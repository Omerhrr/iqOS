// IQAIR//OS - Market Data plugin
// SIM engine: regime-switching geometric brownian motion ticking 1/s per asset,
// with seeded per-timeframe candle history. All timeframes stay consistent with
// the live tick path because every candle is aggregated from the same ticks.
//
// LIVE bridge (iqair): polls the iqair sidecar for candles + prices and merges
// them into the same (asset, tf) series, so the rest of the OS is broker-agnostic.

import type { AssetInfo, Candle, MarketMode, Timeframe } from '../types'
import type { KernelContext } from '../kernel'
import { ALL_TIMEFRAMES, TIMEFRAME_SECONDS } from '../types'
import type { Plugin } from '../kernel'
import { gaussLike } from './random'
import { UNIVERSE, getInstrument, isInstrumentOpen } from '../universe'

const HISTORY_CANDLES = 760
const MAX_TICKS = 40000

interface Regime {
  drift: number
  anchor: number
}

export class MarketDataService {
  private ctx!: KernelContext
  mode: MarketMode = 'sim'
  liveUrl = 'http://127.0.0.1:8788'
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
  private lastCandleTs = new Map<string, number>()
  activeAsset = 'EURUSD'

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
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
    ctx.log('market-data', `universe online: ${this.assets.length} instruments, ${ALL_TIMEFRAMES.length} timeframes (lazy seeding)`)
  }

  /** Materialize seeded history + sim tracking for an instrument on first use. */
  ensureSeeded(ticker: string): void {
    if (this.seeded.has(ticker)) return
    const a = this.assets.find((x) => x.ticker === ticker)
    if (!a) return
    this.seeded.add(ticker)
    for (const tf of ALL_TIMEFRAMES) {
      this.closed.set(this.key(ticker, tf), this.seedHistory(a, tf))
    }
  }

  refreshSchedules(): void {
    const now = new Date()
    for (const a of this.assets) {
      a.open = isInstrumentOpen(a, now)
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.liveTimer) clearInterval(this.liveTimer)
  }

  private key(asset: string, tf: Timeframe) {
    return `${asset}|${tf}`
  }

  /** Seed statistically-plausible history ending at basePrice. */
  private seedHistory(asset: AssetInfo, tf: Timeframe): Candle[] {
    const tfSec = TIMEFRAME_SECONDS[tf]
    const sigma = asset.volatility * Math.sqrt(tfSec) * (tf === '5s' ? 1.15 : tf === '15s' ? 1.1 : 1)
    const out: Candle[] = []
    const now = Math.floor(Date.now() / 1000)
    const t0 = now - (now % tfSec) - HISTORY_CANDLES * tfSec
    let price = asset.basePrice * (1 - asset.volatility * Math.sqrt(tfSec) * 6)
    // walk forward with occasional regime shifts so the data has trend + range phases
    let drift = 0
    for (let i = 0; i < HISTORY_CANDLES; i++) {
      if (Math.random() < 0.015) drift = (Math.random() - 0.5) * sigma * 0.9
      const open = price
      const ret = drift + (sigma * (Math.random() + Math.random() + Math.random() + Math.random() - 2)) * 0.87
      const close = open * Math.exp(ret)
      const wick = Math.abs(ret) * 1.8 + sigma * 0.6
      const high = Math.max(open, close) * (1 + wick * Math.random() * 0.55)
      const low = Math.min(open, close) * (1 - wick * Math.random() * 0.55)
      const volume = Math.round(500 + Math.random() * 2500 * (1 + Math.abs(ret) / sigma))
      out.push({ time: t0 + i * tfSec, open, high, low, close, volume })
      price = close
    }
    // rescale so the series ends exactly at basePrice
    const scale = asset.basePrice / out[out.length - 1].close
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
        arr.push(current)
        if (arr.length > 1500) arr.splice(0, arr.length - 1500)
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

  async connectLive(url: string, email: string, password: string, balanceMode: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, balance_mode: balanceMode }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) return { ok: false, error: data.error ?? 'sidecar rejected connection' }
      this.liveUrl = url
      this.mode = 'live'
      if (this.liveTimer) clearInterval(this.liveTimer)
      this.liveTimer = setInterval(() => void this.pollLive(), 4000)
      void this.pollLive()
      this.ctx.log('market-data', `LIVE via iqair sidecar @ ${url}`)
      return { ok: true }
    } catch (err) {
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
    try {
      const url = `${this.liveUrl.replace(/\/$/, '')}`
      const [candleRes, priceRes] = await Promise.all([
        fetch(`${url}/candles?asset=${this.activeAsset}&size=240&tf=60`),
        fetch(`${url}/price?asset=${this.activeAsset}`),
      ])
      const candleData = (await candleRes.json()) as { ok: boolean; candles?: Candle[] }
      const priceData = (await priceRes.json()) as { ok: boolean; price?: number }
      if (candleData.ok && candleData.candles?.length) {
        for (const tf of ALL_TIMEFRAMES) {
          const agg = this.aggregate(candleData.candles, TIMEFRAME_SECONDS[tf])
          if (agg.length > 10) {
            this.closed.set(this.key(this.activeAsset, tf), agg.slice(0, -1))
            this.candles.set(this.key(this.activeAsset, tf), agg[agg.length - 1])
          }
        }
        const lastC = candleData.candles[candleData.candles.length - 1]
        this.prices.set(this.activeAsset, lastC.close)
      }
      if (priceData.ok && priceData.price) {
        const now = Math.floor(Date.now() / 1000)
        this.prices.set(this.activeAsset, priceData.price)
        for (const tf of ALL_TIMEFRAMES) this.applyTick(this.activeAsset, tf, { ts: now, price: priceData.price, vol: 0 })
      }
    } catch (err) {
      this.ctx.bus.emit('alert', { level: 'warn', message: `live feed hiccup: ${(err as Error).message}`, ts: Math.floor(Date.now() / 1000) })
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

  getCandles(asset: string, tf: Timeframe, limit = 400): Candle[] {
    this.ensureSeeded(asset)
    const k = this.key(asset, tf)
    const closedArr = this.closed.get(k) ?? []
    const forming = this.candles.get(k)
    const all = forming ? [...closedArr, forming] : [...closedArr]
    return all.slice(-limit)
  }

  getPrice(asset: string): number {
    return this.prices.get(asset) ?? 0
  }

  listAssets(): (AssetInfo & { price: number })[] {
    return this.assets.map((a) => ({ ...a, price: this.prices.get(a.ticker) ?? a.basePrice }))
  }

  setMode(mode: MarketMode): void {
    if (mode === 'live') throw new Error('use connectLive() to enter live mode')
    this.disconnectLive()
  }

  /** Payout lookup per trade kind. */
  payoutFor(ticker: string, kind: 'binary' | 'turbo' | 'digital' | 'cfd'): number {
    const a = getInstrument(ticker)
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
