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
  basisCandles,
  buildCtx,
  evaluateCustom,
  heikinAshiCandles,
  kalmanCandles,
  typicalCandles,
  smoothedCandles,
  labelOf,
  normalizeSpec,
  prepareSignal,
  slugify,
  type Basis,
  type CustomSpec,
  type EvalCtx,
  type SignalDef,
} from '../strategies/custom'
import { detectPatterns } from '../analytics/patterns'
import { analyze } from '../analytics/engine'
import { classifyRegime, type Regime } from '../analytics/regime'

export interface LearnOptions {
  asset: string
  tf: Timeframe
  bars?: number // history to learn from (default 1200, cap 2200)
  horizon?: number // bars ahead the outcome is measured (default 1)
  minSamples?: number // min occurrences for a signal to qualify (default 40, auto-relaxed on thin history)
  minEdge?: number // min win-rate edge vs 50% in points (default 2)
  maxSignals?: number // signals composed into the spec (default 8)
  payout?: number // binary payout used in the backtest (default 0.7 = house cap)
  amount?: number // backtest stake (default 10)
  name?: string // spec name override
  basis?: Basis // what the signals read: raw OHLC, Heiken-Ashi, Kalman-smoothed, typical-price, or SMA-smoothed
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
  // Wilson-score 95% CI lower bound on winRate, minus 50 - a "haircut" edge
  // that discounts small-sample luck (n=41 at a flattering winRate scores
  // much lower here than n=400 at the same winRate). Selection AND weight
  // are now based on this, not the raw edgePts above, so the ensemble isn't
  // dominated by a signal that just got lucky on a thin sample.
  edgeLB: number
  weight: number
  selected: boolean
  // Full signal definition this stat was measured from - exposed so a caller
  // (the AI Lab UI's manual signal checkboxes) can compose a CustomSpec out
  // of ANY subset of measured candidates, not just the ones the auto-select
  // step picked. Without this the UI could only ever save/deploy exactly
  // what the algorithm chose - a signal with a dash in the weight column
  // (excluded by min-n, min-edge, or the one-per-family rule) had no way
  // back into a deployed spec even when the user could see it looked good.
  def: SignalDef
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
  // Wilson-score 95% confidence interval on winRate, and a flag for when
  // totalTrades is too small to trust the point estimate - same treatment
  // given to the Backtest Lab's engines, so a learned pair's numbers carry
  // the same honesty about sample size.
  winRateCiLow: number
  winRateCiHigh: number
  lowSample: boolean
}

export interface LearnResult {
  ok: boolean
  asset: string
  tf: Timeframe
  basis: Basis
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
  // Sequential out-of-sample folds carved from the last 40% of history (the
  // single "last 30%" holdout above is one window, and a strategy can get
  // lucky/unlucky in any one window) - the SAME calibrated spec is replayed
  // over each fold with no re-tuning, so a low foldsProfitable count is a
  // real signal that the edge isn't stable across time, not just an artifact
  // of where the holdout boundary happened to fall.
  holdoutFolds: SimMetrics[]
  foldsProfitable: number
  // true when minVotes had to drop to 1 because fewer than 3 signals
  // qualified - the ensemble's "confluence guard" (multiple independent
  // signals agreeing) is degraded to a single signal firing alone, which is
  // materially weaker evidence and was previously invisible in the UI.
  confluenceWeak: boolean
  regime: Regime
  note: string
}

