// Task 63 selftest - chart-type engines (rangebars / volumebars / footprint /
// tpo / tickbars / ivhv). Pure-math property checks, no kernel needed.
// Run: bun scripts/chart_types_selftest.ts  (cwd: mini-services/trading-core
// is NOT required - the engines are pure).

import { rangeBars } from '../mini-services/trading-core/src/analytics/rangebars'
import { volumeBars } from '../mini-services/trading-core/src/analytics/volumebars'
import { computeFootprint } from '../mini-services/trading-core/src/analytics/footprint'
import { computeTpo } from '../mini-services/trading-core/src/analytics/tpo'
import { tickBars, type TickPoint } from '../mini-services/trading-core/src/analytics/tickbars'
import { hvSeries, ivFromPayout, realizedUpProb } from '../mini-services/trading-core/src/analytics/ivhv'
import type { Candle } from '../mini-services/trading-core/src/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`)
  }
}
const EPS = 1e-9
const closeTo = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

// ---------- tape builders ----------
function walk(seed: number, n: number, tfSec = 60, vol = 1000, t0 = 1700000000): Candle[] {
  // deterministic pseudo-random walk (mulberry32)
  let s = seed >>> 0
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out: Candle[] = []
  let price = 1.1
  for (let i = 0; i < n; i++) {
    const open = price
    const drift = (rnd() - 0.5) * 0.0012
    const close = Math.max(0.01, open * (1 + drift))
    const hi = Math.max(open, close) * (1 + rnd() * 0.0004)
    const lo = Math.min(open, close) * (1 - rnd() * 0.0004)
    out.push({ time: t0 + i * tfSec, open, high: hi, low: lo, close, volume: Math.round(vol * (0.5 + rnd())) })
    price = close
  }
  return out
}
const upTape: Candle[] = []
for (let i = 0; i < 120; i++) {
  const o = 1 + i * 0.0005
  upTape.push({ time: 1700000000 + i * 60, open: o, high: o + 0.0006, low: o - 0.0001, close: o + 0.0004, volume: 500 })
}

// ============ 1. range bars ============
console.log('\n[rangebars]')
{
  const tape = walk(42, 300)
  const r = rangeBars(tape, { range: 0.0004 })
  check('paints bars from a 300-candle tape', r.bars.length > 20, `bars=${r.bars.length}`)
  check('every bar spans exactly `range`', r.bars.every((b) => closeTo(Math.abs(b.close - b.open), 0.0004, EPS)))
  check('rangeRule says explicit', r.rangeRule.startsWith('explicit'))
  check('up tape -> net up trend', rangeBars(upTape, { range: 0.0003 }).trend === 'up')
  const rUp = rangeBars(upTape, { range: 0.0003 })
  check('up tape -> no down bars', rUp.bars.every((b) => b.dir === 1), `dirs=${[...new Set(rUp.bars.map((b) => b.dir))]}`)
  check('times strictly ascending', r.bars.every((b, i) => i === 0 || b.time > r.bars[i - 1].time))
  check('ATR sizing works', rangeBars(tape, {}).range > 0 && rangeBars(tape, {}).rangeRule.includes('ATR'))
  // continuation + reversal mix: sawtooth tape must produce both dirs
  const saw: Candle[] = []
  for (let i = 0; i < 200; i++) {
    const base = 1 + (i % 20) * 0.0001
    const dirUp = Math.floor(i / 20) % 2 === 0
    saw.push({ time: 1700000000 + i * 60, open: base, high: base + (dirUp ? 0.0006 : 0.0001), low: base - (dirUp ? 0.0001 : 0.0006), close: base + (dirUp ? 0.0005 : -0.0005), volume: 100 })
  }
  const rSaw = rangeBars(saw, { range: 0.0004 })
  check('sawtooth tape flips direction', rSaw.flips > 0 && rSaw.bars.some((b) => b.dir === -1) && rSaw.bars.some((b) => b.dir === 1), `flips=${rSaw.flips}`)
  check('streak <= bars length', rSaw.streak <= rSaw.bars.length)
}

