// IQAIR//OS - tests for the price/volume scan (plugins/pvscan.ts): real vs OTC comparison, no invented correlations for flat volume.
import assert from 'node:assert/strict'
import { PvScanService, groupOf, type PvRow } from '../src/plugins/pvscan'

function rng(s: number) { return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 } }
const g = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r())
/** volumeKind: 'follows' volume grows with |move|; 'indep' random volume; 'flat' constant */
function candles(seed: number, volumeKind: 'follows' | 'indep' | 'flat', n = 200) {
  const r = rng(seed * 11)
  let x = 100
  return Array.from({ length: n }, (_, i) => {
    const d = g(r) * 0.2
    const o = x
    x += d
    const v = volumeKind === 'flat' ? 10 : volumeKind === 'follows' ? 10 * (1 + (4 * Math.abs(d)) / 0.2) * (0.8 + 0.4 * r()) : 10 * (0.7 + 0.6 * r())
    return { time: 1_700_000_000 + i * 60, open: o, high: Math.max(o, x) + 0.02, low: Math.min(o, x) - 0.02, close: x, volume: v }
  })
}
const ASSETS: { ticker: string; name: string; category: string; open: boolean; kind: 'follows' | 'indep' | 'flat' }[] = [
  { ticker: 'EURUSD', name: 'EUR/USD', category: 'forex', open: true, kind: 'follows' },
  { ticker: 'GBPUSD', name: 'GBP/USD', category: 'forex', open: true, kind: 'follows' },
  { ticker: 'USDJPY', name: 'USD/JPY', category: 'forex', open: true, kind: 'indep' },
  { ticker: 'EURUSD-OTC', name: 'EUR/USD OTC', category: 'forex', open: true, kind: 'flat' },
  { ticker: 'GBPUSD-OTC', name: 'GBP/USD OTC', category: 'forex', open: true, kind: 'flat' },
  { ticker: 'AUDUSD-OTC', name: 'AUD/USD OTC', category: 'forex', open: true, kind: 'follows' },
  { ticker: 'CLOSED', name: 'closed pair', category: 'forex', open: false, kind: 'follows' },
]
async function boot() {
  const svc = new PvScanService()
  const market = {
    listAssets: () => ASSETS,
    getCandlesDeep: (t: string) => { const a = ASSETS.find((x) => x.ticker === t)!; return candles(t.length * 7, a.kind) },
  }
  await svc.start({ use: () => market, log: () => {} } as any)
  return svc
}
let pass = 0, fail = 0
const run = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log('  ok - ' + name); pass++ } catch (e) { console.log('  FAIL - ' + name + '\n    ' + (e as Error).message); fail++ }
}
async function main() {
await run('real vs OTC groups: counts, usable-volume share, flat-volume pairs excluded from correlations', async () => {
  const b: any = (await (await boot()).global({ tf: '1m' }))
  assert.equal(b.ok, true)
  assert.equal(b.universe, 6)
  assert.equal(b.real.pairs, 3)
  assert.equal(b.otc.pairs, 3)
  assert.equal(b.real.withVolume, 3)
  assert.equal(b.otc.withVolume, 1)
  assert.ok(Math.abs(b.otc.volumeShare - 1 / 3) < 1e-9)
  assert.deepEqual(b.noVolume.map((x: any) => x.asset).sort(), ['EURUSD-OTC', 'GBPUSD-OTC'])
})
await run('pairs whose volume follows moves rank above independent volume; flat pairs never get a correlation', async () => {
  const b: any = await (await boot()).global({ tf: '1m' })
  const order = b.rows.map((r: PvRow) => r.asset)
  assert.ok(!order.includes('EURUSD-OTC') && !order.includes('GBPUSD-OTC'))
  assert.equal(order.indexOf('USDJPY'), order.length - 1)
  const top = b.rows[0]
  assert.ok(top.corrAbs > 0.4, 'top corrAbs ' + top.corrAbs)
  assert.ok(b.real.shareTracking > 0.5 && b.real.medianCorrAbs > 0.2)
})
await run('closed pairs skipped; unknown timeframe rejected; empty group has null medians', async () => {
  const svc = await boot()
  const b: any = await svc.global({ tf: '1m' })
  assert.ok(![...b.rows, ...b.noVolume].some((r: any) => r.asset === 'CLOSED'))
  assert.equal((svc.global({ tf: '7x' }) as any).ok, false)
  const e = groupOf([], 0)
  assert.equal(e.medianCorrAbs, null)
  assert.equal(e.shareTracking, null)
  assert.equal(e.volumeShare, 0)
})
}
main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + (pass + fail) + ' total')
  process.exit(fail ? 1 : 0)
})
