// IQAIR//OS - tests: market maker model (mmxm.*), smt.* (partner pair) and premium/discount (smcx.pd*).
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { readMmxm } from '../src/analytics/mslmmxm'
import { readSmcx } from '../src/analytics/mslsmcx'
import { backtestMslScript } from '../src/analytics/mslbacktest'

const tests: [string, () => void][] = []
const test = (n: string, f: () => void) => tests.push([n, f])
const T0 = 1_700_000_000
function zig(points: [number, number][], pad = 0.0001, t0 = T0): Candle[] {
  const out: Candle[] = []
  for (let p = 0; p < points.length - 1; p++) {
    const [i0, v0] = points[p]
    const [i1, v1] = points[p + 1]
    for (let i = i0; i < i1 || (p === points.length - 2 && i === i1); i++) {
      const c = v0 + ((v1 - v0) * (i - i0)) / (i1 - i0)
      const prev = out.length ? out[out.length - 1].close : c
      out.push({ time: t0 + out.length * 60, open: prev, high: c + pad, low: c - pad, close: c, volume: 100 })
    }
  }
  return out
}
/** a full buy-model cycle: consolidation (0-21), sell-side curve to 1.0889 at bar 48 (lower high 1.0932 at 43), reversal, climb back through the consolidation high */
function buyCycle(): Candle[] {
  const cons: Candle[] = []
  for (let i = 0; i < 22; i++) {
    const c = 1.1 + 0.0004 * Math.sin(i * 1.3)
    const prev = cons.length ? cons[cons.length - 1].close : c
    cons.push({ time: T0 + i * 60, open: prev, high: Math.max(prev, c) + 0.0001, low: Math.min(prev, c) - 0.0001, close: c, volume: 100 })
  }
  const rest = zig([[22, 1.0998], [30, 1.096], [33, 1.0972], [40, 1.092], [43, 1.0932], [48, 1.089], [56, 1.095], [70, 1.101]])
    .map((c) => ({ ...c, time: T0 + (22 + (c.time - T0) / 60) * 60 }))
  return [...cons, ...rest]
}
const mirrored = (c: Candle[]): Candle[] => c.map((k) => ({ ...k, open: 2.2 - k.open, high: 2.2 - k.low, low: 2.2 - k.high, close: 2.2 - k.close }))
// the reader needs 60+ bars: pad the front of every prefix with a flat quiet run so short prefixes are readable too
const withLead = (c: Candle[]): Candle[] => {
  const lead: Candle[] = []
  const t = c[0].time
  for (let i = 0; i < 60; i++) {
    const v = c[0].close + 0.0004 * Math.sin(i * 1.1)
    lead.push({ time: t - (60 - i) * 60, open: v, high: v + 0.0002, low: v - 0.0002, close: v, volume: 100 })
  }
  return [...lead, ...c]
}

