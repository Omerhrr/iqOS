// IQAIR//OS - many support/resistance levels and Fibonacci legs mapped on a FAST chart (5s by default) and read on the 1-minute chart
// (MSL `snr.*`, `fibs.*`, and the `snr-multi` / `fib-multi` chart overlays).
//
// The fast chart carries far more pivots than the chart you trade on: a 5s chart has 12 bars per minute, so a 2-hour window holds ~1400 bars and dozens of
// levels that a 1m chart never shows. Distances are measured in the TRADING chart's ATR14 so a level "0.3 ATR away" means the same thing everywhere.
//
// SNR  - fractal pivots (2 bars each side) of the fast highs AND lows, clustered when within 0.25 ATR(1m) of the running cluster mean; a cluster is a level,
//        `touches` = its pivots, strength = min(1, touches/6) x a recency factor (0.5..1, half-life ~600 fast bars). A level above the 1m close is resistance,
//        below is support; flipped levels simply move sides. Kept: touches >= 2, within 8 ATR(1m), nearest 40.
// FIBS - a zig-zag of the fast chart's HIGHS and LOWS (wick to wick) with a 2 ATR(1m) reversal threshold gives the last 8 legs; for each leg that is still INTACT (price has not closed beyond the
//        leg's start since) the retracement levels 38.2 / 50 / 61.8 / 70.5 / 78.6 are drawn from the leg's end. An up-leg's retracements are support, a down-leg's
//        resistance. Levels from DIFFERENT legs within 0.25 ATR(1m) stack into a confluence count.
// HONEST: levels are a map, not a forecast. More levels means more chances for price to be "at" one by accident - the touch/strength/confluence fields exist so a
// script can demand the crowded, repeatedly-tested ones, and a backtest has to show whether that pays.
import type { Candle } from '../types'
import { atr } from './indicators'

export const FASTLEVELS_MIN_FAST = 120
const SNR_TOL = 0.25
const SNR_MAX_DIST = 8
const SNR_KEEP = 40
const FIB_RATIOS = [0.382, 0.5, 0.618, 0.705, 0.786]
const FIB_LEGS = 8
const FIB_REV = 2

export interface SnrLevel { price: number; touches: number; strength: number; lastAge: number; side: 'support' | 'resistance' }
export interface SnrMap { ok: boolean; price: number; atr1m: number; levels: SnrLevel[] }
export interface FibLeg { start: number; end: number; dir: 1 | -1; endIndex: number; intact: boolean }
export interface FibLevel { price: number; ratio: number; leg: number; side: 'support' | 'resistance'; confluence: number }
export interface FibMap { ok: boolean; price: number; atr1m: number; legs: FibLeg[]; levels: FibLevel[] }

function refAtr(base: Candle[], fast: Candle[]): { a: number; spacingFast: number } {
  const a14 = atr(base.map((x) => x.high), base.map((x) => x.low), base.map((x) => x.close), 14)
  let a = a14[a14.length - 1]
  let sp = Infinity
  for (let i = 1; i < fast.length; i++) { const g = fast[i].time - fast[i - 1].time; if (g > 0 && g < sp) sp = g }
  if (!Number.isFinite(a) || a <= 0) a = NaN
  return { a, spacingFast: Number.isFinite(sp) ? sp : 5 }
}

