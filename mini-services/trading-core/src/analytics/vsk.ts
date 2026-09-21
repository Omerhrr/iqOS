// IQAIR//OS - VSK Synthesis algorithm
// ─────────────────────────────────────────────────────────────────────────────
// ONE stacked algorithm, FOUR layers, ONE trigger. Every layer feeds the next:
//
//   [ L1  VWAP Z-Score ]        volume-weighted macro exhaustion - arms the
//        │                      reversion setup when price pierces the ±z
//        ▼                      boundary of the rolling VWAP envelope.
//   [ L2  Volatility Squeeze ]  precision gate - TTM squeeze + BB-width
//        │                      percentile. A runaway trend BLOCKS the fade;
//        ▼                      compression / range regimes let it through.
//   [ L3  Kalman Filter ]       micro noise filter - a 2-state (level+slope)
//        │                      Kalman curve. Its slope turn is the first
//        ▼                      sign the structure is bending back.
//   [ L4  Parabolic SAR ]       kinetic trigger - PSAR runs on the FILTERED
//                               curve (not raw price). The exact bar it flips
//                               in the armed direction is the entry.
//
// signal(bar) = L4 flip  AND  L1 armed on that side  AND  L3 slope turning
//               AND  L2 not runaway.
//
// Everything is pure: candles in → full per-bar series out (registry/chart
// friendly, NaN during warmup), a last-bar evaluate() for the strategy
// registry / backtester / agent, and a seeded bootstrap Monte Carlo over the
// resulting trade list. No I/O, no clock, no globals.
// ─────────────────────────────────────────────────────────────────────────────

import type { Candle } from '../types'
import * as TA from './indicators'

export interface VSKParams {
  vwapPeriod: number // L1 rolling VWAP window (bars)
  zEntry: number // L1 |z| that arms the reversion setup
  armWindow: number // L1 how long a stretch stays armed (bars)
  bbPeriod: number // L2 Bollinger period
  bbMult: number // L2 Bollinger width multiplier
  kcMult: number // L2 Keltner multiplier (squeeze envelope)
  pctLookback: number // L2 percentile window for width & slope ranks
  widthPctRunaway: number // L2 block: width percentile >= this ...
  slopePctRunaway: number // L2 block: ... AND |slope| percentile >= this
  kalmanQ: number // L3 process noise (x rolling price variance)
  kalmanR: number // L3 measurement noise (x rolling price variance)
  sarStep: number // L4 PSAR acceleration factor step
  sarMax: number // L4 PSAR acceleration factor cap
}

export const VSK_DEFAULTS: VSKParams = {
  vwapPeriod: 60,
  zEntry: 1.8,
  armWindow: 12, // spans extreme->flip latency: z peaks at the price extreme,
  // the PSAR-on-curve flip confirms ~10-15 bars later - the armed state must
  // survive that gap or L4 can never fire ("detect boundary, wait for flip")
  bbPeriod: 20,
  bbMult: 2.0,
  kcMult: 1.5,
  pctLookback: 100,
  widthPctRunaway: 88,
  slopePctRunaway: 80,
  kalmanQ: 0.02,
  kalmanR: 1.5,
  sarStep: 0.02,
  sarMax: 0.2,
}

export interface VSKSeries {
  vwap: number[] // L1 rolling VWAP
  z: number[] // L1 (close - vwap) / rolling sigma
  squeezeOn: boolean[] // L2 BB inside Keltner (compression)
  widthPct: number[] // L2 BB-width percentile 0..100
  slopePct: number[] // L2 |kalman slope| percentile 0..100
  runaway: boolean[] // L2 blocked regime (trend running away)
  kalman: number[] // L3 filtered structural curve
  slope: number[] // L3 curve slope (price per bar)
  sar: number[] // L4 PSAR on the filtered curve
  sarDir: number[] // L4 +1 bull (sar below curve) / -1 bear
  signal: number[] // final gated signal: +1 call, -1 put, 0 none
  state: string[] // per-bar layer state string (tooltips / journal)
}

