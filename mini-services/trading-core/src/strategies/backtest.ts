// IQAIR//OS - Backtester
// Walks a strategy over historical candles. Two settlement models:
//  - binary: fixed stake, settles at expiryBars close vs entry (win = stake*payout)
//  - spot:   enters at close, exits on opposite signal / TP / SL / max bars
import type { BacktestResult, BacktestTrade, Candle, Timeframe } from '../types'
import { defaultParams, getStrategy } from './builtin'
import { sharpeRatio } from '../analytics/quant'

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

  const trades: BacktestTrade[] = []
  const equityCurve: { time: number; value: number }[] = []
  const warmup = Math.max(10, Math.min(candles.length - 20, opts.warmupBars ?? 220)) // ema200 etc. warmup guard
  const rets: number[] = []
  let peak = equity
  let maxDD = 0

  // -------- binary settlement --------
  if (mode === 'binary') {
    for (let i = warmup; i < candles.length - expiryBars; i++) {
      const evalWindow = candles.slice(0, i + 1)
      const ev = strat.evaluate(evalWindow, params)
      if (ev.direction === 'none') continue
      const entry = candles[i].close
      const exitCandle = candles[i + expiryBars]
      const stake = Math.min(amount, equity)
      if (stake <= 0) break
      const won = ev.direction === 'call' ? exitCandle.close > entry : exitCandle.close < entry
      const draw = exitCandle.close === entry
      const pnl = draw ? 0 : won ? stake * payout : -stake
      equity += pnl
      rets.push(pnl / Math.max(stake, 0.01))
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
          const exit = candle.close
          const direction = open.side === 'call' ? 1 : -1
          const pnl = (exit - open.entry) / open.entry * amount * direction
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
  }
}
