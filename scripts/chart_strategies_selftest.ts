// Task 64 selftest - the six chart-type strategies (range-run / volbars-conviction /
// footprint-imbalance / tpo-fade / tick-regime / ivhv-edge). Pure-math checks on
// engineered tapes, no kernel needed.
// Run: bun scripts/chart_strategies_selftest.ts

import { STRATEGIES, getStrategy, defaultParams } from '../mini-services/trading-core/src/strategies/builtin'
import { computeFootprint } from '../mini-services/trading-core/src/analytics/footprint'
import { computeTpo } from '../mini-services/trading-core/src/analytics/tpo'
import * as ta from '../mini-services/trading-core/src/analytics/indicators'
import type { Candle, StrategyEval } from '../mini-services/trading-core/src/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`)
  }
}
const sameEval = (a: StrategyEval, b: StrategyEval) => a.direction === b.direction && a.score === b.score

// ---------- tape builders ----------
function walk(seed: number, n: number, tfSec = 60, vol = 1000, t0 = 1700000000): Candle[] {
  let s = seed >>> 0
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out: Candle[] = []
  let price = 1.1
  for (let i = 0; i < n; i++) {
    const open = price
    const drift = (rnd() - 0.5) * 0.0012
    const close = Math.max(0.01, open * (1 + drift))
    const hi = Math.max(open, close) * (1 + rnd() * 0.0004)
    const lo = Math.min(open, close) * (1 - rnd() * 0.0004)
    out.push({ time: t0 + i * tfSec, open, high: hi, low: lo, close, volume: Math.round(vol * (0.5 + rnd())) })
    price = close
  }
  return out
}

/** monotonic up tape (the chart_types_selftest classic) */
const upTape: Candle[] = []
for (let i = 0; i < 120; i++) {
  const o = 1 + i * 0.0005
  upTape.push({ time: 1700000000 + i * 60, open: o, high: o + 0.0006, low: o - 0.0001, close: o + 0.0004, volume: 500 })
}

/** exact +step/-step alternation - every candle paints one range bar, flipping each candle */
function sawtooth(n: number, step = 0.0004, vol = 500): Candle[] {
  const out: Candle[] = []
  let price = 1.0
  for (let i = 0; i < n; i++) {
    const open = price
    const close = i % 2 === 0 ? open + step : open - step
    out.push({ time: 1700000000 + i * 60, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: vol })
    price = close
  }
  return out
}

/** equal-volume conviction tape: every candle a full-body up (or down) bar, constant volume */
function convictionTape(n: number, up: boolean, vol = 100): Candle[] {
  const out: Candle[] = []
  let price = 1.0
  for (let i = 0; i < n; i++) {
    const o = price
    const c = up ? o + 0.002 : o - 0.002
    out.push({ time: 1700000000 + i * 60, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: vol })
    price = c
  }
  return out
}

/** weak-body tape: tiny body inside a big range (no conviction) */
function dojiTape(n: number, vol = 100): Candle[] {
  const out: Candle[] = []
  let price = 1.0
  for (let i = 0; i < n; i++) {
    const o = price
    const c = o + (i % 2 === 0 ? 0.0005 : -0.0005)
    out.push({ time: 1700000000 + i * 60, open: o, high: Math.max(o, c) + 0.0035, low: Math.min(o, c) - 0.0035, close: c, volume: vol })
    price = c
  }
  return out
}

/** sinusoidal balance tape around 1.0 (TPO rotations) */
function balanceTape(n: number, amp = 0.0004, period = 20, vol = 500): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const o = 1.0 + amp * Math.sin((i * 2 * Math.PI) / period)
    const c = 1.0 + amp * Math.sin(((i + 1) * 2 * Math.PI) / period)
    out.push({ time: 1700000000 + i * 60, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: vol })
  }
  return out
}

