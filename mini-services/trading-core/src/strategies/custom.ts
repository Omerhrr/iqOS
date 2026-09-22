// IQAIR//OS - Custom (AI-learned) strategy DSL
// The Strategy Lab mines a pair's history for edge-bearing events and composes
// them into a CustomSpec: a portable, inspectable strategy definition the
// autopilot can trade (strategyId "custom:<id>"). The vocabulary spans the
// user's ask: candlestick patterns, bar formations, Heiken Ashi patterns,
// line/structural patterns, and parametric INDICATOR rules (the lab's own
// invented indicators - rsi/bbpos/zscore/donchianpos/macdz/slope/streak/
// wickbias/emasign/hadist/bodypos).
//
// Scoring model: every signal carries a weight (1..50, proportional to the
// measured edge). On each closed bar the active bull and bear signals vote:
//   score = 100 * (bullW - bearW) / (bullW + bearW)   (0 when nothing fires)
// A trade fires when |score| >= spec.minScore AND the winning side has at
// least spec.minVotes distinct signals behind it (confluence guard).
//
// CONSISTENCY CONTRACT: the learner and the live evaluator share the exact
// same per-bar activity tests (signalActive on a full-series context), so a
// backtested spec behaves identically when a bot trades it live.

import type { Candle, Side, StrategyEval } from '../types'
import * as ta from '../analytics/indicators'
import { detectPatterns } from '../analytics/patterns'

// ---------- signal vocabulary ----------

/** Candlestick pattern straight from the recognition library (e.g. "Bullish
 * Engulfing"). dir may invert the textbook implication to fade it. */
export interface CandleSignal {
  kind: 'candle'
  name: string
  dir: Side
  weight: number
}

/** Bar formation: an unusually wide body vs ATR (conviction/expansion bar). */
export interface BarSignal {
  kind: 'bar'
  variant: 'wide-bull' | 'wide-bear'
  atrK?: number // body >= atrK * ATR(14) (default 1.1)
  dir: Side
  weight: number
}

/** Heiken Ashi pattern. */
export interface HASignal {
  kind: 'ha'
  variant: 'flip-up' | 'flip-down' | 'streak-up' | 'streak-down' | 'strong-bull' | 'strong-bear'
  len?: number // streak/flip minimum run (default 3 for streak, 2 for flip)
  dir: Side
  weight: number
}

/** Line / structural pattern on the raw series. */
export interface LineSignal {
  kind: 'line'
  variant: 'breakout-up' | 'breakout-down' | 'hh-hl' | 'lh-ll'
  lookback?: number // breakout window (default 20) / run length (default 3)
  dir: Side
  weight: number
}

/** Parametric indicator rule - the lab's invented indicators. Fires when the
 * indicator value compares against `threshold` via `op`. */
export interface IndicatorSignal {
  kind: 'indicator'
  ind:
    | 'rsi' // RSI(period)
    | 'bbpos' // Bollinger %B (0..1)
    | 'zscore' // (close - SMA) / std
    | 'donchianpos' // close position inside the N-bar range 0..1
    | 'macdz' // MACD histogram / ATR
    | 'slope' // linreg slope / ATR
    | 'streak' // signed run of same-colour candles (+k green / -k red)
    | 'wickbias' // (lowerWick - upperWick) / range
    | 'emasign' // (emaFast - emaSlow) / ATR, magnitude-carrying
    | 'hadist' // (haClose - haOpen) / ATR
    | 'bodypos' // (close - low) / range
  params?: Record<string, number> // period/fast/slow/mult per indicator
  op: '>' | '<'
  threshold: number
  dir: Side
  weight: number
}

export type SignalDef = CandleSignal | BarSignal | HASignal | LineSignal | IndicatorSignal

