// IQAIR//OS - Liquidity Spring engine ("tension & reversal" chart hypothesis).
//
// Models price as a rubber band stretching away from a fast reference
// (an EMA of recent closes, the "core") and measures two things every bar:
//   - TENSION  - how far price has stretched from the core, expressed as a
//     z-score against the TRAILING stdev of that same stretch (so "far" is
//     relative to this instrument/timeframe's own recent behaviour, not an
//     absolute price distance).
//   - DECELERATION - whether real participation (candle volume, same
//     volume-honesty convention effortbricks.ts/volumebars.ts already use)
//     is falling off relative to its own trailing average.
// `snap` fires only when BOTH are true at once - a stretch with no real
// participation behind it sustaining it anymore is exactly the "rubber band
// at max stretch, about to snap back" signature the design doc described.
// Stretch alone (no deceleration) is just a strong trend continuing, not a
// spring - this engine does not call that a snap.
//
// HONESTY: `tensionScore`/`activityRatio` are NaN until enough trailing
// history exists (same "can't say yet" convention swing.ts/effortbricks.ts
// already follow for their own lookback-lag reads) - `snap` is false
// whenever either read is NaN, never defaulted to a guess.
//
// Pure function, O(n) over candles, no look-ahead - every stdev/average is
// computed from points strictly BEFORE the current one, so a backtest's
// closed-bar walk and a live read agree bar-for-bar. SAFE_BACKTEST_SOURCES
// tier, same reasoning effortbricks.ts/mrc.ts's candle-fallback path follow.

import type { Candle } from '../types'

export interface SpringPoint {
  time: number
  close: number
  /** EMA(emaPeriod) of close - the "core" the band is stretched from. */
  baseline: number
  /** close - baseline (signed). */
  deviation: number
  /** |deviation| / trailing stdev of |deviation| over the last `lookback`
   * points BEFORE this one. NaN before `lookback` prior points exist. */
  tensionScore: number
  /** This candle's own volume (or 1 per candle if the whole window carries
   * no volume at all - same degenerate handling effortbricks.ts uses). */
  activity: number
  /** activity / trailing average activity over the last `lookback` points
   * BEFORE this one. NaN before enough history exists. */
  activityRatio: number
  /** activityRatio < 1 (real participation is falling off) - only when activityRatio is finite. */
  decelerating: boolean
  /** tensionScore >= snapTensionFloor AND decelerating - "max stretch,
   * participation drying up, likely to revert." False whenever either
   * input is NaN, never guessed. */
  snap: boolean
}

export interface SpringResult {
  points: SpringPoint[]
  emaPeriod: number
  lookback: number
  snapTensionFloor: number
  /** Direction of the deviation on the LAST snap point seen, 'none' if no snap has fired yet. */
  trend: 'stretched-up' | 'stretched-down' | 'none'
  /** Bars since that last snap (0 = the current/last bar itself snapped). NaN if none has fired yet. */
  barsSinceSnap: number
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = values[0]
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

function stdev(values: number[]): number {
  if (values.length < 2) return NaN
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length
  return Math.sqrt(variance)
}

export function computeLiquiditySpring(
  candles: Candle[],
  opts: { emaPeriod?: number; lookback?: number; snapTensionFloor?: number } = {}
): SpringResult {
  const emaPeriod = Math.max(2, Math.round(opts.emaPeriod ?? 20))
  const lookback = Math.max(5, Math.min(300, Math.round(opts.lookback ?? 50)))
  const snapTensionFloor = Math.max(0.5, opts.snapTensionFloor ?? 2.0)
  const empty: SpringResult = { points: [], emaPeriod, lookback, snapTensionFloor, trend: 'none', barsSinceSnap: NaN }
  if (candles.length < 3) return empty

  const closes = candles.map((c) => c.close)
  const baselines = ema(closes, emaPeriod)
  const anyVolume = candles.some((c) => Number.isFinite(c.volume) && c.volume > 0)

  const points: SpringPoint[] = []
  const devHistory: number[] = []
  const activityHistory: number[] = []

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const baseline = baselines[i]
    const deviation = c.close - baseline
    const absDev = Math.abs(deviation)
    const activity = anyVolume ? Math.max(0, Number.isFinite(c.volume) ? c.volume : 0) : 1

    const trailingStdev = devHistory.length >= lookback ? stdev(devHistory.slice(-lookback)) : NaN
    const tensionScore = Number.isFinite(trailingStdev) && trailingStdev > 0 ? Math.min(6, absDev / trailingStdev) : NaN
    const trailingActivity = activityHistory.length >= lookback ? activityHistory.slice(-lookback).reduce((a, b) => a + b, 0) / lookback : NaN
    const activityRatio = Number.isFinite(trailingActivity) && trailingActivity > 0 ? activity / trailingActivity : NaN
    const decelerating = Number.isFinite(activityRatio) && activityRatio < 1
    const snap = Number.isFinite(tensionScore) && tensionScore >= snapTensionFloor && decelerating

    points.push({ time: c.time, close: c.close, baseline, deviation, tensionScore, activity, activityRatio, decelerating, snap })
    devHistory.push(absDev)
    activityHistory.push(activity)
  }

  let trend: SpringResult['trend'] = 'none'
  let barsSinceSnap = NaN
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].snap) {
      trend = points[i].deviation >= 0 ? 'stretched-up' : 'stretched-down'
      barsSinceSnap = points.length - 1 - i
      break
    }
  }

  return { points, emaPeriod, lookback, snapTensionFloor, trend, barsSinceSnap }
}
