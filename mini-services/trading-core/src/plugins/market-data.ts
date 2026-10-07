// IQAIR//OS - Market Data plugin
// SIM engine: regime-switching geometric brownian motion ticking 1/s per asset,
// with seeded per-timeframe candle history. All timeframes stay consistent with
// the live tick path because every candle is aggregated from the same ticks.
//
// LIVE bridge (iqair): polls the iqair sidecar for candles + prices and merges
// them into the same (asset, tf) series, so the rest of the OS is broker-agnostic.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { AssetInfo, Candle, MarketMode, Timeframe } from '../types'
import type { KernelContext } from '../kernel'
import { ALL_TIMEFRAMES, TIMEFRAME_SECONDS } from '../types'
import type { Plugin } from '../kernel'
import { gaussLike } from './random'
import { UNIVERSE, getInstrument, isInstrumentOpen, registerDynamicInstrument } from '../universe'
import type { Store } from '../store'

const HISTORY_CANDLES = 760
const MAX_TICKS = 40000
const MEM_CAP = 1500 // in-memory closed bars per asset|tf (unchanged memory profile)
// Task 59: max assets the live poll keeps warm per cycle (charted + watchlists).
// The sidecar serializes broker calls - more than this would stretch the 4s
// poll past the tick cadence. Excess watchlist pairs are skipped (logged hourly).
const MAX_LIVE_POLL_ASSETS = 8
const ARCHIVE_DEEP = 4000 // max bars hydrated/read from the sqlite archive per asset|tf
const ARCHIVE_CAP = 4000 // archive trim cap per asset|tf (auto-prune)
const ARCHIVE_FLUSH_MS = 5000 // batched write cadence
const ARCHIVE_PRUNE_FLUSHES = 60 // ~every 5 minutes
const GAP_FILL_MAX = 720 // max synthetic gap-fill bars per key on boot (12h of 1m)

/** Deterministic PRNG stream per ticker so the SIM universe tells the SAME story on every boot. */
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Regime {
  drift: number
  anchor: number
}

export class MarketDataService {
  private ctx!: KernelContext
  mode: MarketMode = 'sim'
  // Docker default (see docker-compose.yml) - overwritten by connectLive()'s
  // url argument as soon as the operator connects; this is just the value
  // before any connect ever happens.
  liveUrl = 'http://iqos-sidecar:47313'
  // Sandbox resets kill the sidecar daemon between sessions; the kernel is
  // environment-supervised and always comes back, so IT owns sidecar revival:
  // on a failed connect, spawn the sidecar once and retry (see ensureSidecar).
  private sidecarSpawnTs = 0
  private connectRetrying = false
  private static SIDECAR_CMD = ['/home/z/.venv/bin/python3', '/home/z/my-project/live/iqair_sidecar.py']
  assets: AssetInfo[] = UNIVERSE.map((a) => ({ ...a }))
  private prices = new Map<string, number>()
  private regimes = new Map<string, Regime>()
  private ticks = new Map<string, { ts: number; price: number; vol: number }[]>()
  // candle series per asset per tf (aggregated from ticks)
  private candles = new Map<string, Candle>() // key = asset|tf -> current forming candle
  private closed = new Map<string, Candle[]>() // key = asset|tf -> closed candles
  private seeded = new Set<string>() // assets whose history is materialized
  private timer: ReturnType<typeof setInterval> | null = null
  private liveTimer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  // live-poll cadence control: ticks (/price) every 4s, the heavy 240-bar
  // candle rebuild only every 60s - it shares the sidecar's single serialized
  // bus with batch price sweeps and used to make the 4s poll time out
  private lastCandlePull = 0
  private lastFeedBarTs = 0 // time of the newest real bar seen (feed freshness)
  private pollFailStreak = 0 // consecutive swallowed pollLive failures (Task 58 alert)
  // Task 59 multi-asset live poll state:
  private pollInFlight = false // re-entrancy guard (poll can outlive the 4s timer)
  private extraCandlePull = new Map<string, number>() // per-extra-asset 60s candle cadence
  private lastFeedBarByAsset = new Map<string, number>() // per-asset freshness anchor
  private archivedUpTo = new Map<string, number>() // incremental real-bar archive watermark
  private warnedPollCap = 0
  private lastCandleTs = new Map<string, number>()
  private store: Store | null = null
  private archiveQueue: { asset: string; tf: string; time: number; open: number; high: number; low: number; close: number; volume: number }[] = []
  private flushCount = 0
  activeAsset = 'EURUSD'
  // The sidecar's authenticated account decides which instruments exist on IQ
  // right now (incl. weekend OTC). Fetched from GET /assets on the sidecar.
  private sidecarRows: { ticker: string; category: string; open: boolean; payout: number | null }[] = []
  private sidecarAssets: Set<string> | null = null
  // REAL per-instrument payouts from the IQ account metadata (0-1 fractions;
  // binary + turbo groups report them, margin/digital groups do not).
  private sidecarPayouts: Map<string, { binary: number | null; turbo: number | null }> = new Map()
  private sidecarAssetsTs = 0
  private static SIDECAR_ASSETS_TTL = 10 * 60_000
  // Payout sample history per instrument (for the /iv_hv IV-proxy series):
  // {t, payout} appended on every metadata refresh that carries a payout,
  // deduped against the last sample so unchanged quotes do not create
  // stair-steps. In-memory by design - accrues live, resets on restart
  // (the /iv_hv response discloses ivSource honestly).
  private payoutHistory: Map<string, { t: number; payout: number }[]> = new Map()
  private static PAYOUT_HISTORY_CAP = 2000

  /** Refresh the IQ tradable-asset list from the sidecar (10 min TTL).
   * NOTE: the sidecar's get_asset_metadata round-trip against IQ is SLOW
   * (~95s for the full instrument table) - callers must not block on this;
   * kick it and serve the last cached rows (dedupe prevents stampedes when
   * /assets, /instruments and the source switch all fire at once). */
  private sidecarFetch: Promise<Set<string> | null> | null = null
  async ensureSidecarAssets(): Promise<Set<string> | null> {
    if (this.sidecarAssets && Date.now() - this.sidecarAssetsTs < MarketDataService.SIDECAR_ASSETS_TTL) return this.sidecarAssets
    if (this.sidecarFetch) return this.sidecarFetch
    this.sidecarFetch = this.fetchSidecarAssets().finally(() => {
      this.sidecarFetch = null
    })
    return this.sidecarFetch
  }

