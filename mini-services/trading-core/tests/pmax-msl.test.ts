// IQAIR//OS - tests: PMax (analytics/pmax.ts, ind.pmax)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { pmax, pmaxMa, PMAX_MAS, pmaxSource } from '../src/analytics/pmax'
import { sma } from '../src/analytics/indicators'
const T0 = Date.UTC(2026, 0, 5) / 1000
/** up trend, down trend, up trend with noise */
const series = (n = 900): Candle[] => { let x = 100, s = 1; const out: Candle[] = []; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) % 4294967296; const noise = (s / 4294967296 - 0.5) * 0.6; const drift = Math.sin((i * 2 * Math.PI) / 300) * 0.35; const o = x; x = o + drift + noise; out.push({ time: T0 + i * 60, open: o, close: x, high: Math.max(o, x) + 0.15, low: Math.min(o, x) - 0.15, volume: 5 }) } return out }
const col = (c: Candle[]) => ({ open: c.map((k) => k.open), high: c.map((k) => k.high), low: c.map((k) => k.low), close: c.map((k) => k.close) })
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const ramp = Array.from({ length: 100 }, (_, i) => 10 + 2 * i), flat = Array.from({ length: 100 }, () => 50)
test('moving averages: TSF projects a ramp one bar ahead, TMA = sma(sma), ZLEMA/VAR/WWMA of a constant converge to it', () => {
  assert.ok(Math.abs(pmaxMa('tsf', ramp, 10)[99] - (10 + 2 * 100)) < 1e-9, 'tsf')
  const tma = pmaxMa('tma', ramp, 10), ref = sma(sma(ramp, 5).slice(4), 6)
  assert.ok(Math.abs(tma[99] - ref[ref.length - 1]) < 1e-9, 'tma')
  for (const t of ['zlema', 'wwma', 'sma', 'ema', 'wma']) assert.ok(Math.abs(pmaxMa(t, flat, 10)[99] - 50) < 0.5, `${t} ${pmaxMa(t, flat, 10)[99]}`)
  // VAR faithfully reproduces Pine: on a perfectly flat series the CMO is 0, so VAR never leaves its zero start; on real (moving) data it tracks price
  assert.equal(pmaxMa('var', flat, 10)[99], 0)
  const wig = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * 3 + i * 0.1), v = pmaxMa('var', wig, 10)
  assert.ok(Math.abs(v[199] - wig[199]) < 6, `var ${v[199]} vs ${wig[199]}`)
  assert.throws(() => pmaxMa('nope', flat, 10))
})
test('sources', () => {
  const x = { open: [1], high: [4], low: [2], close: [3] }
  assert.equal(pmaxSource('hl2', x)[0], 3); assert.equal(pmaxSource('hlc3', x)[0], 3); assert.equal(pmaxSource('ohlc4', x)[0], 2.5); assert.throws(() => pmaxSource('x', x))
})
test('line ratchets, sits below the MA in an up trend and above it in a down trend; trend flips are rare but happen', () => {
  const c = series(), r = pmax(col(c), { ma: 'ema', maLen: 10, atrLen: 10, mult: 3 })
  let flips = 0, ups = 0, downs = 0
  for (let i = 30; i < c.length; i++) {
    if (r.dir[i] === 1) { assert.ok(r.line[i] < r.ma[i] + 1e-9, `up: line above MA at ${i}`); ups++ } else { assert.ok(r.line[i] > r.ma[i] - 1e-9, `down: line below MA at ${i}`); downs++ }
    if (r.dir[i] !== r.dir[i - 1]) flips++
    if (r.dir[i] === 1 && r.dir[i - 1] === 1) assert.ok(r.line[i] >= r.line[i - 1] - 1e-9, 'long stop never falls while trend is up')
    if (r.dir[i] === -1 && r.dir[i - 1] === -1) assert.ok(r.line[i] <= r.line[i - 1] + 1e-9, 'short stop never rises while trend is down')
  }
  assert.ok(flips >= 2 && flips < 60 && ups > 50 && downs > 50, `flips ${flips} ups ${ups} downs ${downs}`)
})
test('a flip to +1 is exactly when the MA crosses above the PMax line (buy signal)', () => {
  const c = series(), r = pmax(col(c))
  let buys = 0
  for (let i = 31; i < c.length; i++) if (r.dir[i] === 1 && r.dir[i - 1] === -1) { buys++; assert.ok(r.ma[i] > r.line[i - 1] - 1e-9, 'MA ends above the old PMax'); assert.ok(r.ma[i - 1] <= r.line[i - 1] + 1e-9, 'and was at/below it the bar before') }
  assert.ok(buys >= 1)
})
test('MSL: ind.pmax fields work for every MA type and the cross script trades', () => {
  const c = series()
  for (const t of PMAX_MAS) {
    const r = backtestMslScript(c, `let pm = ind.pmax("${t}", 10, 10, 3, "hl2", 1)\ncall when pm.ma.crossed("up", pm.line)\nput when pm.ma.crossed("down", pm.line)`, { expiryBars: 3 })
    assert.ok(r.ok, `${t}: ${r.error}`); assert.ok(r.trades.length >= 2, `${t}: ${r.trades.length} trades`)
  }
  const d = backtestMslScript(c, 'let pm = ind.pmax()\ncall when pm.dir[-1] == 1 and pm.dir[-2] == -1\nput when pm.trend[-1] == -1 and pm.trend[-2] == 1 and pm.atr[-1] > 0 and pm.tsl[-1] > 0', { expiryBars: 3 })
  assert.ok(d.ok && d.trades.length >= 2, String(d.error))
  const tfr = backtestMslScript(c, 'call when ind.pmax("ema", 10, 10, 3, "hl2", 1, "5m").dir[-1] == 1', { expiryBars: 3 }); assert.ok(tfr.ok, String(tfr.error))
  const bad = backtestMslScript(c, 'call when ind.pmax("zzz").dir[-1] == 1', { expiryBars: 3 }); assert.ok(!bad.ok || bad.trades.length === 0)
})
console.log(`${pass}/${total} passed`); if (pass !== total) process.exit(1)
