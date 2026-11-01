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
import { predictNextCandle, setOracleCalibrationProvider, type NextCandlePrediction, type OracleRegime } from '../analytics/nextcandle'
import { setPatternReliabilityProvider } from '../analytics/patterns'
import { weightedHitRate, weightedMeanBy } from '../analytics/recencystats'
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
   * outcome. */
  drivers: { name: string; vote: number }[]
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
  /** per-driver votes at issue time, carried through for driverStats() */
  drivers: { name: string; vote: number }[]
  /** pattern hits at issue time, carried through for patternReliabilityTable() */
  patternHits: { name: string; direction: 'bullish' | 'bearish' | 'neutral' }[]
  /** predicted magnitude at issue time - feeds magnitudeCalibrationFor() against |exit-entry| */
  expectedMove: number
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
      magnitudeCalibration: this.magnitudeCalibrationFor(asset, tf),
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
      drivers: pred.drivers.map((d) => ({ name: d.name, vote: d.vote })),
      patternHits: pred.patternHits,
      expectedMove: pred.expectedMove,
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
    }[]
    driverWeightMultipliers: Record<string, number>
    regimeDriverWeightMultipliers: Partial<Record<OracleRegime, Record<string, number>>>
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
      }
    }).sort((a, b) => b.n - a.n)
    return {
      total: this.resolved.length,
      pending: this.pending.size,
      records,
      driverWeightMultipliers: this.driverWeightMultipliers(),
      regimeDriverWeightMultipliers: this.driverWeightMultipliersByRegime(),
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
      const key = `${tf}:${a.ticker}`
      const cached = this.scanRows.get(key)
      if (!refresh && cached && now - cached.computedTs < GLOBAL_SCAN_TTL_MS) {
        rows.push(cached)
        continue
      }
      const pred = this.predict(a.ticker, tf)
      let row: GlobalScanRow
      if (pred) {
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
        }
      }
      this.scanRows.set(key, row)
      if (this.scanRows.size > 400) {
        // evict the stalest quarter - boards on tfs nobody polls anymore
        const stale = [...this.scanRows.entries()].sort((x, y) => x[1].computedTs - y[1].computedTs).slice(0, 100)
        for (const [k] of stale) this.scanRows.delete(k)
      }
      rows.push(row)
      refreshed++
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
