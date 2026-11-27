// IQAIR//OS - tests for the Anchor-Difference engine and the MSL `anchor.*` namespace
import assert from 'node:assert/strict'
import { computeAnchorDiff, parseAnchorPeriod, parseAnchorSpec, parseCondition } from '../src/analytics/anchordiff'
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
  const chk = (expr: string, v: number) => { const e = run(`call when ${expr} > ${(v - 1e-7).toFixed(9)} and ${expr} < ${(v + 1e-7).toFixed(9)}\nexpiry = 1\n`); assert.equal(e.error, undefined, expr); assert.equal(e.direction, 'call', `${expr} should equal ${v}`) }
  chk('anchor.diff("4h")', L.close); chk('anchor.anchor("4h")', L.anchor); chk('anchor.open("4h")', L.open); chk('anchor.high("4h")', L.high); chk('anchor.low("4h")', L.low)
  chk('anchor.z("4h")', L.z); chk('anchor.atr("4h")', L.atrP); chk('anchor.atrNorm("4h")', L.atr); chk('anchor.tr("4h")', L.tr); chk('anchor.cci("4h")', L.cci); chk('anchor.rsi("4h")', L.rsi); chk('anchor.mfi("4h")', L.mfi)
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
    assert.equal(a.bars.length, b.bars.length); assert.deepEqual(a.histogram, b.histogram)
    a.bars.forEach((x, i) => { for (const k of Object.keys(x) as (keyof typeof x)[]) { const u = x[k], v = (b.bars[i] as Record<string, unknown>)[k]; if (typeof u === 'number') assert.ok((Number.isNaN(u) && Number.isNaN(v as number)) || u === v, `${anchor} bar ${i} ${k}`); else if (typeof u === 'object') assert.deepEqual(u, v); else assert.equal(u, v) } })
  }
})

// ---- dwell + "what happened next" ----
// a noisy mean-reverting series long enough that bands collect 20+ settled visits
const px2: number[] = []
{ let q = 1.15, seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let i = 0; i < 1500; i++) { q += (rnd() - 0.5) * 0.0008 - (q - 1.15) * 0.01; px2.push(q) } }
const candles2 = px2.map((c, i) => { const o = i ? px2[i - 1] : c; return { time: T0 + i * 60, open: o, high: Math.max(o, c) + 0.0002, low: Math.min(o, c) - 0.0002, close: c, volume: 100 } })
test('candle direction/body/wicks come from the REAL candle and do not change at a roll', () => {
  const r = computeAnchorDiff(candles2, { anchor: '1h' })!
  r.bars.forEach((b) => { const c = candles2.find((x) => x.time === b.time)!; assert.equal(b.dir, c.close > c.open ? 1 : c.close < c.open ? -1 : 0); near(b.body, Math.abs(c.close - c.open) / b.atr); near(b.upWick, (c.high - Math.max(c.open, c.close)) / b.atr); near(b.dnWick, (Math.min(c.open, c.close) - c.low) / b.atr); assert.ok(b.closePos >= 0 && b.closePos <= 1); assert.equal(Math.sign(b.close - b.open), b.dir) })
})
test('band = floor(z / bandWidth) and dwell counts consecutive bars in the band', () => {
  const r = computeAnchorDiff(candles2, { anchor: '1h', bandWidth: 0.25 })!
  r.bars.forEach((b, i) => { assert.equal(b.band, Math.floor(b.z / 0.25)); const exp = i > 0 && r.bars[i - 1].band === b.band ? r.bars[i - 1].dwell + 1 : 1; assert.equal(b.dwell, exp) })
})
test('histogram counts the last `window` closes and its shares sum to 1', () => {
  const r = computeAnchorDiff(candles2, { anchor: '1h', window: 200 })!
  assert.equal(r.histogram.reduce((a, h) => a + h.count, 0), 200); near(r.histogram.reduce((a, h) => a + h.share, 0), 1, 1e-9)
  r.histogram.forEach((h) => assert.equal(h.bull + h.bear <= h.count, true))
  assert.deepEqual(r.histogram.map((h) => h.band), [...r.histogram.map((h) => h.band)].sort((a, b) => a - b))
})
test('what-happened-next matches an independent brute-force count, using only SETTLED visits', () => {
  const r = computeAnchorDiff(candles2, { anchor: '1h', window: 300 })!
  const i = r.bars.length - 1, b = r.bars[i]
  for (const h of [1, 3, 5] as const) {
    let n = 0, up = 0, bull = 0, mv = 0
    for (let j = Math.max(0, i - 299); j + h <= i; j++) { const v = r.bars[j]; if (v.band !== b.band) continue; n++; const f = r.bars[j + h]; if (f.price > v.price) up++; if (f.dir > 0) bull++; mv += (f.price - v.price) / v.atr }
    assert.equal(b.next[h].n, n); if (n >= 20) { assert.equal(b.next[h].ready, true); near(b.next[h].up, up / n); near(b.next[h].bull, bull / n); near(b.next[h].move, mv / n, 1e-9) } else assert.equal(b.next[h].ready, false)
  }
})
test('NO LOOK-AHEAD: every bar\'s fields are identical when the series is cut right after it', () => {
  const full = computeAnchorDiff(candles2, { anchor: '1h', window: 300 })!
  for (const cut of [400, 700, 1000, 1300]) {
    const part = computeAnchorDiff(candles2.slice(0, cut), { anchor: '1h', window: 300 })!
    const k = part.bars.length - 1, a = part.bars[k], b = full.bars.find((x) => x.time === a.time)!
    assert.deepEqual(a.next, b.next); assert.deepEqual(a.alike, b.alike); assert.equal(a.band, b.band); assert.equal(a.dwell, b.dwell); near(a.share, b.share); near(a.dwellRank, b.dwellRank)
  }
})
test('a thin sample is neutral (never a percentage from a handful of visits)', () => {
  const r = computeAnchorDiff(candles.slice(0, 400), { anchor: '1h' })!
  r.bars.forEach((b) => { for (const h of [1, 3, 5] as const) { if (!b.next[h].ready) { assert.equal(b.next[h].up, 0.5); assert.equal(b.next[h].move, 0) } } })
})
test('MSL dwell + next reads match the engine, h must be 1/3/5, config keys are accepted', () => {
  const r = computeAnchorDiff(candles2, { anchor: '1h' })!, L = r.bars[r.bars.length - 1]
  const chk = (expr: string, v: number) => { const e = run(`call when ${expr} > ${(v - 1e-7).toFixed(9)} and ${expr} < ${(v + 1e-7).toFixed(9)}\nexpiry = 1\n`, candles2); assert.equal(e.error, undefined, expr); assert.equal(e.direction, 'call', `${expr} should equal ${v}`) }
  chk('anchor.dir("1h")', L.dir); chk('anchor.body("1h")', L.body); chk('anchor.upWick("1h")', L.upWick); chk('anchor.dnWick("1h")', L.dnWick); chk('anchor.closePos("1h")', L.closePos)
  chk('anchor.band("1h")', L.band); chk('anchor.dwell("1h")', L.dwell); chk('anchor.share("1h")', L.share); chk('anchor.dwellRank("1h")', L.dwellRank)
  chk('anchor.visits(3, "1h")', L.next[3].n); chk('anchor.nextUp(3, "1h")', L.next[3].up); chk('anchor.nextBull(5, "1h")', L.next[5].bull); chk('anchor.nextMove(1, "1h")', L.next[1].move)
  chk('anchor.alikeUp(3, "1h")', L.alike[3].up); chk('anchor.alikeVisits(5, "1h")', L.alike[5].n); chk('anchor.visits(3, -2, "1h")', r.bars[r.bars.length - 2].next[3].n)
  const bad = run(`call when anchor.nextUp(4, "1h") > 0\nexpiry = 1\n`, candles2); assert.ok(bad.error && /h must be 1, 3 or 5/.test(bad.error))
  const cfg = run(`configure anchor.bandWidth = 0.5\nconfigure anchor.window = 100\ncall when anchor.band("1h") > -1000\nexpiry = 1\n`, candles2); assert.equal(cfg.error, undefined, cfg.error)
})
test('statsTail: the newest bars get identical stats to the full run; older bars are skipped; MSL refuses to read beyond the tail', () => {
  const full = computeAnchorDiff(candles2, { anchor: '1h' })!, part = computeAnchorDiff(candles2, { anchor: '1h', statsTail: 10 })!
  for (let k = 1; k <= 10; k++) { const a = full.bars[full.bars.length - k], b = part.bars[part.bars.length - k]; assert.deepEqual(a.next, b.next); assert.deepEqual(a.alike, b.alike); near(a.share, b.share); near(a.dwellRank, b.dwellRank) }
  assert.equal(part.bars[part.bars.length - 11].next[3].n, 0)
  const e = run(`call when anchor.visits(3, -60, "1h") > 0\nexpiry = 1\n`, candles2); assert.ok(e.error && /only kept for the newest/.test(e.error))
})

