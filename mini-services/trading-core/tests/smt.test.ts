import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { smtDivergence } from '../src/analytics/smt'

const t0 = 1_700_000_000
let seed = 7
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5)
function series(closes: number[], pad = 0.0002): Candle[] {
  return closes.map((c, i) => ({ time: t0 + i * 60, open: i ? closes[i - 1] : c, high: c + pad, low: c - pad, close: c, volume: 1 }))
}
/** a shared random driver, partner = driver*beta + small noise, so the pair really co-moves */
function pair(n: number, beta = 1): [number[], number[]] {
  const a: number[] = [1.1]
  const b: number[] = [1.3]
  for (let i = 1; i < n; i++) { const d = rnd() * 0.0008; a.push(a[i - 1] + d); b.push(b[i - 1] + d * beta + rnd() * 0.00005) }
  return [a, b]
}
const tests: [string, () => void][] = []
const test = (n: string, f: () => void) => tests.push([n, f])

test('both make a new high together: no divergence', () => {
  const [a, b] = pair(80)
  for (let i = 70; i < 80; i++) { a[i] = a[69] + (i - 69) * 0.002; b[i] = b[69] + (i - 69) * 0.002 }
  const r = smtDivergence(series(a), series(b))
  assert.equal(r.ok, true)
  assert.equal(r.direction, 'none')
})
test('A makes a new high, B does not: bearish SMT, A leads, B lags', () => {
  const [a, b] = pair(80)
  for (let i = 0; i < 80; i++) { b[i] = b[i] }
  // A spikes to a fresh high in the last 8 bars; B drifts a bit but stays below its earlier peak
  const midB = b.slice(0, 72).reduce((x, y) => x + y, 0) / 72
  for (let i = 72; i < 80; i++) { a[i] = Math.max(...a.slice(0, 72)) + 0.004; b[i] = b[71] }
  // keep correlation high by adding the same small steps to both before the window
  const r = smtDivergence(series(a), series(b))
  if (!r.ok) { console.log('   (corr gate)', r.reason) }
  assert.ok(r.ok, r.reason)
  assert.equal(r.direction, 'bearish')
  assert.equal(r.leader, 'a')
  assert.equal(r.laggard, 'b')
})
test('B makes a lower low, A holds: bullish SMT, B leads', () => {
  const [a, b] = pair(80)
  const midA = a.slice(0, 72).reduce((x, y) => x + y, 0) / 72
  for (let i = 72; i < 80; i++) { a[i] = a[71]; b[i] = Math.min(...b.slice(0, 72)) - 0.004 }
  const r = smtDivergence(series(a), series(b))
  assert.ok(r.ok, r.reason)
  assert.equal(r.direction, 'bullish')
  assert.equal(r.leader, 'b')
})
test('uncorrelated pair is refused, not read', () => {
  const a: number[] = [1.1], b: number[] = [1.3]
  for (let i = 1; i < 120; i++) { a.push(a[i - 1] + rnd() * 0.0008); b.push(b[i - 1] + rnd() * 0.0008) }
  const r = smtDivergence(series(a), series(b))
  assert.equal(r.ok, false)
  assert.match(r.reason ?? '', /correlation/)
})
test('too few aligned bars is refused', () => {
  const [a, b] = pair(20)
  assert.equal(smtDivergence(series(a), series(b)).ok, false)
})
test('inverse pair: mirrored partner is read correctly', () => {
  const [a, b0] = pair(80)
  const b = b0.map((x) => 2.6 - x) // perfectly inverse
  const plain = smtDivergence(series(a), series(b))
  assert.equal(plain.ok, false)
  const inv = smtDivergence(series(a), series(b), { inverse: true })
  assert.equal(inv.ok, true)
})
test('timestamps are aligned, extra bars on one side ignored', () => {
  const [a, b] = pair(90)
  const ca = series(a)
  const cb = series(b).slice(10)
  const r = smtDivergence(ca, cb)
  assert.equal(r.bars, 80)
})
let fail = 0
for (const [n, f] of tests) { try { f(); console.log('ok  ' + n) } catch (e) { fail++; console.log('FAIL ' + n + '\n    ' + (e as Error).message.slice(0, 400)) } }
console.log(fail ? fail + ' FAILED' : 'all ' + tests.length + ' passed')
process.exit(fail ? 1 : 0)
