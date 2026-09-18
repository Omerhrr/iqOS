'use client'

// IQAIR//OS - Chart workspace: 8 chart types + dynamic registry overlays
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { Button } from '@/components/ui/button'
import type { AnalysisResult, Candle, ChartType, IndicatorSeries } from '@/lib/os/client'
import { CHART_TYPES, fmtPrice } from '@/lib/os/client'

interface ChartPanelProps {
  candles: Candle[]
  analysis: AnalysisResult | null
  price: number
  digitsTicker: string
  chartType: ChartType
  onChartTypeChange: (t: ChartType) => void
  overlays: IndicatorSeries[]
  registrySize: number
  onOpenPicker: () => void
}

const UP = '#10b981'
const DOWN = '#f43f5e'
const GRID = 'rgba(28,39,57,0.55)'
const TEXT = '#7c8aa5'

interface OverlayToggles {
  ema20: boolean
  ema50: boolean
  ema200: boolean
  bb: boolean
  supertrend: boolean
  vwap: boolean
}

const DEFAULT_TOGGLES: OverlayToggles = { ema20: true, ema50: true, ema200: false, bb: false, supertrend: true, vwap: false }

// ---------- transforms ----------

function heikinAshi(candles: Candle[]): Candle[] {
  const out: Candle[] = []
  let prevOpen = candles[0]?.open ?? 0
  let prevClose = candles[0]?.close ?? 0
  for (const c of candles) {
    const close = (c.open + c.high + c.low + c.close) / 4
    const open = (prevOpen + prevClose) / 2
    const high = Math.max(c.high, open, close)
    const low = Math.min(c.low, open, close)
    out.push({ time: c.time, open, high, low, close, volume: c.volume })
    prevOpen = open
    prevClose = close
  }
  return out
}

function renko(candles: Candle[], tfSec: number): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-150)
  // brick size = 30% of average true range of the window
  let trSum = 0
  for (let i = 1; i < window.length; i++) {
    trSum += Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close)
    )
  }
  const brick = Math.max(trSum / Math.max(window.length - 1, 1) * 0.3, 1e-9)
  const bricks: Candle[] = []
  let lastClose = window[0].close
  let refPrice = lastClose
  const end = window[window.length - 1].time
  for (const c of window) {
    refPrice = lastClose
    while (c.close >= refPrice + brick) {
      const t = end - (bricks.length % 400) * tfSec
      bricks.push({ time: t, open: refPrice, high: refPrice + brick, low: refPrice, close: refPrice + brick, volume: 0 })
      refPrice += brick
      lastClose = refPrice
    }
    while (c.close <= refPrice - brick) {
      const t = end - (bricks.length % 400) * tfSec
      bricks.push({ time: t, open: refPrice, high: refPrice, low: refPrice - brick, close: refPrice - brick, volume: 0 })
      refPrice -= brick
      lastClose = refPrice
    }
  }
  // ensure strictly increasing times
  for (let i = 1; i < bricks.length; i++) {
    if (bricks[i].time <= bricks[i - 1].time) bricks[i].time = bricks[i - 1].time + tfSec
  }
  return bricks.slice(-300)
}

const lineStyleMap: Record<string, LineStyle> = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted }

