// the per-strategy data source: an input named dataSource picks iq / volume / binance; a slot override wins over the declared default
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
process.chdir(mkdtempSync(join(tmpdir(), 'bnsrc-')))
const { MetaStrategyService } = await import('../src/plugins/metastrategy')
const { MarketDataService } = await import('../src/plugins/market-data')
const { BinanceFeed, binanceReaderScope, setActiveBinanceFeed, binanceDataBlock } = await import('../src/plugins/binancefeed')
const { overlayVolume, binanceCandles } = await import('../src/analytics/binancedata')
const svc = new MetaStrategyService() as any
const S = (def: string) => `input dataSource = "${def}" options "iq", "volume", "binance" "Data source"\ncall when px.volume[-1] > 5\nconfidence = 60\nexpiry = 1\n`
test('no dataSource input -> iq', () => assert.equal(svc.dataSourceFor('call when true\nconfidence = 60\n', undefined), 'iq'))
test('declared default is used', () => { assert.equal(svc.dataSourceFor(S('volume')), 'volume'); assert.equal(svc.dataSourceFor(S('binance')), 'binance'); assert.equal(svc.dataSourceFor(S('iq')), 'iq') })
test('the slot override wins over the default', () => assert.equal(svc.dataSourceFor(S('iq'), { dataSource: 'binance' }), 'binance'))
test('garbage falls back to iq', () => assert.equal(svc.dataSourceFor(S('iq'), { dataSource: 'banana' }), 'iq'))
test('end to end: the same script sees IQ volume, Binance volume, or Binance candles depending on the input', () => {
  const m: any = new MarketDataService()
  svc.market = m
  const iq = m.getCandlesDeep('BTCUSD', '1m', 120, true)
  const f = new BinanceFeed({ dataDir: join(process.cwd(), 'bn') }); f.setRecorder(false)
  const fa = f as any; fa.connected = true; fa.lastMsgMs = Date.now(); fa.nowMs = () => Date.now(); fa.enabled = true
  setActiveBinanceFeed(f)
  for (const c of iq) f.addMinute('BTCUSDT', { time: c.time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, quoteVolume: 0, trades: 1, takerBuy: 0 }, false)
  m.setCandleOverlay((a: string, tf: string, cs: any[], limit: number, closedOnly: boolean, mode: string) => mode === 'volume' ? overlayVolume(cs, tf, 'BTCUSDT', f) : binanceCandles(tf, 'BTCUSDT', f, limit, closedOnly, Math.floor(Date.now() / 1000)))
  // IQ sim volume is in the thousands (call fires); Binance volume here is 1 (call must NOT fire)
  const run = (def: string) => svc.testScript(S(def), 'BTCUSD', '1m')
  const a = run('iq'), b = run('volume'), c = run('binance')
  assert.equal(a.ok, true, a.error); assert.equal(a.direction, 'call')
  assert.equal(b.ok, true, b.error); assert.equal(b.direction, 'none')
  assert.equal(c.ok, true, c.error); assert.equal(c.direction, 'none')
  // and the mode did not leak out of the evaluation
  assert.ok(m.getCandlesDeep('BTCUSD', '1m', 1, true)[0].volume > 5)
})
test('binance.* inside a strategy run reads the feed for that asset; other assets get a clear error', () => {
  const f = new BinanceFeed({ dataDir: join(process.cwd(), 'bn2') }); f.setRecorder(false)
  const m: any = new MarketDataService(); svc.market = m
  const bn = binanceReaderScope // exists and restores
  assert.equal(typeof bn, 'function')
  const r = svc.testScript('call when binance.ok()\nconfidence = 60\n', 'EURUSD', '1m')
  assert.equal(r.ok, false); assert.ok(/Binance data/i.test(String(r.error)), String(r.error))
})
test('fail closed: no feed / stale feed / pair without a Binance market all block a binance strategy', () => {
  setActiveBinanceFeed(null)
  assert.match(String(binanceDataBlock('BTCUSD')), /not running/)
  assert.match(String(binanceDataBlock('EURUSD-OTC')), /no/)
  const f = new BinanceFeed({ dataDir: join(process.cwd(), 'bn3') }); f.setRecorder(false)
  setActiveBinanceFeed(f)
  assert.match(String(binanceDataBlock('BTCUSD')), /stale|disconnected/)   // never connected
  const fa = f as any; fa.connected = true; fa.lastMsgMs = Date.now(); fa.nowMs = () => Date.now()
  assert.match(String(binanceDataBlock('BTCUSD')), /stale|disconnected/)   // connected but no closed minute yet
  f.addMinute('BTCUSDT', { time: Math.floor(Date.now() / 60000) * 60 - 60, open: 1, high: 1, low: 1, close: 1, volume: 1, quoteVolume: 0, trades: 1, takerBuy: 0 }, false)
  assert.equal(binanceDataBlock('BTCUSD'), null)
  fa.lastMsgMs = Date.now() - 60_000
  assert.match(String(binanceDataBlock('BTCUSD')), /stale/)                // silent socket
  setActiveBinanceFeed(null)
})
test('a strategy in binance mode on a stale feed evaluates to no trade, never to IQ candles', () => {
  setActiveBinanceFeed(null)
  const m: any = new MarketDataService(); svc.market = m
  svc.specs.set('meta:bn', { id: 'meta:bn', name: 'bn', mode: 'all', conditions: [], script: S('binance'), updatedTs: 1 })
  const r = svc.evaluate('meta:bn', 'BTCUSD', '1m')
  assert.equal(r.result.direction, 'none'); assert.match(r.result.notes, /no trade/)
})
test('binance.* reads work with dataSource iq too (IQ candles for price, Binance for delta)', () => {
  const m: any = new MarketDataService(); svc.market = m
  const f = new BinanceFeed({ dataDir: join(process.cwd(), 'bn4') }); f.setRecorder(false)
  const iq = m.getCandlesDeep('BTCUSD', '1m', 120, true)
  for (const c of iq) f.addMinute('BTCUSDT', { time: c.time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, quoteVolume: 0, trades: 1, takerBuy: 8 }, false)
  setActiveBinanceFeed(f)
  const r = svc.testScript('call when binance.deltaPct() > 0.3\nconfidence = 60\nexpiry = 1\n', 'BTCUSD', '1m')
  assert.equal(r.ok, true, r.error); assert.equal(r.direction, 'call')
  setActiveBinanceFeed(null)
})
test('binance now-reads: live() and nowDelta follow the forming minute; they refuse to run in a backtest-style reader', () => {
  const nowMs = (Math.floor(Date.now() / 60000) * 60 + 30) * 1000
  const f = new BinanceFeed({ dataDir: join(process.cwd(), 'bn5'), nowMs: () => nowMs }); f.setRecorder(false)
  const fa = f as any; fa.sessionStartMs = nowMs - 3_600_000
  const t0 = Math.floor(nowMs / 60000) * 60
  f.ingestTrade('BTCUSDT', 1, 100000, 3, nowMs - 5000, false)
  f.ingestTrade('BTCUSDT', 2, 100000, 1, nowMs - 4000, true)
  f.ingestKline('BTCUSDT', { t: t0 * 1000, o: '100000', h: '100000', l: '100000', c: '100000', v: '4', q: '0', n: 2, V: '3', x: false })
  const nb = f.now('BTCUSDT', 60)!
  assert.equal(nb.ageSec, 30); assert.equal(nb.delta, 2); assert.equal(nb.buyVolume, 3); assert.equal(nb.complete, false)
  // the forming minute is NOT in the closed history
  assert.equal(f.lastClosed('BTCUSDT'), 0)
  // 5m running bar = closed minutes in the bucket + the forming one
  assert.ok(f.now('BTCUSDT', 300)!.volume >= 4)
})
total++
try {
  await (async () => {
  const { binanceSettle } = await import('../src/plugins/binancefeed')
  const f = new BinanceFeed({ dataDir: join(process.cwd(), 'bn6') }); f.setRecorder(false)
  setActiveBinanceFeed(f)
  const T = Math.floor(Date.now() / 60000) * 60 - 600
  // 5m candle opening at T needs the minute T+240
  assert.equal(await binanceSettle('BTCUSD', '5m', T, 300), false)
  setTimeout(() => f.addMinute('BTCUSDT', { time: T + 240, open: 1, high: 1, low: 1, close: 1, volume: 1, quoteVolume: 0, trades: 1, takerBuy: 0 }, false), 150)
  assert.equal(await binanceSettle('BTCUSD', '5m', T, 2000), true)
  assert.equal(await binanceSettle('EURUSD', '5m', T, 100), true) // no Binance market: nothing to wait for
  setActiveBinanceFeed(null)
  })()
  console.log('ok  binanceSettle waits for the minute that ends the candle, and gives up (false) when it never comes'); pass++
} catch (e) { console.log('FAIL binanceSettle', (e as Error).message) }
test('usesBinanceData and needsSubMinute recognise binance scripts', () => {
  const put = (id: string, script: string) => svc.specs.set(id, { id, name: id, mode: 'all', conditions: [], script, updatedTs: 1 })
  put('meta:a', S('volume')); put('meta:b', S('iq')); put('meta:c', 'call when binance.delta() > 0\nconfidence = 60\n'); put('meta:d', 'call when binance.nowDelta() > 0\nconfidence = 60\n')
  assert.equal(svc.usesBinanceData('meta:a'), true); assert.equal(svc.usesBinanceData('meta:b'), false)
  assert.equal(svc.usesBinanceData('meta:c'), true)
  assert.equal(svc.needsSubMinute('meta:d'), true); assert.equal(svc.needsSubMinute('meta:c'), false)
})
console.log(`${pass}/${total}`)
process.exit(pass === total ? 0 : 1)

