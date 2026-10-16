// IQAIR//OS - Cointegration (pairs trading)
// Lead-lag (analytics/leadlag.ts) trades a RETURNS correlation: "the leader
// just moved, the follower's echo of that same move is overdue". Cointegration
// is the other classic pairs-trading idea and a genuinely different
// statistical object: instead of correlated RETURNS, it asks whether the two
// assets' PRICE LEVELS share a stable long-run relationship - a linear
// combination (the "spread") that is itself stationary (mean-reverting) even
// though each price individually wanders (a random walk). When that holds,
// the spread stretching away from its own equilibrium is the tradeable edge,
// regardless of what either leg's own price action looks like in isolation.
//
// Engle-Granger two-step method, the standard (if simplest) textbook
// approach: (1) OLS-regress follower price on leader price over a rolling
// window to get the hedge ratio beta (spread = follower - alpha - beta*leader);
// (2) test whether THAT SPREAD SERIES is itself mean-reverting, reusing
// analytics/kalman.ts's ouEstimate - it is already generic over any numeric
// series, not specifically price, so no new OU-fitting code is needed here.
// This is a lighter-weight substitute for a real Engle-Granger ADF test (no
// proper unit-root test is implemented - the OU fit's own t-stat on phi is
// used as the reversion-significance proxy instead, the same convention
// kalman-ou-reversion already uses for price itself), but it is testing the
// right object: the SPREAD's stationarity, not the raw price correlation.
//
// Reuses analytics/leadlag.ts's leadersFor()/LEADLAG_GROUPS for candidate
// pairs (the same liquidity/macro leaders plausibly share a long-run price
// relationship with their followers, not just a returns echo) rather than
// inventing a second pair list - and therefore reuses the exact same
// StrategyHints.leaderCandles plumbing already threaded through
// backtest.ts/optimize.ts/plugins/analytics.ts for lead-lag: no additional
// backtest-engine wiring is needed for a cointegration strategy to work
// everywhere lead-lag-echo already does.

import { ouEstimate } from './kalman'

/** Bars of leader+follower price history used for the rolling beta/spread fit. */
export const COINTEGRATION_WINDOW = 180
/** Minimum OLS fit quality (R^2 of follower ~ alpha + beta*leader) before the
 * hedge ratio itself is trusted - a weak beta fit means "spread" is just
 * noise, whatever the OU fit on it says. */
export const COINTEGRATION_MIN_R2 = 0.5
/** Minimum OU reversion significance (t-stat of 1-phi) on the SPREAD series -
 * same convention/threshold family as kalman.ts's meanReverting gate. */
export const COINTEGRATION_MIN_TSTAT = 2
/** Spread half-life beyond this is too slow to trade within any reasonable
 * option/CFD holding horizon. */
export const COINTEGRATION_MAX_HALFLIFE = 80

export interface CointegrationFit {
  /** Hedge ratio: spread[i] = follower[i] - (alpha + beta*leader[i]). */
  beta: number
  alpha: number
  /** OLS fit quality of follower ~ alpha + beta*leader. */
  r2: number
  /** OU equilibrium of the spread series itself. */
  theta: number
  sigmaEq: number
  /** OU reversion significance of the spread (NOT of either raw price). */
  tStat: number
  halfLifeBars: number
  /** (lastSpread - theta) / sigmaEq - how many spread-sigmas the pair is
   * currently stretched from its fitted equilibrium. */
  z: number
  /** How many (leader, follower) price pairs fed the beta/spread fit. */
  n: number
}

function ols(x: number[], y: number[]): { alpha: number; beta: number; r2: number } {
  const n = Math.min(x.length, y.length)
  if (n < 10) return { alpha: y[y.length - 1] ?? 0, beta: 0, r2: 0 }
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i] }
  const mx = sx / n, my = sy / n
  let sxx = 0, sxy = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx
    const dy = y[i] - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  const beta = sxx > 1e-12 ? sxy / sxx : 0
  const alpha = my - beta * mx
  let ssRes = 0
  for (let i = 0; i < n; i++) {
    const fit = alpha + beta * x[i]
    const resid = y[i] - fit
    ssRes += resid * resid
  }
  const r2 = syy > 1e-12 ? Math.max(0, 1 - ssRes / syy) : 0
  return { alpha, beta, r2 }
}

/**
 * Fits the hedge ratio over the trailing `window` bars of leader/follower
 * closes, builds the implied spread series, and OU-fits that spread. Both
 * arrays must already be time-aligned bar-for-bar (same tf, same bar
 * boundaries) - same contract as leadlag.ts's fitLeadLag.
 */
export function fitCointegration(leaderCloses: number[], followerCloses: number[], window = COINTEGRATION_WINDOW): CointegrationFit | null {
  const n = Math.min(leaderCloses.length, followerCloses.length)
  const w = Math.min(window, n)
  if (w < 30) return null
  const leaderWin = leaderCloses.slice(n - w)
  const followerWin = followerCloses.slice(n - w)
  const { alpha, beta, r2 } = ols(leaderWin, followerWin)
  const spread = followerWin.map((f, i) => f - (alpha + beta * leaderWin[i]))
  const est = ouEstimate(spread, Math.max(20, Math.round(w * 0.8)))
  const sigmaEq = est.sigmaEq > 1e-9 ? est.sigmaEq : 1
  const lastSpread = spread[spread.length - 1]
  const z = (lastSpread - est.theta) / sigmaEq
  return {
    beta,
    alpha,
    r2,
    theta: est.theta,
    sigmaEq: est.sigmaEq,
    tStat: est.tStat,
    halfLifeBars: est.halfLifeBars,
    z,
    n: w,
  }
}
