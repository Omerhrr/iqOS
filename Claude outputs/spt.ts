import assert from 'node:assert/strict'
import { readSp, readSsp, type SpPoint } from '../src/analytics/sp'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const T0 = 1_700_000_000
// path of a 60 s candle sampled every 5 s: drift per step (ATR units) for the first n steps, then optional burst steps
const path = (drift: number, steps: number, burst: number[] = []): SpPoint[] => { const out: SpPoint[] = []; let p = 100; for (let i = 1; i <= steps; i++) { p += drift; out.push({ t: T0 + i * 5, p }) } burst.forEach((b, k) => { p += b; out.push({ t: T0 + (steps + 1 + k) * 5, p }) }); return out }
const run = (pts: SpPoint[], trend = 0, extra = {}) => readSp(pts, { open: 100, openSec: T0, nowSec: pts[pts.length - 1].t, tfSec: 60, atr: 1, trend, ...extra })
test('1 pressure up + shock up -> put', () => { const r = run(path(0.03, 6, [0.35, 0.2])); assert.equal(r.caseNo, 1); assert.equal(r.direction, 'put') })
test('2 pressure down + shock down -> call', () => { const r = run(path(-0.03, 6, [-0.35, -0.2])); assert.equal(r.caseNo, 2); assert.equal(r.direction, 'call') })
test('3 pressure up + shock down -> no call (case removed)', () => { const r = run(path(0.04, 6, [-0.3, -0.25])); assert.equal(r.shockDir, -1); assert.equal(r.pressureDir, 1); assert.equal(r.caseNo, 0); assert.equal(r.direction, 'none') })
test('4 pressure down + shock up -> no call (case removed)', () => { const r = run(path(-0.04, 6, [0.3, 0.25])); assert.equal(r.caseNo, 0); assert.equal(r.direction, 'none') })
const runSsp = (pts: SpPoint[], trend = 0, extra = {}) => readSsp(pts, { open: 100, openSec: T0, nowSec: pts[pts.length - 1].t, tfSec: 60, atr: 1, trend, ...extra })
test('sp: pressure with NO shock is no call any more (case 5 moved to SSP)', () => { const r = run(path(0.03, 10), 1); assert.equal(r.shock, false); assert.equal(r.caseNo, 0); assert.equal(r.direction, 'none') })
test('ssp: pressure, no shock -> with the trend (up)', () => { const r = runSsp(path(0.03, 10), 1); assert.equal(r.shock, false); assert.equal(r.caseNo, 5); assert.equal(r.direction, 'call') })
test('ssp: down trend, up pressure still trades the TREND', () => { const r = runSsp(path(0.03, 10), -1); assert.equal(r.caseNo, 5); assert.equal(r.direction, 'put') })
test('ssp: no clear trend -> no call', () => { const r = runSsp(path(0.03, 10), 0); assert.equal(r.direction, 'none'); assert.match(r.text, /no clear trend/) })
test('ssp: a shock present -> no call (that is story.sp)', () => { const r = runSsp(path(0.03, 6, [0.35, 0.2]), 1); assert.equal(r.direction, 'none') })
test('no pressure (flat) -> no call even with a shock', () => { const pts = path(0, 6, [0.4, 0.2]); const r = run(pts); assert.equal(r.direction, 'none') })
test('choppy path has no steady pressure', () => { const pts: SpPoint[] = []; let p = 100; for (let i = 1; i <= 10; i++) { p += i % 2 ? 0.12 : -0.12; pts.push({ t: T0 + i * 5, p }) } assert.equal(run(pts, 1).pressure, false) })
test('an old burst is history, not the ongoing shock', () => { const pts: SpPoint[] = []; let p = 100; pts.push({ t: T0 + 5, p: (p += 0.5) }); pts.push({ t: T0 + 10, p: (p += 0.2) }); for (let i = 3; i <= 12; i++) pts.push({ t: T0 + i * 5, p: (p += 0.02) }); const r = run(pts, 1); assert.equal(r.shock, false) })
test('too little path is a clean error', () => { const r = run([{ t: T0 + 5, p: 100.1 }]); assert.equal(r.ok, false) })
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