export interface VSKEval {
  direction: 'call' | 'put' | 'none'
  score: number
  notes: string
}

const finite = (v: number): boolean => Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Percentile rank (0..100) of v inside the trailing window of xs ending at i. */
function pctRank(xs: number[], i: number, window: number, v: number): number {
  let below = 0
  let total = 0
  const lo = Math.max(0, i - window + 1)
  for (let k = lo; k <= i; k++) {
    const x = xs[k]
    if (!finite(x)) continue
    total++
    if (x <= v) below++
  }
  return total > 0 ? (below / total) * 100 : 50
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer engines
// ─────────────────────────────────────────────────────────────────────────────

/**
 * L1 - rolling VWAP + z-score. O(n) via prefix sums.
 * IQ OTC candles often carry volume 0: fall back to an unweighted typical-price
 * average so the boundary detector still works on flat-volume feeds.
 * z is normalized by the rolling sigma of typical price (classic VWAP-envelope
 * construction), so it reads "sigmas from the volume-weighted boundary".
 */
function layerVWAP(candles: Candle[], period: number): { vwap: number[]; z: number[] } {
  const n = candles.length
  const vwap = new Array<number>(n).fill(NaN)
  const z = new Array<number>(n).fill(NaN)
  const w = Math.max(2, period)
  const tp = new Array<number>(n)
  const pv = new Array<number>(n) // typical * volume
  const vol = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const c = candles[i]
    const t = (c.high + c.low + c.close) / 3
    tp[i] = t
    const v = Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0
    pv[i] = t * v
    vol[i] = v
  }
  let sPV = 0
  let sV = 0
  let sTP = 0
  let sTP2 = 0
  for (let i = 0; i < n; i++) {
    sPV += pv[i]
    sV += vol[i]
    sTP += tp[i]
    sTP2 += tp[i] * tp[i]
    const k = i - w
    if (k >= 0) {
      sPV -= pv[k]
      sV -= vol[k]
      sTP -= tp[k]
      sTP2 -= tp[k] * tp[k]
    }
    const m = Math.min(i + 1, w)
    const vwapI = sV > 0 ? sPV / sV : sTP / m
    vwap[i] = vwapI
    if (i >= w - 1) {
      const mean2 = sTP2 / m
      const mean = sTP / m
      const variance = Math.max(mean2 - mean * mean, 0)
      const sigma = Math.sqrt(variance)
      z[i] = sigma > 1e-12 ? clamp((candles[i].close - vwapI) / sigma, -12, 12) : 0
    }
  }
  return { vwap, z }
}

// Shared layer-engine config views: TSK (the volume-free sibling algorithm)
// reuses the L2/L3/L4 engines verbatim, so they are typed on the narrow field
// set they actually consume - VSKParams satisfies both structurally.
export interface SqueezeCfg {
  bbPeriod: number
  bbMult: number
  kcMult: number
  pctLookback: number
  widthPctRunaway: number
  slopePctRunaway: number
}
export interface KalmanCfg {
  kalmanQ: number
  kalmanR: number
}

/**
 * L2 - TTM-style squeeze + BB-width percentile. Squeeze ON = Bollinger bands
 * inside the Keltner envelope (volatility compression). widthPct ranks the
 * current band width against recent history; combined with the Kalman slope
 * rank it detects a RUNAWAY trend (both expanding and steep) which blocks
 * fade entries. SHARED ENGINE (VSK L2 = TSK L2).
 */
