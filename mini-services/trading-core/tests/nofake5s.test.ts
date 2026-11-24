import assert from 'node:assert/strict'
const { MarketDataService } = await import('../src/plugins/market-data')
const now = Math.floor(Date.now() / 1000), t0 = now - (now % 60) - 5 * 60
const bars = Array.from({ length: 6 }, (_, i) => ({ time: t0 + i * 60, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1 }))
;(globalThis as any).fetch = async (u: string) => ({ json: async () => String(u).includes('/price') ? { ok: true, price: 105.5 } : { ok: true, candles: bars } })
const m: any = new (MarketDataService as any)()
m.activeAsset = 'EURUSD'; m.ctx = { bus: { emit() {} }, log() {}, use() { return undefined } }
try { await m.pollLiveAsset('http://x', 'EURUSD', true) } catch (e) { console.log('threw', (e as Error).message) }
const n = (tf: string) => (m.closed?.get?.(m.key('EURUSD', tf)) ?? []).length
console.log('closed 5s', n('5s'), '15s', n('15s'), '30s', n('30s'), '1m', n('1m'), '5m', n('5m'))
assert.ok(n('1m') >= 5, '1m bars merged'); assert.ok(n('5s') <= 1, 'no 1m bar stamped as 5s bars')
console.log('ok')
