// Edge semantics - deterministic logic unit (bun).
// Locks the one primitive every fresh-condition gate rides on:
//   - edgePhase: the transition table (none->dir = entered, same = held,
//     opposite = flip, cur none = null)
//   - evalWithEdge: prev-bar re-evaluation wiring + ageBars walk (held only)
//   - diffEdges: the chart-scanner's registry (boot backfill, entered on
//     reappearance, observed flip, lapse cleanup)
//   - TTL anchoring: buildChartSignal's validUntil runs from the BAR END,
//     not the scan time, and ageSec measures real data lag
//   - spot backtest edgeTrigger parity: a persisting condition re-enters
//     only after a real lapse/flip (bot semantics), not after every exit
import { edgePhase, evalWithEdge, MAX_AGE_BARS } from '../mini-services/trading-core/src/analytics/edge'
import { buildChartSignal, diffEdges, type EdgeState } from '../mini-services/trading-core/src/analytics/chartsignals'
import { backtest } from '../mini-services/trading-core/src/strategies/backtest'
import type { Candle } from '../mini-services/trading-core/src/types'

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) {
    pass++
    console.log('  ok', name)
  } else {
    fail++
    console.log('  FAIL', name)
  }
}

// ---------- edgePhase: the transition table ----------
{
  console.log('edgePhase transitions')
  ok(edgePhase('none', 'call') === 'entered', 'none -> call = entered')
  ok(edgePhase('none', 'put') === 'entered', 'none -> put = entered')
  ok(edgePhase('call', 'call') === 'held', 'call -> call = held (already true)')
  ok(edgePhase('put', 'put') === 'held', 'put -> put = held (already true)')
  ok(edgePhase('call', 'put') === 'flip', 'call -> put = flip')
  ok(edgePhase('put', 'call') === 'flip', 'put -> call = flip')
  ok(edgePhase('call', 'none') === null, 'cur none = no edge to classify')
  ok(edgePhase('none', 'none') === null, 'none -> none = null')
}

// ---------- evalWithEdge: prev-bar wiring + age walk ----------
{
  console.log('evalWithEdge')
  // level-shaped condition: call while close < 100, else none (like RSI
  // reversion: the LEVEL is true, the wrapper classifies the transition)
  const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
    time: 1_700_000_000 + i * 60,
    open: 100, high: 101, low: 99,
    close: i < 30 ? 105 : 95, // condition true for the last 10 bars
    volume: 1,
  }))
  const evaluate = (cs: Candle[]) => (cs.length && cs[cs.length - 1].close < 100 ? { direction: 'call' as const, score: 60, notes: 'below level' } : { direction: 'none' as const, score: 0, notes: 'above level' })
  const ev = evalWithEdge(evaluate, candles)
  ok(ev.direction === 'call' && ev.phase === 'held', 'condition true for 10 bars reads held, not entered')
  ok(ev.ageBars === 10, `ageBars counts the exact streak (got ${ev.ageBars}, want 10)`)

  const fresh = evalWithEdge(evaluate, [...candles.slice(0, 30), { ...candles[30], close: 95 }])
  ok(fresh.phase === 'entered' && fresh.ageBars === 1, 'first true bar = entered, age 1')

  // flip: opposite direction on the prior bar (ALL bars above the level
  // except the last one, so prev = put, cur = call)
  const flipEval = (cs: Candle[]) => (cs.length && cs[cs.length - 1].close < 100 ? { direction: 'call' as const, score: 60, notes: '' } : { direction: 'put' as const, score: 50, notes: '' })
  const flipCandles: Candle[] = candles.map((c, i) => (i === 39 ? { ...c, close: 95 } : { ...c, close: 105 }))
  const flipped = evalWithEdge(flipEval, flipCandles)
  ok(flipped.phase === 'flip' && flipped.ageBars === 1, 'opposite prior direction = flip, age 1')

  // quiet condition carries no phase
  const quiet = evalWithEdge(evaluate, candles.slice(0, 20))
  ok(quiet.direction === 'none' && quiet.phase === undefined, 'none eval carries no phase')

  // age walk caps at MAX_AGE_BARS (deep repeats all tell the same story)
  const longStreak: Candle[] = Array.from({ length: 60 }, (_, i) => ({ time: 1_700_000_000 + i * 60, open: 100, high: 101, low: 99, close: 95, volume: 1 }))
  const capped = evalWithEdge(evaluate, longStreak)
  ok(capped.ageBars === MAX_AGE_BARS + 1, `deep streak caps at ${MAX_AGE_BARS}+ (got ${capped.ageBars})`)

  // single-bar history: first visible bar is by definition an entry
  const one = evalWithEdge(evaluate, [candles[30]])
  ok(one.phase === 'entered', 'single-bar window = entered')
}

