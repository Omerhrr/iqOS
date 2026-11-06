// Tick Desk selftest - the tick-chart engines (tickCandles / Tick SMC /
// Tick Oracle / Tick Technical / Tick Footprint). Pure-math property checks,
// no kernel needed. Everything derives from SYNTHETIC tick streams built to
// known shapes, so each assertion pins an honest behavior:
//   - tickCandles: bucket boundaries, up/dn print counts, forming-bucket
//     exclusion, median prints-per-candle
//   - Tick SMC: an engineered rally-pullback-breakout tape reads trend 'up'
//     with a bull BOS and a 'call' lean; thin buffers say "warming up"
//   - Tick Oracle: trending tape fires a call on workable buckets, the 1s/2s
//     buckets on a ~1s feed are cadence-gated (honest refusal), walk-forward
//     evidence appears once enough buckets exist
//   - Tick Technical: enough tick buckets -> oscillators+MAs vote and the
//     ladder aggregates; short windows say "warming up" and skip lists name
//     the missing windows
//   - Tick Footprint: bins carry the MEASURED up/down print counts (not a
//     proxy), delta sums, POC exists, first in-window print's direction is
//     measured from the last pre-window print (never guessed)
// Run: bun scripts/tickdesk_selftest.ts  (from the repo root)

import {
  computeTickFootprint,
  computeTickOracle,
  computeTickSmc,
  computeTickTechnical,
  tickCandles,
} from '../mini-services/trading-core/src/analytics/tickdesk'
import type { TickPoint } from '../mini-services/trading-core/src/analytics/otcfootprint'

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

// ---------- tape builders ----------

/** Deterministic 1-print-per-second tape with a drift per phase (every print
 * is a price CHANGE - the collector's contract). */
function tape(phases: { prints: number; step: number }[], t0Ms = 1_700_000_000_000, p0 = 1.1): TickPoint[] {
  const out: TickPoint[] = []
  let price = p0
  let ts = t0Ms
  for (const ph of phases) {
    for (let i = 0; i < ph.prints; i++) {
      price = Math.max(0.01, price + ph.step)
      out.push({ ts, price })
      ts += 1000
    }
  }
  return out
}

/** Zigzag tape: alternates runs of up/down prints (gives swings + sweeps). */
function zigzag(runs: { prints: number; step: number }[], t0Ms = 1_700_000_000_000, p0 = 2.0): TickPoint[] {
  const out: TickPoint[] = []
  let price = p0
  let ts = t0Ms
  for (const run of runs) {
    for (let i = 0; i < run.prints; i++) {
      price = Math.max(0.01, price + run.step)
      out.push({ ts, price })
      ts += 1000
    }
  }
  return out
}

const EPS = 1e-9
const closeTo = (a: number, b: number, eps = EPS) => Math.abs(a - b) <= eps

const NOW_MS = 1_700_000_000_000 + 400 * 1000 // after all tapes below

// ============ 1. tickCandles ============
console.log('\n[tickcandles]')
{
  // 12 prints at 1s cadence into 5s buckets -> 3 closed buckets (+1 forming
  // bucket pinned by nowMs)
  const t: TickPoint[] = []
  let price = 1.0
  for (let i = 0; i < 12; i++) {
    price += i % 2 === 0 ? 0.001 : -0.0005 // alternating pressure
    t.push({ ts: 1_700_000_000_000 + i * 1000, price })
  }
  const nowMs = 1_700_000_000_000 + 13 * 1000 // inside the 4th bucket
  const r = tickCandles(t, 5, nowMs)
  check('bucket count (closed only, forming excluded)', r.closed.length === 2, `closed=${r.closed.length}`)
  check('forming bucket present', r.forming !== null)
  check('bucket start is bucket-aligned', r.closed[0].time === Math.floor(1_700_000_000_000 / 5000) * 5)
  // prints i=0..4: +0.001,-0.0005,+0.001,-0.0005,+0.001 -> o 1.001 / h 1.002 / l 1.0005 / c 1.002
  check(
    'ohlc of bucket 0',
    r.closed[0].open === 1.001 &&
      closeTo(r.closed[0].high, 1.002) &&
      r.closed[0].low === 1.0005 &&
      closeTo(r.closed[0].close, 1.002),
    JSON.stringify(r.closed[0]),
  )
  // the FIRST-EVER print carries no direction (nothing before it) -> 2u/2d, not 3u/2d
  check('up/dn counts of bucket 0 (first print has no direction)', r.closed[0].upTicks === 2 && r.closed[0].dnTicks === 2, `${r.closed[0].upTicks}u/${r.closed[0].dnTicks}d`)
  check('ticks sum == closed prints (forming excluded)', r.closed.reduce((s, c) => s + c.ticks, 0) === 10, `${r.closed.reduce((s, c) => s + c.ticks, 0)}`)
  // no prints near now -> nothing forming
  const r2 = tickCandles(t, 5, 1_700_000_000_000 + 600 * 1000)
  check('stale feed: everything closed, forming null', r2.forming === null && r2.closed.length === 3)
  check('med prints/candle', r.medTicksPerCandle === 5, `${r.medTicksPerCandle}`)
}

