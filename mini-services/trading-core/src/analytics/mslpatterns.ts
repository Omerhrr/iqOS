// IQAIR//OS - the last SMC concepts as CANDLE-DERIVED primitives for MSL (`smcx.*`): mitigation blocks, propulsion blocks, volume imbalance,
// Judas swing and turtle soup. Pure, causal (closed candles up to "now"), so they work live, in the traders and in meta_strategy_backtest.
// Each is ONE mechanical reading of a discretionary concept - documented below and in the vocabulary - and none has a measured edge.
import type { Candle } from '../types'
import { atr } from './indicators'
import { scanSmc } from './smc'

export const PATTERN_MIN_BARS = 60
const WINDOW = 300

export interface Zone {
  top: number
  bottom: number
  /** bars since the pattern completed (the break / the propulsion candle / the gap candle) */
  barsAgo: number
  inZone: boolean
}
export interface BlockRead {
  price: number
  atr: number
  mitBull: Zone | null
  mitBear: Zone | null
  propBull: Zone | null
  propBear: Zone | null
  viBull: (Zone & { sizeAtr: number }) | null
  viBear: (Zone & { sizeAtr: number }) | null
}

interface Sw { index: number; price: number }
function swings2(c: Candle[]): { highs: Sw[]; lows: Sw[] } {
  const highs: Sw[] = []
  const lows: Sw[] = []
  for (let i = 2; i < c.length - 2; i++) {
    if (c[i].high > c[i - 1].high && c[i].high > c[i - 2].high && c[i].high > c[i + 1].high && c[i].high > c[i + 2].high) highs.push({ index: i, price: c[i].high })
    if (c[i].low < c[i - 1].low && c[i].low < c[i - 2].low && c[i].low < c[i + 1].low && c[i].low < c[i + 2].low) lows.push({ index: i, price: c[i].low })
  }
  return { highs, lows }
}

const MIT_BREAK_WITHIN = 30
const MIT_MAX_AGE = 80

/** Mitigation block. Bullish: in a down-move a swing low A undercuts the prior swing low P (a lower low), a rally makes swing high H, then the next
 * swing low B FAILS to undercut A (B > A) and price CLOSES above H within 30 bars: the structure shift. The block is the last bearish candle between
 * (B - 3) and the break - its full high/low range. Valid until a later close goes below the block. Bearish is the mirror. The newest qualifying
 * sequence per side is returned. (Unlike an order block it follows a FAILED extreme, not a swept one.) */
function findMitigation(c: Candle[], dir: 'bull' | 'bear'): { top: number; bottom: number; at: number } | null {
  const n = c.length
  const { highs, lows } = swings2(c)
  const ext = dir === 'bull' ? lows : highs // the swing type that made the lower low / higher high
  const opp = dir === 'bull' ? highs : lows
  for (let j = ext.length - 1; j >= 2 && j >= ext.length - 7; j--) {
    const B = ext[j], A = ext[j - 1], P = ext[j - 2]
    const trend = dir === 'bull' ? A.price < P.price : A.price > P.price
    const failed = dir === 'bull' ? B.price > A.price : B.price < A.price
    if (!trend || !failed) continue
    const mid = opp.filter((s) => s.index > A.index && s.index < B.index)
    if (!mid.length) continue
    const H = dir === 'bull' ? Math.max(...mid.map((s) => s.price)) : Math.min(...mid.map((s) => s.price))
    let k = -1
    for (let i = B.index + 1; i < n && i <= B.index + MIT_BREAK_WITHIN; i++) if (dir === 'bull' ? c[i].close > H : c[i].close < H) { k = i; break }
    if (k < 0 || n - 1 - k > MIT_MAX_AGE) continue
    let bi = -1
    for (let i = k - 1; i >= Math.max(1, B.index - 3); i--) if (dir === 'bull' ? c[i].close < c[i].open : c[i].close > c[i].open) { bi = i; break }
    if (bi < 0) continue
    const top = c[bi].high
    const bottom = c[bi].low
    let dead = false
    for (let i = k + 1; i < n; i++) if (dir === 'bull' ? c[i].close < bottom : c[i].close > top) { dead = true; break }
    if (dead) continue
    return { top, bottom, at: k }
  }
  return null
}

