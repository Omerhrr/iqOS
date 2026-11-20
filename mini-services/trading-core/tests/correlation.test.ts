// IQAIR//OS - tests: correlation by exposure + shuffled scan rotation
import assert from 'node:assert/strict'
import { exposure, correlatedWith, relatedAssets, ScanRotation } from '../src/analytics/correlation'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const blocks = (a: string, s: string, o: [string, string][]) => !!correlatedWith(a, s, o.map(([asset, side]) => ({ asset, side })))
test('exposure: call EURUSD = long EUR short USD; put flips', () => { const e = exposure('EURUSD', 'call'); assert.equal(e.get('EUR'), 1); assert.equal(e.get('USD'), -1); assert.equal(exposure('EURUSD', 'put').get('USD'), 1) })
test('EURUSD call blocks GBPUSD call (both short USD) and AUDUSD call', () => { assert.ok(blocks('GBPUSD', 'call', [['EURUSD', 'call']])); assert.ok(blocks('AUDUSD', 'call', [['EURUSD', 'call']])) })
test('EURUSD call blocks USDJPY PUT (both short USD) but not USDJPY CALL', () => { assert.ok(blocks('USDJPY', 'put', [['EURUSD', 'call']])); assert.ok(!blocks('USDJPY', 'call', [['EURUSD', 'call']])) })
test('opposite directions on the same family are a spread, allowed', () => { assert.ok(!blocks('GBPUSD', 'put', [['EURUSD', 'call']])) })
test('EURUSD call blocks EURJPY call (long EUR) and EURGBP call', () => { assert.ok(blocks('EURJPY', 'call', [['EURUSD', 'call']])); assert.ok(blocks('EURGBP', 'call', [['EURUSD', 'call']])) })
test('metals and crypto are their own factors and ignore the FX book', () => {
  assert.ok(blocks('XAGUSD', 'call', [['XAUUSD', 'call']])); assert.ok(!blocks('XAGUSD', 'put', [['XAUUSD', 'call']])); assert.ok(blocks('ETHUSD', 'call', [['BTCUSD', 'call']]))
  assert.ok(!blocks('XAUUSD', 'call', [['EURUSD', 'call']])); assert.ok(!blocks('BTCUSD', 'call', [['EURUSD', 'call']]))
})
test('OTC suffix is ignored; unknown symbols never conflict', () => { assert.ok(blocks('GBPUSD-OTC', 'call', [['EURUSD', 'call']])); assert.ok(!blocks('AAPL', 'call', [['MSFT', 'call']])) })
test('the same pair is left to the trader\'s own per-asset rule', () => { assert.ok(!blocks('EURUSD', 'call', [['EURUSD', 'call']])) })
test('the block names the shared factor', () => { const c = correlatedWith('GBPUSD', 'call', [{ asset: 'EURUSD', side: 'call' }]); assert.ok(c && c.factors.includes('short USD')) })
test('relatedAssets (direction unknown): EURUSD~GBPUSD, EURUSD~EURJPY, XAU~XAG, BTC~ETH; not EURUSD~USDJPY, not gold~EURUSD', () => {
  assert.ok(relatedAssets('EURUSD', 'GBPUSD')); assert.ok(relatedAssets('EURUSD', 'EURJPY')); assert.ok(relatedAssets('XAUUSD', 'XAGUSD')); assert.ok(relatedAssets('BTCUSD', 'ETHUSD'))
  assert.ok(!relatedAssets('EURUSD', 'USDJPY')); assert.ok(!relatedAssets('XAUUSD', 'EURUSD'))
})
test('rotation: every asset is visited within a lap, windows never exceed the size, order reshuffles per lap', () => {
  const list = Array.from({ length: 117 }, (_, i) => `P${i}`); let sd = 5; const r = new ScanRotation(() => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296))
  const lap = (): string[] => { const seen: string[] = []; for (let k = 0; k < 10; k++) { const w = r.current(list, 12); assert.ok(w.length <= 12); seen.push(...w); r.advance(list, 12) } return seen }
  const l1 = lap(); assert.equal(new Set(l1.slice(0, 117)).size, 117)
  const l2 = lap(); assert.notDeepEqual(l1.slice(0, 40), l2.slice(0, 40))
})
test('rotation: current() is stable inside a tick; a small list is returned whole', () => {
  const r = new ScanRotation(); const list = Array.from({ length: 30 }, (_, i) => `P${i}`); assert.deepEqual(r.current(list, 10), r.current(list, 10)); assert.deepEqual(r.current(['A', 'B'], 10), ['A', 'B'])
})
test('rotation survives the list changing (assets closing / opening)', () => {
  const r = new ScanRotation(); let list = Array.from({ length: 40 }, (_, i) => `P${i}`); r.current(list, 10); r.advance(list, 10); list = list.slice(5, 38).concat(['NEW1', 'NEW2'])
  const w = r.current(list, 10); assert.ok(w.every((x) => list.includes(x)))
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
