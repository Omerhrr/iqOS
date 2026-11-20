// IQAIR//OS - tests: heikin ashi predictor
import assert from 'node:assert/strict'
import { readHa, haFilter, heikinAshi, reportHaFilter } from '../src/analytics/hapredict'
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

test('HA candles: close = OHLC/4, open = mid of previous HA', () => {
  const c = series(30, 'walk'); const h = heikinAshi(c)
  assert.ok(Math.abs(h[5].close - (c[5].open + c[5].high + c[5].low + c[5].close) / 4) < 1e-12)
  assert.ok(Math.abs(h[5].open - (h[4].open + h[4].close) / 2) < 1e-12); assert.ok(h[7].high >= Math.max(h[7].open, h[7].close) && h[7].low <= Math.min(h[7].open, h[7].close))
})
test('thin history reported', () => { const x = readHa(series(60, 'walk')); assert.equal(x.ok, false); assert.ok(/needs/.test(x.error ?? '')) })
test('a steady climb reads as a strong bull streak', () => { const x = readHa(series(400, 'trend')); assert.ok(x.ok); assert.equal(x.ha.color, 'bull'); assert.ok(x.ha.streak >= 3, String(x.ha.streak)) })
test('NO LOOK-AHEAD: the read at bar t does not change when later bars change', () => {
  const a = series(500, 'walk'); const b = a.map((x: any) => ({ ...x })); const base = readHa(a.slice(0, 400))
  const alt = readHa(b.slice(0, 400)); assert.equal(base.pred.pUp, alt.pred.pUp)
  for (let i = 400; i < 500; i++) { b[i].close = b[i].close * 1.01; b[i].high *= 1.02 }
  const alt2 = readHa(b.slice(0, 400)); assert.equal(base.pred.pUp, alt2.pred.pUp); assert.equal(base.pred.trackN, alt2.pred.trackN)
})
test('it LEARNS a planted rule: after a strong bull HA streak the next candle is up 85%', () => {
  const out: any[] = []; let p = 1.2; let up = 0
  for (let i = 0; i < 1500; i++) { const o = p; const hot = i > 4 && out.slice(-3).every((k) => k.close > k.open) ; let mv: number
    if (hot) mv = (r() < 0.85 ? 1 : -1) * (0.0002 + r() * 0.0002); else mv = (r() - 0.5) * 0.0005
    const c = o + mv; out.push({ time: 1_700_006_400 + i * 60, open: o, high: Math.max(o, c) + r() * 0.00005, low: Math.min(o, c) - r() * 0.00005, close: c, volume: 100 }); p = c }
  const x = readHa(out); assert.ok(x.ok); assert.ok(x.pred.trackN >= 30, String(x.pred.trackN)); assert.ok(x.pred.trackHit > 0.55, String(x.pred.trackHit)); assert.ok(x.pred.validated)
})
test('random walk: not validated by luck most of the time, and probabilities stay near 50%', () => {
  let validated = 0; for (let k = 0; k < 6; k++) { const x = readHa(series(700, 'walk')); assert.ok(x.ok); assert.ok(Math.abs(x.pred.pUp - 0.5) < 0.2); if (x.pred.validated) validated++ }
  assert.ok(validated <= 2, `validated ${validated}/6 on noise`)
})
test('filter semantics: colour against blocks, doji is neutral, both needs both', () => {
  const x = readHa(series(400, 'trend')); assert.ok(x.ok)
  const call = haFilter(x, 'call', 'color'), put = haFilter(x, 'put', 'color')
  if (x.ha.strength !== 'weak') { assert.equal(call.pass, x.ha.color === 'bull'); assert.equal(put.pass, x.ha.color === 'bear'); assert.equal(put.stance, x.ha.color === 'bull' ? 'against' : 'with') }
  assert.equal(haFilter(x, 'call', 'both').pass, x.allow.color.call && x.allow.predict.call)
  assert.equal(haFilter(x, 'none', 'color').pass, false)
})
test('report: thin history reported; random data does not claim a filter', () => {
  assert.equal(reportHaFilter(series(100, 'walk'), undefined).ok, false)
  const rep = reportHaFilter(series(700, 'walk'), undefined, { step: 6 }); assert.ok(rep.ok); assert.ok(!/useful pm filter/.test(rep.verdict), rep.verdict)
})
test('story.ha / story.haFilter work in MSL', () => {
  const parsed = parseStrategyScript('let h = story.ha()\nlet f = story.haFilter("call", "both")\nlet t = story.haText()\ncall when h.ok and h.allowCall and f.pass\nput when h.ok and h.allowPut and story.haFilter("put").pass\n'); assert.ok(parsed.ok, (parsed as any).error)
  const d = series(400, 'trend'); const sr = { time: d.map((x: any) => x.time), open: d.map((x: any) => x.open), high: d.map((x: any) => x.high), low: d.map((x: any) => x.low), close: d.map((x: any) => x.close), volume: d.map(() => 100) }
  const res: any = evaluateStrategyScript((parsed as any).ast, {} as any, (() => { throw new Error('x') }) as any, sr as any); assert.ok(!res.error, res.error)
})
test('story.ha on thin history is a clean ok:false', () => {
  const parsed = parseStrategyScript('let h = story.ha()\ncall when h.ok and h.allowCall\n'); assert.ok(parsed.ok)
  const res: any = evaluateStrategyScript((parsed as any).ast, {} as any, (() => { throw new Error('x') }) as any, { time: [1, 2, 3], open: [1, 1, 1], high: [1, 1, 1], low: [1, 1, 1], close: [1, 1, 1], volume: [1, 1, 1] } as any); assert.ok(!res.error, res.error); assert.equal(res.direction, 'none')
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
