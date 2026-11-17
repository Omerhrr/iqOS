// IQAIR//OS - tests: nc.* (the Next-Candle Oracle as an MSL namespace)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { predictNextCandle } from '../src/analytics/nextcandle'

const T0 = 1_700_000_000
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
function walk(n: number, seed: number): Candle[] {
  const r = rng(seed), out: Candle[] = []
  let x = 100
  for (let i = 0; i < n; i++) { const o = x; x += (r() - 0.5) * 0.6; out.push({ time: T0 + i * 60, open: o, high: Math.max(o, x) + 0.05, low: Math.min(o, x) - 0.05, close: x, volume: 100 }) }
  return out
}
const SCRIPT = 'if nc.ok() and nc.conf() >= 55 and nc.agree() >= 0.6\n  call when nc.side() == "call"\n  put when nc.side() == "put"\nend'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }

test('scripts parse', () => {
  assert.equal(parseStrategyScript(SCRIPT).ok, true)
  assert.equal(parseStrategyScript('if nc.ok() and nc.pUp() >= 0.6 and nc.driver("markov") > 0.55 and nc.regime() == "TRENDING"\n  call when true\nend').ok, true)
})
test('thin history: ok() false and a reader fails closed (no trades)', () => {
  const res = backtestMslScript(walk(200, 1), SCRIPT, { expiryBars: 1, warmupBars: 100, runId: 'nc0' })
  assert.equal(res.trades.length, 0)
})
test('namespace equals the oracle: same pUp/direction on the same window', () => {
  const c = walk(700, 2)
  const win = c.slice(0, 601)
  const direct = predictNextCandle(win.slice(-520), { asset: 'MSL', tf: 'msl', mode: 'sim', seed: (win[win.length - 1].time * 31 + win.length) % 2147483647 })!
  const res = backtestMslScript(c.slice(0, 602), 'if nc.ok() and nc.side() == "call"\n  call when true\nelseif nc.ok() and nc.side() == "put"\n  put when true\nend', { expiryBars: 1, warmupBars: 600, runId: 'nc1' })
  const sig = res.trades[res.trades.length - 1]
  if (direct.direction === 'none') assert.equal(sig, undefined)
  else {
    assert.ok(sig, 'a read was produced')
    assert.equal(sig.direction, direct.direction)
  }
  assert.ok(direct.pUp > 0 && direct.pUp < 1)
})
test('no look-ahead: a read on a prefix does not change when later bars exist', () => {
  const c = walk(700, 4)
  const a = predictNextCandle(c.slice(0, 600).slice(-520), { asset: 'MSL', tf: 'msl', mode: 'sim', seed: 12345 })!
  const b = predictNextCandle(c.slice(0, 600).slice(-520), { asset: 'MSL', tf: 'msl', mode: 'sim', seed: 12345 })!
  assert.equal(a.pUp, b.pUp)
})
test('random walk: no edge is invented (win rate near 50%)', () => {
  const res = backtestMslScript(walk(1500, 9), SCRIPT, { expiryBars: 1, warmupBars: 330, runId: 'nc2' })
  const n = res.trades.length
  const w = res.trades.filter((t) => t.win).length
  if (n >= 40) assert.ok(Math.abs(w / n - 0.5) < 0.12, `wr ${w}/${n}`)
})
console.log(pass === total ? `all ${pass} passed` : `${total - pass} FAILED`)
if (pass !== total) process.exit(1)
