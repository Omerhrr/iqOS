// IQAIR//OS - MRC Next-Movement Predictor
//
// Turns the Market Response Clock's own continuation/reversal split into a
// LIVE, self-calibrating panel read - not a hardcoded constant borrowed
// from one historical study. The original Phase 3 finding (see
// claude/market-response-chart-mrc.md: low-response bars reversed
// next-bar ~33.5% of the time, high-response bars continued ~86.3%) is
// what motivated this, but baking those two numbers in forever would be
// exactly the mistake example #13 in examples/msl-examples.md already made
// once (treating someone else's historical split as a permanent constant,
// off by which side of 50% it actually landed on). Instead, every read
// recomputes BOTH rates from THIS asset's own trailing confirmed-bar
// history, walk-forward (bar i's own next-bar outcome, never looking past
// it) - the same per-asset self-calibration discipline the Next-Expiry
// Oracle (analytics/nextexpiry.ts) already uses.
//
// Sibling of reversal.ts (same state-machine shape, same fail-closed
// "warming up" convention, same single-asset readFor() + plugin wrapping
// contract) but reads MRC bars (analytics/mrc.ts), not the Technical
// ladder's indicator votes - and is deliberately single-timeframe, not a
// per-rung ladder, since MRC's adaptive event clock already IS its own
// "timeframe."
//
// HONESTY: a fresh asset/tf with too little confirmed-bar history is
// ok:false "warming up". Once there's enough history to call a state at
// all, a calibration bucket (high-response or low-response) with too few
// samples of ITS OWN still reports 'uncertain' rather than a confident
// number built on a handful of bars - this is why MRC_PREDICT_MIN_CALIB_N
// exists as a SEPARATE gate from MRC_PREDICT_MIN_BARS.

import type { MrcBar, MrcResult } from './mrc'

export const MRC_PREDICT_MIN_BARS = 40
/** A calibration bucket (high-response or low-response) needs at least
 * this many of its OWN trailing samples before its empirical rate is
 * trusted enough to drive a confidence number - fewer than this reports
 * 'uncertain' even if the overall bar count clears MRC_PREDICT_MIN_BARS. */
export const MRC_PREDICT_MIN_CALIB_N = 10
/** A calibrated rate has to clear this to be worth acting on at all - a
 * rate sitting at/near 50% is "no edge", not a direction to trade, exactly
 * the distinction example #13's bug blurred. */
export const MRC_PREDICT_MIN_EDGE_RATE = 0.55

export type MrcPredictState = 'warming' | 'uncertain' | 'continuation-likely' | 'reversal-likely'

export interface MrcPredictResult {
  ok: boolean
  note: string
  state: MrcPredictState
  direction: 'call' | 'put' | 'none'
  /** 0-100, derived directly from the winning calibration rate - never a
   * hand-picked default, so a script/panel reading this can gate() on it
   * honestly. 0 whenever direction is 'none'. */
  confidence: number
  /** 0-1, the calibrated probability itself (continuation rate when
   * state is 'continuation-likely', reversal rate when 'reversal-likely',
   * 0.5 - no edge - otherwise). This is what a script should feed gate(). */
  value: number
  /** how many trailing same-bucket (high- or low-response) samples the
   * winning rate was built from - the precision disclosure. */
  sampleSize: number
  lastResponseRatio: number
  lastDisplacement: number
  fidelity: MrcResult['fidelity']
}

interface Calibration {
  highContinueRate: number
  lowReverseRate: number
  highN: number
  lowN: number
}

/** Walk the confirmed, non-gap bars once. For every bar except the very
 * last (which has no "next bar" outcome yet), bucket it by whether its OWN
 * responseRatio was high (>=1) or low (<1), and whether the FOLLOWING
 * confirmed bar's displacement continued (same sign) or reversed (opposite
 * sign) relative to it. Both rates are this asset's own empirical history,
 * never a number carried over from a different sample or a different
 * asset. */
export function calibrateMrcPredict(bars: MrcBar[]): Calibration {
  let highContinue = 0, highN = 0, lowReverse = 0, lowN = 0
  for (let i = 0; i < bars.length - 1; i++) {
    const cur = bars[i]
    const next = bars[i + 1]
    if (!Number.isFinite(cur.responseRatio) || cur.displacement === 0 || next.displacement === 0) continue
    const continued = Math.sign(cur.displacement) === Math.sign(next.displacement)
    if (cur.responseRatio >= 1.0) {
      highN++
      if (continued) highContinue++
    } else {
      lowN++
      if (!continued) lowReverse++
    }
  }
  return {
    highContinueRate: highN > 0 ? highContinue / highN : NaN,
    lowReverseRate: lowN > 0 ? lowReverse / lowN : NaN,
    highN,
    lowN,
  }
}

