// IQAIR//OS - Unified chart-type INDICATOR board.
//
// Direct instruction: "just as we have them as charts, now having them as
// indicators... I think they will be a great help to our AI trader for easy
// accessibility." Every chart type this platform already renders (candle,
// tick, footprint, OTC/velocity footprint, renko, range, tick-footprint,
// IV-HV, SMC, ICT) already has its own engine somewhere in this kernel -
// this module does NOT reimplement any of them. It is a thin, pure,
// synchronous ADAPTER that calls each engine's existing exported function
// and reduces its result to ONE consistent row shape, so any caller (AI
// Trader's own-math, a future MSL source, a future panel) can get all ten
// reads with one function call instead of hunting down ten different
// services with ten different return shapes.
//
// SMC vs ICT split: analytics/smc.ts's own module header already documents
// which of its 15 concepts are classic/generic market-structure terms
// (BOS, CHoCH, Supply&Demand, Support&Resistance, Breakout) vs specifically
// ICT-originated concepts (FVG, IFVG, Order Block, Breaker Block, Liquidity
// Sweep, OTE, KRM, CRT, Power of 3, Silver Bullet) - this reuses that exact
// split as two separate votes off the SAME one scanSmc() call, rather than
// running the (identical) scan twice.
//
// Every row is fail-closed: missing/thin input -> direction 'none',
// confidence 0, an honest note - never a guessed direction.

import type { Candle } from '../types'
import {
  engineVoteSingle, tickVote, otcFootprintVote, type ChartEngineVote, type OtcFpRead,
} from './chartsignals'
import { scanSmc, type SmcScanResult, type SmcKind } from './smc'
import { realizedUpProb } from './ivhv'
import { computeTickFootprint, type TickFootprintResult } from './tickdesk'
import type { TickPoint as FootprintTickPoint } from './tickbars'

export type ChartIndicatorId =
  | 'candle'
  | 'tick'
  | 'footprint'
  | 'otcFootprint'
  | 'renko'
  | 'range'
  | 'tickFootprint'
  | 'ivHv'
  | 'smc'
  | 'ict'

export interface ChartIndicatorRow {
  id: ChartIndicatorId
  label: string
  direction: 'call' | 'put' | 'none'
  confidence: number // 0-100
  note: string
}

/** ICT-originated concepts (per smc.ts's own module-header admission) -
 * everything else live in SmcKind is the generic/classic structure half. */
/** Exported so other callers (plugins/metastrategy.ts's 'ict'/'smc' MSL
 * sources) can reuse the exact same split instead of redefining it. */
export const ICT_KINDS: ReadonlySet<SmcKind> = new Set<SmcKind>([
  'FVG', 'IFVG', 'ORDER_BLOCK', 'BREAKER_BLOCK', 'LIQUIDITY_SWEEP', 'OTE', 'KRM', 'CRT', 'POWER_OF_3', 'SILVER_BULLET',
])
export const SMC_KINDS: ReadonlySet<SmcKind> = new Set<SmcKind>(['BOS', 'CHOCH', 'SUPPLY_DEMAND', 'SUPPORT_RESISTANCE', 'BREAKOUT'])

function fromVote(id: ChartIndicatorId, label: string, v: ChartEngineVote): ChartIndicatorRow {
  return {
    id,
    label,
    direction: v.dir > 0 ? 'call' : v.dir < 0 ? 'put' : 'none',
    confidence: Math.round(v.weight * 100),
    note: v.note,
  }
}

/** Aggregates a SmcScanResult's "right now" (barsAgo===0) signals restricted
 * to one kind-set into one vote - the same majority/tie-break math
 * smcNowRead() (smc.ts) uses for the whole-scan read, just scoped to a
 * SUBSET of kinds so SMC and ICT can be reported as two separate rows off
 * one scan instead of smcNowRead's single all-kinds verdict. */