export interface ObLike { direction: 'bullish' | 'bearish'; top: number; bottom: number; index: number }
const PROP_BODY_ATR = 0.7
const PROP_MAX_AGE = 30
/** Propulsion block: a strong candle (body >= 0.7 ATR) that TAPS an unviolated order block of its own direction (a bullish candle whose low reaches the
 * zone, not more than 0.25 ATR below its bottom) and CLOSES beyond the zone (above its top for a bullish one). The block is the candle's body. Newest
 * within the last 30 bars; dropped once a later close is beyond the candle's far end. */
export function findPropulsion(c: Candle[], a: number[], zones: ObLike[], dir: 'bull' | 'bear'): { top: number; bottom: number; at: number } | null {
  const n = c.length
  for (let i = n - 1; i >= Math.max(2, n - PROP_MAX_AGE); i--) {
    const k = c[i]
    const A = a[i]
    if (!(A > 0)) continue
    const body = Math.abs(k.close - k.open)
    if (body < PROP_BODY_ATR * A) continue
    if (dir === 'bull' ? !(k.close > k.open) : !(k.close < k.open)) continue
    const hit = zones.some((z) => {
      if (z.direction !== (dir === 'bull' ? 'bullish' : 'bearish') || z.index >= i) return false
      if (dir === 'bull') return k.low <= z.top && k.low >= z.bottom - 0.25 * A && k.close > z.top
      return k.high >= z.bottom && k.high <= z.top + 0.25 * A && k.close < z.bottom
    })
    if (!hit) continue
    const top = Math.max(k.open, k.close)
    const bottom = Math.min(k.open, k.close)
    let dead = false
    for (let j = i + 1; j < n; j++) if (dir === 'bull' ? c[j].close < k.low : c[j].close > k.high) { dead = true; break }
    if (dead) continue
    return { top, bottom, at: i }
  }
  return null
}

const VI_MAX_AGE = 40
/** Volume imbalance: two consecutive candles whose BODIES do not touch while their WICKS still overlap (a bullish one: the second body starts above the
 * first body's top and the second low is at or below the first high) - the gap between the bodies is the zone. Unfilled until a later bar trades back
 * through the near edge of the gap. Newest within 40 bars. NOTE: a feed whose candles always open exactly at the previous close can never show one. */
function findVi(c: Candle[], a: number[], dir: 'bull' | 'bear', minAtr: number): { top: number; bottom: number; at: number; sizeAtr: number } | null {
  const n = c.length
  for (let i = n - 1; i >= Math.max(1, n - VI_MAX_AGE); i--) {
    const p = c[i - 1], k = c[i]
    const A = a[i]
    if (!(A > 0)) continue
    const pTop = Math.max(p.open, p.close), pBot = Math.min(p.open, p.close)
    const kTop = Math.max(k.open, k.close), kBot = Math.min(k.open, k.close)
    let top: number, bottom: number
    if (dir === 'bull') {
      if (!(kBot > pTop) || !(k.low <= p.high)) continue
      bottom = pTop; top = kBot
    } else {
      if (!(kTop < pBot) || !(k.high >= p.low)) continue
      top = pBot; bottom = kTop
    }
    const sizeAtr = (top - bottom) / A
    if (sizeAtr < minAtr) continue
    let filled = false
    for (let j = i + 1; j < n; j++) if (dir === 'bull' ? c[j].low <= bottom : c[j].high >= top) { filled = true; break }
    if (filled) continue
    return { top, bottom, at: i, sizeAtr }
  }
  return null
}

