// IQAIR//OS - Regime scan plugin
//
// The whole-universe "what regime is each pair in" board for ONE timeframe:
// every open pair is classified (analytics/regimescan.ts) as trending up,
// trending down, ranging or noise, and each bucket is ranked by its own score.
// Closed candles only; per pair/tf results are TTL-cached so a tab polling
// every few seconds does not recompute the universe each time.

import type { KernelContext, Plugin } from '../kernel'
import type { Timeframe } from '../types'
import { ALL_TIMEFRAMES } from '../types'
import { classifyRegimeRow, MIN_BARS, REGIME_WINDOW, type RegimeKind, type RegimeRow } from '../analytics/regimescan'
import type { MarketDataService } from './market-data'

const CANDLE_LOOKBACK = 140
const TTL_MS = 15_000

export interface RegimeBoardRow extends RegimeRow {
  asset: string
  name: string
  category: string
  otc: boolean
}

export interface RegimeBoard {
  ok: true
  tf: Timeframe
  scannedTs: number
  /** open instruments considered */
  universe: number
  /** instruments with enough closed candles to classify */
  classified: number
  /** instruments skipped for too little history on this timeframe */
  noData: number
  window: number
  counts: Record<RegimeKind, number>
  up: RegimeBoardRow[]
  down: RegimeBoardRow[]
  ranging: RegimeBoardRow[]
  noise: RegimeBoardRow[]
}

export class RegimeScanService {
  private market!: MarketDataService
  private cache = new Map<string, { ts: number; row: RegimeRow | null }>()

  async start(ctx: KernelContext): Promise<void> {
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('regimescan', 'Regime scan online (trend up / trend down / ranging / noise, whole universe, one tf at a time)')
  }

  stop(): void {
    this.cache.clear()
  }

  global(opts: { tf?: string; category?: string; refresh?: boolean } = {}): RegimeBoard | { ok: false; error: string } {
    const tf = opts.tf ?? '1m'
    if (!(ALL_TIMEFRAMES as string[]).includes(tf)) return { ok: false, error: `unknown timeframe '${tf}'` }
    const t = tf as Timeframe
    const category = opts.category && opts.category !== 'all' ? opts.category : null
    const universe = this.market.listAssets().filter((a) => a.open && (!category || a.category === category))
    const now = Date.now()
    const rows: RegimeBoardRow[] = []
    let noData = 0
    for (const a of universe) {
      const key = `${a.ticker}:${t}`
      let hit = this.cache.get(key)
      if (opts.refresh || !hit || now - hit.ts >= TTL_MS) {
        let row: RegimeRow | null = null
        try {
          const candles = this.market.getCandlesDeep(a.ticker, t, CANDLE_LOOKBACK, true)
          row = candles && candles.length >= MIN_BARS ? classifyRegimeRow(candles) : null
        } catch {
          row = null
        }
        hit = { ts: now, row }
        this.cache.set(key, hit)
      }
      if (!hit.row) {
        noData++
        continue
      }
      rows.push({ ...hit.row, asset: a.ticker, name: a.name, category: a.category, otc: /-OTC$/i.test(a.ticker) })
    }
    if (this.cache.size > 3000) {
      for (const [k, v] of [...this.cache.entries()].sort((x, y) => x[1].ts - y[1].ts).slice(0, 800)) this.cache.delete(k)
    }
    const by = (k: RegimeKind) => rows.filter((r) => r.regime === k).sort((x, y) => y.score - x.score || x.asset.localeCompare(y.asset))
    const up = by('trend-up')
    const down = by('trend-down')
    const ranging = by('ranging')
    const noise = by('noise')
    return {
      ok: true,
      tf: t,
      scannedTs: now,
      universe: universe.length,
      classified: rows.length,
      noData,
      window: REGIME_WINDOW,
      counts: { 'trend-up': up.length, 'trend-down': down.length, ranging: ranging.length, noise: noise.length },
      up,
      down,
      ranging,
      noise,
    }
  }
}

export const regimeScanPlugin: Plugin = {
  name: 'regimescan',
  start: async (ctx) => {
    const svc = new RegimeScanService()
    ctx.provide('regimescan', svc)
    await svc.start(ctx)
  },
}
