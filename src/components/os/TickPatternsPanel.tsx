'use client'

// IQAIR//OS - Tick Patterns panel: candlestick pattern detection on the TICK
// chart, per direct instruction ("lets build a panel for detecting candle
// pattern on tick chart"). Every other pattern surface (Pattern Bias,
// ADX+Pattern, Candle Math) runs detectPatterns() against time-candles
// (1m, 5m, ...) - a formation that only forms and resolves INSIDE one
// time-candle is invisible to all of them. This panel runs the SAME
// detector library (analytics/patterns.ts via analytics/tickpatterns.ts)
// against the tick chart's own N-tick bars (/tick_patterns), so a hit here
// can complete faster than any time-candle would ever show it.
//
// Polls on its own short interval rather than closedTick (a time-candle
// close) - tick bars complete on tick COUNT, not wall-clock candle
// boundaries, so this panel's own cadence needs to be faster than a candle
// close to actually catch a hit while it's still fresh.

import { useCallback, useEffect, useState } from 'react'
import type { TickPatternHit, TickPatternsResponse } from '@/lib/os/client'
import { getTickPatterns } from '@/lib/os/client'

interface TickPatternsPanelProps {
  asset: string
  onClose: () => void
}

const POLL_MS = 3000
const PER_OPTIONS = [5, 10, 20, 30] as const

function HeuristicTag() {
  return (
    <span
      className="ml-1.5 cursor-help rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-amber-400"
      title="Candlestick pattern detection is a heuristic analysis aid, not a guaranteed signal - always confirm against the live tick chart."
    >
      heuristic
    </span>
  )
}

function dirChip(direction: 'bullish' | 'bearish' | 'neutral') {
  const cls =
    direction === 'bullish'
      ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
      : direction === 'bearish'
        ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
        : 'border-[#3d4d66] text-[#7c8aa5]'
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-wider ${cls}`}>
      {direction === 'bullish' ? '▲ bullish' : direction === 'bearish' ? '▼ bearish' : '· neutral'}
    </span>
  )
}

function reliabilityStars(n: 1 | 2 | 3) {
  return (
    <span className="font-mono text-[9px] text-amber-300" title={`reliability ${n}/3`}>
      {'★'.repeat(n)}
      <span className="text-[#2a3650]">{'★'.repeat(3 - n)}</span>
    </span>
  )
}

function hitCard(h: TickPatternHit, now: number) {
  const ageSec = Math.max(0, Math.round(now - h.time))
  const fresh = h.barsAgo === 0
  return (
    <div
      key={`${h.time}:${h.name}`}
      className={`rounded-lg border p-2 ${fresh ? (h.direction === 'bullish' ? 'border-emerald-500/40 bg-emerald-500/5' : h.direction === 'bearish' ? 'border-rose-500/40 bg-rose-500/5' : 'border-[#1c2739] bg-[#0b111c]') : 'border-[#1c2739] bg-[#0b111c] opacity-70'}`}
    >
      <div className="flex items-center justify-between gap-1.5">
        <span className="font-mono text-[10px] font-bold text-[#dbe4f0]">{h.name}</span>
        {reliabilityStars(h.reliability)}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        {dirChip(h.direction)}
        <span className="font-mono text-[8px] text-[#4b5a72]">{h.barsAgo === 0 ? 'latest tick-bar' : `${h.barsAgo} tick-bar${h.barsAgo === 1 ? '' : 's'} ago`}</span>
        <span className="ml-auto font-mono text-[8px] text-[#3d4d66]">{ageSec}s ago · {h.ticks} ticks</span>
      </div>
      <p className="mt-1 font-mono text-[8.5px] leading-relaxed text-[#7c8aa5]">{h.note}</p>
    </div>
  )
}

export default function TickPatternsPanel({ asset, onClose }: TickPatternsPanelProps) {
  const [per, setPer] = useState<number>(10)
  const [data, setData] = useState<TickPatternsResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now() / 1000)

  const load = useCallback(async () => {
    try {
      const d = await getTickPatterns(asset, { per, lookback: 20 })
      if (d.ok) {
        setData(d)
        setErr(null)
      } else {
        setErr(d.error ?? 'tick pattern scan unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    }
    setNow(Date.now() / 1000)
  }, [asset, per])

  useEffect(() => {
    setData(null)
    setErr(null)
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const hits = data?.hits ?? []
  // newest tick-bar first - detectTickPatterns() returns them in
  // detectPatterns()'s own oldest-completed-hit-first order within the
  // lookback window, which reads backwards for a live-monitoring panel.
  const sorted = [...hits].sort((a, b) => b.time - a.time || a.barsAgo - b.barsAgo)

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Tick Patterns</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">{asset} · candlestick patterns on tick-bars</span>
        <HeuristicTag />
        <button type="button" onClick={onClose} className="ml-auto rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300">
          ✕
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">ticks/bar</span>
        <div className="flex gap-1">
          {PER_OPTIONS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPer(p)}
              className={`rounded border px-1.5 py-px font-mono text-[9px] ${per === p ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300' : 'border-[#1c2739] text-[#7c8aa5] hover:border-cyan-500/30'}`}
            >
              {p}
            </button>
          ))}
        </div>
        {data && (
          <span className="ml-auto font-mono text-[8px] text-[#3d4d66]">
            {data.barCount} bars · {data.dataSource === 'candle' ? 'pseudo-ticks' : 'real ticks'}
          </span>
        )}
      </div>

      {err && <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5 font-mono text-[9px] text-rose-300">{err}</div>}

      {data?.dataSource === 'candle' && (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-1.5 font-mono text-[8.5px] leading-relaxed text-amber-300">
          No raw tick buffer available right now - bars are pseudo-ticks (5s candle closes), so hits reflect that coarser resolution, not real sub-second structure.
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {sorted.map((h) => hitCard(h, now))}
        {data && sorted.length === 0 && !err && (
          <p className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#4b5a72]">
            no candlestick pattern in the last {data.lookback} tick-bars - quiet tape, or the noise floor is rejecting bars too thin to trust
          </p>
        )}
        {!data && !err && <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#4b5a72]">loading…</div>}
      </div>

      <p className="shrink-0 font-mono text-[8px] leading-relaxed text-[#3d4d66]">
        Runs the same candlestick-pattern detector every other pattern surface in this OS uses (Pattern Bias, ADX+Pattern, Candle Math, the candle() signal function) - the only difference is what counts as "one candle": tick-bars (N consecutive price observations) instead of a fixed time window. A pattern that forms and fully resolves inside a single 1m/5m candle is invisible to every time-candle pattern scan; this panel is specifically for catching those. Not a guaranteed signal - a heuristic shape match, same honesty framing as every other pattern tool here.
      </p>
    </div>
  )
}
