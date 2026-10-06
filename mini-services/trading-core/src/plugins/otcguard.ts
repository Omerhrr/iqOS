// IQAIR//OS - OTC Guard (the defense layer against generator-driven markets)
//
// PREMISE: OTC pairs don't respect technical analysis - the charts are
// machine-generated (CSPRNG-style feed synthesis), so a pattern that backtests
// beautifully on an OTC pair can be pure luck: the strategy is "finding"
// structure in noise. We do NOT try to study/crack the generator. Instead we
// build a CONTROLLED TRIAL around it:
//
//   1. Calibrate our own chart generator (analytics/synthfeed.ts) on the
//      measured statistics of the exact pair under test (returns distribution
//      via block bootstrap + cadence) - a synthetic twin with the same
//      statistical fingerprints and ZERO learnable structure by construction.
//   2. Run the SAME strategy on the real pair and on K synthetic twins.
//   3. edgeZ = (real win rate - synthetic mean win rate) / synthetic std dev.
//      If real ≈ synthetic, the strategy is "beating the placebo" by nothing -
//      the observed performance is what dumb luck scores on this feed.
//
// VERDICTS: 'edge' (real beats the placebo beyond minEdgeZ sigmas), 'weak'
// (suggestive but under the bar), 'no_edge' (indistinguishable from luck),
// 'inconclusive' (too few real trades to say anything).
//
// ENFORCEMENT: when policy = 'enforce', autonomy (strategy bots in autopilot
// + the os-mode auto-trader) is BLOCKED from opening trades on OTC assets
// unless a fresh 'edge' verdict exists for that (asset, strategy) pair.
// policy = 'warn' lets trades through but stamps a warning. policy = 'off'
// disables the gate entirely. Manual/human trades are NEVER blocked - the
// human is the pilot, this guard only governs the machines (same philosophy
// as the memory gate).
//
// Non-OTC assets are always passed through untouched: real instruments have
// real order flow, and TA is the intended tool there.

import type { Plugin, KernelContext } from '../kernel'
import type { Store } from '../store'
import type { MarketDataService } from './market-data'
import type { Candle, Timeframe } from '../types'
import type { CustomSpec } from '../strategies/custom'
import { normalizeSpec } from '../strategies/custom'
import { fastBacktest } from '../strategies/optimize'
import { calibrateFromCandles, calibrateFromPoints, generateCandles, generatePoints, pointsToCandles, tfSeconds } from '../analytics/synthfeed'

export type OtcPolicy = 'enforce' | 'warn' | 'off'
export type OtcVerdict = 'edge' | 'weak' | 'no_edge' | 'inconclusive'

export interface OtcConfig {
  policy: OtcPolicy
  /** Sigmas the real win rate must clear above the placebo mean to count as 'edge'. */
  minEdgeZ: number
  /** How many synthetic twins to generate per defense run. */
  seriesK: number
  /** Verdict freshness window (days) - stale verdicts stop gating. */
  ttlDays: number
  /** Real backtest must produce at least this many trades for a verdict. */
  minRealTrades: number
}

const DEFAULT_CONFIG: OtcConfig = {
  policy: 'enforce',
  minEdgeZ: 1.5,
  seriesK: 24,
  ttlDays: 7,
  minRealTrades: 10,
}

export interface OtcDefenseReport {
  ok: true
  asset: string
  strategyKey: string
  tf: Timeframe
  isOtc: boolean
  verdict: OtcVerdict
  edgeZ: number
  real: { winRate: number; totalTrades: number; profitFactor: number; expectancy: number; netPnl: number }
  placebo: { series: number; winRateMean: number; winRateStd: number; winRateP95: number; expectancyMean: number }
  calibration: { source: 'tick' | 'candle'; n: number; blockLen: number; seedBase: number; meanAbsStep: number; excessKurtosis: number; driftNeutral: boolean }
  /** Where the tested candles came from: 'live' (real broker feed) or 'sim'
   *  (the sandbox market simulator). A verdict on sim data says something
   *  about the SIMULATOR's structure, not about any real OTC feed - re-run
   *  the defense on live data before trusting an 'edge' verdict. */
  dataMode: 'live' | 'sim'
  config: OtcConfig
  testedAt: number
  /** Human-readable one-liner: what the verdict means for this feed. */
  summary: string
}

