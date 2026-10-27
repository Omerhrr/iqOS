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
import { predictNextCandle, setOracleCalibrationProvider, type NextCandlePrediction } from '../analytics/nextcandle'
import type { MarketDataService } from './market-data'

const MAX_RESOLVED = 800
const CALIBRATION_WINDOW = 120 // rolling record length fed back into confidence
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
    ctx.log('nextcandle', 'next-candle oracle online (multi-model fusion + self-calibration honesty loop)')
  }

  stop(): void {
    this.unsub?.()
    this.persist()
  }

  /** Issue (or refresh) the prediction for asset/tf and track it. */
  predict(asset: string, tf: string): NextCandlePrediction | null {
    const candles: Candle[] = this.market.getCandlesDeep(asset, tf as never, 1500, true)
    const cal = this.calibrationFor(asset, tf)
    const pred = predictNextCandle(candles, { asset, tf, mode: this.market.mode, calibration: cal })
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
      }
      this.resolved.push(entry)
      while (this.resolved.length > MAX_RESOLVED) this.resolved.shift()
      this.persist()
    }
  }

  /** Rolling record for one asset:tf, windowed to CALIBRATION_WINDOW. */
  calibrationFor(asset: string, tf: string): { n: number; hitRate: number; brier: number } | null {
    const rows = this.resolved.filter((r) => r.asset === asset && r.tf === tf).slice(-CALIBRATION_WINDOW)
    if (rows.length === 0) return null
    const hitRate = rows.reduce((s, r) => s + r.score, 0) / rows.length
    const brier = rows.reduce((s, r) => s + r.brier, 0) / rows.length
    return { n: rows.length, hitRate, brier }
  }

  /** Full stats for the panel: per-asset:tf records + recent resolutions. */
  stats(): {
    total: number
    pending: number
    records: { asset: string; tf: string; n: number; hitRate: number; brier: number; streak: number }[]
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
      return { asset, tf, n: rows.length, hitRate: win, brier, streak }
    }).sort((a, b) => b.n - a.n)
    return {
      total: this.resolved.length,
      pending: this.pending.size,
      records,
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
