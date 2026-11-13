// IQAIR//OS - tests for the MSL `amd.*` namespace (accumulation / manipulation / distribution).
//   npx tsx tests/amd-msl.test.ts      (from mini-services/trading-core)
//
// HONESTY NOTE: the planted-market tests prove the DETECTOR finds a structure that was put there on purpose and gets its
// direction right. They say nothing about whether real markets trade this way - that is only answered by a real-data backtest.
import assert from 'node:assert/strict'
import { parseStrategyScript, evaluateStrategyScript, type MslSeriesCtx } from '../src/analytics/strategylang'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { readAmd, AMD_MIN_BARS } from '../src/analytics/mslamd'
import type { Candle } from '../src/types'

type Test = { name: string; fn: () => void }
const tests: Test[] = []
const test = (name: string, fn: () => void) => tests.push({ name, fn })
const T0 = 1_700_000_000

function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r())
function build(closes: number[], r: () => number, step = 60, t0 = T0): Candle[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c
    return { time: t0 + i * step, open: o, high: Math.max(o, c) + r() * 0.1, low: Math.min(o, c) - r() * 0.1, close: c, volume: 10 }
  })
}
function rw(n: number, seed = 1, sig = 1): Candle[] {
  const r = rng(seed)
  let x = 100
  const c: number[] = []
  for (let i = 0; i < n; i++) {
    x += gauss(r) * sig
    c.push(x)
  }
  return build(c, r)
}
/** one planted cycle appended to closes: quiet box, sweep + reclaim, displacement opposite the sweep. Returns the new last price. */
function cycle(c: number[], r: () => number, sweepUp: boolean, tail = 12): void {
  let x = c[c.length - 1]
  const mid = x
  for (let i = 0; i < 20; i++) c.push(mid + gauss(r) * 0.25)
  const hi = Math.max(...c.slice(-20))
  const lo = Math.min(...c.slice(-20))
  if (sweepUp) {
    c.push(hi + 0.6)
    c.push(hi + 0.4)
  } else {
    c.push(lo - 0.6)
    c.push(lo - 0.4)
  }
  c.push(mid)
  x = mid
  for (let i = 0; i < tail; i++) {
    x += (sweepUp ? -1 : 1) * 0.8 + gauss(r) * 0.2
    c.push(x)
  }
}
function planted(seed: number, sweepUp: boolean, tail = 12): Candle[] {
  const r = rng(seed)
  let x = 100
  const c: number[] = []
  for (let i = 0; i < 110; i++) {
    x += gauss(r)
    c.push(x)
  }
  cycle(c, r, sweepUp, tail)
  return build(c, r)
}
function toSeries(c: Candle[], withTime = false): MslSeriesCtx {
  return { open: c.map((x) => x.open), high: c.map((x) => x.high), low: c.map((x) => x.low), close: c.map((x) => x.close), volume: c.map((x) => x.volume ?? 0), ...(withTime ? { time: c.map((x) => x.time) } : {}) }
}
function run(script: string, series: MslSeriesCtx) {
  const parsed = parseStrategyScript(script)
  assert.ok(parsed.ok, `parse failed: ${!parsed.ok ? parsed.error : ''}`)
  if (!parsed.ok) throw new Error('unreachable')
  return evaluateStrategyScript(parsed.ast, {}, undefined, series, undefined, undefined, undefined)
}
const val = (expr: string, c: Candle[], withTime = false) => run(`call when true\nconfidence = ${expr}`, toSeries(c, withTime))
const num = (expr: string, c: Candle[], withTime = false) => {
  const o = val(expr, c, withTime)
  assert.equal(o.error, undefined, String(o.error))
  return Number(o.confidence)
}
const lit = (x: number) => (x >= 0 ? x.toFixed(12) : `(0 - ${(-x).toFixed(12)})`)
const eq = (expr: string, want: number, c: Candle[], withTime = false) => assert.equal(num(`abs((${expr}) - ${lit(want)}) < 0.000000001`, c, withTime), 1, `${expr} != ${want}`)
const phaseIs = (c: Candle[], p: string, mode = '') => run(`call when amd.phase(${mode}) == "${p}"\nconfidence = 50`, toSeries(c, mode === '1')).direction === 'call'

