'use client'

// IQAIR//OS - Chart workspace (lightweight-charts v5)
import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { Button } from '@/components/ui/button'
import type { AnalysisResult, Candle } from '@/lib/os/client'
import { fmtPrice } from '@/lib/os/client'

interface ChartPanelProps {
  candles: Candle[]
  analysis: AnalysisResult | null
  price: number
  digitsTicker: string
}

interface OverlayToggles {
  ema20: boolean
  ema50: boolean
  bb: boolean
  supertrend: boolean
  vwap: boolean
}

const UP = '#10b981'
const DOWN = '#f43f5e'
const GRID = 'rgba(28,39,57,0.55)'
const TEXT = '#7c8aa5'

export default function ChartPanel({ candles, analysis, price, digitsTicker }: ChartPanelProps) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const ema20Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema50Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const bbUpRef = useRef<ISeriesApi<'Line'> | null>(null)
  const bbLoRef = useRef<ISeriesApi<'Line'> | null>(null)
  const stRef = useRef<ISeriesApi<'Line'> | null>(null)
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null)
  const [toggles, setToggles] = useState<OverlayToggles>({ ema20: true, ema50: true, bb: false, supertrend: true, vwap: false })

  // create chart once
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

    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineColor: '#38bdf8',
    })
    volRef.current = chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      color: 'rgba(56,189,248,0.28)',
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })

    ema20Ref.current = chart.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    ema50Ref.current = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    bbUpRef.current = chart.addSeries(LineSeries, { color: 'rgba(148,163,184,0.5)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false })
    bbLoRef.current = chart.addSeries(LineSeries, { color: 'rgba(148,163,184,0.5)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false })
    stRef.current = chart.addSeries(LineSeries, { color: '#a78bfa', lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
    vwapRef.current = chart.addSeries(LineSeries, { color: '#e879f9', lineWidth: 1, lineStyle: 0, priceLineVisible: false, lastValueVisible: false })

    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [])

  // full data refresh
  useEffect(() => {
    if (!candleRef.current || !volRef.current || !chartRef.current) return
    const barData = candles.map((c) => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }))
    candleRef.current.setData(barData)
    volRef.current.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(16,185,129,0.30)' : 'rgba(244,63,94,0.30)',
      }))
    )
  }, [candles])

  // overlays refresh
  useEffect(() => {
    if (!analysis || !ema20Ref.current) return
    ema20Ref.current.setData(analysis.indicatorSeries.ema20.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))
    ema50Ref.current.setData(analysis.indicatorSeries.ema50.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))
    bbUpRef.current.setData(analysis.indicatorSeries.bbUpper.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))
    bbLoRef.current.setData(analysis.indicatorSeries.bbLower.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))
    stRef.current.setData(analysis.indicatorSeries.supertrend.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))
    vwapRef.current.setData(analysis.indicatorSeries.vwap.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))
  }, [analysis])

  // toggle visibility
  useEffect(() => {
    ema20Ref.current?.applyOptions({ visible: toggles.ema20 })
    ema50Ref.current?.applyOptions({ visible: toggles.ema50 })
    bbUpRef.current?.applyOptions({ visible: toggles.bb })
    bbLoRef.current?.applyOptions({ visible: toggles.bb })
    stRef.current?.applyOptions({ visible: toggles.supertrend })
    vwapRef.current?.applyOptions({ visible: toggles.vwap })
  }, [toggles])

  const lastCandle = candles[candles.length - 1]
  const lastUp = lastCandle ? lastCandle.close >= lastCandle.open : true

  return (
    <div className="relative flex h-full min-h-[320px] flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="absolute right-3 top-2 z-10 flex flex-wrap gap-1">
        {(
          [
            ['ema20', 'EMA20', '#38bdf8'],
            ['ema50', 'EMA50', '#f59e0b'],
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
            {analysis.asset} · {analysis.tf} · {candles.length} bars ·{' '}
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
