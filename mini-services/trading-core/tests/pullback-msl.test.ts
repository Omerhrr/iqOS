// IQAIR//OS - tests: pb.* (analytics/pullback.ts)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { readPullback } from '../src/analytics/pullback'
const T0 = 1_700_000_000
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
let t = 0
const bar = (o: number, c: number, w = 0.05): Candle => ({ time: T0 + t++ * 60, open: o, close: c, high: Math.max(o, c) + w, low: Math.min(o, c) - w, volume: 1 })
/** noise, a clean up leg of `up`, then a pullback of `frac` of it (optionally resuming) */
function scene(frac: number, resume: boolean): Candle[] {
  t = 0
  const r = rng(5), out: Candle[] = []
  let x = 100
  for (let i = 0; i < 80; i++) { const o = x; x += (r() - 0.5) * 0.3; x = Math.min(100.5, Math.max(99.5, x)); out.push(bar(o, x)) }
  const start = x
  for (let i = 0; i < 12; i++) { const o = x; x += 0.5; out.push(bar(o, x, 0.03)) }
  const top = x, leg = top - start
  const target = top - frac * leg
  const steps = 6
  for (let i = 0; i < steps; i++) { const o = x; x -= (top - target) / steps; out.push(bar(o, x, 0.03)) }
  if (resume) { const o = x; x += 0.7; const b = bar(o, x, 0.03); out.push(b) }
  return out
}
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
test('normal pullback of a clean up leg is measured', () => {
  const r = readPullback(scene(0.5, false))
  assert.equal(r.state, 'pullback'); assert.equal(r.side, 1)
  assert.ok(Math.abs(r.depth - 0.5) < 0.15, `depth ${r.depth}`)
  assert.equal(r.kind, 'normal'); assert.equal(r.fib, true)
})
test('shallow vs deep vs failed classification', () => {
  assert.equal(readPullback(scene(0.25, false)).kind, 'shallow')
  assert.equal(readPullback(scene(0.7, false)).kind, 'deep')
  const f = readPullback(scene(0.9, false))
  assert.ok(f.kind === 'failed' || f.kind === 'deep')
})
test('resume bar flips resumed/ready on', () => {
  const a = readPullback(scene(0.45, false)), b = readPullback(scene(0.45, true))
  assert.equal(a.resumed, false)
  assert.equal(b.state, 'pullback', JSON.stringify(b))
  assert.equal(b.resumed, true, JSON.stringify(b)); assert.equal(b.ready, true)
})
test('mirror: a rally inside a down-trend reads side -1', () => {
  const up = scene(0.5, false)
  const mid = up[0].close
  const dn = up.map((k, i) => ({ ...k, open: 2 * mid - k.open, close: 2 * mid - k.close, high: 2 * mid - k.low, low: 2 * mid - k.high, time: T0 + i * 60 }))
  const r = readPullback(dn)
  assert.equal(r.state, 'pullback'); assert.equal(r.side, -1)
})
test('still impulsing is not a pullback; thin history fails closed', () => {
  const r = readPullback(scene(0.0, false).slice(0, 90))
  assert.notEqual(r.state, 'pullback')
  assert.equal(readPullback(scene(0.5, false).slice(0, 30)).ok, false)
})
test('scripts parse and backtest runs', () => {
  const sc = 'if pb.ok() and pb.active() and pb.side() == 1 and pb.ready() and pb.types() >= 1\n  call when true\nelseif pb.ok() and pb.active() and pb.side() == -1 and pb.ready() and pb.types() >= 1\n  put when true\nend'
  assert.equal(parseStrategyScript(sc).ok, true)
  assert.equal(parseStrategyScript('if pb.kind() == "normal" and pb.ema()\n  call when true\nend').ok, true)
  const r = backtestMslScript(scene(0.5, true).concat(scene(0.4, true).map((k, i) => ({ ...k, time: T0 + (200 + i) * 60 }))), sc, { expiryBars: 2, warmupBars: 60 })
  assert.ok(r.trades.length >= 0)
})
console.log(`${pass}/${total}`)
if (pass !== total) process.exit(1)
