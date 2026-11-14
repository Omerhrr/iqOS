// IQAIR//OS - tests for the MSL `pv.*` (price / volume relationship) namespace and the builtin "PV 1" strategy.
import assert from 'node:assert/strict'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { readPv, pvInput, volumeOk, pearson } from '../src/analytics/mslpv'

type Test = { name: string; fn: () => void }
const tests: Test[] = []
const test = (name: string, fn: () => void) => tests.push({ name, fn })
const SCRIPT = `# PV 1: trade what volume CONFIRMS, fade what it does not. Silent on any feed without real volume (OTC / flat).
let ready = pv.ok() and pv.volumeOk()
let atr = ind.atr(14)[-1]
let moveAtr = (ohlc(-1).c - ohlc(-6).c) / atr
# is volume in this window tied to the SIZE of moves, and is it heavier now than just before?
let tracksMoves = pv.corrAbs(30) >= 0.2
let loud = pv.relVol(30) >= 1.1
let tilt = pv.tilt(10)
# playbook 1 - confirmed move: price moved >= 0.8 ATR over 5 bars, the volume leaned the same way and is rising -> follow it
let followUp = moveAtr >= 0.8 and tilt >= 0.35
let followDown = moveAtr <= -0.8 and tilt <= -0.35
# playbook 2 - absorption: an extended move (>= 1.2 ATR) whose volume is NOT behind it and whose last bar shows heavy effort for little result -> fade it
let absorbed = pv.effort() >= 1.8 and abs(tilt) < 0.15
let fadeUp = moveAtr >= 1.2 and absorbed
let fadeDown = moveAtr <= -1.2 and absorbed
call when ready and ((tracksMoves and loud and followUp) or fadeDown)
put when ready and ((tracksMoves and loud and followDown) or fadeUp)
confidence = clamp(52 + 10 * abs(tilt) + 6 * (pv.corrAbs(30) - 0.2), 52, 70)`
function rng(s: number) { return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 } }
const g = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r())
type Mode = 'null' | 'planted' | 'flat' | 'zero'
function gen(seed: number, mode: Mode, n = 900) {
  const r = rng(seed * 37)
  let x = 100, drift = 0, left = 0
  const out: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = []
  for (let i = 0; i < n; i++) {
    if (mode === 'planted' && left <= 0) { drift = (r() < 0.5 ? -1 : 1) * (r() < 0.5 ? 0 : 0.08); left = 8 + Math.floor(r() * 12) }
    left--
    const d = (mode === 'planted' ? drift : 0) + g(r) * 0.2
    const o = x
    x += d
    const v = mode === 'flat' ? 10 : mode === 'zero' ? 0 : mode === 'planted' ? 10 * (1 + (3 * Math.abs(d)) / 0.2 + (drift !== 0 ? 1.5 : 0)) * (0.8 + 0.4 * r()) : 10 * (0.7 + 0.6 * r())
    out.push({ time: 1_700_000_000 + i * 60, open: o, high: Math.max(o, x) + r() * 0.03, low: Math.min(o, x) - r() * 0.03, close: x, volume: v })
  }
  return out
}
const pool = (mode: Mode, exp = 2) => {
  let trades = 0, wins = 0
  for (let s = 1; s <= 20; s++) {
    const res = backtestMslScript(gen(s, mode), SCRIPT, { expiryBars: exp, warmupBars: 120 })
    assert.equal(res.ok, true)
    trades += res.trades.length
    wins += res.wins
  }
  return { trades, wr: trades ? wins / trades : 0 }
}
const evalNum = (expr: string, mode: Mode, seed = 3): number => {
  const c = gen(seed, mode)
  const res = backtestMslScript(c, `call when ${expr}`, { expiryBars: 1, warmupBars: c.length - 3 })
  assert.equal(res.ok, true)
  return res.trades.length
}

