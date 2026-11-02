// IQAIR//OS - Next-Candle Oracle plugin
//
// Wraps analytics/nextcandle.ts's fused prediction with the same honesty
// plumbing the chart-signals / lead-lag scanners use: every prediction the
// panel issues is TRACKED, and when the target candle closes the tracker
// resolves it (win/loss vs the predicted direction, Brier score vs the
// predicted probability). The rolling record (hit rate + Brier over the
// last N resolved predictions per asset:tf) is fed BACK into the next
// prediction's confidence - an oracle that has been wrong lately speaks
// more humbly, and the panel shows the record next to the forecast.
//
// Pending predictions are deduped per (asset, tf, targetBarTime): re-polls
// inside the same forming bar replace the pending entry instead of stacking
// duplicates (same rule as SignalOutcomeTracker). Resolved records persist
// to data/nextcandle_outcomes.json so a kernel restart keeps the track
// record - same durability contract as plugins/chartsignals.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { Candle, Timeframe } from '../types'
import { pairKey, predictNextCandle, setOracleCalibrationProvider, type NextCandlePrediction, type OracleRegime } from '../analytics/nextcandle'
import { setPatternReliabilityProvider } from '../analytics/patterns'
import { weightedHitRate, weightedMean, weightedMeanBy } from '../analytics/recencystats'
import { classifySession, type Session } from '../analytics/session'
import type { MarketDataService } from './market-data'

const MAX_RESOLVED = 800
const CALIBRATION_WINDOW = 120 // rolling record length fed back into confidence
/** min resolved rows (per-driver, or per asset:tf:regime bucket) before its
 * record is trusted enough to adjust anything - thin records are no record,
 * same floor philosophy applyCalibrationDiscount already uses (n>=20). */
const DRIVER_STATS_MIN_N = 30
const DRIVER_STATS_WINDOW = 250
/** same "thin record is no record" floor, applied per PATTERN NAME instead
 * of per driver - a pattern that's barely ever fired keeps its hand-set
 * reliability until it has. */
const PATTERN_STATS_MIN_N = 25
const PATTERN_STATS_WINDOW = 400
/** min resolved rows before a driver PAIR's agreement rate is trusted for
 * driverCorrelationTable() - a thin pair shouldn't get discounted off one
 * lucky/unlucky coincidence of agreement. */
const PAIR_CORR_MIN_N = 30
const PAIR_CORR_WINDOW = 400
/** min resolved rows before learnedConfidenceBlendWeight() trusts its own
 * sweep - this one re-derives a synthetic "would-be confidence" per row,
 * which is noisier than a plain hit-rate average, so it wants more samples
 * than the other DRIVER_STATS_MIN_N=30-style floors before committing. */
const BLEND_WEIGHT_MIN_N = 60
const BLEND_WEIGHT_WINDOW = 400
const BLEND_WEIGHT_CANDIDATES = [0.35, 0.45, 0.5, 0.55, 0.65, 0.75]
/** THIS PAIR'S OWN counterpart to BLEND_WEIGHT_MIN_N - necessarily smaller,
 * same "pair physiology" reasoning as PAIR_DRIVER_STATS_MIN_N above: one
 * pair accumulates qualifying rows (real driver snapshots, non-flat,
 * 4+ drivers fired) far slower than the whole universe blended together. */
const PAIR_BLEND_WEIGHT_MIN_N = 35
/** THIS PAIR'S OWN counterpart to PATTERN_STATS_MIN_N - same reasoning,
 * smaller floor since one pair's own pattern hits are rarer than the
 * universe-wide pool. */
const PAIR_PATTERN_STATS_MIN_N = 14
const PAIR_PATTERN_STATS_WINDOW = 600
/** "Pair physiology" floors: the per-asset:tf counterparts of
 * DRIVER_STATS_MIN_N/WINDOW and PAIR_CORR_MIN_N/WINDOW above, necessarily
 * smaller than the universe-wide ones - one pair accumulates resolved
 * predictions far slower than the whole universe blended together, so
 * demanding the same sample size would mean these per-pair tables never
 * actually trigger. Still a real floor, not zero - "thin record is no
 * record" applies here too, just calibrated to what one pair alone can
 * realistically produce. Deliberately uses a WIDER window than the
 * universe-wide DRIVER_STATS_WINDOW (same reasoning
 * driverWeightMultipliersByRegime() already uses *2) since a per-pair,
 * per-regime split sees even fewer rows per bucket. */
const PAIR_DRIVER_STATS_MIN_N = 18
const PAIR_DRIVER_STATS_WINDOW = 500
const PAIR_CORR_PAIR_MIN_N = 18
const PAIR_CORR_PAIR_WINDOW = 600
/** "Cluster physiology" floors: an intermediate tier between one pair's own
 * thin history and the full universe blend, grouping resolved rows by
 * asset CATEGORY (plus OTC vs non-OTC - see clusterKeyFor()) instead of by
 * exact ticker. A whole asset class accumulates resolved history faster
 * than any one pair but still has its own character distinct from the
 * universe blend (e.g. crypto's volatility physiology vs. a forex major's),
 * so this floor sits between PAIR_DRIVER_STATS_MIN_N and DRIVER_STATS_MIN_N -
 * stricter than the pair floor (a cluster's thin sample is less excusable
 * than one pair's) but still looser than the full-universe floor. */
const CLUSTER_DRIVER_STATS_MIN_N = 24
const CLUSTER_DRIVER_STATS_WINDOW = 500
const CLUSTER_CORR_PAIR_MIN_N = 24
const CLUSTER_CORR_PAIR_WINDOW = 600
const OUTCOME_FILE = 'nextcandle_outcomes.json'
/** Next Global board: a scanned row older than this is recomputed on the
 * next poll. Deliberately short - one prediction is ~15ms so a full board
 * refresh is cheap, but the TTL keeps N simultaneous panels from fusing
 * the same pair twice inside one forming bar. */
const GLOBAL_SCAN_TTL_MS = 12_000

interface PendingPrediction {
  asset: string
  tf: string
  targetBarTime: number
  issuedTs: number
  pUp: number
  direction: 'call' | 'put' | 'none'
  confidence: number
  price: number
  /** the regime this prediction was issued under - carried through to the
   * resolved record so the honesty loop can split calibration by regime. */
  regime: OracleRegime
  /** lightweight per-driver read at issue time (name + signed vote only,
   * not the full OracleDriver) - carried through to the resolved record so
   * each model's OWN accuracy can be tracked independently of the fused
   * outcome. `pUp` (this driver's own probability read, pre-fusion) feeds
   * driverCalibrationMultipliers()'s Brier-based quality weighting and
   * driverCorrelationTable()'s pairwise agreement learning - neither
   * existed before this round, when only the sign (`vote`) was kept. */
  drivers: { name: string; vote: number; pUp: number }[]
  /** which candle patterns fired this read (name + direction) - carried
   * through to the resolved record so each PATTERN's own live reliability
   * can be learned, independent of the fused outcome and of the driver
   * accuracy above (see patternReliabilityTable()). */
  patternHits: { name: string; direction: 'bullish' | 'bearish' | 'neutral' }[]
  /** this read's own predicted magnitude (price units) - carried through
   * to the resolved record so the REALIZED move can be checked against it
   * (see magnitudeCalibrationFor()), the one estimate in this fusion that
   * was never checked against reality before. */
  expectedMove: number
  /** this read's own predicted candle SHAPE (body-ratio + close-position,
   * the same geometry expectedCandleType is classified from) - carried
   * through to the resolved record so the REALIZED shape can be checked
   * against it (see shapeCalibrationFor()), the other estimate besides
   * magnitude that nothing checked against reality until now. */
  bodyRatio: number
  closePos: number
}

