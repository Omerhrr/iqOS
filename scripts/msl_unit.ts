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

// 7 - MSL v2: expiry statement (fires-only, clamped 1..60, non-finite fails closed)
{
  const p = parseStrategyScript('call when oracle.call\nconfidence = 70\nexpiry = 2')
  ok(p.ok, 'expiry statement parses')
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.direction === 'call' && out.expiryMin === 2 && !out.error, 'expiry = 2 surfaces as expiryMin 2 on a fired side')
  }
  const p2 = parseStrategyScript('put when accute.put\nexpiry = 2.7')
  ok(p2.ok, 'fractional expiry parses')
  if (p2.ok) {
    const out = evaluateStrategyScript(p2.ast, reads)
    ok(out.expiryMin === 3 && out.direction === 'put', 'expiry 2.7 rounds to whole 3')
  }
  const p3 = parseStrategyScript('call when oracle.call\nexpiry = 300')
  if (p3.ok) {
    const out = evaluateStrategyScript(p3.ast, reads)
    ok(out.expiryMin === 60, 'expiry 300 clamps to 60')
  }
  const p4 = parseStrategyScript('call when oracle.call\nexpiry = 0')
  if (p4.ok) {
    const out = evaluateStrategyScript(p4.ast, reads)
    ok(out.expiryMin === 1, 'expiry 0 clamps up to 1')
  }
  const p5 = parseStrategyScript(`call when oracle.call\nexpiry = ${'9'.repeat(40)} * ${'9'.repeat(40)} * ${'9'.repeat(40)} * ${'9'.repeat(40)} * ${'9'.repeat(40)} * ${'9'.repeat(40)} * ${'9'.repeat(40)} * ${'9'.repeat(40)}`)
  ok(p5.ok, 'overflow expiry script parses (literals finite)')
  if (p5.ok) {
    const out = evaluateStrategyScript(p5.ast, reads)
    ok(out.direction === 'none' && out.confidence === 0 && !!out.error, 'non-finite expiry (overflow to Infinity) fails the script closed')
  }
  const p6 = parseStrategyScript('call when none == call\nexpiry = 5')
  ok(p6.ok, 'unfired expiry script parses')
  if (p6.ok) {
    const out = evaluateStrategyScript(p6.ast, reads)
    ok(out.direction === 'none' && out.expiryMin === undefined, 'no side fired -> no expiryMin (fires-only contract)')
  }
}

// 8 - MSL v2: configure statements (collected plain values, last write wins)
{
  const p = parseStrategyScript('configure renko.atrMult = 0.5\nconfigure pf.reversalBoxes = 4\nconfigure strategy.ema-trend.fast = 5\ncall when oracle.call')
  ok(p.ok, 'configure lines parse (chart knobs + strategy params)')
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.configs?.['renko.atrMult'] === 0.5 && out.configs?.['pf.reversalBoxes'] === 4 && out.configs?.['strategy.ema-trend.fast'] === 5 && !out.error, 'configure values collected into configs')
  }
  const p2 = parseStrategyScript('configure renko.atrMult = 2\nconfigure renko.atrMult = 0.5\ncall when oracle.call')
  if (p2.ok) {
    const out = evaluateStrategyScript(p2.ast, reads)
    ok(out.configs?.['renko.atrMult'] === 0.5, 'duplicate configure key: last write wins')
  }
  const p3 = parseStrategyScript('configure renko = 1\ncall when oracle.call')
  ok(!p3.ok, 'configure without a dotted key rejected at parse time')
  const p4 = parseStrategyScript('configure renko.atrMult = oracle\ncall when oracle.call')
  ok(p4.ok, 'configure with a source value parses (runtime catches it)')
  if (p4.ok) {
    const out = evaluateStrategyScript(p4.ast, reads)
    ok(out.direction === 'none' && !!out.error, 'configure value that is a read object fails the script closed')
  }
}

// 9 - MSL v2: new core funcs (if lazy / clamp / pow / sqrt / mod / round family)
{
  const p = parseStrategyScript("call when oracle.call\nconfidence = if(oracle.call, clamp(oracle.conf + 10, 0, 85), 0)")
  ok(p.ok, 'if + clamp parse')
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, reads)
    ok(out.confidence === 85 && !out.error, 'if takes the call branch; clamp caps at 85')
  }
  const lazy = parseStrategyScript("call when oracle.call\nconfidence = if(oracle.call, 80, missingSource.conf)")
  ok(lazy.ok, 'lazy-if script parses')
  if (lazy.ok) {
    const out = evaluateStrategyScript(lazy.ast, reads)
    ok(out.confidence === 80 && !out.error, 'if is LAZY - the untaken branch (unknown source) never evaluates')
  }
  const p2 = parseStrategyScript('call when oracle.call\nconfidence = pow(2, 5) + mod(10, 3)')
  if (p2.ok) {
    const out = evaluateStrategyScript(p2.ast, reads)
    ok(out.confidence === 33 && !out.error, 'pow(2,5) + mod(10,3) = 33 exactly')
  }
  const p3 = parseStrategyScript('call when oracle.call\nconfidence = round(74.6)')
  if (p3.ok) {
    const out = evaluateStrategyScript(p3.ast, reads)
    ok(out.confidence === 75 && !out.error, 'round() rounds')
  }
  const p4 = parseStrategyScript('call when oracle.call\nconfidence = floor(40.9) + ceil(20.1) + sign(-3) + sign(2)')
  if (p4.ok) {
    const out = evaluateStrategyScript(p4.ast, reads)
    ok(out.confidence === 61 && !out.error, 'floor(40.9)+ceil(20.1)+sign(-3)+sign(2) = 40+21-1+1 = 61')
  }
  const p5 = parseStrategyScript('call when oracle.call\nconfidence = sqrt(-1)')
  if (p5.ok) {
    const out = evaluateStrategyScript(p5.ast, reads)
    ok(out.direction === 'none' && !!out.error, 'sqrt of a negative fails the script closed')
  }
  const p6 = parseStrategyScript('call when oracle.call\nconfidence = mod(5, 0)')
  if (p6.ok) {
    const out = evaluateStrategyScript(p6.ast, reads)
    ok(out.direction === 'none' && !!out.error, 'mod by zero fails the script closed')
  }
}

// 10 - MSL v2: the .value field (raw headline metric on a read)
{
  const valued: Record<string, MslSourceRead> = {
    oracle: { direction: 'call', confidence: 80 },
    'nextExpiry:5': { direction: 'call', confidence: 62, value: 0.61 },
    accute: { direction: 'none', confidence: 55 },
  }
  const p = parseStrategyScript('call when nextExpiry:5.dir == call and nextExpiry:5.value > 0.56\nput when accute.put\nconfidence = 60')
  ok(p.ok, '.value field parses on a pinned rung key')
  if (p.ok) {
    const out = evaluateStrategyScript(p.ast, valued)
    ok(out.direction === 'call' && out.confidence === 60 && !out.error, 'pWin 0.61 > 0.56 threshold fires on .value')
  }
  const p2 = parseStrategyScript('call when oracle.value > 0.9\nput when accute.put\nconfidence = 50')
  if (p2.ok) {
    const out = evaluateStrategyScript(p2.ast, valued)
    ok(out.direction === 'none' && !out.error, 'a source without a headline number reads .value as 0 (honest default)')
  }
}

console.log(`msl_unit: ${pass} ok, ${fail} FAIL`)
if (fail > 0) process.exit(1)
