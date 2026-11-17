// IQAIR//OS - tests: mkt.* / adapt.* (analytics/marketmind.ts)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { readMarket, readAdapt } from '../src/analytics/marketmind'

const tests: [string, () => void][] = []
const test = (n: string, f: () => void) => tests.push([n, f])
const T0 = 1_700_000_000
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
const gauss = (r: () => number) => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }
/** returns follow ret[t] = phi*ret[t-1] + noise */
function ar(n: number, phi: number, seed: number): Candle[] {
  const r = rng(seed), out: Candle[] = []
  let x = 100, prev = 0
  for (let i = 0; i < n; i++) {
    const o = x
    prev = phi * prev + gauss(r) * 0.2
    x = o + prev
    out.push({ time: T0 + i * 60, open: o, high: Math.max(o, x) + r() * 0.05, low: Math.min(o, x) - r() * 0.05, close: x, volume: 100 })
  }
  return out
}
const SCRIPT = 'if adapt.ok() and adapt.n() >= 30 and adapt.p() >= 0.60\\n  call when adapt.side() == "call"\\n  put when adapt.side() == "put"\\nend'.replace(/\\n/g, '\n')

test('scripts parse', () => {
  assert.equal(parseStrategyScript(SCRIPT).ok, true)
  assert.equal(parseStrategyScript('if mkt.ok() and mkt.isTrending() and mkt.strength() > 0.4\n  call when mkt.trend() == 1\nend').ok, true)
})
test('thin history fails closed', () => {
  assert.equal(readMarket(ar(50, 0, 1)).ok, false)
  assert.equal(readAdapt(ar(50, 0, 1)).ok, false)
})
test('trending data is labelled trending; reverting data is not', () => {
  const t = readMarket(ar(800, 0.6, 5)), v = readMarket(ar(800, -0.6, 5))
  assert.equal(t.ok && v.ok, true)
  assert.ok(t.vr > v.vr, `vr trend ${t.vr} vs revert ${v.vr}`)
  assert.ok(t.ac > 0 && v.ac < 0)
})
test('adapt picks follow on persistent data and fade on reverting data', () => {
  let f = 0, d = 0
  for (let s = 1; s <= 6; s++) {
    const t = readAdapt(ar(900, 0.6, s)), v = readAdapt(ar(900, -0.6, s))
    if (t.pFollow > t.pFade) f++
    if (v.pFade > v.pFollow) d++
  }
  assert.ok(f >= 5 && d >= 5, `follow ${f}/6 fade ${d}/6`)
})
test('no look-ahead: appending a bar cannot change an earlier read', () => {
  const c = ar(700, 0.5, 9)
  const a = readAdapt(c.slice(0, 600))
  const b = readAdapt(c.slice(0, 600).concat([]))
  assert.deepEqual(a, b)
})
test('planted persistence: adaptive script wins above chance in backtest', () => {
  const res = backtestMslScript(ar(2500, 0.6, 21), SCRIPT, { expiryBars: 1, warmupBars: 300, runId: 'am' } as never) as { trades?: { win?: boolean; won?: boolean }[] }
  const tr = res.trades ?? []
  const wins = tr.filter((t) => t.win ?? t.won).length
  assert.ok(tr.length >= 20, `trades ${tr.length}`)
  assert.ok(wins / tr.length > 0.55, `wr ${wins}/${tr.length}`)
})
test('random walk: rule rarely clears 60% and wins about half', () => {
  const res = backtestMslScript(ar(2500, 0, 33), SCRIPT, { expiryBars: 1, warmupBars: 300, runId: 'am0' } as never) as { trades?: { win?: boolean; won?: boolean }[] }
  const tr = res.trades ?? []
  const wins = tr.filter((t) => t.win ?? t.won).length
  assert.ok(tr.length < 0.15 * 2200, `fires ${tr.length}`)
  if (tr.length >= 30) assert.ok(Math.abs(wins / tr.length - 0.5) < 0.15, `wr ${wins}/${tr.length}`)
})
let pass = 0
for (const [n, f] of tests) { try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
console.log(pass === tests.length ? `all ${pass} passed` : `${tests.length - pass} FAILED`)
if (pass !== tests.length) process.exit(1)
