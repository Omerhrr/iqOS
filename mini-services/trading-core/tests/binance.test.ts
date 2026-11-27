// IQAIR//OS - tests for the Binance feed model: aggressor-tagged footprint, minute alignment, closed-only reads,
// volume overlay on IQ candles, the full-Binance candle mode and the MSL binance.* reads.
import assert from 'node:assert/strict'
import { BinanceFeed } from '../src/plugins/binancefeed'
import { aggAt, aggregateMinutes, binanceCandles, overlayVolume, binanceSymbolFor, modeFromNumber, type BinanceMinute } from '../src/analytics/binancedata'
import { parseStrategyScript, evaluateStrategyScript, setBinanceReader } from '../src/analytics/strategylang'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`)
const T0 = Math.floor(1_700_000_000 / 3600) * 3600 // an hour boundary
const SYM = 'BTCUSDT'
const kline = (i: number, o: number, c: number, v: number, V: number) => ({ t: (T0 + i * 60) * 1000, o: String(o), h: String(Math.max(o, c) + 5), l: String(Math.min(o, c) - 5), c: String(c), v: String(v), q: String(v * c), n: 10, V: String(V), x: true })
const mkFeed = () => { const f = new BinanceFeed({ dataDir: '/tmp/bn-test-' + Math.random().toString(36).slice(2), nowMs: () => (T0 + 4000) * 1000 }); f.setRecorder(false); return f }

test('symbol map: BTCUSD/ETHUSD only, never OTC', () => {
  assert.equal(binanceSymbolFor('BTCUSD'), 'BTCUSDT'); assert.equal(binanceSymbolFor('ethusd'), 'ETHUSDT')
  assert.equal(binanceSymbolFor('EURUSD-OTC'), undefined); assert.equal(binanceSymbolFor('BTCUSD-OTC'), undefined)
})
test('mode numbers', () => { assert.equal(modeFromNumber(0), 'iq'); assert.equal(modeFromNumber(1), 'volume'); assert.equal(modeFromNumber(2), 'binance') })

test('trade -> footprint: buyer-is-maker = SELL aggressor, ladder sums to kline volume, true delta and POC', () => {
  const f = mkFeed()
  const base = (T0 + 60) * 1000
  // session started before this minute so it counts as complete
  ;(f as unknown as { sessionStartMs: number }).sessionStartMs = T0 * 1000
  f.ingestTrade(SYM, 1, 100003, 2, base + 100, false)  // buy 2 @ 100000 bin
  f.ingestTrade(SYM, 2, 100004, 1, base + 200, true)   // sell 1 @ 100000 bin
  f.ingestTrade(SYM, 3, 100021, 1, base + 300, true)   // sell 1 @ 100020 bin
  f.ingestKline(SYM, kline(1, 100000, 100020, 4, 2))
  const m = f.range(SYM, T0 + 60, T0 + 120)[0]
  assert.ok(m.foot && m.footComplete)
  const a = aggAt(f, SYM, T0 + 60, 60)!
  near(a.buyVolume, 2); near(a.sellVolume, 2); near(a.delta, 0)
  assert.equal(a.poc, 100000); assert.equal(a.footShare, 1)
})
test('a hole in the trade ids marks the ladder incomplete; delta falls back to the kline taker split', () => {
  const f = mkFeed()
  ;(f as unknown as { sessionStartMs: number }).sessionStartMs = T0 * 1000
  const base = (T0 + 60) * 1000
  f.ingestTrade(SYM, 10, 100000, 1, base + 1, false)
  f.ingestTrade(SYM, 12, 100000, 1, base + 2, false) // id 11 is missing
  f.ingestKline(SYM, kline(1, 100000, 100010, 3, 1))
  const a = aggAt(f, SYM, T0 + 60, 60)!
  assert.equal(a.footShare, 0)
  near(a.buyVolume, 1); near(a.sellVolume, 2); near(a.delta, -1) // taker split: buy 1 of 3
})
test('a ladder that does not add up to the kline volume is not trusted', () => {
  const f = mkFeed()
  ;(f as unknown as { sessionStartMs: number }).sessionStartMs = T0 * 1000
  f.ingestTrade(SYM, 1, 100000, 1, (T0 + 60) * 1000 + 5, false)
  f.ingestKline(SYM, kline(1, 100000, 100010, 5, 2)) // kline says 5, ladder saw 1
  assert.equal(f.range(SYM, T0 + 60, T0 + 120)[0].footComplete, false)
})
test('a minute that started before the socket connected is never complete', () => {
  const f = mkFeed()
  ;(f as unknown as { sessionStartMs: number }).sessionStartMs = (T0 + 90) * 1000
  f.ingestTrade(SYM, 1, 100000, 1, (T0 + 60) * 1000 + 5, false)
  f.ingestKline(SYM, kline(1, 100000, 100010, 1, 1))
  assert.equal(f.range(SYM, T0 + 60, T0 + 120)[0].footComplete, false)
})
test('a forming kline (x=false) is ignored: nothing is stored', () => {
  const f = mkFeed()
  f.ingestKline(SYM, { ...kline(1, 1, 2, 3, 1), x: false })
  assert.equal(f.lastClosed(SYM), 0)
})
test('handleMessage parses combined-stream frames', () => {
  const f = mkFeed()
  ;(f as unknown as { sessionStartMs: number }).sessionStartMs = T0 * 1000
  f.handleMessage(JSON.stringify({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', s: SYM, a: 1, p: '100000', q: '1.5', T: (T0 + 60) * 1000 + 9, m: false } }))
  const k = kline(1, 100000, 100001, 1.5, 1.5)
  f.handleMessage(JSON.stringify({ stream: 'btcusdt@kline_1m', data: { e: 'kline', s: SYM, k } }))
  f.handleMessage('not json')
  assert.equal(f.lastClosed(SYM), T0 + 60)
})

const fill = (f: BinanceFeed, from: number, count: number, vol = (i: number) => 10 + i) => {
  for (let i = from; i < from + count; i++) f.addMinute(SYM, { time: T0 + i * 60, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: vol(i), quoteVolume: 0, trades: 1, takerBuy: vol(i) * 0.75 }, false)
}
test('aggregate: 5 minutes -> one 5m bar (O first, C last, H max, L min, V sum), complete only with all 5', () => {
  const f = mkFeed(); fill(f, 0, 5)
  const a = aggAt(f, SYM, T0, 300)!
  assert.equal(a.open, 100); near(a.close, 104.5); assert.equal(a.high, 105); assert.equal(a.low, 99)
  near(a.volume, 10 + 11 + 12 + 13 + 14); assert.equal(a.complete, true)
  const f2 = mkFeed(); fill(f2, 0, 4)
  assert.equal(aggAt(f2, SYM, T0, 300)!.complete, false)
})
test('overlayVolume keeps IQ price, replaces volume by the minute sum; an incomplete candle gets 0 = no data', () => {
  const f = mkFeed(); fill(f, 0, 7) // minutes 0..6 held
  const iq = [{ time: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }, { time: T0 + 300, open: 1.5, high: 3, low: 1, close: 2, volume: 0 }]
  const out = overlayVolume(iq, '5m', SYM, f)
  assert.equal(out[0].close, 1.5); near(out[0].volume, 60)   // IQ's own close, Binance volume
  assert.equal(out[1].volume, 0)                               // minutes 5,6 only -> not complete
})
test('overlay is aligned to the candle grid: a candle at +60s must not pick the neighbour minute', () => {
  const f = mkFeed(); fill(f, 0, 3, (i) => [100, 200, 400][i])
  const out = overlayVolume([{ time: T0 + 60, open: 0, high: 0, low: 0, close: 0, volume: 0 }], '1m', SYM, f)
  assert.equal(out[0].volume, 200)
})
test('binanceCandles: whole closed candles only, newest not beyond the last closed minute', () => {
  const f = mkFeed(); fill(f, 0, 13) // 13 minutes: two full 5m bars (0-4, 5-9), minutes 10..12 partial
  const c = binanceCandles('5m', SYM, f, 10, true, T0 + 13 * 60)
  assert.deepEqual(c.map((x) => x.time), [T0, T0 + 300])
  const withForming = binanceCandles('5m', SYM, f, 10, false, T0 + 13 * 60)
  assert.equal(withForming[withForming.length - 1].time, T0 + 600)  // the partial bar is last
})
test('no look-ahead: results for bar k do not change when later minutes arrive', () => {
  const f = mkFeed(); fill(f, 0, 6)
  const before = aggAt(f, SYM, T0, 300)!
  fill(f, 6, 20)
  const after = aggAt(f, SYM, T0, 300)!
  assert.deepEqual(before, after)
})
test('addMinute keeps order and dedupes; a ladder-carrying copy replaces a backfilled one', () => {
  const f = mkFeed()
  const mm = (t: number, foot?: boolean): BinanceMinute => ({ time: t, open: 1, high: 1, low: 1, close: 1, volume: 1, quoteVolume: 0, trades: 1, takerBuy: 0, ...(foot ? { foot: [{ price: 1, buy: 1, sell: 0 }], footComplete: true } : {}) })
  f.addMinute(SYM, mm(T0 + 120), false); f.addMinute(SYM, mm(T0), false); f.addMinute(SYM, mm(T0 + 60), false); f.addMinute(SYM, mm(T0 + 60, true), false)
  assert.deepEqual(f.range(SYM, T0, T0 + 200).map((m) => m.time), [T0, T0 + 60, T0 + 120])
  assert.ok(f.range(SYM, T0 + 60, T0 + 61)[0].foot)
})
test('recorder writes a line per closed minute and restore reloads it', () => {
  const dir = '/tmp/bn-rec-' + Math.random().toString(36).slice(2)
  const mk = () => new BinanceFeed({ dataDir: dir, nowMs: () => (T0 + 4000) * 1000 })
  const f = mk(); (f as unknown as { enabled: boolean }).enabled = true; f.setRecorder(true)
  ;(f as unknown as { sessionStartMs: number }).sessionStartMs = T0 * 1000
  f.ingestTrade(SYM, 1, 100000, 1, (T0 + 60) * 1000 + 5, false)
  f.ingestKline(SYM, kline(1, 100000, 100010, 1, 1))
  assert.equal(f.health().recorder.written, 1)
  const g = mk() as unknown as { restore(): void; range(s: string, a: number, b: number): BinanceMinute[] }
  g.restore()
  const m = g.range(SYM, T0 + 60, T0 + 120)[0]
  assert.ok(m && m.foot && m.footComplete)
})
test('health reports stale when never connected', () => { const h = mkFeed().health(); assert.equal(h.connected, false); assert.equal(h.stale, true) })

// ---- MSL binance.* ----
const series = (n: number) => ({ open: Array(n).fill(1), high: Array(n).fill(2), low: Array(n).fill(0.5), close: Array(n).fill(1.5), volume: Array(n).fill(0), time: Array.from({ length: n }, (_, i) => T0 + i * 60) })
test('MSL binance.volume/delta/poc read the bar that matches the candle time; fail clearly without a reader', () => {
  const f = mkFeed(); fill(f, 0, 12)
  const q = parseStrategyScript('let d = binance.delta()\nlet v = binance.volume(-2)\ncall when binance.ok() and d != 0 and v > 0\nconfidence = 70')
  assert.ok(q.ok, q.ok ? '' : q.error)
  const s = series(12)
  setBinanceReader({ asset: 'BTCUSD', at: (t, sec) => aggAt(f, SYM, t, sec) })
  const r = evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, s)
  setBinanceReader(null)
  assert.equal(r.error, undefined, r.error); assert.equal(r.direction, 'call')
  const r2 = evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, s)
  assert.ok(r2.error && /Binance data/i.test(r2.error), r2.error)
})
test('MSL binance.cumDelta sums the last n bars and is 0 when any bar lacks data', () => {
  const f = mkFeed(); fill(f, 0, 12)
  const q = parseStrategyScript('let c = binance.cumDelta(3)\ncall when c > 0\nconfidence = 60')
  setBinanceReader({ asset: 'BTCUSD', at: (t, sec) => aggAt(f, SYM, t, sec) })
  const ok = evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, series(12))
  const missing = evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, series(40)) // last bars are beyond the held minutes
  setBinanceReader(null)
  assert.equal(ok.direction, 'call') // takerBuy = 75% of volume -> positive delta every minute
  assert.equal(missing.direction, 'none')
})
test('aggregateMinutes: delta is the footprint split only when EVERY minute carries a complete ladder', () => {
  const full: BinanceMinute = { time: T0, open: 1, high: 1, low: 1, close: 1, volume: 3, quoteVolume: 0, trades: 1, takerBuy: 0, foot: [{ price: 1, buy: 3, sell: 0 }], footComplete: true }
  const part: BinanceMinute = { time: T0 + 60, open: 1, high: 1, low: 1, close: 1, volume: 2, quoteVolume: 0, trades: 1, takerBuy: 1 }
  const a = aggregateMinutes(T0, 120, [full, part], 1)!
  assert.equal(a.footShare, 0.5); near(a.delta, (0 + 1) - (3 + 1)) // falls back to taker split for the whole bar: buy 0+1, sell 3+1
})
test('POC is not reported from a partial ladder', () => {
  const part: BinanceMinute = { time: T0, open: 1, high: 1, low: 1, close: 1, volume: 5, quoteVolume: 0, trades: 1, takerBuy: 2, foot: [{ price: 7, buy: 1, sell: 0 }], footComplete: false }
  assert.equal(aggregateMinutes(T0, 60, [part], 1)!.poc, undefined)
})
test('MSL now-reads error in a reader without a live bar (backtest/replay), and live() reports freshness', () => {
  const f = mkFeed(); fill(f, 0, 12)
  const q = parseStrategyScript('call when binance.nowDelta() > 0\nconfidence = 60')
  setBinanceReader({ asset: 'BTCUSD', at: (t, sec) => aggAt(f, SYM, t, sec) }) // no `now`: what a backtest has
  const r = evaluateStrategyScript((q as { ast: never }).ast, {}, undefined, series(12))
  assert.ok(r.error && /only exists live/i.test(r.error), r.error)
  const q2 = parseStrategyScript('call when binance.live()\nconfidence = 60')
  setBinanceReader({ asset: 'BTCUSD', at: () => undefined, now: () => undefined })
  assert.equal(evaluateStrategyScript((q2 as { ast: never }).ast, {}, undefined, series(12)).direction, 'none')
  setBinanceReader({ asset: 'BTCUSD', at: () => undefined, now: () => ({ ageSec: 5 } as never) })
  assert.equal(evaluateStrategyScript((q2 as { ast: never }).ast, {}, undefined, series(12)).direction, 'call')
  setBinanceReader(null)
})
console.log(`${pass}/${total}`)
if (pass !== total) process.exit(1)