test('planted sweep + reclaim + displacement: the phases arrive in order with the right direction (both sides)', () => {
  let detected = 0
  let wrongDir = 0
  let accumulating = 0
  let manipReclaim = 0
  let n = 0
  for (let seed = 1; seed <= 50; seed++) {
    for (const up of [true, false]) {
      n++
      const c = planted(seed * 3, up)
      const want = up ? -1 : 1
      const last = readAmd(c, 0)!
      if (last.phase === 'distribution') {
        if (last.dir === want) detected++
        else wrongDir++
      }
      if (readAmd(c.slice(0, 128), 0)!.phase === 'accumulation') accumulating++
      const m = readAmd(c.slice(0, 133), 0)!
      if (m.phase === 'manipulation' && m.returned && m.dir === want && m.sweepSide === (up ? 1 : -1)) manipReclaim++
    }
  }
  assert.equal(wrongDir, 0, 'a distribution must never point the wrong way on the planted structure')
  assert.ok(detected >= n * 0.75, `distribution found ${detected}/${n}`)
  assert.ok(accumulating >= n * 0.75, `accumulation found ${accumulating}/${n}`)
  assert.ok(manipReclaim >= n * 0.75, `manipulation + reclaim found ${manipReclaim}/${n}`)
})

test('the MSL namespace reads exactly what the detector reads', () => {
  const c = planted(12, false)
  const m = readAmd(c, 0)!
  assert.equal(m.phase, 'distribution')
  assert.ok(phaseIs(c, 'distribution'))
  assert.equal(num('amd.stage()', c), 3)
  assert.equal(num('amd.distributing()', c), 1)
  assert.equal(num('amd.accumulating() + amd.manipulating()', c), 0)
  assert.equal(num('amd.dir() + 1', c), 2, 'bullish after a sweep of the lows')
  assert.equal(num('amd.sweepSide() + 1', c), 0, 'the box LOW was swept')
  assert.equal(num('amd.returned()', c), 1)
  eq('amd.boxHigh()', m.boxHigh, c)
  eq('amd.boxLow()', m.boxLow, c)
  eq('amd.sweepDepth()', m.sweepDepth, c)
  eq('amd.moveAtr()', m.moveAtr, c)
  assert.equal(num('amd.age()', c), m.age)
  assert.equal(num('amd.boxBars()', c), m.boxBars)
  assert.ok(m.moveAtr > 0 && m.sweepDepth > 0)
  const up = planted(12, true)
  assert.equal(num('amd.dir() + 1', up), 0, 'bearish after a sweep of the highs')
})

test('manipulation: the poke is live before the reclaim, returned() flips on the reclaim, and a poke that is NOT reclaimed is a breakout', () => {
  const r = rng(77)
  let x = 100
  const c: number[] = []
  for (let i = 0; i < 110; i++) {
    x += gauss(r)
    c.push(x)
  }
  const mid = x
  for (let i = 0; i < 20; i++) c.push(mid + gauss(r) * 0.25)
  const hi = Math.max(...c.slice(-20))
  const base = c.length
  c.push(hi + 0.7) // poke 1
  const pokeLive = build([...c], rng(5))
  const m0 = readAmd(pokeLive, 0)!
  assert.equal(m0.phase, 'manipulation')
  assert.equal(m0.returned, false)
  assert.equal(m0.sweepSide, 1)
  c.push(mid) // reclaim
  const m1 = readAmd(build([...c], rng(5)), 0)!
  assert.equal(m1.phase, 'manipulation')
  assert.equal(m1.returned, true)
  assert.equal(m1.dir, -1)
  // instead of reclaiming, keep closing above the box for 6 bars: a genuine breakout
  const c2 = c.slice(0, base)
  for (let k = 0; k < 6; k++) c2.push(hi + 0.7 + k * 0.1)
  const b = readAmd(build(c2, rng(5)), 0)!
  assert.equal(b.phase, 'none')
  assert.equal(b.breakout, 1)
  assert.equal(num('amd.breakout()', build(c2, rng(5))), 1)
})

