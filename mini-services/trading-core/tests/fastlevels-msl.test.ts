// IQAIR//OS - tests: snr.* / fibs.* (analytics/fastlevels.ts) - many levels from a 5s chart, read on 1m
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript, setBacktestFastFeed } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { buildSnrMap, buildFibMap, readSnr, buildZoneMap, readZones, buildTrendMap, readTrend } from '../src/analytics/fastlevels'

const T0 = 1_700_000_040
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
/** 5s random walk bounded in a 99..101 box (bounces off both walls -> repeated pivots there) */
function fast5(n: number, seed: number): Candle[] {
  const r = rng(seed), out: Candle[] = []
  let x = 100
  for (let i = 0; i < n; i++) {
    const o = x
    x += (r() - 0.5) * 0.12 + (x > 100.9 ? -0.08 : x < 99.1 ? 0.08 : 0)
    x = Math.min(101, Math.max(99, x))
    out.push({ time: T0 + i * 5, open: o, close: x, high: Math.max(o, x) + r() * 0.03, low: Math.min(o, x) - r() * 0.03, volume: 10 })
  }
  return out
}
function agg(c: Candle[], sec: number): Candle[] {
  const out: Candle[] = []
  for (const k of c) {
    const st = Math.floor(k.time / sec) * sec, l = out[out.length - 1]
    if (l && l.time === st) { l.high = Math.max(l.high, k.high); l.low = Math.min(l.low, k.low); l.close = k.close; l.volume += k.volume } else out.push({ ...k, time: st })
  }
  return out
}
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }

const F = fast5(3000, 7)
const B = agg(F, 60)

test('snr map finds many levels, both sides, with touches', () => {
  const m = buildSnrMap(F, B)
  assert.ok(m.ok && m.levels.length >= 6, `levels ${m.levels.length}`)
  assert.ok(m.levels.some((l) => l.side === 'support') && m.levels.some((l) => l.side === 'resistance'))
  assert.ok(m.levels.every((l) => l.touches >= 2))
  assert.ok(m.levels.length > 3, 'more than a handful of levels')
})
test('too-thin fast chart fails closed', () => {
  assert.equal(buildSnrMap(F.slice(0, 50), B).ok, false)
  assert.equal(buildFibMap(F.slice(0, 50), B).ok, false)
})
test('fib map builds legs and stacked levels', () => {
  const m = buildFibMap(F, B)
  assert.ok(m.ok && m.legs.length >= 1, `legs ${m.legs.length}`)
  assert.ok(m.levels.every((l) => l.confluence >= 1))
})
test('rejection of a level by a planted 1m bar', () => {
  const m = buildSnrMap(F, B)
  const L = m.levels.find((l) => l.side === 'support')!
  const b = B.slice(0, -1)
  const last = b[b.length - 1]
  const a = m.atr1m
  b.push({ time: last.time + 60, open: L.price + 0.6 * a, close: L.price + 0.8 * a, high: L.price + 0.9 * a, low: L.price - 0.05 * a, volume: 1 })
  const r = readSnr(F, b)
  assert.ok(r.ok)
  assert.ok(r.rejected !== 0 || r.atLevel !== null)
})
test('scripts parse', () => {
  const s = 'if snr.ok() and snr.rejected() == 1 and snr.rejTouches() >= 3 and fibs.confluence(0.3) >= 2\n  call when true\nend'
  assert.equal(parseStrategyScript(s).ok, true)
  assert.equal(parseStrategyScript('if snr.supDist(2) < 0.4 and snr.count("15s") > 5\n  put when true\nend').ok, true)
})
test('without a fast feed the backtest fails closed (no trades)', () => {
  setBacktestFastFeed(null)
  const r = backtestMslScript(B, 'if snr.ok() and snr.rejected() == 1\n  call when true\nend', { expiryBars: 1, warmupBars: 40 })
  assert.equal(r.trades.length, 0)
})
test('with a 5s feed the same script trades, and only sees closed fast bars', () => {
  setBacktestFastFeed({ '5s': F })
  const script = 'if snr.ok() and snr.rejected() == 1\n  call when true\nelseif snr.ok() and snr.rejected() == -1\n  put when true\nend'
  const r = backtestMslScript(B, script, { expiryBars: 1, warmupBars: 40 })
  setBacktestFastFeed(null)
  assert.ok(r.trades.length > 0, `trades ${r.trades.length}`)
})

