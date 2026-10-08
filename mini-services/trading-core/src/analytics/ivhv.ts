// IQAIR//OS - Implied vs Historical volatility engine (kernel-side engine of
// record).
//
// HV (historical / realized volatility) is real math: rolling stddev of log
// returns over `window` candles, annualized with a 365-day 24/7 convention
// (this OS trades FX + crypto feeds that run around the clock; a 252-day
// equity convention would understate by ~13%). Reported in percent.
//
// IV honesty (the important part): a TRUE option-market implied volatility
// is NOT recoverable from what this broker exposes. The classic inversion
// N(d2) = 1/(1+payout) has NO solution for an at-the-money digital under a
// lognormal model whenever payout > 0 (breakeven prob > 0.5 while N(-0.5*sigma*sqrt(T)) < 0.5
// for any positive sigma) - the excess probability IS the house edge, not
// volatility. Extracting real IV needs an implied distribution (a payout
// smile across strikes), which the sidecar does not expose.
//
// What IS honest and informative is the payout-implied BREAKEVEN PROBABILITY
// q(t) = 1/(1 + payout(t)): the win rate a trader needs to break even. It
// moves whenever the broker reprices payouts (0.85 -> 54.05%, 0.70 ->
// 58.82%) and is the closest IV-analog this OS can compute from quoted
// prices. Every response carries `ivRule` saying exactly this, and the
// series is named ivProxy - consumers/UI must not label it "implied
// volatility" without the proxy qualifier.
//
// IV TIME SERIES: payouts are sampled by market-data's metadata refresh into
// an in-memory ring buffer (payoutHistory) - it accrues live and is empty
// after a restart until the first polls land. The series carries whatever
// samples exist; `ivSource` says 'observed' (>=2 samples), 'current' (single
// sample - the broker's current quote only) or 'none'.
//
// Pure functions, O(n), no look-ahead.

import type { Candle } from '../types'

export interface HvPoint {
  time: number
  /** Annualized historical volatility, percent (NaN while the window fills). */
  hv: number
}

export interface IvPoint {
  time: number
  /** Observed payout (fraction, e.g. 0.85). */
  payout: number
  /** 100 / (1 + payout) - breakeven win rate, percent. */
  breakevenPct: number
}

export interface HvSeriesResult {
  window: number
  /** Annualization disclosure, e.g. 'sqrt(31536000/tf 60) x 100, 365d convention'. */
  annualization: string
  series: HvPoint[]
  hvNow: number
}

export function hvSeries(candles: Candle[], opts: { window?: number } = {}): HvSeriesResult {
  const window = Math.max(2, Math.min(500, Math.round(opts.window ?? 20)))
  const tfSec = candles.length >= 2 ? Math.max(1, candles[candles.length - 1].time - candles[candles.length - 2].time) : 60
  const YEAR_SEC = 365 * 86400
  const ann = Math.sqrt(YEAR_SEC / tfSec)
  const series: HvPoint[] = []

  // log returns of CLOSES; window is the number of returns (candles - 1)
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1].close
    const b = candles[i].close
    let hv = NaN
    if (a > 0 && b > 0) {
      // rolling stddev (population) of the last `window` log returns
      const from = Math.max(1, i - window + 1)
      const n = i - from + 1
      if (n >= 2) {
        const logs: number[] = []
        for (let j = from; j <= i; j++) {
          const pa = candles[j - 1].close
          const pb = candles[j].close
          if (pa > 0 && pb > 0) logs.push(Math.log(pb / pa))
        }
        const m = logs.length
        if (m >= 2) {
          const mean = logs.reduce((s, x) => s + x, 0) / m
          const varr = logs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / m
          hv = Math.sqrt(varr) * ann * 100
        }
      }
    }
    series.push({ time: candles[i].time, hv })
  }

  const last = series.length ? series[series.length - 1].hv : NaN
  return {
    window,
    annualization: `sqrt(${YEAR_SEC}/tf ${tfSec}s) x 100, 365d convention`,
    series,
    hvNow: Number.isFinite(last) ? last : NaN,
  }
}

/** Realized up-closing frequency over the last `window` candles, percent -
 * the edge-comparison line (realized WR vs the payout-implied breakeven). */
export function realizedUpProb(candles: Candle[], window = 100): number {
  const n = Math.min(Math.max(2, Math.round(window)), candles.length)
  const slice = candles.slice(-n)
  const ups = slice.filter((c) => c.close > c.open).length
  return (ups / slice.length) * 100
}

export interface IvProxyResult {
  payout: number
  breakevenPct: number
  rule: string
}

/** Payout -> breakeven probability (the disclosed IV-analog). */
export function ivFromPayout(payout: number): IvProxyResult {
  const p = Number.isFinite(payout) && payout > 0 ? payout : 0
  return {
    payout: p,
    breakevenPct: p > 0 ? (100 / (1 + p)) : NaN,
    rule: 'breakeven = 100/(1+payout) - payout-implied PROXY, not option-market IV (ATM digital inversion carries house edge, not vol)',
  }
}