export function voteForKindSet(result: SmcScanResult, kinds: ReadonlySet<SmcKind>, id: ChartIndicatorId, label: string): ChartIndicatorRow {
  const now = result.signals.filter((s) => s.barsAgo === 0 && kinds.has(s.kind))
  if (!now.length) return { id, label, direction: 'none', confidence: 0, note: 'no concept in this group fired this candle' }
  const bullish = now.filter((s) => s.direction === 'bullish').length
  const bearish = now.filter((s) => s.direction === 'bearish').length
  const tied = bullish === bearish
  const direction: 'call' | 'put' = tied ? (now[0].direction === 'bullish' ? 'call' : 'put') : bullish > bearish ? 'call' : 'put'
  const winners = Math.max(bullish, bearish)
  const confidence = now.length <= 1 ? 65 : Math.round((winners / now.length) * 100)
  const kindsNow = [...new Set(now.map((s) => s.kind))].join(', ')
  const tieNote = tied && now.length > 1 ? ` (tied - went with ${now[0].kind}'s first fire)` : ''
  return { id, label, direction, confidence, note: `${now.length} concept(s) now (${kindsNow}) - ${winners}/${now.length} agree ${direction}${tieNote}` }
}

function tickFootprintRow(fp: TickFootprintResult | null): ChartIndicatorRow {
  if (!fp || !fp.ok || !fp.summary.buckets) {
    return { id: 'tickFootprint', label: 'Tick footprint (real-print delta)', direction: 'none', confidence: 0, note: fp?.note ?? 'no tick-footprint read yet - tick buffer cold or too thin' }
  }
  const { netDelta, totalUp, totalDn } = fp.summary
  const total = totalUp + totalDn
  if (total === 0 || netDelta === 0) return { id: 'tickFootprint', label: 'Tick footprint (real-print delta)', direction: 'none', confidence: 0, note: `flat - ${totalUp} up / ${totalDn} dn prints` }
  const direction: 'call' | 'put' = netDelta > 0 ? 'call' : 'put'
  const confidence = Math.min(100, Math.round((Math.abs(netDelta) / total) * 200))
  return { id: 'tickFootprint', label: 'Tick footprint (real-print delta)', direction, confidence, note: `net delta ${netDelta} (${totalUp} up / ${totalDn} dn prints)${fp.summary.dominantPoc != null ? `, POC ${fp.summary.dominantPoc}` : ''}` }
}

function ivHvRow(candles: Candle[]): ChartIndicatorRow {
  if (candles.length < 10) return { id: 'ivHv', label: 'IV-HV (realized up-close vs 50%)', direction: 'none', confidence: 0, note: 'not enough closes yet' }
  const upProb = realizedUpProb(candles, Math.min(100, candles.length))
  const delta = upProb - 0.5
  if (Math.abs(delta) < 1e-9) return { id: 'ivHv', label: 'IV-HV (realized up-close vs 50%)', direction: 'none', confidence: 0, note: 'exactly 50/50 up-closes, no lean' }
  const direction: 'call' | 'put' = delta > 0 ? 'call' : 'put'
  const confidence = Math.min(100, Math.round(Math.abs(delta) * 200))
  return { id: 'ivHv', label: 'IV-HV (realized up-close vs 50%)', direction, confidence, note: `realized up-close ${(upProb * 100).toFixed(1)}%` }
}

/** All ten chart-type indicators, one call, one consistent row shape.
 * Every input is optional except candles - a caller that hasn't fetched
 * ticks/footprint/smc yet still gets the candle-only rows (candle,
 * footprint-proxy, renko, range, IV-HV), with the rest reporting an honest
 * 'none'/cold note instead of being silently absent from the array. */
