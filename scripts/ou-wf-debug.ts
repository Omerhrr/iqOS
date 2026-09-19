// Debug: run the OU walk-forward outside the kernel to see per-fold detail
import { walkForward } from '../mini-services/trading-core/src/strategies/optimize'

// synthetic mean-reverting series with the same shape as market data candles
const N = 2200
const candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = []
let price = 1.1
let seed = 42
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648 - 0.5
}
for (let i = 0; i < N; i++) {
  // strong OU pull toward 1.1 so the strategy should fire
  price = price + 0.35 * (1.1 - price) + rand() * 0.004
  candles.push({ time: 1700000000 + i * 60, open: price, high: price * 1.0005, low: price * 0.9995, close: price, volume: 100 })
}

const out = walkForward(candles, 'SYNTH', '1m', {
  strategy: 'kalman-ou-reversion',
  sweep: {
    window: { from: 180, to: 300, step: 60 },
    zEntry: { from: 1.4, to: 2.4, step: 0.2 },
    maxHalfLife: { from: 30, to: 120, step: 30 },
  },
  objective: 'netPnl',
  minTrades: 5,
  maxCombos: 80,
  folds: 3,
  isRatio: 0.7,
})
console.log('folds:', out.folds.length)
for (const f of out.folds) {
  console.log(`fold ${f.fold}: isBars ${f.isBars} oosBars ${f.oosBars} | IS trades ${f.is.totalTrades} net ${f.is.netPnl.toFixed(1)} | OOS trades ${f.oos.totalTrades} net ${f.oos.netPnl.toFixed(1)} wr ${f.oos.winRate.toFixed(0)}% | best ${JSON.stringify(f.bestParams)}`)
}
console.log('oos aggregate:', out.oos.totalTrades, 'trades, net', out.oos.netPnl.toFixed(1), '| foldsProfitable', out.foldsProfitable, '| efficiency', out.efficiencyPct.toFixed(0) + '%')
