// IQAIR//OS - Shock + Pressure composite
//
// Same philosophy as analytics/adxpatternbias.ts: combine two already-existing
// reads into one directional score instead of inventing new math.
//
//   1. Shock - a sudden, discontinuous move: the latest closed bar's return
//      measured against this asset's own recent volatility (ATR, indicators.ts's
//      atr()). A bar whose move is several multiples of its normal range is an
//      "event" - something just broke from the recent pattern (a gap, a burst
//      of aggressive flow, a liquidity air-pocket) rather than a gradual drift.
//      This is an ATR-normalized ratio, not a real statistical z-score (returns
//      aren't normally distributed and ATR isn't a stdev-of-returns estimator) -
//      it is labeled "shock ratio" everywhere, never "z", to stay honest about
//      what it actually is.
//
//   2. Pressure - directional imbalance BUILDING across several bars, not just
//      the one that shocked. IQ Option's feed has no real order book or
//      bid/ask-tagged trades (see analytics/orderflow.ts's own note on this),
//      so pressure here reuses that module's existing CLV-based buy/sell volume
//      split (computeCandleDelta) summed over a short lookback window instead
//      of inventing a second approximation - net delta / total volume over that
//      window, in [-1, +1].
//
// Neither read alone is enough to act on: a shock with no pressure behind it is
// as likely to be a one-bar spike that round-trips as a real breakout, and
// pressure building with no shock yet is still just "building" - there's no
// trigger. This module scores AGREEMENT between the two the same way
// adxpatternbias.ts does: same direction + both meaningful -> high-confidence
// composite; disagreement or either read flat -> composite near 0 and it does
// not qualify. Shock plays the role ADX/DI plays there (the gate: nothing
// qualifies without it), pressure plays the role pattern bias plays (the
// confirming second read).

import type { Candle } from '../types'
import { atr } from './indicators'
import { computeCandleDelta } from './orderflow'

export const SHOCK_RATIO_THRESHOLD = 2.5
export const PRESSURE_LOOKBACK = 10
/** |composite| at/above this is "worth a look" - see composite() below for
 * how the two reads are combined into this single number. Same [-10,10]
 * scale and same meaning as adxpatternbias.ts's COMPOSITE_QUALIFY, just a
 * separate constant/name so the two modules stay independently tunable. */
export const SHOCKPRESSURE_COMPOSITE_QUALIFY = 3.5

export type Bias = 'bullish' | 'bearish' | 'neutral'

