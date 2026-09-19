// IQAIR//OS - Analytics plugin
// Wraps the analysis engine behind the kernel and caches results per (asset, tf)
// until a new candle closes, so panels/agent hit the cache instead of recomputing.

import type { AnalysisResult, Timeframe } from '../types'
import type { KernelContext, Plugin } from '../kernel'
import type { MarketDataService } from './market-data'
import { analyze } from '../analytics/engine'
import { backtest, type BacktestOptions } from '../strategies/backtest'
import { STRATEGIES, getStrategy, defaultParams } from '../strategies/builtin'

export class AnalyticsService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private cache = new Map<string, { ts: number; result: AnalysisResult }>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    // invalidate cache when a candle closes
    ctx.bus.on('candle', ({ asset, tf, closed }) => {
      if (closed) this.cache.delete(`${asset}|${tf}`)
    })
    ctx.log('analytics', 'analysis engine online (indicators, patterns, markov, montecarlo, quant)')
  }

  analyze(asset: string, tf: Timeframe, force = false): AnalysisResult {
    const key = `${asset}|${tf}`
    if (!force) {
      const hit = this.cache.get(key)
      if (hit) return hit.result
    }
    // deep read: prefer archived history so markov/quant stats survive restarts
    const candles = this.market.getCandlesDeep(asset, tf, 1500)
    if (candles.length < 60) throw new Error(`not enough candles yet for ${asset} ${tf} (${candles.length})`)
    const result = analyze(candles, asset, tf)
    this.cache.set(key, { ts: result.ts, result })
    return result
  }

  listStrategies() {
    return STRATEGIES.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      params: s.params,
      defaults: defaultParams(s),
    }))
  }

  runStrategy(asset: string, tf: Timeframe, strategyId: string, params?: Record<string, number | string>) {
    const strat = getStrategy(strategyId)
    if (!strat) throw new Error(`unknown strategy ${strategyId}`)
    // deep read: long-warmup strategies (markov family) stay usable right after restarts
    const candles = this.market.getCandlesDeep(asset, tf, 1500)
    if (candles.length < 60) throw new Error('not enough candle history yet')
    const merged = { ...defaultParams(strat), ...(params ?? {}) }
    const ev = strat.evaluate(candles, merged)
    return { ...ev, asset, tf, strategy: strategyId, price: candles[candles.length - 1].close }
  }

  runBacktest(asset: string, tf: Timeframe, opts: BacktestOptions) {
    // deep read: the backtest lab sees the full accumulated history (up to 2200 bars)
    const candles = this.market.getCandlesDeep(asset, tf, 2200)
    if (candles.length < 300) throw new Error('not enough candle history for a meaningful backtest')
    return backtest(candles, asset, tf, opts)
  }

  private log(..._args: unknown[]) {
    void this.ctx
  }
}

let active: AnalyticsService | null = null

export const analyticsPlugin: Plugin = {
  name: 'analytics',
  start: async (ctx) => {
    const svc = new AnalyticsService()
    active = svc
    ctx.provide('analytics', svc)
    await svc.start(ctx)
  },
  stop: () => {
    active = null
  },
}