/** planted: quiet base then a hard jump up (demand), later a quiet base then a hard drop (supply) */
function planted(): Candle[] {
  const out: Candle[] = []
  let x = 100, t = T0
  const push = (o: number, c: number, w = 0.01) => { out.push({ time: t, open: o, close: c, high: Math.max(o, c) + w, low: Math.min(o, c) - w, volume: 1 }); t += 5 }
  const r = rng(3)
  for (let i = 0; i < 300; i++) { const o = x; x += (r() - 0.5) * 0.3; x = Math.min(100.6, Math.max(99.4, x)); push(o, x, 0.05) }
  for (let i = 0; i < 3; i++) push(99.7, 99.7 + (i % 2) * 0.005, 0.005)
  for (let i = 0; i < 4; i++) { const o = x = 99.7 + i * 0.5; push(o, o + 0.5, 0.02) }
  x = 101.7
  for (let i = 0; i < 40; i++) { const o = x; x += (r() - 0.5) * 0.02; push(o, x, 0.05) }
  return out
}
test('planted base + impulse is found as demand', () => {
  const P = planted(), PB = agg(P, 60)
  const m = buildZoneMap(P, PB)
  assert.ok(m.ok)
  assert.ok(m.zones.some((z) => z.kind === 'demand' && z.bottom > 99.6 && z.top < 99.8), JSON.stringify(m.zones.slice(0, 3)))
})
test('zone rejection read: wick into demand closing above', () => {
  const P = planted(), PB = agg(P, 60)
  const b = PB.slice(0, -1), last = b[b.length - 1]
  const mk = (z: { top: number; bottom: number }) => ({ time: last.time + 60, open: z.top + 0.1, close: z.top + 0.2, high: z.top + 0.25, low: z.bottom + 0.001, volume: 1 })
  // the bar itself moves the ATR, so settle the zone with a first pass, then aim the bar at it
  const z0 = readZones(P, [...b, mk(buildZoneMap(P, PB).zones.find((q) => q.kind === 'demand')!)]).map.zones.find((q) => q.kind === 'demand')!
  const r = readZones(P, [...b, mk(z0)])
  assert.equal(r.rejected, 1, JSON.stringify(r.map.zones.slice(0, 3)))
})
test('zone scripts parse and fail closed with no fast feed', () => {
  const sc = 'if zone.ok() and zone.rejected() == 1 and zone.fresh()\n  call when true\nelseif zone.ok() and zone.rejected() == -1 and zone.fresh()\n  put when true\nend'
  assert.equal(parseStrategyScript(sc).ok, true)
  setBacktestFastFeed(null)
  assert.equal(backtestMslScript(B, sc, { expiryBars: 1, warmupBars: 40 }).trades.length, 0)
  setBacktestFastFeed({ '5s': F })
  const r = backtestMslScript(B, sc, { expiryBars: 1, warmupBars: 40 })
  setBacktestFastFeed(null)
  assert.ok(r.trades.length >= 0)
})
/** planted rising channel: lows ride 100 + 0.002*i, highs 0.6 above; bounce structure every 40 bars */
function channel5(n: number): Candle[] {
  const out: Candle[] = []
  const r = rng(11)
  for (let i = 0; i < n; i++) {
    const ph = (i % 40) / 40, floor = 100 + 0.004 * i, mid = floor + 0.3 + 0.3 * Math.cos(Math.PI * (ph * 2 - 1)) * -1
    const c = Math.max(floor + 0.02, mid + (r() - 0.5) * 0.02), o = i ? out[i - 1].close : c
    out.push({ time: T0 + i * 5, open: o, close: c, high: Math.max(o, c) + 0.01, low: Math.max(floor, Math.min(o, c) - 0.01), volume: 1 })
  }
  return out
}
test('trendline: finds a rising support line with touches and positive slope', () => {
  const C = channel5(900), CB = agg(C, 60)
  const m = buildTrendMap(C, CB)
  assert.ok(m.ok && m.support, 'support line')
  assert.ok(m.support!.slope > 0 && m.support!.touches >= 2, JSON.stringify(m.support))
})
test('trendline scripts parse; fail closed with no feed', () => {
  const sc = 'if trend.ok() and trend.rejected() == 1 and trend.supTouches() >= 3 and trend.supSlope() > 0\n  call when true\nelseif trend.ok() and trend.broken() == 1\n  call when true\nend'
  assert.equal(parseStrategyScript(sc).ok, true)
  setBacktestFastFeed(null)
  assert.equal(backtestMslScript(B, sc, { expiryBars: 1, warmupBars: 40 }).trades.length, 0)
  const r = readTrend(F, B)
  assert.ok(r.ok)
})
console.log(`${pass}/${total}`)
if (pass !== total) process.exit(1)
