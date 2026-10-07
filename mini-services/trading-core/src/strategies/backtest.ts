// IQAIR//OS - Backtester
// Walks a strategy over historical candles. Two settlement models:
//  - binary: fixed stake, settles at expiryBars close vs entry (win = stake*payout)
//  - spot:   enters at close, exits on opposite signal / TP / SL / max bars
import type { BacktestResult, BacktestTrade, Candle, StrategyDef, Timeframe } from '../types'
import { defaultParams, getStrategy } from './builtin'
import { sharpeRatio } from '../analytics/quant'
import type { StakePlan } from '../plugins/autopilot'
import { evaluateCustom, type CustomSpec } from './custom'

/** Resolves a strategy id to a StrategyDef, understanding BOTH the static
 * builtin registry (builtin.ts's STRATEGIES) and AI Lab-learned "custom:<id>"
 * specs, which live in the lab plugin's store, not in STRATEGIES. Every
 * engine entry point (backtest/fastBacktest/gridSearch/walkForward/
 * sweepAssets) resolves strategies through this one function so a Lab
 * strategy works identically everywhere a builtin one does, instead of each
 * engine needing its own "is this a custom: id" branch.
 *
 * `customSpec` must be supplied by the caller (resolved from the lab store,
 * e.g. in index.ts's HTTP handlers) when `id` starts with "custom:" - this
 * module has no store access of its own. When it's missing for a custom id,
 * this throws the same "Unknown strategy" error a bad builtin id would,
 * which the HTTP layer turns into a clean 400 instead of a crash. */
export function resolveStrategyDef(id: string, customSpec?: CustomSpec): StrategyDef {
  if (id.startsWith('custom:') && customSpec) {
    return {
      id,
      name: customSpec.name ?? id,
      description: 'Custom AI Lab strategy',
      params: [],
      evaluate: (candles) => evaluateCustom(customSpec, candles),
    }
  }
  const strat = getStrategy(id)
  if (!strat) throw new Error(`Unknown strategy: ${id}`)
  return strat
}

export interface DirectionMetrics {
  trades: number
  wins: number
  losses: number
  winRate: number
  netPnl: number
  expectancy: number
}

/** Splits any trade list by side (call/put) - shared by backtest.ts's own
 * full run AND optimize.ts's fast windowed path (grid search, walk-forward,
 * asset sweep), so every one of those surfaces reports the exact same
 * per-direction shape rather than each growing its own slightly-different
 * copy. A strategy's blended win rate can quietly hide "great on calls, a
 * coin-flip on puts" (or the reverse) - this is what you need to see before
 * picking a dir for it in an AI Lab group, and it matters just as much when
 * comparing optimizer combos, walk-forward folds, or swept assets as it
 * does on a single run. */
export function directionBreakdown(trades: BacktestTrade[]): { call: DirectionMetrics; put: DirectionMetrics } {
  const of = (side: 'call' | 'put'): DirectionMetrics => {
    const sideTrades = trades.filter((t) => t.side === side)
    const sideWins = sideTrades.filter((t) => t.status === 'won').length
    // Task 58 (P1): pushes are no longer "wins with pnl 0" - exclude them
    // from BOTH wins and losses so the per-direction win rate is the honest
    // decided-trade rate (they still count in trades/netPnl/expectancy).
    const sideLosses = sideTrades.filter((t) => t.status === 'lost').length
    const sidePnl = sideTrades.reduce((a, t) => a + t.pnl, 0)
    return {
      trades: sideTrades.length,
      wins: sideWins,
      losses: sideLosses,
      winRate: sideWins + sideLosses ? (sideWins / (sideWins + sideLosses)) * 100 : 0,
      netPnl: sidePnl,
      expectancy: sideTrades.length ? sidePnl / sideTrades.length : 0,
    }
  }
  return { call: of('call'), put: of('put') }
}