/** candle closes as pseudo-ticks from a sign pattern over moves */
function movesTape(moves: number[], start = 1.0, vol = 500): Candle[] {
  const out: Candle[] = [{ time: 1700000000, open: start, high: start, low: start, close: start, volume: vol }]
  let price = start
  for (let i = 0; i < moves.length; i++) {
    const o = price
    const c = price + moves[i]
    out.push({ time: 1700000000 + (i + 1) * 60, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: vol })
    price = c
  }
  return out
}

/** all-green / all-red tape (close beyond open every candle) */
function trendTape(n: number, up: boolean, vol = 500): Candle[] {
  const out: Candle[] = []
  let price = 1.0
  for (let i = 0; i < n; i++) {
    const o = price
    const c = up ? o + 0.0008 : o - 0.0008
    out.push({ time: 1700000000 + i * 60, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: vol })
    price = c
  }
  return out
}

/** fireSeq mirrors the backtester: evaluate(slice(0, i+1)) per bar */
function fireSeq(id: string, tape: Candle[], params: Record<string, number | string> = {}) {
  const strat = getStrategy(id)
  if (!strat) throw new Error(`strategy ${id} not registered`)
  const out: { i: number; ev: StrategyEval }[] = []
  for (let i = 0; i < tape.length; i++) {
    const ev = strat.evaluate(tape.slice(0, i + 1), params)
    if (ev.direction !== 'none') out.push({ i, ev })
  }
  return out
}
const evAt = (id: string, tape: Candle[], params: Record<string, number | string> = {}): StrategyEval =>
  (getStrategy(id) as { evaluate: (c: Candle[], p: Record<string, number | string>) => StrategyEval }).evaluate(tape, params)

// ============ registry ============
console.log('\n[registry]')
{
  check('registry carries 43 strategies', STRATEGIES.length === 43, `got ${STRATEGIES.length}`)
  const ids = ['range-run', 'volbars-conviction', 'footprint-imbalance', 'tpo-fade', 'tick-regime', 'ivhv-edge']
  for (const id of ids) {
    const s = getStrategy(id)
    check(`${id} registered with params`, !!s && s.params.length > 0)
    if (!s) continue
    const dp = defaultParams(s)
    check(`${id} defaults within declared min/max`, s.params.every((p) => typeof dp[p.key] === 'number' && (p.min === undefined || (dp[p.key] as number) >= p.min) && (p.max === undefined || (dp[p.key] as number) <= p.max)))
  }
  // no crashes / sane outputs on a generic random tape for the whole registry
  const tape = walk(7, 300)
  let sane = true
  let detail = ''
  for (const s of STRATEGIES) {
    for (const i of [120, 200, 299]) {
      let ev: StrategyEval
      try {
        ev = s.evaluate(tape.slice(0, i + 1), defaultParams(s))
      } catch (e) {
        sane = false
        detail = `${s.id} threw at i=${i}: ${e}`
        break
      }
      if (!['call', 'put', 'none'].includes(ev.direction) || !Number.isFinite(ev.score) || Math.abs(ev.score) > 100) {
        sane = false
        detail = `${s.id} insane output at i=${i}: ${JSON.stringify(ev)}`
        break
      }
    }
    if (!sane) break
  }
  check('all 43 strategies evaluate sanely on a random tape', sane, detail)
}

