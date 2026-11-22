import assert from 'node:assert/strict'
import { stepLimit, limitKey, limitStats, limitText, clearLimit, pickLevel, kindsFor, type LimitInput, type Level } from '../src/analytics/sagelimit'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const demand: Level = { kind: 'demand', label: 'SUPPLY_DEMAND', edge: 99.5, far: 99.2, touches: 0, barsAgo: 5 }
const base = { cond: true, valid: true, dir: 1, seconds: 60, mode: 'reject' as const, where: 'auto' as string | number, maxAtr: 1.5, breakAtr: 0.25, reactAtr: 0.1, runAtr: 0.8, horizonSec: 60, atr: 1, book: () => [demand] }
let k = 0
const K = () => limitKey('lm', 'n' + k++)
const run = (key: string, steps: Array<[number, number, Partial<LimitInput>?]>) => { let last = stepLimit({ ...base, ...(steps[0]?.[2] ?? {}), key, nowMs: 0, price: 100 }); const fires: number[] = []; for (const [t, px, o] of steps) { last = stepLimit({ ...base, ...o, key, nowMs: t * 1000, price: px }); if (last.fire) fires.push(t) } return { last, fires } }
test('rests at the zone, does nothing while price is above it', () => { const r = run(K(), [[3, 99.9], [6, 99.8]]); assert.deepEqual(r.fires, []); assert.equal(r.last.rec.state, 'resting'); assert.equal(r.last.rec.level?.kind, 'demand') })
test('touch mode: enters the moment price reaches the zone edge, at a better price', () => { const r = run(K(), [[3, 99.8], [6, 99.5, { mode: 'touch' }]]); assert.deepEqual(r.fires, [6]); assert.ok(r.last.rec.entryGain > 0.4) })
test('reject mode: touch alone does not enter; the turn back out does', () => { const r = run(K(), [[3, 99.6], [6, 99.45], [9, 99.4], [12, 99.55]]); assert.deepEqual(r.fires, [12]); assert.equal(r.last.rec.cls, 'reject') })
test('reject mode: still falling inside the zone = no entry (no falling knife)', () => { const r = run(K(), [[3, 99.5], [6, 99.4], [9, 99.35]]); assert.deepEqual(r.fires, []); assert.equal(r.last.rec.state, 'touched') })
test('price goes THROUGH the zone -> level broken, cancelled', () => { const r = run(K(), [[3, 99.5], [6, 98.9], [9, 99.6]]); assert.deepEqual(r.fires, []); assert.match(r.last.rec.why, /broken/) })
test('price runs away our way without touching -> not chased, cancelled', () => { const r = run(K(), [[3, 100.4], [6, 100.9]]); assert.deepEqual(r.fires, []); assert.match(r.last.rec.why, /ran/) })
test('never reached in time -> cancelled (expired)', () => { const r = run(K(), [[10, 99.9], [61, 99.95]]); assert.deepEqual(r.fires, []); assert.match(r.last.rec.why, /never reached/) })
test('signal gone cancels', () => { const r = run(K(), [[3, 99.9], [6, 99.8, { cond: false }]]); assert.deepEqual(r.fires, []); assert.match(r.last.rec.why, /signal gone/) })
test('re-check failing at the turn holds the entry back', () => { const r = run(K(), [[3, 99.5], [6, 99.4], [9, 99.55, { valid: false }]]); assert.deepEqual(r.fires, []) })
test('put side mirrors (resistance above)', () => { const sup: Level = { kind: 'supply', label: 'SD', edge: 100.5, far: 100.8, touches: 0, barsAgo: 3 }; const o = { dir: -1, book: () => [sup] }; const r = run(K(), [[3, 100.3, o], [6, 100.55, o], [9, 100.6, o], [12, 100.45, o]]); assert.deepEqual(r.fires, [12]) })
test('explicit price level works with no book', () => { const o = { where: 99.7 as string | number, book: () => [] as Level[] }; const r = run(K(), [[3, 99.8, o], [6, 99.65, { ...o, mode: 'touch' as const }]]); assert.deepEqual(r.fires, [6]); assert.equal(r.last.rec.level?.kind, 'price') })
test('no level within reach -> stays idle with a reason, retries later', () => { const far: Level = { ...demand, edge: 95, far: 94.5 }; const r = run(K(), [[3, 100, { book: () => [far] }]]); assert.equal(r.last.rec.state, 'idle'); assert.match(r.last.rec.why, /no .*level within/) })
test('pickLevel prefers a proven nearby zone and respects where', () => { const a: Level = { kind: 'fvg', label: 'F', edge: 99.7, far: 99.5, touches: 0, barsAgo: 2 }; const b: Level = { kind: 'ob', label: 'O', edge: 99.6, far: 99.3, touches: 0, barsAgo: 2 }; assert.equal(pickLevel([a, b], 1, 100, 1, 'auto', 1.5, () => undefined).level?.kind, 'ob'); assert.equal(pickLevel([a, b], 1, 100, 1, 'fvg', 1.5, () => undefined).level?.kind, 'fvg'); assert.equal(pickLevel([a, b], 1, 100, 1, 'sd', 1.5, () => undefined).level, null) })
test('kindsFor groups', () => { assert.ok(kindsFor('sd').has('demand') && !kindsFor('sd').has('ob')); assert.ok(kindsFor('sr').has('msnr')) })
test('a kind that keeps losing is refused by the learned gate', () => { const res = pickLevel([demand], 1, 100, 1, 'auto', 1.5, () => ({ n: 20, w: 3 })); assert.equal(res.level, null); assert.deepEqual(res.refused, ['demand']) })
test('cancelled signals are resolved counterfactually, per kind', () => { const key = K(); run(key, [[3, 100.4], [6, 100.9], [200, 102]]); const sk = Object.entries(limitStats(key)).find(([n]) => n.startsWith('skip:runaway:demand')); assert.ok(sk && sk[1].n === 1 && sk[1].w === 1); assert.match(limitText(key), /demand: taken none yet, cancelled ones that would have won 1\/1/) })
clearLimit('lm')
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
