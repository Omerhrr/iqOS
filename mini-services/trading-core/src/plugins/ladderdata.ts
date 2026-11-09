// IQAIR//OS - Shared ladder-data gatherer for the Technical Summary and
// Reversal panels (plugins/technical.ts, plugins/reversal.ts).
//
// Both engines run the SAME 10-rung timeframe ladder (analytics/technicals.ts
// TECH_LADDER), so the market-data plumbing is factored out here: native
// deep candles for the tracked timeframes, 1m deep candles for the 3m
// aggregation, and the per-asset tick ring for the 1s/2s/3s time bars (sim:
// the engine's 1s prints, LIVE: the real broker quotes the 4s poll lands -
// see the DEAD SECONDS-RUNGS FIX in market-data.ts). Pure data-in/data-out -
// no engine logic, no caching policy (each plugin owns its own TTL cache).

import type { Candle } from '../types'
import type { KernelContext } from '../kernel'
import type { MarketDataService } from './market-data'
import { TECH_NATIVE_TFS, type TickPoint } from '../analytics/technicals'

export interface LadderData {
  native: Record<string, Candle[]>
  ticks: TickPoint[]
  price: number
  mode: 'sim' | 'live'
  nowSec: number
}

/** THE 1s/2s/3s DEAD-RUNGS BUG: this used to build the ladder's three
 * tick-built rungs from market.recentTicks() alone - market-data.ts's OWN
 * tick ring, which on a LIVE feed is only ever fed at the ~4s poll cadence
 * (see the DEAD SECONDS-RUNGS FIX comment there). A tick every ~4 seconds
 * mapped onto nominal 1-second buckets means 3 of every 4 buckets are
 * simply ABSENT (barsFromTicks only creates a bar when a tick actually
 * lands in it) - not thin, structurally broken: the 1s/2s/3s rungs could
 * take minutes to even clear TECH_MIN_BARS, and the bars that did exist
 * were really ~4s apart masquerading as 1s/2s/3s, which is exactly why
 * these rungs "don't seem to work." The otc-footprint plugin runs its OWN,
 * genuinely sub-second tick buffer fed from the sidecar's 100ms capture
 * (plugins/otcfootprint.ts's ticksFor() - already what aitrader.ts's tick
 * desk reads for ANY live asset, not just OTC pairs despite the module's
 * name) - merging it in here gives the Technical Summary and Reversal
 * panels the SAME real sub-second resolution the tick desk already has,
 * instead of the coarse 4s ring. market.recentTicks() is kept as a floor:
 * sim mode and any live asset the sidecar hasn't captured yet still get
 * SOMETHING rather than an empty ladder. */
function gatherTicks(market: MarketDataService, ctx: KernelContext | undefined, asset: string): TickPoint[] {
  // Meta-Strategy historical replay (market.setReplayAsof): both tick
  // sources here are live-only ring buffers with no historical record - the
  // coarse ring only ever holds "recent" ticks and the OTC footprint
  // collector's dense buffer is built from a live sidecar capture. Neither
  // has anything honest to say about a bar from the middle of a backtest,
  // so the 1s/2s/3s rungs these ticks build (TECH_LADDER) fail closed to
  // "not ok" during replay instead of silently answering with TODAY's
  // ticks relabeled as history - the same fail-closed convention every
  // other MSL primitive in this codebase follows.
  if (market.isReplaying()) return []
  const coarse: TickPoint[] = market.recentTicks(asset, 4000).map((t) => ({ time: t.ts, price: t.price }))
  let dense: TickPoint[] = []
  try {
    const ofp = ctx?.use<{ ticksFor(asset: string): { ts: number; price: number }[] }>('otcFootprint')
    if (ofp) dense = ofp.ticksFor(asset).map((t) => ({ time: Math.floor(t.ts / 1000), price: t.price }))
  } catch {
    // otc-footprint plugin not loaded - coarse ticks only
  }
  if (!dense.length) return coarse
  // merge + dedupe by second (dense wins a same-second collision - it's the
  // more precise source), sorted ascending the way every consumer expects.
  const bySec = new Map<number, TickPoint>()
  for (const t of coarse) if (Number.isFinite(t.time) && Number.isFinite(t.price) && t.price > 0) bySec.set(t.time, t)
  for (const t of dense) if (Number.isFinite(t.time) && Number.isFinite(t.price) && t.price > 0) bySec.set(t.time, t)
  return [...bySec.values()].sort((a, b) => a.time - b.time)
}

/** Pull every rung's raw data for one asset. `asset` must exist in the
 * market service's universe - the caller reports unknown tickers. `ctx` is
 * optional only so a caller without kernel access still gets the coarse
 * tick floor instead of failing outright - every real plugin caller should
 * pass it so the 1s/2s/3s rungs get the dense sidecar-capture ticks. */
export function gatherLadder(market: MarketDataService, asset: string, ctx?: KernelContext): LadderData | null {
  const listed = market.listAssets().find((a) => a.ticker === asset)
  if (!listed) return null
  const native: Record<string, Candle[]> = {}
  for (const tf of TECH_NATIVE_TFS) native[tf] = market.getCandlesDeep(asset, tf, 300, true)
  // 3m needs 3 x the rung's bars of 1m history
  native['1m'] = market.getCandlesDeep(asset, '1m', 800, true)
  const ticks = gatherTicks(market, ctx, asset)
  const nowSec = Math.floor(Date.now() / 1000)
  const price = listed.price || native['1m'][native['1m'].length - 1]?.close || 0
  return { native, ticks, price, mode: market.mode, nowSec }
}
