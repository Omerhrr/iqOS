// IQAIR//OS - pattern DISCOVERY with a held-out test (MSL `learn.*`).
//
// The script does not ship with patterns: it mines them from this pair's own history. Candidate patterns are candle-shape
// sequences (1, 2 or 3 closed bars, each described by direction, body size vs ATR14, and where it closed in its range),
// optionally conditioned on the mkt regime. For each candidate the next-bar hit-rate is measured on an OLDER train slice
// (first 70% of the window); only candidates that are statistically strong on train (z >= 3, a Bonferroni-style bar for
// ~1000 candidates) are then re-measured on the NEWER, untouched validation slice (last 30%) and must agree in direction
// with at least a one-sided p < 0.05 there. Survivors are the "discovered" patterns; the latest bar is matched against them.
// Walk-forward: only bars whose next candle has closed are used, the latest bar's own outcome never is.
// HONEST: with a few thousand bars most pairs yield NO survivors - that is the correct answer, not a bug. Under pure noise
// the expected false survivors are well under 1 per run; real survivors are still past frequencies, not forecasts.
import type { Candle } from '../types'
import { atr } from './indicators'
import { regimeSeries } from './marketmind'

export const DISCOVER_MIN_BARS = 400
const WINDOW = 3000
const TRAIN_FRAC = 0.7
const MIN_TRAIN_N = 25
const MIN_VAL_N = 10
const Z_TRAIN = 3.0
const Z_VAL = 1.645

export interface Found { key: string; side: 'call' | 'put'; trainN: number; trainP: number; valN: number; valP: number; n: number; p: number; low: number }
export interface LearnRead {
  ok: boolean
  found: number // validated patterns in total
  tested: number // candidates with enough train samples (the multiple-testing count)
  match: boolean
  side: 'call' | 'put' | 'none'
  pattern: string
  p: number
  low: number
  n: number
  valP: number
  valN: number
  conflict: boolean // matching patterns disagree on direction
}
const EMPTY: LearnRead = { ok: false, found: 0, tested: 0, match: false, side: 'none', pattern: '', p: 0.5, low: 0, n: 0, valP: 0.5, valN: 0, conflict: false }

function wilsonLow(w: number, n: number): number {
  if (n <= 0) return 0
  const z = 1.96, p = w / n, d = 1 + (z * z) / n
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d)
}

function symbols(c: Candle[]): { full: string[]; red: string[] } {
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 14)
  const full: string[] = [], red: string[] = []
  for (let i = 0; i < c.length; i++) {
    const rng = c[i].high - c[i].low, body = Math.abs(c[i].close - c[i].open)
    if (!Number.isFinite(a[i]) || a[i] <= 0 || rng <= 0) { full.push(''); red.push(''); continue }
    const d = body < 0.1 * rng ? 'x' : c[i].close > c[i].open ? 'u' : 'd'
    const sz = body / a[i]
    const size3 = sz < 0.3 ? 's' : sz < 0.8 ? 'm' : 'b'
    const pos = (c[i].close - c[i].low) / rng
    const pos3 = pos < 0.34 ? 'l' : pos > 0.66 ? 'h' : 'm'
    full.push(d + size3 + pos3)
    red.push(d + (sz < 0.5 ? 's' : 'b') + (pos < 0.5 ? 'l' : 'h'))
  }
  return { full, red }
}

function keysAt(i: number, full: string[], red: string[], regime: string): string[] {
  if (!full[i]) return []
  const out = [`1:${full[i]}`]
  if (i >= 1 && red[i - 1]) out.push(`2:${red[i - 1]}.${red[i]}`)
  if (i >= 2 && red[i - 1] && red[i - 2]) out.push(`3:${red[i - 2]}.${red[i - 1]}.${red[i]}`)
  const base = out.slice()
  for (const k of base) out.push(`${regime}|${k}`)
  return out
}

const zOf = (w: number, n: number): number => (n > 0 ? (w - n / 2) / (Math.sqrt(n) / 2) : 0)
const describe = (k: string): string => k.replace(/^(\d):/, '$1-bar ').replace('|', ' in ')

export function readLearn(candles: Candle[]): LearnRead {
  if (candles.length < DISCOVER_MIN_BARS) return { ...EMPTY }
  candles = candles.slice(-WINDOW)
  const n = candles.length, last = n - 1
  const { full, red } = symbols(candles)
  const regimeAt = regimeSeries(candles)
  const lo = 150
  const usable = last - lo // bars lo..last-1 have a closed next candle
  if (usable < 200) return { ...EMPTY }
  const split = lo + Math.floor(usable * TRAIN_FRAC)
  type Acc = { tn: number; tu: number; vn: number; vu: number }
  const m = new Map<string, Acc>()
  for (let i = lo; i < last; i++) {
    const mv = candles[i + 1].close - candles[i].close
    if (mv === 0) continue
    const up = mv > 0 ? 1 : 0
    for (const k of keysAt(i, full, red, regimeAt[i])) {
      if (k.startsWith('|')) continue
      let a = m.get(k)
      if (!a) m.set(k, (a = { tn: 0, tu: 0, vn: 0, vu: 0 }))
      if (i < split) { a.tn++; a.tu += up } else { a.vn++; a.vu += up }
    }
  }
  let tested = 0
  const found = new Map<string, Found>()
  for (const [k, a] of m) {
    if (a.tn < MIN_TRAIN_N) continue
    tested++
    const dir = a.tu > a.tn / 2 ? 1 : -1
    const wTrain = dir > 0 ? a.tu : a.tn - a.tu
    if (zOf(wTrain, a.tn) < Z_TRAIN) continue
    if (a.vn < MIN_VAL_N) continue
    const wVal = dir > 0 ? a.vu : a.vn - a.vu
    if (zOf(wVal, a.vn) < Z_VAL) continue
    const w = wTrain + wVal, nn = a.tn + a.vn
    found.set(k, { key: k, side: dir > 0 ? 'call' : 'put', trainN: a.tn, trainP: wTrain / a.tn, valN: a.vn, valP: wVal / a.vn, n: nn, p: (w + 1) / (nn + 2), low: wilsonLow(w, nn) })
  }
  const res: LearnRead = { ...EMPTY, ok: true, found: found.size, tested }
  const hits = keysAt(last, full, red, regimeAt[last]).map((k) => found.get(k)).filter((x): x is Found => !!x)
  if (!hits.length) return res
  hits.sort((x, y) => y.low - x.low)
  const b = hits[0]
  res.match = true
  res.side = b.side
  res.pattern = describe(b.key)
  res.p = b.p
  res.low = b.low
  res.n = b.n
  res.valP = b.valP
  res.valN = b.valN
  res.conflict = hits.some((h) => h.side !== b.side)
  return res
}
