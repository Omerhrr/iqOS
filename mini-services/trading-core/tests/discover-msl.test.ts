// IQAIR//OS - tests: learn.* pattern discovery (analytics/discover.ts)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { readLearn } from '../src/analytics/discover'

const tests: [string, () => void][] = []
const test = (n: string, f: () => void) => tests.push([n, f])
const T0 = 1_700_000_000
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
const gauss = (r: () => number) => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }
/** random walk; if plant: after a BIG green bar closing at its high, the next bar is UP 80% of the time */
function mk(n: number, seed: number, plant: boolean): Candle[] {
  const r = rng(seed), out: Candle[] = []
  let x = 100, prevBigUp = false
  for (let i = 0; i < n; i++) {
    const o = x
    let mv = gauss(r) * 0.3
    if (plant && prevBigUp) mv = Math.abs(mv) * (r() < 0.85 ? 1 : -1)
    x = o + mv
    const hi = Math.max(o, x), lo = Math.min(o, x)
    const bigUp = mv > 0.34
    out.push({ time: T0 + i * 60, open: o, high: bigUp ? hi + 0.01 : hi + r() * 0.2, low: lo - r() * 0.2, close: x, volume: 100 })
    prevBigUp = bigUp
  }
  return out
}
const SCRIPT = 'if learn.ok() and learn.match() and not learn.conflict() and learn.low() >= 0.55\n  call when learn.side() == "call"\n  put when learn.side() == "put"\nend'

test('script parses', () => assert.equal(parseStrategyScript(SCRIPT).ok, true))
test('thin history fails closed', () => assert.equal(readLearn(mk(100, 1, false)).ok, false))
test('planted pattern is discovered and validated', () => {
  let hit = 0
  for (let s = 1; s <= 5; s++) { const r = readLearn(mk(3000, s, true)); if (r.ok && r.found >= 1) hit++ }
  assert.ok(hit >= 4, `discovered in ${hit}/5 seeds`)
})
test('pure noise: almost never validates a pattern', () => {
  let bad = 0
  for (let s = 1; s <= 12; s++) { const r = readLearn(mk(3000, 100 + s, false)); if (r.ok && r.found >= 1) bad++ }
  assert.ok(bad <= 2, `false discoveries in ${bad}/12 noise runs`)
})
test('planted: discovered script wins above chance', () => {
  const res = backtestMslScript(mk(3000, 7, true), SCRIPT, { expiryBars: 1, warmupBars: 1500, runId: 'ln' } as never) as { trades?: { win?: boolean; won?: boolean }[] }
  const tr = res.trades ?? []
  const wins = tr.filter((t) => t.win ?? t.won).length
  assert.ok(tr.length >= 10, `trades ${tr.length}`)
  assert.ok(wins / tr.length > 0.6, `wr ${wins}/${tr.length}`)
})
let pass = 0
for (const [n, f] of tests) { try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
console.log(pass === tests.length ? `all ${pass} passed` : `${tests.length - pass} FAILED`)
if (pass !== tests.length) process.exit(1)
