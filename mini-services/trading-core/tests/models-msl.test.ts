// IQAIR//OS - tests for the MSL `ou.*` / `markov.*` / `stat.*` / `cm.*` namespaces and log()/exp().
//   npx tsx tests/models-msl.test.ts      (from mini-services/trading-core)
import assert from 'node:assert/strict'
import { parseStrategyScript, evaluateStrategyScript, type MslSeriesCtx } from '../src/analytics/strategylang'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { ouState } from '../src/analytics/kalman'
import { markovChain, hurstExponent, autocorrelation, regressionChannel } from '../src/analytics/quant'
import { blendCandles, findSmartBlends } from '../src/analytics/candlemath'
import { varianceRatio } from '../src/analytics/mslmodels'
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
function mk(closes: number[], seed = 1): Candle[] {
  const r = rng(seed + 99)
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c
    return { time: T0 + i * 60, open: o, high: Math.max(o, c) + r() * 0.03, low: Math.min(o, c) - r() * 0.03, close: c, volume: 10 + r() * 5 }
  })
}
/** mean-reverting (AR(1) level, OU) */
function ouWalk(n: number, phi = 0.85, seed = 1, sig = 0.2): Candle[] {
  const r = rng(seed)
  const c: number[] = []
  let x = 100
  for (let i = 0; i < n; i++) {
    x = 100 + phi * (x - 100) + gauss(r) * sig
    c.push(x)
  }
  return mk(c, seed)
}
/** random walk */
function rw(n: number, seed = 1, sig = 0.2): Candle[] {
  const r = rng(seed)
  const c: number[] = []
  let x = 100
  for (let i = 0; i < n; i++) {
    x += gauss(r) * sig
    c.push(x)
  }
  return mk(c, seed)
}
/** returns with AR(1) coefficient rho: rho>0 trending, rho<0 reverting */
function arRet(n: number, rho: number, seed = 1): Candle[] {
  const r = rng(seed)
  const c: number[] = []
  let x = 100
  let prev = 0
  for (let i = 0; i < n; i++) {
    prev = rho * prev + gauss(r) * 0.1
    x += prev
    c.push(x)
  }
  return mk(c, seed)
}
function toSeries(c: Candle[]): MslSeriesCtx {
  return { open: c.map((x) => x.open), high: c.map((x) => x.high), low: c.map((x) => x.low), close: c.map((x) => x.close), volume: c.map((x) => x.volume ?? 0) }
}
function run(script: string, series: MslSeriesCtx) {
  const parsed = parseStrategyScript(script)
  assert.ok(parsed.ok, `parse failed: ${!parsed.ok ? parsed.error : ''}`)
  if (!parsed.ok) throw new Error('unreachable')
  return evaluateStrategyScript(parsed.ast, {}, undefined, series, undefined, undefined, undefined)
}
/** numeric MSL value via `confidence = x` (clamped/rounded to 0-100; booleans read 1/0), so scale in the expression */
const val = (expr: string, c: Candle[]) => run(`call when true\nconfidence = ${expr}`, toSeries(c))
const num = (expr: string, c: Candle[]) => {
  const o = val(expr, c)
  assert.equal(o.error, undefined, String(o.error))
  return Number(o.confidence)
}

/** exact float equality inside MSL: |expr - X| < 1e-9 (confidence is clamped/rounded to 0-100, so compare in the script) */
const lit = (x: number) => (x >= 0 ? x.toFixed(12) : `(0 - ${(-x).toFixed(12)})`)
const eq = (expr: string, want: number, c: Candle[], tol = 1e-9) => assert.equal(num(`abs((${expr}) - ${lit(want)}) < ${tol.toFixed(12)}`, c), 1, `${expr} != ${want}`)

// ------------------------------------------------------------------ ou
test('ou: reads the same model as kalman.ts (z, theta, half-life, t-stat) on a mean-reverting market', () => {
  const c = ouWalk(300)
  const live = ouState(c.map((x) => x.close), 240)
  eq('ou.z()', live.z, c)
  eq('ou.theta()', live.theta, c)
  eq('ou.tStat()', live.tStat, c)
  eq('ou.halfLife()', live.halfLifeBars, c)
  eq('ou.sigma()', live.sigmaEq, c)
  assert.equal(num('ou.reverting()', c), live.meanReverting ? 1 : 0)
  assert.ok(live.meanReverting, 'a phi=0.85 OU market should read as mean-reverting')
  assert.ok(live.halfLifeBars < 15)
})

