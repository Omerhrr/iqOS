// Replay tester for strategies that read Binance volume / delta / footprint: runs the normal MSL backtester over recorded minutes.
//
// Two candle modes (the same two a live strategy can pick with its `dataSource` input):
//   volume  - IQ Option's own 1m candles (price, direction, settlement) with Binance volume merged by the minute. Needs the recorded IQ candle of every minute in the bar.
//   binance - Binance's own candles. Works on any recorded minute, but the entry/settlement price is Binance's, not IQ's.
// binance.* reads (closed-bar ones) are served from the recorded minutes; the live-only forming-bar reads fail loudly here.
//
// No look-ahead: a bar is only built from minutes that belong to it, and the reader answers for the bar's own time, so a strategy evaluated
// on bar k never sees a later minute (tests/binance-replay.test.ts replays a prefix and a longer run and checks they agree).
//
// HONESTY: a win rate over a few hundred trades is mostly luck. Every result carries the breakeven win rate for the payout, a 95% interval,
// the out-of-sample half, and a verdict that gets STRICTER the more variants were tried (the more you test, the more some will look good by chance).

import type { Candle } from '../types'
import { BINANCE_BIN, TF_SEC, aggAt, aggregateMinutes, type BinanceMinute, type MinuteSource } from './binancedata'
import { backtestMslScript, type MslBacktestResult } from './mslbacktest'
import { listScriptInputs, setBinanceReader, type MslInputValue } from './strategylang'

export interface IqMinute { open: number; high: number; low: number; close: number }

/** sorted closed minutes per symbol, held in arrays (a replay needs random access by time, not the live ring buffer) */
export class ArrayMinuteSource implements MinuteSource {
  private by = new Map<string, BinanceMinute[]>()
  set(symbol: string, minutes: BinanceMinute[]): void {
    const m = [...minutes].sort((a, b) => a.time - b.time)
    const out: BinanceMinute[] = []
    for (const x of m) { if (out.length && out[out.length - 1].time === x.time) { if (!out[out.length - 1].foot && x.foot) out[out.length - 1] = x } else out.push(x) }
    this.by.set(symbol, out)
  }
  range(symbol: string, fromSec: number, toSec: number): BinanceMinute[] {
    const arr = this.by.get(symbol)
    if (!arr || !arr.length) return []
    let lo = 0, hi = arr.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].time < fromSec) lo = mid + 1; else hi = mid }
    const out: BinanceMinute[] = []
    for (let i = lo; i < arr.length && arr[i].time < toSec; i++) out.push(arr[i])
    return out
  }
  lastClosed(symbol: string): number { const a = this.by.get(symbol); return a && a.length ? a[a.length - 1].time : 0 }
  firstHeld(symbol: string): number { const a = this.by.get(symbol); return a && a.length ? a[0].time : 0 }
}

export type ReplayMode = 'volume' | 'binance'

/** the candle series a replay evaluates: whole bars only, every minute of the bar present on the sides the mode needs */
export function buildReplayCandles(mode: ReplayMode, tfSec: number, src: MinuteSource, symbol: string, iq: ReadonlyMap<number, IqMinute>): Candle[] {
  const first = src.firstHeld(symbol), last = src.lastClosed(symbol)
  if (!first || !last) return []
  const step = BINANCE_BIN[symbol] ?? 1
  const n = Math.max(1, Math.round(tfSec / 60))
  const out: Candle[] = []
  for (let t = Math.ceil(first / tfSec) * tfSec; t + tfSec - 60 <= last; t += tfSec) {
    const mins = src.range(symbol, t, t + tfSec)
    if (mins.length < n) continue
    const a = aggregateMinutes(t, tfSec, mins, step)
    if (!a || !a.complete) continue
    if (mode === 'binance') { out.push({ time: t, open: a.open, high: a.high, low: a.low, close: a.close, volume: a.volume }); continue }
    let o = NaN, h = -Infinity, l = Infinity, c = NaN, ok = true
    for (let m = t; m < t + tfSec; m += 60) {
      const q = iq.get(m)
      if (!q) { ok = false; break }
      if (m === t) o = q.open
      if (q.high > h) h = q.high
      if (q.low < l) l = q.low
      c = q.close
    }
    if (ok) out.push({ time: t, open: o, high: h, low: l, close: c, volume: a.volume })
  }
  return out
}

// ---------- statistics ----------
/** Wilson 95% interval for a win rate */
export function wilson(wins: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 }
  const p = wins / n, d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) }
}
/** inverse normal CDF (Acklam), p in (0,1) */
export function normInv(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425, hi = 1 - lo
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1) }
  if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1) }
  const q = p - 0.5, r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

export interface ReplayStats {
  trades: number
  wins: number
  winRate: number | null
  breakeven: number
  /** per $1 staked */
  expectancy: number | null
  ci: { lo: number; hi: number } | null
  /** lower bound of the win rate after correcting for `tried` variants (Bonferroni, one-sided) */
  adjLo: number | null
  oos: { trades: number; winRate: number | null; expectancy: number | null } | null
  verdict: 'no-trades' | 'too-few' | 'negative' | 'inconclusive' | 'candidate'
  note: string
}

