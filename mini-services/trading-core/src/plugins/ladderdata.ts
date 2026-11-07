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
import type { MarketDataService } from './market-data'
import { TECH_NATIVE_TFS, type TickPoint } from '../analytics/technicals'

export interface LadderData {
  native: Record<string, Candle[]>
  ticks: TickPoint[]
  price: number
  mode: 'sim' | 'live'
  nowSec: number
}

/** Pull every rung's raw data for one asset. `asset` must exist in the
 * market service's universe - the caller reports unknown tickers. */
export function gatherLadder(market: MarketDataService, asset: string): LadderData | null {
  const listed = market.listAssets().find((a) => a.ticker === asset)
  if (!listed) return null
  const native: Record<string, Candle[]> = {}
  for (const tf of TECH_NATIVE_TFS) native[tf] = market.getCandlesDeep(asset, tf, 300, true)
  // 3m needs 3 x the rung's bars of 1m history
  native['1m'] = market.getCandlesDeep(asset, '1m', 800, true)
  const ticks: TickPoint[] = market.recentTicks(asset, 4000).map((t) => ({ time: t.ts, price: t.price }))
  const nowSec = Math.floor(Date.now() / 1000)
  const price = listed.price || native['1m'][native['1m'].length - 1]?.close || 0
  return { native, ticks, price, mode: market.mode, nowSec }
}
