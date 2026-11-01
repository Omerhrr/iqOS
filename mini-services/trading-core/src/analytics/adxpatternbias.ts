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
//
// Three independent precision layers sit on top of that base agreement
// check, each one only ever TIGHTENING qualification, never loosening it:
//   - HA veto: the same pattern catalog re-run on Heikin Ashi candles
//   - HTF veto: the same ADX/DI read one timeframe rung up (optional input)
//   - regime dampening: a higher qualify bar when the Oracle's own regime
//     classifier (analytics/regime.ts) reads this bar as VOLATILE
// Volume confirmation is informational only (see `volumeConfirms`) - it
// never gates `qualifies` because plenty of OTC/binary feeds carry no real
// volume data at all (see shockpressure.ts's volumeDegraded).

import type { Candle, PatternHit, Timeframe, AnalysisResult } from '../types'
import { adx } from './indicators'
import { detectPatterns, patternBias } from './patterns'
import { heikinAshiSeries } from './chartsignals'
import { classifyRegime, type Regime } from './regime'
import { ewmaVol, garchVol } from './quant'

export const ADX_TREND_THRESHOLD = 25
export const PATTERN_BIAS_LOOKBACK = 8
/** |composite| at/above this is "worth a look" - see composite() below for
 * how the two reads are combined into this single number. In a VOLATILE
 * regime (see `regime` on the fit) this bar is raised 25%, same spirit as
 * the Oracle's own chaosFlatten - a trending-looking ADX/DI read earned
 * inside a volatile tape is less trustworthy than the same read in a clean
 * trend, so it has to clear a higher bar instead of being vetoed outright. */
export const COMPOSITE_QUALIFY = 3.5
export const COMPOSITE_QUALIFY_VOLATILE = COMPOSITE_QUALIFY * 1.25
/** VOLATILE multiplier applied to whichever qualify bar is active (hand-set
 * or learned below) - kept as a ratio rather than a second flat constant so
 * a learned bar still gets the same proportional VOLATILE dampening. */
const VOLATILE_QUALIFY_MULT = COMPOSITE_QUALIFY_VOLATILE / COMPOSITE_QUALIFY

// ---------- honesty-loop learning bridges ----------
// plugins/adxhonesty.ts (new - this composite never had its own honesty
// loop before) tracks every qualifying call this module produces through
// its tracked callers, resolves each one against the REAL next-bar
// direction, and feeds two learned numbers back here, universe-wide (same
// "no asset keying needed" scope the Oracle's driver weights and the
// learned pattern-reliability table already use) - so every caller of
// fitAdxPatternBias, tracked or not, inherits the learned numbers with no
// code changes on their end.
export interface AdxPatternBiasLearning {
  /** learned relative weight of the ADX/DI trend-push leg vs the pattern-
   * bias leg in composite() - replaces the hand-set 1:1 blend once each
   * leg has enough resolved samples to trust. Both default to 1 (today's
   * behavior). composite() re-normalizes so (trendWeight+patternWeight)/2
   * always averages to 1 - only the RELATIVE balance between the two legs
   * ever changes, never the overall scale COMPOSITE_QUALIFY is tuned to. */
  trendWeight: number
  patternWeight: number
}
export type AdxPatternBiasLearningProvider = () => AdxPatternBiasLearning | null
let adxLearningProvider: AdxPatternBiasLearningProvider | null = null
export function setAdxPatternBiasLearningProvider(p: AdxPatternBiasLearningProvider | null): void {
  adxLearningProvider = p
}

/** learned COMPOSITE_QUALIFY replacement - the smallest bar, among a small
 * candidate sweep, whose own resolved hit rate (universe-wide) clears a
 * target precision, found by plugins/adxhonesty.ts. null until there's
 * enough resolved history to trust any candidate. */
export type AdxQualifyBarProvider = () => number | null
let adxQualifyBarProvider: AdxQualifyBarProvider | null = null
export function setAdxQualifyBarProvider(p: AdxQualifyBarProvider | null): void {
  adxQualifyBarProvider = p
}

/** 5s..1d ladder, same order ALL_TIMEFRAMES uses - lets the multi-timeframe
 * confirmation below ask "what's one rung up from here" without keeping a
 * second lookup table in sync by hand. */
