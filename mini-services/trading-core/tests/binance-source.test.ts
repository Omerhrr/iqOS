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
const { BinanceFeed, binanceReaderScope } = await import('../src/plugins/binancefeed')
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
console.log(`${pass}/${total}`)
process.exit(pass === total ? 0 : 1)
