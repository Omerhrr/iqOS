// IQAIR//OS - tests: multi-timeframe story (4h + 15m context -> direction for the trading timeframe)
import assert from 'node:assert/strict'
import { readMtf, readFrame } from '../src/analytics/mtfstory'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
let sd = 17; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
const mk = (spacing: number, path: (i: number) => number, n = 160) => Array.from({ length: n }, (_, i) => { const o = path(i), c = path(i + 1); return { time: 1_700_000_000 + i * spacing, open: o, close: c, high: Math.max(o, c) + 0.0002 + r() * 0.0001, low: Math.min(o, c) - 0.0002 - r() * 0.0001, volume: 100 } })
const up = (s: number) => mk(s, (i) => 1.3 + i * 0.0006 + Math.sin(i / 4) * 0.0004)
const down = (s: number) => mk(s, (i) => 1.3 - i * 0.0006 + Math.sin(i / 4) * 0.0004)
const flat = (s: number) => mk(s, (i) => 1.3 + (i % 2 ? 0.0004 : -0.0004) + (r() - 0.5) * 0.0001)
test('a rising frame votes bullish across chart types with high agreement; a falling one bearish', () => {
  const u = readFrame('4h', up(14400)); assert.ok(u.ok && u.score > 0.4 && u.agreement > 0.7, JSON.stringify([u.score, u.agreement, u.votes.map((v) => v.name + v.vote)]))
  assert.ok(u.votes.some((v) => v.name === 'renko') && u.votes.some((v) => v.name === 'kagi') && u.votes.some((v) => v.name === 'baseline') && u.lines.length >= 5)
  const d = readFrame('15m', down(900)); assert.ok(d.score < -0.4, String(d.score))
})
test('4h and 15m bullish + a bullish 1m trigger = aligned CALL', () => {
  const m = readMtf('1m', up(60), [{ tf: '4h', candles: up(14400) }, { tf: '15m', candles: up(900) }])
  assert.ok(m.ok && m.alignment === 'aligned' && m.direction === 'call' && m.lean === 'call' && m.confidence > 40, JSON.stringify([m.alignment, m.direction, m.confidence, m.text]))
})
test('bearish context + bearish trigger = aligned PUT', () => {
  const m = readMtf('5m', down(300), [{ tf: '4h', candles: down(14400) }, { tf: '15m', candles: down(900) }]); assert.equal(m.direction, 'put'); assert.equal(m.alignment, 'aligned')
})
test('bullish context but the trigger is falling = pullback, no direction; trigger neutral = wait', () => {
  const pull = readMtf('1m', down(60), [{ tf: '4h', candles: up(14400) }, { tf: '15m', candles: up(900) }]); assert.equal(pull.alignment, 'pullback-against-context'); assert.equal(pull.direction, 'none'); assert.equal(pull.lean, 'call')
  const wait = readMtf('1m', flat(60), [{ tf: '4h', candles: up(14400) }, { tf: '15m', candles: up(900) }]); assert.equal(wait.alignment, 'wait-for-trigger'); assert.equal(wait.direction, 'none'); assert.equal(wait.lean, 'call')
})
test('opposite higher frames are flagged and confidence is cut; a flat context has no lean', () => {
  const m = readMtf('1m', up(60), [{ tf: '4h', candles: up(14400) }, { tf: '15m', candles: down(900) }]); assert.ok(m.warnings.some((w) => /opposite/.test(w)), JSON.stringify(m.warnings))
  const f = readMtf('1m', up(60), [{ tf: '4h', candles: flat(14400) }, { tf: '15m', candles: flat(900) }]); assert.equal(f.alignment, 'no-context'); assert.equal(f.direction, 'none')
})
test('thin data is reported, not guessed', () => {
  const m = readMtf('1m', up(60), [{ tf: '4h', candles: up(14400).slice(0, 20) }]); assert.equal(m.ok, false); assert.ok(/no usable higher timeframe/.test(m.error ?? ''))
})
import { evaluateStrategyScript, parseStrategyScript } from '../src/analytics/strategylang'
test('MSL: story.mtf("4h","15m") reads the higher frames through seriesFor and gives direction / lean / alignment / per-frame scores', () => {
  const ser = (c: any[]) => ({ open: c.map((x) => x.open), high: c.map((x) => x.high), low: c.map((x) => x.low), close: c.map((x) => x.close), volume: c.map((x) => x.volume), time: c.map((x) => x.time) })
  const trig = ser(up(60)), h4 = ser(up(14400)), m15 = ser(up(900))
  const seriesFor = (tf: string) => (tf === '4h' ? h4 : tf === '15m' ? m15 : undefined)
  const run = (src: string) => { const p = parseStrategyScript(src); assert.ok(p.ok, (p as any).error); return evaluateStrategyScript((p as any).ast, {}, undefined, trig as any, seriesFor as any, undefined, { keyPrefix: 'mtf-t' } as any) }
  const r = run('let m = story.mtf("4h", "15m")\ncall when m.ok and m.direction == "call" and m.alignment == "aligned" and m.strength >= 40 and m.score4h > 0.3 and m.score15m > 0.3 and m.contextScore > 0.3 and m.text != ""\nput when m.direction == "put"')
  assert.equal(r.direction, 'call', JSON.stringify(r))
  const bad = run('let m = story.mtf("1d")\ncall when m.ok\nput when false'); assert.equal(bad.direction, 'none')
  const e = run('call when story.mtf().ok'); assert.ok(e.error && /higher timeframe/.test(e.error), JSON.stringify(e))
})
console.log(`${pass}/${total}`)
