// IQAIR//OS - Reversal Detection engine
//
// A dedicated "is this turning RIGHT NOW" panel, sibling of the Technical
// Summary engine (analytics/technicals.ts) and its rung-for-rung ladder
// (1s/2s/3s tick-built, 5s..5m native, 3m aggregated from 1m). Where the
// Technical Summary asks "which way is this timeframe leaning", this engine
// asks the sharper exhaustion question: "is the CURRENT move losing its
// last believers and flipping?" - and answers in states, not vibes:
//
//   calm        no stretch, no trigger, nothing to act on
//   forming     an extreme is in place (oversold/overbought/stretched) and
//               counter-pressure is building, but no bar-0 trigger yet
//   reversing   trigger fired on the LATEST closed bar + enough net weight -
//               the "reversing now" signal the operator asked for
//   confirmed   trigger fired on the PRIOR bar and the latest bar CLOSED
//               further in the reversal direction (follow-through)
//
// Detector panel (each vote carries a weight, all fail-closed):
//   1. RSI(14) extreme hook      w2  oversold/overbought AND turning
//   2. Stochastic(14,3,3) cross  w2  K crosses D out of the extreme zone
//   3. Candle reversal patterns  w1-3  the OS's own detector library
//     (Hammer/Shooting Star/Engulfing/Morning-Evening Star/... via
//     detectPatterns + patternBias - noise-floored, recency-weighted);
//     bar-0 hits are TRIGGERS, bar-1 hits only support "confirmed"
//   4. Bollinger(20,2) re-entry  w2  pierced band, then closed back inside
//   5. RSI divergence            w3  price new extreme, RSI disagrees
//   6. Run exhaustion fade       w1-2  4+ same-direction bars, counter-close
//   7. Stretch fade (z-score)    w1  close > 2 sigma from SMA20, moving back
//
// HONESTY: a rung with fewer than REV_MIN_BARS closed bars is ok:false
// "warming up"; a tick-built rung on a stale feed is ok:false, never "calm"
// (calm is a market statement, warm-up is a data statement - they must not
// be conflated). One-tick bars (sparse feeds) are disclosed via ticksPerBar:
// wick-based detectors self-reject there through the pattern library's own
// noise floor, and the reasons list shows exactly which detectors voted.
// Pure functions, closed bars only, no look-ahead.

import type { Candle } from '../types'
import { sma, rsi, stochastic, bollinger, stdDev, isn } from './indicators'
import { detectPatterns, patternBias } from './patterns'
import {
  TECH_LADDER, TECH_TICK_STALE_SEC, barsFromTicks, aggregateCandles, type TickPoint,
} from './technicals'

/** Min closed bars before a rung's reversal state is read at all (covers
 * RSI/Stoch/BB warmup + the divergence lookback comfortably). */
export const REV_MIN_BARS = 60
/** Bars of history fed to the detectors per rung. */
export const REV_BARS_PER_RUNG = 120

export type ReversalState = 'calm' | 'forming' | 'reversing' | 'confirmed'
export type ReversalDir = 'up' | 'down' | 'none'

export interface ReversalReason {
  detector: string
  dir: 'up' | 'down'
  weight: number
  note: string
}

export interface ReversalTfRow {
  tf: string
  sec: number
  source: 'ticks' | 'native' | 'agg1m'
  ok: boolean
  note: string
  bars: number
  /** tick-built rungs only: mean observations per bar */
  ticksPerBar: number | null
  state: ReversalState
  direction: ReversalDir
  /** net directional weight: sum(up) - sum(down) - signed conviction */
  score: number
  reasons: ReversalReason[]
}

export interface ReversalSummary {
  asset: string
  ts: number
  mode: 'sim' | 'live'
  price: number
  rows: ReversalTfRow[]
  /** the most urgent live read across the ladder (reversing > confirmed >
   * forming), or null when every live rung is calm */
  best: { tf: string; state: ReversalState; direction: 'up' | 'down'; score: number } | null
  note: string
}

const STATE_RANK: Record<ReversalState, number> = { calm: 0, forming: 1, confirmed: 2, reversing: 3 }

const last = (arr: number[]): number => (arr.length ? arr[arr.length - 1] : NaN)

interface Vote {
  detector: string
  dir: 'up' | 'down'
  weight: number
  note: string
  /** true only for bar-0 events (pattern on the latest bar, stoch cross,
   * BB re-entry) - the "reversing NOW" trigger class */
  trigger: boolean
}

/** Two most recent swing extremes (local pivots with `w` bars clearance)
 * inside the lookback - the divergence engine's price/RSI anchor pairs. */
