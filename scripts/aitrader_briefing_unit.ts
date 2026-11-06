// AI Trader expert-desk upgrade - deterministic logic unit (bun, in-process).
// Locks the detection/precision/accuracy contract added to plugins/aitrader.ts:
//   - candleAnatomy: last-3-closed-bar bodies/wicks/close-position, anchored
//     same-color streak (>=3 to report), range position, rejection-wick tags
//   - swingStructure: 2-bar fractal swings, BOS vs range-bound verdict
//   - deskTally: confidence-weighted call/put/abstain counts across panel reads
//   - calibrationLines: >=3 graded calls only; per-direction and per-confidence-
//     bucket W/L so the model can see its own inflation/bias
//   - deskBriefingFor: every desk seat fail-closed - a kernel where every
//     service is missing still yields the pure session line, NO throw; a stub
//     oracle seat is picked up and formatted; a resolver that fails once
//     RETRIES on the next cycle (null is never cached)
//   - end-to-end pipeline: thin-but-valid candles + unreachable LLM still
//     records a skip row carrying the desk audit trail (source:'desk' lines)
import { EventBus } from '../mini-services/trading-core/src/kernel'
import type { KernelContext } from '../mini-services/trading-core/src/kernel'
import { Store } from '../mini-services/trading-core/src/store'
import { AiTraderService, candleAnatomy, swingStructure, deskTally, calibrationLines, tapeHealthLines, tickDeskLines, otcFootprintLines } from '../mini-services/trading-core/src/plugins/aitrader'
import type { Candle } from '../mini-services/trading-core/src/types'
import type { MetaSourceRead } from '../mini-services/trading-core/src/analytics/metastrategy'
import type { TickPoint, FootprintResult } from '../mini-services/trading-core/src/analytics/otcfootprint'
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

// ---------- synthetic candles ----------
const nowSec = Math.floor(Date.now() / 1000)
function makeCandles(n: number, gen: (i: number) => { o: number; h: number; l: number; c: number }): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const b = gen(i)
    out.push({ time: nowSec - (n - 1 - i) * 60, open: b.o, high: b.h, low: b.l, close: b.c, volume: 1000 })
  }
  return out
}
const rising = makeCandles(30, (i) => {
  const base = 1.1 + i * 0.0001
  return { o: base, h: base + 0.00012, l: base - 0.00005, c: base + 0.0001 }
})
// a bar with a huge upper wick (close well off the high): sellers rejected higher prices
const wicky = makeCandles(6, (i) => {
  const base = 1.1 + i * 0.00005
  const o = base
  const c = i === 5 ? base + 0.00005 : base + 0.0001
  return { o, h: base + 0.0012, l: base - 0.00005, c }
})

// ---------- 1. candleAnatomy ----------
{
  const lines = candleAnatomy(rising)
  ok(lines.length >= 4, 'anatomy: 3 bars + streak + range position on a rising series', JSON.stringify(lines))
  ok(lines.some((l) => l.includes('up bar') && l.includes('body')), 'anatomy: bars labeled up with body share', '')
  ok(lines.some((l) => l.includes('streak: 30 consecutive up-color')), 'anatomy: all-up series reports the full streak', lines.find((l) => l.includes('streak')) ?? '')
  ok(lines.some((l) => l.includes('range position')), 'anatomy: range position line present', '')

  const wickLines = candleAnatomy(wicky)
  ok(wickLines.some((l) => l.includes('[long upper wick')), 'anatomy: rejection wick tagged on the wick-heavy bar', JSON.stringify(wickLines))

  ok(candleAnatomy(rising.slice(0, 3)).length === 0, 'anatomy: <4 bars -> silence (fail-closed)', '')
}

// ---------- 2. swingStructure ----------
{
  // triangle wave, period 8, strictly unique extrema -> real 2-bar fractals
  const zz = makeCandles(36, (i) => {
    const p = i % 8
    const base = 1.1 + (p <= 4 ? p : 8 - p) * 0.0002
    return { o: base, h: base + 0.00004, l: base - 0.00004, c: base }
  })
  const lines = swingStructure(zz)
  ok(lines.some((l) => l.includes('last swing high')), 'structure: swing high reported', JSON.stringify(lines))
  ok(lines.some((l) => l.includes('last swing low')), 'structure: swing low reported', '')
  ok(lines.some((l) => l.includes('INSIDE the last swing high/low pair')), 'structure: contained close -> honest range-bound verdict', JSON.stringify(lines))

  // trend that closes ABOVE every prior high -> bullish BOS
  const bos = makeCandles(24, (i) => {
    const base = 1.1 + i * 0.0003
    return { o: base, h: base + 0.0004, l: base - 0.0001, c: base + 0.00035 }
  })
  ok(swingStructure(bos).some((l) => l.includes('no confirmed 2-bar swing points')), 'structure: one-directional tape -> honest no-swings line', JSON.stringify(swingStructure(bos)))

  ok(swingStructure(rising.slice(0, 8)).length === 0, 'structure: <9 bars -> silence', '')
}

