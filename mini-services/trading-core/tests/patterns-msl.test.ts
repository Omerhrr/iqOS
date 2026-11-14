// IQAIR//OS - tests: mitigation / propulsion blocks, volume imbalance, Judas swing, turtle soup (smcx.* candle-derived primitives).
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { readBlocks, findPropulsion, readJudas, readSoup } from '../src/analytics/mslpatterns'
import { atr } from '../src/analytics/indicators'

const tests: [string, () => void][] = []
const test = (n: string, f: () => void) => tests.push([n, f])
const T0 = 1_700_000_000
function zig(points: [number, number][], pad = 0.0001, t0 = T0, step = 60): Candle[] {
  const out: Candle[] = []
  for (let p = 0; p < points.length - 1; p++) {
    const [i0, v0] = points[p]
    const [i1, v1] = points[p + 1]
    for (let i = i0; i < i1 || (p === points.length - 2 && i === i1); i++) {
      const c = v0 + ((v1 - v0) * (i - i0)) / (i1 - i0)
      const prev = out.length ? out[out.length - 1].close : c
      out.push({ time: t0 + out.length * step, open: prev, high: c + pad, low: c - pad, close: c, volume: 100 })
    }
  }
  return out
}
const mirror = (c: Candle[]): Candle[] => c.map((k) => ({ ...k, open: 2.2 - k.open, high: 2.2 - k.low, low: 2.2 - k.high, close: 2.2 - k.close }))
const fires = (c: Candle[], line: string, side: 'call' | 'put' = 'call') => {
  const res = backtestMslScript(c, `${side} when ${line}`, { expiryBars: 1, warmupBars: c.length - 3 })
  assert.equal(res.ok, true, (res as { error?: string }).error)
  return res.trades.length
}
/** quiet lead-in; each candle opens at the previous close so the feed itself has NO body gaps (no accidental volume imbalances) */
const lead = (n: number, v: number, t0: number, step = 60): Candle[] => {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const c = v + 0.0003 * Math.sin(i * 1.7)
    const o = i ? out[i - 1].close : c
    out.push({ time: t0 + i * step, open: o, high: Math.max(o, c) + 0.0002, low: Math.min(o, c) - 0.0002, close: c, volume: 100 })
  }
  return out
}

// ---- mitigation block ----
// lows: P 1.095 (bar 10), A 1.090 (26, a lower low), high H 1.097 (32), B 1.093 (40, FAILS to undercut A), then a close above H (~bar 43)
const mitBull = () => zig([[0, 1.1], [10, 1.095], [16, 1.099], [26, 1.09], [32, 1.097], [40, 1.093], [46, 1.0995], [66, 1.1]])
test('bullish mitigation block: lower low, failed lower low, break of the intervening high -> block = the last bearish candle', () => {
  const r = readBlocks(mitBull())!
  assert.ok(r.mitBull, 'found')
  assert.equal(r.mitBear, null)
  assert.ok(r.mitBull!.bottom < 1.0935 && r.mitBull!.top < 1.0945, JSON.stringify(r.mitBull))
})
test('bearish mitigation block is the mirror', () => {
  const r = readBlocks(mirror(mitBull()))!
  assert.ok(r.mitBear)
  assert.equal(r.mitBull, null)
})
test('a mitigation block dies when a later close goes below it', () => {
  const c = mitBull()
  c.push({ time: c[c.length - 1].time + 60, open: 1.1, high: 1.1, low: 1.09, close: 1.0905, volume: 1 })
  c.push({ time: c[c.length - 1].time + 60, open: 1.0905, high: 1.091, low: 1.09, close: 1.0903, volume: 1 })
  const r = readBlocks(c)!
  assert.equal(r.mitBull, null)
})
test('a second lower low (the low is NOT failed) is not a mitigation block', () => {
  const c = zig([[0, 1.1], [10, 1.095], [16, 1.099], [26, 1.09], [32, 1.097], [40, 1.087], [46, 1.0995], [66, 1.1]])
  assert.equal(readBlocks(c)!.mitBull, null)
})
test('smcx.mitBull() / mitBullIn / mitAgo in MSL (backtest)', () => {
  const c = mitBull()
  assert.ok(fires(c, 'smcx.mitBull()') > 0)
  assert.equal(fires(c, 'smcx.mitBear()', 'put'), 0)
  assert.ok(fires(c, 'smcx.mitAgo("bull") < 40') > 0)
  assert.ok(fires(c, 'smcx.mitAgo("bear") == 99') > 0)
})

