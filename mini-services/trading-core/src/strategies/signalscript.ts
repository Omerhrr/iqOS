// IQAIR//OS - AI Lab's signal vocabulary, exposed to Meta Strategy Lab's
// own language (MSL, analytics/strategylang.ts).
//
// Per direct instruction: "it should use the same language we created for
// meta strategy" - AI Lab's CustomSpec (custom.ts) was JSON (a signals[]
// array of weighted votes), the one genuinely different format left in the
// OS after Meta-Strategy got its own script language. This module is the
// bridge: one MSL function per SignalDef *kind* (candle/bar/ha/line/renko/
// pf/mtf/indicator family/builtin/engine), each just constructing the SAME
// SignalDef object custom.ts's learner/evaluator already knows how to
// read, then asking signalActive() (custom.ts, already-existing, already-
// tested) whether it fired on this bar - so a script-based CustomSpec
// isn't a new signal engine, it's the OLD one addressed by name instead of
// by JSON shape.
//
// Direction convention: every function takes its OWN intended direction as
// an explicit `call`/`put` argument (SignalDef.dir is NOT inferred - the
// same "Bullish Engulfing" pattern can be traded as a continuation OR a
// fade signal depending on what the learner measured, so the DIRECTION IS
// PART OF THE DEFINITION, same as the JSON spec always required). When the
// signal fires, the function's read reports THAT direction; when it
// doesn't, it reports 'none'. Combine two mirror-image calls (one `call`,
// one `put`) with the script's own call-when/put-when logic to cover both
// sides, exactly like Meta-Strategy's own renko+smc confluence does.
//
// Confidence convention: these signals are boolean (fired or not), not
// graded - every function takes an optional trailing `conf` argument
// (0-100, default 65, same flat "lone signal, no honesty-loop number"
// default smcNowRead() uses) that becomes the read's confidence when it
// fires. Use it, or build your own via avg()/weighted logic in the script.
import type { EvalCtx, SignalDef } from './custom'
import { signalActive } from './custom'
import type { MinableEngineId } from '../analytics/chartsignals'
import { getStrategy, defaultParams } from './builtin'
import type { MslSourceRead } from '../analytics/strategylang'

/** Every function name this module answers for - strategylang.ts's
 * evaluator falls through to the resolver for any of these (anything NOT
 * one of its own six core arithmetic funcs). Exported so the AI Lab UI can
 * list/autocomplete them without duplicating this list by hand. */
export const SIGNAL_FUNCS = [
  'candle',
  'bar',
  'ha',
  'line',
  'renko',
  'pf',
  'mtf',
  'indicator',
  'indicatorType',
  'indicatorPeriod',
  'builtinSig',
  'engine',
] as const

type Arg = number | boolean | string