// ============ 2. Tick SMC ============
console.log('\n[tick smc]')
{
  // Bucket-aligned tape (t0 lands exactly on a 15s bucket boundary) so each
  // phase is whole buckets: leg 1 up (4 buckets) -> pullback (2) -> leg 2 up
  // (3) -> pullback (2) -> breakout leg (3). Two HH/HL pairs (trend 'up'
  // needs TWO swing highs + TWO swing lows) then a close beyond the last
  // swing high -> bull BOS. Fractal swings need 2 full pullback buckets,
  // which is why the pullbacks are 30 prints, not 15.
  const SMC_T0 = 1_700_000_010_000 // 1700000010s = exactly divisible by 15
  const SMC_NOW = SMC_T0 + 400 * 1000
  const t = zigzag(
    [
      { prints: 60, step: 0.00003 },  // leg 1 up -> swing high H1
      { prints: 30, step: -0.00004 }, // pullback -> higher low HL1
      { prints: 45, step: 0.00003 },  // leg 2 up -> swing high H2 > H1
      { prints: 30, step: -0.00004 }, // pullback -> higher low HL2 > HL1
      { prints: 45, step: 0.00003 },  // breakout leg (closes beyond H2)
    ],
    SMC_T0,
  )
  const smc = computeTickSmc(t, { bucketSec: 15, nowMs: SMC_NOW })
  check('ok on a 210-print structured tape', smc.ok === true, smc.note ?? '')
  check('trend reads up (HH+HL twice)', smc.trend === 'up', smc.trend)
  check('bull BOS detected', smc.bos !== null && smc.bos.dir === 'bull', JSON.stringify(smc.bos))
  check('no CHoCH against an up trend', smc.choch === null, JSON.stringify(smc.choch))
  check('direction leans call with confidence', smc.direction === 'call' && smc.confidence > 0, `${smc.direction} ${smc.confidence}`)
  check('reasons carry evidence', smc.reasons.length >= 2, smc.reasons.join(' | '))
  check('price is the last print', smc.price === t[t.length - 1].price)

  // mirrored tape: LH/LL twice, then a breakdown leg
  const t2 = zigzag(
    [
      { prints: 60, step: -0.00003 },
      { prints: 30, step: 0.00004 },
      { prints: 45, step: -0.00003 },
      { prints: 30, step: 0.00004 },
      { prints: 45, step: -0.00003 },
    ],
    SMC_T0,
  )
  const smc2 = computeTickSmc(t2, { bucketSec: 15, nowMs: SMC_NOW })
  check('bear mirror: trend down', smc2.trend === 'down', smc2.trend)
  check('bear mirror: bear BOS', smc2.bos !== null && smc2.bos.dir === 'bear')
  check('bear mirror: direction put', smc2.direction === 'put', smc2.direction)

  // thin tape: fewer than 12 closed buckets -> honest warming-up
  const thin = tape([{ prints: 10, step: 0.00003 }])
  const smc3 = computeTickSmc(thin, { bucketSec: 15, nowMs: NOW_MS })
  check('thin tape: not ok', smc3.ok === false)
  check('thin tape: warming note names the deficit', (smc3.note ?? '').includes('warming up'), smc3.note ?? '')

  // flat tape: jitter around one level -> ok but no strong conviction
  const flat: TickPoint[] = []
  let fp = 1.5
  for (let i = 0; i < 300; i++) {
    fp += i % 4 === 0 ? 0.00001 : -0.00001
    flat.push({ ts: 1_700_000_000_000 + i * 1000, price: fp })
  }
  const smc4 = computeTickSmc(flat, { bucketSec: 15, nowMs: NOW_MS })
  check('flat tape: ok but weak/absent lean', smc4.ok === true && (smc4.direction === 'none' || smc4.confidence <= 92), `${smc4.direction} ${smc4.confidence}`)
}

