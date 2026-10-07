// IQAIR//OS - OTC TWIN ENGINE (Task 54)
//
// THE REVERSE-ENGINEERED BROKER GENERATOR, IMPLEMENTED BY US.
//
// This is not a metaphor and not a bootstrap: Tasks 52+53 recovered a
// complete statistical specification of how the broker's OTC engine
// behaves, by calibrating detectors on known generators (mulberry32 /
// LCG48 / CSPRNG controls) and contrasting 31k+ depth-matched real vs
// OTC 1m candles across 155 pairs. The recovered spec:
//
//   1. STEPS ARE IID (zero memory) - |r| autocorr lag-1 ~0.003-0.028
//      vs 0.24-0.27 on real FX; Ljung-Box(10) p 0.34-0.86 vs p~0 real.
//   2. STEP SIZES NEAR-GAUSSIAN - excess kurtosis ~4 vs 161-236 real.
//   3. PER-PAIR SIGMA CALIBRATION - each pair gets its own vol scalar.
//   4. SIGNS ARE A FAIR COIN, independent of magnitude - decided split
//      49.6-50.7% across pairs (|z| < 1.71), tick P(same sign) fair.
//   5. FINE DECIMAL LATTICE (1e-5..1e-6) - ~1% candle flat mass emerges
//      from quantization (coarse-grid pairs like BONK get 15-18%).
//   6. CSPRNG-GRADE SEQUENCING - mulberry32 is LOUDLY detectable through
//      the identical pipeline (ngram z=+65.9); their stream is silent at
//      every calibrated detector. So: our twin defaults to Web Crypto.
//   7. NO SESSION STRUCTURE - hourly vol spread 1.1x vs 3.6-3.8x real.
//   8. NO BID-ASK BOUNCE - real ticks show anti-persistence
//      (P(same sign) 0.35-0.43, z -8..-14); OTC ticks are fair.
//
// One line: THEY SIMULATE SCALE, NOT MARKET. An iid Gaussian walk on a
// decimal lattice is maximum entropy - there is nothing to predict, which
// is exactly why four consecutive "edges" we chased (BONK drift,
// interpolation runway, mechanical alternation, draw-as-win accounting)
// all died under the audit protocol. The twin exists so that:
//
//   - Any "OTC strategy" can be trialed against a stream that is the same
//     statistical animal as the broker feed. Edge found HERE is by
//     definition an artifact; edge on the real feed that does not beat
//     this twin's placebo distribution is the same thing.
//   - The forensics/authenticity stack has a living calibration target:
//     the twin MUST read synthetic-like by construction. If the real feed
//     ever stops reading that way, the broker changed generators - and
//     THAT event re-opens the prediction case with new evidence.
//
// Honesty about the RNG: the broker (almost certainly) does not use Web
// Crypto either - it uses SOME CSPRNG we cannot fingerprint. Our csprng
// mode is "same security class, different algorithm"; that is the best
// any outsider can do, and it is exactly what the forensics says about
// THEIR stream too (class-fingerprintable, algorithm-invisible).

import type { Candle } from '../types'
import { mulberry32 } from './synthfeed'

export interface TwinParams {
  /** Anchor price: the pair's last observed close. */
  p0: number
  /** Per-step (per-candle) standard deviation in ABSOLUTE price units. */
  sigmaPerStep: number
  /** Decimal lattice (price grid), e.g. 1e-5. */
  lattice: number
  /** Measured flat-candle rate of the source pair (context only). */
  flatRate: number
  /** Probability a candle is a complete stall (0 move) beyond what pure
   *  lattice quantization already produces - the spec's extra flat mass. */
  stallProb: number
  /** Mean absolute candle step of the source pair. */
  meanAbsStep: number
  /** How many source candles the calibration came from. */
  sourceN: number
}

export interface TwinSelfTest {
  flatRate: number
  decidedShare: number
  decidedUpRate: number
  decidedZ: number
  absAcf1: number
  /** 'synthetic-like' is the ONLY healthy verdict for a twin. */
  authenticityVerdict: string
}

export interface OtcTwinResult {
  candles: Candle[]
  params: TwinParams
  rngMode: 'csprng' | 'seeded'
  seed: number | null
  selfTest: TwinSelfTest
}

