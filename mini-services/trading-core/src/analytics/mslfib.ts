// IQAIR//OS - pure readers behind the MSL `fib.*` / `pivot.*` / `vol.*` namespaces.
//
// fib.*   Fibonacci retracement, extension, arcs and time zones of the SAME swing the Auto Fibonacci
//         chart overlay uses (structural.ts computeFibSeries: the trailing-window high/low, whichever
//         formed LATER defines the leg). The window ends on the last CLOSED bar, so nothing here looks
//         ahead; like the overlay, the grid re-anchors the moment a new extreme forms (no confirmation lag).
// pivot.* Floor pivots from structural.ts computePivotSeries (previous UTC day H/L/C when the series
//         carries real timestamps over 2+ days, else a rolling-window fallback).
// vol.*   ATR volatility state, self-normalised against the pair's OWN recent ATR history.
//
// Candle-derived only. Pure, no I/O.
import type { Candle } from '../types'
import { atr as atrArr } from './indicators'
import { computePivotSeries } from './structural'

export const FIB_MIN_BARS = 40
export const FIB_DEFAULT_LOOKBACK = 150
/** retracement ratios the "nearest level" helpers snap to (same set the overlay draws) */
export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
/** Fibonacci sequence for time zones (0 = the anchor bar itself) */
export const FIB_SEQ = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610]

const fin = (v: number, d = 0): number => (Number.isFinite(v) ? v : d)

export interface FibSwing {
  hi: number
  lo: number
  hiIdx: number
  loIdx: number
  /** low formed first, rallied to the high -> true (uptrend leg) */
  up: boolean
  diff: number
  /** index of the leg's END extreme (the one formed later) and START extreme */
  endIdx: number
  startIdx: number
  /** bars between the two extremes */
  legBars: number
  /** bars since the end extreme, measured to the last closed bar */
  age: number
  last: number
  lastIdx: number
  atr: number
}

export function fibSwing(candles: Candle[], lookback = FIB_DEFAULT_LOOKBACK): FibSwing | null {
  const n = candles.length
  if (n < FIB_MIN_BARS) return null
  const lb = Math.max(20, Math.min(600, Math.round(Number.isFinite(lookback) ? lookback : FIB_DEFAULT_LOOKBACK)))
  const i = n - 1
  const lo = Math.max(0, i - lb + 1)
  let hiIdx = lo
  let loIdx = lo
  for (let k = lo; k <= i; k++) {
    if (candles[k].high >= candles[hiIdx].high) hiIdx = k
    if (candles[k].low <= candles[loIdx].low) loIdx = k
  }
  const hi = candles[hiIdx].high
  const low = candles[loIdx].low
  const up = hiIdx > loIdx
  const endIdx = up ? hiIdx : loIdx
  const startIdx = up ? loIdx : hiIdx
  const a = atrArr(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), 14)
  return {
    hi,
    lo: low,
    hiIdx,
    loIdx,
    up,
    diff: Math.max(hi - low, 1e-12),
    endIdx,
    startIdx,
    legBars: Math.abs(hiIdx - loIdx),
    age: i - endIdx,
    last: candles[i].close,
    lastIdx: i,
    atr: fin(a[a.length - 1]),
  }
}

/** retracement price: ratio 0 = the leg's end extreme, 1 = its start, >1 = beyond the start */
export const fibRetr = (s: FibSwing, r: number): number => (s.up ? s.hi - s.diff * r : s.lo + s.diff * r)
/** extension price: ratio 1 = the end extreme, 1.272 / 1.618 project the leg beyond it (same rule as the overlay) */
export const fibExt = (s: FibSwing, e: number): number => (s.up ? s.hi + (e - 1) * s.diff : s.lo - (e - 1) * s.diff)
/** where price sits as a retracement ratio (0 at the end extreme, 1 at the start, >1 beyond, <0 beyond the end) */
export const fibPos = (s: FibSwing): number => (s.up ? (s.hi - s.last) / s.diff : (s.last - s.lo) / s.diff)

/** Fibonacci ARC at the last bar. Circles are centred on the leg's END extreme with radius ratio x leg length, in a
 * normalised plane where the x axis is bars and the y axis is price scaled so the whole leg is a 45-degree line
 * (k = legBars / diff). That makes the arc independent of chart zoom - a chart drawing uses screen scale instead, so a
 * drawn arc can differ. The arc is only defined while the last bar is within the radius (age <= R). */
