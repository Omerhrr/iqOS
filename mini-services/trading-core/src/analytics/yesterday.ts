// IQAIR//OS - same-time-yesterday scanner analytics
// "What was the market DOING at this exact time yesterday - and in the window
// right after?" For every open instrument the scanner finds the bar that was
// forming exactly 24h ago and replays the forward window that started at that
// moment: net move, high-low travel, best excursion above / below the moment's
// price, plus where price has gone SINCE (then -> now) and which trading
// session the market was in at the time. Traders read it as intraday
// seasonality: "EURUSD usually pumps at this hour - did it, yesterday?"
//
// Honesty rules this module enforces:
// - the story is built ONLY from bars actually present in the series; a row
//   whose window coverage is under half of the expected bars is dropped
//   entirely (market dark at that hour yesterday / asset never warmed) rather
//   than silently reporting a move computed from a fraction of the window;
// - `barsFound` vs `barsExpected` travels with every row that does pass, so
//   the panel can show partial coverage instead of implying a full window;
// - `archived` counts the bars that came from the kernel's own store (real
//   accumulated history - broker bars in live mode) vs the deterministic
//   prehistory the feed generates, so a synthetic "yesterday" can never
//   masquerade as a remembered one.
// - dir is scale-invariant: a window counts as directional only when its net
//   move exceeds 10% of its own high-low travel - a 0.05% drift inside a
//   0.6% chop is flat, no matter the asset class.

import { classifySession, type Session } from './session'
import type { AssetCategory, Candle } from '../types'

export type YdayDir = 'up' | 'down' | 'none'

export interface YesterdayRow {
  asset: string
  name: string
  category: AssetCategory
  otc: boolean
  /** epoch seconds of the bar that was forming exactly 24h ago - the window starts here */
  thenTs: number
  /** price at that moment (open of the bar containing T-24h) */
  thenPrice: number
  /** price right now */
  nowPrice: number
  /** (now - then) / then, % - where the market has gone since that moment */
  sincePct: number
  /** net move over the window that started at that moment, % (window close vs thenPrice) */
  movePct: number
  dir: YdayDir
  /** high-low travel across the window, % of thenPrice */
  rangePct: number
  /** best excursion above thenPrice inside the window, % */
  runUpPct: number
  /** deepest excursion below thenPrice inside the window, % */
  drawdownPct: number
  /** window bars present vs expected - coverage is displayed, never implied */
  barsFound: number
  barsExpected: number
  /** of the bars found, how many came from the kernel's store (accumulated history) */
  archived: number
  /** session the market was in at that moment yesterday (OTC pairs always 'OTC') */
  session: Session
}

export interface YesterdayInfo {
  ticker: string
  name: string
  category: AssetCategory
  otc: boolean
}

export interface YesterdayOpts {
  /** scan moment, epoch seconds */
  nowSec: number
  /** forward window length, seconds (a multiple of tfSec, >= tfSec) */
  windowSec: number
  /** scanned timeframe bar size, seconds */
  tfSec: number
  /** current price for the asset (0 = unknown - the row is dropped) */
  nowPrice: number
  /** archived (store-backed) bars inside the window - provenance label */
  archived: number
}

const DAY_SEC = 86_400
const r4 = (x: number) => Math.round(x * 10_000) / 10_000

/**
 * Build the same-time-yesterday row for one asset, or null when history does
 * not honestly cover the moment (no bars in the window, under half the
 * expected coverage, or no current price to anchor "since then").
 * `candles` must be closed bars sorted ascending by time (getCandles* contract).
 */
export function buildYesterdayRow(info: YesterdayInfo, candles: Candle[], opts: YesterdayOpts): YesterdayRow | null {
  if (!(opts.nowPrice > 0)) return null
  const target = opts.nowSec - DAY_SEC
  // the bucket that was forming at that exact moment (bar opens are tf-aligned)
  const t0 = target - (target % opts.tfSec)
  const windowEnd = t0 + opts.windowSec
  const win = candles.filter((c) => c.time >= t0 && c.time < windowEnd)
  const barsExpected = Math.round(opts.windowSec / opts.tfSec)
  if (!win.length) return null
  // coverage gate: under half the window is a fraction of a story, not a story
  if (win.length < Math.max(1, Math.floor(barsExpected * 0.5))) return null

  const thenPrice = win[0].open
  if (!(thenPrice > 0)) return null
  let high = win[0].high
  let low = win[0].low
  for (const c of win) {
    if (c.high > high) high = c.high
    if (c.low < low) low = c.low
  }
  const lastClose = win[win.length - 1].close
  const movePct = (lastClose / thenPrice - 1) * 100
  const rangePct = ((high - low) / thenPrice) * 100
  // directional only when the net move is >= 10% of the window's own travel
  const eps = rangePct * 0.1
  const dir: YdayDir = movePct > eps ? 'up' : movePct < -eps ? 'down' : 'none'

  return {
    asset: info.ticker,
    name: info.name,
    category: info.category,
    otc: info.otc,
    thenTs: t0,
    thenPrice,
    nowPrice: opts.nowPrice,
    sincePct: r4((opts.nowPrice / thenPrice - 1) * 100),
    movePct: r4(movePct),
    dir,
    rangePct: r4(rangePct),
    runUpPct: r4(Math.max(0, (high / thenPrice - 1) * 100)),
    drawdownPct: r4(Math.max(0, (1 - low / thenPrice) * 100)),
    barsFound: win.length,
    barsExpected,
    archived: Math.min(opts.archived, win.length),
    session: classifySession(t0, info.ticker),
  }
}
