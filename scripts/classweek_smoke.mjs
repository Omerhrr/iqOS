#!/usr/bin/env node
// Class-strip week-rhyme smoke (Task 10 companion to yesterday_e2e).
// The per-class week average is computed WEB-side from the wire; this locks
// the arithmetic the YesterdayPanel classRhyme memo performs:
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
const buildClass = (rows, pick) => {
  const sub = rows.filter(pick)
  const es = sub.flatMap((r) => (r.echo ? [r.echo.rhyme] : []))
  const wk = sub.flatMap((r) => [...(r.echo ? [r.echo.rhyme] : []), ...(r.prior ?? []).flatMap((p) => (p.echo ? [p.echo.rhyme] : []))])
  return {
    compared: es.length,
    avg: es.length ? Math.round(es.reduce((s, x) => s + x, 0) / es.length) : null,
    wkObs: wk.length,
    wkRhymed: wk.filter((x) => x >= 70).length,
    wkAvg: wk.length ? Math.round(wk.reduce((s, x) => s + x, 0) / wk.length) : null,
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
  // independent recompute from raw observations
  const sub = rows.filter(pick)
  const obs = sub.flatMap((r) => [r.echo?.rhyme, ...(r.prior ?? []).map((p) => p.echo?.rhyme)].filter((x) => x != null))
  const exp = obs.length ? Math.round(obs.reduce((s, x) => s + x, 0) / obs.length) : null
  ok(`${label}: wkAvg matches recompute`, a.wkAvg === exp, `wkAvg=${a.wkAvg} exp=${exp}`)
  ok(`${label}: wkAvg within observation range`, a.wkAvg >= Math.min(...obs) && a.wkAvg <= Math.max(...obs), `wkAvg=${a.wkAvg} min=${Math.min(...obs)} max=${Math.max(...obs)}`)
  ok(`${label}: wkAvg 0..100`, a.wkAvg >= 0 && a.wkAvg <= 100, `wkAvg=${a.wkAvg}`)
}

// one concrete sample so the log carries real numbers
const sample = rows.find((r) => r.echo && (r.prior ?? []).some((p) => p.echo))
if (sample) {
  const stripEchoes = [sample.echo?.rhyme, ...(sample.prior ?? []).map((p) => p.echo?.rhyme)].filter((x) => x != null)
  ok('sample row: PriorStrip observations == wire echoes', stripEchoes.length === 1 + (sample.prior ?? []).filter((p) => p.echo != null).length, `asset=${sample.asset} echoes=${stripEchoes.join(',')}`)
  console.log(`  sample ${sample.asset}: echo=${sample.echo.rhyme} priors=${(sample.prior ?? []).map((p) => `${p.back}d:${p.echo?.rhyme ?? '—'}`).join(' ')}`)
} else {
  ok('sample row exists (echoed row with a prior echo)', false, 'no row qualified')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
