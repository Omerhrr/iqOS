// IQAIR//OS - Accumulation / Manipulation / Distribution (ICT "Power of 3") phase reader for the MSL `amd.*` namespace.
//
// A small causal state machine over CLOSED candles (nothing looks ahead; every phase is a function of the bars up to the last one):
//
//   1. ACCUMULATION  a recent, tight consolidation box: the bars' mean true range is compressed against the bars before it
//                    (<= BOX_COMPRESSION) and the box's high-low range is small against that earlier ATR (<= BOX_RANGE_ATR).
//   2. MANIPULATION  price pokes BEYOND one side of the box (by > EPS_ATR x ATR) and closes back inside within MAX_RETURN bars -
//                    the false break / liquidity grab. (A breach that is NOT reclaimed in time is a real breakout, not manipulation.)
//   3. DISTRIBUTION  after the reclaim, price closes beyond the OPPOSITE edge of the box: the real move. Its direction is opposite the sweep
//                    (sweep of the lows -> bullish, sweep of the highs -> bearish).
//
// The cycle is dropped when it stalls (no distribution within MAX_WAIT bars of the reclaim), fails (price re-breaches the sweep side, or
// closes back through the sweep extreme after distributing) or ages out (MAX_DIST_AGE bars after distribution began).
//
// Two box sources share the same machine:
//   mode 0 "structure": the most recent qualifying consolidation found anywhere in the trailing window (works on OTC and any asset).
//   mode 1 "session":   the UTC-day ASIA range (00:00-08:00) is the accumulation box, and only bars from 08:00 UTC on can sweep it
//                       (London) and distribute (New York) - the classic session-anchored model. Needs real timestamps and the whole
//                       Asia session inside the history; real FX/crypto sessions only (OTC instruments have no market session).
//
// Honest scope: this detects the PATTERN. Whether the pattern has an edge on real markets is not established here.
// Candle-derived only; pure, no I/O.
import type { Candle } from '../types'

export const AMD_MIN_BARS = 120
export const BOX_MIN = 10
export const BOX_MAX = 40
export const BOX_COMPRESSION = 0.65
export const BOX_RANGE_ATR = 2.5
export const PRIOR_BARS = 40
export const EPS_ATR = 0.1
/** a poke must also clear this many mean true ranges OF THE BOX ITSELF, so ordinary noise inside a tight range is not read as a sweep */
export const EPS_NOISE = 0.75
export const MAX_RETURN = 4
export const MAX_WAIT = 15
export const MAX_DIST_AGE = 30

export type AmdPhase = 'none' | 'accumulation' | 'manipulation' | 'distribution'

export interface AmdRead {
  phase: AmdPhase
  /** +1 bullish (swept the lows, real move up) / -1 bearish; 0 until a sweep has happened */
  dir: number
  /** side that was swept: +1 the box high / -1 the box low / 0 none yet */
  sweepSide: number
  /** manipulation only: price has closed back inside the box (the reclaim happened) */
  returned: boolean
  /** a breach that was not reclaimed within MAX_RETURN bars (a genuine breakout; phase is 'none') */
  breakout: number
  boxHigh: number
  boxLow: number
  boxBars: number
  /** bars since the current phase began */
  age: number
  /** how far past the box the sweep extreme went, in ATR */
  sweepDepth: number
  /** distribution only: how far the close is beyond the opposite box edge, in ATR (signed by dir) */
  moveAtr: number
  atr: number
  mode: number
}

const NONE: Omit<AmdRead, 'atr' | 'mode'> = { phase: 'none', dir: 0, sweepSide: 0, returned: false, breakout: 0, boxHigh: 0, boxLow: 0, boxBars: 0, age: 0, sweepDepth: 0, moveAtr: 0 }

interface Box {
  hi: number
  lo: number
  start: number
  end: number
  /** earliest bar that may count as a breach (mode 1: first bar after the Asia session; mode 0: end + 1) */
  from: number
  atr: number
  /** mean true range of the box's own bars */
  noise: number
}

function trueRange(c: Candle[]): number[] {
  const tr = new Array<number>(c.length)
  for (let i = 0; i < c.length; i++) tr[i] = i === 0 ? c[i].high - c[i].low : Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
  return tr
}

