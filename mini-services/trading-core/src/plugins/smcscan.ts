// IQAIR//OS - Smart Money Concepts scan service (panel-facing)
// Thin cache+lifecycle wrapper over analytics/smc.ts, same shape as every
// other *ScanService (leadlagscan/cointegrationscan/volarbscan): cache per
// asset:tf so a busy panel polling every few seconds doesn't recompute the
// whole candle walk on every request, plus a self-scan sweep so a tab left
// open keeps its result fresh even between polls.
//
// Outcome tracking: now wired (analytics/smcoutcomes.ts), same sweep/flush
// cadence leadlagscan.ts uses for its own honesty loop - every scan whose
// summary clears SmcOutcomeTracker's confidence floor becomes (or stays)
// a pending claim, resolved against the asset's own price at a flat
// bar-count horizon. This is what will let the next-candle Oracle's SMC
// driver (#10, currently an unvalidated guessed weight - see
// analytics/nextcandle.ts) eventually get re-weighted against real
// resolved outcomes via /smc_stats, same "validate before wire" discipline
// every other source here went through - applied retroactively since SMC
// was wired ahead of it, per direct instruction at the time.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { Timeframe } from '../types'
import { TIMEFRAME_SECONDS } from '../types'
import type { MarketDataService } from './market-data'
import { scanSmc, type SmcScanResult } from '../analytics/smc'
import { SmcOutcomeTracker, type SmcOutcomeStats, type ResolvedSmcOutcome } from '../analytics/smcoutcomes'

const CACHE_MS = 10_000
const SELF_SCAN_MS = CACHE_MS
const ACTIVE_MS = 20 * 60_000
const CANDLE_LOOKBACK = 300
const SWEEP_MS = 5_000 // outcome sampling/resolution cadence, same as leadlagscan.ts
const FLUSH_MS = 10_000 // debounced outcomes persistence

export interface SmcScanResponse {
  ok: true
  asset: string
  tf: Timeframe
  result: SmcScanResult | null
  ts: number
  scanMs: number
}

export class SmcScanService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private cache = new Map<string, { ts: number; result: SmcScanResponse }>()
  private activeKeys = new Map<string, number>()
  private selfScanTimer: ReturnType<typeof setInterval> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private tracker = new SmcOutcomeTracker()
  private outcomesPath = join(process.cwd(), 'data', 'smc_outcomes.json')

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.loadOutcomes()
    this.selfScanTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, lastRequested] of this.activeKeys) {
        if (now - lastRequested > ACTIVE_MS) {
          this.activeKeys.delete(key)
          continue
        }
        const [asset, tf] = key.split('|') as [string, Timeframe]
        try {
          this.scan(asset, tf) // updates cache + records qualifying claims into the outcome tracker
        } catch {
          /* a failed self-scan just waits for the next tick */
        }
      }
    }, SELF_SCAN_MS)
    this.sweepTimer = setInterval(() => {
      try {
        const resolved = this.tracker.tick(Date.now(), (a) => this.market.getPrice(a))
        if (resolved.length) {
          ctx.log('smc-scan', `resolved ${resolved.length} SMC outcome(s) (${resolved.map((r) => `${r.asset} ${r.outcome}`).join(', ')})`)
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
    ctx.log('smc-scan', 'smart-money-concepts scanner online (FVG/OB/BOS/CHoCH/sweep/OTE/breaker/S&D/S&R/breakout/CRT/Po3/Silver Bullet/KRM) + outcome tracking')
  }

  stop(): void {
    if (this.selfScanTimer) clearInterval(this.selfScanTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.flushTimer) clearInterval(this.flushTimer)
  }

  private loadOutcomes(): void {
    try {
      const raw = JSON.parse(readFileSync(this.outcomesPath, 'utf8')) as { resolved?: ResolvedSmcOutcome[] }
      this.tracker = new SmcOutcomeTracker(raw.resolved ?? [])
      if (raw.resolved?.length) {
        this.ctx.log('smc-scan', `restored ${raw.resolved.length} tracked SMC outcomes from data/`)
      }
    } catch {
      /* no file yet - start clean */
    }
  }

  /** Outcome stats for the panel's hit-rate view, and eventually for
   * re-weighting the Oracle's SMC driver. tf filters to one timeframe's
   * reads; omitted = all timeframes blended. */
  stats(tf?: Timeframe): SmcOutcomeStats {
    return this.tracker.stats(tf)
  }

  private scanOnce(asset: string, tf: Timeframe): SmcScanResponse {
    const t0 = Date.now()
    let result: SmcScanResult | null = null
    try {
      const candles = this.market.getCandlesDeep(asset, tf, CANDLE_LOOKBACK, true)
      result = scanSmc(candles)
    } catch {
      result = null
    }
    return { ok: true, asset, tf, result, ts: Date.now(), scanMs: Date.now() - t0 }
  }

  scan(asset: string, tf: Timeframe): SmcScanResponse {
    const key = `${asset}|${tf}`
    this.activeKeys.set(key, Date.now())
    const cached = this.cache.get(key)
    const now = Date.now()
    if (cached && now - cached.ts < CACHE_MS) {
      this.recordFromResponse(asset, tf, cached.result)
      return cached.result
    }
    const result = this.scanOnce(asset, tf)
    this.cache.set(key, { ts: result.ts, result })
    this.recordFromResponse(asset, tf, result)
    return result
  }

  /** Feed the current summary into the outcome tracker (record a fresh
   * claim if it clears the confidence floor and isn't already pending,
   * prune any pending claim whose direction the summary has since dropped)
   * - called on every scan, cached or fresh, same as leadlagscan.ts's
   * scanOnce does for its own tracker but split out since this service's
   * cache can serve a result without recomputing it. */
  private recordFromResponse(asset: string, tf: Timeframe, resp: SmcScanResponse): void {
    const r = resp.result
    if (!r || r.summary.direction === 'none') return
    try {
      const now = Date.now()
      this.tracker.record(
        {
          asset,
          tf,
          tfSec: TIMEFRAME_SECONDS[tf],
          price: r.price,
          direction: r.summary.direction,
          confidence: r.summary.confidence,
          trend: r.trend,
          bullish: r.summary.bullish,
          bearish: r.summary.bearish,
        },
        now,
      )
      const liveKey = `${asset}|${tf}|${r.summary.direction}`
      this.tracker.pruneStale(new Set([liveKey]), now)
    } catch {
      /* tracking never breaks the scan */
    }
  }
}

export const smcScanPlugin: Plugin = {
  name: 'smc-scan',
  start: async (ctx) => {
    const svc = new SmcScanService()
    ctx.provide('smcScan', svc)
    await svc.start(ctx)
  },
}
