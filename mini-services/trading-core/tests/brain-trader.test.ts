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
type AssetStub = { ticker: string; open: boolean; otc?: boolean }
function harness(mode: 'auto' | 'human', series: Candle[], signal: Sig | ((asset: string) => Sig) = { direction: 'call', confidence: 70, notes: 'fired: trendCall' }, assetList: AssetStub[] = [{ ticker: 'EURUSD', open: true, otc: false }]) {
  const evalAssets: string[] = []
  const placed: unknown[] = []
  let cfgRow: unknown = null
  let logRow: unknown = null
  let candles = series
  const openPos: unknown[] = []
  let evalCalls = 0
  let lastEvalId = ''
  const store = {
    getBrainTraderConfig: () => cfgRow, saveBrainTraderConfig: (c: unknown) => { cfgRow = c },
    getBrainTraderLog: () => logRow, saveBrainTraderLog: (l: unknown) => { logRow = l },
    listPositions: () => openPos,
  }
  const market = { listAssets: () => assetList, getCandlesDeep: () => candles }
  const metaStrategy = {
    evaluate: (id: string, asset: string) => { evalCalls++; lastEvalId = id; evalAssets.push(asset); return { spec: { id, name: 'Brain 1', script: SCRIPT }, result: typeof signal === 'function' ? signal(asset) : signal, price: candles[candles.length - 1].close } },
    snapshotSources: () => [{ source: 'renko', direction: 'call', confidence: 70, label: 'up' }],
  }
  const services: Record<string, unknown> = {
    store, market, metaStrategy,
    mode: { status: () => ({ mode }) },
    execution: { accountSource: 'paper', placeOrder: async (req: unknown) => { placed.push(req); return { ok: true } } },
  }
  const ctx = { use: (n: string) => services[n], bus: { on: () => () => {} }, log: () => {}, provide: () => {} }
  const svc = new BrainTraderService()
  return { svc, ctx, placed, openPos, evalAssets, getLog: () => logRow as BrainDecision[], setCandles: (c: Candle[]) => { candles = c }, evals: () => evalCalls, evalId: () => lastEvalId }
}
/** closed bars ending one bar ago (so the feed counts as fresh) */
const series = () => {
  const now = Math.floor(Date.now() / 1000)
  return rw(200, 4).map((c, i, a) => ({ ...c, time: now - (a.length - i) * 60 }))
}
const oldSeries = () => rw(200, 4)
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
  await boot(h, { ...BASE, live: false, maxOpen: 10 })
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

const MANY: AssetStub[] = [
  ...Array.from({ length: 40 }, (_, i) => ({ ticker: `PAIR${i}`, open: true, otc: false })),
  ...Array.from({ length: 10 }, (_, i) => ({ ticker: `OTC${i}`, open: true, otc: true })),
  { ticker: 'CLOSED1', open: false, otc: false },
]

test('ALL pairs: every open pair is scanned (not a handful), closed markets are skipped, and the real/OTC scope narrows it', async () => {
  const h = harness('auto', series(), { direction: 'none', confidence: 0, notes: '' }, MANY)
  await boot(h, { ...BASE, live: false, watchMode: 'all', marketScope: 'all' })
  assert.equal(h.svc.status().watching.pool, 50)
  await runOnce(h)
  assert.equal(new Set(h.evalAssets).size, 50)
  assert.ok(!h.evalAssets.includes('CLOSED1'))
  const h2 = harness('auto', series(), { direction: 'none', confidence: 0, notes: '' }, MANY)
  await boot(h2, { ...BASE, live: false, watchMode: 'all', marketScope: 'otc' })
  await runOnce(h2)
  assert.equal(new Set(h2.evalAssets).size, 10)
  assert.ok(h2.evalAssets.every((a) => a.startsWith('OTC')))
  const h3 = harness('auto', series(), { direction: 'none', confidence: 0, notes: '' }, MANY)
  await boot(h3, { ...BASE, live: false, watchMode: 'all', marketScope: 'real' })
  await runOnce(h3)
  assert.equal(new Set(h3.evalAssets).size, 40)
})

test('SELECTED pairs: only the chosen pairs are scanned; a chosen pair whose market is closed is skipped; duplicates and unknown pairs are harmless', async () => {
  const h = harness('auto', series(), { direction: 'none', confidence: 0, notes: '' }, MANY)
  await boot(h, { ...BASE, live: false, watchMode: 'selected', assets: ['PAIR3', 'OTC2', 'PAIR3', 'CLOSED1', 'NOPE'] })
  assert.equal(h.svc.status().watching.pool, 2)
  assert.equal(h.svc.status().watching.selected, 4)
  await runOnce(h)
  assert.deepEqual([...h.evalAssets].sort(), ['OTC2', 'PAIR3'])
  const h2 = harness('auto', series(), { direction: 'none', confidence: 0, notes: '' }, MANY)
  await boot(h2, { ...BASE, live: false, watchMode: 'selected', assets: [] })
  await runOnce(h2)
  assert.equal(h2.evalAssets.length, 0, 'selected mode with nothing selected watches nothing')
  assert.equal(h2.svc.status().runtime.lastScanPool, 0)
})

