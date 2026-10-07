// IQAIR//OS - Renko brick engine (kernel-side engine of record).
//
// The web chart (ChartPanel.tsx) carries its own small builder for live
// rendering; this module is the one strategies, backtests, screener rows and
// agent tools consume, so the math here is authoritative.
//
// Rules (classic close-based renko):
//   - brick size: explicit `brickSize`, or ATR(close-based true range,
//     `atrPeriod`) * `atrMult` - the practical adaptive default.
//   - continuation: a brick paints when close clears the last brick's close
//     by one full brick in the trend direction.
//   - reversal: in an up run, close must fall TWO bricks below the last
//     brick's close; the reversal brick floats one brick below it (the
//     classic gap), then the trend has flipped.
//
// HONEST TIMES (Task 59-c flagged the web chart's "fictional brick times"):
// a brick's `time` is the OPEN TIME of the candle that COMPLETED it - the
// moment the brick became knowable. When one candle completes several bricks
// (a large bar), the first keeps the candle's open time and each subsequent
// brick is staggered +1s (renko bricks have no independent clock; lightweight-
// charts needs ascending unique times). `timeRule` documents this.
//
// Pure function, O(n) over candles, no look-ahead: a brick is only ever
// built from data that candle carried, so backtests (closed-bar slices) and
// live reads agree bar-for-bar.

import type { Candle } from '../types'

export interface RenkoBrick {
  /** Open time of the candle that COMPLETED this brick (see timeRule). */
  time: number
  open: number
  high: number
  low: number
  close: number
  /** 1 = up brick, -1 = down brick. */
  dir: 1 | -1
}

export interface RenkoResult {
  brickSize: number
  /** How brickSize was derived. */
  brickRule: string
  /** How `time` is assigned. */
  timeRule: string
  bricks: RenkoBrick[]
  /** Direction of the last brick. */
  trend: 'up' | 'down' | 'none'
  /** Consecutive same-direction bricks ending at the last one. */
  streak: number
  /** Direction changes across the whole brick series. */
  flips: number
  /** The ATR the size was derived from (NaN when brickSize was explicit). */
  atr: number
}

/** Mean true range over the last `period` candles (simple mean, not Wilder's
 * smoothed ATR - deterministic and restart-stable, which matters for
 * backtest/live parity). Returns NaN when history is too thin. */
export function renkoAtr(candles: Candle[], period = 14): number {
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

export function renkoBricks(
  candles: Candle[],
  opts: { brickSize?: number; atrPeriod?: number; atrMult?: number } = {}
): RenkoResult {
  const atrPeriod = Math.max(2, Math.round(opts.atrPeriod ?? 14))
  const atrMult = Math.max(0.05, opts.atrMult ?? 0.3)
  const atr = renkoAtr(candles, atrPeriod)
  const explicit = opts.brickSize !== undefined && Number.isFinite(opts.brickSize) && opts.brickSize > 0
  const brickSize = explicit
    ? (opts.brickSize as number)
    : Math.max(Number.isFinite(atr) ? atr * atrMult : 0, 1e-9)
  const brickRule = explicit ? `explicit ${brickSize}` : `ATR(${atrPeriod}) x ${atrMult}`

  const bricks: RenkoBrick[] = []
  if (!Number.isFinite(brickSize) || brickSize <= 0 || candles.length === 0) {
    return { brickSize, brickRule, timeRule: 'completion-candle open time (+1s per extra brick)', bricks, trend: 'none', streak: 0, flips: 0, atr }
  }

  let lastClose = candles[0].close // reference = close of the last painted brick (seeded with the first candle)
  let dir: 0 | 1 | -1 = 0
  let flips = 0

  for (const c of candles) {
    let painted = 0
    const paint = (open: number, close: number, d: 1 | -1) => {
      bricks.push({
        // first brick of this candle keeps the candle's open time, the rest
        // stagger +1s (documented in timeRule; ascending-guard below mops up
        // the pathological case of more bricks than the tf has seconds)
        time: c.time + painted,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        dir: d,
      })
      painted++
      lastClose = close
      if (dir !== 0 && dir !== d) flips++
      dir = d
    }

    if (dir === 0) {
      // seed: whichever side clears one brick first
      if (c.close >= lastClose + brickSize) paint(lastClose, lastClose + brickSize, 1)
      else if (c.close <= lastClose - brickSize) paint(lastClose, lastClose - brickSize, -1)
    }

    // paint() mutates `dir` through this closure - TS control-flow analysis
    // can't see closure writes, so re-widen before the per-direction blocks
    dir = dir as 0 | 1 | -1

    if (dir === 1) {
      while (c.close >= lastClose + brickSize) paint(lastClose, lastClose + brickSize, 1)
      if (c.close <= lastClose - 2 * brickSize) {
        // reversal: the down brick sits one brick below the last up brick's
        // top, and the reference lands on ITS close (2 bricks down) - the
        // next down brick then continues from there, never repainting it
        paint(lastClose - brickSize, lastClose - 2 * brickSize, -1)
      }
    }

    if (dir === -1) {
      while (c.close <= lastClose - brickSize) paint(lastClose, lastClose - brickSize, -1)
      if (c.close >= lastClose + 2 * brickSize) {
        paint(lastClose + brickSize, lastClose + 2 * brickSize, 1)
      }
    }
  }

  // ascending guard (a candle that painted more bricks than its tf has
  // seconds could collide with the next candle's open time)
  for (let i = 1; i < bricks.length; i++) {
    if (bricks[i].time <= bricks[i - 1].time) bricks[i].time = bricks[i - 1].time + 1
  }

  let streak = 0
  const trend: RenkoResult['trend'] = dir === 0 ? 'none' : dir === 1 ? 'up' : 'down'
  if (bricks.length) {
    const d = bricks[bricks.length - 1].dir
    for (let i = bricks.length - 1; i >= 0 && bricks[i].dir === d; i--) streak++
  }

  return {
    brickSize,
    brickRule,
    timeRule: 'completion-candle open time (+1s per extra brick)',
    bricks,
    trend,
    streak,
    flips,
    atr: explicit ? NaN : atr,
  }
}
