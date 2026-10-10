#!/usr/bin/env bun
// Unit cross-check for the echo (lead-in comparison) in analytics/yesterday.
// Builds a synthetic candle series with ENGINEERED windows and asserts the
// kernel math reproduces the hand-computed moves/ranges/rhyme exactly:
//   - yesterday lead-in rises +0.40% with 0.80% travel
//   - today lead-in    rises +0.40% with 0.80% travel  -> same dir, same mag
//   - variant B: today lead-in FALLS -0.40%             -> opposite, rhyme 20
//   - variant C: thin today side (under half covered)   -> echo null
//   - quiet: dead-flat / near-flat both sides           -> quiet true, aggregates' problem
//   - session profile: the SAME adjacent-day lead-in echo scored at every
//     hour of the day (engineered lead-ins at known UTC hours) -> per-session
//     buckets (obs/quiet/avg), future today-side skip, dark-session zeros,
//     -OTC collapse, quiet exclusion, row-path wiring, and the HOURS each
//     bucket's average is fed by (SessionRhyme.hours - non-quiet slots only,
//     dark sessions empty) plus the fmtHours run-length form the panel's
//     tooltips spell them out with
//   - watchlist snapshot: the ranking comparators (rhyme/week/peak orders,
//     quiet exclusion, sink sentinels) and the serializer (header fields,
//     cap, conditional columns, quiet marker, peak/spread cell, off-hours
//     off* marker, per-row script sub-lines, exact round-trip of the row
//     numbers) against src/lib/os/watchlist.ts - the REAL shipped module,
//     imported straight from the web tree
//   - snapshot roundtrip: parseWatchlist reads the shape back out of the
//     serializer's own text (selection + sort + scope, never the numbers),
//     refuses non-snapshots and empty ones with a reason, keeps script
//     sub-lines / key row / legend from leaking in as rows, dedupes by
//     best rank, ranks by the written index and degrades honestly on a
//     trimmed or hand-edited header
// Run: bun scripts/yesterday_echo_unit.mjs
import { buildPriorDay, buildSessionProfile, buildYesterdayRow } from '../mini-services/trading-core/src/analytics/yesterday'
import { cmpBySort, buildWatchlist, parseWatchlist, fmtWatchlistTs, fmtHours } from '../src/lib/os/watchlist'

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
    ok('not quiet (both lead-ins directional)', e.quiet === false, `got ${e.quiet}`)
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
    ok('variant B not quiet (both directional)', eB.quiet === false, `got ${eB.quiet}`)
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
  ok('variant D QUIET (dead-flat both sides)', eD?.quiet === true, `got ${eD?.quiet}`)

  // variant E: NEAR-flat both sides (tiny but nonzero travel, |move| under
  // 10% of it) -> dir 'none' on both sides -> quiet, same, rhyme 50..100
  // (dir points are free; the ratio parts stay high on two matching dead
  // windows). The exact case the quiet flag exists for: 90-from-flat.
  const nearY = run(t0 - WIN, WIN / TF, base, 0.001, 0.02)
  const nearT = run(t0 + DAY - WIN, WIN / TF, base, -0.0005, 0.02)
  const rowE = buildYesterdayRow(info, [...nearY, ...flatFwd, ...nearT, ...tail], opts)
  const eE = rowE?.echo
  ok('variant E near-flat both sides -> quiet + same', eE?.quiet === true && eE?.dirAgree === 'same', JSON.stringify(eE))
  ok('variant E quiet rhyme within 50..100', eE != null && eE.rhyme >= 50 && eE.rhyme <= 100, `got ${eE?.rhyme}`)

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
  ok('prior echo not quiet on directional lead-ins', pdUp?.echo?.quiet === false, JSON.stringify(pdUp?.echo))
  // flat prior lead-in vs flat today side -> quiet: trivial agreement
  const priorLeadFlat = run(t0 - DAY - WIN, WIN / TF, base, 0, 0.02)
  const todayNoneStats = { movePct: 0, rangePct: 0.02, dir: 'none' }
  const pdFlat = buildPriorDay(info, [...priorLeadFlat, ...prior2Fwd, ...sparse].sort((a, b) => a.time - b.time), { nowSec, windowSec: WIN, tfSec: TF, back: 2, todayLeadIn: { stats: todayNoneStats, barsFound: 60 } })
  ok('prior echo QUIET on flat/flat lead-ins', pdFlat?.echo?.quiet === true && pdFlat?.echo?.dirAgree === 'same', JSON.stringify(pdFlat?.echo))
  const pdDown = buildPriorDay(info, [...priorLeadDown, ...prior2Fwd, ...sparse].sort((a, b) => a.time - b.time), { nowSec, windowSec: WIN, tfSec: TF, back: 2, todayLeadIn: { stats: todayStats, barsFound: 60 } })
  ok('prior echo 20 on opposite-dir same-travel', pdDown?.echo?.rhyme === 20 && pdDown?.echo?.dirAgree === 'opposite', JSON.stringify(pdDown?.echo))
  const pdThin = buildPriorDay(info, [...priorLeadUp.slice(0, 18), ...prior2Fwd, ...sparse].sort((a, b) => a.time - b.time), { nowSec, windowSec: WIN, tfSec: TF, back: 2, todayLeadIn: { stats: todayStats, barsFound: 60 } })
  ok('prior echo null when the prior lead-in is thin', pdThin !== null && pdThin.echo === null, JSON.stringify(pdThin?.echo))
  // through the row: priorDays=1 wires today's lead-in automatically - the
  // remembered day carries its echo; with TODAY's side thin (variant C), the
  // prior echo is null too (today is the weak side in every comparison)
  const rowPriorEcho = buildYesterdayRow(info, [...priorLeadUp, ...prior2Fwd, ...sparse].sort((a, b) => a.time - b.time), { ...opts, priorDays: 1 })
  ok('row path: prior echo wired from today lead-in', rowPriorEcho?.prior[0]?.echo?.rhyme === 100 && rowPriorEcho?.prior[0]?.echo?.dirAgree === 'same', JSON.stringify(rowPriorEcho?.prior[0]?.echo))
  ok('row path: prior echo quiet flag boolean', typeof rowPriorEcho?.prior[0]?.echo?.quiet === 'boolean', JSON.stringify(rowPriorEcho?.prior[0]?.echo))
  ok('row path: prior anchor is exactly t0 - DAY', rowPriorEcho?.prior[0]?.thenTs === t0 - DAY, `thenTs=${rowPriorEcho?.prior[0]?.thenTs} expected=${t0 - DAY}`)
  const seriesThinToday = [...ydayLead, ...ydayFwd, ...thin, ...tail]
  const rowThinToday = buildYesterdayRow(info, [...priorLeadUp, ...prior2Fwd, ...seriesThinToday].sort((a, b) => a.time - b.time), { ...opts, priorDays: 1 })
  ok('thin today side silences the prior echo too', rowThinToday?.prior[0]?.echo === null, JSON.stringify(rowThinToday?.prior[0]?.echo))
}

