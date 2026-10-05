// IQAIR//OS - Custom (AI-learned) strategy DSL
// The Strategy Lab mines a pair's history for edge-bearing events and composes
// them into a CustomSpec: a portable, inspectable strategy definition the
// autopilot can trade (strategyId "custom:<id>"). The vocabulary spans the
// user's ask: candlestick patterns, bar formations, Heiken Ashi patterns,
// line/structural patterns, and parametric INDICATOR rules spanning the
// FULL analytics/indicators.ts suite: the lab's own invented indicators
// (rsi/bbpos/zscore/donchianpos/macdz/slope/streak/wickbias/emasign/hadist/
// bodypos), swing/trend primitives (psar/fractal), and eight generic
// families selected via params.type - madist (every MA type), osc0100 /
// oscpm100 / oscz (every oscillator), trenddist (supertrend/chandelier/
// ichimoku), bandpos (keltner/envelope), volflow (every volume indicator)
// and levels (pivot points/fibonacci). correlation/beta are NOT exposed -
// they need a second instrument's series, which the single-asset evaluator
// contract doesn't carry; zigzag is excluded because it repaints (the last
// swing can move as new bars arrive, unusable for a live, non-repainting
// signal).
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
import { trendPullbackSeries, rangeZoneSeries } from '../analytics/structure'

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
    | 'psar' // Parabolic SAR trend distance: (close - sar) / ATR - positive above SAR (uptrend), negative below (downtrend)
    | 'fractal' // Williams Fractal breakout: (close - lastConfirmedFractalHigh)/ATR when breaking above resistance, (close - lastConfirmedFractalLow)/ATR when breaking below support, 0 otherwise
    | 'trendpullback' // trending-market pullback: signed, nonzero only inside a confirmed HH/HL (bull) or LH/LL (bear) swing structure AND price pulled back near the last confirmed swing point - see analytics/structure.ts
    | 'rangezone' // ranging-market buy/sell zone: signed, nonzero only while price is drifting sideways in a channel AND near its floor (buy zone, positive) or ceiling (sell zone, negative) - see analytics/structure.ts
    // ---- generic families covering the rest of analytics/indicators.ts (selected via params.type) ----
    | 'madist' // (close - MA)/ATR. params.type: sma|ema|wma|dema|tema|trima|kama|hma|vwma|zlema|t3|mcginley|linreg|midpoint
    | 'osc0100' // native 0..100 oscillator. params.type: stochk|stochd|willr|ultosc|aroonup|aroondown|mfi
    | 'oscpm100' // native -100..100-ish oscillator, raw. params.type: cci|cmo|tsi|rvi|aroonosc|stochrsik|stochrsid
    | 'oscz' // momentum/volatility family, each internally scaled sensibly. params.type: roc|mom|ppo|apo|trix|dpo|kst|qstick|awesomeosc|fisher|massindex|natr|histvol|stddev|atrz|hilbert|ulcer
    | 'trenddist' // signed trend-line breakout distance/ATR, same shape as psar/fractal. params.type: supertrend|chandelier|ichimoku
    | 'bandpos' // position inside a band, 0..1. params.type: keltner|envelope
    | 'volflow' // volume-flow accumulators, rolling z-scored. params.type: obv|ad|cmf|forceindex|eom|nvi|pvi|klinger|chaikinosc|vwapdist
    | 'levels' // signed distance to nearest static level/ATR. params.type: pivot|fib
  params?: Record<string, number> // period/fast/slow/mult per indicator
  type?: string // sub-selector for the generic families above (madist/osc0100/oscpm100/oscz/trenddist/bandpos/volflow/levels)
  /** '>'/'<' - the original single-threshold comparisons. 'between' - fires
   * only while the value sits inside [threshold, threshold2] (e.g.
   * "rangezone > 0.05 AND rangezone < 0.07" - the exact multi-condition case
   * that wasn't expressible before: the DSL only ever had ONE threshold per
   * signal, so a band had no way to be written as a single rule and had to
   * be faked as two separate always-independently-voting signals instead,
   * which isn't the same thing as a single AND'd condition). 'outside' -
   * the complement: fires outside [threshold, threshold2] (e.g. "avoid the
   * dead zone between -0.05 and 0.05"). threshold2 is ignored for '>'/'<'. */
  op: '>' | '<' | 'between' | 'outside'
  threshold: number
  threshold2?: number
  dir: Side
  weight: number
}