export interface CustomSpec {
  name: string
  description?: string
  signals: SignalDef[]
  /** min |score| (0..100) to fire a trade */
  minScore: number
  /** confluence: min distinct signals behind the winning side */
  minVotes: number
  /** bars-ahead horizon the learner validated against (informational) */
  horizon: number
  /** The candle basis the spec was learned on and trades on: 'candles' (raw,
   * default) or 'heikin' (every signal reads the Heiken-Ashi transform of the
   * feed). Outcomes/settlement are ALWAYS measured on real prices either way. */
  basis?: 'candles' | 'heikin'
}

// ---------- heiken ashi ----------

export interface HASeries {
  open: number[]
  high: number[]
  low: number[]
  close: number[]
}

/** Heiken Ashi transform: smoothed opens/closes expose trend runs and bleed
 * out intrabar noise - the basis of the HA pattern family. */
export function heikinAshi(candles: Candle[]): HASeries {
  const n = candles.length
  const o: number[] = new Array(n)
  const h: number[] = new Array(n)
  const l: number[] = new Array(n)
  const c: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const k = candles[i]
    c[i] = (k.open + k.high + k.low + k.close) / 4
    o[i] = i === 0 ? (k.open + k.close) / 2 : (o[i - 1] + c[i - 1]) / 2
    h[i] = Math.max(k.high, o[i], c[i])
    l[i] = Math.min(k.low, o[i], c[i])
  }
  return { open: o, high: h, low: l, close: c }
}

/** Heiken-Ashi as a Candle[] (1:1 with the input series - same length, same
 * timestamps), so any signal family can be evaluated on the HA basis. */
export function heikinAshiCandles(candles: Candle[]): Candle[] {
  const ha = heikinAshi(candles)
  return candles.map((k, i) => ({ time: k.time, open: ha.open[i], high: ha.high[i], low: ha.low[i], close: ha.close[i], volume: k.volume }))
}

/** The candle series a spec's signals are evaluated on (raw or HA transform). */
export function basisCandles(spec: Pick<CustomSpec, 'basis'>, candles: Candle[]): Candle[] {
  return spec.basis === 'heikin' ? heikinAshiCandles(candles) : candles
}

// ---------- full-series evaluation context ----------

export interface EvalCtx {
  candles: Candle[]
  n: number
  close: number[]
  high: number[]
  low: number[]
  open: number[]
  atr: number[]
  ha: HASeries
  haColor: number[] // +1 green / -1 red / 0 flat
  body: number[]
  range: number[]
  hits: Map<string, 'bullish' | 'bearish' | 'neutral'> // candle patterns on the LAST bar only
}

export function buildCtx(candles: Candle[]): EvalCtx {
  const n = candles.length
  const close = candles.map((k) => k.close)
  const high = candles.map((k) => k.high)
  const low = candles.map((k) => k.low)
  const open = candles.map((k) => k.open)
  const atr = ta.atr(high, low, close, 14)
  const ha = heikinAshi(candles)
  const haColor = ha.close.map((v, i) => (v > ha.open[i] ? 1 : v < ha.open[i] ? -1 : 0))
  const body = candles.map((k) => Math.abs(k.close - k.open))
  const range = candles.map((k) => Math.max(k.high - k.low, 1e-12))
  const hits = new Map<string, 'bullish' | 'bearish' | 'neutral'>()
  if (n >= 13) {
    for (const hit of detectPatterns(candles, 1)) hits.set(hit.name.toLowerCase(), hit.direction)
  }
  return { candles, n, close, high, low, open, atr, ha, haColor, body, range, hits }
}

// ---------- indicator series (shared: learner + live evaluator) ----------

/** Full-length series for an indicator signal. Exactly the math the live
 * evaluator uses - the learner measures edge on THESE values. */
