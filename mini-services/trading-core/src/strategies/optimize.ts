// IQAIR//OS - Research engine: grid optimization, walk-forward validation, asset sweeps
// Fast windowed evaluation paths for the Strategy Lab. Binary settlement only (what
// autopilot bots trade). Results for the finalists are re-verified through the full
// backtester so the numbers the user acts on match the Single-run lab exactly.
import type { BacktestResult, BacktestTrade, Candle, StrategyDef, Timeframe } from '../types'
import { defaultParams, getStrategy } from './builtin'
import { backtest } from './backtest'
import { sharpeRatio } from '../analytics/quant'

export type Objective = 'netPnl' | 'sharpe' | 'profitFactor' | 'winRate' | 'expectancy'
export type SweepSpec = Record<string, { from: number; to: number; step: number }>

export interface FastMetrics {
  totalTrades: number
  wins: number
  winRate: number
  netPnl: number
  profitFactor: number
  maxDrawdownPct: number
  sharpe: number
  expectancy: number
  finalEquity: number
}

export interface OptRow {
  params: Record<string, number | string>
  metrics: FastMetrics
  score: number
  rank: number
  verified: boolean // re-run through the full backtester
}

export interface HeatmapData {
  xKey: string
  yKey: string
  xs: number[]
  ys: number[]
  cells: { x: number; y: number; value: number | null; trades: number; winRate: number }[]
}

export interface GridSearchResult {
  strategy: string
  asset: string
  tf: Timeframe
  objective: Objective
  totalCombos: number
  evaluated: number
  skipped: number // combos that bankrupted or hit the trade guard
  elapsedMs: number
  ranked: OptRow[]
  heatmap: HeatmapData | null
  best: OptRow | null
}

export interface WalkForwardFold {
  fold: number
  isBars: number
  oosBars: number
  bestParams: Record<string, number | string>
  is: FastMetrics
  oos: FastMetrics
}

export interface WalkForwardResult {
  strategy: string
  asset: string
  tf: Timeframe
  objective: Objective
  folds: WalkForwardFold[]
  oos: FastMetrics // OOS aggregate across folds
  isNet: number
  oosNet: number
  efficiencyPct: number // oosNet / isNet * 100
  foldsProfitable: number
  bestParams: Record<string, number | string> // params of the most consistent fold (best OOS score)
  elapsedMs: number
}

export interface SweepRow {
  asset: string
  category: string
  open: boolean
  payout: number
  metrics: FastMetrics
  score: number
}

export interface SweepResult {
  strategy: string
  tf: Timeframe
  params: Record<string, number | string>
  objective: Objective
  tested: number
  skipped: number
  elapsedMs: number
  rows: SweepRow[]
}

// ---------- param warmup profile ----------
// Strategies that fit a Markov chain over 500+ bars need long prefixes; the rest
// converge quickly. Used to pick the evaluation window and fold sizes.
function strategyWarmup(id: string): number {
  if (id === 'markov-edge' || id === 'confluence-core') return 560
  if (id === 'kalman-ou-reversion') return 340 // OU fits need their full estimation window before any signal
  if (id === 'ema-trend') return 180
  return 80
}

// ---------- grid expansion ----------
export function expandGrid(strat: StrategyDef, sweep: SweepSpec, maxCombos: number): {
  combos: Record<string, number | string>[]
  total: number
  truncated: boolean
} {
  const keys: string[] = []
  const valueLists: number[][] = []
  const base = defaultParams(strat)

  for (const p of strat.params) {
    const spec = sweep[p.key]
    if (!spec) continue
    const from = Math.min(spec.from, spec.to)
    const to = Math.max(spec.from, spec.to)
    let step = Math.max(spec.step, 0.0001)
    const vals: number[] = []
    for (let v = from; v <= to + step * 0.001; v += step) {
      vals.push(Number(v.toFixed(6)))
      if (vals.length > 64) break
    }
    if (vals.length) {
      keys.push(p.key)
      valueLists.push(vals)
    }
  }

  let total = 1
  for (const l of valueLists) total *= l.length
  const cap = Math.max(4, maxCombos)
  const truncated = total > cap
  const combos: Record<string, number | string>[] = []

  if (!truncated) {
    // full cartesian product
    const walk = (idx: number, acc: Record<string, number | string>) => {
      if (idx === keys.length) {
        combos.push({ ...acc })
        return
      }
      for (const v of valueLists[idx]) walk(idx + 1, { ...acc, [keys[idx]]: v })
    }
    walk(0, {})
  } else {
    // random sample without replacement when the full grid exceeds the cap
    const stride = keys.map((_, i) => valueLists[i].length)
    const seen = new Set<string>()
    let guard = cap * 12
    while (combos.length < cap && guard-- > 0) {
      const pick = stride.map((n) => Math.floor(Math.random() * n))
      const sig = pick.join(',')
      if (seen.has(sig)) continue
      seen.add(sig)
      const combo: Record<string, number | string> = {}
      pick.forEach((pi, ki) => (combo[keys[ki]] = valueLists[ki][pi]))
      combos.push(combo)
    }
  }
  return { combos, total, truncated }
}

