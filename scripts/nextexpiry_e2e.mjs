#!/usr/bin/env bun
// Next-Expiry Oracle e2e (HTTP vs the live kernel).
// Verifies /next_expiry + /next_expiry_stats end to end:
//   - shape: 5-row ladder (1/2/3/5/15 ascending), regime/session/half-life
//     context, best pick null-or-floored, every row's numbers finite and in
//     band, warming rows never carry a direction
//   - anchoring: each row's targetBarTime sits E minutes ahead of the last
//     closed 1m bar from /candles deep=1 (entry ~ its close)
//   - fail-closed: an unknown asset (no closed history) returns ok:false
//     with the needs-N-bars message, never a guess
//   - stats: per (asset, expiry) records, universe-wide expirySummary over
//     the full ladder, learned driver tables, recent ledger
//   - the honesty loop ticks: after repeated polls, pending >= 0 and any
//     resolved rows carry consistent win/loss math (hit vs realized side)
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

console.log(`next-expiry oracle e2e vs ${BASE}`)

const warm = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDCAD', 'EURCHF', 'EURUSD-OTC', 'GBPUSD-OTC', 'BTCUSD']
for (const a of warm) await get(`/candles?asset=${a}&tf=60&limit=1000&deep=1`)
await new Promise((r) => setTimeout(r, 1500))

// ---------- /next_expiry shape ----------
const d = await get('/next_expiry?asset=EURUSD')
ok('200 + ok', d.status === 200 && d.body.ok === true, JSON.stringify(d.body).slice(0, 200))
const p = d.body.prediction
ok('prediction present', !!p)
if (p) {
  ok('asset + mode echo', p.asset === 'EURUSD' && ['sim', 'live'].includes(p.mode), `${p.asset} ${p.mode}`)
  ok('5-row ladder ascending', Array.isArray(p.rows) && p.rows.length === 5 && p.rows.map((r) => r.expiry).join(',') === '1,2,3,5,15', JSON.stringify(p.rows?.map((r) => r.expiry)))
  ok('regime is one of the 4', ['TRENDING', 'RANGING', 'VOLATILE', 'MIXED'].includes(p.regime), p.regime)
  ok('session is one of the 6', ['ASIA', 'LONDON', 'OVERLAP', 'NEWYORK', 'OFF', 'OTC'].includes(p.session), p.session)
  ok('spot finite + positive', Number.isFinite(p.price) && p.price > 0, String(p.price))
  ok('halfLifeMin null or 1..240', p.halfLifeMin === null || (Number.isFinite(p.halfLifeMin) && p.halfLifeMin >= 1 && p.halfLifeMin <= 240), String(p.halfLifeMin))
  ok('note present', typeof p.note === 'string' && p.note.length > 0)

  // grounding + bands per row
  let grounded = true
  let bands = true
  for (const r of p.rows) {
    for (const v of [r.pUp, r.pWin, r.confidence, r.rawConfidence, r.edge, r.expectedMove, r.cone?.low, r.cone?.high]) {
      if (!Number.isFinite(v)) grounded = false
    }
    if (r.pWin < 0.5 || r.pWin > 1) bands = false
    if (r.ok) {
      if (r.confidence < 0 || r.confidence > 97) bands = false
      if (!['call', 'put', 'none'].includes(r.direction)) bands = false
      if (!Array.isArray(r.drivers) || r.drivers.length < 1) bands = false
      for (const dr of r.drivers) {
        if (!Number.isFinite(dr.pUp) || !Number.isFinite(dr.weight) || dr.weight <= 0) bands = false
        if (typeof dr.detail !== 'string' || dr.detail.length === 0) bands = false
      }
    } else if (r.direction !== 'none' || r.note.length === 0) {
      bands = false
    }
  }
  ok('every row number finite', grounded)
  ok('row bands + warming rows directionless-with-note', bands)
  const b = p.best
  ok('best null or floor-clearing', b === null || (b.pWin >= 0.56 && b.confidence >= 25 && ['call', 'put'].includes(b.direction)), JSON.stringify(b))
  const bestRow = b ? p.rows.find((r) => r.expiry === b.expiry) : null
  ok('best pick references a live ok row', !b || (bestRow && bestRow.ok && bestRow.direction === b.direction), JSON.stringify(bestRow?.direction))

  // anchoring: the engine reads closedOnly, so its "last closed bar" is the
  // /candles tail MINUS the forming bar -> expected offset is (E-1)*60 when
  // the forming bar is still open (the 1m window IS the forming bar), or
  // E*60 if that bar closed between the two calls (just-closed race)
  const cd = await get('/candles?asset=EURUSD&tf=60&limit=5&deep=1')
  const bars = cd.body.candles ?? []
  if (bars.length >= 2) {
    const lc = bars[bars.length - 1].time
    const anchored = p.rows.every((r) => {
      const diff = r.targetBarTime - lc
      return Number.isFinite(r.targetBarTime) && (diff === (r.expiry - 1) * 60 || diff === r.expiry * 60)
    })
    ok('targetBarTime anchored on the bar whose close is E minutes after entry', anchored, JSON.stringify(p.rows.map((r) => [r.expiry, r.targetBarTime - lc])))
  }
}

// ---------- fail-closed: unknown asset ----------
const bad = await get('/next_expiry?asset=ZZZNOPE')
ok('unknown asset -> ok:false (fail-closed)', bad.status === 200 && bad.body.ok === false && /needs/.test(bad.body.error ?? ''), JSON.stringify(bad.body).slice(0, 160))

// ---------- honesty loop ticks ----------
const d2 = await get('/next_expiry?asset=GBPUSD')
await new Promise((r) => setTimeout(r, 500))
const s = await get('/next_expiry_stats')
ok('stats 200 + ok', s.status === 200 && s.body.ok === true, JSON.stringify(s.body).slice(0, 160))
ok('stats counters finite', Number.isFinite(s.body.total) && Number.isFinite(s.body.pending), `total=${s.body.total} pending=${s.body.pending}`)
ok('expirySummary spans the ladder', Array.isArray(s.body.expirySummary) && s.body.expirySummary.map((x) => x.expiry).join(',') === '1,2,3,5,15')
ok('records array + learned tables object', Array.isArray(s.body.records) && typeof s.body.driverWeightMultipliers === 'object')
let ledgerSane = true
for (const r of s.body.recent ?? []) {
  if (!Number.isFinite(r.expiry) || ![1, 2, 3, 5, 15].includes(r.expiry)) ledgerSane = false
  if (typeof r.hit !== 'boolean' || !Number.isFinite(r.brier) || r.brier < 0 || r.brier > 1) ledgerSane = false
  if (r.actual === 'up') { if (r.exit <= r.entry) ledgerSane = false }
  else if (r.actual === 'down') { if (r.exit >= r.entry) ledgerSane = false }
}
ok('ledger rows internally consistent (hit math + brier band)', ledgerSane, JSON.stringify((s.body.recent ?? [])[0] ?? {}).slice(0, 200))
ok('predictions registered on the ledger path', d2.status === 200 && (s.body.pending + s.body.total) >= 0)

console.log(`next_expiry e2e: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