// ---------- diffEdges: the chart-scanner registry ----------
{
  console.log('diffEdges registry')
  const reg = new Map<string, EdgeState>()
  const NOW = 1_700_000_500_000

  // first scan = boot backfill: nothing may look fresh
  const scan1 = [
    { asset: 'EURUSD', direction: 'call' as const, barTs: 1_700_000_400 },
    { asset: 'GBPUSD', direction: 'put' as const, barTs: 1_700_000_400 },
  ]
  let meta = diffEdges(reg, scan1, NOW)
  ok(meta.get('EURUSD')?.phase === 'held' && meta.get('EURUSD')?.backfilled === true, 'first scan: held + backfilled (boot cannot know the age)')
  ok(meta.get('EURUSD')?.firstSeenTs === 1_700_000_400_000, 'backfilled firstSeen anchored at the bar, not the scan')

  // second scan, same reads = held (not entered), backfill flag survives
  meta = diffEdges(reg, scan1, NOW + 60_000)
  ok(meta.get('EURUSD')?.phase === 'held' && meta.get('EURUSD')?.backfilled === true, 'same read next scan: still held, still backfilled')

  // new asset appears = a genuine entered
  meta = diffEdges(reg, [...scan1, { asset: 'XAUUSD', direction: 'call' as const, barTs: 1_700_000_460 }], NOW + 120_000)
  ok(meta.get('XAUUSD')?.phase === 'entered' && meta.get('XAUUSD')?.backfilled === false, 'new qualifying asset = entered, not backfilled')

  // observed flip = a REAL fresh edge even for a backfilled read
  meta = diffEdges(reg, [{ asset: 'EURUSD', direction: 'put' as const, barTs: 1_700_000_460 }, scan1[1]], NOW + 180_000)
  ok(meta.get('EURUSD')?.phase === 'flip' && meta.get('EURUSD')?.backfilled === false, 'direction change = flip (both sides observed)')
  ok(meta.get('EURUSD')?.firstSeenTs === NOW + 180_000, 'flip restarts the spell clock at the scan that saw it')

  // lapse: drop from the registry; reappearance = fresh entry again
  meta = diffEdges(reg, [{ asset: 'EURUSD', direction: 'put' as const, barTs: 1_700_000_460 }], NOW + 240_000)
  ok(meta.get('GBPUSD') === undefined, 'lapsed read: no meta (it is gone, not held)')
  meta = diffEdges(reg, [{ asset: 'EURUSD', direction: 'put' as const, barTs: 1_700_000_460 }, { asset: 'GBPUSD', direction: 'put' as const, barTs: 1_700_000_470 }], NOW + 300_000)
  ok(meta.get('GBPUSD')?.phase === 'entered' && meta.get('GBPUSD')?.backfilled === false, 'reappearance after lapse = fresh entry')
}

