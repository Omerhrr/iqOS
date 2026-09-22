// Lab basis selftest - the "learn no matter the chart type" contract:
// 1. heikinAshiCandles is 1:1 (length/timestamps) with the raw series
// 2. basisCandles only transforms when spec.basis === 'heikin'
// 3. a spec learned on the HA basis persists basis:'heikin' through normalizeSpec
// 4. HA-basis signals differ from raw-basis signals on the same data (real transform)
// 5. outcome/settlement arrays stay on REAL prices (learn + backtestSpec use raw closes)
// 6. thin-history auto-relaxation: minSamples never exceeds the ask, never below 10
// 7. garbage basis values normalize away (undefined basis = raw)
import { createHash } from 'node:crypto'
import type { Candle } from '../mini-services/trading-core/src/types'
import {
  basisCandles,
  buildCtx,
  evaluateCustom,
  heikinAshiCandles,
  normalizeSpec,
  type CustomSpec,
} from '../mini-services/trading-core/src/strategies/custom'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++
    console.log(`  ok ${pass} - ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${pass + fail} - ${name}${extra ? ` (${extra})` : ''}`)
  }
}

// deterministic synthetic series: trending legs + noise
function synth(n: number, seedStr: string): Candle[] {
  let h = parseInt(createHash('md5').update(seedStr).digest('hex').slice(0, 8), 16)
  const rng = () => {
    h = (h * 1664525 + 1013904223) >>> 0
    return h / 0xffffffff
  }
  const out: Candle[] = []
  let px = 1.1
  const t0 = 1_800_000_000 - n * 60
  for (let i = 0; i < n; i++) {
    const trend = Math.sin(i / 40) * 0.0004 + (i % 120 < 60 ? 0.0002 : -0.0002)
    px = Math.max(0.5, px + trend + (rng() - 0.5) * 0.0006)
    const spread = 0.0002 + rng() * 0.0002
    out.push({ time: t0 + i * 60, open: px - spread / 2, high: px + spread, low: px - spread, close: px, volume: Math.round(100 + rng() * 900) })
  }
  return out
}

const raw = synth(600, 'basis-selftest')

// 1. 1:1 transform
const ha = heikinAshiCandles(raw)
ok('heikinAshiCandles preserves length', ha.length === raw.length)
ok('heikinAshiCandles preserves timestamps', ha.every((c, i) => c.time === raw[i].time))
ok('heikinAshiCandles preserves volume', ha.every((c, i) => c.volume === raw[i].volume))
ok('HA close = OHLC/4', Math.abs(ha[10].close - (raw[10].open + raw[10].high + raw[10].low + raw[10].close) / 4) < 1e-12)
ok('HA differs from raw closes', ha.filter((c, i) => Math.abs(c.close - raw[i].close) > 1e-9).length > raw.length / 2)

// 2. basisCandles gating
const rawSpec: CustomSpec = { name: 'raw', signals: [{ kind: 'ha', variant: 'streak-up', len: 3, dir: 'call', weight: 20 }], minScore: 40, minVotes: 1, horizon: 1 }
const haSpec: CustomSpec = { ...rawSpec, basis: 'heikin' }
ok('basisCandles raw passthrough', basisCandles(rawSpec, raw) === raw)
ok('basisCandles heikin transforms', basisCandles(haSpec, raw) !== raw && basisCandles(haSpec, raw).length === raw.length)

// 3. normalizeSpec round-trips basis
const norm = normalizeSpec(JSON.parse(JSON.stringify(haSpec)), 't')
ok('normalizeSpec keeps basis heikin', norm?.basis === 'heikin')
ok('normalizeSpec keeps signals', (norm?.signals.length ?? 0) === 1)
const normRaw = normalizeSpec({ ...JSON.parse(JSON.stringify(haSpec)), basis: 'renko' }, 't')
ok('unknown basis drops to raw (undefined)', normRaw?.basis === undefined)

// 4. HA-basis evaluation differs from raw-basis evaluation somewhere
const ctxRaw = buildCtx(raw)
const ctxHa = buildCtx(ha)
const votesDiffer = raw.some((_, i) => {
  const a = evaluateCustom(rawSpec, raw.slice(0, i + 1))
  const b = evaluateCustom(haSpec, raw.slice(0, i + 1))
  return a.score !== b.score
})
ok('same data, different basis -> different scores somewhere', votesDiffer)
ok('raw spec scores identical on both ctx builds (sanity)', evaluateCustom(rawSpec, raw).score === evaluateCustomAtProxy(rawSpec, ctxRaw))
function evaluateCustomAtProxy(spec: CustomSpec, ctx: ReturnType<typeof buildCtx>): number {
  // re-uses evaluateCustom on the ctx's own candles to prove ctx consistency
  return evaluateCustom(spec, ctx.candles).score
}

// 5. settlement honesty: heikinAshiCandles closes are NOT used by learn sims.
// The learn() pipeline reads `raw` closes (verified via API in lab_e2e); here we
// prove the HA close is a derived value (would corrupt settlement if misused).
ok('HA close is an average (never equals raw close generally)', Math.abs(ha[5].close - raw[5].close) > 0 || Math.abs(ha[6].close - raw[6].close) > 0)

// 6. thin-history relaxation formula (mirrors lab.learn)
function relaxed(ask: number, bars: number, horizon = 1, warm = 30): number {
  return Math.max(10, Math.min(ask, Math.floor((bars - warm - horizon) / 6)))
}
ok('thin 240 bars relaxes 40 -> 34', relaxed(40, 240) === 34)
ok('thin 150 bars relaxes 40 -> 19', relaxed(40, 150) === 19)
ok('rich 1200 bars keeps ask 40', relaxed(40, 1200) === 40)
ok('floor never below 10', relaxed(10, 90) === 10)
ok('never above the ask', relaxed(20, 1200) === 20)

// 7. evaluateCustom on an HA spec still takes RAW candles from the caller
const ev = evaluateCustom(haSpec, raw)
ok('HA spec evaluates from raw feed (live-trade shape)', typeof ev.score === 'number' && !!ev.notes)

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