/** Anything with these fields the guard can gate on (ScreenRow subset). */
interface GateTarget {
  asset: string
  otc?: boolean
}

export class OtcGuardService {
  private ctx: KernelContext
  private store: Store
  private config: OtcConfig

  constructor(ctx: KernelContext) {
    this.ctx = ctx
    this.store = ctx.use<Store>('store')
    this.config = { ...DEFAULT_CONFIG, ...(this.store.getOtcConfig() as Partial<OtcConfig> | null) }
    // The verdicts table can grow unbounded on repeated runs - keep it tidy.
    this.store.pruneOtcVerdicts(500)
  }

  getConfig(): OtcConfig {
    return { ...this.config }
  }

  setConfig(patch: Partial<OtcConfig>): OtcConfig {
    if (patch.policy !== undefined) {
      const p = String(patch.policy)
      if (p !== 'enforce' && p !== 'warn' && p !== 'off') throw new Error('policy must be enforce | warn | off')
      this.config.policy = p as OtcPolicy
    }
    if (patch.minEdgeZ !== undefined) this.config.minEdgeZ = Math.max(0.5, Math.min(4, Number(patch.minEdgeZ) || DEFAULT_CONFIG.minEdgeZ))
    if (patch.seriesK !== undefined) this.config.seriesK = Math.max(4, Math.min(96, Math.floor(Number(patch.seriesK) || DEFAULT_CONFIG.seriesK)))
    if (patch.ttlDays !== undefined) this.config.ttlDays = Math.max(0.25, Math.min(90, Number(patch.ttlDays) || DEFAULT_CONFIG.ttlDays))
    if (patch.minRealTrades !== undefined) this.config.minRealTrades = Math.max(3, Math.min(200, Math.floor(Number(patch.minRealTrades) || DEFAULT_CONFIG.minRealTrades)))
    this.store.saveOtcConfig(this.config)
    return this.getConfig()
  }

  isOtc(asset: string): boolean {
    try {
      const market = this.ctx.use<MarketDataService>('market')
      const info = market.listAssets().find((a) => a.ticker === asset)
      if (info && typeof info.otc === 'boolean') return info.otc
    } catch {
      // market not loaded - fall back to naming convention
    }
    return asset.toUpperCase().endsWith('-OTC')
  }