export function buildSnrMap(fast: Candle[], base: Candle[]): SnrMap {
  const empty: SnrMap = { ok: false, price: 0, atr1m: 0, levels: [] }
  if (fast.length < FASTLEVELS_MIN_FAST || base.length < 20) return empty
  const f = fast.slice(-2000)
  const { a } = refAtr(base, f)
  if (!Number.isFinite(a)) return empty
  const price = base[base.length - 1].close
  const piv: { p: number; i: number }[] = []
  for (let i = 2; i < f.length - 2; i++) {
    const c = f[i]
    if (c.high > f[i - 1].high && c.high > f[i - 2].high && c.high >= f[i + 1].high && c.high >= f[i + 2].high) piv.push({ p: c.high, i })
    if (c.low < f[i - 1].low && c.low < f[i - 2].low && c.low <= f[i + 1].low && c.low <= f[i + 2].low) piv.push({ p: c.low, i })
  }
  piv.sort((x, y) => x.p - y.p)
  const tol = SNR_TOL * a
  const groups: { p: number; i: number }[][] = []
  let g: { p: number; i: number }[] = []
  let mean = 0
  for (const q of piv) {
    if (g.length && q.p - mean > tol) { groups.push(g); g = [] }
    g.push(q)
    mean = g.reduce((s, x) => s + x.p, 0) / g.length
  }
  if (g.length) groups.push(g)
  const lastIdx = f.length - 1
  const levels: SnrLevel[] = []
  for (const gr of groups) {
    if (gr.length < 2) continue
    const p = gr.reduce((s, x) => s + x.p, 0) / gr.length
    if (Math.abs(p - price) > SNR_MAX_DIST * a) continue
    const last = Math.max(...gr.map((x) => x.i))
    const age = lastIdx - last
    const rec = 0.5 + 0.5 * Math.pow(0.5, age / 600)
    levels.push({ price: p, touches: gr.length, strength: Math.min(1, gr.length / 6) * rec, lastAge: age, side: p >= price ? 'resistance' : 'support' })
  }
  levels.sort((x, y) => Math.abs(x.price - price) - Math.abs(y.price - price))
  return { ok: true, price, atr1m: a, levels: levels.slice(0, SNR_KEEP) }
}

export function buildFibMap(fast: Candle[], base: Candle[]): FibMap {
  const empty: FibMap = { ok: false, price: 0, atr1m: 0, legs: [], levels: [] }
  if (fast.length < FASTLEVELS_MIN_FAST || base.length < 20) return empty
  const f = fast.slice(-2000)
  const { a } = refAtr(base, f)
  if (!Number.isFinite(a)) return empty
  const price = base[base.length - 1].close
  // zig-zag on the fast closes with a FIB_REV * ATR(1m) reversal threshold
  const th = FIB_REV * a
  const pts: { p: number; i: number; hi: boolean }[] = []
  let dir = 0
  let hi = { p: f[0].high, i: 0 }
  let lo = { p: f[0].low, i: 0 }
  for (let i = 1; i < f.length; i++) {
    const h = f[i].high, l = f[i].low
    if (dir === 0) {
      if (h > hi.p) hi = { p: h, i }
      if (l < lo.p) lo = { p: l, i }
      if (hi.p - lo.p >= th) {
        if (lo.i < hi.i) { pts.push({ ...lo, hi: false }); dir = 1 } else { pts.push({ ...hi, hi: true }); dir = -1 }
      }
    } else if (dir === 1) {
      if (h > hi.p) hi = { p: h, i }
      else if (hi.p - l >= th) { pts.push({ ...hi, hi: true }); dir = -1; lo = { p: l, i } }
    } else {
      if (l < lo.p) lo = { p: l, i }
      else if (h - lo.p >= th) { pts.push({ ...lo, hi: false }); dir = 1; hi = { p: h, i } }
    }
  }
  if (dir === 1) pts.push({ ...hi, hi: true })
  else if (dir === -1) pts.push({ ...lo, hi: false })
  const legs: FibLeg[] = []
  for (let k = 1; k < pts.length; k++) {
    const s = pts[k - 1], e = pts[k]
    if (s.hi === e.hi) continue
    const d: 1 | -1 = e.p > s.p ? 1 : -1
    let intact = true
    for (let t = e.i + 1; t < f.length; t++) { if (d === 1 ? f[t].close < s.p : f[t].close > s.p) { intact = false; break } }
    legs.push({ start: s.p, end: e.p, dir: d, endIndex: e.i, intact })
  }
  const use = legs.filter((l) => l.intact).slice(-FIB_LEGS)
  const raw: FibLevel[] = []
  use.forEach((l, li) => {
    for (const r of FIB_RATIOS) {
      const p = l.dir === 1 ? l.end - r * (l.end - l.start) : l.end + r * (l.start - l.end)
      if (Math.abs(p - price) > SNR_MAX_DIST * a) continue
      raw.push({ price: p, ratio: r, leg: li, side: l.dir === 1 ? 'support' : 'resistance', confluence: 1 })
    }
  })
  for (const lv of raw) lv.confluence = new Set(raw.filter((o) => Math.abs(o.price - lv.price) <= SNR_TOL * a).map((o) => o.leg)).size
  raw.sort((x, y) => Math.abs(x.price - price) - Math.abs(y.price - price))
  return { ok: true, price, atr1m: a, legs: use, levels: raw }
}

