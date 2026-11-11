// IQAIR//OS - Historical Outcome Memory (HOM) engine.
//
// Every calibration mechanism already in this codebase (the Next-Expiry
// Oracle's own applyCalibrationDiscount, the Next-Candle Oracle's, Tempo's
// per-pair gate) is AGGREGATE: bucketed by (asset, expiry) or by driver or
// by regime, recency-weighted, collapsed into one number. None of them ever
// answer the much more concrete question a trader actually wants when
// staring at a setup: "forget the model's number for a second - show me
// the actual historical moments that looked like THIS one, and how they
// actually settled." That's what this engine does: a pure k-nearest-
// neighbor search over past market states, reporting the raw comparable
// cases (not just their aggregate), so a caller can see the evidence
// itself, not only a model's summary of it.
//
// STATE FEATURES, deliberately simple and self-contained (NOT a reuse of
// classifyRegime/hurstProxy/garchVol from nextexpiry.ts/regime.ts - those
// do heavier rolling statistics tuned for that engine's own 1m-native,
// 720+-bar-minimum use case; running that per CANDIDATE across a
// multi-thousand-bar search window would be slow and would compound a
// second classifier's own error modes into this one). Three features,
// z-scored against the candidate pool itself for a fair distance metric:
//   - momentum   : ROC over the trailing `featureWindow` bars (%)
//   - volatility : ATR(14) / close (normalized true range)
//   - runLength  : signed count of the current consecutive same-direction
//     close run, capped at +/-10 (how "stretched" the recent move already is)
// SESSION-GATED: a candidate only counts if it shares the current bar's
// session bucket (analytics/session.ts#classifySession) - the same
// "comparable means same session too" principle the oracle's own Session
// Drift driver already relies on (intraday physiology - London-morning
// drift is not the same phenomenon as a thin off-hours grind, even at
// identical momentum/volatility readings).
//
// NO LOOK-AHEAD, the one rule this whole engine stands or falls on:
//   - the CURRENT state's own features use only candles up to and
//     including the last closed bar (n-1) - exactly what a live read can
//     actually see.
//   - each CANDIDATE's own features use only candles up to and including
//     its own index j - a candidate from deep history is evaluated the
//     same honest way the current bar is, never peeking past itself either.
//   - a candidate's OUTCOME (what actually happened by its own +expiryBars
//     settlement) is of course read from AFTER j - that's not look-ahead,
//     it's the entire point: j is a CLOSED historical bar whose future is
//     already known, which is exactly what makes it usable as evidence.
//   - `minGapBars` excludes any candidate within that many bars of "now" -
//     without this, the nearest "neighbors" would just be the last few
//     bars of the live run itself (trivially similar, not independent
//     evidence) and the whole exercise would answer nothing.
//
// Pure function, O(n) candidate scan over the lookback window, no
// live-plugin state - SAFE_BACKTEST_SOURCES tier, same as effort/mrc's
// candle-fallback mode.

import type { Candle } from '../types'
import { classifySession, type Session } from './session'

export interface AnalogMatch {
  /** The candidate bar's own index time (its own close is the "entry"). */
  time: number
  /** Euclidean distance in the z-scored feature space - lower = more similar. */
  distance: number
  /** Signed % return from the candidate's close to its close `expiryBars` later. */
  outcomeReturn: number
  outcomeDirection: 'up' | 'down' | 'flat'
}

export interface OutcomeMemoryResult {
  ok: boolean
  note: string
  k: number
  expiryBars: number
  session: Session
  /** How many eligible (same-session, far-enough-from-now, outcome-resolved)
   * candidates existed in the lookback window BEFORE taking the top k -
   * the honest "how big was the comparable pool" number, since a k=20
   * match drawn from a pool of 22 means something very different from one
   * drawn from a pool of 900. */
  poolSize: number
  matches: AnalogMatch[]
  upCount: number
  downCount: number
  flatCount: number
  /** up / (up + down) - flats excluded from the ratio (same convention
   * effortbricks.ts's/renko.ts's own up/down-only reads use elsewhere). NaN
   * when upCount + downCount is 0 (every match happened to be flat). */
  pUp: number
  avgReturn: number
  medianReturn: number
}

interface StateFeatures {
  momentum: number
  volatility: number
  runLength: number
}

const FLAT_DEADBAND = 1e-9 // a return smaller than this counts as 'flat', not up/down

function atrAt(candles: Candle[], i: number, period: number): number {
  const start = Math.max(1, i - period + 1)
  let sum = 0
  let n = 0
  for (let k = start; k <= i; k++) {
    const c = candles[k]
    const prev = candles[k - 1]
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
    n++
  }
  return n > 0 ? sum / n : NaN
}

function featuresAt(candles: Candle[], i: number, featureWindow: number): StateFeatures | null {
  if (i < featureWindow || i < 1) return null
  const now = candles[i].close
  const then = candles[i - featureWindow].close
  const momentum = then !== 0 ? ((now - then) / then) * 100 : 0
  const atr = atrAt(candles, i, 14)
  const volatility = now !== 0 && Number.isFinite(atr) ? atr / now : NaN
  if (!Number.isFinite(volatility)) return null
  let run = 0
  for (let k = i; k >= 1; k--) {
    const up = candles[k].close >= candles[k - 1].close
    const sign = up ? 1 : -1
    if (run === 0) run = sign
    else if (Math.sign(run) === sign) run += sign
    else break
  }
  return { momentum, volatility, runLength: Math.max(-10, Math.min(10, run)) }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
}
function stdev(xs: number[], m: number): number {
  if (xs.length < 2) return NaN
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(v)
}

