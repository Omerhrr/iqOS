// IQAIR//OS - Expected Move parameter sweep.  Run:  bun scripts/em-sweep.ts --db data/os.db --asset US2000 --tf 1m --expiry 1
// Tries em.outside() "fade" (bet the stretch reverses) and "follow" (bet it continues) over a grid of window / estimator / hurst / horizon / sigma, on the
// recorded candles in candles_archive, and reports win rate, the Wilson 95% lower bound and the break-even for the payout.
// HONEST METHOD: configs are RANKED ON THE FIRST HALF of the data and judged on the SECOND HALF, which the ranking never saw. With hundreds of configs some
// always look good by luck; the script prints how many "passes" pure chance would produce so you can tell. Gaps in the archive split the data into segments.
import { Database } from 'bun:sqlite'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { wilsonLowerBound } from '../src/analytics/mslai-stats'
import type { Candle } from '../src/types'

const arg = (n: string, d: string): string => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const flag = (n: string): boolean => process.argv.includes('--' + n)
const DB = arg('db', 'data/os.db'), ASSET = arg('asset', 'US2000'), TF = arg('tf', '1m')
const EXPIRY = Math.max(1, Number(arg('expiry', '1'))), PAYOUT = Number(arg('payout', '0.85')), MINSEG = Number(arg('minseg', '120'))
const BREAKEVEN = 1 / (1 + PAYOUT)
const SPACING: Record<string, number> = { '5s': 5, '15s': 15, '30s': 30, '1m': 60, '2m': 120, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 }
const sp = SPACING[TF]; if (!sp) { console.error('unknown --tf ' + TF); process.exit(1) }

const db = new Database(DB, { readonly: true })
const assets: string[] = ASSET === 'ALL' ? (db.query(`select distinct asset from candles_archive where tf=?`).all(TF) as { asset: string }[]).map((r) => r.asset) : [ASSET]
type Seg = { asset: string; candles: Candle[] }
const segs: Seg[] = []
for (const a of assets) {
  const rows = db.query(`select time,open,high,low,close,volume from candles_archive where asset=? and tf=? order by time`).all(a, TF) as Candle[]
  let cur: Candle[] = []
  for (const r of rows) { if (cur.length && r.time - cur[cur.length - 1].time > sp * 1.5) { if (cur.length >= MINSEG) segs.push({ asset: a, candles: cur }); cur = [] } cur.push(r) }
  if (cur.length >= MINSEG) segs.push({ asset: a, candles: cur })
}
const totalBars = segs.reduce((s, x) => s + x.candles.length, 0)
console.log(`${ASSET} ${TF}: ${segs.length} contiguous segment(s) >= ${MINSEG} bars, ${totalBars} bars; expiry ${EXPIRY} bar(s); payout ${PAYOUT} -> break-even ${(BREAKEVEN * 100).toFixed(1)}%`)
if (totalBars < 600) { console.log('Too little data for a meaningful sweep (need roughly 3000+ bars). Nothing to conclude - record more candles first.'); process.exit(0) }

const quick = flag('quick')
const WIN = quick ? [50, 100] : [30, 60, 100, 200], BARS = quick ? [1, 3] : [1, 3, 5], KS = quick ? [1.5, 2] : [1, 1.5, 2], HURST = quick ? [0.5] : [0.4, 0.5, 0.6], MODES = [0, 1, 2, 3]
const MODE_NAME = ['rms', 'std', 'ewma', 'parkinson']
interface Cfg { rule: 'fade' | 'follow'; bars: number; k: number; w: number; h: number; m: number }
const cfgs: Cfg[] = []
for (const rule of ['fade', 'follow'] as const) for (const bars of BARS) for (const k of KS) for (const w of WIN) for (const m of MODES) for (const h of bars === 1 ? [0.5] : HURST) cfgs.push({ rule, bars, k, w, h, m })
const script = (c: Cfg): string => {
  const o = `em.outside(${c.bars}, ${c.k}, ${c.w}, ${c.h}, ${c.m})`
  const up = c.rule === 'fade' ? 'put' : 'call', dn = c.rule === 'fade' ? 'call' : 'put'
  return `${up} when ${o} == 1\n${dn} when ${o} == -1`
}
interface T { time: number; win: boolean }
const run = (c: Cfg): T[] => {
  const out: T[] = []
  const src = script(c)
  for (const s of segs) {
    const r = backtestMslScript(s.candles, src, { expiryBars: EXPIRY, warmupBars: Math.max(60, Math.min(c.w, 100)) })
    if (!r.ok) throw new Error(r.error)
    for (const t of r.trades) out.push({ time: s.candles[t.index]?.time ?? t.time, win: t.win })
  }
  return out.sort((a, b) => a.time - b.time)
}
const stat = (t: T[]) => { const w = t.filter((x) => x.win).length; return { n: t.length, w, wr: t.length ? w / t.length : 0, lb: wilsonLowerBound(w, t.length) } }
const pct = (x: number) => (x * 100).toFixed(1).padStart(5) + '%'

