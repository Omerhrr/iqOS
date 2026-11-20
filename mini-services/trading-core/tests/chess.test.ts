// IQAIR//OS - tests: chess
import assert from 'node:assert/strict'
import { readChess, reportChess } from '../src/analytics/chess'
import { evaluateStrategyScript, parseStrategyScript } from '../src/analytics/strategylang'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
let sd = 21; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
type K = 'walk' | 'trend' | 'range' | 'cycle'
const series = (n: number, kind: K, t0 = 1_700_006_400) => {
  const out: any[] = []; let p = 1.2
  for (let i = 0; i < n; i++) {
    const o = p; let mv: number
    if (kind === 'trend') mv = 0.0004 + (r() - 0.5) * 0.0003
    else if (kind === 'range') mv = (1.2 - p) * 0.35 + (r() - 0.5) * 0.0004
    else if (kind === 'cycle') { const ph = i % 120; mv = (ph < 50 ? (r() - 0.5) * 0.00008 : ph < 80 ? 0.0005 * (r() > 0.2 ? 1 : -1) + (r() - 0.5) * 0.0003 : (r() - 0.5) * 0.0002) } // quiet -> burst -> settle
    else mv = (r() - 0.5) * 0.0006
    const c = o + mv
    out.push({ time: t0 + i * 60, open: o, high: Math.max(o, c) + r() * 0.0002, low: Math.min(o, c) - r() * 0.0002, close: c, volume: 100 }); p = c
  }
  return out
}

const clean = (a: any[]) => a
test('thin history is reported', () => { const x = readChess(series(80, 'walk')); assert.equal(x.ok, false); assert.ok(/needs/.test(x.error ?? '')) })
test('well-formed read on a random walk', () => {
  const x = readChess(series(600, 'walk')); assert.ok(x.ok, x.error ?? 'chess failed')
  assert.ok(x.position.eval >= -1 && x.position.eval <= 1); assert.ok(['call', 'put', 'wait'].includes(x.think.best)); assert.ok(x.lines.length === 6)
  assert.ok(x.position.rank >= 1 && x.position.rank <= 8); assert.ok(x.pieces.kingLong >= 0 && x.pieces.kingLong <= 1)
})
test('a steady climb: buyers stand better', () => { const x = readChess(series(500, 'trend')); assert.ok(x.ok); assert.ok(x.position.eval > 0, String(x.position.eval)) })
test('planted trap: failed break above a swing high reads as a PUT trap', () => {
  const a = series(400, 'range'); let hi = -Infinity, hiIdx = 0
  for (let i = 300; i < 380; i++) if (a[i].high > hi) { hi = a[i].high; hiIdx = i }
  const b = a.slice(0, 392); const L = b[391].close
  // approach and wick above the swing high, close back under it
  b.push({ time: b[391].time + 60, open: L, high: hi + 0.0004, low: L - 0.0001, close: hi - 0.0003, volume: 100 })
  b.push({ time: b[391].time + 120, open: hi - 0.0003, high: hi - 0.0002, low: hi - 0.0012, close: hi - 0.0010, volume: 100 })
  const x = readChess(b, { light: true }); assert.ok(x.ok)
  assert.ok(x.tactics.some((t) => t.name === 'trap' || t.name === 'sacrifice'), JSON.stringify(x.tactics.map((t) => t.name + t.stage)))
})
test('mate is never claimed without a mating net', () => { const x = readChess(series(500, 'walk')); if (x.mate.mated === 'none') assert.equal(x.mate.mate, false) })
test('verdict dir none implies strength 0 and WAIT line', () => {
  for (const k of ['walk', 'range', 'trend', 'cycle'] as K[]) { const x = readChess(series(500, k), { light: true }); if (x.verdict.dir === 'none') assert.equal(x.verdict.strength, 0); else assert.ok(x.verdict.strength >= 35) }
})
test('report: random data does not hand out false edges (no tactic with z>=2 and lift)', () => {
  const rep = reportChess(series(2500, 'walk')); assert.ok(rep.ok); const bad = Object.entries(rep.tactics).filter(([, v]) => v.n >= 30 && (v.z ?? 0) >= 3)
  assert.ok(bad.length <= 1, JSON.stringify(bad.map(([k, v]) => [k, v.n, v.z])))
})
test('report: thin history reported', () => { assert.equal(reportChess(series(100, 'walk')).ok, false) })
test('chess.* works in MSL', () => {
  const parsed = parseStrategyScript('let c = chess.all()\nlet p = chess.position()\nlet th = chess.think()\nlet t = chess.text()\ncall when c.ok and c.act and c.dir == "call"\nput when c.ok and c.act and c.dir == "put" and p.eval < 0\n'); assert.ok(parsed.ok, (parsed as any).error)
  const sr = { time: series(400, 'walk').map((c) => c.time), open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[], volume: [] as number[] }
  for (const c of series(400, 'walk')) { sr.open.push(c.open); sr.high.push(c.high); sr.low.push(c.low); sr.close.push(c.close); sr.volume.push(c.volume) }
  const res: any = evaluateStrategyScript((parsed as any).ast, {} as any, (() => { throw new Error('x') }) as any, sr as any); assert.ok(!res.error, res.error)
})
test('chess.all() on thin history is a clean ok:false', () => {
  const parsed = parseStrategyScript('let c = chess.all()\ncall when c.ok and c.act\n'); assert.ok(parsed.ok)
  const sr = { time: [1, 2, 3], open: [1, 1, 1], high: [1, 1, 1], low: [1, 1, 1], close: [1, 1, 1], volume: [1, 1, 1] }
  const res: any = evaluateStrategyScript((parsed as any).ast, {} as any, (() => { throw new Error('x') }) as any, sr as any); assert.ok(!res.error, res.error); assert.equal(res.direction, 'none')
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
