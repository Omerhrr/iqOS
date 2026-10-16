'use client'

// IQAIR//OS - Volatility Arb panel: close-to-close vs Parkinson range-vol read
// for the currently active instrument (analytics/volarb.ts). Single asset,
// polled on an interval - mirrors ChartSignalsDistillPanel's shape.

import { useEffect, useState } from 'react'
import type { VolArbResponse, Timeframe } from '@/lib/os/client'
import { getVolArb, fmtPrice } from '@/lib/os/client'

const POLL_MS = 8_000
const DEFAULT_WINDOW = 40
const RATIO_HIGH = 1.6
const RATIO_LOW = 0.6

export default function VolatilityArbPanel({
  onClose,
  asset,
  tf,
}: {
  onClose: () => void
  asset: string
  tf: Timeframe
}) {
  const [data, setData] = useState<VolArbResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [window_, setWindow] = useState(DEFAULT_WINDOW)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      setLoading(true)
      try {
        const d = await getVolArb(asset, tf, window_)
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
  const direction: 'call' | 'put' | null = !r
    ? null
    : r.ratio >= RATIO_HIGH && r.lastBarDir !== 0
      ? (r.lastBarDir > 0 ? 'put' : 'call')
      : r.ratio <= RATIO_LOW && r.momentum !== 0
        ? (r.momentum > 0 ? 'call' : 'put')
        : null
  const dirColor = direction === 'call' ? '#10b981' : direction === 'put' ? '#f43f5e' : '#5a6a85'
  const dirLabel = direction === 'call' ? 'CALL' : direction === 'put' ? 'PUT' : 'no edge'
  const regime = !r ? null : r.ratio >= RATIO_HIGH ? 'range vol dominant (fade)' : r.ratio <= RATIO_LOW ? 'close vol dominant (continue)' : 'balanced'

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">Volatility Arb</span>
        <span className="ml-1 font-mono text-[8px] text-[#3d4d66]">
          {asset} · {tf}
        </span>
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
            not enough history yet for the vol-arb read (needs ~{window_} bars on {tf}).
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div
              className="flex items-center justify-between rounded-md border px-2 py-2"
              style={{ borderColor: `${dirColor}33`, background: `${dirColor}14` }}
            >
              <div className="flex flex-col">
                <span className="font-mono text-[8px] uppercase tracking-wider text-[#5a6a85]">{regime}</span>
                <span className="font-mono text-base font-bold" style={{ color: dirColor }}>
                  {dirLabel}
                </span>
              </div>
              <div className="text-right">
                <div className="font-mono text-[8px] uppercase tracking-wider text-[#5a6a85]">price</div>
                <div className="font-mono text-xs text-[#aebccf]">{data.price !== null ? fmtPrice(data.price) : '-'}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded border border-[#1c2739] p-2 font-mono text-[9px]">
              <div className="flex justify-between">
                <span className="text-[#5a6a85]">close-to-close vol</span>
                <span className="text-[#aebccf]">{(r.closeVol * 100).toFixed(3)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#5a6a85]">Parkinson range vol</span>
                <span className="text-[#aebccf]">{(r.rangeVol * 100).toFixed(3)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#5a6a85]">ratio (range/close)</span>
                <span className="text-[#aebccf]">{r.ratio.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#5a6a85]">last bar</span>
                <span className="text-[#aebccf]">{r.lastBarDir > 0 ? 'up' : r.lastBarDir < 0 ? 'down' : 'doji'}</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="font-mono text-[8px] uppercase tracking-wider text-[#5a6a85]">window</span>
              <input
                type="range"
                min={20}
                max={120}
                step={5}
                value={window_}
                onChange={(e) => setWindow(Number(e.target.value))}
                className="h-1 flex-1 accent-sky-400"
              />
              <span className="w-8 text-right font-mono text-[9px] text-[#aebccf]">{window_}</span>
            </div>

            <p className="font-mono text-[8px] leading-relaxed text-[#3d4d66]">
              No options chain/IV surface exists here, so this arbs two REALIZED-vol estimators of the same tape instead:
              close-to-close EWMA vs the Parkinson high-low range estimator. Ratio ≥ {RATIO_HIGH.toFixed(1)} = wicking without
              follow-through (fade); ratio ≤ {RATIO_LOW.toFixed(1)} = a steady grind wider bars would show (continue). Same
              read the &quot;Volatility Arb (Close-vs-Range)&quot; strategy trades in the Backtest Lab.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
