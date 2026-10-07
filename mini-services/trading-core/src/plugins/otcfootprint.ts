// IQAIR//OS - OTC Micro-Tick Velocity Footprint collector
// Owns the per-asset micro-tick buffers that everything tick-derived reads:
//
//   sim  - the kernel's own 1s engine emits `tick` bus events; the collector
//          records them (price-CHANGE only, same semantic as the live feed)
//          and lazily backfills from market-data's ring buffer at first read
//          so a fresh boot doesn't start the footprint from zero.
//   live - the iqair sidecar polls the broker's RAM candle table at 100ms
//          and records every price change with a wall-clock ms timestamp;
//          the collector pulls /tick_stats every LIVE_PULL_MS and merges the
//          new prints into a long-running buffer (the sidecar only keeps the
//          last ~1000, so frequent merging is what makes DEEP velocity
//          history possible at all).
//
// The buffer is registered as the analytics/otcfootprint.ts tick provider,
// so builtin strategies and the AI lab's otcv* indicator family all read the
// exact same data the /otc_footprint chart renders - measured-candidate IS
// the deployed math, everywhere.
//
// Invariants respected: read-only over the data chain (never touches candles,
// the archive, or settlement); buffers are pure memory, rebuilt naturally
// after restart; no fabrication - assets without tick coverage simply report
// empty / stand aside.

import type { KernelContext, Plugin } from '../kernel'
import type { MarketDataService } from './market-data'
import { buildFootprint, registerTickProvider, type FootprintResult, type TickPoint } from '../analytics/otcfootprint'

const OTF_MAX_TICKS = 60_000 // per asset (~16h at the sim engine's 1s cadence)
const LIVE_PULL_MS = 8_000 // sidecar /tick_stats merge cadence
const LIVE_PULL_MIN_MS = 5_000 // on-demand throttle (footprint() awaits a fresh pull)
const PULL_ASSETS_CAP = 6 // active + enabled-bot watchlist assets per sweep

