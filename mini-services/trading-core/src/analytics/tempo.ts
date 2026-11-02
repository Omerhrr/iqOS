// Tempo - the patience engine.
//
// The idea: instead of firing on every bar like every other signal source,
// treat each 10-bar window as a hunting license for exactly ONE shot - the
// bar inside the window whose next-candle prediction is the SUREST. On 1m
// that means at most 6 trades an hour (one per 10-minute window, 1-minute
// expiry); on 2m, one shot per 20 minutes with a 2-minute expiry; every
// timeframe scales the same way: 10 bars analyzed, one bar traded, expiry =
// 1 bar of the signal timeframe.
//
// The core problem this module solves honestly is OPTIMAL STOPPING: when
// the engine reads a strong conviction on bar 2 of 10, should it shoot now
// or wait for a possibly-better bar? Shooting on every "pretty good" bar
// breaks the one-per-window promise; waiting for bar 10 every time wastes
// the strong early reads. The rule here is a greedy order-statistic
// stopping rule:
//
//   fire  iff  conviction(bar) >= max(floor, expectedMax * sqrt(remaining/10))
//
// where `expectedMax` is the pair's OWN recent window-max conviction
// (rolling mean of the best reading each of the last N windows produced)
// and `remaining` is the count of bars still to come after this one in the
// window. Early in a window the bar to beat is nearly the pair's typical
// window-best (hard to clear - patience); by the last bar the bar to beat
// is just the absolute floor (the license gets used if ANY qualifying read
// exists, and the window honestly closes empty if none ever did).
//
// Conviction scale: the oracle fusion's calibrated confidence (0-100)
// weighted by its distance from the coin flip, conviction = confidence x
// edgePp / 100, so "conf 80 with a 30pp lean" = 24 while "conf 65 with a
// 6pp lean" = 3.9 - a number that only climbs when BOTH how sure the
// fusion is AND how far from a coin flip it leans are high. Same tradability
// weighting the Next Global board ranks by, compressed to one scalar.
//
// Pure module: no plugin, no I/O - windows, conviction and the stopping
// decision only, so tests and the plugin can share one implementation.

/** Bars per hunting window - the "analyze 10, trade 1" constant. */
export const TEMPO_WINDOW_BARS = 10

/** How many past window-maxima feed the expected-max estimate. */
export const TEMPO_HISTORY_WINDOWS = 12

/** Absolute conviction floor - never fire below this even on the last bar
 * of a window. 8 = roughly "calibrated conf 65+ leaning 13pp+ off the coin
 * flip" or "conf 80 leaning 10pp+" - below that the fusion is not saying
 * anything worth a license. Used as pairFloor()'s fallback when a pair has
 * no window history yet, and as the band pairFloor() is clamped within. */
export const TEMPO_FLOOR = 8
/** pairFloor() never drifts outside this band even for a pair whose own
 * history runs unusually calm or unusually wild - keeps one outlier pair
 * from setting an ultra-permissive or ultra-restrictive floor for itself. */
export const TEMPO_FLOOR_MIN = 5
export const TEMPO_FLOOR_MAX = 14
/** Firing again on a setup that echoes a recent same-direction, similar-
 * conviction LOSS on this exact pair raises its floor by this multiplier
 * instead of refusing outright - a real edge can still clear the raised
 * bar; a repeat of the same recent mistake usually can't. */
export const TEMPO_RECENT_LOSS_PENALTY = 1.25
/** pairAccuracyMult() (plugin-computed, from the pair's own lifetime shot
 * ledger) never raises the floor by more than this - a structurally bad
 * pair gets dampened, not effectively shut off outright. */
export const TEMPO_PAIR_ACCURACY_MAX_PENALTY = 1.6

/** Half-life, in WINDOWS (not bars), for the recency weighting inside
 * expectedWindowMax below. Deliberately much shorter than the universal
 * recencystats.ts default (150) - the window-max history only holds the
 * last TEMPO_HISTORY_WINDOWS (12) entries to begin with, so a half-life on
 * that scale makes the 2-3 most recent windows meaningfully outweigh ones
 * from the start of the buffer instead of all 12 counting almost equally. */
export const TEMPO_HISTORY_HALFLIFE = 5

/** The hand-set fraction of a pair's expected window-max that pairFloor()
 * used to always use. Kept as the fallback/default and as the center of
 * the learned-coefficient search band below - see
 * PATIENCE_COEFF_MIN/MAX and the plugin's learnedPatienceCoeff(). */
