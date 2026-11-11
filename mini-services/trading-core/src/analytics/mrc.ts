// IQAIR//OS - Market Response Chart (MRC) engine.
//
// An adaptive-event-clock bar: a new bar forms on whichever of three
// triggers fires first -
//   PRICE event    - price has moved far enough from the bar's reference
//   ACTIVITY event - enough real participation has accumulated
//   TIME safeguard - the bar has run too long with neither of the above
// - rather than at a fixed time interval (a candle) or a fixed price
// distance alone (Renko/Range Bars/P&F). The premise (Wyckoff "effort vs
// result", same lineage as effortbricks.ts's brick-confirmation idea, one
// level up): a bar that took a long time and a lot of activity to produce
// very little net price movement is a genuinely different market event than
// one that moved the same distance in one quiet tick - and a fixed-interval
// candle, Renko brick, or tick bar cannot tell the two apart, by
// construction. `response_efficiency` (displacement per unit of activity)
// is the number that makes that distinction explicit and queryable.
//
// FIDELITY (the central honesty question this module must answer, same
// discipline as tickbars.ts's own `dataSource` contract): can this bar's
// `path_efficiency`/`reversal_count`/true tick-based `directional_delta`
// be computed from a REAL observed path, or only guessed at?
//   - 'tick'   : built from `ctx.liveTicks` (real price-change events,
//     see otcfootprint.ts) - every tick is one real observation, so the
//     zigzag path between them is genuinely known. Only available live,
//     with a filled tick buffer (or the new ticks_archive table replayed
//     into the same shape for an offline validation pass).
//   - 'candle' : no real tick stream available - candle closes stand in as
//     pseudo-observations (same fallback tickbars.ts already uses, same
//     caveat: "this is NOT raw tick data"). Intra-candle path order is
//     UNKNOWABLE from OHLC alone (rangebars.ts's own header discloses this
//     exact limitation) - so `pathEfficiency`/`reversalCount` are NaN in
//     this mode rather than fabricated, and `directionalDelta` falls back
//     to candle up/down count (a real fact about the candles, just a
//     coarser one than real tick direction).
//
// DEAD-TIME GUARD (added after Phase 2 offline validation against real
// archived EURUSD history surfaced the problem for real): the only
// historical archive this OS has (`candles_archive`) is NOT continuous -
// recording gaps of minutes to tens of hours are common. Any gap between
// consecutive raw samples bigger than `maxGapMultiple x` the expected base
// interval force-closes whatever bar was accumulating, tagged `dataGap`,
// and that bar is excluded from the trailing response/activity averages -
// archive downtime must never be read as "real, low-activity dead time" the
// way effortbricks.ts's `effortSource:'none'` keeps all-zero-volume candles
// from fabricating a confirmed brick. This rule applies identically whether
// the base interval comes from the candle timeframe or from tick cadence
// (`medianTickGapMs` - the same measure tickbar.avgGapMs() already exposes).
//
// PROVISIONAL VS CONFIRMED: every bar except possibly the last formed
// because a real trigger fired (price/activity/time) - `confirmed: true`.
// The last bar, if the data simply ran out before any trigger fired, is
// still-forming and marked `confirmed: false` (same "don't claim a closed
// bar that hasn't actually closed" discipline swing.ts's own lookback-lag
// honesty follows) - a live read sees it; a closed-bar backtest walk must
// drop it, same convention every other chart engine's last-bar handling
// follows in this codebase.
//
// Pure function, O(n) over its input points, no look-ahead - safe to call
// from both a live read and a closed-bar backtest slice. Falls back
// gracefully to candle fidelity rather than throwing when no live tick
// buffer is available (SAME precedent `tickbarPoints()` in strategylang.ts
// already established for `tickbar.*` - this is why that namespace needs no
// UNSAFE_BACKTEST_SOURCES entry, and why this one doesn't either).

import type { Candle } from '../types'
import { medianTickGapMs } from './tickdesk'