/** Multi-timeframe EMA-trend agreement: resamples this series into synthetic
 * `factor`x bars (e.g. factor 5 on a 1m feed = synthetic 5m) and fires when
 * EMA(8) vs EMA(21) on that higher timeframe agrees with `dir` - the same
 * idea as the standalone mtf-alignment strategy, pulled into the signal
 * vocabulary so the lab can mine it for edge, combine it with other signal
 * families, and weight it by measured performance like everything else. */
export interface MTFSignal {
  kind: 'mtf'
  factor: 5 | 15
  dir: Side
  weight: number
}

export type SignalDef = CandleSignal | BarSignal | HASignal | LineSignal | IndicatorSignal | MTFSignal

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
   * default), 'heikin' (every signal reads the Heiken-Ashi transform of the
   * feed), 'kalman' (every signal reads a Kalman-smoothed trend series -
   * denoises intrabar chop, similar in spirit to Heiken-Ashi but a genuinely
   * different filter), 'typical' (HLC3 typical-price candles - a cheap,
   * well-known smoothing that folds the whole bar's range into one number
   * instead of just the close), or 'smoothed' (a 3-bar SMA of price - the
   * lightest-touch denoise of the set, reacts faster than Kalman/typical but
   * damps single-bar noise spikes). Outcomes/settlement are ALWAYS measured
   * on real prices, whichever basis the signals themselves read. */
  basis?: Basis
}

export type Basis = 'candles' | 'heikin' | 'kalman' | 'typical' | 'smoothed'

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

/** Simple scalar Kalman filter over the close price: a random-walk state
 * model with a fixed process/observation noise ratio, so it smooths from
 * bar 0 with no long warmup (unlike the OU-fit filter used elsewhere for
 * mean-reversion estimation - this one is purpose-built as a lightweight,
 * general-purpose "chart type" for the signal vocabulary, not a statistical
 * model of the price process). Higher `q` tracks price more closely (less
 * smoothing); lower `q` filters out more intrabar noise. */
export function kalmanSmooth(closes: number[], q = 0.05): number[] {
  const n = closes.length
  const out = new Array<number>(n)
  if (n === 0) return out
  let xh = closes[0]
  let P = 1
  const R = 1
  for (let i = 0; i < n; i++) {
    if (i > 0) P += q
    const K = P / (P + R)
    xh += K * (closes[i] - xh)
    P *= 1 - K
    out[i] = xh
  }
  return out
}

/** Kalman-smoothed basis as a Candle[] (1:1 with the input series). Real
 * high/low are kept (and widened if needed) so wick-based signals still see
 * genuine market range; only open/close track the smoothed trend, the same
 * shape of transform as the Heiken-Ashi basis above. */
export function kalmanCandles(candles: Candle[], q = 0.05): Candle[] {
  const smoothed = kalmanSmooth(candles.map((k) => k.close), q)
  const n = candles.length
  const out: Candle[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const k = candles[i]
    const close = smoothed[i]
    const open = i === 0 ? k.open : smoothed[i - 1]
    out[i] = {
      time: k.time,
      open,
      close,
      high: Math.max(k.high, open, close),
      low: Math.min(k.low, open, close),
      volume: k.volume,
    }
  }
  return out
}

/** Typical-price candles: close -> (H+L+C)/3, a well-known smoothing that
 * folds the whole bar's range into one number instead of just the close
 * print. High/low/open are widened/kept the same way kalmanCandles does, so
 * wick-reading signals still see genuine market range. */
export function typicalCandles(candles: Candle[]): Candle[] {
  const n = candles.length
  const typical = candles.map((k) => (k.high + k.low + k.close) / 3)
  const out: Candle[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const k = candles[i]
    const close = typical[i]
    const open = i === 0 ? k.open : typical[i - 1]
    out[i] = { time: k.time, open, close, high: Math.max(k.high, open, close), low: Math.min(k.low, open, close), volume: k.volume }
  }
  return out
}

/** Lightest-touch basis of the set: a plain 3-bar SMA of the close, nothing
 * more. Reacts faster to new moves than Kalman or typical-price (shorter
 * effective lookback), while still damping single-bar noise spikes - a
 * cheap baseline to check whether the heavier filters are earning their
 * keep on a given pair. */
