// IQAIR//OS - same-time-yesterday scanner plugin
// For every open instrument: what was the market doing EXACTLY 24h ago, and
// in the window right after? The scan walks the whole open universe (same
// session-aware open set as the chart-signals scanner), pulls a deep candle
// read on the requested timeframe (bar that was forming at T-24h must be in
// the series), and lets analytics/yesterday build each row: price at the
// moment, the forward window's net move / range / run-up / drawdown, where
// price has gone since, session context and window coverage. Rows sort by
// |move| - the biggest "yesterday at this hour" stories lead.
//
// tf respect (same rule as /signals): the caller names the timeframe, the
// lookback runs on those candles, and the cache is keyed per tf:window so a
// 1m story and a 5m story never bleed into each other. Timeframes whose
// 24h + window lookback cannot fit the 4000-bar archive depth (5s / 15s)
// are refused with a clear 400 instead of silently answering from a
// fraction of the day. The result is cached 60s - a T-24h target crawls
// forward one second per second, so rapid panel polls share one scan.

import type { KernelContext, Plugin } from '../kernel'
import type { Candle, Timeframe } from '../types'
import { TIMEFRAME_SECONDS } from '../types'
import { isInstrumentOpen, searchInstruments } from '../universe'
import type { Store } from '../store'
import { buildYesterdayRow, type YesterdayRow } from '../analytics/yesterday'
import type { MarketDataService } from './market-data'

const UNIVERSE_HARD_CAP = 200 // same safety valve as the chart-signals scan
const CACHE_MS = 60_000
const DAY_SEC = 86_400
const MAX_LOOKBACK_BARS = 4000 // mirrors the archive cap - beyond this the history is not there

export interface YesterdayResult {
  ok: true
  tf: Timeframe
  /** effective forward window in minutes (snapped to whole bars of the tf) */
  windowMin: number
  /** feed behind the scan: 'sim' = deterministic sim engine, 'live' = broker feed */
  mode: 'sim' | 'live'
  scanned: number
  /** rows that passed the coverage gate (enough window bars to tell the story) */
  considered: number
  /** dropped for thin history - market dark at that hour yesterday / asset never warmed */
  skipped: number
  rows: YesterdayRow[]
  ts: number
  scanMs: number
}

export class YesterdayService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private store: Store | null = null
  // keyed tf:windowSec - a 1m/60min story and a 5m/60min story live side by side
  private cache = new Map<string, { ts: number; result: YesterdayResult }>()
  private inflight = new Map<string, Promise<YesterdayResult>>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    try {
      this.store = ctx.use<Store>('storeRaw')
    } catch {
      this.store = null // no archive - provenance counts stay 0 (all seeded)
    }
    ctx.log('yesterday', 'same-time-yesterday scanner online (T-24h window replay per open instrument)')
  }

  /** Quantized request plan: window snapped to whole bars of the tf (>= 1
   * bar), plus whether the 24h + window lookback fits the archive depth. */
  static plan(tf: Timeframe, windowMin: number): { windowSec: number; windowMin: number; ok: boolean; needed: number } {
    const tfSec = TIMEFRAME_SECONDS[tf]
    const windowSec = Math.max(1, Math.floor((Math.max(1, windowMin) * 60) / tfSec)) * tfSec
    const needed = Math.ceil((DAY_SEC + windowSec) / tfSec) + 2
    return { windowSec, windowMin: Math.round(windowSec / 60), ok: needed <= MAX_LOOKBACK_BARS, needed }
  }

  /** Fresh scan (cached per tf:windowSec for CACHE_MS), inflight-deduped. */
  async scan(tf: Timeframe, windowMin: number): Promise<YesterdayResult> {
    const plan = YesterdayService.plan(tf, windowMin)
    const key = `${tf}:${plan.windowSec}`
    const cached = this.cache.get(key)
    const now = Date.now()
    if (cached && now - cached.ts < CACHE_MS) return cached.result
    const running = this.inflight.get(key)
    if (running) return running
    const p = this.scanOnce(tf, plan).then((r) => {
      this.cache.set(key, { ts: r.ts, result: r })
      this.inflight.delete(key)
      return r
    })
    this.inflight.set(key, p)
    return p
  }

  /** How many bars of the window came from the kernel's own store (real
   * accumulated history - broker bars in live mode) vs deterministic
   * prehistory. Read-only, best-effort: provenance never breaks the scan. */
  private archivedIn(asset: string, tf: Timeframe, fromTs: number, toTs: number): number {
    if (!this.store) return 0
    try {
      const arch = this.store.getCandlesArchive(asset, tf, MAX_LOOKBACK_BARS)
      return arch.filter((c) => c.time >= fromTs && c.time < toTs).length
    } catch {
      return 0
    }
  }

  private async scanOnce(tf: Timeframe, plan: { windowSec: number; windowMin: number }): Promise<YesterdayResult> {
    const t0wall = Date.now()
    const tfSec = TIMEFRAME_SECONDS[tf]
    const nowSec = Math.floor(Date.now() / 1000)
    const active = this.market.activeAsset
    // Session-aware open set: same rescue rule as the chart-signals scan -
    // curated rows carry a static open=false at boot, the time-of-day check
    // admits them when their session is actually running.
    const universe = searchInstruments('', 'all')
      .filter((i) => i.open || isInstrumentOpen(i))
      .sort((a, b) => (a.ticker === active ? -1 : b.ticker === active ? 1 : 0))
      .slice(0, UNIVERSE_HARD_CAP)
    const limit = Math.min(MAX_LOOKBACK_BARS, Math.ceil((DAY_SEC + plan.windowSec) / tfSec) + 2)

    let scanned = 0
    const rows: YesterdayRow[] = []
    const CHUNK = 4
    for (let i = 0; i < universe.length; i += CHUNK) {
      await Promise.all(
        universe.slice(i, i + CHUNK).map(async (info) => {
          scanned++
          let candles: Candle[] = []
          try {
            candles = this.market.getCandlesLookback(info.ticker, tf, limit)
          } catch {
            return
          }
          if (candles.length < 3) return
          const p = this.market.getPrice(info.ticker)
          const nowPrice = p > 0 ? p : candles[candles.length - 1].close
          // window start bucket for the provenance count - same bucket math
          // as analytics/yesterday (bar opens are tf-aligned)
          const target = nowSec - DAY_SEC
          const w0 = target - (target % tfSec)
          const archived = this.archivedIn(info.ticker, tf, w0, w0 + plan.windowSec)
          const row = buildYesterdayRow(
            { ticker: info.ticker, name: info.name, category: info.category, otc: !!info.otc },
            candles,
            { nowSec, windowSec: plan.windowSec, tfSec, nowPrice, archived },
          )
          if (row) rows.push(row)
        }),
      )
    }

    rows.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct))
    return {
      ok: true,
      tf,
      windowMin: plan.windowMin,
      mode: this.market.mode,
      scanned,
      considered: rows.length,
      skipped: scanned - rows.length,
      rows,
      ts: Date.now(),
      scanMs: Date.now() - t0wall,
    }
  }
}

export const yesterdayPlugin: Plugin = {
  name: 'yesterday',
  start: async (ctx) => {
    const svc = new YesterdayService()
    ctx.provide('yesterday', svc)
    await svc.start(ctx)
  },
}
