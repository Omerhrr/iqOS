// Deterministic selftest for the compounding house rules (no market luck):
//   Rule 1 - payout cap: a win folds in at most payoutCap% (default+max 70) of
//            the stake as profit, even when the broker paid more (94% here).
//   Rule 2 - stop-on-loss: one loss sets planState.halted (persisted); a
//            stopOnLoss:false control bot re-seeds instead of halting.
//   Restart - bot_restart clears the halt and re-seeds the pot.
// Also checks the payoutCap clamp (90 -> 70) in parseStakePlan.
// Run: bun scripts/compound_rules_selftest.ts
import { Store } from '../mini-services/trading-core/src/store'
import { AutopilotService } from '../mini-services/trading-core/src/plugins/autopilot'
import type { Position } from '../mini-services/trading-core/src/types'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`)
  if (!cond) failures++
}
const r2 = (x: number) => Math.round(x * 100) / 100

const mkSvc = () => {
  const store = new Store(':memory:')
  const svc = new AutopilotService()
  const s = svc as unknown as {
    store: Store
    market: { assets: { ticker: string }[] }
    ctx: { bus: { emit: () => void; on: () => void }; log: () => void; use: () => never }
  }
  s.store = store
  s.market = { assets: [{ ticker: 'EURUSD-OTC' }, { ticker: 'BTCUSD' }] }
  s.ctx = { bus: { emit: () => {}, on: () => () => {} }, log: () => {}, use: () => { throw new Error('no plugins') } }
  return { store, svc }
}

const mkPos = (over: Partial<Position>): Position =>
  ({
    id: `p${Math.random().toString(36).slice(2, 8)}`,
    tsOpen: Math.floor(Date.now() / 1000),
    tsClose: Math.floor(Date.now() / 1000),
    asset: 'EURUSD-OTC',
    tf: '5s',
    side: 'call',
    kind: 'binary',
    mode: 'paper',
    amount: 1,
    expiryBars: 1,
    entryPrice: 1.1,
    exitPrice: 1.1,
    payout: 0.94,
    status: 'won',
    note: '',
    ...over,
  }) as Position

async function main() {
  // ---------- strict bot: cap fold + halt + restart ----------
  const { store, svc } = mkSvc()
  const saved = svc.saveBot({
    name: 'strict',
    watchlist: ['EURUSD-OTC'],
    strategyId: 'rsi-reversion',
    tf: '5s',
    kind: 'binary',
    stake: 10,
    maxOpen: 1,
    cooldownSec: 0,
    stakePlan: { kind: 'compound', base: 1, rollPct: 100, maxStake: 50, payoutCap: 70, stopOnLoss: true },
  })
  check('strict bot saved', saved.ok === true, saved.error ?? '')
  const botId = saved.bot!.id
  const close = (over: Partial<Position>) =>
    (svc as unknown as { onPositionClosed: (p: Position) => void }).onPositionClosed(mkPos({ ...over, note: `bot:${botId}` }))
  const plan = () => store.listBots().find((b) => b.bot.id === botId)!.bot.planState!
  const stats = () => (svc as unknown as { statsFor: (id: string) => Record<string, unknown> }).statsFor(botId)

  // trade 1: WIN $1 with broker paying 94% -> fold capped at $0.70, pot 1.70
  close({ status: 'won', amount: 1, pnl: 0.94 })
  check('win fold capped at 70% (0.94 -> 0.70)', plan().pot === 1.7, `pot=${plan().pot}`)
  check('rollN advanced', plan().rollN === 1)
  check('not halted on a win', plan().halted !== true)

  // trade 2: WIN $1.70, payout 94% -> fold 1.19 (not 1.598), pot 2.89
  close({ status: 'won', amount: 1.7, pnl: 1.598 })
  check('second win fold capped (1.598 -> 1.19)', plan().pot === 2.89, `pot=${plan().pot}`)
  check('rollN = 2', plan().rollN === 2)

  // trade 3: LOSS $2.89 -> pot 0 AND the cycle halts (persisted)
  close({ status: 'lost', amount: 2.89, pnl: -2.89 })
  check('loss burns the stake', plan().pot === 0, `pot=${plan().pot}`)
  check('loss HALTS the cycle (planState.halted)', plan().halted === true, JSON.stringify(plan()))
  check('stats expose halted to UI', stats().halted === true)
  check('completed cycle counted', plan().restarts === 1)

  // restart: halt cleared, pot re-seeded to base, cumulative cycles kept
  const rr = svc.restartBot(botId)
  check('restartBot ok', rr.ok === true, rr.error ?? '')
  const after = plan()
  check('restart cleared halt', after.halted !== true)
  check('restart re-seeded pot', after.pot === 0 && after.rollN === 0, `pot=${after.pot}`)
  check('restart kept cumulative cycles', after.restarts === 1)

  // sub-cap passthrough: payout 55% <= cap folds the full pnl (working pot =
  // re-seeded base $1 after the restart, so pot = 1 + 0.55)
  close({ status: 'won', amount: 1, pnl: 0.55, payout: 0.55 })
  check('sub-cap payout folds fully (0.55)', plan().pot === 1.55, `pot=${plan().pot}`)

  // ---------- control bot: stopOnLoss:false keeps the legacy re-seed roll ----------
  const ctl = mkSvc()
  const savedCtl = ctl.svc.saveBot({
    name: 'control',
    watchlist: ['EURUSD-OTC'],
    strategyId: 'rsi-reversion',
    tf: '5s',
    kind: 'binary',
    stake: 10,
    maxOpen: 1,
    cooldownSec: 0,
    stakePlan: { kind: 'compound', base: 1, rollPct: 100, maxStake: 50, payoutCap: 70, stopOnLoss: false },
  })
  check('control bot saved', savedCtl.ok === true, savedCtl.error ?? '')
  const ctlId = savedCtl.bot!.id
  const ctlClose = (over: Partial<Position>) =>
    (ctl.svc as unknown as { onPositionClosed: (p: Position) => void }).onPositionClosed(mkPos({ ...over, note: `bot:${ctlId}` }))
  const ctlPlan = () => ctl.store.listBots().find((b) => b.bot.id === ctlId)!.bot.planState!

  ctlClose({ status: 'won', amount: 1, pnl: 0.94 })
  check('control: win still folds capped', Math.abs(ctlPlan().pot - 1.7) < 1e-9, `pot=${ctlPlan().pot}`)
  ctlClose({ status: 'lost', amount: 1.7, pnl: -1.7 })
  check('control: loss burns back to base, does NOT halt (re-seeds)', ctlPlan().halted !== true, JSON.stringify(ctlPlan()))

  // restart on a non-compound bot is rejected
  const fixed = ctl.svc.saveBot({ id: 'fixed-bot', name: 'fixed', watchlist: ['EURUSD-OTC'], strategyId: 'rsi-reversion', tf: '5s', kind: 'binary', stake: 10 })
  const rr2 = ctl.svc.restartBot(fixed.bot!.id)
  check('restart rejected for fixed bots', rr2.ok === false, rr2.error ?? '')

  // ---------- payoutCap clamp: 90 is forced down to the 70 house maximum ----------
  const clampSvc = mkSvc()
  const savedCap = clampSvc.svc.saveBot({
    name: 'clamped',
    watchlist: ['EURUSD-OTC'],
    strategyId: 'rsi-reversion',
    tf: '5s',
    kind: 'binary',
    stake: 10,
    stakePlan: { kind: 'compound', base: 1, payoutCap: 90, stopOnLoss: true },
  })
  check('payoutCap 90 clamped to 70', savedCap.bot!.stakePlan?.payoutCap === 70, String(savedCap.bot!.stakePlan?.payoutCap))

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
