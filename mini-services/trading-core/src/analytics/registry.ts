// IQAIR//OS - Indicator registry
// 100+ indicator definitions (overlap, momentum, volume, volatility, trend, cycle,
// statistic). Every entry exposes params, pane placement and a compute() that maps
// candles -> lines, powering chart overlays, oscillator sub-panes, the picker UI,
// the pattern scanner and the AI agent tools.

import type { Candle, IndicatorDef, IndicatorOutput } from '../types'
import * as TA from './indicators'

const isn = TA.isn

const line = (key: string, color: string, values: number[], style?: 'solid' | 'dashed' | 'dotted', width?: 1 | 2): IndicatorOutput['lines'][number] => ({
  key,
  color,
  style,
  width,
  values,
})

const num = (candles: Candle[], params: Record<string, number>, key: string, dflt: number): number => {
  const v = params[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

// palette
const C = {
  blue: '#38bdf8',
  orange: '#f59e0b',
  green: '#10b981',
  red: '#f43f5e',
  violet: '#a78bfa',
  pink: '#e879f9',
  yellow: '#facc15',
  teal: '#2dd4bf',
  slate: '#94a3b8',
  indigo: '#818cf8',
  lime: '#a3e635',
  rose: '#fb7185',
  cyan: '#22d3ee',
}

const p = (key: string, label: string, min: number, max: number, dflt: number, step = 1) => ({
  key,
  label,
  type: 'number' as const,
  min,
  max,
  step,
  default: dflt,
})

// ============================ OVERLAP ============================

const overlap: IndicatorDef[] = [
  {
    id: 'sma', name: 'SMA', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 2, 400, 20)],
    description: 'Simple Moving Average - arithmetic mean of the last N closes.',
    compute: (c, par) => ({ lines: [line('sma', C.blue, TA.sma(TA.closes(c), num(c, par, 'period', 20)))] }),
  },
  {
    id: 'ema', name: 'EMA', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 2, 400, 20)],
    description: 'Exponential Moving Average - weights recent closes exponentially.',
    compute: (c, par) => ({ lines: [line('ema', C.orange, TA.ema(TA.closes(c), num(c, par, 'period', 20)))] }),
  },
  {
    id: 'wma', name: 'WMA', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 2, 200, 20)],
    description: 'Linearly Weighted Moving Average.',
    compute: (c, par) => ({ lines: [line('wma', C.teal, TA.wma(TA.closes(c), num(c, par, 'period', 20)))] }),
  },
  {
    id: 'dema', name: 'DEMA', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 2, 200, 20)],
    description: 'Double EMA - 2*EMA1 - EMA2, reduced lag.',
    compute: (c, par) => ({ lines: [line('dema', C.lime, TA.dema(TA.closes(c), num(c, par, 'period', 20)))] }),
  },
  {
    id: 'tema', name: 'TEMA', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 2, 200, 20)],
    description: 'Triple EMA - 3*EMA1 - 3*EMA2 + EMA3.',
    compute: (c, par) => ({ lines: [line('tema', C.rose, TA.tema(TA.closes(c), num(c, par, 'period', 20)))] }),
  },
  {
    id: 'trima', name: 'TRIMA', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 3, 200, 20)],
    description: 'Triangular Moving Average - SMA of SMA, very smooth.',
    compute: (c, par) => ({ lines: [line('trima', C.slate, TA.trima(TA.closes(c), num(c, par, 'period', 20)))] }),
  },
  {
    id: 'kama', name: 'KAMA', category: 'overlap', pane: 'overlay',
    params: [p('period', 'ER Period', 2, 100, 10), p('fast', 'Fast EMA', 1, 10, 2), p('slow', 'Slow EMA', 10, 60, 30)],
    description: 'Kaufman Adaptive MA - speeds up in trends, slows in chop.',
    compute: (c, par) => ({
      lines: [line('kama', C.violet, TA.kama(TA.closes(c), num(c, par, 'period', 10), num(c, par, 'fast', 2), num(c, par, 'slow', 30)))],
    }),
  },
  {
    id: 'hma', name: 'Hull MA', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 4, 200, 16)],
    description: 'Hull Moving Average - extremely low lag weighted MA.',
    compute: (c, par) => ({ lines: [line('hma', C.cyan, TA.hma(TA.closes(c), num(c, par, 'period', 16)))] }),
  },
  {
    id: 'vwma', name: 'VWMA', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 2, 200, 20)],
    description: 'Volume Weighted Moving Average.',
    compute: (c, par) => ({ lines: [line('vwma', C.pink, TA.vwma(TA.closes(c), c.map((k) => k.volume), num(c, par, 'period', 20)))] }),
  },
  {
    id: 'zlema', name: 'ZLEMA', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 2, 200, 20)],
    description: 'Zero-Lag EMA - de-lagged price input.',
    compute: (c, par) => ({ lines: [line('zlema', C.yellow, TA.zlema(TA.closes(c), num(c, par, 'period', 20)))] }),
  },
  {
    id: 't3', name: 'T3', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 2, 50, 5), p('vf', 'Volume Factor', 0, 1, 0.7, 0.1)],
    description: 'Tillson T3 - six EMAs blended with a volume factor.',
    compute: (c, par) => ({ lines: [line('t3', C.green, TA.t3(TA.closes(c), num(c, par, 'period', 5), num(c, par, 'vf', 0.7)))] }),
  },
  {
    id: 'mcginley', name: 'McGinley Dynamic', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'McGinley Dynamic - self-adjusting MA that hugs price.',
    compute: (c, par) => ({ lines: [line('md', C.indigo, TA.mcginley(TA.closes(c), num(c, par, 'period', 14)))] }),
  },
  {
    id: 'envelope', name: 'MA Envelope', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 2, 200, 20), p('pct', 'Deviation %', 0.5, 10, 2.5, 0.1)],
    description: 'SMA with fixed percentage bands above/below.',
    compute: (c, par) => {
      const env = TA.envelope(TA.closes(c), num(c, par, 'period', 20), num(c, par, 'pct', 2.5))
      return { lines: [line('upper', C.slate, env.upper, 'dashed'), line('mid', C.slate, env.mid), line('lower', C.slate, env.lower, 'dashed')], fillBetween: [0, 2] }
    },
  },
  {
    id: 'linreg-line', name: 'Linear Regression', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 5, 200, 50)],
    description: 'Rolling least-squares regression endpoint line.',
    compute: (c, par) => ({ lines: [line('lr', C.pink, TA.linregLine(TA.closes(c), num(c, par, 'period', 50)))] }),
  },
  {
    id: 'midpoint', name: 'Midpoint', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Period', 2, 200, 14)],
    description: 'Midpoint of the highest high and lowest low over N bars.',
    compute: (c, par) => ({ lines: [line('mid', C.slate, TA.midpoint(TA.closes(c), num(c, par, 'period', 14)))] }),
  },
  {
    id: 'vwap', name: 'VWAP', category: 'overlap', pane: 'overlay',
    params: [],
    description: 'Volume Weighted Average Price - cumulative session anchor.',
    compute: (c) => ({ lines: [line('vwap', C.pink, TA.vwap(c), 'solid', 2)] }),
  },
  // MA presets (common chart defaults)
  {
    id: 'ema-9', name: 'EMA 9', category: 'overlap', pane: 'overlay', params: [],
    description: 'EMA(9) - scalp fast line.',
    compute: (c) => ({ lines: [line('ema9', '#67e8f9', TA.ema(TA.closes(c), 9))] }),
  },
  {
    id: 'ema-21', name: 'EMA 21', category: 'overlap', pane: 'overlay', params: [],
    description: 'EMA(21) - intraday trend line.',
    compute: (c) => ({ lines: [line('ema21', '#fbbf24', TA.ema(TA.closes(c), 21))] }),
  },
  {
    id: 'ema-50', name: 'EMA 50', category: 'overlap', pane: 'overlay', params: [],
    description: 'EMA(50) - medium trend line.',
    compute: (c) => ({ lines: [line('ema50', '#fb923c', TA.ema(TA.closes(c), 50))] }),
  },
  {
    id: 'ema-100', name: 'EMA 100', category: 'overlap', pane: 'overlay', params: [],
    description: 'EMA(100) - swing trend line.',
    compute: (c) => ({ lines: [line('ema100', '#f87171', TA.ema(TA.closes(c), 100))] }),
  },
  {
    id: 'ema-200', name: 'EMA 200', category: 'overlap', pane: 'overlay', params: [],
    description: 'EMA(200) - the institutional trend divider.',
    compute: (c) => ({ lines: [line('ema200', '#c084fc', TA.ema(TA.closes(c), 200), 'solid', 2)] }),
  },
  {
    id: 'sma-50', name: 'SMA 50', category: 'overlap', pane: 'overlay', params: [],
    description: 'SMA(50) - medium baseline.',
    compute: (c) => ({ lines: [line('sma50', '#60a5fa', TA.sma(TA.closes(c), 50))] }),
  },
  {
    id: 'sma-200', name: 'SMA 200', category: 'overlap', pane: 'overlay', params: [],
    description: 'SMA(200) - golden/death cross baseline.',
    compute: (c) => ({ lines: [line('sma200', '#a5b4fc', TA.sma(TA.closes(c), 200), 'solid', 2)] }),
  },
  {
    id: 'ma-ribbon', name: 'MA Ribbon', category: 'overlap', pane: 'overlay', params: [],
    description: 'Ribbon of 6 EMAs (10..60) - trend strength at a glance.',
    compute: (c) => {
      const cl = TA.closes(c)
      const colors = ['#38bdf8', '#2dd4bf', '#a3e635', '#facc15', '#fb923c', '#f43f5e']
      return {
        lines: [10, 20, 30, 40, 50, 60].map((pp, i) => line(`ema${pp}`, colors[i], TA.ema(cl, pp))),
      }
    },
  },
  {
    id: 'alligator', name: 'Alligator', category: 'overlap', pane: 'overlay', params: [],
    description: "Williams Alligator - jaw (13), teeth (8), lips (5) smoothed MAs.",
    compute: (c) => {
      const cl = TA.closes(c)
      const sm = (src: number[], period: number) => TA.trima(src, period)
      return {
        lines: [
          line('jaw', C.blue, sm(cl, 13).map((v, i) => (isn(v) ? v : NaN))),
          line('teeth', C.red, sm(cl, 8)),
          line('lips', C.green, sm(cl, 5)),
        ],
      }
    },
  },
]

