// IQAIR//OS - tests for the Brain (analytics/brain.ts) and the Brain Trader plugin (plugins/braintrader.ts).
//   npx tsx tests/brain-trader.test.ts      (from mini-services/trading-core)
//
// HONESTY NOTE: planted-structure tests prove the brain finds and orients a structure that was put there on purpose, and that the trader
// plumbing (review, veto, fail-closed, shadow vs live, scoring) behaves. They say nothing about whether the brain or the reviewer has an
// edge on a real market - that is only answered by the decision log's hit rates over a long real-data run.
import assert from 'node:assert/strict'
import { readBrain, BRAIN_MIN_BARS, DEFAULT_BRAIN_STRATEGY, sanitizeBrainStrategy } from '../src/analytics/brain'
import { BrainTraderService, parseReview, snapExpiry, buildReviewMessages, resolveOutcome, computeStats, type BrainDecision } from '../src/plugins/braintrader'
import type { Candle } from '../src/types'

type Test = { name: string; fn: () => void | Promise<void> }
const tests: Test[] = []
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn })

function rng(seed:number){let s=seed;return()=>{s=(s*1664525+1013904223)%4294967296;return s/4294967296}}
const gauss=(r:()=>number)=>Math.sqrt(-2*Math.log(r()||1e-9))*Math.cos(2*Math.PI*r())
type C={time:number;open:number;high:number;low:number;close:number;volume:number}
/** wyckoff cycle: accum (down trend) or distribution (mirror). stages controls how far it runs */
function wy(seed:number, accum:boolean, stage:'range'|'spring'|'sos'|'lps'|'markup', flatVol=false){
  const r=rng(seed); const sg=accum?1:-1; // sg=+1: price falls into range then rises
  const closes:number[]=[],vol:number[]=[],hiX:number[]=[],loX:number[]=[]
  const push=(c:number,v:number,wick=0.1,extraHi=0,extraLo=0)=>{closes.push(c);vol.push(flatVol?10:v);hiX.push(extraHi);loX.push(extraLo)}
  let x=100
  for(let i=0;i<80;i++){x+=gauss(r)*0.5;push(x,10*(0.6+0.8*r()))}
  for(let i=0;i<40;i++){x-=sg*(0.4+gauss(r)*0.1);push(x,10*(0.6+0.8*r()))}       // prior trend into range
  // selling climax bar: wide, high volume, closes off the extreme
  x-=sg*1.0; push(x+sg*0.6, 45, 0, 0, 0); closes[closes.length-1]=x+sg*0.6;
  const base=x // the extreme (support for accum)
  const S=base, W=4
  // range: oscillate between S and S+W (accum: up from S)
  const rngLen=55
  for(let i=0;i<rngLen;i++){const t=i/rngLen;const p=S+sg*(W/2+ (W/2)*Math.sin(i*0.55)+gauss(r)*0.12);push(p,10*(0.6+0.8*r()))}
  const rngEnd=closes.length
  if(stage==='range') return finish()
  // spring: poke beyond support by 0.7 then reclaim (low volume)
  push(S-sg*0.2, 5, 0, 0, 0); closes[closes.length-1]=S-sg*0.2
  {const k=closes.length-1; if(accum) loX[k]=0.55; else hiX[k]=0.55}
  push(S+sg*1.2, 6)
  for(let i=0;i<6;i++){push(S+sg*(W/2+gauss(r)*0.4),10*(0.6+0.8*r()))}
  if(stage==='spring') return finish()
  // SOS: decisive expansion through the far edge with volume
  const R=S+sg*W
  push(R+sg*1.8, 38)
  if(stage==='sos') return finish()
  // LPS pullback holding the old resistance, then markup
  for(let i=0;i<4;i++){push(R+sg*(1.6-0.35*i+gauss(r)*0.1),7)}
  push(R+sg*0.6,6)
  if(stage==='lps') return finish()
  for(let i=0;i<16;i++){push(closes[closes.length-1]+sg*0.55+gauss(r)*0.1,14)}
  return finish()
  function finish(){const rr=rng(seed+500);return closes.map((c,i)=>{const o=i?closes[i-1]:c;return{time:1.7e9+i*60,open:o,high:Math.max(o,c)+rr()*0.1+hiX[i],low:Math.min(o,c)-rr()*0.1+loX[i],close:c,volume:vol[i]}}) as C[]}
}
function rw(n:number,seed:number){const r=rng(seed);let x=100;const out:C[]=[];for(let i=0;i<n;i++){const o=x;x+=gauss(r);out.push({time:1.7e9+i*60,open:o,high:Math.max(o,x)+r()*.1,low:Math.min(o,x)-r()*.1,close:x,volume:10*(0.6+0.8*r())})}return out}


