// IQAIR//OS - chart-pattern engine (MSL `cp.*`, `autotrend.*`, `ew.*`; also folded into detectPatterns() so every candle-pattern surface sees these hits).
//
// All geometry is measured in ATR14 of the SAME series (never percent of price), so a pattern means the same on EURUSD, an index or a synthetic OTC feed. Closed candles only, last 160 bars.
// Pivots are fractals (3 bars each side). A pattern's boundary lines are least-squares fits through 2-4 pivots with every touch within 0.35 ATR of the line.
//
//   BOUNDARY patterns (upper line through pivot highs, lower line through pivot lows; drift d = slope x span / ATR):
//     Ascending Triangle  flat top (|d|<=0.8), rising lows (d>=1.0), converging           bullish
//     Descending Triangle flat bottom, falling highs (d<=-1.0), converging                 bearish
//     Symmetrical Triangle falling highs + rising lows, converging                          neutral (direction = the break)
//     Falling Wedge       both falling, upper falls faster, converging                      bullish
//     Rising Wedge        both rising, lower rises faster, converging                       bearish
//     Rectangle           both flat, width >= 1.5 ATR, not converging                       continuation of the prior trend (neutral without one)
//     Bull/Bear Pennant   a POLE (>= 3 ATR in <= 12 bars, efficiency >= 0.5) then a small converging triangle (5-30 bars) that gave back < 50% of the pole
//     Bull/Bear Flag      a POLE then a parallel channel sloping AGAINST it (5-30 bars), retracing < 50% of the pole
//   PIVOT-SEQUENCE patterns:
//     Head and Shoulders (bearish) / Inverse (bullish): three peaks, the middle one highest by >= 0.5 ATR, shoulders within 35% of the head height of each other, troughs level within half the head height
//     Cup and Handle (bullish) / Inverted (bearish): rounded base >= 3 ATR deep over 15+ bars (parabola R2 >= 0.6, bottom in the middle), right rim within 15% of the depth of the left rim, then a 3-25 bar handle that gives back <= 50% of the depth
//   Each pattern is FORMING while price is inside its boundary (barsAgo 0), and BROKEN when a bar closed beyond the boundary by 0.1 ATR (direction = the break, barsAgo = bars since); a break older than 8 bars is dropped.
//   `target` = the classic measured move (pattern height or pole from the break level).
// AUTO TREND: regression of the last 50 closes (slope in ATR/bar, R2) + pivot trendline (lows in an up-trend / highs in a down-trend) with touches; broken = a close beyond that line by 0.3 ATR.
// ELLIOTT: a zig-zag (1.5 ATR reversal) of highs/lows; mechanical rules only: wave 2 never beyond the start of wave 1, wave 3 not the shortest of 1/3/5, wave 4 never overlaps wave 1's end.
//   States: wave3 (W1,W2 confirmed and price is beyond W1's end), wave5 (W1-W4 confirmed, price extending), wave5done (five waves in, price turned back), abcdone (zig-zag A-B-C complete and turning).
// HONEST: these are rule-based readings of discretionary patterns. Wave counting in particular is subjective - this is ONE strict reading, it will miss counts a human would make and nothing here has a measured edge.
import type { Candle } from '../types'
import { atr } from './indicators'

export const CP_MIN_BARS = 60
const WINDOW = 160
const MAX_BREAK_AGE = 8

export type CpDir = 'bullish' | 'bearish' | 'neutral'
export interface CpLine { slope: number; intercept: number } // price = intercept + slope * barIndex (index within the analysed window)
export interface CpHit {
  name: string
  direction: CpDir
  reliability: 1 | 2 | 3
  barsAgo: number
  note: string
  broken: boolean
  /** boundary values at the latest bar (when the pattern has them) */
  upper?: number
  lower?: number
  target?: number
}
interface Pv { i: number; p: number }

function pivots(c: Candle[], K = 3): { highs: Pv[]; lows: Pv[] } {
  const highs: Pv[] = [], lows: Pv[] = []
  for (let i = K; i < c.length - K; i++) {
    let h = true, l = true
    for (let k = 1; k <= K; k++) {
      if (!(c[i].high > c[i - k].high && c[i].high >= c[i + k].high)) h = false
      if (!(c[i].low < c[i - k].low && c[i].low <= c[i + k].low)) l = false
    }
    if (h) highs.push({ i, p: c[i].high })
    if (l) lows.push({ i, p: c[i].low })
  }
  return { highs, lows }
}
function fit(pts: Pv[]): { line: CpLine; resid: number } {
  const n = pts.length
  const mx = pts.reduce((a, p) => a + p.i, 0) / n, my = pts.reduce((a, p) => a + p.p, 0) / n
  let sxx = 0, sxy = 0
  for (const p of pts) { sxx += (p.i - mx) ** 2; sxy += (p.i - mx) * (p.p - my) }
  const slope = sxx > 0 ? sxy / sxx : 0
  const line = { slope, intercept: my - slope * mx }
  let resid = 0
  for (const p of pts) resid = Math.max(resid, Math.abs(p.p - (line.intercept + slope * p.i)))
  return { line, resid }
}
const at = (l: CpLine, i: number): number => l.intercept + l.slope * i