export const PATIENCE_COEFF_DEFAULT = 0.35
/** pairFloor()'s learned coefficient (plugin-computed from the resolved
 * shot ledger) never drifts outside this band - keeps a thin or noisy
 * ledger from pushing the floor fraction to an extreme that would make
 * every pair effectively never-fire or always-fire. */
export const PATIENCE_COEFF_MIN = 0.25
export const PATIENCE_COEFF_MAX = 0.5

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo
}

/** Per-pair floor instead of one global constant for every asset: a pair
 * whose own typical window-best conviction runs hot (volatile pairs swing
 * harder) gets a correspondingly higher floor, a pair that runs cool gets a
 * lower one - a single flat TEMPO_FLOOR was either too loose for calm
 * pairs or too tight for volatile ones. Falls back to the flat TEMPO_FLOOR
 * while the pair has no window history yet (expectedWindowMax returns 0
 * below 3 observed windows) - explore first, get picky once the pair's own
 * rhythm is known, the same philosophy expectedWindowMax itself uses.
 *
 * `coeff` used to be a hard-coded 0.35 here. The plugin can now pass a
 * fleet-learned coefficient instead (searched against the resolved shot
 * ledger for whichever fraction would have maximized net hit rate) - falls
 * back to PATIENCE_COEFF_DEFAULT (the original 0.35) below its own
 * "thin record is no record" sample floor, so behavior never regresses
 * before there's enough resolved history to trust a learned value. */
export function pairFloor(history: number[], fallback = TEMPO_FLOOR, coeff = PATIENCE_COEFF_DEFAULT): number {
  const expMax = expectedWindowMax(history)
  if (expMax <= 0) return fallback
  return clamp(expMax * clamp(coeff, PATIENCE_COEFF_MIN, PATIENCE_COEFF_MAX), TEMPO_FLOOR_MIN, TEMPO_FLOOR_MAX)
}

export interface TempoWindow {
  /** epoch-aligned window index: floor(barTime / windowMs) */
  windowIdx: number
  /** 0-based position of this bar inside its window (0..9) */
  barIndex: number
  /** bars still to come AFTER this one in the same window (9 - barIndex) */
  barsRemaining: number
  windowStartMs: number
  windowEndMs: number
}

/** Which 10-bar window does a bar belong to, and where inside it? Windows
 * are aligned to epoch boundaries (window 0 starts at 0) so every consumer
 * - panel, auto-trader, plugin - computes the SAME window for the same bar
 * without shared state. */
export function tempoWindow(barTimeMs: number, tfSec: number): TempoWindow {
  const windowMs = TEMPO_WINDOW_BARS * tfSec * 1000
  const windowIdx = Math.floor(barTimeMs / windowMs)
  const windowStartMs = windowIdx * windowMs
  const barMs = tfSec * 1000
  const barIndex = Math.min(TEMPO_WINDOW_BARS - 1, Math.floor((barTimeMs - windowStartMs) / barMs))
  return {
    windowIdx,
    barIndex,
    barsRemaining: TEMPO_WINDOW_BARS - 1 - barIndex,
    windowStartMs,
    windowEndMs: windowStartMs + windowMs,
  }
}

/** Conviction: the fusion's calibrated confidence weighted by how far its
 * lean sits from the coin flip, compressed to 0-100. NaN-safe - a garbage
 * read convicts 0, never qualifies, never trades. */
export function tempoConviction(confidence: number, pUp: number): number {
  if (!Number.isFinite(confidence) || !Number.isFinite(pUp)) return 0
  const edgePp = Math.abs(pUp - 0.5) * 200
  return Math.max(0, Math.min(100, (confidence * edgePp) / 100))
}

/** Renko bricks and Footprint (order-flow delta) as independent inputs to
 * conviction - not a binary confluence veto like claim()'s cross-engine
 * ADX/Pattern check, but a bounded multiplicative nudge, the same "driver,
 * not a gate" treatment nextcandle.ts gives these same two reads as its
 * own standalone fusion drivers (#8/#9 there). Tempo's conviction is
 * already a scalar rather than a probability, so re-fusing from scratch
 * doesn't fit - a nudge does: agreement raises conviction (more worth
 * spending the window's one shot on), disagreement lowers it, but never
 * to zero on its own - a single chart-reading engine disagreeing with the
 * full oracle fusion is a data point, not a veto. `renkoVote`/
 * `footprintVote` are signed votes in [-1, 1] (0 = that driver wasn't
 * active this bar - see GlobalScanRow's own doc), passed straight through
 * from the Oracle's own already-computed drivers, so this never
 * recomputes Renko/Footprint itself. The two are correlation-discounted
 * against each other (both read the same underlying price action) so an
 * agreeing pair doesn't double-count, the same discount idea
 * nextcandle.ts applies to its own correlated driver pairs. */
