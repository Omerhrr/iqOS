// IQAIR//OS - tests: weather + editor chapters of the story
import assert from 'node:assert/strict'
import { readWeather } from '../src/analytics/weather'
import { readEditor, reportEditor } from '../src/analytics/editor'
import { evaluateStrategyScript, parseStrategyScript } from '../src/analytics/strategylang'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
let sd = 9; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
const series = (n: number, kind: 'trend' | 'range' | 'dead' | 'walk') => {
  const out: any[] = []; let p = 1.2
  for (let i = 0; i < n; i++) {
    const o = p; let mv: number
    if (kind === 'trend') mv = 0.0004 + (r() - 0.5) * 0.0003
    else if (kind === 'range') mv = (1.2 - p) * 0.35 + (r() - 0.5) * 0.0004
    else if (kind === 'dead') mv = (r() - 0.5) * 0.00002
    else mv = (r() - 0.5) * 0.0006
    const c = o + mv, w = kind === 'dead' ? 0.00001 : 0.0002
    out.push({ time: 1_700_000_000 + i * 60, open: o, high: Math.max(o, c) + r() * w, low: Math.min(o, c) - r() * w, close: c, volume: 100 }); p = c
  }
  return out
}
const collapsed = () => { const a = series(300, 'walk'); const L = a[a.length - 1].close; const b = Array.from({ length: 70 }, (_, i) => ({ time: a[299].time + (i + 1) * 60, open: L, high: L + 0.00001, low: L - 0.00001, close: L + (r() - 0.5) * 0.00001, volume: 100 })); return [...a, ...b] }
test('weather: thin history reported', () => { const w = readWeather(series(60, 'walk')); assert.equal(w.ok, false) })
test('weather: a steady climb is a trend-up; efficiency is high', () => { const w = readWeather(series(300, 'trend')); assert.ok(w.ok); assert.equal(w.regime, 'trend-up', w.regime); assert.ok(w.er > 0.5) })
test('weather: mean-reverting noise is a range with low efficiency', () => { const w = readWeather(series(300, 'range')); assert.ok(w.ok); assert.ok(['range', 'mixed', 'squeeze', 'dead'].includes(w.regime), w.regime); assert.ok(w.er < 0.35, String(w.er)) })
test('weather: a volatility collapse reads as dead or squeeze (relative to the pair\'s own history)', () => { const w = readWeather(collapsed()); assert.ok(['dead', 'squeeze'].includes(w.regime), w.regime); assert.equal(w.tradeable, false) })
test('weather: in a persistent trend, following has paid (favours follow)', () => { const w = readWeather(series(500, 'trend')); assert.ok(w.momentumN > 30); assert.ok(w.momentumHit > 0.5, String(w.momentumHit)) })
test('editor: a market that has gone dead gives no call and says so', () => { const e = readEditor(collapsed(), undefined, null, { htfTf: 'none' }); assert.equal(e.dir, 'none'); assert.equal(e.wx.regime, 'dead'); assert.equal(e.tradeNow, false) })
test('editor: output is coherent (dir/strength/agreement, invalidation on the correct side)', () => {
  const d = series(700, 'walk'); let seen = 0
  for (let k = 300; k < 700; k += 25) {
    const e = readEditor(d.slice(0, k), undefined, null, { htfTf: 'none' }); assert.ok(e.ok || e.error)
    assert.ok(['aligned', 'conflict', 'nm-only', 'pm-only', 'no-call'].includes(e.agreement))
    if (e.dir === 'none') assert.equal(e.tradeNow, false)
    if (e.dir === 'call' && Number.isFinite(e.invalidation)) { assert.ok(e.invalidation < d[k - 1].close); seen++ }
    if (e.dir === 'put' && Number.isFinite(e.invalidation)) { assert.ok(e.invalidation > d[k - 1].close); seen++ }
    assert.ok(e.strength >= 0 && e.strength <= 100)
  }
})
test('reportEditor: groups and verdict are produced, rates are valid', () => {
  const d = series(900, 'walk'); const rep = reportEditor(d, undefined, { step: 10 }); assert.ok(rep.ok, rep.error ?? 'report failed')
  for (const g of Object.values(rep.groups)) assert.ok(g.rate === null || (g.rate >= 0 && g.rate <= 1))
  assert.ok(typeof rep.verdict === 'string' && rep.verdict.length > 10)
})
test('story.weather() and story.editor() work in MSL', () => {
  const parsed = parseStrategyScript('let w = story.weather()\nlet e = story.editor("none")\ncall when e.ok and e.direction == "call" and w.tradeable\nput when e.ok and e.direction == "put" and w.tradeable\n'); assert.ok(parsed.ok, (parsed as any).error)
  const d = series(400, 'walk'); const sr = { open: d.map((x: any) => x.open), high: d.map((x: any) => x.high), low: d.map((x: any) => x.low), close: d.map((x: any) => x.close), volume: d.map(() => 100), time: d.map((x: any) => x.time) }
  const res: any = evaluateStrategyScript((parsed as any).ast, {} as any, (() => { throw new Error('x') }) as any, sr as any); assert.ok(!res.error, res.error)
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
