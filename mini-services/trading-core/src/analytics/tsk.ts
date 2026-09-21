// IQAIR//OS - TSK Synthesis algorithm (volume-free sibling of VSK)
// ─────────────────────────────────────────────────────────────────────────────
// Same stacked philosophy as VSK Synthesis, ONE layer swapped: the volume-
// weighted VWAP boundary is replaced by a least-squares TRENDLINE boundary,
// so the whole stack runs on price alone (works on feeds with flat/zero
// volume and needs no volume semantics at all):
//
//   [ L1  Trendline Z-Score ]   rolling least-squares regression line over
//        │                      tlPeriod closes - the classic deviation
//        ▼                      channel. z = (close - line) / residual sigma
//                               arms the setup when price is stretched N
//                               sigmas off the FITTED TREND (not the mean).
//   [ L2  Volatility Squeeze ]  precision gate - TTM squeeze + BB-width
//        │                      percentile. A runaway trend BLOCKS the entry;
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
// Character vs VSK: VWAP-z reads "stretched from the volume-weighted MEAN"
// (pure reversion); trendline-z reads "stretched from the fitted TREND" -
// channel reversion that stays meaningful while a gentle trend carries the
// anchor. L2 still suppresses violent one-way moves.
//
// L2/L3/L4 are the SHARED ENGINES exported by vsk.ts (identical code path,
// one source of truth). L1 and the synthesis live here. Everything is pure:
// candles in → full per-bar series out (registry/chart friendly, NaN during
// warmup), a last-bar evaluate() for the strategy registry / backtester /
// agent, and a seeded bootstrap Monte Carlo over the resulting trade list.
// No I/O, no clock, no globals, NO VOLUME INPUTS.
// ─────────────────────────────────────────────────────────────────────────────

import type { Candle } from '../types'
import { layerSqueeze, layerKalman, layerSAR, type SqueezeCfg, type KalmanCfg } from './vsk'
import { vskMonteCarlo, type VSKMonteCarloOptions, type VSKMonteCarloResult } from './vsk'

export interface TSKParams extends SqueezeCfg, KalmanCfg {
  tlPeriod: number // L1 regression trendline window (bars)
  zEntry: number // L1 |z| that arms the setup
  armWindow: number // L1 how long a stretch stays armed (bars)
  sarStep: number // L4 PSAR acceleration factor step
  sarMax: number // L4 PSAR acceleration factor cap
}

export const TSK_DEFAULTS: TSKParams = {
  tlPeriod: 60,
  zEntry: 1.8,
  armWindow: 24, // spans extreme->flip latency: vs VSK the TILTED regression
  // anchor lets price rejoin the line FASTER than a flat VWAP mean, so the z
  // stretch peaks EARLIER relative to the PSAR-on-curve flip (measured 17-22
  // bars on oscillating data vs 10-15 for VSK) - the armed state must survive
  // that gap or L4 can never fire ("detect boundary, wait for flip")
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

export interface TSKSeries {
  trendline: number[] // L1 fitted regression value at each bar
  sigma: number[] // L1 residual std (channel unit)
  z: number[] // L1 (close - trendline) / sigma
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

export interface TSKEval {
  direction: 'call' | 'put' | 'none'
  score: number
  notes: string
}

const finite = (v: number): boolean => Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// ─────────────────────────────────────────────────────────────────────────────
// Layer engines
// ─────────────────────────────────────────────────────────────────────────────

/**
 * L1 - rolling least-squares trendline + residual z-score. O(1) per bar via
 * rolling moment sums S1=Σy, S2=Σy², S3=Σ(i·y) (absolute bar index moments),
 * with the window-relative r = idx - a handled analytically:
 *   Σr  = w(w-1)/2,  Σr² = w(w-1)(2w-1)/6          (constants)
 *   Σry = S3 - a·S1                                 (a = first bar of window)
 * slope b = (w·Σry - Σr·Σy) / (w·Σr² - Σr²), intercept a₀ = ȳ - b·r̄.
 * Fitted value at the CURRENT bar (r = w-1) is tl = ȳ + b·(w-1)/2; the
 * residual sigma comes from the closed-form window RSS, so z reads "sigmas
 * from the fitted trend" - a standard deviation channel, volume-free.
 */
function layerTrendline(
  candles: Candle[],
  period: number
): { trendline: number[]; sigma: number[]; z: number[] } {
  const n = candles.length
  const trendline = new Array<number>(n).fill(NaN)
  const sigma = new Array<number>(n).fill(NaN)
  const z = new Array<number>(n).fill(NaN)
  const w = Math.max(3, Math.floor(period))
  const y = candles.map((c) => c.close)
  const Sr = (w * (w - 1)) / 2
  const Sr2 = (w * (w - 1) * (2 * w - 1)) / 6
  const den = w * Sr2 - Sr * Sr // > 0 for every w >= 2
  let S1 = 0
  let S2 = 0
  let S3 = 0
  for (let i = 0; i < n; i++) {
    S1 += y[i]
    S2 += y[i] * y[i]
    S3 += i * y[i]
    const k = i - w
    if (k >= 0) {
      S1 -= y[k]
      S2 -= y[k] * y[k]
      S3 -= k * y[k]
    }
    if (i < w - 1) continue
    const a = i - w + 1 // first bar of the window
    const Sry = S3 - a * S1
    const b = (w * Sry - Sr * S1) / den
    const yBar = S1 / w
    const rBar = Sr / w // = (w-1)/2
    const a0 = yBar - b * rBar
    const tl = a0 + b * (w - 1) // fitted at the current bar
    // closed-form window RSS = Σ(y - a0 - b·r)²
    const rss = S2 - 2 * a0 * S1 - 2 * b * Sry + w * a0 * a0 + 2 * a0 * b * Sr + b * b * Sr2
    const sig = Math.sqrt(Math.max(rss, 0) / w)
    trendline[i] = tl
    sigma[i] = sig
    z[i] = sig > 1e-12 ? clamp((y[i] - tl) / sig, -12, 12) : 0
  }
  return { trendline, sigma, z }
}

// ─────────────────────────────────────────────────────────────────────────────
// The algorithm
// ─────────────────────────────────────────────────────────────────────────────

/** Run the full 4-layer stack over a candle array. Pure, O(n·lookback). */
export function computeTSK(candles: Candle[], params?: Partial<TSKParams>): TSKSeries {
  const p: TSKParams = { ...TSK_DEFAULTS, ...(params ?? {}) }
  const n = candles.length
  const empty: TSKSeries = {
    trendline: [], sigma: [], z: [], squeezeOn: [], widthPct: [], slopePct: [], runaway: [],
    kalman: [], slope: [], sar: [], sarDir: [], signal: [], state: [],
  }
  if (n < 30) return empty

  const { trendline, sigma, z } = layerTrendline(candles, p.tlPeriod)
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
      `tl:${finite(z[i]) ? z[i].toFixed(2) : '·'}${armedCall ? '↓ARM' : armedPut ? '↑ARM' : ''}`,
      squeezeOn[i] ? 'SQZ' : runaway[i] ? 'RUN!' : 'RNG',
      `sar:${dir[i] > 0 ? '↑' : '↓'}${flipUp ? 'FLIP↑' : flipDn ? 'FLIP↓' : ''}`,
    ]
    state[i] = layerBits.join('|')
  }
  return { trendline, sigma, z, squeezeOn, widthPct, slopePct, runaway, kalman, slope, sar, sarDir: dir, signal, state }
}

