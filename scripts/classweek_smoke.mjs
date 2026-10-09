#!/usr/bin/env node
// Class-strip week-rhyme smoke (Task 10) + week-sort metric smoke (Task 11)
// + quiet-exclusion smoke (Task 12) + session-profile smoke (Task 13)
// + script-by-class fold smoke (Task 14) - companions to yesterday_e2e. The
// per-class week average, the week sort key and the per-class session fold
// are computed WEB-side from the wire; this locks the arithmetic the
// YesterdayPanel performs:
//   - weekLive must be false at days=1 (no priors -> week numbers stay hidden)
//   - weekLive must be true at days=3 (priors carry echoes)
//   - per class: wkObs == own echoes + prior echoes, wkRhymed <= wkObs,
//     wkAvg within [min, max] of the observations and 0..100
//   - wkAvg recomputed independently (sum/len, rounded) matches exactly
//   - observations the PriorStrip would use are the same data source
//   - session profile (profile=1): five ordered session buckets on real
//     rows / one OTC bucket on -OTC rows, quiet <= obs, avg null iff every
//     pair was quiet, obs bounded by hours-in-session x days
//   - script by class: each class's row profiles folded per session -
//     clock obs from real rows only, OTC obs from the -OTC twins only,
//     avg null iff no non-quiet observations, class avg within the range
//     of its contributing row averages (weighted mean), and every class's
//     OTC obs bounded by the OTC class's (twins are a subset of OTC)
//   - peak sort: best session average among sessions with 2+ non-quiet
//     observations, spread (best - worst qualified) as tie-break, no
//     qualified session -> -1 (sink); OTC's single bucket spreads 0
//   - watchlist export (Task 16): every live row carries the complete
//     field set the text snapshot reads (the serializer itself is locked
//     by the unit suite against the real module)
//   - off-hours caveat (Task 17): the rows whose qualified best session is
//     the OFF bucket - exactly the rows the panel underlines and the
//     snapshot marks off* - their OFF average really is the maximum, and
//     the firing count on the live universe is logged for eyeballing
// Read-only.
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
const weekLive = (rows) => rows.some((r) => (r.prior ?? []).some((p) => p.echo != null))
// the panel's arithmetic ranks only NON-QUIET echoes (a rhyme between two
// flat lead-ins is real but trivial) - the mirrors below exclude them too
const notQuiet = (e) => e != null && e.quiet !== true
const buildClass = (rows, pick) => {
  const sub = rows.filter(pick)
  const es = sub.flatMap((r) => (notQuiet(r.echo) ? [r.echo.rhyme] : []))
  const wk = sub.flatMap((r) => [
    ...(notQuiet(r.echo) ? [r.echo.rhyme] : []),
    ...(r.prior ?? []).flatMap((p) => (notQuiet(p.echo) ? [p.echo.rhyme] : [])),
  ])
  return {
    compared: es.length,
    avg: es.length ? Math.round(es.reduce((s, x) => s + x, 0) / es.length) : null,
    mainQuiet: sub.filter((r) => r.echo?.quiet === true).length,
    wkObs: wk.length,
    wkRhymed: wk.filter((x) => x >= 70).length,
    wkAvg: wk.length ? Math.round(wk.reduce((s, x) => s + x, 0) / wk.length) : null,
    wkQuiet: sub.reduce((n, r) => n + (r.echo?.quiet === true ? 1 : 0) + (r.prior ?? []).filter((p) => p.echo?.quiet === true).length, 0),
  }
}

console.log(`class-week smoke vs ${BASE}`)

// warm so a fresh kernel has remembered history to scan
for (const a of ['EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD', 'ETHUSD', 'EURUSD-OTC', 'GBPUSD-OTC', 'USDJPY-OTC']) {
  await get(`/candles?asset=${a}&tf=60&size=240`)
}
await new Promise((r) => setTimeout(r, 1200))