function side(v: Arg, label: string): 'call' | 'put' {
  const s = String(v)
  if (s === 'call' || s === 'put') return s
  throw new Error(`${label}: expected direction "call" or "put", got "${s}"`)
}
function num(v: Arg | undefined, fallback: number): number {
  if (v === undefined) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
function str(v: Arg | undefined, fallback: string): string {
  return v === undefined ? fallback : String(v)
}
function confOf(v: Arg | undefined): number {
  return Math.max(0, Math.min(100, Math.round(num(v, 65))))
}

/** Turns one SIGNAL_FUNCS call into the matching SignalDef, weight is
 * irrelevant for a live read (only matters for the OLD weighted-vote
 * evaluator, never invoked here) so every def gets a placeholder of 1. */
function buildSignalDef(fn: string, args: Arg[]): SignalDef {
  switch (fn) {
    case 'candle': {
      // candle(name, dir, conf?, series?)
      const [name, dirArg, , seriesArg] = args
      return { kind: 'candle', name: String(name ?? ''), dir: side(dirArg, 'candle()'), series: seriesArg === 'heikin' ? 'heikin' : 'bar', weight: 1 }
    }
    case 'bar': {
      // bar(variant, dir, conf?, atrK?)
      const [variant, dirArg, , atrK] = args
      const v = String(variant)
      if (v !== 'wide-bull' && v !== 'wide-bear') throw new Error(`bar(): unknown variant "${v}" - use wide-bull/wide-bear`)
      return { kind: 'bar', variant: v, dir: side(dirArg, 'bar()'), atrK: num(atrK, 1.1), weight: 1 }
    }
    case 'ha': {
      // ha(variant, dir, conf?, len?)
      const [variant, dirArg, , len] = args
      const v = String(variant)
      if (!['flip-up', 'flip-down', 'streak-up', 'streak-down', 'strong-bull', 'strong-bear'].includes(v)) throw new Error(`ha(): unknown variant "${v}"`)
      return { kind: 'ha', variant: v as never, dir: side(dirArg, 'ha()'), len: len === undefined ? undefined : num(len, 3), weight: 1 }
    }
    case 'line': {
      // line(variant, dir, conf?, lookback?)
      const [variant, dirArg, , lookback] = args
      const v = String(variant)
      if (!['breakout-up', 'breakout-down', 'hh-hl', 'lh-ll'].includes(v)) throw new Error(`line(): unknown variant "${v}"`)
      return { kind: 'line', variant: v as never, dir: side(dirArg, 'line()'), lookback: lookback === undefined ? undefined : num(lookback, 20), weight: 1 }
    }
    case 'renko': {
      // renko(variant, dir, conf?, len?)
      const [variant, dirArg, , len] = args
      const v = String(variant)
      if (!['flip-up', 'flip-down', 'streak-up', 'streak-down'].includes(v)) throw new Error(`renko(): unknown variant "${v}"`)
      return { kind: 'renko', variant: v as never, dir: side(dirArg, 'renko()'), len: len === undefined ? undefined : num(len, 2), weight: 1 }
    }
    case 'pf': {
      // pf(variant, dir, conf?, reversalBoxes?)
      const [variant, dirArg, , reversalBoxes] = args
      const v = String(variant)
      if (!['double-top-breakout', 'double-bottom-breakdown', 'triple-top-breakout', 'triple-bottom-breakdown'].includes(v)) throw new Error(`pf(): unknown variant "${v}"`)
      return { kind: 'pf', variant: v as never, dir: side(dirArg, 'pf()'), reversalBoxes: reversalBoxes === undefined ? undefined : num(reversalBoxes, 3), weight: 1 }
    }
    case 'mtf': {
      // mtf(factor, dir, conf?)
      const [factor, dirArg] = args
      const f = Number(factor)
      if (f !== 5 && f !== 15) throw new Error(`mtf(): factor must be 5 or 15, got ${f}`)
      return { kind: 'mtf', factor: f as 5 | 15, dir: side(dirArg, 'mtf()'), weight: 1 }
    }
    case 'indicator': {
      // indicator(ind, op, threshold, dir, conf?, threshold2?)
      const [ind, op, threshold, dirArg, , threshold2] = args
      return {
        kind: 'indicator',
        ind: String(ind) as never,
        op: String(op) as never,
        threshold: num(threshold, 0),
        threshold2: threshold2 === undefined ? undefined : num(threshold2, 0),
        dir: side(dirArg, 'indicator()'),
        weight: 1,
      }
    }
    case 'indicatorType': {
      // indicatorType(ind, type, op, threshold, dir, conf?, threshold2?)
      const [ind, type, op, threshold, dirArg, , threshold2] = args
      return {
        kind: 'indicator',
        ind: String(ind) as never,
        type: String(type),
        op: String(op) as never,
        threshold: num(threshold, 0),
        threshold2: threshold2 === undefined ? undefined : num(threshold2, 0),
        dir: side(dirArg, 'indicatorType()'),
        weight: 1,
      }
    }
    case 'indicatorPeriod': {
      // indicatorPeriod(ind, period, op, threshold, dir, conf?, threshold2?)
      const [ind, period, op, threshold, dirArg, , threshold2] = args
      return {
        kind: 'indicator',
        ind: String(ind) as never,
        params: { period: num(period, 14) },
        op: String(op) as never,
        threshold: num(threshold, 0),
        threshold2: threshold2 === undefined ? undefined : num(threshold2, 0),
        dir: side(dirArg, 'indicatorPeriod()'),
        weight: 1,
      }
    }
    case 'builtinSig': {
      // builtinSig(id, dir, conf?)
      const [id, dirArg] = args
      return { kind: 'builtin', id: String(id), dir: side(dirArg, 'builtinSig()'), weight: 1 }
    }
    case 'engine': {
      // engine(engineId, dir, conf?)
      const [engineId, dirArg] = args
      return { kind: 'engine', engine: String(engineId) as MinableEngineId, dir: side(dirArg, 'engine()'), weight: 1 }
    }
    default:
      throw new Error(`unknown signal function "${fn}"`)
  }
}

/** The confidence arg is always the 3rd positional arg across every
 * function above (after whatever identifies the signal + its direction) -
 * pulled out once here rather than duplicated in every case. */
function confArgIndexFor(fn: string): number {
  switch (fn) {
    case 'mtf':
    case 'builtinSig':
    case 'engine':
      return 2
    case 'indicator':
      return 4
    case 'indicatorType':
    case 'indicatorPeriod':
      return 5
    default:
      return 2 // candle/bar/ha/line/renko/pf
  }
}

/** Builds the resolver strategylang.ts's evaluator calls for any function
 * name it doesn't know itself - evaluates the matching SignalDef against
 * `ctx` at bar `i` (default: latest closed bar, same as every other live
 * read in this codebase) via custom.ts's own signalActive(), unmodified -
 * so a script's "candle(...)" and a JSON spec's `{kind:'candle',...}`
 * signal are checked by the EXACT same code, nothing reimplemented. */
export function makeSignalResolver(ctx: EvalCtx, i: number = ctx.n - 1): (fn: string, args: Arg[]) => MslSourceRead {
  return (fn, args) => {
    if (!(SIGNAL_FUNCS as readonly string[]).includes(fn)) {
      throw new Error(`unknown function "${fn}" - available signal functions: ${SIGNAL_FUNCS.join(', ')} (plus avg/sum/min/max/count/abs)`)
    }
    const def = buildSignalDef(fn, args)
    const active = signalActive(def, ctx, i)
    const confidence = active ? confOf(args[confArgIndexFor(fn)]) : 0
    return { direction: active ? def.dir : 'none', confidence }
  }
}

// Re-exported so callers don't need a second import just to sanity-check a
// builtin id exists before letting a script reference it (builtinSig()).
export { getStrategy, defaultParams }
