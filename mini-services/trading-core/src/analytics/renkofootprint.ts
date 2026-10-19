// IQAIR//OS - Renko + Footprint composite (kernel-side engine of record).
//
// Pairs the renko brick-trend read with the volume-footprint delta read
// (real-market instruments, CLV-proxy volume - see footprint.ts's own
// honesty header) or the OTC micro-tick velocity footprint read (OTC
// instruments, no order book exists there - see otcfootprint.ts's header)
// into one agreement-gated composite. Same "two independent reads must
// agree before this counts as a signal" shape shockpressure.ts uses for
// shock+pressure. No new math: reuses the exact renko/footprint/otc-
// footprint engine votes the Chart Signals scanner already renders, just
// combined differently (a 2-of-2 agreement gate instead of the full
// 6/7-engine composite).
//
// Pure function, no look-ahead (the votes it's handed are themselves pure).

import type { ChartEngineVote } from './chartsignals'

export const RENKO_FP_COMPOSITE_QUALIFY = 3.5

export interface RenkoFootprintFit {
  renkoDir: 'call' | 'put' | null
  renkoWeight: number
  renkoNote: string
  fpDir: 'call' | 'put' | null
  fpWeight: number
  fpNote: string
  agree: boolean
  /** -10..+10 signed composite (call positive), halved when the two engines
   * disagree - a lone engine never wins on size alone. */
  composite: number
  direction: 'call' | 'put' | null
  qualifies: boolean
}

function toSide(dir: 1 | -1 | 0): 'call' | 'put' | null {
  return dir === 1 ? 'call' : dir === -1 ? 'put' : null
}

/** `fp` is either the real volume-footprint vote or the OTC micro-tick
 * velocity-footprint vote - caller picks which, this function only ever
 * sees two generic engine votes. */
export function combineRenkoFootprint(renko: ChartEngineVote, fp: ChartEngineVote): RenkoFootprintFit {
  const renkoDir = toSide(renko.dir)
  const fpDir = toSide(fp.dir)
  const renkoPush = renko.dir * Math.min(1, renko.weight) * 6
  const fpPush = fp.dir * Math.min(1, fp.weight) * 6
  const sum = renkoPush + fpPush
  const agree = renkoDir !== null && fpDir !== null && renkoDir === fpDir
  const composite = Math.max(-10, Math.min(10, agree ? sum : sum / 2))
  const direction: 'call' | 'put' | null = composite > 0.1 ? 'call' : composite < -0.1 ? 'put' : null
  const qualifies = agree && Math.abs(composite) >= RENKO_FP_COMPOSITE_QUALIFY
  return {
    renkoDir,
    renkoWeight: renko.weight,
    renkoNote: renko.note,
    fpDir,
    fpWeight: fp.weight,
    fpNote: fp.note,
    agree,
    composite,
    direction,
    qualifies,
  }
}
