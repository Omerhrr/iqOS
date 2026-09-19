// IQAIR//OS - Screener plugin (DISCOVERY layer)
// A background scanner that walks the ENTIRE instrument universe across the
// configured timeframes and maintains a ranked opportunity feed. Uses the
// lightweight scanSnapshot (no Monte Carlo / no series) so a full sweep of
// ~115 instruments x N timeframes costs milliseconds per pair. Rows refresh
// automatically when a candle closes (stale invalidation via the event bus),
// so the feed is always built on closed-candle data.

import type { AssetCategory, Timeframe } from '../types'
import type { KernelContext, Plugin } from '../kernel'
import type { MarketDataService } from './market-data'
import { scanSnapshot } from '../analytics/engine'
import { searchInstruments } from '../universe'

export interface ScreenRow {
  asset: string
  name: string
  category: AssetCategory
  otc: boolean
  tf: Timeframe
  price: number
  score: number
  direction: 'call' | 'put' | 'none'
  confidence: number
  pUp: number
  regime: 'bull' | 'bear' | 'range' | 'chop'
  ouZ: number // Kalman/OU stretch: sigmas from the OU equilibrium
  ouHalfLife: number // OU mean-reversion half-life in bars (9999 = effectively none)
  ouMeanReverting: boolean // OU fit significance gate (t-stat + tradeable half-life)
  ouTStat: number // t-stat of the OU reversion fit
  rsi: number
  adx: number
  atrPct: number
  hurst: number
  changePct: number
  payout: number
  topPattern: { name: string; direction: string; reliability: number } | null
  ts: number // candle time the row was computed on
  computedTs: number // wall clock when computed
}

export interface ScreenerConfig {
  tfs: Timeframe[]
  /** category filter for the sweep; 'all' covers every instrument (OTC included) */
  category: 'all' | AssetCategory | 'otc'
  /** pairs processed per loop tick - keeps the kernel responsive */
  batch: number
  /** minimum closed candles required before a pair is scored */
  minCandles: number
}

export const DEFAULT_SCREENER_CONFIG: ScreenerConfig = {
  tfs: ['1m', '5m', '15m'],
  category: 'all',
  batch: 6,
  minCandles: 240,
}

const VALID_TFS: Timeframe[] = ['5s', '15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d']
const SWEEP_COOLDOWN_MS = 20_000 // minimum pause between full sweeps

export class ScreenerService {
  private ctx!: KernelContext
  private market!: MarketDataService
  config: ScreenerConfig = { ...DEFAULT_SCREENER_CONFIG }
  private rows = new Map<string, ScreenRow>() // key = asset|tf
  private queue: { asset: string; tf: Timeframe }[] = []
  private stale = new Set<string>() // keys invalidated by a candle close, scanned first
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSweepTs = 0
  private lastSweepMs = 0
  private sweeping = false
  private started = 0

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.started = Math.floor(Date.now() / 1000)

    // candle close -> invalidate that pair so the next loop tick rescores it
    ctx.bus.on('candle', ({ asset, tf, closed }) => {
      if (!closed) return
      const key = `${asset}|${tf}`
      if (this.rows.has(key)) this.stale.add(key)
    })

