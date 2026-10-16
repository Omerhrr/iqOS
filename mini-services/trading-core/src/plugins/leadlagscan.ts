// IQAIR//OS - Lead-lag scanner (panel-facing)
// os-mode.ts's pickLeadLagSignal() computes lead-lag fits privately, once
// per auto-trader tick, gated straight through to a trade decision - there
// was no way to just LOOK at the correlation/lag picture without the
// auto-trader running. This service re-runs the exact same fit (same
// LEADLAG_GROUPS, same thresholds, same fitLeadLag/projectLeadLagSignal
// pure functions) for every leader/follower pair and returns the FULL
// table - including pairs that don't currently clear the trading
// thresholds - so a panel can show "here's every group, here's what's
// correlated right now and what isn't" the same way chart-signals' /signals
// endpoint shows every chart-engine read, not just the ones an auto-trader
// would act on. Read-only: never places a trade, never touches sweepEdge
// memory, and is cheap enough (a handful of in-memory candle reads per
// poll) to recompute on every request rather than needing scan/peek/
// background-rescan machinery like the chart-signals scanner does.

import type { KernelContext, Plugin } from '../kernel'
import type { AssetCategory, Timeframe } from '../types'
import type { MarketDataService } from './market-data'
import { fitLeadLag, projectLeadLagSignal } from '../analytics/leadlag'
import { LEADLAG_GROUPS, LEADLAG_LOOKBACK_BARS, LEADLAG_MIN_ABS_CORRELATION, LEADLAG_MIN_TRIGGER_Z } from './os-mode'

export interface LeadLagRow {
  leader: string
  asset: string
  name: string
  category: AssetCategory
  otc: boolean
  open: boolean
  price: number
  lag: number
  correlation: number
  lagsTested: number
  n: number
  triggerReturn: number
  triggerZ: number
  /** null when there wasn't enough history/overlap to fit anything honest -
   * distinct from a fit that WAS computed but reads as flat/no-direction. */
  direction: 'call' | 'put' | null
  /** true iff this row currently clears every gate pickLeadLagSignal()
   * itself requires (|corr| + |triggerZ| thresholds, enough overlap) - i.e.
   * this is exactly what the auto-trader would see as a tradeable edge on
   * this pair right now, independent of score/confidence/cooldown gates
   * that depend on the live AutoTraderConfig rather than the fit itself. */
  qualifies: boolean
  ts: number
}

export interface LeadLagScanResult {
  ok: true
  tf: Timeframe
  groups: { leader: string; open: boolean; followers: number }[]
  scanned: number
  qualifying: number
  rows: LeadLagRow[]
  ts: number
  scanMs: number
}

const CACHE_MS = 15_000 // correlation/lag drift slowly bar-to-bar - no need to recompute every poll

