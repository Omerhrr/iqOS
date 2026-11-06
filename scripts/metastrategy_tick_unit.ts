// Meta Strategy tick-desk sources - deterministic logic unit (bun, in-process).
// Locks the contract added when the four Tick Desk engines became Meta
// Strategy condition sources (tickSmc/tickOracle/tickTechnical/tickFootprint):
//   - save() validation: tickBucketSec only on tick* sources, whole seconds
//     1..3600 (rounds 30.4 -> 30), non-tick sources rejected
//   - readSource: all four reads resolve off a synthetic rising tick stream
//     through evaluate() exactly like the panels render them (SMC call on an
//     uptrend, footprint delta read, technical summary read, oracle read)
//   - fail-closed: an asset with NO tick buffer reads 'none' on all four,
//     with honest warming labels - never a guessed direction
//   - pinned buckets: tickBucketSec 60 -> the label names the 1m bucket; a
//     bucket the feed's cadence can't support (1s buckets on ~1s prints)
//     reads none with the cadence note
//   - MSL: bare tickSmc/tickOracle/tickTechnical/tickFootprint keys plus the
//     pinned tickOracle:<SEC> keys work in testScript()
import { EventBus } from '../mini-services/trading-core/src/kernel'
import type { KernelContext } from '../mini-services/trading-core/src/kernel'
import { MetaStrategyService } from '../mini-services/trading-core/src/plugins/metastrategy'
import { NextExpiryService } from '../mini-services/trading-core/src/plugins/nextexpiry'
import type { TickPoint } from '../mini-services/trading-core/src/analytics/otcfootprint'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    pass++
    console.log('  ok', name)
  } else {
    fail++
    console.log('  FAIL', name, detail)
  }
}

// ---------- synthetic tick stream: 250ms prints (live-sidecar-like cadence),
// staircase uptrend - 2 buckets rising then a 1-bucket pullback, so the 15s
// tick candles form clean HH+HL swing structure for the tick-SMC read ----------
function makeTicks(nPrints: number, stepMs = 250): TickPoint[] {
  const now = Date.now()
  const t0 = now - nPrints * stepMs
  const out: TickPoint[] = []
  let p = 1.1
  for (let i = 0; i < nPrints; i++) {
    // cycle = 300 prints (75s = 5x15s buckets): 3 buckets up, 2 buckets
    // pulling back - deep enough that each leg top/pullback floor is a strict
    // 2-bucket fractal at bucket level -> real HH+HL swing structure
    const phase = i % 300
    p = Math.max(1e-6, p + (phase < 180 ? 0.0005 : -0.0002))
    out.push({ ts: t0 + i * stepMs, price: p })
  }
  return out
}

// ---------- boot one MetaStrategyService over a fake market + fake tick collector ----------
// `candles` (optional) feeds getCandlesDeep - the chart reads AND the MSL
// signal resolver run on it; `extra` (optional) maps service names to stubs
// so the whole-panel sources (technical/reversal/tempo/confluence/volArb/
// cointegration) can be exercised against their panel shapes.
async function boot(ticksFor: (asset: string) => TickPoint[], opts: { candles?: import('../mini-services/trading-core/src/types').Candle[]; extra?: Record<string, unknown> } = {}) {
  process.chdir(mkdtempSync(join(tmpdir(), 'meta-tick-unit-')))
  const candles = opts.candles ?? []
  const market = {
    mode: 'sim' as const,
    getCandlesDeep: () => candles,
    listAssets: () => [{ ticker: 'EURUSD', price: 1.1, open: true }],
    getPrice: () => 1.1,
  }
  const ofpStub = { ticksFor }
  const expSvc = new NextExpiryService()
  const metaSvc = new MetaStrategyService()
  const ctx = {
    bus: new EventBus(),
    services: new Map(),
    provide: () => {},
    use: (name: string) => (name === 'otcFootprint' ? ofpStub : name === 'nextexpiry' ? expSvc : opts.extra?.[name] ?? market),
    log: () => {},
  } as unknown as KernelContext
  await expSvc.start(ctx)
  await metaSvc.start(ctx)
  return metaSvc
}