// ---- SESSION PROFILE: the same adjacent-day lead-in echo at every hour ----
// Engineered lead-ins at known UTC hours (MID = a real UTC midnight, 60s-
// aligned so every h:00 anchor is exact):
//   h13 today  [M+12h,M+13h)  up   +0.40% / 0.80% travel
//   h13 yday   [M-12h,M-11h)  up   +0.40% / 0.80%
//   h13 T-2    [M-36h,M-35h)  down -0.40% / 0.80%
//   h15 yday   [M-10h,M-09h)  up   +0.40% / 0.80%
//   h15 T-2    [M-34h,M-33h)  up   +0.40% / 0.80%
// now = 14:00:30 UTC -> h13's today side has elapsed, h15's has NOT
// (future): expected pairs = h13 d1 (100 same) + h13 d2 (20 opposite) +
// h15 d2-only (100 same) -> OVERLAP obs 3, avg round((100+20+100)/3) = 73.
// The future today-side skip is what keeps h15 at ONE pair (obs 3, not 4).
// Every other session: obs 0 / avg null - honest zeros, not absent slots.
// A -OTC ticker has no sessions: one day-wide OTC bucket, same pairs.
const MID = 1_699_920_000 // 2023-11-14T00:00:00Z
const nowP = MID + 14 * 3_600 + 30
const pOpts = { nowSec: nowP, windowSec: WIN, tfSec: TF, days: 2 }
const profSeries = [
  run(MID + 12 * 3_600, WIN / TF, base, 0.4, 0.8),  // today h13 lead-in
  run(MID - 12 * 3_600, WIN / TF, base, 0.4, 0.8),  // yesterday h13 lead-in
  run(MID - 36 * 3_600, WIN / TF, base, -0.4, 0.8), // T-2 h13 lead-in
  run(MID - 10 * 3_600, WIN / TF, base, 0.4, 0.8),  // yesterday h15 lead-in
  run(MID - 34 * 3_600, WIN / TF, base, 0.4, 0.8),  // T-2 h15 lead-in
].flat().sort((a, b) => a.time - b.time)
const prof = buildSessionProfile(info, profSeries, pOpts)
ok('profile: five ordered session buckets on a real ticker', prof.length === 5 && prof.map((s) => s.session).join(',') === 'ASIA,LONDON,OVERLAP,NEWYORK,OFF', JSON.stringify(prof))
const ov = prof.find((s) => s.session === 'OVERLAP')
ok('profile: OVERLAP obs 3 (h13 d1+d2, h15 d2 - future today-side skipped)', ov?.obs === 3, JSON.stringify(ov))
ok('profile: OVERLAP avg 73, none quiet', ov?.avg === 73 && ov?.quiet === 0, JSON.stringify(ov))
ok('profile: bucket sum is the exact non-quiet total (100+20+100 = 220)', ov?.sum === 220 && Number.isInteger(ov?.sum), JSON.stringify(ov))
ok('profile: dark sessions honest zeros (ASIA / OFF)', prof.find((s) => s.session === 'ASIA')?.obs === 0 && prof.find((s) => s.session === 'ASIA')?.avg === null && prof.find((s) => s.session === 'OFF')?.obs === 0, JSON.stringify(prof))
ok('profile: dark sessions sum to 0 too (nothing non-quiet to total)', prof.find((s) => s.session === 'ASIA')?.sum === 0 && prof.find((s) => s.session === 'OFF')?.sum === 0, JSON.stringify(prof))
const profOtc = buildSessionProfile({ ...info, ticker: 'TEST-OTC', otc: true }, profSeries, pOpts)
ok('profile: -OTC ticker collapses to one OTC bucket (same pairs)', profOtc.length === 1 && profOtc[0].session === 'OTC' && profOtc[0].obs === 3 && profOtc[0].avg === 73, JSON.stringify(profOtc))
ok('profile: OTC bucket carries the same exact sum (220)', profOtc[0]?.sum === 220, JSON.stringify(profOtc))
// quiet exclusion: the h15 pair both FLAT -> quiet, kept out of the average
const profQuietSeries = [
  run(MID + 12 * 3_600, WIN / TF, base, 0.4, 0.8),
  run(MID - 12 * 3_600, WIN / TF, base, 0.4, 0.8),
  run(MID - 36 * 3_600, WIN / TF, base, -0.4, 0.8),
  run(MID - 10 * 3_600, WIN / TF, base, 0, 0.02),   // yesterday h15 lead-in flat
  run(MID - 34 * 3_600, WIN / TF, base, 0, 0.02),   // T-2 h15 lead-in flat
].flat().sort((a, b) => a.time - b.time)
const ovQ = buildSessionProfile(info, profQuietSeries, pOpts).find((s) => s.session === 'OVERLAP')
ok('profile: quiet pair counted in obs, excluded from avg (3 obs, 1 quiet, avg 60)', ovQ?.obs === 3 && ovQ?.quiet === 1 && ovQ?.avg === 60, JSON.stringify(ovQ))
ok('profile: sum follows the exclusion (kept 100+20 = 120, quiet pair not totalled)', ovQ?.sum === 120, JSON.stringify(ovQ))
// HOURS (Task 20): each bucket names the distinct UTC hours whose NON-quiet
// pairs fed avg - the question a peak cell asks. Engineered slots: h13 (two
// non-quiet pairs) + h15 (one) -> OVERLAP hours [13,15]; the quiet variant's
// h15 pair is quiet, so its hours shrink to [13] while obs stays 3 - the
// listed hours are exactly what the average rests on. Dark sessions: []
// (honest zero, like obs 0 / avg null). -OTC: same pairs, day-wide bucket.
ok('profile hours: OVERLAP names 13 and 15 (every non-quiet slot)', JSON.stringify(ov?.hours) === '[13,15]', JSON.stringify(ov?.hours))
ok('profile hours: quiet pair\'s hour drops out (obs stays 3, hours [13])', JSON.stringify(ovQ?.hours) === '[13]', JSON.stringify(ovQ?.hours))
ok('profile hours: dark sessions carry the honest empty array', JSON.stringify(prof.find((s) => s.session === 'ASIA')?.hours) === '[]' && JSON.stringify(prof.find((s) => s.session === 'OFF')?.hours) === '[]', JSON.stringify(prof.map((s) => [s.session, s.hours])))
ok('profile hours: -OTC day-wide bucket carries the same hours', JSON.stringify(profOtc[0]?.hours) === '[13,15]', JSON.stringify(profOtc[0]?.hours))
// the row path was checked with JSON.stringify equality on the whole
// profile - it now covers the hours arrays too (same objects both sides)