// ============================ MOMENTUM ============================

const momentum: IndicatorDef[] = [
  {
    id: 'rsi', name: 'RSI', category: 'momentum', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Relative Strength Index - 0..100 speed of price moves.',
    compute: (c, par) => ({
      lines: [line('rsi', C.violet, TA.rsi(TA.closes(c), num(c, par, 'period', 14)))],
      levels: [30, 50, 70], bands: [0, 100],
    }),
  },
  {
    id: 'stochastic', name: 'Stochastic', category: 'momentum', pane: 'sub',
    params: [p('k', '%K Length', 2, 100, 14), p('d', '%D Smooth', 1, 20, 3), p('smooth', '%K Smooth', 1, 20, 3)],
    description: 'Stochastic Oscillator %K/%D - position within recent range.',
    compute: (c, par) => {
      const { k, d } = TA.stochastic(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'k', 14), num(c, par, 'd', 3), num(c, par, 'smooth', 3))
      return { lines: [line('k', C.blue, k), line('d', C.orange, d)], levels: [20, 80], bands: [0, 100] }
    },
  },
  {
    id: 'stoch-fast', name: 'Stochastic Fast', category: 'momentum', pane: 'sub',
    params: [p('k', '%K Length', 2, 100, 14), p('d', '%D Length', 1, 20, 3)],
    description: 'Fast Stochastic - raw %K with short %D.',
    compute: (c, par) => {
      const { k, d } = TA.stochastic(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'k', 14), num(c, par, 'd', 3), 1)
      return { lines: [line('k', C.teal, k), line('d', C.rose, d)], levels: [20, 80], bands: [0, 100] }
    },
  },
  {
    id: 'stochrsi', name: 'Stochastic RSI', category: 'momentum', pane: 'sub',
    params: [p('rsi', 'RSI Length', 2, 50, 14), p('stoch', 'Stoch Length', 2, 50, 14), p('k', '%K Smooth', 1, 10, 3), p('d', '%D Smooth', 1, 10, 3)],
    description: 'Stochastic applied to RSI - hyper-sensitive momentum.',
    compute: (c, par) => {
      const { k, d } = TA.stochRsi(TA.closes(c), num(c, par, 'rsi', 14), num(c, par, 'stoch', 14), num(c, par, 'k', 3), num(c, par, 'd', 3))
      return { lines: [line('k', C.cyan, k), line('d', C.pink, d)], levels: [20, 80], bands: [0, 100] }
    },
  },
  {
    id: 'macd', name: 'MACD', category: 'momentum', pane: 'sub',
    params: [p('fast', 'Fast', 2, 100, 12), p('slow', 'Slow', 2, 200, 26), p('signal', 'Signal', 1, 50, 9)],
    description: 'MACD line, signal line and histogram.',
    compute: (c, par) => {
      const m = TA.macd(TA.closes(c), num(c, par, 'fast', 12), num(c, par, 'slow', 26), num(c, par, 'signal', 9))
      return {
        lines: [line('macd', C.blue, m.macd), line('signal', C.orange, m.signal)],
        hist: { values: m.hist, color: 'updown' }, levels: [0],
      }
    },
  },
  {
    id: 'ppo', name: 'PPO', category: 'momentum', pane: 'sub',
    params: [p('fast', 'Fast', 2, 100, 12), p('slow', 'Slow', 2, 200, 26), p('signal', 'Signal', 1, 50, 9)],
    description: 'Percentage Price Oscillator - scale-free MACD.',
    compute: (c, par) => {
      const m = TA.ppo(TA.closes(c), num(c, par, 'fast', 12), num(c, par, 'slow', 26), num(c, par, 'signal', 9))
      return {
        lines: [line('ppo', C.blue, m.ppo), line('signal', C.orange, m.signal)],
        hist: { values: m.hist, color: 'updown' }, levels: [0],
      }
    },
  },
  {
    id: 'apo', name: 'APO', category: 'momentum', pane: 'sub',
    params: [p('fast', 'Fast', 2, 100, 12), p('slow', 'Slow', 2, 200, 26)],
    description: 'Absolute Price Oscillator - EMA fast minus slow.',
    compute: (c, par) => ({
      lines: [line('apo', C.green, TA.apo(TA.closes(c), num(c, par, 'fast', 12), num(c, par, 'slow', 26)))],
      levels: [0],
    }),
  },
  {
    id: 'cmo', name: 'Chande MO', category: 'momentum', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Chande Momentum Oscillator - -100..100.',
    compute: (c, par) => ({
      lines: [line('cmo', C.yellow, TA.cmo(TA.closes(c), num(c, par, 'period', 14)))],
      levels: [-50, 50], bands: [-100, 100],
    }),
  },
  {
    id: 'momentum', name: 'Momentum', category: 'momentum', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 10)],
    description: 'Momentum - close minus close N bars ago.',
    compute: (c, par) => ({
      lines: [line('mom', C.teal, TA.mom(TA.closes(c), num(c, par, 'period', 10)))],
      levels: [0],
    }),
  },
  {
    id: 'roc', name: 'ROC', category: 'momentum', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 12)],
    description: 'Rate of Change in %.',
    compute: (c, par) => ({
      lines: [line('roc', C.orange, TA.roc(TA.closes(c), num(c, par, 'period', 12)))],
      levels: [0],
    }),
  },
  {
    id: 'williams-r', name: 'Williams %R', category: 'momentum', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Williams %R - inverted stochastic -0..-100.',
    compute: (c, par) => ({
      lines: [line('wr', C.red, TA.williamsR(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'period', 14)))],
      levels: [-80, -20], bands: [-100, 0],
    }),
  },
  {
    id: 'tsi', name: 'TSI', category: 'momentum', pane: 'sub',
    params: [p('long', 'Long', 5, 100, 25), p('short', 'Short', 2, 50, 13)],
    description: 'True Strength Index - double-smoothed momentum.',
    compute: (c, par) => {
      const t = TA.tsi(TA.closes(c), num(c, par, 'long', 25), num(c, par, 'short', 13))
      return { lines: [line('tsi', C.blue, t.tsi), line('signal', C.orange, t.signal)], levels: [-25, 0, 25], bands: [-100, 100] }
    },
  },
  {
    id: 'ultimate-osc', name: 'Ultimate Osc', category: 'momentum', pane: 'sub',
    params: [p('p1', 'Fast', 2, 20, 7), p('p2', 'Mid', 5, 40, 14), p('p3', 'Slow', 10, 60, 28)],
    description: 'Ultimate Oscillator - 3 timeframe buying pressure blend.',
    compute: (c, par) => ({
      lines: [line('uo', C.lime, TA.ultimateOsc(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'p1', 7), num(c, par, 'p2', 14), num(c, par, 'p3', 28)))],
      levels: [30, 50, 70], bands: [0, 100],
    }),
  },
  {
    id: 'cci', name: 'CCI', category: 'momentum', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 20)],
    description: 'Commodity Channel Index - deviation from typical price.',
    compute: (c, par) => ({
      lines: [line('cci', C.orange, TA.cci(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'period', 20)))],
      levels: [-100, 100],
    }),
  },
  {
    id: 'dpo', name: 'DPO', category: 'momentum', pane: 'sub',
    params: [p('period', 'Period', 4, 100, 20)],
    description: 'Detrended Price Oscillator - cycle peaks/troughs.',
    compute: (c, par) => ({
      lines: [line('dpo', C.violet, TA.dpo(TA.closes(c), num(c, par, 'period', 20)))],
      levels: [0],
    }),
  },
  {
    id: 'kst', name: 'KST', category: 'momentum', pane: 'sub',
    params: [],
    description: 'Know Sure Thing - 4 ROC terms smoothed.',
    compute: (c) => {
      const k = TA.kst(TA.closes(c))
      return { lines: [line('kst', C.blue, k.kst), line('signal', C.orange, k.signal)], levels: [0] }
    },
  },
  {
    id: 'rvi', name: 'RVI', category: 'momentum', pane: 'sub',
    params: [p('period', 'Period', 4, 100, 10)],
    description: 'Relative Vigor Index - close location within range.',
    compute: (c, par) => {
      const r = TA.rvi(TA.closes(c), TA.highs(c), TA.lows(c), num(c, par, 'period', 10))
      return { lines: [line('rvi', C.green, r.rvi), line('signal', C.red, r.signal)], levels: [0] }
    },
  },
  {
    id: 'fisher', name: 'Fisher Transform', category: 'momentum', pane: 'sub',
    params: [p('period', 'Period', 3, 50, 9)],
    description: 'Fisher Transform - turns prices into a Gaussian-normalized wave.',
    compute: (c, par) => {
      const f = TA.fisherTransform(TA.highs(c), TA.lows(c), num(c, par, 'period', 9))
      return { lines: [line('fisher', C.violet, f.fisher), line('trigger', C.slate, f.trigger, 'dashed')], levels: [0] }
    },
  },
  {
    id: 'awesome-osc', name: 'Awesome Osc', category: 'momentum', pane: 'sub',
    params: [],
    description: 'Awesome Oscillator - SMA5-SMA34 of HL2.',
    compute: (c) => ({
      lines: [line('ao', C.blue, TA.awesomeOsc(TA.highs(c), TA.lows(c)))],
      hist: { values: TA.awesomeOsc(TA.highs(c), TA.lows(c)), color: 'updown' }, levels: [0],
    }),
  },
  {
    id: 'qstick', name: 'Qstick', category: 'momentum', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Qstick - SMA of candle body (close-open).',
    compute: (c, par) => ({
      lines: [line('qs', C.cyan, TA.qstick(c.map((k) => k.open), TA.closes(c), num(c, par, 'period', 14)))],
      levels: [0],
    }),
  },
  {
    id: 'stc', name: 'Schaff TC', category: 'momentum', pane: 'sub',
    params: [p('fast', 'Fast MACD', 2, 50, 23), p('slow', 'Slow MACD', 10, 100, 50), p('cycle', 'Cycle', 5, 50, 10)],
    description: 'Schaff Trend Cycle - stochastic of MACD, 0..100.',
    compute: (c, par) => {
      const cl = TA.closes(c)
      const m = TA.macd(cl, num(c, par, 'fast', 23), num(c, par, 'slow', 50), 9)
      const cyc = num(c, par, 'cycle', 10)
      const raw = new Array<number>(cl.length).fill(NaN)
      for (let i = cyc; i < cl.length; i++) {
        let hh = -Infinity
        let ll = Infinity
        for (let j = 0; j < cyc; j++) {
          const v = m.macd[i - j]
          if (!isn(v)) continue
          hh = Math.max(hh, v)
          ll = Math.min(ll, v)
        }
        raw[i] = hh === ll ? 50 : ((m.macd[i] - ll) / (hh - ll)) * 100
      }
      const k = TA.rsi(raw.map((v) => (isn(v) ? v : 50)), 3)
      return { lines: [line('stc', C.pink, k)], levels: [25, 75], bands: [0, 100] }
    },
  },
  {
    id: 'bop', name: 'Balance of Power', category: 'momentum', pane: 'sub',
    params: [p('period', 'Smooth', 1, 50, 14)],
    description: 'BOP - who wins each candle, body vs range.',
    compute: (c, par) => {
      const raw = c.map((k) => (k.high - k.low === 0 ? 0 : (k.close - k.open) / (k.high - k.low)))
      return {
        lines: [line('bop', C.green, TA.sma(raw, num(c, par, 'period', 14)))],
        levels: [0], bands: [-1, 1],
      }
    },
  },
]

