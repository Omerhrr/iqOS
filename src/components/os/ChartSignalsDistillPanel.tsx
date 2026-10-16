'use client'

// IQAIR//OS - Chart Signals Distill panel: the Kalman-OU-smoothed read of the
// combined chart-engine vote for the currently active instrument. Shows the
// raw (per-bar) combined vote score next to the distilled (decluttered)
// score so you can see how much the smoothing actually moved the read, plus
// the OU fit diagnostics (theta/z/tStat) the distillation is built on.
// Single-asset, polled on an interval - unlike Chart Signals/Lead-Lag this
// does not scan a universe/group list, since the distill fit is per-asset
// and already costs `window`x a normal vote read (see
// analytics/chartsignalsdistill.ts).

import { useEffect, useState } from 'react'
import type { ChartSignalsDistillResponse, Timeframe } from '@/lib/os/client'
import { getChartSignalsDistill, fmtPrice } from '@/lib/os/client'

const POLL_MS = 8_000
const DEFAULT_WINDOW = 20

function ScoreBar({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(-100, Math.min(100, value))
  const pct = Math.abs(clamped) / 2 // half-width from center, 0..50%
  const dir = clamped > 0.5 ? 'call' : clamped < -0.5 ? 'put' : null
  const color = dir === 'call' ? '#10b981' : dir === 'put' ? '#f43f5e' : '#5a6a85'
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 font-mono text-[8px] uppercase tracking-wide text-[#5a6a85]">{label}</span>
      <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-[#0b111c]">
        <div className="absolute left-1/2 top-0 h-full w-px bg-[#2a3850]" />
        <div
          className="absolute top-0 h-full"
          style={{
            width: `${pct}%`,
            left: clamped >= 0 ? '50%' : `${50 - pct}%`,
            background: color,
            opacity: 0.75,
          }}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-[9px] font-bold" style={{ color }}>
        {clamped >= 0 ? '+' : ''}
        {clamped.toFixed(0)}
      </span>
    </div>
  )
}

export default function ChartSignalsDistillPanel({
  onClose,
  asset,
  tf,
}: {
  onClose: () => void
  asset: string
  tf: Timeframe
}) {
  const [data, setData] = useState<ChartSignalsDistillResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [window_, setWindow] = useState(DEFAULT_WINDOW)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      setLoading(true)
      try {
        const d = await getChartSignalsDistill(asset, tf, { window: window_ })
        if (!cancelled) {
          setData(d)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) {
          setLoading(false)
          timer = setTimeout(poll, POLL_MS)
        }
      }
    }
    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [asset, tf, window_])

  const r = data?.result ?? null
  const direction = data?.direction ?? null
  const dirColor = direction === 'call' ? '#10b981' : direction === 'put' ? '#f43f5e' : '#5a6a85'
  const dirLabel = direction === 'call' ? 'CALL' : direction === 'put' ? 'PUT' : 'no read'

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">Chart Signals Distill</span>
        <span className="ml-1 font-mono text-[8px] text-[#3d4d66]">{asset} · {tf}</span>
        {loading && <span className="font-mono text-[8px] text-[#3d4d66]">·</span>}
        <button
          type="button"
          onClick={onClose}
          title="close"
          className="ml-auto rounded px-1.5 py-0.5 font-mono text-[9px] text-[#5a6a85] hover:bg-[#1c2739] hover:text-[#aebccf]"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error ? (
          <div className="rounded border border-rose-900/40 bg-rose-950/20 p-2 font-mono text-[9px] text-rose-300">{error}</div>
        ) : !data ? (
          <div className="font-mono text-[9px] text-[#5a6a85]">loading…</div>
        ) : !r ? (
          <div className="font-mono text-[9px] text-[#5a6a85]">
            not enough history yet for the distill fit (needs ~{40 + window_} closed bars on {tf}).
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div
              className="flex items-center justify-between rounded-md border px-2 py-2"
              style={{ borderColor: `${dirColor}33`, background: `${dirColor}14` }}
            >
              <div className="flex flex-col">
                <span className="font-mono text-[8px] uppercase tracking-wider text-[#5a6a85]">distilled read</span>
                <span className="font-mono text-base font-bold" style={{ color: dirColor }}>
                  {dirLabel}
                </span>
              </div>
              <div className="text-right">
                <div className="font-mono text-[8px] uppercase tracking-wider text-[#5a6a85]">price</div>
                <div className="font-mono text-xs text-[#aebccf]">{data.price !== null ? fmtPrice(data.price) : '-'}</div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <ScoreBar value={r.rawScore} label="raw" />
              <ScoreBar value={r.filtered} label="distilled" />
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded border border-[#1c2739] p-2 font-mono text-[9px]">
              <div className="flex justify-between">
                <span className="text-[#5a6a85]">θ (equilibrium)</span>
                <span className="text-[#aebccf]">{r.theta.toFixed(1)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#5a6a85]">z</span>
                <span className="text-[#aebccf]">{r.z.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#5a6a85]">t-stat</span>
                <span className="text-[#aebccf]">{r.tStat.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#5a6a85]">samples</span>
                <span className="text-[#aebccf]">{r.n}</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="font-mono text-[8px] uppercase tracking-wider text-[#5a6a85]">window</span>
              <input
                type="range"
                min={12}
                max={40}
                step={1}
                value={window_}
                onChange={(e) => setWindow(Number(e.target.value))}
                className="h-1 flex-1 accent-amber-400"
              />
              <span className="w-6 text-right font-mono text-[9px] text-[#aebccf]">{window_}</span>
            </div>

            <p className="font-mono text-[8px] leading-relaxed text-[#3d4d66]">
              Raw = this bar&apos;s combined chart-engine vote score. Distilled = that score run through an OU fit + Kalman
              forward pass over the last {window_} bars - smooths out single-bar family disagreement. Same strategy is
              backtestable in the Backtest Lab as &quot;Chart Signals Distill (Kalman-OU)&quot;.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
