// IQAIR//OS - Delta Profile engine.
//
// The 5th new chart type from the roadmap's recommended order (Volume
// Profile, Line Break, Kagi, Swing, THEN Delta Profile) - deferred across
// every prior phase, built here in the post-roadmap follow-up session.
//
// A Delta Profile is Volume Profile's sibling: instead of showing how much
// volume traded at each price, it shows the NET buy-vs-sell delta at each
// price. Same range-overlap volume-spreading proxy as volumeprofile.ts/
// footprint.ts/volumebars.ts (this codebase has no real bid/ask feed - see
// every one of those modules' own headers), but additionally splits each
// candle's spread volume into buy/sell shares via CLV (close-location-
// value: a candle closing near its high assigns more of its volume to
// "buy", closing near its low assigns more to "sell" - the SAME proxy
// footprint.ts's candle-derived engine already uses and discloses for
// exactly this reason). `quality: 'estimated'`, never `measured`.
//
// Pure function, no I/O, no look-ahead - replays faithfully in
// meta_strategy_backtest, same as vp.*/tpo.*/etc.

import type { Candle } from '../types'

export interface DeltaProfileRow {
  priceLow: number
  priceHigh: number
  mid: number
  /** Net buy-minus-sell volume at this level (CLV-proxy, approximate). */
  delta: number
  /** Total (buy+sell) volume at this level, for context/normalizing. */
  volume: number
}

export interface DeltaProfileResult {
  binCount: number
  method: string
  rows: DeltaProfileRow[]
  totalDelta: number
  totalVolume: number
  /** The row with the largest POSITIVE delta - the strongest buy node. */
  positiveDeltaPoc: number | null
  /** The row with the largest NEGATIVE delta - the strongest sell node. */
  negativeDeltaPoc: number | null
  /** sum of all positive-delta rows' delta / totalVolume, -1..1 - the
   * profile's own skew: net-bullish (>0) vs net-bearish (<0) across the
   * whole window, not just at one level. */
  deltaSkew: number
}

export function computeDeltaProfile(candles: Candle[], opts: { binCount?: number } = {}): DeltaProfileResult {
  const binCount = Math.max(5, Math.min(200, Math.round(opts.binCount ?? 48)))
  const method = 'buy/sell volume spread across range-overlapping price bins via close-location-value (CLV) proxy (approx - no bid/ask feed, same proxy as footprint.ts)'
  const empty: DeltaProfileResult = { binCount, method, rows: [], totalDelta: 0, totalVolume: 0, positiveDeltaPoc: null, negativeDeltaPoc: null, deltaSkew: 0 }
  if (!candles.length) return empty

  let lo = Infinity
  let hi = -Infinity
  for (const c of candles) {
    lo = Math.min(lo, c.low)
    hi = Math.max(hi, c.high)
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return empty

  const binSize = (hi - lo) / binCount
  const deltas = new Array(binCount).fill(0)
  const volumes = new Array(binCount).fill(0)
  let totalVolume = 0

  for (const c of candles) {
    const vol = Number.isFinite(c.volume) ? c.volume : 0
    if (vol <= 0) continue
    const range = c.high - c.low
    // CLV: (2*close - high - low) / range, in [-1, 1]; buyShare/sellShare
    // split the candle's own volume accordingly (close at the high ->
    // clv=1 -> 100% buy; close at the low -> clv=-1 -> 100% sell).
    const clv = range > 0 ? (2 * c.close - c.high - c.low) / range : 0
    const buyShare = (1 + clv) / 2
    const sellShare = 1 - buyShare
    const buyVol = vol * buyShare
    const sellVol = vol * sellShare

    const span = Math.max(c.high, c.low) - Math.min(c.high, c.low)
    if (span <= 0) {
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((c.close - lo) / binSize)))
      deltas[idx] += buyVol - sellVol
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
      const overlapShare = overlap / span
      deltas[b] += (buyVol - sellVol) * overlapShare
      volumes[b] += vol * overlapShare
      totalVolume += vol * overlapShare
    }
  }

  const rows: DeltaProfileRow[] = deltas.map((delta, b) => {
    const priceLow = lo + b * binSize
    const priceHigh = priceLow + binSize
    return { priceLow, priceHigh, mid: (priceLow + priceHigh) / 2, delta, volume: volumes[b] }
  })

  const totalDelta = rows.reduce((s, r) => s + r.delta, 0)
  if (totalVolume <= 0) return { ...empty, rows }

  let posIdx = -1
  let negIdx = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].delta > 0 && (posIdx === -1 || rows[i].delta > rows[posIdx].delta)) posIdx = i
    if (rows[i].delta < 0 && (negIdx === -1 || rows[i].delta < rows[negIdx].delta)) negIdx = i
  }
  return {
    binCount,
    method,
    rows,
    totalDelta,
    totalVolume,
    positiveDeltaPoc: posIdx >= 0 ? rows[posIdx].mid : null,
    negativeDeltaPoc: negIdx >= 0 ? rows[negIdx].mid : null,
    deltaSkew: Math.max(-1, Math.min(1, totalDelta / totalVolume)),
  }
}
