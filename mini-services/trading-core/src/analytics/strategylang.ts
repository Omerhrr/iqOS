// IQAIR//OS - Meta Strategy Lab's own strategy language ("MSL")
//
// Per direct instruction: "i thought we build a way to write a strat using
// json in meta strategy... instead of using json, lets create our own
// strategy language, that we can use to achieve almost everything." The
// dropdown-built MetaStrategySpec (conditions[] + mode: all/any/weighted,
// see analytics/metastrategy.ts) stays the default, simple path - this
// module is the alternative, more expressive path: a small, safe, line-
// based language that reads the SAME panel verdicts (Oracle, HMA/ROC/
// Bull-Bear, Momentum Score, Accute, Renko, SMC's blended summary, SMC
// "now" aggregate and per-kind, and the Renko+SMC confluence) and combines
// them with real boolean/arithmetic logic instead of a fixed combine mode.
//
// Still deliberately NOT an arbitrary scripting language - same reasoning
// analytics/metastrategy.ts's own module header gives for the JSON spec:
// handing a live trading loop something that can do I/O, loop unboundedly,
// or reach outside its sandbox is a 1000x bigger blast radius than the
// payoff. This language can only read named sources' .dir/.conf/.active/
// .call/.put, combine them with and/or/not/comparisons/arithmetic, and
// assign the result to `call`/`put`/`confidence` - there is no loop, no
// function definition, no I/O, no way to reach anything but the `reads`
// map (and, since MSL below, the caller's optional raw-series ctx) the
// caller hands in. Evaluation is pure and terminates in O(script length) -
// no unbounded recursion, no host object ever exposed.
//
// MSL ("lets make it a multipurpose lang... have all indicators, have
// all charts and their own specs... should be able to compute anything") -
// per direct instruction, the language now ALSO has:
//   - a `series` value (MslSeriesValue) and `ser[-1]`/`ser[-2]`/... offset
//     indexing (indexSeries() below), plus series methods .crossed(...)/
//     .slope(n)/.max/min/mean/stddev(n) (seriesMethod() below);
//   - the `ind.*` namespace (indicatorCall() below) - raw indicator
//     PRIMITIVES (continuous series, not a boolean threshold check), reusing
//     analytics/indicators.ts's existing implementations verbatim: rsi, ema,
//     sma, wma, hma, kama, vwma, atr, roc, momentum, zscore, obv, cmf,
//     forceindex, psar (single series), and macd, bb, stoch, adx, supertrend
//     (bundles of named sub-series - .hist, .upper, .k, .plusDI, .line, ...);
//   - `ohlc(-n)` - one historical bar's raw OHLCV + derived shape (.body,
//     .range, .upper_wick, .lower_wick), `-1` = the latest closed bar;
//   - `cross(a, b)` / `between(x, lo, hi)` function-call aliases.
// This is a genuine, scoped exception to "doesn't know about candles or
// indicators" above: `ind.*`/`ohlc()` DO need the caller's raw per-bar
// history (EvalEnv.series, duck-typed to analytics/indicators.ts's own
// array shapes - still no import of custom.ts/metastrategy.ts, so the
// dependency direction this module's header describes elsewhere is
// unchanged), and are the deliberate point where this module stops being
// "panel verdicts only" and starts being able to express a genuinely novel
// indicator/candle strategy, not just compose what other engines already
// computed. Still bounded the same way as everything else here: no loop, no
// I/O, no unbounded recursion - `ind.*` calls one existing pure function and
// returns, same cost shape as any other primitive in this language.
//
// SINCE ADDED (this section originally listed these as not-yet-built -
// corrected in place rather than left stale): `live()` - the currently
// FORMING bar (EvalEnv.liveBar), and `tick.delta/velocity/ratio/count()` -
// RAW live tick-window stats over the real broker tick buffer
// (EvalEnv.liveTicks/liveNowMs) - both only meaningful in a context that
// wires live data in (today: only the omni-trader, plugins/omnitrader.ts -
// every candle-close-paced evaluator fails these closed with a clear
// error, not a silent zero); an `<TF>` suffix on `ind.*`/`ohlc()` calls
// (EvalEnv.seriesFor) for reading a DIFFERENT timeframe's own history; and
// the `foot.*` namespace (footMethod() below) - RAW per-price-NODE
// footprint primitives (foot.poc/pocTicks/stagnation/delta/speedRatio,
// foot.imbalance(side, ratio, windowSec?) for a diagonal buy/sell
// imbalance at the busiest node, foot.consecutiveDense(n, factor,
// windowSec?) for a run of n price-adjacent dense nodes) - same
// omni-trader-only, real-tick-buffer contract as tick.*, built on top of
// buildFootprint() (analytics/otcfootprint.ts) verbatim, nothing
// recomputed. This closes the "aggregate stats only, no price-level
// breakdown" gap tick.* deliberately left open.
//
// SINCE ADDED (2): `since(cond)` / `streak(cond)` - narrow, deliberately-
// scoped persisted cross-cycle state (MslStateStore below), NOT a general
// state.*/read-write primitive. `since(cond)` counts whole CLOSED bars
// since `cond` last evaluated true for THIS script+asset+tf+call-site (0
// while true, a large sentinel if it has never been true yet); `streak(
// cond)` counts the current run of consecutive closed bars `cond` has
// been true (0 once it goes false). Scope is per (spec id, asset, tf, the
// call site's position in the script source) - two `since(...)` calls in
// the same script track independently even with an identical condition
// expression. In-memory, reset on process restart, AND reset whenever a
// script-built spec is re-saved (editing the script invalidates its old
// counters rather than silently carrying stale state into new logic).
// Dedupes by the bar's own close time, not by call count, so being
// evaluated more than once on the same closed bar (the two-pass configure
// re-run, a tight omni-trader poll loop re-checking a bar that hasn't
// closed yet) never double-advances a counter. Only meaningful wherever a
// caller threads EvalEnv.stateKeyPrefix/barTimeSec through (today: every
// script evaluator, via metastrategy.ts's evaluateScript) - still fails
// closed with a clear error if neither is wired in.
//
// SINCE ADDED (3): `renko.bricks(n?)`/`renko.brickSize()`, `pf.boxes(n?)`/
// `pf.boxSize()`, `ha.bars(n?)`/`ha.streak()`/`ha.flip()`/`ha.bodyAtr()` -
// brick/box/HA-candle-LEVEL primitives (renkoMethod/pfMethod/haMethod
// below), closing the gap the plain `renko`/`pointFigure`/`heikinAshi`
// verdict reads leave open: those only ever vote on the AGGREGATE trend,
// never let a script pattern-match the bricks/boxes/candles themselves.
// `renko`/`pf`/`ha` are METHOD-CALL namespaces (parens required - `ha.flip`
// with no parens is a FIELD access on a different identifier and fails
// closed with "unknown field"), and `.bricks(n)`/`.boxes(n)`/`.bars(n)`
// return a SERIES (same as `ind.*`) - index it (`[-1]`) before using it in
// a comparison, exactly like any `ind.*` series; using the bare series
// value fails closed with the same "can't be used directly" error `ind.*`
// already gives. Reuses the EXISTING renkoBricks()/pointFigure()/
// heikinAshiSeries() engines verbatim via a shared candle conversion -
// nothing re-derived. `tick.*`/`foot.*` (above) also each gained a
// `<x>Series(windowSec?, buckets?)` historical sibling of their scalar
// form, for the same reason - `.slope()`/`.mean(n)` rate-of-change on the
// tape, not just a now-snapshot.
//
// Grammar (line-oriented; '#' to end-of-line is a comment; blank lines
// ignored):
//   let <name> = <expr>          bind an intermediate value for reuse
//   call when <boolExpr>         sets the CALL verdict if true
//   put when <boolExpr>          sets the PUT verdict if true
//   confidence = <numExpr>       optional - overrides the default 0-100
//                                 confidence (clamped); may appear once
//   expiry = <numExpr>           optional - the expiry this script PREFERS
//                                 for its trade, whole minutes (clamped 1-60;
//                                 1/2/3/5/15 are the rungs the engines
//                                 actually price). Evaluated only when a side
//                                 actually fired, like confidence. Surfaces
//                                 as MslEvalResult.expiryMin for the caller.
//   configure <a.b> = <expr>     optional, repeatable - per-script overrides
//                                 for HOW a source computes its read (chart
//                                 engine knobs like renko.atrMult = 0.5,
//                                 pf.reversalBoxes = 4, tpo.periodSec = 900,
//                                 strategy param overrides like
//                                 strategy.ema-cross.fast = 5). Paths are
//                                 dotted identifiers (at least one dot); the
//                                 CALLER owns the whitelist - unknown keys or
//                                 out-of-range values are a script ERROR (fail
//                                 closed), never silently ignored. Collected
//                                 into MslEvalResult.configs (last write wins
//                                 per key).
//
// Expressions (standard precedence, low to high):
//   or  <  and  <  not  <  comparisons (== != >= <= > <)  <  + -  <  * /
//   <  unary -  <  atoms
// Atoms: number literals, true/false, call/put/none (direction literals,
// also valid as bare identifiers), string literal '...'/"...", identifier
// (a source key the caller provided in `reads`, or a `let` binding),
// identifier '.' field (field in dir/direction/conf/confidence/active/
// call/put/value - 'value' is the source's own headline NUMBER in its
// native scale, e.g. the next-expiry rung's pWin 0..1 or renko's signed
// streak; 0 when a source has none), '(' expr ')', func(args...) where
// func in {avg, sum, min, max, count, abs, if, clamp, round, floor, ceil,
// sign, sqrt, pow, mod}.
//
// Source identifiers may contain ':' (e.g. `smc:FVG`, `smc:now`) - the
// caller (plugins/metastrategy.ts) builds the `reads` map with exactly the
// keys a script is allowed to reference: 'oracle', 'hmaRocBullBear',
// 'momentumScore', 'accute', 'renko', 'pointFigure', 'rangeBars', 'candle',
// 'bar', 'heikinAshi', 'line', 'area', 'baseline', 'volumeBars', 'tick',
// 'footprint', 'tpo', 'ivHv', 'smc', 'smcNow', 'renkoSmc',
// 'renkoSmcMajority', the tick-desk engines 'tickSmc', 'tickOracle',
// 'tickTechnical', 'tickFootprint' (raw micro-tick reads), 'nextExpiry'
// (the Next-Expiry Oracle's best pick, honesty-floored) plus
// 'nextExpiry:<E>' for each ladder rung (nextExpiry:1/2/3/5/15 - same ':'
// convention), the pinned tick-desk buckets 'tickOracle:<SEC>' /
// 'tickTechnical:<SEC>' (SEC = one of 1/2/3/5/15/30/60/120/180/300), and
// 'screenerRank' (the market-wide Screener board's row for this pair+tf),
// 'chartSignals' (the chart-signal pattern committee's fade-adjusted
// suggested trade), 'leadLag' (is a correlated leader already moving
// first) and 'yesterday' (the T-24h replay echo - a deliberately weak
// prior, confidence capped 30-80), plus
// 'technical' (the Technical Summary panel's whole-ladder consensus) plus
// 'technical:<TF>' for each TECH_LADDER rung (technical:1s, technical:2s,
// technical:3s, technical:5s, technical:15s, technical:30s, technical:1m,
// technical:2m, technical:3m, technical:5m, ... - same TF tokens the panel
// itself uses), and 'reversal' (the Reversal Radar's single most-urgent
// live read) plus 'reversal:<TF>' for the same rungs - a reversal rung
// only ever claims .dir in its two tradeable states (reversing-now or
// confirmed); calm/forming honestly read .dir == none, so "is NOT
// reversing" at a rung is simply `not reversal:1s.active`, and
// 'smc:<KIND>' for each of the 15 SMC concepts (smcNowRead() per kind) -
// "any of the smcs" per direct instruction, without needing 15 new
// MetaConditionSource union members. 'pointFigure'/
// 'rangeBars' are the same "not just renko - p&f, range and all others as
// we see fit" instruction: every chart engine this codebase already keeps
// as its own pure module (analytics/renko.ts, pointfigure.ts, rangebars.ts)
// is reachable from a script the same way, so a new chart type only ever
// needs a new `reads` key here, never a language change.

// MSL's `ind.*` namespace (indicatorCall(), further below) is a thin
// script-callable wrapper over these EXISTING array-returning
// implementations - aliased on import (never renamed in indicators.ts
// itself) purely to keep this module's own helper names (rsi/ema/sma/...
// would otherwise shadow nothing here, but the alias makes "this came from
// indicators.ts, unmodified" unmistakable at every call site below).
import {
  rsi as rsiInd,
  ema as emaInd,
  sma as smaInd,
  wma as wmaInd,
  hma as hmaInd,
  kama as kamaInd,
  vwma as vwmaInd,
  atr as atrInd,
  roc as rocInd,
  mom as momInd,
  zscoreSeries as zscoreInd,
  obv as obvInd,
  cmf as cmfInd,
  forceIndex as forceIndexInd,
  parabolicSar as parabolicSarInd,
  macd as macdInd,
  bollinger as bollingerInd,
  stochastic as stochasticInd,
  adx as adxInd,
  supertrend as supertrendInd,
} from './indicators'
import { buildFootprint, type FootprintBucket } from './otcfootprint'
// `renko.*`/`pf.*`/`ha.*` namespaces (renkoMethod/pfMethod/haMethod below) -
// reuse the SAME pure engines the 'renko'/'pointFigure'/'heikinAshi' verdict
// reads already call (plugins/metastrategy.ts), nothing re-derived. A type-
// only import of Candle (types.ts is a plain shared type module, not a
// domain plugin, so this doesn't break the "no import of custom.ts/
// metastrategy.ts" isolation this file's header describes) plus the three
// engines' own pure functions.
import type { Candle } from '../types'
import { renkoBricks, renkoAtr } from './renko'
import { pointFigure } from './pointfigure'
import { heikinAshiSeries } from './chartsignals'
import { rangeBars } from './rangebars'
import { volumeBars } from './volumebars'
import { computeTpo } from './tpo'
import { computeVolumeProfile } from './volumeprofile'
import { lineBreak } from './linebreak'
import { kagi } from './kagi'
import { computeSwing } from './swing'

export interface MslSourceRead {
  direction: 'call' | 'put' | 'none'
  confidence: number // 0..100
  /** OPTIONAL: the source's own headline numeric metric, in its native scale
   * (documented per source by whoever builds the reads map - e.g. a
   * next-expiry rung reports pWin 0..1, the tick oracle its walk-forward
   * score, renko its signed streak). Exposed to scripts as the `.value`
   * field; a source without a headline number omits it and `.value`
   * honestly reads 0. */
  value?: number
}

/** A source read, tagged so it's distinguishable from a plain string at
 * runtime (MslValue has no other object variant). Both the caller's static
 * `reads` map AND a signal-function call (see MslSignalResolver below) now
 * produce this SAME shape, so `.dir`/`.conf`/etc. work identically either
 * way - "oracle.dir" and "candle('Bullish Engulfing', call).dir" are the
 * same kind of thing to the evaluator. */
export interface MslReadValue extends MslSourceRead {
  readonly __mslRead: true
}

function readValue(r: MslSourceRead): MslReadValue {
  return {
    __mslRead: true,
    direction: r.direction,
    confidence: r.confidence,
    ...(r.value !== undefined && Number.isFinite(r.value) ? { value: r.value } : {}),
  }
}

function isReadValue(v: unknown): v is MslReadValue {
  return typeof v === 'object' && v !== null && (v as MslReadValue).__mslRead === true
}

/** MSL: a rolling numeric series (e.g. `ind.rsi(14)`) - chronological
 * ascending, same convention as EvalCtx's own close/high/low/... arrays
 * (last element = the latest closed bar). `[-1]`/`[-2]`/... index FROM that
 * latest end: `ser[-1]` = values[length-1] (latest), `ser[-2]` = one bar
 * back, etc - see indexSeries() below for the exact mapping. Tagged the
 * same way MslReadValue is, so evalExpr's existing "is this a composite
 * value, not a plain number" guards (truthy/asNum) extend to it for free. */