export default function ChartPanel({
  candles,
  analysis,
  price,
  digitsTicker,
  chartType,
  onChartTypeChange,
  overlays,
  registrySize,
  onOpenPicker,
}: ChartPanelProps) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const priceSeriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Bar'> | ISeriesApi<'Line'> | ISeriesApi<'Area'> | ISeriesApi<'Baseline'> | ISeriesApi<'Histogram'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const overlayRefs = useRef<Map<string, ISeriesApi<'Line'>>>(new Map())
  const builtinRef = useRef<{ ema20?: ISeriesApi<'Line'>; ema50?: ISeriesApi<'Line'>; ema200?: ISeriesApi<'Line'>; bbUp?: ISeriesApi<'Line'>; bbLo?: ISeriesApi<'Line'>; st?: ISeriesApi<'Line'>; vwap?: ISeriesApi<'Line'> }>({})
  const [toggles, setToggles] = useState<OverlayToggles>(DEFAULT_TOGGLES)

  const tfSec = useMemo(() => {
    if (!candles || candles.length < 2) return 60
    return Math.max(1, candles[candles.length - 1].time - candles[candles.length - 2].time)
  }, [candles])

  const displayCandles = useMemo(() => {
    if (chartType === 'heikin') return heikinAshi(candles)
    if (chartType === 'renko') return renko(candles, tfSec)
    return candles
  }, [candles, chartType, tfSec])

  // create/recreate chart when chartType changes; built-in series live & die with the chart
  useEffect(() => {
    if (!elRef.current) return
    const chart = createChart(elRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: TEXT,
        fontSize: 11,
        fontFamily: 'var(--font-geist-mono), monospace',
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      crosshair: { mode: 0, vertLine: { color: '#3b82a0', labelBackgroundColor: '#0f2733' }, horzLine: { color: '#3b82a0', labelBackgroundColor: '#0f2733' } },
      rightPriceScale: { borderColor: '#1c2739', scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: '#1c2739', timeVisible: true, secondsVisible: true, rightOffset: 6 },
    })
    chartRef.current = chart

    const vol = chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      color: 'rgba(56,189,248,0.28)',
    })
    volRef.current = vol
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })

    let price: ISeriesApi<'Candlestick'> | ISeriesApi<'Bar'> | ISeriesApi<'Line'> | ISeriesApi<'Area'> | ISeriesApi<'Baseline'>
    if (chartType === 'candles') {
      price = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        priceLineColor: '#38bdf8',
      })
    } else if (chartType === 'hollow') {
      price = chart.addSeries(CandlestickSeries, {
        upColor: 'transparent', downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        priceLineColor: '#38bdf8',
      })
    } else if (chartType === 'heikin' || chartType === 'renko') {
      price = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        priceLineColor: '#38bdf8',
      })
    } else if (chartType === 'bars') {
      price = chart.addSeries(BarSeries, { upColor: UP, downColor: DOWN, thinBars: false })
    } else if (chartType === 'line') {
      price = chart.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 2 })
    } else if (chartType === 'area') {
      price = chart.addSeries(AreaSeries, {
        lineColor: '#38bdf8', topColor: 'rgba(56,189,248,0.28)', bottomColor: 'rgba(56,189,248,0.02)', lineWidth: 2,
      })
    } else {
      // baseline
      price = chart.addSeries(BaselineSeries, {
        topLineColor: UP, topFillColor1: 'rgba(16,185,129,0.28)', topFillColor2: 'rgba(16,185,129,0.02)',
        bottomLineColor: DOWN, bottomFillColor1: 'rgba(244,63,94,0.02)', bottomFillColor2: 'rgba(244,63,94,0.28)',
      })
    }
    priceSeriesRef.current = price

    // built-in overlay series (fresh per chart)
    const mk = (color: string, style: LineStyle = LineStyle.Solid, width: 1 | 2 = 1) =>
      chart.addSeries(LineSeries, { color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false })
    builtinRef.current = {
      ema20: mk('#38bdf8'),
      ema50: mk('#f59e0b'),
      ema200: mk('#c084fc', LineStyle.Solid, 2),
      bbUp: mk('rgba(148,163,184,0.5)', LineStyle.Dashed),
      bbLo: mk('rgba(148,163,184,0.5)', LineStyle.Dashed),
      st: mk('#a78bfa', LineStyle.Solid, 2),
      vwap: mk('#e879f9'),
    }

    return () => {
      chart.remove()
      chartRef.current = null
      priceSeriesRef.current = null
      volRef.current = null
      builtinRef.current = {}
      overlayRefs.current.clear()
    }
  }, [chartType])

  // price + volume data
  useEffect(() => {
    const price = priceSeriesRef.current
    const vol = volRef.current
    if (!price || !vol || displayCandles.length === 0) return
    if (chartType === 'line' || chartType === 'area' || chartType === 'baseline') {
      const lineData = displayCandles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close }))
      ;(price as ISeriesApi<'Line'>).setData(lineData)
      vol.setData(displayCandles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? 'rgba(16,185,129,0.30)' : 'rgba(244,63,94,0.30)' })))
      return
    }
    ;(price as ISeriesApi<'Candlestick'>).setData(
      displayCandles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }))
    )
    vol.setData(
      displayCandles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(16,185,129,0.30)' : 'rgba(244,63,94,0.30)',
      }))
    )
  }, [displayCandles, chartType])

  // built-in overlay data + toggle visibility
  useEffect(() => {
    const b = builtinRef.current
    if (!analysis || !b.ema20 || !chartRef.current) return
    const toPts = (arr: { time: number; value: number }[]) => arr.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
    b.ema20.setData(toPts(analysis.indicatorSeries.ema20))
    b.ema50.setData(toPts(analysis.indicatorSeries.ema50))
    b.ema200.setData(toPts(analysis.indicatorSeries.ema200))
    b.bbUp.setData(toPts(analysis.indicatorSeries.bbUpper))
    b.bbLo.setData(toPts(analysis.indicatorSeries.bbLower))
    b.st.setData(analysis.indicatorSeries.supertrend.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))
    b.vwap.setData(toPts(analysis.indicatorSeries.vwap))
    b.ema20.applyOptions({ visible: toggles.ema20 })
    b.ema50.applyOptions({ visible: toggles.ema50 })
    b.ema200.applyOptions({ visible: toggles.ema200 })
    b.bbUp.applyOptions({ visible: toggles.bb })
    b.bbLo.applyOptions({ visible: toggles.bb })
    b.st.applyOptions({ visible: toggles.supertrend })
    b.vwap.applyOptions({ visible: toggles.vwap })
  }, [analysis, toggles, chartType])

  // registry overlays: create/remove line series on the live chart
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const seen = new Set<string>()
    for (const s of overlays) {
      s.lines.forEach((ln, i) => {
        const key = `${s.id}:${s.lines[i]?.key}:${i}`
        seen.add(key)
        let series = overlayRefs.current.get(key)
        if (!series) {
          series = chart.addSeries(LineSeries, {
            color: ln.color,
            lineWidth: 1,
            lineStyle: lineStyleMap[ln.style ?? 'solid'] ?? LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: false,
          })
          overlayRefs.current.set(key, series)
        }
        series.setData(
          s.time
            .map((t, ti) => ({ time: t as UTCTimestamp, value: ln.values[ti] }))
            .filter((p) => p.value !== null && Number.isFinite(p.value as number)) as { time: UTCTimestamp; value: number }[]
        )
        series.applyOptions({ visible: true })
      })
    }
    // remove stale
    for (const [key, series] of overlayRefs.current) {
      if (!seen.has(key)) {
        try {
          chart.removeSeries(series)
        } catch {
          // chart already torn down
        }
        overlayRefs.current.delete(key)
      }
    }
  }, [overlays, chartType])

  const lastCandle = candles[candles.length - 1]
  const lastUp = lastCandle ? lastCandle.close >= lastCandle.open : true

  return (
    <div className="relative flex h-full min-h-[320px] flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      {/* chart type selector */}
      <div className="absolute left-2 top-2 z-10 flex flex-wrap items-center gap-1">
        {CHART_TYPES.map((t) => (
          <button
            key={t.id}
            onClick={() => onChartTypeChange(t.id)}
            className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition-colors ${
              chartType === t.id ? 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/40' : 'bg-[#0d1420]/90 text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={onOpenPicker}
          className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-300 ring-1 ring-violet-500/40 transition-colors hover:bg-violet-500/25"
          title="Browse the full indicator registry"
        >
          + Indicator ({registrySize})
        </button>
      </div>

      {/* built-in overlay toggles */}
      <div className="absolute right-3 top-2 z-10 flex flex-wrap gap-1">
        {(
          [
            ['ema20', 'EMA20', '#38bdf8'],
            ['ema50', 'EMA50', '#f59e0b'],
            ['ema200', 'EMA200', '#c084fc'],
            ['bb', 'BOLL', '#94a3b8'],
            ['supertrend', 'ST', '#a78bfa'],
            ['vwap', 'VWAP', '#e879f9'],
          ] as [keyof OverlayToggles, string, string][]
        ).map(([key, label, color]) => (
          <Button
            key={key}
            variant="outline"
            size="sm"
            onClick={() => setToggles((t) => ({ ...t, [key]: !t[key] }))}
            className="h-6 rounded-full border-[#1c2739] bg-[#0d1420] px-2 text-[10px] tracking-wide"
            style={{
              color: toggles[key] ? color : '#4b5a72',
              borderColor: toggles[key] ? `${color}66` : '#1c2739',
            }}
          >
            {label}
          </Button>
        ))}
      </div>

      <div ref={elRef} className="min-h-0 flex-1" />
      <div className="flex items-center justify-between border-t border-[#1c2739] px-3 py-1.5 text-[11px] font-mono">
        <span className={lastUp ? 'text-emerald-400' : 'text-rose-400'}>
          {fmtPrice(price, digitsTicker)} <span className="text-[#4b5a72]">last</span>
        </span>
        {analysis && (
          <span className="text-[#4b5a72]">
            {analysis.asset} · {analysis.tf} · {chartType} · {candles.length} bars ·{' '}
            <span className={analysis.changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {analysis.changePct >= 0 ? '+' : ''}
              {analysis.changePct.toFixed(2)}%
            </span>
          </span>
        )}
      </div>
    </div>
  )
}