// ---- propulsion block (zone-injected unit test + integration smoke) ----
test('propulsion block: a strong bullish candle tapping an unviolated bullish OB and closing above it', () => {
  const c = lead(40, 1.1, T0)
  const a = atr(c.map((k) => k.high), c.map((k) => k.low), c.map((k) => k.close), 14)
  const obs = [{ direction: 'bullish' as const, top: 1.1004, bottom: 1.0996, index: 20 }]
  const last = c[c.length - 1].time
  // strong bullish candle: opens 1.0999, low 1.0998 (inside the zone), closes 1.1015 (body ~0.0016 >> ATR ~0.0006)
  c.push({ time: last + 60, open: 1.0999, high: 1.1016, low: 1.0998, close: 1.1015, volume: 1 })
  const A = atr(c.map((k) => k.high), c.map((k) => k.low), c.map((k) => k.close), 14)
  const r = findPropulsion(c, A, obs, 'bull')
  assert.ok(r, 'found')
  assert.equal(r!.at, c.length - 1)
  assert.equal(r!.bottom, 1.0999)
  assert.equal(r!.top, 1.1015)
  assert.equal(findPropulsion(c, A, obs, 'bear'), null)
  assert.equal(findPropulsion(c, A, [{ ...obs[0], direction: 'bearish' }], 'bull'), null) // wrong-direction OB
  void a
})
test('propulsion: dropped once a later close is below the candle low', () => {
  const c = lead(40, 1.1, T0)
  const obs = [{ direction: 'bullish' as const, top: 1.1004, bottom: 1.0996, index: 20 }]
  const last = c[c.length - 1].time
  c.push({ time: last + 60, open: 1.0999, high: 1.1016, low: 1.0998, close: 1.1015, volume: 1 })
  c.push({ time: last + 120, open: 1.1015, high: 1.1015, low: 1.0990, close: 1.0992, volume: 1 })
  const A = atr(c.map((k) => k.high), c.map((k) => k.low), c.map((k) => k.close), 14)
  assert.equal(findPropulsion(c, A, obs, 'bull'), null)
})
test('smcx.propBull() runs live/backtest without error', () => {
  assert.equal(fires(mitBull(), 'smcx.propBull()') >= 0, true)
})

// ---- volume imbalance ----
const withVi = (): Candle[] => {
  const c = lead(70, 1.1, T0)
  const t = c[c.length - 1].time
  c.push({ time: t + 60, open: 1.1, high: 1.1006, low: 1.0998, close: 1.1004, volume: 1 }) // body 1.1000-1.1004
  c.push({ time: t + 120, open: 1.1008, high: 1.1016, low: 1.1004, close: 1.1014, volume: 1 }) // body 1.1008-1.1014, low <= prior high (wicks overlap)
  c.push({ time: t + 180, open: 1.1014, high: 1.1018, low: 1.1012, close: 1.1016, volume: 1 })
  return c
}
test('volume imbalance: bodies do not touch, wicks overlap -> bullish VI, zone = the gap between bodies', () => {
  const r = readBlocks(withVi())!
  assert.ok(r.viBull, 'found')
  assert.ok(Math.abs(r.viBull!.bottom - 1.1004) < 1e-9 && Math.abs(r.viBull!.top - 1.1008) < 1e-9)
  assert.ok(r.viBull!.sizeAtr > 0.05)
})
test('a filled volume imbalance is dropped; a gap whose wicks do not overlap is not a VI (that is an FVG)', () => {
  const c = withVi()
  c.push({ time: c[c.length - 1].time + 60, open: 1.1016, high: 1.1016, low: 1.1002, close: 1.1005, volume: 1 })
  assert.equal(readBlocks(c)!.viBull, null)
  const d = lead(70, 1.1, T0)
  const t = d[d.length - 1].time
  d.push({ time: t + 60, open: 1.1, high: 1.1004, low: 1.0998, close: 1.1002, volume: 1 })
  d.push({ time: t + 120, open: 1.1012, high: 1.102, low: 1.1008, close: 1.1018, volume: 1 }) // low 1.1008 > prior high 1.1004: wicks do not overlap
  assert.equal(readBlocks(d)!.viBull, null)
})
test('smcx.viBull / viSizeAtr / viAgo in MSL; bearish VI is the mirror', () => {
  assert.ok(fires(withVi(), 'smcx.viBull()') > 0)
  assert.ok(fires(withVi(), 'smcx.viSizeAtr("bull") > 0.2') > 0)
  assert.ok(fires(withVi(), 'smcx.viAgo("bull") <= 2') > 0)
  assert.equal(fires(withVi(), 'smcx.viBull(50)'), 0)
  const m = readBlocks(mirror(withVi()))!
  assert.ok(m.viBear && !m.viBull)
})
test('a feed whose candles always open at the prior close never shows a volume imbalance', () => {
  assert.equal(readBlocks(zig([[0, 1.09], [30, 1.1], [45, 1.094], [66, 1.099]]))!.viBull, null)
})

