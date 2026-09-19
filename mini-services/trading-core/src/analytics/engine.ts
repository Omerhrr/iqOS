// IQAIR//OS - Analysis engine
// Runs every analytic over a candle series and produces an IndicatorSnapshot,
// quant stats, Markov model, Monte Carlo, S/R zones, patterns and a composite
// confluence signal (-100..100) built from weighted factor votes.
import type {
  AnalysisResult,
  Candle,
  CompositeSignal,
  Direction,
  Factor,
  IndicatorSnapshot,
  MarkovResult,
  PatternHit,
  QuantStats,
  Timeframe,
} from '../types'
import * as ta from './indicators'
import { detectPatterns, patternBias } from './patterns'
import {
  autocorrelation,
  ewmaVol,
  garchVol,
  hurstExponent,
  kurtosis,
  logReturns,
  markovChain,
  monteCarlo,
  regressionChannel,
  sharpeRatio,
  skewness,
  stdev,
  supportResistance,
} from './quant'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const last = (arr: number[]): number => {
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i]
  return NaN
}

function percentileRank(values: number[], v: number): number {
  const valid = values.filter(Number.isFinite)
  if (!valid.length) return 0.5
  const below = valid.filter((x) => x <= v).length
  return below / valid.length
}

function snapshot(candles: Candle[]): IndicatorSnapshot {
  const c = candles.map((k) => k.close)
  const h = candles.map((k) => k.high)
  const l = candles.map((k) => k.low)
  const v = candles.map((k) => k.volume)
  const rsiArr = ta.rsi(c, 14)
  const st = ta.stochastic(h, l, c)
  const md = ta.macd(c)
  const bb = ta.bollinger(c, 20, 2)
  const adxRes = ta.adx(h, l, c, 14)
  const a = ta.atr(h, l, c, 14)
  const stTrend = ta.supertrend(h, l, c, 10, 3)
  const ich = ta.ichimoku(h, l)
  const don = ta.donchian(h, l, 20)
  const kel = ta.keltner(h, l, c, 20, 2)
  const price = c[c.length - 1]
  const atrVal = last(a) || price * 0.001

  return {
    rsi: last(rsiArr),
    stochK: last(st.k),
    stochD: last(st.d),
    macd: last(md.macd),
    macdSignal: last(md.signal),
    macdHist: last(md.hist),
    bbUpper: last(bb.upper),
    bbMid: last(bb.mid),
    bbLower: last(bb.lower),
    bbPercentB: last(bb.percentB),
    bbWidth: last(bb.width),
    ema20: last(ta.ema(c, 20)),
    ema50: last(ta.ema(c, 50)),
    ema200: last(ta.ema(c, 200)),
    sma20: last(ta.sma(c, 20)),
    atr: atrVal,
    atrPct: (atrVal / price) * 100,
    adx: last(adxRes.adx),
    plusDI: last(adxRes.plusDI),
    minusDI: last(adxRes.minusDI),
    cci: last(ta.cci(h, l, c, 20)),
    williamsR: last(ta.williamsR(h, l, c, 14)),
    mfi: last(ta.mfi(h, l, c, v, 14)),
    obv: last(ta.obv(c, v)),
    vwap: last(ta.vwap(candles)),
    roc: last(ta.roc(c, 12)),
    supertrend: last(stTrend.line),
    supertrendDir: last(stTrend.dir),
    tenkan: last(ich.tenkan),
    kijun: last(ich.kijun),
    donchianUpper: last(don.upper),
    donchianLower: last(don.lower),
    keltnerUpper: last(kel.upper),
    keltnerLower: last(kel.lower),
  }
}