const GRID_CANDIDATES = [1e-3, 5e-4, 2e-4, 1e-4, 5e-5, 2e-5, 1e-5, 5e-6, 2e-6, 1e-6]

/** Abramowitz-Stegun 7.1.26 erf (|err| < 1.5e-7) - enough for flat-mass math. */
function erf(x: number): number {
  const s = Math.sign(x)
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x)
  return s * y
}

/**
 * Estimate twin parameters from the pair's own observed OTC candles -
 * mirroring how the broker calibrates vol PER PAIR. Sigma comes from the
 * mean absolute step via the half-normal relation E|X| = sigma*sqrt(2/pi)
 * (steps are near-Gaussian per spec point 2, so this estimator is
 * efficient here - it would NOT be on real fat-tailed feeds).
 */
export function estimateTwinParams(candles: Candle[]): TwinParams | null {
  if (candles.length < 60) return null
  const steps: number[] = []
  let flat = 0
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close
    if (d === 0) flat++
    steps.push(d)
  }
  const meanAbs = steps.reduce((s, v) => s + Math.abs(v), 0) / steps.length
  if (!(meanAbs > 0)) return null
  const sigma = meanAbs / Math.sqrt(2 / Math.PI)
  // dominant lattice: coarsest grid covering >=95% of closes (same rule as
  // /otc_forensics - finest-first would always match a dust-level grid)
  let lattice = 0
  for (const g of GRID_CANDIDATES) {
    const cov = candles.filter((c) => Math.abs(Math.round(c.close / g) * g - c.close) < 1e-9).length / candles.length
    if (cov >= 0.95) {
      lattice = g
      break
    }
  }
  if (!(lattice > 0)) lattice = 1e-5
  // how much flat mass pure quantization already implies: P(|N(0,sigma)| <
  // lattice/2) rounds to the same lattice unit. Whatever flat mass the pair
  // shows BEYOND that is generator stall - reproduce it explicitly.
  const qFlat = erf(lattice / 2 / sigma / Math.SQRT2)
  const stallProb = Math.max(0, Math.min(0.4, flat / steps.length - qFlat))
  return {
    p0: candles[candles.length - 1].close,
    sigmaPerStep: sigma,
    lattice,
    flatRate: flat / steps.length,
    stallProb,
    meanAbsStep: meanAbs,
    sourceN: candles.length,
  }
}

/** One uniform in [0,1) from Web Crypto (CSPRNG class, spec point 6). */
function csprngUniform(): number {
  const u = new Uint32Array(1)
  crypto.getRandomValues(u)
  return u[0] / 4294967296
}

/**
 * Generate the twin: n candles of iid near-Gaussian steps on a decimal
 * lattice, starting from p0, one candle per tfSec.
 *
 * Step distribution: a 2-component Gaussian scale mixture - 95% N(0,sigma)
 * + 5% N(0,2*sigma) - which lands kurtosis at ~3.97, matching the measured
 * broker spec (3.9-4.2, i.e. MILD fat tails; a pure Gaussian would read 3,
 * real markets read 161+). Signs stay a fair coin by symmetry (spec point
 * 4). Stall candles (spec's extra flat mass, spec point 5) collapse to a
 * zero move with probability params.stallProb.
 *
 * Intra-candle realism: the candle's step Z is split into SUB sub-steps via
 * a random Brownian-bridge decomposition (g_i normalized so they sum to
 * exactly Z), and the path is quantized to the lattice as it unfolds - the
 * twin gets realistic wicks WITHOUT importing any structure (pure diffusion
 * geometry, same as the broker's candle renderer).
 */
