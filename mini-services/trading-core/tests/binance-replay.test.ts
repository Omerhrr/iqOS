// replay tester for strategies that read Binance volume / delta: planted edge is found, a random market is not, no look-ahead, honest verdicts
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArrayMinuteSource, buildReplayCandles, judge, normInv, replayModeOf, runReplay, wilson } from '../src/analytics/binancereplay'
import type { BinanceMinute } from '../src/analytics/binancedata'
import { BUILTIN_TV_SPECS } from '../src/plugins/builtinTvSpecs'
import { loadRecorded } from '../src/plugins/binancefeed'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const T0 = Math.floor(1_700_000_000 / 3600) * 3600
const SYM = 'BTCUSDT'
const spec = (id: string) => BUILTIN_TV_SPECS.find((s) => s.id === id)!.script
let seed = 12345
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647

/** `n` minutes; when `planted`, bar i's delta points the way bar i+1 moves (85% of the time) */
function market(n: number, planted: boolean): { minutes: BinanceMinute[]; iq: Map<number, { open: number; high: number; low: number; close: number }> } {
  seed = 12345
  const dirs: number[] = Array.from({ length: n + 1 }, () => (rnd() < 0.5 ? 1 : -1))
  const minutes: BinanceMinute[] = []
  const iq = new Map<number, { open: number; high: number; low: number; close: number }>()
  let px = 100000
  for (let i = 0; i < n; i++) {
    const d = dirs[i], open = px, close = px + d * 5
    px = close
    const vol = 10 + rnd() * 20
    const signalDir = planted ? (rnd() < 0.85 ? dirs[i + 1] : -dirs[i + 1]) : (rnd() < 0.5 ? 1 : -1)
    const buy = vol * (0.5 + 0.35 * signalDir)           // deltaPct = 0.7 * signalDir
    minutes.push({ time: T0 + i * 60, open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close, volume: vol, quoteVolume: 0, trades: 20, takerBuy: buy, foot: [{ price: Math.round(close / 10) * 10, buy, sell: vol - buy }], footComplete: true })
    iq.set(T0 + i * 60, { open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close })
  }
  return { minutes, iq }
}
const srcOf = (m: BinanceMinute[]) => { const s = new ArrayMinuteSource(); s.set(SYM, m); return s }
const DELTA = spec('meta:builtin-binance-delta')
const run = (src: ArrayMinuteSource, iq: Map<number, any>, inputs: Record<string, any>, tried = 4, mode: 'volume' | 'binance' = 'binance', script = DELTA, expiryBars = 1) =>
  runReplay({ script, inputs, mode, tf: '1m', symbol: SYM, src, iq, expiryBars, payout: 0.85, tried })

