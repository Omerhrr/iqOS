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
  splitBySession: boolean // bucket by entrySession too (ASIA/LONDON/OVERLAP/NEWYORK/OFF) vs pooled across the whole day
  /** How the win-rate floor is interpreted. 'absolute' (default, the
   * original behavior) - minWinRateFloorPct is taken literally regardless
   * of what the pair pays. 'payout-aware' - the required floor is computed
   * PER TRADE from the pair's live payout: breakeven 1/(1+payout) as a %,
   * plus marginPct points of cushion. The point: a fixed 62% floor demands
   * 7 points of edge at an 82% payout (BE 54.9%) but only 1.4 at 65% (BE
   * 60.6%) - the payout-aware mode keeps the CUSHION constant as payouts
   * move, which is the quantity that actually decides expected value.
   * Trades without a known payout fall back to the absolute floor. */
  floorMode?: 'absolute' | 'payout-aware'
  /** Cushion over breakeven in 'payout-aware' mode (percentage points the
   * Wilson lower bound must clear above breakeven). Default 5. */
  marginPct?: number
}

export const DEFAULT_ADAPTIVE: AdaptiveConfig = {
  enabled: true,
  minSampleSize: 25,
  minWinRateFloorPct: 62,
  scoreBucketWidth: 10,
  splitByRegime: true,
  splitBySession: true,
  floorMode: 'absolute',
  marginPct: 5,
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
    if (saved) {
      this.config = { ...DEFAULT_ADAPTIVE, ...(saved as Partial<AdaptiveConfig>) }
      // AUDIT FIX (Task 58, P2): sanitize on restore too - a persisted NaN
      // (serialized to null by JSON) must not reach the floor math.
      for (const k of ['minSampleSize', 'minWinRateFloorPct', 'scoreBucketWidth', 'marginPct'] as const) {
        const v = Number(this.config[k])
        if (!Number.isFinite(v)) (this.config[k] as number) = DEFAULT_ADAPTIVE[k]
      }
      if (this.config.floorMode !== 'payout-aware') this.config.floorMode = 'absolute'
    }
    ctx.log('adaptive', `confidence gate online - floor ${this.config.minWinRateFloorPct}% (Wilson lower bound, n>=${this.config.minSampleSize})`)
  }

  stop(): void {}

  configure(patch: Partial<AdaptiveConfig>): AdaptiveConfig {
    // AUDIT FIX (Task 58, P2): clamp(NaN) used to store NaN - a NaN
    // marginPct/minWinRateFloorPct made the required floor NaN and every
    // wilsonLowerPct >= NaN comparison false, bricking the adaptive gate SHUT
    // fleet-wide until a restart (JSON null healed it by accident).
    // Non-finite input now falls back to the CURRENT value (fail-closed).
    const clamp = (v: unknown, lo: number, hi: number, cur: number) => {
      const n = Math.round(Number(v))
      if (!Number.isFinite(n)) return Math.min(hi, Math.max(lo, Math.round(Number(cur)) || lo))
      return Math.min(hi, Math.max(lo, n))
    }
    const next = { ...this.config, ...patch }
    next.minSampleSize = clamp(next.minSampleSize, 5, 500, this.config.minSampleSize)
    next.minWinRateFloorPct = clamp(next.minWinRateFloorPct, 1, 99, this.config.minWinRateFloorPct)
    next.scoreBucketWidth = clamp(next.scoreBucketWidth, 1, 50, this.config.scoreBucketWidth)
    next.enabled = Boolean(next.enabled)
    next.splitByRegime = Boolean(next.splitByRegime)
    next.splitBySession = Boolean(next.splitBySession)
    next.floorMode = next.floorMode === 'payout-aware' ? 'payout-aware' : 'absolute'
    next.marginPct = clamp(next.marginPct ?? 5, 0, 30, this.config.marginPct ?? 5)
    this.config = next
    this.store.saveAdaptiveConfig(this.config)
    this.ctx.bus.emit('alert', {
      level: 'info',
      message: `Adaptive gate updated: floor ${next.minWinRateFloorPct}%${next.floorMode === 'payout-aware' ? ` as payout-aware +${next.marginPct}pts over breakeven` : ' (absolute)'} · min n ${next.minSampleSize} · bucket width ${next.scoreBucketWidth}${next.splitByRegime ? ' · split by regime' : ' · pooled across regimes'}${next.splitBySession ? ' · split by session' : ' · pooled across sessions'}${next.enabled ? '' : ' · FLEET DEFAULT OFF'}`,
      ts: Math.floor(Date.now() / 1000),
    })
    return this.config
  }

  /** Look up this exact bucket's realized record and judge it. Does NOT
   * place or record trades - it only reads the journal that execution
   * already writes on every settle, so there's nothing extra to wire up
   * per-trade; the very trade being gated becomes part of the bucket once it
   * settles. `payout` (0-1 fraction, from the caller's live payoutFor read)
   * activates the payout-aware floor when floorMode is 'payout-aware';
   * undefined/unknown falls back to the absolute floor. */
  check(asset: string, tf: string, strategyId: string, side: string, score: number, regime?: string, session?: string, payout?: number): AdaptiveVerdict {
    const width = this.config.scoreBucketWidth
    const floor = Math.floor(Math.abs(score) / width) * width
    const useRegime = this.config.splitByRegime ? regime : undefined
    const useSession = this.config.splitBySession ? session : undefined
    const stats = this.store.adaptiveBucketStats(asset, tf, strategyId, side, floor, width, useRegime, useSession)
    const winRatePct = stats.trades ? Math.round((stats.wins / stats.trades) * 1000) / 10 : 0
    const wilsonLowerPct = Math.round(wilsonLowerBound(stats.wins, stats.trades) * 10) / 10
    const bucket = `${asset} ${tf} ${strategyId} ${side} score[${floor}-${floor + width}) ${useRegime ?? 'any-regime'} ${useSession ?? 'any-session'}`

    // required floor: absolute (the configured number) or payout-aware
    // (breakeven 1/(1+p) + cushion). payout in 0..1 only - anything else
    // (0 = unknown, >= 1 = nonsense) falls back to the absolute floor.
    const payoutAware =
      this.config.floorMode === 'payout-aware' && typeof payout === 'number' && payout > 0 && payout < 1
    const requiredFloor = payoutAware
      ? Math.min(99, 100 / (1 + payout) + (this.config.marginPct ?? 5))
      : this.config.minWinRateFloorPct
    const floorLabel = payoutAware
      ? `breakeven ${(100 / (1 + payout!)).toFixed(1)}% at pay ${(payout! * 100).toFixed(0)}% + ${this.config.marginPct ?? 5}pts = ${requiredFloor.toFixed(1)}%`
      : `${this.config.minWinRateFloorPct}% bar`

    if (stats.trades < this.config.minSampleSize) {
      // not enough evidence to judge this exact setup yet - let it trade so
      // the bucket has something to be judged ON. This is the ONE place the
      // gate is deliberately permissive.
      return { ok: true, trades: stats.trades, wins: stats.wins, winRatePct, wilsonLowerPct, bucket }
    }
    if (wilsonLowerPct >= requiredFloor) {
      return { ok: true, trades: stats.trades, wins: stats.wins, winRatePct, wilsonLowerPct, bucket }
    }
    return {
      ok: false,
      reason: `adaptive: "${bucket}" has ${stats.trades} settled trades at ${winRatePct}% win rate (95% floor ${wilsonLowerPct}%) - below the ${floorLabel}, standing aside`,
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
