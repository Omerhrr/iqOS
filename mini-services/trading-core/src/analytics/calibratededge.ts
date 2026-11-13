// IQAIR//OS - Calibrated Regime Edge engine.
//
// WHY THIS EXISTS (the strategy vet's central finding, measured, not argued):
// every builtin strategy was run over (a) a driftless random walk, (b) a
// synthetic market with planted lag-1 MOMENTUM and (c) one with planted lag-1
// MEAN REVERSION. On (a) all 57 settle at ~50% (no look-ahead anywhere - good).
// On (b)/(c) almost every rule is FIXED-POLARITY: the trend-followers that win
// 57-63% in the momentum market lose at 35-44% in the reverting one, and the
// faders do the exact opposite. A fixed rule therefore has no edge of its own -
// its sign is borrowed from whichever autocorrelation regime the pair happens
// to be in, and it pays the house the moment that regime flips. The only rules
// that won in BOTH planted markets were the ones that MEASURE the regime first
// (markov-edge, tick-regime).
//
// This engine is that idea reduced to its smallest honest form, with the two
// things those rules lack: a payout-aware statistical gate, and a stability
// check. It does not predict - it looks up, on this pair's own trailing closed
// bars, one conditional frequency:
//
//   "after a bar that moved about THIS hard, how often did price keep going
//    the same way over the next `horizon` bars?"
//
// and trades continuation (or the fade) only when the evidence that the true
// rate beats this trade's BREAKEVEN is statistically solid:
//
//   1. STATE-CONDITIONAL. Bars are bucketed by |return| / sigma (quiet /
//      normal / impulse). An unconditional 56% continuation rate is real but
//      too thin to clear an 85% payout's 54.1% breakeven with confidence;
//      the same market is typically far more one-sided right after an
//      impulse bar, which is where a tradeable margin actually lives.
//      Up and down moves are pooled (continuation vs reversal is the
//      symmetric question), doubling the sample per bucket.
//   2. WILSON LOWER BOUND vs BREAKEVEN. The gate is not "p-hat > 55%" - it
//      is "the one-sided lower confidence bound of the winning side's rate
//      >= 1/(1+payout) + margin". A 9/12 bucket (75%) does not pass; a
//      70/105 bucket does. Ties count AGAINST both sides (a flat settle is
//      not a win for anyone). For horizon > 1 the overlapping outcomes are
//      not independent, so the sample is deflated by the horizon first.
//   3. STABILITY + RECENCY. The window is split in half and the same side
//      must lead in BOTH halves AND in the newest fifth of the samples. A
//      rate that is strong overall but only because of older bars is a
//      regime that already ended - and trading it is worse than a coin flip.
//
// Pure function of candles[0..n-1], no look-ahead: a historical pair (t,
// t+horizon) is only counted when t+horizon <= n-1, i.e. already settled.
import type { Candle } from '../types'

export interface CalibratedEdgeOpts {
  /** trailing closed bars searched for evidence (default 600) */
  window?: number
  /** outcome horizon in bars - must match the trade's own expiry (default 1) */
  horizon?: number
  /** payout as a fraction, e.g. 0.85 (default 0.85) */
  payout?: number
  /** cushion over breakeven, in probability points, e.g. 0.01 (default 0.01) */
  margin?: number
  /** one-sided confidence z: 1.28 = 90%, 1.64 = 95% (default 1.64) */
  z?: number
  /** minimum same-state settled samples (default 40) */
  minSamples?: number
}

export interface CalibratedEdgeResult {
  direction: 'call' | 'put' | 'none'
  /** 'continuation' = trade with the last bar, 'reversal' = fade it */
  mode: 'continuation' | 'reversal' | 'none'
  /** which |return| bucket the current bar is in */
  state: 'quiet' | 'normal' | 'impulse' | 'flat'
  samples: number
  /** raw winning-side frequency (ties counted against it) */
  rate: number
  /** one-sided Wilson lower bound of `rate` on the horizon-deflated sample */
  lowerBound: number
  breakeven: number
  /** lowerBound - breakeven - margin; >= 0 means the gate is open */
  edge: number
  stable: boolean
  note: string
}

export function wilsonLower(wins: number, n: number, z: number): number {
  if (n <= 0) return 0
  const p = wins / n
  const denom = 1 + (z * z) / n
  const center = p + (z * z) / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return Math.max(0, (center - margin) / denom)
}

const STATE_NAMES = ['quiet', 'normal', 'impulse'] as const

