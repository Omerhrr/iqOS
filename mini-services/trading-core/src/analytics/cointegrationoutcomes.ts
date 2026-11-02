// Cointegration outcome tracking: the honesty loop for the Engle-Granger
// pairs scanner (analytics/cointegration.ts), mirroring leadlagoutcomes.ts's
// role for the lead-lag scanner - same shape, different claim. Lead-lag
// claims "the follower echoes the leader's RETURNS move"; cointegration
// claims "the SPREAD (follower - alpha - beta*leader) reverts to its own
// equilibrium" - a genuinely different statistical object, so this needs
// its own ledger rather than reusing lead-lag's (its win/loss semantics
// would be comparing unrelated claims under one roof).
//
// Horizon: the fit's own halfLifeBars IS its claim about how fast the
// spread should revert - giving it a further buffer of the SAME half-life
// worth of bars (clamped) is the same "honest, generous window" convention
// leadlagoutcomes.ts uses for lag. A spread that hasn't reverted by twice
// its own fitted half-life didn't pay off on this instance.
//
// Pure module: resolveAt timestamps and prices come in via tick(), the
// plugin owns persistence (state()/load()) exactly like leadlagoutcomes.ts.

import type { Timeframe } from '../types'

export interface PendingCointegrationOutcome {
  id: string
  leader: string
  asset: string
  tf: Timeframe
  otc: boolean
  direction: 'call' | 'put'
  entry: number
  beta: number
  r2: number
  z: number
  tStat: number
  halfLifeBars: number
  ts: number
  resolveAt: number
}

export type CointegrationOutcomeId = 'win' | 'loss' | 'flat'

export interface ResolvedCointegrationOutcome {
  id: string
  leader: string
  asset: string
  tf: Timeframe
  otc: boolean
  direction: 'call' | 'put'
  entry: number
  exit: number
  movePct: number
  outcome: CointegrationOutcomeId
  beta: number
  r2: number
  z: number
  tStat: number
  halfLifeBars: number
  ts: number
  resolvedAt: number
}

export interface CointegrationLeaderStats {
  leader: string
  wins: number
  losses: number
  flats: number
  winRate: number | null
  pending: number
}

export interface CointegrationStats {
  wins: number
  losses: number
  flats: number
  winRate: number | null
  pending: number
  recorded: number
  avgMovePct: number
  byLeader: CointegrationLeaderStats[]
  recent: ResolvedCointegrationOutcome[]
}

const MIN_HORIZON_MS = 60_000 // never resolve faster than 1 minute, same floor leadlagoutcomes.ts uses
const MAX_HORIZON_MS = 30 * 60_000 // cap even a slow-reverting fit's wait
const MAX_RECENT = 200

export class CointegrationOutcomeTracker {
  private pending = new Map<string, PendingCointegrationOutcome>() // keyed by leader|asset|direction while open
  private resolved: ResolvedCointegrationOutcome[] = []
  private dirty = false

  constructor(seed: ResolvedCointegrationOutcome[] = []) {
    this.resolved = seed.slice(-2000)
  }

  get needsFlush(): boolean {
    return this.dirty
  }

  markFlushed(): void {
    this.dirty = false
  }

  state(): { resolved: ResolvedCointegrationOutcome[] } {
    return { resolved: this.resolved.slice(-2000) }
  }

  private key(leader: string, asset: string, direction: 'call' | 'put'): string {
    return `${leader}|${asset}|${direction}`
  }

  /** Record every currently-qualifying row as a pending claim. Dedup: a row
   * that keeps qualifying across polls (same leader+asset+direction) is one
   * ongoing claim, not re-recorded each poll. */
  record(
    rows: { leader: string; asset: string; tf: Timeframe; otc: boolean; direction: 'call' | 'put'; price: number; beta: number; r2: number; z: number; tStat: number; halfLifeBars: number; tfSec: number }[],
    now: number,
  ): void {
    for (const r of rows) {
      const k = this.key(r.leader, r.asset, r.direction)
      if (this.pending.has(k)) continue
      const horizonMs = Math.min(MAX_HORIZON_MS, Math.max(MIN_HORIZON_MS, r.tfSec * 1000 * Math.max(1, r.halfLifeBars) * 2))
      this.pending.set(k, {
        id: `${k}|${now}`,
        leader: r.leader,
        asset: r.asset,
        tf: r.tf,
        otc: r.otc,
        direction: r.direction,
        entry: r.price,
        beta: r.beta,
        r2: r.r2,
        z: r.z,
        tStat: r.tStat,
        halfLifeBars: r.halfLifeBars,
        ts: now,
        resolveAt: now + horizonMs,
      })
    }
  }