export class LeadLagScanService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private cache = new Map<Timeframe, { ts: number; result: LeadLagScanResult }>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('lead-lag-scan', 'lead-lag correlation scanner online (EURUSD/XAUUSD/BTCUSD/oil leader groups)')
  }

  private scanOnce(tf: Timeframe): LeadLagScanResult {
    const t0 = Date.now()
    const assets = this.market.assets
    const byTicker = new Map(assets.map((a) => [a.ticker, a]))
    const open = new Set(assets.filter((a) => a.open).map((a) => a.ticker))
    const leaderCloseCache = new Map<string, number[] | null>()
    const rows: LeadLagRow[] = []
    const groupMeta: { leader: string; open: boolean; followers: number }[] = []
    let scanned = 0

    for (const group of LEADLAG_GROUPS) {
      const leaderOpen = open.has(group.leader)
      groupMeta.push({ leader: group.leader, open: leaderOpen, followers: group.followers.length })
      let leaderCloses = leaderCloseCache.get(group.leader)
      if (leaderCloses === undefined) {
        try {
          leaderCloses = leaderOpen
            ? (() => {
                const candles = this.market.getCandles(group.leader, tf, LEADLAG_LOOKBACK_BARS, true)
                return candles.length >= 30 ? candles.map((c) => c.close) : null
              })()
            : null
        } catch {
          leaderCloses = null
        }
        leaderCloseCache.set(group.leader, leaderCloses)
      }
      for (const asset of group.followers) {
        scanned++
        const inst = byTicker.get(asset)
        const isOpen = open.has(asset)
        const base: Omit<LeadLagRow, 'lag' | 'correlation' | 'lagsTested' | 'n' | 'triggerReturn' | 'triggerZ' | 'direction' | 'qualifies'> = {
          leader: group.leader,
          asset,
          name: inst?.name ?? asset,
          category: (inst?.category ?? 'forex') as AssetCategory,
          otc: inst?.otc ?? asset.endsWith('-OTC'),
          open: isOpen,
          price: 0,
          ts: Date.now(),
        }
        if (!leaderCloses || !isOpen) {
          rows.push({ ...base, lag: 0, correlation: 0, lagsTested: 0, n: 0, triggerReturn: 0, triggerZ: 0, direction: null, qualifies: false })
          continue
        }
        try {
          const followerCandles = this.market.getCandles(asset, tf, LEADLAG_LOOKBACK_BARS, true)
          if (followerCandles.length < 30) {
            rows.push({ ...base, lag: 0, correlation: 0, lagsTested: 0, n: 0, triggerReturn: 0, triggerZ: 0, direction: null, qualifies: false })
            continue
          }
          const price = followerCandles[followerCandles.length - 1]?.close ?? 0
          const followerCloses = followerCandles.map((c) => c.close)
          const fit = fitLeadLag(leaderCloses, followerCloses, 10)
          const signal = fit.n >= 10 ? projectLeadLagSignal(fit, leaderCloses) : null
          const qualifies =
            fit.n >= 10 &&
            Math.abs(fit.correlation) >= LEADLAG_MIN_ABS_CORRELATION &&
            !!signal &&
            Math.abs(signal.triggerZ) >= LEADLAG_MIN_TRIGGER_Z
          rows.push({
            ...base,
            price,
            lag: fit.lag,
            correlation: fit.correlation,
            lagsTested: fit.lagsTested,
            n: fit.n,
            triggerReturn: signal?.triggerReturn ?? 0,
            triggerZ: signal?.triggerZ ?? 0,
            direction: signal?.direction ?? null,
            qualifies,
          })
        } catch {
          rows.push({ ...base, lag: 0, correlation: 0, lagsTested: 0, n: 0, triggerReturn: 0, triggerZ: 0, direction: null, qualifies: false })
        }
      }
    }

    rows.sort((a, b) => Number(b.qualifies) - Number(a.qualifies) || Math.abs(b.correlation) - Math.abs(a.correlation))
    return {
      ok: true,
      tf,
      groups: groupMeta,
      scanned,
      qualifying: rows.filter((r) => r.qualifies).length,
      rows,
      ts: Date.now(),
      scanMs: Date.now() - t0,
    }
  }

  /** Cached per-tf for CACHE_MS - cheap enough to just recompute on expiry,
   * no scanning-dedup/background-rescan machinery needed (unlike the full
   * open-universe chart-signals scan, this only ever touches the handful
   * of tickers named in LEADLAG_GROUPS). */
  scan(tf: Timeframe): LeadLagScanResult {
    const cached = this.cache.get(tf)
    const now = Date.now()
    if (cached && now - cached.ts < CACHE_MS) return cached.result
    const result = this.scanOnce(tf)
    this.cache.set(tf, { ts: result.ts, result })
    return result
  }
}

export const leadLagScanPlugin: Plugin = {
  name: 'lead-lag-scan',
  start: async (ctx) => {
    const svc = new LeadLagScanService()
    ctx.provide('leadLagScan', svc)
    await svc.start(ctx)
  },
}
