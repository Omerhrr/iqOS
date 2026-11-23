import assert from 'node:assert/strict'
import { buildConfig, setSchedule, scheduleBlock, recordScheduleTrade, scheduleText, inWindow, schedKey, parseTz } from '../src/analytics/schedule'
import { stepSage, clearSage, sageKey } from '../src/analytics/sage'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
// 2026-11-16 is a Monday. times given as UTC; tz = GMT+1 so local = UTC+1
const at = (h: number, m = 0, day = 16) => Date.UTC(2026, 10, day, h, m)
let k = 0
const fresh = (a: Parameters<typeof buildConfig>[0]) => { const key = `t${k++}|sched|x`; setSchedule(key, buildConfig(a)); return key }
test('window 13:00-16:00 GMT+1: 12:30 UTC (13:30 local) open, 15:00 UTC (16:00 local) closed, 11:59 UTC closed', () => {
  const key = fresh({ window: '13:00-16:00', tz: 1 })
  assert.equal(scheduleBlock(key, at(12, 30)), ''); assert.ok(scheduleBlock(key, at(15, 0)).includes('outside')); assert.ok(scheduleBlock(key, at(11, 59)).includes('outside')); assert.equal(scheduleBlock(key, at(12, 0)), '')
})
test('2 per hour: third trade in the same local hour is refused, next local hour opens again', () => {
  const key = fresh({ window: '13:00-16:00', tz: 1, perHour: 2 })
  recordScheduleTrade(key, at(12, 5)); recordScheduleTrade(key, at(12, 20))
  assert.ok(scheduleBlock(key, at(12, 40)).includes('hourly')); assert.equal(scheduleBlock(key, at(13, 1)), '')
})
test('window of 3 hours x 2 per hour allows exactly 6 trades, a 4h window allows 8', () => {
  for (const [w, want] of [['13:00-16:00', 6], ['13:00-17:00', 8]] as const) {
    const key = fresh({ window: w, tz: 1, perHour: 2 }); let n = 0
    for (let h = 12; h < 17; h++) for (let t = 0; t < 4; t++) { const now = at(h, t * 10 + 1); if (scheduleBlock(key, now) === '') { recordScheduleTrade(key, now); n++ } }
    assert.equal(n, want)
  }
})
test('daily cap across hours; resets next local day', () => {
  const key = fresh({ window: 'all', tz: 0, perDay: 3 })
  for (let h = 8; h < 11; h++) recordScheduleTrade(key, at(h)); assert.ok(scheduleBlock(key, at(15)).includes('daily')); assert.equal(scheduleBlock(key, at(8, 0, 17)), '')
})
test('local day boundary follows tz (23:30 UTC is already tomorrow at GMT+1)', () => {
  const key = fresh({ window: 'all', tz: 1, perDay: 1 }); recordScheduleTrade(key, at(22, 30)); assert.ok(scheduleBlock(key, at(22, 50)).includes('daily')); assert.equal(scheduleBlock(key, at(23, 10)), '')
})
test('minimum gap spreads trades', () => { const key = fresh({ window: 'all', minGapMin: 20 }); recordScheduleTrade(key, at(10, 0)); assert.ok(scheduleBlock(key, at(10, 10)).includes('gap')); assert.equal(scheduleBlock(key, at(10, 21)), '') })
test('overnight window 22:00-02:00 and weekday filter', () => {
  const key = fresh({ window: '22:00-02:00', tz: 0, days: 'mon-fri' })
  assert.equal(scheduleBlock(key, at(23, 0, 16)), ''); assert.equal(scheduleBlock(key, at(1, 0, 17)), ''); assert.ok(scheduleBlock(key, at(12, 0, 16)).includes('outside'))
  assert.ok(scheduleBlock(key, at(23, 0, 21)).includes('trading day')) // Saturday 21st
  assert.ok(scheduleBlock(key, at(1, 0, 22)).includes('trading day')) // Sunday 01:00 is the tail of SATURDAY's session, so blocked
})
test('several windows and tz parsing', () => { assert.equal(parseTz('GMT+1'), 60); assert.equal(parseTz(5.5), 330); assert.equal(parseTz('-05:00'), -300); const key = fresh({ window: '09:00-11:00,13:00-16:00' }); assert.equal(scheduleBlock(key, at(10)), ''); assert.ok(scheduleBlock(key, at(12)).includes('outside')); assert.equal(scheduleBlock(key, at(14)), '') })
test('bad input throws a readable error', () => { assert.throws(() => buildConfig({ window: '13-' }), /time|window/); assert.throws(() => buildConfig({ window: '25:00-26:00' }), /valid time|read the time/); assert.throws(() => buildConfig({ window: 'all', days: 'funday' }), /days/) })
test('scope: script shares one budget across pairs, pair splits it', () => { assert.equal(schedKey('spec|EURUSD|1m', 'a', 'script'), schedKey('spec|GBPUSD|5m', 'a', 'script')); assert.notEqual(schedKey('spec|EURUSD|1m', 'a', 'pair'), schedKey('spec|GBPUSD|1m', 'a', 'pair')) })
// sage integration: a signal that would enter outside the window never fires, inside it fires and is counted once
const sageIn = (key: string, p: Partial<Parameters<typeof stepSage>[0]>) => stepSage({ key, cond: true, valid: true, dir: 1, seconds: 60, dipAtr: 0.15, abortAtr: 0.5, goAtr: 0.1, recoverFrac: 0.4, straightTake: true, horizonSec: 60, nowMs: 0, price: 100, atr: 1, ...p })
test('sage: closed window never arms; open window fires on a straight move and counts one trade', () => {
  const sk = fresh({ window: '13:00-16:00', tz: 1, perHour: 1 }); const gate = () => scheduleBlock(sk, now), onFire = () => recordScheduleTrade(sk, now)
  let now = at(10, 0); const key = sageKey('p1', 'a'); clearSage('p1')
  let r = sageIn(key, { nowMs: now, price: 100, gate, onFire }); assert.equal(r.rec.state, 'idle'); assert.ok(r.rec.why.includes('schedule'))
  now = at(12, 10); r = sageIn(key, { nowMs: now, price: 100, gate, onFire }); assert.equal(r.rec.state, 'watching')
  now = at(12, 10) + 5000; r = sageIn(key, { nowMs: now, price: 100.3, gate, onFire }); assert.equal(r.fire, true)
  r = sageIn(key, { nowMs: now + 100, price: 100.3, gate, onFire }); assert.equal(r.fire, true) // same instant is idempotent
  assert.ok(scheduleBlock(sk, at(12, 30)).includes('hourly')) // exactly one counted
})
test('sage: window closing while it waits cancels the entry instead of firing', () => {
  const sk = fresh({ window: '13:00-16:00', tz: 1 }); let now = at(14, 59, 16); const gate = () => scheduleBlock(sk, now); clearSage('p2'); const key = sageKey('p2', 'a')
  sageIn(key, { nowMs: now, gate }); now = at(15, 0) + 2000
  const r = sageIn(key, { nowMs: now, price: 100.3, gate }); assert.equal(r.fire, false); assert.ok(r.rec.why.includes('not entered'))
})
test('text reports window, counts and whether a trade can be taken', () => { const key = fresh({ window: '13:00-16:00', tz: 1, perDay: 8, perHour: 2 }); recordScheduleTrade(key, at(12, 5)); const t = scheduleText(key, at(12, 30)); assert.ok(t.includes('13:00-16:00') && t.includes('1/2') && t.includes('1/8') && t.includes('open')) })
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
