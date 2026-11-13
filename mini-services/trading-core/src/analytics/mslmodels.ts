// IQAIR//OS - pure model readers behind the MSL `ou.*` / `markov.*` / `stat.*` / `cm.*` namespaces.
//
// Every function here is a thin, pure wrapper over an engine the OS ALREADY runs
// (kalman.ts, quant.ts, candlemath.ts, patterns.ts) on CLOSED candles only, so a script,
// the panels and a backtest read the same numbers for the same bars. Nothing in this
// file invents a statistic; it only exposes existing models to the script language.
//
// Candle-derived only (no ticks, no timestamps needed). `strategylang.ts` owns the
// name -> value dispatch and the fail-closed error messages.
import type { Candle, PatternHit } from '../types'
import { ouState, ouSeries } from './kalman'
import { markovChain, hurstExponent, autocorrelation, regressionChannel, ewmaVol, garchVol, logReturns, mean, stdev, skewness, kurtosis } from './quant'
import { blendCandles, findSmartBlends } from './candlemath'
import { detectPatterns } from './patterns'

/** minimum closed bars before ou/markov/stat/cm read anything at all */
export const MODEL_MIN_BARS = 60
/** hurst needs 100 log-returns */
export const HURST_MIN_BARS = 101
/** bars handed to the OU/Kalman fit (the model's own default window is 240) */
export const OU_BARS = 300

const fin = (v: number, dflt = 0): number => (Number.isFinite(v) ? v : dflt)
const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)))

// ---------------------------------------------------------------- OU / Kalman
export interface OUModel {
  theta: number
  phi: number
  kappa: number
  sigmaEq: number
  sigmaEps: number
  halfLife: number
  r2: number
  tStat: number
  z: number
  meanReverting: boolean
  state: 'stretched-below' | 'stretched-above' | 'neutral'
  signal: 'call' | 'put' | 'none'
  score: number
  /** Kalman fair-value estimate of the latent level (last bar) */
  fair: number
  /** last standardized Kalman innovation */
  innovation: number
  sample: number
}

export function readOU(candles: Candle[], window = 240): OUModel | null {
  if (candles.length < MODEL_MIN_BARS) return null
  const bars = candles.length > OU_BARS ? candles.slice(candles.length - OU_BARS) : candles
  const closes = bars.map((c) => c.close)
  const w = clampInt(window, 30, 240)
  const live = ouState(closes, w)
  const s = ouSeries(bars, w)
  let fair = live.theta
  let innovation = 0
  for (let i = s.filtered.length - 1; i >= 0; i--) {
    if (Number.isFinite(s.filtered[i])) {
      fair = s.filtered[i]
      innovation = fin(s.innovationZ[i])
      break
    }
  }
  return {
    theta: fin(live.theta),
    phi: fin(live.phi, 1),
    kappa: fin(live.kappa),
    sigmaEq: fin(live.sigmaEq),
    sigmaEps: fin(live.sigmaEps),
    halfLife: fin(live.halfLifeBars, 9999),
    r2: fin(live.r2),
    tStat: fin(live.tStat),
    z: fin(live.z),
    meanReverting: live.meanReverting,
    state: live.state,
    signal: live.signal,
    score: fin(live.score),
    fair: fin(fair),
    innovation,
    sample: live.sample,
  }
}

// ---------------------------------------------------------------- Markov
export interface MarkovModel {
  probUp: number
  probDown: number
  probFlat: number
  expectedReturn: number
  trendiness: number
  entropy: number
  regime: string
  /** last return state, -2 big_down .. +2 big_up */
  state: number
  /** next-state probabilities from the current state, index 0..4 = state -2..+2 */
  next: number[]
  matrix: number[][]
  stationary: number[]
  samples: number
}