export interface ResolvedPrediction {
  asset: string
  tf: string
  targetBarTime: number
  issuedTs: number
  resolvedTs: number
  predicted: 'call' | 'put' | 'none'
  pUp: number
  confidence: number
  entry: number
  exit: number
  /** realized direction of the candle: 'up' | 'down' | 'flat' (doji at same close) */
  actual: 'up' | 'down' | 'flat'
  hit: boolean
  /** 1 if predicted direction realized, 0 otherwise (flat counts against both) */
  score: number
  /** Brier contribution: (pUp - realizedUp)² with realizedUp 1/0 (flat=0.5->0.25) */
  brier: number
  /** regime this prediction was issued under - feeds regimeCalibrationFor() */
  regime: OracleRegime
  /** per-driver votes + own pUp at issue time, carried through for
   * driverWeightMultipliers()/driverCalibrationMultipliers()/
   * driverCorrelationTable(). */
  drivers: { name: string; vote: number; pUp: number }[]
  /** pattern hits at issue time, carried through for patternReliabilityTable() */
  patternHits: { name: string; direction: 'bullish' | 'bearish' | 'neutral' }[]
  /** predicted magnitude at issue time - feeds magnitudeCalibrationFor() against |exit-entry| */
  expectedMove: number
  /** predicted shape at issue time - feeds shapeCalibrationFor() against
   * the resolved candle's own realized body-ratio/close-position. */
  predBodyRatio: number
  predClosePos: number
  /** the resolved candle's own REALIZED shape - computed once at
   * resolution from the actual OHLC, not re-derived anywhere else. */
  realizedBodyRatio: number
  realizedClosePos: number
}

export interface GlobalScanRow {
  asset: string
  tf: string
  /** when this row's fused read was computed (0 = never, warming up) */
  computedTs: number
  /** the bar this prediction targets - the currently forming candle whose
   * close will resolve it. Tempo (plugins/tempo.ts) windows its 10-bar
   * hunting licenses on this bar, so consumers know WHICH bar a read is
   * about without re-deriving it. */
  targetBarTime: number
  /** true = a live prediction; false = thin/no history on this pair yet */
  ok: boolean
  note: string
  pUp: number
  direction: 'call' | 'put' | 'none'
  confidence: number
  rawConfidence: number
  regime: string
  price: number
  expectedMove: number
  atr: number
  driversActive: number
  calibration: { n: number; hitRate: number; brier: number } | null
  /** signed vote in [-1, 1] from the fusion's own "Renko bricks" driver,
   * 0 when that driver wasn't active this bar (no brick painted yet) -
   * a passthrough of a read the fusion already computed, not a second
   * calculation, so Tempo (plugins/tempo.ts) can treat it as one more
   * independent input without re-deriving Renko itself. */
  renkoVote: number
  /** same passthrough for the fusion's "Footprint" driver. */
  footprintVote: number
  /** plain-language label for the kind of candle shape this geometry
   * implies - passthrough of predictNextCandle()'s own classification,
   * so a consumer built on top of the Oracle (Tempo, Accute) can surface
   * it without recomputing bodyRatio/closePos itself. */
  expectedCandleType: string
}

export interface GlobalScanResult {
  tf: string
  scannedTs: number
  universe: number
  scanned: number
  live: number
  warming: number
  /** refresh=1 forced every row's recompute, not just stale ones */
  refreshed: number
  rows: GlobalScanRow[]
}