export function generateOtcTwin(params: TwinParams, n: number, tfSec: number, opts?: { seed?: number }): OtcTwinResult {
  const SUB = 12
  const rngMode: 'csprng' | 'seeded' = opts?.seed !== undefined ? 'seeded' : 'csprng'
  const rng = opts?.seed !== undefined ? mulberry32(opts.seed) : csprngUniform
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(params.lattice))))
  const quant = (units: number) => +(units * params.lattice).toFixed(decimals)
  const normal = () => {
    // Box-Muller; guard u1=0 (log(0))
    let u1 = rng()
    if (u1 <= 0) u1 = 2.3283064365386963e-10 // 2^-32, smallest positive
    const u2 = rng()
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }
  // walk in LATTICE UNITS (integers) - zero accumulation drift, flats fall
  // out of quantization exactly like the broker's renderer (spec point 5)
  let units = Math.round(params.p0 / params.lattice)
  const t0 = Math.floor(Date.now() / 1000 / tfSec) * tfSec - (n - 1) * tfSec
  const candles: Candle[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const open = quant(units)
    let hi = units
    let lo = units
    if (rng() < params.stallProb) {
      // generator stall: the whole candle settles on the same lattice unit
    } else {
      const big = rng() < 0.05
      // mixture (1 at sigma, 2 at sigma) has variance 1.15 -> normalize so
      // the calibrated sigma stays the ACTUAL per-step stdev
      const Z = (params.sigmaPerStep * (big ? 2 : 1) * normal()) / Math.sqrt(1.15)
      // Brownian bridge: split Z into SUB pieces that sum to Z exactly
      const g: number[] = []
      let ss = 0
      for (let s = 0; s < SUB; s++) {
        const v = normal()
        g.push(v)
        ss += v * v
      }
      const inv = ss > 0 ? 1 / Math.sqrt(ss) : 0
      let cum = 0
      for (let s = 0; s < SUB; s++) {
        cum += g[s] * inv
        const pos = units + Math.round((Z * cum) / params.lattice)
        if (pos > hi) hi = pos
        if (pos < lo) lo = pos
      }
      units += Math.round(Z / params.lattice)
    }
    const close = quant(units)
    candles[i] = {
      time: t0 + i * tfSec,
      open,
      high: quant(hi),
      low: quant(lo),
      close,
      volume: 0,
    }
  }
  return { candles, params, rngMode, seed: opts?.seed ?? null, selfTest: twinSelfTest(candles) }
}

/**
 * Self-test on the twin's own output: decided-coin + |r| acf1 + the same
 * authenticity rule /otc_forensics uses. A healthy twin reads
 * synthetic-like with a fair coin - if it EVER reads otherwise, our own
 * generator code is broken, which is the kind of error this catches.
 */
export function twinSelfTest(candles: Candle[]): TwinSelfTest {
  let up = 0
  let down = 0
  let flat = 0
  const absSteps: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close
    if (d > 0) up++
    else if (d < 0) down++
    else flat++
    absSteps.push(Math.abs(d))
  }
  const T = up + down + flat
  const dec = up + down
  const decUp = up / Math.max(1, dec)
  const z = (decUp - 0.5) / Math.sqrt(0.25 / Math.max(1, dec))
  const NA = absSteps.length
  const mA = absSteps.reduce((s, v) => s + v, 0) / Math.max(1, NA)
  const dev = absSteps.map((v) => v - mA)
  const c0 = dev.reduce((s, v) => s + v * v, 0)
  const rho = (k: number) => (c0 > 0 ? dev.slice(k).reduce((s, v, i) => s + v * dev[i], 0) / c0 : 0)
  const acf1 = NA > 1 ? rho(1) : 0
  // noise-aware floor: |r| acf1 sampling noise is ~1/sqrt(N); the fixed 0.05
  // verdict floor matches /otc_forensics at n~2000, but a 500-candle twin
  // has a +-0.09 floor - without this, healthy small twins read
  // 'inconclusive' on pure noise
  const floor = Math.max(0.05, 2.2 / Math.sqrt(Math.max(1, NA)))
  // Task 58 (P3): the verdict used to gate ONLY on |acf1| - decidedZ (the
  // fair-coin check) was computed but never gated, so a twin with a biased
  // sign generator still read "synthetic-like" despite the doc promising the
  // coin is checked. Both conditions now gate (3.5sigma on the coin z).
  const zFloor = 3.5
  const coinOk = Math.abs(z) <= zFloor
  const verdict = Math.abs(acf1) <= floor && coinOk ? 'synthetic-like' : acf1 >= floor || !coinOk ? 'real-like' : 'inconclusive'
  return {
    flatRate: +(flat / Math.max(1, T)).toFixed(4),
    decidedShare: +(dec / Math.max(1, T)).toFixed(4),
    decidedUpRate: +decUp.toFixed(4),
    decidedZ: +z.toFixed(2),
    absAcf1: +acf1.toFixed(4),
    authenticityVerdict: verdict,
  }
}
