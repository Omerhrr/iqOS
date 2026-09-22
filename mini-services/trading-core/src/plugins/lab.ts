// IQAIR//OS - Strategy Lab plugin (AI learning agent)
// Mines a pair's candle history for edge-bearing events across the full
// pattern vocabulary - candlestick formations, bar expansions, Heiken Ashi
// structures, line/structural breaks and a parametric indicator family - then
// composes the survivors into a CustomSpec the autopilot can trade as
// strategyId "custom:<id>". Every learned strategy is backed by measured
// stats (samples, win rate, edge) and a binary backtest with an honest
// holdout split, so the numbers the user sees are the numbers the lab got.

import type { Candle, Side, Timeframe } from '../types'
import type { KernelContext, Plugin } from '../kernel'
import type { MarketDataService } from './market-data'
import { Store } from '../store'
import {
  buildCtx,
  evaluateCustom,
  labelOf,
  normalizeSpec,
  prepareSignal,
  slugify,
  type CustomSpec,
  type EvalCtx,
  type SignalDef,
} from '../strategies/custom'
import { detectPatterns } from '../analytics/patterns'

export interface LearnOptions {
  asset: string
  tf: Timeframe
  bars?: number // history to learn from (default 1200, cap 2200)
  horizon?: number // bars ahead the outcome is measured (default 1)
  minSamples?: number // min occurrences for a signal to qualify (default 40)
  minEdge?: number // min win-rate edge vs 50% in points (default 2)
  maxSignals?: number // signals composed into the spec (default 8)
  payout?: number // binary payout used in the backtest (default 0.7 = house cap)
  amount?: number // backtest stake (default 10)
  name?: string // spec name override
}

export interface SignalStat {
  key: string
  kind: SignalDef['kind']
  label: string
  dir: Side
  n: number
  wins: number
  winRate: number // %
  edgePts: number // winRate - 50
  weight: number
  selected: boolean
}

export interface SimMetrics {
  trades: number
  wins: number
  losses: number
  winRate: number // %
  netPnl: number
  profitFactor: number
  maxDrawdown: number
  expectancy: number
}

export interface LearnResult {
  ok: boolean
  asset: string
  tf: Timeframe
  candlesTested: number
  horizon: number
  minSamples: number
  minEdge: number
  breakevenWinRate: number // % needed at the given payout to break even
  signals: SignalStat[] // measured candidates (top 24 by edge, selected flagged)
  spec: CustomSpec | null
  calibration: { thresholds: { minScore: number; trades: number; winRate: number }[]; chosen: number; votes: number }
  backtest: SimMetrics | null
  holdout: SimMetrics | null
  note: string
}

export interface LabRow {
  id: string
  spec: CustomSpec
  asset: string
  tf: string
  stats: { backtest?: SimMetrics; holdout?: SimMetrics; breakeven?: number } | null
  createdTs: number
  updatedTs: number
}

/** Direction-neutral / indecision formations never become directional signals. */
const CANDLE_SKIP = new Set(['Doji', 'Spinning Top', 'High Wave', 'Inside Bar'])

/** Map<lowercase pattern name, Side> per bar - the candlestick family's
 * per-bar activity (context windows make it non-vectorizable). */
type CandleHits = Map<string, Side>[]

interface Candidate {
  key: string
  kind: SignalDef['kind']
  label: string
  dir: Side
  family: string
  def: SignalDef
  test: (i: number) => boolean
}

