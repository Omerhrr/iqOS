// IQAIR//OS - tests: polar.* (analytics/polarity.ts)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { readPolarity } from '../src/analytics/polarity'

const T0 = 1_700_000_000
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
/** returns r[t] = phi * r[t-1] + noise: phi<0 reverts (a follow-the-last-candle rule is reliably wrong), phi>0 persists */
function ar(n: number, phi: number, seed: number): Candle[] {
  const r = rng(seed), out: Candle[] = []
  let x = 100, prev = 0
  for (let i = 0; i < n; i++) { const o = x; prev = phi * prev + (r() - 0.5) * 0.5; x = o + prev; out.push({ time: T0 + i * 60, open: o, high: Math.max(o, x) + r() * 0.04, low: Math.min(o, x) - r() * 0.04, close: x, volume: 100 }) }
  return out
}
const SCRIPT = 'if polar.ok() and polar.side() != "none"\n  call when polar.side() == "call"\n  put when polar.side() == "put"\nend'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const run = (c: Candle[]) => { const res = backtestMslScript(c, SCRIPT, { expiryBars: 1, warmupBars: 260, runId: 'pl' + Math.random() }); return { n: res.trades.length, w: res.trades.filter((t) => t.win).length } }

test('scripts parse', () => {
  assert.equal(parseStrategyScript(SCRIPT).ok, true)
  assert.equal(parseStrategyScript('if polar.ok() and polar.flipped("follow") and polar.z("follow") <= -2.5 and polar.n("follow") >= 40\n  call when polar.baseSide("follow") == "put"\nend').ok, true)
})
test('thin history is not ok', () => assert.equal(readPolarity(ar(100, 0, 1)).ok, false))
test('reverting market: the follow base is flipped, momentum market: it is kept', () => {
  const rv = readPolarity(ar(1200, -0.6, 3)), mo = readPolarity(ar(1200, 0.6, 3))
  const f = (x: typeof rv) => x.bases.find((b) => b.base === 'follow')!
  assert.equal(f(rv).mode, 'flip', `rv z ${f(rv).z} n ${f(rv).n}`)
  assert.equal(f(mo).mode, 'keep', `mo z ${f(mo).z} n ${f(mo).n}`)
})
test('transmuted signal wins above chance in a backtest on the reverting market', () => {
  const r = run(ar(2600, -0.6, 5))
  assert.ok(r.n >= 40, `trades ${r.n}`); assert.ok(r.w / r.n > 0.57, `wr ${r.w}/${r.n}`)
})
test('random walk: mostly skips and wins about half', () => {
  const r = run(ar(2600, 0, 7))
  if (r.n >= 40) assert.ok(Math.abs(r.w / r.n - 0.5) < 0.1, `wr ${r.w}/${r.n}`)
  assert.ok(r.n < 0.5 * 2300, `fires ${r.n}`)
})
console.log(pass === total ? `all ${pass} passed` : `${total - pass} FAILED`)
if (pass !== total) process.exit(1)
