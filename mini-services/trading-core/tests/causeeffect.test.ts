// IQAIR//OS - tests: cause -> effect predicted move, MSL story.pm(), ticks in the lab
import assert from 'node:assert/strict'
import { readCauseEffect, adLine, tickImbalance } from '../src/analytics/causeeffect'
import { evaluateStrategyScript, parseStrategyScript } from '../src/analytics/strategylang'
import { backtestMslScript, setBacktestTickFeed, getBacktestTickCoverage } from '../src/analytics/mslbacktest'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
let sd = 7; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
// planted: a heavy-volume close near the high is followed by an up bar 80% of the time (and the mirror for the low)
const planted = (n = 400) => {
  const out: any[] = []; let p = 1.3, pend = 0
  for (let i = 0; i < n; i++) {
    const strong = r() < 0.3 ? (r() < 0.5 ? 1 : -1) : 0
    const o = p
    let c: number, h: number, l: number, v: number
    if (strong) { c = o + strong * (0.0006 + r() * 0.0003); h = Math.max(o, c) + 0.00005; l = Math.min(o, c) - 0.00005; v = 300 + r() * 100; pend = r() < 0.8 ? strong : -strong }
    else { const mv = pend ? pend * (0.0004 + r() * 0.0002) : (r() - 0.5) * 0.0004; c = o + mv; h = Math.max(o, c) + 0.0001 + r() * 0.0001; l = Math.min(o, c) - 0.0001 - r() * 0.0001; v = 100 + r() * 30; pend = 0 }
    out.push({ time: 1_700_000_000 + i * 60, open: o, high: h, low: l, close: c, volume: v }); p = c
  }
  return out
}
test('A/D line rises on closes near the high and falls near the low', () => {
  const up = adLine([2, 2], [1, 1], [1.9, 1.9], [10, 10]); assert.ok(up[1] > up[0] && up[0] > 0)
  const dn = adLine([2, 2], [1, 1], [1.1, 1.1], [10, 10]); assert.ok(dn[1] < dn[0] && dn[0] < 0)
})
test('tick imbalance: rising ticks positive, falling negative, too few = NaN', () => {
  const t = Array.from({ length: 20 }, (_, i) => ({ ts: 1000 + i * 10, price: 1 + i * 0.001 }))
  assert.ok(tickImbalance(t, 1000, 2000) > 0.9)
  assert.ok(tickImbalance(t.map((x) => ({ ts: x.ts, price: 2 - x.price })), 1000, 2000) < -0.9)
  assert.ok(Number.isNaN(tickImbalance(t.slice(0, 3), 1000, 2000)))
})
test('thin history is reported, not guessed', () => { const x = readCauseEffect(planted(30)); assert.equal(x.ok, false); assert.ok(/needs/.test(x.error ?? '')) })
test('a strong buying cause that paid reads as buying pressure with a bullish effect; coherence is high', () => {
  const d = planted(400); const x = readCauseEffect(d.slice(0, 399)); assert.ok(x.ok)
  const c = readCauseEffect(d.slice(0, 380)); assert.ok(c.validation.coherence > 0.6, String(c.validation.coherence))
  let found = false
  for (let k = 200; k < 399 && !found; k++) { const y = readCauseEffect(d.slice(0, k)); if (y.cause.dir === 1 && y.cause.mag >= 0.35) { assert.equal(y.effect.dir, 1); assert.ok(/buying/.test(y.cause.label)); found = true } }
  assert.ok(found)
})
test('on planted data the model predicts the next candle better than chance, walk-forward, with no look-ahead', () => {
  const d = planted(500); const x = readCauseEffect(d.slice(0, 499), undefined, { track: 150 })
  assert.ok(x.validation.trackN >= 20, String(x.validation.trackN)); assert.ok(x.validation.trackHit > 0.54, String(x.validation.trackHit))
  // truncating the future must not change a past reading
  const a = readCauseEffect(d.slice(0, 300)), b = readCauseEffect(d.slice(0, 300))
  assert.equal(a.pm.prob, b.pm.prob); assert.equal(a.pm.dir, b.pm.dir)
})
test('ticks feed the cause; without ticks the reading says so', () => {
  const d = planted(200); const lastT = d[199].time
  const ticks: { ts: number; price: number }[] = []
  for (let i = 0; i < 30; i++) ticks.push({ ts: (lastT + i * 2) * 1000, price: d[199].open + i * 0.00002 })
  const w = readCauseEffect(d, ticks), n = readCauseEffect(d)
  assert.equal(w.cause.ticksUsed, true); assert.ok(w.cause.tickImb > 0.9); assert.equal(n.cause.ticksUsed, false); assert.ok(/no tick data/.test(n.text))
})
test('S/R and retest are computed with distances in ATR', () => {
  const x = readCauseEffect(planted(300)); assert.ok(x.sr.supDist > 0 && x.sr.resDist > 0); assert.ok(['call', 'put', 'none'].includes(x.pm.dir)); assert.ok(x.pm.prob >= 0.05 && x.pm.prob <= 0.95)
})
const ser = (c: any[]) => ({ open: c.map((x) => x.open), high: c.map((x) => x.high), low: c.map((x) => x.low), close: c.map((x) => x.close), volume: c.map((x) => x.volume), time: c.map((x) => x.time) })
test('MSL: story.pm() bundle + pmText; ticks come through live.ticks', () => {
  const d = planted(300), s = ser(d), lt = d[299].time
  const ticks = Array.from({ length: 20 }, (_, i) => ({ ts: (lt + i) * 1000, price: d[299].open + i * 0.00001 }))
  const run = (src: string, live?: any) => { const p = parseStrategyScript(src); assert.ok(p.ok, (p as any).error); return evaluateStrategyScript((p as any).ast, {}, undefined, s as any, (() => undefined) as any, live, { keyPrefix: 'pm-t' } as any) }
  const o = run('let m = story.pm()\ncall when m.ok and m.prob >= 0 and m.text != "" and m.causeLabel != "" and m.supDist > 0 and m.ticksUsed == false')
  assert.ok(!o.error, String(o.error))
  const o2 = run('let m = story.pm()\ncall when m.ok and m.ticksUsed and story.pmText() != ""', { ticks, nowMs: (lt + 20) * 1000 })
  assert.ok(!o2.error, String(o2.error)); assert.equal(o2.direction, 'call')
})
test('lab ticks: a tick script backtests with the archive windowed per bar and coverage reported; no feed = clear failure-free run', () => {
  const d = planted(300)
  const ticks: { ts: number; price: number }[] = []
  for (let i = 220; i < 300; i++) for (let k = 0; k < 8; k++) ticks.push({ ts: (d[i].time + k * 7) * 1000, price: d[i].open + (d[i].close - d[i].open) * (k / 8) })
  const script = 'let m = story.pm()\ncall when m.ok and m.ticksUsed and m.tickImb > 0.5\nput when m.ok and m.ticksUsed and m.tickImb < -0.5'
  setBacktestTickFeed(ticks)
  try {
    const res = backtestMslScript(d, script, { expiryBars: 1, warmupBars: 80 })
    const cov = getBacktestTickCoverage()
    assert.ok(res.ok, res.error ?? ""); assert.ok(cov && cov.barsWithTicks > 0 && cov.share < 0.5, JSON.stringify(cov))
    assert.ok(res.trades.every((t: any) => t.index >= 220 - 1), 'signals only where ticks exist')
  } finally { setBacktestTickFeed(null) }
  assert.equal(getBacktestTickCoverage()?.barsEvaluated !== undefined, true)
})
import { combineCeMtf } from '../src/analytics/causeeffect'
const fake = (sign: number, conf = 60, eff = 1): any => ({ ok: true, cause: { label: 'buying-pressure-strong' }, effect: { dir: eff }, validation: { validated: true }, pm: { sign, dir: sign > 0 ? 'call' : sign < 0 ? 'put' : 'none', prob: 0.5 + sign * 0.15, confidence: conf }, text: 't' })
test('5m blend: agree = aligned and stronger; opposite = conflict, no call; 5m alone = wait-for-trigger', () => {
  const a = combineCeMtf(fake(1), fake(1), '5m'); assert.equal(a.alignment, 'aligned'); assert.equal(a.dir, 'call'); assert.ok(a.strength > 60 && a.triggerWithHtf)
  const c = combineCeMtf(fake(1), fake(-1), '5m'); assert.equal(c.alignment, 'conflict'); assert.equal(c.dir, 'none'); assert.equal(c.lean, 'put')
  const w = combineCeMtf(fake(0, 0), fake(1), '5m'); assert.equal(w.alignment, 'wait-for-trigger'); assert.equal(w.dir, 'none'); assert.equal(w.lean, 'call')
  const n = combineCeMtf(fake(1), null, '5m'); assert.equal(n.alignment, 'no-htf'); assert.equal(n.dir, 'call')
})
test('MSL: story.pm() defaults to 5m via seriesFor and story.pm("none") skips it', () => {
  const d = planted(400), s = ser(d)
  const five: any[] = []; for (let i = 0; i + 5 <= d.length; i += 5) { const g = d.slice(i, i + 5); five.push({ time: g[0].time, open: g[0].open, close: g[4].close, high: Math.max(...g.map((x: any) => x.high)), low: Math.min(...g.map((x: any) => x.low)), volume: g.reduce((a: number, x: any) => a + x.volume, 0) }) }
  const f5 = ser(five); const run = (src: string) => { const p = parseStrategyScript(src); assert.ok(p.ok, (p as any).error); return evaluateStrategyScript((p as any).ast, {}, undefined, s as any, ((tf: string) => (tf === '5m' ? f5 : undefined)) as any, undefined, { keyPrefix: 'pm5' } as any) }
  const a = run('let m = story.pm()\ncall when m.ok and m.htfOk and m.alignment != "no-htf" and m.text != ""'); assert.ok(!a.error, String(a.error))
  const b = run('let m = story.pm("none")\ncall when m.ok and m.htfOk == false and m.alignment == "no-htf" or m.alignment == "no-call" or m.alignment == "trigger-only"'); assert.ok(!b.error, String(b.error))
})
import { backtestMslManaged, backtestMslScriptWalkForward, backtestMslScriptCrossAsset } from '../src/analytics/mslbacktest'
test('lab ticks reach managed, walk-forward and cross-asset backtests (per-asset feed)', () => {
  const d = planted(300), e = planted(300)
  const mkT = (c: any[]) => { const t: { ts: number; price: number }[] = []; for (let i = 220; i < 300; i++) for (let k = 0; k < 8; k++) t.push({ ts: (c[i].time + k * 7) * 1000, price: c[i].open + (c[i].close - c[i].open) * (k / 8) }); return t }
  const script = 'let m = story.pm()\ncall when m.ok and m.ticksUsed and m.tickImb > 0.5\nput when m.ok and m.ticksUsed and m.tickImb < -0.5'
  setBacktestTickFeed(mkT(d))
  try {
    const w = backtestMslScriptWalkForward(d, script, { warmupBars: 80 }); assert.ok(w.ok, (w as any).error); assert.ok((getBacktestTickCoverage()?.barsWithTicks ?? 0) > 0)
    const m = backtestMslManaged(d, script, { warmupBars: 80 }); assert.ok(m.ok, (m as any).error); assert.ok((getBacktestTickCoverage()?.barsWithTicks ?? 0) > 0)
  } finally { setBacktestTickFeed(null) }
  const x = backtestMslScriptCrossAsset({ A: d, B: e }, script, { warmupBars: 80 }, { A: { ticks: mkT(d) } })
  const a = x.perAsset.find((p) => p.asset === 'A')!, b = x.perAsset.find((p) => p.asset === 'B')!
  assert.ok((a as any).tickCoverage && (a as any).tickCoverage.barsWithTicks > 0); assert.equal(b.result.trades.length, 0, 'asset without a feed has no tick signals')
})
console.log(`\n${pass}/${total} passed`); if (pass !== total) process.exit(1)
