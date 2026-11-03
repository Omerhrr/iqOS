// SMC outcome tracking: the honesty loop for the Smart Money Concepts
// scanner (analytics/smc.ts / plugins/smcscan.ts), mirroring
// leadlagoutcomes.ts's role for the lead-lag scanner - same shape, much
// simpler claim surface: one claim per asset+tf+direction, straight off
// SmcScanResult.summary (direction/confidence), not per individual
// FVG/OB/BOS/etc. signal. Summary-level is the honest granularity here:
// summary.direction is already smcSummaryScore()'s own digest across every
// active signal, and that digest is exactly what nextcandle.ts's driver
// #10 actually fuses - tracking the digest's own hit rate is what tells us
// whether THAT number is worth its current (deliberately low, guessed)
// weight, which is the whole point of building this.
//
// Why this exists: smc.ts's own header says "nothing here has been
// outcome-tracked yet" and nextcandle.ts's SMC driver comment calls its
// starting weight "unvalidated... see analytics/smc.ts". This tracker is
// what lets that weight stop being a guess - same "validate before wire"
// discipline this session has followed for every other source
// (lead-lag/chart-signals/cointegration/vol-arb), applied retroactively
// to the one driver that got wired ahead of validation per direct
// instruction.
//
// Horizon: unlike lead-lag (which has a fitted `lag` to size the window),
// SMC's claim is "structure keeps leaning this way over the next handful
// of bars on THIS tf" - no fitted parameter to borrow, so the horizon is a
// flat multiple of the bar itself (same idea as lead-lag's own
// MIN/MAX_HORIZON_MS clamp, just without a `lag` input to scale from).
//
// Pure module: resolveAt timestamps and prices come in via tick(), the
// plugin owns persistence (state()/load()) and the record/prune/tick
// cadence, exactly like leadlagoutcomes.ts.

import type { Timeframe } from '../types'

export interface PendingSmcOutcome {
  id: string
  asset: string
  tf: Timeframe
  direction: 'call' | 'put'
  entry: number
  confidence: number
  trend: 'bullish' | 'bearish' | 'range'
  bullish: number
  bearish: number
  ts: number
  resolveAt: number
}

export type SmcOutcomeId = 'win' | 'loss' | 'flat'

export interface ResolvedSmcOutcome {
  id: string
  asset: string
  tf: Timeframe
  direction: 'call' | 'put'
  entry: number
  exit: number
  movePct: number
  outcome: SmcOutcomeId
  confidence: number
  trend: 'bullish' | 'bearish' | 'range'
  bullish: number
  bearish: number
  ts: number
  resolvedAt: number
}

export interface SmcAssetStats {
  asset: string
  wins: number
  losses: number
  flats: number
  winRate: number | null
  pending: number
}

export interface SmcOutcomeStats {
  wins: number
  losses: number
  flats: number
  winRate: number | null
  pending: number
  recorded: number
  avgMovePct: number
  /** winRate broken out by confidence bucket - the question that actually
   * decides whether the driver's weight should scale with confidence the
   * way most of the other 9 drivers' votes already do. */
  byConfidence: { bucket: string; wins: number; losses: number; flats: number; winRate: number | null }[]
  byAsset: SmcAssetStats[]
  recent: ResolvedSmcOutcome[]
}

const HORIZON_BARS = 6 // flat multiple of the bar itself - see module header
const MIN_HORIZON_MS = 60_000
const MAX_HORIZON_MS = 30 * 60_000
const MAX_RECENT = 200
const MIN_CONFIDENCE = 55 // below this the summary itself is barely leaning - not worth a claim

function confidenceBucket(confidence: number): string {
  if (confidence >= 80) return '80-100'
  if (confidence >= 65) return '65-79'
  return '55-64'
}

export class SmcOutcomeTracker {
  private pending = new Map<string, PendingSmcOutcome>() // keyed by asset|tf|direction while open
  private resolved: ResolvedSmcOutcome[] = []
  private dirty = false

  constructor(seed: ResolvedSmcOutcome[] = []) {
    this.resolved = seed.slice(-2000)
  }

  get needsFlush(): boolean {
    return this.dirty
  }

  markFlushed(): void {
    this.dirty = false
  }

  state(): { resolved: ResolvedSmcOutcome[] } {
    return { resolved: this.resolved.slice(-2000) }
  }

  private key(asset: string, tf: Timeframe, direction: 'call' | 'put'): string {
    return `${asset}|${tf}|${direction}`
  }

