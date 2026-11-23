import assert from 'node:assert/strict'
import { readFinderAsset, chooseExpiry, type FinderFrame } from '../src/analytics/finder'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const T0 = 1_700_006_400
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) }
type C = { time: number; open: number; high: number; low: number; close: number; volume: number }
function walk(n: number, seed: number, drift = 0, vol = 0.4): C[] { const r = rng(seed); const out: C[] = []; let x = 100; for (let i = 0; i < n; i++) { const o = x; x += drift + (r() - 0.5) * vol; const hi = Math.max(o, x) + r() * 0.1, lo = Math.min(o, x) - r() * 0.1; out.push({ time: T0 + i * 60, open: o, close: x, high: hi, low: lo, volume: 100 + r() * 50 }) } return out }
function agg(c: C[], k: number): C[] { const out: C[] = []; for (let i = 0; i + k <= c.length; i += k) { const s = c.slice(i, i + k); out.push({ time: s[0].time, open: s[0].open, close: s[k - 1].close, high: Math.max(...s.map((x) => x.high)), low: Math.min(...s.map((x) => x.low)), volume: s.reduce((a, x) => a + x.volume, 0) }) } return out }
const framesOf = (m1: C[]): FinderFrame[] => [{ tf: '1m', sec: 60, candles: m1 }, { tf: '2m', sec: 120, candles: agg(m1, 2) }, { tf: '5m', sec: 300, candles: agg(m1, 5) }]
const NOW = T0 + 4000 * 60
test('thin history is a clean not-found', () => { const r = readFinderAsset(framesOf(walk(300, 1)), { mode: 'option', asset: 'EURUSD', nowSec: NOW }); assert.equal(r.found, false) })
test('never throws and respects 1-30 min expiry on many random walks (option)', () => {
  let found = 0, n = 0
  for (let s = 1; s <= 12; s++) { const r = readFinderAsset(framesOf(walk(3000, s * 13)), { mode: 'option', asset: 'EURUSD', nowSec: NOW }); n++; assert.ok(r.ok); if (r.found) { found++; assert.ok(r.expiry && r.expiry.minutes >= 1 && r.expiry.minutes <= 30, JSON.stringify(r.expiry)); assert.ok(r.side !== 'none') } }
  console.log(`   random walks: ${found}/${n} produced a trade`)
  assert.ok(found <= Math.ceil(n * 0.4), `too many invented trades: ${found}/${n}`)
})
test('cfd mode: when found, stop and target sit on the correct sides with rr >= 1.5', () => {
  let seen = 0
  for (let s = 1; s <= 30 && seen < 3; s++) { const r = readFinderAsset(framesOf(walk(3000, s * 7, s % 2 ? 0.02 : -0.02)), { mode: 'cfd', asset: 'EURUSD', nowSec: NOW }); if (r.found && r.cfd) { seen++; const c = r.cfd; if (r.side === 'call') assert.ok(c.stop < c.entry && c.target > c.entry); else assert.ok(c.stop > c.entry && c.target < c.entry); assert.ok(c.rr >= 1.5 && c.tpPct > 0 && c.slPct > 0) } }
  console.log(`   cfd setups seen: ${seen}`)
})
test('every rejection carries a reason', () => { const r = readFinderAsset(framesOf(walk(3000, 99)), { mode: 'option', asset: 'EURUSD', nowSec: NOW }); if (!r.found) assert.ok(r.rejected.length > 0 && r.text.length > 5) })
test('chooseExpiry stays within bounds and returns a table', () => { const f = framesOf(walk(3000, 5))[0]; const e = chooseExpiry(f, 'call', false); assert.ok(e.minutes >= 1 && e.minutes <= 30 && e.table.length > 3) })
test('OTC flag runs through', () => { const r = readFinderAsset(framesOf(walk(3000, 8)), { mode: 'option', asset: 'EURUSD-OTC', otc: true, nowSec: NOW }); assert.ok(r.ok && r.session === 'OTC') })
test('finder uses pm + Weis wave only: frames carry the wave read, nothing mentions nm, expiry comes from wave rhythm', () => {
  let seen = 0
  for (let s = 1; s <= 8; s++) {
    const r = readFinderAsset(framesOf(walk(3000, s * 11, s % 2 ? 0.03 : -0.03)), { mode: 'option', asset: 'EURUSD', nowSec: NOW })
    for (const f of r.frames) { seen++; assert.ok(['call', 'put', 'none'].includes(f.ww) && ['with', 'against', 'neutral'].includes(f.wwAlign) && typeof f.wwText === 'string'); assert.equal((f as unknown as Record<string, unknown>).nmRecord, undefined) }
    assert.ok(!/\bnm\b/i.test(r.text + r.story.join(' ')), 'nm leaked into the text')
    if (r.expiry) assert.ok(r.expiry.basis.includes('Weis wave') || r.expiry.basis.includes('too few waves'), r.expiry.basis)
  }
  assert.ok(seen > 0)
})
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
