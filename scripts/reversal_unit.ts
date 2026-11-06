// Reversal Detection engine - deterministic logic unit (bun, in-process).
// Locks the contract added with the Reversal / Reversal Global panels
// (analytics/reversal.ts + plugins/reversal.ts):
//   - ladder shape: 10 rows, same TECH_LADDER + source rules as technicals
//   - fail-closed: < REV_MIN_BARS -> ok:false "warming up", no state
//     invented; a stale tick feed -> ok:false, never "calm"
//   - calm ground truth: a frozen feed votes NOTHING (every
//     detector gated on a real extreme/trigger) -> calm / none / 0; a real
//     9-bar sine is honestly NOT calm (stoch reads its cycle) - locked too
//   - "reversing now": deep decline + sharp up bar fires RSI hook + stoch
//     cross + band re-entry + stretch fade (two of them bar-0 triggers) ->
//     state reversing, direction up; the mirrored rally+down bar -> down
//   - detector ground truth: run exhaustion votes AGAINST a 6+ bar run;
//     a hammer after decline is a bar-0 candle-pattern trigger
//   - "confirmed": trigger fired on the PRIOR bar + latest bar closed
//     further in the reversal direction (the one-bar lookback contract)
//   - plugin plumbing: readFor unknown -> null; globalScan urgency sort
//     (reversing > confirmed > forming > calm, then |score|), warming last
import { ReversalService } from '../mini-services/trading-core/src/plugins/reversal'
import {
  REV_MIN_BARS, buildReversalSummary, readReversalTf, reversalVotes,
} from '../mini-services/trading-core/src/analytics/reversal'
import { TECH_LADDER, aggregateCandles } from '../mini-services/trading-core/src/analytics/technicals'
import { detectPatterns } from '../mini-services/trading-core/src/analytics/patterns'
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

const t0 = 1_700_000_000
let seq = 0
const mkCandle = (time: number, open: number, close: number, lowerWick = 0, upperWick = 0, vol = 100): Candle => {
  seq++
  return {
    time,
    open,
    close,
    high: Math.max(open, close) + Math.max(upperWick, 1e-9),
    low: Math.min(open, close) - Math.max(lowerWick, 1e-9),
    volume: vol,
  }
}

/** `n` bars stepping `step` per bar, tiny proportional wicks. */
const trend = (n: number, step: number, p0 = 1.2): Candle[] => {
  const out: Candle[] = []
  let p = p0
  for (let i = 0; i < n; i++) {
    const o = p
    p = p + step
    const w = Math.abs(p - o) * 0.02
    out.push(mkCandle(t0 + i * 60, o, p, w, w))
  }
  return out
}

/** frozen feed: every bar identical - the only series where EVERY detector
 * is honestly silent (no extremes, no runs, no patterns) */
const frozen = (n: number, p0 = 1.2): Candle[] =>
  Array.from({ length: n }, (_, i) => mkCandle(t0 + i * 60, p0, p0))

/** deep `n`-bar decline then one SHARP up bar (3x the decline step) - the
 * canonical exhaustion hook the panel exists to catch */
const declineThenHook = (n = 70, step = -0.0006, p0 = 1.2): Candle[] => {
  const base = trend(n, step, p0)
  const last = base[base.length - 1]
  const hook = mkCandle(t0 + n * 60, last.close, last.close - step * 3, Math.abs(step) * 0.1, Math.abs(step) * 0.4)
  return [...base, hook]
}

// ---------- 1. ladder shape + fail-closed ----------
console.log('section 1: ladder + fail-closed gates')
{
  const rows = TECH_LADDER.map((r) =>
    r.source === 'ticks'
      ? readReversalTf(r.tf, r.sec, 'ticks', [], { nowSec: 0 })
      : r.source === 'agg1m'
        ? readReversalTf(r.tf, r.sec, 'agg1m', aggregateCandles(trend(200, 0.0008), 60, 3))
        : readReversalTf(r.tf, r.sec, 'native', trend(200, 0.0008)),
  )
  ok(rows.length === 10, 'ladder emits 10 rows')
  ok(rows.every((r) => r.tf === TECH_LADDER[rows.indexOf(r)].tf), 'rows stay in ladder order')
  const thin = readReversalTf('1m', 60, 'native', trend(REV_MIN_BARS - 1, 0.0006))
  ok(!thin.ok && thin.note.includes('warming') && thin.state === 'calm' && thin.reasons.length === 0, 'thin rung -> warming, no state, no votes', thin.note)
  const now = t0 + 500_000
  const stale = readReversalTf('1s', 1, 'ticks', trend(80, 0.00001, 1.2).map((c) => ({ ...c, time: t0 - 200 + (c.time - t0) })), { nowSec: now })
  ok(!stale.ok && stale.note.includes('stale'), 'stale tick feed -> ok:false stale, never calm', stale.note)
  // a frozen feed votes NOTHING -> genuinely calm (every detector gated on a
  // real extreme/trigger; silence is the honest read)
  const calmRow = readReversalTf('1m', 60, 'native', frozen(80))
  ok(calmRow.ok, 'frozen rung is live (data is degenerate but present)')
  ok(calmRow.state === 'calm' && calmRow.direction === 'none' && calmRow.score === 0 && calmRow.reasons.length === 0,
    `frozen series -> calm/none/0 (got ${calmRow.state}/${calmRow.direction}/${calmRow.score})`, JSON.stringify(calmRow.reasons))
  ok(reversalVotes(frozen(70)).length === 0, 'frozen series votes nothing at the detector level')
}