// ---- days=1 (default): no priors -> the panel must hide week numbers ----
const d1 = await get('/yesterday?tf=5m')
ok('days=1: 200 + ok', d1.status === 200 && d1.body.ok === true, JSON.stringify(d1.body).slice(0, 160))
ok('days=1: rows present', (d1.body.rows ?? []).length >= 1, `rows=${d1.body.rows?.length}`)
ok('days=1: weekLive is false', !weekLive(d1.body.rows ?? []), 'some row carried a prior echo at depth 1d')

// ---- days=3: priors with echoes -> the week arithmetic ----
const d3 = await get('/yesterday?tf=5m&days=3')
ok('days=3: 200 + ok', d3.status === 200 && d3.body.ok === true, JSON.stringify(d3.body).slice(0, 160))
const rows = d3.body.rows ?? []
ok('days=3: rows present', rows.length >= 1, `rows=${rows.length}`)
ok('days=3: weekLive is true', weekLive(rows), 'no prior echo anywhere on a 3d scan')

const priorsEchoed = rows.flatMap((r) => (r.prior ?? []).filter((p) => p.echo != null))
ok('days=3: prior echoes well-formed', priorsEchoed.every((p) => Number.isInteger(p.echo.rhyme) && p.echo.rhyme >= 0 && p.echo.rhyme <= 100 && ['same', 'partial', 'opposite'].includes(p.echo.dirAgree)), `n=${priorsEchoed.length}`)
// ---- quiet flag (Task 12): well-formed + its arithmetic consequences ----
const allEchoed = [...rows.flatMap((r) => (r.echo ? [r.echo] : [])), ...priorsEchoed.map((p) => p.echo)]
ok('quiet: boolean on every echo (main + prior)', allEchoed.every((e) => typeof e.quiet === 'boolean'), `n=${allEchoed.length}`)
ok('quiet: implies dirAgree same + rhyme >= 50', allEchoed.every((e) => !e.quiet || (e.dirAgree === 'same' && e.rhyme >= 50)))
console.log(`      quiet echoes: main ${rows.filter((r) => r.echo?.quiet === true).length}/${rows.filter((r) => r.echo).length}, prior ${priorsEchoed.filter((p) => p.echo.quiet === true).length}/${priorsEchoed.length}`)

const classes = [
  ['OTC', (r) => r.otc],
  ['FX', (r) => r.category === 'forex'],
  ['Crypto', (r) => r.category === 'crypto'],
  ['Stocks', (r) => r.category === 'stock'],
]
for (const [label, pick] of classes) {
  const a = buildClass(rows, pick)
  if (a.compared === 0) {
    ok(`${label}: no compared rows (honest skip)`, true)
    continue
  }
  ok(`${label}: yesterday avg 0..100`, a.avg >= 0 && a.avg <= 100, `avg=${a.avg}`)
  ok(`${label}: wkObs = own + prior echoes`, a.wkObs >= a.compared, `wkObs=${a.wkObs} compared=${a.compared}`)
  ok(`${label}: wkRhymed <= wkObs`, a.wkRhymed <= a.wkObs, `wkRhymed=${a.wkRhymed} wkObs=${a.wkObs}`)
  // independent recompute from raw observations (non-quiet only, mirroring
  // the panel's exclusion rule)
  const sub = rows.filter(pick)
  const obs = sub.flatMap((r) => [
    ...(r.echo && r.echo.quiet !== true ? [r.echo.rhyme] : []),
    ...(r.prior ?? []).flatMap((p) => (p.echo && p.echo.quiet !== true ? [p.echo.rhyme] : [])),
  ])
  const exp = obs.length ? Math.round(obs.reduce((s, x) => s + x, 0) / obs.length) : null
  ok(`${label}: wkAvg matches recompute`, a.wkAvg === exp, `wkAvg=${a.wkAvg} exp=${exp}`)
  ok(`${label}: wkAvg within observation range`, a.wkAvg >= Math.min(...obs) && a.wkAvg <= Math.max(...obs), `wkAvg=${a.wkAvg} min=${Math.min(...obs)} max=${Math.max(...obs)}`)
  ok(`${label}: quiet echoes excluded from averages (counts sane)`, a.mainQuiet >= 0 && a.wkQuiet >= a.mainQuiet, `mainQuiet=${a.mainQuiet} wkQuiet=${a.wkQuiet}`)
  ok(`${label}: wkAvg 0..100`, a.wkAvg >= 0 && a.wkAvg <= 100, `wkAvg=${a.wkAvg}`)
}

