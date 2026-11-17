// IQAIR//OS - tests: replayMslScript (5s replay tester), timing.hold replay + bypass, risk.*, session.*
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript, replayMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { riskStats, sessionAt, inWindow, weekendAt } from '../src/analytics/mslrisk'

const T0 = 1_700_000_040 // 2023-11-14 22:14:00 UTC
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
function feed(n: number, drift: number, seed = 4): Candle[] {
  const r = rng(seed), out: Candle[] = []
  let x = 100
  for (let i = 0; i < n; i++) { const o = x; x += drift + (r() - 0.5) * 0.01; out.push({ time: T0 + i * 5, open: o, close: x, high: Math.max(o, x) + 0.003, low: Math.min(o, x) - 0.003, volume: 1 }) }
  return out
}
function agg(c: Candle[], sec: number): Candle[] {
  const out: Candle[] = []
  for (const k of c) { const st = Math.floor(k.time / sec) * sec, l = out[out.length - 1]; if (l && l.time === st) { l.high = Math.max(l.high, k.high); l.low = Math.min(l.low, k.low); l.close = k.close; l.volume += k.volume } else out.push({ ...k, time: st }) }
  return out
}
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const HOLD = 'let setup = timing.second() < 30\nlet go = timing.hold("t", setup, 1, 20, 0.05)\nif go == 1\n  call when true\nend'
const UP = feed(1500, 0.02), DOWN = feed(1500, -0.02)

test('replay on a rising feed: the hold confirms and the calls win', () => {
  const r = replayMslScript(agg(UP, 60), UP, HOLD, { expirySec: 60, warmupBars: 40 })
  assert.ok(r.ok, r.error)
  assert.ok(r.trades.length > 5, `trades ${r.trades.length}`)
  assert.equal(r.wins, r.trades.length)
})
test('replay on a falling feed: the hold aborts, no trades', () => {
  const r = replayMslScript(agg(DOWN, 60), DOWN, HOLD, { expirySec: 60, warmupBars: 40 })
  assert.ok(r.ok, r.error)
  assert.equal(r.trades.length, 0)
})
test('holdBypass acts at arm time: on the falling feed it trades and loses (the wait protected us)', () => {
  const r = replayMslScript(agg(DOWN, 60), DOWN, HOLD, { expirySec: 60, warmupBars: 40, holdBypass: true })
  assert.ok(r.ok, r.error)
  assert.ok(r.trades.length > 5)
  assert.equal(r.wins, 0)
})
test('risk.losses() caps the number of consecutive losers', () => {
  const sc = 'if risk.losses() < 2 and timing.second() < 10\n  call when true\nend'
  const r = replayMslScript(agg(DOWN, 60), DOWN, sc, { expirySec: 60, warmupBars: 40 })
  assert.ok(r.ok, r.error)
  assert.equal(r.trades.length, 2, `trades ${r.trades.length}`)
})
test('risk stats: streaks, today P&L, drawdown, no look-ahead', () => {
  const now = Date.UTC(2026, 0, 5, 12, 0, 0)
  const o = [true, true, false, false, false].map((w, i) => ({ ts: now - (5 - i) * 60_000, win: w, units: w ? 0.85 : -1 }))
  const s = riskStats([...o, { ts: now + 60_000, win: true, units: 0.85 }], now)
  assert.equal(s.losses, 3); assert.equal(s.wins, 0); assert.equal(s.trades, 5)
  assert.ok(Math.abs(s.todayPnl - (1.7 - 3)) < 1e-9)
  assert.ok(Math.abs(s.drawdown - 3) < 1e-9)
  assert.equal(s.last(4).wins, 1)
})
test('risk.* throws in the candle backtester (no trade clock)', () => {
  const r = backtestMslScript(agg(UP, 60), 'if risk.losses() < 2\n  call when true\nend', { expiryBars: 1, warmupBars: 40 })
  assert.equal(r.trades.length, 0)
})
test('session classification and windows', () => {
  assert.equal(sessionAt(Date.UTC(2026, 0, 6, 13, 0)).name, 'overlap')
  assert.equal(sessionAt(Date.UTC(2026, 0, 6, 3, 0)).name, 'asia')
  assert.equal(sessionAt(Date.UTC(2026, 0, 6, 9, 0)).name, 'london')
  assert.equal(sessionAt(Date.UTC(2026, 0, 6, 18, 0)).name, 'ny')
  assert.equal(sessionAt(Date.UTC(2026, 0, 6, 22, 0)).name, 'dead')
  assert.equal(inWindow(Date.UTC(2026, 0, 6, 23, 30), '22:00', '02:00'), true)
  assert.equal(inWindow(Date.UTC(2026, 0, 6, 12, 0), '22:00', '02:00'), false)
  assert.equal(weekendAt(Date.UTC(2026, 0, 3, 12, 0)), true)
})
test('session scripts parse and the clock reads replay in a candle backtest', () => {
  assert.equal(parseStrategyScript('if session.overlap() and not session.weekend() and session.minsIn("ny") > 30\n  call when true\nend').ok, true)
  const r = backtestMslScript(agg(UP, 60), 'if session.name() == "dead"\n  call when true\nend', { expiryBars: 1, warmupBars: 40 })
  assert.ok(r.trades.length > 0)
  const r2 = backtestMslScript(agg(UP, 60), 'if session.london()\n  call when true\nend', { expiryBars: 1, warmupBars: 40 })
  assert.equal(r2.trades.length, 0)
})
test('thin or missing fast data fails closed', () => {
  assert.equal(replayMslScript(agg(UP, 60), UP.slice(0, 100), HOLD).ok, false)
})
console.log(`${pass}/${total}`)
if (pass !== total) process.exit(1)