function prep(candles: Candle[]): { c: Candle[]; A: number } | null {
  if (candles.length < CP_MIN_BARS) return null
  const c = candles.slice(-WINDOW)
  const a14 = atr(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 14)
  const A = a14[a14.length - 1]
  if (!Number.isFinite(A) || A <= 0) return null
  return { c, A }
}

/** pole: the strongest directional move of 3..12 bars ending at or just before `start` */
function pole(c: Candle[], start: number, A: number): { dir: 1 | -1; size: number; begin: number } | null {
  let best: { dir: 1 | -1; size: number; begin: number } | null = null
  for (let m = 3; m <= 12; m++) {
    const b = start - m
    if (b < 0) break
    const net = c[start].close - c[b].close
    let path = 0
    for (let k = b + 1; k <= start; k++) path += Math.abs(c[k].close - c[k - 1].close)
    if (path <= 0 || Math.abs(net) / path < 0.5) continue
    if (Math.abs(net) >= 3 * A && (!best || Math.abs(net) > best.size)) best = { dir: net > 0 ? 1 : -1, size: Math.abs(net), begin: b }
  }
  return best
}

function breakInfo(c: Candle[], upper: CpLine, lower: CpLine, from: number, A: number): { dir: 0 | 1 | -1; age: number } {
  const n = c.length
  for (let i = n - 1; i >= Math.max(from, n - 1 - MAX_BREAK_AGE); i--) {
    if (c[i].close > at(upper, i) + 0.1 * A) return { dir: 1, age: n - 1 - i }
    if (c[i].close < at(lower, i) - 0.1 * A) return { dir: -1, age: n - 1 - i }
  }
  return { dir: 0, age: 0 }
}