export interface MslSeriesValue {
  readonly __mslSeries: true
  values: number[]
}

function seriesValue(values: number[]): MslSeriesValue {
  return { __mslSeries: true, values }
}

function isSeriesValue(v: unknown): v is MslSeriesValue {
  return typeof v === 'object' && v !== null && (v as MslSeriesValue).__mslSeries === true
}

/** MSL: one historical bar's OHLCV + derived shape, from `bar(-n)`.
 * Field access only (`.o`/`.open`, `.h`/`.high`, `.l`/`.low`, `.c`/`.close`,
 * `.v`/`.volume`, `.body`, `.range`, `.upper_wick`, `.lower_wick`) - see
 * fieldOf() below. */
export interface MslBarValue {
  readonly __mslBar: true
  o: number
  h: number
  l: number
  c: number
  v: number
  body: number
  range: number
  upperWick: number
  lowerWick: number
}

function isBarValue(v: unknown): v is MslBarValue {
  return typeof v === 'object' && v !== null && (v as MslBarValue).__mslBar === true
}

/** MSL: a named bundle of sub-values, for an indicator call that
 * naturally returns more than one series (`ind.macd(12,26,9)` ->
 * `{macd, signal, hist}`, `ind.bb(20,2)` -> `{upper, mid, lower, width,
 * percentB}`, `ind.stoch(14,3,3)` -> `{k, d}`, `ind.adx(14)` -> `{adx,
 * plusDI, minusDI}`, `ind.supertrend(10,3)` -> `{line, dir}`). Each named
 * field is itself a full MslValue (almost always a series) - `.field`
 * access just looks the name up, see fieldOf() below. */
export interface MslBundleValue {
  readonly __mslBundle: true
  fields: Record<string, MslValue>
}

function bundleValue(fields: Record<string, MslValue>): MslBundleValue {
  return { __mslBundle: true, fields }
}

function isBundleValue(v: unknown): v is MslBundleValue {
  return typeof v === 'object' && v !== null && (v as MslBundleValue).__mslBundle === true
}

/** Any non-plain MSL value - a source/signal read, a series, a bar, or a
 * bundle. None of these can be used directly as a number/boolean (compare,
 * add, "and"/"or") - a script must narrow to a plain value first, via
 * `.field` (read/bar/bundle) or `[n]`/`.method()` (series). Centralizes the
 * guard truthy()/asNum() both already had for reads alone. */
function isComposite(v: unknown): v is MslReadValue | MslSeriesValue | MslBarValue | MslBundleValue {
  return isReadValue(v) || isSeriesValue(v) || isBarValue(v) || isBundleValue(v)
}

export type MslValue = number | boolean | string | MslReadValue | MslSeriesValue | MslBarValue | MslBundleValue

/** The raw per-bar history a script's `ind.*`/`bar(-n)` primitives read
 * from - chronological ascending, index n-1 = the latest CLOSED bar, same
 * shape/convention strategies/custom.ts's EvalCtx already uses for its own
 * close/high/low/open/volume/atr/body/range arrays (passed in directly,
 * duck-typed - this module still never imports custom.ts, same dependency-
 * isolation this file's header already explains for the reads map). Optional
 * everywhere: a caller with no candle history (or one that only wants the
 * panel-source side of the language) simply omits it, and `ind.*`/`bar()`
 * fail closed with a clear error instead of silently reading nothing. */
export interface MslSeriesCtx {
  open: number[]
  high: number[]
  low: number[]
  close: number[]
  volume: number[]
}

/** Bundles the three things every evalExpr/explainExpr call threads through
 * unchanged (the static `reads` map, the signal-function `resolve`r, and the
 * optional raw-series `series` ctx) into one object, so a deeper recursive
 * call is `(subExpr, env, ctx)` instead of three positional params that have
 * to be repeated correctly at every call site. */
export interface EvalEnv {
  reads: Record<string, MslSourceRead>
  resolve?: MslSignalResolver
  series?: MslSeriesCtx
  /** MSL: the optional trailing timeframe string on `ind.*(...)`/
   * `ohlc(-n, tf)` ("5m", "1h", ...) - looks up (and the caller is expected
   * to cache) that timeframe's OWN MslSeriesCtx, fetched from a SEPARATE
   * candle history than this pair's native tf. Undefined means the caller
   * built no cross-timeframe support (e.g. a context with only panel
   * reads) - a TF-suffixed call then fails closed with a clear error, same
   * convention as `series` being absent. Returning undefined for an
   * unrecognized/unavailable tf (vs throwing) lets the caller distinguish
   * "no cross-TF support at all" from "that specific tf has no data yet" -
   * both still fail the call closed, just with a more specific message. */
  seriesFor?: (tf: string) => MslSeriesCtx | undefined
  /** MSL/omni-trader: the CURRENTLY FORMING (unclosed) bar's OHLCV-so-
   * far, snapshotted at evaluation time - a `live()` call reads this.
   * Deliberately separate from `series`/`ohlc()` (which only ever see
   * CLOSED, settled bars - that guarantee stays intact for every existing
   * script): a caller that wants sub-bar reactivity passes this in
   * ADDITIONALLY, it never replaces the closed-bar series. Undefined
   * (every caller except the omni-trader) means `live()` fails closed. */
  liveBar?: MslBarValue
  /** MSL/omni-trader: the raw tick buffer (price-change events, ms
   * timestamps, chronological ascending) backing the `tick.*` namespace -
   * real broker tick data (see plugins/otcfootprint.ts), not a candle-
   * bucket aggregate. Undefined means no live tick feed was wired in (the
   * normal case for every evaluator except the omni-trader) - `tick.*`
   * calls then fail closed with a clear error, same convention as
   * `series`/`liveBar` being absent. */
  liveTicks?: readonly { ts: number; price: number }[]
  /** Wall-clock "now" (ms) that `tick.*` windows are measured back FROM.
   * AUDIT FIX: measuring back from the LAST TICK'S OWN timestamp instead
   * (the first version of this) can never detect a real stall - if ticks
   * genuinely stop arriving, the buffer's last entry stops advancing, but
   * the window just before it still has the same old ticks in it forever,
   * so "velocity dropped to zero 3 seconds ago" would never show up no
   * matter how long the real stall lasts. Measuring from actual wall-clock
   * now means a stall becomes visible as soon as it's been quiet for
   * `windowSec`. Defaults to Date.now() when ticks are supplied but this
   * isn't (set explicitly for a deterministic replay/test). */
  liveNowMs?: number
  /** `since()`/`streak()`'s scope key - everything except the call-site
   * sequence number (ctx builds `${stateKeyPrefix}|${seq}`). The CALLER
   * decides what this identifies (metastrategy.ts uses `${specId}|
   * ${asset}|${tf}`) - this module never knows or cares what a spec/asset/
   * tf even are, same dependency-isolation every other EvalEnv field here
   * already keeps. Undefined means the caller wired no state tracking in
   * - `since()`/`streak()` then fail closed. */
  stateKeyPrefix?: string
  /** The CLOSED bar this evaluation is for, epoch seconds - `since()`/
   * `streak()`'s dedup key (MslStateStore.observe() below only advances a
   * counter the FIRST time it sees a given barTimeSec for a given key, so
   * a re-run on the same still-open bar - the two-pass configure retry, a
   * tight poll loop - never double-counts). Undefined means the same as
   * stateKeyPrefix being undefined: `since()`/`streak()` fail closed. */
  barTimeSec?: number
}

/** `since()`/`streak()`'s per-call-site memory. Deliberately NOT a general
 * state.* read/write primitive (see the module header's "SINCE ADDED (2)"
 * note) - just these two narrow counters, in-memory, reset on restart. One
 * module-level singleton; `clearMslState()` lets a caller invalidate every
 * key under one prefix (metastrategy.ts calls it when a script-built spec
 * is re-saved, so an edited script never inherits a stale counter from its
 * previous version). */
interface MslStateRecord {
  lastBarTimeSec: number
  lastTrue: boolean
  sinceBars: number
  streakBars: number
}
/** Sentinel for "cond has never been true yet" - large rather than -1 so a
 * script written as `since(x) > 20` (or any plain threshold check) reads
 * correctly as true without a special "never happened" case to guard for. */
const MSL_SINCE_NEVER = 1_000_000

class MslStateStore {
  private recs = new Map<string, MslStateRecord>()

  observe(key: string, barTimeSec: number, condTrue: boolean): MslStateRecord {
    const existing = this.recs.get(key)
    if (existing && existing.lastBarTimeSec === barTimeSec) return existing // already advanced for this bar
    const rec: MslStateRecord = existing
      ? {
          lastBarTimeSec: barTimeSec,
          lastTrue: condTrue,
          sinceBars: condTrue ? 0 : existing.sinceBars >= MSL_SINCE_NEVER ? MSL_SINCE_NEVER : existing.sinceBars + 1,
          streakBars: condTrue ? (existing.lastTrue ? existing.streakBars + 1 : 1) : 0,
        }
      : { lastBarTimeSec: barTimeSec, lastTrue: condTrue, sinceBars: condTrue ? 0 : MSL_SINCE_NEVER, streakBars: condTrue ? 1 : 0 }
    this.recs.set(key, rec)
    return rec
  }

  clearPrefix(prefix: string): void {
    const needle = `${prefix}|`
    for (const key of this.recs.keys()) if (key.startsWith(needle)) this.recs.delete(key)
  }
}

const mslStateStore = new MslStateStore()

/** Invalidate every `since()`/`streak()` counter scoped under one
 * `stateKeyPrefix` (e.g. a meta-strategy spec id) - call this whenever the
 * script that prefix belongs to changes, so edited logic never resumes
 * counting from a previous version's state. */
export function clearMslState(stateKeyPrefix: string): void {
  mslStateStore.clearPrefix(stateKeyPrefix)
}

function requireMslState(ctx: EvalEnv, fn: string, seq: number | undefined, condTrue: boolean): MslStateRecord {
  if (seq === undefined) throw new MslRuntimeError(`"${fn}(...)" internal error - call site wasn't assigned a state slot (parser bug)`)
  if (ctx.stateKeyPrefix === undefined || ctx.barTimeSec === undefined) {
    throw new MslRuntimeError(`${fn}() needs bar-close state tracking, which is not available in this evaluation context`)
  }
  return mslStateStore.observe(`${ctx.stateKeyPrefix}|${seq}`, ctx.barTimeSec, condTrue)
}

/** Resolves a function call the core language doesn't itself know (i.e.
 * not one of avg/sum/min/max/count/abs) into a source read - this is how
 * AI Lab's signal vocabulary (candle/bar/ha/line/renko/pf/indicator/...,
 * see strategies/signalscript.ts) plugs into the SAME language Meta-
 * Strategy already uses, without this module needing to know anything
 * about candles, indicators, or any other domain - it just asks the
 * caller "what does this call resolve to right now" and gets back a
 * direction+confidence, exactly like a named `reads` entry. Args are
 * already-evaluated plain values (never another read - see the guard in
 * evalExpr's 'call' case); the resolver throws to fail the whole script
 * evaluation (caught the same way any other runtime error is), or returns
 * a read normally. */
export type MslSignalResolver = (fn: string, args: (number | boolean | string)[]) => MslSourceRead

export interface MslEvalResult {
  direction: 'call' | 'put' | 'none'
  confidence: number // 0..100
  /** set by an "expiry = <minutes>" statement (whole minutes, clamped 1-60)
   * - the caller decides what to do with the script's preferred horizon
   * (Meta Trader surfaces it in its eval result; the engines' own honesty
   * gates still apply on top of it). */
  expiryMin?: number
  /** collected "configure <key> = <value>" statements (last write wins) -
   * the CALLER validates every key against its own whitelist and applies
   * them when building the reads; unknown keys fail the script closed. */
  configs?: Record<string, number | boolean | string>
  /** human-readable evaluation trace - which when-clauses fired, final
   * confidence source - surfaced in the Meta Strategy Lab's test panel so
   * a script's behavior is inspectable, not a black box. */
  trace: string[]
  error?: string
}

// ---------- tokenizer ----------

type TokKind =
  | 'num' | 'str' | 'ident' | 'dot' | 'comma' | 'lparen' | 'rparen' | 'lbracket' | 'rbracket' | 'eq_assign'
  | 'eqeq' | 'neq' | 'gte' | 'lte' | 'gt' | 'lt' | 'plus' | 'minus' | 'star' | 'slash'
  | 'and' | 'or' | 'not' | 'let' | 'call_kw' | 'put_kw' | 'when' | 'confidence_kw'
  | 'expiry_kw' | 'configure_kw' | 'eof'

interface Token {
  kind: TokKind
  value: string
  line: number
}

const KEYWORDS: Record<string, TokKind> = {
  and: 'and',
  or: 'or',
  not: 'not',
  let: 'let',
  call: 'call_kw',
  put: 'put_kw',
  when: 'when',
  confidence: 'confidence_kw',
  expiry: 'expiry_kw',
  configure: 'configure_kw',
}

class MslSyntaxError extends Error {}

/** AUDIT: strip a '#' comment to end-of-line WITHOUT cutting '#' inside a
 * string literal (`candle('Bull #3', call)` used to lose the tail of its
 * own first argument to the comment pass, then fail to parse). Quote-aware
 * scan: a '#' opens a comment only outside '...' / "...". */
function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === '#') return line.slice(0, i)
  }
  return line
}

function tokenize(src: string): Token[] {
  const lines = src.split('\n')
  const toks: Token[] = []
  for (let li = 0; li < lines.length; li++) {
    const line = stripComment(lines[li]) // '#' starts a comment - rest of the line is dropped
    let i = 0
    while (i < line.length) {
      const c = line[i]
      if (c === ' ' || c === '\t' || c === '\r') {
        i++
        continue
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(line[i + 1] ?? ''))) {
        let j = i
        while (j < line.length && /[0-9.]/.test(line[j])) j++
        const word = line.slice(i, j)
        // AUDIT: a multi-dot token like "1.2.3" used to tokenize happily and
        // Number() to NaN - a NaN atom that flowed through arithmetic into
        // confidence (Math.max/min pass NaN straight through) and OUT of the
        // evaluator as a tradeable decision. Reject at the source instead:
        // the parser only ever sees finite literals now.
        const numVal = Number(word)
        if (!Number.isFinite(numVal)) throw new MslSyntaxError(`line ${li + 1}: malformed number "${word}"`)
        toks.push({ kind: 'num', value: word, line: li + 1 })
        i = j
        continue
      }
      if (c === "'" || c === '"') {
        const quote = c
        let j = i + 1
        while (j < line.length && line[j] !== quote) j++
        // AUDIT: an unterminated string used to be silently accepted as the
        // rest-of-line (a typo like 'Bullish Engulfing without its closing
        // quote changed the script's meaning instead of failing at save).
        if (j >= line.length) throw new MslSyntaxError(`line ${li + 1}: unterminated string literal - missing closing ${quote}`)
        toks.push({ kind: 'str', value: line.slice(i + 1, j), line: li + 1 })
        i = j + 1
        continue
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i
        while (j < line.length && /[A-Za-z0-9_:\-]/.test(line[j])) j++
        const word = line.slice(i, j)
        const kw = KEYWORDS[word]
        toks.push({ kind: kw ?? 'ident', value: word, line: li + 1 })
        i = j
        continue
      }
      if (c === '.') {
        toks.push({ kind: 'dot', value: '.', line: li + 1 })
        i++
        continue
      }
      if (c === ',') {
        toks.push({ kind: 'comma', value: ',', line: li + 1 })
        i++
        continue
      }
      if (c === '(') {
        toks.push({ kind: 'lparen', value: '(', line: li + 1 })
        i++
        continue
      }
      if (c === ')') {
        toks.push({ kind: 'rparen', value: ')', line: li + 1 })
        i++
        continue
      }
      if (c === '[') {
        toks.push({ kind: 'lbracket', value: '[', line: li + 1 })
        i++
        continue
      }
      if (c === ']') {
        toks.push({ kind: 'rbracket', value: ']', line: li + 1 })
        i++
        continue
      }
      if (c === '=' && line[i + 1] === '=') {
        toks.push({ kind: 'eqeq', value: '==', line: li + 1 })
        i += 2
        continue
      }
      if (c === '!' && line[i + 1] === '=') {
        toks.push({ kind: 'neq', value: '!=', line: li + 1 })
        i += 2
        continue
      }
      if (c === '>' && line[i + 1] === '=') {
        toks.push({ kind: 'gte', value: '>=', line: li + 1 })
        i += 2
        continue
      }
      if (c === '<' && line[i + 1] === '=') {
        toks.push({ kind: 'lte', value: '<=', line: li + 1 })
        i += 2
        continue
      }
      if (c === '>') {
        toks.push({ kind: 'gt', value: '>', line: li + 1 })
        i++
        continue
      }
      if (c === '<') {
        toks.push({ kind: 'lt', value: '<', line: li + 1 })
        i++
        continue
      }
      if (c === '=') {
        toks.push({ kind: 'eq_assign', value: '=', line: li + 1 })
        i++
        continue
      }
      if (c === '+') {
        toks.push({ kind: 'plus', value: '+', line: li + 1 })
        i++
        continue
      }
      if (c === '-') {
        toks.push({ kind: 'minus', value: '-', line: li + 1 })
        i++
        continue
      }
      if (c === '*') {
        toks.push({ kind: 'star', value: '*', line: li + 1 })
        i++
        continue
      }
      if (c === '/') {
        toks.push({ kind: 'slash', value: '/', line: li + 1 })
        i++
        continue
      }
      throw new MslSyntaxError(`line ${li + 1}: unexpected character "${c}"`)
    }
    toks.push({ kind: 'eof', value: '\\n', line: li + 1 }) // line terminator, reused as a statement separator below
  }
  toks.push({ kind: 'eof', value: '', line: lines.length })
  return toks
}

