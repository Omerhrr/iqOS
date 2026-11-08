// IQAIR//OS - Volume Profile engine (Phase 5 of the chart-engine expansion
// roadmap - see claude/msl-capability-matrix.md and
// claude/chart-engine-roadmap-progress.md).
//
// A volume profile splits a window of candles into price bins and shows how
// much volume traded at each price - the thing TPO (analytics/tpo.ts) is
// explicitly NOT: TPO counts TIME spent at a price (letters), this counts
// VOLUME. The two engines must never be conflated (see the capability
// matrix's section O note) - this file is the first place a real
// volume-based POC/VAH/VAL/HVN/LVN exists anywhere in the codebase.
//
// VOLUME HONESTY (same convention as footprint.ts/volumebars.ts): a
// candle's volume is spread across the price bins its [low, high] range
// overlaps, proportional to each bin's overlap share - the SAME proxy
// footprint.ts already uses and discloses, because that is the only way to
// turn a candle's single volume number into a price-level distribution
// without inventing data. This is `quality: 'estimated'` in the property
// registry, never `measured` - label it "volume (approx)" everywhere, same
// rule every other volume-shaped surface in this codebase already follows.
//
// MODES ("session"/"fixed-range"/"visible-range"/"composite"/"anchored" in
// the roadmap) are NOT different math - they are different choices of WHICH
// candles to pass in. This module only computes a profile over whatever
// candle array it's given; the caller decides the window:
//   - fixed-range / visible-range: pass exactly the candles you want profiled.
//   - session: pass only the candles from the current session's start (the
//     caller groups by session boundary, same as any other session-aware
//     feature in this codebase already does - not re-derived here).
//   - anchored: pass only the candles from the anchor time forward.
//   - composite: pass the full multi-session window; it's the plain window
//     case with a longer lookback, nothing additional to compute.
//   - developing: call this function repeatedly with a growing candle slice
//     as new candles close - computeVolumeProfile() is pure and O(n), cheap
//     enough to re-run per bar rather than needing a separate incremental path.
//
// Pure function, no I/O, no look-ahead.

import type { Candle } from '../types'

export interface VolumeProfileRow {
  priceLow: number
  priceHigh: number
  mid: number
  /** Approximate volume at this price level (range-overlap proxy - see
   * module header). Never "measured bid/ask volume." */
  volume: number
}

export interface VolumeProfileResult {
  binCount: number
  /** Disclosure string, same house pattern as footprint.ts's `method` field. */
  method: string
  rows: VolumeProfileRow[]
  totalVolume: number
  /** Point of Control - the row with the most volume. Null for an empty window. */
  poc: number | null
  /** Value Area High/Low - the price range covering `valueAreaPct` of total
   * volume, built outward from the POC row (same value-area-building
   * convention TPO's own engine uses, just keyed on volume instead of TPO
   * counts). */
  valueAreaHigh: number | null
  valueAreaLow: number | null
  valueAreaPct: number
  /** High-Volume Nodes: rows at or above `hvnMult` x the window's mean row
   * volume - price levels the market spent real volume at (likely support/
   * resistance by volume, not by time). */
  hvn: number[]
  /** Low-Volume Nodes: rows at or below `lvnMult` x the window's mean row
   * volume (and > 0, so a totally-empty bin from a too-fine binCount doesn't
   * masquerade as a "rejected" level) - thin levels price tends to move
   * through quickly rather than accept. */
  lvn: number[]
}

export function computeVolumeProfile(
  candles: Candle[],
  opts: { binCount?: number; valueAreaPct?: number; hvnMult?: number; lvnMult?: number } = {}
): VolumeProfileResult {
  const binCount = Math.max(5, Math.min(200, Math.round(opts.binCount ?? 48)))
  const valueAreaPct = Math.max(0.5, Math.min(0.95, opts.valueAreaPct ?? 0.7))
  const hvnMult = Math.max(1, opts.hvnMult ?? 1.5)
  const lvnMult = Math.max(0, Math.min(1, opts.lvnMult ?? 0.3))
  const method = 'volume spread across range-overlapping price bins (approx - no bid/ask feed, same proxy as the footprint engine)'

  const empty: VolumeProfileResult = { binCount, method, rows: [], totalVolume: 0, poc: null, valueAreaHigh: null, valueAreaLow: null, valueAreaPct, hvn: [], lvn: [] }
  if (!candles.length) return empty

  let lo = Infinity
  let hi = -Infinity
  for (const c of candles) {
    lo = Math.min(lo, c.low)
    hi = Math.max(hi, c.high)
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return empty

  const binSize = (hi - lo) / binCount
  const volumes = new Array(binCount).fill(0)
  let totalVolume = 0
  for (const c of candles) {
    const vol = Number.isFinite(c.volume) ? c.volume : 0
    if (vol <= 0) continue
    const span = Math.max(c.high, c.low) - Math.min(c.high, c.low)
    if (span <= 0) {
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((c.close - lo) / binSize)))
      volumes[idx] += vol
      totalVolume += vol
      continue
    }
    const firstBin = Math.max(0, Math.floor((c.low - lo) / binSize))
    const lastBin = Math.min(binCount - 1, Math.floor((c.high - lo) / binSize))
    for (let b = firstBin; b <= lastBin; b++) {
      const binLo = lo + b * binSize
      const binHi = binLo + binSize
      const overlap = Math.min(binHi, c.high) - Math.max(binLo, c.low)
      if (overlap <= 0) continue
      const share = vol * (overlap / span)
      volumes[b] += share
      totalVolume += share
    }
  }

  const rows: VolumeProfileRow[] = volumes.map((volume, b) => {
    const priceLow = lo + b * binSize
    const priceHigh = priceLow + binSize
    return { priceLow, priceHigh, mid: (priceLow + priceHigh) / 2, volume }
  })

  if (totalVolume <= 0) return { ...empty, rows }

  let pocIdx = 0
  for (let i = 1; i < rows.length; i++) if (rows[i].volume > rows[pocIdx].volume) pocIdx = i
  const poc = rows[pocIdx].mid

  // Value area: grow outward from POC, always taking the richer neighbor
  // next (same greedy convention TPO's value-area build uses), until the
  // accumulated volume share reaches valueAreaPct.
  let loIdx = pocIdx
  let hiIdx = pocIdx
  let acc = rows[pocIdx].volume
  const target = totalVolume * valueAreaPct
  while (acc < target && (loIdx > 0 || hiIdx < rows.length - 1)) {
    const belowVol = loIdx > 0 ? rows[loIdx - 1].volume : -1
    const aboveVol = hiIdx < rows.length - 1 ? rows[hiIdx + 1].volume : -1
    if (aboveVol >= belowVol) {
      hiIdx++
      acc += rows[hiIdx].volume
    } else {
      loIdx--
      acc += rows[loIdx].volume
    }
  }
  const valueAreaLow = rows[loIdx].priceLow
  const valueAreaHigh = rows[hiIdx].priceHigh

  const meanVol = totalVolume / rows.filter((r) => r.volume > 0).length || 0
  const hvn = rows.filter((r) => r.volume >= hvnMult * meanVol).map((r) => r.mid)
  const lvn = rows.filter((r) => r.volume > 0 && r.volume <= lvnMult * meanVol).map((r) => r.mid)

  return { binCount, method, rows, totalVolume, poc, valueAreaHigh, valueAreaLow, valueAreaPct, hvn, lvn }
}
