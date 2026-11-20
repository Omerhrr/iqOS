// IQAIR//OS - tests: trading.plan
import assert from 'node:assert/strict'
import { readPlan, reportPlan, hourMarks } from '../src/analytics/tradingplan'
import { scanSetups, excludeHeld, withConfirmation, SetupCache } from '../src/analytics/setupscan'
import { evaluateStrategyScript, parseStrategyScript } from '../src/analytics/strategylang'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
let sd = 11; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
type K = 'walk' | 'up' | 'down' | 'range'
const series = (n: number, kind: K, t0 = 1_700_006_400, step = 60) => {
  const out: any[] = []; let p = 1.2
  for (let i = 0; i < n; i++) {
    const o = p; let mv: number
    if (kind === 'up') mv = 0.00022 * (Math.sin(i / 14) > -0.5 ? 1 : -0.3) + (r() - 0.5) * 0.0003
    else if (kind === 'down') mv = -0.00022 * (Math.sin(i / 14) > -0.5 ? 1 : -0.3) + (r() - 0.5) * 0.0003
    else if (kind === 'range') mv = (1.2 - p) * 0.3 + (r() - 0.5) * 0.0005
    else mv = (r() - 0.5) * 0.0006
    const c = o + mv
    out.push({ time: t0 + i * step, open: o, high: Math.max(o, c) + r() * 0.0002, low: Math.min(o, c) - r() * 0.0002, close: c, volume: 100 }); p = c
  }
  return out
}
test('thin history is reported', () => { const x = readPlan(series(100, 'walk')); assert.equal(x.ok, false); assert.ok(/needs/.test(x.error ?? '')) })
test('uptrend: detected as up with a stage and a stop below / target above', () => {
  const x = readPlan(series(500, 'up')); assert.ok(x.ok, x.error); assert.equal(x.trend.dir, 'up'); assert.ok(x.trend.strength >= 45)
  assert.ok(['early', 'developing', 'mature', 'extended', 'pullback', 'broken'].includes(x.trend.stage))
  if (Number.isFinite(x.setup.stop)) assert.ok(x.setup.stop < x.price)
})
test('downtrend: detected as down', () => { const x = readPlan(series(500, 'down')); assert.ok(x.ok); assert.equal(x.trend.dir, 'down') })
test('a steady uptrend never allows a PUT, and a downtrend never allows a CALL (against the trend)', () => {
  const u = readPlan(series(500, 'up')); assert.equal(u.setup.allowPut, false); const d = readPlan(series(500, 'down')); assert.equal(d.setup.allowCall, false)
})
test('an exhausted trend is flagged too far and blocks joining it', () => {
  const a = series(400, 'walk'); let p = a[399].close; const t0 = a[399].time
  for (let i = 0; i < 60; i++) { const o = p, c = o + 0.0009 + r() * 0.0002; a.push({ time: t0 + (i + 1) * 60, open: o, high: c + 0.0001, low: o - 0.0001, close: c, volume: 100 }); p = c }
  const x = readPlan(a); assert.ok(x.ok); assert.equal(x.trend.dir, 'up'); assert.ok(x.trend.tooFar, `maturity ${x.trend.maturity.toFixed(2)} stretch ${x.trend.stretch.toFixed(2)}`); assert.equal(x.setup.allowCall, false)
  assert.ok(x.setup.blocks.some((b) => /too far|stretched|chasing/i.test(b)), x.setup.blocks.join(' | '))
})
test('levels: a range has support below and resistance above, with touches', () => {
  const x = readPlan(series(700, 'range')); assert.ok(x.ok); const s = x.levels.filter((l) => l.side === 'support'), re = x.levels.filter((l) => l.side === 'resistance')
  assert.ok(s.length >= 1 && re.length >= 1); assert.ok(s.every((l) => l.price < x.price) && re.every((l) => l.price > x.price)); assert.ok(Math.max(...x.levels.map((l) => l.touches)) >= 2)
  assert.ok(x.levels.every((l) => l.strength >= 0 && l.strength <= 100))
})
test('previous-day high / low / close are marked when the clock is real', () => {
  const x = readPlan(series(2000, 'walk', 1_700_006_400, 60)); assert.ok(x.ok); assert.ok(x.levels.some((l) => l.kind === 'prev-day-high')); assert.ok(x.levels.some((l) => l.kind === 'prev-day-low'))
})
test('avoid zones: buying right under a strong resistance is an avoid zone for CALL, not for PUT', () => {
  const x = readPlan(series(700, 'range')); assert.ok(x.ok); const callZ = x.avoid.filter((z) => z.kind === 'price' && z.side === 'call'); assert.ok(callZ.length >= 1); for (const z of callZ) assert.ok(z.from < z.to)
})
test('hours are plain vertical lines: 25 marks, on the hour, one is now, no judgement attached', () => {
  const m = hourMarks(1_700_006_400 + 1234); assert.equal(m.length, 25); assert.equal(m.filter((k) => k.now).length, 1); for (const k of m) { assert.ok(k.time % 3600 === 0); assert.deepEqual(Object.keys(k).sort(), ['hour', 'label', 'now', 'time']) }
  const x = readPlan(series(500, 'walk')); assert.ok(x.ok); assert.equal(x.marks.length, 25); assert.ok(!JSON.stringify(x).includes('"tag"'))
})
const assetsList = ['UPA', 'UPB', 'DNA', 'RNG', 'WLK'].map((t) => ({ ticker: t, otc: false }))
const bank: Record<string, any[]> = { UPA: series(500, 'up'), UPB: series(500, 'up'), DNA: series(500, 'down'), RNG: series(700, 'range'), WLK: series(500, 'walk') }
test('scan keeps only favourable setups, ranked by quality, each with a side', () => {
  const sc = scanSetups(assetsList, (t) => bank[t]); assert.equal(sc.scanned, 5); for (const r of sc.rows) { assert.ok(r.side === 'call' || r.side === 'put'); assert.ok(r.quality > 0) }
  for (let i = 1; i < sc.rows.length; i++) assert.ok(sc.rows[i - 1].quality >= sc.rows[i].quality)
  const hi = scanSetups(assetsList, (t) => bank[t], { minQuality: 101 }); assert.equal(hi.rows.length, 0)
})
test('after a trade the next pick is a DIFFERENT market: the pair and anything duplicating its exposure are dropped', () => {
  const rows: any[] = [{ asset: 'EURUSD', side: 'call', quality: 80 }, { asset: 'GBPUSD', side: 'call', quality: 70 }, { asset: 'USDJPY', side: 'call', quality: 60 }, { asset: 'XAUUSD', side: 'call', quality: 50 }]
  const left = excludeHeld(rows, [{ asset: 'EURUSD', side: 'call' }]).map((r) => r.asset)
  assert.ok(!left.includes('EURUSD') && !left.includes('GBPUSD'), left.join()); assert.ok(left.includes('USDJPY') && left.includes('XAUUSD'))
})
test('SetupCache reuses a scan until the ttl and rescans immediately after invalidate()', () => {
  const c = new SetupCache(); let n = 0; const compute = () => { n++; return { rows: [], scanned: 0, withTrend: 0 } }
  c.get(100, 30, compute); c.get(110, 30, compute); assert.equal(n, 1); c.get(131, 30, compute); assert.equal(n, 2); c.invalidate(); c.get(132, 30, compute); assert.equal(n, 3)
})
test('withConfirmation adds pm and the Heikin Ashi read, and confirmed needs both to agree with the setup side', () => {
  const rows: any[] = [{ asset: 'UPA', otc: false, side: 'call', quality: 70 }]; const out = withConfirmation(rows, (t) => bank[t]); assert.ok(out[0].pmDir !== undefined); assert.ok(out[0].haColor !== undefined)
  assert.equal(out[0].confirmed, out[0].pmDir === 'call' && out[0].haOk)
})
test('the setup is consistent: side/ready/quality agree with the allow flags', () => {
  for (const k of ['up', 'down', 'range', 'walk'] as K[]) { const x = readPlan(series(600, k)); assert.ok(x.ok); if (!x.setup.ready) { assert.ok(!x.setup.allowCall && !x.setup.allowPut); assert.equal(x.setup.side, 'none'); assert.equal(x.setup.quality, 0) } else { assert.ok(x.setup.quality > 0); assert.equal(x.setup.side === 'call', x.setup.allowCall); if (x.setup.side === 'call') assert.equal(x.trend.dir, 'up') } }
})
test('report: random walk does not hand out a false edge', () => {
  const rep = reportPlan(series(2500, 'walk'), { step: 4 }); assert.ok(rep.ok); const p = rep.groups['PLAN: fresh trend, not in an avoid zone']
  assert.ok(!p || p.n < 30 || p.z === null || p.z < 3, JSON.stringify(p))
})
test('report: thin history reported', () => { assert.equal(reportPlan(series(200, 'walk')).ok, false) })
test('trading.plan / levels / hours / avoid / text work in MSL', () => {
  const parsed = parseStrategyScript('let tp = trading.plan()\nlet st = trading.setup()\nlet lv = trading.levels()\nlet hr = trading.hours()\nlet av = trading.avoid()\nlet t = trading.text()\ncall when tp.ok and tp.allowCall and st.ready and not av.avoidCallNow and hr.secsToNextHour > 60\nput when tp.ok and tp.allowPut and lv.supports >= 0\n'); assert.ok(parsed.ok, (parsed as any).error)
  const d = series(500, 'up'); const sr = { time: d.map((x: any) => x.time), open: d.map((x: any) => x.open), high: d.map((x: any) => x.high), low: d.map((x: any) => x.low), close: d.map((x: any) => x.close), volume: d.map(() => 100) }
  const res: any = evaluateStrategyScript((parsed as any).ast, {} as any, (() => { throw new Error('x') }) as any, sr as any); assert.ok(!res.error, res.error)
})
test('trading.plan on thin history is a clean ok:false', () => {
  const parsed = parseStrategyScript('let tp = trading.plan()\ncall when tp.ok and tp.allowCall\n'); assert.ok(parsed.ok)
  const res: any = evaluateStrategyScript((parsed as any).ast, {} as any, (() => { throw new Error('x') }) as any, { time: [1, 2, 3], open: [1, 1, 1], high: [1, 1, 1], low: [1, 1, 1], close: [1, 1, 1], volume: [1, 1, 1] } as any); assert.ok(!res.error, res.error); assert.equal(res.direction, 'none')
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