function lastTwoPivots(values: number[], w: number, kind: 'low' | 'high'): [number, number] | null {
  const pivots: number[] = []
  const start = Math.max(w, values.length - 60)
  for (let i = start; i < values.length - w; i++) {
    let extreme = true
    for (let j = i - w; j <= i + w; j++) {
      if (j === i || j < 0 || j >= values.length) continue
      if (kind === 'low' ? values[j] < values[i] : values[j] > values[i]) { extreme = false; break }
    }
    if (extreme) pivots.push(i)
  }
  if (pivots.length < 2) return null
  return [pivots[pivots.length - 2], pivots[pivots.length - 1]]
}

/** All detector reads for one rung's closed bars. Every branch is gated on
 * finite indicator values - a thin or degenerate series votes nothing. */
export function reversalVotes(bars: Candle[]): Vote[] {
  const votes: Vote[] = []
  const n = bars.length
  if (n < REV_MIN_BARS) return votes
  const cl = bars.map((c) => c.close)
  const hi = bars.map((c) => c.high)
  const lo = bars.map((c) => c.low)
  const lastBar = bars[n - 1]
  const prevBar = bars[n - 2]

  // 1. RSI(14) extreme hook
  const r = rsi(cl, 14)
  const rN = last(r); const rP = r[n - 2]
  if (isn(rN) && isn(rP)) {
    if (rP < 30 && rN > rP) votes.push({ detector: 'RSI hook', dir: 'up', weight: 2, note: `RSI hooking up from oversold (${rP.toFixed(1)} → ${rN.toFixed(1)})`, trigger: false })
    else if (rP > 70 && rN < rP) votes.push({ detector: 'RSI hook', dir: 'down', weight: 2, note: `RSI hooking down from overbought (${rP.toFixed(1)} → ${rN.toFixed(1)})`, trigger: false })
  }

  // 2. Stochastic(14,3,3) cross out of the extreme zone
  const st = stochastic(hi, lo, cl, 14, 3, 3)
  const kN = last(st.k); const dN = last(st.d); const kP = st.k[n - 2]; const dP = st.d[n - 2]
  if (isn(kN) && isn(dN) && isn(kP) && isn(dP)) {
    if (kP < 20 && kP <= dP && kN > dN) votes.push({ detector: 'Stoch cross', dir: 'up', weight: 2, note: `Stoch crossed up from oversold (K ${kP.toFixed(0)}→${kN.toFixed(0)})`, trigger: true })
    else if (kP > 80 && kP >= dP && kN < dN) votes.push({ detector: 'Stoch cross', dir: 'down', weight: 2, note: `Stoch crossed down from overbought (K ${kP.toFixed(0)}→${kN.toFixed(0)})`, trigger: true })
  }

  // 3. Candle reversal patterns - the OS's own noise-floored library.
  //    barsAgo 0 = trigger (reversing NOW), barsAgo 1 = follow-through
  //    support only (feeds the "confirmed" state).
  const hits = detectPatterns(bars, 3).filter((h) => h.barsAgo <= 1 && h.direction !== 'neutral')
  if (hits.length) {
    const table: Record<string, number> = {}
    for (const h of hits) table[h.name] = h.reliability
    const bias = patternBias(hits, table)
    if (Math.abs(bias) >= 1) {
      const dir: 'up' | 'down' = bias > 0 ? 'up' : 'down'
      const fresh = hits.filter((h) => h.direction === (dir === 'up' ? 'bullish' : 'bearish'))
      const newest = [...fresh].sort((a, b) => a.barsAgo - b.barsAgo || b.reliability - a.reliability)[0]
      votes.push({
        detector: 'Candle patterns',
        dir,
        weight: Math.max(1, Math.min(3, Math.max(1, Math.round(Math.abs(bias)))) - (newest.barsAgo === 1 ? 1 : 0)),
        note: `${newest.name} ${newest.barsAgo === 0 ? 'on the latest bar' : 'one bar ago'} - ${newest.note.toLowerCase()}`,
        trigger: newest.barsAgo === 0,
      })
    }
  }

  // 4. Bollinger(20,2) pierce + re-entry
  const bb = bollinger(cl, 20, 2)
  if (isn(bb.lower[n - 1]) && isn(bb.upper[n - 1]) && prevBar) {
    if (prevBar.close < bb.lower[n - 2] && lastBar.close >= bb.lower[n - 1]) votes.push({ detector: 'Band re-entry', dir: 'up', weight: 2, note: 'pierced lower Bollinger band, closed back inside', trigger: true })
    else if (prevBar.close > bb.upper[n - 2] && lastBar.close <= bb.upper[n - 1]) votes.push({ detector: 'Band re-entry', dir: 'down', weight: 2, note: 'pierced upper Bollinger band, closed back inside', trigger: true })
  }

  // 5. RSI divergence on the last two swing pivots
  const pivLo = lastTwoPivots(cl, 2, 'low')
  if (pivLo && isn(r[pivLo[0]]) && isn(r[pivLo[1]])) {
    const [a, b] = pivLo
    if (cl[b] < cl[a] && r[b] > r[a] + 2) votes.push({ detector: 'Divergence', dir: 'up', weight: 3, note: `bullish divergence: price lower low, RSI higher low (${r[a].toFixed(0)} → ${r[b].toFixed(0)})`, trigger: false })
  }
  const pivHi = lastTwoPivots(cl, 2, 'high')
  if (pivHi && isn(r[pivHi[0]]) && isn(r[pivHi[1]])) {
    const [a, b] = pivHi
    if (cl[b] > cl[a] && r[b] < r[a] - 2) votes.push({ detector: 'Divergence', dir: 'down', weight: 3, note: `bearish divergence: price higher high, RSI lower high (${r[a].toFixed(0)} → ${r[b].toFixed(0)})`, trigger: false })
  }

  // 6. Run exhaustion fade: 4+ consecutive same-body-direction bars is an
  //    extended run - fade it. Weight grows when the run is unusually long.
  let runLen = 1
  for (let i = n - 1; i > 0; i--) {
    const upI = bars[i].close > bars[i].open
    const upPrev = bars[i - 1].close > bars[i - 1].open
    if (upI === upPrev && bars[i].close !== bars[i].open) runLen++
    else break
  }
  if (runLen >= 4) {
    const runUp = bars[n - 1].close > bars[n - 1].open
    if (runUp) votes.push({ detector: 'Run exhaustion', dir: 'down', weight: runLen >= 6 ? 2 : 1, note: `${runLen}-bar up run extended - fade vote`, trigger: false })
    else votes.push({ detector: 'Run exhaustion', dir: 'up', weight: runLen >= 6 ? 2 : 1, note: `${runLen}-bar down run extended - fade vote`, trigger: false })
  }

  // 7. Stretch fade: close > 2 sigma from SMA(20) and moving back toward the mean
  const m20 = sma(cl, 20)
  const sd20 = stdDev(cl, 20)
  const zN = isn(m20[n - 1]) && isn(sd20[n - 1]) && sd20[n - 1] > 0 ? (cl[n - 1] - m20[n - 1]) / sd20[n - 1] : NaN
  const zP = isn(m20[n - 2]) && isn(sd20[n - 2]) && sd20[n - 2] > 0 ? (cl[n - 2] - m20[n - 2]) / sd20[n - 2] : NaN
  if (isn(zN) && isn(zP)) {
    if (zP <= -2 && zN > zP) votes.push({ detector: 'Stretch fade', dir: 'up', weight: 1, note: `stretched ${Math.abs(zP).toFixed(1)}σ below SMA20, snapping back (z ${zP.toFixed(1)} → ${zN.toFixed(1)})`, trigger: false })
    else if (zP >= 2 && zN < zP) votes.push({ detector: 'Stretch fade', dir: 'down', weight: 1, note: `stretched ${zP.toFixed(1)}σ above SMA20, snapping back (z ${zP.toFixed(1)} → ${zN.toFixed(1)})`, trigger: false })
  }

  return votes
}

