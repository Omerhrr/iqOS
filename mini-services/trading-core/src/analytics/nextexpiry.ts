// IQAIR//OS - Next-Expiry Oracle engine
//
// The Next-Candle Oracle answers "which way is the NEXT candle going?" -
// one fixed horizon (the chart's own next bar). This engine answers the
// question a minutes-expiry trader actually faces first: "WHICH expiry
// should I even take right now?" Binary platforms offer 1/2/3/5/15-minute
// expiries on the same asset at the same moment, and they are NOT equally
// forecastable - a pair can be clean and persistent at the 1-minute scale
// while its 15-minute horizon is a coin flip, or mean-revert like clockwork
// every ~4 minutes so that the 3m/5m windows are the tradeable ones.
//
// For every expiry E in {1,2,3,5,15} the engine fuses its own panel of
// horizon-native prediction models (all computed on closed 1m candles,
// horizon E measured in whole minutes ahead):
//
//   1. Markov H-E transitions - 3-bar direction-state -> forward E-minute
//      outcome counts (Laplace-smoothed). The oracle's Markov driver,
//      generalized from "next bar" to "E bars ahead".
//   2. Variance-ratio read - VR(E) = Var(E-step returns) / (E * Var(1-step))
//      over non-overlapping windows. VR > 1 = price trends at this horizon
//      (momentum gets the vote), VR < 1 = price mean-reverts (fade gets the
//      vote), VR ~ 1 = the honest read is "nobody knows": the driver
//      ABSTAINS at that expiry rather than inventing a direction.
//   3. OU half-life fade - AR(1) on log price gives a reversion half-life H;
//      a Gaussian affinity of E to H weights the fade strongest exactly at
//      the expiry where the pair historically snaps back. Level-based (works
//      from stretch, not returns) so it disagrees with #2 for a reason.
//   4. Run-length exhaustion - when the current same-sign run already
//      matches/exceeds its historical norm, the empirical forward-outcome
//      distribution at that run depth calls continuation vs exhaustion.
//   5. Session drift - the pair's own average forward-E return during THIS
//      session bucket (classifySession), capturing intraday physiology
//      (London-morning drift persists; thin OFF-hours drift doesn't).
//
// REGIME AFFINITY: the kernel's own classifyRegime (same 4-way read the
// Next-Candle Oracle and autopilot gate on) shapes per-expiry weights, not
// directions - TRENDING regimes boost the long expiries where a trend has
// time to pay, RANGING boosts the short snap-back expiries, VOLATILE
// flattens everything (nobody is trustworthy in chaos) and widens the
// direction deadband. MIXED is neutral.
//
// HONESTY: every numeric the engine emits is clamped/grounded (NaN in a
// driver just means the driver doesn't fire that bar), fusion needs >= 2
// active models per expiry or the row reports ok:false ("warming up") in
// plain language, and the row's confidence is discounted by the plugin's
// OWN resolved record for that exact (asset, expiry) - an oracle that has
// been wrong at the 5-minute expiry speaks more humbly about 5-minute
// expiries specifically (same honesty-loop contract as the Next-Candle
// Oracle, plugins/nextexpiry.ts).

import type { Candle } from '../types'
import { ewmaVol, garchVol } from './quant'
import { atr } from './indicators'
import { classifyRegime } from './regime'
import type { OracleRegime } from './nextcandle'
import { applyCalibrationDiscount } from './nextcandle'
import { classifySession, type Session } from './session'
import type { AnalysisResult } from '../types'

/** The expiries this oracle reads, in minutes - matches the standard
 * binary-option expiry ladder the panels offer. */
export const EXPIRIES_MIN = [1, 2, 3, 5, 15] as const
export type ExpiryMin = (typeof EXPIRIES_MIN)[number]

/** Minimum closed 1m bars before the engine will speak at all - enough for
 * the 15m expiry's non-overlapping variance-ratio sample plus driver
 * warmups. Below this the route fails closed ("needs N+ closed 1m bars"). */
