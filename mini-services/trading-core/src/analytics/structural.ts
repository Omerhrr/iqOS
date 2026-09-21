// IQAIR//OS - Structural chart tools
// ─────────────────────────────────────────────────────────────────────────────
// The drawing-tool family the registry was missing, as pure per-bar series so
// they render like any other overlay (stepped/horizontal segments included):
//
//   [ Pivot Points ]     session (UTC day) floor pivots - classic, fibonacci,
//                        camarilla and woodie variants; rolling-window fallback
//                        when the feed does not span two sessions (OTC crops).
//   [ Auto Fibonacci ]   retracement 0..1 + 1.272/1.618 extensions of the last
//                        significant swing inside the lookback, direction-aware,
//                        re-anchoring only when a new extreme forms.
//   [ Auto Trendlines ]  fractal-pivot support/resistance lines: least-squares
//                        fit through the most recent confirmed swing highs/lows,
//                        projected to the current bar (non-repainting: a pivot
//                        only counts once its right flank has confirmed).
//   [ Fair Value Gaps ]  3-bar imbalance zones (ICT-style): the newest unfilled
//                        bull/bear gap tracked until price closes through it.
//
// Everything is pure: candles in -> { lines-ready arrays, state strings } out.
// No I/O, no clock, no globals.
// ─────────────────────────────────────────────────────────────────────────────

import type { Candle } from '../types'

const finite = (v: number): boolean => Number.isFinite(v)
const nanArr = (n: number): number[] => new Array<number>(n).fill(NaN)

// ─────────────────────────────────────────────────────────────────────────────
// Pivot Points
// ─────────────────────────────────────────────────────────────────────────────

export interface PivotSeriesParams {
  variant: number // 0 classic | 1 fibonacci | 2 camarilla | 3 woodie
  period: number // rolling fallback window (bars)
}

export interface PivotSeries {
  pp: number[]
  r1: number[]
  r2: number[]
  r3: number[]
  s1: number[]
  s2: number[]
  s3: number[]
  mode: 'session' | 'rolling'
  state: string[]
}

const VARIANT_NAMES = ['classic', 'fibonacci', 'camarilla', 'woodie'] as const

/** One UTC-day aggregate of the feed. */
interface DayAgg {
  day: number
  h: number
  l: number
  c: number
}

function dayAggregates(candles: Candle[]): Map<number, DayAgg> {
  const map = new Map<number, DayAgg>()
  for (const c of candles) {
    const t = Number.isFinite(c.time) && c.time > 0 ? c.time : NaN
    if (!Number.isFinite(t)) return map // feed without usable timestamps
    const day = Math.floor(t / 86400)
    const agg = map.get(day)
    if (!agg) map.set(day, { day, h: c.high, l: c.low, c: c.close })
    else {
      agg.h = Math.max(agg.h, c.high)
      agg.l = Math.min(agg.l, c.low)
      agg.c = c.close
    }
  }
  return map
}

/** Core level math from a prior-session H/L/C anchor. */
function levelsFrom(variant: number, h: number, l: number, c: number): { pp: number; r: [number, number, number]; s: [number, number, number] } {
  const range = Math.max(h - l, 1e-12)
  if (variant === 3) {
    // woodie - close-weighted pivot
    const pp = (h + l + 2 * c) / 4
    return { pp, r: [2 * pp - l, pp + range, h + 2 * (pp - l)], s: [2 * pp - h, pp - range, l - 2 * (h - pp)] }
  }
  if (variant === 2) {
    // camarilla - close + fractional ranges (R1..R3 band)
    const pp = (h + l + c) / 3
    const k = 1.1 * range
    return { pp, r: [c + k / 12, c + k / 6, c + k / 4], s: [c - k / 12, c - k / 6, c - k / 4] }
  }
  if (variant === 1) {
    // fibonacci pivots - PP +/- fib ratios of the range
    const pp = (h + l + c) / 3
    return { pp, r: [pp + 0.382 * range, pp + 0.618 * range, pp + range], s: [pp - 0.382 * range, pp - 0.618 * range, pp - range] }
  }
  // classic floor pivots
  const pp = (h + l + c) / 3
  return { pp, r: [2 * pp - l, pp + range, h + 2 * (pp - l)], s: [2 * pp - h, pp - range, l - 2 * (h - pp)] }
}

/**
 * Session pivot points (previous UTC day H/L/C -> today's levels), stepped
 * per bar. Falls back to a rolling `period`-bar window when the feed does not
 * span at least two UTC days (typical for short OTC crops) - then levels
 * recompute per bar instead of stepping at midnight.
 */
