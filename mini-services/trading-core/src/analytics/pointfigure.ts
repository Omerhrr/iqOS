// IQAIR//OS - Point & Figure engine (kernel-side engine of record).
//
// Classic high/low P&F: price lives on a fixed grid of `boxSize` levels
// (absolute grid, box k spans [k*box, (k+1)*box)); an X column grows up one
// box per box cleared by HIGH, an O column grows down one box per box broken
// by LOW, and the column flips only after price moves `reversalBoxes`
// (classic 3) boxes against it. No time axis by nature - a column takes as
// long as it takes.
//
// HONEST TIMES: columns carry startTime (first candle contributing to the
// column) and endTime (open time of the candle that last extended the
// column) - real candle times, no synthetic axis. Breakout patterns carry
// `at` = the open time of the exact candle that pushed the box past the
// prior top/bottom, so strategy freshness checks anchor on real bars.
//
// Within one candle the order is deterministic: extension first, then
// reversal check (intra-candle path order is unknowable from OHLC - this is
// the standard convention, documented here).
//
// Pure function, O(n), no look-ahead: boxes only ever paint from data the
// candle carried, so closed-bar backtests and live reads agree bar-for-bar.

import type { Candle } from '../types'

export interface PFColumn {
  dir: 'X' | 'O'
  /** Highest box boundary in price (top of the top box). */
  top: number
  /** Lowest box boundary in price (bottom of the bottom box). */
  bottom: number
  /** Number of boxes painted in this column. */
  boxes: number
  /** Open time of the first candle contributing to the column. */
  startTime: number
  /** Open time of the candle that last extended the column. */
  endTime: number
}

export interface PFPattern {
  name: string
  direction: 'call' | 'put'
  /** Open time of the candle that completed the pattern (real bar). */
  at: number
}

export interface PFResult {
  boxSize: number
  boxRule: string
  reversalBoxes: number
  columns: PFColumn[]
  lastDir: 'X' | 'O' | null
  /** Most recent double/triple top-bottom pattern of either side. */
  pattern: PFPattern | null
  /** Latest breakout / breakdown signals, kept separate for callers. */
  buySignal: PFPattern | null
  sellSignal: PFPattern | null
  /** ATR the box size was derived from (NaN when boxSize was explicit). */
  atr: number
}

export function pointFigure(
  candles: Candle[],
  opts: { boxSize?: number; atrPeriod?: number; atrMult?: number; reversalBoxes?: number } = {}
): PFResult {
  const atrPeriod = Math.max(2, Math.round(opts.atrPeriod ?? 14))
  const atrMult = Math.max(0.05, opts.atrMult ?? 0.5)
  const reversalBoxes = Math.max(1, Math.min(10, Math.round(opts.reversalBoxes ?? 3)))
  const atr = atrFrom(candles, atrPeriod)
  const explicit = opts.boxSize !== undefined && Number.isFinite(opts.boxSize) && opts.boxSize > 0
  const boxSize = explicit ? (opts.boxSize as number) : Math.max(Number.isFinite(atr) ? atr * atrMult : 0, 1e-9)
  const boxRule = explicit ? `explicit ${boxSize}` : `ATR(${atrPeriod}) x ${atrMult}`

  const columns: PFColumn[] = []
  let buySignal: PFPattern | null = null
  let sellSignal: PFPattern | null = null
  if (!Number.isFinite(boxSize) || boxSize <= 0 || candles.length === 0) {
    return { boxSize, boxRule, reversalBoxes, columns, lastDir: null, pattern: null, buySignal, sellSignal, atr }
  }

  // tops of completed X columns / bottoms of completed O columns (grid idx)
  const xTops: number[] = []
  const oBottoms: number[] = []

  let dir: 'X' | 'O' | null = null
  let top = 0 // grid idx of the top box of the current column
  let bottom = 0 // grid idx of the bottom box
  let startT = 0
  let endT = 0

  const closeColumn = (t: number) => {
    columns.push({
      dir: dir as 'X' | 'O',
      top: (top + 1) * boxSize,
      bottom: bottom * boxSize,
      boxes: top - bottom + 1,
      startTime: startT,
      endTime: endT || t,
    })
    if (dir === 'X') xTops.push(top)
    else oBottoms.push(bottom)
  }

  for (const c of candles) {
    const hi = Math.floor(c.high / boxSize)
    const lo = Math.floor(c.low / boxSize)

    if (dir === null) {
      // seed: first candle paints an X column from its low box to its high box
      dir = 'X'
      top = hi
      bottom = lo
      startT = c.time
      endT = c.time
      continue
    }

    if (dir === 'X') {
      let extended = false
      while (hi > top) {
        top++
        extended = true
      }
      if (extended) {
        endT = c.time
        // breakout bookkeeping: crossing above the previous X column's top
        const prevTop = xTops.length ? xTops[xTops.length - 1] : null
        if (prevTop !== null && top === prevTop + 1) {
          const triple = xTops.length >= 2 && xTops[xTops.length - 1] === xTops[xTops.length - 2]
          const sig: PFPattern = {
            name: triple ? 'Triple Top Breakout' : 'Double Top Breakout',
            direction: 'call',
            at: c.time,
          }
          buySignal = sig
        }
      }
      if (lo <= top - reversalBoxes) {
        // reversal to O: new column starts one box below the X top and must
        // run at least `reversalBoxes` boxes down (or to the candle's low)
        closeColumn(c.time)
        const newBottom = Math.min(top - reversalBoxes, lo)
        dir = 'O'
        top = top - 1
        bottom = newBottom
        startT = c.time
        endT = c.time
      }
    } else {
      let extended = false
      while (lo < bottom) {
        bottom--
        extended = true
      }
      if (extended) {
        endT = c.time
        const prevBottom = oBottoms.length ? oBottoms[oBottoms.length - 1] : null
        if (prevBottom !== null && bottom === prevBottom - 1) {
          const triple = oBottoms.length >= 2 && oBottoms[oBottoms.length - 1] === oBottoms[oBottoms.length - 2]
          const sig: PFPattern = {
            name: triple ? 'Triple Bottom Breakdown' : 'Double Bottom Breakdown',
            direction: 'put',
            at: c.time,
          }
          sellSignal = sig
        }
      }
      if (hi >= bottom + reversalBoxes) {
        closeColumn(c.time)
        const newTop = Math.max(bottom + reversalBoxes, hi)
        dir = 'X'
        bottom = bottom + 1
        top = newTop
        startT = c.time
        endT = c.time
      }
    }
  }
  if (dir !== null) closeColumn(candles[candles.length - 1].time)

  const pattern = buySignal && sellSignal
    ? (buySignal.at >= sellSignal.at ? buySignal : sellSignal)
    : (buySignal ?? sellSignal)

  return {
    boxSize,
    boxRule,
    reversalBoxes,
    columns,
    lastDir: dir,
    pattern,
    buySignal,
    sellSignal,
    atr: explicit ? NaN : atr,
  }
}

function atrFrom(candles: Candle[], period: number): number {
  if (candles.length < 2) return NaN
  const n = Math.min(period, candles.length - 1)
  let sum = 0
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i]
    const prev = candles[i - 1]
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
  }
  return sum / n
}
