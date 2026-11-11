// IQAIR//OS - Pulse-Vector bars (analytics/pulsebars.ts).
//
// Packages three already-existing live-tick primitives into ONE bundled bar
// per FIXED micro-interval, instead of making a caller assemble them from
// three separate calls every time:
//   - tick DENSITY   (tickCount / velocity)        - same math tick.count()/
//     tick.velocity() already compute, just bucketed into fixed windows
//     rather than a sliding trailing one.
//   - speed ACCELERATION (this interval's velocity minus the previous
//     interval's)                                  - the identical finite-
//     difference tick.acceleration() already does, just bar-aligned instead
//     of an ad-hoc window pair.
//   - price DISPLACEMENT over the interval          - same as tick.delta().
// Nothing here is new math - it's the aggregation step those three
// primitives were each missing: one object per fixed interval, not three
// separate live reads a script or renderer has to stitch together.
//
// EXHAUSTION SCORE, the one genuinely new idea layered on top: within a
// run of consecutive same-direction bars, track the PEAK velocity reached
// so far in that run. `exhaustionScore` = how far the CURRENT bar's
// velocity has fallen from that run's own peak, in [0, 1] - "thick base
// that thins out at the top" (the surge kept extending in the same
// direction while its own speed fell off a cliff from its own peak) is
// exactly a high exhaustion score; "thick nodes, bright, still accelerating"
// is exactly a LOW one. NaN (not 0) before a run has at least 2 bars or a
// peak to compare against - same "can't say yet" honesty discipline every
// other engine's lookback-lag already follows (swing.ts, effortbricks.ts's
// regime read) - a caller should not read NaN as "confirmed no exhaustion."
//
// HONESTY: an interval with ZERO ticks is OMITTED, never fabricated as a
// flat/zero-activity bar - same "never interpolate what didn't happen"
// rule tickbars.ts/otcfootprint.ts already follow (gaps in the live tick
// feed are real gaps, not information). `sparse: true` flags a bar built
// from fewer than `sparseFloor` ticks - its OWN velocity/acceleration
// numbers are still real, just noisier than a bar with real density behind
// it, exactly the same disclosed-but-not-discarded treatment a thin
// footprint bucket already gets elsewhere in this codebase.
//
// LIVE-ONLY BY NATURE: built on the raw tick stream, same as tick.*/foot.*
// - no historical tick archive exists deep enough to replay this over old
// data yet (see claude/market-response-chart-mrc.md's own tick-archive
// note). Not a SAFE_BACKTEST_SOURCES engine.
//
// Pure function, O(n) over the tick buffer, no look-ahead.

export interface PulseTick {
  ts: number // epoch milliseconds
  price: number
}

export type PulseColor = 'accel-up' | 'decel-up' | 'accel-down' | 'decel-down' | 'flat'

export interface PulseBar {
  time: number // epoch seconds, start of this micro-interval
  endTime: number
  open: number
  high: number
  low: number
  close: number
  /** close - open (signed). */
  displacement: number
  range: number
  /** Real tick count in this interval - the density/"node thickness" signal. */
  tickCount: number
  /** tickCount / actual duration (the last bar's duration may be shorter
   * than intervalSec if the buffer ends mid-interval). */
  velocity: number
  /** This bar's velocity minus the PREVIOUS emitted bar's velocity (an
   * omitted zero-tick interval does not count as "previous" - acceleration
   * always compares against the last bar that actually had ticks).
   * Positive = speeding up, negative = slowing down. NaN on the very first
   * bar (nothing to compare against yet). */
  acceleration: number
  /** How far this bar's velocity has fallen from its own same-direction
   * run's peak velocity so far, in [0, 1]. NaN before the run has at least
   * 2 bars (see module header). */
  exhaustionScore: number
  /** Direction-and-acceleration label matching the Pulse-Vector color
   * mapping this engine was designed around: accel-up/decel-up (bright vs
   * fading green), accel-down/decel-down (bright vs fading red), flat
   * (zero displacement this interval). */
  color: PulseColor
  /** Built from fewer than `sparseFloor` ticks - read with that in mind. */
  sparse: boolean
}

