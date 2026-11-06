// Next-Expiry Oracle - deterministic logic unit (bun, in-process).
// Locks the contract added with the new panel (analytics/nextexpiry.ts +
// plugins/nextexpiry.ts):
//   - fail-closed: <720 closed 1m bars -> null; non-1m base series -> null;
//     a NaN tail candle -> null (the route then reports "needs N+ bars")
//   - ladder shape: always 5 rows, expiries [1,2,3,5,15] ascending, with
//     ok:false "warming up" rows for horizons whose models are thin
//   - numeric grounding: every emitted pUp/pWin/confidence/edge/expectedMove
//     is finite and inside its band (pWin in [0.5,1], conf in [0,97])
//   - window anchoring: row.targetBarTime = last closed bar time + E*60s
//     (the 1m bar whose close is exactly E minutes after entry)
//   - honesty plumbing: a bad calibration record DISCOUNTS the confidence
//     vs raw; a good one boosts it; the plugin resolves a pending window
//     when its anchor 1m candle closes and the per-(asset,expiry) record
//     then feeds back
//   - best pick: either null (honest "wait") or a row clearing both the
//     pWin floor (>= 0.56) and the confidence floor (>= 25)
import { EventBus } from '../mini-services/trading-core/src/kernel'
import type { KernelContext } from '../mini-services/trading-core/src/kernel'
import { EXPIRIES_MIN, EXPIRY_ORACLE_MIN_CANDLES, predictNextExpiry } from '../mini-services/trading-core/src/analytics/nextexpiry'
import { NextExpiryService } from '../mini-services/trading-core/src/plugins/nextexpiry'
import { MetaStrategyService } from '../mini-services/trading-core/src/plugins/metastrategy'
import type { Candle } from '../mini-services/trading-core/src/types'
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

// ---------- deterministic candle builders ----------
const walk = (n: number, seed = 11, p0 = 1.2, drift = 0): Candle[] => {
  let s = seed >>> 0
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 // deterministic 0..1
  }
  const baseTs = Math.floor(Date.now() / 60000) * 60000 - n * 60000
  const out: Candle[] = []
  let p = p0
  for (let i = 0; i < n; i++) {
    // small alternating noise so step variance never collapses to 0
    const shock = (rnd() - 0.5) * 0.004 + (i % 2 === 0 ? drift : drift * 0.2)
    const o = p
    p = Math.max(1e-6, p * (1 + shock))
    const hi = Math.max(o, p) * (1 + rnd() * 0.0008)
    const lo = Math.min(o, p) * (1 - rnd() * 0.0008)
    out.push({ time: baseTs + i * 60, open: o, high: hi, low: lo, close: p, volume: 100 + rnd() * 50 })
  }
  return out
}

const withNaN = (candles: Candle[]): Candle[] => {
  const c = candles.slice()
  const last = { ...c[c.length - 1] }
  last.close = NaN
  c[c.length - 1] = last
  return c
}

const spacedAs = (candles: Candle[], sec: number): Candle[] =>
  candles.map((c, i) => ({ ...c, time: candles[0].time + i * sec }))

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// ---------- 1. fail-closed gates ----------
{
  const thin = walk(EXPIRY_ORACLE_MIN_CANDLES - 1)
  ok(predictNextExpiry(thin, { asset: 'EURUSD', mode: 'sim' }) === null, 'fail-closed: <720 closed 1m bars -> null')
  const full = walk(EXPIRY_ORACLE_MIN_CANDLES + 300)
  ok(predictNextExpiry(spacedAs(full, 300), { asset: 'EURUSD', mode: 'sim' }) === null, 'fail-closed: non-1m base series refused (5m spacing -> null)')
  ok(predictNextExpiry(withNaN(full), { asset: 'EURUSD', mode: 'sim' }) === null, 'fail-closed: NaN tail candle -> null')
}

