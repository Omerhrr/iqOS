// IQAIR//OS - tests: the Alchemist builtin strategies as seeded in plugins/metastrategy.ts, and cross-timeframe support in the pure-candle backtester
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'

const T0 = 1_700_000_000
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
function walk(n: number, seed: number, step = 60): Candle[] {
  const r = rng(seed), out: Candle[] = []
  let x = 100
  for (let i = 0; i < n; i++) { const o = x; x += (r() - 0.5) * 0.5; out.push({ time: T0 + i * step, open: o, high: Math.max(o, x) + r() * 0.08, low: Math.min(o, x) - r() * 0.08, close: x, volume: 100 }) }
  return out
}
function builtinScript(id: string): string {
  const src = readFileSync(join(__dirname, '../src/plugins/metastrategy.ts'), 'utf8')
  const at = src.indexOf(`id: '${id}'`)
  assert.ok(at > 0, `${id} is not seeded`)
  const open = src.indexOf('script: `', at) + 'script: `'.length
  return src.slice(open, src.indexOf('`', open))
}
const FULL = `if msnr.ok() and crt.ok() and signal.ok() and fib.ok(30)
  if msnr.rejected() == 1 and crt.dir() == 1 and signal.smcLean() == 1 and fib.dir(30) == 1 and fib.pos(30) >= 0.62 and fib.pos(30) <= 0.79
    call when true
  elseif msnr.rejected() == 1 and crt.dir() == 1 and (signal.smcLean() == 1 or (fib.dir(30) == 1 and fib.pos(30) >= 0.62 and fib.pos(30) <= 0.79))
    call when true
  elseif msnr.rejected() == -1 and crt.dir() == -1 and signal.smcLean() == -1 and fib.dir(30) == -1 and fib.pos(30) >= 0.62 and fib.pos(30) <= 0.79
    put when true
  elseif msnr.rejected() == -1 and crt.dir() == -1 and (signal.smcLean() == -1 or (fib.dir(30) == -1 and fib.pos(30) >= 0.62 and fib.pos(30) <= 0.79))
    put when true
  end
end`
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }

test('both Alchemist builtins parse', () => {
  for (const id of ['meta:builtin-alchemist', 'meta:builtin-alchemist-htf']) { const p = parseStrategyScript(builtinScript(id)); assert.ok(p.ok, id + (p.ok ? '' : p.error)) }
})
test('builtin Alchemist fires on the same bars as the written-out script, with confidence 72 or 85', () => {
  const c = walk(2600, 8)
  const a = backtestMslScript(c, builtinScript('meta:builtin-alchemist'), { expiryBars: 1, warmupBars: 100, runId: 'b1' })
  const b = backtestMslScript(c, FULL, { expiryBars: 1, warmupBars: 100, runId: 'b2' })
  assert.equal(a.trades.length, b.trades.length)
  assert.deepEqual(a.trades.map((t) => [t.time, t.direction]), b.trades.map((t) => [t.time, t.direction]))
  for (const t of a.trades) assert.ok(t.confidence === 72 || t.confidence === 85, `confidence ${t.confidence}`)
})
test('backtester answers a higher-timeframe argument by aggregating, completed bars only', () => {
  const c = walk(400, 3)
  const res = backtestMslScript(c, 'if ind.rsi(14, "5m")[-1] > 0 and ohlc(-1, "5m").c > 0\n  call when true\nend', { expiryBars: 1, warmupBars: 120, runId: 'x1' })
  assert.ok(res.trades.length > 100, `HTF read evaluated on ${res.trades.length} bars`)
  // look-ahead guard: pick a bar in the MIDDLE of a 5m bucket; the visible 5m bar must be the last COMPLETED bucket, never the partial one
  let i = 200
  while (Math.floor(c[i].time / 300) === Math.floor((c[i].time + 60) / 300)) i++ // bar i is not the last bar of its bucket... find one that IS mid-bucket
  i = [...Array(60).keys()].map((k) => 150 + k).find((k) => Math.floor(c[k].time / 300) === Math.floor((c[k].time + 60) / 300) && Math.floor(c[k - 1].time / 300) === Math.floor(c[k].time / 300))!
  const cur = Math.floor(c[i].time / 300) * 300
  let exp = NaN
  for (let k = i; k >= 0; k--) { if (Math.floor(c[k].time / 300) * 300 < cur) { exp = c[k].close; break } }
  assert.ok(Number.isFinite(exp) && exp !== c[i].close)
  const one = backtestMslScript(c.slice(0, i + 2), `if ohlc(-1, "5m").c == ${exp}\n  call when true\nend`, { expiryBars: 1, warmupBars: i, runId: 'x3' })
  assert.equal(one.trades.length, 1, 'the visible 5m bar is the last completed bucket')
  const leak = backtestMslScript(c.slice(0, i + 2), `if ohlc(-1, "5m").c == ${c[i].close}\n  call when true\nend`, { expiryBars: 1, warmupBars: i, runId: 'x4' })
  assert.equal(leak.trades.length, 0, 'the partial bucket is never visible')
})
test('a timeframe that does not divide the candle spacing still fails closed (no trades, no crash)', () => {
  const res = backtestMslScript(walk(300, 4, 60), 'if ohlc(-1, "90s").c > 0\n  call when true\nend', { expiryBars: 1, warmupBars: 100, runId: 'x2' })
  assert.equal(res.trades.length, 0)
})
console.log(pass === total ? `all ${pass} passed` : `${total - pass} FAILED`)
if (pass !== total) process.exit(1)
