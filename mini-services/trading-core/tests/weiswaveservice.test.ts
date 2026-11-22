import assert from 'node:assert/strict'
import { WeisWaveService } from '../src/plugins/weiswave'
import type { Candle } from '../src/types'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const build = (legs: Array<[number, number, number]>): Candle[] => { const out: Candle[] = []; let p = 100, t = 1_700_000_000, k = 0; for (const [n, mv, vol] of legs) for (let i = 0; i < n; i++) { const o = p; p += mv / n; out.push({ time: t, open: o, high: Math.max(o, p) + 0.2, low: Math.min(o, p) - 0.2, close: p, volume: vol + (k++ % 5) * 3 }); t += 60 } return out }
const lead: Array<[number, number, number]> = [[30, 0.5, 100], [10, 4, 100], [10, -4, 100]]
const weakUp = build([...lead, [10, 6, 300], [8, -3, 100], [10, 4, 90]]) // spent up-wave -> put
const weakDn = build([...lead, [10, -6, 300], [8, 3, 100], [10, -4, 90]]) // -> call
const thin = build([[20, 1, 100]])
const data: Record<string, Candle[]> = { UP: weakUp, DN: weakDn, THIN: thin }
const mkSvc = () => { const s = new WeisWaveService() as any; s.ctx = { log() {} }; s.market = { getCandles: (a: string) => data[a] ?? [], listAssets: () => Object.keys(data).map((t) => ({ ticker: t, open: true, price: 100, category: 'x' })), isOptionInstrument: () => true }; return s as WeisWaveService }
test('pair read: spent up-wave votes put on every live rung', () => { const r = mkSvc().read('UP', { tfs: ['1m', '5m'] as any }); assert.equal(r.ok, true); assert.equal(r.direction, 'put'); assert.ok(r.net < 0); assert.equal(r.agree, 2); assert.equal(r.best?.direction, 'put') })
test('pair read: spent down-wave votes call', () => { const r = mkSvc().read('DN', { tfs: ['1m'] as any }); assert.equal(r.direction, 'call'); assert.ok(r.net > 0) })
test('thin history is warming, never a fabricated side', () => { const r = mkSvc().read('THIN', { tfs: ['1m'] as any }); assert.equal(r.ok, false); assert.equal(r.direction, 'none'); assert.equal(r.rungs[0].ok, false) })
test('global board: actionable first, warming last, counts add up', () => { const g = mkSvc().globalScan({ tfs: ['1m'] as any }); assert.equal(g.universe, 3); assert.equal(g.live, 2); assert.equal(g.warming, 1); assert.equal(g.calls, 1); assert.equal(g.puts, 1); assert.equal(g.rows[g.rows.length - 1].asset, 'THIN') })
test('TTL cache returns the same row until refresh', () => { const s = mkSvc(); const a = s.read('UP', { tfs: ['1m'] as any }); assert.equal(s.read('UP', { tfs: ['1m'] as any }), a); assert.notEqual(s.read('UP', { tfs: ['1m'] as any, refresh: true }), a) })
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
