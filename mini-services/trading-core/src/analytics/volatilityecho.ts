// IQAIR//OS - Volatility Echo engine ("dual-speed overlay" chart hypothesis).
//
// A Bollinger-Band-shaped statistical band (SMA(window) +/- bandMult x
// trailing stdev of the last `window` closes), plus two classifications
// the design doc specifically asked for:
//   - SQUEEZE  - the band has pinched tighter than its own trailing average
//     width ("coiling" - the doc's own "wait for the break" read).
//   - PIERCE   - price has closed outside the band on this very bar ("the
//     raw line pierces outside the ribbon" - a clean directional burst).
// This is standard, well-understood statistics (nothing here claims to be
// a new discovery) - the contribution is bundling band + squeeze + pierce
// into one object per bar with this codebase's own honesty conventions,
// the same role effortbricks.ts/pulsebars.ts play for their own underlying
// statistics.
//
// HONESTY: `ribbonWidthRatio` (and therefore `squeeze`) is NaN/false until
// enough trailing width history exists - same "can't say yet" convention
// every other lookback-lagged read in this codebase follows.
//
// Pure function, O(n) over candles, no look-ahead - every stdev/average
// uses only points up to and including the current one for the band itself
// (a real trader reading a live band sees exactly this), and only POINTS
// STRICTLY BEFORE the current one for the ratio/squeeze read (so that read
// never leaks the current bar's own width into its own classification).
// SAFE_BACKTEST_SOURCES tier.

import type { Candle } from '../types'

export type EchoPierce = 'up' | 'down' | null

export interface EchoPoint {
  time: number
  price: number
  /** SMA(window) of close. */
  baseline: number
  /** Population stdev of the last `window` closes (this bar included). */
  stdev: number
  upperBand: number
  lowerBand: number
  /** upperBand - lowerBand. */
  ribbonWidth: number
  /** ribbonWidth / trailing average ribbonWidth over the last `lookback`
   * points STRICTLY BEFORE this one. NaN before enough history exists.
   * <1 = pinched tighter than usual; >1 = flared wider than usual. */
  ribbonWidthRatio: number
  /** ribbonWidthRatio below squeezeFloor - "coiling, wait for the break."
   * False whenever ribbonWidthRatio is NaN, never guessed. */
  squeeze: boolean
  /** price > upperBand -> 'up'; price < lowerBand -> 'down'; else null. */
  pierced: EchoPierce
}

export interface EchoResult {
  points: EchoPoint[]
  window: number
  bandMult: number
  squeezeFloor: number
  lookback: number
  /** The LAST point's own read, the single most useful summary field:
   * 'burst-up'/'burst-down' on a pierce, 'squeeze' when coiled (and not
   * pierced - a pierce always takes priority over a squeeze label), else 'none'. */
  trend: 'burst-up' | 'burst-down' | 'squeeze' | 'none'
}

function sma(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

function popStdev(values: number[], mean: number): number {
  if (values.length < 2) return NaN
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length
  return Math.sqrt(variance)
}

export function computeVolatilityEcho(
  candles: Candle[],
  opts: { window?: number; bandMult?: number; squeezeFloor?: number; lookback?: number } = {}
): EchoResult {
  const window = Math.max(3, Math.min(200, Math.round(opts.window ?? 15)))
  const bandMult = Math.max(0.5, opts.bandMult ?? 2.0)
  const squeezeFloor = Math.max(0.05, Math.min(1, opts.squeezeFloor ?? 0.6))
  const lookback = Math.max(5, Math.min(300, Math.round(opts.lookback ?? 50)))
  const empty: EchoResult = { points: [], window, bandMult, squeezeFloor, lookback, trend: 'none' }
  if (candles.length < window + 1) return empty

  const points: EchoPoint[] = []
  const widthHistory: number[] = []

  for (let i = window - 1; i < candles.length; i++) {
    const slice = candles.slice(i - window + 1, i + 1).map((c) => c.close)
    const close = candles[i].close
    const baseline = sma(slice)
    const dev = popStdev(slice, baseline)
    const ribbonWidth = Number.isFinite(dev) ? dev * bandMult * 2 : NaN
    const upperBand = baseline + (Number.isFinite(dev) ? dev * bandMult : 0)
    const lowerBand = baseline - (Number.isFinite(dev) ? dev * bandMult : 0)

    const trailingWidths = widthHistory.slice(-lookback)
    const trailingAvgWidth = trailingWidths.length >= Math.min(lookback, 10) ? sma(trailingWidths) : NaN
    const ribbonWidthRatio = Number.isFinite(trailingAvgWidth) && trailingAvgWidth > 0 && Number.isFinite(ribbonWidth) ? ribbonWidth / trailingAvgWidth : NaN
    const squeeze = Number.isFinite(ribbonWidthRatio) && ribbonWidthRatio < squeezeFloor
    const pierced: EchoPierce = close > upperBand ? 'up' : close < lowerBand ? 'down' : null

    points.push({ time: candles[i].time, price: close, baseline, stdev: dev, upperBand, lowerBand, ribbonWidth, ribbonWidthRatio, squeeze, pierced })
    widthHistory.push(ribbonWidth)
  }

  if (!points.length) return empty
  const last = points[points.length - 1]
  const trend: EchoResult['trend'] = last.pierced === 'up' ? 'burst-up' : last.pierced === 'down' ? 'burst-down' : last.squeeze ? 'squeeze' : 'none'

  return { points, window, bandMult, squeezeFloor, lookback, trend }
}