// ---- fmtHours (Task 20): the tooltip's run-length form, locked exactly ----
// Lives in watchlist.ts beside the serializer so the panel and the unit share
// one formatter: consecutive hours collapse to HH-HH, the rest comma-separate,
// everything zero-padded, sorted + deduped defensively, empty -> "none".
ok('fmtHours: empty reads "none"', fmtHours([]) === 'none', JSON.stringify(fmtHours([])))
ok('fmtHours: a lone hour zero-pads (7 -> "07")', fmtHours([7]) === '07', JSON.stringify(fmtHours([7])))
ok('fmtHours: a consecutive run collapses (9-12)', fmtHours([9, 10, 11, 12]) === '09-12', JSON.stringify(fmtHours([9, 10, 11, 12])))
ok('fmtHours: a gap stays comma-separated (13, 15)', fmtHours([13, 15]) === '13, 15', JSON.stringify(fmtHours([13, 15])))
ok('fmtHours: the full day is one range (00-23)', fmtHours(Array.from({ length: 24 }, (_, i) => i)) === '00-23', JSON.stringify(fmtHours(Array.from({ length: 24 }, (_, i) => i))))
ok('fmtHours: midnight cannot join an evening run (00, 22-23)', fmtHours([0, 22, 23]) === '00, 22-23', JSON.stringify(fmtHours([0, 22, 23])))
ok('fmtHours: the OFF bucket\'s whole window is one run (21-23)', fmtHours([21, 22, 23]) === '21-23', JSON.stringify(fmtHours([21, 22, 23])))
ok('fmtHours: unsorted + duplicated input sorts and dedupes defensively', fmtHours([15, 13, 13]) === '13, 15', JSON.stringify(fmtHours([15, 13, 13])))
// row path: opts.profile wires the same arithmetic (days = priorDays + 1);
// absent unless requested
const rowProf = buildYesterdayRow(info, profSeries, { nowSec: nowP, windowSec: WIN, tfSec: TF, nowPrice: base * 1.004, archived: 0, priorDays: 1, profile: true })
ok('row path: profile wired == direct buildSessionProfile', JSON.stringify(rowProf?.profile) === JSON.stringify(prof), JSON.stringify(rowProf?.profile))
const rowNoProf = buildYesterdayRow(info, profSeries, { nowSec: nowP, windowSec: WIN, tfSec: TF, nowPrice: base * 1.004, archived: 0, priorDays: 1 })
ok('row path: profile absent when not requested', rowNoProf?.profile === undefined, JSON.stringify(rowNoProf?.profile))