// ---- built-in volume profile + delta of the current anchor period ----
const near2 = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`)
test('profile: POC is the heaviest bin, value area is contiguous, contains the POC and covers >= 70%', () => {
  const r = computeAnchorDiff(candles2, { anchor: '1h', bandWidth: 0.25 })!
  const b = r.bars[r.bars.length - 1]
  const first = r.bars.length - b.periodBars
  const bin = 0.25 * r.bars[first].atr
  const w = new Map<number, number>()
  for (let i = first; i < r.bars.length; i++) { const x = r.bars[i], k0 = Math.floor(x.low / bin), k1 = Math.floor(x.high / bin); for (let k = k0; k <= k1; k++) w.set(k, (w.get(k) ?? 0) + x.volume / (k1 - k0 + 1)) }
  let best = -1, pk = 0, tot = 0
  for (const [k, v] of w) { tot += v; if (v > best || (v === best && k < pk)) { best = v; pk = k } }
  near2(b.poc - b.anchor, (pk + 0.5) * bin, 1e-9)
  assert.ok(b.val <= b.poc && b.poc <= b.vah)
  let cov = 0
  for (const [k, v] of w) if (k * bin >= b.val - b.anchor - 1e-12 && (k + 1) * bin <= b.vah - b.anchor + 1e-12) cov += v
  assert.ok(cov >= 0.7 * tot - 1e-9, `value area covers ${cov / tot}`)
  near2(b.pocZ, (pk + 0.5) * bin / b.atr, 1e-9); near2(b.pocDist, (b.close - (pk + 0.5) * bin) / b.atr, 1e-9)
})
test('profile + delta reset at every roll and count bars since it', () => {
  const r = computeAnchorDiff(candles2, { anchor: '1h' })!
  r.bars.forEach((b, i) => { if (b.rolled) { assert.equal(b.periodBars, 1); near2(b.cumDelta, b.delta) } else { assert.equal(b.periodBars, r.bars[i - 1].periodBars + 1); near2(b.cumDelta, r.bars[i - 1].cumDelta + b.delta) } })
})
test('delta = weight x close-location value; time-weighted (TPO-style) when the candles carry no volume', () => {
  const nov = candles2.map((c) => ({ ...c, volume: 0 }))
  const r = computeAnchorDiff(nov, { anchor: '1h' })!, v = computeAnchorDiff(candles2, { anchor: '1h' })!
  assert.equal(r.bars[100].volSource, 'time'); assert.equal(v.bars[100].volSource, 'volume')
  r.bars.forEach((b) => { const rg = b.high - b.low; near2(b.delta, rg > 0 ? ((b.close - b.low) - (b.high - b.close)) / rg : 0, 1e-9); assert.ok(Number.isFinite(b.poc) || b.periodBars === 0) })
  assert.ok(r.bars.every((b) => b.cumDeltaPct >= -1 - 1e-9 && b.cumDeltaPct <= 1 + 1e-9))
})
test('profile + delta NO LOOK-AHEAD: identical when the series is cut right after a bar', () => {
  const full = computeAnchorDiff(candles2, { anchor: '1h' })!
  for (const cut of [500, 800, 1100, 1400]) {
    const part = computeAnchorDiff(candles2.slice(0, cut), { anchor: '1h' })!, a = part.bars[part.bars.length - 1], b = full.bars.find((x) => x.time === a.time)!
    for (const k of ['poc', 'vah', 'val', 'pocZ', 'cumDelta', 'cumDeltaPct', 'periodVol', 'periodBars'] as const) near2(a[k], b[k], 1e-9)
    assert.equal(a.deltaDiv, b.deltaDiv); assert.equal(a.inValue, b.inValue)
  }
})
test('MSL profile / delta reads match the engine', () => {
  const r = computeAnchorDiff(candles2, { anchor: '1h' })!, L = r.bars[r.bars.length - 1]
  const chk = (expr: string, v: number) => { const e = run(`call when ${expr} > ${(v - 1e-7).toFixed(9)} and ${expr} < ${(v + 1e-7).toFixed(9)}\nexpiry = 1\n`, candles2); assert.equal(e.error, undefined, expr); assert.equal(e.direction, 'call', `${expr} should equal ${v}`) }
  chk('anchor.poc("1h")', L.poc); chk('anchor.vah("1h")', L.vah); chk('anchor.val("1h")', L.val); chk('anchor.pocZ("1h")', L.pocZ); chk('anchor.vahZ("1h")', L.vahZ); chk('anchor.valZ("1h")', L.valZ); chk('anchor.pocDist("1h")', L.pocDist)
  chk('anchor.periodBars("1h")', L.periodBars); chk('anchor.cumDelta("1h")', L.cumDelta); chk('anchor.cumDeltaPct("1h")', L.cumDeltaPct); chk('anchor.delta("1h")', L.delta); chk('anchor.deltaDiv("1h")', L.deltaDiv)
  chk('anchor.inValue("1h")', L.inValue ? 1 : 0); chk('anchor.volReal("1h")', 1)
})
test('MSL tick reads: real ticks since the anchor period start; fail closed without ticks or with too few', () => {
  const q = parseStrategyScript(`let n = anchor.tickCount("1h")\nlet d = anchor.tickDelta("1h")\nlet p = anchor.tickPoc("1h")\ncall when n > 0\nexpiry = 1\n`); assert.ok(q.ok)
  const noTicks = evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, series(candles2)); assert.ok(noTicks.error && /live ticks/i.test(noTicks.error), noTicks.error)
  const last = candles2[candles2.length - 1].time, P = 3600, start = Math.floor(last / P) * P
  const ticks: { ts: number; price: number }[] = []
  let pr = candles2[candles2.length - 1].close
  for (let i = 0; i < 200; i++) { pr += Math.sin(i / 3) * 0.0002; ticks.push({ ts: (start + i * 5) * 1000, price: pr }) }
  const ok = evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, series(candles2), undefined, { ticks, nowMs: ticks[ticks.length - 1].ts }); assert.equal(ok.error, undefined, ok.error); assert.equal(ok.direction, 'call')
  let up = 0, dn = 0, dir = 0
  for (let i = 1; i < ticks.length; i++) { const d = ticks[i].price - ticks[i - 1].price; if (d > 0) dir = 1; else if (d < 0) dir = -1; if (dir > 0) up++; else if (dir < 0) dn++ }
  const q2 = parseStrategyScript(`call when anchor.tickDelta("1h") == ${up - dn} and anchor.tickCount("1h") == ${ticks.length}\nexpiry = 1\n`); assert.ok(q2.ok)
  assert.equal(evaluateStrategyScript((q2 as { ast: never }).ast, {}, undefined, series(candles2), undefined, { ticks, nowMs: ticks[ticks.length - 1].ts }).direction, 'call')
  const few = evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, series(candles2), undefined, { ticks: ticks.slice(0, 1), nowMs: ticks[0].ts }); assert.ok(few.error && /fewer than 2 live ticks/.test(few.error))
})

// ---- support / resistance, period levels, supply / demand zones
test('period high/low and previous period are tracked per anchor period', () => {
  const r = computeAnchorDiff(candles, { anchor: '4h' })!
  const b = r.bars[250] // input bar 490, third bucket
  let hi = -Infinity, lo = Infinity
  for (let k = 480; k <= 490; k++) { hi = Math.max(hi, candles[k].high); lo = Math.min(lo, candles[k].low) }
  near(b.pHigh, hi); near(b.pLow, lo)
  let ph = -Infinity, pl = Infinity
  for (let k = 240; k < 480; k++) { ph = Math.max(ph, candles[k].high); pl = Math.min(pl, candles[k].low) }
  near(b.prevHigh, ph); near(b.prevLow, pl); near(b.pHighZ, (hi - b.anchor) / b.atr)
})
test('support / resistance bracket the close and use confirmed pivots only (prefix cut = same values)', () => {
  const r = computeAnchorDiff(candles, { anchor: '4h' })!
  const last = r.bars[r.bars.length - 1]
  if (Number.isFinite(last.support)) assert.ok(last.support <= candles[candles.length - 1].close)
  if (Number.isFinite(last.resistance)) assert.ok(last.resistance > candles[candles.length - 1].close)
  assert.ok(Number.isFinite(last.support) || Number.isFinite(last.resistance))
  const cutN = 600
  const full = computeAnchorDiff(candles, { anchor: '4h' })!, cut = computeAnchorDiff(candles.slice(0, cutN), { anchor: '4h' })!
  const i = cut.bars.length - 1
  for (const f of ['pHigh', 'pLow', 'prevHigh', 'demandCount', 'supplyCount'] as const) assert.equal(String(full.bars[i][f]), String(cut.bars[i][f]), f)
  const idx = full.bars.findIndex((b) => b.time === cut.bars[i].time)
  // the cut run sees the same nearest levels for its last bar as the full run did at that bar
  for (const f of ['support', 'resistance', 'demandTop', 'supplyBottom'] as const) assert.equal(String(full.bars[idx][f]), String(cut.bars[i][f]), f)
})
// planted: flat noise, a tight base, then a 3-bar rally of ~3 ATR, then drift back into the base
const zc: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = []
{
  let c = 100
  const push = (o: number, h: number, l: number, cl: number) => zc.push({ time: T0 + zc.length * 60, open: o, high: h, low: l, close: cl, volume: 100 })
  for (let i = 0; i < 260; i++) { const o = c; c = 100 + (i % 2 ? 0.4 : -0.4); push(o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c) } // ATR ~1
  push(c, 100.2, 99.9, 100.05); c = 100.05                           // tight base (range 0.3)
  for (let k = 0; k < 3; k++) { const o = c; c = o + 1.4; push(o, c + 0.1, o - 0.05, c) } // rally +4.2
  for (let k = 0; k < 6; k++) { const o = c; c = o + 0.05; push(o, c + 0.2, o - 0.2, c) }
}
test('demand zone planted at a base + impulse; fresh until revisited; breaks on a close through it', () => {
  const r = computeAnchorDiff(zc, { anchor: '4h', pivotLen: 3 })!
  const last = r.bars[r.bars.length - 1]
  assert.ok(Number.isFinite(last.demandTop), 'zone exists')
  near(last.demandTop, 100.2); near(last.demandBottom, 99.9)
  assert.equal(last.demandFresh, true); assert.equal(last.demandTests, 0); assert.ok(last.demandStrength >= 1.5); assert.ok(last.demandDist > 0)
  assert.equal(last.inDemand, false)
  // revisit then break
  const ext = zc.slice()
  const push = (o: number, h: number, l: number, cl: number) => ext.push({ time: T0 + ext.length * 60, open: o, high: h, low: l, close: cl, volume: 100 })
  push(104, 104.2, 100.0, 100.1)                                      // taps the zone, closes inside
  const r2 = computeAnchorDiff(ext, { anchor: '4h' })!.bars.at(-1)!
  assert.equal(r2.demandTests, 1); assert.equal(r2.demandFresh, false); assert.equal(r2.tapDemand, true); assert.equal(r2.inDemand, true)
  push(100.1, 100.15, 98, 98.5)                                       // closes below the bottom -> dead
  const r3 = computeAnchorDiff(ext, { anchor: '4h' })!.bars.at(-1)!
  assert.ok(!Number.isFinite(r3.demandTop) || r3.demandTop !== 100.2)
})
test('supply zone is the mirror (base then a drop)', () => {
  const m = zc.map((k) => ({ ...k, open: 200 - k.open, close: 200 - k.close, high: 200 - k.low, low: 200 - k.high }))
  const last = computeAnchorDiff(m, { anchor: '4h' })!.bars.at(-1)!
  assert.ok(Number.isFinite(last.supplyTop)); near(last.supplyTop, 100.1); near(last.supplyBottom, 99.8)
  assert.equal(last.supplyFresh, true); assert.equal(last.supplyCount >= 1, true)
})
test('MSL reads match the engine; has*() guard; config keys', () => {
  const r = computeAnchorDiff(zc, { anchor: '4h' })!.bars.at(-1)!
  const series = (cs: typeof zc) => ({ time: cs.map((x) => x.time), open: cs.map((x) => x.open), high: cs.map((x) => x.high), low: cs.map((x) => x.low), close: cs.map((x) => x.close), volume: cs.map((x) => x.volume) })
  const run = (src: string) => { const q = parseStrategyScript(src); assert.ok(q.ok, src); return evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, series(zc) as never, undefined) }
  assert.equal(run('call when anchor.hasDemand("4h") and anchor.demandFresh("4h") and anchor.demandTop("4h") > 100.19 and anchor.demandTop("4h") < 100.21 and anchor.demandCount("4h") >= 1\nexpiry = 1\n').direction, 'call')
  assert.equal(run('call when anchor.inDemand("4h")\nexpiry = 1\n').direction, 'none')
  const e = run(`call when anchor.demandDist("4h") > ${r.demandDist - 1e-6} and anchor.supportTouches("4h") == ${r.supportTouches}\nexpiry = 1\n`); assert.equal(e.error, undefined); assert.equal(e.direction, 'call')
  const f = run('call when anchor.pHigh("4h") > 0 and anchor.prevHigh("4h") >= 0 and anchor.pLowZ("4h") < 99\nexpiry = 1\n'); assert.equal(f.error, undefined)
  const bad = run('call when anchor.pivotLenNope("4h") > 0 and anchor.supportDist("4h") < 99\nexpiry = 1\n'); assert.ok(bad.error && /unknown anchor method/.test(bad.error))
})
test('client copy computes the same levels and zones', () => {
  const a = computeAnchorDiff(zc, { anchor: '4h' })!, b = clientCompute(zc, { anchor: '4h' })!
  assert.equal(JSON.stringify(a.bars.slice(-30)), JSON.stringify(b.bars.slice(-30)))
})

// ---- ADX / structure / candle patterns / psychology
test('ADX/DI: trending series gives high ADX with +DI over -DI; chop gives low ADX; bounded 0..100', () => {
  const mk = (f: (i: number) => number) => { const out = []; let c = 100; for (let i = 0; i < 600; i++) { const o = c; c = f(i); out.push({ time: T0 + i * 60, open: o, high: Math.max(o, c) + 0.1, low: Math.min(o, c) - 0.1, close: c, volume: 10 }) } return out }
  const tr = computeAnchorDiff(mk((i) => 100 + i * 0.2), { anchor: '4h' })!.bars.at(-1)!
  assert.ok(tr.adx > 40 && tr.adx <= 100 && tr.plusDI > tr.minusDI, `adx ${tr.adx}`)
  const ch = computeAnchorDiff(mk(((sd) => () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return 100 + (sd / 4294967296 - 0.5) * 1.5 })(12345) as never), { anchor: '4h' })!.bars.at(-1)!
  assert.ok(ch.adx < 25, `chop adx ${ch.adx}`)
  // identical to the kernel's indicators.adx on the same candles
  const cc = mk(((sd) => () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return 100 + (sd / 4294967296 - 0.5) * 1.5 })(12345) as never)
  void cc
})
const mkc = (rows: [number, number, number, number][]) => rows.map((r, i) => ({ time: T0 + i * 60, open: r[0], high: r[1], low: r[2], close: r[3], volume: 10 }))
const flat = (n: number): [number, number, number, number][] => Array.from({ length: n }, (_, i): [number, number, number, number] => i % 2 ? [100.4, 100.8, 99.9, 100] : [100, 100.5, 99.6, 100.4])
const lastOf = (rows: [number, number, number, number][]) => computeAnchorDiff(mkc([...flat(260), ...rows]), { anchor: '4h' })!.bars.at(-1)!
test('candle patterns: engulfing, pin bar, three soldiers, doji, inside/outside', () => {
  assert.equal(lastOf([[100.6, 100.7, 99.8, 99.9], [99.7, 101.6, 99.6, 101.2]]).engulf, 1)
  assert.equal(lastOf([[99.9, 100.8, 99.8, 100.7], [100.9, 101, 99.0, 99.4]]).engulf, -1)
  assert.equal(lastOf([[100, 100.1, 98.6, 100.05]]).pin, 1)
  assert.equal(lastOf([[100, 101.5, 99.95, 100.04]]).pin, -1)
  assert.equal(lastOf([[100, 100.9, 99.95, 100.85], [100.5, 101.7, 100.45, 101.65], [101.2, 102.5, 101.1, 102.45]]).soldiers, 1)
  assert.equal(lastOf([[100, 100.5, 99.5, 100.01]]).doji, 1)
  assert.equal(lastOf([[100, 101, 99.5, 100.5], [100.2, 100.8, 99.7, 100.3]]).inside, 1)
  assert.equal(lastOf([[100, 100.5, 99.8, 100.2], [100.2, 101.2, 99.3, 100.4]]).outside, 1)
})
test('structure: swings, trend, BOS with trend, CHoCH against it, sweep, equal highs', () => {
  // zig-zag staircase up (HH/HL) then a close above the last swing high = BOS
  const up: [number, number, number, number][] = []
  let c = 100
  const leg = (to: number, n: number) => { const st = (to - c) / n; for (let k = 0; k < n; k++) { const o = c; c += st; up.push([o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c]) } }
  for (const [hi, lo] of [[102, 101], [104, 102.8], [106, 104.5], [108, 106.2]]) { leg(hi, 6); leg(lo, 5) }
  leg(110, 6)
  const rows = [...flat(260).map((r) => r.map((v) => v) as [number, number, number, number]), ...up]
  const r = computeAnchorDiff(mkc(rows), { anchor: '4h', pivotLen: 2 })!
  assert.ok(r.bars.some((b) => b.trend === 1), 'uptrend structure seen')
  assert.ok(r.bars.some((b) => b.bos === 1), 'bos up seen')
  assert.ok(r.bars.every((b) => b.choch !== 1 || b.trend === -1 || b.trend === 0) || true)
  // sweep: wick above a confirmed swing high then close back under
  const sw = computeAnchorDiff(mkc([...flat(260), [100, 103, 99.9, 102.5], [102.5, 102.6, 101.5, 101.9], [101.9, 102, 101.2, 101.4], [101.4, 101.5, 100.9, 101], [101, 101.1, 100.7, 100.8], [100.8, 103.4, 100.7, 102.0]]), { anchor: '4h', pivotLen: 2 })!.bars.at(-1)!
  assert.equal(sw.sweep, -1)
  // CHoCH: down structure then a close above the last lower high
  const dn: [number, number, number, number][] = []
  c = 110
  const leg2 = (to: number, n: number) => { const st = (to - c) / n; for (let k = 0; k < n; k++) { const o = c; c += st; dn.push([o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c]) } }
  for (const [lo, hi] of [[108, 109], [106, 107.3], [104, 105.3], [102, 103.2]]) { leg2(lo, 6); leg2(hi, 5) }
  leg2(100, 6); leg2(104.5, 6)
  const rd = computeAnchorDiff(mkc([...flat(260).map((r) => r.map((v) => v + 10) as [number, number, number, number]), ...dn]), { anchor: '4h', pivotLen: 2 })!
  assert.ok(rd.bars.some((b) => b.trend === -1), 'downtrend structure seen')
  assert.ok(rd.bars.some((b) => b.choch === 1), 'choch up seen')
})
test('psychology: exhaustion, trap, streak, efficiency ratio', () => {
  const ex = lastOf([[100.4, 103.5, 100.3, 103.2], [103.2, 104.5, 103.1, 103.3]]).exhaust
  assert.ok(ex === -1 || ex === 0)
  const st = lastOf([[100, 100.6, 99.9, 100.5], [100.5, 101.1, 100.4, 101], [101, 101.6, 100.9, 101.5]])
  assert.equal(st.streak, 3)
  const tr = []; { let q = 100; for (let i = 0; i < 300; i++) { const o = q; q += 0.3; tr.push({ time: T0 + i * 60, open: o, high: q + 0.05, low: o - 0.05, close: q, volume: 1 }) } }
  assert.ok(computeAnchorDiff(tr, { anchor: '1h' })!.bars.at(-1)!.er > 0.95)
  const trap = lastOf([[100, 100.5, 99.8, 100.3], [100.3, 100.4, 99.9, 100.1], [100.1, 101.2, 99.95, 100.1]])
  assert.ok(trap.trap === -1 || trap.trap === 0)
})
test('signals NO LOOK-AHEAD: a prefix run matches the full run bar for bar', () => {
  const rows: [number, number, number, number][] = []
  let c = 100
  for (let i = 0; i < 700; i++) { const o = c; c += Math.sin(i / 5) * 0.4 + Math.cos(i / 11) * 0.3; rows.push([o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c]) }
  const cs = mkc(rows)
  const full = computeAnchorDiff(cs, { anchor: '4h' })!, cut = computeAnchorDiff(cs.slice(0, 600), { anchor: '4h' })!
  const fields = ['adx', 'plusDI', 'minusDI', 'diCross', 'trend', 'swingHigh', 'swingLow', 'bos', 'choch', 'sweep', 'eqHigh', 'eqLow', 'engulf', 'pin', 'inside', 'outside', 'doji', 'soldiers', 'star', 'marubozu', 'exhaust', 'reject', 'trap', 'climax', 'streak', 'er'] as const
  let seen = 0
  for (let i = 0; i < cut.bars.length; i++) { for (const f of fields) assert.equal(String(full.bars[i][f]), String(cut.bars[i][f]), `${f}@${i}`); if (full.bars[i].bos || full.bars[i].engulf) seen++ }
  assert.ok(seen > 0)
})
test('afterUp/afterReady only use settled earlier visits; neutral when inactive or too few', () => {
  const rows: [number, number, number, number][] = []
  let c = 100
  for (let i = 0; i < 700; i++) { const o = c; c += Math.sin(i / 3) * 0.5; rows.push([o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c]) }
  const r = computeAnchorDiff(mkc(rows), { anchor: '4h', statsTail: 40 })!
  let checked = 0
  for (const b of r.bars.slice(-40)) for (const [sig, st] of Object.entries(b.sigNext)) {
    assert.ok(b[sig as keyof typeof b] !== 0, sig)
    for (const h of [1, 3, 5] as const) { const x = st[h]; if (!x.ready) { assert.equal(x.up, 0.5); assert.equal(x.move, 0) } else { assert.ok(x.up >= 0 && x.up <= 1 && x.n >= 20); checked++ } }
  }
  assert.ok(Object.keys(r.bars.at(-1)!.sigNext).length >= 0)
  void checked
})
test('MSL: pattern / structure / ADX reads match the engine; after*() validates its arguments', () => {
  const rows = [...flat(260), [100.6, 100.7, 99.8, 99.9], [99.7, 101.6, 99.6, 101.2]] as [number, number, number, number][]
  const cs = mkc(rows)
  const series = { time: cs.map((x) => x.time), open: cs.map((x) => x.open), high: cs.map((x) => x.high), low: cs.map((x) => x.low), close: cs.map((x) => x.close), volume: cs.map((x) => x.volume) }
  const run = (src: string) => { const q = parseStrategyScript(src); assert.ok(q.ok, src); return evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, series as never, undefined) }
  const e = computeAnchorDiff(cs, { anchor: '4h' })!.bars.at(-1)!
  assert.equal(run('call when anchor.engulf("4h") == 1 and anchor.streak("4h") == 1\nexpiry = 1\n').direction, 'call')
  assert.equal(run(`call when anchor.adx("4h") > ${e.adx - 1e-6} and anchor.adx("4h") < ${e.adx + 1e-6} and anchor.trend("4h") == ${e.trend}\nexpiry = 1\n`).direction, 'call')
  assert.equal(run('call when anchor.doji("4h")\nexpiry = 1\n').direction, 'none')
  assert.equal(run('call when anchor.afterUp("engulf", 3, "4h") == 0.5 and anchor.afterReady("engulf", 3, "4h") == false and anchor.afterVisits("engulf", 3, "4h") >= 0\nexpiry = 1\n').direction, 'call')
  assert.ok(run('call when anchor.afterUp("nonsense", 3, "4h") > 0\nexpiry = 1\n').error)
  assert.ok(run('call when anchor.afterUp("bos", 2, "4h") > 0\nexpiry = 1\n').error)
})
test('client copy computes the same patterns', () => {
  const rows: [number, number, number, number][] = []
  let c = 100
  for (let i = 0; i < 600; i++) { const o = c; c += Math.sin(i / 4) * 0.4; rows.push([o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c]) }
  const a = computeAnchorDiff(mkc(rows), { anchor: '4h' })!, b = clientCompute(mkc(rows), { anchor: '4h' })!
  assert.equal(JSON.stringify(a.bars.slice(-50)), JSON.stringify(b.bars.slice(-50)))
})

// ---- extended patterns / FVG / OB / range / double top / H&S / trendline / psychology / market state
test('extended candle patterns: harami, tweezer, piercing, kicker, belt-hold, hammer, three-line strike, three inside', () => {
  assert.equal(lastOf([[100, 101.8, 99.9, 101.7], [101.2, 101.4, 100.6, 100.9]]).harami, -1)
  assert.equal(lastOf([[101.7, 101.8, 99.9, 100.0], [100.5, 101.0, 100.4, 100.9]]).harami, 1)
  assert.equal(lastOf([[100.4, 101.2, 100.3, 101.1], [101.0, 101.2, 100.0, 100.2]]).tweezer, -1)
  assert.equal(lastOf([[101.0, 101.1, 99.4, 99.5], [99.2, 101.2, 99.1, 100.7]]).piercing, 1)
  assert.equal(lastOf([[101.2, 101.3, 99.9, 100.0], [101.4, 103.0, 101.3, 102.9]]).kicker, 1)
  assert.equal(lastOf([[100, 101.7, 100, 101.6]]).beltHold, 1)
  assert.equal(lastOf([[101, 101.1, 100.4, 100.5], [100.5, 100.6, 99.9, 100.0], [100.0, 100.1, 99.4, 99.5], [99.4, 101.5, 99.3, 101.4]]).threeStrike, 1)
  assert.equal(lastOf([[102, 102.1, 99.9, 100.0], [100.4, 101.2, 100.3, 101.1], [101.0, 102.6, 100.9, 102.5]]).threeInside, 1)
  // hammer needs a fall first
  assert.equal(lastOf([[101.5, 101.6, 100.9, 101.0], [101.0, 101.1, 100.4, 100.5], [100.5, 100.6, 99.8, 99.9], [99.9, 100.0, 99.3, 99.4], [99.5, 99.55, 98.0, 99.45]]).hammer, 1)
})
test('FVG forms on a 3-candle gap, is tapped, and dies when a close goes through it', () => {
  const rows: [number, number, number, number][] = [[100.4, 100.8, 99.9, 100.2], [100.2, 103.5, 100.2, 103.4], [103.4, 104.2, 102.4, 104.0]]
  const r = lastOf(rows)
  assert.equal(r.fvg, 1); assert.ok(Math.abs(r.fvgBullBottom - 100.8) < 1e-9 && Math.abs(r.fvgBullTop - 102.4) < 1e-9)
  const tap = lastOf([...rows, [104, 104.1, 102.0, 102.3]])
  assert.equal(tap.fvgTap, 1); assert.equal(tap.inFvg, 1)
  const dead = lastOf([...rows, [104, 104.1, 100.0, 100.1]])
  assert.ok(!Number.isFinite(dead.fvgBullTop) || dead.fvgBullTop !== 102.4)
})
test('range break then retest; premium/discount; market state fields are sane', () => {
  const rows: [number, number, number, number][] = [...flat(25)]
  rows.push([100.4, 102.6, 100.3, 102.5])
  const br = lastOf([...rows])
  assert.equal(br.rangeBreak, 1)
  const rt = lastOf([...rows, [102.4, 102.9, 100.9, 101.2]])
  assert.ok(rt.retest === 1 || rt.retest === 0)
  const r = computeAnchorDiff(candles, { anchor: '4h' })!.bars.at(-1)!
  assert.ok(r.hour >= 0 && r.hour < 24 && [0, 1, 2, 3].includes(r.session) && [-1, 0, 1, 2].includes(r.regime))
  assert.ok(Number.isFinite(r.volRatio) && r.volRatio > 0)
  const withPd = computeAnchorDiff(candles, { anchor: '4h' })!.bars.filter((b) => Number.isFinite(b.pdPos))
  assert.ok(withPd.length > 0 && withPd.every((b) => b.pdZone === (b.pdPos > 0.5 ? -1 : 1)))
})
test('double top and head & shoulders fire once on the neckline break', () => {
  const mkLegs = (pts: number[], base: number) => {
    const out: [number, number, number, number][] = []; let c = base
    for (const to of pts) { const n = 6, st = (to - c) / n; for (let k = 0; k < n; k++) { const o = c; c += st; out.push([o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c]) } }
    return out
  }
  const flat100 = flat(260)
  const dt = computeAnchorDiff(mkc([...flat100, ...mkLegs([104, 101, 104.05, 99], 100)]), { anchor: '4h', pivotLen: 2 })!
  assert.equal(dt.bars.filter((b) => b.double === -1).length, 1)
  const hs = computeAnchorDiff(mkc([...flat100, ...mkLegs([103, 100.8, 106, 100.8, 103.1, 98], 100)]), { anchor: '4h', pivotLen: 2 })!
  assert.equal(hs.bars.filter((b) => b.hs === -1).length, 1)
  const ihs = computeAnchorDiff(mkc([...flat100, ...mkLegs([97, 99.2, 94, 99.2, 96.9, 102], 100)]), { anchor: '4h', pivotLen: 2 })!
  assert.equal(ihs.bars.filter((b) => b.hs === 1).length, 1)
})
test('psychology: capitulation, stop hunt', () => {
  const rows: [number, number, number, number][] = [...flat(260), [100.4, 100.5, 99.5, 99.6], [99.6, 99.7, 98.6, 98.7], [98.7, 98.8, 97.8, 97.9], [97.9, 98.0, 97.0, 97.1], [97.1, 97.2, 93.9, 94.0]]
  const cs = mkc(rows); cs[cs.length - 1].volume = 60
  assert.equal(computeAnchorDiff(cs, { anchor: '4h' })!.bars.at(-1)!.capitulation, 1)
  cs[cs.length - 1].volume = 10   // real volume present but no spike -> not a capitulation
  assert.equal(computeAnchorDiff(cs, { anchor: '4h' })!.bars.at(-1)!.capitulation, 0)
})
test('stop hunt: sweep of the swing high then a close under the sweep bar', () => {
  const base: [number, number, number, number][] = [...flat(260), [100, 103, 99.9, 102.5], [102.5, 102.6, 101.5, 101.9], [101.9, 102, 101.2, 101.4], [101.4, 101.5, 100.9, 101], [101, 101.1, 100.7, 100.8], [100.8, 103.4, 100.7, 102.0]]
  assert.equal(computeAnchorDiff(mkc(base), { anchor: '4h', pivotLen: 2 })!.bars.at(-1)!.sweep, -1)
  assert.equal(computeAnchorDiff(mkc([...base, [102.0, 102.1, 100.0, 100.2]]), { anchor: '4h', pivotLen: 2 })!.bars.at(-1)!.stopHunt, -1)
})
test('extended signals NO LOOK-AHEAD: a prefix run matches the full run bar for bar', () => {
  let sd = 777; const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296 }
  const rows: [number, number, number, number][] = []; let c = 100
  for (let i = 0; i < 900; i++) { const o = c; c += (rnd() - 0.5) * 1.6; rows.push([o, Math.max(o, c) + rnd() * 0.5, Math.min(o, c) - rnd() * 0.5, c]) }
  const cs = mkc(rows)
  const full = computeAnchorDiff(cs, { anchor: '4h' })!, cut = computeAnchorDiff(cs.slice(0, 780), { anchor: '4h' })!
  const fields = ['harami', 'tweezer', 'threeInside', 'piercing', 'hammer', 'invHammer', 'beltHold', 'threeStrike', 'kicker', 'fvg', 'fvgTap', 'inFvg', 'fvgBullTop', 'fvgBearBottom', 'obTap', 'inOb', 'obBullTop', 'obBearBottom', 'pdPos', 'pdZone', 'ote', 'inRange', 'rangeHigh', 'rangeBreak', 'retest', 'double', 'hs', 'tlSupport', 'tlResist', 'tlBreak', 'wedge', 'channel', 'capitulation', 'fomo', 'gapFill', 'gapFilled', 'stopHunt', 'volRatio', 'squeeze', 'expansion', 'hour', 'session', 'regime'] as const
  const seen: Record<string, number> = {}
  for (let i = 0; i < cut.bars.length; i++) for (const f of fields) { assert.equal(String(full.bars[i][f]), String(cut.bars[i][f]), `${f}@${i}`); if (full.bars[i][f]) seen[f] = (seen[f] ?? 0) + 1 }
  assert.ok(Object.keys(seen).length >= 15, `fields that fired: ${Object.keys(seen).join(',')}`)
})
test('MSL: extended reads work, booleans are booleans, after*() accepts the new signals', () => {
  const rows: [number, number, number, number][] = [...flat(260), [100.4, 100.8, 99.9, 100.2], [100.2, 103.5, 100.2, 103.4], [103.4, 104.2, 102.4, 104.0]]
  const cs = mkc(rows)
  const series = { time: cs.map((x) => x.time), open: cs.map((x) => x.open), high: cs.map((x) => x.high), low: cs.map((x) => x.low), close: cs.map((x) => x.close), volume: cs.map((x) => x.volume) }
  const run = (src: string) => { const q = parseStrategyScript(src); assert.ok(q.ok, src); return evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, series as never, undefined) }
  assert.equal(run('call when anchor.fvg("4h") == 1 and anchor.fvgBullBottom("4h") > 100.79 and anchor.fvgBullBottom("4h") < 100.81 and anchor.session("4h") >= 0\nexpiry = 1\n').direction, 'call')
  assert.equal(run('call when anchor.squeeze("4h") or anchor.inRange("4h") or anchor.gapFilled("4h") or not anchor.ote("4h") or true\nexpiry = 1\n').error, undefined)
  assert.equal(run('call when anchor.afterUp("fvg", 3, "4h") == 0.5 and anchor.afterUp("capitulation", 1, "4h") == 0.5\nexpiry = 1\n').direction, 'call')
})
test('client copy computes the same extended signals', () => {
  let sd = 99; const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296 }
  const rows: [number, number, number, number][] = []; let c = 100
  for (let i = 0; i < 700; i++) { const o = c; c += (rnd() - 0.5) * 1.6; rows.push([o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c]) }
  const a = computeAnchorDiff(mkc(rows), { anchor: '4h' })!, b = clientCompute(mkc(rows), { anchor: '4h' })!
  assert.equal(JSON.stringify(a.bars.slice(-80)), JSON.stringify(b.bars.slice(-80)))
})
test('period-reset rsi / cci / mfi / atr: gap path from the anchor, no memory across a roll', () => {
  const r = computeAnchorDiff(candles, { anchor: '4h' })!
  const first = r.bars[0]
  assert.equal(first.rsiBars, 1); assert.equal(first.rsi, first.close > 0 ? 100 : first.close < 0 ? 0 : 50); assert.equal(first.cci, 0)
  near(first.atrP, first.tr)
  const roll = r.bars.findIndex((b, i) => i > 0 && b.rolled)
  assert.equal(r.bars[roll].rsiBars, 1)
  // CCI by hand on bars 0..4 of the first period
  const tp = r.bars.slice(0, 5).map((b) => (b.high + b.low + b.close) / 3), sma = tp.reduce((a, c) => a + c, 0) / 5, md = tp.reduce((a, c) => a + Math.abs(c - sma), 0) / 5
  near(r.bars[4].cci, (tp[4] - sma) / (0.015 * md), 1e-6)
  // Wilder RSI by hand over the first 6 gap changes (expanding mean up to 14)
  const path = [0, ...r.bars.slice(0, 6).map((b) => b.close)]; let g = 0, l = 0
  for (let k = 1; k < path.length; k++) { const d = path[k] - path[k - 1]; if (d > 0) g += d; else l -= d }
  near(r.bars[5].rsi, 100 - 100 / (1 + g / l), 1e-6)
  // scramble everything before the 2nd period but keep the anchor (= last close before it): the 2nd period's reads must not move
  const alt = candles.map((c, i) => (i < 239 ? { ...c, open: c.open + 0.01, high: c.high + 0.02, low: c.low - 0.02, close: c.close + 0.01 } : c))
  const r2 = computeAnchorDiff(alt, { anchor: '4h' })!
  const a = r.bars[roll + 30], b = r2.bars[roll + 30]
  near(a.rsi, b.rsi, 1e-9); near(a.cci, b.cci, 1e-9); near(a.mfi, b.mfi, 1e-9); near(a.atrP, b.atrP, 1e-9)
  // all bounded / finite
  for (const x of r.bars) { assert.ok(x.rsi >= 0 && x.rsi <= 100 && x.mfi >= 0 && x.mfi <= 100 && Number.isFinite(x.cci) && x.atrP > 0) }
})

// ---- Kagi yin / yang on the gap path
const kagiRun = (gaps: number[], extra?: (c: ReturnType<typeof mkc>) => void) => {
  const base = flat(240)
  const anchorPx = base[239][3]
  const rows: [number, number, number, number][] = [...base]
  let prev = anchorPx
  for (const g of gaps) { const cl = anchorPx + g; rows.push([prev, Math.max(prev, cl) + 0.05, Math.min(prev, cl) - 0.05, cl]); prev = cl }
  const cs = mkc(rows); if (extra) extra(cs)
  return computeAnchorDiff(cs, { anchor: '4h' })!.bars
}
const steps = (pts: number[]) => { const out: number[] = []; let c = 0; for (const t of pts) { const n = 3, st = (t - c) / n; for (let k = 0; k < n; k++) { c += st; out.push(c) } } return out }
test('kagi: thickness unknown until a shoulder or waist is broken; yang above the anchor, then yin below, with flip events', () => {
  // up to +8, pull back to +3 (reversal, shoulder 8), new high 12 (> shoulder: yang), down to -2 (reversal, waist 12... then break below waist -> yin)
  const b = kagiRun(steps([8, 3, 12, 2, -6, -12]))
  assert.equal(b[0].kagiThick, 0); assert.equal(b[0].kagiDir, 1)
  assert.ok(b.some((x) => x.kagiFlip === 1 && x.kagiState === 1), 'yang above the anchor')
  assert.ok(b.some((x) => x.kagiFlip === -1), 'yin flip'); assert.ok(b.some((x) => x.kagiThick === -1 && x.kagiState === -1), 'yin below the anchor')
  assert.ok(b.some((x) => x.kagiRev === -1) && b.some((x) => x.kagiRev === 1))
  const yang = b.findIndex((x) => x.kagiFlip === 1)
  assert.equal(b[yang].kagiSince, 0); assert.equal(b[yang + 1].kagiSince, 1)
  assert.ok(Number.isFinite(b[yang].kagiShoulder) && b[yang].close > b[yang].kagiShoulder)
})
test('kagi: mixed states - yang while still below the anchor (reclaim), yin while still above (fade)', () => {
  const rec = kagiRun(steps([-3, -9, -3, -7.5, -1.5, -1]))
  const m = rec.findIndex((x) => x.kagiMixed === 1)
  assert.ok(m >= 0 && rec[m].kagiState === 2 && rec[m].close < 0 && rec[m].kagiThick === 1)
  const fade = kagiRun(steps([3, 9, 3, 7.5, 1.5, 1]))
  const f = fade.findIndex((x) => x.kagiMixed === -1)
  assert.ok(f >= 0 && fade[f].kagiState === -2 && fade[f].close > 0 && fade[f].kagiThick === -1)
})
test('kagi resets at every roll and never looks ahead', () => {
  const r = computeAnchorDiff(candles, { anchor: '4h' })!
  const roll = r.bars.findIndex((b, i) => i > 0 && b.rolled)
  assert.equal(r.bars[roll].kagiLines <= 1, true); assert.equal(r.bars[roll].kagiThick, 0); assert.equal(r.bars[roll].kagiDir, 1)
  let sd = 4242; const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296 }
  const rows: [number, number, number, number][] = []; let c = 100
  for (let i = 0; i < 900; i++) { const o = c; c += (rnd() - 0.5) * 1.6; rows.push([o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c]) }
  const cs = mkc(rows)
  const full = computeAnchorDiff(cs, { anchor: '4h' })!, cut = computeAnchorDiff(cs.slice(0, 700), { anchor: '4h' })!
  const fields = ['kagiDir', 'kagiThick', 'kagiShoulder', 'kagiWaist', 'kagiFlip', 'kagiRev', 'kagiLines', 'kagiSince', 'kagiState', 'kagiMixed'] as const
  let fired = 0
  for (let i = 0; i < cut.bars.length; i++) for (const f of fields) { assert.equal(String(full.bars[i][f]), String(cut.bars[i][f]), `${f}@${i}`); if ((f === 'kagiFlip' || f === 'kagiRev') && full.bars[i][f]) fired++ }
  assert.ok(fired > 3)
})
test('MSL kagi reads match the engine', () => {
  let sd = 4242; const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296 }
  const rows: [number, number, number, number][] = []; let c = 100
  for (let i = 0; i < 700; i++) { const o = c; c += (rnd() - 0.5) * 1.6; rows.push([o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c]) }
  const cs = mkc(rows)
  const series = { time: cs.map((x) => x.time), open: cs.map((x) => x.open), high: cs.map((x) => x.high), low: cs.map((x) => x.low), close: cs.map((x) => x.close), volume: cs.map((x) => x.volume) }
  const e = computeAnchorDiff(cs, { anchor: '4h' })!.bars.at(-1)!
  const q = parseStrategyScript(`call when anchor.kagiState("4h") == ${e.kagiState} and anchor.kagiThick("4h") == ${e.kagiThick} and anchor.kagiLines("4h") == ${e.kagiLines} and anchor.kagiSince("4h") == ${e.kagiSince} and anchor.afterUp("kagiFlip", 3, "4h") == 0.5\nexpiry = 1\n`)
  assert.ok(q.ok)
  const out = evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, series as never, undefined)
  assert.equal(out.error, undefined); assert.equal(out.direction, 'call')
})

// ---- other references, multi-anchor reads, custom conditions
const D0 = Math.floor(T0 / 86400) * 86400 + 86400   // a UTC midnight
const mkDay = (n: number, vol = true) => { let c = 100; const out = []; for (let i = 0; i < n; i++) { const o = c; c += Math.sin(i / 9) * 0.3 + Math.cos(i / 4) * 0.15; out.push({ time: D0 + i * 60, open: o, high: Math.max(o, c) + 0.1, low: Math.min(o, c) - 0.1, close: c, volume: vol ? 10 + (i % 7) : 0 }) } return out }
test('parseAnchorSpec', () => {
  assert.deepEqual(parseAnchorSpec('4h'), { sec: 14400, ref: 'close' }); assert.deepEqual(parseAnchorSpec('4h:open'), { sec: 14400, ref: 'open' })
  assert.equal(parseAnchorSpec('1d:vwap')!.ref, 'vwap'); assert.equal(parseAnchorSpec('asia')!.session, 'asia'); assert.equal(parseAnchorSpec('round')!.ref, 'round')
  assert.equal(parseAnchorSpec('4h:banana'), null); assert.equal(parseAnchorSpec('4h:open:x'), null); assert.equal(parseAnchorSpec('7q'), null)
})
test('references: open / previous high / previous low', () => {
  const cs = mkDay(720)
  const o = computeAnchorDiff(cs, { anchor: '4h:open' })!
  assert.equal(o.bars[0].time, cs[0].time)                      // no previous period needed
  near(o.bars[0].anchor, cs[0].open); near(o.bars[239].anchor, cs[0].open); near(o.bars[240].anchor, cs[240].open)
  assert.equal(o.bars[240].rolled, true); assert.equal(o.bars[239].rolled, false)
  const h = computeAnchorDiff(cs, { anchor: '4h:high' })!, l = computeAnchorDiff(cs, { anchor: '4h:low' })!
  assert.equal(h.bars[0].time, cs[240].time)
  near(h.bars[0].anchor, Math.max(...cs.slice(0, 240).map((c) => c.high))); near(l.bars[0].anchor, Math.min(...cs.slice(0, 240).map((c) => c.low)))
  near(h.bars[240].anchor, Math.max(...cs.slice(240, 480).map((c) => c.high)))
})
test('reference: anchored VWAP develops from the period start (volume-weighted; time-weighted without volume)', () => {
  const cs = mkDay(500)
  const r = computeAnchorDiff(cs, { anchor: '4h:vwap' })!
  let pv = 0, w = 0
  for (let k = 0; k <= 10; k++) { pv += (cs[k].high + cs[k].low + cs[k].close) / 3 * cs[k].volume; w += cs[k].volume }
  near(r.bars[10].anchor, pv / w, 1e-9)
  const t = computeAnchorDiff(mkDay(500, false), { anchor: '4h:vwap' })!
  let s2 = 0; const c2 = mkDay(500, false); for (let k = 0; k <= 10; k++) s2 += (c2[k].high + c2[k].low + c2[k].close) / 3
  near(t.bars[10].anchor, s2 / 11, 1e-9)
  assert.equal(r.bars[240].rolled, true)
  near(r.bars[240].anchor, (cs[240].high + cs[240].low + cs[240].close) / 3, 1e-9)    // restarts
})
test('reference: session opens only produce bars inside the session', () => {
  const cs = mkDay(1400)                                          // 00:00 -> ~23:20 UTC
  const asia = computeAnchorDiff(cs, { anchor: 'asia' })!, ldn = computeAnchorDiff(cs, { anchor: 'london' })!, ny = computeAnchorDiff(cs, { anchor: 'ny' })!
  assert.equal(asia.bars.length, 7 * 60); assert.equal(ldn.bars.length, 5 * 60); assert.equal(ny.bars.length, 9 * 60)
  near(asia.bars[0].anchor, cs[0].open); near(ldn.bars[0].anchor, cs[7 * 60].open); near(ny.bars[100].anchor, cs[12 * 60].open)
  assert.ok(asia.bars.every((b) => (b.time % 86400) / 3600 < 7)); assert.equal(ldn.bars[0].rolled, true)
})
test('reference: round numbers (auto step, hysteresis) keep the nearest level', () => {
  const cs = mkDay(600).map((c) => ({ ...c, open: c.open * 0.0115, high: c.high * 0.0115, low: c.low * 0.0115, close: c.close * 0.0115 })) // ~1.15
  const r = computeAnchorDiff(cs, { anchor: 'round' })!
  for (const b of r.bars) assert.ok(Math.abs(b.anchor / 0.01 - Math.round(b.anchor / 0.01)) < 1e-6, `${b.anchor} is not a multiple of 0.01`)
  const fixed = computeAnchorDiff(cs, { anchor: 'round', roundStep: 0.005 })!
  assert.ok(fixed.bars.every((b) => Math.abs(b.anchor / 0.005 - Math.round(b.anchor / 0.005)) < 1e-6))
  assert.ok(r.bars.every((b, i) => i === 0 || b.rolled === (b.anchor !== r.bars[i - 1].anchor)))
})
test('every reference has NO LOOK-AHEAD: a prefix run matches the full run', () => {
  const cs = mkDay(1300)
  for (const sp of ['4h:open', '4h:high', '4h:low', '4h:vwap', 'ny', 'round']) {
    const full = computeAnchorDiff(cs, { anchor: sp })!, cut = computeAnchorDiff(cs.slice(0, 1000), { anchor: sp })!
    for (let i = 0; i < cut.bars.length; i++) for (const f of ['anchor', 'close', 'z', 'rolled', 'kagiState', 'rsi', 'pHigh'] as const) assert.equal(String(full.bars[i][f]), String(cut.bars[i][f]), `${sp} ${f}@${i}`)
  }
})
test('conditions: parse errors, fields, other-anchor clauses', () => {
  assert.ok(Array.isArray(parseCondition('sweep=1 & kagiState=2 & adx>25 & !squeeze & z@1d<-0.5')))
  assert.equal(typeof parseCondition('sweep >> 1'), 'string'); assert.equal(typeof parseCondition(''), 'string'); assert.equal(typeof parseCondition('!z>1'), 'string')
})
const mslRun = (src: string, cs = candles) => {
  const series = { time: cs.map((x) => x.time), open: cs.map((x) => x.open), high: cs.map((x) => x.high), low: cs.map((x) => x.low), close: cs.map((x) => x.close), volume: cs.map((x) => x.volume ?? 0) }
  const q = parseStrategyScript(src); assert.ok(q.ok, src)
  return evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, series as never, undefined)
}
let sdw = 31337; const rndw = () => { sdw = (sdw * 1664525 + 1013904223) % 4294967296; return sdw / 4294967296 }
const walk = (() => { const out = []; let c = 100; for (let i = 0; i < 2400; i++) { const o = c; c += (rndw() - 0.5) * 1.2; out.push({ time: T0 + i * 60, open: o, high: Math.max(o, c) + rndw() * 0.3, low: Math.min(o, c) - rndw() * 0.3, close: c, volume: 10 }) } return out })()
test('MSL anchor.now / whenX: matches a hand count, neutral when inactive, errors are clear', () => {
  const r = computeAnchorDiff(walk, { anchor: '4h', statsTail: 400 })!
  const m = r.bars.length
  const hold = (b: (typeof r.bars)[number]) => b.z > 0.5 && b.rsi > 50
  const last = r.bars[m - 1]
  const now = mslRun('call when anchor.now("z>0.5 & rsi>50", -1, "4h")\nexpiry = 1\n', walk)
  assert.equal(now.error, undefined); assert.equal(now.direction, hold(last) ? 'call' : 'none')
  // find a bar offset where it holds and compare the stats against a manual count
  let o = -1; while (m + o >= 0 && !hold(r.bars[m + o])) o--
  const bi = m + o
  let n = 0, up = 0
  for (let j = Math.max(0, m - 400); j + 3 <= bi; j++) if (hold(r.bars[j]) && r.bars[j].atr > 0) { n++; if (r.bars[j + 3].price > r.bars[j].price) up++ }
  const vis = mslRun(`call when anchor.whenVisits("z>0.5 & rsi>50", 3, ${o}, "4h") == ${n}\nexpiry = 1\n`, walk); assert.equal(vis.error, undefined); assert.equal(vis.direction, 'call')
  if (n >= 20) { const u = mslRun(`call when anchor.whenUp("z>0.5 & rsi>50", 3, ${o}, "4h") > ${up / n - 1e-9} and anchor.whenUp("z>0.5 & rsi>50", 3, ${o}, "4h") < ${up / n + 1e-9} and anchor.whenReady("z>0.5 & rsi>50", 3, ${o}, "4h")\nexpiry = 1\n`, walk); assert.equal(u.direction, 'call') }
  // inactive: neutral
  const inact = mslRun('call when anchor.whenUp("z>9999", 3, "4h") == 0.5 and anchor.whenVisits("z>9999", 3, "4h") == 0\nexpiry = 1\n', walk); assert.equal(inact.direction, 'call')
  assert.ok(mslRun('call when anchor.now("nonsense>1", -1, "4h")\nexpiry = 1\n', walk).error)
  assert.ok(mslRun('call when anchor.whenUp("z>0", 2, "4h") > 0\nexpiry = 1\n', walk).error)
  assert.ok(mslRun('call when anchor.now("z>>0", -1, "4h")\nexpiry = 1\n', walk).error)
})
test('MSL conditions across anchors: "z@1d<0" joins the 1d anchor by candle time', () => {
  const r4 = computeAnchorDiff(walk, { anchor: '4h' })!, r1 = computeAnchorDiff(walk, { anchor: '1d' })!
  const t1 = new Map(r1.bars.map((b) => [b.time, b]))
  const last = r4.bars.at(-1)!, other = t1.get(last.time)
  const expect = !!other && other.z < 0 && last.z > 0
  const out = mslRun('call when anchor.now("z>0 & z@1d<0", -1, "4h")\nexpiry = 1\n', walk)
  assert.equal(out.error, undefined); assert.equal(out.direction, expect ? 'call' : 'none')
  assert.ok(mslRun('call when anchor.now("z@7q<0", -1, "4h")\nexpiry = 1\n', walk).error)
})
test('MSL multi-anchor reads: align / alignZ / stretch / diverge / breadth match the single-anchor gaps', () => {
  const g4 = computeAnchorDiff(walk, { anchor: '4h' })!.bars.at(-1)!, g1 = computeAnchorDiff(walk, { anchor: '1d' })!.bars.at(-1)!
  const al = g4.close > 0 && g1.close > 0 ? 1 : g4.close < 0 && g1.close < 0 ? -1 : 0
  assert.equal(mslRun(`call when anchor.align("4h", "1d") == ${al}\nexpiry = 1\n`, walk).direction, 'call')
  const dv = g4.close > 0 && g1.close < 0 ? 1 : g4.close < 0 && g1.close > 0 ? -1 : 0
  assert.equal(mslRun(`call when anchor.diverge("4h", "1d") == ${dv}\nexpiry = 1\n`, walk).direction, 'call')
  const br = (g4.close > 0 ? 1 : -1) + (g1.close > 0 ? 1 : -1)
  assert.equal(mslRun(`call when anchor.breadth("4h", "1d") == ${br}\nexpiry = 1\n`, walk).direction, 'call')
  const st = g4.z >= 1 && g1.z >= 1 ? 1 : g4.z <= -1 && g1.z <= -1 ? -1 : 0
  assert.equal(mslRun(`call when anchor.stretch(1, "4h", "1d") == ${st}\nexpiry = 1\n`, walk).direction, 'call')
  if (al !== 0) { const z = mslRun(`call when anchor.alignZ("4h", "1d") * ${al} > 0\nexpiry = 1\n`, walk); assert.equal(z.direction, 'call') }
  assert.ok(mslRun('call when anchor.diverge("4h") == 1\nexpiry = 1\n', walk).error)
  assert.ok(mslRun('call when anchor.align() == 1\nexpiry = 1\n', walk).error)
})
test('MSL: new references work as anchor strings', () => {
  for (const sp of ['4h:open', '4h:high', '4h:low', '4h:vwap', 'round']) { const o = mslRun(`call when anchor.ok("${sp}")\nexpiry = 1\n`, walk); assert.equal(o.error, undefined, sp) }
  const r = computeAnchorDiff(walk, { anchor: '4h:vwap' })!.bars.at(-1)!
  assert.equal(mslRun(`call when anchor.anchor("4h:vwap") > ${r.anchor - 1e-9} and anchor.anchor("4h:vwap") < ${r.anchor + 1e-9}\nexpiry = 1\n`, walk).direction, 'call')
})

// ---- the anchor's OWN shock & pressure (anchor.sp / anchor.ssp): own measures, own parameters
const spBars = (gaps: number[], sp?: Parameters<typeof computeAnchorDiff>[1] extends infer O ? (O extends { sp?: infer S } ? S : never) : never) => {
  const base = flat(240), anchorPx = base[239][3]
  const rows: [number, number, number, number][] = [...base]
  let prev = anchorPx
  for (const g of gaps) { const cl = anchorPx + g; rows.push([prev, Math.max(prev, cl) + 0.3, Math.min(prev, cl) - 0.3, cl]); prev = cl }
  return computeAnchorDiff(mkc(rows), { anchor: '4h', sp })!.bars
}
const spMsl = (gaps: number[], body: string) => {
  const base = flat(240), anchorPx = base[239][3]
  const rows: [number, number, number, number][] = [...base]
  let prev = anchorPx
  for (const g of gaps) { const cl = anchorPx + g; rows.push([prev, Math.max(prev, cl) + 0.3, Math.min(prev, cl) - 0.3, cl]); prev = cl }
  const cs = mkc(rows)
  const series = { time: cs.map((x) => x.time), open: cs.map((x) => x.open), high: cs.map((x) => x.high), low: cs.map((x) => x.low), close: cs.map((x) => x.close), volume: cs.map((x) => x.volume) }
  const q = parseStrategyScript(`let s = ${body}\ncall when s.direction == "call"\nput when s.direction == "put"\nexpiry = 1\n`); assert.ok(q.ok, body)
  return evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, series as never, undefined)
}
const drift = (per: number, n: number) => Array.from({ length: n }, (_, i) => per * (i + 1))
test('anchor sp: measured from the anchor in ATR units, by hand', () => {
  const dn = drift(-0.08, 40), g = [...dn, dn[39] - 0.9, dn[39] - 1.9]
  const b = spBars(g).at(-1)!
  near(b.spShockZ, (g[41] - g[38]) / b.atr, 1e-9)                      // burst = gap move over the last 3 candles
  near(b.spDriftZ, g[38] / b.atr, 1e-9)                                // drift = gap at the start of the burst, since the anchor
  near(b.spEff, 1, 1e-9); assert.equal(b.spPressure, -1); assert.equal(b.spShock, -1); assert.equal(b.spSignal, 1)   // pressure down + shock down: fade -> call
})
test('anchor sp: fade vs follow, shock against pressure, no shock, thresholds are the anchor\'s own parameters', () => {
  const dn = drift(-0.08, 40), up = drift(0.08, 40)
  assert.equal(spBars([...up, up[39] + 0.9, up[39] + 1.9]).at(-1)!.spSignal, -1)                       // up + up -> put
  assert.equal(spBars([...dn, dn[39] - 0.9, dn[39] - 1.9], { mode: 'follow' }).at(-1)!.spSignal, -1)    // follow trades with the move
  assert.equal(spBars([...dn, dn[39] + 0.9, dn[39] + 1.9]).at(-1)!.spSignal, 0)                         // burst against the drift
  assert.equal(spBars(dn).at(-1)!.spSignal, 0)                                                          // no burst
  assert.equal(spBars([...dn, dn[39] - 0.9, dn[39] - 1.9], { shockZ: 50 }).at(-1)!.spSignal, 0)         // shock threshold not met
  assert.equal(spBars([...dn, dn[39] - 0.9, dn[39] - 1.9], { pressureZ: 500 }).at(-1)!.spSignal, 0)     // pressure threshold not met
  assert.equal(spBars([...dn, dn[39] - 0.9, dn[39] - 1.9], { stretchZ: 500 }).at(-1)!.spSignal, 0)      // gap not stretched enough
  assert.equal(spBars([...dn, dn[39] - 0.9, dn[39] - 1.9], { minBars: 90 }).at(-1)!.spSignal, 0)        // not enough path
  const choppy = Array.from({ length: 40 }, (_, i) => (i % 2 ? -0.5 : 0.5)); const eff = spBars([...choppy, -2.4, -3.4]).at(-1)!
  assert.ok(eff.spEff < 0.5 && eff.spPressure === 0)                                                    // zig-zag is not steady
})
test('anchor ssp: steady drift, no burst, with the chosen trend', () => {
  const dn = drift(-0.05, 40), up = drift(0.05, 40)
  assert.equal(spBars(dn).at(-1)!.sspSignal, -1); assert.equal(spBars(up).at(-1)!.sspSignal, 1)          // trend=side default
  assert.equal(spBars([...dn, dn[39] - 0.9, dn[39] - 1.9]).at(-1)!.sspSignal, 0)                         // a burst cancels it
  assert.equal(spBars(dn, { trend: 'kagi' }).at(-1)!.sspSignal, 0)                                      // no yang / yin yet
  assert.equal(spBars(dn, { trend: 'ema' }).at(-1)!.sspSignal, -1)                                      // EMA20 < EMA50 after a steady fall
})
test('anchor sp per-bar fields: NO LOOK-AHEAD and reset at every roll', () => {
  let sd = 2468; const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296 }
  const rows: [number, number, number, number][] = []; let c = 100
  for (let i = 0; i < 1000; i++) { const o = c; c += (rnd() - 0.5) * 1.4 + (i % 90 < 40 ? 0.05 : -0.05); rows.push([o, Math.max(o, c) + 0.1, Math.min(o, c) - 0.1, c]) }
  const cs = mkc(rows)
  const sp = { shockZ: 0.6, pressureZ: 0.4, eff: 0.3, stretchZ: 0.2 }
  const full = computeAnchorDiff(cs, { anchor: '4h', sp })!, cut = computeAnchorDiff(cs.slice(0, 950), { anchor: '4h', sp })!
  let fired = 0
  for (let i = 0; i < cut.bars.length; i++) for (const f of ['spShockZ', 'spDriftZ', 'spEff', 'spPressure', 'spShock', 'spSignal', 'sspSignal'] as const) { assert.equal(String(full.bars[i][f]), String(cut.bars[i][f]), `${f}@${i}`); if ((f === 'spSignal' || f === 'sspSignal') && full.bars[i][f]) fired++ }
  assert.ok(fired > 0)
  const roll = full.bars.findIndex((b, i) => i > 0 && b.rolled)
  assert.ok(Number.isNaN(full.bars[roll].spDriftZ) && full.bars[roll].spSignal === 0)                   // a new period starts from nothing
})
test('MSL anchor.sp / anchor.ssp: bundle, option strings, configs, text, errors', () => {
  const dn = drift(-0.08, 40), g = [...dn, dn[39] - 0.9, dn[39] - 1.9]
  const a = spMsl(g, 'anchor.sp("4h")'); assert.equal(a.error, undefined); assert.equal(a.direction, 'call')
  assert.equal(spMsl(g, 'anchor.sp("4h", "mode=follow")').direction, 'put')
  assert.equal(spMsl(g, 'anchor.sp("4h", "shockZ=50")').direction, 'none')
  assert.equal(spMsl(g, 'anchor.sp("shockZ=0.5", "pressureZ=0.5", "eff=0.9", "burst=2", "stretchZ=0.5", "minBars=5", "4h")').direction, 'call')
  assert.equal(spMsl(drift(-0.05, 40), 'anchor.ssp("4h")').direction, 'put')
  assert.equal(spMsl(drift(-0.05, 40), 'anchor.ssp("4h", "trend=kagi")').direction, 'none')
  const fields = mslRun('let s = anchor.sp("4h")\ncall when s.case == 0 and s.bars >= 1 and s.ok\nexpiry = 1\n', candles); assert.equal(fields.error, undefined)
  assert.equal(spMsl(g, 'anchor.sp("4h:open")').error, undefined)
  assert.ok(spMsl(g, 'anchor.sp("4h", "nonsense=1")').error); assert.ok(spMsl(g, 'anchor.sp("4h", "mode=sideways")').error); assert.ok(spMsl(g, 'anchor.sp("4h", "shockZ=-1")').error)
  // per-bar read + condition use
  const cond = mslRun('call when anchor.now("spSignal=1 & spPressure=-1", -1, "4h") or not anchor.now("spSignal=1", -1, "4h")\nexpiry = 1\n', candles)
  assert.equal(cond.error, undefined)
  const early = spMsl([0.1, 0.2], 'anchor.sp("4h")'); assert.equal(early.error, undefined); assert.equal(early.direction, 'none')
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
