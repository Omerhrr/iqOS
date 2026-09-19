// IQAIR//OS - Strategy registry
// Data-driven strategy definitions. `evaluate` is pure: candles + params in,
// a directional eval out. Used by the Strategy Lab, the backtester and the agent.
import type { StrategyDef } from '../types'
import * as ta from '../analytics/indicators'
import { markovChain } from '../analytics/quant'
import { detectPatterns, patternBias } from '../analytics/patterns'

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
]

export const getStrategy = (id: string): StrategyDef | undefined => STRATEGIES.find((s) => s.id === id)

export function defaultParams(s: StrategyDef): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const p of s.params) out[p.key] = p.default
  return out
}