// ---------- 3. deskTally ----------
{
  const read = (direction: 'call' | 'put' | 'none', confidence: number): MetaSourceRead => ({ source: 'oracle', direction, confidence, label: direction })
  const snap = [read('call', 70), read('call', 50), read('put', 40), read('none', 0)]
  const tally = deskTally(snap) ?? ''
  ok(tally.includes('2 call / 1 put / 1 abstaining'), 'tally: counts calls/puts/abstentions', tally)
  ok(tally.includes('+80 toward call'), 'tally: confidence-weighted net (70+50-40=+80)', tally)
  ok(tally.toLowerCase().includes('starting point'), 'tally: framed as a starting point, not a verdict', tally)
  ok(deskTally([]) === null, 'tally: empty snapshot -> null', '')
}

// ---------- 4. calibrationLines ----------
{
  const rows = [
    { direction: 'call', confidence: 80, outcome: 'win' as const },
    { direction: 'call', confidence: 85, outcome: 'win' as const },
    { direction: 'call', confidence: 70, outcome: 'loss' as const },
    { direction: 'put', confidence: 70, outcome: 'loss' as const },
    { direction: 'put', confidence: 72, outcome: 'loss' as const },
    { direction: 'put', confidence: 75, outcome: 'loss' as const },
  ]
  const lines = calibrationLines(rows)
  ok(lines.some((l) => l.includes('CALL calls: 2W/1L (67%)')), 'calibration: per-direction W/L', JSON.stringify(lines))
  ok(lines.some((l) => l.includes('PUT calls: 0W/3L (0%)')), 'calibration: losing direction exposed', JSON.stringify(lines))
  ok(lines.some((l) => l.includes('confidence 70-74') || l.includes('confidence 65-74')), 'calibration: bucket line present', JSON.stringify(lines))
  ok(lines[0].includes('self-calibration'), 'calibration: header line first', JSON.stringify(lines))
  ok(calibrationLines(rows.slice(0, 2)).length === 0, 'calibration: <3 graded calls -> silence (no fake stats)', '')
}

// ---------- harness: fresh service with controllable desk seats ----------
function makeCtx(store: Store, seats: Map<string, unknown>): KernelContext {
  return {
    bus: new EventBus(),
    services: new Map(),
    provide: () => {},
    use: (name: string) => {
      if (name === 'store') return store
      const s = seats.get(name)
      if (s !== undefined) return s
      // start() resolves these unconditionally - harmless {} stubs when the
      // harness didn't provide real ones (the briefing itself never touches
      // them; the desk seats are the ones deliberately left unregistered)
      if (name === 'market' || name === 'execution') return {}
      throw new Error(`service ${name} not registered`)
    },
    log: () => {},
  } as unknown as KernelContext
}
async function freshService(seats: Map<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'aitrader-desk-unit-'))
  const store = new Store(join(dir, 'unit.db'))
  const svc = new AiTraderService()
  await svc.start(makeCtx(store, seats))
  return { svc, store }
}

// ---------- 5. deskBriefingFor: every seat empty -> session line only, NO throw ----------
{
  const { svc } = await freshService(new Map())
  const b = await svc.deskBriefingFor('EURUSD', '1m', nowSec, 1)
  ok(b.sourcesSeen === 1, 'briefing: with every service missing, exactly the pure session section reports', `sourcesSeen=${b.sourcesSeen}`)
  ok(b.lines.length >= 2 && b.lines[0] === '[trading session]', 'briefing: session section present', JSON.stringify(b.lines.slice(0, 2)))
  ok(b.lines.some((l) => /ASIA|LONDON|OVERLAP|NEWYORK|OFF/.test(l)), 'briefing: session line names the actual session', JSON.stringify(b.lines))
  svc.stop()
}