export function indicatorSeries(s: IndicatorSignal, ctx: EvalCtx): number[] {
  const p = s.params ?? {}
  const num = (v: number | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d)
  switch (s.ind) {
    case 'rsi':
      return ta.rsi(ctx.close, num(p.period, 14))
    case 'bbpos':
      return ta.bollinger(ctx.close, num(p.period, 20), num(p.mult, 2)).percentB
    case 'zscore': {
      const period = num(p.period, 20)
      const smaArr = ta.sma(ctx.close, period)
      const sd = ta.stdDev(ctx.close, period)
      return ctx.close.map((v, i) => (sd[i] > 1e-12 ? (v - smaArr[i]) / sd[i] : NaN))
    }
    case 'donchianpos': {
      const period = num(p.period, 20)
      const out: number[] = new Array(ctx.n).fill(NaN)
      for (let i = period; i < ctx.n; i++) {
        const win = ctx.candles.slice(i - period, i) // the `period` bars BEFORE i
        const hh = Math.max(...win.map((k) => k.high))
        const ll = Math.min(...win.map((k) => k.low))
        out[i] = hh - ll > 1e-12 ? (ctx.close[i] - ll) / (hh - ll) : NaN
      }
      return out
    }
    case 'macdz': {
      const md = ta.macd(ctx.close, num(p.fast, 12), num(p.slow, 26), num(p.signal, 9))
      return md.hist.map((v, i) => (ctx.atr[i] > 1e-12 ? v / ctx.atr[i] : NaN))
    }
    case 'slope': {
      // rolling least-squares slope over `period` closes, ATR-normalized
      const period = Math.max(2, num(p.period, 20))
      const out: number[] = new Array(ctx.n).fill(NaN)
      for (let i = period - 1; i < ctx.n; i++) {
        let sx = 0
        let sy = 0
        let sxy = 0
        let sxx = 0
        for (let j = 0; j < period; j++) {
          const y = ctx.close[i - period + 1 + j]
          sx += j
          sy += y
          sxy += j * y
          sxx += j * j
        }
        const denom = period * sxx - sx * sx
        const slope = denom === 0 ? 0 : (period * sxy - sx * sy) / denom
        out[i] = ctx.atr[i] > 1e-12 ? slope / ctx.atr[i] : NaN
      }
      return out
    }
    case 'streak': {
      const out: number[] = new Array(ctx.n).fill(0)
      let run = 0
      for (let i = 0; i < ctx.n; i++) {
        const sgn = Math.sign(ctx.close[i] - ctx.open[i])
        if (sgn === 0) run = 0
        else run = Math.sign(run) === sgn ? run + sgn : sgn
        out[i] = run
      }
      return out
    }
    case 'wickbias': {
      return ctx.candles.map((k, i) => {
        const uw = k.high - Math.max(k.open, k.close)
        const lw = Math.min(k.open, k.close) - k.low
        return (lw - uw) / ctx.range[i]
      })
    }
    case 'emasign': {
      const f = ta.ema(ctx.close, num(p.fast, 9))
      const sl = ta.ema(ctx.close, num(p.slow, 21))
      return f.map((v, i) => (ctx.atr[i] > 1e-12 ? (v - sl[i]) / ctx.atr[i] : NaN))
    }
    case 'hadist': {
      return ctx.ha.close.map((v, i) => (ctx.atr[i] > 1e-12 ? (v - ctx.ha.open[i]) / ctx.atr[i] : NaN))
    }
    case 'bodypos': {
      return ctx.candles.map((k, i) => (k.close - k.low) / ctx.range[i])
    }
  }
}

// ---------- per-signal activity ----------

/** Human label for a signal (alert notes, discovery table, eval notes). */
export function labelOf(s: SignalDef): string {
  switch (s.kind) {
    case 'candle':
      return s.name
    case 'bar':
      return s.variant === 'wide-bull' ? 'Wide Bull Bar' : 'Wide Bear Bar'
    case 'ha':
      return {
        'flip-up': 'HA Flip Up',
        'flip-down': 'HA Flip Down',
        'streak-up': 'HA Streak Up',
        'streak-down': 'HA Streak Down',
        'strong-bull': 'HA Strong Bull',
        'strong-bear': 'HA Strong Bear',
      }[s.variant]
    case 'line':
      return {
        'breakout-up': `Breakout Up(${s.lookback ?? 20})`,
        'breakout-down': `Breakout Down(${s.lookback ?? 20})`,
        'hh-hl': 'Higher Highs & Lows',
        'lh-ll': 'Lower Highs & Lows',
      }[s.variant]
    case 'indicator': {
      const p = s.params ?? {}
      const pd = p.period ?? p.fast
      return `${s.ind}${Number.isFinite(pd) ? `(${pd})` : ''} ${s.op} ${s.threshold}`
    }
  }
}