/**
 * Last-bar evaluation for the strategy registry / backtester / agent.
 * Bounded to the trailing 1400 bars: every layer is rolling, so signals on
 * the final bar are identical to a full-history pass at a fraction of the
 * cost (the backtester re-evaluates per bar).
 */
export function tskEvaluate(candles: Candle[], params?: Partial<TSKParams>): TSKEval {
  if (candles.length < 40) return { direction: 'none', score: 0, notes: 'warming up' }
  const p: TSKParams = { ...TSK_DEFAULTS, ...(params ?? {}) }
  const src = candles.length > 1400 ? candles.slice(-1400) : candles
  const s = computeTSK(src, p)
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
      notes: `L1 z ${zTxt} stretched below trendline · L2 ${regime} (w${wTxt}) · L3 curve turning up · L4 SAR flipped UP on Kalman curve`,
    }
  }
  if (sig === -1) {
    const score = clamp(46 + Math.min(26, (Math.abs(zArm(s, i, 1, p)) - p.zEntry) * 14) + (s.squeezeOn[i] ? 8 : 4) + (finite(s.slopePct[i]) ? Math.min(8, s.slopePct[i] / 12) : 0), 42, 94)
    return {
      direction: 'put',
      score,
      notes: `L1 z ${zTxt} stretched above trendline · L2 ${regime} (w${wTxt}) · L3 curve turning down · L4 SAR flipped DOWN on Kalman curve`,
    }
  }
  // no signal - explain WHICH layer is holding the door (agent/UI friendly)
  if (s.runaway[i]) {
    return { direction: 'none', score: 0, notes: `L2 BLOCK: runaway trend (width ${wTxt}pct, slope ${s.slopePct[i]?.toFixed(0) ?? '·'}pct) - entry suppressed` }
  }
  const armedLow = recentExtreme(s.z, i, p.armWindow, -1)
  const armedHigh = recentExtreme(s.z, i, p.armWindow, 1)
  if (!finite(armedLow) || armedLow > -p.zEntry) {
    if (!finite(armedHigh) || armedHigh < p.zEntry) {
      return { direction: 'none', score: 0, notes: `L1 idle: z ${zTxt} inside ±${p.zEntry} of trendline · L2 ${regime}` }
    }
    return { direction: 'none', score: 12, notes: `L1 armed UP-side (z ${zTxt}) but L4 waiting for SAR flip DOWN on curve` }
  }
  return { direction: 'none', score: 12, notes: `L1 armed DOWN-side (z ${zTxt}) but L4 waiting for SAR flip UP on curve` }
}

/** The most extreme z within the ARM window on one side (for scoring). */
function zArm(s: TSKSeries, i: number, side: -1 | 1, p: TSKParams): number {
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
// Monte Carlo - the generic seeded bootstrap over trade PnL (shared with VSK)
// ─────────────────────────────────────────────────────────────────────────────

export type TSKMonteCarloOptions = VSKMonteCarloOptions
export type TSKMonteCarloResult = VSKMonteCarloResult
export const tskMonteCarlo = vskMonteCarlo
