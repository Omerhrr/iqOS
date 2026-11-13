// IQAIR//OS - tests for the MSL `fib.*` / `pivot.*` / `vol.*` namespaces.
//   npx tsx tests/fib-msl.test.ts      (from mini-services/trading-core)
import assert from 'node:assert/strict'
import { parseStrategyScript, evaluateStrategyScript, type MslSeriesCtx } from '../src/analytics/strategylang'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { computeFibSeries, computePivotSeries } from '../src/analytics/structural'
import { atr } from '../src/analytics/indicators'
import { fibSwing, fibArc, FIB_SEQ } from '../src/analytics/mslfib'
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
function walk(n: number, seed = 1, sig = 0.2, step = 60): Candle[] {
  const r = rng(seed)
  const out: Candle[] = []
  let x = 100
  for (let i = 0; i < n; i++) {
    const o = x
    x += gauss(r) * sig
    out.push({ time: T0 + i * step, open: o, high: Math.max(o, x) + r() * 0.05, low: Math.min(o, x) - r() * 0.05, close: x, volume: 10 })
  }
  return out
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
const eq = (expr: string, want: number, c: Candle[], tol = 1e-9, withTime = false) => assert.equal(num(`abs((${expr}) - ${lit(want)}) < ${tol.toFixed(12)}`, c, withTime), 1, `${expr} != ${want}`)

/** an explicit up-leg: flat base, rally to a high, then drift down a bit. startIdx = low bar, endIdx = high bar */
function leg(up: boolean, baseBars = 30, legLen = 40, pullback = 12, pullStep = 0.2): Candle[] {
  const c: Candle[] = []
  let p = 100
  const push = (close: number) => {
    const o = p
    c.push({ time: T0 + c.length * 60, open: o, high: Math.max(o, close) + 0.05, low: Math.min(o, close) - 0.05, close, volume: 10 })
    p = close
  }
  for (let i = 0; i < baseBars; i++) push(100 + Math.sin(i) * 0.05)
  for (let i = 1; i <= legLen; i++) push(100 + (up ? 1 : -1) * i * 0.25)
  for (let i = 1; i <= pullback; i++) push(p - (up ? 1 : -1) * pullStep)
  return c
}

// ------------------------------------------------------------------ fib
test('fib: level / ext / dir equal the Auto Fibonacci overlay at every prefix (causal, no look-ahead)', () => {
  const c = walk(400, 3, 0.25)
  for (const k of [160, 220, 300, 400]) {
    const pre = c.slice(0, k)
    const s = computeFibSeries(pre, { lookback: 150, withExt: 1 })
    const i = k - 1
    eq('fib.level(0.382)', s.fib382[i], pre)
    eq('fib.level(0.618)', s.fib618[i], pre)
    eq('fib.level(0.5)', s.fib50[i], pre)
    eq('fib.level(0)', s.fib0[i], pre)
    eq('fib.level(1)', s.fib100[i], pre)
    eq('fib.ext(1.272)', s.ext1272[i], pre)
    eq('fib.ext(1.618)', s.ext1618[i], pre)
    assert.equal(num('fib.dir()', pre), s.state[i].startsWith('UP') ? 1 : 0, 'dir 1 for an up leg; -1 clamps to 0 in confidence')
  }
})

test('fib: explicit up and down legs - levels, pos, golden pocket, nearest, at(), leg stats', () => {
  const up = leg(true)
  const sw = fibSwing(up, 150)!
  assert.equal(sw.up, true)
  eq('fib.high()', sw.hi, up)
  eq('fib.low()', sw.lo, up)
  eq('fib.level(0)', sw.hi, up)
  eq('fib.level(1)', sw.lo, up)
  eq('fib.level(0.5)', (sw.hi + sw.lo) / 2, up)
  assert.equal(num('fib.legBars()', up), sw.legBars)
  assert.equal(num('fib.age()', up), sw.age)
  const pos = (sw.hi - sw.last) / sw.diff
  eq('fib.pos()', pos, up)
  assert.equal(num('fib.goldenPocket()', up), pos >= 0.382 && pos <= 0.618 ? 1 : 0)
  eq('fib.legAtr()', sw.diff / sw.atr, up, 1e-6)
  // nearest ratio is one of the standard set and closest to pos
  const std = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
  const near = std.reduce((b, r) => (Math.abs(r - pos) < Math.abs(b - pos) ? r : b), 0)
  eq('fib.nearest()', near, up)
  // at(): price exactly on its own nearest level is within a tiny tolerance of it
  assert.equal(num(`fib.at(${near}, 100)`, up), 1)
  // down leg mirrors
  const dn = leg(false)
  const sd = fibSwing(dn, 150)!
  assert.equal(sd.up, false)
  eq('fib.level(0)', sd.lo, dn)
  eq('fib.level(1)', sd.hi, dn)
  eq('fib.pos()', (sd.last - sd.lo) / sd.diff, dn)
  assert.equal(num('fib.dir() + 1', dn), 0, 'dir -1')
  // extensions project beyond the end extreme
  eq('fib.ext(1)', sw.hi, up)
  eq('fib.ext(1.618)', sw.hi + 0.618 * sw.diff, up)
  eq('fib.ext(1.618)', sd.lo - 0.618 * sd.diff, dn)
})

test('fib: arcs follow the circle geometry, are defined only inside their radius, and gate cleanly', () => {
  const up = leg(true, 30, 40, 12)
  const sw = fibSwing(up, 150)!
  const k = sw.legBars / sw.diff
  const L = Math.hypot(sw.legBars, sw.legBars)
  for (const r of [0.382, 0.5, 0.618, 1]) {
    const R = r * L
    const live = R > sw.age
    assert.equal(num(`fib.arcLive(${r})`, up), live ? 1 : 0)
    if (live) {
      const want = sw.hi - Math.sqrt(R * R - sw.age * sw.age) / k
      eq(`fib.arc(${r})`, want, up, 1e-9)
      eq(`fib.arcDist(${r})`, sw.last - want, up, 1e-9)
      assert.ok(want < sw.hi, 'an up-leg arc hangs BELOW the leg end')
    }
  }
  // far from the leg end the small arcs are no longer defined and arc() fails closed
  const far = leg(true, 30, 10, 60, 0.005)
  assert.equal(num('fib.arcLive(0.382)', far), 0)
  assert.ok(val('fib.arc(0.382)', far).error, 'arc outside its radius fails closed')
  // down leg: arcs hang ABOVE the low
  const dn = leg(false)
  const sd = fibSwing(dn, 150)!
  const a = fibArc(sd, 0.618)
  assert.ok(a.live && a.price > sd.lo)
  assert.ok(val('fib.arc(0)', up).error)
})

test('fib: time zones count Fibonacci multiples of `unit` bars from the leg START', () => {
  for (const pb of [3, 9, 20, 30]) {
    const c = leg(true, 30, 40, pb)
    const sw = fibSwing(c, 150)!
    const since = sw.lastIdx - sw.startIdx
    let j = 0
    while (j + 1 < FIB_SEQ.length && FIB_SEQ[j + 1] <= since) j++
    assert.equal(num('fib.tz()', c), j)
    assert.equal(num('fib.tzMult()', c), Math.min(100, FIB_SEQ[j]))
    assert.equal(num('fib.tzNext()', c), FIB_SEQ[j + 1] - since)
    assert.equal(num('fib.tzOn()', c), FIB_SEQ.includes(since) ? 1 : 0)
    assert.equal(num('fib.tzOn(1, 1)', c), FIB_SEQ.some((f) => Math.abs(f - since) <= 1) ? 1 : 0)
    // TradingView-style unit = leg length
    assert.equal(num('fib.tzUnit()', c), Math.min(100, sw.legBars))
  }
})

test('fib: fail-closed on thin history, flat swing, bad args; optional lookback changes the swing', () => {
  assert.ok(val('fib.level(0.5)', walk(20)).error)
  assert.equal(num('fib.ok()', walk(20)), 0)
  assert.equal(num('fib.ok()', walk(60)), 1)
  const flat: Candle[] = Array.from({ length: 80 }, (_, i) => ({ time: T0 + i * 60, open: 100, high: 100, low: 100, close: 100, volume: 1 }))
  assert.ok(val('fib.level(0.5)', flat).error)
  assert.ok(val('fib.ext(0.5)', walk(200)).error, 'extension < 1 is refused')
  assert.ok(val('fib.level()', walk(200)).error)
  assert.ok(val('fib.level(0.5, 100, 7)', walk(200)).error, 'too many args')
  assert.ok(val('fib.nope()', walk(200)).error)
  const c = walk(400, 8, 0.3)
  const a = fibSwing(c, 60)!
  const b = fibSwing(c, 300)!
  eq('fib.level(0.5, 60)', (a.hi + a.lo) / 2, c)
  eq('fib.level(0.5, 300)', (b.hi + b.lo) / 2, c)
})

// ------------------------------------------------------------------ pivots
test('pivot: session pivots equal computePivotSeries with real timestamps; rolling fallback without', () => {
  const c = walk(900, 5, 0.1, 300) // 5m bars, ~3.1 days
  for (const variant of [0, 1, 2, 3]) {
    const s = computePivotSeries(c, { variant, period: 60 })
    const i = c.length - 1
    assert.equal(s.mode, 'session')
    for (const [name, arr] of [['pp', s.pp], ['r1', s.r1], ['r2', s.r2], ['r3', s.r3], ['s1', s.s1], ['s2', s.s2], ['s3', s.s3]] as const) {
      eq(`pivot.${name}(${variant})`, arr[i], c, 1e-9, true)
    }
  }
  const sess = run('call when pivot.mode() == "session"\nconfidence = 50', toSeries(c, true))
  assert.equal(sess.direction, 'call')
  const roll = run('call when pivot.mode() == "rolling"\nconfidence = 50', toSeries(c, false))
  assert.equal(roll.direction, 'call')
  const r = computePivotSeries(c.map((x, i) => ({ ...x, time: i })), { variant: 0, period: 60 })
  eq('pivot.pp()', r.pp[c.length - 1], c, 1e-9, false)
})

test('pivot: ordering, above(), nearest and distance in ATR', () => {
  const c = walk(900, 6, 0.1, 300)
  assert.equal(num('pivot.s3() < pivot.s2() and pivot.s2() < pivot.s1() and pivot.s1() < pivot.pp() and pivot.pp() < pivot.r1() and pivot.r1() < pivot.r2() and pivot.r2() < pivot.r3()', c, true), 1)
  const last = c[c.length - 1].close
  const s = computePivotSeries(c, { variant: 0, period: 60 })
  const i = c.length - 1
  const lv = [s.s3[i], s.s2[i], s.s1[i], s.pp[i], s.r1[i], s.r2[i], s.r3[i]]
  assert.equal(num('pivot.above()', c, true), lv.filter((l) => last > l).length)
  const best = lv.reduce((b, l) => (Math.abs(l - last) < Math.abs(b - last) ? l : b), lv[0])
  eq('pivot.nearest()', best, c, 1e-9, true)
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 14)
  eq('pivot.nearestDist()', (last - best) / a[a.length - 1], c, 1e-9, true)
  assert.equal(num('pivot.ok()', walk(5)), 0)
  assert.ok(val('pivot.pp()', walk(5)).error)
  assert.ok(val('pivot.zz()', c).error)
})

