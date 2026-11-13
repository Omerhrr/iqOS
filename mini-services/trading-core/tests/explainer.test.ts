// IQAIR//OS - tests for the Explainer (analytics/explainer.ts + plugins/explainer.ts).
//
// Same no-framework runner as msl.test.ts:
//   npx tsx tests/explainer.test.ts      (from mini-services/trading-core)
//
// Covers each panel's verdict rule at its boundaries, the agreement count
// (unreadable panels are excluded, never counted as neutral), and the real
// service path with a stubbed market/engines.

import assert from 'node:assert/strict'
import {
  explainMrc,
  explainPatterns,
  explainSmc,
  explainSwing,
  explainTechnical,
  summarizeVerdicts,
  PATTERN_LEAN_MIN,
  type PanelVerdict,
} from '../src/analytics/explainer'
import { ExplainerService } from '../src/plugins/explainer'
import { computeSwing } from '../src/analytics/swing'
import { summarizeTf } from '../src/analytics/technicals'
import type { Candle, PatternHit } from '../src/types'
import type { SmcScanResult } from '../src/analytics/smc'
import type { MrcPredictResult } from '../src/analytics/mrcpredict'

type Test = { name: string; fn: () => void }
const tests: Test[] = []
function test(name: string, fn: () => void) {
  tests.push({ name, fn })
}

const hit = (name: string, direction: PatternHit['direction'], reliability: 1 | 2 | 3, barsAgo = 0): PatternHit => ({ name, direction, reliability, barsAgo, note: `${name} note` })

function smcFixture(over: Partial<SmcScanResult> = {}): SmcScanResult {
  return {
    price: 1.2345,
    ts: 0,
    trend: 'bearish',
    signals: [
      { kind: 'CRT', direction: 'bullish', index: 99, barsAgo: 0, active: true, note: 'crt' },
      { kind: 'FVG', direction: 'bearish', index: 97, barsAgo: 2, active: true, top: 1.24, bottom: 1.23, note: 'fvg' },
      { kind: 'CHOCH', direction: 'bearish', index: 96, barsAgo: 3, active: true, level: 1.25, note: 'choch' },
      { kind: 'ORDER_BLOCK', direction: 'bearish', index: 90, barsAgo: 9, active: false, top: 1.3, bottom: 1.29, note: 'stale ob' },
    ],
    summary: { direction: 'put', confidence: 68, bullish: 1, bearish: 3 },
    ...over,
  }
}

const mrcFixture = (over: Partial<MrcPredictResult> = {}): MrcPredictResult => ({
  ok: true, note: 'note', state: 'continuation-likely', direction: 'call', confidence: 62, value: 0.62, sampleSize: 48, lastResponseRatio: 1.4, lastDisplacement: 0.0003, fidelity: 'candle', ...over,
})

// ---------------------------------------------------------------- SMC

test('SMC: no scan result reads as unreadable, not neutral', () => {
  const v = explainSmc(null)
  assert.equal(v.ok, false)
  assert.equal(v.lean, 'none')
  assert.match(v.headline, /60\+ bars/)
})

test('SMC: restates the engine lean and lists only ACTIVE signals, newest first', () => {
  const v = explainSmc(smcFixture())
  assert.equal(v.ok, true)
  assert.equal(v.lean, 'put')
  assert.equal(v.strength, 68)
  assert.match(v.headline, /PUT 68%/)
  assert.match(v.headline, /1 bullish vs 3 bearish/)
  assert.match(v.reasons[0], /bearish/)
  assert.match(v.reasons[1], /CRT bullish, now/)
  assert.match(v.reasons[2], /Fair Value Gap bearish, 2 bars ago/)
  assert.ok(!v.reasons.join(' ').includes('stale ob'), 'inactive signals are not explained')
})

test('SMC: engine says none -> no lean, no strength', () => {
  const v = explainSmc(smcFixture({ summary: { direction: 'none', confidence: 0, bullish: 1, bearish: 1 }, trend: 'range' }))
  assert.equal(v.lean, 'none')
  assert.equal(v.strength, null)
  assert.match(v.reasons[0], /range/)
})

// ---------------------------------------------------------- candle patterns

test('patterns: nothing found is readable and flat', () => {
  const v = explainPatterns([])
  assert.equal(v.ok, true)
  assert.equal(v.lean, 'none')
  assert.match(v.headline, /No candlestick pattern/)
})

test('patterns: a neutral doji never leans', () => {
  const v = explainPatterns([hit('Doji', 'neutral', 1)])
  assert.equal(v.lean, 'none')
  assert.match(v.headline, /not decisive/)
})

