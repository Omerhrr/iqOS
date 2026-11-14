// IQAIR//OS - tests for the MSL `smcx.*` namespace (equal highs/lows, rejection blocks, inducement as candle-derived primitives).
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { readSmcx } from '../src/analytics/mslsmcx'

const tests: [string, () => void][] = []
const test = (n: string, f: () => void) => tests.push([n, f])
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
const eqh = () => zig([[0, 1.09], [20, 1.1], [30, 1.095], [40, 1.1], [50, 1.096], [66, 1.1]])
const rejBear = () => { const c = zig([[0, 1.09], [30, 1.1], [45, 1.094], [66, 1.0935]]); c[30] = { ...c[30], open: 1.1, close: 1.0999, high: 1.101, low: 1.0997 }; return c }
const plain = () => zig([[0, 1.09], [30, 1.1], [45, 1.094], [66, 1.099]])
const idm = () => { const c = zig([[0, 1.09], [20, 1.1], [28, 1.096], [45, 1.104], [52, 1.1022], [58, 1.103], [66, 1.1035]]); c[58] = { ...c[58], open: 1.103, low: 1.101, close: 1.1029, high: 1.1031 }; return c }
const clean = () => zig([[0, 1.09], [66, 1.12]])
/** number of signalled bars among the last 2 evaluated bars (warmup = len - 3) */
const fires = (c: Candle[], line: string, side: 'call' | 'put' = 'call') => {
  const res = backtestMslScript(c, `${side} when ${line}`, { expiryBars: 1, warmupBars: c.length - 3 })
  assert.equal(res.ok, true, (res as { error?: string }).error)
  return res.trades.length
}

test('readSmcx reads the equal-highs pool: level, touches, small ATR distance', () => {
  const r = readSmcx(eqh())!
  assert.ok(r.eqh)
  assert.equal(r.eqh!.touches, 2)
  assert.ok(r.eqh!.distAtr < 1)
  assert.equal(r.eql, null)
})
test('readSmcx: too few bars -> null', () => { assert.equal(readSmcx(eqh().slice(0, 30)), null) })
test('smcx.eqhNear fires on the equal-highs fixture and not on a plain zig-zag with unequal highs', () => {
  assert.ok(fires(eqh(), 'smcx.eqhNear()') > 0)
  assert.equal(fires(zig([[0, 1.09], [20, 1.1], [30, 1.095], [40, 1.103], [50, 1.096], [66, 1.1]]), 'smcx.eqhNear()'), 0)
})
test('smcx.eqhTouches / eqhDist are numbers usable in comparisons', () => {
  assert.ok(fires(eqh(), 'smcx.eqhTouches() == 2 and smcx.eqhDist() < 1') > 0)
  assert.equal(fires(plain(), 'smcx.eqhTouches() >= 1'), 0)
})
test('smcx.rejBear fires on the long-wick fixture, not on a plain zig-zag', () => {
  assert.ok(fires(rejBear(), 'smcx.rejBear()', 'put') > 0)
  assert.equal(fires(plain(), 'smcx.rejBear()', 'put'), 0)
})
test('smcx.rejAgo takes a string direction and reports bars since the block', () => {
  assert.ok(fires(rejBear(), 'smcx.rejAgo("bear") <= 40 and smcx.rejAgo("bear") >= 20', 'put') > 0)
  assert.ok(fires(plain(), 'smcx.rejAgo("bear") == 99', 'put') > 0)
})
test('smcx.idmBull(10) fires after the inducement take, not on a clean trend', () => {
  assert.ok(fires(idm(), 'smcx.idmBull(10)') > 0)
  assert.equal(fires(clean(), 'smcx.idmBull(10)'), 0)
  assert.equal(fires(clean(), 'smcx.idmBear(10)', 'put'), 0)
})
test('smcx.idmAgo reports a bar count for the take', () => {
  assert.ok(fires(idm(), 'smcx.idmAgo("bull") <= 10') > 0)
})
test('the namespace works inside a backtest (not "unavailable") and mixes with other namespaces', () => {
  const c = eqh()
  const res = backtestMslScript(c, 'call when smcx.ok() and smcx.eqhNear() and signal.ok()\nconfidence = 55', { expiryBars: 1, warmupBars: c.length - 3 })
  assert.equal(res.ok, true)
  assert.ok(res.trades.length >= 0)
})
test('context kinds still do not move the aggregate smc source (it reads none in a backtest, smcx does not)', () => {
  assert.equal(fires(eqh(), 'smc:EQH_EQL.dir == "call"'), 0)
  assert.ok(fires(eqh(), 'smcx.eqhNear()') > 0)
})
test('a wrong direction word is a runtime error, a wrong method is a runtime error', () => {
  const c = eqh()
  const bad = backtestMslScript(c, 'call when smcx.rejAgo("up") < 5', { expiryBars: 1, warmupBars: c.length - 3 })
  assert.equal(bad.trades.length, 0)
  const unk = backtestMslScript(c, 'call when smcx.nonsense()', { expiryBars: 1, warmupBars: c.length - 3 })
  assert.equal(unk.trades.length, 0)
})
test('script with smcx parses', () => { assert.equal((parseStrategyScript as any)('call when smcx.eqhNear(0.5) and smcx.rejBullIn()\nconfidence = 55').ok, true) })

let fail = 0
for (const [n, f] of tests) { try { f(); console.log('ok  ' + n) } catch (e) { fail++; console.log('FAIL ' + n + '\n    ' + (e as Error).message.slice(0, 500)) } }
console.log(fail ? fail + ' FAILED' : 'all ' + tests.length + ' passed')
process.exit(fail ? 1 : 0)
