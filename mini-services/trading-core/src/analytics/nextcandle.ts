// IQAIR//OS - Next-Candle Oracle
//
// Fuses every directional model the kernel already carries into ONE
// probabilistic forecast of the NEXT candle (direction, magnitude, range)
// - and scores itself. Philosophy, same as analytics/shockpressure.ts and
// adxpatternbias.ts: do not invent new math, combine existing reads - but
// combine them the way the system's own research says they should be
// weighted, and be honest about disagreement.
//
// The models (all already exist in this codebase, zero new indicator math):
//   1. markovChain          - transition-matrix P(next move up)     (quant.ts)
//   2. monteCarlo bootstrap - fraction of resampled paths ending up (quant.ts)
//   3. ouState (Kalman/OU)  - filtered drift + stretch-from-mean    (kalman.ts)
//   4. confluenceSignalOnly - the 14-factor composite engine        (engine.ts)
//   5. chart-engine vote    - renko/pnf/range/tick/footprint/heikin/candle
//                             committee via combineVotes            (chartsignals.ts)
//   6. candle patterns      - net bias of the 35-detector family    (patterns.ts)
//   7. bar physics          - close-location-value + body pressure of the
//                             last few bars (the OTC feed's only real tell,
//                             see analytics/otcfootprint.ts)
//   8. Renko bricks         - the brick-trend read on its own, not folded
//                             into the chart-engine committee's vote - a
//                             standalone, independently-weighted model
//                             exactly like 1-7, not a confluence check
//                             (analytics/renko.ts via chartsignals.ts's
//                             engineVoteSingle())
//   9. Footprint             - order-flow delta/absorption read, same
//                             standalone treatment as Renko above
//                             (analytics/footprint.ts via engineVoteSingle())
// Drivers 8-9 reuse the EXACT SAME vote functions driver #5 (chart-engine
// committee) already calls internally - they are not a second measurement,
// just the same read exposed as its own model instead of buried inside
// the committee's combined score. Since #5 still includes them too, a
// correlation discount (CORRELATED_DRIVER_GROUPS below) keeps an agreeing
// pair from being counted as two independent confirmations.
//
// REGIME WEIGHTING - the market understanding from the 2026-10-27 research
// battery (scripts/results/FINDINGS.md): this universe is regime-persistent
// trending. In TRENDING regimes trend models (markov trendiness, confluence,
// chart engines, streaks) get upweighted and fade models get downweighted;
// in RANGING regimes the OU stretch / z-fade side gets its weight back.
// VOLATILE regimes trust nobody: weights flatten toward equal and the
// confidence floor drops.
//
// FUSION: each model contributes pUp in [0,1] plus a weight. Fusion is a
// weighted geometric mean of odds (log-odds average) - robust to one model
// screaming while the rest whisper, and it never produces a certainty the
// inputs cannot support. Confidence comes from (a) inter-model agreement and
// (b) how far the fused odds are from coin-flip, then is discounted by the
// oracle's own live calibration record (the honesty loop in
// plugins/nextcandle.ts feeds realized hit rate + Brier back into the read).
//
// MAGNITUDE: expected move = last close * EWMA vol, rescaled by the
// state-mean of the Markov next-state (so a big_up transition forecasts a
// bigger-than-vol candle); range from the typical range/body ratio; wick
// split from the recent CLV asymmetry. All estimates are ATR-denominated
// so the panel can draw the next candle as a cone.
//
// Everything is closed-candle only (the kernel's closedOnly invariant) and
// JSON-safe (NaN grounded to 0/null the same way engine.ts does it).

import type { Candle, MarkovResult } from '../types'
import { markovChain, monteCarlo, ewmaVol, garchVol, rng } from './quant'
import { ouState } from './kalman'
import { confluenceSignalOnly } from './engine'
import { combineVotes, engineVotes, engineVoteSingle, heikinAshiSeries } from './chartsignals'
import { detectPatterns, patternBias, learnedPatternReliability } from './patterns'
import { atr } from './indicators'
import type { AnalysisResult } from '../types'
import { classifyRegime } from './regime'

export const ORACLE_MIN_CANDLES = 320 // markov(lookback 300) + warmup for the rest
/** Evaluation window cap for consumers that re-evaluate bar-by-bar (the
 * oracle-fusion strategy, the global scanner): every model inside reads at
 * most ~300 bars of history, so a 520-bar tail is bit-identical input to the
 * full series and keeps per-eval cost constant no matter how deep the feed. */
export const ORACLE_EVAL_WINDOW = 520
const MC_SIMS = 1200
const MC_HORIZON = 1

export type OracleRegime = 'TRENDING' | 'RANGING' | 'VOLATILE' | 'MIXED'

export interface OracleDriver {
  name: string
  /** the model's own read of P(next close > current close) */
  pUp: number
  /** weight used in the fusion (post-regime adjustment) */
  weight: number
  /** signed -1..+1 convenience read for the UI */
  vote: number
  /** one-line human explanation of what the model sees */
  detail: string
}