// ---- WATCHLIST SNAPSHOT (Task 16): the exported text + the ranking it rides ----
// The panel sorts by and serializes through src/lib/os/watchlist.ts; bun
// imports that module directly, so these checks lock the REAL shipped code
// (not a mirror): the three watchlist orders with their quiet exclusion and
// sink sentinels, and the snapshot's layout - header fields, topN cap,
// conditional week/peak columns, the quiet marker, and every cell matching
// the row it came from.
const wr = (asset, movePct, echo, prior, profile) => ({ asset, movePct, sincePct: 0, rangePct: 1, echo, prior, profile })
const WROWS = [
  // AAA: week kept [90,80,40] -> rhymed 2, avg 70; peak L/N 80 vs Asia 60 (spread 20)
  wr('AAA', 1.2, { rhyme: 90, quiet: false }, [{ echo: { rhyme: 80, quiet: false } }, { echo: { rhyme: 40, quiet: false } }], [{ session: 'OVERLAP', obs: 6, quiet: 0, avg: 80 }, { session: 'ASIA', obs: 4, quiet: 1, avg: 60 }]),
  // BBB: week kept [95,20] -> rhymed 1, avg 58; peak single qualified session (no spread)
  wr('BBB', 3.0, { rhyme: 95, quiet: false }, [{ echo: { rhyme: 20, quiet: false } }], [{ session: 'OVERLAP', obs: 6, quiet: 0, avg: 60 }]),
  // CCC: no echo anywhere, dark profile -> sinks in week AND peak
  wr('CCC', 0.5, null, [], [{ session: 'ASIA', obs: 0, quiet: 0, avg: null }]),
  // DDD: every echo quiet -> week kept 0 (-1 sink); no profile at all
  wr('DDD', 2.0, { rhyme: 100, quiet: true }, [{ echo: { rhyme: 90, quiet: true } }], null),
  // EEE: one non-quiet echo, no priors, no profile
  wr('EEE', 0.9, { rhyme: 55, quiet: false }, [], null),
]
const byWeek = [...WROWS].sort(cmpBySort('week')).map((r) => r.asset)
ok('watchlist: week order - rhymed days first, avg breaks ties, sinks last', JSON.stringify(byWeek) === JSON.stringify(['AAA', 'BBB', 'EEE', 'DDD', 'CCC']), `got ${byWeek.join(',')}`)
ok('watchlist: week order - all-quiet row keys to -1, sinks beside the no-echo row, |move| breaks', cmpBySort('week')(WROWS[3], WROWS[2]) < 0, `DDD vs CCC cmp=${cmpBySort('week')(WROWS[3], WROWS[2])}`)
const byPeak = [...WROWS].sort(cmpBySort('peak')).map((r) => r.asset)
ok('watchlist: peak order - best session wins, spread/|move| place the rest', JSON.stringify(byPeak) === JSON.stringify(['AAA', 'BBB', 'DDD', 'EEE', 'CCC']), `got ${byPeak.join(',')}`)
const rhymeSorted = [...WROWS].sort(cmpBySort('rhyme')).map((r) => r.asset)
ok('watchlist: rhyme order exact - the sort reads the score (quiet 100 included), nulls sink by |move|', JSON.stringify(rhymeSorted) === JSON.stringify(['DDD', 'BBB', 'AAA', 'EEE', 'CCC']), `got ${rhymeSorted.join(',')}`)
ok('watchlist: move order uses |move| - BBB 3.0 first, CCC 0.5 last', JSON.stringify([...WROWS].sort(cmpBySort('move')).map((r) => r.asset)) === JSON.stringify(['BBB', 'DDD', 'AAA', 'EEE', 'CCC']), `got ${[...WROWS].sort(cmpBySort('move')).map((r) => r.asset).join(',')}`)

