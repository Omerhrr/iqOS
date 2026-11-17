// IQAIR//OS - tests: em.* (analytics/expectedmove.ts)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { emCone, emSigmaAt, emZ, emParams } from '../src/analytics/expectedmove'
const T0 = 1_700_000_040
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
const mk = (cl: number[]): Candle[] => cl.map((c, i) => { const o = i ? cl[i - 1] : c; return { time: T0 + i * 60, open: o, close: c, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, volume: 1 } })
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const calm = (n: number, step = 0.1, seed = 3): number[] => { const r = rng(seed); const o: number[] = [100]; for (let i = 1; i < n; i++) o.push(o[i - 1] + (r() < 0.5 ? -step : step)); return o }
test('sigma of +/-0.1 steps is 0.1 and cone widens with sqrt(h)', () => {
  const c = mk(calm(120)); assert.ok(Math.abs(emSigmaAt({ close: c.map((k) => k.close), high: c.map((k) => k.high), low: c.map((k) => k.low) }, 119) - 0.1) < 1e-9)
  const e = emCone(c, 16, [1, 2]); assert.ok(e.ok)
  assert.ok(Math.abs(e.points[0].upper[0] - e.price) < 1e-9)
  assert.ok(Math.abs(e.points[16].upper[0] - e.price - 0.4) < 1e-9, 'sqrt(16)*0.1 = 0.4')
  assert.ok(Math.abs(e.points[4].upper[1] - e.price - 0.4) < 1e-9, '2 sigma at 4 bars')
  assert.ok(Math.abs(e.points[4].lower[1] - (e.price - 0.4)) < 1e-9)
})
test('z measures a jump against the sd known before it (no look-ahead)', () => {
  const cl = calm(120); cl.push(cl[119] + 1.0)
  assert.ok(emZ({ close: cl, high: cl, low: cl }, 1) > 9, String(emZ({ close: cl, high: cl, low: cl }, 1)))
})
test('em.* scripts evaluate; outside() fires on the jump bar only', () => {
  const cl = calm(120); for (let i = 0; i < 3; i++) cl.push(cl[cl.length - 1] + 0.1 * (i % 2 ? 1 : -1)); cl.push(cl[cl.length - 1] + 1.0); const jump = cl.length - 1; cl.push(cl[jump] - 0.3); const c = mk(cl)
  const r = backtestMslScript(c, 'put when em.outside(1, 3) == 1', { expiryBars: 1 }); assert.ok(r.ok, String(r.error)); assert.equal(r.trades.length, 1)
  assert.equal(r.trades[0].index, jump); assert.equal(r.trades[0].win, true)
  const u = backtestMslScript(c, 'call when em.ok() and em.sigma() > 0 and em.upper(4, 2) > em.lower(4, 2) and em.width(4, 2) > 0 and em.sigmaAtr() > 0', { expiryBars: 1 })
  assert.ok(u.ok, String(u.error)); assert.ok(u.trades.length > 0)
  const bad = backtestMslScript(c, 'call when em.nope() == 1', { expiryBars: 1 }); assert.ok(!bad.ok || bad.trades.length === 0)
})
test('window, mode and hurst change the cone', () => {
  const c = mk(calm(160)); const a = emCone(c, 16, [1], { window: 100 }), b = emCone(c, 16, [1], { window: 100, hurst: 0.7 }), w = emCone(c, 16, [1], { window: 30, mode: 'ewma' }), pk = emCone(c, 16, [1], { mode: 'parkinson' })
  assert.ok(b.points[16].upper[0] > a.points[16].upper[0], 'hurst 0.7 widens faster')
  assert.ok(Math.abs(b.points[1].upper[0] - a.points[1].upper[0]) < 1e-9, '1 bar is unaffected by hurst')
  assert.ok(Math.abs(w.sd - 0.1) < 1e-9 && w.params.mode === 'ewma' && w.params.window === 30)
  assert.ok(pk.ok && pk.sd > 0 && Math.abs(pk.sd - a.sd) > 1e-6, 'parkinson reads high-low')
  assert.equal(emParams({ window: 5, hurst: 9 }).window, 10); assert.equal(emParams({ hurst: 9 }).hurst, 1)
})
test('MSL tuning arguments reach the maths', () => {
  const c = mk(calm(160))
  const run = (sc: string) => { const r = backtestMslScript(c, sc, { expiryBars: 1 }); assert.ok(r.ok, String(r.error)); return r.trades.length }
  assert.ok(run('call when em.upper(16, 1, 100, 0.5, 0) > 0') > 0)
  assert.equal(run('call when em.upper(16, 1, 100, 0.5, 0) - em.upper(1, 1, 100, 0.5, 0) > 0.29'), run('call when em.ok()'), 'sqrt16*0.1-0.1 = 0.3')
  assert.equal(run('call when em.upper(16, 1, 100, 0.7, 0) - em.upper(16, 1, 100, 0.5, 0) > 0.05'), run('call when em.ok()'), 'hurst widens')
  assert.ok(run('call when em.sigma(30, 2) > 0 and em.sigma(50, 3) > 0 and em.sigmaAtr(60, 1) > 0 and em.z(3, 80, 0.5, 2) > -99 and em.width(4, 2, 100, 0.5, 3) > 0') > 0)
  const bad = backtestMslScript(c, 'call when em.upper(4, 1, -5) > 0', { expiryBars: 1 }); assert.ok(bad.ok === false || bad.trades.length === 0)
})
console.log(`${pass}/${total} passed`); if (pass !== total) process.exit(1)