// ---------- AST ----------

type Expr =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'dir'; v: 'call' | 'put' | 'none' }
  | { t: 'ident'; name: string }
  | { t: 'field'; obj: Expr; field: string }
  | { t: 'unary'; op: 'not' | 'neg'; e: Expr }
  | { t: 'bin'; op: 'and' | 'or' | '==' | '!=' | '>=' | '<=' | '>' | '<' | '+' | '-' | '*' | '/'; l: Expr; r: Expr }
  /** `seq` is only set for a `since(...)`/`streak(...)` call - its stable,
   * parse-order call-site index within THIS script (Parser.stateSeq below),
   * used to scope that call's MslStateStore memory from every other
   * since()/streak() call in the same script, even an identical-looking
   * one. Every other function ignores it. */
  | { t: 'call'; fn: string; args: Expr[]; seq?: number }
  /** MSL: `ser[-1]` - idx must evaluate to a (usually negative, whole)
   * number; see indexSeries() for the exact "-1 = latest" mapping. */
  | { t: 'index'; obj: Expr; idx: Expr }
  /** MSL: `obj.name(args)` - a dotted call, distinct from plain `.field`
   * access (no parens). Covers BOTH a namespace pseudo-call where `obj` is
   * a bare `ind`/`foot`/`tick` identifier never meant to be evaluated on
   * its own (methodCall() below special-cases those before touching `obj`
   * at all), and a real series/bar method call (`ser.crossed(...)`,
   * `ser.slope(5)`) where `obj` IS evaluated normally first. */
  | { t: 'method'; obj: Expr; name: string; args: Expr[] }

type Stmt =
  | { kind: 'let'; name: string; expr: Expr }
  | { kind: 'call'; expr: Expr }
  | { kind: 'put'; expr: Expr }
  | { kind: 'confidence'; expr: Expr }
  | { kind: 'expiry'; expr: Expr }
  | { kind: 'configure'; path: string; expr: Expr }

export interface MslAst {
  stmts: Stmt[]
}

// Read fields (unchanged) PLUS bar fields (MslBarValue) PLUS the named
// sub-fields the ind.* bundle indicators return (MslBundleValue) - all in
// one flat set the PARSER checks for an early typo-catch; which subset
// actually applies to a given value is a RUNTIME question (fieldOf()
// throws a clear "not valid on this kind of value" error there), same
// split every other type error in this language already uses.
const FIELDS = new Set([
  'dir', 'direction', 'conf', 'confidence', 'active', 'call', 'put', 'value',
  // bar (MslBarValue)
  'o', 'open', 'h', 'high', 'l', 'low', 'c', 'close', 'v', 'volume', 'body', 'range', 'upper_wick', 'lower_wick',
  // bundle sub-fields across every ind.* multi-series indicator
  'macd', 'signal', 'hist', 'upper', 'mid', 'lower', 'width', 'percentB', 'k', 'd', 'adx', 'plusDI', 'minusDI', 'line',
  // bundle sub-fields on pf.column(offset) - top/bottom price boundary,
  // unsigned box count (signed direction is already pf.boxes(n)'s own job,
  // not duplicated here)
  'top', 'bottom', 'boxes',
])
// Core arithmetic funcs (avg/sum/min/max/count/abs) are no longer special-
// cased at PARSE time - any identifier followed by "(" parses as a call
// (see parsePrimary's doc comment). evalExpr's 'call' case still handles
// those six itself; every other name falls through to a caller-supplied
// resolver (signal functions, etc - see MslSignalResolver above).

// ---------- parser (recursive descent, one statement per source line) ----------

class Parser {
  private pos = 0
  /** Assigns each `since(...)`/`streak(...)` call site a stable, parse-
   * order index (see Expr's `seq` field) - deterministic across re-parses
   * of the SAME script text (single-pass recursive descent, always visits
   * call sites in the same left-to-right order), which is exactly the
   * stability MslStateStore's keys need. */
  private stateSeq = 0
  constructor(private toks: Token[]) {}

  private peek(): Token {
    return this.toks[this.pos]
  }
  private next(): Token {
    return this.toks[this.pos++]
  }
  private expect(kind: TokKind): Token {
    const t = this.next()
    if (t.kind !== kind) throw new MslSyntaxError(`line ${t.line}: expected ${kind}, got "${t.value}"`)
    return t
  }
  private skipLineBreaks(): void {
    while (this.peek().kind === 'eof' && this.toks[this.pos + 1] && this.toks[this.pos + 1].kind !== 'eof') {
      // 'eof' tokens inserted per source line double as line breaks; the
      // true end-of-input is the LAST token in the stream.
      if (this.pos === this.toks.length - 1) break
      this.pos++
    }
  }

  parseProgram(): MslAst {
    const stmts: Stmt[] = []
    this.skipLineBreaks()
    while (this.peek().kind !== 'eof' || this.pos < this.toks.length - 1) {
      if (this.peek().kind === 'eof') {
        this.pos++
        continue
      }
      stmts.push(this.parseStatement())
      // a statement must end at a line-break ('eof' token) or real eof
      if (this.peek().kind !== 'eof') throw new MslSyntaxError(`line ${this.peek().line}: unexpected "${this.peek().value}" after statement`)
    }
    return { stmts }
  }

  private parseStatement(): Stmt {
    const t = this.peek()
    if (t.kind === 'let') {
      this.next()
      const name = this.expect('ident').value
      this.expect('eq_assign')
      const expr = this.parseOr()
      return { kind: 'let', name, expr }
    }
    if (t.kind === 'call_kw') {
      this.next()
      this.expectWord('when')
      return { kind: 'call', expr: this.parseOr() }
    }
    if (t.kind === 'put_kw') {
      this.next()
      this.expectWord('when')
      return { kind: 'put', expr: this.parseOr() }
    }
    if (t.kind === 'confidence_kw') {
      this.next()
      this.expect('eq_assign')
      return { kind: 'confidence', expr: this.parseOr() }
    }
    if (t.kind === 'expiry_kw') {
      this.next()
      this.expect('eq_assign')
      return { kind: 'expiry', expr: this.parseOr() }
    }
    if (t.kind === 'configure_kw') {
      // configure <ident>(.<ident>)+ = <expr> - the path is collected as a
      // dotted string; which keys are legal (and their ranges) is the
      // CALLER's whitelist (plugins/metastrategy.ts), applied at eval time
      // so a stale parser can never bless a key the kernel no longer honors.
      this.next()
      let path = this.expect('ident').value
      while (this.peek().kind === 'dot') {
        this.next()
        path += `.${this.expect('ident').value}`
      }
      if (!path.includes('.')) throw new MslSyntaxError(`line ${t.line}: "configure" needs a dotted key like configure renko.atrMult = 0.5 (got "${path}")`)
      this.expect('eq_assign')
      return { kind: 'configure', path, expr: this.parseOr() }
    }
    throw new MslSyntaxError(`line ${t.line}: expected "let", "call when", "put when", "confidence =", "expiry =" or "configure ... =", got "${t.value}"`)
  }

  private expectWord(word: string): void {
    const t = this.next()
    if (t.kind !== 'when') throw new MslSyntaxError(`line ${t.line}: expected "${word}", got "${t.value}"`)
  }

  private parseOr(): Expr {
    let l = this.parseAnd()
    while (this.peek().kind === 'or') {
      this.next()
      l = { t: 'bin', op: 'or', l, r: this.parseAnd() }
    }
    return l
  }
  private parseAnd(): Expr {
    let l = this.parseNot()
    while (this.peek().kind === 'and') {
      this.next()
      l = { t: 'bin', op: 'and', l, r: this.parseNot() }
    }
    return l
  }
  private parseNot(): Expr {
    if (this.peek().kind === 'not') {
      this.next()
      return { t: 'unary', op: 'not', e: this.parseNot() }
    }
    return this.parseCompare()
  }
  private parseCompare(): Expr {
    const l = this.parseAdd()
    const k = this.peek().kind
    const cmp: Record<string, string> = { eqeq: '==', neq: '!=', gte: '>=', lte: '<=', gt: '>', lt: '<' }
    if (cmp[k]) {
      this.next()
      const r = this.parseAdd()
      return { t: 'bin', op: cmp[k] as '==' | '!=' | '>=' | '<=' | '>' | '<', l, r }
    }
    return l
  }
  private parseAdd(): Expr {
    let l = this.parseMul()
    while (this.peek().kind === 'plus' || this.peek().kind === 'minus') {
      const op = this.next().kind === 'plus' ? '+' : '-'
      l = { t: 'bin', op, l, r: this.parseMul() }
    }
    return l
  }
  private parseMul(): Expr {
    let l = this.parseUnary()
    while (this.peek().kind === 'star' || this.peek().kind === 'slash') {
      const op = this.next().kind === 'star' ? '*' : '/'
      l = { t: 'bin', op, l, r: this.parseUnary() }
    }
    return l
  }
  private parseUnary(): Expr {
    if (this.peek().kind === 'minus') {
      this.next()
      return { t: 'unary', op: 'neg', e: this.parseUnary() }
    }
    return this.parseAtom()
  }
  // Postfix chain, generic over ANY primary expression (a bare source
  // identifier, a function call like `candle(...)`, now also a series or
  // bar expression):
  //   ".field"      - field access, no parens (read/bar/bundle - FIELDS
  //                   whitelist below, fieldOf() does the real per-kind
  //                   check at eval time)
  //   ".name(args)" - a dotted METHOD call (MSL: ind.rsi(14),
  //                   ser.crossed(...), ser.slope(5), ...) - distinct AST
  //                   node from plain field access since it takes args and
  //                   its name isn't restricted to the FIELDS whitelist
  //                   (methodCall()/the ind.* namespace own their own name
  //                   lists, checked at eval time for a clearer error).
  //   "[idx]"       - series indexing (MSL: ser[-1]) - idx is itself a
  //                   full expression so `ser[-n]` with a let-bound `n`
  //                   works too.
  private parseAtom(): Expr {
    let e = this.parsePrimary()
    for (;;) {
      if (this.peek().kind === 'dot') {
        this.next()
        // AUDIT FIX (caught by scripts/msl_unit.ts): `.call` / `.put` are
        // documented FIELDS (fieldOf implements them, the grammar comment
        // lists them), but `call`/`put` tokenize as KEYWORDS everywhere - so
        // expect('ident') here rejected them and EVERY script using the
        // documented `oracle.call` / `accute.put` shape failed to parse.
        // Accept the two direction keywords as field names; the value slot
        // carries the literal word either way.
        const ft = this.next()
        const fieldKw = ft.kind === 'call_kw' || ft.kind === 'put_kw'
        if (ft.kind !== 'ident' && !fieldKw)
          throw new MslSyntaxError(`line ${ft.line}: unknown field/method ".${ft.value}"`)
        if (this.peek().kind === 'lparen') {
          // a dotted call - name isn't checked against FIELDS (methods
          // have their own vocabulary, validated at eval time by
          // methodCall()/the ind./foot./tick. namespace dispatchers).
          this.next()
          const args: Expr[] = []
          if (this.peek().kind !== 'rparen') {
            args.push(this.parseOr())
            while (this.peek().kind === 'comma') {
              this.next()
              args.push(this.parseOr())
            }
          }
          this.expect('rparen')
          e = { t: 'method', obj: e, name: ft.value, args }
          continue
        }
        if (!FIELDS.has(ft.value)) throw new MslSyntaxError(`line ${ft.line}: unknown field ".${ft.value}" - use dir/direction/conf/confidence/active/call/put/value, a bar field (o/h/l/c/v/body/range/upper_wick/lower_wick), or an indicator bundle field (macd/signal/hist/upper/mid/lower/width/percentB/k/d/adx/plusDI/minusDI/line)`)
        e = { t: 'field', obj: e, field: ft.value }
        continue
      }
      if (this.peek().kind === 'lbracket') {
        this.next()
        const idx = this.parseOr()
        this.expect('rbracket')
        e = { t: 'index', obj: e, idx }
        continue
      }
      break
    }
    return e
  }

  private parsePrimary(): Expr {
    const t = this.next()
    if (t.kind === 'num') return { t: 'num', v: Number(t.value) }
    if (t.kind === 'str') return { t: 'str', v: t.value }
    if (t.kind === 'lparen') {
      const e = this.parseOr()
      this.expect('rparen')
      return e
    }
    if (t.kind === 'ident') {
      if (t.value === 'true') return { t: 'bool', v: true }
      if (t.value === 'false') return { t: 'bool', v: false }
      if (t.value === 'none') return { t: 'dir', v: 'none' }
      // Any identifier immediately followed by "(" is a function call -
      // the core arithmetic funcs (avg/sum/min/max/count/abs) and any
      // signal function a caller's resolver understands (candle/bar/ha/
      // renko/pf/indicator/...) are syntactically identical; which bucket
      // a name falls into is decided at EVAL time (evalExpr's 'call'
      // case), not at parse time - a new signal vocabulary never needs a
      // parser/grammar change, only a new resolver entry.
      if (this.peek().kind === 'lparen') {
        this.next()
        const args: Expr[] = []
        if (this.peek().kind !== 'rparen') {
          args.push(this.parseOr())
          while (this.peek().kind === 'comma') {
            this.next()
            args.push(this.parseOr())
          }
        }
        this.expect('rparen')
        const seq = t.value === 'since' || t.value === 'streak' ? this.stateSeq++ : undefined
        return { t: 'call', fn: t.value, args, ...(seq !== undefined ? { seq } : {}) }
      }
      return { t: 'ident', name: t.value }
    }
    if (t.kind === 'call_kw') return { t: 'dir', v: 'call' }
    if (t.kind === 'put_kw') return { t: 'dir', v: 'put' }
    throw new MslSyntaxError(`line ${t.line}: unexpected token "${t.value}"`)
  }
}