const TF_ORDER: Timeframe[] = ['5s', '15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d']
export function higherTimeframe(tf: Timeframe): Timeframe | null {
  const i = TF_ORDER.indexOf(tf)
  if (i < 0 || i >= TF_ORDER.length - 1) return null
  return TF_ORDER[i + 1]
}

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
  /** Every pattern hit in the lookback window, most recent first (same list
   * `topPattern` was already pulled from, just not truncated to one) - for
   * UI that wants to show the whole formation list (e.g. "Bullish
   * Engulfing", "Hammer"), not just the single strongest/most recent hit. */
  patterns: PatternHit[]
  /** Same pattern catalog, same detectors, run against the Heikin Ashi
   * transform of this series instead of raw OHLC - HA's smoothed bodies
   * surface reversal/continuation formations (Doji, Hammer, Engulfing, ...)
   * that can read cleaner than the raw-candle version once the HA
   * smoothing removes noise wicks, at the cost of lagging the real price a
   * bit (HA open is a running average of the prior bar). Raw-candle
   * patterns above already double as "bar chart" patterns: a Bar chart and
   * a Candles chart plot the exact same OHLC values, just styled
   * differently, so there is no separate bar transform to add. */
  haPatterns: PatternHit[]
  haPatternBias: number
  haPatternDirection: Bias
  /** agree = adxDirection and patternDirection point the same way (and
   * neither is neutral) - the whole point of this panel over either read
   * alone. */
  agree: boolean
  /** -10..+10: ADX/DI direction and magnitude (trending only) combined
   * multiplicatively with pattern bias so disagreement cancels toward 0 and
   * agreement amplifies, then clamped. See composite() for the exact rule. */
  composite: number
  direction: Bias
  /** Heikin Ashi pattern direction actively CONTRADICTS the proposed
   * direction (both non-neutral, opposite signs) - an independent third
   * read (same detectors, smoothed series) catching exactly the "ADX/DI +
   * raw-candle pattern agree, but the smoothed bodies disagree" case that
   * the raw agree-check alone cannot see. Precision veto only: this never
   * HELPS a marginal composite qualify, it only blocks one that would have. */
  haDisagrees: boolean
  /** Same ADX/DI read, one timeframe rung up (caller-supplied via the
   * `higherCandles` param - optional, so every existing caller that doesn't
   * pass it keeps running exactly as before: 'neutral', never vetoes).
   * 'neutral' when the higher timeframe isn't itself trending (>= 25) or
   * wasn't provided - a flat higher frame says nothing, so it never blocks. */
  htfDirection: Bias
  /** The higher-timeframe ADX/DI direction actively contradicts this read's
   * proposed direction - catches a trend call about to be overrun by the
   * bigger timeframe's opposite trend. Precision veto only, same contract
   * as haDisagrees. */
  htfDisagrees: boolean
  /** The Oracle's own 4-way regime classifier (analytics/regime.ts), fed
   * this fit's own real ADX plus lightweight vol/persistence proxies - the
   * same classifier the Next-Candle Oracle runs, reused rather than
   * reinvented. Cross-pollinates the two engines' understanding of "is this
   * tape trustworthy right now" without computing the Oracle's full fusion. */
  regime: Regime
  /** Did the strongest recent pattern hit's own bar carry above-average
   * volume for this lookback window? null when volume data is degraded
   * (routinely true for OTC/binary feeds - see shockpressure.ts's
   * volumeDegraded) so a caller never mistakes "no data" for "no
   * confirmation". Informational only - this never gates `qualifies`, it
   * only lets a caller adjust score/break ties, the same way pair-signal
   * already uses haPatternDirection and footprint delta. */
  volumeConfirms: boolean | null
  qualifies: boolean
}

