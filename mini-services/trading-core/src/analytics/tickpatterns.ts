// IQAIR//OS - Candlestick pattern detection on the TICK chart.
//
// Per direct instruction: "lets build a panel for detecting candle pattern
// on tick chart." Every existing pattern surface (Pattern Bias, ADX+Pattern,
// Candle Math, the `candle(...)` MSL/signal-func primitive) runs
// detectPatterns() (analytics/patterns.ts) against real TIME-based candles
// (1m, 5m, ...). None of them ever see the tick chart's own N-tick bars
// (analytics/tickbars.ts) - a hammer or engulfing that only shows up at
// tick-chart resolution (because it forms and resolves inside a single
// time-candle) is invisible to every one of those. This module closes that
// gap: it's a thin, honest adapter, not a new detector - it converts
// TickBar[] into the same Candle[] shape detectPatterns() already consumes
// and calls it verbatim. Nothing about pattern math changes; only what
// "one candle" means does.
//
// Pure function, no I/O, no look-ahead - same shape as every other
// analytics module this codebase keeps pure and side-effect-free.

import type { Candle, PatternHit } from '../types'
import { detectPatterns } from './patterns'
import type { TickBar } from './tickbars'

export interface TickPatternHit extends PatternHit {
  /** The tick bar's own close time (epoch seconds, float for a real tick
   * feed) the hit's anchor bar completed on - lets the caller/UI line a hit
   * up against the tick chart's own x-axis, which doesn't share a grid with
   * time candles. */
  time: number
  /** How many ticks were aggregated into the anchor bar (TickBar.ticks) -
   * surfaced so a hit on a half-formed trailing bar (fewer ticks than the
   * bar size, only possible for the LAST bar) can be told apart from a
   * fully-formed one without the caller re-deriving it. */
  ticks: number
}

/** Converts tick bars into detectPatterns()-shaped candles. `volume` is the
 * bar's own tick count (tickBars.ts's own "the only honest size signal"
 * convention) - carried through so a pattern that happens to care about
 * relative volume (none currently do, but detectPatterns() takes a real
 * Candle[], not a stripped-down OHLC-only shape) sees a real number, not a
 * fabricated one. */
function tickBarsToCandles(bars: TickBar[]): Candle[] {
  return bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.ticks }))
}

/** Scans the tail of a tick-bar series for candlestick patterns, same
 * lookback contract as detectPatterns() itself (the window grows from the
 * oldest bar detectPatterns() will consider up through every bar in
 * `bars`, so a pattern that completed `barsAgo` tick-bars back is still
 * reported, not just the very latest bar). Returns bars newest-first isn't
 * done here - callers get detectPatterns()'s own order (oldest completed
 * hit first within the lookback window) with `time`/`ticks` merged in per
 * hit from the anchor bar (`bars.length - 1 - hit.barsAgo`). */
export function detectTickPatterns(bars: TickBar[], lookback = 8): TickPatternHit[] {
  if (bars.length < 3) return []
  const candles = tickBarsToCandles(bars)
  const hits = detectPatterns(candles, lookback)
  return hits.map((h) => {
    const anchorIdx = bars.length - 1 - h.barsAgo
    const anchor = bars[anchorIdx] ?? bars[bars.length - 1]
    return { ...h, time: anchor.time, ticks: anchor.ticks }
  })
}
