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
async function boot(ticksFor: (asset: string) => TickPoint[]) {
  process.chdir(mkdtempSync(join(tmpdir(), 'meta-tick-unit-')))
  const candles: import('../mini-services/trading-core/src/types').Candle[] = []
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
    use: (name: string) => (name === 'otcFootprint' ? ofpStub : name === 'nextexpiry' ? expSvc : market),
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

  console.log(`\nmetastrategy_tick_unit: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

void main()
