// Signal outcome tracking: every qualifying chart-signal read becomes a
// pending record; the plugin feeds prices on a fixed sweep and resolves the
// record when its suggested expiry elapses. This is the honesty loop for
// the Signal Panel - "the charts said call 3 minutes ago: what actually
// happened?" - aggregated into per-kind win rates and per-engine hit rates.
//
// Resolution semantics (deliberately conservative):
// - Option reads: exit vs entry at expirySec. movePct > 0 -> win, < 0 ->
//   loss, exactly 0 -> flat (excluded from win-rate denominators).
// - CFD plans: the plan outlives the read's TTL, so it resolves on first
//   TP/SL touch (SAMPLED at the sweep cadence - between-sample touches are
//   invisible, labeled sampled) within a 15-minute horizon; at the horizon
//   without a touch the outcome is 'timeout' with the move recorded, and
//   timeouts stay OUT of the TP-hit-rate denominator.
//
// Engine attribution: each directional vote is scored against the signed
// move - a renko 'call' vote hits when price actually rose. Flat moves hit
// nothing and are excluded from engine denominators too.
//
// This module is pure: prices come in via tick(), persistence is the
// plugin's job (state() / load()).

import type { ChartEngineId, ChartSignal } from './chartsignals'

export type SignalKind = 'option' | 'cfd'
export type SignalOutcome = 'win' | 'loss' | 'flat' | 'timeout'

export interface PendingOutcome {
  id: string
  kind: SignalKind
  asset: string
  otc: boolean
  direction: 'call' | 'put'
  entry: number
  expirySec: number
  ts: number
  resolveAt: number
  score: number
  strength: number
  agree: number
  total: number
  engines: { engine: ChartEngineId; dir: 1 | -1 }[]
  sl: number | null
  tp: number | null
  horizonAt: number
  samples: number[]
  maxFavPct: number
  maxAdvPct: number
}

export interface ResolvedOutcome {
  id: string
  kind: SignalKind
  asset: string
  otc: boolean
  direction: 'call' | 'put'
  entry: number
  exit: number
  expirySec: number
  ts: number
  resolvedAt: number
  movePct: number
  outcome: SignalOutcome
  /** CFD only: which level the sampled path touched first. */
  touched: 'tp' | 'sl' | null
  maxFavPct: number
  maxAdvPct: number
  score: number
  strength: number
  agree: number
  total: number
  engines: { engine: ChartEngineId; dir: 1 | -1; hit: boolean }[]
}

export interface EngineStat {
  engine: ChartEngineId
  votes: number
  hits: number
  winRate: number | null
}

export interface MarketSplit {
  wins: number
  losses: number
  winRate: number | null
}

export interface KindStats {
  recorded: number
  pending: number
  resolved: number
  wins: number
  losses: number
  flats: number
  timeouts: number
  winRate: number | null
  avgMovePct: number
  engines: EngineStat[]
  byMarket: { real: MarketSplit; otc: MarketSplit }
  recent: ResolvedOutcome[]
}

const MAX_PENDING = 200
const MAX_RESOLVED = 800
const CFD_HORIZON_SEC = 900 // a CFD plan lives 15 minutes, not the read's TTL

let seq = 0

export class SignalOutcomeTracker {
  private pending = new Map<string, PendingOutcome>()
  private resolved: ResolvedOutcome[] = []
  private recordedTotal = { option: 0, cfd: 0 }
  private dirty = false

  constructor(restored?: ResolvedOutcome[]) {
    if (restored?.length) {
      // boot restore: keep newest-last order, cap to the ring size
      this.resolved = restored.slice(-MAX_RESOLVED).map((r) => ({ ...r }))
      for (const r of this.resolved) {
        this.recordedTotal[r.kind]++
        if (r.ts > seq) seq = r.ts
      }
    }
  }