export class OtcFootprintService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private buffers = new Map<string, TickPoint[]>()
  private backfilled = new Set<string>()
  private watermark = new Map<string, number>() // live-pull ts (ms) per asset
  private lastPull = new Map<string, number>()
  private pulling = new Set<string>()
  private unsub: (() => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastWarn = new Map<string, number>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    registerTickProvider((asset) => this.ticksFor(asset))
    // sim engine ticks (1s cadence, price may repeat) - record changes only
    this.unsub = ctx.bus.on('tick', ({ asset, price, ts }) => {
      this.record(asset, [{ ts: ts * 1000, price }])
    })
    // live sidecar capture merge
    this.timer = setInterval(() => void this.sweepLive(), LIVE_PULL_MS)
    ctx.log('otc-footprint', 'micro-tick velocity collector online (sim bus + sidecar 100ms capture)')
  }

  stop(): void {
    if (this.unsub) this.unsub()
    this.unsub = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Append ticks, capped, order-preserving. Consecutive same-price prints
   * carry no direction - drop them (the sidecar already dedupes; the sim bus
   * doesn't). */
  private record(asset: string, ticks: TickPoint[]): void {
    if (!ticks.length) return
    let buf = this.buffers.get(asset)
    if (!buf) {
      buf = []
      this.buffers.set(asset, buf)
    }
    const last = buf.length ? buf[buf.length - 1] : null
    for (const t of ticks) {
      if (!Number.isFinite(t.ts) || !Number.isFinite(t.price)) continue
      if (last && t.ts <= last.ts) continue // monotonic guard (double events, clock jitter)
      if (last && t.price === last.price) continue // no direction -> not a tick
      buf.push({ ts: t.ts, price: t.price })
    }
    if (buf.length > OTF_MAX_TICKS) buf.splice(0, buf.length - OTF_MAX_TICKS)
  }

  /** One-time lazy backfill from the sim engine's ring buffer (seconds -> ms)
   * so the collector inherits the kernel's already-accumulated tick history. */
  private backfill(asset: string): void {
    if (this.backfilled.has(asset)) return
    this.backfilled.add(asset)
    try {
      const raw = this.market.recentTicks(asset, OTF_MAX_TICKS)
      const now = Date.now()
      this.record(
        asset,
        raw.map((t) => ({ ts: t.ts * 1000, price: t.price })).filter((t) => t.ts <= now + 5_000),
      )
      this.watermark.set(asset, Math.max(this.watermark.get(asset) ?? 0, raw.length ? raw[raw.length - 1].ts * 1000 : 0))
    } catch {
      // sim buffer unavailable - footprint just starts from now
    }
  }

  /** Sync provider target (builtin strategies, lab otcv* series). */
  ticksFor(asset: string): TickPoint[] {
    this.backfill(asset)
    return this.buffers.get(asset) ?? []
  }

  /** Merge the sidecar's latest 100ms-captured prints for one asset. Ignores
   * the candle fallback (getTickSeries dataSource:'candle' would pollute a
   * TICK buffer with candle closes - exactly what this chart must not do). */
  private async pullLive(asset: string): Promise<void> {
    if (this.pulling.has(asset)) return
    this.pulling.add(asset)
    try {
      const { points, dataSource } = await this.market.getTickSeries(asset)
      if (dataSource !== 'tick' || !points.length) {
        this.warn(asset, 'sidecar tick buffer unavailable - velocity footprint waiting for 100ms captures')
        return
      }
      const wm = this.watermark.get(asset) ?? 0
      const fresh = points
        .map((p) => ({ ts: Math.round(p.time * 1000), price: p.price }))
        .filter((p) => p.ts > wm)
      if (fresh.length) {
        this.record(asset, fresh)
        this.watermark.set(asset, fresh[fresh.length - 1].ts)
      }
      this.lastPull.set(asset, Date.now())
    } catch (err) {
      this.warn(asset, `sidecar tick pull failed: ${(err as Error).message}`)
    } finally {
      this.pulling.delete(asset)
    }
  }

  private warn(asset: string, msg: string): void {
    const now = Date.now()
    if (now - (this.lastWarn.get(asset) ?? 0) < 10 * 60_000) return // once per 10 min per asset
    this.lastWarn.set(asset, now)
    this.ctx.log('otc-footprint', `${asset}: ${msg}`)
  }

  /** Periodic live sweep: active asset + every enabled bot's watchlist, so
   * bots trading OTC pairs accumulate velocity history even when nobody is
   * watching that chart. */
  private async sweepLive(): Promise<void> {
    if (this.market.mode !== 'live') return
    const assets = new Set<string>([this.market.activeAsset])
    try {
      const ap = this.ctx.use<{ listBots(): { bot: { enabled: boolean; watchlist: string[] } }[] }>('autopilot')
      for (const { bot } of ap.listBots()) {
        if (!bot.enabled) continue
        for (const a of bot.watchlist) assets.add(a)
      }
    } catch {
      // autopilot not loaded - active asset only
    }
    for (const asset of [...assets].slice(0, PULL_ASSETS_CAP)) {
      await this.pullLive(asset)
    }
  }

  /** The /otc_footprint read: live mode awaits one fresh sidecar merge (so a
   * chart opened after an idle stretch isn't stale), then builds. */
  async footprint(asset: string, opts: { minutes?: number; bucketSec?: number; fastMs?: number; minDelta?: number; ratioAt?: number; stagnationAt?: number } = {}): Promise<FootprintResult> {
    const a = String(asset ?? '').toUpperCase() || this.market.activeAsset
    if (this.market.mode === 'live') {
      const age = Date.now() - (this.lastPull.get(a) ?? 0)
      if (age > LIVE_PULL_MIN_MS) await this.pullLive(a)
    }
    const ticks = this.ticksFor(a)
    const live = this.market.mode === 'live'
    return buildFootprint(ticks, {
      ...opts,
      asset: a,
      dataSourceLabel: live ? 'sidecar-tick-100ms' : ticks.length ? 'sim-tick-1s' : 'no-ticks-yet',
    })
  }
}

let instance: OtcFootprintService | null = null

export const otcFootprintPlugin: Plugin = {
  name: 'otc-footprint',
  start: async (ctx) => {
    const svc = new OtcFootprintService()
    instance = svc
    ctx.provide('otcFootprint', svc)
    await svc.start(ctx)
  },
  stop: () => {
    instance?.stop()
    instance = null
  },
}