const SEEDS = 40

test('thin history: no read, no proposal', () => {
  const r = readBrain(rw(BRAIN_MIN_BARS - 20, 1) as Candle[])
  assert.equal(r.ok, false)
  assert.equal(r.proposal, false)
})

test('planted Wyckoff phase D (both sides): the reversal playbook names the right direction, never the wrong one', () => {
  for (const accum of [true, false]) {
    let right = 0
    let wrong = 0
    for (let s = 1; s <= SEEDS; s++) {
      const r = readBrain(wy(s, accum, 'lps') as Candle[], { minAgree: 1 })
      const want = accum ? 'call' : 'put'
      if (r.candidate === want) right++
      else if (r.candidate !== 'none') wrong++
    }
    assert.equal(wrong, 0, `${accum ? 'accumulation' : 'distribution'}: ${wrong} wrong-direction candidates`)
    assert.ok(right / SEEDS >= 0.8, `${accum ? 'accumulation' : 'distribution'}: only ${right}/${SEEDS} named the planted direction`)
  }
})

test('the confluence gate: a lone anchor is not a proposal at the default minAgree, and a proposal needs the agreeing families it claims', () => {
  let loneProposals = 0
  for (let s = 1; s <= SEEDS; s++) {
    const strict = readBrain(wy(s, true, 'lps') as Candle[])
    const loose = readBrain(wy(s, true, 'lps') as Candle[], { minAgree: 1 })
    if (strict.proposal) assert.ok(strict.agree.length >= 3)
    if (loose.proposal) assert.ok(loose.agree.length >= 1 && loose.direction === 'call' && loose.invalidation > 0 && loose.confluence > 0)
    if (loose.proposal && !strict.proposal) loneProposals++
  }
  assert.ok(loneProposals > 0, 'expected the strict gate to refuse at least some lone-anchor setups the loose gate accepts')
})

test('random walks: proposals are rare at the default gate (the shape-matching is not a trade machine)', () => {
  let tot = 0
  let prop = 0
  for (let s = 1; s <= 30; s++) {
    const c = rw(500, s * 7) as Candle[]
    for (let end = 160; end <= 500; end += 10) {
      tot++
      if (readBrain(c.slice(0, end)).proposal) prop++
    }
  }
  assert.ok(prop / tot <= 0.04, `random walks proposed on ${((prop / tot) * 100).toFixed(1)}% of reads`)
})

test('deterministic and causal: the same closed bars always give the same read', () => {
  const c = wy(3, true, 'lps') as Candle[]
  assert.deepEqual(readBrain(c, { minAgree: 1 }), readBrain(c.slice(), { minAgree: 1 }))
})