export const EXPIRY_ORACLE_MIN_CANDLES = 720
/** Bars scanned for forward-outcome statistics (markov/runs/session). */
const FWD_WINDOW = 900
/** Non-overlapping E-step samples required before the variance-ratio read
 * is trusted at that expiry (15m needs the deepest history: ~55 x 15). */
const VR_MIN_SAMPLES = 55
/** In-state observations before the Markov H-E driver speaks. */
const MARKOV_STATE_MIN = 30
/** Matching run-depth observations before Run exhaustion speaks. */
const RUN_STATE_MIN = 25
/** Same-session historical bars before Session drift speaks. */
const SESSION_MIN = 40
/** Direction deadband away from coin-flip (mirrors the Next-Candle Oracle;
 * VOLATILE regimes demand more separation). */
const DEADBAND = 0.06
const VOLATILE_DEADBAND = 0.09
/** Best-pick floors: a recommended expiry must clear BOTH a pWin floor and
 * a confidence floor, or the oracle says "no edge - wait" (the honest
 * default; most bars are not worth an expiry pick). */
const BEST_MIN_PWIN = 0.56
const BEST_MIN_CONF = 25
/** Log-odds fusion needs at least this many active models per expiry. */
const MIN_ACTIVE_DRIVERS = 2
const MAX_BAR_WINDOW = 1600 // plugin fetch cap, mirrored for safety

export interface ExpiryDriver {
  name: string
  /** the model's own read of P(close E minutes ahead > spot) */
  pUp: number
  /** weight used in this expiry's fusion (post-regime-affinity) */
  weight: number
  /** signed -1..+1 convenience read for the UI */
  vote: number
  /** one-line human explanation of what the model sees at THIS expiry */
  detail: string
}

export interface ExpiryRow {
  /** expiry horizon in whole minutes (1/2/3/5/15) */
  expiry: number
  /** false = this expiry's models are still warming up (thin history);
   * the panel renders it grayed with `note`, never as a recommendation */
  ok: boolean
  note: string
  pUp: number
  direction: 'call' | 'put' | 'none'
  /** probability the RECOMMENDED direction wins = max(pUp, 1-pUp) */
  pWin: number
  /** 0..100 - agreement + distance from coin-flip, x predictability,
   * discounted by this (asset, expiry)'s own honesty record */
  confidence: number
  rawConfidence: number
  /** tradability score for the best-pick ranking:
   * (pWin - 0.5) x predictability x confidence/100 */
  edge: number
  /** 0..1 - how non-random this horizon's variance ratio is right now */
  predictability: number
  /** expected |move| over the window in price units (VR-adjusted) */
  expectedMove: number
  /** spot-centered cone the move is expected to land inside */
  cone: { low: number; high: number }
  drivers: ExpiryDriver[]
  driversActive: number
  /** the plugin's resolved honesty record for THIS (asset, expiry) */
  calibration: { n: number; hitRate: number; brier: number } | null
  /** 1m bar-open timestamp whose CLOSE resolves this window (entry ~ spot
   * at issue; exit = that bar's close) - the plugin anchors resolution on
   * it and the panel shows the countdown against it */
  targetBarTime: number
}

export interface NextExpiryPrediction {
  asset: string
  ts: number
  mode: 'sim' | 'live'
  /** spot = last closed 1m close - the entry every row is measured from */
  price: number
  regime: OracleRegime
  session: Session
  /** OU reversion half-life in WHOLE MINUTES (the expiry compass) - null
   * when the pair isn't mean-reverting enough to have one */
  halfLifeMin: number | null
  /** one row per EXPIRIES_MIN entry, ascending - always all 5, with
   * ok:false rows for horizons still warming up */
  rows: ExpiryRow[]
  /** the oracle's single recommendation - null when nothing clears the
   * floors ("no edge right now - wait"), the honest default */
  best: { expiry: number; direction: 'call' | 'put'; pWin: number; confidence: number; edge: number } | null
  note: string
  calibrationTotal: { n: number; hitRate: number; brier: number } | null
}

