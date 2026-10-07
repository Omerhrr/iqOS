// IQAIR//OS - Strategy Lab plugin (AI learning agent)
// Mines a pair's candle history for edge-bearing events across the full
// pattern vocabulary - candlestick formations, bar expansions, Heiken Ashi
// structures, line/structural breaks, Renko brick flips/streaks, P&F
// breakout patterns and a parametric indicator family - then
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
  /** Mine AND/OR/AND-AND confluence combos of the best single signals, not
   * just flat independent-signal voting - see learn()'s "combo mining"
   * comment. Default true (on); set false for the old singles-only
   * behavior or to skip the extra compute. */
  mineCombos?: boolean
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
  stats: {
    backtest?: SimMetrics
    holdout?: SimMetrics
    breakeven?: number
    decayed?: boolean
    decayedTs?: number
    /** THE BUG this flag fixes: relearnRow() always called learn() fresh,
     * which RE-MINES the whole candidate pool and auto-selects a brand new
     * signal set from scratch - discarding any manual curation (checkboxes
     * unticked in the AI Lab UI, or a strategy built entirely by hand in the
     * manual builder) the very next scheduled re-learn (every ~6h) or the
     * next click of "re-learn now". A user who deliberately kept 3 signals
     * out of 8 would silently get back a fresh 8-signal auto-pick with no
     * warning. `curated: true` marks a spec whose signal LIST must never be
     * regenerated - relearn still refreshes its backtest/holdout numbers and
     * decay flag against fresh data, it just never touches which signals are
     * in it. */
    curated?: boolean
  } | null
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
    // A curated spec's signal LIST is user-chosen and must never be
    // regenerated by re-mining - see LabRow.stats.curated's doc comment.
    if (row.stats?.curated) return this.relearnCuratedRow(row, verb)
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
      // AUDIT FIX (Task 58, P2): foldsProfitable === 0 used to conflate "no
      // OOS folds could be built (short history)" with "every fold lost" -
      // healthy specs learned on ~120-173 bars were flagged decayed and their
      // bots auto-disarmed on every 15-min relearn (the alert even fabricated
      // a "0/3" denominator). Only judge decay when folds were actually built.
      const noFoldsBuilt = fresh.holdoutFolds.length === 0
      const decayed =
        !fresh.ok || fresh.holdout === null || fresh.holdout.winRate < fresh.breakevenWinRate || (!noFoldsBuilt && fresh.foldsProfitable === 0)
      if (decayed) {
        const reason = !fresh.ok
          ? 'no signal still clears its filters on fresh data'
          : noFoldsBuilt
            ? `fresh holdout ${fresh.holdout!.winRate.toFixed(1)}% vs breakeven ${fresh.breakevenWinRate.toFixed(1)}% (history too short to build OOS folds - judged on the holdout only)`
            : `fresh holdout ${fresh.holdout!.winRate.toFixed(1)}% vs breakeven ${fresh.breakevenWinRate.toFixed(1)}%, ${fresh.foldsProfitable}/${fresh.holdoutFolds.length} OOS folds profitable`
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

  /** Re-learn for a curated spec: refresh its backtest/holdout numbers and
   * decay flag against fresh history, WITHOUT ever touching row.spec.signals
   * - the whole point of `curated`. Reuses backtestSpec()'s own simulation
   * and persistence (it already merges into existing stats, preserving
   * `curated: true`), then layers the same decay-detection/auto-disarm
   * courtesy relearnRow() gives a mined spec. */
  private relearnCuratedRow(row: LabRow, verb: 'auto-relearned' | 'manually re-learned'): { ok: boolean; decayed?: boolean; error?: string } {
    const now = Math.floor(Date.now() / 1000)
    try {
      const fresh = this.backtestSpec({ id: row.id, asset: row.asset, tf: row.tf, horizon: row.spec.horizon })
      const decayed = fresh.holdout.winRate < fresh.breakevenWinRate
      if (decayed) {
        this.ctx.bus.emit('alert', {
          level: 'danger',
          message: `[lab] "${row.spec.name}" (${row.id}) [curated - signals kept as-is] looks DECAYED on re-learn - fresh holdout ${fresh.holdout.winRate.toFixed(1)}% vs breakeven ${fresh.breakevenWinRate.toFixed(1)}%. Signals left untouched; any bot trading it was disarmed.`,
          ts: now,
        })
        this.store.saveLabStrategy({ id: row.id, spec: row.spec, asset: row.asset, tf: row.tf, stats: { ...(row.stats ?? {}), backtest: fresh.backtest, holdout: fresh.holdout, breakeven: fresh.breakevenWinRate, decayed: true, decayedTs: now } })
        try {
          const ap = this.ctx.use<AutopilotLike>('autopilot')
          for (const { bot } of ap.listBots()) {
            if (bot.enabled && bot.strategyId === row.id) {
              ap.toggleBot(bot.id, false)
              this.ctx.bus.emit('alert', { level: 'danger', message: `[lab] bot "${bot.name}" AUTO-DISARMED - its curated strategy ${row.id} decayed on re-learn`, ts: now })
            }
          }
        } catch {
          // autopilot not loaded
        }
        return { ok: true, decayed: true }
      }
      // backtestSpec() above already persisted the refreshed backtest/holdout
      // (and preserved curated:true); just clear any stale decayed flag.
      this.store.saveLabStrategy({ id: row.id, spec: row.spec, asset: row.asset, tf: row.tf, stats: { ...(row.stats ?? {}), backtest: fresh.backtest, holdout: fresh.holdout, breakeven: fresh.breakevenWinRate, decayed: false } })
      const prevWr = (row.stats ?? {}).holdout?.winRate
      this.ctx.bus.emit('alert', {
        level: 'info',
        message: `[lab] "${row.spec.name}" (${row.id}) [curated] ${verb} - holdout ${fresh.holdout.winRate.toFixed(1)}%${Number.isFinite(prevWr) ? ` (was ${prevWr!.toFixed(1)}%)` : ''}, ${row.spec.signals.length} signals kept as chosen`,
        ts: now,
      })
      return { ok: true, decayed: false }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.ctx.log('lab', `curated relearn failed for ${row.id}: ${msg}`)
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
    const payout = Math.max(0.5, Math.min(0.95, Number.isFinite(Number(opts.payout)) ? Number(opts.payout) : 0.7))
    // AUDIT FIX (Task 58, P2): Math.max(1, NaN) is NaN - a garbage amount
    // ("abc") used to flow into simFromSeries and produce NaN netPnl /
    // breakeven, which JSON.stringify turned into null IN THE RESPONSE and
    // into the persisted lab stats. Garbage falls back to the defaults.
    const amount = Math.max(1, Number.isFinite(Number(opts.amount)) ? Number(opts.amount) : 10)
    const bars = Math.max(300, Math.min(2200, Math.round(opts.bars ?? 1200)))
    const basis: Basis = opts.basis === 'heikin' || opts.basis === 'kalman' || opts.basis === 'typical' || opts.basis === 'smoothed' ? opts.basis : 'candles'

    const raw = this.market.getCandlesDeep(asset, tf, bars, true) // Task 59: closedOnly
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

    // ---- combo mining: AND/OR confluence of the best single signals ----
    // Up to here, every candidate the learner can select is ONE atomic
    // signal firing alone - a flat ensemble vote, never "Range Sell Zone
    // AND Wide Bear Bar" or "RSI oversold OR Donchian breakout" the way the
    // AI Lab's manual group-builder lets a human construct by hand. Mine
    // the same shape automatically: take a short per-direction shortlist of
    // the best-MEASURED singles (one per family, so this isn't just
    // combining two thresholds of the same indicator), then measure every
    // 2-member AND, 2-member OR, and 3-member AND combination of them
    // exactly like a single signal (same win-rate-after-`horizon`-bars
    // test) and fold the results back into the SAME `measured`/select
    // pipeline below - a combo competes on its own measured edge, with no
    // special-casing, and only wins a slot in the final spec if it's
    // actually better than the atoms it's built from. Bounded to a small
    // shortlist (not the whole candidate pool) because combo count grows
    // combinatorially; disable with mineCombos:false for the old flat-only
    // behavior (or to skip the extra compute on a slow pair/large bar
    // count).
    if (opts.mineCombos !== false) {
      const singleByKey = new Map(candidates.map((c) => [c.key, c]))
      const COMBO_POOL = 10 // shortlist size per direction
      const MIN_COMBO_N = Math.max(10, Math.round(minSamples * 0.6)) // a combo fires less often than either member alone - don't bother measuring one whose base rate is already hopeless
      const comboCandidates: Candidate[] = []
      for (const dir of ['call', 'put'] as const) {
        const seenFam = new Set<string>()
        const pool: Candidate[] = []
        for (const m of measured) {
          if (m.dir !== dir) continue
          const c = singleByKey.get(m.key)
          if (!c) continue
          if (seenFam.has(c.family)) continue
          seenFam.add(c.family)
          pool.push(c)
          if (pool.length >= COMBO_POOL) break
        }
        for (let i = 0; i < pool.length; i++) {
          for (let j = i + 1; j < pool.length; j++) {
            const a = pool[i]
            const b = pool[j]
            for (const op of ['and', 'or'] as const) {
              const def: SignalDef = { kind: 'group', op, signals: [a.def, b.def], dir, weight: 10 }
              const key = `group:${op}:${[a.key, b.key].sort().join('+')}`
              comboCandidates.push({
                key,
                kind: 'group',
                label: labelOf(def),
                dir,
                family: key,
                def,
                test: op === 'and' ? (ii: number) => a.test(ii) && b.test(ii) : (ii: number) => a.test(ii) || b.test(ii),
              })
            }
            // 3-way AND confluence ("multiple ANDs") - skipping a 3-way OR,
            // which just gets noisier/more overlapping without adding a
            // genuinely new idea the way stacking a third confirming
            // condition onto an AND does.
            for (let k = j + 1; k < pool.length; k++) {
              const c3 = pool[k]
              const def3: SignalDef = { kind: 'group', op: 'and', signals: [a.def, b.def, c3.def], dir, weight: 10 }
              const key3 = `group:and:${[a.key, b.key, c3.key].sort().join('+')}`
              comboCandidates.push({
                key: key3,
                kind: 'group',
                label: labelOf(def3),
                dir,
                family: key3,
                def: def3,
                test: (ii: number) => a.test(ii) && b.test(ii) && c3.test(ii),
              })
            }
          }
        }
      }

      if (comboCandidates.length) {
        const comboStats = new Map<string, { n: number; wins: number }>()
        for (let i = warm; i < end; i++) {
          for (const c of comboCandidates) {
            if (!c.test(i)) continue
            const s = comboStats.get(c.key) ?? { n: 0, wins: 0 }
            s.n += 1
            const up = settle[i + horizon] > settle[i]
            const dn = settle[i + horizon] < settle[i]
            if (c.dir === 'call' ? up : dn) s.wins += 1
            comboStats.set(c.key, s)
          }
        }
        for (const c of comboCandidates) {
          const s = comboStats.get(c.key)
          if (!s || s.n < MIN_COMBO_N) continue
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
          candidates.push(c) // so byKey below (built from candidates) resolves combo keys too
        }
        measured.sort((a, b) => b.edgeLB - a.edgeLB || b.n - a.n)
      }
    }

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
    const raw = this.market.getCandlesDeep(asset, tfv, 2200, true) // Task 59: closedOnly
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

  /** Wipes the whole learned-strategy library - every AI Lab spec, not just
   * decayed ones. Does NOT touch anything currently referencing a
   * "custom:<id>" strategy by id (a bot's strategyId, the auto-trader's
   * strategyIds/autoDiscover pool) - those just start failing their
   * isValidStrategyId/runStrategy lookups like any other removed id would,
   * same as deleting one spec at a time already behaves. Caller is
   * responsible for warning the user about that before calling this. */
  removeAll(): { ok: true; removed: number } {
    const removed = this.store.deleteAllLabStrategies()
    this.ctx.bus.emit('alert', {
      level: 'info',
      message: `[lab] learned-strategy library cleared - ${removed} spec(s) removed`,
      ts: Math.floor(Date.now() / 1000),
    })
    return { ok: true, removed }
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
    const candles = this.market.getCandlesDeep(asset, tf, 1500, true) // Task 59: closedOnly
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
    case 'renko':
      // flip-up/down share one family (both directions of the same "young
      // reversal" structure), streak-up/down another - mirrors the mtf
      // convention so the ensemble can't stock both sides of one idea.
      return `renko:${s.variant.replace(/-(up|down)$/, '')}`
    case 'pf':
      // all four breakout patterns are one family - they're rare events
      // (a handful of occurrences per thousand bars) and one P&F slot in
      // the ensemble is the right share
      return 'pf'
    case 'group':
      // groups are hand/AI-authored combinations, not something the miner
      // itself generates as a candidate - key it by its member families so
      // two groups combining the same underlying signals still dedupe.
      return `group:${s.op}:${s.signals.map(familyOf).sort().join('+')}`
    case 'builtin':
      // like groups, a registry-strategy signal is hand-picked (or pasted
      // in via JSON), not something the miner sweeps on its own.
      return `builtin:${s.id}`
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
    case 'renko':
      return `renko:${s.variant}:${s.len ?? ''}:${s.atrPeriod ?? ''}:${s.atrMult ?? ''}:${s.brickSize ?? ''}`
    case 'pf':
      return `pf:${s.variant}:${s.reversalBoxes ?? ''}:${s.atrPeriod ?? ''}:${s.atrMult ?? ''}:${s.boxSize ?? ''}`
    case 'group':
      return `group:${s.op}:${s.dir}:${s.signals.map(candidateKeyOf).join('+')}`
    case 'builtin':
      return `builtin:${s.id}:${s.dir}:${JSON.stringify(s.params ?? {})}`
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
/** Build a per-bar activity test for one signal, substituting the FULL-SERIES
 * candle-hit scan for any 'candle' signal instead of custom.ts's own
 * prepareSignal() - which only ever checks the LAST bar (ctx.hits is "candle
 * patterns on the LAST bar only", built for live evaluation where that's
 * exactly what's wanted). Over a backtest's whole history that single-bar
 * test is false almost everywhere, so without this substitution a candle
 * signal (and any group containing one) would measure as "basically never
 * fires" no matter how often the pattern actually occurred historically -
 * silently wrong backtest numbers, not a signal problem.
 *
 * THE BUG this fixes: the substitution used to happen only for TOP-LEVEL
 * candle signals (a flat .map over spec.signals) - a candle pattern nested
 * inside a GroupSignal (e.g. "Engulfing" AND "RSI < 30") still got custom.ts's
 * tail-bar-only test via the group's own prepareSignal() recursing on its
 * members, so any group with a candle member backtested as if that member
 * almost never fired, skewing the group's measured win rate/trade count. */
function buildBacktestTest(s: SignalDef, ctx: EvalCtx, candleHits: CandleHits): (i: number) => boolean {
  if (s.kind === 'candle') {
    const name = s.name.toLowerCase()
    return (i: number) => candleHits[i]?.get(name) === s.dir
  }
  if (s.kind === 'group') {
    const members = s.signals.map((m) => buildBacktestTest(m, ctx, candleHits))
    return s.op === 'and' ? (i: number) => members.every((fn) => fn(i)) : (i: number) => members.some((fn) => fn(i))
  }
  return prepareSignal(s, ctx)
}

function scoreSeriesFor(
  spec: CustomSpec,
  ctx: EvalCtx,
  candleHits: CandleHits,
): { score: number; votes: number; dir: Side | 'none' }[] {
  const n = ctx.n
  const tests = spec.signals.map((s) => buildBacktestTest(s, ctx, candleHits))
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
  // renko brick structures (see analytics/renko.ts) - flip = young reversal
  // (trend flipped to this side within the last `len` bricks), streak = a
  // same-color run of `len` bricks. Sizing is trailing-ATR per bar, the
  // exact convention the renko-flip builtin trades on, so a learned spec
  // and the standalone strategy agree bar-for-bar.
  { kind: 'renko', variant: 'flip-up', len: 2, dir: 'call', weight: 10 },
  { kind: 'renko', variant: 'flip-down', len: 2, dir: 'put', weight: 10 },
  { kind: 'renko', variant: 'streak-up', len: 3, dir: 'call', weight: 10 },
  { kind: 'renko', variant: 'streak-down', len: 3, dir: 'put', weight: 10 },
  // P&F breakout patterns (see analytics/pointfigure.ts) - fire only on the
  // bar that painted the breakout box. Rare by construction: minSamples
  // usually keeps these out of the ensemble unless the tape genuinely
  // revisits levels, which is exactly when the pattern means something.
  { kind: 'pf', variant: 'double-top-breakout', dir: 'call', weight: 10 },
  { kind: 'pf', variant: 'double-bottom-breakdown', dir: 'put', weight: 10 },
  { kind: 'pf', variant: 'triple-top-breakout', dir: 'call', weight: 10 },
  { kind: 'pf', variant: 'triple-bottom-breakdown', dir: 'put', weight: 10 },
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
  // trending-market pullback (swing HH/HL or LH/LL structure + pullback near
  // the last confirmed swing point) - learnable per-pair counterpart of the
  // trend-structure-pullback builtin strategy. Two flank/leg presets so the
  // learner can pick whichever matches a pair's typical swing size.
  { kind: 'indicator', ind: 'trendpullback', params: { pivotFlank: 3, pullbackAtr: 0.75, minLegAtr: 2 }, op: '>', threshold: 0.05, dir: 'call', weight: 12 },
  { kind: 'indicator', ind: 'trendpullback', params: { pivotFlank: 3, pullbackAtr: 0.75, minLegAtr: 2 }, op: '<', threshold: -0.05, dir: 'put', weight: 12 },
  { kind: 'indicator', ind: 'trendpullback', params: { pivotFlank: 5, pullbackAtr: 1, minLegAtr: 3 }, op: '>', threshold: 0.05, dir: 'call', weight: 12 },
  { kind: 'indicator', ind: 'trendpullback', params: { pivotFlank: 5, pullbackAtr: 1, minLegAtr: 3 }, op: '<', threshold: -0.05, dir: 'put', weight: 12 },
  // ranging-market buy zone / sell zone - the sideways-channel counterpart.
  { kind: 'indicator', ind: 'rangezone', params: { window: 40, rangeThreshold: 0.35, zoneAtr: 0.4 }, op: '>', threshold: 0.05, dir: 'call', weight: 12 },
  { kind: 'indicator', ind: 'rangezone', params: { window: 40, rangeThreshold: 0.35, zoneAtr: 0.4 }, op: '<', threshold: -0.05, dir: 'put', weight: 12 },
  { kind: 'indicator', ind: 'rangezone', params: { window: 60, rangeThreshold: 0.25, zoneAtr: 0.5 }, op: '>', threshold: 0.05, dir: 'call', weight: 12 },
  { kind: 'indicator', ind: 'rangezone', params: { window: 60, rangeThreshold: 0.25, zoneAtr: 0.5 }, op: '<', threshold: -0.05, dir: 'put', weight: 12 },
  // order flow (CLV-based approximation - see analytics/orderflow.ts; no
  // real tick/order-book data exists on this platform) - lets the learner
  // discover whether delta/POC/value-area concepts carry edge on a pair,
  // same as every other family above.
  { kind: 'indicator', ind: 'ofdelta', params: { period: 20 }, op: '>', threshold: 1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'ofdelta', params: { period: 20 }, op: '<', threshold: -1, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'ofcumdelta', params: { lookback: 10, period: 20 }, op: '>', threshold: 1, dir: 'call', weight: 11 },
  { kind: 'indicator', ind: 'ofcumdelta', params: { lookback: 10, period: 20 }, op: '<', threshold: -1, dir: 'put', weight: 11 },
  { kind: 'indicator', ind: 'ofcumdelta', params: { lookback: 20, period: 40 }, op: '>', threshold: 1, dir: 'call', weight: 11 },
  { kind: 'indicator', ind: 'ofcumdelta', params: { lookback: 20, period: 40 }, op: '<', threshold: -1, dir: 'put', weight: 11 },
  { kind: 'indicator', ind: 'ofpocdist', params: { period: 40 }, op: '<', threshold: -1.2, dir: 'call', weight: 11 },
  { kind: 'indicator', ind: 'ofpocdist', params: { period: 40 }, op: '>', threshold: 1.2, dir: 'put', weight: 11 },
  { kind: 'indicator', ind: 'ofvapos', params: { period: 40 }, op: '>', threshold: 1.05, dir: 'call', weight: 11 },
  { kind: 'indicator', ind: 'ofvapos', params: { period: 40 }, op: '<', threshold: -0.05, dir: 'put', weight: 11 },
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
