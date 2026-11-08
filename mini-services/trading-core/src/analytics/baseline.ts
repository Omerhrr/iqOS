// IQAIR//OS - Baseline chart engine.
//
// A Baseline chart is a close-price line with ONE extra idea: a baseline
// level (rendered as a flat reference line) that the chart fills green
// above and red below. Until this module, that baseline existed only in
// the frontend's RENDER (first visible bar's close, drawn as a flat line) -
// there was no backing analytics module at all, so nothing could answer
// "what IS the baseline right now" or "how far above/below it is price".
// See claude/msl-capability-matrix.md section G.
//
// DEFINITION, matching the frontend's own render rule exactly (not a new
// invention): the baseline is the FIRST candle's close in whatever window
// the caller passes - same "first bar close of window" the chart itself
// draws from. A caller wanting a different baseline convention (anchored to
// a session start, a round number, yesterday's close, etc.) picks it by
// choosing which candles to pass in, the same "window selection, not
// different math" principle Volume Profile's modes already document.
//
// Pure function, no I/O, no look-ahead.

import type { Candle } from '../types'

export interface BaselineResult {
  /** The window's first close - the flat reference line's own level. */
  baseline: number
  /** Latest close. */
  last: number
  /** last - baseline. */
  deviation: number
  /** deviation / baseline * 100, NaN if baseline is exactly 0 (never a misleading divide-by-zero result). */
  deviationPct: number
  aboveBaseline: boolean
  /** Signed crossing direction of the MOST RECENT bar-to-bar move across the baseline: +1 (crossed up), -1 (crossed down), 0 (no crossing this bar, or fewer than 2 bars). */
  crossDirection: 1 | -1 | 0
  /** deviation (close[i] - baseline) for every bar in the window, chronological. */
  deviationSeries: number[]
}

export function computeBaseline(candles: Candle[]): BaselineResult | null {
  if (!candles.length) return null
  const baseline = candles[0].close
  const last = candles[candles.length - 1].close
  const deviation = last - baseline
  const deviationPct = baseline !== 0 ? (deviation / baseline) * 100 : NaN
  let crossDirection: 1 | -1 | 0 = 0
  if (candles.length >= 2) {
    const prev = candles[candles.length - 2].close
    if (prev <= baseline && last > baseline) crossDirection = 1
    else if (prev >= baseline && last < baseline) crossDirection = -1
  }
  const deviationSeries = candles.map((c) => c.close - baseline)
  return { baseline, last, deviation, deviationPct, aboveBaseline: last > baseline, crossDirection, deviationSeries }
}
