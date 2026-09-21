// Verification harness for the Task 30 chart-rendering upgrades:
//   1. psar  -> line style 'dots' (traditional point-marker rendering)
//   2. zigzag -> dense interpolated swing line (visible segments) + forex-scale default dev
//   3. fractals -> arrow MARKERS (arrowDown above swing highs / arrowUp below swing lows)
//   4. vsk/tsk stack sar lines -> 'dots' as well
// Run: bun scripts/render_selftest.ts   (from repo root)
import { getIndicatorDef, computeIndicator } from '../mini-services/trading-core/src/analytics/registry'
import type { Candle } from '../mini-services/trading-core/src/types'

let pass = 0
let fail = 0
const ok = (cond: boolean, name: string, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ok  ${name}${extra ? ' - ' + extra : ''}`)
  } else {
    fail++
    console.error(`FAIL  ${name}${extra ? ' - ' + extra : ''}`)
  }
}

// Synthetic candles: OU-like mean reversion with pronounced swings around 1.10
// (forex scale: per-bar noise ~ a few pips), then a trend leg.
function synth(n: number, seed = 7): Candle[] {
  let s = seed
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648 - 0.5
  }
  const out: Candle[] = []
  let price = 1.1
  const anchor = 1.1
  let drift = 0
  for (let i = 0; i < n; i++) {
    // alternating trend legs (like real FX micro-structure) so 0.05% swings form
    if (i % 45 === 0) drift = (rnd() > 0.5 ? 1 : -1) * 0.000035
    const pull = i < n - 150 ? (anchor - price) * 0.012 : 0.00004
    const wave = Math.sin(i / 12) * 0.0004
    price += pull + wave + drift + rnd() * 0.0004
    const o = price - rnd() * 0.0002
    const cl = price
    const hi = Math.max(o, cl) + Math.abs(rnd()) * 0.0003
    const lo = Math.min(o, cl) - Math.abs(rnd()) * 0.0003
    out.push({ time: 1700000000 + i * 60, open: o, high: hi, low: lo, close: cl, volume: 0 })
  }
  return out
}

const candles = synth(600)
console.log(`synth candles: ${candles.length}`)

// ---------- 1. PSAR dots ----------
{
  const def = getIndicatorDef('psar')!
  const res = computeIndicator('psar', candles, {})!
  const sar = res.output.lines[0]
  ok(def !== undefined, 'psar def exists')
  ok(sar.style === 'dots', 'psar line style is dots', `style=${sar.style}`)
  ok(res.output.lines[0].values.filter((v) => Number.isFinite(v)).length > 500, 'psar values dense')
}

// ---------- 2. ZigZag ----------
{
  const def = getIndicatorDef('zigzag')!
  ok(def.params[0].default === 0.05 && def.params[0].min === 0.02, 'zigzag default dev 0.05% (forex-visible)', `default=${def.params[0].default}`)
  const res = computeIndicator('zigzag', candles, {})!
  const zz = res.output.lines[0].values
  const finite = zz.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0)
  ok(finite.length > 30, 'zigzag has many finite points', `finite=${finite.length}`)
  // dense coverage between first and last pivot: no NaN holes inside
  let holes = 0
  for (let i = finite[0]; i <= finite[finite.length - 1]; i++) if (!Number.isFinite(zz[i])) holes++
  ok(holes === 0, 'zigzag interpolated - no gaps between first/last pivot', `holes=${holes}`)
  // pivot values must sit exactly on closes
  const pivIdx = finite.filter((i) => zz[i] === candles[i].close)
  ok(pivIdx.length >= 4, 'zigzag pivots land on closes', `pivots=${pivIdx.length}`)
  // interpolation midpoint sanity: bar between two pivots sits between their values
  const a = pivIdx[0]
  const b = pivIdx[1]
  const mid = Math.floor((a + b) / 2)
  ok(zz[mid] >= Math.min(zz[a], zz[b]) - 1e-12 && zz[mid] <= Math.max(zz[a], zz[b]) + 1e-12, 'interpolated midpoint within segment range')
}

// ---------- 3. Fractals as arrows ----------
{
  const def = getIndicatorDef('fractals')!
  const res = computeIndicator('fractals', candles, {})!
  const mk = res.output.markers ?? []
  ok(res.output.lines.length === 0 && mk.length > 10, 'fractals emit markers (no lines)', `markers=${mk.length}`)
  ok(mk.every((m) => m.shape === 'arrowDown' || m.shape === 'arrowUp'), 'all markers are arrows')
  ok(mk.every((m) => (m.shape === 'arrowDown' ? m.position === 'aboveBar' && m.color === '#f43f5e' : m.position === 'belowBar' && m.color === '#10b981')), 'up-fractal: arrowDown above (red) / down-fractal: arrowUp below (green)')
  // markers must sit on real swing extremes, and never inside the unconfirmed right wing
  const timeIdx = new Map(candles.map((c, i) => [c.time, i]))
  let extremaOk = true
  let wingOk = true
  for (const m of mk) {
    const i = timeIdx.get(m.time)
    if (i === undefined) { extremaOk = false; break }
    if (m.shape === 'arrowDown') {
      if (!(candles[i].high >= candles[i - 2].high && candles[i].high >= candles[i + 2].high)) extremaOk = false
    } else {
      if (!(candles[i].low <= candles[i - 2].low && candles[i].low <= candles[i + 2].low)) extremaOk = false
    }
    if (i > candles.length - 3) wingOk = false
  }
  ok(extremaOk, 'every marker is a genuine 2/2 Williams extreme')
  ok(wingOk, 'no markers inside the unconfirmed right wing (non-repainting)')
  // wing param respected
  const res5 = computeIndicator('fractals', candles, { wing: 5 })!
  const mk5 = (res5.output.markers ?? []).filter((m) => m.shape === 'arrowDown')
  const mk2 = mk.filter((m) => m.shape === 'arrowDown')
  ok(mk5.length <= mk2.length, 'larger wing -> fewer (stronger) fractals', `w2=${mk2.length} w5=${mk5.length}`)
}

// ---------- 4. vsk/tsk stack sar dots ----------
{
  for (const id of ['vsk', 'tsk']) {
    const res = computeIndicator(id, candles, {})!
    const sar = res.output.lines.find((l) => l.key === 'sar')!
    ok(sar.style === 'dots', `${id} stack sar renders as dots`, `style=${sar.style}`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
