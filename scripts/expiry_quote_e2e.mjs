#!/usr/bin/env node
// iqOS E2E - real-world expiry-quote settlement for LIVE options.
//
// Spins a FAKE iqair sidecar on :8799 that scripts:
//   - decoy feed prices (what the OLD settlement path would have used), and
//   - authoritative EXPIRY QUOTE candles (what IQ actually settles against).
// The verdicts deliberately FLIP between the two sources, so a pass proves
// the kernel settled from the sidecar's expiry quotes, not its own tick.
//
//   EURUSD call: feed decoy 1.09900 (would LOSE)  | expiry quote 1.10500 (WINS)
//   GBPUSD call: feed decoy 1.27200 (would WIN)   | expiry quote 1.26500 (LOSES)
//
// Also verifies: broker `expired` echo -> settlesAt, /positions reconcile
// (real expiration_time + openPrice -> entry), balance true-up, paper ledger
// untouched. Restores the kernel to PAPER at the end.

import http from 'node:http'

const KERNEL = 'http://127.0.0.1:3030'
const FAKE_PORT = 8799
const EXPIRY_SEC = 6 // scripted broker expiry (fast E2E)

const FEED = { EURUSD: 1.099, GBPUSD: 1.272 } // decoy stream/feed prices
const OPEN = { EURUSD: 1.1, GBPUSD: 1.27 } // broker openPrice (the quote IQ settles against)
const QUOTE = { EURUSD: 1.105, GBPUSD: 1.265 } // broker quote AT expiry

