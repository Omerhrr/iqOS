'use client'

// IQAIR//OS - small pieces shared by the Renko Reversal and Kagi Reversal
// boards: labels, the freshness / timeframe controls and the evidence badge.

import type { ReversalBoardTf, ReversalFollowThrough } from '@/lib/os/client'
import { REVERSAL_BOARD_TFS } from '@/lib/os/client'

export function fmtEventTime(t: number): string {
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false })
}

export function ageLabel(candlesAgo: number): string {
  if (candlesAgo <= 0) return 'now'
  if (candlesAgo === 1) return '1 candle ago'
  return `${candlesAgo} candles ago`
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`

export const FRESH_OPTIONS: { value: number; label: string; help: string }[] = [
  { value: 0, label: 'this candle', help: 'only reversals that fired on the newest closed candle' },
  { value: 1, label: '≤1 candle', help: 'fired on the newest or the previous closed candle' },
  { value: 2, label: '≤2 candles', help: 'fired within the last two closed candles' },
  { value: 3, label: '≤3 candles', help: 'fired within the last three closed candles' },
]

/** "How fresh must a reversal be" selector. */
export function FreshnessControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">
      <span className="text-[#4b5a72]">fired</span>
      <div className="flex overflow-hidden rounded border border-[#1c2739]">
        {FRESH_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            title={o.help}
            onClick={() => onChange(o.value)}
            className={`px-1.5 py-px uppercase ${value === o.value ? 'bg-white/10 text-[#dbe4f0]' : 'hover:text-[#dbe4f0]'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 30s..15m timeframe toggles (at least one stays on). */
export function TfToggles({ value, onChange }: { value: Record<ReversalBoardTf, boolean>; onChange: (v: Record<ReversalBoardTf, boolean>) => void }) {
  const activeCount = REVERSAL_BOARD_TFS.filter((t) => value[t]).length
  return (
    <div className="flex items-center gap-1">
      <span className="font-mono text-[9px] text-[#4b5a72]">tf</span>
      {REVERSAL_BOARD_TFS.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => {
            if (value[t] && activeCount === 1) return
            onChange({ ...value, [t]: !value[t] })
          }}
          className={`rounded border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider ${
            value[t] ? 'border-[#3d4d66] bg-white/10 text-[#dbe4f0]' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  )
}

/** Compact evidence chip: how often this kind of event followed through on THIS
 * pair/timeframe's own window, Wilson-floored against the payout breakeven. A
 * flashy rate on a thin sample is never shown as proof. */
export function EvidenceChip({ stat }: { stat: ReversalFollowThrough | null | undefined }) {
  if (!stat) return <span className="font-mono text-[8px] text-[#3d4d66]">no history</span>
  const body = `${stat.wins}/${stat.n} = ${pct(stat.rate)} · floor ${pct(stat.lowerBound)} vs breakeven ${pct(stat.breakeven)}`
  if (stat.proven) {
    return (
      <span className="rounded border border-emerald-500/50 bg-emerald-500/10 px-1 py-px font-mono text-[8px] uppercase tracking-wider text-emerald-300" title={`proven on this pair/timeframe's own window: ${body}`}>
        proven {pct(stat.rate)} · n{stat.n}
      </span>
    )
  }
  if (stat.enough) {
    return (
      <span className="rounded border border-amber-500/40 px-1 py-px font-mono text-[8px] uppercase tracking-wider text-amber-300" title={`enough events, floor does not clear breakeven: ${body}`}>
        not proven · {pct(stat.rate)}
      </span>
    )
  }
  return (
    <span className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]" title={`too few settled events to judge (needs 20): ${body}`}>
      n&lt;20
    </span>
  )
}

export function BoardHonestyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[8.5px] leading-snug text-[#aebccf]">
      {children}
      <div className="mt-1 text-[#4b5a72]">
        The evidence chip is each series&apos; own history (closed candles, next candle, ties count against the event, Wilson floor vs the payout breakeven). A flip is a structural event, not a trade signal; &ldquo;proven&rdquo; is history on that window, not a forecast. Binary options pay under even odds - paper-trade before trusting any of it.
      </div>
    </div>
  )
}