export function layerSqueeze(
  candles: Candle[],
  p: SqueezeCfg,
  slope: number[]
): { squeezeOn: boolean[]; widthPct: number[]; slopePct: number[]; runaway: boolean[] } {
  const n = candles.length
  const squeezeOn = new Array<boolean>(n).fill(false)
  const widthPct = new Array<number>(n).fill(NaN)
  const slopePct = new Array<number>(n).fill(NaN)
  const runaway = new Array<boolean>(n).fill(false)
  const h = candles.map((c) => c.high)
  const l = candles.map((c) => c.low)
  const c = candles.map((k) => k.close)
  const bb = TA.bollinger(c, p.bbPeriod, p.bbMult)
  const kc = TA.keltner(h, l, c, p.bbPeriod, p.kcMult)
  const widths = bb.mid.map((m, i) => (finite(m) && m > 0 ? (bb.upper[i] - bb.lower[i]) / m : NaN))
  for (let i = 0; i < n; i++) {
    if (finite(bb.upper[i]) && finite(kc.upper[i]) && finite(bb.lower[i]) && finite(kc.lower[i])) {
      squeezeOn[i] = bb.upper[i] < kc.upper[i] && bb.lower[i] > kc.lower[i]
    }
    if (finite(widths[i])) widthPct[i] = pctRank(widths, i, p.pctLookback, widths[i])
    if (finite(slope[i])) slopePct[i] = pctRankAbs(slope, i, p.pctLookback, slope[i])
    runaway[i] =
      finite(widthPct[i]) &&
      finite(slopePct[i]) &&
      widthPct[i] >= p.widthPctRunaway &&
      slopePct[i] >= p.slopePctRunaway
  }
  return { squeezeOn, widthPct, slopePct, runaway }
}

/** |slope| percentile rank - a runaway trend is steep regardless of direction. */
function pctRankAbs(xs: number[], i: number, window: number, v: number): number {
  let below = 0
  let total = 0
  const a = Math.abs(v)
  const lo = Math.max(0, i - window + 1)
  for (let k = lo; k <= i; k++) {
    const x = xs[k]
    if (!finite(x)) continue
    total++
    if (Math.abs(x) <= a) below++
  }
  return total > 0 ? (below / total) * 100 : 50
}

/**
 * L3 - two-state (level + slope) Kalman filter, the "structural curve".
 * Q and R are scaled by the rolling price variance so the SAME tuning works
 * on EURUSD (1.14) and BTC (60000). Output: filtered level + slope per bar.
 * SHARED ENGINE (VSK L3 = TSK L3).
 */
export function layerKalman(candles: Candle[], p: KalmanCfg): { kalman: number[]; slope: number[]; varScale: number[] } {
  const n = candles.length
  const kalman = new Array<number>(n).fill(NaN)
  const slope = new Array<number>(n).fill(NaN)
  const varScale = new Array<number>(n).fill(0)
  const c = candles.map((k) => k.close)
  // rolling variance of closes over 100 bars (prefix sums, O(1) per bar)
  const W = 100
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    s1 += c[i]
    s2 += c[i] * c[i]
    const k = i - W
    if (k >= 0) {
      s1 -= c[k]
      s2 -= c[k] * c[k]
    }
    const m = Math.min(i + 1, W)
    const mean = s1 / m
    varScale[i] = Math.max(s2 / m - mean * mean, 1e-12)
  }

  // init level at first close, slope 0
  let f = c[0]
  let v = 0
  let P00 = varScale[0] || 1e-12
  let P01 = 0
  let P10 = 0
  let P11 = varScale[0] || 1e-12
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const q = p.kalmanQ * varScale[i]
      const r = p.kalmanR * varScale[i]
      // predict: x = F x, F = [[1,1],[0,1]]
      const fx0 = f + v
      const fx1 = v
      // P = F P Fᵀ + Q  (expanded for dt=1)
      const nP00 = P00 + P01 + P10 + P11 + 0.25 * q
      const nP01 = P01 + P11 + 0.5 * q
      const nP10 = P10 + P11 + 0.5 * q
      const nP11 = P11 + q
      // update with measurement close[i]
      const y = c[i] - fx0
      const S = nP00 + r
      const K0 = nP00 / S
      const K1 = nP10 / S
      f = fx0 + K0 * y
      v = fx1 + K1 * y
      // P' = (I - K H) P,  H = [1, 0]
      const uP00 = (1 - K0) * nP00
      const uP01 = (1 - K0) * nP01
      const uP10 = nP10 - K1 * nP00
      const uP11 = nP11 - K1 * nP01
      P00 = uP00
      P01 = uP01
      P10 = uP10
      P11 = uP11
    }
    kalman[i] = f
    slope[i] = v
  }
  return { kalman, slope, varScale }
}