test('script parses', () => { assert.equal((parseStrategyScript as any)(SCRIPT).ok, true) })
test('pearson: perfect, inverse, and constant series', () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9)
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-9)
  assert.equal(pearson([1, 2, 3, 4], [5, 5, 5, 5]), 0)
})
test('volumeOk: true for varying volume, false for flat / zero / mostly-zero volume', () => {
  assert.equal(volumeOk(gen(1, 'null').map((c) => c.volume)), true)
  assert.equal(volumeOk(gen(1, 'flat').map((c) => c.volume)), false)
  assert.equal(volumeOk(gen(1, 'zero').map((c) => c.volume)), false)
  const sparse = gen(1, 'null').map((c, i) => (i % 3 ? 0 : c.volume))
  assert.equal(volumeOk(sparse), false)
})
test('readers: planted volume-follows-moves reads strong corrAbs; independent volume reads near zero', () => {
  let pl = 0, nu = 0
  for (let s = 1; s <= 20; s++) {
    pl += readPv(pvInput(gen(s, 'planted' as Mode) as any))!.corrAbs
    nu += Math.abs(readPv(pvInput(gen(s, 'null') as any))!.corrAbs)
  }
  assert.ok(pl / 20 > 0.4, 'planted corrAbs ' + (pl / 20).toFixed(2))
  assert.ok(nu / 20 < 0.3, 'null |corrAbs| ' + (nu / 20).toFixed(2))
})
test('flat or zero volume: every reader says 0 instead of inventing a relationship', () => {
  for (const m of ['flat', 'zero'] as Mode[]) {
    const r = readPv(pvInput(gen(2, m) as any))!
    assert.equal(r.volumeOk, false)
    for (const k of ['corrRet', 'corrAbs', 'corrLevel', 'relVol', 'tilt', 'effort'] as const) assert.equal(r[k], 0, m + ' ' + k)
  }
})
test('tilt is the volume-weighted direction (+ when up bars carry the volume)', () => {
  const c = gen(4, 'null') as any[]
  for (let i = c.length - 12; i < c.length; i++) { c[i].close = c[i - 1].close + 0.1; c[i].volume = 30 }
  assert.ok(readPv(pvInput(c), 10)!.tilt > 0.9)
})
test('MSL: pv.* callable in a script, args honoured, errors are clear', () => {
  assert.ok(evalNum('pv.ok() and pv.volumeOk()', 'null') > 0)
  assert.equal(evalNum('pv.volumeOk()', 'flat'), 0)
  assert.ok(evalNum('pv.tilt(5) >= -1 and pv.tilt(5) <= 1', 'planted') > 0)
  const bad = backtestMslScript(gen(1, 'null'), 'call when pv.nope() > 0', { expiryBars: 1, warmupBars: 100 })
  assert.ok(!bad.ok || bad.trades.length === 0)
})
test('PV 1: silent on flat and zero volume (OTC-style feeds)', () => {
  assert.equal(pool('flat').trades, 0)
  assert.equal(pool('zero').trades, 0)
})
test('PV 1: finds the planted volume-confirmed moves; on independent-volume random walks it stays inside a chance band', () => {
  const real = pool('planted')
  const nul = pool('null')
  assert.ok(real.trades >= 200, 'only ' + real.trades + ' trades')
  assert.ok(real.wr > 0.55, 'planted ' + (real.wr * 100).toFixed(1) + '% over ' + real.trades)
  assert.ok(nul.trades < 50 || (nul.wr > 0.4 && nul.wr < 0.6), 'null ' + (nul.wr * 100).toFixed(1) + '% over ' + nul.trades)
})

let pass = 0, fail = 0
for (const t of tests) {
  try { t.fn(); console.log('  ok - ' + t.name); pass++ } catch (e) { console.log('  FAIL - ' + t.name + '\n    ' + (e as Error).message); fail++ }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + tests.length + ' total')
process.exit(fail ? 1 : 0)
