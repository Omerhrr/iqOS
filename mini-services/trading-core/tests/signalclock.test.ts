// IQAIR//OS - tests for analytics/signalclock.ts (the Signal clock's combination rules).
//   npx tsx tests/signalclock.test.ts      (from mini-services/trading-core)
import assert from 'node:assert/strict'
import { buildSignal, fitExpiry, regimePart, ENTER_NEEDLE, WAIT_CLAMP } from '../src/analytics/signalclock'
import type { EffortRead, Lean, PanelVerdict } from '../src/analytics/explainer'
import type { RegimeRow } from '../src/analytics/regimescan'
import type { Candle } from '../src/types'

type Test = { name: string; fn: () => void }
const tests: Test[] = []
const test = (name: string, fn: () => void) => tests.push({ name, fn })

const IDS: PanelVerdict['id'][] = ['smc', 'candle', 'mrc', 'swing', 'technical']
function panels(leans: (Lean | 'off')[]): PanelVerdict[] {
  return IDS.map((id, i) => {
    const l = leans[i] ?? 'none'
    const ok = l !== 'off'
    return { id, title: id, ok, lean: ok ? (l as Lean) : 'none', strength: ok && l !== 'none' ? 60 : null, headline: `${id} ${l}`, reasons: [] }
  })
}
function effort(lean: Lean, ok = true): EffortRead {
  return { ok, lean, strength: lean === 'none' ? null : 70, headline: `effort ${lean}`, reasons: [], brickSize: 1, brickRule: 'x', effortSource: 'volume', trend: 'up', streak: 3, confirmedRatio: 0.7, regime: 'trending', lookback: 20, bricks: [] }
}
function regime(kind: RegimeRow['regime'], score = 70, position = 0.5): RegimeRow {
  return { regime: kind, score, er: 0.5, adx: 30, plusDI: 25, minusDI: 10, tStat: 5, r2: 0.8, rangePct: 0.5, rangeAtr: 6, crossings: 6, touchesTop: 3, touchesBottom: 3, position, flipRate: 0.3, price: 1, windowHigh: 1.1, windowLow: 0.9, reason: `${kind} reason` }
}
function walkCandles(n: number, step: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ time: i * 60, open: 100 + i * step, high: 100 + i * step + 0.1, low: 100 + i * step - 0.1, close: 100 + (i + 1) * step, volume: 10 }) as Candle)
}
const B = (p: PanelVerdict[], e: EffortRead | null, r: RegimeRow | null, c: Candle[] = walkCandles(150, 0.05)) => buildSignal({ panels: p, effort: e, regime: r, candles: c, tfSec: 60 })

test('trend-up with readers agreeing is BUY, needle positive, expiry given', () => {
  const s = B(panels(['call', 'call', 'call', 'call', 'none']), effort('call'), regime('trend-up'))
  assert.equal(s.action, 'buy')
  assert.ok(s.needle >= ENTER_NEEDLE)
  assert.ok(s.expiry && s.expiry.bars >= 1)
})

test('trend-down with readers agreeing is SELL, needle negative', () => {
  const s = B(panels(['put', 'put', 'put', 'none', 'put']), effort('put'), regime('trend-down'), walkCandles(150, -0.05))
  assert.equal(s.action, 'sell')
  assert.ok(s.needle <= -ENTER_NEEDLE)
})

test('trend-up but the readers lean PUT is WAIT (regime and readers disagree)', () => {
  const s = B(panels(['put', 'put', 'put', 'call', 'none']), effort('put'), regime('trend-up'))
  assert.equal(s.action, 'wait')
  assert.ok(s.expiry === null)
})

test('noise regime is always WAIT, even with unanimous readers', () => {
  const s = B(panels(['call', 'call', 'call', 'call', 'call']), effort('call'), regime('noise'))
  assert.equal(s.action, 'wait')
  assert.ok(s.headline.includes('noise'))
})

test('unreadable regime (null) is WAIT', () => {
  const s = B(panels(['call', 'call', 'call', 'call', 'call']), effort('call'), null)
  assert.equal(s.action, 'wait')
  assert.equal(s.regime, 'unreadable')
})

test('while WAIT the needle never leaves the WAIT zone', () => {
  const s = B(panels(['call', 'call', 'call', 'call', 'call']), effort('call'), regime('noise'))
  assert.ok(Math.abs(s.needle) <= WAIT_CLAMP)
  assert.ok(Math.abs(s.rawNeedle) > WAIT_CLAMP)
})

test('ranging at the bottom edge with no readers against is a BUY fade', () => {
  const s = B(panels(['call', 'none', 'call', 'none', 'none']), effort('none'), regime('ranging', 60, 0.05))
  assert.equal(s.action, 'buy')
  assert.equal(s.expiry?.bars, 2)
})

test('ranging at the top edge is a SELL fade; mid-box is WAIT', () => {
  const top = B(panels(['put', 'none', 'put', 'none', 'none']), effort('none'), regime('ranging', 60, 0.95))
  assert.equal(top.action, 'sell')
  const mid = B(panels(['put', 'none', 'put', 'none', 'none']), effort('none'), regime('ranging', 60, 0.5))
  assert.equal(mid.action, 'wait')
})

test('a range-edge fade is refused when two readers lean against it', () => {
  const s = B(panels(['put', 'put', 'call', 'none', 'none']), effort('none'), regime('ranging', 60, 0.05))
  assert.equal(s.action, 'wait')
})

test('unreadable readers are excluded, never counted as neutral', () => {
  const s = B(panels(['call', 'call', 'off', 'off', 'off']), effort('none', false), regime('trend-up'))
  assert.equal(s.readers.unreadable, 4)
  assert.equal(s.readers.call, 2)
  assert.equal(s.readers.flat, 0)
})

test('evidence lists every reader plus Effort Renko', () => {
  const s = B(panels(['call', 'put', 'none', 'none', 'none']), effort('call'), regime('noise'))
  assert.equal(s.evidence.length, 6)
  assert.ok(s.evidence.some((e) => e.id === 'effort'))
})

test('regimePart: sign follows the regime, noise is zero, edge depth scales the fade', () => {
  assert.ok(regimePart(regime('trend-up')).value > 0)
  assert.ok(regimePart(regime('trend-down')).value < 0)
  assert.equal(regimePart(regime('noise')).value, 0)
  assert.ok(regimePart(regime('ranging', 50, 0)).value > regimePart(regime('ranging', 50, 0.15)).value)
  assert.equal(regimePart(regime('ranging', 50, 0.5)).value, 0)
})

test('fitExpiry on a steady climb picks a hold with a high follow-through rate', () => {
  const e = fitExpiry(walkCandles(150, 0.05), 1, 60, 'trend-up')!
  assert.ok(e.rates.every((r) => r.rate > 0.9))
  assert.ok(e.minutes === e.bars)
})

test('fitExpiry with the signal against the drift reports no edge and the shortest hold', () => {
  const e = fitExpiry(walkCandles(150, 0.05), -1, 60, 'trend-down')!
  assert.equal(e.bars, 1)
  assert.ok(e.basis.includes('coin flip'))
})

test('fitExpiry fails closed with too little history', () => {
  assert.equal(fitExpiry(walkCandles(10, 0.05), 1, 60, 'trend-up'), null)
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
    console.log(`  FAIL - ${t.name}\n    ${err instanceof Error ? err.message : err}`)
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
if (failed > 0) process.exit(1)