// ------------------------------------------------------------------ vol
test('vol: atr / atrPct / ratio match the indicator math; rank is a percentile of the pair\'s own ATR history', () => {
  const c = walk(300, 9, 0.2)
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 14)
  const cur = a[a.length - 1]
  eq('vol.atr()', cur, c)
  eq('vol.atrPct()', (cur / c[c.length - 1].close) * 100, c)
  const hist = a.slice(-200).filter((v) => Number.isFinite(v))
  const rank = (hist.filter((v) => v < cur).length + 0.5 * hist.filter((v) => v === cur).length) / hist.length
  eq('vol.rank()', rank, c)
  const af = atr(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 5)
  const as = atr(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 30)
  eq('vol.ratio()', af[af.length - 1] / as[as.length - 1], c)
  const last = c[c.length - 1]
  eq('vol.barRatio()', (last.high - last.low) / cur, c)
  eq('vol.barRatio(-3)', (c[c.length - 3].high - c[c.length - 3].low) / cur, c)
})

test('vol: a frantic tail ranks high / expanding, a dead tail ranks low / contracting, and low|moderate|high partition the rank', () => {
  const calm = walk(200, 11, 0.1)
  const frantic = walk(40, 12, 1.2).map((x, i) => ({ ...x, time: T0 + (200 + i) * 60 }))
  const shift = calm[calm.length - 1].close - frantic[0].open
  const hot = [...calm, ...frantic.map((x) => ({ ...x, open: x.open + shift, high: x.high + shift, low: x.low + shift, close: x.close + shift }))]
  assert.equal(num('vol.high()', hot), 1)
  assert.equal(num('vol.low()', hot), 0)
  assert.equal(num('vol.moderate()', hot), 0)
  assert.equal(num('vol.ratio() > 1.05', hot), 1)
  const wild = walk(200, 13, 1.0)
  const dead = walk(40, 14, 0.02).map((x, i) => ({ ...x, time: T0 + (200 + i) * 60 }))
  const sh2 = wild[wild.length - 1].close - dead[0].open
  const cold = [...wild, ...dead.map((x) => ({ ...x, open: x.open + sh2, high: x.high + sh2, low: x.low + sh2, close: x.close + sh2 }))]
  assert.equal(num('vol.low()', cold), 1)
  assert.equal(num('vol.high()', cold), 0)
  assert.equal(num('vol.ratio() < 0.7', cold), 1)
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const c = walk(300, seed, 0.2)
    assert.equal(num('vol.low() + vol.moderate() + vol.high()', c), 1, 'exactly one of low/moderate/high')
    assert.equal(num('vol.low(0.4) + vol.moderate(0.4, 0.6) + vol.high(0.6)', c), 1)
  }
  assert.ok(val('vol.moderate(0.8, 0.2)', hot).error)
  assert.ok(val('vol.rank()', walk(30)).error)
  assert.equal(num('vol.ok()', walk(30)), 0)
})

