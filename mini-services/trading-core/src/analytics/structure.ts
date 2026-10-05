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
import { rng } from './quant'

// ---------- Monte Carlo analog confirmation ----------
//
// The raw signed series below answer "is price structurally in the pullback
// / zone right now" - but that alone can't tell a continuation setup from
// one about to break and reverse (the exact "will it breakout or pullback"
// question this was built to answer). confirmStructuralSeries adds that
// judgment WITHOUT a second indicator: every time the raw series goes hot at
// bar t, it looks at every PAST bar where the same signed setup fired on
// this same pair, and what actually happened `horizon` bars later each time
// (a normalized, direction-signed log-return - positive means that episode
// would have won). That pool of real historical analogs is then Monte Carlo
// bootstrap-resampled (sampled with replacement, deterministically seeded so
// the learner and live evaluator agree bit-for-bit on the same history) to
// estimate the probability this exact setup follows through rather than
// faking out. Below `minSamples` analogs the gate is honestly a cold start -
// not enough history to judge yet - so it passes the raw signal through
// unchanged, same cold-start philosophy as plugins/adaptive.ts's confidence
// gate; once there's enough evidence, a setup whose own measured analogs
// don't clear `minProb` gets zeroed out here instead of reaching the vote.
//
// Strictly non-repainting: an episode starting at idx only becomes usable
// evidence once its own `horizon`-bars-ahead bar has actually closed, and a
// bar's episode is registered for future judging AFTER today's confirm
// decision is made, so nothing ever judges itself.
export interface ConfirmParams {
  confirm?: boolean // apply the Monte Carlo analog gate at all (default true)
  confirmHorizon?: number // bars ahead an episode's outcome is measured over (default 5)
  confirmMinProb?: number // bootstrap-estimated P(favorable) an episode's analog pool must clear to keep firing (default 0.55)
  confirmMinSamples?: number // analog pool size below which the gate is a cold-start pass-through (default 20)
  confirmSims?: number // bootstrap resample draws (default 500)
}

/** Exported for direct testing/reuse - see the module header for the full
 * explanation of what this does and why it's safe (non-repainting, cold
 * start honest, deterministic). */
export function applyMonteCarloConfirm(close: number[], raw: number[], p: ConfirmParams): number[] {
  if (p.confirm === false) return raw
  const horizon = Math.max(1, Math.round(p.confirmHorizon ?? 5))
  const minProb = Math.min(0.99, Math.max(0.5, p.confirmMinProb ?? 0.55))
  const minSamples = Math.max(5, Math.round(p.confirmMinSamples ?? 20))
  const nSims = Math.max(50, Math.round(p.confirmSims ?? 500))
  const n = raw.length
  const out = new Array(n).fill(0)
  // edges[+1]/edges[-1]: realized, direction-normalized log-returns of every
  // PAST episode of that sign, resolved as soon as its horizon has elapsed.
  const bullEdges: number[] = []
  const bearEdges: number[] = []
  const pending: { idx: number; dir: 1 | -1 }[] = []
  let cursor = 0
  // one deterministic RNG per call - identical input series always yields
  // the identical confirm decisions, which is what keeps the lab's backtest
  // and the live evaluator in agreement (custom.ts's consistency contract).
  const r = rng(0x5eed)
  for (let t = 0; t < n; t++) {
    while (cursor < pending.length && pending[cursor].idx + horizon <= t) {
      const ep = pending[cursor]
      const edge = ep.dir === 1 ? Math.log(close[ep.idx + horizon] / close[ep.idx]) : Math.log(close[ep.idx] / close[ep.idx + horizon])
      ;(ep.dir === 1 ? bullEdges : bearEdges).push(edge)
      cursor++
    }
    const sig = raw[t]
    if (sig === 0) continue
    const dir: 1 | -1 = sig > 0 ? 1 : -1
    const pool = dir === 1 ? bullEdges : bearEdges
    if (pool.length < minSamples) {
      out[t] = sig // cold start - not enough analog history to judge yet, pass through honestly
    } else {
      let favCount = 0
      for (let s = 0; s < nSims; s++) {
        const edge = pool[Math.floor(r() * pool.length)]
        if (edge > 0) favCount++
      }
      const probFav = favCount / nSims
      if (probFav >= minProb) out[t] = sig // confirmed by its own analog history - keep it
      // else: this exact setup's analogs don't support it right now - discard (out[t] stays 0)
    }
    // register today's episode for future bars to judge against, regardless
    // of today's verdict - the analog pool must reflect every real past
    // occurrence, not just the ones that happened to pass the gate.
    if (t + horizon < n) pending.push({ idx: t, dir })
  }
  return out
}

export interface TrendPullbackParams extends ConfirmParams {
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
  return applyMonteCarloConfirm(close, out, params)
}

export interface RangeZoneParams extends ConfirmParams {
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
  return applyMonteCarloConfirm(close, out, params)
}