function boundaryPatterns(c: Candle[], A: number): CpHit[] {
  const n = c.length
  const { highs, lows } = pivots(c)
  const out: CpHit[] = []
  let best: { score: number; hit: CpHit } | null = null
  for (let kh = 2; kh <= Math.min(4, highs.length); kh++) {
    for (let kl = 2; kl <= Math.min(4, lows.length); kl++) {
      const H = highs.slice(-kh), L = lows.slice(-kl)
      const fu = fit(H), fl = fit(L)
      if (fu.resid > 0.35 * A || fl.resid > 0.35 * A) continue
      const s0 = Math.min(H[0].i, L[0].i)
      const span = n - 1 - s0
      if (span < 8 || span > 130) continue
      // the latest pivot of each side must be recent enough that the pattern is still live
      if (n - 1 - Math.max(H[H.length - 1].i, L[L.length - 1].i) > 25) continue
      const wStart = at(fu.line, s0) - at(fl.line, s0), wNow = at(fu.line, n - 1) - at(fl.line, n - 1)
      if (wStart <= 0 || wNow < 0.2 * A) continue
      const du = (fu.line.slope * span) / A, dl = (fl.line.slope * span) / A
      const converging = wNow < 0.8 * wStart
      const flatU = Math.abs(du) <= 0.8, flatL = Math.abs(dl) <= 0.8
      let name = '', dir: CpDir = 'neutral', note = ''
      const pl = pole(c, s0, A)
      const small = span >= 5 && span <= 30
      if (pl && small && converging && du < 0 && dl > 0 && wStart <= 0.5 * pl.size) { name = pl.dir === 1 ? 'Bullish Pennant' : 'Bearish Pennant'; dir = pl.dir === 1 ? 'bullish' : 'bearish'; note = `pole ${(pl.size / A).toFixed(1)} ATR then a small converging triangle` }
      else if (pl && small && Math.abs(du - dl) <= 0.6 && wStart <= 0.6 * pl.size && ((pl.dir === 1 && du < 0 && dl < 0) || (pl.dir === -1 && du > 0 && dl > 0))) { name = pl.dir === 1 ? 'Bull Flag' : 'Bear Flag'; dir = pl.dir === 1 ? 'bullish' : 'bearish'; note = `pole ${(pl.size / A).toFixed(1)} ATR then a parallel counter-channel` }
      else if (flatU && dl >= 1.0 && converging) { name = 'Ascending Triangle'; dir = 'bullish'; note = 'flat resistance with rising lows' }
      else if (flatL && du <= -1.0 && converging) { name = 'Descending Triangle'; dir = 'bearish'; note = 'flat support with falling highs' }
      else if (du < 0 && dl < 0 && du < dl && converging && du <= -0.8) { name = 'Falling Wedge'; dir = 'bullish'; note = 'both lines falling, upper faster - sellers tiring' }
      else if (du > 0 && dl > 0 && dl > du && converging && dl >= 0.8) { name = 'Rising Wedge'; dir = 'bearish'; note = 'both lines rising, lower faster - buyers tiring' }
      else if (du <= -0.8 && dl >= 0.8 && converging) { name = 'Symmetrical Triangle'; dir = 'neutral'; note = 'falling highs, rising lows - await the break' }
      else if (flatU && flatL && wNow >= 1.5 * A && wNow >= 0.7 * wStart) {
        const pre = s0 - 25 >= 0 ? c[s0].close - c[s0 - 25].close : 0
        name = pre >= 1.5 * A ? 'Bullish Rectangle' : pre <= -1.5 * A ? 'Bearish Rectangle' : 'Rectangle'
        dir = pre >= 1.5 * A ? 'bullish' : pre <= -1.5 * A ? 'bearish' : 'neutral'
        note = 'flat top and bottom'
      }
      if (!name) continue
      const bk = breakInfo(c, fu.line, fl.line, s0, A)
      let direction = dir, reliability: 1 | 2 | 3 = dir === 'neutral' ? 1 : 2, barsAgo = 0, broken = false
      let target: number | undefined
      if (bk.dir !== 0) {
        broken = true; barsAgo = bk.age; direction = bk.dir === 1 ? 'bullish' : 'bearish'
        reliability = dir !== 'neutral' && ((dir === 'bullish') === (bk.dir === 1)) ? 3 : 2
        const base = bk.dir === 1 ? at(fu.line, n - 1 - bk.age) : at(fl.line, n - 1 - bk.age)
        const h = name.includes('Pennant') || name.includes('Flag') ? (pl?.size ?? wStart) : wStart
        target = base + bk.dir * h
      } else if (direction !== 'neutral') {
        const h = name.includes('Pennant') || name.includes('Flag') ? (pl?.size ?? wStart) : wStart
        target = direction === 'bullish' ? at(fu.line, n - 1) + h : at(fl.line, n - 1) - h
      }
      const hit: CpHit = { name, direction, reliability, barsAgo, note: broken ? `${note} - broke ${direction === 'bullish' ? 'up' : 'down'}` : note, broken, upper: at(fu.line, n - 1), lower: at(fl.line, n - 1), target }
      const score = (kh + kl) * 10 + (broken ? 5 : 0) - Math.abs(span - 40) / 10 - (fu.resid + fl.resid) / A
      if (!best || score > best.score) best = { score, hit }
    }
  }
  if (best) out.push(best.hit)
  return out
}

function invert(c: Candle[]): Candle[] {
  return c.map((k) => ({ ...k, open: -k.open, close: -k.close, high: -k.low, low: -k.high }))
}

/** Head and shoulders TOP on `c` (bearish). Run on invert(c) for the inverse. Prices passed in are in the frame being analysed. */
function headShoulders(c: Candle[], A: number): { barsAgo: number; broken: boolean; neckNow: number; head: number; neckAtHead: number; shoulderBars: number } | null {
  const n = c.length
  const { highs, lows } = pivots(c)
  for (let k = highs.length - 1; k >= 2; k--) {
    const RS = highs[k], HD = highs[k - 1], LS = highs[k - 2]
    if (n - 1 - RS.i > 30) break
    if (!(HD.p > LS.p + 0.5 * A && HD.p > RS.p + 0.5 * A)) continue
    const t1 = lows.filter((q) => q.i > LS.i && q.i < HD.i).sort((a, b) => a.p - b.p)[0]
    const t2 = lows.filter((q) => q.i > HD.i && q.i < RS.i).sort((a, b) => a.p - b.p)[0]
    if (!t1 || !t2) continue
    const neckMid = (t1.p + t2.p) / 2
    const headH = HD.p - neckMid
    if (headH < 1.5 * A) continue
    if (Math.abs(LS.p - RS.p) > 0.35 * headH) continue
    if (Math.abs(t1.p - t2.p) > 0.5 * headH) continue
    const d1 = HD.i - LS.i, d2 = RS.i - HD.i
    if (d1 / d2 < 0.4 || d1 / d2 > 2.5) continue
    const slope = (t2.p - t1.p) / (t2.i - t1.i)
    const neck = (i: number) => t1.p + slope * (i - t1.i)
    let broken = false, barsAgo = 0
    for (let i = n - 1; i > RS.i && i >= n - 1 - MAX_BREAK_AGE; i--) if (c[i].close < neck(i) - 0.1 * A) { broken = true; barsAgo = n - 1 - i }
    if (!broken && c[n - 1].close < neck(n - 1) - 0.1 * A) continue
    return { barsAgo, broken, neckNow: neck(n - 1), head: HD.p, neckAtHead: neck(HD.i), shoulderBars: d1 }
  }
  return null
}

