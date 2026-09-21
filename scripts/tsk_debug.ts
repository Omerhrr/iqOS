// Debug: why does TSK gate never pass while VSK fires on the same data?
import { computeTSK, TSK_DEFAULTS } from '../mini-services/trading-core/src/analytics/tsk'
import { computeVSK, VSK_DEFAULTS } from '../mini-services/trading-core/src/analytics/vsk'

interface K { time: number; open: number; high: number; low: number; close: number; volume: number }
function synth(n: number, seed = 42): K[] {
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5 }
  const out: K[] = []
  let price = 1.1
  const anchor = 1.1
  for (let i = 0; i < n; i++) {
    if (i < 700) { price += (anchor - price) * 0.06 + Math.sin(i / 14) * 0.0012 + rnd() * 0.0006 }
    else { price += 0.0015 + rnd() * 0.0004 }
    const o = price - rnd() * 0.0004
    const c = price
    out.push({ time: 1789900000 + i * 60, open: o, high: Math.max(o, c) + rnd() * 0.0003, low: Math.min(o, c) - rnd() * 0.0003, close: c, volume: 0 })
  }
  return out
}
const candles = synth(1000)

function gateStats(name: string, series: { signal: number[]; z: number[]; runaway: boolean[]; sarDir: number[]; slope: number[] }, zEntry: number, armWindow: number) {
  let flips = 0, flipArmed = 0, flipArmedTurn = 0, blocked = 0, sig = 0
  const near: string[] = []
  for (let i = 1; i < series.signal.length; i++) {
    const flipUp = series.sarDir[i] === 1 && series.sarDir[i - 1] === -1
    const flipDn = series.sarDir[i] === -1 && series.sarDir[i - 1] === 1
    if (!flipUp && !flipDn) continue
    flips++
    let armedCall = false, armedPut = false
    const lo = Math.max(0, i - armWindow + 1)
    for (let k = lo; k <= i; k++) {
      if (!Number.isFinite(series.z[k])) continue
      if (series.z[k] <= -zEntry) armedCall = true
      if (series.z[k] >= zEntry) armedPut = true
    }
    const turnUp = series.slope[i] > series.slope[i - 1]
    const turnDn = series.slope[i] < series.slope[i - 1]
    const armed = flipUp ? armedCall : flipDn ? armedPut : false
    const turn = flipUp ? turnUp : turnDn
    if (armed) flipArmed++
    if (armed && turn) flipArmedTurn++
    if (armed && !turn && !series.runaway[i] && near.length < 8) {
      near.push(`bar ${i} ${flipUp ? 'UP' : 'DN'} armed z=${series.z[i].toFixed(2)} slope ${series.slope[i - 1].toFixed(6)}->${series.slope[i].toFixed(6)} turn=${turn}`)
    }
    if (series.runaway[i]) blocked++
    if (series.signal[i] !== 0) sig++
  }
  console.log(`[${name}] flips=${flips} flip+armed=${flipArmed} flip+armed+turn=${flipArmedTurn} flip-in-runaway=${blocked} finalSignals=${sig}`)
  for (const s of near) console.log(`   near-miss: ${s}`)
}

const tsk = computeTSK(candles)
const vsk = computeVSK(candles)
console.log(`TSK z: min=${Math.min(...tsk.z.slice(60).filter(Number.isFinite)).toFixed(2)} max=${Math.max(...tsk.z.slice(60).filter(Number.isFinite)).toFixed(2)} |z|>1.8 bars=${tsk.z.filter((z) => Number.isFinite(z) && Math.abs(z) >= 1.8).length}`)
console.log(`VSK z: min=${Math.min(...vsk.z.slice(60).filter(Number.isFinite)).toFixed(2)} max=${Math.max(...vsk.z.slice(60).filter(Number.isFinite)).toFixed(2)} |z|>1.8 bars=${vsk.z.filter((z) => Number.isFinite(z) && Math.abs(z) >= 1.8).length}`)
gateStats('VSK', vsk, VSK_DEFAULTS.zEntry, VSK_DEFAULTS.armWindow)
gateStats('TSK', tsk, TSK_DEFAULTS.zEntry, TSK_DEFAULTS.armWindow)
