// IQAIR//OS - archive backfill (test utility, NOT part of the kernel)
// Seeds the candle archive with synthetic bars so deep-history features
// (research depth, boot hydration, gap-fill) can be verified without waiting
// days of runtime. Usage:
//   bun scripts/archive-backfill.ts [asset] [tf] [count] [basePrice] [vol]
import { Database } from 'bun:sqlite'
import { join } from 'path'

const asset = (process.argv[2] ?? 'EURUSD').toUpperCase()
const tf = process.argv[3] ?? '5s'
const count = Math.max(1, Number(process.argv[4] ?? 2400))
const basePrice = Number(process.argv[5] ?? 1.0855)
const vol = Number(process.argv[6] ?? 0.000045)

const TF_SEC: Record<string, number> = {
  '5s': 5, '15s': 15, '30s': 30, '1m': 60, '2m': 120, '5m': 300,
  '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400,
}
const tfSec = TF_SEC[tf]
if (!tfSec) throw new Error(`bad tf ${tf}`)

const dbPath = process.env.IQAIR_OS_DB ?? join(process.cwd(), 'mini-services', 'trading-core', 'data', 'os.db')
const db = new Database(dbPath)
db.run('PRAGMA journal_mode = WAL;')

const now = Math.floor(Date.now() / 1000)
const t0 = now - (now % tfSec) - count * tfSec
const sigma = vol * Math.sqrt(tfSec)

interface Row { asset: string; tf: string; time: number; open: number; high: number; low: number; close: number; volume: number }
const rows: Row[] = []
let price = basePrice
for (let i = 0; i < count; i++) {
  const open = price
  const ret = (Math.random() + Math.random() + Math.random() + Math.random() - 2) * sigma * 0.87
  const close = open * Math.exp(ret)
  const wick = Math.abs(ret) * 1.8 + sigma * 0.6
  rows.push({
    asset, tf, time: t0 + i * tfSec, open,
    high: Math.max(open, close) * (1 + wick * Math.random() * 0.55),
    low: Math.min(open, close) * (1 - wick * Math.random() * 0.55),
    close, volume: Math.round(500 + Math.random() * 2500),
  })
  price = close
}
// rescale so the backfill ends at basePrice (continuity with the live feed)
const scale = basePrice / price
for (const r of rows) {
  r.open *= scale
  r.high *= scale
  r.low *= scale
  r.close *= scale
}

const stmt = db.prepare(
  'INSERT INTO candles_archive (asset, tf, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(asset, tf, time) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume'
)
const tx = db.transaction((batch: Row[]) => {
  for (const r of batch) stmt.run(r.asset, r.tf, r.time, r.open, r.high, r.low, r.close, r.volume)
})
for (let i = 0; i < rows.length; i += 500) tx(rows.slice(i, i + 500))
const n = (db.query('SELECT COUNT(*) n FROM candles_archive WHERE asset = ? AND tf = ?').get(asset, tf) as { n: number }).n
console.log(`backfilled ${count} bars -> ${asset} ${tf} (key now holds ${n} rows)`)
