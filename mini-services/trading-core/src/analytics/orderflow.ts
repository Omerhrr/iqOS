// IQAIR//OS - Order flow approximation (Volume Profile / Footprint / Cumulative Delta)
//
// IQ Option does not expose real tick-by-tick bid/ask-tagged trades or order-book
// depth for any instrument class this OS trades. (Task 59 correction: the
// sidecar DOES capture a 100ms quote-change sampling buffer for the
// randomness audit - /tick_stats - but it has no volume and no bid/ask tags,
// so a CLV delta over OHLCV remains the only honest order-flow proxy here.)
// Everything below is a best-effort, candle-level APPROXIMATION, not real
// order flow - every surface that renders it must say so.
//
// Buy/sell split per candle uses the standard close-location-value (CLV) proxy:
// a candle that closes near its high is treated as mostly buy pressure, a candle
// that closes near its low as mostly sell pressure, linearly across the range.
//   buyVolume  = volume * (close - low) / (high - low)
//   sellVolume = volume - buyVolume
// A zero-range candle (high === low) splits its volume 50/50 since CLV is
// undefined there.
//
// A second approximation layer applies to `volume` itself: for OTC/binary
// synthetic instruments IQ Option's "volume" field is commonly a tick/sample
// count rather than genuine traded size. Candle.volume is used as-is here
// (it is the only size signal available at all) but callers/UI must label it
// "volume (approx)" rather than implying verified traded volume.
// Task 59 note: this IS wired into strategies - builtin volume-profile family
// (vp-poc-reversion / vp-value-area-breakout), delta-divergence, and the
// custom ofdelta/ofcumdelta/ofpocdist/ofvapos signals - all labeled "(approx)".
import type { Candle } from '../types'

export interface CandleDelta {
  time: number
  buyVolume: number
  sellVolume: number
  delta: number // buyVolume - sellVolume
}

export interface CumulativeDeltaPoint {
  time: number
  cumulativeDelta: number
}

export interface VolumeProfileLevel {
  price: number // midpoint of the bucket
  priceLow: number
  priceHigh: number
  volume: number
  buyVolume: number
  sellVolume: number
}

export interface VolumeProfileResult {
  levels: VolumeProfileLevel[]
  poc: number // price (bucket midpoint) with the single highest total volume
  valueAreaHigh: number
  valueAreaLow: number
  totalVolume: number
}

/** Per-candle CLV-based buy/sell volume split. Pure function, no side effects. */
export function computeCandleDelta(candles: Candle[]): CandleDelta[] {
  return candles.map((c) => {
    const range = c.high - c.low
    const clv = range > 0 ? (c.close - c.low) / range : 0.5
    const buyVolume = c.volume * clv
    const sellVolume = c.volume - buyVolume
    return { time: c.time, buyVolume, sellVolume, delta: buyVolume - sellVolume }
  })
}

/** Running sum of per-candle delta. Pure function over computeCandleDelta's output. */
export function computeCumulativeDelta(deltas: Array<Pick<CandleDelta, 'time' | 'delta'>>): CumulativeDeltaPoint[] {
  let running = 0
  return deltas.map((d) => {
    running += d.delta
    return { time: d.time, cumulativeDelta: running }
  })
}

const DEFAULT_BUCKETS = 36
const MIN_BUCKETS = 10
const MAX_BUCKETS = 80
const VALUE_AREA_PCT = 0.70

/**
 * Volume-at-price histogram (Point of Control + Value Area), approximated
 * from OHLCV candles with the CLV buy/sell split above.
 *
 * Attribution rule: each candle's (approximated) volume is distributed
 * proportionally across every bucket its high-low range overlaps, weighted
 * by the fraction of the candle's range inside that bucket. This is more
 * accurate than "attribute the whole candle to its close bucket" (which
 * collapses wide-range candles onto a single price) while staying O(candles
 * x buckets) and side-effect free - a reasonable accuracy/complexity
 * tradeoff for a histogram feeding a visual overlay rather than execution
 * logic.
 */