/** Inherent direction of a variant (textbook implication). */
export function impliedDir(s: SignalDef): Side {
  switch (s.kind) {
    case 'candle':
      return s.dir
    case 'bar':
      return s.variant === 'wide-bull' ? 'call' : 'put'
    case 'ha':
      return s.variant.endsWith('up') || s.variant === 'strong-bull' ? 'call' : 'put'
    case 'line':
      return s.variant.endsWith('up') || s.variant === 'hh-hl' ? 'call' : 'put'
    case 'indicator':
      return s.dir
  }
}

/** Precompute what a signal needs so `testAt` is O(1) per bar. */
export function prepareSignal(s: SignalDef, ctx: EvalCtx): (i: number) => boolean {
  const num = (v: number | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d)
  switch (s.kind) {
    case 'candle': {
      // candle recognition is per-bar (context windows) - handled by the
      // learner via detectPatterns; the live path uses the tail-bar hit map.
      const name = s.name.toLowerCase()
      const align = s.dir === 'call'
      return (i: number) => {
        if (i !== ctx.n - 1) return false
        const d = ctx.hits.get(name)
        return !!d && d !== 'neutral' && (d === 'bullish') === align
      }
    }
    case 'bar': {
      const k = num(s.atrK, 1.1)
      return (i: number) => {
        if (!(ctx.atr[i] > 1e-12)) return false
        const bull = ctx.close[i] > ctx.open[i]
        return ctx.body[i] >= k * ctx.atr[i] && ((s.variant === 'wide-bull' && bull) || (s.variant === 'wide-bear' && !bull))
      }
    }
    case 'ha': {
      const len = num(s.len, s.variant.startsWith('flip') ? 2 : 3)
      const runs: number[] = new Array(ctx.n).fill(0)
      let run = 0
      for (let i = 0; i < ctx.n; i++) {
        const c = ctx.haColor[i]
        if (c === 0) run = 0
        else run = Math.sign(run) === c ? run + c : c
        runs[i] = run
      }
      const strong: number[] = ctx.ha.close.map((v, i) => {
        const hBody = Math.abs(v - ctx.ha.open[i])
        const hRange = Math.max(ctx.ha.high[i] - ctx.ha.low[i], 1e-12)
        return hBody >= hRange * 0.7 ? 1 : 0
      })
      return (i: number) => {
        if (i < len + 1) return false
        const col = ctx.haColor[i]
        const prev = runs[i - 1]
        switch (s.variant) {
          case 'flip-up':
            return col > 0 && prev <= -(len - 1)
          case 'flip-down':
            return col < 0 && prev >= len - 1
          case 'streak-up':
            return col > 0 && runs[i] >= len
          case 'streak-down':
            return col < 0 && runs[i] <= -len
          case 'strong-bull':
            return col > 0 && strong[i] === 1
          case 'strong-bear':
            return col < 0 && strong[i] === 1
        }
      }
    }
    case 'line': {
      const lb = num(s.lookback, s.variant.startsWith('breakout') ? 20 : 3)
      if (s.variant === 'breakout-up' || s.variant === 'breakout-down') {
        return (i: number) => {
          if (i < lb) return false
          let hh = -Infinity
          let ll = Infinity
          for (let j = i - lb; j < i; j++) {
            if (ctx.high[j] > hh) hh = ctx.high[j]
            if (ctx.low[j] < ll) ll = ctx.low[j]
          }
          return s.variant === 'breakout-up' ? ctx.close[i] > hh : ctx.close[i] < ll
        }
      }
      return (i: number) => {
        if (i < lb) return false
        for (let j = i - lb + 1; j <= i; j++) {
          const upBar = ctx.high[j] > ctx.high[j - 1] && ctx.low[j] > ctx.low[j - 1]
          const dnBar = ctx.high[j] < ctx.high[j - 1] && ctx.low[j] < ctx.low[j - 1]
          if (s.variant === 'hh-hl' ? !upBar : !dnBar) return false
        }
        return true
      }
    }
    case 'indicator': {
      const series = indicatorSeries(s, ctx)
      return (i: number) => {
        const v = series[i]
        if (!Number.isFinite(v)) return false
        return s.op === '>' ? v > s.threshold : v < s.threshold
      }
    }
  }
}

