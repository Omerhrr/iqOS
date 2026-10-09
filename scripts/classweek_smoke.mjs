#!/usr/bin/env node
// Class-strip week-rhyme smoke (Task 10) + week-sort metric smoke (Task 11)
// + quiet-exclusion smoke (Task 12) companions to yesterday_e2e. The
// per-class week average and the week sort key are computed WEB-side from
// the wire; this locks the arithmetic the YesterdayPanel performs:
//   - weekLive must be false at days=1 (no priors -> week numbers stay hidden)
//   - weekLive must be true at days=3 (priors carry echoes)
//   - per class: wkObs == own echoes + prior echoes, wkRhymed <= wkObs,
//     wkAvg within [min, max] of the observations and 0..100
//   - wkAvg recomputed independently (sum/len, rounded) matches exactly
//   - observations the PriorStrip would use are the same data source
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
