import assert from 'node:assert/strict'
import { stepSage, sageKey, sageStats, sageText, clearSage, type SageInput } from '../src/analytics/sage'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const base = { cond: true, valid: true, dir: 1, seconds: 30, dipAtr: 0.15, abortAtr: 0.5, goAtr: 0.1, recoverFrac: 0.4, straightTake: true, horizonSec: 60, atr: 1 }
let k = 0
const run = (key: string, steps: Array<[number, number, Partial<SageInput>?]>) => { let last = stepSage({ ...base, ...(steps[0]?.[2] ?? {}), key, nowMs: 0, price: 100 }); const fires: number[] = []; for (const [t, px, o] of steps) { last = stepSage({ ...base, ...o, key, nowMs: t * 1000, price: px }); if (last.fire) fires.push(t) } return { last, fires } }
const K = () => sageKey('sg', 'n' + k++)
test('straight move is TAKEN at once, never skipped (survivorship)', () => { const r = run(K(), [[2, 100.05], [4, 100.2]]); assert.deepEqual(r.fires, [4]); assert.equal(r.last.rec.cls, 'straight') })
test('shallow dip then turn + valid -> enters on the turn at a better price', () => { const r = run(K(), [[3, 99.8], [6, 99.75], [9, 99.9]]); assert.deepEqual(r.fires, [9]); assert.equal(r.last.rec.cls, 'dip'); assert.ok(r.last.rec.entryGain > 0.05) })
test('does not buy the falling knife: still falling = no entry', () => { const r = run(K(), [[3, 99.8], [6, 99.7], [9, 99.65]]); assert.deepEqual(r.fires, []) })
test('dip turns but re-check fails -> no entry, aborts at timeout', () => { const r = run(K(), [[3, 99.8], [6, 99.75], [10, 99.95, { valid: false }], [31, 99.95, { valid: false }]]); assert.deepEqual(r.fires, []); assert.equal(r.last.rec.state, 'aborted') })
test('deep dip = reversal, aborts early', () => { const r = run(K(), [[3, 99.8], [6, 99.4], [9, 100.0]]); assert.deepEqual(r.fires, []); assert.match(r.last.rec.why, /too deep/) })
test('signal vanishing aborts', () => { const r = run(K(), [[3, 99.8], [6, 99.9, { cond: false }]]); assert.deepEqual(r.fires, []) })
test('straight = skip setting skips the strong move', () => { const r = run(K(), [[3, 100.3, { straightTake: false }]]); assert.deepEqual(r.fires, []) })
test('put side mirrors', () => { const r = run(K(), [[3, 100.2, { dir: -1 }], [6, 100.25, { dir: -1 }], [9, 100.1, { dir: -1 }]]); assert.deepEqual(r.fires, [9]) })
test('skipped signals are resolved counterfactually (measures missed winners)', () => { const key = K(); run(key, [[3, 99.4], [200, 101]]); const s = sageStats(key); const sk = Object.entries(s).find(([n]) => n.startsWith('skip:')); assert.ok(sk && sk[1].n === 1 && sk[1].w === 1); assert.match(sageText(key), /skipped signals that would have won 1\/1/) })
test('learned gate: dip entries that keep losing get refused', () => {
  const key = K(); const lose = () => { run(key, [[3, 99.8], [6, 99.75], [9, 99.9]]); stepSage({ ...base, cond: false, key, nowMs: 10_000, price: 99.9 }); stepSage({ ...base, cond: false, key, nowMs: 12_000, price: 99.9 }); stepSage({ ...base, cond: false, key, nowMs: 80_000, price: 99.0 }) }
  for (let i = 0; i < 16; i++) lose()
  const b = sageStats(key)['take:dip']; assert.ok(b && b.n >= 15 && b.w === 0)
  const r = run(key, [[3, 99.8], [6, 99.75], [9, 99.9]]); assert.deepEqual(r.fires, []); assert.match(r.last.rec.why, /learned/)
})
test('RETOUCH: dipped, then price touches the signal price again -> enters immediately (before the recovery rule would)', () => { const r = run(K(), [[3, 99.8], [6, 99.82], [9, 100.0]]); assert.deepEqual(r.fires, [9]); assert.equal(r.last.rec.cls, 'retouch'); assert.equal(r.last.rec.entryGain, 0) })
test('RETOUCH off: same path falls back to the normal dip rule', () => { const r = run(K(), [[3, 99.8, { retouch: false }], [6, 99.75, { retouch: false }], [9, 100.0, { retouch: false }]]); assert.equal(r.last.rec.cls, 'dip') })
test('RETOUCH needs a dip first: no dip + back at entry is not a retouch', () => { const r = run(K(), [[3, 99.95], [6, 100.0]]); assert.notEqual(r.last.rec.cls, 'retouch') })
test('RETOUCH does not rescue a reversal: deep dip still aborts', () => { const r = run(K(), [[3, 99.8], [6, 99.4], [9, 100.0]]); assert.deepEqual(r.fires, []) })
test('RETOUCH needs the signal still on', () => { const r = run(K(), [[3, 99.8], [9, 100.0, { cond: false }]]); assert.deepEqual(r.fires, []) })
clearSage('sg')
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
