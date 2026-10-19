// IQAIR//OS - Ticks + Volume composite (kernel-side engine of record).
//
// Pairs the tick-bar trend read (analytics/tickbars.ts, via chartsignals.ts's
// tickVote - real sub-candle ticks when the ring buffer has them, else the
// honest 1m-close pseudo-tick fallback the same vote already labels) with
// the relative-volume surge read (analytics/volumefootprint.ts's
// volumeVote) into one agreement-gated composite. Same "two independent
// reads must agree" shape as shockpressure.ts / renkofootprint.ts /
// volumefootprint.ts.
//
// REAL MARKET ONLY, for the same reason volumefootprint.ts is: OTC's
// "volume" field is commonly a tick/sample count rather than genuine traded
// size (orderflow.ts's honesty header), so a relative-volume surge read
// against it would measure the generator's print rate, not real
// participation. (The tick half of this pairing works fine on OTC - it's
// the volume half that doesn't - so this composite as a whole stays
// real-market only rather than offering a half-honest OTC variant.)
//
// Pure function, no look-ahead (the votes it's handed are themselves pure).

import { combineEngineVotes, type EngineVoteLike } from './renkofootprint'
import type { VolumeVote } from './volumefootprint'

export const TICK_VOL_COMPOSITE_QUALIFY = 3.5

export interface TickVolumeFit {
  tickDir: 'call' | 'put' | null
  tickWeight: number
  tickNote: string
  volDir: 'call' | 'put' | null
  volWeight: number
  volNote: string
  relVolume: number
  agree: boolean
  /** -10..+10 signed composite (call positive), halved when the two reads
   * disagree - a lone read never wins on size alone. */
  composite: number
  direction: 'call' | 'put' | null
  qualifies: boolean
}

export function combineTickVolume(tick: EngineVoteLike, vol: VolumeVote): TickVolumeFit {
  const c = combineEngineVotes(tick, vol, TICK_VOL_COMPOSITE_QUALIFY)
  return {
    tickDir: c.aDir,
    tickWeight: tick.weight,
    tickNote: tick.note,
    volDir: c.bDir,
    volWeight: vol.weight,
    volNote: vol.note,
    relVolume: vol.relVolume,
    agree: c.agree,
    composite: c.composite,
    direction: c.direction,
    qualifies: c.qualifies,
  }
}
