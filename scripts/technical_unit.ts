// Technical Summary engine - deterministic logic unit (bun, in-process).
// Locks the contract added with the Technical / Technical Global panels
// (analytics/technicals.ts + plugins/technical.ts + plugins/ladderdata.ts):
//   - ladder shape: always 10 rows, 1s..5m in order, sources ticks/native/
//     native/native/native/native/native/native/agg1m/native
//   - verdict mapping: +/- thresholds at 0.15 / 0.5, counts disclosed,
//     counted excludes n/a votes
//   - directional ground truth: a strong monotonic uptrend reads BUY or
//     STRONG BUY on every mature native rung; a downtrend mirrors it
//   - bar builders: barsFromTicks buckets by epoch-second (re-polls
//     identical, ticksPerBar honest), aggregateCandles 3x1m buckets by
//     time%180 and DROPS the still-forming trailing bucket
//   - fail-closed: < TECH_MIN_BARS -> ok:false "warming up", no verdict
//     invented; a stale tick feed -> ok:false, never "neutral"
//   - warmup honesty: on a short series the MA200 vote is n/a (excluded
//     from counted), not a fake neutral
//   - plugin plumbing: summaryFor('NOPE') -> null (clean fail-closed),
//     globalScan rows TTL-cached + sorted by |score| with warming last
import { TechnicalService } from '../mini-services/trading-core/src/plugins/technical'
import { gatherLadder } from '../mini-services/trading-core/src/plugins/ladderdata'
import {
  TECH_LADDER, TECH_MIN_BARS, aggregateCandles, barsFromTicks, buildTechnicalSummary,
  consensusFromScores, summarizeTf, verdictFromVotes,
} from '../mini-services/trading-core/src/analytics/technicals'
import type { Candle } from '../mini-services/trading-core/src/types'

let pass = 0
let fail = 0
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    pass++
    console.log('  ok', name)
  } else {
    fail++
    console.log('  FAIL', name, detail)
  }
}

// ---------- deterministic candle builders ----------
const mkCandle = (time: number, open: number, close: number, vol = 100): Candle => {
  const wick = Math.max(Math.abs(close - open) * 0.02, 1e-9) // wick proportional to body: no artificial oscillator noise
  return {
    time,
    open,
    high: Math.max(open, close) + wick,
    low: Math.min(open, close) - wick,
    close,
    volume: vol,
  }
}

/** additive constant-step trend (every body strictly same direction, no
 * noise) - clean ground truth AND an exact up/down mirror pair: every MA
 * must sit below (uptrend) / above (downtrend) price, momentum oscillators
 * must lean with the trend. Hull MA(9) intentionally LEADS (its
 * extrapolation overshoots), so the test tolerates that one vote. */
const trend = (n: number, step: number, p0 = 1.2, t0 = 1_700_000_000): Candle[] => {
  const out: Candle[] = []
  let p = p0
  for (let i = 0; i < n; i++) {
    const o = p
    p = p + step
    out.push(mkCandle(t0 + i * 60, o, p))
  }
  return out
}

// ---------- 1. ladder shape ----------
console.log('section 1: ladder shape')
{
  const ups = trend(300, 0.0012)
  const rows = TECH_LADDER.map((r) =>
    r.source === 'ticks'
      ? summarizeTf(r.tf, r.sec, 'ticks', [], { nowSec: 0 })
      : r.source === 'agg1m'
        ? summarizeTf(r.tf, r.sec, 'agg1m', aggregateCandles(ups, 60, 3))
        : summarizeTf(r.tf, r.sec, 'native', ups),
  )
  ok(rows.length === 10, 'ladder emits 10 rows', String(rows.length))
  ok(TECH_LADDER.map((r) => r.tf).join(',') === '1s,2s,3s,5s,15s,30s,1m,2m,3m,5m', 'ladder order + labels')
  ok(TECH_LADDER.filter((r) => r.source === 'ticks').map((r) => r.tf).join(',') === '1s,2s,3s', 'seconds rungs are tick-built')
  ok(TECH_LADDER.find((r) => r.tf === '3m')?.source === 'agg1m', '3m is the aggregated rung')
  ok(TECH_LADDER.find((r) => r.tf === '3m')?.sec === 180 && TECH_LADDER.find((r) => r.tf === '5m')?.sec === 300, 'rung seconds correct')
  ok(rows.every((r) => r.osc.length === 11 || !r.ok), 'oscillator panel = 11 votes on live rungs', String(rows[3]?.osc.length))
  ok(rows.every((r) => r.mas.length === 15 || !r.ok), 'MA panel = 15 votes on live rungs', String(rows[3]?.mas.length))
}