// ============ 2. volume bars ============
console.log('\n[volumebars]')
{
  const tape = walk(7, 200)
  const total = tape.reduce((s, c) => s + c.volume, 0)
  const per = 3000
  const r = volumeBars(tape, { per })
  check('paints bars', r.bars.length > 10, `bars=${r.bars.length}`)
  check('every CLOSED bar reaches `per`', r.bars.slice(0, -1).every((b) => b.volume >= per))
  check('volume conservation: sum(bars) == sum(candles)', closeTo(r.bars.reduce((s, b) => s + b.volume, 0), total, 1e-6), `${r.bars.reduce((s, b) => s + b.volume, 0)} vs ${total}`)
  check('open == first contributing candle open (spot check)', (() => {
    const firstT = r.bars[0].time
    const c0 = tape.find((c) => c.time === firstT)!
    return closeTo(r.bars[0].open, c0.open, EPS)
  })())
  check('times strictly ascending', r.bars.every((b, i) => i === 0 || b.time > r.bars[i - 1].time))
  check('endTime >= time within each bar', r.bars.every((b) => b.endTime >= b.time))
  check('volumeSource feed', r.volumeSource === 'feed')
  const zero = tape.map((c) => ({ ...c, volume: 0 }))
  const rz = volumeBars(zero)
  check('all-zero volume -> degenerate, honest', rz.degenerate && rz.bars.length === 0 && rz.volumeSource === 'none')
  const auto = volumeBars(tape)
  check('auto per yields a sane bar count (window/80 target)', auto.bars.length >= 40 && auto.bars.length <= 160, `bars=${auto.bars.length}`)
}

// ============ 3. footprint ============
console.log('\n[footprint]')
{
  const tape = walk(99, 80)
  const fp = computeFootprint(tape, { binsPerCandle: 6 })
  check('one cluster per candle', fp.candles.length === 80)
  check('volume conservation per candle', fp.candles.every((fc) => closeTo(fc.volume, fc.rows.reduce((s, r) => s + r.buyVolume + r.sellVolume, 0), 1e-6)))
  check('rows volume == candle volume', fp.candles.every((fc, i) => closeTo(fc.volume, tape[i].volume, 1e-6)))
  check('delta = buy - sell everywhere', fp.candles.every((fc) => closeTo(fc.delta, fc.buyVolume - fc.sellVolume, 1e-6) && fc.rows.every((r) => closeTo(r.delta, r.buyVolume - r.sellVolume, 1e-6))))
  check('rows sit inside the candle range', fp.candles.every((fc) => fc.rows.every((r) => r.priceLow >= fc.low - 1e-12 && r.priceHigh <= fc.high + 1e-12)))
  check('poc never null on a volume tape', fp.candles.every((fc) => fc.poc !== null))
  const imb = computeFootprint(tape, { binsPerCandle: 4, imbalanceRatio: 3 })
  check('imbalance flags consistent', imb.candles.every((fc) => fc.rows.every((r) => r.imbalance === null || (r.imbalance === 'buy' ? r.buyVolume >= 3 * r.sellVolume : r.sellVolume >= 3 * r.buyVolume))))
  const flat = computeFootprint([{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 500 }], {})
  check('zero-range candle -> single 50/50 row', flat.candles[0].rows.length === 1 && closeTo(flat.candles[0].rows[0].buyVolume, 250, 1e-9))
  check('binsPerCandle clamped (2..24)', computeFootprint(tape, { binsPerCandle: 99 }).binsPerCandle === 24)
}

// ============ 4. TPO ============
console.log('\n[tpo]')
{
  const tape = walk(3, 240, 60, 1000, 1699999200) // bracket-aligned 4h of 1m -> 8 x 30min periods
  const t = computeTpo(tape, { periodSec: 1800, binCount: 50 })
  check('8 periods from 4h window', t.periods.length === 8, `got ${t.periods.length}`)
  check('totalTpos >= periods (each touches >=1 bin)', t.totalTpos >= t.periods.length)
  check('value area >= 70%', t.valueAreaHigh !== null && t.bins.filter((b) => b.inValueArea).reduce((s, b) => s + b.tpos, 0) >= t.totalTpos * 0.7 - EPS)
  check('POC is the max bin', (() => {
    const poc = t.bins.find((b) => b.mid === t.poc)!
    return t.bins.every((b) => b.tpos <= poc.tpos)
  })())
  check('VA bounds inside window', t.valueAreaHigh! <= t.bins[t.bins.length - 1].priceHigh + 1e-12 && t.valueAreaLow! >= t.bins[0].priceLow - 1e-12)
  check('letters cycle A,B,C...', t.periods[0].letter === 'A' && t.periods[1].letter === 'B' && t.periods[2].letter === 'C')
  check('IB = first period range', closeTo(t.ibHigh! - t.ibLow!, t.periods[0].high - t.periods[0].low, EPS))
  const t1h = computeTpo(tape, { periodSec: 300 }) // requested 5m < tf 1m? no: tf 60s < 300s -> fixed 300s brackets
  check('coarser-than-requested tf still builds', t1h.periods.length > 0 && t1h.periodRule.includes('fixed'))
  const coarse = computeTpo(walk(5, 50, 3600), { periodSec: 1800 })
  check('tf >= requested -> per-candle periods', coarse.periodRule.includes('per-candle') && coarse.periods.length === 50)
  const single = computeTpo([{ time: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 }], {})
  check('single-price window -> one bin, honest VA', single.bins.length === 1 && single.totalTpos === 1)
}

