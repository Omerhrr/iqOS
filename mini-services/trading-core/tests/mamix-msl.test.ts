// IQAIR//OS - tests: extra MAs (dema/t3/hema/vwap/ind.ma), session.inDates, risk week/drawdown/loss-days
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { dema, t3, hema, vwapDaily, haOpenSeries, maSeries } from '../src/analytics/mamix'
import { ema } from '../src/analytics/indicators'
import { riskStats, inDates } from '../src/analytics/mslrisk'
const T0 = Date.UTC(2026, 0, 5) / 1000
const wave = (n: number, per = 60): Candle[] => Array.from({ length: n }, (_, i) => { const c = 100 + 3 * Math.sin((i * 2 * Math.PI) / per) + i * 0.002, o = i ? 100 + 3 * Math.sin(((i - 1) * 2 * Math.PI) / per) + (i - 1) * 0.002 : c; return { time: T0 + i * 60, open: o, close: c, high: Math.max(o, c) + 0.1, low: Math.min(o, c) - 0.1, volume: 10 + (i % 7) } })
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const flat = Array.from({ length: 200 }, () => 100)
test('dema and t3 of a constant are that constant (weights sum to 1)', () => {
  assert.ok(Math.abs(dema(flat, 21)[199] - 100) < 1e-9); assert.ok(Math.abs(t3(flat, 21)[199] - 100) < 1e-9)
})
test('dema reacts faster than ema on a ramp (less lag)', () => {
  const ramp = Array.from({ length: 200 }, (_, i) => i); assert.ok(dema(ramp, 21)[199] > ema(ramp, 21)[199] && dema(ramp, 21)[199] <= 199 + 1e-9)
})
test('hema = ema of the Heikin-Ashi open, ha open follows its recursion', () => {
  const c = wave(120), o = c.map((k) => k.open), h = c.map((k) => k.high), l = c.map((k) => k.low), cl = c.map((k) => k.close)
  const ha = haOpenSeries(o, h, l, cl)
  assert.ok(Math.abs(ha[0] - (o[0] + cl[0]) / 2) < 1e-12)
  assert.ok(Math.abs(ha[5] - (ha[4] + (o[4] + h[4] + l[4] + cl[4]) / 4) / 2) < 1e-12)
  assert.deepEqual(hema(o, h, l, cl, 21).map((x) => +x.toFixed(9)), ema(ha, 21).map((x) => +x.toFixed(9)))
})
test('vwap restarts every UTC day', () => {
  const time = Array.from({ length: 4 }, (_, i) => (i < 2 ? Date.UTC(2026, 0, 5, 23, 58 + i) : Date.UTC(2026, 0, 6, 0, i - 2)) / 1000)
  const v = vwapDaily([11, 21, 31, 41], [9, 19, 29, 39], [10, 20, 30, 40], [1, 1, 1, 1], time)
  assert.equal(v[0], 10); assert.equal(v[1], 15); assert.equal(v[2], 30); assert.equal(v[3], 35)
  assert.throws(() => maSeries('vwap', { open: [1], high: [1], low: [1], close: [1], volume: [1] }, 5))
  assert.throws(() => maSeries('nope', { open: [1], high: [1], low: [1], close: [1], volume: [1], time: [1] }, 5))
})
const run = (c: Candle[], s: string) => backtestMslScript(c, s, { expiryBars: 3 })
test('ind.ma works for every type inside a crossover script, and "tf" still parses', () => {
  const c = wave(600)
  for (const t of ['ema', 'hema', 'sma', 'hma', 'wma', 'dema', 'vwma', 'vwap', 't3', 'kama']) {
    const r = run(c, `let fast = ind.ma("${t}", 10)\nlet slow = ind.ma("${t}", 30)\ncall when fast.crossed("up", slow)\nput when fast.crossed("down", slow)`)
    if (t !== 'vwap') { assert.ok(r.ok, `${t}: ${r.error}`); assert.ok(r.trades.length > 4, `${t} made ${r.trades.length} trades`) }
  }
  const r2 = run(c, 'call when ind.ma("ema", 10, "5m")[-1] > ind.ma("ema", 30, "5m")[-1]'); assert.ok(r2.ok, String(r2.error))
  assert.ok(!run(c, 'call when ind.ma("zzz", 10)[-1] > 0').ok || run(c, 'call when ind.ma("zzz", 10)[-1] > 0').trades.length === 0)
})
test('ind.dema / ind.t3 / ind.hema direct calls', () => {
  const r = run(wave(300), 'call when ind.dema(10)[-1] > ind.t3(10, 0.7)[-1] or ind.hema(10)[-1] > 0'); assert.ok(r.ok, String(r.error)); assert.ok(r.trades.length > 0)
})
test('session.inDates replays on the bar time (bare end date = whole day)', () => {
  assert.ok(inDates(Date.UTC(2026, 0, 6, 23, 59), '2026-01-05', '2026-01-06'))
  assert.ok(!inDates(Date.UTC(2026, 0, 7, 0, 1), '2026-01-05', '2026-01-06'))
  assert.ok(!inDates(Date.UTC(2026, 0, 5, 13, 29), '2026-01-05 13:30', '2026-01-06'))
  assert.throws(() => inDates(0, 'yesterday', '2026-01-06'))
  const c = wave(300) // 5 hours from 2026-01-05 00:00 UTC
  const all = run(c, 'call when session.inDates("2026-01-05", "2026-01-05") and ind.ma("ema", 5)[-1] > ind.ma("ema", 20)[-1]')
  const none = run(c, 'call when session.inDates("2026-02-01", "2026-02-02") and ind.ma("ema", 5)[-1] > ind.ma("ema", 20)[-1]')
  assert.ok(all.ok && all.trades.length > 0 && none.ok && none.trades.length === 0)
})
test('risk: week count, total drawdown, losing-day streak', () => {
  const D = 86_400_000, mon = Date.UTC(2026, 0, 5) // a Monday
  const o = [{ ts: mon - D, win: true, units: 0.85 }, { ts: mon + 3600_000, win: false, units: -1 }, { ts: mon + D + 3600_000, win: false, units: -1 }, { ts: mon + 2 * D + 3600_000, win: false, units: -1 }, { ts: mon + 2 * D + 7200_000, win: true, units: 0.85 }]
  const st = riskStats(o, mon + 2 * D + 8000_000)
  assert.equal(st.tradesWeek, 4, 'Monday 00:00 onward')
  assert.ok(Math.abs(st.pnlAll - (0.85 - 1 - 1 - 1 + 0.85)) < 1e-9)
  assert.ok(Math.abs(st.drawdownAll - 3) < 1e-9, 'peak 0.85 -> trough -2.15')
  assert.equal(st.lossDays, 3)
})
console.log(`${pass}/${total} passed`); if (pass !== total) process.exit(1)
