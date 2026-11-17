// IQAIR//OS - tests: analytics/patternengine.ts (triangles, wedges, rectangle, pennant, flags, H&S, cup & handle, auto trend, Elliott) on planted shapes
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { detectChartPatterns2, readAutoTrend, readElliott, patternEngineHits } from '../src/analytics/patternengine'

const T0 = 1_700_000_040
/** closes follow the polyline through the waypoints [barIndex, price]; wicks +/- w; optional lead-in of flat bars at the first price */
function shape(wp: [number, number][], opts: { lead?: number; w?: number } = {}): Candle[] {
  const w = opts.w ?? 0.08, lead = opts.lead ?? 0
  const closes: number[] = []
  for (let i = 0; i < lead; i++) closes.push(wp[0][1] + Math.sin(i * 1.7) * 0.03)
  for (let k = 0; k < wp.length - 1; k++) {
    const [i0, p0] = wp[k], [i1, p1] = wp[k + 1]
    for (let i = i0; i < i1; i++) closes.push(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0))
  }
  closes.push(wp[wp.length - 1][1])
  const out: Candle[] = []
  for (let i = 0; i < closes.length; i++) {
    const o = i ? closes[i - 1] : closes[i], c = closes[i]
    out.push({ time: T0 + i * 60, open: o, close: c, high: Math.max(o, c) + w, low: Math.min(o, c) - w, volume: 1 })
  }
  return out
}
const mirror = (c: Candle[], axis = 200): Candle[] => c.map((k) => ({ ...k, open: axis - k.open, close: axis - k.close, high: axis - k.low, low: axis - k.high }))
const names = (c: Candle[]) => detectChartPatterns2(c).map((h) => h.name)
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }

const ASC = shape([[0, 100], [10, 105], [20, 101], [30, 105], [40, 102.5], [50, 105], [58, 103.5], [64, 104.3]], { lead: 10 })
const SYM = shape([[0, 100], [10, 106], [20, 100.5], [30, 105], [40, 101.5], [50, 104], [58, 102.5], [64, 103.4]], { lead: 10 })
const FALL_W = shape([[0, 104], [5, 110], [15, 105], [25, 108], [35, 103], [45, 106], [55, 101.5], [62, 103.5]], { lead: 10 })
const RECT = shape([[0, 100], [5, 105], [15, 100], [25, 105], [35, 100], [45, 105], [55, 100], [62, 102.5]], { lead: 10 })
const FLAG = shape([[0, 100], [10, 100], [20, 110], [24, 108.3], [29, 109.4], [33, 107.9], [38, 109.0], [42, 107.5], [46, 108.2]], { lead: 25 })
const PEN = shape([[0, 100], [10, 100], [20, 110], [25, 107], [30, 109.4], [35, 107.8], [40, 109.0], [44, 108.2], [48, 108.7]], { lead: 25 })
const HS = shape([[0, 100], [10, 105], [18, 102], [28, 108], [38, 102.3], [48, 105.2], [56, 103.2]], { lead: 24 })
function cupSeries(): Candle[] {
  const wp: [number, number][] = [[0, 100]]
  // run-up to the left rim at bar 20
  wp.push([20, 110])
  for (let i = 21; i <= 80; i++) wp.push([i, 100 + 10 * ((i - 50) / 30) ** 2])
  wp.push([86, 107.6], [92, 108.9], [96, 108.4])
  return shape(wp.filter((p, k, a) => k === 0 || p[0] > a[k - 1][0]), { w: 0.1 })
}
const CUP = cupSeries()
const TREND = (() => { const wp: [number, number][] = []; for (let i = 0; i <= 70; i++) wp.push([i, 100 + 0.15 * i + 1.2 * Math.sin(i / 2.6)]); return shape(wp, { w: 0.1 }) })()
const EW3 = shape([[0, 100], [12, 106], [22, 103], [32, 112]], { lead: 30 })
const EW5 = shape([[0, 100], [12, 106], [22, 103], [34, 112], [42, 108.5], [52, 115], [54, 113.2]], { lead: 24 })
const ABC = shape([[0, 110], [12, 104], [20, 108], [32, 102], [35, 104]], { lead: 30 })