export interface NextCandlePrediction {
  asset: string
  tf: string
  ts: number
  /** bar-open timestamp the prediction targets (current forming bar's open) */
  targetBarTime: number
  price: number
  /** fused probability the next candle closes above the current close */
  pUp: number
  direction: 'call' | 'put' | 'none'
  /** 0..100 - agreement + distance from coin-flip, discounted by live calibration */
  confidence: number
  /** raw confidence before the calibration discount (panel shows both) */
  rawConfidence: number
  regime: OracleRegime
  /** expected absolute move of the next candle, price units */
  expectedMove: number
  /** ATR(14) of the series - the cone's natural denominator */
  atr: number
  /** expected next-candle range cone (price units) */
  range: { low: number; high: number }
  /** expected body vs range ratio 0..1 */
  bodyRatio: number
  /** expected close position within the range 0..1 (wick asymmetry read) */
  closePos: number
  /** plain-language label for the kind of candle shape this geometry
   * (bodyRatio + closePos + direction) implies - e.g. a wide body with a
   * close pinned near the extreme reads as a marubozu-like strong candle;
   * a thin body near the middle reads as a doji/indecision bar. Derived
   * purely from the estimates above, not a new model - see
   * classifyExpectedCandleType(). */
  expectedCandleType: string
  drivers: OracleDriver[]
  /** how many drivers were actually usable (had enough history) */
  driversActive: number
  /** which candle patterns actually fired this read (name + direction only,
   * capped to the strongest/most recent 6) - lets the plugin resolve each
   * one against the real next-candle outcome and learn its own live
   * reliability (see patterns.ts's provider bridge). Empty when the
   * "Candle patterns" driver found nothing this bar. */
  patternHits: { name: string; direction: 'bullish' | 'bearish' | 'neutral' }[]
  /** live self-calibration, injected by the plugin's honesty loop (null = no record yet) */
  calibration: { n: number; hitRate: number; brier: number } | null
  mode: 'sim' | 'live'
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1))
}

/** pUp of a single model from a signed score in [-1, 1] */
function pUpFromScore(score: number): number {
  return clamp(0.5 + 0.5 * clamp(score, -1, 1), 0.01, 0.99)
}

/** log-odds weighted fusion of pUp values */
function fuseOdds(entries: { pUp: number; weight: number }[]): number {
  const totalW = entries.reduce((a, e) => a + e.weight, 0)
  if (totalW <= 0) return 0.5
  let logit = 0
  for (const e of entries) {
    const p = clamp(e.pUp, 0.01, 0.99)
    logit += (e.weight / totalW) * Math.log(p / (1 - p))
  }
  return clamp(1 / (1 + Math.exp(-logit)), 0.01, 0.99)
}

/** map the composite engine score (-100..100) to pUp with a soft sigmoid */
function pUpFromEngineScore(score: number): number {
  const x = clamp(score / 45, -3, 3)
  return clamp(1 / (1 + Math.exp(-x)), 0.05, 0.95)
}