    // single paced loop: drains the queue a small batch at a time
    this.timer = setInterval(() => this.pump(), 1_200)
    ctx.log('screener', `discovery engine online - sweep targets ${this.config.tfs.join('/')} across the full universe`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ---------- configuration ----------

  configure(patch: Partial<ScreenerConfig>): { ok: boolean; config: ScreenerConfig; error?: string } {
    if (patch.tfs !== undefined) {
      const tfs = (Array.isArray(patch.tfs) ? patch.tfs : [])
        .map((t) => String(t) as Timeframe)
        .filter((t) => VALID_TFS.includes(t))
      if (!tfs.length) return { ok: false, config: this.config, error: `tfs must be a non-empty list from ${VALID_TFS.join('|')}` }
      // cap at 4 timeframes - beyond that sweeps stop being meaningful
      this.config.tfs = [...new Set(tfs)].slice(0, 4)
      this.resetSweep()
    }
    if (patch.category !== undefined) {
      const c = String(patch.category)
      if (!['all', 'otc', 'forex', 'crypto', 'commodity', 'stock', 'index'].includes(c)) {
        return { ok: false, config: this.config, error: `unknown category ${c}` }
      }
      this.config.category = c as ScreenerConfig['category']
      this.resetSweep()
    }
    if (patch.batch !== undefined) this.config.batch = Math.min(20, Math.max(2, Math.round(Number(patch.batch) || DEFAULT_SCREENER_CONFIG.batch)))
    if (patch.minCandles !== undefined) this.config.minCandles = Math.min(700, Math.max(60, Math.round(Number(patch.minCandles) || DEFAULT_SCREENER_CONFIG.minCandles)))
    this.ctx.log('screener', `config updated - tfs ${this.config.tfs.join('/')} category ${this.config.category}`)
    return { ok: true, config: { ...this.config } }
  }

  private resetSweep(): void {
    this.queue = []
    this.lastSweepTs = 0 // trigger a fresh sweep immediately
  }

  // ---------- scanning ----------

  private buildQueue(): void {
    const t0 = Date.now()
    const instruments = searchInstruments('', this.config.category).filter((i) => i.open)
    const queue: { asset: string; tf: Timeframe }[] = []
    for (const tf of this.config.tfs) {
      for (const inst of instruments) queue.push({ asset: inst.ticker, tf })
    }
    // stale pairs jump the queue so hot markets rescore first
    const fresh = queue.filter((p) => !this.stale.has(`${p.asset}|${p.tf}`))
    const hot = queue.filter((p) => this.stale.has(`${p.asset}|${p.tf}`))
    this.queue = [...hot, ...fresh]
    this.lastSweepTs = Math.floor(Date.now() / 1000)
    this.lastSweepMs = Date.now() - t0
    this.sweeping = true
  }

  private pump(): void {
    if (this.sweeping && this.queue.length === 0) {
      this.sweeping = false
      this.ctx.log('screener', `sweep complete - ${this.rows.size} pairs scored (queue drain ${this.lastSweepMs}ms)`)
    }
    if (!this.queue.length) {
      const nowSec = Math.floor(Date.now() / 1000)
      if (nowSec - this.lastSweepTs >= SWEEP_COOLDOWN_MS / 1000 || !this.rows.size) this.buildQueue()
      return
    }
    const batch = this.queue.splice(0, this.config.batch)
    for (const { asset, tf } of batch) {
      try {
        this.scorePair(asset, tf)
      } catch {
        // thin history / closed market - drop silently, next sweep retries
      }
    }
  }

  /** Score one pair and store the row. Throws when history is too thin. */
  private scorePair(asset: string, tf: Timeframe): ScreenRow {
    const candles = this.market.getCandles(asset, tf, 300)
    if (candles.length < this.config.minCandles) throw new Error(`thin history ${asset} ${tf}`)
    const snap = scanSnapshot(candles, asset, tf)
    const inst = this.market.assets.find((a) => a.ticker === asset)
    const row: ScreenRow = {
      asset,
      name: inst?.name ?? asset,
      category: inst?.category ?? 'forex',
      otc: inst?.otc ?? false,
      tf,
      price: snap.price,
      score: Math.round(snap.score * 10) / 10,
      direction: snap.direction,
      confidence: Math.round(snap.confidence),
      pUp: Math.round(snap.probUp * 1000) / 1000,
      regime: snap.regime,
      ouZ: Math.round(snap.ouZ * 100) / 100,
      ouHalfLife: Math.round(snap.ouHalfLife * 10) / 10,
      ouMeanReverting: snap.ouMeanReverting,
      ouTStat: Math.round(snap.ouTStat * 100) / 100,
      rsi: Math.round(snap.rsi * 10) / 10,
      adx: Math.round(snap.adx * 10) / 10,
      atrPct: Math.round(snap.atrPct * 1000) / 1000,
      hurst: Math.round(snap.hurst * 100) / 100,
      changePct: Math.round(snap.changePct * 100) / 100,
      payout: this.market.payoutFor(asset, 'binary'),
      topPattern: snap.topPattern,
      ts: snap.ts,
      computedTs: Math.floor(Date.now() / 1000),
    }
    this.rows.set(`${asset}|${tf}`, row)
    this.stale.delete(`${asset}|${tf}`)
    return row
  }

  // ---------- public API ----------

  /**
   * Fresh evaluation for one pair - recomputed on demand (used by alert rules
   * so their triggers see closed-candle data even when the row was purged).
   */
  evaluate(asset: string, tf: Timeframe): ScreenRow {
    const key = `${asset}|${tf}`
    if (!this.stale.has(key)) {
      const cached = this.rows.get(key)
      if (cached) return cached
    }
    return this.scorePair(asset, tf)
  }

  hasRow(asset: string, tf: Timeframe): boolean {
    return this.rows.has(`${asset}|${tf}`)
  }

  top(opts: {
    tf?: Timeframe
    category?: string
    direction?: 'all' | 'call' | 'put'
    minScore?: number
    q?: string
    limit?: number
  }): { rows: ScreenRow[]; total: number } {
    const q = (opts.q ?? '').toLowerCase().trim()
    let rows = [...this.rows.values()]
    if (opts.tf) rows = rows.filter((r) => r.tf === opts.tf)
    if (opts.category && opts.category !== 'all') {
      if (opts.category === 'otc') rows = rows.filter((r) => r.otc)
      else rows = rows.filter((r) => r.category === opts.category)
    }
    if (opts.direction && opts.direction !== 'all') rows = rows.filter((r) => r.direction === opts.direction)
    if (opts.minScore && opts.minScore > 0) rows = rows.filter((r) => Math.abs(r.score) >= opts.minScore!)
    if (q) rows = rows.filter((r) => `${r.asset} ${r.name}`.toLowerCase().includes(q))
    rows.sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || b.confidence - a.confidence)
    return { rows: rows.slice(0, Math.min(opts.limit ?? 40, 200)), total: rows.length }
  }

  status(): {
    pairs: number
    tfs: Timeframe[]
    category: string
    queue: number
    stale: number
    instruments: number
    lastSweepTs: number
    sweeping: boolean
    uptimeSec: number
  } {
    const instruments = new Set([...this.rows.values()].map((r) => r.asset)).size
    return {
      pairs: this.rows.size,
      tfs: this.config.tfs,
      category: this.config.category,
      queue: this.queue.length,
      stale: this.stale.size,
      instruments,
      lastSweepTs: this.lastSweepTs,
      sweeping: this.queue.length > 0,
      uptimeSec: Math.floor(Date.now() / 1000) - this.started,
    }
  }
}

let active: ScreenerService | null = null

export const screenerPlugin: Plugin = {
  name: 'screener',
  start: async (ctx) => {
    const svc = new ScreenerService()
    active = svc
    ctx.provide('screener', svc)
    await svc.start(ctx)
  },
  stop: () => {
    active?.stop()
    active = null
  },
}