const TS = 1_699_920_000_000 // 2023-11-14T00:00:00Z
ok('watchlist: fmtWatchlistTs renders a UTC label', fmtWatchlistTs(TS) === '2023-11-14 00:00 UTC', `got ${fmtWatchlistTs(TS)}`)
const snap = buildWatchlist({ rows: WROWS, sort: 'peak', tsMs: TS, topN: 3, mktLabel: 'all markets', catLabel: 'all classes' })
const snapLines = snap.split('\n')
// AAA + BBB carry a measured profile (one script sub-line each), DDD does not
ok('watchlist: snapshot is title + key row + data rows (+ script sub-lines) + legend', snapLines.length === 3 + 3 + 2, `lines=${snapLines.length}`)
ok('watchlist: header carries the scan time, sort, filters and count', snapLines[0].includes('2023-11-14 00:00 UTC') && snapLines[0].includes('sort peak') && snapLines[0].includes('all markets') && snapLines[0].includes('all classes') && snapLines[0].includes('top 3 of 5'), snapLines[0])
ok('watchlist: cap respected - the top-3 text holds exactly AAA/BBB/DDD', snapLines[2].includes('AAA') && snapLines[4].includes('BBB') && snapLines[6].includes('DDD'), snapLines.slice(2, 7).join(' | '))
ok('watchlist: quiet echo marked q in the echo cell', snapLines[6].includes('100q'), snapLines[6])
ok('watchlist: peak cell is session + best + spread (AAA L/N 80 Δ20)', snapLines[2].includes('L/N 80 Δ20'), snapLines[2])
ok('watchlist: single qualified session renders without a spread tag', snapLines[4].includes('L/N 60') && !snapLines[4].includes('Δ'), snapLines[4])
ok('watchlist: row without a profile renders an honest — peak cell', snapLines[6].includes('—'), snapLines[6])
ok('watchlist: move cell signed to two decimals', snapLines[2].includes('+1.20%') && snapLines[4].includes('+3.00%'), `${snapLines[2]} | ${snapLines[4]}`)
// ---- script sub-lines (Task 18): the shape travels with the paste ----
ok('watchlist: AAA sub-line is indented, canonical-ordered (wire ships OVERLAP first, text says Asia before L/N)', snapLines[3].startsWith('      script  ') && snapLines[3].indexOf('Asia 60') !== -1 && snapLines[3].indexOf('Asia 60') < snapLines[3].indexOf('L/N 80'), snapLines[3])
ok('watchlist: BBB sub-line is measured-only (no empty session pairs)', snapLines[5].includes('L/N 60') && !snapLines[5].includes('Asia') && !snapLines[5].includes('off') && !snapLines[5].includes('OTC'), snapLines[5])
ok('watchlist: dark/no-profile rows add no sub-line (DDD line has none)', !snapLines[6].includes('script'), snapLines[6])
const snapWeek = buildWatchlist({ rows: WROWS, sort: 'week', tsMs: TS, topN: 5 })
const wLine = snapWeek.split('\n')[2]
ok('watchlist: week cell is rhymed/kept + avg over non-quiet days (AAA 2/3 70)', wLine.includes('2/3 70'), wLine)
ok('watchlist: quiet-only and no-echo rows render a — week cell', snapWeek.split('\n').some((l) => l.includes('DDD') && l.includes('—')) && snapWeek.split('\n').some((l) => l.includes('CCC') && l.includes('—')), snapWeek)
const snapBare = buildWatchlist({ rows: [WROWS[4]], sort: 'rhyme', tsMs: TS, topN: 10 })
ok('watchlist: week column omitted when no exported row has a prior echo', !snapBare.split('\n')[1].includes('week'), snapBare.split('\n')[1])
ok('watchlist: peak column omitted when no exported row has a profile', !snapBare.split('\n')[1].includes('peak'), snapBare.split('\n')[1])
ok('watchlist: full scan says so in the header (no top-N truncation)', snapBare.split('\n')[0].includes('1 row'), snapBare.split('\n')[0])
const snapEmpty = buildWatchlist({ rows: [], sort: 'week', tsMs: TS, topN: 10 })
ok('watchlist: empty view is honest (no rows - loosen the filters)', snapEmpty.includes('no rows - loosen the filters'), snapEmpty.split('\n')[1])
ok('watchlist: serializer deterministic (same input -> same text)', buildWatchlist({ rows: WROWS, sort: 'week', tsMs: TS, topN: 5 }) === snapWeek)

