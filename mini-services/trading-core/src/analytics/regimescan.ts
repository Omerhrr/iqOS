// IQAIR//OS - Regime scan: which pairs are trending (up / down), ranging, or
// just noise, right now, on one timeframe.
//
// Pure function over CLOSED candles. Every read is DESCRIPTIVE - it says what
// the last WINDOW bars looked like, not what the next bar will do, and a
// regime can flip the very next candle.
//
//   trending  - efficiency ratio (net move / path travelled) is high, the
//               OLS slope of closes is statistically distinct from zero,
//               ADX confirms a directional market and +DI/-DI point the same
//               way as the net move. Direction = sign of the net move.
//   ranging   - going nowhere (low efficiency, ADX below the trend zone) but
//               not shapeless: price crossed its own window mean several
//               times AND tagged both the top and bottom of the window's
//               range at least twice each - a two-sided, tested box.
//   noise     - everything else: no direction and no box (erratic, flip-flop
//               bars, one-off excursions). It is what is left, not a signal.
//
// Scores (0-100) only RANK pairs inside their own bucket; they are not
// probabilities. The null test in tests/regimescan.test.ts pins how often a
// pure random walk lands in each bucket, so "trending" cannot silently become
// a label that random data earns half the time.

import type { Candle } from '../types'
import { adx as adxSeries } from './indicators'

export type RegimeKind = 'trend-up' | 'trend-down' | 'ranging' | 'noise'

export const REGIME_WINDOW = 40
export const MIN_BARS = REGIME_WINDOW + 20

export const TREND_ER_MIN = 0.4
export const TREND_T_MIN = 4
export const TREND_ADX_MIN = 22
export const RANGE_ER_MAX = 0.3
export const RANGE_ADX_MAX = 30
export const RANGE_MIN_CROSSINGS = 4
export const RANGE_MIN_TOUCHES = 2
const ZONE = 0.2

export interface RegimeRow {
  regime: RegimeKind
  /** 0-100, ranks pairs within the same regime only - not a probability. */
  score: number
  /** efficiency ratio over the window: 0 = pure back-and-forth, 1 = straight line */
  er: number
  adx: number
  plusDI: number
  minusDI: number
  /** t-statistic of the OLS slope of closes over the window */
  tStat: number
  r2: number
  /** window high-low as % of the last close */
  rangePct: number
  /** window high-low in ATR(14) units */
  rangeAtr: number
  /** times closes crossed the window mean */
  crossings: number
  touchesTop: number
  touchesBottom: number
  /** 0 = at the window low, 1 = at the window high */
  position: number
  /** share of bars that reversed the previous bar's direction */
  flipRate: number
  price: number
  windowHigh: number
  windowLow: number
  reason: string
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

function lastFinite(a: number[]): number {
  for (let i = a.length - 1; i >= 0; i--) if (Number.isFinite(a[i])) return a[i]
  return NaN
}

export function classifyRegimeRow(candles: Candle[]): RegimeRow | null {
  if (candles.length < MIN_BARS) return null
  const closes = candles.map((c) => c.close)
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const n = closes.length
  const price = closes[n - 1]
  if (!(price > 0) || closes.some((v) => !Number.isFinite(v))) return null

  const W = REGIME_WINDOW
  const w = closes.slice(n - W)
  const wHigh = Math.max(...highs.slice(n - W))
  const wLow = Math.min(...lows.slice(n - W))
  const range = wHigh - wLow

  // efficiency ratio
  let path = 0
  for (let i = 1; i < W; i++) path += Math.abs(w[i] - w[i - 1])
  const net = w[W - 1] - w[0]
  const er = path > 0 ? Math.abs(net) / path : 0

  // OLS slope t-stat + R^2
  const xm = (W - 1) / 2
  const ym = w.reduce((a, b) => a + b, 0) / W
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = 0; i < W; i++) {
    sxx += (i - xm) * (i - xm)
    sxy += (i - xm) * (w[i] - ym)
    syy += (w[i] - ym) * (w[i] - ym)
  }
  const slope = sxx > 0 ? sxy / sxx : 0
  let sse = 0
  for (let i = 0; i < W; i++) {
    const e = w[i] - (ym + slope * (i - xm))
    sse += e * e
  }
  const se = sxx > 0 && W > 2 ? Math.sqrt(sse / (W - 2) / sxx) : 0
  const tStat = se > 0 ? slope / se : slope === 0 ? 0 : slope > 0 ? 99 : -99
  const r2 = syy > 0 ? clamp01(1 - sse / syy) : 0

