// IQAIR//OS - Cointegration scanner (panel-facing) + outcome tracking
// Same role/shape as leadlagscan.ts for its own source: re-runs the
// Engle-Granger pairs fit (analytics/cointegration.ts) over every
// leader/follower pair in LEADLAG_GROUPS (same roster lead-lag scans - a
// stable long-run price relationship is at least as plausible between the
// same macro-linked pairs), returns the full table, and - new vs the old
// bare index.ts module function this replaces - records every qualifying
// row as a tracked claim so there is finally a REAL answer to "does
// cointegration actually work on this feed" instead of just a plausible
// fit (task: next-candle-oracle real-edge audit, 2026-11-02 - lead-lag and
// chart-signals already had this; cointegration and vol-arb never did).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { AssetCategory, Timeframe } from '../types'
import { TIMEFRAME_SECONDS } from '../types'
import type { MarketDataService } from './market-data'
import { fitCointegration, COINTEGRATION_WINDOW, COINTEGRATION_MIN_R2, COINTEGRATION_MIN_TSTAT, COINTEGRATION_MAX_HALFLIFE } from '../analytics/cointegration'
import { LEADLAG_GROUPS } from './os-mode'
import { CointegrationOutcomeTracker, type CointegrationStats, type ResolvedCointegrationOutcome } from '../analytics/cointegrationoutcomes'

export interface CointegrationScanRow {
  leader: string
  asset: string
  name: string
  category: AssetCategory
  otc: boolean
  open: boolean
  price: number
  beta: number
  r2: number
  z: number
  tStat: number
  halfLifeBars: number
  n: number
  direction: 'call' | 'put' | null
  /** clears the SAME gates the cointegration-pairs strategy itself requires
   * (minR2/minTStat/maxHalfLife) plus a |z| >= 1.5 entry. */
  qualifies: boolean
  ts: number
}

export interface CointegrationScanResult {
  ok: true
  tf: Timeframe
  scanned: number
  qualifying: number
  rows: CointegrationScanRow[]
  ts: number
  scanMs: number
}

const CACHE_MS = 15_000 // beta/spread fit drifts slowly bar-to-bar, same cadence leadlagscan.ts uses
const SWEEP_MS = 5_000
const FLUSH_MS = 10_000
const ACTIVE_MS = 30 * 60_000
const SELF_SCAN_MS = CACHE_MS

