// IQAIR//OS - tests: timing.* (analytics/timing.ts) - hold-and-confirm window + clock reads
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { evaluateStrategyScript, parseStrategyScript, clearMslState, type MslSeriesCtx } from '../src/analytics/strategylang'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { stepHold } from '../src/analytics/timing'

const T0 = 1_700_000_040 // aligned to a minute
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
function bars(n: number): Candle[] {
  const r = rng(9), out: Candle[] = []
  let x = 100
  for (let i = 0; i < n; i++) { const o = x; x += (r() - 0.5) * 0.4; out.push({ time: T0 + i * 60, open: o, close: x, high: Math.max(o, x) + 0.05, low: Math.min(o, x) - 0.05, volume: 1 }) }
  return out
}
const C = bars(80)
const series: MslSeriesCtx = { open: C.map((c) => c.open), high: C.map((c) => c.high), low: C.map((c) => c.low), close: C.map((c) => c.close), volume: C.map((c) => c.volume), time: C.map((c) => c.time) }
const lastClose = C[C.length - 1].close
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }

const SCRIPT = `let setup = true
let go = timing.hold("t1", setup, 1, 20, 0.05)
if go == 1
  call when true
  confidence = 80
end`
const parsed = parseStrategyScript(SCRIPT)
const run = (script: typeof parsed, nowMs: number, price: number, prefix = 'tm') => {
  if (!script.ok) throw new Error('parse')
  return evaluateStrategyScript(script.ast, {}, undefined, series, undefined, { nowMs, ticks: [{ ts: nowMs, price }] }, { keyPrefix: prefix, barTimeSec: C[C.length - 1].time })
}
const ATR = (() => { let s = 0; for (let i = C.length - 14; i < C.length; i++) s += Math.max(C[i].high - C[i].low, Math.abs(C[i].high - C[i - 1].close), Math.abs(C[i].low - C[i - 1].close)); return s / 14 })()

test('script parses', () => assert.equal(parsed.ok, true))
test('arms, waits, then confirms once when price moved with the call', () => {
  clearMslState('tm')
  const t0 = 1_800_000_000_000
  assert.equal(run(parsed, t0, lastClose).direction, 'none')                     // armed
  assert.equal(run(parsed, t0 + 10_000, lastClose + 0.2 * ATR).direction, 'none') // still waiting
  const r = run(parsed, t0 + 21_000, lastClose + 0.3 * ATR)
  assert.equal(r.direction, 'call'); assert.equal(r.confidence, 80)
})
test('aborts early when price goes against the call (does not wait out the clock)', () => {
  clearMslState('tm')
  const t0 = 1_800_000_100_000
  run(parsed, t0, lastClose)
  run(parsed, t0 + 5_000, lastClose - 0.5 * ATR)
  assert.equal(run(parsed, t0 + 25_000, lastClose + 0.5 * ATR).direction, 'none') // already aborted + latched
})
test('aborts when price went nowhere', () => {
  clearMslState('tm')
  const t0 = 1_800_000_200_000
  run(parsed, t0, lastClose)
  assert.equal(run(parsed, t0 + 21_000, lastClose + 0.01 * ATR).direction, 'none')
})
test('latched: a lingering condition does not re-arm after a result', () => {
  const key = 'lat'
  const base = { key, cond: true, dir: 1, seconds: 20, minAtr: 0.05, abortAtr: 0.3, price: 100, atr: 1 }
  let t = 5_000_000
  stepHold({ ...base, nowMs: t }) // arm
  stepHold({ ...base, nowMs: t + 21_000, price: 100.5 }) // confirm
  t += 30_000
  const a = stepHold({ ...base, nowMs: t })
  const b = stepHold({ ...base, nowMs: t + 25_000, price: 101 })
  assert.equal(a.fire || b.fire, false)
  stepHold({ ...base, nowMs: t + 26_000, cond: false }) // clears the latch
  stepHold({ ...base, nowMs: t + 27_000 }) // re-arms
  assert.equal(stepHold({ ...base, nowMs: t + 50_000, price: 100.6 }).fire, true)
})
test('condition disappearing aborts the wait', () => {
  const base = { key: 'gone', cond: true, dir: -1, seconds: 20, minAtr: 0.05, abortAtr: 0.3, price: 100, atr: 1 }
  stepHold({ ...base, nowMs: 9_000_000 })
  const r = stepHold({ ...base, nowMs: 9_005_000, cond: false })
  assert.equal(r.rec.state, 'aborted'); assert.match(r.rec.why, /analysis gone/)
})
test('put direction counts a falling price as confirmation', () => {
  const base = { key: 'put', cond: true, dir: -1, seconds: 20, minAtr: 0.05, abortAtr: 0.3, price: 100, atr: 1 }
  stepHold({ ...base, nowMs: 1_000_000 })
  assert.equal(stepHold({ ...base, nowMs: 1_021_000, price: 99.8 }).fire, true)
})
test('state reads and bar clock', () => {
  clearMslState('tm2')
  const sc = parseStrategyScript('let g = timing.hold("t9", true, "call", 30)\nif timing.state("t9") == "waiting" and timing.barLeft() >= 0 and timing.barAge() >= 0\n  call when true\nend')
  assert.equal(sc.ok, true)
  const t0 = 1_800_000_300_000
  run(sc, t0, lastClose, 'tm2')
  const r = run(sc, t0 + 4_000, lastClose, 'tm2')
  assert.equal(r.direction, 'call', r.error ?? '')
})
test('bad usage fails with a clear error', () => {
  const bad = parseStrategyScript('let g = timing.hold("t", true, 0, 20)\nif g == 1\n  call when true\nend')
  assert.equal(bad.ok, true)
  const r = run(bad, 1_800_000_400_000, lastClose, 'tm3')
  assert.ok(r.error && /dir/.test(r.error), r.error)
})
test('hold is live-only: a backtest never trades on it, the bar clock still replays', () => {
  const r = backtestMslScript(bars(200), SCRIPT, { expiryBars: 1, warmupBars: 60 })
  assert.equal(r.trades.length, 0)
  const r2 = backtestMslScript(bars(200), 'if timing.second() == 0 and timing.barLeft() <= 60\n  call when true\nend', { expiryBars: 1, warmupBars: 60 })
  assert.ok(r2.trades.length > 0)
})
console.log(`${pass}/${total}`)
if (pass !== total) process.exit(1)
