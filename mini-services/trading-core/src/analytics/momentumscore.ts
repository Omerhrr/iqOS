// IQAIR//OS - Multi-timeframe "Market Momentum Score" secondary candle read
//
// A THIRD, deliberately simple next-candle shape read for the panel, per
// the user's own formula:
//
//   Market Momentum Score = (W1 * T_15m) + (W2 * T_5m) + (W3 * T_1m) + (W4 * T_30s)
//
// Same spirit as hmarocbullbear.ts's secondary read (see that module's own
// header): a plain, transparent, untracked read shown ALONGSIDE the
// Oracle's calibrated fusion for visual comparison, not fused through its
// log-odds/correlation-discount/honesty-loop machinery and not one of its
// weighted drivers.
//
// T_<tf> is pure "candle math" (the user's own phrasing) - no borrowed
// indicator, unlike the HMA/ROC/Bull-Bear read: the average body direction
// (close-open)/(high-low), i.e. where in its own range each candle closed,
// over the last LOOKBACK closed candles on that timeframe. +1 = every
// recent candle closed at its high (as bullish as a candle can read), -1 =
// every one closed at its low.
//
// WEIGHTS: the user's formula names W1-W4 but not their values. Default
// weights below follow the standard multi-timeframe-cascade convention -
// the SLOWER timeframe gets the HEAVIER weight (it's the trend filter; the
// faster timeframes are the noisier confirmation/timing layer):
//   W1 (15m) = 0.40, W2 (5m) = 0.30, W3 (1m) = 0.20, W4 (30s) = 0.10
// They sum to 1 so the fused score stays on the same -1..1 scale as each
// T_<tf> term. Pass `weights` to override if a different scheme was meant.
import type { Candle } from '../types'

const LOOKBACK = 5
const DEFAULT_WEIGHTS = { w15m: 0.4, w5m: 0.3, w1m: 0.2, w30s: 0.1 }

export interface MomentumScoreWeights {
  w15m: number
  w5m: number
  w1m: number
  w30s: number
}

export interface MomentumScorePrediction {
  direction: 'call' | 'put' | 'none'
  /** the fused Market Momentum Score, -1..1 */
  score: number
  /** 0..100 - |score| scaled, same convention as the other secondary read */
  strength: number
  weights: MomentumScoreWeights
  /** each timeframe's own T_<tf> term, -1..1, before weighting */
  components: { t15m: number; t5m: number; t1m: number; t30s: number }
  bodyRatio: number
  closePos: number
  expectedCandleType: string
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo
}

/** Pure candle math: average body-direction-within-range over the last
 * LOOKBACK closed candles. Returns NaN if there isn't enough history. */
function candleMathTerm(candles: Candle[]): number {
  if (candles.length < LOOKBACK) return NaN
  const recent = candles.slice(-LOOKBACK)
  let sum = 0
  for (const c of recent) {
    const range = c.high - c.low
    sum += range > 0 ? (c.close - c.open) / range : 0
  }
  return clamp(sum / recent.length, -1, 1)
}

/** Same plain-language shape classifier hmarocbullbear.ts uses, duplicated
 * rather than imported from analytics/nextcandle.ts on purpose - same
 * dependency-isolation reasoning as that module (see its own header). */
function classifyShape(bodyRatio: number, closePos: number, direction: 'call' | 'put' | 'none'): string {
  if (direction === 'none') {
    return bodyRatio < 0.3 ? 'doji / indecision candle (no clear lean)' : 'choppy candle, no clear lean despite some body'
  }
  const bullish = direction === 'call'
  const extremeClose = bullish ? closePos >= 0.75 : closePos <= 0.25
  if (bodyRatio < 0.25) return `small-bodied ${bullish ? 'bullish' : 'bearish'} candle, long wicks`
  if (bodyRatio >= 0.65 && extremeClose) return `strong marubozu-like ${bullish ? 'bullish' : 'bearish'} candle`
  if (bodyRatio >= 0.65) return `wide-bodied ${bullish ? 'bullish' : 'bearish'} candle with some wick`
  return `moderate-bodied ${bullish ? 'bullish' : 'bearish'} candle with balanced wicks`
}

/** Pure read over four ALREADY-FETCHED timeframe candle series for the
 * same instrument (the plugin pulls these independently of whatever
 * timeframe the chart/Oracle itself is running on - this is a genuine
 * multi-timeframe read, not a resample of one series). Returns null when
 * any one of the four doesn't have enough history yet. */
export function predictMomentumScore(
  byTf: { t15m: Candle[]; t5m: Candle[]; t1m: Candle[]; t30s: Candle[] },
  weights: MomentumScoreWeights = DEFAULT_WEIGHTS
): MomentumScorePrediction | null {
  const t15m = candleMathTerm(byTf.t15m)
  const t5m = candleMathTerm(byTf.t5m)
  const t1m = candleMathTerm(byTf.t1m)
  const t30s = candleMathTerm(byTf.t30s)
  if (![t15m, t5m, t1m, t30s].every(Number.isFinite)) return null

  const score = clamp(weights.w15m * t15m + weights.w5m * t5m + weights.w1m * t1m + weights.w30s * t30s, -1, 1)
  const deadband = 0.08 // same spirit as the Oracle's own direction deadband
  const direction: 'call' | 'put' | 'none' = score >= deadband ? 'call' : score <= -deadband ? 'put' : 'none'
  const strength = Math.round(clamp(Math.abs(score), 0, 1) * 100)

  const bodyRatio = clamp(0.2 + Math.abs(score) * 0.7, 0.05, 0.95)
  const closePos = clamp(0.5 + (direction === 'none' ? 0 : score) * 0.45, 0.05, 0.95)

  return {
    direction,
    score: Math.round(score * 1000) / 1000,
    strength,
    weights,
    components: {
      t15m: Math.round(t15m * 1000) / 1000,
      t5m: Math.round(t5m * 1000) / 1000,
      t1m: Math.round(t1m * 1000) / 1000,
      t30s: Math.round(t30s * 1000) / 1000,
    },
    bodyRatio,
    closePos,
    expectedCandleType: classifyShape(bodyRatio, closePos, direction),
  }
}