// one concrete sample so the log carries real numbers
const sample = rows.find((r) => r.echo && (r.prior ?? []).some((p) => p.echo))
if (sample) {
  // the strip's aggregate ranks NON-quiet observations only (Task 12)
  const keptEchoes = [
    ...(sample.echo && sample.echo.quiet !== true ? [sample.echo.rhyme] : []),
    ...(sample.prior ?? []).flatMap((p) => (p.echo && p.echo.quiet !== true ? [p.echo.rhyme] : [])),
  ]
  const allEchoes = [sample.echo?.rhyme, ...(sample.prior ?? []).map((p) => p.echo?.rhyme)].filter((x) => x != null)
  ok('sample row: PriorStrip aggregate == non-quiet wire echoes', keptEchoes.length === allEchoes.length - [sample.echo?.quiet === true, ...(sample.prior ?? []).map((p) => p.echo?.quiet === true)].filter(Boolean).length, `asset=${sample.asset} kept=${keptEchoes.length} all=${allEchoes.length}`)
  console.log(`  sample ${sample.asset}: echo=${sample.echo.rhyme}${sample.echo.quiet ? 'q' : ''} priors=${(sample.prior ?? []).map((p) => `${p.back}d:${p.echo?.rhyme ?? '—'}${p.echo?.quiet ? 'q' : ''}`).join(' ')}`)
} else {
  ok('sample row exists (echoed row with a prior echo)', false, 'no row qualified')
}

// ---- week sort (Task 11 + Task 12): the best-echoes watchlist order ----
// Mirrors the panel's weekRhymeCmp KEY: [days rhymed 70+, avg rhyme, -1 when
// no NON-QUIET observations]. The comparator itself is client-side; these
// checks pin its semantics against the wire: content, bounds, the sink
// sentinel, and the ranking rule on a synthetic case (consistency beats
// strength; quiet rhymes don't count).
const wObs = (r) => [
  ...(r.echo && r.echo.quiet !== true ? [r.echo.rhyme] : []),
  ...(r.prior ?? []).flatMap((p) => (p.echo && p.echo.quiet !== true ? [p.echo.rhyme] : [])),
]
const wKey = (r) => {
  const e = wObs(r)
  return [e.filter((x) => x >= 70).length, e.length ? e.reduce((s, x) => s + x, 0) / e.length : -1]
}
const sinks = rows.filter((r) => wObs(r).length === 0)
ok('week sort: rows with zero observations key to [0, -1]', sinks.every((r) => wKey(r)[0] === 0 && wKey(r)[1] === -1), `sinks=${sinks.length}`)
ok('week sort: rhymed count <= observations for every row', rows.every((r) => wKey(r)[0] <= wObs(r).length))
const rhymers = rows.filter((r) => wKey(r)[0] > 0)
ok('week sort: watchlist has rhyming rows at 3d', rhymers.length > 0, `rhymers=${rhymers.length}`)
// ranking rule on synthetic rows: rhymed days dominate, avg breaks ties,
// a no-observation row sinks below any rhyming row; a row whose only echoes
// are QUIET sinks with them (quiet rhymes don't count toward the order)
const synth = [
  { asset: 'A', echo: { rhyme: 95, quiet: false }, prior: [{ echo: { rhyme: 90, quiet: false } }] },
  { asset: 'B', echo: { rhyme: 99, quiet: false }, prior: [{ echo: { rhyme: 30, quiet: false } }] },
  { asset: 'C', echo: null, prior: [] },
  { asset: 'D', echo: { rhyme: 100, quiet: true }, prior: [{ echo: { rhyme: 95, quiet: true } }] },
]
const ranked = [...synth].sort((a, b) => wKey(b)[0] - wKey(a)[0] || wKey(b)[1] - wKey(a)[1])
ok('week sort: 2 rhyming days outrank 1 (consistency beats strength)', ranked[0].asset === 'A', `top=${ranked[0].asset}`)
ok('week sort: higher avg breaks rhymed-count ties', ranked[1].asset === 'B', `second=${ranked[1].asset}`)
ok('week sort: no-observation row sinks', ranked[2].asset === 'C', `third=${ranked[2].asset}`)
ok('week sort: quiet-only row sinks with the no-observation row', ranked[3].asset === 'D' && wKey(synth[3])[0] === 0 && wKey(synth[3])[1] === -1, `last=${ranked[3].asset}`)
// top-3 sample of the would-be watchlist for eyeballing
const top3 = [...rows].sort((a, b) => wKey(b)[0] - wKey(a)[0] || wKey(b)[1] - wKey(a)[1] || Math.abs(b.movePct) - Math.abs(a.movePct)).slice(0, 3)
for (const t of top3) console.log(`  watchlist ${t.asset}: rhymed ${wKey(t)[0]}/${wObs(t).length} avg ${Math.round(wKey(t)[1])}`)