/** One rung's reversal state from its closed bars. */
export function readReversalTf(
  tf: string,
  sec: number,
  source: 'ticks' | 'native' | 'agg1m',
  bars: Candle[],
  opts: { nowSec?: number; ticksPerBar?: number | null } = {},
): ReversalTfRow {
  const closed = bars.filter((c) => c && Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0)
  const base = { tf, sec, source, ticksPerBar: opts.ticksPerBar ?? null }
  if (closed.length < REV_MIN_BARS) {
    return { ...base, ok: false, note: `warming up - needs ${REV_MIN_BARS}+ closed bars (has ${closed.length})`, bars: closed.length, state: 'calm', direction: 'none', score: 0, reasons: [] }
  }
  if (source === 'ticks' && opts.nowSec !== undefined) {
    const newestBarEnd = closed[closed.length - 1].time + sec
    if (opts.nowSec - newestBarEnd > TECH_TICK_STALE_SEC) {
      return { ...base, ok: false, note: `tick feed stale - newest bar ends ${Math.round(opts.nowSec - newestBarEnd)}s ago`, bars: closed.length, state: 'calm', direction: 'none', score: 0, reasons: [] }
    }
  }
  const votes = reversalVotes(closed)
  const reasons: ReversalReason[] = votes.map((v) => ({ detector: v.detector, dir: v.dir, weight: v.weight, note: v.note }))
  let up = 0; let down = 0
  for (const v of votes) (v.dir === 'up' ? (up += v.weight) : (down += v.weight))
  const net = up - down
  const direction: ReversalDir = net > 0 ? 'up' : net < 0 ? 'down' : 'none'

  // one-bar lookback: the PRIOR bar's detector read. A trigger that fired
  // one bar ago is invisible to the bar-0 vote panel, but "that read was
  // STRONG (net >= 3) AND trigger-fired, and price has followed through
  // with a further close in the same direction" is exactly what a
  // CONFIRMED reversal is - the current bar's own residual votes only need
  // to still point the same way, not re-reach the full threshold.
  const priorVotes = net !== 0 && closed.length > REV_MIN_BARS ? reversalVotes(closed.slice(0, -1)) : []
  let priorUp = 0; let priorDown = 0
  for (const v of priorVotes) (v.dir === 'up' ? (priorUp += v.weight) : (priorDown += v.weight))
  const priorNet = priorUp - priorDown
  const priorStrong = direction === 'up' ? priorNet >= 3 : direction === 'down' ? priorNet <= -3 : false
  const priorTriggerInDir = priorVotes.some((v) => v.trigger && v.dir === direction)

  let state: ReversalState = 'calm'
  const lastBar = closed[closed.length - 1]
  const prevBar = closed[closed.length - 2]
  const extended = direction === 'up' ? lastBar.close > prevBar.close : direction === 'down' ? lastBar.close < prevBar.close : false
  if (direction !== 'none' && Math.abs(net) >= 3 && votes.some((v) => v.trigger && v.dir === direction)) {
    state = 'reversing'
  } else if (priorStrong && priorTriggerInDir && extended) {
    // the prior bar carried the full signal; this bar only had to follow
    // through - fresh triggers on THIS bar would have said reversing above
    state = 'confirmed'
  }
  if (state === 'calm' && Math.abs(net) >= 2) state = 'forming'

  const note = `${closed.length} closed bars · ${votes.length} detector vote${votes.length === 1 ? '' : 's'}`
  return { ...base, ok: true, note, bars: closed.length, state, direction, score: net, reasons }
}

