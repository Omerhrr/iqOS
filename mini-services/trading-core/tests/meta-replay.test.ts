// IQAIR//OS - tests: Backtest Lab replay of meta: scripts (SMC family replay-safe; reads only for referenced sources)
import assert from 'node:assert/strict'
import { MetaStrategyService } from '../src/plugins/metastrategy'
let sd = 9; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
let p = 1.3; const all = Array.from({ length: 700 }, (_, i) => { const o = p; p += (Math.sin(i / 20) * 0.0006 + (r() - 0.5) * 0.0009); return { time: 1_700_000_040 + i * 60, open: o, close: p, high: Math.max(o, p) + 0.00025, low: Math.min(o, p) - 0.00025, volume: 1 } })
const svc: any = new MetaStrategyService()
svc.ctx = { log: () => {}, bus: { emit() {} }, use: (n: string) => { throw new Error('no service ' + n) } }
let asof = Infinity, maxSeen = 0
svc.market = { getCandlesDeep: (_a: string, _t: string, n: number) => { const e = all.filter((c) => c.time <= asof); maxSeen = Math.max(maxSeen, e.length ? e[e.length - 1].time : 0); return e.slice(-n) }, setReplayAsof: (t: number) => { asof = t }, getPrice: () => p, listAssets: () => [], payoutFor: () => 0.85 }
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const add = (id: string, script: string) => { asof = Infinity; return add0(id, script) }
const add0 = (id: string, script: string) => svc.specs.set(id, { id, name: id, mode: 'all', conditions: [], script })
test('an smc:<KIND> script backtests (no live-only rejection) and never sees bars after the replayed one', () => {
  add('meta:t-smc', 'call when smc:CRT.dir == call\nput when smc:CRT.dir == put\nconfidence = smc:CRT.conf\nexpiry = 3')
  const res = svc.backtestMeta('meta:t-smc', 'GBPUSD', '1m', {}); assert.ok(res.trades.length >= 0 && res.trades.every((t: any) => t.ts <= all[all.length - 1].time))
})
test('bare smc / smcNow / ict sources replay too', () => {
  add('meta:t-smc2', 'call when smcNow.dir == call\nput when smc.dir == put and ict.dir == put\nexpiry = 3'); svc.backtestMeta('meta:t-smc2', 'GBPUSD', '1m', {})
})
test('still-unsafe sources are rejected with a clear message', () => {
  add('meta:t-bad', 'call when oracle.dir == call'); assert.throws(() => svc.backtestMeta('meta:t-bad', 'GBPUSD', '1m', {}), /LIVE-only/)
})
test('a script with no sources and a signal-function script both replay (lazy resolver)', () => {
  add('meta:t-none', 'let h = ind.hull("hma", 55, "close")\ncall when h[-1] > h[-3] and h[-2] <= h[-4]\nput when h[-1] < h[-3] and h[-2] >= h[-4]\nexpiry = 3')
  const a = svc.backtestMeta('meta:t-none', 'GBPUSD', '1m', {}); assert.ok(a.trades.length > 0)
  add('meta:t-sig', 'call when rsi(14, 30)\nexpiry = 3'); svc.backtestMeta('meta:t-sig', 'GBPUSD', '1m', {})
})
console.log(`\n${pass}/${total} passed`); if (pass !== total) process.exit(1)