export interface LiveTickPoint {
  ts: number // epoch milliseconds (same shape as otcfootprint.ts's TickPoint / ctx.liveTicks)
  price: number
}

export type MrcFidelity = 'tick' | 'candle'
export type MrcTrigger = 'price' | 'activity' | 'time' | 'gap'

export interface MrcBar {
  /** Start time of the bar. Tick fidelity: epoch seconds (float). Candle
   * fidelity: the candle's own integer `time`, same unit ambiguity
   * tickbar.duration()'s own doc comment already discloses for its
   * candle-fallback mode (NOT wall-clock seconds in that mode unless the
   * underlying tf is 1s). */
  time: number
  endTime: number
  open: number
  high: number
  low: number
  close: number
  /** endTime - time, same unit caveat as `time` above. */
  duration: number
  /** close - open (signed). */
  displacement: number
  /** high - low. */
  range: number
  /** Tick fidelity: count of real ticks in the bar (the only honest size
   * signal - same "observation count" convention tickbars.ts uses for its
   * own `volume` field). Candle fidelity: summed candle volume (or a count
   * fallback if every candle in the window carries no volume at all). */
  activityCount: number
  /** activityCount / duration. NaN when duration is 0. */
  velocity: number
  /** Tick fidelity: (up-ticks - down-ticks), real tick-by-tick direction.
   * Candle fidelity: (up-candles - down-candles) - a real fact about the
   * candles, a coarser one than genuine tick direction. */
  directionalDelta: number
  /** |directionalDelta| / (number of directional observations in the bar -
   * NOT activityCount, which in candle fidelity is volume-weighted rather
   * than a point count; this ratio is about HOW MANY observations agreed
   * on direction, not how much size was behind them), in [0, 1]. 1 = every
   * observation moved the same direction; 0 = perfectly balanced
   * back-and-forth. NaN when the bar has fewer than 1 directional
   * observation (its very first point, with nothing to compare against). */
  directionalRatio: number
  /** |displacement| / total tick-to-tick path length actually walked.
   * Only meaningful with a REAL observed path - NaN in candle fidelity
   * (see module header). 1 = moved in a straight line with zero backtrack;
   * near 0 = covered a lot of ground but ended up almost where it started. */
  pathEfficiency: number
  /** Count of direction reversals along the real tick-to-tick path. NaN in
   * candle fidelity (same reason as pathEfficiency). */
  reversalCount: number
  /** Share of this bar's observations whose price fell in its single
   * busiest price band (10 equal-width bins across [low, high]) - how
   * concentrated price action was around one level vs spread evenly across
   * the bar's range. In [1/activityCount, 1]; NaN when activityCount is 0
   * or range is 0 (every observation at one exact price - treated as fully
   * concentrated: 1). Computable in BOTH fidelity modes (bins candle closes
   * the same way it bins real ticks) - no NaN-gating needed here. */
  priceConcentration: number
  /** |displacement| / activityCount - the core Wyckoff effort-vs-result
   * number this whole engine exists to surface. NaN when activityCount is 0. */
  responseEfficiency: number
  /** responseEfficiency / the trailing average of the last `lookback`
   * CLEAN (non-dataGap) bars' own responseEfficiency, as of just before
   * this bar closed. NaN before enough trailing bars exist, or on a
   * dataGap bar (excluded by construction - see module header). <1 = below
   * average ("effort without full result"); >1 = above average ("clean,
   * low-resistance move"). */
  responseRatio: number
  trigger: MrcTrigger
  /** This bar's formation was forced/truncated by a recording gap (see
   * module header's DEAD-TIME GUARD) - excluded from every trailing-average
   * read, and its own duration/velocity/responseEfficiency numbers should
   * be read with that in mind (the elapsed time includes real downtime,
   * not genuine market dead time). */
  dataGap: boolean
  /** False only for a still-forming last bar that closed because the input
   * simply ran out, not because any real trigger fired (see module
   * header's PROVISIONAL VS CONFIRMED). */
  confirmed: boolean
}