export function fibArc(s: FibSwing, ratio: number): { price: number; live: boolean } {
  if (s.legBars < 3) return { price: NaN, live: false }
  const k = s.legBars / s.diff
  const L = Math.hypot(s.legBars, s.legBars)
  const R = ratio * L
  const dx = s.age
  if (!(R > dx)) return { price: NaN, live: false }
  const off = Math.sqrt(R * R - dx * dx) / k
  return { price: s.up ? s.hi - off : s.lo + off, live: true }
}

/** Fibonacci TIME ZONES: vertical lines at FIB_SEQ[j] x unit bars after the leg's START extreme. */
export function fibTimeZone(s: FibSwing, unit: number): { index: number; sinceStart: number; onZone: (tol: number) => boolean; toNext: number; mult: number } {
  const u = Math.max(1, Math.round(Number.isFinite(unit) ? unit : 1))
  const since = s.lastIdx - s.startIdx
  let j = 0
  while (j + 1 < FIB_SEQ.length && FIB_SEQ[j + 1] * u <= since) j++
  const next = j + 1 < FIB_SEQ.length ? FIB_SEQ[j + 1] * u - since : -1
  return {
    index: j,
    sinceStart: since,
    mult: FIB_SEQ[j],
    toNext: next,
    onZone: (tol: number) => FIB_SEQ.some((f) => Math.abs(f * u - since) <= tol),
  }
}

// ---------------------------------------------------------------- pivots
export interface PivotRead {
  pp: number
  r1: number
  r2: number
  r3: number
  s1: number
  s2: number
  s3: number
  mode: 'session' | 'rolling'
  variant: number
  atr: number
}

export function readPivots(candles: Candle[], variant = 0, period = 60): PivotRead | null {
  const n = candles.length
  if (n < 12) return null
  const v = Math.max(0, Math.min(3, Math.round(Number.isFinite(variant) ? variant : 0)))
  const per = Math.max(10, Math.min(500, Math.round(Number.isFinite(period) ? period : 60)))
  // without real timestamps force the rolling fallback (synthetic times would look like a single session)
  const ser = computePivotSeries(candles, { variant: v, period: per })
  const i = n - 1
  if (!Number.isFinite(ser.pp[i])) return null
  const a = atrArr(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), 14)
  return { pp: ser.pp[i], r1: ser.r1[i], r2: ser.r2[i], r3: ser.r3[i], s1: ser.s1[i], s2: ser.s2[i], s3: ser.s3[i], mode: ser.mode, variant: v, atr: fin(a[a.length - 1]) }
}

// ---------------------------------------------------------------- volatility
export interface VolRead {
  atr: number
  atrPct: number
  /** percentile rank (0..1) of the current ATR inside its own recent history */
  rank: number
  /** ATR(fast) / ATR(slow) */
  ratio: number
  samples: number
}

export const VOL_MIN_BARS = 60

export function readVol(candles: Candle[], period = 14, lookback = 200, fast = 5, slow = 30): VolRead | null {
  const n = candles.length
  if (n < VOL_MIN_BARS) return null
  const per = Math.max(2, Math.min(100, Math.round(period)))
  const lb = Math.max(30, Math.min(1000, Math.round(lookback)))
  const hi = candles.map((c) => c.high)
  const lo = candles.map((c) => c.low)
  const cl = candles.map((c) => c.close)
  const a = atrArr(hi, lo, cl, per)
  const cur = a[n - 1]
  if (!Number.isFinite(cur)) return null
  const hist: number[] = []
  for (let i = Math.max(0, n - lb); i < n; i++) if (Number.isFinite(a[i])) hist.push(a[i])
  if (hist.length < 30) return null
  let below = 0
  let equal = 0
  for (const v of hist) {
    if (v < cur) below++
    else if (v === cur) equal++
  }
  const rank = (below + 0.5 * equal) / hist.length
  const af = atrArr(hi, lo, cl, Math.max(2, Math.round(fast)))
  const as = atrArr(hi, lo, cl, Math.max(3, Math.round(slow)))
  const ratio = Number.isFinite(af[n - 1]) && Number.isFinite(as[n - 1]) && as[n - 1] > 1e-12 ? af[n - 1] / as[n - 1] : 1
  return { atr: cur, atrPct: cl[n - 1] > 0 ? (cur / cl[n - 1]) * 100 : 0, rank, ratio, samples: hist.length }
}
