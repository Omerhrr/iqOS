// IQAIR//OS - tests: cp.* / autotrend.* / ew.* MSL namespaces and the new candle detectors
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { parseStrategyScript } from '../src/analytics/strategylang'
import { detectPatterns, CANDLE_PATTERN_NAMES } from '../src/analytics/patterns'
const T0 = 1_700_000_040
const mk = (cl: number[], w = 0.08): Candle[] => cl.map((c, i) => { const o = i ? cl[i - 1] : c; return { time: T0 + i * 60, open: o, close: c, high: Math.max(o, c) + w, low: Math.min(o, c) - w, volume: 1 } })
const lerp = (wp: [number, number][]): number[] => { const o: number[] = []; for (let k = 0; k < wp.length - 1; k++) for (let i = wp[k][0]; i < wp[k + 1][0]; i++) o.push(wp[k][1] + ((wp[k + 1][1] - wp[k][1]) * (i - wp[k][0])) / (wp[k + 1][0] - wp[k][0])); o.push(wp[wp.length - 1][1]); return o }
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const lead = Array.from({ length: 10 }, (_, i) => 104 + Math.sin(i * 1.7) * 0.03)
const FALL = mk([...lead, ...lerp([[0, 104], [5, 110], [15, 105], [25, 108], [35, 103], [45, 106], [55, 101.5], [62, 103.5]])])
const run = (c: Candle[], src: string) => backtestMslScript(c, src, { expiryBars: 1 })
test('parses cp/autotrend/ew scripts', () => {
  parseStrategyScript('call when cp.ok() and cp.has("Falling Wedge")')
  parseStrategyScript('put when autotrend.ok() and autotrend.dir() == -1 and ew.ok()')
})
test('cp.has finds a planted falling wedge', () => {
  const r = run(FALL, 'call when cp.has("Falling Wedge")')
  assert.ok(r.ok, String(r.error)); assert.ok(r.trades.length > 0, 'wedge never found')
  const b = run(FALL, 'call when cp.best() == "Falling Wedge"'); assert.ok(b.ok && b.trades.length > 0)
  const z = run(FALL, 'call when cp.has("Cup and Handle")'); assert.ok(z.ok && z.trades.length === 0)
})
test('ew/autotrend evaluate without error', () => {
  const r = run(FALL, 'call when ew.ok() and autotrend.ok() and cp.count() >= 0 and ew.state() != "x"'); assert.ok(r.ok, String(r.error))
  const u = run(FALL, 'call when cp.has("Falling Wedge", "5m")'); assert.ok(u.ok || /history/.test(u.error ?? ''))
})
test('candle("Falling Wedge") name is registered', () => { assert.ok(CANDLE_PATTERN_NAMES.includes('Falling Wedge')); assert.ok(CANDLE_PATTERN_NAMES.includes('Elliott ABC Top')) })
test('upside tasuki gap detected', () => {
  const c = mk([...Array.from({ length: 70 }, (_, i) => 100 + i * 0.05)]); const b = c[c.length - 1].close
  c.push({ time: T0 + 70 * 60, open: b, close: b + 1.0, high: b + 1.02, low: b - 0.02, volume: 1 })
  c.push({ time: T0 + 71 * 60, open: b + 1.4, close: b + 1.9, high: b + 1.92, low: b + 1.38, volume: 1 })
  c.push({ time: T0 + 72 * 60, open: b + 1.7, close: b + 1.15, high: b + 1.72, low: b + 1.12, volume: 1 })
  const n = detectPatterns(c, 3).map((h) => h.name)
  assert.ok(n.includes('Upside Tasuki Gap') || n.includes('Rising Window'), n.join(','))
})
test('long lower shadow detected', () => {
  const c = mk(Array.from({ length: 70 }, (_, i) => 100 - i * 0.02)); const b = c[c.length - 1].close
  c.push({ time: T0 + 70 * 60, open: b, close: b + 0.05, high: b + 0.07, low: b - 1, volume: 1 })
  assert.ok(detectPatterns(c, 1).some((h) => h.name === 'Long Lower Shadow'))
})
console.log(`${pass}/${total} passed`); if (pass !== total) process.exit(1)
