// IQAIR//OS - Quantitative algorithms
// Markov chains, Monte Carlo (GBM + bootstrap), Hurst exponent,
// autocorrelation, EWMA/GARCH volatility, regression channel, S/R zones.
import type { Candle, MarkovResult, MonteCarloResult, SRZone } from '../types'

// ---------- helpers ----------

export function logReturns(closesArr: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < closesArr.length; i++) {
    if (closesArr[i - 1] > 0 && closesArr[i] > 0) out.push(Math.log(closesArr[i] / closesArr[i - 1]))
  }
  return out
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1))
}

export function skewness(xs: number[]): number {
  const n = xs.length
  if (n < 3) return 0
  const m = mean(xs)
  const s = stdev(xs)
  if (s === 0) return 0
  return (n / ((n - 1) * (n - 2))) * xs.reduce((a, x) => a + ((x - m) / s) ** 3, 0)
}

export function kurtosis(xs: number[]): number {
  const n = xs.length
  if (n < 4) return 0
  const m = mean(xs)
  const s = stdev(xs)
  if (s === 0) return 0
  const g2 = xs.reduce((a, x) => a + ((x - m) / s) ** 4, 0) / n
  return g2 - 3
}

// Deterministic PRNG (mulberry32) so simulations are reproducible per request
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gauss(r: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = r()
  while (v === 0) v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ---------- Markov chain ----------

export const MARKOV_STATES = ['big_down', 'down', 'flat', 'up', 'big_up'] as const

/**
 * First-order Markov chain over vol-scaled return states.
 * Thresholds adapt to the asset's own return distribution (k * sigma),
 * so it works identically on forex and crypto.
 */
export function markovChain(closesArr: number[], opts?: { lookback?: number; kBig?: number; kFlat?: number }): MarkovResult {
  const lookback = Math.min(opts?.lookback ?? 500, closesArr.length - 1)
  const kBig = opts?.kBig ?? 1.4
  const kFlat = opts?.kFlat ?? 0.35
  const series = closesArr.slice(-(lookback + 1))
  const rets = logReturns(series)
  const sigma = stdev(rets) || 1e-9
  const stateMean = new Array(5).fill(0)
  const stateCount = new Array(5).fill(0)
  const counts: number[][] = [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ]

  const classify = (r: number): number => {
    const z = r / sigma
    if (z <= -kBig) return 0
    if (z <= -kFlat) return 1
    if (z < kFlat) return 2
    if (z < kBig) return 3
    return 4
  }

  const states = rets.map(classify)
  for (let i = 0; i < states.length; i++) {
    stateMean[states[i]] += rets[i]
    stateCount[states[i]]++
    if (i > 0) counts[states[i - 1]][states[i]]++
  }
  for (let s = 0; s < 5; s++) if (stateCount[s] > 0) stateMean[s] /= stateCount[s]

  // transition matrix with Laplace smoothing
  const matrix = counts.map((row) => {
    const total = row.reduce((a, b) => a + b, 0) + 5
    return row.map((c) => (c + 1) / total)
  })

  // stationary distribution via power iteration
  let stationary = [0.2, 0.2, 0.2, 0.2, 0.2]
  for (let it = 0; it < 200; it++) {
    const next = new Array(5).fill(0)
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) next[j] += stationary[i] * matrix[i][j]
    stationary = next
  }

  const lastState = states[states.length - 1] ?? 2
  const nextStateProbs = matrix[lastState].slice()
  const probUp = nextStateProbs[3] + nextStateProbs[4]
  const probDown = nextStateProbs[0] + nextStateProbs[1]
  const probFlat = nextStateProbs[2]
  const expectedReturn = nextStateProbs.reduce((a, p, s) => a + p * stateMean[s], 0)

  const trendiness = Math.max(
    0,
    Math.min(1, matrix[3][3] + matrix[1][1] - matrix[3][1] - matrix[1][3])
  )

  // normalized Shannon entropy of the next-step distribution
  let H = 0
  for (const p of nextStateProbs) if (p > 0) H -= p * Math.log(p)
  const entropy = H / Math.log(5)

  // regime: combine drift asymmetry + persistence
  const bullBias = matrix[3][3] + matrix[3][4] + matrix[4][3]
  const bearBias = matrix[1][1] + matrix[1][0] + matrix[0][1]
  let regime: MarkovResult['regime'] = 'range'
  if (trendiness > 0.55 && bullBias > bearBias * 1.15) regime = 'bull'
  else if (trendiness > 0.55 && bearBias > bullBias * 1.15) regime = 'bear'
  else if (trendiness <= 0.45 && entropy > 0.92) regime = 'chop'

  return {
    states: [...MARKOV_STATES],
    matrix,
    counts,
    stationary,
    lastState,
    nextStateProbs,
    probUp,
    probDown,
    probFlat,
    expectedReturn,
    trendiness,
    entropy,
    regime,
    sampleSize: states.length,
  }
}