/** Cup and handle (bullish) on `c`; run on invert(c) for the inverted/bearish one. */
function cupHandle(c: Candle[], A: number): { barsAgo: number; broken: boolean; rim: number; depth: number } | null {
  const n = c.length
  for (const W of [40, 60, 90, 130]) {
    if (n < W + 5) continue
    const s = n - W
    // left rim: highest high in the first third of the window
    let li = s
    for (let i = s; i < s + Math.floor(W / 3); i++) if (c[i].high > c[li].high) li = i
    // bottom: lowest low after the left rim, before the last 12 bars
    let bi = li + 1
    for (let i = li + 1; i < n - 5; i++) if (c[i].low < c[bi].low) bi = i
    // right rim: highest high after the bottom
    let ri = bi + 1
    for (let i = bi + 1; i < n; i++) if (c[i].high >= c[ri].high) ri = i
    const rim = c[li].high, depth = rim - c[bi].low
    if (depth < 3 * A) continue
    if (Math.abs(c[ri].high - rim) > 0.15 * depth) continue
    const cupLen = ri - li
    if (cupLen < 15) continue
    const pos = (bi - li) / cupLen
    if (pos < 0.3 || pos > 0.7) continue
    // roundedness: quadratic fit of closes between the rims
    const xs: number[] = [], ys: number[] = []
    for (let i = li; i <= ri; i++) { xs.push(i); ys.push(c[i].close) }
    const m = xs.length
    let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0
    const x0 = xs[0]
    for (let k = 0; k < m; k++) { const x = xs[k] - x0, y = ys[k]; sx += x; sx2 += x * x; sx3 += x ** 3; sx4 += x ** 4; sy += y; sxy += x * y; sx2y += x * x * y }
    // solve 3x3 normal equations for y = a + b x + c x^2
    const M = [[m, sx, sx2], [sx, sx2, sx3], [sx2, sx3, sx4]], V = [sy, sxy, sx2y]
    const det = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
    const D = det(M)
    if (Math.abs(D) < 1e-12) continue
    const rep = (col: number) => M.map((row, r) => row.map((v, cc) => (cc === col ? V[r] : v)))
    const a0 = det(rep(0)) / D, a1 = det(rep(1)) / D, a2 = det(rep(2)) / D
    if (a2 <= 0) continue // must open upward (a U)
    const meanY = sy / m
    let ssr = 0, sst = 0
    for (let k = 0; k < m; k++) { const x = xs[k] - x0, pred = a0 + a1 * x + a2 * x * x; ssr += (ys[k] - pred) ** 2; sst += (ys[k] - meanY) ** 2 }
    if (sst <= 0 || 1 - ssr / sst < 0.6) continue
    // handle: after the right rim, a shallow pullback of 3-25 bars
    const handleLen = n - 1 - ri
    if (handleLen > 25) continue
    let hl = Infinity
    for (let i = ri; i < n; i++) hl = Math.min(hl, c[i].low)
    const give = c[ri].high - hl
    if (give > 0.5 * depth) continue
    if (handleLen > 0 && handleLen < 3 && give < 0.05 * depth) continue
    let broken = false, barsAgo = 0
    for (let i = n - 1; i > ri && i >= n - 1 - MAX_BREAK_AGE; i--) if (c[i].close > c[ri].high + 0.1 * A) { broken = true; barsAgo = n - 1 - i }
    if (!broken && handleLen < 3) continue // no handle yet = just a cup, not the pattern
    return { barsAgo, broken, rim: Math.max(rim, c[ri].high), depth }
  }
  return null
}

