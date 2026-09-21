// Quick verification harness for the TSK Synthesis algorithm (volume-free).
// Run: bun scripts/tsk_selftest.ts   (from mini-services/trading-core)
import { computeTSK, tskEvaluate, tskMonteCarlo, TSK_DEFAULTS } from '../mini-services/trading-core/src/analytics/tsk'

interface K { time: number; open: number; high: number; low: number; close: number; volume: number }

// Synthetic candle generator: mean-reverting OU-like sine + noise (should ARM
// + TRIGGER often), plus a runaway trend segment (L2 must block there).
// VOLUME IS 0 EVERYWHERE - TSK must not care.
function synth(n: number, seed = 42): K[] {
  let s = seed
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648 - 0.5
  }
  const out: K[] = []
  let price = 1.1
  const anchor = 1.1
  for (let i = 0; i < n; i++) {
    if (i < 700) {
      // mean reversion around anchor with visible swings
      const pull = (anchor - price) * 0.06
      const wave = Math.sin(i / 14) * 0.0012
      price += pull + wave + rnd() * 0.0006
    } else {
      // runaway trend: +0.0015/bar for 300 bars
      price += 0.0015 + rnd() * 0.0004
    }
    const o = price - rnd() * 0.0004
    const c = price
    const hi = Math.max(o, c) + rnd() * 0.0003
    const lo = Math.min(o, c) - rnd() * 0.0003
    out.push({ time: 1789900000 + i * 60, open: o, high: hi, low: lo, close: c, volume: 0 })
  }
  return out
}

const candles = synth(1000)
console.log(`candles: ${candles.length} (volume all 0)`)

const t0 = performance.now()
const tsk = computeTSK(candles)
const dt = performance.now() - t0
console.log(`computeTSK: ${dt.toFixed(1)}ms, series length ${tsk.signal.length}`)

// ── correctness: naive O(w) least squares vs the O(1) rolling engine ──
const w = TSK_DEFAULTS.tlPeriod
let tlOk = 0
let tlChecked = 0
let maxRelErr = 0
for (const i of [w, w + 37, 500, 777, 999]) {
  const win = candles.slice(i - w + 1, i + 1).map((c) => c.close)
  let sx = 0, sy = 0, sxy = 0, sxx = 0
  for (let r = 0; r < w; r++) {
    sx += r; sy += win[r]; sxy += r * win[r]; sxx += r * r
  }
  const den = w * sxx - sx * sx
  const b = (w * sxy - sx * sy) / den
  const a = (sy - b * sx) / w
  const tlNaive = a + b * (w - 1)
  let rss = 0
  for (let r = 0; r < w; r++) {
    const res = win[r] - (a + b * r)
    rss += res * res
  }
  const sigNaive = Math.sqrt(rss / w)
  const zNaive = (candles[i].close - tlNaive) / sigNaive
  tlChecked += 3
  const errs = [
    Math.abs(tlNaive - tsk.trendline[i]) / Math.abs(tlNaive),
    Math.abs(sigNaive - tsk.sigma[i]) / Math.abs(sigNaive),
    Math.abs(zNaive - tsk.z[i]) / Math.max(1e-12, Math.abs(zNaive)),
  ]
  maxRelErr = Math.max(maxRelErr, ...errs)
  if (errs.every((e) => e < 1e-6)) tlOk += 3
}
console.log(`trendline math vs naive LSQ: ${tlOk}/${tlChecked} match, max rel err ${maxRelErr.toExponential(2)} (must be all match)`)

const n = tsk.signal.length
const finiteCount = (a: (number | boolean)[]) => a.filter((x) => typeof x === 'number' ? Number.isFinite(x) : true).length
console.log(`z finite: ${finiteCount(tsk.z)}/${n}`)
console.log(`trendline[100..104]: ${tsk.trendline.slice(100, 105).map((v) => v.toFixed(5)).join(', ')}`)
console.log(`kalman[100..104]: ${tsk.kalman.slice(100, 105).map((v) => v.toFixed(5)).join(', ')}`)
console.log(`sar flips: ${tsk.sarDir.filter((d, i) => i > 0 && d !== tsk.sarDir[i - 1] && d !== 0).length}`)
console.log(`signals: +1=${tsk.signal.filter((s) => s === 1).length} -1=${tsk.signal.filter((s) => s === -1).length}`)
console.log(`runaway bars: ${tsk.runaway.filter(Boolean).length} (expect concentrated in the trend segment 700+)`)
const runIdx = tsk.runaway.map((r, i) => (r ? i : -1)).filter((i) => i >= 0)
if (runIdx.length) console.log(`runaway range: ${runIdx[0]}..${runIdx[runIdx.length - 1]}`)
// signals must NOT appear in the runaway segment
const badSignals = tsk.signal.filter((s, i) => s !== 0 && tsk.runaway[i]).length
console.log(`signals inside runaway regime: ${badSignals} (must be 0)`)

// evaluate must explain state
for (const slice of [candles.slice(0, 400), candles.slice(0, 800), candles]) {
  const ev = tskEvaluate(slice, TSK_DEFAULTS)
  console.log(`evaluate@${slice.length}: ${ev.direction} (${ev.score}) - ${ev.notes}`)
}

// backtest-style timing: 350 evaluations over growing slices (worst case)
const t1 = performance.now()
for (let i = 300; i < 1000; i += 2) tskEvaluate(candles.slice(0, i))
console.log(`350 evaluate calls: ${(performance.now() - t1).toFixed(0)}ms`)

// Monte Carlo on a plausible trade list: 55% win, payout 0.85, stake 10
const pnls: number[] = []
let s2 = 7
const rnd2 = () => {
  s2 = (s2 * 1103515245 + 12345) % 2147483648
  return s2 / 2147483648
}
for (let i = 0; i < 120; i++) pnls.push(rnd2() < 0.55 ? 8.5 : -10)
const mc = tskMonteCarlo(pnls, { sims: 5000, startEquity: 1000, seed: 7 })
console.log(`--- MC ---`)
console.log(`perTrade: winRate=${mc.perTrade.winRate.toFixed(3)} mean=${mc.perTrade.mean.toFixed(3)} tStat=${mc.perTrade.tStat.toFixed(2)}`)
console.log(`finalEquity p5=${mc.finalEquity.p5.toFixed(0)} median=${mc.finalEquity.median.toFixed(0)} p95=${mc.finalEquity.p95.toFixed(0)}`)
console.log(`probProfit=${mc.probProfit.toFixed(3)} probRuin=${mc.probRuin.toFixed(4)}`)
console.log(`maxDD mean=${mc.maxDD.mean.toFixed(3)} worst=${mc.maxDD.worst.toFixed(3)}`)
// determinism
const mc2 = tskMonteCarlo(pnls, { sims: 5000, startEquity: 1000, seed: 7 })
console.log(`deterministic seed: ${mc.finalEquity.median === mc2.finalEquity.median ? 'OK' : 'FAIL'}`)
