// IQAIR//OS - the Polarity Switch (MSL `polar.*`): turns a signal that is reliably WRONG in the current market into one that is right.
//
// Every fixed rule is fixed-polarity: a trend-follower wins in trending markets and loses in reverting ones, a fader the reverse. The Polarity Switch
// keeps four plain BASE signals (follow = the last candle's direction; ctl = who is in control when |score| >= 40; rev = the reversal-evidence side
// when score >= 40; trend = close vs EMA20) and, for each, measures walk-forward how it has actually done on THIS pair, in the SAME market regime
// (mkt: trend_up / trend_down / revert / chop), recent bars weighted more (half-life 300 bars). Then per base:
//   z >= +2 and n >= 30  -> KEEP  (the signal is reliably right here)            side = base side
//   z <= -2 and n >= 30  -> FLIP  (the signal is reliably WRONG here: transmute)  side = opposite of base side
//   otherwise            -> SKIP  (no proof either way)                           side = none
// z = (hits - n/2) / (sqrt(n)/2) on the unweighted counts. pick() chooses the base with the largest |z| (selection among four = a multiple-testing
// cost, so the thresholds are stricter than a single test). p() = the shrunk weighted rate of the chosen polarity. Walk-forward: only earlier bars
// whose next candle already closed are scored; the latest bar's own outcome is never used.
// HONEST: flipping a loser is only an edge if the loss is structural, not luck - the |z| >= 2 bar and n >= 30 are there for that, and on noise
// the Polarity Switch should mostly SKIP. A flip that held in the past can stop holding when the regime changes.
import type { Candle } from '../types'
import { atr, ema } from './indicators'
import { regimeSeries } from './marketmind'
import { scoreAt } from './control'
import { rowAt, rsiSeries } from './revmsl'

export const POLAR_MIN_BARS = 200
const WINDOW = 1500
const HALF_LIFE = 300
export const POLAR_BASES = ['follow', 'ctl', 'rev', 'trend'] as const
export type PolarBase = (typeof POLAR_BASES)[number]
export type PolarMode = 'keep' | 'flip' | 'skip'

export interface PolarBaseRead { base: PolarBase; baseSide: 'call' | 'put' | 'none'; mode: PolarMode; side: 'call' | 'put' | 'none'; p: number; n: number; z: number; hit: number }
export interface PolarRead {
  ok: boolean
  regime: string
  bases: PolarBaseRead[]
  best: PolarBaseRead | null
}

export function readPolarity(candles: Candle[]): PolarRead {
  const empty: PolarRead = { ok: false, regime: '', bases: [], best: null }
  if (candles.length < POLAR_MIN_BARS) return empty
  const c = candles.slice(-(WINDOW + 40))
  const n = c.length, last = n - 1
  const close = c.map((x) => x.close)
  const e = ema(close, 20)
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), close, 14)
  const r = rsiSeries(close, 14)
  const reg = regimeSeries(c)
  if (!reg[last]) return empty
  const volOk = false // control flow component off: keeps the base cheap and identical on OTC
  const pred = (b: PolarBase, i: number): number => {
    if (b === 'follow') return Math.sign(c[i].close - c[i].open)
    if (b === 'trend') return Number.isFinite(e[i]) ? Math.sign(c[i].close - e[i]) : 0
    if (b === 'ctl') { const s = scoreAt(c, i, 10, e, a, volOk); return s && Math.abs(s.score) >= 40 ? Math.sign(s.score) : 0 }
    const row = rowAt(c, i, e, a, r)
    if (!row || Math.max(row.call, row.put) < 40) return 0
    return row.call >= row.put ? 1 : -1
  }
  const bases: PolarBaseRead[] = []
  for (const b of POLAR_BASES) {
    let w = 0, tot = 0, hits = 0, cnt = 0
    for (let i = Math.max(12, last - WINDOW); i < last; i++) {
      if (reg[i] !== reg[last]) continue
      const mv = c[i + 1].close - c[i].close
      if (mv === 0) continue
      const p = pred(b, i)
      if (p === 0) continue
      const win = p * mv > 0 ? 1 : 0
      const wt = Math.pow(0.5, (last - i) / HALF_LIFE)
      w += wt * win
      tot += wt
      hits += win
      cnt++
    }
    const z = cnt > 0 ? (hits - cnt / 2) / (Math.sqrt(cnt) / 2) : 0
    const pNow = pred(b, last)
    const baseSide: 'call' | 'put' | 'none' = pNow > 0 ? 'call' : pNow < 0 ? 'put' : 'none'
    const pBase = (w + 1) / (tot + 2)
    let mode: PolarMode = 'skip'
    if (cnt >= 30 && z >= 2) mode = 'keep'
    else if (cnt >= 30 && z <= -2) mode = 'flip'
    let side: 'call' | 'put' | 'none' = 'none'
    if (mode !== 'skip' && baseSide !== 'none') side = mode === 'keep' ? baseSide : baseSide === 'call' ? 'put' : 'call'
    bases.push({ base: b, baseSide, mode, side, p: mode === 'flip' ? 1 - pBase : pBase, n: cnt, z, hit: cnt ? hits / cnt : 0.5 })
  }
  const live = bases.filter((x) => x.side !== 'none')
  const best = live.length ? live.reduce((m, x) => (Math.abs(x.z) > Math.abs(m.z) ? x : m)) : null
  return { ok: true, regime: reg[last], bases, best }
}
