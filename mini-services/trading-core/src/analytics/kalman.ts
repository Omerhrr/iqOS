// IQAIR//OS - Kalman filter + Ornstein-Uhlenbeck mean-reversion model
//
// The OU process dX = kappa*(theta - X)*dt + sigma*dW is the canonical
// continuous-time mean-reverting process. Discretized per bar it is exactly
// an AR(1):
//   x_{t+1} = theta + phi*(x_t - theta) + eps,   phi = e^{-kappa*dt}
// We fit (theta, phi, sigma_eps) by OLS over a rolling window, derive kappa,
// the half-life ln(2)/kappa and the stationary std sigma_eq =
// sigma_eps/sqrt(1 - phi^2), then run a scalar Kalman filter whose transition
// equation is the OU drift itself - so the filtered fair value anticipates
// reversion toward theta instead of merely lagging price.
//
// Signals fire when price stretches |z| sigmas from the equilibrium with
// z = (price - theta)/sigma_eq, gated by reversion significance (t-stat of
// 1-phi) so trending/random-walk regimes do not produce fade signals.

import type { Candle, KalmanOUResult, OULive, OUParams, OUSeries } from '../types'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const HL_CAP = 9999 // JSON-safe "effectively no reversion" sentinel

/**
 * OLS fit of the discretized OU (AR(1)) over the last `window` closes.
 * Returns the process parameters plus fit diagnostics (R^2, t-stat of 1-b).
 */
export function ouEstimate(closesArr: number[], window = 240): OUParams {
  const n = closesArr.length
  const w = Math.min(Math.max(window, 30), Math.max(n - 1, 30))
  const x = closesArr.slice(Math.max(0, n - w - 1)) // w+1 points -> w pairs
  const m = x.length - 1

  // degenerate input -> flat, non-reverting placeholder (all finite: JSON-safe)
  const fallback = (): OUParams => {
    let s = 0
    for (const v of x) if (Number.isFinite(v)) s += v
    return { theta: s / Math.max(x.length, 1), phi: 1, kappa: 0, sigmaEps: 0, sigmaEq: 0, halfLifeBars: HL_CAP, r2: 0, tStat: 0, sample: m }
  }
  if (m < 10) return fallback()

  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < m; i++) {
    const a = x[i]
    const b = x[i + 1]
    if (!Number.isFinite(a) || !Number.isFinite(b)) return fallback()
    sx += a
    sy += b
    sxx += a * a
    sxy += a * b
  }
  const den = m * sxx - sx * sx
  const rawB = den === 0 ? 1 : (m * sxy - sx * sy) / den
  const rawA = (sy - rawB * sx) / m

  const ybar = sy / m
  const xbar = sx / m
  let ssRes = 0
  let ssTot = 0
  let ssX = 0
  for (let i = 0; i < m; i++) {
    const a = x[i]
    const y = x[i + 1]
    const fit = rawA + rawB * a
    ssRes += (y - fit) * (y - fit)
    ssTot += (y - ybar) * (y - ybar)
    ssX += (a - xbar) * (a - xbar)
  }
  const sigmaEps = m > 2 ? Math.sqrt(Math.max(ssRes, 0) / (m - 2)) : 0
  const r2 = ssTot > 0 ? clamp(1 - ssRes / ssTot, 0, 1) : 0
  const seB = ssX > 0 && sigmaEps > 0 ? sigmaEps / Math.sqrt(ssX) : 0
  const tStat = seB > 0 ? (1 - rawB) / seB : 0

  const phi = clamp(rawB, 0.01, 0.9995)
  const kappa = -Math.log(phi)
  let lo = Infinity
  let hi = -Infinity
  for (const v of x) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  // near unit root: the intercept ratio explodes - fall back to the window mean
  let theta = Math.abs(1 - rawB) < 0.002 ? ybar : rawA / (1 - rawB)
  theta = clamp(theta, lo * 0.25, hi * 1.75) // sanity guard against absurd equilibria
  const sigmaEq = sigmaEps / Math.sqrt(Math.max(1 - phi * phi, 1e-6))
  const halfLifeBars = kappa > 1e-4 ? Math.min(Math.log(2) / kappa, HL_CAP) : HL_CAP

  return { theta, phi, kappa, sigmaEps, sigmaEq, halfLifeBars, r2, tStat, sample: m }
}

