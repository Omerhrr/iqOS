// IQ Option tick bars: counts, up/down delta, ladder + POC, complete/partial flags, loss windows, forming bar, and the collector's coverage tracking
import assert from 'node:assert/strict'
import { buildIqBars, ladderStepFor } from '../src/analytics/iqticks'
import { OtcFootprintService } from '../src/plugins/otcfootprint'
let pass = 0, total = 0
const test = (n: string, f: () => void | Promise<void>) => { total++; try { const r = f(); if (r instanceof Promise) throw new Error('use testA'); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const testA = async (n: string, f: () => Promise<void>) => { total++; try { await f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const T0 = Math.floor(1_700_000_000_000 / 3_600_000) * 3_600_000

// minute 0: 1.0 -> 1.1 -> 1.2 -> 1.1 -> 1.2 -> 1.3 (4 up, 1 down, the first tick has no previous); minute 1: 1.3 -> 1.2 -> 1.1 (2 down)
const tk = (ms: number, p: number) => ({ ts: T0 + ms, price: p })
const ticks = [tk(1000, 1.0), tk(5000, 1.1), tk(9000, 1.2), tk(20000, 1.1), tk(30000, 1.2), tk(50000, 1.3), tk(61000, 1.2), tk(70000, 1.1)]
const cov = { from: T0 - 1000, losses: [] as { from: number; to: number }[] }

test('counts, up/down delta, OHLC and the first tick having no direction', () => {
  const r = buildIqBars(ticks, 60, cov, T0 + 130_000, 10, 0.1)
  assert.equal(r.bars.length, 2)
  const a = r.bars[0], b = r.bars[1]
  assert.equal(a.up, 4); assert.equal(a.down, 1); assert.equal(a.ticks, 5); assert.equal(a.delta, 3)
  assert.equal(a.open, 1.0); assert.equal(a.high, 1.3); assert.equal(a.low, 1.0); assert.equal(a.close, 1.3)
  assert.ok(Math.abs(a.deltaPct - 0.6) < 1e-9)
  assert.equal(b.up, 0); assert.equal(b.down, 2); assert.equal(b.delta, -2)
  assert.ok(Math.abs(a.upMove - 0.4) < 1e-9 && Math.abs(a.downMove - 0.1) < 1e-9)
})
test('the ladder counts ticks by level and the POC is the busiest level', () => {
  const r = buildIqBars(ticks, 60, cov, T0 + 130_000, 10, 0.1)
  const a = r.bars[0]
  const at = (p: number) => a.ladder.find((x) => Math.abs(x.price - p) < 1e-9)!
  assert.equal(at(1.2).up, 2); assert.equal(at(1.1).up, 1); assert.equal(at(1.1).down, 1); assert.equal(at(1.3).up, 1)
  assert.equal(a.poc, 1.1) // 1.1 and 1.2 tie on 2 ticks: the lower level wins
  assert.equal(a.ladder.reduce((x, r) => x + r.up + r.down, 0), a.ticks)
})
test('the forming bar is separate, has its age, and is not in the closed list', () => {
  const r = buildIqBars(ticks, 60, cov, T0 + 75_000, 10, 0.1)
  assert.equal(r.bars.length, 1)
  assert.ok(r.forming && r.forming.ageSec === 15 && r.forming.down === 2 && r.forming.time === (T0 + 60_000) / 1000)
})
test('a bar the collector did not watch from the start is partial; later bars are complete', () => {
  const late = { from: T0 + 30_000, losses: [] }
  const r = buildIqBars(ticks, 60, late, T0 + 130_000, 10, 0.1)
  assert.equal(r.bars[0].complete, false); assert.equal(r.bars[1].complete, true)
})
test('a window where samples were lost makes the bars it touches partial', () => {
  const c = { from: T0 - 1000, losses: [{ from: T0 + 62_000, to: T0 + 66_000 }] }
  const r = buildIqBars(ticks, 60, c, T0 + 130_000, 10, 0.1)
  assert.equal(r.bars[0].complete, true); assert.equal(r.bars[1].complete, false)
})
test('higher timeframes aggregate from the ticks themselves', () => {
  const r = buildIqBars(ticks, 300, cov, T0 + 400_000, 10, 0.1)
  assert.equal(r.bars.length, 1); assert.equal(r.bars[0].ticks, 7); assert.equal(r.bars[0].up, 4); assert.equal(r.bars[0].down, 3)
})
test('no ticks -> nothing, and the ladder step is a round number near range/12', () => {
  assert.deepEqual(buildIqBars([], 60, cov, T0, 5).bars, [])
  const t: { ts: number; price: number }[] = []
  for (let i = 0; i < 60; i++) t.push({ ts: T0 + i * 1000, price: 100 + (i % 12) })
  const st = ladderStepFor(t)
  assert.ok([0.5, 1, 2].includes(st), `step ${st}`)
})
await testA('collector: coverage starts at the first tick and a full sidecar buffer with a hole is recorded as a loss', async () => {
  const svc: any = new OtcFootprintService()
  let pts: { time: number; price: number }[] = []
  svc.market = { mode: 'live', activeAsset: 'EURUSD', getTickSeries: async () => ({ points: pts, dataSource: 'tick' }), recentTicks: () => [] }
  svc.ctx = { log() {} }
  pts = Array.from({ length: 1000 }, (_, i) => ({ time: (T0 + i * 100) / 1000, price: 1 + i * 1e-5 }))
  await svc.pullLive('EURUSD')
  assert.equal(svc.coverage('EURUSD').from, T0); assert.equal(svc.coverage('EURUSD').losses.length, 0)
  // next pull: the sidecar buffer is full and its oldest point is 60 s newer than what we merged -> samples in between are gone
  pts = Array.from({ length: 1000 }, (_, i) => ({ time: (T0 + 160_000 + i * 100) / 1000, price: 2 + i * 1e-5 }))
  await svc.pullLive('EURUSD')
  const c = svc.coverage('EURUSD')
  assert.equal(c.losses.length, 1); assert.ok(c.losses[0].to - c.losses[0].from > 50_000)
})
await testA('collector: ensure() keeps the asset in the sweep for a couple of minutes', async () => {
  const svc: any = new OtcFootprintService()
  svc.market = { mode: 'sim', activeAsset: 'EURUSD', getTickSeries: async () => ({ points: [], dataSource: 'candle' }), recentTicks: () => [] }
  svc.ctx = { log() {} }
  await svc.ensure('gbpusd')
  assert.ok(svc.tabWatch.get('GBPUSD') > Date.now() + 100_000)
})
console.log(`${pass}/${total}`)
process.exit(pass === total ? 0 : 1)