export function readMarkov(candles: Candle[], lookback = 500): MarkovModel | null {
  if (candles.length < MODEL_MIN_BARS) return null
  const lb = clampInt(lookback, 60, 1000)
  const r = markovChain(candles.map((c) => c.close), { lookback: lb })
  return {
    probUp: fin(r.probUp),
    probDown: fin(r.probDown),
    probFlat: fin(r.probFlat),
    expectedReturn: fin(r.expectedReturn),
    trendiness: fin(r.trendiness),
    entropy: fin(r.entropy),
    regime: r.regime,
    state: r.lastState - 2,
    next: r.nextStateProbs.map((x) => fin(x)),
    matrix: r.matrix,
    stationary: r.stationary.map((x) => fin(x)),
    samples: r.sampleSize,
  }
}

// ---------------------------------------------------------------- stat
/** Lo-MacKinlay variance ratio of q-bar vs 1-bar log returns over the last n returns (overlapping sums).
 * VR < 1 = mean-reverting, ~1 = random walk, > 1 = trending. z is the homoskedastic test statistic. */
export function varianceRatio(closes: number[], q: number, n: number): { vr: number; z: number } {
  const rets = logReturns(closes).slice(-n)
  const T = rets.length
  if (T < q * 4 || q < 2) return { vr: 1, z: 0 }
  const m = mean(rets)
  let s1 = 0
  for (const r of rets) s1 += (r - m) ** 2
  const var1 = s1 / T
  if (var1 <= 1e-18) return { vr: 1, z: 0 }
  let sq = 0
  let cnt = 0
  let run = 0
  for (let i = 0; i < T; i++) {
    run += rets[i]
    if (i >= q) run -= rets[i - q]
    if (i >= q - 1) {
      sq += (run - q * m) ** 2
      cnt++
    }
  }
  const varq = sq / (cnt * q)
  const vr = varq / var1
  const se = Math.sqrt((2 * (2 * q - 1) * (q - 1)) / (3 * q * T))
  return { vr: fin(vr, 1), z: se > 0 ? fin((vr - 1) / se) : 0 }
}

export interface StatArgs {
  n?: number
  lag?: number
  q?: number
  k?: number
  lambda?: number
}

export function statValue(name: string, closes: number[], a: StatArgs): number | null {
  const n = a.n !== undefined ? clampInt(a.n, 20, 600) : undefined
  switch (name) {
    case 'hurst':
      if (closes.length < HURST_MIN_BARS) return null
      return fin(hurstExponent(closes), 0.5)
    case 'autocorr': {
      const lag = clampInt(a.lag ?? 1, 1, 20)
      const rets = logReturns(closes).slice(-(n ?? 120))
      if (rets.length < lag + 20) return null
      return fin(autocorrelation(rets, lag)[lag - 1])
    }
    case 'varianceRatio':
    case 'vrZ': {
      const q = clampInt(a.q ?? 4, 2, 30)
      const vr = varianceRatio(closes, q, n ?? 200)
      return name === 'vrZ' ? vr.z : vr.vr
    }
    case 'regSlope':
    case 'regR2':
    case 'regMid':
    case 'regUpper':
    case 'regLower':
    case 'regZ': {
      const period = n ?? 100
      if (closes.length < Math.min(period, 30)) return null
      const k = a.k !== undefined && Number.isFinite(a.k) && a.k > 0 ? a.k : 2
      const ch = regressionChannel(closes, period, name === 'regZ' ? 1 : k)
      if (name === 'regSlope') return fin(ch.slope)
      if (name === 'regR2') return fin(ch.r2)
      if (name === 'regMid') return fin(ch.mid)
      if (name === 'regUpper') return fin(ch.upper)
      if (name === 'regLower') return fin(ch.lower)
      const sd = ch.upper - ch.mid // k = 1 channel -> one residual sigma
      return sd > 1e-12 ? fin((closes[closes.length - 1] - ch.mid) / sd) : 0
    }
    case 'ewmaVol': {
      const rets = logReturns(closes).slice(-(n ?? 300))
      if (rets.length < 30) return null
      return fin(ewmaVol(rets, a.lambda !== undefined && a.lambda > 0 && a.lambda < 1 ? a.lambda : 0.94))
    }
    case 'garchVol': {
      const rets = logReturns(closes).slice(-(n ?? 300))
      if (rets.length < 50) return null
      return fin(garchVol(rets).vol)
    }
    case 'retMean':
    case 'retStd':
    case 'skew':
    case 'kurt': {
      const rets = logReturns(closes).slice(-(n ?? 120))
      if (rets.length < 20) return null
      if (name === 'retMean') return fin(mean(rets))
      if (name === 'retStd') return fin(stdev(rets))
      if (name === 'skew') return fin(skewness(rets))
      return fin(kurtosis(rets))
    }
    default:
      throw new Error(`unknown stat ${name}`)
  }
}
export const STAT_NAMES = ['hurst', 'autocorr', 'varianceRatio', 'vrZ', 'regSlope', 'regR2', 'regMid', 'regUpper', 'regLower', 'regZ', 'ewmaVol', 'garchVol', 'retMean', 'retStd', 'skew', 'kurt']