export function computeVolumeProfile(candles: Candle[], opts?: { bucketCount?: number }): VolumeProfileResult {
  const bucketCount = Math.max(MIN_BUCKETS, Math.min(MAX_BUCKETS, Math.round(opts?.bucketCount ?? DEFAULT_BUCKETS)))

  if (candles.length === 0) {
    return { levels: [], poc: 0, valueAreaHigh: 0, valueAreaLow: 0, totalVolume: 0 }
  }

  let lo = Infinity
  let hi = -Infinity
  for (const c of candles) {
    if (c.low < lo) lo = c.low
    if (c.high > hi) hi = c.high
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    // Degenerate range (flat candles): single bucket at that price.
    const deltas = computeCandleDelta(candles)
    const volume = deltas.reduce((s, d) => s + d.buyVolume + d.sellVolume, 0)
    const buyVolume = deltas.reduce((s, d) => s + d.buyVolume, 0)
    const sellVolume = deltas.reduce((s, d) => s + d.sellVolume, 0)
    const price = candles[0].close
    return {
      levels: [{ price, priceLow: price, priceHigh: price, volume, buyVolume, sellVolume }],
      poc: price,
      valueAreaHigh: price,
      valueAreaLow: price,
      totalVolume: volume,
    }
  }

  const bucketSize = (hi - lo) / bucketCount
  const levels: VolumeProfileLevel[] = Array.from({ length: bucketCount }, (_, i) => {
    const priceLow = lo + i * bucketSize
    const priceHigh = i === bucketCount - 1 ? hi : lo + (i + 1) * bucketSize
    return { price: (priceLow + priceHigh) / 2, priceLow, priceHigh, volume: 0, buyVolume: 0, sellVolume: 0 }
  })

  const deltas = computeCandleDelta(candles)
  for (let ci = 0; ci < candles.length; ci++) {
    const c = candles[ci]
    const d = deltas[ci]
    const range = c.high - c.low
    if (range <= 0) {
      // Flat candle: dump entirely into the bucket containing its price.
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((c.close - lo) / bucketSize)))
      levels[idx].volume += c.volume
      levels[idx].buyVolume += d.buyVolume
      levels[idx].sellVolume += d.sellVolume
      continue
    }
    const startIdx = Math.min(bucketCount - 1, Math.max(0, Math.floor((c.low - lo) / bucketSize)))
    const endIdx = Math.min(bucketCount - 1, Math.max(0, Math.floor((c.high - lo) / bucketSize)))
    for (let bi = startIdx; bi <= endIdx; bi++) {
      const bucketLow = levels[bi].priceLow
      const bucketHigh = levels[bi].priceHigh
      const overlapLow = Math.max(c.low, bucketLow)
      const overlapHigh = Math.min(c.high, bucketHigh)
      const overlap = Math.max(0, overlapHigh - overlapLow)
      const frac = overlap / range
      if (frac <= 0) continue
      levels[bi].volume += c.volume * frac
      levels[bi].buyVolume += d.buyVolume * frac
      levels[bi].sellVolume += d.sellVolume * frac
    }
  }

  const totalVolume = levels.reduce((s, l) => s + l.volume, 0)

  let pocIdx = 0
  for (let i = 1; i < levels.length; i++) {
    if (levels[i].volume > levels[pocIdx].volume) pocIdx = i
  }

  // Standard Value Area calculation: expand outward from the POC one bucket
  // at a time, each step taking whichever side (above/below the current
  // window) has more volume, until the window covers >= 70% of total volume.
  let vaLowIdx = pocIdx
  let vaHighIdx = pocIdx
  let vaVolume = levels[pocIdx]?.volume ?? 0
  const target = totalVolume * VALUE_AREA_PCT
  while (vaVolume < target && (vaLowIdx > 0 || vaHighIdx < levels.length - 1)) {
    const belowVol = vaLowIdx > 0 ? levels[vaLowIdx - 1].volume : -1
    const aboveVol = vaHighIdx < levels.length - 1 ? levels[vaHighIdx + 1].volume : -1
    if (aboveVol >= belowVol) {
      vaHighIdx++
      vaVolume += levels[vaHighIdx].volume
    } else {
      vaLowIdx--
      vaVolume += levels[vaLowIdx].volume
    }
  }

  return {
    levels,
    poc: levels[pocIdx]?.price ?? 0,
    valueAreaHigh: levels[vaHighIdx]?.price ?? 0,
    valueAreaLow: levels[vaLowIdx]?.price ?? 0,
    totalVolume,
  }
}
