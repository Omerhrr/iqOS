// IQAIR//OS - Synthetic Feed Generator (our own calibrated chart generator)
//
// WHY THIS EXISTS: OTC pairs don't respect technical analysis - the charts
// are machine-generated. Rather than pretending otherwise (or fantasizing
// about reverse-engineering the broker's RNG, which is neither feasible nor
// the point), we build OUR OWN generator that mimics the STATISTICAL
// BEHAVIOR we measured on a studied pair - the step-size distribution, fat
// tails, skew and update cadence from analytics/randomness.ts, plus the
// short-memory structure captured by block bootstrapping the empirical
// return series itself.
//
// WHAT IT IS HONESTLY:
//  - A statistical mimic. It reproduces what the feed LOOKS like (return
//    distribution, volatility clustering, cadence), learned from real
//    observations of that pair. It is NOT a clone of the broker's algorithm
//    and makes no claim about how the broker actually produces prices.
//  - Deliberately seeded, not cryptographically random. Unlike the broker
//    (which uses a CSPRNG precisely so nobody can predict it), our generator
//    uses a fast seeded PRNG (mulberry32) so every synthetic series is
//    reproducible from (calibration, seed) - a placebo test must be
//    auditable, or it's just another uncheckable claim.
//
// WHAT IT IS FOR - THE DEFENSE: run the same strategy on the REAL pair and
// on K synthetic twins calibrated to it. If the strategy's win rate on real
// data is indistinguishable from its win rate on the synthetic twins (which
// contain NO learnable structure by construction - just resampled noise with
// the same statistical fingerprints), then the "edge" was luck, not TA. See
// plugins/otcguard.ts for the verdict logic. This is a controlled trial:
// synthetic series = placebo group, real series = treatment group.

import type { Candle } from '../types'
import { computeStepStats, computeIntervalStats, type PricePoint } from './randomness'

/** mulberry32 - tiny, fast, seedable PRNG (32-bit state). Quality is more
 *  than sufficient for Monte Carlo placebo work; reproducibility is the
 *  feature, not a weakness. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface FeedCalibration {
  /** Anchor price the generator starts from (last observed real price). */
  p0: number
  /** Empirical relative returns, chronological - the bootstrap population. */
  returns: number[]
  /** Empirical inter-sample intervals (ms), chronological - cadence model. */
  intervalsMs: number[]
  /** Bootstrap block length (bars) - preserves short-term autocorrelation
   *  and volatility clustering that an i.i.d. resample would erase. */
  blockLen: number
  /** What the calibration was learned from: 'tick' (sidecar sub-candle
   *  observations) or 'candle' (finest candle closes). Drives the honest
   *  labeling on every report built on this calibration. */
  source: 'tick' | 'candle'
  /** Source candles kept for the candle-level generator: when we calibrate
   *  from candle closes, each bootstrapped return carries the wick profile
   *  of the SAME real candle, so synthetic candles have realistic high/low
   *  structure (a close-only walk would produce degenerate O=H=L=C bars and
   *  silently zero out pattern-based strategies in the placebo group). */
  srcCandles?: Candle[]
  /** Descriptive fingerprint of the source series, carried through to
   *  reports so a verdict can be read against the actual stats. */
  stepStats: ReturnType<typeof computeStepStats>
  intervalStats: ReturnType<typeof computeIntervalStats>
}

/**
 * Calibrate the generator from an observed price series (real ticks or the
 * finest candle closes available). Pure: keeps references to the input
 * arrays' derived copies only.
 */
export function calibrateFromPoints(
  points: PricePoint[],
  opts?: { blockLen?: number; source?: 'tick' | 'candle'; driftNeutral?: boolean },
): FeedCalibration {
  const returns: number[] = []
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].price
    if (prev !== 0) returns.push((points[i].price - prev) / prev)
  }
  const intervalsMs: number[] = []
  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].time - points[i - 1].time) * 1000
    if (dt > 0) intervalsMs.push(dt)
  }
  // DRIFT-NEUTRAL calibration: subtract the mean return so the placebo
  // pool carries NO net drift. Why it matters: the default calibration
  // inherits the pair's own drift, so a drift-following strategy scores
  // the SAME win rate on the placebo as on the real feed and the trial
  // reads no_edge even when the drift is real and persistent (it is,
  // on some OTC feeds - see the forensics battery). With driftNeutral
  // the placebo is a fair-coin drift-free twin: a drift follower now
  // has to BEAT luck on a flat feed, which is exactly the question
  // "is the edge the drift itself?". Run BOTH nulls on any OTC strategy
  // to see where its money comes from.
  let pool = returns
  if (opts?.driftNeutral && returns.length > 1) {
    const mu = returns.reduce((a, b) => a + b, 0) / returns.length
    pool = returns.map((r) => r - mu)
  }
  return {
    p0: points.length ? points[points.length - 1].price : 1,
    returns: pool,
    intervalsMs,
    blockLen: Math.max(2, Math.min(32, opts?.blockLen ?? 8)),
    source: opts?.source ?? 'candle',
    stepStats: computeStepStats(points),
    intervalStats: computeIntervalStats(points),
  }
}

