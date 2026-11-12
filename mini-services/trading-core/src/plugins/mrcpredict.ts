// IQAIR//OS - MRC Next-Movement Predictor plugin
//
// Wraps analytics/mrcpredict.ts (the self-calibrating continuation/reversal
// predictor built on top of the Market Response Clock) with the same
// market-data plumbing and board shape as plugins/reversal.ts - one
// `readFor(asset, tf)` for the per-asset panel and a TTL-cached
// `globalScan()` for the whole-universe board.
//
// Deliberately single-timeframe (unlike reversal.ts's per-rung ladder) -
// MRC's adaptive event clock already IS its own "timeframe", built off
// candle fidelity here (no live tick upgrade - same SAFE_BACKTEST_SOURCES
// reasoning the bare 'mrc' MSL source already follows in metastrategy.ts).

import type { KernelContext, Plugin } from '../kernel'
import { computeMrc } from '../analytics/mrc'
import { predictFromMrc, type MrcPredictResult, type MrcPredictState } from '../analytics/mrcpredict'
import type { MarketDataService } from './market-data'

const GLOBAL_SCAN_TTL_MS = 15_000
const STATE_RANK: Record<MrcPredictState, number> = { warming: 0, uncertain: 1, 'reversal-likely': 2, 'continuation-likely': 2 }
const DEFAULT_TF = '1m'

export interface MrcPredictGlobalRow {
  asset: string
  tf: string
  price: number
  computedTs: number
  ok: boolean
  result: MrcPredictResult
}

export interface MrcPredictGlobalResult {
  scannedTs: number
  universe: number
  scanned: number
  live: number
  warming: number
  refreshed: number
  rows: MrcPredictGlobalRow[]
}

export class MrcPredictService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private scanRows = new Map<string, { row: MrcPredictGlobalRow; computedTs: number }>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('mrcpredict', 'MRC next-movement predictor online (self-calibrating per asset, candle fidelity)')
  }

  stop(): void { /* stateless reads - nothing to flush */ }

  /** Full predictor read for one asset/tf. Returns null for a ticker
   * outside the universe - clean fail-closed, never a fake calm. */
  readFor(asset: string, tf: string = DEFAULT_TF): MrcPredictResult | null {
    const candles = this.market.getCandlesDeep(asset, tf, 300, true)
    if (!candles || candles.length === 0) return null
    const mrc = computeMrc(candles, undefined, {})
    return predictFromMrc(mrc)
  }

  rowFor(asset: string, tf: string, priceHint: number, opts: { refresh?: boolean } = {}): MrcPredictGlobalRow {
    const key = `${asset}:${tf}`
    const cached = this.scanRows.get(key)
    if (!opts.refresh && cached && Date.now() - cached.computedTs < GLOBAL_SCAN_TTL_MS) return cached.row
    const result = this.readFor(asset, tf)
    if (!result) {
      this.scanRows.delete(key)
      return {
        asset, tf, price: priceHint, computedTs: 0, ok: false,
        result: { ok: false, note: 'not in the tracked universe', state: 'warming', direction: 'none', confidence: 0, value: 0.5, sampleSize: 0, lastResponseRatio: NaN, lastDisplacement: NaN, fidelity: 'candle' },
      }
    }
    const row: MrcPredictGlobalRow = { asset, tf, price: priceHint, computedTs: Date.now(), ok: result.ok, result }
    this.scanRows.set(key, { row, computedTs: row.computedTs })
    if (this.scanRows.size > 400) {
      const stale = [...this.scanRows.entries()].sort((a, b) => a[1].computedTs - b[1].computedTs).slice(0, 100)
      for (const [k] of stale) this.scanRows.delete(k)
    }
    return row
  }

  globalScan(opts: { tf?: string; limit?: number; category?: string; refresh?: boolean } = {}): MrcPredictGlobalResult {
    const tf = opts.tf ?? DEFAULT_TF
    const category = opts.category && opts.category !== 'all' ? opts.category : null
    const universe = this.market.listAssets().filter((a) => a.open && (!category || a.category === category))
    const limit = opts.limit !== undefined ? Math.max(1, Math.min(Math.round(opts.limit), 500)) : universe.length
    const picked = universe.slice(0, limit)

    let refreshed = 0
    const rows: MrcPredictGlobalRow[] = []
    for (const a of picked) {
      const before = this.scanRows.get(`${a.ticker}:${tf}`)?.computedTs ?? 0
      const row = this.rowFor(a.ticker, tf, a.price ?? 0, { refresh: opts.refresh === true })
      if (row.computedTs !== 0 && row.computedTs !== before) refreshed++
      rows.push(row)
    }

    const live = rows.filter((r) => r.ok)
    live.sort((x, y) =>
      STATE_RANK[y.result.state] - STATE_RANK[x.result.state] ||
      y.result.confidence - x.result.confidence ||
      x.asset.localeCompare(y.asset))
    const warmingRows = rows.filter((r) => !r.ok)
    warmingRows.sort((a, b) => a.asset.localeCompare(b.asset))
    return {
      scannedTs: Date.now(),
      universe: universe.length,
      scanned: rows.length,
      live: live.length,
      warming: warmingRows.length,
      refreshed,
      rows: [...live, ...warmingRows],
    }
  }
}

export const mrcPredictPlugin: Plugin = {
  name: 'mrcpredict',
  start: async (ctx) => {
    const svc = new MrcPredictService()
    ctx.provide('mrcpredict', svc)
    await svc.start(ctx)
  },
}