export interface NextExpiryInput {
  asset: string
  mode: 'sim' | 'live'
  /** per-expiry honesty records from the plugin, keyed by String(expiry) -
   * applied via applyCalibrationDiscount (same discount curve as the
   * Next-Candle Oracle) */
  calibrations?: Record<string, { n: number; hitRate: number; brier: number } | null>
  /** learned per-driver weight multipliers from the plugin's honesty loop,
   * keyed by String(expiry) then driver name (1 = unchanged) */
  driverWeightMultipliers?: Record<string, Partial<Record<string, number>>>
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1))
}

function pUpFromScore(score: number): number {
  return clamp(0.5 + 0.5 * clamp(score, -1, 1), 0.01, 0.99)
}

function logistic(x: number): number {
  return clamp(1 / (1 + Math.exp(-clamp(x, -12, 12))), 0.02, 0.98)
}

/** log-odds weighted fusion (same robustness contract as the oracle's) */
function fuseOdds(entries: { pUp: number; weight: number }[]): number {
  const totalW = entries.reduce((a, e) => a + e.weight, 0)
  if (totalW <= 0) return 0.5
  let logit = 0
  for (const e of entries) {
    const p = clamp(e.pUp, 0.02, 0.98)
    logit += (e.weight / totalW) * Math.log(p / (1 - p))
  }
  return clamp(1 / (1 + Math.exp(-logit)), 0.02, 0.98)
}

/** proxy ADX / Hurst - same lightweight shapes the Next-Candle Oracle uses
 * for its regime read (kept local so the two engines can drift independently) */
function trendinessProxy(candles: Candle[]): number {
  const n = Math.min(20, candles.length - 1)
  const seg = candles.slice(-(n + 1))
  const net = Math.abs(seg[seg.length - 1].close - seg[0].close)
  let travel = 0
  for (let i = 1; i < seg.length; i++) travel += Math.abs(seg[i].close - seg[i - 1].close)
  if (travel <= 0) return 0
  return clamp((net / travel) * 60, 0, 60)
}

function hurstProxy(closes: number[]): number {
  const rets: number[] = []
  for (let i = Math.max(1, closes.length - 60); i < closes.length; i++) rets.push(Math.sign(closes[i] - closes[i - 1]))
  if (rets.length < 20) return 0.5
  let same = 0
  for (let i = 1; i < rets.length; i++) if (rets[i] === rets[i - 1]) same++
  const persistence = same / (rets.length - 1)
  return clamp(0.5 + (persistence - 0.5) * 0.5, 0.3, 0.7)
}

/** Variance ratio at horizon E from NON-overlapping E-step log returns -
 * the classic VR(k) test statistic. 1.0 = random walk, >1 = persistent
 * (trending), <1 = mean-reverting at this horizon. Returns null when the
 * window can't supply VR_MIN_SAMPLES independent E-step observations. */
function varianceRatio(closes: number[], E: number): number | null {
  const win = closes.slice(-Math.min(FWD_WINDOW + E, closes.length))
  const stepRets: number[] = []
  for (let i = 1; i < win.length; i++) stepRets.push(Math.log(win[i] / win[i - 1]))
  if (stepRets.length < VR_MIN_SAMPLES * E) return null
  const sampleRets: number[] = []
  for (let i = 0; i + E <= stepRets.length; i += E) {
    let acc = 0
    for (let j = 0; j < E; j++) acc += stepRets[i + j]
    sampleRets.push(acc)
  }
  if (sampleRets.length < VR_MIN_SAMPLES) return null
  const v1 = stdev(stepRets)
  const vE = stdev(sampleRets)
  if (!(v1 > 1e-12) || !(vE > 1e-12)) return null
  return (vE * vE) / (E * v1 * v1)
}

/** AR(1) on log price -> reversion half-life in bars. Returns null when the
 * fit isn't mean-reverting (phi >= 1 or <= 0) - no half-life, no fade read. */