// ---- OFF-HOURS MARKER (Task 17): the session-level cousin of the quiet q ----
// An OFF-bucket peak is real (quiet pairs are already excluded) but it was
// scored at hours OUTSIDE the named sessions - thin books, small travel - so
// the snapshot marks it off* inline and the legend spells the caveat out.
// The marker must fire ONLY when OFF is the best session: a clock-session or
// OTC day-wide peak stays clean.
const FFF = wr('FFF', 0.7, { rhyme: 60, quiet: false }, [], [
  { session: 'OFF', obs: 4, quiet: 0, avg: 74 },
  { session: 'OVERLAP', obs: 3, quiet: 0, avg: 54 },
  { session: 'ASIA', obs: 2, quiet: 0, avg: 50 },
])
const snapOff = buildWatchlist({ rows: [FFF], sort: 'peak', tsMs: TS, topN: 5 })
ok('watchlist: OFF-bucket peak marked off* in the peak cell (off* 74 Δ24)', snapOff.split('\n')[2].includes('off* 74 Δ24'), snapOff.split('\n')[2])
ok('watchlist: FFF sub-line marks the measured OFF cell too (Asia 50  L/N 54  off* 74)', snapOff.split('\n')[3].includes('Asia 50  L/N 54  off* 74'), snapOff.split('\n')[3])
ok('watchlist: the legend spells the off* caveat out', snapOff.split('\n').at(-1).includes('* off-hours (thin books, weight it)'), snapOff.split('\n').at(-1))
const snapLon = buildWatchlist({ rows: [WROWS[0]], sort: 'peak', tsMs: TS, topN: 5 })
ok('watchlist: a clock-session peak carries no marker', snapLon.split('\n')[2].includes('L/N 80 Δ20') && !snapLon.split('\n')[2].includes('*'), snapLon.split('\n')[2])
// OFF qualifies but is NOT the best -> the marker must not fire on the peak cell
const HHH = wr('HHH', 0.8, { rhyme: 55, quiet: false }, [], [
  { session: 'OFF', obs: 4, quiet: 0, avg: 74 },
  { session: 'OVERLAP', obs: 3, quiet: 0, avg: 80 },
])
const snapMixed = buildWatchlist({ rows: [HHH], sort: 'peak', tsMs: TS, topN: 5 })
ok('watchlist: marker only when OFF IS the best (L/N 80 stays clean)', snapMixed.split('\n')[2].includes('L/N 80 Δ6') && !snapMixed.split('\n')[2].includes('*'), snapMixed.split('\n')[2])
ok('watchlist: HHH sub-line marks OFF measured even when L/N is the peak', snapMixed.split('\n')[3].includes('L/N 80') && snapMixed.split('\n')[3].includes('off* 74'), snapMixed.split('\n')[3])
// OTC day-wide + all-quiet buckets in the sub-line
const snapOtc = buildWatchlist({ rows: [wr('GGG', 1.0, { rhyme: 50, quiet: false }, [], [{ session: 'OTC', obs: 5, quiet: 0, avg: 61 }])], sort: 'peak', tsMs: TS, topN: 5 })
ok('watchlist: an OTC day-wide peak carries no marker either', snapOtc.split('\n')[2].includes('OTC 61') && !snapOtc.split('\n')[2].includes('*'), snapOtc.split('\n')[2])
ok('watchlist: OTC sub-line renders the day-wide bucket', snapOtc.split('\n')[3].trim() === 'script  OTC 61', snapOtc.split('\n')[3])
const III = wr('III', 0.4, { rhyme: 45, quiet: false }, [], [
  { session: 'ASIA', obs: 3, quiet: 3, avg: null },
  { session: 'LONDON', obs: 2, quiet: 0, avg: 66 },
])
const snapQuiet = buildWatchlist({ rows: [III], sort: 'peak', tsMs: TS, topN: 5 })
ok('watchlist: an all-quiet measured bucket reads — in the sub-line (Lon 66, Asia —)', snapQuiet.split('\n')[3].includes('Asia —') && snapQuiet.split('\n')[3].includes('Lon 66'), snapQuiet.split('\n')[3])