/** Is this signal ACTIVE at bar `i` (default: the last closed bar)? */
export function signalActive(s: SignalDef, ctx: EvalCtx, i = ctx.n - 1): boolean {
  return prepareSignal(s, ctx)(i)
}

// ---------- evaluation ----------

export interface CustomEval extends StrategyEval {
  active: { label: string; dir: Side; weight: number }[]
}

/** Vote the spec's signals at bar `i` (default: last closed candle). */
export function evaluateCustomAt(spec: CustomSpec, ctx: EvalCtx, i = ctx.n - 1): { direction: 'call' | 'put' | 'none'; score: number; votes: number; active: CustomEval['active'] } {
  let bullW = 0
  let bearW = 0
  const active: CustomEval['active'] = []
  for (const s of spec.signals) {
    if (!signalActive(s, ctx, i)) continue
    const dir: Side = s.dir === 'put' ? 'put' : 'call'
    const w = Math.max(1, Math.min(50, Number(s.weight) || 0))
    if (dir === 'call') bullW += w
    else bearW += w
    active.push({ label: labelOf(s), dir, weight: w })
  }
  const total = bullW + bearW
  if (total <= 0) return { direction: 'none', score: 0, votes: 0, active }
  const score = Math.round((100 * (bullW - bearW)) / total)
  const dir: 'call' | 'put' = bullW >= bearW ? 'call' : 'put'
  const votes = active.filter((a) => a.dir === dir).length
  const minScore = Math.max(5, Math.min(95, spec.minScore))
  const minVotes = Math.max(1, Math.round(spec.minVotes || 1))
  if (Math.abs(score) < minScore || votes < minVotes) return { direction: 'none', score, votes, active }
  return { direction: dir, score, votes, active }
}

/** Vote the spec's signals on the last closed candle. Pure: candles in, eval out.
 * The spec's basis decides what the signals read (raw OHLC or the HA transform);
 * the caller keeps feeding RAW candles either way. */
export function evaluateCustom(spec: CustomSpec, candles: Candle[]): CustomEval {
  if (candles.length < 25) return { direction: 'none', score: 0, notes: 'warming up (need >=25 bars)', active: [] }
  const ctx = buildCtx(basisCandles(spec, candles))
  const out = evaluateCustomAt(spec, ctx)
  const names = out.active.filter((a) => a.dir === out.direction).map((a) => `${a.label} (${a.weight})`)
  if (out.direction === 'none') {
    return {
      direction: 'none',
      score: out.score,
      notes: `confluence ${out.votes}/${Math.max(1, Math.round(spec.minVotes || 1))}, score ${out.score} vs min ${spec.minScore}`,
      active: out.active,
    }
  }
  return {
    direction: out.direction,
    score: out.score,
    notes: `${out.votes} signal${out.votes > 1 ? 's' : ''} confluence: ${names.join(' + ')}`,
    active: out.active,
  }
}

// ---------- spec normalization ----------

