// IQAIR//OS - tests for the Brain Trader: the builtin MSL strategy it ships with (meta:builtin-brain-fib-adaptive) and the trader
// plugin (plugins/braintrader.ts) that runs a saved MSL strategy and asks an AI reviewer before every trade.
//   npx tsx tests/brain-trader.test.ts      (from mini-services/trading-core)
//
// HONESTY NOTE: planted-structure tests prove the script fires on the pattern it describes, in the right direction, and the plumbing
// (review, veto, fail-closed, shadow vs live, scoring) behaves. They say nothing about whether the strategy or the reviewer has an edge
// on a real market - that is only answered by the decision log's hit rates over a long real-data run.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseStrategyScript, evaluateStrategyScript, type MslSeriesCtx } from '../src/analytics/strategylang'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { fibEvidence } from '../src/analytics/brain'
import { BrainTraderService, parseReview, snapExpiry, buildReviewMessages, resolveOutcome, computeStats, type BrainDecision } from '../src/plugins/braintrader'
import type { Candle } from '../src/types'

type Test = { name: string; fn: () => void | Promise<void> }
const tests: Test[] = []
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn })

function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r())
function rw(n: number, seed: number): Candle[] {
  const r = rng(seed)
  let x = 100
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const o = x
    x += gauss(r)
    out.push({ time: 1.7e9 + i * 60, open: o, high: Math.max(o, x) + r() * 0.1, low: Math.min(o, x) - r() * 0.1, close: x, volume: 10 })
  }
  return out
}
// trend leg up, pullback to ~retr of the leg, then a bullish reversal bar (mirror when up=false)
function pullback(seed: number, up: boolean, retr: number, tail: 'engulf' | 'none'): Candle[]{
  const r=rng(seed), sg=up?1:-1; const closes:number[]=[];let x=100
  for(let i=0;i<110;i++){x+=gauss(r)*0.3;closes.push(x)}
  const start=x
  for(let i=0;i<50;i++){x+=sg*(0.35+gauss(r)*0.1);closes.push(x)}
  const leg=x-start
  const target=x-leg*retr
  const steps=8
  for(let i=1;i<=steps;i++){closes.push(x+(target-x)*(i/steps)+gauss(r)*0.05)}
  const c: Candle[]=closes.map((cl,i)=>{const o=i?closes[i-1]:cl;return{time:1.7e9+i*60,open:o,high:Math.max(o,cl)+r()*0.08,low:Math.min(o,cl)-r()*0.08,close:cl,volume:10}})
  if(tail==='engulf'){const last=c[c.length-1];const o=last.close - sg*0.0;const cl=last.close+sg*0.9;c.push({time:last.time+60,open:last.close-sg*0.1,high:Math.max(o,cl)+0.05,low:Math.min(o,cl)-0.1,close:cl,volume:10})}
  return c
}

function toSeries(c: Candle[]): MslSeriesCtx {
  return { open: c.map((x) => x.open), high: c.map((x) => x.high), low: c.map((x) => x.low), close: c.map((x) => x.close), volume: c.map((x) => x.volume ?? 0), time: c.map((x) => x.time) }
}
/** the builtin strategy exactly as it is seeded: pulled out of plugins/metastrategy.ts so this test cannot drift from what ships */
function builtinScript(id: string): string {
  const src = readFileSync(join(__dirname, '../src/plugins/metastrategy.ts'), 'utf8')
  const at = src.indexOf(`id: '${id}'`)
  assert.ok(at > 0, `${id} is not seeded in metastrategy.ts`)
  const open = src.indexOf('script: `', at) + 'script: `'.length
  return src.slice(open, src.indexOf('`', open))
}
const SCRIPT = builtinScript('meta:builtin-brain-fib-adaptive')
function runScript(script: string, c: Candle[]) {
  const p = parseStrategyScript(script)
  assert.ok(p.ok, !p.ok ? p.error : '')
  if (!p.ok) throw new Error('unreachable')
  return evaluateStrategyScript(p.ast, {}, undefined, toSeries(c), undefined, undefined, undefined)
}

