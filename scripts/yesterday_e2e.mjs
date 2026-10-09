#!/usr/bin/env bun
// Same-time-yesterday scanner e2e.
// Verifies /yesterday against the live kernel: response shape, the T-24h
// anchor (window starts at the bar forming exactly 24h ago), row sanity
// (move/range/excursions/coverage/provenance), direction classification,
// (echo lead-in comparison yesterday vs today: rhyme bounds, dirAgree
// consistency with the move signs, coverage-when-present), the days param
// (same-hour history strips: prior-day sanity + anchors, clamp, depth gate),
// the /candles deep=1 read the echo click-through feeds on (archive depth,
// deeper-than-plain reach, ascending bars, live tail, clamp), sorting by
// |move|, the window param (clamp + quantization), tf respect (per-tf
// caches, no cross-tf leak), the archive-depth gate (5s/15s refused with a
// clear 400) and the strict tf gate. Read-only.
const BASE = process.env.IQAIR_OS_URL ?? 'http://localhost:3030'
const TOKEN = (process.env.KERNEL_TOKEN ?? '').trim()
let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`)
  }
}
const get = async (path) => {
  const r = await fetch(`${BASE}${path}`, {
    headers: TOKEN ? { 'x-kernel-token': TOKEN } : {},
    signal: AbortSignal.timeout(120_000),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

console.log(`same-time-yesterday e2e vs ${BASE}`)

// warm a spread of assets so the scanner has closed history (fresh kernels
// only materialize candles for touched pairs) - includes OTC + crypto
const warm = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDCAD', 'USDCHF', 'EURCHF', 'NZDUSD', 'USDCAD',
  'EURUSD-OTC', 'GBPUSD-OTC', 'USDJPY-OTC', 'AUDCAD-OTC', 'EURGBP-OTC', 'BTCUSD', 'ETHUSD', 'SOLUSD',
]
for (const a of warm) await get(`/candles?asset=${a}&tf=60&size=240`)
await new Promise((r) => setTimeout(r, 1500))

// ---------- shape + T-24h anchor ----------
const d = await get('/yesterday?tf=1m')
ok('200 + ok', d.status === 200 && d.body.ok === true, JSON.stringify(d.body).slice(0, 200))
ok('tf/window/mode echo', d.body.tf === '1m' && d.body.windowMin === 60 && ['sim', 'live'].includes(d.body.mode), `tf=${d.body.tf} windowMin=${d.body.windowMin} mode=${d.body.mode}`)
ok('scanned the universe', (d.body.scanned ?? 0) >= 8, `scanned=${d.body.scanned}`)
ok('rows + skipped account for the scan', d.body.considered === d.body.rows.length && d.body.considered + d.body.skipped === d.body.scanned, `considered=${d.body.considered} skipped=${d.body.skipped} scanned=${d.body.scanned}`)
ok('has rows (lookback reaches 24h back)', d.body.rows.length >= 1, `rows=${d.body.rows.length}`)

const rows = d.body.rows ?? []
const r0 = rows[0] ?? null
if (r0) {
  // the window must start at the minute-bucket containing exactly now-86400
  // (allow one bucket of drift for a second boundary crossing mid-scan)
  const tgt = Math.floor(d.body.ts / 1000) - 86_400
  const exp0 = tgt - (tgt % 60)
  ok('window anchored at T-24h', Math.abs(r0.thenTs - exp0) <= 60, `thenTs=${r0.thenTs} expected~${exp0} delta=${r0.thenTs - exp0}`)
  ok('prices positive', r0.thenPrice > 0 && r0.nowPrice > 0, `then=${r0.thenPrice} now=${r0.nowPrice}`)
  ok('sincePct sane', Number.isFinite(r0.sincePct) && Math.abs(r0.sincePct) < 60, `sincePct=${r0.sincePct}`)
  ok('move/range/excursions finite', [r0.movePct, r0.rangePct, r0.runUpPct, r0.drawdownPct].every((v) => Number.isFinite(v) && v >= 0 || (v < 0 && v === r0.movePct)), JSON.stringify([r0.movePct, r0.rangePct, r0.runUpPct, r0.drawdownPct]))
  ok('excursions within the window range', r0.runUpPct <= r0.rangePct + 0.01 && r0.drawdownPct <= r0.rangePct + 0.01, `up=${r0.runUpPct} dd=${r0.drawdownPct} range=${r0.rangePct}`)
  ok('dir enum + consistent with the move sign', ['up', 'down', 'none'].includes(r0.dir) && (r0.dir === 'up' ? r0.movePct > 0 : r0.dir === 'down' ? r0.movePct < 0 : Math.abs(r0.movePct) <= r0.rangePct * 0.1 + 0.001), `dir=${r0.dir} move=${r0.movePct} range=${r0.rangePct}`)
  ok('coverage gate respected', r0.barsFound >= Math.max(1, Math.floor(r0.barsExpected * 0.5)) && r0.barsFound <= r0.barsExpected, `found=${r0.barsFound}/${r0.barsExpected}`)
  ok('provenance bounded', Number.isFinite(r0.archived) && r0.archived >= 0 && r0.archived <= r0.barsFound, `archived=${r0.archived}/${r0.barsFound}`)
  ok('session enum', ['ASIA', 'LONDON', 'OVERLAP', 'NEWYORK', 'OFF', 'OTC'].includes(r0.session), `session=${r0.session}`)
  ok('otc flag boolean', typeof r0.otc === 'boolean')
}

// every row passes the same gates (the e2e samples the whole returned set)
ok('all rows well-formed', rows.every((r) =>
  r.asset && r.name && r.category && typeof r.otc === 'boolean' &&
  Number.isFinite(r.thenTs) && r.thenPrice > 0 && r.nowPrice > 0 &&
  Number.isFinite(r.movePct) && Number.isFinite(r.rangePct) && r.rangePct >= 0 &&
  ['up', 'down', 'none'].includes(r.dir) &&
  r.barsFound >= Math.max(1, Math.floor(r.barsExpected * 0.5)) && r.barsFound <= r.barsExpected &&
  r.archived >= 0 && r.archived <= r.barsFound &&
  ['ASIA', 'LONDON', 'OVERLAP', 'NEWYORK', 'OFF', 'OTC'].includes(r.session),
))

// ---------- echo: the lead-in comparison, yesterday vs today ----------
// rhyme 0..100, dirAgree enum, today's side bounded; dirAgree must agree
// with the two moves' signs under the same 10%-of-own-travel rule the row
// itself uses. A warmed sim series covers both lead-in windows, so most
// rows carry an echo - a missing echo is honest (thin side), not an error.
const flat = (m, rg) => Math.abs(m) <= rg * 0.1 + 0.001
ok('all echoes well-formed', rows.every((r) =>
  r.echo === null || r.echo === undefined ||
  (Number.isFinite(r.echo.rhyme) && r.echo.rhyme >= 0 && r.echo.rhyme <= 100 &&
    ['same', 'partial', 'opposite'].includes(r.echo.dirAgree) &&
    Number.isFinite(r.echo.ydayMovePct) && Number.isFinite(r.echo.ydayRangePct) && r.echo.ydayRangePct >= 0 &&
    Number.isFinite(r.echo.todayMovePct) && Number.isFinite(r.echo.todayRangePct) && r.echo.todayRangePct >= 0 &&
    Number.isFinite(r.echo.todayBarsFound) && r.echo.todayBarsFound >= 1 && r.echo.todayBarsFound <= r.barsExpected),
))
const withEcho = rows.filter((r) => r.echo)
ok('dirAgree consistent with the moves', withEcho.every((r) => {
  const e = r.echo
  const fy = flat(e.ydayMovePct, e.ydayRangePct)
  const ft = flat(e.todayMovePct, e.todayRangePct)
  if (e.dirAgree === 'same') return (fy && ft) || (!fy && !ft && e.ydayMovePct > 0 === e.todayMovePct > 0)
  if (e.dirAgree === 'opposite') return !fy && !ft && e.ydayMovePct > 0 !== e.todayMovePct > 0
  return fy !== ft
}))
ok('echo present on most rows (warmed sim covers both lead-ins)', withEcho.length >= Math.floor(rows.length * 0.8), `echo=${withEcho.length}/${rows.length}`)
// QUIET flag: both lead-ins flat by the module's 10%-of-own-travel rule ->
// the agreement is real but trivial. On the wire the flag must be a boolean,
// imply dirAgree 'same' + rhyme >= 50 (free direction points), and agree
// with the lead-in moves/travels the main echo carries (prior echoes have
// no lead-in numbers on the wire, so the arithmetic check is main-only).
ok('quiet flag well-formed + consistent (main echo)', withEcho.every((r) => {
  const e = r.echo
  if (typeof e.quiet !== 'boolean') return false
  if (!e.quiet) return true
  return e.dirAgree === 'same' && e.rhyme >= 50 &&
    flat(e.ydayMovePct, e.ydayRangePct) && flat(e.todayMovePct, e.todayRangePct)
}))
ok('non-quiet echoes have a real mover on one side', withEcho.every((r) => {
  const e = r.echo
  if (e.quiet) return true
  return Math.abs(e.ydayMovePct) > e.ydayRangePct * 0.1 - 0.001 || Math.abs(e.todayMovePct) > e.todayRangePct * 0.1 - 0.001
}))
console.log(`      quiet echoes: ${withEcho.filter((r) => r.echo.quiet).length}/${withEcho.length}`)
if (r0 && r0.echo) {
  ok('echo rhyme inside 0..100', r0.echo.rhyme >= 0 && r0.echo.rhyme <= 100, `rhyme=${r0.echo.rhyme}`)
  ok('echo today side bounded by the window', r0.echo.todayBarsFound >= Math.max(1, Math.floor(r0.barsExpected * 0.5)) && r0.echo.todayBarsFound <= r0.barsExpected, `today=${r0.echo.todayBarsFound}/${r0.barsExpected}`)
}
ok('sorted by |move| desc', rows.every((x, i, arr) => i === 0 || Math.abs(arr[i - 1].movePct) >= Math.abs(x.movePct)))
ok('OTC rows present (OTC universe warmed)', rows.some((r) => r.otc), `otcRows=${rows.filter((r) => r.otc).length}`)
ok('warmed majors covered', ['EURUSD', 'BTCUSD', 'EURUSD-OTC'].every((a) => rows.some((r) => r.asset === a)), `rows=${rows.length}`)

// ---------- days param: same-hour history past yesterday ----------
// default depth is 1 - rows carry an EMPTY prior, the response echoes days
ok('days defaults to 1 + prior empty', d.body.days === 1 && rows.every((r) => Array.isArray(r.prior) && r.prior.length === 0), `days=${d.body.days}`)
// 5m reaches a week back: ask 3 days, prior days are anchored at T-24h*back
const d3 = await get('/yesterday?tf=5m&days=3')
const d3rows = d3.body.rows ?? []
ok('days=3 echoes 3', d3.status === 200 && d3.body.days === 3, `status=${d3.status} days=${d3.body.days}`)
ok('prior well-formed', d3rows.every((r) => (r.prior ?? []).every((p) =>
  [2, 3].includes(p.back) && Number.isFinite(p.thenTs) && p.thenTs > 0 &&
  Number.isFinite(p.movePct) && ['up', 'down', 'none'].includes(p.dir) &&
  Number.isFinite(p.rangePct) && p.rangePct >= 0 &&
  p.barsFound >= Math.max(1, Math.floor(p.barsExpected * 0.5)) && p.barsFound <= p.barsExpected &&
  ['ASIA', 'LONDON', 'OVERLAP', 'NEWYORK', 'OFF', 'OTC'].includes(p.session),
)))
const d3withPrior = d3rows.filter((r) => (r.prior ?? []).length > 0)
ok('warmed rows carry prior days', d3withPrior.length >= Math.floor(d3rows.length * 0.8), `prior=${d3withPrior.length}/${d3rows.length}`)
if (d3withPrior.length > 0) {
  const p0 = d3withPrior[0].prior[0]
  const tgt2 = Math.floor(d3.body.ts / 1000) - 2 * 86_400
  const exp2 = tgt2 - (tgt2 % 300)
  ok('prior day anchored at T-48h (5m buckets)', Math.abs(p0.thenTs - exp2) <= 300, `thenTs=${p0.thenTs} expected~${exp2}`)
}
ok('gaps allowed but backs only 2..3', d3rows.every((r) => (r.prior ?? []).every((p, i, arr) => p.back >= 2 && p.back <= 3 && (i === 0 || arr[i - 1].back < p.back))))

// prior-day echo: today's lead-in vs THAT day's lead-in - well-formed when
// present, absent (null) is honest, and present on the warmed sim universe
// whose prehistory covers the prior lead-ins
ok('prior echoes well-formed when present', d3rows.every((r) => (r.prior ?? []).every((p) =>
  p.echo === null || p.echo === undefined ||
  (Number.isInteger(p.echo.rhyme) && p.echo.rhyme >= 0 && p.echo.rhyme <= 100 &&
    ['same', 'partial', 'opposite'].includes(p.echo.dirAgree)),
)))
const d3priorEntries = d3rows.flatMap((r) => r.prior ?? [])
const d3priorEchoed = d3priorEntries.filter((p) => p.echo != null)
ok('prior echoes present on most remembered days (sim prehistory covers)', d3priorEntries.length > 0 && d3priorEchoed.length >= Math.floor(d3priorEntries.length * 0.7), `echoed=${d3priorEchoed.length}/${d3priorEntries.length}`)
ok('prior echoes: quiet well-formed, implies same + rhyme >= 50', d3priorEchoed.every((p) => {
  if (typeof p.echo.quiet !== 'boolean') return false
  if (!p.echo.quiet) return true
  return p.echo.dirAgree === 'same' && p.echo.rhyme >= 50
}))
console.log(`      quiet prior echoes: ${d3priorEchoed.filter((p) => p.echo.quiet).length}/${d3priorEchoed.length}`)
// rhyme arithmetic bounds by dirAgree: same = 50 dir pts + 0..50 -> >=50,
// opposite = 0 dir pts + <=30 + <=20 -> <=50, partial = 25 + 0..50 -> 25..75
ok('prior rhyme arithmetic consistent with dirAgree', d3priorEchoed.every((p) =>
  (p.echo.dirAgree === 'same' ? p.echo.rhyme >= 50 : true) &&
  (p.echo.dirAgree === 'opposite' ? p.echo.rhyme <= 50 : true) &&
  (p.echo.dirAgree === 'partial' ? p.echo.rhyme >= 25 && p.echo.rhyme <= 75 : true),
))
// clamp: 99 -> 7 (5m fits a week), depth gate: 1m + 3d needs 4442 bars > 4000
const d7 = await get('/yesterday?tf=5m&days=99')
ok('days clamped to 7', d7.status === 200 && d7.body.days === 7, `days=${d7.body.days}`)
const tooDeep = await get('/yesterday?tf=1m&days=3')
ok('1m days=3 refused by the depth gate', tooDeep.status === 400 && /depth|reach/.test(tooDeep.body.error ?? ''), JSON.stringify(tooDeep.body).slice(0, 160))
const d2m1 = await get('/yesterday?tf=1m&days=2')
ok('1m days=2 fits and answers', d2m1.status === 200 && d2m1.body.days === 2 && (d2m1.body.rows ?? []).every((r) => (r.prior ?? []).length <= 1), `status=${d2m1.status}`)
ok('1m days=2 prior echoes bounded', (d2m1.body.rows ?? []).every((r) => (r.prior ?? []).every((p) => p.echo == null || (p.echo.rhyme >= 0 && p.echo.rhyme <= 100))))

// ---------- cache + window param ----------
const [c1, c2] = await Promise.all([get('/yesterday?tf=1m'), get('/yesterday?tf=1m')])
ok('60s cache serves the same scan', c1.body.ts === c2.body.ts)
const w15 = await get('/yesterday?tf=1m&window=15')
ok('window=15 echoed', w15.status === 200 && w15.body.windowMin === 15, `windowMin=${w15.body.windowMin}`)
ok('window=15 quantizes to 1m bars', (w15.body.rows ?? []).every((r) => r.barsExpected === 15), JSON.stringify(w15.body.rows?.[0]?.barsExpected))
const wClamp = await get('/yesterday?tf=1m&window=9999')
ok('window clamped to 240', wClamp.status === 200 && wClamp.body.windowMin === 240, `windowMin=${wClamp.body.windowMin}`)

// ---------- tf respect: per-tf scans, no cross-tf leak ----------
const m5 = await get('/yesterday?tf=5m')
ok('5m scan 200 + tf echo', m5.status === 200 && m5.body.ok === true && m5.body.tf === '5m', `tf=${m5.body.tf}`)
ok('5m window quantizes to 5m bars (60min -> 12 bars)', (m5.body.rows ?? []).every((r) => r.barsExpected === 12), JSON.stringify(m5.body.rows?.[0]?.barsExpected))
const m1back = await get('/yesterday?tf=1m')
ok('1m after 5m still reports 1m (no cross-tf cache leak)', m1back.body.tf === '1m', `tf=${m1back.body.tf}`)
ok('per-tf scans are distinct', m5.body.ts !== m1back.body.ts, `5m ts=${m5.body.ts} 1m ts=${m1back.body.ts}`)

// ---------- gates: garbage tf, unsupported tf, deep-tf quantization ----------
const bad = await get('/yesterday?tf=bogus')
ok('garbage tf rejected', bad.status === 400 && bad.body.ok === false)
const fast = await get('/yesterday?tf=5s')
ok('5s refused (24h lookback cannot fit the archive depth)', fast.status === 400 && /archive depth/.test(fast.body.error ?? ''), JSON.stringify(fast.body).slice(0, 160))
const fast15 = await get('/yesterday?tf=15s')
ok('15s refused too', fast15.status === 400)
const h4 = await get('/yesterday?tf=4h&window=60')
ok('4h window snaps up to one bar (240m) and answers', h4.status === 200 && h4.body.windowMin === 240, `windowMin=${h4.body.windowMin} status=${h4.status}`)

// ---------- /candles deep read (the echo click-through's chart feed) ----------
// deep=1 serves the accumulated archive + live tail (getCandlesDeep) up to
// the 4000-bar archive depth - the page uses it to put a full day + the
// replay window of REAL remembered bars behind the click-through scroll.
const plainC = await get('/candles?asset=BTCUSD&tf=1m&limit=320')
const deepC = await get('/candles?asset=BTCUSD&tf=1m&limit=1600&deep=1')
ok('deep read 200 + ok', deepC.status === 200 && deepC.body.ok === true, JSON.stringify(deepC.body).slice(0, 160))
ok('deep echoes deep:true + asset/tf', deepC.body.deep === true && deepC.body.asset === 'BTCUSD' && deepC.body.tf === '1m', `deep=${deepC.body.deep} tf=${deepC.body.tf}`)
ok('plain read does not claim deep', plainC.status === 200 && plainC.body.deep === undefined)
const dp = deepC.body.candles ?? []
const pp = plainC.body.candles ?? []
ok('deep supplies materially more bars than the plain chart feed', dp.length > pp.length, `deep=${dp.length} plain=${pp.length}`)
ok('deep reaches further back than the plain feed', dp.length > 0 && pp.length > 0 && dp[0].time < pp[0].time, `deep first=${dp[0]?.time} plain first=${pp[0]?.time}`)
ok('deep bars ascend with positive prices', dp.every((c, i) => i === 0 || c.time > dp[i - 1].time) && dp.every((c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0))
const nowSec = Math.floor(Date.now() / 1000)
ok('deep tail touches the live edge', dp.length > 0 && dp[dp.length - 1].time >= nowSec - 120, `last=${dp[dp.length - 1]?.time} now=${nowSec}`)
const clamped = await get('/candles?asset=BTCUSD&tf=1m&limit=99999&deep=1')
ok('deep clamps at the 4000-bar archive depth', clamped.status === 200 && (clamped.body.candles ?? []).length <= 4000, `len=${(clamped.body.candles ?? []).length}`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
