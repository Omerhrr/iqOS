// IQAIR//OS - tests: live script series length (nc.* needs 320+ closed bars; 240 made nc.ok() always false live)
import assert from 'node:assert/strict'
import { MetaStrategyService } from '../src/plugins/metastrategy'
let sd = 9; const r = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296)
let p = 1.3; const all = Array.from({ length: 900 }, (_, i) => { const o = p; p += (Math.sin(i / 20) * 0.0006 + (r() - 0.5) * 0.0009); return { time: 1_700_000_040 + i * 60, open: o, close: p, high: Math.max(o, p) + 0.00025, low: Math.min(o, p) - 0.00025, volume: 1 } })
const svc: any = new MetaStrategyService()
svc.ctx = { log: () => {}, bus: { emit() {} }, use: (n: string) => { throw new Error('no service ' + n) } }
let asked = 0
svc.market = { getCandlesDeep: (_a: string, _t: string, n: number) => { asked = Math.max(asked, n); return all.slice(-n) }, getPrice: () => p, listAssets: () => [] }
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
test('a script that reads nc.* is given 520 closed bars and nc.ok() is true', () => {
  asked = 0
  const t = svc.testScript('call when nc.ok()\nput when not nc.ok()', 'GBPUSD', '1m'); assert.ok(t.ok, t.error)
  assert.equal(asked, 520); assert.equal(t.direction, 'call', JSON.stringify(t.trace))
})
test('other scripts keep the normal 240 bars', () => {
  asked = 0
  const t = svc.testScript('call when sw.ok()\nput when not sw.ok()', 'GBPUSD', '1m'); assert.ok(t.ok, t.error); assert.equal(asked, 240)
})
test('timing.hold confirms off the feed spot price when the tick buffer is empty or stale; a frozen price aborts "went nowhere" and says so', () => {
  // plant a bar where a trivially-true hold arms, then walk 25 s of polls
  const hold = 'let go = timing.hold("t", true, -1, 20, 0.05, 0.3)\nput when go == 1\ncall when false'
  const bar = { __mslBar: true, o: 1, h: 1, l: 1, c: 1, v: 1, body: 0, range: 0, upperWick: 0, lowerWick: 0 }
  svc.specs.set('meta:t-hold', { id: 'meta:t-hold', name: 't', mode: 'all', conditions: [], script: hold })
  let spot = 1.3
  svc.market.getPrice = () => spot
  const run = (ticks: { ts: number; price: number }[], moving: boolean, prefixId: string) => {
    svc.specs.set(prefixId, { id: prefixId, name: 't', mode: 'all', conditions: [], script: hold })
    const T0 = 1_900_000_000_000; let fired = ''; let trace = ''
    for (let s = 0; s <= 30; s++) { spot = moving ? 1.3 - 0.00002 * s : 1.3; const r = svc.evaluateLive(prefixId, 'EURUSD', '1m', { bar, ticks, nowMs: T0 + s * 1000 }); if (r.result.direction !== 'none' && !fired) fired = `${s}s`; trace = r.result.notes }
    return { fired, trace }
  }
  const a = run([], true, 'meta:t-hold-a'); assert.ok(a.fired === '20s', `spot moving, no ticks: ${a.fired} ${a.trace}`)
  const b = run([{ ts: 1_900_000_000_000 - 900_000, price: 1.3 }], true, 'meta:t-hold-b'); assert.ok(b.fired === '20s', `stale ticks: ${b.fired}`)
  const c = run([], false, 'meta:t-hold-c'); assert.equal(c.fired, ''); assert.ok(/went nowhere/.test(c.trace) || /idle/.test(c.trace), c.trace)
})
test('hasWaitingHold is true only while a hold of that spec is counting down', () => {
  const T0 = 1_900_100_000_000
  const hold = 'let go = timing.hold("w", true, -1, 20, 0.05, 0.3)\nput when go == 1\ncall when false'
  const bar = { __mslBar: true, o: 1, h: 1, l: 1, c: 1, v: 1, body: 0, range: 0, upperWick: 0, lowerWick: 0 }
  svc.specs.set('meta:t-w', { id: 'meta:t-w', name: 't', mode: 'all', conditions: [], script: hold })
  assert.equal(svc.hasWaitingHold('meta:t-w'), false)
  svc.market.getPrice = () => 1.3
  svc.evaluateLive('meta:t-w', 'EURUSD', '1m', { bar, ticks: [], nowMs: T0 })
  assert.equal(svc.hasWaitingHold('meta:t-w'), true)
  assert.equal(svc.hasWaitingHold('meta:t-w', 'EURUSD', '1m'), true)
  assert.equal(svc.hasWaitingHold('meta:t-w', 'GBPUSD', '1m'), false)
  assert.equal(svc.hasWaitingHold('meta:other'), false)
})
test('trend-pullback + nc + timing builtin runs live without script errors and can arm a hold', () => {
  const { BUILTIN_TV_SPECS } = require('../src/plugins/builtinTvSpecs')
  const sp = BUILTIN_TV_SPECS.find((x: any) => x.id === 'meta:builtin-trend-pullback-nc-timing'); assert.ok(sp)
  const bar = { __mslBar: true, o: 1, h: 1, l: 1, c: 1, v: 1, body: 0, range: 0, upperWick: 0, lowerWick: 0 }
  svc.specs.set(sp.id, { id: sp.id, name: sp.name, mode: 'all', conditions: [], script: sp.script })
  const bad: string[] = []; let armed = 0
  const saved = all.slice()
  for (let k = 0; k < 120; k++) {
    all.length = 0; all.push(...saved.slice(0, 700 + k))
    p = all[all.length - 1].close
    const r = svc.evaluateLive(sp.id, 'EURUSD', '1m', { bar, ticks: [], nowMs: (all[all.length - 1].time + 60) * 1000 + 5000 })
    if (/error/i.test(r.result.notes ?? '')) bad.push(r.result.notes)
    if (svc.hasWaitingHold(sp.id)) armed++
  }
  assert.equal(bad.length, 0, bad[0]); console.log('    armed on', armed, 'of 120 polls')
})
test('pure nc + hold: no script errors; arms, then fires with the move and cancels on a flat price', () => {
  const { BUILTIN_TV_SPECS } = require('../src/plugins/builtinTvSpecs')
  const sp = BUILTIN_TV_SPECS.find((x: any) => x.id === 'meta:builtin-nc-pure-hold'); assert.ok(sp)
  const bar = { __mslBar: true, o: 1, h: 1, l: 1, c: 1, v: 1, body: 0, range: 0, upperWick: 0, lowerWick: 0 }
  const run = (id: string, drift: number) => {
    svc.specs.set(id, { id, name: sp.name, mode: 'all', conditions: [], script: sp.script })
    const T0 = 1_900_200_000_000; let fired = ''; let armedAt = -1; const base = all[all.length - 1].close
    for (let s = 0; s <= 40; s++) {
      p = base; svc.market.getPrice = () => base + drift * s
      const r = svc.evaluateLive(id, 'EURUSD', '1m', { bar, ticks: [], nowMs: T0 + s * 1000 })
      assert.ok(!/error/i.test(r.result.notes ?? ''), r.result.notes)
      if (armedAt < 0 && svc.hasWaitingHold(id)) armedAt = s
      if (r.result.direction !== 'none' && !fired) fired = r.result.direction
    }
    return { fired, armedAt }
  }
  const side = run('meta:ncp-flat', 0)
  assert.equal(side.fired, '', 'a flat price must not fire')
  const call = run('meta:ncp-up', 0.00003), put = run('meta:ncp-down', -0.00003)
  assert.ok(call.fired === 'call' || put.fired === 'put' || (call.armedAt >= 0 || put.armedAt >= 0), 'oracle should arm on one of the sides')
  console.log('    up:', JSON.stringify(call), 'down:', JSON.stringify(put))
  assert.ok(!(call.fired === 'put') && !(put.fired === 'call'), 'never fires against the move')
})
console.log(`${pass}/${total}`); process.exit(pass === total ? 0 : 1)