// ============================ VOLUME ============================

const volume: IndicatorDef[] = [
  {
    id: 'obv', name: 'OBV', category: 'volume', pane: 'sub', params: [],
    description: 'On-Balance Volume - cumulative signed volume.',
    compute: (c) => ({ lines: [line('obv', C.blue, TA.obv(TA.closes(c), c.map((k) => k.volume)))] }),
  },
  {
    id: 'mfi', name: 'MFI', category: 'volume', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Money Flow Index - volume-weighted RSI.',
    compute: (c, par) => ({
      lines: [line('mfi', C.green, TA.mfi(TA.highs(c), TA.lows(c), TA.closes(c), c.map((k) => k.volume), num(c, par, 'period', 14)))],
      levels: [20, 50, 80], bands: [0, 100],
    }),
  },
  {
    id: 'adl', name: 'A/D Line', category: 'volume', pane: 'sub', params: [],
    description: 'Accumulation/Distribution Line.',
    compute: (c) => ({ lines: [line('adl', C.teal, TA.adl(TA.highs(c), TA.lows(c), TA.closes(c), c.map((k) => k.volume)))] }),
  },
  {
    id: 'cmf', name: 'CMF', category: 'volume', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 20)],
    description: 'Chaikin Money Flow - -1..1.',
    compute: (c, par) => ({
      lines: [line('cmf', C.orange, TA.cmf(TA.highs(c), TA.lows(c), TA.closes(c), c.map((k) => k.volume), num(c, par, 'period', 20)))],
      hist: { values: TA.cmf(TA.highs(c), TA.lows(c), TA.closes(c), c.map((k) => k.volume), num(c, par, 'period', 20)), color: 'updown' },
      levels: [0], bands: [-0.5, 0.5],
    }),
  },
  {
    id: 'chaikin-osc', name: 'Chaikin Osc', category: 'volume', pane: 'sub',
    params: [p('fast', 'Fast', 2, 20, 3), p('slow', 'Slow', 5, 50, 10)],
    description: 'Chaikin Oscillator - EMA spread of A/D line.',
    compute: (c, par) => ({
      lines: [line('cho', C.violet, TA.chaikinOsc(TA.highs(c), TA.lows(c), TA.closes(c), c.map((k) => k.volume), num(c, par, 'fast', 3), num(c, par, 'slow', 10)))],
      levels: [0],
    }),
  },
  {
    id: 'force-index', name: 'Force Index', category: 'volume', pane: 'sub',
    params: [p('period', 'Period', 1, 50, 13)],
    description: 'Elder Force Index - price*volume thrust.',
    compute: (c, par) => ({
      lines: [line('fi', C.pink, TA.forceIndex(TA.closes(c), c.map((k) => k.volume), num(c, par, 'period', 13)))],
      levels: [0],
    }),
  },
  {
    id: 'eom', name: 'Ease of Movement', category: 'volume', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'EOM - how easily price moves on volume.',
    compute: (c, par) => ({
      lines: [line('eom', C.lime, TA.eom(TA.highs(c), TA.lows(c), c.map((k) => k.volume), num(c, par, 'period', 14)))],
      levels: [0],
    }),
  },
  {
    id: 'nvi', name: 'NVI', category: 'volume', pane: 'sub', params: [],
    description: 'Negative Volume Index - smart money days.',
    compute: (c) => ({ lines: [line('nvi', C.red, TA.nvi(TA.closes(c), c.map((k) => k.volume)))] }),
  },
  {
    id: 'pvi', name: 'PVI', category: 'volume', pane: 'sub', params: [],
    description: 'Positive Volume Index - crowd days.',
    compute: (c) => ({ lines: [line('pvi', C.green, TA.pvi(TA.closes(c), c.map((k) => k.volume)))] }),
  },
  {
    id: 'klinger', name: 'Klinger VO', category: 'volume', pane: 'sub',
    params: [p('fast', 'Fast', 10, 60, 34), p('slow', 'Slow', 20, 100, 55), p('signal', 'Signal', 3, 30, 13)],
    description: 'Klinger Volume Oscillator.',
    compute: (c, par) => {
      const k = TA.klinger(TA.highs(c), TA.lows(c), TA.closes(c), c.map((x) => x.volume), num(c, par, 'fast', 34), num(c, par, 'slow', 55))
      return { lines: [line('vf', C.blue, k.vf), line('signal', C.orange, k.signal)], levels: [0] }
    },
  },
  {
    id: 'vol-osc', name: 'Volume Osc', category: 'volume', pane: 'sub',
    params: [p('fast', 'Fast', 2, 50, 5), p('slow', 'Slow', 5, 100, 20)],
    description: 'Volume Oscillator - % spread of two volume MAs.',
    compute: (c, par) => {
      const vol = c.map((k) => k.volume)
      const f = TA.sma(vol, num(c, par, 'fast', 5))
      const s = TA.sma(vol, num(c, par, 'slow', 20))
      const out = f.map((v, i) => (isn(v) && isn(s[i]) && s[i] !== 0 ? ((v - s[i]) / s[i]) * 100 : NaN))
      return { lines: [line('vo', C.yellow, out)], levels: [0] }
    },
  },
  {
    id: 'pvt', name: 'PVT', category: 'volume', pane: 'sub', params: [],
    description: 'Price Volume Trend - OBV refined with % change.',
    compute: (c) => {
      const cl = TA.closes(c)
      const out = new Array<number>(cl.length).fill(0)
      for (let i = 1; i < cl.length; i++) {
        const pct = cl[i - 1] === 0 ? 0 : (cl[i] - cl[i - 1]) / cl[i - 1]
        out[i] = out[i - 1] + pct * c[i].volume
      }
      return { lines: [line('pvt', C.cyan, out)] }
    },
  },
]

