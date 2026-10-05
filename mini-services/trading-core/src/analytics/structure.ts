// IQAIR//OS - Market-structure signal series, shared by the Strategy Lab
// (mining/backtesting) and the live custom-strategy evaluator
// (strategies/custom.ts), exactly like psar/fractal already are. Both
// functions below return a FULL-LENGTH, SIGNED, non-repainting series -
// positive = bullish condition, negative = bearish, 0 = inactive - so they
// slot straight into IndicatorSignal's generic op/threshold/dir machinery.
//
// trendPullbackSeries: the trending-market concept the user asked for - find
// the swing structure (higher-highs/higher-lows = bull, lower-highs/lower-
// lows = bear), require a real leg (not noise), and only go "hot" when price
// is pulled back close to the most recent confirmed swing point in the
// direction of that structure - i.e. only buys in a bull structure, only
// sells in a bear one, with structure-break (opposing HH/HL vs LH/LL) acting
// as the built-in reversal guard: as soon as the swing sequence breaks, bull
// and bear both go cold until a new, confirmed sequence forms.
//
// rangeZoneSeries: the ranging-market "buy zone / sell zone" counterpart -
// detect a channel where price is drifting sideways (net drift small vs the
// channel's own width) and fire a buy-zone signal near the channel floor, a
// sell-zone signal near its ceiling. Entirely separate code path from
// trendPullbackSeries: a market in one is explicitly not treated as the
// other (a trending run won't pass the ranging-ratio gate, and a quiet range
// won't pass the leg-size gate), so the lab can mine both independently and
// let measured edge decide which fires on a given pair/timeframe.
//
// Both functions are non-repainting: every value at bar t is computed only
// from bars <= t (trendPullbackSeries additionally only trusts a swing pivot
// once its confirmation flank has actually closed, same discipline as the
// fractal indicator in custom.ts).

import type { Candle } from '../types'
import * as ta from './indicators'
import { findPivots } from './chart-patterns'

export interface TrendPullbackParams {
  pivotFlank?: number // swing-pivot confirmation flank each side (default 3)
  pullbackAtr?: number // max ATR-distance from the reference swing point still counted "pulled back" (default 0.75)
  minLegAtr?: number // the completed leg (last pivot pair) must span at least this many ATRs, filters noise chop (default 2)
}

/** Signed trend-structure-pullback distance. Positive while in a confirmed
 * bull structure (HH+HL) and price has pulled back within `pullbackAtr` ATRs
 * of the last confirmed swing low (magnitude grows the closer price sits to
 * that low); negative mirror for a confirmed bear structure (LH+LL) pulling
 * back up toward the last confirmed swing high; 0 whenever the structure is
 * mixed/broken or price isn't in the pullback zone. */
export function trendPullbackSeries(candles: Candle[], params: TrendPullbackParams = {}): number[] {
  const flank = Math.max(1, Math.round(params.pivotFlank ?? 3))
  const pullbackAtr = Math.max(0.1, params.pullbackAtr ?? 0.75)
  const minLegAtr = Math.max(0, params.minLegAtr ?? 2)
  const n = candles.length
  const high = candles.map((k) => k.high)
  const low = candles.map((k) => k.low)
  const close = candles.map((k) => k.close)
  const atrArr = ta.atr(high, low, close, 14)
  // findPivots only ever reads a pivot's own left/right flank window, so
  // running it once over the full series is equivalent to running it on any
  // prefix long enough to confirm that pivot - safe to reuse across all t.
  const allPivots = findPivots(candles, flank, flank)
  const out: number[] = new Array(n).fill(0)
  let cursor = 0
  const confirmedHighs: number[] = []
  const confirmedLows: number[] = []
  for (let t = 0; t < n; t++) {
    while (cursor < allPivots.length && allPivots[cursor].idx + flank <= t) {
      const piv = allPivots[cursor]
      if (piv.kind === 'H') confirmedHighs.push(piv.price)
      else confirmedLows.push(piv.price)
      if (confirmedHighs.length > 2) confirmedHighs.shift()
      if (confirmedLows.length > 2) confirmedLows.shift()
      cursor++
    }
    const atrT = atrArr[t]
    if (!(atrT > 1e-12) || confirmedHighs.length < 2 || confirmedLows.length < 2) continue
    const bull = confirmedHighs[1] > confirmedHighs[0] && confirmedLows[1] > confirmedLows[0]
    const bear = confirmedHighs[1] < confirmedHighs[0] && confirmedLows[1] < confirmedLows[0]
    if (!bull && !bear) continue // mixed/broken structure - sit out, this is the reversal guard
    const legAtr = bull ? Math.abs(confirmedLows[1] - confirmedHighs[0]) / atrT : Math.abs(confirmedHighs[1] - confirmedLows[0]) / atrT
    if (legAtr < minLegAtr) continue // too small to be a real leg - likely chop
    if (bull) {
      const ref = confirmedLows[confirmedLows.length - 1]
      const dist = (close[t] - ref) / atrT
      if (dist >= 0 && dist <= pullbackAtr) out[t] = pullbackAtr - dist + 0.01
    } else {
      const ref = confirmedHighs[confirmedHighs.length - 1]
      const dist = (ref - close[t]) / atrT
      if (dist >= 0 && dist <= pullbackAtr) out[t] = -(pullbackAtr - dist + 0.01)
    }
  }
  return out
}

export interface RangeZoneParams {
  window?: number // rolling channel lookback, bars BEFORE t (default 40)
  rangeThreshold?: number // max |net drift| / channel width still counted "ranging" (default 0.35)
  zoneAtr?: number // max ATR-distance from a channel edge counted "in the zone" (default 0.4)
}

/** Signed ranging-market zone distance. Positive = inside the buy zone near
 * the floor of a detected sideways channel (magnitude grows closer to the
 * floor); negative = sell zone near the ceiling; 0 whenever the market isn't
 * currently ranging (net drift too large relative to channel width - that's
 * a trend, not a range, and trendPullbackSeries is the one that should fire
 * there instead) or price is in the middle of the channel. */
export function rangeZoneSeries(candles: Candle[], params: RangeZoneParams = {}): number[] {
  const window = Math.max(5, Math.round(params.window ?? 40))
  const rangeThreshold = Math.max(0.01, params.rangeThreshold ?? 0.35)
  const zoneAtr = Math.max(0.05, params.zoneAtr ?? 0.4)
  const n = candles.length
  const high = candles.map((k) => k.high)
  const low = candles.map((k) => k.low)
  const close = candles.map((k) => k.close)
  const atrArr = ta.atr(high, low, close, 14)
  const out: number[] = new Array(n).fill(0)
  for (let t = window; t < n; t++) {
    const atrT = atrArr[t]
    if (!(atrT > 1e-12)) continue
    let hh = -Infinity
    let ll = Infinity
    for (let j = t - window; j < t; j++) {
      if (high[j] > hh) hh = high[j]
      if (low[j] < ll) ll = low[j]
    }
    const channelWidth = hh - ll
    if (!(channelWidth > 1e-12)) continue
    const netDrift = Math.abs(close[t] - close[t - window])
    if (netDrift / channelWidth > rangeThreshold) continue // trending, not ranging - sit out
    const distFromLow = (close[t] - ll) / atrT
    const distFromHigh = (hh - close[t]) / atrT
    if (distFromLow <= zoneAtr) out[t] = zoneAtr - distFromLow + 0.01
    else if (distFromHigh <= zoneAtr) out[t] = -(zoneAtr - distFromHigh + 0.01)
  }
  return out
}