  /** Record qualifying signals from one scan. Same kind+asset+direction
   * while still pending counts ONCE (the first qualification is the read
   * event; re-scans every 12s must not inflate the sample). */
  record(kind: SignalKind, signals: ChartSignal[], now: number): number {
    let added = 0
    for (const s of signals) {
      const key = `${kind}:${s.asset}:${s.direction}`
      if (this.pending.has(key)) continue
      const dir = s.direction === 'call' ? 1 : -1
      const cfd = kind === 'cfd' && s.cfd ? { sl: s.cfd.sl, tp: s.cfd.tp } : null
      const pending: PendingOutcome = {
        id: `sig-${now}-${++seq}`,
        kind,
        asset: s.asset,
        otc: s.otc,
        direction: s.direction,
        entry: s.price,
        expirySec: s.expirySec,
        ts: s.ts,
        resolveAt: s.ts + s.expirySec * 1000,
        score: s.score,
        strength: s.strength,
        agree: s.agree,
        total: s.total,
        engines: s.votes
          .filter((v) => v.dir !== 0)
          .map((v) => ({ engine: v.engine, dir: v.dir as 1 | -1 })),
        sl: cfd?.sl ?? null,
        tp: cfd?.tp ?? null,
        horizonAt: s.ts + (kind === 'cfd' ? CFD_HORIZON_SEC : s.expirySec) * 1000,
        samples: [],
        maxFavPct: 0,
        maxAdvPct: 0,
      }
      this.pending.set(key, pending)
      this.recordedTotal[kind]++
      added++
    }
    // bound: drop oldest pending when the map overflows (pathological only)
    while (this.pending.size > MAX_PENDING) {
      const oldest = [...this.pending.values()].sort((a, b) => a.resolveAt - b.resolveAt)[0]
      this.pending.delete(`${oldest.kind}:${oldest.asset}:${oldest.direction}`)
    }
    if (added > 0) this.dirty = true
    return added
  }

  /** Sweep: sample every pending record at the current price, resolve the
   * matured ones. `priceOf` returning 0 (unknown) skips that record. */
  tick(now: number, priceOf: (asset: string) => number): ResolvedOutcome[] {
    const out: ResolvedOutcome[] = []
    for (const [key, p] of this.pending) {
      const price = priceOf(p.asset)
      if (price > 0) {
        const dir = p.direction === 'call' ? 1 : -1
        const movePct = ((price - p.entry) / Math.max(p.entry, 1e-12)) * 100 * dir
        if (movePct > p.maxFavPct) p.maxFavPct = movePct
        if (movePct < p.maxAdvPct) p.maxAdvPct = movePct
        p.samples.push(price)
        // CFD first-touch check (sampled): only meaningful with levels
        if (p.kind === 'cfd' && p.tp !== null && p.sl !== null) {
          const hitTp = p.direction === 'call' ? price >= p.tp : price <= p.tp
          const hitSl = p.direction === 'call' ? price <= p.sl : price >= p.sl
          if (hitTp || hitSl) {
            out.push(this.resolve(p, price, now, hitTp ? 'tp' : 'sl', movePct))
            this.pending.delete(key)
            continue
          }
        }
      }
      if (now >= p.resolveAt) {
        const price2 = price > 0 ? price : 0
        const movePct = price2 > 0 ? ((price2 - p.entry) / Math.max(p.entry, 1e-12)) * 100 * (p.direction === 'call' ? 1 : -1) : 0
        // option kind resolves here; cfd without a touch keeps pending
        // until its horizon (the plan is still live)
        if (p.kind === 'option' || now >= p.horizonAt) {
          // cfd horizon without a touch = 'timeout' regardless of the
          // drift sign - an untouched plan is unresolved, not a win
          const outcome: SignalOutcome = p.kind === 'cfd' ? 'timeout' : price2 <= 0 ? 'flat' : movePct > 0 ? 'win' : movePct < 0 ? 'loss' : 'flat'
          out.push(this.resolve(p, price2, now, null, movePct, outcome))
          this.pending.delete(key)
        }
      }
    }
    return out
  }

