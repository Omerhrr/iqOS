// IQAIR//OS - Reversal Detection plugin
//
// Wraps analytics/reversal.ts (the "is this turning RIGHT NOW" state
// engine: calm / forming / reversing / confirmed per rung) with the same
// market-data plumbing and board shape as plugins/technical.ts - one
// `readFor(asset)` for the per-asset panel and a TTL-cached `globalScan()`
// for the whole-universe Reversal Global board.
//
// No outcome ledger on purpose (v1, same reasoning as plugins/technical.ts):
// the engine emits weighted detector votes and states, not single pWin
// predictions. The state thresholds (|net| >= 3 with a bar-0 trigger) and
// the per-detector reason list are the disclosed precision contract.

import type { KernelContext, Plugin } from '../kernel'
import { buildReversalSummary, type ReversalSummary, type ReversalState, type ReversalTfRow } from '../analytics/reversal'
import { TECH_LADDER } from '../analytics/technicals'
import { gatherLadder } from './ladderdata'
import type { MarketDataService } from './market-data'

const GLOBAL_SCAN_TTL_MS = 15_000
/** Board sort order: urgency first, matching the engine's STATE_RANK. */
const STATE_RANK: Record<ReversalState, number> = { calm: 0, forming: 1, confirmed: 2, reversing: 3 }

export interface ReversalGlobalRow {
  asset: string
  price: number
  computedTs: number
  /** true = at least one rung is live; false = everything still warming */
  ok: boolean
  note: string
  mode: 'sim' | 'live'
  /** the row's most urgent live read (null = every live rung calm) */
  best: { tf: string; state: ReversalState; direction: 'up' | 'down'; score: number } | null
  /** convenience flattening of best for the board's sort/chips */
  state: ReversalState
  direction: 'up' | 'down' | 'none'
  score: number
  /** mini strip, ladder order: one cell per rung */
  cells: { tf: string; ok: boolean; state: ReversalState; direction: string; score: number }[]
}

export interface ReversalGlobalResult {
  scannedTs: number
  universe: number
  scanned: number
  live: number
  warming: number
  refreshed: number
  rows: ReversalGlobalRow[]
}

export class ReversalService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private scanRows = new Map<string, { row: ReversalGlobalRow; computedTs: number }>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('reversal', `reversal detection online (${TECH_LADDER.length}-rung ladder, 7 fail-closed detectors)`)
  }

  stop(): void { /* stateless reads - nothing to flush */ }

  /** Full per-timeframe reversal read for one asset. Returns null for a
   * ticker outside the universe - clean fail-closed, never a fake calm. */
  readFor(asset: string): ReversalSummary | null {
    const data = gatherLadder(this.market, asset, this.ctx)
    if (!data) return null
    return buildReversalSummary({ asset, ...data })
  }

  /** Single-pair board row - the same TTL cache globalScan() reads. */
  rowFor(asset: string, priceHint: number, opts: { refresh?: boolean } = {}): ReversalGlobalRow {
    const cached = this.scanRows.get(asset)
    if (!opts.refresh && cached && Date.now() - cached.computedTs < GLOBAL_SCAN_TTL_MS) return cached.row
    const data = gatherLadder(this.market, asset, this.ctx)
    if (!data) {
      this.scanRows.delete(asset)
      return {
        asset, price: priceHint, computedTs: 0, ok: false,
        note: 'not in the tracked universe', mode: this.market.mode,
        best: null, state: 'calm', direction: 'none', score: 0,
        cells: TECH_LADDER.map((r) => ({ tf: r.tf, ok: false, state: 'calm' as const, direction: 'none', score: 0 })),
      }
    }
    const sum = buildReversalSummary({ asset, ...data })
    const liveRows = sum.rows.filter((r) => r.ok)
    const row: ReversalGlobalRow = {
      asset,
      price: sum.price,
      computedTs: Date.now(),
      ok: liveRows.length > 0,
      note: sum.note,
      mode: sum.mode,
      best: sum.best,
      state: sum.best?.state ?? 'calm',
      direction: sum.best?.direction ?? 'none',
      score: sum.best?.score ?? 0,
      cells: sum.rows.map((r) => ({ tf: r.tf, ok: r.ok, state: r.state, direction: r.direction, score: r.score })),
    }
    this.scanRows.set(asset, { row, computedTs: row.computedTs })
    if (this.scanRows.size > 400) {
      const stale = [...this.scanRows.entries()].sort((a, b) => a[1].computedTs - b[1].computedTs).slice(0, 100)
      for (const [k] of stale) this.scanRows.delete(k)
    }
    return row
  }

  globalScan(opts: { limit?: number; category?: string; refresh?: boolean } = {}): ReversalGlobalResult {
    const category = opts.category && opts.category !== 'all' ? opts.category : null
    const universe = this.market.listAssets().filter((a) => a.open && (!category || a.category === category))
    const limit = opts.limit !== undefined ? Math.max(1, Math.min(Math.round(opts.limit), 500)) : universe.length
    const picked = universe.slice(0, limit)

    let refreshed = 0
    const rows: ReversalGlobalRow[] = []
    for (const a of picked) {
      const before = this.scanRows.get(a.ticker)?.computedTs ?? 0
      const row = this.rowFor(a.ticker, a.price ?? 0, { refresh: opts.refresh === true })
      if (row.computedTs !== 0 && row.computedTs !== before) refreshed++
      rows.push(row)
    }

    // urgency sort: reversing > confirmed > forming > calm, then |score|;
    // warming rows last (alphabetical, same contract as every board here)
    const live = rows.filter((r) => r.ok)
    live.sort((x, y) =>
      STATE_RANK[y.state] - STATE_RANK[x.state] ||
      Math.abs(y.score) - Math.abs(x.score) ||
      x.asset.localeCompare(y.asset))
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

export const reversalPlugin: Plugin = {
  name: 'reversal',
  start: async (ctx) => {
    const svc = new ReversalService()
    ctx.provide('reversal', svc)
    await svc.start(ctx)
  },
}