export interface BacktestOptions {
  strategy: string
  params?: Record<string, number | string>
  mode?: 'binary' | 'spot'
  payout?: number
  amount?: number
  expiryBars?: number
  startEquity?: number
  tpPct?: number // spot mode take-profit %
  slPct?: number // spot mode stop-loss %
  maxBars?: number // spot mode max holding bars
  warmupBars?: number // indicator warmup guard (default 220 for ema200-class)
  // Task 58 (P1): simulate the LIVE bots' edge-trigger - a persisting signal
  // in the same direction fires ONCE per episode (re-armed only after the
  // signal lapses or flips), and maxOpen/cooldown throttle further. The
  // default (false) preserves the historical every-signal-bar accounting;
  // turn it on for a trade profile a live bot can actually realize.
  edgeTrigger?: boolean
  // Round-trip cost modeling, all opt-in (default 0 - unchanged behavior
  // unless set). spreadPct/slippagePct move the fill price against the side
  // taken before settlement; commissionPct is taken off the stake on every
  // trade regardless of outcome. Mirrors optimize.ts's fastBacktest so the
  // Single-Run lab and the Optimizer/Walk-Forward/Asset-Sweep labs can be
  // compared apples-to-apples when cost modeling is turned on.
  spreadPct?: number
  slippagePct?: number
  commissionPct?: number
  // Replay the SAME compounding ladder the live autopilot runs (stakeFor /
  // onPositionClosed in autopilot.ts) against this backtest's own real
  // win/loss sequence, instead of a flat `amount` per trade - binary mode
  // only (compounding is not a concept in spot mode, which already risks a
  // fixed notional per position). This answers "what would compounding
  // actually have done on this history", as opposed to compound_plan's
  // idealized every-trade-wins ladder projection.
  stakePlan?: StakePlan
  // Required when `strategy` is a "custom:<id>" AI Lab strategy id - the
  // lab store isn't reachable from this module, so the HTTP layer resolves
  // it and passes the spec through. Ignored for builtin strategy ids.
  customSpec?: CustomSpec
  // Manually force which side(s) are taken, instead of the default "take
  // whatever the strategy signals and report both sides blended". 'call'/
  // 'put' skip bars where the strategy signals the other direction (as if
  // that signal were 'none'); 'both' (or unset) preserves current behavior
  // exactly.
  direction?: 'call' | 'put' | 'both'
}

/** Mutable compounding-cycle state, mirroring autopilot.ts's RuntimeState
 * fields (pot/rollN/halted) closely enough to replay the exact same roll
 * math against a backtest's own trade sequence. */
interface CompoundCycle {
  pot: number
  rollN: number
  halted: boolean
}

function compoundStakeFor(plan: StakePlan, cycle: CompoundCycle): number {
  const pot = cycle.pot >= 0.01 ? cycle.pot : plan.base
  const derisk = plan.deriskAfter !== undefined && plan.deriskPct !== undefined && cycle.rollN >= plan.deriskAfter
  const rollPct = derisk ? plan.deriskPct! : (plan.rollPct ?? 100)
  const raw = (pot * rollPct) / 100
  return Math.min(plan.maxStake ?? 5000, pot, Math.max(1, Math.round(raw * 100) / 100))
}

function compoundSettle(plan: StakePlan, cycle: CompoundCycle, won: boolean, stake: number, payout: number): void {
  const base = plan.base
  const working = cycle.pot >= 0.01 ? cycle.pot : base
  if (won) {
    const cap = (plan.payoutCap ?? 70) / 100
    const fold = Math.min(stake * payout, stake * cap)
    cycle.pot = Math.round((working + fold) * 100) / 100
    cycle.rollN += 1
    if (plan.periods && cycle.rollN >= plan.periods) {
      if (plan.onComplete === 'reseed') {
        cycle.pot = 0
        cycle.rollN = 0
      } else {
        cycle.halted = true
      }
    }
  } else {
    cycle.pot = Math.round(Math.max(0, working - stake) * 100) / 100
    cycle.rollN = 0
    if (plan.stopOnLoss !== false) cycle.halted = true
  }
}