// ---------- 2. directional ground truth ----------
console.log('section 2: directional ground truth')
{
  const ups = trend(300, 0.0015)
  const downs = trend(300, -0.0015)
  const upRow = summarizeTf('1m', 60, 'native', ups)
  const dnRow = summarizeTf('1m', 60, 'native', downs)
  ok(upRow.ok && upRow.summary.label === 'STRONG BUY', `uptrend -> STRONG BUY (got ${upRow.summary.label} ${upRow.summary.score.toFixed(2)})`)
  ok(dnRow.ok && dnRow.summary.label === 'STRONG SELL', `downtrend -> STRONG SELL (got ${dnRow.summary.label} ${dnRow.summary.score.toFixed(2)})`)
  ok(upRow.maSummary.sells <= 1, 'uptrend: at most the leading Hull MA votes sell', JSON.stringify(upRow.mas.filter((v) => v.read === 'sell').map((v) => v.name)))
  ok(dnRow.maSummary.buys <= 1, 'downtrend: at most the leading Hull MA votes buy')
  ok(upRow.summary.score >= 0.5 && dnRow.summary.score <= -0.5, 'scores clear the strong band')
  // mirror symmetry: the additive trend pair is an exact mirror, so the two
  // verdicts must (approximately) cancel - a one-sided gauge bias would
  // break this
  ok(Math.abs(upRow.summary.score + dnRow.summary.score) <= 0.15, `up/down verdicts mirror (up ${upRow.summary.score.toFixed(2)} vs dn ${dnRow.summary.score.toFixed(2)})`)
}

// ---------- 3. verdict mapping ----------
console.log('section 3: verdict mapping')
{
  const v = (b: number, s: number, c: number) => verdictFromVotes(b, s, c).label
  ok(v(10, 0, 10) === 'STRONG BUY', 'unanimous buy -> STRONG BUY')
  ok(v(6, 4, 10) === 'BUY', '60/40 (score 0.2) -> BUY')
  ok(v(5, 5, 10) === 'NEUTRAL', 'even split -> NEUTRAL')
  ok(v(4, 6, 10) === 'SELL', '40/60 (score -0.2) -> SELL')
  ok(v(0, 10, 10) === 'STRONG SELL', 'unanimous sell -> STRONG SELL')
  ok(v(0, 0, 0) === 'NEUTRAL' && verdictFromVotes(0, 0, 0).score === 0, 'no counted votes -> honest 0 neutral')
  // n/a exclusion: counted only counts real votes
  const va = verdictFromVotes(3, 0, 5)
  ok(va.counted === 5 && va.neutrals === 2, 'neutral votes counted, n/a never enters', JSON.stringify(va))
  // consensus: plain mean of scores
  const cs = consensusFromScores([0.6, -0.2, 0.2])
  ok(Math.abs(cs.score - 0.2) < 1e-9, 'consensus = mean of rung scores', cs.score.toFixed(3))
  ok(cs.label === 'BUY', 'consensus label follows the mean', cs.label)
  ok(consensusFromScores([]).counted === 0, 'empty consensus -> counted 0')
}

// ---------- 4. bar builders ----------
console.log('section 4: tick bars + aggregation')
{
  // 10 Hz ticks for 30s -> 30 x 1s bars, mean 10 ticks/bar; re-poll identical.
  // t0 is epoch-aligned to 1s AND 2s AND 3s so bucket counts are exact.
  const t0 = 1_699_999_998
  ok(t0 % 1 === 0 && t0 % 2 === 0 && t0 % 3 === 0, 't0 aligned to 1s/2s/3s buckets')
  const points = Array.from({ length: 300 }, (_, i) => ({ time: t0 + i / 10, price: 1.2 + Math.sin(i / 25) * 0.001 }))
  const a = barsFromTicks(points, 1)
  ok(a.bars.length === 30, `1s bars from 10Hz stream = 30 (got ${a.bars.length})`)
  ok(Math.abs(a.ticksPerBar - 10) < 1e-9, 'ticksPerBar = 10.0', String(a.ticksPerBar))
  ok(a.bars.every((b) => Number.isFinite(b.open) && Number.isFinite(b.close) && b.volume === 10), 'every bar finite, volume = observation count')
  const b = barsFromTicks(points, 1)
  ok(JSON.stringify(a.bars) === JSON.stringify(b.bars), 're-poll produces identical bars (bucket-aligned)')
  // 2s / 3s bars from the same stream
  ok(barsFromTicks(points, 2).bars.length === 15, '2s bars = 15')
  ok(barsFromTicks(points, 3).bars.length === 10, '3s bars = 10')
  // garbage ticks skipped, never crash
  ok(barsFromTicks([{ time: NaN, price: 1 }, { time: t0, price: -5 }, ...points], 1).bars.length === 30, 'non-finite / non-positive ticks dropped')

  // 3m from 1m: bucket by time%180, trailing partial bucket dropped.
  // t0 aligned to 180s so every bucket starts full.
  const base = 1_699_999_920
  ok(base % 180 === 0, 'base aligned to 3m buckets')
  const oneMin = Array.from({ length: 152 }, (_, i) => mkCandle(base + i * 60, 1.2, 1.2 + i * 0.0001))
  const agg = aggregateCandles(oneMin, 60, 3)
  ok(agg.length === 50, `152 x 1m -> 50 complete 3m bars (partial dropped, got ${agg.length})`, String(agg.length))
  ok(agg.every((c) => c.time % 180 === 0), 'every aggregated bar is bucket-aligned to 180s')
  ok(Math.abs(agg[0].close - oneMin[2].close) < 1e-12, 'first 3m bar closes with the 3rd 1m bar')
  ok(Math.abs(agg[0].high - Math.max(...oneMin.slice(0, 3).map((c) => c.high))) < 1e-12, 'aggregated high = max of members')
  ok(Math.abs(agg[0].volume - (oneMin[0].volume + oneMin[1].volume + oneMin[2].volume)) < 1e-9, 'aggregated volume sums members')
  // the 153rd bar completes the trailing bucket -> 51
  const oneMin2 = [...oneMin, mkCandle(base + 152 * 60, 1.2, 1.3)]
  ok(aggregateCandles(oneMin2, 60, 3).length === 51, 'a completed trailing bucket is kept', String(aggregateCandles(oneMin2, 60, 3).length))
}