// ============================ VOLATILITY ============================

const volatility: IndicatorDef[] = [
  {
    id: 'atr', name: 'ATR', category: 'volatility', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Average True Range - absolute volatility unit.',
    compute: (c, par) => ({ lines: [line('atr', C.orange, TA.atr(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'period', 14)))] }),
  },
  {
    id: 'natr', name: 'NATR', category: 'volatility', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Normalized ATR - ATR as % of price.',
    compute: (c, par) => ({ lines: [line('natr', C.yellow, TA.natr(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'period', 14)))] }),
  },
  {
    id: 'trange', name: 'True Range', category: 'volatility', pane: 'sub', params: [],
    description: 'Raw True Range per candle.',
    compute: (c) => ({ lines: [line('tr', C.slate, TA.trange(TA.highs(c), TA.lows(c), TA.closes(c)))] }),
  },
  {
    id: 'bollinger', name: 'Bollinger Bands', category: 'volatility', pane: 'overlay',
    params: [p('period', 'Period', 2, 200, 20), p('mult', 'StdDev', 0.5, 5, 2, 0.1)],
    description: 'Bollinger Bands - SMA ± N standard deviations.',
    compute: (c, par) => {
      const b = TA.bollinger(TA.closes(c), num(c, par, 'period', 20), num(c, par, 'mult', 2))
      return {
        lines: [line('upper', C.slate, b.upper, 'dashed'), line('mid', C.blue, b.mid), line('lower', C.slate, b.lower, 'dashed')],
        fillBetween: [0, 2],
      }
    },
  },
  {
    id: 'bb-percent-b', name: 'BB %B', category: 'volatility', pane: 'sub',
    params: [p('period', 'Period', 2, 200, 20), p('mult', 'StdDev', 0.5, 5, 2, 0.1)],
    description: 'Position within Bollinger Bands, 0..1.',
    compute: (c, par) => {
      const b = TA.bollinger(TA.closes(c), num(c, par, 'period', 20), num(c, par, 'mult', 2))
      return { lines: [line('pb', C.cyan, b.percentB)], levels: [0, 0.5, 1], bands: [-0.5, 1.5] }
    },
  },
  {
    id: 'bb-width', name: 'BB Width', category: 'volatility', pane: 'sub',
    params: [p('period', 'Period', 2, 200, 20), p('mult', 'StdDev', 0.5, 5, 2, 0.1)],
    description: 'Band width as % of midline - squeeze detector.',
    compute: (c, par) => {
      const b = TA.bollinger(TA.closes(c), num(c, par, 'period', 20), num(c, par, 'mult', 2))
      return { lines: [line('bw', C.indigo, b.width)] }
    },
  },
  {
    id: 'keltner', name: 'Keltner Channels', category: 'volatility', pane: 'overlay',
    params: [p('period', 'Period', 2, 200, 20), p('mult', 'ATR Mult', 0.5, 6, 2, 0.1)],
    description: 'EMA ± ATR channels.',
    compute: (c, par) => {
      const k = TA.keltner(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'period', 20), num(c, par, 'mult', 2))
      return {
        lines: [line('upper', C.teal, k.upper, 'dashed'), line('mid', C.teal, k.mid), line('lower', C.teal, k.lower, 'dashed')],
        fillBetween: [0, 2],
      }
    },
  },
  {
    id: 'donchian', name: 'Donchian Channels', category: 'volatility', pane: 'overlay',
    params: [p('period', 'Period', 2, 200, 20)],
    description: 'Highest-high / lowest-low channel - breakout baseline.',
    compute: (c, par) => {
      const d = TA.donchian(TA.highs(c), TA.lows(c), num(c, par, 'period', 20))
      return {
        lines: [line('upper', C.violet, d.upper, 'dashed'), line('mid', C.violet, d.mid, 'dotted'), line('lower', C.violet, d.lower, 'dashed')],
        fillBetween: [0, 2],
      }
    },
  },
  {
    id: 'ulcer', name: 'Ulcer Index', category: 'volatility', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Ulcer Index - depth and duration of drawdowns.',
    compute: (c, par) => ({ lines: [line('ui', C.red, TA.ulcerIndex(TA.closes(c), num(c, par, 'period', 14)))] }),
  },
  {
    id: 'chandelier', name: 'Chandelier Exit', category: 'volatility', pane: 'overlay',
    params: [p('period', 'Period', 2, 100, 22), p('mult', 'ATR Mult', 1, 6, 3, 0.1)],
    description: 'Chandelier trailing stop levels from the extreme.',
    compute: (c, par) => {
      const ch = TA.chandelierExit(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'period', 22), num(c, par, 'mult', 3))
      return { lines: [line('long', C.green, ch.long), line('short', C.red, ch.short)] }
    },
  },
  {
    id: 'mass-index', name: 'Mass Index', category: 'volatility', pane: 'sub',
    params: [p('period', 'EMA', 2, 30, 9), p('sum', 'Sum', 10, 50, 25)],
    description: 'Mass Index - reversal bulge above 27.',
    compute: (c, par) => ({
      lines: [line('mi', C.rose, TA.massIndex(TA.highs(c), TA.lows(c), num(c, par, 'period', 9), num(c, par, 'sum', 25)))],
      levels: [26.5, 27],
    }),
  },
  {
    id: 'hist-vol', name: 'Hist Volatility', category: 'volatility', pane: 'sub',
    params: [p('period', 'Period', 5, 200, 20)],
    description: 'Annualized historical volatility of log returns.',
    compute: (c, par) => ({ lines: [line('hv', C.orange, TA.histVol(TA.closes(c), num(c, par, 'period', 20)))] }),
  },
]