export interface SnrRead { ok: boolean; map: SnrMap; rejected: number; rejLevel: number; rejTouches: number; atLevel: SnrLevel | null }
/** rejection read of the latest closed TRADING-chart bar against the fast-chart levels */
export function readSnr(fast: Candle[], base: Candle[], tolAtr = 0.25): SnrRead {
  const map = buildSnrMap(fast, base)
  const out: SnrRead = { ok: map.ok, map, rejected: 0, rejLevel: 0, rejTouches: 0, atLevel: null }
  if (!map.ok) return out
  const b = base[base.length - 1]
  const a = map.atr1m
  let best: SnrLevel | null = null
  for (const L of map.levels) {
    const near = L.price >= b.low - tolAtr * a && L.price <= b.high + tolAtr * a
    if (!near) continue
    if (!best || L.touches > best.touches) best = L
  }
  out.atLevel = best
  for (const L of map.levels) {
    const bull = b.low <= L.price + 0.15 * a && b.close > L.price && b.open > L.price
    const bear = b.high >= L.price - 0.15 * a && b.close < L.price && b.open < L.price
    if ((bull || bear) && L.touches > out.rejTouches) { out.rejected = bull ? 1 : -1; out.rejLevel = L.price; out.rejTouches = L.touches }
  }
  return out
}

export interface FibsRead { ok: boolean; map: FibMap; rejected: number; rejRatio: number; atCount: number; supportAt: number; resistAt: number }
export function readFibs(fast: Candle[], base: Candle[], tolAtr = 0.3): FibsRead {
  const map = buildFibMap(fast, base)
  const out: FibsRead = { ok: map.ok, map, rejected: 0, rejRatio: 0, atCount: 0, supportAt: 0, resistAt: 0 }
  if (!map.ok) return out
  const b = base[base.length - 1]
  const a = map.atr1m
  const near = map.levels.filter((l) => l.price >= b.low - tolAtr * a && l.price <= b.high + tolAtr * a)
  out.atCount = new Set(near.map((l) => l.leg)).size
  out.supportAt = new Set(near.filter((l) => l.side === 'support').map((l) => l.leg)).size
  out.resistAt = new Set(near.filter((l) => l.side === 'resistance').map((l) => l.leg)).size
  let bestC = 0
  for (const L of map.levels) {
    const bull = L.side === 'support' && b.low <= L.price + 0.15 * a && b.close > L.price && b.open > L.price
    const bear = L.side === 'resistance' && b.high >= L.price - 0.15 * a && b.close < L.price && b.open < L.price
    if ((bull || bear) && L.confluence > bestC) { bestC = L.confluence; out.rejected = bull ? 1 : -1; out.rejRatio = L.ratio }
  }
  return out
}

