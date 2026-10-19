// IQAIR//OS - Volume + Footprint composite (kernel-side engine of record).
//
// Pairs a plain relative-volume surge read (this window's volume vs its own
// recent baseline, direction from the CLV-proxy buy/sell delta over the same
// window - orderflow.ts's computeCandleDelta) with the volume-footprint
// delta read (analytics/footprint.ts, via chartsignals.ts's footprintVote)
// into one agreement-gated composite. Same "two independent reads must
// agree before this counts as a signal" shape shockpressure.ts and
// renkofootprint.ts use.
//
// REAL MARKET ONLY. orderflow.ts's own honesty header: "for OTC/binary
// synthetic instruments IQ Option's 'volume' field is commonly a tick/sample
// count rather than genuine traded size" - a relative-volume "surge" read
// against that would measure the generator's print rate, not real
// participation. The Renko + OTC Footprint panel already covers OTC
// honestly via the micro-tick velocity read instead; this panel does not
// have an OTC variant.
//
// Pure function, O(n), no look-ahead.

import type { Candle } from '../types'
import { computeCandleDelta } from './orderflow'
import { combineEngineVotes, type EngineVoteLike } from './renkofootprint'

export const VOLUME_FP_COMPOSITE_QUALIFY = 3.5
export const VOLUME_LOOKBACK = 10
export const VOLUME_BASELINE = 30 // candles immediately before the lookback window, for the average
export const VOLUME_SURGE_MIN = 1.3 // lookback window must run at least this many x the baseline's per-bar average

export interface VolumeVote extends EngineVoteLike {
  /** lookback window's average volume per bar / baseline average volume per
   * bar. NaN when there's no honest baseline (thin history or a dead tape). */
  relVolume: number
}

export interface VolumeFootprintFit {
  volDir: 'call' | 'put' | null
  volWeight: number
  volNote: string
  relVolume: number
  fpDir: 'call' | 'put' | null
  fpWeight: number
  fpNote: string
  agree: boolean
  /** -10..+10 signed composite (call positive), halved when the two reads
   * disagree - a lone read never wins on size alone. */
  composite: number
  direction: 'call' | 'put' | null
  qualifies: boolean
}

/** Relative-volume surge vote: is recent volume running hot against its own
 * baseline, and which way is it leaning (CLV-proxy buy/sell delta over the
 * same lookback window)? Stands aside (dir 0) on thin history, a dead
 * baseline, a sub-threshold surge, or a flat delta - a surge with no lean,
 * or a lean with no surge, is not a vote either engine should get credit
 * for. */
export function volumeVote(candles: Candle[], lookback = VOLUME_LOOKBACK, baseline = VOLUME_BASELINE): VolumeVote {
  if (candles.length < lookback + baseline + 1) {
    return { dir: 0, weight: 0, note: 'thin history', relVolume: NaN }
  }
  const window = candles.slice(-lookback)
  const base = candles.slice(-(lookback + baseline), -lookback)
  const baseAvgPerBar = base.reduce((s, c) => s + Math.max(0, c.volume), 0) / Math.max(1, base.length)
  const windowAvgPerBar = window.reduce((s, c) => s + Math.max(0, c.volume), 0) / Math.max(1, window.length)
  const relVolume = baseAvgPerBar > 0 ? windowAvgPerBar / baseAvgPerBar : NaN

  if (!Number.isFinite(relVolume)) {
    return { dir: 0, weight: 0, note: 'no baseline volume', relVolume }
  }

  const deltas = computeCandleDelta(window)
  const netDelta = deltas.reduce((s, d) => s + d.delta, 0)
  const netVolume = deltas.reduce((s, d) => s + d.buyVolume + d.sellVolume, 0)
  const share = netVolume > 0 ? netDelta / netVolume : 0
  const dir: 1 | -1 | 0 = share > 0.06 ? 1 : share < -0.06 ? -1 : 0

  if (relVolume < VOLUME_SURGE_MIN || dir === 0) {
    return { dir: 0, weight: 0, note: `relvol ${relVolume.toFixed(2)}x avg, delta ${(share * 100).toFixed(1)}% (no surge)`, relVolume }
  }
  const weight = Math.min(0.3 + (relVolume - VOLUME_SURGE_MIN) * 0.3 + Math.abs(share), 0.95)
  return {
    dir,
    weight,
    note: `relvol ${relVolume.toFixed(2)}x avg, delta ${(share * 100).toFixed(1)}%`,
    relVolume,
  }
}

export function combineVolumeFootprint(vol: VolumeVote, fp: EngineVoteLike): VolumeFootprintFit {
  const c = combineEngineVotes(vol, fp, VOLUME_FP_COMPOSITE_QUALIFY)
  return {
    volDir: c.aDir,
    volWeight: vol.weight,
    volNote: vol.note,
    relVolume: vol.relVolume,
    fpDir: c.bDir,
    fpWeight: fp.weight,
    fpNote: fp.note,
    agree: c.agree,
    composite: c.composite,
    direction: c.direction,
    qualifies: c.qualifies,
  }
}
