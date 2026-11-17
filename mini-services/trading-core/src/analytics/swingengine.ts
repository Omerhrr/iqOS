// IQAIR//OS - generic SWING engine + full ELLIOTT WAVE counter (analytics/swingengine.ts)
// The point of this module is to give MSL the one primitive almost every price-structure strategy is built from: the sequence of confirmed swing highs/lows, the leg between them,
// and how far the developing leg has gone. With that, Elliott waves, support/resistance from pivots, retracement and pullback strategies, trendlines/channels and harmonic ratios are all
// just arithmetic in a script. Swings are wick-to-wick. Two degrees of detection:
//   mode 0 "zigzag": a swing is confirmed once price reverses by k * ATR14 (default k = 2) from the running extreme - bigger k = bigger waves
//   mode 1 "fractal": a swing high/low is the highest/lowest bar of n = round(k) bars on each side, confirmed n bars later; consecutive same-side swings are merged keeping the more extreme
// Sizes are measured in ATR14 of the latest bar. Closed bars only.
import { atr as atrWilder } from './indicators'

export interface SwingIn { high: number[]; low: number[]; close: number[] }
export interface Pivot { idx: number; price: number; type: 1 | -1 } // 1 = swing high, -1 = swing low
export interface Swings { pivots: Pivot[]; cur: Pivot | null; atr: number; last: number }
export const SW_MIN_BARS = 40

export function computeSwings(x: SwingIn, k = 2, mode = 0): Swings {
  const n = x.close.length, atrS = atrWilder(x.high, x.low, x.close, 14), last = n - 1
  const atr = atrS[last]
  const pivots: Pivot[] = []
  if (n < SW_MIN_BARS || !(atr > 0)) return { pivots, cur: null, atr: atr || 0, last }
  if (mode === 1) {
    const w = Math.max(1, Math.round(k))
    for (let i = w; i < n - w; i++) {
      let isH = true, isL = true
      for (let j = 1; j <= w; j++) { if (!(x.high[i] > x.high[i - j]) || !(x.high[i] >= x.high[i + j])) isH = false; if (!(x.low[i] < x.low[i - j]) || !(x.low[i] <= x.low[i + j])) isL = false }
      const add = (type: 1 | -1, price: number): void => {
        const p = pivots[pivots.length - 1]
        if (p && p.type === type) { if (type === 1 ? price > p.price : price < p.price) { p.idx = i; p.price = price } }
        else pivots.push({ idx: i, price, type })
      }
      if (isH && !isL) add(1, x.high[i]); else if (isL && !isH) add(-1, x.low[i]); else if (isH && isL) add(x.high[i] - x.close[i] > x.close[i] - x.low[i] ? 1 : -1, x.high[i] - x.close[i] > x.close[i] - x.low[i] ? x.high[i] : x.low[i])
    }
  } else {
    let dir = 0, hiI = 0, loI = 0, curI = 0, curP = 0
    for (let i = 1; i < n; i++) {
      const thr = k * atrS[i]
      if (!(thr > 0)) { if (x.high[i] > x.high[hiI]) hiI = i; if (x.low[i] < x.low[loI]) loI = i; continue }
      if (dir === 0) {
        if (x.high[i] > x.high[hiI]) hiI = i
        if (x.low[i] < x.low[loI]) loI = i
        if (x.high[i] - x.low[loI] >= thr && loI < i) { pivots.push({ idx: loI, price: x.low[loI], type: -1 }); dir = 1; curI = i; curP = x.high[i] }
        else if (x.high[hiI] - x.low[i] >= thr && hiI < i) { pivots.push({ idx: hiI, price: x.high[hiI], type: 1 }); dir = -1; curI = i; curP = x.low[i] }
      } else if (dir === 1) {
        if (x.high[i] > curP) { curP = x.high[i]; curI = i }
        if (curP - x.low[i] >= thr && curI < i) { pivots.push({ idx: curI, price: curP, type: 1 }); dir = -1; curI = i; curP = x.low[i] }
      } else {
        if (x.low[i] < curP) { curP = x.low[i]; curI = i }
        if (x.high[i] - curP >= thr && curI < i) { pivots.push({ idx: curI, price: curP, type: -1 }); dir = 1; curI = i; curP = x.high[i] }
      }
    }
    if (dir !== 0) return { pivots, cur: { idx: curI, price: curP, type: dir === 1 ? 1 : -1 }, atr, last }
  }
  // fractal mode / undetermined: the developing extreme is the best high (after a low) or low (after a high) since the last pivot
  const lp = pivots[pivots.length - 1]
  if (!lp) return { pivots, cur: null, atr, last }
  let ci = lp.idx + 1
  for (let i = lp.idx + 1; i < n; i++) if (lp.type === -1 ? x.high[i] >= x.high[ci] : x.low[i] <= x.low[ci]) ci = i
  return { pivots, cur: ci < n ? { idx: ci, price: lp.type === -1 ? x.high[ci] : x.low[ci], type: lp.type === -1 ? 1 : -1 } : null, atr, last }
}