// ---------- Monte Carlo ----------

export function monteCarlo(
  closesArr: number[],
  opts?: { nSims?: number; horizon?: number; samplePaths?: number; mode?: 'gbm' | 'bootstrap'; seed?: number }
): MonteCarloResult {
  const nSims = Math.min(opts?.nSims ?? 2000, 5000)
  const horizon = Math.min(opts?.horizon ?? 30, 200)
  const samplePaths = opts?.samplePaths ?? 20
  const mode = opts?.mode ?? 'gbm'
  const seed = opts?.seed ?? Date.now() % 2147483647
  const r = rng(seed)

  const rets = logReturns(closesArr.slice(-400))
  const mu = mean(rets)
  const sigma = stdev(rets) || 1e-9
  const last = closesArr[closesArr.length - 1]

  const endPrices: number[] = []
  const paths: number[][] = []
  let totalDD = 0

  for (let s = 0; s < nSims; s++) {
    let price = last
    let peak = last
    let maxDD = 0
    const path: number[] = [last]
    for (let t = 0; t < horizon; t++) {
      let step: number
      if (mode === 'bootstrap') step = rets[Math.floor(r() * rets.length)] ?? 0
      else step = mu - (sigma * sigma) / 2 + sigma * gauss(r)
      price *= Math.exp(step)
      if (price > peak) peak = price
      const dd = peak > 0 ? (peak - price) / peak : 0
      if (dd > maxDD) maxDD = dd
      path.push(price)
    }
    endPrices.push(price)
    totalDD += maxDD
    if (s < samplePaths) paths.push(path)
  }

  endPrices.sort((a, b) => a - b)
  const q = (p: number) => endPrices[Math.floor(p * (endPrices.length - 1))]
  const probUp = endPrices.filter((p) => p > last).length / endPrices.length
  const expRet = endPrices.reduce((a, b) => a + Math.log(b / last), 0) / endPrices.length
  const var95 = Math.max(0, (last - q(0.05)) / last)
  const tail = endPrices.slice(0, Math.max(1, Math.floor(endPrices.length * 0.05)))
  const cvar95 = Math.max(0, (last - mean(tail)) / last)

  return {
    paths,
    horizon,
    nSims,
    p5: q(0.05),
    p25: q(0.25),
    median: q(0.5),
    p75: q(0.75),
    p95: q(0.95),
    probUp,
    expectedReturn: expRet,
    var95,
    cvar95,
    maxDrawdownExpected: totalDD / nSims,
  }
}

// ---------- Hurst exponent (rescaled range) ----------

export function hurstExponent(closesArr: number[], maxLag = 60): number {
  const rets = logReturns(closesArr.slice(-600))
  if (rets.length < 100) return 0.5
  const lags: number[] = []
  const rsVals: number[] = []
  for (let lag = 8; lag <= Math.min(maxLag, Math.floor(rets.length / 4)); lag *= 1.6) {
    const nChunks = Math.floor(rets.length / lag)
    if (nChunks < 2) continue
    let acc = 0
    let used = 0
    for (let c = 0; c < nChunks; c++) {
      const chunk = rets.slice(c * lag, (c + 1) * lag)
      const m = mean(chunk)
      let cum = 0
      let minDev = Infinity
      let maxDev = -Infinity
      for (const x of chunk) {
        cum += x - m
        minDev = Math.min(minDev, cum)
        maxDev = Math.max(maxDev, cum)
      }
      const s = stdev(chunk)
      if (s <= 1e-12) continue
      const rs = (maxDev - minDev) / s
      acc += Math.log(Math.max(rs, 1e-12))
      used++
    }
    if (used > 0) {
      lags.push(Math.log(lag))
      rsVals.push(acc / used)
    }
  }
  if (lags.length < 3) return 0.5
  // OLS fit of log(R/S) vs log(lag)
  const n = lags.length
  const mx = mean(lags)
  const my = mean(rsVals)
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (lags[i] - mx) * (rsVals[i] - my)
    den += (lags[i] - mx) ** 2
  }
  const h = den === 0 ? 0.5 : num / den
  return Math.max(0, Math.min(1, h))
}

// ---------- Autocorrelation ----------

export function autocorrelation(rets: number[], maxLag = 20): number[] {
  const m = mean(rets)
  const denom = rets.reduce((a, x) => a + (x - m) ** 2, 0)
  const out: number[] = []
  for (let lag = 1; lag <= maxLag; lag++) {
    let num = 0
    for (let i = lag; i < rets.length; i++) num += (rets[i] - m) * (rets[i - lag] - m)
    out.push(denom === 0 ? 0 : num / denom)
  }
  return out
}