/** longest qualifying consolidation ending exactly at bar `e` (compressed against the PRIOR_BARS before it, and small in ATR terms) */
function boxEndingAt(c: Candle[], ps: number[], e: number, minStart = 0): Box | null {
  const meanTr = (a: number, b: number) => (ps[b + 1] - ps[a]) / (b - a + 1)
  let hi = -Infinity
  let lo = Infinity
  const cands: { box: Box; comp: number; range: number }[] = []
  for (let L = 1; L <= BOX_MAX; L++) {
    const k = e - L + 1
    if (k < Math.max(PRIOR_BARS, minStart)) break
    hi = Math.max(hi, c[k].high)
    lo = Math.min(lo, c[k].low)
    if (L < BOX_MIN) continue
    const prior = meanTr(k - PRIOR_BARS, k - 1)
    if (prior <= 1e-12) continue
    const comp = meanTr(k, e) / prior
    if (comp <= BOX_COMPRESSION && hi - lo <= BOX_RANGE_ATR * prior) cands.push({ box: { hi, lo, start: k, end: e, from: e + 1, atr: prior, noise: meanTr(k, e) }, comp, range: hi - lo })
  }
  if (!cands.length) return null
  // the longest box that is still NEARLY as compressed as the quietest one: stops the box from creeping back into the noisy bars that led into it
  const minComp = Math.min(...cands.map((x) => x.comp))
  // ...and whose range has not blown out against the shortest box's (one outlier bar from the lead-in widens a box a lot and would swallow the sweep)
  const minRange = Math.min(...cands.map((x) => x.range))
  let best = cands[0]
  for (const x of cands) if (x.comp <= minComp * 1.3 + 0.02 && x.range <= minRange * 1.4 + 1e-9 && x.box.end - x.box.start >= best.box.end - best.box.start) best = x
  return best.box
}

/** How many bars of history the structure replay walks (older cycles are long dead by MAX_* anyway). */
const REPLAY_BARS = 160

/** Mode 0: replay the trailing window bar by bar like a live observer. A box is FORMED when a qualifying consolidation first exists, extends
 * while it keeps qualifying, and the first bar that pokes beyond it (tested against the box as it stood BEFORE that bar, so a sweep can never be
 * absorbed into its own box) starts the sweep logic. A cycle that ends dead (breakout, stalled, failed, aged out) sends the replay back to
 * looking for the next box. Returns the live read at the last bar. */
function replayStructure(c: Candle[], tr: number[]): AmdRead | null {
  const n = c.length
  const i = n - 1
  const ps = new Array<number>(n + 1).fill(0)
  for (let k = 0; k < n; k++) ps[k + 1] = ps[k] + tr[k]
  let t = Math.max(BOX_MIN + PRIOR_BARS, n - REPLAY_BARS)
  let box: Box | null = null
  let lastValid = -1
  let minStart = 0
  let cand: AmdRead | null = null
  let lastBreakout: { res: AmdRead; at: number } | null = null
  while (t <= i) {
    if (!box) {
      const b0 = boxEndingAt(c, ps, t, minStart)
      if (b0) {
        box = b0
        lastValid = t
        // a NEWER consolidation supersedes an older cycle that is still technically alive
        cand = null
      }
      t++
      continue
    }
    const eps = Math.max(EPS_ATR * box.atr, EPS_NOISE * box.noise)
    if (c[t].high > box.hi + eps || c[t].low < box.lo - eps) {
      const res = runMachine(c, { ...box, from: t }, 0)
      if (res.phase !== 'none') cand = res // live at the last bar; keep looking for a NEWER structure after it
      else if (res.breakout !== 0) lastBreakout = { res, at: t }
      // resume seeking after the breach (a new box may not reuse the sweep's own bars)
      box = null
      lastValid = -1
      minStart = t + 1 + MAX_RETURN
      t++
      continue
    }
    const ext = boxEndingAt(c, ps, t, minStart)
    if (ext) {
      box = ext
      lastValid = t
    } else if (t - lastValid > 10) {
      box = null // loosened and drifted for too long: the consolidation is over
    }
    t++
  }
  if (box) return runMachine(c, { ...box, from: i + 1 }, 0)
  if (cand) return cand
  // a recent unreclaimed breach is worth reporting (phase stays 'none')
  return lastBreakout && i - lastBreakout.at <= MAX_DIST_AGE ? lastBreakout.res : null
}

/** the UTC-day Asia range (mode 1): bars 00:00-08:00 of the last bar's day, requires the session start to be inside the history */
function asiaBox(c: Candle[], tr: number[]): Box | null {
  const n = c.length
  const last = c[n - 1]
  const day = Math.floor(last.time / 86400)
  const dayStart = day * 86400
  const asiaEnd = dayStart + 8 * 3600
  let s = -1
  let e = -1
  for (let k = n - 1; k >= 0; k--) {
    if (c[k].time < dayStart) break
    if (c[k].time < asiaEnd) {
      if (e < 0) e = k
      s = k
    }
  }
  if (s < 0 || e < 0 || e - s + 1 < 6) return null
  // require the history to reach back to the session start (not a partial range)
  const step = n > 1 ? Math.max(1, Math.round((c[n - 1].time - c[0].time) / (n - 1))) : 60
  if (s === 0 && c[0].time > dayStart + 2 * step) return null
  let hi = -Infinity
  let lo = Infinity
  for (let k = s; k <= e; k++) {
    hi = Math.max(hi, c[k].high)
    lo = Math.min(lo, c[k].low)
  }
  const a = tr.slice(Math.max(0, s - PRIOR_BARS), s)
  const atrv = a.length >= 10 ? a.reduce((x, y) => x + y, 0) / a.length : tr.slice(s, e + 1).reduce((x, y) => x + y, 0) / (e - s + 1)
  if (!(atrv > 1e-12) || !(hi - lo > 0)) return null
  return { hi, lo, start: s, end: e, from: e + 1, atr: atrv, noise: tr.slice(s, e + 1).reduce((x, y) => x + y, 0) / (e - s + 1) }
}

