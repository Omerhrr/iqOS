// IQAIR//OS - tests: CFD plan, sizing, story.cfd()
import assert from 'node:assert/strict'
import { readCfdPlan, cfdSize } from '../src/analytics/cfdplan'
import { evaluateStrategyScript, parseStrategyScript } from '../src/analytics/strategylang'
import { sanitizeCfdConfig, DEFAULT_CFD_TRADER } from '../src/plugins/cfdtrader'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
let sd = 11; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
const walk = (n: number) => { const out: any[] = []; let p = 1.1; for (let i = 0; i < n; i++) { const o = p, c = o + (r() - 0.48) * 0.0008, h = Math.max(o, c) + r() * 0.0003, l = Math.min(o, c) - r() * 0.0003; out.push({ time: 1_700_000_000 + i * 60, open: o, high: h, low: l, close: c, volume: 100 + r() * 100 }); p = c } return out }
test('plan levels sit on the right side and rr/ev are consistent', () => {
  let found = 0
  const d = walk(500)
  for (let k = 120; k < 500; k += 7) {
    const p = readCfdPlan(d.slice(0, k), undefined, null, { htfTf: 'none' })
    if (!p.ok) continue
    found++
    if (p.direction === 'call') { assert.ok(p.stop < p.entry && p.target > p.entry) } else { assert.ok(p.stop > p.entry && p.target < p.entry) }
    assert.ok(Math.abs(p.rr - p.rewardDist / p.riskDist) < 1e-9)
    assert.ok(p.rr >= 1.5 - 1e-9, String(p.rr))
    assert.ok(Math.abs(p.ev - (p.prob * p.rr - (1 - p.prob))) < 1e-9)
    assert.ok(p.riskAtr >= 0.8 - 1e-9 && p.riskAtr <= 3 + 1e-9)
  }
  assert.ok(found > 0, 'no plan produced on 500 bars')
})
test('thin history is an error, not a guess', () => { const p = readCfdPlan(walk(20)); assert.equal(p.ok, false); assert.equal(p.direction, 'none') })
test('risk sizing: loss at the stop equals riskPct of equity (uncapped)', () => {
  const s = cfdSize({ mode: 'risk', equity: 10000, riskPct: 1, fixedMargin: 0, leverage: 30, entry: 1.1, stopDist: 0.002, maxMarginPct: 100 })
  assert.ok(Math.abs(s.riskAmount - 100) < 0.5, String(s.riskAmount)); assert.equal(s.capped, false)
})
test('risk sizing is capped by max margin %; fixed margin ignores the stop', () => {
  const s = cfdSize({ mode: 'risk', equity: 1000, riskPct: 5, fixedMargin: 0, leverage: 2, entry: 1.1, stopDist: 0.0005, maxMarginPct: 10 })
  assert.equal(s.capped, true); assert.ok(s.margin <= 100)
  const f = cfdSize({ mode: 'margin', equity: 1000, riskPct: 1, fixedMargin: 50, leverage: 10, entry: 2, stopDist: 0.01 })
  assert.equal(f.margin, 50); assert.equal(f.notional, 500); assert.equal(f.units, 250)
})
test('story.cfd() is available in MSL and returns the plan bundle', () => {
  const parsed = parseStrategyScript('let c = story.cfd("none")\ncall when c.ok and c.direction == "call"\nput when c.ok and c.direction == "put"\npos.stop = c.stop\npos.target = c.target\n')
  assert.ok(parsed.ok, (parsed as any).error)
  const d = walk(500); let fired = 0
  for (let k = 120; k < 500; k += 5) {
    const sr = { open: d.slice(0, k).map((x) => x.open), high: d.slice(0, k).map((x) => x.high), low: d.slice(0, k).map((x) => x.low), close: d.slice(0, k).map((x) => x.close), volume: d.slice(0, k).map((x) => x.volume), time: d.slice(0, k).map((x) => x.time) }
    const res: any = evaluateStrategyScript((parsed as any).ast, {} as any, (() => { throw new Error('x') }) as any, sr as any)
    assert.ok(!res.error, res.error)
    if (res.direction !== 'none') { fired++; assert.ok(res.entry && Number.isFinite(res.entry.stop) && Number.isFinite(res.entry.target)); if (res.direction === 'call') assert.ok(res.entry.stop < res.entry.target) }
  }
  assert.ok(fired > 0)
})
test('config sanitizer clamps and rejects junk', () => {
  const c = sanitizeCfdConfig({ riskPct: 99, leverage: 9999, sizing: 'bogus', mode: 'live', tf: 'nope', assets: ['EURUSD', 5] }, DEFAULT_CFD_TRADER)
  assert.equal(c.riskPct, 10); assert.equal(c.leverage, 500); assert.equal(c.sizing, 'risk'); assert.equal(c.mode, 'live'); assert.equal(c.tf, '1m'); assert.deepEqual(c.assets, ['EURUSD'])
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