test('statistics: wilson and the normal quantile', () => {
  assert.ok(Math.abs(normInv(0.975) - 1.95996) < 1e-3)
  const w = wilson(60, 100); assert.ok(w.lo > 0.5 && w.hi < 0.7 && w.lo < 0.6 && w.hi > 0.6)
})
test('a planted delta edge is found: follow wins ~85%, fade loses, verdict candidate / negative', () => {
  const { minutes, iq } = market(3000, true)
  const s = srcOf(minutes)
  const f = run(s, iq, { mode: 'follow' }), x = run(s, iq, { mode: 'fade' })
  assert.equal(f.ok, true, f.error); assert.ok(f.stats!.trades > 200, String(f.stats!.trades))
  assert.ok(f.stats!.winRate! > 0.75, String(f.stats!.winRate))
  assert.equal(f.stats!.verdict, 'candidate'); assert.equal(x.stats!.verdict, 'negative')
})
test('a market with no relationship is NOT called a candidate, whichever way it is traded', () => {
  const { minutes, iq } = market(3000, false)
  const s = srcOf(minutes)
  for (const m of ['follow', 'fade']) for (const ex of [1, 3]) {
    const r = run(s, iq, { mode: m }, 4, 'binance', DELTA, ex)
    assert.equal(r.ok, true, r.error); assert.notEqual(r.stats!.verdict, 'candidate', `${m}/${ex}: ${r.stats!.note}`)
  }
})
test('a verdict gets stricter with more variants tried', () => {
  const { minutes, iq } = market(3000, true)
  const s = srcOf(minutes)
  const a = run(s, iq, { mode: 'follow' }, 1).stats!, b = run(s, iq, { mode: 'follow' }, 500).stats!
  assert.ok(b.adjLo! < a.adjLo!, `${b.adjLo} !< ${a.adjLo}`)
})
test('no look-ahead: trades on the first part are identical whether or not later minutes exist', () => {
  const { minutes, iq } = market(3000, true)
  const short = run(srcOf(minutes.slice(0, 1800)), iq, { mode: 'follow' }), long = run(srcOf(minutes), iq, { mode: 'follow' })
  const cut = T0 + 1700 * 60
  const a = short.result!.trades.filter((t) => t.time < cut).map((t) => [t.time, t.direction, t.win])
  const b = long.result!.trades.filter((t) => t.time < cut).map((t) => [t.time, t.direction, t.win])
  assert.ok(a.length > 50); assert.deepEqual(a, b)
})
test('volume mode needs the recorded IQ candle of every minute; with none it says so, with all it uses IQ price', () => {
  const { minutes, iq } = market(600, true)
  const none = run(srcOf(minutes), new Map(), { mode: 'follow' }, 1, 'volume')
  assert.equal(none.ok, false); assert.match(String(none.error), /IQ candle/)
  const some = new Map([...iq].map(([k, v]) => [k, { ...v, close: v.close + 0 }]))
  const full = run(srcOf(minutes), some, { mode: 'follow' }, 1, 'volume')
  assert.equal(full.ok, true, full.error)
})
test('buildReplayCandles drops bars with a missing minute on either side', () => {
  const { minutes, iq } = market(20, true)
  const holey = minutes.filter((m) => m.time !== T0 + 2 * 60)
  const c = buildReplayCandles('binance', 300, srcOf(holey), SYM, iq)
  assert.equal(c.find((x) => x.time === T0), undefined)         // the 5m bar that contained the missing minute is gone
  const iq2 = new Map(iq); iq2.delete(T0 + 10 * 60)
  assert.equal(buildReplayCandles('volume', 300, srcOf(minutes), SYM, iq2).find((x) => x.time === T0 + 600), undefined)
})
test('a strategy that reads the forming bar cannot be replayed: it errors, it does not guess', () => {
  const { minutes, iq } = market(800, true)
  const r = run(srcOf(minutes), iq, { mode: 'follow' }, 1, 'binance', spec('meta:builtin-binance-intrabar'))
  assert.equal(r.ok, false); assert.match(String(r.error), /only exists live/i)
})
test('replayModeOf follows the dataSource input', () => {
  assert.equal(replayModeOf(DELTA), 'volume'); assert.equal(replayModeOf(DELTA, { dataSource: 'binance' }), 'binance'); assert.equal(replayModeOf(DELTA, { dataSource: 'iq' }), 'iq')
})
test('judge: too few trades and no trades are labelled as such', () => {
  const mk = (n: number) => ({ ok: true, barsEvaluated: 0, trades: Array.from({ length: n }, (_, i) => ({ index: i, time: i, direction: 'call' as const, confidence: 60, entry: 1, exit: 2, win: true })), wins: n, losses: 0, winRate: 1, avgConfidence: 60, unavailableSources: [] })
  assert.equal(judge(mk(0), 0.85, 1).verdict, 'no-trades'); assert.equal(judge(mk(10), 0.85, 1).verdict, 'too-few')
})
test('loadRecorded merges minute files, IQ patch lines and survives a torn line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bnrec-')); mkdirSync(dir, { recursive: true })
  const L = (o: unknown) => JSON.stringify(o)
  writeFileSync(join(dir, '2026-01-01.jsonl'), [
    L({ s: SYM, t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 3, q: 0, n: 1, tb: 1, f: [[1, 2, 1]], fc: 1, iq: [1, 2, 0.5, 1.4] }),
    L({ s: SYM, t: T0 + 60, o: 1, h: 2, l: 0.5, c: 1.5, v: 3, q: 0, n: 1, tb: 1 }),
    L({ s: SYM, t: T0 + 60, iqOnly: 1, iq: [1, 2, 0.5, 1.6] }),
    '{"s":"BTCUSDT","t":',
  ].join('\n'))
  writeFileSync(join(dir, 'now-2026-01-01.jsonl'), L({ s: SYM, ts: 1, m: T0 }) + '\n')
  const d = loadRecorded(dir)
  assert.equal(d.minutes.get(SYM)!.length, 2); assert.equal(d.coverage[SYM].ladder, 1); assert.equal(d.coverage[SYM].iq, 2)
  assert.equal(d.iq.get(SYM)!.get(T0 + 60)!.close, 1.6); assert.equal(d.files.length, 1)
})
console.log(`${pass}/${total}`)
process.exit(pass === total ? 0 : 1)
