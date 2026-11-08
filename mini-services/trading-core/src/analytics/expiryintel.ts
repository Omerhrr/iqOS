// IQAIR//OS - Binary-options expiry intelligence.
//
// Section 9 of the original "MSL expansion backlog" checklist asked for a
// cluster of expiry-aware primitives (directional pressure/momentum near
// expiry, reversal risk near expiry, candle-completion probability, price
// displacement over a window, volatility-adjusted expected movement, and
// expiry-gated stagnation/exhaustion). Everything here is a PURE function of
// candle history - no live-plugin state, no payout, no tick buffer - so it
// replays faithfully in meta_strategy_backtest exactly like ind.*/ohlc()
// already do. Nothing here invents new indicator math: momentum/
// displacement/expected-move all reuse the same ROC/ATR-family formulas
// analytics/indicators.ts already has, just named and packaged for the
// "how is this bar likely to resolve by expiry" use case specifically.
//
// candleCompletionProbability() is the one genuinely NEW idea here, and it
// is stated as an explicit, documented heuristic, not a textbook formula -
// no canonical "probability a binary candle closes in its current leaning
// direction" formula exists. It models the remaining time-to-close as a
// driftless random walk (a standard first-pass approximation for short
// horizons) with volatility estimated from recent ATR, and reads out the
// normal-CDF probability that the already-realized intrabar displacement
// survives to the close. This is clearly flagged everywhere it's surfaced
// so nobody mistakes it for a measured probability.

import type { Candle } from '../types'

function atr(candles: Candle[], period: number): number {
  const n = candles.length
  if (n < 2) return 0
  const start = Math.max(1, n - period)
  let sum = 0
  let count = 0
  for (let i = start; i < n; i++) {
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close))
    sum += tr
    count++
  }
  return count > 0 ? sum / count : 0
}

/** Rate-of-change momentum over `lookback` bars, as a signed percentage of
 * the earlier close - the exact same ROC formula ind.roc() already uses,
 * just under an expiry-context name so a script reads "momentum heading
 * into expiry" rather than reaching for the generic indicator. */
export function expiryMomentum(candles: Candle[], lookback = 5): number {
  const n = candles.length
  if (n < lookback + 1) return 0
  const now = candles[n - 1].close
  const then = candles[n - 1 - lookback].close
  return then !== 0 ? ((now - then) / then) * 100 : 0
}

/** Raw price displacement over `windowBars`, in price units AND as a
 * multiple of the window's own ATR (so "how far did price move" is
 * comparable across assets/volatility regimes, not just raw price units). */
export function priceDisplacement(candles: Candle[], windowBars = 5): { price: number; atrMultiple: number } {
  const n = candles.length
  if (n < windowBars + 1) return { price: 0, atrMultiple: 0 }
  const now = candles[n - 1].close
  const then = candles[n - 1 - windowBars].close
  const a = atr(candles, Math.max(windowBars, 14))
  return { price: now - then, atrMultiple: a > 0 ? (now - then) / a : 0 }
}

/** Volatility-adjusted expected move over `windowBars`, using the standard
 * square-root-of-time ATR scaling (ATR per bar * sqrt(bars) - the same
 * scaling convention option-pricing/vol-forecasting already uses for
 * "expected move over N periods" from a per-period volatility estimate). */
export function volAdjustedExpectedMove(candles: Candle[], windowBars = 5): number {
  const a = atr(candles, Math.max(14, windowBars))
  return a * Math.sqrt(Math.max(1, windowBars))
}

/** Reversal-risk proxy: how many ATRs the last `lookback`-bar move has
 * already travelled (a z-score-shaped overextension read) - a documented
 * heuristic (there is no single textbook "reversal risk" formula): the
 * further price has already run relative to its own recent ATR, the higher
 * this reads, on the theory that an overextended move is statistically more
 * likely to mean-revert before a short expiry than to keep accelerating.
 * Always a non-negative magnitude - direction is read separately from the
 * move's own sign (priceDisplacement.price), this is "how stretched", not
 * "which way". */
export function reversalRisk(candles: Candle[], lookback = 5): number {
  const d = priceDisplacement(candles, lookback)
  return Math.abs(d.atrMultiple)
}

/** Expiry-gated stagnation/exhaustion over the last `windowBars`: stagnation
 * = the window's own range is small relative to its ATR (price went
 * nowhere despite "normal" volatility - a candle completing from here has
 * no established direction to extend); exhaustion = momentum over the same
 * window is large relative to ATR (a sustained one-directional run that is
 * running out of fresh volatility to keep extending on). Both read as
 * magnitudes (0+); a script compares against its own threshold, same
 * convention as every other raw primitive in this codebase (no forced
 * boolean gate baked in here). */
export function expiryStagnationExhaustion(candles: Candle[], windowBars = 5): { stagnation: number; exhaustion: number } {
  const n = candles.length
  if (n < windowBars + 1) return { stagnation: 0, exhaustion: 0 }
  const a = atr(candles, Math.max(14, windowBars))
  if (a <= 0) return { stagnation: 0, exhaustion: 0 }
  let hi = -Infinity
  let lo = Infinity
  for (let i = n - windowBars; i < n; i++) {
    hi = Math.max(hi, candles[i].high)
    lo = Math.min(lo, candles[i].low)
  }
  const range = hi - lo
  const stagnation = range > 0 ? Math.max(0, 1 - range / a) : 1
  const exhaustion = Math.abs(expiryMomentum(candles, windowBars)) / 100 / Math.max(a / candles[n - 1].close, 1e-9)
  return { stagnation: Math.round(stagnation * 1000) / 1000, exhaustion: Math.round(exhaustion * 100) / 100 }
}

// Standard normal CDF via the Abramowitz-Stegun approximation (no external
// stats library in this codebase) - accurate to ~1e-7, plenty for a
// documented heuristic read, never presented as exact.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp((-z * z) / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z >= 0 ? 1 - p : p
}

export interface CompletionProbability {
  direction: 'call' | 'put' | 'none'
  probability: number // 0.5..1 toward `direction`, 0.5 = coin-flip (no lean yet)
}

/** Candle-completion probability, as an EXPLICIT documented heuristic (see
 * this module's own header) - not a measured/historical frequency. Models
 * the live bar's remaining time as a driftless random walk with per-bar
 * volatility `atr(closedCandles)`, and reads the probability that the
 * already-realized open-to-now displacement (openToNow, in price units)
 * survives through the remaining `remainingFraction` (0..1) of the bar.
 * remainingFraction=1 (nothing elapsed yet) always reads 0.5 (no lean is
 * possible with no information yet) and remainingFraction=0 (bar fully
 * elapsed) reads 1.0 toward whichever direction the realized move already
 * leans - the two sane boundary behaviors a caller should expect. */
export function candleCompletionProbability(closedCandles: Candle[], openToNow: number, remainingFraction: number): CompletionProbability {
  if (openToNow === 0) return { direction: 'none', probability: 0.5 }
  const frac = Math.max(0, Math.min(1, remainingFraction))
  if (frac >= 1) return { direction: 'none', probability: 0.5 }
  const a = atr(closedCandles, 14)
  if (a <= 0) return { direction: 'none', probability: 0.5 }
  const remainingVol = a * Math.sqrt(Math.max(frac, 1e-6))
  const z = Math.abs(openToNow) / remainingVol
  const probability = Math.max(0.5, Math.min(1, normalCdf(z)))
  return { direction: openToNow > 0 ? 'call' : 'put', probability: Math.round(probability * 1000) / 1000 }
}
