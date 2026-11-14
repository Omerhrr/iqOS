// Meta Trader + Omni Trader cooldowns: per-pair (cooldownSec) and global (globalCooldownSec).
//   npx tsx tests/cooldowns.test.ts      (from mini-services/trading-core)
import assert from 'node:assert/strict'
import { MetaTraderService } from '../src/plugins/metatrader'
import { OmniTraderService } from '../src/plugins/omnitrader'

const tests: Array<[string, () => Promise<void>]> = []
const test = (n: string, f: () => Promise<void>) => tests.push([n, f])

function harness(Svc: new () => any, cfg: Record<string, unknown>) {
  const assets = ['EURUSD', 'GBPUSD', 'AUDUSD'].map((t) => ({ ticker: t, open: true, otc: false }))
  const services: Record<string, any> = {
    market: { listAssets: () => assets, getCandlesDeep: () => [] },
    store: { getMetaTraderConfig: () => null, saveMetaTraderConfig: () => {}, getOmniTraderConfig: () => null, saveOmniTraderConfig: () => {}, listPositions: () => [] },
    mode: { status: () => ({ mode: 'auto' }) },
    metaStrategy: { evaluate: () => { throw new Error('should not be reached') } },
  }
  const ctx = { use: (n: string) => services[n] ?? {}, bus: { on: () => () => {} }, log: () => {}, provide: () => {} }
  const svc = new Svc()
  return { svc, ctx, cfg }
}
async function boot(Svc: new () => any, cfg: Record<string, unknown>) {
  const h = harness(Svc, cfg)
  try { await h.svc.start(h.ctx) } catch { /* restore() may touch stores we stub loosely */ }
  h.svc.stop()
  h.svc.configure({ enabled: true, ...cfg })
  return h.svc
}
const tickName = (s: any) => (s.omniTick ? 'omniTick' : 'metaTraderTick')

for (const [label, Svc] of [['meta', MetaTraderService], ['omni', OmniTraderService]] as const) {
  test(`${label}: globalCooldownSec defaults to 0 and is clamped / rounded from a patch`, async () => {
    const s = await boot(Svc as never, {})
    assert.equal(s.config.globalCooldownSec, 0)
    s.configure({ globalCooldownSec: -5 })
    assert.equal(s.config.globalCooldownSec, 0)
    s.configure({ globalCooldownSec: 12.4 })
    assert.equal(s.config.globalCooldownSec, 12)
  })
  test(`${label}: global cooldown blocks the whole tick after a trade, on any pair`, async () => {
    const s = await boot(Svc as never, { metaStrategyId: 'x', globalCooldownSec: 60, maxOpen: 5 })
    s.rt.lastTradeTs = Math.floor(Date.now() / 1000) - 10
    await s[tickName(s)]()
    assert.match(String(s.rt.lastRejection), /global cooldown: \d+s left/)
  })
  test(`${label}: global cooldown has expired -> the tick moves past the gate`, async () => {
    const s = await boot(Svc as never, { metaStrategyId: 'x', globalCooldownSec: 60, maxOpen: 5 })
    s.rt.lastTradeTs = Math.floor(Date.now() / 1000) - 61
    s.rt.lastRejection = undefined
    await s[tickName(s)]().catch(() => {})
    assert.doesNotMatch(String(s.rt.lastRejection ?? ''), /global cooldown/)
  })
  test(`${label}: globalCooldownSec 0 never blocks`, async () => {
    const s = await boot(Svc as never, { metaStrategyId: 'x', globalCooldownSec: 0, maxOpen: 5 })
    s.rt.lastTradeTs = Math.floor(Date.now() / 1000)
    s.rt.lastRejection = undefined
    await s[tickName(s)]().catch(() => {})
    assert.doesNotMatch(String(s.rt.lastRejection ?? ''), /global cooldown/)
  })
  test(`${label}: per-pair cooldown removes only that pair from the candidate pool`, async () => {
    const s = await boot(Svc as never, { metaStrategyId: 'x', cooldownSec: 60 })
    const now = Math.floor(Date.now() / 1000)
    s.assetCooldownUntil.set('EURUSD', now + 60)
    const pool: string[] = s.candidatePool()
    assert.ok(!pool.includes('EURUSD'))
    assert.ok(pool.includes('GBPUSD') && pool.includes('AUDUSD'))
    s.assetCooldownUntil.set('EURUSD', now - 1)
    assert.ok(s.candidatePool().includes('EURUSD'))
  })
}

void (async () => {
  let fail = 0
  for (const [n, f] of tests) { try { await f(); console.log('ok  ' + n) } catch (e) { fail++; console.log('FAIL ' + n + '\n    ' + (e as Error).message.slice(0, 400)) } }
  console.log(fail ? fail + ' FAILED' : 'all ' + tests.length + ' passed')
  process.exit(fail ? 1 : 0)
})()