// ============================ TREND ============================

const trend: IndicatorDef[] = [
  {
    id: 'adx', name: 'ADX + DI', category: 'trend', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'ADX trend strength with +DI/-DI direction lines.',
    compute: (c, par) => {
      const a = TA.adx(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'period', 14))
      return { lines: [line('adx', C.white ?? '#e2e8f0', a.adx, 'solid', 2), line('+di', C.green, a.plusDI), line('-di', C.red, a.minusDI)], levels: [25] }
    },
  },
  {
    id: 'di-plus', name: '+DI', category: 'trend', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Plus Directional Indicator.',
    compute: (c, par) => ({
      lines: [line('+di', C.green, TA.adx(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'period', 14)).plusDI)],
    }),
  },
  {
    id: 'di-minus', name: '-DI', category: 'trend', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Minus Directional Indicator.',
    compute: (c, par) => ({
      lines: [line('-di', C.red, TA.adx(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'period', 14)).minusDI)],
    }),
  },
  {
    id: 'aroon', name: 'Aroon', category: 'trend', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Aroon Up/Down - time since recent extremes.',
    compute: (c, par) => {
      const a = TA.aroon(TA.highs(c), TA.lows(c), num(c, par, 'period', 14))
      return { lines: [line('up', C.green, a.up), line('down', C.red, a.down)], levels: [50], bands: [0, 100] }
    },
  },
  {
    id: 'aroon-osc', name: 'Aroon Osc', category: 'trend', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Aroon Oscillator - Up minus Down, -100..100.',
    compute: (c, par) => {
      const a = TA.aroon(TA.highs(c), TA.lows(c), num(c, par, 'period', 14))
      return { lines: [line('osc', C.violet, a.osc)], levels: [0], bands: [-100, 100] }
    },
  },
  {
    id: 'supertrend', name: 'Supertrend', category: 'trend', pane: 'overlay',
    params: [p('period', 'ATR Period', 2, 100, 10), p('mult', 'Multiplier', 0.5, 10, 3, 0.1)],
    description: 'ATR trailing stop that flips with trend.',
    compute: (c, par) => {
      const st = TA.supertrend(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'period', 10), num(c, par, 'mult', 3))
      // color split by direction
      const up = st.line.map((v, i) => (st.dir[i] === 1 ? v : NaN))
      const dn = st.line.map((v, i) => (st.dir[i] === -1 ? v : NaN))
      return { lines: [line('up', C.green, up, 'solid', 2), line('dn', C.red, dn, 'solid', 2)] }
    },
  },
  {
    id: 'psar', name: 'Parabolic SAR', category: 'trend', pane: 'overlay',
    params: [p('step', 'AF Step', 0.005, 0.1, 0.02, 0.005), p('max', 'AF Max', 0.1, 0.5, 0.2, 0.01)],
    description: 'Parabolic SAR stop-and-reverse dots.',
    compute: (c, par) => {
      const sar = TA.parabolicSar(TA.highs(c), TA.lows(c), num(c, par, 'step', 0.02), num(c, par, 'max', 0.2))
      return { lines: [line('sar', C.yellow, sar)] }
    },
  },
  {
    id: 'ichimoku', name: 'Ichimoku Cloud', category: 'trend', pane: 'overlay', params: [],
    description: 'Ichimoku - Tenkan, Kijun, Senkou A/B cloud.',
    compute: (c) => {
      const ik = TA.ichimoku(TA.highs(c), TA.lows(c))
      return {
        lines: [
          line('tenkan', C.blue, ik.tenkan),
          line('kijun', C.red, ik.kijun),
          line('senkouA', C.green, ik.senkouA, 'dashed'),
          line('senkouB', C.rose, ik.senkouB, 'dashed'),
        ],
        fillBetween: [2, 3],
      }
    },
  },
  {
    id: 'trix', name: 'TRIX', category: 'trend', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 15)],
    description: 'TRIX - triple-EMA % rate of change.',
    compute: (c, par) => {
      const t = TA.trix(TA.closes(c), num(c, par, 'period', 15))
      return { lines: [line('trix', C.pink, t.trix), line('signal', C.slate, t.signal)], levels: [0] }
    },
  },
  {
    id: 'vortex', name: 'Vortex', category: 'trend', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 14)],
    description: 'Vortex VI+/VI- - trend initiation detector.',
    compute: (c, par) => {
      const v = TA.vortex(TA.highs(c), TA.lows(c), TA.closes(c), num(c, par, 'period', 14))
      return { lines: [line('vi+', C.green, v.viPlus), line('vi-', C.red, v.viMinus)], levels: [1] }
    },
  },
  {
    id: 'zigzag', name: 'ZigZag', category: 'trend', pane: 'overlay',
    params: [p('dev', 'Deviation %', 1, 30, 5, 0.5)],
    description: 'ZigZag pivots beyond N% deviation.',
    compute: (c, par) => {
      const zz = TA.zigzag(TA.closes(c), num(c, par, 'dev', 5))
      const sparse = new Array<number>(c.length).fill(NaN)
      for (let i = 0; i < zz.time.length; i++) sparse[zz.time[i]] = zz.value[i]
      return { lines: [line('zz', C.yellow, sparse, 'solid', 2)] }
    },
  },
  {
    id: 'gann-hilo', name: 'Gann HiLo', category: 'trend', pane: 'overlay',
    params: [p('period', 'Period', 4, 100, 10)],
    description: 'Gann HiLo Activator - MA of highs/lows trend filter.',
    compute: (c, par) => {
      const per = num(c, par, 'period', 10)
      const sh = TA.sma(TA.highs(c), per)
      const sl = TA.sma(TA.lows(c), per)
      const cl = TA.closes(c)
      const out = new Array<number>(c.length).fill(NaN)
      let prev = NaN
      let dir = 1
      for (let i = per; i < c.length; i++) {
        if (!isn(prev)) dir = cl[i] > sh[i] ? 1 : -1
        else if (cl[i] > sh[i]) dir = 1
        else if (cl[i] < sl[i]) dir = -1
        out[i] = dir === 1 ? sl[i] : sh[i]
        prev = out[i]
      }
      return { lines: [line('hilo', C.cyan, out, 'solid', 2)] }
    },
  },
  {
    id: 'vhf', name: 'VHF', category: 'trend', pane: 'sub',
    params: [p('period', 'Period', 5, 200, 28)],
    description: 'Vertical Horizontal Filter - trend vs congestion.',
    compute: (c, par) => {
      const cl = TA.closes(c)
      const per = num(c, par, 'period', 28)
      const out = new Array<number>(cl.length).fill(NaN)
      for (let i = per - 1; i < cl.length; i++) {
        let hh = -Infinity
        let ll = Infinity
        let denom = 0
        for (let j = 0; j < per; j++) {
          hh = Math.max(hh, cl[i - j])
          ll = Math.min(ll, cl[i - j])
          if (j > 0) denom += Math.abs(cl[i - j + 1] - cl[i - j])
        }
        out[i] = denom === 0 ? 0 : (hh - ll) / denom
      }
      return { lines: [line('vhf', C.lime, out)] }
    },
  },
  {
    id: 'choppiness', name: 'Choppiness', category: 'trend', pane: 'sub',
    params: [p('period', 'Period', 4, 100, 14)],
    description: 'Choppiness Index - 0 (trend) .. 100 (chop).',
    compute: (c, par) => {
      const per = num(c, par, 'period', 14)
      const tr = TA.trange(TA.highs(c), TA.lows(c), TA.closes(c))
      const out = new Array<number>(c.length).fill(NaN)
      for (let i = per; i < c.length; i++) {
        let sumTR = 0
        let hh = -Infinity
        let ll = Infinity
        for (let j = 0; j < per; j++) {
          sumTR += tr[i - j]
          hh = Math.max(hh, c[i - j].high)
          ll = Math.min(ll, c[i - j].low)
        }
        const range = hh - ll
        out[i] = range === 0 ? 50 : (100 * Math.log10(sumTR / range)) / Math.log10(per)
      }
      return { lines: [line('chop', C.slate, out)], levels: [38.2, 61.8], bands: [0, 100] }
    },
  },
]