function quantStats(candles: Candle[]): QuantStats {
  const c = candles.map((k) => k.close)
  const rets = logReturns(c)
  const hurst = hurstExponent(c)
  const hurstNote =
    hurst > 0.58
      ? 'Trending / persistent series'
      : hurst < 0.42
        ? 'Mean-reverting / anti-persistent'
        : 'Near random-walk'
  const ewma = ewmaVol(rets)
  const g = garchVol(rets)
  const candleSec = Math.max(1, (candles[candles.length - 1].time - candles[candles.length - 2].time) || 60)
  const periodsPerYear = (365 * 24 * 3600) / candleSec
  const lr = regressionChannel(c, Math.min(100, c.length), 2)
  const sma20 = ta.sma(c, 20)
  const std = stdev(c.slice(-20))
  const smaVal = last(sma20) || last(c)

  return {
    hurst,
    hurstNote,
    acf: autocorrelation(rets, 20),
    acfSignificance: 1.96 / Math.sqrt(Math.max(rets.length, 1)),
    ewmaVol: ewma,
    garchVol: g.vol,
    annualizedVol: ewma * Math.sqrt(periodsPerYear) * 100,
    zScore: std === 0 ? 0 : (last(c) - smaVal) / std,
    zScorePeriod: 20,
    linreg: { slope: lr.slope, r2: lr.r2, upper: lr.upper, mid: lr.mid, lower: lr.lower },
    dailyVol: ewma * Math.sqrt(86400 / candleSec) * 100,
    sharpe: sharpeRatio(rets, periodsPerYear),
    skew: skewness(rets),
    kurtosis: kurtosis(rets),
  }
}

function buildFactors(
  candles: Candle[],
  ind: IndicatorSnapshot,
  quant: QuantStats,
  markov: ReturnType<typeof markovChain>,
  pBias: number
): Factor[] {
  const price = candles[candles.length - 1].close
  const factors: Factor[] = []

  // --- Trend group ---
  const emaStack =
    (ind.ema20 > ind.ema50 ? 1 : -1) + (ind.ema50 > ind.ema200 ? 1 : -1) + (price > ind.ema20 ? 1 : -1)
  factors.push({
    name: 'EMA Stack 20/50/200',
    group: 'trend',
    value: emaStack,
    vote: clamp(emaStack, -2, 2),
    weight: 14,
    note: ind.ema20 > ind.ema50 ? 'Short MA above long MA' : 'Short MA below long MA',
  })
  const adxTrend = ind.adx > 25 ? 2 : ind.adx > 20 ? 1 : 0
  const diSign = ind.plusDI > ind.minusDI ? 1 : -1
  factors.push({
    name: 'ADX / DI',
    group: 'trend',
    value: ind.adx,
    vote: clamp(adxTrend * diSign, -2, 2),
    weight: 12,
    note: `ADX ${ind.adx.toFixed(1)} - ${adxTrend === 0 ? 'no trend' : 'trending'}, ${diSign > 0 ? '+DI dominates' : '-DI dominates'}`,
  })
  const slopeVote = quant.linreg.r2 > 0.4 ? clamp(Math.sign(quant.linreg.slope) * (quant.linreg.r2 * 2), -2, 2) : 0
  factors.push({
    name: 'Regression Slope (R2)',
    group: 'trend',
    value: quant.linreg.r2,
    vote: slopeVote,
    weight: 10,
    note: `R2 ${quant.linreg.r2.toFixed(2)} - ${quant.linreg.r2 > 0.4 ? 'structured move' : 'loose fit'}`,
  })
  factors.push({
    name: 'Supertrend',
    group: 'trend',
    value: ind.supertrendDir,
    vote: ind.supertrendDir > 0 ? 1.5 : -1.5,
    weight: 10,
    note: ind.supertrendDir > 0 ? 'Bullish regime' : 'Bearish regime',
  })

  // --- Momentum group ---
  factors.push({
    name: 'RSI (14)',
    group: 'momentum',
    value: ind.rsi,
    vote: ind.rsi > 70 ? -1.5 : ind.rsi < 30 ? 1.5 : clamp((ind.rsi - 50) / 20, -1, 1),
    weight: 12,
    note: ind.rsi > 70 ? 'Overbought' : ind.rsi < 30 ? 'Oversold' : 'Mid-range momentum',
  })
  factors.push({
    name: 'MACD Hist',
    group: 'momentum',
    value: ind.macdHist,
    vote: clamp(Math.sign(ind.macdHist) * (Math.abs(ind.macdHist) > ind.atr * 0.05 ? 1.5 : 0.75), -2, 2),
    weight: 10,
    note: ind.macdHist > 0 ? 'Bullish histogram' : 'Bearish histogram',
  })
  factors.push({
    name: 'Stochastic K/D',
    group: 'momentum',
    value: ind.stochK,
    vote:
      ind.stochK > 80 && ind.stochK < ind.stochD
        ? -1.5
        : ind.stochK < 20 && ind.stochK > ind.stochD
          ? 1.5
          : clamp((ind.stochK - 50) / 30, -1, 1),
    weight: 8,
    note: `K ${ind.stochK.toFixed(0)} vs D ${ind.stochD.toFixed(0)}`,
  })

  // --- Mean-reversion group ---
  factors.push({
    name: 'Bollinger %B',
    group: 'mean-reversion',
    value: ind.bbPercentB,
    vote: ind.bbPercentB > 1 ? -1.5 : ind.bbPercentB < 0 ? 1.5 : clamp((0.5 - ind.bbPercentB) * 2, -1, 1),
    weight: 10,
    note: ind.bbPercentB > 1 ? 'Above upper band' : ind.bbPercentB < 0 ? 'Below lower band' : 'Inside bands',
  })
  factors.push({
    name: 'Z-Score (20)',
    group: 'mean-reversion',
    value: quant.zScore,
    vote: clamp(-quant.zScore / 1.5, -1.5, 1.5),
    weight: 8,
    note: `${quant.zScore.toFixed(2)} SD from mean`,
  })
  factors.push({
    name: 'Williams %R',
    group: 'mean-reversion',
    value: ind.williamsR,
    vote: ind.williamsR < -80 ? 1.2 : ind.williamsR > -20 ? -1.2 : 0,
    weight: 6,
    note: ind.williamsR < -80 ? 'Oversold extreme' : ind.williamsR > -20 ? 'Overbought extreme' : 'Neutral',
  })

  // --- Statistical group ---
  factors.push({
    name: 'Markov P(up)',
    group: 'statistical',
    value: markov.probUp,
    vote: clamp((markov.probUp - 0.5) * 6, -2, 2),
    weight: 14,
    note: `P(up) ${(markov.probUp * 100).toFixed(1)}% - regime ${markov.regime}`,
  })
  factors.push({
    name: 'Hurst Exponent',
    group: 'statistical',
    value: quant.hurst,
    vote: quant.hurst > 0.58 ? clamp(Math.sign(quant.linreg.slope) * 1.2, -2, 2) : quant.hurst < 0.42 ? clamp(-Math.sign(quant.zScore) * 1.2, -2, 2) : 0,
    weight: 8,
    note: quant.hurstNote,
  })
  factors.push({
    name: 'Pattern Bias',
    group: 'patterns',
    value: pBias,
    vote: clamp(pBias / 2.5, -2, 2),
    weight: 10,
    note: pBias > 0 ? 'Bullish formations dominate' : pBias < 0 ? 'Bearish formations dominate' : 'No strong formations',
  })
  void price

  return factors
}