export interface LabRow {
  id: string
  spec: CustomSpec
  asset: string
  tf: string
  stats: { backtest?: SimMetrics; holdout?: SimMetrics; breakeven?: number; decayed?: boolean; decayedTs?: number } | null
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

interface AutopilotLike {
  listBots(): { bot: { id: string; enabled: boolean; strategyId: string; name: string } }[]
  toggleBot(id: string, enabled?: boolean): unknown
}

export class StrategyLabService {
  private ctx!: KernelContext
  private store!: Store
  private market!: MarketDataService
  private relearnTimer: ReturnType<typeof setInterval> | null = null
  // Spread across ticks rather than relearning every saved spec at once on
  // the mark - learn() replays the full pattern-mining + holdout-fold
  // pipeline per call, which is CPU-heavy enough that doing it for every
  // saved strategy simultaneously would be a real hit.
  private static readonly RELEARN_TICK_MS = 15 * 60 * 1000 // 15 min sweep cadence
  private static readonly RELEARN_AFTER_SEC = 6 * 60 * 60 // re-mine a spec at most every 6h
  private static readonly RELEARN_MAX_PER_TICK = 2

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.store = ctx.use<Store>('store')
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('lab', 'strategy lab online (pattern mining, edge stats, spec synthesis, holdout backtests)')
    // THE GAP this closes: autopilot's own re-validation sweep explicitly
    // skips custom:* (Strategy Lab) strategies - "aren't backed by the
    // optimize.ts grid engine... outside this gate for now" (see
    // autopilot.ts's revalidateSweep). A learned spec could decay silently
    // with nothing re-checking its edge the way every optimize.ts-backed
    // strategy gets re-walk-forwarded automatically. This sweep gives
    // custom:* specs the same kind of ongoing upkeep, using the lab's own
    // learn() pipeline instead of optimize.ts's grid search.
    this.relearnTimer = setInterval(() => void this.relearnSweep(), StrategyLabService.RELEARN_TICK_MS)
  }

  stop(): void {
    if (this.relearnTimer) clearInterval(this.relearnTimer)
    this.relearnTimer = null
  }

