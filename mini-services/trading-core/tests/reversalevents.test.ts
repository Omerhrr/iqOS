// IQAIR//OS - tests for the Renko (Effort Bricks) / Kagi reversal event feeds.
//
// Same no-framework runner as msl.test.ts (plain node:assert + a tiny loop):
//   npx tsx tests/reversalevents.test.ts      (from mini-services/trading-core)
//
// Covers: Kagi event stamping on a hand-built tape (exact expected events),
// no-look-ahead scoring, Renko/Effort feed shape and the plain-Renko / no-volume
// honesty paths, the exported regime classifier staying identical to the one
// effortBricks() reports, and the null-market check - on a driftless random
// walk NO event kind may ever be called "proven" follow-through.

import assert from 'node:assert/strict'
import { kagi } from '../src/analytics/kagi'
import { effortBricks, classifyEffortRegime } from '../src/analytics/effortbricks'
import { kagiReversalFeed, renkoReversalFeed } from '../src/analytics/reversalevents'
import type { Candle } from '../src/types'

type Test = { name: string; fn: () => void }
const tests: Test[] = []
function test(name: string, fn: () => void) {
  tests.push({ name, fn })
}

function fromCloses(closes: number[], volume = 100): Candle[] {
  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * 60,
    open: i === 0 ? c : closes[i - 1],
    high: Math.max(c, i === 0 ? c : closes[i - 1]) + 0.1,
    low: Math.min(c, i === 0 ? c : closes[i - 1]) - 0.1,
    close: c,
    volume,
  }))
}

function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomWalk(seed: number, n: number, withVolume = true): Candle[] {
  const r = mulberry32(seed)
  let p = 100
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const o = p
    p += (r() - 0.5) * 0.4
    out.push({ time: 1_700_000_000 + i * 60, open: o, high: Math.max(o, p) + 0.05, low: Math.min(o, p) - 0.05, close: p, volume: withVolume ? 50 + Math.floor(r() * 100) : 0 })
  }
  return out
}

// closes crafted so every Kagi event is predictable at reversal = 2
const KAGI_TAPE = [100, 101, 102, 103, 100.5, 99, 98, 100.5, 101, 97, 98, 100, 102]

test('kagi() stamps reversal / yin / yang events with the candle that caused them', () => {
  const r = kagi(fromCloses(KAGI_TAPE), { reversal: 2 })
  const got = r.events.map((e) => `${e.index}:${e.type}:${e.dir}`)
  assert.deepEqual(got, ['4:reversal:-1', '7:reversal:1', '9:yin:-1', '9:reversal:-1', '11:reversal:1', '12:yang:1'])
  const yin = r.events.find((e) => e.type === 'yin')!
  assert.equal(yin.level, 98, 'yin clears the waist (98)')
  assert.equal(yin.thick, false)
  const yang = r.events.find((e) => e.type === 'yang')!
  assert.equal(yang.level, 101, 'yang clears the shoulder (101)')
  assert.equal(yang.thick, true)
  assert.equal(r.thick, true, 'final thickness agrees with the last event')
})

test('kagi events are strictly in candle order and never fire on candle 0', () => {
  const r = kagi(randomWalk(5, 1500), { reversalAtrMult: 1 })
  assert.ok(r.events.length > 20)
  assert.ok(r.events[0].index >= 1)
  for (let i = 1; i < r.events.length; i++) assert.ok(r.events[i].index >= r.events[i - 1].index)
})

test('kagi feed: newest first, counts add up, follow-through scores only closed horizons', () => {
  const feed = kagiReversalFeed(fromCloses(KAGI_TAPE), { reversal: 2, horizon: 1, limit: 50 })
  assert.equal(feed.events.length, 6)
  assert.equal(feed.events[0].type, 'yang', 'newest event first')
  assert.equal(feed.events[0].candlesAgo, 0)
  assert.deepEqual(feed.counts, { reversal: 4, yang: 1, yin: 1 })
  const all = feed.followThrough.find((s) => s.group === 'all')!
  // the yang on the LAST candle has no next candle yet - it must not be scored
  assert.equal(all.n, 5)
  // idx4 put win, idx7 call win, idx9 yin put LOSS, idx9 reversal put LOSS, idx11 call win
  assert.equal(all.wins, 3)
  assert.ok(Math.abs(all.rate - 0.6) < 1e-9)
  assert.equal(all.enough, false, '5 events is never enough to call anything proven')
  assert.equal(all.proven, false)
})

test('kagi feed: limit trims the list but not the scored sample', () => {
  const a = kagiReversalFeed(fromCloses(KAGI_TAPE), { reversal: 2, limit: 2 })
  assert.equal(a.events.length, 2)
  assert.equal(a.followThrough.find((s) => s.group === 'all')!.n, 5)
})

