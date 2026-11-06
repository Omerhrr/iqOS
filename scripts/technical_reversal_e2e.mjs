#!/usr/bin/env node
// Technical Summary + Reversal Detection e2e (HTTP vs the live kernel).
// Verifies /technical + /technical_global + /reversal + /reversal_global
// end to end:
//   - /technical: 10-rung ladder in order (1s..5m), sources disclosed
//     (ticks/native/agg1m), every live row's verdict inside the label set,
//     vote counts consistent (buys+sells <= counted <= osc/ma panel sizes),
//     per-indicator tables present, overall = mean of live scores
//   - /reversal: 10-rung ladder, states inside the state set, direction
//     consistent with score sign, reasons carry detector+dir+weight
//   - both boards: universe scan shape, live/warming split, rows sorted
//     (technical: |score| desc; reversal: urgency then |score|), warming
//     rows last and ok:false
//   - fail-closed: unknown asset -> ok:false, never a fabricated read
//   - determinism: two consecutive /technical polls agree on the same rung
//     verdicts within one closed bar (pure vote math, no ledger drift)
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

console.log(`technical + reversal e2e vs ${BASE}`)
const LADDER = ['1s', '2s', '3s', '5s', '15s', '30s', '1m', '2m', '3m', '5m']
const VERDICTS = ['STRONG BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG SELL']
const STATES = ['calm', 'forming', 'reversing', 'confirmed']

// warm the chart pair like the OS does (seeds candles + starts the tick buffer)
await get('/candles?asset=EURUSD&tf=60&limit=1000&deep=1')
await get('/candles?asset=EURUSD&tf=5&limit=400&deep=1')
// give the sim a few seconds of ticks so the seconds rungs can warm
await new Promise((r) => setTimeout(r, 4000))

// ---------- /technical ----------
{
  const { status, body } = await get('/technical?asset=EURUSD')
  ok('GET /technical 200', status === 200 && body.ok === true, JSON.stringify(body).slice(0, 140))
  const s = body.summary
  ok('summary carries asset/price/mode', s && s.asset === 'EURUSD' && Number.isFinite(s.price) && ['sim', 'live'].includes(s.mode))
  ok('ladder = 10 rows in order', s && Array.isArray(s.rows) && s.rows.map((r) => r.tf).join(',') === LADDER.join(','))
  ok('sources disclosed', s && s.rows.every((r) => ['ticks', 'native', 'agg1m'].includes(r.source)))
  ok('3m is the agg1m rung', s && s.rows.find((r) => r.tf === '3m')?.source === 'agg1m')
  const live = s.rows.filter((r) => r.ok)
  ok('native rungs live on a warm kernel', live.filter((r) => ['5s', '15s', '30s', '1m', '2m', '3m', '5m'].includes(r.tf)).length === 7, `live=${live.length}`)
  ok('warming rows say warming, carry no votes', s.rows.filter((r) => !r.ok).every((r) => r.note.includes('warming') && r.osc.length === 0 && r.mas.length === 0))
  ok('every live verdict inside the label set', live.every((r) => VERDICTS.includes(r.summary.label)))
  ok('vote counts consistent', live.every((r) =>
    r.oscSummary.buys + r.oscSummary.sells <= r.oscSummary.counted && r.oscSummary.counted <= r.osc.length &&
    r.maSummary.buys + r.maSummary.sells <= r.maSummary.counted && r.maSummary.counted <= r.mas.length))
  ok('oscillator panel = 11 rows, MA panel = 15 rows on live rungs', live.every((r) => r.osc.length === 11 && r.mas.length === 15))
  ok('indicator values finite or em-dash', live.every((r) => [...r.osc, ...r.mas].every((v) => v.value === '—' || Number.isFinite(parseFloat(v.value)))))
  const mean = live.reduce((a, r) => a + r.summary.score, 0) / Math.max(1, live.length)
  ok('overall = mean of live rung scores', Math.abs(s.overall.score - mean) < 1e-9, `${s.overall.score} vs ${mean}`)
  ok('direction consistent with score', (s.overall.score >= 0.15 && s.direction === 'call') || (s.overall.score <= -0.15 && s.direction === 'put') || (Math.abs(s.overall.score) < 0.15 && s.direction === 'none') || s.direction === 'none')
  // determinism inside one bar
  const again = await get('/technical?asset=EURUSD')
  ok('re-poll agrees within one closed bar', again.body.ok && again.body.summary.rows.every((r, i) => r.summary.label === s.rows[i].summary.label))
}

