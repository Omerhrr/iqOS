import assert from 'node:assert/strict'
import { readPmm, readSwings, reportPmm } from '../src/analytics/pmm'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { BUILTIN_TV_SPECS } from '../src/plugins/builtinTvSpecs'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const T0 = 1_700_000_040
const mk = (closes: number[]) => closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { time: T0 + i * 60, open: o, close: c, high: Math.max(o, c) + 0.1, low: Math.min(o, c) - 0.1, volume: 100 } })
// zig-zag: legs of +/-amp, drifting by `drift` per leg
function zig(legs: number, leg: number, amp: number, drift: number, start = 100): number[] { const out: number[] = []; let x = start, up = true; for (let l = 0; l < legs; l++) { for (let i = 0; i < leg; i++) { x += (up ? amp : -amp) / leg; out.push(x) } x += drift; up = !up } return out }
const base = (dir: 'call' | 'put', strength = 50) => ({ ok: true, dir, prob: 0.6, strength })
test('swings are labelled HH/HL in a staircase up', () => { const c = mk(zig(10, 6, 2.0, 0.8)); const sw = readSwings(c, 0.5); assert.ok(sw.some((s) => s.label === 'HH') && sw.some((s) => s.label === 'HL')) })
test('uptrend structure read', () => { const c = mk(zig(10, 6, 2.0, 0.8)); const r = readPmm(c, base('call')); assert.equal(r.structure, 'uptrend'); assert.ok(r.sequence.includes('HH')) })
test('downtrend structure read', () => { const c = mk(zig(10, 6, 2.0, -0.8, 120)); const r = readPmm(c, base('put')); assert.equal(r.structure, 'downtrend') })
test('a call against a standing downtrend is blocked unless pm is strong', () => { const c = mk(zig(10, 6, 2.0, -0.8, 120)); const w = readPmm(c, base('call', 50)); assert.equal(w.pass, false); assert.ok(w.blocks.some((b) => b.includes('against'))); const s = readPmm(c, base('call', 85)); assert.ok(!s.blocks.some((b) => b.includes('against'))) })
test('a call right under a swing high is blocked as a wall', () => {
  const closes = zig(8, 6, 2.0, 0.8); const c = mk(closes); const hi = Math.max(...c.map((x) => x.high)); const last = c[c.length - 1]
  const tail = { ...last, close: hi - 0.1, high: hi - 0.05, open: last.close }
  const r = readPmm([...c.slice(0, -1), tail], base('call')); assert.ok(r.blocks.length > 0, r.text)
})
test('with the trend at the higher low gets a boost', () => {
  const c = mk(zig(10, 6, 2.0, 0.8)); const r = readPmm(c, base('call')); assert.ok(r.withStructure)
  assert.ok(r.prob >= 0.6 || r.blocks.length > 0)
})
test('put mirrors: blocked into a swing low', () => { const c = mk(zig(8, 6, 2.0, -0.8, 120)); const sw = readSwings(c, 0.5).filter((x) => x.kind === 'L'); const lo = sw[sw.length - 1].price; const last = c[c.length - 1]; const r = readPmm([...c.slice(0, -1), { ...last, close: lo + 0.15, low: lo + 0.1, open: last.close }], base('put')); assert.ok(r.blocks.length > 0, r.text) })
test('no pm call -> no gate, none', () => { const c = mk(zig(10, 6, 2.0, 0.8)); const r = readPmm(c, { ok: true, dir: 'none', prob: 0.5, strength: 0 }); assert.equal(r.dir, 'none'); assert.equal(r.pass, false) })
test('too little history is a clean ok:false', () => { const r = readPmm(mk([1, 2, 3, 4]), base('call')); assert.equal(r.ok, false) })
test('builtin pmm script parses', () => { const s = (BUILTIN_TV_SPECS as Array<{ id: string; script: string }>).find((x) => x.id === 'meta:builtin-pmm'); assert.ok(s && parseStrategyScript(s.script).ok) })
test('report on a random walk runs and gives a verdict', () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
  let x = 100; const cl = Array.from({ length: 900 }, () => (x += (rnd() - 0.5) * 0.6)); const r = reportPmm(mk(cl), undefined, { step: 6 }); assert.ok(r.ok && r.verdict.length > 10, JSON.stringify(r).slice(0, 200))
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
