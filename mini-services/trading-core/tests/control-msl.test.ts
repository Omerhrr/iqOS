// IQAIR//OS - tests: ctl.* (analytics/control.ts)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { readControl } from '../src/analytics/control'

const T0 = 1_700_000_000
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
function make(n: number, drift: number, seed: number, vol = true): Candle[] {
  const r = rng(seed), out: Candle[] = []
  let x = 100
  for (let i = 0; i < n; i++) { const o = x; x += (r() - 0.5) * 0.6 + drift; out.push({ time: T0 + i * 60, open: o, high: Math.max(o, x) + r() * 0.05, low: Math.min(o, x) - r() * 0.05, close: x, volume: vol ? 50 + r() * 100 : 100 }) }
  return out
}
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }

test('scripts parse', () => {
  assert.equal(parseStrategyScript('if ctl.ok() and ctl.isBuyers() and ctl.strength() >= 50 and ctl.run() >= 3\n  call when true\nend').ok, true)
  assert.equal(parseStrategyScript('if ctl.ok() and ctl.score(20) <= -40\n  put when true\nend').ok, true)
})
test('thin history is not ok', () => assert.equal(readControl(make(20, 0, 1)).ok, false))
test('strong up-drift: buyers in control, strong score; down-drift: sellers', () => {
  const up = readControl(make(200, 0.25, 2)), dn = readControl(make(200, -0.25, 2))
  assert.equal(up.who, 'buyers'); assert.ok(up.score > 40, `up ${up.score}`)
  assert.equal(dn.who, 'sellers'); assert.ok(dn.score < -40, `dn ${dn.score}`)
})
test('flat volume: flow component unavailable, score still computed', () => {
  const r = readControl(make(200, 0.25, 3, false))
  assert.equal(r.volumeOk, false); assert.ok(Number.isNaN(r.flow)); assert.equal(r.full, false); assert.ok(r.score > 30)
})
test('scores are bounded and symmetric under a price mirror', () => {
  const c = make(200, 0.1, 4)
  const m = c.map((x) => ({ ...x, open: 200 - x.open, close: 200 - x.close, high: 200 - x.low, low: 200 - x.high }))
  const a = readControl(c), b = readControl(m)
  assert.ok(Math.abs(a.score) <= 100 && Math.abs(b.score) <= 100)
  assert.ok(Math.abs(a.score + b.score) < 8, `a ${a.score} b ${b.score}`)
})
test('random walk: control labels carry no next-bar edge (win rate near 50%)', () => {
  const res = backtestMslScript(make(2500, 0, 7), 'if ctl.ok() and ctl.isBuyers() and ctl.strength() >= 40\n  call when true\nelseif ctl.ok() and ctl.isSellers() and ctl.strength() >= 40\n  put when true\nend', { expiryBars: 1, warmupBars: 80, runId: 'ctl' })
  const n = res.trades.length, w = res.trades.filter((t) => t.win).length
  assert.ok(n > 100, `trades ${n}`)
  assert.ok(Math.abs(w / n - 0.5) < 0.08, `wr ${w}/${n}`)
})
console.log(pass === total ? `all ${pass} passed` : `${total - pass} FAILED`)
if (pass !== total) process.exit(1)