  /** Record the current summary as a pending claim, if it clears
   * MIN_CONFIDENCE and isn't already an open claim for this asset+tf+
   * direction (a summary that keeps reading the same way poll after poll
   * is one ongoing claim, not a new one every scan). */
  record(row: { asset: string; tf: Timeframe; tfSec: number; price: number; direction: 'call' | 'put'; confidence: number; trend: 'bullish' | 'bearish' | 'range'; bullish: number; bearish: number }, now: number): void {
    if (row.confidence < MIN_CONFIDENCE || !(row.price > 0)) return
    const k = this.key(row.asset, row.tf, row.direction)
    if (this.pending.has(k)) return
    const horizonMs = Math.min(MAX_HORIZON_MS, Math.max(MIN_HORIZON_MS, row.tfSec * 1000 * HORIZON_BARS))
    this.pending.set(k, {
      id: `${k}|${now}`,
      asset: row.asset,
      tf: row.tf,
      direction: row.direction,
      entry: row.price,
      confidence: row.confidence,
      trend: row.trend,
      bullish: row.bullish,
      bearish: row.bearish,
      ts: now,
      resolveAt: now + horizonMs,
    })
  }

  /** Clear a pending claim if the summary has since flipped away from the
   * direction it claimed, before the horizon - same spirit as
   * leadlagoutcomes.ts's pruneStale: a claim whose premise broke down
   * shouldn't silently sit pending forever once nothing re-qualifies it.
   * `liveKeys` is the current asset|tf|direction set still reading
   * confidently in that direction. */
  pruneStale(liveKeys: Set<string>, now: number, maxAgeMs = MAX_HORIZON_MS * 2): void {
    for (const [k, p] of this.pending) {
      if (!liveKeys.has(k) && now - p.ts > maxAgeMs) this.pending.delete(k)
    }
  }

  /** Sample prices for every pending claim past its horizon and resolve
   * it. Returns the newly resolved outcomes (for logging). */
  tick(now: number, getPrice: (asset: string) => number): ResolvedSmcOutcome[] {
    const justResolved: ResolvedSmcOutcome[] = []
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
      const outcome: SmcOutcomeId = movePct === 0 ? 'flat' : (movePct > 0) === (p.direction === 'call') ? 'win' : 'loss'
      const r: ResolvedSmcOutcome = {
        id: p.id,
        asset: p.asset,
        tf: p.tf,
        direction: p.direction,
        entry: p.entry,
        exit,
        movePct,
        outcome,
        confidence: p.confidence,
        trend: p.trend,
        bullish: p.bullish,
        bearish: p.bearish,
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

  stats(tf?: Timeframe): SmcOutcomeStats {
    const pool = tf ? this.resolved.filter((r) => r.tf === tf) : this.resolved
    const wins = pool.filter((r) => r.outcome === 'win').length
    const losses = pool.filter((r) => r.outcome === 'loss').length
    const flats = pool.filter((r) => r.outcome === 'flat').length
    const decided = wins + losses
    const avgMovePct = pool.length ? pool.reduce((s, r) => s + Math.abs(r.movePct), 0) / pool.length : 0

    const buckets = ['55-64', '65-79', '80-100']
    const byConfidence = buckets.map((bucket) => {
      const sub = pool.filter((r) => confidenceBucket(r.confidence) === bucket)
      const w = sub.filter((r) => r.outcome === 'win').length
      const l = sub.filter((r) => r.outcome === 'loss').length
      const f = sub.filter((r) => r.outcome === 'flat').length
      const dec = w + l
      return { bucket, wins: w, losses: l, flats: f, winRate: dec > 0 ? Math.round((w / dec) * 100) : null }
    })

    const assets = [...new Set(pool.map((r) => r.asset))]
    const byAsset: SmcAssetStats[] = assets.map((asset) => {
      const sub = pool.filter((r) => r.asset === asset)
      const w = sub.filter((r) => r.outcome === 'win').length
      const l = sub.filter((r) => r.outcome === 'loss').length
      const f = sub.filter((r) => r.outcome === 'flat').length
      const dec = w + l
      return { asset, wins: w, losses: l, flats: f, winRate: dec > 0 ? Math.round((w / dec) * 100) : null, pending: 0 }
    })
    const pendingByAsset = new Map<string, number>()
    for (const p of this.pending.values()) {
      if (tf && p.tf !== tf) continue
      pendingByAsset.set(p.asset, (pendingByAsset.get(p.asset) ?? 0) + 1)
    }
    for (const ba of byAsset) ba.pending = pendingByAsset.get(ba.asset) ?? 0
    for (const [asset, n] of pendingByAsset) {
      if (!byAsset.some((ba) => ba.asset === asset)) byAsset.push({ asset, wins: 0, losses: 0, flats: 0, winRate: null, pending: n })
    }

    return {
      wins,
      losses,
      flats,
      winRate: decided > 0 ? Math.round((wins / decided) * 100) : null,
      pending: [...this.pending.values()].filter((p) => !tf || p.tf === tf).length,
      recorded: pool.length,
      avgMovePct,
      byConfidence,
      byAsset: byAsset.sort((a, b) => b.wins + b.losses + b.pending - (a.wins + a.losses + a.pending)),
      recent: pool.slice(-MAX_RECENT).reverse(),
    }
  }
}