  /** Drop a pending claim nobody's row re-qualified in a while - the
   * ORIGINAL window still resolves normally via tick(); this only stops a
   * since-dropped pair from lingering forever once nothing re-qualifies it. */
  pruneStale(liveKeys: Set<string>, now: number, maxAgeMs = MAX_HORIZON_MS * 2): void {
    for (const [k, p] of this.pending) {
      if (!liveKeys.has(k) && now - p.ts > maxAgeMs) this.pending.delete(k)
    }
  }

  /** Sample prices for every pending claim past its horizon and resolve it. */
  tick(now: number, getPrice: (asset: string) => number): ResolvedCointegrationOutcome[] {
    const justResolved: ResolvedCointegrationOutcome[] = []
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
      const outcome: CointegrationOutcomeId = movePct === 0 ? 'flat' : (movePct > 0) === (p.direction === 'call') ? 'win' : 'loss'
      const r: ResolvedCointegrationOutcome = {
        id: p.id,
        leader: p.leader,
        asset: p.asset,
        tf: p.tf,
        otc: p.otc,
        direction: p.direction,
        entry: p.entry,
        exit,
        movePct,
        outcome,
        beta: p.beta,
        r2: p.r2,
        z: p.z,
        tStat: p.tStat,
        halfLifeBars: p.halfLifeBars,
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

  stats(tf?: Timeframe): CointegrationStats {
    const pool = tf ? this.resolved.filter((r) => r.tf === tf) : this.resolved
    const wins = pool.filter((r) => r.outcome === 'win').length
    const losses = pool.filter((r) => r.outcome === 'loss').length
    const flats = pool.filter((r) => r.outcome === 'flat').length
    const decided = wins + losses
    const avgMovePct = pool.length ? pool.reduce((s, r) => s + Math.abs(r.movePct), 0) / pool.length : 0
    const leaders = [...new Set(pool.map((r) => r.leader))]
    const byLeader: CointegrationLeaderStats[] = leaders.map((leader) => {
      const sub = pool.filter((r) => r.leader === leader)
      const w = sub.filter((r) => r.outcome === 'win').length
      const l = sub.filter((r) => r.outcome === 'loss').length
      const f = sub.filter((r) => r.outcome === 'flat').length
      const dec = w + l
      return { leader, wins: w, losses: l, flats: f, winRate: dec > 0 ? Math.round((w / dec) * 100) : null, pending: 0 }
    })
    const pendingByLeader = new Map<string, number>()
    for (const p of this.pending.values()) {
      if (tf && p.tf !== tf) continue
      pendingByLeader.set(p.leader, (pendingByLeader.get(p.leader) ?? 0) + 1)
    }
    for (const bl of byLeader) bl.pending = pendingByLeader.get(bl.leader) ?? 0
    for (const [leader, n] of pendingByLeader) {
      if (!byLeader.some((bl) => bl.leader === leader)) byLeader.push({ leader, wins: 0, losses: 0, flats: 0, winRate: null, pending: n })
    }
    return {
      wins,
      losses,
      flats,
      winRate: decided > 0 ? Math.round((wins / decided) * 100) : null,
      pending: [...this.pending.values()].filter((p) => !tf || p.tf === tf).length,
      recorded: pool.length,
      avgMovePct,
      byLeader: byLeader.sort((a, b) => b.wins + b.losses + b.pending - (a.wins + a.losses + a.pending)),
      recent: pool.slice(-MAX_RECENT).reverse(),
    }
  }
}
