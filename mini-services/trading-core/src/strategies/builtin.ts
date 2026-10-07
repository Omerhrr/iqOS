// IQAIR//OS - Strategy registry
// Data-driven strategy definitions. `evaluate` is pure: candles + params in,
// a directional eval out. Used by the Strategy Lab, the backtester and the agent.
import type { StrategyDef } from '../types'
import * as ta from '../analytics/indicators'
import { markovChain, fitDiscreteMarkov, logReturns, stdev, mean, rng, gauss, ewmaVol, garchVol, supportResistance } from '../analytics/quant'
import { detectPatterns, patternBias } from '../analytics/patterns'
import { ouEstimate, ouState } from '../analytics/kalman'
import { vskEvaluate, VSK_DEFAULTS } from '../analytics/vsk'
import { tskEvaluate, TSK_DEFAULTS } from '../analytics/tsk'
import { confluenceSignalOnly } from '../analytics/engine'
import { findPivots } from '../analytics/chart-patterns'
import { computeCandleDelta, computeCumulativeDelta, computeVolumeProfile } from '../analytics/orderflow'
import { renkoBricks } from '../analytics/renko'
import { pointFigure } from '../analytics/pointfigure'
import { rangeBars } from '../analytics/rangebars'
import { volumeBars } from '../analytics/volumebars'
import { computeFootprint } from '../analytics/footprint'
import { computeTpo } from '../analytics/tpo'
import { realizedUpProb, ivFromPayout } from '../analytics/ivhv'

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
      // Task 58 (P3): the old guard was a tautology (n < min(lookback+2, n)
      // is false for every n) so it never ran; markovChain self-limits its
      // lookback (quant.ts), so the meaningful floor is a history minimum.
      if (candles.length < 60) return { direction: 'none', score: 0, notes: 'not enough history' }
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
    id: 'drift-follower',
    name: 'OTC Drift Follower',
    description: 'Adaptive majority-side follower for OTC feeds: counts DECIDED settle direction (up vs down among non-flat transitions - flats are pushes in a binary trade and must not count as wins) over the last K candles and bets the dominant side only when the imbalance clears a binomial z-gate. Zero lookahead and self-disarming. Born from a 30-day / 83-pair audit: flat-heavy feeds (BONK 17.8% flats) make naive up-rate tests read phantom drift, and draw-counted-as-win backtests inflate majority-side win rate from ~41% (honest, LOSING at 0.82 payout) to ~59%. No harvested pair cleared the decided-side gate - this strategy stands down until a real imbalance appears.',
    params: [
      { key: 'k', label: 'Rolling window (bars)', type: 'number', min: 20, max: 2000, default: 500 },
      { key: 'minZ', label: 'Min imbalance z', type: 'number', min: 0.5, max: 5, step: 0.1, default: 2 },
    ],
    evaluate: (candles, p) => {
      const k = Math.max(10, Math.min(num(p, 'k', 500), candles.length - 1))
      const closes = candles.slice(-k - 1).map((c) => c.close)
      let up = 0
      let down = 0
      for (let i = 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1]
        if (d > 0) up++
        else if (d < 0) down++
      }
      const n = up + down
      if (n < 10) return { direction: 'none', score: 0, notes: 'not enough settled bars' }
      const upShare = up / n
      const z = (upShare - 0.5) / Math.sqrt(0.25 / n) // binomial z vs fair coin
      const minZ = num(p, 'minZ', 2)
      if (z >= minZ) return { direction: 'call', score: clamp(40 + Math.abs(z) * 8, 40, 95), notes: `up ${(upShare * 100).toFixed(1)}% of ${n}, z +${z.toFixed(1)}` }
      if (z <= -minZ) return { direction: 'put', score: clamp(40 + Math.abs(z) * 8, 40, 95), notes: `down ${((1 - upShare) * 100).toFixed(1)}% of ${n}, z ${z.toFixed(1)}` }
      return { direction: 'none', score: 0, notes: `up ${(upShare * 100).toFixed(1)}% of ${n}, z ${z.toFixed(1)} < gate ${minZ}` }
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
      // Task 58 (P2): percentB == 0 means price sits EXACTLY on the lower
      // band - the strongest mean-reversion reading - but `|| 0.5` coerced
      // that falsy 0 to neutral, killing the signal precisely when it was
      // strongest (plausible on lattice-quantized OTC prices).
      const pb = last(bb.percentB)
      score += Number.isFinite(pb) ? clamp((0.5 - (pb as number)) * 30, -12, 12) : 0
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
    id: 'confluence-full',
    name: 'Confluence Signal (Full Panel)',
    description:
      'The EXACT live Confluence Signal panel / confluence_read engine as a backtestable strategy - all 14 weighted factors across trend (EMA stack, ADX/DI, regression slope, Supertrend), momentum (RSI, MACD, Stochastic), mean-reversion (Bollinger %B, Z-Score, Williams %R), statistical (Markov P(up), Hurst, Kalman/OU stretch) and pattern bias, netted into the same -100..100 score and confidence read you see on the panel. This is a strictly bigger model than confluence-core (which only has 6 of these 14 factors and omits Hurst and Kalman/OU entirely) - use this one when you want "does what the panel shows actually hold up as an edge", and confluence-core when you want the lighter/faster approximation.',
    params: [
      { key: 'threshold', label: 'Score threshold', type: 'number', min: 10, max: 60, default: 22 },
      { key: 'minConfidence', label: 'Min confidence %', type: 'number', min: 0, max: 100, default: 0 },
    ],
    evaluate: (candles, p) => {
      const sig = confluenceSignalOnly(candles, 'STRAT', '1m')
      const thr = num(p, 'threshold', 22)
      const minConf = num(p, 'minConfidence', 0)
      if (sig.confidence < minConf) {
        return { direction: 'none', score: sig.score, notes: `Confluence ${sig.score.toFixed(0)} but confidence ${sig.confidence.toFixed(0)}% below floor ${minConf}%` }
      }
      if (sig.score >= thr) return { direction: 'call', score: sig.score, notes: `Confluence ${sig.score.toFixed(0)} · conf ${sig.confidence.toFixed(0)}%` }
      if (sig.score <= -thr) return { direction: 'put', score: sig.score, notes: `Confluence ${sig.score.toFixed(0)} · conf ${sig.confidence.toFixed(0)}%` }
      return { direction: 'none', score: sig.score, notes: `Confluence ${sig.score.toFixed(0)} below threshold · conf ${sig.confidence.toFixed(0)}%` }
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
  {
    id: 'ichimoku-cloud',
    name: 'Ichimoku Cloud',
    description:
      'Classic Ichimoku: CALL when price sits above the cloud (max of senkou A/B) AND tenkan crosses above kijun; PUT the mirror below the cloud. Cloud thickness (relative to price) gates confidence - a razor-thin cloud means the cloud itself has little conviction, so thin-cloud crosses score lower even when the cross is real.',
    params: [
      { key: 'conv', label: 'Tenkan period', type: 'number', min: 5, max: 20, default: 9 },
      { key: 'base', label: 'Kijun period', type: 'number', min: 15, max: 40, default: 26 },
      { key: 'spanB', label: 'Senkou B period', type: 'number', min: 30, max: 80, default: 52 },
      { key: 'minCloudPct', label: 'Min cloud thickness %', type: 'number', min: 0, max: 1, step: 0.01, default: 0 },
    ],
    evaluate: (candles, p) => {
      const h = candles.map((k) => k.high)
      const l = candles.map((k) => k.low)
      const c = candles.map((k) => k.close)
      const conv = Math.round(num(p, 'conv', 9))
      const base = Math.round(num(p, 'base', 26))
      const spanB = Math.round(num(p, 'spanB', 52))
      const minCloudPct = num(p, 'minCloudPct', 0)
      const ich = ta.ichimoku(h, l, conv, base, spanB)
      const i = c.length - 1
      const tk = ich.tenkan[i]
      const kj = ich.kijun[i]
      const tkPrev = ich.tenkan[i - 1]
      const kjPrev = ich.kijun[i - 1]
      const sa = ich.senkouA[i]
      const sb = ich.senkouB[i]
      if (![tk, kj, tkPrev, kjPrev, sa, sb].every(Number.isFinite)) {
        return { direction: 'none', score: 0, notes: 'warming up (cloud/tenkan/kijun not formed yet)' }
      }
      const price = c[i]
      const cloudTop = Math.max(sa, sb)
      const cloudBot = Math.min(sa, sb)
      const cloudPct = (cloudTop - cloudBot) / price
      const aboveCloud = price > cloudTop
      const belowCloud = price < cloudBot
      const bullCross = tkPrev <= kjPrev && tk > kj
      const bearCross = tkPrev >= kjPrev && tk < kj
      const thinCloud = cloudPct < minCloudPct
      const baseScore = clamp(55 + Math.abs(tk - kj) / (Math.abs(price) * 0.001 || 1), 50, 90)
      const score = thinCloud ? clamp(baseScore * 0.6, 35, 60) : baseScore
      if (aboveCloud && bullCross) return { direction: 'call', score, notes: `above cloud, tenkan/kijun bull cross${thinCloud ? ' (thin cloud - weak)' : ''}` }
      if (belowCloud && bearCross) return { direction: 'put', score, notes: `below cloud, tenkan/kijun bear cross${thinCloud ? ' (thin cloud - weak)' : ''}` }
      return {
        direction: 'none',
        score: 0,
        notes: aboveCloud ? 'above cloud, no fresh cross' : belowCloud ? 'below cloud, no fresh cross' : 'price inside the cloud (chop)',
      }
    },
  },
  {
    id: 'vwap-reversion',
    name: 'VWAP Reversion',
    description:
      'Fades the stretch of price away from session VWAP: CALL when price is zEntry+ standard deviations below VWAP, PUT when that far above. Same z-score-from-equilibrium shape as Kalman OU Reversion, but against the volume-weighted average price instead of a fitted OU mean - cheaper to compute and a useful cross-check against the OU read on the same instrument. VWAP here runs cumulative over the fetched candle window (no session reset), so treat it as "VWAP of this window" rather than "today\'s session VWAP".',
    params: [
      { key: 'window', label: 'Stdev window (bars)', type: 'number', min: 20, max: 300, default: 100 },
      { key: 'zEntry', label: 'Z entry threshold', type: 'number', min: 1, max: 3.5, step: 0.1, default: 1.5 },
    ],
    evaluate: (candles, p) => {
      const c = candles.map((k) => k.close)
      const vw = ta.vwap(candles)
      const window = Math.round(num(p, 'window', 100))
      const zEntry = num(p, 'zEntry', 1.5)
      const n = c.length
      const w = Math.min(window, n - 1)
      if (w < 10) return { direction: 'none', score: 0, notes: 'warming up' }
      const dists: number[] = []
      for (let i = n - w; i < n; i++) dists.push(c[i] - vw[i])
      const std = stdev(dists)
      const dist = c[n - 1] - vw[n - 1]
      if (std <= 1e-9) return { direction: 'none', score: 0, notes: 'no variance vs VWAP yet' }
      const z = dist / std
      const score = clamp(45 + (Math.abs(z) - zEntry) * 18, 40, 90)
      if (z <= -zEntry) return { direction: 'call', score, notes: `z ${z.toFixed(2)}σ below VWAP (${vw[n - 1].toFixed(5)})` }
      if (z >= zEntry) return { direction: 'put', score, notes: `z ${z.toFixed(2)}σ above VWAP (${vw[n - 1].toFixed(5)})` }
      return { direction: 'none', score: 0, notes: `z ${z.toFixed(2)} inside ±${zEntry}σ of VWAP` }
    },
  },
  {
    id: 'keltner-chandelier',
    name: 'Keltner Breakout + Chandelier',
    description:
      'Trend-continuation on a Keltner channel breakout (ATR-scaled, less noisy than Bollinger): CALL on a close above the upper band, PUT below the lower band. Reports the Chandelier Exit line (a trailing ATR stop) in the notes as the invalidation reference for managing the position manually - the binary engine itself is fixed-expiry, so the Chandelier line is informational context here, not an automatic exit.',
    params: [
      { key: 'period', label: 'Keltner period', type: 'number', min: 10, max: 40, default: 20 },
      { key: 'mult', label: 'Keltner ATR mult', type: 'number', min: 1, max: 4, step: 0.1, default: 2 },
      { key: 'chandPeriod', label: 'Chandelier period', type: 'number', min: 10, max: 40, default: 22 },
      { key: 'chandMult', label: 'Chandelier ATR mult', type: 'number', min: 1, max: 5, step: 0.1, default: 3 },
    ],
    evaluate: (candles, p) => {
      const h = candles.map((k) => k.high)
      const l = candles.map((k) => k.low)
      const c = candles.map((k) => k.close)
      const period = Math.round(num(p, 'period', 20))
      const mult = num(p, 'mult', 2)
      const chandPeriod = Math.round(num(p, 'chandPeriod', 22))
      const chandMult = num(p, 'chandMult', 3)
      const kc = ta.keltner(h, l, c, period, mult)
      const ch = ta.chandelierExit(h, l, c, chandPeriod, chandMult)
      const i = c.length - 1
      const upper = kc.upper[i]
      const lower = kc.lower[i]
      const atrVal = (upper - lower) / (2 * mult) || 1
      if (![upper, lower].every(Number.isFinite)) return { direction: 'none', score: 0, notes: 'warming up' }
      const price = c[i]
      const beyondUp = (price - upper) / atrVal
      const beyondDn = (lower - price) / atrVal
      if (price > upper) {
        const score = clamp(50 + beyondUp * 25, 45, 90)
        return { direction: 'call', score, notes: `close beyond Keltner upper (${upper.toFixed(5)}) - chandelier long-stop ${Number.isFinite(ch.long[i]) ? ch.long[i].toFixed(5) : 'n/a'}` }
      }
      if (price < lower) {
        const score = clamp(50 + beyondDn * 25, 45, 90)
        return { direction: 'put', score, notes: `close beyond Keltner lower (${lower.toFixed(5)}) - chandelier short-stop ${Number.isFinite(ch.short[i]) ? ch.short[i].toFixed(5) : 'n/a'}` }
      }
      return { direction: 'none', score: 0, notes: 'inside Keltner channel' }
    },
  },
  {
    id: 'mtf-alignment',
    name: 'MTF Alignment',
    description:
      'Resamples the SAME candle series into synthetic 5x and 15x bars (e.g. on a 1m feed: the 1m series itself, a synthetic 5m, and a synthetic 15m) and checks EMA(8) vs EMA(21) trend direction on each. Fires only when minAgree of the 3 timeframes agree - this is the multi-timeframe-agreement idea behind confluence_read, pulled out into its own deployable/backtestable strategy. Needs enough history for the 15x resample to have a meaningful EMA(21) - thin history degrades gracefully by treating an unresolvable timeframe as a non-vote, not a crash.',
    params: [
      { key: 'minAgree', label: 'Min timeframes agreeing (of 3)', type: 'number', min: 2, max: 3, default: 3 },
    ],
    evaluate: (candles, p) => {
      const minAgree = Math.max(2, Math.round(num(p, 'minAgree', 3)))
      const resample = (factor: number): { close: number }[] => {
        if (factor === 1) return candles.map((k) => ({ close: k.close }))
        const out: { close: number }[] = []
        for (let i = 0; i + factor <= candles.length; i += factor) {
          out.push({ close: candles[i + factor - 1].close })
        }
        return out
      }
      const dirOf = (series: { close: number }[]): 'call' | 'put' | null => {
        if (series.length < 25) return null
        const c = series.map((s) => s.close)
        const fast = last(ta.ema(c, 8))
        const slow = last(ta.ema(c, 21))
        if (!Number.isFinite(fast) || !Number.isFinite(slow)) return null
        return fast > slow ? 'call' : fast < slow ? 'put' : null
      }
      const levels = [1, 5, 15]
      const votes = levels.map((f) => ({ f, dir: dirOf(resample(f)) })).filter((v) => v.dir !== null)
      const calls = votes.filter((v) => v.dir === 'call').length
      const puts = votes.filter((v) => v.dir === 'put').length
      const usable = votes.length
      const describe = () => votes.map((v) => `${v.f}x:${v.dir}`).join(', ')
      if (usable === 0) return { direction: 'none', score: 0, notes: 'not enough history to resample any timeframe' }
      if (calls >= minAgree && calls > puts) {
        return { direction: 'call', score: clamp(40 + calls * 18, 40, 90), notes: `${calls}/${usable} timeframes bullish (${describe()})` }
      }
      if (puts >= minAgree && puts > calls) {
        return { direction: 'put', score: clamp(40 + puts * 18, 40, 90), notes: `${puts}/${usable} timeframes bearish (${describe()})` }
      }
      return { direction: 'none', score: 0, notes: `no ${minAgree}+ agreement (${describe()})` }
    },
  },
  {
    id: 'vol-squeeze-breakout',
    name: 'Volatility Squeeze Breakout',
    description:
      'Plain Bollinger Band squeeze-then-breakout: flags a squeeze when band width sits in the bottom squeezePct percentile of its own trailing squeezeLookback history, then fires CALL/PUT if price closes beyond the band within armWindow bars of that squeeze. The simpler, single-layer sibling of VSK/TSK\'s squeeze-gate layer - useful as a baseline to check whether VSK/TSK\'s extra Kalman/PSAR machinery is actually earning its keep over this on a given instrument.',
    params: [
      { key: 'period', label: 'Bollinger period', type: 'number', min: 10, max: 40, default: 20 },
      { key: 'mult', label: 'Bollinger mult', type: 'number', min: 1, max: 3, step: 0.1, default: 2 },
      { key: 'squeezeLookback', label: 'Squeeze lookback (bars)', type: 'number', min: 40, max: 300, default: 100 },
      { key: 'squeezePct', label: 'Squeeze percentile', type: 'number', min: 5, max: 40, default: 20 },
      { key: 'armWindow', label: 'Breakout arm window (bars)', type: 'number', min: 1, max: 15, default: 5 },
    ],
    evaluate: (candles, p) => {
      const c = candles.map((k) => k.close)
      const period = Math.round(num(p, 'period', 20))
      const mult = num(p, 'mult', 2)
      const lookback = Math.round(num(p, 'squeezeLookback', 100))
      const pct = num(p, 'squeezePct', 20)
      const armWindow = Math.round(num(p, 'armWindow', 5))
      const bb = ta.bollinger(c, period, mult)
      const n = c.length
      if (n < lookback + armWindow + 5) return { direction: 'none', score: 0, notes: 'warming up' }
      const percentileRank = (idx: number): number => {
        const start = Math.max(0, idx - lookback)
        const window = bb.width.slice(start, idx + 1).filter(Number.isFinite)
        if (window.length < 10) return 1
        const w = bb.width[idx]
        if (!Number.isFinite(w)) return 1
        const below = window.filter((x) => x <= w).length
        return below / window.length
      }
      let wasSqueezed = false
      let squeezedBarsAgo = -1
      for (let back = 1; back <= armWindow; back++) {
        const idx = n - 1 - back
        if (idx < 0) break
        if (percentileRank(idx) * 100 <= pct) {
          wasSqueezed = true
          squeezedBarsAgo = back
          break
        }
      }
      const i = n - 1
      const price = c[i]
      const upper = bb.upper[i]
      const lower = bb.lower[i]
      if (!wasSqueezed) return { direction: 'none', score: 0, notes: `no squeeze in last ${armWindow} bars (width pctile ${(percentileRank(i) * 100).toFixed(0)}%)` }
      if (price > upper) return { direction: 'call', score: clamp(55 + (armWindow - squeezedBarsAgo) * 4, 50, 88), notes: `squeeze ${squeezedBarsAgo}b ago, breakout above upper band` }
      if (price < lower) return { direction: 'put', score: clamp(55 + (armWindow - squeezedBarsAgo) * 4, 50, 88), notes: `squeeze ${squeezedBarsAgo}b ago, breakout below lower band` }
      return { direction: 'none', score: 0, notes: `squeeze ${squeezedBarsAgo}b ago, price still inside bands - waiting for the break` }
    },
  },
  {
    id: 'liquidity-sweep-reversal',
    name: 'Liquidity Sweep Reversal',
    description:
      'Price-action reversal at a real structural level (the same supportResistance() zones key_levels uses): fires when the CURRENT bar wicks through a nearby support/resistance zone and closes back on the other side of it - a classic stop-hunt/liquidity-grab rejection - rather than any bare candlestick shape. Different animal from Pattern Confluence, which reads candle geometry alone with no concept of WHERE on the chart it happened.',
    params: [
      { key: 'lookback', label: 'S/R lookback (bars)', type: 'number', min: 60, max: 400, default: 240 },
      { key: 'minWickAtr', label: 'Min wick size (x ATR)', type: 'number', min: 0.1, max: 2, step: 0.1, default: 0.3 },
    ],
    evaluate: (candles, p) => {
      const h = candles.map((k) => k.high)
      const l = candles.map((k) => k.low)
      const c = candles.map((k) => k.close)
      const lookback = Math.round(num(p, 'lookback', 240))
      const minWickAtr = num(p, 'minWickAtr', 0.3)
      if (candles.length < lookback + 10) return { direction: 'none', score: 0, notes: 'warming up' }
      const zones = supportResistance(candles, lookback)
      const atrArr = ta.atr(h, l, c, 14)
      const i = candles.length - 1
      const atrVal = atrArr[i] || (c[i] * 0.001)
      const price = c[i]
      const supports = zones.filter((z) => z.type === 'support' && z.price <= price * 1.01)
      const resistances = zones.filter((z) => z.type === 'resistance' && z.price >= price * 0.99)
      const nearestSupport = supports.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0]
      const nearestResistance = resistances.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0]
      if (nearestSupport) {
        const wick = nearestSupport.price - l[i]
        if (l[i] < nearestSupport.price && c[i] > nearestSupport.price && wick >= minWickAtr * atrVal) {
          return {
            direction: 'call',
            score: clamp(50 + (wick / atrVal) * 15 + nearestSupport.strength * 20, 45, 92),
            notes: `swept support ${nearestSupport.price.toFixed(5)} (${nearestSupport.touches} touches), closed back above - rejection`,
          }
        }
      }
      if (nearestResistance) {
        const wick = h[i] - nearestResistance.price
        if (h[i] > nearestResistance.price && c[i] < nearestResistance.price && wick >= minWickAtr * atrVal) {
          return {
            direction: 'put',
            score: clamp(50 + (wick / atrVal) * 15 + nearestResistance.strength * 20, 45, 92),
            notes: `swept resistance ${nearestResistance.price.toFixed(5)} (${nearestResistance.touches} touches), closed back below - rejection`,
          }
        }
      }
      return { direction: 'none', score: 0, notes: 'no qualifying sweep this bar' }
    },
  },
  {
    id: 'garch-vol-expansion',
    name: 'GARCH Volatility Expansion',
    description:
      'The expansion mirror of Kalman Volatility Regime Break (which fades COMPRESSION): fires when realized GARCH(1,1) vol has pushed above its EWMA baseline by expandRatio+ (same ratio convention regime_playbook uses for its VOLATILE classification, default 1.3) and trades WITH the recent momentum direction, on the read that a real vol expansion extends rather than mean-reverts in the short run. Computed over a trailing window, not the full history, to stay responsive to regime changes.',
    params: [
      { key: 'window', label: 'Return window (bars)', type: 'number', min: 60, max: 400, default: 300 },
      { key: 'expandRatio', label: 'Expansion ratio (GARCH/EWMA)', type: 'number', min: 1.1, max: 3, step: 0.05, default: 1.3 },
      { key: 'momentumLookback', label: 'Momentum lookback (bars)', type: 'number', min: 2, max: 20, default: 5 },
    ],
    evaluate: (candles, p) => {
      const c = candles.map((k) => k.close)
      const window = Math.round(num(p, 'window', 300))
      const expandRatio = num(p, 'expandRatio', 1.3)
      const momLookback = Math.round(num(p, 'momentumLookback', 5))
      const n = c.length
      if (n < window + 10) return { direction: 'none', score: 0, notes: 'warming up' }
      const rets = logReturns(c.slice(n - window))
      const ewma = ewmaVol(rets)
      const g = garchVol(rets).vol
      if (ewma <= 1e-12) return { direction: 'none', score: 0, notes: 'no baseline volatility yet' }
      const ratio = g / ewma
      if (ratio < expandRatio) return { direction: 'none', score: 0, notes: `GARCH/EWMA ${ratio.toFixed(2)} below expansion threshold ${expandRatio}` }
      const momIdx = Math.max(0, n - 1 - momLookback)
      const momentum = c[n - 1] - c[momIdx]
      const score = clamp(50 + (ratio - expandRatio) * 40, 45, 90)
      if (momentum > 0) return { direction: 'call', score, notes: `vol expanding ${ratio.toFixed(2)}x baseline, ${momLookback}b momentum up` }
      if (momentum < 0) return { direction: 'put', score, notes: `vol expanding ${ratio.toFixed(2)}x baseline, ${momLookback}b momentum down` }
      return { direction: 'none', score: 0, notes: `vol expanding ${ratio.toFixed(2)}x baseline but momentum flat` }
    },
  },
  {
    id: 'trend-structure-pullback',
    name: 'Trend Structure Pullback',
    description:
      'Classic trend-following price action: reads the market\'s own swing structure (fractal swing highs/lows, same pivots the chart-pattern scanner and ZigZag use) to decide whether it is actually trending - Higher Highs + Higher Lows = uptrend, Lower Highs + Lower Lows = downtrend, anything else (a mixed or flat sequence) is treated as no-trade range/chop. Only trades WITH that confirmed trend: in an uptrend it waits for price to pull back into a nearby support zone or the classic floor pivot/S1 (same supportResistance()/pivotPoints() levels key_levels and Liquidity Sweep Reversal use) and only fires once THIS bar actually closes back up off it (a real bounce, not just drifting down toward the level) - the downtrend case is the exact mirror into resistance/pivot/R1. Two guards specifically exist to avoid the reversal risk this was built to dodge: a candidate trend is discarded outright if its last swing leg is too small relative to ATR (noise masquerading as structure), and a trend already in play is invalidated the moment price closes beyond the swing point that defined it (a new low under the last HL in an uptrend, or a new high over the last LH in a downtrend) - that is the earliest objective sign of a reversal, so it stands aside rather than keep buying/selling into one. Never fades a trend and never picks tops/bottoms against it - the opposite read from Liquidity Sweep Reversal, which deliberately fades a level regardless of trend.',
    params: [
      { key: 'pivotFlank', label: 'Swing confirmation flank (bars each side)', type: 'number', min: 2, max: 8, default: 3 },
      { key: 'srLookback', label: 'Support/resistance lookback (bars)', type: 'number', min: 60, max: 400, default: 240 },
      { key: 'pullbackAtr', label: 'Max pullback distance from level (x ATR)', type: 'number', min: 0.2, max: 2, step: 0.1, default: 0.75 },
      { key: 'minLegAtr', label: 'Min trend-leg size to count as trending (x ATR)', type: 'number', min: 0.5, max: 6, step: 0.25, default: 2 },
    ],
    evaluate: (candles, p) => {
      const h = candles.map((k) => k.high)
      const l = candles.map((k) => k.low)
      const c = candles.map((k) => k.close)
      const o = candles.map((k) => k.open)
      const pivotFlank = Math.round(num(p, 'pivotFlank', 3))
      const srLookback = Math.round(num(p, 'srLookback', 240))
      const pullbackAtr = num(p, 'pullbackAtr', 0.75)
      const minLegAtr = num(p, 'minLegAtr', 2)
      const n = candles.length
      if (n < Math.max(srLookback, 80) + 10) return { direction: 'none', score: 0, notes: 'warming up' }

      const pivots = findPivots(candles, pivotFlank, pivotFlank)
      const highs = pivots.filter((pv) => pv.kind === 'H')
      const lows = pivots.filter((pv) => pv.kind === 'L')
      if (highs.length < 2 || lows.length < 2) return { direction: 'none', score: 0, notes: 'not enough confirmed swing points yet' }

      const lastHighs = highs.slice(-2)
      const lastLows = lows.slice(-2)
      const bullStructure = lastHighs[1].price > lastHighs[0].price && lastLows[1].price > lastLows[0].price
      const bearStructure = lastHighs[1].price < lastHighs[0].price && lastLows[1].price < lastLows[0].price
      if (!bullStructure && !bearStructure) return { direction: 'none', score: 0, notes: 'no clean HH/HL or LH/LL sequence - ranging/transitioning' }

      const atrArr = ta.atr(h, l, c, 14)
      const i = n - 1
      const atrVal = atrArr[i] || c[i] * 0.001
      const price = c[i]

      // impulse leg size (earlier swing point of the pair to the later one,
      // in the trend direction) - filters out a technically-HH/HL sequence
      // that is really just noise on a flat tape
      const legSize = bullStructure ? lastHighs[1].price - lastLows[0].price : lastHighs[0].price - lastLows[1].price
      if (legSize < minLegAtr * atrVal)
        return { direction: 'none', score: 0, notes: `structure present but leg too small (${(legSize / atrVal).toFixed(1)}x ATR, need ${minLegAtr}x)` }

      // structure break: the trend only stays "clean" while price hasn't
      // violated the swing point that defines it - closing below the last
      // confirmed swing low in an uptrend (or above the last swing high in
      // a downtrend) is the earliest objective sign of a reversal, so this
      // stands aside instead of buying/selling into one
      if (bullStructure && price < lastLows[1].price) return { direction: 'none', score: 0, notes: 'uptrend structure broken - price closed below the last swing low' }
      if (bearStructure && price > lastHighs[1].price) return { direction: 'none', score: 0, notes: 'downtrend structure broken - price closed above the last swing high' }

      const zones = supportResistance(candles, srLookback)
      const pivLevels = ta.pivotPoints(candles, Math.min(srLookback, 60))

      if (bullStructure) {
        const supports = zones.filter((z) => z.type === 'support' && z.price <= price * 1.02).sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
        const nearestSupport = supports[0]
        const pivotFloor = [pivLevels.pp, pivLevels.s1].filter((lv) => lv <= price * 1.02).sort((a, b) => Math.abs(a - price) - Math.abs(b - price))[0]
        const level = nearestSupport ? nearestSupport.price : pivotFloor
        if (level === undefined) return { direction: 'none', score: 0, notes: 'uptrend intact but no nearby support/pivot to pull back into' }
        const dist = price - level
        if (dist < 0 || dist > pullbackAtr * atrVal)
          return { direction: 'none', score: 0, notes: `uptrend intact, waiting for a pullback (${(dist / atrVal).toFixed(2)}x ATR from ${level.toFixed(5)})` }
        // bounce confirmation: THIS bar closed green and at/above the prior
        // close - a real bounce off the level, not just drifting down to it
        const bouncing = c[i] > o[i] && c[i] >= c[i - 1]
        if (!bouncing) return { direction: 'none', score: 0, notes: `at support ${level.toFixed(5)}, no bounce confirmation yet this bar` }
        const touches = nearestSupport?.touches ?? 0
        const score = clamp(52 + (legSize / atrVal) * 3 + ((pullbackAtr * atrVal - dist) / atrVal) * 10 + touches * 4, 48, 94)
        return {
          direction: 'call',
          score,
          notes: `uptrend (HH/HL), pullback to ${nearestSupport ? 'support' : 'pivot'} ${level.toFixed(5)}${touches ? ` (${touches} touches)` : ''}, bounce confirmed`,
        }
      }

      const resistances = zones.filter((z) => z.type === 'resistance' && z.price >= price * 0.98).sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
      const nearestResistance = resistances[0]
      const pivotCeil = [pivLevels.pp, pivLevels.r1].filter((lv) => lv >= price * 0.98).sort((a, b) => Math.abs(a - price) - Math.abs(b - price))[0]
      const level = nearestResistance ? nearestResistance.price : pivotCeil
      if (level === undefined) return { direction: 'none', score: 0, notes: 'downtrend intact but no nearby resistance/pivot to pull back into' }
      const dist = level - price
      if (dist < 0 || dist > pullbackAtr * atrVal)
        return { direction: 'none', score: 0, notes: `downtrend intact, waiting for a pullback (${(dist / atrVal).toFixed(2)}x ATR from ${level.toFixed(5)})` }
      const bouncing = c[i] < o[i] && c[i] <= c[i - 1]
      if (!bouncing) return { direction: 'none', score: 0, notes: `at resistance ${level.toFixed(5)}, no rejection confirmation yet this bar` }
      const touches = nearestResistance?.touches ?? 0
      const score = clamp(52 + (legSize / atrVal) * 3 + ((pullbackAtr * atrVal - dist) / atrVal) * 10 + touches * 4, 48, 94)
      return {
        direction: 'put',
        score,
        notes: `downtrend (LH/LL), pullback to ${nearestResistance ? 'resistance' : 'pivot'} ${level.toFixed(5)}${touches ? ` (${touches} touches)` : ''}, rejection confirmed`,
      }
    },
  },
  {
    id: 'poc-reversion',
    name: 'POC Reversion (Order Flow, approx)',
    description:
      'Volume-profile mean reversion: CALL when price has stretched meaningfully below the recent Point of Control (the high-volume node price tends to gravitate back toward) AND the most recent bars show buy-side delta turning positive (a confirming nudge, not just "far from POC"); PUT is the symmetric case above POC with delta turning negative. Volume profile and buy/sell delta are CLV-based approximations from OHLCV candles (see analytics/orderflow.ts) - IQ Option exposes no real order-book/tick data, so this is NOT institutional order flow, just a candle-level proxy for where volume (approx) has concentrated.',
    params: [
      { key: 'profileWindow', label: 'Volume profile window (bars)', type: 'number', min: 20, max: 300, default: 80 },
      { key: 'buckets', label: 'Profile buckets', type: 'number', min: 10, max: 60, default: 24 },
      { key: 'minDistAtr', label: 'Min distance from POC (x ATR)', type: 'number', min: 0.3, max: 4, step: 0.1, default: 1 },
      { key: 'confirmBars', label: 'Delta confirmation window (bars)', type: 'number', min: 1, max: 10, default: 3 },
    ],
    evaluate: (candles, p) => {
      const window = Math.round(num(p, 'profileWindow', 80))
      const buckets = Math.round(num(p, 'buckets', 24))
      const minDistAtr = num(p, 'minDistAtr', 1)
      const confirmBars = Math.round(num(p, 'confirmBars', 3))
      const n = candles.length
      if (n < window + 5) return { direction: 'none', score: 0, notes: 'warming up' }
      // Task 58 (P2): exclude the decision bar from the profile, matching the
      // sibling value-area-breakout - including it let the decision bar drag
      // the POC/value area toward itself and biased stretch distances low
      // exactly on breakout bars.
      const slice = candles.slice(-window - 1, -1)
      const vp = computeVolumeProfile(slice, { bucketCount: buckets })
      const h = candles.map((k) => k.high)
      const l = candles.map((k) => k.low)
      const c = candles.map((k) => k.close)
      const atrArr = ta.atr(h, l, c, 14)
      const i = n - 1
      const atrVal = atrArr[i] || c[i] * 0.001
      const price = c[i]
      const distAtr = (price - vp.poc) / atrVal
      const confirmDeltas = computeCandleDelta(candles.slice(-confirmBars))
      const deltaSum = confirmDeltas.reduce((s, d) => s + d.delta, 0)
      if (distAtr <= -minDistAtr && deltaSum > 0) {
        const score = clamp(48 + (Math.abs(distAtr) - minDistAtr) * 16, 42, 92)
        return { direction: 'call', score, notes: `${Math.abs(distAtr).toFixed(2)}x ATR below POC ${vp.poc.toFixed(5)}, delta turning positive (approx)` }
      }
      if (distAtr >= minDistAtr && deltaSum < 0) {
        const score = clamp(48 + (Math.abs(distAtr) - minDistAtr) * 16, 42, 92)
        return { direction: 'put', score, notes: `${Math.abs(distAtr).toFixed(2)}x ATR above POC ${vp.poc.toFixed(5)}, delta turning negative (approx)` }
      }
      return { direction: 'none', score: 0, notes: `${distAtr.toFixed(2)}x ATR from POC ${vp.poc.toFixed(5)} - no qualifying stretch+delta confirmation` }
    },
  },
  {
    id: 'value-area-breakout',
    name: 'Value Area Breakout (Order Flow, approx)',
    description:
      'Trades a close outside the recent Value Area (the band holding ~70% of volume around the POC): CALL above Value Area High, PUT below Value Area Low. A breakout accompanied by strong supporting delta (buy pressure on a VAH break, sell pressure on a VAL break) scores meaningfully higher than a bare breakout with weak/contrary delta - the order-flow equivalent of "the move has volume behind it". Volume profile and delta are CLV-based approximations (see analytics/orderflow.ts), not real tick/order-book data.',
    params: [
      { key: 'profileWindow', label: 'Volume profile window (bars)', type: 'number', min: 20, max: 300, default: 80 },
      { key: 'buckets', label: 'Profile buckets', type: 'number', min: 10, max: 60, default: 24 },
      { key: 'confirmBars', label: 'Delta confirmation window (bars)', type: 'number', min: 1, max: 10, default: 3 },
    ],
    evaluate: (candles, p) => {
      const window = Math.round(num(p, 'profileWindow', 80))
      const buckets = Math.round(num(p, 'buckets', 24))
      const confirmBars = Math.round(num(p, 'confirmBars', 3))
      const n = candles.length
      if (n < window + 5) return { direction: 'none', score: 0, notes: 'warming up' }
      // profile computed on the window EXCLUDING the live bar, so the
      // breakout is measured against a profile that doesn't already bake
      // the breakout bar itself into the value area.
      const slice = candles.slice(-window - 1, -1)
      const vp = computeVolumeProfile(slice, { bucketCount: buckets })
      const c = candles.map((k) => k.close)
      const price = c[n - 1]
      const confirmDeltas = computeCandleDelta(candles.slice(-confirmBars))
      const deltaSum = confirmDeltas.reduce((s, d) => s + d.delta, 0)
      const totalVol = confirmDeltas.reduce((s, d) => s + d.buyVolume + d.sellVolume, 0) || 1
      const deltaRatio = deltaSum / totalVol // -1..1, sign/strength of supporting flow
      if (price > vp.valueAreaHigh) {
        const bonus = deltaRatio > 0 ? deltaRatio * 35 : deltaRatio * 20 // weaker penalty than bonus strength, but contrary delta still hurts
        const score = clamp(55 + bonus, 40, 94)
        return {
          direction: 'call',
          score,
          notes: `closed above VAH ${vp.valueAreaHigh.toFixed(5)}${deltaRatio > 0.1 ? ', supporting buy delta (approx)' : deltaRatio < -0.1 ? ', delta NOT confirming (approx) - weaker' : ''}`,
        }
      }
      if (price < vp.valueAreaLow) {
        const bonus = deltaRatio < 0 ? -deltaRatio * 35 : -deltaRatio * 20
        const score = clamp(55 + bonus, 40, 94)
        return {
          direction: 'put',
          score,
          notes: `closed below VAL ${vp.valueAreaLow.toFixed(5)}${deltaRatio < -0.1 ? ', supporting sell delta (approx)' : deltaRatio > 0.1 ? ', delta NOT confirming (approx) - weaker' : ''}`,
        }
      }
      return { direction: 'none', score: 0, notes: `inside value area [${vp.valueAreaLow.toFixed(5)}, ${vp.valueAreaHigh.toFixed(5)}]` }
    },
  },
  {
    id: 'delta-divergence',
    name: 'Delta Divergence (Order Flow, approx)',
    description:
      'Classic order-flow divergence, approximated from CLV-based candle delta: PUT when price makes a new local high over the lookback window but cumulative delta does NOT make a new high over the same window (buying pressure failing to confirm the new high - bearish divergence); CALL is the symmetric case (new local low in price, cumulative delta NOT making a new low - selling pressure failing to confirm). This is a candle-level CLV approximation of real tick-level order-flow divergence (see analytics/orderflow.ts) - IQ Option exposes no genuine buy/sell-tagged trade data.',
    params: [
      { key: 'lookback', label: 'Divergence lookback (bars)', type: 'number', min: 10, max: 120, default: 30 },
      { key: 'minGapAtr', label: 'Min price extreme gap (x ATR)', type: 'number', min: 0, max: 2, step: 0.05, default: 0.1 },
    ],
    evaluate: (candles, p) => {
      const lookback = Math.round(num(p, 'lookback', 30))
      const minGapAtr = num(p, 'minGapAtr', 0.1)
      const n = candles.length
      if (n < lookback + 5) return { direction: 'none', score: 0, notes: 'warming up' }
      const window = candles.slice(-lookback)
      const deltas = computeCandleDelta(window)
      const cum = computeCumulativeDelta(deltas)
      const h = candles.map((k) => k.high)
      const l = candles.map((k) => k.low)
      const c = candles.map((k) => k.close)
      const atrArr = ta.atr(h, l, c, 14)
      const i = n - 1
      const atrVal = atrArr[i] || c[i] * 0.001
      const priceHigh = Math.max(...window.map((k) => k.high))
      const priceLow = Math.min(...window.map((k) => k.low))
      const cumMax = Math.max(...cum.map((d) => d.cumulativeDelta))
      const cumMin = Math.min(...cum.map((d) => d.cumulativeDelta))
      const lastHigh = window[window.length - 1].high
      const lastLow = window[window.length - 1].low
      const lastCum = cum[cum.length - 1].cumulativeDelta
      const priceAtNewHigh = lastHigh >= priceHigh - 1e-9 && (lastHigh - Math.max(...window.slice(0, -1).map((k) => k.high))) >= minGapAtr * atrVal
      const priceAtNewLow = lastLow <= priceLow + 1e-9 && (Math.min(...window.slice(0, -1).map((k) => k.low)) - lastLow) >= minGapAtr * atrVal
      const deltaFailsHigh = lastCum < cumMax - 1e-9
      const deltaFailsLow = lastCum > cumMin + 1e-9
      if (priceAtNewHigh && deltaFailsHigh) {
        const gap = (cumMax - lastCum) / (Math.abs(cumMax) + 1e-9)
        const score = clamp(50 + gap * 60, 42, 90)
        return { direction: 'put', score, notes: `new ${lookback}b price high, cumulative delta (approx) failed to confirm - bearish divergence` }
      }
      if (priceAtNewLow && deltaFailsLow) {
        const gap = (lastCum - cumMin) / (Math.abs(cumMin) + 1e-9)
        const score = clamp(50 + gap * 60, 42, 90)
        return { direction: 'call', score, notes: `new ${lookback}b price low, cumulative delta (approx) failed to confirm - bullish divergence` }
      }
      return { direction: 'none', score: 0, notes: 'no qualifying price/delta divergence this bar' }
    },
  },
  {
    id: 'renko-flip',
    name: 'Renko Brick Flip',
    description:
      'Close-based renko with ATR-sized bricks (2-brick reversal rule): CALL on a fresh flip to up bricks, PUT on a fresh flip to down. Fires only while the new trend is young (confirm bricks), then stands aside until the next flip - noise-averaged by construction, no time noise.',
    params: [
      { key: 'atrPeriod', label: 'ATR period (brick sizing)', type: 'number', min: 5, max: 50, default: 14 },
      { key: 'atrMult', label: 'Brick = ATR x', type: 'number', min: 0.1, max: 1, step: 0.05, default: 0.3 },
      { key: 'confirm', label: 'Confirm bricks', type: 'number', min: 1, max: 3, default: 1 },
    ],
    evaluate: (candles, p) => {
      if (candles.length < 40) return { direction: 'none', score: 0, notes: 'warming up (<40 bars)' }
      const r = renkoBricks(candles, { atrPeriod: num(p, 'atrPeriod', 14), atrMult: num(p, 'atrMult', 0.3) })
      const b = r.bricks
      if (b.length < 4) {
        return { direction: 'none', score: 0, notes: `only ${b.length} bricks @ box ${(r.brickSize * 1e4).toFixed(1)}p - raise atrMult for this tape` }
      }
      const lastDir = b[b.length - 1].dir
      let streak = 0
      for (let i = b.length - 1; i >= 0 && b[i].dir === lastDir; i--) streak++
      if (streak > num(p, 'confirm', 1)) {
        return { direction: 'none', score: 0, notes: `${lastDir > 0 ? 'up' : 'down'} run ${streak} bricks old - awaiting next flip` }
      }
      const score = clamp(55 + 15 * streak, 55, 90)
      return {
        direction: lastDir > 0 ? 'call' : 'put',
        score,
        notes: `brick flip ${lastDir > 0 ? 'UP' : 'DOWN'} x${streak} (${b.length} bricks, ${r.flips} flips, box ${(r.brickSize * 1e4).toFixed(1)}p)`,
      }
    },
  },
  {
    id: 'pf-breakout',
    name: 'P&F Breakout',
    description:
      "Classic high/low point & figure (ATR-sized boxes, 3-box reversal): CALL on a double/triple-top X breakout, PUT on a double/triple-bottom O breakdown. Fires only on the bar that painted the breakout box - stale patterns stand aside.",
    params: [
      { key: 'atrPeriod', label: 'ATR period (box sizing)', type: 'number', min: 5, max: 50, default: 14 },
      { key: 'atrMult', label: 'Box = ATR x', type: 'number', min: 0.1, max: 1, step: 0.05, default: 0.5 },
      { key: 'reversal', label: 'Reversal boxes', type: 'number', min: 2, max: 5, default: 3 },
    ],
    evaluate: (candles, p) => {
      if (candles.length < 40) return { direction: 'none', score: 0, notes: 'warming up (<40 bars)' }
      const pf = pointFigure(candles, {
        atrPeriod: num(p, 'atrPeriod', 14),
        atrMult: num(p, 'atrMult', 0.5),
        reversalBoxes: num(p, 'reversal', 3),
      })
      if (pf.columns.length < 4) {
        return { direction: 'none', score: 0, notes: `only ${pf.columns.length} columns @ box ${(pf.boxSize * 1e4).toFixed(1)}p - lower atrMult for this tape` }
      }
      const pat = pf.pattern
      if (!pat) return { direction: 'none', score: 0, notes: `no top/bottom pattern yet (${pf.columns.length} columns)` }
      if (pat.at !== candles[candles.length - 1].time) {
        return { direction: 'none', score: 0, notes: `${pat.name} completed on an earlier bar - stale` }
      }
      const triple = pat.name.startsWith('Triple')
      const score = clamp(60 + (triple ? 15 : 0) + (pat.direction === (pf.lastDir === 'X' ? 'call' : 'put') ? 5 : 0), 60, 95)
      return {
        direction: pat.direction,
        score,
        notes: `${pat.name} (${pf.columns.length} columns, box ${(pf.boxSize * 1e4).toFixed(1)}p, ${pf.reversalBoxes}-box reversal)`,
      }
    },
  },
  {
    id: 'range-run',
    name: 'Range Bar Run',
    description:
      'Range-bar continuation: every range bar spans EXACTLY one full range of price travel (ATR-sized, close-chained), so a run of same-direction bars is sustained one-directional pressure measured in distance, not time. CALL while the up-run is young (confirm bars), PUT on a young down-run; stands aside once the run is older than confirm - the entry is the run, not its memory. No renko-style reversal multiplier: either side needs one full range from the running reference.',
    params: [
      { key: 'atrPeriod', label: 'ATR period (range sizing)', type: 'number', min: 5, max: 50, default: 14 },
      { key: 'atrMult', label: 'Range = ATR x', type: 'number', min: 0.1, max: 1, step: 0.05, default: 0.5 },
      { key: 'confirm', label: 'Confirm bars', type: 'number', min: 1, max: 3, default: 1 },
    ],
    evaluate: (candles, p) => {
      if (candles.length < 40) return { direction: 'none', score: 0, notes: 'warming up (<40 bars)' }
      const r = rangeBars(candles, { atrPeriod: num(p, 'atrPeriod', 14), atrMult: num(p, 'atrMult', 0.5) })
      const b = r.bars
      if (b.length < 4) {
        return { direction: 'none', score: 0, notes: `only ${b.length} bars @ range ${(r.range * 1e4).toFixed(1)}p - raise atrMult for this tape` }
      }
      const lastDir = b[b.length - 1].dir
      let streak = 0
      for (let i = b.length - 1; i >= 0 && b[i].dir === lastDir; i--) streak++
      if (streak > num(p, 'confirm', 1)) {
        return { direction: 'none', score: 0, notes: `${lastDir > 0 ? 'up' : 'down'} run ${streak} bars old - awaiting next flip` }
      }
      const score = clamp(55 + 15 * streak, 55, 90)
      return {
        direction: lastDir > 0 ? 'call' : 'put',
        score,
        notes: `range run ${lastDir > 0 ? 'UP' : 'DOWN'} x${streak} (${b.length} bars, ${r.flips} flips, range ${(r.range * 1e4).toFixed(1)}p, ${r.rangeRule})`,
      }
    },
  },
  {
    id: 'volbars-conviction',
    name: 'Equal-Volume Conviction',
    description:
      'Constant-volume bars normalize activity: every bar folds the same (approx) volume, so a wide BODY on equal activity is directional conviction, not a busy tape. CALL on the last COMPLETED volume bar closing as a dominant-body up bar, PUT the mirror. The still-forming trailing bar is excluded (its OHLC would keep folding forward), auto bar sizing runs on a trailing window so live and backtest agree, and volume is the broker (approx) feed.',
    params: [
      { key: 'per', label: 'Volume per bar (0 = auto)', type: 'number', min: 0, max: 1000000000, default: 0 },
      { key: 'bodyFrac', label: 'Min body fraction of range', type: 'number', min: 0.4, max: 0.95, step: 0.05, default: 0.6 },
      { key: 'sizingBars', label: 'Trailing window for auto sizing', type: 'number', min: 30, max: 300, default: 100 },
    ],
    evaluate: (candles, p) => {
      if (candles.length < 40) return { direction: 'none', score: 0, notes: 'warming up (<40 bars)' }
      // auto sizing on a TRAILING window (not the whole growing slice) so the
      // bar structure is window-offset independent - the property renko/pf
      // sizing already honors and backtest slice(0, i+1) needs
      const sizing = Math.max(20, Math.round(num(p, 'sizingBars', 100)))
      const perParam = num(p, 'per', 0)
      const autoPer = volumeBars(candles.slice(-sizing), { per: 0 }).per
      const v = volumeBars(candles, { per: perParam > 0 ? perParam : autoPer })
      if (v.volumeSource === 'none') {
        return { direction: 'none', score: 0, notes: 'all-zero volume window - no activity to read (approx feed)' }
      }
      if (v.bars.length < 5) {
        return { direction: 'none', score: 0, notes: `only ${v.bars.length} volume bars - lower per or widen the window` }
      }
      // the trailing bar is still forming while its folded volume < per:
      // conviction is only read on COMPLETED bars
      let lastBar = v.bars[v.bars.length - 1]
      if (lastBar.volume < v.per) lastBar = v.bars[v.bars.length - 2]
      const span = lastBar.high - lastBar.low
      if (!(span > 0)) {
        return { direction: 'none', score: 0, notes: 'last completed volume bar has zero range - stand aside' }
      }
      const bf = num(p, 'bodyFrac', 0.6)
      const bodyFrac = Math.abs(lastBar.close - lastBar.open) / span
      if (bodyFrac < bf) {
        return { direction: 'none', score: 0, notes: `body ${Math.round(bodyFrac * 100)}% of range < ${Math.round(bf * 100)}% - no conviction on equal volume` }
      }
      const dir = lastBar.close > lastBar.open ? 'call' : 'put'
      const score = clamp(55 + (bodyFrac - bf) * 80, 55, 90)
      return {
        direction: dir,
        score,
        notes: `volume bar body ${Math.round(bodyFrac * 100)}% of range ${dir === 'call' ? 'UP' : 'DOWN'} (${v.bars.length} bars, ${v.perRule}, volume (approx))`,
      }
    },
  },
  {
    id: 'footprint-imbalance',
    name: 'Footprint Imbalance Stack',
    description:
      'Footprint chart read: fires when the last closed candle shows a STACK of imbalanced price bins in one direction (minRows bins where one side carries >= imbalanceRatio x the other at bin resolution) - the classic stacked-imbalance continuation signal. The buy/sell split is the CLV proxy (closes near the high = buy pressure) and volume is the (approx) feed; volume-less candles never fire.',
    params: [
      { key: 'binsPerCandle', label: 'Price bins per candle', type: 'number', min: 2, max: 24, default: 8 },
      { key: 'imbalanceRatio', label: 'Imbalance ratio (x)', type: 'number', min: 1.5, max: 10, step: 0.5, default: 3 },
      { key: 'minRows', label: 'Min stacked rows', type: 'number', min: 1, max: 12, default: 4 },
    ],
    evaluate: (candles, p) => {
      if (candles.length < 20) return { direction: 'none', score: 0, notes: 'warming up (<20 bars)' }
      const c = candles[candles.length - 1]
      const vol = Number.isFinite(c.volume) ? c.volume : 0
      if (!(vol > 0)) return { direction: 'none', score: 0, notes: 'volume-less candle - no footprint read (approx feed)' }
      if (!(c.high > c.low)) return { direction: 'none', score: 0, notes: 'zero-range candle - no ladder to read' }
      const fp = computeFootprint([c], {
        binsPerCandle: Math.round(num(p, 'binsPerCandle', 8)),
        imbalanceRatio: num(p, 'imbalanceRatio', 3),
      })
      const rows = fp.candles[0].rows
      const buyRows = rows.filter((r) => r.imbalance === 'buy').length
      const sellRows = rows.filter((r) => r.imbalance === 'sell').length
      const minRows = Math.max(1, Math.round(num(p, 'minRows', 4)))
      if (buyRows < minRows && sellRows < minRows) {
        return { direction: 'none', score: 0, notes: `${buyRows} buy / ${sellRows} sell imbalanced rows < ${minRows} - no stack` }
      }
      if (buyRows >= minRows && sellRows >= minRows && buyRows === sellRows) {
        return { direction: 'none', score: 0, notes: `${buyRows} buy vs ${sellRows} sell rows - stacks cancel, ambiguous` }
      }
      const buy = buyRows > sellRows
      const rowsN = Math.max(buyRows, sellRows)
      const score = clamp(55 + (rowsN - minRows) * 6, 55, 92)
      return {
        direction: buy ? 'call' : 'put',
        score,
        notes: `${rowsN}/${rows.length} bins ${buy ? 'BUY' : 'SELL'} imbalanced >= ${num(p, 'imbalanceRatio', 3)}x (CLV proxy, volume (approx))`,
      }
    },
  },
  {
    id: 'tpo-fade',
    name: 'TPO Balance Fade',
    description:
      'Market-profile read: when the recent window shows a BALANCED profile (price rotated through the POC at least minRotations times) and the last close pokes just outside the 70% value area, fade the excursion back toward the POC - the classic balance-day edge. Excursions beyond maxDistAtr read as trend days, not fades, and stand aside; single-print TPO counting on 30-min brackets (per-candle fallback when tf >= bracket).',
    params: [
      { key: 'window', label: 'Profile window (candles)', type: 'number', min: 40, max: 400, default: 160 },
      { key: 'periodSec', label: 'TPO bracket (seconds)', type: 'number', min: 300, max: 86400, step: 300, default: 1800 },
      { key: 'minRotations', label: 'Min POC rotations', type: 'number', min: 1, max: 10, default: 3 },
      { key: 'maxDistAtr', label: 'Max excursion (x ATR)', type: 'number', min: 0.5, max: 5, step: 0.25, default: 2 },
    ],
    evaluate: (candles, p) => {
      const win = Math.round(num(p, 'window', 160))
      const n = candles.length
      if (n < win + 5) return { direction: 'none', score: 0, notes: 'warming up (<window+5 bars)' }
      const tpo = computeTpo(candles.slice(-win), { periodSec: num(p, 'periodSec', 1800) })
      if (tpo.poc === null || tpo.valueAreaHigh === null || tpo.valueAreaLow === null) {
        return { direction: 'none', score: 0, notes: 'no profile yet' }
      }
      // balance detector: strict close crossings of the POC
      const closes = candles.slice(-win).map((k) => k.close)
      let side = closes[0] >= (tpo.poc as number) ? 1 : -1
      let rotations = 0
      for (let i = 1; i < closes.length; i++) {
        const s = closes[i] >= (tpo.poc as number) ? 1 : -1
        if (s !== side) {
          rotations++
          side = s
        }
      }
      const minRot = Math.max(1, Math.round(num(p, 'minRotations', 3)))
      if (rotations < minRot) {
        return { direction: 'none', score: 0, notes: `${rotations} POC rotations < ${minRot} - trend-day profile, fade stands aside` }
      }
      const price = closes[closes.length - 1]
      const atrArr = ta.atr(candles.map((k) => k.high), candles.map((k) => k.low), candles.map((k) => k.close), 14)
      const atrVal = Number.isFinite(last(atrArr)) ? (last(atrArr) as number) : price * 0.001
      const maxDist = num(p, 'maxDistAtr', 2) * atrVal
      const above = price > tpo.valueAreaHigh
      const below = price < tpo.valueAreaLow
      if (!above && !below) {
        return { direction: 'none', score: 0, notes: `inside value area [${tpo.valueAreaLow.toFixed(5)}, ${tpo.valueAreaHigh.toFixed(5)}] after ${rotations} rotations` }
      }
      const dist = above ? price - (tpo.valueAreaHigh as number) : (tpo.valueAreaLow as number) - price
      if (dist > maxDist) {
        return { direction: 'none', score: 0, notes: `${(dist / atrVal).toFixed(1)} ATR beyond VA edge > ${num(p, 'maxDistAtr', 2)} - reads as breakout, not fade` }
      }
      const prox = 1 - dist / Math.max(maxDist, 1e-9) // 1 = right at the edge, 0 = at maxDist
      const score = clamp(52 + Math.min(20, (rotations - minRot) * 5) + prox * 15, 45, 90)
      return {
        direction: above ? 'put' : 'call',
        score,
        notes: `balance fade ${above ? 'PUT' : 'CALL'}: ${rotations} rotations, ${(dist / atrVal).toFixed(2)} ATR beyond ${above ? 'VAH' : 'VAL'}, POC ${(tpo.poc as number).toFixed(5)} (${tpo.periodRule})`,
      }
    },
  },
  {
    id: 'tick-regime',
    name: 'Tick Persistence Regime',
    description:
      "Reads the tape's own character (candle closes as pseudo-ticks): the z-score of same-direction consecutive moves vs a fair coin. A PERSISTENT tape (z >= zMin) continues - fire with the last move; an ANTI-persistent tape (z <= -zMin, the bid-ask-bounce microstructure real feeds show) fades - fire against the last move. A fair-coin tape (|z| < zMin) is unpredictable by construction and stands aside - OTC feeds read fair-coin here, which is this strategy honestly refusing to trade them.",
    params: [
      { key: 'window', label: 'Move window (diffs)', type: 'number', min: 30, max: 500, default: 120 },
      { key: 'zMin', label: 'Min |z| vs fair coin', type: 'number', min: 0.5, max: 4, step: 0.25, default: 1.5 },
    ],
    evaluate: (candles, p) => {
      const win = Math.round(num(p, 'window', 120))
      if (candles.length < win + 2) return { direction: 'none', score: 0, notes: 'warming up (<window+2 bars)' }
      const cs = candles.slice(-(win + 1)).map((c) => c.close)
      const diffs: number[] = []
      for (let i = 1; i < cs.length; i++) {
        const d = cs[i] - cs[i - 1]
        if (d !== 0) diffs.push(d)
      }
      let pairs = 0
      let same = 0
      for (let i = 1; i < diffs.length; i++) {
        pairs++
        if (diffs[i] * diffs[i - 1] > 0) same++
      }
      const minPairs = Math.max(20, Math.round(win * 0.25))
      if (pairs < minPairs) {
        return { direction: 'none', score: 0, notes: `only ${pairs} nonzero move pairs - flat tape, stand aside` }
      }
      const pHat = same / pairs
      const z = (pHat - 0.5) / Math.sqrt(0.25 / pairs)
      const zMin = num(p, 'zMin', 1.5)
      if (Math.abs(z) < zMin) {
        return { direction: 'none', score: 0, notes: `tape reads fair-coin (P(same)=${pHat.toFixed(2)}, z ${z.toFixed(2)}) - unpredictable, standing aside` }
      }
      const persistent = z > 0
      const lastUp = diffs[diffs.length - 1] > 0
      // persistent: continue the last move; anti-persistent: fade the bounce
      const wantUp = persistent ? lastUp : !lastUp
      const score = clamp(55 + Math.abs(z) * 8, 55, 92)
      return {
        direction: wantUp ? 'call' : 'put',
        score,
        notes: `${persistent ? 'PERSISTENT' : 'ANTI-PERSISTENT'} tape P(same)=${pHat.toFixed(2)} z ${z.toFixed(2)} - ${persistent ? 'continuing' : 'fading'} the last move (pseudo-ticks = candle closes)`,
      }
    },
  },
  {
    id: 'ivhv-edge',
    name: 'Breakeven Probability Edge (IV*HV)',
    description:
      "The IV-vs-HV chart's edge view as a strategy: fires when the realized frequency of up-closes over the window clears the payout-implied breakeven probability q = 100/(1+payout) - the disclosed IV proxy - by a margin. CALL when the up-frequency clears it, PUT when the down-frequency does. Payout is a PARAM here (default 0.85); at trade time the live EV gate still applies with the real quote - this strategy makes the statistical case, the gate prices it.",
    params: [
      { key: 'window', label: 'Up-frequency window (bars)', type: 'number', min: 20, max: 300, default: 100 },
      { key: 'payout', label: 'Payout assumption (fraction)', type: 'number', min: 0.5, max: 2, step: 0.05, default: 0.85 },
      { key: 'margin', label: 'Margin over breakeven (pts)', type: 'number', min: 0, max: 15, step: 0.5, default: 5 },
    ],
    evaluate: (candles, p) => {
      const win = Math.round(num(p, 'window', 100))
      if (candles.length < win + 2) return { direction: 'none', score: 0, notes: 'warming up (<window+2 bars)' }
      const iv = ivFromPayout(num(p, 'payout', 0.85))
      const be = iv.breakevenPct
      if (!Number.isFinite(be)) return { direction: 'none', score: 0, notes: 'payout param not usable - no breakeven' }
      const u = realizedUpProb(candles, win) // percent of up closes over the window
      const margin = num(p, 'margin', 5)
      const upEdge = u - (be + margin)
      const downEdge = 100 - u - (be + margin)
      if (upEdge < 0 && downEdge < 0) {
        return { direction: 'none', score: 0, notes: `up-freq ${u.toFixed(1)}% / down ${(100 - u).toFixed(1)}% vs breakeven ${be.toFixed(2)}% + ${margin} margin - no side clears it` }
      }
      const isCall = upEdge >= downEdge
      const edge = isCall ? upEdge : downEdge
      const score = clamp(55 + edge * 2.5, 55, 92)
      return {
        direction: isCall ? 'call' : 'put',
        score,
        notes: `${isCall ? 'up' : 'down'}-freq ${(isCall ? u : 100 - u).toFixed(1)}% over ${win} bars clears breakeven ${be.toFixed(2)}% (payout ${iv.payout}, IV proxy rule) by ${edge.toFixed(1)} pts - live EV gate still applies`,
      }
    },
  },
]

export const getStrategy = (id: string): StrategyDef | undefined => STRATEGIES.find((s) => s.id === id)

export function defaultParams(s: StrategyDef): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const p of s.params) out[p.key] = p.default
  return out
}