// ---------- fast windowed backtest (binary settlement) ----------
const emptyMetrics = (): FastMetrics => ({
  totalTrades: 0,
  wins: 0,
  winRate: 0,
  netPnl: 0,
  profitFactor: 0,
  maxDrawdownPct: 0,
  sharpe: 0,
  expectancy: 0,
  finalEquity: 0,
})

export function fastBacktest(
  candles: Candle[],
  strategyId: string,
  params: Record<string, number | string>,
  opts: { payout?: number; amount?: number; expiryBars?: number; startEquity?: number; warmup?: number } = {}
): FastMetrics {
  const strat = getStrategy(strategyId)
  if (!strat) throw new Error(`Unknown strategy: ${strategyId}`)
  const payout = opts.payout ?? 0.85
  const amount = Math.max(0.01, opts.amount ?? 10)
  const expiryBars = Math.max(1, opts.expiryBars ?? 1)
  const warmup = Math.max(20, opts.warmup ?? strategyWarmup(strategyId))
  let equity = opts.startEquity ?? 1000
  const startEquity = equity

  const window = Math.min(candles.length, Math.max(warmup + 120, 700))
  const trades: BacktestTrade[] = []
  const rets: number[] = []
  let peak = equity
  let maxDD = 0
  let wins = 0
  let grossWin = 0
  let grossLoss = 0

  const stop = candles.length - expiryBars
  for (let i = warmup; i < stop; i++) {
    const win = candles.slice(Math.max(0, i - window + 1), i + 1)
    const ev = strat.evaluate(win, params)
    if (ev.direction === 'none') continue
    const entry = candles[i].close
    const exitCandle = candles[i + expiryBars]
    const stake = Math.min(amount, equity)
    if (stake <= 0) break
    const won = ev.direction === 'call' ? exitCandle.close > entry : exitCandle.close < entry
    const draw = exitCandle.close === entry
    const pnl = draw ? 0 : won ? stake * payout : -stake
    equity += pnl
    if (pnl > 0) {
      wins++
      grossWin += pnl
    } else if (pnl < 0) {
      grossLoss += -pnl
    }
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
    if (equity <= amount * 0.5) break // bankrupt combo, stop wasting cycles
  }

  const total = trades.length
  const avgTfSec = candles.length > 1 ? candles[candles.length - 1].time - candles[candles.length - 2].time : 60
  const periodsPerYear = (365 * 24 * 3600) / Math.max(1, avgTfSec)
  return {
    totalTrades: total,
    wins,
    winRate: total ? (wins / total) * 100 : 0,
    netPnl: equity - startEquity,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss,
    maxDrawdownPct: startEquity > 0 ? (maxDD / startEquity) * 100 : 0,
    sharpe: sharpeRatio(rets, periodsPerYear),
    expectancy: total ? (equity - startEquity) / total : 0,
    finalEquity: equity,
  }
}

function scoreOf(m: FastMetrics, objective: Objective, minTrades: number): number {
  if (m.totalTrades < minTrades) return -Infinity
  switch (objective) {
    case 'netPnl':
      return m.netPnl
    case 'sharpe':
      return m.sharpe
    case 'profitFactor':
      return Math.min(m.profitFactor, 10) // cap so 1-win combos don't dominate
    case 'winRate':
      return m.winRate
    case 'expectancy':
      return m.expectancy
  }
}

