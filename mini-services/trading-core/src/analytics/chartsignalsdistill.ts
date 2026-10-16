// IQAIR//OS - Chart Signals Distill
// The combined chart-engine vote (renko/P&F/range/tick/footprint/Heikin-Ashi/
// candlestick families - see chartsignals.ts's engineVotes/combineVotes) is a
// committee: on any given bar one or two families can flip in or out of
// agreement even when the underlying read hasn't really changed, so the raw
// combined score is noisier bar-to-bar than the thing it's trying to measure.
// This module "distills" it: builds a short rolling series of the raw signed
// vote score (one per bar), fits an Ornstein-Uhlenbeck process to THAT SERIES
// ITSELF (reusing analytics/kalman.ts's generic, series-agnostic ouEstimate -
// it already treats its input as "a numeric series", not specifically price),
// then runs one scalar Kalman forward pass over it. The result is the same
// "filtered fair-value estimate" idea kalman.ts's ouSeries/ouKalman compute
// for price, except applied to the vote score - a decluttered, persistence-
// weighted read of what the chart engines are collectively saying, instead of
// the single latest (possibly noisy) bar's raw tally.
//
// This is NOT mean-reversion on price, and NOT the OU-vs-price model
// kalman-ou-reversion/kalman-ou-scalp trade - theta/z here describe the vote
// SERIES's own short-run equilibrium, purely as the Kalman filter's input for
// smoothing. Whether the distilled read fires a trade is a plain threshold on
// the filtered value's magnitude (see the chartsignals-distill strategy in
// strategies/builtin.ts), not a reversion bet.
//
// Cost note: building the raw series means running engineVotes() once per
// bar in the window (each one itself scans back through the candle history
// for its own engines) - `window` is capped to keep a single evaluate() call
// bounded, but it is still `window`x the cost of a single chartsignals-vote
// read. Callers evaluating this on every backtest bar should expect it to be
// the slowest strategy in the registry.

import type { Candle } from '../types'
import { engineVotes, combineVotes } from './chartsignals'
import { ouEstimate } from './kalman'

/** Default bars of raw vote-score history fed into the OU fit + Kalman pass. */
export const DISTILL_DEFAULT_WINDOW = 20
/** Hard cap - each extra bar costs one more full engineVotes() scan. */
export const DISTILL_MAX_WINDOW = 40
/** Floor - below this few raw-score samples the OU fit is too thin to trust. */
export const DISTILL_MIN_WINDOW = 12
/** Kalman observation-noise multiplier (same convention as kalman.ts's
 * ouSeries/ouKalman obsNoise param): how much to trust each new raw bar vs
 * the OU-predicted carry-forward. Lower = smoother/slower, higher = snappier. */
const DEFAULT_OBS_NOISE = 0.5

export interface ChartSignalsDistillResult {
  /** Kalman-filtered (decluttered) combined vote score, signed -100..100. */
  filtered: number
  /** OU equilibrium of the vote-SCORE series itself (not price). */
  theta: number
  /** (filtered - theta) / sigmaEq of the score series. */
  z: number
  /** AR(1) fit significance of the score series' own OU fit (diagnostic only -
   * this module does not gate on it; a strategy built on this can). */
  tStat: number
  sigmaEq: number
  /** The single most-recent bar's raw (undistilled) combined vote score, for
   * comparison against `filtered` - how much the distillation actually moved it. */
  rawScore: number
  /** How many raw score samples actually fed the fit (<= window). */
  n: number
}

/** Signed combined chart-signals vote score for one point in history: +score
 * for a qualifying CALL read, -score for PUT, 0 when no family agreement
 * clears the vote engine's own threshold/minAgree gate. `candles` should
 * already be sliced to end at the bar being scored (no look-ahead). */
function voteScoreAt(
  candles: Candle[],
  opts: { threshold: number; minAgree: number; otc: boolean; realTicks: Parameters<typeof engineVotes>[1]['realTicks'] }
): number {
  if (candles.length < 40) return 0
  const votes = engineVotes(candles, { otc: opts.otc, realTicks: opts.realTicks })
  const combined = combineVotes(votes, { threshold: opts.threshold, minAgree: opts.minAgree })
  if (!combined) return 0
  return combined.direction === 'call' ? combined.score : -combined.score
}

export function distillChartSignals(
  candles: Candle[],
  opts: {
    window?: number
    threshold?: number
    minAgree?: number
    otc?: boolean
    realTicks?: Parameters<typeof engineVotes>[1]['realTicks']
    obsNoise?: number
  } = {}
): ChartSignalsDistillResult | null {
  const window = Math.max(DISTILL_MIN_WINDOW, Math.min(DISTILL_MAX_WINDOW, Math.round(opts.window ?? DISTILL_DEFAULT_WINDOW)))
  const threshold = opts.threshold ?? 35
  const minAgree = opts.minAgree ?? 2
  const otc = !!opts.otc
  const realTicks = opts.realTicks ?? null
  const obsNoise = opts.obsNoise ?? DEFAULT_OBS_NOISE
  const n = candles.length
  // Need 40 bars of warmup for the FIRST scored bar in the window, plus the
  // window itself.
  if (n < 40 + window) return null

  const series: number[] = []
  for (let back = window - 1; back >= 0; back--) {
    const endIdx = n - 1 - back
    series.push(voteScoreAt(candles.slice(0, endIdx + 1), { threshold, minAgree, otc, realTicks }))
  }

  // OU fit directly on the raw score series - ouEstimate is generic over any
  // number[] (it just calls its argument "closesArr" out of convention).
  const est = ouEstimate(series, Math.max(10, window - 2))

  // Single forward Kalman pass over the series (same recursion as kalman.ts's
  // ouSeries/ouKalman, run once here instead of as a rolling per-bar array,
  // and over the score series instead of price).
  const Q = Math.max(est.sigmaEps * est.sigmaEps, 1e-9)
  let xh = series[0]
  let P = Math.max(est.sigmaEq * est.sigmaEq, 1e-9)
  for (let i = 1; i < series.length; i++) {
    // predict: pull the latent level toward the fitted OU equilibrium
    xh = est.theta + est.phi * (xh - est.theta)
    P = est.phi * est.phi * P + Q
    // update with the observed raw score
    const R = Math.max(obsNoise * Q, 1e-9)
    const innov = series[i] - xh
    const S = P + R
    const K = P / S
    xh += K * innov
    P *= 1 - K
  }

  const sigmaEq = est.sigmaEq > 1e-9 ? est.sigmaEq : 1
  const z = (xh - est.theta) / sigmaEq
  return {
    filtered: xh,
    theta: est.theta,
    z,
    tStat: est.tStat,
    sigmaEq: est.sigmaEq,
    rawScore: series[series.length - 1],
    n: series.length,
  }
}
