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
  const chk = (expr: string, v: number) => { const e = run(`call when ${expr} > ${(v - 1e-7).toFixed(9)} and ${expr} < ${(v + 1e-7).toFixed(9)}\nexpiry = 1\n`); assert.equal(e.error, undefined, expr); assert.equal(e.direction, 'call', `${expr} should equal ${v}`) }
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
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