  // ATR(14), simple mean of true range
  let trSum = 0
  const trN = 14
  for (let i = n - trN; i < n; i++) {
    trSum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]))
  }
  const atr = trSum / trN
  const rangeAtr = atr > 0 ? range / atr : 0

  // ADX
  const a = adxSeries(highs, lows, closes, 14)
  const adxV = lastFinite(a.adx)
  const pdi = lastFinite(a.plusDI)
  const mdi = lastFinite(a.minusDI)

  // box structure: mean crossings + boundary touches (entries into each zone)
  let crossings = 0
  for (let i = 1; i < W; i++) if ((w[i - 1] - ym) * (w[i] - ym) < 0) crossings++
  const topEdge = wHigh - ZONE * range
  const botEdge = wLow + ZONE * range
  let touchesTop = 0
  let touchesBottom = 0
  let inTop = false
  let inBot = false
  const hw = highs.slice(n - W)
  const lw = lows.slice(n - W)
  for (let i = 0; i < W; i++) {
    const t = range > 0 && hw[i] >= topEdge
    const b = range > 0 && lw[i] <= botEdge
    if (t && !inTop) touchesTop++
    if (b && !inBot) touchesBottom++
    inTop = t
    inBot = b
  }

  // flip rate
  let flips = 0
  for (let i = 2; i < W; i++) if ((w[i] - w[i - 1]) * (w[i - 1] - w[i - 2]) < 0) flips++
  const flipRate = flips / Math.max(1, W - 2)

  const position = range > 0 ? clamp01((price - wLow) / range) : 0.5
  const adxN = Number.isFinite(adxV) ? adxV : 0
  const pdiN = Number.isFinite(pdi) ? pdi : 0
  const mdiN = Number.isFinite(mdi) ? mdi : 0
  const up = net > 0
  const diAgrees = up ? pdiN > mdiN : mdiN > pdiN

  let regime: RegimeKind = 'noise'
  let score = 0
  let reason = ''
  if (er >= TREND_ER_MIN && Math.abs(tStat) >= TREND_T_MIN && adxN >= TREND_ADX_MIN && diAgrees) {
    regime = up ? 'trend-up' : 'trend-down'
    score = Math.round(100 * (0.4 * clamp01(er / 0.6) + 0.3 * clamp01(adxN / 40) + 0.3 * r2))
    reason = `efficiency ${(er * 100).toFixed(0)}%, ADX ${adxN.toFixed(0)} with ${up ? '+DI over -DI' : '-DI over +DI'}, slope t=${tStat.toFixed(1)}, R² ${(r2 * 100).toFixed(0)}%.`
  } else if (er <= RANGE_ER_MAX && adxN < RANGE_ADX_MAX && crossings >= RANGE_MIN_CROSSINGS && touchesTop >= RANGE_MIN_TOUCHES && touchesBottom >= RANGE_MIN_TOUCHES) {
    regime = 'ranging'
    score = Math.round(100 * (0.4 * clamp01(crossings / 10) + 0.3 * clamp01(rangeAtr / 8) + 0.3 * clamp01(1 - er / RANGE_ER_MAX)))
    reason = `crossed its mean ${crossings}x, tagged the top ${touchesTop}x and bottom ${touchesBottom}x, efficiency ${(er * 100).toFixed(0)}%, ADX ${adxN.toFixed(0)}.`
  } else {
    regime = 'noise'
    score = Math.round(100 * (0.5 * clamp01(1 - er / 0.3) + 0.5 * clamp01(flipRate / 0.6)))
    const why: string[] = []
    if (er >= TREND_ER_MIN) why.push(`some direction (efficiency ${(er * 100).toFixed(0)}%) but ${adxN < TREND_ADX_MIN ? `ADX only ${adxN.toFixed(0)}` : !diAgrees ? 'DI disagrees' : `slope t=${tStat.toFixed(1)} too weak`}`)
    else why.push(`no direction (efficiency ${(er * 100).toFixed(0)}%)`)
    if (touchesTop < RANGE_MIN_TOUCHES || touchesBottom < RANGE_MIN_TOUCHES) why.push('no tested two-sided box')
    else if (crossings < RANGE_MIN_CROSSINGS) why.push(`only ${crossings} mean crossings`)
    else if (adxN >= RANGE_ADX_MAX) why.push(`ADX ${adxN.toFixed(0)} too high for a range`)
    why.push(`${(flipRate * 100).toFixed(0)}% of bars reversed the one before`)
    reason = why.join('; ') + '.'
  }

  return {
    regime, score, er, adx: adxN, plusDI: pdiN, minusDI: mdiN, tStat, r2,
    rangePct: (range / price) * 100, rangeAtr, crossings, touchesTop, touchesBottom, position, flipRate,
    price, windowHigh: wHigh, windowLow: wLow, reason,
  }
}
