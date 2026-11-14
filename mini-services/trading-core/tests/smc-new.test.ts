// IQAIR//OS - tests for the three SMC context kinds: EQH_EQL, REJECTION_BLOCK, INDUCEMENT.
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { scanSmc, smcNowRead, smcAnyAgrees, ALL_SMC_KINDS, TALLY_EXCLUDED } from '../src/analytics/smc'

type Test = { name: string; fn: () => void }
const tests: Test[] = []
const test = (name: string, fn: () => void) => tests.push({ name, fn })

/** closes interpolated linearly between waypoints [barIndex, price]; high/low = close +/- pad */
function zig(points: [number, number][], pad = 0.0001): Candle[] {
  const out: Candle[] = []
  const t0 = 1_700_000_000
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
const kinds = (c: Candle[], k: string) => (scanSmc(c)?.signals ?? []).filter((s) => s.kind === k)

test('kinds registered and context kinds listed', () => {
  assert.equal(ALL_SMC_KINDS.length, 18)
  for (const k of ['EQH_EQL', 'REJECTION_BLOCK', 'INDUCEMENT']) assert.ok(ALL_SMC_KINDS.includes(k as never) && TALLY_EXCLUDED.has(k as never))
})

test('equal highs: two matching swing highs, unswept, price near -> active EQH pool (barsAgo 0)', () => {
  const c = zig([[0, 1.09], [20, 1.1], [30, 1.095], [40, 1.1], [50, 1.096], [66, 1.1]])
  const e = kinds(c, 'EQH_EQL').filter((s) => s.direction === 'bullish')
  assert.equal(e.length, 1, JSON.stringify(e))
  assert.equal(e[0].touches, 2)
  assert.ok(Math.abs((e[0].level ?? 0) - 1.1001) < 1e-9)
  assert.equal(e[0].barsAgo, 0)
  assert.equal(e[0].active, true)
})

test('equal highs: swept pool disappears', () => {
  const c = zig([[0, 1.09], [20, 1.1], [30, 1.095], [40, 1.1], [50, 1.096], [62, 1.0997], [66, 1.103]])
  assert.equal(kinds(c, 'EQH_EQL').filter((s) => s.direction === 'bullish').length, 0)
})

test('equal highs: unequal highs are not a pool', () => {
  const c = zig([[0, 1.09], [20, 1.1], [30, 1.095], [40, 1.1030], [50, 1.096], [66, 1.0997]])
  assert.equal(kinds(c, 'EQH_EQL').filter((s) => s.direction === 'bullish').length, 0)
})

test('equal lows mirror: pool below price', () => {
  const c = zig([[0, 1.11], [20, 1.1], [30, 1.105], [40, 1.1], [50, 1.104], [66, 1.1003]])
  const e = kinds(c, 'EQH_EQL').filter((s) => s.direction === 'bearish')
  assert.equal(e.length, 1)
  assert.equal(e[0].touches, 2)
})

test('rejection block (bearish): long upper wick at a swing high, entry at the body edge', () => {
  const c = zig([[0, 1.09], [30, 1.1], [45, 1.094], [66, 1.0935]])
  // replace the peak (bar 30) with a long-wick candle
  c[30] = { ...c[30], open: 1.1, close: 1.0999, high: 1.101, low: 1.0997 }
  const r = kinds(c, 'REJECTION_BLOCK').filter((s) => s.direction === 'bearish')
  assert.equal(r.length, 1, JSON.stringify(r))
  assert.equal(r[0].top, 1.101)
  assert.equal(r[0].bottom, 1.1)
  assert.equal(r[0].active, true)
})

test('rejection block is dropped once a later bar closes beyond the wick tip', () => {
  const c = zig([[0, 1.09], [30, 1.1], [45, 1.094], [60, 1.1025], [66, 1.1026]])
  c[30] = { ...c[30], open: 1.1, close: 1.0999, high: 1.101, low: 1.0997 }
  assert.equal(kinds(c, 'REJECTION_BLOCK').filter((s) => s.index === 30).length, 0)
})

test('rejection block (bullish) mirror at a swing low', () => {
  const c = zig([[0, 1.11], [30, 1.1], [45, 1.106], [66, 1.1065]])
  c[30] = { ...c[30], open: 1.1, close: 1.1001, high: 1.1003, low: 1.099 }
  const r = kinds(c, 'REJECTION_BLOCK').filter((s) => s.direction === 'bullish' && s.index === 30)
  assert.equal(r.length, 1)
  assert.equal(r[0].bottom, 1.099)
  assert.equal(r[0].top, 1.1)
})

test('a plain zig-zag with no long wicks has no rejection block', () => {
  const c = zig([[0, 1.09], [30, 1.1], [45, 1.094], [66, 1.099]])
  assert.equal(kinds(c, 'REJECTION_BLOCK').length, 0)
})

test('inducement (bullish): bait low in a pullback inside an up-trend is wicked through and reclaimed', () => {
  const c = zig([[0, 1.09], [20, 1.1], [28, 1.096], [45, 1.104], [52, 1.1022], [58, 1.103], [66, 1.1035]])
  // bar 58: wick below the bait (the 1.1022 low at bar 52), close back above it
  c[58] = { ...c[58], open: 1.103, low: 1.101, close: 1.1029, high: 1.1031 }
  const ind = kinds(c, 'INDUCEMENT')
  assert.ok(ind.length >= 1, 'no inducement found: ' + JSON.stringify(scanSmc(c)?.signals.map((s) => [s.kind, s.direction, s.index])))
  assert.equal(ind[0].direction, 'bullish')
})

test('no inducement on a clean trend with no pullback sweep', () => {
  const c = zig([[0, 1.09], [66, 1.12]])
  assert.equal(kinds(c, 'INDUCEMENT').length, 0)
})

test('context kinds never change the aggregate: summary counts only non-context active signals', () => {
  const c = zig([[0, 1.09], [20, 1.1], [30, 1.095], [40, 1.1], [50, 1.096], [66, 1.1]])
  const r = scanSmc(c)!
  const act = r.signals.filter((s) => s.active && !TALLY_EXCLUDED.has(s.kind))
  assert.equal(r.summary.bullish, act.filter((s) => s.direction === 'bullish').length)
  assert.equal(r.summary.bearish, act.filter((s) => s.direction === 'bearish').length)
  assert.ok(r.signals.some((s) => s.kind === 'EQH_EQL' && s.active), 'EQH present but excluded')
  const agg = smcNowRead(r)
  assert.ok(!agg.note.includes('EQH_EQL'))
  const any = smcAnyAgrees(r, 'call')
  assert.ok(!any.note.includes('EQH_EQL'))
  // per-kind read still works
  const one = smcNowRead(r, 'EQH_EQL')
  assert.equal(one.direction, 'call')
})

let failed = 0
for (const t of tests) {
  try { t.fn(); console.log('ok  ' + t.name) } catch (e) { failed++; console.log('FAIL ' + t.name + '\n    ' + (e instanceof Error ? e.message.slice(0, 600) : e)) }
}
console.log(failed ? `${failed} FAILED` : `all ${tests.length} passed`)
process.exit(failed ? 1 : 0)
