// MSL (strategy language) hardening - deterministic logic unit (bun).
// Locks the audit fixes to analytics/strategylang.ts:
//   - malformed numeric literals ("1.2.3") are REJECTED at parse time - they
//     used to tokenize happily and Number() to NaN, a NaN atom that flowed
//     through arithmetic into confidence and OUT of the evaluator as a
//     tradeable decision (Math.max/min/round all pass NaN through)
//   - a confidence expression that reaches +/-Infinity (huge-literal
//     overflow) then Infinity - Infinity fails CLOSED (none/0 + error),
//     never a NaN confidence on a live direction
//   - unterminated string literals are rejected (used to be silently
//     accepted as rest-of-line)
//   - '#' starts a comment only OUTSIDE a string literal
//   - all pre-existing behavior that must not regress: smc:FVG-style ':'-keys,
//     trailing comments, default confidence 65, both-fire conflict -> none,
//     divide-by-zero -> 0 convention, let-bindings, clamp to 0..100
import { parseStrategyScript, evaluateStrategyScript, type MslSourceRead } from '../mini-services/trading-core/src/analytics/strategylang'

let pass = 0
let fail = 0
function ok(cond: boolean, name: string) {
  if (cond) {
    pass++
    console.log('  ok', name)
  } else {
    fail++
    console.log('  FAIL', name)
  }
}

const reads: Record<string, MslSourceRead> = {
  oracle: { direction: 'call', confidence: 80 },
  accute: { direction: 'put', confidence: 55 },
  'smc:FVG': { direction: 'call', confidence: 70 },
}

// 1 - malformed numbers rejected at parse time
ok(!parseStrategyScript('call when oracle.call\nconfidence = 1.2.3').ok, 'multi-dot literal 1.2.3 rejected')
ok(!parseStrategyScript('call when oracle.call\nconfidence = 1..2').ok, 'multi-dot literal 1..2 rejected')
ok(!parseStrategyScript('call when 1.2.3 > 2').ok, 'multi-dot literal in a comparison rejected')

// 2 - valid decimals still fine
{
  const p = parseStrategyScript('call when oracle.call\nconfidence = 72.5')
  ok(p.ok, 'valid decimal literal still parses')
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.direction === 'call' && out.confidence === 73 && !out.error, 'decimal confidence evaluates + rounds')
  }
}

// 3 - unterminated string rejected
ok(!parseStrategyScript(`call when candle('Bullish Engulfing, call)`).ok, 'unterminated string rejected')

// 4 - '#' inside a string is NOT a comment; '#' outside still is
{
  const p = parseStrategyScript(`call when 'a #b' == 'a #b'`)
  ok(p.ok, "'#' inside a string literal survives comment stripping")
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.direction === 'call' && !out.error, "string containing '#' compares equal and fires")
  }
  const q = parseStrategyScript('call when oracle.call # trailing comment')
  ok(q.ok, 'trailing comment still stripped')
  if (q.ok) {
    const out = evaluateStrategyScript(q.ast, reads)
    ok(out.direction === 'call' && !out.error, 'script with trailing comment evaluates')
  }
}

// 5 - non-finite confidence fails closed (huge-literal overflow -> Infinity)
const BIG = '9'.repeat(40) // 1e40; ^8 overflows past 1.8e308
{
  const inf = parseStrategyScript(`call when oracle.call\nlet x = ${BIG} * ${BIG} * ${BIG} * ${BIG} * ${BIG} * ${BIG} * ${BIG} * ${BIG}\nconfidence = x`)
  ok(inf.ok, 'overflow script parses (literals themselves finite)')
  if (inf.ok) {
    const out = evaluateStrategyScript(inf.ast, reads)
    ok(out.direction === 'none' && out.confidence === 0 && !!out.error, 'Infinite confidence fails closed to none/0 + error')
  }
  const nan = parseStrategyScript(`call when oracle.call\nlet x = ${BIG} * ${BIG} * ${BIG} * ${BIG} * ${BIG} * ${BIG} * ${BIG} * ${BIG}\nconfidence = x - x`)
  ok(nan.ok, 'Inf - Inf script parses')
  if (nan.ok) {
    const out = evaluateStrategyScript(nan.ast, reads)
    ok(out.direction === 'none' && out.confidence === 0 && !!out.error, 'NaN confidence (Inf - Inf) fails closed to none/0 + error')
  }
}

// 6 - baseline behavior that must not regress
{
  const p = parseStrategyScript('call when oracle.call')
  ok(p.ok, 'plain call-when parses')
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.direction === 'call' && out.confidence === 65 && !out.error, 'default confidence 65')
  }
}
{
  const p = parseStrategyScript('call when smc:FVG.call')
  ok(p.ok, "':' source key (smc:FVG) still tokenizes")
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.direction === 'call' && !out.error, "smc:FVG read resolves")
  }
}
{
  const p = parseStrategyScript('let w = oracle.conf / 2\ncall when w > 30\nconfidence = w * 2')
  ok(p.ok, 'let-binding arithmetic parses')
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.direction === 'call' && out.confidence === 80 && !out.error, 'let-binding confidence math')
  }
}
{
  const p = parseStrategyScript('call when oracle.call\nput when accute.put')
  ok(p.ok, 'conflicting whens parse')
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.direction === 'none' && out.confidence === 0 && !out.error, 'both-fire conflict -> none (unchanged)')
  }
}
{
  const p = parseStrategyScript('call when oracle.call\nconfidence = 5 / 0')
  ok(p.ok, 'divide-by-zero script parses')
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.direction === 'call' && out.confidence === 0 && !out.error, 'divide-by-zero -> 0 convention unchanged')
  }
}
{
  const p = parseStrategyScript('call when oracle.call\nconfidence = 500')
  ok(p.ok, 'over-range confidence parses')
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.direction === 'call' && out.confidence === 100 && !out.error, 'confidence still clamps to 0..100')
  }
}
{
  const p = parseStrategyScript('call when oracle.call\nconfidence = -5 + 20')
  ok(p.ok, 'negative literal parses')
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.direction === 'call' && out.confidence === 15 && !out.error, 'negative-literal confidence math')
  }
}
{
  const p = parseStrategyScript('put when accute.put')
  ok(p.ok, 'put-when parses')
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.direction === 'put' && out.confidence === 65 && !out.error, 'put side fires with default confidence')
  }
}

console.log(`msl_unit: ${pass} ok, ${fail} FAIL`)
if (fail > 0) process.exit(1)