test('patterns: a strong fresh bullish pattern leans CALL; the mirror leans PUT', () => {
  const up = explainPatterns([hit('Three White Soldiers', 'bullish', 3, 0)])
  assert.equal(up.lean, 'call')
  assert.ok(up.strength !== null && up.strength > 0)
  assert.match(up.reasons[0], /Three White Soldiers \(bullish, ★★★, now\)/)
  const down = explainPatterns([hit('Evening Star', 'bearish', 3, 0)])
  assert.equal(down.lean, 'put')
})

test('patterns: the lean threshold is exactly PATTERN_LEAN_MIN of net bias', () => {
  // reliability 1 at 0 bars ago = bias 1 (below 1.5) -> no lean
  assert.equal(explainPatterns([hit('weak', 'bullish', 1, 0)]).lean, 'none')
  // reliability 2 at 0 bars ago = bias 2 (>= 1.5) -> lean
  assert.equal(explainPatterns([hit('ok', 'bullish', 2, 0)]).lean, 'call')
  assert.ok(PATTERN_LEAN_MIN > 1 && PATTERN_LEAN_MIN <= 2)
})

test('patterns: opposing patterns cancel instead of both counting', () => {
  const v = explainPatterns([hit('a', 'bullish', 2, 0), hit('b', 'bearish', 2, 0)])
  assert.equal(v.lean, 'none')
})

// -------------------------------------------------------------------- MRC

test('MRC: warming / not ok is unreadable', () => {
  assert.equal(explainMrc(mrcFixture({ ok: false, state: 'warming', direction: 'none', note: 'warming up' })).ok, false)
  assert.equal(explainMrc(null).ok, false)
})

test('MRC: uncertain is readable but flat (no edge is an answer, not a gap)', () => {
  const v = explainMrc(mrcFixture({ state: 'uncertain', direction: 'none', confidence: 0, note: 'rate under 55%' }))
  assert.equal(v.ok, true)
  assert.equal(v.lean, 'none')
  assert.match(v.headline, /No edge/)
})

test('MRC: continuation vs reversal wording and the engine direction are restated', () => {
  const c = explainMrc(mrcFixture())
  assert.equal(c.lean, 'call')
  assert.equal(c.strength, 62)
  assert.match(c.headline, /Continuation likely - CALL 62% \(n=48\)/)
  const r = explainMrc(mrcFixture({ state: 'reversal-likely', direction: 'put', confidence: 58 }))
  assert.equal(r.lean, 'put')
  assert.match(r.headline, /Reversal likely - PUT 58%/)
})

// ------------------------------------------------------------------ swing

const sw = (structure: 'hh-hl' | 'lh-ll' | 'none', highs: number[], lows: number[]) => ({
  lookback: 3,
  structure,
  direction: 1 as const,
  swings: [
    ...highs.map((p, i) => ({ time: 100 + i * 10, price: p, kind: 'high' as const, index: 10 + i * 10 })),
    ...lows.map((p, i) => ({ time: 105 + i * 10, price: p, kind: 'low' as const, index: 15 + i * 10 })),
  ],
})

test('swing: fewer than two confirmed highs and lows is unreadable', () => {
  const v = explainSwing(sw('none', [10], [5, 6]), 7)
  assert.equal(v.ok, false)
  assert.match(v.headline, /Not enough confirmed swings/)
})

test('swing: hh-hl leans CALL, lh-ll leans PUT, mixed leans nothing', () => {
  assert.equal(explainSwing(sw('hh-hl', [10, 12], [5, 7]), 9).lean, 'call')
  assert.equal(explainSwing(sw('lh-ll', [12, 10], [7, 5]), 8).lean, 'put')
  assert.equal(explainSwing(sw('none', [10, 12], [7, 5]), 9).lean, 'none')
})

test('swing: a structure that price has just broken does not lean', () => {
  const up = explainSwing(sw('hh-hl', [10, 12], [5, 7]), 6.5) // below the last low (7)
  assert.equal(up.lean, 'none')
  assert.match(up.headline, /failing/)
  const down = explainSwing(sw('lh-ll', [12, 10], [7, 5]), 10.5) // above the last high (10)
  assert.equal(down.lean, 'none')
  assert.match(down.headline, /failing/)
})