test('buy model: phase 2 after the curve, 3 right after the reversal, 4 while it runs, 5 at the target', () => {
  const full = withLead(buyCycle())
  const at = (k: number) => readMmxm(full.slice(0, 60 + k))!
  const p2 = at(53)
  assert.equal(p2.model, 'buy')
  assert.equal(p2.phase, 2, JSON.stringify(p2))
  const p3 = at(56)
  assert.equal(p3.phase, 3, JSON.stringify(p3))
  const p4 = at(65)
  assert.equal(p4.phase, 4, JSON.stringify(p4))
  const p5 = at(buyCycle().length)
  assert.equal(p5.phase, 5, JSON.stringify(p5))
  assert.ok(p4.progress > 0.4 && p4.progress < 1)
  assert.ok(Math.abs(p4.invalidation - (1.089 - 0.0001)) < 1e-9)
  assert.ok(p4.target > 1.1)
})
test('sell model is the mirror image', () => {
  const full = withLead(mirrored(buyCycle()))
  const at = (k: number) => readMmxm(full.slice(0, 60 + k))!
  const r = at(65)
  assert.equal(r.model, 'sell')
  assert.equal(r.phase, 4)
  assert.ok(r.target < 1.1 && r.target > 1.09, String(r.target))
  assert.ok(r.invalidation > 1.1)
  assert.equal(at(56).phase, 3)
})
test('no model: a plain range, a plain trend, too few bars', () => {
  const range: Candle[] = []
  for (let i = 0; i < 120; i++) { const c = 1.1 + 0.0005 * Math.sin(i * 0.9); range.push({ time: T0 + i * 60, open: c, high: c + 0.0002, low: c - 0.0002, close: c, volume: 1 }) }
  assert.equal(readMmxm(range)!.model, 'none')
  assert.equal(readMmxm(zig([[0, 1.09], [120, 1.13]]))!.model, 'none')
  assert.equal(readMmxm(range.slice(0, 30)), null)
})
test('a new low beyond the curve extreme voids the model (no stale buy)', () => {
  const c = withLead(buyCycle()).slice(0, 60 + 62)
  const extra = zig([[0, c[c.length - 1].close], [8, 1.085]], 0.0001, c[c.length - 1].time + 60)
  const r = readMmxm([...c, ...extra.slice(1)])!
  assert.ok(!(r.model === 'buy' && (r.phase === 3 || r.phase === 4)), JSON.stringify(r))
})
test('mmxm.* in MSL: buy() fires only in the entry window, inside a backtest', () => {
  const full = withLead(buyCycle())
  const res = backtestMslScript(full, 'call when mmxm.buy()\nconfidence = 55', { expiryBars: 1, warmupBars: 60 + 52 })
  assert.equal(res.ok, true)
  assert.ok(res.trades.length >= 8, 'fires through phases 3-4 (' + res.trades.length + ')')
  const none = backtestMslScript(full, 'call when mmxm.sell()', { expiryBars: 1, warmupBars: 60 + 52 })
  assert.equal(none.trades.length, 0)
})
test('mmxm.phase() / model() / progress() are readable values', () => {
  const full = withLead(buyCycle())
  const res = backtestMslScript(full, 'call when mmxm.model() == "buy" and mmxm.phase() >= 3 and mmxm.progress() > 0.2', { expiryBars: 1, warmupBars: 60 + 52 })
  assert.ok(res.trades.length > 0)
})

// ---- premium / discount ----
test('premium/discount: price in the lower half of the dealing range is discount, upper half premium', () => {
  const lowEnd = zig([[0, 1.1], [15, 1.09], [30, 1.1], [45, 1.09], [60, 1.1], [75, 1.093]]) // range 1.09-1.1, ends near the low
  const r = readSmcx(lowEnd)!
  assert.ok(r.pd, 'range found')
  assert.ok(r.pd!.pos < 0.5, 'pos ' + r.pd!.pos)
  const hiEnd = zig([[0, 1.09], [15, 1.1], [30, 1.09], [45, 1.1], [60, 1.09], [75, 1.098]])
  const r2 = readSmcx(hiEnd)!
  assert.ok(r2.pd!.pos > 0.5, 'pos ' + r2.pd!.pos)
})
test('smcx.discount()/premium()/pdPos() in MSL', () => {
  const lowEnd = zig([[0, 1.1], [15, 1.09], [30, 1.1], [45, 1.09], [60, 1.1], [75, 1.093]])
  const run = (line: string) => backtestMslScript(lowEnd, `call when ${line}`, { expiryBars: 1, warmupBars: lowEnd.length - 3 }).trades.length
  assert.ok(run('smcx.pdOk() and smcx.discount()') > 0)
  assert.equal(run('smcx.premium()'), 0)
  assert.ok(run('smcx.pdOk() and smcx.pdPos() < 0.35') > 0)
  assert.ok(run('smcx.discount(0.9) and smcx.pdSpanAtr() > 1.5') > 0)
})
test('no dealing range under 1.5 ATR wide: pdOk false, premium/discount false', () => {
  const tiny: Candle[] = []
  for (let i = 0; i < 100; i++) { const c = 1.1 + 0.00005 * Math.sin(i); tiny.push({ time: T0 + i * 60, open: c, high: c + 0.0003, low: c - 0.0003, close: c, volume: 1 }) }
  const r = readSmcx(tiny)!
  assert.equal(r.pd, null)
})

