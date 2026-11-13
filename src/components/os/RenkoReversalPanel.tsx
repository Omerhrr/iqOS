'use client'

// IQAIR//OS - Renko Reversal panel
// Lists ONLY the moments a Renko-style brick chart flipped direction, newest
// first - no state printed between them. Default source is Effort Bricks
// (same geometry and 2-brick reversal rule as Renko, but a smaller ATR x 0.3
// step so the flip fires earlier, and each reversal carries whether real
// volume stood behind it plus the participation regime as of that brick).
// Plain Renko is a switchable source for slow pairs. Below the list, every
// event kind's own measured follow-through on this pair's window, set against
// the payout breakeven - so a flip is never presented as more than it is.
// Backed by /renko_reversals (analytics/reversalevents.ts, plugins/reversalevents.ts).

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RenkoReversalFeed, ReversalRegime } from '@/lib/os/client'
import { fmtPrice, getRenkoReversals } from '@/lib/os/client'
import { ageLabel, fmtEventTime, FollowThroughBox } from './ReversalFeedShared'

interface RenkoReversalPanelProps {
  asset: string
  tf?: string
  /** bumps on every closed candle - keeps the feed fresh */
  closedTick?: number
  onClose: () => void
}

const FALLBACK_POLL_MS = 12_000
/** a reversal this young (in closed candles) is "fresh" - worth a highlighted banner */
const FRESH_CANDLES = 1

const REGIME_CLASS: Record<ReversalRegime, string> = {
  trending: 'text-emerald-300',
  ranging: 'text-sky-300',
  choppy: 'text-amber-300',
  none: 'text-[#7c8aa5]',
}

const REGIME_HELP: Record<ReversalRegime, string> = {
  trending: 'participation-backed bricks run mostly one way',
  ranging: 'participation-backed bricks swing both ways between levels',
  choppy: 'distance painted without real volume behind it - the classic whipsaw tape',
  none: 'not enough bricks (or no volume data) to classify',
}

const arrow = (dir: 'call' | 'put') => (dir === 'call' ? '▲' : '▼')
const dirClass = (dir: 'call' | 'put') => (dir === 'call' ? 'text-emerald-300' : 'text-rose-300')

