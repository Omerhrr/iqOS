// Verification harness for the structural chart tools (pivots/fib/trendlines/fvg).
// Run: bun scripts/structural_selftest.ts   (from mini-services/trading-core)
import {
  computePivotSeries, computeFibSeries, computeTrendlineSeries, computeFvgSeries,
} from '../mini-services/trading-core/src/analytics/structural'

interface K { time: number; open: number; high: number; low: number; close: number; volume: number }
const bar = (t: number, o: number, h: number, l: number, c: number): K => ({ time: t, open: o, high: h, low: l, close: c, volume: 0 })
let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const near = (a: number, b: number, eps = 1e-9): boolean => Number.isFinite(a) && Math.abs(a - b) < eps

// ── 1. Pivot Points: two UTC sessions, hand-computed classic levels ──
{
  const DAY = 86400
  const d0 = DAY * 100
  const dayA: K[] = []
  for (let i = 0; i < 120; i++) {
    let h = 1.15 + 0.002 * Math.sin(i / 7)
    let l = h - 0.003
    let c = 1.15
    if (i === 40) h = 1.2 // session high
    if (i === 80) l = 1.1 // session low
    if (i === 119) c = 1.15 // session close (already)
    dayA.push(bar(d0 + i * 60, c - 0.001, h, l, c))
  }
  const dayB: K[] = []
  for (let i = 0; i < 120; i++) dayB.push(bar(d0 + DAY + i * 60, 1.16, 1.165, 1.155, 1.16))
  const s = computePivotSeries([...dayA, ...dayB], { variant: 0 })
  check('pivots: session mode detected', s.mode === 'session')
  check('pivots: first session NaN (no anchor)', !Number.isFinite(s.pp[50]))
  // classic from H=1.2 L=1.1 C=1.15: PP=1.15 R1=1.2 S1=1.1 R2=1.25 S2=1.05 R3=1.3 S3=1.0
  const j = 200 // a day-B bar
  check('pivots: PP', near(s.pp[j], 1.15), `${s.pp[j]}`)
  check('pivots: R1', near(s.r1[j], 1.2), `${s.r1[j]}`)
  check('pivots: S1', near(s.s1[j], 1.1), `${s.s1[j]}`)
  check('pivots: R2', near(s.r2[j], 1.25), `${s.r2[j]}`)
  check('pivots: S2', near(s.s2[j], 1.05), `${s.s2[j]}`)
  check('pivots: R3', near(s.r3[j], 1.3), `${s.r3[j]}`)
  check('pivots: S3', near(s.s3[j], 1.0), `${s.s3[j]}`)
  // fibonacci variant: R1 = PP + 0.382*range = 1.15 + 0.0382 = 1.1882
  const sf = computePivotSeries([...dayA, ...dayB], { variant: 1 })
  check('pivots: fib variant R1', near(sf.r1[j], 1.15 + 0.382 * 0.1), `${sf.r1[j]}`)
  // rolling fallback: no usable timestamps
  const noT = [...dayA, ...dayB].map((k, i) => ({ ...k, time: 0 }))
  const sr = computePivotSeries(noT, { variant: 0, period: 60 })
  check('pivots: rolling fallback active', sr.mode === 'rolling' && Number.isFinite(sr.pp[100]))
}
// ── 2. Auto Fibonacci: clean up-leg 1.0 -> 1.1 ──
{
  const candles: K[] = []
  for (let i = 0; i < 150; i++) {
    let px = 1.05 + 0.0003 * Math.sin(i)
    if (i === 50) px = 1.0 // swing low (exact flat bar)
    if (i === 120) px = 1.1 // swing high (exact flat bar)
    const h = i === 120 ? px : px + 0.0001
    const l = i === 50 ? px : px - 0.0001
    candles.push(bar(1789900000 + i * 60, px, h, l, px))
  }
  const s = computeFibSeries(candles, { lookback: 150 })
  const j = 145
  check('fib: 0% at swing high', near(s.fib0[j], 1.1), `${s.fib0[j]}`)
  check('fib: 100% at swing low', near(s.fib100[j], 1.0), `${s.fib100[j]}`)
  check('fib: 50%', near(s.fib50[j], 1.05), `${s.fib50[j]}`)
  check('fib: 61.8%', near(s.fib618[j], 1.1 - 0.0618), `${s.fib618[j]}`)
  check('fib: ext 1.618', near(s.ext1618[j], 1.1 + 0.618 * 0.1), `${s.ext1618[j]}`)
  check('fib: up-leg direction', s.state[j].startsWith('UP'), s.state[j])
  // flip the leg: make a new LOW after the high
  candles.push(bar(1789900000 + 150 * 60, 0.98, 0.985, 0.98, 0.98)) // new swing low below 1.0
  const s2 = computeFibSeries(candles, { lookback: 150 })
  const j2 = 150
  check('fib: re-anchors to down-leg', s2.state[j2].startsWith('DOWN') && near(s2.fib0[j2], 0.98), s2.state[j2])
}
// ── 3. Auto Trendlines: three collinear swing highs -> exact line recovery ──
{
  // line y = 1.31 - 0.0005*idx ; pivots at idx 20/60/100 (1.30, 1.28, 1.26)
  const candles: K[] = []
  let h = 1.299
  for (let i = 0; i < 130; i++) {
    if (i === 20) h = 1.30
    else if (i === 60) h = 1.28
    else if (i === 100) h = 1.26
    else if (i > 20 && i < 58) h = Math.max(1.2745, h - 0.0006)
    else if (i > 60 && i < 98) h = Math.max(1.2545, h - 0.0006)
    else if (i > 100) h = Math.max(1.2445, h - 0.0006)
    else if (i < 20) h = 1.296 + 0.0002 * i
    // valleys around pivot bars stay strictly below the crest
    if (i === 59 || i === 99) h = h - 0.0002
    if (i === 58 || i === 98) h = h - 0.0004
    if (i === 61 || i === 101) h = h - 0.0004
    candles.push(bar(1789900000 + i * 60, h - 0.002, h, h - 0.004, h - 0.001))
  }
  const s = computeTrendlineSeries(candles, { pivotLeft: 2, pivotRight: 2, maxFit: 3 })
  const j = 125
  const expect = 1.31 - 0.0005 * 125 // 1.2475
  check('trendlines: collinear fit recovered', near(s.resTrend[j], expect, 1e-8), `res=${s.resTrend[j]} expect=${expect}`)
  check('trendlines: descending slope', s.resSlope[j] < 0, `${s.resSlope[j]}`)
  check('trendlines: NaN before first anchor', !Number.isFinite(s.resTrend[10]))
  check('trendlines: state explains position', s.state[j].includes('res desc'), s.state[j])
}
// ── 4. Fair Value Gaps: constructed 3-bar imbalance + fill ──
{
  const candles: K[] = [
    bar(1789900000, 1.095, 1.1, 1.09, 1.098),
    bar(1789900060, 1.098, 1.105, 1.095, 1.1),
    bar(1789900120, 1.1, 1.108, 1.1, 1.105),
    bar(1789900180, 1.11, 1.13, 1.12, 1.125), // low 1.12 > high[1]=1.105 -> bull gap
    bar(1789900240, 1.125, 1.126, 1.104, 1.118), // low 1.104 <= high[2]=1.108 -> NO second gap
    bar(1789900300, 1.118, 1.119, 1.09, 1.093), // close 1.093 < bot 1.105 -> filled
  ]
  const s = computeFvgSeries(candles)
  check('fvg: detected bull gap', near(s.bullTop[3], 1.12) && near(s.bullBot[3], 1.105), `${s.bullTop[3]}/${s.bullBot[3]}`)
  check('fvg: still active bar 4', Number.isFinite(s.bullTop[4]))
  check('fvg: filled by close-through', !Number.isFinite(s.bullTop[5]), `${s.bullTop[5]}`)
  check('fvg: state counts', s.state[4].includes('bull fvg 1'), s.state[4])
}
// ── 5. Performance on a 1400-bar feed ──
{
  const candles: K[] = []
  let px = 1.1
  let s3 = 42
  const rnd = () => { s3 = (s3 * 1103515245 + 12345) % 2147483648; return s3 / 2147483648 - 0.5 }
  for (let i = 0; i < 1400; i++) {
    px += (1.1 - px) * 0.05 + Math.sin(i / 14) * 0.0008 + rnd() * 0.0005
    candles.push(bar(1789900000 + i * 60, px - 0.0002, px + 0.0003, px - 0.0003, px))
  }
  const t0 = performance.now()
  computePivotSeries(candles)
  computeFibSeries(candles)
  computeTrendlineSeries(candles)
  computeFvgSeries(candles)
  const dt = performance.now() - t0
  check('perf: all four series on 1400 bars', dt < 500, `${dt.toFixed(1)}ms`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