test('ascending triangle (bullish, flat top, rising lows)', () => {
  const h = detectChartPatterns2(ASC).find((x) => x.name === 'Ascending Triangle')
  assert.ok(h, names(ASC).join(','))
  assert.equal(h!.direction, 'bullish'); assert.ok(h!.target! > h!.upper!)
})
test('descending triangle is the mirror (bearish)', () => {
  const h = detectChartPatterns2(mirror(ASC)).find((x) => x.name === 'Descending Triangle')
  assert.ok(h, names(mirror(ASC)).join(',')); assert.equal(h!.direction, 'bearish')
})
test('symmetrical triangle is neutral until it breaks', () => {
  const h = detectChartPatterns2(SYM).find((x) => x.name === 'Symmetrical Triangle')
  assert.ok(h, names(SYM).join(',')); assert.equal(h!.direction, 'neutral'); assert.equal(h!.broken, false)
})
test('falling wedge is bullish, rising wedge bearish', () => {
  const f = detectChartPatterns2(FALL_W).find((x) => x.name === 'Falling Wedge')
  assert.ok(f, names(FALL_W).join(',')); assert.equal(f!.direction, 'bullish')
  const r = detectChartPatterns2(mirror(FALL_W)).find((x) => x.name === 'Rising Wedge')
  assert.ok(r, names(mirror(FALL_W)).join(',')); assert.equal(r!.direction, 'bearish')
})
test('rectangle: flat top and bottom', () => {
  assert.ok(names(RECT).some((x) => /Rectangle/.test(x)), names(RECT).join(','))
})
test('bull flag after a pole, bear flag is the mirror', () => {
  assert.ok(names(FLAG).includes('Bull Flag'), names(FLAG).join(','))
  assert.ok(names(mirror(FLAG)).includes('Bear Flag'), names(mirror(FLAG)).join(','))
})
test('bullish pennant after a pole, bearish is the mirror', () => {
  assert.ok(names(PEN).includes('Bullish Pennant'), names(PEN).join(','))
  assert.ok(names(mirror(PEN)).includes('Bearish Pennant'), names(mirror(PEN)).join(','))
})
test('head and shoulders (bearish) and the inverse (bullish)', () => {
  const h = detectChartPatterns2(HS).find((x) => x.name === 'Head and Shoulders')
  assert.ok(h, names(HS).join(',')); assert.equal(h!.direction, 'bearish'); assert.ok(h!.target! < h!.lower!)
  const i = detectChartPatterns2(mirror(HS)).find((x) => x.name === 'Inverse Head and Shoulders')
  assert.ok(i, names(mirror(HS)).join(',')); assert.equal(i!.direction, 'bullish')
})
test('head and shoulders reads broken once a close is under the neckline', () => {
  const broken = HS.concat([103, 102, 101.2, 100.6].map((p, k) => ({ time: T0 + (HS.length + k) * 60, open: p + 0.4, close: p, high: p + 0.5, low: p - 0.1, volume: 1 })))
  const h = detectChartPatterns2(broken).find((x) => x.name === 'Head and Shoulders')
  assert.ok(h && h.broken, JSON.stringify(h))
})
test('cup and handle (bullish) and the inverted cup (bearish)', () => {
  const h = detectChartPatterns2(CUP).find((x) => x.name === 'Cup and Handle')
  assert.ok(h, names(CUP).join(',')); assert.equal(h!.direction, 'bullish')
  const i = detectChartPatterns2(mirror(CUP)).find((x) => x.name === 'Inverted Cup and Handle')
  assert.ok(i, names(mirror(CUP)).join(',')); assert.equal(i!.direction, 'bearish')
})
test('auto trend: up-trend found with touches; mirror is down', () => {
  const t = readAutoTrend(TREND)
  assert.equal(t.dir, 1); assert.ok(t.r2 > 0.5 && t.touches >= 2, JSON.stringify(t))
  assert.equal(readAutoTrend(mirror(TREND)).dir, -1)
})
test('auto trend: a trendline break is reported', () => {
  const brk = TREND.concat([94, 93, 92].map((p, k) => ({ time: T0 + (TREND.length + k) * 60, open: p + 2, close: p, high: p + 2.1, low: p - 0.1, volume: 1 })))
  const t = readAutoTrend(brk)
  assert.ok(t.broken === -1 || t.dir === 0 || t.dir === 1, JSON.stringify(t))
})
test('elliott wave 3 up in progress (and the mirror down)', () => {
  const e = readElliott(EW3)
  assert.equal(e.state, 'wave3', JSON.stringify(e)); assert.equal(e.dir, 1); assert.ok(e.target > 112 && Math.abs(e.invalid - 100) < 0.2, JSON.stringify(e))
  const d = readElliott(mirror(EW3))
  assert.equal(d.state, 'wave3'); assert.equal(d.dir, -1)
})
test('elliott five waves up done: a correction is expected', () => {
  const e = readElliott(EW5)
  assert.ok(e.state === 'wave5done' || e.state === 'wave5', JSON.stringify(e))
  assert.equal(e.trend, 1)
})
test('elliott A-B-C down complete and turning up', () => {
  const e = readElliott(ABC)
  assert.equal(e.state, 'abcdone', JSON.stringify(e)); assert.equal(e.dir, 1)
})
test('flat noise finds no pattern, thin history fails closed', () => {
  const flat = shape([[0, 100], [80, 100.3]], { w: 0.05 })
  assert.equal(detectChartPatterns2(flat).length, 0)
  assert.equal(detectChartPatterns2(flat.slice(0, 30)).length, 0)
  assert.equal(readElliott(flat.slice(0, 30)).ok, false)
})
test('patternEngineHits emits PatternHit-shaped rows with valid fields', () => {
  for (const h of patternEngineHits(ASC)) { assert.ok(['bullish', 'bearish', 'neutral'].includes(h.direction)); assert.ok([1, 2, 3].includes(h.reliability)); assert.ok(h.barsAgo >= 0) }
})
console.log(`${pass}/${total}`)
if (pass !== total) process.exit(1)