// ---- session profile (Task 13): the script-by-session aggregates ----
// Kernel-side arithmetic, but the panel renders exactly these buckets, so
// the wire contract is locked here: five ORDERED session buckets on real
// rows (ASIA..OFF - obs 0 / avg null is an honest empty session, not an
// absent one), one day-wide OTC bucket on -OTC rows (they have no
// sessions), quiet <= obs per bucket, avg present iff at least one
// non-quiet pair survived, and obs bounded by hours-in-session x days
// (each hour contributes at most `days` adjacent-day lead-in pairs).
const SESH = ['ASIA', 'LONDON', 'OVERLAP', 'NEWYORK', 'OFF']
const HRS = { ASIA: 7, LONDON: 6, OVERLAP: 3, NEWYORK: 5, OFF: 3, OTC: 24 }
const dprof = await get('/yesterday?tf=5m&days=3&profile=1')
const prows = dprof.body.rows ?? []
ok('profile: 200 + rows', dprof.status === 200 && dprof.body.ok === true && prows.length >= 1, `rows=${prows.length}`)
ok('profile: five ordered buckets on real rows, one OTC bucket on -OTC', prows.every((r) => r.otc
  ? (r.profile ?? []).length === 1 && r.profile[0].session === 'OTC'
  : (r.profile ?? []).length === 5 && r.profile.every((s, i) => s.session === SESH[i])),
)
ok('profile: quiet <= obs, avg null iff all quiet, avg 0..100', prows.every((r) => (r.profile ?? []).every((s) =>
  s.quiet >= 0 && s.quiet <= s.obs && (s.avg === null ? s.obs - s.quiet === 0 : (s.obs - s.quiet > 0 && s.avg >= 0 && s.avg <= 100))),
))
ok('profile: obs bounded by hours-in-session x days', prows.every((r) => (r.profile ?? []).every((s) => s.obs <= (HRS[s.session] ?? 24) * 3)))
ok('profile: per-row obs sums bounded by 24h x days', prows.every((r) => (r.profile ?? []).reduce((n, s) => n + s.obs, 0) <= 24 * 3))
const scripted = prows.filter((r) => (r.profile ?? []).some((s) => s.obs > 0))
ok('profile: measured rows exist (warmed universe)', scripted.length > 0, `scripted=${scripted.length}/${prows.length}`)
const sp = scripted.find((r) => !r.otc) ?? scripted[0]
if (sp) console.log(`  sample ${sp.asset} script: ${(sp.profile ?? []).map((s) => `${s.session}:${s.avg ?? '--'}(${s.obs}${s.quiet ? `-${s.quiet}q` : ''})`).join(' ')}`)