// ---------------------------------------------------------------- cm (candle math)
export const CM_MIN_BARS = 30
export const CM_MAX_GROUP = 50

/** Blend the `n` closed bars ending at `end` (index into candles, inclusive) with the Candle Math rule. */
export function cmBlend(candles: Candle[], n: number, endIdx: number): Candle | null {
  const size = clampInt(n, 1, CM_MAX_GROUP)
  const start = endIdx - size + 1
  if (start < 0 || endIdx >= candles.length) return null
  return blendCandles(candles.slice(start, endIdx + 1))
}

const norm = (s: string) => s.trim().toLowerCase()

export interface CmReading {
  blended: Candle
  /** pattern hits on the blended candle (barsAgo 0), context = the bars before the group + the blended candle */
  hits: PatternHit[]
  /** names of those hits that the raw, unblended bars did NOT show inside the group */
  revealed: string[]
}

/** Read the blended candle of the last `n` bars (or ending at `endIdx`) for patterns, and which are newly revealed by blending. */
export function cmRead(candles: Candle[], n: number, endIdx = candles.length - 1): CmReading | null {
  const size = clampInt(n, 1, CM_MAX_GROUP)
  const start = endIdx - size + 1
  if (start < 0 || endIdx >= candles.length) return null
  const blended = blendCandles(candles.slice(start, endIdx + 1))
  const ctxStart = Math.max(0, start - 20)
  const win = [...candles.slice(ctxStart, start), blended]
  const hits = win.length >= 3 ? detectPatterns(win, 3).filter((h) => h.barsAgo === 0) : []
  const rawWin = candles.slice(ctxStart, endIdx + 1)
  const rawNames = new Set(rawWin.length >= 3 ? detectPatterns(rawWin, Math.min(8, size + 2)).filter((h) => h.barsAgo <= size - 1).map((h) => norm(h.name)) : [])
  const revealed = hits.map((h) => h.name).filter((nm) => !rawNames.has(norm(nm)))
  return { blended, hits, revealed }
}

export function cmHas(r: CmReading, name: string): boolean {
  const want = norm(name)
  return r.hits.some((h) => norm(h.name) === want)
}
export function cmRevealedHas(r: CmReading, name: string): boolean {
  const want = norm(name)
  return r.revealed.some((nm) => norm(nm) === want)
}
/** +1 / -1 / 0: net of bullish vs bearish hits, each weighted by its reliability (1-3) */
export function cmDir(r: CmReading): number {
  let net = 0
  for (const h of r.hits) net += (h.direction === 'bullish' ? 1 : h.direction === 'bearish' ? -1 : 0) * h.reliability
  return net > 0 ? 1 : net < 0 ? -1 : 0
}

/** the pattern-confirmed ("smart") blend group ending on the LATEST bar, if any: its size (2-4) and net direction */
export function cmSmart(candles: Candle[]): { size: number; dir: number; patterns: string[] } | null {
  const tail = candles.length > 40 ? candles.slice(candles.length - 40) : candles
  const last = tail.length - 1
  const hit = findSmartBlends(tail).find((b) => b.endIdx === last)
  if (!hit) return null
  const size = hit.endIdx - hit.startIdx + 1
  const r = cmRead(tail, size, last)
  return { size, dir: r ? cmDir(r) : 0, patterns: hit.patterns }
}
