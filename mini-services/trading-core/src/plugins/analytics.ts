// IQAIR//OS - Analytics plugin
// Wraps the analysis engine behind the kernel and caches results per (asset, tf)
// until a new candle closes, so panels/agent hit the cache instead of recomputing.

import type { AnalysisResult, Candle, Timeframe } from '../types'
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
    // Same aux-series lookup runBacktest uses (lead-lag leader / cointegration
    // leader / triangulation's two legs) - without this, those three
    // strategies always read "no leader/legs" LIVE even when the Backtest
    // Lab validates them fine, since this is the path bots + manual eval +
    // the auto-trader's single-shot checks all go through.
    const aux = this.auxCandles(asset, tf, strategyId, 1500, candles.length)
    const hints = { asset, leaderCandles: aux.leaderCandles, leaderCandles2: aux.leaderCandles2 }
    // Edge wrapper: the evaluate stays pure/level-shaped; the transition vs
    // the previous closed bar is classified here so every consumer (bots,
    // auto-trader, panels) can gate on "just became true" vs "already true".
    // NB: the edge wrapper re-evaluates on a shorter candle slice (one bar
    // dropped) but reuses these SAME aux-series hints for both passes - a
    // one-bar lookahead on the aux leg for the "previous bar" phase check
    // only, never on the traded direction itself. Acceptable: it only
    // affects entered/held/flip classification, not which way a fresh
    // signal points.
    const ev = evalWithEdge((cs) => strat.evaluate(cs, merged, hints), candles, hints)
    return { ...ev, asset, tf, strategy: strategyId, price: candles[candles.length - 1].close, barTs: candles[candles.length - 1].time }
  }

  runBacktest(asset: string, tf: Timeframe, opts: BacktestOptions) {
    // deep read: the backtest lab sees the full accumulated history (up to 2200 bars)
    // Task 59 (P1): closedOnly for the same live-parity reason as runStrategy.
    const candles = this.market.getCandlesDeep(asset, tf, 2200, true)
    if (candles.length < 300) throw new Error('not enough candle history for a meaningful backtest')
    // A custom:<id> spec's TOP-LEVEL strategy id is never 'triangulation-arb'
    // etc. itself - but its signals can EMBED one of those three as a
    // 'builtin' member (strategies/custom.ts), which needs the same aux
    // lookup one level down, keyed by that member's own strategy id.
    if (opts.strategy.startsWith('custom:')) {
      return backtest(candles, asset, tf, { ...opts, auxByStrategy: this.auxByStrategyMap(asset, tf, 2200, candles.length) })
    }
    const aux = this.auxCandles(asset, tf, opts.strategy, 2200, candles.length)
    return backtest(candles, asset, tf, {
      ...opts,
      leaderCandles: aux.leaderCandles ?? opts.leaderCandles,
      leaderCandles2: aux.leaderCandles2 ?? opts.leaderCandles2,
    })
  }

  /** Builds the full auxByStrategy map (every builtin id that needs a
   * second series, for whichever of them happen to be embedded as a
   * 'builtin' signal inside a custom spec) - see StrategyHints.auxByStrategy.
   * Exported as a plain method (not gated on which ids the spec actually
   * uses - cheap enough at 1-3 extra candle fetches, and avoids having to
   * walk the spec's signal tree here just to find out). */
  auxByStrategyMap(asset: string, tf: Timeframe, limit: number, expectedLength: number): Record<string, { leaderCandles?: Candle[]; leaderCandles2?: Candle[] }> {
    const map: Record<string, { leaderCandles?: Candle[]; leaderCandles2?: Candle[] }> = {}
    const leaders = leadersFor(asset)
    if (leaders.length > 0) {
      try {
        const lc = this.market.getCandlesDeep(leaders[0], tf, limit, true)
        if (lc.length >= Math.min(300, expectedLength)) {
          map['leadlag-echo'] = { leaderCandles: lc }
          map['cointegration-pairs'] = { leaderCandles: lc }
        }
      } catch {
        /* leader history unavailable - those two members honestly stand aside */
      }
    }
    try {
      const legs = legsForCross(asset, this.market.assets.filter((a) => a.category === 'forex').map((a) => a.ticker))
      if (legs) {
        const abRaw = this.market.getCandlesDeep(legs.legAB.ticker, tf, limit, true)
        const bcRaw = this.market.getCandlesDeep(legs.legBC.ticker, tf, limit, true)
        if (abRaw.length === expectedLength && bcRaw.length === expectedLength) {
          map['triangulation-arb'] = { leaderCandles: orientCandles(abRaw, legs.legAB.invert), leaderCandles2: orientCandles(bcRaw, legs.legBC.invert) }
        }
      }
    } catch {
      /* triangle leg history unavailable - that member honestly stands aside */
    }
    return map
  }

  // Shared by runStrategy (live single-shot eval, incl. bots + auto-trader)
  // and runBacktest (Backtest Lab): fetches whichever auxiliary candle
  // series a strategy needs beyond its own asset's history - the group
  // leader for lead-lag/cointegration-style strategies, or the two FX
  // triangle legs for triangulation-arb - gated on the strategy id so the
  // two never collide on the same leaderCandles slot. Returns {} (every
  // other strategy just ignores the unused hint) when the asset isn't a
  // known follower/triangle cross, or the aux history can't be fetched -
  // the strategy then honestly stands aside rather than guessing.
  private auxCandles(
    asset: string,
    tf: Timeframe,
    strategyId: string,
    limit: number,
    expectedLength: number
  ): { leaderCandles?: ReturnType<MarketDataService['getCandlesDeep']>; leaderCandles2?: ReturnType<MarketDataService['getCandlesDeep']> } {
    if (strategyId === 'triangulation-arb') {
      try {
        const legs = legsForCross(asset, this.market.assets.filter((a) => a.category === 'forex').map((a) => a.ticker))
        if (legs) {
          const abRaw = this.market.getCandlesDeep(legs.legAB.ticker, tf, limit, true)
          const bcRaw = this.market.getCandlesDeep(legs.legBC.ticker, tf, limit, true)
          if (abRaw.length === expectedLength && bcRaw.length === expectedLength) {
            return { leaderCandles: orientCandles(abRaw, legs.legAB.invert), leaderCandles2: orientCandles(bcRaw, legs.legBC.invert) }
          }
        }
      } catch {
        /* triangle leg history unavailable - triangulation-arb honestly stands aside */
      }
      return {}
    }
    const leaders = leadersFor(asset)
    if (leaders.length > 0) {
      try {
        const lc = this.market.getCandlesDeep(leaders[0], tf, limit, true)
        if (lc.length >= Math.min(300, expectedLength)) return { leaderCandles: lc }
      } catch {
        /* leader history unavailable - the strategy honestly stands aside */
      }
    }
    return {}
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
