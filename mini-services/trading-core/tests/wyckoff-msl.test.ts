// IQAIR//OS - tests for the MSL `wyckoff.*` namespace (Wyckoff accumulation / distribution schematic).
//   npx tsx tests/wyckoff-msl.test.ts      (from mini-services/trading-core)
//
// HONESTY NOTE: the planted-market tests prove the DETECTOR finds a schematic that was put there on purpose and labels its phase and
// direction correctly. They say nothing about whether real markets trade this way - only a real-data backtest answers that.
import assert from 'node:assert/strict'
import { parseStrategyScript, evaluateStrategyScript, type MslSeriesCtx } from '../src/analytics/strategylang'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { readWyckoff, WYCKOFF_MIN_BARS } from '../src/analytics/mslwyckoff'
import type { Candle } from '../src/types'

type Test = { name: string; fn: () => void }
const tests: Test[] = []
const test = (name: string, fn: () => void) => tests.push({ name, fn })

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

function toSeries(c: Candle[]): MslSeriesCtx {
  return { open: c.map((x) => x.open), high: c.map((x) => x.high), low: c.map((x) => x.low), close: c.map((x) => x.close), volume: c.map((x) => x.volume ?? 0), time: c.map((x) => x.time) }
}
function run(script: string, series: MslSeriesCtx) {
  const parsed = parseStrategyScript(script)
  assert.ok(parsed.ok, `parse failed: ${!parsed.ok ? parsed.error : ''}`)
  if (!parsed.ok) throw new Error('unreachable')
  return evaluateStrategyScript(parsed.ast, {}, undefined, series, undefined, undefined, undefined)
}
const stages = ['range', 'spring', 'sos', 'lps', 'markup'] as const
const SEEDS = 40

test('planted accumulation / distribution: schematic and direction are right, phases follow the stage (both sides)', () => {
  const want: Record<string, string[]> = { range: ['B', 'C'], spring: ['C'], sos: ['D', 'E'], lps: ['D', 'E'], markup: ['E'] }
  for (const accum of [true, false]) {
    for (const st of stages) {
      let right = 0
      let wrongSide = 0
      for (let s = 1; s <= SEEDS; s++) {
        const r = readWyckoff(wy(s, accum, st) as Candle[])!
        if (r.schematic !== 'none' && (r.schematic === 'accumulation') !== accum) wrongSide++
        if (r.schematic !== 'none' && want[st].includes(r.phase)) right++
      }
      assert.equal(wrongSide, 0, `${accum ? 'acc' : 'dist'} ${st}: ${wrongSide} wrong-side calls`)
      assert.ok(right / SEEDS >= 0.85, `${accum ? 'acc' : 'dist'} ${st}: only ${right}/${SEEDS} read right`)
    }
  }
})

test('planted events: spring / upthrust, SOS / SOW and LPS / LPSY flags land on the matching stage', () => {
  let sp = 0, sosN = 0, lpsN = 0, up = 0, sow = 0, lpsy = 0
  for (let s = 1; s <= SEEDS; s++) {
    if (readWyckoff(wy(s, true, 'spring') as Candle[])!.spring) sp++
    if (readWyckoff(wy(s, true, 'sos') as Candle[])!.sos) sosN++
    if (readWyckoff(wy(s, true, 'lps') as Candle[])!.lps) lpsN++
    if (readWyckoff(wy(s, false, 'spring') as Candle[])!.upthrust) up++
    if (readWyckoff(wy(s, false, 'sos') as Candle[])!.sow) sow++
    if (readWyckoff(wy(s, false, 'lps') as Candle[])!.lpsy) lpsy++
  }
  for (const [n, v] of Object.entries({ sp, sosN, lpsN, up, sow, lpsy })) assert.ok(v / SEEDS >= 0.8, `${n}: ${v}/${SEEDS}`)
})

test('flat volume: still reads the schematic from true range and says volumeOk is false', () => {
  let ok = 0
  for (let s = 1; s <= SEEDS; s++) {
    const r = readWyckoff(wy(s, true, 'markup', true) as Candle[])!
    if (r.schematic === 'accumulation') {
      ok++
      assert.equal(r.volumeOk, false)
    }
  }
  assert.ok(ok / SEEDS >= 0.5, `flat-volume detection only ${ok}/${SEEDS}`)
})