const j = (v) => JSON.stringify(v)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function kernel(path, method = 'GET', body) {
  const res = await fetch(`${KERNEL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : j(body),
    signal: AbortSignal.timeout(40_000),
  })
  return res.json()
}

// ---------------- fake sidecar ----------------

const orders = []
let nextId = Math.floor(Date.now() / 10) // unique across E2E runs (kernel persists lv-<id>)
let balance = 10000
const booked = new Set()

function brokerBalance() {
  // lazily book expired orders the way IQ would: win credits stake+payout
  const now = Math.floor(Date.now() / 1000)
  for (const o of orders) {
    if (booked.has(o.id) || o.expired > now) continue
    booked.add(o.id)
    const won = o.direction === 'call' ? QUOTE[o.asset] > OPEN[o.asset] : QUOTE[o.asset] < OPEN[o.asset]
    if (won) balance += o.amount * (1 + o.payout)
  }
  return balance
}

function feedCandles(asset, size = 240) {
  const now = Math.floor(Date.now() / 1000)
  const last = now - (now % 60)
  const price = FEED[asset] ?? 1.1
  const out = []
  for (let i = size - 1; i >= 0; i--) {
    const t = last - i * 60
    out.push({ from: t, to: t + 60, open: price, close: price, min: price, max: price, volume: 0 })
  }
  return out
}

function expiryCandles(asset, tf, end) {
  // kernel asks end = expiresAt + tf; the candle whose window ends exactly at
  // the expiry second carries the broker quote, the rest carry the feed
  const order = orders.find((o) => o.asset === asset && Math.abs(o.expired + tf - end) <= 3 && !booked.has(o.id))
  if (!order) return null
  const now = Math.floor(Date.now() / 1000)
  if (order.expired > now) return null // expiry candle not frozen yet (like real IQ)
  const out = []
  for (let i = 5; i >= 0; i--) {
    const t = end - (i + 1) * tf
    const isExpiry = t + tf === order.expired
    out.push({
      from: t,
      to: t + tf,
      open: isExpiry ? OPEN[asset] : FEED[asset] ?? 1.1,
      close: isExpiry ? QUOTE[asset] : FEED[asset] ?? 1.1,
      min: (isExpiry ? QUOTE[asset] : FEED[asset] ?? 1.1) * 0.999,
      max: (isExpiry ? QUOTE[asset] : FEED[asset] ?? 1.1) * 1.001,
      volume: 0,
    })
  }
  return out
}

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
    if (p === '/balance_mode') return reply(200, { ok: true })
    if (p === '/balance') return reply(200, { ok: true, amount: brokerBalance(), mode: 'PRACTICE' })
    if (p === '/assets')
      return reply(200, {
        ok: true,
        assets: [
          { ticker: 'EURUSD', category: 'forex', is_open: true, payout: 0.85 },
          { ticker: 'GBPUSD', category: 'forex', is_open: true, payout: 0.84 },
        ],
      })
    if (p === '/price') {
      const a = url.searchParams.get('asset') ?? 'EURUSD'
      if (!(a in FEED)) return reply(200, { ok: false })
      return reply(200, { ok: true, asset: a, price: FEED[a], src: 'stream' })
    }
    if (p === '/prices') return reply(200, { ok: true, prices: {} })
    if (p === '/candles') {
      const asset = url.searchParams.get('asset') ?? 'EURUSD'
      const tf = Number(url.searchParams.get('tf') ?? 60)
      const end = Number(url.searchParams.get('end') ?? 0)
      const candles = end > 0 ? expiryCandles(asset, tf, end) : feedCandles(asset)
      return reply(200, { ok: true, candles: candles ?? [] })
    }
    if (p === '/trade') {
      const asset = String(body.asset ?? '')
      if (!(asset in FEED)) return reply(200, { ok: false, error: `unknown asset ${asset}` })
      const now = Math.floor(Date.now() / 1000)
      const order = {
        id: nextId++,
        asset,
        amount: Number(body.amount ?? 10),
        direction: String(body.direction ?? 'call'),
        expired: now + EXPIRY_SEC,
        openPrice: OPEN[asset],
        payout: asset === 'EURUSD' ? 0.85 : 0.84,
      }
      orders.push(order)
      balance -= order.amount
      console.log(`[fake] trade ${order.id} ${asset} ${order.direction} $${order.amount} expires ${order.expired} (in ${EXPIRY_SEC}s)`)
      return reply(200, { ok: true, order_id: order.id, mode: body.mode ?? 'binary-option', asset, expired: order.expired })
    }
    if (p === '/positions') {
      const now = Math.floor(Date.now() / 1000)
      const open = orders.filter((o) => !booked.has(o.id) && o.expired > now)
      return reply(200, {
        ok: true,
        positions: open.map((o) => ({
          id: o.id,
          instrument_type: 'binary-option',
          instrument_symbol: o.asset,
          expiration_time: o.expired,
          openPrice: o.openPrice,
          amount: o.amount,
          direction: o.direction,
        })),
      })
    }
    return reply(404, { ok: false, error: `no route ${p}` })
  })
})

// ---------------- assertions ----------------

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`)
  if (!cond) failures++
}

await new Promise((r) => fake.listen(FAKE_PORT, r))
console.log(`[fake] sidecar on :${FAKE_PORT}`)