export function smoothedCandles(candles: Candle[], period = 3): Candle[] {
  const n = candles.length
  const closes = candles.map((k) => k.close)
  const sma = ta.sma(closes, period)
  const out: Candle[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const k = candles[i]
    const close = Number.isFinite(sma[i]) ? sma[i] : k.close
    const prevClose = i === 0 ? k.open : Number.isFinite(sma[i - 1]) ? sma[i - 1] : closes[i - 1]
    out[i] = { time: k.time, open: prevClose, close, high: Math.max(k.high, prevClose, close), low: Math.min(k.low, prevClose, close), volume: k.volume }
  }
  return out
}

/** The candle series a spec's signals are evaluated on (raw or a transform). */
export function basisCandles(spec: Pick<CustomSpec, 'basis'>, candles: Candle[]): Candle[] {
  if (spec.basis === 'heikin') return heikinAshiCandles(candles)
  if (spec.basis === 'kalman') return kalmanCandles(candles)
  if (spec.basis === 'typical') return typicalCandles(candles)
  if (spec.basis === 'smoothed') return smoothedCandles(candles)
  return candles
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
  volume: number[]
  hits: Map<string, 'bullish' | 'bearish' | 'neutral'> // candle patterns on the LAST bar only
}

export function buildCtx(candles: Candle[]): EvalCtx {
  const n = candles.length
  const close = candles.map((k) => k.close)
  const high = candles.map((k) => k.high)
  const low = candles.map((k) => k.low)
  const open = candles.map((k) => k.open)
  const volume = candles.map((k) => k.volume ?? 0)
  const atr = ta.atr(high, low, close, 14)
  const ha = heikinAshi(candles)
  const haColor = ha.close.map((v, i) => (v > ha.open[i] ? 1 : v < ha.open[i] ? -1 : 0))
  const body = candles.map((k) => Math.abs(k.close - k.open))
  const range = candles.map((k) => Math.max(k.high - k.low, 1e-12))
  const hits = new Map<string, 'bullish' | 'bearish' | 'neutral'>()
  if (n >= 13) {
    for (const hit of detectPatterns(candles, 1)) hits.set(hit.name.toLowerCase(), hit.direction)
  }
  return { candles, n, close, high, low, open, atr, ha, haColor, body, range, volume, hits }
}

/** ATR-normalized rolling z-score of an arbitrary raw series - used to turn
 * unbounded accumulator indicators (OBV, A/D line, NVI/PVI, Klinger...) into
 * a comparable, threshold-able signal without changing their shape. */
