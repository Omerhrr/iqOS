// IQAIR//OS - pullback detector (MSL `pb.*`). Candle-derived, so it works on any timeframe and replays in the backtester.
//
// A zig-zag of the chart's HIGHS and LOWS (reversal = 1.5 ATR14) gives swing points. With the last three points W -> Y -> X:
//   W->Y is the PREVIOUS leg (the impulse, direction d), Y->X is the LATEST leg (X is the developing extreme).
//   If the latest leg is SMALLER than the impulse (and at least 8% of it) and runs against it, it is a PULLBACK of depth |X-Y| / |Y-W| (0 = none, 1 = all of the impulse given back).
//   If it is as big or bigger than the impulse the old trend is over / it is a new impulse: state = impulse, no pullback.
// Kinds (all independent, any number can be true at once - "any kind"):
//   shallow  depth < 0.382 (strong trends: flags, tight pauses)      normal  0.382..0.618     deep  0.618..0.786     failed  > 0.786 (the trend is probably broken)
//   ema      the pullback extreme came within 0.3 ATR of the EMA20 or EMA50 (dynamic-support pullback)
//   fib      depth lies in 0.382..0.786 (the classic retracement band)
//   retest   the extreme returned to within 0.4 ATR of the swing level the impulse broke (broken resistance -> support, or the mirror)
//   flag     the pullback bars are quiet: their average range is under 70% of the impulse bars'
// resumed = the latest closed bar closed in the trend direction, beyond the previous bar's extreme, with a body in that direction. ready = pullback + resumed + not failed.
// HONEST: this DESCRIBES a pullback; whether buying it pays is what a backtest has to show.
import type { Candle } from '../types'
import { atr, ema } from './indicators'

export const PB_MIN_BARS = 60
const REV = 1.5

export interface PullbackRead {
  ok: boolean
  state: 'pullback' | 'impulse' | 'none'
  side: number // +1 = pullback inside an UP-trend (a dip to buy), -1 = a rally inside a DOWN-trend
  depth: number
  legAtr: number
  bars: number
  counter: number
  kind: 'shallow' | 'normal' | 'deep' | 'failed' | 'none'
  ema: boolean
  fib: boolean
  retest: boolean
  flag: boolean
  resumed: boolean
  ready: boolean
  aligned: boolean
  types: number
}
const NONE: PullbackRead = { ok: false, state: 'none', side: 0, depth: 0, legAtr: 0, bars: 0, counter: 0, kind: 'none', ema: false, fib: false, retest: false, flag: false, resumed: false, ready: false, aligned: false, types: 0 }