export function computeCalibratedEdge(candles: Candle[], opts: CalibratedEdgeOpts = {}): CalibratedEdgeResult {
  const window = Math.max(100, Math.min(5000, Math.round(opts.window ?? 600)))
  const horizon = Math.max(1, Math.min(20, Math.round(opts.horizon ?? 1)))
  const payout = opts.payout !== undefined && opts.payout > 0 && opts.payout < 2 ? opts.payout : 0.85
  const margin = Math.max(0, opts.margin ?? 0.01)
  const z = Math.max(0.5, Math.min(3.5, opts.z ?? 1.64))
  const minSamples = Math.max(10, Math.round(opts.minSamples ?? 40))
  const breakeven = 1 / (1 + payout)
  const none = (note: string, state: CalibratedEdgeResult['state'] = 'flat', extra: Partial<CalibratedEdgeResult> = {}): CalibratedEdgeResult => ({
    direction: 'none', mode: 'none', state, samples: 0, rate: 0, lowerBound: 0, breakeven, edge: -1, stable: false, note, ...extra,
  })

  const n = candles.length
  if (n < Math.min(window, 200) + horizon + 2) return none(`warming up - needs ${Math.min(window, 200) + horizon + 2}+ closed bars, has ${n}`)
  const start = Math.max(1, n - window)
  // log returns r[t] = ln(c[t]/c[t-1]) for t in [start, n-1]
  const ret = new Array<number>(n).fill(0)
  let sum = 0
  let sumSq = 0
  let cnt = 0
  for (let t = start; t < n; t++) {
    const a = candles[t - 1].close
    const b = candles[t].close
    const r = a > 0 && b > 0 ? Math.log(b / a) : 0
    ret[t] = r
    sum += r
    sumSq += r * r
    cnt++
  }
  const mean = cnt ? sum / cnt : 0
  const sigma = Math.sqrt(Math.max(0, cnt ? sumSq / cnt - mean * mean : 0))
  if (!(sigma > 0)) return none('flat tape - no return variance in the window')
  const bucket = (r: number): number => {
    const a = Math.abs(r) / sigma
    return a < 0.5 ? 0 : a < 1.2 ? 1 : 2
  }

  const rNow = ret[n - 1]
  if (rNow === 0) return none('last bar closed flat - no move to continue or fade')
  const b = bucket(rNow)
  const state = STATE_NAMES[b]

  // settled same-state pairs, split into an older and a newer half by time
  const lastT = n - 1 - horizon
  const mid = start + Math.floor((lastT - start) / 2)
  const half = [
    { n: 0, same: 0, opp: 0 },
    { n: 0, same: 0, opp: 0 },
  ]
  // +1 continuation / -1 reversal / 0 tie, in time order - for the
  // "is it STILL working" read on the newest few samples below
  const seq: number[] = []
  for (let t = start; t <= lastT; t++) {
    const r = ret[t]
    if (r === 0 || bucket(r) !== b) continue
    const out = candles[t + horizon].close - candles[t].close
    const h = half[t <= mid ? 0 : 1]
    h.n++
    if (out === 0) {
      seq.push(0)
      continue // a tie is a win for neither side - stays in n only
    }
    if (out > 0 === r > 0) {
      h.same++
      seq.push(1)
    } else {
      h.opp++
      seq.push(-1)
    }
  }
  const total = half[0].n + half[1].n
  const same = half[0].same + half[1].same
  const opp = half[0].opp + half[1].opp
  if (total < minSamples) return none(`${state} state: only ${total} settled samples in the window (needs ${minSamples}) - not judged yet`, state, { samples: total })

  const cont = same >= opp
  const wins = cont ? same : opp
  const rate = wins / total
  // overlapping multi-bar outcomes are not independent - deflate the sample
  const nEff = total / horizon
  const lowerBound = wilsonLower(rate * nEff, nEff, z)
  const edge = lowerBound - breakeven - margin
  const lead = (h: { n: number; same: number; opp: number }) => (cont ? h.same - h.opp : h.opp - h.same)
  const minHalf = Math.max(5, Math.floor(minSamples / 3))
  // RECENCY: the newest fifth of the samples (>= 10) must lead the same way
  // too. Measured in the vet: when the regime flips faster than the window
  // (planted +/-0.2 flipping every 400 bars vs a 600-bar window) the two
  // halves can both still lead from the OLD regime while the newest
  // samples have already turned - trading that stale read lost 66% of the
  // time. This is the check that catches it.
  const recentN = Math.max(10, Math.round(seq.length * 0.2))
  let recentLead = 0
  for (let i = Math.max(0, seq.length - recentN); i < seq.length; i++) recentLead += cont ? seq[i] : -seq[i]
  const stable = half[0].n >= minHalf && half[1].n >= minHalf && lead(half[0]) > 0 && lead(half[1]) > 0 && recentLead > 0
  const mode = cont ? 'continuation' : 'reversal'
  const base = { state, samples: total, rate, lowerBound, breakeven, edge, stable }
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const head = `${state} state: ${mode} ${wins}/${total} = ${pct(rate)} (${z.toFixed(2)}z floor ${pct(lowerBound)}, breakeven ${pct(breakeven)} at ${(payout * 100).toFixed(0)}% payout)`
  if (edge < 0) return none(`${head} - floor does not clear breakeven +${(margin * 100).toFixed(1)}pts, no proven edge`, state, base)
  if (!stable) return none(`${head} - clears the floor overall but NOT consistently (older half ${half[0].same}:${half[0].opp}, newer half ${half[1].same}:${half[1].opp}, newest ${recentN} net ${recentLead > 0 ? '+' : ''}${recentLead}) - regime not stable`, state, base)
  const up = rNow > 0
  const direction = (cont ? up : !up) ? 'call' : 'put'
  return { direction, mode, ...base, note: `${head} - stable (older half ${half[0].same}:${half[0].opp}, newer half ${half[1].same}:${half[1].opp}, newest ${recentN} net +${recentLead}) -> ${direction.toUpperCase()}` }
}
