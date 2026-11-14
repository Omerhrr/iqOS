import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { dayLevels } from '../src/analytics/daylevels'

const STEP = 300
const start = Date.UTC(2026, 10, 2) / 1000 // Mon 2026-11-02 00:00 UTC
const DAY = 86400
/** 5m candles from `start` to `endT`, price = 1.10 + 0.002*sin; per-day spikes injected by `spikes` (time -> [high, low]) */
function build(endT: number, spikes: Record<number, [number, number]> = {}): Candle[] {
  const out: Candle[] = []
  for (let t = start; t <= endT; t += STEP) {
    const c = 1.1 + 0.002 * Math.sin(t / 7000)
    const sp = spikes[t]
    out.push({ time: t, open: c, high: sp ? sp[0] : c + 0.0003, low: sp ? sp[1] : c - 0.0003, close: c, volume: 1 })
  }
  return out
}
const at = (day: number, h: number, m = 0) => start + day * DAY + h * 3600 + m * 60
const tests: [string, () => void][] = []
const test = (n: string, f: () => void) => tests.push([n, f])

// day 8 = Tue 2026-11-10 (today), day 7 = Mon 11-09 (previous day), prior week = days 0-6 (Mon 11-02 .. Sun 11-08)
test('previous day high/low, today range and previous-week range are found at their true values', () => {
  const c = build(at(8, 12), {
    [at(7, 9)]: [1.109, 1.1],
    [at(7, 14)]: [1.1, 1.091],
    [at(3, 10)]: [1.12, 1.1], // previous week high
    [at(4, 10)]: [1.1, 1.08], // previous week low
  })
  const r = dayLevels(c)
  assert.ok(r.ok, r.reason)
  const by = Object.fromEntries(r.levels.map((l) => [l.id, l]))
  assert.equal(by.PDH.price, 1.109)
  assert.equal(by.PDL.price, 1.091)
  assert.equal(by.PWH.price, 1.12)
  assert.equal(by.PWL.price, 1.08)
  assert.ok(by.DAY_HIGH && by.DAY_LOW)
  assert.equal(by.PDH.from, '2026-11-09')
})

test('a level price has traded beyond is swept; one it has not reached stays a live draw', () => {
  const c = build(at(8, 12), { [at(7, 9)]: [1.109, 1.1], [at(7, 14)]: [1.1, 1.091] })
  const r = dayLevels(c)
  const pdh = r.levels.find((l) => l.id === 'PDH')!
  assert.equal(pdh.swept, false)
  assert.equal(r.nearestAbove?.price !== undefined, true)
  assert.ok((r.nearestAbove?.distanceAtr ?? 0) > 0 && (r.nearestBelow?.distanceAtr ?? 0) < 0)
})

test('taking PDH and closing back inside is recorded as a rejection bar', () => {
  const rej = at(8, 10)
  const c = build(at(8, 12), { [at(7, 9)]: [1.109, 1.1], [at(8, 10)]: [1.1105, 1.1] })
  const r = dayLevels(c)
  const pdh = r.levels.find((l) => l.id === 'PDH')!
  assert.equal(pdh.swept, true)
  assert.ok(pdh.rejectedBar !== null)
  assert.equal(c[pdh.rejectedBar!].time, rej)
})

test('session ranges use fixed UTC hours', () => {
  const c = build(at(8, 12), { [at(8, 3)]: [1.1075, 1.1] , [at(8, 9)]: [1.1, 1.0925] })
  const r = dayLevels(c)
  const by = Object.fromEntries(r.levels.map((l) => [l.id, l]))
  assert.equal(by.ASIA_HIGH.price, 1.1075)
  assert.equal(by.LONDON_LOW.price, 1.0925)
})

test('missing coverage means no level, not an invented one', () => {
  // only 3 hours of data today and nothing yesterday
  const c: Candle[] = []
  for (let t = at(8, 9); t <= at(8, 12); t += STEP) c.push({ time: t, open: 1.1, high: 1.1005, low: 1.0995, close: 1.1 + (t % 600 ? 0.0001 : 0), volume: 1 })
  const r = dayLevels(c)
  assert.ok(r.ok)
  assert.equal(r.levels.find((l) => l.id === 'PDH'), undefined)
  assert.equal(r.levels.find((l) => l.id === 'PWH'), undefined)
})

test('too few bars / flat series refused', () => {
  assert.equal(dayLevels(build(at(0, 1))).ok, false)
  const flat: Candle[] = []
  for (let i = 0; i < 100; i++) flat.push({ time: start + i * STEP, open: 1, high: 1, low: 1, close: 1, volume: 1 })
  assert.equal(dayLevels(flat).ok, false)
})
let fail = 0
for (const [n, f] of tests) { try { f(); console.log('ok  ' + n) } catch (e) { fail++; console.log('FAIL ' + n + '\n    ' + (e as Error).message.slice(0, 400)) } }
console.log(fail ? fail + ' FAILED' : 'all ' + tests.length + ' passed')
process.exit(fail ? 1 : 0)