export class CointegrationScanService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private cache = new Map<Timeframe, { ts: number; result: CointegrationScanResult }>()
  private tracker = new CointegrationOutcomeTracker()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private selfScanTimer: ReturnType<typeof setInterval> | null = null
  private outcomesPath = join(process.cwd(), 'data', 'cointegration_outcomes.json')
  private activeTfs = new Map<Timeframe, number>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.loadOutcomes()
    this.sweepTimer = setInterval(() => {
      try {
        const resolved = this.tracker.tick(Date.now(), (a) => this.market.getPrice(a))
        if (resolved.length) {
          ctx.log('cointegration-scan', `resolved ${resolved.length} cointegration outcome(s) (${resolved.map((r) => `${r.leader}->${r.asset} ${r.outcome}`).join(', ')})`)
        }
      } catch {
        /* the honesty loop never breaks scanning */
      }
    }, SWEEP_MS)
    this.flushTimer = setInterval(() => {
      if (!this.tracker.needsFlush) return
      try {
        mkdirSync(join(process.cwd(), 'data'), { recursive: true })
        writeFileSync(this.outcomesPath, JSON.stringify({ savedAt: Date.now(), ...this.tracker.state() }))
        this.tracker.markFlushed()
      } catch {
        /* persistence is best-effort */
      }
    }, FLUSH_MS)
    this.selfScanTimer = setInterval(() => {
      const now = Date.now()
      for (const [tf, lastRequested] of this.activeTfs) {
        if (now - lastRequested > ACTIVE_MS) {
          this.activeTfs.delete(tf)
          continue
        }
        try {
          this.scan(tf)
        } catch {
          /* a failed self-scan just waits for the next tick */
        }
      }
    }, SELF_SCAN_MS)
    ctx.log('cointegration-scan', 'cointegration (Engle-Granger pairs) scanner online + outcome tracking')
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.selfScanTimer) clearInterval(this.selfScanTimer)
  }

  private loadOutcomes(): void {
    try {
      const raw = JSON.parse(readFileSync(this.outcomesPath, 'utf8')) as { resolved?: ResolvedCointegrationOutcome[] }
      this.tracker = new CointegrationOutcomeTracker(raw.resolved ?? [])
      if (raw.resolved?.length) {
        this.ctx.log('cointegration-scan', `restored ${raw.resolved.length} tracked cointegration outcomes from data/`)
      }
    } catch {
      /* no file yet - start clean */
    }
  }

  stats(tf?: Timeframe): CointegrationStats {
    return this.tracker.stats(tf)
  }

  private scanOnce(tf: Timeframe): CointegrationScanResult {
    const t0 = Date.now()
    const rows: CointegrationScanRow[] = []
    const byTicker = new Map(this.market.assets.map((a) => [a.ticker, a]))
    const leaderCloseCache = new Map<string, number[] | null>()
    let scanned = 0
    for (const group of LEADLAG_GROUPS) {
      const leaderInfo = byTicker.get(group.leader)
      let leaderCloses = leaderCloseCache.get(group.leader)
      if (leaderCloses === undefined) {
        try {
          leaderCloses = leaderInfo?.open ? this.market.getCandlesDeep(group.leader, tf, Math.max(600, COINTEGRATION_WINDOW + 50), true).map((c) => c.close) : null
        } catch {
          leaderCloses = null
        }
        leaderCloseCache.set(group.leader, leaderCloses)
      }
      if (!leaderCloses || leaderCloses.length < 30) continue
      for (const asset of group.followers) {
        scanned++
        const inst = byTicker.get(asset)
        if (!inst?.open) continue
        try {
          const candles = this.market.getCandlesDeep(asset, tf, Math.max(600, COINTEGRATION_WINDOW + 50), true)
          if (candles.length < 30) continue
          const fit = fitCointegration(leaderCloses, candles.map((c) => c.close), COINTEGRATION_WINDOW)
          if (!fit) continue
          const qualifies = fit.r2 >= COINTEGRATION_MIN_R2 && fit.tStat >= COINTEGRATION_MIN_TSTAT && fit.halfLifeBars <= COINTEGRATION_MAX_HALFLIFE && Math.abs(fit.z) >= 1.5
          rows.push({
            leader: group.leader,
            asset,
            name: inst.name,
            category: inst.category,
            otc: !!inst.otc,
            open: inst.open,
            price: candles[candles.length - 1]?.close ?? 0,
            beta: fit.beta,
            r2: fit.r2,
            z: fit.z,
            tStat: fit.tStat,
            halfLifeBars: fit.halfLifeBars,
            n: fit.n,
            direction: fit.z <= -1.5 ? 'call' : fit.z >= 1.5 ? 'put' : null,
            qualifies,
            ts: Date.now(),
          })
        } catch {
          /* one bad pair never breaks the scan */
        }
      }
    }
    rows.sort((x, y) => Number(y.qualifies) - Number(x.qualifies) || Math.abs(y.z) - Math.abs(x.z))

    const nowMs = Date.now()
    const tfSec = TIMEFRAME_SECONDS[tf]
    const qualifyingRows = rows.filter((r) => r.qualifies && r.direction)
    try {
      this.tracker.record(
        qualifyingRows.map((r) => ({
          leader: r.leader,
          asset: r.asset,
          tf,
          otc: r.otc,
          direction: r.direction as 'call' | 'put',
          price: r.price,
          beta: r.beta,
          r2: r.r2,
          z: r.z,
          tStat: r.tStat,
          halfLifeBars: r.halfLifeBars,
          tfSec,
        })),
        nowMs,
      )
      const liveKeys = new Set(qualifyingRows.map((r) => `${r.leader}|${r.asset}|${r.direction}`))
      this.tracker.pruneStale(liveKeys, nowMs)
    } catch {
      /* tracking never breaks the scan */
    }

    return {
      ok: true,
      tf,
      scanned,
      qualifying: rows.filter((r) => r.qualifies).length,
      rows,
      ts: Date.now(),
      scanMs: Date.now() - t0,
    }
  }

  scan(tf: Timeframe): CointegrationScanResult {
    this.activeTfs.set(tf, Date.now())
    const cached = this.cache.get(tf)
    const now = Date.now()
    if (cached && now - cached.ts < CACHE_MS) return cached.result
    const result = this.scanOnce(tf)
    this.cache.set(tf, { ts: result.ts, result })
    return result
  }
}

export const cointegrationScanPlugin: Plugin = {
  name: 'cointegration-scan',
  start: async (ctx) => {
    const svc = new CointegrationScanService()
    ctx.provide('cointegrationScan', svc)
    await svc.start(ctx)
  },
}
