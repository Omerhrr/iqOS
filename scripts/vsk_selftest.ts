// Quick verification harness for the VSK Synthesis algorithm.
// Run: bun scripts/vsk_selftest.ts   (from mini-services/trading-core)
import { computeVSK, vskEvaluate, vskMonteCarlo, VSK_DEFAULTS } from '../mini-services/trading-core/src/analytics/vsk'

interface K { time: number; open: number; high: number; low: number; close: number; volume: number }

// Synthetic candle generator: mean-reverting OU-like sine + noise (should ARM
// + TRIGGER often), plus a runaway trend segment (L2 must block there).
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
    out.push({ time: 1789900000 + i * 60, open: o, high: hi, low: lo, close: c, volume: i % 7 === 0 ? 0 : 100 + rnd() * 50 })
  }
  return out
}

const candles = synth(1000)
console.log(`candles: ${candles.length}`)

const t0 = performance.now()
const vsk = computeVSK(candles)
const dt = performance.now() - t0
console.log(`computeVSK: ${dt.toFixed(1)}ms, series length ${vsk.signal.length}`)

const n = vsk.signal.length
const finiteCount = (a: (number | boolean)[]) => a.filter((x) => typeof x === 'number' ? Number.isFinite(x) : true).length
console.log(`z finite: ${finiteCount(vsk.z)}/${n}`)
console.log(`vwap[100..104]: ${vsk.vwap.slice(100, 105).map((v) => v.toFixed(5)).join(', ')}`)
console.log(`kalman[100..104]: ${vsk.kalman.slice(100, 105).map((v) => v.toFixed(5)).join(', ')}`)
console.log(`sar flips: ${vsk.sarDir.filter((d, i) => i > 0 && d !== vsk.sarDir[i - 1] && d !== 0).length}`)
console.log(`signals: +1=${vsk.signal.filter((s) => s === 1).length} -1=${vsk.signal.filter((s) => s === -1).length}`)
console.log(`runaway bars: ${vsk.runaway.filter(Boolean).length} (expect concentrated in the trend segment 700+)`)
const runIdx = vsk.runaway.map((r, i) => (r ? i : -1)).filter((i) => i >= 0)
if (runIdx.length) console.log(`runaway range: ${runIdx[0]}..${runIdx[runIdx.length - 1]}`)
// signals must NOT appear in the runaway segment
const badSignals = vsk.signal.filter((s, i) => s !== 0 && vsk.runaway[i]).length
console.log(`signals inside runaway regime: ${badSignals} (must be 0)`)

// evaluate must explain state
for (const slice of [candles.slice(0, 400), candles.slice(0, 800), candles]) {
  const ev = vskEvaluate(slice, VSK_DEFAULTS)
  console.log(`evaluate@${slice.length}: ${ev.direction} (${ev.score}) - ${ev.notes}`)
}

// backtest-style timing: 1500 evaluations over 1400-bar slices (worst case)
const t1 = performance.now()
for (let i = 300; i < 1000; i += 2) vskEvaluate(candles.slice(0, i))
console.log(`350 evaluate calls: ${(performance.now() - t1).toFixed(0)}ms`)

// Monte Carlo on a plausible trade list: 55% win, payout 0.85, stake 10
const pnls: number[] = []
let s2 = 7
const rnd2 = () => {
  s2 = (s2 * 1103515245 + 12345) % 2147483648
  return s2 / 2147483648
}
for (let i = 0; i < 120; i++) pnls.push(rnd2() < 0.55 ? 8.5 : -10)
const mc = vskMonteCarlo(pnls, { sims: 5000, startEquity: 1000, seed: 7 })
console.log(`--- MC ---`)
console.log(`perTrade: winRate=${mc.perTrade.winRate.toFixed(3)} mean=${mc.perTrade.mean.toFixed(3)} tStat=${mc.perTrade.tStat.toFixed(2)}`)
console.log(`finalEquity p5=${mc.finalEquity.p5.toFixed(0)} median=${mc.finalEquity.median.toFixed(0)} p95=${mc.finalEquity.p95.toFixed(0)}`)
console.log(`probProfit=${mc.probProfit.toFixed(3)} probRuin=${mc.probRuin.toFixed(4)}`)
console.log(`maxDD mean=${mc.maxDD.mean.toFixed(3)} worst=${mc.maxDD.worst.toFixed(3)}`)
console.log(`fan steps=${mc.fan.step.length} last p5=${mc.fan.p5.at(-1)?.toFixed(0)} p50=${mc.fan.p50.at(-1)?.toFixed(0)} p95=${mc.fan.p95.at(-1)?.toFixed(0)}`)
// determinism
const mc2 = vskMonteCarlo(pnls, { sims: 5000, startEquity: 1000, seed: 7 })
console.log(`deterministic seed: ${mc.finalEquity.median === mc2.finalEquity.median ? 'OK' : 'FAIL'}`)