// ---- Judas swing ----
const DAY0 = Math.floor(T0 / 86400) * 86400 + 86400 * 3 // a day boundary
const judasSeries = (fakeDown = true, withReclaim = true): Candle[] => {
  const t07 = DAY0 + 7 * 3600
  const pre = lead(180, 1.1, t07 - 180 * 60) // 04:00-07:00 flat
  const c = [...pre]
  const O = 1.1
  const sgn = fakeDown ? -1 : 1
  for (let i = 0; i < 90; i++) {
    const t = t07 + i * 60
    const px = i === 0 ? O : i <= 20 ? O + sgn * 0.0007 * (i / 20) : withReclaim && i <= 50 ? O + sgn * 0.0007 * (1 - (i - 20) / 15) : O + sgn * (withReclaim ? -0.0006 : 0.0007)
    const prev = c[c.length - 1].close
    c.push({ time: t, open: i === 0 ? O : prev, high: Math.max(prev, px) + 0.0001, low: Math.min(prev, px) - 0.0001, close: px, volume: 1 })
  }
  return c
}
test('Judas swing (London): fake move down >= 0.75 ATR then a close back above the open -> bullish', () => {
  const j = readJudas(judasSeries(true, true), 1)!
  assert.equal(j.dir, 1)
  assert.ok(j.ago < 99)
})
test('Judas swing: fake move UP then back below the open -> bearish', () => {
  assert.equal(readJudas(judasSeries(false, true), 1)!.dir, -1)
})
test('Judas swing: a fake move that is never reclaimed is not a Judas swing; other sessions read none', () => {
  assert.equal(readJudas(judasSeries(true, false), 1)!.dir, 0)
  assert.equal(readJudas(judasSeries(true, true), 2)!.dir, 0)
})
test('smcx.judasBull in MSL (needs timestamps) and rejects a bad session', () => {
  const c = judasSeries(true, true)
  assert.ok(fires(c, 'smcx.judasBull(1, 200)') > 0)
  assert.equal(fires(c, 'smcx.judasBear(1, 200)', 'put'), 0)
  assert.ok(fires(c, 'smcx.judasAgo(1) < 200') > 0)
  assert.equal(fires(c, 'smcx.judasBull(7)'), 0)
})

// ---- turtle soup ----
const soupSeries = (): Candle[] => {
  const c = lead(60, 1.1, T0)
  c[45] = { ...c[45], low: 1.098 } // the prior 20-bar low: 15 bars back, the lowest of the window
  const t = c[c.length - 1].time
  c.push({ time: t + 60, open: 1.0999, high: 1.1003, low: 1.0975, close: 1.0999, volume: 1 }) // undercuts the prior low and closes back above it
  return c
}
test('turtle soup: undercut the 20-bar low (extreme >= 4 bars old) and close back above -> bullish soup', () => {
  assert.equal(readSoup(soupSeries(), 'bull', 20), 0)
  assert.notEqual(readSoup(soupSeries(), 'bear', 20), 0) // the spike is a LOW undercut, never a bearish soup
})
test('turtle soup: a real breakdown (close stays below) is not soup', () => {
  const c = soupSeries()
  c[c.length - 1] = { ...c[c.length - 1], close: 1.0978 }
  assert.notEqual(readSoup(c, 'bull', 20), 0)
})
test('smcx.soupBull / soupAgo in MSL; bearish soup is the mirror', () => {
  const c = soupSeries()
  // the backtester evaluates up to the second-to-last bar, so add one quiet bar so the spike is itself an evaluated bar
  const t = c[c.length - 1].time
  const c2 = [...c, { time: t + 60, open: 1.0999, high: 1.1002, low: 1.0997, close: 1.1, volume: 1 }]
  assert.ok(fires(c2, 'smcx.soupBull(20, 3)') > 0)
  assert.ok(fires(c2, 'smcx.soupAgo("bull") == 0') > 0)
  assert.equal(fires(c2, 'smcx.soupBull(20, 1)'), 1) // k = 1: only the spike bar itself (ago 0)
  assert.equal(readSoup(mirror(c), 'bear', 20), 0)
})

let fail = 0
for (const [n, f] of tests) { try { f(); console.log('ok  ' + n) } catch (e) { fail++; console.log('FAIL ' + n + '\n    ' + (e as Error).message.slice(0, 600)) } }
console.log(fail ? fail + ' FAILED' : 'all ' + tests.length + ' passed')
process.exit(fail ? 1 : 0)
