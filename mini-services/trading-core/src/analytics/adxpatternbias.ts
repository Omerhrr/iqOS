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
/** A bar crossing ADX_TREND_THRESHOLD for ONE bar can be a spike, not a
 * real trend - require the ADX reading to have held at/above the
 * (possibly learned) threshold for this many consecutive bars, including
 * the current one, before calling it trending at all. Applied identically
 * to the base read and the HTF read (adxDirectionOf below). Precision-
 * only: raising this only ever makes "trending" harder to earn, same
 * never-loosens contract as every other veto in this module. */
const TREND_PERSISTENCE_BARS = 2

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

/** Learned replacement for the flat HTF veto: how much extra composite
 * margin an HTF-disagreeing read must clear to still qualify, as a
 * multiplier on the normal qualify bar. null (the default, and the
 * fallback below LEG_STATS_MIN_N-equivalent sample size in the honesty
 * loop) means "no learning yet" and the veto stays exactly as hard as it
 * always was - this can only ever make the veto data-driven, never
 * silently remove it before there's evidence either way. */
/** Learned replacement for the flat ADX_TREND_THRESHOLD (25): a bar's own
 * resolved ledger can only ever tell this whether RAISING the bar would
 * have paid off - every resolved call already required adx >= the
 * threshold in force at track time, so there's no data on what a LOWER
 * threshold would have done. The learned value is therefore only ever
 * >= ADX_TREND_THRESHOLD: precision-tightening only, same contract as
 * every other learned veto here. null = still using the flat 25. */
export type AdxTrendThresholdProvider = () => number | null
let adxTrendThresholdProvider: AdxTrendThresholdProvider | null = null
export function setAdxTrendThresholdProvider(p: AdxTrendThresholdProvider | null): void {
  adxTrendThresholdProvider = p
}
function effectiveAdxTrendThreshold(): number {
  const learned = adxTrendThresholdProvider?.()
  return learned && learned >= ADX_TREND_THRESHOLD ? learned : ADX_TREND_THRESHOLD
}

export type AdxHtfLearningProvider = () => { penaltyMult: number } | null
let adxHtfLearningProvider: AdxHtfLearningProvider | null = null
export function setAdxHtfLearningProvider(p: AdxHtfLearningProvider | null): void {
  adxHtfLearningProvider = p
}

/** Learned replacement for the flat HA (Heikin Ashi pattern) veto - same
 * graduated-penalty shape as the HTF veto above (setAdxHtfLearningProvider),
 * just for the OTHER independent precision layer. The HA veto used to be a
 * hard block with no way to ever learn whether the smoothed-series
 * contradiction actually costs accuracy or not; this lets the honesty loop
 * shadow-track calls blocked only by HA disagreement and replace the flat
 * block with a learned extra-margin requirement once there's evidence
 * either way. null = still a hard block (today's original behavior). */
export type AdxHaLearningProvider = () => { penaltyMult: number } | null
let adxHaLearningProvider: AdxHaLearningProvider | null = null
export function setAdxHaLearningProvider(p: AdxHaLearningProvider | null): void {
  adxHaLearningProvider = p
}

/** Learned, bounded boost to the composite-vs-qualify-bar comparison when
 * `volumeConfirms` reads true - was purely informational (never gated or
 * helped `qualifies`) despite plausibly carrying real signal on feeds that
 * DO have volume data. Capped well under the HTF/confluence boosts' own
 * ceiling (VOLUME_BOOST_MAX) since this is a much weaker, more occasional
 * signal (volume data is routinely absent on OTC/binary feeds - see
 * shockpressure.ts's volumeDegraded). 1 (no boost) until the honesty loop
 * has enough resolved history on BOTH the confirmed and unconfirmed sides
 * to trust the comparison. */
export const VOLUME_BOOST_MAX = 1.2
export type AdxVolumeBoostProvider = () => number | null
let adxVolumeBoostProvider: AdxVolumeBoostProvider | null = null
export function setAdxVolumeBoostProvider(p: AdxVolumeBoostProvider | null): void {
  adxVolumeBoostProvider = p
}

/** Learned, direction-split replacement for the flat universe-wide qualify
 * bar - a composite this reliable at +7 (bullish) doesn't necessarily mean
 * the same reliability at -7 (bearish); many pairs/regimes carry a
 * structural trend bias that makes one direction's reads more trustworthy
 * than the other's. Falls back through: this direction's own learned bar,
 * then the flat universe-wide learned bar (adxQualifyBarProvider), then the
 * hand-set COMPOSITE_QUALIFY - same graduated-fallback shape used
 * everywhere else in this module. */
