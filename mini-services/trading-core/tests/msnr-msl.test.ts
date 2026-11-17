// IQAIR//OS - tests: msnr.* and crt.* (analytics/msnr.ts) and the Alchemist script
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { readMsnr, readCrt } from '../src/analytics/msnr'

const T0 = 1_700_000_000
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
const bar = (i: number, o: number, c: number, hi?: number, lo?: number): Candle => ({ time: T0 + i * 60, open: o, close: c, high: hi ?? Math.max(o, c) + 0.02, low: lo ?? Math.min(o, c) - 0.02, volume: 100 })
/** flat noise around 100 */
function base(n: number, seed: number): Candle[] {
  const r = rng(seed), out: Candle[] = []
  let x = 100
  for (let i = 0; i < n; i++) { const o = x; x += (r() - 0.5) * 0.3 - (x - 100) * 0.05; out.push(bar(i, o, x)) }
  return out
}
export const ALCHEMIST = `if msnr.ok() and crt.ok() and signal.ok() and fib.ok(30)
  if msnr.rejected() == 1 and crt.dir() == 1 and signal.smcLean() == 1 and fib.dir(30) == 1 and fib.pos(30) >= 0.62 and fib.pos(30) <= 0.79
    call when true
    confidence = 85
  elseif msnr.rejected() == 1 and crt.dir() == 1 and (signal.smcLean() == 1 or (fib.dir(30) == 1 and fib.pos(30) >= 0.62 and fib.pos(30) <= 0.79))
    call when true
    confidence = 72
  elseif msnr.rejected() == -1 and crt.dir() == -1 and signal.smcLean() == -1 and fib.dir(30) == -1 and fib.pos(30) >= 0.62 and fib.pos(30) <= 0.79
    put when true
    confidence = 85
  elseif msnr.rejected() == -1 and crt.dir() == -1 and (signal.smcLean() == -1 or (fib.dir(30) == -1 and fib.pos(30) >= 0.62 and fib.pos(30) <= 0.79))
    put when true
    confidence = 72
  end
end`
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }

test('scripts parse (incl. the full Alchemist)', () => {
  assert.equal(parseStrategyScript(ALCHEMIST).ok, true)
  assert.equal(parseStrategyScript('if msnr.ok() and msnr.virgin() and crt.bullish() and crt.strong()\n  call when true\nend').ok, true)
  assert.equal(parseStrategyScript('if crt.ok() and crt.dir(3) == -1\n  put when true\nend').ok, true)
})
test('MSNR: a closing-price valley is a fresh V level and a wick-only test is a bullish rejection', () => {
  const c = base(60, 1)
  // valley: closes fall to 98.0 then recover
  const v: number[] = [100, 99.4, 98.8, 98.4, 98.0, 98.5, 99.0, 99.5, 100, 100.2, 100.1, 100.3]
  let x = c[c.length - 1].close
  for (let i = 0; i < v.length; i++) { c.push(bar(c.length, x, v[i])); x = v[i] }
  // latest bar: wick down into 98.0 then close back at 99.6 (a close never went to 98.0 again)
  c.push(bar(c.length, 100.2, 99.6, 100.25, 97.99))
  const r = readMsnr(c)
  assert.equal(r.ok, true)
  assert.equal(r.rejected, 1, `rejected ${r.rejected}`)
  assert.ok(Math.abs(r.rejLevel - 98.0) < 1e-9, `level ${r.rejLevel}`)
})
test('MSNR: a level that a later bar CLOSED beyond is no longer fresh (no bullish rejection of it)', () => {
  const c = base(60, 2)
  const v: number[] = [100, 99.4, 98.8, 98.4, 98.0, 98.5, 99.0, 99.5, 100, 99, 97.9, 99.2, 100, 100.2]
  let x = c[c.length - 1].close
  for (let i = 0; i < v.length; i++) { c.push(bar(c.length, x, v[i])); x = v[i] }
  c.push(bar(c.length, 100.2, 99.6, 100.25, 97.99))
  const r = readMsnr(c)
  assert.notEqual(r.rejected === 1 && Math.abs(r.rejLevel - 98.0) < 1e-9, true)
})
test('MSNR mirror: a closing peak wick-test is a bearish rejection', () => {
  const c = base(60, 3)
  const v: number[] = [100, 100.6, 101.2, 101.6, 102.0, 101.5, 101.0, 100.5, 100, 99.8, 99.9, 99.7]
  let x = c[c.length - 1].close
  for (let i = 0; i < v.length; i++) { c.push(bar(c.length, x, v[i])); x = v[i] }
  c.push(bar(c.length, 99.8, 100.4, 102.01, 99.75))
  const r = readMsnr(c)
  assert.equal(r.rejected, -1); assert.ok(Math.abs(r.rejLevel - 102.0) < 1e-9)
})
test('CRT: sweep of candle 1 low that closes back inside is bullish, high is bearish, both is none', () => {
  const c = base(40, 4)
  const p = c[c.length - 1]
  const bull = [...c, bar(40, p.close, p.close + 0.1, p.close + 0.15, p.close - 0.1)]
  const c1 = bull[bull.length - 2]
  bull[bull.length - 1] = bar(40, c1.close, c1.low + 0.12, c1.high - 0.01, c1.low - 0.3)
  assert.equal(readCrt(bull).dir, 1)
  const bear = [...c]; const q = bear[bear.length - 1]
  bear.push(bar(40, q.close, q.high - 0.12, q.high + 0.3, q.low + 0.01))
  assert.equal(readCrt(bear).dir, -1)
  const both = [...c]; const w = both[both.length - 1]
  both.push(bar(40, w.close, w.close, w.high + 0.3, w.low - 0.3))
  assert.equal(readCrt(both).dir, 0)
})
test('null market: the full Alchemist script rarely fires and wins about half', () => {
  const r = rng(11), c: Candle[] = []
  let x = 100
  for (let i = 0; i < 3000; i++) { const o = x; x += (r() - 0.5) * 0.4; c.push({ time: T0 + i * 60, open: o, high: Math.max(o, x) + r() * 0.06, low: Math.min(o, x) - r() * 0.06, close: x, volume: 100 }) }
  const res = backtestMslScript(c, ALCHEMIST, { expiryBars: 3, warmupBars: 120, runId: 'alc' })
  const n = res.trades.length, w = res.trades.filter((t) => t.win).length
  if (n >= 30) assert.ok(Math.abs(w / n - 0.5) < 0.15, `wr ${w}/${n}`)
  assert.ok(n < 0.1 * 2800, `fires ${n}`)
})
console.log(pass === total ? `all ${pass} passed` : `${total - pass} FAILED`)
if (pass !== total) process.exit(1)
