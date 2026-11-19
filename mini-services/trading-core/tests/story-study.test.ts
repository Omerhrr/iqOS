// IQAIR//OS - tests: the story study finds a planted pattern and stays quiet on noise
import assert from 'node:assert/strict'
import { studyStories, labelsAt } from '../src/analytics/storystudy'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
let sd = 21; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
const gen = (n: number, plant: boolean) => {
  const out: any[] = []; let p = 1.3
  for (let i = 0; i < n; i++) {
    const o = p; let d = (r() - 0.5) * 0.002
    const prev = out[out.length - 1]
    // planted: after a candle that closes in the top 10% of its range with a big body (marubozu up) the NEXT candle is up 80% of the time
    if (plant && prev && prev.close > prev.open && (prev.close - prev.open) / Math.max(prev.high - prev.low, 1e-9) >= 0.8 && (prev.close - prev.open) > 0.0008) d = (r() < 0.8 ? 1 : -1) * Math.abs(d)
    p += d
    out.push({ time: 1_700_000_000 + i * 60, open: o, close: p, high: Math.max(o, p) + r() * 0.0001, low: Math.min(o, p) - r() * 0.0001, volume: 1 })
  }
  return out
}
test('labels exist for a candle and include the kind with its direction', () => {
  const c = gen(80, false); const l = labelsAt({ open: c.map((x) => x.open), high: c.map((x) => x.high), low: c.map((x) => x.low), close: c.map((x) => x.close), time: c.map((x) => x.time) })
  assert.ok(l.some((x) => x.startsWith('kind:')), l.join(','))
})
test('too little data says so instead of inventing results', () => { const x = studyStories(gen(100, false)); assert.equal(x.ok, false); assert.ok(/400/.test(x.error ?? '')) })
test('a planted "big up candle -> next candle up" pattern is found as a call survivor out of sample', () => {
  const x = studyStories(gen(2500, true), { horizon: 1, payout: 0.85 }); assert.ok(x.ok, x.error)
  const row = x.rows.find((q) => q.label === 'kind:marubozu+'); assert.ok(row, x.rows.map((q) => q.label).join(',')); assert.equal(row!.side, 'call'); assert.ok(row!.outWin > 0.55 && row!.survivor, JSON.stringify(row))
})
test('pure noise: survivors stay near what luck predicts and reference rate is ~50%', () => {
  const x = studyStories(gen(2500, false)); assert.ok(x.ok); assert.ok(Math.abs(x.baseUp - 0.5) < 0.06)
  assert.ok(x.survivors <= Math.max(3, Math.ceil(x.expectedLucky * 3)), `${x.survivors} survivors, luck expects ~${x.expectedLucky.toFixed(1)} of ${x.labels}`)
})
console.log(`${pass}/${total}`)