// ---------- 2. healthy read: ladder shape + grounding ----------
{
  const pred = predictNextExpiry(walk(EXPIRY_ORACLE_MIN_CANDLES + 300, 23, 1.2, 0.00002), { asset: 'EURUSD-OTC', mode: 'sim' })
  ok(pred !== null, 'healthy read produced')
  if (pred) {
    ok(pred.rows.length === 5, 'ladder has exactly 5 rows', `got ${pred.rows.length}`)
    ok(pred.rows.map((r) => r.expiry).join(',') === EXPIRIES_MIN.join(','), 'expiries are 1/2/3/5/15 ascending')
    ok(finite(pred.price) && pred.price > 0, 'spot finite + positive')
    ok(['TRENDING', 'RANGING', 'VOLATILE', 'MIXED'].includes(pred.regime), 'regime is one of the 4 kernel regimes', pred.regime)
    ok(['ASIA', 'LONDON', 'OVERLAP', 'NEWYORK', 'OFF', 'OTC'].includes(pred.session), 'session is one of the 6 buckets', pred.session)
    const lastT = EXPIRY_ORACLE_MIN_CANDLES + 300 - 1
    const baseTs = Math.floor(Date.now() / 60000) * 60000 - (lastT + 1) * 60000
    const anchored = pred.rows.every((r) => r.targetBarTime === baseTs + (lastT) * 60 + r.expiry * 60)
    ok(anchored, 'targetBarTime = last closed bar + E*60 for every row')
    let grounded = true
    let bandOk = true
    for (const r of pred.rows) {
      for (const v of [r.pUp, r.pWin, r.confidence, r.rawConfidence, r.edge, r.expectedMove, r.cone.low, r.cone.high]) {
        if (!finite(v)) grounded = false
      }
      if (r.pWin < 0.5 || r.pWin > 1) bandOk = false
      if (r.ok && (r.confidence < 0 || r.confidence > 97)) bandOk = false
      if (r.ok && !['call', 'put', 'none'].includes(r.direction)) bandOk = false
      if (!r.ok && r.direction !== 'none') bandOk = false
    }
    ok(grounded, 'every emitted row number is finite')
    ok(bandOk, 'pWin/confidence bands + warming rows never carry a direction')
    // best pick invariant: null, or clears BOTH floors
    const b = pred.best
    ok(b === null || (b.pWin >= 0.56 && b.confidence >= 25 && ['call', 'put'].includes(b.direction)), 'best pick floors enforced (or honest null)')
    // note exists and is plain language
    ok(typeof pred.note === 'string' && pred.note.length > 0, 'plain-language note present')
  }
}

// ---------- 3. honesty plumbing: calibration discount ----------
{
  const candles = walk(EXPIRY_ORACLE_MIN_CANDLES + 300, 31, 0.65, 0.00001)
  const plain = predictNextExpiry(candles, { asset: 'GBPUSD', mode: 'sim' })
  const discounted = predictNextExpiry(candles, { asset: 'GBPUSD', mode: 'sim', calibrations: { '1': { n: 50, hitRate: 0.4, brier: 0.3 }, '5': { n: 50, hitRate: 0.4, brier: 0.3 } } })
  const boosted = predictNextExpiry(candles, { asset: 'GBPUSD', mode: 'sim', calibrations: { '1': { n: 60, hitRate: 0.68, brier: 0.18 }, '5': { n: 60, hitRate: 0.68, brier: 0.18 } } })
  ok(plain !== null && discounted !== null && boosted !== null, 'all three calibration variants produced')
  if (plain && discounted && boosted) {
    const badRows = discounted.rows.filter((r) => (r.expiry === 1 || r.expiry === 5) && r.ok && r.rawConfidence > 0)
    const goodRows = boosted.rows.filter((r) => (r.expiry === 1 || r.expiry === 5) && r.ok && r.rawConfidence > 0)
    const badDiscounted = badRows.length > 0 && badRows.every((r) => r.confidence < r.rawConfidence)
    const goodBoosted = goodRows.length > 0 && goodRows.every((r) => r.confidence >= r.rawConfidence)
    ok(badDiscounted, 'a bad record (40% hit, 0.30 Brier) discounts confidence below raw', JSON.stringify(badRows.map((r) => [r.expiry, r.rawConfidence, r.confidence])))
    ok(goodBoosted, 'a good record (68% hit, 0.18 Brier) never discounts below raw', JSON.stringify(goodRows.map((r) => [r.expiry, r.rawConfidence, r.confidence])))
    // thin record is no record: n < 20 changes nothing
    const thinCal = predictNextExpiry(candles, { asset: 'GBPUSD', mode: 'sim', calibrations: { '1': { n: 5, hitRate: 0.1, brier: 0.45 } } })
    const thinSame = thinCal !== null && thinCal.rows.every((r) => r.expiry !== 1 || r.calibration?.n === 5)
    ok(thinSame, 'thin records are carried through untouched (n<20 = no discount engine-side)')
  }
}

