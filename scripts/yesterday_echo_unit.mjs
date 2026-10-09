#!/usr/bin/env bun
// Unit cross-check for the echo (lead-in comparison) in analytics/yesterday.
// Builds a synthetic candle series with ENGINEERED windows and asserts the
// kernel math reproduces the hand-computed moves/ranges/rhyme exactly:
//   - yesterday lead-in rises +0.40% with 0.80% travel
//   - today lead-in    rises +0.40% with 0.80% travel  -> same dir, same mag
//   - variant B: today lead-in FALLS -0.40%             -> opposite, rhyme 20
//   - variant C: thin today side (under half covered)   -> echo null
// Run: bun scripts/yesterday_echo_unit.mjs
import { buildPriorDay, buildYesterdayRow } from '../mini-services/trading-core/src/analytics/yesterday'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`) }
}

const TF = 60 // 1m bars, seconds
const WIN = 3600 // 60-minute windows
const DAY = 86_400
// anchor t0 must be the 1m bucket containing now-86400: pick nowSec = t0+86400+30
const t0 = 1_700_000_000 - (1_700_000_000 % TF)
const nowSec = t0 + DAY + 30

/** one closed 1m bar with the given open/close and a high/low box around both */
const bar = (time, open, close, wick = 0) => ({
  time, open, close,
  high: Math.max(open, close) + wick,
  low: Math.min(open, close) - wick,
  volume: 1,
})
/** a run of `n` bars drifting `pct`% total from `p`. Wicks are sized so the
 * window's high-low travel lands at `travel`% of the first open: the extremes
 * are last-close+wick and first-open-wick, so wick = p*(travel-|pct|)/200. */
function run(from, n, p, pct, travel) {
  const out = []
  const step = (p * pct / 100) / n
  const wick = Math.max(0, (p * (travel - Math.abs(pct)) / 100) / 2)
  let price = p
  for (let i = 0; i < n; i++) {
    const open = price
    price = open + step
    out.push(bar(from + i * TF, open, price, wick))
  }
  return out
}

const info = { ticker: 'TEST', name: 'Test Asset', category: 'forex', otc: false }
const base = 100

// engineered series:
//   [t0-WIN, t0)           yesterday lead-in: +0.40% move, 0.80% travel
//   [t0, t0+WIN)           yesterday replay window: dead flat
//   [t0+DAY-WIN, t0+DAY)   today lead-in: +0.40% move, 0.80% travel (variant A)
//   [t0+DAY, ...)          tail after the anchor (now-anchored, few bars)
const ydayLead = run(t0 - WIN, WIN / TF, base, 0.4, 0.8)
const ydayFwd = run(t0, WIN / TF, base * 1.004, 0.01, 0.02)
const todayLead = run(t0 + DAY - WIN, WIN / TF, base, 0.4, 0.8)
const tail = run(t0 + DAY, 2, base * 1.004, 0.01, 0.02)
const series = [...ydayLead, ...ydayFwd, ...todayLead, ...tail]

const opts = { nowSec, windowSec: WIN, tfSec: TF, nowPrice: base * 1.0042, archived: 0 }
const row = buildYesterdayRow(info, series, opts)

ok('row built', row !== null)
if (row) {
  const e = row.echo
  ok('echo present', e !== null, JSON.stringify(e))
  if (e) {
    ok('yday lead-in move reproduced', Math.abs(e.ydayMovePct - 0.4) < 0.01, `got ${e.ydayMovePct}`)
    ok('yday lead-in travel reproduced', Math.abs(e.ydayRangePct - 0.8) < 0.05, `got ${e.ydayRangePct}`)
    ok('today lead-in move reproduced', Math.abs(e.todayMovePct - 0.4) < 0.01, `got ${e.todayMovePct}`)
    ok('dirAgree same (both up, same magnitude)', e.dirAgree === 'same', `got ${e.dirAgree}`)
    ok('rhyme 100 when the lead-ins match', e.rhyme === 100, `got ${e.rhyme}`)
  }

  // variant B: today's lead-in falls -0.40% with the same travel -> opposite
  const down = run(t0 + DAY - WIN, WIN / TF, base, -0.4, 0.8)
  const seriesB = [...ydayLead, ...ydayFwd, ...down, ...tail]
  const rowB = buildYesterdayRow(info, seriesB, opts)
  const eB = rowB?.echo
  ok('variant B echo present', !!eB)
  if (eB) {
    ok('variant B dirAgree opposite', eB.dirAgree === 'opposite', `got ${eB.dirAgree}`)
    // dir 0 + mag 30*(1-0.8/0.8)=0 + vol 20 -> 20
    ok('variant B rhyme 20 (opposite dir, same travel)', eB.rhyme === 20, `got ${eB.rhyme}`)
  }

  // variant C: today's lead-in 70% missing (18 of 60 bars < half) -> echo null
  const thin = down.slice(0, Math.floor(down.length * 0.3))
  const seriesC = [...ydayLead, ...ydayFwd, ...thin, ...tail]
  const rowC = buildYesterdayRow(info, seriesC, opts)
  ok('variant C row still built (fwd window fine)', rowC !== null)
  ok('variant C echo null when a side is thin', rowC?.echo === null, JSON.stringify(rowC?.echo))

  // variant D: dead flat both sides -> rhyme 100, dirAgree same
  const flatY = run(t0 - WIN, WIN / TF, base, 0, 0)
  const flatT = run(t0 + DAY - WIN, WIN / TF, base, 0, 0)
  const flatFwd = run(t0, WIN / TF, base, 0.01, 0.02)
  const rowD = buildYesterdayRow(info, [...flatY, ...flatFwd, ...flatT, ...tail], opts)
  const eD = rowD?.echo
  ok('variant D flat/flat rhyme 100 + same', eD?.rhyme === 100 && eD?.dirAgree === 'same', JSON.stringify(eD))

  // ---- prior days: the same window at T-48h, T-72h, ... ----
  // sparse series: an ENGINEERED T-48h window (-0.60% move, 1.00% travel)
  // plus the variant-A pieces; T-72h and T-96h are intentionally ABSENT so
  // the gap-honesty rule can be asserted. back counts from NOW: nowSec =
  // t0 + DAY + 30, so T-48h buckets to t0 - DAY (not t0 - 2*DAY).
  const prior2Win = run(t0 - DAY, WIN / TF, base, -0.6, 1.0)
  const sparse = [...prior2Win, ...ydayLead, ...ydayFwd, ...todayLead, ...tail].sort((a, b) => a.time - b.time)
  const pd = buildPriorDay(info, sparse, { nowSec, windowSec: WIN, tfSec: TF, back: 2 })
  ok('prior day T-48h built', pd !== null)
  if (pd) {
    ok('prior day back/anchor correct', pd.back === 2 && pd.thenTs === t0 - DAY, `back=${pd.back} thenTs=${pd.thenTs} expected=${t0 - DAY}`)
    ok('prior day move reproduced', Math.abs(pd.movePct - -0.6) < 0.01, `got ${pd.movePct}`)
    ok('prior day travel reproduced', Math.abs(pd.rangePct - 1.0) < 0.05, `got ${pd.rangePct}`)
    ok('prior day dir down', pd.dir === 'down', `got ${pd.dir}`)
    ok('prior day coverage full', pd.barsFound === 60 && pd.barsExpected === 60, `${pd.barsFound}/${pd.barsExpected}`)
  }
  // through the row: priorDays 1 -> exactly the T-48h day; 3 -> still only
  // that one (T-72h/T-96h absent = honest gaps, never thin fills)
  const rowP1 = buildYesterdayRow(info, sparse, { ...opts, priorDays: 1 })
  ok('row.prior has the remembered day', rowP1?.prior.length === 1 && rowP1.prior[0].back === 2, JSON.stringify(rowP1?.prior))
  const rowP3 = buildYesterdayRow(info, sparse, { ...opts, priorDays: 3 })
  ok('row.prior skips uncovered days', rowP3?.prior.length === 1, `got ${rowP3?.prior.length} (backs ${rowP3?.prior.map((p) => p.back).join(',')})`)
  // a thin T-48h window (20 of 60 bars) is dropped by the same >= half gate
  const thinPrior = buildPriorDay(info, [...prior2Win.slice(0, 20)], { nowSec, windowSec: WIN, tfSec: TF, back: 2 })
  ok('thin prior day dropped', thinPrior === null, JSON.stringify(thinPrior))
  // days=1 default: rows carry an empty prior
  ok('default row.prior empty', Array.isArray(row?.prior) && row.prior.length === 0, JSON.stringify(row?.prior))

  // ---- prior-day ECHO: today's lead-in vs THAT day's lead-in ----
  // In `sparse` the T-48h FORWARD window is covered but its LEAD-IN
  // ([t0-DAY-WIN, t0-DAY)) is absent -> PriorDay present, echo null (a
  // missing comparison is honest, not an error).
  const pdSparse = buildPriorDay(info, sparse, { nowSec, windowSec: WIN, tfSec: TF, back: 2, todayLeadIn: null })
  ok('sparse prior built without today lead-in', pdSparse !== null && pdSparse.echo === null, JSON.stringify(pdSparse?.echo))
  // engineered T-48h lead-ins compared against TODAY's lead-in (+0.40%, 0.80%):
  //   identical lead-in -> dir 50 + mag 30 + vol 20 = 100, 'same'
  //   opposite (-0.40%, same travel) -> 0 + 30*(1-0.8/0.8) + 20 = 20, 'opposite'
  //   thin prior lead-in (18 of 60 bars) -> echo null, forward window still fine
  const todayStats = { movePct: 0.4, rangePct: 0.8, dir: 'up' }
  const priorLeadUp = run(t0 - DAY - WIN, WIN / TF, base, 0.4, 0.8)
  const priorLeadDown = run(t0 - DAY - WIN, WIN / TF, base, -0.4, 0.8)
  const prior2Fwd = run(t0 - DAY, WIN / TF, base, 0.01, 0.02)
  const pdUp = buildPriorDay(info, [...priorLeadUp, ...prior2Fwd, ...sparse].sort((a, b) => a.time - b.time), { nowSec, windowSec: WIN, tfSec: TF, back: 2, todayLeadIn: { stats: todayStats, barsFound: 60 } })
  ok('prior echo 100 on identical lead-ins', pdUp?.echo?.rhyme === 100 && pdUp?.echo?.dirAgree === 'same', JSON.stringify(pdUp?.echo))
  const pdDown = buildPriorDay(info, [...priorLeadDown, ...prior2Fwd, ...sparse].sort((a, b) => a.time - b.time), { nowSec, windowSec: WIN, tfSec: TF, back: 2, todayLeadIn: { stats: todayStats, barsFound: 60 } })
  ok('prior echo 20 on opposite-dir same-travel', pdDown?.echo?.rhyme === 20 && pdDown?.echo?.dirAgree === 'opposite', JSON.stringify(pdDown?.echo))
  const pdThin = buildPriorDay(info, [...priorLeadUp.slice(0, 18), ...prior2Fwd, ...sparse].sort((a, b) => a.time - b.time), { nowSec, windowSec: WIN, tfSec: TF, back: 2, todayLeadIn: { stats: todayStats, barsFound: 60 } })
  ok('prior echo null when the prior lead-in is thin', pdThin !== null && pdThin.echo === null, JSON.stringify(pdThin?.echo))
  // through the row: priorDays=1 wires today's lead-in automatically - the
  // remembered day carries its echo; with TODAY's side thin (variant C), the
  // prior echo is null too (today is the weak side in every comparison)
  const rowPriorEcho = buildYesterdayRow(info, [...priorLeadUp, ...prior2Fwd, ...sparse].sort((a, b) => a.time - b.time), { ...opts, priorDays: 1 })
  ok('row path: prior echo wired from today lead-in', rowPriorEcho?.prior[0]?.echo?.rhyme === 100 && rowPriorEcho?.prior[0]?.echo?.dirAgree === 'same', JSON.stringify(rowPriorEcho?.prior[0]?.echo))
  ok('row path: prior anchor is exactly t0 - DAY', rowPriorEcho?.prior[0]?.thenTs === t0 - DAY, `thenTs=${rowPriorEcho?.prior[0]?.thenTs} expected=${t0 - DAY}`)
  const seriesThinToday = [...ydayLead, ...ydayFwd, ...thin, ...tail]
  const rowThinToday = buildYesterdayRow(info, [...priorLeadUp, ...prior2Fwd, ...seriesThinToday].sort((a, b) => a.time - b.time), { ...opts, priorDays: 1 })
  ok('thin today side silences the prior echo too', rowThinToday?.prior[0]?.echo === null, JSON.stringify(rowThinToday?.prior[0]?.echo))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
