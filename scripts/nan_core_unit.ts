// Layer-2 NaN hardening - deterministic logic unit (bun).
// Locks the screener-source contract added after the finGte gates (312a459):
//   - a glitched TAIL candle (NaN/Inf close) leaves price/atrPct/changePct
//     non-finite while score/confidence stay finite (probe-verified) - so a
//     tradeable-looking row with a garbage price could reach the pickers, the
//     arm backfill and the alerts
//   - scorePair must therefore FAIL CLOSED: a row whose tradeable core is not
//     fully finite is never emitted (throw, thin-history style)
//   - neutral-but-valid rows still pass: flat tape (RSI 50, ADX 0) and
//     mid-series glitches (rescued by last()'s walk-back) stay finite
import { ScreenerService } from '../mini-services/trading-core/src/plugins/screener'
import { Screener2Service } from '../mini-services/trading-core/src/plugins/screener2'
import { scanSnapshot } from '../mini-services/trading-core/src/analytics/engine'
import type { Candle, Timeframe } from '../mini-services/trading-core/src/types'

let pass = 0
let fail = 0
function ok(cond: boolean, name: string) {
  if (cond) {
    pass++
    console.log('  ok', name)
  } else {
    fail++
    console.log('  FAIL', name)
  }
}
const throws = (fn: () => unknown): Error | null => {
  try {
    fn()
    return null
  } catch (e) {
    return e as Error
  }
}

// ---------- candle builders (deterministic) ----------
const walk = (n: number, seed = 7, p0 = 1.2): number[] => {
  let s = seed >>> 0
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [p0]
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + (rnd() - 0.5) * 0.004))
  return out
}
const toCandles = (w: number[]): Candle[] =>
  w.map((c, i) => ({ time: 1_700_000_000 + i * 60, open: c, high: c * 1.0008, low: c * 0.9992, close: c, volume: 100 + i }))
const flat = (n = 300): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ time: 1_700_000_000 + i * 60, open: 1.2345, high: 1.2345, low: 1.2345, close: 1.2345, volume: 1 }))
const tailNaN = (n = 300): Candle[] => toCandles(walk(n).map((c, i) => (i === n - 1 ? NaN : c)))
const tailInf = (n = 300): Candle[] => toCandles(walk(n).map((c, i) => (i === n - 1 ? Infinity : c)))
const midNaN = (n = 300): Candle[] => toCandles(walk(n).map((c, i) => (i === 200 ? NaN : c)))
const healthy = (n = 300): Candle[] => toCandles(walk(n))

const CORE_FIELDS = ['price', 'score', 'confidence', 'pUp', 'pDown', 'rsi', 'adx', 'atrPct', 'hurst', 'changePct', 'ouZ', 'ouHalfLife', 'ouTStat'] as const

const newScreener = (candles: Candle[]) => {
  const svc = new ScreenerService()
  ;(svc as unknown as { market: unknown }).market = {
    getCandles: (_a: string, _tf: Timeframe, n: number) => candles.slice(-n),
    assets: [{ ticker: 'PROBE', name: 'Probe Pair', category: 'forex', otc: false, open: true }],
    payoutFor: () => 0.85,
  }
  return svc
}
const newScreener2 = (candles: Candle[]) => {
  const svc = new Screener2Service()
  ;(svc as unknown as { market: unknown }).market = {
    getCandlesDeep: (_a: string, _tf: Timeframe, n: number) => candles.slice(-n),
    assets: [{ ticker: 'PROBE', name: 'Probe Pair', category: 'forex', otc: false, open: true }],
    payoutFor: () => 0.85,
  }
  return svc
}

// ---------- 1. the vector itself (why the guard exists) ----------
{
  console.log('the tail-glitch vector')
  const snap = scanSnapshot(tailNaN(), 'PROBE', '1m')
  ok(!Number.isFinite(snap.price), 'NaN tail close -> snapshot price is NaN')
  ok(!Number.isFinite(snap.atrPct) && !Number.isFinite(snap.changePct), 'atrPct + changePct poisoned too')
  ok(Number.isFinite(snap.score) && Number.isFinite(snap.confidence), 'score/confidence stay finite - the row looks tradeable')
}