  /** Force the next ensureSidecarAssets() caller to hit the sidecar instead
   * of serving the (up to 10 min stale) cached rows - used right after a
   * live order comes back rejected as "asset not available", which means
   * our is_open cache is already wrong for that pair and the normal TTL
   * would otherwise let callers keep trusting it for several more minutes. */
  forceRefreshSidecarAssets(): void {
    this.sidecarAssetsTs = 0
    void this.ensureSidecarAssets()
  }

  private async fetchSidecarAssets(): Promise<Set<string> | null> {
    try {
      const res = await fetch(`${this.liveUrl.replace(/\/$/, '')}/assets`, { signal: AbortSignal.timeout(150_000) })
      const data = (await res.json()) as { ok?: boolean; assets?: { ticker?: string; asset?: string; category?: string; is_open?: boolean; payout?: number | null }[] }
      const rows = data?.assets ?? []
      // IQ returns the SAME ticker under several groups (binary/digital/
      // turbo/cfd/forex/crypto). Dedupe by ticker; resolve the category by
      // priority (explicit asset class beats option-type group) and open =
      // open in ANY group. Payouts: the turbo/binary groups carry the real
      // commission-derived payout - binary wins the primary field, turbo is
      // kept per kind (null everywhere => payout genuinely unknown).
      const PRIORITY: Record<string, number> = { crypto: 4, forex: 3, cfd: 2 }
      const byTicker = new Map<string, { ticker: string; category: string; open: boolean; score: number; binary: number | null; turbo: number | null }>()
      for (const r of rows) {
        const t = r.ticker ?? r.asset
        if (!t) continue
        const rawCat = String(r.category ?? '').toLowerCase()
        const score = PRIORITY[rawCat] ?? 1
        const open = Boolean(r.is_open)
        const pay = typeof r.payout === 'number' && Number.isFinite(r.payout) && r.payout > 0 && r.payout <= 1 ? r.payout : null
        const prev = byTicker.get(t)
        if (!prev) byTicker.set(t, { ticker: t, category: rawCat, open, score, binary: rawCat === 'binary' ? pay : null, turbo: rawCat === 'turbo' ? pay : null })
        else {
          if (score > prev.score) prev.category = rawCat
          prev.open = prev.open || open
          prev.score = Math.max(prev.score, score)
          if (rawCat === 'binary' && pay !== null) prev.binary = prev.binary === null ? pay : Math.max(prev.binary, pay)
          if (rawCat === 'turbo' && pay !== null) prev.turbo = prev.turbo === null ? pay : Math.max(prev.turbo, pay)
        }
      }
      const out = [...byTicker.values()].map((r) => ({ ticker: r.ticker, category: r.category, open: r.open, payout: r.binary ?? r.turbo, turbo: r.turbo }))
      if (out.length) {
        this.sidecarRows = out.map((r) => ({ ticker: r.ticker, category: r.category, open: r.open, payout: r.payout }))
        this.sidecarAssets = new Set(out.map((r) => r.ticker))
        this.sidecarPayouts = new Map(out.map((r) => [r.ticker, { binary: r.payout, turbo: r.turbo ?? r.payout }]))
        // Task 63: sample the payout curve for the IV-proxy series (dedup:
        // only when the quote actually moved since the last sample)
        const nowSec = Date.now() / 1000
        for (const r of out) {
          if (r.payout === null || !Number.isFinite(r.payout) || r.payout <= 0) continue
          const hist = this.payoutHistory.get(r.ticker) ?? []
          const last = hist[hist.length - 1]
          if (last && Math.abs(last.payout - r.payout) < 1e-9) continue
          hist.push({ t: nowSec, payout: r.payout })
          if (hist.length > MarketDataService.PAYOUT_HISTORY_CAP) hist.splice(0, hist.length - MarketDataService.PAYOUT_HISTORY_CAP)
          this.payoutHistory.set(r.ticker, hist)
        }
        this.sidecarAssetsTs = Date.now()
        const withPay = out.filter((r) => r.payout !== null).length
        this.ctx.log('market-data', `IQ asset universe refreshed: ${out.length} instruments (${out.filter((r) => r.open).length} open, ${out.filter((r) => r.ticker.endsWith('-OTC')).length} OTC, ${withPay} with real payouts)`)
        this.syncDynamicInstruments(out)
      }
    } catch {
      // sidecar dark / not connected / still crunching - keep the previous set
    }
    return this.sidecarAssets
  }

  /** Catalog any IQ-account instrument we've never seen before, so the user
   * never has to hand-add a pair to universe.ts just because it's tradable
   * on IQ but wasn't part of our curated 115-row starter list (this is how
   * SNAP/SNAP-OTC got added manually before this existed). New rows get
   * schedule 'live' - their open/closed state is trusted straight from IQ's
   * own is_open flag (kept fresh every refresh cycle) rather than guessed at
   * with a time-of-day heuristic. Defaults for fields IQ's metadata doesn't
   * carry (pip size, sim volatility, leverage) are conservative placeholders
   * good enough for trading/backtesting; they don't affect real order sizing,
   * which always goes through the sidecar's own price/expiry quotes. */
  private syncDynamicInstruments(
    rows: { ticker: string; category: string; open: boolean; payout: number | null; turbo: number | null }[]
  ): void {
    let added = 0
    for (const r of rows) {
      if (getInstrument(r.ticker)) continue // already curated or already auto-added
      const otc = r.ticker.endsWith('-OTC')
      const category = this.mapIQCategory(r.category, r.ticker)
      const base = r.ticker.replace(/-OTC$/, '').replace(/_/g, ' ')
      const info: AssetInfo = {
        ticker: r.ticker,
        name: base + (otc ? ' OTC' : ''),
        category,
        otc,
        basePrice: this.prices.get(r.ticker) ?? 1,
        pip: category === 'forex' ? 5 : category === 'crypto' ? 2 : 2,
        volatility: category === 'crypto' ? 0.0006 : category === 'forex' ? 0.00005 : 0.0002,
        payout: r.payout ?? 0.8,
        turboPayout: r.turbo ?? undefined,
        digitalPayout: undefined,
        leverage: category === 'forex' ? 30 : 10,
        schedule: 'live',
        open: r.open,
        iqairName: r.ticker,
      }
      if (registerDynamicInstrument(info)) {
        this.assets.push(info)
        this.prices.set(info.ticker, info.basePrice)
        this.regimes.set(info.ticker, { drift: (Math.random() - 0.5) * 2e-5, anchor: info.basePrice })
        this.ticks.set(info.ticker, [])
        added++
      }
    }
    if (added) this.ctx.log('market-data', `auto-discovered ${added} new IQ instrument(s) not in the curated catalog - added live`)
  }

