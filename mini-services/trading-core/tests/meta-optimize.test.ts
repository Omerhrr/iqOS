// IQAIR//OS - tests: meta: strategies in Optimizer / Walk-Forward / Asset Sweep (strategy engine bridge)
import assert from 'node:assert/strict'
import { MetaStrategyService } from '../src/plugins/metastrategy'
import { gridSearch, walkForward, sweepAssets } from '../src/strategies/optimize'
import { backtest, setMetaDefResolver } from '../src/strategies/backtest'
let sd = 9; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
let p = 1.3; const all = Array.from({ length: 1300 }, (_, i) => { const o = p; p += (Math.sin(i / 20) * 0.0006 + (r() - 0.5) * 0.0009); return { time: 1_700_000_040 + i * 60, open: o, close: p, high: Math.max(o, p) + 0.00025, low: Math.min(o, p) - 0.00025, volume: 1 } })
const svc: any = new MetaStrategyService()
svc.ctx = { log: () => {}, bus: { emit() {} }, use: (n: string) => { throw new Error('no service ' + n) } }
let asof = Infinity
svc.market = { getCandlesDeep: (_a: string, _t: string, n: number) => all.filter((c) => c.time <= asof).slice(-n), setReplayAsof: (t: number | null) => { asof = t ?? Infinity }, getPrice: () => p, listAssets: () => [], payoutFor: () => 0.85 }
svc.libPath = '/tmp/ms_opt.json'; svc.persist = () => {}
setMetaDefResolver((id) => svc.asStrategyDef(id))
svc.specs.set('meta:t-hull', { id: 'meta:t-hull', name: 'hull', mode: 'all', conditions: [], script: 'let h = ind.hull("hma", 21, "close")\ncall when h[-1] > h[-3] and h[-2] <= h[-4]\nput when h[-1] < h[-3] and h[-2] >= h[-4]\nexpiry = 3' })
svc.specs.set('meta:t-bad', { id: 'meta:t-bad', name: 'bad', mode: 'all', conditions: [], script: 'call when oracle.dir == call' })
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const cs = all.slice(0, 900)
test('Single engine backtest() runs a meta: id and trades', () => { const b = backtest(cs, 'GBPUSD', '1m', { strategy: 'meta:t-hull', expiryBars: 1 }); assert.ok(b.trades.length > 5, String(b.trades.length)) })
test('Optimizer (gridSearch) runs a meta: strategy', () => { const g = gridSearch(cs, 'GBPUSD', '1m', { strategy: 'meta:t-hull', sweep: {}, minTrades: 5, maxCombos: 10, expiryBars: 1 } as any); assert.ok(g.evaluated >= 1 && g.best !== null, JSON.stringify(g).slice(0, 200)) })
test('Walk-Forward runs a meta: strategy', () => { const w = walkForward(cs, 'GBPUSD', '1m', { strategy: 'meta:t-hull', sweep: {}, fixedParams: {}, minTrades: 3, maxCombos: 10, folds: 2, isRatio: 0.7, expiryBars: 1 } as any); assert.ok(w.folds.length >= 1) })
test('Asset Sweep runs a meta: strategy', () => {
  const out = sweepAssets([{ ticker: 'GBPUSD', category: 'forex', open: true, payout: 0.85 }, { ticker: 'EURUSD', category: 'forex', open: true, payout: 0.85 }], () => all.slice(0, 900), '1m', { strategy: 'meta:t-hull', minTrades: 3, expiryBars: 1 } as any)
  assert.ok(out.rows.length >= 1, JSON.stringify(out).slice(0, 200))
})
test('a live-only meta source fails with the clear message', () => { assert.throws(() => backtest(cs, 'GBPUSD', '1m', { strategy: 'meta:t-bad' }), /LIVE-only/); assert.throws(() => backtest(cs, 'GBPUSD', '1m', { strategy: 'meta:nope' }), /Unknown strategy/) })
console.log(`\n${pass}/${total} passed`); if (pass !== total) process.exit(1)
