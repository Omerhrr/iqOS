// Live-data verification that the engine family measures (Task 64-d):
// pulls the same deep candles the kernel's learn() uses, runs the lab's
// exact per-bar measurement for the 14 engine candidates, prints n / wins /
// winRate / edgeLB per candidate. Proves the family mines on real feed data
// even when the top-24 display cut hides it.
import { createHash } from 'node:crypto'
import { buildCtx, prepareSignal } from '../mini-services/trading-core/src/strategies/custom'
import type { SignalStat } from '../mini-services/trading-core/src/plugins/lab'
import type { Candle, Timeframe } from '../mini-services/trading-core/src/types'

const [asset, tfArg] = process.argv.slice(2).length === 2 ? process.argv.slice(2) : ['EURUSD', '1m']
const tf = tfArg as Timeframe

const res = await fetch(`http://localhost:3030/candles?symbol=${asset}&tf=${tf}&limit=1200`)
if (!res.ok) {
  console.error('candles fetch failed:', res.status, await res.text())
  process.exit(1)
}
const raw = (await res.json()) as { ok?: boolean; candles?: Candle[] }
const candles: Candle[] = Array.isArray(raw) ? raw : (raw.candles ?? [])
console.log(`asset=${asset} tf=${tf} bars=${candles.length}`)
if (candles.length < 200) {
  console.error('not enough history to measure')
  process.exit(1)
}

const settle = candles.map((c) => c.close)
const ctx = buildCtx(candles)
const horizon = 1
const warm = 30
const minSamples = Math.max(10, Math.min(40, Math.floor((candles.length - warm - horizon) / 6)))

// Wilson 95% lower bound (same as the lab's wilsonInterval)
function wilsonLower(wins: number, n: number): number {
  const p = wins / n
  const z = 1.96
  const denom = 1 + (z * z) / n
  const center = p + (z * z) / (2 * n)
  const rad = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return (center - rad) / denom
}

let h = parseInt(createHash('md5').update('seedless').digest('hex').slice(0, 8), 16) // keep import used
void h

const ENGINES = ['renko', 'pnf', 'range', 'tick', 'footprint', 'heikin', 'candle'] as const
const rows: SignalStat[] = []
for (const engine of ENGINES) {
  for (const dir of ['call', 'put'] as const) {
    const def = { kind: 'engine', engine, dir, weight: 10 } as const
    const test = prepareSignal(def, ctx)
    let n = 0
    let wins = 0
    for (let i = warm; i < candles.length - horizon; i++) {
      if (!test(i)) continue
      n++
      const up = settle[i + horizon] > settle[i]
      const dn = settle[i + horizon] < settle[i]
      if (dir === 'call' ? up : dn) wins++
    }
    const wr = n ? (wins / n) * 100 : NaN
    rows.push({
      key: `engine:${engine}:${dir}`,
      kind: 'engine',
      label: `${engine} ${dir}`,
      dir,
      n,
      wins,
      winRate: Math.round(wr * 100) / 100,
      edgePts: Math.round((wr - 50) * 100) / 100,
      edgeLB: n >= 10 ? Math.round((wilsonLower(wins, n) * 100 - 50) * 100) / 100 : NaN,
      weight: 0,
      selected: false,
      def,
    })
  }
}
console.log(`minSamples(floored)=${minSamples}\n`)
console.log('engine            dir    n     wins   winRate   edgePts  edgeLB   qualifies')
for (const r of rows) {
  const q = r.n >= minSamples && r.edgeLB >= 2
  console.log(
    r.key.padEnd(22),
    'n=' + String(r.n).padStart(4),
    'w=' + String(r.wins).padStart(4),
    (Number.isFinite(r.winRate) ? r.winRate.toFixed(1) + '%' : '-').padStart(8),
    (Number.isFinite(r.edgePts) ? (r.edgePts > 0 ? '+' : '') + r.edgePts.toFixed(2) : '-').padStart(8),
    (Number.isFinite(r.edgeLB) ? (r.edgeLB > 0 ? '+' : '') + r.edgeLB.toFixed(2) : '-').padStart(8),
    q ? 'YES' : 'no'
  )
}