/**
 * L4 - Parabolic SAR (Wilder) on the Kalman curve. Feeding the filtered curve
 * as both high and low makes the flip fire the exact bar the STRUCTURE turns,
 * not bars later on noisy raw price. SHARED ENGINE (VSK L4 = TSK L4).
 */
export function layerSAR(curve: number[], step: number, max: number): { sar: number[]; dir: number[] } {
  const n = curve.length
  const sar = new Array<number>(n).fill(NaN)
  const dir = new Array<number>(n).fill(0)
  if (n < 3) return { sar, dir }
  let up = curve[1] >= curve[0]
  let af = step
  let ep = up ? Math.max(curve[0], curve[1]) : Math.min(curve[0], curve[1])
  let s = curve[0]
  dir[1] = up ? 1 : -1
  for (let i = 2; i < n; i++) {
    // advance
    s = s + af * (ep - s)
    const prev = curve[i - 1]
    const prev2 = curve[i - 2]
    const cur = curve[i]
    if (up) {
      // Wilder: clamp against the PRIOR two bars only, then test the current
      // bar against it - clamping against `cur` itself would make the flip
      // test unreachable (s <= cur always).
      s = Math.min(s, prev, prev2)
      if (cur < s) {
        // flip down
        up = false
        s = ep
        ep = cur
        af = step
      } else if (cur > ep) {
        ep = cur
        af = Math.min(af + step, max)
      }
    } else {
      s = Math.max(s, prev, prev2)
      if (cur > s) {
        // flip up
        up = true
        s = ep
        ep = cur
        af = step
      } else if (cur < ep) {
        ep = cur
        af = Math.min(af + step, max)
      }
    }
    sar[i] = s
    dir[i] = up ? 1 : -1
  }
  return { sar, dir }
}

// ─────────────────────────────────────────────────────────────────────────────
// The algorithm
// ─────────────────────────────────────────────────────────────────────────────

