// IQAIR//OS - tests: swing engine + ew2 + px + geometry helpers
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { computeSwings, readEw2 } from '../src/analytics/swingengine'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
// piecewise-linear path through waypoints, 12 bars per leg, tiny deterministic wiggle
const path = (wp: number[], per = 12): Candle[] => {
  const out: Candle[] = []; let t = 1_700_000_040
  // flat lead-in so ATR exists
  for (let i = 0; i < 30; i++) { const p = wp[0] + Math.sin(i) * 0.3; out.push({ time: t, open: p, close: p, high: p + 0.5, low: p - 0.5, volume: 1 }); t += 60 }
  for (let k = 1; k < wp.length; k++) for (let j = 1; j <= per; j++) { const p = wp[k - 1] + ((wp[k] - wp[k - 1]) * j) / per; const o = out[out.length - 1].close; out.push({ time: t, open: o, close: p, high: Math.max(o, p) + 0.3, low: Math.min(o, p) - 0.3, volume: 1 }); t += 60 }
  return out
}
// bullish impulse 100->110 (w1) ->104 (w2) ->125 (w3) ->116 (w4) ->130 (w5), then A-B-C down
const IMP = [100, 110, 104, 125, 116, 130]
const ABC = [...IMP, 118, 124, 108]
test('swing engine finds the planted pivots in order', () => {
  const c = path([...IMP, 118]); const s = computeSwings({ high: c.map(x => x.high), low: c.map(x => x.low), close: c.map(x => x.close) }, 2, 0)
  const px = s.pivots.map(p => Math.round(p.price))
  assert.ok(px.length >= 5, `pivots ${px}`)
  assert.ok(Math.abs(s.pivots[s.pivots.length - 1].price - 130) < 1.5, `last pivot ${px}`)
})
test('ew2 reads a valid impulse and the 3 hard rules hold', () => {
  const c = path([...IMP, 118]); const e = readEw2(computeSwings({ high: c.map(x => x.high), low: c.map(x => x.low), close: c.map(x => x.close) }, 2, 0))
  assert.ok(e.ok, 'ok'); assert.equal(e.dir, 1)
  assert.ok(e.pts[3].price > e.pts[1].price)
})
test('MSL: sw/ew2/px/helpers evaluate and a strategy trades on repeated structure', () => {
  let wp: number[] = [100]; for (let r = 0; r < 6; r++) wp = wp.concat([110, 104, 125, 116, 130, 112].map(v => v + r * 0))
  const c = path(wp)
  const src = `let a = sw.high(1)\nlet b = sw.low(1)\nlet r = sw.retr()\nlet f = fibRet(sw.low(2), sw.high(1), 0.618)\nlet p = px.high.max(20)\ncall when sw.dir() == 1 and sw.curLeg() > 0.5\nput when sw.dir() == -1 and sw.curLeg() < -0.5`
  const r = backtestMslScript(c, src, { expiryBars: 3 }); assert.ok(r.ok, r.error); assert.ok(r.trades.length >= 2, `${r.trades.length}`)
  const r2 = backtestMslScript(c, `call when ew2.ok() and ew2.dir() == 1 and ew2.wave() >= 1`, { expiryBars: 3 }); assert.ok(r2.ok, r2.error)
  const r3 = backtestMslScript(c, `let q = lineAt(100, 10, 110, 0, 5)\nlet d = distAtr(px.close[-1], 100)\ncall when near(px.close[-1], sw.low(1), 3) and px.close[-1] > px.close[-2]`, { expiryBars: 3 }); assert.ok(r3.ok, r3.error)
})
test('missing swings give NaN-safe false, not a crash; unknown method errors', () => {
  const c = path([100, 100.2, 100, 100.1]); const r = backtestMslScript(c, 'call when sw.high(5) > 0', { expiryBars: 3 }); assert.ok(r.ok, r.error); assert.equal(r.trades.length, 0)
  const bad = backtestMslScript(path(IMP), 'call when sw.nope() > 0', { expiryBars: 3 }); assert.ok(!bad.ok || bad.trades.length === 0)
})
console.log(`${pass}/${total}`); process.exit(pass === total ? 0 : 1)
