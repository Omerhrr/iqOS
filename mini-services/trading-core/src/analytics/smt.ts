// IQAIR//OS - SMT divergence (Smart Money Technique) between two correlated instruments. Pure on closed candles.
//
// SMT: two instruments that normally move together test a prior extreme; one takes it out (a new high / low in the recent window) and
// the other FAILS to. Bearish SMT = one pair makes a higher high while its partner does not (a failed high on the laggard);
// bullish SMT = one makes a lower low while the other holds its low. The read is only meaningful for pairs that really are
// positively co-moving, so it is gated on the return correlation of the two series (use `inverse` for an inversely related pair such as
// EURUSD vs USDCHF: the partner's series is mirrored first).
//
// One mechanical reading: the last `recent` bars are compared with the `lookback - recent` bars before them, on timestamp-aligned
// candles. Not a unique definition and NOT a measured edge - it describes what the last candles did.
import type { Candle } from '../types'

export interface SmtResult {
  ok: boolean
  reason?: string
  bars: number
  /** return correlation of the aligned pair over (up to) the 100 bars BEFORE the recent window (after mirroring when inverse) */
  corr: number
  /** 'bullish' = lows diverged (one made a lower low, the other held), 'bearish' = highs diverged, 'none' */
  direction: 'bullish' | 'bearish' | 'none'
  /** which side took the extreme: 'a' | 'b' */
  leader: 'a' | 'b' | null
  /** the one that failed to confirm */
  laggard: 'a' | 'b' | null
  extreme: 'high' | 'low' | null
  note: string
}

export const SMT_MIN_CORR = 0.5
export const SMT_MIN_BARS = 40

export function alignByTime(a: Candle[], b: Candle[]): [Candle[], Candle[]] {
  const bm = new Map<number, Candle>()
  for (const c of b) bm.set(c.time, c)
  const ra: Candle[] = []
  const rb: Candle[] = []
  for (const c of a) {
    const o = bm.get(c.time)
    if (o) { ra.push(c); rb.push(o) }
  }
  return [ra, rb]
}

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length)
  if (n < 3) return 0
  let mx = 0, my = 0
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i] }
  mx /= n; my /= n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0
}

/** Mirror a series around a fixed pivot so highs become lows (for inversely related pairs). */
function mirror(c: Candle[]): Candle[] {
  const pivot = c.length ? c[c.length - 1].close : 0
  return c.map((k) => ({ ...k, open: 2 * pivot - k.open, high: 2 * pivot - k.low, low: 2 * pivot - k.high, close: 2 * pivot - k.close }))
}

export function smtDivergence(aRaw: Candle[], bRaw: Candle[], opts: { lookback?: number; recent?: number; inverse?: boolean } = {}): SmtResult {
  const lookback = Math.max(12, Math.min(120, opts.lookback ?? 24))
  const recent = Math.max(3, Math.min(lookback - 6, opts.recent ?? 8))
  const none = (reason: string, bars = 0, corr = 0): SmtResult => ({ ok: false, reason, bars, corr, direction: 'none', leader: null, laggard: null, extreme: null, note: reason })
  let [a, b] = alignByTime(aRaw, bRaw)
  if (a.length < SMT_MIN_BARS) return none(`only ${a.length} timestamp-aligned bars (need ${SMT_MIN_BARS}+)`, a.length)
  if (opts.inverse) b = mirror(b)
  const n = a.length
  const split = n - recent
  // the co-movement gate is measured on the history BEFORE the recent window: the divergence itself must not be what breaks the gate
  const w = Math.min(100, split - 1)
  const ra: number[] = []
  const rb: number[] = []
  for (let i = split - w; i < split; i++) { ra.push(a[i].close - a[i - 1].close); rb.push(b[i].close - b[i - 1].close) }
  const corr = pearson(ra, rb)
  if (corr < SMT_MIN_CORR) return none(`return correlation ${corr.toFixed(2)} is below ${SMT_MIN_CORR} - not a co-moving pair right now${opts.inverse ? '' : ' (inversely related? try inverse)'}`, n, corr)
  const from = Math.max(0, n - lookback)
  const maxH = (c: Candle[], s: number, e: number) => { let m = -Infinity; for (let i = s; i < e; i++) if (c[i].high > m) m = c[i].high; return m }
  const minL = (c: Candle[], s: number, e: number) => { let m = Infinity; for (let i = s; i < e; i++) if (c[i].low < m) m = c[i].low; return m }
  const aHigh = maxH(a, split, n) > maxH(a, from, split)
  const bHigh = maxH(b, split, n) > maxH(b, from, split)
  const aLow = minL(a, split, n) < minL(a, from, split)
  const bLow = minL(b, split, n) < minL(b, from, split)
  const highDiv = aHigh !== bHigh
  const lowDiv = aLow !== bLow
  const base = { ok: true, bars: n, corr }
  // both a high and a low divergence in the same window = a wide, two-sided range: no clean read
  if (highDiv && lowDiv) return { ...base, direction: 'none', leader: null, laggard: null, extreme: null, note: 'highs and lows both diverged in the window - no clean read' }
  if (highDiv) {
    const leader = aHigh ? 'a' : 'b'
    return { ...base, direction: 'bearish', leader, laggard: leader === 'a' ? 'b' : 'a', extreme: 'high', note: `bearish SMT: ${leader.toUpperCase()} made a new ${lookback}-bar-window high in the last ${recent} bars, its partner did not confirm` }
  }
  if (lowDiv) {
    const leader = aLow ? 'a' : 'b'
    return { ...base, direction: 'bullish', leader, laggard: leader === 'a' ? 'b' : 'a', extreme: 'low', note: `bullish SMT: ${leader.toUpperCase()} made a new ${lookback}-bar-window low in the last ${recent} bars, its partner held` }
  }
  return { ...base, direction: 'none', leader: null, laggard: null, extreme: null, note: 'both confirmed or both failed together - no divergence' }
}
