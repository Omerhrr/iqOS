// IQAIR//OS - Analytics plugin
// Wraps the analysis engine behind the kernel and caches results per (asset, tf)
// until a new candle closes, so panels/agent hit the cache instead of recomputing.

import type { AnalysisResult, Timeframe } from '../types'
import type { KernelContext, Plugin } from '../kernel'
import type { MarketDataService } from './market-data'
import { analyze } from '../analytics/engine'
import { backtest, type BacktestOptions } from '../strategies/backtest'
import { STRATEGIES, getStrategy, defaultParams } from '../strategies/builtin'
import { evalWithEdge } from '../analytics/edge'
import { leadersFor } from '../analytics/leadlag'
import { legsForCross, orientCandles } from '../analytics/triangulation'

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
    // Task 59 (P1): closedOnly - the /analysis read used to include the
    // just-opened 1-tick forming bar, so the card's markov lastState was
    // almost always the FLAT row and RSI/MACD/BB last values were 1-tick
    // samples. Backtests evaluate closed bars - live must too.
    const candles = this.market.getCandlesDeep(asset, tf, 1500, true)
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
    // Task 59 (P1): closedOnly - bots must evaluate the same closed-bar
    // series the backtests do, never the freshly-opened forming bar.
    const candles = this.market.getCandlesDeep(asset, tf, 1500, true)
    if (candles.length < 60) throw new Error('not enough candle history yet')
    const merged = { ...defaultParams(strat), ...(params ?? {}) }
    // Edge wrapper: the evaluate stays pure/level-shaped; the transition vs
    // the previous closed bar is classified here so every consumer (bots,
    // auto-trader, panels) can gate on "just became true" vs "already true".
    const ev = evalWithEdge((cs) => strat.evaluate(cs, merged, { asset }), candles, { asset })
    return { ...ev, asset, tf, strategy: strategyId, price: candles[candles.length - 1].close, barTs: candles[candles.length - 1].time }
  }

  runBacktest(asset: string, tf: Timeframe, opts: BacktestOptions) {
    // deep read: the backtest lab sees the full accumulated history (up to 2200 bars)
    // Task 59 (P1): closedOnly for the same live-parity reason as runStrategy.
    const candles = this.market.getCandlesDeep(asset, tf, 2200, true)
    if (candles.length < 300) throw new Error('not enough candle history for a meaningful backtest')
    // Lead-lag-style strategies need a SECOND series: the group leader's own
    // candles, same tf, fetched here (not inside backtest.ts, which has no
    // market access) and threaded through as leaderCandles. Only matters
    // when `asset` is actually a known follower (leadersFor returns [] for
    // everything else, including leaders themselves) - every other
    // strategy id just ignores the unused opts.leaderCandles passthrough.
    let leaderCandles: typeof candles | undefined
    let leaderCandles2: typeof candles | undefined
    if (opts.strategy === 'triangulation-arb') {
      // Triangulation's two auxiliary legs: only meaningful when `asset` is
      // itself the cross side of a known FX triangle (legsForCross finds a
      // shared "middle" currency), fetched here (not inside builtin.ts,
      // which has no market access) and pre-oriented so they multiply
      // straight into the cross's own units - evaluate() never flips them.
      // Gated on the strategy id so it never collides with the lead-lag
      // leaderCandles slot below (same field name, different meaning).
      try {
        const legs = legsForCross(asset, this.market.assets.filter((a) => a.category === 'forex').map((a) => a.ticker))
        if (legs) {
          const abRaw = this.market.getCandlesDeep(legs.legAB.ticker, tf, 2200, true)
          const bcRaw = this.market.getCandlesDeep(legs.legBC.ticker, tf, 2200, true)
          if (abRaw.length === candles.length && bcRaw.length === candles.length) {
            leaderCandles = orientCandles(abRaw, legs.legAB.invert)
            leaderCandles2 = orientCandles(bcRaw, legs.legBC.invert)
          }
        }
      } catch {
        /* triangle leg history unavailable - triangulation-arb honestly stands aside */
      }
    } else {
      // Lead-lag-style strategies need a SECOND series: the group leader's
      // own candles, same tf, fetched here (not inside backtest.ts, which
      // has no market access) and threaded through as leaderCandles. Only
      // matters when `asset` is actually a known follower (leadersFor
      // returns [] for everything else, including leaders themselves) -
      // every other strategy id just ignores the unused opts.leaderCandles
      // passthrough.
      const leaders = leadersFor(asset)
      if (leaders.length > 0) {
        try {
          const lc = this.market.getCandlesDeep(leaders[0], tf, 2200, true)
          if (lc.length >= 300) leaderCandles = lc
        } catch {
          /* leader history unavailable - the strategy honestly stands aside */
        }
      }
    }
    return backtest(candles, asset, tf, {
      ...opts,
      leaderCandles: leaderCandles ?? opts.leaderCandles,
      leaderCandles2: leaderCandles2 ?? opts.leaderCandles2,
    })
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
