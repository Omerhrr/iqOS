// IQAIR//OS - Renko / Kagi reversal event feeds plugin
//
// Thin market-data wrapper over analytics/reversalevents.ts, same shape as
// plugins/mrcpredict.ts: one `readFor`-style call per panel, no state, nothing
// to flush. Candle fidelity only (closed bars) - both engines are
// SAFE_BACKTEST_SOURCES-tier, so live and backtest reads agree bar-for-bar.

import type { KernelContext, Plugin } from '../kernel'
import type { Candle, Timeframe } from '../types'
import {
  kagiReversalFeed,
  renkoReversalFeed,
  type FeedOpts,
  type KagiReversalFeed,
  type RenkoReversalFeed,
  type ReversalSource,
} from '../analytics/reversalevents'
import type { MarketDataService } from './market-data'

const DEFAULT_TF: Timeframe = '1m'
const VALID_TF = new Set<string>(['5s', '15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d'])
/** Closed bars searched: enough for hundreds of events (and a meaningful
 * follow-through sample) without making the per-poll walk expensive. */
const WINDOW = 800

export type FeedResult<T> = { ok: true; result: T } | { ok: false; error: string }

export class ReversalEventsService {
  private market!: MarketDataService

  async start(ctx: KernelContext): Promise<void> {
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('reversalevents', 'Renko (Effort Bricks) / Kagi reversal event feeds online (closed-candle fidelity)')
  }

  stop(): void { /* stateless reads - nothing to flush */ }

  private candles(asset: string, tf: string): { candles: Candle[] | null; error: string } {
    if (!VALID_TF.has(tf)) return { candles: null, error: `unknown timeframe '${tf}'` }
    const candles = this.market.getCandlesDeep(asset, tf as Timeframe, WINDOW, true)
    if (!candles || candles.length === 0) return { candles: null, error: 'not in the tracked universe' }
    return { candles, error: '' }
  }

  renko(
    asset: string,
    tf: string = DEFAULT_TF,
    opts: FeedOpts & { source?: ReversalSource; atrMult?: number } = {},
  ): FeedResult<RenkoReversalFeed> {
    const c = this.candles(asset, tf)
    if (!c.candles) return { ok: false, error: c.error }
    return { ok: true, result: renkoReversalFeed(c.candles, opts) }
  }

  kagi(
    asset: string,
    tf: string = DEFAULT_TF,
    opts: FeedOpts & { reversalAtrMult?: number } = {},
  ): FeedResult<KagiReversalFeed> {
    const c = this.candles(asset, tf)
    if (!c.candles) return { ok: false, error: c.error }
    return { ok: true, result: kagiReversalFeed(c.candles, opts) }
  }
}

export const reversalEventsPlugin: Plugin = {
  name: 'reversalevents',
  start: async (ctx) => {
    const svc = new ReversalEventsService()
    ctx.provide('reversalevents', svc)
    await svc.start(ctx)
  },
}