// ---------- 4. learned driver weights accepted + per-expiry scoping ----------
{
  const candles = walk(EXPIRY_ORACLE_MIN_CANDLES + 300, 41, 1.5, -0.00002)
  const withLearned = predictNextExpiry(candles, {
    asset: 'USDJPY',
    mode: 'sim',
    driverWeightMultipliers: { '3': { 'Markov H-E': 1.4, 'VR momentum': 0.7 }, '15': { 'OU half-life': 1.3 } },
  })
  ok(withLearned !== null, 'learned driver-weight tables accepted')
  if (withLearned) {
    let grounded = true
    for (const r of withLearned.rows) for (const d of r.drivers) if (!finite(d.pUp) || !finite(d.weight) || d.weight <= 0) grounded = false
    ok(grounded, 'driver reads stay finite + positive-weighted under learned tables')
  }
}

// ---------- 5. plugin honesty loop end-to-end (fake market, real bus) ----------
{
  const candles = walk(EXPIRY_ORACLE_MIN_CANDLES + 300, 51, 1.1, 0.00003)
  const market = {
    mode: 'sim' as const,
    getCandlesDeep: () => candles,
    listAssets: () => [{ ticker: 'EURUSD', price: candles[candles.length - 1].close, open: true }],
  }
  const bus = new EventBus()
  const ctx = {
    bus,
    services: new Map(),
    provide: () => {},
    use: () => market,
    log: () => {},
  } as unknown as KernelContext
  const svc = new NextExpiryService()
  // isolate the plugin's persistence: the service resolves data/ against
  // process.cwd() at call time - without this, THIS test's own previous run
  // (or the live kernel's file) would be restored here and the ledger
  // deltas below would count stale rows
  process.chdir(mkdtempSync(join(tmpdir(), 'nextexpiry-unit-')))
  await svc.start(ctx)
  const pred = svc.predict('EURUSD')
  ok(pred !== null, 'plugin predict() produced through the fake market')
  const actionable = pred ? pred.rows.filter((r) => r.ok && r.direction !== 'none') : []
  const stats0 = svc.stats()
  ok(stats0.pending === actionable.length, `pending ledger holds exactly the actionable windows (${stats0.pending}/${actionable.length})`)
  if (pred && actionable.length > 0) {
    const target = actionable[0]
    // emit the anchor candle close -> resolution
    bus.emit('candle', { asset: 'EURUSD', tf: '1m', closed: true, candle: { time: target.targetBarTime, open: pred.price, high: pred.price * 1.001, low: pred.price * 0.999, close: target.direction === 'call' ? pred.price * 1.002 : pred.price * 0.998, volume: 10 } })
    const stats1 = svc.stats()
    ok(stats1.pending === stats0.pending - 1, 'anchor close resolves exactly one pending window')
    ok(stats1.total === stats0.total + 1, 'resolved ledger grew by exactly one', `total ${stats0.total} -> ${stats1.total}`)
    ok(stats1.recent.length === 1 && stats1.recent[0].asset === 'EURUSD' && stats1.recent[0].expiry === target.expiry, 'resolution carries asset + expiry')
    const hitExpected = target.direction === 'call'
    ok(stats1.recent[0].hit === hitExpected, 'win/loss classified from the realized close direction')
    ok(finite(stats1.recent[0].brier) && stats1.recent[0].brier >= 0 && stats1.recent[0].brier <= 1, 'Brier contribution finite in [0,1]')
    const cal = svc.calibrationFor('EURUSD', target.expiry)
    ok(cal !== null && cal.n === 1, 'per-(asset,expiry) record now non-null (feeds next confidence)')
    // wrong-tf and non-anchored events resolve nothing
    bus.emit('candle', { asset: 'EURUSD', tf: '5m', closed: true, candle: { time: (actionable[0].targetBarTime ?? 0) + 300, open: 1, high: 1, low: 1, close: 1, volume: 0 } })
    bus.emit('candle', { asset: 'GBPUSD', tf: '1m', closed: true, candle: { time: target.targetBarTime, open: 1, high: 1, low: 1, close: 1, volume: 0 } })
    const stats2 = svc.stats()
    ok(stats2.total === 1, 'non-1m / other-asset closes never resolve foreign windows')
    // expirySummary covers the whole ladder
    ok(stats2.expirySummary.length === 5 && stats2.expirySummary.map((s) => s.expiry).join(',') === '1,2,3,5,15', 'stats expirySummary spans the full ladder')
  }
  svc.stop()
}

