// IQAIR//OS - tests: ai.* (analytics/mslai.ts) with a mocked model
import assert from 'node:assert/strict'
import type { Candle } from '../src/types'
import { backtestMslScript } from '../src/analytics/mslbacktest'
import { evaluateStrategyScript, parseStrategyScript } from '../src/analytics/strategylang'
import { aiReadingFor, clearAiCache, parseReading, setMslAiChat, setMslAiEnabled, aiVet, aiAnalyze } from '../src/analytics/mslai'

const T0 = 1_700_000_000
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
function walk(n: number): Candle[] {
  const r = rng(3), out: Candle[] = []
  let x = 100
  for (let i = 0; i < n; i++) { const o = x; x += (r() - 0.5) * 0.6; out.push({ time: T0 + i * 60, open: o, high: Math.max(o, x) + 0.05, low: Math.min(o, x) - 0.05, close: x, volume: 100 }) }
  return out
}
const SCRIPT = 'if ai.ready() and ai.side() == "call" and ai.conf() >= 60 and not ai.veto()\n  call when true\nend'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let pass = 0, total = 0
const test = async (n: string, f: () => Promise<void> | void) => { total++; try { await f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }

await test('script parses', () => assert.equal(parseStrategyScript(SCRIPT).ok, true))
await test('parseReading is strict and clamps', () => {
  assert.equal(parseReading('nonsense'), null)
  const a = parseReading('here: {"side":"call","confidence":150,"risk":"low","regime":"trend","reason":"x"}')!
  assert.equal(a.side, 'call'); assert.equal(a.confidence, 100)
  assert.equal(parseReading('{"side":"banana","confidence":90}')!.side, 'none')
})
await test('no provider: off, never throws out of the reader', () => {
  setMslAiEnabled(false); setMslAiChat(null); clearAiCache()
  assert.equal(aiReadingFor(walk(200)).state, 'off')
})
await test('first call is pending, a later call reads the cached verdict', async () => {
  clearAiCache(); setMslAiEnabled(true)
  let calls = 0
  setMslAiChat(async () => { calls++; return '{"side":"call","confidence":72,"risk":"low","regime":"drift","reason":"test"}' })
  const c = walk(200)
  assert.equal(aiReadingFor(c).state, 'pending')
  await sleep(30)
  const st = aiReadingFor(c)
  assert.equal(st.state, 'ready'); assert.equal(st.reading!.side, 'call')
  aiReadingFor(c); aiReadingFor(c)
  assert.equal(calls, 1, 'one model call per bar fingerprint')
})
await test('model failure becomes an error state, not a crash', async () => {
  clearAiCache(); setMslAiEnabled(true)
  setMslAiChat(async () => { throw new Error('boom') })
  const c = walk(210)
  aiReadingFor(c); await sleep(30)
  assert.equal(aiReadingFor(c).state, 'error')
})
await test('backtests never call the model', () => {
  clearAiCache(); setMslAiEnabled(true)
  let calls = 0
  setMslAiChat(async () => { calls++; return '{"side":"call","confidence":99,"risk":"low"}' })
  const res = backtestMslScript(walk(300), SCRIPT, { expiryBars: 1, warmupBars: 100, runId: 'ai' })
  assert.equal(res.trades.length, 0)
  assert.equal(calls, 0)
})
await test('vet and analyze pass the evidence to the model and return its text', async () => {
  let seen = ''
  setMslAiChat(async (m) => { seen = m.map((x) => x.content).join('\n'); return 'verdict: unproven' })
  assert.equal(await aiVet('if true\n call when true\nend', 'trades 12'), 'verdict: unproven')
  assert.ok(seen.includes('trades 12') && seen.includes('call when true'))
  assert.equal(await aiAnalyze(walk(200), 'why?', 'asset X'), 'verdict: unproven')
  assert.ok(seen.includes('last 40 candles'))
})
void evaluateStrategyScript
console.log(pass === total ? `all ${pass} passed` : `${total - pass} FAILED`)
if (pass !== total) process.exit(1)