function heatmapFrom(
  keys: string[],
  valueLists: Map<string, Set<number>>,
  rows: { params: Record<string, number | string>; metrics: FastMetrics; score: number }[],
  objective: Objective
): HeatmapData | null {
  if (keys.length === 0) return null
  const sortedKeys = [...keys].sort((a, b) => (valueLists.get(b)?.size ?? 0) - (valueLists.get(a)?.size ?? 0))
  const xKey = sortedKeys[0]
  const yKey = sortedKeys[1] ?? sortedKeys[0]
  const xs = [...(valueLists.get(xKey) ?? [])].sort((a, b) => a - b)
  const ys = xKey === yKey ? [0] : [...(valueLists.get(yKey) ?? [])].sort((a, b) => a - b)
  const buckets = new Map<string, { sum: number; n: number; trades: number; wins: number }>()
  for (const r of rows) {
    const x = Number(r.params[xKey])
    const y = xKey === yKey ? 0 : Number(r.params[yKey])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const k = `${x}|${y}`
    const b = buckets.get(k) ?? { sum: 0, n: 0, trades: 0, wins: 0 }
    if (Number.isFinite(r.score)) {
      b.sum += r.score
      b.n++
    }
    b.trades += r.metrics.totalTrades
    b.wins += r.metrics.wins
    buckets.set(k, b)
  }
  const cells = [...buckets.entries()].map(([k, b]) => {
    const [x, y] = k.split('|').map(Number)
    return { x, y: xKey === yKey ? 0 : y, value: b.n ? b.sum / b.n : null, trades: b.trades, winRate: b.trades ? (b.wins / b.trades) * 100 : 0 }
  })
  return { xKey, yKey: xKey === yKey ? xKey : yKey, xs, ys, cells }
}

// ---------- grid search ----------
export interface GridSearchOptions {
  strategy: string
  sweep: SweepSpec
  objective?: Objective
  minTrades?: number
  maxCombos?: number
  top?: number
  payout?: number
  amount?: number
  expiryBars?: number
  startEquity?: number
}

export function gridSearch(candles: Candle[], asset: string, tf: Timeframe, opts: GridSearchOptions): GridSearchResult {
  const strat = getStrategy(opts.strategy)
  if (!strat) throw new Error(`Unknown strategy: ${opts.strategy}`)
  const objective = opts.objective ?? 'netPnl'
  const minTrades = Math.max(1, opts.minTrades ?? 8)
  const top = Math.max(1, Math.min(30, opts.top ?? 20))
  const common = { payout: opts.payout, amount: opts.amount, expiryBars: opts.expiryBars, startEquity: opts.startEquity }
  const sweptKeys = Object.keys(opts.sweep).filter((k) => strat.params.some((p) => p.key === k))

  const t0 = Date.now()
  const { combos, total, truncated } = expandGrid(strat, opts.sweep, opts.maxCombos ?? 240)
  const valueLists = new Map<string, Set<number>>()
  for (const k of sweptKeys) valueLists.set(k, new Set())

  const scored: { params: Record<string, number | string>; metrics: FastMetrics; score: number }[] = []
  let skipped = 0
  for (const combo of combos) {
    const m = fastBacktest(candles, strat.id, combo, common)
    for (const k of sweptKeys) {
      const v = Number(combo[k])
      if (Number.isFinite(v)) valueLists.get(k)!.add(v)
    }
    const score = scoreOf(m, objective, minTrades)
    if (!Number.isFinite(score)) skipped++
    scored.push({ params: combo, metrics: m, score })
  }

  scored.sort((a, b) => b.score - a.score || b.metrics.totalTrades - a.metrics.totalTrades)

  // re-verify the finalists through the full backtester so numbers match the Single lab
  const ranked: OptRow[] = []
  const head = scored.slice(0, top)
  for (let i = 0; i < head.length; i++) {
    const h = head[i]
    let metrics = h.metrics
    let verified = false
    if (i < 3 && Number.isFinite(h.score)) {
      try {
        const full: BacktestResult = backtest(candles, asset, tf, {
          strategy: strat.id,
          params: h.params,
          mode: 'binary',
          payout: opts.payout ?? 0.85,
          amount: opts.amount ?? 10,
          expiryBars: opts.expiryBars ?? 1,
          startEquity: opts.startEquity ?? 1000,
        })
        const fm: FastMetrics = {
          totalTrades: full.metrics.totalTrades,
          wins: full.metrics.wins,
          winRate: full.metrics.winRate,
          netPnl: full.metrics.netPnl,
          profitFactor: full.metrics.profitFactor,
          maxDrawdownPct: full.metrics.maxDrawdownPct,
          sharpe: full.metrics.sharpe,
          expectancy: full.metrics.expectancy,
          finalEquity: full.metrics.finalEquity,
        }
        const fs = scoreOf(fm, objective, minTrades)
        if (Number.isFinite(fs)) {
          metrics = fm
          verified = true
        }
      } catch {
        // keep fast metrics
      }
    }
    ranked.push({ params: h.params, metrics, score: verified ? scoreOf(metrics, objective, minTrades) : h.score, rank: i + 1, verified })
  }
  ranked.sort((a, b) => b.score - a.score)
  ranked.forEach((r, i) => (r.rank = i + 1))

  const heatmap = truncated || scored.length ? heatmapFrom(sweptKeys, valueLists, scored, objective) : null

  return {
    strategy: strat.id,
    asset,
    tf,
    objective,
    totalCombos: total,
    evaluated: scored.length,
    skipped,
    elapsedMs: Date.now() - t0,
    ranked,
    heatmap: sweptKeys.length >= 1 ? heatmap : null,
    best: ranked[0] ?? null,
  }
}