// ============ 5. tick bars ============
console.log('\n[tickbars]')
{
  const pts: TickPoint[] = Array.from({ length: 253 }, (_, i) => ({ time: 1700000000 + i * 0.1, price: 1.1 + Math.sin(i / 5) * 0.0008 }))
  const r = tickBars(pts, { per: 10 })
  check('253 ticks @ per 10 -> 26 bars (25 full + partial)', r.bars.length === 26, `bars=${r.bars.length}`)
  check('complete bars carry exactly `per` ticks', r.bars.slice(0, -1).every((b) => b.ticks === 10))
  check('last partial carries the remainder', r.bars[r.bars.length - 1].ticks === 3)
  check('tick conservation', r.bars.reduce((s, b) => s + b.ticks, 0) === 253)
  check('OHLC matches brute force (bar 0)', (() => {
    const seg = pts.slice(0, 10)
    const b = r.bars[0]
    return closeTo(b.open, seg[0].price, EPS) && closeTo(b.close, seg[9].price, EPS) && closeTo(b.high, Math.max(...seg.map((p) => p.price)), EPS) && closeTo(b.low, Math.min(...seg.map((p) => p.price)), EPS)
  })())
  check('dataSource passthrough', tickBars(pts, { dataSource: 'tick' }).dataSource === 'tick')
  check('per clamped to >= 2', tickBars(pts, { per: 1 }).per === 2)
}

// ============ 6. IV vs HV ============
console.log('\n[ivhv]')
{
  const be85 = ivFromPayout(0.85)
  check('payout 0.85 -> breakeven 54.054%', closeTo(be85.breakevenPct, 100 / 1.85, 1e-9))
  const be70 = ivFromPayout(0.7)
  check('payout 0.70 -> breakeven 58.824%', closeTo(be70.breakevenPct, 100 / 1.7, 1e-9))
  check('payout up -> breakeven down (monotone)', ivFromPayout(0.9).breakevenPct < ivFromPayout(0.85).breakevenPct && ivFromPayout(0.85).breakevenPct < ivFromPayout(0.6).breakevenPct)
  check('rule discloses proxy status', be85.rule.includes('PROXY'))

  const flat: Candle[] = Array.from({ length: 60 }, (_, i) => ({ time: 1700000000 + i * 60, open: 1.1, high: 1.1, low: 1.1, close: 1.1, volume: 100 }))
  const hvFlat = hvSeries(flat, { window: 20 })
  check('flat tape -> hv 0 where window fills', Number.isFinite(hvFlat.hvNow) && closeTo(hvFlat.hvNow, 0, 1e-12))

  const tape = walk(11, 120)
  const hv = hvSeries(tape, { window: 20 })
  check('moving tape -> hv > 0', hv.hvNow > 0)
  check('series length == candles - 1', hv.series.length === 119)
  check('annualization discloses 365d convention', hv.annualization.includes('365d'))
  check('window clamp (>=2)', hvSeries(tape, { window: 1 }).window === 2)
  // higher realized vol -> higher hvNow: 3x amplitude tape
  const wild = tape.map((c, i) => {
    const scale = 3
    const prev = i ? tape[i - 1].close : c.open
    const c2 = prev * Math.exp((Math.log(c.close / prev)) * scale)
    return { ...c, close: c2, open: c.open, high: Math.max(c2, c.open) * 1.0001, low: Math.min(c2, c.open) * 0.9999 }
  })
  check('amplified tape -> higher hvNow', hvSeries(wild, { window: 20 }).hvNow > hv.hvNow * 2, `wild=${hvSeries(wild, { window: 20 }).hvNow.toFixed(2)} vs ${hv.hvNow.toFixed(2)}`)
  const allUp: Candle[] = Array.from({ length: 30 }, (_, i) => ({ time: 1700000000 + i * 60, open: 1, high: 1.002, low: 0.999, close: 1.001, volume: 1 }))
  check('realizedUpProb all-up -> 100%', closeTo(realizedUpProb(allUp, 30), 100, 1e-9))
}

console.log(`\n=== chart_types_selftest: ${pass} ok, ${fail} FAIL ===`)
process.exit(fail ? 1 : 0)