  /** Does this ticker exist on the connected IQ account at all? (membership,
   * not schedule - a closed-but-existing pair is still an IQ asset.) */
  isIQAsset(ticker: string): boolean {
    return this.sidecarAssets?.has(ticker) ?? false
  }

  /** How many IQ instruments are known right now (0 = metadata not loaded yet). */
  get iqAssetCount(): number {
    return this.sidecarAssets?.size ?? 0
  }

  /** Sidecar category strings + ticker shape -> kernel AssetCategory.
   * IQ groups option AVAILABILITY (binary/digital/turbo) alongside asset
   * classes (forex/crypto/cfd) - the option groups carry no class info, so
   * the ticker shape decides: 6-letter bases are currency pairs, the rest
   * are single-name instruments (stocks, some funds). */
  private mapIQCategory(cat: string, ticker: string): 'forex' | 'crypto' | 'commodity' | 'stock' | 'index' {
    const base = ticker.replace(/-OTC$/, '').toUpperCase()
    const c = cat.toLowerCase()
    if (c === 'crypto') return 'crypto'
    if (c === 'forex') return 'forex'
    if (c === 'cfd') {
      if (/^(XAU|XAG|XPT|XPD|OIL|BRENT|WTI|NGAS|COPPER|SILVER)/.test(base)) return 'commodity'
      if (/SP500|NSDQ|US30|US100|DAX|FTSE|NIKKEI|HSI|ESTX|CAC|IBEX|MIB|ASX|SMI|AEX/.test(base)) return 'index'
      if (/^[A-Z]{6}$/.test(base)) return 'forex'
      return 'stock'
    }
    // binary / digital / turbo (and anything unknown)
    if (/^[A-Z]{6}$/.test(base)) return 'forex'
    return 'stock'
  }

  /**
   * THE IQ account's own asset list, built from the authenticated session's
   * metadata - this is the ONLY universe served in IQ mode; the 115-pair sim
   * universe never leaks into it. Prices are known only for polled assets
   * (the active one) - rows without a tick carry price 0 and the UI shows a
   * dash until the pair is opened.
   */
  iqAssetRows(): { ticker: string; name: string; category: 'forex' | 'crypto' | 'commodity' | 'stock' | 'index'; otc: boolean; price: number; payout: number | null; turboPayout?: number | null; schedule: '24/7' | undefined; open: boolean; iq: boolean }[] {
    return this.sidecarRows.map((r) => {
      const otc = r.ticker.endsWith('-OTC')
      const pay = this.sidecarPayouts.get(r.ticker)
      return {
        ticker: r.ticker,
        name: r.ticker.replace(/-OTC$/, '').replace(/_/g, ' ') + (otc ? ' OTC' : ''),
        category: this.mapIQCategory(r.category, r.ticker),
        otc,
        price: this.prices.get(r.ticker) ?? 0,
        // the account's REAL payout - null when IQ doesn't report one for
        // this instrument (margin CFDs/stocks have no fixed payout)
        payout: pay?.binary ?? null,
        turboPayout: pay?.turbo ?? null,
        schedule: otc ? ('24/7' as const) : undefined,
        open: r.open,
        iq: true,
      }
    })
  }

  /** Can this instrument be traded on the connected IQ account right now? */
  isIQAvailable(ticker: string): boolean {
    if (!this.sidecarAssets || this.sidecarAssets.size === 0) return true // unknown -> don't hide anything
    const a = this.assets.find((x) => x.ticker === ticker)
    const sym = a?.iqairName ?? ticker
    return this.sidecarAssets.has(sym) || this.sidecarAssets.has(ticker)
  }

  /**
   * Can this ticker actually be traded as an OPTION (binary/turbo) on the
   * connected IQ account? IQ lists every instrument in its metadata, but only
   * some carry a binary/turbo payout - margin CFDs (stocks, indices, many
   * commodities) exist purely as CFDs, and an option order on them is always
   * rejected with "is not a turbo/binary/digital instrument". The honest
   * signal is the account's own payout map: binary/turbo payout reported =
   * options-capable, null = CFD-only. Permissive while the metadata hasn't
   * loaded yet (or in sim mode, where every universe instrument is
   * options-capable by construction) - same "unknown -> don't hide anything"
   * contract as isIQAvailable above, so a cold kernel never blind-drops
   * candidates; the reactive broker-rejection path remains the backstop.
   */
  isOptionInstrument(ticker: string): boolean {
    if (!this.sidecarPayouts || this.sidecarPayouts.size === 0) return true // sim mode / metadata not loaded yet
    const a = this.assets.find((x) => x.ticker === ticker)
    const sym = a?.iqairName ?? ticker
    const pay = this.sidecarPayouts.get(sym) ?? this.sidecarPayouts.get(ticker)
    // Not on the account at all, or on it with no binary/turbo payout (CFD-only)
    return !!pay && pay.binary !== null
  }