export function parseStrategyScript(src: string): { ok: true; ast: MslAst } | { ok: false; error: string } {
  try {
    const toks = tokenize(src)
    const ast = new Parser(toks).parseProgram()
    if (!ast.stmts.some((s) => s.kind === 'call') && !ast.stmts.some((s) => s.kind === 'put')) {
      return { ok: false, error: 'a strategy script needs at least one "call when ..." or "put when ..." statement' }
    }
    return { ok: true, ast }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------- evaluator ----------

class MslRuntimeError extends Error {}

/** Human-readable name for an error message - "a series (ind.rsi(...) result)",
 * "a bar (ohlc(...) result)", etc - instead of the raw tagged object. */
function compositeKind(v: unknown): string {
  if (isReadValue(v)) return 'a source/signal value'
  if (isSeriesValue(v)) return 'a series (ind.* result)'
  if (isBarValue(v)) return 'a bar (ohlc() result)'
  if (isBundleValue(v)) return 'an indicator bundle (ind.macd/bb/stoch/adx/supertrend result)'
  return 'this value'
}

function truthy(v: MslValue): boolean {
  if (isComposite(v)) throw new MslRuntimeError(`${compositeKind(v)} can't be used directly - access .dir/.conf/.active/.call/.put (read), a field (bar/bundle), or [n]/.method() (series) instead`)
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return v !== 'none' && v !== ''
}

function asNum(v: MslValue): number {
  if (isComposite(v)) throw new MslRuntimeError(`${compositeKind(v)} can't be used directly - access .conf/.value (read), a field (bar/bundle), or [n] (series) instead`)
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  throw new MslRuntimeError(`expected a number, got "${v}"`)
}

/** Dispatches `.field` by the OBJECT's actual kind - a read's dir/conf/
 * active/call/put/value (unchanged), a bar's OHLCV + shape, or a bundle's
 * named sub-value (ind.macd(...).hist, ind.bb(...).upper, ...). The parser's
 * FIELDS set is a flat early typo-catch across all three; this is where a
 * name that's valid for the WRONG kind (e.g. ".body" on a read) gets its
 * real, specific error. */
function fieldOf(val: MslValue, field: string): MslValue {
  if (isBundleValue(val)) {
    if (!(field in val.fields)) throw new MslRuntimeError(`"${compositeKind(val)}" has no field ".${field}"`)
    return val.fields[field]
  }
  if (isBarValue(val)) {
    switch (field) {
      case 'o':
      case 'open':
        return val.o
      case 'h':
      case 'high':
        return val.h
      case 'l':
      case 'low':
        return val.l
      case 'c':
      case 'close':
        return val.c
      case 'v':
      case 'volume':
        return val.v
      case 'body':
        return val.body
      case 'range':
        return val.range
      case 'upper_wick':
        return val.upperWick
      case 'lower_wick':
        return val.lowerWick
      default:
        throw new MslRuntimeError(`a bar has no field ".${field}" - use o/open, h/high, l/low, c/close, v/volume, body, range, upper_wick, lower_wick`)
    }
  }
  if (isSeriesValue(val)) throw new MslRuntimeError(`a series has no ".${field}" field - index it with "[n]" or call a method like ".crossed(...)"/".slope(n)"`)
  if (!isReadValue(val)) throw new MslRuntimeError(`".${field}" needs a source, signal, bar or indicator-bundle value, not "${val}"`)
  switch (field) {
    case 'dir':
    case 'direction':
      return val.direction
    case 'conf':
    case 'confidence':
      return val.confidence
    case 'active':
      return val.direction !== 'none'
    case 'call':
      return val.direction === 'call'
    case 'put':
      return val.direction === 'put'
    case 'value':
      // the source's own headline number in its native scale; a source
      // without one honestly reads 0 (documented per source in the reads
      // map builder - never a fabricated default)
      return val.value !== undefined && Number.isFinite(val.value) ? val.value : 0
    default:
      throw new MslRuntimeError(`unknown field ".${field}"`)
  }
}

/** `ser[-1]` = the latest value, `ser[-2]` = one bar back, etc - same
 * "-1 = latest" convention as the grammar proposal. `values` is stored
 * chronological ascending (last element = latest), so offset `k` (expected
 * <= 0) maps to `values.length - 1 + (k + 1)` = `values.length + k`. Throws
 * (fail-closed, same convention as every other "no data here" case in this
 * language) rather than returning NaN, both for a genuinely out-of-range
 * offset and for a value that's still NaN (indicator warmup window). */
function indexSeries(s: MslSeriesValue, offset: number): number {
  const i = s.values.length + Math.trunc(offset)
  if (i < 0 || i >= s.values.length) throw new MslRuntimeError(`series index [${offset}] out of range - only ${s.values.length} bar(s) of history available`)
  const v = s.values[i]
  if (!Number.isFinite(v)) throw new MslRuntimeError(`series value at [${offset}] isn't available yet (indicator warmup / thin history)`)
  return v
}

/** Last `n` FINITE values off the tail of a series (dropping NaN warmup
 * entries) - the window `.max/.min/.mean/.stddev(n)` compute over. Throws
 * if nothing finite is in that window at all (fail-closed). */
function lastFiniteWindow(values: number[], n: number): number[] {
  const window = Math.max(1, Math.trunc(n))
  const tail = values.slice(Math.max(0, values.length - window))
  const finite = tail.filter((v) => Number.isFinite(v))
  if (!finite.length) throw new MslRuntimeError(`not enough history for a ${window}-bar window yet`)
  return finite
}

/** Simple least-squares slope over a window of values, index-as-x (0..n-1) -
 * same idea strategies/custom.ts's own 'slope' indicator (linreg slope/ATR)
 * uses, exposed raw here so a script can scale/compare it itself. */
function linRegSlope(values: number[]): number {
  const n = values.length
  if (n < 2) return 0
  const mx = (n - 1) / 2
  const my = values.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = i - mx
    num += dx * (values[i] - my)
    den += dx * dx
  }
  return den === 0 ? 0 : num / den
}

/** `ser.crossed(...)` / `.slope(n)` / `.max/min/mean/stddev(n)` - the series
 * method vocabulary. `args` are already-evaluated MslValue (a `.crossed`
 * comparison level may itself be another series, e.g.
 * `ind.ema(9).crossed(ind.ema(21))`). */
function seriesMethod(name: string, args: MslValue[], s: MslSeriesValue): MslValue {
  const at = (v: MslValue, offset: number): number => (isSeriesValue(v) ? indexSeries(v, offset) : asNum(v))
  switch (name) {
    case 'slope':
      return linRegSlope(lastFiniteWindow(s.values, args.length ? asNum(args[0]) : 10))
    case 'max':
      return Math.max(...lastFiniteWindow(s.values, args.length ? asNum(args[0]) : 10))
    case 'min':
      return Math.min(...lastFiniteWindow(s.values, args.length ? asNum(args[0]) : 10))
    case 'mean': {
      const w = lastFiniteWindow(s.values, args.length ? asNum(args[0]) : 10)
      return w.reduce((a, b) => a + b, 0) / w.length
    }
    case 'stddev': {
      const w = lastFiniteWindow(s.values, args.length ? asNum(args[0]) : 10)
      const m = w.reduce((a, b) => a + b, 0) / w.length
      return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length)
    }
    case 'crossed': {
      // 1 arg: crossed another series/level, EITHER direction.
      // 2 args: crossed "up"/"down" through a level/series, that direction only.
      if (args.length === 1) {
        const other = args[0]
        const prevSign = Math.sign(at(s, -2) - at(other, -2))
        const curSign = Math.sign(at(s, -1) - at(other, -1))
        return prevSign !== 0 && curSign !== 0 && prevSign !== curSign
      }
      if (args.length === 2) {
        const dir = String(args[0])
        if (dir !== 'up' && dir !== 'down') throw new MslRuntimeError(`".crossed(dir, level)" dir must be "up" or "down" (got "${dir}") - or pass one argument to cross either direction`)
        const level = args[1]
        const prevA = at(s, -2)
        const curA = at(s, -1)
        const prevB = at(level, -2)
        const curB = at(level, -1)
        return dir === 'up' ? prevA <= prevB && curA > curB : prevA >= prevB && curA < curB
      }
      throw new MslRuntimeError('".crossed(...)" takes either (otherSeriesOrLevel) or ("up"|"down", level)')
    }
    default:
      throw new MslRuntimeError(`unknown series method ".${name}(...)" - use crossed/slope/max/min/mean/stddev`)
  }
}

/** `ohlc(-n)` - one historical bar's OHLCV + derived shape (body/range/
 * wicks), `-1` = the latest CLOSED bar, same offset convention as series
 * indexing. Needs the caller's raw candle history (`EvalEnv.series`) -
 * absent in a context that only built the panel-source `reads` map (fails
 * closed with a clear error, same as every other "not available here"
 * case). */
function ohlcAt(series: MslSeriesCtx | undefined, offset: number): MslBarValue {
  if (!series) throw new MslRuntimeError('ohlc() needs raw candle history, which is not available in this evaluation context')
  const n = series.close.length
  const i = n + Math.trunc(offset)
  if (i < 0 || i >= n) throw new MslRuntimeError(`ohlc(${offset}) out of range - only ${n} bar(s) of history available`)
  const o = series.open[i]
  const h = series.high[i]
  const l = series.low[i]
  const c = series.close[i]
  const v = series.volume[i]
  if (![o, h, l, c].every(Number.isFinite)) throw new MslRuntimeError(`ohlc(${offset}) isn't available yet (thin history)`)
  return {
    __mslBar: true,
    o,
    h,
    l,
    c,
    v: Number.isFinite(v) ? v : 0,
    body: Math.abs(c - o),
    range: h - l,
    upperWick: h - Math.max(o, c),
    lowerWick: Math.min(o, c) - l,
  }
}

/** Builds the same MslBarValue shape ohlcAt() returns, from an arbitrary
 * O/H/L/C/V - used by renko.ohlc()/ha.ohlc()/rangebars.ohlc()/
 * volumebars.ohlc() to expose a synthetic bar's full OHLC through the
 * IDENTICAL .o/.h/.l/.c/.v/.body/.range/.upper_wick/.lower_wick field
 * contract a real ohlc(offset) bar already has - a script written against
 * one works unmodified against the other. */
function barValueFromOHLC(o: number, h: number, l: number, c: number, v = 0): MslBarValue {
  return {
    __mslBar: true,
    o,
    h,
    l,
    c,
    v,
    body: Math.abs(c - o),
    range: h - l,
    upperWick: h - Math.max(o, c),
    lowerWick: Math.min(o, c) - l,
  }
}

/** Shared offset-into-an-array resolver for the brick/column/HA/synthetic-
 * bar `.ohlc(offset)` methods below - same convention as ohlc(offset)
 * itself: -1 = the latest, out-of-range fails closed with a clear error
 * naming how much history actually exists (never a silent wrap/clamp). */
function offsetInto<T>(arr: T[], offset: number, label: string): T {
  const n = arr.length
  const i = n + Math.trunc(offset)
  if (i < 0 || i >= n) throw new MslRuntimeError(`${label}(${offset}) out of range - only ${n} bar(s) of history available`)
  return arr[i]
}

/** `cross(a, b)` - the function-call alias of `a.crossed(b)` (either
 * direction), for when neither side reads more naturally as the "owner" of
 * the method - at least one side must be a series (crossing needs history;
 * two plain numbers never "cross"). */
function crossAny(a: MslValue, b: MslValue): boolean {
  if (!isSeriesValue(a) && !isSeriesValue(b)) throw new MslRuntimeError('cross(a, b) needs at least one series (e.g. ind.ema(9), ind.ema(21)) - two plain numbers can\'t cross')
  const at = (v: MslValue, offset: number): number => (isSeriesValue(v) ? indexSeries(v, offset) : asNum(v))
  const prevSign = Math.sign(at(a, -2) - at(b, -2))
  const curSign = Math.sign(at(a, -1) - at(b, -1))
  return prevSign !== 0 && curSign !== 0 && prevSign !== curSign
}

/** `ind.*` namespace - raw indicator primitives over the caller's series
 * context, reusing analytics/indicators.ts's EXISTING array-returning
 * implementations verbatim (nothing here recomputes any indicator math -
 * this is purely a script-callable wrapper). Single-series indicators
 * return an MslSeriesValue directly; indicators that naturally produce more
 * than one line (macd/bb/stoch/adx/supertrend) return an MslBundleValue
 * whose named fields are each themselves a series (`.hist`, `.upper`,
 * `.k`, `.plusDI`, `.line`, ...). */
/** `ind.*` needs the raw per-bar series context; some evaluation contexts
 * (no candle history threaded in) don't have one. Fails with a clear
 * message instead of a confusing downstream "undefined" error. */
/** Resolves which MslSeriesCtx a `ind.*`/`ohlc()` call should read from: the
 * caller's own-timeframe `series` by default, or a different timeframe's
 * series when `tf` (MSL's optional trailing TF argument, e.g.
 * `ind.rsi(14, "5m")`) names one - via `ctx.seriesFor`, which a caller with
 * no cross-timeframe support simply leaves undefined. Fails closed with a
 * message that distinguishes "no history at all here" from "no <TF>
 * support wired up" from "that tf has no data yet", rather than one
 * generic error for all three. */
/** `tick.*` namespace - raw live tick-window stats, for the omni-trader's
 * sub-bar reactivity (see EvalEnv.liveTicks's doc comment). Every method
 * takes an optional trailing window in SECONDS (default 5) and looks only
 * at ticks within that many seconds of the LAST tick in the buffer (not
 * wall-clock "now" - the buffer's own latest print IS "now" for a replay/
 * backtest context). Deliberately returns RAW numbers, not z-scored
 * thresholds like the otcv* indicator family - a script combines/compares
 * these itself (e.g. "velocity dropped near zero then burst" is naturally
 * "small window count, then a larger one, compared arithmetically"),
 * exactly the same raw-vs-thresholded split `ind.*` already drew for the
 * mainstream indicators. */
// ticks are chronological ascending - walk back from the end instead of
// filtering the whole buffer every call (the buffer can hold up to 60k
// prints per asset). A buffer whose last print is already OLDER than
// floorTs (a genuine stall) correctly yields an EMPTY window here, not the
// stale ticks from before the stall started. Shared by tickMethod()'s
// scalar reads and tickBucketedSeries()'s per-bucket reads below.
function sliceTickWindow(ticks: readonly { ts: number; price: number }[], endTs: number, windowSec: number): readonly { ts: number; price: number }[] {
  const floorTs = endTs - windowSec * 1000
  let i = ticks.length
  while (i > 0 && ticks[i - 1].ts >= floorTs) i--
  return ticks.slice(i).filter((t) => t.ts <= endTs)
}

// The scalar math for count/delta/velocity/ratio, factored out of
// tickMethod() so tickBucketedSeries() below can run it once per historical
// bucket instead of only ever on "now"'s trailing window.
function tickWindowMetric(name: 'count' | 'delta' | 'velocity' | 'ratio', windowTicks: readonly { ts: number; price: number }[]): number {
  switch (name) {
    case 'count':
      return windowTicks.length
    case 'delta': {
      // signed: up-ticks minus down-ticks (consecutive-equal prints never
      // enter the buffer at all - see otcfootprint.ts's record()).
      let up = 0
      let dn = 0
      for (let j = 1; j < windowTicks.length; j++) {
        if (windowTicks[j].price > windowTicks[j - 1].price) up++
        else if (windowTicks[j].price < windowTicks[j - 1].price) dn++
      }
      return up - dn
    }
    case 'velocity': {
      // ticks per second over however much of the window is actually
      // covered (not the requested window, in case the buffer itself
      // doesn't go back that far) - "velocity dropped to zero" reads
      // honestly as "0" rather than being diluted by an unfilled window.
      if (windowTicks.length < 2) return 0
      const spanSec = Math.max((windowTicks[windowTicks.length - 1].ts - windowTicks[0].ts) / 1000, 1e-3)
      return windowTicks.length / spanSec
    }
    case 'ratio': {
      // same log2(dnAvgMs/upAvgMs) shape as the otcvratio indicator/
      // velocitySeriesFor(), just over a live trailing window instead of a
      // candle bucket.
      let up = 0
      let dn = 0
      let upMs = 0
      let dnMs = 0
      for (let j = 1; j < windowTicks.length; j++) {
        const gap = Math.max(0, windowTicks[j].ts - windowTicks[j - 1].ts)
        if (windowTicks[j].price > windowTicks[j - 1].price) {
          up++
          upMs += gap
        } else if (windowTicks[j].price < windowTicks[j - 1].price) {
          dn++
          dnMs += gap
        }
      }
      const upAvg = up ? upMs / up : 0
      const dnAvg = dn ? dnMs / dn : 0
      const ratio = upAvg > 0 ? dnAvg / upAvg : dnAvg > 0 ? 8 : 1
      return Math.log2(Math.max(ratio, 1 / 8))
    }
  }
}