try {
  const h = await kernel('/health')
  check('kernel alive', h?.ok === true)

  const before = await kernel('/account')
  const paperBefore = before.account.balance

  check('connect fake sidecar', (await kernel('/live/connect', 'POST', { url: `http://127.0.0.1:${FAKE_PORT}`, email: 'e2e@test', password: 'x', balanceMode: 'PRACTICE' })).ok === true)
  const src = await kernel('/account/source', 'POST', { source: 'iq' })
  check('switch source to IQ', src?.ok === true && src.source === 'iq', `feed=${src.feedMode}`)

  const t1 = await kernel('/trade', 'POST', { asset: 'EURUSD', side: 'call', kind: 'binary', amount: 10, expiryBars: 1, tf: '1m' })
  check('EURUSD live binary placed', t1?.ok === true && t1.position?.mode === 'live', t1?.error ?? `order ${t1?.position?.liveOrderId}`)
  const t2 = await kernel('/trade', 'POST', { asset: 'GBPUSD', side: 'call', kind: 'binary', amount: 10, expiryBars: 1, tf: '1m' })
  check('GBPUSD live binary placed', t2?.ok === true, t2?.error ?? '')

  const e1 = t1.position?.settlesAt
  const nowS = Math.floor(Date.now() / 1000)
  check('settlesAt = broker expired echo (not now+60)', Math.abs(e1 - (nowS + EXPIRY_SEC)) <= 3, `settlesAt=${e1}, now+6=${nowS + EXPIRY_SEC}`)

  // wait past expiry + settlement sweep + reconcile + balance sync
  const waitMs = (e1 - nowS) * 1000 + 9000
  if (!Number.isFinite(waitMs) || waitMs <= 0) throw new Error('bad settlesAt - order placement failed')
  console.log(`[e2e] waiting ${(waitMs / 1000).toFixed(0)}s for expiry + settlement...`)
  await sleep(waitMs)

  const pos = await kernel('/positions?limit=20')
  const p1 = (pos.positions ?? []).find((x) => x.id === t1.position.id)
  const p2 = (pos.positions ?? []).find((x) => x.id === t2.position.id)

  check('EURUSD settled', p1 && p1.status !== 'open', p1?.status ?? 'missing')
  check('EURUSD entry reconciled to broker openPrice', p1 && Math.abs(p1.entryPrice - OPEN.EURUSD) < 1e-9, `entry=${p1?.entryPrice}`)
  check('EURUSD exit = expiry quote', p1 && Math.abs(p1.exitPrice - QUOTE.EURUSD) < 1e-9, `exit=${p1?.exitPrice}`)
  check('EURUSD WON via expiry quote (feed decoy would have LOST)', p1?.status === 'won', `status=${p1?.status}`)
  check('EURUSD pnl = stake*payout', p1 && Math.abs(p1.pnl - 10 * p1.payout) < 0.01, `pnl=${p1?.pnl}, payout=${p1?.payout}`)
  check('EURUSD settled within 3s of expiry', p1 && p1.tsClose - p1.settlesAt <= 3, `lag=${p1 ? p1.tsClose - p1.settlesAt : '?'}s`)

  check('GBPUSD settled', p2 && p2.status !== 'open', p2?.status ?? 'missing')
  check('GBPUSD entry reconciled to broker openPrice', p2 && Math.abs(p2.entryPrice - OPEN.GBPUSD) < 1e-9, `entry=${p2?.entryPrice}`)
  check('GBPUSD exit = expiry quote', p2 && Math.abs(p2.exitPrice - QUOTE.GBPUSD) < 1e-9, `exit=${p2?.exitPrice}`)
  check('GBPUSD LOST via expiry quote (feed decoy would have WON)', p2?.status === 'lost', `status=${p2?.status}`)
  check('GBPUSD pnl = -stake', p2 && Math.abs(p2.pnl + 10) < 0.01, `pnl=${p2?.pnl}`)

  const alerts = await kernel('/alerts')
  const msgs = (alerts.alerts ?? []).map((a) => a.message).join(' | ')
  check('settlement alerts name the expiry-quote source', /iq expiry 1s quote/.test(msgs), '')

  // balance true-up: fake books 10000 - 20 + 18.5 (EURUSD win at 0.85)
  let liveBal = null
  for (let i = 0; i < 12; i++) {
    const acct = await kernel('/account')
    liveBal = acct.account.liveBalance
    if (Math.abs(liveBal - 9998.5) < 0.01) break
    await sleep(2000)
  }
  check('liveBalance true-up from broker ledger', liveBal !== null && Math.abs(liveBal - 9998.5) < 0.01, `liveBalance=${liveBal}, expected 9998.5`)
  const after = await kernel('/account')
  check('paper ledger untouched by live settlements', Math.abs(after.account.balance - paperBefore) < 0.005, `paper ${paperBefore} -> ${after.account.balance}`)
} catch (err) {
  failures++
  console.log(`FAIL - e2e crashed: ${err.message}`)
} finally {
  // restore paper + drop the fake session
  try {
    await kernel('/account/source', 'POST', { source: 'paper' })
    await kernel('/live/disconnect', 'POST', {})
  } catch {}
  fake.close()
}

console.log(failures === 0 ? '\nEXPIRY-QUOTE E2E: ALL GREEN' : `\nEXPIRY-QUOTE E2E: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