export function computePivotSeries(candles: Candle[], params?: Partial<PivotSeriesParams>): PivotSeries {
  const n = candles.length
  const variant = Math.max(0, Math.min(3, Math.round(params?.variant ?? 0)))
  const period = Math.max(10, Math.round(params?.period ?? 60))
  const out: PivotSeries = {
    pp: nanArr(n), r1: nanArr(n), r2: nanArr(n), r3: nanArr(n),
    s1: nanArr(n), s2: nanArr(n), s3: nanArr(n),
    mode: 'session',
    state: new Array<string>(n).fill(''),
  }
  if (n < 5) return out

  const aggs = dayAggregates(candles)
  const sessionMode = aggs.size >= 2 && Number.isFinite(candles[0].time) && candles[0].time > 0
  out.mode = sessionMode ? 'session' : 'rolling'

  if (sessionMode) {
    const days = [...aggs.keys()].sort((a, b) => a - b)
    const prevOf = new Map<number, DayAgg>()
    for (let k = 1; k < days.length; k++) prevOf.set(days[k], aggs.get(days[k - 1])!)
    for (let i = 0; i < n; i++) {
      const t = candles[i].time
      const day = Math.floor(t / 86400)
      const prev = prevOf.get(day)
      if (!prev) continue // first session in the feed has no anchor yet
      const { pp, r, s } = levelsFrom(variant, prev.h, prev.l, prev.c)
      out.pp[i] = pp
      out.r1[i] = r[0]; out.r2[i] = r[1]; out.r3[i] = r[2]
      out.s1[i] = s[0]; out.s2[i] = s[1]; out.s3[i] = s[2]
      const px = candles[i].close
      const pos = px > r[2] ? 'above R3' : px > r[0] ? `R1-R3` : px > pp ? 'R1-PP' : px > s[0] ? 'PP-S1' : px > s[2] ? 'S1-S3' : 'below S3'
      out.state[i] = `${VARIANT_NAMES[variant]} ${pos}`
    }
    return out
  }

  // rolling fallback: prior `period` bars (excluding current) anchor the levels
  for (let i = period; i < n; i++) {
    let h = -Infinity
    let l = Infinity
    for (let k = i - period; k < i; k++) {
      h = Math.max(h, candles[k].high)
      l = Math.min(l, candles[k].low)
    }
    const { pp, r, s } = levelsFrom(variant, h, l, candles[i - 1].close)
    out.pp[i] = pp
    out.r1[i] = r[0]; out.r2[i] = r[1]; out.r3[i] = r[2]
    out.s1[i] = s[0]; out.s2[i] = s[1]; out.s3[i] = s[2]
    const px = candles[i].close
    const pos = px > r[2] ? 'above R3' : px > r[0] ? `R1-R3` : px > pp ? 'R1-PP' : px > s[0] ? 'PP-S1' : px > s[2] ? 'S1-S3' : 'below S3'
    out.state[i] = `rolling ${VARIANT_NAMES[variant]} ${pos}`
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto Fibonacci (retracement + extension)
// ─────────────────────────────────────────────────────────────────────────────

export interface FibSeriesParams {
  lookback: number // swing search window (bars)
  withExt: number // 1 = draw 1.272 / 1.618 extension lines
}

export interface FibSeries {
  fib0: number[] // swing extreme (0%)
  fib236: number[]
  fib382: number[]
  fib50: number[]
  fib618: number[] // golden pocket lower bound
  fib786: number[]
  fib100: number[] // opposite swing extreme (100%)
  ext1272: number[]
  ext1618: number[]
  state: string[]
}

/**
 * Direction-aware auto fib: per bar, locate the swing high and swing low of
 * the trailing `lookback` window; whichever formed LATER defines the leg.
 * Uptrend leg (low -> high): retracements hang from the high; extensions
 * project above it. Downtrend mirrored. Levels jump only when a new extreme
 * replaces the swing, exactly how a manual drawing behaves.
 */
export function computeFibSeries(candles: Candle[], params?: Partial<FibSeriesParams>): FibSeries {
  const n = candles.length
  const lookback = Math.max(20, Math.round(params?.lookback ?? 150))
  const withExt = (params?.withExt ?? 1) !== 0
  const out: FibSeries = {
    fib0: nanArr(n), fib236: nanArr(n), fib382: nanArr(n), fib50: nanArr(n),
    fib618: nanArr(n), fib786: nanArr(n), fib100: nanArr(n), ext1272: nanArr(n), ext1618: nanArr(n),
    state: new Array<string>(n).fill(''),
  }
  if (n < lookback * 0.5) return out
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - lookback + 1)
    if (i - lo + 1 < 20) continue
    let hiIdx = lo
    let loIdx = lo
    for (let k = lo; k <= i; k++) {
      if (candles[k].high >= candles[hiIdx].high) hiIdx = k
      if (candles[k].low <= candles[loIdx].low) loIdx = k
    }
    const hi = candles[hiIdx].high
    const low = candles[loIdx].low
    const diff = Math.max(hi - low, 1e-12)
    const up = hiIdx > loIdx // low formed first, rallied to high -> uptrend leg
    const retr = (ratio: number): number => (up ? hi - diff * ratio : low + diff * ratio)
    out.fib0[i] = up ? hi : low
    out.fib236[i] = retr(0.236)
    out.fib382[i] = retr(0.382)
    out.fib50[i] = retr(0.5)
    out.fib618[i] = retr(0.618)
    out.fib786[i] = retr(0.786)
    out.fib100[i] = up ? low : hi
    if (withExt) {
      out.ext1272[i] = up ? hi + 0.272 * diff : low - 0.272 * diff
      out.ext1618[i] = up ? hi + 0.618 * diff : low - 0.618 * diff
    }
    const px = candles[i].close
    const zone = px > out.fib618[i] && px < out.fib382[i] ? 'GOLDEN POCKET' : px > out.fib236[i] ? '0-23.6' : px > out.fib382[i] ? '23.6-38.2' : px > out.fib50[i] ? '38.2-50' : px > out.fib618[i] ? '50-61.8' : px > out.fib786[i] ? '61.8-78.6' : 'deep'
    out.state[i] = `${up ? 'UP' : 'DOWN'} leg ${zone}`
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto Trendlines (fractal-pivot S/R)
// ─────────────────────────────────────────────────────────────────────────────

export interface TrendlineSeriesParams {
  pivotLeft: number // fractal flank bars
  pivotRight: number
  maxFit: number // pivots used in the least-squares fit (2..5)
}

export interface TrendlineSeries {
  resTrend: number[] // projected resistance trendline
  supTrend: number[] // projected support trendline
  resSlope: number[] // line slope per bar (NaN while unanchored)
  supSlope: number[]
  state: string[]
}

interface FractalPivot {
  confIdx: number // bar at which the pivot is CONFIRMED (no lookahead)
  idx: number
  price: number
}

function fractalPivots(candles: Candle[], left: number, right: number): { highs: FractalPivot[]; lows: FractalPivot[] } {
  const highs: FractalPivot[] = []
  const lows: FractalPivot[] = []
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true
    let isLow = true
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue
      if (candles[j].high >= candles[i].high) isHigh = false
      if (candles[j].low <= candles[i].low) isLow = false
    }
    if (isHigh) highs.push({ confIdx: i + right, idx: i, price: candles[i].high })
    if (isLow) lows.push({ confIdx: i + right, idx: i, price: candles[i].low })
  }
  return { highs, lows }
}