test('ou: dfSignificant (5% Dickey-Fuller) rarely fires on random walks; the app\'s loose reverting() flag is only a screen', () => {
  let strict = 0
  let loose = 0
  for (let seed = 1; seed <= 30; seed++) {
    strict += num('ou.dfSignificant()', rw(300, seed))
    loose += num('ou.reverting()', rw(300, seed))
  }
  assert.ok(strict <= 7, `${strict}/30 random walks pass the strict test`)
  assert.ok(loose > strict, `loose ${loose} should pass more often than strict ${strict} (documented: reverting() is a screen)`)
  assert.equal(num('ou.dfSignificant()', ouWalk(300, 0.85, 9)), 1, 'a true OU market passes the strict test')
})

test('ou: a stretch above the equilibrium reads stretchedAbove + put signal; bands and fair value are coherent', () => {
  const c = ouWalk(299, 0.85, 4)
  const last = c[c.length - 1].close
  c.push({ time: T0 + 299 * 60, open: last, high: 103.5, low: last, close: 103, volume: 10 })
  assert.equal(num('ou.stretchedAbove()', c), 1)
  assert.equal(num('ou.stretchedBelow()', c), 0)
  const sig = run('put when ou.signal() == "put"\ncall when ou.signal() == "call"', toSeries(c))
  assert.equal(sig.direction, 'put')
  assert.equal(num('ou.upper() > ou.theta() and ou.lower() < ou.theta() and ou.upper(240, 3) > ou.upper(240, 2)', c), 1)
  assert.equal(num('ou.fair() > 90 and ou.fair() < 110', c), 1)
})

test('ou: too little history -> ok() false and the script fails closed', () => {
  const c = ouWalk(40)
  assert.equal(num('ou.ok()', c), 0)
  assert.ok(val('ou.z()', c).error)
})

// ------------------------------------------------------------------ markov
test('markov: matches the chain in quant.ts and the probabilities are coherent', () => {
  const c = arRet(400, 0.3)
  const m = markovChain(c.map((x) => x.close), { lookback: 500 })
  eq('markov.probUp()', m.probUp, c)
  eq('markov.probDown()', m.probDown, c)
  eq('markov.state()', m.lastState - 2, c)
  eq('markov.p(1, 1)', m.matrix[3][3], c)
  eq('markov.samples()', m.sampleSize, c)
  eq('markov.next(-2) + markov.next(-1) + markov.next(0) + markov.next(1) + markov.next(2)', 1, c, 1e-9)
  eq('markov.probUp() + markov.probDown() + markov.probFlat()', 1, c, 1e-9)
  const rg = run('call when markov.regime() == "bull" or markov.regime() == "bear" or markov.regime() == "range" or markov.regime() == "chop"\nconfidence = 50', toSeries(c))
  assert.equal(rg.error, undefined)
  assert.equal(rg.direction, 'call', 'regime() is one of the four documented labels')
})

test('markov: a custom lookback is honoured; bad state / thin history fail closed', () => {
  const c = arRet(400, 0.3)
  const m = markovChain(c.map((x) => x.close), { lookback: 120 })
  eq('markov.probUp(120)', m.probUp, c)
  assert.ok(val('markov.next(3)', c).error, 'state 3 is out of range')
  assert.ok(val('markov.p(1)', c).error)
  assert.ok(val('markov.probUp()', arRet(30, 0.3)).error)
})

// ------------------------------------------------------------------ stat
test('stat: hurst / autocorr / regression match quant.ts', () => {
  const c = arRet(400, 0.4)
  const closes = c.map((x) => x.close)
  eq('stat.hurst()', hurstExponent(closes), c)
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]))
  const ac = autocorrelation(rets.slice(-120), 1)[0]
  eq('stat.autocorr(1, 120)', ac, c)
  assert.ok(ac > 0.1, `momentum series should have positive lag-1 autocorr (${ac})`)
  const ch = regressionChannel(closes, 100, 2)
  eq('stat.regMid(100)', ch.mid, c)
  assert.equal(num('stat.regUpper(100, 2) > stat.regMid(100) and stat.regLower(100, 2) < stat.regMid(100)', c), 1)
})

