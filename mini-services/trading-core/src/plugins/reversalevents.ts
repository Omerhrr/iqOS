// IQAIR//OS - Renko / Kagi reversal event feeds plugin
//
// Two shapes over analytics/reversalevents.ts:
//   - renko()/kagi(): the full event feed for ONE pair on ONE timeframe.
//   - globalRenko()/globalKagi(): the whole-universe "who is reversing NOW"
//     boards - every open pair x every scan timeframe (30s..15m), keeping only
//     the pair/tf series whose newest event is fresh (at most `fresh` closed
//     candles old). This is what the panels use: the question they answer is
//     "which charts just flipped", never "what is the open pair doing".
//
// Candle fidelity only (closed bars) - both engines are SAFE_BACKTEST_SOURCES
// tier, so live and backtest reads agree bar-for-bar. Feeds are TTL-cached per
// pair/tf/source; the freshness filter is applied at read time, so changing
// `fresh` costs nothing.

import type { KernelContext, Plugin } from '../kernel'
import type { Candle, Timeframe } from '../types'
import {
  kagiReversalFeed,
  renkoReversalFeed,
  type FeedOpts,
  type FollowThroughStat,
  type KagiFeedEvent,
  type KagiReversalFeed,
  type RenkoReversalEvent,
  type RenkoReversalFeed,
  type ReversalSource,
} from '../analytics/reversalevents'
import type { EffortRegime } from '../analytics/effortbricks'
import type { KagiRegime } from '../analytics/kagi'
import type { MarketDataService } from './market-data'

const DEFAULT_TF: Timeframe = '1m'
const VALID_TF = new Set<string>(['5s', '15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d'])
/** Closed bars searched for a single-pair read. */
const WINDOW = 800
/** Closed bars searched per pair/tf on the board scan - enough for a useful
 * follow-through sample on the series that fire, cheap across hundreds of series. */
const SCAN_WINDOW = 500
const SCAN_TTL_MS = 20_000
/** The board's timeframe ladder: 30s up to 15m. */
export const BOARD_TFS: Timeframe[] = ['30s', '1m', '2m', '5m', '15m']
/** Oldest an event may be (closed candles) and still count as "reversing now". */
export const MAX_FRESH_CANDLES = 3

export type FeedResult<T> = { ok: true; result: T } | { ok: false; error: string }

export interface BoardMeta {
  scannedTs: number
  /** open instruments considered */
  universe: number
  /** pair x tf series with enough candles to read */
  series: number
  /** pair x tf series that returned nothing (no history on that tf) */
  noData: number
  tfs: Timeframe[]
  /** the freshness window used: events at most this many closed candles old */
  fresh: number
}

export interface RenkoBoardRow {
  asset: string
  tf: Timeframe
  price: number
  computedTs: number
  source: ReversalSource
  /** the pair/tf's newest reversal (always within `fresh` candles) */
  event: RenkoReversalEvent
  trend: 'up' | 'down' | 'none'
  streak: number
  brickSize: number
  /** participation regime now (effort source only) */
  regime: EffortRegime | null
  confirmedRatio: number
  /** follow-through of THIS event's kind on this pair/tf's own window (confirmed / unconfirmed, or 'all' on plain Renko) */
  stat: FollowThroughStat | null
}

export interface RenkoBoard extends BoardMeta {
  source: ReversalSource
  rows: RenkoBoardRow[]
}

export interface KagiBoardRow {
  asset: string
  tf: Timeframe
  price: number
  computedTs: number
  /** every fresh event on this pair/tf, newest first (a yin/yang and a reversal can share a candle) */
  events: KagiFeedEvent[]
  direction: 'up' | 'down' | 'none'
  thick: boolean
  regime: KagiRegime
  structure: 'hh-hl' | 'lh-ll' | 'none'
  /** follow-through of each fresh event kind on this pair/tf's own window, by kind */
  stats: Record<string, FollowThroughStat>
}

export interface KagiBoard extends BoardMeta {
  rows: KagiBoardRow[]
}

