// IQAIR//OS - Three-Line-Break engine (Phase 6 of the chart-engine expansion
// roadmap).
//
// Classic close-only line-break chart: a new line only forms when the close
// either (a) continues the current line's direction beyond its own close, or
// (b) reverses by breaking past the EXTREME close of the last `lines` lines
// (the "N-line break" reversal rule - most candles are absorbed with no new
// line at all, which is the whole point of the chart: it filters out noise
// that doesn't actually extend or reverse the trend).
//
// SIMPLIFICATION, stated honestly rather than silently: this is a
// CLOSE-based line break (lines track only open/close, not high/low),
// standard for how most retail platforms draw it and sufficient for the
// vocabulary the roadmap asks for (direction/streak/reversal/historical
// series). A true OHLC-aware variant would track each line's own high/low
// too - not built here; flagged if ever needed.
//
// Pure function, no I/O, no look-ahead.

import type { Candle } from '../types'

export interface LineBreakBar {
  time: number
  open: number
  close: number
  dir: 1 | -1
}

export interface LineBreakResult {
  lineCount: number
  bars: LineBreakBar[]
  direction: 1 | -1 | 0
  /** Consecutive same-direction lines ending at the last one. */
  streak: number
}

export function lineBreak(candles: Candle[], opts: { lines?: number } = {}): LineBreakResult {
  const lineCount = Math.max(2, Math.min(10, Math.round(opts.lines ?? 3)))
  const bars: LineBreakBar[] = []
  for (const c of candles) {
    const close = c.close
    if (bars.length === 0) {
      bars.push({ time: c.time, open: c.open, close, dir: close >= c.open ? 1 : -1 })
      continue
    }
    const last = bars[bars.length - 1]
    if (close === last.close) continue // no price change from the last line's close - absorbed
    if ((last.dir === 1 && close > last.close) || (last.dir === -1 && close < last.close)) {
      bars.push({ time: c.time, open: last.close, close, dir: last.dir })
      continue
    }
    const window = bars.slice(-lineCount)
    const extreme = last.dir === 1 ? Math.min(...window.map((l) => l.close)) : Math.max(...window.map((l) => l.close))
    const broke = last.dir === 1 ? close < extreme : close > extreme
    if (broke) bars.push({ time: c.time, open: last.close, close, dir: last.dir === 1 ? -1 : 1 })
    // else: absorbed - this candle moved against the trend but not far
    // enough to break the last N lines' extreme, so no new line paints.
  }
  const last = bars[bars.length - 1]
  let streak = 0
  if (last) for (let i = bars.length - 1; i >= 0 && bars[i].dir === last.dir; i--) streak++
  return { lineCount, bars, direction: last?.dir ?? 0, streak }
}
