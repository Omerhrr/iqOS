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
import { combineVotes, engineVotes, heikinAshiSeries } from './chartsignals'
import { detectPatterns, patternBias } from './patterns'
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
  drivers: OracleDriver[]
  /** how many drivers were actually usable (had enough history) */
  driversActive: number
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
  /** live self-calibration record from the plugin (null when no resolved predictions yet) */
  calibration?: { n: number; hitRate: number; brier: number } | null
  /** Monte Carlo bootstrap paths. Default 1200 (panel-grade); the bar-by-bar
   * strategy eval passes fewer for backtest speed - the fused read is stable
   * well below the default (binomial noise on pUp ~ 1/sqrt(n)). */
  mcSims?: number
  /** Include the chart-engine committee (renko/pnf/range/tick/footprint/heikin
   * vote). Default on; the backtester can drop it (the heaviest driver) when
   * sweeping gate params. */
  includeCommittee?: boolean
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
    const bias = patternBias(hits) // signed, roughly -2..2
    if (hits.length > 0) {
      const w = 6 * chaosFlatten
      drivers.push({
        name: 'Candle patterns',
        pUp: pUpFromScore(clamp(bias / 2, -1, 1)),
        weight: w,
        vote: clamp(bias / 2, -1, 1),
        detail: `${hits.length} recent patterns, net bias ${bias.toFixed(1)}`,
      })
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

  const usable = drivers.filter((d) => Number.isFinite(d.pUp) && Number.isFinite(d.weight) && d.weight > 0)
  if (usable.length < 3) return null // not enough working models - refuse rather than guess

  const pUp = fuseOdds(usable.map((d) => ({ pUp: d.pUp, weight: d.weight })))

  // agreement: share of total weight sitting on the winning side
  const winSide = pUp >= 0.5 ? 1 : -1
  const agreeW = usable.reduce((s, d) => s + (Math.sign(d.vote || (d.pUp - 0.5)) === winSide ? d.weight : 0), 0)
  const totalW = usable.reduce((s, d) => s + d.weight, 0)
  const agreement = totalW > 0 ? agreeW / totalW : 0.5
  const distance = Math.abs(pUp - 0.5) * 2 // 0..1
  const rawConfidence = clamp((0.55 * agreement + 0.45 * distance) * 100, 0, 97)

  // calibration discount: the oracle's own realized record tempers the read
  const cal = input.calibration ?? null
  const confidence = applyCalibrationDiscount(rawConfidence, cal)

  // ---------- magnitude: EWMA vol + markov next-state emphasis, ATR-anchored ----------
  const nextStateMean = markovStateMeanReturn(markov)
  const vol = ewma > 0 ? ewma : stdev(recent) || 1e-9
  const atrSafe = atrVal > 0 ? atrVal : Math.max(price * vol * 2, 1e-9)
  // 1-bar close-to-close move is on the order of one ATR; the Markov
  // next-state distribution stretches it when a big move state dominates
  const markovBoost = clamp(0.7 + (Math.abs(nextStateMean) / vol) * 0.35, 0.7, 1.8)
  const expAbs = clamp(price * vol * markovBoost, 0.35 * atrSafe, 1.8 * atrSafe)
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

  return {
    asset: input.asset,
    tf: input.tf,
    ts: Date.now(),
    targetBarTime,
    price,
    pUp,
    direction: pUp >= 0.56 ? 'call' : pUp <= 0.44 ? 'put' : 'none',
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
    drivers: usable,
    driversActive: usable.length,
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