// Clamp bucket count the same way everywhere a script asks for a bucketed
// history (tick.*Series/foot.*Series) - at least 2 (a 1-bucket "series"
// isn't one), capped at 50 (each bucket is its own buffer walk/
// buildFootprint() call - 50 is already generous for a .slope()/.mean(n)
// read, which rarely wants more than a handful of recent buckets).
function seriesBucketCount(raw: number | undefined, dflt: number): number {
  const n = raw !== undefined && Number.isFinite(raw) ? raw : dflt
  return Math.max(2, Math.min(50, Math.round(n)))
}

/** `tick.<x>Series(windowSec?, buckets?)` - a SERIES of the last `buckets`
 * non-overlapping `windowSec`-wide tick-window readings of the same metric
 * `tick.<x>()` already returns as a scalar-now snapshot, chronological,
 * `[-1]` = the most recent (still-forming-ish, but same "now" window
 * tick.<x>() itself reads) bucket - giving a script `.slope()`/`.mean(n)`/
 * `.crossed()` rate-of-change over the tape, not just an instantaneous
 * read. Buckets are consecutive and END-aligned to `nowTs` (bucket 0 is the
 * OLDEST, ending `buckets * windowSec` seconds before now; the last bucket
 * ends exactly at `nowTs`, identical to what tick.<x>(windowSec) itself
 * would read right now) - no gaps, no overlap, same windowing semantics as
 * the scalar method reusing sliceTickWindow()/tickWindowMetric() per
 * bucket. */
function tickBucketedSeries(name: 'count' | 'delta' | 'velocity' | 'ratio', args: MslValue[], ticks: readonly { ts: number; price: number }[], nowTs: number): MslValue {
  const windowSec = args.length > 0 ? asNum(args[0]) : 5
  if (!Number.isFinite(windowSec) || windowSec <= 0) throw new MslRuntimeError(`tick.${name}Series(windowSec, buckets?) - windowSec must be a positive number`)
  const buckets = seriesBucketCount(args.length > 1 ? asNum(args[1]) : undefined, 10)
  const out: number[] = new Array(buckets)
  for (let b = 0; b < buckets; b++) {
    const endTs = nowTs - (buckets - 1 - b) * windowSec * 1000
    out[b] = ticks.length ? tickWindowMetric(name, sliceTickWindow(ticks, endTs, windowSec)) : 0
  }
  return seriesValue(out)
}

function tickMethod(name: string, args: MslValue[], ticks: readonly { ts: number; price: number }[], nowTs: number): MslValue {
  if (name === 'countSeries') return tickBucketedSeries('count', args, ticks, nowTs)
  if (name === 'deltaSeries') return tickBucketedSeries('delta', args, ticks, nowTs)
  if (name === 'velocitySeries') return tickBucketedSeries('velocity', args, ticks, nowTs)
  if (name === 'ratioSeries') return tickBucketedSeries('ratio', args, ticks, nowTs)
  if (name !== 'count' && name !== 'delta' && name !== 'velocity' && name !== 'ratio')
    throw new MslRuntimeError(`unknown tick method "tick.${name}(...)" - use delta/velocity/ratio/count, or deltaSeries/velocitySeries/ratioSeries/countSeries for a historical series`)
  const windowSec = args.length ? asNum(args[0]) : 5
  if (!Number.isFinite(windowSec) || windowSec <= 0) throw new MslRuntimeError(`tick.${name}(windowSec) - windowSec must be a positive number`)
  if (!ticks.length) return 0
  const windowTicks = sliceTickWindow(ticks, nowTs, windowSec)
  return tickWindowMetric(name, windowTicks)
}

/** `tick.*` needs the raw live tick buffer; fails closed with a message
 * that distinguishes "no live tick feed wired in" from the equivalent
 * `requireSeries()` messages for `ind.*`/`ohlc()`. */
function requireTicks(ctx: EvalEnv): readonly { ts: number; price: number }[] {
  if (!ctx.liveTicks) throw new MslRuntimeError('tick.*() needs a live tick feed, which is not available in this evaluation context (only the omni-trader wires one in)')
  return ctx.liveTicks
}

/** One footprint snapshot (per-price-level up/dn ticks, POC, stagnation,
 * speed ratio, delta) over the trailing `windowSec` of the live tick
 * buffer, measured back from wall-clock `nowMs` - same semantics as
 * `tick.*`'s windowing, built by asking `buildFootprint()` (analytics/
 * otcfootprint.ts - the SAME math the live Signal Panel's footprint chart
 * uses, nothing re-derived) for one bucket exactly `windowSec` wide and
 * taking its only/latest bucket. Returns undefined on no coverage (too few
 * prints in the window) rather than a zeroed-out fake bucket. */
function footSnapshot(ticks: readonly { ts: number; price: number }[], nowMs: number, windowSec: number): FootprintBucket | undefined {
  if (!ticks.length || !Number.isFinite(windowSec) || windowSec <= 0) return undefined
  const bucketSec = Math.max(5, Math.round(windowSec))
  const minutes = Math.max(1, Math.ceil(bucketSec / 60))
  const result = buildFootprint([...ticks], { bucketSec, minutes, nowMs })
  const bucket = result.buckets[result.buckets.length - 1]
  return bucket && bucket.nTicks >= 3 ? bucket : undefined
}

/** `foot.<x>Series(bucketSec?, buckets?)` - a SERIES of the last `buckets`
 * footprint-bucket readings of one aggregate field (poc/pocTicks/
 * stagnation/delta(velDelta)/speedRatio), chronological, `[-1]` = most
 * recent - the per-price-NODE sibling of `tick.<x>Series()`. Unlike
 * tick.*Series (which has to hand-roll bucketing via sliceTickWindow()
 * because tick.* has no natural multi-bucket engine), buildFootprint()
 * ALREADY produces a chronological array of buckets in one call - so this
 * reuses `result.buckets` directly instead of calling buildFootprint()
 * once per bucket (one pass over the tick buffer total, not `buckets`
 * passes). A bucket with too few prints (< 3 ticks, same thin-coverage
 * floor footSnapshot() itself uses) reads back as NaN rather than a
 * misleading zero - `.slope()`/`.mean(n)` on a series with real gaps is a
 * script-visible "thin data" signal, not a silent flat line. */
function footBucketedSeries(field: 'poc' | 'pocTicks' | 'stagnation' | 'delta' | 'speedRatio', args: MslValue[], ticks: readonly { ts: number; price: number }[], nowMs: number): MslValue {
  const bucketSec = Math.max(5, Math.round(args.length > 0 ? asNum(args[0]) : 10))
  if (!Number.isFinite(bucketSec) || bucketSec <= 0) throw new MslRuntimeError(`foot.${field}Series(bucketSec, buckets?) - bucketSec must be a positive number`)
  const buckets = seriesBucketCount(args.length > 1 ? asNum(args[1]) : undefined, 10)
  if (!ticks.length) return seriesValue(new Array(buckets).fill(NaN))
  const minutes = Math.max(1, Math.ceil((bucketSec * buckets) / 60))
  const result = buildFootprint([...ticks], { bucketSec, minutes, nowMs })
  const pick = (b: FootprintBucket | undefined): number => {
    if (!b || b.nTicks < 3) return NaN
    switch (field) {
      case 'poc':
        return b.pocPrice
      case 'pocTicks':
        return b.pocTicks
      case 'stagnation':
        return b.stagnation
      case 'delta':
        return b.velDelta
      case 'speedRatio':
        return b.speedRatio
    }
  }
  const tail = result.buckets.slice(-buckets)
  const out = tail.map(pick)
  while (out.length < buckets) out.unshift(NaN) // pad the front if buildFootprint() couldn't form `buckets` full windows yet (thin history)
  return seriesValue(out)
}

/** `foot.*` namespace - raw per-price-NODE footprint primitives, the piece
 * `tick.*` deliberately left out (tick.* is aggregate-over-the-whole-
 * window only, no per-price-level breakdown). Reuses buildFootprint()
 * verbatim; nothing here recomputes footprint math. */
function footMethod(name: string, args: MslValue[], ticks: readonly { ts: number; price: number }[], nowMs: number): MslValue {
  const defaultWindowSec = 10 // wider than tick.*'s 5s default - a footprint needs enough prints to actually form rows across price levels
  if (name === 'pocSeries') return footBucketedSeries('poc', args, ticks, nowMs)
  if (name === 'pocTicksSeries') return footBucketedSeries('pocTicks', args, ticks, nowMs)
  if (name === 'stagnationSeries') return footBucketedSeries('stagnation', args, ticks, nowMs)
  if (name === 'deltaSeries') return footBucketedSeries('delta', args, ticks, nowMs)
  if (name === 'speedRatioSeries') return footBucketedSeries('speedRatio', args, ticks, nowMs)
  switch (name) {
    case 'poc': {
      const b = footSnapshot(ticks, nowMs, args.length ? asNum(args[0]) : defaultWindowSec)
      return b ? b.pocPrice : 0
    }
    case 'pocTicks': {
      const b = footSnapshot(ticks, nowMs, args.length ? asNum(args[0]) : defaultWindowSec)
      return b ? b.pocTicks : 0
    }
    case 'stagnation': {
      // pocTicks / median(row totals) - ~1 = ordinary, >= 3 = a genuine
      // cluster (the "massive volume, no price movement" node).
      const b = footSnapshot(ticks, nowMs, args.length ? asNum(args[0]) : defaultWindowSec)
      return b ? b.stagnation : 0
    }
    case 'delta': {
      // up-ticks minus down-ticks across the WHOLE window (bucket-level,
      // not per-row) - the raw sibling of tick.delta(), footprint-shaped.
      const b = footSnapshot(ticks, nowMs, args.length ? asNum(args[0]) : defaultWindowSec)
      return b ? b.velDelta : 0
    }
    case 'speedRatio': {
      // dnAvgMs/upAvgMs, RAW (not log2-signed like tick.ratio()/otcvratio)
      // - >1 means price is moving UP through these levels faster, <1 the
      // mirror, 1 = symmetric.
      const b = footSnapshot(ticks, nowMs, args.length ? asNum(args[0]) : defaultWindowSec)
      return b ? b.speedRatio : 1
    }
    case 'imbalance': {
      // foot.imbalance("buy"|"sell", ratio, windowSec?) - true if the
      // BUSIEST price node (the POC - the level price is stalling at)
      // shows a diagonal up/dn imbalance of at least `ratio`x in that
      // direction. This is the literal "footprint prints extreme Delta
      // cluster... massive buying delta at the top of a candle" primitive
      // ("massive buying" = up-ticks; "buy"-side imbalance checks up/dn).
      if (args.length < 2) throw new MslRuntimeError(`foot.imbalance(side, ratio, windowSec?) takes at least 2 arguments, got ${args.length}`)
      const side = String(args[0])
      if (side !== 'buy' && side !== 'sell') throw new MslRuntimeError(`foot.imbalance(side, ...) - side must be "buy" or "sell" (got "${side}")`)
      const ratio = asNum(args[1])
      const b = footSnapshot(ticks, nowMs, args.length >= 3 ? asNum(args[2]) : defaultWindowSec)
      if (!b) return false
      let pocRow: FootprintBucket['rows'][number] | undefined
      for (const row of b.rows) if (!pocRow || row.total > pocRow.total) pocRow = row
      if (!pocRow) return false
      return side === 'buy' ? (pocRow.dn > 0 ? pocRow.up / pocRow.dn >= ratio : pocRow.up > 0) : pocRow.up > 0 ? pocRow.dn / pocRow.up >= ratio : pocRow.dn > 0
    }
    case 'consecutiveDense': {
      // foot.consecutiveDense(n, factor, windowSec?) - true if there is a
      // run of at least `n` PRICE-ADJACENT nodes (rows are already sorted
      // high price -> low, so array adjacency IS price adjacency) each
      // printing at least `factor` x the window's median row density. The
      // literal "3 to 5 consecutive price nodes printing maximum volume
      // density" primitive.
      if (args.length < 2) throw new MslRuntimeError(`foot.consecutiveDense(n, factor, windowSec?) takes at least 2 arguments, got ${args.length}`)
      const n = Math.max(1, Math.round(asNum(args[0])))
      const factor = asNum(args[1])
      const b = footSnapshot(ticks, nowMs, args.length >= 3 ? asNum(args[2]) : defaultWindowSec)
      if (!b || b.rows.length < n) return false
      const totals = b.rows.map((r) => r.total).sort((x, y) => x - y)
      const mid = totals.length >> 1
      const med = totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2
      if (med <= 0) return false
      let run = 0
      for (const row of b.rows) {
        if (row.total >= factor * med) {
          run++
          if (run >= n) return true
        } else {
          run = 0
        }
      }
      return false
    }
    case 'divergence': {
      // foot.divergence(windowSec?) - buildFootprint() ALREADY computes this
      // per bucket (FootprintBucket.divergence) and it was simply never
      // surfaced to MSL before (see claude/msl-capability-matrix.md section
      // L's "delta divergence" row) - the Metric-B divergence trap: heavy
      // positive delta closing at the window's LOW ('put-trap' - the
      // generator is capping a ceiling) or heavy negative delta closing at
      // the HIGH ('call-trap' - flooring). Returns the string itself
      // ('put-trap'|'call-trap'|'none'), never coerced to a boolean, so
      // "which kind" is never lost.
      const b = footSnapshot(ticks, nowMs, args.length ? asNum(args[0]) : defaultWindowSec)
      return b ? b.divergence ?? 'none' : 'none'
    }
    case 'exhaustion': {
      // foot.exhaustion(windowSec?) - same story: FootprintBucket.exhaustion
      // (speed-ratio exhaustion - one side ticking >= ratioAt times faster
      // while the OTHER side still has prints, a genuine one-sided thrust
      // rather than a one-way gap with no opposing flow at all) already
      // existed and was never exposed. Returns 'up'|'down'|'none'.
      const b = footSnapshot(ticks, nowMs, args.length ? asNum(args[0]) : defaultWindowSec)
      return b ? b.exhaustion ?? 'none' : 'none'
    }
    case 'cumulativeDelta': {
      // foot.cumulativeDelta(bucketSec?, buckets?) - RAW running sum of
      // per-bucket delta (velDelta) across the trailing `buckets` window,
      // the raw sibling of the existing `ofcumdelta` indicator (which is
      // candle-approximated AND z-scored - this is real-tick-derived and
      // unscaled, matching the "RAW, not z-scored/thresholded" convention
      // every other foot.*/tick.* primitive already follows). A bucket with
      // too few prints contributes 0, not NaN, to the SUM (unlike the
      // *Series siblings, which deliberately keep NaN gaps visible for
      // .slope()/.mean() - a running total should not go NaN just because
      // one thin bucket interrupted it).
      const bucketSec = Math.max(5, Math.round(args.length > 0 ? asNum(args[0]) : defaultWindowSec))
      const buckets = seriesBucketCount(args.length > 1 ? asNum(args[1]) : undefined, 10)
      if (!ticks.length) return 0
      const minutes = Math.max(1, Math.ceil((bucketSec * buckets) / 60))
      const result = buildFootprint([...ticks], { bucketSec, minutes, nowMs })
      const recent = result.buckets.slice(-buckets)
      let sum = 0
      for (const b of recent) if (b.nTicks >= 3) sum += b.velDelta
      return sum
    }
    case 'consecutiveImbalance': {
      // foot.consecutiveImbalance(side, ratio, n, bucketSec?) - the
      // "stacked imbalance" read (roadmap section 5): true iff the last `n`
      // CONSECUTIVE footprint buckets each show their own POC-row diagonal
      // imbalance of at least `ratio`x in `side`'s direction - same
      // per-bucket imbalance test foot.imbalance() already runs on a single
      // window, generalized across several consecutive buckets so a script
      // can tell "one lucky window" from "this side has been in control for
      // N buckets running" without re-deriving the loop itself.
      if (args.length < 3) throw new MslRuntimeError('foot.consecutiveImbalance(side, ratio, n, bucketSec?) takes at least 3 arguments')
      const side = String(args[0])
      if (side !== 'buy' && side !== 'sell') throw new MslRuntimeError(`foot.consecutiveImbalance(side, ...) - side must be "buy" or "sell" (got "${side}")`)
      const ratio = asNum(args[1])
      const n = Math.max(1, Math.round(asNum(args[2])))
      const bucketSec = Math.max(5, Math.round(args.length > 3 ? asNum(args[3]) : defaultWindowSec))
      if (!ticks.length) return false
      const minutes = Math.max(1, Math.ceil((bucketSec * n) / 60))
      const result = buildFootprint([...ticks], { bucketSec, minutes, nowMs })
      const recent = result.buckets.slice(-n)
      if (recent.length < n) return false
      return recent.every((b) => {
        if (b.nTicks < 3) return false
        let pocRow: FootprintBucket['rows'][number] | undefined
        for (const row of b.rows) if (!pocRow || row.total > pocRow.total) pocRow = row
        if (!pocRow) return false
        return side === 'buy' ? (pocRow.dn > 0 ? pocRow.up / pocRow.dn >= ratio : pocRow.up > 0) : pocRow.up > 0 ? pocRow.dn / pocRow.up >= ratio : pocRow.dn > 0
      })
    }
    default:
      throw new MslRuntimeError(`unknown foot method "foot.${name}(...)" - use poc/pocTicks/stagnation/delta/speedRatio/imbalance/consecutiveDense/divergence/exhaustion/cumulativeDelta/consecutiveImbalance, or pocSeries/pocTicksSeries/stagnationSeries/deltaSeries/speedRatioSeries for a historical series`)
  }
}