// ============ 3. Tick Oracle ============
console.log('\n[tick oracle]')
{
  const t = tape([
    { prints: 120, step: 0.00003 },
    { prints: 40, step: -0.00002 },
    { prints: 80, step: 0.00004 },
  ])
  const r = computeTickOracle(t, { nowMs: NOW_MS })
  check('ladder covers 1s..5m', r.rows.length === 10 && r.rows[0].label === '1s' && r.rows[9].label === '5m', r.rows.map((x) => x.label).join(','))
  // 1s cadence feed: a 1s bucket holds ~1 print per candle -> cadence-gated
  const one = r.rows.find((x) => x.label === '1s')
  check('1s bucket cadence-gated on a ~1s feed', one !== undefined && !one.ok && (one.note ?? '').includes('cadence'), one?.note ?? '')
  // 2s buckets hold ~2 prints/candle - thin but each carries a direction, so
  // the gate (median < 2) lets it vote
  const two = r.rows.find((x) => x.label === '2s')
  check('2s bucket workable at ~2 prints/candle', two !== undefined && two.ok === true, two?.note ?? '')
  // 5m buckets: 4 minutes of tape -> warming up
  const five = r.rows.find((x) => x.label === '5m')
  check('5m bucket warming up (only 4 min of tape)', five !== undefined && !five.ok && (five.note ?? '').includes('warming'), five?.note ?? '')
  // workable buckets (5s/15s/30s/1m/2m/3m) vote
  const workable = r.rows.filter((x) => x.ok)
  check('workable buckets exist', workable.length >= 3, `${workable.length}`)
  check('a workable bucket leans call on the breakout tape', workable.some((x) => x.direction === 'call'), workable.map((x) => `${x.label}:${x.direction}`).join(','))
  check('walk-forward evidence present on enough history', workable.some((x) => x.wf && x.wf.n >= 10), workable.map((x) => `${x.label}:wf=${x.wf?.n ?? 0}`).join(','))
  check('wf hit rate within 0..100', workable.every((x) => !x.wf || x.wf.hitRatePct === null || (x.wf.hitRatePct >= 0 && x.wf.hitRatePct <= 100)))
  check('best picks the strongest qualified read', r.best !== null && r.best.direction !== 'none', r.best ? `${r.best.label} ${r.best.direction}` : 'none')
  // thin tape: nothing workable anywhere
  const thin = tape([{ prints: 8, step: 0.00003 }])
  const r2 = computeTickOracle(thin, { nowMs: NOW_MS })
  check('thin tape: ok=false with note', r2.ok === false && (r2.note ?? '').length > 0)
  check('thin tape: best null (fail-closed)', r2.best === null)
}

