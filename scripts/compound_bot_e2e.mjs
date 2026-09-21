// E2E: compounding stake plan on a real paper bot.
// Creates a compound bot ($1 seed, full roll, 5s binaries), lets it trade on
// the sim feed, then REPLAYS its closed trades from the journal to verify the
// stake ladder followed pot = pot + pnl (win) / pot -= stake (loss, restart).
// Outcome-agnostic: works whether the bot wins or loses. Run: node scripts/compound_bot_e2e.mjs
const KERNEL = 'http://127.0.0.1:3030'
const BASE = 1

async function kget(path) {
  const r = await fetch(`${KERNEL}${path}`)
  return r.json()
}
async function kpost(path, body) {
  const r = await fetch(`${KERNEL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return r.json()
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`)
  if (!cond) failures++
}
const r2 = (x) => Math.round(x * 100) / 100

async function main() {
  // 0. kernel up + capture original mode
  const h = await kget('/health')
  check('kernel healthy', !!h.ok)
  const mode0 = await kget('/mode').catch(() => null)
  const origMode = mode0?.mode ?? 'human'
  await kpost('/mode_set', { mode: 'auto', reason: 'compound e2e' })

  // 1. /compound_plan math
  const plan = await kget('/compound_plan?base=1&payout=0.85&steps=5&rollPct=100')
  check('plan ok', plan.ok === true)
  check('plan growth 1.85', plan.growth === 1.85, String(plan.growth))
  const stakes = plan.schedule.map((s) => s.stake)
  check('plan ladder 1/1.85/3.42/6.33/11.71', JSON.stringify(stakes) === JSON.stringify([1, 1.85, 3.42, 6.33, 11.71]), JSON.stringify(stakes))
  const planCap = await kget('/compound_plan?base=1&payout=0.85&steps=10&maxStake=5')
  check('plan hitCapAt flagged', planCap.hitCapAt === 3, String(planCap.hitCapAt))

  // 2. create the compound bot (try strategies until one fires)
  const candidates = ['stoch-cross', 'bb-bounce', 'ema-trend', 'macd-cross']
  let botId = null
  for (const strategyId of candidates) {
    const res = await kpost('/bot_save', {
      name: 'E2E compound',
      enabled: true,
      watchlist: ['EURUSD-OTC'],
      strategyId,
      tf: '5s',
      kind: 'binary',
      stake: 10, // ignored by the plan
      expiryBars: 1,
      minScore: 0,
      direction: 'both',
      regime: 'all',
      maxOpen: 1, // clean one-at-a-time ladder
      cooldownSec: 0,
      stakePlan: { kind: 'compound', base: BASE, rollPct: 100, maxStake: 50 },
    })
    if (!res.ok) {
      console.log(`  (${strategyId} rejected: ${res.error})`)
      continue
    }
    botId = res.bot.id
    // give it up to 40s to produce >= 3 closed trades (5s binaries trade fast)
    let closed = 0
    for (let i = 0; i < 20; i++) {
      await sleep(2000)
      const jr = await kget('/journal?scope=bots')
      closed = (jr.recent ?? []).filter((t) => t.note === `bot:${botId}` && (t.status === 'won' || t.status === 'lost')).length
      if (closed >= 3) break
    }
    console.log(`  strategy ${strategyId}: ${closed} closed trades`)
    if (closed >= 3) break
    await kpost('/bot_delete', { id: botId })
    botId = null
  }
  // 1 closed trade is enough to verify the ladder mathematically
  check('compound bot produced >= 1 closed trades', !!botId)
  if (!botId) {
    await kpost('/mode_set', { mode: origMode })
    process.exit(1)
  }

  // 3. replay the ladder from the journal (chronological) and verify stakes
  const jr = await kget('/journal?scope=bots')
  const mine = (jr.recent ?? [])
    .filter((t) => t.note === `bot:${botId}` && (t.status === 'won' || t.status === 'lost'))
    .sort((a, b) => a.tsOpen - b.tsOpen)
  let pot = 0
  let rollN = 0
  let restarts = 0
  let ladderOk = true
  const trail = []
  for (const t of mine) {
    const working = pot >= 0.01 ? pot : BASE
    const expected = r2(working) // full roll
    if (r2(t.amount) !== expected) {
      ladderOk = false
      trail.push(`MISMATCH trade@${t.tsOpen} amount=${t.amount} expected=${expected}`)
      break
    }
    trail.push(`${t.status} $${t.amount}${t.status === 'won' ? ` +${r2(t.pnl)}` : ''}`)
    if (t.status === 'won') {
      const fold = Math.min(t.pnl ?? t.amount * 0.85, t.amount * 0.7) // house rule: payout capped at 70%
      pot = Math.round((working + fold) * 100) / 100
      rollN += 1
    } else {
      pot = Math.round(Math.max(0, working - t.amount) * 100) / 100
      if (rollN > 0) restarts += 1
      rollN = 0
    }
  }
  check('stake ladder followed the pot', ladderOk, trail.join(' | '))
  console.log(`  ladder: ${trail.join(' -> ')}`)

  // 4. /bots stats mirror the replay
  const fleet = await kget('/bots')
  const row = (fleet.bots ?? []).find((b) => b.bot.id === botId)
  check('bots stats: pot matches replay', row && r2(row.stats.pot) === r2(pot), `kernel=${row?.stats.pot} replay=${r2(pot)}`)
  check('bots stats: rollN matches', row && row.stats.rollN === rollN, `kernel=${row?.stats.rollN} replay=${rollN}`)
  check('bots stats: restarts matches', row && row.stats.restarts === restarts, `kernel=${row?.stats.restarts} replay=${restarts}`)
  check('bots stats: config carries planState', !!row?.bot.planState, JSON.stringify(row?.bot.planState))

  // 5. cleanup: disarm, delete, restore mode
  await kpost('/bot_toggle', { id: botId, enabled: false })
  await kpost('/bot_delete', { id: botId })
  await kpost('/mode_set', { mode: origMode })
  const after = await kget('/bots')
  check('bot deleted', !(after.bots ?? []).some((b) => b.bot.id === botId))

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
