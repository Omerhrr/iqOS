// E2E: compounding stake plan on a real paper bot.
// Refreshed for the T55/T57/T59 semantics (the old version predated them and
// failed on three fronts):
//   1. /compound_plan now hard-caps payout at 70% (T55) - growth is 1.7 at
//      full roll no matter what the broker pays; the excess is skimmed.
//   2. The research gate (T57) blocks arming any strategy without a fresh
//      walk-forward verdict - the suite asserts the gate actually blocks,
//      then arms with force:true (the designed override; the bot stays
//      visibly flagged forcedUnvalidated).
//   3. Compound settle now stops on loss (cycle halts, awaiting restart) and
//      folds wins at min(pnl, 70% of stake) - the replay mirrors both.
// The OTC defense gate (T56) is flipped to 'warn' for the run and restored:
// its verdict path has its own e2e, and a synthetic feed by construction
// can't pass an enforce-mode placebo for arbitrary TA strategies.
// Outcome-agnostic: works whether the bot wins or loses.
// Run: node scripts/compound_bot_e2e.mjs
const KERNEL = 'http://127.0.0.1:3030'
const BASE = 1
const PLAN_MAX_STAKE = 50 // keep in sync with the stakePlan below

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
  // 0. kernel up + capture sandbox state we mutate (restored in finally)
  const h = await kget('/health')
  check('kernel healthy', !!h.ok)
  const mode0 = await kget('/mode').catch(() => null)
  const origMode = mode0?.mode ?? 'human'
  const otc0 = await kget('/otc_config').catch(() => null)
  const origOtcPolicy = otc0?.config?.policy ?? 'enforce'

  let botId = null
  try {
    await kpost('/mode_set', { mode: 'auto', reason: 'compound e2e' })
    await kpost('/otc_config', { policy: 'warn' })

    // 1. /compound_plan math - payout capped at 70% by design
    const plan = await kget('/compound_plan?base=1&payout=0.85&steps=5&rollPct=100')
    check('plan ok', plan.ok === true)
    check('plan payout capped 0.85 -> 0.7', plan.capped === true && plan.payout === 0.7 && plan.payoutCap === 0.7, `payout=${plan.payout} raw=${plan.rawPayout}`)
    check('plan growth 1.7 (payout cap, not 1.85)', plan.growth === 1.7, String(plan.growth))
    const stakes = plan.schedule.map((s) => s.stake)
    check('plan ladder 1/1.7/2.89/4.91/8.35', JSON.stringify(stakes) === JSON.stringify([1, 1.7, 2.89, 4.91, 8.35]), JSON.stringify(stakes))
    const lossAt = plan.schedule.map((s) => s.lossAt)
    check('plan lossAt ladder (capital burned per step)', JSON.stringify(lossAt) === JSON.stringify([1, 2.7, 5.59, 10.5, 18.85]), JSON.stringify(lossAt))
    const plan07 = await kget('/compound_plan?base=1&payout=0.7&steps=5&rollPct=100')
    check('plan uncapped at exactly 0.7', plan07.capped === false && plan07.growth === 1.7, `capped=${plan07.capped} growth=${plan07.growth}`)
    const planCap = await kget('/compound_plan?base=1&payout=0.85&steps=10&maxStake=5')
    check('plan hitCapAt flagged at n=4 (1.7 growth)', planCap.hitCapAt === 4, String(planCap.hitCapAt))

    // 2. research gate (T57): an unvalidated strategy must NOT arm...
    const gateProbe = await kpost('/bot_save', {
      name: 'E2E compound gate-probe',
      enabled: true,
      watchlist: ['EURUSD-OTC'],
      strategyId: 'stoch-cross',
      tf: '5s',
      kind: 'binary',
      stake: 10,
      expiryBars: 1,
      minScore: 0,
      direction: 'both',
      regime: 'all',
      maxOpen: 1,
      cooldownSec: 0,
      stakePlan: { kind: 'compound', base: BASE, rollPct: 100, maxStake: PLAN_MAX_STAKE },
    })
    check('research gate blocks unvalidated arm', gateProbe.ok === false && /research-gate: .+walk-forward/.test(gateProbe.error ?? ''), gateProbe.error ?? 'saved?!')

    // 3. ...and force:true is the designed override (flagged, never silent)
    const candidates = ['stoch-cross', 'bb-bounce', 'ema-trend', 'macd-cross']
    botId = null
    let closed = 0
    let forcedSeen = false
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
        stakePlan: { kind: 'compound', base: BASE, rollPct: 100, maxStake: PLAN_MAX_STAKE },
        force: true, // research-gate override: no walk-forward verdict in the sandbox - deliberate
      })
      if (!res.ok) {
        console.log(`  (${strategyId} rejected: ${res.error})`)
        continue
      }
      if (!forcedSeen) {
        forcedSeen = true
        check('forced arm flagged on the bot', res.forced === true && res.bot?.forcedUnvalidated === true, `forced=${res.forced} flag=${res.bot?.forcedUnvalidated}`)
      }
      botId = res.bot.id
      // give it up to 40s to produce closed trades (5s binaries trade fast);
      // stop early when the cycle halts - stop-on-loss means no more trades
      closed = 0
      for (let i = 0; i < 20; i++) {
        await sleep(2000)
        const jr = await kget('/journal?scope=bots')
        closed = (jr.recent ?? []).filter((t) => t.note === `bot:${botId}` && (t.status === 'won' || t.status === 'lost')).length
        if (closed >= 3) break
        const fleet = await kget('/bots')
        const row = (fleet.bots ?? []).find((b) => b.bot.id === botId)
        if (row?.stats?.halted) break // cycle ended (loss) - ladder is complete
      }
      console.log(`  strategy ${strategyId}: ${closed} closed trades`)
      if (closed >= 1) break
      await kpost('/bot_delete', { id: botId })
      botId = null
    }
    check('compound bot produced >= 1 closed trades', !!botId && closed >= 1, `bot=${botId ?? 'none'} closed=${closed}`)
    if (!botId || closed < 1) return
    const strategyUsed = (await kget('/bots')).bots?.find((b) => b.bot.id === botId)?.bot.strategyId

    // 4. replay the ladder from the journal (chronological) and verify stakes
    const jr = await kget('/journal?scope=bots')
    const mine = (jr.recent ?? [])
      .filter((t) => t.note === `bot:${botId}` && (t.status === 'won' || t.status === 'lost'))
      .sort((a, b) => a.tsOpen - b.tsOpen)
    let pot = 0
    let rollN = 0
    let restarts = 0
    let sawLoss = false
    let ladderOk = true
    const trail = []
    for (const t of mine) {
      const working = pot >= 0.01 ? pot : BASE
      // full roll, capped at the plan's maxStake exactly like stakeFor()
      const expected = Math.min(PLAN_MAX_STAKE, r2(working))
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
        sawLoss = true
      }
    }
    check('stake ladder followed the pot (70%-capped fold, maxStake-aware)', ladderOk, trail.join(' | '))
    console.log(`  ladder: ${trail.join(' -> ')}`)

    // 5. /bots stats mirror the replay
    const fleet = await kget('/bots')
    const row = (fleet.bots ?? []).find((b) => b.bot.id === botId)
    check('bots stats: pot matches replay', row && r2(row.stats.pot) === r2(pot), `kernel=${row?.stats.pot} replay=${r2(pot)}`)
    check('bots stats: rollN matches', row && row.stats.rollN === rollN, `kernel=${row?.stats.rollN} replay=${rollN}`)
    check('bots stats: restarts matches', row && row.stats.restarts === restarts, `kernel=${row?.stats.restarts} replay=${restarts}`)
    check('bots stats: halted mirrors stop-on-loss', row && row.stats.halted === sawLoss, `kernel=${row?.stats.halted} replaySawLoss=${sawLoss}`)
    check('bots stats: config carries planState', !!row?.bot.planState, JSON.stringify(row?.bot.planState))
    check('bots stats: forcedUnvalidated flag persisted', row?.bot.forcedUnvalidated === true, String(row?.bot.forcedUnvalidated))
    console.log(`  (strategy used: ${strategyUsed})`)
  } finally {
    // 6. cleanup: disarm, delete, restore otc policy + mode (even on crash)
    if (botId) {
      await kpost('/bot_toggle', { id: botId, enabled: false }).catch(() => {})
      await kpost('/bot_delete', { id: botId }).catch(() => {})
    }
    await kpost('/otc_config', { policy: origOtcPolicy }).catch(() => {})
    await kpost('/mode_set', { mode: origMode }).catch(() => {})
    const after = await kget('/bots')
    check('bot deleted', !(after.bots ?? []).some((b) => b.bot.id === botId))
    const otcAfter = await kget('/otc_config')
    check('otc policy restored', otcAfter?.config?.policy === origOtcPolicy, `${otcAfter?.config?.policy} (want ${origOtcPolicy})`)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
