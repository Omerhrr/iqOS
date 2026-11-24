// IQAIR//OS - tests for the Anchor-Difference engine and the MSL `anchor.*` namespace
import assert from 'node:assert/strict'
import { computeAnchorDiff, parseAnchorPeriod } from '../src/analytics/anchordiff'
import { parseStrategyScript, evaluateStrategyScript } from '../src/analytics/strategylang'
import { computeAnchorDiff as clientCompute } from '../../../src/lib/os/anchordiff'
import { atr as atrFn, trueRange } from '../src/analytics/indicators'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
// 12 hours of 1m candles starting at a 4h boundary (UTC 00:00 + k*4h); deterministic wiggle
const T0 = Math.floor(1_700_000_000 / 14400) * 14400
const N = 720
const px: number[] = []
let p = 1.15
for (let i = 0; i < N; i++) { p += Math.sin(i / 7) * 0.0003 + (i % 240 === 0 ? 0.002 : 0.00005); px.push(p) }
const candles = px.map((c, i) => ({ time: T0 + i * 60, open: i ? px[i - 1] : c, high: Math.max(c, i ? px[i - 1] : c) + 0.0001, low: Math.min(c, i ? px[i - 1] : c) - 0.0001, close: c, volume: 100 + (i % 17) }))
const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`)

test('parseAnchorPeriod', () => {
  assert.equal(parseAnchorPeriod('4h'), 14400); assert.equal(parseAnchorPeriod('1d'), 86400); assert.equal(parseAnchorPeriod('15m'), 900)
  assert.equal(parseAnchorPeriod(undefined), 14400); assert.equal(parseAnchorPeriod('banana'), null); assert.equal(parseAnchorPeriod('10s'), null)
})
test('no bar before the first completed period; 4h anchor = close of the last candle before the bucket', () => {
  const r = computeAnchorDiff(candles, { anchor: '4h' })!
  assert.equal(r.bars[0].time, T0 + 240 * 60)          // first 4h bucket has no anchor
  near(r.bars[0].anchor, px[239])                        // anchor = close of bar 239
  near(r.bars[0].close, px[240] - px[239])
  near(r.bars[239].anchor, px[239]); near(r.bars[240].anchor, px[479])   // rolls at the 8h boundary
  assert.equal(r.bars[0].rolled, true); assert.equal(r.bars[1].rolled, false); assert.equal(r.bars[240].rolled, true)
})
test('OHLC are price minus anchor (wicks stay true)', () => {
  const r = computeAnchorDiff(candles, { anchor: '4h' })!
  const b = r.bars[10], c = candles[250]
  near(b.open, c.open - b.anchor); near(b.high, c.high - b.anchor); near(b.low, c.low - b.anchor); near(b.close, c.close - b.anchor)
})
test('TR and ATR are the PRICE values (identical inside a period, no fake spike at a roll)', () => {
  const r = computeAnchorDiff(candles, { anchor: '4h' })!
  const tr = trueRange(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close))
  const at = atrFn(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), 14)
  r.bars.forEach((b, k) => { const i = 240 + k; near(b.tr, tr[i]); near(b.atr, at[i]) })
})
test('z = close gap / ATR', () => { const r = computeAnchorDiff(candles, { anchor: '4h' })!; const b = r.bars[100]; near(b.z, b.close / b.atr) })
test('crossing is judged against the CURRENT anchor (a roll cannot fake a cross)', () => {
  const r = computeAnchorDiff(candles, { anchor: '4h' })!
  r.bars.forEach((b, k) => { const i = 240 + k; const prev = candles[i - 1].close - b.anchor; const exp = prev <= 0 && b.close > 0 ? 1 : prev >= 0 && b.close < 0 ? -1 : 0; assert.equal(b.crossed, exp) })
})
test('rocAtr = (gap - gap[n]) / atr and roc is NaN for a tiny or sign-flipped earlier gap', () => {
  const r = computeAnchorDiff(candles, { anchor: '1h', rocPeriod: 5 })!
  r.bars.forEach((b, k) => {
    const i = candles.findIndex((c) => c.time === b.time); if (i < 5) return
    near(b.rocAtr, (b.close - (candles[i - 5].close - b.anchor)) / b.atr, 1e-7)
    const dp = candles[i - 5].close - b.anchor
    if (Math.abs(dp) < 0.3 * b.atr || dp * b.close <= 0) assert.ok(Number.isNaN(b.roc)); else near(b.roc, ((Math.abs(b.close) - Math.abs(dp)) / Math.abs(dp)) * 100, 1e-6)
  })
})
test('switching the anchor changes the anchor but not the candle times or count (after warmup)', () => {
  const a = computeAnchorDiff(candles, { anchor: '1h' })!, b = computeAnchorDiff(candles, { anchor: '4h' })!
  assert.ok(a.bars.length > b.bars.length); assert.equal(a.bars[a.bars.length - 1].time, b.bars[b.bars.length - 1].time)
})
test('a bad anchor returns null; a window shorter than one period returns zero bars', () => {
  assert.equal(computeAnchorDiff(candles, { anchor: 'zz' }), null)
  assert.equal(computeAnchorDiff(candles.slice(0, 100), { anchor: '4h' })!.bars.length, 0)
})
const series = (cs: typeof candles) => ({ open: cs.map((c) => c.open), high: cs.map((c) => c.high), low: cs.map((c) => c.low), close: cs.map((c) => c.close), volume: cs.map((c) => c.volume), time: cs.map((c) => c.time) })
const run = (src: string, cs = candles, inputs?: Record<string, number | boolean | string>) => { const q = parseStrategyScript(src); assert.ok(q.ok, q.ok ? '' : q.error); return evaluateStrategyScript(q.ast, {}, undefined, series(cs), undefined, undefined, undefined, undefined, inputs) }
test('MSL anchor.* reads match the engine (value for value)', () => {
  const r = computeAnchorDiff(candles, { anchor: '4h' })!, L = r.bars[r.bars.length - 1], P = r.bars[r.bars.length - 2]
  const chk = (expr: string, v: number) => { const e = run(`call when ${expr} > ${v - 1e-7} and ${expr} < ${v + 1e-7}\nexpiry = 1\n`); assert.equal(e.error, undefined, expr); assert.equal(e.direction, 'call', `${expr} should equal ${v}`) }
  chk('anchor.diff("4h")', L.close); chk('anchor.anchor("4h")', L.anchor); chk('anchor.open("4h")', L.open); chk('anchor.high("4h")', L.high); chk('anchor.low("4h")', L.low)
  chk('anchor.z("4h")', L.z); chk('anchor.atr("4h")', L.atr); chk('anchor.tr("4h")', L.tr); chk('anchor.cci("4h")', L.cci); chk('anchor.rsi("4h")', L.rsi); chk('anchor.mfi("4h")', L.mfi)
  chk('anchor.rocAtr("4h")', L.rocAtr); chk('anchor.diff(-2, "4h")', P.close); chk('anchor.z(-2, "4h")', P.z)
})
test('MSL: anchor period is switchable through an input', () => {
  const src = `input per = "4h" options "15m","30m","1h","4h","1d","1w"\ncall when anchor.above(per)\nconfidence = 60\nexpiry = 1\n`
  assert.equal(run(src).error, undefined); assert.equal(run(src, candles, { per: '1h' }).error, undefined)
  const bad = run(`call when anchor.above("7q")\nexpiry = 1\n`); assert.ok(bad.error && /not an anchor period/.test(bad.error))
})
test('MSL: too-short history fails closed with a clear message', () => {
  const e = run(`call when anchor.above("4h")\nexpiry = 1\n`, candles.slice(0, 100)); assert.ok(e.error && /shorter than one 4h period/.test(e.error)); assert.equal(e.direction, 'none')
})
test('MSL: unknown method names the options', () => { const e = run(`call when anchor.nope("4h") > 0\nexpiry = 1\n`); assert.ok(e.error && /use ok\(\)/.test(e.error)) })
test('MSL: z, cross, sinceCross, rolled, diffSeries run', () => {
  const e = run(`let z = anchor.z("4h")\nlet s = anchor.sinceCross("4h")\nlet r = anchor.rolled("4h")\nlet d = anchor.diffSeries(5, "4h")\ncall when z > 0 and s >= 0\nconfidence = 55\nexpiry = 1\n`)
  assert.equal(e.error, undefined)
})
test('client copy (src/lib/os/anchordiff.ts) matches the kernel engine bar for bar', () => {
  const cl = { computeAnchorDiff: clientCompute }
  for (const anchor of ['15m', '1h', '4h']) {
    const a = computeAnchorDiff(candles, { anchor, rocPeriod: 5 })!, b = cl.computeAnchorDiff(candles, { anchor, rocPeriod: 5 })!
    assert.equal(a.bars.length, b.bars.length)
    a.bars.forEach((x, i) => { for (const k of Object.keys(x) as (keyof typeof x)[]) { const u = x[k], v = (b.bars[i] as Record<string, unknown>)[k]; if (typeof u === 'number') assert.ok((Number.isNaN(u) && Number.isNaN(v as number)) || u === v, `${anchor} bar ${i} ${k}`); else assert.equal(u, v) } })
  }
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
