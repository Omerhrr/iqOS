// IQAIR//OS - Range bar engine (kernel-side engine of record).
//
// Classic range bars: every bar spans EXACTLY `range` of price from its open
// to its close - an up bar closes at open + range, a down bar at open - range.
// There is no time axis by nature (a bar takes as long as price needs to
// travel one full range) and no renko-style reversal multiplier: either side
// needs one full `range` from the running reference.
//
// CLOSE-CHAINED (renko.ts convention): bars complete on candle CLOSES only -
// intra-candle wick paths are not reconstructed. Reconstructing them from
// OHLC is unknowable-order guesswork that artifacts on inclusive touches (a
// candle whose low sits exactly one range below the running reference would
// paint a spurious down bar after the up bar consumed the same move), so the
// engine stays deterministic and repaint-free at tf granularity. The span IS
// the signal; the shadows would be reconstruction noise.
//
// SIZE: explicit `range`, or ATR(close-based true range, `atrPeriod`) *
// `atrMult` - the practical adaptive default (same convention as renko.ts).
//
// HONEST TIMES (same convention as renko.ts): a bar's `time` is the OPEN TIME
// of the candle that COMPLETED it, +1s stagger per extra bar painted by the
// same candle (range bars have no independent clock; lightweight-charts needs
// ascending unique times). `timeRule` documents this.
//
// WICKS: range bars are wickless by construction (high = max(open, close),
// low = min(open, close)) - the span is the signal, not the shadows.

import type { Candle } from '../types'

export interface RangeBar {
  /** Open time of the candle that COMPLETED this bar (see timeRule). */
  time: number
  open: number
  high: number
  low: number
  close: number
  /** 1 = closed at open + range, -1 = closed at open - range. */
  dir: 1 | -1
}

export interface RangeBarsResult {
  range: number
  rangeRule: string
  timeRule: string
  bars: RangeBar[]
  trend: 'up' | 'down' | 'none'
  /** Consecutive same-direction bars ending at the last one. */
  streak: number
  flips: number
  /** ATR the range was derived from (NaN when range was explicit). */
  atr: number
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

export function rangeBars(
  candles: Candle[],
  opts: { range?: number; atrPeriod?: number; atrMult?: number } = {}
): RangeBarsResult {
  const atrPeriod = Math.max(2, Math.round(opts.atrPeriod ?? 14))
  const atrMult = Math.max(0.05, opts.atrMult ?? 0.5)
  const atr = atrFrom(candles, atrPeriod)
  const explicit = opts.range !== undefined && Number.isFinite(opts.range) && opts.range > 0
  const range = explicit ? (opts.range as number) : Math.max(Number.isFinite(atr) ? atr * atrMult : 0, 1e-9)
  const rangeRule = explicit ? `explicit ${range}` : `ATR(${atrPeriod}) x ${atrMult}`

  const bars: RangeBar[] = []
  if (!Number.isFinite(range) || range <= 0 || candles.length === 0) {
    return { range, rangeRule, timeRule: 'completion-candle open time (+1s per extra bar)', bars, trend: 'none', streak: 0, flips: 0, atr }
  }

  // ref = the running reference price a new bar opens at (prior close),
  // seeded with the first candle's close. dir === 0 until the first bar.
  let ref = candles[0].close
  let dir: 0 | 1 | -1 = 0
  let flips = 0

  for (const c of candles) {
    // close-chained: closes (and only closes) complete bars, in both
    // directions, one full `range` each - no reversal multiplier
    let painted = 0
    const paint = (d: 1 | -1) => {
      const open = ref
      const close = d === 1 ? open + range : open - range
      bars.push({
        time: c.time + painted,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        dir: d,
      })
      painted++
      ref = close
      if (dir !== 0 && dir !== d) flips++
      dir = d
    }
    while (c.close >= ref + range) paint(1)
    while (c.close <= ref - range) paint(-1)
  }

  // ascending guard (same rationale as renko.ts)
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].time <= bars[i - 1].time) bars[i].time = bars[i - 1].time + 1
  }

  let streak = 0
  const trend: RangeBarsResult['trend'] = dir === 0 ? 'none' : dir === 1 ? 'up' : 'down'
  if (bars.length) {
    const d = bars[bars.length - 1].dir
    for (let i = bars.length - 1; i >= 0 && bars[i].dir === d; i--) streak++
  }

  return {
    range,
    rangeRule,
    timeRule: 'completion-candle open time (+1s per extra bar)',
    bars,
    trend,
    streak,
    flips,
    atr: explicit ? NaN : atr,
  }
}
