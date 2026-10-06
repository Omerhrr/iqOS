// IQAIR//OS - Screener2 plugin (DISCOVERY layer, Confluence Signal engine)
// NOT a Screener clone - a market-wide sweep of the SAME engine the
// single-asset Confluence Signal panel/confluence_read use (confluenceSignalOnly,
// on the same deep candle read - market.getCandlesDeep(asset, tf, 1500),
// archived + live tail). A row carries the real CompositeSignal.factors array
// (EMA Stack, ADX/DI, Regression Slope, Supertrend, RSI, MACD Hist, Stochastic
// K/D, Bollinger %B, Z-Score, Williams %R, Markov P(up), Hurst Exponent,
// Kalman/OU Stretch, Pattern Bias) - the exact factor breakdown the panel
// shows for one pair - not the Screener's derived scalar columns (rsi/adx/
// regime/hurst/ouZ/pUp as plain numbers, topPattern as a name). The UI is
// responsible for rendering each row as a shrunk version of the panel's own
// meter + factor list, not a data-table row.

import type { AssetCategory, Factor, Timeframe } from '../types'
import type { KernelContext, Plugin } from '../kernel'
import type { MarketDataService } from './market-data'
import { confluenceSignalOnly } from '../analytics/engine'
import { searchInstruments } from '../universe'

/** One pair's full Confluence Signal read - everything the single-asset panel
 * shows (meter + factor votes), plus the metadata needed to list/sort/click it. */
export interface ConfluenceRow {
  asset: string
  name: string
  category: AssetCategory
  otc: boolean
  tf: Timeframe
  price: number
  score: number // -100..100, same as the panel's meter
  direction: 'call' | 'put' | 'none'
  confidence: number // 0..100
  factors: Factor[] // the exact 14-factor breakdown the panel lists
  payout: number
  ts: number // candle time the row was computed on
  computedTs: number // wall clock when computed
}

export interface Screener2Config {
  tfs: Timeframe[]
  category: 'all' | AssetCategory | 'otc'
  batch: number // small - each pair re-fits the full engine on 1500 deep candles
  minCandles: number
}

export const DEFAULT_SCREENER2_CONFIG: Screener2Config = {
  tfs: ['1m', '5m', '15m'],
  category: 'all',
  batch: 3,
  minCandles: 240,
}

/** Deep-read depth, matching AnalyticsService.analyze()'s getCandlesDeep call
 * exactly - the real source of a "panel vs sweep" divergence is candle depth
 * (EMA200/Markov lookback 500/Hurst/regression all starved on a shallow
 * window), not the OU model, which is identical either way. */
const DEEP_CANDLES = 1500

const VALID_TFS: Timeframe[] = ['5s', '15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d']
const SWEEP_COOLDOWN_MS = 20_000

export class Screener2Service {
  private ctx!: KernelContext
  private market!: MarketDataService
  config: Screener2Config = { ...DEFAULT_SCREENER2_CONFIG }
  private rows = new Map<string, ConfluenceRow>()
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
    ctx.log('screener2', `Confluence Signal sweep online - targets ${this.config.tfs.join('/')} across the full universe`)
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

  /** Score one pair with confluenceSignalOnly on the panel's own deep candle
   * read - the row IS the panel's CompositeSignal, nothing derived/renamed. */
  private scorePair(asset: string, tf: Timeframe): ConfluenceRow {
    const candles = this.market.getCandlesDeep(asset, tf, DEEP_CANDLES)
    if (candles.length < this.config.minCandles) throw new Error(`thin history ${asset} ${tf}`)
    const sig = confluenceSignalOnly(candles, asset, tf)
    const inst = this.market.assets.find((a) => a.ticker === asset)
    const row: ConfluenceRow = {
      asset,
      name: inst?.name ?? asset,
      category: inst?.category ?? 'forex',
      otc: inst?.otc ?? false,
      tf,
      price: sig.price,
      score: Math.round(sig.score * 10) / 10,
      direction: sig.direction,
      confidence: Math.round(sig.confidence),
      factors: sig.factors,
      payout: this.market.payoutFor(asset, 'binary'),
      ts: sig.ts,
      computedTs: Math.floor(Date.now() / 1000),
    }
    this.rows.set(`${asset}|${tf}`, row)
    this.stale.delete(`${asset}|${tf}`)
    return row
  }

  // ---------- public API ----------

  evaluate(asset: string, tf: Timeframe): ConfluenceRow {
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
  }): { rows: ConfluenceRow[]; total: number } {
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
