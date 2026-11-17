// IQAIR//OS - tests: MSL language core (var/assign/for/while/fn/arrays/draw)
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { parseStrategyScript, evaluateStrategyScript, clearMslState, type MslSeriesCtx } from '../src/analytics/strategylang'
import { backtestMslScript } from '../src/analytics/mslbacktest'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const mk = (n: number): MslSeriesCtx => { const close = Array.from({ length: n }, (_, i) => 100 + i), time = Array.from({ length: n }, (_, i) => 1_700_000_000 + i * 60); return { open: close.map(c => c - 0.2), high: close.map(c => c + 1), low: close.map(c => c - 1), close, volume: close.map(() => 1), time } }
const ser = mk(60)
const run = (src: string, state?: { keyPrefix: string; barTimeSec: number }) => { const p = parseStrategyScript(src); assert.ok(p.ok, (p as any).error); return evaluateStrategyScript((p as any).ast, {}, undefined, ser, undefined, undefined, state) }
test('for loop sums, step and break/continue work', () => {
  assert.equal(run('var t = 0\nfor i = 1 to 10\n  t += i\nend\ncall when t == 55').direction, 'call')
  assert.equal(run('let t = 0\nfor i = 10 to 1 step -3\n  t += i\nend\ncall when t == 22').direction, 'call') // 10+7+4+1
  assert.equal(run('let t = 0\nfor i = 1 to 100\n  if i > 5\n    break\n  end\n  if i == 2\n    continue\n  end\n  t += i\nend\ncall when t == 13').direction, 'call') // 1+3+4+5
})
test('while loop + step budget stops an endless loop', () => {
  assert.equal(run('let n = 0\nwhile n < 7\n  n += 1\nend\ncall when n == 7').direction, 'call')
  const r = run('let n = 0\nwhile true\n  n += 1\nend\ncall when n > 0'); assert.ok(r.error && /10000|steps/.test(r.error), r.error)
})
test('arrays: literal, push, index, len, sum, setidx, negative index, methods', () => {
  assert.equal(run('let a = [3, 1, 2]\na.push(10)\na[0] = 4\ncall when len(a) == 4 and a[-1] == 10 and a.sum() == 17 and a.max() == 10 and a.sort()[0] == 1').direction, 'call')
  assert.ok(run('let a = [1]\ncall when a[5] > 0').error)
})
test('series.toArray lets a loop walk history: count bars where close rose', () => {
  assert.equal(run('let c = px.close.toArray(10)\nlet up = 0\nfor i = 1 to len(c) - 1\n  if c[i] > c[i - 1]\n    up += 1\n  end\nend\ncall when up == 9').direction, 'call')
})
test('user fn: params, return, recursion cap, hoisting, array arg is copied', () => {
  assert.equal(run('call when sq(3) + hyp(3, 4) == 14\nfn sq(x)\n  return x * x\nend\nfn hyp(a, b)\n  return sqrt(sq(a) + sq(b))\nend').direction, 'call')
  assert.equal(run('fn fact(n)\n  if n <= 1\n    return 1\n  end\n  return n * fact(n - 1)\nend\ncall when fact(5) == 120').direction, 'call')
  assert.ok(run('fn f(n)\n  return f(n + 1)\nend\ncall when f(0) > 0').error)
  assert.ok(run('let g = [1]\nfn bad(a)\n  g.push(2)\n  return 1\nend\ncall when bad(g) == 1').error, 'fn must not mutate outer arrays')
  assert.equal(run('let g = [1]\nfn ok(a)\n  a.push(2)\n  return a.len()\nend\nlet n = ok(g)\ncall when n == 2 and len(g) == 1').direction, 'call')
})
test('fn used in an EXPRESSION still cannot change outer state or fire signals', () => {
  assert.ok(run('let z = 1\nfn f()\n  z = 2\n  return 1\nend\nlet y = f()\ncall when y == 1').error)
  assert.ok(run('fn f()\n  call when true\n  return 1\nend\nlet y = f()\ncall when false').error)
  assert.ok(run('let g = [1]\nfn bad(a)\n  g.push(2)\n  return 1\nend\nlet y = bad(g)\ncall when y == 1').error)
  assert.ok(!parseStrategyScript('break\ncall when true').ok)
})
test('fn called as a STATEMENT can fire signals, use var, change outer variables and arrays', () => {
  assert.equal(run('fn go()\n  call when true\nend\ngo()').direction, 'call')
  assert.equal(run('let z = 1\nlet g = [1]\nfn bump(arr, k)\n  z += k\n  arr.push(z)\nend\nbump(g, 4)\nbump(g, 1)\ncall when z == 6 and len(g) == 3 and g[-1] == 6').direction, 'call')
  const src = 'fn count()\n  var n = 0\n  n += 1\nend\ncount()\ncall when n >= 2'
  const K = { keyPrefix: 'lang-fnvar', barTimeSec: 1000 }
  assert.equal(run(src, K).direction, 'none'); assert.equal(run(src, { ...K, barTimeSec: 1060 }).direction, 'call'); clearMslState('lang-fnvar')
  assert.equal(run('fn setpos(x)\n  pos.stop = x\nend\nsetpos(95)\ncall when true').entry?.stop, 95)
})
test('maps: literal, fields, index by text, assignment, methods, nesting, errors', () => {
  assert.equal(run('let m = { a: 1, "b c": 2, d: [1, 2, 3] }\nm.a += 4\nm["e"] = 9\ncall when m.a == 5 and m["b c"] == 2 and m.d[2] == 3 and m.e == 9 and len(m) == 4 and m.has("e") and not m.has("zz") and m.get("zz", 7) == 7').direction, 'call')
  assert.equal(run('let m = { x: 1 }\nlet c = m.copy()\nc.x = 5\nlet ks = m.keys()\ncall when m.x == 1 and c.x == 5 and ks[0] == "x" and m.values()[0] == 1').direction, 'call')
  assert.ok(run('let m = { x: 1 }\ncall when m.nope > 0').error); assert.ok(run('let m = { x: 1 }\nlet y = m + 1\ncall when true').error)
  assert.ok(!parseStrategyScript('let m = { a: 1, a: 2 }\ncall when true').ok)
  assert.equal(run('let m = {\n  a: 1,\n  b: 2\n}\ncall when m.a + m.b == 3').direction, 'call')
})
test('a map as a struct: fn returns a record; records in an array; persistent map', () => {
  assert.equal(run('fn level(p, t)\n  return { price: p, touches: t }\nend\nlet ls = [level(100, 2), level(105, 5)]\nlet best = ls[0]\nfor i = 1 to len(ls) - 1\n  if ls[i].touches > best.touches\n    best = ls[i]\n  end\nend\ncall when best.price == 105').direction, 'call')
  const src = 'var st = { n: 0, seen: [] }\nst.n += 1\nst.seen.push(st.n)\ncall when st.n == 3 and len(st.seen) == 3'
  const K = { keyPrefix: 'lang-map', barTimeSec: 1 }
  run(src, K); run(src, { ...K, barTimeSec: 2 }); assert.equal(run(src, { ...K, barTimeSec: 3 }).direction, 'call'); clearMslState('lang-map')
})
test('arrays hold series, bars, bundles and maps; persistent vars still refuse them', () => {
  assert.equal(run('let a = [px.close, px.high]\nlet b = [ohlc(-1)]\nlet m = { s: px.low, b: ind.macd(12, 26, 9) }\ncall when a[0][-1] == 159 and a[1][-1] == 160 and b[0].c == 159 and m.s[-1] == 158 and len(m) == 2').direction, 'call')
  assert.ok(run('var keep = [px.close]\ncall when true', { keyPrefix: 'lang-pv', barTimeSec: 1 }).error); clearMslState('lang-pv')
})
test('i-1 is subtraction now; hyphenated source ids with a colon still tokenize', () => {
  assert.equal(run('let i = 5\ncall when i-1 == 4 and i-2 == 3').direction, 'call')
  assert.ok(parseStrategyScript('call when foo:bar-baz.dir == call').ok)
  const cfg = parseStrategyScript('configure strategy.calibrated-edge.window = 230\ncall when true'); assert.ok(cfg.ok, (cfg as any).error)
})
test('var persists bar to bar, same-bar re-evaluation does not double count, new key starts fresh', () => {
  const src = 'var n = 0\nn += 1\ncall when n >= 3'
  const K = { keyPrefix: 'lang-test-1', barTimeSec: 1000 }
  assert.equal(run(src, K).direction, 'none')              // n=1
  assert.equal(run(src, { ...K, barTimeSec: 1060 }).direction, 'none') // n=2
  assert.equal(run(src, { ...K, barTimeSec: 1060 }).direction, 'none') // same bar again: still n=2, not 3
  assert.equal(run(src, { ...K, barTimeSec: 1120 }).direction, 'call')  // n=3
  assert.equal(run(src, { keyPrefix: 'lang-test-2', barTimeSec: 1000 }).direction, 'none')
  clearMslState('lang-test-1'); clearMslState('lang-test-2')
  assert.equal(run(src, K).direction, 'none')
  clearMslState('lang-test-1')
})
test('persistent array + entry-level memory in a backtest ("remember the level where I entered")', () => {
  const c: Candle[] = Array.from({ length: 300 }, (_, i) => { const p = 100 + Math.sin(i / 8) * 4; return { time: 1_700_000_040 + i * 60, open: p - 0.1, close: p, high: p + 0.4, low: p - 0.4, volume: 1 } })
  const src = 'var lvl = 0\nvar hits = []\nif lvl == 0 and px.close[-1] > px.close[-2] and px.close[-2] < px.close[-3]\n  lvl = px.close[-1]\n  hits.push(lvl)\nend\nif lvl > 0 and px.close[-1] < lvl - 1\n  lvl = 0\nend\ncall when lvl > 0 and len(hits) >= 1 and px.close[-1] > lvl'
  const r = backtestMslScript(c, src, { expiryBars: 3 }); assert.ok(r.ok, r.error); assert.ok(r.trades.length >= 3, `${r.trades.length}`)
})
test('draw.* collects deduplicated overlays; NaN draws nothing; bad method errors', () => {
  const r = run('draw.line(sw.low(1), 20, sw.low(2), 5, "#ff0000", "TL")\ndraw.hline(px.close[-1], "orange", "px")\ndraw.hline(px.close[-1], "orange", "px")\ndraw.zone(110, 105, 30)\ndraw.label(120, 3, "hi")\ndraw.marker(2, "up")\ndraw.hline(sw.high(99))\ncall when true')
  assert.ok(!r.error, r.error); const d = r.draws!
  assert.equal(d.filter(x => x.kind === 'hline').length, 1); assert.equal(d.length, 4) // sw.* NaN line + NaN hline dropped
  assert.ok(d.find(x => x.kind === 'zone')!.t1! > 0)
  assert.ok(run('draw.nope(1)\ncall when true').error)
})
test('operators: % and compound assign', () => { assert.equal(run('let x = 17\nx %= 5\ncall when 17 % 5 == 2').direction, 'call') })
test('errors carry their line number; a script that fails on every bar is reported, not a clean zero', () => {
  const r = run('let a = 1\nlet b = [1, 2]\ncall when b[9] > 0'); assert.ok(r.error && /^line 3:/.test(r.error), r.error)
  const r2 = run('let m = { x: 1 }\nfor i = 1 to 3\n  m.zz += 1\nend\ncall when true'); assert.ok(r2.error && /line 3:/.test(r2.error), r2.error)
  const c: Candle[] = Array.from({ length: 200 }, (_, i) => ({ time: 1_700_000_040 + i * 60, open: 100, close: 100 + (i % 3), high: 102, low: 98, volume: 1 }))
  const bt = backtestMslScript(c, 'let a = [1]\ncall when a[5] > 0', { expiryBars: 3 }); assert.equal(bt.ok, false); assert.ok(/failed on every bar/.test(bt.error ?? '') && /line 2/.test(bt.error ?? ''), bt.error)
  const part = backtestMslScript(c, 'let k = px.close[-1]\nlet a = [1]\ncall when px.close[-1] > 99 and if(px.close[-1] == 100, a[5], 1) > 0', { expiryBars: 3 }); assert.ok(part.ok && part.scriptErrors && part.scriptErrors.count > 0 && part.scriptErrors.count < part.scriptErrors.evaluated, JSON.stringify(part.scriptErrors))
})
console.log(`${pass}/${total}`); process.exit(pass === total ? 0 : 1)