export interface ShockPressureFit {
  atr: number
  barReturn: number
  /** latest bar's return / ATR - NOT a real z-score, see header note. */
  shockRatio: number
  shock: boolean
  shockDirection: Bias
  /** sum of (buyVolume - sellVolume) over the lookback window - see
   * orderflow.ts's CLV-based approximation this reuses. */
  netDelta: number
  /** total (buy + sell) volume over the same window; 0 when every candle in
   * the window has zero volume - see volumeDegraded below for what happens
   * to pressureRatio then (it is NOT simply forced to 0/neutral anymore). */
  netVolume: number
  /** true when netVolume is ~0 across the whole window (THE BUG this fixed:
   * live/forming candles and many OTC/binary instruments routinely carry
   * zero or dead volume - see market-data.ts's applyTick note and
   * orderflow.ts's own header on "volume" being tick-count-ish for these
   * instruments - which used to force pressureRatio to a hardcoded 0 every
   * time, making pressureDirection permanently 'neutral' and therefore
   * `agree`/`qualifies` structurally unreachable regardless of how extreme
   * the shock was. When true, pressureRatio below falls back to a
   * volume-independent proxy - the window's average CLV position
   * (close-location-value, the same buy/sell split orderflow.ts's
   * computeCandleDelta uses per-candle) - instead of the volume-weighted
   * delta, since direction-of-closes is still a meaningful read even with
   * no real size signal to weight it by. */
  volumeDegraded: boolean
  /** netDelta / netVolume when volume data exists, [-1, +1]; the CLV-based
   * fallback described in volumeDegraded above when it doesn't. Either way,
   * [-1, +1]. */
  pressureRatio: number
  pressureDirection: Bias
  /** agree = shockDirection and pressureDirection point the same way (and
   * neither is neutral) - the whole point of this panel over either read
   * alone. */
  agree: boolean
  /** -10..+10: shock contributes a signed push (0 unless shock is true,
   * otherwise the shock ratio itself, clamped) combined multiplicatively
   * with pressure's signed push so disagreement cancels toward 0 and
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

/** The combining rule, identical shape to adxpatternbias.ts's composite():
 * the composite is the SUM of the two signed pushes when they agree in sign,
 * HALVED-and-summed (penalized) when they disagree - so two weak-but-agreeing
 * reads can still clear the bar, while a shock fighting pressure in the
 * opposite direction (a spike against the grain - more likely to round-trip)
 * pulls the composite back toward 0 rather than letting the bigger of the two
 * just win. */
function composite(shockPush: number, pressurePush: number): number {
  const sum = shockPush + pressurePush
  const sameSign = (shockPush >= 0 && pressurePush >= 0) || (shockPush <= 0 && pressurePush <= 0)
  const raw = sameSign ? sum : sum * 0.5
  return Math.max(-10, Math.min(10, raw))
}

/** Fits the composite read from a closed-candle series. Returns null when
 * there isn't enough history for either leg. */
export function fitShockPressure(candles: Candle[], atrPeriod = 14, pressureLookback = PRESSURE_LOOKBACK, shockRatioThreshold = SHOCK_RATIO_THRESHOLD): ShockPressureFit | null {
  if (candles.length < Math.max(atrPeriod * 2, pressureLookback + 2, 30)) return null
  const high = candles.map((c) => c.high)
  const low = candles.map((c) => c.low)
  const close = candles.map((c) => c.close)
  const atrSeries = atr(high, low, close, atrPeriod)
  const i = atrSeries.length - 1
  const atrVal = atrSeries[i]
  const barReturn = close[i] - close[i - 1]
  if (!Number.isFinite(atrVal) || atrVal <= 0 || !Number.isFinite(barReturn)) return null

  const shockRatio = barReturn / atrVal
  // THE BUG this fixed: this used to always compare against the module's
  // own SHOCK_RATIO_THRESHOLD constant, ignoring the caller's own threshold
  // entirely - builtin.ts's "shock-pressure" strategy exposes a user-facing
  // "Min |shock ratio|" param that this never actually honored, so changing
  // it in the UI had zero effect on what qualified (cosmetic control).
  const shock = Math.abs(shockRatio) >= shockRatioThreshold
  const shockDirection: Bias = shock ? (shockRatio > 0 ? 'bullish' : 'bearish') : 'neutral'
  const shockPush = shock ? Math.max(-6, Math.min(6, shockRatio)) : 0

  const window = candles.slice(-pressureLookback)
  const deltas = computeCandleDelta(window)
  const netDelta = deltas.reduce((s, d) => s + d.delta, 0)
  const netVolume = deltas.reduce((s, d) => s + d.buyVolume + d.sellVolume, 0)
  // THE BUG this fixed: netVolume is routinely ~0 for the live/forming candle
  // (market-data.ts's tick-rolled path synthesizes vol:0 between sidecar
  // merges) and for plenty of OTC/binary instruments generally (orderflow.ts's
  // own header note: "volume" there is commonly a tick/sample count, which
  // can itself be 0) - this used to hard-fall-back pressureRatio to 0, which
  // is indistinguishable from "no pressure" and pins pressureDirection at
  // 'neutral' forever, so `agree` (and therefore `qualifies`) could never
  // become true no matter how strong the shock was. Falling back to the
  // window's average CLV position (same close-location-value buy/sell split
  // computeCandleDelta uses per-candle, just unweighted by volume) keeps a
  // real directional read alive in exactly the cases that used to go dead.
  const volumeDegraded = netVolume <= 0
  const clvBias =
    window.reduce((s, c) => {
      const range = c.high - c.low
      const clv = range > 0 ? (c.close - c.low) / range : 0.5
      return s + (clv - 0.5) * 2 // -1 (closed at the low) .. +1 (closed at the high)
    }, 0) / Math.max(1, window.length)
  const pressureRatio = volumeDegraded ? clvBias : netDelta / netVolume
  const pressureDirection = biasOf(pressureRatio, 0.1)
  const pressurePush = Math.max(-6, Math.min(6, pressureRatio * 6))

  const comp = composite(shockPush, pressurePush)
  const direction = biasOf(comp, 0.75)
  const agree = shockDirection !== 'neutral' && pressureDirection !== 'neutral' && shockDirection === pressureDirection

  return {
    atr: atrVal,
    barReturn,
    shockRatio,
    shock,
    shockDirection,
    netDelta,
    netVolume,
    volumeDegraded,
    pressureRatio,
    pressureDirection,
    agree,
    composite: comp,
    direction,
    qualifies: shock && agree && Math.abs(comp) >= SHOCKPRESSURE_COMPOSITE_QUALIFY,
  }
}