/** Assemble the whole-ladder reversal read from pre-fetched data (same
 * input contract as buildTechnicalSummary - the plugin owns market access,
 * the engine stays pure). */
export function buildReversalSummary(input: {
  asset: string
  mode: 'sim' | 'live'
  price: number
  native: Record<string, Candle[]>
  ticks: TickPoint[]
  nowSec: number
}): ReversalSummary {
  const rows: ReversalTfRow[] = []
  for (const rung of TECH_LADDER) {
    if (rung.source === 'ticks') {
      const relevant = input.ticks.filter((p) => Number.isFinite(p.time) && input.nowSec - p.time <= 6 * 3600)
      const tail = relevant.slice(-REV_BARS_PER_RUNG * 4)
      const { bars, ticksPerBar } = barsFromTicks(tail, rung.sec)
      rows.push(readReversalTf(rung.tf, rung.sec, 'ticks', bars.slice(-REV_BARS_PER_RUNG), { nowSec: input.nowSec, ticksPerBar }))
    } else if (rung.source === 'agg1m') {
      const src = input.native['1m'] ?? []
      const bars = aggregateCandles(src.slice(-REV_BARS_PER_RUNG * 3), 60, 3)
      rows.push(readReversalTf(rung.tf, rung.sec, 'agg1m', bars.slice(-REV_BARS_PER_RUNG)))
    } else {
      const bars = (input.native[rung.tf] ?? []).slice(-REV_BARS_PER_RUNG)
      rows.push(readReversalTf(rung.tf, rung.sec, 'native', bars))
    }
  }

  const live = rows.filter((r) => r.ok)
  let best: ReversalSummary['best'] = null
  for (const r of live) {
    if (r.state === 'calm' || r.direction === 'none') continue
    // narrowed by the guard above - the best pick never carries 'none'
    const dir: 'up' | 'down' = r.direction
    if (!best || STATE_RANK[r.state] > STATE_RANK[best.state] || (STATE_RANK[r.state] === STATE_RANK[best.state] && Math.abs(r.score) > Math.abs(best.score))) {
      best = { tf: r.tf, state: r.state, direction: dir, score: r.score }
    }
  }
  const note = live.length === 0
    ? 'every rung still warming up - no reversal reads yet'
    : best
      ? `${best.tf} ${best.state} ${best.direction} (score ${best.score > 0 ? '+' : ''}${best.score})`
      : 'no rung is turning - all calm'
  return { asset: input.asset, ts: Date.now(), mode: input.mode, price: input.price, rows, best, note }
}