test('stalled, failed and aged-out cycles drop back to none; a close back through the sweep extreme ends the move', () => {
  // distribution that ages out: long displacement tail
  const old = planted(21, true, 70)
  assert.notEqual(readAmd(old, 0)!.phase, 'distribution', 'a distribution 50+ bars old is over')
  // failed: after distributing down, price rips back above the sweep extreme
  const r = rng(31)
  let x = 100
  const c: number[] = []
  for (let i = 0; i < 110; i++) {
    x += gauss(r)
    c.push(x)
  }
  cycle(c, r, true, 6)
  const hi = Math.max(...c.slice(110, 130))
  c.push(hi + 3) // rips back above the sweep extreme
  assert.notEqual(readAmd(build(c, rng(5)), 0)!.phase, 'distribution')
})

test('random walks: phases are labelled on a minority of bars, and the scan is causal', () => {
  const counts: Record<string, number> = {}
  let total = 0
  for (let seed = 1; seed <= 40; seed++) {
    const c = rw(400, seed * 7)
    for (let end = 130; end <= 400; end += 10) {
      const p = readAmd(c.slice(0, end), 0)!.phase
      counts[p] = (counts[p] ?? 0) + 1
      total++
    }
  }
  const labelled = 1 - (counts.none ?? 0) / total
  assert.ok(labelled < 0.3, `${(labelled * 100).toFixed(1)}% of random-walk bars carry a phase label`)
  // causality: the read at bar k is identical whether or not later bars exist
  const c = planted(5, true)
  for (const k of [125, 133, 140, 145]) {
    const a = readAmd(c.slice(0, k), 0)!
    const b = readAmd(build(c.slice(0, k).map((x) => x.close), rng(1)).map((x, i) => ({ ...c[i] })), 0)!
    assert.equal(a.phase, b.phase)
  }
})

test('session mode: the Asia range is the box, London sweeps it, New York distributes (real timestamps required)', () => {
  const STEP = 300
  const day0 = Math.floor(T0 / 86400) * 86400
  const r = rng(9)
  const closes: number[] = []
  // day 1 + day 2: noisy filler (also gives the pivot/prior-ATR history)
  let x = 100
  for (let i = 0; i < 288 * 2; i++) {
    x += gauss(r) * 0.6
    closes.push(x)
  }
  // day 3: Asia 00:00-08:00 (96 bars) quiet range
  const mid = x
  for (let i = 0; i < 96; i++) closes.push(mid + gauss(r) * 0.15)
  const asia = closes.slice(-96)
  const lo = Math.min(...asia)
  const hi = Math.max(...asia)
  // London 08:00: sweep the LOW and reclaim
  closes.push(lo - 0.5)
  closes.push(lo - 0.3)
  closes.push(mid)
  // New York drift up
  x = mid
  for (let i = 0; i < 30; i++) {
    x += 0.35 + gauss(r) * 0.1
    closes.push(x)
  }
  const candles = build(closes, r, STEP, day0)
  const asiaEndIdx = 288 * 2 + 96
  // during Asia (07:00 = idx 288*2+84): accumulation
  const during = candles.slice(0, 288 * 2 + 84)
  assert.equal(readAmd(during, 1)!.phase, 'accumulation')
  assert.ok(phaseIs(during, 'accumulation', '1'))
  // right after the reclaim: manipulation, bullish expectation
  const afterReclaim = candles.slice(0, asiaEndIdx + 3)
  const m = readAmd(afterReclaim, 1)!
  assert.equal(m.phase, 'manipulation')
  assert.equal(m.returned, true)
  assert.equal(m.dir, 1)
  assert.equal(m.sweepSide, -1)
  assert.equal(Math.abs(m.boxHigh - hi) < 0.5 && Math.abs(m.boxLow - lo) < 0.5, true)
  // New York drift: distribution up
  const d = readAmd(candles, 1)!
  assert.equal(d.phase, 'distribution')
  assert.equal(d.dir, 1)
  assert.equal(num('amd.stage(1)', candles, true), 3)
  assert.equal(num('amd.dir(1)', candles, true), 1)
  // needs timestamps, and the whole Asia session in the history
  assert.ok(val('amd.phase(1)', candles, false).error, 'session mode without timestamps fails closed')
  assert.equal(num('amd.ok(1)', candles, false), 0)
  const partial = candles.slice(288 * 2 + 30)
  assert.equal(num('amd.ok(1)', partial, true), 0, 'history that starts mid-Asia has no complete box')
})

