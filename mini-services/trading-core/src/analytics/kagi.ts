// IQAIR//OS - Kagi engine (Phase 6 of the chart-engine expansion roadmap).
//
// Kagi tracks price with a single zig-zag line that only reverses once price
// moves `reversal` against the current extreme - same ATR-adaptive sizing
// convention renko.ts/rangebars.ts already use (explicit `reversal`, or
// ATR(atrPeriod) * reversalAtrMult). The line's THICKNESS flips independent
// of a reversal: it turns thick ("yang") the moment price breaks above the
// most recent SHOULDER (the high set just before the last down-reversal),
// and thin ("yin") the moment it breaks below the most recent WAIST (the low
// set just before the last up-reversal) - this is the standard definition,
// and it is why a thickness flip can happen mid-trend, not only at a
// reversal.
//
// Pure function, no I/O, no look-ahead. Reuses the exact same trailing-ATR
// calculation rangebars.ts already defines (duplicated here as a tiny local
// helper rather than importing a private function from another engine
// module - keeps this file dependency-free, same as renko.ts/rangebars.ts
// each keep their own local atr helper today).

import type { Candle } from '../types'

export interface KagiLine {
  time: number
  price: number
  dir: 1 | -1
  thick: boolean
}

export interface KagiResult {
  reversal: number
  lines: KagiLine[]
  direction: 1 | -1 | 0
  thick: boolean
  /** The high set just before the most recent down-reversal (null until one has occurred). */
  shoulder: number | null
  /** The low set just before the most recent up-reversal (null until one has occurred). */
  waist: number | null
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

export function kagi(candles: Candle[], opts: { reversal?: number; atrPeriod?: number; reversalAtrMult?: number } = {}): KagiResult {
  const atrPeriod = Math.max(2, Math.round(opts.atrPeriod ?? 14))
  const mult = Math.max(0.1, opts.reversalAtrMult ?? 1)
  const reversal = opts.reversal ?? atrFrom(candles, atrPeriod) * mult
  const empty: KagiResult = { reversal, lines: [], direction: 0, thick: true, shoulder: null, waist: null }
  if (!candles.length || !Number.isFinite(reversal) || reversal <= 0) return empty

  let dir: 1 | -1 = 1
  let extreme = candles[0].close
  let shoulder: number | null = null
  let waist: number | null = null
  let thick = true
  const lines: KagiLine[] = [{ time: candles[0].time, price: extreme, dir, thick }]

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i].close
    if (shoulder !== null && c > shoulder) thick = true
    if (waist !== null && c < waist) thick = false
    if (dir === 1) {
      if (c >= extreme) {
        extreme = c
        lines[lines.length - 1] = { ...lines[lines.length - 1], price: extreme, thick }
      } else if (extreme - c >= reversal) {
        shoulder = extreme
        dir = -1
        extreme = c
        lines.push({ time: candles[i].time, price: extreme, dir, thick })
      }
    } else {
      if (c <= extreme) {
        extreme = c
        lines[lines.length - 1] = { ...lines[lines.length - 1], price: extreme, thick }
      } else if (c - extreme >= reversal) {
        waist = extreme
        dir = 1
        extreme = c
        lines.push({ time: candles[i].time, price: extreme, dir, thick })
      }
    }
  }
  return { reversal, lines, direction: dir, thick, shoulder, waist }
}