// ============ 1. range-run ============
console.log('\n[range-run]')
{
  const saw = sawtooth(300)
  check('warmup: <40 bars stands aside', evAt('range-run', saw.slice(0, 30)).direction === 'none')
  // atrMult 1.0 -> range = ATR = one full step: exactly one bar per candle,
  // flipping every candle (the default 0.5 would paint two bars per candle and
  // never fire with confirm=1 - the sawtooth then reads as an old 2-run)
  const fires = fireSeq('range-run', saw, { atrMult: 1.0 })
  check('sawtooth fires every candle once warm (40-bar warmup -> 261 fires)', fires.length === 261, `fires=${fires.length}`)
  check('first fire is PUT at the first post-warmup bar (i=39, bar 4 is down)', fires[0]?.i === 39 && fires[0].ev.direction === 'put', JSON.stringify(fires[0]))
  check('fires alternate call/put with the sawtooth', fires.length > 0 && fires.every((f, k) => f.ev.direction === (k % 2 === 0 ? 'put' : 'call')))
  check('fire scores = 70 (streak 1)', fires.length > 0 && fires.every((f) => f.ev.score === 70))
  check('monotonic up tape stands aside (run grows old)', fireSeq('range-run', upTape).every((f) => f.i < 40), JSON.stringify(fireSeq('range-run', upTape).slice(0, 2)))
  const full = evAt('range-run', saw, { atrMult: 1.0 })
  const cut = evAt('range-run', saw.slice(-100), { atrMult: 1.0 })
  check('window-offset independence: direction+score identical from a 100-bar window', sameEval(full, cut), `full=${full.direction}/${full.score} cut=${cut.direction}/${cut.score}`)
  check('notes disclose flip counts (expected to differ across windows)', full.notes !== cut.notes)
  const d1 = evAt('range-run', saw.slice(0, 200))
  const d2 = evAt('range-run', saw.slice(0, 200))
  check('deterministic', JSON.stringify(d1) === JSON.stringify(d2))
}

// ============ 2. volbars-conviction ============
console.log('\n[volbars-conviction]')
{
  const up = convictionTape(60, true)
  const down = convictionTape(60, false)
  const P = { per: 300 }
  check('warmup: <40 bars stands aside', evAt('volbars-conviction', up.slice(0, 30), P).direction === 'none')
  const lateUp = evAt('volbars-conviction', up, P)
  check('full-body equal-volume bar fires CALL', lateUp.direction === 'call', JSON.stringify(lateUp))
  check('fire score 95->clamp 90 region', lateUp.score >= 85 && lateUp.score <= 90, `score=${lateUp.score}`)
  const lateDown = evAt('volbars-conviction', down, P)
  check('mirror tape fires PUT', lateDown.direction === 'put')
  const doji = evAt('volbars-conviction', dojiTape(60), P)
  check('weak-body bar stands aside', doji.direction === 'none', JSON.stringify(doji))
  const zero = evAt('volbars-conviction', convictionTape(60, true, 0), P)
  check('zero-volume window stands aside honestly', zero.direction === 'none' && zero.notes.includes('zero volume'), JSON.stringify(zero))
  // trailing-partial exclusion: at 43 candles the 15th bar holds 1 candle (100 < per 300),
  // so evaluate must ignore it and match the 42-candle read exactly
  const at43 = evAt('volbars-conviction', up.slice(0, 43), P)
  const at42 = evAt('volbars-conviction', up.slice(0, 42), P)
  check('trailing partial bar excluded: signal at 43 == signal at 42', sameEval(at43, at42), `43=${at43.direction}/${at43.score} 42=${at42.direction}/${at42.score}`)
  const auto = evAt('volbars-conviction', up, {})
  check('auto per (0) also fires on the conviction tape', auto.direction === 'call', JSON.stringify(auto))
  const full = evAt('volbars-conviction', up, P)
  const cut = evAt('volbars-conviction', up.slice(-50), P)
  check('window-offset independence (explicit per): direction+score identical from a 50-bar window', sameEval(full, cut), `full=${full.direction}/${full.score} cut=${cut.direction}/${cut.score}`)
  check('notes carry the (approx) volume disclosure', lateUp.notes.includes('approx'))
}