interface ScanOpts {
  fresh?: number
  tfs?: string[]
  category?: string
  refresh?: boolean
}

export class ReversalEventsService {
  private market!: MarketDataService
  private renkoCache = new Map<string, { computedTs: number; feed: RenkoReversalFeed | null }>()
  private kagiCache = new Map<string, { computedTs: number; feed: KagiReversalFeed | null }>()

  async start(ctx: KernelContext): Promise<void> {
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('reversalevents', 'Renko (Effort Bricks) / Kagi reversal boards online (30s..15m, whole universe, closed-candle fidelity)')
  }

  stop(): void {
    this.renkoCache.clear()
    this.kagiCache.clear()
  }

  private candles(asset: string, tf: string, limit: number): { candles: Candle[] | null; error: string } {
    if (!VALID_TF.has(tf)) return { candles: null, error: `unknown timeframe '${tf}'` }
    const candles = this.market.getCandlesDeep(asset, tf as Timeframe, limit, true)
    if (!candles || candles.length === 0) return { candles: null, error: 'not in the tracked universe' }
    return { candles, error: '' }
  }

  // ---- single pair ----------------------------------------------------

  renko(
    asset: string,
    tf: string = DEFAULT_TF,
    opts: FeedOpts & { source?: ReversalSource; atrMult?: number } = {},
  ): FeedResult<RenkoReversalFeed> {
    const c = this.candles(asset, tf, WINDOW)
    if (!c.candles) return { ok: false, error: c.error }
    return { ok: true, result: renkoReversalFeed(c.candles, opts) }
  }

  kagi(
    asset: string,
    tf: string = DEFAULT_TF,
    opts: FeedOpts & { reversalAtrMult?: number } = {},
  ): FeedResult<KagiReversalFeed> {
    const c = this.candles(asset, tf, WINDOW)
    if (!c.candles) return { ok: false, error: c.error }
    return { ok: true, result: kagiReversalFeed(c.candles, opts) }
  }

  // ---- whole-universe boards -------------------------------------------

  private scanSetup(opts: ScanOpts) {
    const fresh = Math.max(0, Math.min(MAX_FRESH_CANDLES, Math.round(opts.fresh ?? 1)))
    const requested = (opts.tfs && opts.tfs.length ? opts.tfs : BOARD_TFS).filter((t): t is Timeframe => BOARD_TFS.includes(t as Timeframe))
    const tfs = requested.length ? requested : BOARD_TFS
    const category = opts.category && opts.category !== 'all' ? opts.category : null
    const universe = this.market.listAssets().filter((a) => a.open && (!category || a.category === category))
    return { fresh, tfs, universe }
  }

  private trimCache(cache: Map<string, { computedTs: number }>): void {
    if (cache.size <= 2500) return
    const stale = [...cache.entries()].sort((a, b) => a[1].computedTs - b[1].computedTs).slice(0, 500)
    for (const [k] of stale) cache.delete(k)
  }

