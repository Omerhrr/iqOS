// AI Trader compounding stake plan - deterministic logic unit (bun, in-process).
// Locks the contract added with the AI Trader's stakePlan (plugins/aitrader.ts),
// mirrored field-for-field from the autopilot bots' StakePlan machinery and the
// Backtest Lab compound engine (strategies/backtest.ts):
//   - sanitize: junk/zero/over-cap plan fields clamp or drop (base>=1,
//     payoutCap<=70, rollPct<=100, kind!=='compound' = no plan at all)
//   - sizing: pot-based (dust < $0.01 re-seeds at base), rollPct% of the pot,
//     maxStake clamp, $1 broker floor, cents rounding; flat stake with no plan
//   - fold-in/burn: a win folds min(pnl, amount*payoutCap%) into the pot
//     (rollPct is a SIZING lever only, exactly like backtest.ts/autopilot - it
//     does NOT shrink the fold), a loss burns the stake back out
//   - stop-on-loss (default) halts the cycle; periods N completes it on the
//     Nth win (halt, or auto re-seed under onComplete:'reseed' bounded by
//     reseedLimit); stopOnLoss:false + lossReseedLimit forces a stop after N
//     consecutive losses; a win resets the loss re-seed counter
//   - the halt gate: a halted plan skips the WHOLE cycle (skip decision row,
//     no LLM call) until restartCompound(); restart re-seeds at base and keeps
//     the cumulative restarts counter
//   - identity: only positions tagged strategy 'ai-trader' feed the roll
//   - persistence: the roll state rides the ai_trader_config blob and is
//     restored on start(); dropping the plan resets it
//   - derisk: after deriskAfter wins, sizing switches to deriskPct% of the pot
import { EventBus } from '../mini-services/trading-core/src/kernel'
import type { KernelContext } from '../mini-services/trading-core/src/kernel'
import { Store } from '../mini-services/trading-core/src/store'
import { AiTraderService } from '../mini-services/trading-core/src/plugins/aitrader'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    pass++
    console.log('  ok', name)
  } else {
    fail++
    console.log('  FAIL', name, detail)
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

// ---------- harness: a REAL Store per section on its own temp dir (plan
// state rides the config blob, so a shared store would leak roll state
// across sections), stub market/exec ----------
type AiPos = { strategy?: string; status: string; pnl?: number; amount?: number }
function makeCtx(bus: EventBus, store: Store): KernelContext {
  return {
    bus,
    services: new Map(),
    provide: () => {},
    // 'market'/'execution' are only assigned in start(); the compounding paths
    // under test never touch them (the halt gate short-circuits before candidates).
    use: (name: string) => (name === 'store' ? store : {}),
    log: () => {},
  } as unknown as KernelContext
}
const settle = (bus: EventBus, position: AiPos) => bus.emit('positionClosed', { position })
const won = (amount: number, pnl: number): AiPos => ({ strategy: 'ai-trader', status: 'won', pnl, amount })
const lost = (amount: number, pnl = -amount): AiPos => ({ strategy: 'ai-trader', status: 'lost', pnl, amount })

/** Each call = a fresh database + fresh kernel bus, i.e. a fresh boot. */
async function freshService() {
  const dir = mkdtempSync(join(tmpdir(), 'aitrader-compound-unit-'))
  const store = new Store(join(dir, 'unit.db'))
  const bus = new EventBus()
  const svc = new AiTraderService()
  await svc.start(makeCtx(bus, store))
  return { svc, bus, store }
}

// ---------- 1. sanitize: junk in, sane plan out (or no plan) ----------
{
  const { svc } = await freshService()
  svc.configure({ stake: 2 })
  const st = svc.getStatus()
  ok(st.nextStake.compound === false, 'flat default: no plan -> flat stake sizing')
  ok(st.nextStake.amount === 2, 'flat default: next stake = config.stake', String(st.nextStake.amount))

  // junk kind -> plan dropped entirely
  svc.configure({ stakePlan: { kind: 'martingale', base: 5 } as never })
  ok(svc.getStatus().config.stakePlan === undefined, "kind !== 'compound' -> plan dropped")

  // clamps mirror autopilot's parseStakePlan
  svc.configure({ stakePlan: { kind: 'compound', base: 0, rollPct: 500, payoutCap: 90 } })
  const plan = svc.getStatus().config.stakePlan
  ok(isObj(plan) && plan.base === 1, 'base clamped to the $1 broker minimum', JSON.stringify(plan))
  ok(isObj(plan) && plan.rollPct === 100, 'rollPct clamped to 100', JSON.stringify(plan))
  ok(isObj(plan) && plan.payoutCap === 70, 'payoutCap clamped to the 70% house max', JSON.stringify(plan))

  // NaN poison -> fallbacks, not NaN propagation
  svc.configure({ stakePlan: { kind: 'compound', base: NaN, payoutCap: NaN } as never })
  const plan2 = svc.getStatus().config.stakePlan
  ok(isObj(plan2) && plan2.base === 1 && plan2.payoutCap === 70, 'NaN fields fall back to defaults (base 1, cap 70)', JSON.stringify(plan2))

  // the config surface never leaks the plan state blob
  ok(!JSON.stringify(svc.getStatus().config).includes('planState'), 'status().config does not leak planState')

  // restart without a plan is a clean 400
  svc.configure({ stakePlan: undefined })
  ok(svc.restartCompound().ok === false, 'restart without a compound plan is rejected')
  svc.stop()
}

// ---------- 2. fold-in / burn / cap / sizing (rollPct = sizing lever only) ----------
{
  const { svc, bus } = await freshService()
  svc.configure({ stakePlan: { kind: 'compound', base: 2, payoutCap: 70 } })
  let st = svc.getStatus()
  ok(st.nextStake.amount === 2 && st.nextStake.pot === 2 && st.nextStake.phase === 'compound', 'fresh cycle: dust pot re-seeds at base for sizing')

  // broker pays 90% but the cap is 70: fold = min(1.8, 2*0.7) = 1.4 -> pot 3.4
  settle(bus, won(2, 1.8))
  st = svc.getStatus()
  ok(st.planState.pot === 3.4 && st.planState.rollN === 1, 'win folds payout capped at payoutCap% (90% pay -> 70% fold)', `pot ${st.planState.pot}`)
  ok(st.nextStake.amount === 3.4, 'next stake = full pot at rollPct 100', String(st.nextStake.amount))

  // second win on the rolled pot: fold capped at 3.4*0.7 = 2.38 -> pot 5.78
  settle(bus, won(3.4, 2.78))
  st = svc.getStatus()
  ok(st.planState.pot === 5.78 && st.planState.rollN === 2, 'second win compounds the rolled pot (cents-rounded)', `pot ${st.planState.pot}`)

  // rollPct is a SIZING lever, not a fold lever (mirrors backtest.ts + autopilot)
  svc.configure({ stakePlan: { kind: 'compound', base: 2, rollPct: 50, payoutCap: 70 } })
  settle(bus, won(2, 1.4)) // pot was 5.78 >= $0.01, folds 1.4 -> 7.18
  st = svc.getStatus()
  ok(st.planState.pot === 7.18, 'rollPct does NOT shrink the fold-in', `pot ${st.planState.pot}`)
  ok(st.nextStake.amount === 3.59, 'rollPct 50 halves the STAKE (7.18 * 0.5)', String(st.nextStake.amount))

  // maxStake clamp
  svc.configure({ stakePlan: { kind: 'compound', base: 2, maxStake: 3, payoutCap: 70 } })
  ok(svc.getStatus().nextStake.amount === 3, 'maxStake caps the rolled stake', String(svc.getStatus().nextStake.amount))

  // loss burns the stake back out and halts (stopOnLoss default true)
  settle(bus, lost(3))
  st = svc.getStatus()
  ok(st.planState.pot === 4.18 && st.planState.rollN === 0, 'loss burns the actual stake from the pot', `pot ${st.planState.pot}`)
  ok(st.planState.halted === true && st.planState.complete === false, 'stop-on-loss halts the cycle')
  ok(st.planState.restarts === 1, 'a winning streak ended -> restarts counter bumped')
  svc.stop()
}

// ---------- 3. halt gate: no analysis, no LLM call, skip row in the log ----------
{
  const { svc, bus } = await freshService()
  svc.configure({ stakePlan: { kind: 'compound', base: 2, payoutCap: 70 } })
  settle(bus, lost(2))
  ok(svc.getStatus().planState.halted === true, 'halted after the loss')
  const before = svc.getStatus().cycles
  const out = await svc.runNow()
  ok(out.ok === false, 'halted runNow resolves not-ok (nothing acted on)')
  ok(svc.getStatus().cycles === before + 1, 'halted cycle still counts as a cycle')
  const rows = svc.listDecisions(3)
  ok(rows.length >= 1 && rows[0].direction === 'skip' && /compound cycle ended on a loss/.test(rows[0].reasoning), 'halted cycle logs a skip row that says why', rows[0]?.reasoning)
  ok(/no LLM call made/.test(rows[0].reasoning), 'the skip row is explicit about no LLM spend')

  // restart revives: pot 0, halt cleared, next stake back at the seed
  ok(svc.restartCompound().ok === true, 'restart accepted with a plan armed')
  const st = svc.getStatus()
  ok(st.planState.halted === false && st.planState.pot === 0 && st.planState.rollN === 0, 'restart re-seeds the pot at base')
  ok(st.nextStake.amount === 2, 'next stake after restart = seed $2', String(st.nextStake.amount))
  svc.stop()
}

// ---------- 4. periods complete: win-side halt vs auto re-seed + limit ----------
{
  // periods 2, onComplete halt (default): the 2nd win completes the cycle
  const a = await freshService()
  a.svc.configure({ stakePlan: { kind: 'compound', base: 1, periods: 2, payoutCap: 70 } })
  settle(a.bus, won(1, 0.7))
  settle(a.bus, won(1.7, 1.19)) // fold capped at 1.7*0.7 = 1.19 -> pot 2.89
  let st = a.svc.getStatus()
  ok(st.planState.complete === true && st.planState.halted === true, 'periods reached: cycle COMPLETE and halted (win-side)')
  ok(st.planState.rollN === 2 && st.planState.restarts === 1, 'complete cycle keeps rollN and bumps restarts')
  a.svc.restartCompound()
  st = a.svc.getStatus()
  ok(st.planState.restarts === 1 && st.planState.pot === 0 && !st.planState.halted, 'restart keeps the cumulative restarts counter')
  a.svc.stop()

  // periods 1 + onComplete reseed + reseedLimit 1: one auto re-seed, then forced halt
  const b = await freshService()
  b.svc.configure({ stakePlan: { kind: 'compound', base: 1, periods: 1, onComplete: 'reseed', reseedLimit: 1, payoutCap: 70 } })
  settle(b.bus, won(1, 0.7))
  st = b.svc.getStatus()
  ok(!st.planState.halted && st.planState.reseedCount === 1 && st.planState.pot === 0, 'complete + reseed: pot re-seeded, NOT halted')
  settle(b.bus, won(1, 0.7))
  st = b.svc.getStatus()
  ok(st.planState.halted === true && st.planState.complete === true, 'reseed limit reached: forced win-side halt')
  ok(st.planState.restarts === 2, 'both completions counted as restarts')
  b.svc.stop()
}

// ---------- 5. stopOnLoss:false + lossReseedLimit (forced stop after N losses) ----------
{
  const { svc, bus } = await freshService()
  svc.configure({ stakePlan: { kind: 'compound', base: 2, stopOnLoss: false, lossReseedLimit: 2, payoutCap: 70 } })
  settle(bus, lost(2))
  let st = svc.getStatus()
  ok(!st.planState.halted && st.planState.lossReseedCount === 1, 'loss 1 re-seeded through (not halted)')
  settle(bus, won(2, 1.4)) // a win resets the consecutive-loss counter
  st = svc.getStatus()
  ok(st.planState.lossReseedCount === 0 && st.planState.rollN === 1, 'win resets the loss re-seed counter')
  settle(bus, lost(2.7))
  st = svc.getStatus()
  ok(!st.planState.halted && st.planState.lossReseedCount === 1, 'loss after a win restarts the counter (not halted)')
  settle(bus, lost(2))
  st = svc.getStatus()
  ok(st.planState.halted === true && st.planState.complete === false, '2 consecutive re-seeded losses -> forced stop')
  svc.stop()
}

// ---------- 6. identity: only ai-trader positions feed the roll ----------
{
  const { svc, bus } = await freshService()
  svc.configure({ stakePlan: { kind: 'compound', base: 2, payoutCap: 70 } })
  settle(bus, { strategy: 'bot:abc', status: 'won', pnl: 100, amount: 2 })
  settle(bus, { strategy: 'meta:oracle', status: 'lost', pnl: -2, amount: 2 })
  settle(bus, { status: 'won', pnl: 5, amount: 2 }) // untagged (manual ticket)
  settle(bus, { strategy: 'ai-trader', status: 'closed', pnl: 3, amount: 2 }) // early exit, not a binary settle
  const st = svc.getStatus()
  ok(st.planState.pot === 0 && st.planState.rollN === 0 && !st.planState.halted, 'foreign/unsettled positions never touch the pot', `pot ${st.planState.pot} rollN ${st.planState.rollN}`)
  ok(st.nextStake.pot === 2 && st.nextStake.compound === true, 'sizing still reads the seed while the raw pot is untouched', JSON.stringify(st.nextStake))
  svc.stop()
}

// ---------- 7. derisk ladder ----------
{
  const { svc, bus } = await freshService()
  svc.configure({ stakePlan: { kind: 'compound', base: 2, deriskAfter: 1, deriskPct: 50, payoutCap: 70 } })
  settle(bus, won(2, 1.4)) // pot 3.4, rollN 1
  const st = svc.getStatus()
  ok(st.nextStake.phase === 'derisk', 'derisk phase engaged after the threshold')
  ok(st.nextStake.amount === 1.7, 'deriskPct 50 stakes half the pot (3.4 * 0.5)', String(st.nextStake.amount))
  svc.stop()
}

// ---------- 8. persistence: the roll survives a kernel restart; dropping the plan resets it ----------
{
  const { svc, bus, store } = await freshService()
  svc.configure({ stakePlan: { kind: 'compound', base: 2, payoutCap: 70 } })
  settle(bus, won(2, 1.4)) // pot 3.4 rollN 1
  settle(bus, lost(3.4)) // pot 0... burn -> pot 0, halted
  const saved = svc.getStatus().planState
  // a "rebooted" service over the SAME store (new bus so no double-settle)
  const bus2 = new EventBus()
  const svc2 = new AiTraderService()
  await svc2.start(makeCtx(bus2, store))
  const restored = svc2.getStatus().planState
  ok(restored.pot === saved.pot && restored.rollN === saved.rollN && restored.halted === saved.halted && restored.restarts === saved.restarts, 'plan state restored from the config blob after a restart', JSON.stringify({ saved, restored }))

  // dropping the plan wipes the roll state (fresh start on re-arm)
  svc2.configure({ stakePlan: undefined })
  const st = svc2.getStatus()
  ok(!st.nextStake.compound && st.planState.pot === 0 && !st.planState.halted, 'switching back to flat drops the roll state')
  // and re-arming starts a genuinely fresh cycle, not the old halted one
  svc2.configure({ stakePlan: { kind: 'compound', base: 2, payoutCap: 70 } })
  const st2 = svc2.getStatus()
  ok(st2.nextStake.compound && st2.planState.pot === 0 && !st2.planState.halted && st2.nextStake.pot === 2, 're-arming the plan starts a fresh cycle at base')
  svc.stop()
  svc2.stop()
}

console.log(`\naitrader_compound_unit: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