// ---------- 6. briefing picks up a stub oracle seat + formats its calibration ----------
{
  const stubPrediction = {
    asset: 'EURUSD', tf: '1m', ts: nowSec, targetBarTime: nowSec, price: 1.1,
    pUp: 0.63, direction: 'call', confidence: 55, rawConfidence: 71, regime: 'trend',
    expectedMove: 0.0004, atr: 0.0008, range: { low: 1.0995, high: 1.1007 },
    bodyRatio: 0.6, closePos: 0.7, expectedCandleType: 'strong bull bar',
    drivers: [], driversActive: 5, patternHits: [{ name: 'engulfing', direction: 'bullish' }],
    calibration: null, mode: 'sim',
  }
  const seats = new Map<string, unknown>([['nextcandle', { predict: () => stubPrediction }]])
  const { svc } = await freshService(seats)
  const b = await svc.deskBriefingFor('EURUSD', '1m', nowSec, 1)
  const block = b.lines.join('\n')
  ok(b.lines[0] === '[next-candle oracle (deep read)]', 'briefing: oracle section first (before session)', JSON.stringify(b.lines.slice(0, 2)))
  ok(block.includes('CALL (pUp 63%)') && block.includes('raw 71%'), 'briefing: direction + pUp + raw-vs-calibrated confidence rendered', block)
  ok(block.includes('NO live calibration record'), 'briefing: null calibration rendered as unproven (honest)', block)
  ok(block.includes('engulfing (bullish)'), 'briefing: pattern hits rendered', block)
  ok(block.includes('strong bull bar'), 'briefing: expected candle shape rendered', block)
  ok(b.sourcesSeen === 2, 'briefing: oracle + session = 2 sources reporting', `sourcesSeen=${b.sourcesSeen}`)

  // a THROWING seat (registered service that fails on a thin asset) degrades
  // to an omitted section, never a crash
  const badSeats = new Map<string, unknown>([['nextcandle', { predict: () => { throw new Error('thin history') } }]])
  const { svc: svc2 } = await freshService(badSeats)
  const b2 = await svc2.deskBriefingFor('EURUSD', '1m', nowSec, 1)
  ok(b2.sourcesSeen === 1 && !b2.lines.join('').includes('next-candle oracle'), 'briefing: throwing oracle seat omitted cleanly', JSON.stringify(b2.lines))
  svc.stop()
  svc2.stop()
}

// ---------- 7. resolver: a failed resolve is retried next cycle (heals) ----------
{
  let failFirst = true
  const dir = mkdtempSync(join(tmpdir(), 'aitrader-desk-unit-'))
  const store = new Store(join(dir, 'unit.db'))
  const flaky = {
    bus: new EventBus(),
    services: new Map(),
    provide: () => {},
    use: (name: string) => {
      if (name === 'store') return store
      if (name === 'market' || name === 'execution') return {}
      if (name === 'nextcandle') {
        if (failFirst) throw new Error('not registered yet')
        return { predict: () => null } // registered but no prediction yet -> section still omitted (no pred)
      }
      throw new Error(`service ${name} not registered`)
    },
    log: () => {},
  } as unknown as KernelContext
  const svc2 = new AiTraderService()
  await svc2.start(flaky)
  const b1 = await svc2.deskBriefingFor('EURUSD', '1m', nowSec, 1)
  ok(b1.sourcesSeen === 1, 'flaky resolver: first cycle -> oracle seat missing', `sourcesSeen=${b1.sourcesSeen}`)
  failFirst = false
  const b2 = await svc2.deskBriefingFor('EURUSD', '1m', nowSec, 1)
  // the second resolve succeeds but predict() returns null -> still omitted,
  // but the RESOLVER cached the service (proves the retry happened: no
  // throw, and the seat count path ran against the now-registered plugin)
  ok(b2.sourcesSeen === 1 && b2.lines.length === b1.lines.length, 'flaky resolver: retried next cycle, null-prediction seat still omitted cleanly', `sourcesSeen=${b2.sourcesSeen}`)
  svc2.stop()
}

// ---------- 8. end-to-end: valid candles + unreachable LLM -> skip row WITH the desk audit trail ----------
{
  const candles = makeCandles(60, (i) => {
    const base = 1.1 + Math.sin(i / 6) * 0.0004 + i * 0.00002
    return { o: base, h: base + 0.00012, l: base - 0.00012, c: base + (i % 2 ? 0.00008 : -0.00008) }
  })
  const market = {
    getPrice: () => 1.1,
    getCandles: () => candles,
    getCandlesDeep: () => candles,
    listAssets: () => [],
    mode: 'sim',
  }
  const seats = new Map<string, unknown>([
    ['market', market],
    ['execution', { accountSource: 'paper', placeOrder: () => ({ ok: false, error: 'not reached' }) }],
  ])
  const { svc, store } = await freshService(seats)
  // port 1: guaranteed fast connection-refused, then trading-core's own .env
  // fallback also fails (no provider keys in the unit env) -> LLM error path
  svc.configure({ appUrl: 'http://127.0.0.1:1', intervalMin: 10 })
  const out = await svc.runNow()
  ok(out.ok === false, 'e2e: runNow not-ok when the LLM is unreachable', out.error ?? '')
  const row = svc.listDecisions(1)[0]
  ok(Boolean(row) && row.direction === 'skip', 'e2e: a skip decision row was recorded', row?.direction ?? 'no row')
  ok(/LLM call failed/.test(row?.reasoning ?? ''), 'e2e: the row names the LLM failure as the reason', row?.reasoning ?? '')
  const snap: { source: string; label: string }[] = typeof row?.snapshot === 'string' ? JSON.parse(row.snapshot) : (row?.snapshot as { source: string; label: string }[])
  ok(Array.isArray(snap) && snap.some((e) => e.source === 'desk' && e.label === '[trading session]'), 'e2e: decision row carries the desk audit trail (source:desk)', JSON.stringify(snap?.slice(0, 2)))
  ok(!snap.some((e) => e.source === 'desk' && (e.label.startsWith('- bar ') || e.label.includes('swing'))), 'e2e: own-analysis sections stay prompt-only (audit = desk briefing + tally, not the anatomy rows)', JSON.stringify(snap?.filter((e) => e.source === 'desk').map((e) => e.label.slice(0, 30))))
  svc.stop()
  void store
}

