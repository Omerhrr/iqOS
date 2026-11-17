// IQAIR//OS - tests: LuxAlgo Smart Money Concepts port (analytics/luxsmc.ts, ind.lux) on hand-built planted structures
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { luxSmc, LUX_FIELDS } from '../src/analytics/luxsmc'
const T0 = Date.UTC(2026, 0, 5) / 1000
function shape(wp: [number, number][], opts: { lead?: number; w?: number; step?: number; t0?: number } = {}): Candle[] {
  const w = opts.w ?? 0.05, lead = opts.lead ?? 0, step = opts.step ?? 60, t0 = opts.t0 ?? T0
  const closes: number[] = []
  for (let i = 0; i < lead; i++) closes.push(wp[0][1] + Math.sin(i * 1.3) * 0.02)
  for (let k = 0; k < wp.length - 1; k++) { const [i0, p0] = wp[k], [i1, p1] = wp[k + 1]; for (let i = i0; i < i1; i++) closes.push(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0)) }
  closes.push(wp[wp.length - 1][1])
  return closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { time: t0 + i * step, open: o, close: c, high: Math.max(o, c) + w, low: Math.min(o, c) - w, volume: 1 } })
}
const col = (c: Candle[]) => ({ open: c.map((k) => k.open), high: c.map((k) => k.high), low: c.map((k) => k.low), close: c.map((k) => k.close), time: c.map((k) => k.time) })
const sum = (a: number[]) => a.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0)
const idx = (a: number[]) => a.map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0)
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const O = { swingLen: 4, internalLen: 2 }
const A = shape([[0, 100], [10, 110], [16, 104], [26, 114], [32, 108], [42, 118], [50, 96]])
test('swing structure: BOS bullish twice while trend is up, then CHoCH bearish when the swing low breaks; trend flips', () => {
  const r = luxSmc(col(A), O)
  assert.equal(sum(r.swingBullBos), 2, `bull bos at ${idx(r.swingBullBos)}`)
  assert.equal(sum(r.swingBullChoch), 0); assert.equal(sum(r.swingBearBos), 0)
  assert.equal(sum(r.swingBearChoch), 1, `bear choch at ${idx(r.swingBearChoch)}`)
  const b = idx(r.swingBullBos), c = idx(r.swingBearChoch)[0]
  assert.ok(b[0] >= 20 && b[0] <= 26, `first BOS at ${b[0]}`); assert.ok(b[1] >= 34 && b[1] <= 40, `second BOS at ${b[1]}`); assert.ok(c >= 44 && c <= 49, `CHoCH at ${c}`)
  assert.equal(r.swingTrend[25], 1); assert.equal(r.swingTrend[A.length - 1], -1)
})
test('a bullish BOS stores a bullish order block at the lowest candle of the leg; it is mitigated when price trades below it', () => {
  const r = luxSmc(col(A), O)
  const first = idx(r.swingBullBos)[0]
  assert.equal(r.swingObBull[first], 1)
  assert.ok(Math.abs(r.swingObBullBottom[first] - 103.95) < 0.06, `OB bottom ${r.swingObBullBottom[first]}`)
  const brk = idx(r.swingObBullBreak); assert.ok(brk.length >= 1 && brk[0] > idx(r.swingBearChoch)[0] - 4, `break at ${brk}`)
  assert.equal(r.swingObBull[A.length - 1], 0, 'all bullish OBs mitigated by the crash')
  assert.ok(r.swingObBear[A.length - 1] >= 1, 'the bearish CHoCH stored a bearish OB')
})
test('price returning into a bullish OB is flagged (swingObBullIn) without breaking it', () => {
  const C = shape([[0, 100], [10, 110], [16, 104], [26, 114], [32, 104.02], [40, 112]])
  const r = luxSmc(col(C), O)
  assert.equal(r.swingObBullIn[32], 1, `in at 32: ${r.swingObBullIn[32]} (top ${r.swingObBullTop[32]} bottom ${r.swingObBullBottom[32]})`)
  assert.equal(sum(r.swingObBullBreak), 0)
})
test('premium / discount / equilibrium and strong / weak high-low are consistent', () => {
  const r = luxSmc(col(A), O)
  let prem = 0
  for (let i = 0; i < A.length; i++) {
    if (!Number.isFinite(r.pos[i])) continue
    if (r.premium[i]) { prem++; assert.ok(r.pos[i] >= 0.94) }
    if (r.discount[i]) assert.ok(r.pos[i] <= 0.06)
    if (r.equilibrium[i]) assert.ok(Math.abs(r.pos[i] - 0.5) <= 0.026)
  }
  assert.ok(prem >= 1, 'price spent time in the premium zone near the 118 high')
  const e = A.length - 1
  assert.ok(Number.isFinite(r.strongHigh[e]) && Number.isNaN(r.weakHigh[e]), 'bearish trend -> the high is STRONG')
  assert.ok(Number.isFinite(r.weakLow[e]) && Number.isNaN(r.strongLow[e]), '...and the low is WEAK')
  assert.ok(Math.abs(r.top[e] - 118.05) < 0.1, `top ${r.top[e]}`)
})
test('equal highs fire when a pivot high lands within eqThr * ATR200 of the previous one', () => {
  const lead = Array.from({ length: 260 }, (_, i) => 100 + Math.sin(i / 3) * 0.3)
  const tail = shape([[0, 100], [8, 105], [18, 101], [28, 105.02], [38, 100]]).map((k, i) => ({ ...k, time: T0 + (260 + i) * 60 }))
  const lc: Candle[] = lead.map((c, i) => { const o = i ? lead[i - 1] : c; return { time: T0 + i * 60, open: o, close: c, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, volume: 1 } })
  const r = luxSmc(col([...lc, ...tail]), { swingLen: 20, internalLen: 5, eqLen: 3, eqThr: 0.5 })
  const ev = idx(r.eqh).filter((i) => i > 280); assert.ok(ev.length >= 1 && ev.some((i) => i >= 286 && i <= 292), `eqh events ${ev}`)
  assert.ok(Math.abs(r.eqhLevel[ev[0]] - 105.07) < 0.15, `eq level ${r.eqhLevel[ev[0]]}`)
})
test('fair value gap: forms on the third candle, price returning inside is flagged, closing through it deletes it', () => {
  const base = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 0.01 : -0.01))
  const k: Candle[] = base.map((c, i) => ({ time: T0 + i * 60, open: c, close: c + 0.005, high: c + 0.03, low: c - 0.03, volume: 1 }))
  k.push({ time: T0 + 40 * 60, open: 100.0, close: 100.1, high: 100.2, low: 99.9, volume: 1 })    // k-2
  k.push({ time: T0 + 41 * 60, open: 100.1, close: 102.5, high: 102.6, low: 99.95, volume: 1 }) // k-1 impulse (wick back to the base: no gap against bar 39)
  k.push({ time: T0 + 42 * 60, open: 102.4, close: 102.0, high: 102.5, low: 101.0, volume: 1 })   // k: low 101 > high[k-2] 100.2
  k.push({ time: T0 + 43 * 60, open: 102.0, close: 100.7, high: 102.0, low: 100.6, volume: 1 })   // closes inside [100.2, 101.0]
  k.push({ time: T0 + 44 * 60, open: 100.7, close: 99.6, high: 100.7, low: 99.5, volume: 1 })     // low < gap bottom -> deleted
  const r = luxSmc(col(k), O)
  assert.equal(r.fvgBull[42], 1); assert.equal(sum(r.fvgBull), 1)
  assert.equal(r.fvgBullCount[42], 1); assert.equal(r.fvgBullIn[43], 1); assert.equal(r.fvgBullIn[42], 0)
  assert.equal(r.fvgBullCount[44], 0, 'deleted')
  const m = luxSmc(col(k.map((c) => ({ ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high }))), O)
  assert.equal(m.fvgBear[42], 1, 'mirror = bearish gap'); assert.equal(m.fvgBull[42], 0)
})
test('previous day / week / month highs and lows', () => {
  const k: Candle[] = []
  for (let h = 0; h < 14 * 24; h++) { const day = Math.floor(h / 24), c = 100 + day; k.push({ time: T0 + h * 3600, open: c, close: c, high: c + 0.5, low: c - 0.5, volume: 1 }) } // Mon Jan 5 .. Sun Jan 18
  const r = luxSmc(col(k), O)
  const at = (day: number, hour = 5) => day * 24 + hour
  assert.ok(Number.isNaN(r.pdh[at(0)]), 'no previous day yet')
  assert.equal(r.pdh[at(3)], 102.5); assert.equal(r.pdl[at(3)], 101.5)
  assert.ok(Number.isNaN(r.pwh[at(6)]), 'still in week 1')
  assert.equal(r.pwh[at(7)], 106.5, 'week 2 sees week 1 (days 0-6, max 106.5)'); assert.equal(r.pwl[at(7)], 99.5)
  assert.ok(Number.isNaN(r.pmh[at(13)]), 'first month: no previous month')
})
test('MSL: ind.lux fields trade a BOS/CHoCH script; options and tf pop parse', () => {
  const S = shape([[0, 100], [10, 110], [16, 104], [26, 114], [32, 108], [42, 118], [50, 96], [60, 105]], { lead: 70 })
  const run = (sc: string) => backtestMslScript(S, sc, { expiryBars: 3 })
  const r = run('let lx = ind.lux(4, 2)\ncall when lx.swingBullBos[-1] == 1\nput when lx.swingBearChoch[-1] == 1')
  assert.ok(r.ok, String(r.error)); assert.ok(r.trades.length >= 1, `trades ${r.trades.length}`)
  const all = LUX_FIELDS.map((f) => `ind.lux(4, 2).${f}[-1] > -999999999`).join(' or ')
  assert.ok(run(`call when ${all} or true`).ok)
  const o = run('call when ind.lux(4, 2, 3, 0.1, 1, 1, 1, 0).internalTrend[-1] == 1')
  assert.ok(o.ok, String(o.error))
  const t = run('call when ind.lux(4, 2, 3, 0.1, 0, 0, 0, 1, "5m").swingTrend[-1] == 1'); assert.ok(t.ok || /5m|timeframe/.test(String(t.error)))
})
console.log(`${pass}/${total} passed`); if (pass !== total) process.exit(1)