  globalRenko(opts: ScanOpts & { source?: ReversalSource } = {}): RenkoBoard {
    const source: ReversalSource = opts.source === 'renko' ? 'renko' : 'effort'
    const { fresh, tfs, universe } = this.scanSetup(opts)
    const now = Date.now()
    const rows: RenkoBoardRow[] = []
    let series = 0
    let noData = 0
    for (const a of universe) {
      for (const tf of tfs) {
        const key = `${a.ticker}:${tf}:${source}`
        let hit = this.renkoCache.get(key)
        if (opts.refresh || !hit || now - hit.computedTs >= SCAN_TTL_MS) {
          const c = this.candles(a.ticker, tf, SCAN_WINDOW)
          hit = { computedTs: now, feed: c.candles ? renkoReversalFeed(c.candles, { source, limit: 5 }) : null }
          this.renkoCache.set(key, hit)
        }
        if (!hit.feed) {
          noData++
          continue
        }
        series++
        const e = hit.feed.events[0]
        if (!e || e.candlesAgo > fresh) continue
        const group = e.confirmed === null ? 'all' : e.confirmed ? 'confirmed' : 'unconfirmed'
        rows.push({
          asset: a.ticker,
          tf,
          price: a.price ?? 0,
          computedTs: hit.computedTs,
          source,
          event: e,
          trend: hit.feed.trend,
          streak: hit.feed.streak,
          brickSize: hit.feed.brickSize,
          regime: hit.feed.regime,
          confirmedRatio: hit.feed.confirmedRatio,
          stat: hit.feed.followThrough.find((s) => s.group === group) ?? null,
        })
      }
    }
    this.trimCache(this.renkoCache)
    // newest first; then volume-confirmed, then proven follow-through, then the
    // stronger lower bound; stable alphabetical tail
    rows.sort(
      (x, y) =>
        x.event.candlesAgo - y.event.candlesAgo ||
        Number(y.event.confirmed === true) - Number(x.event.confirmed === true) ||
        Number(y.stat?.proven === true) - Number(x.stat?.proven === true) ||
        (y.stat?.lowerBound ?? 0) - (x.stat?.lowerBound ?? 0) ||
        x.asset.localeCompare(y.asset) ||
        BOARD_TFS.indexOf(x.tf) - BOARD_TFS.indexOf(y.tf),
    )
    return { scannedTs: now, universe: universe.length, series, noData, tfs, fresh, source, rows }
  }

  globalKagi(opts: ScanOpts = {}): KagiBoard {
    const { fresh, tfs, universe } = this.scanSetup(opts)
    const now = Date.now()
    const rows: KagiBoardRow[] = []
    let series = 0
    let noData = 0
    for (const a of universe) {
      for (const tf of tfs) {
        const key = `${a.ticker}:${tf}`
        let hit = this.kagiCache.get(key)
        if (opts.refresh || !hit || now - hit.computedTs >= SCAN_TTL_MS) {
          const c = this.candles(a.ticker, tf, SCAN_WINDOW)
          hit = { computedTs: now, feed: c.candles ? kagiReversalFeed(c.candles, { limit: 10 }) : null }
          this.kagiCache.set(key, hit)
        }
        if (!hit.feed) {
          noData++
          continue
        }
        series++
        const events = hit.feed.events.filter((e) => e.candlesAgo <= fresh)
        if (!events.length) continue
        const stats: Record<string, FollowThroughStat> = {}
        for (const e of events) {
          const s = hit.feed.followThrough.find((x) => x.group === e.type)
          if (s) stats[e.type] = s
        }
        rows.push({
          asset: a.ticker,
          tf,
          price: a.price ?? 0,
          computedTs: hit.computedTs,
          events,
          direction: hit.feed.direction,
          thick: hit.feed.thick,
          regime: hit.feed.regime,
          structure: hit.feed.structure,
          stats,
        })
      }
    }
    this.trimCache(this.kagiCache)
    // newest first; a yin/yang structural break outranks a bare reversal; then
    // any proven follow-through; stable alphabetical tail
    const strong = (r: KagiBoardRow) => r.events.some((e) => e.type !== 'reversal')
    const proven = (r: KagiBoardRow) => Object.values(r.stats).some((s) => s.proven)
    rows.sort(
      (x, y) =>
        x.events[0].candlesAgo - y.events[0].candlesAgo ||
        Number(strong(y)) - Number(strong(x)) ||
        Number(proven(y)) - Number(proven(x)) ||
        x.asset.localeCompare(y.asset) ||
        BOARD_TFS.indexOf(x.tf) - BOARD_TFS.indexOf(y.tf),
    )
    return { scannedTs: now, universe: universe.length, series, noData, tfs, fresh, rows }
  }
}

export const reversalEventsPlugin: Plugin = {
  name: 'reversalevents',
  start: async (ctx) => {
    const svc = new ReversalEventsService()
    ctx.provide('reversalevents', svc)
    await svc.start(ctx)
  },
}
