// Validation for the Kalman + OU engine: parameter recovery, signal behavior,
// JSON safety, and smoke tests through engine/strategy/registry paths.
import { ouEstimate, ouState, ouSeries, ouKalman } from '../mini-services/trading-core/src/analytics/kalman'
import { analyze, scanSnapshot } from '../mini-services/trading-core/src/analytics/engine'
import { STRATEGIES, defaultParams } from '../mini-services/trading-core/src/strategies/builtin'
import { computeIndicator } from '../mini-services/trading-core/src/analytics/registry'
import type { Candle } from '../mini-services/trading-core/src/types'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`)
}

// deterministic PRNG
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 1) simulate a TRUE OU process: dX = kappa(theta - X)dt + sigma dW, dt = 1 bar
// discretization: X_{t+1} = theta + phi*(X_t - theta) + sigma*sqrt(dt)*N(0,1) * approx
const THETA = 1.1
const KAPPA = 0.05 // half-life ~13.9 bars
const SIGMA = 0.004
const PHI = Math.exp(-KAPPA)
const rand = mulberry32(42)
const gauss = () => {
  const u = Math.max(rand(), 1e-9)
  const v = Math.max(rand(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
const ouSim: number[] = [THETA]
for (let i = 1; i < 1200; i++) {
  ouSim.push(THETA + PHI * (ouSim[i - 1] - THETA) + SIGMA * gauss())
}
const sigmaEqTrue = SIGMA / Math.sqrt(2 * KAPPA)

const est = ouEstimate(ouSim, 500)
check('theta recovered (±10%)', Math.abs(est.theta - THETA) / THETA < 0.1, `est=${est.theta.toFixed(4)} true=${THETA}`)
check('kappa recovered (±40%)', Math.abs(est.kappa - KAPPA) / KAPPA < 0.4, `est=${est.kappa.toFixed(4)} true=${KAPPA}`)
check('half-life in plausible band', est.halfLifeBars > 8 && est.halfLifeBars < 25, `est=${est.halfLifeBars.toFixed(1)} (true ≈ ${(Math.log(2) / KAPPA).toFixed(1)})`)
check('sigmaEq same order of magnitude', est.sigmaEq > sigmaEqTrue * 0.6 && est.sigmaEq < sigmaEqTrue * 1.6, `est=${est.sigmaEq.toFixed(5)} true=${sigmaEqTrue.toFixed(5)}`)
check('reversion significant (t ≥ 1.5)', est.tStat >= 1.5, `t=${est.tStat.toFixed(2)}`)

// 2) stretched below equilibrium -> CALL
const stretchedDown = [...ouSim.slice(-500).map((v) => v), THETA - 2.5 * sigmaEqTrue]
const liveDown = ouState(stretchedDown, 500)
check('stretch below -> CALL signal', liveDown.signal === 'call', `z=${liveDown.z.toFixed(2)} state=${liveDown.state}`)
const stretchedUp = [...ouSim.slice(-500).map((v) => v), THETA + 2.5 * sigmaEqTrue]
const liveUp = ouState(stretchedUp, 500)
check('stretch above -> PUT signal', liveUp.signal === 'put', `z=${liveUp.z.toFixed(2)} state=${liveUp.state}`)

// 3) random walk should NOT be flagged mean-reverting
const rw: number[] = [1.1]
for (let i = 1; i < 1200; i++) rw.push(rw[i - 1] * (1 + 0.0002 * gauss()))
const rwEst = ouState(rw, 500)
check('random walk not mean-reverting', !rwEst.meanReverting, `t=${rwEst.tStat.toFixed(2)} HL=${rwEst.halfLifeBars}`)

// 4) JSON safety: no NaN/Infinity anywhere in a full result
const candles: Candle[] = ouSim.map((v, i) => ({
  time: 1700000000 + i * 60,
  open: v,
  high: v * 1.0005,
  low: v * 0.9995,
  close: v,
  volume: 100,
}))
const full = ouKalman(candles, 240)
const json = JSON.stringify(full)
check('ouKalman JSON-safe (no NaN/Infinity)', !json.includes('NaN') && !json.includes('Infinity'))
check('zSeries length capped at 240', full.zSeries.length === 240, `len=${full.zSeries.length}`)
check('zSeries finite after warmup', full.zSeries.slice(-50).every((v) => v !== null && Number.isFinite(v)))

const s = ouSeries(candles, 240)
check('series warmup is NaN then finite', !Number.isFinite(s.filtered[10]) && Number.isFinite(s.filtered[300]))
check('bands bracket theta', s.upper[300] > s.theta[300] && s.lower[300] < s.theta[300])

// 5) engine integration: analyze() includes kalman; factor present in signal
const analysis = analyze(candles, 'EURUSD', '1m')
check('analysis.kalman present', !!analysis.kalman && Number.isFinite(analysis.kalman.z))
const ouFactor = analysis.signal.factors.find((f) => f.name === 'Kalman/OU Stretch')
check('composite signal carries OU factor', !!ouFactor, ouFactor?.note ?? '')
const scan = scanSnapshot(candles, 'EURUSD', '1m')
check('scanSnapshot runs (screener path)', Number.isFinite(scan.score))

// 6) strategy path
const strat = STRATEGIES.find((st) => st.id === 'kalman-ou-reversion')!
check('strategy registered', !!strat)
const ev = strat.evaluate(candles, defaultParams(strat))
check('strategy evaluates with finite score', Number.isFinite(ev.score), `${ev.direction} ${ev.score.toFixed(0)} — ${ev.notes}`)

// 7) registry paths
const bands = computeIndicator('kalman-ou', candles.slice(-400))
check('registry kalman-ou computes 4 lines', !!bands && bands.output.lines.length === 4)
const zInd = computeIndicator('kalman-ou-z', candles.slice(-400))
check('registry kalman-ou-z computes with levels', !!zInd && !!zInd.output.levels && zInd.output.levels.includes(-2))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