export interface OracleInput {
  asset: string
  tf: string
  mode: 'sim' | 'live'
  /** live self-calibration record from the plugin (null when no resolved
   * predictions yet) - used as the fallback when no regime-specific record
   * below is thick enough yet, and as the only record when the plugin
   * hasn't adopted regime-split tracking. */
  calibration?: { n: number; hitRate: number; brier: number } | null
  /** Same shape as `calibration`, but one record per OracleRegime - the
   * plugin's honesty loop can track "how honest am I specifically when I
   * call this a TRENDING bar" separately from RANGING/VOLATILE/MIXED,
   * since a model well-calibrated in one regime can be overconfident in
   * another. Looked up by this prediction's OWN computed regime; falls
   * back to `calibration` when that regime's bucket is missing or thin. */
  regimeCalibration?: Partial<Record<OracleRegime, { n: number; hitRate: number; brier: number } | null>>
  /** Same shape as `calibration`, this time the plugin's own bucket for
   * the CURRENT trading session (classifySession - ASIA/LONDON/OVERLAP/
   * NEWYORK/OFF/OTC) already resolved and selected before calling in -
   * this engine just takes whatever single bucket the caller decided
   * applies right now. Checked after regime (the stronger split) and
   * before the direction fallback: a pair can be honestly calibrated
   * overall yet systematically off during the thin OFF hours or the
   * London/NY OVERLAP specifically. */
  sessionCalibration?: { n: number; hitRate: number; brier: number } | null
  /** Same shape as `calibration` again, this time split by the PREDICTED
   * DIRECTION ('call'/'put') rather than regime - an oracle can be quietly
   * worse at calling puts than calls on a given pair, an asymmetry the
   * regime-blended and direction-blended records both hide. Used only as
   * a fallback when regimeCalibration's own bucket for this read's regime
   * is missing or thin - regime is the more specific signal when both are
   * available; this fills the gap when it isn't. */
  directionCalibration?: Partial<Record<'call' | 'put', { n: number; hitRate: number; brier: number } | null>>
  /** Per-driver weight multipliers, keyed by OracleDriver.name - the
   * plugin's honesty loop tracks each model's own resolved accuracy and
   * feeds a multiplier back (>1 = this driver has been reliably right
   * lately, <1 = reliably wrong), on top of the static regime boosts each
   * driver already gets below. Missing/omitted name = multiplier 1
   * (unchanged), so existing callers that don't pass this are unaffected.
   * This is the BLENDED-across-regimes table - used as the fallback when
   * `regimeDriverWeightMultipliers` below has no bucket for this read's
   * own regime yet. */
  driverWeightMultipliers?: Partial<Record<string, number>>
  /** Same per-driver multiplier table, split one bucket per OracleRegime -
   * a driver can be reliable in TRENDING and noise in RANGING; this is the
   * more specific record predictNextCandle prefers once its own regime is
   * known (which happens BEFORE the drivers loop runs, so there's no
   * chicken-egg problem applying it here, unlike calibration). Falls back
   * to `driverWeightMultipliers` when this regime's bucket is missing. */
  regimeDriverWeightMultipliers?: Partial<Record<OracleRegime, Partial<Record<string, number>>>>
  /** THIS PAIR'S OWN per-driver weight multiplier - same win-rate-based
   * table as `driverWeightMultipliers` above, computed from only this
   * asset:tf's own resolved history instead of the whole universe's. A
   * pair's "physiology" can make one model reliably sharper on it and
   * another reliably noisy, which the universe-blended table can't see.
   * Takes priority over everything else in this cascade once this pair
   * has enough of its own resolved history (plugins/nextcandle.ts's
   * "thin record is no record" floor, necessarily smaller than the
   * universe-wide one since one pair sees far fewer resolutions) -
   * missing/omitted name falls through to `pairRegimeDriverWeightMultipliers`
   * then the universe-wide tables above, same cascade shape as calibration
   * already uses (regime -> session -> direction -> blended). */
  pairDriverWeightMultipliers?: Partial<Record<string, number>>
  /** Same per-pair table as `pairDriverWeightMultipliers`, split one
   * bucket per OracleRegime - this pair's own driver physiology can itself
   * differ by regime (e.g. reliably trend-following in TRENDING, noisy in
   * RANGING). The most specific bucket in the whole cascade: checked
   * first, before the pair-blended table, which is checked before the
   * universe-wide regime/blended tables. */
  pairRegimeDriverWeightMultipliers?: Partial<Record<OracleRegime, Partial<Record<string, number>>>>
  /** Per-driver CALIBRATION-quality multiplier, keyed by OracleDriver.name -
   * a second, independent axis from driverWeightMultipliers above. That
   * one rewards a driver for being directionally RIGHT (win rate); this
   * one rewards a driver for being honest about its OWN uncertainty (low
   * resolved Brier) rather than just lucky on sign - a driver that's
   * right 55% of the time while confidently predicting 90% every time is
   * directionally fine but badly miscalibrated, and win-rate alone can't
   * see that. 1 = unchanged; clamped to [0.8, 1.2] inside predictNextCandle
   * regardless of what's passed, so this can only ever nudge, not replace,
   * the win-rate multiplier above. */
  driverCalibrationMultipliers?: Partial<Record<string, number>>
  /** THIS PAIR'S OWN per-driver calibration-quality multiplier - same
   * Brier-based table as `driverCalibrationMultipliers` above, computed
   * from only this asset:tf's own resolved history. Takes priority over
   * the universe-wide table once this pair has enough of its own
   * resolved history; falls through to it otherwise. */
  pairDriverCalibrationMultipliers?: Partial<Record<string, number>>
  /** CLUSTER-level (asset-category, e.g. "forex" or "crypto:otc") driver
   * weight multiplier table - an intermediate fallback tier between this
   * pair's own thin history and the full universe-wide blend. A pair with
   * too little of its own resolved history to trust `pairDriverWeightMultipliers`
   * can still often be reasonably described by "how does this whole asset
   * class behave", which accumulates history far faster than any one pair.
   * Checked after the pair-blended table and before the universe-wide
   * regime table in the cascade. */
  clusterDriverWeightMultipliers?: Partial<Record<string, number>>
  /** Same cluster-level table as `clusterDriverWeightMultipliers`, split
   * one bucket per OracleRegime - checked after the pair-regime table and
   * before the pair-blended table. */
  clusterRegimeDriverWeightMultipliers?: Partial<Record<OracleRegime, Partial<Record<string, number>>>>
  /** CLUSTER-level per-driver calibration-quality multiplier - same
   * Brier-based shape as `driverCalibrationMultipliers`, scoped to this
   * pair's asset category instead of one pair or the whole universe.
   * Checked between the pair-level and universe-level calibration
   * tables. */
  clusterDriverCalibrationMultipliers?: Partial<Record<string, number>>
  /** Learned pairwise driver correlation discount, keyed by a stable
   * "NameA|NameB" string (alphabetical, built by pairKey() below) - how
   * much to discount the SECOND-listed driver's weight when both members
   * of a pair agree on direction. Generalizes the old hand-picked
   * CORRELATED_DRIVER_GROUPS: that list is still the DEFAULT prior for the
   * one pair it names, but any pair the honesty loop has enough resolved
   * history on (agreeing meaningfully more than chance) gets its own
   * learned discount instead, hand-picked or not. Missing/omitted pair =
   * no discount (1) unless the hand-set default applies. */
  driverCorrelation?: Partial<Record<string, number>>
  /** THIS PAIR'S OWN learned pairwise driver correlation discount - same
   * shape and key convention as `driverCorrelation` above, computed from
   * only this asset:tf's own resolved co-occurrences. Which models double
   * up on the same evidence can plausibly differ by instrument (a
   * trending forex major vs. a mean-reverting OTC synthetic), so this
   * takes priority over the universe-wide table once this pair has
   * enough of its own resolved history; falls through to it otherwise. */
  pairDriverCorrelation?: Partial<Record<string, number>>
  /** CLUSTER-level learned pairwise driver correlation discount - same key
   * convention as `driverCorrelation`/`pairDriverCorrelation`, scoped to
   * this pair's asset category. Checked between the pair-level and
   * universe-level correlation tables. */
  clusterDriverCorrelation?: Partial<Record<string, number>>
  /** Learned replacement for the flat 0.55/0.45 agreement/distance blend
   * that produces rawConfidence - the smallest-error candidate, among a
   * small sweep, at predicting the resolved ledger's own realized hit
   * rate. null = still using the flat 0.55 agreement weight. */
  confidenceBlendWeight?: number | null
  /** THIS PAIR'S OWN learned replacement for confidenceBlendWeight, computed
   * from only this asset:tf's own resolved ledger. Takes priority over the
   * universe-wide confidenceBlendWeight once this pair has enough of its
   * own resolved history; falls through to it (then the flat 0.55 default)
   * otherwise. */
  pairConfidenceBlendWeight?: number | null
  /** THIS PAIR'S OWN learned per-pattern reliability table - same shape as
   * patterns.ts's learnedPatternReliability(), filtered to only this
   * asset:tf's own resolved pattern-hit history. Does this pattern actually
   * call the next candle on THIS pair specifically, vs. the universe-wide
   * table. Merged on top of the universe-wide table (not a wholesale
   * replacement) so patterns absent from the thinner per-pair table still
   * fall back to the universe-wide learned value rather than the hand-set
   * default. */
  pairPatternReliability?: Partial<Record<string, number>>
  /** Learned ratio of REALIZED candle move to this engine's own predicted
   * `expectedMove`, for this exact asset:tf - the one estimate in this
   * whole fusion that was never checked against reality until now. 1 =
   * unchanged (today's behavior); >1 widens the forecast cone (this pair's
   * candles realize bigger moves than predicted), <1 narrows it. Clamped
   * defensively inside predictNextCandle regardless of what's passed. */
  magnitudeCalibration?: number | null
  /** Monte Carlo bootstrap paths. Default 1200 (panel-grade); the bar-by-bar
   * strategy eval passes fewer for backtest speed - the fused read is stable
   * well below the default (binomial noise on pUp ~ 1/sqrt(n)). */
  mcSims?: number
  /** Include the chart-engine committee (renko/pnf/range/tick/footprint/heikin
   * vote). Default on; the backtester can drop it (the heaviest driver) when
   * sweeping gate params. */
  includeCommittee?: boolean
}

