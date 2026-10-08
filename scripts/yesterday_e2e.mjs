#!/usr/bin/env bun
// Same-time-yesterday scanner e2e.
// Verifies /yesterday against the live kernel: response shape, the T-24h
// anchor (window starts at the bar forming exactly 24h ago), row sanity
// (move/range/excursions/coverage/provenance), direction classification,
// sorting by |move|, the window param (clamp + quantization), tf respect
// (per-tf caches, echo, no cross-tf leak), the archive-depth gate (5s/15s
// refused with a clear 400) and the strict tf gate. Read-only.
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
ok('sorted by |move| desc', rows.every((x, i, arr) => i === 0 || Math.abs(arr[i - 1].movePct) >= Math.abs(x.movePct)))
ok('OTC rows present (OTC universe warmed)', rows.some((r) => r.otc), `otcRows=${rows.filter((r) => r.otc).length}`)
ok('warmed majors covered', ['EURUSD', 'BTCUSD', 'EURUSD-OTC'].every((a) => rows.some((r) => r.asset === a)), `rows=${rows.length}`)

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