// ZONES - supply / demand on the fast chart. A BASE is 1-4 consecutive small bars (range <= 0.4 ATR of the trading chart); the zone is the base's low..high. DEMAND = price then
// left the base UP: within the next 4 fast bars a high >= zone top + 1.0 ATR. SUPPLY = mirror, a low <= zone bottom - 1.0 ATR. Later bars: `tests` = bars that re-entered the zone
// after the impulse; a CLOSE through the far side kills it (broken, dropped); zones tested more than 3 times are dropped. FRESH = tests 0. strength = min(1, displacement / 3 ATR).
const ZONE_BASE_RANGE = 0.4
const ZONE_IMPULSE = 1.0
const ZONE_KEEP = 20
export interface Zone { kind: 'demand' | 'supply'; top: number; bottom: number; tests: number; strength: number; age: number }
export interface ZoneMap { ok: boolean; price: number; atr1m: number; zones: Zone[] }
export function buildZoneMap(fast: Candle[], base: Candle[]): ZoneMap {
  const empty: ZoneMap = { ok: false, price: 0, atr1m: 0, zones: [] }
  if (fast.length < FASTLEVELS_MIN_FAST || base.length < 20) return empty
  const f = fast.slice(-2000)
  const { a } = refAtr(base, f)
  if (!Number.isFinite(a)) return empty
  const price = base[base.length - 1].close
  const small = (k: number) => f[k].high - f[k].low <= ZONE_BASE_RANGE * a
  const out: Zone[] = []
  let skipUntil = -1
  for (let i = 1; i < f.length - 4; i++) {
    if (i <= skipUntil || !small(i)) continue
    let s0 = i
    while (s0 > 0 && i - s0 < 3 && small(s0 - 1)) s0--
    let e = i
    while (e < f.length - 5 && e - s0 < 3 && small(e + 1)) e++
    let top = -Infinity, bot = Infinity
    for (let k = s0; k <= e; k++) { top = Math.max(top, f[k].high); bot = Math.min(bot, f[k].low) }
    let up = -Infinity, dn = Infinity
    for (let k = e + 1; k <= Math.min(e + 4, f.length - 1); k++) { up = Math.max(up, f[k].high); dn = Math.min(dn, f[k].low) }
    const upD = up - top, dnD = bot - dn
    let kind: 'demand' | 'supply' | null = null
    if (upD >= ZONE_IMPULSE * a && upD >= dnD) kind = 'demand'
    else if (dnD >= ZONE_IMPULSE * a) kind = 'supply'
    if (!kind) continue
    skipUntil = e + 4
    let tests = 0, dead = false, inside = false
    for (let k = e + 5; k < f.length; k++) {
      const c = f[k]
      const touching = kind === 'demand' ? c.low <= top : c.high >= bot
      if (kind === 'demand' ? c.close < bot : c.close > top) { dead = true; break }
      if (touching && !inside) tests++
      inside = touching
    }
    if (dead || tests > 3) continue
    out.push({ kind, top, bottom: bot, tests, strength: Math.min(1, (kind === 'demand' ? upD : dnD) / (3 * a)), age: f.length - 1 - e })
  }
  const near = out.filter((z) => Math.abs((z.top + z.bottom) / 2 - price) <= SNR_MAX_DIST * a)
  near.sort((x, y) => Math.abs((x.top + x.bottom) / 2 - price) - Math.abs((y.top + y.bottom) / 2 - price))
  return { ok: true, price, atr1m: a, zones: near.slice(0, ZONE_KEEP) }
}
export interface ZoneRead { ok: boolean; map: ZoneMap; inDemand: boolean; inSupply: boolean; rejected: number; zone: Zone | null }
/** latest closed TRADING-chart bar vs the zones: rejected +1 = wicked into a demand zone and closed back above its top, -1 = into supply and closed back below its bottom */
export function readZones(fast: Candle[], base: Candle[]): ZoneRead {
  const map = buildZoneMap(fast, base)
  const out: ZoneRead = { ok: map.ok, map, inDemand: false, inSupply: false, rejected: 0, zone: null }
  if (!map.ok) return out
  const b = base[base.length - 1]
  for (const z of map.zones) {
    const hit = b.low <= z.top && b.high >= z.bottom
    if (!hit) continue
    if (z.kind === 'demand') { out.inDemand = true; if (b.close > z.top && b.open > z.bottom && (!out.zone || z.strength > out.zone.strength)) { out.rejected = 1; out.zone = z } }
    else { out.inSupply = true; if (b.close < z.bottom && b.open < z.top && (!out.zone || z.strength > out.zone.strength)) { out.rejected = -1; out.zone = z } }
  }
  return out
}
