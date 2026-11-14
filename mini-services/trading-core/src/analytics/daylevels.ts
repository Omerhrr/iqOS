// IQAIR//OS - day / week / session liquidity levels (the targets SMC traders watch): previous UTC day high & low (PDH/PDL), today's
// high & low so far, previous UTC week high & low (PWH/PWL), and the latest Asia / London / New York session ranges. Pure on
// closed candles with real epoch-second timestamps.
//
// Why this is not an `smc:<KIND>`: scanSmc sees only the last ~240 bars, which at 1m is four hours - it cannot see yesterday.
// This reads a deeper window (the caller passes 1-2k bars of a coarser tf, e.g. 5m).
//
// Sessions are FIXED UTC-hour buckets (Asia 00-07, London 07-12, New York 12-21), no DST adjustment - the same coarse approximation
// the rest of this kernel uses. A level is only reported when the data actually covers it (coverage is shown), never invented.
import type { Candle } from '../types'

export interface DayLevel {
  id: 'PDH' | 'PDL' | 'DAY_HIGH' | 'DAY_LOW' | 'PWH' | 'PWL' | 'ASIA_HIGH' | 'ASIA_LOW' | 'LONDON_HIGH' | 'LONDON_LOW' | 'NY_HIGH' | 'NY_LOW'
  label: string
  price: number
  side: 'above' | 'below'
  /** signed distance from the last close in ATR units (positive = level above price) */
  distanceAtr: number
  /** price has traded beyond this level since it was set (a high above, a low below) */
  swept: boolean
  /** the most recent bar that took it AND closed back inside: a stop-hunt read (bearish at highs, bullish at lows) */
  rejectedBar: number | null
  /** the date / session / week the level belongs to, for display */
  from: string
}

export interface DayLevelsResult {
  ok: boolean
  reason?: string
  price: number
  atr: number
  bars: number
  levels: DayLevel[]
  /** nearest unswept level above / below price (the likely liquidity draws) */
  nearestAbove: DayLevel | null
  nearestBelow: DayLevel | null
  note: string
}

const DAY = 86400
const dayStart = (t: number) => Math.floor(t / DAY) * DAY
/** UTC week starts Monday: epoch day 0 (1970-01-01) was a Thursday, so Monday = (day + 3) % 7 === 0 */
const weekStart = (t: number) => { const d = Math.floor(t / DAY); return (d - ((d + 3) % 7)) * DAY }
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)

function atrOf(c: Candle[], n = 14): number {
  if (c.length < 2) return 0
  const m = Math.min(n, c.length - 1)
  let s = 0
  for (let i = c.length - m; i < c.length; i++) s += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
  return s / m
}

