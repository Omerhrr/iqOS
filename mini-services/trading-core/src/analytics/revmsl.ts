// IQAIR//OS - reversal detection for MSL (`rev.*`). Two layers on closed candles, both candle-derived and backtestable:
//
//  1. THE OS REVERSAL ENGINE (analytics/reversal.ts readReversalTf - the Reversal Radar's own detector panel: RSI hook, Stochastic cross,
//     candle reversal patterns, Bollinger re-entry, RSI divergence, run exhaustion, stretch fade) read on the script's candles:
//     state() calm|forming|reversing|confirmed, dir() up|down|none, net() weighted net, has("RSI") a named detector voted, reasons() text.
//     The bare `reversal` / `reversal:<TF>` verdict sources read the LIVE radar and are blank in a backtest; this layer replays.
//  2. A SCORE + EMPIRICAL PROBABILITY: six visible pieces of exhaustion evidence per side 0..100 (stretch from EMA20 >= 1.5 ATR .25,
//     RSI14 extreme .20, 3+ same-colour bars .20, rejection wick >= 40% of range .15, sweep of the prior 10-bar extreme and close back
//     inside .15, shrinking bodies .05). side() = stronger side (none under 20). p() = among EARLIER bars with the same side and score
//     bucket (<30, 30-50, 50-70, 70+) whose next candle closed, the share that moved in the reversal direction, shrunk (w+1)/(n+2).
//     Walk-forward; the latest bar's own outcome is never used.
// HONEST: reversal evidence describes exhaustion; whether price turns is a frequency a backtest has to show per pair.
import type { Candle } from '../types'
import { atr, ema } from './indicators'
import { readReversalTf, REV_MIN_BARS, REV_BARS_PER_RUNG, type ReversalState } from './reversal'

export const REVMSL_MIN_BARS = Math.max(80, REV_MIN_BARS)
const WINDOW = 1500
export interface RevRead {
  ok: boolean
  side: 'call' | 'put' | 'none'
  score: number
  callScore: number
  putScore: number
  p: number
  n: number
  low: number
  streak: number
  stretch: number
  rsi: number
  wick: number
  sweep: boolean
  shrink: boolean
  confirmed: boolean
  state: ReversalState
  dir: 'up' | 'down' | 'none'
  net: number
  detectors: string[]
  reasons: string
}
const EMPTY: RevRead = { ok: false, side: 'none', score: 0, callScore: 0, putScore: 0, p: 0.5, n: 0, low: 0, streak: 0, stretch: 0, rsi: 50, wick: 0, sweep: false, shrink: false, confirmed: false, state: 'calm', dir: 'none', net: 0, detectors: [], reasons: '' }

function wilsonLow(w: number, n: number): number {
  if (n <= 0) return 0
  const z = 1.96, p = w / n, d = 1 + (z * z) / n
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d)
}
export function rsiSeries(close: number[], period = 14): number[] {
  const out = new Array(close.length).fill(NaN)
  let g = 0, l = 0
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1]
    const up = Math.max(0, d), dn = Math.max(0, -d)
    if (i <= period) { g += up; l += dn; if (i === period) { g /= period; l /= period; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l) } } else {
      g = (g * (period - 1) + up) / period
      l = (l * (period - 1) + dn) / period
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l)
    }
  }
  return out
}
const bucket = (s: number): number => (s < 30 ? 0 : s < 50 ? 1 : s < 70 ? 2 : 3)

interface Row { call: number; put: number; streak: number; stretch: number; rsi: number; wick: number; sweep: boolean; shrink: boolean }

