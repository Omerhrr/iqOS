// IQAIR//OS - tests: story.* (the story of the last closed candle) + roc
import assert from 'node:assert/strict'
import { readStory, readRoc } from '../src/analytics/candlestory'
import { evaluateStrategyScript, parseStrategyScript } from '../src/analytics/strategylang'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
// 60 calm bars around 1.3000 (range ~ 0.0010), then a crafted last bar
const mk = (last: [number, number, number, number]) => {
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], t: number[] = []
  for (let i = 0; i < 60; i++) { const b = 1.3 + (i % 2 ? 0.0002 : -0.0002); o.push(b); c.push(b + (i % 2 ? -0.0002 : 0.0002)); h.push(Math.max(o[i], c[i]) + 0.0003); l.push(Math.min(o[i], c[i]) - 0.0003); t.push(1_700_000_000 + i * 60) }
  o.push(last[0]); h.push(last[1]); l.push(last[2]); c.push(last[3]); t.push(1_700_000_000 + 60 * 60)
  return { open: o, high: h, low: l, close: c, time: t }
}
test('marubozu up: almost all body, closes at the high', () => {
  const s = readStory(mk([1.3000, 1.3016, 1.2999, 1.3015])); assert.equal(s.kind, 'marubozu'); assert.equal(s.dir, 1); assert.ok(s.closePos > 0.9); assert.ok(/one-way up/.test(s.text), s.text)
})
test('rejection of the highs: long upper wick, closes low', () => {
  const s = readStory(mk([1.3000, 1.3020, 1.2998, 1.3001])); assert.equal(s.kind, 'rejection-high'); assert.ok(/rejected/.test(s.text), s.text)
})
test('stop-run below the recent low that closes back above is flagged as a bullish sweep', () => {
  const s = readStory(mk([1.3000, 1.3004, 1.2985, 1.3003])); assert.equal(s.sweep, 1); assert.ok(/swept below/.test(s.text), s.text)
})
test('breakout above the recent high', () => {
  const s = readStory(mk([1.3002, 1.3022, 1.3001, 1.3020])); assert.equal(s.breakout, 1)
})
test('doji and inside bar', () => {
  assert.equal(readStory(mk([1.3000, 1.3006, 1.2994, 1.30005])).kind, 'doji')
  assert.equal(readStory(mk([1.3000, 1.3003, 1.2998, 1.3001])).inside, true)
})
test('too few candles: not ok, never throws', () => {
  const s = readStory({ open: [1, 1], high: [1, 1], low: [1, 1], close: [1, 1] }); assert.equal(s.ok, false)
})
test('5s path: clean push vs chop, retrace and early extreme', () => {
  const base = mk([1.3000, 1.3016, 1.2999, 1.3015]); const t0 = base.time[60]
  const five = (path: number[]) => { const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], t: number[] = []; let prev = 1.3000; path.forEach((p, k) => { o.push(prev); c.push(p); h.push(Math.max(prev, p)); l.push(Math.min(prev, p)); t.push(t0 + k * 5); prev = p }); return { open: o, high: h, low: l, close: c, time: t } }
  const clean = readStory(base, five(Array.from({ length: 12 }, (_, k) => 1.3000 + 0.0015 * (k + 1) / 12)))
  assert.ok(clean.has5s && clean.pathEff > 0.9 && clean.retrace < 0.1, JSON.stringify([clean.pathEff, clean.retrace])); assert.ok(/clean push/.test(clean.text), clean.text)
  const chop = readStory(base, five([1.3010, 1.2995, 1.3012, 1.2996, 1.3013, 1.2997, 1.3014, 1.2998, 1.3015, 1.2999, 1.3014, 1.3015]))
  assert.ok(chop.pathEff < 0.25, String(chop.pathEff)); assert.ok(/chopped/.test(chop.text), chop.text)
  const faded = readStory(base, five([1.3010, 1.3020, 1.3018, 1.3016, 1.3015, 1.3015, 1.3015, 1.3015, 1.3015, 1.3015, 1.3015, 1.3015]))
  assert.equal(faded.extremeEarly, 1); assert.ok(faded.retrace > 0.15)
  assert.equal(readStory(base).has5s, false)
})
test('roc: percent change over n bars, ATR units, acceleration, body roc', () => {
  const b = mk([1.3000, 1.3016, 1.2999, 1.3015]); const r1 = readRoc(b, 1), r5 = readRoc(b, 5)
  assert.ok(Math.abs(r1.roc - (b.close[60] - b.close[59]) / b.close[59] * 100) < 1e-9)
  assert.ok(Math.abs(r5.roc - (b.close[60] - b.close[55]) / b.close[55] * 100) < 1e-9)
  assert.ok(Number.isFinite(r1.rocAtr) && Number.isFinite(r1.accel) && Math.abs(r1.rocOfBody - 0.1153846) < 1e-3, JSON.stringify(r1))
})
test('story.* works in a script (backtest-safe) and an unknown method says what exists', () => {
  const b = mk([1.3000, 1.3016, 1.2999, 1.3015])
  const run = (src: string) => { const p = parseStrategyScript(src); assert.ok(p.ok, (p as any).error); return evaluateStrategyScript((p as any).ast, {}, undefined, { ...b, volume: b.close.map(() => 1) } as any, undefined, undefined, { keyPrefix: 'story-t' } as any) }
  const r = run('call when story.kind() == "marubozu" and story.dir() == 1 and story.roc(1) > 0 and story.is("marubozu") and story.size() > 1\nput when story.sweep() == -1')
  assert.equal(r.direction, 'call', JSON.stringify(r))
  const bad = run('call when story.nope() == 1'); assert.ok(bad.error && /story\.nope/.test(bad.error), JSON.stringify(bad))
})
import { readWindowStory } from '../src/analytics/candlestory'
const series = (f: (i: number) => number, n = 120, wob = 0.0003) => {
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], t: number[] = []
  for (let i = 0; i < n; i++) { const a = f(i), b = f(i + 1); o.push(a); c.push(b); h.push(Math.max(a, b) + wob); l.push(Math.min(a, b) - wob); t.push(1_700_000_000 + i * 60) }
  return { open: o, high: h, low: l, close: c, time: t }
}
test('window story: a steady climb is a trend-up for 14 and 21 bars, a steady fall trend-down', () => {
  const up = series((i) => 1.3 + (i < 90 ? 0 : (i - 90) * 0.0006))
  for (const n of [14, 21]) { const w = readWindowStory(up, n); assert.equal(w.kind, 'trend-up', `${n}: ${w.kind} ${w.text}`); assert.ok(w.eff > 0.8 && w.net > 2) }
  const dn = series((i) => 1.3 - (i < 90 ? 0 : (i - 90) * 0.0006)); assert.equal(readWindowStory(dn, 14).kind, 'trend-down')
})
test('window story: sideways chop is a range, a V is a reversal-up, shrinking candles a squeeze', () => {
  const chop = series((i) => 1.3 + (i % 2 ? 0.0004 : -0.0004)); assert.equal(readWindowStory(chop, 14).kind, 'range', readWindowStory(chop, 14).text)
  const v = series((i) => 1.3 + (i < 90 ? 0 : i < 105 ? -(i - 90) * 0.0007 : -0.0105 + (i - 105) * 0.0007)); assert.equal(readWindowStory(v, 30).kind, 'reversal-up', readWindowStory(v, 30).text)
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = []
  for (let i = 0; i < 100; i++) { const amp = i < 80 ? 0.0010 : 0.0010 * Math.max(0.1, 1 - (i - 80) / 14); const m = 1.3 + (i % 2 ? amp / 2 : -amp / 2), m2 = 1.3 + (i % 2 ? -amp / 2 : amp / 2); o.push(m); c.push(m2); h.push(Math.max(m, m2) + amp * 0.2); l.push(Math.min(m, m2) - amp * 0.2) }
  const sq = readWindowStory({ open: o, high: h, low: l, close: c }, 18); assert.equal(sq.kind, 'squeeze', sq.kind + ' ' + sq.text)
})
test('window story: too few bars or a silly n is not ok and never throws; any n in range works', () => {
  assert.equal(readWindowStory(series((i) => 1.3, 20), 14).ok, false); assert.equal(readWindowStory(series((i) => 1.3), 2).ok, false)
  for (const n of [3, 5, 8, 34, 55, 89]) assert.equal(readWindowStory(series((i) => 1.3 + Math.sin(i / 7) * 0.003, 200), n).ok, true)
})
test('story.window(n) / windowText / windowKind in a script, fields via the bundle', () => {
  const b = series((i) => 1.3 + (i < 90 ? 0 : (i - 90) * 0.0006))
  const run = (src: string) => { const p = parseStrategyScript(src); assert.ok(p.ok, (p as any).error); return evaluateStrategyScript((p as any).ast, {}, undefined, { ...b, volume: b.close.map(() => 1) } as any, undefined, undefined, { keyPrefix: 'sw-t' } as any) }
  const r = run('let w = story.window(14)\ncall when w.ok and w.kind == "trend-up" and w.net > 2 and w.eff > 0.7 and story.windowKind(21) == "trend-up" and story.windowText(14) != ""\nput when w.kind == "trend-down"')
  assert.equal(r.direction, 'call', JSON.stringify(r))
})
import { readStructure, cutBars } from '../src/analytics/candlestory'
// zigzag with a rising drift: peaks every 8 bars, each higher than the last
const zig = (drift: number, n = 140) => series((i) => 1.3 + drift * i + 0.004 * Math.abs(((i % 16) - 8)) , n, 0.0002)
test('structure: an up-zigzag labels higher highs and higher lows, overall high/low and sequence are right', () => {
  const b = zig(0.0004); const st = readStructure(b, 60)
  assert.ok(st.ok && st.hh >= 2 && st.hl >= 2 && st.lh === 0 && st.ll === 0, JSON.stringify([st.hh, st.hl, st.lh, st.ll, st.sequence]))
  assert.equal(st.structure, 'uptrend'); assert.ok(/HH/.test(st.sequence) && /HL/.test(st.sequence), st.sequence)
  const last = b.close.length - 1; let hiI = last - 59, hi = -1; for (let k = last - 59; k <= last; k++) if (b.high[k] >= hi) { hi = b.high[k]; hiI = k }
  assert.equal(st.high, hi); assert.equal(st.highAge, last - hiI); assert.equal(st.rocs.length, 60); assert.equal(st.kinds.length, 60)
  assert.ok(st.highs.every((p, j) => j === 0 || p.price > st.highs[j - 1].price))
})
test('structure: a down-zigzag is lower highs and lower lows, a past window (ago) works', () => {
  const st = readStructure(zig(-0.0004), 60); assert.ok(st.lh >= 2 && st.ll >= 2 && st.hh === 0 && st.hl === 0 && st.structure === 'downtrend', JSON.stringify([st.lh, st.ll, st.structure]))
  const up = zig(0.0004); const past = readStructure(up, 40, 30); assert.ok(past.ok); assert.equal(past.n, 40)
  assert.equal(cutBars(up, 30).close.length, up.close.length - 30)
})
test('structure: roc profile - fastest/sharpest bar, halves, acceleration', () => {
  const b = series((i) => 1.3 + (i < 100 ? 0.0001 * i : 0.01 + (i - 100) * 0.0008), 130); const st = readStructure(b, 60)
  assert.ok(st.rocSecond > st.rocFirst && st.rocAccel > 0, JSON.stringify([st.rocFirst, st.rocSecond]))
  assert.ok(st.rocMax > 0 && st.rocUpShare > 0.9 && st.rocMaxAge >= 0)
})
test('script: story.at(k), story.structure(n) arrays and labels, structureText', () => {
  const b = zig(0.0004)
  const run = (src: string) => { const p = parseStrategyScript(src); assert.ok(p.ok, (p as any).error); return evaluateStrategyScript((p as any).ast, {}, undefined, { ...b, volume: b.close.map(() => 1) } as any, undefined, undefined, { keyPrefix: 'st-t' } as any) }
  const r = run('let w = story.structure(60)\nlet c5 = story.at(5)\nlet lastLabel = w.highLabels[len(w.highLabels) - 1]\ncall when w.ok and w.structure == "uptrend" and w.hh >= 2 and lastLabel == "HH" and c5.ok and len(w.rocs) == 60 and story.structureText(60) != "" and story.roc(5, 10) != 0\nput when w.ll > 2')
  assert.equal(r.direction, 'call', JSON.stringify(r))
})
import { readFormingStory } from '../src/analytics/candlestory'
// noisy calm history (so volatility is measurable) + a crafted last bar
let nsd = 3; const nr = () => ((nsd = (nsd * 1664525 + 1013904223) % 4294967296) / 4294967296)
const mkN = (last: [number, number, number, number]) => {
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], t: number[] = []; let p = 1.3
  for (let i = 0; i < 60; i++) { const a = p; p += (nr() - 0.5) * 0.0008; o.push(a); c.push(p); h.push(Math.max(a, p) + nr() * 0.0002); l.push(Math.min(a, p) - nr() * 0.0002); t.push(1_700_000_000 + i * 60) }
  const k = c[59]; o.push(k + (last[0] - 1.3)); h.push(k + (last[1] - 1.3)); l.push(k + (last[2] - 1.3)); c.push(k + (last[3] - 1.3)); t.push(1_700_000_000 + 60 * 60)
  return { open: o, high: h, low: l, close: c, time: t }
}
test('expected move in the story: a huge candle is an extreme sigma move, a normal one is not; next-bar cone is centred on the close', () => {
  const bigBars = mkN([1.3000, 1.3040, 1.2999, 1.3038]); const big = readStory(bigBars); assert.ok(big.moveSigma > 2 && big.rangeSigma > 2 && /extreme move/.test(big.text), big.text)
  const calm = readStory(mkN([1.3000, 1.3004, 1.2998, 1.3001])); assert.ok(Math.abs(calm.moveSigma) < 1 && /normal move/.test(calm.text), calm.text)
  assert.ok(Math.abs((big.expUp1 + big.expDn1) / 2 - bigBars.close[60]) < 1e-9 && big.expUp2 > big.expUp1 && big.sigma > 0)
  assert.ok(Number.isNaN(readStory({ open: Array(20).fill(1), high: Array(20).fill(1.001), low: Array(20).fill(0.999), close: Array(20).fill(1) }).moveSigma))
})
test('window story carries the expected move: netSigma and the next-bar cone', () => {
  const up = series((i) => 1.3 + (i < 90 ? 0 : (i - 90) * 0.0006)); const w = readWindowStory(up, 14)
  assert.ok(w.netSigma > 2 && w.expUp1 > w.expDn1 && /sigma/.test(w.text), JSON.stringify([w.netSigma, w.text]))
})
test('forming candle: partial story with progress, from the closed series plus the bar so far', () => {
  const b = mkN([1.3000, 1.3016, 1.2999, 1.3015]); const closed = { open: b.open.slice(0, 60), high: b.high.slice(0, 60), low: b.low.slice(0, 60), close: b.close.slice(0, 60), time: b.time.slice(0, 60) }
  const f = readFormingStory(closed, { o: 1.3000, h: 1.3012, l: 1.2999, c: 1.3011 }, b.time[60], 0.4)
  assert.equal(f.partial, true); assert.ok(Math.abs(f.progress - 0.4) < 1e-9); assert.ok(/^So far \(40% of the candle elapsed, still forming\)/.test(f.text), f.text); assert.equal(f.dir, 1)
})
test('script: story.now() reads the forming bar when a live bar exists and says so when it does not; moveSigma/windowSigma/expUp work', () => {
  const b = mkN([1.3000, 1.3016, 1.2999, 1.3015]); const closed = { ...b, open: b.open.slice(0, 60), high: b.high.slice(0, 60), low: b.low.slice(0, 60), close: b.close.slice(0, 60), time: b.time.slice(0, 60), volume: Array(60).fill(1) }
  const run = (src: string, live?: any) => { const p = parseStrategyScript(src); assert.ok(p.ok, (p as any).error); return evaluateStrategyScript((p as any).ast, {}, undefined, closed as any, undefined, live, { keyPrefix: 'sn-t' } as any) }
  const bar = { __mslBar: true, o: 1.3000, h: 1.3030, l: 1.2999, c: 1.3028, v: 1, body: 0, range: 0, upperWick: 0, lowerWick: 0 }
  const nowMs = (b.time[59] + 60 + 30) * 1000
  const r = run('let n = story.now()\ncall when n.ok and n.partial and n.dir == 1 and n.progress > 0.4 and n.progress < 0.6 and n.moveSigma > 1 and n.expUp1 > n.expDn1\nput when false', { bar, ticks: [], nowMs } as any)
  assert.equal(r.direction, 'call', JSON.stringify(r))
  const e = run('call when story.now().ok'); assert.ok(e.error && /story\.now\(\)/.test(e.error), JSON.stringify(e))
  const m = run('call when story.moveSigma() != 0 and story.rangeSigma() > 0 and story.windowSigma(14) != 0 and story.expUp() > story.expDn() and story.expUp(2) > story.expUp(1)'); assert.equal(m.direction, 'call', JSON.stringify(m))
})
console.log(`${pass}/${total}`)