// ---------- 6. globalScan: board sort, TTL cache, refresh, warming rows ----------
{
  // isolate persistence for this service too (fresh temp dir #2)
  process.chdir(mkdtempSync(join(tmpdir(), 'nextexpiry-unit-')))
  const mk = (seed: number, drift: number) => walk(EXPIRY_ORACLE_MIN_CANDLES + 300, seed, 1.2, drift)
  const series: Record<string, Candle[]> = {
    EURUSD: mk(61, 0.00003),
    GBPUSD: mk(62, -0.00004),
    THIN1: mk(63, 0).slice(0, 100), // too thin for the engine
  }
  const market = {
    mode: 'sim' as const,
    getCandlesDeep: (asset: string) => series[asset] ?? [],
    listAssets: () => [
      { ticker: 'EURUSD', price: series.EURUSD[series.EURUSD.length - 1].close, open: true },
      { ticker: 'GBPUSD', price: series.GBPUSD[series.GBPUSD.length - 1].close, open: true },
      { ticker: 'THIN1', price: 1.0, open: true },
    ],
  }
  const bus2 = new EventBus()
  const ctx2 = {
    bus: bus2,
    services: new Map(),
    provide: () => {},
    use: () => market,
    log: () => {},
  } as unknown as KernelContext
  const svc2 = new NextExpiryService()
  await svc2.start(ctx2)

  const scan1 = svc2.globalScan()
  ok(scan1.scanned === 3 && scan1.universe === 3, 'board scans the whole open universe (no silent truncation)', `scanned=${scan1.scanned}`)
  ok(scan1.live === 2 && scan1.warming === 1, 'live/warming split is honest', `live=${scan1.live} warming=${scan1.warming}`)
  const liveRows = scan1.rows.filter((r) => r.ok)
  const warmingRows = scan1.rows.filter((r) => !r.ok)
  ok(warmingRows.length === 1 && warmingRows[0].asset === 'THIN1' && warmingRows[0].computedTs === 0 && /warming/.test(warmingRows[0].note), 'warming row carries computedTs=0 + warming note')
  ok(warmingRows[0].rungs.length === 5 && warmingRows[0].rungs.every((r) => !r.ok), 'warming row still carries the full 5-rung strip')
  // edge sort: non-increasing across live rows, live before warming
  let sortedOk = true
  for (let i = 1; i < liveRows.length; i++) if ((liveRows[i - 1].best?.edge ?? 0) < (liveRows[i].best?.edge ?? 0)) sortedOk = false
  ok(sortedOk, 'live rows sorted by best edge descending')
  ok(scan1.rows.findIndex((r) => r.ok) < scan1.rows.findIndex((r) => !r.ok) || scan1.warming === 0, 'live rows precede warming rows')
  // row shape
  const r0 = liveRows[0]
  ok(r0.rungs.map((g) => g.expiry).join(',') === '1,2,3,5,15', 'board row rungs span the ladder')
  ok(r0.best === null || (r0.best.pWin >= 0.56 && r0.best.confidence >= 25), 'board best pick clears floors (or honest wait)')
  ok(['TRENDING', 'RANGING', 'VOLATILE', 'MIXED'].includes(r0.regime) && r0.session.length > 0, 'board row carries regime + session')

  // TTL cache: immediate re-poll recomputes nothing
  const scan2 = svc2.globalScan()
  ok(scan2.refreshed === 0, 'TTL cache: immediate re-poll refreshes nothing', `refreshed=${scan2.refreshed}`)
  ok(scan2.rows.find((r) => r.asset === 'EURUSD')?.computedTs === r0.computedTs, 'TTL cache: computedTs unchanged inside the TTL window')
  // refresh=1 forces recompute of every live row
  const scan3 = svc2.globalScan({ refresh: true })
  ok(scan3.refreshed === scan3.live && scan3.refreshed > 0, 'refresh=1 forces every live row to recompute', `refreshed=${scan3.refreshed} live=${scan3.live}`)
  ok(scan3.rows.find((r) => r.asset === 'EURUSD')!.computedTs > r0.computedTs, 'refresh=1 bumps computedTs')
  // the board feeds the SAME honesty ledger as the per-asset panel
  ok(svc2.stats().pending > 0, 'board scans register pending windows on the shared ledger')
  // limit is a safety ceiling, not a truncation knob: limit=2 scans exactly 2
  const scan4 = svc2.globalScan({ limit: 2 })
  ok(scan4.scanned === 2 && scan4.universe === 3, 'explicit limit acts as a ceiling (2 of 3 scanned)')
  svc2.stop()
}

