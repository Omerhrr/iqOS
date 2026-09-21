// Signal-frequency stability scan across TSK params (synthetic + live-ish data)
import { computeTSK, type TSKParams } from '../mini-services/trading-core/src/analytics/tsk'

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
    out.push({ time: 1789900000 + i * 60, open: o, high: Math.max(o, price) + rnd() * 0.0003, low: Math.min(o, price) - rnd() * 0.0003, close: price, volume: 0 })
  }
  return out
}
const candles = synth(1000)
const combos: Array<Partial<TSKParams>> = [
  {},
  { tlPeriod: 40 }, { tlPeriod: 90 },
  { zEntry: 1.6 }, { zEntry: 2.2 },
  { armWindow: 18 }, { armWindow: 30 },
  { kalmanQ: 0.01 }, { kalmanQ: 0.05 },
  { tlPeriod: 90, zEntry: 2.2 },
]
for (const c of combos) {
  const s = computeTSK(candles, c)
  const up = s.signal.filter((x) => x === 1).length
  const dn = s.signal.filter((x) => x === -1).length
  const bad = s.signal.filter((x, i) => x !== 0 && s.runaway[i]).length
  console.log(`${JSON.stringify(c).padEnd(28)} signals=${up + dn} (+${up}/-${dn}) inRunaway=${bad}`)
}