/** Run the full 4-layer stack over a candle array. Pure, O(n·lookback). */
export function computeVSK(candles: Candle[], params?: Partial<VSKParams>): VSKSeries {
  const p: VSKParams = { ...VSK_DEFAULTS, ...(params ?? {}) }
  const n = candles.length
  const empty: VSKSeries = {
    vwap: [], z: [], squeezeOn: [], widthPct: [], slopePct: [], runaway: [],
    kalman: [], slope: [], sar: [], sarDir: [], signal: [], state: [],
  }
  if (n < 30) return empty

  const { vwap, z } = layerVWAP(candles, p.vwapPeriod)
  const { kalman, slope } = layerKalman(candles, p)
  const { squeezeOn, widthPct, slopePct, runaway } = layerSqueeze(candles, p, slope)
  const { sar, dir } = layerSAR(kalman, p.sarStep, p.sarMax)

  const signal = new Array<number>(n).fill(0)
  const state = new Array<string>(n).fill('')
  for (let i = 1; i < n; i++) {
    const flipUp = dir[i] === 1 && dir[i - 1] === -1
    const flipDn = dir[i] === -1 && dir[i - 1] === 1
    const turnUp = finite(slope[i]) && finite(slope[i - 1]) && slope[i] > slope[i - 1]
    const turnDn = finite(slope[i]) && finite(slope[i - 1]) && slope[i] < slope[i - 1]
    // L1 arming: the stretch happened within the last armWindow bars
    let armedCall = false
    let armedPut = false
    let zArm = 0
    const lo = Math.max(0, i - p.armWindow + 1)
    for (let k = lo; k <= i; k++) {
      if (!finite(z[k])) continue
      if (z[k] <= -p.zEntry && (!armedCall || z[k] < zArm)) {
        armedCall = true
        zArm = z[k]
      }
      if (z[k] >= p.zEntry && (!armedPut || z[k] > zArm)) {
        armedPut = true
        zArm = z[k]
      }
    }
    const block = runaway[i]
    const call = flipUp && armedCall && turnUp && !block
    const put = flipDn && armedPut && turnDn && !block
    signal[i] = call ? 1 : put ? -1 : 0
    const layerBits = [
      `z:${finite(z[i]) ? z[i].toFixed(2) : '·'}${armedCall ? '↓ARM' : armedPut ? '↑ARM' : ''}`,
      squeezeOn[i] ? 'SQZ' : runaway[i] ? 'RUN!' : 'RNG',
      `sar:${dir[i] > 0 ? '↑' : '↓'}${flipUp ? 'FLIP↑' : flipDn ? 'FLIP↓' : ''}`,
    ]
    state[i] = layerBits.join('|')
  }
  return { vwap, z, squeezeOn, widthPct, slopePct, runaway, kalman, slope, sar, sarDir: dir, signal, state }
}

/**
 * Last-bar evaluation for the strategy registry / backtester / agent.
 * Bounded to the trailing 1400 bars: every layer is rolling, so signals on
 * the final bar are identical to a full-history pass at a fraction of the
 * cost (the backtester re-evaluates per bar).
 */
export function vskEvaluate(candles: Candle[], params?: Partial<VSKParams>): VSKEval {
  if (candles.length < 40) return { direction: 'none', score: 0, notes: 'warming up' }
  const p: VSKParams = { ...VSK_DEFAULTS, ...(params ?? {}) }
  const src = candles.length > 1400 ? candles.slice(-1400) : candles
  const s = computeVSK(src, p)
  const i = s.signal.length - 1
  const sig = s.signal[i]
  const zNow = s.z[i]
  const zTxt = finite(zNow) ? zNow.toFixed(2) : '·'
  const wTxt = finite(s.widthPct[i]) ? s.widthPct[i].toFixed(0) : '·'
  const regime = s.squeezeOn[i] ? 'squeeze' : s.runaway[i] ? 'runaway' : 'range'

  if (sig === 1) {
    const score = clamp(46 + Math.min(26, (Math.abs(zArm(s, i, -1, p)) - p.zEntry) * 14) + (s.squeezeOn[i] ? 8 : 4) + (finite(s.slopePct[i]) ? Math.min(8, s.slopePct[i] / 12) : 0), 42, 94)
    return {
      direction: 'call',
      score,
      notes: `L1 z ${zTxt} stretched below VWAP · L2 ${regime} (w${wTxt}) · L3 curve turning up · L4 SAR flipped UP on Kalman curve`,
    }
  }
  if (sig === -1) {
    const score = clamp(46 + Math.min(26, (Math.abs(zArm(s, i, 1, p)) - p.zEntry) * 14) + (s.squeezeOn[i] ? 8 : 4) + (finite(s.slopePct[i]) ? Math.min(8, s.slopePct[i] / 12) : 0), 42, 94)
    return {
      direction: 'put',
      score,
      notes: `L1 z ${zTxt} stretched above VWAP · L2 ${regime} (w${wTxt}) · L3 curve turning down · L4 SAR flipped DOWN on Kalman curve`,
    }
  }
  // no signal - explain WHICH layer is holding the door (agent/UI friendly)
  if (s.runaway[i]) {
    return { direction: 'none', score: 0, notes: `L2 BLOCK: runaway trend (width ${wTxt}pct, slope ${s.slopePct[i]?.toFixed(0) ?? '·'}pct) - fade suppressed` }
  }
  const armedLow = recentExtreme(s.z, i, p.armWindow, -1)
  const armedHigh = recentExtreme(s.z, i, p.armWindow, 1)
  if (!finite(armedLow) || armedLow > -p.zEntry) {
    if (!finite(armedHigh) || armedHigh < p.zEntry) {
      return { direction: 'none', score: 0, notes: `L1 idle: z ${zTxt} inside ±${p.zEntry} · L2 ${regime}` }
    }
    return { direction: 'none', score: 12, notes: `L1 armed UP-side (z ${zTxt}) but L4 waiting for SAR flip DOWN on curve` }
  }
  return { direction: 'none', score: 12, notes: `L1 armed DOWN-side (z ${zTxt}) but L4 waiting for SAR flip UP on curve` }
}