export function judge(r: MslBacktestResult, payout: number, tried: number): ReplayStats {
  const n = r.trades.length, wins = r.trades.filter((t) => t.win).length
  const breakeven = 1 / (1 + payout)
  const ev = (w: number, m: number) => (m ? (w / m) * payout - (1 - w / m) : null)
  const oos = r.outOfSample && r.outOfSample.trades > 0 ? { trades: r.outOfSample.trades, winRate: r.outOfSample.winRate, expectancy: r.outOfSample.winRate == null ? null : r.outOfSample.winRate * payout - (1 - r.outOfSample.winRate) } : null
  if (!n) return { trades: 0, wins: 0, winRate: null, breakeven, expectancy: null, ci: null, adjLo: null, oos, verdict: 'no-trades', note: 'the strategy never fired on this data' }
  const wr = wins / n
  const ci = wilson(wins, n)
  const zAdj = normInv(1 - 0.05 / Math.max(1, tried))   // one-sided, corrected for how many variants were tried
  const adj = wilson(wins, n, zAdj)
  const expectancy = ev(wins, n)
  let verdict: ReplayStats['verdict'], note: string
  if (n < 30) { verdict = 'too-few'; note = `only ${n} trades: nothing can be concluded` }
  else if (adj.lo > breakeven && n >= 100 && oos && oos.expectancy != null && oos.expectancy > 0) { verdict = 'candidate'; note = `the win rate beats breakeven even after allowing for ${tried} variants tried, and the last part of the data agrees - still verify on new days before risking money` }
  else if ((expectancy ?? 0) > 0) { verdict = 'inconclusive'; note = `positive on this data but inside what luck produces (95% interval ${(ci.lo * 100).toFixed(1)}-${(ci.hi * 100).toFixed(1)}%, breakeven ${(breakeven * 100).toFixed(1)}%, ${tried} variants tried)` }
  else { verdict = 'negative'; note = `below breakeven (${(breakeven * 100).toFixed(1)}%) on this data` }
  return { trades: n, wins, winRate: wr, breakeven, expectancy, ci, adjLo: adj.lo, oos, verdict, note }
}

export interface ReplayRun {
  script: string
  inputs?: Record<string, MslInputValue>
  mode: ReplayMode
  tf: string
  symbol: string
  src: MinuteSource
  iq: ReadonlyMap<number, IqMinute>
  expiryBars: number
  payout: number
  warmupBars?: number
  /** share of the candles kept as the out-of-sample tail (default 0.3) */
  oosFrac?: number
  tried?: number
}
export interface ReplayResult { ok: boolean; error?: string; candles: number; stats: ReplayStats | null; result?: MslBacktestResult }

export function runReplay(o: ReplayRun): ReplayResult {
  const tfSec = TF_SEC[o.tf]
  if (!tfSec) return { ok: false, error: `unknown timeframe ${o.tf}`, candles: 0, stats: null }
  const candles = buildReplayCandles(o.mode, tfSec, o.src, o.symbol, o.iq)
  const warm = o.warmupBars ?? 60
  if (candles.length < warm + o.expiryBars + 20) return { ok: false, error: `only ${candles.length} usable ${o.tf} bars (need at least ${warm + o.expiryBars + 20}); ${o.mode === 'volume' ? 'volume mode needs the recorded IQ candle of every minute, record longer or try binance mode' : 'record longer'}`, candles: candles.length, stats: null }
  const oosBars = Math.max(1, Math.round(candles.length * (o.oosFrac ?? 0.3)))
  // recorded bars never change during a replay, so each (bar, timeframe) is aggregated once (a script that reads 20 bars back per evaluation would otherwise re-aggregate them thousands of times)
  const memo = new Map<number, ReturnType<typeof aggAt>>()
  setBinanceReader({ asset: o.symbol, at: (t, sec) => { const k = t * 1000 + sec / 60; if (memo.has(k)) return memo.get(k); const a = aggAt(o.src, o.symbol, t, sec); memo.set(k, a); return a } })
  try {
    const result = backtestMslScript(candles, o.script, { expiryBars: o.expiryBars, warmupBars: warm, payout: o.payout, outOfSampleBars: oosBars, inputs: o.inputs })
    if (!result.ok) return { ok: false, error: result.error, candles: candles.length, stats: null, result }
    return { ok: true, candles: candles.length, stats: judge(result, o.payout, o.tried ?? 1), result }
  } finally { setBinanceReader(null) }
}

/** the candle mode a script asks for through its `dataSource` input ("iq" is not replayable: it has no volume) */
export function replayModeOf(script: string, inputs?: Record<string, MslInputValue>): ReplayMode | 'iq' {
  let v: unknown = inputs?.dataSource
  if (v === undefined) { const d = listScriptInputs(script); if (d.ok) v = d.inputs.find((i) => i.name === 'dataSource')?.def }
  const t = String(v ?? 'volume').toLowerCase()
  return t === 'binance' ? 'binance' : t === 'iq' ? 'iq' : 'volume'
}
