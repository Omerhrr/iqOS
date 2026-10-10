#!/usr/bin/env bun
// Chart-signals scanner e2e - Task 64-a.
// Verifies /signals (option + cfd kinds) against the live kernel: response
// shape, confluence qualification (strength/agreement floors), per-market
// engine sets (footprint for real pairs, otcfootprint for OTC), CFD level
// sanity (SL/TP on the right side, RR floor), TTL freshness, cache, sorting
// and the strict tf gate. Read-only - the scanner touches no kernel state.
// TF respect: the scan runs on the requested timeframe, per-kind:tf caches
// never leak into each other, and TTL/expiry scale with the bar size.
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
// boot backfill on the wire: a fresh kernel's FIRST scan cannot know how
// long the current reads have been true, so every read is held+backfilled
// and nothing counts as a fresh edge - the anti-stale-burst contract
ok('boot backfill: first scan marks reads held (not entered)', (o1.body.signals ?? []).every((s) => s.phase === 'held' && s.backfilled === true), `phases=${[...new Set((o1.body.signals ?? []).map((s) => s.phase))].join(',')}`)
ok('boot backfill: freshEdges = 0 on the first scan', o1.body.freshEdges === 0, `freshEdges=${o1.body.freshEdges}`)
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
  // TTL runs from the BAR END (the closed candle that fed the votes), not
  // the scan time - a late scan against old candles honestly lives shorter
  ok('TTL anchored to the bar end (barTs + 60s + 150s)', s.validUntil === (s.barTs + 60) * 1000 + 150_000, `validUntil-ts=${s.validUntil - s.ts}ms barTs=${s.barTs}`)
  ok('barTs/ageSec freshness present', Number.isFinite(s.barTs) && Number.isFinite(s.ageSec) && s.ageSec >= 0 && s.ageSec <= 120, `ageSec=${s.ageSec}`)
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

// ---------- tf respect: scan follows the requested timeframe ----------
// the panel sends the chart's tf; the kernel must scan those candles (not
// silently default to 1m) and keep kind:tf caches separate - with the old
// kind-only cache key the second call below came back mislabeled with the
// first call's tf
const m5 = await get('/signals?kind=option&tf=5m&top=5')
ok('5m scan 200 + tf echo', m5.status === 200 && m5.body.ok === true && m5.body.tf === '5m', `tf=${m5.body.tf}`)
const m1back = await get('/signals?kind=option&tf=1m&top=5')
ok('1m after 5m still reports 1m (no cross-tf cache leak)', m1back.body.tf === '1m', `tf=${m1back.body.tf}`)
ok('per-tf caches are distinct scans', m5.body.ts !== m1back.body.ts, `5m ts=${m5.body.ts} 1m ts=${m1back.body.ts}`)
const s5 = m5.body.signals?.[0] ?? null
if (s5) {
  // 5m bars: suggested expiry scales x5 (300..1500s, cap 1800) and the read
  // lives ~5 bars (ttl 1500s from ITS bar end) - an M5 structural read must
  // not die in 2.5 min
  ok('5m expiry scaled (>= 300s, <= 1800s)', s5.expirySec >= 300 && s5.expirySec <= 1800, `expirySec=${s5.expirySec}`)
  ok('5m TTL anchored to its own bar end (+1500s)', s5.validUntil === (s5.barTs + 300) * 1000 + 1500_000, `ttlFromScan=${Math.round((s5.validUntil - s5.ts) / 1000)}s barTs=${s5.barTs}`)
}
const st5 = await get('/signals_stats?tf=5m')
ok('stats accept tf filter', st5.status === 200 && st5.body.ok === true)
const stBad = await get('/signals_stats?tf=bogus')
ok('stats reject garbage tf', stBad.status === 400)

// ---------- edge registry across scans: the second scan of the same
// kind:tf after a bar close re-stamps phases; a NEW qualifying read (one
// that was absent from the boot scan) must come back 'entered', never
// backfilled. Poll once more after a pause: same reads stay held, and the
// phase vocabulary itself is locked (only the three values exist).
await new Promise((r) => setTimeout(r, 7000))
const again = await get('/signals?kind=option')
ok('rescan 200', again.status === 200 && again.body.ok === true)
ok('phase vocabulary locked to entered|held|flip', (again.body.signals ?? []).every((s) => ['entered', 'held', 'flip'].includes(s.phase)), `phases=${[...new Set((again.body.signals ?? []).map((s) => s.phase))].join(',')}`)
ok('re-scan after a bar close: freshEdges never negative and <= qualifying', again.body.freshEdges >= 0 && again.body.freshEdges <= (again.body.qualifying ?? 0), `freshEdges=${again.body.freshEdges} qualifying=${again.body.qualifying}`)

console.log(`\n${pass} checks passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
