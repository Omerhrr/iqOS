'use client'

// IQAIR//OS - Chart workspace: 8 chart types + dynamic registry overlays.
// No default indicators - the chart starts clean and the operator's picker
// selection (persisted in localStorage) is the single source of overlays.
import { useCallback, useEffect, useMemo, useRef } from 'react'
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
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineWidth,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { AnalysisResult, Candle, ChartType, IndicatorSeries, Position } from '@/lib/os/client'
import { chartPriceFormat, fmtPrice } from '@/lib/os/client'

interface ChartPanelProps {
  candles: Candle[]
  analysis: AnalysisResult | null
  price: number
  digitsTicker: string
  chartType: ChartType
  overlays: IndicatorSeries[]
  positions?: Position[]
  settledPositions?: Position[]
}

type AnyPriceSeries =
  | ISeriesApi<'Candlestick'>
  | ISeriesApi<'Bar'>
  | ISeriesApi<'Line'>
  | ISeriesApi<'Area'>
  | ISeriesApi<'Baseline'>
  | ISeriesApi<'Histogram'>

const UP = '#10b981'
const DOWN = '#f43f5e'
const GRID = 'rgba(28,39,57,0.55)'
const TEXT = '#7c8aa5'

// ---------- transforms ----------

/** Latest candle open time <= ts (renko/heikin display times differ from feed times). */
function snapToCandle(candles: Candle[], ts: number): UTCTimestamp | null {
  let t: number | null = null
  for (const c of candles) {
    if (c.time <= ts) t = c.time
    else break
  }
  return t as UTCTimestamp | null
}

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
  overlays,
  positions,
  settledPositions,
}: ChartPanelProps) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const priceSeriesRef = useRef<AnyPriceSeries | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const entryLineRefs = useRef<Map<string, { series: AnyPriceSeries; line: IPriceLine; price: number; title: string }>>(new Map())
  const markersRef = useRef<{ series: AnyPriceSeries; api: ISeriesMarkersPluginApi<Time> } | null>(null)
  const priceFmtKeyRef = useRef<string | null>(null)

  // axis/crosshair/price-line precision follows the asset's quote convention
  // (the library default of 2 decimals turns 1.10283 into 1.10)
  const priceFmt = useMemo(() => chartPriceFormat(digitsTicker, price), [digitsTicker, price])
  const overlayRefs = useRef<Map<string, ISeriesApi<'Line'>>>(new Map())
  // registry indicator markers (fractal arrows) + trade markers merge into ONE
  // setMarkers payload on the price series - two refs, one plugin
  const indMarkersRef = useRef<SeriesMarker<Time>[]>([])
  const tradeMarkersRef = useRef<SeriesMarker<Time>[]>([])

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
    price.applyOptions({ priceFormat: priceFmt })
    priceSeriesRef.current = price

    return () => {
      chart.remove()
      chartRef.current = null
      priceSeriesRef.current = null
      volRef.current = null
      overlayRefs.current.clear()
      entryLineRefs.current.clear()
      markersRef.current = null
      indMarkersRef.current = []
      tradeMarkersRef.current = []
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
    ;(price as unknown as ISeriesApi<'Candlestick'>).setData(
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

  // live precision sync: asset switch or a quote crossing a magnitude band
  useEffect(() => {
    const key = `${digitsTicker}:${priceFmt.precision}`
    if (priceFmtKeyRef.current === key) return
    priceFmtKeyRef.current = key
    priceSeriesRef.current?.applyOptions({ priceFormat: priceFmt })
  }, [priceFmt, digitsTicker])

  // registry overlays: create/remove line series on the live chart. The
  // 'dots' style renders traditional point markers (Parabolic SAR) with no
  // connecting line via the series' point-marker options.
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
          const isDots = ln.style === 'dots'
          series = chart.addSeries(LineSeries, {
            color: ln.color,
            lineWidth: (ln.width ?? 1) as LineWidth,
            lineVisible: !isDots,
            pointMarkersVisible: isDots,
            pointMarkersRadius: isDots ? 1 : undefined,
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

  // single markers plugin on the price series; indicator arrows (fractals)
  // and trade entry/settle markers both feed the same payload
  const ensureMarkerApi = useCallback(() => {
    const series = priceSeriesRef.current
    if (!series) return null
    if (!markersRef.current || markersRef.current.series !== series) {
      markersRef.current = { series, api: createSeriesMarkers(series, []) }
    }
    return markersRef.current.api
  }, [])

  const applyMarkers = useCallback(() => {
    if (!markersRef.current) return
    const all = [...indMarkersRef.current, ...tradeMarkersRef.current]
    all.sort((a, b) => Number(a.time) - Number(b.time))
    markersRef.current.api.setMarkers(all)
  }, [])

  // registry indicator markers (Williams fractal arrows) - times snap to the
  // displayed candle grid (heikin/renko remap times), then merge via applyMarkers
  useEffect(() => {
    const out: SeriesMarker<Time>[] = []
    for (const s of overlays) {
      for (const m of s.markers ?? []) {
        const t = snapToCandle(displayCandles, m.time)
        if (t === null) continue
        out.push({
          time: t,
          position: m.position,
          shape: m.shape,
          color: m.color,
          text: m.text,
          size: m.size ?? 1,
        })
      }
    }
    indMarkersRef.current = out
    ensureMarkerApi()
    applyMarkers()
  }, [overlays, displayCandles, chartType, ensureMarkerApi, applyMarkers])

  // trade overlay: one dashed price line per open position on this asset
  // (green CALL / red PUT, titled with kind + stake + expiry countdown) and
  // markers pinning entries - arrows for open trades, faded arrows + a
  // settle circle with P&L for the most recent settled trades, so bar-count
  // expiries and outcomes are readable straight off the chart. Lines re-
  // attach after chart-type switches and drop when trades settle or the
  // operator switches asset.
  useEffect(() => {
    const series = priceSeriesRef.current
    if (!series) return
    const lastT = displayCandles.length ? displayCandles[displayCandles.length - 1].time : 0
    const open = (positions ?? []).filter((p) => p.status === 'open' && p.asset === digitsTicker)
    const seen = new Set<string>()
    for (const p of open) {
      seen.add(p.id)
      const isCall = p.side === 'call'
      // expiry countdown: bars for binary/turbo (settle on the close of the
      // expiry bar), seconds for digital, none for CFD
      let countdown = ''
      if (p.kind !== 'cfd' && lastT > 0 && tfSec > 0) {
        if (p.kind === 'digital' && p.expirySec) {
          countdown = ` · T-${Math.max(0, Math.round(p.tsOpen + p.expirySec - lastT))}s`
        } else if (p.expiryBars) {
          const barsSince = Math.max(0, Math.round((lastT - p.tsOpen) / tfSec))
          countdown = ` · T-${Math.max(0, p.expiryBars - barsSince)}`
        }
      }
      const title = `${isCall ? '▲ CALL' : '▼ PUT'} ${p.kind} $${p.amount}${countdown}`
      const existing = entryLineRefs.current.get(p.id)
      if (existing && existing.series === series && existing.title === title) continue
      if (existing) {
        if (existing.series === series && existing.price === p.entryPrice) {
          existing.line.applyOptions({ title }) // countdown tick - keep the line
          entryLineRefs.current.set(p.id, { ...existing, title })
          continue
        }
        try {
          existing.series.removePriceLine(existing.line)
        } catch {
          // chart already torn down
        }
        entryLineRefs.current.delete(p.id)
      }
      const line = series.createPriceLine({
        price: p.entryPrice,
        color: isCall ? UP : DOWN,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title,
      })
      entryLineRefs.current.set(p.id, { series, line, price: p.entryPrice, title })
    }
    for (const [key, entry] of entryLineRefs.current) {
      if (!seen.has(key)) {
        try {
          entry.series.removePriceLine(entry.line)
        } catch {
          // chart already torn down
        }
        entryLineRefs.current.delete(key)
      }
    }

    ensureMarkerApi()
    const markers: SeriesMarker<Time>[] = []
    for (const p of open) {
      const t = snapToCandle(displayCandles, p.tsOpen)
      if (t === null) continue
      const isCall = p.side === 'call'
      markers.push({
        time: t,
        position: isCall ? 'belowBar' : 'aboveBar',
        color: isCall ? UP : DOWN,
        shape: isCall ? 'arrowUp' : 'arrowDown',
        text: `${isCall ? '▲' : '▼'} $${p.amount} ${p.kind}`,
        size: 1,
      })
    }
    // settled feed arrives newest-first (ts_open DESC); review window = 30 most recent
    for (const p of (settledPositions ?? []).filter((q) => q.asset === digitsTicker).slice(0, 30)) {
      const col = p.pnl === undefined ? '#7c8aa5' : p.pnl > 0 ? UP : p.pnl < 0 ? DOWN : '#7c8aa5'
      const isCall = p.side === 'call'
      const entryT = snapToCandle(displayCandles, p.tsOpen)
      if (entryT !== null) {
        markers.push({
          time: entryT,
          position: isCall ? 'belowBar' : 'aboveBar',
          color: col,
          shape: isCall ? 'arrowUp' : 'arrowDown',
          text: `${isCall ? '▲' : '▼'} $${p.amount}`,
          size: 1,
        })
      }
      const exitT = p.tsClose ? snapToCandle(displayCandles, p.tsClose) : null
      if (exitT !== null) {
        markers.push({
          time: exitT,
          position: isCall ? 'aboveBar' : 'belowBar',
          color: col,
          shape: 'circle',
          text: `■ ${p.pnl === undefined ? '' : `${p.pnl >= 0 ? '+' : '-'}$${Math.abs(p.pnl).toFixed(2)}`}`,
          size: 1,
        })
      }
    }
    tradeMarkersRef.current = markers
    applyMarkers()
  }, [positions, settledPositions, digitsTicker, chartType, displayCandles, tfSec, ensureMarkerApi, applyMarkers])

  const lastCandle = candles[candles.length - 1]
  const lastUp = lastCandle ? lastCandle.close >= lastCandle.open : true

  // zoom controls: scale the visible logical range around its center
  const zoomBy = (factor: number) => {
    const ts = chartRef.current?.timeScale()
    if (!ts) return
    const r = ts.getVisibleLogicalRange()
    if (!r) return
    const center = (r.from + r.to) / 2
    const half = Math.max(((r.to - r.from) / 2) * factor, 1.5)
    ts.setVisibleLogicalRange({ from: center - half, to: center + half })
  }
  const fitChart = () => {
    chartRef.current?.timeScale().fitContent()
    chartRef.current?.timeScale().scrollToRealTime()
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      {/* zoom controls (left of the price scale) */}
      <div className="absolute bottom-10 right-[60px] z-10 flex flex-col gap-1">
        <button
          onClick={() => zoomBy(0.7)}
          title="Zoom in"
          className="flex h-6 w-6 items-center justify-center rounded border border-[#1c2739] bg-[#0d1420]/90 font-mono text-[13px] font-bold leading-none text-[#7c8aa5] transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
        >
          +
        </button>
        <button
          onClick={() => zoomBy(1.4)}
          title="Zoom out"
          className="flex h-6 w-6 items-center justify-center rounded border border-[#1c2739] bg-[#0d1420]/90 font-mono text-[13px] font-bold leading-none text-[#7c8aa5] transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
        >
          −
        </button>
        <button
          onClick={fitChart}
          title="Fit chart"
          className="flex h-6 w-6 items-center justify-center rounded border border-[#1c2739] bg-[#0d1420]/90 text-[11px] leading-none text-[#7c8aa5] transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
        >
          ⤢
        </button>
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
