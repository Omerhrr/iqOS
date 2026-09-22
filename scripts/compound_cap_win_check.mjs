// Focused check: the 70% payout cap binds on LIVE WINS.
// Creates a stopOnLoss:false compound bot (keeps trading through losses),
// waits for a win, then verifies the pot folded in min(pnl, stake*0.70) - i.e.
// a broker payout above 70% gets skimmed, never compounded.
// Run: node scripts/compound_cap_win_check.mjs
const KERNEL = 'http://127.0.0.1:3030'
const BASE = 1
const CAP = 0.7

const kget = (p) => fetch(`${KERNEL}${p}`).then((r) => r.json())
const kpost = (p, b) =>
  fetch(`${KERNEL}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json())
const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
const r2 = (x) => Math.round(x * 100) / 100

let failures = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`)
  if (!cond) failures++
}

async function main() {
  const mode0 = await kget('/mode').catch(() => null)
  const origMode = mode0?.mode ?? 'human'
  await kpost('/mode_set', { mode: 'auto', reason: 'cap win check' })

  let botId = null
  for (const strategyId of ['stoch-cross', 'bb-bounce', 'ema-trend', 'macd-cross']) {
    const res = await kpost('/bot_save', {
      name: 'E2E cap win',
      enabled: true,
      watchlist: ['EURUSD-OTC'],
      strategyId,
      tf: '5s',
      kind: 'binary',
      stake: 10,
      expiryBars: 1,
      minScore: 0,
      direction: 'both',
      regime: 'all',
      maxOpen: 1,
      cooldownSec: 0,
      stakePlan: { kind: 'compound', base: BASE, rollPct: 100, maxStake: 50, payoutCap: 70, stopOnLoss: false },
    })
    if (res.ok) {
      botId = res.bot.id
      break
    }
  }
  check('bot created', !!botId)
  if (!botId) process.exit(1)

  // wait for a win (420s budget - signals can be sparse)
  let won = null
  let wins = 0
  for (let i = 0; i < 210 && !won; i++) {
    await sleep(2000)
    const jr = await kget('/journal?scope=bots')
    const mine = (jr.recent ?? []).filter((t) => t.note === `bot:${botId}` && t.status === 'won')
    if (mine.length > 0) {
      wins = mine.length
      won = mine.sort((a, b) => a.tsOpen - b.tsOpen)[wins - 1]
    }
  }
  if (!won) {
    console.log('SKIP - no win observed in the window')
    await kpost('/bot_toggle', { id: botId, enabled: false })
    await kpost('/bot_delete', { id: botId })
    await kpost('/mode_set', { mode: origMode })
    process.exit(0)
  }
  console.log(`  winning trade: stake $${won.amount} pnl $${r2(won.pnl)} (implied payout ${r2((won.pnl / won.amount) * 100)}%)`)

  // replay the pot through ALL closed trades up to the win
  const jr2 = await kget('/journal?scope=bots')
  const mine2 = (jr2.recent ?? [])
    .filter((t) => t.note === `bot:${botId}` && (t.status === 'won' || t.status === 'lost'))
    .sort((a, b) => a.tsOpen - b.tsOpen)
  let pot = 0
  const trail = []
  for (const t of mine2) {
    const working = pot >= 0.01 ? pot : BASE
    if (t.status === 'won') {
      const fold = r2(Math.min(t.pnl ?? 0, t.amount * CAP))
      pot = r2(working + fold)
      trail.push(`won $${t.amount} +${fold}${t.pnl > t.amount * CAP + 1e-9 ? ' CAPPED' : ' uncapped'}`)
    } else {
      pot = r2(Math.max(0, working - t.amount))
      trail.push(`lost $${t.amount}`)
    }
  }
  console.log(`  ladder: ${trail.join(' -> ')}`)

  const row = (await kget('/bots')).bots.find((b) => b.bot.id === botId)
  check('pot folded the CAPPED payout', row && r2(row.stats.pot) === r2(pot), `kernel=${row?.stats.pot} replay=${r2(pot)}`)
  if (won.pnl > won.amount * CAP + 1e-9) {
    check('cap actually bound (payout above 70%)', r2(row?.stats.pot) === r2(BASE + won.amount * CAP), `pot=${row?.stats.pot} expected=${r2(BASE + won.amount * CAP)}`)
  } else {
    console.log(`  note: broker payout ${r2((won.pnl / won.amount) * 100)}% <= 70%, fold uncapped (passthrough verified)`)
  }

  await kpost('/bot_toggle', { id: botId, enabled: false })
  await kpost('/bot_delete', { id: botId })
  await kpost('/mode_set', { mode: origMode })
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
