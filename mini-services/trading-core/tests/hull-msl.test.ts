// IQAIR//OS - tests: Hull Suite (ind.hull: hma / ehma / thma)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { hullSeries, HULL_MODES } from '../src/analytics/mamix'
let s = 7
const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
const px = Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 20) * 5 + (rnd() - 0.5))
const naiveWma = (a: number[], end: number, len: number): number => { let acc = 0; for (let j = 0; j < len; j++) acc += a[end - j] * (len - j); return acc / ((len * (len + 1)) / 2) }
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
test('HMA matches the naive wma(2*wma(n/2) - wma(n), round(sqrt(n))) formula at the last bar', () => {
  const len = 55, sq = Math.round(Math.sqrt(len)), half = Math.trunc(len / 2), end = px.length - 1
  const raw = (i: number) => 2 * naiveWma(px, i, half) - naiveWma(px, i, len)
  const series = Array.from({ length: sq }, (_, k) => raw(end - sq + 1 + k))
  assert.ok(Math.abs(hullSeries('hma', px, len)[end] - naiveWma(series, sq - 1, sq)) < 1e-9)
})
test('THMA (called with len/2 like the script) matches the naive formula', () => {
  const L = 55 / 2, a = Math.trunc(L / 3), b = Math.trunc(L / 2), c = Math.trunc(L), end = px.length - 1
  const raw = (i: number) => naiveWma(px, i, a) * 3 - naiveWma(px, i, b) - naiveWma(px, i, c)
  const series = Array.from({ length: c }, (_, k) => raw(end - c + 1 + k))
  assert.ok(Math.abs(hullSeries('thma', px, 55)[end] - naiveWma(series, c - 1, c)) < 1e-9)
})
test('every variation: constant in -> constant out, ramp lags less than a plain wma, unknown mode throws', () => {
  for (const m of HULL_MODES) {
    assert.ok(Math.abs(hullSeries(m, Array.from({ length: 200 }, () => 50), 55)[199] - 50) < 1e-9, m)
    const r = hullSeries(m, Array.from({ length: 200 }, (_, i) => i), 55)[199]; assert.ok(Math.abs(r - 199) < 6 && r < 199.0001, `${m} on a ramp ${r}`)
  }
  assert.throws(() => hullSeries('nope', px, 55))
})
test('MSL: the strategy (HULL[0] vs HULL[2]) trades; every variation and source parses', () => {
  const c: Candle[] = px.map((p, i) => ({ time: 1_700_000_040 + i * 60, open: p - 0.1, close: p, high: p + 0.3, low: p - 0.3, volume: 1 }))
  for (const m of HULL_MODES) for (const src of ['close', 'hl2', 'ohlc4']) {
    const r = backtestMslScript(c, `let h = ind.hull("${m}", 21, "${src}")\ncall when h[-1] > h[-3] and h[-2] <= h[-4]\nput when h[-1] < h[-3] and h[-2] >= h[-4]`, { expiryBars: 3 })
    assert.ok(r.ok, `${m}/${src}: ${r.error}`); assert.ok(r.trades.length >= 2, `${m}/${src}: ${r.trades.length} trades`)
  }
  assert.ok(backtestMslScript(c, 'call when ind.hull()[-1] > ind.hull()[-3]', { expiryBars: 3 }).ok)
  assert.ok(backtestMslScript(c, 'call when ind.hull("hma", 21, "close", "5m")[-1] > 0', { expiryBars: 3 }).ok)
  const bad = backtestMslScript(c, 'call when ind.hull("zzz")[-1] > 0', { expiryBars: 3 }); assert.ok(!bad.ok || bad.trades.length === 0)
})
console.log(`${pass}/${total} passed`); if (pass !== total) process.exit(1)