// ============================ CYCLE / STATISTIC ============================

const statistic: IndicatorDef[] = [
  {
    id: 'hilbert-sine', name: 'Hilbert Sine Wave', category: 'cycle', pane: 'sub',
    params: [p('period', 'Period', 10, 100, 32)],
    description: 'Ehlers-style dominant cycle sine wave with lead line.',
    compute: (c, par) => {
      const h = TA.hilbertSine(TA.closes(c), num(c, par, 'period', 32))
      return { lines: [line('sine', C.blue, h.sine), line('lead', C.orange, h.lead, 'dashed')], bands: [-1.2, 1.2] }
    },
  },
  {
    id: 'zscore', name: 'Z-Score', category: 'statistic', pane: 'sub',
    params: [p('period', 'Period', 5, 200, 20)],
    description: 'Price z-score vs rolling mean - mean reversion gauge.',
    compute: (c, par) => ({
      lines: [line('z', C.violet, TA.zscoreSeries(TA.closes(c), num(c, par, 'period', 20)))],
      levels: [-2, 0, 2],
    }),
  },
  {
    id: 'variance', name: 'Variance', category: 'statistic', pane: 'sub',
    params: [p('period', 'Period', 2, 200, 20)],
    description: 'Rolling variance of price.',
    compute: (c, par) => ({ lines: [line('var', C.slate, TA.varianceSeries(TA.closes(c), num(c, par, 'period', 20)))] }),
  },
  {
    id: 'stddev', name: 'Std Dev', category: 'statistic', pane: 'sub',
    params: [p('period', 'Period', 2, 200, 20)],
    description: 'Rolling standard deviation of price.',
    compute: (c, par) => ({ lines: [line('sd', C.teal, TA.stdDev(TA.closes(c), num(c, par, 'period', 20)))] }),
  },
  {
    id: 'linreg-slope', name: 'LinReg Slope', category: 'statistic', pane: 'sub',
    params: [p('period', 'Period', 5, 200, 20)],
    description: 'Rolling regression slope - trend velocity.',
    compute: (c, par) => {
      const cl = TA.closes(c)
      const per = num(c, par, 'period', 20)
      const out = new Array<number>(cl.length).fill(NaN)
      for (let i = per - 1; i < cl.length; i++) {
        let sx = 0
        let sy = 0
        let sxy = 0
        let sxx = 0
        for (let j = 0; j < per; j++) {
          sx += j
          sy += cl[i - per + 1 + j]
          sxy += j * cl[i - per + 1 + j]
          sxx += j * j
        }
        const denom = per * sxx - sx * sx
        out[i] = denom === 0 ? 0 : (per * sxy - sx * sy) / denom
      }
      return { lines: [line('slope', C.green, out)], levels: [0] }
    },
  },
  {
    id: 'correlation', name: 'Price-Volume Corr', category: 'statistic', pane: 'sub',
    params: [p('period', 'Period', 5, 200, 20)],
    description: 'Rolling correlation between close and volume.',
    compute: (c, par) => ({
      lines: [line('corr', C.yellow, TA.correlation(TA.closes(c), c.map((k) => k.volume), num(c, par, 'period', 20)))],
      bands: [-1, 1], levels: [0],
    }),
  },
]

