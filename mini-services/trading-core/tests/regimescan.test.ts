// IQAIR//OS - tests for analytics/regimescan.ts (classifier) and the board ranking.
//   npx tsx tests/regimescan.test.ts      (from mini-services/trading-core)
import assert from 'node:assert/strict'
import { classifyRegimeRow, MIN_BARS } from '../src/analytics/regimescan'
import type { Candle } from '../src/types'

type Test = { name: string; fn: () => void }
const tests: Test[] = []
const test = (name: string, fn: () => void) => tests.push({ name, fn })

function rng(seed: number) {
  let s = seed
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
  const gauss = () => {
    let u = 0
    let v = 0
    while (!u) u = rnd()
    while (!v) v = rnd()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  return gauss
}

function gen(g: () => number, f: (i: number) => number, noise: number, n = 120): Candle[] {
  const out: Candle[] = []
  let prev = f(0)
  for (let i = 0; i < n; i++) {
    const c = f(i) + g() * noise
    const o = prev
    prev = c
    out.push({ time: i * 60, open: o, high: Math.max(o, c) + Math.abs(g()) * noise * 0.3, low: Math.min(o, c) - Math.abs(g()) * noise * 0.3, close: c, volume: 10 } as Candle)
  }
  return out
}

function walk(g: () => number, n = 120): Candle[] {
  const out: Candle[] = []
  let p = 100
  for (let i = 0; i < n; i++) {
    const o = p
    p += g() * 0.1
    out.push({ time: i * 60, open: o, high: Math.max(o, p) + Math.abs(g()) * 0.03, low: Math.min(o, p) - Math.abs(g()) * 0.03, close: p, volume: 10 } as Candle)
  }
  return out
}

test('too little history is not classified', () => {
  const g = rng(1)
  assert.equal(classifyRegimeRow(walk(g, MIN_BARS - 1)), null)
})

test('a clear up-drift reads trend-up, a clear down-drift trend-down', () => {
  const g = rng(2)
  let up = 0
  let down = 0
  for (let k = 0; k < 100; k++) {
    if (classifyRegimeRow(gen(g, (i) => 100 + i * 0.05, 0.1))?.regime === 'trend-up') up++
    if (classifyRegimeRow(gen(g, (i) => 100 - i * 0.05, 0.1))?.regime === 'trend-down') down++
  }
  assert.ok(up >= 50, `trend-up detected ${up}/100`)
  assert.ok(down >= 50, `trend-down detected ${down}/100`)
})

test('an up-drift never reads trend-down (direction is the sign of the net move)', () => {
  const g = rng(3)
  for (let k = 0; k < 100; k++) assert.notEqual(classifyRegimeRow(gen(g, (i) => 100 + i * 0.05, 0.1))?.regime, 'trend-down')
})

test('a fast oscillation inside a box reads ranging', () => {
  const g = rng(4)
  let r = 0
  for (let k = 0; k < 100; k++) if (classifyRegimeRow(gen(g, (i) => 100 + Math.sin(i / 2.5) * 0.6, 0.05))?.regime === 'ranging') r++
  assert.ok(r >= 90, `ranging detected ${r}/100`)
})

test('NULL: a pure random walk is rarely called trending (<= 8%)', () => {
  const g = rng(5)
  let t = 0
  const N = 600
  for (let k = 0; k < N; k++) {
    const x = classifyRegimeRow(walk(g))?.regime
    if (x === 'trend-up' || x === 'trend-down') t++
  }
  assert.ok(t / N <= 0.08, `random walk labelled trending ${((t / N) * 100).toFixed(1)}%`)
})

test('NULL: random walks are not trending-biased toward one direction', () => {
  const g = rng(6)
  let up = 0
  let dn = 0
  for (let k = 0; k < 800; k++) {
    const x = classifyRegimeRow(walk(g))?.regime
    if (x === 'trend-up') up++
    if (x === 'trend-down') dn++
  }
  assert.ok(Math.abs(up - dn) <= 25, `up ${up} vs down ${dn}`)
})

test('every row carries a plain-language reason and a 0-100 score', () => {
  const g = rng(7)
  for (let k = 0; k < 50; k++) {
    const r = classifyRegimeRow(walk(g))!
    assert.ok(r.reason.length > 10)
    assert.ok(r.score >= 0 && r.score <= 100)
    assert.ok(r.position >= 0 && r.position <= 1)
  }
})

test('a flat zero-range series is noise, never a crash', () => {
  const flat: Candle[] = Array.from({ length: 80 }, (_, i) => ({ time: i * 60, open: 1, high: 1, low: 1, close: 1, volume: 0 }) as Candle)
  const r = classifyRegimeRow(flat)!
  assert.equal(r.regime, 'noise')
})

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    t.fn()
    passed++
    console.log(`  ok - ${t.name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL - ${t.name}\n    ${err instanceof Error ? err.message : err}`)
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
if (failed > 0) process.exit(1)
