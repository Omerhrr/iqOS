// per-slot editable inputs in MetaStrategyService: store, restore, reset, stale-name cleanup, persistence
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
process.chdir(mkdtempSync(join(tmpdir(), 'metain-')))
const { MetaStrategyService } = await import('../src/plugins/metastrategy')
const mk = () => new MetaStrategyService() as any
const SCRIPT = `input pressure = 0.12 min 0.01 max 1 "Pressure"\ninput period = 14 min 1 max 200\nlet s = story.ssp(pressure, 10, period)\ncall when s.direction == "call"\nexpiry = 1\n`
const seed = (svc: any, script = SCRIPT) => svc.specs.set('meta:t', { id: 'meta:t', name: 't', mode: 'all', conditions: [], script, updatedTs: 1 })
test('declared inputs come from the script, values default to the script', () => { const s = mk(); seed(s); const g = s.getInputs('bot:b1', 'meta:t'); assert.deepEqual(g.declared.map((d: any) => d.name), ['pressure', 'period']); assert.deepEqual(g.values, { pressure: 0.12, period: 14 }); assert.deepEqual(g.edited, {}) })
test('editing one slot does not touch another slot or the script', () => {
  const s = mk(); seed(s); s.setInputs('bot:b1', 'meta:t', { period: 5 })
  assert.equal(s.getInputs('bot:b1', 'meta:t').values.period, 5); assert.equal(s.getInputs('bot:b2', 'meta:t').values.period, 14); assert.equal(s.getInputs('omni', 'meta:t').values.period, 14); assert.equal(s.get('meta:t').script, SCRIPT)
})
test('remove the strategy from the slot and add it back: the edits are still there', () => {
  const s = mk(); seed(s); s.setInputs('meta', 'meta:t', { pressure: 0.3 })
  s.specs.delete('meta:t'); assert.equal(s.getInputs('meta', 'meta:t').declared.length, 0) // while it is gone nothing is shown
  seed(s); assert.equal(s.getInputs('meta', 'meta:t').values.pressure, 0.3)
})
test('a value equal to the script default is not stored (a later default change still flows through)', () => {
  const s = mk(); seed(s); s.setInputs('auto', 'meta:t', { period: 14 }); assert.deepEqual(s.getInputs('auto', 'meta:t').edited, {})
  seed(s, SCRIPT.replace('period = 14', 'period = 20')); assert.equal(s.getInputs('auto', 'meta:t').values.period, 20)
})
test('out of range / wrong type edits are rejected with a reason and not stored', () => { const s = mk(); seed(s); const r = s.setInputs('bot:x', 'meta:t', { pressure: 5, period: 'abc' }); assert.equal(r.rejected.length, 2); assert.deepEqual(r.edited, {}) })
test('null puts one input back to the default; reset puts all back', () => {
  const s = mk(); seed(s); s.setInputs('bot:x', 'meta:t', { pressure: 0.5, period: 9 })
  assert.deepEqual(s.setInputs('bot:x', 'meta:t', { pressure: null }).edited, { period: 9 }); assert.deepEqual(s.resetInputs('bot:x', 'meta:t').edited, {})
})
test('an input the script no longer declares is dropped from what runs and reported', () => {
  const s = mk(); seed(s); s.setInputs('bot:x', 'meta:t', { period: 8 }); seed(s, `input pressure = 0.12\nlet s = story.ssp(pressure)\ncall when s.direction == "call"\n`)
  const g = s.getInputs('bot:x', 'meta:t'); assert.deepEqual(g.edited, {}); assert.equal(g.dropped.length, 1)
})
test('edits survive a restart (written to data/meta_inputs.json)', () => {
  const a = mk(); seed(a); a.setInputs('omni', 'meta:t', { pressure: 0.4 }); assert.ok(existsSync(join(process.cwd(), 'data', 'meta_inputs.json')))
  const b = mk(); b.loadInputs(); seed(b); assert.equal(b.getInputs('omni', 'meta:t').values.pressure, 0.4)
})
test('clearSlotInputs forgets a deleted bot only', () => { const s = mk(); seed(s); s.setInputs('bot:gone', 'meta:t', { period: 3 }); s.setInputs('bot:keep', 'meta:t', { period: 4 }); s.clearSlotInputs('bot:gone'); assert.equal(s.getInputs('bot:gone', 'meta:t').values.period, 14); assert.equal(s.getInputs('bot:keep', 'meta:t').values.period, 4) })
test('a conditions-built spec has no inputs', () => { const s = mk(); s.specs.set('meta:c', { id: 'meta:c', name: 'c', mode: 'all', conditions: [], updatedTs: 1 }); assert.deepEqual(s.getInputs('meta', 'meta:c').declared, []) })
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
