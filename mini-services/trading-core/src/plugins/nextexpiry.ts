// IQAIR//OS - Next-Expiry Oracle plugin
//
// Wraps analytics/nextexpiry.ts's per-expiry fusion with the SAME honesty
// plumbing the Next-Candle Oracle runs on (plugins/nextcandle.ts): every
// call/put recommendation the panel issues for a specific expiry window is
// TRACKED, and when that window's anchor 1m bar closes the tracker resolves
// it (win/loss vs the predicted direction, Brier vs the predicted pUp). The
// rolling record per (asset, expiry) is fed BACK into that expiry's next
// confidence read via applyCalibrationDiscount, and each MODEL's own
// resolved accuracy per expiry feeds per-driver weight multipliers - an
// oracle that has been wrong at the 5-minute expiry speaks more humbly
// about 5-minute expiries, and a driver that keeps missing at 15m loses
// weight at 15m specifically.
//
// Window anchoring: a prediction issued on the pair's last closed 1m bar
// (open time T0, entry ~= its close) for expiry E resolves on the close of
// the 1m bar with open time T0 + E*60 - i.e. the bar whose close is exactly
// E minutes after entry. Pending entries are deduped per
// (asset, expiry, targetBarTime): re-polls inside the same window replace
// the pending entry instead of stacking duplicates (same rule as
// plugins/nextcandle.ts). Resolved records persist to
// data/nextexpiry_outcomes.json so a kernel restart keeps the track record
// - same durability contract as plugins/chartsignals.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { Candle } from '../types'
import { EXPIRIES_MIN, EXPIRY_ORACLE_MIN_CANDLES, predictNextExpiry, type NextExpiryPrediction } from '../analytics/nextexpiry'
import { weightedMeanBy } from '../analytics/recencystats'
import type { MarketDataService } from './market-data'

const MAX_RESOLVED = 800
const MAX_PENDING = 600
/** rolling honesty record length fed back into per-expiry confidence */
const CALIBRATION_WINDOW = 120
/** min resolved rows before a (asset, expiry) record is trusted enough to
 * discount confidence - "thin record is no record", same floor philosophy
 * as plugins/nextcandle.ts's applyCalibrationDiscount contract (n >= 20) */
const RECORD_MIN_N = 20
/** per-driver win-rate learning, universe-wide within one expiry bucket */
const DRIVER_STATS_MIN_N = 30
const DRIVER_STATS_WINDOW = 250
const OUTCOME_FILE = 'nextexpiry_outcomes.json'

interface PendingExpiry {
  asset: string
  expiry: number
  targetBarTime: number
  issuedTs: number
  direction: 'call' | 'put'
  pUp: number
  confidence: number
  price: number
  /** per-driver reads at issue time (name + signed vote) - carried through
   * to the resolved record so each model's OWN accuracy can be learned per
   * expiry (driverWeightMultipliers below). */
  drivers: { name: string; vote: number; pUp: number }[]
}

export interface ResolvedExpiry {
  asset: string
  expiry: number
  targetBarTime: number
  issuedTs: number
  resolvedTs: number
  predicted: 'call' | 'put'
  pUp: number
  confidence: number
  entry: number
  exit: number
  /** realized direction of the window: 'up' | 'down' | 'flat' */
  actual: 'up' | 'down' | 'flat'
  hit: boolean
  score: number
  /** (pUp - realizedUp)² with realizedUp 1/0 (flat = 0.5 -> 0.25) */
  brier: number
  drivers: { name: string; vote: number; pUp: number }[]
}

export interface NextExpiryStatsResponse {
  total: number
  pending: number
  /** per (asset, expiry) honesty records */
  records: {
    asset: string
    expiry: number
    n: number
    hitRate: number
    brier: number
    streak: number
  }[]
  /** universe-wide per-expiry summary - which expiry ladder rung is
   * actually paying across every pair the oracle has resolved */
  expirySummary: {
    expiry: number
    n: number
    hitRate: number
    brier: number
  }[]
  /** learned per-driver win-rate multipliers, keyed by String(expiry) */
  driverWeightMultipliers: Record<string, Record<string, number>>
  recent: ResolvedExpiry[]
}

