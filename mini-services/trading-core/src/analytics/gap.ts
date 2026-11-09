// IQAIR//OS - Candlestick gap detection engine (claude/msl-capability-
// matrix.md section A, flagged "missing" since the Phase 0 audit).
//
// Classic full-range gap: the next candle's OPEN lands outside the PRIOR
// candle's own [low, high] range (open > prevHigh = gap up, open < prevLow
// = gap down) - most candles never gap at all, which is the whole point of
// flagging it. HONEST SCOPE, stated here since it was stated explicitly
// when this item was scoped: this is near-meaningless on IQ Option's OTC
// synthetic pairs, which trade continuously with no session close and so
// essentially never gap - this engine exists for forex/real-market
// instruments where session opens genuinely can. No special-casing by
// asset type here though; the math is honest either way, it just rarely
// fires on one feed type.
//
// A gap is additionally tracked as FILLED the first time price later
// trades back through the pre-gap close level (the classic "gaps get
// filled" read) - `filledAt` is the real bar time that happened, null
// while still open.
//
// Pure function, O(n), no look-ahead: a gap's own detection never depends
// on future bars (only its FILLED status does, and that's explicitly a
// backward-looking scan from the gap forward through already-known bars).

import type { Candle } from '../types'

export interface GapEvent {
  /** Open time of the candle that gapped. */
  time: number
  /** +1 = gap up, -1 = gap down. */
  dir: 1 | -1
  /** |open - prior candle's close|. */
  size: number
  /** True once price has traded back through the pre-gap close level. */
  filled: boolean
  /** Real bar time the gap was filled, null while still open. */
  filledAt: number | null
}

export interface GapResult {
  gaps: GapEvent[]
}

export function detectGaps(candles: Candle[]): GapResult {
  const gaps: GapEvent[] = []
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]
    const c = candles[i]
    let dir: 1 | -1 | 0 = 0
    if (c.open > prev.high) dir = 1
    else if (c.open < prev.low) dir = -1
    if (dir === 0) continue
    const size = Math.abs(c.open - prev.close)
    let filled = false
    let filledAt: number | null = null
    for (let j = i; j < candles.length; j++) {
      const k = candles[j]
      if (dir === 1 ? k.low <= prev.close : k.high >= prev.close) {
        filled = true
        filledAt = k.time
        break
      }
    }
    gaps.push({ time: c.time, dir, size, filled, filledAt })
  }
  return { gaps }
}
