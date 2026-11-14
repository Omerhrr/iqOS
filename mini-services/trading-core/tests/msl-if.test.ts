// IQAIR//OS - tests for MSL block conditionals: if / elseif (else if) / else / end.
import assert from 'node:assert/strict'
import { parseStrategyScript, evaluateStrategyScript, flattenStmts } from '../src/analytics/strategylang'
import { backtestMslScript } from '../src/analytics/mslbacktest'

type Test = { name: string; fn: () => void }
const tests: Test[] = []
const test = (name: string, fn: () => void) => tests.push({ name, fn })
const run = (src: string) => {
  const p = parseStrategyScript(src)
  if (!p.ok) return { parseError: p.error } as const
  return { r: evaluateStrategyScript(p.ast, {}), ast: p.ast } as const
}
const ok = (src: string) => {
  const o = run(src)
  assert.ok('r' in o, 'parse error: ' + ('parseError' in o ? o.parseError : ''))
  return o.r
}
const perr = (src: string) => {
  const o = run(src)
  assert.ok('parseError' in o, 'expected a parse error')
  return o.parseError
}

test('if / else: the true branch runs, the other does not', () => {
  const a = ok('let x = 5\nif x > 3\n  call when true\n  confidence = 80\nelse\n  put when true\nend')
  assert.equal(a.direction, 'call')
  assert.equal(a.confidence, 80)
  const b = ok('let x = 1\nif x > 3\n  call when true\nelse\n  put when true\n  confidence = 61\nend')
  assert.equal(b.direction, 'put')
  assert.equal(b.confidence, 61)
})
test('elseif chain: the FIRST true branch wins, later ones are not taken', () => {
  const src = (x: number) => `let x = ${x}\nif x > 10\n  call when true\n  confidence = 90\nelseif x > 5\n  call when true\n  confidence = 70\nelseif x > 0\n  put when true\n  confidence = 50\nelse\n  put when true\n  confidence = 30\nend`
  assert.deepEqual([ok(src(20)).direction, ok(src(20)).confidence], ['call', 90])
  assert.deepEqual([ok(src(7)).direction, ok(src(7)).confidence], ['call', 70])
  assert.deepEqual([ok(src(2)).direction, ok(src(2)).confidence], ['put', 50])
  assert.deepEqual([ok(src(-4)).direction, ok(src(-4)).confidence], ['put', 30])
})
test('"else if" is the same as "elseif"; "then" after a condition is optional', () => {
  const r = ok('let x = 1\nif x > 3 then\n  call when true\nelse if x > 0 then\n  put when true\nelse\n  call when true\nend')
  assert.equal(r.direction, 'put')
})
test('no else and no branch true: nothing happens; statements outside the block still run', () => {
  const r = ok('call when true\nif 1 > 2\n  put when true\nend')
  assert.equal(r.direction, 'call')
  const r2 = ok('call when 1 > 2\nif 1 > 2\n  put when true\nend')
  assert.equal(r2.direction, 'none')
})
test('nested blocks', () => {
  const r = ok('let a = 1\nlet b = 2\nif a == 1\n  if b == 2\n    call when true\n    confidence = 77\n  else\n    put when true\n  end\nelse\n  put when true\nend')
  assert.equal(r.direction, 'call')
  assert.equal(r.confidence, 77)
})
test('conditions in branches that were not taken are never evaluated (a guarded reading cannot error)', () => {
  const r = ok('if 1 == 1\n  call when true\nelseif neverDefined > 1\n  put when true\nelse\n  put when neverDefined2 > 1\nend')
  assert.equal(r.direction, 'call')
  assert.equal(r.error, undefined)
  // ...but a taken branch with a bad reference does fail the script, like any other statement
  const bad = ok('if 1 == 1\n  call when neverDefined > 1\nend')
  assert.match(String(bad.error), /unknown identifier/)
})
test('let inside a branch is visible after the block only if that branch ran', () => {
  const r = ok('let d = 0\nif 1 == 1\n  let d = 9\nend\ncall when true\nconfidence = d')
  assert.equal(r.confidence, 9)
  const r2 = ok('let d = 0\nif 1 == 2\n  let d = 9\nend\ncall when true\nconfidence = d')
  assert.equal(r2.confidence, 0)
  const r3 = ok('if 1 == 2\n  let e = 9\nend\ncall when true\nconfidence = e')
  assert.match(String(r3.error), /unknown identifier|failed/)
})
test('call and put both firing across branches and outside still reads none (same rule as flat scripts)', () => {
  const r = ok('call when true\nif 1 == 1\n  put when true\nend')
  assert.equal(r.direction, 'none')
})
test('the trace shows which branch was taken', () => {
  const r = ok('let x = 2\nif x > 5\n  call when true\nelseif x > 1\n  call when true\nelse\n  put when true\nend')
  assert.ok(r.trace.some((l) => /^if .*-> false/.test(l)))
  assert.ok(r.trace.some((l) => /^if .*-> true/.test(l)))
})
test('syntax errors are clear: unclosed block, stray end/else/elseif, else with a condition, anything after else, too deep', () => {
  assert.match(perr('if 1 > 2\n  call when true\n'), /never closed.*end/)
  assert.match(perr('call when true\nend'), /"end" without a matching "if"/)
  assert.match(perr('call when true\nelse\nend'), /"else" without a matching "if"/)
  assert.match(perr('call when true\nelseif 1 > 2\nend'), /"elseif" without a matching "if"/)
  assert.match(perr('if 1 > 2\n  call when true\nelse 1 > 2\n  put when true\nend'), /else.*no condition/)
  assert.match(perr('if 1 > 2\n  call when true\nelse\n  put when true\nelseif 1 > 1\n  put when true\nend'), /nothing may follow "else"|never closed/)
  assert.match(perr('if 1 > 2 call when true\nend'), /unexpected/)
  const deep = (n: number): string => (n === 0 ? 'call when true' : `if true\n${deep(n - 1)}\nend`)
  assert.ok(parseStrategyScript(deep(8)).ok)
  assert.match(perr(deep(9)), /nested more than 8/)
})
test('a script whose only call/put is inside a block still parses; a script with none is still rejected', () => {
  assert.ok(parseStrategyScript('if true\n  call when true\nend').ok)
  const none = parseStrategyScript('if true\n  let x = 1\nend')
  assert.equal(none.ok, false)
})
test('the inline if(cond, a, b) function still works, and "end" / "else" stay usable as ordinary names', () => {
  const r = ok('let end = 3\nlet else = if(end > 2, 10, 20)\ncall when end > 1\nconfidence = else')
  assert.equal(r.confidence, 10)
})
test('flattenStmts lists every statement including those inside blocks', () => {
  const p = parseStrategyScript('configure renko.atrMult = 0.5\nif true\n  configure renko.atrMult = 0.7\n  if true\n    call when true\n  end\nelse\n  put when true\nend')
  assert.ok(p.ok)
  if (!p.ok) return
  const kinds = flattenStmts(p.ast.stmts).map((s) => s.kind)
  assert.equal(kinds.filter((k) => k === 'configure').length, 2)
  assert.equal(kinds.filter((k) => k === 'call').length, 1)
  assert.equal(kinds.filter((k) => k === 'put').length, 1)
  assert.equal(kinds.filter((k) => k === 'if').length, 2)
})