/** Correlated driver groups: members read substantially the same underlying
 * evidence (raw bar shape), so when they AGREE it isn't two independent
 * confirmations, it's partially the same evidence counted twice. This is
 * now only the DEFAULT prior for the one pair hand-picked at design time -
 * see `driverCorrelation` on OracleInput and pairKey() below for the
 * learned, general replacement that covers any pair, not just this one. */
const CORRELATED_DRIVER_GROUPS: string[][] = [
  ['Candle patterns', 'Bar physics'],
  // driver #5 (chart-engine committee) already folds the renko/footprint
  // votes into its combined score - #8/#9 expose those SAME reads as
  // their own standalone models (see module header), so when they agree
  // with the committee it's the same evidence, not a second confirmation.
  ['Chart engines', 'Renko bricks'],
  ['Chart engines', 'Footprint'],
]
const CORRELATION_DISCOUNT = 0.65

/** Stable, order-independent key for a driver pair - how plugins/
 * nextcandle.ts's learned driverCorrelation table is keyed, so a caller
 * never has to guess which of the two names comes first. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function handSetDiscount(a: string, b: string): number | null {
  for (const group of CORRELATED_DRIVER_GROUPS) {
    if (group.includes(a) && group.includes(b)) return CORRELATION_DISCOUNT
  }
  return null
}

/** Discount the weight of whichever driver in an agreeing, correlated pair
 * is listed SECOND when both members agree on direction - only ever
 * tightens (reduces double-counted weight), never loosens. Checks the
 * LEARNED table first (any pair with enough resolved history), falling
 * back to the hand-set default for the one pair that was ever manually
 * flagged; a pair with neither gets no discount at all. */
function decorrelateWeights(usable: OracleDriver[], learnedCorrelation?: Partial<Record<string, number>> | null): OracleDriver[] {
  const out = usable.map((d) => ({ ...d }))
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i]
      const b = out[j]
      const learned = learnedCorrelation?.[pairKey(a.name, b.name)]
      const discount = Number.isFinite(learned) && learned! > 0 && learned! < 1 ? learned! : handSetDiscount(a.name, b.name)
      if (discount === null) continue
      const aSign = Math.sign(a.vote || a.pUp - 0.5)
      const bSign = Math.sign(b.vote || b.pUp - 0.5)
      if (aSign !== 0 && aSign === bSign) b.weight *= discount
    }
  }
  return out
}

