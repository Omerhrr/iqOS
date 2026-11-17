// IQAIR//OS - tests: rev.* (analytics/reversal.ts)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { readReversal } from '../src/analytics/revmsl'

const T0 = 1_700_000_000
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
/** mean-reverting around 100: each step pulls back toward the mean with strength k, plus noise */
function revert(n: number, k: number, seed: number): Candle[] {
  const r = rng(seed), out: Candle[] = []
  let x = 100
  for (let i = 0; i < n; i++) { const o = x; x += -k * (x - 100) + (r() - 0.5) * 0.8; out.push({ time: T0 + i * 60, open: o, high: Math.max(o, x) + r() * 0.1, low: Math.min(o, x) - r() * 0.1, close: x, volume: 100 }) }
  return out
}
const SCRIPT = 'if rev.ok() and rev.side() != "none" and rev.score() >= 20 and rev.n() >= 20 and rev.p() >= 0.58\n  call when rev.side() == "call"\n  put when rev.side() == "put"\nend'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }

test('scripts parse', () => {
  assert.equal(parseStrategyScript(SCRIPT).ok, true)
  assert.equal(parseStrategyScript('if rev.ok() and (rev.state() == "reversing" or rev.state() == "confirmed") and rev.dir() == "up" and rev.has("RSI")\n  call when true\nend').ok, true)
  assert.equal(parseStrategyScript('if rev.ok() and rev.confirmed() and rev.sweep() and rev.streak() <= -3\n  call when true\nend').ok, true)
})
test('thin history is not ok', () => assert.equal(readReversal(revert(40, 0.1, 1)).ok, false))
test('a stretched, exhausted downside bar scores a bullish reversal', () => {
  const c = revert(200, 0.05, 2)
  for (let i = 0; i < 6; i++) { const o = c[c.length - 1].close; const x = o - 1.2; c.push({ time: T0 + (c.length) * 60, open: o, high: o + 0.05, low: x - 0.6, close: x + 0.1 * (i === 5 ? 6 : 0), volume: 100 }) }
  const r = readReversal(c)
  assert.equal(r.side, 'call'); assert.ok(r.score >= 45, `score ${r.score}`); assert.ok(r.streak <= -3 || r.stretch < -1.5)
})
test('mirror symmetry: flipping prices flips the side and keeps the score', () => {
  const c = revert(300, 0.1, 3)
  const m = c.map((x) => ({ ...x, open: 200 - x.open, close: 200 - x.close, high: 200 - x.low, low: 200 - x.high }))
  const a = readReversal(c), b = readReversal(m)
  if (a.side !== 'none') { assert.notEqual(a.side, b.side); assert.ok(Math.abs(a.score - b.score) <= 1, `${a.score} ${b.score}`) }
})
test('strong mean reversion: reversal script wins above chance; random walk: near 50%', () => {
  const run = (c: Candle[]) => { const res = backtestMslScript(c, SCRIPT, { expiryBars: 1, warmupBars: 100, runId: 'rv' + Math.random() }); return { n: res.trades.length, w: res.trades.filter((t) => t.win).length } }
  const rv = run(revert(3000, 0.35, 5)), rw = run(revert(3000, 0, 5))
  assert.ok(rv.n >= 30, `trades ${rv.n}`); assert.ok(rv.w / rv.n > 0.58, `reverting wr ${rv.w}/${rv.n}`)
  if (rw.n >= 40) assert.ok(Math.abs(rw.w / rw.n - 0.5) < 0.12, `random wr ${rw.w}/${rw.n}`)
})
console.log(pass === total ? `all ${pass} passed` : `${total - pass} FAILED`)
if (pass !== total) process.exit(1)
