// IQAIR//OS - tests for the MSL `signal.*` namespace and the shared Signal core.
//   npx tsx tests/signal-msl.test.ts      (from mini-services/trading-core)
//
// Pins the property the namespace exists for: the Signal tab, a live MSL script
// and a backtest replay all read the SAME function of the SAME closed candles.
import assert from 'node:assert/strict'
import { parseStrategyScript, evaluateStrategyScript, type MslSeriesCtx } from '../src/analytics/strategylang'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { readSignalCore, SIGNAL_BARS } from '../src/analytics/signalcore'
import { SignalService } from '../src/plugins/signal'
import type { Candle } from '../src/types'

type Test = { name: string; fn: () => void }
const tests: Test[] = []
const test = (name: string, fn: () => void) => tests.push({ name, fn })

const T0 = 1_700_000_000 // a real-looking epoch second

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

function toSeries(c: Candle[], withTime = true): MslSeriesCtx {
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

const SCRIPT = 'call when signal.buy()\nput when signal.sell()\nconfidence = signal.strength()'

test('a script reads the same call and strength as the core, on an up-drift', () => {
  const c = drift(300, 0.05)
  const core = readSignalCore(c)!
  const out = run(SCRIPT, toSeries(c))
  assert.equal(out.error, undefined)
  assert.equal(core.signal.action, 'buy')
  assert.equal(out.direction, 'call')
  assert.equal(out.confidence, core.signal.strength)
})

test('a script reads SELL on a down-drift, identical to the core', () => {
  const c = drift(300, -0.05, 2)
  const core = readSignalCore(c)!
  const out = run(SCRIPT, toSeries(c))
  assert.equal(core.signal.action, 'sell')
  assert.equal(out.direction, 'put')
  assert.equal(out.confidence, core.signal.strength)
})

test('the core only ever sees the last 240 bars, however many are passed', () => {
  const c = drift(1000, 0.05, 3)
  const a = readSignalCore(c)!
  const b = readSignalCore(c.slice(-SIGNAL_BARS))!
  assert.equal(a.signal.needle, b.signal.needle)
  assert.equal(a.signal.action, b.signal.action)
  assert.equal(a.bars, SIGNAL_BARS)
})

test('without candle timestamps signal.* fails the script closed (never reads wrongly)', () => {
  const out = run(SCRIPT, toSeries(drift(300, 0.05), false))
  assert.ok(out.error && out.error.includes('timestamps'), String(out.error))
  assert.equal(out.direction, 'none')
})

test('ok() is false on thin history and every other method fails closed', () => {
  const thin = toSeries(drift(30, 0.05))
  const ok = run('call when signal.ok()\nconfidence = 50', thin)
  assert.equal(ok.error, undefined)
  assert.equal(ok.direction, 'none')
  const bad = run('call when signal.buy()\nconfidence = 50', thin)
  assert.ok(bad.error && bad.error.includes('too thin'), String(bad.error))
})

test('numeric and string methods return what the core holds', () => {
  const c = drift(300, 0.05, 4)
  const core = readSignalCore(c)!
  const s = toSeries(c)
  const needle = run('call when true\nconfidence = abs(signal.needle())', s)
  assert.equal(needle.confidence, Math.abs(core.signal.needle))
  const act = run('call when signal.action() == "buy"\nconfidence = 50', s)
  assert.equal(act.direction, 'call')
  const rg = run('call when signal.regime() == "trend-up" and signal.trending() and not signal.noise()\nconfidence = 50', s)
  assert.equal(rg.direction, core.signal.regime === 'trend-up' ? 'call' : 'none')
  const ex = run('call when true\nconfidence = signal.hold()', s)
  assert.equal(ex.confidence, core.signal.expiry ? core.signal.expiry.bars : 0)
})

test('per-reader lean / strength / ok methods match the evidence list', () => {
  const c = drift(300, 0.05, 5)
  const core = readSignalCore(c)!
  const s = toSeries(c)
  for (const id of ['smc', 'candle', 'mrc', 'swing', 'technical', 'effort']) {
    const e = core.signal.evidence.find((x) => x.id === id)!
    const lean = run(`call when true\nconfidence = ${id}Lean_PLACEHOLDER`.replace(`${id}Lean_PLACEHOLDER`, `50 + 10 * signal.${id}Lean()`), s)
    assert.equal(lean.confidence, 50 + 10 * (e.ok ? (e.lean === 'call' ? 1 : e.lean === 'put' ? -1 : 0) : 0), id)
    const okv = run(`call when signal.${id}Ok()\nconfidence = 50`, s)
    assert.equal(okv.direction, e.ok ? 'call' : 'none', id)
  }
})

test('an unknown method names the valid ones', () => {
  const out = run('call when signal.nope()\nconfidence = 50', toSeries(drift(300, 0.05)))
  assert.ok(out.error && out.error.includes('unknown signal method'), String(out.error))
})

test('the Signal service returns exactly the core\'s call for the same candles', () => {
  const c = drift(300, 0.05, 6)
  const services: Record<string, unknown> = {
    market: { getCandlesDeep: () => c, getPrice: () => 0, listAssets: () => [] },
    regimescan: { global: () => ({ ok: true, up: [], down: [], ranging: [] }) },
  }
  const svc = new SignalService()
  void svc.start({ use: (n: string) => services[n], log: () => {}, provide: () => {} } as never)
  const r = svc.read('EURUSD', '1m')
  assert.equal(r.ok, true)
  if (!r.ok) return
  const core = readSignalCore(c, { tfSec: 60 })!
  assert.equal(r.signal.action, core.signal.action)
  assert.equal(r.signal.needle, core.signal.needle)
  assert.equal(r.price, c[c.length - 1].close) // no live price -> last close
})

test('the Signal service says why when history is too thin', () => {
  const services: Record<string, unknown> = { market: { getCandlesDeep: () => drift(20, 0.05), getPrice: () => 1, listAssets: () => [] }, regimescan: {} }
  const svc = new SignalService()
  void svc.start({ use: (n: string) => services[n], log: () => {}, provide: () => {} } as never)
  const r = svc.read('EURUSD', '1m')
  assert.equal(r.ok, false)
})

test('BACKTEST: a signal.* script replays on historical candles and each bar matches the core', () => {
  const c = drift(420, 0.05, 7)
  const t = Date.now()
  const r = backtestMslScript(c, SCRIPT, { expiryBars: 3, warmupBars: 80 })
  const ms = Date.now() - t
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(r.barsEvaluated > 300)
  assert.ok(r.trades.length > 0, 'a steady drift produces BUY calls to settle')
  // every fired bar must be a bar where the core, fed only candles[0..i], says the same thing
  for (const tr of r.trades.slice(0, 15)) {
    const core = readSignalCore(c.slice(0, (tr as { index: number }).index + 1))!
    assert.equal(core.signal.action === 'buy' ? 'call' : core.signal.action === 'sell' ? 'put' : 'none', (tr as { direction: string }).direction)
  }
  assert.ok(ms < 60_000, `backtest took ${ms}ms`)
})

test('NULL MARKET: signal.buy()/sell() on pure random walks settles near a coin flip (no invented edge)', () => {
  let trades = 0
  let wins = 0
  for (let seed = 1; seed <= 10; seed++) {
    const r = rng(seed * 7919)
    const c: Candle[] = []
    let p = 100
    for (let i = 0; i < 1000; i++) {
      const o = p
      p += (r() - 0.5) * 0.1
      c.push({ time: T0 + i * 60, open: o, high: Math.max(o, p) + 0.02, low: Math.min(o, p) - 0.02, close: p, volume: 10 })
    }
    const res = backtestMslScript(c, SCRIPT, { expiryBars: 3, warmupBars: 80 })
    assert.equal(res.ok, true)
    trades += res.trades.length
    wins += res.wins
  }
  assert.ok(trades >= 200, `only ${trades} trades - sample too small to judge`)
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