// ============ 4. Tick Technical ============
console.log('\n[tick technical]')
{
  // 4 minutes at 1s cadence; 5s buckets -> 47 closed buckets (enough for the
  // full oscillator set, too few for SMA/EMA 100/200 -> skipped lists)
  const t = tape([
    { prints: 100, step: 0.00004 },
    { prints: 60, step: -0.00005 },
    { prints: 100, step: 0.00005 },
    { prints: 100, step: -0.00003 },
  ])
  const r = computeTickTechnical(t, { detailBucketSec: 5, nowMs: NOW_MS })
  check('ok with at least one bucket computable', r.ok === true)
  const d5 = r.buckets.find((b) => b.bucketSec === 5)
  check('5s bucket computable', d5 !== undefined && d5.ok === true)
  check('detail table populated', r.detail.ok === true && r.detail.rows.length >= 10, `${r.detail.rows.length} rows`)
  check('oscillators present in detail', r.detail.rows.some((x) => x.group === 'osc' && x.name === 'RSI(14)'))
  check('moving averages present in detail', r.detail.rows.some((x) => x.group === 'ma' && x.name === 'SMA(10)'))
  check('MA(200) honestly skipped on thin tick history', r.detail.skipped.some((x) => x.includes('SMA/EMA(200)')), r.detail.skipped.join(' | '))
  check('votes are only buy/sell/neutral', r.detail.rows.every((x) => ['buy', 'sell', 'neutral'].includes(x.vote)))
  const d5b = r.buckets.find((b) => b.bucketSec === 5)
  check('ladder aggregates votes', d5b !== undefined && d5b.summary.buy + d5b.summary.sell + d5b.summary.neutral === r.detail.rows.length, `${d5b?.summary.buy}+${d5b?.summary.sell}+${d5b?.summary.neutral} vs ${r.detail.rows.length}`)
  // 5m detail: only 4 closed buckets -> warming
  const r2 = computeTickTechnical(t, { detailBucketSec: 300, nowMs: NOW_MS })
  check('5m detail warming up', r2.detail.ok === false && (r2.detail.note ?? '').includes('warming'), r2.detail.note ?? '')
  // rule disclosure rides on the response
  check('aggregation rule disclosed', r.rule.includes('net = (buy - sell)'))
}

// ============ 5. Tick Footprint ============
console.log('\n[tick footprint]')
{
  // bucketSec 10; one pre-window print seeds direction of the first window print
  const t: TickPoint[] = []
  let price = 1.0
  // pre-window: 3 prints (10s) so the window doesn't include them
  for (let i = 0; i < 3; i++) {
    price += 0.001
    t.push({ ts: 1_700_000_000_000 + i * 1000, price })
  }
  // window: 20 prints rising in a tight band then falling
  for (let i = 0; i < 20; i++) {
    price += i < 12 ? 0.0005 : -0.0006
    t.push({ ts: 1_700_000_000_030_000 + i * 1000, price })
  }
  const nowMs = 1_700_000_000_060_000
  const r = computeTickFootprint(t, { bucketSec: 10, bins: 4, maxBuckets: 10, nowMs })
  check('ok with closed buckets', r.ok === true && r.candles.length >= 1, `${r.candles.length}`)
  check('buckets are 10s', r.bucketSec === 10)
  // measured totals: 3 pre-window + 20 in-window prints; the FIRST-EVER print
  // has no predecessor so it carries no direction -> 14u/8d of 22 carriers
  check('total up/dn measured (14u/8d)', r.summary.totalUp === 14 && r.summary.totalDn === 8, `${r.summary.totalUp}u/${r.summary.totalDn}d`)
  check('net delta = up - dn', r.summary.netDelta === r.summary.totalUp - r.summary.totalDn)
  check('POC exists per candle', r.candles.every((c) => c.poc !== null))
  check('bins carry imbalances only on >=4 prints', r.candles.every((c) => c.rows.every((x) => x.imbalance === null || x.up + x.dn >= 4)))
  const sumDelta = r.candles.reduce((s, c) => s + c.delta, 0)
  check('per-candle delta sums to window delta', sumDelta === r.summary.netDelta, `${sumDelta} vs ${r.summary.netDelta}`)
  // dominant POC exists once 2+ candles share a POC level or at least one exists
  check('dominant POC present', r.summary.dominantPoc !== null)
  // empty buffer -> honest note
  const r2 = computeTickFootprint([], { bucketSec: 10, nowMs: NOW_MS })
  check('empty buffer: not ok with note', r2.ok === false && (r2.note ?? '').length > 0)
}

console.log(`\n=== tickdesk selftest: ${pass} pass / ${fail} fail ===`)
if (fail > 0) process.exit(1)