const CROSS_SIGNAL_MAX_BOOST = 1.18
const CROSS_SIGNAL_MAX_PENALTY = 0.82
const CROSS_SIGNAL_CORRELATION_DISCOUNT = 0.6

export function tempoCrossSignalMult(direction: 'call' | 'put' | 'none', renkoVote: number, footprintVote: number): number {
  if (direction === 'none' || (renkoVote === 0 && footprintVote === 0)) return 1
  const side = direction === 'call' ? 1 : -1
  let rW = Math.abs(renkoVote)
  let fW = Math.abs(footprintVote)
  const rSign = Math.sign(renkoVote)
  const fSign = Math.sign(footprintVote)
  if (rSign !== 0 && rSign === fSign) fW *= CROSS_SIGNAL_CORRELATION_DISCOUNT // footprint listed second, discounted
  const totalW = rW + fW
  if (totalW <= 0) return 1
  const agree = (rSign === side ? rW : rSign === -side ? -rW : 0) + (fSign === side ? fW : fSign === -side ? -fW : 0)
  const score = Math.max(-1, Math.min(1, agree / totalW)) // -1 full disagree .. +1 full agree
  const mult = score >= 0 ? 1 + score * (CROSS_SIGNAL_MAX_BOOST - 1) : 1 + score * (1 - CROSS_SIGNAL_MAX_PENALTY)
  return Math.max(CROSS_SIGNAL_MAX_PENALTY, Math.min(CROSS_SIGNAL_MAX_BOOST, mult))
}

/** Rolling mean of the pair's recent window-maxima (last N windows). Fewer
 * than 3 observed windows = no statistics yet -> 0, which makes the rule
 * fall back to the absolute floor (explore first, get picky once the
 * pair's own rhythm is known). From 6 observations on, trims the single
 * highest and lowest window-max before averaging: a plain mean let ONE
 * freak high-conviction window drag the patience bar up for the next
 * TEMPO_HISTORY_WINDOWS windows, making the pair go quiet right after its
 * best read - the trim keeps the estimate anchored to the pair's typical
 * rhythm instead of its single best or worst outlier.
 *
 * Recency-weighted (TEMPO_HISTORY_HALFLIFE): the buffer used to average
 * its last-12 window-maxima flat, so a volatility shift only showed up
 * once enough stale windows had rolled out of the 12-slot buffer - up to
 * 12 windows of lag. Each surviving (post-trim) entry now gets weight
 * 0.5^(age/halfLife) by its position in the ORIGINAL chronological array
 * (age measured before trimming, so removing the two outliers doesn't
 * distort how old the remaining entries actually are), letting the
 * estimate track a real rhythm change within 2-3 windows instead. */
export function expectedWindowMax(history: number[], halfLife = TEMPO_HISTORY_HALFLIFE): number {
  const h = history.slice(-TEMPO_HISTORY_WINDOWS).filter((v) => Number.isFinite(v) && v > 0)
  if (h.length < 3) return 0
  const indexed = h.map((v, idx) => ({ v, age: h.length - 1 - idx }))
  const keep = h.length < 6 ? indexed : (() => {
    const sorted = [...indexed].sort((a, b) => a.v - b.v)
    const dropLow = sorted[0]
    const dropHigh = sorted[sorted.length - 1]
    return indexed.filter((e) => e !== dropLow && e !== dropHigh)
  })()
  let wSum = 0
  let total = 0
  for (const { v, age } of keep) {
    const w = Math.pow(0.5, age / halfLife)
    wSum += w
    total += v * w
  }
  return wSum > 0 ? total / wSum : 0
}

export type TempoDecisionKind = 'fire' | 'wait' | 'skip'

export interface TempoDecision {
  kind: TempoDecisionKind
  /** the conviction bar this reading had to clear */
  threshold: number
  /** the patience component alone (what the rest of the window demands) */
  patienceBar: number
  conviction: number
  reason: string
}