export function detectChartPatterns2(candles: Candle[]): CpHit[] {
  const p = prep(candles)
  if (!p) return []
  const { c, A } = p
  const out: CpHit[] = [...boundaryPatterns(c, A)]
  const hs = headShoulders(c, A)
  if (hs) out.push({ name: 'Head and Shoulders', direction: 'bearish', reliability: hs.broken ? 3 : 2, barsAgo: hs.barsAgo, broken: hs.broken, note: hs.broken ? 'neckline broken down' : 'right shoulder in, price still above the neckline', lower: hs.neckNow, target: hs.neckNow - (hs.head - hs.neckAtHead) })
  const ci = invert(c)
  const ihs = headShoulders(ci, A)
  if (ihs) out.push({ name: 'Inverse Head and Shoulders', direction: 'bullish', reliability: ihs.broken ? 3 : 2, barsAgo: ihs.barsAgo, broken: ihs.broken, note: ihs.broken ? 'neckline broken up' : 'right shoulder in, price still below the neckline', upper: -ihs.neckNow, target: -(ihs.neckNow - (ihs.head - ihs.neckAtHead)) })
  const cup = cupHandle(c, A)
  if (cup) out.push({ name: 'Cup and Handle', direction: 'bullish', reliability: cup.broken ? 3 : 2, barsAgo: cup.barsAgo, broken: cup.broken, note: cup.broken ? 'broke above the rim' : 'rounded base, handle forming under the rim', upper: cup.rim, target: cup.rim + cup.depth })
  const icup = cupHandle(ci, A)
  if (icup) out.push({ name: 'Inverted Cup and Handle', direction: 'bearish', reliability: icup.broken ? 3 : 2, barsAgo: icup.barsAgo, broken: icup.broken, note: icup.broken ? 'broke below the rim' : 'rounded top, handle forming above the rim', lower: -icup.rim, target: -(icup.rim + icup.depth) })
  return out
}

// ------------------------------------------------------------------ auto trend
export interface AutoTrend {
  ok: boolean
  dir: 1 | -1 | 0
  slope: number // ATR per bar (regression of the last 50 closes)
  r2: number
  strength: number // 0..100
  touches: number
  line: number // the trendline's value at the latest bar (0 = none)
  broken: number // +1 closed back above a down-trend line, -1 closed below an up-trend line (within the last 8 bars), 0 none
  brokenAge: number
}
const NO_TREND: AutoTrend = { ok: false, dir: 0, slope: 0, r2: 0, strength: 0, touches: 0, line: 0, broken: 0, brokenAge: 0 }
export function readAutoTrend(candles: Candle[]): AutoTrend {
  const p = prep(candles)
  if (!p) return NO_TREND
  const { c, A } = p
  const n = c.length, m = Math.min(50, n)
  const y = c.slice(-m).map((k) => k.close)
  const mx = (m - 1) / 2, my = y.reduce((a, b) => a + b, 0) / m
  let sxx = 0, sxy = 0, syy = 0
  for (let i = 0; i < m; i++) { sxx += (i - mx) ** 2; sxy += (i - mx) * (y[i] - my); syy += (y[i] - my) ** 2 }
  const slope = sxy / sxx
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0
  const slopeAtr = slope / A
  const dir: 1 | -1 | 0 = Math.abs(slopeAtr * m) >= 1.5 && r2 >= 0.4 ? (slope > 0 ? 1 : -1) : 0
  if (dir === 0) return { ...NO_TREND, ok: true, slope: slopeAtr, r2 }
  const { highs, lows } = pivots(c)
  const base = n - m
  const pv = (dir === 1 ? lows : highs).filter((q) => q.i >= base)
  let line = 0, touches = 0, broken = 0, brokenAge = 0
  if (pv.length >= 2) {
    // pick the best pair of the last 5 pivots: most touches within 0.35 ATR, no close beyond it by 0.3 ATR
    const cand = pv.slice(-5)
    let bestT = 0
    for (let a = 0; a < cand.length - 1; a++) for (let b = a + 1; b < cand.length; b++) {
      const sl = (cand[b].p - cand[a].p) / (cand[b].i - cand[a].i)
      if (dir === 1 ? sl <= 0 : sl >= 0) continue
      const val = (i: number) => cand[a].p + sl * (i - cand[a].i)
      let ok = true
      for (let i = cand[a].i; i < n; i++) if (dir === 1 ? c[i].close < val(i) - 0.3 * A : c[i].close > val(i) + 0.3 * A) { ok = false; break }
      if (!ok) continue
      const t = cand.filter((q) => q.i >= cand[a].i && Math.abs(q.p - val(q.i)) <= 0.35 * A).length
      if (t > bestT) { bestT = t; line = val(n - 1); touches = t }
    }
    // a break of the best line that WAS valid until recently: re-test allowing the last 8 bars to violate
    if (!line) {
      const cand2 = pv.slice(-5)
      for (let a = 0; a < cand2.length - 1; a++) for (let b = a + 1; b < cand2.length; b++) {
        const sl = (cand2[b].p - cand2[a].p) / (cand2[b].i - cand2[a].i)
        if (dir === 1 ? sl <= 0 : sl >= 0) continue
        const val = (i: number) => cand2[a].p + sl * (i - cand2[a].i)
        let ok = true
        for (let i = cand2[a].i; i < n - 1 - MAX_BREAK_AGE; i++) if (dir === 1 ? c[i].close < val(i) - 0.3 * A : c[i].close > val(i) + 0.3 * A) { ok = false; break }
        if (!ok) continue
        const t = cand2.filter((q) => q.i >= cand2[a].i && Math.abs(q.p - val(q.i)) <= 0.35 * A).length
        if (t < 2) continue
        for (let i = n - 1; i >= n - 1 - MAX_BREAK_AGE; i--) {
          if (dir === 1 ? c[i].close < val(i) - 0.3 * A : c[i].close > val(i) + 0.3 * A) { broken = dir === 1 ? -1 : 1; brokenAge = n - 1 - i; line = val(n - 1); touches = t }
        }
      }
    }
  }
  const strength = Math.round(Math.min(100, 100 * r2 * Math.min(1, Math.abs(slopeAtr * m) / 6) + touches * 4))
  return { ok: true, dir, slope: slopeAtr, r2, strength, touches, line, broken, brokenAge }
}