// ============ 3. footprint-imbalance + engine fix ============
console.log('\n[footprint-imbalance]')
{
  // engine fix pin: volume-less rows are NEVER imbalanced
  const noVol = computeFootprint([{ time: 1, open: 1, high: 1.01, low: 0.99, close: 1.005, volume: 0 }])
  check('engine fix: zero-volume ranged candle -> imbalance null', noVol.candles[0].rows.every((r) => r.imbalance === null))
  const flatVol = computeFootprint([{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 500 }])
  check('engine fix: flat candle -> imbalance null (50/50)', flatVol.candles[0].rows.every((r) => r.imbalance === null))

  const ctx = (target: Candle): Candle[] => [
    ...walk(11, 24, 60, 800, 1700000000 - 24 * 60),
    { ...target, time: 1700000000 },
  ]
  const strongBuy = ctx({ time: 0, open: 1.0, high: 1.01, low: 1.0, close: 1.01, volume: 1000 })
  const strongSell = ctx({ time: 0, open: 1.01, high: 1.01, low: 1.0, close: 1.0, volume: 1000 })
  const mid = ctx({ time: 0, open: 1.0, high: 1.01, low: 1.0, close: 1.005, volume: 1000 })
  const noVolCtx = ctx({ time: 0, open: 1.0, high: 1.01, low: 1.0, close: 1.01, volume: 0 })
  const b = evAt('footprint-imbalance', strongBuy)
  check('close at high -> full buy stack fires CALL', b.direction === 'call', JSON.stringify(b))
  check('buy stack covers all 8 bins (minRows 4)', b.notes.includes('8/8'), b.notes)
  check('fire score = 55 + (8-4)*6 = 79', b.score === 79, `score=${b.score}`)
  check('notes carry CLV proxy disclosure', b.notes.includes('CLV'))
  const s = evAt('footprint-imbalance', strongSell)
  check('close at low -> full sell stack fires PUT', s.direction === 'put')
  const m = evAt('footprint-imbalance', mid)
  check('mid close -> no stack, stands aside', m.direction === 'none', JSON.stringify(m))
  const nv = evAt('footprint-imbalance', noVolCtx)
  check('volume-less candle never fires', nv.direction === 'none' && nv.notes.includes('volume-less'), JSON.stringify(nv))
  const bins2 = evAt('footprint-imbalance', strongBuy, { binsPerCandle: 2, minRows: 2 })
  check('bins/minRows params honored (2 bins, minRows 2 -> 2/2 stack)', bins2.direction === 'call' && bins2.notes.includes('2/2'), JSON.stringify(bins2))
  const d1 = evAt('footprint-imbalance', strongBuy)
  const d2 = evAt('footprint-imbalance', strongBuy)
  check('deterministic', JSON.stringify(d1) === JSON.stringify(d2))
}

