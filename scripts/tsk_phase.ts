// Measure phase alignment: distance from z-extreme / z-zero-cross to the SAR flip
import { computeTSK, TSK_DEFAULTS } from '../mini-services/trading-core/src/analytics/tsk'

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
const tsk = computeTSK(candles)
const { z, sarDir, slope } = tsk

console.log('flip bars and their z-phase timeline:')
for (let i = 1; i < sarDir.length; i++) {
  const flipUp = sarDir[i] === 1 && sarDir[i - 1] === -1
  const flipDn = sarDir[i] === -1 && sarDir[i - 1] === 1
  if (!flipUp && !flipDn) continue
  const side = flipUp ? -1 : 1 // armed side: call for flipUp
  // most recent z beyond zEntry on that side
  let lastExtreme = -1
  for (let k = i; k >= Math.max(0, i - 59); k--) {
    if (Number.isFinite(z[k]) && side * z[k] >= TSK_DEFAULTS.zEntry) { lastExtreme = k; break }
  }
  // most recent zero-cross of z in the armed direction (z was opposite-signed, now >= 0 for up)
  let zeroCross = -1
  for (let k = i; k >= Math.max(0, i - 59); k--) {
    if (Number.isFinite(z[k]) && Number.isFinite(z[k - 1]) && side * z[k] >= 0 && side * z[k - 1] < 0) { zeroCross = k; break }
  }
  const extremeDist = lastExtreme >= 0 ? i - lastExtreme : -1
  const crossDist = zeroCross >= 0 ? i - zeroCross : -1
  const turn = slope[i] > slope[i - 1] ? (flipUp ? 'turnOK' : 'turnNO') : (flipUp ? 'turnNO' : 'turnOK')
  console.log(`bar ${i} ${flipUp ? 'FLIP_UP(call)' : 'FLIP_DN(put)'}: zExtreme ${extremeDist >= 0 ? extremeDist + ' bars ago' : '>59'} · zZeroCross ${crossDist >= 0 ? crossDist + ' bars ago' : '>59'} · ${turn} · z@flip=${z[i].toFixed(2)}`)
}