// ---------- 2. screener scorePair fails closed ----------
{
  console.log('screener scorePair rejects non-finite cores')
  const e1 = throws(() => newScreener(tailNaN()).scorePair('PROBE', '1m'))
  ok(!!e1 && e1.message.includes('non-finite core'), `tail NaN close -> throws (${e1?.message ?? 'no throw'})`)
  ok(!!e1 && e1.message.includes('price'), 'error names the poisoned field (price)')
  const e2 = throws(() => newScreener(tailInf()).scorePair('PROBE', '1m'))
  ok(!!e2 && e2.message.includes('price'), 'tail Infinity close -> throws too (Number.isFinite covers Inf)')
  const svc = newScreener(tailNaN())
  throws(() => svc.scorePair('PROBE', '1m'))
  ok([...(svc as unknown as { rows: Map<string, unknown> }).rows.values()].length === 0, 'nothing stored - the garbage row never enters the feed')
}

// ---------- 3. screener scorePair accepts valid rows ----------
{
  console.log('screener scorePair keeps valid rows')
  const row = newScreener(healthy()).scorePair('PROBE', '1m')
  const bad = CORE_FIELDS.filter((k) => !Number.isFinite(row[k] as number))
  ok(bad.length === 0, `healthy walk -> every core field finite (bad: ${bad.join(',') || 'none'})`)
  const quiet = newScreener(flat()).scorePair('PROBE', '1m')
  const badQ = CORE_FIELDS.filter((k) => !Number.isFinite(quiet[k] as number))
  ok(badQ.length === 0, `flat tape (RSI 50 / ADX 0 neutral shape) -> still finite, NOT rejected`)
  const rescued = newScreener(midNaN()).scorePair('PROBE', '1m')
  const badM = CORE_FIELDS.filter((k) => !Number.isFinite(rescued[k] as number))
  ok(badM.length === 0, `mid-series glitch (last() walk-back rescues) -> still emitted`)
}

// ---------- 4. evaluate() propagation + cache path ----------
{
  console.log('evaluate propagation')
  const e = throws(() => newScreener(tailNaN()).evaluate('PROBE', '1m'))
  ok(!!e && e.message.includes('non-finite core'), 'evaluate with no cache -> throws, never returns a NaN row')
  const svc = newScreener(healthy())
  const stored = svc.scorePair('PROBE', '1m')
  const cached = svc.evaluate('PROBE', '1m')
  ok(cached === stored, 'cached finite row -> evaluate returns it unchanged (normal path intact)')
}

// ---------- 5. screener2 (confluence deep read) same contract ----------
{
  console.log('screener2 scorePair rejects non-finite cores')
  const e1 = throws(() => newScreener2(tailNaN()).scorePair('PROBE', '1m'))
  ok(!!e1 && e1.message.includes('non-finite core'), `tail NaN close -> confluence row rejected (${e1?.message ?? 'no throw'})`)
  const row = newScreener2(healthy()).scorePair('PROBE', '1m')
  ok(Number.isFinite(row.price) && Number.isFinite(row.score) && Number.isFinite(row.confidence), 'healthy walk -> confluence core finite, emitted')
  const quiet = newScreener2(flat()).scorePair('PROBE', '1m')
  ok(Number.isFinite(quiet.price) && Number.isFinite(quiet.score), 'flat tape -> confluence row still emitted (neutral is valid)')
}

// ---------- 6. top() purity ----------
{
  console.log('top() purity')
  const svc = newScreener(healthy())
  svc.scorePair('PROBE', '1m')
  const { rows } = svc.top({ limit: 50 })
  ok(rows.length === 1 && Number.isFinite(rows[0].price), 'top() serves only finite-core rows')
}

console.log(`\nnan_core_unit: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
