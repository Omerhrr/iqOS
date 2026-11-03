// IQAIR//OS - Smart Money Concepts scan service (panel-facing)
// Thin cache+lifecycle wrapper over analytics/smc.ts, same shape as every
// other *ScanService (leadlagscan/cointegrationscan/volarbscan): cache per
// asset:tf so a busy panel polling every few seconds doesn't recompute the
// whole candle walk on every request, plus a self-scan sweep so a tab left
// open keeps its result fresh even between polls. No outcome tracking here
// yet (see smc.ts's module header) - this is detection-only until it's
// validated against real resolved outcomes.
import type { KernelContext, Plugin } from '../kernel'
import type { Timeframe } from '../types'
import type { MarketDataService } from './market-data'
import { scanSmc, type SmcScanResult } from '../analytics/smc'

const CACHE_MS = 10_000
const SELF_SCAN_MS = CACHE_MS
const ACTIVE_MS = 20 * 60_000
const CANDLE_LOOKBACK = 300

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

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.selfScanTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, lastRequested] of this.activeKeys) {
        if (now - lastRequested > ACTIVE_MS) {
          this.activeKeys.delete(key)
          continue
        }
        const [asset, tf] = key.split('|') as [string, Timeframe]
        try {
          this.scan(asset, tf)
        } catch {
          /* a failed self-scan just waits for the next tick */
        }
      }
    }, SELF_SCAN_MS)
    ctx.log('smc-scan', 'smart-money-concepts scanner online (FVG/OB/BOS/CHoCH/sweep/OTE/breaker/S&D/S&R/breakout/CRT/Po3/Silver Bullet/KRM)')
  }

  stop(): void {
    if (this.selfScanTimer) clearInterval(this.selfScanTimer)
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
    if (cached && now - cached.ts < CACHE_MS) return cached.result
    const result = this.scanOnce(asset, tf)
    this.cache.set(key, { ts: result.ts, result })
    return result
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