const KNOWN_INDS = new Set([
  'rsi', 'bbpos', 'zscore', 'donchianpos', 'macdz', 'slope', 'streak', 'wickbias', 'emasign', 'hadist', 'bodypos',
])
const KNOWN_HA = new Set(['flip-up', 'flip-down', 'streak-up', 'streak-down', 'strong-bull', 'strong-bear'])
const KNOWN_LINE = new Set(['breakout-up', 'breakout-down', 'hh-hl', 'lh-ll'])
const KNOWN_BAR = new Set(['wide-bull', 'wide-bear'])

const clampN = (v: unknown, lo: number, hi: number, d = lo): number => {
  const n = Number(v)
  if (!Number.isFinite(n)) return d
  return Math.min(hi, Math.max(lo, n))
}

/** Normalize + validate an arbitrary spec (from disk or the AI): unknown or
 * malformed signals are dropped, numbers clamped, dir defaults to the
 * variant's textbook direction. Returns null when nothing usable remains. */
export function normalizeSpec(raw: unknown, fallbackName = 'Learned Strategy'): CustomSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<CustomSpec>
  const signals: SignalDef[] = []
  const list: unknown[] = Array.isArray(r.signals) ? (r.signals as unknown[]) : []
  for (const s of list.slice(0, 16)) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const weight = clampN(o.weight, 1, 50, 10)
    const dir = o.dir === 'put' ? 'put' : o.dir === 'call' ? 'call' : undefined
    if (o.kind === 'candle' && typeof o.name === 'string' && o.name.length <= 40) {
      signals.push({ kind: 'candle', name: o.name, dir: dir ?? 'call', weight })
    } else if (o.kind === 'bar' && KNOWN_BAR.has(String(o.variant))) {
      const variant = String(o.variant) as BarSignal['variant']
      signals.push({ kind: 'bar', variant, atrK: clampN(o.atrK, 0.5, 3, 1.1), dir: dir ?? (variant === 'wide-bull' ? 'call' : 'put'), weight })
    } else if (o.kind === 'ha' && KNOWN_HA.has(String(o.variant))) {
      const variant = String(o.variant) as HASignal['variant']
      const dflt: Side = variant.endsWith('up') || variant === 'strong-bull' ? 'call' : 'put'
      signals.push({ kind: 'ha', variant, len: clampN(o.len, 2, 10, variant.startsWith('flip') ? 2 : 3), dir: dir ?? dflt, weight })
    } else if (o.kind === 'line' && KNOWN_LINE.has(String(o.variant))) {
      const variant = String(o.variant) as LineSignal['variant']
      const dflt: Side = variant.endsWith('up') || variant === 'hh-hl' ? 'call' : 'put'
      signals.push({ kind: 'line', variant, lookback: clampN(o.lookback, 2, 100, variant.startsWith('breakout') ? 20 : 3), dir: dir ?? dflt, weight })
    } else if (o.kind === 'indicator' && KNOWN_INDS.has(String(o.ind)) && (o.op === '>' || o.op === '<')) {
      const params: Record<string, number> = {}
      for (const [k, v] of Object.entries((o.params as Record<string, unknown>) ?? {})) {
        const n = Number(v)
        if (Number.isFinite(n)) params[k] = n
      }
      signals.push({
        kind: 'indicator',
        ind: String(o.ind) as IndicatorSignal['ind'],
        params,
        op: o.op,
        threshold: clampN(o.threshold, -1e6, 1e6, 0),
        dir: dir ?? 'call',
        weight,
      })
    }
  }
  if (!signals.length) return null
  return {
    name: String(r.name ?? fallbackName).slice(0, 60) || fallbackName,
    description: r.description ? String(r.description).slice(0, 400) : undefined,
    signals,
    minScore: clampN(r.minScore, 5, 95, 45),
    minVotes: Math.round(clampN(r.minVotes, 1, 6, 1)),
    horizon: Math.round(clampN(r.horizon, 1, 10, 1)),
    ...(r.basis === 'heikin' ? { basis: 'heikin' as const } : {}),
  }
}

/** "EURUSD 1m Trend Machine" -> eurusd-1m-trend-machine (id slug part). */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'lab'
  )
}