test('ONE AT A TIME: several pairs signal the same bar -> only the strongest goes to the reviewer; a veto frees the next-best on the next tick', async () => {
  const conf: Record<string, number> = { PAIR0: 60, PAIR1: 80, PAIR2: 70, PAIR3: 75, PAIR4: 65 }
  const mk = () => harness('auto', series(), (a: string) => ({ direction: 'call', confidence: conf[a] ?? 0, notes: 'x' }), MANY.slice(0, 5))
  const h = mk()
  await boot(h, { ...BASE, live: false, watchMode: 'all', maxReviewsPerHour: 100 })
  let calls = 0
  const prompts: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => { calls++; prompts.push(String(init?.body)); return llm('{"decision":"no","expirySec":60,"confidence":50,"reason":"not clean"}')() }) as typeof fetch
  try {
    await tickOf(h)
    assert.equal(calls, 1, 'exactly ONE reviewer call for five valid pairs')
    assert.equal(h.getLog().length, 1)
    assert.equal(h.getLog()[0].asset, 'PAIR1', 'the strongest signal is the one reviewed')
    assert.match(prompts[0], /strongest of 5 valid signals/)
    assert.equal(h.svc.status().pending, 4)
    await tickOf(h) // veto does not occupy a slot -> the next-best is reviewed
    assert.equal(calls, 2)
    assert.equal(h.getLog()[1].asset, 'PAIR3')
    await tickOf(h)
    await tickOf(h)
    await tickOf(h)
    assert.equal(calls, 5)
    assert.deepEqual(h.getLog().map((d) => d.asset), ['PAIR1', 'PAIR3', 'PAIR2', 'PAIR4', 'PAIR0'], 'descending strategy confidence, each pair reviewed once')
    await tickOf(h)
    assert.equal(calls, 5, 'nothing is reviewed twice')
  } finally { globalThis.fetch = real }
  h.svc.stop()
})

test('A TRADE IS OPEN: the scan keeps going, signals wait, nothing else goes to the reviewer until the slot frees, stale ones are dropped', async () => {
  const conf: Record<string, number> = { PAIR0: 60, PAIR1: 80, PAIR2: 70 }
  const h = harness('auto', series(), (a: string) => ({ direction: 'call', confidence: conf[a] ?? 0, notes: 'x' }), MANY.slice(0, 3))
  await boot(h, { ...BASE, live: true, watchMode: 'all', maxOpen: 1, maxReviewsPerHour: 100 })
  let calls = 0
  const real = globalThis.fetch
  globalThis.fetch = (async () => { calls++; return llm(GO)() }) as typeof fetch
  const openPositions = h.openPos
  try {
    await tickOf(h)
    assert.equal(calls, 1)
    assert.equal(h.placed.length, 1)
    // the placed trade is now OPEN: report it so the slot is busy
    openPositions.push({ note: 'brain:trader x', asset: 'PAIR1' })
    await tickOf(h)
    await tickOf(h)
    assert.equal(calls, 1, 'no second reviewer call while the trade is open')
    assert.equal(h.placed.length, 1)
    assert.match(String(h.svc.status().runtime.lastReason), /holding \d+ signal\(s\)/)
    // the trade ends: the best STILL-FRESH signal goes next
    openPositions.length = 0
    await tickOf(h)
    assert.equal(calls, 2)
    assert.equal(h.getLog()[1].asset, 'PAIR2')
    // and a signal that waited too long (2+ bars) is dropped, not sent late
    openPositions.push({ note: 'brain:trader y', asset: 'PAIR2' })
    ;(h.svc as unknown as { now: () => number }).now = () => Math.floor(Date.now() / 1000) + 600
    await tickOf(h)
    assert.ok((h.svc.status().runtime.expiredCandidates ?? 0) >= 1)
    assert.equal(calls, 2)
  } finally { globalThis.fetch = real }
  h.svc.stop()
})