// ---------- 7. meta-strategy signal source integration ----------
// The Next-Expiry Oracle as a Meta Strategy condition source ('nextExpiry'):
// best-pick read mirrors the engine's honesty-floored best, per-rung
// (expiryMin) reads mirror that rung, save() rejects non-ladder rungs, MSL
// scripts get 'nextExpiry' + 'nextExpiry:<E>' keys, thin pairs read none.
{
  // isolate persistence (fresh temp dir #3) - MetaStrategyService loads and
  // persists data/meta_strategies.json against process.cwd() too
  process.chdir(mkdtempSync(join(tmpdir(), 'nextexpiry-unit-')))
  const candles = walk(EXPIRY_ORACLE_MIN_CANDLES + 300, 71, 1.2, 0.00003)
  const market = {
    mode: 'sim' as const,
    getCandlesDeep: (asset: string) => (asset === 'THIN2' ? [] : candles),
    listAssets: () => [{ ticker: 'EURUSD', price: candles[candles.length - 1].close, open: true }],
    getPrice: () => candles[candles.length - 1].close,
  }
  const bus3 = new EventBus()
  const expSvc = new NextExpiryService()
  const metaSvc = new MetaStrategyService()
  const ctx3 = {
    bus: bus3,
    services: new Map(),
    provide: () => {},
    use: (name: string) => (name === 'nextexpiry' ? expSvc : market),
    log: () => {},
  } as unknown as KernelContext
  await expSvc.start(ctx3)
  await metaSvc.start(ctx3)

  // save() validation: a non-ladder rung is rejected before it can ever sit
  // in a spec silently reading none forever
  let rejected = ''
  try {
    metaSvc.save({ name: 'bad rung', mode: 'all', conditions: [{ source: 'nextExpiry', direction: 'either', expiryMin: 7 }] })
  } catch (e) {
    rejected = (e as Error).message
  }
  ok(/expiryMin/.test(rejected), 'save() rejects a non-ladder expiryMin (7m)', rejected)

  const saved = metaSvc.save({
    name: 'expiry driven',
    mode: 'any',
    conditions: [
      { source: 'nextExpiry', direction: 'either', minConfidence: 0 },
      { source: 'nextExpiry', direction: 'call', expiryMin: 5, minConfidence: 0 },
    ],
  })
  ok(saved.ok, 'save() accepts best-pick + per-rung nextExpiry conditions')
  ok(saved.spec.conditions.some((c) => c.expiryMin === 5), 'per-rung expiryMin survives the save mapping')

  const pred = expSvc.predict('EURUSD')
  ok(pred !== null, 'expiry oracle produced through the shared fake market')
  const ev = metaSvc.evaluate(saved.id, 'EURUSD', '5m')
  ok(ev.result.conditions.length === 2, 'evaluate() resolves both nextExpiry conditions')
  const bestRead = ev.result.conditions[0].read
  const rungRead = ev.result.conditions[1].read
  if (pred) {
    if (pred.best) {
      ok(bestRead.direction === pred.best.direction && bestRead.confidence === pred.best.confidence, 'best-pick read mirrors the engine best (direction + confidence, no second gate)', `${bestRead.direction}/${bestRead.confidence} vs ${pred.best.direction}/${pred.best.confidence}`)
      ok(/Expiry oracle \d+m/.test(bestRead.label), 'best-pick label names the expiry rung', bestRead.label)
    } else {
      ok(bestRead.direction === 'none', 'null best -> honest none read (wait)', bestRead.label)
    }
    const rung5 = pred.rows.find((r) => r.expiry === 5)
    if (rung5 && rung5.ok && rung5.direction !== 'none') {
      ok(rungRead.direction === rung5.direction && rungRead.confidence === rung5.confidence, '5m-rung read mirrors that rung row', `${rungRead.direction}/${rungRead.confidence} vs ${rung5.direction}/${rung5.confidence}`)
    } else {
      ok(rungRead.direction === 'none' && rungRead.confidence === 0, 'warming/deadband 5m rung reads as none/0, never a guess', rungRead.label)
    }
  }

  // MSL scripts: bare key + pinned-rung key both resolve and agree with the
  // condition-path reads of the same moment
  const t1 = metaSvc.testScript('call when nextExpiry.dir == call\nput when nextExpiry.dir == put', 'EURUSD', '5m')
  ok(t1.ok === true, 'MSL: bare nextExpiry key resolves in scripts', t1.error ?? '')
  const t2 = metaSvc.testScript('call when nextExpiry:5.dir == call\nput when nextExpiry:5.dir == put', 'EURUSD', '5m')
  ok(t2.ok === true, 'MSL: pinned nextExpiry:5 key resolves (digits after colon tokenize as one identifier)', t2.error ?? '')
  if (t1.ok && t2.ok && pred) {
    if (pred.best) ok(t1.direction === pred.best.direction, 'script best-pick verdict matches the engine best direction', `${t1.direction} vs ${pred.best.direction}`)
    const rung5b = pred.rows.find((r) => r.expiry === 5)
    if (rung5b && rung5b.ok && rung5b.direction !== 'none') ok(t2.direction === rung5b.direction, 'script pinned-rung verdict matches the rung direction', `${t2.direction} vs ${rung5b.direction}`)
  }

  // snapshotSources (AI Trader desk) carries the expiry read too
  const snap = metaSvc.snapshotSources('EURUSD', '5m')
  const snapExp = snap.find((r) => r.source === 'nextExpiry')
  ok(snapExp !== undefined, 'snapshotSources exposes the nextExpiry read to the AI Trader desk')
  ok(snapExp !== undefined && (snapExp.direction === 'none' ? snapExp.confidence === 0 : finite(snapExp.confidence)), 'snapshot nextExpiry read is grounded (none -> 0, else finite conf)')

  // fail-closed on a thin pair: predict() null -> every nextExpiry condition
  // reads none, the evaluation never throws
  const evThin = metaSvc.evaluate(saved.id, 'THIN2', '1m')
  ok(evThin.result.conditions.every((c) => c.read.direction === 'none' && c.read.confidence === 0), 'thin pair -> both nextExpiry conditions read none/0 (fail-closed, no throw)')

  expSvc.stop()
}

console.log(`nextexpiry_unit: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