export function compositeSignal(
  candles: Candle[],
  asset: string,
  tf: Timeframe,
  markov: ReturnType<typeof markovChain>,
  quant: QuantStats,
  ind: IndicatorSnapshot,
  pBias: number
): CompositeSignal {
  const factors = buildFactors(candles, ind, quant, markov, pBias)
  const totalWeight = factors.reduce((a, f) => a + f.weight, 0)
  const raw = factors.reduce((a, f) => a + f.vote * f.weight, 0)
  const score = clamp((raw / (totalWeight * 2)) * 100, -100, 100)
  const active = factors.filter((f) => Math.abs(f.vote) > 0.15)
  const agreeing = active.filter((f) => Math.sign(f.vote) === Math.sign(score) && score !== 0)
  const confidence =
    active.length === 0
      ? 0
      : clamp((agreeing.length / active.length) * 0.6 + (Math.abs(score) / 100) * 0.4, 0, 1) * 100
  const direction = score >= 22 ? 'call' : score <= -22 ? 'put' : 'none'
  return {
    asset,
    tf,
    ts: candles[candles.length - 1].time,
    price: candles[candles.length - 1].close,
    score,
    direction,
    confidence,
    factors,
  }
}

const seriesToLine = (arr: number[], candles: Candle[], limit = 240): { time: number; value: number }[] => {
  const out: { time: number; value: number }[] = []
  const start = Math.max(0, arr.length - limit)
  for (let i = start; i < arr.length; i++) {
    if (Number.isFinite(arr[i]) && Number.isFinite(candles[i]?.time)) out.push({ time: candles[i].time, value: arr[i] })
  }
  return out
}