// ============ 4. tpo-fade ============
console.log('\n[tpo-fade]')
{
  const bal = balanceTape(200)
  check('warmup stands aside', evAt('tpo-fade', bal.slice(0, 100)).direction === 'none')
  const inside = evAt('tpo-fade', bal)
  check('balance tape closing inside VA stands aside', inside.direction === 'none', JSON.stringify(inside))

  // excursion engineering via deterministic fixed point: the excursion candle
  // shifts the profile AND the ATR itself (Wilder-smoothed over its own TR),
  // so aim dist/atr at the target by iterating on the FINAL tape the strategy
  // will see - same ta.atr(14), same computeTpo window, no circularity
  const win = 160
  const lastOf = (a: number[]): number => a[a.length - 1]
  function excursionTape(side: 'up' | 'down', targetAtrMult: number): Candle[] {
    let delta = 0.0002
    let tape = bal
    for (let k = 0; k < 25; k++) {
      const prev = tape[tape.length - 1]
      const tpo = computeTpo(tape.slice(-win), { periodSec: 1800 })
      const edge = (side === 'up' ? tpo.valueAreaHigh : tpo.valueAreaLow) as number
      const close = side === 'up' ? edge + delta : edge - delta
      tape = [
        ...tape.slice(0, -1),
        { time: prev.time + 60, open: prev.close, high: Math.max(prev.close, close), low: Math.min(prev.close, close), close, volume: 500 },
      ]
      const tpo2 = computeTpo(tape.slice(-win), { periodSec: 1800 })
      const edge2 = (side === 'up' ? tpo2.valueAreaHigh : tpo2.valueAreaLow) as number
      const closeNow = tape[tape.length - 1].close
      const dist = side === 'up' ? closeNow - edge2 : edge2 - closeNow
      const atrVal = lastOf(ta.atr(tape.map((c) => c.high), tape.map((c) => c.low), tape.map((c) => c.close), 14))
      const cur = dist / atrVal
      if (Math.abs(cur - targetAtrMult) < 0.03) break
      delta = Math.max(1e-7, delta * (targetAtrMult / Math.max(cur, 0.05)))
    }
    return tape
  }

  const fadeUp = excursionTape('up', 0.5)
  const f = evAt('tpo-fade', fadeUp)
  check('balance + close ~0.5 ATR above VAH fires PUT fade', f.direction === 'put', JSON.stringify(f))
  check('fade notes carry rotation count + ATR distance', /rotations/.test(f.notes) && /ATR beyond VAH/.test(f.notes), f.notes)
  const fadeDn = excursionTape('down', 0.5)
  const fd = evAt('tpo-fade', fadeDn)
  check('mirror excursion below VAL fires CALL fade', fd.direction === 'call', JSON.stringify(fd))

  const bigUp = excursionTape('up', 4)
  const big = evAt('tpo-fade', bigUp)
  check('4 ATR beyond VAH reads as breakout, stands aside', big.direction === 'none' && big.notes.includes('breakout'), JSON.stringify(big))

  const trend = evAt('tpo-fade', upTape, { window: 80 })
  check('monotonic trend tape: rotations gate blocks the fade', trend.direction === 'none' && trend.notes.includes('rotations'), JSON.stringify(trend))
  const strictRot = evAt('tpo-fade', fadeUp, { minRotations: 50 })
  check('minRotations=50 (unreachable) stands aside', strictRot.direction === 'none', JSON.stringify(strictRot))
  const d1 = evAt('tpo-fade', fadeUp)
  const d2 = evAt('tpo-fade', fadeUp)
  check('deterministic', JSON.stringify(d1) === JSON.stringify(d2))
}

// ============ 5. tick-regime ============
console.log('\n[tick-regime]')
{
  const a = 0.0002
  const alt = movesTape(Array.from({ length: 129 }, (_, i) => (i % 2 === 0 ? a : -a)))
  const same = movesTape(Array.from({ length: 129 }, () => a))
  // block pattern +a,+a,-a,-a repeated: exactly 50% same-sign pairs
  const fair = movesTape(Array.from({ length: 128 }, (_, i) => (Math.floor(i / 2) % 2 === 0 ? a : -a)).concat([a]))
  const flat = movesTape(Array.from({ length: 129 }, () => 0))

  const altEv = evAt('tick-regime', alt)
  // alt moves: +a,-a,... -> last move (index 128, even) is +a (UP);
  // anti-persistent tape fades it -> PUT
  check('alternating tape is ANTI-persistent -> fade the up-move (PUT)', altEv.direction === 'put' && altEv.notes.includes('ANTI-PERSISTENT'), JSON.stringify(altEv))
  const sameEv = evAt('tick-regime', same)
  check('same-sign tape is PERSISTENT -> continue (CALL)', sameEv.direction === 'call' && sameEv.notes.includes('PERSISTENT'), JSON.stringify(sameEv))
  const altDown = movesTape(Array.from({ length: 129 }, (_, i) => (i % 2 === 0 ? -a : a)))
  // altDown moves: -a,+a,... -> last move is -a (DOWN); fade -> CALL
  check('mirror alternating tape ending DOWN fades to CALL', evAt('tick-regime', altDown).direction === 'call', JSON.stringify(evAt('tick-regime', altDown)))
  const fairEv = evAt('tick-regime', fair)
  check('50/50 engineered tape reads fair-coin and stands aside', fairEv.direction === 'none' && fairEv.notes.includes('fair-coin'), JSON.stringify(fairEv))
  const flatEv = evAt('tick-regime', flat)
  check('flat tape stands aside (no pairs)', flatEv.direction === 'none', JSON.stringify(flatEv))
  check('warmup stands aside', evAt('tick-regime', alt.slice(0, 100)).direction === 'none')
  const strictZ = evAt('tick-regime', fair, { zMin: 0.5 })
  check('zMin 0.5 above the fair-coin |z|=0 stands aside', strictZ.direction === 'none', JSON.stringify(strictZ))
  check('anti-persistent score = 55 + |z|*8, clamped <= 92', altEv.score > 55 && altEv.score <= 92, `score=${altEv.score}`)
  check('notes disclose pseudo-tick source', altEv.notes.includes('pseudo-ticks'))
  const d1 = evAt('tick-regime', alt)
  const d2 = evAt('tick-regime', alt)
  check('deterministic', JSON.stringify(d1) === JSON.stringify(d2))
}