export function readBlocks(all: Candle[], viMinAtr = 0.05): BlockRead | null {
  if (all.length < PATTERN_MIN_BARS) return null
  const c = all.length > WINDOW ? all.slice(-WINDOW) : all
  const n = c.length
  const a = atr(c.map((k) => k.high), c.map((k) => k.low), c.map((k) => k.close), 14)
  const A = Number.isFinite(a[n - 1]) && a[n - 1] > 0 ? a[n - 1] : c[n - 1].close * 0.001
  const price = c[n - 1].close
  const z = <T extends { top: number; bottom: number; at: number }>(r: T | null): (Zone & Omit<T, 'top' | 'bottom' | 'at'>) | null =>
    r ? { ...r, barsAgo: n - 1 - r.at, inZone: price <= r.top && price >= r.bottom } as never : null
  const scan = scanSmc(c)
  const obs: ObLike[] = (scan?.signals ?? []).filter((s) => s.kind === 'ORDER_BLOCK' && s.active && s.top !== undefined && s.bottom !== undefined).map((s) => ({ direction: s.direction, top: s.top!, bottom: s.bottom!, index: s.index }))
  return {
    price,
    atr: A,
    mitBull: z(findMitigation(c, 'bull')),
    mitBear: z(findMitigation(c, 'bear')),
    propBull: z(findPropulsion(c, a, obs, 'bull')),
    propBear: z(findPropulsion(c, a, obs, 'bear')),
    viBull: z(findVi(c, a, 'bull', viMinAtr)) as BlockRead['viBull'],
    viBear: z(findVi(c, a, 'bear', viMinAtr)) as BlockRead['viBear'],
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Judas swing (session-open fake move) and turtle soup (false 20-bar breakout)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export const JUDAS_SESSIONS = [0, 7, 12] as const // UTC hour of the day open, London open, New York open
const JUDAS_WINDOW_SEC = 3 * 3600
const JUDAS_FAKE_ATR = 0.75
const DAY = 86400

export interface JudasRead {
  /** +1 = fake move DOWN then reclaimed the open (expected real move up), -1 = fake move UP then lost the open, 0 = none */
  dir: -1 | 0 | 1
  /** bars since the reclaim bar (99 = none) */
  ago: number
}

/** Judas swing at a session open: from the session's opening price O, price first makes a fake move of >= 0.75 ATR one way inside the first 3 hours, then a
 * bar CLOSES back through O the other way (the reclaim). dir is the expected real direction (opposite the fake). Needs real timestamps and the session
 * open bar inside the data; the latest session that has started is read. A fresh session with no fake move yet reads none. */
export function readJudas(all: Candle[], session: 0 | 1 | 2): JudasRead | null {
  if (all.length < PATTERN_MIN_BARS) return null
  const c = all.length > WINDOW ? all.slice(-WINDOW) : all
  const n = c.length
  const last = c[n - 1]
  const barSec = Math.max(1, Math.round(c[n - 1].time - c[n - 2].time))
  let s0 = Math.floor(last.time / DAY) * DAY + JUDAS_SESSIONS[session] * 3600
  if (s0 > last.time) s0 -= DAY
  let i0 = -1
  for (let i = 0; i < n; i++) if (c[i].time >= s0) { i0 = i; break }
  if (i0 < 0 || c[i0].time - s0 > 2 * barSec || i0 < 20) return { dir: 0, ago: 99 }
  const a = atr(c.map((k) => k.high), c.map((k) => k.low), c.map((k) => k.close), 14)
  const A = a[i0 - 1] > 0 ? a[i0 - 1] : a[n - 1]
  if (!(A > 0)) return { dir: 0, ago: 99 }
  const O = c[i0].open
  let fake: -1 | 1 | 0 = 0
  for (let i = i0; i < n && c[i].time < s0 + JUDAS_WINDOW_SEC; i++) {
    if (fake === 0) {
      if (c[i].low <= O - JUDAS_FAKE_ATR * A) fake = 1 // fell first: real move expected up
      else if (c[i].high >= O + JUDAS_FAKE_ATR * A) fake = -1
      continue
    }
    if (fake === 1 && c[i].close > O) return { dir: 1, ago: n - 1 - i }
    if (fake === -1 && c[i].close < O) return { dir: -1, ago: n - 1 - i }
  }
  return { dir: 0, ago: 99 }
}

/** Turtle soup (Raschke): bar i takes out the lowest low (highest high) of the previous `period` bars - and that extreme is at least 4 bars old - then CLOSES
 * back inside. Bullish soup = false breakdown (expected up), bearish = false breakout. Returns the bars-ago of the newest such bar within the last 20 bars
 * (99 = none). */
export function readSoup(all: Candle[], dir: 'bull' | 'bear', period: number): number | null {
  const c = all.length > WINDOW ? all.slice(-WINDOW) : all
  const n = c.length
  if (n < period + 6) return null
  for (let i = n - 1; i >= Math.max(period, n - 20); i--) {
    let ext = dir === 'bull' ? Infinity : -Infinity
    let extIdx = -1
    for (let j = i - period; j < i; j++) {
      if (dir === 'bull' ? c[j].low < ext : c[j].high > ext) { ext = dir === 'bull' ? c[j].low : c[j].high; extIdx = j }
    }
    if (extIdx < 0 || i - extIdx < 4) continue
    if (dir === 'bull' ? c[i].low < ext && c[i].close > ext : c[i].high > ext && c[i].close < ext) return n - 1 - i
  }
  return 99
}
