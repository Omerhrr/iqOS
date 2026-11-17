// IQAIR//OS - tests: managed-trade backtest (stop / target / trail / breakeven / partial / multi / hold-until)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslManaged } from '../src/analytics/mslbacktest'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
// bars given as [open, high, low, close]; first 8 flat bars at 100 as warmup
const bars = (rows: number[][]): Candle[] => [...Array.from({ length: 8 }, () => [100, 100.5, 99.5, 100]), ...rows].map((r, i) => ({ time: 1_700_000_040 + i * 60, open: r[0], high: r[1], low: r[2], close: r[3], volume: 1 }))
const O = { warmupBars: 5, maxBars: 50 }
// enter exactly once, on the first evaluated bar after warmup: a persistent flag
const ONCE = 'var done = 0\nlet go = done == 0\ndone = 1\n'
test('stop-loss: long stopped out at the stop price, R = -1', () => {
  const c = bars([[100, 101, 99.8, 100.5], [100.5, 100.6, 97, 98], [98, 99, 97, 98]])
  const r = backtestMslManaged(c, ONCE + 'pos.stop = pos.entry - 2\ncall when go', O); assert.ok(r.ok, r.error)
  assert.equal(r.trades.length, 1); const t = r.trades[0]
  assert.equal(t.reason, 'stop'); assert.ok(Math.abs(t.exit - (t.entry - 2)) < 1e-9, `${t.exit}`); assert.ok(Math.abs(t.r! + 1) < 1e-9); assert.equal(t.win, false)
})
test('take-profit: short hits target, R = +2 with a 1-unit stop', () => {
  const c = bars([[100, 100.4, 99, 99.5], [99.5, 99.8, 97.8, 98], [98, 98, 97, 97.5]])
  const r = backtestMslManaged(c, ONCE + 'pos.stop = pos.entry + 1\npos.target = pos.entry - 2\nput when go', O); assert.ok(r.ok, r.error)
  const t = r.trades[0]; assert.equal(t.reason, 'target'); assert.ok(Math.abs(t.r! - 2) < 1e-9); assert.equal(t.direction, 'put'); assert.ok(t.win)
})
test('stop and target on the SAME bar: the stop wins (conservative)', () => {
  const c = bars([[100, 103, 97, 100], [100, 100, 100, 100]])
  const r = backtestMslManaged(c, ONCE + 'pos.stop = pos.entry - 2\npos.target = pos.entry + 2\ncall when go', O)
  assert.equal(r.trades[0].reason, 'stop')
})
test('gap through the stop fills at the OPEN (worse than the stop)', () => {
  const c = bars([[100, 100.2, 99.9, 100], [95, 95.5, 94, 95]])
  const r = backtestMslManaged(c, ONCE + 'pos.stop = pos.entry - 2\ncall when go', O); const t = r.trades[0]
  assert.equal(t.reason, 'stop'); assert.equal(t.exit, 95); assert.ok(t.r! < -2)
})
test('trailing stop ratchets up and exits on the pullback', () => {
  const c = bars([[100, 102, 100, 102], [102, 106, 102, 106], [106, 110, 106, 109.5], [109.5, 109.6, 106, 106.2], [106, 106, 100, 100]])
  const r = backtestMslManaged(c, ONCE + 'pos.stop = pos.entry - 5\npos.trail = 3\ncall when go', O); const t = r.trades[0]
  assert.equal(t.reason, 'stop'); assert.ok(Math.abs(t.exit - 107) < 1e-9, `exit ${t.exit}`) // best 110 - 3
  assert.ok(t.pnlPrice > 6)
})
test('break-even: once +3 in profit the stop moves to entry and a return stops at 0', () => {
  const c = bars([[100, 104, 100, 103], [103, 103, 99, 100], [100, 100, 100, 100]])
  const r = backtestMslManaged(c, ONCE + 'pos.stop = pos.entry - 5\npos.breakeven = 3\ncall when go', O); const t = r.trades[0]
  assert.equal(t.reason, 'stop'); assert.ok(Math.abs(t.pnlPrice) < 1e-9)
})
test('partial exit: half at +2 via exit 0.5 when, rest at the target; pnl is the weighted sum', () => {
  const c = bars([[100, 102.5, 100, 102.2], [102.2, 104.5, 102, 104.2], [104.2, 106.2, 104, 106]])
  const src = ONCE + 'pos.stop = pos.entry - 3\npos.target = pos.entry + 6\ncall when go\nexit 0.5 when pos.pnl >= 2 and pos.left == 1'
  const r = backtestMslManaged(c, src, O); const t = r.trades[0]
  assert.equal(t.parts.length, 2); assert.equal(t.parts[0].reason, 'exit'); assert.ok(Math.abs(t.parts[0].frac - 0.5) < 1e-9)
  assert.ok(t.pnlPrice > 3 && t.pnlPrice < 6.5, `${t.pnlPrice}`)
})
test('hold until: dynamic exit condition on pos.*, and the time stop closes a stuck trade', () => {
  const c = bars([[100, 101, 99.5, 100.5], [100.5, 101.5, 100, 101], [101, 103, 101, 102.8], [102.8, 103, 102, 102.5]])
  const r = backtestMslManaged(c, ONCE + 'call when go\nhold until pos.pnl >= 2.5', O); assert.equal(r.trades[0].reason, 'exit'); assert.ok(r.trades[0].win)
  const flat = bars(Array.from({ length: 30 }, () => [100, 100.3, 99.7, 100]))
  const r2 = backtestMslManaged(flat, ONCE + 'call when go', { warmupBars: 5, maxBars: 10 }); assert.equal(r2.trades[0].reason, 'time'); assert.equal(r2.trades[0].bars, 10)
})
test('multiple positions (pos.max) and scaling in; opposite signals are ignored while open', () => {
  const rows = Array.from({ length: 12 }, (_, i) => [100 + i, 100.6 + i, 99.8 + i, 100.3 + i])
  const r = backtestMslManaged(bars(rows), 'pos.max = 3\ncall when true\nput when false', { warmupBars: 5, maxBars: 4 })
  assert.ok(r.trades.length >= 6, `${r.trades.length}`); assert.ok(r.trades.every(t => t.direction === 'call'))
  const one = backtestMslManaged(bars(rows), 'call when true', { warmupBars: 5, maxBars: 4 }); assert.ok(one.trades.length < r.trades.length)
})
test('script-controlled trail via a persistent var (remember the best price) + stop update each bar', () => {
  const c = bars([[100, 103, 100, 103], [103, 106, 103, 105.5], [105.5, 105.6, 102, 102.5], [102, 102, 98, 98]])
  const src = 'var best = 0\nif best == 0\n  best = px.close[-1]\nend\nbest = max(best, px.high[-1])\npos.stop = best - 4\ncall when best == px.close[-1]'
  const r = backtestMslManaged(c, src, { warmupBars: 5, maxBars: 50, maxPositions: 1 }); const t = r.trades[0]
  assert.equal(t.reason, 'stop'); assert.ok(t.exit > 100, `exit ${t.exit}`)
})
test('bad levels (stop on the wrong side) are dropped and counted, never trusted', () => {
  const c = bars([[100, 101, 99.8, 100.5], [100.5, 100.6, 97, 98], [98, 99, 97, 98]])
  const r = backtestMslManaged(c, ONCE + 'pos.stop = pos.entry + 2\ncall when go', O); assert.ok(r.skippedBadLevels >= 1); assert.equal(r.trades[0].r, undefined)
})
test('summary: profit factor, expectancy R, byReason; draws are surfaced', () => {
  const rows: number[][] = []; for (let k = 0; k < 6; k++) { rows.push([100, 101, 99.9, 100.5], k % 2 ? [100.5, 100.6, 97, 98] : [100.5, 104, 100.4, 103.5], [100, 100, 100, 100]) }
  const r = backtestMslManaged(bars(rows), 'pos.stop = pos.entry - 2\npos.target = pos.entry + 3\ndraw.hline(px.close[-1], "blue", "x")\ncall when px.close[-1] == 100 and px.close[-2] != 100', { warmupBars: 5, maxBars: 5 })
  assert.ok(r.ok && r.trades.length >= 3, `${r.trades.length}`); assert.ok(r.expectancyR !== null && r.profitFactor !== null); assert.ok(Object.keys(r.byReason).length >= 2); assert.ok(r.draws && r.draws.length === 1)
})
console.log(`${pass}/${total}`); process.exit(pass === total ? 0 : 1)
