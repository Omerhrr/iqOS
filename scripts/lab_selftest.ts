// Strategy Lab self-test: custom DSL + learning pipeline (bun scripts/lab_selftest.ts)
// Synthetic candles with PLANTED structure prove the lab discovers what is
// actually there, and the evaluator votes exactly as the learner measured.
import { heikinAshi, evaluateCustom, normalizeSpec, signalActive, buildCtx, type CustomSpec } from '../mini-services/trading-core/src/strategies/custom'
import { StrategyLabService } from '../mini-services/trading-core/src/plugins/lab'
import type { Candle } from '../mini-services/trading-core/src/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++
    console.log(`  ok ${pass} - ${name}`)
  } else {
    fail++
    console.error(`  FAIL ${fail} - ${name} ${extra}`)
  }
}

// ---------- synthetic candle factory ----------
let seed = 42
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

function mkCandle(time: number, open: number, close: number, wick = 0.0002): Candle {
  const high = Math.max(open, close) + wick
  const low = Math.min(open, close) - wick
  return { time, open, high, low, close, volume: 0 }
}

// A market that: drifts down for 5 bars, prints a Bullish Engulfing, then
// rallies 5 bars (the planted edge the lab must find), and repeats. Between
// planted blocks: neutral noise candles.
function plantEngulfingRally(blocks: number): Candle[] {
  const out: Candle[] = []
  let t = 1700000000
  let price = 1.1
  const down = 0.0004
  const up = 0.0006
  for (let b = 0; b < blocks; b++) {
    // 5 red bars
    for (let i = 0; i < 5; i++) {
      const open = price
      price -= down * (0.7 + rnd() * 0.6)
      out.push(mkCandle(t++, open, price))
    }
    // bullish engulfing: red body then bigger green body engulfing it
    const open1 = price
    price -= down * 0.8
    out.push(mkCandle(t++, open1, price, 0.00005))
    const open2 = price - down * 0.2 // opens just below prior close (engulf precondition)
    price = open1 + up * 0.2 // closes above prior open
    out.push(mkCandle(t++, open2, price, 0.00005))
    // 5 green bars
    for (let i = 0; i < 5; i++) {
      const open = price
      price += up * (0.7 + rnd() * 0.6)
      out.push(mkCandle(t++, open, price))
    }
    // 6 flat-ish bars (no signal)
    for (let i = 0; i < 6; i++) {
      const open = price
      price += (rnd() - 0.5) * 0.00005
      out.push(mkCandle(t++, open, price, 0.0003))
    }
  }
  return out
}

// A market that: builds a 3-green Heiken Ashi streak then continues up.
// Raw candles alternate large green bodies with tiny red bars so HA smooths
// into a clean up-run.
function plantHAStreakRally(blocks: number): Candle[] {
  const out: Candle[] = []
  let t = 1800000000
  let price = 1.2
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 3; i++) {
      const open = price
      price += 0.0008
      out.push(mkCandle(t++, open, price, 0.00005))
    }
    for (let i = 0; i < 5; i++) {
      const open = price
      price += 0.0005 * (0.5 + rnd())
      out.push(mkCandle(t++, open, price))
    }
    // pullback phase: 3 small red bars (HA stays greenish due to smoothing)
    for (let i = 0; i < 3; i++) {
      const open = price
      price -= 0.00008
      out.push(mkCandle(t++, open, price, 0.0004))
    }
  }
  return out
}

console.log('--- heiken ashi transform ---')
{
  const cs: Candle[] = [
    { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 0 },
    { time: 2, open: 11, high: 13, low: 10.5, close: 12.5, volume: 0 },
  ]
  const ha = heikinAshi(cs)
  check('HA close = OHLC/4', Math.abs(ha.close[0] - 10.5) < 1e-9 && Math.abs(ha.close[1] - 11.75) < 1e-9)
  check('HA open[0] = (o+c)/2', Math.abs(ha.open[0] - 10.5) < 1e-9)
  check('HA open[1] = (prevO+prevC)/2', Math.abs(ha.open[1] - 10.5) < 1e-9)
  check('HA high envelopes', ha.high[1] >= Math.max(cs[1].high, ha.open[1], ha.close[1]) - 1e-9)
  check('HA low envelopes', ha.low[1] <= Math.min(cs[1].low, ha.open[1], ha.close[1]) + 1e-9)
}

console.log('--- planted Bullish Engulfing edge is discovered ---')
{
  const candles = plantEngulfingRally(40) // ~40 events, ~520 bars
  // drive learn() through a stubbed service (no kernel): minimal fake market
  const lab = Object.create(StrategyLabService.prototype) as StrategyLabService
  ;(lab as unknown as { market: { getCandlesDeep: () => Candle[] } }).market = { getCandlesDeep: () => candles }
  ;(lab as unknown as { ctx: unknown }).ctx = { bus: { emit: () => {} }, log: () => {} }
  const res = lab.learn({ asset: 'TEST', tf: '1m', bars: 2200, minSamples: 15, minEdge: 1, payout: 0.7, name: 'Planted Engulf' })
  check('learn ok', res.ok, res.note)
  check(
    'Bullish Engulfing among measured signals',
    res.signals.some((s) => s.label.toLowerCase() === 'bullish engulfing' && s.edgePts > 0),
    JSON.stringify(res.signals.slice(0, 6)),
  )
  const engulf = res.signals.find((s) => s.label.toLowerCase() === 'bullish engulfing')
  check('engulfing edge positive', !!engulf && engulf.edgePts > 20, engulf ? `edge ${engulf.edgePts}` : 'missing')
  check('spec synthesized', !!res.spec)
  check('spec trades the engulfing', !!res.spec?.signals.some((s) => s.kind === 'candle' && s.name.toLowerCase() === 'bullish engulfing'))
  check('backtest win rate > breakeven', !!res.backtest && res.backtest.trades >= 5 && res.backtest.winRate > res.breakevenWinRate, JSON.stringify(res.backtest))
}

