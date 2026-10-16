'use client'

// IQAIR//OS - Cointegration panel: Engle-Granger pairs read for the currently
// active instrument against its lead-lag group leader (same leader lookup as
// the lead-lag/cointegration-pairs strategies - analytics/leadlag.ts's
// leadersFor). Shows the fitted hedge ratio, spread equilibrium/z, and
// reversion diagnostics - single asset+leader, polled on an interval, no
// universe scan (mirrors ChartSignalsDistillPanel's single-asset shape).

import { useEffect, useState } from 'react'
import type { CointegrationResponse, Timeframe } from '@/lib/os/client'
import { getCointegration, fmtPrice } from '@/lib/os/client'

const POLL_MS = 10_000
const DEFAULT_WINDOW = 180

export default function CointegrationPanel({
  onClose,
  asset,
  tf,
}: {
  onClose: () => void
  asset: string
  tf: Timeframe
}) {
  const [data, setData] = useState<CointegrationResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [window_, setWindow] = useState(DEFAULT_WINDOW)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      setLoading(true)
      try {
        const d = await getCointegration(asset, tf, window_)
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
        <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-400" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">Cointegration</span>
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
        ) : !data.leader ? (
          <div className="font-mono text-[9px] text-[#5a6a85]">
            {asset} is not a tracked lead-lag/cointegration follower (see analytics/leadlag.ts's groups) - nothing to fit.
          </div>
        ) : !r ? (
          <div className="font-mono text-[9px] text-[#5a6a85]">
            not enough overlapping {data.leader}/{asset} history yet for the beta/spread fit (needs ~{window_} bars on {tf}).
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div
              className="flex items-center justify-between rounded-md border px-2 py-2"
              style={{ borderColor: `${dirColor}33`, background: `${dirColor}14` }}
            >
              <div className="flex flex-col">
                <span className="font-mono text-[8px] uppercase tracking-wider text-[#5a6a85]">
                  {asset} vs {data.leader}
                </span>
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
                <span className="text-[#5a6a85]">hedge ratio β</span>
                <span className="text-[#aebccf]">{r.beta.toFixed(4)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#5a6a85]">beta fit R²</span>
                <span className="text-[#aebccf]">{r.r2.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#5a6a85]">spread z</span>
                <span className="text-[#aebccf]">{r.z.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#5a6a85]">reversion t-stat</span>
                <span className="text-[#aebccf]">{r.tStat.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#5a6a85]">half-life</span>
                <span className="text-[#aebccf]">{r.halfLifeBars >= 9999 ? '∞' : `${r.halfLifeBars.toFixed(0)}b`}</span>
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
                min={60}
                max={400}
                step={10}
                value={window_}
                onChange={(e) => setWindow(Number(e.target.value))}
                className="h-1 flex-1 accent-fuchsia-400"
              />
              <span className="w-8 text-right font-mono text-[9px] text-[#aebccf]">{window_}</span>
            </div>

            <p className="font-mono text-[8px] leading-relaxed text-[#3d4d66]">
              Engle-Granger: β is {asset}&apos;s fitted hedge ratio against {data.leader}; the spread (asset - (α + β·leader))
              is OU-fit, and z is how many spread-sigmas it currently sits from its own equilibrium. Needs R² and t-stat both
              clearing a floor to be a real pair, not just noise - same read the &quot;Cointegration Pairs (Engle-Granger)&quot;
              strategy trades in the Backtest Lab.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