export function dayLevels(candles: Candle[], opts: { minDayBars?: number } = {}): DayLevelsResult {
  const none = (reason: string): DayLevelsResult => ({ ok: false, reason, price: 0, atr: 0, bars: candles.length, levels: [], nearestAbove: null, nearestBelow: null, note: reason })
  if (candles.length < 30) return none(`only ${candles.length} bars`)
  const last = candles[candles.length - 1]
  const price = last.close
  const a = atrOf(candles)
  if (!(a > 0)) return none('no range (flat series)')
  const today = dayStart(last.time)
  const barSecs = candles.length > 1 ? Math.max(1, Math.round(candles[candles.length - 1].time - candles[candles.length - 2].time)) : 60
  // a previous day counts only with enough of it present (default 60% of its bars at this bar length)
  const minDayBars = opts.minDayBars ?? Math.floor((DAY / barSecs) * 0.6)

  const range = (from: number, to: number) => {
    let hi = -Infinity, lo = Infinity, n = 0, hiIdx = -1, loIdx = -1
    for (let i = 0; i < candles.length; i++) {
      const t = candles[i].time
      if (t < from || t >= to) continue
      n++
      if (candles[i].high > hi) { hi = candles[i].high; hiIdx = i }
      if (candles[i].low < lo) { lo = candles[i].low; loIdx = i }
    }
    return { hi, lo, n, hiIdx, loIdx }
  }
  const levels: DayLevel[] = []
  const add = (id: DayLevel['id'], label: string, p: number, setIdx: number, from: string) => {
    if (!isFinite(p)) return
    const side: 'above' | 'below' = p >= price ? 'above' : 'below'
    const isHigh = /HIGH|PDH|PWH/.test(id)
    let swept = false
    let rejectedBar: number | null = null
    for (let i = Math.max(0, setIdx + 1); i < candles.length; i++) {
      const k = candles[i]
      if (isHigh ? k.high > p : k.low < p) {
        swept = true
        if (isHigh ? k.close < p : k.close > p) rejectedBar = i
      }
    }
    // a level that is the extreme of "now" cannot have been swept after itself
    levels.push({ id, label, price: p, side, distanceAtr: (p - price) / a, swept, rejectedBar, from })
  }

  const pd = range(today - DAY, today)
  if (pd.n >= minDayBars) {
    add('PDH', 'Previous day high', pd.hi, pd.hiIdx, iso(today - DAY))
    add('PDL', 'Previous day low', pd.lo, pd.loIdx, iso(today - DAY))
  }
  const td = range(today, today + DAY)
  if (td.n >= 6) {
    add('DAY_HIGH', 'Today high so far', td.hi, td.hiIdx, iso(today))
    add('DAY_LOW', 'Today low so far', td.lo, td.loIdx, iso(today))
  }
  const wk = weekStart(last.time)
  const pw = range(wk - 7 * DAY, wk)
  if (pw.n >= Math.floor((5 * DAY) / barSecs * 0.6)) {
    add('PWH', 'Previous week high', pw.hi, pw.hiIdx, iso(wk - 7 * DAY))
    add('PWL', 'Previous week low', pw.lo, pw.loIdx, iso(wk - 7 * DAY))
  }
  // latest COMPLETED (or in-progress, if it has bars) session of each kind, searching back up to 3 days
  const sessions: { key: 'ASIA' | 'LONDON' | 'NY'; label: string; h0: number; h1: number }[] = [
    { key: 'ASIA', label: 'Asia', h0: 0, h1: 7 },
    { key: 'LONDON', label: 'London', h0: 7, h1: 12 },
    { key: 'NY', label: 'New York', h0: 12, h1: 21 },
  ]
  for (const s of sessions) {
    for (let back = 0; back < 3; back++) {
      const d0 = today - back * DAY
      const from = d0 + s.h0 * 3600
      const to = d0 + s.h1 * 3600
      if (from > last.time) continue
      const r = range(from, Math.min(to, last.time + 1))
      const need = Math.max(3, Math.floor(((s.h1 - s.h0) * 3600) / barSecs * 0.5))
      if (r.n >= need) {
        add(`${s.key}_HIGH` as DayLevel['id'], `${s.label} high`, r.hi, r.hiIdx, iso(d0))
        add(`${s.key}_LOW` as DayLevel['id'], `${s.label} low`, r.lo, r.loIdx, iso(d0))
        break
      }
    }
  }
  const above = levels.filter((l) => !l.swept && l.side === 'above').sort((x, y) => x.distanceAtr - y.distanceAtr)[0] ?? null
  const below = levels.filter((l) => !l.swept && l.side === 'below').sort((x, y) => y.distanceAtr - x.distanceAtr)[0] ?? null
  return {
    ok: true,
    price,
    atr: a,
    bars: candles.length,
    levels,
    nearestAbove: above,
    nearestBelow: below,
    note: 'Fixed UTC-hour sessions (no DST). A level appears only when the data covers it. "swept" = traded beyond since it was set; "rejectedBar" = the latest bar that took it and closed back inside. Descriptive liquidity map, not a forecast.',
  }
}