/**
 * Calibrate from OHLC candles (the common case: the strategy under test
 * consumes tf candles, so the placebo must live on the same bar grid).
 * Keeps the source candles themselves - the candle-level generator
 * bootstraps each bar's close-to-close return TOGETHER WITH its wick
 * profile, so synthetic bars keep realistic high/low shape.
 */
export function calibrateFromCandles(candles: Candle[], opts?: { blockLen?: number; driftNeutral?: boolean }): FeedCalibration {
  const points: PricePoint[] = candles.map((c) => ({ time: c.time, price: c.close }))
  const cal = calibrateFromPoints(points, { blockLen: opts?.blockLen ?? 4, source: 'candle', driftNeutral: opts?.driftNeutral })
  return { ...cal, srcCandles: [...candles] }
}

/**
 * Block bootstrap: draw consecutive blocks of `cal.blockLen` empirical
 * returns (with replacement, random start positions) until n are drawn, and
 * finally truncate. Block resampling preserves the measured short-memory
 * structure (autocorrelation, vol clustering, fat tails) that i.i.d.
 * resampling would destroy - so the placebo series are "equally wild" as
 * the real feed, and any strategy win-rate parity between them and reality
 * is meaningful.
 */
export function bootstrapReturns(cal: FeedCalibration, n: number, rng: () => number): number[] {
  const src = cal.returns
  const out: number[] = []
  if (!src.length || n <= 0) return out
  if (src.length <= cal.blockLen) {
    // Degenerate short history: i.i.d. resample is the only option left.
    for (let i = 0; i < n; i++) out.push(src[Math.floor(rng() * src.length)])
    return out
  }
  while (out.length < n) {
    const start = Math.floor(rng() * (src.length - cal.blockLen))
    const take = Math.min(cal.blockLen, n - out.length)
    for (let i = 0; i < take; i++) out.push(src[start + i])
  }
  return out
}

/**
 * Generate one synthetic tick/point series from a calibration. Deterministic
 * in (cal, seed): the same inputs always yield the same series.
 * The walk starts at the calibration anchor p0 and compounds bootstrapped
 * relative returns. Timestamps compound resampled empirical intervals so
 * cadence matches the source too (that matters because a metronomic
 * generator feed and a jittery organic feed should NOT look identical).
 */
export function generatePoints(cal: FeedCalibration, n: number, seed: number, t0Sec?: number): PricePoint[] {
  const rng = mulberry32(seed)
  if (!cal.returns.length || n <= 0) return []
  const rets = bootstrapReturns(cal, n - 1, rng)
  const ivals = cal.intervalsMs.length
    ? bootstrapIntervals(cal.intervalsMs, n - 1, rng)
    : null
  const nowSec = t0Sec ?? Date.now() / 1000
  const spanMs = ivals ? ivals.reduce((a, b) => a + b, 0) : (n - 1) * 1000
  // Anchor the LAST point at nowSec and walk backwards in time, so synthetic
  // series line up with "recent data" regardless of n - mirrors how the rest
  // of the OS treats candle arrays (newest last).
  const startMs = (nowSec - spanMs / 1000) * 1000
  const points: PricePoint[] = new Array(n)
  let price = cal.p0
  points[n - 1] = { time: nowSec, price }
  let tMs = startMs
  for (let i = n - 2; i >= 0; i--) {
    price = price / (1 + rets[i])
    tMs -= ivals ? ivals[i] : 1000
    points[i] = { time: tMs / 1000, price }
  }
  return points
}

function bootstrapIntervals(intervalsMs: number[], n: number, rng: () => number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(intervalsMs[Math.floor(rng() * intervalsMs.length)])
  return out
}