export interface MrcResult {
  fidelity: MrcFidelity
  /** How the base sampling interval (for the dead-time guard) was derived. */
  baseIntervalRule: string
  bars: MrcBar[]
  trend: 'up' | 'down' | 'none'
  /** Consecutive same-direction CONFIRMED bars ending at the last confirmed one. */
  streak: number
}

const REGIME_LOOKBACK_DEFAULT = 20
const PRICE_CONCENTRATION_BINS = 10

interface Point {
  t: number // seconds
  price: number
  activity: number // 1 per real tick in tick fidelity; this candle's own volume (or 1) in candle fidelity
  isUp: boolean | null // null only possible on the very first point (no prior price to compare)
}

function buildPoints(candles: Candle[], liveTicks: LiveTickPoint[] | undefined): { points: Point[]; fidelity: MrcFidelity; baseIntervalRule: string } {
  if (liveTicks && liveTicks.length >= 2) {
    const gapMs = medianTickGapMs(liveTicks.map((t) => ({ ts: t.ts, price: t.price })))
    const points: Point[] = []
    let prevPrice: number | null = null
    for (const t of liveTicks) {
      if (!Number.isFinite(t.ts) || !Number.isFinite(t.price)) continue
      points.push({ t: t.ts / 1000, price: t.price, activity: 1, isUp: prevPrice === null ? null : t.price >= prevPrice })
      prevPrice = t.price
    }
    return { points, fidelity: 'tick', baseIntervalRule: gapMs ? `median tick gap ${gapMs}ms` : 'median tick gap unavailable (fewer than 2 gaps) - dead-time guard disabled' }
  }
  // candle fallback: each candle's CLOSE stands for one pseudo-observation
  // (same convention tickbarPoints() uses), volume carried through as the
  // activity weight (or 1 per candle if the whole window is volume-less -
  // same degenerate handling effortbricks.ts/volumebars.ts already use).
  const anyVolume = candles.some((c) => Number.isFinite(c.volume) && c.volume > 0)
  const tfGaps: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const g = candles[i].time - candles[i - 1].time
    if (g > 0) tfGaps.push(g)
  }
  tfGaps.sort((a, b) => a - b)
  const baseIntervalSec = tfGaps.length ? tfGaps[Math.floor(tfGaps.length / 2)] : NaN
  const points: Point[] = []
  let prevClose: number | null = null
  for (const c of candles) {
    const activity = anyVolume ? Math.max(0, Number.isFinite(c.volume) ? c.volume : 0) : 1
    points.push({ t: c.time, price: c.close, activity, isUp: prevClose === null ? null : c.close >= prevClose })
    prevClose = c.close
  }
  return {
    points,
    fidelity: 'candle',
    baseIntervalRule: Number.isFinite(baseIntervalSec) ? `median candle spacing ${baseIntervalSec}s` : 'median candle spacing unavailable - dead-time guard disabled',
  }
}