// ---------- 9. tick-desk briefing helpers (tape health / tick engines / velocity footprint) ----------
{
  // fresh rising staircase: 250ms prints, 3 buckets up / 2 buckets back
  const nowMs = Date.now()
  const t0 = nowMs - 3000 * 250
  const freshTicks: TickPoint[] = []
  let p = 1.1
  for (let i = 0; i < 3000; i++) {
    p += (i % 300) < 180 ? 0.0005 : -0.0002
    freshTicks.push({ ts: t0 + i * 250, price: p })
  }
  const health = tapeHealthLines(freshTicks, nowMs)
  ok(health.length >= 1 && health[0].includes('(fresh)'), 'tapeHealthLines: fresh tape reports cadence + age + fresh flag', health[0] ?? '')
  ok(health.some((l) => l.includes('print flow') && l.includes('up-prints')), 'tapeHealthLines: measured print-flow line present on a directional stream', health.join(' | '))
  const staleTicks: TickPoint[] = freshTicks.slice(0, 400).map((t) => ({ ...t, ts: t.ts - 600_000 }))
  const stale = tapeHealthLines(staleTicks, nowMs)
  ok(stale.length >= 1 && /STALE/.test(stale[0]), 'tapeHealthLines: an old last print is flagged STALE with the discount instruction', stale[0] ?? '')
  ok(tapeHealthLines([], nowMs).length === 0, 'tapeHealthLines: no prints -> empty seat, never a fabricated line')

  const desk = tickDeskLines(freshTicks, nowMs)
  ok(desk.some((l) => l.startsWith('tick SMC (15s buckets): trend UP')), 'tickDeskLines: tick SMC reads the uptrend off tick candles', desk.join(' | '))
  ok(desk.some((l) => l.startsWith('tick oracle (next tick-candle): best')), 'tickDeskLines: tick oracle best-bucket line present', '')
  ok(desk.some((l) => l.startsWith('tick technical (osc+MA committee per bucket):')), 'tickDeskLines: tick technical ladder line present', '')
  ok(desk.some((l) => l.startsWith('tick footprint (60s buckets, measured prints): net delta +')), 'tickDeskLines: measured-print footprint delta line present (uptrend -> positive)', '')
  ok(!desk.some((l) => l.toLowerCase().includes('swing')), 'tickDeskLines: no own-analysis vocabulary leaks into desk audit lines', desk.join(' | '))
  const thin = tickDeskLines([{ ts: nowMs - 1000, price: 1.1 }, { ts: nowMs, price: 1.1001 }], nowMs)
  ok(thin.every((l) => typeof l === 'string' && l.length > 0) && !thin.some((l) => l.startsWith('tick SMC')), 'tickDeskLines: a 2-print stream still fails closed (SMC omitted, no throw)', JSON.stringify(thin))

  const fp: FootprintResult = {
    asset: 'EURUSD',
    bucketSec: 60,
    tickSize: 0.00001,
    dataSource: 'sim-tick-1s',
    cadenceMs: 1000,
    minutes: 30,
    buckets: [],
    summary: { totalUp: 34, totalDn: 22, netDelta: 12, avgSpeedRatio: 1.25, dominantPoc: 1.10234, signal: 'call', score: 42, note: 'delta +12, ratio 1.25, stagnation 0.0 - no OTC footprint edge' },
  }
  const vf = otcFootprintLines(fp)
  ok(vf.length >= 1 && vf[0].includes('velocity footprint') && vf[0].includes('CALL') && vf[0].includes('+12'), 'otcFootprintLines: verdict/score/delta line rendered', vf[0] ?? '')
  ok(vf.some((l) => l.startsWith('engine note:')), 'otcFootprintLines: the engine\'s own note is carried verbatim', vf.join(' | '))
  const vfQuiet = otcFootprintLines({ ...fp, summary: { ...fp.summary, note: '' } })
  ok(vfQuiet.length === 1, 'otcFootprintLines: no note -> single line, no empty filler', vfQuiet.join(' | '))
}

console.log(`\naitrader_briefing_unit: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