function rng(s: number) { return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 } }
function walk(seed: number, n = 500) {
  const r = rng(seed)
  let x = 100
  return Array.from({ length: n }, (_, i) => {
    const o = x
    x += (r() - 0.5) * 0.6
    return { time: 1_700_000_000 + i * 60, open: o, high: Math.max(o, x) + 0.05, low: Math.min(o, x) - 0.05, close: x, volume: 10 + r() * 5 }
  })
}
test('backtest: an if / elseif / else script gives exactly the trades of its flat equivalent', () => {
  const flat = 'let z = ou.z()\ncall when z <= -1.5\nput when z >= 1.5\nconfidence = 60'
  const blocks = 'let z = ou.z()\nif z <= -1.5\n  call when true\nelseif z >= 1.5\n  put when true\nelse\n  call when false\nend\nconfidence = 60'
  let n = 0
  for (let s = 1; s <= 6; s++) {
    const c = walk(s * 13)
    const a = backtestMslScript(c, flat, { expiryBars: 2, warmupBars: 80 })
    const b = backtestMslScript(c, blocks, { expiryBars: 2, warmupBars: 80 })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(b.trades.length, a.trades.length)
    assert.equal(b.wins, a.wins)
    n += a.trades.length
  }
  assert.ok(n > 20, 'only ' + n + ' trades compared')
})

let pass = 0
let fail = 0
for (const t of tests) {
  try {
    t.fn()
    pass++
    console.log('  ok - ' + t.name)
  } catch (e) {
    fail++
    console.log('  FAIL - ' + t.name + '\n    ' + (e as Error).message)
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + tests.length + ' total')
process.exit(fail ? 1 : 0)
