// Range map: ranks pairs by how a fixed OU fade held up. Planted mean-reverting vs random-walk vs trending series.
//   npx tsx tests/rangemap.test.ts      (from mini-services/trading-core)
import assert from 'node:assert/strict'
import { RangeMapService, wilsonLow, fadeScript } from '../src/plugins/rangemap'
import { parseStrategyScript } from '../src/analytics/strategylang'

const tests: Array<[string, () => Promise<void>]> = []
const test = (n: string, f: () => Promise<void>) => tests.push([n, f])
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5) }
function series(kind: 'ou' | 'rw' | 'trend', n: number, seed: number) {
  const r = rng(seed); const out: any[] = []; let x = 1.1; const mid = 1.1
  for (let i = 0; i < n; i++) {
    const o = x
    if (kind === 'ou') x += 0.25 * (mid - x) + r() * 0.0016
    else if (kind === 'trend') x += 0.00035 + r() * 0.001
    else x += r() * 0.001
    out.push({ time: 1.7e9 + i * 60, open: o, high: Math.max(o, x) + Math.abs(r()) * 0.0002, low: Math.min(o, x) - Math.abs(r()) * 0.0002, close: x, volume: 10 })
  }
  return out
}
function harness(map: Record<string, any[]>) {
  const market = {
    listAssets: () => Object.keys(map).map((t) => ({ ticker: t, open: true, otc: /OTC$/.test(t) })),
    getCandlesDeep: (a: string) => map[a] ?? [],
  }
  const logs: string[] = []
  const svc = new RangeMapService()
  void svc.start({ use: () => market, log: (_: string, m: string) => logs.push(m), bus: { on: () => () => {} }, provide: () => {} } as any)
  return svc
}
const waitDone = async (svc: RangeMapService) => { for (let i = 0; i < 400; i++) { if (svc.status().status !== 'running') return; await new Promise((r) => setTimeout(r, 25)) } throw new Error('timeout') }

test('fadeScript parses', async () => { assert.ok(parseStrategyScript(fadeScript(1.5)).ok) })
test('wilsonLow is below the observed rate and tightens with n', async () => {
  const a = wilsonLow(6, 10)!, b = wilsonLow(60, 100)!
  assert.ok(a < 0.6 && b < 0.6 && b > a)
  assert.equal(wilsonLow(0, 0), null)
})
test('bad options are rejected; no matching pairs is an error', async () => {
  const svc = harness({ A: series('rw', 600, 1) })
  assert.equal(svc.begin({ tf: '7x' }).ok, false)
  assert.equal(svc.begin({ assets: ['ZZZ'] }).ok, false)
})
test('a planted mean-reverting pair outranks random-walk and trending pairs', async () => {
  const svc = harness({ OU: series('ou', 1500, 3), RW: series('rw', 1500, 4), TR: series('trend', 1500, 5) })
  const r = svc.begin({ bars: 1500, zEntry: 1.5 })
  assert.ok(r.ok)
  await waitDone(svc)
  const st = svc.status()
  assert.equal(st.status, 'done')
  const ou = st.rows.find((x) => x.asset === 'OU')!, rw = st.rows.find((x) => x.asset === 'RW')!, tr = st.rows.find((x) => x.asset === 'TR')!
  assert.ok(ou.trades >= 20, `ou trades ${ou.trades}`)
  assert.ok((ou.winRate ?? 0) > 0.6, `ou win ${ou.winRate}`)
  assert.ok((ou.winRate ?? 0) > (rw.winRate ?? 0) && (ou.winRate ?? 0) > (tr.winRate ?? 0.5), `ou ${ou.winRate} rw ${rw.winRate} tr ${tr.winRate}`)
  assert.equal(ou.holdsUp, true)
  assert.ok(st.watchlist.includes('OU'))
  assert.ok(!st.watchlist.includes('TR'))
  assert.equal(ou.thirds.length, 3)
})
test('a thin-history pair is skipped with a reason, not scored', async () => {
  const svc = harness({ THIN: series('ou', 200, 9), OK: series('rw', 600, 2) })
  svc.begin({})
  await waitDone(svc)
  const st = svc.status()
  assert.ok(st.skipped.some((s) => s.asset === 'THIN' && /closed bars/.test(s.reason)))
  assert.ok(st.rows.some((x) => x.asset === 'OK'))
})
test('a second start while running is refused; cancel stops the run', async () => {
  const svc = harness({ A: series('rw', 1500, 1), B: series('rw', 1500, 2), C: series('rw', 1500, 3) })
  assert.ok(svc.begin({}).ok)
  assert.equal(svc.begin({}).ok, false)
  assert.equal(svc.cancel(), true)
  assert.equal(svc.status().status, 'idle')
})
test('real vs OTC groups are split and counted', async () => {
  const svc = harness({ OU: series('ou', 1500, 3), 'OU-OTC': series('ou', 1500, 6) })
  svc.begin({ bars: 1500 })
  await waitDone(svc)
  const g = svc.status().groups!
  assert.equal(g.real.pairs, 1)
  assert.equal(g.otc.pairs, 1)
})

test('expiry scan compares the fixed expiry with half-life multiples; scanExpiry:false skips it', async () => {
  const svc = harness({ OU: series('ou', 1500, 3) })
  svc.begin({ bars: 1500, zEntry: 1.5 })
  await waitDone(svc)
  const ou = svc.status().rows.find((x) => x.asset === 'OU')!
  assert.ok(ou.expiryScan, 'expiryScan present')
  assert.equal(ou.expiryScan!.tries[0].how, 'fixed')
  assert.ok(ou.expiryScan!.tries.length >= 2, 'multiples tried')
  assert.ok(ou.expiryScan!.best, 'a best exists')
  const m = ou.expiryScan!.suggestedExpiryMin
  assert.ok(m === null || (m >= 1 && m <= 15), 'suggested ' + m)
  const svc2 = harness({ OU: series('ou', 1500, 3) })
  svc2.begin({ bars: 1500, scanExpiry: false })
  await waitDone(svc2)
  assert.equal(svc2.status().rows.find((x) => x.asset === 'OU')!.expiryScan, null)
})

void (async () => {
  let fail = 0
  for (const [n, f] of tests) { try { await f(); console.log('ok  ' + n) } catch (e) { fail++; console.log('FAIL ' + n + '\n    ' + (e as Error).message.slice(0, 400)) } }
  console.log(fail ? fail + ' FAILED' : 'all ' + tests.length + ' passed')
  process.exit(fail ? 1 : 0)
})()
