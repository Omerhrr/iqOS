// IQAIR//OS - tests for the MSL `input` statement (editable, per-slot settings declared in a script)
import assert from 'node:assert/strict'
import { parseStrategyScript, evaluateStrategyScript, listScriptInputs, sanitizeInputOverrides } from '../src/analytics/strategylang'
let pass = 0, total = 0
const test = (n: string, f: () => void) => { total++; try { f(); console.log('ok ', n); pass++ } catch (e) { console.log('FAIL', n, (e as Error).message) } }
const SRC = `input level = 5 min 1 max 10 "Level"
input fast = true
input mode = "atr" options "atr", "roc"
input neg = -2.5 min -5 max 0
let x = level * 2
call when x >= 10
confidence = x
expiry = 1
`
const run = (src: string, inputs?: Record<string, number | boolean | string>) => { const p = parseStrategyScript(src); assert.ok(p.ok, p.ok ? '' : p.error); return evaluateStrategyScript(p.ast, {}, undefined, undefined, undefined, undefined, undefined, undefined, inputs) }
test('listScriptInputs reads name, type, default, limits, options, label', () => {
  const r = listScriptInputs(SRC); assert.ok(r.ok); if (!r.ok) return
  assert.deepEqual(r.inputs.map((i) => [i.name, i.type, i.def]), [['level', 'number', 5], ['fast', 'boolean', true], ['mode', 'string', 'atr'], ['neg', 'number', -2.5]])
  assert.equal(r.inputs[0].min, 1); assert.equal(r.inputs[0].max, 10); assert.equal(r.inputs[0].label, 'Level'); assert.deepEqual(r.inputs[2].options, ['atr', 'roc']); assert.equal(r.inputs[3].min, -5)
})
test('no overrides: the script default is used', () => { const r = run(SRC); assert.equal(r.error, undefined); assert.equal(r.direction, 'call'); assert.equal(r.confidence, 10) })
test('an override replaces the default without touching the script', () => { const r = run(SRC, { level: 8 }); assert.equal(r.confidence, 16); assert.ok(r.trace.some((t) => /input level = 8 \(edited, script default 5\)/.test(t))) })
test('an override below the minimum is ignored (default used) and the trace says why', () => { const r = run(SRC, { level: 0 }); assert.equal(r.confidence, 10); assert.ok(r.trace.some((t) => /override ignored/.test(t))) })
test('a wrong-type override is ignored', () => { assert.equal(run(SRC, { level: 'abc' as unknown as number }).confidence, 10) })
test('an override for a name the script no longer declares is simply unused', () => { const r = run(SRC, { gone: 3, level: 6 }); assert.equal(r.error, undefined); assert.equal(r.confidence, 12) })
test('boolean and text inputs reach the script', () => {
  const s = `input fast = false\ninput mode = "atr" options "atr", "roc"\ncall when fast and mode == "roc"\nexpiry = 1\n`
  assert.equal(run(s).direction, 'none'); assert.equal(run(s, { fast: true, mode: 'roc' }).direction, 'call'); assert.equal(run(s, { fast: true, mode: 'bad' }).direction, 'none')
})
test('sanitizeInputOverrides returns the valid ones and explains each drop', () => {
  const r = listScriptInputs(SRC); assert.ok(r.ok); if (!r.ok) return
  const s = sanitizeInputOverrides(r.inputs, { level: 11, fast: 'true', mode: 'roc', zzz: 1, neg: -1 })
  assert.deepEqual(s.values, { fast: true, mode: 'roc', neg: -1 }); assert.equal(s.dropped.length, 2)
})
test('declaring an input twice is a syntax error', () => { const p = parseStrategyScript(`input a = 1\ninput a = 2\ncall when a > 0\n`); assert.equal(p.ok, false) })
test('input inside an if block is rejected', () => { const p = parseStrategyScript(`let q = 1\nif q > 0\n  input a = 1\nend\ncall when q > 0\n`); assert.equal(p.ok, false) })
test('default outside its own min/max is rejected', () => { assert.equal(parseStrategyScript(`input a = 50 min 1 max 10\ncall when a > 0\n`).ok, false) })
test('min above max is rejected', () => { assert.equal(parseStrategyScript(`input a = 5 min 9 max 2\ncall when a > 0\n`).ok, false) })
test('a text default must be one of its options', () => { assert.equal(parseStrategyScript(`input m = "x" options "a", "b"\ncall when 1 > 0\n`).ok, false) })
test('min on a text input is rejected', () => { assert.equal(parseStrategyScript(`input m = "a" min 1\ncall when 1 > 0\n`).ok, false) })
test('"input" is still a usable name elsewhere (let input = 3, input = 4)', () => { const r = run(`let input = 3\ninput = 4\ncall when input >= 4\nexpiry = 1\n`); assert.equal(r.direction, 'call') })
test('works with story-style positional args: an input feeds a function argument', () => { const r = run(`input t = 0.5 min 0 max 1\ncall when max(t, 0.1) >= 0.5\nexpiry = 1\n`, { t: 0.2 }); assert.equal(r.direction, 'none') })
console.log(`${pass}/${total}`); if (pass !== total) process.exit(1)