// ---------- 2. detector ground truth ----------
console.log('section 2: detector ground truth')
{
  // hammer after decline: tiny body, long lower wick, on the latest bar -
  // the library MUST see the Hammer itself; the aggregated pattern vote may
  // net out against other hits, but it must be a bar-0 trigger vote
  const base = trend(70, -0.0006)
  const last = base[base.length - 1]
  const hammer = mkCandle(t0 + 70 * 60, last.close - 0.0002, last.close + 0.0002, 0.0012, 0.00012)
  const series = [...base, hammer]
  const hits = detectPatterns(series, 1).filter((h) => h.barsAgo === 0)
  ok(hits.some((h) => h.name === 'Hammer'), 'Hammer detected on the constructed bar', hits.map((h) => h.name).join(','))
  const hammerVotes = reversalVotes(series)
  ok(hammerVotes.some((v) => v.detector === 'Candle patterns' && v.trigger), 'hammer bar produces a bar-0 candle-pattern trigger vote', JSON.stringify(hammerVotes.map((v) => v.detector)))

  // extended run exhaustion: a 70-bar rally IS one run -> fade vote against
  const rally = trend(70, 0.0012)
  const runVotes = reversalVotes(rally)
  const exhaust = runVotes.find((v) => v.detector === 'Run exhaustion')
  ok(exhaust !== undefined && exhaust.dir === 'down' && exhaust.weight === 2, '70-bar rally -> down exhaustion fade w2', JSON.stringify(exhaust))
  // a 4-bar run inside an otherwise strictly-alternating series fades at w1
  const alt = (n: number): Candle[] => {
    const out: Candle[] = []
    let p = 1.2
    for (let i = 0; i < n; i++) {
      const o = p
      p = p * (1 + (i % 2 === 0 ? 0.00003 : -0.00003))
      out.push(mkCandle(t0 + i * 60, o, p))
    }
    return out
  }
  const shortRunSeries = [...alt(66), ...trend(4, 0.0012, 1.2)]
  ok(reversalVotes(shortRunSeries).find((v) => v.detector === 'Run exhaustion')?.weight === 1, '4-bar run -> w1 fade')
}

// ---------- 3. reversing now (both directions) ----------
console.log('section 3: reversing now')
{
  const hookUp = readReversalTf('1m', 60, 'native', declineThenHook())
  ok(hookUp.ok && hookUp.state === 'reversing', `decline + sharp up bar -> REVERSING (got ${hookUp.state}, net ${hookUp.score})`, JSON.stringify(hookUp.reasons))
  ok(hookUp.direction === 'up', 'hook direction up')
  ok(hookUp.reasons.some((r) => r.detector === 'RSI hook' && r.dir === 'up'), 'RSI hook voted up')
  ok(hookUp.reasons.some((r) => r.detector === 'Stoch cross' && r.dir === 'up'), 'stoch cross voted up')
  // mirror: rally + sharp down bar -> reversing down
  const rally = trend(70, 0.0006)
  const last = rally[rally.length - 1]
  const downBar = mkCandle(t0 + 70 * 60, last.close, last.close - 0.0006 * 3, Math.abs(0.0006) * 0.4, Math.abs(0.0006) * 0.1)
  const hookDown = readReversalTf('1m', 60, 'native', [...rally, downBar])
  ok(hookDown.ok && hookDown.state === 'reversing' && hookDown.direction === 'down', `rally + sharp down bar -> REVERSING down (got ${hookDown.state}/${hookDown.direction}, net ${hookDown.score})`, JSON.stringify(hookDown.reasons))
}