/**
 * Candle-level generator (used when the calibration comes from OHLC bars):
 * block-bootstraps close-to-close returns and, for every bootstrapped bar,
 * reattaches the WICK PROFILE of the very real candle that supplied the
 * return - upper/lower wick extents in return space, scaled to the
 * synthetic body. The result: synthetic candles with realistic high/low
 * structure, no lookahead, zero learnable structure beyond what resampled
 * noise + carried shape provides. Deterministic in (cal, seed).
 *
 * Timestamps run FORWARD from the first real candle's time on the tf grid
 * (open-time anchoring, same convention as pointsToCandles) so the
 * synthetic series lines up with "recent history" the same way the real
 * window does.
 */
export function generateCandles(cal: FeedCalibration, n: number, seed: number, tfSec: number): Candle[] {
  const src = cal.srcCandles
  if (!src || src.length < 8 || n <= 0) return []
  const rng = mulberry32(seed)
  // Real candle shapes in return space, aligned with cal.returns[i] which
  // is the close-to-close return INTO src[i+1] from src[i].
  const shapes: { upWick: number; downWick: number }[] = []
  for (let i = 1; i < src.length; i++) {
    const c = src[i]
    const bodyTop = Math.max(c.open, c.close)
    const bodyBot = Math.min(c.open, c.close)
    const upWick = bodyTop > 0 ? Math.max(0, (c.high - bodyTop) / bodyTop) : 0
    const downWick = bodyBot > 0 ? Math.max(0, (bodyBot - c.low) / bodyBot) : 0
    shapes.push({ upWick, downWick })
  }
  if (!shapes.length) return []

  // Block-bootstrap indices into the shape/return population (same block
  // mechanics as bootstrapReturns, but carrying candle indices so shape and
  // return stay coupled to the same source bar).
  const idx: number[] = []
  const popLen = shapes.length
  const bl = Math.min(cal.blockLen, popLen)
  while (idx.length < n - 1) {
    const start = Math.floor(rng() * (popLen - bl + 1))
    const take = Math.min(bl, n - 1 - idx.length)
    for (let i = 0; i < take; i++) idx.push(start + i)
  }

  const out: Candle[] = new Array(n)
  let price = src[0].close
  const t0 = src[0].time
  out[0] = { time: t0, open: price, high: price, low: price, close: price, volume: 0 }
  for (let i = 1; i < n; i++) {
    const s = shapes[idx[i - 1]]
    const r = cal.returns[idx[i - 1]]
    const open = price
    const close = open * (1 + r)
    const bodyTop = Math.max(open, close)
    const bodyBot = Math.min(open, close)
    const high = bodyTop * (1 + s.upWick)
    const low = bodyBot * (1 - s.downWick)
    out[i] = {
      time: t0 + i * tfSec,
      open,
      high,
      low: low > 0 ? low : 0,
      close,
      volume: 0,
    }
    price = close
  }
  return out
}

/** Seconds per candle for the Timeframe strings the OS uses. */
export function tfSeconds(tf: string): number {
  const m = /^(\d+)([smhd])$/.exec(tf.trim())
  if (!m) return 60
  const n = Number(m[1])
  switch (m[2]) {
    case 's': return n
    case 'm': return n * 60
    case 'h': return n * 3600
    case 'd': return n * 86400
    default: return 60
  }
}

/**
 * Aggregate a point series into standard OHLC candles bucketed by open time
 * (floor to tfSec boundaries) - same "candle open time" anchoring convention
 * the rest of the OS uses (see analytics/candlemath.ts's time note). Volume
 * is unknown for OTC feeds (the broker doesn't publish it) so it is left 0,
 * exactly like the live feed's candles.
 */
export function pointsToCandles(points: PricePoint[], tfSec: number): Candle[] {
  if (!points.length || tfSec <= 0) return []
  const buckets = new Map<number, { o: number; h: number; l: number; c: number }>()
  for (const p of points) {
    const b = Math.floor(p.time / tfSec) * tfSec
    const cur = buckets.get(b)
    if (!cur) buckets.set(b, { o: p.price, h: p.price, l: p.price, c: p.price })
    else {
      if (p.price > cur.h) cur.h = p.price
      if (p.price < cur.l) cur.l = p.price
      cur.c = p.price
    }
  }
  const out: Candle[] = []
  for (const [time, v] of buckets) out.push({ time, open: v.o, high: v.h, low: v.l, close: v.c, volume: 0 })
  out.sort((a, b) => a.time - b.time)
  return out
}