/** The stopping rule. `fire` = this bar is the shot; `wait` = a future bar
 * of this window is statistically likelier to beat it; `skip` = below the
 * absolute floor, this bar can never be worth the license. */
export function tempoDecide(opts: {
  conviction: number
  barsRemaining: number
  windowMaxHistory: number[]
  floor?: number
  /** plugin-supplied: this pair's own shot ledger shows a same-direction
   * loss at a similar conviction level within the last few windows -
   * raises the floor by TEMPO_RECENT_LOSS_PENALTY instead of refusing
   * outright (see the constant's doc above). */
  recentSimilarLoss?: boolean
  /** plugin-supplied: this pair's own LIFETIME shot ledger (not just the
   * last few windows) has enough resolved shots to trust and reads
   * persistently below a healthy hit rate - a longer-horizon, structural
   * version of recentSimilarLoss above. 1 = no penalty (default); clamped
   * to [1, TEMPO_PAIR_ACCURACY_MAX_PENALTY] by the plugin before it gets
   * here, but clamped again here defensively. */
  pairAccuracyMult?: number
  /** plugin-supplied: the fleet-learned pairFloor() coefficient (see
   * PATIENCE_COEFF_DEFAULT/MIN/MAX above), replacing the hand-set 0.35
   * once the resolved shot ledger has enough history to trust one.
   * Ignored when `floor` is already supplied directly. */
  floorCoeff?: number
}): TempoDecision {
  const baseFloor = opts.floor ?? pairFloor(opts.windowMaxHistory, TEMPO_FLOOR, opts.floorCoeff ?? PATIENCE_COEFF_DEFAULT)
  const pairMult = Number.isFinite(opts.pairAccuracyMult) ? clamp(opts.pairAccuracyMult ?? 1, 1, TEMPO_PAIR_ACCURACY_MAX_PENALTY) : 1
  const floor = (opts.recentSimilarLoss ? baseFloor * TEMPO_RECENT_LOSS_PENALTY : baseFloor) * pairMult
  const conviction = Number.isFinite(opts.conviction) ? Math.max(0, opts.conviction) : 0
  const expMax = expectedWindowMax(opts.windowMaxHistory)
  // order-statistic decay: the best of k remaining bars from a distribution
  // whose window-max averages expMax scales ~ sqrt(k/10)
  const patienceBar = expMax * Math.sqrt(Math.max(0, opts.barsRemaining) / TEMPO_WINDOW_BARS)
  const threshold = Math.max(floor, patienceBar)
  const cautionBits: string[] = []
  if (opts.recentSimilarLoss) cautionBits.push('echoes a recent similar loss on this pair')
  if (pairMult > 1) cautionBits.push(`this pair's lifetime hit rate is below target (floor x${pairMult.toFixed(2)})`)
  const cautionNote = cautionBits.length ? ` (floor raised - ${cautionBits.join('; ')})` : ''
  if (conviction < floor) {
    return {
      kind: 'skip',
      threshold,
      patienceBar,
      conviction,
      reason:
        expMax > 0
          ? `conviction ${conviction.toFixed(1)} below the license floor ${floor.toFixed(1)}${cautionNote}`
          : `conviction ${conviction.toFixed(1)} below the license floor ${floor.toFixed(1)} (no window history yet - floor-only mode)${cautionNote}`,
    }
  }
  if (conviction >= threshold) {
    const why =
      patienceBar > floor
        ? `conviction ${conviction.toFixed(1)} clears the patience bar ${patienceBar.toFixed(1)} (${opts.barsRemaining} bar${opts.barsRemaining === 1 ? '' : 's'} left would only be expected to reach ${expMax.toFixed(1)} window-best)${cautionNote}`
        : expMax > 0
          ? `conviction ${conviction.toFixed(1)} clears floor ${floor.toFixed(1)} - patience bar decayed to it on the window's last leg${cautionNote}`
          : `conviction ${conviction.toFixed(1)} clears floor ${floor.toFixed(1)} (no window history yet - floor-only mode)${cautionNote}`
    return { kind: 'fire', threshold, patienceBar, conviction, reason: why }
  }
  return {
    kind: 'wait',
    threshold,
    patienceBar,
    conviction,
    reason: `conviction ${conviction.toFixed(1)} real but below the patience bar ${patienceBar.toFixed(1)} - wait for a better bar in this window${cautionNote}`,
  }
}