/** Shared classification: regime flag, stretch state, directional signal. */
function classify(est: OUParams, z: number, zStretch: number): Pick<OULive, 'meanReverting' | 'state' | 'signal' | 'score' | 'note'> {
  const meanReverting = est.tStat >= 1.5 && est.halfLifeBars <= 250 && est.sigmaEq > 0
  const state = z <= -zStretch ? 'stretched-below' : z >= zStretch ? 'stretched-above' : 'neutral'
  const signal =
    meanReverting && z <= -zStretch ? 'call' : meanReverting && z >= zStretch ? 'put' : 'none'
  const score =
    signal === 'none'
      ? 0
      : clamp(40 + (Math.abs(z) - zStretch) * 20 + Math.min(15, Math.max(0, est.tStat) * 3), 35, 92)
  const hl = est.halfLifeBars >= HL_CAP ? '∞' : est.halfLifeBars.toFixed(0)
  const note = meanReverting
    ? `z ${z.toFixed(2)}σ from OU mean · half-life ${hl} bars · κ ${est.kappa.toFixed(3)}`
    : `no reversion edge · t ${est.tStat.toFixed(1)} · half-life ${hl} bars`
  return { meanReverting, state, signal, score, note }
}

/**
 * Cheap live state (single window estimate, no filter, no series).
 * Used by scanSnapshot so a full-universe sweep stays cheap.
 */
export function ouState(closesArr: number[], window = 240, zStretch = 1.5): OULive {
  const est = ouEstimate(closesArr, window)
  const sigmaEq = est.sigmaEq > 1e-12 ? est.sigmaEq : 1
  const last = closesArr[closesArr.length - 1] ?? est.theta
  const z = Number.isFinite(last) ? clamp((last - est.theta) / sigmaEq, -12, 12) : 0
  return { ...est, z, ...classify(est, z, zStretch) }
}

/**
 * Rolling per-bar OU estimation + a scalar Kalman forward pass whose state
 * equation is the OU drift. Arrays are full-length and NaN before warmup so
 * they align 1:1 with the candle array (registry/chart friendly).
 */
export function ouSeries(candles: Candle[], window = 240, zMult = 2, obsNoise = 0.5): OUSeries {
  const n = candles.length
  const closesArr = candles.map((c) => c.close)
  const w = Math.min(Math.max(window, 30), Math.max(n - 1, 30))
  const filtered = new Array<number>(n).fill(NaN)
  const theta = new Array<number>(n).fill(NaN)
  const upper = new Array<number>(n).fill(NaN)
  const lower = new Array<number>(n).fill(NaN)
  const z = new Array<number>(n).fill(NaN)
  const innovationZ = new Array<number>(n).fill(NaN)
  if (n < 40) return { filtered, theta, upper, lower, z, innovationZ }

  let xh = closesArr[w - 1]
  let P = 1
  for (let i = w; i < n; i++) {
    const est = ouEstimate(closesArr.slice(i - w, i + 1), w) // window ends at bar i
    const Q = Math.max(est.sigmaEps * est.sigmaEps, 1e-18)
    if (i === w) P = Math.max(est.sigmaEq * est.sigmaEq, 1e-18)

    // predict: pull the latent level toward the OU equilibrium
    xh = est.theta + est.phi * (xh - est.theta)
    P = est.phi * est.phi * P + Q

    // update with the observed close
    const R = Math.max(obsNoise * Q, 1e-18)
    const innov = closesArr[i] - xh
    const S = P + R
    const K = P / S
    xh += K * innov
    P *= 1 - K

    filtered[i] = xh
    innovationZ[i] = S > 0 ? innov / Math.sqrt(S) : 0
    theta[i] = est.theta
    upper[i] = est.theta + zMult * est.sigmaEq
    lower[i] = est.theta - zMult * est.sigmaEq
    z[i] = est.sigmaEq > 1e-12 ? clamp((closesArr[i] - est.theta) / est.sigmaEq, -12, 12) : 0
  }
  return { filtered, theta, upper, lower, z, innovationZ }
}

/**
 * Full model for AnalysisResult: live state from the final window plus a
 * capped z-history for the quant panel sparkline.
 */
export function ouKalman(candles: Candle[], window = 240, zMult = 2, obsNoise = 0.5): KalmanOUResult {
  const closesArr = candles.map((c) => c.close)
  const live = ouState(closesArr, window)
  const s = ouSeries(candles, window, zMult, obsNoise)
  let innovationZ = 0
  for (let i = s.innovationZ.length - 1; i >= 0; i--) {
    if (Number.isFinite(s.innovationZ[i])) {
      innovationZ = s.innovationZ[i]
      break
    }
  }
  const zSeries = s.z.slice(-240).map((v) => (Number.isFinite(v) ? v : null))
  return {
    ...live,
    window: Math.min(Math.max(window, 30), Math.max(closesArr.length - 1, 30)),
    zMult,
    innovationZ,
    zSeries,
  }
}