export function predictNextCandle(candles: Candle[], input: OracleInput): NextCandlePrediction | null {
  if (candles.length < ORACLE_MIN_CANDLES) return null
  // closed candles only - last bar is the latest CLOSED bar, the target is the bar after it
  const closed = candles[candles.length - 1]
  const closes = candles.map((c) => c.close)
  const price = closed.close
  const targetBarTime = closed.time + (candles[candles.length - 1].time - candles[candles.length - 2].time || 60)

  // ---------- shared context ----------
  const atrSeries = atr(candles.map((c) => c.high), candles.map((c) => c.low), closes, 14)
  const atrVal = atrSeries[atrSeries.length - 1] || 0
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]))
  const recent = rets.slice(-300)

  const analysisStub = {
    indicators: { adx: 0 },
    quant: { hurst: 0.5, garchVol: 0, ewmaVol: 0 },
  } as unknown as AnalysisResult
  // regime via the kernel's own classifier on a lightweight analysis read
  const markov: MarkovResult = markovChain(closes, { lookback: 300 })
  const adxProxy = trendinessProxy(candles)
  const garch = garchVol(recent)
  const ewma = ewmaVol(recent)
  const regime: OracleRegime = classifyRegime({
    indicators: { adx: adxProxy },
    quant: { hurst: hurstProxy(closes), garchVol: garch, ewmaVol: ewma },
  } as unknown as AnalysisResult)

  // regime weight adjustments - see header note
  const trendBoost = regime === 'TRENDING' ? 1.35 : regime === 'RANGING' ? 0.7 : 1
  const fadeBoost = regime === 'RANGING' ? 1.5 : regime === 'TRENDING' ? 0.6 : 1
  const chaosFlatten = regime === 'VOLATILE' ? 0.6 : 1

  const drivers: OracleDriver[] = []
  let patternHitsSnapshot: { name: string; direction: 'bullish' | 'bearish' | 'neutral' }[] = []

  // ---------- 1. Markov transition matrix ----------
  {
    const trendy = markov.trendiness // persistence 0..1
    const w = 14 * (0.75 + 0.5 * trendy) * trendBoost * chaosFlatten
    drivers.push({
      name: 'Markov transitions',
      pUp: clamp(markov.probUp, 0.02, 0.98),
      weight: w,
      vote: (markov.probUp - 0.5) * 2,
      detail: `P(up) ${((markov.probUp) * 100).toFixed(0)}% from state "${markov.states[markov.lastState]}", trendiness ${(trendy * 100).toFixed(0)}%, regime ${markov.regime}`,
    })
  }

  // ---------- 2. Monte Carlo bootstrap ----------
  {
    const sims = clamp(Math.round(input.mcSims ?? MC_SIMS), 100, 4000)
    const mc = monteCarlo(closes, { nSims: sims, horizon: MC_HORIZON, mode: 'bootstrap', seed: (Date.now() ^ candles.length) % 2147483647, samplePaths: 0 })
    const w = 10 * trendBoost * chaosFlatten
    drivers.push({
      name: 'Monte Carlo (bootstrap)',
      pUp: clamp(mc.probUp, 0.02, 0.98),
      weight: w,
      vote: (mc.probUp - 0.5) * 2,
      detail: `${mc.nSims} resampled paths: ${(mc.probUp * 100).toFixed(0)}% end above spot; E[r] ${(mc.expectedReturn * 100).toFixed(3)}%`,
    })
  }

  // ---------- 3. Kalman/OU drift + stretch ----------
  {
    const ou = ouState(closes, 240)
    // drift read: OU mean drift toward theta over one bar, scaled by sigma
    const drift = ou.kappa !== 0 ? clamp((ou.theta - price) / (ou.sigmaEq || 1e-9) * Math.min(ou.kappa, 0.5), -1, 1) : 0
    // fade read: stretched above mean -> expect pull down (weight boosted in RANGING)
    const stretch = clamp(-ou.z / 2.5, -1, 1) // +1 = far below mean -> pull UP
    const blended = clamp(0.6 * drift + 0.4 * stretch, -1, 1)
    const w = 10 * fadeBoost * chaosFlatten * (ou.meanReverting ? 1.2 : 0.8)
    drivers.push({
      name: 'Kalman/OU',
      pUp: pUpFromScore(blended),
      weight: w,
      vote: blended,
      detail: `z-stretch ${ou.z.toFixed(2)} (${ou.state}), half-life ${ou.halfLifeBars.toFixed(0)} bars, ${ou.meanReverting ? 'mean-reverting' : 'not mean-reverting'}`,
    })
  }

  // ---------- 4. Composite confluence engine (14 factors) ----------
  {
    const sig = confluenceSignalOnly(candles, input.asset, input.tf as never)
    const w = 13 * trendBoost * chaosFlatten
    drivers.push({
      name: 'Confluence engine',
      pUp: pUpFromEngineScore(sig.score),
      weight: w,
      vote: clamp(sig.score / 100, -1, 1),
      detail: `composite ${sig.score.toFixed(0)}/100, ${sig.factors.length} factors, confidence ${sig.confidence.toFixed(0)}%`,
    })
  }

  // ---------- 5. Chart-engine committee ----------
  {
    const votes = input.includeCommittee === false ? [] : engineVotes(candles, { otc: false, realTicks: null, otcRead: null })
    const comb = combineVotes(votes, { threshold: 30, minAgree: 2 })
    if (comb) {
      // combineVotes' score is ALREADY signed (-100..100, negative = put) -
      // the earlier `direction === 'call' ? score : -score` double-negated
      // put reads and made a unanimous-put committee vote max-bullish
      const signed = comb.score
      const w = 9 * trendBoost * chaosFlatten
      drivers.push({
        name: 'Chart engines',
        pUp: pUpFromScore(clamp(signed / 60, -1, 1)),
        weight: w,
        vote: clamp(signed / 60, -1, 1),
        detail: `${comb.agree}/${comb.total} engine families agree ${comb.direction}, score ${comb.score.toFixed(0)}`,
      })
    }
  }

  // ---------- 6. Candle patterns ----------
  {
    const hits = detectPatterns(candles, 8)
    const bias = patternBias(
      hits,
      input.pairPatternReliability
        ? ({ ...(learnedPatternReliability() ?? {}), ...input.pairPatternReliability } as Record<string, number>)
        : undefined
    ) // signed, roughly -2..2 (uses this pair's own learned per-pattern
    // reliability table, merged on top of the universe-wide learned table,
    // when enough of this pair's own resolved history exists - otherwise
    // falls back to the universe-wide table via patterns.ts's provider
    // bridge - so this driver's own bias already reflects "does
    // this pattern actually call the next candle on this universe", not
    // just the hand-set reliability score)
    if (hits.length > 0) {
      const w = 6 * chaosFlatten
      drivers.push({
        name: 'Candle patterns',
        pUp: pUpFromScore(clamp(bias / 2, -1, 1)),
        weight: w,
        vote: clamp(bias / 2, -1, 1),
        detail: `${hits.length} recent patterns, net bias ${bias.toFixed(1)}`,
      })
      // snapshot for the honesty loop: which patterns actually fired, so
      // the plugin can resolve EACH ONE against the real next-candle
      // direction and learn its own live reliability (see patterns.ts).
      // Capped to the 6 strongest/most-recent hits - detectPatterns already
      // sorts that way - to keep the resolved record small.
      patternHitsSnapshot = hits.slice(0, 6).map((h) => ({ name: h.name, direction: h.direction }))
    }
  }

  // ---------- 7. Bar physics (CLV + body pressure + streak) ----------
  {
    const last5 = candles.slice(-5)
    const clv = mean(last5.map((c) => {
      const r = c.high - c.low
      return r > 0 ? ((c.close - c.low) / r - 0.5) * 2 : 0
    }))
    const bodies = last5.map((c) => {
      const r = c.high - c.low
      return r > 0 ? (c.close - c.open) / r : 0
    })
    const bodyPressure = clamp(mean(bodies) * 2, -1, 1)
    // streak: consecutive same-direction closes (continuation in trending regimes)
    let streak = 0
    for (let i = candles.length - 1; i > 0; i--) {
      const d = Math.sign(candles[i].close - candles[i - 1].close)
      if (d === 0) break
      if (streak === 0 || Math.sign(streak) === d) streak += d
      else break
    }
    const streakRead = clamp((streak / 4) * (regime === 'TRENDING' ? 1 : -0.5), -1, 1)
    const read = clamp(0.45 * clv + 0.35 * bodyPressure + 0.2 * streakRead, -1, 1)
    const w = 7 * (regime === 'TRENDING' ? 1.2 : 1) * chaosFlatten
    drivers.push({
      name: 'Bar physics',
      pUp: pUpFromScore(read),
      weight: w,
      vote: read,
      detail: `CLV ${clv.toFixed(2)}, body ${bodyPressure.toFixed(2)}, streak ${streak} (${streak >= 0 ? 'up' : 'down'})`,
    })
  }

  // ---------- 8. Renko bricks (standalone, not confluence) ----------
  {
    const rv = engineVoteSingle('renko', candles)
    if (rv.dir !== 0) {
      const w = 8 * trendBoost * chaosFlatten
      const signed = clamp(rv.dir * rv.weight, -1, 1)
      drivers.push({
        name: 'Renko bricks',
        pUp: pUpFromScore(signed),
        weight: w,
        vote: signed,
        detail: rv.note,
      })
    }
  }

  // ---------- 9. Footprint (order-flow delta/absorption) ----------
  {
    const fv = engineVoteSingle('footprint', candles)
    if (fv.dir !== 0) {
      const w = 7 * chaosFlatten
      const signed = clamp(fv.dir * fv.weight, -1, 1)
      drivers.push({
        name: 'Footprint',
        pUp: pUpFromScore(signed),
        weight: w,
        vote: signed,
        detail: fv.note,
      })
    }
  }

  // per-driver adaptive weighting: the plugin's honesty loop tracks each
  // model's own resolved accuracy and feeds a multiplier back here, on top
  // of the static regime boosts above - a driver that's been reliably
  // wrong lately gets downweighted automatically instead of only ever being
  // tuned by hand via trendBoost/fadeBoost/chaosFlatten. Per driver, prefers
  // THIS PAIR'S OWN regime-specific table (its physiology can itself differ
  // by regime), then this pair's own blended table, then the UNIVERSE's
  // regime-specific table (`regime` is already known at this point - no
  // chicken-egg problem the way calibration below has), then the
  // universe's blended table - same cascade shape calibration already
  // uses (regime -> session -> direction -> blended), just one level more
  // specific at the top for a pair with enough of its own resolved history.
  // Cascade is now 5 tiers, most to least specific: pair-regime ->
  // pair-blended -> cluster-regime -> cluster-blended -> universe-regime ->
  // universe-blended. `pick5` checks each in that order and takes the
  // first finite, positive value it finds.
  const pick5 = (name: string, tiers: (Partial<Record<string, number>> | undefined)[]): number | undefined => {
    for (const t of tiers) {
      const v = t?.[name]
      if (Number.isFinite(v) && (v as number) > 0) return v as number
    }
    return undefined
  }
  const pairRegimeDwm = input.pairRegimeDriverWeightMultipliers?.[regime]
  const clusterRegimeDwm = input.clusterRegimeDriverWeightMultipliers?.[regime]
  const universeRegimeDwm = input.regimeDriverWeightMultipliers?.[regime]
  if (
    pairRegimeDwm || input.pairDriverWeightMultipliers || clusterRegimeDwm || input.clusterDriverWeightMultipliers ||
    universeRegimeDwm || input.driverWeightMultipliers || input.pairDriverCalibrationMultipliers ||
    input.clusterDriverCalibrationMultipliers || input.driverCalibrationMultipliers
  ) {
    for (const d of drivers) {
      const m = pick5(d.name, [pairRegimeDwm, input.pairDriverWeightMultipliers, clusterRegimeDwm, input.clusterDriverWeightMultipliers, universeRegimeDwm, input.driverWeightMultipliers])
      if (m !== undefined) d.weight *= clamp(m, 0.6, 1.5)
      // calibration-quality axis, independent of the win-rate multiplier
      // above - rewards a driver for being honest about its own
      // uncertainty (low resolved Brier), not just lucky on sign. No
      // regime split for this axis (same as the universe-wide version),
      // just pair-first, then cluster, then universe.
      const c = pick5(d.name, [input.pairDriverCalibrationMultipliers, input.clusterDriverCalibrationMultipliers, input.driverCalibrationMultipliers])
      if (c !== undefined) d.weight *= clamp(c, 0.8, 1.2)
    }
  }

  // Driver correlation, per-PAIR-OF-DRIVERS: this pair's own learned
  // discount for a given driver pair takes priority over the universe-wide
  // one, independently for each pair of drivers - a merged table built
  // once per call rather than threading two lookups through
  // decorrelateWeights() itself.
  const mergedCorrelation: Partial<Record<string, number>> | undefined =
    input.pairDriverCorrelation || input.clusterDriverCorrelation || input.driverCorrelation
      ? { ...(input.driverCorrelation ?? {}), ...(input.clusterDriverCorrelation ?? {}), ...(input.pairDriverCorrelation ?? {}) }
      : undefined
  const usable = decorrelateWeights(
    drivers.filter((d) => Number.isFinite(d.pUp) && Number.isFinite(d.weight) && d.weight > 0),
    mergedCorrelation,
  )
  // Up to 9 drivers can fire now (Renko bricks/Footprint, #8-9, are
  // conditional on having a nonzero vote, same as Chart engines #5);
  // requiring 5+ (a majority of 9) rather than the old 4-of-7 bar keeps the
  // same "closes the small-sample overconfidence hole" intent as the
  // original comment - a thin read used to score confidence identically
  // to a full-roster one as long as the few available agreed, which
  // overstates how much evidence actually backs it.
  if (usable.length < 5) return null // not enough working models - refuse rather than guess

  const pUp = fuseOdds(usable.map((d) => ({ pUp: d.pUp, weight: d.weight })))

  // agreement: share of total weight sitting on the winning side
  const winSide = pUp >= 0.5 ? 1 : -1
  const agreeW = usable.reduce((s, d) => s + (Math.sign(d.vote || (d.pUp - 0.5)) === winSide ? d.weight : 0), 0)
  const totalW = usable.reduce((s, d) => s + d.weight, 0)
  const agreement = totalW > 0 ? agreeW / totalW : 0.5
  const distance = Math.abs(pUp - 0.5) * 2 // 0..1
  // sample-size dampener: 7 is the full driver roster: a 4/7 read is
  // dampened toward coin-flip confidence even when the 4 that fired agree
  // completely, a 7/7 read gets none - the fused pUp itself is unaffected
  // (direction never changes), only how much the number is allowed to say.
  const sampleFactor = clamp(0.72 + 0.28 * (usable.length / drivers.length), 0.72, 1)
  // learned agreement/distance blend: the smallest-error candidate (vs the
  // resolved ledger's own realized hit rate) replaces the flat hand-set
  // 0.55/0.45 split once there's enough history to pick one; null (thin
  // history) keeps today's 0.55 agreement weight exactly as it was.
  const pairBlendOk = Number.isFinite(input.pairConfidenceBlendWeight) && (input.pairConfidenceBlendWeight as number) >= 0 && (input.pairConfidenceBlendWeight as number) <= 1
  const universeBlendOk = Number.isFinite(input.confidenceBlendWeight) && (input.confidenceBlendWeight as number) >= 0 && (input.confidenceBlendWeight as number) <= 1
  const agreeWeight = pairBlendOk ? (input.pairConfidenceBlendWeight as number) : universeBlendOk ? (input.confidenceBlendWeight as number) : 0.55
  const rawConfidence = clamp((agreeWeight * agreement + (1 - agreeWeight) * distance) * 100 * sampleFactor, 0, 97)

  // calibration discount: the oracle's own realized record tempers the
  // read. Preference order, most specific first: (1) REGIME-SPECIFIC
  // record - a model well calibrated in TRENDING can be overconfident in
  // VOLATILE, blending them hides that; (2) DIRECTION-SPECIFIC record
  // (predictedDirSign below, derivable now since pUp is already fused) -
  // an oracle can be quietly worse at calling puts than calls on a pair,
  // an asymmetry the regime-blended record also hides; (3) the plain
  // blended-across-everything record. Each tier only used once it clears
  // its own n>=20 "thin record is no record" floor.
  const predictedDirSign: 'call' | 'put' = pUp >= 0.5 ? 'call' : 'put'
  const regimeCal = input.regimeCalibration?.[regime] ?? null
  const sessionCal = input.sessionCalibration ?? null
  const dirCal = input.directionCalibration?.[predictedDirSign] ?? null
  const cal =
    regimeCal && regimeCal.n >= 20
      ? regimeCal
      : sessionCal && sessionCal.n >= 20
        ? sessionCal
        : dirCal && dirCal.n >= 20
          ? dirCal
          : input.calibration ?? null
  const confidence = applyCalibrationDiscount(rawConfidence, cal)

  // ---------- magnitude: EWMA vol + markov next-state emphasis, ATR-anchored ----------
  const nextStateMean = markovStateMeanReturn(markov)
  const vol = ewma > 0 ? ewma : stdev(recent) || 1e-9
  const atrSafe = atrVal > 0 ? atrVal : Math.max(price * vol * 2, 1e-9)
  // 1-bar close-to-close move is on the order of one ATR; the Markov
  // next-state distribution stretches it when a big move state dominates
  const markovBoost = clamp(0.7 + (Math.abs(nextStateMean) / vol) * 0.35, 0.7, 1.8)
  // magnitude calibration: the one estimate in this whole fusion nothing
  // ever checked against reality until now - this engine's own self-
  // calibration loop only ever checked DIRECTION (hit rate, Brier). A
  // learned realized/predicted move ratio for this exact pair widens or
  // narrows the cone to match how big its candles actually move, clamped
  // defensively either way so a thin or noisy record can't blow the cone
  // out - and the clamp band below is widened symmetrically to give the
  // calibration real room to work instead of immediately re-clamping it away.
  const magCal = input.magnitudeCalibration && Number.isFinite(input.magnitudeCalibration) && input.magnitudeCalibration > 0 ? clamp(input.magnitudeCalibration, 0.5, 2) : 1
  const expAbs = clamp(price * vol * markovBoost * magCal, 0.2 * atrSafe, 2.2 * atrSafe)
  const dirSign = pUp >= 0.5 ? 1 : -1

  // range cone: typical range/body ratio of the last 40 bars
  let rangeAcc = 0
  let bodyAcc = 0
  for (const c of candles.slice(-40)) {
    rangeAcc += c.high - c.low
    bodyAcc += Math.abs(c.close - c.open)
  }
  const avgRange = rangeAcc / 40 || atrVal || 1e-9
  const avgBody = bodyAcc / 40 || 1e-9
  const bodyRatio = clamp(avgBody / avgRange, 0.05, 0.95)
  const closePosRaw = clamp(0.5 + (dirSign * distance) / 2, 0.05, 0.95)

  // direction deadband: wider in VOLATILE (every driver is noisier there,
  // chaosFlatten already says so for the weights - the direction call
  // should demand more separation from the coin flip to match), unchanged
  // elsewhere. A 0.56/0.44 call on a VOLATILE bar used to get exactly the
  // same confidence treatment as one on a clean TRENDING bar.
  const deadband = regime === 'VOLATILE' ? 0.09 : 0.06
  const direction: 'call' | 'put' | 'none' = pUp >= 0.5 + deadband ? 'call' : pUp <= 0.5 - deadband ? 'put' : 'none'

  return {
    asset: input.asset,
    tf: input.tf,
    ts: Date.now(),
    targetBarTime,
    price,
    pUp,
    direction,
    confidence,
    rawConfidence,
    regime,
    expectedMove: expAbs,
    atr: atrVal,
    range: {
      low: price - expAbs * (1 + (1 - bodyRatio)),
      high: price + expAbs * (1 + (1 - bodyRatio)),
    },
    bodyRatio,
    closePos: closePosRaw,
    expectedCandleType: classifyExpectedCandleType(bodyRatio, closePosRaw, direction),
    drivers: usable,
    driversActive: usable.length,
    patternHits: patternHitsSnapshot,
    calibration: cal,
    mode: input.mode,
  }
}