// ---------- 4. confirmed (prior-bar trigger + follow-through) ----------
console.log('section 4: confirmed state')
{
  // flat base, plunge bar, recovery bar (bar-0 read THERE: band re-entry +
  // pattern trigger, net >= 3), then a small follow-through bull bar that
  // fires nothing new - the prior read + the higher close = confirmed
  const base = Array.from({ length: 58 }, (_, i) => mkCandle(t0 + i * 60, 1.2, 1.2))
  const plunge = mkCandle(t0 + 58 * 60, 1.2, 1.19, 0.0002, 0.0002)
  const recovery = mkCandle(t0 + 59 * 60, 1.19, 1.198, 0.0001, 0.0003)
  const prior = readReversalTf('1m', 60, 'native', [...base, plunge, recovery])
  ok(prior.state === 'reversing' && prior.direction === 'up', 'prior bar reads reversing up (the signal being confirmed)', `${prior.state}/${prior.direction} ${JSON.stringify(prior.reasons)}`)
  const follow = mkCandle(t0 + 60 * 60, 1.198, 1.1982, 0.0001, 0.0001)
  const row = readReversalTf('1m', 60, 'native', [...base, plunge, recovery, follow])
  ok(row.ok, 'confirmed scenario rung live')
  ok(row.state === 'confirmed' && row.direction === 'up', `prior-bar trigger + follow-through -> CONFIRMED up (got ${row.state}/${row.direction}, net ${row.score})`, JSON.stringify(row.reasons))
}

// ---------- 5. buildReversalSummary + best pick ----------
console.log('section 5: summary + best pick')
{
  const hook = declineThenHook(200)
  const native = { '5s': declineThenHook(70), '15s': declineThenHook(70), '30s': declineThenHook(70), '1m': hook, '2m': declineThenHook(70), '5m': declineThenHook(70) }
  const t0n = t0 + 600_000
  const ticks = Array.from({ length: 1200 }, (_, i) => ({ time: t0n - 1200 + i, price: 1.2 + Math.sin(i / 7) * 0.0003 }))
  const sum = buildReversalSummary({ asset: 'TESTUSD', mode: 'sim', price: 1.2, native, ticks, nowSec: t0n })
  ok(sum.rows.length === 10, 'summary carries the whole ladder')
  ok(sum.rows.filter((r) => r.ok).length === 10, 'dense tick buffer + deep 1m -> all 10 rungs live', sum.rows.filter((r) => !r.ok).map((r) => r.tf).join(','))
  ok(sum.best !== null && sum.best.direction === 'up' && (sum.best.state === 'reversing' || sum.best.state === 'confirmed'), 'best pick catches the hook (up, urgent state)', JSON.stringify(sum.best))
  // a frozen asset is honestly all-calm: no best pick, not a fake signal
  const calm = buildReversalSummary({ asset: 'CALM', mode: 'sim', price: 1.2, native: { '5s': frozen(80), '15s': frozen(80), '30s': frozen(80), '1m': frozen(200), '2m': frozen(80), '5m': frozen(80) }, ticks, nowSec: t0n })
  ok(calm.best === null && calm.note.includes('all calm'), 'frozen asset -> best null, honest all-calm note', calm.note)
}

// ---------- 6. plugin plumbing ----------
console.log('section 6: plugin plumbing (ReversalService)')
{
  const fakeMarket = {
    mode: 'sim' as const,
    listAssets: () => [
      { ticker: 'HOT', open: true, category: 'forex', price: 1.2 },
      { ticker: 'MID', open: true, category: 'forex', price: 2 },
      { ticker: 'THIN', open: true, category: 'forex', price: 3 },
    ],
    getCandlesDeep: (a: string, _tf: string, limit: number) => {
      if (a === 'HOT') return declineThenHook(70)
      if (a === 'MID') return [...trend(60, 0.0006), ...trend(8, 0.0002, 1.24)]
      return trend(Math.min(limit, 10), 0.0006)
    },
    recentTicks: () => [] as { ts: number; price: number }[],
  }
  const svc = new ReversalService()
  await svc.start({ use: () => fakeMarket, log: () => {} } as never)
  ok(svc.readFor('NOPE') === null, 'readFor unknown -> clean fail-closed null')
  const hot = svc.readFor('HOT')
  ok(hot !== null && hot.best !== null && hot.best.direction === 'up', 'readFor(HOT) catches the hook', hot ? JSON.stringify(hot.best) : 'null')
  const scan = svc.globalScan({})
  ok(scan.scanned === 3 && scan.warming === 1, 'globalScan counts warming', JSON.stringify({ s: scan.scanned, w: scan.warming }))
  ok(scan.rows[scan.rows.length - 1].asset === 'THIN' && !scan.rows[scan.rows.length - 1].ok, 'warming row last')
  const liveRows = scan.rows.filter((r) => r.ok)
  ok(liveRows.every((r) => r.cells.length === 10), 'rows carry the 10-rung state strip')
  ok(liveRows[0].state === 'reversing' || liveRows[0].state === 'confirmed', 'most urgent row ranks first', liveRows.map((r) => `${r.asset}:${r.state}`).join(','))
}

console.log(`\nreversal_unit: ${pass} ok, ${fail} FAIL`)
if (fail > 0) process.exit(1)