export class StrategyLabService {
  private ctx!: KernelContext
  private store!: Store
  private market!: MarketDataService

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.store = ctx.use<Store>('store')
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('lab', 'strategy lab online (pattern mining, edge stats, spec synthesis, holdout backtests)')
  }

  // ---------- learning pipeline ----------

  learn(opts: LearnOptions): LearnResult {
    const asset = String(opts.asset ?? this.market.activeAsset).toUpperCase()
    const tf = opts.tf as Timeframe
    const horizon = Math.max(1, Math.min(10, Math.round(opts.horizon ?? 1)))
    const minSamples = Math.max(10, Math.round(opts.minSamples ?? 40))
    const minEdge = Math.max(0.5, Math.min(20, Number(opts.minEdge ?? 2)))
    const maxSignals = Math.max(2, Math.min(12, Math.round(opts.maxSignals ?? 8)))
    const payout = Math.max(0.5, Math.min(0.95, Number(opts.payout ?? 0.7)))
    const amount = Math.max(1, Number(opts.amount ?? 10))
    const bars = Math.max(300, Math.min(2200, Math.round(opts.bars ?? 1200)))

    const candles = this.market.getCandlesDeep(asset, tf, bars)
    if (candles.length < 220) throw new Error(`not enough history for ${asset} ${tf} (${candles.length} bars, need 220+)`)
    const n = candles.length
    const ctx = buildCtx(candles)
    const warm = 30

    // ---- candidates from the parametric vocabulary ----
    const candidates: Candidate[] = CANDIDATE_SIGNALS.map((def) => ({
      key: candidateKeyOf(def),
      kind: def.kind,
      label: labelOf(def),
      dir: def.dir,
      family: familyOf(def),
      def,
      test: prepareSignal(def, ctx),
    }))

    // ---- candlestick family: per-bar scan ----
    const candleHits = scanCandleHits(candles)
    const candleDefs = new Map<string, { name: string; dir: Side }>()
    for (let i = warm; i < n; i++) {
      for (const [name, dir] of candleHits[i]) {
        if (!candleDefs.has(name)) candleDefs.set(name, { name: displayName(name), dir })
      }
    }
    for (const { name, dir } of candleDefs.values()) {
      const def: SignalDef = { kind: 'candle', name, dir, weight: 10 }
      candidates.push({
        key: candidateKeyOf(def),
        kind: 'candle',
        label: name,
        dir,
        family: `candle:${name.toLowerCase()}`,
        def,
        test: (i) => candleHits[i]?.get(name.toLowerCase()) === dir,
      })
    }

    // ---- measure edge: did price move in the implied dir `horizon` bars later? ----
    const close = ctx.close
    const stats = new Map<string, { n: number; wins: number }>()
    const end = n - horizon
    for (let i = warm; i < end; i++) {
      for (const c of candidates) {
        if (!c.test(i)) continue
        const s = stats.get(c.key) ?? { n: 0, wins: 0 }
        s.n += 1
        const up = close[i + horizon] > close[i]
        const dn = close[i + horizon] < close[i]
        if (c.dir === 'call' ? up : dn) s.wins += 1
        stats.set(c.key, s)
      }
    }

    // ---- rank + select (best edge per family keeps the ensemble diverse) ----
    const measured: SignalStat[] = []
    for (const c of candidates) {
      const s = stats.get(c.key)
      if (!s || s.n === 0) continue
      const winRate = (s.wins / s.n) * 100
      measured.push({
        key: c.key,
        kind: c.kind,
        label: c.label,
        dir: c.dir,
        n: s.n,
        wins: s.wins,
        winRate: round2(winRate),
        edgePts: round2(winRate - 50),
        weight: 0,
        selected: false,
      })
    }
    measured.sort((a, b) => b.edgePts - a.edgePts || b.n - a.n)

    const byKey = new Map(candidates.map((c) => [c.key, c]))
    const qualifying = measured.filter((m) => m.n >= minSamples && m.edgePts >= minEdge)
    const selected: SignalStat[] = []
    const seenFamily = new Set<string>()
    for (const m of qualifying) {
      if (selected.length >= maxSignals) break
      const fam = byKey.get(m.key)?.family ?? m.key
      if (seenFamily.has(fam)) continue
      seenFamily.add(fam)
      selected.push(m)
    }
    for (const m of selected) {
      m.selected = true
      m.weight = Math.max(6, Math.min(50, Math.round(m.edgePts * 4)))
    }

    if (!selected.length) {
      return {
        ok: false,
        asset,
        tf,
        candlesTested: n,
        horizon,
        minSamples,
        minEdge,
        breakevenWinRate: round2((1 / (1 + payout)) * 100),
        signals: measured.slice(0, 24),
        spec: null,
        calibration: { thresholds: [], chosen: 0, votes: 1 },
        backtest: null,
        holdout: null,
        note: `no event cleared the filters (n >= ${minSamples}, edge >= ${minEdge}pts over ${n} bars) - nothing to deploy; lower minEdge/minSamples or try another pair/timeframe`,
      }
    }

    // ---- spec + threshold calibration ----
    const spec: CustomSpec = {
      name: opts.name?.trim() || `${asset} ${tf} Learned`,
      description: `Learned by the Strategy Lab from ${n} x ${tf} bars of ${asset}: ${selected.length} edge-bearing signals (win-rate edge ${Math.min(...selected.map((s) => s.edgePts))}-${Math.max(...selected.map((s) => s.edgePts))} pts, horizon ${horizon} bar${horizon > 1 ? 's' : ''}).`,
      signals: selected.map((m) => {
        const def = { ...byKey.get(m.key)!.def, weight: m.weight }
        return def
      }),
      minScore: 45,
      minVotes: selected.length >= 3 ? 2 : 1,
      horizon,
    }

    const series = scoreSeriesFor(spec, ctx, candleHits)
    const minVotes = spec.minVotes
    const thresholds: { minScore: number; trades: number; winRate: number }[] = []
    for (let t = 30; t <= 75; t += 5) {
      const sim = simFromSeries(series, candles, warm, horizon, amount, payout, minVotes, t)
      thresholds.push({ minScore: t, trades: sim.trades, winRate: round2(sim.winRate) })
    }
    const testedBars = end - warm
    const needTrades = Math.max(10, Math.floor(testedBars / 200))
    const good = thresholds.filter((t) => t.trades >= needTrades).sort((a, b) => b.winRate - a.winRate || b.trades - a.trades)
    const fallback = thresholds.filter((t) => t.trades >= 5).sort((a, b) => b.winRate - a.winRate)[0]
    const chosen = good[0] ?? fallback ?? { minScore: 40, trades: 0, winRate: 0 }
    spec.minScore = chosen.minScore

    // ---- final backtests: full sample + honest holdout (last 30%) ----
    const backtest = simFromSeries(series, candles, warm, horizon, amount, payout, minVotes, spec.minScore)
    const holdout = simFromSeries(series, candles, Math.floor(n * 0.7), horizon, amount, payout, minVotes, spec.minScore)

    return {
      ok: true,
      asset,
      tf,
      candlesTested: n,
      horizon,
      minSamples,
      minEdge,
      breakevenWinRate: round2((1 / (1 + payout)) * 100),
      signals: measured.slice(0, 24),
      spec,
      calibration: { thresholds, chosen: spec.minScore, votes: minVotes },
      backtest,
      holdout,
      note: `learned ${selected.length}-signal spec "${spec.name}" (minScore ${spec.minScore}, minVotes ${minVotes}); full-sample win rate ${backtest.winRate.toFixed(1)}% vs breakeven ${((1 / (1 + payout)) * 100).toFixed(1)}%, holdout (last 30%) ${holdout.trades} trades @ ${holdout.winRate.toFixed(1)}%`,
    }
  }

  // ---------- backtest a spec (or a saved one) ----------

  backtestSpec(input: { spec?: unknown; id?: string; asset?: string; tf?: string; payout?: number; amount?: number; horizon?: number }): { ok: boolean; id?: string; asset: string; tf: Timeframe; spec: CustomSpec; backtest: SimMetrics; holdout: SimMetrics; breakevenWinRate: number } {
    let spec = normalizeSpec(input.spec, 'Inline Spec')
    let id: string | undefined
    if (!spec && input.id) {
      const row = this.store.listLabStrategies().find((r) => r.id === input.id)
      if (row) spec = normalizeSpec(row.spec, row.id)
      id = input.id
    }
    if (!spec) throw new Error('need a valid spec or a saved lab id')
    const asset = String(input.asset ?? '').toUpperCase() || this.market.activeAsset
    const tfv = (input.tf ?? '1m') as Timeframe
    const payout = Math.max(0.5, Math.min(0.95, Number(input.payout ?? 0.7)))
    const amount = Math.max(1, Number(input.amount ?? 10))
    const horizon = Math.max(1, Math.min(10, Math.round(input.horizon ?? spec.horizon ?? 1)))
    const candles = this.market.getCandlesDeep(asset, tfv, 2200)
    if (candles.length < 220) throw new Error(`not enough history for ${asset} ${tfv} (${candles.length} bars)`)
    const ctx = buildCtx(candles)
    const candleHits = scanCandleHits(candles)
    const series = scoreSeriesFor(spec, ctx, candleHits)
    const backtest = simFromSeries(series, candles, 30, horizon, amount, payout, spec.minVotes, spec.minScore)
    const holdout = simFromSeries(series, candles, Math.floor(candles.length * 0.7), horizon, amount, payout, spec.minVotes, spec.minScore)
    return {
      ok: true,
      id,
      asset,
      tf: tfv,
      spec,
      backtest,
      holdout,
      breakevenWinRate: round2((1 / (1 + payout)) * 100),
    }
  }

  // ---------- library ----------

  save(input: { id?: string; name?: string; spec: unknown; asset?: string; tf?: string; stats?: unknown }): { ok: boolean; id: string; spec: CustomSpec } {
    const spec = normalizeSpec(input.spec, input.name ?? 'Learned Strategy')
    if (!spec) throw new Error('invalid spec - no usable signals survived normalization')
    if (input.name) spec.name = String(input.name).slice(0, 60)
    const id = (input.id?.trim() || `custom:${slugify(spec.name)}`).toLowerCase()
    this.store.saveLabStrategy({
      id,
      spec,
      asset: String(input.asset ?? '').toUpperCase() || 'ANY',
      tf: String(input.tf ?? '1m'),
      stats: input.stats,
    })
    this.ctx.bus.emit('alert', {
      level: 'success',
      message: `[lab] strategy "${spec.name}" saved as ${id} (${spec.signals.length} signals, minScore ${spec.minScore}, minVotes ${spec.minVotes})`,
      ts: Math.floor(Date.now() / 1000),
    })
    return { ok: true, id, spec }
  }

  list(): LabRow[] {
    return this.store.listLabStrategies().map((r) => ({
      id: r.id,
      spec: normalizeSpec(r.spec, r.id) ?? ({ name: r.id, signals: [], minScore: 45, minVotes: 1, horizon: 1 } as CustomSpec),
      asset: r.asset,
      tf: r.tf,
      stats: (r.stats as LabRow['stats']) ?? null,
      createdTs: r.createdTs,
      updatedTs: r.updatedTs,
    }))
  }

  get(id: string): LabRow | null {
    return this.list().find((r) => r.id === id.toLowerCase()) ?? null
  }

  remove(id: string): { ok: boolean; error?: string } {
    const ok = this.store.deleteLabStrategy(id.toLowerCase())
    return ok ? { ok } : { ok, error: 'lab strategy not found' }
  }

  // ---------- autopilot integration ----------

  isValidStrategyId(id: string): boolean {
    return id.startsWith('custom:') && this.store.listLabStrategies().some((r) => r.id === id)
  }

  /** Live evaluation on the deep candle history (same math as the backtest). */
  runStrategy(asset: string, tf: Timeframe, id: string) {
    const row = this.get(id)
    if (!row) throw new Error(`unknown lab strategy ${id}`)
    const spec = normalizeSpec(row.spec, id)
    if (!spec) throw new Error(`lab strategy ${id} has no usable signals`)
    const candles = this.market.getCandlesDeep(asset, tf, 1500)
    if (candles.length < 25) throw new Error('not enough candle history yet')
    const ev = evaluateCustom(spec, candles)
    return { ...ev, asset, tf, strategy: id, price: candles[candles.length - 1].close }
  }
}