test('parseReview: clean JSON, JSON inside prose, expiry snapped to the allowed list', () => {
  const ok = parseReview('{"decision":"go","expirySec":200,"confidence":71,"reason":"clean sweep"}', [60, 180, 300])!
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

test('review prompt: carries the evidence and the constraints the reviewer must respect', () => {
  const r = readBrain(wy(1, true, 'lps') as Candle[], { minAgree: 1 })
  const msgs = buildReviewMessages('EURUSD', '1m', r, wy(1, true, 'lps') as Candle[], [60, 180, 300])
  const all = msgs.map((m) => m.content).join('\n')
  assert.ok(/60, 180, 300/.test(all))
  assert.ok(/NOT a win probability/.test(all))
  assert.ok(/cannot change the direction/i.test(all))
  assert.ok(/READERS:/.test(all) && /wyckoff/.test(all))
  assert.ok(/LAST 12 CLOSED BARS/.test(all))
})

const mkDec = (over: Partial<BrainDecision>): BrainDecision => ({
  id: 'x', ts: 0, asset: 'EURUSD', tf: '1m', barTime: 1_000_000, direction: 'call', playbook: 'reversal', regime: 'range', confluence: 60,
  agree: ['wyckoff'], oppose: [], reason: '', entryPrice: 100, expirySec: 120, status: 'approved', placed: false, ...over,
})
const bar = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 1 })

test('resolveOutcome: scores at entry + expiry bars, call and put, tie, and not-yet-resolvable', () => {
  const candles = [bar(1_000_000, 100), bar(1_000_060, 100.5), bar(1_000_120, 101)]
  assert.deepEqual(resolveOutcome(mkDec({}), candles), { outcome: 'win', exitPrice: 101 })
  assert.equal(resolveOutcome(mkDec({ direction: 'put' }), candles)!.outcome, 'loss')
  assert.equal(resolveOutcome(mkDec({ entryPrice: 101 }), candles)!.outcome, 'tie')
  assert.equal(resolveOutcome(mkDec({ expirySec: 600 }), candles), null)
})

