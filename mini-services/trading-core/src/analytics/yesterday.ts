// IQAIR//OS - same-time-yesterday scanner analytics
// "What was the market DOING at this exact time yesterday - and in the window
// right after?" For every open instrument the scanner finds the bar that was
// forming exactly 24h ago and replays the forward window that started at that
// moment: net move, high-low travel, best excursion above / below the moment's
// price, plus where price has gone SINCE (then -> now) and which trading
// session the market was in at the time. Traders read it as intraday
// seasonality: "EURUSD usually pumps at this hour - did it, yesterday?"
//
// The ECHO answers the follow-up a forward replay alone cannot: is TODAY
// repeating yesterday's script? Both sides of the comparison are the window
// leading INTO the same time of day - yesterday's ended exactly at the anchor
// moment, today's ends within one bar of now (the anchor bucket + 24h is
// always <= now) - so the two windows are wall-clock aligned, not just
// "roughly a day apart". Each row scores the rhyme 0..100 from three
// explainable parts: direction agreement (50), how close today's net move is
// to yesterday's measured against yesterday's own travel (30, scale-free),
// and how close today's travel is to yesterday's (20).
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

/** The window leading INTO the moment (same length as the replay window),
 * yesterday vs today - the "is today repeating yesterday's lead-in?"
 * comparison. null when either side is under half covered (dark session,
 * asset never warmed) - a missing echo is information, not an error. */
export interface YesterdayEcho {
  /** net move over the lead-in window, yesterday (%) */
  ydayMovePct: number
  /** high-low travel over the lead-in window, yesterday (%) */
  ydayRangePct: number
  /** same wall-clock lead-in window, today (%) */
  todayMovePct: number
  todayRangePct: number
  /** bars present on today's side of the comparison */
  todayBarsFound: number
  /** 'same' = both windows pushed the same way (or both flat), 'opposite' =
   * pushed against each other, 'partial' = one went nowhere */
  dirAgree: 'same' | 'partial' | 'opposite'
  /** 0..100 - direction agreement (50) + move magnitude vs yesterday's own
   * travel (30) + travel ratio (20). >=70 rhymes, <40 diverges. */
  rhyme: number
}

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
  /** lead-in comparison, yesterday vs today - see YesterdayEcho */
  echo: YesterdayEcho | null
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

interface WinStats {
  movePct: number
  rangePct: number
  dir: YdayDir
}

/** Net move / high-low travel / direction over a run of closed bars - the
 * shared math behind the replay window and both echo windows. dir keeps the
 * scale-invariant 10%-of-own-travel rule: a drift smaller than a tenth of
 * the window's travel is flat, whatever the asset class. */
function windowStats(win: Candle[]): WinStats | null {
  if (!win.length) return null
  const open = win[0].open
  if (!(open > 0)) return null
  let high = win[0].high
  let low = win[0].low
  for (const c of win) {
    if (c.high > high) high = c.high
    if (c.low < low) low = c.low
  }
  const movePct = (win[win.length - 1].close / open - 1) * 100
  const rangePct = ((high - low) / open) * 100
  const eps = rangePct * 0.1
  const dir: YdayDir = movePct > eps ? 'up' : movePct < -eps ? 'down' : 'none'
  return { movePct, rangePct, dir }
}

/** The rhyme score's three parts, kept explicit so the panel tooltip can
 * quote them: direction (50), move delta in units of yesterday's travel
 * (30, scale-free), travel ratio (20). Dead-flat on both sides agrees
 * perfectly; yesterday flat + today moving disagrees. */
function rhymeScore(sy: WinStats, st: WinStats): { rhyme: number; dirAgree: YesterdayEcho['dirAgree'] } {
  const dirAgree: YesterdayEcho['dirAgree'] =
    sy.dir === st.dir ? 'same' : sy.dir === 'none' || st.dir === 'none' ? 'partial' : 'opposite'
  const dirPts = dirAgree === 'same' ? 50 : dirAgree === 'partial' ? 25 : 0
  let magPts: number
  let volPts: number
  if (sy.rangePct <= 0 && st.rangePct <= 0) {
    magPts = 30
    volPts = 20
  } else if (sy.rangePct <= 0) {
    magPts = 0
    volPts = 0
  } else {
    magPts = 30 * Math.max(0, 1 - Math.abs(st.movePct - sy.movePct) / sy.rangePct)
    volPts = 20 * Math.max(0, 1 - Math.abs(1 - st.rangePct / sy.rangePct))
  }
  const rhyme = Math.max(0, Math.min(100, Math.round(dirPts + magPts + volPts)))
  return { rhyme, dirAgree }
}

/**
 * Build the same-time-yesterday row for one asset, or null when history does
 * not honestly cover the moment (no bars in the window, under half the
 * expected coverage, or no current price to anchor "since then").
 * `candles` must be closed bars sorted ascending by time (getCandles* contract)
 * and reach back to t0 - windowSec for the echo (the scanner's lookback is
 * sized for 24h + 2x window).
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
  const minBars = Math.max(1, Math.floor(barsExpected * 0.5))
  if (win.length < minBars) return null

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

  // ECHO: the lead-in windows ending at the same wall-clock moment -
  // yesterday's ends exactly at the anchor, today's at anchor + 24h which is
  // always <= now (the anchor bucket never lands after the scan moment).
  // Either side under half covered -> no comparison rather than a fake one.
  let echo: YesterdayEcho | null = null
  const backY = candles.filter((c) => c.time >= t0 - opts.windowSec && c.time < t0)
  const todayEnd = t0 + DAY_SEC
  const backT = candles.filter((c) => c.time >= todayEnd - opts.windowSec && c.time < todayEnd)
  if (backY.length >= minBars && backT.length >= minBars) {
    const sy = windowStats(backY)
    const st = windowStats(backT)
    if (sy && st) {
      const { rhyme, dirAgree } = rhymeScore(sy, st)
      echo = {
        ydayMovePct: r4(sy.movePct),
        ydayRangePct: r4(sy.rangePct),
        todayMovePct: r4(st.movePct),
        todayRangePct: r4(st.rangePct),
        todayBarsFound: backT.length,
        dirAgree,
        rhyme,
      }
    }
  }

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
    echo,
  }
}
