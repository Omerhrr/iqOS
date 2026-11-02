// IQAIR//OS - HMA/ROC/Bull-Bear secondary candle read
// A second, DELIBERATELY SIMPLE next-candle shape read for the panel to show
// next to the Oracle's own fused prediction - three classic, independent
// technical reads (Hull MA slope, Rate of Change momentum, Elder Ray
// Bull/Bear Power), averaged, not fused through the Oracle's log-odds/
// correlation-discount/honesty-loop machinery and NOT one of its weighted
// drivers. This is intentionally a plain, transparent "what would three
// textbook indicators alone say" read for visual comparison on the panel,
// not a claim that it beats or replaces the Oracle - it carries none of the
// Oracle's calibration and is not tracked by the honesty loop (unlike every
// other prediction in this codebase, see plugins/nextcandle.ts's module
// header) because the point here is to show the reader the OBVIOUS/naive
// technical read next to the honestly-calibrated one, not to fuse them.
//
// Hull MA: near-zero-lag weighted MA (analytics/indicators.ts's hma()) -
// its SLOPE (current vs N bars back, normalized by price) is the trend
// read: up-sloping HMA = bullish lean.
// ROC: plain rate-of-change momentum (indicators.ts's roc()) over the same
// window - positive = bullish momentum, negative = bearish.
// Bull/Bear Power (Elder Ray, Alexander Elder): bullPower = high - EMA13,
// bearPower = low - EMA13. Net power (bullPower + bearPower) above zero
// means buyers are winning the tug-of-war against the 13-bar trend, below
// zero means sellers are; normalized by ATR so it reads on the same -1..1
// scale as the other two.

import type { Candle } from '../types'
import { closes, highs, lows, hma, roc, ema, trueRange } from './indicators'

const HMA_PERIOD = 16
const HMA_SLOPE_LOOKBACK = 3
const ROC_PERIOD = 12
const BULLBEAR_EMA_PERIOD = 13
const ATR_PERIOD = 14
const MIN_CANDLES = Math.max(HMA_PERIOD * 2, ROC_PERIOD + HMA_SLOPE_LOOKBACK + 5, BULLBEAR_EMA_PERIOD + 5, ATR_PERIOD + 5)

export interface HmaRocBullBearPrediction {
  direction: 'call' | 'put' | 'none'
  /** combined -1..1 score, simple average of the three normalized reads */
  score: number
  /** 0..100 - |score| scaled, NOT the Oracle's agreement+distance
   * confidence and not calibration-discounted (see module header: this
   * read isn't tracked by the honesty loop at all). */
  strength: number
  hmaSlope: number
  rocValue: number
  bullPower: number
  bearPower: number
  /** expected body vs range ratio 0..1, same geometry convention as the
   * Oracle's own bodyRatio - derived from |score| here, not learned. */
  bodyRatio: number
  /** expected close position within the range 0..1 - derived from score's
   * sign+magnitude, same convention as the Oracle's own closePos. */
  closePos: number
  expectedCandleType: string
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo
}

/** Same plain-language shape classifier the Oracle uses, duplicated rather
 * than imported from analytics/nextcandle.ts on purpose - this module must
 * stay free of any Oracle-side dependency so it can never accidentally pull
 * in Oracle calibration/weighting and misrepresent itself as part of it. */
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

/** Pure per-bar read. Returns null when there isn't enough history for all
 * three indicators to clear their own warmup. */
export function predictHmaRocBullBear(candles: Candle[]): HmaRocBullBearPrediction | null {
  if (candles.length < MIN_CANDLES) return null
  const c = closes(candles)
  const h = highs(candles)
  const l = lows(candles)
  const price = c[c.length - 1]

  // 1. Hull MA slope: current vs HMA_SLOPE_LOOKBACK bars back, normalized
  // by price so it reads as a fraction regardless of instrument scale.
  const hmaLine = hma(c, HMA_PERIOD)
  const hmaNow = hmaLine[hmaLine.length - 1]
  const hmaPrev = hmaLine[hmaLine.length - 1 - HMA_SLOPE_LOOKBACK]
  if (!Number.isFinite(hmaNow) || !Number.isFinite(hmaPrev) || price <= 0) return null
  const hmaSlopePct = ((hmaNow - hmaPrev) / price) * 100
  // a 0.15% HMA slope over 3 bars is already a decisively clean trend on
  // most instruments/timeframes this platform scans - same soft-clamp
  // convention the Oracle's own pUpFromScore/pUpFromEngineScore use
  const hmaScore = clamp(hmaSlopePct / 0.15, -1, 1)

  // 2. ROC momentum: same soft-clamp convention, 1.5% chosen the same way
  // (a clean, decisive read on most of this platform's scanned pairs).
  const rocLine = roc(c, ROC_PERIOD)
  const rocNow = rocLine[rocLine.length - 1]
  if (!Number.isFinite(rocNow)) return null
  const rocScore = clamp(rocNow / 1.5, -1, 1)

  // 3. Elder Ray Bull/Bear Power: net power normalized by ATR so it sits on
  // the same -1..1 scale as the other two regardless of instrument scale.
  const ema13 = ema(c, BULLBEAR_EMA_PERIOD)
  const emaNow = ema13[ema13.length - 1]
  if (!Number.isFinite(emaNow)) return null
  const bullPower = h[h.length - 1] - emaNow
  const bearPower = l[l.length - 1] - emaNow
  const tr = trueRange(h, l, c)
  const atrWindow = tr.slice(-ATR_PERIOD).filter(Number.isFinite)
  const atr = atrWindow.length ? atrWindow.reduce((a, b) => a + b, 0) / atrWindow.length : 0
  const netPower = bullPower + bearPower
  const bullBearScore = atr > 0 ? clamp(netPower / (1.5 * atr), -1, 1) : 0

  const score = (hmaScore + rocScore + bullBearScore) / 3
  const deadband = 0.08 // same spirit as the Oracle's own direction deadband
  const direction: 'call' | 'put' | 'none' = score >= deadband ? 'call' : score <= -deadband ? 'put' : 'none'
  const strength = Math.round(clamp(Math.abs(score), 0, 1) * 100)

  const bodyRatio = clamp(0.2 + Math.abs(score) * 0.7, 0.05, 0.95)
  const closePos = clamp(0.5 + (direction === 'none' ? 0 : score) * 0.45, 0.05, 0.95)

  return {
    direction,
    score: Math.round(score * 1000) / 1000,
    strength,
    hmaSlope: Math.round(hmaSlopePct * 1000) / 1000,
    rocValue: Math.round(rocNow * 1000) / 1000,
    bullPower: Math.round(bullPower * 1e6) / 1e6,
    bearPower: Math.round(bearPower * 1e6) / 1e6,
    bodyRatio,
    closePos,
    expectedCandleType: classifyShape(bodyRatio, closePos, direction),
  }
}
