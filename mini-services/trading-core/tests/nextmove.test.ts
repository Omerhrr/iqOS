// IQAIR//OS - tests: next move (nm)
import assert from 'node:assert/strict'
import { readNextMove, combineNmPm } from '../src/analytics/nextmove'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
let sd = 3; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
// planted: price pushed to the PREVIOUS DAY HIGH is rejected (falls) 80% of the time; elsewhere a random walk. 1m bars over 12 days.
let nearFlags: boolean[] = []
const make = (days = 12, plant = true) => {
  nearFlags = []
  const out: any[] = []; let p = 1.2, t = 1_700_006_400 - (1_700_006_400 % 86400)
  let prevHigh = NaN, dayHigh = -Infinity, curDay = Math.floor(t / 86400)
  for (let i = 0; i < days * 1440; i++, t += 60) {
    const d = Math.floor(t / 86400); if (d !== curDay) { prevHigh = dayHigh; dayHigh = -Infinity; curDay = d }
    let mv = (r() - 0.5) * 0.0006; let nr = false
    if (plant && Number.isFinite(prevHigh)) { const dist = prevHigh - p; if (dist < 0.0004 && dist > -0.0002) { nr = true; mv = r() < 0.8 ? -(0.0003 + r() * 0.0003) : 0.0003 + r() * 0.0003; } else if (dist > 0.002) mv += 0.00004 } // drifts up toward yesterday's high, then rejects
    const o = p, c = o + mv, h = Math.max(o, c) + r() * 0.0002, l = Math.min(o, c) - r() * 0.0002
    nearFlags.push(nr); out.push({ time: t, open: o, high: h, low: l, close: c, volume: 100 }); p = c; dayHigh = Math.max(dayHigh, h)
  }
  return out
}
test('thin history is reported, not guessed', () => { const x = readNextMove(make(1).slice(0, 80)); assert.equal(x.ok, false); assert.ok(/needs/.test(x.error ?? '')) })
test('reads the day map: previous day levels, range position, session, gap', () => {
  const d = make(6); const x = readNextMove(d.slice(0, 4 * 1440 + 700), { horizon: 5 })
  assert.ok(x.map.clock); assert.ok(Number.isFinite(x.map.prevHigh) && x.map.prevHigh > x.map.prevLow)
  assert.ok(x.map.rangePos >= 0 && x.map.rangePos <= 1); assert.ok(['asia', 'london', 'ny', 'off'].includes(x.map.session))
  assert.ok(x.map.dayHigh >= x.map.dayLow); assert.ok(x.map.lastSession !== 'none')
})
test('pure: the read at bar k depends only on bars up to k', () => {
  const d = make(5); const k = 3 * 1440 + 500
  const a = readNextMove(d.slice(0, k + 1)), b = readNextMove([...d.slice(0, k + 1), ...d.slice(k + 1, k + 200).map((x: any) => ({ ...x, close: x.close + 1, high: x.high + 1 }))].slice(0, k + 1))
  assert.equal(a.nm.prob, b.nm.prob); assert.equal(a.reach.pUpFirst, b.reach.pUpFirst)
})
test('reach probabilities are sane (sum <= 1, within 0..1) and levels sit on the right sides', () => {
  const d = make(6); for (const k of [3 * 1440 + 100, 4 * 1440 + 900, 5 * 1440 + 300]) {
    const x = readNextMove(d.slice(0, k)); if (!x.ok) continue
    assert.ok(x.reach.pUpFirst >= 0 && x.reach.pDownFirst >= 0 && x.reach.pUpFirst + x.reach.pDownFirst <= 1.0001)
    if (Number.isFinite(x.reach.upLevel)) assert.ok(x.reach.upLevel > x.nm.price); if (Number.isFinite(x.reach.downLevel)) assert.ok(x.reach.downLevel < x.nm.price)
  }
})
test('finds a planted level behaviour: at yesterday\'s high it calls PUT and is right far more often than chance', () => {
  const d = make(16), near = nearFlags.slice(); let n = 0, put = 0, hit = 0
  for (let k = 4 * 1440; k < d.length - 2; k += 2) { if (!near[k + 1]) continue; const x = readNextMove(d.slice(0, k + 1), { horizon: 3, track: 30 }); if (!x.ok || x.nm.dir === 'none') continue; n++; if (x.nm.dir === 'put') put++; if ((x.nm.dir === 'call') === (d[k + 1].close > d[k].close)) hit++ }
  assert.ok(n > 40, 'few calls ' + n); assert.ok(put / n > 0.7, `put share ${(put / n).toFixed(2)}`); assert.ok(hit / n > 0.62, `hit ${(hit / n).toFixed(3)} of ${n}`)
})
test('ledger counts day-level touches', () => { const x = readNextMove(make(8).slice(0, 7 * 1440)); assert.ok(x.ledger.dayHighN > 0, String(x.ledger.dayHighN)) })
test('OTC mode needs a stricter walk-forward bar', () => { const d = make(6); const o = readNextMove(d.slice(0, 5 * 1440), { otc: true, track: 30 }); if (o.validation.trackN < 30) assert.equal(o.validation.validated, false) })
test('combineNmPm: agree -> aligned, opposite -> conflict, one side -> only', () => {
  const d = make(6); const x = readNextMove(d.slice(0, 5 * 1440)); const fake = (s: number) => ({ pm: { sign: s, prob: 0.5 + s * 0.1, confidence: 60 } })
  const forced = { ...x, ok: true, nm: { ...x.nm, sign: 1, dir: 'call' as const, prob: 0.6, confidence: 60 } }
  assert.equal(combineNmPm(forced, fake(1)).alignment, 'aligned'); assert.equal(combineNmPm(forced, fake(-1)).alignment, 'conflict')
  assert.equal(combineNmPm(forced, null).alignment, 'nm-only'); assert.equal(combineNmPm({ ...forced, nm: { ...forced.nm, sign: 0 } }, fake(1)).alignment, 'pm-only')
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