// ---- SNAPSHOT ROUNDTRIP (Task 19): parseWatchlist reads the shape back ----
// The roundtrip law: parse(buildWatchlist(x)) restores the SELECTION + the
// SORT + the SCOPE labels and counts, never the numbers - every cell the
// serializer wrote is data the parser must skip. These checks run the
// parser against the snapshots BUILT above, so serializer and parser are
// locked to each other, not to parallel mirrors.
const rt = parseWatchlist(snap)
ok('roundtrip: the top-3 peak snapshot parses back ok', rt.ok, JSON.stringify(rt))
if (rt.ok) {
  ok('roundtrip: assets are the snapshot\'s ranked rows in rank order', JSON.stringify(rt.wl.assets) === JSON.stringify(['AAA', 'BBB', 'DDD']), `got ${rt.wl.assets.join(',')}`)
  ok('roundtrip: sort + ts label ride the header', rt.wl.sort === 'peak' && rt.wl.tsLabel === '2023-11-14 00:00 UTC', `sort=${rt.wl.sort} ts=${rt.wl.tsLabel}`)
  ok('roundtrip: scope labels + top-of counts ride the header', rt.wl.mktLabel === 'all markets' && rt.wl.catLabel === 'all classes' && rt.wl.total === 5 && rt.wl.ranked === 3, JSON.stringify(rt.wl))
}
const rtWeek = parseWatchlist(snapWeek)
ok('roundtrip: the full week snapshot parses back (N rows variant, not top-of)', rtWeek.ok && rtWeek.wl.assets.join(',') === 'AAA,BBB,EEE,DDD,CCC' && rtWeek.wl.sort === 'week' && rtWeek.wl.total === 5 && rtWeek.wl.ranked === 5, JSON.stringify(rtWeek.ok ? rtWeek.wl : rtWeek))
ok('roundtrip: serializer defaults surface as the scope labels', rtWeek.ok && rtWeek.wl.mktLabel === 'all markets' && rtWeek.wl.catLabel === 'all classes', JSON.stringify(rtWeek.ok ? [rtWeek.wl.mktLabel, rtWeek.wl.catLabel] : rtWeek))
ok('roundtrip: script sub-lines, key row and legend never leak in as rows', rtWeek.ok && rtWeek.wl.assets.every((a) => !['script', 'asset', 'Asia', 'Lon', 'L/N', 'NY', 'off', 'OTC', 'legend:'].includes(a)), `got ${rtWeek.ok ? rtWeek.wl.assets.join(',') : '-'}`)
const rtBare = parseWatchlist(snapBare)
ok('roundtrip: the 1-row snapshot parses (singular "1 row" count)', rtBare.ok && rtBare.wl.assets.join(',') === 'EEE' && rtBare.wl.sort === 'rhyme' && rtBare.wl.total === 1 && rtBare.wl.ranked === 1, JSON.stringify(rtBare.ok ? rtBare.wl : rtBare))
ok('roundtrip: an empty snapshot is refused with a reason', !parseWatchlist(snapEmpty).ok && parseWatchlist(snapEmpty).why.includes('no ranked rows'), JSON.stringify(parseWatchlist(snapEmpty)))
ok('roundtrip: non-snapshot text is refused (no title tag)', !parseWatchlist('hello world\n1  AAA  90').ok && parseWatchlist('hello world\n1  AAA  90').why.includes('not an iqOS'), JSON.stringify(parseWatchlist('hello world')))
const snapReal = buildWatchlist({ rows: [WROWS[0]], sort: 'move', tsMs: TS, mktLabel: 'REAL', catLabel: 'forex' })
const rtReal = parseWatchlist(snapReal)
ok('roundtrip: custom scope labels travel verbatim (REAL / forex, sort move)', rtReal.ok && rtReal.wl.mktLabel === 'REAL' && rtReal.wl.catLabel === 'forex' && rtReal.wl.sort === 'move', JSON.stringify(rtReal.ok ? [rtReal.wl.mktLabel, rtReal.wl.catLabel, rtReal.wl.sort] : rtReal))
const snapSince = buildWatchlist({ rows: [WROWS[0]], sort: 'since', tsMs: TS })
const snapRange = buildWatchlist({ rows: [WROWS[0]], sort: 'range', tsMs: TS })
ok('roundtrip: the since/range sorts parse back too (all six kinds pass)', parseWatchlist(snapSince).ok && parseWatchlist(snapSince).wl.sort === 'since' && parseWatchlist(snapRange).ok && parseWatchlist(snapRange).wl.sort === 'range', `${parseWatchlist(snapSince).ok ? parseWatchlist(snapSince).wl.sort : 'x'}/${parseWatchlist(snapRange).ok ? parseWatchlist(snapRange).wl.sort : 'x'}`)
ok('roundtrip: a bogus sort in the header degrades to null, not a guess', parseWatchlist(snap.replace('sort peak', 'sort bogus')).ok && parseWatchlist(snap.replace('sort peak', 'sort bogus')).wl.sort === null, JSON.stringify(parseWatchlist(snap.replace('sort peak', 'sort bogus')).ok ? parseWatchlist(snap.replace('sort peak', 'sort bogus')).wl.sort : '-'))
const trimmed = ['iqOS yesterday watchlist · sort week', '  1  AAA   90  2/3 70  L/N 80 Δ20  +1.20%'].join('\n')
const rtTrim = parseWatchlist(trimmed)
ok('roundtrip: a hand-trimmed header degrades honestly (nulls, not guesses)', rtTrim.ok && rtTrim.wl.sort === 'week' && rtTrim.wl.tsLabel === null && rtTrim.wl.mktLabel === null && rtTrim.wl.catLabel === null && rtTrim.wl.total === null && rtTrim.wl.ranked === 1, JSON.stringify(rtTrim.ok ? rtTrim.wl : rtTrim))
ok('roundtrip: a title-only snapshot (no ranked lines) is refused', !parseWatchlist('iqOS yesterday watchlist · 2023-11-14 00:00 UTC · sort week · all markets · all classes · 0 rows').ok, JSON.stringify(parseWatchlist('iqOS yesterday watchlist · 0 rows')))
const dupText = `${snapWeek}\n  9  AAA   90  2/3 70  L/N 80 Δ20  +1.20%`
const rtDup = parseWatchlist(dupText)
ok('roundtrip: a duplicate line keeps the best rank and does not double-count', rtDup.ok && rtDup.wl.ranked === 5 && rtDup.wl.assets[0] === 'AAA', `ranked=${rtDup.ok ? rtDup.wl.ranked : '-'} first=${rtDup.ok ? rtDup.wl.assets[0] : '-'}`)
const shuffled = [
  'iqOS yesterday watchlist · 2023-11-14 00:00 UTC · sort move · all markets · all classes · 2 rows',
  '  #  asset   echo  move',
  '   2  EURUSD-OTC   50  +0.50%',
  '   1  JJJ   80  +0.80%',
  'legend: rhyme = dir 50 + move-vs-travel 30',
].join('\n')
ok('roundtrip: ranks reorder the assets even in a hand-shuffled paste', parseWatchlist(shuffled).ok && JSON.stringify(parseWatchlist(shuffled).wl.assets) === JSON.stringify(['JJJ', 'EURUSD-OTC']), `got ${parseWatchlist(shuffled).ok ? parseWatchlist(shuffled).wl.assets.join(',') : '-'}`)
ok('roundtrip: a -OTC ticker with hyphens parses as one asset', parseWatchlist(shuffled).ok && parseWatchlist(shuffled).wl.assets.includes('EURUSD-OTC'), JSON.stringify(parseWatchlist(shuffled).ok ? parseWatchlist(shuffled).wl.assets : '-'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