export function computeOutcomeMemory(
  candles: Candle[],
  asset: string,
  opts: {
    expiryBars?: number
    k?: number
    lookback?: number
    featureWindow?: number
    minGapBars?: number
    minPoolSize?: number
    weights?: { momentum?: number; volatility?: number; runLength?: number }
  } = {}
): OutcomeMemoryResult {
  const expiryBars = Math.max(1, Math.round(opts.expiryBars ?? 5))
  const k = Math.max(3, Math.min(200, Math.round(opts.k ?? 20)))
  const lookback = Math.max(100, Math.min(10_000, Math.round(opts.lookback ?? 1500)))
  const featureWindow = Math.max(2, Math.round(opts.featureWindow ?? 10))
  const minGapBars = Math.max(1, Math.round(opts.minGapBars ?? Math.max(20, expiryBars * 2)))
  const minPoolSize = Math.max(k, Math.round(opts.minPoolSize ?? k))
  const wMom = opts.weights?.momentum ?? 1
  const wVol = opts.weights?.volatility ?? 1
  const wRun = opts.weights?.runLength ?? 0.5

  const empty = (note: string): OutcomeMemoryResult => ({
    ok: false, note, k, expiryBars, session: 'OFF', poolSize: 0, matches: [],
    upCount: 0, downCount: 0, flatCount: 0, pUp: NaN, avgReturn: NaN, medianReturn: NaN,
  })

  const n = candles.length
  if (n < featureWindow + expiryBars + minGapBars + minPoolSize) {
    return empty(`not enough history: needs ${featureWindow + expiryBars + minGapBars + minPoolSize}+ candles, has ${n}`)
  }

  const nowIdx = n - 1
  const nowFeat = featuresAt(candles, nowIdx, featureWindow)
  if (!nowFeat) return empty('current bar has no computable state yet')
  const nowSession = classifySession(candles[nowIdx].time, asset)

  // search window: cap the scan to the trailing `lookback` bars so a very
  // deep archive doesn't force an unbounded scan on every call
  const scanStart = Math.max(featureWindow, n - lookback)
  const scanEnd = nowIdx - expiryBars - minGapBars // inclusive: candidate's own outcome must be closed, and it must sit at least minGapBars before now

  type Candidate = { idx: number; feat: StateFeatures; outcomeReturn: number }
  const pool: Candidate[] = []
  for (let j = scanStart; j <= scanEnd; j++) {
    if (classifySession(candles[j].time, asset) !== nowSession) continue
    const feat = featuresAt(candles, j, featureWindow)
    if (!feat) continue
    const entryClose = candles[j].close
    const exitClose = candles[j + expiryBars].close
    if (entryClose === 0) continue
    const outcomeReturn = ((exitClose - entryClose) / entryClose) * 100
    pool.push({ idx: j, feat, outcomeReturn })
  }

  if (pool.length < minPoolSize) {
    return empty(`comparable pool too thin: ${pool.length} same-session historical state(s) found, need ${minPoolSize}+ (try a longer lookback or a lower minPoolSize)`)
  }

  // z-score the pool (+ the current state, same mean/std) for a fair distance
  const moms = pool.map((p) => p.feat.momentum)
  const vols = pool.map((p) => p.feat.volatility)
  const runs = pool.map((p) => p.feat.runLength)
  const mMom = mean(moms), sMom = stdev(moms, mMom) || 1
  const mVol = mean(vols), sVol = stdev(vols, mVol) || 1
  const mRun = mean(runs), sRun = stdev(runs, mRun) || 1

  const z = (f: StateFeatures) => ({
    momentum: (f.momentum - mMom) / sMom,
    volatility: (f.volatility - mVol) / sVol,
    runLength: (f.runLength - mRun) / sRun,
  })
  const zNow = z(nowFeat)

  const scored = pool.map((p) => {
    const zp = z(p.feat)
    const d = Math.sqrt(
      wMom * (zp.momentum - zNow.momentum) ** 2 + wVol * (zp.volatility - zNow.volatility) ** 2 + wRun * (zp.runLength - zNow.runLength) ** 2
    )
    return { ...p, distance: d }
  })
  scored.sort((a, b) => a.distance - b.distance)
  const top = scored.slice(0, k)

  let upCount = 0, downCount = 0, flatCount = 0
  const matches: AnalogMatch[] = top.map((t) => {
    const dir: AnalogMatch['outcomeDirection'] = t.outcomeReturn > FLAT_DEADBAND ? 'up' : t.outcomeReturn < -FLAT_DEADBAND ? 'down' : 'flat'
    if (dir === 'up') upCount++
    else if (dir === 'down') downCount++
    else flatCount++
    return { time: candles[t.idx].time, distance: t.distance, outcomeReturn: t.outcomeReturn, outcomeDirection: dir }
  })

  const returns = matches.map((m) => m.outcomeReturn).sort((a, b) => a - b)
  const avgReturn = mean(returns)
  const medianReturn = returns.length ? returns[Math.floor(returns.length / 2)] : NaN
  const pUp = upCount + downCount > 0 ? upCount / (upCount + downCount) : NaN

  return {
    ok: true,
    note: `${top.length} comparable same-session historical state(s) matched (pool of ${pool.length})`,
    k: top.length,
    expiryBars,
    session: nowSession,
    poolSize: pool.length,
    matches,
    upCount,
    downCount,
    flatCount,
    pUp,
    avgReturn,
    medianReturn,
  }
}