  /**
   * THE PLACEBO TEST. Runs the strategy on the real pair, calibrates the
   * generator on that same pair's own feed statistics, generates K synthetic
   * twins, runs the strategy on each, and scores real performance against
   * the placebo distribution. Persists a verdict row on every run.
   */
  async runDefense(input: {
    asset: string
    strategyId: string
    tf?: string
    params?: Record<string, number | string>
    k?: number
    payout?: number
    expiryBars?: number
    limit?: number
    seedBase?: number
    /** Calibrate the placebo on DRIFT-NEUTRAL returns (mean subtracted).
     *  Default placebo inherits the pair's own drift, so drift-following
     *  strategies always read no_edge against it. Run the trial BOTH ways:
     *  default null answers "does the strategy beat its own feed's luck?",
     *  driftNeutral null answers "is the edge the feed's drift itself?". */
    driftNeutral?: boolean
  }): Promise<OtcDefenseReport> {
    const market = this.ctx.use<MarketDataService>('market')
    const asset = String(input.asset || market.activeAsset)
    const tf = (input.tf || '1m') as Timeframe
    const strategyKey = String(input.strategyId || 'confluence')
    const k = Math.max(4, Math.min(96, Math.floor(input.k ?? this.config.seriesK)))
    const limit = Math.max(300, Math.min(2000, input.limit ?? 1000))
    const payout = input.payout ?? 0.85

    // Resolve custom:<id> lab strategies to their spec (same path the
    // autopilot and run_strategy use), so lab-learned strategies can be
    // placebo-tested exactly like builtins.
    let customSpec: CustomSpec | undefined
    if (strategyKey.startsWith('custom:')) {
      const row = this.store.listLabStrategies().find((r) => r.id === strategyKey)
      if (!row) throw new Error(`unknown lab strategy ${strategyKey}`)
      customSpec = normalizeSpec(row.spec, row.id) ?? undefined
      if (!customSpec) throw new Error(`lab strategy ${strategyKey} has no usable signals`)
    }

    // ---- real side ----
    // OTC trials MUST read the broker's own feed: kernel memory can hold
    // sim-seeded history for assets the UI never opened (fresh boot = sim
    // feed until adoption), which would silently test the SIMULATOR. For
    // any asset other than the active one, a fresh sidecar pull is the
    // honest source; memory remains the fallback.
    let realCandles: Candle[]
    if (asset !== market.activeAsset) {
      realCandles = await market.fetchSidecarCandles(asset, tf, Math.min(1000, limit))
      if (realCandles.length < 120) realCandles = market.getCandles(asset, tf, limit)
    } else {
      realCandles = market.getCandles(asset, tf, limit)
    }
    if (realCandles.length < 120) throw new Error(`thin history on ${asset} ${tf} (${realCandles.length} candles) - warm the feed first`)
    const real = fastBacktest(realCandles, strategyKey, input.params ?? {}, {
      payout,
      expiryBars: input.expiryBars,
      customSpec,
    })

    // ---- calibration: the finest data we have for THIS pair ----
    // Sample size is aligned to the real test either way: the placebo must
    // face the SAME number of candles as the real backtest, or the win-rate
    // comparison is apples-to-oranges.
    let calPoints: { time: number; price: number }[] = []
    let calSource: 'tick' | 'candle' = 'candle'
    try {
      const tick = await market.getTickSeries(asset)
      if (tick.dataSource === 'tick' && tick.points.length >= 200) {
        calPoints = tick.points
        calSource = 'tick'
      }
    } catch {
      // sidecar unreachable - candle closes are the honest fallback
    }
    const tfSec = tfSeconds(tf)
    const seedBase = input.seedBase ?? (Math.floor(Date.now() / 1000) % 2147483647)
    let calibration
    let synthSeries: Candle[][] = []
    let blockLen = 4
    let nPoints = 0 // tick path: points per generated twin (hoisted for the widen-retry)
    if (calSource === 'tick') {
      calibration = calibrateFromPoints(calPoints, { blockLen: 8, source: 'tick', driftNeutral: input.driftNeutral })
      blockLen = 8
      // points per candle so the aggregated twins match the real bar count
      const perCandle = Math.max(1, Math.round(realCandles.length / Math.max(1, Math.round((calPoints[calPoints.length - 1].time - calPoints[0].time) / tfSec))))
      nPoints = Math.min(8000, realCandles.length * perCandle + perCandle)
      for (let i = 0; i < k; i++) {
        const pts = generatePoints(calibration, nPoints, (seedBase + i * 7919) >>> 0)
        synthSeries.push(pointsToCandles(pts, tfSec))
      }
    } else {
      calibration = calibrateFromCandles(realCandles, { blockLen: 8, driftNeutral: input.driftNeutral })
      blockLen = 8
      for (let i = 0; i < k; i++) {
        synthSeries.push(generateCandles(calibration, realCandles.length, (seedBase + i * 7919) >>> 0, tfSec))
      }
    }

    // ---- placebo side: K synthetic twins, identical strategy ----
    // Strict strategies can legitimately produce 0 trades on most random-walk
    // twins, and one degenerate twin throwing shouldn't kill the trial - but
    // BOTH cases used to be silently swallowed into a generic 400. Collect
    // the failure reasons, widen the placebo panel once (3x twins, fresh
    // seeds) when it comes up short, and only then fail with a DIAGNOSTIC
    // message that says what actually happened on the real feed.
    const collectPlacebo = (series: Candle[][]): { winRates: number[]; expectancies: number[]; zeroTrade: number; errors: string[] } => {
      const winRates: number[] = []
      const expectancies: number[] = []
      let zeroTrade = 0
      const errors: string[] = []
      for (const synthCandles of series) {
        if (synthCandles.length < 120) {
          zeroTrade++
          continue
        }
        try {
          const m = fastBacktest(synthCandles, strategyKey, input.params ?? {}, {
            payout,
            expiryBars: input.expiryBars,
            customSpec,
          })
          if (m.totalTrades > 0) {
            winRates.push(m.winRate)
            expectancies.push(m.expectancy)
          } else {
            zeroTrade++
          }
        } catch (e) {
          errors.push(e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120))
        }
      }
      return { winRates, expectancies, zeroTrade, errors }
    }

