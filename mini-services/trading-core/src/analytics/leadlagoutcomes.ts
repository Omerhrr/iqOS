// Lead-lag outcome tracking: the honesty loop for the lead-lag correlation
// scanner, mirroring analytics/signaloutcomes.ts's role for chart-signals
// but far simpler - lead-lag has no engine roster or CFD plan, just one
// claim per qualifying row: "the follower should move `direction` within
// a horizon set by the fitted lag". Every row that clears LeadLagScanService's
// `qualifies` gate becomes a pending record at the moment it qualifies
// (deduped per leader+asset+direction while pending - a fit that keeps
// re-qualifying bar after bar is one claim, not a new one every poll);
// resolution compares the follower's price at the horizon against its
// entry price, same win/loss/flat semantics as the option side of the
// chart-signals tracker. This is what actually answers "is this better
// than watching indicators" with numbers instead of argument - without it
// the lead-lag source is just another unverified picker.
//
// Horizon choice: the fit claims the follower echoes the leader's trigger
// move `lag` bars after it happened - by the time a row qualifies, that
// window has already mostly elapsed (the trigger is `lag` bars in the
// past). Giving the echo a further buffer of the SAME `lag` worth of bars
// (clamped to a sane range) is a deliberately generous, honest window:
// if the follower hasn't moved the predicted direction by then, the fit's
// claim for this specific instance didn't pay off.
//
// Pure module: resolveAt timestamps and prices come in via tick(), the
// plugin owns persistence (state()/load()) exactly like signaloutcomes.ts.

import type { Timeframe } from '../types'

export interface PendingLeadLagOutcome {
  id: string
  leader: string
  asset: string
  tf: Timeframe
  otc: boolean
  direction: 'call' | 'put'
  entry: number
  correlation: number
  lag: number
  triggerZ: number
  ts: number
  resolveAt: number
}

export type LeadLagOutcomeId = 'win' | 'loss' | 'flat'

export interface ResolvedLeadLagOutcome {
  id: string
  leader: string
  asset: string
  tf: Timeframe
  otc: boolean
  direction: 'call' | 'put'
  entry: number
  exit: number
  movePct: number
  outcome: LeadLagOutcomeId
  correlation: number
  lag: number
  triggerZ: number
  ts: number
  resolvedAt: number
}

export interface LeaderStats {
  leader: string
  wins: number
  losses: number
  flats: number
  winRate: number | null
  pending: number
}

export interface LeadLagStats {
  wins: number
  losses: number
  flats: number
  winRate: number | null
  pending: number
  recorded: number
  avgMovePct: number
  byLeader: LeaderStats[]
  recent: ResolvedLeadLagOutcome[]
}

const MIN_HORIZON_MS = 60_000 // never resolve faster than 1 minute - a lag-0 fit still needs SOME runway
const MAX_HORIZON_MS = 30 * 60_000 // cap the wait even for a high-lag fit on a slow timeframe
const MAX_RECENT = 200

export class LeadLagOutcomeTracker {
  private pending = new Map<string, PendingLeadLagOutcome>() // keyed by leader|asset|direction while open
  private resolved: ResolvedLeadLagOutcome[] = []
  private dirty = false

  constructor(seed: ResolvedLeadLagOutcome[] = []) {
    this.resolved = seed.slice(-2000)
  }

  get needsFlush(): boolean {
    return this.dirty
  }

  markFlushed(): void {
    this.dirty = false
  }

  state(): { resolved: ResolvedLeadLagOutcome[] } {
    return { resolved: this.resolved.slice(-2000) }
  }

  private key(leader: string, asset: string, direction: 'call' | 'put'): string {
    return `${leader}|${asset}|${direction}`
  }

  /** Record every currently-qualifying row as a pending claim. Dedup: a
   * row that keeps qualifying across polls (same leader+asset+direction)
   * is one ongoing claim, not re-recorded each poll - only a NEW
   * leader/asset/direction combination opens a fresh pending record. */
  record(
    rows: { leader: string; asset: string; tf: Timeframe; otc: boolean; direction: 'call' | 'put'; price: number; correlation: number; lag: number; triggerZ: number; tfSec: number }[],
    now: number,
  ): void {
    for (const r of rows) {
      const k = this.key(r.leader, r.asset, r.direction)
      if (this.pending.has(k)) continue // already tracking this exact claim
      const horizonMs = Math.min(MAX_HORIZON_MS, Math.max(MIN_HORIZON_MS, r.tfSec * 1000 * Math.max(1, r.lag)))
      this.pending.set(k, {
        id: `${k}|${now}`,
        leader: r.leader,
        asset: r.asset,
        tf: r.tf,
        otc: r.otc,
        direction: r.direction,
        entry: r.price,
        correlation: r.correlation,
        lag: r.lag,
        triggerZ: r.triggerZ,
        ts: now,
        resolveAt: now + horizonMs,
      })
    }
  }

  /** Clear a pending claim if its row no longer qualifies (correlation
   * broke down before the horizon) - the ORIGINAL window still resolves
   * normally via tick(); this only stops a since-dropped pair from being
   * silently kept pending forever once nothing re-qualifies it. Called
   * with the current qualifying key set each scan. */
  pruneStale(liveKeys: Set<string>, now: number, maxAgeMs = MAX_HORIZON_MS * 2): void {
    for (const [k, p] of this.pending) {
      if (!liveKeys.has(k) && now - p.ts > maxAgeMs) this.pending.delete(k)
    }
  }

  /** Sample prices for every pending claim past its horizon and resolve
   * it. Returns the newly resolved outcomes (for logging). */
  tick(now: number, getPrice: (asset: string) => number): ResolvedLeadLagOutcome[] {
    const justResolved: ResolvedLeadLagOutcome[] = []
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
      const outcome: LeadLagOutcomeId = movePct === 0 ? 'flat' : (movePct > 0) === (p.direction === 'call') ? 'win' : 'loss'
      const r: ResolvedLeadLagOutcome = {
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
        correlation: p.correlation,
        lag: p.lag,
        triggerZ: p.triggerZ,
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

  stats(tf?: Timeframe): LeadLagStats {
    const pool = tf ? this.resolved.filter((r) => r.tf === tf) : this.resolved
    const wins = pool.filter((r) => r.outcome === 'win').length
    const losses = pool.filter((r) => r.outcome === 'loss').length
    const flats = pool.filter((r) => r.outcome === 'flat').length
    const decided = wins + losses
    const avgMovePct = pool.length ? pool.reduce((s, r) => s + Math.abs(r.movePct), 0) / pool.length : 0
    const leaders = [...new Set(pool.map((r) => r.leader))]
    const byLeader: LeaderStats[] = leaders.map((leader) => {
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
