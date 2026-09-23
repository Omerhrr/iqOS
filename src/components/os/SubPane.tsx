'use client'

// IQAIR//OS - SubPane: oscillator indicator pane rendered under the main chart
import { useEffect, useRef, useState } from 'react'
import { GripVertical } from 'lucide-react'
import { ColorType, HistogramSeries, LineSeries, LineStyle, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import type { IndicatorSeries, Timeframe } from '@/lib/os/client'
import { osGet } from '@/lib/os/client'

interface Props {
  id: string
  asset: string
  tf: Timeframe
  params?: Record<string, number>
  onRemove: () => void
  /** fill the parent box (resizable desktop stack) instead of the fixed 130px */
  fill?: boolean
  /** this pane's position in the stack + the reorder callback - drag the
   * grip onto another pane to swap them, same "grab and move" feel as
   * resizing the chart itself. Both undefined when the stack holds one pane. */
  dragIndex?: number
  onReorder?: (from: number, to: number) => void
}

const GRID = 'rgba(28,39,57,0.55)'
const TEXT = '#7c8aa5'

export default function SubPane({ id, asset, tf, params, onRemove, fill, dragIndex, onReorder }: Props) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<(ISeriesApi<'Line'> | ISeriesApi<'Histogram'>)[]>([])
  const [series, setSeries] = useState<IndicatorSeries | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const draggable = dragIndex !== undefined && onReorder !== undefined

  const paramKey = params ? JSON.stringify(params) : ''

  useEffect(() => {
    let cancelled = false
    const fetchParams: Record<string, string | number> = { id, asset, tf, limit: 320 }
    if (params) for (const [k, v] of Object.entries(params)) fetchParams[`p_${k}`] = v
    osGet<{ ok: boolean; series: IndicatorSeries }>('/indicator', fetchParams)
      .then((d) => {
        if (cancelled) return
        if (d.ok) setSeries(d.series)
        else setError('unavailable')
      })
      .catch(() => !cancelled && setError('fetch failed'))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, asset, tf, paramKey])

  useEffect(() => {
    if (!elRef.current) return
    const chart = createChart(elRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: TEXT,
        fontSize: 9,
        fontFamily: 'var(--font-geist-mono), monospace',
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: { borderColor: '#1c2739' },
      timeScale: { borderColor: '#1c2739', timeVisible: true, secondsVisible: false, visible: false },
    })
    chartRef.current = chart
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !series) return
    // clear previously drawn series
    for (const s of seriesRef.current) {
      try {
        chart.removeSeries(s)
      } catch {
        // already removed with chart
      }
    }
    seriesRef.current = []

    for (const ln of series.lines) {
      const s = chart.addSeries(LineSeries, {
        color: ln.color,
        lineWidth: 1,
        lineStyle: ln.style === 'dashed' ? LineStyle.Dashed : ln.style === 'dotted' ? LineStyle.Dotted : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: true,
      })
      s.setData(
        series.time
          .map((t, i) => ({ time: t as UTCTimestamp, value: ln.values[i] }))
          .filter((p) => p.value !== null && Number.isFinite(p.value)) as { time: UTCTimestamp; value: number }[]
      )
      seriesRef.current.push(s)
    }
    if (series.hist) {
      const h = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false })
      const colorize = (v: number | null) => {
        if (v === null || !Number.isFinite(v)) return 'rgba(148,163,184,0.4)'
        if (series.hist?.color === 'updown') return v >= 0 ? 'rgba(16,185,129,0.55)' : 'rgba(244,63,94,0.55)'
        return series.hist?.color ?? 'rgba(56,189,248,0.5)'
      }
      h.setData(
        series.time
          .map((t, i) => ({ time: t as UTCTimestamp, value: series.hist?.values[i] ?? null, color: colorize(series.hist?.values[i] ?? null) }))
          .filter((p) => p.value !== null && Number.isFinite(p.value)) as { time: UTCTimestamp; value: number; color: string }[]
      )
      seriesRef.current.push(h)
    }
    if (series.bands) {
      chart.priceScale('right').applyOptions({ autoScale: true })
    }
  }, [series])

  const lastLine = series?.lines[0]
  const lastVal = lastLine ? lastLine.values[lastLine.values.length - 1] : null

  return (
    <div
      onDragOver={
        draggable
          ? (e) => {
              e.preventDefault()
              setDragOver(true)
            }
          : undefined
      }
      onDragLeave={draggable ? () => setDragOver(false) : undefined}
      onDrop={
        draggable
          ? (e) => {
              e.preventDefault()
              setDragOver(false)
              const from = Number(e.dataTransfer.getData('text/plain'))
              if (Number.isFinite(from) && from !== dragIndex) onReorder!(from, dragIndex!)
            }
          : undefined
      }
      className={`relative flex shrink-0 flex-col rounded-lg border bg-[#0b111c] transition-colors ${fill ? 'h-full min-h-0' : 'h-[130px]'} ${dragOver ? 'border-cyan-500/70' : 'border-[#1c2739]'}`}
    >
      <div className="absolute left-2 top-1 z-10 flex items-center gap-2 font-mono text-[9px]">
        {draggable && (
          <span
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', String(dragIndex))
              e.dataTransfer.effectAllowed = 'move'
            }}
            title="drag to reorder"
            className="-ml-0.5 cursor-grab text-[#4b5a72] hover:text-cyan-300 active:cursor-grabbing"
          >
            <GripVertical size={11} />
          </span>
        )}
        <span className="font-semibold uppercase tracking-wider text-[#aab6cc]">{series?.name ?? id}</span>
        {lastVal !== null && Number.isFinite(lastVal) && (
          <span style={{ color: lastLine?.color ?? '#7c8aa5' }}>{typeof lastVal === 'number' ? lastVal.toFixed(2) : ''}</span>
        )}
      </div>
      <button
        onClick={onRemove}
        className="absolute right-1.5 top-1 z-10 rounded bg-[#101828]/90 px-1.5 text-[9px] font-bold text-rose-400 hover:bg-rose-500/10"
        title="remove pane"
      >
        ✕
      </button>
      {error ? (
        <div className="flex flex-1 items-center justify-center font-mono text-[10px] text-[#4b5a72]">{error}</div>
      ) : (
        <div ref={elRef} className="min-h-0 flex-1 px-0.5 pb-0.5" />
      )}
    </div>
  )
}
