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
 * anything worth a license. */
export const TEMPO_FLOOR = 8

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

/** Rolling mean of the pair's recent window-maxima (last N windows). Fewer
 * than 3 observed windows = no statistics yet -> 0, which makes the rule
 * fall back to the absolute floor (explore first, get picky once the
 * pair's own rhythm is known). */
export function expectedWindowMax(history: number[]): number {
  const h = history.slice(-TEMPO_HISTORY_WINDOWS).filter((v) => Number.isFinite(v) && v > 0)
  if (h.length < 3) return 0
  return h.reduce((s, v) => s + v, 0) / h.length
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
}): TempoDecision {
  const floor = opts.floor ?? TEMPO_FLOOR
  const conviction = Number.isFinite(opts.conviction) ? Math.max(0, opts.conviction) : 0
  const expMax = expectedWindowMax(opts.windowMaxHistory)
  // order-statistic decay: the best of k remaining bars from a distribution
  // whose window-max averages expMax scales ~ sqrt(k/10)
  const patienceBar = expMax * Math.sqrt(Math.max(0, opts.barsRemaining) / TEMPO_WINDOW_BARS)
  const threshold = Math.max(floor, patienceBar)
  if (conviction < floor) {
    return {
      kind: 'skip',
      threshold,
      patienceBar,
      conviction,
      reason:
        expMax > 0
          ? `conviction ${conviction.toFixed(1)} below the license floor ${floor.toFixed(1)}`
          : `conviction ${conviction.toFixed(1)} below the license floor ${floor.toFixed(1)} (no window history yet - floor-only mode)`,
    }
  }
  if (conviction >= threshold) {
    const why =
      patienceBar > floor
        ? `conviction ${conviction.toFixed(1)} clears the patience bar ${patienceBar.toFixed(1)} (${opts.barsRemaining} bar${opts.barsRemaining === 1 ? '' : 's'} left would only be expected to reach ${expMax.toFixed(1)} window-best)`
        : expMax > 0
          ? `conviction ${conviction.toFixed(1)} clears floor ${floor.toFixed(1)} - patience bar decayed to it on the window's last leg`
          : `conviction ${conviction.toFixed(1)} clears floor ${floor.toFixed(1)} (no window history yet - floor-only mode)`
    return { kind: 'fire', threshold, patienceBar, conviction, reason: why }
  }
  return {
    kind: 'wait',
    threshold,
    patienceBar,
    conviction,
    reason: `conviction ${conviction.toFixed(1)} real but below the patience bar ${patienceBar.toFixed(1)} - wait for a better bar in this window`,
  }
}