/** `renko.*`/`pf.*`/`ha.*`'s shared conversion - renkoBricks()/pointFigure()/
 * heikinAshiSeries() all want a real Candle[] (they only use .time to STAMP
 * their output, never to decide the math - brick/box/HA logic is pure
 * sequence + OHLCV), so a synthetic sequential time (0,1,2,...) is exactly
 * as correct as a real one here and lets these namespaces reuse
 * EvalEnv.series/seriesFor (the plain OHLCV arrays ind.* / ohlc() already
 * read) instead of needing a whole second raw-candle channel threaded in. */
function seriesToCandles(s: MslSeriesCtx): Candle[] {
  const n = s.close.length
  const out: Candle[] = new Array(n)
  for (let i = 0; i < n; i++) out[i] = { time: i, open: s.open[i], high: s.high[i], low: s.low[i], close: s.close[i], volume: s.volume[i] }
  return out
}

/** Clamp + round a series lookback argument the same way everywhere
 * (renko.bricks(n)/pf.boxes(n)/ha.bars(n)) - at least 1, capped at 200 (an
 * indicator-scale window; deeper history all tells the same "long-run
 * structure" story and costs a full brick/box/HA rebuild per extra bar). */
function seriesLookback(args: MslValue[], dflt: number): number {
  const n = args.length ? asNum(args[0]) : dflt
  return Math.max(1, Math.min(200, Math.round(n)))
}

/** `renko.*` - BRICK-level primitives, closing the gap the plain 'renko'
 * verdict read (.dir/.conf/.value - value is already the signed streak, so
 * renko.value covers "how long has it been running") leaves open: a script
 * can trade the aggregate trend, but couldn't ask a pattern question about
 * the bricks THEMSELVES ("first green brick after exactly 3 red bricks
 * where this brick is oversized") until now. `renko.bricks(n?)` is a
 * SERIES of the last n bricks' signed directions (+1/-1, chronological,
 * [-1] = the latest brick - same convention every other MSL series uses),
 * indexable and usable with every series method (.slope/.max/.min/.mean/
 * .stddev/.crossed). `renko.brickSize()` is the current ATR-derived (or
 * explicit, if configured) brick size in price units, for "is this brick
 * bigger than usual" checks (renko.brickSize() vs ohlc(-1).range, say).
 * Same optional trailing TF-string contract as ind.* / ohlc(). */
function renkoMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = renkoBricks(candles)
  switch (name) {
    case 'bricks':
      return seriesValue(r.bricks.map((b) => b.dir).slice(-seriesLookback(args, 50)))
    case 'brickSize':
      return r.brickSize
    case 'ohlc': {
      // renko.ohlc(offset) - a brick's own full OHLC (renko.bricks(n) only
      // ever gave signed DIRECTION; the brick's actual open/high/low/close
      // was already computed by renkoBricks() and simply never exposed -
      // see claude/msl-capability-matrix.md section H). Same -1=latest
      // offset convention as ohlc(offset) itself. Volume has no meaning for
      // a synthetic brick (it spans a variable number of source candles),
      // so v is always 0 here - never fabricate a number for it.
      if (!args.length) throw new MslRuntimeError('renko.ohlc(offset) needs an offset argument, e.g. renko.ohlc(-1)')
      const b = offsetInto(r.bricks, asNum(args[0]), 'renko.ohlc')
      return barValueFromOHLC(b.open, b.high, b.low, b.close, 0)
    }
    default:
      throw new MslRuntimeError(`unknown renko method "renko.${name}(...)" - use bricks(n?)/brickSize()/ohlc(offset) (or renko.dir/.conf/.value for the plain verdict read)`)
  }
}

/** `pf.*` - BOX-level primitives, same reasoning as renko.* above: the
 * plain 'pointFigure' verdict read only gives the aggregate column vote.
 * `pf.boxes(n?)` is a series of the last n columns' SIGNED box counts
 * (positive = X column, negative = O column, chronological, [-1] = the
 * current/most recent column) - lets a script ask "how many boxes has each
 * recent column painted," not just which way the current one leans.
 * `pf.boxSize()` is the current box size in price units. */
function pfMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = pointFigure(candles)
  switch (name) {
    case 'boxes':
      return seriesValue(r.columns.map((c) => (c.dir === 'X' ? c.boxes : -c.boxes)).slice(-seriesLookback(args, 50)))
    case 'boxSize':
      return r.boxSize
    case 'column': {
      // pf.column(offset) - a column's own top/bottom price boundary and
      // unsigned box count (PFColumn{top,bottom,boxes} - computed by
      // pointFigure() and, like renko's bricks, never exposed before). Dir
      // is deliberately NOT a field here (it's a string 'X'|'O' in the
      // underlying engine, which would be a confusing third "direction"
      // representation alongside the call/put/none literals and
      // pf.boxes(n)'s own +X/-O signed convention) - read pf.boxes(n)[-1]'s
      // sign for the same information.
      if (!args.length) throw new MslRuntimeError('pf.column(offset) needs an offset argument, e.g. pf.column(-1)')
      const col = offsetInto(r.columns, asNum(args[0]), 'pf.column')
      return bundleValue({ top: col.top, bottom: col.bottom, boxes: col.boxes })
    }
    default:
      throw new MslRuntimeError(`unknown pf method "pf.${name}(...)" - use boxes(n?)/boxSize()/column(offset) (or pointFigure.dir/.conf/.value for the plain verdict read)`)
  }
}

/** `ha.*` - Heikin Ashi candle-level primitives (a BRAND NEW namespace, not
 * the existing 'heikinAshi' verdict-read identifier - no collision, since
 * that one is only ever used as a field access, never a method call).
 * `ha.bars(n?)` is a series of the last n HA candles' signed body
 * directions (close>=open -> +1, else -1), same chronological/[-1]-latest
 * convention as renko.bricks()/pf.boxes() - lets a script pattern-match
 * across several HA candles. `ha.streak()` is the CURRENT signed run length
 * (positive = n consecutive green HA candles, negative = n red) - same
 * "+up/-down" convention renko's own .value field already uses.
 * `ha.flip()` is true the instant the latest HA candle's color differs from
 * the one before it (a fresh reversal, not a held trend). `ha.bodyAtr()` is
 * the latest HA candle's body size scaled by the SAME candle-based ATR
 * renko's own adaptive brick sizing uses (renkoAtr()) - "is this HA candle
 * unusually strong" without a script re-deriving its own ATR. */
function haMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const ha = heikinAshiSeries(candles)
  const dirs = ha.map((c) => (c.close >= c.open ? 1 : -1))
  switch (name) {
    case 'bars':
      return seriesValue(dirs.slice(-seriesLookback(args, 50)))
    case 'streak': {
      if (!dirs.length) return 0
      const last = dirs[dirs.length - 1]
      let streak = 0
      for (let i = dirs.length - 1; i >= 0 && dirs[i] === last; i--) streak++
      return last * streak
    }
    case 'flip':
      return dirs.length >= 2 && dirs[dirs.length - 1] !== dirs[dirs.length - 2]
    case 'bodyAtr': {
      if (!ha.length) return 0
      const lastBar = ha[ha.length - 1]
      const body = Math.abs(lastBar.close - lastBar.open)
      const atr = renkoAtr(candles)
      return Number.isFinite(atr) && atr > 0 ? body / atr : 0
    }
    case 'ohlc': {
      // ha.ohlc(offset) - the HA candle's own full OHLC (ha.bars(n) only
      // ever gave signed body direction - see claude/msl-capability-matrix.md
      // section C, the single biggest named gap there). Volume is the
      // UNDERLYING real candle's own volume at the same index (HA smoothing
      // only touches O/H/L/C, never volume) - carried through honestly
      // rather than fabricated as 0.
      if (!args.length) throw new MslRuntimeError('ha.ohlc(offset) needs an offset argument, e.g. ha.ohlc(-1)')
      const idx = candles.length + Math.trunc(asNum(args[0]))
      if (idx < 0 || idx >= ha.length) throw new MslRuntimeError(`ha.ohlc(${asNum(args[0])}) out of range - only ${ha.length} bar(s) of history available`)
      const bar = ha[idx]
      const v = candles[idx]?.volume
      return barValueFromOHLC(bar.open, bar.high, bar.low, bar.close, Number.isFinite(v) ? (v as number) : 0)
    }
    default:
      throw new MslRuntimeError(`unknown ha method "ha.${name}(...)" - use bars(n?)/streak()/flip()/bodyAtr()/ohlc(offset) (or heikinAshi.dir/.conf for the plain verdict read)`)
  }
}

/** `rangebars.*` - Range Bars had NO MSL namespace at all before this (see
 * claude/msl-capability-matrix.md section J) - only the aggregate
 * `rangeBars` verdict source existed. `rangebars.bars(n?)` is a series of
 * the last n bars' signed direction (+1 = closed at open+range, -1 =
 * open-range, same convention renko.bricks()/pf.boxes() already use).
 * `rangebars.ohlc(offset)` is a bar's full OHLC (range bars are wickless by
 * construction - high=max(open,close), low=min(open,close) - so this is
 * honest, not an approximation). `rangebars.range()` is the current range
 * threshold in price units. `rangebars.streak()` is the engine's own
 * consecutive-same-direction count (RangeBarsResult.streak), not
 * re-derived. Volume has no meaning for a range bar (wickless, time-
 * independent span) - rangebars.ohlc()'s v is always 0, same honesty rule
 * as renko.ohlc(). */
function rangebarsMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = rangeBars(candles)
  switch (name) {
    case 'bars':
      return seriesValue(r.bars.map((b) => b.dir).slice(-seriesLookback(args, 50)))
    case 'ohlc': {
      if (!args.length) throw new MslRuntimeError('rangebars.ohlc(offset) needs an offset argument, e.g. rangebars.ohlc(-1)')
      const b = offsetInto(r.bars, asNum(args[0]), 'rangebars.ohlc')
      return barValueFromOHLC(b.open, b.high, b.low, b.close, 0)
    }
    case 'range':
      return r.range
    case 'streak':
      return r.streak
    default:
      throw new MslRuntimeError(`unknown rangebars method "rangebars.${name}(...)" - use bars(n?)/ohlc(offset)/range()/streak() (or rangeBars.dir/.conf/.value for the plain verdict read)`)
  }
}

/** `volumebars.*` - Volume Bars also had NO MSL namespace at all before
 * this (same gap as Range Bars). `volumebars.bars(n?)` is a series of the
 * last n bars' signed direction - DERIVED here (close>=open -> +1, else
 * -1), since VolumeBar itself carries no `dir` field yet; deriving it at
 * the call site rather than editing volumebars.ts's shipped interface
 * keeps this change additive-only. `volumebars.ohlc(offset)` is a bar's
 * full OHLC WITH its real accumulated volume (unlike renko/range/pf, a
 * volume bar's volume is exactly the thing that closed it, so v is always
 * populated, honestly labeled via volumeSource below). `volumebars.
 * threshold()` is the current volume-per-bar threshold. `volumebars.
 * volumeSource()` surfaces the engine's own 'feed'|'none' honesty flag (a
 * script can gate on real-volume-vs-none exactly like the route already
 * does) - returned as the string itself, not coerced to a boolean, so a
 * future third state doesn't silently collapse into one side. */
function volumebarsMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = volumeBars(candles)
  switch (name) {
    case 'bars':
      return seriesValue(r.bars.map((b) => (b.close >= b.open ? 1 : -1)).slice(-seriesLookback(args, 50)))
    case 'ohlc': {
      if (!args.length) throw new MslRuntimeError('volumebars.ohlc(offset) needs an offset argument, e.g. volumebars.ohlc(-1)')
      const b = offsetInto(r.bars, asNum(args[0]), 'volumebars.ohlc')
      return barValueFromOHLC(b.open, b.high, b.low, b.close, b.volume)
    }
    case 'threshold':
      return r.per
    case 'volumeSource':
      return r.volumeSource
    default:
      throw new MslRuntimeError(`unknown volumebars method "volumebars.${name}(...)" - use bars(n?)/ohlc(offset)/threshold()/volumeSource() (or volumeBars.dir/.conf/.value for the plain verdict read)`)
  }
}

/** `tpo.*` - TPO/Market Profile also had NO MSL namespace at all before
 * this (same gap as Range/Volume Bars) - POC/VAH/VAL/Initial-Balance were
 * all already computed server-side (computeTpo()) and only reachable
 * through the aggregate `tpo` verdict source. Every accessor here is a
 * plain scalar (TPO has no natural "series of n" shape the way bricks/
 * boxes/HA bars do - a TPO profile is one value per PERIOD, and periods
 * default to 30 minutes, not per-candle) - returns NaN when the engine
 * itself returns null (empty window), never a misleading 0. Reminder (see
 * claude/msl-capability-matrix.md section O): this POC is TIME-based (TPO
 * letter counts), never confuse it with a VOLUME-based POC - that concept
 * doesn't exist anywhere yet (Volume Profile is a separate, not-yet-built
 * engine). */
function tpoMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = computeTpo(candles)
  const num = (v: number | null): number => (v === null ? NaN : v)
  switch (name) {
    case 'poc':
      return num(r.poc)
    case 'vah':
      return num(r.valueAreaHigh)
    case 'val':
      return num(r.valueAreaLow)
    case 'ibHigh':
      return num(r.ibHigh)
    case 'ibLow':
      return num(r.ibLow)
    default:
      throw new MslRuntimeError(`unknown tpo method "tpo.${name}(...)" - use poc()/vah()/val()/ibHigh()/ibLow() (or tpo.dir/.conf/.value for the plain verdict read)`)
  }
}

/** `vp.*` - Volume Profile (Phase 5 of the chart-engine expansion roadmap -
 * a genuinely NEW engine, not an exposure of something that already
 * existed server-side, unlike most of the Phase 2-4 additions above).
 * vp.poc()/vah()/val() are VOLUME-based (analytics/volumeprofile.ts) -
 * never confuse these with tpo.poc()/vah()/val() above, which are
 * TIME-based. vp.hvn(n?)/vp.lvn(n?) return a SERIES of up to n High/Low
 * Volume Node prices (chronological by PRICE, ascending - there is no
 * natural time order for a price-level list, so "series" here just means
 * "indexable list", [-1] = the highest-priced node, [0] = the lowest).
 * Quality is 'estimated' (range-overlap volume-spread proxy, same as
 * footprint.ts) - never 'measured'. */
function vpMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = computeVolumeProfile(candles)
  const num = (v: number | null): number => (v === null ? NaN : v)
  switch (name) {
    case 'poc':
      return num(r.poc)
    case 'vah':
      return num(r.valueAreaHigh)
    case 'val':
      return num(r.valueAreaLow)
    case 'totalVolume':
      return r.totalVolume
    case 'hvn':
      return seriesValue(r.hvn.slice(-seriesLookback(args, 10)))
    case 'lvn':
      return seriesValue(r.lvn.slice(-seriesLookback(args, 10)))
    default:
      throw new MslRuntimeError(`unknown vp method "vp.${name}(...)" - use poc()/vah()/val()/totalVolume()/hvn(n?)/lvn(n?)`)
  }
}

/** `linebreak.*` - Three-Line-Break (Phase 6). linebreak.bars(n?) is a
 * SERIES of the last n lines' signed direction, same chronological/[-1]
 * convention as renko.bricks()/rangebars.bars(). linebreak.ohlc(offset) is
 * a line's own open/close (CLOSE-based engine - see linebreak.ts's header -
 * so high=max(open,close)/low=min(open,close)/v=0, same honesty convention
 * as renko.ohlc()/rangebars.ohlc()). linebreak.lineCount() is the
 * configured N (3 by default - "three-line break"). linebreak.streak() is
 * the engine's own consecutive-same-direction line count. */
function linebreakMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = lineBreak(candles)
  switch (name) {
    case 'bars':
      return seriesValue(r.bars.map((b) => b.dir).slice(-seriesLookback(args, 50)))
    case 'ohlc': {
      if (!args.length) throw new MslRuntimeError('linebreak.ohlc(offset) needs an offset argument, e.g. linebreak.ohlc(-1)')
      const b = offsetInto(r.bars, asNum(args[0]), 'linebreak.ohlc')
      return barValueFromOHLC(b.open, Math.max(b.open, b.close), Math.min(b.open, b.close), b.close, 0)
    }
    case 'lineCount':
      return r.lineCount
    case 'streak':
      return r.streak
    default:
      throw new MslRuntimeError(`unknown linebreak method "linebreak.${name}(...)" - use bars(n?)/ohlc(offset)/lineCount()/streak()`)
  }
}

/** `kagi.*` - Kagi (Phase 6). kagi.direction() is the current trend's
 * signed direction. kagi.thick() is the CURRENT line segment's thickness
 * (true = thick/yang, false = thin/yin - see kagi.ts's header for the exact
 * shoulder/waist-break rule). kagi.reversal() is the current ATR-derived
 * reversal amount in price units. kagi.shoulder()/kagi.waist() are the most
 * recent shoulder/waist price levels (NaN until the first down/up
 * reversal has occurred, never a misleading 0). */
function kagiMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = kagi(candles)
  const num = (v: number | null): number => (v === null ? NaN : v)
  switch (name) {
    case 'direction':
      return r.direction
    case 'thick':
      return r.thick
    case 'reversal':
      return r.reversal
    case 'shoulder':
      return num(r.shoulder)
    case 'waist':
      return num(r.waist)
    default:
      throw new MslRuntimeError(`unknown kagi method "kagi.${name}(...)" - use direction()/thick()/reversal()/shoulder()/waist()`)
  }
}

/** `swing.*` - swing-structure (Phase 6). swing.structure() is
 * 'hh-hl'|'lh-ll'|'none' (see swing.ts's header - compares only the last TWO
 * confirmed highs and lows, 'none' is the honest "no clean structure yet"
 * read, not a forced guess). swing.direction() is the signed direction of
 * the most recent confirmed leg. swing.high(offset)/swing.low(offset) index
 * into the confirmed swing-high/swing-low price list (same -1=latest
 * convention as everywhere else), fails closed on an out-of-range offset -
 * remember a swing needs `lookback` bars AFTER it to confirm, so the most
 * recent bars never have one yet (not a bug). swing.length() is the bar
 * distance between the last two confirmed swings of EITHER kind (their
 * `index` difference) - a duration, not a price. */
function swingMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = computeSwing(candles)
  const highs = r.swings.filter((s) => s.kind === 'high')
  const lows = r.swings.filter((s) => s.kind === 'low')
  switch (name) {
    case 'structure':
      return r.structure
    case 'direction':
      return r.direction
    case 'high': {
      if (!args.length) throw new MslRuntimeError('swing.high(offset) needs an offset argument, e.g. swing.high(-1)')
      if (!highs.length) throw new MslRuntimeError('swing.high(offset) - no confirmed swing highs yet (too little history, or none met the lookback window)')
      return offsetInto(highs, asNum(args[0]), 'swing.high').price
    }
    case 'low': {
      if (!args.length) throw new MslRuntimeError('swing.low(offset) needs an offset argument, e.g. swing.low(-1)')
      if (!lows.length) throw new MslRuntimeError('swing.low(offset) - no confirmed swing lows yet (too little history, or none met the lookback window)')
      return offsetInto(lows, asNum(args[0]), 'swing.low').price
    }
    case 'length': {
      if (r.swings.length < 2) return 0
      const a = r.swings[r.swings.length - 2]
      const b = r.swings[r.swings.length - 1]
      return Math.abs(b.index - a.index)
    }
    default:
      throw new MslRuntimeError(`unknown swing method "swing.${name}(...)" - use structure()/direction()/high(offset)/low(offset)/length()`)
  }
}

function requireSeries(ctx: EvalEnv, tf?: string): MslSeriesCtx {
  if (tf === undefined) {
    if (!ctx.series) throw new MslRuntimeError('ind.*() needs raw candle history, which is not available in this evaluation context')
    return ctx.series
  }
  if (!ctx.seriesFor) throw new MslRuntimeError(`a <tf> argument ("${tf}") was given, but this evaluation context has no cross-timeframe support`)
  const s = ctx.seriesFor(tf)
  if (!s) throw new MslRuntimeError(`no candle history available for timeframe "${tf}" (unknown timeframe, or too thin to use yet)`)
  return s
}

function indicatorCall(name: string, args: MslValue[], s: MslSeriesCtx): MslValue {
  const n = (i: number, fallback: number): number => (args[i] !== undefined ? asNum(args[i]) : fallback)
  const { open, high, low, close, volume } = s
  switch (name) {
    case 'rsi':
      return seriesValue(rsiInd(close, n(0, 14)))
    case 'ema':
      return seriesValue(emaInd(close, n(0, 9)))
    case 'sma':
      return seriesValue(smaInd(close, n(0, 20)))
    case 'wma':
      return seriesValue(wmaInd(close, n(0, 20)))
    case 'hma':
      return seriesValue(hmaInd(close, n(0, 20)))
    case 'kama':
      return seriesValue(kamaInd(close, n(0, 10)))
    case 'vwma':
      return seriesValue(vwmaInd(close, volume, n(0, 20)))
    case 'atr':
      return seriesValue(atrInd(high, low, close, n(0, 14)))
    case 'roc':
      return seriesValue(rocInd(close, n(0, 12)))
    case 'momentum':
      return seriesValue(momInd(close, n(0, 10)))
    case 'zscore':
      return seriesValue(zscoreInd(close, n(0, 20)))
    case 'obv':
      return seriesValue(obvInd(close, volume))
    case 'cmf':
      return seriesValue(cmfInd(high, low, close, volume, n(0, 20)))
    case 'forceindex':
      return seriesValue(forceIndexInd(close, volume, n(0, 13)))
    case 'psar':
      return seriesValue(parabolicSarInd(high, low, n(0, 0.02), n(1, 0.2)))
    case 'macd': {
      const r = macdInd(close, n(0, 12), n(1, 26), n(2, 9))
      return bundleValue({ macd: seriesValue(r.macd), signal: seriesValue(r.signal), hist: seriesValue(r.hist) })
    }
    case 'bb': {
      const r = bollingerInd(close, n(0, 20), n(1, 2))
      return bundleValue({ upper: seriesValue(r.upper), mid: seriesValue(r.mid), lower: seriesValue(r.lower), width: seriesValue(r.width), percentB: seriesValue(r.percentB) })
    }
    case 'stoch': {
      const r = stochasticInd(high, low, close, n(0, 14), n(1, 3), n(2, 3))
      return bundleValue({ k: seriesValue(r.k), d: seriesValue(r.d) })
    }
    case 'adx': {
      const r = adxInd(high, low, close, n(0, 14))
      return bundleValue({ adx: seriesValue(r.adx), plusDI: seriesValue(r.plusDI), minusDI: seriesValue(r.minusDI) })
    }
    case 'supertrend': {
      // proposal's arg order is (mult, len); the underlying function takes
      // (period, mult) - mapped explicitly rather than reordering the
      // shared indicators.ts signature other callers already depend on.
      const r = supertrendInd(high, low, close, n(1, 10), n(0, 3))
      return bundleValue({ line: seriesValue(r.line), dir: seriesValue(r.dir) })
    }
    default:
      throw new MslRuntimeError(`unknown indicator "ind.${name}(...)" - rsi/ema/sma/wma/hma/kama/vwma/atr/roc/momentum/zscore/obv/cmf/forceindex/psar/macd/bb/stoch/adx/supertrend`)
  }
}

function evalExpr(e: Expr, env: Record<string, MslValue>, ctx: EvalEnv): MslValue {
  switch (e.t) {
    case 'num':
      return e.v
    case 'str':
      return e.v
    case 'bool':
      return e.v
    case 'dir':
      return e.v
    case 'ident': {
      // let-bindings take priority (a script can shadow a source name with
      // its own intermediate value); a name that isn't bound falls back to
      // the static `reads` map the caller supplied, wrapped into the SAME
      // read shape a signal-function call produces, so e.g. `oracle.dir`
      // and `let o = oracle; o.dir` behave identically.
      if (e.name in env) return env[e.name]
      if (e.name in ctx.reads) return readValue(ctx.reads[e.name])
      throw new MslRuntimeError(`unknown identifier "${e.name}" - not a let-binding, and not a known source (did you mean to add ".dir" or ".conf"?)`)
    }
    case 'field': {
      const val = evalExpr(e.obj, env, ctx)
      return fieldOf(val, e.field)
    }
    case 'index': {
      const obj = evalExpr(e.obj, env, ctx)
      const idx = asNum(evalExpr(e.idx, env, ctx))
      if (!isSeriesValue(obj)) throw new MslRuntimeError(`"[...]" indexing needs a series value, not "${compositeKind(obj)}"`)
      return indexSeries(obj, idx)
    }
    case 'method': {
      // `ind.rsi(14)` etc - "ind" is a namespace marker, not a real value,
      // so it's special-cased here rather than evaluated as an ident (which
      // would otherwise throw "unknown identifier ind").
      if (e.obj.t === 'ident' && e.obj.name === 'ind' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        // MSL: an optional trailing TF string ("5m", "1h", ...) reads
        // this indicator against a DIFFERENT timeframe's own candle history
        // instead of this pair's native one - e.g. ind.rsi(14, "5m") while
        // trading the 1m. Every ind.* param is otherwise numeric, so a
        // trailing string argument is unambiguous.
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return indicatorCall(e.name, args, requireSeries(ctx, tf))
      }
      // `tick.delta(5)` etc - same namespace-marker special case as "ind",
      // omni-trader only (requireTicks() fails closed everywhere else).
      if (e.obj.t === 'ident' && e.obj.name === 'tick' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        return tickMethod(e.name, args, requireTicks(ctx), ctx.liveNowMs ?? Date.now())
      }
      // `foot.imbalance(...)` etc - same namespace-marker special case,
      // same omni-trader-only contract (requireTicks() fails closed).
      if (e.obj.t === 'ident' && e.obj.name === 'foot' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        return footMethod(e.name, args, requireTicks(ctx), ctx.liveNowMs ?? Date.now())
      }
      // `renko.bricks(...)`/`pf.boxes(...)`/`ha.bars(...)` etc - brick/box/
      // HA-candle-level primitives, same optional trailing TF-string
      // contract as ind.*/ohlc(). 'renko' is ALSO a real reads-map identifier
      // (the plain verdict read, e.g. `renko.dir`) but that's a DIFFERENT
      // AST node (a 'field' access, no parens) - this only intercepts the
      // METHOD-call form, so `renko.dir`/`renko.value` are completely
      // unaffected. 'pf'/'ha' are brand new namespace markers (the verdict
      // reads use the different identifiers 'pointFigure'/'heikinAshi'), so
      // there's no collision to guard against for those two at all.
      if (e.obj.t === 'ident' && e.obj.name === 'renko' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return renkoMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'pf' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return pfMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'ha' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return haMethod(e.name, args, ctx, tf)
      }
      // `rangebars.*`/`volumebars.*`/`tpo.*` - same namespace-marker pattern
      // as renko/pf/ha above. 'rangeBars'/'volumeBars'/'tpo' are ALSO real
      // reads-map identifiers (the plain verdict reads, e.g. `tpo.dir`) but
      // that's the DIFFERENT 'field' AST node (no parens) - this only
      // intercepts the METHOD-call form, exactly the same non-collision as
      // renko.dir vs renko.bricks(...) above. Note the lowercase namespace
      // names here (rangebars/volumebars) vs the camelCase verdict-read
      // identifiers (rangeBars/volumeBars) - deliberately distinct spellings
      // so a script can never typo one into silently meaning the other.
      if (e.obj.t === 'ident' && e.obj.name === 'rangebars' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return rangebarsMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'volumebars' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return volumebarsMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'tpo' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return tpoMethod(e.name, args, ctx, tf)
      }
      // `vp.*`/`linebreak.*`/`kagi.*`/`swing.*` - Phase 5/6 namespaces, same
      // namespace-marker pattern as everything above. None of these four
      // collide with an existing verdict-read identifier ('vp'/'linebreak'/
      // 'kagi'/'swing' are brand new names, unlike renko/pf/ha/tpo/
      // rangebars/volumebars which already existed as field-access verdict
      // reads before gaining a method-call namespace).
      if (e.obj.t === 'ident' && e.obj.name === 'vp' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return vpMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'linebreak' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return linebreakMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'kagi' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return kagiMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'swing' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return swingMethod(e.name, args, ctx, tf)
      }
      const obj = evalExpr(e.obj, env, ctx)
      const args = e.args.map((a) => evalExpr(a, env, ctx))
      if (isSeriesValue(obj)) return seriesMethod(e.name, args, obj)
      throw new MslRuntimeError(`".${e.name}(...)" needs a series value, not "${compositeKind(obj)}"`)
    }
    case 'unary': {
      const v = evalExpr(e.e, env, ctx)
      if (e.op === 'not') return !truthy(v)
      return -asNum(v)
    }
    case 'bin': {
      if (e.op === 'and') return truthy(evalExpr(e.l, env, ctx)) && truthy(evalExpr(e.r, env, ctx))
      if (e.op === 'or') return truthy(evalExpr(e.l, env, ctx)) || truthy(evalExpr(e.r, env, ctx))
      const l = evalExpr(e.l, env, ctx)
      const r = evalExpr(e.r, env, ctx)
      if ((e.op === '==' || e.op === '!=') && (isComposite(l) || isComposite(r))) {
        throw new MslRuntimeError(`${compositeKind(isComposite(l) ? l : r)} can't be compared directly - access .dir/.conf/.active/.call/.put (read), a field (bar/bundle), or [n]/.method() (series) instead`)
      }
      switch (e.op) {
        case '==':
          return l === r
        case '!=':
          return l !== r
        case '>=':
          return asNum(l) >= asNum(r)
        case '<=':
          return asNum(l) <= asNum(r)
        case '>':
          return asNum(l) > asNum(r)
        case '<':
          return asNum(l) < asNum(r)
        case '+':
          return asNum(l) + asNum(r)
        case '-':
          return asNum(l) - asNum(r)
        case '*':
          return asNum(l) * asNum(r)
        case '/':
          return asNum(r) === 0 ? 0 : asNum(l) / asNum(r)
      }
      break
    }
    case 'call': {
      // 'if' is LAZY - only the taken branch is evaluated (so a branch that
      // would throw on this bar's data, e.g. reading a warming source, is
      // never touched when the condition picks the other one).
      if (e.fn === 'if') {
        if (e.args.length !== 3) throw new MslRuntimeError(`if(cond, then, else) takes exactly 3 arguments, got ${e.args.length}`)
        return truthy(evalExpr(e.args[0], env, ctx)) ? evalExpr(e.args[1], env, ctx) : evalExpr(e.args[2], env, ctx)
      }
      const args = e.args.map((a) => evalExpr(a, env, ctx))
      switch (e.fn) {
        case 'avg':
          return args.length ? args.reduce((s: number, a) => s + asNum(a), 0) / args.length : 0
        case 'sum':
          return args.reduce((s: number, a) => s + asNum(a), 0)
        case 'min':
          return args.length ? Math.min(...args.map(asNum)) : 0
        case 'max':
          return args.length ? Math.max(...args.map(asNum)) : 0
        case 'count':
          return args.filter(truthy).length
        case 'abs':
          return Math.abs(asNum(args[0] ?? 0))
        case 'clamp': {
          if (args.length !== 3) throw new MslRuntimeError(`clamp(x, lo, hi) takes exactly 3 arguments, got ${args.length}`)
          const [x, lo, hi] = args.map(asNum)
          return Math.max(lo, Math.min(hi, x))
        }
        case 'round':
          return Math.round(asNum(args[0] ?? 0))
        case 'floor':
          return Math.floor(asNum(args[0] ?? 0))
        case 'ceil':
          return Math.ceil(asNum(args[0] ?? 0))
        case 'sign':
          return Math.sign(asNum(args[0] ?? 0))
        case 'sqrt': {
          const v = asNum(args[0] ?? 0)
          if (v < 0) throw new MslRuntimeError('sqrt() of a negative number - would produce NaN confidence')
          return Math.sqrt(v)
        }
        case 'pow': {
          if (args.length !== 2) throw new MslRuntimeError(`pow(base, exp) takes exactly 2 arguments, got ${args.length}`)
          return Math.pow(asNum(args[0]), asNum(args[1]))
        }
        case 'mod': {
          if (args.length !== 2) throw new MslRuntimeError(`mod(a, b) takes exactly 2 arguments, got ${args.length}`)
          const b = asNum(args[1])
          if (b === 0) throw new MslRuntimeError('mod(a, 0) - divide by zero')
          return asNum(args[0]) % b
        }
        case 'ohlc': {
          // ohlc(offset) or ohlc(offset, "5m") - the optional 2nd arg is the
          // same cross-timeframe TF string ind.*() takes.
          if (args.length !== 1 && args.length !== 2) throw new MslRuntimeError(`ohlc(offset) or ohlc(offset, tf) takes 1 or 2 arguments, got ${args.length}`)
          const tf = args.length === 2 ? String(args[1]) : undefined
          return ohlcAt(requireSeries(ctx, tf), asNum(args[0]))
        }
        case 'cross': {
          if (args.length !== 2) throw new MslRuntimeError(`cross(a, b) takes exactly 2 arguments, got ${args.length}`)
          return crossAny(args[0], args[1])
        }
        case 'between': {
          if (args.length !== 3) throw new MslRuntimeError(`between(x, lo, hi) takes exactly 3 arguments, got ${args.length}`)
          const [x, lo, hi] = args.map(asNum)
          return x >= lo && x <= hi
        }
        case 'live': {
          // live() - the currently FORMING (unclosed) bar, omni-trader only.
          if (args.length !== 0) throw new MslRuntimeError(`live() takes no arguments, got ${args.length}`)
          if (!ctx.liveBar) throw new MslRuntimeError('live() needs the currently-forming bar, which is not available in this evaluation context (only the omni-trader wires one in)')
          return ctx.liveBar
        }
        case 'since': {
          if (args.length !== 1) throw new MslRuntimeError(`since(cond) takes exactly 1 argument, got ${args.length}`)
          return requireMslState(ctx, 'since', e.seq, truthy(args[0])).sinceBars
        }
        case 'streak': {
          if (args.length !== 1) throw new MslRuntimeError(`streak(cond) takes exactly 1 argument, got ${args.length}`)
          return requireMslState(ctx, 'streak', e.seq, truthy(args[0])).streakBars
        }
        default: {
          // Not a core arithmetic func - ask the caller's resolver (AI
          // Lab's signal vocabulary plugs in exactly here, see
          // strategies/signalscript.ts). Args to a signal function are
          // always plain config values (names/numbers/flags), never
          // another source/signal - asPlainArg enforces that so a
          // resolver never has to guard against receiving a read object.
          if (!ctx.resolve) throw new MslRuntimeError(`unknown function "${e.fn}"`)
          const plainArgs = args.map((a) => {
            if (isComposite(a)) throw new MslRuntimeError(`"${e.fn}(...)" got ${compositeKind(a)} as an argument - pass plain values (numbers, 'call'/'put', strings) instead`)
            return a
          })
          return readValue(ctx.resolve(e.fn, plainArgs))
        }
      }
    }
  }
  throw new MslRuntimeError('unreachable expression node')
}