export class NextExpiryService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private pending = new Map<string, PendingExpiry>()
  private resolved: ResolvedExpiry[] = []
  private unsub: (() => void) | null = null

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.restore()
    // resolution anchor: the 1m candle whose open time equals the pending
    // entry's targetBarTime just CLOSED - that close is the window's exit
    this.unsub = ctx.bus.on('candle', ({ asset, tf, candle, closed }) => {
      if (!closed || tf !== '1m') return
      this.resolveFor(asset, candle)
    })
    ctx.log('nextexpiry', `next-expiry oracle online (per-expiry fusion over ${EXPIRIES_MIN.join('/')}m + self-calibration honesty loop)`)
  }

  stop(): void {
    this.unsub?.()
    this.persist()
  }

  /** Issue (or refresh) the per-expiry reads for one asset and track every
   * actionable row. Returns null when the pair lacks the closed 1m depth
   * the engine demands - the route reports that as a clean fail-closed. */
  predict(asset: string): NextExpiryPrediction | null {
    const candles: Candle[] = this.market.getCandlesDeep(asset, '1m', 1600, true)
    const calibrations: Record<string, { n: number; hitRate: number; brier: number } | null> = {}
    for (const E of EXPIRIES_MIN) calibrations[String(E)] = this.calibrationFor(asset, E)
    const pred = predictNextExpiry(candles, {
      asset,
      mode: this.market.mode,
      calibrations,
      driverWeightMultipliers: this.driverWeightMultipliers(),
    })
    if (!pred) return null
    for (const row of pred.rows) {
      // only actionable rows enter the ledger - a 'none' (deadband lean)
      // makes no claim that could win or lose, so there is nothing honest
      // to track
      if (!row.ok || row.direction === 'none') continue
      const key = `${asset}:${row.expiry}:${row.targetBarTime}`
      this.pending.set(key, {
        asset,
        expiry: row.expiry,
        targetBarTime: row.targetBarTime,
        issuedTs: Date.now(),
        direction: row.direction,
        pUp: row.pUp,
        confidence: row.confidence,
        price: pred.price,
        drivers: row.drivers.map((d) => ({ name: d.name, vote: d.vote, pUp: d.pUp })),
      })
    }
    if (this.pending.size > MAX_PENDING) {
      // drop the oldest fifth - pending entries resolve on their anchor
      // close anyway; keeping the map bounded is bookkeeping, not judgment
      const keys = [...this.pending.keys()].slice(0, Math.floor(MAX_PENDING / 4))
      for (const k of keys) this.pending.delete(k)
    }
    return pred
  }

  /** Resolve every pending window of this asset whose anchor bar just closed. */
  private resolveFor(asset: string, candle: Candle): void {
    const prefix = `${asset}:`
    for (const [key, p] of this.pending) {
      if (!key.startsWith(prefix)) continue
      if (p.targetBarTime !== candle.time) continue
      this.pending.delete(key)
      const diff = candle.close - p.price
      const actual: ResolvedExpiry['actual'] = Math.abs(diff) < 1e-12 ? 'flat' : diff > 0 ? 'up' : 'down'
      const hit = p.direction === 'call' ? actual === 'up' : actual === 'down'
      const realizedUp = actual === 'up' ? 1 : actual === 'down' ? 0 : 0.5
      const entry: ResolvedExpiry = {
        asset,
        expiry: p.expiry,
        targetBarTime: p.targetBarTime,
        issuedTs: p.issuedTs,
        resolvedTs: Date.now(),
        predicted: p.direction,
        pUp: p.pUp,
        confidence: p.confidence,
        entry: p.price,
        exit: candle.close,
        actual,
        hit,
        score: hit ? 1 : 0,
        brier: (p.pUp - realizedUp) * (p.pUp - realizedUp),
        drivers: p.drivers,
      }
      this.resolved.push(entry)
      while (this.resolved.length > MAX_RESOLVED) this.resolved.shift()
      this.persist()
    }
  }

  /** Rolling honesty record for one (asset, expiry), windowed to
   * CALIBRATION_WINDOW, recency-weighted (analytics/recencystats.ts). */
  calibrationFor(asset: string, expiry: number): { n: number; hitRate: number; brier: number } | null {
    const rows = this.resolved.filter((r) => r.asset === asset && r.expiry === expiry).slice(-CALIBRATION_WINDOW)
    if (rows.length === 0) return null
    return {
      n: rows.length,
      hitRate: weightedMeanBy(rows, (r) => r.score),
      brier: weightedMeanBy(rows, (r) => r.brier),
    }
  }

  /** Learned per-driver win-rate multipliers, universe-wide within one
   * expiry bucket (analytics/nextexpiry.ts's driverWeightMultipliers input,
   * keyed by String(expiry) then driver name). A driver whose votes have
   * been resolving RIGHT at the 3m expiry gets up-weighted there and only
   * there; the clamp band [0.6, 1.5] (re-clamped engine-side too) keeps any
   * single table from dominating the fusion. */
  private driverWeightMultipliers(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {}
    for (const E of EXPIRIES_MIN) {
      const window = this.resolved.filter((r) => r.expiry === E).slice(-DRIVER_STATS_WINDOW)
      const byName = new Map<string, boolean[]>()
      for (const r of window) {
        for (const d of r.drivers ?? []) {
          if (!Number.isFinite(d.vote) || d.vote === 0) continue
          const arr = byName.get(d.name) ?? []
          arr.push((d.vote > 0) === (r.actual === 'up'))
          byName.set(d.name, arr)
        }
      }
      const table: Record<string, number> = {}
      for (const [name, hits] of byName) {
        if (hits.length < DRIVER_STATS_MIN_N) continue
        const rate = weightedMeanBy(hits.map((h) => ({ score: h ? 1 : 0 })), (x) => x.score)
        table[name] = Math.max(0.6, Math.min(1.5, 0.5 + rate))
      }
      if (Object.keys(table).length > 0) out[String(E)] = table
    }
    return out
  }

  stats(): NextExpiryStatsResponse {
    const byKey = new Map<string, ResolvedExpiry[]>()
    for (const r of this.resolved) {
      const k = `${r.asset}:${r.expiry}`
      const arr = byKey.get(k) ?? []
      arr.push(r)
      byKey.set(k, arr)
    }
    const records = [...byKey.entries()].map(([k, rows]) => {
      const [asset, expiryStr] = k.split(':')
      const hitRate = rows.reduce((s, r) => s + r.score, 0) / Math.max(1, rows.length)
      const brier = rows.reduce((s, r) => s + r.brier, 0) / Math.max(1, rows.length)
      let streak = 0
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].hit) streak++
        else break
      }
      return { asset, expiry: Number(expiryStr), n: rows.length, hitRate, brier, streak }
    }).sort((a, b) => b.n - a.n)
    const expirySummary = EXPIRIES_MIN.map((E) => {
      const rows = this.resolved.filter((r) => r.expiry === E)
      if (rows.length === 0) return { expiry: E, n: 0, hitRate: 0, brier: 0 }
      return {
        expiry: E,
        n: rows.length,
        hitRate: rows.reduce((s, r) => s + r.score, 0) / rows.length,
        brier: rows.reduce((s, r) => s + r.brier, 0) / rows.length,
      }
    })
    return {
      total: this.resolved.length,
      pending: this.pending.size,
      records,
      expirySummary,
      driverWeightMultipliers: this.driverWeightMultipliers(),
      recent: this.resolved.slice(-40).reverse(),
    }
  }

  // ---------- persistence (same contract as plugins/nextcandle.ts) ----------
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
      if (Array.isArray(raw?.resolved)) {
        // restore only well-formed rows - a corrupt field must never poison
        // the honesty loop (fail-closed, same as every restore in this repo)
        this.resolved = raw.resolved.filter(
          (r: ResolvedExpiry) =>
            r && typeof r.asset === 'string' && typeof r.expiry === 'number' &&
            Number.isFinite(r.expiry) && (r.expiry === 1 || r.expiry === 2 || r.expiry === 3 || r.expiry === 5 || r.expiry === 15) &&
            typeof r.hit === 'boolean' && Number.isFinite(r.brier) && Number.isFinite(r.score),
        ).slice(-MAX_RESOLVED)
      }
      this.ctx.log('nextexpiry', `restored ${this.resolved.length} resolved expiry predictions from data/`)
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

export const nextExpiryPlugin: Plugin = {
  name: 'next-expiry',
  start: async (ctx) => {
    const svc = new NextExpiryService()
    ctx.provide('nextexpiry', svc)
    await svc.start(ctx)
  },
}

// re-export for the route layer's error message (single source of truth)
export { EXPIRY_ORACLE_MIN_CANDLES }