test('swing: the real computeSwing on a zig-zag climb reads as an uptrend', () => {
  const candles: Candle[] = []
  for (let i = 0; i < 120; i++) {
    const close = 100 + i * 0.25 + Math.sin(i / 3) * 3
    candles.push({ time: 1000 + i * 60, open: close - 0.1, high: close + 0.4, low: close - 0.4, close, volume: 10 })
  }
  const s = computeSwing(candles, { lookback: 3 })
  assert.equal(s.structure, 'hh-hl')
  const v = explainSwing(s, candles[candles.length - 1].close)
  assert.equal(v.ok, true)
  assert.ok(['call', 'none'].includes(v.lean), 'uptrend structure may only lean CALL (or none if price just broke the last low)')
})

// -------------------------------------------------------------- technical

function techRow(score: number, ok = true) {
  const label = score >= 0.5 ? 'STRONG BUY' : score >= 0.15 ? 'BUY' : score > -0.15 ? 'NEUTRAL' : score > -0.5 ? 'SELL' : 'STRONG SELL'
  const v = { label, score, buys: score > 0 ? 8 : 2, sells: score > 0 ? 2 : 8, neutrals: 2, counted: 12 } as const
  return {
    tf: '1m', sec: 60, source: 'native' as const, ok, note: ok ? 'ok' : 'warming up - needs 40+ closed bars (has 12)', bars: 100, ticksPerBar: null,
    osc: [{ name: 'RSI(14)', read: score > 0 ? ('buy' as const) : ('sell' as const), value: '31.2' }],
    oscSummary: v, mas: [{ name: 'EMA(20)', read: score > 0 ? ('buy' as const) : ('sell' as const), value: '1.2' }], maSummary: v, summary: v,
  }
}

test('technical: a warming-up row is unreadable and carries the engine note', () => {
  const v = explainTechnical(techRow(0.5, false) as never)
  assert.equal(v.ok, false)
  assert.match(v.headline, /warming up/)
  assert.equal(explainTechnical(null).ok, false)
})

test('technical: lean follows the 0.15 vote-balance line the engine itself uses', () => {
  assert.equal(explainTechnical(techRow(0.6) as never).lean, 'call')
  assert.equal(explainTechnical(techRow(0.15) as never).lean, 'call')
  assert.equal(explainTechnical(techRow(0.1) as never).lean, 'none')
  assert.equal(explainTechnical(techRow(-0.1) as never).lean, 'none')
  assert.equal(explainTechnical(techRow(-0.6) as never).lean, 'put')
  const v = explainTechnical(techRow(0.6) as never)
  assert.equal(v.strength, 60)
  assert.match(v.reasons.join(' '), /Voting buy: RSI\(14\) 31\.2/)
})

// ---------------------------------------------------------------- summary

const pv = (id: PanelVerdict['id'], lean: PanelVerdict['lean'], ok = true): PanelVerdict => ({ id, title: id, ok, lean, strength: null, headline: '', reasons: [] })

test('summary: 4 CALL + 1 flat is aligned', () => {
  const s = summarizeVerdicts([pv('smc', 'call'), pv('candle', 'call'), pv('mrc', 'call'), pv('swing', 'call'), pv('technical', 'none')])
  assert.equal(s.lean, 'call')
  assert.equal(s.grade, 'aligned')
  assert.match(s.headline, /4 of 5 readable panels lean CALL, 1 flat/)
})

test('summary: a level split is mixed and leans nowhere', () => {
  const s = summarizeVerdicts([pv('smc', 'call'), pv('candle', 'put'), pv('mrc', 'none'), pv('swing', 'none'), pv('technical', 'none')])
  assert.equal(s.lean, 'none')
  assert.equal(s.grade, 'mixed')
  assert.match(s.headline, /disagree: 1 lean CALL vs 1 lean PUT/)
})

test('summary: 3 vs 1 leans with the majority but is not "aligned"', () => {
  const s = summarizeVerdicts([pv('smc', 'put'), pv('candle', 'put'), pv('mrc', 'put'), pv('swing', 'call'), pv('technical', 'none')])
  assert.equal(s.lean, 'put')
  assert.equal(s.grade, 'leaning')
  assert.match(s.headline, /1 lean the other way/)
})

test('summary: unreadable panels are excluded from the count, never counted as neutral', () => {
  const s = summarizeVerdicts([pv('smc', 'call'), pv('candle', 'call'), pv('mrc', 'none', false), pv('swing', 'none', false), pv('technical', 'call')])
  assert.equal(s.unavailable, 2)
  assert.equal(s.readable, 3)
  assert.equal(s.flat, 0)
  assert.equal(s.grade, 'aligned')
  assert.match(s.headline, /3 of 3 readable panels/)
})