export function computeMrc(
  candles: Candle[],
  liveTicks: LiveTickPoint[] | undefined,
  opts: {
    priceMult?: number
    activityMult?: number
    maxDurationSec?: number
    maxGapMultiple?: number
    lookback?: number
  } = {}
): MrcResult {
  const priceMult = Math.max(0.5, opts.priceMult ?? 6)
  const maxDurationSec = Math.max(1, opts.maxDurationSec ?? 120)
  const maxGapMultiple = Math.max(1.5, opts.maxGapMultiple ?? 6)
  const lookback = Math.max(2, Math.min(100, Math.round(opts.lookback ?? REGIME_LOOKBACK_DEFAULT)))

  const { points, fidelity, baseIntervalRule } = buildPoints(candles, liveTicks)
  const gapMatch = baseIntervalRule.match(/([\d.]+)(ms|s)$/)
  const baseIntervalSec = gapMatch ? Number(gapMatch[1]) / (gapMatch[2] === 'ms' ? 1000 : 1) : NaN
  const gapThresholdSec = Number.isFinite(baseIntervalSec) ? baseIntervalSec * maxGapMultiple : Infinity

  const bars: MrcBar[] = []
  const responseHistory: number[] = []
  const activityHistory: number[] = []

  if (points.length < 2) {
    return { fidelity, baseIntervalRule, bars, trend: 'none', streak: 0 }
  }

  // running ATR-ish price volatility reference for the price-event
  // threshold: trailing mean |delta| over up to 14 recent points (tick
  // fidelity has no OHLC to run a real ATR against - this is the honest
  // tick-native equivalent, documented here rather than pretending it's ATR).
  const deltaWindow: number[] = []

  let barOpen = points[0].price
  let barStart = points[0].t
  let barHigh = points[0].price
  let barLow = points[0].price
  let barClose = points[0].price
  let activity = 0
  let upCount = 0
  let downCount = 0
  let pointsInBar = 0
  let pathLength = 0
  let reversals = 0
  let lastDirSign = 0 // sign of the last tick-to-tick move within the current bar
  const binCounts = () => new Array(PRICE_CONCENTRATION_BINS).fill(0)
  let bins = binCounts()
  let prevT = points[0].t
  let prevPrice = points[0].price
  const ref = () => (bars.length ? bars[bars.length - 1].close : points[0].price)

  const closeBar = (endPoint: Point, trigger: MrcTrigger, dataGap: boolean, confirmed: boolean) => {
    const duration = Math.max(endPoint.t - barStart, 1e-6)
    const displacement = barClose - barOpen
    const range = barHigh - barLow
    const velocity = activity > 0 ? activity / duration : NaN
    const directionalObs = upCount + downCount
    const directionalRatio = directionalObs > 0 ? Math.abs(upCount - downCount) / directionalObs : NaN
    const pathEfficiency = fidelity === 'tick' && pathLength > 0 ? Math.abs(displacement) / pathLength : NaN
    const reversalCount = fidelity === 'tick' ? reversals : NaN
    const maxBin = Math.max(...bins)
    const priceConcentration = pointsInBar > 0 ? (range > 0 ? maxBin / pointsInBar : 1) : NaN
    const responseEfficiency = activity > 0 ? Math.abs(displacement) / activity : NaN
    const trailingAvg = responseHistory.length ? responseHistory.reduce((a, b) => a + b, 0) / responseHistory.length : NaN
    const responseRatio = Number.isFinite(trailingAvg) && trailingAvg > 0 && Number.isFinite(responseEfficiency) ? responseEfficiency / trailingAvg : NaN

    bars.push({
      time: barStart,
      endTime: endPoint.t,
      open: barOpen,
      high: barHigh,
      low: barLow,
      close: barClose,
      duration,
      displacement,
      range,
      activityCount: activity,
      velocity,
      directionalDelta: upCount - downCount,
      directionalRatio,
      pathEfficiency,
      reversalCount,
      priceConcentration,
      responseEfficiency,
      responseRatio,
      trigger,
      dataGap,
      confirmed,
    })
    if (!dataGap && confirmed) {
      if (Number.isFinite(responseEfficiency)) {
        responseHistory.push(responseEfficiency)
        if (responseHistory.length > lookback) responseHistory.shift()
      }
      activityHistory.push(activity)
      if (activityHistory.length > Math.min(lookback, 10)) activityHistory.shift()
    }
    barOpen = NaN
    activity = 0
    upCount = 0
    downCount = 0
    pointsInBar = 0
    pathLength = 0
    reversals = 0
    lastDirSign = 0
    bins = binCounts()
  }

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const gapBefore = Number.isFinite(gapThresholdSec) && p.t - prevT > gapThresholdSec

    if (gapBefore && pointsInBar > 0) {
      // DEAD-TIME GUARD: close whatever was accumulating BEFORE this point,
      // tagged dataGap - see module header.
      closeBar(points[i - 1], 'gap', true, true)
    }

    if (pointsInBar === 0) {
      barOpen = p.price
      barStart = p.t
      barHigh = p.price
      barLow = p.price
    }
    barHigh = Math.max(barHigh, p.price)
    barLow = Math.min(barLow, p.price)
    barClose = p.price
    activity += p.activity
    if (p.isUp === true) upCount++
    else if (p.isUp === false) downCount++
    pointsInBar++

    if (i > 0) {
      const delta = p.price - prevPrice
      pathLength += Math.abs(delta)
      const dirSign = delta > 0 ? 1 : delta < 0 ? -1 : 0
      if (dirSign !== 0 && lastDirSign !== 0 && dirSign !== lastDirSign) reversals++
      if (dirSign !== 0) lastDirSign = dirSign
      deltaWindow.push(Math.abs(delta))
      if (deltaWindow.length > 14) deltaWindow.shift()
    }
    const binIdx = barHigh > barLow ? Math.min(PRICE_CONCENTRATION_BINS - 1, Math.floor(((p.price - barLow) / (barHigh - barLow)) * PRICE_CONCENTRATION_BINS)) : 0
    bins[binIdx]++

    prevT = p.t
    prevPrice = p.price

    // Price-event threshold: a multiple of the trailing average SINGLE-STEP
    // move (last up to 14 steps) - the honest tick-native equivalent of an
    // ATR-style volatility reference, since tick fidelity has no OHLC to
    // run a real multi-bar ATR against (documented in the module header -
    // NOT the same scale as effortbricks.ts's/renko.ts's own ATR(14), by
    // design: `priceMult` here is "how many typical single steps" rather
    // than "what fraction of a multi-candle true-range average"). Candle
    // fidelity reuses the identical formula over candle-close deltas -
    // one less special case, at the cost of being a slightly coarser
    // volatility read than a true candle ATR would give; acceptable given
    // `priceMult` is a tunable `configure` override either way.
    const avgStep = deltaWindow.length ? deltaWindow.reduce((a, b) => a + b, 0) / deltaWindow.length : NaN
    const distanceFromRef = Math.abs(barClose - ref())
    const activityThreshold = activityHistory.length >= 3 ? activityHistory.reduce((a, b) => a + b, 0) / activityHistory.length : opts.activityMult !== undefined ? opts.activityMult : 6
    const elapsed = p.t - barStart

    const priceEvent = pointsInBar >= 2 && Number.isFinite(avgStep) && avgStep > 0 && distanceFromRef >= avgStep * priceMult
    const activityEvent = pointsInBar >= 2 && activity >= activityThreshold
    const timeEvent = elapsed >= maxDurationSec
    const isLast = i === points.length - 1

    if (priceEvent || activityEvent || timeEvent || isLast) {
      // A still-forming last bar that only closed because the data ran out
      // (none of the three real triggers fired) is labeled 'time' too - the
      // same "took too long to resolve" bucket as a genuine time safeguard,
      // but see `confirmed` (false in that case) for the authoritative
      // "did a real trigger actually fire" signal.
      const trigger: MrcTrigger = priceEvent ? 'price' : activityEvent ? 'activity' : 'time'
      const realTrigger = priceEvent || activityEvent || timeEvent
      closeBar(p, trigger, false, realTrigger)
    }
  }

  const confirmedBars = bars.filter((b) => b.confirmed && !b.dataGap)
  let streak = 0
  let trend: MrcResult['trend'] = 'none'
  if (confirmedBars.length) {
    const d = confirmedBars[confirmedBars.length - 1].directionalDelta
    trend = d > 0 ? 'up' : d < 0 ? 'down' : 'none'
    const sign = Math.sign(d)
    for (let i = confirmedBars.length - 1; i >= 0 && Math.sign(confirmedBars[i].directionalDelta) === sign && sign !== 0; i--) streak++
  }

  return { fidelity, baseIntervalRule, bars, trend, streak }
}