function ouHalfLife(closes: number[], window = 480): { halfLifeBars: number; phi: number; mu: number; z: number } | null {
  const seg = closes.slice(-window)
  if (seg.length < 60) return null
  const logs = seg.map((c) => Math.log(c > 0 ? c : 1e-9))
  const mu = mean(logs)
  const sd = stdev(logs)
  if (!(sd > 1e-12)) return null
  let num = 0
  let den = 0
  for (let i = 1; i < logs.length; i++) {
    const a = logs[i - 1] - mu
    const b = logs[i] - mu
    num += a * b
    den += a * a
  }
  if (!(den > 1e-12)) return null
  const phi = num / den
  if (!(phi > 0.01 && phi < 0.999)) return null
  const halfLifeBars = Math.log(0.5) / Math.log(phi)
  if (!Number.isFinite(halfLifeBars) || halfLifeBars <= 0) return null
  const z = (logs[logs.length - 1] - mu) / sd
  return { halfLifeBars, phi, mu, z }
}

/** current signed run length: consecutive same-sign 1m closes ending at the
 * last closed bar (0 when the last bar was flat) */
function currentRun(candles: Candle[]): number {
  let run = 0
  for (let i = candles.length - 1; i > 0; i--) {
    const d = Math.sign(candles[i].close - candles[i - 1].close)
    if (d === 0) break
    if (run === 0 || Math.sign(run) === d) run += d
    else break
  }
  return run
}