// ---------- 5. fail-closed gates ----------
console.log('section 5: fail-closed gates')
{
  const thin = trend(TECH_MIN_BARS - 1, 0.001)
  const row = summarizeTf('1m', 60, 'native', thin)
  ok(!row.ok && row.note.includes('warming'), 'thin rung -> warming, no verdict', row.note)
  ok(row.summary.counted === 0 && row.osc.length === 0, 'thin rung votes nothing')
  // stale tick feed -> ok:false, never neutral
  const now = 1_700_100_000
  const staleTicks = Array.from({ length: 100 }, (_, i) => ({ time: now - 120 - i, price: 1.2 }))
  const srow = summarizeTf('1s', 1, 'ticks', barsFromTicks(staleTicks, 1).bars, { nowSec: now })
  ok(!srow.ok && srow.note.includes('stale'), 'stale tick feed -> ok:false stale note', srow.note)
  // warmup honesty: short-but-mature series excludes MA200 instead of faking neutral
  const mid = trend(90, 0.0012)
  const mrow = summarizeTf('1m', 60, 'native', mid)
  ok(mrow.ok, '90-bar rung is live')
  const ma200 = mrow.mas.find((v) => v.name === 'SMA(200)')
  ok(ma200?.read === 'na' && ma200.value === '—', 'SMA(200) is n/a on a 90-bar rung (excluded, not fake-neutral)', JSON.stringify(ma200))
  ok(mrow.mas.find((v) => v.name === 'EMA(10)')?.read === 'buy', 'EMA(10) still votes on a 90-bar rung')
  ok(mrow.maSummary.counted === mrow.mas.filter((v) => v.read !== 'na').length, 'counted excludes n/a votes')
}