// ---- generic accessors: n = 1 is the MOST RECENT confirmed swing ----
export const nth = (s: Swings, n: number, type?: 1 | -1): Pivot | undefined => {
  const k = Math.max(1, Math.round(n))
  const list = type ? s.pivots.filter((p) => p.type === type) : s.pivots
  return list[list.length - k]
}
/** leg n = the move from the (n+1)th-latest to the n-th latest confirmed swing: signed price change (up positive) */
export const legPrice = (s: Swings, n: number): number => { const b = nth(s, n), a = nth(s, n + 1); return a && b ? b.price - a.price : NaN }
export const legBars = (s: Swings, n: number): number => { const b = nth(s, n), a = nth(s, n + 1); return a && b ? b.idx - a.idx : NaN }
/** how much of the last COMPLETED leg the developing leg has given back (0 = none, 1 = all of it, >1 = more than all); NaN when unknown */
export function retraceOfLast(s: Swings): number {
  const lp = nth(s, 1), pp = nth(s, 2)
  if (!lp || !pp || !s.cur) return NaN
  const leg = Math.abs(lp.price - pp.price)
  return leg > 0 ? Math.abs(s.cur.price - lp.price) / leg : NaN
}

// ---- Elliott wave counter built on the swings ----
export interface Ew2 {
  ok: boolean; k: number; dir: number; pts: Pivot[]; atr: number; cur: Pivot | null
  trunc: boolean; rules: Record<number, boolean>; type: string
}
const EMPTY: Ew2 = { ok: false, k: -1, dir: 0, pts: [], atr: 0, cur: null, trunc: false, rules: {}, type: '' }
/** Validate a chain of alternating pivots as impulse (points 0-5) + optional A-B-C (6-8). Mirrored so it only has to think "up". */
function validate(P: number[]): { ok: boolean; rules: Record<number, boolean>; trunc: boolean } {
  const K = P.length - 1, rules: Record<number, boolean> = {}
  let ok = true
  if (K >= 2) { rules[2] = P[2] > P[0]; ok = ok && rules[2] }                                   // wave 2 never retraces more than 100% of wave 1
  if (K >= 3) ok = ok && P[3] > P[1]                                                            // wave 3 must reach beyond the end of wave 1
  if (K >= 4) { rules[4] = P[4] > P[1] && P[4] < P[3]; ok = ok && rules[4] }                    // wave 4 does not overlap wave 1
  let trunc = false
  if (K >= 5) {
    const w1 = P[1] - P[0], w3 = P[3] - P[2], w5 = P[5] - P[4]
    rules[3] = !(w3 < w1 && w3 < w5); ok = ok && rules[3]                                       // wave 3 is never the shortest
    trunc = P[5] < P[3]; rules[5] = !trunc                                                      // a wave 5 that fails to pass wave 3's end is "truncated" (allowed, flagged)
  }
  if (K >= 6) ok = ok && P[6] < P[5]
  if (K >= 7) ok = ok && P[7] > P[6]
  if (K >= 8) ok = ok && P[8] < P[7]
  if (K <= 1) { rules[2] = true; rules[3] = true; rules[4] = true; rules[5] = true }
  if (K < 3) { rules[3] = true } if (K < 4) { rules[4] = true } if (K < 5) { rules[5] = true } if (K < 2) { rules[2] = true }
  return { ok, rules, trunc }
}
export function readEw2(s: Swings): Ew2 {
  const n = s.pivots.length
  if (n < 1 || !s.cur) return EMPTY
  for (let start = Math.max(0, n - 9); start < n; start++) { // oldest valid start = longest chain
    const chain = s.pivots.slice(start), dir = chain[0].type === -1 ? 1 : -1
    const P = chain.map((p) => p.price * dir)
    const v = validate(P)
    if (!v.ok) continue
    const K = chain.length - 1
    if (K < 0) continue
    // a flat/zigzag label for a finished correction
    let type = ''
    if (K >= 8) type = P[8] < P[6] ? (P[7] > P[5] ? 'flat' : 'zigzag') : 'flat'
    return { ok: K >= 2, k: K, dir, pts: chain, atr: s.atr, cur: s.cur, trunc: v.trunc, rules: v.rules, type }
  }
  return EMPTY
}
export const ewLen = (e: Ew2, i: number): number => (e.pts[i] && e.pts[i - 1] ? Math.abs(e.pts[i].price - e.pts[i - 1].price) : NaN)
export function ewRatio(e: Ew2, i: number): number {
  const w = (j: number): number => ewLen(e, j)
  switch (i) {
    case 2: return w(2) / w(1)
    case 3: return w(3) / w(1)
    case 4: return w(4) / w(3)
    case 5: return w(5) / w(1)
    case 7: return w(7) / w(6)
    case 8: return w(8) / w(6)
    default: return NaN
  }
}
/** projected price for wave w at `ratio`: 2 = retrace of wave 1, 3 = extension of wave 1 from the end of 2, 4 = retrace of wave 3, 5 = extension of wave 1 from the end of 4, 7 = retrace of A (B), 8 = extension of A from B (C) */
export function ewProj(e: Ew2, w: number, ratio: number): number {
  const p = (i: number): number => (e.pts[i] ? e.pts[i].price : NaN), d = e.dir
  const w1 = Math.abs(p(1) - p(0)), w3 = Math.abs(p(3) - p(2)), a = Math.abs(p(6) - p(5))
  switch (w) {
    case 2: return p(1) - d * ratio * w1
    case 3: return p(2) + d * ratio * w1
    case 4: return p(3) - d * ratio * w3
    case 5: return p(4) + d * ratio * w1
    case 7: return p(6) + d * ratio * a
    case 8: return p(7) - d * ratio * a
    default: return NaN
  }
}
/** the level that must hold for the count in progress: wave 2 -> start of 1, wave 3 -> end of 2, wave 4 -> end of 1 (overlap rule), wave 5 -> end of 4, correction -> end of 5 */
export function ewInvalid(e: Ew2): number {
  const p = (i: number): number => (e.pts[i] ? e.pts[i].price : NaN)
  switch (e.k) { case 1: return p(0); case 2: return p(2); case 3: return p(1); case 4: return p(4); case 5: case 6: case 7: return p(5); default: return NaN }
}
/** the developing leg has gone beyond the previous same-direction extreme (wave 3 past the end of 1, wave 5 past the end of 3) */
export function ewConfirmed(e: Ew2): boolean {
  if (!e.cur) return false
  const d = e.dir, c = e.cur.price * d
  if (e.k === 2) return c > e.pts[1].price * d
  if (e.k === 4) return c > e.pts[3].price * d
  return false
}
export const EW_STAGES = ['w1', 'w2', 'w3', 'w4', 'w5', 'wA', 'wB', 'wC', 'done'] as const
