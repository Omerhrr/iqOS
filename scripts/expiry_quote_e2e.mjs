#!/usr/bin/env node
// iqOS E2E - broker-authoritative settlement for LIVE options (T55 flow).
//
// Spins a FAKE iqair sidecar on :8799 that scripts:
//   - decoy FEED prices (what any local price-guess settle would use), and
//   - the authoritative /order_result close record (what IQ actually settles
//     against: pnl sign decides, close_quote/close_time decorate history).
// The verdicts deliberately FLIP between the two sources, so a pass proves
// the kernel settled from the broker's own order result - not from its tick,
// not from an expiry candle, not from any local price ladder:
//
//   EURUSD call: feed decoy 1.09900 (would LOSE)  | broker pnl +8.50 (WINS)
//   GBPUSD call: feed decoy 1.27200 (would WIN)   | broker pnl -10   (LOSES)
//
// Refresh note (stale vs T55): the old flow scripted "expiry quote candles"
// and expected the kernel to settle from them; live options now settle ONLY
// via sidecar /order_result - the fake carries NO scripted expiry candles at
// all anymore, so a regression to any price-based guess must fail here.
//
// Also verifies: broker `expired` echo -> settlesAt via the /positions
// reconcile (real expiration_time + openPrice -> entry), /positions
// reconcile, balance true-up, paper ledger untouched. Restores the kernel
// to PAPER at the end.

import http from 'node:http'

const KERNEL = 'http://127.0.0.1:3030'
const FAKE_PORT = 8799
const EXPIRY_SEC = 12 // scripted broker expiry (fast E2E; leaves the +2.5s reconcile room to land)

const FEED = { EURUSD: 1.099, GBPUSD: 1.272 } // decoy stream/feed prices
const OPEN = { EURUSD: 1.1, GBPUSD: 1.27 } // broker openPrice (the quote IQ settles against)
const QUOTE = { EURUSD: 1.105, GBPUSD: 1.265 } // broker close_quote AT expiry

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

const brokerWon = (o) => (o.direction === 'call' ? QUOTE[o.asset] > OPEN[o.asset] : QUOTE[o.asset] < OPEN[o.asset])

