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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { AssetCategory, Timeframe } from '../types'
import { TIMEFRAME_SECONDS } from '../types'
import type { MarketDataService } from './market-data'
import { fitLeadLag, projectLeadLagSignal } from '../analytics/leadlag'
import { LeadLagOutcomeTracker, type LeadLagStats, type ResolvedLeadLagOutcome } from '../analytics/leadlagoutcomes'
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
const SWEEP_MS = 5_000 // outcome sampling / resolution cadence, same cadence chart-signals uses
const FLUSH_MS = 10_000 // debounced outcomes persistence
/** How long after its last consumer request a tf stays "active" for the
 * self-driving rescan below - mirrors chartsignals.ts's activeCombos: the
 * honesty loop needs to keep recording/resolving outcomes even while no
 * panel is actively polling (e.g. an overnight soak test), but only for a
 * tf someone actually asked about recently - not every timeframe forever. */
const ACTIVE_MS = 30 * 60_000
const SELF_SCAN_MS = CACHE_MS

export class LeadLagScanService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private cache = new Map<Timeframe, { ts: number; result: LeadLagScanResult }>()
  private tracker = new LeadLagOutcomeTracker()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private selfScanTimer: ReturnType<typeof setInterval> | null = null
  private outcomesPath = join(process.cwd(), 'data', 'leadlag_outcomes.json')
  // tf -> last consumer-request ts; only recently-requested tfs get the
  // self-driving rescan below, so the honesty loop runs for whatever the
  // panel/auto-trader actually uses without scanning every tf forever
  private activeTfs = new Map<Timeframe, number>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.loadOutcomes()
    this.sweepTimer = setInterval(() => {
      try {
        const resolved = this.tracker.tick(Date.now(), (a) => this.market.getPrice(a))
        if (resolved.length) {
          ctx.log('lead-lag-scan', `resolved ${resolved.length} lead-lag outcome(s) (${resolved.map((r) => `${r.leader}->${r.asset} ${r.outcome}`).join(', ')})`)
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
    // self-driving rescan: votes/fits only change on closed candles, but
    // unlike chart-signals this scanner has no bar-close bus event to hook
    // (it only touches the small LEADLAG_GROUPS roster) - a plain interval
    // re-scanning every recently-active tf is simple and cheap enough here.
    // This is what keeps outcomes accruing while no panel is open polling.
    this.selfScanTimer = setInterval(() => {
      const now = Date.now()
      for (const [tf, lastRequested] of this.activeTfs) {
        if (now - lastRequested > ACTIVE_MS) {
          this.activeTfs.delete(tf)
          continue
        }
        try {
          this.scan(tf) // updates cache + records qualifying rows into the outcome tracker
        } catch {
          /* a failed self-scan just waits for the next tick */
        }
      }
    }, SELF_SCAN_MS)
    ctx.log('lead-lag-scan', 'lead-lag correlation scanner online (EURUSD/XAUUSD/BTCUSD/oil leader groups) + outcome tracking')
  }

  private loadOutcomes(): void {
    try {
      const raw = JSON.parse(readFileSync(this.outcomesPath, 'utf8')) as { resolved?: ResolvedLeadLagOutcome[] }
      this.tracker = new LeadLagOutcomeTracker(raw.resolved ?? [])
      if (raw.resolved?.length) {
        this.ctx.log('lead-lag-scan', `restored ${raw.resolved.length} tracked lead-lag outcomes from data/`)
      }
    } catch {
      /* no file yet - start clean */
    }
  }

  /** Outcome stats for the panel's hit-rate view. tf filters to one
   * timeframe's reads; omitted = all timeframes blended. */
  stats(tf?: Timeframe): LeadLagStats {
    return this.tracker.stats(tf)
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

    // every currently-qualifying row becomes (or stays) a pending outcome
    // claim - the honesty loop that actually tells us whether this source
    // is worth having, not just whether the fit looks plausible
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
          correlation: r.correlation,
          lag: r.lag,
          triggerZ: r.triggerZ,
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
   * of tickers named in LEADLAG_GROUPS). Marks the tf active, arming the
   * self-driving rescan above for ACTIVE_MS - same "stops being pull-only
   * once someone's watching" idea chart-signals uses for bar-close rescans. */
  scan(tf: Timeframe): LeadLagScanResult {
    this.activeTfs.set(tf, Date.now())
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