export type AdxQualifyBarByDirectionProvider = () => { bullish: number | null; bearish: number | null } | null
let adxQualifyBarByDirectionProvider: AdxQualifyBarByDirectionProvider | null = null
export function setAdxQualifyBarByDirectionProvider(p: AdxQualifyBarByDirectionProvider | null): void {
  adxQualifyBarByDirectionProvider = p
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
  /** Same pattern-bias read as the raw-candle leg, one timeframe rung up
   * (same optional `higherCandles` input as htfDirection) - 'neutral' when
   * there's no pattern hit on the higher frame or it wasn't supplied. */
  htfPatternDirection: Bias
  /** The higher-timeframe ADX/DI direction OR the higher-timeframe pattern
   * direction actively contradicts this read's proposed direction -
   * catches a trend/pattern call about to be overrun by the bigger
   * timeframe. Precision veto only, same contract as haDisagrees; both
   * checks share one learned penalty (see setAdxHtfLearningProvider). */
  htfDisagrees: boolean
  /** Would this fit have qualified if the HTF veto alone were ignored (HA
   * veto and the qualify bar still apply)? Lets the honesty loop shadow-
   * track exactly the calls the HTF veto blocks - the only way to ever
   * learn whether that veto is worth its cost, since a hard-blocked call
   * never gets to resolve against reality on its own. */
  qualifiesIgnoringHtf: boolean
  /** Would this fit have qualified if the HA veto alone were ignored (HTF
   * veto and qualify bar still apply)? Shadow-tracking counterpart of
   * qualifiesIgnoringHtf, for the HA veto's own learned graduated penalty
   * (see setAdxHaLearningProvider). */
  qualifiesIgnoringHa: boolean
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
/** Has the ADX series held AT OR ABOVE `threshold` for TREND_PERSISTENCE_BARS
 * consecutive bars ending at index `i` (inclusive)? A series shorter than
 * the persistence window just checks whatever history exists - this can
 * only ever make "trending" harder to earn, never impossible to earn on
 * thin history. */
function trendPersists(adxSeries: number[], i: number, threshold: number): boolean {
  for (let k = 0; k < TREND_PERSISTENCE_BARS; k++) {
    const idx = i - k
    if (idx < 0) break
    if (!(adxSeries[idx] >= threshold)) return false
  }
  return true
}

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
  const threshold = effectiveAdxTrendThreshold()
  const trending = adxVal >= threshold && trendPersists(adxSeries, i, threshold)
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

  const trendThreshold = effectiveAdxTrendThreshold()
  const trending = adxVal >= trendThreshold && trendPersists(adxSeries, i, trendThreshold)
  const adxDirection: Bias = trending ? (plusVal > minusVal ? 'bullish' : plusVal < minusVal ? 'bearish' : 'neutral') : 'neutral'
  const trendPush = trending ? Math.max(-6, Math.min(6, (adxVal - trendThreshold) * (adxDirection === 'bearish' ? -1 : 1) * 0.3)) : 0

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

  // HTF veto: this timeframe's own ADX/DI fight against one rung up's, OR
  // this timeframe's pattern read fighting one rung up's pattern read -
  // same shape as the HA veto, optional, only tightens, never fires when
  // the higher frame isn't trending/has no pattern read or wasn't
  // supplied. Both checks share ONE learned penalty (htfPenaltyMult) -
  // they're the same underlying idea (does the bigger timeframe disagree)
  // just read off two different legs, so one learned number for "is the
  // HTF veto worth its cost" covers both instead of needing two separate
  // honesty-loop ledgers.
  const htf = higherCandles && higherCandles.length ? adxDirectionOf(higherCandles, period) : null
  const htfDirection: Bias = htf?.direction ?? 'neutral'
  const htfAdxDisagrees = htfDirection !== 'neutral' && direction !== 'neutral' && htfDirection !== direction
  const htfHits = higherCandles && higherCandles.length ? detectPatterns(higherCandles, lookback) : null
  const htfPatternBias = htfHits ? patternBias(htfHits) : 0
  const htfPatternDirection: Bias = htfHits ? biasOf(htfPatternBias, 0.5) : 'neutral'
  const htfPatternDisagrees = htfPatternDirection !== 'neutral' && direction !== 'neutral' && htfPatternDirection !== direction
  const htfDisagrees = htfAdxDisagrees || htfPatternDisagrees

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
  const byDir = adxQualifyBarByDirectionProvider?.() ?? null
  const dirBar = direction === 'bullish' ? byDir?.bullish : direction === 'bearish' ? byDir?.bearish : null
  const baseBar = dirBar && dirBar > 0 ? dirBar : learnedBar && learnedBar > 0 ? learnedBar : COMPOSITE_QUALIFY
  const qualifyBar = regime === 'VOLATILE' ? baseBar * VOLATILE_QUALIFY_MULT : baseBar

  // Volume confirmation: computed before the qualify checks below (used to
  // be purely informational, computed last) so volumeConfirmBoost() can
  // feed into the composite-vs-qualify-bar comparison. See volumeConfirms
  // doc above - only ever computed when real volume data exists for this
  // window; null (no data, routinely true for OTC/binary feeds) never
  // boosts or penalizes, same as it never gated before.
  const volWindow = candles.slice(-lookback)
  const avgVol = mean(volWindow.map((c) => c.volume))
  const volumeDataPresent = avgVol > 0 && volWindow.some((c) => c.volume > 0)
  let volumeConfirms: boolean | null = null
  if (volumeDataPresent && top) {
    const topBar = candles[candles.length - 1 - (top.barsAgo ?? 0)]
    if (topBar) volumeConfirms = topBar.volume > avgVol
  }
  // Learned, bounded boost (see setAdxVolumeBoostProvider) - only ever
  // applied to the COMPARISON against the qualify bar, never to the
  // `composite` value itself reported on the fit, so the panel's own
  // composite number stays the honest, un-boosted read.
  const volBoost = volumeConfirms === true ? Math.max(1, Math.min(VOLUME_BOOST_MAX, adxVolumeBoostProvider?.() ?? 1)) : 1
  const effectiveComp = comp * volBoost

  const qualifiesBase = agree && Math.abs(effectiveComp) >= qualifyBar
  // Learned, graduated HA veto: with no learning yet (null provider or
  // thin shadow-tracked sample) this behaves EXACTLY like the old hard
  // veto - haBlocks === haDisagrees. Once the honesty loop has enough
  // shadow-tracked HA-disagreeing calls to know whether the smoothed-series
  // contradiction actually costs accuracy, penaltyMult replaces the flat
  // block with a learned extra-margin requirement, same shape as the HTF
  // veto below.
  const haLearning = adxHaLearningProvider?.() ?? null
  const haPenaltyMult = haLearning && Number.isFinite(haLearning.penaltyMult) && haLearning.penaltyMult > 0 ? haLearning.penaltyMult : null
  const haBlocks = haDisagrees && (haPenaltyMult === null ? true : Math.abs(effectiveComp) < qualifyBar * haPenaltyMult)
  // Learned, graduated HTF veto: with no learning yet (null provider or
  // thin sample in the honesty loop) this behaves EXACTLY like the old
  // hard veto - htfBlocks === htfDisagrees. Once the honesty loop has
  // enough shadow-tracked HTF-disagreeing calls to know whether the HTF
  // read actually costs accuracy, penaltyMult replaces the flat block with
  // a learned extra-margin requirement: small (near 1x) if disagreement
  // turns out not to matter much, large enough to be a de-facto veto
  // again if it does.
  const htfLearning = adxHtfLearningProvider?.() ?? null
  const htfPenaltyMult = htfLearning && Number.isFinite(htfLearning.penaltyMult) && htfLearning.penaltyMult > 0 ? htfLearning.penaltyMult : null
  const htfBlocks = htfDisagrees && (htfPenaltyMult === null ? true : Math.abs(effectiveComp) < qualifyBar * htfPenaltyMult)
  const qualifiesIgnoringHtf = qualifiesBase && !haBlocks
  const qualifiesIgnoringHa = qualifiesBase && !htfBlocks
  const qualifies = qualifiesBase && !haBlocks && !htfBlocks

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
    htfPatternDirection,
    htfDisagrees,
    regime,
    volumeConfirms,
    qualifiesIgnoringHtf,
    qualifiesIgnoringHa,
    qualifies,
  }
}