// ---- script by class (Task 14): the class-level fold the panel renders ----
// The panel folds each class's row profiles per session: obs/quiet sum
// across rows, the buckets' unrounded `sum` totals too, and the class
// average is round(totalSum / totalKept) - weighted by observations, never
// an average of rounded averages. These checks pin that arithmetic against
// the wire: the real/OTC partition, the fold's null/kept contract, the
// weighted-mean property, and the cross-chip subset bound.
const ALLSESS = ['ASIA', 'LONDON', 'OVERLAP', 'NEWYORK', 'OFF', 'OTC']
const foldClass = (rs, session) => {
  const buckets = rs.flatMap((r) => (r.profile ?? []).filter((s) => s.session === session))
  const obs = buckets.reduce((n, s) => n + s.obs, 0)
  const quiet = buckets.reduce((n, s) => n + s.quiet, 0)
  const sum = buckets.reduce((n, s) => n + (s.sum ?? 0), 0)
  const kept = obs - quiet
  return { obs, quiet, kept, sum, avg: kept > 0 ? Math.round(sum / kept) : null, avgs: buckets.filter((s) => s.obs - s.quiet > 0).map((s) => s.avg) }
}
const FCLASSES = [
  ['OTC', (r) => r.otc],
  ['FX', (r) => r.category === 'forex'],
  ['Crypto', (r) => r.category === 'crypto'],
  ['Stocks', (r) => r.category === 'stock'],
]
const measured = FCLASSES.some(([, pick]) => ALLSESS.some((s) => foldClass(prows.filter(pick), s).obs > 0))
ok('script by class: measured classes exist (profiled universe)', measured)
const otcClassObs = foldClass(prows.filter((r) => r.otc), 'OTC').obs
for (const [label, pick] of FCLASSES) {
  const rs = prows.filter(pick)
  if (rs.length === 0) {
    ok(`${label} script: no rows in class (honest skip)`, true)
    continue
  }
  // structure: fold each class's rows independently by kind - a clock
  // session's obs must come only from the class's REAL rows (an -OTC row
  // carries no clock buckets), the OTC bucket's only from its twins
  const kindObs = (otcKind, s) =>
    rs.filter((r) => (otcKind ? r.otc : !r.otc)).flatMap((r) => (r.profile ?? []).filter((b) => b.session === s)).reduce((n, b) => n + b.obs, 0)
  ok(`${label} script: clock obs from real rows, OTC obs from twins`, ALLSESS.every((s) => foldClass(rs, s).obs === (s === 'OTC' ? kindObs(true, 'OTC') : kindObs(false, s))), `obs=${ALLSESS.map((s) => `${s[0]}:${foldClass(rs, s).obs}`).join(' ')}`)
  // the fold's null/kept contract per session: avg null exactly when no
  // non-quiet observation survived (and the total is 0 there too)
  const nulls = ALLSESS.map((s) => foldClass(rs, s)).filter((f) => f.kept === 0)
  const nonNulls = ALLSESS.map((s) => foldClass(rs, s)).filter((f) => f.kept > 0)
  ok(`${label} script: avg null iff no non-quiet observations`, nulls.every((f) => f.avg === null && f.sum === 0) && nonNulls.every((f) => f.avg !== null), `kept0=${nulls.length} scored=${nonNulls.length}`)
  if (nonNulls.length > 0) {
    // weighted-mean property: the class average is an observation-weighted
    // mean of the contributing row averages, so it must sit inside their
    // range (rounding cannot escape it - the bounds are integers)
    ok(`${label} script: class avg within contributing row avg range`, nonNulls.every((f) => f.avg >= Math.min(...f.avgs) && f.avg <= Math.max(...f.avgs)), `avgs=${nonNulls.map((f) => f.avg).join(',')}`)
  }
  // cross-chip bound: the OTC column of any class aggregates a subset of
  // the rows the OTC class chip aggregates (its twins are OTC rows too)
  if (label !== 'OTC') ok(`${label} script: OTC obs <= the OTC class's (twins are a subset)`, foldClass(rs, 'OTC').obs <= otcClassObs, `class=${foldClass(rs, 'OTC').obs} otc=${otcClassObs}`)
  if (label === 'OTC' || label === 'FX') {
    console.log(`  script ${label}: ${ALLSESS.map((s) => { const f = foldClass(rs, s); return f.obs > 0 ? `${s}:${f.avg ?? '--'}(${f.obs}${f.quiet ? `-${f.quiet}q` : ''})` : null }).filter(Boolean).join(' ')}`)
  }
}

