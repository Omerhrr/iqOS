// IQAIR//OS - Price/volume scan plugin
//
// For ONE timeframe, every open pair's volume-vs-price relationship (analytics/mslpv.ts readPv): is the feed's volume usable at all, how
// strongly volume tracks the SIZE of moves (corrAbs) and the DIRECTION of moves (corrRet), the volume tilt, and the relative volume. The
// summary compares REAL pairs with OTC pairs - how many carry usable volume and what the typical correlations are among those that do.
// Closed candles only, per pair/tf TTL-cached. Descriptive: a correlation in the current window says nothing about the next candle.
import type { KernelContext, Plugin } from '../kernel'
import type { Timeframe } from '../types'
import { ALL_TIMEFRAMES } from '../types'
import { readPv, pvInput, PV_MIN_BARS } from '../analytics/mslpv'
import type { MarketDataService } from './market-data'

const LOOKBACK = 160
const TTL_MS = 30_000
const WINDOW = 30

export interface PvRow {
  asset: string
  name: string
  category: string
  otc: boolean
  bars: number
  volumeOk: boolean
  corrAbs: number
  corrRet: number
  corrLevel: number
  tilt: number
  relVol: number
}
export interface PvGroup {
  pairs: number
  /** pairs whose volume varies (usable) */
  withVolume: number
  /** share of pairs with usable volume, 0..1 */
  volumeShare: number
  /** among pairs with usable volume (null when none): median and share of pairs with corrAbs >= 0.2 */
  medianCorrAbs: number | null
  medianCorrRet: number | null
  shareTracking: number | null
}
export interface PvBoard {
  ok: true
  tf: Timeframe
  scannedTs: number
  window: number
  universe: number
  noData: number
  real: PvGroup
  otc: PvGroup
  /** pairs with usable volume, strongest volume-size link first */
  rows: PvRow[]
  /** pairs with no usable volume (flat / zero / sparse) */
  noVolume: { asset: string; name: string; otc: boolean }[]
  note: string
}

const median = (a: number[]): number | null => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
export function groupOf(rows: PvRow[], total: number): PvGroup {
  const v = rows.filter((r) => r.volumeOk)
  return {
    pairs: total,
    withVolume: v.length,
    volumeShare: total ? v.length / total : 0,
    medianCorrAbs: median(v.map((r) => r.corrAbs)),
    medianCorrRet: median(v.map((r) => r.corrRet)),
    shareTracking: v.length ? v.filter((r) => r.corrAbs >= 0.2).length / v.length : null,
  }
}

export class PvScanService {
  private market!: MarketDataService
  private cache = new Map<string, { ts: number; row: Omit<PvRow, 'asset' | 'name' | 'category' | 'otc'> | null }>()

  async start(ctx: KernelContext): Promise<void> {
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('pvscan', 'Price/volume scan online (volume vs price per pair, real vs OTC)')
  }
  stop(): void {
    this.cache.clear()
  }

  global(opts: { tf?: string; refresh?: boolean } = {}): PvBoard | { ok: false; error: string } {
    const tf = opts.tf ?? '1m'
    if (!(ALL_TIMEFRAMES as string[]).includes(tf)) return { ok: false, error: `unknown timeframe '${tf}'` }
    const t = tf as Timeframe
    const universe = this.market.listAssets().filter((a) => a.open)
    const now = Date.now()
    const rows: PvRow[] = []
    const noVolume: PvBoard['noVolume'] = []
    let noData = 0
    for (const a of universe) {
      const key = `${a.ticker}:${t}`
      let hit = this.cache.get(key)
      if (opts.refresh || !hit || now - hit.ts >= TTL_MS) {
        let row: PvScanRow | null = null
        try {
          const candles = this.market.getCandlesDeep(a.ticker, t, LOOKBACK, true)
          const r = candles && candles.length >= PV_MIN_BARS ? readPv(pvInput(candles), WINDOW) : null
          row = r ? { bars: candles.length, volumeOk: r.volumeOk, corrAbs: r.corrAbs, corrRet: r.corrRet, corrLevel: r.corrLevel, tilt: r.tilt, relVol: r.relVol } : null
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
      const otc = /-OTC$/i.test(a.ticker)
      if (!hit.row.volumeOk) noVolume.push({ asset: a.ticker, name: a.name, otc })
      rows.push({ ...hit.row, asset: a.ticker, name: a.name, category: a.category, otc })
    }
    if (this.cache.size > 3000) {
      for (const [k, v] of [...this.cache.entries()].sort((x, y) => x[1].ts - y[1].ts).slice(0, 800)) this.cache.delete(k)
    }
    const real = rows.filter((r) => !r.otc)
    const otc = rows.filter((r) => r.otc)
    return {
      ok: true,
      tf: t,
      scannedTs: now,
      window: WINDOW,
      universe: universe.length,
      noData,
      real: groupOf(real, real.length),
      otc: groupOf(otc, otc.length),
      rows: rows.filter((r) => r.volumeOk).sort((x, y) => y.corrAbs - x.corrAbs || x.asset.localeCompare(y.asset)),
      noVolume,
      note: 'Descriptive only: a correlation over the last ' + WINDOW + ' bars says how volume and price moved TOGETHER recently, not what the next candle does. Pairs with flat/zero/sparse volume are listed separately (no correlation is invented for them).',
    }
  }
}
type PvScanRow = Omit<PvRow, 'asset' | 'name' | 'category' | 'otc'>

export const pvScanPlugin: Plugin = {
  name: 'pvscan',
  start: async (ctx) => {
    const svc = new PvScanService()
    ctx.provide('pvscan', svc)
    await svc.start(ctx)
  },
}
