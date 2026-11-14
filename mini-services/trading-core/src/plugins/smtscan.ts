// IQAIR//OS - SMT divergence scan plugin: one pair on demand, or a board of the default co-moving pairs that are open right now.
// Closed candles only; descriptive, not a forecast.
import type { KernelContext, Plugin } from '../kernel'
import type { Timeframe } from '../types'
import { ALL_TIMEFRAMES } from '../types'
import { smtDivergence, type SmtResult } from '../analytics/smt'
import type { MarketDataService } from './market-data'

const LOOKBACK_BARS = 200

/** pairs that normally co-move (inverse = the partner moves the opposite way). Only those with BOTH sides open are scanned. */
export const DEFAULT_SMT_PAIRS: { a: string; b: string; inverse?: boolean }[] = [
  { a: 'EURUSD', b: 'GBPUSD' },
  { a: 'AUDUSD', b: 'NZDUSD' },
  { a: 'EURUSD', b: 'USDCHF', inverse: true },
  { a: 'GBPUSD', b: 'USDCHF', inverse: true },
  { a: 'EURUSD-OTC', b: 'GBPUSD-OTC' },
  { a: 'AUDUSD-OTC', b: 'NZDUSD-OTC' },
  { a: 'EURJPY', b: 'GBPJPY' },
  { a: 'XAUUSD', b: 'XAGUSD' },
]

export interface SmtRow extends SmtResult {
  a: string
  b: string
  inverse: boolean
}

export class SmtScanService {
  private market!: MarketDataService
  async start(ctx: KernelContext): Promise<void> {
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('smtscan', 'SMT divergence scan online')
  }
  stop(): void {}

  one(a: string, b: string, tf: string, opts: { lookback?: number; recent?: number; inverse?: boolean } = {}): SmtRow | { ok: false; error: string } {
    if (!(ALL_TIMEFRAMES as string[]).includes(tf)) return { ok: false, error: `unknown timeframe '${tf}'` }
    const ca = this.market.getCandlesDeep(a, tf as Timeframe, LOOKBACK_BARS, true)
    const cb = this.market.getCandlesDeep(b, tf as Timeframe, LOOKBACK_BARS, true)
    if (!ca || !cb) return { ok: false, error: `no candles for ${!ca ? a : b}` }
    return { ...smtDivergence(ca, cb, opts), a, b, inverse: !!opts.inverse }
  }

  board(tf: string, opts: { lookback?: number; recent?: number } = {}): { ok: true; tf: string; rows: SmtRow[]; diverging: SmtRow[]; skipped: string[]; note: string } | { ok: false; error: string } {
    if (!(ALL_TIMEFRAMES as string[]).includes(tf)) return { ok: false, error: `unknown timeframe '${tf}'` }
    const open = new Set(this.market.listAssets().filter((x) => x.open).map((x) => x.ticker))
    const rows: SmtRow[] = []
    const skipped: string[] = []
    for (const p of DEFAULT_SMT_PAIRS) {
      if (!open.has(p.a) || !open.has(p.b)) { skipped.push(`${p.a}/${p.b} (not both open)`); continue }
      const r = this.one(p.a, p.b, tf, { ...opts, inverse: p.inverse })
      if ('error' in r) { skipped.push(`${p.a}/${p.b} (${r.error})`); continue }
      rows.push(r)
    }
    return {
      ok: true,
      tf,
      rows,
      diverging: rows.filter((r) => r.direction !== 'none'),
      skipped,
      note: 'Descriptive only: one mechanical reading of SMT on closed candles (recent vs prior extremes, gated on return correlation >= 0.5). It has no measured edge.',
    }
  }
}

export const smtScanPlugin: Plugin = {
  name: 'smtscan',
  start: async (ctx) => {
    const svc = new SmtScanService()
    ctx.provide('smtscan', svc)
    await svc.start(ctx)
  },
}