// ---------- Volatility models ----------

export function ewmaVol(rets: number[], lambda = 0.94): number {
  if (!rets.length) return 0
  let v = rets.slice(0, 30).reduce((a, x) => a + x * x, 0) / Math.min(30, rets.length)
  for (const x of rets) v = lambda * v + (1 - lambda) * x * x
  return Math.sqrt(v)
}

/** GARCH(1,1) via coarse grid search on (alpha, beta), omega from variance targeting. */
export function garchVol(rets: number[]): { vol: number; alpha: number; beta: number } {
  if (rets.length < 50) return { vol: ewmaVol(rets), alpha: 0.1, beta: 0.85 }
  const uncond = mean(rets.map((x) => x * x))
  let best = { vol: 0, alpha: 0.08, beta: 0.9, err: Infinity }
  for (let ai = 1; ai <= 8; ai++) {
    for (let bi = 1; bi <= 8; bi++) {
      const alpha = ai * 0.015 // 0.015..0.12
      const beta = 0.8 + bi * 0.012 // 0.812..0.896
      if (alpha + beta >= 0.999) continue
      const omega = (1 - alpha - beta) * uncond
      let v = uncond
      let err = 0
      for (const x of rets) {
        v = omega + alpha * x * x + beta * v
        err += Math.log(Math.max(v, 1e-14)) + (x * x) / Math.max(v, 1e-14)
      }
      if (err < best.err) best = { vol: Math.sqrt(v), alpha, beta, err }
    }
  }
  return { vol: best.vol, alpha: best.alpha, beta: best.beta }
}

// ---------- Regression channel ----------

export function regressionChannel(closesArr: number[], period = 100, k = 2): {
  slope: number
  r2: number
  upper: number
  mid: number
  lower: number
} {
  const src = closesArr.slice(-period)
  const n = src.length
  let sx = 0
  let sy = 0
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sx += i
    sy += src[i]
    sxy += i * src[i]
    sxx += i * i
  }
  const denom = n * sxx - sx * sx
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom
  const intercept = (sy - slope * sx) / n
  const fitted = src.map((_, i) => intercept + slope * i)
  const resid = src.map((v, i) => v - fitted[i])
  const sd = stdev(resid)
  const m = mean(src)
  let ssTot = 0
  for (const v of src) ssTot += (v - m) ** 2
  let ssRes = 0
  for (const r of resid) ssRes += r * r
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot)
  return {
    slope,
    r2,
    upper: intercept + slope * (n - 1) + k * sd,
    mid: intercept + slope * (n - 1),
    lower: intercept + slope * (n - 1) - k * sd,
  }
}

// ---------- Support / resistance zones ----------

export function supportResistance(candles: Candle[], lookback = 240, tolerance = 0.0012): SRZone[] {
  const window = candles.slice(-lookback)
  if (window.length < 20) return []
  const price = window[window.length - 1].close
  const pivHigh: number[] = []
  const pivLow: number[] = []
  for (let i = 2; i < window.length - 2; i++) {
    const c = window[i]
    if (c.high > window[i - 1].high && c.high > window[i - 2].high && c.high > window[i + 1].high && c.high > window[i + 2].high)
      pivHigh.push(c.high)
    if (c.low < window[i - 1].low && c.low < window[i - 2].low && c.low < window[i + 1].low && c.low < window[i + 2].low)
      pivLow.push(c.low)
  }
  const cluster = (levels: number[], type: 'support' | 'resistance'): SRZone[] => {
    const zones: SRZone[] = []
    const sorted = [...levels].sort((a, b) => a - b)
    let group: number[] = []
    const flush = () => {
      if (!group.length) return
      const avg = mean(group)
      zones.push({
        price: avg,
        touches: group.length,
        type,
        strength: Math.min(1, group.length / 6),
      })
      group = []
    }
    for (const lv of sorted) {
      if (!group.length || Math.abs(lv - mean(group)) / price <= tolerance * 10) group.push(lv)
      else flush(), group.push(lv)
    }
    flush()
    return zones
  }
  const zones = [...cluster(pivLow, 'support'), ...cluster(pivHigh, 'resistance')]
  return zones
    .filter((z) => Math.abs(z.price - price) / price < 0.03)
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
    .slice(0, 6)
}

// ---------- Portfolio stats ----------

export function sharpeRatio(rets: number[], periodsPerYear: number): number {
  const m = mean(rets)
  const s = stdev(rets)
  if (s === 0) return 0
  return (m / s) * Math.sqrt(periodsPerYear)
}