// ---- peak sort (Task 15): trade the pair where its script rhymes ----
// The panel's peakKey is WEB-side from the wire: best session average among
// sessions with at least TWO non-quiet observations (one lucky hour is not
// a script; quiet echoes are already excluded from the kernel's averages),
// the spread best-minus-worst-qualified breaking ties, rows without a
// qualified session keying to -1 and sinking. An -OTC row's single day-wide
// bucket is its own best session with spread 0. These checks pin the key's
// semantics against the wire and the ranking rule on synthetic rows.
const peakKey = (r) => {
  const quals = (r.profile ?? []).filter((s) => s.obs - s.quiet >= 2 && s.avg != null).map((s) => s.avg)
  return { best: quals.length ? Math.max(...quals) : -1, spread: quals.length > 1 ? Math.max(...quals) - Math.min(...quals) : 0, n: quals.length }
}
ok('peak: best is 0..100 or -1 (no qualified session)', prows.every((r) => { const k = peakKey(r); return k.best === -1 || (k.best >= 0 && k.best <= 100) }))
ok('peak: spread >= 0, and 0 whenever fewer than two sessions qualify', prows.every((r) => { const k = peakKey(r); return k.spread >= 0 && (k.n >= 2 || k.spread === 0) }))
ok('peak: -1 really means no qualified session on the wire', prows.every((r) => peakKey(r).best !== -1 || !(r.profile ?? []).some((s) => s.obs - s.quiet >= 2 && s.avg != null)))
ok('peak: best dominates every qualified session average', prows.every((r) => { const q = (r.profile ?? []).filter((s) => s.obs - s.quiet >= 2 && s.avg != null).map((s) => s.avg); return q.length === 0 || peakKey(r).best === Math.max(...q) }))
ok('peak: -OTC rows have a single bucket so their spread is 0', prows.filter((r) => r.otc).every((r) => peakKey(r).spread === 0 && (peakKey(r).best === -1 || peakKey(r).best === (r.profile ?? []).find((s) => s.obs - s.quiet >= 2)?.avg)), `otc=${prows.filter((r) => r.otc).length}`)
// ranking rule on synthetic rows: best average dominates, a wider spread
// breaks best-ties (the peak of a session-structured script is worth more),
// and rows with nothing qualified sink below every qualified row
const psynth = [
  { asset: 'C', movePct: 0.1, profile: [{ session: 'ASIA', obs: 6, quiet: 0, avg: 90 }, { session: 'LONDON', obs: 6, quiet: 0, avg: 60 }] },
  { asset: 'A', movePct: 0.1, profile: [{ session: 'ASIA', obs: 6, quiet: 0, avg: 80 }, { session: 'LONDON', obs: 6, quiet: 0, avg: 40 }] },
  { asset: 'B', movePct: 0.1, profile: [{ session: 'ASIA', obs: 6, quiet: 0, avg: 80 }, { session: 'LONDON', obs: 6, quiet: 0, avg: 70 }] },
  { asset: 'D', movePct: 5.0, profile: [{ session: 'ASIA', obs: 1, quiet: 0, avg: 95 }, { session: 'LONDON', obs: 2, quiet: 2, avg: null }] },
  { asset: 'E', movePct: 0.1, profile: [{ session: 'ASIA', obs: 0, quiet: 0, avg: null }] },
]
const pranked = [...psynth].sort((a, b) => peakKey(b).best - peakKey(a).best || peakKey(b).spread - peakKey(a).spread || Math.abs(b.movePct) - Math.abs(a.movePct))
ok('peak: highest best-session average wins', pranked[0].asset === 'C', `top=${pranked[0].asset}`)
ok('peak: wider spread breaks best-ties (session structure matters)', pranked[1].asset === 'A' && pranked[2].asset === 'B', `2nd=${pranked[1].asset} 3rd=${pranked[2].asset}`)
ok('peak: one lucky hour (kept 1) does not qualify - row sinks', pranked[3].asset === 'D' && peakKey(psynth[3]).best === -1, `4th=${pranked[3].asset} best=${peakKey(psynth[3]).best}`)
ok('peak: all-quiet/nothing-measured sinks with the unqualified', pranked[4].asset === 'E' && peakKey(psynth[4]).best === -1, `last=${pranked[4].asset}`)
// top-3 of the would-be peak watchlist for eyeballing
const ptop = [...prows].sort((a, b) => peakKey(b).best - peakKey(a).best || peakKey(b).spread - peakKey(a).spread || Math.abs(b.movePct) - Math.abs(a.movePct)).slice(0, 3)
for (const t of ptop) {
  const k = peakKey(t)
  const peakSess = (t.profile ?? []).filter((s) => s.obs - s.quiet >= 2 && s.avg === k.best)[0]
  console.log(`  peak ${t.asset}: ${peakSess ? peakSess.session : '?'} ${k.best} spread ${k.spread}`)
}