// ---------- walk-forward ----------
export interface WalkForwardOptions extends GridSearchOptions {
  folds?: number
  isRatio?: number
}

export function walkForward(candles: Candle[], asset: string, tf: Timeframe, opts: WalkForwardOptions): WalkForwardResult {
  const strat = getStrategy(opts.strategy)
  if (!strat) throw new Error(`Unknown strategy: ${opts.strategy}`)
  const objective = opts.objective ?? 'netPnl'
  const minTrades = Math.max(1, opts.minTrades ?? 6)
  const folds = Math.max(2, Math.min(5, Math.round(opts.folds ?? 3)))
  const isRatio = Math.max(0.5, Math.min(0.85, opts.isRatio ?? 0.7))
  const common = { payout: opts.payout, amount: opts.amount, expiryBars: opts.expiryBars, startEquity: opts.startEquity }
  const warmup = strategyWarmup(strat.id)

  const t0 = Date.now()
  const usable = candles.length - warmup
  const foldSize = Math.floor(usable / folds)
  if (foldSize < 140) {
    throw new Error(
      `history too short for ${folds} walk-forward folds on ${strat.id} (needs ~${(warmup + 140 * folds).toFixed(0)} candles, have ${candles.length}) — try fewer folds or a faster-warming strategy`
    )
  }
  const { combos } = expandGrid(strat, opts.sweep, opts.maxCombos ?? 120)

  const outFolds: WalkForwardFold[] = []
  let isNet = 0
  const oosMetrics: FastMetrics[] = []
  let bestFoldScore = -Infinity
  let bestParams: Record<string, number | string> = strat.params.reduce((a, p) => ({ ...a, [p.key]: p.default }), {} as Record<string, number | string>)

  for (let f = 0; f < folds; f++) {
    const isStart = warmup + f * foldSize
    const isBars = Math.max(80, Math.floor(foldSize * isRatio))
    const oosStart = isStart + isBars
    const oosEnd = Math.min(candles.length, isStart + foldSize)
    const isSlice = candles.slice(isStart, isStart + isBars)
    const oosSlice = candles.slice(oosStart, oosEnd)
    if (isSlice.length < 80 || oosSlice.length < 40) continue

    // in-sample: pick the best params on this fold
    let bestScore = -Infinity
    let bestCombo = combos[0] ?? ({} as Record<string, number | string>)
    let bestIsMetrics = emptyMetrics()
    for (const combo of combos) {
      const m = fastBacktest(isSlice, strat.id, combo, { ...common, warmup: Math.min(60, Math.floor(isSlice.length * 0.2)), startEquity: 1000 })
      const s = scoreOf(m, objective, minTrades)
      if (Number.isFinite(s) && s > bestScore) {
        bestScore = s
        bestCombo = combo
        bestIsMetrics = m
      }
    }
    if (!Number.isFinite(bestScore)) {
      // no combo passed the trade guard on this fold — record zeros
      const zero = emptyMetrics()
      outFolds.push({ fold: f + 1, isBars: isSlice.length, oosBars: oosSlice.length, bestParams: bestCombo, is: bestIsMetrics, oos: zero })
      oosMetrics.push(zero)
      continue
    }

    // out-of-sample: settle the chosen params with the REAL settlement engine.
    // Slow-warming strategies (OU fits, Markov chains) cannot produce signals
    // off a cold 40-bar prefix - extend the slice BACKWARDS over already-seen
    // history for estimation (no lookahead: trades only fire after the warmup
    // guard, i.e. strictly inside the true OOS region).
    const oosWarmup = Math.min(strategyWarmup(strat.id), isStart)
    const oosFull = backtest(candles.slice(Math.max(0, oosStart - oosWarmup), oosEnd), asset, tf, {
      strategy: strat.id,
      params: bestCombo,
      mode: 'binary',
      payout: opts.payout ?? 0.85,
      amount: opts.amount ?? 10,
      expiryBars: opts.expiryBars ?? 1,
      startEquity: 1000,
      warmupBars: oosWarmup,
    })
    const oosM: FastMetrics = {
      totalTrades: oosFull.metrics.totalTrades,
      wins: oosFull.metrics.wins,
      winRate: oosFull.metrics.winRate,
      netPnl: oosFull.metrics.netPnl,
      profitFactor: oosFull.metrics.profitFactor,
      maxDrawdownPct: oosFull.metrics.maxDrawdownPct,
      sharpe: oosFull.metrics.sharpe,
      expectancy: oosFull.metrics.expectancy,
      finalEquity: oosFull.metrics.finalEquity,
    }
    outFolds.push({ fold: f + 1, isBars: isSlice.length, oosBars: oosSlice.length, bestParams: bestCombo, is: bestIsMetrics, oos: oosM })
    oosMetrics.push(oosM)
    isNet += bestIsMetrics.netPnl
    const oosScore = scoreOf(oosM, objective, 1)
    if (Number.isFinite(oosScore) && oosScore > bestFoldScore) {
      bestFoldScore = oosScore
      bestParams = bestCombo
    }
  }

  // OOS aggregate (per-fold net summed on equal start equity)
  const agg = emptyMetrics()
  for (const m of oosMetrics) {
    agg.totalTrades += m.totalTrades
    agg.wins += m.wins
    agg.netPnl += m.netPnl
    agg.finalEquity += m.finalEquity - 1000
  }
  agg.winRate = agg.totalTrades ? (agg.wins / agg.totalTrades) * 100 : 0
  agg.expectancy = agg.totalTrades ? agg.netPnl / agg.totalTrades : 0
  const grossPos = oosMetrics.reduce((a, m) => a + Math.max(0, m.netPnl), 0)
  const grossNeg = Math.abs(oosMetrics.reduce((a, m) => a + Math.min(0, m.netPnl), 0))
  agg.profitFactor = grossNeg > 0 ? grossPos / grossNeg : grossPos > 0 ? 99 : 0
  agg.maxDrawdownPct = Math.max(0, ...oosMetrics.map((m) => m.maxDrawdownPct))
  agg.sharpe = oosMetrics.length ? oosMetrics.reduce((a, m) => a + m.sharpe, 0) / oosMetrics.length : 0

  const foldsProfitable = oosMetrics.filter((m) => m.netPnl > 0).length
  return {
    strategy: strat.id,
    asset,
    tf,
    objective,
    folds: outFolds,
    oos: agg,
    isNet,
    oosNet: agg.netPnl,
    efficiencyPct: isNet !== 0 ? (agg.netPnl / Math.abs(isNet)) * 100 : 0,
    foldsProfitable,
    bestParams,
    elapsedMs: Date.now() - t0,
  }
}

