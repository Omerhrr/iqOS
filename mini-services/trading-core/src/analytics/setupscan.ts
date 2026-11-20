// IQAIR//OS - SETUP SCAN: runs the trading plan (analytics/tradingplan.ts) over every open pair and keeps the ones whose CONDITIONS are favourable right now, ranked by setup quality.
// It is not a signal. The traders (Omni / Meta) use it as their POOL: the strategy (pm, a Heikin Ashi filter, a pattern ...) is evaluated only on pairs that are in a favourable setup. After a trade the scan is
// invalidated and re-run, the pair just traded (and anything that duplicates its exposure) is left out, so the next trade comes from a different market.

import { readPlan, type PlanResult } from './tradingplan'
import { readCauseEffect, type CeCandle } from './causeeffect'
import { readHa } from './hapredict'
import { correlatedWith, type OpenLeg } from './correlation'

export interface SetupRow {
  asset: string; otc: boolean; side: 'call' | 'put'; quality: number; trend: string; stage: string; strength: number; maturity: number
  atEntry: boolean; rr: number; stop: number; target: number; price: number
  /** optional enrichment (withConfirmation): what the strategy layer says about this setup */
  pmDir?: string; pmStrength?: number; haColor?: string; haOk?: boolean; confirmed?: boolean
}

export interface ScanOptions { minQuality?: number; limit?: number; requireEntry?: boolean }

/** plan every asset, keep favourable setups, rank by quality (desc). `candles(asset)` returns closed bars on the setup timeframe. */
export function scanSetups(assets: ReadonlyArray<{ ticker: string; otc?: boolean }>, candles: (ticker: string) => CeCandle[], opts: ScanOptions = {}): { rows: SetupRow[]; scanned: number; withTrend: number } {
  const rows: SetupRow[] = []; let scanned = 0, withTrend = 0
  for (const a of assets) {
    let p: PlanResult
    try { p = readPlan(candles(a.ticker), { light: true, otc: !!a.otc }) } catch { continue }
    if (!p.ok) continue
    scanned++
    if (p.trend.dir !== 'none') withTrend++
    if (!p.setup.ready || p.setup.side === 'none') continue
    if (p.setup.quality < (opts.minQuality ?? 0)) continue
    if (opts.requireEntry && !p.setup.atEntry) continue
    rows.push({ asset: a.ticker, otc: !!a.otc, side: p.setup.side, quality: p.setup.quality, trend: p.trend.dir, stage: p.trend.stage, strength: p.trend.strength, maturity: p.trend.maturity, atEntry: p.setup.atEntry, rr: p.setup.rr, stop: p.setup.stop, target: p.setup.target, price: p.price })
  }
  rows.sort((x, y) => y.quality - x.quality)
  return { rows: opts.limit ? rows.slice(0, opts.limit) : rows, scanned, withTrend }
}

/** adds pm and the Heikin Ashi read to each setup: `confirmed` = pm points the same way as the setup AND the Heikin Ashi colour filter lets that side through. Costs a pm read per row, so use it on the shortlist. */
export function withConfirmation(rows: SetupRow[], candles: (ticker: string) => CeCandle[]): SetupRow[] {
  return rows.map((r) => {
    try {
      const c = candles(r.asset), ce = readCauseEffect(c, undefined, { otc: r.otc }), ha = readHa(c, { otc: r.otc })
      const haOk = ha.ok ? ha.allow.color[r.side] : false, pmDir = ce.ok ? ce.pm.dir : 'none'
      return { ...r, pmDir, pmStrength: ce.ok ? ce.pm.confidence : 0, haColor: ha.ok ? ha.ha.color : 'n/a', haOk, confirmed: pmDir === r.side && haOk }
    } catch { return r }
  })
}

/** drop setups that duplicate an open position's exposure or are the pair itself, so the next pick is a different market */
export function excludeHeld(rows: SetupRow[], open: readonly OpenLeg[]): SetupRow[] {
  const held = new Set(open.map((o) => o.asset))
  return rows.filter((r) => !held.has(r.asset) && !correlatedWith(r.asset, r.side, open))
}

/** a scan result that is reused for `ttlSec`, and thrown away the moment a trade is taken so the next tick rescans */
export class SetupCache {
  private at = 0
  private rows: SetupRow[] = []
  private meta = { scanned: 0, withTrend: 0 }
  invalidate(): void { this.at = 0 }
  get(nowSec: number, ttlSec: number, compute: () => { rows: SetupRow[]; scanned: number; withTrend: number }): SetupRow[] {
    if (this.at === 0 || nowSec - this.at >= ttlSec) { const r = compute(); this.rows = r.rows; this.meta = { scanned: r.scanned, withTrend: r.withTrend }; this.at = nowSec }
    return this.rows
  }
  get stats(): { scanned: number; withTrend: number; ready: number; ageKnown: boolean } { return { ...this.meta, ready: this.rows.length, ageKnown: this.at > 0 } }
}