test('builtin strategy: parses, and evaluates without a runtime error on random walks and on a trending pullback', () => {
  let errs = 0
  for (let s = 1; s <= 6; s++) {
    const c = rw(400, s * 5)
    for (let e = 160; e <= 400; e += 16) if (runScript(SCRIPT, c.slice(0, e)).error) errs++
    if (runScript(SCRIPT, pullback(s, true, 0.5, 'engulf')).error) errs++
  }
  assert.equal(errs, 0)
})

test('builtin strategy: a planted pullback into the 38-62% zone fires in the TREND direction and never against it (both sides); a deep pullback does not fire', () => {
  for (const up of [true, false]) {
    let right = 0
    let wrong = 0
    let deep = 0
    for (let s = 1; s <= 40; s++) {
      const o = runScript(SCRIPT, pullback(s, up, 0.5, 'engulf'))
      if (o.direction === (up ? 'call' : 'put')) right++
      else if (o.direction !== 'none') wrong++
      if (runScript(SCRIPT, pullback(s, up, 0.618, 'engulf')).direction !== 'none') deep++
    }
    assert.equal(wrong, 0, `${up ? 'up' : 'down'}trend: ${wrong} wrong-direction fires`)
    assert.ok(right >= 6, `${up ? 'up' : 'down'}trend: fired on only ${right}/40 planted pullbacks`)
    assert.equal(deep, 0, 'fired on a 61.8% pullback whose SMC reads bearish - the confirmation gate should hold')
  }
})

test('builtin strategy: rare on random walks (stands aside in noise, needs a leg + level + SMC + candle)', () => {
  let n = 0
  let fires = 0
  for (let s = 1; s <= 25; s++) {
    const c = rw(500, s * 13)
    for (let e = 160; e <= 500; e += 10) {
      n++
      if (runScript(SCRIPT, c.slice(0, e)).direction !== 'none') fires++
    }
  }
  assert.ok(fires / n <= 0.02, `fired on ${((fires / n) * 100).toFixed(1)}% of random-walk reads`)
})

test('builtin strategy: null-market backtest is a coin flip (no manufactured edge)', () => {
  let t = 0
  let w = 0
  for (let s = 1; s <= 30; s++) {
    const res = backtestMslScript(rw(1200, s * 17), SCRIPT, { expiryBars: 3, warmupBars: 160 })
    assert.equal(res.ok, true)
    t += res.trades.length
    w += res.wins
  }
  if (t >= 30) assert.ok(w / t > 0.35 && w / t < 0.65, `random walk ${((w / t) * 100).toFixed(1)}% over ${t} trades`)
})

test('parseReview: clean JSON, JSON inside prose, expiry snapped to the allowed list', () => {
  const ok = parseReview('{"decision":"go","expirySec":200,"confidence":71,"reason":"clean level"}', [60, 180, 300])!
  assert.equal(ok.go, true)
  assert.equal(ok.expirySec, 180)
  assert.equal(ok.confidence, 71)
  const prose = parseReview('Sure.\n```json\n{"decision":"NO","expirySec":60,"confidence":20,"reason":"stale"}\n```', [60, 180])!
  assert.equal(prose.go, false)
  assert.equal(snapExpiry(1000, [60, 180, 300]), 300)
})

test('parseReview fails closed: anything that is not a clear go/no object is rejected', () => {
  for (const bad of ['', 'go', 'I think we should trade', '{"decision":"maybe"}', '{"direction":"call"}', '{decision: go}', '{"decision":1}']) {
    assert.equal(parseReview(bad, [60, 180]), null, bad)
  }
})

test('review prompt: carries what the strategy saw (script, notes, fib levels, panels, bars) and the constraints on the reviewer', () => {
  const c = pullback(1, true, 0.5, 'engulf')
  const msgs = buildReviewMessages({ asset: 'EURUSD', tf: '1m', strategyName: 'Brain 1', script: SCRIPT, direction: 'call', confidence: 60, notes: 'fired: trendCall', price: c[c.length - 1].close, candles: c, expiriesSec: [60, 180, 300], panelLines: ['- renko: call 70'], scriptExpiryMin: 3 })
  const all = msgs.map((m) => m.content).join('\n')
  assert.ok(/60, 180, 300/.test(all))
  assert.ok(/NOT a win probability/.test(all))
  assert.ok(/cannot change the direction/i.test(all))
  assert.ok(/BRAIN STRATEGY 1/.test(all), 'the script text is included')
  assert.ok(/fired: trendCall/.test(all), 'the strategy notes are included')
  assert.ok(/FIBONACCI: UP leg/.test(all) && /61\.8%=/.test(all), 'the fib levels are included')
  assert.ok(/renko: call 70/.test(all) && /3-minute horizon/.test(all) && /LAST 12 CLOSED BARS/.test(all))
  assert.ok(/no usable leg/.test(fibEvidence(rw(20, 1))))
})