export default function RenkoReversalPanel({ asset, tf = '1m', closedTick, onClose }: RenkoReversalPanelProps) {
  const [feed, setFeed] = useState<RenkoReversalFeed | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [source, setSource] = useState<'effort' | 'renko'>('effort')
  const [hideChoppy, setHideChoppy] = useState(true)
  const [confirmedOnly, setConfirmedOnly] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await getRenkoReversals(asset, tf, { source, limit: 60 })
      if (res.ok && res.result) {
        setFeed(res.result)
        setErr(null)
      } else {
        setFeed(null)
        setErr(res.error ?? 'Renko reversal feed unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [asset, tf, source])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), FALLBACK_POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick])

  const isEffort = feed?.source === 'effort'
  const noVolume = feed?.effortSource === 'none'
  const shown = useMemo(() => {
    if (!feed) return []
    return feed.events.filter((e) => {
      if (isEffort && hideChoppy && e.regime === 'choppy') return false
      if (isEffort && confirmedOnly && e.confirmed !== true) return false
      return true
    })
  }, [feed, isEffort, hideChoppy, confirmedOnly])
  const hidden = feed ? feed.events.length - shown.length : 0
  const latest = shown[0]
  const fresh = latest !== undefined && latest.candlesAgo <= FRESH_CANDLES

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-orange-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Renko Reversal</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">{asset} · {tf}</span>
        <div className="ml-1 flex overflow-hidden rounded border border-[#1c2739]">
          {(['effort', 'renko'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSource(s)}
              className={`px-1.5 py-px font-mono text-[9px] uppercase ${source === s ? 'bg-orange-500/20 text-orange-300' : 'text-[#7c8aa5] hover:text-[#dbe4f0]'}`}
              title={s === 'effort' ? 'Effort Bricks - ATR x 0.3 step, volume-confirmed (earlier flips, with a quality read)' : 'plain Renko - ATR x 0.3 step, price only (no confirmation data)'}
            >
              {s === 'effort' ? 'effort bricks' : 'plain renko'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
        >
          close
        </button>
      </div>

      {err && (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-[9px] text-amber-300">{err}</div>
      )}

      {feed && (
        <>
          {/* latest reversal banner */}
          <div
            className={`rounded-lg border px-2.5 py-2 ${
              fresh
                ? latest.dir === 'call'
                  ? 'border-emerald-500/50 bg-emerald-500/10'
                  : 'border-rose-500/50 bg-rose-500/10'
                : 'border-[#1c2739] bg-[#0b111c]'
            }`}
          >
            {latest ? (
              <div className="flex items-center gap-2">
                <span className={`font-mono text-lg font-bold leading-none ${dirClass(latest.dir)}`}>{arrow(latest.dir)}</span>
                <div className="flex flex-col">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">
                    {fresh ? 'reversal' : 'last reversal'} · {latest.dir === 'call' ? 'flipped up' : 'flipped down'}
                  </span>
                  <span className="font-mono text-[9px] text-[#7c8aa5]">
                    {ageLabel(latest.candlesAgo)} · {fmtEventTime(latest.time)} · after a {latest.priorRun}-brick run
                  </span>
                </div>
                <div className="ml-auto flex flex-col items-end">
                  <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{fmtPrice(latest.price, asset)}</span>
                  {isEffort && latest.confirmed !== null && (
                    <span className={`font-mono text-[8px] uppercase tracking-wider ${latest.confirmed ? 'text-emerald-300' : 'text-[#7c8aa5]'}`}>
                      {latest.confirmed ? 'confirmed' : 'unconfirmed'}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <span className="font-mono text-[10px] text-[#7c8aa5]">
                {feed.events.length
                  ? 'No reversal passes the filters right now.'
                  : 'No reversal brick in the window yet.'}
              </span>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]" title="the direction of the brick run in progress">
                run {feed.trend === 'none' ? 'n/a' : feed.trend} ×{feed.streak}
              </span>
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]" title={feed.brickRule}>
                brick {fmtPrice(feed.brickSize, asset)}
              </span>
              {isEffort && feed.regime && (
                <span
                  className={`rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider ${REGIME_CLASS[feed.regime]}`}
                  title={`${REGIME_HELP[feed.regime]} · ${(feed.confirmedRatio * 100).toFixed(0)}% of recent bricks volume-confirmed`}
                >
                  {feed.regime}
                </span>
              )}
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]">
                {feed.totalReversals} flips / {feed.candleCount} candles
              </span>
            </div>
          </div>

          {isEffort && noVolume && (
            <div className="rounded border border-amber-500/30 bg-amber-500/5 p-1.5 font-mono text-[9px] text-amber-300">
              No volume on this pair - reversals still list, but nothing can be confirmed and the regime read stays off.
            </div>
          )}

          {/* filters (Effort source only - plain Renko carries no quality data) */}
          {isEffort && !noVolume && (
            <div className="flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#7c8aa5]">
              <label className="flex cursor-pointer items-center gap-1">
                <input type="checkbox" checked={hideChoppy} onChange={(e) => setHideChoppy(e.target.checked)} className="accent-orange-400" />
                hide choppy
              </label>
              <label className="flex cursor-pointer items-center gap-1">
                <input type="checkbox" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} className="accent-orange-400" />
                confirmed only
              </label>
              {hidden > 0 && <span className="ml-auto text-[#4b5a72]">{hidden} hidden</span>}
            </div>
          )}

          {/* event list */}
          <div className="rounded-lg border border-[#1c2739] bg-[#0b111c]">
            <div className="flex items-center border-b border-[#1c2739] px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">
              <span className="w-[58px]">time</span>
              <span className="w-[34px]">dir</span>
              <span className="flex-1">price</span>
              <span className="w-[46px] text-right">run</span>
              {isEffort && <span className="w-[86px] text-right">quality</span>}
            </div>
            {shown.length === 0 ? (
              <div className="px-2 py-3 text-center font-mono text-[9px] text-[#4b5a72]">nothing to show</div>
            ) : (
              shown.map((e) => (
                <div
                  key={`${e.time}-${e.dir}`}
                  className={`flex items-center border-b border-[#1c2739]/60 px-2 py-0.5 font-mono text-[9.5px] last:border-b-0 ${e.candlesAgo <= FRESH_CANDLES ? 'bg-white/[0.03]' : ''}`}
                  title={`${ageLabel(e.candlesAgo)}${e.effortRatio !== null ? ` · volume ${e.effortRatio.toFixed(2)}x the trailing brick average` : ''}`}
                >
                  <span className="w-[58px] text-[#7c8aa5]">{fmtEventTime(e.time)}</span>
                  <span className={`w-[34px] font-bold ${dirClass(e.dir)}`}>{arrow(e.dir)} {e.dir === 'call' ? 'CALL' : 'PUT'}</span>
                  <span className="flex-1 text-[#dbe4f0]">{fmtPrice(e.price, asset)}</span>
                  <span className="w-[46px] text-right text-[#7c8aa5]">{e.priorRun}b</span>
                  {isEffort && (
                    <span className="w-[86px] text-right text-[8.5px] uppercase">
                      {e.confirmed === null ? (
                        <span className="text-[#4b5a72]">n/a</span>
                      ) : (
                        <>
                          <span className={e.confirmed ? 'text-emerald-300' : 'text-[#7c8aa5]'}>{e.confirmed ? 'conf' : 'unconf'}</span>
                          {e.regime && e.regime !== 'none' && <span className={` ${REGIME_CLASS[e.regime]}`}> · {e.regime}</span>}
                        </>
                      )}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          <FollowThroughBox stats={feed.followThrough} title="After a reversal" />

          <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[8.5px] leading-snug text-[#aebccf]">
            A reversal brick prints after a counter-move of two brick sizes, so on a choppy pair it prints constantly - that is why quality is shown with every flip. <span className="text-[#7c8aa5]">Confirmed</span> = the reversal brick carried at least average volume versus the trailing bricks; the regime is the participation read over the 20 bricks ending at it. On OTC pairs &ldquo;volume&rdquo; is often a tick count, not traded size.
          </div>
        </>
      )}
    </div>
  )
}
