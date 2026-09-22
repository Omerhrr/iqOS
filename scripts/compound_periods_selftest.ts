// Deterministic selftest for Task 37 compounding extensions (no market luck):
//   Rule 1 - periods: the Nth WIN completes the cycle (halt+complete, or
//            onComplete 'reseed' auto-restarts).
//   Rule 2 - de-risk: after deriskAfter wins, stakes drop to deriskPct% of
//            the pot; a derisk-phase loss only burns that fraction.
//   Rule 3 - session windows: inSession() boundaries incl. midnight wrap.
//   Rule 4 - time expiry + session parsing/clamps in saveBot.
// Run: bun scripts/compound_periods_selftest.ts
import { Store } from '../mini-services/trading-core/src/store'
import { AutopilotService, inSession } from '../mini-services/trading-core/src/plugins/autopilot'
import type { Position } from '../mini-services/trading-core/src/types'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`)
  if (!cond) failures++
}

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

const utcDate = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 22, h, m))

async function main() {
  // ---------- 1. periods: 3 wins complete the cycle (halt + complete) ----------
  const a = mkSvc()
  const savedA = a.svc.saveBot({
    name: 'p3', watchlist: ['EURUSD-OTC'], strategyId: 'rsi-reversion', tf: '5s', kind: 'binary',
    stake: 10, maxOpen: 1, cooldownSec: 0,
    stakePlan: { kind: 'compound', base: 1, rollPct: 100, payoutCap: 70, stopOnLoss: true, periods: 3 },
  })
  check('periods bot saved', savedA.ok === true, savedA.error ?? '')
  const idA = savedA.bot!.id
  const closeA = (over: Partial<Position>) =>
    (a.svc as unknown as { onPositionClosed: (p: Position) => void }).onPositionClosed(mkPos({ ...over, note: `bot:${idA}` }))
  const planA = () => a.store.listBots().find((b) => b.bot.id === idA)!.bot.planState!
  const statsA = () => (a.svc as unknown as { statsFor: (id: string) => Record<string, unknown> }).statsFor(idA)

  closeA({ status: 'won', amount: 1, pnl: 0.94 })
  closeA({ status: 'won', amount: 1.7, pnl: 1.598 })
  check('2 wins: not halted yet', planA().halted !== true, `pot=${planA().pot}`)
  closeA({ status: 'won', amount: 2.89, pnl: 2.89 * 0.94 })
  check('3rd win COMPLETES the cycle (halted)', planA().halted === true, JSON.stringify(planA()))
  check('complete flag set (win-side halt)', planA().complete === true)
  check('pot at 70% cap ladder 1.7^3', Math.abs(planA().pot - 4.91) < 0.011, `pot=${planA().pot}`)
  check('cycle counted once', planA().restarts === 1)
  check('stats expose complete to UI', statsA().complete === true && statsA().halted === true)
  const rA = a.svc.restartBot(idA)
  check('restart after complete ok', rA.ok === true)
  check('restart cleared complete', planA().complete !== true && planA().halted !== true)

  // ---------- 2. periods + onComplete reseed: auto fresh cycle ----------
  const b = mkSvc()
  const savedB = b.svc.saveBot({
    name: 'p2-reseed', watchlist: ['EURUSD-OTC'], strategyId: 'rsi-reversion', tf: '5s', kind: 'binary',
    stake: 10, maxOpen: 1, cooldownSec: 0,
    stakePlan: { kind: 'compound', base: 1, rollPct: 100, payoutCap: 70, stopOnLoss: true, periods: 2, onComplete: 'reseed' },
  })
  check('reseed bot saved', savedB.ok === true)
  const idB = savedB.bot!.id
  const closeB = (over: Partial<Position>) =>
    (b.svc as unknown as { onPositionClosed: (p: Position) => void }).onPositionClosed(mkPos({ ...over, note: `bot:${idB}` }))
  const planB = () => b.store.listBots().find((x) => x.bot.id === idB)!.bot.planState!
  closeB({ status: 'won', amount: 1, pnl: 0.94 })
  closeB({ status: 'won', amount: 1.7, pnl: 1.598 })
  check('reseed: cycle completes WITHOUT halt', planB().halted !== true && planB().complete !== true, JSON.stringify(planB()))
  check('reseed: pot back to 0', planB().pot === 0 && planB().rollN === 0)
  check('reseed: cycle counted', planB().restarts === 1)
  closeB({ status: 'won', amount: 1, pnl: 0.94 })
  check('reseed: fresh cycle compounds from base again', Math.abs(planB().pot - 1.7) < 1e-9, `pot=${planB().pot}`)

  // ---------- 3. de-risk: half stakes after roll 2, loss keeps the rest ----------
  const c = mkSvc()
  const savedC = c.svc.saveBot({
    name: 'derisk', watchlist: ['EURUSD-OTC'], strategyId: 'rsi-reversion', tf: '5s', kind: 'binary',
    stake: 10, maxOpen: 1, cooldownSec: 0,
    stakePlan: { kind: 'compound', base: 1, rollPct: 100, payoutCap: 70, stopOnLoss: true, periods: 4, deriskAfter: 2, deriskPct: 50 },
  })
  check('derisk bot saved', savedC.ok === true)
  const idC = savedC.bot!.id
  const svcC = c.svc as unknown as {
    onPositionClosed: (p: Position) => void
    stakeFor: (bot: { stakePlan?: unknown }, rt: { pot: number; rollN: number }) => { amount: number; phase: string }
    runtime: Map<string, { pot: number; rollN: number }>
  }
  const botC = () => c.store.listBots().find((x) => x.bot.id === idC)!.bot
  const rtC = () => svcC.runtime.get(idC)!
  const planC = () => botC().planState!
  const stakeNow = () => svcC.stakeFor(botC(), rtC())

  check('stake 1 = full pot (base)', stakeNow().amount === 1 && stakeNow().phase === 'compound', JSON.stringify(stakeNow()))
  svcC.onPositionClosed(mkPos({ status: 'won', amount: 1, pnl: 0.94, note: `bot:${idC}` }))
  check('stake 2 = full pot (1.70)', stakeNow().amount === 1.7, `amt=${stakeNow().amount}`)
  svcC.onPositionClosed(mkPos({ status: 'won', amount: 1.7, pnl: 1.598, note: `bot:${idC}` }))
  check('stake 3 = HALF pot (2.89 -> 1.45) derisk phase', stakeNow().amount === 1.45 && stakeNow().phase === 'derisk', JSON.stringify(stakeNow()))
  svcC.onPositionClosed(mkPos({ status: 'won', amount: 1.45, pnl: 1.45 * 0.7, note: `bot:${idC}` }))
  check('derisk win folds 70% of the half-stake', Math.abs(rtC().pot - 3.91) < 0.011, `pot=${rtC().pot}`)
  check('stake 4 = half of 3.91 -> 1.96', stakeNow().amount === 1.96, `amt=${stakeNow().amount}`)

  // derisk-phase loss burns ONLY the half stake - the ladder's earlier wins stay
  svcC.onPositionClosed(mkPos({ status: 'lost', amount: 1.96, pnl: -1.96, note: `bot:${idC}` }))
  check('derisk loss keeps the banked remainder', Math.abs(rtC().pot - (3.91 - 1.96)) < 0.011, `pot=${rtC().pot}`)
  check('derisk loss halts (stopOnLoss default)', planC().halted === true && planC().complete !== true, JSON.stringify(planC()))

  // ---------- 4. session windows ----------
  check('overlap 14:00 UTC in-session', inSession('overlap', utcDate(14)) === true)
  check('overlap 12:59 UTC out', inSession('overlap', utcDate(12, 59)) === false)
  check('overlap 13:00 start inclusive', inSession('overlap', utcDate(13, 0)) === true)
  check('overlap 16:59 in', inSession('overlap', utcDate(16, 59)) === true)
  check('overlap 17:00 end exclusive', inSession('overlap', utcDate(17, 0)) === false)
  check('london 08:00 in', inSession('london', utcDate(8)) === true)
  check('newyork 21:59 in', inSession('newyork', utcDate(21, 59)) === true)
  check('newyork 22:00 out', inSession('newyork', utcDate(22)) === false)
  check('asia 00:00 in', inSession('asia', utcDate(0)) === true)
  check('asia 09:00 out', inSession('asia', utcDate(9)) === false)
  check('sydney wraps midnight (22:00 in)', inSession('sydney', utcDate(22)) === true)
  check('sydney wraps midnight (05:59 in)', inSession('sydney', utcDate(5, 59)) === true)
  check('sydney gap (12:00 out)', inSession('sydney', utcDate(12)) === false)
  check('all always in-session', inSession('all', utcDate(3)) === true)

  // session parsing: valid kept, bogus dropped to undefined (all sessions)
  const d = mkSvc()
  const savedD = d.svc.saveBot({
    name: 'sess', watchlist: ['EURUSD-OTC'], strategyId: 'rsi-reversion', tf: '5s', kind: 'binary',
    stake: 10, session: 'overlap', expirySec: 900,
    stakePlan: { kind: 'compound', base: 1, payoutCap: 70, periods: 7, deriskAfter: 5, deriskPct: 50 },
  })
  check('session overlap kept', savedD.bot!.session === 'overlap', String(savedD.bot!.session))
  check('expirySec 900 kept', savedD.bot!.expirySec === 900)
  check('plan periods/derisk kept', savedD.bot!.stakePlan?.periods === 7 && savedD.bot!.stakePlan?.deriskAfter === 5 && savedD.bot!.stakePlan?.deriskPct === 50)
  const savedD2 = d.svc.saveBot({ id: savedD.bot!.id, name: 'sess', watchlist: ['EURUSD-OTC'], strategyId: 'rsi-reversion', tf: '5s', kind: 'binary', stake: 10, session: 'bogus' as never, expirySec: 30 })
  check('bogus session dropped -> all', savedD2.bot!.session === undefined, String(savedD2.bot!.session))
  check('expirySec 30 clamped to 60', savedD2.bot!.expirySec === 60, String(savedD2.bot!.expirySec))
  const savedD3 = d.svc.saveBot({ id: savedD.bot!.id, name: 'sess', watchlist: ['EURUSD-OTC'], strategyId: 'rsi-reversion', tf: '5s', kind: 'binary', stake: 10, stakePlan: { kind: 'compound', base: 1, payoutCap: 70, periods: 5000, deriskPct: 150, onComplete: 'bogus' as never } })
  check('periods 5000 clamped to 1000', savedD3.bot!.stakePlan?.periods === 1000, String(savedD3.bot!.stakePlan?.periods))
  check('deriskPct 150 clamped to 100', savedD3.bot!.stakePlan?.deriskPct === 100)
  check('bogus onComplete dropped', savedD3.bot!.stakePlan?.onComplete === undefined)

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