const mkDec = (over: Partial<BrainDecision>): BrainDecision => ({
  id: 'x', ts: 0, asset: 'EURUSD', tf: '1m', barTime: 1_000_000, direction: 'call', strategyId: 's', strategyName: 'S', confidence: 60, notes: '',
  entryPrice: 100, expirySec: 120, status: 'approved', placed: false, ...over,
})
const bar = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 1 })

test('resolveOutcome: scores at entry + expiry bars, call and put, tie, and not-yet-resolvable', () => {
  const candles = [bar(1_000_000, 100), bar(1_000_060, 100.5), bar(1_000_120, 101)]
  assert.deepEqual(resolveOutcome(mkDec({}), candles), { outcome: 'win', exitPrice: 101 })
  assert.equal(resolveOutcome(mkDec({ direction: 'put' }), candles)!.outcome, 'loss')
  assert.equal(resolveOutcome(mkDec({ entryPrice: 101 }), candles)!.outcome, 'tie')
  assert.equal(resolveOutcome(mkDec({ expirySec: 600 }), candles), null)
})

test('computeStats: groups signals / approved / vetoed and reports the lift only when both sides have outcomes', () => {
  const log = [
    mkDec({ status: 'approved', outcome: 'win' }), mkDec({ status: 'approved', outcome: 'win' }),
    mkDec({ status: 'vetoed', outcome: 'loss' }), mkDec({ status: 'vetoed', outcome: 'win' }),
    mkDec({ status: 'ai_unavailable' }),
  ]
  const s = computeStats(log)
  assert.equal(s.proposed.n, 5)
  assert.equal(s.approved.hitRate, 1)
  assert.equal(s.vetoed.hitRate, 0.5)
  assert.equal(s.proposed.hitRate, 0.75)
  assert.equal(s.reviewerLiftPts, 25)
  assert.equal(computeStats([mkDec({})]).reviewerLiftPts, null)
})

// ------------------------------------------------------------ service, with a fake kernel
type Sig = { direction: 'call' | 'put' | 'none'; confidence: number; notes: string; expiryMin?: number }
function harness(mode: 'auto' | 'human', series: Candle[], signal: Sig = { direction: 'call', confidence: 70, notes: 'fired: trendCall' }) {
  const placed: unknown[] = []
  let cfgRow: unknown = null
  let logRow: unknown = null
  let candles = series
  let evalCalls = 0
  let lastEvalId = ''
  const store = {
    getBrainTraderConfig: () => cfgRow, saveBrainTraderConfig: (c: unknown) => { cfgRow = c },
    getBrainTraderLog: () => logRow, saveBrainTraderLog: (l: unknown) => { logRow = l },
    listPositions: () => [] as unknown[],
  }
  const market = { listAssets: () => [{ ticker: 'EURUSD', open: true, otc: false }], getCandlesDeep: () => candles }
  const metaStrategy = {
    evaluate: (id: string) => { evalCalls++; lastEvalId = id; return { spec: { id, name: 'Brain 1', script: SCRIPT }, result: signal, price: candles[candles.length - 1].close } },
    snapshotSources: () => [{ source: 'renko', direction: 'call', confidence: 70, label: 'up' }],
  }
  const services: Record<string, unknown> = {
    store, market, metaStrategy,
    mode: { status: () => ({ mode }) },
    execution: { accountSource: 'paper', placeOrder: async (req: unknown) => { placed.push(req); return { ok: true } } },
  }
  const ctx = { use: (n: string) => services[n], bus: { on: () => () => {} }, log: () => {}, provide: () => {} }
  const svc = new BrainTraderService()
  return { svc, ctx, placed, getLog: () => logRow as BrainDecision[], setCandles: (c: Candle[]) => { candles = c }, evals: () => evalCalls, evalId: () => lastEvalId }
}
const series = () => rw(200, 4)
async function boot(h: ReturnType<typeof harness>, cfg: Record<string, unknown>) {
  await h.svc.start(h.ctx as never)
  h.svc.configure(cfg as never)
}
const tickOf = (h: ReturnType<typeof harness>) => (h.svc as unknown as { tick(): Promise<void> }).tick()
async function runOnce(h: ReturnType<typeof harness>) {
  await tickOf(h)
  h.svc.stop()
}
const withFetch = async (reply: () => Promise<Response> | Response, fn: () => Promise<void>) => {
  const real = globalThis.fetch
  globalThis.fetch = (async () => reply()) as typeof fetch
  try { await fn() } finally { globalThis.fetch = real }
}
const llm = (content: string) => () => new Response(JSON.stringify({ ok: true, content, provider: 'test', model: 'm' }), { status: 200 })
const GO = '{"decision":"go","expirySec":300,"confidence":66,"reason":"level is clean"}'
const BASE = { enabled: true, cooldownSec: 0 }

