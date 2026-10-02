// IQAIR//OS - Backtester
// Walks a strategy over historical candles. Two settlement models:
//  - binary: fixed stake, settles at expiryBars close vs entry (win = stake*payout)
//  - spot:   enters at close, exits on opposite signal / TP / SL / max bars
import type { BacktestResult, BacktestTrade, Candle, Timeframe } from '../types'
import { defaultParams, getStrategy } from './builtin'
import { sharpeRatio } from '../analytics/quant'
import type { StakePlan } from '../plugins/autopilot'

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
  const strat = getStrategy(opts.strategy)
  if (!strat) throw new Error(`Unknown strategy: ${opts.strategy}`)
  const params = { ...defaultParams(strat), ...(opts.params ?? {}) }
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
      const ev = strat.evaluate(evalWindow, params)
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
        status: draw ? 'won' : won ? 'won' : 'lost',
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
            : strat.evaluate([...candles.slice(0, i + 1)], params)
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
      const ev = strat.evaluate([...candles.slice(0, i + 1)], params)
      if (ev.direction !== 'none' && equity >= amount) {
        open = { side: ev.direction, entry: candle.close, bars: 0, ts: candle.time }
      }
    }
  }

  const wins = trades.filter((t) => t.status === 'won').length
  const losses = trades.length - wins
  const grossWin = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0)
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0))
  const avgTfSec = candles.length > 1 ? candles[candles.length - 1].time - candles[candles.length - 2].time : 60
  const periodsPerYear = (365 * 24 * 3600) / Math.max(1, avgTfSec)

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
      winRate: trades.length ? (wins / trades.length) * 100 : 0,
      netPnl: equity - startEquity,
      profitFactor: grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss,
      maxDrawdown: maxDD,
      maxDrawdownPct: startEquity > 0 ? (maxDD / startEquity) * 100 : 0,
      sharpe: sharpeRatio(rets, periodsPerYear),
      expectancy: trades.length ? (equity - startEquity) / trades.length : 0,
      finalEquity: equity,
      startEquity,
    },
    ...(compoundPlan ? { compoundCycles } : {}),
  }
}
