// Chart-engine vote signal (Task 64-d: feed the lab) - deterministic checks:
// 1. parity: engineVoteSingle matches engineVotes per engine on the same slice
// 2. window parity: the lab's per-bar replay equals the live scanner's read
//    on the trailing 240-candle window (what the scanner feeds the engines)
// 3. no lookahead: corrupting bars AFTER i never changes the vote at i
// 4. thin-history floor: bars below the scanner's 40-candle guard never fire
// 5. normalize round-trip: valid engine defs survive; missing dir, unknown
//    engine and the tick-buffer-only otcfootprint are dropped
// 6. scorer integration: an engine-only spec votes with the engine's dir
import { createHash } from 'node:crypto'
import type { Candle } from '../mini-services/trading-core/src/types'
import {
  buildCtx,
  evaluateCustom,
  normalizeSpec,
  prepareSignal,
  signalActive,
  type CustomSpec,
} from '../mini-services/trading-core/src/strategies/custom'
import { buildChartSignal, engineVoteSingle, engineVotes, MINABLE_ENGINES } from '../mini-services/trading-core/src/analytics/chartsignals'

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

const raw = synth(600, 'engine-unit')

// 1. parity: single-engine eval == full engineVotes row
{
  const slice = raw.slice(-240)
  const all = engineVotes(slice, { otc: false, realTicks: null, otcRead: null })
  for (const engine of MINABLE_ENGINES) {
    const single = engineVoteSingle(engine, slice)
    const row = all.find((v) => v.engine === engine)
    ok(`parity ${engine}: dir`, single.dir === row?.dir, `${single.dir} vs ${row?.dir}`)
    ok(`parity ${engine}: weight`, Math.abs(single.weight - (row?.weight ?? -1)) < 1e-12)
    ok(`parity ${engine}: note`, single.note === row?.note)
  }
}

// 2. window parity with the live scanner: per-bar replay at the tail ==
// the scanner's per-engine vote on the trailing 240 candles
{
  const feed = raw.slice(-240) // what the scanner hands buildChartSignal
  const ctx = buildCtx(raw)
  for (const engine of MINABLE_ENGINES) {
    for (const dir of ['call', 'put'] as const) {
      const def = { kind: 'engine', engine, dir, weight: 10 } as const
      const test = prepareSignal(def, ctx)
      const live = engineVoteSingle(engine, feed).dir === (dir === 'call' ? 1 : -1)
      ok(`tail parity ${engine}/${dir}`, test(raw.length - 1) === live, `replay ${test(raw.length - 1)} vs live ${live}`)
    }
  }
}

// 3. no lookahead: corrupting everything AFTER bar i must not move the
// vote at i (per-bar purity - the def reads only the trailing window)
{
  const i = 300
  const mutated = raw.map((c, j) => (j <= i ? c : { time: c.time, open: c.open * 3, high: c.high * 5, low: c.low * 0.1, close: c.close * 7, volume: 1e9 }))
  const ctxA = buildCtx(raw)
  const ctxB = buildCtx(mutated)
  for (const engine of MINABLE_ENGINES) {
    const def = { kind: 'engine', engine, dir: 'call', weight: 10 } as const
    const a = prepareSignal(def, ctxA)(i)
    const b = prepareSignal(def, ctxB)(i)
    ok(`no-lookahead ${engine}@${i}`, a === b, `${a} vs ${b}`)
  }
}

// 4. thin-history floor: below the scanner's 40-candle guard, no engine fires
{
  const short = raw.slice(0, 30)
  const ctxShort = buildCtx(short)
  for (const engine of MINABLE_ENGINES) {
    const def = { kind: 'engine', engine, dir: 'call', weight: 10 } as const
    ok(`floor ${engine} @29 candles`, signalActive(def, ctxShort) === false)
  }
  const ctxEdge = buildCtx(raw.slice(0, 45))
  const defC = { kind: 'engine', engine: 'candle', dir: 'call', weight: 10 } as const
  // bar 39 exactly = first fireable bar (40-candle window), must not throw
  signalActive(defC, ctxEdge, 39)
  ok('floor edge @39 candles evaluates', true)
}

// 5. normalize round-trip
{
  const spec = normalizeSpec({
    name: 'engine test',
    minScore: 30,
    minVotes: 1,
    horizon: 1,
    signals: [
      { kind: 'engine', engine: 'renko', dir: 'call', weight: 10 },
      { kind: 'engine', engine: 'otcfootprint', dir: 'call', weight: 10 }, // not minable
      { kind: 'engine', engine: 'pnf', weight: 10 }, // no dir -> dropped
      { kind: 'engine', engine: 'banana', dir: 'put', weight: 10 }, // unknown engine
    ],
  })
  ok('normalize keeps 1 of 4', spec?.signals.length === 1, `kept ${spec?.signals.length}`)
  ok('normalize keeps renko call', spec?.signals[0]?.kind === 'engine' && spec?.signals[0].engine === 'renko' && spec?.signals[0].dir === 'call')
}

// 6. scorer integration: an engine-only spec votes with the engine's dir
{
  const renkoDir = engineVoteSingle('renko', raw.slice(-240)).dir
  if (renkoDir !== 0) {
    const spec = normalizeSpec({
      name: 'renko only',
      minScore: 10,
      minVotes: 1,
      horizon: 1,
      signals: [{ kind: 'engine', engine: 'renko', dir: renkoDir === 1 ? 'call' : 'put', weight: 10 }],
    }) as CustomSpec
    const ev = evaluateCustom(spec, raw)
    ok('engine-only spec fires with engine dir', ev.direction === (renkoDir === 1 ? 'call' : 'put') && Math.abs(ev.score) > 0, `dir ${ev.direction} score ${ev.score}`)
    const flipped = normalizeSpec({
      name: 'renko flipped',
      minScore: 10,
      minVotes: 1,
      horizon: 1,
      signals: [{ kind: 'engine', engine: 'renko', dir: renkoDir === 1 ? 'put' : 'call', weight: 10 }],
    }) as CustomSpec
    const ev2 = evaluateCustom(flipped, raw)
    ok('opposite def does not fire', ev2.direction !== (renkoDir === 1 ? 'call' : 'put'), `dir ${ev2.direction} score ${ev2.score}`)
  } else {
    ok('renko vote was neutral on the synthetic series (skipped firing checks)', true)
  }
}

// 7. scanner-level sanity: buildChartSignal on this series agrees with the
// mined defs on WHICH engines voted which way at the tail bar
{
  const feed = raw.slice(-240)
  const sig = buildChartSignal({ ticker: 'SYNTH', name: 'Synth', category: 'forex', otc: false, pip: 4 }, feed, { now: 1_800_000_000_000 })
  if (sig) {
    const ctx = buildCtx(raw)
    let checked = 0
    let allMatch = true
    for (const v of sig.votes) {
      if (v.engine === 'otcfootprint' || !MINABLE_ENGINES.includes(v.engine as (typeof MINABLE_ENGINES)[number])) continue
      for (const dir of ['call', 'put'] as const) {
        const def = { kind: 'engine', engine: v.engine, dir, weight: 10 } as const
        const fires = prepareSignal(def, ctx)(raw.length - 1)
        const should = v.dir === (dir === 'call' ? 1 : -1)
        if (fires !== should) allMatch = false
        checked++
      }
    }
    ok(`scanner votes match mined defs (${checked} checks)`, allMatch && checked >= 14)
  } else {
    ok('no qualifying scanner signal on synthetic series (engines still checked above)', true)
  }
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