export function predictNextExpiry(candles: Candle[], input: NextExpiryInput): NextExpiryPrediction | null {
  if (candles.length < EXPIRY_ORACLE_MIN_CANDLES) return null
  for (const c of candles.slice(-3)) {
    if (!Number.isFinite(c.close) || !Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low)) return null
  }
  const last = candles[candles.length - 1]
  const prev = candles[candles.length - 2]
  const barSec = Math.max(60, last.time - prev.time || 60)
  if (Math.abs(barSec - 60) > 5) {
    // the engine is 1m-native by design - refuse a different base series
    // rather than silently mis-scaling every horizon
    return null
  }
  const spot = last.close
  const closes = candles.map((c) => c.close)
  const nowSec = Math.floor(Date.now() / 1000)
  const session = classifySession(nowSec, input.asset)
  const targetNow = last.time // last CLOSED bar's open time

  // ---------- shared context ----------
  const atr1m = atr(candles.map((c) => c.high), candles.map((c) => c.low), closes, 14).at(-1) || 0
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]))
  const recent = rets.slice(-300)
  const sigma1 = (() => {
    const e = ewmaVol(recent)
    const g = garchVol(recent).vol
    const s = e > 0 ? e : g > 0 ? g : stdev(recent)
    return s > 1e-12 ? s : 1e-9
  })()

  const adxProxy = trendinessProxy(candles)
  const regime: OracleRegime = classifyRegime({
    indicators: { adx: adxProxy },
    quant: { hurst: hurstProxy(closes), garchVol: garchVol(recent).vol, ewmaVol: ewmaVol(recent) },
  } as unknown as AnalysisResult)

  // regime affinity per expiry: shapes WEIGHTS only, never direction - the
  // direction comes from each expiry's own model panel
  const regimeMult = (E: number): number => {
    if (regime === 'TRENDING') return E >= 5 ? 1.25 : E <= 2 ? 0.85 : 1
    if (regime === 'RANGING') return E <= 3 ? 1.2 : E >= 15 ? 0.75 : 1
    if (regime === 'VOLATILE') return 0.7
    return 1
  }
  const chaosFlatten = regime === 'VOLATILE' ? 0.6 : 1

  // ---------- shared model state (computed once, read per expiry) ----------
  const ou = ouHalfLife(closes)
  const halfLifeMin = ou ? clamp(Math.round(ou.halfLifeBars), 1, 240) : null
  const run = currentRun(candles)

  const rows: ExpiryRow[] = []
  const deadband = regime === 'VOLATILE' ? VOLATILE_DEADBAND : DEADBAND

  for (const E of EXPIRIES_MIN) {
    const drivers: ExpiryDriver[] = []
    const learnKey = String(E)
    const learned = input.driverWeightMultipliers?.[learnKey] ?? {}
    const applyLearned = (name: string, w: number): number => {
      const m = learned[name]
      return Number.isFinite(m) && (m as number) > 0 ? w * clamp(m as number, 0.6, 1.5) : w
    }

    // ----- VR (also the row's predictability backbone) -----
    const vr = varianceRatio(closes, E)
    const vrDev = vr === null ? 0 : clamp(vr - 1, -0.5, 0.5)

    // ----- 1. Markov H-E transitions -----
    // state = sign pattern of the last three 1m closes (8 states); the
    // forward outcome is sign(close[i+E] - close[i]) scanned over the
    // recent window, Laplace-smoothed so an unseen state can't divide by 0
    {
      const stateSig = [Math.sign(closes[closes.length - 1] - closes[closes.length - 2]), Math.sign(closes[closes.length - 2] - closes[closes.length - 3]), Math.sign(closes[closes.length - 3] - closes[closes.length - 4])]
      const stateId = stateSig.reduce((s, d) => s * 3 + (d > 0 ? 2 : d < 0 ? 0 : 1), 0)
      const win = Math.min(FWD_WINDOW, closes.length - E - 1)
      let up = 0
      let down = 0
      // anchor idx needs 4 closed bars of state behind it AND E closed bars
      // of forward outcome ahead of it (idx + E < length)
      for (let i = Math.max(4, E + 1); i <= win; i++) {
        const idx = closes.length - i // scan from oldest eligible anchor
        const s = [Math.sign(closes[idx] - closes[idx - 1]), Math.sign(closes[idx - 1] - closes[idx - 2]), Math.sign(closes[idx - 2] - closes[idx - 3])]
        const id = s.reduce((acc, d) => acc * 3 + (d > 0 ? 2 : d < 0 ? 0 : 1), 0)
        if (id !== stateId) continue
        const fwd = closes[idx + E] - closes[idx]
        if (fwd > 0) up++
        else if (fwd < 0) down++
      }
      const n = up + down
      if (n >= MARKOV_STATE_MIN) {
        const pUp = clamp((up + 1) / (n + 2), 0.02, 0.98)
        const w = applyLearned('Markov H-E', 12 * regimeMult(E) * chaosFlatten)
        drivers.push({
          name: 'Markov H-E',
          pUp,
          weight: w,
          vote: (pUp - 0.5) * 2,
          detail: `${n} same-state ${E}m outcomes: ${(pUp * 100).toFixed(0)}% closed up (state ${stateSig.map((d) => (d > 0 ? 'U' : d < 0 ? 'D' : '=')).join('')})`,
        })
      }
    }

    // ----- 2. Variance-ratio momentum / mean-reversion -----
    // The ONE model that owns the trend-vs-fade call per horizon: momentum
    // continues when VR(E) > 1, stretches snap back when VR(E) < 1, and at
    // VR ~ 1 it abstains (a random-walk horizon deserves no vote).
    if (vr !== null && Math.abs(vrDev) > 0.05) {
      const mRet = closes[closes.length - 1] / closes[closes.length - 1 - E] - 1
      const z = clamp(mRet / (sigma1 * Math.sqrt(E)), -4, 4)
      const trending = vrDev > 0
      const read = trending ? clamp(z * 1.2, -1, 1) : clamp(-z * 1.2, -1, 1)
      const strength = Math.min(Math.abs(vrDev) / 0.4, 1) // 0..1 conviction
      const w = applyLearned(trending ? 'VR momentum' : 'VR fade', (4 + 10 * strength) * regimeMult(E) * chaosFlatten)
      drivers.push({
        name: trending ? 'VR momentum' : 'VR fade',
        pUp: pUpFromScore(read),
        weight: w,
        vote: read,
        detail: `VR(${E}m) ${vr.toFixed(2)} (${trending ? 'trending' : 'mean-reverting'}), ${E}m z ${z >= 0 ? '+' : ''}${z.toFixed(2)} -> ${trending ? 'continue' : 'fade'}`,
      })
    }

    // ----- 3. OU half-life fade -----
    if (ou) {
      // expected fraction of the stretch covered in E bars, from the AR(1):
      // 1 - phi^E; the fade read scales with BOTH the stretch and that
      // coverage, so the same stretch means more at the expiry nearest the
      // pair's own half-life
      const cover = clamp(1 - Math.pow(ou.phi, E), 0, 1)
      const read = clamp(-ou.z * cover * 1.6, -1, 1)
      // Gaussian affinity of E to the pair's own half-life (bars->minutes:
      // the base series IS 1m, so bars == minutes)
      const aff = Math.exp(-((E - ou.halfLifeBars) ** 2) / (2 * Math.max(0.6 * ou.halfLifeBars, 1) ** 2))
      if (Math.abs(read) > 0.04) {
        const w = applyLearned('OU half-life', (3 + 9 * aff) * regimeMult(E) * chaosFlatten)
        drivers.push({
          name: 'OU half-life',
          pUp: pUpFromScore(read),
          weight: w,
          vote: read,
          detail: `stretch z ${ou.z.toFixed(2)}, covers ${(cover * 100).toFixed(0)}% in ${E}m (half-life ${ou.halfLifeBars.toFixed(1)}m, affinity ${(aff * 100).toFixed(0)}%)`,
        })
      }
    }

    // ----- 4. Run-length exhaustion -----
    if (Math.abs(run) >= 2) {
      const win = Math.min(FWD_WINDOW, closes.length - E - 1)
      let up = 0
      let down = 0
      // anchor needs a full |run| behind it and E forward bars ahead of it
      for (let i = Math.max(Math.abs(run) + 1, E + 1); i <= win; i++) {
        const idx = closes.length - i
        // same-sign run of at least |run| ending at idx-1..idx?
        let okRun = true
        for (let j = 1; j <= Math.abs(run); j++) {
          if (Math.sign(closes[idx - j + 1] - closes[idx - j]) !== Math.sign(run)) {
            okRun = false
            break
          }
        }
        if (!okRun) continue
        const fwd = closes[idx + E] - closes[idx]
        if (fwd > 0) up++
        else if (fwd < 0) down++
      }
      const n = up + down
      if (n >= RUN_STATE_MIN) {
        const pUp = clamp((up + 1) / (n + 2), 0.02, 0.98)
        const w = applyLearned('Run exhaustion', 7 * regimeMult(E) * chaosFlatten)
        drivers.push({
          name: 'Run exhaustion',
          pUp,
          weight: w,
          vote: (pUp - 0.5) * 2,
          detail: `after a ${Math.abs(run)}-bar ${run > 0 ? 'up' : 'down'} run, ${E}m later: ${(pUp * 100).toFixed(0)}% up (${n} matches)`,
        })
      }
    }

    // ----- 5. Session drift -----
    {
      const win = Math.min(2160, closes.length - E - 1)
      const vals: number[] = []
      for (let i = E + 1; i <= win; i++) {
        const idx = closes.length - i
        const t = candles[idx]?.time ?? 0
        // candle.time is bar-open SECONDS (tempo.ts x1000 for ms) - exactly
        // what classifySession expects
        if (classifySession(t, input.asset) !== session) continue
        vals.push(Math.log(closes[idx + E] / closes[idx]))
      }
      if (vals.length >= SESSION_MIN) {
        const m = mean(vals)
        const z = clamp(m / (sigma1 * Math.sqrt(E)), -3, 3)
        const w = applyLearned('Session drift', 5 * regimeMult(E) * chaosFlatten)
        drivers.push({
          name: 'Session drift',
          pUp: logistic(z * 1.5),
          weight: w,
          vote: clamp(z * 1.5, -1, 1),
          detail: `${vals.length} ${session}-session ${E}m reads avg ${(m * 1e4).toFixed(1)} bp (z ${z >= 0 ? '+' : ''}${z.toFixed(2)})`,
        })
      }
    }

    // ----- fuse this expiry -----
    const usable = drivers.filter((d) => Number.isFinite(d.pUp) && Number.isFinite(d.weight) && d.weight > 0)
    const cal = input.calibrations?.[learnKey] ?? null
    if (usable.length < MIN_ACTIVE_DRIVERS || vr === null) {
      rows.push({
        expiry: E,
        ok: false,
        note: vr === null ? `warming up - needs ${VR_MIN_SAMPLES}+ independent ${E}m samples` : `warming up - ${usable.length}/${MIN_ACTIVE_DRIVERS} models ready`,
        pUp: 0.5,
        direction: 'none',
        pWin: 0.5,
        confidence: 0,
        rawConfidence: 0,
        edge: 0,
        predictability: 0,
        expectedMove: spot * sigma1 * Math.sqrt(E),
        cone: { low: spot, high: spot },
        drivers: usable,
        driversActive: usable.length,
        calibration: cal,
        targetBarTime: targetNow + E * 60,
      })
      continue
    }

    const pUp = fuseOdds(usable.map((d) => ({ pUp: d.pUp, weight: d.weight })))
    const winSide = pUp >= 0.5 ? 1 : -1
    const totalW = usable.reduce((s, d) => s + d.weight, 0)
    const agreeW = usable.reduce((s, d) => s + (Math.sign(d.vote || (d.pUp - 0.5)) === winSide ? d.weight : 0), 0)
    const agreement = totalW > 0 ? agreeW / totalW : 0.5
    const distance = Math.abs(pUp - 0.5) * 2
    const sampleFactor = clamp(0.75 + 0.25 * (usable.length / drivers.length), 0.75, 1)
    // predictability: how far this horizon's variance ratio sits from the
    // random walk - the honest "is this horizon even forecastable" factor
    const predictability = clamp(Math.abs(vr - 1) / 0.35, 0.15, 1)
    const rawConfidence = clamp((0.55 * agreement + 0.45 * distance) * 100 * sampleFactor * (0.45 + 0.55 * predictability), 0, 97)
    const confidence = applyCalibrationDiscount(rawConfidence, cal)
    const direction: 'call' | 'put' | 'none' = pUp >= 0.5 + deadband ? 'call' : pUp <= 0.5 - deadband ? 'put' : 'none'
    const pWin = Math.max(pUp, 1 - pUp)
    const expectedMove = clamp(spot * sigma1 * Math.sqrt(E * clamp(vr, 0.3, 2.5)), 0.2 * Math.max(atr1m, 1e-9) * Math.sqrt(E), 3 * Math.max(atr1m, 1e-9) * Math.sqrt(E))
    const edge = clamp((pWin - 0.5) * predictability * (confidence / 100), 0, 1)
    rows.push({
      expiry: E,
      ok: true,
      note: '',
      pUp,
      direction,
      pWin,
      confidence,
      rawConfidence,
      edge,
      predictability,
      expectedMove,
      cone: { low: spot - expectedMove * 1.4, high: spot + expectedMove * 1.4 },
      drivers: usable,
      driversActive: usable.length,
      calibration: cal,
      targetBarTime: targetNow + E * 60,
    })
  }

  // ----- best pick: argmax edge among rows clearing BOTH floors -----
  const candidates = rows.filter((r) => r.ok && r.direction !== 'none' && r.pWin >= BEST_MIN_PWIN && r.confidence >= BEST_MIN_CONF)
  candidates.sort((a, b) => b.edge - a.edge)
  const top = candidates[0] ?? null
  const best = top
    ? { expiry: top.expiry, direction: top.direction as 'call' | 'put', pWin: top.pWin, confidence: top.confidence, edge: top.edge }
    : null

  // sanity: every emitted number must be finite - a single NaN would poison
  // the panel; ground rather than emit
  for (const r of rows) {
    if (!Number.isFinite(r.pUp) || !Number.isFinite(r.confidence) || !Number.isFinite(r.expectedMove)) {
      r.ok = false
      r.direction = 'none'
      r.note = 'read grounded - a model produced a non-finite value this bar'
      r.confidence = 0
      r.edge = 0
    }
  }

  const liveRows = rows.filter((r) => r.ok)
  const note = best
    ? `${best.expiry}m ${best.direction} @ ${(best.pWin * 100).toFixed(0)}% pWin - strongest edge across ${liveRows.length}/5 expiries (${regime.toLowerCase()} regime, ${session} session)`
    : liveRows.length === 0
      ? 'no expiry ready yet - all five horizons still warming up'
      : `no edge clearing the floors right now (${regime.toLowerCase()} regime, ${session} session) - wait`

  return {
    asset: input.asset,
    ts: Date.now(),
    mode: input.mode,
    price: spot,
    regime,
    session,
    halfLifeMin,
    rows,
    best,
    note,
    calibrationTotal: null,
  }
}
