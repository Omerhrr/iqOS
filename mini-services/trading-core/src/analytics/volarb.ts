// IQAIR//OS - Volatility Arb (two realized-vol estimators, no options chain)
// Real volatility arbitrage trades realized vol against an options market's
// IMPLIED vol. IQ Option exposes no options chain/IV surface here (the same
// honest limitation strategies/builtin.ts's mc-fairvalue-edge and ivhv-edge
// already document), so there is no implied-vol leg to arb against directly.
// What the raw OHLC feed DOES give us is two genuinely different realized-vol
// ESTIMATORS of the same underlying: the plain close-to-close estimator
// (what every other vol-based strategy here already uses, via
// analytics/quant.ts's ewmaVol) only sees where price settled each bar, while
// the Parkinson range-based estimator also sees the high/low travel INSIDE
// each bar - information close-to-close throws away entirely. The two
// normally track each other; when they diverge, that is real, measurable
// information about intrabar microstructure:
//   - range vol >> close vol: bars are wicking hard but not displacing net
//     closes - exhaustion/failed-breakout microstructure, faded here.
//   - close vol >> range vol: price is grinding a steady net move WITHOUT
//     correspondingly wide bars - unusually orderly, traded as continuation.
// This is "vol arb" between two realized-vol models of the same tape, not a
// claim about a mispriced option - the honest substitute available without a
// real IV surface.

import type { Candle } from '../types'
import { logReturns, ewmaVol } from './quant'

export const VOLARB_DEFAULT_WINDOW = 40
export const VOLARB_MIN_WINDOW = 20
export const VOLARB_MAX_WINDOW = 120

export interface VolArbResult {
  /** EWMA close-to-close realized vol, per-bar fraction. */
  closeVol: number
  /** Parkinson range-based realized vol, per-bar fraction (same scale as
   * closeVol - comparable 1:1). */
  rangeVol: number
  /** rangeVol / closeVol - the "arb" readout: 1 = the two estimators agree. */
  ratio: number
  /** Net price change over the window (sign only matters for the
   * close-vol-dominant continuation case). */
  momentum: number
  /** Last closed bar's body direction, -1/0/+1 (down/doji/up) - what the
   * range-vol-dominant fade case bets against. */
  lastBarDir: -1 | 0 | 1
}

/** Parkinson (1980) high-low range estimator: sigma^2 = (1/(4*ln2*n)) *
 * sum(ln(high/low)^2). Captures intrabar range close-to-close cannot. */
function parkinsonVol(candles: Candle[]): number {
  let sumSq = 0
  let cnt = 0
  for (const c of candles) {
    if (c.high > 0 && c.low > 0 && c.high >= c.low) {
      const lr = Math.log(c.high / c.low)
      sumSq += lr * lr
      cnt++
    }
  }
  if (cnt === 0) return 0
  return Math.sqrt(sumSq / (4 * Math.log(2) * cnt))
}

export function computeVolArb(candles: Candle[], window = VOLARB_DEFAULT_WINDOW): VolArbResult | null {
  const w = Math.max(VOLARB_MIN_WINDOW, Math.min(VOLARB_MAX_WINDOW, Math.round(window)))
  const n = candles.length
  if (n < w + 2) return null
  const slice = candles.slice(n - w - 1)
  const closes = slice.map((c) => c.close)
  const rets = logReturns(closes)
  const closeVol = ewmaVol(rets) || 1e-9
  const rangeVol = parkinsonVol(slice.slice(1)) // same count as rets (one per bar transition)
  const ratio = closeVol > 1e-12 ? rangeVol / closeVol : 0
  const momentum = closes[closes.length - 1] - closes[0]
  const last = slice[slice.length - 1]
  const body = last.close - last.open
  const lastBarDir: -1 | 0 | 1 = body > 0 ? 1 : body < 0 ? -1 : 0
  return { closeVol, rangeVol, ratio, momentum, lastBarDir }
}