test('stat: variance ratio separates reverting (<1), random (~1) and trending (>1) markets', () => {
  const vr = (c: Candle[]) => varianceRatio(c.map((x) => x.close), 4, 400).vr
  const rev = vr(arRet(500, -0.4, 3))
  const trend = vr(arRet(500, 0.4, 3))
  const flat = vr(rw(500, 3))
  assert.ok(rev < 0.85, `reverting VR ${rev}`)
  assert.ok(trend > 1.3, `trending VR ${trend}`)
  assert.ok(flat > 0.7 && flat < 1.3, `random walk VR ${flat}`)
  eq('stat.varianceRatio(4, 400)', rev, arRet(500, -0.4, 3))
  assert.ok(num('stat.vrZ(4, 400) * 0 + 1', arRet(500, 0.4, 3)) === 1)
})

test('stat: regression slope sign, regZ on a stretch, volatility, moments, and fail-closed windows', () => {
  const up = ouWalk(10, 1)
  void up
  const c = mk(Array.from({ length: 200 }, (_, i) => 100 + i * 0.05 + Math.sin(i) * 0.05))
  assert.equal(num('stat.regSlope(100) > 0', c), 1)
  assert.equal(num('stat.regR2(100) > 0.8', c), 1)
  assert.equal(num('stat.ewmaVol() > 0 and stat.garchVol() > 0 and stat.retStd() > 0', c), 1)
  assert.equal(num('stat.kurt() * 0 + 1', c), 1)
  assert.ok(val('stat.hurst()', mk(Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i)))).error, 'hurst needs 101 bars')
  assert.ok(val('stat.nope()', c).error)
  assert.ok(val('stat.regZ()', c).error === undefined)
})

// ------------------------------------------------------------------ cm
test('cm: blend(n) is exactly the Candle Math blend and exposes bar fields', () => {
  const c = rw(120, 7)
  const b = blendCandles(c.slice(-3))
  eq('cm.blend(3).o', b.open, c)
  eq('cm.blend(3).h', b.high, c)
  eq('cm.blend(3).l', b.low, c)
  eq('cm.blend(3).c', b.close, c)
  assert.equal(num('cm.blend(3).h == max(ohlc(-1).h, ohlc(-2).h, ohlc(-3).h)', c), 1)
  assert.equal(num('cm.blend(3).l == min(ohlc(-1).l, ohlc(-2).l, ohlc(-3).l)', c), 1)
  assert.equal(num('cm.blend(3).c == ohlc(-1).c and cm.blend(3).o == ohlc(-3).o', c), 1)
  assert.equal(num('abs(cm.blend(3).body - abs(ohlc(-1).c - ohlc(-3).o)) < 0.0000001', c), 1)
  assert.equal(num('cm.blend(1).range == ohlc(-1).range', c), 1)
  // blend ending earlier: bars -5..-3
  assert.equal(num('cm.blend(3, -3).c == ohlc(-3).c', c), 1)
  assert.ok(val('cm.blend()', c).error, 'n is required')
  assert.ok(val('cm.blend(500)', c).error, 'a group larger than the history fails closed')
})

test('cm: patterns on the blended candle (has/count/dir) agree with the detector, and a bull marubozu is bullish', () => {
  // flat chop then three small green candles that blend into one big bullish marubozu-like body
  const base = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 2) * 0.1)
  const c: Candle[] = base.map((x, i) => ({ time: T0 + i * 60, open: x, high: x + 0.1, low: x - 0.1, close: x + 0.01, volume: 10 }))
  let p = 100
  for (let k = 0; k < 3; k++) {
    c.push({ time: T0 + (40 + k) * 60, open: p, high: p + 0.5, low: p - 0.01, close: p + 0.49, volume: 12 })
    p += 0.49
  }
  assert.ok(num('cm.count(3)', c) >= 1, 'a big blended body should trigger at least one pattern')
  assert.equal(num('cm.dir(3)', c), 1)
  assert.equal(num('cm.has("Bullish Marubozu", 3)', c), 1)
  assert.equal(num('cm.has("bullish marubozu", 3)', c), 1, 'case-insensitive')
  assert.equal(num('cm.bullish(3) >= 1 and cm.bearish(3) == 0', c), 1)
  assert.equal(num('cm.has("Doji", 3)', c), 0)
  assert.ok(val('cm.has("Doji")', c).error, 'n is required')
  assert.ok(val('cm.has(3, 3)', c).error, 'name must be a string')
  assert.equal(num('cm.newCount(3) <= cm.count(3)', c), 1)
})

