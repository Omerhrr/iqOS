import assert from 'node:assert/strict'
const { MarketDataService } = await import('../src/plugins/market-data')
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const mk = (over: Record<string, any>) => Object.assign(Object.create(MarketDataService.prototype), {
  activeAsset: 'BTCUSD', warnedPollCap: 0,
  store: { listBots: () => [{ bot: { enabled: true, watchlist: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'] } }] },
  ctx: { log: () => {}, use: (n: string) => over[n] },
})
test('a sub-minute script\'s pinned pairs come right after the charted pair, ahead of a long bot watchlist', () => {
  const m = mk({ metaTrader: { pinnedAssets: () => ['EURUSD', 'GBPUSD'], watchedAssets: () => ['ZZZ'] }, omniTrader: { pinnedAssets: () => ['EURUSD', 'USDJPY'] } }) as any
  const out = m.livePollAssets()
  assert.deepEqual(out.slice(0, 4), ['BTCUSD', 'EURUSD', 'GBPUSD', 'USDJPY']); assert.equal(out.length, 15)
})
test('without pins nothing changes (charted first, then bots)', () => {
  const out = (mk({}) as any).livePollAssets(); assert.equal(out[0], 'BTCUSD'); assert.equal(out[1], 'A1')
})
const { ModeService } = await import('../src/plugins/os-mode')
const { AutopilotService } = await import('../src/plugins/autopilot')
const assets = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD', 'BTCUSD', 'ETHUSD', 'NZDUSD', 'EURGBP', 'AAA', 'ZZZ'].map((ticker) => ({ ticker, open: true }))
const ctxFor = (needs: boolean) => ({ use: (n: string) => (n === 'market' ? { assets } : { needsSubMinute: () => needs }) })
const auto = (cfg: any, needs: boolean) => Object.assign(Object.create(ModeService.prototype), { config: { enabled: true, watchlist: [], watchlistMode: 'only', strategyIds: [], ...cfg }, ctx: ctxFor(needs) })
test('Auto Trader: sub-minute meta strategy -> stable liquid-first pins (max 6)', () => {
  const a = auto({ signalSource: 'meta-strategy', metaStrategyId: 'meta:x' }, true) as any
  assert.deepEqual(a.pinnedAssets(), ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD', 'BTCUSD'])
  assert.deepEqual((auto({ signalSource: 'meta-strategy', metaStrategyId: 'meta:x' }, false) as any).pinnedAssets(), [])
})
test('Auto Trader: pool members, watchlist and non-meta sources', () => {
  assert.equal((auto({ signalSource: 'strategy', strategyIds: ['rsi', 'meta:x'] }, true) as any).pinnedAssets().length, 6)
  assert.deepEqual((auto({ signalSource: 'strategy', strategyIds: ['rsi'] }, true) as any).pinnedAssets(), [])
  assert.deepEqual((auto({ signalSource: 'meta-strategy', metaStrategyId: 'meta:x', watchlist: ['ZZZ', 'AAA', 'ETHUSD'] }, true) as any).pinnedAssets(), ['AAA', 'ETHUSD', 'ZZZ'])
  assert.deepEqual((auto({ signalSource: 'oracle-fusion' }, true) as any).pinnedAssets(), [])
})
const bot = (id: string, watchlist: string[], strategyId = 'meta:x') => ({ id, enabled: true, tf: '1m', strategyId, watchlist, universeSweep: false })
const bots = (list: any[], needs: boolean, calls: string[], trades: Record<string, number>) => Object.assign(Object.create(AutopilotService.prototype), {
  store: { listBots: () => list.map((bot) => ({ bot })) }, meta: { needsSubMinute: () => needs }, evaluating: new Set(), subMinuteDone: new Map(),
  runtime: new Map(list.map((b) => [b.id, { trades: trades[b.id] ?? 0 }])),
  tradeForBot: async (b: any, asset: string) => { calls.push(`${b.id}:${asset}`); if (trades.fire) (bots as any).rt.get(b.id).trades++ },
  reject: () => {},
})
test('bots: pinned = first 6 of each sub-minute bot watchlist, none for other strategies', () => {
  const b = bots([bot('a', ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']), bot('b', ['E2', 'X1'])], true, [], {}) as any
  assert.deepEqual(b.pinnedAssets(), ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'X1'])
  assert.deepEqual((bots([bot('a', ['E1'])], false, [], {}) as any).pinnedAssets(), [])
  assert.deepEqual((bots([bot('a', ['E1'], 'rsi')], true, [], {}) as any).pinnedAssets(), [])
})
test('bots: the mid-candle sweep runs a sub-minute bot only inside the candle, and stops after a trade that bar', async () => {
  const realNow = Date.now
  const calls: string[] = []; const b = bots([bot('a', ['E1', 'E2'])], true, calls, {}) as any
  try {
    Date.now = () => 1_800_000_000_000 - (1_800_000_000_000 % 60_000) + 5_000 // 8% into the bar
    await b.subMinuteSweep(); assert.deepEqual(calls, [])
    Date.now = () => 1_800_000_000_000 - (1_800_000_000_000 % 60_000) + 40_000 // 67% into the bar
    await b.subMinuteSweep(); assert.deepEqual(calls, ['a:E1', 'a:E2'])
    b.tradeForBot = async (bb: any, asset: string) => { calls.push(`T${asset}`); b.runtime.get(bb.id).trades++ } // now it trades
    calls.length = 0; await b.subMinuteSweep(); assert.deepEqual(calls, ['TE1', 'TE2'])
    calls.length = 0; await b.subMinuteSweep(); assert.deepEqual(calls, []) // already traded these pairs this bar
  } finally { Date.now = realNow }
})
await new Promise((r) => setTimeout(r, 50))
console.log(`${pass}/${total}`)