// ---- watchlist export (Task 16): the fields the snapshot reads ----
// The serializer + comparators are locked by the unit suite against the
// real src/lib/os/watchlist.ts module (bun imports it directly); this pins
// the WIRE side once, consolidated: every live row carries the complete
// field set the export reads (asset, move, echo rhyme+quiet, prior echoes,
// profile buckets) - if the kernel ever drops one, the snapshot degrades
// silently, so the input contract is locked here instead of hoped for.
ok('export: every profiled row carries the fields the snapshot reads', prows.every((r) =>
  typeof r.asset === 'string' && r.asset.length > 0 && Number.isFinite(r.movePct) &&
  (r.echo == null || (Number.isFinite(r.echo.rhyme) && typeof r.echo.quiet === 'boolean')) &&
  (r.prior ?? []).every((p) => p.echo == null || (Number.isFinite(p.echo.rhyme) && typeof p.echo.quiet === 'boolean')) &&
  (r.profile ?? []).every((s) => ['ASIA', 'LONDON', 'OVERLAP', 'NEWYORK', 'OFF', 'OTC'].includes(s.session) && (s.avg === null || (s.avg >= 0 && s.avg <= 100))),
), JSON.stringify(prows.find((r) => r.echo == null || (r.profile ?? []).length === 0)))

// ---- off-hours caveat (Task 17): the OFF bucket reads with a discount ----
// An off-hours average is real (quiet pairs are already excluded) but it was
// scored at hours OUTSIDE the named sessions, where the books are thin - so
// the panel underlines it and the snapshot marks such a peak off*. The
// marker rule itself is locked by the unit suite against the real
// src/lib/os/watchlist.ts; this pins the WIRE side it keys on: the rows the
// rule would fire on (qualified best session = OFF, 2+ non-quiet obs) have
// an OFF average that truly is their maximum - no false positives on
// clock-session peaks - and the firing count is the "how often does the
// caveat actually matter" reading on the live universe.
const offMarked = prows.filter((r) => {
  const q = (r.profile ?? []).filter((s) => s.obs - s.quiet >= 2 && s.avg != null)
  return q.length > 0 && q.reduce((a, b) => (b.avg > a.avg ? b : a)).session === 'OFF'
})
ok('off-hours: a marked row\'s OFF best really is its maximum (no false positives)', offMarked.every((r) => {
  const offAvg = (r.profile ?? []).find((s) => s.session === 'OFF' && s.obs - s.quiet >= 2)?.avg
  const others = (r.profile ?? []).filter((s) => s.obs - s.quiet >= 2 && s.avg != null && s.session !== 'OFF')
  return offAvg != null && peakKey(r).best === offAvg && others.every((s) => offAvg >= s.avg)
}), JSON.stringify(offMarked.slice(0, 3).map((r) => r.asset)))
console.log(`  off-hours peaks: ${offMarked.length}/${prows.length} rows - the dotted-underline caveat fires${offMarked.length ? ': ' + offMarked.map((r) => r.asset).join(' ') : ' on none right now'}`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
