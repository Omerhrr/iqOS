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

export const RENKO_FP_COMPOSITE_QUALIFY = 3.5

/** Minimal shape a 2-of-2 agreement-gated composite needs from either side -
 * any {dir, weight, note} reader qualifies, not just a chartsignals.ts
 * ChartEngineId-tagged `ChartEngineVote` (e.g. volumefootprint.ts's
 * relative-volume read, which isn't one of the named chart engines). */
export interface EngineVoteLike {
  dir: 1 | -1 | 0
  weight: number
  note: string
}

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

export function toSide(dir: 1 | -1 | 0): 'call' | 'put' | null {
  return dir === 1 ? 'call' : dir === -1 ? 'put' : null
}

/** Shared 2-of-2 agreement-gate math: signed push per side (dir * weight,
 * clamped to [0,1] weight, scaled to +/-6), summed when the sides agree and
 * halved when they fight, clamped to +/-10, qualifying needs agreement AND
 * the composite clearing `threshold`. Both renkofootprint's and
 * volumefootprint's composites are this exact shape - only the field names
 * on the returned row differ per caller. */
export function combineEngineVotes(a: EngineVoteLike, b: EngineVoteLike, threshold = RENKO_FP_COMPOSITE_QUALIFY) {
  const aDir = toSide(a.dir)
  const bDir = toSide(b.dir)
  const aPush = a.dir * Math.min(1, a.weight) * 6
  const bPush = b.dir * Math.min(1, b.weight) * 6
  const sum = aPush + bPush
  const agree = aDir !== null && bDir !== null && aDir === bDir
  const composite = Math.max(-10, Math.min(10, agree ? sum : sum / 2))
  const direction: 'call' | 'put' | null = composite > 0.1 ? 'call' : composite < -0.1 ? 'put' : null
  const qualifies = agree && Math.abs(composite) >= threshold
  return { aDir, bDir, agree, composite, direction, qualifies }
}

/** `fp` is either the real volume-footprint vote or the OTC micro-tick
 * velocity-footprint vote - caller picks which, this function only ever
 * sees two generic engine votes. */
export function combineRenkoFootprint(renko: EngineVoteLike, fp: EngineVoteLike): RenkoFootprintFit {
  const c = combineEngineVotes(renko, fp, RENKO_FP_COMPOSITE_QUALIFY)
  return {
    renkoDir: c.aDir,
    renkoWeight: renko.weight,
    renkoNote: renko.note,
    fpDir: c.bDir,
    fpWeight: fp.weight,
    fpNote: fp.note,
    agree: c.agree,
    composite: c.composite,
    direction: c.direction,
    qualifies: c.qualifies,
  }
}