  private resolve(p: PendingOutcome, exit: number, now: number, touched: 'tp' | 'sl' | null, movePct: number, forced?: SignalOutcome): ResolvedOutcome {
    const outcome: SignalOutcome =
      forced ?? (movePct > 0 ? 'win' : movePct < 0 ? 'loss' : 'flat')
    // engine votes are RAW market directions - attribute against the raw
    // move sign, not the direction-adjusted one (a winning put's renko
    // 'put' vote must hit, a losing call's heikin counter-vote must miss)
    const rawSign = movePct * (p.direction === 'call' ? 1 : -1)
    const r: ResolvedOutcome = {
      id: p.id,
      kind: p.kind,
      asset: p.asset,
      otc: p.otc,
      direction: p.direction,
      entry: p.entry,
      exit,
      expirySec: p.expirySec,
      ts: p.ts,
      resolvedAt: now,
      movePct: Math.round(movePct * 1000) / 1000,
      outcome,
      touched,
      maxFavPct: Math.round(p.maxFavPct * 1000) / 1000,
      maxAdvPct: Math.round(p.maxAdvPct * 1000) / 1000,
      score: p.score,
      strength: p.strength,
      agree: p.agree,
      total: p.total,
      engines: p.engines.map((e) => ({
        ...e,
        hit: rawSign > 0 ? e.dir === 1 : rawSign < 0 ? e.dir === -1 : false,
      })),
    }
    this.resolved.push(r)
    if (this.resolved.length > MAX_RESOLVED) this.resolved.splice(0, this.resolved.length - MAX_RESOLVED)
    this.dirty = true
    return r
  }

  /** Aggregate per-kind stats for the panel's hit-rate view. */
  stats(): { option: KindStats; cfd: KindStats } {
    return { option: this.kindStats('option'), cfd: this.kindStats('cfd') }
  }

  private kindStats(kind: SignalKind): KindStats {
    const rows = this.resolved.filter((r) => r.kind === kind)
    const wins = rows.filter((r) => r.outcome === 'win').length
    const losses = rows.filter((r) => r.outcome === 'loss').length
    const flats = rows.filter((r) => r.outcome === 'flat').length
    const timeouts = rows.filter((r) => r.outcome === 'timeout').length
    const decided = wins + losses
    const moves = rows.filter((r) => r.movePct !== 0).map((r) => r.movePct)
    const engines = new Map<ChartEngineId, { votes: number; hits: number }>()
    for (const r of rows) {
      // a flat move hit nothing and missed nothing - engine votes on it
      // stay out of the per-engine denominators (same rule as the headline)
      if (r.movePct === 0) continue
      for (const e of r.engines) {
        const st = engines.get(e.engine) ?? { votes: 0, hits: 0 }
        st.votes++
        if (e.hit) st.hits++
        engines.set(e.engine, st)
      }
    }
    const split = (otc: boolean): MarketSplit => {
      const sub = rows.filter((r) => r.otc === otc && (r.outcome === 'win' || r.outcome === 'loss'))
      const w = sub.filter((r) => r.outcome === 'win').length
      return { wins: w, losses: sub.length - w, winRate: sub.length ? Math.round((w / sub.length) * 1000) / 10 : null }
    }
    return {
      recorded: this.recordedTotal[kind],
      pending: [...this.pending.values()].filter((p) => p.kind === kind).length,
      resolved: rows.length,
      wins,
      losses,
      flats,
      timeouts,
      winRate: decided ? Math.round((wins / decided) * 1000) / 10 : null,
      avgMovePct: moves.length ? Math.round((moves.reduce((s, m) => s + m, 0) / moves.length) * 1000) / 1000 : 0,
      engines: [...engines.entries()]
        .map(([engine, st]) => ({ engine, votes: st.votes, hits: st.hits, winRate: st.votes ? Math.round((st.hits / st.votes) * 1000) / 10 : null }))
        .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1)),
      byMarket: { real: split(false), otc: split(true) },
      recent: rows.slice(-12).reverse(),
    }
  }

  state(): { resolved: ResolvedOutcome[] } {
    return { resolved: [...this.resolved] }
  }

  get needsFlush(): boolean {
    return this.dirty
  }

  markFlushed(): void {
    this.dirty = false
  }
}