/** Syntax-only rendering of an identifier/field-access chain (e.g.
 * "technical:30s.conf") - no evaluation, just the dotted name a `call
 * when`/`put when` clause actually wrote. Falls back to a generic
 * placeholder for a sub-expression that isn't a plain name (a nested
 * bin/unary/call as the object of a field access, e.g. "renko(2).dir" -
 * rare in practice since clauses almost always name a source directly). */
function prettyExpr(e: Expr): string {
  switch (e.t) {
    case 'ident':
      return e.name
    case 'field':
      return `${prettyExpr(e.obj)}.${e.field}`
    case 'num':
      return String(e.v)
    case 'str':
      return JSON.stringify(e.v)
    case 'bool':
      return String(e.v)
    case 'dir':
      return e.v
    default:
      return '<expr>'
  }
}

/** One decimal place for a clause-trace number - plenty of precision for
 * "was this confidence over the gate", without trailing float noise. */
function fmtExplainVal(v: MslValue): string {
  if (isReadValue(v)) {
    const parts = [`${v.direction}/${v.confidence}`]
    if (v.value !== undefined) parts.push(`val ${Math.round(v.value * 100) / 100}`)
    return parts.join(', ')
  }
  if (isSeriesValue(v)) {
    const last = v.values.length ? v.values[v.values.length - 1] : NaN
    return `series(...,${Number.isFinite(last) ? Math.round(last * 100) / 100 : 'NaN'})`
  }
  if (isBarValue(v)) return `bar(o${v.o} h${v.h} l${v.l} c${v.c})`
  if (isBundleValue(v)) return `bundle(${Object.keys(v.fields).join('/')})`
  if (typeof v === 'number') return String(Math.round(v * 100) / 100)
  return String(v)
}

/** Clause-level trace for ONE `call when`/`put when` expression - the
 * per-source .dir/.conf (or let-bound intermediate) values that actually
 * decided the true/false, instead of a bare "call when ... -> false" that
 * names no cause. Mirrors evalExpr's exact laziness (and/or short-circuit,
 * if()'s untaken branch) so it never forces a branch evalExpr itself would
 * have skipped - a warming source in the untaken half of an if(), or past
 * the short-circuit point of an "and"/"or", must stay unevaluated here too,
 * or this would throw on data evalExpr never needed to touch. Every value
 * is still produced by evalExpr itself (never reimplemented), so the trace
 * can never disagree with the actual verdict - this only adds narration
 * around calls evalExpr already made. */
function explainExpr(e: Expr, env: Record<string, MslValue>, ctx: EvalEnv): { text: string; value: MslValue } {
  switch (e.t) {
    case 'num':
    case 'str':
    case 'bool':
    case 'dir': {
      const value = evalExpr(e, env, ctx)
      return { text: fmtExplainVal(value), value }
    }
    case 'ident':
    case 'field': {
      const value = evalExpr(e, env, ctx)
      return { text: `${prettyExpr(e)}=${fmtExplainVal(value)}`, value }
    }
    case 'unary': {
      const inner = explainExpr(e.e, env, ctx)
      const value = e.op === 'not' ? !truthy(inner.value) : -asNum(inner.value)
      return { text: `${e.op === 'not' ? 'not' : '-'}(${inner.text})=${fmtExplainVal(value)}`, value }
    }
    case 'bin': {
      if (e.op === 'and') {
        const left = explainExpr(e.l, env, ctx)
        if (!truthy(left.value)) return { text: `${left.text} and <short-circuited, not evaluated>`, value: false }
        const right = explainExpr(e.r, env, ctx)
        return { text: `${left.text} and ${right.text}`, value: truthy(right.value) }
      }
      if (e.op === 'or') {
        const left = explainExpr(e.l, env, ctx)
        if (truthy(left.value)) return { text: `${left.text} or <short-circuited, not evaluated>`, value: true }
        const right = explainExpr(e.r, env, ctx)
        return { text: `${left.text} or ${right.text}`, value: truthy(right.value) }
      }
      // every other binary op is non-lazy (evalExpr always touches both
      // sides) - safe to explain both, then let evalExpr itself compute the
      // real result rather than re-deriving comparison/arithmetic semantics
      // here a second time.
      const left = explainExpr(e.l, env, ctx)
      const right = explainExpr(e.r, env, ctx)
      const value = evalExpr(e, env, ctx)
      return { text: `${left.text} ${e.op} ${right.text}=${fmtExplainVal(value)}`, value }
    }
    case 'call': {
      if (e.fn === 'if') {
        const cond = explainExpr(e.args[0], env, ctx)
        const takeThen = truthy(cond.value)
        const branch = explainExpr(takeThen ? e.args[1] : e.args[2], env, ctx)
        return { text: `if(${cond.text}) ${takeThen ? 'then' : 'else'} ${branch.text}`, value: branch.value }
      }
      const value = evalExpr(e, env, ctx)
      const argTexts = e.args.map((a) => explainExpr(a, env, ctx).text)
      return { text: `${e.fn}(${argTexts.join(', ')})=${fmtExplainVal(value)}`, value }
    }
    case 'index': {
      const value = evalExpr(e, env, ctx)
      return { text: `${prettyExpr(e.obj)}[${explainExpr(e.idx, env, ctx).text}]=${fmtExplainVal(value)}`, value }
    }
    case 'method': {
      // Not lazy and doesn't need its own per-arg narration (ind.*/series
      // methods are leaf numeric computations, not boolean gates) - just
      // evaluate once and format, same as a plain 'call'.
      const value = evalExpr(e, env, ctx)
      const argTexts = e.args.map((a) => explainExpr(a, env, ctx).text)
      return { text: `${prettyExpr(e.obj)}.${e.name}(${argTexts.join(', ')})=${fmtExplainVal(value)}`, value }
    }
  }
}

/** Run a parsed script against one asset+tf's current source reads.
 * Fail-closed, same convention every other strategy evaluator in this
 * codebase uses: a runtime error (unknown source, a thin-history source
 * that never got a slot in `reads`) resolves to 'none' with the error
 * message attached, never a thrown exception into the trading loop. */
export function evaluateStrategyScript(
  ast: MslAst,
  reads: Record<string, MslSourceRead>,
  resolve?: MslSignalResolver,
  series?: MslSeriesCtx,
  seriesFor?: (tf: string) => MslSeriesCtx | undefined,
  live?: { bar?: MslBarValue; ticks?: readonly { ts: number; price: number }[]; nowMs?: number },
  state?: { keyPrefix: string; barTimeSec?: number },
): MslEvalResult {
  const ctx: EvalEnv = {
    reads,
    resolve,
    series,
    seriesFor,
    liveBar: live?.bar,
    liveTicks: live?.ticks,
    liveNowMs: live?.nowMs,
    stateKeyPrefix: state?.keyPrefix,
    barTimeSec: state?.barTimeSec,
  }
  const env: Record<string, MslValue> = {}
  const trace: string[] = []
  const configs: Record<string, number | boolean | string> = {}
  let callFired = false
  let putFired = false
  let confidenceExpr: Expr | null = null
  let expiryExpr: Expr | null = null
  try {
    for (const stmt of ast.stmts) {
      if (stmt.kind === 'let') {
        env[stmt.name] = evalExpr(stmt.expr, env, ctx)
        continue
      }
      if (stmt.kind === 'call') {
        const v = truthy(evalExpr(stmt.expr, env, ctx))
        if (v) callFired = true
        trace.push(`call when ${explainExpr(stmt.expr, env, ctx).text} -> ${v}`)
        continue
      }
      if (stmt.kind === 'put') {
        const v = truthy(evalExpr(stmt.expr, env, ctx))
        if (v) putFired = true
        trace.push(`put when ${explainExpr(stmt.expr, env, ctx).text} -> ${v}`)
        continue
      }
      if (stmt.kind === 'confidence') {
        confidenceExpr = stmt.expr // evaluated below, only if a side actually fired
        continue
      }
      if (stmt.kind === 'expiry') {
        expiryExpr = stmt.expr // evaluated below, only if a side actually fired
        continue
      }
      if (stmt.kind === 'configure') {
        // config values are PLAIN numbers/booleans/strings - a read object
        // here is almost certainly a typo ("configure renko = ..." without
        // the key), so it fails the script loudly instead of poisoning the
        // caller's whitelist lookup.
        const v = evalExpr(stmt.expr, env, ctx)
        if (isReadValue(v)) throw new MslRuntimeError(`"configure ${stmt.path}" got a source/signal value - the value must be a plain number/boolean/string`)
        configs[stmt.path] = v as number | boolean | string
        trace.push(`configure ${stmt.path} = ${String(v)}`)
        continue
      }
    }
  } catch (err) {
    return { direction: 'none', confidence: 0, trace, error: err instanceof Error ? err.message : String(err) }
  }

  if (callFired && putFired) {
    trace.push('both "call when" and "put when" fired - conflicting, reads as none')
    return { direction: 'none', confidence: 0, trace }
  }
  if (!callFired && !putFired) {
    return { direction: 'none', confidence: 0, trace }
  }
  const direction: 'call' | 'put' = callFired ? 'call' : 'put'
  let confidence = 65 // same "lone signal, no honesty-loop number to lean on" flat default smcNowRead() uses
  if (confidenceExpr) {
    try {
      const raw = asNum(evalExpr(confidenceExpr, env, ctx))
      // AUDIT: Math.max/Math.min/round all pass NaN straight through, so an
      // expression that reached +/-Infinity (huge-literal overflow) and then
      // Infinity - Infinity in a let-binding used to exit here as a NaN
      // confidence on a live direction. Fail closed instead: a non-finite
      // confidence is an error, and an error resolves to none/0 (below).
      if (!Number.isFinite(raw)) throw new MslRuntimeError('confidence expression produced a non-finite value (check for divide-by-zero-style arithmetic on huge literals)')
      confidence = Math.max(0, Math.min(100, Math.round(raw)))
    } catch (err) {
      return { direction: 'none', confidence: 0, trace, error: `confidence expression failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  } else {
    trace.push('no "confidence = ..." statement - defaulted to 65 (set one explicitly for a real number)')
  }
  // expiry statement: whole minutes 1-60, evaluated ONLY when a side fired
  // (same laziness contract as confidence) - a non-finite result fails the
  // whole script closed, same as a bad confidence.
  let expiryMin: number | undefined
  if (expiryExpr) {
    try {
      const raw = asNum(evalExpr(expiryExpr, env, ctx))
      if (!Number.isFinite(raw)) throw new MslRuntimeError('expiry expression produced a non-finite value')
      expiryMin = Math.max(1, Math.min(60, Math.round(raw)))
      if (expiryMin !== raw) trace.push(`expiry = ${raw} clamped/rounded to ${expiryMin} (whole minutes 1-60)`)
    } catch (err) {
      return { direction: 'none', confidence: 0, trace, error: `expiry expression failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return { direction, confidence, trace, ...(expiryMin !== undefined ? { expiryMin } : {}), ...(Object.keys(configs).length ? { configs } : {}) }
}
