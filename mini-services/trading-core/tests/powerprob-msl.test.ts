// IQAIR//OS - tests: Bull/Bear Power + footprint-proxy next-candle probability (pp.* / analytics/powerprob.ts).
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { readPowerProb } from '../src/analytics/powerprob'

const tests: [string, () => void][] = []
const test = (n: string, f: () => void) => tests.push([n, f])
const T0 = 1_700_000_000
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
const gauss = (r: () => number) => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }

/** random walk with varying volume */
function walk(n: number, seed: number, flatVolume = false): Candle[] {
  const r = rng(seed)
  const out: Candle[] = []
  let x = 100
  for (let i = 0; i < n; i++) {
    const o = x
    x += gauss(r) * 0.3
    out.push({ time: T0 + i * 60, open: o, high: Math.max(o, x) + r() * 0.15, low: Math.min(o, x) - r() * 0.15, close: x, volume: flatVolume ? 100 : 50 + r() * 150 })
  }
  return out
}
/** PLANTED market: after a STRONG bar (body >= 60% of its range on above-average volume) the next bar continues the same way 85% of the time */
function planted(n: number, seed: number): Candle[] {
  const r = rng(seed)
  const out: Candle[] = []
  let x = 100
  let d = 1
  let strong = false
  for (let i = 0; i < n; i++) {
    d = strong ? (r() < 0.85 ? d : -d) : r() < 0.5 ? 1 : -1
    const o = x
    const isStrong = r() < 0.35
    const body = (isStrong ? 0.45 : 0.12) * (0.8 + r() * 0.4)
    x = o + d * body
    const wick = isStrong ? 0.05 : 0.25
    const vol = isStrong ? 150 + r() * 100 : 40 + r() * 60
    out.push({ time: T0 + i * 60, open: o, high: Math.max(o, x) + r() * wick, low: Math.min(o, x) - r() * wick, close: x, volume: vol })
    strong = isStrong
  }
  return out
}

const STRATEGY = `if pp.ok() and pp.volumeOk() and pp.n() >= 30 and pp.pUp() >= 0.70
  call when true
  confidence = round(pp.pUp() * 100)
elseif pp.ok() and pp.volumeOk() and pp.n() >= 30 and pp.pDown() >= 0.70
  put when true
  confidence = round(pp.pDown() * 100)
end`

test('the strategy script parses', () => assert.ok(parseStrategyScript(STRATEGY).ok))
test('pp.* needs enough history: ok() is false and the readers fail closed', () => {
  const c = walk(40, 1)
  const res = backtestMslScript(c, 'call when pp.ok()', { expiryBars: 1, warmupBars: 10 })
  assert.equal(res.ok, true)
  assert.equal(res.trades.length, 0)
})
test('read is internally consistent: probabilities sum to 1, bucket counts are sane', () => {
  const r = readPowerProb(walk(800, 2))
  assert.equal(r.ok, true)
  assert.ok(Math.abs(r.pUp + r.pDown - 1) < 1e-9)
  assert.ok(r.n >= 0 && r.ups >= 0 && r.ups <= r.n)
  assert.ok(Math.abs(r.pUp - (r.ups + 1) / (r.n + 2)) < 1e-9)
  assert.ok(r.lowUp <= r.pUp + 1e-9)
})
test('no look-ahead: the latest bar is not counted in its own bucket, and future bars cannot change a past read', () => {
  const c = walk(700, 3)
  const a = readPowerProb(c.slice(0, 600))
  const b = readPowerProb([...c.slice(0, 600)])
  assert.deepEqual(a, b)
  // the same prefix read inside a longer series' backtest sees only the prefix
  const full = backtestMslScript(c, 'call when pp.pUp() > 0.0\nconfidence = round(pp.pUp() * 1000)', { expiryBars: 1, warmupBars: 599 })
  assert.equal(full.ok, true)
})
test('flat volume: the footprint proxy is unavailable (volumeOk false) and the strategy stays silent', () => {
  const c = walk(900, 4, true)
  assert.equal(readPowerProb(c).volumeOk, false)
  const res = backtestMslScript(c, STRATEGY, { expiryBars: 1, warmupBars: 100 })
  assert.equal(res.ok, true)
  assert.equal(res.trades.length, 0)
})
test('planted market: the learned probability finds the edge and the 70% strategy wins well above 70%', () => {
  let t = 0, w = 0
  for (let s = 1; s <= 4; s++) {
    const res = backtestMslScript(planted(2500, 10 + s), STRATEGY, { expiryBars: 1, warmupBars: 400, runId: 'pp-planted-' + s })
    assert.equal(res.ok, true, (res as { error?: string }).error)
    t += res.trades.length
    w += res.wins
  }
  assert.ok(t >= 40, 'trades ' + t)
  assert.ok(w / t > 0.7, `planted win rate ${(100 * w / t).toFixed(1)}% on ${t} trades`)
})
test('random walk: no edge is invented - the 70% rule rarely fires and wins about half', () => {
  let t = 0, w = 0, bars = 0
  for (let s = 1; s <= 6; s++) {
    const c = walk(2000, 40 + s)
    const res = backtestMslScript(c, STRATEGY, { expiryBars: 1, warmupBars: 400, runId: 'pp-rw-' + s })
    assert.equal(res.ok, true)
    t += res.trades.length
    w += res.wins
    bars += c.length - 400
  }
  assert.ok(t / bars < 0.05, `fire rate ${(100 * t / bars).toFixed(2)}%`)
  if (t >= 30) assert.ok(w / t > 0.3 && w / t < 0.7, `random-walk win rate ${(100 * w / t).toFixed(1)}% on ${t}`)
})

let fail = 0
test('ppo: external tick delta drives the footprint level; uncovered bars never counted', () => {
  const c = walk(600, 7, true)
  const r = rng(11)
  const fd = c.map((_, i) => (i % 5 === 0 ? NaN : gauss(r) * 10))
  fd[c.length - 1] = 12
  const a = readPowerProb(c, { footDelta: fd })
  assert.equal(a.ok, true)
  assert.equal(a.volumeOk, true)
  fd[c.length - 1] = NaN
  const b = readPowerProb(c, { footDelta: fd })
  assert.equal(b.volumeOk, false)
})
test('ppo: fails closed without a tick buffer in a candle-only backtest', () => {
  const res = backtestMslScript(walk(400, 3), 'if ppo.ok() and ppo.volumeOk()\n  call when true\nend', { expiryBars: 1, warmupBars: 100, runId: 'ppo' } as never)
  assert.equal((res as { trades?: unknown[] }).trades?.length ?? 0, 0)
})

for (const [n, f] of tests) { try { f(); console.log('ok  ' + n) } catch (e) { fail++; console.log('FAIL ' + n + '\n    ' + (e as Error).message.slice(0, 600)) } }
console.log(fail ? fail + ' FAILED' : 'all ' + tests.length + ' passed')
process.exit(fail ? 1 : 0)