function warming(note: string, fidelity: MrcResult['fidelity']): MrcPredictResult {
  return { ok: false, note, state: 'warming', direction: 'none', confidence: 0, value: 0.5, sampleSize: 0, lastResponseRatio: NaN, lastDisplacement: NaN, fidelity }
}

function uncertain(note: string, sampleSize: number, lastResponseRatio: number, lastDisplacement: number, fidelity: MrcResult['fidelity']): MrcPredictResult {
  return { ok: true, note, state: 'uncertain', direction: 'none', confidence: 0, value: 0.5, sampleSize, lastResponseRatio, lastDisplacement, fidelity }
}

/** The whole-engine read, pure function over an already-computed MrcResult
 * (same input contract as reversal.ts's build* functions - the plugin owns
 * market access, the engine stays pure and independently testable). */
export function predictFromMrc(mrc: MrcResult): MrcPredictResult {
  const confirmed = mrc.bars.filter((b) => b.confirmed && !b.dataGap)
  if (confirmed.length < MRC_PREDICT_MIN_BARS) {
    return warming(`warming up - needs ${MRC_PREDICT_MIN_BARS}+ confirmed bars (has ${confirmed.length})`, mrc.fidelity)
  }

  const last = confirmed[confirmed.length - 1]
  const rr = last.responseRatio
  const d = last.displacement
  const { highContinueRate, lowReverseRate, highN, lowN } = calibrateMrcPredict(confirmed)

  if (d === 0 || !Number.isFinite(rr)) {
    return uncertain('latest confirmed bar had no net displacement - no prediction', highN + lowN, rr, d, mrc.fidelity)
  }

  const dirOfLast: 1 | -1 = d > 0 ? 1 : -1

  if (rr >= 1.0) {
    // High response: this asset's own history says "clean, low-resistance
    // move" bars like this one tend to CONTINUE - predict the SAME
    // direction as the latest bar's own displacement.
    if (!Number.isFinite(highContinueRate) || highN < MRC_PREDICT_MIN_CALIB_N) {
      return uncertain(`high-response bar (ratio ${rr.toFixed(2)}), but too few high-response samples yet (n=${highN}) to calibrate confidence`, highN + lowN, rr, d, mrc.fidelity)
    }
    if (highContinueRate < MRC_PREDICT_MIN_EDGE_RATE) {
      return uncertain(`high-response bar (ratio ${rr.toFixed(2)}) - but this asset's own continuation rate is only ${(highContinueRate * 100).toFixed(1)}% (n=${highN}), not enough edge to call continuation`, highN, rr, d, mrc.fidelity)
    }
    const direction = dirOfLast === 1 ? 'call' : 'put'
    return {
      ok: true,
      note: `high-response bar (ratio ${rr.toFixed(2)}) - this asset's own history continues ${(highContinueRate * 100).toFixed(1)}% of the time after this (n=${highN})`,
      state: 'continuation-likely',
      direction,
      confidence: Math.round(highContinueRate * 100),
      value: highContinueRate,
      sampleSize: highN,
      lastResponseRatio: rr,
      lastDisplacement: d,
      fidelity: mrc.fidelity,
    }
  }

  // Low response: this asset's own history says "effort without full
  // result" bars like this one tend to REVERSE - predict the OPPOSITE
  // direction of the latest bar's own displacement.
  if (!Number.isFinite(lowReverseRate) || lowN < MRC_PREDICT_MIN_CALIB_N) {
    return uncertain(`low-response bar (ratio ${rr.toFixed(2)}), but too few low-response samples yet (n=${lowN}) to calibrate confidence`, highN + lowN, rr, d, mrc.fidelity)
  }
  if (lowReverseRate < MRC_PREDICT_MIN_EDGE_RATE) {
    return uncertain(`low-response bar (ratio ${rr.toFixed(2)}) - but this asset's own reversal rate is only ${(lowReverseRate * 100).toFixed(1)}% (n=${lowN}), not enough edge to call reversal`, lowN, rr, d, mrc.fidelity)
  }
  const direction = dirOfLast === 1 ? 'put' : 'call'
  return {
    ok: true,
    note: `low-response bar (ratio ${rr.toFixed(2)}) - this asset's own history reverses ${(lowReverseRate * 100).toFixed(1)}% of the time after this (n=${lowN})`,
    state: 'reversal-likely',
    direction,
    confidence: Math.round(lowReverseRate * 100),
    value: lowReverseRate,
    sampleSize: lowN,
    lastResponseRatio: rr,
    lastDisplacement: d,
    fidelity: mrc.fidelity,
  }
}