test('defaults: SHADOW, AI required, runs the builtin Brain strategy', async () => {
  const h = harness('auto', series())
  await h.svc.start(h.ctx as never)
  const c = h.svc.configure({} as never)
  assert.equal(c.live, false)
  assert.equal(c.requireAi, true)
  assert.equal(c.enabled, false)
  assert.equal(c.metaStrategyId, 'meta:builtin-brain-fib-adaptive')
  const c2 = h.svc.configure({ metaStrategyId: 'meta:builtin-trend-pullback-confluence', minConfidence: 999, expiriesSec: [300, 1, 60, 99999, 60], defaultExpirySec: 70 } as never)
  assert.equal(c2.metaStrategyId, 'meta:builtin-trend-pullback-confluence')
  assert.equal(c2.minConfidence, 100)
  assert.deepEqual(c2.expiriesSec, [60, 300])
  assert.equal(c2.defaultExpirySec, 60)
  h.svc.stop()
})

test('shadow mode: the strategy signals, reviewer says go with its own expiry, logged as approved, NO order placed', async () => {
  const h = harness('auto', series())
  await boot(h, { ...BASE, live: false })
  await withFetch(llm(GO), () => runOnce(h))
  const log = h.getLog()
  assert.equal(log.length, 1)
  assert.equal(h.evalId(), 'meta:builtin-brain-fib-adaptive')
  assert.equal(log[0].status, 'approved')
  assert.equal(log[0].direction, 'call')
  assert.equal(log[0].expirySec, 300)
  assert.equal(log[0].strategyName, 'Brain 1')
  assert.match(log[0].notes, /trendCall/)
  assert.equal(log[0].placed, false)
  assert.equal(h.placed.length, 0)
})

test('live + AUTO: go places one order with the reviewer\'s expiry; the same go in human mode only logs', async () => {
  const h = harness('auto', series())
  await boot(h, { ...BASE, live: true })
  await withFetch(llm(GO), () => runOnce(h))
  assert.equal(h.placed.length, 1)
  const req = h.placed[0] as { side: string; expirySec: number; note: string; strategy: string }
  assert.equal(req.side, 'call')
  assert.equal(req.expirySec, 300)
  assert.ok(req.note.startsWith('brain:trader'))
  assert.equal(req.strategy, 'brain:meta:builtin-brain-fib-adaptive')
  assert.equal(h.getLog()[0].placed, true)
  const h2 = harness('human', series())
  await boot(h2, { ...BASE, live: true })
  await withFetch(llm(GO), () => runOnce(h2))
  assert.equal(h2.placed.length, 0)
  assert.match(String(h2.getLog()[0].placeError), /not AUTO/)
})

test('veto: reviewer says no, nothing is placed even when live, and the vetoed signal is still logged for scoring', async () => {
  const h = harness('auto', series())
  await boot(h, { ...BASE, live: true })
  await withFetch(llm('{"decision":"no","expirySec":60,"confidence":30,"reason":"price already left the level"}'), () => runOnce(h))
  assert.equal(h.placed.length, 0)
  const d = h.getLog()[0]
  assert.equal(d.status, 'vetoed')
  assert.equal(d.ai?.go, false)
  assert.equal(d.placed, false)
})