function runMachine(c: Candle[], box: Box, mode: number): AmdRead {
  const i = c.length - 1
  const { hi, lo, atr } = box
  const eps = Math.max(EPS_ATR * atr, EPS_NOISE * box.noise)
  const base = { boxHigh: hi, boxLow: lo, boxBars: box.end - box.start + 1, atr, mode }
  const inside = (k: number) => c[k].close <= hi && c[k].close >= lo
  let b = -1
  let side = 0
  for (let j = box.from; j <= i; j++) {
    const up = c[j].high > hi + eps
    const dn = c[j].low < lo - eps
    if (up && dn) return { ...NONE, ...base, breakout: c[j].close > hi ? 1 : c[j].close < lo ? -1 : 0 } // both sides in one bar: not a clean sweep
    if (up || dn) {
      b = j
      side = up ? 1 : -1
      break
    }
  }
  // no breach yet: still accumulating while the last close is inside the box (mode 0 additionally limits staleness)
  if (b < 0) {
    if (!inside(i)) return { ...NONE, ...base }
    if (mode === 0 && i - box.end > 10) return { ...NONE, ...base }
    return { ...NONE, ...base, phase: 'accumulation', age: i - box.start }
  }
  // find the reclaim
  let r = -1
  for (let j = b; j <= Math.min(i, b + MAX_RETURN); j++) {
    if (inside(j)) {
      r = j
      break
    }
  }
  const extreme = (from: number, to: number) => {
    let x = side === 1 ? -Infinity : Infinity
    for (let k = from; k <= to; k++) x = side === 1 ? Math.max(x, c[k].high) : Math.min(x, c[k].low)
    return x
  }
  if (r < 0) {
    if (i < b + MAX_RETURN) {
      // still inside the grace window: the poke is live, reclaim pending
      const x = extreme(b, i)
      return { ...NONE, ...base, phase: 'manipulation', dir: -side, sweepSide: side, returned: false, age: i - b, sweepDepth: Math.abs(x - (side === 1 ? hi : lo)) / atr }
    }
    return { ...NONE, ...base, breakout: side } // not reclaimed in time: a real breakout
  }
  const dir = -side
  const opp = dir === 1 ? hi : lo
  let d = -1
  let ext = extreme(b, r)
  for (let j = r + 1; j <= i; j++) {
    // re-breach of the sweep side after the reclaim = the manipulation failed
    if (side === 1 ? c[j].high > ext + eps && c[j].close > hi : c[j].low < ext - eps && c[j].close < lo) return { ...NONE, ...base, sweepSide: side }
    ext = side === 1 ? Math.max(ext, c[j].high) : Math.min(ext, c[j].low)
    if (d < 0 && (dir === 1 ? c[j].close > hi + eps : c[j].close < lo - eps)) d = j
  }
  const depth = Math.abs(ext - (side === 1 ? hi : lo)) / atr
  if (d < 0) {
    if (i - r > MAX_WAIT) return { ...NONE, ...base, sweepSide: side }
    return { ...NONE, ...base, phase: 'manipulation', dir, sweepSide: side, returned: true, age: i - r, sweepDepth: depth }
  }
  if (i - d > MAX_DIST_AGE) return { ...NONE, ...base, sweepSide: side }
  // a close back through the sweep extreme after distributing = the move failed
  if (side === 1 ? c[i].close > ext : c[i].close < ext) return { ...NONE, ...base, sweepSide: side }
  return { ...NONE, ...base, phase: 'distribution', dir, sweepSide: side, returned: true, age: i - d, sweepDepth: depth, moveAtr: ((c[i].close - opp) * dir) / atr }
}

export function readAmd(candles: Candle[], mode = 0): AmdRead | null {
  const n = candles.length
  if (n < AMD_MIN_BARS) return null
  const tr = trueRange(candles)
  const atrNow = tr.slice(-14).reduce((x, y) => x + y, 0) / 14
  if (mode === 0) return replayStructure(candles, tr) ?? { ...NONE, atr: atrNow, mode }
  const box = asiaBox(candles, tr)
  if (!box) return { ...NONE, atr: atrNow, mode }
  return runMachine(candles, box, mode)
}
