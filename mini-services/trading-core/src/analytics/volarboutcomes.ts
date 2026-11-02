// Volatility-arb outcome tracking: the honesty loop for the close-vol vs
// range-vol scanner (analytics/volarb.ts), same shape/role as
// leadlagoutcomes.ts and cointegrationoutcomes.ts for their own scanners.
// The claim here is simpler than either: no leader/follower pair, just
// "this asset's vol-ratio regime (fade when ratio is high - close moves
// are overstating the real range, a mean-reversion tell; continue when
// ratio is low - the range is moving more than closes admit, a
// continuation tell) predicts the next stretch of price action." There is
// no natural "lag" or "half-life" to size a horizon from (unlike lead-lag's
// echo delay or cointegration's spread half-life), so this ledger uses a
// flat multi-bar horizon - long enough for the regime to actually play out,
// short enough that the entry vol reading is still relevant.
//
// Pure module: resolveAt timestamps and prices come in via tick(), the
// plugin owns persistence (state()/load()) exactly like the other two.

import type { Timeframe } from '../types'

export interface PendingVolArbOutcome {
  id: string
  asset: string
  tf: Timeframe
  otc: boolean
  direction: 'call' | 'put'
  entry: number
  ratio: number
  regime: 'fade' | 'continue' | 'balanced'
  momentum: number
  ts: number
  resolveAt: number
}

export type VolArbOutcomeId = 'win' | 'loss' | 'flat'

export interface ResolvedVolArbOutcome {
  id: string
  asset: string
  tf: Timeframe
  otc: boolean
  direction: 'call' | 'put'
  entry: number
  exit: number
  movePct: number
  outcome: VolArbOutcomeId
  ratio: number
  regime: 'fade' | 'continue' | 'balanced'
  momentum: number
  ts: number
  resolvedAt: number
}

export interface VolArbRegimeStats {
  regime: 'fade' | 'continue' | 'balanced'
  wins: number
  losses: number
  flats: number
  winRate: number | null
  pending: number
}

export interface VolArbStats {
  wins: number
  losses: number
  flats: number
  winRate: number | null
  pending: number
  recorded: number
  avgMovePct: number
  byRegime: VolArbRegimeStats[]
  recent: ResolvedVolArbOutcome[]
}

// flat horizon: long enough for a vol-regime read to actually play out,
// short enough the entry reading is still the relevant one. 8 bars, same
// MIN/MAX clamp convention as the pair-based trackers.
const HORIZON_BARS = 8
const MIN_HORIZON_MS = 60_000
const MAX_HORIZON_MS = 30 * 60_000
const MAX_RECENT = 200

export class VolArbOutcomeTracker {
  private pending = new Map<string, PendingVolArbOutcome>() // keyed by asset|direction while open
  private resolved: ResolvedVolArbOutcome[] = []
  private dirty = false

  constructor(seed: ResolvedVolArbOutcome[] = []) {
    this.resolved = seed.slice(-2000)
  }

  get needsFlush(): boolean {
    return this.dirty
  }

  markFlushed(): void {
    this.dirty = false
  }

  state(): { resolved: ResolvedVolArbOutcome[] } {
    return { resolved: this.resolved.slice(-2000) }
  }

  private key(asset: string, direction: 'call' | 'put'): string {
    return `${asset}|${direction}`
  }

  /** Record every currently-directional (fade or continue, never balanced -
   * that regime has no direction to claim) row as a pending claim. Dedup:
   * same asset+direction while pending is one ongoing claim. */
  record(rows: { asset: string; tf: Timeframe; otc: boolean; direction: 'call' | 'put'; price: number; ratio: number; regime: 'fade' | 'continue' | 'balanced'; momentum: number; tfSec: number }[], now: number): void {
    for (const r of rows) {
      const k = this.key(r.asset, r.direction)
      if (this.pending.has(k)) continue
      const horizonMs = Math.min(MAX_HORIZON_MS, Math.max(MIN_HORIZON_MS, r.tfSec * 1000 * HORIZON_BARS))
      this.pending.set(k, {
        id: `${k}|${now}`,
        asset: r.asset,
        tf: r.tf,
        otc: r.otc,
        direction: r.direction,
        entry: r.price,
        ratio: r.ratio,
        regime: r.regime,
        momentum: r.momentum,
        ts: now,
        resolveAt: now + horizonMs,
      })
    }
  }

  pruneStale(liveKeys: Set<string>, now: number, maxAgeMs = MAX_HORIZON_MS * 2): void {
    for (const [k, p] of this.pending) {
      if (!liveKeys.has(k) && now - p.ts > maxAgeMs) this.pending.delete(k)
    }
  }

  tick(now: number, getPrice: (asset: string) => number): ResolvedVolArbOutcome[] {
    const justResolved: ResolvedVolArbOutcome[] = []
    for (const [k, p] of this.pending) {
      if (now < p.resolveAt) continue
      let exit: number
      try {
        exit = getPrice(p.asset)
      } catch {
        this.pending.delete(k)
        continue
      }
      if (!Number.isFinite(exit) || exit <= 0) {
        this.pending.delete(k)
        continue
      }
      const movePct = p.entry > 0 ? ((exit - p.entry) / p.entry) * 100 : 0
      const outcome: VolArbOutcomeId = movePct === 0 ? 'flat' : (movePct > 0) === (p.direction === 'call') ? 'win' : 'loss'
      const r: ResolvedVolArbOutcome = {
        id: p.id,
        asset: p.asset,
        tf: p.tf,
        otc: p.otc,
        direction: p.direction,
        entry: p.entry,
        exit,
        movePct,
        outcome,
        ratio: p.ratio,
        regime: p.regime,
        momentum: p.momentum,
        ts: p.ts,
        resolvedAt: now,
      }
      this.resolved.push(r)
      justResolved.push(r)
      this.pending.delete(k)
      this.dirty = true
    }
    if (this.resolved.length > 2000) this.resolved = this.resolved.slice(-2000)
    return justResolved
  }

  stats(tf?: Timeframe): VolArbStats {
    const pool = tf ? this.resolved.filter((r) => r.tf === tf) : this.resolved
    const wins = pool.filter((r) => r.outcome === 'win').length
    const losses = pool.filter((r) => r.outcome === 'loss').length
    const flats = pool.filter((r) => r.outcome === 'flat').length
    const decided = wins + losses
    const avgMovePct = pool.length ? pool.reduce((s, r) => s + Math.abs(r.movePct), 0) / pool.length : 0
    const regimes: VolArbRegimeStats['regime'][] = ['fade', 'continue', 'balanced']
    const byRegime: VolArbRegimeStats[] = regimes.map((regime) => {
      const sub = pool.filter((r) => r.regime === regime)
      const w = sub.filter((r) => r.outcome === 'win').length
      const l = sub.filter((r) => r.outcome === 'loss').length
      const f = sub.filter((r) => r.outcome === 'flat').length
      const dec = w + l
      const pending = [...this.pending.values()].filter((p) => p.regime === regime && (!tf || p.tf === tf)).length
      return { regime, wins: w, losses: l, flats: f, winRate: dec > 0 ? Math.round((w / dec) * 100) : null, pending }
    })
    return {
      wins,
      losses,
      flats,
      winRate: decided > 0 ? Math.round((wins / decided) * 100) : null,
      pending: [...this.pending.values()].filter((p) => !tf || p.tf === tf).length,
      recorded: pool.length,
      avgMovePct,
      byRegime,
      recent: pool.slice(-MAX_RECENT).reverse(),
    }
  }
}
