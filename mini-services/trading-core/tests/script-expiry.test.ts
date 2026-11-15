// A script's own `expiry = <minutes>`: honored by the backtester (scriptExpiry) and, when useScriptExpiry is on, by Meta Trader and Omni Trader orders.
//   npx tsx tests/script-expiry.test.ts      (from mini-services/trading-core)
import assert from 'node:assert/strict'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { MetaTraderService } from '../src/plugins/metatrader'
import { OmniTraderService } from '../src/plugins/omnitrader'

const tests: Array<[string, () => Promise<void>]> = []
const test = (n: string, f: () => Promise<void>) => tests.push([n, f])
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5) }
const ou = (n: number, k: number, seed: number) => {
  const r = rng(seed); const c: any[] = []; let x = 1.1
  for (let i = 0; i < n; i++) { const o = x; x += k * (1.1 - x) + r() * 0.0016; c.push({ time: 1.7e9 + i * 60, open: o, high: Math.max(o, x) + 1e-4, low: Math.min(o, x) - 1e-4, close: x, volume: 10 }) }
  return c
}
const script = (e: string) => `if ou.ok() and ou.z() >= 1.5 and ind.rsi(14)[-1] > 60
  put when true
  confidence = 58
  ${e}
elseif ou.ok() and ou.z() <= -1.5 and ind.rsi(14)[-1] < 40
  call when true
  confidence = 58
  ${e}
end`

test('backtest: scriptExpiry settles each fire at the expiry the script set (minutes -> bars)', async () => {
  const c = ou(1500, 0.25, 3)
  const r = backtestMslScript(c, script('expiry = 2'), { expiryBars: 5, warmupBars: 130, scriptExpiry: { barSeconds: 60 } })
  assert.ok(r.trades.length > 20)
  assert.ok(r.trades.every((t) => t.expiryBars === 2))
  const t = r.trades[0]
  assert.equal(t.exit, c[t.index + 2].close)
  // 5-minute bars: expiry = 10 minutes -> 2 bars
  const r5 = backtestMslScript(c, script('expiry = 10'), { expiryBars: 1, warmupBars: 130, scriptExpiry: { barSeconds: 300 } })
  assert.ok(r5.trades.every((t) => t.expiryBars === 2))
})
test('backtest: without scriptExpiry the script expiry is ignored (unchanged behavior)', async () => {
  const c = ou(1500, 0.25, 3)
  const a = backtestMslScript(c, script('expiry = 2'), { expiryBars: 3, warmupBars: 130 })
  const b = backtestMslScript(c, script(''), { expiryBars: 3, warmupBars: 130 })
  assert.equal(a.trades.length, b.trades.length)
  assert.equal(a.wins, b.wins)
  assert.ok(a.trades.every((t) => t.expiryBars === undefined))
})
test('backtest: a fire whose script set no expiry falls back to expiryBars', async () => {
  const c = ou(1500, 0.25, 3)
  const r = backtestMslScript(c, script(''), { expiryBars: 4, warmupBars: 130, scriptExpiry: { barSeconds: 60 } })
  assert.ok(r.trades.length > 20 && r.trades.every((t) => t.expiryBars === undefined && t.exit === c[t.index + 4].close))
})
test('backtest: a half-life-driven expiry varies per fire', async () => {
  const c = ou(3000, 0.06, 7)
  const r = backtestMslScript(c, script('expiry = max(1, min(15, round(1.5 * ou.halfLife())))'), { expiryBars: 3, warmupBars: 130, scriptExpiry: { barSeconds: 60 } })
  const set = new Set(r.trades.map((t) => t.expiryBars))
  assert.ok(r.trades.length > 30 && set.size > 1, `distinct expiries ${[...set]}`)
})