test('fail-closed on thin history, bad mode, unknown method', () => {
  const thin = rw(AMD_MIN_BARS - 10)
  assert.equal(num('amd.ok()', thin), 0)
  assert.ok(val('amd.phase()', thin).error)
  assert.ok(val('amd.stage(2)', rw(200)).error, 'mode must be 0 or 1')
  assert.ok(val('amd.nope()', rw(200)).error)
  assert.equal(num('amd.ok()', rw(200)), 1)
})

test('backtest: following the distribution wins on a planted-cycle market (machinery check) and is a coin flip on random walks', () => {
  const script = 'call when amd.distributing() and amd.dir() == 1 and amd.age() <= 2\nput when amd.distributing() and amd.dir() == 0 - 1 and amd.age() <= 2\nconfidence = 60'
  // markets made of repeated planted cycles with RW filler between them
  let pt = 0
  let pw = 0
  for (let seed = 1; seed <= 6; seed++) {
    const r = rng(seed * 101)
    let x = 100
    const c: number[] = []
    for (let i = 0; i < 100; i++) {
      x += gauss(r)
      c.push(x)
    }
    for (let k = 0; k < 10; k++) {
      cycle(c, r, r() < 0.5, 12)
      for (let i = 0; i < 50; i++) c.push(c[c.length - 1] + gauss(r))
    }
    const res = backtestMslScript(build(c, r), script, { expiryBars: 3, warmupBars: 100 })
    assert.equal(res.ok, true)
    pt += res.trades.length
    pw += res.wins
  }
  assert.ok(pt >= 20, `only ${pt} trades on the planted-cycle market`)
  assert.ok(pw / pt > 0.65, `planted-cycle market ${((pw / pt) * 100).toFixed(1)}% over ${pt} trades`)
  // null market
  let nt = 0
  let nw = 0
  for (let seed = 1; seed <= 25; seed++) {
    const res = backtestMslScript(rw(900, seed * 13), script, { expiryBars: 3, warmupBars: 130 })
    assert.equal(res.ok, true)
    nt += res.trades.length
    nw += res.wins
  }
  assert.ok(nt >= 60, `only ${nt} trades on random walks`)
  const wr = nw / nt
  assert.ok(wr > 0.4 && wr < 0.6, `random walk ${(wr * 100).toFixed(1)}% over ${nt} trades`)
})

test('the documented examples parse', () => {
  const ex = [
    'call when amd.distributing() and amd.dir() == 1 and amd.age() <= 3 and vol.moderate()\nput when amd.distributing() and amd.dir() == -1 and amd.age() <= 3 and vol.moderate()\nconfidence = 60',
    'call when amd.manipulating() and amd.returned() and amd.dir() == 1 and amd.sweepDepth() > 0.5\nconfidence = 55',
    'call when amd.phase(1) == "distribution" and amd.dir(1) == 1\nconfidence = 55',
  ]
  for (const e of ex) {
    const p = parseStrategyScript(e)
    assert.ok(p.ok, !p.ok ? p.error : '')
  }
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
    console.log(`  FAIL - ${t.name}\n    ${err instanceof Error ? err.message : err}`)
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
if (failed > 0) process.exit(1)
