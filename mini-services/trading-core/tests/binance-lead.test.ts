// Binance vs IQ lead/lag: a planted delay is recovered, the direction is right, unrelated series are 'none', the gap ignores the usual basis,
// and the edge analyzer finds a real lag edge only when your order is faster than the lag
import assert from 'node:assert/strict'
import { analyzeGapEdge, estimateLag, gapBpsNow, gridPrices, type Pt } from '../src/analytics/binancelead'
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
let seed = 99
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) * Math.SQRT2 }
const T0 = 1_700_000_000_000

/** Binance prints every 50 ms (random walk); IQ shows the Binance price from `lagMs` earlier times a constant basis, sampled every 100 ms, stored on change only */
function world(seconds: number, lagMs: number, basis = 1.0004, independent = false): { bin: Pt[]; iq: Pt[] } {
  seed = 99
  const steps = seconds * 20
  const bin: Pt[] = []
  let p = 100000
  for (let i = 0; i < steps; i++) { p *= 1 + gauss() * 0.00003; bin.push({ t: T0 + i * 50, p }) }
  const other: number[] = []
  let q = 100000
  for (let i = 0; i < steps; i++) { q *= 1 + gauss() * 0.00003; other.push(q) }
  const iq: Pt[] = []
  let last = NaN
  for (let t = T0; t < T0 + seconds * 1000; t += 100) {
    const k = Math.floor((t - lagMs - T0) / 50)
    if (k < 0) continue
    const v = (independent ? other[k] : bin[k].p) * basis
    const r = Math.round(v * 100) / 100
    if (r !== last) { iq.push({ t, p: r }); last = r }
  }
  return { bin, iq }
}

test('gridPrices holds the last known price', () => {
  const g = gridPrices([{ t: 0, p: 1 }, { t: 250, p: 2 }], 0, 600, 200)
  assert.deepEqual(g, [1, 1, 2, 2])
  assert.ok(Number.isNaN(gridPrices([{ t: 500, p: 1 }], 0, 400, 200)[0]))
})
test('a planted 700 ms delay is recovered and Binance is named the leader', () => {
  const { bin, iq } = world(900, 700)
  const r = estimateLag(bin, iq, T0 + 30_000, T0 + 900_000)
  assert.equal(r.leader, 'binance'); assert.ok(Math.abs(r.lagMs - 700) <= 120, `lag ${r.lagMs}`); assert.ok(r.corr > 0.5, `corr ${r.corr}`)
})
test('when IQ is the one moving first the leader is IQ', () => {
  const { bin, iq } = world(900, 0)
  const swapped = estimateLag(iq.map((x) => ({ t: x.t + 800, p: x.p })), bin, T0 + 30_000, T0 + 900_000)   // "bin" side is the late one
  assert.equal(swapped.leader, 'iq'); assert.ok(swapped.lagMs < -500, `lag ${swapped.lagMs}`)
})
test('two independent series have no leader', () => {
  const { bin, iq } = world(900, 700, 1.0004, true)
  const r = estimateLag(bin, iq, T0 + 30_000, T0 + 900_000)
  assert.equal(r.leader, 'none')
})
test('too little data is reported, not guessed', () => {
  const { bin, iq } = world(20, 700)
  const r = estimateLag(bin.slice(0, 10), iq.slice(0, 10), T0, T0 + 20_000)
  assert.equal(r.ok, false); assert.equal(r.leader, 'none')
})
test('the gap ignores the usual basis between the two prices', () => {
  const ratios = Array.from({ length: 100 }, () => 1.0004)
  assert.ok(Math.abs(gapBpsNow(100000 * 1.0004, 100000, ratios)!) < 1e-6)
  const g = gapBpsNow(100000 * 1.0004 * 1.0005, 100000, ratios)!
  assert.ok(Math.abs(g - 5) < 0.01, `gap ${g}`)
  assert.equal(gapBpsNow(1, 1, ratios.slice(0, 5)), null)
})
test('edge analyzer: a real lag edge shows with a fast order and disappears with a slow one', () => {
  const { bin, iq } = world(6 * 3600, 700)
  const fast = analyzeGapEdge(bin, iq, { thresholdsBps: [2, 3], horizonsSec: [1, 2], delayMs: 0 })
  assert.ok(fast.rows.some((r) => r.verdict === 'candidate'), JSON.stringify(fast.rows.map((r) => [r.thresholdBps, r.horizonSec, r.trades, r.winRate, r.verdict])))
  const slow = analyzeGapEdge(bin, iq, { thresholdsBps: [2, 3], horizonsSec: [1, 2], delayMs: 2500 })
  assert.ok(!slow.rows.some((r) => r.verdict === 'candidate'), JSON.stringify(slow.rows.map((r) => [r.thresholdBps, r.horizonSec, r.trades, r.winRate, r.verdict])))
})
test('edge analyzer: unrelated series never give a candidate', () => {
  const { bin, iq } = world(6 * 3600, 700, 1.0004, true)
  const r = analyzeGapEdge(bin, iq, { thresholdsBps: [2, 3, 5], horizonsSec: [1, 5, 15], delayMs: 0 })
  assert.ok(!r.rows.some((x) => x.verdict === 'candidate'))
})
test('edge analyzer asks for more data instead of guessing', () => {
  const r = analyzeGapEdge([{ t: 0, p: 1 }], [{ t: 0, p: 1 }])
  assert.equal(r.rows.length, 0)
})
process.chdir(mkdtempSync(join(tmpdir(), 'bnlead-')))
const { LeadMonitor, loadTicks, leadReport } = await import('../src/plugins/binancelead')
const { binanceReaderScope, setActiveLeadSource, setActiveBinanceFeed, BinanceFeed } = await import('../src/plugins/binancefeed')
const { MetaStrategyService } = await import('../src/plugins/metastrategy')
const { MarketDataService } = await import('../src/plugins/market-data')
const { BUILTIN_TV_SPECS } = await import('../src/plugins/builtinTvSpecs')