// ---------- 6. buildTechnicalSummary end-to-end ----------
console.log('section 6: buildTechnicalSummary')
{
  const ups = trend(300, 0.0012)
  const t0 = 1_700_100_000
  const ticks = Array.from({ length: 1200 }, (_, i) => ({ time: t0 - 1200 + i, price: 1.2 + i * 1e-6 }))
  const native = { '5s': ups, '15s': ups, '30s': ups, '1m': ups, '2m': ups, '5m': ups }
  const sum = buildTechnicalSummary({ asset: 'TESTUSD', mode: 'sim', price: ups[ups.length - 1].close, native, ticks, nowSec: t0 })
  ok(sum.rows.length === 10, 'summary carries the whole ladder')
  ok(sum.rows.filter((r) => r.ok).length === 10, 'dense 1Hz tick buffer makes ALL 10 rungs live (1200s of ticks)', String(sum.rows.filter((r) => r.ok).length))
  ok(sum.rows.every((r) => r.tf === TECH_LADDER[sum.rows.indexOf(r)].tf), 'rows stay in ladder order')
  ok(sum.direction === 'call', 'unanimous uptrend -> direction call', sum.direction)
  ok(sum.overall.score > 0.15 && sum.overall.label !== 'NEUTRAL', 'overall consensus reads bullish', `${sum.overall.label} ${sum.overall.score.toFixed(2)}`)
  ok(sum.rows.find((r) => r.tf === '3m')?.source === 'agg1m', '3m row discloses its aggregation')
  // a short tick buffer leaves the seconds rungs warming, native rungs live
  const shortSum = buildTechnicalSummary({ asset: 'TESTUSD', mode: 'sim', price: 1.2, native, ticks: ticks.slice(-30), nowSec: t0 })
  ok(shortSum.rows.filter((r) => r.ok).length === 7, '30 ticks -> 7 live rungs, 3 seconds rungs warming', String(shortSum.rows.filter((r) => r.ok).length))
  ok(shortSum.rows.filter((r) => r.source === 'ticks').every((r) => !r.ok && r.note.includes('warming')), 'seconds rungs say warming, not neutral')
  // stale/warming seconds rungs never fake reads: the 1s rung has 50 bars
  // (past the warm gate) so it reads STALE; 2s/3s are thinner so they read
  // WARMING - both must be ok:false, neither may claim a verdict
  const staleSum = buildTechnicalSummary({ asset: 'TESTUSD', mode: 'sim', price: 1.2, native, ticks: ticks.slice(0, 50).map((p, i) => ({ ...p, time: t0 - 5000 + i })), nowSec: t0 })
  const tickRows = staleSum.rows.filter((r) => r.source === 'ticks')
  ok(tickRows.every((r) => !r.ok), 'stale tick rungs all ok:false')
  ok(tickRows.find((r) => r.tf === '1s')?.note.includes('stale') === true, '1s rung (50 bars) reads stale')
  ok(tickRows.filter((r) => r.tf !== '1s').every((r) => r.note.includes('warming')), 'thinner 2s/3s rungs read warming')
}

// ---------- 7. plugin plumbing ----------
console.log('section 7: plugin plumbing (TechnicalService)')
{
  const fakeMarket = {
    mode: 'sim' as const,
    listAssets: () => [
      { ticker: 'AAA', open: true, category: 'forex', price: 1.2 },
      { ticker: 'BBB', open: true, category: 'forex', price: 2 },
      { ticker: 'CCC', open: true, category: 'forex', price: 3 },
    ],
    getCandlesDeep: (a: string, _tf: string, limit: number) =>
      a === 'CCC' ? trend(Math.min(limit, 10), 0.001) : trend(limit, a === 'AAA' ? 0.0012 : -0.0008),
    recentTicks: () => [] as { ts: number; price: number }[],
  }
  const ctxStub = { use: () => fakeMarket, log: () => {} } as never
  const svc = new TechnicalService()
  await svc.start(ctxStub)

  // gatherLadder: unknown asset -> clean null
  ok(gatherLadder(fakeMarket as never, 'NOPE') === null, 'gatherLadder null for unknown asset')
  const data = gatherLadder(fakeMarket as never, 'AAA')
  ok(data !== null && Object.keys(data.native).length === 6 && data.native['1m'].length >= 300, 'gatherLadder pulls 6 native TFs + deep 1m')
  ok(data !== null && Array.isArray(data.ticks) && data.nowSec > 0 && data.mode === 'sim', 'gatherLadder carries ticks + nowSec + mode')

  // summaryFor through the real service: live uptrend verdict, unknown -> null
  const sum = svc.summaryFor('AAA')
  ok(sum !== null && sum.asset === 'AAA' && sum.direction === 'call', 'summaryFor(AAA) live call verdict', sum ? `${sum.overall.label}` : 'null')
  ok(svc.summaryFor('NOPE') === null, 'summaryFor unknown -> clean fail-closed null')

  // globalScan: conviction sort (|score| desc), warming rows last
  const scan = svc.globalScan({})
  ok(scan.scanned === 3 && scan.live === 2 && scan.warming === 1, 'globalScan counts live + warming', JSON.stringify({ s: scan.scanned, l: scan.live, w: scan.warming }))
  ok(scan.rows[0].ok && scan.rows[1].ok && !scan.rows[2].ok && scan.rows[2].asset === 'CCC', 'live rows first, warming last', JSON.stringify(scan.rows.map((r) => [r.asset, r.ok])))
  ok(Math.abs(scan.rows[0].overall.score) >= Math.abs(scan.rows[1].overall.score), 'live rows sorted by |score| desc', JSON.stringify(scan.rows.map((r) => r.overall.score)))
  ok(scan.rows[0].cells.length === 10, 'board row carries the 10-rung strip')
  ok(scan.rows[2].ok === false && scan.rows[2].note.length > 0, 'warming row carries its honest note')
}

console.log(`\ntechnical_unit: ${pass} ok, ${fail} FAIL`)
if (fail > 0) process.exit(1)