// ============================ OVERLAY EXTRAS ============================

const extras: IndicatorDef[] = [
  {
    id: 'pivot-points', name: 'Pivot Points', category: 'overlap', pane: 'overlay',
    params: [p('period', 'Window', 10, 200, 20)],
    description: 'Classic floor pivots PP/R1-R3/S1-S3 over recent window.',
    compute: (c, par) => {
      const w = Math.max(10, num(c, par, 'period', 20))
      const out: IndicatorOutput['lines'] = []
      const labels = ['pp', 'r1', 'r2', 'r3', 's1', 's2', 's3']
      const colors = [C.yellow, C.red, C.red, C.red, C.green, C.green, C.green]
      for (let li = 0; li < 7; li++) {
        const vals = new Array<number>(c.length).fill(NaN)
        for (let i = w; i < c.length; i++) {
          const window = c.slice(i - w, i)
          const h = Math.max(...window.map((x) => x.high))
          const l = Math.min(...window.map((x) => x.low))
          const cl = window[window.length - 1].close
          const pp = (h + l + cl) / 3
          const range = h - l
          const set = [pp, 2 * pp - l, pp + range, h + 2 * (pp - l), 2 * pp - h, pp - range, l - 2 * (h - pp)]
          vals[i] = set[li]
        }
        out.push(line(labels[li], colors[li], vals, li === 0 ? 'solid' : 'dashed'))
      }
      return { lines: out }
    },
  },
  {
    id: 'fib-levels', name: 'Fibonacci Retracement', category: 'overlap', pane: 'overlay',
    params: [p('lookback', 'Lookback', 20, 500, 60)],
    description: 'Auto fib retracement of the recent swing.',
    compute: (c, par) => {
      const lb = num(c, par, 'lookback', 60)
      const out: IndicatorOutput['lines'] = []
      const lv = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
      const colors = ['#94a3b8', '#f43f5e', '#fb923c', '#facc15', '#a3e635', '#2dd4bf', '#94a3b8']
      lv.forEach((r, li) => {
        const vals = new Array<number>(c.length).fill(NaN)
        for (let i = lb; i < c.length; i++) {
          const window = c.slice(i - lb, i)
          const h = Math.max(...window.map((x) => x.high))
          const l = Math.min(...window.map((x) => x.low))
          const diff = h - l
          const up = window[window.length - 1].close >= (h + l) / 2
          vals[i] = up ? h - diff * r : l + diff * r
        }
        out.push(line(`fib${r}`, colors[li], vals, 'dotted'))
      })
      return { lines: out }
    },
  },
]

// ============================ EXTRA PACK ============================

