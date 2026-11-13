// IQAIR//OS - tests for the MSL `tech.*` namespace (per-indicator Technical votes).
//   npx tsx tests/tech-msl.test.ts      (from mini-services/trading-core)
import assert from 'node:assert/strict'
import { parseStrategyScript, evaluateStrategyScript, type MslSeriesCtx } from '../src/analytics/strategylang'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { oscillatorVotes, maVotes, TECH_BARS_PER_RUNG } from '../src/analytics/technicals'
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
function drift(n: number, perBar: number, seed = 1, noise = 0.1): Candle[] {
  const r = rng(seed)
  const out: Candle[] = []
  let p = 100
  for (let i = 0; i < n; i++) {
    const o = p
    p += perBar + (r() - 0.5) * noise
    out.push({ time: T0 + i * 60, open: o, high: Math.max(o, p) + 0.02, low: Math.min(o, p) - 0.02, close: p, volume: 10 + r() * 5 })
  }
  return out
}
function toSeries(c: Candle[], withTime = false): MslSeriesCtx {
  return {
    open: c.map((x) => x.open), high: c.map((x) => x.high), low: c.map((x) => x.low), close: c.map((x) => x.close),
    volume: c.map((x) => x.volume ?? 0), ...(withTime ? { time: c.map((x) => x.time) } : {}),
  }
}
function run(script: string, series: MslSeriesCtx) {
  const parsed = parseStrategyScript(script)
  assert.ok(parsed.ok, `parse failed: ${!parsed.ok ? parsed.error : ''}`)
  if (!parsed.ok) throw new Error('unreachable')
  return evaluateStrategyScript(parsed.ast, {}, undefined, series, undefined, undefined, undefined)
}
/** evaluate `confidence = <expr>` so a numeric MSL value comes back (booleans read as 1/0) */
const val = (expr: string, series: MslSeriesCtx) => run(`call when true\nconfidence = ${expr}`, series)

test('counts match the panel functions exactly (up-drift)', () => {
  const c = drift(300, 0.05)
  const bars = c.slice(-TECH_BARS_PER_RUNG)
  const all = [...oscillatorVotes(bars), ...maVotes(bars)]
  const buys = all.filter((v) => v.read === 'buy').length
  const sells = all.filter((v) => v.read === 'sell').length
  const counted = all.filter((v) => v.read !== 'na').length
  const s = toSeries(c)
  assert.equal(val('tech.buys()', s).confidence, buys)
  assert.equal(val('tech.sells()', s).confidence, sells)
  assert.equal(val('tech.counted()', s).confidence, counted)
  assert.ok(buys > sells, `an up-drift should vote mostly buy (${buys} vs ${sells})`)
})

test('mirror: a down-drift votes mostly sell and tech.sellShare() is high', () => {
  const s = toSeries(drift(300, -0.05, 2))
  assert.ok(Number(val('tech.sells()', s).confidence) > Number(val('tech.buys()', s).confidence))
  assert.equal(run('put when tech.sellShare() >= 0.5\nconfidence = 60', s).direction, 'put')
})

test('per-block counts add up to the total', () => {
  const s = toSeries(drift(300, 0.04, 3))
  const g = (e: string) => Number(val(e, s).confidence)
  assert.equal(g('tech.oscBuys() + tech.maBuys()'), g('tech.buys()'))
  assert.equal(g('tech.oscSells() + tech.maSells()'), g('tech.sells()'))
  assert.equal(g('tech.oscCounted() + tech.maCounted()'), g('tech.counted()'))
  assert.equal(g('tech.oscCounted()'), 11)
})

test('single indicators vote +1 / -1 consistent with the panel, and score() is (buys-sells)/counted', () => {
  const c = drift(300, 0.05)
  const s = toSeries(c)
  const bars = c.slice(-TECH_BARS_PER_RUNG)
  const ma = maVotes(bars)
  const ema50 = ma.find((v) => v.name === 'EMA(50)')!
  assert.equal(val('tech.ema50()', s).confidence, ema50.read === 'buy' ? 1 : ema50.read === 'sell' ? -1 : 0)
  assert.equal(val('tech.ema200Ok()', s).confidence, 1)
  const buys = Number(val('tech.buys()', s).confidence)
  const sells = Number(val('tech.sells()', s).confidence)
  const counted = Number(val('tech.counted()', s).confidence)
  // confidence is clamped/rounded to 0-100, so read score as a percentage (positive on an up-drift)
  assert.equal(val('tech.score() * 100', s).confidence, Math.round(((buys - sells) / counted) * 100))
})

test('allBuy/allSell are exactly "every counted vote agrees"', () => {
  for (const [pb, seed] of [[0.05, 1], [-0.05, 2], [0, 5]] as const) {
    const s = toSeries(drift(300, pb, seed))
    const g = (e: string) => val(e, s).confidence
    const buys = Number(g('tech.buys()')), sells = Number(g('tech.sells()')), counted = Number(g('tech.counted()'))
    assert.equal(g('tech.allBuy()'), counted > 0 && buys === counted ? 1 : 0)
    assert.equal(g('tech.allSell()'), counted > 0 && sells === counted ? 1 : 0)
  }
})

test('too little history: ok() is false, other methods fail the script closed; indicators without history are excluded, not neutral', () => {
  const short = toSeries(drift(30, 0.05))
  assert.equal(val('tech.ok()', short).confidence, 0)
  assert.ok(val('tech.buys()', short).error, 'should fail closed')
  const mid = toSeries(drift(120, 0.05)) // enough for most, not for SMA/EMA 200
  assert.equal(val('tech.sma200Ok()', mid).confidence, 0)
  assert.equal(val('tech.sma200()', mid).confidence, 0)
  assert.ok(Number(val('tech.maCounted()', mid).confidence) < 15)
})

test('works without timestamps and an unknown method errors with the vocabulary', () => {
  const s = toSeries(drift(200, 0.05), false)
  assert.equal(val('tech.ok()', s).confidence, 1)
  const bad = val('tech.nope()', s)
  assert.ok(bad.error && /unknown tech method/.test(bad.error), String(bad.error))
})

test('backtest replays it, and a null market shows no invented edge', () => {
  let trades = 0
  let wins = 0
  for (let seed = 1; seed <= 25; seed++) {
    const r = rng(seed * 7919)
    const c: Candle[] = []
    let p = 100
    for (let i = 0; i < 1200; i++) {
      const o = p
      p += (r() - 0.5) * 0.4
      c.push({ time: T0 + i * 60, open: o, high: Math.max(o, p) + 0.05, low: Math.min(o, p) - 0.05, close: p, volume: 10 })
    }
    const res = backtestMslScript(c, 'call when tech.buyShare() >= 0.7\nput when tech.sellShare() >= 0.7\nconfidence = 60', { expiryBars: 3, warmupBars: 80 })
    assert.equal(res.ok, true)
    trades += res.trades.length
    wins += res.wins
  }
  assert.ok(trades >= 150, `only ${trades} trades - sample too small to judge`)
  const wr = wins / trades
  assert.ok(wr > 0.42 && wr < 0.58, `pooled win rate on random walks ${(wr * 100).toFixed(1)}% over ${trades} trades`)
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
