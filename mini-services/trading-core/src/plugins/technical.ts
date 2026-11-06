// IQAIR//OS - Technical Summary plugin
//
// Wraps analytics/technicals.ts (the investing.com-style per-timeframe
// oscillator + moving-average verdict engine) with the market-data plumbing:
// one `summaryFor(asset)` for the per-asset panel and a TTL-cached
// `globalScan()` for the whole-universe Technical Global board.
//
// No outcome ledger on purpose (v1): the engine emits VOTE COUNTS and score
// thresholds, not single actionable predictions with a pWin - there is no
// one number here whose win/loss would be honest to track per poll. The
// precision levers are the disclosed thresholds (±0.15 / ±0.5), the per-rung
// vote tallies, and the fail-closed warm gates; an honesty loop for the
// rung verdicts is a deliberate follow-up, not an oversight.

import type { KernelContext, Plugin } from '../kernel'
import {
  buildTechnicalSummary, TECH_LADDER, type TechTfRow, type TechVerdict, type TechnicalSummary,
} from '../analytics/technicals'
import { gatherLadder } from './ladderdata'
import type { MarketDataService } from './market-data'

/** Board scan TTL - one full technical read is a handful of indicator passes
 * over <= 260-bar series (single-digit ms), so N panels polling cost one
 * recompute per pair per TTL, never per poll. */
const GLOBAL_SCAN_TTL_MS = 15_000

export interface TechnicalGlobalRow {
  asset: string
  price: number
  /** when this row's read was computed (0 = never, warming up) */
  computedTs: number
  /** true = at least one rung is live; false = everything still warming */
  ok: boolean
  note: string
  mode: 'sim' | 'live'
  overall: TechVerdict
  direction: 'call' | 'put' | 'none'
  /** mini strip, ladder order: one cell per rung */
  cells: { tf: string; ok: boolean; label: TechVerdict['label']; score: number }[]
  /** the rung with the strongest conviction right now (null = none live) */
  strongest: { tf: string; label: TechVerdict['label']; score: number } | null
}

export interface TechnicalGlobalResult {
  scannedTs: number
  universe: number
  scanned: number
  live: number
  warming: number
  /** refresh=1 forced every row's recompute, not just stale ones */
  refreshed: number
  rows: TechnicalGlobalRow[]
}

export class TechnicalService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private scanRows = new Map<string, { row: TechnicalGlobalRow; computedTs: number }>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('technical', `technical summary online (${TECH_LADDER.length}-rung ladder, oscillator+MA vote panels)`)
  }

  stop(): void { /* stateless reads - nothing to flush */ }

  /** Full per-timeframe technical summary for one asset. Returns null for a
   * ticker outside the universe - the route reports that as a clean
   * fail-closed, never as a fake neutral read. */
  summaryFor(asset: string): TechnicalSummary | null {
    const data = gatherLadder(this.market, asset)
    if (!data) return null
    return buildTechnicalSummary({ asset, ...data })
  }

  /** Single-pair board row - the same TTL cache globalScan() reads. */
  rowFor(asset: string, priceHint: number, opts: { refresh?: boolean } = {}): TechnicalGlobalRow {
    const cached = this.scanRows.get(asset)
    if (!opts.refresh && cached && Date.now() - cached.computedTs < GLOBAL_SCAN_TTL_MS) return cached.row
    const data = gatherLadder(this.market, asset)
    if (!data) {
      this.scanRows.delete(asset)
      const empty: TechTfRow[] = []
      return {
        asset, price: priceHint, computedTs: 0, ok: false,
        note: 'not in the tracked universe', mode: this.market.mode,
        overall: { label: 'NEUTRAL', score: 0, buys: 0, sells: 0, neutrals: 0, counted: 0 },
        direction: 'none',
        cells: TECH_LADDER.map((r) => ({ tf: r.tf, ok: false, label: 'NEUTRAL' as const, score: 0 })),
        strongest: null,
      }
    }
    const sum = buildTechnicalSummary({ asset, ...data })
    const liveRows = sum.rows.filter((r) => r.ok)
    const strongestRow = liveRows.length
      ? [...liveRows].sort((a, b) => Math.abs(b.summary.score) - Math.abs(a.summary.score))[0]
      : null
    const row: TechnicalGlobalRow = {
      asset,
      price: sum.price,
      computedTs: Date.now(),
      ok: liveRows.length > 0,
      note: sum.note,
      mode: sum.mode,
      overall: sum.overall,
      direction: sum.direction,
      cells: sum.rows.map((r) => ({ tf: r.tf, ok: r.ok, label: r.summary.label, score: r.summary.score })),
      strongest: strongestRow ? { tf: strongestRow.tf, label: strongestRow.summary.label, score: strongestRow.summary.score } : null,
    }
    this.scanRows.set(asset, { row, computedTs: row.computedTs })
    if (this.scanRows.size > 400) {
      // evict the stalest quarter - board entries for pairs nobody polls
      const stale = [...this.scanRows.entries()].sort((a, b) => a[1].computedTs - b[1].computedTs).slice(0, 100)
      for (const [k] of stale) this.scanRows.delete(k)
    }
    return row
  }

  globalScan(opts: { limit?: number; category?: string; refresh?: boolean } = {}): TechnicalGlobalResult {
    // NO silent truncation (same contract as every global board in this OS):
    // `limit` is a hard SAFETY CEILING only - when the caller omits it, the
    // WHOLE open universe is scanned.
    const category = opts.category && opts.category !== 'all' ? opts.category : null
    const universe = this.market.listAssets().filter((a) => a.open && (!category || a.category === category))
    const limit = opts.limit !== undefined ? Math.max(1, Math.min(Math.round(opts.limit), 500)) : universe.length
    const picked = universe.slice(0, limit)

    let refreshed = 0
    const rows: TechnicalGlobalRow[] = []
    for (const a of picked) {
      const before = this.scanRows.get(a.ticker)?.computedTs ?? 0
      const row = this.rowFor(a.ticker, a.price ?? 0, { refresh: opts.refresh === true })
      if (row.computedTs !== 0 && row.computedTs !== before) refreshed++
      rows.push(row)
    }

    // conviction sort: strongest overall score first (|score|, then raw
    // score so the bulls and bears interleave by strength); warming last
    const live = rows.filter((r) => r.ok)
    live.sort((x, y) => Math.abs(y.overall.score) - Math.abs(x.overall.score) || y.overall.score - x.overall.score)
    const warming = rows.filter((r) => !r.ok)
    warming.sort((a, b) => a.asset.localeCompare(b.asset))
    return {
      scannedTs: Date.now(),
      universe: universe.length,
      scanned: rows.length,
      live: live.length,
      warming: warming.length,
      refreshed,
      rows: [...live, ...warming],
    }
  }
}

export const technicalPlugin: Plugin = {
  name: 'technical',
  start: async (ctx) => {
    const svc = new TechnicalService()
    ctx.provide('technical', svc)
    await svc.start(ctx)
  },
}