/** Least-squares line through up to `max` pivots -> value+slope at bar x. */
function fitLine(pivots: FractalPivot[], max: number, x: number): { value: number; slope: number } | null {
  const use = pivots.slice(-max)
  if (use.length < 2) return null
  let sx = 0
  let sy = 0
  let sxy = 0
  let sxx = 0
  for (const p of use) {
    sx += p.idx
    sy += p.price
    sxy += p.idx * p.price
    sxx += p.idx * p.idx
  }
  const m = use.length
  const den = m * sxx - sx * sx
  if (den === 0) {
    // vertically stacked pivots (flat line) - legal, slope 0
    const v = sy / m
    return { value: v, slope: 0 }
  }
  const slope = (m * sxy - sx * sy) / den
  const intercept = (sy - slope * sx) / m
  return { value: intercept + slope * x, slope }
}

/**
 * Auto support/resistance trendlines: fractal swing pivots confirmed by their
 * right flank (non-repainting), the most recent `maxFit` of each kind fitted
 * by least squares and projected to the current bar. The line re-anchors when
 * a new confirmed pivot replaces the fit - like a trader redrawing them.
 */
export function computeTrendlineSeries(candles: Candle[], params?: Partial<TrendlineSeriesParams>): TrendlineSeries {
  const n = candles.length
  const left = Math.max(2, Math.round(params?.pivotLeft ?? 5))
  const right = Math.max(2, Math.round(params?.pivotRight ?? 5))
  const maxFit = Math.max(2, Math.min(5, Math.round(params?.maxFit ?? 3)))
  const out: TrendlineSeries = {
    resTrend: nanArr(n), supTrend: nanArr(n), resSlope: nanArr(n), supSlope: nanArr(n),
    state: new Array<string>(n).fill(''),
  }
  if (n < left + right + 5) return out
  const { highs, lows } = fractalPivots(candles, left, right)
  let hi = 0
  let lo = 0
  for (let i = 0; i < n; i++) {
    while (hi < highs.length && highs[hi].confIdx <= i) hi++
    while (lo < lows.length && lows[lo].confIdx <= i) lo++
    const confirmedHighs = highs.slice(0, hi)
    const confirmedLows = lows.slice(0, lo)
    const res = fitLine(confirmedHighs, maxFit, i)
    const sup = fitLine(confirmedLows, maxFit, i)
    // anchored: draw each line only from its oldest fitted pivot onward
    const resAnchor = confirmedHighs.length >= 2 ? confirmedHighs[Math.max(0, confirmedHighs.length - maxFit)].idx : -1
    const supAnchor = confirmedLows.length >= 2 ? confirmedLows[Math.max(0, confirmedLows.length - maxFit)].idx : -1
    if (res && i >= resAnchor) {
      out.resTrend[i] = res.value
      out.resSlope[i] = res.slope
    }
    if (sup && i >= supAnchor) {
      out.supTrend[i] = sup.value
      out.supSlope[i] = sup.slope
    }
    const px = candles[i].close
    const bits: string[] = []
    if (res && sup) {
      if (px > res.value) bits.push('broke RES')
      else if (px < sup.value) bits.push('broke SUP')
      else bits.push('inside channel')
      bits.push(`res ${res.slope >= 0 ? 'asc' : 'desc'} · sup ${sup.slope >= 0 ? 'asc' : 'desc'}`)
    } else bits.push('warming up')
    out.state[i] = bits.join(' · ')
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Fair Value Gaps (3-bar imbalance)
// ─────────────────────────────────────────────────────────────────────────────

export interface FvgSeriesParams {
  maxAge: number // bars a gap stays tracked after detection
}

export interface FvgSeries {
  bullTop: number[] // newest unfilled bullish gap upper bound
  bullBot: number[]
  bearTop: number[] // newest unfilled bearish gap upper bound
  bearBot: number[]
  state: string[]
}

interface Gap {
  top: number
  bot: number
  born: number
}

/**
 * Three-candle imbalance: bull gap when low[i] > high[i-2] (zone = that void),
 * bear gap when high[i] < low[i-2]. A gap survives until a CLOSE trades
 * through its far edge (full fill), or maxAge bars pass. Per bar the newest
 * active bull and bear gaps are drawn as stepped lines.
 */
export function computeFvgSeries(candles: Candle[], params?: Partial<FvgSeriesParams>): FvgSeries {
  const n = candles.length
  const maxAge = Math.max(10, Math.round(params?.maxAge ?? 120))
  const out: FvgSeries = {
    bullTop: nanArr(n), bullBot: nanArr(n), bearTop: nanArr(n), bearBot: nanArr(n),
    state: new Array<string>(n).fill(''),
  }
  if (n < 5) return out
  const bulls: Gap[] = []
  const bears: Gap[] = []
  for (let i = 2; i < n; i++) {
    // detection
    if (candles[i].low > candles[i - 2].high) {
      bulls.unshift({ top: candles[i].low, bot: candles[i - 2].high, born: i })
      if (bulls.length > 4) bulls.pop()
    }
    if (candles[i].high < candles[i - 2].low) {
      bears.unshift({ top: candles[i - 2].low, bot: candles[i].high, born: i })
      if (bears.length > 4) bears.pop()
    }
    // fill checks (close through the FAR edge = fully traded)
    for (let k = bulls.length - 1; k >= 0; k--) {
      if (i - bulls[k].born > maxAge || candles[i].close < bulls[k].bot) bulls.splice(k, 1)
    }
    for (let k = bears.length - 1; k >= 0; k--) {
      if (i - bears[k].born > maxAge || candles[i].close > bears[k].top) bears.splice(k, 1)
    }
    // draw the newest active gap of each kind
    if (bulls.length) {
      out.bullTop[i] = bulls[0].top
      out.bullBot[i] = bulls[0].bot
    }
    if (bears.length) {
      out.bearTop[i] = bears[0].top
      out.bearBot[i] = bears[0].bot
    }
    const bits: string[] = []
    if (bulls.length) bits.push(`bull fvg ${bulls.length}`)
    if (bears.length) bits.push(`bear fvg ${bears.length}`)
    out.state[i] = bits.join(' · ') || 'no active gap'
  }
  return out
}
