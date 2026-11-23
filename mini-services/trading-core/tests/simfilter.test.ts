import assert from 'node:assert/strict'
import { decimalsOf, realDecimals, isSimBar, simTimes } from '../src/analytics/simfilter'
import { MarketDataService } from '../src/plugins/market-data'
import type { Candle } from '../src/types'
let pass = 0, total = 0
const test = (n: string, f: () => void | Promise<void>) => { total++; const r = (async () => { try { await f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } })(); return r }
const C = (time: number, p: number): Candle => ({ time, open: p, high: p + 0.002, low: p - 0.002, close: p + 0.001, volume: 0 })
const realBars = Array.from({ length: 60 }, (_, i) => C(1_700_000_000 + i * 60, 59000 + i * 0.5))
// stub kernel context
const mkCtx = () => ({ use: () => { throw new Error('no plugin') }, log: () => {}, bus: { emit: () => {}, on: () => {} } }) as never
await test('decimalsOf handles plain, trailing and exponent numbers', () => { assert.equal(decimalsOf(59051.755), 3); assert.equal(decimalsOf(100), 0); assert.equal(decimalsOf(1.5e-7), 8); assert.equal(decimalsOf(97234.894031), 6); assert.ok(decimalsOf(145676.7721418979) >= 10) })
await test('real precision is read from real bars; sim bars exceed it', () => { const d = realDecimals(realBars)!; assert.equal(d, 3); assert.equal(isSimBar(C(1, 59000.5), d), false); assert.equal(isSimBar({ open: 97234.894031, high: 97258.679098, low: 97234.894031, close: 97253.923395 }, d), true) })
await test('needs enough real bars to read a precision', () => { assert.equal(realDecimals(realBars.slice(0, 5)), null) })
await test('simTimes returns only the simulated rows', () => { const rows = [C(1, 59000.5), { time: 2, open: 97234.894031, high: 97300.123456, low: 97200.654321, close: 97250.987654, volume: 900 }, C(3, 59001.5)]; assert.deepEqual(simTimes(rows, 3), [2]) })
// provenance in the feed
const mk = () => { const m = new MarketDataService() as any; m.ctx = mkCtx(); m.store = null; return m }
await test('sim ticks never reach the archive queue and are tagged synthetic', () => {
  const m = mk(); m.mode = 'sim'; m.closed.set('BTCUSD|5s', [])
  const T = 1_700_000_000
  for (let i = 0; i < 40; i++) m.applyTick('BTCUSD', '5s', { ts: T + i * 5, price: 97000 + i * 1.234567, vol: 100 })
  assert.equal(m.archiveQueue.length, 0)
  const closed: Candle[] = m.closed.get('BTCUSD|5s') ?? []
  assert.ok(closed.length >= 30 && closed.every((c) => m.synthBars.has(c)))
})
await test('live ticks are archived and are not tagged', () => {
  const m = mk(); m.mode = 'live'; m.closed.set('BTCUSD|5s', [])
  const T = 1_700_000_000
  for (let i = 0; i < 20; i++) m.applyTick('BTCUSD', '5s', { ts: T + i * 5, price: 59000.5 + i, vol: 0 })
  assert.ok(m.archiveQueue.length >= 15)
  assert.ok((m.closed.get('BTCUSD|5s') as Candle[]).every((c) => !m.synthBars.has(c)))
})
await test('going live drops the sim bars (seed, gap-fill, sim ticks) but keeps real ones; mixed forming bar is dropped too', () => {
  const m = mk(); m.mode = 'sim'
  const T = 1_700_000_000
  const real = C(T - 600, 59000.5); const sim = C(T - 300, 97000.123456789)
  m.closed.set('BTCUSD|5s', [real, m.tagSynth([sim])[0]])
  const forming = C(T, 59001.5); m.candles.set('BTCUSD|5s', forming)
  m.applyTick('BTCUSD', '5s', { ts: T + 1, price: 97001.987654321, vol: 100 }) // sim tick touches the real forming bar -> tainted
  assert.ok(m.synthBars.has(m.candles.get('BTCUSD|5s')))
  m.mode = 'live'; m.liveClean.clear()
  m.applyTick('BTCUSD', '5s', { ts: T + 12, price: 59002.5, vol: 0 })
  const arr: Candle[] = m.closed.get('BTCUSD|5s')
  assert.ok(arr.includes(real) && !arr.includes(sim), 'real kept, sim dropped')
  assert.ok(!m.synthBars.has(m.candles.get('BTCUSD|5s')), 'the forming bar is a fresh real one')
  const archived = m.archiveQueue.map((r: { close: number }) => r.close)
  assert.ok(!archived.some((p: number) => p > 90000), 'no sim price was archived')
})
await test('seeded synthetic history is tagged and a live merge removes it', () => {
  const m = mk(); m.mode = 'live'
  m.seeded.add('EURUSD')
  const syn = m.tagSynth(Array.from({ length: 50 }, (_, i) => C(1_700_000_000 + i * 60, 1.0834129987 + i * 0.0001234567)))
  m.closed.set('EURUSD|1m', syn)
  assert.equal(m.dropSynthetic('EURUSD|1m'), 50)
  assert.equal((m.closed.get('EURUSD|1m') as Candle[]).length, 0)
})
await test('cleanArchive: dry run counts, apply deletes only the simulated rows, refuses when not live or when >90% look simulated', async () => {
  const simRow = (t: number): Candle => ({ time: t, open: 97234.894031 + t % 7, high: 97300.123456, low: 97200.654321, close: 97250.987654 + t % 5, volume: 900 })
  const rows: Candle[] = [C(10, 59000.5), simRow(20), C(30, 59001.5), simRow(40)]
  const deleted: number[] = []
  const m = mk(); m.mode = 'live'
  m.store = { getCandlesArchive: (_a: string, tf: string) => (tf === '5m' ? rows : []), deleteCandleRows: (_a: string, _tf: string, times: number[]) => { deleted.push(...times); return times.length } }
  m.fetchSidecarCandles = async () => realBars
  const dry = await m.cleanArchive('BTCUSD', false)
  assert.equal(dry.ok, true); assert.equal(dry.simRows, 2); assert.equal(dry.deleted, 0); assert.equal(deleted.length, 0)
  const done = await m.cleanArchive('BTCUSD', true)
  assert.equal(done.deleted, 2); assert.deepEqual(deleted.sort(), [20, 40])
  m.mode = 'sim'; assert.equal((await m.cleanArchive('BTCUSD', true)).ok, false)
  m.mode = 'live'; m.store.getCandlesArchive = () => [simRow(1), simRow(2), simRow(3)]
  const refused = await m.cleanArchive('BTCUSD', true); assert.equal(refused.ok, false); assert.ok(String(refused.error).includes('90%'))
  m.fetchSidecarCandles = async () => []; assert.equal((await m.cleanArchive('BTCUSD', false)).ok, false)
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
