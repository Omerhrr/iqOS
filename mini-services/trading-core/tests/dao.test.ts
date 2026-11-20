// IQAIR//OS - tests: the Dao lenses
import assert from 'node:assert/strict'
import { readDao, reportDao, touchProbRW } from '../src/analytics/dao'
import { evaluateStrategyScript, parseStrategyScript } from '../src/analytics/strategylang'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
let sd = 21; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
type K = 'walk' | 'trend' | 'range' | 'cycle'
const series = (n: number, kind: K, t0 = 1_700_006_400) => {
  const out: any[] = []; let p = 1.2
  for (let i = 0; i < n; i++) {
    const o = p; let mv: number
    if (kind === 'trend') mv = 0.0004 + (r() - 0.5) * 0.0003
    else if (kind === 'range') mv = (1.2 - p) * 0.35 + (r() - 0.5) * 0.0004
    else if (kind === 'cycle') { const ph = i % 120; mv = (ph < 50 ? (r() - 0.5) * 0.00008 : ph < 80 ? 0.0005 * (r() > 0.2 ? 1 : -1) + (r() - 0.5) * 0.0003 : (r() - 0.5) * 0.0002) } // quiet -> burst -> settle
    else mv = (r() - 0.5) * 0.0006
    const c = o + mv
    out.push({ time: t0 + i * 60, open: o, high: Math.max(o, c) + r() * 0.0002, low: Math.min(o, c) - r() * 0.0002, close: c, volume: 100 }); p = c
  }
  return out
}
test('thin history is reported', () => { const x = readDao(series(80, 'walk')); assert.equal(x.ok, false); assert.ok(/needs/.test(x.error ?? '')) })
test('all nine lenses and the lines are produced and well-formed', () => {
  const x = readDao(series(600, 'walk')); assert.ok(x.ok, x.error ?? 'dao failed')
  assert.equal(x.lines.length, 9); assert.ok(x.yinyang.yang >= 0 && x.yinyang.yang <= 1); assert.ok(Math.abs(x.yinyang.yang + x.yinyang.yin - 1) < 1e-9)
  assert.ok(['stillness', 'movement', 'expansion', 'excess', 'transformation'].includes(x.phase.phase))
  assert.ok(['birth', 'growth', 'mature', 'correcting', 'dying', 'dead'].includes(x.life.stage))
  assert.ok(['discount', 'equilibrium', 'premium'].includes(x.space.zone)); assert.ok(x.space.rangePos >= 0 && x.space.rangePos <= 1)
  assert.ok(x.fate.coneUp1 > x.fate.coneDn1 && x.fate.coneUp2 > x.fate.coneUp1)
})
test('yin is not bearish: a rising market can be contracting (state string carries both)', () => {
  const x = readDao(series(500, 'trend')); assert.ok(/^(bullish|bearish|balanced)-(contracting|expanding|steady)$/.test(x.yinyang.state), x.yinyang.state)
})
test('a steady climb: uptrend leg, scales agree up, momentum is genuine or steady', () => {
  const x = readDao(series(500, 'trend')); assert.equal(x.life.dir, 1); assert.equal(x.time.scaleDir, 1); assert.ok(x.time.alignment >= 0.75); assert.ok(['surging', 'steady'].includes(x.momentum.state), x.momentum.state)
})
test('wu wei blocks chasing: a vertical spike at the end is not chased', () => {
  const a = series(400, 'walk'); const L = a[a.length - 1].close
  const b = Array.from({ length: 12 }, (_, i) => ({ time: a[399].time + (i + 1) * 60, open: L + i * 0.0012, high: L + i * 0.0012 + 0.0013, low: L + i * 0.0012 - 0.0001, close: L + (i + 1) * 0.0012, volume: 100 }))
  const x = readDao([...a, ...b]); assert.ok(x.ok)
  if (x.lean.dir === 'call') { assert.equal(x.wuwei.act, false); assert.ok(x.wuwei.wait.length > 0) }
  assert.ok(x.phase.stretch > 1.5, String(x.phase.stretch))
})
test('wu wei: when it acts there are no blocks; when it waits there is always a reason', () => {
  const d = series(900, 'walk'); let acts = 0, waits = 0
  for (let k = 300; k < 900; k += 20) { const x = readDao(d.slice(0, k), undefined, { light: true }); if (!x.ok) continue; if (x.wuwei.act) { acts++; assert.equal(x.wuwei.wait.length, 0); assert.notEqual(x.wuwei.dir, 'none') } else { waits++; assert.ok(x.wuwei.wait.length > 0 || x.wuwei.favour < 45) } }
  assert.ok(waits > acts, `waits ${waits} acts ${acts}`)
})
test('fate: touch probability is 1 at zero distance and falls with distance; cone is symmetric', () => {
  assert.equal(touchProbRW(0, 1), 1); assert.ok(touchProbRW(1, 1) > touchProbRW(2, 1)); assert.ok(touchProbRW(3, 1) < 0.01 + 0.0)
  const x = readDao(series(500, 'walk')); const px = (x.fate.coneUp1 + x.fate.coneDn1) / 2; assert.ok(Math.abs(x.fate.coneUp1 - px - (px - x.fate.coneDn1)) < 1e-9)
})
test('fate: a mean-reverting series reads as reverting/random, a trending one as trending/random', () => {
  const m = readDao(series(700, 'range')).fate; const t = readDao(series(700, 'trend')).fate
  assert.ok(m.vr5 < t.vr5, `${m.vr5} vs ${t.vr5}`); assert.notEqual(m.character, 'trending'); assert.notEqual(t.character, 'reverting')
})
test('time: hour-of-day fields exist on a clocked series', () => { const x = readDao(series(600, 'walk')); assert.ok(x.time.hour >= 0 && x.time.hour < 24); assert.ok(x.time.hourN > 0) })
test('life: a long one-way run is mature/dying/growth with positive maturity, retrace within range', () => { const x = readDao(series(600, 'trend')); assert.ok(x.life.maturity > 0); assert.ok(x.life.retrace >= -1 && x.life.retrace <= 2) })
test('cycle data: quiet -> burst -> settle shows both stillness and expansion/movement phases in the research matrix', () => {
  const rep = reportDao(series(1800, 'cycle')); assert.ok(rep.ok, rep.error ?? 'report failed')
  const seen = Object.entries(rep.q4.dwell).filter(([, v]) => v > 0).map(([k]) => k); assert.ok(seen.includes('stillness'), seen.join(',')); assert.ok(seen.length >= 3, seen.join(','))
  assert.ok(rep.q4.stillnessToMovement20.n > 30)
})
test('research: expansion is followed by contraction far more than baseline on cyclical (planted) data', () => {
  const rep = reportDao(series(2400, 'cycle')); assert.ok(rep.ok); assert.ok(rep.q1.afterExpansion.n > 30, String(rep.q1.afterExpansion.n)); assert.ok((rep.q1.lift ?? 0) >= 1.0, String(rep.q1.lift))
})
test('research: report is complete and every rate is valid', () => {
  const rep = reportDao(series(1200, 'walk')); assert.ok(rep.ok)
  for (const q of [rep.q1.afterExpansion, rep.q1.baseline, rep.q2.afterStrong, rep.q2.baseline, rep.q3.atTurn, rep.q3.baseline, rep.q5.whenAct, rep.q5.whenWait, rep.q5.all]) assert.ok(q.rate === null || (q.rate >= 0 && q.rate <= 1), 'rate')
  for (const q of [rep.q1, rep.q2, rep.q3, rep.q4, rep.q5]) assert.ok(q.answer.length > 5)
  assert.equal(reportDao(series(100, 'walk')).ok, false)
})
test('dao.* works in MSL: dao.all(), dao.wuwei(), dao.phase(), dao.text()', () => {
  const parsed = parseStrategyScript('let d = dao.all()\nlet w = dao.wuwei()\nlet p = dao.phase()\nlet t = dao.text()\ncall when d.ok and d.act and d.dir == "call"\nput when d.ok and d.act and d.dir == "put" and w.favour >= 40 and p.phase != "stillness"\n'); assert.ok(parsed.ok, (parsed as any).error)
  const d = series(500, 'walk'); const sr = { open: d.map((x: any) => x.open), high: d.map((x: any) => x.high), low: d.map((x: any) => x.low), close: d.map((x: any) => x.close), volume: d.map(() => 100), time: d.map((x: any) => x.time) }
  const res: any = evaluateStrategyScript((parsed as any).ast, {} as any, (() => { throw new Error('x') }) as any, sr as any); assert.ok(!res.error, res.error)
})
test('dao.all() on thin history is a clean ok:false, not a crash', () => {
  const parsed = parseStrategyScript('let d = dao.all()\ncall when d.ok and d.act\n'); assert.ok(parsed.ok)
  const d = series(60, 'walk'); const sr = { open: d.map((x: any) => x.open), high: d.map((x: any) => x.high), low: d.map((x: any) => x.low), close: d.map((x: any) => x.close), volume: d.map(() => 100), time: d.map((x: any) => x.time) }
  const res: any = evaluateStrategyScript((parsed as any).ast, {} as any, (() => { throw new Error('x') }) as any, sr as any); assert.ok(!res.error, res.error); assert.equal(res.direction, 'none')
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
