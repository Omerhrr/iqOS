// Recency-weighted statistics - shared by every learning mechanism in this
// codebase (Oracle's driver/regime/direction/magnitude calibration, the
// ADX/DI+Pattern honesty loop's leg weights/qualify bar/HTF learning,
// Tempo's per-pair accuracy gate).
//
// Every one of those mechanisms used to treat its rolling window as flat:
// a win from 400 bars ago counted exactly as much as one from the last
// bar. That means a real regime shift (a pair's volatility character
// changing, a pattern's reliability drifting) only gets reflected once
// enough OLD data has rolled out of the window - which can be hundreds of
// bars of lag. Exponential recency weighting fixes this with no extra
// bookkeeping: each row gets weight 0.5^(age/halfLife) where age is how
// many rows newer than it exist in the same array (array is assumed
// chronological, oldest first - the convention every `resolved`/`shots`
// array in this codebase already uses). The newest row always has weight
// 1; a row `halfLife` rows old has weight 0.5; one `2*halfLife` old has
// weight 0.25; and so on - old data never vanishes outright, it just
// counts for less, which is what lets the learned value track a real
// shift in dozens of samples instead of waiting out the whole window.
//
// Sample-size gating ("thin record is no record") is UNCHANGED by this -
// every caller still gates on the raw row count (rows.length), not an
// "effective" weighted count, so a thin-but-recent window still doesn't
// get trusted prematurely.

/** Default half-life, in samples, for every learning mechanism that calls
 * weightedHitRate/weightedMean without one of its own. ~150 resolved
 * predictions is a few days of 1m-5m activity on an active pair - old
 * enough to be stable, young enough to track a real behavior change
 * within a trading session or two. */
export const DEFAULT_RECENCY_HALFLIFE = 150

/** Recency-weighted hit rate over a chronological (oldest-first) array.
 * `hit` decides whether a row counts as a win. Returns the raw count
 * alongside the weighted rate so callers can still gate on sample size. */
export function weightedHitRate<T>(rows: readonly T[], hit: (row: T) => boolean, halfLife = DEFAULT_RECENCY_HALFLIFE): { n: number; hitRate: number } {
  const n = rows.length
  if (n === 0) return { n: 0, hitRate: 0 }
  let wSum = 0
  let wHit = 0
  for (let idx = 0; idx < n; idx++) {
    const age = n - 1 - idx
    const w = Math.pow(0.5, age / halfLife)
    wSum += w
    if (hit(rows[idx])) wHit += w
  }
  return { n, hitRate: wSum > 0 ? wHit / wSum : 0 }
}

/** Recency-weighted mean of a numeric chronological (oldest-first) array. */
export function weightedMean(values: readonly number[], halfLife = DEFAULT_RECENCY_HALFLIFE): number {
  const n = values.length
  if (n === 0) return 0
  let wSum = 0
  let total = 0
  for (let idx = 0; idx < n; idx++) {
    const age = n - 1 - idx
    const w = Math.pow(0.5, age / halfLife)
    wSum += w
    total += values[idx] * w
  }
  return wSum > 0 ? total / wSum : 0
}

/** Recency-weighted mean of `pick(row)` over a chronological (oldest-first)
 * array of rows - the generic-row counterpart of weightedMean above, used
 * where the window holds objects rather than bare numbers. */
export function weightedMeanBy<T>(rows: readonly T[], pick: (row: T) => number, halfLife = DEFAULT_RECENCY_HALFLIFE): number {
  const n = rows.length
  if (n === 0) return 0
  let wSum = 0
  let total = 0
  for (let idx = 0; idx < n; idx++) {
    const age = n - 1 - idx
    const w = Math.pow(0.5, age / halfLife)
    wSum += w
    total += pick(rows[idx]) * w
  }
  return wSum > 0 ? total / wSum : 0
}