export function buildChartIndicatorBoard(input: {
  candles: Candle[]
  /** real tick stream (tickbars.ts shape: {time: epoch SECONDS, price}) -
   * convert from whatever TickPoint shape the caller's collector uses. */
  realTicks?: FootprintTickPoint[] | null
  /** OTC/velocity footprint engine's result.summary, already computed by
   * the caller (plugins/otcfootprint.ts's footprint()) - reused here
   * rather than re-fetched, since it is already an async/rate-limited call. */
  otcFootprint?: { signal: 'call' | 'put' | 'none'; score: number; netDelta: number; avgSpeedRatio: number; buckets: number } | null
  /** real-tick-print footprint (analytics/tickdesk.ts's computeTickFootprint)
   * - distinct from BOTH the candle-proxy 'footprint' row and the
   * speed/velocity 'otcFootprint' row: this one is actual print-by-print
   * buy/sell volume at price, same engine the Tick Desk panel renders. */
  tickFootprint?: TickFootprintResult | null
  /** already-computed SMC/ICT scan (analytics/smc.ts's scanSmc) - reused
   * here (not re-scanned) to produce the SMC and ICT rows off one pass. */
  smc?: SmcScanResult | null
}): ChartIndicatorRow[] {
  const { candles } = input
  const rows: ChartIndicatorRow[] = []
  if (candles.length) {
    rows.push(fromVote('candle', 'Candle (body/CLV structure)', engineVoteSingle('candle', candles)))
    rows.push(fromVote('footprint', 'Footprint (candle-proxy CLV delta)', engineVoteSingle('footprint', candles)))
    rows.push(fromVote('renko', 'Renko (noise-eliminated bricks)', engineVoteSingle('renko', candles)))
    rows.push(fromVote('range', 'Range bars (noise-eliminated)', engineVoteSingle('range', candles)))
    rows.push(fromVote('tick', 'Tick (real transactions)', tickVote(candles, input.realTicks ?? null)))
    rows.push(ivHvRow(candles))
  } else {
    for (const [id, label] of [
      ['candle', 'Candle (body/CLV structure)'],
      ['footprint', 'Footprint (candle-proxy CLV delta)'],
      ['renko', 'Renko (noise-eliminated bricks)'],
      ['range', 'Range bars (noise-eliminated)'],
      ['tick', 'Tick (real transactions)'],
      ['ivHv', 'IV-HV (realized up-close vs 50%)'],
    ] as [ChartIndicatorId, string][]) {
      rows.push({ id, label, direction: 'none', confidence: 0, note: 'no candle history yet' })
    }
  }
  const otcRead: OtcFpRead | null = input.otcFootprint
    ? { signal: input.otcFootprint.signal, score: input.otcFootprint.score, netDelta: input.otcFootprint.netDelta, avgSpeedRatio: input.otcFootprint.avgSpeedRatio, buckets: input.otcFootprint.buckets }
    : null
  rows.push(fromVote('otcFootprint', 'OTC/velocity footprint (print-speed pressure)', otcFootprintVote(otcRead)))
  rows.push(tickFootprintRow(input.tickFootprint ?? null))
  if (input.smc) {
    rows.push(voteForKindSet(input.smc, SMC_KINDS, 'smc', 'SMC structure (BOS/CHoCH/Supply-Demand/S&R/Breakout)'))
    rows.push(voteForKindSet(input.smc, ICT_KINDS, 'ict', 'ICT concepts (FVG/OB/Breaker/Liquidity Sweep/OTE/KRM/CRT/Po3/Silver Bullet)'))
  } else {
    rows.push({ id: 'smc', label: 'SMC structure (BOS/CHoCH/Supply-Demand/S&R/Breakout)', direction: 'none', confidence: 0, note: 'no SMC scan available this cycle' })
    rows.push({ id: 'ict', label: 'ICT concepts (FVG/OB/Breaker/Liquidity Sweep/OTE/KRM/CRT/Po3/Silver Bullet)', direction: 'none', confidence: 0, note: 'no SMC scan available this cycle' })
  }
  return rows
}

/** One compact line per row, ladder-strip style - for a prompt/log that
 * wants the whole board at a glance rather than one paragraph per row. */
export function chartIndicatorBoardLines(rows: ChartIndicatorRow[]): string[] {
  return rows.map((r) => `- ${r.label}: ${r.direction === 'none' ? 'n/a' : r.direction.toUpperCase()}${r.confidence ? ` (${r.confidence}%)` : ''} - ${r.note}`)
}