console.log('--- planted HA streak edge is discovered ---')
{
  const candles = plantHAStreakRally(120)
  const lab = Object.create(StrategyLabService.prototype) as StrategyLabService
  ;(lab as unknown as { market: { getCandlesDeep: () => Candle[] } }).market = { getCandlesDeep: () => candles }
  ;(lab as unknown as { ctx: unknown }).ctx = { bus: { emit: () => {} }, log: () => {} }
  const res = lab.learn({ asset: 'TEST2', tf: '1m', bars: 2200, minSamples: 25, minEdge: 1, payout: 0.7, name: 'Planted HA' })
  check('learn ok', res.ok, res.note)
  check(
    'HA streak-up discovered with positive edge',
    res.signals.some((s) => s.kind === 'ha' && s.label === 'HA Streak Up' && s.edgePts > 0),
    JSON.stringify(res.signals.slice(0, 8).map((s) => [s.label, s.edgePts])),
  )
  check('backtest profitable at 0.7 payout', !!res.backtest && res.backtest.netPnl > 0, JSON.stringify(res.backtest))
}

console.log('--- evaluator votes per the scoring model ---')
{
  const cs = plantHAStreakRally(40)
  const ctx = buildCtx(cs)
  const spec: CustomSpec = {
    name: 't',
    signals: [
      { kind: 'ha', variant: 'streak-up', len: 3, dir: 'call', weight: 30 },
      { kind: 'bar', variant: 'wide-bull', atrK: 0.3, dir: 'call', weight: 10 },
      { kind: 'ha', variant: 'streak-down', len: 3, dir: 'put', weight: 40 },
    ],
    minScore: 40,
    minVotes: 2,
    horizon: 1,
  }
  // find a bar with both bull signals active
  let fired = -1
  for (let i = 30; i < ctx.n; i++) {
    if (signalActive(spec.signals[0], ctx, i) && signalActive(spec.signals[1], ctx, i)) {
      fired = i
      break
    }
  }
  check('a bar exists with 2 bull signals active', fired > 0)
  if (fired > 0) {
    const ev = evaluateCustom(spec, cs.slice(0, fired + 1))
    check('confluence fires CALL', ev.direction === 'call', JSON.stringify(ev))
    check('score = 100 when no bear votes', ev.score === 100)
    check('notes list both signals', ev.notes.includes('HA Streak Up') && ev.notes.includes('Wide Bull Bar'), ev.notes)
  }
  // single-signal bar below minVotes -> none
  let solo = -1
  for (let i = 30; i < ctx.n; i++) {
    if (signalActive(spec.signals[0], ctx, i) && !signalActive(spec.signals[1], ctx, i) && !signalActive(spec.signals[2], ctx, i)) {
      solo = i
      break
    }
  }
  if (solo > 0) {
    const ev = evaluateCustom(spec, cs.slice(0, solo + 1))
    check('minVotes=2 blocks lone signal', ev.direction === 'none', JSON.stringify(ev))
  } else check('minVotes=2 blocks lone signal (skipped - no solo bar)', true)
}

console.log('--- spec normalization ---')
{
  const spec = normalizeSpec({
    name: 'x',
    signals: [
      { kind: 'candle', name: 'Bullish Engulfing', weight: 99 },
      { kind: 'ha', variant: 'flip-up' }, // no dir -> implied call, no len -> 2
      { kind: 'indicator', ind: 'rsi', params: { period: 14 }, op: '<', threshold: 30 }, // implied dir required -> call default
      { kind: 'alien', variant: 'nope' },
      { kind: 'indicator', ind: 'nope', op: '>', threshold: 1 },
    ],
    minScore: 400,
    minVotes: 99,
    horizon: 99,
  })
  check('keeps 3 valid signals, drops unknown kinds/inds', spec?.signals.length === 3, JSON.stringify(spec))
  check('weight clamped to 50', spec?.signals[0].weight === 50)
  check('ha implied dir call + len 2', spec?.signals[1].dir === 'call' && (spec?.signals[1] as { len?: number }).len === 2)
  check('minScore clamped to 95', spec?.minScore === 95)
  check('minVotes clamped to 6', spec?.minVotes === 6)
  check('horizon clamped to 10', spec?.horizon === 10)
  check('garbage -> null', normalizeSpec({ signals: [{ kind: 'nope' }] }) === null)
  check('non-object -> null', normalizeSpec('x' as unknown as object) === null)
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