export class NextCandleService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private pending = new Map<string, PendingPrediction>()
  private resolved: ResolvedPrediction[] = []
  private unsub: (() => void) | null = null

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.restore()
    // resolve pending predictions on candle close - the same bus event the
    // whole settlement stack listens to
    this.unsub = ctx.bus.on('candle', ({ asset, tf, candle, closed }) => {
      if (!closed) return
      this.resolveFor(asset, tf, candle)
    })
    // bridge the honesty record into the strategy layer: oracle-fusion bot
    // evals read this so the confidence gate tightens when the oracle has
    // been wrong on exactly this pair+tf (see analytics/nextcandle.ts)
    setOracleCalibrationProvider((asset, tf) => this.calibrationFor(asset, tf))
    // same bridge shape, one level down: learned per-PATTERN reliability,
    // live everywhere patternBias() is called codebase-wide (see
    // analytics/patterns.ts's provider bridge doc).
    setPatternReliabilityProvider(() => this.patternReliabilityTable())
    ctx.log('nextcandle', 'next-candle oracle online (multi-model fusion + self-calibration honesty loop + learned pattern reliability)')
  }

  stop(): void {
    this.unsub?.()
    this.persist()
  }

  /** Issue (or refresh) the prediction for asset/tf and track it. */
  predict(asset: string, tf: string): NextCandlePrediction | null {
    const candles: Candle[] = this.market.getCandlesDeep(asset, tf as never, 1500, true)
    const cal = this.calibrationFor(asset, tf)
    const currentSession = classifySession(Math.floor(Date.now() / 1000), asset)
    const pred = predictNextCandle(candles, {
      asset,
      tf,
      mode: this.market.mode,
      calibration: cal,
      regimeCalibration: this.regimeCalibrationFor(asset, tf),
      sessionCalibration: this.sessionCalibrationFor(asset, tf)[currentSession] ?? null,
      directionCalibration: this.directionCalibrationFor(asset, tf),
      driverWeightMultipliers: this.driverWeightMultipliers(),
      regimeDriverWeightMultipliers: this.driverWeightMultipliersByRegime(),
      pairDriverWeightMultipliers: this.pairDriverWeightMultipliers(asset, tf),
      pairRegimeDriverWeightMultipliers: this.pairDriverWeightMultipliersByRegime(asset, tf),
      clusterDriverWeightMultipliers: this.clusterDriverWeightMultipliers(asset),
      clusterRegimeDriverWeightMultipliers: this.clusterDriverWeightMultipliersByRegime(asset),
      driverCalibrationMultipliers: this.driverCalibrationMultipliers(),
      pairDriverCalibrationMultipliers: this.pairDriverCalibrationMultipliers(asset, tf),
      clusterDriverCalibrationMultipliers: this.clusterDriverCalibrationMultipliers(asset),
      driverCorrelation: this.driverCorrelationTable(),
      pairDriverCorrelation: this.pairDriverCorrelationTable(asset, tf),
      clusterDriverCorrelation: this.clusterDriverCorrelationTable(asset),
      confidenceBlendWeight: this.learnedConfidenceBlendWeight(),
      pairConfidenceBlendWeight: this.pairLearnedConfidenceBlendWeight(asset, tf),
      pairPatternReliability: this.pairPatternReliabilityTable(asset, tf),
      magnitudeCalibration: this.magnitudeCalibrationFor(asset, tf),
      shapeCalibration: this.shapeCalibrationFor(asset, tf),
    })
    if (!pred) return null
    const key = `${asset}:${tf}:${pred.targetBarTime}`
    // dedupe: replace the pending entry for the same target bar - a re-poll
    // inside the same forming bar is a refresh, not a second bet
    this.pending.set(key, {
      asset,
      tf,
      targetBarTime: pred.targetBarTime,
      issuedTs: Date.now(),
      pUp: pred.pUp,
      direction: pred.direction,
      confidence: pred.confidence,
      price: pred.price,
      regime: pred.regime,
      drivers: pred.drivers.map((d) => ({ name: d.name, vote: d.vote, pUp: d.pUp })),
      patternHits: pred.patternHits,
      expectedMove: pred.expectedMove,
      bodyRatio: pred.bodyRatio,
      closePos: pred.closePos,
    })
    if (this.pending.size > 400) {
      // drop the oldest fifth - pending entries resolve on candle close anyway
      const keys = [...this.pending.keys()].slice(0, 80)
      for (const k of keys) this.pending.delete(k)
    }
    return pred
  }

  /** Resolve every pending prediction whose target bar just closed. */
  private resolveFor(asset: string, tf: string, candle: Candle): void {
    const prefix = `${asset}:${tf}:`
    for (const [key, p] of this.pending) {
      if (!key.startsWith(prefix)) continue
      if (p.targetBarTime !== candle.time) continue
      this.pending.delete(key)
      const diff = candle.close - p.price
      const actual: ResolvedPrediction['actual'] = Math.abs(diff) < 1e-12 ? 'flat' : diff > 0 ? 'up' : 'down'
      const predicted = p.direction === 'none' ? (p.pUp >= 0.5 ? 'call' : 'put') : p.direction // 'none' still implies a lean via pUp
      const hit = predicted === 'call' ? actual === 'up' : predicted === 'put' ? actual === 'down' : false
      const realizedUp = actual === 'up' ? 1 : actual === 'down' ? 0 : 0.5
      // realized SHAPE of the resolving candle itself - the same two
      // numbers expectedCandleType is classified from, computed fresh from
      // the actual OHLC (never re-derived anywhere else). Guard against a
      // zero-range bar (high===low) with a tiny epsilon rather than NaN.
      const range = Math.max(candle.high - candle.low, 1e-9)
      const realizedBodyRatio = Math.min(1, Math.max(0, Math.abs(candle.close - candle.open) / range))
      const realizedClosePos = Math.min(1, Math.max(0, (candle.close - candle.low) / range))
      const entry: ResolvedPrediction = {
        asset,
        tf,
        targetBarTime: p.targetBarTime,
        issuedTs: p.issuedTs,
        resolvedTs: Date.now(),
        predicted,
        pUp: p.pUp,
        confidence: p.confidence,
        entry: p.price,
        exit: candle.close,
        actual,
        hit,
        score: hit ? 1 : 0,
        brier: (p.pUp - realizedUp) * (p.pUp - realizedUp),
        regime: p.regime,
        drivers: p.drivers,
        patternHits: p.patternHits,
        expectedMove: p.expectedMove,
        predBodyRatio: p.bodyRatio,
        predClosePos: p.closePos,
        realizedBodyRatio,
        realizedClosePos,
      }
      this.resolved.push(entry)
      while (this.resolved.length > MAX_RESOLVED) this.resolved.shift()
      this.persist()
    }
  }

  /** Rolling record for one asset:tf, windowed to CALIBRATION_WINDOW.
   * Recency-weighted (see analytics/recencystats.ts): a loss streak from
   * weeks ago no longer holds the discount down once the pair has clearly
   * turned around - the discount now tracks a real accuracy shift within
   * roughly a half-life's worth of fresh resolutions instead of waiting
   * for the whole flat window to roll over. */
  calibrationFor(asset: string, tf: string): { n: number; hitRate: number; brier: number } | null {
    const rows = this.resolved.filter((r) => r.asset === asset && r.tf === tf).slice(-CALIBRATION_WINDOW)
    if (rows.length === 0) return null
    const hitRate = weightedMeanBy(rows, (r) => r.score)
    const brier = weightedMeanBy(rows, (r) => r.brier)
    return { n: rows.length, hitRate, brier }
  }

  /** Same rolling record as calibrationFor(), split one bucket per regime -
   * lets predictNextCandle discount confidence using "how honest am I
   * specifically on TRENDING bars for this pair" instead of one number
   * blended across every regime it's ever seen. Buckets below
   * DRIVER_STATS_MIN_N/2 (a regime sees fewer resolutions than the pair
   * overall, so the bar is lower) are omitted entirely - predictNextCandle
   * already falls back to the blended record when a regime key is absent. */
  private regimeCalibrationFor(asset: string, tf: string): Partial<Record<OracleRegime, { n: number; hitRate: number; brier: number }>> {
    const rows = this.resolved.filter((r) => r.asset === asset && r.tf === tf).slice(-CALIBRATION_WINDOW * 2)
    const out: Partial<Record<OracleRegime, { n: number; hitRate: number; brier: number }>> = {}
    const regimes: OracleRegime[] = ['TRENDING', 'RANGING', 'VOLATILE', 'MIXED']
    for (const regime of regimes) {
      const rs = rows.filter((r) => r.regime === regime)
      if (rs.length < 20) continue
      out[regime] = {
        n: rs.length,
        hitRate: weightedMeanBy(rs, (r) => r.score),
        brier: weightedMeanBy(rs, (r) => r.brier),
      }
    }
    return out
  }

  /** Session-bucketed rolling record (classifySession - ASIA/LONDON/
   * OVERLAP/NEWYORK/OFF/OTC), same shape and same "n>=20" floor as
   * regimeCalibrationFor() above. A pair that's honestly calibrated
   * overall can still be systematically over-confident in the thin OFF
   * hours or under-confident during the London/NY OVERLAP - this catches
   * that without needing a separate regime bucket per session. Checked
   * AFTER regime (the stronger, already-proven split) and BEFORE the
   * direction fallback in predictNextCandle's preference order. */
  private sessionCalibrationFor(asset: string, tf: string): Partial<Record<Session, { n: number; hitRate: number; brier: number }>> {
    const rows = this.resolved.filter((r) => r.asset === asset && r.tf === tf).slice(-CALIBRATION_WINDOW * 2)
    const out: Partial<Record<Session, { n: number; hitRate: number; brier: number }>> = {}
    const bySession = new Map<Session, ResolvedPrediction[]>()
    for (const r of rows) {
      const session = classifySession(Math.floor(r.issuedTs / 1000), asset)
      const list = bySession.get(session) ?? []
      list.push(r)
      bySession.set(session, list)
    }
    for (const [session, rs] of bySession) {
      if (rs.length < 20) continue
      out[session] = {
        n: rs.length,
        hitRate: weightedMeanBy(rs, (r) => r.score),
        brier: weightedMeanBy(rs, (r) => r.brier),
      }
    }
    return out
  }

  /** Same rolling record as calibrationFor(), split one bucket per
   * PREDICTED DIRECTION instead of regime - catches an oracle that's
   * quietly worse at calling puts than calls on this pair, which the
   * regime-blended and all-blended records both hide. Used only as a
   * fallback when regimeCalibrationFor()'s own bucket for the read's
   * regime is thin - see analytics/nextcandle.ts's preference order. */
  private directionCalibrationFor(asset: string, tf: string): Partial<Record<'call' | 'put', { n: number; hitRate: number; brier: number }>> {
    const rows = this.resolved.filter((r) => r.asset === asset && r.tf === tf).slice(-CALIBRATION_WINDOW * 2)
    const out: Partial<Record<'call' | 'put', { n: number; hitRate: number; brier: number }>> = {}
    for (const dir of ['call', 'put'] as const) {
      const rs = rows.filter((r) => r.predicted === dir)
      if (rs.length < 20) continue
      out[dir] = {
        n: rs.length,
        hitRate: weightedMeanBy(rs, (r) => r.score),
        brier: weightedMeanBy(rs, (r) => r.brier),
      }
    }
    return out
  }

  /** Per-driver win rate across the WHOLE universe (not per asset:tf - a
   * driver's reliability is a property of the model, not one pair), fed
   * back as a weight multiplier: a driver sitting meaningfully above 50%
   * hit rate over a real sample gets upweighted, one sitting below gets
   * downweighted, on top of the static regime boosts each driver already
   * carries in analytics/nextcandle.ts. */
  private driverWeightMultipliers(): Record<string, number> {
    const window = this.resolved.slice(-DRIVER_STATS_WINDOW)
    const byName = new Map<string, { calls: boolean[] }>()
    for (const r of window) {
      const realizedUpSign = r.actual === 'up' ? 1 : r.actual === 'down' ? -1 : 0
      if (realizedUpSign === 0) continue // flat bars don't score any driver
      for (const d of r.drivers ?? []) {
        const s = byName.get(d.name) ?? { calls: [] }
        s.calls.push(Math.sign(d.vote) === realizedUpSign)
        byName.set(d.name, s)
      }
    }
    const out: Record<string, number> = {}
    for (const [name, s] of byName) {
      if (s.calls.length < DRIVER_STATS_MIN_N) continue
      const winRate = weightedHitRate(s.calls, (hit) => hit).hitRate
      out[name] = Math.max(0.75, Math.min(1.3, 0.75 + (winRate - 0.5) * 2.5))
    }
    return out
  }

  /** Same per-driver win rate as driverWeightMultipliers(), split one
   * bucket per OracleRegime - a driver can be genuinely good in TRENDING
   * and noise in RANGING, which the blended table above hides. Splitting
   * by regime means each bucket sees fewer resolutions, so this uses a
   * wider window (DRIVER_STATS_WINDOW * 2) than the blended table to give
   * each regime bucket a real chance to clear DRIVER_STATS_MIN_N; a regime
   * with too few resolutions is simply absent, and predictNextCandle falls
   * back to the blended table for it. */
  private driverWeightMultipliersByRegime(): Partial<Record<OracleRegime, Record<string, number>>> {
    const window = this.resolved.slice(-DRIVER_STATS_WINDOW * 2)
    const byRegime = new Map<OracleRegime, Map<string, boolean[]>>()
    for (const r of window) {
      const realizedUpSign = r.actual === 'up' ? 1 : r.actual === 'down' ? -1 : 0
      if (realizedUpSign === 0) continue
      const byName = byRegime.get(r.regime) ?? new Map<string, boolean[]>()
      for (const d of r.drivers ?? []) {
        const s = byName.get(d.name) ?? []
        s.push(Math.sign(d.vote) === realizedUpSign)
        byName.set(d.name, s)
      }
      byRegime.set(r.regime, byName)
    }
    const out: Partial<Record<OracleRegime, Record<string, number>>> = {}
    for (const [regime, byName] of byRegime) {
      const table: Record<string, number> = {}
      for (const [name, calls] of byName) {
        if (calls.length < DRIVER_STATS_MIN_N) continue
        const winRate = weightedHitRate(calls, (hit) => hit).hitRate
        table[name] = Math.max(0.75, Math.min(1.3, 0.75 + (winRate - 0.5) * 2.5))
      }
      if (Object.keys(table).length > 0) out[regime] = table
    }
    return out
  }

  /** THIS PAIR'S OWN per-driver win-rate multiplier, blended across its own
   * resolved regimes - analytics/nextcandle.ts's OracleInput.pairDriverWeightMultipliers.
   * Same algorithm as driverWeightMultipliers() above, scoped to only this
   * asset:tf's own resolved rows and gated at the smaller
   * PAIR_DRIVER_STATS_MIN_N floor - a pair's own physiology (which model is
   * actually sharp on IT specifically) can differ from the universe-blended
   * read, and this is the first thing predictNextCandle's fusion checks for
   * each driver before falling back to the universe-wide tables. */
  private pairDriverWeightMultipliers(asset: string, tf: string): Record<string, number> {
    const window = this.resolved.filter((r) => r.asset === asset && r.tf === tf).slice(-PAIR_DRIVER_STATS_WINDOW)
    const byName = new Map<string, boolean[]>()
    for (const r of window) {
      const realizedUpSign = r.actual === 'up' ? 1 : r.actual === 'down' ? -1 : 0
      if (realizedUpSign === 0) continue
      for (const d of r.drivers ?? []) {
        const s = byName.get(d.name) ?? []
        s.push(Math.sign(d.vote) === realizedUpSign)
        byName.set(d.name, s)
      }
    }
    const out: Record<string, number> = {}
    for (const [name, calls] of byName) {
      if (calls.length < PAIR_DRIVER_STATS_MIN_N) continue
      const winRate = weightedHitRate(calls, (hit) => hit).hitRate
      out[name] = Math.max(0.75, Math.min(1.3, 0.75 + (winRate - 0.5) * 2.5))
    }
    return out
  }

  /** THIS PAIR'S OWN per-driver win-rate multiplier, split one bucket per
   * OracleRegime - analytics/nextcandle.ts's
   * OracleInput.pairRegimeDriverWeightMultipliers, the most specific bucket
   * in the whole driver-weighting cascade. Same algorithm as
   * driverWeightMultipliersByRegime() above, scoped to this asset:tf and a
   * wider window (regime-split further thins an already-thin per-pair
   * pool). */
  private pairDriverWeightMultipliersByRegime(asset: string, tf: string): Partial<Record<OracleRegime, Record<string, number>>> {
    const window = this.resolved.filter((r) => r.asset === asset && r.tf === tf).slice(-PAIR_DRIVER_STATS_WINDOW * 2)
    const byRegime = new Map<OracleRegime, Map<string, boolean[]>>()
    for (const r of window) {
      const realizedUpSign = r.actual === 'up' ? 1 : r.actual === 'down' ? -1 : 0
      if (realizedUpSign === 0) continue
      const byName = byRegime.get(r.regime) ?? new Map<string, boolean[]>()
      for (const d of r.drivers ?? []) {
        const s = byName.get(d.name) ?? []
        s.push(Math.sign(d.vote) === realizedUpSign)
        byName.set(d.name, s)
      }
      byRegime.set(r.regime, byName)
    }
    const out: Partial<Record<OracleRegime, Record<string, number>>> = {}
    for (const [regime, byName] of byRegime) {
      const table: Record<string, number> = {}
      for (const [name, calls] of byName) {
        if (calls.length < PAIR_DRIVER_STATS_MIN_N) continue
        const winRate = weightedHitRate(calls, (hit) => hit).hitRate
        table[name] = Math.max(0.75, Math.min(1.3, 0.75 + (winRate - 0.5) * 2.5))
      }
      if (Object.keys(table).length > 0) out[regime] = table
    }
    return out
  }

  /** Learned ratio of REALIZED candle move (|exit-entry|) to this engine's
   * own predicted expectedMove, for this exact asset:tf - the magnitude
   * estimate was never checked against reality before this. Excludes flat
   * bars (a zero realized move against a non-zero prediction would always
   * read as "predicted too wide", which isn't a fair read of a doji).
   * null (expectedMove left unchanged) until there's a real sample. */
  private magnitudeCalibrationFor(asset: string, tf: string): number | null {
    const rows = this.resolved.filter((r) => r.asset === asset && r.tf === tf && r.actual !== 'flat' && r.expectedMove > 0).slice(-CALIBRATION_WINDOW)
    if (rows.length < 20) return null
    const realizedAvg = weightedMeanBy(rows, (r) => Math.abs(r.exit - r.entry))
    const predictedAvg = weightedMeanBy(rows, (r) => r.expectedMove)
    if (predictedAvg <= 0) return null
    return realizedAvg / predictedAvg
  }

  /** Learned correction for the SHAPE prediction (bodyRatio + closePos) -
   * the other geometry estimate, besides magnitude, that nothing checked
   * against reality until now. Same pattern as magnitudeCalibrationFor():
   * windowed to this exact asset:tf, thin-record-null, the engine clamps
   * defensively regardless of what's returned here.
   * - bodyRatioRatio: learned ratio of REALIZED body-ratio to this engine's
   *   own PREDICTED body-ratio (centered on 1 = unchanged) - a value above
   *   1 means candles are realizing bigger bodies than predicted (oracle is
   *   under-calling doji/indecision), below 1 means the opposite.
   * - closePosBias: learned ADDITIVE bias on closePos (centered on 0) - a
   *   positive value means candles are realizing closes further toward the
   *   high than predicted, negative means further toward the low. Additive
   *   (not a ratio) because closePos is already centered around 0.5, not
   *   anchored at 0 the way bodyRatio/expectedMove are. */
  private shapeCalibrationFor(asset: string, tf: string): { bodyRatioRatio: number | null; closePosBias: number | null } | null {
    const rows = this.resolved.filter((r) => r.asset === asset && r.tf === tf && r.predBodyRatio > 0).slice(-CALIBRATION_WINDOW)
    if (rows.length < 20) return null
    const predBodyAvg = weightedMeanBy(rows, (r) => r.predBodyRatio)
    const realizedBodyAvg = weightedMeanBy(rows, (r) => r.realizedBodyRatio)
    const bodyRatioRatio = predBodyAvg > 0 ? realizedBodyAvg / predBodyAvg : null
    const predClosePosAvg = weightedMeanBy(rows, (r) => r.predClosePos)
    const realizedClosePosAvg = weightedMeanBy(rows, (r) => r.realizedClosePos)
    const closePosBias = realizedClosePosAvg - predClosePosAvg
    return { bodyRatioRatio, closePosBias }
  }

  /** Per-PATTERN live reliability, learned the same way driverWeightMultipliers()
   * learns per-DRIVER reliability: a pattern's own win rate against the
   * REAL realized next-candle direction, universe-wide (a pattern's
   * reliability is a property of the pattern, not one pair), replacing its
   * hand-set reliability score once there's a real sample. Fed into
   * analytics/patterns.ts's provider bridge at start() below, so every
   * patternBias() caller in the codebase - this engine's own "Candle
   * patterns" driver, adxpatternbias.ts's two pattern reads, any strategy
   * - picks it up automatically. Mapped to roughly the same 1-3(-4) scale
   * the hand-set reliability table already uses, so a learned value slots
   * in without silently changing the overall magnitude patternBias() reads
   * at. */
  private patternReliabilityTable(): Record<string, number> {
    const window = this.resolved.slice(-PATTERN_STATS_WINDOW)
    const byName = new Map<string, boolean[]>()
    for (const r of window) {
      const realizedUpSign = r.actual === 'up' ? 1 : r.actual === 'down' ? -1 : 0
      if (realizedUpSign === 0) continue // flat bars don't score any pattern
      for (const h of r.patternHits ?? []) {
        if (h.direction === 'neutral') continue // neutral patterns have nothing to score
        const dirSign = h.direction === 'bullish' ? 1 : -1
        const s = byName.get(h.name) ?? []
        s.push(dirSign === realizedUpSign)
        byName.set(h.name, s)
      }
    }
    const out: Record<string, number> = {}
    for (const [name, calls] of byName) {
      if (calls.length < PATTERN_STATS_MIN_N) continue
      const winRate = weightedHitRate(calls, (hit) => hit).hitRate
      out[name] = Math.max(0.3, Math.min(4, winRate * 6))
    }
    return out
  }

  /** THIS PAIR'S OWN learned per-pattern reliability table -
   * analytics/nextcandle.ts's OracleInput.pairPatternReliability. Same
   * win-rate algorithm as patternReliabilityTable() above, scoped to only
   * this asset:tf's own resolved pattern-hit history. The caller (the
   * "Candle patterns" driver in analytics/nextcandle.ts) merges this on
   * TOP of the universe-wide table rather than using it standalone, since
   * patternBias()'s override replaces the whole table rather than merging
   * per-key. */
  private pairPatternReliabilityTable(asset: string, tf: string): Record<string, number> {
    const window = this.resolved.filter((r) => r.asset === asset && r.tf === tf).slice(-PAIR_PATTERN_STATS_WINDOW)
    const byName = new Map<string, boolean[]>()
    for (const r of window) {
      const realizedUpSign = r.actual === 'up' ? 1 : r.actual === 'down' ? -1 : 0
      if (realizedUpSign === 0) continue
      for (const h of r.patternHits ?? []) {
        if (h.direction === 'neutral') continue
        const dirSign = h.direction === 'bullish' ? 1 : -1
        const s = byName.get(h.name) ?? []
        s.push(dirSign === realizedUpSign)
        byName.set(h.name, s)
      }
    }
    const out: Record<string, number> = {}
    for (const [name, calls] of byName) {
      if (calls.length < PAIR_PATTERN_STATS_MIN_N) continue
      const winRate = weightedHitRate(calls, (hit) => hit).hitRate
      out[name] = Math.max(0.3, Math.min(4, winRate * 6))
    }
    return out
  }

  /** Per-driver CALIBRATION-quality multiplier, universe-wide - a second,
   * independent axis from driverWeightMultipliers() above. That one
   * rewards a driver for being directionally RIGHT (win rate); this one
   * rewards it for being honest about its OWN uncertainty: its resolved
   * Brier contribution ((pUp - realizedUp)², 0.25 = an honest coin flip),
   * computed from the driver's OWN pUp read, not the fused one. A driver
   * right 55% of the time while confidently predicting 90% every time is
   * directionally fine but badly miscalibrated - win rate alone can't see
   * that; this can. */
  private driverCalibrationMultipliers(): Record<string, number> {
    const window = this.resolved.slice(-DRIVER_STATS_WINDOW * 2)
    const byName = new Map<string, number[]>()
    for (const r of window) {
      const realizedUp = r.actual === 'up' ? 1 : r.actual === 'down' ? 0 : 0.5
      for (const d of r.drivers ?? []) {
        if (!Number.isFinite(d.pUp)) continue
        const arr = byName.get(d.name) ?? []
        arr.push((d.pUp - realizedUp) ** 2)
        byName.set(d.name, arr)
      }
    }
    const out: Record<string, number> = {}
    for (const [name, briers] of byName) {
      if (briers.length < DRIVER_STATS_MIN_N) continue
      const meanBrier = weightedMean(briers)
      out[name] = Math.max(0.8, Math.min(1.2, 1 + (0.25 - meanBrier) * 1.5))
    }
    return out
  }

  /** THIS PAIR'S OWN per-driver calibration-quality multiplier -
   * analytics/nextcandle.ts's OracleInput.pairDriverCalibrationMultipliers.
   * Same Brier-based algorithm as driverCalibrationMultipliers() above,
   * scoped to only this asset:tf's own resolved rows. */
  private pairDriverCalibrationMultipliers(asset: string, tf: string): Record<string, number> {
    const window = this.resolved.filter((r) => r.asset === asset && r.tf === tf).slice(-PAIR_DRIVER_STATS_WINDOW * 2)
    const byName = new Map<string, number[]>()
    for (const r of window) {
      const realizedUp = r.actual === 'up' ? 1 : r.actual === 'down' ? 0 : 0.5
      for (const d of r.drivers ?? []) {
        if (!Number.isFinite(d.pUp)) continue
        const arr = byName.get(d.name) ?? []
        arr.push((d.pUp - realizedUp) ** 2)
        byName.set(d.name, arr)
      }
    }
    const out: Record<string, number> = {}
    for (const [name, briers] of byName) {
      if (briers.length < PAIR_DRIVER_STATS_MIN_N) continue
      const meanBrier = weightedMean(briers)
      out[name] = Math.max(0.8, Math.min(1.2, 1 + (0.25 - meanBrier) * 1.5))
    }
    return out
  }

  /** Learned pairwise driver correlation discount (analytics/
   * nextcandle.ts's `driverCorrelation` input, generalizing the old
   * hand-picked CORRELATED_DRIVER_GROUPS): for every pair of drivers that
   * both fired on the same resolved call, how often did they agree on
   * direction (unweighted sign match)? A pair that agrees meaningfully
   * more than chance (>60%) is probably reading overlapping evidence, not
   * confirming independently - discounted toward 0.5 the more they agree;
   * a pair at or below 60% agreement gets no discount at all. Requires
   * PAIR_CORR_MIN_N resolved co-occurrences per pair before trusting it. */
  private driverCorrelationTable(): Record<string, number> {
    const window = this.resolved.slice(-PAIR_CORR_WINDOW)
    const pairs = new Map<string, boolean[]>()
    for (const r of window) {
      const ds = r.drivers ?? []
      for (let i = 0; i < ds.length; i++) {
        for (let j = i + 1; j < ds.length; j++) {
          const a = ds[i]
          const b = ds[j]
          const aSign = Math.sign(a.vote)
          const bSign = Math.sign(b.vote)
          if (aSign === 0 || bSign === 0) continue
          const key = pairKey(a.name, b.name)
          const arr = pairs.get(key) ?? []
          arr.push(aSign === bSign)
          pairs.set(key, arr)
        }
      }
    }
    const out: Record<string, number> = {}
    for (const [key, agrees] of pairs) {
      if (agrees.length < PAIR_CORR_MIN_N) continue
      const agreeRate = weightedHitRate(agrees, (a) => a).hitRate
      if (agreeRate > 0.6) out[key] = Math.max(0.5, 1 - (agreeRate - 0.6) * 1.5)
    }
    return out
  }

  /** THIS PAIR'S OWN learned pairwise driver correlation discount -
   * analytics/nextcandle.ts's OracleInput.pairDriverCorrelation. Same
   * co-occurrence-agreement algorithm as driverCorrelationTable() above,
   * scoped to only this asset:tf's own resolved rows and a wider window
   * (PAIR_CORR_PAIR_WINDOW) since a driver PAIR's co-occurrence within one
   * pair's own history is rarer still than a single driver's own history. */
  private pairDriverCorrelationTable(asset: string, tf: string): Record<string, number> {
    const window = this.resolved.filter((r) => r.asset === asset && r.tf === tf).slice(-PAIR_CORR_PAIR_WINDOW)
    const pairs = new Map<string, boolean[]>()
    for (const r of window) {
      const ds = r.drivers ?? []
      for (let i = 0; i < ds.length; i++) {
        for (let j = i + 1; j < ds.length; j++) {
          const a = ds[i]
          const b = ds[j]
          const aSign = Math.sign(a.vote)
          const bSign = Math.sign(b.vote)
          if (aSign === 0 || bSign === 0) continue
          const key = pairKey(a.name, b.name)
          const arr = pairs.get(key) ?? []
          arr.push(aSign === bSign)
          pairs.set(key, arr)
        }
      }
    }
    const out: Record<string, number> = {}
    for (const [key, agrees] of pairs) {
      if (agrees.length < PAIR_CORR_PAIR_MIN_N) continue
      const agreeRate = weightedHitRate(agrees, (a) => a).hitRate
      if (agreeRate > 0.6) out[key] = Math.max(0.5, 1 - (agreeRate - 0.6) * 1.5)
    }
    return out
  }

  /** This asset's cluster key for the intermediate fallback tier: asset
   * CATEGORY, plus an ":otc" suffix when the ticker is an OTC synthetic -
   * OTC instruments of the same nominal category (e.g. "crypto" vs
   * "crypto-OTC") can have a meaningfully different physiology (continuous
   * synthetic feed vs. real market hours), so they're kept as separate
   * clusters rather than merged. Returns null when the ticker isn't found
   * in the live universe (never seen asset, or market-data not yet loaded) -
   * callers simply skip the cluster tier in that case. */
  // Ticker -> cluster-key cache. clusterKeyFor() is called once per
  // RESOLVED ROW inside clusterRows() below, and predict() calls the 4
  // cluster methods on every single prediction - on a live universe
  // (1000+ auto-discovered instruments) a naive listAssets().find() per
  // call turns into resolved-rows x universe-size array scans PER
  // PREDICTION, run across every asset a global scan touches: enough to
  // block the event loop for seconds and 524-timeout the whole kernel,
  // not just this feature (every REST route lives on the same thread).
  // Rebuilt only when the live universe's size changes (rare - a handful
  // of times per session as new instruments get auto-discovered), so
  // lookups are O(1) amortized instead of O(universe size) every time.
  private clusterKeyCache: Map<string, string> | null = null
  private clusterKeyCacheUniverseSize = -1

  /** This asset's cluster key for the intermediate fallback tier: asset
   * CATEGORY, plus an ":otc" suffix when the ticker is an OTC synthetic -
   * OTC instruments of the same nominal category (e.g. "crypto" vs
   * "crypto-OTC") can have a meaningfully different physiology (continuous
   * synthetic feed vs. real market hours), so they're kept as separate
   * clusters rather than merged. Returns null when the ticker isn't found
   * in the live universe (never seen asset, or market-data not yet loaded) -
   * callers simply skip the cluster tier in that case. */
  private clusterKeyFor(asset: string): string | null {
    // this.market.assets is the plain backing array (O(1) to read/length-
    // check); listAssets() re-maps it with a price/iq lookup per item on
    // EVERY call, which would make even this staleness check O(universe
    // size) again if used here instead.
    const assets = this.market.assets
    if (!this.clusterKeyCache || this.clusterKeyCacheUniverseSize !== assets.length) {
      this.clusterKeyCache = new Map(assets.map((a) => [a.ticker, a.ticker.endsWith('-OTC') ? `${a.category}:otc` : a.category]))
      this.clusterKeyCacheUniverseSize = assets.length
    }
    return this.clusterKeyCache.get(asset) ?? null
  }

  // clusterRows() result cache, keyed by cluster key (not by asset - every
  // pair in the same cluster shares one answer) and invalidated by
  // this.resolved's own length, which only ever grows (ResolvedPrediction
  // rows are pushed, then shifted off the front once MAX_RESOLVED is hit -
  // a length change is exactly "something changed, recompute"). Without
  // this, a global scan touching N same-cluster pairs would still redo the
  // full this.resolved filter N times per poll.
  private clusterRowsCache = new Map<string, ResolvedPrediction[]>()
  private clusterRowsCacheResolvedLen = -1

  /** Resolved rows belonging to the same cluster as `asset`, re-derived at
   * query time (ResolvedPrediction doesn't persist a category, and an
   * asset's category can't meaningfully change mid-session anyway). */
  private clusterRows(asset: string): ResolvedPrediction[] {
    const key = this.clusterKeyFor(asset)
    if (!key) return []
    if (this.clusterRowsCacheResolvedLen !== this.resolved.length) {
      this.clusterRowsCache.clear()
      this.clusterRowsCacheResolvedLen = this.resolved.length
    }
    const cached = this.clusterRowsCache.get(key)
    if (cached) return cached
    const rows = this.resolved.filter((r) => this.clusterKeyFor(r.asset) === key)
    this.clusterRowsCache.set(key, rows)
    return rows
  }

  /** CLUSTER-level per-driver win-rate multiplier -
   * analytics/nextcandle.ts's OracleInput.clusterDriverWeightMultipliers.
   * Same win-rate algorithm as driverWeightMultipliers()/
   * pairDriverWeightMultipliers() above, scoped to every resolved row
   * whose asset shares this asset's cluster key. */
  private clusterDriverWeightMultipliers(asset: string): Record<string, number> {
    const window = this.clusterRows(asset).slice(-CLUSTER_DRIVER_STATS_WINDOW)
    const byName = new Map<string, boolean[]>()
    for (const r of window) {
      const realizedUpSign = r.actual === 'up' ? 1 : r.actual === 'down' ? -1 : 0
      if (realizedUpSign === 0) continue
      for (const d of r.drivers ?? []) {
        const s = byName.get(d.name) ?? []
        s.push(Math.sign(d.vote) === realizedUpSign)
        byName.set(d.name, s)
      }
    }
    const out: Record<string, number> = {}
    for (const [name, calls] of byName) {
      if (calls.length < CLUSTER_DRIVER_STATS_MIN_N) continue
      const winRate = weightedHitRate(calls, (hit) => hit).hitRate
      out[name] = Math.max(0.75, Math.min(1.3, 0.75 + (winRate - 0.5) * 2.5))
    }
    return out
  }

  /** Same cluster-level table as clusterDriverWeightMultipliers(), split
   * one bucket per OracleRegime. */
  private clusterDriverWeightMultipliersByRegime(asset: string): Partial<Record<OracleRegime, Record<string, number>>> {
    const window = this.clusterRows(asset).slice(-CLUSTER_DRIVER_STATS_WINDOW * 2)
    const byRegime = new Map<OracleRegime, Map<string, boolean[]>>()
    for (const r of window) {
      const realizedUpSign = r.actual === 'up' ? 1 : r.actual === 'down' ? -1 : 0
      if (realizedUpSign === 0) continue
      const byName = byRegime.get(r.regime) ?? new Map<string, boolean[]>()
      for (const d of r.drivers ?? []) {
        const s = byName.get(d.name) ?? []
        s.push(Math.sign(d.vote) === realizedUpSign)
        byName.set(d.name, s)
      }
      byRegime.set(r.regime, byName)
    }
    const out: Partial<Record<OracleRegime, Record<string, number>>> = {}
    for (const [regime, byName] of byRegime) {
      const bucket: Record<string, number> = {}
      for (const [name, calls] of byName) {
        if (calls.length < CLUSTER_DRIVER_STATS_MIN_N) continue
        const winRate = weightedHitRate(calls, (hit) => hit).hitRate
        bucket[name] = Math.max(0.75, Math.min(1.3, 0.75 + (winRate - 0.5) * 2.5))
      }
      if (Object.keys(bucket).length > 0) out[regime] = bucket
    }
    return out
  }

  /** CLUSTER-level per-driver calibration-quality multiplier -
   * analytics/nextcandle.ts's OracleInput.clusterDriverCalibrationMultipliers.
   * Same Brier-based algorithm as driverCalibrationMultipliers()/
   * pairDriverCalibrationMultipliers() above. */
  private clusterDriverCalibrationMultipliers(asset: string): Record<string, number> {
    const window = this.clusterRows(asset).slice(-CLUSTER_DRIVER_STATS_WINDOW * 2)
    const byName = new Map<string, number[]>()
    for (const r of window) {
      const realizedUp = r.actual === 'up' ? 1 : r.actual === 'down' ? 0 : 0.5
      for (const d of r.drivers ?? []) {
        if (!Number.isFinite(d.pUp)) continue
        const arr = byName.get(d.name) ?? []
        arr.push((d.pUp - realizedUp) ** 2)
        byName.set(d.name, arr)
      }
    }
    const out: Record<string, number> = {}
    for (const [name, briers] of byName) {
      if (briers.length < CLUSTER_DRIVER_STATS_MIN_N) continue
      const meanBrier = weightedMean(briers)
      out[name] = Math.max(0.8, Math.min(1.2, 1 + (0.25 - meanBrier) * 1.5))
    }
    return out
  }

  /** CLUSTER-level learned pairwise driver correlation discount -
   * analytics/nextcandle.ts's OracleInput.clusterDriverCorrelation. Same
   * co-occurrence-agreement algorithm as driverCorrelationTable()/
   * pairDriverCorrelationTable() above. */
  private clusterDriverCorrelationTable(asset: string): Record<string, number> {
    const window = this.clusterRows(asset).slice(-CLUSTER_CORR_PAIR_WINDOW)
    const pairs = new Map<string, boolean[]>()
    for (const r of window) {
      const ds = r.drivers ?? []
      for (let i = 0; i < ds.length; i++) {
        for (let j = i + 1; j < ds.length; j++) {
          const a = ds[i]
          const b = ds[j]
          const aSign = Math.sign(a.vote)
          const bSign = Math.sign(b.vote)
          if (aSign === 0 || bSign === 0) continue
          const key = pairKey(a.name, b.name)
          const arr = pairs.get(key) ?? []
          arr.push(aSign === bSign)
          pairs.set(key, arr)
        }
      }
    }
    const out: Record<string, number> = {}
    for (const [key, agrees] of pairs) {
      if (agrees.length < CLUSTER_CORR_PAIR_MIN_N) continue
      const agreeRate = weightedHitRate(agrees, (a) => a).hitRate
      if (agreeRate > 0.6) out[key] = Math.max(0.5, 1 - (agreeRate - 0.6) * 1.5)
    }
    return out
  }

  /** THIS PAIR'S OWN learned replacement for the flat agreement/distance
   * blend - analytics/nextcandle.ts's OracleInput.pairConfidenceBlendWeight.
   * Same sweep as learnedConfidenceBlendWeight() below, scoped to only this
   * asset:tf's own resolved rows; a smaller floor since one pair alone
   * accumulates qualifying rows (real driver snapshots, 4+ drivers fired)
   * far slower than the whole universe. */
  private pairLearnedConfidenceBlendWeight(asset: string, tf: string): number | null {
    const window = this.resolved
      .filter((r) => r.asset === asset && r.tf === tf)
      .slice(-BLEND_WEIGHT_WINDOW)
      .filter((r) => r.actual !== 'flat' && (r.drivers?.length ?? 0) >= 4)
    if (window.length < PAIR_BLEND_WEIGHT_MIN_N) return null
    let best: { w: number; err: number } | null = null
    for (const w of BLEND_WEIGHT_CANDIDATES) {
      let errSum = 0
      for (const r of window) {
        const winSide = r.pUp >= 0.5 ? 1 : -1
        const agree = r.drivers.filter((d) => Math.sign(d.vote) === winSide).length / r.drivers.length
        const distance = Math.abs(r.pUp - 0.5) * 2
        const confEst = Math.max(0, Math.min(1, w * agree + (1 - w) * distance))
        const realizedHit = r.hit ? 1 : 0
        errSum += (confEst - realizedHit) ** 2
      }
      const err = errSum / window.length
      if (!best || err < best.err) best = { w, err }
    }
    return best?.w ?? null
  }

  /** Learned replacement for the flat 0.55/0.45 agreement/distance blend
   * that produces rawConfidence: sweeps a small set of candidate agreement
   * weights and picks whichever would have best predicted the resolved
   * ledger's own realized hit rate (lowest mean squared error, same shape
   * as a Brier score). Reconstructs `agreement` from each resolved row's
   * own stored drivers (unweighted sign match against the row's own pUp
   * side - the per-driver WEIGHTS used at issue time aren't persisted, so
   * this is an unweighted proxy, close enough to pick a sane blend ratio)
   * and `distance` directly from the row's stored pUp. null (keeps the
   * flat 0.55) until there's enough resolved history with real driver
   * snapshots to trust the sweep. */
  private learnedConfidenceBlendWeight(): number | null {
    const window = this.resolved.slice(-BLEND_WEIGHT_WINDOW).filter((r) => r.actual !== 'flat' && (r.drivers?.length ?? 0) >= 4)
    if (window.length < BLEND_WEIGHT_MIN_N) return null
    let best: { w: number; err: number } | null = null
    for (const w of BLEND_WEIGHT_CANDIDATES) {
      let errSum = 0
      for (const r of window) {
        const winSide = r.pUp >= 0.5 ? 1 : -1
        const agree = r.drivers.filter((d) => Math.sign(d.vote) === winSide).length / r.drivers.length
        const distance = Math.abs(r.pUp - 0.5) * 2
        const confEst = Math.max(0, Math.min(1, w * agree + (1 - w) * distance))
        const realizedHit = r.hit ? 1 : 0
        errSum += (confEst - realizedHit) ** 2
      }
      const err = errSum / window.length
      if (!best || err < best.err) best = { w, err }
    }
    return best?.w ?? null
  }

  /** Full stats for the panel: per-asset:tf records + recent resolutions. */
  /** Lifetime ledger for panels/agents - now also surfaces the learned
   * diagnostics every prediction already uses internally (driver weights,
   * pattern reliability, and each asset:tf's own regime/session/direction
   * calibration buckets and magnitude ratio), none of which had an API
   * surface before this round: the numbers were influencing predictions
   * invisibly, with nothing to show what was actually learned. */
  stats(): {
    total: number
    pending: number
    records: {
      asset: string
      tf: string
      n: number
      hitRate: number
      brier: number
      streak: number
      regimeCalibration: Partial<Record<OracleRegime, { n: number; hitRate: number; brier: number }>>
      sessionCalibration: Partial<Record<Session, { n: number; hitRate: number; brier: number }>>
      directionCalibration: Partial<Record<'call' | 'put', { n: number; hitRate: number; brier: number }>>
      magnitudeCalibration: number | null
      /** this pair's own "physiology": its own per-driver win-rate
       * multipliers (blended + per-regime), calibration-quality
       * multipliers, and driver-correlation discounts - takes priority
       * over the universe-wide tables below once this pair has enough of
       * its own resolved history (PAIR_DRIVER_STATS_MIN_N /
       * PAIR_CORR_PAIR_MIN_N); empty objects mean still falling back to
       * the universe-wide read for every driver. */
      pairDriverWeightMultipliers: Record<string, number>
      pairRegimeDriverWeightMultipliers: Partial<Record<OracleRegime, Record<string, number>>>
      pairDriverCalibrationMultipliers: Record<string, number>
      pairDriverCorrelation: Record<string, number>
      pairConfidenceBlendWeight: number | null
      pairPatternReliability: Record<string, number>
      /** intermediate asset-category tier between this pair's own tables
       * above and the universe-wide tables below - empty objects mean
       * still falling back further (to the pair table if present, else
       * universe-wide), or that this ticker's category couldn't be
       * resolved. */
      clusterKey: string | null
      clusterDriverWeightMultipliers: Record<string, number>
      clusterRegimeDriverWeightMultipliers: Partial<Record<OracleRegime, Record<string, number>>>
      clusterDriverCalibrationMultipliers: Record<string, number>
      clusterDriverCorrelation: Record<string, number>
    }[]
    driverWeightMultipliers: Record<string, number>
    regimeDriverWeightMultipliers: Partial<Record<OracleRegime, Record<string, number>>>
    driverCalibrationMultipliers: Record<string, number>
    driverCorrelation: Record<string, number>
    confidenceBlendWeight: number | null
    patternReliability: Record<string, number>
    recent: ResolvedPrediction[]
  } {
    const byKey = new Map<string, ResolvedPrediction[]>()
    for (const r of this.resolved) {
      const k = `${r.asset}:${r.tf}`
      const arr = byKey.get(k) ?? []
      arr.push(r)
      byKey.set(k, arr)
    }
    const records = [...byKey.entries()].map(([k, rows]) => {
      const [asset, tf] = k.split(':')
      const win = rows.reduce((s, r) => s + r.score, 0) / Math.max(1, rows.length)
      const brier = rows.reduce((s, r) => s + r.brier, 0) / Math.max(1, rows.length)
      let streak = 0
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].hit) streak++
        else break
      }
      return {
        asset,
        tf,
        n: rows.length,
        hitRate: win,
        brier,
        streak,
        regimeCalibration: this.regimeCalibrationFor(asset, tf),
        sessionCalibration: this.sessionCalibrationFor(asset, tf),
        directionCalibration: this.directionCalibrationFor(asset, tf),
        magnitudeCalibration: this.magnitudeCalibrationFor(asset, tf),
        pairDriverWeightMultipliers: this.pairDriverWeightMultipliers(asset, tf),
        pairRegimeDriverWeightMultipliers: this.pairDriverWeightMultipliersByRegime(asset, tf),
        pairDriverCalibrationMultipliers: this.pairDriverCalibrationMultipliers(asset, tf),
        pairDriverCorrelation: this.pairDriverCorrelationTable(asset, tf),
        pairConfidenceBlendWeight: this.pairLearnedConfidenceBlendWeight(asset, tf),
        pairPatternReliability: this.pairPatternReliabilityTable(asset, tf),
        clusterKey: this.clusterKeyFor(asset),
        clusterDriverWeightMultipliers: this.clusterDriverWeightMultipliers(asset),
        clusterRegimeDriverWeightMultipliers: this.clusterDriverWeightMultipliersByRegime(asset),
        clusterDriverCalibrationMultipliers: this.clusterDriverCalibrationMultipliers(asset),
        clusterDriverCorrelation: this.clusterDriverCorrelationTable(asset),
      }
    }).sort((a, b) => b.n - a.n)
    return {
      total: this.resolved.length,
      pending: this.pending.size,
      records,
      driverWeightMultipliers: this.driverWeightMultipliers(),
      regimeDriverWeightMultipliers: this.driverWeightMultipliersByRegime(),
      driverCalibrationMultipliers: this.driverCalibrationMultipliers(),
      driverCorrelation: this.driverCorrelationTable(),
      confidenceBlendWeight: this.learnedConfidenceBlendWeight(),
      patternReliability: this.patternReliabilityTable(),
      recent: this.resolved.slice(-40).reverse(),
    }
  }

  // ---------- Next Global: whole-universe scan ----------
  // One fused next-candle read per instrument across the board, cached
  // per (tf, asset) with a short TTL. Rows are recomputed lazily: a poll
  // only refuses a row older than GLOBAL_SCAN_TTL_MS, so N panels polling
  // cost one fusion per pair per TTL, not one per poll. Every computed row
  // goes through this.predict() and is therefore TRACKED by the honesty
  // loop - the global board and the per-asset oracle panel share one
  // calibration ledger, and the more the board scans, the faster each
  // pair's record builds.

  private scanRows = new Map<string, GlobalScanRow>() // key: `${tf}:${asset}`

  /** Single-pair counterpart to globalScan()'s per-row computation - same
   * TTL cache (keyed by `${tf}:${ticker}`, shared with the board: a panel
   * reading one pair and the board scanning the whole universe hit the
   * same cached row, never double the work), same thin/no-history fallback
   * shape. Pulled out so other plugins (Tempo's single-pair rowFor(), the
   * Accute confluence engine) can get one fresh oracle row without paying
   * for or depending on a full board scan. `price` needs the asset's own
   * AssetInfo (for the thin-history fallback's last-known price), so this
   * takes it as a param rather than re-deriving it internally. */
  private scanRowFor(a: { ticker: string; price: number }, tf: Timeframe, refresh = false): GlobalScanRow {
    const now = Date.now()
    const key = `${tf}:${a.ticker}`
    const cached = this.scanRows.get(key)
    if (!refresh && cached && now - cached.computedTs < GLOBAL_SCAN_TTL_MS) return cached
    const pred = this.predict(a.ticker, tf)
    let row: GlobalScanRow
    if (pred) {
      const renkoDriver = pred.drivers.find((d) => d.name === 'Renko bricks')
      const footprintDriver = pred.drivers.find((d) => d.name === 'Footprint')
      row = {
        asset: a.ticker,
        tf,
        computedTs: now,
        targetBarTime: pred.targetBarTime,
        ok: true,
        note: '',
        pUp: pred.pUp,
        direction: pred.direction,
        confidence: pred.confidence,
        rawConfidence: pred.rawConfidence,
        regime: pred.regime,
        price: pred.price,
        expectedMove: pred.expectedMove,
        atr: pred.atr,
        driversActive: pred.driversActive,
        calibration: pred.calibration,
        renkoVote: renkoDriver?.vote ?? 0,
        footprintVote: footprintDriver?.vote ?? 0,
        expectedCandleType: pred.expectedCandleType,
      }
    } else {
      // thin/no history yet (lazy-seeded feed) - keep the timestamp at the
      // attempt so the row retries on a later poll, not every poll
      row = {
        asset: a.ticker,
        tf,
        computedTs: now,
        targetBarTime: 0,
        ok: false,
        note: 'warming up: needs 320+ closed bars on this tf',
        pUp: 0.5,
        direction: 'none',
        confidence: 0,
        rawConfidence: 0,
        regime: 'MIXED',
        price: a.price,
        expectedMove: 0,
        atr: 0,
        driversActive: 0,
        calibration: this.calibrationFor(a.ticker, tf),
        renkoVote: 0,
        footprintVote: 0,
        expectedCandleType: '',
      }
    }
    this.scanRows.set(key, row)
    if (this.scanRows.size > 400) {
      // evict the stalest quarter - boards on tfs nobody polls anymore
      const stale = [...this.scanRows.entries()].sort((x, y) => x[1].computedTs - y[1].computedTs).slice(0, 100)
      for (const [k] of stale) this.scanRows.delete(k)
    }
    return row
  }

  /** Public single-pair read - resolves the asset's current price/AssetInfo
   * from the market service itself, so callers only need a ticker. */
  rowFor(asset: string, tf: Timeframe, opts: { refresh?: boolean } = {}): GlobalScanRow {
    // listAssets() (not the plain this.market.assets) because only it
    // carries the live `price` field the thin-history fallback needs -
    // one lookup per call, nowhere near the hot per-resolved-row path the
    // cluster-key cache above exists to avoid.
    const info = this.market.listAssets().find((a) => a.ticker === asset)
    return this.scanRowFor({ ticker: asset, price: info?.price ?? 0 }, tf, opts.refresh === true)
  }

  globalScan(tf: Timeframe, opts: { limit?: number; category?: string; refresh?: boolean } = {}): GlobalScanResult {
    const limit = Math.max(1, Math.min(Math.round(opts.limit ?? 30), 150))
    const category = opts.category && opts.category !== 'all' ? opts.category : null
    const refresh = opts.refresh === true
    const now = Date.now()

    const universe = this.market.listAssets().filter((a) => a.open && (!category || a.category === category))
    const picked = universe.slice(0, limit)

    let refreshed = 0
    const rows: GlobalScanRow[] = []
    for (const a of picked) {
      const before = this.scanRows.get(`${tf}:${a.ticker}`)
      const row = this.scanRowFor(a, tf, refresh)
      if (!before || row.computedTs !== before.computedTs) refreshed++
      rows.push(row)
    }

    // tradability sort: confidence weighted by how far the fused read sits
    // from coin-flip - the board's job is to surface "worth looking at"
    const live = rows.filter((r) => r.ok)
    live.sort((x, y) => y.confidence * Math.abs(y.pUp - 0.5) - x.confidence * Math.abs(x.pUp - 0.5))
    const warming = rows.filter((r) => !r.ok)
    warming.sort((a, b) => a.asset.localeCompare(b.asset))
    return {
      tf,
      scannedTs: now,
      universe: universe.length,
      scanned: rows.length,
      live: live.length,
      warming: warming.length,
      refreshed,
      rows: [...live, ...warming],
    }
  }

  // ---------- persistence (same contract as plugins/chartsignals.ts) ----------
  private dataFile(): string {
    const dir = join(process.cwd(), 'data')
    mkdirSync(dir, { recursive: true })
    return join(dir, OUTCOME_FILE)
  }

  private restore(): void {
    try {
      const f = this.dataFile()
      if (!existsSync(f)) return
      const raw = JSON.parse(readFileSync(f, 'utf8'))
      if (Array.isArray(raw?.resolved)) this.resolved = raw.resolved.slice(-MAX_RESOLVED)
      this.ctx.log('next-candle', `restored ${this.resolved.length} resolved oracle predictions from data/`)
    } catch {
      // corrupt/missing file - start with a clean ledger, never break boot
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.dataFile(), JSON.stringify({ resolved: this.resolved.slice(-MAX_RESOLVED) }))
    } catch {
      // best-effort - the in-memory record stays authoritative until next save
    }
  }
}

export const nextCandlePlugin: Plugin = {
  name: 'next-candle',
  start: async (ctx) => {
    const svc = new NextCandleService()
    ctx.provide('nextcandle', svc)
    await svc.start(ctx)
  },
}