/** The honesty-loop discount, factored out so consumers that cache the RAW
 * fused read (the oracle-fusion strategy memoizes per bar) can apply the
 * LIVE calibration at eval time without recomputing the models. Same math
 * predictNextCandle itself uses: a record below ~52% hit rate discounts up
 * to 35%, above 60% boosts up to 10%; Brier vs the 0.25 coin baseline
 * moves it a further ±10-15%. Needs n >= 20 resolved predictions - a thin
 * record is no record. */
export function applyCalibrationDiscount(rawConfidence: number, cal: { n: number; hitRate: number; brier: number } | null | undefined): number {
  if (!cal || cal.n < 20) return clamp(rawConfidence, 1, 97)
  const hitEdge = clamp((cal.hitRate - 0.52) / 0.2, -0.35, 0.1)
  const brierEdge = clamp((0.25 - cal.brier) * 2, -0.15, 0.1)
  return clamp(rawConfidence * (1 + hitEdge + brierEdge), 1, 97)
}

// ---------- live calibration bridge ----------
// plugins/nextcandle.ts registers its per-asset:tf honesty record here at
// boot. The oracle-fusion strategy reads it so LIVE bot evals get the same
// confidence discount the oracle panel shows. Module-level on purpose:
// strategy evaluate() is pure/sync with no kernel context - this read-only
// lookup is the one leg of permitted outside state. A backtest run on a
// kernel with a live record WILL see it (an honest, conservative prior from
// the same engine on the same feed); a strategy can opt out via its
// useCalibration param.
export type OracleCalibrationProvider = (asset: string, tf: string) => { n: number; hitRate: number; brier: number } | null
let oracleCalibrationProvider: OracleCalibrationProvider | null = null
export function setOracleCalibrationProvider(p: OracleCalibrationProvider | null): void {
  oracleCalibrationProvider = p
}
export function oracleCalibrationFor(asset: string, tf: string): { n: number; hitRate: number; brier: number } | null {
  return oracleCalibrationProvider ? oracleCalibrationProvider(asset, tf) : null
}

