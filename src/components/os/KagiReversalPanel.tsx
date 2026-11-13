'use client'

// IQAIR//OS - Kagi Reversal panel (yin / yang)
// Lists ONLY Kagi events, newest first:
//   REVERSAL  the line flipped direction after an ATR-sized move against it
//   YANG      price broke ABOVE the last shoulder - the line turned thick,
//             demand took over (a structural break, can fire mid-trend)
//   YIN       price broke BELOW the last waist - the line turned thin,
//             supply took over
// Yin/yang are the stronger structural events; a bare reversal is often just a
// pullback. The chart view cannot show thickness (its pseudo-candles are
// append-only), which is why this panel reads the engine's event log directly.
// Below the list, each event kind's own measured follow-through on this pair's
// window against the payout breakeven.
// Backed by /kagi_reversals (analytics/kagi.ts events, analytics/reversalevents.ts).

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KagiReversalFeed, ReversalRegime } from '@/lib/os/client'
import { fmtPrice, getKagiReversals } from '@/lib/os/client'
import { ageLabel, fmtEventTime, FollowThroughBox } from './ReversalFeedShared'

interface KagiReversalPanelProps {
  asset: string
  tf?: string
  /** bumps on every closed candle - keeps the feed fresh */
  closedTick?: number
  onClose: () => void
}

type EventType = 'reversal' | 'yang' | 'yin'

const FALLBACK_POLL_MS = 12_000
const FRESH_CANDLES = 1

const TYPE_LABEL: Record<EventType, string> = { reversal: 'REVERSAL', yang: 'YANG', yin: 'YIN' }
const TYPE_CLASS: Record<EventType, string> = {
  reversal: 'border-[#3d4d66] text-[#aebccf]',
  yang: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  yin: 'border-sky-500/50 bg-sky-500/10 text-sky-300',
}
const TYPE_HELP: Record<EventType, string> = {
  reversal: 'the line flipped direction after an ATR-sized move against it',
  yang: 'price broke above the last shoulder - the line turned thick; demand took over',
  yin: 'price broke below the last waist - the line turned thin; supply took over',
}
const REGIME_CLASS: Record<ReversalRegime, string> = {
  trending: 'text-emerald-300',
  ranging: 'text-sky-300',
  choppy: 'text-amber-300',
  none: 'text-[#7c8aa5]',
}

const arrow = (dir: 'call' | 'put') => (dir === 'call' ? '▲' : '▼')
const dirClass = (dir: 'call' | 'put') => (dir === 'call' ? 'text-emerald-300' : 'text-rose-300')

