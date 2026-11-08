// IQAIR//OS - Swing high/low structure engine (Phase 6 of the chart-engine
// expansion roadmap).
//
// A bar is a confirmed swing high/low when its high/low is the extreme of a
// `lookback`-bar window centered on it - the standard fractal-pivot
// definition. HONEST LAG, stated rather than hidden: a swing needs
// `lookback` bars AFTER it to confirm, so the most recent `lookback` closed
// bars can never have a confirmed swing yet - this is not a bug to "fix" by
// looking ahead, it's what makes a swing point real instead of a repainting
// guess. structure() compares only the last TWO confirmed highs and the
// last TWO confirmed lows - "higher high AND higher low" = hh-hl,
// "lower high AND lower low" = lh-ll, anything else (including a high and a
// low moving in different directions from each other) = 'none', the honest
// "no clean structure yet" read rather than forcing a guess.
//
// Pure function, no I/O, no look-ahead (beyond the lookback-bar confirmation
// delay this detector requires by definition).

import type { Candle } from '../types'

export interface SwingPoint {
  time: number
  price: number
  kind: 'high' | 'low'
  index: number
}

export interface SwingResult {
  lookback: number
  swings: SwingPoint[]
  structure: 'hh-hl' | 'lh-ll' | 'none'
  /** Signed direction of the most recent confirmed leg (the last two
   * swing points by index, whichever kind they are) - +1 if price rose
   * from the earlier to the later point, -1 if it fell, 0 with fewer than
   * two confirmed swings. */
  direction: 1 | -1 | 0
}

export function computeSwing(candles: Candle[], opts: { lookback?: number } = {}): SwingResult {
  const lookback = Math.max(1, Math.min(20, Math.round(opts.lookback ?? 3)))
  const swings: SwingPoint[] = []
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true
    let isLow = true
    const h = candles[i].high
    const l = candles[i].low
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue
      if (candles[j].high >= h) isHigh = false
      if (candles[j].low <= l) isLow = false
    }
    // A bar can't honestly be both in the same window at once except on
    // degenerate flat data - prefer whichever extreme is more pronounced
    // relative to the window's own range, rather than silently picking high.
    if (isHigh && isLow) {
      const mid = (h + l) / 2
      if (candles[i].close >= mid) isLow = false
      else isHigh = false
    }
    if (isHigh) swings.push({ time: candles[i].time, price: h, kind: 'high', index: i })
    else if (isLow) swings.push({ time: candles[i].time, price: l, kind: 'low', index: i })
  }

  const highs = swings.filter((s) => s.kind === 'high')
  const lows = swings.filter((s) => s.kind === 'low')
  let structure: SwingResult['structure'] = 'none'
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price
    const ll = lows[lows.length - 1].price < lows[lows.length - 2].price
    if (hh && hl) structure = 'hh-hl'
    else if (lh && ll) structure = 'lh-ll'
  }

  let direction: 1 | -1 | 0 = 0
  if (swings.length >= 2) {
    const a = swings[swings.length - 2]
    const b = swings[swings.length - 1]
    direction = b.price > a.price ? 1 : b.price < a.price ? -1 : 0
  }

  return { lookback, swings, structure, direction }
}
