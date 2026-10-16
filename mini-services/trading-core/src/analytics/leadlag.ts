// IQAIR//OS - EUR/USD lead-lag correlation
// Intermarket analysis: EUR/USD carries >60% of FX liquidity, so a sharp
// move there often ripples into other pairs that share its base or quote
// currency with some delay. This module measures that empirically rather
// than assuming it - rolling cross-correlation of bar-over-bar returns
// between a "leader" series (EUR/USD) and a "follower" series (the
// secondary pair) at several lag offsets, picking whichever lag has the
// strongest |correlation| over the lookback window. The caller (os-mode.ts's
// pickLeadLagSignal) then checks whether the leader's return at that lag
// offset ago was a meaningful move, and if so projects the same-signed
// (or opposite-signed, if the fitted correlation is negative) move onto the
// follower right now.
//
// This is standard descriptive lead-lag/cross-correlation methodology, the
// same kind used in intermarket/statistical-arbitrage research - not a
// predictive model of any single tick, and not a claim that the
// relationship is stationary forever (hence recomputing on a rolling
// window rather than caching a fixed lag/correlation indefinitely).

export interface LeadLagFit {
  /** best-fit lag in bars: how many bars AFTER the leader moves, the
   * follower's matching move tends to show up. 0 = contemporaneous. */
  lag: number
  /** Pearson correlation of leader_return[t-lag] vs follower_return[t], at
   * the best-fit lag. Sign matters: negative means the follower tends to
   * move opposite the leader (e.g. a quote-currency relationship). */
  correlation: number
  /** how many lag offsets were actually tested (for diagnostics). */
  lagsTested: number
  /** how many (leader, follower) return pairs went into the winning lag's
   * correlation - lower n at higher lags since the window shrinks. */
  n: number
}

export interface LeadLagSignal {
  fit: LeadLagFit
  /** the leader's most recent return (close-over-close at the fitted lag's
   * offset back from "now"), expressed as a plain fraction (0.001 = 0.1%). */
  triggerReturn: number
  /** z-score of triggerReturn against the leader's own recent return
   * distribution - how unusual this move is, not just its raw size. */
  triggerZ: number
  /** projected direction for the follower, combining the fit's sign with
   * the trigger's direction. null if the fit/trigger doesn't clear the
   * caller's thresholds (this module doesn't gate - os-mode.ts does). */
  direction: 'call' | 'put'
}

function closesToReturns(closes: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]
    out.push(prev > 0 ? (closes[i] - prev) / prev : 0)
  }
  return out
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  let sa = 0, sb = 0
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i] }
  const ma = sa / n, mb = sb / n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  const denom = Math.sqrt(da * db)
  return denom > 0 ? num / denom : 0
}

/**
 * Fit the best lag (0..maxLag bars) at which the leader's return best
 * predicts the follower's SAME-INDEX return, i.e. corr(leaderReturns[t -
 * lag], followerReturns[t]) over the overlapping window. Both return series
 * must already be time-aligned bar-for-bar (same tf, same bar boundaries -
 * the caller is responsible for that, since both candles come from the
 * same market-data service at the same timeframe).
 */
export function fitLeadLag(leaderCloses: number[], followerCloses: number[], maxLag = 10): LeadLagFit {
  const leaderReturns = closesToReturns(leaderCloses)
  const followerReturns = closesToReturns(followerCloses)
  let best: LeadLagFit = { lag: 0, correlation: 0, lagsTested: 0, n: 0 }
  const cap = Math.max(0, Math.min(maxLag, leaderReturns.length - 3, followerReturns.length - 3))
  let tested = 0
  for (let lag = 0; lag <= cap; lag++) {
    // follower[lag..] aligned against leader[0..length-lag] - i.e. the
    // leader's return `lag` bars ago lines up with the follower's return now.
    const followerSlice = followerReturns.slice(lag)
    const leaderSlice = leaderReturns.slice(0, leaderReturns.length - lag)
    const n = Math.min(leaderSlice.length, followerSlice.length)
    if (n < 10) continue // too few overlapping points at this lag to trust the fit
    const corr = pearson(leaderSlice.slice(-n), followerSlice.slice(-n))
    tested++
    if (Math.abs(corr) > Math.abs(best.correlation)) best = { lag, correlation: corr, lagsTested: tested, n }
  }
  best.lagsTested = tested
  return best
}

/**
 * Given a fitted lag/correlation and the two assets' most recent closes,
 * produce the projected trigger + direction. Returns null if there isn't
 * enough history to compute the trigger return.
 */
export function projectLeadLagSignal(fit: LeadLagFit, leaderCloses: number[]): LeadLagSignal | null {
  const leaderReturns = closesToReturns(leaderCloses)
  if (leaderReturns.length < fit.lag + 1) return null
  // the leader's return `fit.lag` bars back from the most recent closed bar -
  // that's the move whose echo should be landing on the follower right now.
  const idx = leaderReturns.length - 1 - fit.lag
  if (idx < 0) return null
  const triggerReturn = leaderReturns[idx]
  // z-score the trigger against a trailing window of the leader's own
  // returns (excluding the trigger bar itself) so "unusual" is relative to
  // this pair's own recent volatility, not a fixed threshold.
  const window = leaderReturns.slice(Math.max(0, idx - 60), idx)
  if (window.length < 10) return null
  const mean = window.reduce((s, v) => s + v, 0) / window.length
  const variance = window.reduce((s, v) => s + (v - mean) * (v - mean), 0) / Math.max(1, window.length - 1)
  const std = Math.sqrt(variance)
  const triggerZ = std > 0 ? (triggerReturn - mean) / std : 0
  // sign of the projected move = sign(triggerReturn) * sign(correlation) -
  // a negative-correlation pair (e.g. a quote-currency relationship) should
  // move OPPOSITE the leader's trigger, not with it.
  const projectedSign = Math.sign(triggerReturn) * Math.sign(fit.correlation)
  if (projectedSign === 0) return null
  return {
    fit,
    triggerReturn,
    triggerZ,
    direction: projectedSign > 0 ? 'call' : 'put',
  }
}