export function analyze(candles: Candle[], asset: string, tf: Timeframe): AnalysisResult {
  const c = candles.map((k) => k.close)
  const h = candles.map((k) => k.high)
  const l = candles.map((k) => k.low)
  const ind = snapshot(candles)
  const quant = quantStats(candles)
  const markov = markovChain(c, { lookback: 500 })
  const patterns = detectPatterns(candles, 8)
  const pBias = patternBias(patterns)
  const signal = compositeSignal(candles, asset, tf, markov, quant, ind, pBias)
  const stTrend = ta.supertrend(h, l, c, 10, 3)
  const mc = monteCarlo(c, { nSims: 1500, horizon: 30, samplePaths: 20 })
  const price = c[c.length - 1]
  const refIdx = Math.max(0, c.length - 25)
  const changePct = c[refIdx] ? ((price - c[refIdx]) / c[refIdx]) * 100 : 0

  return {
    asset,
    tf,
    ts: candles[candles.length - 1].time,
    price,
    changePct,
    indicators: ind,
    indicatorSeries: {
      ema20: seriesToLine(ta.ema(c, 20), candles),
      ema50: seriesToLine(ta.ema(c, 50), candles),
      ema200: seriesToLine(ta.ema(c, 200), candles),
      bbUpper: seriesToLine(ta.bollinger(c, 20, 2).upper, candles),
      bbLower: seriesToLine(ta.bollinger(c, 20, 2).lower, candles),
      supertrend: stTrend.line.reduce<{ time: number; value: number; dir: number }[]>((acc, v, i) => {
        if (Number.isFinite(v) && Number.isFinite(stTrend.dir[i]) && candles[i]) {
          acc.push({ time: candles[i].time, value: v, dir: stTrend.dir[i] })
        }
        return acc
      }, []).slice(-240),
      vwap: seriesToLine(ta.vwap(candles), candles),
    },
    patterns,
    markov,
    montecarlo: mc,
    quant,
    srZones: supportResistance(candles, 240),
    signal,
    registrySize: 101,
  }
}

/**
 * Lightweight per-pair snapshot for the screener / alert rules.
 * Same factor math as `analyze()` but skips Monte Carlo, indicator series,
 * S/R zones and the registry path - a full-universe sweep stays in milliseconds
 * per pair instead of tens of milliseconds.
 */
export function scanSnapshot(
  candles: Candle[],
  asset: string,
  tf: Timeframe
): {
  asset: string
  tf: Timeframe
  ts: number
  price: number
  changePct: number
  score: number
  direction: Direction
  confidence: number
  rsi: number
  adx: number
  atrPct: number
  hurst: number
  probUp: number
  regime: MarkovResult['regime']
  topPattern: { name: string; direction: PatternHit['direction']; reliability: number } | null
} {
  const c = candles.map((k) => k.close)
  const ind = snapshot(candles)
  const quant = quantStats(candles)
  const markov = markovChain(c, { lookback: 500 })
  const patterns = detectPatterns(candles, 8)
  const pBias = patternBias(patterns)
  const signal = compositeSignal(candles, asset, tf, markov, quant, ind, pBias)
  const refIdx = Math.max(0, c.length - 25)
  const price = c[c.length - 1]
  const top = patterns.find((p) => p.direction !== 'neutral') ?? patterns[0]
  return {
    asset,
    tf,
    ts: candles[candles.length - 1].time,
    price,
    changePct: c[refIdx] ? ((price - c[refIdx]) / c[refIdx]) * 100 : 0,
    score: signal.score,
    direction: signal.direction,
    confidence: signal.confidence,
    rsi: ind.rsi,
    adx: ind.adx,
    atrPct: ind.atrPct,
    hurst: quant.hurst,
    probUp: markov.probUp,
    regime: markov.regime,
    topPattern: top ? { name: top.name, direction: top.direction, reliability: top.reliability } : null,
  }
}

export { percentileRank }