    let placebo = collectPlacebo(synthSeries)
    if (placebo.winRates.length < 4) {
      // widen once: 3x twins with brand-new seeds - a strict strategy or an
      // unlucky seed batch shouldn't sink the trial when more sampling fixes it
      const wideK = Math.min(96, k * 3)
      synthSeries = []
      for (let i = 0; i < wideK; i++) {
        const seed = (seedBase + 104729 + i * 7919) >>> 0
        if (calSource === 'tick') {
          const pts = generatePoints(calibration, nPoints, seed)
          synthSeries.push(pointsToCandles(pts, tfSec))
        } else {
          synthSeries.push(generateCandles(calibration, realCandles.length, seed, tfSec))
        }
      }
      placebo = collectPlacebo(synthSeries)
    }
    if (placebo.winRates.length < 4) {
      const topError = placebo.errors[0] ? ` first twin error: "${placebo.errors[0]}"${placebo.errors.length > 1 ? ` (+${placebo.errors.length - 1} more)` : ''}` : ''
      throw new Error(
        `placebo panel too thin: ${placebo.winRates.length}/${synthSeries.length} twins produced trades ` +
          `(${placebo.zeroTrade} zero-trade, ${placebo.errors.length} errored${topError}). ` +
          `Real feed gave ${real.totalTrades} trades over ${realCandles.length} candles - ` +
          `the strategy is likely too strict for this pair/tf (${tf}); try a lower tf, looser params, or a different strategy`,
      )
    }