test('COMPOUNDING: win folds profit into the pot (next stake), loss burns it and halts, restart re-seeds; live orders use the pot; shadow never touches it', async () => {
  const h = harness('auto', series())
  await boot(h, { ...BASE, live: true, stake: 1, stakePlan: { kind: 'compound', base: 2 } as never })
  assert.equal(h.svc.stakeFor(), 2)
  const close = (pnl: number, status: string, amount: number) => (h.svc as unknown as { onPositionClosed(p: unknown): void }).onPositionClosed({ note: 'brain:trader z', pnl, status, amount })
  close(1.6, 'won', 2) // fold min(1.6, 2*0.7=1.4) = 1.4
  assert.equal(h.svc.stakeFor(), 3.4)
  assert.equal(h.svc.status().runtime.rollN, 1)
  close(1.0, 'won', 3.4) // fold min(1.0, 2.38)=1.0 -> 4.4
  assert.equal(h.svc.stakeFor(), 4.4)
  await withFetch(llm(GO), () => runOnce(h))
  assert.equal((h.placed[0] as { amount: number }).amount, 4.4, 'the live order stakes the pot')
  assert.equal(h.getLog()[0].stake, 4.4)
  close(-4.4, 'lost', 4.4) // pot burned, cycle halted
  assert.equal(h.svc.status().runtime.halted, true)
  assert.equal(h.svc.stakeFor(), 2, 'a burned pot re-seeds at base')
  // halted: the scan does not even call the reviewer
  const h2 = harness('auto', series())
  await boot(h2, { ...BASE, live: true, stakePlan: { kind: 'compound', base: 2 } as never })
  ;(h2.svc as unknown as { onPositionClosed(p: unknown): void }).onPositionClosed({ note: 'brain:trader z', pnl: -2, status: 'lost', amount: 2 })
  let called = 0
  await withFetch(() => { called++; return llm(GO)() }, () => runOnce(h2))
  assert.equal(called, 0, 'halted cycle makes no reviewer call')
  assert.equal(h2.placed.length, 0)
  assert.match(String(h2.svc.status().runtime.lastRejection), /halted/)
  assert.deepEqual(h2.svc.restartCompound(), { ok: true })
  assert.equal(h2.svc.status().runtime.halted, false)
  // shadow decisions never touch the pot
  const h3 = harness('auto', series())
  await boot(h3, { ...BASE, live: false, stakePlan: { kind: 'compound', base: 2 } as never })
  await withFetch(llm(GO), () => runOnce(h3))
  assert.equal(h3.placed.length, 0)
  assert.equal(h3.svc.status().runtime.pot ?? 0, 0)
  // a changed plan starts a fresh roll; junk plans are dropped
  h.svc.configure({ stakePlan: { kind: 'compound', base: 5 } as never })
  assert.equal(h.svc.stakeFor(), 5)
  h.svc.configure({ stakePlan: { kind: 'martingale' } as never })
  assert.equal(h.svc.status().config.stakePlan, undefined)
  assert.equal(h.svc.stakeFor(), 1)
})

test('config: watchMode defaults to ALL, bad values fall back, the selected list is de-duplicated', async () => {
  const h = harness('auto', series())
  await h.svc.start(h.ctx as never)
  assert.equal(h.svc.configure({} as never).watchMode, 'all')
  assert.equal(h.svc.configure({ watchMode: 'nonsense' } as never).watchMode, 'all')
  const c = h.svc.configure({ watchMode: 'selected', assets: ['A', 'B', 'A', '', 5 as never] } as never)
  assert.equal(c.watchMode, 'selected')
  assert.deepEqual(c.assets, ['A', 'B'])
  h.svc.stop()
})

test('FEED WARMING: the trader exposes the pairs it watches so market-data keeps them fresh (disabled = none)', async () => {
  const h = harness('auto', series(), { direction: 'none', confidence: 0, notes: '' }, MANY)
  await boot(h, { enabled: false, watchMode: 'all', marketScope: 'all' })
  assert.deepEqual(h.svc.watchedAssets(), [])
  h.svc.configure({ enabled: true } as never)
  assert.equal(h.svc.watchedAssets().length, 50)
  assert.ok(!h.svc.watchedAssets().includes('CLOSED1'))
  h.svc.configure({ watchMode: 'selected', assets: ['PAIR3', 'OTC2'] } as never)
  assert.deepEqual([...h.svc.watchedAssets()].sort(), ['OTC2', 'PAIR3'])
  h.svc.stop()
})

test('STALE feeds are reported: pairs whose last closed bar is old are counted so a frozen feed is visible, not silent', async () => {
  const h = harness('auto', oldSeries(), { direction: 'none', confidence: 0, notes: '' }, MANY)
  await boot(h, { ...BASE, live: false, watchMode: 'all', marketScope: 'all' })
  await runOnce(h)
  const rt = h.svc.status().runtime as { lastScanStale?: number; staleSample?: string[] }
  assert.equal(rt.lastScanStale, 50)
  assert.ok((rt.staleSample ?? []).length > 0)
  const now = Math.floor(Date.now() / 1000)
  const fresh = series().map((c, i, a) => ({ ...c, time: now - (a.length - 1 - i) * 60 - 60 }))
  const h2 = harness('auto', fresh, { direction: 'none', confidence: 0, notes: '' }, MANY)
  await boot(h2, { ...BASE, live: false, watchMode: 'all', marketScope: 'all' })
  await runOnce(h2)
  assert.equal((h2.svc.status().runtime as { lastScanStale?: number }).lastScanStale, 0)
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
