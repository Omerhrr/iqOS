// IQAIR//OS - Signal core: the Signal clock computed from closed candles ALONE.
//
// One pure function the Signal tab, `/signal`, the MSL `signal.*` namespace and
// the MSL backtester all share, so the dial, a live script and a historical
// replay answer identically for the same bars. It re-runs the five Explainer
// readers (SMC scan, candle patterns, MRC predictor, swing structure, technical
// votes), Effort Renko and the regime classifier on the candle window and
// hands them to analytics/signalclock.ts buildSignal().
//
// WINDOW: the last SIGNAL_BARS (240) closed candles - the depth a live MSL
// script is handed - so a backtest (which can pass thousands of bars) is
// trimmed to the same window and cannot see more history than live does.
// This is slightly shallower than the Explainer tab (400 bars; SMC/MRC 300).
//
// TIMES: candle `time` must be real epoch seconds. The SMC reader keys kill-zone
// concepts on the UTC hour and the technical/expiry maths on the bar length, so
// a series without timestamps is refused (null) rather than read wrongly.

import type { Candle } from '../types'
import { scanSmc } from './smc'
import { detectPatterns } from './patterns'
import { computeMrc } from './mrc'
import { predictFromMrc } from './mrcpredict'
import { computeSwing } from './swing'
import { summarizeTf, TECH_BARS_PER_RUNG } from './technicals'
import { effortBricks } from './effortbricks'
import {
  explainEffort,
  explainMrc,
  explainPatterns,
  explainSmc,
  explainSwing,
  explainTechnical,
  type EffortRead,
  type PanelVerdict,
} from './explainer'
import { classifyRegimeRow, MIN_BARS, type RegimeRow } from './regimescan'
import { buildSignal, type SignalResult } from './signalclock'

export const SIGNAL_BARS = 240
export const SIGNAL_MIN_BARS = MIN_BARS
const SWING_LOOKBACK = 3
const PATTERN_LOOKBACK = 8

export interface SignalCore {
  signal: SignalResult
  regime: RegimeRow | null
  panels: PanelVerdict[]
  effort: EffortRead
  tfSec: number
  bars: number
}

/** Median positive gap between consecutive candle times (seconds). */
export function inferTfSec(candles: Candle[]): number {
  const d: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const g = candles[i].time - candles[i - 1].time
    if (g > 0) d.push(g)
  }
  if (!d.length) return 0
  d.sort((a, b) => a - b)
  return d[Math.floor(d.length / 2)]
}

export function readSignalCore(candles: Candle[], opts: { tfSec?: number } = {}): SignalCore | null {
  const win = candles.slice(-SIGNAL_BARS)
  if (win.length < SIGNAL_MIN_BARS) return null
  const tfSec = opts.tfSec && opts.tfSec > 0 ? opts.tfSec : inferTfSec(win)
  if (!(tfSec > 0)) return null
  const last = win[win.length - 1]

  const smc = scanSmc(win)
  const hits = win.length >= 12 ? detectPatterns(win.slice(-60), PATTERN_LOOKBACK) : []
  let mrcPred = null as ReturnType<typeof predictFromMrc> | null
  try {
    mrcPred = predictFromMrc(computeMrc(win, undefined, {}))
  } catch {
    mrcPred = null
  }
  const swing = computeSwing(win.slice(-250), { lookback: SWING_LOOKBACK })
  const techRow = summarizeTf(`${tfSec}s`, tfSec, 'native', win.slice(-TECH_BARS_PER_RUNG))

  const panels: PanelVerdict[] = [
    explainSmc(smc),
    explainPatterns(hits, PATTERN_LOOKBACK),
    explainMrc(mrcPred),
    explainSwing(swing, last.close),
    explainTechnical(techRow),
  ]
  let effort: EffortRead
  try {
    effort = explainEffort(effortBricks(win.slice(-300)))
  } catch {
    effort = explainEffort(null)
  }
  const regime = classifyRegimeRow(win.slice(-150))
  const signal = buildSignal({ panels, effort, regime, candles: win, tfSec })
  return { signal, regime, panels, effort, tfSec, bars: win.length }
}