test('effort feed: every listed event is a real direction flip, newest first', () => {
  const candles = randomWalk(11, 2000)
  const feed = renkoReversalFeed(candles, { source: 'effort', limit: 200 })
  assert.equal(feed.source, 'effort')
  assert.equal(feed.effortSource, 'volume')
  assert.ok(feed.totalReversals > 30)
  assert.ok(feed.events.length > 0 && feed.events.length <= 200)
  for (let i = 1; i < feed.events.length; i++) assert.ok(feed.events[i].time <= feed.events[i - 1].time)
  for (const e of feed.events) {
    assert.ok(e.candlesAgo >= 0 && e.candleIdx >= 0 && e.candleIdx < candles.length)
    assert.ok(e.priorRun >= 1)
    assert.equal(typeof e.confirmed, 'boolean')
    assert.ok(e.regime !== null)
  }
})

test('effort feed: reversals are exactly the brick direction changes', () => {
  const candles = randomWalk(13, 1200)
  const feed = renkoReversalFeed(candles, { source: 'effort', limit: 200 })
  const bricks = effortBricks(candles, {}).bricks
  let flips = 0
  for (let k = 1; k < bricks.length; k++) if (bricks[k].dir !== bricks[k - 1].dir) flips++
  assert.equal(feed.totalReversals, flips)
})

test('plain Renko source never fabricates confirmation or regime', () => {
  const feed = renkoReversalFeed(randomWalk(17, 1200), { source: 'renko', limit: 50 })
  assert.equal(feed.source, 'renko')
  assert.equal(feed.effortSource, 'n/a')
  assert.equal(feed.regime, null)
  assert.ok(feed.events.length > 0)
  for (const e of feed.events) {
    assert.equal(e.confirmed, null)
    assert.equal(e.regime, null)
    assert.equal(e.effortRatio, null)
  }
  assert.deepEqual(feed.followThrough.map((s) => s.group), ['all'])
})

test('a pair with no volume reads unconfirmed-unknown, never "confirmed"', () => {
  const feed = renkoReversalFeed(randomWalk(19, 1200, false), { source: 'effort', limit: 50 })
  assert.equal(feed.effortSource, 'none')
  assert.ok(feed.events.length > 0)
  for (const e of feed.events) {
    assert.equal(e.confirmed, null)
    assert.equal(e.regime, 'none')
  }
})

test('classifyEffortRegime matches the regime effortBricks() itself reports', () => {
  for (const seed of [3, 4, 5, 6, 7]) {
    const r = effortBricks(randomWalk(seed, 1500), { lookback: 20 })
    assert.ok(r.bricks.length >= 20)
    const c = classifyEffortRegime(r.bricks.slice(-20))
    assert.equal(c.regime, r.regime, `seed ${seed}`)
    assert.ok(Math.abs(c.confirmedRatio - r.confirmedRatio) < 1e-12, `seed ${seed}`)
  }
})

test('NULL MARKET: on a driftless random walk no event kind is ever "proven" follow-through', () => {
  for (const seed of [21, 22, 23, 24]) {
    const candles = randomWalk(seed, 4000)
    const feeds = [
      renkoReversalFeed(candles, { source: 'effort' }).followThrough,
      renkoReversalFeed(candles, { source: 'renko' }).followThrough,
      kagiReversalFeed(candles, {}).followThrough,
    ]
    for (const stats of feeds) {
      for (const s of stats) {
        assert.equal(s.proven, false, `seed ${seed}: ${s.group} n=${s.n} rate=${s.rate.toFixed(3)} floor=${s.lowerBound.toFixed(3)} falsely proven`)
        assert.ok(s.lowerBound <= s.rate + 1e-9, 'a lower bound can never exceed the raw rate')
      }
    }
  }
})

test('follow-through breakeven follows the payout', () => {
  const lo = kagiReversalFeed(fromCloses(KAGI_TAPE), { reversal: 2, payout: 0.85 }).followThrough[0].breakeven
  const hi = kagiReversalFeed(fromCloses(KAGI_TAPE), { reversal: 2, payout: 0.92 }).followThrough[0].breakeven
  assert.ok(Math.abs(lo - 1 / 1.85) < 1e-12)
  assert.ok(Math.abs(hi - 1 / 1.92) < 1e-12)
  assert.ok(hi < lo, 'a bigger payout lowers the bar')
})

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    t.fn()
    passed++
    console.log(`  ok - ${t.name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL - ${t.name}`)
    console.log(`    ${err instanceof Error ? err.message : err}`)
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
if (failed > 0) process.exit(1)