// ---------- buildChartSignal: barTs / ageSec / TTL anchored to the bar ----------
{
  console.log('chart signal freshness')
  const info = { ticker: 'EURUSD', name: 'Euro', category: 'forex', otc: false, pip: 5 }
  // deterministic uptrend: enough history for the 40-candle floor
  const candles: Candle[] = Array.from({ length: 240 }, (_, i) => ({
    time: 1_700_000_000 + i * 60,
    open: 100 + i * 0.1, high: 100.8 + i * 0.1, low: 99.8 + i * 0.1, close: 100.5 + i * 0.1, volume: 10,
  }))
  const SCAN = (candles[candles.length - 1].time + 60) * 1000 + 3_000 // 3s after bar end
  const sig = buildChartSignal(info, candles, { now: SCAN, ttlSec: 150, tfSec: 60 })
  ok(sig !== null, 'signal built')
  if (sig) {
    ok(sig.barTs === candles[candles.length - 1].time, 'barTs = last closed candle open time')
    ok(sig.ageSec === 3, `ageSec = scan lag behind the bar end (got ${sig.ageSec}, want 3)`)
    ok(sig.validUntil === (candles[candles.length - 1].time + 60) * 1000 + 150_000, 'TTL anchored to the BAR END + ttl, not the scan time')
    // late scan against an old bar: honest shorter life, visible age
    const LATE = SCAN + 100_000
    const stale = buildChartSignal(info, candles, { now: LATE, ttlSec: 150, tfSec: 60 })
    ok(stale !== null && stale.ageSec === 103, 'late scan shows the true data lag (103s)')
    ok(stale !== null && stale.validUntil === sig.validUntil, 'late scan does NOT extend the read life')
  }
}

// ---------- spot backtest edgeTrigger parity ----------
{
  console.log('spot backtest edge parity')
  // ema-trend fixture: a steady rise = 'call' that PERSISTS across exits
  // (level condition), a choppy zigzag collapses ADX = genuine 'none' lapse.
  // Path: flat warmup / rise (condition true, position cycles via maxBars) /
  // zigzag lapse / rise again -> with edgeTrigger the persisting condition
  // enters ONCE per episode (2 total), legacy re-enters after every exit.
  const path: number[] = []
  for (let i = 0; i < 40; i++) path.push(100) // warmup flat
  for (let i = 1; i <= 120; i++) path.push(100 + i * 0.3) // rising leg 1
  for (let i = 0; i < 50; i++) path.push(i % 2 === 0 ? 136.4 : 135.6) // choppy lapse (ADX collapses)
  for (let i = 1; i <= 120; i++) path.push(136 + i * 0.3) // rising leg 2
  const candles: Candle[] = path.map((c, i) => ({ time: 1_700_000_000 + i * 60, open: c, high: c + 0.2, low: c - 0.2, close: c, volume: 1 }))
  // adx 25: steady rise clears it (call persists), the choppy zigzag drops
  // below it (genuine 'none' lapse between the two episodes)
  const base = { asset: 'FIX', tf: '1m' as const, strategy: 'ema-trend', params: { fast: 9, slow: 21, adx: 25 }, startEquity: 1000, amount: 10, warmupBars: 50, maxBars: 2, tpPct: 0.001, slPct: 100 }
  // edgeTrigger ON: entries only on fresh edges -> one per episode
  const on = backtest(candles, 'FIX', '1m', { ...base, mode: 'spot', edgeTrigger: true })
  const onEntries = on.trades.length
  ok(onEntries === 2, `edgeTrigger spot: persisting condition enters once per episode (got ${onEntries}, want 2)`)
  ok(on.trades.every((t) => t.side === 'call'), 'both episodes read the same level condition')
  // edgeTrigger OFF: legacy every-bar behavior re-enters after every exit
  const off = backtest(candles, 'FIX', '1m', { ...base, mode: 'spot', edgeTrigger: false })
  ok(off.trades.length > onEntries, `edgeTrigger off re-enters every cycle (${off.trades.length} > ${onEntries})`)
  // binary mode keeps its own Task-58 semantics: same episode discipline
  const bin = backtest(candles, 'FIX', '1m', { ...base, mode: 'binary', edgeTrigger: true, expiryBars: 1, payout: 0.85 })
  ok(bin.trades.length === 2, `binary edgeTrigger: same episode count (got ${bin.trades.length}, want 2)`)
}

console.log(`\n${pass} checks passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
