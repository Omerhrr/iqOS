// E2E: IQ Day P/L + Total P/L must be PER-MODE (paper / IQ practice / IQ real),
// measured against broker-balance snapshots - not the single paper ledger.
// Drives the REAL kernel HTTP surface against a fake sidecar whose PRACTICE and
// REAL balances differ. Run: node scripts/live_pl_e2e.mjs  (kernel on :3030)
import http from 'node:http'

const KERNEL = 'http://127.0.0.1:3030'
const PORT = 8799
const BAL = { PRACTICE: 10500, REAL: 9800 } // distinct accounts, distinct P/L
let mode = 'PRACTICE'

const j = (o) => JSON.stringify(o)
async function kget(path) {
  const r = await fetch(`${KERNEL}${path}`)
  return r.json()
}
async function kpost(path, body) {
  const r = await fetch(`${KERNEL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: j(body ?? {}),
  })
  return r.json()
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// ---------------- fake sidecar (per-mode balances) ----------------
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const reply = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(j(obj))
  }
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    const p = url.pathname
    if (p === '/health') return reply(200, { ok: true, connected: true, assets_mapped: 2 })
    if (p === '/connect') return reply(200, { ok: true })
    if (p === '/balance_mode') {
      if (body.mode === 'REAL' || body.mode === 'PRACTICE') mode = body.mode
      return reply(200, { ok: true })
    }
    if (p === '/balance') return reply(200, { ok: true, amount: BAL[mode], mode })
    if (p === '/assets')
      return reply(200, {
        ok: true,
        assets: [
          { ticker: 'EURUSD', category: 'forex', is_open: true, payout: 0.85 },
          { ticker: 'GBPUSD', category: 'forex', is_open: true, payout: 0.84 },
        ],
      })
    if (p === '/price') return reply(200, { ok: true, asset: url.searchParams.get('asset') ?? 'EURUSD', price: 1.1, src: 'stream' })
    if (p === '/prices') return reply(200, { ok: true, prices: {} })
    if (p === '/candles') {
      const now = Math.floor(Date.now() / 1000)
      const last = now - (now % 60)
      const out = []
      for (let i = 5; i >= 0; i--) {
        const t = last - (i + 1) * 60
        out.push({ from: t, to: t + 60, open: 1.1, close: 1.1, min: 1.099, max: 1.101, volume: 0 })
      }
      return reply(200, { ok: true, candles: out })
    }
    if (p === '/trade') return reply(200, { ok: false, error: 'no trades in this test' })
    if (p === '/positions') return reply(200, { ok: true, positions: [] })
    return reply(404, { ok: false, error: `no route ${p}` })
  })
})

// ---------------- assertions ----------------
let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`)
  if (!cond) failures++
}

async function waitForKernel() {
  for (let i = 0; i < 30; i++) {
    try {
      const h = await kget('/health')
      if (h.ok) return true
    } catch {}
    await sleep(1000)
  }
  return false
}

async function main() {
  await new Promise((res) => fake.listen(PORT, '127.0.0.1', res))
  console.log(`[fake sidecar] :${PORT} PRACTICE=$${BAL.PRACTICE} REAL=$${BAL.REAL}`)

  if (!(await waitForKernel())) {
    console.log('FATAL - kernel not reachable')
    process.exit(1)
  }

  // 1. connect IQ session + switch source (PRACTICE first)
  const conn = await kpost('/live/connect', { url: `http://127.0.0.1:${PORT}`, email: 'e@x.io', password: 'p', balanceMode: 'PRACTICE' })
  check('live connect ok', conn.ok === true, conn.error ?? '')
  const sw = await kpost('/account/source', { source: 'iq', balanceMode: 'PRACTICE' })
  check('switch source -> iq/practice', sw.ok === true, sw.error ?? '')

  // 2. first observation: P/L measured from snapshot => both zero, own start
  let a = (await kget('/account')).account
  check('practice: source iq', a.source === 'iq', a.source)
  check('practice: liveBalance = broker', a.liveBalance === 10500, String(a.liveBalance))
  check('practice: startBalance = own snapshot', a.startBalance === 10500, String(a.startBalance))
  check('practice: fresh dayPnl 0', a.dayPnl === 0, String(a.dayPnl))
  check('practice: fresh totalPnl 0', a.totalPnl === 0, String(a.totalPnl))

  // 3. broker books a win: +120 -> both P/L move with the sync, paper numbers gone
  BAL.PRACTICE = 10620
  await sleep(13000) // balance sync cadence 10s
  a = (await kget('/account')).account
  check('practice: dayPnl follows broker', a.dayPnl === 120, String(a.dayPnl))
  check('practice: totalPnl follows broker', a.totalPnl === 120, String(a.totalPnl))

  // 4. REAL account: completely independent baseline (THE COMPLAINT)
  const sw2 = await kpost('/account/source', { source: 'iq', balanceMode: 'REAL' })
  check('switch source -> iq/real', sw2.ok === true, sw2.error ?? '')
  a = (await kget('/account')).account
  check('real: balanceMode REAL', a.balanceMode === 'REAL', a.balanceMode)
  check('real: liveBalance = real broker', a.liveBalance === 9800, String(a.liveBalance))
  check('real: startBalance = own snapshot', a.startBalance === 9800, String(a.startBalance))
  check('real: fresh dayPnl 0 (not practice 120)', a.dayPnl === 0, String(a.dayPnl))
  check('real: fresh totalPnl 0 (not practice 120)', a.totalPnl === 0, String(a.totalPnl))

  // 5. REAL books a loss: -70 -> its own day/total, practice row untouched
  BAL.REAL = 9730
  await sleep(13000)
  a = (await kget('/account')).account
  check('real: dayPnl follows broker', a.dayPnl === -70, String(a.dayPnl))
  check('real: totalPnl follows broker', a.totalPnl === -70, String(a.totalPnl))

  // 6. back to PRACTICE: its P/L SURVIVED the real interlude (persisted baselines)
  const sw3 = await kpost('/account/source', { source: 'iq', balanceMode: 'PRACTICE' })
  check('switch back -> iq/practice', sw3.ok === true, sw3.error ?? '')
  await sleep(1200)
  a = (await kget('/account')).account
  check('practice persisted: dayPnl still 120', a.dayPnl === 120, String(a.dayPnl))
  check('practice persisted: totalPnl still 120', a.totalPnl === 120, String(a.totalPnl))

  // 7. paper: back to the paper ledger (source + numbers decoupled)
  const sw4 = await kpost('/account/source', { source: 'paper' })
  check('switch back -> paper', sw4.ok === true, sw4.error ?? '')
  a = (await kget('/account')).account
  check('paper: source paper', a.source === 'paper', a.source)
  check('paper: dayPnl is a ledger number', typeof a.dayPnl === 'number', String(a.dayPnl))

  await kpost('/live/disconnect')
  fake.close()
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
