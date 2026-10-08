#!/usr/bin/env bun
// Chart-signals scanner e2e - Task 64-a.
// Verifies /signals (option + cfd kinds) against the live kernel: response
// shape, confluence qualification (strength/agreement floors), per-market
// engine sets (footprint for real pairs, otcfootprint for OTC), CFD level
// sanity (SL/TP on the right side, RR floor), TTL freshness, cache, sorting
// and the strict tf gate. Read-only - the scanner touches no kernel state.
const BASE = process.env.IQAIR_OS_URL ?? 'http://localhost:3030'
// P0: kernels started with KERNEL_TOKEN reject unauthenticated REST - send
// the token from env when the target kernel has one.
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
    signal: AbortSignal.timeout(60_000),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

console.log(`chart-signals e2e vs ${BASE}`)

// warm a spread of assets so the scanner has closed history (fresh kernels
// only materialize candles for touched pairs) - includes OTC + crypto so the
// OTC leg of the scan has history to vote on
const warm = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDCAD', 'USDCHF', 'EURCHF', 'NZDUSD', 'USDCAD',
  'EURUSD-OTC', 'GBPUSD-OTC', 'USDJPY-OTC', 'AUDCAD-OTC', 'EURGBP-OTC', 'BTCUSD', 'ETHUSD', 'SOLUSD',
]
for (const a of warm) await get(`/candles?asset=${a}&tf=60&size=240`)
await new Promise((r) => setTimeout(r, 1500))

// ---------- option kind: shape + qualification ----------
const o1 = await get('/signals?kind=option&top=5')
ok('option 200 + ok', o1.status === 200 && o1.body.ok === true)
ok('kind/tf echo', o1.body.kind === 'option' && o1.body.tf === '1m')
ok('scanned >= 8', (o1.body.scanned ?? 0) >= 8, `scanned=${o1.body.scanned}`)
ok('signals <= 5 (top still respected)', Array.isArray(o1.body.signals) && o1.body.signals.length <= 5)
ok('has qualifying signals', o1.body.signals.length >= 1, JSON.stringify(o1.body).slice(0, 200))

const s = o1.body.signals[0] ?? null
if (s) {
  ok('direction call|put', s.direction === 'call' || s.direction === 'put')
  ok('strength = |score| in 35..100', s.strength === Math.abs(s.score) && s.strength >= 35 && s.strength <= 100)
  ok('agreement floor agree>=3, agree<=total', s.agree >= 3 && s.agree <= s.total && s.total === 7)
  ok('expiry 60..300s on the minute', s.expirySec >= 60 && s.expirySec <= 300 && s.expirySec % 60 === 0)
  ok('fresh TTL ~150s', s.validUntil > s.ts && s.validUntil - s.ts >= 149_000 && s.validUntil - s.ts <= 151_000)
  ok('7 engine votes', Array.isArray(s.votes) && s.votes.length === 7)
  const eng = s.votes.map((v) => v.engine)
  if (s.otc) {
    ok('OTC signal votes otcfootprint (not footprint)', eng.includes('otcfootprint') && !eng.includes('footprint'), eng.join(','))
  } else {
    ok('real signal votes footprint (not otcfootprint)', eng.includes('footprint') && !eng.includes('otcfootprint'), eng.join(','))
  }
  ok('every vote dir/weight sane', s.votes.every((v) => [-1, 0, 1].includes(v.dir) && v.weight >= 0 && v.weight <= 1))
}

// ---------- sorting + top param ----------
const sorted = [...(o1.body.signals ?? [])].every((x, i, arr) => i === 0 || arr[i - 1].strength >= x.strength)
ok('sorted by strength desc', sorted)
const o2 = await get('/signals?kind=option&top=2')
ok('top=2 respected', o2.body.signals?.length <= 2)

// ---------- full-universe scan: no top cut, OTC included ----------
// default (no top) returns EVERY qualifying read - the old cap chopped the
// list at 5/10 and the universe at 18 instruments; the whole open set is
// scanned now and the response reports coverage (incl. the OTC split).
const full = await get('/signals?kind=option')
ok('full 200 + ok', full.status === 200 && full.body.ok === true)
ok('universe reported', Number.isFinite(full.body.universe) && full.body.universe >= 8, `universe=${full.body.universe}`)
ok('nothing left behind (scanned === universe)', full.body.scanned === full.body.universe, `scanned=${full.body.scanned} universe=${full.body.universe}`)
ok('no top cut: all qualifying reads returned', full.body.signals?.length === full.body.qualifying, `signals=${full.body.signals?.length} qualifying=${full.body.qualifying}`)
ok('OTC assets scanned (>= 2)', (full.body.otcScanned ?? 0) >= 2, `otcScanned=${full.body.otcScanned}`)
ok('otcQualifying matches the otc cards actually returned', (full.body.otcQualifying ?? -1) === (full.body.signals?.filter((s) => s.otc).length ?? -1), `otcQualifying=${full.body.otcQualifying} otcCards=${full.body.signals?.filter((s) => s.otc).length}`)
ok('otc chips on otc signals', full.body.signals?.every((s) => typeof s.otc === 'boolean'))

// ---------- cfd kind: level sanity ----------
const c1 = await get('/signals?kind=cfd&top=5')
ok('cfd 200 + ok', c1.status === 200 && c1.body.ok === true && c1.body.kind === 'cfd')
const cs = c1.body.signals?.[0] ?? null
if (cs) {
  ok('cfd levels present', !!cs.cfd && Number.isFinite(cs.cfd.entry) && Number.isFinite(cs.cfd.sl) && Number.isFinite(cs.cfd.tp))
  if (cs.cfd) {
    const { entry, sl, tp, rr } = cs.cfd
    const sidesOk = cs.direction === 'call' ? sl < entry && tp > entry : sl > entry && tp < entry
    ok('SL/TP on the correct sides', sidesOk, `dir=${cs.direction} sl=${sl} entry=${entry} tp=${tp}`)
    ok('RR >= 1.5', rr >= 1.5, `rr=${rr}`)
  }
}

// ---------- cache + strict tf + top clamp ----------
const [a, b] = await Promise.all([get('/signals?kind=option&top=5'), get('/signals?kind=option&top=5')])
ok('12s cache serves the same scan', a.body.ts === b.body.ts)
const bad = await get('/signals?kind=option&tf=bogus')
ok('garbage tf rejected', bad.status === 400 && bad.body.ok === false)
const clamp = await get('/signals?kind=option&top=99')
ok('top=99 still a clean cut', clamp.body.signals?.length <= 99)

console.log(`\n${pass} checks passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
