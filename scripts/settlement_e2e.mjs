// E2E: instant-at-expiry settlement for paper options.
// Places a 60s binary (1m tf) and a 30s turbo (5s tf), then polls positions
// and asserts each settles within ~2.5s of its settlesAt (the old candle-close
// path could lag up to a full candle - 59s on 1m).
const BASE = 'http://localhost:3030'

const get = async (p) => (await fetch(`${BASE}${p}`)).json()
const post = async (p, b) => (await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json()

async function runCase(name, trade) {
  const acct0 = await get('/account')
  const t0 = Math.floor(Date.now() / 1000)
  const r = await post('/trade', trade)
  if (!r.ok) throw new Error(`${name}: place failed: ${r.error}`)
  const pos = r.position
  const late = pos.settlesAt - (t0 + (trade.kind === 'turbo' ? 30 : 60))
  console.log(`[${name}] opened ${pos.id} entry=${pos.entryPrice.toFixed(5)} settlesAt=+${pos.settlesAt - t0}s stake=$${pos.amount}`)

  // poll until settled; hard cap 90s
  let settled = null
  const poll0 = Date.now()
  while (Date.now() - poll0 < 90_000) {
    await new Promise((res) => setTimeout(res, 1000))
    const pl = await get('/positions')
    const me = (pl.positions ?? pl).find?.((p) => p.id === pos.id) ?? (Array.isArray(pl) ? pl.find((p) => p.id === pos.id) : null)
    if (!me) throw new Error(`${name}: position vanished`)
    if (me.status !== 'open') {
      settled = me
      break
    }
  }
  if (!settled) throw new Error(`${name}: never settled within 90s`)
  const settleWall = Math.floor(Date.now() / 1000)
  const lagVsExpiry = settleWall - pos.settlesAt // when we OBSERVED it closed (poll granularity 1s)
  const acct1 = await get('/account')
  const delta = acct1.account.balance - acct0.account.balance
  // delta is measured from BEFORE the open: the stake was escrowed at open
  // (-amount) and the settlement credits stake+pnl back -> net win delta is
  // +pnl (not stake+pnl, which would only hold if measured after the open).
  const expectedWin = settled.pnl >= 0 ? settled.pnl : 0
  console.log(`[${name}] settled status=${settled.status} exit=${settled.exitPrice?.toFixed(5)} pnl=${settled.pnl?.toFixed(2)} observed lag vs expiry=~${lagVsExpiry}s (poll 1s)`)
  console.log(`[${name}] balance delta=$${delta.toFixed(2)} (stake $${pos.amount}, payout x${pos.payout})`)
  if (lagVsExpiry > 3) throw new Error(`${name}: settled ${lagVsExpiry}s after expiry - sweep too slow`)
  if (Math.abs(delta) < 0.0001 && settled.pnl !== 0) throw new Error(`${name}: balance did not move despite pnl`)
  if (settled.pnl >= 0 && Math.abs(delta - expectedWin) > 0.01) throw new Error(`${name}: balance mismatch: delta ${delta.toFixed(2)} vs expected ${expectedWin.toFixed(2)}`)
  if (settled.pnl < 0 && delta > 0.0001) throw new Error(`${name}: loss should not credit balance`)
  console.log(`[${name}] PASS\n`)
}

async function main() {
  // binary: 1m tf, 1 bar -> 60s expiry. Old path settled at the NEXT 1m candle
  // close after expiry (up to +59s). New sweep must fire at ~settlesAt.
  await runCase('binary-60s', { asset: 'EURUSD-OTC', tf: '1m', side: Math.random() < 0.5 ? 'call' : 'put', kind: 'binary', amount: 10, expiryBars: 1 })
  // turbo: 5s tf, min 30s settle
  await runCase('turbo-30s', { asset: 'EURUSD-OTC', tf: '5s', side: Math.random() < 0.5 ? 'call' : 'put', kind: 'turbo', amount: 5, expiryBars: 6 })
  console.log('ALL SETTLEMENT CASES PASS')
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