export function backtest(candles: Candle[], asset: string, tf: Timeframe, opts: BacktestOptions): BacktestResult {
  const strat = resolveStrategyDef(opts.strategy, opts.customSpec)
  const params = { ...defaultParams(strat), ...(opts.params ?? {}) }
  const wantDir = opts.direction ?? 'both'
  const filterDir = <T extends { direction: 'call' | 'put' | 'none' }>(ev: T): T =>
    wantDir !== 'both' && ev.direction !== 'none' && ev.direction !== wantDir ? ({ ...ev, direction: 'none' } as T) : ev
  const mode = opts.mode ?? 'binary'
  const payout = opts.payout ?? 0.85
  const amount = Math.max(0.01, opts.amount ?? 10)
  const expiryBars = Math.max(1, opts.expiryBars ?? 1)
  let equity = opts.startEquity ?? 1000
  const startEquity = equity
  const costPct = Math.max(0, opts.spreadPct ?? 0) + Math.max(0, opts.slippagePct ?? 0)
  const commissionPct = Math.max(0, opts.commissionPct ?? 0)

  const trades: BacktestTrade[] = []
  const equityCurve: { time: number; value: number }[] = []
  const warmup = Math.max(10, Math.min(candles.length - 20, opts.warmupBars ?? 220)) // ema200 etc. warmup guard
  const rets: number[] = []
  let peak = equity
  let maxDD = 0
  const compoundPlan = mode === 'binary' && opts.stakePlan?.kind === 'compound' ? opts.stakePlan : null
  const cycle: CompoundCycle = { pot: 0, rollN: 0, halted: false }
  let compoundCycles = 0 // how many times stopOnLoss ended a cycle and a fresh one restarted at base

  // -------- binary settlement --------
  let prevEvalDir: 'call' | 'put' | 'none' = 'none' // Task 58: edge-trigger simulation
  if (mode === 'binary') {
    for (let i = warmup; i < candles.length - expiryBars; i++) {
      if (compoundPlan && cycle.halted) {
        // stopOnLoss (default true) ends a cycle just like the live bot - a
        // real bot would stand down for the user to bot_restart, but a
        // backtest has no one to click restart, so it auto-reseeds at base
        // and keeps walking the history (otherwise one early loss would
        // silently end the entire backtest after a handful of trades).
        cycle.pot = 0
        cycle.rollN = 0
        cycle.halted = false
        compoundCycles++
      }
      const evalWindow = candles.slice(0, i + 1)
      const ev = filterDir(strat.evaluate(evalWindow, params))
      // Task 58 (P1): edge-trigger parity with the live bots - a persisting
      // same-direction signal fires once per episode (lapse/flip re-arms)
      if (opts.edgeTrigger) {
        const suppress = ev.direction !== 'none' && ev.direction === prevEvalDir
        prevEvalDir = ev.direction
        if (suppress) continue
      }
      if (ev.direction === 'none') continue
      const rawEntry = candles[i].close
      const entry = ev.direction === 'call' ? rawEntry * (1 + costPct / 100) : rawEntry * (1 - costPct / 100)
      const exitCandle = candles[i + expiryBars]
      const rawStake = compoundPlan ? compoundStakeFor(compoundPlan, cycle) : amount
      const stake = Math.min(rawStake, equity)
      if (stake <= 0) break
      const commission = stake * (commissionPct / 100)
      const won = ev.direction === 'call' ? exitCandle.close > entry : exitCandle.close < entry
      const draw = exitCandle.close === entry
      const pnl = (draw ? 0 : won ? stake * payout : -stake) - commission
      equity += pnl
      rets.push(pnl / Math.max(stake, 0.01))
      if (compoundPlan && !draw) compoundSettle(compoundPlan, cycle, won, stake, payout)
      trades.push({
        ts: exitCandle.time,
        side: ev.direction === 'call' ? 'call' : 'put',
        entry,
        exit: exitCandle.close,
        amount: stake,
        pnl,
        // Task 58 (P1): a draw is a PUSH (stake refunded, pnl 0) - it used to
        // be recorded 'won' and inflated winRate (the drift-follower doc's own
        // measured ~41% -> ~59% inflation on flat-heavy feeds)
        status: draw ? 'push' : won ? 'won' : 'lost',
      })
      if (equity > peak) peak = equity
      const dd = peak - equity
      if (dd > maxDD) maxDD = dd
      equityCurve.push({ time: exitCandle.time, value: equity })
    }
  } else {
    // -------- spot settlement --------
    const tpPct = opts.tpPct ?? 0.4
    const slPct = opts.slPct ?? 0.25
    const maxBars = opts.maxBars ?? 24
    let open: { side: 'call' | 'put'; entry: number; bars: number; ts: number } | null = null
    for (let i = warmup; i < candles.length; i++) {
      const candle = candles[i]
      if (open) {
        open.bars++
        const movePct = ((candle.close - open.entry) / open.entry) * 100 * (open.side === 'call' ? 1 : -1)
        const hitTP = movePct >= tpPct
        const hitSL = movePct <= -slPct
        const evNow =
          hitTP || hitSL || open.bars >= maxBars
            ? { direction: 'none' as const, score: 0, notes: '' }
            : filterDir(strat.evaluate([...candles.slice(0, i + 1)], params))
        const flipped = evNow.direction !== 'none' && evNow.direction !== open.side
        if (hitTP || hitSL || open.bars >= maxBars || flipped) {
          const rawExit = candle.close
          // Exit fill also moves against the position (selling into the bid /
          // buying into the ask), same direction of unfavorability as entry.
          const exit = open.side === 'call' ? rawExit * (1 - costPct / 100) : rawExit * (1 + costPct / 100)
          const direction = open.side === 'call' ? 1 : -1
          const commission = amount * (commissionPct / 100)
          const pnl = ((exit - open.entry) / open.entry) * amount * direction - commission
          equity += pnl
          rets.push(pnl / Math.max(amount, 0.01))
          trades.push({
            ts: candle.time,
            side: open.side,
            entry: open.entry,
            exit,
            amount,
            pnl,
            status: pnl >= 0 ? 'won' : 'lost',
          })
          if (equity > peak) peak = equity
          const dd = peak - equity
          if (dd > maxDD) maxDD = dd
          equityCurve.push({ time: candle.time, value: equity })
          open = null
        }
        continue
      }
      const ev = filterDir(strat.evaluate([...candles.slice(0, i + 1)], params))
      if (ev.direction !== 'none' && equity >= amount) {
        open = { side: ev.direction, entry: candle.close, bars: 0, ts: candle.time }
      }
    }
  }

  const wins = trades.filter((t) => t.status === 'won').length
  const losses = trades.filter((t) => t.status === 'lost').length
  const grossWin = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0)
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0))
  // Task 58 (P3): Sharpe was annualized on the BAR calendar while `rets` are
  // PER-TRADE returns - a strategy trading 5% of bars had its Sharpe scaled
  // up by the full bar calendar. Annualize on the realized trade cadence
  // instead (mean inter-trade gap), which is what per-trade returns imply.
  const tsSorted = trades.map((t) => t.ts).sort((a, b) => a - b)
  let meanGapSec = 0
  if (tsSorted.length > 1) {
    let gaps = 0
    for (let i = 1; i < tsSorted.length; i++) gaps += tsSorted[i] - tsSorted[i - 1]
    meanGapSec = gaps / (tsSorted.length - 1)
  }
  const periodsPerYear = meanGapSec > 0 ? (365 * 24 * 3600) / meanGapSec : 252

  const byDirection = directionBreakdown(trades)

  return {
    strategy: strat.id,
    asset,
    tf,
    mode,
    params,
    candlesTested: Math.max(0, candles.length - warmup),
    trades,
    equityCurve,
    metrics: {
      totalTrades: trades.length,
      wins,
      losses,
      winRate: wins + losses ? (wins / (wins + losses)) * 100 : 0,
      netPnl: equity - startEquity,
      profitFactor: grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss,
      maxDrawdown: maxDD,
      maxDrawdownPct: startEquity > 0 ? (maxDD / startEquity) * 100 : 0,
      sharpe: sharpeRatio(rets, periodsPerYear),
      expectancy: trades.length ? (equity - startEquity) / trades.length : 0,
      finalEquity: equity,
      startEquity,
      byDirection,
    },
    ...(compoundPlan ? { compoundCycles } : {}),
  }
}