  /** Re-mine up to RELEARN_MAX_PER_TICK saved specs whose last learn is
   * older than RELEARN_AFTER_SEC. A spec that still clears its own filters
   * gets its signals/weights/calibration refreshed in place (same id, so
   * any bot trading it picks up the update with no re-save needed). A spec
   * that no longer clears them - or whose fresh holdout can't beat breakeven
   * - is left untouched but flagged "decayed" in its stored stats, and any
   * enabled bot trading it is auto-disarmed, the same courtesy optimize.ts-
   * backed strategies already get from the daily re-validation gate. */
  private async relearnSweep(): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    const due = this.list()
      .filter((r) => r.asset && r.asset !== 'ANY' && now - r.updatedTs >= StrategyLabService.RELEARN_AFTER_SEC)
      .slice(0, StrategyLabService.RELEARN_MAX_PER_TICK)
    for (const row of due) this.relearnRow(row, 'auto-relearned')
  }

  /** Manual trigger for the "Re-learn now" button - same decay-check/auto-
   * disarm logic as the scheduled sweep, just bypassing the age gate. */
  relearnOne(id: string): { ok: boolean; decayed?: boolean; error?: string } {
    const row = this.get(id.toLowerCase())
    if (!row) return { ok: false, error: 'lab strategy not found' }
    if (!row.asset || row.asset === 'ANY') return { ok: false, error: 'strategy has no specific asset to re-learn against' }
    return this.relearnRow(row, 'manually re-learned')
  }

  private relearnRow(row: LabRow, verb: 'auto-relearned' | 'manually re-learned'): { ok: boolean; decayed?: boolean; error?: string } {
    const now = Math.floor(Date.now() / 1000)
    try {
      const fresh = this.learn({
        asset: row.asset,
        tf: row.tf as Timeframe,
        basis: row.spec.basis,
        horizon: row.spec.horizon,
        name: row.spec.name,
      })
      const oldStats = (row.stats ?? {}) as { holdout?: SimMetrics; breakeven?: number }
      const decayed = !fresh.ok || fresh.holdout === null || fresh.holdout.winRate < fresh.breakevenWinRate || fresh.foldsProfitable === 0
      if (decayed) {
        const reason = !fresh.ok
          ? 'no signal still clears its filters on fresh data'
          : `fresh holdout ${fresh.holdout!.winRate.toFixed(1)}% vs breakeven ${fresh.breakevenWinRate.toFixed(1)}%, ${fresh.foldsProfitable}/${fresh.holdoutFolds.length || 3} OOS folds profitable`
        this.ctx.bus.emit('alert', {
          level: 'danger',
          message: `[lab] "${row.spec.name}" (${row.id}) looks DECAYED on re-learn - ${reason}. Kept the last-good spec live but disarmed any bot trading it.`,
          ts: now,
        })
        // keep the last-good tradeable spec, just mark it + refresh the
        // relearn clock so this doesn't retry every single tick
        this.store.saveLabStrategy({ id: row.id, spec: row.spec, asset: row.asset, tf: row.tf, stats: { ...oldStats, decayed: true, decayedTs: now } })
        try {
          const ap = this.ctx.use<AutopilotLike>('autopilot')
          for (const { bot } of ap.listBots()) {
            if (bot.enabled && bot.strategyId === row.id) {
              ap.toggleBot(bot.id, false)
              this.ctx.bus.emit('alert', { level: 'danger', message: `[lab] bot "${bot.name}" AUTO-DISARMED - its strategy ${row.id} decayed on re-learn`, ts: now })
            }
          }
        } catch {
          // autopilot not loaded
        }
        return { ok: true, decayed: true }
      }
      // still earning its keep - refresh the deployed spec in place
      this.store.saveLabStrategy({
        id: row.id,
        spec: fresh.spec,
        asset: row.asset,
        tf: row.tf,
        stats: { backtest: fresh.backtest, holdout: fresh.holdout, breakeven: fresh.breakevenWinRate, decayed: false },
      })
      const prevWr = oldStats.holdout?.winRate
      this.ctx.bus.emit('alert', {
        level: 'info',
        message: `[lab] "${row.spec.name}" (${row.id}) ${verb} - holdout ${fresh.holdout!.winRate.toFixed(1)}%${Number.isFinite(prevWr) ? ` (was ${prevWr!.toFixed(1)}%)` : ''}, ${fresh.spec!.signals.length} signals`,
        ts: now,
      })
      return { ok: true, decayed: false }
    } catch (err) {
      // a transient data/history issue on one spec shouldn't stop a sweep
      // from getting to the next one, or crash a manual re-learn request
      const msg = err instanceof Error ? err.message : String(err)
      this.ctx.log('lab', `relearn failed for ${row.id}: ${msg}`)
      return { ok: false, error: msg }
    }
  }

  // ---------- learning pipeline ----------

  learn(opts: LearnOptions): LearnResult {
    const asset = String(opts.asset ?? this.market.activeAsset).toUpperCase()
    const tf = opts.tf as Timeframe
    const horizon = Math.max(1, Math.min(10, Math.round(opts.horizon ?? 1)))
    const minSamplesAsk = Math.max(10, Math.round(opts.minSamples ?? 40))
    const minEdge = Math.max(0.5, Math.min(20, Number(opts.minEdge ?? 2)))
    const maxSignals = Math.max(2, Math.min(12, Math.round(opts.maxSignals ?? 8)))
    const payout = Math.max(0.5, Math.min(0.95, Number(opts.payout ?? 0.7)))
    const amount = Math.max(1, Number(opts.amount ?? 10))
    const bars = Math.max(300, Math.min(2200, Math.round(opts.bars ?? 1200)))
    const basis: Basis = opts.basis === 'heikin' || opts.basis === 'kalman' || opts.basis === 'typical' || opts.basis === 'smoothed' ? opts.basis : 'candles'

    const raw = this.market.getCandlesDeep(asset, tf, bars)
    if (raw.length < 120) throw new Error(`not enough history for ${asset} ${tf} (${raw.length} bars, need 120+)`)
    // thin history auto-relaxation: a hard sample floor on a short series is
    // the #1 "the lab is failing" trap - scale the ask down to what the series
    // can statistically support (never ABOVE the caller's ask)
    const warm = 30
    const minSamples = Math.max(10, Math.min(minSamplesAsk, Math.floor((raw.length - warm - horizon) / 6)))
    // signals read the chosen basis; outcomes/settlement are ALWAYS real prices
    const candles =
      basis === 'heikin' ? heikinAshiCandles(raw) : basis === 'kalman' ? kalmanCandles(raw) : basis === 'typical' ? typicalCandles(raw) : basis === 'smoothed' ? smoothedCandles(raw) : raw
    const settle = raw.map((c) => c.close)
    const n = candles.length
    const ctx = buildCtx(candles)
    // Regime tag - what kind of market this pair/window actually was
    // (trending/ranging/volatile/mixed), so a learned edge can be read
    // alongside the conditions it was learned under rather than in a vacuum.
    let regime: Regime = 'MIXED'
    try {
      regime = classifyRegime(analyze(raw, asset, tf))
    } catch {
      // analytics engine needs its own minimum history/indicator warmup;
      // leave the default tag rather than fail the whole learn() call over it
    }

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

    // ---- measure edge: did REAL price move in the implied dir `horizon` bars later? ----
    const stats = new Map<string, { n: number; wins: number }>()
    const end = n - horizon
    for (let i = warm; i < end; i++) {
      for (const c of candidates) {
        if (!c.test(i)) continue
        const s = stats.get(c.key) ?? { n: 0, wins: 0 }
        s.n += 1
        const up = settle[i + horizon] > settle[i]
        const dn = settle[i + horizon] < settle[i]
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
      const [ciLow] = wilsonInterval(s.wins, s.n)
      measured.push({
        key: c.key,
        kind: c.kind,
        label: c.label,
        dir: c.dir,
        n: s.n,
        wins: s.wins,
        winRate: round2(winRate),
        edgePts: round2(winRate - 50),
        edgeLB: round2(ciLow - 50),
        weight: 0,
        selected: false,
        def: c.def,
      })
    }
    // THE BUG this replaces: ranking and weighting by raw edgePts let a
    // small-sample fluke (say n=41, winRate 62%) outrank and outweigh a
    // signal with a much bigger, more trustworthy sample (n=400, winRate
    // 58%) just because its POINT ESTIMATE happened to be higher - exactly
    // the kind of overfit-to-noise the holdout/fold checks downstream are
    // supposed to catch, but by then the ensemble had already baked the
    // lucky signal in. Ranking by the Wilson lower bound instead means a
    // thin sample needs a genuinely large edge to compete with a well-
    // sampled one at a smaller edge.
    measured.sort((a, b) => b.edgeLB - a.edgeLB || b.n - a.n)

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
      // weighted by the same haircut-edge used to rank/select above, not the
      // raw point-estimate edge - a signal that barely cleared minEdge on a
      // thin sample now gets a proportionally smaller vote than one with the
      // same raw edge backed by hundreds of occurrences.
      m.weight = Math.max(6, Math.min(50, Math.round(Math.max(0.5, m.edgeLB) * 4)))
    }

    if (!selected.length) {
      return {
        ok: false,
        asset,
        tf,
        basis,
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
        holdoutFolds: [],
        foldsProfitable: 0,
        confluenceWeak: false,
        regime,
        note: `no event cleared the filters (n >= ${minSamples}, edge >= ${minEdge}pts over ${n} bars) - nothing to deploy; lower minEdge/minSamples or try another pair/timeframe`,
      }
    }

    // ---- spec + threshold calibration ----
    const spec: CustomSpec = {
      name: opts.name?.trim() || `${asset} ${tf} Learned`,
      description: `Learned by the Strategy Lab from ${n} x ${tf} bars of ${asset}${basis !== 'candles' ? ` on the ${basisLabel(basis)} basis` : ''}: ${selected.length} edge-bearing signals (win-rate edge ${Math.min(...selected.map((s) => s.edgePts))}-${Math.max(...selected.map((s) => s.edgePts))} pts, horizon ${horizon} bar${horizon > 1 ? 's' : ''}).`,
      signals: selected.map((m) => {
        const def = { ...byKey.get(m.key)!.def, weight: m.weight }
        return def
      }),
      minScore: 45,
      minVotes: selected.length >= 3 ? 2 : 1,
      horizon,
      ...(basis !== 'candles' ? { basis } : {}),
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
    // sims settle on REAL prices (raw closes) even for the heikin basis
    const backtest = simFromSeries(series, raw, warm, horizon, amount, payout, minVotes, spec.minScore)
    const holdout = simFromSeries(series, raw, Math.floor(n * 0.7), horizon, amount, payout, minVotes, spec.minScore)

    // ---- holdout folds: 3 sequential OOS windows over the last 40% ----
    // The single 70/30 split above is one draw of where the boundary falls;
    // replaying the SAME already-calibrated spec (no re-tuning) over several
    // sequential windows checks whether the edge holds up across different
    // stretches of time, not just in whichever window the holdout happened
    // to land on.
    const FOLD_COUNT = 3
    const foldsStart = Math.floor(n * 0.6)
    const foldSize = Math.floor((n - foldsStart) / FOLD_COUNT)
    const holdoutFolds: SimMetrics[] = []
    if (foldSize >= 20) {
      for (let f = 0; f < FOLD_COUNT; f++) {
        const foldStart = foldsStart + f * foldSize
        const foldEnd = f === FOLD_COUNT - 1 ? n : foldStart + foldSize
        holdoutFolds.push(simFromSeries(series, raw, foldStart, horizon, amount, payout, minVotes, spec.minScore, foldEnd))
      }
    }
    const foldsProfitable = holdoutFolds.filter((f) => f.netPnl > 0).length
    const confluenceWeak = minVotes < 2

    return {
      ok: true,
      asset,
      tf,
      basis,
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
      holdoutFolds,
      foldsProfitable,
      confluenceWeak,
      regime,
      note: `learned ${selected.length}-signal ${basis !== 'candles' ? `${basisLabel(basis).toUpperCase()} ` : ''}spec "${spec.name}" (minScore ${spec.minScore}, minVotes ${minVotes}${confluenceWeak ? ' - confluence guard degraded to a single signal' : ''}); full-sample win rate ${backtest.winRate.toFixed(1)}% vs breakeven ${((1 / (1 + payout)) * 100).toFixed(1)}%, holdout (last 30%) ${holdout.trades} trades @ ${holdout.winRate.toFixed(1)}%, ${foldsProfitable}/${holdoutFolds.length || FOLD_COUNT} OOS folds profitable, regime at learn time: ${regime}`,
    }
  }

  // ---------- backtest a spec (or a saved one) ----------

  backtestSpec(input: { spec?: unknown; id?: string; asset?: string; tf?: string; payout?: number; amount?: number; horizon?: number }): { ok: boolean; id?: string; asset: string; tf: Timeframe; spec: CustomSpec; backtest: SimMetrics; holdout: SimMetrics; breakevenWinRate: number } {
    let spec = normalizeSpec(input.spec, 'Inline Spec')
    let id: string | undefined
    let savedRow: LabRow | null = null
    if (!spec && input.id) {
      const row = this.store.listLabStrategies().find((r) => r.id === input.id)
      if (row) {
        spec = normalizeSpec(row.spec, row.id)
        savedRow = { id: row.id, spec: spec!, asset: row.asset, tf: row.tf, stats: row.stats as LabRow['stats'], createdTs: row.createdTs, updatedTs: row.updatedTs }
      }
      id = input.id
    }
    if (!spec) throw new Error('need a valid spec or a saved lab id')
    const asset = String(input.asset ?? '').toUpperCase() || this.market.activeAsset
    const tfv = (input.tf ?? '1m') as Timeframe
    const payout = Math.max(0.5, Math.min(0.95, Number(input.payout ?? 0.7)))
    const amount = Math.max(1, Number(input.amount ?? 10))
    const horizon = Math.max(1, Math.min(10, Math.round(input.horizon ?? spec.horizon ?? 1)))
    const raw = this.market.getCandlesDeep(asset, tfv, 2200)
    if (raw.length < 120) throw new Error(`not enough history for ${asset} ${tfv} (${raw.length} bars, need 120+)`)
    // signals read the spec's basis; sims settle on REAL prices
    const basisSeries = basisCandles(spec, raw)
    const ctx = buildCtx(basisSeries)
    const candleHits = scanCandleHits(basisSeries)
    const series = scoreSeriesFor(spec, ctx, candleHits)
    const backtest = simFromSeries(series, raw, 30, horizon, amount, payout, spec.minVotes, spec.minScore)
    const holdout = simFromSeries(series, raw, Math.floor(raw.length * 0.7), horizon, amount, payout, spec.minVotes, spec.minScore)
    const breakevenWinRate = round2((1 / (1 + payout)) * 100)
    // THE BUG this replaces: this method computed fresh numbers and just
    // handed them back in the HTTP response - nothing was ever written to the
    // saved row, so the UI's "re-backtest" button (which posts here, then
    // reloads the library from the STORE) always showed the exact same old
    // stats no matter how many times you clicked it. The library is now
    // updated in place, same as relearnRow does for a full re-learn, so a
    // plain re-backtest (same signals, fresh numbers) is actually visible.
    if (savedRow) {
      this.store.saveLabStrategy({
        id: savedRow.id,
        spec,
        asset: savedRow.asset,
        tf: savedRow.tf,
        stats: { ...(savedRow.stats ?? {}), backtest, holdout, breakeven: breakevenWinRate },
      })
    }
    return {
      ok: true,
      id,
      asset,
      tf: tfv,
      spec,
      backtest,
      holdout,
      breakevenWinRate,
    }
  }

  // ---------- library ----------

  save(input: { id?: string; name?: string; spec: unknown; asset?: string; tf?: string; stats?: unknown }): { ok: boolean; id: string; spec: CustomSpec } {
    const spec = normalizeSpec(input.spec, input.name ?? 'Learned Strategy')
    if (!spec) throw new Error('invalid spec - no usable signals survived normalization')
    if (input.name) spec.name = String(input.name).slice(0, 60)
    // Defensive: `id` is the literal strategyId ("custom:<slug>") returned to
    // callers - it must carry the "custom:" prefix EXACTLY ONCE. A caller
    // that already has an id (or a name) containing "custom:" and then
    // prefixes it again produces "custom:custom:..." - a strategyId that
    // looks saved but matches nothing in the library (bot_create/lab_get
    // look up the exact string). Collapse any repeated prefix here so a
    // mistake upstream can't silently mint an undeployable id.
    const id = (input.id?.trim() || `custom:${slugify(spec.name)}`).toLowerCase().replace(/^(?:custom:)+/, 'custom:')
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
    case 'mtf':
      // each factor is its own family (5x and 15x are different enough
      // timeframes that both are worth keeping if they both show edge),
      // but up/down of the SAME factor count as one family so the ensemble
      // doesn't select both sides of the identical trend test.
      return `mtf:${s.factor}`
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
    case 'mtf':
      return `mtf:${s.factor}:${s.dir}`
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

/** Human label for a basis, for descriptions/notes. */
function basisLabel(basis: Basis): string {
  return { candles: 'raw candle', heikin: 'Heiken-Ashi', kalman: 'Kalman-smoothed', typical: 'typical-price', smoothed: 'SMA-smoothed' }[basis]
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

/** Binary-settlement simulation of a precomputed score series. `endIdx`
 * (default: full series) lets a caller confine the simulation to a
 * sub-window - e.g. one sequential holdout fold - without recomputing the
 * score series each time. */
function simFromSeries(
  series: { score: number; votes: number; dir: Side | 'none' }[],
  candles: Candle[],
  startIdx: number,
  horizon: number,
  amount: number,
  payout: number,
  minVotes: number,
  minScore: number,
  endIdx?: number,
): SimMetrics {
  let trades = 0
  let wins = 0
  let pnl = 0
  let grossWin = 0
  let grossLoss = 0
  let peak = 0
  let maxDD = 0
  const end = Math.min(endIdx ?? candles.length, candles.length) - horizon
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
  const [ciLow, ciHigh] = wilsonInterval(wins, trades)
  return {
    trades,
    wins,
    losses: trades - wins,
    winRate: trades ? (wins / trades) * 100 : 0,
    netPnl: round2(pnl),
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : round2(grossWin / grossLoss),
    maxDrawdown: round2(maxDD),
    expectancy: trades ? round2(pnl / trades) : 0,
    winRateCiLow: ciLow,
    winRateCiHigh: ciHigh,
    lowSample: trades < 30,
  }
}

/** Wilson score 95% confidence interval on a binomial proportion - stays
 * well-behaved (never leaves [0,100]) at small n or extreme win rates,
 * unlike the naive normal approximation. */
function wilsonInterval(wins: number, total: number, z = 1.96): [number, number] {
  if (total <= 0) return [0, 0]
  const p = wins / total
  const denom = 1 + (z * z) / total
  const center = p + (z * z) / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))
  const low = (center - margin) / denom
  const high = (center + margin) / denom
  return [Math.max(0, low * 100), Math.min(100, high * 100)]
}

// ---------- candidate vocabulary (the lab's invented indicator family) ----------

/** The parametric candidates the learner sweeps. Each maps 1:1 to a SignalDef
 * the evaluator understands, so a measured candidate IS the deployed math. */
export const CANDIDATE_SIGNALS: SignalDef[] = [
  // multi-timeframe EMA-trend agreement (resampled 5x/15x, same idea as the
  // standalone mtf-alignment strategy) - lets the lab discover whether a
  // pair's edge actually comes from aligning with the bigger-timeframe trend
  { kind: 'mtf', factor: 5, dir: 'call', weight: 10 },
  { kind: 'mtf', factor: 5, dir: 'put', weight: 10 },
  { kind: 'mtf', factor: 15, dir: 'call', weight: 10 },
  { kind: 'mtf', factor: 15, dir: 'put', weight: 10 },
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
  // Parabolic SAR trend distance
  { kind: 'indicator', ind: 'psar', params: { afStep: 0.02, afMax: 0.2 }, op: '>', threshold: 0.1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'psar', params: { afStep: 0.02, afMax: 0.2 }, op: '<', threshold: -0.1, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'psar', params: { afStep: 0.01, afMax: 0.15 }, op: '>', threshold: 0.05, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'psar', params: { afStep: 0.01, afMax: 0.15 }, op: '<', threshold: -0.05, dir: 'put', weight: 10 },
  // Williams Fractal swing breakout
  { kind: 'indicator', ind: 'fractal', params: { left: 2, right: 2 }, op: '>', threshold: 0.05, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'fractal', params: { left: 2, right: 2 }, op: '<', threshold: -0.05, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'fractal', params: { left: 3, right: 3 }, op: '>', threshold: 0.1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'fractal', params: { left: 3, right: 3 }, op: '<', threshold: -0.1, dir: 'put', weight: 10 },
  // ---- generic families: full analytics/indicators.ts suite ----
  // moving-average distance (trend/pullback)
  { kind: 'indicator', ind: 'madist', type: 'hma', params: { period: 20 }, op: '>', threshold: 0.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'hma', params: { period: 20 }, op: '<', threshold: -0.2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'kama', params: { period: 10 }, op: '>', threshold: 0.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'kama', params: { period: 10 }, op: '<', threshold: -0.2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'tema', params: { period: 20 }, op: '>', threshold: 0.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'tema', params: { period: 20 }, op: '<', threshold: -0.2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'vwma', params: { period: 20 }, op: '>', threshold: 0.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'vwma', params: { period: 20 }, op: '<', threshold: -0.2, dir: 'put', weight: 10 },
  // 0..100 oscillators (mean reversion)
  { kind: 'indicator', ind: 'osc0100', type: 'stochk', params: { period: 14 }, op: '<', threshold: 20, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'stochk', params: { period: 14 }, op: '>', threshold: 80, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'willr', params: { period: 14 }, op: '<', threshold: 20, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'willr', params: { period: 14 }, op: '>', threshold: 80, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'mfi', params: { period: 14 }, op: '<', threshold: 20, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'mfi', params: { period: 14 }, op: '>', threshold: 80, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'aroonup', params: { period: 14 }, op: '>', threshold: 90, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'aroondown', params: { period: 14 }, op: '>', threshold: 90, dir: 'put', weight: 10 },
  // -100..100-ish oscillators
  { kind: 'indicator', ind: 'oscpm100', type: 'cci', params: { period: 20 }, op: '<', threshold: -100, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'oscpm100', type: 'cci', params: { period: 20 }, op: '>', threshold: 100, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'oscpm100', type: 'cmo', params: { period: 14 }, op: '<', threshold: -50, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'oscpm100', type: 'cmo', params: { period: 14 }, op: '>', threshold: 50, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'oscpm100', type: 'tsi', op: '<', threshold: -25, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'oscpm100', type: 'tsi', op: '>', threshold: 25, dir: 'put', weight: 10 },
  // momentum/volatility family
  { kind: 'indicator', ind: 'oscz', type: 'roc', params: { period: 12 }, op: '>', threshold: 0.5, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'oscz', type: 'roc', params: { period: 12 }, op: '<', threshold: -0.5, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'oscz', type: 'fisher', params: { period: 9 }, op: '<', threshold: -1.5, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'oscz', type: 'fisher', params: { period: 9 }, op: '>', threshold: 1.5, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'oscz', type: 'awesomeosc', op: '>', threshold: 0.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'oscz', type: 'awesomeosc', op: '<', threshold: -0.2, dir: 'put', weight: 10 },
  // trend-line breakout distance
  { kind: 'indicator', ind: 'trenddist', type: 'supertrend', params: { period: 10, mult: 3 }, op: '>', threshold: 0.1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'trenddist', type: 'supertrend', params: { period: 10, mult: 3 }, op: '<', threshold: -0.1, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'trenddist', type: 'ichimoku', op: '>', threshold: 0.1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'trenddist', type: 'ichimoku', op: '<', threshold: -0.1, dir: 'put', weight: 10 },
  // band position (mean reversion)
  { kind: 'indicator', ind: 'bandpos', type: 'keltner', params: { period: 20 }, op: '<', threshold: 0.05, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'bandpos', type: 'keltner', params: { period: 20 }, op: '>', threshold: 0.95, dir: 'put', weight: 10 },
  // volume flow
  { kind: 'indicator', ind: 'volflow', type: 'cmf', params: { period: 20 }, op: '>', threshold: 0.1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'volflow', type: 'cmf', params: { period: 20 }, op: '<', threshold: -0.1, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'volflow', type: 'vwapdist', op: '>', threshold: 0.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'volflow', type: 'vwapdist', op: '<', threshold: -0.2, dir: 'put', weight: 10 },
  // static levels
  { kind: 'indicator', ind: 'levels', type: 'pivot', op: '>', threshold: 0.3, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'levels', type: 'pivot', op: '<', threshold: -0.3, dir: 'put', weight: 10 },
]

let labServiceInstance: StrategyLabService | null = null

export const labPlugin: Plugin = {
  name: 'lab',
  start: async (ctx) => {
    const svc = new StrategyLabService()
    labServiceInstance = svc
    ctx.provide('lab', svc)
    await svc.start(ctx)
  },
  // THE BUG this replaces: stop() was a no-op, so the relearn sweep's
  // setInterval (and any future lab timers) would keep firing against a
  // torn-down kernel context on a plugin reload/restart instead of being
  // cleared like every other plugin's timer (autopilot, sentinel) already is.
  stop: () => {
    labServiceInstance?.stop()
    labServiceInstance = null
  },
}