// ---------- asset sweep ----------
export interface AssetSweepOptions {
  strategy: string
  params?: Record<string, number | string>
  objective?: Objective
  minTrades?: number
  payout?: number
  amount?: number
  expiryBars?: number
  startEquity?: number
  maxAssets?: number
}

export interface CandleFetcher {
  (asset: string): Candle[]
}

export function sweepAssets(
  assets: { ticker: string; category: string; open: boolean; payout: number }[],
  fetchCandles: CandleFetcher,
  tf: Timeframe,
  opts: AssetSweepOptions
): SweepResult {
  const strat = getStrategy(opts.strategy)
  if (!strat) throw new Error(`Unknown strategy: ${opts.strategy}`)
  const objective = opts.objective ?? 'netPnl'
  const minTrades = Math.max(1, opts.minTrades ?? 8)
  const base = defaultParams(strat)
  const params = { ...base, ...(opts.params ?? {}) }
  const t0 = Date.now()
  const rows: SweepRow[] = []
  let skipped = 0
  const cap = Math.max(1, Math.min(80, opts.maxAssets ?? 40))

  for (const a of assets.slice(0, cap)) {
    try {
      const candles = fetchCandles(a.ticker)
      if (candles.length < 300) {
        skipped++
        continue
      }
      const m = fastBacktest(candles, strat.id, params, {
        payout: opts.payout,
        amount: opts.amount,
        expiryBars: opts.expiryBars,
        startEquity: opts.startEquity,
      })
      const score = scoreOf(m, objective, minTrades)
      rows.push({ asset: a.ticker, category: a.category, open: a.open, payout: a.payout, metrics: m, score })
    } catch {
      skipped++
    }
  }

  rows.sort((a, b) => b.score - a.score || b.metrics.netPnl - a.metrics.netPnl)
  return {
    strategy: strat.id,
    tf,
    params,
    objective,
    tested: rows.length,
    skipped,
    elapsedMs: Date.now() - t0,
    rows,
  }
}
