// IQAIR//OS - Strategy registry
// Data-driven strategy definitions. `evaluate` is pure: candles + params in,
// a directional eval out. Used by the Strategy Lab, the backtester and the agent.
import type { StrategyDef } from '../types'
import * as ta from '../analytics/indicators'
import { markovChain, fitDiscreteMarkov, logReturns, stdev, mean, rng, gauss } from '../analytics/quant'
import { detectPatterns, patternBias } from '../analytics/patterns'
import { ouEstimate, ouState } from '../analytics/kalman'
import { vskEvaluate, VSK_DEFAULTS } from '../analytics/vsk'
import { tskEvaluate, TSK_DEFAULTS } from '../analytics/tsk'

const last = (arr: number[]): number => {
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i]
  return NaN
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const num = (p: Record<string, number | string>, k: string, d: number) => {
  const v = Number(p[k])
  return Number.isFinite(v) ? v : d
}

export const STRATEGIES: StrategyDef[] = [
  {
    id: 'rsi-reversion',
    name: 'RSI Mean Reversion',
    description: 'Fades RSI extremes: CALL when RSI dips below the oversold threshold, PUT above overbought.',
    params: [
      { key: 'period', label: 'RSI period', type: 'number', min: 5, max: 40, default: 14 },
      { key: 'oversold', label: 'Oversold level', type: 'number', min: 10, max: 45, default: 30 },
      { key: 'overbought', label: 'Overbought level', type: 'number', min: 55, max: 90, default: 70 },
    ],
    evaluate: (candles, p) => {
      const r = last(ta.rsi(candles.map((c) => c.close), num(p, 'period', 14)))
      const os = num(p, 'oversold', 30)
      const ob = num(p, 'overbought', 70)
      if (r < os) return { direction: 'call', score: clamp((os - r) * 4, 40, 100), notes: `RSI ${r.toFixed(1)} below ${os}` }
      if (r > ob) return { direction: 'put', score: clamp((r - ob) * 4, 40, 100), notes: `RSI ${r.toFixed(1)} above ${ob}` }
      return { direction: 'none', score: 0, notes: `RSI ${r.toFixed(1)} neutral` }
    },
  },
  {
    id: 'macd-cross',
    name: 'MACD Crossover',
    description: 'CALL when MACD histogram flips positive, PUT when it flips negative.',
    params: [
      { key: 'fast', label: 'Fast EMA', type: 'number', min: 5, max: 30, default: 12 },
      { key: 'slow', label: 'Slow EMA', type: 'number', min: 15, max: 60, default: 26 },
      { key: 'signal', label: 'Signal EMA', type: 'number', min: 5, max: 20, default: 9 },
    ],
    evaluate: (candles, p) => {
      const md = ta.macd(candles.map((c) => c.close), num(p, 'fast', 12), num(p, 'slow', 26), num(p, 'signal', 9))
      const h0 = md.hist[md.hist.length - 1]
      const h1 = md.hist[md.hist.length - 2]
      if (!Number.isFinite(h0) || !Number.isFinite(h1)) return { direction: 'none', score: 0, notes: 'warming up' }
      if (h1 <= 0 && h0 > 0) return { direction: 'call', score: 75, notes: 'Bullish MACD cross' }
      if (h1 >= 0 && h0 < 0) return { direction: 'put', score: 75, notes: 'Bearish MACD cross' }
      return { direction: 'none', score: clamp((h0 / (last(candles.map((c) => c.close)) * 0.001)) * 10, -30, 30), notes: 'No fresh cross' }
    },
  },
  {
    id: 'bb-bounce',
    name: 'Bollinger Bounce',
    description: 'Mean-reversion at the bands: CALL below the lower band, PUT above the upper band.',
    params: [
      { key: 'period', label: 'BB period', type: 'number', min: 10, max: 50, default: 20 },
      { key: 'mult', label: 'Std-dev multiplier', type: 'number', min: 1, max: 3.5, step: 0.1, default: 2 },
    ],
    evaluate: (candles, p) => {
      const bb = ta.bollinger(candles.map((c) => c.close), num(p, 'period', 20), num(p, 'mult', 2))
      const pb = last(bb.percentB)
      if (pb < 0.02) return { direction: 'call', score: 70, notes: 'Price pinned below lower band' }
      if (pb > 0.98) return { direction: 'put', score: 70, notes: 'Price pinned above upper band' }
      return { direction: 'none', score: clamp((0.5 - pb) * 60, -30, 30), notes: `%B ${(pb * 100).toFixed(0)}%` }
    },
  },
  {
    id: 'ema-trend',
    name: 'EMA Trend Rider',
    description: 'Trades with the trend when fast EMA is over slow EMA and ADX confirms strength.',
    params: [
      { key: 'fast', label: 'Fast EMA', type: 'number', min: 5, max: 30, default: 9 },
      { key: 'slow', label: 'Slow EMA', type: 'number', min: 15, max: 100, default: 21 },
      { key: 'adx', label: 'ADX filter', type: 'number', min: 10, max: 40, default: 20 },
    ],
    evaluate: (candles, p) => {
      const c = candles.map((k) => k.close)
      const fast = last(ta.ema(c, num(p, 'fast', 9)))
      const slow = last(ta.ema(c, num(p, 'slow', 21)))
      const adxRes = ta.adx(candles.map((k) => k.high), candles.map((k) => k.low), c)
      const adxV = last(adxRes.adx)
      if (Number.isNaN(fast) || Number.isNaN(slow) || Number.isNaN(adxV)) return { direction: 'none', score: 0, notes: 'warming up' }
      if (adxV < num(p, 'adx', 20)) return { direction: 'none', score: 0, notes: `ADX ${adxV.toFixed(1)} too weak` }
      const bull = fast > slow
      return {
        direction: bull ? 'call' : 'put',
        score: clamp(40 + adxV, 40, 95),
        notes: `${bull ? 'Bull' : 'Bear'} stack, ADX ${adxV.toFixed(1)}`,
      }
    },
  },
  {
    id: 'markov-edge',
    name: 'Markov Regime Edge',
    description: 'Uses the fitted Markov transition matrix: trades the aggregated P(next move up) against a threshold.',
    params: [
      { key: 'lookback', label: 'Lookback states', type: 'number', min: 100, max: 900, default: 500 },
      { key: 'threshold', label: 'Edge threshold %', type: 'number', min: 52, max: 70, default: 56 },
    ],
    evaluate: (candles, p) => {
      if (candles.length < Math.min(num(p, 'lookback', 500) + 2, candles.length)) {
        if (candles.length < 60) return { direction: 'none', score: 0, notes: 'not enough history' }
      }
      const m = markovChain(candles.map((c) => c.close), { lookback: num(p, 'lookback', 500) })
      const thr = num(p, 'threshold', 56) / 100
      const upPct = m.probUp * 100
      const dnPct = m.probDown * 100
      if (m.probUp >= thr) return { direction: 'call', score: clamp((m.probUp - 0.5) * 260, 40, 95), notes: `P(up) ${upPct.toFixed(1)}% - regime ${m.regime}` }
      if (m.probDown >= thr) return { direction: 'put', score: clamp((m.probDown - 0.5) * 260, 40, 95), notes: `P(down) ${dnPct.toFixed(1)}% - regime ${m.regime}` }
      return { direction: 'none', score: 0, notes: `P(up) ${upPct.toFixed(1)}% vs P(down) ${dnPct.toFixed(1)}% - no edge` }
    },
  },
  {
    id: 'markov-vol-regime',
    name: 'Markov Volatility Regime',
    description: "Fits a discrete Markov chain over hidden volatility states (Compressed/Orderly/Toxic) from realized vol, not price direction. No options market here, so 'short premium expecting compression' has no binary-option analog and is skipped (stands aside) - but 'buy cheap gamma right before a Toxic flip' translates directly: when the chain gives a high transition probability OUT of Compressed and INTO Toxic, it fires the breakout direction off the recent range, the same trade a long-gamma option would want.",
    params: [
      { key: 'volWindow', label: 'Realized-vol window (bars)', type: 'number', min: 5, max: 40, default: 14 },
      { key: 'lookback', label: 'Vol-state history (bars)', type: 'number', min: 100, max: 500, default: 240 },
      { key: 'expansionProb', label: 'P(-> Toxic) trigger', type: 'number', min: 0.3, max: 0.9, step: 0.05, default: 0.55 },
      { key: 'rangeLookback', label: 'Breakout-direction range', type: 'number', min: 5, max: 40, default: 20 },
    ],
    evaluate: (candles, p) => {
      const volWindow = Math.round(num(p, 'volWindow', 14))
      const lookback = Math.round(num(p, 'lookback', 240))
      const expansionProb = num(p, 'expansionProb', 0.55)
      const rangeLookback = Math.round(num(p, 'rangeLookback', 20))
      const closesArr = candles.map((c) => c.close)
      const need = lookback + volWindow + 5
      if (closesArr.length < need) return { direction: 'none', score: 0, notes: `warming up (need ${need} bars)` }
      // realized-vol series: rolling stdev of log returns, one reading per bar
      // over the last `lookback` bars - this IS the "historical volatility"
      // series the Markov chain is fit on, in place of raw returns.
      const rets = logReturns(closesArr)
      const volSeries: number[] = []
      for (let i = volWindow; i < rets.length; i++) volSeries.push(stdev(rets.slice(i - volWindow, i)))
      const recent = volSeries.slice(-lookback)
      const volMean = mean(recent)
      const volSd = stdev(recent) || 1e-12
      const classify = (v: number): number => {
        const z = (v - volMean) / volSd
        if (z <= -0.4) return 0 // compressed
        if (z >= 0.6) return 2 // toxic
        return 1 // orderly
      }
      const states = recent.map(classify)
      const chain = fitDiscreteMarkov(states, 3)
      const label = ['Compressed', 'Orderly', 'Toxic'][chain.lastState]
      if (chain.lastState === 0 && chain.nextProbs[2] >= expansionProb) {
        // expansion imminent: pick the breakout side off the recent range,
        // the direction a long-gamma bet would actually pay on
        const dch = ta.donchian(candles.map((c) => c.high), candles.map((c) => c.low), rangeLookback)
        const upper = dch.upper[dch.upper.length - 1]
        const lower = dch.lower[dch.lower.length - 1]
        const lastPrice = closesArr[closesArr.length - 1]
        const pos = upper > lower ? (lastPrice - lower) / (upper - lower) : 0.5
        const score = clamp(45 + (chain.nextProbs[2] - expansionProb) * 110, 40, 92)
        if (pos >= 0.55) return { direction: 'call', score, notes: `Compressed -> Toxic P=${(chain.nextProbs[2] * 100).toFixed(0)}%, pressing range high - vol expansion setup` }
        if (pos <= 0.45) return { direction: 'put', score, notes: `Compressed -> Toxic P=${(chain.nextProbs[2] * 100).toFixed(0)}%, pressing range low - vol expansion setup` }
        return { direction: 'none', score: 0, notes: `Toxic flip likely (P=${(chain.nextProbs[2] * 100).toFixed(0)}%) but price mid-range - no side yet` }
      }
      if (chain.lastState === 2 && chain.nextProbs[0] >= expansionProb) {
        return { direction: 'none', score: 0, notes: `Toxic -> Compressed P=${(chain.nextProbs[0] * 100).toFixed(0)}% - a premium-selling setup with no binary-option analog, standing aside` }
      }
      return { direction: 'none', score: 0, notes: `regime ${label}, no transition edge (P(Toxic) ${(chain.nextProbs[2] * 100).toFixed(0)}%, P(Compressed) ${(chain.nextProbs[0] * 100).toFixed(0)}%)` }
    },
  },
  {
    id: 'markov-flow-imbalance',
    name: 'Markov Flow Imbalance (OHLC proxy)',
    description: "Approximates order-flow imbalance from OHLC candles (close position within the bar's range, and body-vs-range dominance) since no Level-2 order book feed exists here - true bid/ask depth and cancellation-rate modeling is not possible on this data. Fits a fast discrete Markov chain over 3 imbalance states (Bid-heavy/Balanced/Ask-heavy) on a short lookback and trades continuation the moment the chain shows high persistence toward one side - the closest honest analog to trading a detected order-flow regime, not a substitute for real LOB microstructure.",
    params: [
      { key: 'lookback', label: 'Imbalance-state history (bars)', type: 'number', min: 30, max: 200, default: 80 },
      { key: 'persistProb', label: 'Persistence trigger P(stay)', type: 'number', min: 0.4, max: 0.95, step: 0.05, default: 0.6 },
    ],
    evaluate: (candles, p) => {
      const lookback = Math.round(num(p, 'lookback', 80))
      const persistProb = num(p, 'persistProb', 0.6)
      if (candles.length < lookback + 5) return { direction: 'none', score: 0, notes: 'warming up' }
      const window = candles.slice(-lookback)
      // imbalance proxy per bar: where close sits in the bar's range, signed
      // by whether the bar closed up or down - a stand-in for "aggressive
      // buying/selling pressure" absent real order-book depth.
      const states = window.map((c) => {
        const range = c.high - c.low
        const posInRange = range > 1e-12 ? (c.close - c.low) / range : 0.5
        if (posInRange >= 0.62) return 2 // ask-heavy / aggressive buying
        if (posInRange <= 0.38) return 0 // bid-heavy / aggressive selling
        return 1 // balanced
      })
      const chain = fitDiscreteMarkov(states, 3)
      const last3 = states.slice(-3)
      const stableRun = last3.every((s) => s === chain.lastState)
      if (chain.lastState === 2 && chain.nextProbs[2] >= persistProb && stableRun) {
        return { direction: 'call', score: clamp(42 + (chain.nextProbs[2] - persistProb) * 100, 40, 88), notes: `ask-heavy flow persisting (P(stay) ${(chain.nextProbs[2] * 100).toFixed(0)}%) - proxy imbalance, not real LOB` }
      }
      if (chain.lastState === 0 && chain.nextProbs[0] >= persistProb && stableRun) {
        return { direction: 'put', score: clamp(42 + (chain.nextProbs[0] - persistProb) * 100, 40, 88), notes: `bid-heavy flow persisting (P(stay) ${(chain.nextProbs[0] * 100).toFixed(0)}%) - proxy imbalance, not real LOB` }
      }
      return { direction: 'none', score: 0, notes: `flow state ${['bid-heavy', 'balanced', 'ask-heavy'][chain.lastState]}, no persistence edge` }
    },
  },
  {
    id: 'donchian-breakout',
    name: 'Donchian Breakout',
    description: 'Classic turtle system: CALL on close above the N-bar high, PUT on close below the N-bar low.',
    params: [
      { key: 'period', label: 'Channel period', type: 'number', min: 10, max: 80, default: 20 },
    ],
    evaluate: (candles, p) => {
      const period = num(p, 'period', 20)
      if (candles.length < period + 2) return { direction: 'none', score: 0, notes: 'not enough history' }
      const window = candles.slice(-period - 1, -1)
      const hh = Math.max(...window.map((c) => c.high))
      const ll = Math.min(...window.map((c) => c.low))
      const close = candles[candles.length - 1].close
      if (close > hh) return { direction: 'call', score: 72, notes: `Broke ${period}-bar high ${hh.toFixed(5)}` }
      if (close < ll) return { direction: 'put', score: 72, notes: `Broke ${period}-bar low ${ll.toFixed(5)}` }
      return { direction: 'none', score: 0, notes: 'Inside channel' }
    },
  },
  {
    id: 'stoch-cross',
    name: 'Stochastic Cross',
    description: 'CALL when %K crosses above %D from oversold, PUT when %K crosses below %D from overbought.',
    params: [
      { key: 'kPeriod', label: '%K period', type: 'number', min: 5, max: 30, default: 14 },
      { key: 'oversold', label: 'Oversold', type: 'number', min: 5, max: 40, default: 20 },
      { key: 'overbought', label: 'Overbought', type: 'number', min: 60, max: 95, default: 80 },
    ],
    evaluate: (candles, p) => {
      const st = ta.stochastic(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), num(p, 'kPeriod', 14))
      const k0 = st.k[st.k.length - 1]
      const k1 = st.k[st.k.length - 2]
      const d0 = st.d[st.d.length - 1]
      const d1 = st.d[st.d.length - 2]
      if ([k0, k1, d0, d1].some((v) => !Number.isFinite(v))) return { direction: 'none', score: 0, notes: 'warming up' }
      const os = num(p, 'oversold', 20)
      const ob = num(p, 'overbought', 80)
      if (k1 <= d1 && k0 > d0 && k0 < os + 15) return { direction: 'call', score: 68, notes: `Bullish K/D cross at ${k0.toFixed(0)}` }
      if (k1 >= d1 && k0 < d0 && k0 > ob - 15) return { direction: 'put', score: 68, notes: `Bearish K/D cross at ${k0.toFixed(0)}` }
      return { direction: 'none', score: 0, notes: 'No qualifying cross' }
    },
  },
  {
    id: 'supertrend-follow',
    name: 'Supertrend Follow',
    description: 'Trades in the direction of the Supertrend flip.',
    params: [
      { key: 'period', label: 'ATR period', type: 'number', min: 5, max: 30, default: 10 },
      { key: 'mult', label: 'ATR multiplier', type: 'number', min: 1, max: 5, step: 0.25, default: 3 },
    ],
    evaluate: (candles, p) => {
      const st = ta.supertrend(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), num(p, 'period', 10), num(p, 'mult', 3))
      const d0 = st.dir[st.dir.length - 1]
      const d1 = st.dir[st.dir.length - 2]
      if (!Number.isFinite(d0) || !Number.isFinite(d1)) return { direction: 'none', score: 0, notes: 'warming up' }
      if (d0 > 0 && d1 < 0) return { direction: 'call', score: 76, notes: 'Supertrend flipped bullish' }
      if (d0 < 0 && d1 > 0) return { direction: 'put', score: 76, notes: 'Supertrend flipped bearish' }
      return { direction: d0 > 0 ? 'call' : 'put', score: 30, notes: `Riding ${d0 > 0 ? 'bull' : 'bear'} trend` }
    },
  },
  {
    id: 'pattern-confluence',
    name: 'Pattern Confluence',
    description: 'Accumulates candlestick pattern bias over recent bars and trades meaningful clusters.',
    params: [
      { key: 'lookback', label: 'Pattern lookback (bars)', type: 'number', min: 3, max: 15, default: 6 },
      { key: 'minBias', label: 'Min bias', type: 'number', min: 1, max: 5, step: 0.5, default: 2 },
    ],
    evaluate: (candles, p) => {
      const hits = detectPatterns(candles, num(p, 'lookback', 6))
      const bias = patternBias(hits)
      const min = num(p, 'minBias', 2)
      const names = hits.filter((h) => (bias > 0 ? h.direction === 'bullish' : h.direction === 'bearish')).map((h) => h.name)
      if (bias >= min) return { direction: 'call', score: clamp(50 + bias * 8, 40, 92), notes: `Bullish: ${names.join(', ') || '-'}` }
      if (bias <= -min) return { direction: 'put', score: clamp(50 + Math.abs(bias) * 8, 40, 92), notes: `Bearish: ${names.join(', ') || '-'}` }
      return { direction: 'none', score: clamp(bias * 10, -30, 30), notes: `Bias ${bias.toFixed(1)} below threshold` }
    },
  },
  {
    id: 'kalman-ou-reversion',
    name: 'Kalman OU Reversion',
    description: 'Kalman-filtered Ornstein-Uhlenbeck model: CALL when price stretches below the estimated equilibrium, PUT above - gated by reversion significance (t-stat) and a tradeable half-life.',
    params: [
      { key: 'window', label: 'Estimation window', type: 'number', min: 60, max: 500, default: 240 },
      { key: 'zEntry', label: 'Z entry threshold', type: 'number', min: 1, max: 3.5, step: 0.1, default: 1.8 },
      { key: 'maxHalfLife', label: 'Max half-life (bars)', type: 'number', min: 5, max: 200, default: 60 },
    ],
    evaluate: (candles, p) => {
      const ou = ouState(candles.map((c) => c.close), num(p, 'window', 240))
      const ze = num(p, 'zEntry', 1.8)
      const hl = ou.halfLifeBars >= 9999 ? '∞' : ou.halfLifeBars.toFixed(0)
      if (!ou.meanReverting) {
        return { direction: 'none', score: 0, notes: `OU: not mean-reverting (t ${ou.tStat.toFixed(1)}, HL ${hl}b)` }
      }
      if (ou.halfLifeBars > num(p, 'maxHalfLife', 60)) {
        return { direction: 'none', score: 0, notes: `OU: half-life ${hl}b exceeds cap · z ${ou.z.toFixed(2)}` }
      }
      const score = clamp(45 + (Math.abs(ou.z) - ze) * 20 + Math.min(18, Math.max(0, ou.tStat) * 3), 42, 95)
      if (ou.z <= -ze) return { direction: 'call', score, notes: `z ${ou.z.toFixed(2)}σ below OU mean · HL ${hl}b · κ ${ou.kappa.toFixed(3)}` }
      if (ou.z >= ze) return { direction: 'put', score, notes: `z ${ou.z.toFixed(2)}σ above OU mean · HL ${hl}b · κ ${ou.kappa.toFixed(3)}` }
      return { direction: 'none', score: 0, notes: `z ${ou.z.toFixed(2)} inside ±${ze}σ · HL ${hl}b` }
    },
  },
  {
    id: 'kalman-ou-breakout',
    name: 'Kalman OU Breakdown Breakout',
    description: 'Trades continuation, not reversion: fires only once the OU fit has lost its grip (weak/failed t-stat or a stretched, one-directional run of Kalman innovations) AND price has broken past a wide z-band - betting the reversion mechanism just broke down and a structural move is underway.',
    params: [
      { key: 'window', label: 'Estimation window', type: 'number', min: 60, max: 500, default: 240 },
      { key: 'zBreak', label: 'Breakout z threshold', type: 'number', min: 2, max: 5, step: 0.1, default: 3 },
      { key: 'runLen', label: 'Innovation run length', type: 'number', min: 2, max: 10, default: 3 },
    ],
    evaluate: (candles, p) => {
      const closesArr = candles.map((c) => c.close)
      const window = num(p, 'window', 240)
      const zBreak = num(p, 'zBreak', 3)
      const runLen = Math.round(num(p, 'runLen', 3))
      const est = ouEstimate(closesArr, window)
      const sigmaEq = est.sigmaEq > 1e-12 ? est.sigmaEq : 1
      const lastPrice = closesArr[closesArr.length - 1]
      const z = clamp((lastPrice - est.theta) / sigmaEq, -12, 12)
      if (Math.abs(z) < zBreak) return { direction: 'none', score: 0, notes: `z ${z.toFixed(2)} inside ±${zBreak}σ band - no breakout` }
      const sigmaEps = est.sigmaEps > 1e-12 ? est.sigmaEps : 1
      let sameSign = 0
      for (let k = 0; k < runLen; k++) {
        const i = closesArr.length - 1 - k
        if (i < 1) break
        const predicted = est.theta + est.phi * (closesArr[i - 1] - est.theta)
        const innov = (closesArr[i] - predicted) / sigmaEps
        if (Math.sign(innov) === Math.sign(z) && Math.abs(innov) > 0.3) sameSign++
      }
      const structurallyBroken = est.tStat < 1.5 || est.halfLifeBars > 250 || sameSign >= Math.max(2, runLen - 1)
      if (!structurallyBroken) return { direction: 'none', score: 0, notes: `z ${z.toFixed(2)} stretched but reversion (t ${est.tStat.toFixed(1)}) still intact - not a breakout, fade territory instead` }
      const score = clamp(45 + (Math.abs(z) - zBreak) * 15 + sameSign * 8, 40, 95)
      const dir = z > 0 ? 'call' : 'put'
      return { direction: dir, score, notes: `${dir === 'call' ? 'Upside' : 'Downside'} breakout: z ${z.toFixed(2)}σ past ${zBreak}, reversion failed (t ${est.tStat.toFixed(1)}), ${sameSign}/${runLen} innovations confirming` }
    },
  },
  {
    id: 'kalman-ou-scalp',
    name: 'Kalman OU Scalp (Fast Half-Life)',
    description: 'Only trades when the OU half-life is so short the reversion should complete within the option expiry window - the market-making analog: a tight, fast-vibrating equilibrium rather than a slow macro reversion. Fires more often, on smaller stretches, than the standard OU Reversion strategy.',
    params: [
      { key: 'window', label: 'Estimation window', type: 'number', min: 30, max: 300, default: 120 },
      { key: 'zEntry', label: 'Z entry threshold', type: 'number', min: 0.5, max: 2.5, step: 0.1, default: 1.1 },
      { key: 'maxHalfLife', label: 'Max half-life (bars)', type: 'number', min: 1, max: 20, default: 6 },
    ],
    evaluate: (candles, p) => {
      const ou = ouState(candles.map((c) => c.close), num(p, 'window', 120))
      const ze = num(p, 'zEntry', 1.1)
      const maxHL = num(p, 'maxHalfLife', 6)
      if (!ou.meanReverting) return { direction: 'none', score: 0, notes: `no reversion edge (t ${ou.tStat.toFixed(1)})` }
      if (ou.halfLifeBars > maxHL) return { direction: 'none', score: 0, notes: `half-life ${ou.halfLifeBars.toFixed(1)}b too slow for a scalp (cap ${maxHL}b)` }
      if (Math.abs(ou.z) < ze) return { direction: 'none', score: 0, notes: `z ${ou.z.toFixed(2)} inside ±${ze}σ - waiting for the next wobble` }
      const speedBonus = clamp((maxHL - ou.halfLifeBars) * 6, 0, 30)
      const score = clamp(48 + (Math.abs(ou.z) - ze) * 14 + speedBonus, 42, 94)
      if (ou.z <= -ze) return { direction: 'call', score, notes: `fast fade: z ${ou.z.toFixed(2)}σ below μ · HL ${ou.halfLifeBars.toFixed(1)}b (quick round-trip)` }
      return { direction: 'put', score, notes: `fast fade: z ${ou.z.toFixed(2)}σ above μ · HL ${ou.halfLifeBars.toFixed(1)}b (quick round-trip)` }
    },
  },
  {
    id: 'kalman-ou-vol-regime',
    name: 'Kalman Volatility Regime Break',
    description: "Tracks the OU-fitted process noise (sigma) against its own longer-run baseline: when the current window's noise has compressed well below baseline (an artificial calm the market hasn't priced in) AND price pushes to the edge of its recent range, bets on the expansion breaking in that direction.",
    params: [
      { key: 'window', label: 'Fast window', type: 'number', min: 40, max: 200, default: 90 },
      { key: 'baseWindow', label: 'Baseline window', type: 'number', min: 120, max: 500, default: 300 },
      { key: 'compressRatio', label: 'Compression ratio', type: 'number', min: 0.3, max: 0.9, step: 0.05, default: 0.6 },
      { key: 'rangeLookback', label: 'Range lookback', type: 'number', min: 10, max: 60, default: 20 },
    ],
    evaluate: (candles, p) => {
      const closesArr = candles.map((c) => c.close)
      const highArr = candles.map((c) => c.high)
      const lowArr = candles.map((c) => c.low)
      const window = num(p, 'window', 90)
      const baseWindow = Math.max(window + 20, num(p, 'baseWindow', 300))
      const ratio = num(p, 'compressRatio', 0.6)
      const lookback = Math.round(num(p, 'rangeLookback', 20))
      const fast = ouEstimate(closesArr, window)
      const base = ouEstimate(closesArr, baseWindow)
      const baseSigma = base.sigmaEq > 1e-9 ? base.sigmaEq : (fast.sigmaEq || 1)
      const compression = fast.sigmaEq / baseSigma
      if (!(compression <= ratio)) return { direction: 'none', score: 0, notes: `sigma ${fast.sigmaEq.toFixed(4)} vs baseline ${baseSigma.toFixed(4)} (ratio ${compression.toFixed(2)}) - no compression` }
      const dch = ta.donchian(highArr, lowArr, lookback)
      const upper = dch.upper[dch.upper.length - 1]
      const lower = dch.lower[dch.lower.length - 1]
      const lastPrice = closesArr[closesArr.length - 1]
      const nearTop = upper > lower ? (lastPrice - lower) / (upper - lower) : 0.5
      const score = clamp(45 + (ratio - compression) * 120, 40, 92)
      if (nearTop >= 0.9) return { direction: 'call', score, notes: `vol compressed ${(compression * 100).toFixed(0)}% of baseline, pressing the ${lookback}-bar range high - expansion setup` }
      if (nearTop <= 0.1) return { direction: 'put', score, notes: `vol compressed ${(compression * 100).toFixed(0)}% of baseline, pressing the ${lookback}-bar range low - expansion setup` }
      return { direction: 'none', score: clamp((0.5 - Math.abs(nearTop - 0.5)) * 20, -20, 20), notes: `vol compressed but price mid-range (${(nearTop * 100).toFixed(0)}%) - no edge yet` }
    },
  },
  {
    id: 'kalman-ou-adaptive-trend',
    name: 'Kalman Adaptive Mean Trend',
    description: 'Re-fits the OU equilibrium on a short rolling window so theta itself becomes an ultra-smooth, lag-light trend line. When that adaptive mean is sloping, only takes mean-reversion dips/rallies IN the direction of the slope (buy dips in an uptrend, sell rallies in a downtrend) instead of fading every stretch blindly.',
    params: [
      { key: 'window', label: 'Adaptive window', type: 'number', min: 30, max: 200, default: 80 },
      { key: 'slopeLookback', label: 'Slope lookback (bars)', type: 'number', min: 5, max: 60, default: 20 },
      { key: 'minSlopePct', label: 'Min slope % (of price)', type: 'number', min: 0.01, max: 1, step: 0.01, default: 0.05 },
      { key: 'zEntry', label: 'Z entry threshold', type: 'number', min: 0.5, max: 3, step: 0.1, default: 1.2 },
    ],
    evaluate: (candles, p) => {
      const closesArr = candles.map((c) => c.close)
      const window = num(p, 'window', 80)
      const slopeLB = Math.round(num(p, 'slopeLookback', 20))
      const minSlopePct = num(p, 'minSlopePct', 0.05)
      const ze = num(p, 'zEntry', 1.2)
      if (closesArr.length < window + slopeLB + 5) return { direction: 'none', score: 0, notes: 'warming up' }
      const nowEst = ouEstimate(closesArr, window)
      const pastEst = ouEstimate(closesArr.slice(0, closesArr.length - slopeLB), window)
      const lastPrice = closesArr[closesArr.length - 1]
      const slopePct = ((nowEst.theta - pastEst.theta) / Math.max(1e-9, Math.abs(pastEst.theta))) * 100
      const sigmaEq = nowEst.sigmaEq > 1e-9 ? nowEst.sigmaEq : 1
      const z = clamp((lastPrice - nowEst.theta) / sigmaEq, -12, 12)
      if (Math.abs(slopePct) < minSlopePct) {
        return { direction: 'none', score: 0, notes: `μ flat (slope ${slopePct.toFixed(3)}%/${slopeLB}b) - no trend bias, sitting out` }
      }
      const trendUp = slopePct > 0
      if (trendUp && z <= -ze) {
        return { direction: 'call', score: clamp(50 + Math.abs(slopePct) * 20 + (Math.abs(z) - ze) * 10, 45, 94), notes: `μ rising ${slopePct.toFixed(2)}%/${slopeLB}b, dip ${z.toFixed(2)}σ below trend mean - buy the dip` }
      }
      if (!trendUp && z >= ze) {
        return { direction: 'put', score: clamp(50 + Math.abs(slopePct) * 20 + (Math.abs(z) - ze) * 10, 45, 94), notes: `μ falling ${slopePct.toFixed(2)}%/${slopeLB}b, rally ${z.toFixed(2)}σ above trend mean - sell the rally` }
      }
      return { direction: 'none', score: 0, notes: `μ ${trendUp ? 'rising' : 'falling'} ${slopePct.toFixed(2)}%/${slopeLB}b but no ${trendUp ? 'dip' : 'rally'} entry yet (z ${z.toFixed(2)})` }
    },
  },
  {
    id: 'mc-fairvalue-edge',
    name: 'Monte Carlo Fair-Value Edge',
    description: "The classic quant-arb idea (exotic-option pricing vs a replicated hedge, and vol-arb on the market's implied range probability) adapted honestly to a binary bet: there's no options chain or IV surface on this platform to price against, so instead of pricing an exotic derivative it prices the binary itself. Bootstrap-resamples the asset's own historical return distribution (not a Gaussian assumption - captures real fat tails/skew, the 'path model') to get the TRUE simulated probability the option finishes ITM, and trades only when that beats the broker's payout-implied breakeven probability by a real margin - literally 'the market misprices this, take the statistical edge', just against your own broker's payout instead of an options market.",
    params: [
      { key: 'lookback', label: 'Return sample window (bars)', type: 'number', min: 100, max: 500, default: 300 },
      { key: 'horizon', label: 'Simulation horizon (bars = expiry)', type: 'number', min: 1, max: 20, default: 1 },
      { key: 'nSims', label: 'Simulated paths', type: 'number', min: 500, max: 5000, default: 2000 },
      { key: 'payoutPct', label: 'Assumed payout % (match your broker payout)', type: 'number', min: 50, max: 95, default: 85 },
      { key: 'minEdgePct', label: 'Min edge over breakeven (pts)', type: 'number', min: 1, max: 20, default: 4 },
    ],
    evaluate: (candles, p) => {
      const lookback = Math.round(num(p, 'lookback', 300))
      const horizon = Math.max(1, Math.round(num(p, 'horizon', 1)))
      const nSims = Math.min(5000, Math.max(200, Math.round(num(p, 'nSims', 2000))))
      const payout = num(p, 'payoutPct', 85) / 100
      const minEdge = num(p, 'minEdgePct', 4) / 100
      const closesArr = candles.map((c) => c.close)
      if (closesArr.length < lookback + 5) return { direction: 'none', score: 0, notes: 'warming up' }
      const rets = logReturns(closesArr.slice(-(lookback + 1)))
      if (rets.length < 30) return { direction: 'none', score: 0, notes: 'not enough return history to sample' }
      // deterministic seed from the data itself (not wall-clock) - the same
      // history always reproduces the same simulated probability, which
      // matters for backtest/optimizer determinism.
      const seed = (Math.round(closesArr[closesArr.length - 1] * 1e6) ^ (closesArr.length * 2654435761)) >>> 0
      const r = rng(seed || 1)
      const last = closesArr[closesArr.length - 1]
      let up = 0
      for (let s = 0; s < nSims; s++) {
        let price = last
        for (let t = 0; t < horizon; t++) price *= Math.exp(rets[Math.floor(r() * rets.length)] ?? 0)
        if (price > last) up++
      }
      const probUp = up / nSims
      const probDown = 1 - probUp
      // breakeven win probability for a binary paying `payout` on a win and
      // losing the full stake on a loss: P*payout = (1-P) => P = 1/(1+payout)
      const breakeven = 1 / (1 + payout)
      const edgeUp = probUp - breakeven
      const edgeDown = probDown - breakeven
      if (edgeUp >= minEdge && edgeUp >= edgeDown) {
        return { direction: 'call', score: clamp(45 + edgeUp * 300, 40, 94), notes: `MC P(up) ${(probUp * 100).toFixed(1)}% vs breakeven ${(breakeven * 100).toFixed(1)}% (${nSims} bootstrap sims, ${horizon}b horizon) - edge +${(edgeUp * 100).toFixed(1)}pt` }
      }
      if (edgeDown >= minEdge) {
        return { direction: 'put', score: clamp(45 + edgeDown * 300, 40, 94), notes: `MC P(down) ${(probDown * 100).toFixed(1)}% vs breakeven ${(breakeven * 100).toFixed(1)}% (${nSims} bootstrap sims, ${horizon}b horizon) - edge +${(edgeDown * 100).toFixed(1)}pt` }
      }
      return { direction: 'none', score: 0, notes: `MC P(up) ${(probUp * 100).toFixed(1)}% vs breakeven ${(breakeven * 100).toFixed(1)}% - no statistical edge` }
    },
  },
  {
    id: 'kalman-mc-reversion-prob',
    name: 'Kalman-Monte Carlo Reversion Probability',
    description: "Smart mean-reversion: instead of a static z-score band (like Kalman OU Reversion), it forward-simulates the FITTED OU process itself thousands of times from the current stretch and measures the actual probability of snapping back to equilibrium within the trade's own horizon - so a big stretch with a fast half-life can outscore a small stretch with a slow one, exactly the failure mode static bands have. No options/greeks on this platform, so this trades the reversion directly instead of a hedged option position.",
    params: [
      { key: 'window', label: 'OU estimation window', type: 'number', min: 60, max: 500, default: 240 },
      { key: 'horizon', label: 'Simulation horizon (bars = expiry)', type: 'number', min: 1, max: 30, default: 4 },
      { key: 'nSims', label: 'Simulated paths', type: 'number', min: 500, max: 4000, default: 1500 },
      { key: 'zEntry', label: 'Min current stretch (z)', type: 'number', min: 0.5, max: 3, step: 0.1, default: 1 },
      { key: 'snapProb', label: 'Min P(reversion within horizon)', type: 'number', min: 0.5, max: 0.98, step: 0.01, default: 0.85 },
      { key: 'tolerance', label: 'Reversion tolerance (fraction of sigma_eq)', type: 'number', min: 0.1, max: 1, step: 0.05, default: 0.25 },
    ],
    evaluate: (candles, p) => {
      const window = num(p, 'window', 240)
      const horizon = Math.max(1, Math.round(num(p, 'horizon', 4)))
      const nSims = Math.min(4000, Math.max(200, Math.round(num(p, 'nSims', 1500))))
      const ze = num(p, 'zEntry', 1)
      const snapProb = num(p, 'snapProb', 0.85)
      const tol = num(p, 'tolerance', 0.25)
      const closesArr = candles.map((c) => c.close)
      const ou = ouState(closesArr, window)
      if (!ou.meanReverting) return { direction: 'none', score: 0, notes: `not mean-reverting (t ${ou.tStat.toFixed(1)})` }
      if (Math.abs(ou.z) < ze) return { direction: 'none', score: 0, notes: `z ${ou.z.toFixed(2)} below entry stretch ${ze}` }
      const sigmaEq = ou.sigmaEq > 1e-12 ? ou.sigmaEq : 1
      const band = tol * sigmaEq
      const last = closesArr[closesArr.length - 1]
      const seed = (Math.round(last * 1e6) ^ (closesArr.length * 2654435761) ^ Math.round(ou.phi * 1e6)) >>> 0
      const r = rng(seed || 1)
      let reverted = 0
      for (let s = 0; s < nSims; s++) {
        let x = last
        let hit = false
        for (let t = 0; t < horizon; t++) {
          x = ou.theta + ou.phi * (x - ou.theta) + ou.sigmaEps * gauss(r)
          if (Math.abs(x - ou.theta) <= band) { hit = true; break }
        }
        if (hit) reverted++
      }
      const prob = reverted / nSims
      if (prob < snapProb) {
        return { direction: 'none', score: 0, notes: `P(revert in ${horizon}b) ${(prob * 100).toFixed(0)}% below ${(snapProb * 100).toFixed(0)}% - stretch may outlast the trade` }
      }
      const score = clamp(50 + (prob - snapProb) * 200 + Math.min(15, ou.tStat * 2), 45, 95)
      const dir = ou.z < 0 ? 'call' : 'put'
      return { direction: dir, score, notes: `${dir === 'call' ? 'Below' : 'Above'} μ (z ${ou.z.toFixed(2)}), MC P(revert in ${horizon}b) ${(prob * 100).toFixed(0)}% · HL ${ou.halfLifeBars.toFixed(0)}b` }
    },
  },
  {
    id: 'confluence-core',
    name: 'Confluence Core (Composite)',
    description: 'The OS composite signal itself: weighted trend + momentum + mean-reversion + Markov + patterns vote.',
    params: [
      { key: 'threshold', label: 'Score threshold', type: 'number', min: 10, max: 60, default: 22 },
    ],
    evaluate: (candles, p) => {
      // lightweight composite: reuse signal engine pieces without full monte carlo
      const c = candles.map((k) => k.close)
      const h = candles.map((k) => k.high)
      const l = candles.map((k) => k.low)
      const rsiV = last(ta.rsi(c, 14))
      const md = ta.macd(c)
      const bb = ta.bollinger(c, 20, 2)
      const adxRes = ta.adx(h, l, c, 14)
      const m = markovChain(c, { lookback: 500 })
      const hits = detectPatterns(candles, 6)
      const pB = patternBias(hits)
      let score = 0
      score += (rsiV > 50 ? 1 : -1) * 12
      score += Math.sign(last(md.hist) || 0) * 12
      score += clamp((0.5 - (last(bb.percentB) || 0.5)) * 30, -12, 12)
      score += (last(adxRes.plusDI) > last(adxRes.minusDI) ? 1 : -1) * Math.min(14, last(adxRes.adx) || 0) * 0.8
      score += clamp((m.probUp - 0.5) * 90, -20, 20)
      score += clamp(pB * 5, -12, 12)
      score = clamp(score, -100, 100)
      const thr = num(p, 'threshold', 22)
      if (score >= thr) return { direction: 'call', score, notes: `Composite ${score.toFixed(0)} (Markov P(up) ${(m.probUp * 100).toFixed(0)}%)` }
      if (score <= -thr) return { direction: 'put', score, notes: `Composite ${score.toFixed(0)}` }
      return { direction: 'none', score, notes: `Composite ${score.toFixed(0)} below threshold` }
    },
  },
  {
    id: 'vsk-synthesis',
    name: 'VSK Synthesis (4-Layer)',
    description:
      'Layered synthesis: L1 VWAP z-score arms the reversion at the boundary, L2 volatility squeeze blocks runaway trends, L3 Kalman curve confirms the structural turn, L4 PSAR on the FILTERED curve fires the exact flip bar. Entry = all four agree.',
    params: [
      { key: 'vwapPeriod', label: 'L1 VWAP window', type: 'number', min: 10, max: 240, default: VSK_DEFAULTS.vwapPeriod },
      { key: 'zEntry', label: 'L1 z entry', type: 'number', min: 1, max: 4, step: 0.1, default: VSK_DEFAULTS.zEntry },
      { key: 'armWindow', label: 'L1 arm window (bars)', type: 'number', min: 1, max: 20, default: VSK_DEFAULTS.armWindow },
      { key: 'widthPctRunaway', label: 'L2 width runaway %', type: 'number', min: 50, max: 100, default: VSK_DEFAULTS.widthPctRunaway },
      { key: 'slopePctRunaway', label: 'L2 slope runaway %', type: 'number', min: 50, max: 100, default: VSK_DEFAULTS.slopePctRunaway },
      { key: 'kalmanQ', label: 'L3 Kalman Q', type: 'number', min: 0.001, max: 0.2, step: 0.001, default: VSK_DEFAULTS.kalmanQ },
      { key: 'kalmanR', label: 'L3 Kalman R', type: 'number', min: 0.1, max: 10, step: 0.1, default: VSK_DEFAULTS.kalmanR },
      { key: 'sarStep', label: 'L4 SAR step', type: 'number', min: 0.005, max: 0.1, step: 0.005, default: VSK_DEFAULTS.sarStep },
      { key: 'sarMax', label: 'L4 SAR max AF', type: 'number', min: 0.05, max: 0.5, step: 0.01, default: VSK_DEFAULTS.sarMax },
    ],
    evaluate: (candles, p) =>
      vskEvaluate(candles, {
        vwapPeriod: num(p, 'vwapPeriod', VSK_DEFAULTS.vwapPeriod),
        zEntry: num(p, 'zEntry', VSK_DEFAULTS.zEntry),
        armWindow: num(p, 'armWindow', VSK_DEFAULTS.armWindow),
        widthPctRunaway: num(p, 'widthPctRunaway', VSK_DEFAULTS.widthPctRunaway),
        slopePctRunaway: num(p, 'slopePctRunaway', VSK_DEFAULTS.slopePctRunaway),
        kalmanQ: num(p, 'kalmanQ', VSK_DEFAULTS.kalmanQ),
        kalmanR: num(p, 'kalmanR', VSK_DEFAULTS.kalmanR),
        sarStep: num(p, 'sarStep', VSK_DEFAULTS.sarStep),
        sarMax: num(p, 'sarMax', VSK_DEFAULTS.sarMax),
      }),
  },
  {
    id: 'tsk-synthesis',
    name: 'TSK Synthesis (4-Layer, Volume-Free)',
    description:
      'VSK\'s volume-free sibling: L1 least-squares TRENDLINE z-score arms the setup when price stretches N sigmas off the fitted trend (deviation channel - no VWAP, no volume), L2 volatility squeeze blocks runaway trends, L3 Kalman curve confirms the structural turn, L4 PSAR on the FILTERED curve fires the exact flip bar. Entry = all four agree.',
    params: [
      { key: 'tlPeriod', label: 'L1 trendline window', type: 'number', min: 10, max: 240, default: TSK_DEFAULTS.tlPeriod },
      { key: 'zEntry', label: 'L1 z entry', type: 'number', min: 1, max: 4, step: 0.1, default: TSK_DEFAULTS.zEntry },
      { key: 'armWindow', label: 'L1 arm window (bars)', type: 'number', min: 1, max: 40, default: TSK_DEFAULTS.armWindow },
      { key: 'widthPctRunaway', label: 'L2 width runaway %', type: 'number', min: 50, max: 100, default: TSK_DEFAULTS.widthPctRunaway },
      { key: 'slopePctRunaway', label: 'L2 slope runaway %', type: 'number', min: 50, max: 100, default: TSK_DEFAULTS.slopePctRunaway },
      { key: 'kalmanQ', label: 'L3 Kalman Q', type: 'number', min: 0.001, max: 0.2, step: 0.001, default: TSK_DEFAULTS.kalmanQ },
      { key: 'kalmanR', label: 'L3 Kalman R', type: 'number', min: 0.1, max: 10, step: 0.1, default: TSK_DEFAULTS.kalmanR },
      { key: 'sarStep', label: 'L4 SAR step', type: 'number', min: 0.005, max: 0.1, step: 0.005, default: TSK_DEFAULTS.sarStep },
      { key: 'sarMax', label: 'L4 SAR max AF', type: 'number', min: 0.05, max: 0.5, step: 0.01, default: TSK_DEFAULTS.sarMax },
    ],
    evaluate: (candles, p) =>
      tskEvaluate(candles, {
        tlPeriod: num(p, 'tlPeriod', TSK_DEFAULTS.tlPeriod),
        zEntry: num(p, 'zEntry', TSK_DEFAULTS.zEntry),
        armWindow: num(p, 'armWindow', TSK_DEFAULTS.armWindow),
        widthPctRunaway: num(p, 'widthPctRunaway', TSK_DEFAULTS.widthPctRunaway),
        slopePctRunaway: num(p, 'slopePctRunaway', TSK_DEFAULTS.slopePctRunaway),
        kalmanQ: num(p, 'kalmanQ', TSK_DEFAULTS.kalmanQ),
        kalmanR: num(p, 'kalmanR', TSK_DEFAULTS.kalmanR),
        sarStep: num(p, 'sarStep', TSK_DEFAULTS.sarStep),
        sarMax: num(p, 'sarMax', TSK_DEFAULTS.sarMax),
      }),
  },
  {
    id: 'ensemble-vote',
    name: 'Ensemble (Majority Vote)',
    description:
      'Runs several independent strategies on the same candles and only fires when at least `minAgree` of them agree on direction with a per-member score above `voteMinScore` - a higher-precision filter that trades the intersection of independent edges instead of any single one\'s false positives. Score is the average |score| of the agreeing members, scaled down slightly for consensus strength (fewer agreeing members = more shaved off). `members` is a comma-separated list of strategy ids (builtin only - no nested ensembles, no custom: lab strategies); a member id that can\'t be found is skipped and does not count toward the vote.',
    params: [
      { key: 'members', label: 'Member strategies (comma-separated ids)', type: 'select', default: 'ema-trend,rsi-reversion,markov-edge' },
      { key: 'voteMinScore', label: 'Per-member score to count as a vote', type: 'number', min: 0, max: 100, default: 40 },
      { key: 'minAgree', label: 'Min members that must agree', type: 'number', min: 2, max: 6, default: 2 },
    ],
    evaluate: (candles, p) => {
      const ids = String(p.members ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && s !== 'ensemble-vote')
      const voteMinScore = num(p, 'voteMinScore', 40)
      const minAgree = Math.max(2, Math.round(num(p, 'minAgree', 2)))
      const votes: { id: string; direction: 'call' | 'put'; score: number }[] = []
      const skipped: string[] = []
      for (const id of ids) {
        const strat = STRATEGIES.find((s) => s.id === id)
        if (!strat) {
          skipped.push(id)
          continue
        }
        try {
          const merged: Record<string, number | string> = {}
          for (const dp of strat.params) merged[dp.key] = dp.default
          const ev = strat.evaluate(candles, merged)
          if ((ev.direction === 'call' || ev.direction === 'put') && Math.abs(ev.score) >= voteMinScore) {
            votes.push({ id, direction: ev.direction, score: Math.abs(ev.score) })
          }
        } catch {
          skipped.push(id)
        }
      }
      const calls = votes.filter((v) => v.direction === 'call')
      const puts = votes.filter((v) => v.direction === 'put')
      const skippedNote = skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''
      const decide = (side: 'call' | 'put', agreeing: typeof calls, otherCount: number) => {
        if (agreeing.length < minAgree || agreeing.length <= otherCount) return null
        const avg = agreeing.reduce((a, v) => a + v.score, 0) / agreeing.length
        // consensus discount: needing only the bare minimum to agree is a
        // weaker signal than every member piling on - shave up to 15% off
        // when agreement is right at the minAgree floor.
        const consensusFactor = 1 - Math.max(0, (ids.length - agreeing.length) / Math.max(1, ids.length)) * 0.15
        const score = clamp(avg * consensusFactor, 30, 100)
        return {
          direction: side,
          score,
          notes: `${agreeing.length}/${ids.length - skipped.length} agree ${side.toUpperCase()} (${agreeing.map((v) => v.id).join(', ')})${skippedNote}`,
        }
      }
      return (
        decide('call', calls, puts.length) ??
        decide('put', puts, calls.length) ?? {
          direction: 'none',
          score: 0,
          notes: `no ${minAgree}+ consensus - ${calls.length} call vs ${puts.length} put of ${ids.length - skipped.length} usable members${skippedNote}`,
        }
      )
    },
  },
]

export const getStrategy = (id: string): StrategyDef | undefined => STRATEGIES.find((s) => s.id === id)

export function defaultParams(s: StrategyDef): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const p of s.params) out[p.key] = p.default
  return out
}
