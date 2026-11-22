import assert from 'node:assert/strict'
import { readWeisWave, weisWaveSeries } from '../src/analytics/weiswave'
import type { Candle } from '../src/types'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
// legs: [bars, total move, volume per bar]; each bar's range is ~0.4
const build = (legs: Array<[number, number, number]>, start = 100, flat = false): Candle[] => {
  const out: Candle[] = []; let p = start, t = 1_700_000_000, k = 0
  for (const [n, move, vol] of legs) for (let i = 0; i < n; i++) { const o = p; p += move / n; const wob = (k++ % 5) * 3; out.push({ time: t, open: o, high: Math.max(o, p) + 0.2, low: Math.min(o, p) - 0.2, close: p, volume: flat ? 0 : vol + wob }); t += 60 }
  return out
}
const lead: Array<[number, number, number]> = [[30, 0.5, 100], [10, 4, 100], [10, -4, 100]] // warm-up so ATR/history exist
test('atr mode cuts alternating waves and sums their volume', () => { const c = build([...lead, [10, 4, 200], [10, -4, 120], [10, 4, 200]]); const r = readWeisWave(c, { mode: 'atr', thr: 1 }); assert.ok(r); assert.ok(r.waves.length >= 3); assert.ok(r.waves.every((w, i) => i === 0 || w.dir !== r.waves[i - 1].dir)); assert.ok(r.cur.volume > 0) })
test('close mode makes many more, shorter waves than atr mode', () => { const c = build([...lead, [10, 4, 200], [10, -4, 120]]); const a = readWeisWave(c, { mode: 'atr' }), b = readWeisWave(c, { mode: 'close' }); assert.ok(a && b && b.count <= a.count + 10) })
test('wave volume equals the sum of its bars', () => { const c = build([...lead, [10, 4, 200], [10, -4, 120]]); const r = readWeisWave(c, { mode: 'close' })!; const w = r.waves[r.waves.length - 1]; let s = 0; for (let i = w.startIdx + 1; i <= w.endIdx; i++) s += c[i].volume; assert.equal(Math.round(w.volume), Math.round(s)) })
test('weak up-wave: higher high on LESS volume than the previous up-wave -> put', () => { const c = build([...lead, [10, 6, 300], [8, -3, 100], [10, 4, 90]]); const r = readWeisWave(c, { mode: 'atr', thr: 1 })!; assert.equal(r.cur.dir, 1); assert.equal(r.newExtreme, true); assert.equal(r.weak, true); assert.equal(r.direction, 'put') })
test('weak down-wave: lower low on LESS volume -> call', () => { const c = build([...lead, [10, -6, 300], [8, 3, 100], [10, -4, 90]]); const r = readWeisWave(c, { mode: 'atr', thr: 1 })!; assert.equal(r.cur.dir, -1); assert.equal(r.weak, true); assert.equal(r.direction, 'call') })
test('strong up-wave: higher high on MORE volume -> with it (call)', () => { const c = build([...lead, [10, 4, 100], [8, -2, 60], [10, 5, 400]]); const r = readWeisWave(c, { mode: 'atr', thr: 1 })!; assert.equal(r.strong, true); assert.equal(r.direction, 'call') })
test('absorption: huge volume for a tiny move after normal waves', () => { const c = build([...lead, [10, 5, 100], [8, -3, 100], [10, 5, 100], [8, -3, 100], [8, 1.6, 900]]); const r = readWeisWave(c, { mode: 'atr', thr: 0.6 })!; assert.equal(r.absorption, true) })
test('flat/missing volume: volumeOk false, range stands in, still reads', () => { const c = build([...lead, [10, 4, 0], [10, -4, 0]], 100, true); const r = readWeisWave(c, { mode: 'atr' })!; assert.equal(r.volumeOk, false); assert.ok(r.cur.volume > 0) })
test('too little history -> null', () => { assert.equal(readWeisWave(build([[20, 1, 100]])), null) })
test('chart series: cumulative per wave, signed, restarts on a turn, length matches', () => { const c = build([...lead, [10, 4, 200], [10, -4, 120]]); const r = weisWaveSeries(c, { mode: 'atr' }); assert.equal(r.value.length, c.length); const idx = r.dir.map((d, i) => (d !== 0 ? i : -1)).filter((i) => i >= 0); assert.ok(idx.length > 20); for (const i of idx) assert.equal(Math.sign(r.value[i]), r.dir[i]); let restarts = 0; for (const i of idx) if (i > 0 && r.dir[i - 1] !== r.dir[i] && r.dir[i - 1] !== 0) { restarts++; assert.ok(Math.abs(r.value[i]) < Math.abs(r.value[i - 1])) } assert.ok(restarts >= 2) })
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
