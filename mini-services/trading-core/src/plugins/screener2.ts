// IQAIR//OS - Screener2 plugin (DISCOVERY layer, confluence engine)
// Same background-sweep architecture as the Screener plugin (screener.ts),
// but the score/direction/confidence on every row come from
// confluenceSignalOnly - the EXACT 14-factor Confluence Signal panel /
// confluence_read engine (full Kalman/OU fit), not the Screener's cheaper
// ouState approximation. Display-only fields (rsi/adx/hurst/ouZ/pUp/regime/
// pattern) are borrowed from the lightweight scanSnapshot on the same
// candles - identical cost to the main screener for those, so the only extra
// work per pair is the one confluence re-fit. Kept as its own plugin/service/
// endpoint pair (not a mode of the original) so the two feeds, and their
// independent sweep cadence, never interfere with each other.

import type { AssetCategory, Timeframe } from '../types'
import type { KernelContext, Plugin } from '../kernel'
import type { MarketDataService } from './market-data'
import type { ScreenRow } from './screener'
import { confluenceSignalOnly, scanSnapshot } from '../analytics/engine'
import { searchInstruments } from '../universe'

export interface Screener2Config {
  tfs: Timeframe[]
  category: 'all' | AssetCategory | 'otc'
  batch: number // smaller than screener's default - each pair costs more (full Kalman fit)
  minCandles: number
}

export const DEFAULT_SCREENER2_CONFIG: Screener2Config = {
  tfs: ['1m', '5m', '15m'],
  category: 'all',
  batch: 3,
  minCandles: 240,
}

const VALID_TFS: Timeframe[] = ['5s', '15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d']
const SWEEP_COOLDOWN_MS = 20_000

export class Screener2Service {
  private ctx!: KernelContext
  private market!: MarketDataService
  config: Screener2Config = { ...DEFAULT_SCREENER2_CONFIG }
  private rows = new Map<string, ScreenRow>()
  private queue: { asset: string; tf: Timeframe }[] = []
  private stale = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSweepTs = 0
  private lastSweepMs = 0
  private sweeping = false
  private started = 0

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.started = Math.floor(Date.now() / 1000)

    ctx.bus.on('candle', ({ asset, tf, closed }) => {
      if (!closed) return
      const key = `${asset}|${tf}`
      if (this.rows.has(key)) this.stale.add(key)
    })

    this.timer = setInterval(() => this.pump(), 1_200)
    ctx.log('screener2', `confluence discovery engine online - sweep targets ${this.config.tfs.join('/')} across the full universe`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ---------- configuration ----------

  configure(patch: Partial<Screener2Config>): { ok: boolean; config: Screener2Config; error?: string } {
    if (patch.tfs !== undefined) {
      const tfs = (Array.isArray(patch.tfs) ? patch.tfs : [])
        .map((t) => String(t) as Timeframe)
        .filter((t) => VALID_TFS.includes(t))
      if (!tfs.length) return { ok: false, config: this.config, error: `tfs must be a non-empty list from ${VALID_TFS.join('|')}` }
      this.config.tfs = [...new Set(tfs)].slice(0, 4)
      this.resetSweep()
    }
    if (patch.category !== undefined) {
      const c = String(patch.category)
      if (!['all', 'otc', 'forex', 'crypto', 'commodity', 'stock', 'index'].includes(c)) {
        return { ok: false, config: this.config, error: `unknown category ${c}` }
      }
      this.config.category = c as Screener2Config['category']
      this.resetSweep()
    }
    if (patch.batch !== undefined) this.config.batch = Math.min(12, Math.max(1, Math.round(Number(patch.batch) || DEFAULT_SCREENER2_CONFIG.batch)))
    if (patch.minCandles !== undefined) this.config.minCandles = Math.min(700, Math.max(60, Math.round(Number(patch.minCandles) || DEFAULT_SCREENER2_CONFIG.minCandles)))
    this.ctx.log('screener2', `config updated - tfs ${this.config.tfs.join('/')} category ${this.config.category}`)
    return { ok: true, config: { ...this.config } }
  }

  private resetSweep(): void {
    this.queue = []
    this.lastSweepTs = 0
  }

  // ---------- scanning ----------

  private buildQueue(): void {
    const t0 = Date.now()
    const instruments = searchInstruments('', this.config.category).filter((i) => i.open)
    const queue: { asset: string; tf: Timeframe }[] = []
    for (const tf of this.config.tfs) {
      for (const inst of instruments) queue.push({ asset: inst.ticker, tf })
    }
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
      this.ctx.log('screener2', `sweep complete - ${this.rows.size} pairs scored (queue drain ${this.lastSweepMs}ms)`)
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

  /**
   * Score one pair with the full confluence engine (direction/score/
   * confidence) - everything else on the row is the cheap scanSnapshot on the
   * SAME candles, for display only, exactly as the auto-trader's
   * pickConfluenceSignal borrows screener metadata.
   */
  private scorePair(asset: string, tf: Timeframe): ScreenRow {
    const candles = this.market.getCandles(asset, tf, 300)
    if (candles.length < this.config.minCandles) throw new Error(`thin history ${asset} ${tf}`)
    const snap = scanSnapshot(candles, asset, tf)
    const sig = confluenceSignalOnly(candles, asset, tf)
    const inst = this.market.assets.find((a) => a.ticker === asset)
    const row: ScreenRow = {
      asset,
      name: inst?.name ?? asset,
      category: inst?.category ?? 'forex',
      otc: inst?.otc ?? false,
      tf,
      price: snap.price,
      score: Math.round(sig.score * 10) / 10,
      direction: sig.direction,
      confidence: Math.round(sig.confidence),
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

let active: Screener2Service | null = null

export const screener2Plugin: Plugin = {
  name: 'screener2',
  start: async (ctx) => {
    const svc = new Screener2Service()
    active = svc
    ctx.provide('screener2', svc)
    await svc.start(ctx)
  },
  stop: () => {
    active?.stop()
    active = null
  },
}