// ------------------------------------------------------------------ backtests (null market)
test('backtest: fib / pivot / vol scripts replay without error and invent no edge on random walks', () => {
  const scripts = [
    'call when fib.dir() == 1 and fib.at(0.618, 0.3) and vol.moderate()\nput when fib.dir() == 0 - 1 and fib.at(0.618, 0.3) and vol.moderate()\nconfidence = 60',
    'call when fib.goldenPocket() and fib.dir() == 1 and fib.legAtr() > 3\nput when fib.goldenPocket() and fib.dir() == 0 - 1 and fib.legAtr() > 3\nconfidence = 60',
    'call when pivot.nearestDist() < 0 - 0.5 and vol.moderate()\nput when pivot.nearestDist() > 0.5 and vol.moderate()\nconfidence = 60',
    'call when fib.tzOn(1, 0) and fib.pos() > 0.5 and vol.moderate(0.2, 0.8)\nput when fib.tzOn(1, 0) and fib.pos() < 0.5 and vol.moderate(0.2, 0.8)\nconfidence = 60',
  ]
  for (const script of scripts) {
    let trades = 0
    let wins = 0
    for (let seed = 1; seed <= 12; seed++) {
      const res = backtestMslScript(walk(800, seed * 13, 0.2), script, { expiryBars: 3, warmupBars: 100 })
      assert.equal(res.ok, true, `${script.split('\n')[0]}: ${JSON.stringify((res as { error?: string }).error)}`)
      trades += res.trades.length
      wins += res.wins
    }
    if (trades >= 100) {
      const wr = wins / trades
      assert.ok(wr > 0.4 && wr < 0.6, `${(wr * 100).toFixed(1)}% over ${trades} trades for: ${script.split('\n')[0]}`)
    }
  }
})

test('the documented examples parse', () => {
  const ex = [
    'call when fib.dir() == 1 and fib.at(0.618, 0.3) and vol.moderate()\nput when fib.dir() == 0 - 1 and fib.at(0.618, 0.3) and vol.moderate()\nconfidence = 60',
    'call when fib.arcLive(0.618) and abs(fib.arcDist(0.618)) < 0.3 * ind.atr(14)[-1]\nconfidence = 55',
    'call when pivot.above() >= 4 and vol.moderate(0.3, 0.7)\nconfidence = 55',
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