function biasOf(v: number, flatBand: number): Bias {
  if (v > flatBand) return 'bullish'
  if (v < -flatBand) return 'bearish'
  return 'neutral'
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/** Cheap sign-persistence proxy for Hurst, same formula analytics/
 * nextcandle.ts uses for its own regime read - kept local (not imported)
 * so this module doesn't depend on nextcandle.ts at all; both independently
 * feed the same shared classifyRegime(). */
function hurstProxy(closes: number[]): number {
  const rets: number[] = []
  for (let i = Math.max(1, closes.length - 60); i < closes.length; i++) rets.push(Math.sign(closes[i] - closes[i - 1]))
  if (rets.length < 20) return 0.5
  let same = 0
  for (let i = 1; i < rets.length; i++) if (rets[i] === rets[i - 1]) same++
  const persistence = same / (rets.length - 1)
  return Math.max(0.3, Math.min(0.7, 0.5 + (persistence - 0.5) * 0.5))
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
  const learning = adxLearningProvider?.() ?? null
  let tw = learning && Number.isFinite(learning.trendWeight) ? learning.trendWeight : 1
  let pw = learning && Number.isFinite(learning.patternWeight) ? learning.patternWeight : 1
  // re-normalize so the two legs' weights always average to 1 - only their
  // RELATIVE balance moves, the overall scale COMPOSITE_QUALIFY is tuned
  // to never silently drifts just because the learning provider's own
  // scale differs.
  const avg = (tw + pw) / 2
  if (avg > 0) {
    tw /= avg
    pw /= avg
  }
  const wTrend = trendPush * tw
  const wPattern = patBias * pw
  const sum = wTrend + wPattern
  const sameSign = (wTrend >= 0 && wPattern >= 0) || (wTrend <= 0 && wPattern <= 0)
  const raw = sameSign ? sum : sum * 0.5
  return Math.max(-10, Math.min(10, raw))
}

/** Plain ADX/DI direction of a series, trend-gated the same way the main
 * fit is - shared by the base read and the optional higher-timeframe read
 * below so the two can never silently drift apart in logic. */
function adxDirectionOf(candles: Candle[], period: number): { adxVal: number; direction: Bias } | null {
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
  return { adxVal, direction: trending ? (plusVal > minusVal ? 'bullish' : plusVal < minusVal ? 'bearish' : 'neutral') : 'neutral' }
}

/** Fits the composite read from a closed-candle series. Returns null when
 * there isn't enough history for either leg.
 *
 * `higherCandles`, when supplied, is a closed-candle series for the NEXT
 * timeframe up (see `higherTimeframe()`) for the same asset - used only for
 * the htfDisagrees veto. Omitting it (the default - existing callers are
 * unaffected) simply leaves htfDirection 'neutral' and htfDisagrees false. */
export function fitAdxPatternBias(candles: Candle[], period = 14, lookback = PATTERN_BIAS_LOOKBACK, higherCandles?: Candle[]): AdxPatternBiasFit | null {
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

  const haHits = detectPatterns(heikinAshiSeries(candles), lookback)
  const haPatBias = patternBias(haHits)
  const haPatternDirection = biasOf(haPatBias, 0.5)

  const comp = composite(trendPush, patBias)
  const direction = biasOf(comp, 0.75)
  const agree = adxDirection !== 'neutral' && patternDirection !== 'neutral' && adxDirection === patternDirection
  // HA veto: the same pattern catalog, re-run on the smoothed Heikin Ashi
  // series, actively points the OTHER way - a real disagreement the
  // raw-candle agree-check above cannot see (it only compares ADX/DI vs
  // raw-candle patterns). Only ever tightens qualification, never loosens
  // it: a neutral or agreeing HA read changes nothing.
  const haDisagrees = haPatternDirection !== 'neutral' && direction !== 'neutral' && haPatternDirection !== direction

  // HTF veto: this timeframe's own ADX/DI fight against one rung up's.
  // Same shape as the HA veto - optional, only tightens, never fires when
  // the higher frame isn't trending or wasn't supplied.
  const htf = higherCandles && higherCandles.length ? adxDirectionOf(higherCandles, period) : null
  const htfDirection: Bias = htf?.direction ?? 'neutral'
  const htfDisagrees = htfDirection !== 'neutral' && direction !== 'neutral' && htfDirection !== direction

  // Regime cross-pollination: reuse the Oracle's own 4-way classifier
  // (analytics/regime.ts) fed this fit's REAL adx (better than the proxy
  // nextcandle.ts has to estimate) plus the same lightweight vol/
  // persistence proxies it uses. A VOLATILE read raises the qualify bar
  // instead of vetoing outright - volatility makes a trend read noisier,
  // not necessarily wrong.
  const rets: number[] = []
  for (let k = 1; k < close.length; k++) rets.push(Math.log(close[k] / close[k - 1]))
  const recentRets = rets.slice(-300)
  const regime = classifyRegime({
    indicators: { adx: adxVal },
    quant: { hurst: hurstProxy(close), garchVol: garchVol(recentRets), ewmaVol: ewmaVol(recentRets) },
  } as unknown as AnalysisResult)
  const learnedBar = adxQualifyBarProvider?.() ?? null
  const baseBar = learnedBar && learnedBar > 0 ? learnedBar : COMPOSITE_QUALIFY
  const qualifyBar = regime === 'VOLATILE' ? baseBar * VOLATILE_QUALIFY_MULT : baseBar

  // Volume confirmation (informational, see volumeConfirms doc above): only
  // ever computed when real volume data exists for this window.
  const volWindow = candles.slice(-lookback)
  const avgVol = mean(volWindow.map((c) => c.volume))
  const volumeDataPresent = avgVol > 0 && volWindow.some((c) => c.volume > 0)
  let volumeConfirms: boolean | null = null
  if (volumeDataPresent && top) {
    const topBar = candles[candles.length - 1 - (top.barsAgo ?? 0)]
    if (topBar) volumeConfirms = topBar.volume > avgVol
  }

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
    patterns: hits,
    haPatterns: haHits,
    haPatternBias: haPatBias,
    haPatternDirection,
    agree,
    composite: comp,
    direction,
    haDisagrees,
    htfDirection,
    htfDisagrees,
    regime,
    volumeConfirms,
    qualifies: agree && Math.abs(comp) >= qualifyBar && !haDisagrees && !htfDisagrees,
  }
}
