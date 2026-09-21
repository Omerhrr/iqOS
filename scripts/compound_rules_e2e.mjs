// E2E: compounding house rules on a real paper bot.
//   Rule 1 - payout is capped at 70% no matter what the broker pays
//            (/compound_plan clamps, and a win folds in at most stake*0.70).
//   Rule 2 - stop-on-loss (default): ONE loss ends the cycle - the bot stands
//            down (planState.halted) and does not trade again until an
//            explicit /bot_restart; a stopOnLoss:false control bot keeps
//            rolling instead.
// Outcome-agnostic: waits until the strict bot has both a win and a loss.
// Run: node scripts/compound_rules_e2e.mjs
const KERNEL = 'http://127.0.0.1:3030'
const BASE = 1
const CAP = 0.7

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
let skips = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`)
  if (!cond) failures++
}
function skip(name, detail = '') {
  console.log(`SKIP - ${name}${detail ? ` (${detail})` : ''}`)
  skips++
}
const r2 = (x) => Math.round(x * 100) / 100

async function closedTrades(botId) {
  const jr = await kget('/journal?scope=bots')
  return (jr.recent ?? [])
    .filter((t) => t.note === `bot:${botId}` && (t.status === 'won' || t.status === 'lost'))
    .sort((a, b) => a.tsOpen - b.tsOpen)
}

async function main() {
  // 0. kernel up + capture original mode
  const h = await kget('/health')
  check('kernel healthy', !!h.ok)
  const mode0 = await kget('/mode').catch(() => null)
  const origMode = mode0?.mode ?? 'human'
  await kpost('/mode_set', { mode: 'auto', reason: 'compound rules e2e' })

  // 1. /compound_plan payout cap
  const plan = await kget('/compound_plan?base=1&payout=0.92&steps=5&rollPct=100')
  check('plan ok', plan.ok === true)
  check('plan clamps payout 0.92 -> 0.70', plan.payout === 0.7 && plan.rawPayout === 0.92 && plan.capped === true, JSON.stringify({ payout: plan.payout, rawPayout: plan.rawPayout, capped: plan.capped }))
  check('plan growth 1.70 at cap', plan.growth === 1.7, String(plan.growth))
  const stakes = plan.schedule.map((s) => s.stake)
  check('plan ladder at 70% cap 1/1.70/2.89/4.91/8.35', JSON.stringify(stakes) === JSON.stringify([1, 1.7, 2.89, 4.91, 8.35]), JSON.stringify(stakes))
  const planLow = await kget('/compound_plan?base=1&payout=0.55&steps=3&rollPct=100')
  check('plan passes sub-cap payout through', planLow.payout === 0.55 && planLow.capped === false, JSON.stringify({ payout: planLow.payout, capped: planLow.capped }))
  const planDef = await kget('/compound_plan?base=1&steps=3')
  check('plan default payout is the 0.70 cap', planDef.payout === 0.7, String(planDef.payout))

  // 2. two compound bots on fast 5s binaries: strict (stop-on-loss) + control (re-seed)
  const mk = async (name, stopOnLoss) => {
    for (const strategyId of ['stoch-cross', 'bb-bounce', 'ema-trend', 'macd-cross']) {
      const res = await kpost('/bot_save', {
        name,
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
        maxOpen: 1,
        cooldownSec: 0,
        stakePlan: { kind: 'compound', base: BASE, rollPct: 100, maxStake: 50, payoutCap: 70, stopOnLoss },
      })
      if (res.ok) return res.bot.id
      console.log(`  (${name}/${strategyId} rejected: ${res.error})`)
    }
    return null
  }
  const strictId = await mk('E2E strict', true)
  const controlId = await mk('E2E control', false)
  check('strict compound bot created', !!strictId)
  check('control compound bot created', !!controlId)
  if (!strictId || !controlId) {
    await kpost('/mode_set', { mode: origMode })
    process.exit(1)
  }

  // 3. wait for the strict bot to see BOTH a win and a loss (150s budget)
  let mine = []
  for (let i = 0; i < 75; i++) {
    await sleep(2000)
    mine = await closedTrades(strictId)
    const wins = mine.filter((t) => t.status === 'won').length
    const losses = mine.filter((t) => t.status === 'lost').length
    if (wins >= 1 && losses >= 1) break
  }
  const wins = mine.filter((t) => t.status === 'won').length
  const losses = mine.filter((t) => t.status === 'lost').length
  console.log(`  strict bot trades: ${mine.length} (won ${wins} / lost ${losses})`)
  check('strict bot produced closed trades', mine.length >= 1)

  // 4. replay the strict ladder: win folds min(pnl, stake*0.70), loss burns stake
  let pot = 0
  let rollN = 0
  let haltSeenAt = -1 // trade index whose loss should halt the cycle
  let ladderOk = true
  const trail = []
  for (let i = 0; i < mine.length; i++) {
    const t = mine[i]
    const working = pot >= 0.01 ? pot : BASE
    if (r2(t.amount) !== r2(working)) {
      ladderOk = false
      trail.push(`MISMATCH trade@${i} amount=${t.amount} expected=${r2(working)}`)
      break
    }
    if (t.status === 'won') {
      const fold = Math.min(t.pnl ?? 0, t.amount * CAP)
      pot = r2(working + fold)
      rollN += 1
      trail.push(`won $${t.amount} +${r2(fold)} (pnl ${r2(t.pnl)}${t.pnl > t.amount * CAP + 1e-9 ? ' capped' : ''})`)
    } else {
      pot = r2(Math.max(0, working - t.amount))
      if (rollN > 0) trail.push(`lost $${t.amount} -> cycle over`)
      else trail.push(`lost $${t.amount}`)
      rollN = 0
      if (haltSeenAt === -1) haltSeenAt = i
    }
  }
  check('stake ladder followed the 70%-capped pot', ladderOk, trail.join(' | '))
  console.log(`  ladder: ${trail.join(' -> ')}`)

  const fleet1 = await kget('/bots')
  const strictRow1 = (fleet1.bots ?? []).find((b) => b.bot.id === strictId)
  check('stats: pot matches replay', strictRow1 && r2(strictRow1.stats.pot) === r2(pot), `kernel=${strictRow1?.stats.pot} replay=${r2(pot)}`)
  check('stats carry halted flag', strictRow1 && typeof strictRow1.stats.halted === 'boolean')

  // 5. stop-on-loss: after the first loss the cycle is halted and frozen
  if (haltSeenAt >= 0) {
    check('planState.halted set after the loss', strictRow1?.bot.planState?.halted === true, JSON.stringify(strictRow1?.bot.planState))
    check('stats.halted exposed to UI', strictRow1?.stats.halted === true)
    // no NEW trades may appear after the halt (wait out any open position first)
    for (let i = 0; i < 15 && strictRow1?.stats.openCount > 0; i++) {
      await sleep(2000)
    }
    const frozenCount = (await closedTrades(strictId)).length
    await sleep(9000)
    const frozenCount2 = (await closedTrades(strictId)).length
    check('halted bot stopped trading', frozenCount2 === frozenCount && frozenCount2 === mine.length, `before=${frozenCount} after=${frozenCount2}`)
  } else {
    skip('stop-on-loss halt', 'no loss observed in the window')
  }

  // 6. control bot (stopOnLoss:false) must never halt
  const ctlTrades = await closedTrades(controlId)
  const ctlLosses = ctlTrades.filter((t) => t.status === 'lost').length
  const ctlRow = (await kget('/bots')).bots.find((b) => b.bot.id === controlId)
  if (ctlLosses > 0) {
    check('control bot re-seeds instead of halting', ctlRow?.bot.planState?.halted !== true && ctlRow?.stats.halted === false, `losses=${ctlLosses} planState=${JSON.stringify(ctlRow?.bot.planState)}`)
  } else {
    skip('control re-seed behaviour', 'no loss observed yet')
  }

  // 7. /bot_restart revives the strict cycle: halt cleared, pot re-seeded, trading resumes
  const restartTs = Math.floor(Date.now() / 1000)
  const rr = await kpost('/bot_restart', { id: strictId })
  check('bot_restart ok', rr.ok === true, JSON.stringify(rr.error ?? ''))
  const fleet2 = await kget('/bots')
  const strictRow2 = (fleet2.bots ?? []).find((b) => b.bot.id === strictId)
  check('restart cleared halted', strictRow2?.stats.halted === false && strictRow2?.bot.planState?.halted !== true, JSON.stringify(strictRow2?.bot.planState))
  check('restart re-seeded pot to base', strictRow2 && r2(strictRow2.stats.pot) === 0 && strictRow2.stats.rollN === 0, `pot=${strictRow2?.stats.pot}`)
  check('restart kept cumulative cycles', strictRow2 && strictRow2.stats.restarts >= (strictRow1?.stats.restarts ?? 0))

  // it must trade again (minScore 0 on 5s candles -> within ~40s)
  let revived = false
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    const after = await closedTrades(strictId)
    const fresh = after.filter((t) => t.tsOpen > restartTs)
    if (fresh.length > 0) {
      const t = fresh[0]
      check('revived trade stakes the seed again', r2(t.amount) === BASE, `amount=${t.amount}`)
      revived = true
      break
    }
    if ((await kget('/bots')).bots.find((b) => b.bot.id === strictId)?.stats.halted === true) break // lost again instantly - still proof of revival
  }
  if (haltSeenAt >= 0) check('bot traded again after restart', revived)
  else skip('revival trade', 'no prior halt')

  // 8. cleanup
  await kpost('/bot_toggle', { id: strictId, enabled: false })
  await kpost('/bot_delete', { id: strictId })
  await kpost('/bot_toggle', { id: controlId, enabled: false })
  await kpost('/bot_delete', { id: controlId })
  await kpost('/mode_set', { mode: origMode })
  const after = await kget('/bots')
  check('bots deleted', !(after.bots ?? []).some((b) => b.bot.id === strictId || b.bot.id === controlId))

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}${skips ? ` (${skips} skipped)` : ''}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
