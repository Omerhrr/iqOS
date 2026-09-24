// IQAIR//OS - Adaptive confidence gate
//
// There is no strategy with a genuine ~100% win rate - a payout that isn't
// mispriced already assumes nobody has that edge. What DOES move a real win
// rate up in a durable way is trading less often and only in the exact
// conditions where a strategy's OWN realized record - not its backtest, not
// its average, but THIS asset/timeframe/side/score-bucket/regime - has
// actually held up. That's what this gate does: it doesn't predict, it
// looks up. It reads the bot's own settled trade journal (positions table),
// buckets it the same way a trade about to be placed would be bucketed, and
// only lets the trade through when that exact bucket has enough history and
// that history clears a win-rate floor with statistical confidence (Wilson
// lower bound, not the raw ratio - a 4/5 bucket is NOT "80% proven").
//
// Cold-start is handled honestly: a bucket with too few settlements hasn't
// been judged yet, so it's ALLOWED through (this trade is how the bucket
// gets built) rather than block forever. Only a bucket with enough evidence
// of being weak gets refused. This means a brand-new bot/asset/strategy
// combo trades close to normal at first and tightens up as its own history
// accumulates - the opposite of curve-fitting a backtest, since it can only
// act on trades THIS bot actually took.

import type { Plugin, KernelContext } from '../kernel'
import type { Store } from '../store'

export interface AdaptiveConfig {
  enabled: boolean // fleet default - a bot's own `adaptive` flag can still opt out
  minSampleSize: number // settlements needed in a bucket before its record is trusted either way
  minWinRateFloorPct: number // Wilson-lower-bound win rate a bucket must clear to keep firing
  scoreBucketWidth: number // |entryScore| granularity (e.g. 10 = scores 70-79.9 share a bucket)
  splitByRegime: boolean // bucket by entryRegime too (thinner buckets, sharper judgment) vs pooled across regimes
}

export const DEFAULT_ADAPTIVE: AdaptiveConfig = {
  enabled: true,
  minSampleSize: 25,
  minWinRateFloorPct: 62,
  scoreBucketWidth: 10,
  splitByRegime: true,
}

export interface AdaptiveVerdict {
  ok: boolean
  reason?: string
  trades: number
  wins: number
  winRatePct: number
  wilsonLowerPct: number
  bucket: string
}

/** Wilson score interval lower bound at ~95% confidence - the honest "how
 * good do I actually know this to be" number. A 4/5 raw win rate (80%) with
 * n=5 has a Wilson lower bound around 38%: barely more informative than a
 * coin flip. It takes real sample size for the lower bound to approach the
 * raw win rate, which is exactly the point - small samples can't buy a pass. */
function wilsonLowerBound(wins: number, n: number, z = 1.96): number {
  if (n <= 0) return 0
  const p = wins / n
  const denom = 1 + (z * z) / n
  const center = p + (z * z) / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return Math.max(0, ((center - margin) / denom) * 100)
}

export class AdaptiveService {
  private ctx!: KernelContext
  private store!: Store
  config: AdaptiveConfig = { ...DEFAULT_ADAPTIVE }

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.store = ctx.use<Store>('store')
    const saved = this.store.getAdaptiveConfig()
    if (saved) this.config = { ...DEFAULT_ADAPTIVE, ...(saved as Partial<AdaptiveConfig>) }
    ctx.log('adaptive', `confidence gate online - floor ${this.config.minWinRateFloorPct}% (Wilson lower bound, n>=${this.config.minSampleSize})`)
  }

  stop(): void {}

  configure(patch: Partial<AdaptiveConfig>): AdaptiveConfig {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v))))
    const next = { ...this.config, ...patch }
    next.minSampleSize = clamp(next.minSampleSize, 5, 500)
    next.minWinRateFloorPct = clamp(next.minWinRateFloorPct, 1, 99)
    next.scoreBucketWidth = clamp(next.scoreBucketWidth, 1, 50)
    next.enabled = Boolean(next.enabled)
    next.splitByRegime = Boolean(next.splitByRegime)
    this.config = next
    this.store.saveAdaptiveConfig(this.config)
    this.ctx.bus.emit('alert', {
      level: 'info',
      message: `Adaptive gate updated: floor ${next.minWinRateFloorPct}% · min n ${next.minSampleSize} · bucket width ${next.scoreBucketWidth}${next.splitByRegime ? ' · split by regime' : ' · pooled across regimes'}${next.enabled ? '' : ' · FLEET DEFAULT OFF'}`,
      ts: Math.floor(Date.now() / 1000),
    })
    return this.config
  }

  /** Look up this exact bucket's realized record and judge it. Does NOT
   * place or record trades - it only reads the journal that execution
   * already writes on every settle, so there's nothing extra to wire up
   * per-trade; the very trade being gated becomes part of the bucket once it
   * settles. */
  check(asset: string, tf: string, strategyId: string, side: string, score: number, regime?: string): AdaptiveVerdict {
    const width = this.config.scoreBucketWidth
    const floor = Math.floor(Math.abs(score) / width) * width
    const useRegime = this.config.splitByRegime ? regime : undefined
    const stats = this.store.adaptiveBucketStats(asset, tf, strategyId, side, floor, width, useRegime)
    const winRatePct = stats.trades ? Math.round((stats.wins / stats.trades) * 1000) / 10 : 0
    const wilsonLowerPct = Math.round(wilsonLowerBound(stats.wins, stats.trades) * 10) / 10
    const bucket = `${asset} ${tf} ${strategyId} ${side} score[${floor}-${floor + width}) ${useRegime ?? 'any-regime'}`

    if (stats.trades < this.config.minSampleSize) {
      // not enough evidence to judge this exact setup yet - let it trade so
      // the bucket has something to be judged ON. This is the ONE place the
      // gate is deliberately permissive.
      return { ok: true, trades: stats.trades, wins: stats.wins, winRatePct, wilsonLowerPct, bucket }
    }
    if (wilsonLowerPct >= this.config.minWinRateFloorPct) {
      return { ok: true, trades: stats.trades, wins: stats.wins, winRatePct, wilsonLowerPct, bucket }
    }
    return {
      ok: false,
      reason: `adaptive: "${bucket}" has ${stats.trades} settled trades at ${winRatePct}% win rate (95% floor ${wilsonLowerPct}%) - below the ${this.config.minWinRateFloorPct}% bar, standing aside`,
      trades: stats.trades,
      wins: stats.wins,
      winRatePct,
      wilsonLowerPct,
      bucket,
    }
  }

  status(): Record<string, unknown> {
    return { config: this.config }
  }
}

let activeAdaptive: AdaptiveService | null = null

export const adaptivePlugin: Plugin = {
  name: 'adaptive',
  start: async (ctx) => {
    const svc = new AdaptiveService()
    activeAdaptive = svc
    ctx.provide('adaptive', svc)
    await svc.start(ctx)
  },
  stop: () => {
    activeAdaptive?.stop()
    activeAdaptive = null
  },
}