/** The most extreme z within the ARM window on one side (for scoring). */
function zArm(s: VSKSeries, i: number, side: -1 | 1, p: VSKParams): number {
  const e = recentExtreme(s.z, i, p.armWindow, side)
  return finite(e) ? e : side * p.zEntry
}

function recentExtreme(z: number[], i: number, window: number, side: -1 | 1): number {
  let best = NaN
  const lo = Math.max(0, i - window + 1)
  for (let k = lo; k <= i; k++) {
    if (!finite(z[k])) continue
    if (!finite(best)) best = z[k]
    else best = side === -1 ? Math.min(best, z[k]) : Math.max(best, z[k])
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────────────
// Monte Carlo - bootstrap resampling of the strategy's trade PnL sequence
// ─────────────────────────────────────────────────────────────────────────────

export interface VSKMonteCarloOptions {
  sims?: number // resampled paths (default 2000, cap 20000)
  startEquity?: number
  ruinPct?: number // "ruin" = equity <= start * ruinPct (default 0.6)
  seed?: number // deterministic runs for tests/repro
}

export interface VSKMonteCarloResult {
  sims: number
  trades: number
  perTrade: { mean: number; stdev: number; tStat: number; winRate: number; payoff: number }
  finalEquity: { p5: number; p25: number; median: number; p75: number; p95: number; mean: number }
  maxDD: { mean: number; median: number; p95: number; worst: number }
  probProfit: number
  probRuin: number
  actual: { maxWinStreak: number; maxLossStreak: number; totalPnl: number }
  fan: { step: number[]; p5: number[]; p50: number[]; p95: number[] }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return NaN
  const pos = clamp(q, 0, 1) * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * Bootstrap Monte Carlo over a trade PnL list: resample the sequence WITH
 * replacement sims times, rebuild each equity path, and report the
 * distribution of outcomes (final equity, drawdown, ruin probability) plus
 * p5/p50/p95 equity fan curves for charting.
 */
export function vskMonteCarlo(pnls: number[], opts?: VSKMonteCarloOptions): VSKMonteCarloResult {
  const sims = clamp(Math.max(1, opts?.sims ?? 2000), 1, 20000)
  const startEquity = Math.max(1, opts?.startEquity ?? 1000)
  const ruinLevel = startEquity * (opts?.ruinPct ?? 0.6)
  const rng = mulberry32(opts?.seed ?? 20260921)
  const n = pnls.length

  const mean = n ? pnls.reduce((a, b) => a + b, 0) / n : 0
  const variance = n > 1 ? pnls.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : 0
  const stdev = Math.sqrt(Math.max(variance, 0))
  const wins = pnls.filter((x) => x > 0).length
  const grossWin = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0)
  const grossLoss = -pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0)

  const finals: number[] = []
  const dds: number[] = []
  let ruined = 0
  let profitable = 0
  const fanSteps = Math.min(n, 200)
  const stepEvery = Math.max(1, Math.floor(n / fanSteps))
  const fanP5: number[] = []
  const fanP50: number[] = []
  const fanP95: number[] = []
  const fanStep: number[] = []
  const stepEquities: number[][] = []

  if (n === 0) {
    return {
      sims: 0, trades: 0,
      perTrade: { mean: 0, stdev: 0, tStat: 0, winRate: 0, payoff: 0 },
      finalEquity: { p5: startEquity, p25: startEquity, median: startEquity, p75: startEquity, p95: startEquity, mean: startEquity },
      maxDD: { mean: 0, median: 0, p95: 0, worst: 0 },
      probProfit: 0, probRuin: 0,
      actual: { maxWinStreak: 0, maxLossStreak: 0, totalPnl: 0 },
      fan: { step: [0], p5: [startEquity], p50: [startEquity], p95: [startEquity] },
    }
  }

  for (let s = 0; s < sims; s++) {
    let equity = startEquity
    let peak = startEquity
    let maxDD = 0
    let stepIdx = 0
    for (let t = 0; t < n; t++) {
      const pnl = pnls[Math.floor(rng() * n)] ?? 0
      equity += pnl
      if (equity > peak) peak = equity
      const dd = peak > 0 ? (peak - equity) / peak : 0
      if (dd > maxDD) maxDD = dd
      if (t === (stepIdx + 1) * stepEvery - 1) {
        stepIdx++
        ;(stepEquities[stepIdx - 1] ??= []).push(equity)
      }
    }
    finals.push(equity)
    dds.push(maxDD)
    if (equity > startEquity) profitable++
    if (equity <= ruinLevel) ruined++
  }

  // fan percentiles per step
  for (let k = 0; k < stepEquities.length; k++) {
    const col = [...(stepEquities[k] ?? [])].sort((a, b) => a - b)
    if (!col.length) continue
    fanStep.push((k + 1) * stepEvery)
    fanP5.push(quantile(col, 0.05))
    fanP50.push(quantile(col, 0.5))
    fanP95.push(quantile(col, 0.95))
  }

  // actual-sequence streaks (base-rate reality check vs resampled paths)
  let maxWinStreak = 0
  let maxLossStreak = 0
  let curW = 0
  let curL = 0
  for (const x of pnls) {
    if (x > 0) {
      curW++
      curL = 0
    } else if (x < 0) {
      curL++
      curW = 0
    }
    maxWinStreak = Math.max(maxWinStreak, curW)
    maxLossStreak = Math.max(maxLossStreak, curL)
  }

  const sortedFinals = [...finals].sort((a, b) => a - b)
  const sortedDD = [...dds].sort((a, b) => a - b)
  const tStat = stdev > 0 && n > 1 ? mean / (stdev / Math.sqrt(n)) : 0

  return {
    sims,
    trades: n,
    perTrade: {
      mean,
      stdev,
      tStat,
      winRate: n ? wins / n : 0,
      payoff: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    },
    finalEquity: {
      p5: quantile(sortedFinals, 0.05),
      p25: quantile(sortedFinals, 0.25),
      median: quantile(sortedFinals, 0.5),
      p75: quantile(sortedFinals, 0.75),
      p95: quantile(sortedFinals, 0.95),
      mean: finals.reduce((a, b) => a + b, 0) / sims,
    },
    maxDD: {
      mean: dds.reduce((a, b) => a + b, 0) / sims,
      median: quantile(sortedDD, 0.5),
      p95: quantile(sortedDD, 0.95),
      worst: sortedDD[sortedDD.length - 1] ?? 0,
    },
    probProfit: profitable / sims,
    probRuin: ruined / sims,
    actual: { maxWinStreak, maxLossStreak, totalPnl: pnls.reduce((a, b) => a + b, 0) },
    fan: { step: fanStep, p5: fanP5, p50: fanP50, p95: fanP95 },
  }
}