// ---------- helpers ----------

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function familyOf(s: SignalDef): string {
  switch (s.kind) {
    case 'candle':
      return `candle:${s.name.toLowerCase()}`
    case 'bar':
      return 'bar'
    case 'ha':
      return `ha:${s.variant.replace(/-(up|down|bull|bear)$/, '')}`
    case 'line':
      return `line:${s.variant.replace(/-(up|down)$/, '')}`
    case 'indicator':
      return `ind:${s.ind}`
  }
}

/** Canonical key for a signal definition (learner bookkeeping). */
function candidateKeyOf(s: SignalDef): string {
  switch (s.kind) {
    case 'candle':
      return `candle:${s.name.toLowerCase()}`
    case 'bar':
      return `bar:${s.variant}`
    case 'ha':
      return `ha:${s.variant}:${s.len ?? ''}`
    case 'line':
      return `line:${s.variant}:${s.lookback ?? ''}`
    case 'indicator':
      return `indicator:${s.ind}|${s.op}|${s.threshold}|${JSON.stringify(s.params ?? {})}`
  }
}

/** Per-bar candlestick recognition (one deduped scan of the tail bar). */
function scanCandleHits(candles: Candle[]): CandleHits {
  const n = candles.length
  const hits: CandleHits = new Array(n)
  for (let i = 0; i < n; i++) hits[i] = new Map()
  for (let i = 13; i < n; i++) {
    const win = candles.slice(0, i + 1)
    for (const hit of detectPatterns(win, 1)) {
      if (hit.direction === 'neutral' || CANDLE_SKIP.has(hit.name)) continue
      hits[i].set(hit.name.toLowerCase(), hit.direction === 'bullish' ? 'call' : 'put')
    }
  }
  return hits
}