function rollingZ(src: number[], period: number): number[] {
  // sma/stdDev don't tolerate leading NaN (a warmed-up indicator's own
  // warmup NaNs would otherwise taint the running sum forever) - smooth
  // only from the first finite value onward, like indicators.ts's
  // skipLeadingNaN convention.
  const smaArr = ta.skipLeadingNaN(src, (s) => ta.sma(s, period))
  const sd = ta.skipLeadingNaN(src, (s) => ta.stdDev(s, period))
  return src.map((v, i) => (Number.isFinite(sd[i]) && sd[i] > 1e-12 ? (v - smaArr[i]) / sd[i] : NaN))
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
    case 'psar': {
      const sar = ta.parabolicSar(ctx.high, ctx.low, num(p.afStep, 0.02), num(p.afMax, 0.2))
      return ctx.close.map((v, i) => (ctx.atr[i] > 1e-12 ? (v - sar[i]) / ctx.atr[i] : NaN))
    }
    case 'fractal': {
      // Non-repainting Williams Fractal: a high/low fractal at bar i needs
      // `left`/`right` flanking bars strictly lower/higher on both sides, so
      // it can only be confirmed once the right flank has closed (i + right).
      // The series carries the most recently CONFIRMED fractal level forward
      // and reports a signed breakout distance vs it (ATR-normalized) - a
      // real trade only fires once price actually clears a swing point that
      // was visible without lookahead.
      const left = Math.max(1, Math.round(num(p.left, 2)))
      const right = Math.max(1, Math.round(num(p.right, 2)))
      const n = ctx.n
      const out: number[] = new Array(n).fill(0)
      let lastHigh = NaN
      let lastLow = NaN
      for (let i = 0; i < n; i++) {
        // confirm any fractal whose right flank just closed at this bar
        const c = i - right
        if (c >= left && c < n - right) {
          let isHigh = true
          let isLow = true
          for (let j = c - left; j <= c + right; j++) {
            if (j === c) continue
            if (ctx.high[j] >= ctx.high[c]) isHigh = false
            if (ctx.low[j] <= ctx.low[c]) isLow = false
          }
          if (isHigh) lastHigh = ctx.high[c]
          if (isLow) lastLow = ctx.low[c]
        }
        const atrI = ctx.atr[i]
        if (!(atrI > 1e-12)) {
          out[i] = 0
        } else if (Number.isFinite(lastHigh) && ctx.close[i] > lastHigh) {
          out[i] = (ctx.close[i] - lastHigh) / atrI
        } else if (Number.isFinite(lastLow) && ctx.close[i] < lastLow) {
          out[i] = (ctx.close[i] - lastLow) / atrI
        } else {
          out[i] = 0
        }
      }
      return out
    }
    case 'trendpullback':
      return trendPullbackSeries(ctx.candles, {
        pivotFlank: num(p.pivotFlank, 3),
        pullbackAtr: num(p.pullbackAtr, 0.75),
        minLegAtr: num(p.minLegAtr, 2),
        // Monte Carlo analog confirmation (see analytics/structure.ts) - on
        // by default; set params.confirm: 0 to mine/trade the raw structure
        // signal unconfirmed. params carries numbers only, so confirm is 0/1.
        confirm: num(p.confirm, 1) !== 0,
        confirmHorizon: num(p.confirmHorizon, 5),
        confirmMinProb: num(p.confirmMinProb, 0.55),
        confirmMinSamples: num(p.confirmMinSamples, 20),
        confirmSims: num(p.confirmSims, 500),
        // Rolling, recency-weighted analog window (not lifetime-cumulative) -
        // see analytics/structure.ts's header for why. Shrink confirmMaxPool
        // and confirmDecayHalfLife together to make the gate react faster to
        // a pair whose behavior around this setup is actively shifting.
        confirmMaxPool: num(p.confirmMaxPool, 150),
        confirmDecayHalfLife: num(p.confirmDecayHalfLife, 75),
      })
    case 'rangezone':
      return rangeZoneSeries(ctx.candles, {
        window: num(p.window, 40),
        rangeThreshold: num(p.rangeThreshold, 0.35),
        zoneAtr: num(p.zoneAtr, 0.4),
        confirm: num(p.confirm, 1) !== 0,
        confirmHorizon: num(p.confirmHorizon, 5),
        confirmMinProb: num(p.confirmMinProb, 0.55),
        confirmMinSamples: num(p.confirmMinSamples, 20),
        confirmSims: num(p.confirmSims, 500),
        confirmMaxPool: num(p.confirmMaxPool, 150),
        confirmDecayHalfLife: num(p.confirmDecayHalfLife, 75),
      })
    case 'madist': {
      const period = Math.max(2, Math.round(num(p.period, 20)))
      const type = s.type ?? 'ema'
      let ma: number[]
      switch (type) {
        case 'sma':
          ma = ta.sma(ctx.close, period)
          break
        case 'wma':
          ma = ta.wma(ctx.close, period)
          break
        case 'dema':
          ma = ta.dema(ctx.close, period)
          break
        case 'tema':
          ma = ta.tema(ctx.close, period)
          break
        case 'trima':
          ma = ta.trima(ctx.close, period)
          break
        case 'kama':
          ma = ta.kama(ctx.close, period, num(p.fast, 2), num(p.slow, 30))
          break
        case 'hma':
          ma = ta.hma(ctx.close, period)
          break
        case 'vwma':
          ma = ta.vwma(ctx.close, ctx.volume, period)
          break
        case 'zlema':
          ma = ta.zlema(ctx.close, period)
          break
        case 't3':
          ma = ta.t3(ctx.close, period, num(p.vf, 0.7))
          break
        case 'mcginley':
          ma = ta.mcginley(ctx.close, period)
          break
        case 'linreg':
          ma = ta.linregLine(ctx.close, period)
          break
        case 'midpoint':
          ma = ta.midpoint(ctx.close, period)
          break
        default:
          ma = ta.ema(ctx.close, period)
      }
      return ctx.close.map((v, i) => (ctx.atr[i] > 1e-12 && Number.isFinite(ma[i]) ? (v - ma[i]) / ctx.atr[i] : NaN))
    }
    case 'osc0100': {
      const type = s.type ?? 'stochk'
      const period = Math.max(2, Math.round(num(p.period, 14)))
      switch (type) {
        case 'stochk':
          return ta.stochastic(ctx.high, ctx.low, ctx.close, period).k
        case 'stochd':
          return ta.stochastic(ctx.high, ctx.low, ctx.close, period).d
        case 'stochrsik':
          return ta.stochRsi(ctx.close, num(p.rsiPeriod, 14), period).k
        case 'stochrsid':
          return ta.stochRsi(ctx.close, num(p.rsiPeriod, 14), period).d
        case 'willr':
          return ta.williamsR(ctx.high, ctx.low, ctx.close, period).map((v) => v + 100)
        case 'ultosc':
          return ta.ultimateOsc(ctx.high, ctx.low, ctx.close)
        case 'aroonup':
          return ta.aroon(ctx.high, ctx.low, period).up
        case 'aroondown':
          return ta.aroon(ctx.high, ctx.low, period).down
        case 'mfi':
          return ta.mfi(ctx.high, ctx.low, ctx.close, ctx.volume, period)
        default:
          return ta.stochastic(ctx.high, ctx.low, ctx.close, period).k
      }
    }
    case 'oscpm100': {
      const type = s.type ?? 'cci'
      const period = Math.max(2, Math.round(num(p.period, 20)))
      switch (type) {
        case 'cci':
          return ta.cci(ctx.high, ctx.low, ctx.close, period)
        case 'cmo':
          return ta.cmo(ctx.close, period)
        case 'tsi':
          return ta.tsi(ctx.close, num(p.long, 25), num(p.short, 13)).tsi
        case 'rvi':
          return ta.rvi(ctx.close, ctx.high, ctx.low, period).rvi
        case 'aroonosc':
          return ta.aroon(ctx.high, ctx.low, period).osc
        default:
          return ta.cci(ctx.high, ctx.low, ctx.close, period)
      }
    }
    case 'oscz': {
      const type = s.type ?? 'roc'
      const period = Math.max(2, Math.round(num(p.period, 14)))
      const atrNorm = (arr: number[]) => arr.map((v, i) => (ctx.atr[i] > 1e-12 && Number.isFinite(v) ? v / ctx.atr[i] : NaN))
      switch (type) {
        case 'roc':
          return ta.roc(ctx.close, period)
        case 'mom':
          return atrNorm(ta.mom(ctx.close, period))
        case 'ppo':
          return ta.ppo(ctx.close, num(p.fast, 12), num(p.slow, 26)).ppo
        case 'apo':
          return atrNorm(ta.apo(ctx.close, num(p.fast, 12), num(p.slow, 26)))
        case 'trix':
          return ta.trix(ctx.close, period).trix
        case 'dpo':
          return atrNorm(ta.dpo(ctx.close, period))
        case 'kst':
          return ta.kst(ctx.close).kst.map((v) => v / 10)
        case 'qstick':
          return atrNorm(ta.qstick(ctx.open, ctx.close, period))
        case 'awesomeosc':
          return atrNorm(ta.awesomeOsc(ctx.high, ctx.low))
        case 'fisher':
          return ta.fisherTransform(ctx.high, ctx.low, period).fisher
        case 'massindex':
          return ta.massIndex(ctx.high, ctx.low)
        case 'natr':
          return ta.natr(ctx.high, ctx.low, ctx.close, period)
        case 'histvol':
          return ta.histVol(ctx.close, period)
        case 'stddev':
          return atrNorm(ta.stdDev(ctx.close, period))
        case 'atrz':
          return rollingZ(ctx.atr, Math.max(5, period))
        case 'hilbert': {
          const h = ta.hilbertSine(ctx.close, num(p.period2, 32))
          return h.sine.map((v, i) => v - h.lead[i])
        }
        case 'ulcer':
          return ta.ulcerIndex(ctx.close, period)
        default:
          return ta.roc(ctx.close, period)
      }
    }
    case 'trenddist': {
      const type = s.type ?? 'supertrend'
      if (type === 'supertrend') {
        const st = ta.supertrend(ctx.high, ctx.low, ctx.close, Math.round(num(p.period, 10)), num(p.mult, 3))
        return ctx.close.map((v, i) => (ctx.atr[i] > 1e-12 && Number.isFinite(st.line[i]) ? (st.dir[i] * (v - st.line[i])) / ctx.atr[i] : NaN))
      }
      if (type === 'chandelier') {
        const ce = ta.chandelierExit(ctx.high, ctx.low, ctx.close, Math.round(num(p.period, 22)), num(p.mult, 3))
        return ctx.close.map((v, i) => {
          const atrI = ctx.atr[i]
          if (!(atrI > 1e-12)) return NaN
          if (Number.isFinite(ce.long[i]) && v > ce.long[i]) return (v - ce.long[i]) / atrI
          if (Number.isFinite(ce.short[i]) && v < ce.short[i]) return (v - ce.short[i]) / atrI
          return 0
        })
      }
      // ichimoku: signed distance to the nearest cloud edge, 0 while price is inside the cloud
      const ich = ta.ichimoku(ctx.high, ctx.low, Math.round(num(p.conv, 9)), Math.round(num(p.base, 26)), Math.round(num(p.spanB, 52)))
      return ctx.close.map((v, i) => {
        const a = ich.senkouA[i]
        const b = ich.senkouB[i]
        if (!Number.isFinite(a) || !Number.isFinite(b) || !(ctx.atr[i] > 1e-12)) return NaN
        const top = Math.max(a, b)
        const bot = Math.min(a, b)
        if (v > top) return (v - top) / ctx.atr[i]
        if (v < bot) return (v - bot) / ctx.atr[i]
        return 0
      })
    }
    case 'bandpos': {
      const type = s.type ?? 'keltner'
      const period = Math.max(2, Math.round(num(p.period, 20)))
      const band = type === 'envelope' ? ta.envelope(ctx.close, period, num(p.pct, 2.5)) : ta.keltner(ctx.high, ctx.low, ctx.close, period, num(p.mult, 2))
      return ctx.close.map((v, i) => {
        const width = band.upper[i] - band.lower[i]
        return Number.isFinite(width) && width > 1e-12 ? (v - band.lower[i]) / width : NaN
      })
    }
    case 'volflow': {
      const type = s.type ?? 'obv'
      const period = Math.max(2, Math.round(num(p.period, 20)))
      switch (type) {
        case 'obv':
          return rollingZ(ta.obv(ctx.close, ctx.volume), period)
        case 'ad':
          return rollingZ(ta.adl(ctx.high, ctx.low, ctx.close, ctx.volume), period)
        case 'cmf':
          return ta.cmf(ctx.high, ctx.low, ctx.close, ctx.volume, period)
        case 'forceindex':
          return rollingZ(ta.forceIndex(ctx.close, ctx.volume, Math.round(num(p.period, 13))), period)
        case 'eom':
          return rollingZ(ta.eom(ctx.high, ctx.low, ctx.volume, period), period)
        case 'nvi':
          return rollingZ(ta.nvi(ctx.close, ctx.volume), period)
        case 'pvi':
          return rollingZ(ta.pvi(ctx.close, ctx.volume), period)
        case 'klinger':
          return rollingZ(ta.klinger(ctx.high, ctx.low, ctx.close, ctx.volume).vf, period)
        case 'chaikinosc':
          return rollingZ(ta.chaikinOsc(ctx.high, ctx.low, ctx.close, ctx.volume), period)
        case 'vwapdist': {
          const vw = ta.vwap(ctx.candles)
          return ctx.close.map((v, i) => (ctx.atr[i] > 1e-12 && Number.isFinite(vw[i]) ? (v - vw[i]) / ctx.atr[i] : NaN))
        }
        default:
          return rollingZ(ta.obv(ctx.close, ctx.volume), period)
      }
    }
    case 'levels': {
      // signed ATR-normalized distance from close to the nearest static
      // level, recomputed per-bar from ONLY bars up to and including i - no
      // lookahead (the pivot/fib window looks back from i, never forward).
      const type = s.type ?? 'pivot'
      const window = Math.max(5, Math.round(num(p.period, type === 'pivot' ? 20 : 60)))
      const out: number[] = new Array(ctx.n).fill(NaN)
      for (let i = window; i < ctx.n; i++) {
        const slice = ctx.candles.slice(0, i + 1)
        const atrI = ctx.atr[i]
        if (!(atrI > 1e-12)) continue
        let levels: number[]
        if (type === 'pivot') {
          const piv = ta.pivotPoints(slice, window)
          levels = [piv.pp, piv.r1, piv.r2, piv.r3, piv.s1, piv.s2, piv.s3]
        } else {
          levels = ta.fibLevels(slice, window).map((l) => l.price)
        }
        let nearest = levels[0]
        let bestDist = Infinity
        for (const lv of levels) {
          const d = Math.abs(ctx.close[i] - lv)
          if (d < bestDist) {
            bestDist = d
            nearest = lv
          }
        }
        out[i] = (ctx.close[i] - nearest) / atrI
      }
      return out
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
      // trendpullback/rangezone get real names instead of the generic
      // "ind op threshold" format below - otherwise they're nearly
      // impossible to spot in a signal list full of cryptic indicator rows
      // (this is the exact complaint that led to adding this special case).
      if (s.ind === 'trendpullback') return s.dir === 'call' ? 'Trend Pullback (Bull Continuation)' : 'Trend Pullback (Bear Continuation)'
      if (s.ind === 'rangezone') return s.dir === 'call' ? 'Range Buy Zone' : 'Range Sell Zone'
      const p = s.params ?? {}
      const pd = p.period ?? p.fast
      const tag = s.type ? `:${s.type}` : ''
      const name = `${s.ind}${tag}${Number.isFinite(pd) ? `(${pd})` : ''}`
      if (s.op === 'between' || s.op === 'outside') {
        const lo = Math.min(s.threshold, s.threshold2 ?? s.threshold)
        const hi = Math.max(s.threshold, s.threshold2 ?? s.threshold)
        return `${name} ${s.op} [${lo}, ${hi}]`
      }
      return `${name} ${s.op} ${s.threshold}`
    }
    case 'mtf':
      return `MTF ${s.factor}x Trend ${s.dir === 'call' ? 'Up' : 'Down'}`
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
    case 'mtf':
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
      // 'between'/'outside' need a real lo/hi pair regardless of which
      // threshold the user entered larger - don't make the band's validity
      // depend on entry order.
      const lo = Math.min(s.threshold, s.threshold2 ?? s.threshold)
      const hi = Math.max(s.threshold, s.threshold2 ?? s.threshold)
      return (i: number) => {
        const v = series[i]
        if (!Number.isFinite(v)) return false
        switch (s.op) {
          case '>':
            return v > s.threshold
          case '<':
            return v < s.threshold
          case 'between':
            return v >= lo && v <= hi
          case 'outside':
            return v < lo || v > hi
        }
      }
    }
    case 'mtf': {
      const factor = s.factor
      // Resample into non-overlapping `factor`-bar groups and EMA(8)/EMA(21)
      // each group's close - precomputed once per group rather than per bar
      // for speed. No lookahead: group g closes at original index
      // (g+1)*factor-1, so bar i can only ever read the trend of the LAST
      // group that had fully closed by i, same as the live mtf-alignment
      // strategy only resampling complete groups.
      const numGroups = Math.floor(ctx.n / factor)
      const groupClose: number[] = new Array(numGroups)
      for (let g = 0; g < numGroups; g++) groupClose[g] = ctx.close[(g + 1) * factor - 1]
      const fast = ta.ema(groupClose, 8)
      const slow = ta.ema(groupClose, 21)
      const up: boolean[] = new Array(numGroups)
      const dn: boolean[] = new Array(numGroups)
      for (let g = 0; g < numGroups; g++) {
        up[g] = Number.isFinite(fast[g]) && Number.isFinite(slow[g]) && fast[g] > slow[g]
        dn[g] = Number.isFinite(fast[g]) && Number.isFinite(slow[g]) && fast[g] < slow[g]
      }
      const align = s.dir === 'call'
      return (i: number) => {
        const g = Math.floor((i + 1) / factor) - 1
        // mirrors the standalone strategy's `series.length < 25` floor -
        // need enough resampled groups for EMA(21) to mean anything
        if (g < 25) return false
        return align ? up[g] : dn[g]
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
  'psar', 'fractal', 'madist', 'osc0100', 'oscpm100', 'oscz', 'trenddist', 'bandpos', 'volflow', 'levels',
  // THE BUG: trendpullback/rangezone were wired into the ind type union,
  // indicatorSeries(), lab.ts's CANDIDATE_SIGNALS and client.ts's templates,
  // but never added to THIS allow-list - normalizeSpec is what actually
  // persists a spec (manual builder save, learn() output, disk load), so
  // any signal using either one was being silently dropped right here on
  // every save, regardless of everything else working correctly.
  'trendpullback', 'rangezone',
])
// valid params.type values per generic family - inline specs outside this
// set silently fall back to indicatorSeries' own per-family default rather
// than being rejected (a wrong `type` string should degrade, not 400).
const KNOWN_IND_TYPES: Record<string, Set<string>> = {
  madist: new Set(['sma', 'ema', 'wma', 'dema', 'tema', 'trima', 'kama', 'hma', 'vwma', 'zlema', 't3', 'mcginley', 'linreg', 'midpoint']),
  osc0100: new Set(['stochk', 'stochd', 'stochrsik', 'stochrsid', 'willr', 'ultosc', 'aroonup', 'aroondown', 'mfi']),
  oscpm100: new Set(['cci', 'cmo', 'tsi', 'rvi', 'aroonosc']),
  oscz: new Set(['roc', 'mom', 'ppo', 'apo', 'trix', 'dpo', 'kst', 'qstick', 'awesomeosc', 'fisher', 'massindex', 'natr', 'histvol', 'stddev', 'atrz', 'hilbert', 'ulcer']),
  trenddist: new Set(['supertrend', 'chandelier', 'ichimoku']),
  bandpos: new Set(['keltner', 'envelope']),
  volflow: new Set(['obv', 'ad', 'cmf', 'forceindex', 'eom', 'nvi', 'pvi', 'klinger', 'chaikinosc', 'vwapdist']),
  levels: new Set(['pivot', 'fib']),
}
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
    } else if (o.kind === 'indicator' && KNOWN_INDS.has(String(o.ind)) && (o.op === '>' || o.op === '<' || o.op === 'between' || o.op === 'outside')) {
      const params: Record<string, number> = {}
      for (const [k, v] of Object.entries((o.params as Record<string, unknown>) ?? {})) {
        const n = Number(v)
        if (Number.isFinite(n)) params[k] = n
      }
      const ind = String(o.ind) as IndicatorSignal['ind']
      const typeSet = KNOWN_IND_TYPES[ind]
      const type = typeSet && typeSet.has(String(o.type)) ? String(o.type) : undefined
      const needsBand = o.op === 'between' || o.op === 'outside'
      signals.push({
        kind: 'indicator',
        ind,
        ...(type ? { type } : {}),
        params,
        op: o.op,
        threshold: clampN(o.threshold, -1e6, 1e6, 0),
        // a band with no real threshold2 degrades to a single point rather
        // than being dropped outright - prepareSignal's lo===hi collapses
        // 'between' to "equals" and 'outside' to "not equals", both well-
        // defined, so a malformed band still evaluates to something sane.
        ...(needsBand ? { threshold2: clampN(o.threshold2, -1e6, 1e6, clampN(o.threshold, -1e6, 1e6, 0)) } : {}),
        dir: dir ?? 'call',
        weight,
      })
    } else if (o.kind === 'mtf' && (Number(o.factor) === 5 || Number(o.factor) === 15)) {
      signals.push({ kind: 'mtf', factor: Number(o.factor) as 5 | 15, dir: dir ?? 'call', weight })
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
    // THE BUG this originally fixed: this only ever preserved basis:'heikin'
    // on round-trip - a saved spec learned on the kalman basis silently
    // reverted to raw candles (basis undefined) the next time it was loaded
    // from storage and re-normalized, quietly changing what every signal
    // actually reads without changing a single number in the spec itself.
    ...(r.basis === 'heikin' || r.basis === 'kalman' || r.basis === 'typical' || r.basis === 'smoothed' ? { basis: r.basis } : {}),
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