test('computeStats: groups proposed / approved / vetoed and reports the lift only when both sides have outcomes', () => {
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
function harness(mode: 'auto' | 'human', series: Candle[]) {
  const placed: unknown[] = []
  let cfgRow: unknown = null
  let logRow: unknown = null
  const store = {
    getBrainTraderConfig: () => cfgRow, saveBrainTraderConfig: (c: unknown) => { cfgRow = c },
    getBrainTraderLog: () => logRow, saveBrainTraderLog: (l: unknown) => { logRow = l },
    listPositions: () => [] as unknown[],
  }
  const market = { listAssets: () => [{ ticker: 'EURUSD', open: true, otc: false }], getCandlesDeep: () => series }
  const services: Record<string, unknown> = {
    store, market,
    mode: { status: () => ({ mode }) },
    execution: { accountSource: 'paper', placeOrder: async (req: unknown) => { placed.push(req); return { ok: true } } },
  }
  const ctx = { use: (n: string) => services[n], bus: { on: () => () => {} }, log: () => {}, provide: () => {} }
  const svc = new BrainTraderService()
  return { svc, ctx, placed, getLog: () => logRow as BrainDecision[] }
}
const planted = () => wy(1, true, 'lps') as Candle[]
async function boot(h: ReturnType<typeof harness>, cfg: Record<string, unknown>) {
  await h.svc.start(h.ctx as never)
  h.svc.configure(cfg as never)
}
async function runOnce(h: ReturnType<typeof harness>) {
  await (h.svc as unknown as { tick(): Promise<void> }).tick()
  h.svc.stop()
}
const withFetch = async (reply: () => Promise<Response> | Response, fn: () => Promise<void>) => {
  const real = globalThis.fetch
  globalThis.fetch = (async () => reply()) as typeof fetch
  try { await fn() } finally { globalThis.fetch = real }
}
const llm = (content: string) => () => new Response(JSON.stringify({ ok: true, content, provider: 'test', model: 'm' }), { status: 200 })
const BASE = { enabled: true, minAgree: 1, minConfluence: 0, cooldownSec: 0 }

test('shadow mode: reviewer says go, the decision is logged as approved, NO order is placed', async () => {
  const h = harness('auto', planted())
  await boot(h, { ...BASE, live: false })
  await withFetch(llm('{"decision":"go","expirySec":300,"confidence":66,"reason":"ok"}'), () => runOnce(h))
  const log = h.getLog()
  assert.equal(log.length, 1)
  assert.equal(log[0].status, 'approved')
  assert.equal(log[0].direction, 'call')
  assert.equal(log[0].expirySec, 300)
  assert.equal(log[0].placed, false)
  assert.equal(h.placed.length, 0)
})

test('live + AUTO: reviewer go places one order with the reviewer\'s expiry; the same go in human mode only logs', async () => {
  const h = harness('auto', planted())
  await boot(h, { ...BASE, live: true })
  await withFetch(llm('{"decision":"go","expirySec":180,"confidence":70,"reason":"ok"}'), () => runOnce(h))
  assert.equal(h.placed.length, 1)
  const req = h.placed[0] as { side: string; expirySec: number; note: string; amount: number }
  assert.equal(req.side, 'call')
  assert.equal(req.expirySec, 180)
  assert.ok(req.note.startsWith('brain:trader'))
  assert.equal(h.getLog()[0].placed, true)
  const h2 = harness('human', planted())
  await boot(h2, { ...BASE, live: true })
  await withFetch(llm('{"decision":"go","expirySec":180,"confidence":70,"reason":"ok"}'), () => runOnce(h2))
  assert.equal(h2.placed.length, 0)
  assert.match(String(h2.getLog()[0].placeError), /not AUTO/)
})

test('veto: reviewer says no, nothing is placed even when live, and the vetoed proposal is still logged for scoring', async () => {
  const h = harness('auto', planted())
  await boot(h, { ...BASE, live: true })
  await withFetch(llm('{"decision":"no","expirySec":60,"confidence":30,"reason":"stale sweep"}'), () => runOnce(h))
  assert.equal(h.placed.length, 0)
  const d = h.getLog()[0]
  assert.equal(d.status, 'vetoed')
  assert.equal(d.ai?.go, false)
  assert.equal(d.placed, false)
})

test('fail closed: garbage reply and an unreachable reviewer both veto, never trade', async () => {
  const h = harness('auto', planted())
  await boot(h, { ...BASE, live: true })
  await withFetch(llm('sure, buy it!'), () => runOnce(h))
  assert.equal(h.getLog()[0].status, 'ai_unavailable')
  assert.equal(h.placed.length, 0)
  const h2 = harness('auto', planted())
  await boot(h2, { ...BASE, live: true })
  await withFetch(() => { throw new Error('connection refused') }, () => runOnce(h2))
  assert.equal(h2.getLog()[0].status, 'ai_unavailable')
  assert.equal(h2.placed.length, 0)
})

test('the same closed bar is never read twice, and the hourly review cap is enforced', async () => {
  const h = harness('auto', planted())
  await boot(h, { ...BASE, live: false })
  const tick = () => (h.svc as unknown as { tick(): Promise<void> }).tick()
  await withFetch(llm('{"decision":"go","expirySec":180,"confidence":60,"reason":"ok"}'), async () => {
    await tick()
    await tick()
  })
  h.svc.stop()
  assert.equal(h.getLog().length, 1)
  const h2 = harness('auto', planted())
  await boot(h2, { ...BASE, live: false, maxReviewsPerHour: 1 })
  ;(h2.svc as unknown as { reviewTimes: number[] }).reviewTimes = [Date.now()]
  await withFetch(llm('{"decision":"go","expirySec":180,"confidence":60,"reason":"ok"}'), () => runOnce(h2))
  assert.equal(h2.getLog()[0].status, 'rate_limited')
  assert.equal(h2.placed.length, 0)
})

test('config sanitising: expiries clamped and sorted, minAgree bounded, defaults are SHADOW + AI required', async () => {
  const h = harness('auto', planted())
  await h.svc.start(h.ctx as never)
  const fresh = h.svc.configure({} as never)
  assert.equal(fresh.live, false)
  assert.equal(fresh.requireAi, true)
  assert.equal(fresh.enabled, false)
  const c = h.svc.configure({ expiriesSec: [300, 1, 60, 99999, 60], minAgree: 99, defaultExpirySec: 70 } as never)
  assert.deepEqual(c.expiriesSec, [60, 300])
  assert.equal(c.minAgree, 5)
  assert.equal(c.defaultExpirySec, 60)
  h.svc.stop()
})


test('strategy: defaults are valid, bad input is clamped, a partial patch keeps the rest', () => {
  const d = sanitizeBrainStrategy()
  assert.deepEqual(d, DEFAULT_BRAIN_STRATEGY)
  const w = sanitizeBrainStrategy({ minAgree: 99, trendEr: 5, rangeEr: 5, rangeEdge: -1, fibZoneLo: 0.9, fibZoneHi: 0.2, weights: { fib: 100 } as never, playbooks: { reversal: false } as never })
  assert.equal(w.minAgree, 5)
  assert.ok(w.trendEr <= 0.9 && w.rangeEr < w.trendEr)
  assert.ok(w.rangeEdge >= 0.05)
  assert.ok(w.fibZoneHi >= w.fibZoneLo + 0.05)
  assert.equal(w.weights.fib, 5)
  assert.equal(w.weights.smc, 1.5)
  assert.equal(w.playbooks.reversal, false)
  assert.equal(w.playbooks.continuation, true)
})

test('strategy: switching the reversal playbook off removes reversal proposals; switching a reader off removes its vote', () => {
  let revOn = 0
  let revOff = 0
  let wyVotes = 0
  let wyMuted = 0
  for (let s = 1; s <= SEEDS; s++) {
    const c = wy(s, true, 'lps') as Candle[]
    if (readBrain(c, { minAgree: 1 }).playbook === 'reversal') revOn++
    if (readBrain(c, { minAgree: 1, playbooks: { reversal: false, continuation: true, range_fade: true } }).playbook === 'reversal') revOff++
    if (readBrain(c, { minAgree: 1 }).components.find((x) => x.family === 'wyckoff')!.dir !== 0) wyVotes++
    const muted = readBrain(c, { minAgree: 1, families: { fib: true, smc: true, candle: true, amd: true, wyckoff: false } })
    const comp = muted.components.find((x) => x.family === 'wyckoff')!
    if (comp.dir !== 0 || muted.agree.includes('wyckoff')) wyMuted++
    assert.match(comp.note, /disabled in the strategy/)
  }
  assert.ok(revOn / SEEDS >= 0.8, `reversal playbook only on ${revOn}/${SEEDS}`)
  assert.equal(revOff, 0)
  assert.ok(wyVotes / SEEDS >= 0.8)
  assert.equal(wyMuted, 0)
})

test('strategy: the brain config deep-merges a partial strategy patch and keeps minAgree in lockstep', async () => {
  const h = harness('auto', planted())
  await h.svc.start(h.ctx as never)
  h.svc.configure({ strategy: { playbooks: { reversal: false } } } as never)
  let c = h.svc.configure({ strategy: { weights: { fib: 3 } } } as never)
  assert.equal(c.strategy.playbooks.reversal, false)
  assert.equal(c.strategy.weights.fib, 3)
  assert.equal(c.strategy.weights.smc, 1.5)
  c = h.svc.configure({ minAgree: 4 } as never)
  assert.equal(c.strategy.minAgree, 4)
  c = h.svc.configure({ strategy: { minAgree: 2 } } as never)
  assert.equal(c.minAgree, 2)
  h.svc.stop()
})

test('mind(): reads one asset on demand with the configured strategy - no AI call, no log entry, no order', async () => {
  const h = harness('auto', planted())
  await h.svc.start(h.ctx as never)
  h.svc.configure({ strategy: { minAgree: 1 } } as never)
  let fetched = 0
  await withFetch(() => { fetched++; return llm('{}')() }, async () => {
    const m = h.svc.mind('EURUSD')
    assert.equal(m.read.ok, true)
    assert.equal(m.read.candidate, 'call')
    assert.equal(m.tf, '1m')
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