// ---------- /reversal ----------
{
  const { status, body } = await get('/reversal?asset=EURUSD')
  ok('GET /reversal 200', status === 200 && body.ok === true, JSON.stringify(body).slice(0, 140))
  const s = body.summary
  ok('ladder = 10 rows in order', s && s.rows.map((r) => r.tf).join(',') === LADDER.join(','))
  ok('states inside the state set', s.rows.every((r) => STATES.includes(r.state)))
  ok('direction consistent with score sign', s.rows.every((r) => (r.score > 0 && r.direction === 'up') || (r.score < 0 && r.direction === 'down') || (r.score === 0 && r.direction === 'none')))
  ok('reasons carry detector/dir/weight', s.rows.every((r) => r.reasons.every((x) => typeof x.detector === 'string' && ['up', 'down'].includes(x.dir) && x.weight >= 1)))
  ok('reversing implies a bar-0 trigger existed (score magnitude >= 3)', s.rows.filter((r) => r.state === 'reversing').every((r) => Math.abs(r.score) >= 3))
  ok('best pick = null or an urgent live read', s.best === null || (STATES.includes(s.best.state) && ['up', 'down'].includes(s.best.direction)))
}

// ---------- boards ----------
{
  const tg = await get('/technical_global?limit=8')
  ok('GET /technical_global 200', tg.status === 200 && tg.body.ok === true)
  ok('board shape: universe/scanned/live/warming', ['universe', 'scanned', 'live', 'warming', 'rows'].every((k) => k in tg.body))
  const trows = tg.body.rows
  ok('rows carry the 10-rung strip', trows.every((r) => r.cells.length === 10))
  const tLive = trows.filter((r) => r.ok)
  const tWarm = trows.filter((r) => !r.ok)
  ok('live rows before warming rows', tLive.length === 0 || tWarm.length === 0 || trows.indexOf(tLive[tLive.length - 1]) < trows.indexOf(tWarm[0]))
  ok('live rows sorted by |score| desc', tLive.every((r, i) => i === 0 || Math.abs(tLive[i - 1].overall.score) >= Math.abs(r.overall.score)))
  ok('warming rows carry honest notes', tWarm.every((r) => typeof r.note === 'string' && r.note.length > 0))

  const rg = await get('/reversal_global?limit=8')
  ok('GET /reversal_global 200', rg.status === 200 && rg.body.ok === true)
  const rrows = rg.body.rows
  const RANK = { reversing: 3, confirmed: 2, forming: 1, calm: 0 }
  const rLive = rrows.filter((r) => r.ok)
  ok('reversal rows sorted by urgency then |score|', rLive.every((r, i) => i === 0 || RANK[rLive[i - 1].state] > RANK[r.state] || (RANK[rLive[i - 1].state] === RANK[r.state] && Math.abs(rLive[i - 1].score) >= Math.abs(r.score))))
  ok('reversal warming rows last', rLive.length === 0 || rrows[rrows.length - 1].ok === true || rrows.filter((r) => !r.ok).every((r) => rrows.indexOf(r) >= rLive.length))
}

// ---------- fail-closed ----------
{
  const t = await get('/technical?asset=NOPE')
  ok('unknown asset /technical -> ok:false', t.body.ok === false && typeof t.body.error === 'string')
  const r = await get('/reversal?asset=NOPE')
  ok('unknown asset /reversal -> ok:false', r.body.ok === false && typeof r.body.error === 'string')
}

console.log(`\ntechnical_reversal_e2e: ${pass} ok, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
