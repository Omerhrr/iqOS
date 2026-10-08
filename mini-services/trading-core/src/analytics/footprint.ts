// IQAIR//OS - Volume Footprint / Cluster chart engine (kernel-side engine of
// record).
//
// A footprint chart splits EVERY candle into a ladder of price bins and shows
// the buy vs sell volume that traded in each bin (the "cluster"), plus the
// per-candle delta and point-of-control (POC = heaviest bin).
//
// APPROXIMATION HONESTY (mirrors orderflow.ts - read its header first):
// IQ Option exposes no tick-by-tick bid/ask-tagged trades, so a TRUE bid/ask
// footprint is not reconstructible. Two proxy layers apply, both documented
// here and in every response:
//   1. price distribution: the candle's volume is spread across the bins its
//      [low, high] range overlaps, proportional to each bin's overlap with
//      the range (a candle spanning 3.5 bins puts half a bin's worth into the
//      partial edge bins).
//   2. buy/sell split: every bin of a candle shares the candle's CLV ratio
//      (close-location-value: closes near the high = mostly buy pressure,
//      linear across the range; zero-range candles split 50/50).
// Every surface rendering this must say "volume (approx), CLV split".
//
// Imbalance flags mark rows where one side carries >= `imbalanceRatio`x the
// other (classic footprint reading aid) - same proxy caveat.
//
// Pure function, O(n * bins), no look-ahead.

import type { Candle } from '../types'

export interface FootprintRow {
  priceLow: number
  priceHigh: number
  mid: number
  buyVolume: number
  sellVolume: number
  delta: number
  /** buy >= ratio x sell (or vice versa) - CLV-proxy, not bid/ask. */
  imbalance: 'buy' | 'sell' | null
}

export interface FootprintCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  rows: FootprintRow[]
  /** Total approx volume across rows (== candle.volume up to float error). */
  volume: number
  buyVolume: number
  sellVolume: number
  delta: number
  /** Mid price of the heaviest row (null for zero-range zero-volume). */
  poc: number | null
}

export interface FootprintResult {
  binsPerCandle: number
  imbalanceRatio: number
  /** Distribution + split method disclosure. */
  method: string
  candles: FootprintCandle[]
}

export function computeFootprint(
  candles: Candle[],
  opts: { binsPerCandle?: number; imbalanceRatio?: number } = {}
): FootprintResult {
  const binsPerCandle = Math.max(2, Math.min(24, Math.round(opts.binsPerCandle ?? 8)))
  const imbalanceRatio = Math.max(1.5, Math.min(10, opts.imbalanceRatio ?? 3))
  const method = `volume spread across range-overlapping bins, CLV buy/sell split (approx - no bid/ask feed)`

  const out: FootprintCandle[] = candles.map((c) => {
    const lo = c.low
    const hi = Math.max(c.high, c.low) // guard degenerate floats
    const span = hi - lo
    const vol = Number.isFinite(c.volume) ? c.volume : 0

    // CLV ratio for the whole candle (orderflow.ts convention)
    let buyRatio = 0.5
    if (span > 0) buyRatio = Math.min(1, Math.max(0, (c.close - lo) / span))

    const rows: FootprintRow[] = []
    if (span <= 0 || vol <= 0) {
      // flat or volume-less candle: one row at the price, 50/50 (CLV undefined).
      // ALWAYS imbalance:null - a volume-less row cannot be imbalanced (with
      // buy=sell=0 the classic "one side >= ratio x other" comparison is
      // vacuously true and would read dead tape as a buy stack), and a flat
      // candle splits 50/50 by definition. Guards the footprint-imbalance
      // strategy from firing on zero-volume candles.
      rows.push({
        priceLow: lo,
        priceHigh: hi,
        mid: (lo + hi) / 2,
        buyVolume: vol * buyRatio,
        sellVolume: vol * (1 - buyRatio),
        delta: vol * (2 * buyRatio - 1),
        imbalance: null,
      })
    } else {
      const bin = span / binsPerCandle
      for (let b = 0; b < binsPerCandle; b++) {
        const binLo = lo + b * bin
        const binHi = binLo + bin
        // overlap share of the candle's range - sums to 1 across bins
        const overlap = Math.min(binHi, hi) - Math.max(binLo, lo)
        if (overlap <= 0) continue
        const v = vol * (overlap / span)
        const buy = v * buyRatio
        const sell = v - buy
        rows.push({
          priceLow: binLo,
          priceHigh: binHi,
          mid: (binLo + binHi) / 2,
          buyVolume: buy,
          sellVolume: sell,
          delta: buy - sell,
          imbalance: buy >= imbalanceRatio * sell ? 'buy' : sell >= imbalanceRatio * buy ? 'sell' : null,
        })
      }
    }

    let buyVolume = 0
    let sellVolume = 0
    let poc: number | null = null
    let pocVol = -1
    for (const r of rows) {
      buyVolume += r.buyVolume
      sellVolume += r.sellVolume
      const total = r.buyVolume + r.sellVolume
      if (total > pocVol) {
        pocVol = total
        poc = r.mid
      }
    }

    return {
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      rows,
      volume: buyVolume + sellVolume,
      buyVolume,
      sellVolume,
      delta: buyVolume - sellVolume,
      poc,
    }
  })

  return { binsPerCandle, imbalanceRatio, method, candles: out }
}