export function rowAt(c: Candle[], i: number, e: number[], a: number[], r: number[]): Row | null {
  if (i < 12 || !Number.isFinite(e[i]) || !Number.isFinite(a[i]) || a[i] <= 0 || !Number.isFinite(r[i])) return null
  const stretch = (c[i].close - e[i]) / a[i]
  let streak = 0
  const dir = Math.sign(c[i].close - c[i].open)
  if (dir !== 0) { streak = dir; for (let k = i - 1; k >= Math.max(0, i - 12); k--) { if (Math.sign(c[k].close - c[k].open) === dir) streak += dir; else break } }
  const rg = c[i].high - c[i].low
  const lowW = rg > 0 ? (Math.min(c[i].open, c[i].close) - c[i].low) / rg : 0
  const upW = rg > 0 ? (c[i].high - Math.max(c[i].open, c[i].close)) / rg : 0
  let pLow = Infinity, pHigh = -Infinity
  for (let k = i - 10; k < i; k++) { pLow = Math.min(pLow, c[k].low); pHigh = Math.max(pHigh, c[k].high) }
  const sweepDn = c[i].low < pLow && c[i].close > pLow
  const sweepUp = c[i].high > pHigh && c[i].close < pHigh
  const b = (k: number) => Math.abs(c[k].close - c[k].open)
  const shrinkDn = c[i].close < c[i - 2].close && b(i) < b(i - 1) && b(i - 1) < b(i - 2) && c[i - 2].close < c[i - 3].close
  const shrinkUp = c[i].close > c[i - 2].close && b(i) < b(i - 1) && b(i - 1) < b(i - 2) && c[i - 2].close > c[i - 3].close
  const cs = 25 * (stretch <= -1.5 ? 1 : 0) + 20 * (r[i] <= 30 ? 1 : 0) + 20 * (streak <= -3 ? 1 : 0) + 15 * (lowW >= 0.4 ? 1 : 0) + 15 * (sweepDn ? 1 : 0) + 5 * (shrinkDn ? 1 : 0)
  const ps = 25 * (stretch >= 1.5 ? 1 : 0) + 20 * (r[i] >= 70 ? 1 : 0) + 20 * (streak >= 3 ? 1 : 0) + 15 * (upW >= 0.4 ? 1 : 0) + 15 * (sweepUp ? 1 : 0) + 5 * (shrinkUp ? 1 : 0)
  const callSide = cs >= ps
  return { call: cs, put: ps, streak, stretch, rsi: r[i], wick: callSide ? lowW : upW, sweep: callSide ? sweepDn : sweepUp, shrink: callSide ? shrinkDn : shrinkUp }
}

export function readReversal(candles: Candle[]): RevRead {
  if (candles.length < REVMSL_MIN_BARS) return { ...EMPTY }
  const c = candles.slice(-(WINDOW + 40))
  const close = c.map((x) => x.close)
  const e = ema(close, 20)
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), close, 14)
  const r = rsiSeries(close, 14)
  const last = c.length - 1
  const cur = rowAt(c, last, e, a, r)
  if (!cur) return { ...EMPTY }
  const side: 'call' | 'put' | 'none' = Math.max(cur.call, cur.put) < 20 ? 'none' : cur.call >= cur.put ? 'call' : 'put'
  const score = side === 'call' ? cur.call : side === 'put' ? cur.put : Math.max(cur.call, cur.put)
  let w = 0, n = 0
  if (side !== 'none') {
    const bk = bucket(score)
    for (let i = Math.max(12, last - WINDOW); i < last; i++) {
      const row = rowAt(c, i, e, a, r)
      if (!row) continue
      const sd = row.call >= row.put ? 'call' : 'put'
      const sc = sd === 'call' ? row.call : row.put
      if (Math.max(row.call, row.put) < 20 || sd !== side || bucket(sc) !== bk) continue
      const mv = c[i + 1].close - c[i].close
      if (mv === 0) continue
      n++
      if ((side === 'call' && mv > 0) || (side === 'put' && mv < 0)) w++
    }
  }
  const confirmed = side === 'call' ? c[last].close > c[last].open : side === 'put' ? c[last].close < c[last].open : false
  const os = readReversalTf('msl', 60, 'native', c.slice(-REV_BARS_PER_RUNG))
  return {
    ok: true, side, score, callScore: cur.call, putScore: cur.put, p: (w + 1) / (n + 2), n, low: wilsonLow(w, n), streak: cur.streak, stretch: cur.stretch, rsi: cur.rsi, wick: cur.wick, sweep: cur.sweep, shrink: cur.shrink, confirmed,
    state: os.ok ? os.state : 'calm', dir: os.ok ? os.direction : 'none', net: os.ok ? os.score : 0, detectors: os.reasons.map((x) => x.detector), reasons: os.reasons.map((x) => `${x.detector} ${x.dir}`).join('; '),
  }
}
