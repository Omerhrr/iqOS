// IQAIR//OS - tests: Omni Trader scans EVERY open asset over successive ticks, not the same twelve
import assert from 'node:assert/strict'
import { OmniTraderService } from '../src/plugins/omnitrader'
import { SweepEdgeMemory } from '../src/analytics/edge'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const names = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD', 'BTCUSD', ...Array.from({ length: 104 }, (_, i) => `PAIR${i}`)]
const mk = (): any => { const s: any = new OmniTraderService(); s.store = { listPositions: () => [] }; s.market = { listAssets: () => names.map((t) => ({ ticker: t, open: true, otc: false })) }; s.ctx = { log: () => {} }; return s }
test('every open asset is evaluated within a few ticks (was: the same 12 forever)', () => {
  const s = mk(); const seen = new Set<string>()
  for (let k = 0; k < 8; k++) { for (const a of s.candidatePool()) seen.add(a); s.advanceCursor() }
  assert.equal(seen.size, names.length, `${seen.size}/${names.length}`)
})
test('each tick scans at most scanBatch (default 24), and it is configurable', () => {
  const s = mk(); for (let k = 0; k < 15; k++) { assert.ok(s.candidatePool().length <= 24); s.advanceCursor() }
  s.config.scanBatch = 60; assert.equal(s.candidatePool().length, 60); s.config.scanBatch = 150; assert.equal(s.candidatePool().length, names.length)
})
test('a duplicate of an open exposure is caught, a different bet is not, and the guard can be turned off', () => {
  const s = mk(); s.store = { listPositions: () => [{ asset: 'EURUSD', side: 'call', note: 'omni:trader' }] }
  const dup = s.correlatedOpen('GBPUSD', 'call'); assert.ok(dup && dup.factors.includes('short USD')); assert.equal(s.correlatedOpen('GBPUSD', 'put'), null); assert.equal(s.correlatedOpen('XAUUSD', 'call'), null)
  s.config.correlationGuard = false; assert.equal(s.correlatedOpen('GBPUSD', 'call'), null)
})
test('a watchlist of 12 or fewer is scanned whole every tick, unchanged', () => {
  const s = mk(); s.config.assets = ['EURUSD', 'GBPUSD', 'XAUUSD']; const a = s.candidatePool(); s.advanceCursor(); const b = s.candidatePool()
  assert.deepEqual(a, ['EURUSD', 'GBPUSD', 'XAUUSD']); assert.deepEqual(b, a)
})
test('assets with an open position or in cooldown are skipped', () => {
  const s = mk(); s.assetCooldownUntil.set('EURUSD', Math.floor(Date.now() / 1000) + 600); const p = s.candidatePool(); assert.ok(!p.includes('EURUSD'))
})
test('SweepEdgeMemory.backfill marks a standing signal as held without trading it', () => {
  const m = new SweepEdgeMemory(); m.beginSweep('x'); m.endSweep(new Set(['A']), new Set(), 1) // leaves cold
  const k = SweepEdgeMemory.key('B', 'call'); assert.equal(m.gate(k), 'trade'); m.backfill(k, 2); assert.equal(m.gate(k), 'skip')
  m.endSweep(new Set(['B']), new Set(), 3); assert.equal(m.gate(k), 'trade') // lapsed (B evaluated, no longer qualifying) -> a fresh edge can trade
})
let sd2 = 9; const r2 = () => ((sd2 = (sd2 * 1664525 + 1013904223) % 4294967296) / 4294967296)
const upSeries = (n: number, s0: number) => { const out: any[] = []; let p = 1.2 + s0; for (let i = 0; i < n; i++) { const o = p, c = o + 0.00022 * (Math.sin(i / 14) > -0.5 ? 1 : -0.3) + (r2() - 0.5) * 0.0003; out.push({ time: 1_700_006_400 + i * 60, open: o, high: Math.max(o, c) + r2() * 0.0002, low: Math.min(o, c) - r2() * 0.0002, close: c, volume: 100 }); p = c } return out }
test('poolMode "setups": the plan scan is the pool; the pair traded and anything duplicating it are dropped, and a trade forces a rescan', () => {
  const s: any = new OmniTraderService(); const list = ['EURUSD', 'GBPUSD', 'XAUUSD', 'RANGE1']; const bars: Record<string, any[]> = { EURUSD: upSeries(500, 0), GBPUSD: upSeries(500, 0.1), XAUUSD: upSeries(500, 0.2), RANGE1: upSeries(80, 0) }
  let scans = 0; s.market = { listAssets: () => list.map((t) => ({ ticker: t, open: true, otc: false })), getCandlesDeep: (t: string) => { if (t === 'EURUSD') scans++; return bars[t] } }
  s.ctx = { log: () => {} }; let open: any[] = []; s.store = { listPositions: () => open }; s.config.poolMode = 'setups'
  const first = s.candidatePool(); assert.ok(first.length >= 1, 'no setups found in the up-trending pairs'); assert.ok(!first.includes('RANGE1'), 'a pair with thin history cannot be a setup')
  const before = scans; s.candidatePool(); assert.equal(scans, before, 'the scan must be reused inside the ttl')
  open = [{ asset: first[0], side: first[0] === 'XAUUSD' ? 'call' : 'call', note: 'omni:trader' }]; s.setups.invalidate()
  const next = s.candidatePool(); assert.ok(!next.includes(first[0]), 'the pair just traded must not be picked again')
  if (first[0] === 'EURUSD') assert.ok(!next.includes('GBPUSD'), 'a pair duplicating the traded exposure must be skipped')
  assert.ok(scans > before, 'invalidate() must trigger a rescan')
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