async function main() {
  const ticks = makeTicks(3000)

  // ---------- 1. save() validation ----------
  {
    const svc = await boot(() => ticks)
    let rejected = ''
    try {
      svc.save({ name: 'bad bucket', mode: 'all', conditions: [{ source: 'oracle', direction: 'either', tickBucketSec: 60 }] })
    } catch (e) {
      rejected = (e as Error).message
    }
    ok(/tickBucketSec/.test(rejected), 'save() rejects tickBucketSec on a non-tick source (oracle)', rejected)
    let rejected2 = ''
    try {
      svc.save({ name: 'huge bucket', mode: 'all', conditions: [{ source: 'tickSmc', direction: 'either', tickBucketSec: 5000 }] })
    } catch (e) {
      rejected2 = (e as Error).message
    }
    ok(/1\.\.3600/.test(rejected2), 'save() rejects an out-of-range tickBucketSec (5000s)', rejected2)
    const saved = svc.save({
      name: 'tick driven',
      mode: 'any',
      conditions: [
        { source: 'tickSmc', direction: 'either', minConfidence: 0 },
        { source: 'tickOracle', direction: 'either', minConfidence: 0, tickBucketSec: 60 },
        { source: 'tickTechnical', direction: 'either', minConfidence: 0 },
        { source: 'tickFootprint', direction: 'either', minConfidence: 0 },
      ],
    })
    ok(saved.ok, 'save() accepts all four tick-desk conditions')
    ok(saved.spec.conditions.some((c) => c.tickBucketSec === 60), 'pinned tickBucketSec survives the save mapping')
    const rounded = svc.save({ name: 'rounding', mode: 'all', conditions: [{ source: 'tickFootprint', direction: 'either', tickBucketSec: 60.4 }] })
    ok(rounded.ok && rounded.spec.conditions[0]?.tickBucketSec === 60, 'tickBucketSec 60.4 rounds to whole 60', JSON.stringify(rounded.spec.conditions[0]))

    // ---------- 2. readSource through evaluate(): all four resolve ----------
    const ev = svc.evaluate(saved.id, 'EURUSD', '1m')
    ok(ev.result.conditions.length === 4, 'evaluate() resolves all four tick-desk conditions')
    const reads = Object.fromEntries(ev.result.conditions.map((c) => [c.condition.source, c.read]))
    const smc = reads.tickSmc
    ok(smc && (smc.direction === 'call' || smc.direction === 'put'), 'tickSmc read leans on an uptrend stream', smc?.label ?? 'missing')
    ok(smc && /prints\/bucket @15s/.test(smc.label), 'tickSmc label discloses prints/bucket + bucket length', smc?.label ?? '')
    const oracle = reads.tickOracle
    ok(oracle && /Tick oracle 1m/.test(oracle.label), 'pinned tickOracle:60 read names the 1m bucket', oracle?.label ?? '')
    const tech = reads.tickTechnical
    ok(tech && /tick technical/.test(tech.label), 'tickTechnical read resolves off the ladder', tech?.label ?? '')
    const fp = reads.tickFootprint
    ok(fp && (fp.direction === 'call' || fp.direction === 'put'), 'tickFootprint read leans with the net delta', fp?.label ?? '')
    ok(fp && /net delta [+-]?\d/.test(fp.label) && /u\/\d+d/.test(fp.label), 'tickFootprint label carries the measured delta split', fp?.label ?? '')
  }

  // ---------- 3. fail-closed: no tick buffer -> honest none everywhere ----------
  {
    const svc = await boot(() => [])
    const saved = svc.save({
      name: 'cold desk',
      mode: 'any',
      conditions: [
        { source: 'tickSmc', direction: 'either' },
        { source: 'tickOracle', direction: 'either' },
        { source: 'tickTechnical', direction: 'either' },
        { source: 'tickFootprint', direction: 'either' },
      ],
    })
    const ev = svc.evaluate(saved.id, 'EURUSD', '1m')
    const allNone = ev.result.conditions.every((c) => c.read.direction === 'none' && c.read.confidence === 0)
    ok(allNone, 'empty tick buffer -> every tick-desk read is a none read', JSON.stringify(ev.result.conditions.map((c) => [c.condition.source, c.read.direction, c.read.label])))
    ok(ev.result.direction === 'none', 'a cold desk never fires a direction', ev.result.direction)
  }

  // ---------- 4. pinned bucket the feed's cadence can't support ----------
  {
    // a ~1s print cadence cannot support 1s oracle buckets (median 1 print/
    // bucket < the 2-print floor) - the pinned read must stay none with the
    // cadence note, never a guess off a degenerate bucket
    const svc = await boot(() => makeTicks(500, 1000))
    const saved = svc.save({ name: 'too fast', mode: 'all', conditions: [{ source: 'tickOracle', direction: 'either', tickBucketSec: 1 }] })
    const ev = svc.evaluate(saved.id, 'EURUSD', '1m')
    const read = ev.result.conditions[0].read
    ok(read.direction === 'none' && /cadence|warming/.test(read.label), '1s buckets on a ~1s feed read none with the cadence/warming note', read.label)
  }

  // ---------- 5. MSL keys: bare sources + pinned tickOracle:<SEC> ----------
  {
    const svc = await boot(() => ticks)
    const t1 = svc.testScript('call when tickSmc.dir == call and tickFootprint.dir == call\nput when tickSmc.dir == put\nconfidence = avg(tickSmc.conf, tickFootprint.conf)', 'EURUSD', '1m')
    ok(t1.ok, 'MSL accepts bare tickSmc/tickFootprint sources', t1.error ?? '')
    const t2 = svc.testScript('let pinned = tickOracle:60\nlet ladder = tickTechnical:60\ncall when pinned.dir == call and ladder.dir != put\nput when pinned.dir == put\nconfidence = pinned.conf', 'EURUSD', '1m')
    ok(t2.ok, 'MSL accepts pinned tickOracle:60 / tickTechnical:60 keys', t2.error ?? '')
    // a source that does NOT exist must be a clean parse error, not a silent pass
    const t3 = svc.testScript('call when tickDeskFake.dir == call\nput when tickDeskFake.dir == put\nconfidence = 50', 'EURUSD', '1m')
    ok(!t3.ok, 'MSL rejects an unknown tick source cleanly', t3.error ?? '')
  }

  // ---------- 6. whole-OS panel sources: technical/reversal/tempo/confluence/volArb/cointegration ----------
  {
    // stubbed panel services returning their own documented shapes - a
    // script must be able to read ALL six exactly like the panels render
    const svc = await boot(() => ticks, {
      extra: {
        technical: { rowFor: () => ({ ok: true, note: '', direction: 'call', overall: { label: 'BUY', score: 0.4, buys: 12, sells: 4, neutrals: 3, counted: 19 } }) },
        reversal: { rowFor: () => ({ ok: true, note: '', state: 'reversing', direction: 'up', score: 4.2, best: { tf: '1m' } }) },
        tempo: { rowFor: () => ({ ok: true, note: '', decision: 'fire', decisionReason: 'license live', direction: 'put', conviction: 72.4, threshold: 55, barsRemaining: 3 }) },
        screener: { hasRow: () => true, evaluate: () => ({ direction: 'call', confidence: 68, score: 55.5, regime: 'bull', pUp: 0.62 }) },
        volArbScan: { scan: () => ({ ok: true, rows: [{ asset: 'EURUSD', open: true, ratio: 1.7, momentum: 0.3, regime: 'continue', direction: 'call' }] }) },
        cointegrationScan: { scan: () => ({ ok: true, rows: [{ asset: 'EURUSD', leader: 'GBPUSD', beta: 0.9, r2: 0.8, z: -2.3, direction: 'call' }] }) },
      },
    })
    const t = svc.testScript(
      'call when technical.dir == call and technical.value > 0.2\ncall when reversal.dir == call\ncall when tempo.dir == put and tempo.value > 50\ncall when confluence.dir == call\ncall when volArb.dir == call and volArb.value > 0.5\ncall when cointegration.dir == call and cointegration.value < 0\nput when technical.dir == put\nconfidence = avg(technical.conf, confluence.conf)',
      'EURUSD',
      '1m',
    )
    ok(t.ok, 'all six whole-panel sources resolve in one script (with .value thresholds)', t.error ?? '')
    // conditions form too
    const saved = svc.save({ name: 'panel soup', mode: 'any', conditions: [{ source: 'technical', direction: 'either' }, { source: 'reversal', direction: 'either' }, { source: 'tempo', direction: 'either' }, { source: 'confluence', direction: 'either' }, { source: 'volArb', direction: 'either' }, { source: 'cointegration', direction: 'either' }] })
    ok(saved.ok, 'all six accept the conditions[] form')
    const ev = svc.evaluate(saved.id, 'EURUSD', '1m')
    ok(ev.result.conditions.length === 6 && ev.result.conditions.every((c) => c.read.direction !== 'none'), 'all six reads resolve through evaluate() with their panel values', JSON.stringify(ev.result.conditions.map((c) => [c.condition.source, c.read.direction, c.read.value])))
    ok(ev.result.direction === 'call', 'the panel soup fires call (technical/tempo/confluence/cointegration legs agree, reversal up, volarb call)', `${ev.result.direction} ${ev.result.notes.slice(0, 120)}`)
  }

  // ---------- 7. whole-OS panel sources fail closed without their services ----------
  {
    const svc = await boot(() => ticks) // no panel stubs - ctx.use falls back to the market stub
    const saved = svc.save({ name: 'cold panels', mode: 'any', conditions: [{ source: 'technical', direction: 'either' }, { source: 'reversal', direction: 'either' }, { source: 'tempo', direction: 'either' }, { source: 'confluence', direction: 'either' }, { source: 'volArb', direction: 'either' }, { source: 'cointegration', direction: 'either' }] })
    const ev = svc.evaluate(saved.id, 'EURUSD', '1m')
    ok(ev.result.conditions.every((c) => c.read.direction === 'none' && c.read.confidence === 0), 'missing panel services -> every whole-panel read is a none read (never a crash, never a guess)', JSON.stringify(ev.result.conditions.map((c) => c.read.label)))
  }

  // ---------- 8. MSL signal vocabulary in META scripts (indicators + builtin strategies) ----------
  {
    // 240-bar rising candle series - enough for the resolver's 40-bar floor
    // and every indicator warmup it exercises
    const candles: import('../mini-services/trading-core/src/types').Candle[] = []
    const t0 = Math.floor(Date.now() / 1000) - 240 * 60
    for (let i = 0; i < 240; i++) {
      const open = 1.1 * Math.pow(1.0006, i)
      const close = 1.1 * Math.pow(1.0006, i + 1)
      candles.push({ time: t0 + i * 60, open, close, high: Math.max(open, close) + 0.0004, low: Math.min(open, close) - 0.0004, volume: 500 + (i % 9) * 10 })
    }
    const svc = await boot(() => ticks, { candles })
    const t = svc.testScript("call when indicator('rsi', '>', 0, call).active and oracle.conf >= 0\nput when indicator('rsi', '<', 0, put).active\nconfidence = 70", 'EURUSD', '1m')
    ok(t.ok && t.direction === 'call', 'indicator() resolves INSIDE a meta script off the pair candles (rsi > 0 fires on a rising series)', JSON.stringify({ ok: t.ok, dir: t.direction, err: t.error }))
    const bad = svc.testScript("call when indicator('nope', '>', 0, call).active\nput when indicator('rsi', '>', 99, put).active\nconfidence = 50", 'EURUSD', '1m')
    ok(!bad.ok && /valid:/.test(bad.error ?? ''), 'unknown indicator id fails with the friendly valid-ids error', bad.error ?? '')
    const adx = svc.testScript("call when indicatorType('adx', 'diff', '>', 0, call).active\nput when indicatorType('adx', 'adx', '>', 999, put).active\nconfidence = 60", 'EURUSD', '1m')
    ok(adx.ok && adx.direction === 'call', "the NEW adx family resolves (adx:diff > 0 on a rising series; adx:adx > 999 never fires)", JSON.stringify({ ok: adx.ok, dir: adx.direction, err: adx.error }))
    const builtin = svc.testScript("call when builtinSig('ema-trend', call).active\nput when builtinSig('ema-trend', put).active\nconfidence = 65", 'EURUSD', '1m')
    ok(builtin.ok && builtin.direction === 'call', "builtinSig() votes a whole builtin strategy inside a meta script (ema-trend call on a rising series)", JSON.stringify({ ok: builtin.ok, dir: builtin.direction, err: builtin.error }))
    const eng = svc.testScript("call when engine('renko', call).active\nput when engine('renko', put).active\nconfidence = 55", 'EURUSD', '1m')
    ok(eng.ok && eng.direction === 'call', "engine() votes a chart-engine committee inside a meta script (renko call on a rising series)", JSON.stringify({ ok: eng.ok, dir: eng.direction, err: eng.error }))
    // thin history: resolver absent -> the signal call fails the script closed
    const cold = await boot(() => ticks, { candles: [] })
    const thin = cold.testScript("call when indicator('rsi', '>', 0, call).active\nput when accute.put\nconfidence = 50", 'EURUSD', '1m')
    ok(!thin.ok && /unknown function/.test(thin.error ?? ''), 'no candles -> signal calls fail the script closed (no fake resolver)', thin.error ?? '')
  }

  // ---------- 9. configure: validation + real effect on the reads ----------
  {
    const candles: import('../mini-services/trading-core/src/types').Candle[] = []
    const t0 = Math.floor(Date.now() / 1000) - 240 * 60
    for (let i = 0; i < 240; i++) {
      const open = 1.1 * Math.pow(1.0006, i)
      const close = 1.1 * Math.pow(1.0006, i + 1)
      candles.push({ time: t0 + i * 60, open, close, high: Math.max(open, close) + 0.0004, low: Math.min(open, close) - 0.0004, volume: 500 + (i % 9) * 10 })
    }
    const svc = await boot(() => ticks, { candles })
    // save-time static validation: unknown key + unknown strategy id rejected
    let rejected = ''
    try {
      svc.save({ name: 'bad knob', mode: 'all', script: "configure renko.wrongKnob = 1\ncall when renko.dir == call\nput when renko.dir == put\nconfidence = 50" })
    } catch (e) {
      rejected = (e as Error).message
    }
    ok(/unknown key/.test(rejected), 'save() rejects an unknown configure key statically', rejected)
    let rejected2 = ''
    try {
      svc.save({ name: 'bad strat', mode: 'all', script: "configure strategy.no-such-strategy.fast = 5\ncall when oracle.call\nput when oracle.put\nconfidence = 50" })
    } catch (e) {
      rejected2 = (e as Error).message
    }
    ok(/unknown builtin strategy/.test(rejected2), 'save() rejects configure strategy.<unknown id>', rejected2)
    const saved = svc.save({ name: 'configured', mode: 'all', script: "configure renko.atrMult = 0.05\nconfigure pf.reversalBoxes = 5\nconfigure strategy.ema-trend.fast = 4\ncall when renko.dir == call\nput when renko.dir == put\nconfidence = clamp(renko.value, 10, 100)" })
    ok(saved.ok, 'save() accepts a script configuring chart knobs + a real strategy param', '')
    // the configured read actually differs: renko.value (signed streak) at a
    // tiny brick multiplier is LONGER than at the default
    const configured = svc.testScript("call when renko.dir == call\nput when renko.dir == put\nconfidence = clamp(abs(renko.value), 1, 100)", 'EURUSD', '1m')
    const configuredFine = svc.testScript("configure renko.atrMult = 0.05\ncall when renko.dir == call\nput when renko.dir == put\nconfidence = clamp(abs(renko.value), 1, 100)", 'EURUSD', '1m')
    const configuredCoarse = svc.testScript("configure renko.atrMult = 10\ncall when renko.dir == call\nput when renko.dir == put\nconfidence = clamp(abs(renko.value), 1, 100)", 'EURUSD', '1m')
    ok(configuredFine.ok && configuredCoarse.ok, 'both configured scripts evaluate', `${configuredFine.error ?? ''} / ${configuredCoarse.error ?? ''}`)
    ok(configuredFine.confidence !== configuredCoarse.confidence, `configure renko.atrMult CHANGES the read (fine-brick streak ${configuredFine.confidence} != coarse-brick streak ${configuredCoarse.confidence})`)
    ok(configured.confidence === configuredFine.confidence, 'the saved spec (configured atrMult 0.05) evaluates the same as the equivalent dry-run')
    // out-of-range value: rejected at EVAL time even though the path is valid
    const oor = svc.testScript("configure pf.reversalBoxes = 99\ncall when renko.dir == call\nput when renko.dir == put\nconfidence = 50", 'EURUSD', '1m')
    ok(!oor.ok && /1\.\.10/.test(oor.error ?? ''), 'out-of-range configure value fails the script closed at eval', oor.error ?? '')
  }

  // ---------- 10. expiry statement surfaces through testScript ----------
  {
    const candles: import('../mini-services/trading-core/src/types').Candle[] = []
    const t0 = Math.floor(Date.now() / 1000) - 240 * 60
    for (let i = 0; i < 240; i++) {
      const open = 1.1 * Math.pow(1.0006, i)
      const close = 1.1 * Math.pow(1.0006, i + 1)
      candles.push({ time: t0 + i * 60, open, close, high: Math.max(open, close) + 0.0004, low: Math.min(open, close) - 0.0004, volume: 500 })
    }
    const svc = await boot(() => ticks, { candles })
    const t = svc.testScript("call when engine('renko', call).active\nput when engine('renko', put).active\nconfidence = 60\nexpiry = 2.4", 'EURUSD', '1m')
    ok(t.ok && t.expiryMin === 2, 'expiry = 2.4 rounds to expiryMin 2 in testScript', JSON.stringify({ ok: t.ok, exp: t.expiryMin, err: t.error }))
    const noSide = svc.testScript("call when renko.value > 999\nput when renko.value < -999\nconfidence = 50\nexpiry = 5", 'EURUSD', '1m')
    ok(noSide.ok && noSide.expiryMin === undefined, 'no side fired -> no expiryMin (fires-only contract through the plugin)')
  }

  console.log(`\nmetastrategy_tick_unit: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

void main()