    const wrMean = mean(placebo.winRates)
    const wrStd = Math.max(std(placebo.winRates), 0.01) // floor: identical wr on every twin shouldn't zero the z-score
    const edgeZ = (real.winRate - wrMean) / wrStd
    const sorted = [...placebo.winRates].sort((a, b) => a - b)
    const wrP95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]

    let verdict: OtcVerdict
    if (real.totalTrades < this.config.minRealTrades) verdict = 'inconclusive'
    else if (edgeZ >= this.config.minEdgeZ) verdict = 'edge'
    else if (edgeZ >= 0.8) verdict = 'weak'
    else verdict = 'no_edge'

    const isOtc = this.isOtc(asset)
    // fastBacktest reports win rates in PERCENTAGE POINTS (58.26 = 58.26%) -
    // format directly, never ×100.
    const pct = (x: number) => `${x.toFixed(1)}%`
    let summary =
      verdict === 'edge'
        ? `Real ${pct(real.winRate)} beats the ${placebo.winRates.length}-twin placebo (mean ${pct(wrMean)}, p95 ${pct(wrP95)}) by ${edgeZ.toFixed(2)} sigma - performance is unlikely to be pure chance${isOtc ? ', even on this generator-driven feed' : ''}.`
        : verdict === 'weak'
          ? `Real ${pct(real.winRate)} vs placebo mean ${pct(wrMean)} (+${edgeZ.toFixed(2)} sigma) - suggestive but under the ${this.config.minEdgeZ}σ 'edge' bar; treat as unproven.`
          : verdict === 'no_edge'
            ? `Real ${pct(real.winRate)} is statistically indistinguishable from the placebo mean ${pct(wrMean)} (+${edgeZ.toFixed(2)} sigma) - on this feed the strategy performs like luck${isOtc ? ', exactly what a generator-driven chart should produce' : ''}. TA claims are not supported here.`
            : `Only ${real.totalTrades} real trades (need ${this.config.minRealTrades}) - no verdict possible yet.`
    if (input.driftNeutral) summary += ' [DRIFT-NEUTRAL placebo: an edge here means the strategy beats a drift-FREE twin of this feed - on a drifting OTC feed that is the honest test of whether the edge IS the drift]'
    if (market.mode === 'sim') summary += ' [SIMULATOR DATA - this verdict reflects the sim engine\'s own structure, not a real OTC feed; re-run on live data before trusting an "edge"]'

    const report: OtcDefenseReport = {
      ok: true,
      asset,
      strategyKey,
      tf,
      isOtc,
      verdict,
      edgeZ,
      real: {
        winRate: real.winRate,
        totalTrades: real.totalTrades,
        profitFactor: real.profitFactor,
        expectancy: real.expectancy,
        netPnl: real.netPnl,
      },
      placebo: {
        series: placebo.winRates.length,
        winRateMean: wrMean,
        winRateStd: wrStd,
        winRateP95: wrP95,
        expectancyMean: mean(placebo.expectancies),
      },
      calibration: {
        source: calSource,
        n: calSource === 'tick' ? calPoints.length : realCandles.length,
        blockLen,
        seedBase,
        meanAbsStep: calibration.stepStats.meanAbsStep,
        excessKurtosis: calibration.stepStats.excessKurtosis,
        driftNeutral: !!input.driftNeutral,
      },
      dataMode: market.mode,
      config: this.getConfig(),
      testedAt: Math.floor(Date.now() / 1000),
      summary,
    }

    this.store.saveOtcVerdict({
      asset,
      strategyKey,
      tf,
      verdict,
      edgeZ,
      realWinRate: real.winRate,
      realTrades: real.totalTrades,
      placeboWrMean: wrMean,
      placeboWrStd: wrStd,
      placeboSeries: placebo.winRates.length,
      calibrationSource: calSource,
      report,
    })
    this.ctx.log('otcguard', `${asset} × ${strategyKey}: ${verdict} (edgeZ ${edgeZ.toFixed(2)}, real ${pct(real.winRate)} vs placebo ${pct(wrMean)} ± ${pct(wrStd)}, ${calSource} calibration)`)
    return report
  }

  /**
   * Pre-trade gate for the machines. Cheap: reads persisted verdicts, never
   * computes. Returns ok:false only when it should actually BLOCK.
   */
  check(target: GateTarget, strategyKey: string): { ok: boolean; reason?: string; note?: string } {
    const isOtc = typeof target.otc === 'boolean' ? target.otc : this.isOtc(target.asset)
    if (!isOtc) return { ok: true } // real instruments: TA is the intended tool
    if (this.config.policy === 'off') return { ok: true }
    const fresh = this.store.latestOtcVerdict(target.asset, strategyKey, this.config.ttlDays * 86400)
    if (this.config.policy === 'warn') {
      return fresh
        ? { ok: true, note: `OTC ${fresh.verdict} (edgeZ ${fresh.edgeZ.toFixed(2)})` }
        : { ok: true, note: 'OTC feed, never placebo-tested - TA unverified on generator-driven charts' }
    }
    // enforce
    if (!fresh) {
      return {
        ok: false,
        reason: `OTC defense: ${target.asset} is a generator-driven feed and ${strategyKey} has no passing placebo test - run /otc_defense_run first (or set policy warn/off)`,
      }
    }
    if (fresh.verdict === 'edge') return { ok: true, note: `OTC edge verified (${fresh.edgeZ.toFixed(2)}σ)` }
    return {
      ok: false,
      reason: `OTC defense: ${strategyKey} on ${target.asset} scored '${fresh.verdict}' vs its synthetic placebo (edgeZ ${fresh.edgeZ.toFixed(2)}) - performance is indistinguishable from chance on generator-driven charts`,
    }
  }

  listVerdicts(limit = 50) {
    return this.store.listOtcVerdicts(limit)
  }

  statusFor(asset: string, strategyKey: string) {
    return {
      asset,
      strategyKey,
      isOtc: this.isOtc(asset),
      policy: this.config.policy,
      verdict: this.store.latestOtcVerdict(asset, strategyKey, this.config.ttlDays * 86400),
    }
  }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
}

export const otcGuardPlugin: Plugin = {
  name: 'otcguard',
  start(ctx) {
    const svc = new OtcGuardService(ctx)
    ctx.provide('otcGuard', svc)
    const c = svc.getConfig()
    ctx.log('otcguard', `OTC defense online - policy ${c.policy}, minEdgeZ ${c.minEdgeZ}σ, ${c.seriesK} placebo twins/verdict, TTL ${c.ttlDays}d`)
  },
  stop() {},
}