/** Plain-language label for the kind of candle shape the fused geometry
 * (body-vs-range ratio, close position within the range, direction)
 * implies - not a new model, just naming what the already-computed
 * estimates amount to: a wide body with the close pinned near the
 * extreme reads as a strong/marubozu-like candle, a thin body near the
 * middle reads as a doji/indecision bar, and the in-between cases read as
 * an ordinary directional candle with some wick. */
function classifyExpectedCandleType(bodyRatio: number, closePos: number, direction: 'call' | 'put' | 'none'): string {
  if (direction === 'none') {
    return bodyRatio < 0.3 ? 'doji / indecision candle (no clear direction)' : 'choppy candle, no clear direction despite some body'
  }
  const bullish = direction === 'call'
  const extremeClose = bullish ? closePos >= 0.78 : closePos <= 0.22
  if (bodyRatio < 0.25) {
    return `small-bodied ${bullish ? 'bullish' : 'bearish'} spinning-top / near-doji (weak conviction)`
  }
  if (bodyRatio >= 0.65 && extremeClose) {
    return `strong ${bullish ? 'bullish' : 'bearish'} marubozu-like candle (wide body, little opposing wick)`
  }
  if (bodyRatio >= 0.65) {
    return `solid ${bullish ? 'bullish' : 'bearish'} candle with a modest ${bullish ? 'upper' : 'lower'} wick`
  }
  const wickSide = bullish ? (closePos < 0.6 ? 'a rejection wick above the close' : 'balanced wicks') : (closePos > 0.4 ? 'a rejection wick below the close' : 'balanced wicks')
  return `moderate-bodied ${bullish ? 'bullish' : 'bearish'} candle with ${wickSide}`
}

