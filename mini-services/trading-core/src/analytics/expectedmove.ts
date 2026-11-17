// IQAIR//OS - EXPECTED MOVE cone (analytics/expectedmove.ts)
// TradingView's "Expected Move" draws the range OPTIONS imply for an asset by each expiry. IQ Option assets expose no options chain / implied volatility,
// so this is the closest honest equivalent: the range REALIZED volatility implies. sd = root-mean-square of the last 100 close-to-close changes
// (zero drift), and the 1-sigma move over h bars is sd*sqrt(h) (random-walk scaling). Bands = close +/- k*sd*sqrt(h). It describes how far price
// has typically travelled, it is NOT a forecast and it knows nothing about news, jumps or fat tails (real moves exceed 2 sigma far more often than 4.6%).
import type { Candle } from '../types'
import { atr as atrInd } from './indicators'

export const EM_MIN_BARS = 40
export const EM_WINDOW = 100

/** zero-drift per-bar standard deviation of close-to-close changes ending at index `end` (inclusive), last EM_WINDOW changes */
export function emSigmaAt(close: number[], end: number): number {
  const from = Math.max(1, end - EM_WINDOW + 1)
  let s = 0, n = 0
  for (let i = from; i <= end; i++) { const d = close[i] - close[i - 1]; s += d * d; n++ }
  return n >= 10 ? Math.sqrt(s / n) : 0
}
export interface EmRead { ok: boolean; price: number; sd: number; atr: number }
export function readEm(close: number[], high: number[], low: number[]): EmRead {
  const n = close.length
  if (n < EM_MIN_BARS) return { ok: false, price: n ? close[n - 1] : 0, sd: 0, atr: 0 }
  const a = atrInd(high, low, close, 14)
  const sd = emSigmaAt(close, n - 1)
  const at = a[a.length - 1]
  return { ok: sd > 0 && at > 0, price: close[n - 1], sd, atr: at }
}
export const emUpper = (r: EmRead, bars: number, k: number): number => r.price + k * r.sd * Math.sqrt(Math.max(0, bars))
export const emLower = (r: EmRead, bars: number, k: number): number => r.price - k * r.sd * Math.sqrt(Math.max(0, bars))
/** how many sigma the last `bars` bars moved, measured against the sd known BEFORE that move started (no look-ahead). 0 if not computable. */
export function emZ(close: number[], bars: number): number {
  const n = close.length, b = Math.max(1, Math.round(bars))
  if (n < EM_MIN_BARS + b) return 0
  const sd = emSigmaAt(close, n - 1 - b)
  return sd > 0 ? (close[n - 1] - close[n - 1 - b]) / (sd * Math.sqrt(b)) : 0
}
export interface EmConePoint { time: number; step: number; upper: number[]; lower: number[] }
/** the cone drawn on the chart: points at steps 0..horizon bars after the last closed bar, one band per k in `ks` */
export function emCone(candles: Candle[], horizon = 20, ks: number[] = [1, 2]): { ok: boolean; price: number; sd: number; atr: number; spacing: number; ks: number[]; points: EmConePoint[] } {
  const close = candles.map((c) => c.close)
  const r = readEm(close, candles.map((c) => c.high), candles.map((c) => c.low))
  const n = candles.length
  const spacing = n >= 2 ? candles[n - 1].time - candles[n - 2].time : 60
  if (!r.ok) return { ok: false, price: r.price, sd: 0, atr: 0, spacing, ks, points: [] }
  const points: EmConePoint[] = []
  for (let h = 0; h <= horizon; h++) points.push({ time: candles[n - 1].time + h * spacing, step: h, upper: ks.map((k) => emUpper(r, h, k)), lower: ks.map((k) => emLower(r, h, k)) })
  return { ok: true, price: r.price, sd: r.sd, atr: r.atr, spacing, ks, points }
}