function brokerBalance() {
  // lazily book expired orders the way IQ would: win credits stake+payout
  const now = Math.floor(Date.now() / 1000)
  for (const o of orders) {
    if (booked.has(o.id) || o.expired > now) continue
    booked.add(o.id)
    if (brokerWon(o)) balance += o.amount * (1 + o.payout)
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
      // DECOY FEED ONLY - no scripted expiry candles anywhere in this fake.
      // The kernel must never settle a live option from candles; if it does,
      // it reads the decoy stream and every verdict flips -> E2E fails.
      const asset = url.searchParams.get('asset') ?? 'EURUSD'
      return reply(200, { ok: true, candles: feedCandles(asset) })
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
    if (p === '/order_result') {
      // THE settle path (T55): the kernel asks whether IQ has closed this
      // order and what it paid. Before expiry IQ genuinely says "still
      // open" (found:false); after expiry the close record carries the
      // broker's own pnl (sign decides won/lost), close_quote + close_time.
      const want = Number(body.order_id)
      const o = orders.find((x) => x.id === want || String(x.id) === String(body.order_id))
      if (!o) return reply(200, { ok: true, found: false })
      const now = Math.floor(Date.now() / 1000)
      if (o.expired > now) return reply(200, { ok: true, found: false }) // IQ: not closed yet
      const won = brokerWon(o)
      return reply(200, {
        ok: true,
        found: true,
        status: 'closed',
        pnl: won ? o.amount * o.payout : -o.amount, // NET, exactly what IQ credits/debits
        close_price: QUOTE[o.asset],
        close_time: o.expired,
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

  const t0 = Math.floor(Date.now() / 1000)
  const t1 = await kernel('/trade', 'POST', { asset: 'EURUSD', side: 'call', kind: 'binary', amount: 10, expiryBars: 1, tf: '1m' })
  check('EURUSD live binary placed', t1?.ok === true && t1.position?.mode === 'live', t1?.error ?? `order ${t1?.position?.liveOrderId}`)
  const t2 = await kernel('/trade', 'POST', { asset: 'GBPUSD', side: 'call', kind: 'binary', amount: 10, expiryBars: 1, tf: '1m' })
  check('GBPUSD live binary placed', t2?.ok === true, t2?.error ?? '')

  // The reconcile sweep (fires ~2.5s after placement) true-ups BOTH settlesAt
  // (broker expiration_time echo, t0+12) AND entry (broker openPrice - the
  // kernel's own feed shows a different price here, so entry==openPrice can
  // ONLY come from the reconcile). Poll - don't race the 2.5s timer.
  let reconciled = false
  let e1 = null
  for (let i = 0; i < 12; i++) {
    await sleep(1000)
    const pos = await kernel('/positions?limit=20')
    const p1 = (pos.positions ?? []).find((x) => x.id === t1.position.id)
    const p2 = (pos.positions ?? []).find((x) => x.id === t2.position.id)
    if (
      p1 && p2 &&
      Math.abs(p1.settlesAt - (t0 + EXPIRY_SEC)) <= 3 && Math.abs(p2.settlesAt - (t0 + EXPIRY_SEC)) <= 3 &&
      Math.abs(p1.entryPrice - OPEN.EURUSD) < 1e-6 && Math.abs(p2.entryPrice - OPEN.GBPUSD) < 1e-6
    ) {
      reconciled = true
      e1 = p1.settlesAt
      break
    }
  }
  check('reconcile: settlesAt = broker expired echo (not local now+60)', reconciled, `settlesAt=${e1}, broker echo=${t0 + EXPIRY_SEC}`)
  check('reconcile: entry = broker openPrice (kernel feed price differs)', reconciled, 'entry patched from /positions openPrice')

  // wait past expiry + settlement sweep + /order_result + balance sync
  // (e1 is unix SECONDS - Date.now() is ms; sleep until expiry + 6s margin)
  const waitMs = Math.max(0, e1 !== null ? e1 * 1000 + 6500 - Date.now() : 20000)
  console.log(`[e2e] waiting ${(waitMs / 1000).toFixed(0)}s for expiry + broker settlement...`)
  await sleep(waitMs)

  const pos = await kernel('/positions?limit=20')
  const p1 = (pos.positions ?? []).find((x) => x.id === t1.position.id)
  const p2 = (pos.positions ?? []).find((x) => x.id === t2.position.id)

  check('EURUSD settled', p1 && p1.status !== 'open', p1?.status ?? 'missing')
  check('EURUSD entry reconciled to broker openPrice', p1 && Math.abs(p1.entryPrice - OPEN.EURUSD) < 1e-9, `entry=${p1?.entryPrice}`)
  check('EURUSD exit = broker close_quote', p1 && Math.abs(p1.exitPrice - QUOTE.EURUSD) < 1e-9, `exit=${p1?.exitPrice}`)
  check('EURUSD WON via broker record (feed decoy would have LOST)', p1?.status === 'won', `status=${p1?.status}`)
  check('EURUSD pnl = stake*payout (broker-reported)', p1 && Math.abs(p1.pnl - 10 * p1.payout) < 0.01, `pnl=${p1?.pnl}, payout=${p1?.payout}`)
  check('EURUSD settled within 3s of expiry', p1 && p1.tsClose - p1.settlesAt <= 3, `lag=${p1 ? p1.tsClose - p1.settlesAt : '?'}s`)

  check('GBPUSD settled', p2 && p2.status !== 'open', p2?.status ?? 'missing')
  check('GBPUSD entry reconciled to broker openPrice', p2 && Math.abs(p2.entryPrice - OPEN.GBPUSD) < 1e-9, `entry=${p2?.entryPrice}`)
  check('GBPUSD exit = broker close_quote', p2 && Math.abs(p2.exitPrice - QUOTE.GBPUSD) < 1e-9, `exit=${p2?.exitPrice}`)
  check('GBPUSD LOST via broker record (feed decoy would have WON)', p2?.status === 'lost', `status=${p2?.status}`)
  check('GBPUSD pnl = -stake', p2 && Math.abs(p2.pnl + 10) < 0.01, `pnl=${p2?.pnl}`)

  const alerts = await kernel('/alerts')
  const msgs = (alerts.alerts ?? []).map((a) => a.message).join(' | ')
  check('settlement alerts name the broker order-result source', /iq order result/.test(msgs), '')

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