test('summary: all flat, and nothing readable', () => {
  assert.equal(summarizeVerdicts([pv('smc', 'none'), pv('candle', 'none')]).grade, 'flat')
  const none = summarizeVerdicts([pv('smc', 'none', false), pv('candle', 'none', false)])
  assert.equal(none.grade, 'none')
  assert.equal(none.readable, 0)
})

test('summary always carries the honesty note', () => {
  assert.match(summarizeVerdicts([pv('smc', 'call')]).note, /not a probability/)
})

// ---------------------------------------------------------------- service

function zigzag(n: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const close = 100 + i * 0.05 + Math.sin(i / 4) * 2
    out.push({ time: 1_700_000_000 + i * 60, open: close - 0.2, high: close + 0.5, low: close - 0.5, close, volume: 100 + (i % 7) })
  }
  return out
}

function service(candles: Candle[] | ((tf: string) => Candle[]), opts: { smc?: SmcScanResult | null; mrc?: MrcPredictResult | null } = {}) {
  const market = {
    getCandlesDeep: (_a: string, tf: string) => (typeof candles === 'function' ? candles(tf) : candles),
    getPrice: () => 0,
  }
  const services: Record<string, unknown> = {
    market,
    smcScan: { scan: () => ({ result: opts.smc === undefined ? smcFixture() : opts.smc }) },
    mrcpredict: { readFor: () => (opts.mrc === undefined ? mrcFixture() : opts.mrc) },
  }
  const svc = new ExplainerService()
  void svc.start({ use: (n: string) => services[n], log: () => {}, provide: () => {} } as never)
  return svc
}

test('service: reads all five panels in a fixed order and agrees with the summary', () => {
  const r = service(zigzag(400)).read('EURUSD', '1m')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.panels.map((p) => p.id), ['smc', 'candle', 'mrc', 'swing', 'technical'])
  assert.equal(r.tf, '1m')
  assert.equal(r.asset, 'EURUSD')
  assert.equal(r.bars, 400)
  const call = r.panels.filter((p) => p.ok && p.lean === 'call').length
  const put = r.panels.filter((p) => p.ok && p.lean === 'put').length
  assert.equal(r.summary.call, call)
  assert.equal(r.summary.put, put)
  assert.equal(r.summary.readable, r.panels.filter((p) => p.ok).length)
  // price falls back to the last close when the market has no live price
  assert.equal(r.price, zigzag(400)[399].close)
})

test('service: chart payload is the newest 90 closed candles with only the swings inside them', () => {
  const r = service(zigzag(400)).read('EURUSD', '1m')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.chart.candles.length, 90)
  const t0 = r.chart.candles[0].time
  assert.ok(r.chart.swings.length > 0, 'a sine-wave tape has confirmed swings')
  for (const s of r.chart.swings) assert.ok(s.time >= t0)
  assert.ok(['hh-hl', 'lh-ll', 'none'].includes(r.chart.structure))
})

test('service: too little history leaves the data-hungry panels unreadable instead of faking a verdict', () => {
  const r = service(zigzag(30), { smc: null }).read('EURUSD', '1m')
  assert.equal(r.ok, true)
  if (!r.ok) return
  const by = Object.fromEntries(r.panels.map((p) => [p.id, p]))
  assert.equal(by.smc.ok, false)
  assert.equal(by.swing.ok, false)
  assert.equal(by.technical.ok, false)
  assert.ok(r.summary.unavailable >= 3)
})

test('service: unknown timeframe and empty history fail closed', () => {
  assert.deepEqual(service(zigzag(400)).read('EURUSD', '7m'), { ok: false, error: "unknown timeframe '7m'" })
  const empty = service([]).read('NOPE', '1m')
  assert.equal(empty.ok, false)
})

test('service: summarizeTf is called for the requested timeframe, not a nearby ladder rung', () => {
  // 15m is not a technical-ladder rung; the explainer still reads it exactly
  const row = summarizeTf('15m', 900, 'native', zigzag(300))
  assert.equal(row.tf, '15m')
  assert.equal(row.ok, true)
  const r = service(zigzag(400)).read('EURUSD', '15m')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.panels.find((p) => p.id === 'technical')!.ok, true)
})

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    t.fn()
    passed++
    console.log(`  ok - ${t.name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL - ${t.name}`)
    console.log(`    ${err instanceof Error ? err.message : err}`)
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
if (failed > 0) process.exit(1)