// ------------------------------------------------------------------ Elliott
export type EwState = 'none' | 'wave3' | 'wave5' | 'wave5done' | 'abcdone'
export interface EwRead {
  ok: boolean
  state: EwState
  /** direction of the IMPULSE that is being counted (+1 up) */
  trend: 1 | -1 | 0
  /** direction expected next from here (the wave 3/5 continuation, or the correction after wave 5, or the resumption after ABC) */
  dir: 1 | -1 | 0
  wave: number // 3 | 5 | 0
  retrace: number // wave 2 (for wave3) or wave 4 (for wave5) retracement of the previous impulse leg
  target: number // Fibonacci projection (wave 3: 1.618 x W1 from the wave-2 end; wave 5: W1 length from the wave-4 end; wave5done / abcdone: 0.618 of the whole move back); 0 none
  invalid: number // the level that invalidates the count (wave 3: the wave 1 start; wave 5: the wave 1 end); 0 none
  conf: number // 1..3
  note: string
}
const NO_EW: EwRead = { ok: false, state: 'none', trend: 0, dir: 0, wave: 0, retrace: 0, target: 0, invalid: 0, conf: 0, note: '' }
function zigzag(c: Candle[], th: number): { i: number; p: number; hi: boolean }[] {
  const pts: { i: number; p: number; hi: boolean }[] = []
  let dir = 0
  let h = { p: c[0].high, i: 0 }, l = { p: c[0].low, i: 0 }
  for (let i = 1; i < c.length; i++) {
    if (dir === 0) {
      if (c[i].high > h.p) h = { p: c[i].high, i }
      if (c[i].low < l.p) l = { p: c[i].low, i }
      if (h.p - l.p >= th) { if (l.i < h.i) { pts.push({ ...l, hi: false }); dir = 1 } else { pts.push({ ...h, hi: true }); dir = -1 } }
    } else if (dir === 1) {
      if (c[i].high > h.p) h = { p: c[i].high, i }
      else if (h.p - c[i].low >= th) { pts.push({ ...h, hi: true }); dir = -1; l = { p: c[i].low, i } }
    } else {
      if (c[i].low < l.p) l = { p: c[i].low, i }
      else if (c[i].high - l.p >= th) { pts.push({ ...l, hi: false }); dir = 1; h = { p: c[i].high, i } }
    }
  }
  if (dir === 1) pts.push({ ...h, hi: true })
  else if (dir === -1) pts.push({ ...l, hi: false })
  return pts
}
/** Count on the frame where the impulse goes UP (call with the series, then with invert(series) for the down count). */
function ewUp(c: Candle[], A: number): EwRead | null {
  const pts = zigzag(c, 1.5 * A)
  const n = pts.length
  const last = c[c.length - 1].close
  const P = (k: number) => pts[n - 1 - k] // P(0) = the developing extreme
  // five waves: a0 (low) a1 a2 a3 a4 a5 (high). off = 0: a5 is the developing high; off = 1: price already turned and flipped the zig-zag (P(0) is the low after a5)
  for (const off of [0, 1]) {
    if (n < 6 + off) continue
    const [a0, a1, a2, a3, a4, a5] = [P(5 + off), P(4 + off), P(3 + off), P(2 + off), P(1 + off), P(off)]
    if (a0.hi || !a5.hi) continue
    if (off === 1 && !(P(0).p < a5.p)) continue
    const w1 = a1.p - a0.p, w3 = a3.p - a2.p, w5 = a5.p - a4.p
    if (!(a2.p > a0.p && a3.p > a1.p && a4.p > a1.p && w1 > 0 && w3 > 0 && w5 > 0 && a1.p - a2.p >= 0.236 * w1)) continue
    const retr4 = (a3.p - a4.p) / w3
    if (a5.p >= a3.p - 0.1 * A) {
      if (w3 < Math.min(w1, w5)) continue // wave 3 may not be the shortest
      const turned = off === 1 || a5.p - last >= 0.5 * A
      if (turned) return { ok: true, state: 'wave5done', trend: 1, dir: -1, wave: 5, retrace: retr4, target: a5.p - 0.618 * (a5.p - a0.p), invalid: a5.p, conf: 1, note: 'five waves up complete and price has turned - a correction is the mechanical expectation' }
      return { ok: true, state: 'wave5', trend: 1, dir: 1, wave: 5, retrace: retr4, target: a4.p + w1, invalid: a1.p, conf: 1, note: 'wave 5 extending' }
    }
    if (off === 0 && w3 >= 0.9 * w1 && a5.p > a4.p) return { ok: true, state: 'wave5', trend: 1, dir: 1, wave: 5, retrace: retr4, target: a4.p + w1, invalid: a1.p, conf: 1, note: 'wave 4 held above the wave 1 end - wave 5 up under way' }
  }
  // wave 5 about to start: a0 low, a1 high, a2 low, a3 high, a4 low (developing) bounced off by at least 0.3 ATR
  if (n >= 5 && !P(0).hi && P(1).hi && !P(2).hi && P(3).hi && !P(4).hi) {
    const [a0, a1, a2, a3, a4] = [P(4), P(3), P(2), P(1), P(0)]
    const w1 = a1.p - a0.p, w3 = a3.p - a2.p
    if (a2.p > a0.p && a3.p > a1.p && a4.p > a1.p && w3 >= 0.9 * w1 && w1 > 0 && a1.p - a2.p >= 0.236 * w1 && last - a4.p >= 0.3 * A) {
      return { ok: true, state: 'wave5', trend: 1, dir: 1, wave: 5, retrace: (a3.p - a4.p) / w3, target: a4.p + w1, invalid: a1.p, conf: 1, note: 'wave 4 held above the wave 1 end - wave 5 up expected' }
    }
  }
  // wave 3 in progress: a0 low, a1 high, a2 low confirmed, price (developing high) beyond a1
  if (n >= 4 && P(0).hi && !P(1).hi && P(2).hi && !P(3).hi) {
    const [a0, a1, a2] = [P(3), P(2), P(1)]
    const w1 = a1.p - a0.p
    const retr = (a1.p - a2.p) / w1
    if (w1 >= 1.5 * A && a2.p > a0.p && retr >= 0.382 && retr <= 0.886 && P(0).p > a1.p) {
      return { ok: true, state: 'wave3', trend: 1, dir: 1, wave: 3, retrace: retr, target: a2.p + 1.618 * w1, invalid: a0.p, conf: retr >= 0.5 && retr <= 0.786 ? 2 : 1, note: `wave 2 retraced ${(retr * 100).toFixed(0)}% and price is through the wave 1 high - wave 3 up` }
    }
  }
  return null
}
/** zig-zag A-B-C DOWN complete and turning (bullish resumption setup): h0 high, aL low (A), bH high (B), cL low (C). off = 1: the turn already flipped the zig-zag. */
function abcDown(c: Candle[], A: number): EwRead | null {
  const pts = zigzag(c, 1.5 * A)
  const n = pts.length
  const last = c[c.length - 1].close
  for (const off of [0, 1]) {
    if (n < 4 + off) continue
    const P = (k: number) => pts[n - 1 - k]
    const [h0, aL, bH, cL] = [P(3 + off), P(2 + off), P(1 + off), P(off)]
    if (!(h0.hi && !aL.hi && bH.hi && !cL.hi)) continue
    if (off === 1 && !(P(0).hi && P(0).p > cL.p)) continue
    const a = h0.p - aL.p, b = bH.p - aL.p, cc = bH.p - cL.p
    if (a < 1.5 * A) continue
    const bRet = b / a
    if (bRet < 0.382 || bRet > 1.0) continue
    if (cL.p >= aL.p || cc < 0.618 * a) continue
    if (last - cL.p < 0.5 * A) continue
    return { ok: true, state: 'abcdone', trend: -1, dir: 1, wave: 0, retrace: bRet, target: cL.p + 0.618 * (bH.p - cL.p), invalid: cL.p, conf: 1, note: 'A-B-C down complete and price is turning up' }
  }
  return null
}
export function readElliott(candles: Candle[]): EwRead {
  const p = prep(candles)
  if (!p) return NO_EW
  const { c, A } = p
  const up = ewUp(c, A)
  const ci = invert(c)
  const dn = ewUp(ci, A)
  const neg = (r: EwRead): EwRead => ({ ...r, trend: (-r.trend) as 1 | -1 | 0, dir: (-r.dir) as 1 | -1 | 0, target: r.target ? -r.target : 0, invalid: r.invalid ? -r.invalid : 0 })
  const cands: EwRead[] = []
  if (up) cands.push(up)
  if (dn) cands.push(neg(dn))
  const abcD = abcDown(c, A)
  if (abcD) cands.push(abcD)
  const abcU = abcDown(ci, A)
  if (abcU) cands.push(neg(abcU))
  if (!cands.length) return { ...NO_EW, ok: true }
  const rank = (r: EwRead) => (r.state === 'wave3' ? 4 : r.state === 'wave5' ? 3 : r.state === 'wave5done' ? 2 : 1) * 10 + r.conf
  return cands.sort((x, y) => rank(y) - rank(x))[0]
}

