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
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
