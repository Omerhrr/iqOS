'use client'

// IQAIR//OS - small pieces shared by the Renko Reversal and Kagi Reversal
// event panels: event time/age labels and the follow-through evidence box.

import type { ReversalFollowThrough } from '@/lib/os/client'

export function fmtEventTime(t: number): string {
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false })
}

export function ageLabel(candlesAgo: number): string {
  if (candlesAgo <= 0) return 'this candle'
  if (candlesAgo === 1) return '1 candle ago'
  return `${candlesAgo} candles ago`
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

/** What happened after past events of each kind on THIS pair: did price close
 * the next `horizon` candle(s) in the event's direction? Wilson floor against
 * the payout's breakeven, so a flashy rate on a thin sample is never called
 * proof. */
export function FollowThroughBox({ stats, title }: { stats: ReversalFollowThrough[]; title: string }) {
  if (!stats.length) {
    return (
      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#7c8aa5]">
        {title}: no settled events in the window yet.
      </div>
    )
  }
  const horizon = stats[0].horizon
  const breakeven = stats[0].breakeven
  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#aebccf]">{title}</span>
        <span className="ml-auto font-mono text-[8px] text-[#4b5a72]">
          next {horizon} candle{horizon === 1 ? '' : 's'} · breakeven {pct(breakeven)}
        </span>
      </div>
      <div className="mt-1 flex flex-col gap-0.5">
        {stats.map((s) => (
          <div key={s.group} className="flex items-center gap-1.5 font-mono text-[9px]">
            <span className="w-[74px] shrink-0 uppercase text-[#7c8aa5]">{s.group}</span>
            <span className="text-[#dbe4f0]">
              {s.wins}/{s.n} = {pct(s.rate)}
            </span>
            <span className="text-[#4b5a72]">floor {pct(s.lowerBound)}</span>
            <span
              className={`ml-auto rounded border px-1 py-px text-[8px] uppercase tracking-wider ${
                s.proven
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                  : s.enough
                    ? 'border-amber-500/40 bg-amber-500/5 text-amber-300'
                    : 'border-[#1c2739] text-[#4b5a72]'
              }`}
              title={
                s.proven
                  ? 'the lower confidence bound clears this payout’s breakeven on this pair’s own window'
                  : s.enough
                    ? 'enough events, but the lower confidence bound does not clear breakeven - no proven follow-through'
                    : 'too few settled events to judge (needs 20)'
              }
            >
              {s.proven ? 'proven' : s.enough ? 'not proven' : `n<20`}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-1.5 font-mono text-[8px] leading-snug text-[#4b5a72]">
        Measured on this pair&apos;s own window, closed candles only; ties count against the event. A flip is a structural event, not a trade signal - only a row marked proven has cleared breakeven, and even that is history, not a forecast.
      </p>
    </div>
  )
}
