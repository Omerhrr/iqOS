// IQAIR//OS - Malaysian SNR (MSNR) levels and Candle Range Theory (CRT) for MSL (`msnr.*`, `crt.*`) - the first two pillars of the Alchemist.
//
// MSNR draws support/resistance on a LINE chart (closing prices only), never on wicks:
//   A-level (resistance) = a closing-price PEAK: a close higher than the 3 closes before it and not lower than the 3 after it (an "A" shape).
//   V-level (support)    = a closing-price VALLEY (a "V" shape). The level price is that close.
//   FRESH = no later bar has CLOSED beyond the level (>= an A, <= a V) since it formed; a wick that poked it is a test, not a close, and the level stays fresh.
// A REJECTION is the Alchemist's trigger: the latest closed bar wicked into a fresh level (within 0.15 ATR14, or through it) and closed back on the original side.
// Gap levels and storyline sequencing (full MSNR) are not modelled; levels are read from the last 300 closed bars, confirmed (3 bars after the pivot).
//
// CRT: candle 1 sets a range, candle 2 sweeps ONE side of it (a wick beyond) and CLOSES BACK INSIDE. The reversal is the other way, the target is the far
// side of candle 1's range. `n` bars (default 1) can form the range. Latest closed bar = candle 2. Both sides swept in one bar = no clean CRT.
// Both are candle-derived and backtestable. HONEST: these describe a setup; whether it pays is for a backtest to say.
import type { Candle } from '../types'
import { atr } from './indicators'

export const MSNR_MIN_BARS = 40
const PIVOT_K = 3
const LOOKBACK = 300
const TOL_ATR = 0.15

export interface MsnrLevel { price: number; kind: 'A' | 'V'; index: number; fresh: boolean }
export interface MsnrRead {
  ok: boolean
  levels: MsnrLevel[] // fresh levels only, nearest first
  resistance: number // nearest fresh A above the close, 0 when none
  support: number
  resDist: number // ATR units, NaN when none
  supDist: number
  rejected: number // +1 bullish rejection of a fresh V, -1 bearish rejection of a fresh A, 0 none
  rejLevel: number
  rejAge: number // bars since the rejected level formed
  rejTests: number // earlier wick tests of that level (0 = untouched, truly virgin)
  atr: number
}

export function readMsnr(candles: Candle[]): MsnrRead {
  const empty: MsnrRead = { ok: false, levels: [], resistance: 0, support: 0, resDist: NaN, supDist: NaN, rejected: 0, rejLevel: 0, rejAge: 0, rejTests: 0, atr: 0 }
  if (candles.length < MSNR_MIN_BARS) return empty
  const c = candles.slice(-LOOKBACK)
  const n = c.length, last = n - 1
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 14)
  const av = a[last]
  if (!Number.isFinite(av) || av <= 0) return empty
  const lv: MsnrLevel[] = []
  for (let j = PIVOT_K; j <= last - PIVOT_K - 1; j++) {
    let isA = true, isV = true
    for (let k = 1; k <= PIVOT_K; k++) {
      if (!(c[j].close > c[j - k].close)) isA = false
      if (!(c[j].close >= c[j + k].close)) isA = false
      if (!(c[j].close < c[j - k].close)) isV = false
      if (!(c[j].close <= c[j + k].close)) isV = false
    }
    if (!isA && !isV) continue
    const kind: 'A' | 'V' = isA ? 'A' : 'V'
    // fresh as of the bar BEFORE the latest: no close beyond the level between formation+K and last-1
    let fresh = true
    for (let t = j + PIVOT_K + 1; t < last; t++) { if (kind === 'A' ? c[t].close >= c[j].close : c[t].close <= c[j].close) { fresh = false; break } }
    lv.push({ price: c[j].close, kind, index: j, fresh })
  }
  const cl = c[last].close
  let rej = 0, rejLevel = 0, rejAge = 0, rejTests = 0
  for (const L of lv) {
    if (!L.fresh) continue
    if (L.kind === 'A' && c[last].high >= L.price - TOL_ATR * av && c[last].close < L.price && c[last].open < L.price) { rej = -1; rejLevel = L.price; rejAge = last - L.index }
    if (L.kind === 'V' && c[last].low <= L.price + TOL_ATR * av && c[last].close > L.price && c[last].open > L.price) { rej = 1; rejLevel = L.price; rejAge = last - L.index }
    if (rej !== 0 && L.price === rejLevel) {
      let t = 0
      for (let k = L.index + PIVOT_K + 1; k < last; k++) { if (L.kind === 'A' ? c[k].high >= L.price - TOL_ATR * av : c[k].low <= L.price + TOL_ATR * av) t++ }
      rejTests = t
      break
    }
  }
  const fresh = lv.filter((x) => x.fresh).sort((p, q) => Math.abs(p.price - cl) - Math.abs(q.price - cl))
  const above = fresh.filter((x) => x.kind === 'A' && x.price >= cl)
  const below = fresh.filter((x) => x.kind === 'V' && x.price <= cl)
  return {
    ok: true, levels: fresh, resistance: above[0]?.price ?? 0, support: below[0]?.price ?? 0, resDist: above[0] ? (above[0].price - cl) / av : NaN, supDist: below[0] ? (cl - below[0].price) / av : NaN,
    rejected: rej, rejLevel, rejAge, rejTests, atr: av,
  }
}

export interface CrtRead {
  ok: boolean
  dir: number // +1 bullish (low swept, closed back inside), -1 bearish, 0 none
  rangeHigh: number
  rangeLow: number
  mid: number
  target: number // far side of candle 1 range in the reversal direction
  depth: number // sweep depth in ATR
  strong: boolean // candle 2 closed beyond the range midpoint toward the target
}
export function readCrt(candles: Candle[], n = 1): CrtRead {
  const empty: CrtRead = { ok: false, dir: 0, rangeHigh: 0, rangeLow: 0, mid: 0, target: 0, depth: 0, strong: false }
  const k = Math.max(1, Math.min(10, Math.round(n)))
  if (candles.length < Math.max(20, k + 15)) return empty
  const c = candles.slice(-80)
  const last = c.length - 1
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 14)[last]
  if (!Number.isFinite(a) || a <= 0) return empty
  let hi = -Infinity, lo = Infinity
  for (let i = last - k; i < last; i++) { hi = Math.max(hi, c[i].high); lo = Math.min(lo, c[i].low) }
  const m = c[last]
  const sweptHigh = m.high > hi, sweptLow = m.low < lo
  const mid = (hi + lo) / 2
  const base = { ok: true, rangeHigh: hi, rangeLow: lo, mid }
  if (sweptLow && !sweptHigh && m.close > lo && m.close <= hi) return { ...base, dir: 1, target: hi, depth: (lo - m.low) / a, strong: m.close > mid }
  if (sweptHigh && !sweptLow && m.close < hi && m.close >= lo) return { ...base, dir: -1, target: lo, depth: (m.high - hi) / a, strong: m.close < mid }
  return { ...base, dir: 0, target: 0, depth: 0, strong: false }
}