// ============ 6. ivhv-edge ============
console.log('\n[ivhv-edge]')
{
  const { ivFromPayout, realizedUpProb } = await import('../mini-services/trading-core/src/analytics/ivhv')
  check('breakeven math 0.85 -> 54.05%', Math.abs(ivFromPayout(0.85).breakevenPct - 54.05405405405405) < 1e-9)
  check('breakeven math 0.70 -> 58.82%', Math.abs(ivFromPayout(0.7).breakevenPct - 58.8235294117647) < 1e-9)

  const green = trendTape(130, true)
  const red = trendTape(130, false)
  const g = evAt('ivhv-edge', green)
  check('100% up-frequency clears breakeven -> CALL 92', g.direction === 'call' && g.score === 92, JSON.stringify(g))
  check('notes name the breakeven + live EV gate', g.notes.includes('breakeven') && g.notes.includes('EV gate'), g.notes)
  const r = evAt('ivhv-edge', red)
  check('0% up-frequency -> PUT 92', r.direction === 'put' && r.score === 92, JSON.stringify(r))

  // engineered 55% up over the last 100 bars
  const mixed: Candle[] = [...walk(3, 30, 60, 500, 1700000000 - 130 * 60)]
  for (let i = 0; i < 100; i++) {
    const greenBar = i % 20 < 11
    const o = 1.0 + (greenBar ? i * 0.00001 : 0)
    const c = greenBar ? o + 0.0005 : o - 0.0005
    mixed.push({ time: 1700000000 - 100 * 60 + i * 60, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: 500 })
  }
  check('realizedUpProb reads 55 on the engineered window', Math.abs(realizedUpProb(mixed, 100) - 55) < 1e-9, `u=${realizedUpProb(mixed, 100)}`)
  const m = evAt('ivhv-edge', mixed)
  check('55% up vs breakeven 54.05+5 margin -> no side clears, stands aside', m.direction === 'none', JSON.stringify(m))
  const mHighPayout = evAt('ivhv-edge', mixed, { payout: 2.0, margin: 0 })
  check('payout 2.0 lowers breakeven to 33.3% -> same tape fires CALL', mHighPayout.direction === 'call', JSON.stringify(mHighPayout))
  const strict = evAt('ivhv-edge', green, { margin: 15 })
  check('margin 15 vs max achievable edge 45.9 still fires (100-69.05)', strict.direction === 'call', JSON.stringify(strict))
  const warm = evAt('ivhv-edge', green.slice(0, 80))
  check('warmup stands aside (<window+2)', warm.direction === 'none')
  const badPay = evAt('ivhv-edge', green, { payout: 0 })
  check('payout 0 -> no breakeven, stands aside', badPay.direction === 'none', JSON.stringify(badPay))
  const d1 = evAt('ivhv-edge', green)
  const d2 = evAt('ivhv-edge', green)
  check('deterministic', JSON.stringify(d1) === JSON.stringify(d2))
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