test('walk-forward: scriptExpiry settles per fire and folds still partition the trades', async () => {
  const { backtestMslScriptWalkForward } = await import('../src/analytics/mslbacktest')
  const c = ou(1500, 0.25, 3)
  const wf = backtestMslScriptWalkForward(c, script('expiry = 2'), { expiryBars: 5, warmupBars: 130, folds: 4, scriptExpiry: { barSeconds: 60 } })
  assert.ok(wf.ok && wf.overall.trades > 20)
  assert.equal(wf.folds.reduce((a, f) => a + f.trades, 0), wf.overall.trades)
  const plain = backtestMslScript(c, script('expiry = 2'), { expiryBars: 5, warmupBars: 130, scriptExpiry: { barSeconds: 60 } })
  assert.equal(wf.overall.trades, plain.trades.length)
  assert.equal(wf.overall.wins, plain.wins)
  const off = backtestMslScriptWalkForward(c, script('expiry = 2'), { expiryBars: 5, warmupBars: 130, folds: 4 })
  assert.notEqual(off.overall.wins, wf.overall.wins)
})

for (const [label, Svc, tfOf] of [['meta', MetaTraderService, 'metaTrader'], ['omni', OmniTraderService, 'omniTrader']] as const) {
  const make = async (cfg: Record<string, unknown>, kind: string) => {
    const placed: any[] = []
    const services: Record<string, any> = {
      market: { listAssets: () => [], getCandlesDeep: () => [] },
      store: { getMetaTraderConfig: () => null, saveMetaTraderConfig: () => {}, getOmniTraderConfig: () => null, saveOmniTraderConfig: () => {}, listPositions: () => [] },
      mode: { status: () => ({ mode: 'auto' }) },
      execution: { accountSource: 'paper', placeOrder: async (req: any) => { placed.push(req); return { ok: true } } },
    }
    const svc: any = new Svc()
    try { await svc.start({ use: (n: string) => services[n] ?? {}, bus: { on: () => () => {} }, log: () => {}, provide: () => {} } as any) } catch { /* loose stubs */ }
    svc.stop()
    svc.ctx = { use: (n: string) => services[n] ?? {}, bus: { on: () => () => {} }, log: () => {} }
    svc.configure({ tf: '1m', kind, expirySec: 30, ...cfg })
    return { svc, placed }
  }
  const row = (expiryMin?: number) => ({ asset: 'EURUSD', name: 'EURUSD', category: 'forex', otc: false, price: 1.1, direction: 'put', confidence: 60, note: 'x', ...(expiryMin !== undefined ? { expiryMin } : {}) })
  test(`${label}: off by default - the script's expiry does not change the order`, async () => {
    const { svc, placed } = await make({}, 'binary')
    assert.equal(svc.config.useScriptExpiry, false)
    await svc.place(row(5))
    assert.equal(placed[0].expiryBars, 1)
  })
  test(`${label}: on - a binary order uses the script's minutes as bars of the signal tf`, async () => {
    const { svc, placed } = await make({ useScriptExpiry: true }, 'binary')
    await svc.place(row(5))
    assert.equal(placed[0].expiryBars, 5)
  })
  test(`${label}: on - a signal whose script set no expiry keeps the fixed expiry`, async () => {
    const { svc, placed } = await make({ useScriptExpiry: true }, 'binary')
    await svc.place(row(undefined))
    assert.equal(placed[0].expiryBars, 1)
  })
  test(`${label}: on - blitz is capped at 60s, digital uses the minutes in seconds`, async () => {
    const b = await make({ useScriptExpiry: true }, 'blitz'); await b.svc.place(row(5)); assert.equal(b.placed[0].expirySec, 60)
    const d = await make({ useScriptExpiry: true }, 'digital'); await d.svc.place(row(5)); assert.equal(d.placed[0].expirySec, 300)
  })
  void tfOf
}

void (async () => {
  let fail = 0
  for (const [n, f] of tests) { try { await f(); console.log('ok  ' + n) } catch (e) { fail++; console.log('FAIL ' + n + '\n    ' + (e as Error).message.slice(0, 400)) } }
  console.log(fail ? fail + ' FAILED' : 'all ' + tests.length + ' passed')
  process.exit(fail ? 1 : 0)
})()