// ---- smt.* ----
let seed = 5
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5)
function coPair(n: number): [Candle[], Candle[]] {
  const a: number[] = [1.1], b: number[] = [1.3]
  for (let i = 1; i < n; i++) { const d = rnd() * 0.0008; a.push(a[i - 1] + d); b.push(b[i - 1] + d + rnd() * 0.00005) }
  const mk = (x: number[]) => x.map((c, i) => ({ time: T0 + i * 60, open: i ? x[i - 1] : c, high: c + 0.0002, low: c - 0.0002, close: c, volume: 1 } as Candle))
  return [mk(a), mk(b)]
}
test('smt.bearish("P"): A makes a new high, partner does not -> fires in a backtest with partner candles', () => {
  const [a, b] = coPair(120)
  for (let i = 100; i < 120; i++) { a[i] = { ...a[i], close: a[99].close + 0.004, high: a[99].close + 0.0042, low: a[99].close + 0.0038, open: a[99].close + 0.004 }; b[i] = { ...b[99], time: b[i].time } }
  const res = backtestMslScript(a, 'put when smt.ok("PAIRB") and smt.bearish("PAIRB")\nconfidence = 55', { expiryBars: 1, warmupBars: 105, partners: { PAIRB: b } })
  assert.equal(res.ok, true)
  assert.ok(res.trades.length > 0, 'fired (' + res.trades.length + ')')
})
test('smt.* fails closed without partner candles (no trades, no crash)', () => {
  const [a] = coPair(120)
  const res = backtestMslScript(a, 'put when smt.bearish("PAIRB")', { expiryBars: 1, warmupBars: 80 })
  assert.equal(res.ok, true)
  assert.equal(res.trades.length, 0)
})
test('smt.* sees no look-ahead: appending FUTURE partner bars changes nothing', () => {
  const [a, b] = coPair(140)
  for (let i = 100; i < 120; i++) a[i] = { ...a[i], close: a[99].close + 0.004, high: a[99].close + 0.0042, low: a[99].close + 0.0038, open: a[99].close + 0.004 }
  const aa = a.slice(0, 120)
  const bShort = b.slice(0, 120)
  const bLong = b // the same plus 20 later bars (times beyond the last evaluated candle)
  const s = 'put when smt.ok("PAIRB") and smt.bearish("PAIRB")'
  const r1 = backtestMslScript(aa, s, { expiryBars: 1, warmupBars: 80, partners: { PAIRB: bShort } })
  const r2 = backtestMslScript(aa, s, { expiryBars: 1, warmupBars: 80, partners: { PAIRB: bLong } })
  assert.deepEqual(r1.trades.map((t) => t.index), r2.trades.map((t) => t.index))
})
test('smt.leads / smt.dir / smt.corr are readable; an uncorrelated partner is not ok', () => {
  const [a, b] = coPair(120)
  const res = backtestMslScript(a, 'call when smt.corr("PAIRB") > 0.9 and smt.dir("PAIRB") == "none" and smt.leads("PAIRB") == 0', { expiryBars: 1, warmupBars: 80, partners: { PAIRB: b } })
  assert.ok(res.trades.length > 0)
  const u: Candle[] = []
  let x = 1.3
  for (let i = 0; i < 120; i++) { x += rnd() * 0.0008; u.push({ time: T0 + i * 60, open: x, high: x + 0.0002, low: x - 0.0002, close: x, volume: 1 }) }
  const r2 = backtestMslScript(a, 'call when smt.ok("U")', { expiryBars: 1, warmupBars: 80, partners: { U: u } })
  assert.equal(r2.trades.length, 0)
})

let fail = 0
for (const [n, f] of tests) { try { f(); console.log('ok  ' + n) } catch (e) { fail++; console.log('FAIL ' + n + '\n    ' + (e as Error).message.slice(0, 600)) } }
console.log(fail ? fail + ' FAILED' : 'all ' + tests.length + ' passed')
process.exit(fail ? 1 : 0)