/** Restore the library's display casing from a lowercased key. */
function displayName(lower: string): string {
  return lower.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Per-bar vote series for a spec, using exactly the live-evaluation math
 * (prepareSignal tests + the candle scan for the candlestick family). */
function scoreSeriesFor(
  spec: CustomSpec,
  ctx: EvalCtx,
  candleHits: CandleHits,
): { score: number; votes: number; dir: Side | 'none' }[] {
  const n = ctx.n
  const tests = spec.signals.map((s) => {
    const base = prepareSignal(s, ctx)
    if (s.kind !== 'candle') return base
    const name = s.name.toLowerCase()
    return (i: number) => candleHits[i]?.get(name) === s.dir
  })
  const series: { score: number; votes: number; dir: Side | 'none' }[] = new Array(n)
  for (let i = 0; i < n; i++) {
    let bullW = 0
    let bearW = 0
    let bullN = 0
    let bearN = 0
    spec.signals.forEach((s, k) => {
      if (!tests[k](i)) return
      const w = (s as { weight: number }).weight ?? 10
      if (s.dir === 'call') {
        bullW += w
        bullN += 1
      } else {
        bearW += w
        bearN += 1
      }
    })
    const total = bullW + bearW
    if (total <= 0) {
      series[i] = { score: 0, votes: 0, dir: 'none' }
      continue
    }
    const score = Math.round((100 * (bullW - bearW)) / total)
    series[i] = { score, votes: bullW >= bearW ? bullN : bearN, dir: bullW >= bearW ? 'call' : 'put' }
  }
  return series
}

/** Binary-settlement simulation of a precomputed score series. */
function simFromSeries(
  series: { score: number; votes: number; dir: Side | 'none' }[],
  candles: Candle[],
  startIdx: number,
  horizon: number,
  amount: number,
  payout: number,
  minVotes: number,
  minScore: number,
): SimMetrics {
  let trades = 0
  let wins = 0
  let pnl = 0
  let grossWin = 0
  let grossLoss = 0
  let peak = 0
  let maxDD = 0
  const end = candles.length - horizon
  for (let i = Math.max(startIdx, 30); i < end; i++) {
    const s = series[i]
    if (s.dir === 'none' || Math.abs(s.score) < minScore || s.votes < minVotes) continue
    const entry = candles[i].close
    const exit = candles[i + horizon].close
    const won = s.dir === 'call' ? exit > entry : exit < entry
    const draw = exit === entry
    const tradePnl = draw ? 0 : won ? amount * payout : -amount
    trades += 1
    pnl += tradePnl
    if (tradePnl > 0) grossWin += tradePnl
    else if (tradePnl < 0) grossLoss += Math.abs(tradePnl)
    if (won) wins += 1
    if (pnl > peak) peak = pnl
    if (peak - pnl > maxDD) maxDD = peak - pnl
    i += horizon - 1 // no overlapping trades: skip the settlement window
  }
  return {
    trades,
    wins,
    losses: trades - wins,
    winRate: trades ? (wins / trades) * 100 : 0,
    netPnl: round2(pnl),
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : round2(grossWin / grossLoss),
    maxDrawdown: round2(maxDD),
    expectancy: trades ? round2(pnl / trades) : 0,
  }
}

// ---------- candidate vocabulary (the lab's invented indicator family) ----------

/** The parametric candidates the learner sweeps. Each maps 1:1 to a SignalDef
 * the evaluator understands, so a measured candidate IS the deployed math. */
export const CANDIDATE_SIGNALS: SignalDef[] = [
  // bar formations
  { kind: 'bar', variant: 'wide-bull', atrK: 1.1, dir: 'call', weight: 10 },
  { kind: 'bar', variant: 'wide-bear', atrK: 1.1, dir: 'put', weight: 10 },
  // heiken ashi structures
  { kind: 'ha', variant: 'flip-up', len: 2, dir: 'call', weight: 10 },
  { kind: 'ha', variant: 'flip-down', len: 2, dir: 'put', weight: 10 },
  { kind: 'ha', variant: 'streak-up', len: 3, dir: 'call', weight: 10 },
  { kind: 'ha', variant: 'streak-down', len: 3, dir: 'put', weight: 10 },
  { kind: 'ha', variant: 'strong-bull', dir: 'call', weight: 10 },
  { kind: 'ha', variant: 'strong-bear', dir: 'put', weight: 10 },
  // line / structural
  { kind: 'line', variant: 'breakout-up', lookback: 10, dir: 'call', weight: 10 },
  { kind: 'line', variant: 'breakout-down', lookback: 10, dir: 'put', weight: 10 },
  { kind: 'line', variant: 'breakout-up', lookback: 20, dir: 'call', weight: 10 },
  { kind: 'line', variant: 'breakout-down', lookback: 20, dir: 'put', weight: 10 },
  { kind: 'line', variant: 'hh-hl', lookback: 3, dir: 'call', weight: 10 },
  { kind: 'line', variant: 'lh-ll', lookback: 3, dir: 'put', weight: 10 },
  // indicators - mean reversion side
  { kind: 'indicator', ind: 'rsi', params: { period: 14 }, op: '<', threshold: 30, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'rsi', params: { period: 14 }, op: '<', threshold: 35, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'rsi', params: { period: 14 }, op: '>', threshold: 70, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'rsi', params: { period: 14 }, op: '>', threshold: 65, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'rsi', params: { period: 7 }, op: '<', threshold: 25, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'rsi', params: { period: 7 }, op: '>', threshold: 75, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'bbpos', params: { period: 20, mult: 2 }, op: '<', threshold: 0.05, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'bbpos', params: { period: 20, mult: 2 }, op: '>', threshold: 0.95, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'zscore', params: { period: 20 }, op: '<', threshold: -1.5, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'zscore', params: { period: 20 }, op: '>', threshold: 1.5, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'zscore', params: { period: 50 }, op: '<', threshold: -2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'zscore', params: { period: 50 }, op: '>', threshold: 2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'wickbias', op: '>', threshold: 0.45, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'wickbias', op: '<', threshold: -0.45, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'bodypos', op: '<', threshold: 0.15, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'bodypos', op: '>', threshold: 0.85, dir: 'call', weight: 10 },
  // indicators - momentum / continuation side
  { kind: 'indicator', ind: 'donchianpos', params: { period: 20 }, op: '>', threshold: 0.95, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'donchianpos', params: { period: 20 }, op: '<', threshold: 0.05, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'macdz', op: '>', threshold: 0.4, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'macdz', op: '<', threshold: -0.4, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'slope', params: { period: 20 }, op: '>', threshold: 0.35, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'slope', params: { period: 20 }, op: '<', threshold: -0.35, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'streak', op: '>', threshold: 2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'streak', op: '<', threshold: -2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'emasign', params: { fast: 9, slow: 21 }, op: '>', threshold: 0.5, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'emasign', params: { fast: 9, slow: 21 }, op: '<', threshold: -0.5, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'hadist', op: '>', threshold: 0.6, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'hadist', op: '<', threshold: -0.6, dir: 'put', weight: 10 },
]

export const labPlugin: Plugin = {
  name: 'lab',
  start: async (ctx) => {
    const svc = new StrategyLabService()
    ctx.provide('lab', svc)
    await svc.start(ctx)
  },
  stop: () => {},
}