/** feed a LeadMonitor a whole synthetic world as if it were live, up to `endMs` */
function feedMonitor(m: any, w: { bin: Pt[]; iq: Pt[] }, endMs: number): void {
  let bi = 0
  for (let t = T0; t <= endMs; t += 1000) {
    while (bi < w.bin.length && w.bin[bi].t <= t) { m.ingestBin('BTCUSD', w.bin[bi].t, w.bin[bi].p); bi++ }
    m.ingestIq('BTCUSD', w.iq.filter((x) => x.t > t - 1000 && x.t <= t), t); m.sample(t)
  }
}
test('monitor: after a few minutes it names Binance the leader and the gap points the way IQ is about to move', () => {
  const w = world(720, 700)
  const dir = mkdtempSync(join(tmpdir(), 'ld-'))
  const m = new LeadMonitor(dir, ['BTCUSD']); m.iqLive = true; m.recorderOn = () => true
  const end = T0 + 700_000
  feedMonitor(m, w, end)
  m.estimate(end)
  const v = m.view('BTCUSD', end + 200)!
  assert.equal(v.leader, 'binance'); assert.ok(Math.abs(v.lagMs - 700) < 150, `lag ${v.lagMs}`); assert.ok(v.ok, v.note)
  // push Binance 6 bps above where IQ is: gap must read about +6 and be fresh
  const last = [...w.bin].reverse().find((b) => b.t <= end)!
  m.ingestBin('BTCUSD', end + 100, last.p * 1.0006)
  const g = m.view('BTCUSD', end + 200)!
  assert.ok(g.fresh && g.gapBps > 3 && g.gapBps < 9, `gap ${g.gapBps}`)
  // a stale IQ poll makes everything not-ok and the gap 0
  const stale = m.view('BTCUSD', end + 20_000)!
  assert.equal(stale.fresh, false); assert.equal(stale.ok, false)
})
test('monitor: records both streams and loadTicks/leadReport read them back', () => {
  const w = world(5400, 700)
  const dir = mkdtempSync(join(tmpdir(), 'ld2-'))
  const m = new LeadMonitor(dir, ['BTCUSD']); m.iqLive = true; m.recorderOn = () => true
  const end = T0 + 5_400_000
  feedMonitor(m, w, end)
  m.flush(end)
  const files = readdirSync(dir).filter((f) => f.startsWith('ticks-'))
  assert.equal(files.length, 1)
  const t = loadTicks(dir, 'BTCUSD')
  assert.ok(t.bin.length > 10000 && t.iq.length > 5000, `${t.bin.length}/${t.iq.length}`)
  const r: any = leadReport(dir, { pair: 'BTCUSD', delayMs: 0, thresholdsBps: [2, 3], horizonsSec: [1, 2] })
  assert.equal(r.ok, true); assert.equal(r.overall.leader, 'binance'); assert.ok(r.hours.length >= 1)
  assert.equal((leadReport(dir, { pair: 'ETHUSD' }) as any).ok, false)
})
test('monitor: recorder off writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ld3-'))
  const m = new LeadMonitor(dir, ['BTCUSD']); m.recorderOn = () => false
  m.ingestBin('BTCUSD', T0, 1); m.ingestBin('BTCUSD', T0 + 500, 2); m.flush(T0 + 1000)
  assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0)
})
test('MSL: binance.gap()/leadOk() read the live view and refuse to run without one (backtest)', () => {
  const svc = new MetaStrategyService() as any
  const src = 'call when binance.gap() > 2 and binance.leadOk()\nconfidence = 60\nexpiry = 1\n'
  const f = new BinanceFeed({ dataDir: join(process.cwd(), 'bnl') }); f.setRecorder(false)
  setActiveBinanceFeed(f)
  let view: any = { leader: 'binance', lagMs: 700, corr: 0.4, stable: 1, gapBps: 5, fresh: true, ok: true }
  setActiveLeadSource({ view: () => view })
  const m: any = new MarketDataService()
  svc.market = m
  const run = () => binanceReaderScope('BTCUSD', () => svc.testScript(src, 'BTCUSD', '1m'))
  const a = run()
  assert.ok(JSON.stringify(a).includes('call'), JSON.stringify(a).slice(0, 300))
  view = { ...view, gapBps: 1, ok: false }
  const b = run()
  assert.ok(!JSON.stringify(b).includes('"call"') || JSON.stringify(b) !== JSON.stringify(a))
  setActiveLeadSource(null)
})
test('built-in "Binance leads IQ" parses, is live-only and fires only on a fresh, real, big enough gap', () => {
  const spec = BUILTIN_TV_SPECS.find((x: any) => x.id === 'meta:builtin-binance-lead')
  assert.ok(spec)
  assert.ok(/binance\.gap\(\)/.test(spec!.script))
  const svc = new MetaStrategyService() as any
  assert.equal(svc.dataSourceFor(spec!.script, undefined), 'iq')
})
console.log(`${pass}/${total}`)
process.exit(pass === total ? 0 : 1)