test('cm: smart() matches findSmartBlends for the group ending on the latest bar', () => {
  let agree = 0
  for (let seed = 1; seed <= 12; seed++) {
    const c = rw(80, seed, 0.3)
    const tail = c.slice(-40)
    const hit = findSmartBlends(tail).find((b) => b.endIdx === tail.length - 1)
    const want = hit ? hit.endIdx - hit.startIdx + 1 : 0
    assert.equal(num('cm.smart()', c), want)
    if (want) agree++
  }
  void agree
  assert.ok(val('cm.nope()', rw(80)).error)
  assert.equal(num('cm.ok()', rw(80)), 1)
  assert.equal(num('cm.ok()', rw(20)), 0)
})

// ------------------------------------------------------------------ log / exp
test('log/ln/exp work and refuse values that would give NaN', () => {
  const c = rw(80)
  assert.equal(num('round(log(100) * 1000)', c), 100) // clamped to 100 by confidence; value check below
  assert.equal(num('round(ln(exp(2)) * 100)', c), 100)
  assert.equal(num('round(exp(0) * 10)', c), 10)
  assert.equal(num('abs(log(2.718281828459045) - 1) < 0.000001', c), 1)
  assert.ok(val('log(0)', c).error)
  assert.ok(val('ln(0 - 1)', c).error)
  assert.ok(val('exp(1000)', c).error)
})

// ------------------------------------------------------------------ backtests
test('backtest: OU fade has a REAL edge on a mean-reverting market and none on a random walk', () => {
  const script = 'call when ou.stretchedBelow()\nput when ou.stretchedAbove()\nconfidence = 60'
  const pool = (gen: (seed: number) => Candle[], seeds: number) => {
    let trades = 0
    let wins = 0
    for (let seed = 1; seed <= seeds; seed++) {
      const res = backtestMslScript(gen(seed), script, { expiryBars: 2, warmupBars: 80 })
      assert.equal(res.ok, true)
      trades += res.trades.length
      wins += res.wins
    }
    return { trades, wr: trades ? wins / trades : 0 }
  }
  const real = pool((s) => ouWalk(900, 0.85, s * 31), 10)
  const null_ = pool((s) => rw(900, s * 31), 20)
  assert.ok(real.trades >= 100, `only ${real.trades} trades on the OU market`)
  assert.ok(real.wr > 0.56, `OU fade on a true OU market: ${(real.wr * 100).toFixed(1)}% over ${real.trades} trades`)
  assert.ok(null_.trades < 20 || (null_.wr > 0.4 && null_.wr < 0.6), `random walk: ${(null_.wr * 100).toFixed(1)}% over ${null_.trades} trades`)
})

test('backtest: markov / stat / cm scripts replay without error and give no invented edge on random walks', () => {
  const scripts = [
    'call when markov.probUp() >= 0.5 and markov.entropy() < 0.99\nput when markov.probDown() >= 0.5 and markov.entropy() < 0.99\nconfidence = 60',
    'call when stat.autocorr(1, 120) < -0.1 and stat.regZ(100) < -1.5\nput when stat.autocorr(1, 120) < -0.1 and stat.regZ(100) > 1.5\nconfidence = 60',
    'call when cm.dir(3) == 1\nput when cm.dir(3) == -1\nconfidence = 60',
  ]
  for (const script of scripts) {
    let trades = 0
    let wins = 0
    for (let seed = 1; seed <= 12; seed++) {
      const res = backtestMslScript(rw(700, seed * 17), script, { expiryBars: 3, warmupBars: 90 })
      assert.equal(res.ok, true, `${script}: ${JSON.stringify((res as { error?: string }).error)}`)
      trades += res.trades.length
      wins += res.wins
    }
    if (trades >= 100) {
      const wr = wins / trades
      assert.ok(wr > 0.4 && wr < 0.6, `${(wr * 100).toFixed(1)}% over ${trades} trades for: ${script.split('\n')[0]}`)
    }
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