export default function KagiReversalPanel({ asset, tf = '1m', closedTick, onClose }: KagiReversalPanelProps) {
  const [feed, setFeed] = useState<KagiReversalFeed | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [on, setOn] = useState<Record<EventType, boolean>>({ reversal: true, yang: true, yin: true })

  const load = useCallback(async () => {
    try {
      const res = await getKagiReversals(asset, tf, { limit: 80 })
      if (res.ok && res.result) {
        setFeed(res.result)
        setErr(null)
      } else {
        setFeed(null)
        setErr(res.error ?? 'Kagi reversal feed unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [asset, tf])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), FALLBACK_POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick])

  const shown = useMemo(() => (feed ? feed.events.filter((e) => on[e.type]) : []), [feed, on])
  const latest = shown[0]
  const fresh = latest !== undefined && latest.candlesAgo <= FRESH_CANDLES
  const levelText = (type: EventType, level: number | null) =>
    level === null ? '' : `${type === 'reversal' ? 'from' : 'broke'} ${fmtPrice(level, asset)}`

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Kagi Reversal</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">{asset} · {tf}</span>
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
          {/* latest event banner */}
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
                    {fresh ? '' : 'last '}
                    {TYPE_LABEL[latest.type].toLowerCase()} · {latest.dir === 'call' ? 'bullish' : 'bearish'}
                  </span>
                  <span className="font-mono text-[9px] text-[#7c8aa5]">
                    {ageLabel(latest.candlesAgo)} · {fmtEventTime(latest.time)} {levelText(latest.type, latest.level) && `· ${levelText(latest.type, latest.level)}`}
                  </span>
                </div>
                <div className="ml-auto flex flex-col items-end">
                  <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{fmtPrice(latest.price, asset)}</span>
                  <span className={`font-mono text-[8px] uppercase tracking-wider ${latest.thick ? 'text-amber-300' : 'text-sky-300'}`}>
                    {latest.thick ? 'yang · thick' : 'yin · thin'}
                  </span>
                </div>
              </div>
            ) : (
              <span className="font-mono text-[10px] text-[#7c8aa5]">
                {feed.events.length ? 'No event passes the filters right now.' : 'No Kagi event in the window yet.'}
              </span>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]" title="direction of the line in progress">
                line {feed.direction === 'none' ? 'n/a' : feed.direction}
              </span>
              <span
                className={`rounded border px-1.5 py-px font-mono text-[8px] uppercase tracking-wider ${feed.thick ? TYPE_CLASS.yang : TYPE_CLASS.yin}`}
                title={feed.thick ? TYPE_HELP.yang : TYPE_HELP.yin}
              >
                now {feed.thick ? 'yang' : 'yin'}
              </span>
              <span className={`rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider ${REGIME_CLASS[feed.regime]}`} title="Kagi regime - structure of the last shoulders/waists, gated by how densely the line reverses">
                {feed.regime}
                {feed.structure !== 'none' ? ` · ${feed.structure}` : ''}
              </span>
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]" title="reversal threshold (ATR-adaptive)">
                rev {fmtPrice(feed.reversal, asset)}
              </span>
            </div>
            {(feed.shoulder !== null || feed.waist !== null) && (
              <div className="mt-1 flex gap-3 font-mono text-[9px] text-[#7c8aa5]" title="a close above the shoulder fires YANG; a close below the waist fires YIN">
                {feed.shoulder !== null && <span>shoulder <span className="text-amber-300">{fmtPrice(feed.shoulder, asset)}</span></span>}
                {feed.waist !== null && <span>waist <span className="text-sky-300">{fmtPrice(feed.waist, asset)}</span></span>}
              </div>
            )}
          </div>

          {/* type filters */}
          <div className="flex flex-wrap items-center gap-1">
            {(['yang', 'yin', 'reversal'] as EventType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setOn((p) => ({ ...p, [t]: !p[t] }))}
                title={TYPE_HELP[t]}
                className={`rounded border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider transition-opacity ${TYPE_CLASS[t]} ${on[t] ? '' : 'opacity-35'}`}
              >
                {TYPE_LABEL[t]} {feed.counts[t]}
              </button>
            ))}
          </div>

          {/* event list */}
          <div className="rounded-lg border border-[#1c2739] bg-[#0b111c]">
            <div className="flex items-center border-b border-[#1c2739] px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">
              <span className="w-[58px]">time</span>
              <span className="w-[62px]">event</span>
              <span className="w-[34px]">dir</span>
              <span className="flex-1">price</span>
              <span className="w-[96px] text-right">level</span>
            </div>
            {shown.length === 0 ? (
              <div className="px-2 py-3 text-center font-mono text-[9px] text-[#4b5a72]">nothing to show</div>
            ) : (
              shown.map((e) => (
                <div
                  key={`${e.time}-${e.type}-${e.dir}`}
                  className={`flex items-center border-b border-[#1c2739]/60 px-2 py-0.5 font-mono text-[9.5px] last:border-b-0 ${e.candlesAgo <= FRESH_CANDLES ? 'bg-white/[0.03]' : ''}`}
                  title={`${ageLabel(e.candlesAgo)} · ${TYPE_HELP[e.type]}`}
                >
                  <span className="w-[58px] text-[#7c8aa5]">{fmtEventTime(e.time)}</span>
                  <span className="w-[62px]">
                    <span className={`rounded border px-1 py-px text-[8px] uppercase tracking-wider ${TYPE_CLASS[e.type]}`}>{TYPE_LABEL[e.type]}</span>
                  </span>
                  <span className={`w-[34px] font-bold ${dirClass(e.dir)}`}>{arrow(e.dir)}</span>
                  <span className="flex-1 text-[#dbe4f0]">{fmtPrice(e.price, asset)}</span>
                  <span className="w-[96px] text-right text-[8.5px] text-[#4b5a72]">{e.level === null ? '' : fmtPrice(e.level, asset)}</span>
                </div>
              ))
            )}
          </div>

          <FollowThroughBox stats={feed.followThrough} title="After a Kagi event" />

          <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[8.5px] leading-snug text-[#aebccf]">
            Yang and yin are structural breaks and can fire mid-trend, not only at a reversal. A bare reversal after a short run is often just a pullback. The reversal size is ATR-adaptive, so on fast expiries the line can lag - tighten it in MSL (<span className="text-[#7c8aa5]">kagi.reversalAtrMult</span>) if you trade 60s and under.
          </div>
        </>
      )}
    </div>
  )
}