export interface PulseBarsResult {
  intervalSec: number
  bars: PulseBar[]
  /** Consecutive same-direction bars ending at the last one (0 on 'flat'). */
  streak: number
  trend: 'up' | 'down' | 'none'
}

export function computePulseBars(
  ticks: readonly PulseTick[],
  opts: { intervalSec?: number; sparseFloor?: number } = {}
): PulseBarsResult {
  const intervalSec = Math.max(1, opts.intervalSec ?? 5)
  const sparseFloor = Math.max(1, Math.round(opts.sparseFloor ?? 3))
  const empty: PulseBarsResult = { intervalSec, bars: [], streak: 0, trend: 'none' }
  if (!ticks.length) return empty

  const sorted = [...ticks].filter((t) => Number.isFinite(t.ts) && Number.isFinite(t.price)).sort((a, b) => a.ts - b.ts)
  if (!sorted.length) return empty

  const startSec = Math.floor(sorted[0].ts / 1000)
  const endSec = Math.floor(sorted[sorted.length - 1].ts / 1000)
  const bars: PulseBar[] = []

  let prevVelocity = NaN
  let runDir: 1 | -1 | 0 = 0
  let runPeakVelocity = NaN
  let runLength = 0

  for (let bucketStart = startSec; bucketStart <= endSec; bucketStart += intervalSec) {
    const bucketEnd = Math.min(bucketStart + intervalSec, endSec + 1)
    const inBucket = sorted.filter((t) => t.ts >= bucketStart * 1000 && t.ts < bucketEnd * 1000)
    if (!inBucket.length) continue // never fabricate a zero-tick bar - see module header

    const open = inBucket[0].price
    const close = inBucket[inBucket.length - 1].price
    let high = -Infinity, low = Infinity
    for (const t of inBucket) {
      high = Math.max(high, t.price)
      low = Math.min(low, t.price)
    }
    const duration = Math.max(bucketEnd - bucketStart, 1)
    const tickCount = inBucket.length
    const velocity = tickCount / duration
    const displacement = close - open
    const acceleration = Number.isFinite(prevVelocity) ? velocity - prevVelocity : NaN

    const dir: 1 | -1 | 0 = displacement > 0 ? 1 : displacement < 0 ? -1 : 0
    if (dir !== 0 && dir === runDir) {
      runLength++
      runPeakVelocity = Math.max(runPeakVelocity, velocity)
    } else if (dir !== 0) {
      runDir = dir
      runLength = 1
      runPeakVelocity = velocity
    } else {
      // flat bar: doesn't break the run, doesn't extend it or update the peak either
    }
    const exhaustionScore = runLength >= 2 && Number.isFinite(runPeakVelocity) && runPeakVelocity > 0 ? Math.max(0, Math.min(1, (runPeakVelocity - velocity) / runPeakVelocity)) : NaN

    const color: PulseColor =
      dir === 0 ? 'flat' : dir > 0 ? (Number.isFinite(acceleration) && acceleration > 0 ? 'accel-up' : 'decel-up') : Number.isFinite(acceleration) && acceleration > 0 ? 'accel-down' : 'decel-down'

    bars.push({
      time: bucketStart,
      endTime: bucketEnd,
      open,
      high,
      low,
      close,
      displacement,
      range: high - low,
      tickCount,
      velocity,
      acceleration,
      exhaustionScore,
      color,
      sparse: tickCount < sparseFloor,
    })
    prevVelocity = velocity
  }

  if (!bars.length) return empty

  let streak = 0
  const lastDir = bars[bars.length - 1].displacement
  const trend: PulseBarsResult['trend'] = lastDir > 0 ? 'up' : lastDir < 0 ? 'down' : 'none'
  if (trend !== 'none') {
    const sign = Math.sign(lastDir)
    for (let i = bars.length - 1; i >= 0 && Math.sign(bars[i].displacement) === sign; i--) streak++
  }

  return { intervalSec, bars, streak, trend }
}