const extras2: IndicatorDef[] = [
  {
    id: 'rsi-2', name: 'RSI (2)', category: 'momentum', pane: 'sub', params: [],
    description: 'Connors-style ultra-short RSI(2) - extreme snapback signals.',
    compute: (c) => ({
      lines: [line('rsi2', C.rose, TA.rsi(TA.closes(c), 2))],
      levels: [5, 50, 95], bands: [0, 100],
    }),
  },
  {
    id: 'atr-bands', name: 'ATR Bands', category: 'volatility', pane: 'overlay',
    params: [p('period', 'Period', 2, 100, 14), p('mult', 'Multiplier', 0.5, 6, 2, 0.1)],
    description: 'Wilder volatility bands - close ± ATR * mult.',
    compute: (c, par) => {
      const cl = TA.closes(c)
      const a = TA.atr(TA.highs(c), TA.lows(c), cl, num(c, par, 'period', 14))
      const m = num(c, par, 'mult', 2)
      return {
        lines: [line('upper', C.orange, cl.map((v, i) => (isn(a[i]) ? v + m * a[i] : NaN)), 'dashed'), line('lower', C.orange, cl.map((v, i) => (isn(a[i]) ? v - m * a[i] : NaN)), 'dashed')],
        fillBetween: [0, 1],
      }
    },
  },
  {
    id: 'fractals', name: 'Williams Fractals', category: 'trend', pane: 'overlay', params: [],
    description: 'Bill Williams fractal highs/lows - swing markers.',
    compute: (c) => {
      const fh = new Array<number>(c.length).fill(NaN)
      const fl = new Array<number>(c.length).fill(NaN)
      for (let i = 2; i < c.length - 2; i++) {
        if (c[i].high >= c[i - 1].high && c[i].high >= c[i - 2].high && c[i].high >= c[i + 1].high && c[i].high >= c[i + 2].high) fh[i] = c[i].high
        if (c[i].low <= c[i - 1].low && c[i].low <= c[i - 2].low && c[i].low <= c[i + 1].low && c[i].low <= c[i + 2].low) fl[i] = c[i].low
      }
      return { lines: [line('fh', C.red, fh), line('fl', C.green, fl)] }
    },
  },
  {
    id: 'high-low', name: 'High-Low Channel', category: 'trend', pane: 'overlay',
    params: [p('period', 'Period', 2, 200, 50)],
    description: 'Raw highest-high / lowest-low lines over N bars.',
    compute: (c, par) => {
      const per = num(c, par, 'period', 50)
      const hi = new Array<number>(c.length).fill(NaN)
      const lo = new Array<number>(c.length).fill(NaN)
      for (let i = per - 1; i < c.length; i++) {
        let hh = -Infinity
        let ll = Infinity
        for (let j = 0; j < per; j++) {
          hh = Math.max(hh, c[i - j].high)
          ll = Math.min(ll, c[i - j].low)
        }
        hi[i] = hh
        lo[i] = ll
      }
      return { lines: [line('hh', C.slate, hi, 'dotted'), line('ll', C.slate, lo, 'dotted')], fillBetween: [0, 1] }
    },
  },
  {
    id: 'rel-volume', name: 'Relative Volume', category: 'volume', pane: 'sub',
    params: [p('period', 'MA Period', 5, 100, 20)],
    description: 'Volume / SMA(volume) ratio - 1.0 = average activity.',
    compute: (c, par) => {
      const vol = c.map((k) => k.volume)
      const ma = TA.sma(vol, num(c, par, 'period', 20))
      return { lines: [line('rvol', C.yellow, vol.map((v, i) => (isn(ma[i]) && ma[i] !== 0 ? v / ma[i] : NaN)))], levels: [1, 2] }
    },
  },
  {
    id: 'vwap-bands', name: 'VWAP Bands', category: 'overlap', pane: 'overlay',
    params: [p('mult', 'StdDev Mult', 0.5, 4, 1, 0.1)],
    description: 'VWAP with rolling standard deviation bands.',
    compute: (c, par) => {
      const vw = TA.vwap(c)
      const m = num(c, par, 'mult', 1)
      const sd = TA.stdDev(TA.closes(c), 20)
      return {
        lines: [
          line('vwup', C.pink, vw.map((v, i) => (isn(v) && isn(sd[i]) ? v + m * sd[i] : NaN)), 'dashed'),
          line('vwap', C.pink, vw, 'solid', 2),
          line('vwlo', C.pink, vw.map((v, i) => (isn(v) && isn(sd[i]) ? v - m * sd[i] : NaN)), 'dashed'),
        ],
        fillBetween: [0, 2],
      }
    },
  },
  {
    id: 'roc-signal', name: 'ROC + Signal', category: 'momentum', pane: 'sub',
    params: [p('period', 'Period', 2, 100, 12), p('signal', 'Signal EMA', 2, 50, 9)],
    description: 'Rate of Change with EMA signal line.',
    compute: (c, par) => {
      const r = TA.roc(TA.closes(c), num(c, par, 'period', 12))
      const firstValid = r.findIndex(isn)
      const sig = firstValid >= 0 ? TA.ema(r.slice(firstValid).filter(isn), num(c, par, 'signal', 9)) : []
      const signal = new Array<number>(c.length).fill(NaN)
      for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i]
      return { lines: [line('roc', C.orange, r), line('sig', C.blue, signal)], levels: [0] }
    },
  },
  {
    id: 'sma-100', name: 'SMA 100', category: 'overlap', pane: 'overlay', params: [],
    description: 'SMA(100) - long swing baseline.',
    compute: (c) => ({ lines: [line('sma100', '#fbbf24', TA.sma(TA.closes(c), 100))] }),
  },
]

// ============================ REGISTRY EXPORT ============================

export const REGISTRY: IndicatorDef[] = [...overlap, ...momentum, ...volume, ...volatility, ...trend, ...statistic, ...extras, ...extras2]

const REGISTRY_MAP = new Map(REGISTRY.map((d) => [d.id, d]))

export function listRegistry(): Omit<IndicatorDef, 'compute'>[] {
  return REGISTRY.map(({ compute: _c, ...rest }) => rest)
}

export function getIndicatorDef(id: string): IndicatorDef | undefined {
  return REGISTRY_MAP.get(id)
}

export function registrySize(): number {
  return REGISTRY.length
}

/** Compute an indicator with partial params merged over defaults. */
export function computeIndicator(
  id: string,
  candles: Candle[],
  params?: Record<string, number>
): { def: IndicatorDef; output: IndicatorOutput } | null {
  const def = REGISTRY_MAP.get(id)
  if (!def) return null
  const merged: Record<string, number> = {}
  for (const pd of def.params) merged[pd.key] = pd.default
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'number' && Number.isFinite(v)) merged[k] = v
    }
  }
  return { def, output: def.compute(candles, merged) }
}

export const REGISTRY_STATS = {
  total: REGISTRY.length,
  byCategory: REGISTRY.reduce<Record<string, number>>((acc, d) => {
    acc[d.category] = (acc[d.category] ?? 0) + 1
    return acc
  }, {}),
}