const rows: { c: Cfg; all: ReturnType<typeof stat>; tr: ReturnType<typeof stat>; te: ReturnType<typeof stat> }[] = []
const t0 = Date.now()
for (const c of cfgs) {
  const t = run(c); const h = Math.floor(t.length / 2)
  rows.push({ c, all: stat(t), tr: stat(t.slice(0, h)), te: stat(t.slice(h)) })
}
const MINTR = 30
const ok = rows.filter((r) => r.tr.n >= MINTR && r.te.n >= MINTR)
console.log(`${cfgs.length} configs in ${((Date.now() - t0) / 1000).toFixed(0)}s; ${ok.length} have >= ${MINTR} trades in BOTH halves\n`)
const desc = (c: Cfg) => `${c.rule.padEnd(6)} bars=${c.bars} k=${c.k} win=${String(c.w).padEnd(3)} hurst=${c.h} ${MODE_NAME[c.m].padEnd(9)}`
const top = [...ok].sort((a, b) => b.tr.wr - a.tr.wr).slice(0, 10)
console.log('TOP 10 BY FIRST HALF (train) -> what they did on the SECOND HALF (test, unseen):')
console.log('config                                       | train n   wr   | TEST n   wr    LB95  | vs break-even')
for (const r of top) console.log(`${desc(r.c)} | ${String(r.tr.n).padStart(5)} ${pct(r.tr.wr)} | ${String(r.te.n).padStart(5)} ${pct(r.te.wr)} ${pct(r.te.lb)} | ${r.te.lb > BREAKEVEN ? 'ABOVE (lower bound clears)' : r.te.wr > BREAKEVEN ? 'above on average only' : 'below'}`)
const avgTest = top.reduce((s, r) => s + r.te.wr, 0) / Math.max(1, top.length)
console.log(`\nAverage TEST win rate of the 10 train-best configs: ${pct(avgTest)}  (break-even ${pct(BREAKEVEN)})`)
const pass = ok.filter((r) => r.te.lb > BREAKEVEN)
// under pure chance a config's test lower bound clears break-even only if its win rate lands ~2 sd above 50%+; roughly 2.5% of configs by luck
console.log(`Configs whose TEST lower bound clears break-even: ${pass.length} of ${ok.length}. Pure chance alone would give about ${(ok.length * 0.025).toFixed(1)}.`)
for (const dir of ['fade', 'follow'] as const) { const g = ok.filter((r) => r.c.rule === dir); console.log(`  ${dir}: mean test win rate over ${g.length} configs = ${pct(g.reduce((s, r) => s + r.te.wr, 0) / Math.max(1, g.length))}`) }
for (const [name, key] of [['estimator', 'm'], ['window', 'w'], ['bars', 'bars']] as const) {
  const vals = [...new Set(ok.map((r) => r.c[key as 'm']))].sort((a, b) => a - b)
  console.log(`  by ${name}: ` + vals.map((v) => { const g = ok.filter((r) => r.c[key as 'm'] === v); return `${key === 'm' ? MODE_NAME[v] : v}=${pct(g.reduce((s, r) => s + r.te.wr, 0) / g.length).trim()}` }).join('  '))
}
console.log(pass.length > ok.length * 0.05 && avgTest > BREAKEVEN ? '\nVERDICT: some signal beyond chance - validate the best config on a different asset/period before trusting it.' : '\nVERDICT: nothing here beats chance after out-of-sample testing. Do not trade these settings.')
const outFile = arg('out', '')
if (outFile) { await Bun.write(outFile, JSON.stringify(rows, null, 1)); console.log('full results written to ' + outFile) }
