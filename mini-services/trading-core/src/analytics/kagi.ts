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

export type KagiRegime = 'trending' | 'ranging' | 'choppy' | 'none'

export interface KagiResult {
  reversal: number
  lines: KagiLine[]
  direction: 1 | -1 | 0
  thick: boolean
  /** The high set just before the most recent down-reversal (null until one has occurred). */
  shoulder: number | null
  /** The low set just before the most recent up-reversal (null until one has occurred). */
  waist: number | null
  /** hh-hl / lh-ll read over the last two confirmed shoulders and the last two
   * confirmed waists - the same comparison swing.ts's own `structure` field
   * makes, applied to Kagi's own reversal points instead of fractal-pivot
   * swings. 'none' until at least 2 shoulders AND 2 waists exist. */
  structure: 'hh-hl' | 'lh-ll' | 'none'
  /** How many reversal lines were confirmed inside the trailing `regimeLookback`
   * candles - the density/whipsaw signal. */
  legsInWindow: number
  /** 'none' - too little history yet (fewer than 2 shoulders+2 waists, or
   * fewer candles than regimeLookback).
   * 'choppy' - legsInWindow at/above the choppy floor for this window: price
   * is reversing too often, relative to the window, for a hh-hl/lh-ll read
   * to mean anything even if it technically leans one way - frequent
   * whipsaw is noise, not trend.
   * 'trending' - structure is 'hh-hl' or 'lh-ll' and legs aren't dense/choppy.
   * 'ranging' - structure is 'none' (no clean higher-high/higher-low or
   * lower-high/lower-low read) and legs aren't dense/choppy either - price
   * is reversing but without directional structure. */
  regime: KagiRegime
  regimeLookback: number
}

/** Above this many legs per candle inside the window, reversals are dense
 * enough to call "choppy" outright regardless of structure - same
 * floor-on-density spirit as effortbricks.ts's own regime thresholds. */
const CHOPPY_LEG_FLOOR_RATIO = 0.25

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

function classifyRegime(
  lines: KagiLine[],
  candles: Candle[],
  shoulder: number | null,
  waist: number | null,
  regimeLookback: number,
): { structure: KagiResult['structure']; legsInWindow: number; regime: KagiRegime } {
  const empty = { structure: 'none' as const, legsInWindow: 0, regime: 'none' as const }
  if (candles.length < regimeLookback) return empty

  const windowStart = candles[candles.length - regimeLookback].time
  const legsInWindow = lines.filter((l) => l.time >= windowStart).length

  const shoulders = lines.filter((l) => l.dir === -1)
  const waists = lines.filter((l) => l.dir === 1)
  // lines[0] is the seed point (dir defaults to 1 but isn't a real reversal);
  // only lines pushed by an actual reversal (index > 0) count as confirmed
  // shoulders/waists.
  const confirmedShoulders = shoulders.filter((l) => lines.indexOf(l) > 0)
  const confirmedWaists = waists.filter((l) => lines.indexOf(l) > 0)
  if (confirmedShoulders.length < 2 || confirmedWaists.length < 2) return { ...empty, legsInWindow }

  if (legsInWindow / regimeLookback >= CHOPPY_LEG_FLOOR_RATIO) {
    return { structure: 'none', legsInWindow, regime: 'choppy' }
  }

  const hh = confirmedShoulders[confirmedShoulders.length - 1].price > confirmedShoulders[confirmedShoulders.length - 2].price
  const hl = confirmedWaists[confirmedWaists.length - 1].price > confirmedWaists[confirmedWaists.length - 2].price
  const lh = confirmedShoulders[confirmedShoulders.length - 1].price < confirmedShoulders[confirmedShoulders.length - 2].price
  const ll = confirmedWaists[confirmedWaists.length - 1].price < confirmedWaists[confirmedWaists.length - 2].price

  let structure: KagiResult['structure'] = 'none'
  if (hh && hl) structure = 'hh-hl'
  else if (lh && ll) structure = 'lh-ll'

  const regime: KagiRegime = structure === 'none' ? 'ranging' : 'trending'
  return { structure, legsInWindow, regime }
}

export function kagi(
  candles: Candle[],
  opts: { reversal?: number; atrPeriod?: number; reversalAtrMult?: number; regimeLookback?: number } = {},
): KagiResult {
  const atrPeriod = Math.max(2, Math.round(opts.atrPeriod ?? 14))
  const mult = Math.max(0.1, opts.reversalAtrMult ?? 1)
  const reversal = opts.reversal ?? atrFrom(candles, atrPeriod) * mult
  const regimeLookback = Math.max(5, Math.min(300, Math.round(opts.regimeLookback ?? 40)))
  const empty: KagiResult = {
    reversal,
    lines: [],
    direction: 0,
    thick: true,
    shoulder: null,
    waist: null,
    structure: 'none',
    legsInWindow: 0,
    regime: 'none',
    regimeLookback,
  }
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
  const { structure, legsInWindow, regime } = classifyRegime(lines, candles, shoulder, waist, regimeLookback)
  return { reversal, lines, direction: dir, thick, shoulder, waist, structure, legsInWindow, regime, regimeLookback }
}
