// IQAIR//OS - ADX/DI + Pattern Bias composite
//
// Combines two already-existing reads into one directional score instead of
// inventing new math:
//
//   1. ADX / +DI / -DI (analytics/indicators.ts's adx()) - classic trend
//      STRENGTH + direction. ADX > 25 is "trending"; which of +DI/-DI sits on
//      top says which way.
//   2. Pattern Bias (analytics/patterns.ts's detectPatterns + patternBias) -
//      a recency+reliability weighted net score across every candlestick
//      pattern hit in the last few bars, in [-6, +6].
//
// Neither read alone is enough to act on: ADX/DI can be "trending down" while
// the last candle just printed a bullish reversal pattern (exhaustion), and a
// single pattern hit with no trend behind it (ADX < 20, chop) is noise. This
// module scores AGREEMENT between the two: same direction + both strong ->
// high-confidence composite; disagreement or either read flat -> composite
// near 0 and it does not qualify.

import type { Candle } from '../types'
import { adx } from './indicators'
import { detectPatterns, patternBias } from './patterns'

export const ADX_TREND_THRESHOLD = 25
export const PATTERN_BIAS_LOOKBACK = 8
/** |composite| at/above this is "worth a look" - see composite() below for
 * how the two reads are combined into this single number. */
export const COMPOSITE_QUALIFY = 3.5

export type Bias = 'bullish' | 'bearish' | 'neutral'

export interface AdxPatternBiasFit {
  adx: number
  plusDI: number
  minusDI: number
  trending: boolean
  adxDirection: Bias
  patternBias: number
  patternDirection: Bias
  topPattern: string | null
  topPatternBarsAgo: number | null
  /** agree = adxDirection and patternDirection point the same way (and
   * neither is neutral) - the whole point of this panel over either read
   * alone. */
  agree: boolean
  /** -10..+10: ADX/DI direction and magnitude (trending only) combined
   * multiplicatively with pattern bias so disagreement cancels toward 0 and
   * agreement amplifies, then clamped. See composite() for the exact rule. */
  composite: number
  direction: Bias
  qualifies: boolean
}

function biasOf(v: number, flatBand: number): Bias {
  if (v > flatBand) return 'bullish'
  if (v < -flatBand) return 'bearish'
  return 'neutral'
}

/** The combining rule: ADX/DI contributes a signed "trend push" (0 when not
 * trending, otherwise +/-(adx - threshold) scaled to roughly match pattern
 * bias's [-6,+6] range), pattern bias contributes its own signed score, and
 * the composite is their SUM when they agree in sign, HALVED-and-summed
 * (i.e. penalized) when they disagree - so two weak-but-agreeing reads can
 * still clear the bar, while a strong trend fighting a fresh reversal
 * pattern pulls the composite back toward 0 rather than letting the bigger
 * of the two just win. */
function composite(trendPush: number, patBias: number): number {
  const sum = trendPush + patBias
  const sameSign = (trendPush >= 0 && patBias >= 0) || (trendPush <= 0 && patBias <= 0)
  const raw = sameSign ? sum : sum * 0.5
  return Math.max(-10, Math.min(10, raw))
}

/** Fits the composite read from a closed-candle series. Returns null when
 * there isn't enough history for either leg. */
export function fitAdxPatternBias(candles: Candle[], period = 14, lookback = PATTERN_BIAS_LOOKBACK): AdxPatternBiasFit | null {
  if (candles.length < Math.max(period * 2, 30)) return null
  const high = candles.map((c) => c.high)
  const low = candles.map((c) => c.low)
  const close = candles.map((c) => c.close)
  const { adx: adxSeries, plusDI, minusDI } = adx(high, low, close, period)
  const i = adxSeries.length - 1
  const adxVal = adxSeries[i]
  const plusVal = plusDI[i]
  const minusVal = minusDI[i]
  if (!Number.isFinite(adxVal) || !Number.isFinite(plusVal) || !Number.isFinite(minusVal)) return null

  const trending = adxVal >= ADX_TREND_THRESHOLD
  const adxDirection: Bias = trending ? (plusVal > minusVal ? 'bullish' : plusVal < minusVal ? 'bearish' : 'neutral') : 'neutral'
  const trendPush = trending ? Math.max(-6, Math.min(6, (adxVal - ADX_TREND_THRESHOLD) * (adxDirection === 'bearish' ? -1 : 1) * 0.3)) : 0

  const hits = detectPatterns(candles, lookback)
  const patBias = patternBias(hits)
  const patternDirection = biasOf(patBias, 0.5)
  const top = hits[0] ?? null

  const comp = composite(trendPush, patBias)
  const direction = biasOf(comp, 0.75)
  const agree = adxDirection !== 'neutral' && patternDirection !== 'neutral' && adxDirection === patternDirection

  return {
    adx: adxVal,
    plusDI: plusVal,
    minusDI: minusVal,
    trending,
    adxDirection,
    patternBias: patBias,
    patternDirection,
    topPattern: top?.name ?? null,
    topPatternBarsAgo: top?.barsAgo ?? null,
    agree,
    composite: comp,
    direction,
    qualifies: agree && Math.abs(comp) >= COMPOSITE_QUALIFY,
  }
}