/** proxy ADX: directional persistence of closes over 20 bars normalized by range travel */
function trendinessProxy(candles: Candle[]): number {
  const n = Math.min(20, candles.length - 1)
  const seg = candles.slice(-(n + 1))
  const net = Math.abs(seg[seg.length - 1].close - seg[0].close)
  let travel = 0
  for (let i = 1; i < seg.length; i++) travel += Math.abs(seg[i].close - seg[i - 1].close)
  if (travel <= 0) return 0
  // efficiency ratio 0..~1 -> scale to a rough ADX-like 0..60
  return clamp((net / travel) * 60, 0, 60)
}

/** proxy Hurst: sign-persistence fraction of the last 60 returns, mapped near 0.5 */
function hurstProxy(closes: number[]): number {
  const rets: number[] = []
  for (let i = Math.max(1, closes.length - 60); i < closes.length; i++) rets.push(Math.sign(closes[i] - closes[i - 1]))
  if (rets.length < 20) return 0.5
  let same = 0
  for (let i = 1; i < rets.length; i++) if (rets[i] === rets[i - 1]) same++
  const persistence = same / (rets.length - 1) // 0.5 = random sign
  return clamp(0.5 + (persistence - 0.5) * 0.5, 0.3, 0.7)
}

/** E[return] of the next state from the Markov chain's state means */
function markovStateMeanReturn(m: MarkovResult): number {
  // nextStateProbs over MARKOV_STATES; approximate per-state magnitude by
  // the state's name bucket (big=1.8x, plain=1.0x, flat=0.2x of recent vol)
  const mags = [-1.8, -1.0, -0.2, 1.0, 1.8]
  let acc = 0
  for (let i = 0; i < 5; i++) acc += (m.nextStateProbs[i] ?? 0) * mags[i]
  return acc
}

// heikinAshiSeries is imported for parity with the chart-engine committee's
// internal use; engineVotes already handles transforms internally. Keep the
// import tree honest for future wick-profile extensions.
export const __oracleInternals = { heikinAshiSeries, rng, pUpFromEngineScore }
