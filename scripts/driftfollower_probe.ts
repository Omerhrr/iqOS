// Isolate drift-follower evaluate behavior on the real harvest archive
import { loadOtcHarvest } from '/home/z/my-project/mini-services/trading-core/src/analytics/otcHarvest'

const candles = loadOtcHarvest('BONKUSD-OTC', 1000)
console.log('bars:', candles.length, 'span_h:', ((candles[candles.length - 1].time - candles[0].time) / 3600).toFixed(2))

// replicate the evaluate z-gate over the fastBacktest loop
let fires = 0
let noneSmallN = 0
let noneGate = 0
let lastZ = NaN
for (let i = 80; i < candles.length - 1; i++) {
  const win = candles.slice(0, i + 1)
  const k = Math.max(10, Math.min(500, win.length - 1))
  const closes = win.slice(-k - 1).map((c) => c.close)
  let up = 0, down = 0
  for (let j = 1; j < closes.length; j++) {
    const d = closes[j] - closes[j - 1]
    if (d > 0) up++
    else if (d < 0) down++
  }
  const n = up + down
  if (n < 10) { noneSmallN++; continue }
  const upShare = up / n
  const z = (upShare - 0.5) / Math.sqrt(0.25 / n)
  lastZ = z
  if (Math.abs(z) >= 2) fires++
  else noneGate++
}
console.log({ fires, noneSmallN, noneGate, lastZ: lastZ.toFixed(2) })

// ALSO: flat-candle share on this feed (d==0 between closes)
let flat = 0
for (let j = 1; j < candles.length; j++) if (candles[j].close === candles[j - 1].close) flat++
console.log('flat close-to-close share:', (flat / (candles.length - 1)).toFixed(3))