  /** Kick an immediate live poll for the active asset (used after /asset switch). */
  refreshActiveLive(): void {
    // force a candle rebuild for the NEW asset and hold ticks until it lands
    // (lastFeedBarTs=0) - never seed the new chart from the old asset's state
    this.lastCandlePull = 0
    this.lastFeedBarTs = 0
    if (this.mode === 'live') void this.pollLive()
  }

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    try {
      this.store = ctx.use<Store>('storeRaw')
    } catch {
      // store not available - archive disabled, pure in-memory mode
    }
    for (const a of this.assets) {
      this.prices.set(a.ticker, a.basePrice)
      this.regimes.set(a.ticker, { drift: (Math.random() - 0.5) * 2e-5, anchor: a.basePrice })
      const zero: { ts: number; price: number; vol: number }[] = []
      this.ticks.set(a.ticker, zero)
    }
    // lazy seed: only the default active asset boots with full history;
    // every other asset seeds on first access (memory-friendly with 100+ instruments)
    this.ensureSeeded(this.activeAsset)
    this.timer = setInterval(() => this.tickAll(), 1000)
    if (this.store) {
      this.flushTimer = setInterval(() => this.flushArchive(), ARCHIVE_FLUSH_MS)
      ctx.log('market-data', 'candle archive attached - closed bars persist across restarts')
    }
    ctx.log('market-data', `universe online: ${this.assets.length} instruments, ${ALL_TIMEFRAMES.length} timeframes (lazy seeding)`)
    // NOTE: no boot-time session adoption here. The account source (paper vs
    // IQ) is the single routing truth and lives in the execution plugin - the
    // feed only goes live when the operator switches to IQ (or the boot
    // restore finds a persisted IQ source). Otherwise the sim feed would be
    // hijacked by a warm sidecar session the moment the kernel respawns.
  }

  /**
   * Adopt an already-connected iqair sidecar session: no credentials needed,
   * the sidecar holds the authenticated websocket. Returns true when LIVE
   * polling resumed. Safe to call at any time (boot, reconnect, watchdog).
   */
  async adoptSidecarSession(url = this.liveUrl): Promise<boolean> {
    if (this.mode === 'live') return true
    const base = url.replace(/\/$/, '')
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
      const data = (await res.json()) as { ok?: boolean; connected?: boolean }
      if (!data?.connected) return false
      this.liveUrl = url
      this.mode = 'live'
      this.lastCandlePull = 0
      this.lastFeedBarTs = 0
      if (this.liveTimer) clearInterval(this.liveTimer)
      this.liveTimer = setInterval(() => void this.pollLive(), 4000)
      void this.pollLive()
      void this.ensureSidecarAssets()
      this.ctx.log('market-data', `LIVE resumed - adopted connected iqair sidecar @ ${base}`)
      return true
    } catch {
      return false
    }
  }

  /** Materialize history for an instrument on first use: prehistory + archive + gap-fill. */
  ensureSeeded(ticker: string): void {
    if (this.seeded.has(ticker)) return
    const a = this.assets.find((x) => x.ticker === ticker)
    if (!a) return
    this.seeded.add(ticker)
    for (const tf of ALL_TIMEFRAMES) {
      const k = this.key(ticker, tf)
      let series: Candle[] = []
      try {
        if (this.store) series = this.buildSeries(a, tf)
      } catch {
        series = []
      }
      if (!series.length) {
        const nowBucket = this.bucketNow(TIMEFRAME_SECONDS[tf])
        series = this.synthPrehistory(a, tf, HISTORY_CANDLES, nowBucket, a.basePrice, mulberry32(hashSeed(`${a.ticker}|${tf}|seed`)))
      }
      this.closed.set(k, series.slice(-MEM_CAP))
    }
  }

  private bucketNow(tfSec: number): number {
    const now = Math.floor(Date.now() / 1000)
    return now - (now % tfSec)
  }

  /**
   * Layered series: [deterministic prehistory][archived bars][deterministic gap-fill].
   * The archive is the real accumulated story; the synthetic parts are pure
   * functions of (ticker, tf, timestamps) so restarts never rewrite history.
   */
  private buildSeries(a: AssetInfo, tf: Timeframe): Candle[] {
    if (!this.store) return []
    const tfSec = TIMEFRAME_SECONDS[tf]
    const arch = this.store.getCandlesArchive(a.ticker, tf, ARCHIVE_DEEP)
    if (!arch.length) return []
    const series: Candle[] = [...arch]
    // bridge downtime with a deterministic forward walk (continuity up to now)
    const nowBucket = this.bucketNow(tfSec)
    const last = series[series.length - 1]
    const gap = Math.floor((nowBucket - last.time) / tfSec) - 1
    if (gap > 0) {
      const count = Math.min(gap, GAP_FILL_MAX)
      series.push(...this.synthForward(a, tf, count, last.time + tfSec, last.close, mulberry32(hashSeed(`${a.ticker}|${tf}|gap`))))
    }
    // top up with deterministic prehistory so the seeded window stays >= HISTORY_CANDLES
    if (series.length < HISTORY_CANDLES) {
      const need = HISTORY_CANDLES - series.length
      const pre = this.synthPrehistory(a, tf, need, series[0].time, series[0].open, mulberry32(hashSeed(`${a.ticker}|${tf}|pre`)))
      series.unshift(...pre)
    }
    return series
  }

  /** Walk forward from (startTs, startPrice) - used for deterministic gap-fill. */
  private synthForward(asset: AssetInfo, tf: Timeframe, count: number, startTs: number, startPrice: number, rng: () => number): Candle[] {
    const tfSec = TIMEFRAME_SECONDS[tf]
    const sigma = asset.volatility * Math.sqrt(tfSec) * (tf === '5s' ? 1.15 : tf === '15s' ? 1.1 : 1)
    const out: Candle[] = []
    let price = startPrice
    let drift = 0
    for (let i = 0; i < count; i++) {
      if (rng() < 0.015) drift = (rng() - 0.5) * sigma * 0.9
      const open = price
      const ret = drift + (sigma * (rng() + rng() + rng() + rng() - 2)) * 0.87
      const close = open * Math.exp(ret)
      const wick = Math.abs(ret) * 1.8 + sigma * 0.6
      const high = Math.max(open, close) * (1 + wick * rng() * 0.55)
      const low = Math.min(open, close) * (1 - wick * rng() * 0.55)
      const volume = Math.round(500 + rng() * 2500 * (1 + Math.abs(ret) / sigma))
      out.push({ time: startTs + i * tfSec, open, high, low, close, volume })
      price = close
    }
    return out
  }

  refreshSchedules(): void {
    const now = new Date()
    for (const a of this.assets) {
      // 'live' (auto-discovered) instruments carry their open state straight
      // from the sidecar's own is_open field (set/kept fresh in
      // fetchSidecarAssets) - recomputing it here would just be a worse
      // heuristic guess at the same fact IQ already told us.
      if (a.schedule === 'live') continue
      a.open = isInstrumentOpen(a, now)
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.liveTimer) clearInterval(this.liveTimer)
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushArchive() // final write-back
  }

  /** Write-behind: flush queued closed candles to the sqlite archive (batched). */
  private flushArchive(): void {
    if (!this.store || !this.archiveQueue.length) return
    const batch = this.archiveQueue.splice(0, this.archiveQueue.length)
    try {
      this.store.saveCandles(batch)
    } catch {
      // archive write failure must never break the feed
    }
    this.flushCount += 1
    if (this.flushCount % ARCHIVE_PRUNE_FLUSHES === 0) {
      try {
        this.store.pruneArchive(ARCHIVE_CAP)
      } catch {
        // pruning is best-effort
      }
    }
  }

  private key(asset: string, tf: Timeframe) {
    return `${asset}|${tf}`
  }

  /**
   * `count` bars ENDING right before endTs, rescaled to end at endPrice.
   * Deterministic via the caller's rng stream - the same (ticker, tf) always
   * tells the same story, so research results are reproducible across restarts.
   */
  private synthPrehistory(asset: AssetInfo, tf: Timeframe, count: number, endTs: number, endPrice: number, rng: () => number): Candle[] {
    const tfSec = TIMEFRAME_SECONDS[tf]
    const sigma = asset.volatility * Math.sqrt(tfSec) * (tf === '5s' ? 1.15 : tf === '15s' ? 1.1 : 1)
    const out: Candle[] = []
    const t0 = endTs - count * tfSec
    let price = asset.basePrice * (1 - asset.volatility * Math.sqrt(tfSec) * 6)
    // walk forward with occasional regime shifts so the data has trend + range phases
    let drift = 0
    for (let i = 0; i < count; i++) {
      if (rng() < 0.015) drift = (rng() - 0.5) * sigma * 0.9
      const open = price
      const ret = drift + (sigma * (rng() + rng() + rng() + rng() - 2)) * 0.87
      const close = open * Math.exp(ret)
      const wick = Math.abs(ret) * 1.8 + sigma * 0.6
      const high = Math.max(open, close) * (1 + wick * rng() * 0.55)
      const low = Math.min(open, close) * (1 - wick * rng() * 0.55)
      const volume = Math.round(500 + rng() * 2500 * (1 + Math.abs(ret) / sigma))
      out.push({ time: t0 + i * tfSec, open, high, low, close, volume })
      price = close
    }
    // rescale so the series ends exactly at endPrice
    const scale = endPrice / out[out.length - 1].close
    return out.map((c) => ({
      ...c,
      open: c.open * scale,
      high: c.high * scale,
      low: c.low * scale,
      close: c.close * scale,
    }))
  }

  private tickAll(): void {
    const now = Math.floor(Date.now() / 1000)
    this.refreshSchedules()
    for (const a of this.assets) {
      if (this.mode !== 'sim') break
      const r = this.regimes.get(a.ticker)!
      // occasionally switch regime; mean-revert toward anchor in range mode
      if (Math.random() < 0.004) {
        const roll = Math.random()
        r.drift = roll < 0.38 ? a.volatility * (0.2 + Math.random() * 0.5) : roll < 0.76 ? -a.volatility * (0.2 + Math.random() * 0.5) : 0
      }
      const price = this.prices.get(a.ticker)!
      const pull = r.drift === 0 ? (r.anchor - price) / r.anchor * a.volatility * 0.5 : 0
      const ret = r.drift + pull + gaussLike() * a.volatility
      const next = Math.max(price * Math.exp(ret), a.basePrice * 0.5)
      this.prices.set(a.ticker, next)
      // only form candles for materialized assets (UI/strategy touched them)
      if (!this.seeded.has(a.ticker)) continue
      const tickArr = this.ticks.get(a.ticker)!
      tickArr.push({ ts: now, price: next, vol: Math.round(50 + Math.random() * 300) })
      if (tickArr.length > MAX_TICKS) tickArr.splice(0, tickArr.length - MAX_TICKS)
      this.ctx.bus.emit('tick', { asset: a.ticker, price: next, ts: now })
      for (const tf of ALL_TIMEFRAMES) this.applyTick(a.ticker, tf, tickArr[tickArr.length - 1])
    }
  }

  private applyTick(asset: string, tf: Timeframe, tick: { ts: number; price: number; vol: number }): void {
    const tfSec = TIMEFRAME_SECONDS[tf]
    const bucket = tick.ts - (tick.ts % tfSec)
    const k = this.key(asset, tf)
    const current = this.candles.get(k)
    if (!current || current.time !== bucket) {
      if (current) {
        const arr = this.closed.get(k)!
        // regression guard: never file a candle OLDER than the newest closed
        // bar (can happen when sim state and live poll momentarily disagree)
        const lastClosed = arr[arr.length - 1]
        if (!lastClosed || lastClosed.time < current.time) {
          arr.push(current)
          if (arr.length > MEM_CAP) arr.splice(0, arr.length - MEM_CAP)
        }
        this.archiveQueue.push({ asset, tf, time: current.time, open: current.open, high: current.high, low: current.low, close: current.close, volume: current.volume })
        this.ctx.bus.emit('candle', { asset, tf, candle: current, closed: true })
      }
      const fresh: Candle = { time: bucket, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: tick.vol }
      this.candles.set(k, fresh)
      this.ctx.bus.emit('candle', { asset, tf, candle: fresh, closed: false })
    } else {
      current.high = Math.max(current.high, tick.price)
      current.low = Math.min(current.low, tick.price)
      current.close = tick.price
      current.volume += tick.vol
      this.ctx.bus.emit('candle', { asset, tf, candle: current, closed: false })
    }
    this.lastCandleTs.set(k, bucket)
  }

  // ---------- LIVE bridge (iqair sidecar) ----------

  /**
   * Ensure the iqair sidecar is answering on `url`. Returns true when /health
   * responds. If the sidecar is dark and we have not just tried, spawn it
   * detached (survives kernel restarts; orphaned to init) and give it a
   * grace period before re-checking.
   */
  private async ensureSidecar(url: string): Promise<boolean> {
    const base = url.replace(/\/$/, '')
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch { /* dark */ }
    if (Date.now() - this.sidecarSpawnTs < 30_000) return false
    this.sidecarSpawnTs = Date.now()
    const [bin, script] = MarketDataService.SIDECAR_CMD
    try {
      if (!existsSync(script)) {
        this.ctx.log('market-data', `sidecar script missing: ${script}`)
        return false
      }
      const child = spawn(bin, [script], { cwd: '/home/z/my-project/live', detached: true, stdio: 'ignore' })
      child.unref()
      this.ctx.log('market-data', 'sidecar dark - spawned live/iqair_sidecar.py')
    } catch (err) {
      this.ctx.log('market-data', `sidecar spawn failed: ${(err as Error).message}`)
      return false
    }
    await new Promise((r) => setTimeout(r, 1200))
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
      return res.ok
    } catch {
      return false
    }
  }

  async connectLive(url: string, email: string, password: string, balanceMode: string): Promise<{ ok: boolean; error?: string }> {
    // AUDIT FIX (Task 58, P1): empty credentials + an already-authenticated
    // sidecar used to call adoptSidecarSession() HERE - which flipped the
    // data feed LIVE while the account source stayed 'paper'. The paper
    // settle gate (`mode !== 'sim'` skip) then never settled due paper
    // options: they piled up and settled later at a much-later price. That
    // violated this file's own invariant (see the comment below: the feed
    // goes live EXCLUSIVELY through adoptSidecarSession() when the account
    // source switch demands it). An empty-credential connect now only
    // VERIFIES the sidecar session (health read, no state touched) so the
    // user isn't forced to re-type secrets; the feed switch stays exactly
    // where the invariant says it lives.
    if (!email.trim() && !password.trim()) {
      const base = url.replace(/\/$/, '')
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
        const data = (await res.json()) as { ok?: boolean; connected?: boolean }
        if (data?.connected) {
          this.liveUrl = url // remember the endpoint for the later source-switch adopt
          return { ok: true }
        }
        return { ok: false, error: 'sidecar has no authenticated IQ session - enter your credentials to log in' }
      } catch {
        return { ok: false, error: 'sidecar unreachable - cannot verify session' }
      }
    }
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // /connect = login + balance-mode change_balance() on the sidecar -
        // a chain of slow websocket round-trips (can legitimately take ~40s).
        // Without a signal here a hung sidecar pinned the kernel request.
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({ email, password, balance_mode: balanceMode }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) return { ok: false, error: data.error ?? 'sidecar rejected connection' }
      this.liveUrl = url
      // NOTE: authentication only - the data feed is NOT switched here.
      // Logging in credentials must never hijack a running paper session;
      // the feed goes live exclusively through adoptSidecarSession() when
      // the account source switch (execution plugin) demands it.
      void this.ensureSidecarAssets()
      this.ctx.log('market-data', `iqair session authenticated @ ${url} (feed unchanged - governed by account source)`)
      return { ok: true }
    } catch (err) {
      // Sidecar dark (sandbox reset / fresh boot)? Spawn it and retry once.
      if (!this.connectRetrying && (await this.ensureSidecar(url))) {
        this.connectRetrying = true
        try {
          return await this.connectLive(url, email, password, balanceMode)
        } finally {
          this.connectRetrying = false
        }
      }
      return { ok: false, error: `sidecar unreachable at ${url}: ${(err as Error).message}` }
    }
  }

  disconnectLive(): void {
    this.mode = 'sim'
    if (this.liveTimer) clearInterval(this.liveTimer)
    this.liveTimer = null
    this.ctx.bus.emit('alert', { level: 'info', message: 'Switched back to SIM engine', ts: Math.floor(Date.now() / 1000) })
  }

  private async pollLive(): Promise<void> {
    // Task 59: one poll in flight at a time - the multi-asset loop below can
    // outlive the 4s timer when the sidecar is slow; overlapping polls would
    // double-fetch and race the candle merge.
    if (this.pollInFlight) return
    this.pollInFlight = true
    try {
      const url = `${this.liveUrl.replace(/\/$/, '')}`
      // Ticks (/price) every 4s; the 240-bar history rebuild every 60s — but
      // every 8s until the FIRST freshness anchor lands (right after connect
      // or asset switch) so ticks start as soon as possible instead of after
      // a whole minute. Pulling both every 4s used to queue the poll behind
      // batch price sweeps on the sidecar's serialized bus -> "live feed
      // hiccup: timed out".
      const candleEvery = this.lastFeedBarTs === 0 ? 8_000 : 60_000
      const wantCandles = Date.now() - this.lastCandlePull > candleEvery
      if (wantCandles) this.lastCandlePull = Date.now()
      // Task 59 (P1-residual): pollLive used to feed ONLY the charted asset -
      // bots / the auto-trader on any other pair got ZERO candle events, never
      // evaluated, and could not even produce a rejection (silent death).
      // Poll the traded set instead: charted asset + enabled bot watchlists +
      // the auto-trader watchlist, capped to bound sidecar load.
      const assets = this.livePollAssets()
      for (const asset of assets) {
        const extraWantCandles = Date.now() - (this.extraCandlePull.get(asset) ?? 0) > 60_000
        await this.pollLiveAsset(url, asset, asset === this.activeAsset ? wantCandles : extraWantCandles)
      }
    } catch (err) {
      this.ctx.bus.emit('alert', { level: 'warn', message: `live feed hiccup: ${(err as Error).message}`, ts: Math.floor(Date.now() / 1000) })
    } finally {
      this.pollInFlight = false
    }
  }

  /**
   * Assets the live feed must keep warm: the charted asset first, then every
   * enabled bot's watchlist, then the auto-trader watchlist. Capped at
   * MAX_LIVE_POLL_ASSETS - the sidecar serializes broker calls, and an
   * unbounded set would stretch each 4s poll past the tick cadence.
   */
  private livePollAssets(): string[] {
    const out: string[] = []
    const push = (a: unknown) => {
      const t = String(a ?? '').trim().toUpperCase()
      if (t && !out.includes(t)) out.push(t)
    }
    push(this.activeAsset)
    try {
      for (const b of this.store?.listBots() ?? []) {
        if (!b?.bot?.enabled) continue
        for (const a of b.bot.watchlist ?? []) push(a)
      }
    } catch {
      /* store unavailable - the charted asset is still polled */
    }
    try {
      const mode = this.ctx.use<{ config?: { watchlist?: string[] } }>('mode')
      for (const a of mode?.config?.watchlist ?? []) push(a)
    } catch {
      /* mode plugin absent */
    }
    if (out.length > MAX_LIVE_POLL_ASSETS && Date.now() - this.warnedPollCap > 3_600_000) {
      this.warnedPollCap = Date.now()
      this.ctx.log('market-data', `live poll capped at ${MAX_LIVE_POLL_ASSETS} assets - ${out.length - MAX_LIVE_POLL_ASSETS} watchlist pair(s) beyond the cap get no live candles`)
    }
    return out.slice(0, MAX_LIVE_POLL_ASSETS)
  }

  private async pollLiveAsset(url: string, asset: string, wantCandles: boolean): Promise<void> {
    try {
      if (wantCandles) this.extraCandlePull.set(asset, Date.now())
      // fire both fetches in parallel, but CONSUME the price first so the
      // tick lands even while the candle pull is still streaming
      const candleJson = (wantCandles
        ? fetch(`${url}/candles?asset=${asset}&size=240&tf=60`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json())
        : Promise.resolve(null)
      ).catch(() => null) as Promise<{ ok: boolean; candles?: Candle[] } | null>
      const priceData = (await (
        fetch(`${url}/price?asset=${asset}`, { signal: AbortSignal.timeout(12_000) })
          .then((r) => r.json())
          .catch(() => null)
      )) as { ok: boolean; price?: number } | null
      // AUDIT FIX (Task 58, P2): both fetches swallowed EVERY error via
      // `.catch(() => null)` - a dead/busy sidecar silently froze ticks and
      // candles (the freshness gate then stopped all applyTick, starving the
      // live CFD margin monitor) and the "live feed hiccup" alert below
      // never fired because the outer catch only sees non-fetch errors.
      // Consecutive null polls now surface a throttled alert.
      if (!priceData) {
        this.pollFailStreak++
        if (this.pollFailStreak === 3 || (this.pollFailStreak > 0 && this.pollFailStreak % 30 === 0)) {
          this.ctx.bus.emit('alert', {
            level: 'warn',
            message: `live feed failing: ${this.pollFailStreak} consecutive sidecar polls returned nothing - ticks/candles frozen, TP/SL monitoring starved (sidecar @ ${url})`,
            ts: Math.floor(Date.now() / 1000),
          })
        }
      } else {
        this.pollFailStreak = 0
      }
      if (priceData?.ok && priceData.price) {
        const now = Math.floor(Date.now() / 1000)
        this.prices.set(asset, priceData.price)
        // Market closed (weekend / session gap)? The sidecar's last REAL bar
        // may be hours old - ticking then would fabricate fake candles at
        // Friday's price. Freshness is judged from the newest bar seen in the
        // 60s candle pulls (any open market forms a bar newer than ~2min;
        // a closed market stays stale between pulls, so no phantom ticks).
        // Task 59: per-asset freshness - a watchlist pair whose market is dark
        // must not tick just because the charted pair's market is open.
        const fresh = await candleJson
        const lastC = fresh?.candles?.[fresh.candles.length - 1]
        if (lastC?.time) {
          this.lastFeedBarByAsset.set(asset, Math.max(this.lastFeedBarByAsset.get(asset) ?? 0, lastC.time))
          if (asset === this.activeAsset) this.lastFeedBarTs = Math.max(this.lastFeedBarTs, lastC.time)
        }
        const feedTs = asset === this.activeAsset ? this.lastFeedBarTs : (this.lastFeedBarByAsset.get(asset) ?? 0)
        if (feedTs > 0 && now - feedTs <= 150) {
          for (const tf of ALL_TIMEFRAMES) this.applyTick(asset, tf, { ts: now, price: priceData.price, vol: 0 })
        }
      } else {
        void (await candleJson) // drain the in-flight candle fetch
      }
      const candleData = wantCandles ? await candleJson : null
      if (candleData?.ok && candleData.candles?.length) {
        for (const tf of ALL_TIMEFRAMES) {
          const agg = this.aggregate(candleData.candles, TIMEFRAME_SECONDS[tf])
          if (agg.length > 10) {
            // MERGE, not clobber: the sidecar only serves a short tail (~240
            // 1m bars, even unauthenticated). Replacing wholesale used to
            // throw away the seeded prehistory + archived depth for the
            // active asset every 60s, starving the research lab / backtests
            // of history. Fresh bars win a timestamp collision, older memory
            // survives, capped at the usual MEM_CAP.
            const k = this.key(asset, tf)
            const byTime = new Map<number, Candle>()
            for (const c of this.closed.get(k) ?? []) byTime.set(c.time, c)
            for (const c of agg) byTime.set(c.time, c)
            const merged = [...byTime.values()].sort((a, b) => a.time - b.time)
            this.closed.set(k, merged.slice(-MEM_CAP))
            this.candles.set(k, agg[agg.length - 1])
            // Task 59 (P2): archive the real broker bars. The only other
            // archive writer is applyTick's rollover, which in live mode
            // files 4s-sampled bars with volume 0 - the archive (and every
            // post-restart deep read: delta, volume profile, orderflow
            // strategies) was being poisoned with dead volume. agg's last
            // element is the broker's FORMING bar - excluded here. The
            // archive UPSERT (ON CONFLICT DO UPDATE) overwrites the degraded
            // tick-rolled row for the same timestamp.
            const lastArchived = this.archivedUpTo.get(k) ?? 0
            const closedAgg = agg.slice(0, -1).filter((c) => c.time > lastArchived)
            if (closedAgg.length) {
              for (const c of closedAgg)
                this.archiveQueue.push({ asset, tf, time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })
              this.archivedUpTo.set(k, closedAgg[closedAgg.length - 1].time)
            }
          }
        }
        const lastC = candleData.candles[candleData.candles.length - 1]
        this.prices.set(asset, lastC.close)
      }
    } catch {
      // per-asset failure must not kill the remaining assets' polls; the
      // pollFailStreak alert above covers systemic sidecar failure
    }
  }

  private aggregate(source: Candle[], tfSec: number): Candle[] {
    const out: Candle[] = []
    let cur: Candle | null = null
    for (const c of source) {
      const bucket = c.time - (c.time % tfSec)
      if (!cur || cur.time !== bucket) {
        if (cur) out.push(cur)
        cur = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }
      } else {
        cur.high = Math.max(cur.high, c.high)
        cur.low = Math.min(cur.low, c.low)
        cur.close = c.close
        cur.volume += c.volume
      }
    }
    if (cur) out.push(cur)
    return out
  }

  // ---------- public API ----------

  /**
   * closedOnly (Task 59): skip the just-opened forming bar. Decision and
   * analytics reads (confluence, markov, screener, delta, candle math) MUST
   * use it - a 1-tick forming bar read as the "last candle" made every live
   * signal evaluate the freshly-opened bar (markov lastState -> flat ~86% of
   * the time on 1m) while backtests evaluated closed bars only. The chart
   * keeps the default (forming bar included) - it renders the live bar.
   */
  getCandles(asset: string, tf: Timeframe, limit = 400, closedOnly = false): Candle[] {
    this.ensureSeeded(asset)
    const k = this.key(asset, tf)
    const closedArr = this.closed.get(k) ?? []
    const forming = closedOnly ? undefined : this.candles.get(k)
    // The sim engine, the live poll and the archive can momentarily disagree
    // (e.g. right after connecting IQ on a weekend: closed=Friday real bars,
    // forming=stale Sunday sim bar). The chart asserts ascending time - so
    // sort + dedupe here; the newest write wins a timestamp collision.
    const merged = forming ? [...closedArr, forming] : [...closedArr]
    merged.sort((a, b) => a.time - b.time)
    const deduped: Candle[] = []
    for (const c of merged) {
      if (deduped.length && deduped[deduped.length - 1].time === c.time) deduped[deduped.length - 1] = c
      else deduped.push(c)
    }
    return deduped.slice(-limit)
  }

  /**
   * DEEP read: archived bars + in-memory tail merged by time (in-memory wins on overlap).
   * The research lab reads through this so optimizer / walk-forward see the full
   * accumulated history instead of the seeded window.
   */
  getCandlesDeep(asset: string, tf: Timeframe, limit = 2200, closedOnly = false): Candle[] {
    const live = this.getCandles(asset, tf, limit, closedOnly)
    if (!this.store) return live
    let archived: Candle[] = []
    try {
      archived = this.store.getCandlesArchive(asset, tf, limit)
    } catch {
      return live
    }
    if (!archived.length) return live
    if (!live.length) return archived.slice(-limit)
    const liveFirst = live[0].time
    const archLast = archived[archived.length - 1].time
    if (archLast < liveFirst) return [...archived, ...live].slice(-limit)
    // overlap: newest source wins per timestamp
    const byTime = new Map<number, Candle>()
    for (const c of archived) byTime.set(c.time, c)
    for (const c of live) byTime.set(c.time, c)
    return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-limit)
  }

  getPrice(asset: string): number {
    return this.prices.get(asset) ?? 0
  }

  /** Read-only view of the SIM engine's own tick ring buffer (1s cadence,
   * ~MAX_TICKS deep). The OTC footprint collector lazily backfills its
   * per-asset micro-tick history from here so a fresh kernel boot doesn't
   * start the velocity footprint from zero. NOT the live feed - live OTC
   * ticks come from the sidecar's 100ms capture via getTickSeries(). */
  recentTicks(asset: string, limit = 60000): { ts: number; price: number }[] {
    const arr = this.ticks.get(asset)
    if (!arr || !arr.length) return []
    return arr.slice(-limit).map((t) => ({ ts: t.ts, price: t.price }))
  }


  /**
   * Randomness-audit price series: real sub-candle ticks from the sidecar's
   * buffer when LIVE/IQ and the buffer has enough samples, otherwise the
   * finest candle resolution this OS tracks ('5s'). Always says which one
   * it used (dataSource) so the UI can label the result honestly instead of
   * implying raw tick data when it is really candle-close data.
   */
  /**
   * LAZY sidecar pull for assets this kernel process never warmed (e.g.
   * OTC forensics on an arbitrary pair the UI never opened). One sidecar
   * /candles round trip, capped at IQ's 1000-per-call. No caching - the
   * caller paces itself; the sidecar's global lock stays fair.
   */
  async fetchSidecarCandles(asset: string, tf: Timeframe, limit: number): Promise<Candle[]> {
    try {
      const tfSec = TIMEFRAME_SECONDS[tf] ?? 60
      const url = `${this.liveUrl.replace(/\/$/, '')}/candles?asset=${encodeURIComponent(asset)}&size=${Math.min(1000, Math.max(100, Math.floor(limit)))}&tf=${tfSec}`
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json()) as { ok?: boolean; candles?: Candle[] }
      return (res?.candles ?? []).filter((c) => c && Number.isFinite(Number(c.time)) && Number.isFinite(Number(c.close)))
    } catch {
      return []
    }
  }

  async getTickSeries(asset: string): Promise<{ points: { time: number; price: number }[]; dataSource: 'tick' | 'candle' }> {
    if (this.mode === 'live') {
      try {
        const url = `${this.liveUrl.replace(/\/$/, '')}/tick_stats?asset=${encodeURIComponent(asset)}`
        const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
        const data = (await res.json()) as { ok?: boolean; points?: { time: number; price: number }[] }
        if (data?.ok && Array.isArray(data.points) && data.points.length >= 20) {
          return { points: data.points, dataSource: 'tick' }
        }
      } catch {
        // sidecar unreachable / buffer too young - fall through to candles
      }
    }
    const candles = this.getCandles(asset, '5s', 1000)
    return { points: candles.map((c) => ({ time: c.time, price: c.close })), dataSource: 'candle' }
  }

  listAssets(): (AssetInfo & { price: number; iq: boolean })[] {
    return this.assets.map((a) => ({ ...a, price: this.prices.get(a.ticker) ?? a.basePrice, iq: this.isIQAvailable(a.ticker) }))
  }

  setMode(mode: MarketMode): void {
    if (mode === 'live') throw new Error('use connectLive() to enter live mode')
    this.disconnectLive()
  }

  /** Payout lookup per trade kind. IQ-native instruments (and any trade in
   * live mode) use the account's REAL reported payouts; the sim universe
   * keeps its own modeled payouts for paper settlement. Digital has no real
   * IQ figure in iqair 1.0.0 - the binary payout is the honest estimate. */
  payoutFor(ticker: string, kind: 'binary' | 'turbo' | 'digital' | 'cfd'): number {
    if (kind === 'cfd') return 1
    // AUDIT FIX (Task 58, P2): the lookup used the OS ticker only, so remapped
    // instruments (UKBrent→OIL_BRENT, USCrude→OIL_WTI, NASDAQ100→NSDQ100,
    // DJI30→DJ30) never matched sidecarPayouts and always got the sim-modeled
    // payout - the auto-trader's EV gate judged them on a made-up number even
    // live. isOptionInstrument/isIQAvailable map through iqairName first;
    // payoutFor now does too.
    const sym = this.iqairSymbol(ticker)
    const iq = (sym !== ticker ? this.sidecarPayouts.get(sym) : undefined) ?? this.sidecarPayouts.get(ticker)
    const a = getInstrument(ticker)
    if (iq && (!a || this.mode === 'live')) {
      const base = iq.binary ?? (a ? a.payout : 0.85)
      if (kind === 'turbo') return iq.turbo ?? base
      return base // binary + digital (no real digital figure available)
    }
    if (!a) return 0.8
    if (kind === 'turbo') return a.turboPayout ?? a.payout - 0.02
    if (kind === 'digital') return a.digitalPayout ?? a.payout + 0.05
    return a.payout
  }

  /** Map an OS ticker to the live iqair instrument id. */
  iqairSymbol(ticker: string): string {
    const a = getInstrument(ticker)
    return a?.iqairName ?? ticker
  }

  /** Observed payout samples for the /iv_hv IV-proxy series (Task 63).
   * Accepts either the OS ticker or the iqair symbol. In-memory, accrues
   * live, resets on kernel restart - callers must disclose that. */
  getPayoutHistory(ticker: string): { t: number; payout: number }[] {
    const sym = this.iqairSymbol(ticker)
    return (sym !== ticker ? this.payoutHistory.get(sym) : undefined) ?? this.payoutHistory.get(ticker) ?? []
  }
}

let activeService: MarketDataService | null = null

export const marketDataPlugin: Plugin = {
  name: 'market-data',
  start(ctx) {
    const svc = new MarketDataService()
    activeService = svc
    ctx.provide('market', svc)
    return svc.start(ctx)
  },
  stop() {
    activeService?.stop()
    activeService = null
  },
}
