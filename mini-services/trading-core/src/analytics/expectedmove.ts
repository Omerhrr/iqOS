// IQAIR//OS - EXPECTED MOVE cone (analytics/expectedmove.ts)
// TradingView's "Expected Move" draws the range OPTIONS imply for an asset by each expiry. IQ Option assets expose no options chain / implied volatility,
// so this is the closest honest equivalent: the range REALIZED volatility implies. sd = root-mean-square of the last 100 close-to-close changes
// (zero drift by default), and the 1-sigma move over h bars is sd*h^hurst (0.5 = random walk, sqrt(h)). Window, estimator and hurst are all configurable. Bands = close +/- k*sd*sqrt(h). It describes how far price
// has typically travelled, it is NOT a forecast and it knows nothing about news, jumps or fat tails (real moves exceed 2 sigma far more often than 4.6%).
import type { Candle } from '../types'
import { atr as atrInd } from './indicators'

export const EM_MIN_BARS = 40
export const EM_WINDOW = 100
/** Every knob of the cone. window = bars of history (EWMA: the span); mode = how per-bar sd is estimated; hurst = how the move grows with time (0.5 = random walk, sd*sqrt(h);
 *  above 0.5 = trending, the cone widens faster; below 0.5 = mean-reverting, slower). Defaults reproduce the original behaviour. */
export type EmMode = 'rms' | 'std' | 'ewma' | 'parkinson'
export interface EmParams { window: number; mode: EmMode; hurst: number }
export const EM_DEFAULTS: EmParams = { window: EM_WINDOW, mode: 'rms', hurst: 0.5 }
export const EM_MODES: EmMode[] = ['rms', 'std', 'ewma', 'parkinson']
/** MSL passes the mode as a number: 0 rms, 1 std, 2 ewma, 3 parkinson */
export const emModeFromCode = (n: number): EmMode => EM_MODES[Math.max(0, Math.min(EM_MODES.length - 1, Math.round(n)))]
export function emParams(p?: Partial<EmParams>): EmParams {
  const w = Math.round(p?.window ?? EM_DEFAULTS.window), h = p?.hurst ?? EM_DEFAULTS.hurst
  return { window: Math.max(10, Math.min(1000, isFinite(w) ? w : EM_DEFAULTS.window)), mode: p?.mode && EM_MODES.includes(p.mode) ? p.mode : EM_DEFAULTS.mode, hurst: Math.max(0.1, Math.min(1, isFinite(h) ? h : EM_DEFAULTS.hurst)) }
}
export interface EmSeries { close: number[]; high: number[]; low: number[] }

/** per-bar standard deviation (price units) of the bar-to-bar move, estimated from data up to index `end` (inclusive) */
export function emSigmaAt(x: EmSeries, end: number, pr?: Partial<EmParams>): number {
  const { window, mode } = emParams(pr), c = x.close
  const from = Math.max(1, end - window + 1)
  if (end - from + 1 < 10) return 0
  if (mode === 'parkinson') {
    let s = 0, n = 0
    for (let i = from; i <= end; i++) { const r = x.high[i] - x.low[i]; s += r * r; n++ }
    return Math.sqrt(s / n / (4 * Math.LN2))
  }
  if (mode === 'ewma') {
    const lam = 1 - 2 / (window + 1)
    let v = 0, w = 0, f = 1
    for (let i = end; i >= from; i--) { const d = c[i] - c[i - 1]; v += f * d * d; w += f; f *= lam }
    return Math.sqrt(v / w)
  }
  let m = 0, n = 0
  if (mode === 'std') { for (let i = from; i <= end; i++) { m += c[i] - c[i - 1]; n++ } m /= n }
  let s = 0
  n = 0
  for (let i = from; i <= end; i++) { const d = c[i] - c[i - 1] - m; s += d * d; n++ }
  return Math.sqrt(s / n)
}
export interface EmRead { ok: boolean; price: number; sd: number; atr: number; p: EmParams }
export function readEm(x: EmSeries, pr?: Partial<EmParams>): EmRead {
  const n = x.close.length, p = emParams(pr)
  if (n < EM_MIN_BARS) return { ok: false, price: n ? x.close[n - 1] : 0, sd: 0, atr: 0, p }
  const a = atrInd(x.high, x.low, x.close, 14)
  const sd = emSigmaAt(x, n - 1, p), at = a[a.length - 1]
  return { ok: sd > 0 && at > 0, price: x.close[n - 1], sd, atr: at, p }
}
const grow = (r: EmRead, bars: number): number => Math.pow(Math.max(0, bars), r.p.hurst)
export const emUpper = (r: EmRead, bars: number, k: number): number => r.price + k * r.sd * grow(r, bars)
export const emLower = (r: EmRead, bars: number, k: number): number => r.price - k * r.sd * grow(r, bars)
/** how many sigma the last `bars` bars moved, measured against the sd known BEFORE that move started (no look-ahead). 0 if not computable. */
export function emZ(x: EmSeries, bars: number, pr?: Partial<EmParams>): number {
  const n = x.close.length, b = Math.max(1, Math.round(bars)), p = emParams(pr)
  if (n < EM_MIN_BARS + b) return 0
  const sd = emSigmaAt(x, n - 1 - b, p)
  return sd > 0 ? (x.close[n - 1] - x.close[n - 1 - b]) / (sd * Math.pow(b, p.hurst)) : 0
}
export interface EmConePoint { time: number; step: number; upper: number[]; lower: number[] }
/** the cone drawn on the chart: points at steps 0..horizon bars after the last closed bar, one band per k in `ks` */
export function emCone(candles: Candle[], horizon = 20, ks: number[] = [1, 2], pr?: Partial<EmParams>): { ok: boolean; price: number; sd: number; atr: number; spacing: number; ks: number[]; params: EmParams; points: EmConePoint[] } {
  const r = readEm({ close: candles.map((c) => c.close), high: candles.map((c) => c.high), low: candles.map((c) => c.low) }, pr)
  const n = candles.length
  const spacing = n >= 2 ? candles[n - 1].time - candles[n - 2].time : 60
  if (!r.ok) return { ok: false, price: r.price, sd: 0, atr: 0, spacing, ks, params: r.p, points: [] }
  const points: EmConePoint[] = []
  for (let h = 0; h <= horizon; h++) points.push({ time: candles[n - 1].time + h * spacing, step: h, upper: ks.map((k) => emUpper(r, h, k)), lower: ks.map((k) => emLower(r, h, k)) })
  return { ok: true, price: r.price, sd: r.sd, atr: r.atr, spacing, ks, params: r.p, points }
}