/** every hit above as a PatternHit-shaped row, for detectPatterns() and the candle-pattern surfaces */
export function patternEngineHits(candles: Candle[]): CpHit[] {
  const out = detectChartPatterns2(candles)
  const at_ = readAutoTrend(candles)
  if (at_.ok && at_.dir !== 0 && at_.r2 >= 0.5 && at_.touches >= 3 && at_.broken === 0) out.push({ name: at_.dir === 1 ? 'Auto Trend Up' : 'Auto Trend Down', direction: at_.dir === 1 ? 'bullish' : 'bearish', reliability: 1, barsAgo: 0, note: `regression slope ${at_.slope.toFixed(2)} ATR/bar, R2 ${at_.r2.toFixed(2)}, ${at_.touches} line touches`, broken: false, lower: at_.dir === 1 ? at_.line : undefined, upper: at_.dir === -1 ? at_.line : undefined })
  if (at_.ok && at_.broken !== 0) out.push({ name: at_.broken === 1 ? 'Down Trendline Break' : 'Up Trendline Break', direction: at_.broken === 1 ? 'bullish' : 'bearish', reliability: 2, barsAgo: at_.brokenAge, note: `${at_.touches}-touch trendline broken`, broken: true })
  const ew = readElliott(candles)
  if (ew.ok && ew.state !== 'none') {
    const nm = ew.state === 'wave3' ? (ew.trend === 1 ? 'Elliott Wave 3 Up' : 'Elliott Wave 3 Down')
      : ew.state === 'wave5' ? (ew.trend === 1 ? 'Elliott Wave 5 Up' : 'Elliott Wave 5 Down')
        : ew.state === 'wave5done' ? (ew.trend === 1 ? 'Elliott Five Waves Up Done' : 'Elliott Five Waves Down Done')
          : ew.trend === -1 ? 'Elliott ABC Bottom' : 'Elliott ABC Top'
    out.push({ name: nm, direction: ew.dir === 1 ? 'bullish' : 'bearish', reliability: ew.conf >= 2 ? 2 : 1, barsAgo: 0, note: ew.note, broken: false, target: ew.target || undefined })
  }
  return out
}

/** Names this engine can emit (kept next to the detectors; mirrored into patterns.ts's CANDLE_PATTERN_NAMES and the client mirror) */
export const CHART_PATTERN_NAMES: string[] = [
  'Ascending Triangle', 'Descending Triangle', 'Symmetrical Triangle', 'Falling Wedge', 'Rising Wedge', 'Rectangle', 'Bullish Rectangle', 'Bearish Rectangle',
  'Bullish Pennant', 'Bearish Pennant', 'Bull Flag', 'Bear Flag', 'Head and Shoulders', 'Inverse Head and Shoulders', 'Cup and Handle', 'Inverted Cup and Handle',
  'Auto Trend Up', 'Auto Trend Down', 'Up Trendline Break', 'Down Trendline Break',
  'Elliott Wave 3 Up', 'Elliott Wave 3 Down', 'Elliott Wave 5 Up', 'Elliott Wave 5 Down', 'Elliott Five Waves Up Done', 'Elliott Five Waves Down Done', 'Elliott ABC Bottom', 'Elliott ABC Top',
]