export function readPullback(candles: Candle[]): PullbackRead {
  if (candles.length < PB_MIN_BARS) return NONE
  const full = candles.slice(-400)
  const zig = (c: Candle[]): { pts: { p: number; i: number; hi: boolean }[]; A: number; c: Candle[] } => {
    const hi = c.map((x) => x.high), lo = c.map((x) => x.low), cl = c.map((x) => x.close)
    const a14 = atr(hi, lo, cl, 14)
    const A = a14[a14.length - 1]
    const pts: { p: number; i: number; hi: boolean }[] = []
    if (!Number.isFinite(A) || A <= 0) return { pts, A: NaN, c }
    const th = REV * A
    let dir = 0
    let h = { p: hi[0], i: 0 }, l = { p: lo[0], i: 0 }
    for (let i = 1; i < c.length; i++) {
      if (dir === 0) {
        if (hi[i] > h.p) h = { p: hi[i], i }
        if (lo[i] < l.p) l = { p: lo[i], i }
        if (h.p - l.p >= th) { if (l.i < h.i) { pts.push({ ...l, hi: false }); dir = 1 } else { pts.push({ ...h, hi: true }); dir = -1 } }
      } else if (dir === 1) {
        if (hi[i] > h.p) h = { p: hi[i], i }
        else if (h.p - lo[i] >= th) { pts.push({ ...h, hi: true }); dir = -1; l = { p: lo[i], i } }
      } else {
        if (lo[i] < l.p) l = { p: lo[i], i }
        else if (hi[i] - l.p >= th) { pts.push({ ...l, hi: false }); dir = 1; h = { p: hi[i], i } }
      }
    }
    if (dir === 1) pts.push({ ...h, hi: true })
    else if (dir === -1) pts.push({ ...l, hi: false })
    return { pts, A, c }
  }
  // Structure includes the latest bar - unless that bar FLIPPED the zig-zag (a big resumption bar would otherwise turn the pullback into a "new leg"); then it is read up to the previous bar.
  let z = zig(full)
  const zPrev = zig(full.slice(0, -1))
  if (z.pts.length && zPrev.pts.length && z.pts[z.pts.length - 1].hi !== zPrev.pts[zPrev.pts.length - 1].hi) z = zPrev
  const c = z.c, A = z.A, pts = z.pts
  if (!Number.isFinite(A) || A <= 0) return NONE
  const hi = c.map((x) => x.high), lo = c.map((x) => x.low), cl = c.map((x) => x.close)
  const last = c.length - 1
  if (pts.length < 3) return { ...NONE, ok: true }
  const X = pts[pts.length - 1], Y = pts[pts.length - 2], W = pts[pts.length - 3]
  const impulse = Math.abs(Y.p - W.p)
  const latest = Math.abs(X.p - Y.p)
  const d = Y.p > W.p ? 1 : -1
  const base: PullbackRead = { ...NONE, ok: true, side: d, legAtr: impulse / A }
  if (latest >= impulse) return { ...base, state: 'impulse' }
  const depth = latest / impulse
  if (depth < 0.08) return { ...base, state: 'impulse', depth }
  // pullback bars = Y.i+1 .. last
  const from = Y.i + 1
  let counter = 0
  for (let i = from; i <= last; i++) if (d === 1 ? cl[i] < c[i].open : cl[i] > c[i].open) counter++
  const e20 = ema(cl, 20), e50 = ema(cl, 50)
  const ext = X.p
  const near = (v: number) => Math.abs(ext - v) <= 0.3 * A || (d === 1 ? lo[X.i] <= v + 0.3 * A && lo[X.i] >= v - 1.5 * A : hi[X.i] >= v - 0.3 * A && hi[X.i] <= v + 1.5 * A)
  const emaHit = near(e20[X.i]) || near(e50[X.i])
  const kind: PullbackRead['kind'] = depth > 0.786 ? 'failed' : depth > 0.618 ? 'deep' : depth >= 0.382 ? 'normal' : 'shallow'
  const fib = depth >= 0.382 && depth <= 0.786
  // the level the impulse broke: the swing before W on the far side (pts[-4]) when Y went beyond it
  let retest = false
  const Z = pts.length >= 4 ? pts[pts.length - 4] : null
  if (Z && Z.hi === (d === 1) && (d === 1 ? Y.p > Z.p : Y.p < Z.p)) retest = Math.abs(ext - Z.p) <= 0.4 * A
  let impR = 0, impN = 0, pbR = 0, pbN = 0
  for (let i = W.i + 1; i <= Y.i; i++) { impR += hi[i] - lo[i]; impN++ }
  for (let i = from; i <= last; i++) { pbR += hi[i] - lo[i]; pbN++ }
  const flag = impN > 0 && pbN >= 2 && pbR / pbN < 0.7 * (impR / impN)
  const b = full[full.length - 1], pb = full[full.length - 2]
  const resumed = d === 1 ? b.close > b.open && b.close > pb.high : b.close < b.open && b.close < pb.low
  const aligned = d === 1 ? e20[last] > e50[last] : e20[last] < e50[last]
  const types = (emaHit ? 1 : 0) + (fib ? 1 : 0) + (retest ? 1 : 0) + (flag ? 1 : 0)
  return { ok: true, state: 'pullback', side: d, depth, legAtr: impulse / A, bars: full.length - 1 - Y.i, counter, kind, ema: emaHit, fib, retest, flag, resumed, ready: resumed && kind !== 'failed', aligned, types }
}