test('random walks: almost every bar reads none (the shape is rare by chance)', () => {
  let tot = 0
  let none = 0
  for (let s = 1; s <= 60; s++) {
    const c = rw(500, s * 7) as Candle[]
    for (let end = 160; end <= 500; end += 10) {
      tot++
      if (readWyckoff(c.slice(0, end))!.schematic === 'none') none++
    }
  }
  assert.ok(none / tot >= 0.98, `random walks labelled ${((1 - none / tot) * 100).toFixed(1)}% of bars`)
})

test('thin history: ok() is false below the minimum and other methods say so', () => {
  const c = rw(WYCKOFF_MIN_BARS - 10, 3) as Candle[]
  assert.equal(readWyckoff(c), null)
  assert.notEqual(run('call when wyckoff.ok()\nconfidence = 50', toSeries(c)).direction, 'call')
  const o = run('call when wyckoff.phase() == "C"\nconfidence = 50', toSeries(c))
  assert.ok(o.error !== undefined && /150/.test(String(o.error)), String(o.error))
})

test('MSL dispatch: schematic / phase / flags / levels through scripts', () => {
  const c = wy(1, true, 'sos') as Candle[]
  const s = toSeries(c)
  const yes = (e: string) => run(`call when ${e}\nconfidence = 50`, s).direction === 'call'
  assert.ok(yes('wyckoff.ok()'))
  assert.ok(yes('wyckoff.schematic() == "accumulation"'))
  assert.ok(yes('wyckoff.accumulation() and not wyckoff.distribution()'))
  assert.ok(yes('wyckoff.sos() and not wyckoff.sow()'))
  assert.ok(yes('wyckoff.dir() == 1 and wyckoff.stage() >= 4'))
  assert.ok(yes('wyckoff.resistance() > wyckoff.support() and wyckoff.rangeBars() >= 20'))
  assert.ok(yes('wyckoff.priorTrend() < 0 - 3'))
  assert.ok(yes('wyckoff.volumeOk() and wyckoff.climax()'))
  const d = toSeries(wy(1, false, 'sos') as Candle[])
  assert.equal(run('call when wyckoff.distribution() and wyckoff.sow() and wyckoff.dir() == 0 - 1\nconfidence = 50', d).direction, 'call')
  const bad = run('call when wyckoff.nope()\nconfidence = 50', s)
  assert.ok(bad.error !== undefined && /unknown wyckoff method/.test(String(bad.error)))
})

test('backtest on random walks: following the schematic is a coin flip (null market)', () => {
  const script = 'call when wyckoff.accumulation() and wyckoff.phase() == "D"\nput when wyckoff.distribution() and wyckoff.phase() == "D"\nconfidence = 55'
  let n = 0
  let w = 0
  for (let s = 1; s <= 40; s++) {
    const res = backtestMslScript(rw(1200, s * 11) as Candle[], script, { expiryBars: 3, warmupBars: 160 })
    assert.equal(res.ok, true)
    n += res.trades.length
    w += res.wins
  }
  // very rare on a random walk: assert only that it does not manufacture an edge
  if (n >= 30) assert.ok(w / n > 0.35 && w / n < 0.65, `random walk ${((w / n) * 100).toFixed(1)}% over ${n} trades`)
})

test('examples parse', () => {
  for (const e of [
    'call when wyckoff.accumulation() and wyckoff.phase() == "D" and wyckoff.sinceRange() <= 6\nconfidence = 55',
    'call when wyckoff.spring() and wyckoff.phase() == "C"\nconfidence = 50',
    'put when wyckoff.upthrust() and wyckoff.volumeOk()\nconfidence = 50',
  ]) {
    const p = parseStrategyScript(e)
    assert.ok(p.ok, !p.ok ? p.error : '')
  }
})

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    t.fn()
    passed++
    console.log(`  ok - ${t.name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL - ${t.name}\n    ${err instanceof Error ? err.message : err}`)
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
if (failed > 0) process.exit(1)
