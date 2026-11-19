// IQAIR//OS - tests: the story of every chart type (renko, kagi, effort, heikin ashi, tick bars, ticks, baseline, footprint)
import assert from 'node:assert/strict'
import { storyRenko, storyKagi, storyEffort, storyHeikin, storyTickBars, storyTicks, storyBaseline, storyFootprint, runFacts } from '../src/analytics/charttypestory'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
let sd = 11; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
const mk = (path: (i: number) => number, n = 200, vol = (i: number) => 100 + (i % 7) * 10) => Array.from({ length: n }, (_, i) => { const o = path(i), c = path(i + 1); return { time: 1_700_000_000 + i * 60, open: o, close: c, high: Math.max(o, c) + 0.0002 + r() * 0.0001, low: Math.min(o, c) - 0.0002 - r() * 0.0001, volume: vol(i) } })
const climb = mk((i) => 1.3 + i * 0.0004 + Math.sin(i / 3) * 0.0003)
const fall = mk((i) => 1.3 - i * 0.0004 + Math.sin(i / 3) * 0.0003)
const chop = mk((i) => 1.3 + (i % 2 ? 0.0006 : -0.0006) + (r() - 0.5) * 0.0002)
test('run facts: current run, previous run, flips', () => {
  const x = runFacts([1, 1, 1, -1, -1, 1, 1, 1, 1]); assert.equal(x.cur, 4); assert.equal(x.prev, 2); assert.equal(x.flips, 2); assert.equal(x.longest, 4); assert.equal(x.curDir, 1)
})
test('renko: a climb reads as an up run, a fall as a down run, chop as chop; facts carry the pullback to reversal', () => {
  const u = storyRenko(climb); assert.ok(u.ok && u.dir === 1 && /trend-run|extended-run/.test(u.kind), JSON.stringify(u))
  assert.ok(Number.isFinite(u.facts.progress as number) && Number.isFinite(u.facts.toReversal as number) && /brick/.test(u.text), u.text)
  const d = storyRenko(fall); assert.equal(d.dir, -1)
  assert.equal(storyRenko(chop, { brickSize: 0.0005 }).kind, 'chop')
  assert.equal(storyRenko(climb.slice(0, 10)).ok, false)
})
test('kagi: a climb is a rising line with structure, text mentions shoulder/waist semantics, thin data is not ok', () => {
  const k = storyKagi(climb); assert.ok(k.ok && k.dir === 1, JSON.stringify(k)); assert.ok(/rising|reversed|choppy/.test(k.text), k.text)
  assert.equal(storyKagi(climb.slice(0, 12)).ok, false)
  assert.equal(storyKagi(fall).dir, -1)
})
test('effort: reports effort ratio and regime; zero volume says it cannot confirm', () => {
  const e = storyEffort(climb); assert.ok(e.ok && Number.isFinite(e.facts.effortRatio as number), JSON.stringify(e))
  const z = storyEffort(mk((i) => 1.3 + i * 0.0004, 200, () => 0)); assert.ok(z.ok && /no volume/.test(z.text) && z.facts.effortSource === 'none', z.text)
})
test('heikin ashi: a clean climb is strong-up (flat-bottom candles), a fall strong-down, a turn is flagged', () => {
  const straight = mk((i) => 1.3 + i * 0.0006, 60); const s = storyHeikin(straight); assert.equal(s.kind, 'strong-up', JSON.stringify(s)); assert.ok(/no lower wick/.test(s.text))
  assert.equal(storyHeikin(mk((i) => 1.3 - i * 0.0006, 60)).kind, 'strong-down')
  const turn = storyHeikin(mk((i) => (i < 55 ? 1.3 + i * 0.0006 : 1.3 + 55 * 0.0006 - (i - 55) * 0.0012), 60)); assert.ok(['flip-down', 'weakening-up', 'indecision', 'down', 'strong-down'].includes(turn.kind), turn.kind)
})
test('tick bars: speed vs usual, run, source note for candle fallback', () => {
  const pts = Array.from({ length: 400 }, (_, i) => ({ time: 1_700_000_000 + i * (i > 340 ? 0.2 : 1), price: 1.3 + i * 0.00001 }))
  const t = storyTickBars(pts, 'tick', 10); assert.ok(t.ok && t.dir === 1 && Number.isFinite(t.facts.speed as number), JSON.stringify(t)); assert.ok(t.facts.speed as number > 1.5, String(t.facts.speed))
  const c = storyTickBars(pts, 'candle', 10); assert.ok(/not live ticks/.test(c.text))
  assert.equal(storyTickBars(pts.slice(0, 20), 'tick', 10).ok, false)
})
test('ticks: accelerating buyers read as accelerating-up; a dead feed is stalled', () => {
  const now = 2_000_000_000_000
  const ticks: { ts: number; price: number }[] = []; let p = 1.3
  for (let s = 60; s > 5; s--) { ticks.push({ ts: now - s * 1000, price: p }); if (r() > 0.6) p += (r() - 0.45) * 0.00002 }
  for (let k = 50; k >= 0; k--) { p += 0.00002; ticks.push({ ts: now - k * 100, price: p }) }
  const t = storyTicks(ticks, now, 0.0005); assert.ok(t.ok && t.dir === 1 && /accelerating-up|steady-up/.test(t.kind), JSON.stringify(t))
  const dead = storyTicks(ticks, now + 20_000); assert.equal(dead.kind, 'stalled')
  assert.equal(storyTicks(ticks.slice(0, 5), now).ok, false)
})
test('baseline: bull side vs bear side, time on each side, crossings; mid mode centres on the range', () => {
  const up = storyBaseline(climb, 30); assert.ok(up.ok && up.dir === 1 && (up.facts.aboveShare as number) > 0.7 && /bull side/.test(up.text), JSON.stringify(up))
  const dn = storyBaseline(fall, 30); assert.equal(dn.dir, -1); assert.ok(/bear side/.test(dn.text))
  const c = storyBaseline(chop, 30); assert.ok((c.facts.crossings as number) >= 3, JSON.stringify(c.facts)); assert.equal(c.kind, 'chop-around-base')
  const mid = storyBaseline(climb, 30, 'mid'); assert.ok(mid.ok && Math.abs(mid.facts.aboveShare as number - 0.5) < 0.3, JSON.stringify(mid.facts))
  assert.equal(storyBaseline(climb.slice(0, 20), 30).ok, false)
})
test('footprint: delta, POC, imbalances; zero volume says there is nothing to read', () => {
  const up = mk((i) => 1.3 + i * 0.0005, 40, () => 500); const f = storyFootprint(up, 10); assert.ok(f.ok && Number.isFinite(f.facts.delta as number) && /delta/.test(f.text), JSON.stringify(f))
  assert.equal(storyFootprint(mk((i) => 1.3, 40, () => 0), 10).ok, false)
})
import { evaluateStrategyScript, parseStrategyScript } from '../src/analytics/strategylang'
test('MSL: story.of(type) returns a bundle with facts, ofText the sentence, ticks fails closed without a feed', () => {
  const b = { open: climb.map((c) => c.open), high: climb.map((c) => c.high), low: climb.map((c) => c.low), close: climb.map((c) => c.close), volume: climb.map((c) => c.volume), time: climb.map((c) => c.time) }
  const run = (src: string, live?: any) => { const p = parseStrategyScript(src); assert.ok(p.ok, (p as any).error); return evaluateStrategyScript((p as any).ast, {}, undefined, b as any, undefined, live, { keyPrefix: 'cts-t' } as any) }
  const r = run('let rk = story.of("renko")\nlet bl = story.of("baseline", 30, "mid")\nlet kg = story.of("kagi")\ncall when rk.ok and rk.dir == 1 and rk.run >= 3 and bl.ok and bl.aboveShare >= 0 and kg.ok and story.ofText("ha") != "" and story.of("footprint", 8).ok and story.of("effort").ok and story.of("tickbars").ok\nput when false')
  assert.equal(r.direction, 'call', JSON.stringify(r))
  const e = run('call when story.of("ticks").ok'); assert.ok(e.error && /tick feed/.test(e.error), JSON.stringify(e))
  const bad = run('call when story.of("nope").ok'); assert.ok(bad.error && /type must be one of/.test(bad.error))
  const now = 2_000_000_000_000; const ticks = Array.from({ length: 200 }, (_, i) => ({ ts: now - (200 - i) * 300, price: 1.3 + i * 0.00001 }))
  const t = run('call when story.of("ticks").ok and story.of("ticks").dir == 1', { ticks, nowMs: now, bar: undefined } as any); assert.equal(t.direction, 'call', JSON.stringify(t))
})
console.log(`${pass}/${total}`)