test('fail closed: garbage reply and an unreachable reviewer both veto, never trade', async () => {
  const h = harness('auto', series())
  await boot(h, { ...BASE, live: true })
  await withFetch(llm('sure, buy it!'), () => runOnce(h))
  assert.equal(h.getLog()[0].status, 'ai_unavailable')
  assert.equal(h.placed.length, 0)
  const h2 = harness('auto', series())
  await boot(h2, { ...BASE, live: true })
  await withFetch(() => { throw new Error('connection refused') }, () => runOnce(h2))
  assert.equal(h2.getLog()[0].status, 'ai_unavailable')
  assert.equal(h2.placed.length, 0)
})

test('what the strategy returns is respected: no signal, below minConfidence, or the wrong direction never reach the reviewer', async () => {
  let asked = 0
  const ask = () => { asked++; return llm(GO)() }
  for (const [signal, cfg] of [
    [{ direction: 'none', confidence: 0, notes: '' } as Sig, {}],
    [{ direction: 'call', confidence: 40, notes: 'x' } as Sig, { minConfidence: 55 }],
    [{ direction: 'call', confidence: 80, notes: 'x' } as Sig, { direction: 'put' }],
  ] as const) {
    const h = harness('auto', series(), signal)
    await boot(h, { ...BASE, live: false, ...cfg })
    await withFetch(ask, () => runOnce(h))
    assert.equal(h.getLog() ?? null, null)
  }
  assert.equal(asked, 0)
})

test('each closed bar is read once; a signal that stays true is not re-sent for 5 bars, then is again', async () => {
  const base = series()
  const h = harness('auto', base)
  await boot(h, { ...BASE, live: false })
  await withFetch(llm(GO), async () => {
    await tickOf(h)
    await tickOf(h) // same bar: skipped
    assert.equal(h.evals(), 1)
    assert.equal(h.getLog().length, 1)
    const grow = (n: number, from: Candle[]) => {
      const out = from.slice()
      for (let i = 0; i < n; i++) out.push(bar(out[out.length - 1].time + 60, out[out.length - 1].close + 0.1))
      return out
    }
    h.setCandles(grow(2, base)) // new bar, but inside the 5-bar hold
    await tickOf(h)
    assert.equal(h.getLog().length, 1)
    h.setCandles(grow(8, base)) // past the hold
    await tickOf(h)
    assert.equal(h.getLog().length, 2)
  })
  h.svc.stop()
})

test('hourly review cap: over the cap the signal is logged as rate_limited and nothing is placed', async () => {
  const h = harness('auto', series())
  await boot(h, { ...BASE, live: true, maxReviewsPerHour: 1 })
  ;(h.svc as unknown as { reviewTimes: number[] }).reviewTimes = [Date.now()]
  await withFetch(llm(GO), () => runOnce(h))
  assert.equal(h.getLog()[0].status, 'rate_limited')
  assert.equal(h.placed.length, 0)
})

test('preview(): runs the configured strategy on one asset - no AI call, no log entry, no order', async () => {
  const h = harness('auto', series())
  await boot(h, { ...BASE, live: true, minConfidence: 60 })
  let fetched = 0
  await withFetch(() => { fetched++; return llm(GO)() }, async () => {
    const p = h.svc.preview('EURUSD')
    assert.equal(p.direction, 'call')
    assert.equal(p.confidence, 70)
    assert.equal(p.wouldSend, true)
    assert.match(p.notes, /trendCall/)
    h.svc.configure({ minConfidence: 90 } as never)
    assert.equal(h.svc.preview('EURUSD').wouldSend, false)
  })
  h.svc.stop()
  assert.equal(fetched, 0)
  assert.equal(h.placed.length, 0)
})

let passed = 0
let failed = 0
void (async () => {
  for (const t of tests) {
    try {
      await t.fn()
      passed++
      console.log(`  ok - ${t.name}`)
    } catch (err) {
      failed++
      console.log(`  FAIL - ${t.name}\n    ${err instanceof Error ? err.message : err}`)
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
  if (failed > 0) process.exit(1)
})()
