// IQAIR//OS - tests: SignalService.global() (the Signal Global board backend)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { SignalService } from '../src/plugins/signal'

const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
function walk(n: number, seed: number, drift: number): Candle[] {
  const r = rng(seed), out: Candle[] = []
  let x = 100
  for (let i = 0; i < n; i++) { const o = x; x += drift + (r() - 0.5) * 0.4; out.push({ time: 1_700_000_040 + i * 60, open: o, close: x, high: Math.max(o, x) + 0.1, low: Math.min(o, x) - 0.1, volume: 10 }) }
  return out
}
const assets = [
  { ticker: 'AAA', open: true, otc: false }, { ticker: 'BBB', open: true, otc: true }, { ticker: 'CCC', open: false, otc: false }, { ticker: 'DDD', open: true, otc: false },
]
const data: Record<string, Candle[]> = { AAA: walk(260, 1, 0.08), BBB: walk(260, 2, -0.08), CCC: walk(260, 3, 0), DDD: walk(20, 4, 0) }
const svc = new SignalService() as unknown as { market: unknown; global: SignalService['global'] }
svc.market = {
  listAssets: () => assets,
  getCandlesDeep: (a: string) => data[a] ?? [],
  getPrice: (a: string) => data[a]?.[data[a].length - 1]?.close ?? 0,
}
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
test('scans only OPEN pairs; thin history counts as warming, not a row', () => {
  const g = svc.global('1m', { refresh: true })
  assert.ok(g.ok)
  if (!g.ok) return
  assert.equal(g.universe, 3)
  assert.equal(g.scanned + g.warming, 3)
  assert.ok(g.rows.every((r) => r.asset !== 'CCC'))
  assert.ok(g.warming >= 1)
})
test('rows are actionable-first then by strength; counts add up', () => {
  const g = svc.global('1m', { refresh: true })
  if (!g.ok) throw new Error('not ok')
  assert.equal(g.buys + g.sells + g.waits, g.rows.length)
  let seenWait = false
  for (const r of g.rows) { if (r.action === 'wait') seenWait = true; else assert.equal(seenWait, false, 'actionable row after a wait row') }
})
test('scope filter applies before the limit', () => {
  const o = svc.global('1m', { scope: 'otc', refresh: true })
  if (!o.ok) throw new Error('not ok')
  assert.equal(o.universe, 1)
  assert.ok(o.rows.every((r) => r.otc))
  const real = svc.global('1m', { scope: 'real', refresh: true })
  if (!real.ok) throw new Error('not ok')
  assert.ok(real.rows.every((r) => !r.otc))
})
test('bad timeframe is an error, not a crash', () => assert.equal(svc.global('7x').ok, false))
console.log(`${pass}/${total}`)
if (pass !== total) process.exit(1)
