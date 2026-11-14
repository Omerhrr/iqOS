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
import { buildFootprint, footprintValueArea, diagonalImbalance, footprintAbsorption, unfinishedAuction, type FootprintBucket } from './otcfootprint'
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
import { computeDeltaProfile } from './deltaprofile'
import { lineBreak } from './linebreak'
import { kagi } from './kagi'
import { computeSwing } from './swing'
import { tickBars, type TickPoint } from './tickbars'
import { computeBaseline } from './baseline'
import { hvSeries, realizedUpProb, ivFromPayout } from './ivhv'
import { expiryMomentum, priceDisplacement, volAdjustedExpectedMove, reversalRisk, expiryStagnationExhaustion, candleCompletionProbability } from './expiryintel'
import { detectGaps } from './gap'
import { effortBricks } from './effortbricks'
import { computeMrc } from './mrc'
import { computePulseBars } from './pulsebars'
import { computeLiquiditySpring } from './liquidityspring'
import { computeVolatilityEcho } from './volatilityecho'
import { computeTickFootprint } from './tickdesk'
import { computeOutcomeMemory } from './outcomememory'
import { readSignalCore, SIGNAL_MIN_BARS, type SignalCore } from './signalcore'
import { AMD_MIN_BARS, readAmd, type AmdRead } from './mslamd'
import { WYCKOFF_MIN_BARS, readWyckoff, type WyckoffRead } from './mslwyckoff'
import { SMCX_MIN_BARS, readSmcx, type SmcxRead } from './mslsmcx'
import { smtDivergence } from './smt'
import { readBlocks, readJudas, readSoup, type BlockRead, type JudasRead } from './mslpatterns'
import { MMXM_MIN_BARS, readMmxm, type MmxmRead } from './mslmmxm'
import { PV_MIN_BARS, readPv, type PvRead } from './mslpv'
import {
  FIB_MIN_BARS, FIB_RATIOS, VOL_MIN_BARS, fibSwing, fibRetr, fibExt, fibPos, fibArc, fibTimeZone, readPivots, readVol, type FibSwing,
} from './mslfib'
import {
  MODEL_MIN_BARS, HURST_MIN_BARS, CM_MIN_BARS, STAT_NAMES, readOU, readMarkov, statValue, cmRead, cmHas, cmRevealedHas, cmDir, cmSmart,
  type OUModel, type MarkovModel,
} from './mslmodels'
import { oscillatorVotes, maVotes, TECH_MIN_BARS, TECH_BARS_PER_RUNG, type TechVote } from './technicals'

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
  /** Candle open times (epoch seconds), one per bar. Optional: only the `signal.*`
   * namespace needs them (SMC kill-zones key on the UTC hour, the bar length
   * comes from the gaps). Every production producer fills it in; a context
   * without it makes `signal.*` fail closed. */
  time?: number[]
  /** `smt.*`: resolves ANOTHER pair's series on this evaluation's timeframe (live: the partner's closed candles; backtest: the partner candles up to
   * the evaluated bar). Absent = the context has no partner support and `smt.*` fails closed. */
  partner?: (asset: string) => MslSeriesCtx | undefined
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
  /** BUG FIX (flagged repeatedly across the roadmap tracker and capability
   * matrix as a standing gap, closed in the footprint-completion follow-up):
   * the SAME `configure <path> = <value>` statements a script already
   * collects into MslEvalResult.configs (see evaluateStrategyScript below)
   * - but by reference, LIVE, so a namespace method evaluated LATER in the
   * same script (the renko, pf, rangebars, volumebars, vp, dp, linebreak,
   * kagi, and swing namespaces) can read its own sizing overrides
   * at call time, not just have them collected and handed to the CALLER for
   * a SEPARATE future run. Before this fix, `configure vp.binCount = 30`
   * followed by `vp.poc()` in the same script had ZERO effect on that call
   * - the override only ever reached `plugins/metastrategy.ts`'s readSource()
   * switch (the live VERDICT-source path), never a raw namespace call
   * evaluated directly inside evaluateStrategyScript(). Undefined (the
   * normal case for a reads-only evaluation with no configure statements,
   * or a caller that built no `configs` object at all) means every
   * namespace method below falls back to its engine's own hardcoded
   * default, exactly the pre-fix behavior - this is purely additive. */
  configs?: Record<string, number | boolean | string>
}

/** Shared config-override readers for the namespace methods below - same
 * shape as plugins/metastrategy.ts's own cfgNum()/cfgBool(), duplicated
 * rather than imported (dependency-isolation convention this codebase keeps
 * throughout; see e.g. analytics/momentumscore.ts's module header for the
 * same reasoning applied elsewhere). Reads from ctx.configs, which is
 * either the live, in-progress `configs` map a script's own `configure`
 * statements are writing into THIS SAME run (see EvalEnv.configs' doc
 * comment), or whatever a caller pre-seeded it with (e.g. a saved spec's
 * previously-collected overrides) - either way, undefined/missing/wrong-
 * typed always means "use the engine's own default", never a thrown error -
 * configure overrides are an optional convenience, not a requirement. */
function cfgNumLang(ctx: EvalEnv, key: string, fallback: number | undefined): number | undefined {
  const v = ctx.configs?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
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
  /** `if <cond> ... elseif <cond> ... else ... end` - the first branch whose condition is true runs; `else` runs when none did */
  | { kind: 'if'; branches: { cond: Expr; body: Stmt[]; line: number }[]; elseBody?: Stmt[] }

export type MslStmt = Stmt

/** every statement in the script, branch bodies included (depth-first, source order) */
export function flattenStmts(stmts: Stmt[]): Stmt[] {
  const out: Stmt[] = []
  const walk = (list: Stmt[]) => {
    for (const s of list) {
      out.push(s)
      if (s.kind === 'if') {
        for (const b of s.branches) walk(b.body)
        if (s.elseBody) walk(s.elseBody)
      }
    }
  }
  walk(stmts)
  return out
}

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
  // bundle sub-fields on foot.row(levelIndex, bucketsAgo?, bucketSec?) -
  // the footprint-completion sweep's raw per-price-level ladder walk (see
  // that method's own doc comment in footMethod()). 'price'/'up'/'dn'/
  // 'total' are genuinely new names; 'delta'/'imbalance' already exist as
  // foot.* METHOD names (foot.delta()/foot.imbalance()) but never as a
  // FIELD before - no collision, since a method call (foot.delta()) and a
  // bundle field access (r.delta) are different grammar productions and
  // this same set is already shared safely across every bundle kind above.
  'price', 'up', 'dn', 'total', 'delta', 'imbalance',
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
      if (this.isBlockWord(['elseif', 'else', 'end'])) throw new MslSyntaxError(`line ${this.peek().line}: "${this.peek().value}" without a matching "if"`)
      stmts.push(this.parseStatement(0))
      // a statement must end at a line-break ('eof' token) or real eof
      if (this.peek().kind !== 'eof') throw new MslSyntaxError(`line ${this.peek().line}: unexpected "${this.peek().value}" after statement`)
    }
    return { stmts }
  }

  /** the next token is a bare word (identifier) spelling one of these - block keywords are only special at the START of a statement */
  private isBlockWord(words: string[]): boolean {
    const t = this.peek()
    return t.kind === 'ident' && words.includes(t.value)
  }

  /** statements up to (not including) one of the stop words; line breaks between them are skipped */
  private parseBlockBody(stop: string[], depth: number, openLine: number): Stmt[] {
    const body: Stmt[] = []
    for (;;) {
      while (this.peek().kind === 'eof' && this.pos < this.toks.length - 1) this.pos++
      if (this.peek().kind === 'eof') throw new MslSyntaxError(`line ${openLine}: this "if" block is never closed - add "end"`)
      if (this.isBlockWord(stop)) return body
      body.push(this.parseStatement(depth))
      if (this.peek().kind !== 'eof') throw new MslSyntaxError(`line ${this.peek().line}: unexpected "${this.peek().value}" after statement`)
    }
  }

  /** if <cond> [then] / elseif <cond> / else if <cond> / else / end */
  private parseIf(depth: number): Stmt {
    if (depth >= 8) throw new MslSyntaxError(`line ${this.peek().line}: "if" blocks nested more than 8 deep`)
    const openLine = this.peek().line
    const branches: { cond: Expr; body: Stmt[]; line: number }[] = []
    let elseBody: Stmt[] | undefined
    this.next() // 'if'
    const readCond = (): Expr => {
      const cond = this.parseOr()
      if (this.isBlockWord(['then'])) this.next()
      if (this.peek().kind !== 'eof') throw new MslSyntaxError(`line ${this.peek().line}: unexpected "${this.peek().value}" after the if condition - put the statements on the following lines`)
      return cond
    }
    branches.push({ line: openLine, cond: readCond(), body: this.parseBlockBody(['elseif', 'else', 'end'], depth + 1, openLine) })
    for (;;) {
      const w = this.peek()
      if (this.isBlockWord(['elseif'])) {
        this.next()
        branches.push({ line: w.line, cond: readCond(), body: this.parseBlockBody(['elseif', 'else', 'end'], depth + 1, openLine) })
        continue
      }
      if (this.isBlockWord(['else'])) {
        this.next()
        if (this.isBlockWord(['if'])) {
          // "else if <cond>" is the same as "elseif <cond>"
          this.next()
          branches.push({ line: w.line, cond: readCond(), body: this.parseBlockBody(['elseif', 'else', 'end'], depth + 1, openLine) })
          continue
        }
        if (this.peek().kind !== 'eof') throw new MslSyntaxError(`line ${w.line}: "else" takes no condition (use "elseif <cond>" for another test)`)
        elseBody = this.parseBlockBody(['elseif', 'else', 'end'], depth + 1, openLine)
        if (!this.isBlockWord(['end'])) throw new MslSyntaxError(`line ${this.peek().line}: nothing may follow "else" except "end" (found "${this.peek().value}")`)
        break
      }
      break
    }
    if (!this.isBlockWord(['end'])) throw new MslSyntaxError(`line ${openLine}: this "if" block is never closed - add "end"`)
    this.next() // 'end'
    return { kind: 'if', branches, ...(elseBody ? { elseBody } : {}) }
  }

  private parseStatement(depth = 0): Stmt {
    const t = this.peek()
    if (t.kind === 'ident' && t.value === 'if') return this.parseIf(depth)
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
        // BUG FIX (strategy vet): a path SEGMENT that happens to spell a
        // keyword (`configure memory.expiry = 2` - 'expiry' tokenizes as
        // expiry_kw, not ident) used to die here with `expected ident, got
        // "expiry"`, so the whitelisted 'memory.expiry' knob could never be
        // set from a script at all - Outcome Memory was stuck on its 5-bar
        // default horizon no matter what expiry the script itself traded.
        // After a dot inside a configure path a word is always a key
        // segment, never a statement keyword, so accept it as one.
        const seg = this.peek()
        if (seg.kind !== 'ident' && KEYWORDS[seg.value] !== undefined) {
          this.next()
          path += `.${seg.value}`
        } else {
          path += `.${this.expect('ident').value}`
        }
      }
      if (!path.includes('.')) throw new MslSyntaxError(`line ${t.line}: "configure" needs a dotted key like configure renko.atrMult = 0.5 (got "${path}")`)
      this.expect('eq_assign')
      return { kind: 'configure', path, expr: this.parseOr() }
    }
    throw new MslSyntaxError(`line ${t.line}: expected "let", "call when", "put when", "confidence =", "expiry =", "configure ... =" or an "if" block, got "${t.value}"`)
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
    const all = flattenStmts(ast.stmts)
    if (!all.some((s) => s.kind === 'call') && !all.some((s) => s.kind === 'put')) {
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
  if (name === 'acceleration') {
    // tick.acceleration(windowSec?) - the 2nd-derivative primitive §M/§P
    // flagged as missing ("velocity acceleration... would need slope-of-
    // slope, not directly expressible"): this bucket's velocity minus the
    // PREVIOUS same-width bucket's velocity, i.e. a 2-point finite
    // difference of tick.velocity() itself (no new engine - reuses
    // sliceTickWindow()/tickWindowMetric() twice). Positive = the tape is
    // speeding up, negative = slowing down, 0 on too-thin history.
    const windowSec = args.length ? asNum(args[0]) : 5
    if (!Number.isFinite(windowSec) || windowSec <= 0) throw new MslRuntimeError('tick.acceleration(windowSec) - windowSec must be a positive number')
    if (!ticks.length) return 0
    const now = tickWindowMetric('velocity', sliceTickWindow(ticks, nowTs, windowSec))
    const prev = tickWindowMetric('velocity', sliceTickWindow(ticks, nowTs - windowSec * 1000, windowSec))
    return now - prev
  }
  if (name !== 'count' && name !== 'delta' && name !== 'velocity' && name !== 'ratio')
    throw new MslRuntimeError(`unknown tick method "tick.${name}(...)" - use delta/velocity/ratio/count/acceleration, or deltaSeries/velocitySeries/ratioSeries/countSeries for a historical series`)
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

/** `pulse.*` - Pulse-Vector bars (analytics/pulsebars.ts): packages the
 * already-existing tick.count()/tick.velocity()/tick.acceleration()
 * primitives into one bundled bar per FIXED micro-interval, plus a new
 * `exhaustionScore` (how far a bar's velocity has fallen from its own
 * same-direction run's peak - the "thick base thinning out at the top"
 * signature). LIVE-ONLY, same contract as tick.* and foot.* (requireTicks()
 * fails closed outside the omni-trader). `offsetInto`'s own -1-is-latest
 * convention applies to every offset-indexed accessor below. */
function pulseMethod(name: string, args: MslValue[], ctx: EvalEnv, ticks: readonly { ts: number; price: number }[]): MslValue {
  const r = computePulseBars(ticks, {
    intervalSec: cfgNumLang(ctx, 'pulse.interval', undefined),
    sparseFloor: cfgNumLang(ctx, 'pulse.sparseFloor', undefined),
  })
  if (name === 'bars') return seriesValue(r.bars.map((b) => Math.sign(b.displacement)).slice(-seriesLookback(args, 50)))
  if (!r.bars.length) throw new MslRuntimeError('pulse.*(offset) - no pulse bars have formed yet (needs at least one real tick per micro-interval)')
  if (!args.length) throw new MslRuntimeError(`pulse.${name}(offset) needs an offset argument, e.g. pulse.${name}(-1)`)
  const b = offsetInto(r.bars, asNum(args[0]), `pulse.${name}`)
  switch (name) {
    case 'ohlc':
      return barValueFromOHLC(b.open, b.high, b.low, b.close, b.tickCount)
    case 'displacement':
      return b.displacement
    case 'tickCount':
      return b.tickCount
    case 'velocity':
      return b.velocity
    case 'acceleration':
      return Number.isFinite(b.acceleration) ? b.acceleration : 0
    case 'exhaustion':
      return Number.isFinite(b.exhaustionScore) ? b.exhaustionScore : 0
    case 'color':
      return b.color
    case 'sparse':
      return b.sparse
    default:
      throw new MslRuntimeError(
        `unknown pulse method "pulse.${name}(...)" - use bars(n?)/ohlc(offset)/displacement(offset)/tickCount(offset)/velocity(offset)/acceleration(offset)/exhaustion(offset)/color(offset)/sparse(offset)`
      )
  }
}

/** `spring.*` - Liquidity Spring (analytics/liquidityspring.ts): price
 * stretched away from a fast EMA "core," `tension()` a z-score of that
 * stretch against its own trailing stdev, `snap()` true only when a high
 * stretch ALSO coincides with falling participation (`decelerating()`) -
 * the "rubber band at max stretch, about to snap back" signature. Fully
 * candle-derived, SAFE_BACKTEST_SOURCES tier. */
function springMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = computeLiquiditySpring(candles, {
    emaPeriod: cfgNumLang(ctx, 'spring.emaPeriod', undefined),
    lookback: cfgNumLang(ctx, 'spring.lookback', undefined),
    snapTensionFloor: cfgNumLang(ctx, 'spring.snapFloor', undefined),
  })
  if (name === 'points') return seriesValue(r.points.map((p) => Math.sign(p.deviation)).slice(-seriesLookback(args, 50)))
  if (!r.points.length) throw new MslRuntimeError('spring.*(offset) - not enough history yet')
  if (!args.length) throw new MslRuntimeError(`spring.${name}(offset) needs an offset argument, e.g. spring.${name}(-1)`)
  const p = offsetInto(r.points, asNum(args[0]), `spring.${name}`)
  switch (name) {
    case 'baseline':
      return p.baseline
    case 'deviation':
      return p.deviation
    case 'tension':
      return Number.isFinite(p.tensionScore) ? p.tensionScore : 0
    case 'decelerating':
      return p.decelerating
    case 'snap':
      return p.snap
    default:
      throw new MslRuntimeError(`unknown spring method "spring.${name}(...)" - use points(n?)/baseline(offset)/deviation(offset)/tension(offset)/decelerating(offset)/snap(offset)`)
  }
}

/** `echo.*` - Volatility Echo (analytics/volatilityecho.ts): a statistical
 * band (SMA +/- bandMult x trailing stdev) over closes, `squeeze()` when
 * the band has pinched tighter than its own trailing average width
 * ("coiling"), `pierced()` ('up'/'down'/null) when a close breaks outside
 * the band on that bar ("clean directional burst"). SAFE_BACKTEST_SOURCES tier. */
function echoMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = computeVolatilityEcho(candles, {
    window: cfgNumLang(ctx, 'echo.window', undefined),
    bandMult: cfgNumLang(ctx, 'echo.bandMult', undefined),
    squeezeFloor: cfgNumLang(ctx, 'echo.squeezeFloor', undefined),
  })
  if (name === 'points') return seriesValue(r.points.map((p) => (p.pierced === 'up' ? 1 : p.pierced === 'down' ? -1 : 0)).slice(-seriesLookback(args, 50)))
  if (!r.points.length) throw new MslRuntimeError('echo.*(offset) - not enough history yet (needs at least window+1 candles)')
  if (!args.length) throw new MslRuntimeError(`echo.${name}(offset) needs an offset argument, e.g. echo.${name}(-1)`)
  const p = offsetInto(r.points, asNum(args[0]), `echo.${name}`)
  switch (name) {
    case 'baseline':
      return p.baseline
    case 'upperBand':
      return p.upperBand
    case 'lowerBand':
      return p.lowerBand
    case 'width':
      return Number.isFinite(p.ribbonWidth) ? p.ribbonWidth : 0
    case 'squeeze':
      return p.squeeze
    case 'pierced':
      return p.pierced ?? 'none'
    default:
      throw new MslRuntimeError(`unknown echo method "echo.${name}(...)" - use points(n?)/baseline(offset)/upperBand(offset)/lowerBand(offset)/width(offset)/squeeze(offset)/pierced(offset)`)
  }
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

/** Like footSnapshot(), but for a SPECIFIC past bucket rather than only the
 * latest one - foot.row()/foot.rowCount()'s own fetch (see their doc
 * comments for the gap this closes). `bucketsAgo` 0 = the latest bucket,
 * same "0 = most recent" convention foot.*Series's own buckets argument
 * already uses elsewhere, just picking ONE bucket out of the array instead
 * of mapping a field across all of them. Builds enough minutes of history
 * to cover bucketsAgo+1 buckets (same sizing foot.*Series already does for
 * its own `buckets` count), so asking further back pulls more raw ticks,
 * not a different bucketing rule. */
function footBucketAt(
  ticks: readonly { ts: number; price: number }[],
  nowMs: number,
  windowSec: number,
  bucketsAgo: number,
): FootprintBucket | undefined {
  if (!ticks.length || !Number.isFinite(windowSec) || windowSec <= 0) return undefined
  const ago = Number.isFinite(bucketsAgo) ? Math.max(0, Math.round(bucketsAgo)) : 0
  const bucketSec = Math.max(5, Math.round(windowSec))
  const minutes = Math.max(1, Math.ceil((bucketSec * (ago + 1)) / 60))
  const result = buildFootprint([...ticks], { bucketSec, minutes, nowMs })
  const idx = result.buckets.length - 1 - ago
  const bucket = idx >= 0 ? result.buckets[idx] : undefined
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
    case 'vah': {
      // foot.vah(windowSec?, pct?) - footprint's OWN value area (real tick
      // counts, not candle-overlap-estimated volume) - distinct from BOTH
      // tpo.vah() (time-based) and vp.vah() (candle-overlap volume-
      // estimated). Closes §L's longest-standing flagged gap.
      const b = footSnapshot(ticks, nowMs, args.length ? asNum(args[0]) : defaultWindowSec)
      if (!b) return NaN
      const va = footprintValueArea(b, args.length >= 2 ? asNum(args[1]) : 0.7)
      return va ? va.vah : NaN
    }
    case 'val': {
      const b = footSnapshot(ticks, nowMs, args.length ? asNum(args[0]) : defaultWindowSec)
      if (!b) return NaN
      const va = footprintValueArea(b, args.length >= 2 ? asNum(args[1]) : 0.7)
      return va ? va.val : NaN
    }
    case 'deltaPct': {
      // foot.deltaPct(windowSec?) - velDelta / total prints, as a signed
      // percentage (-100..100) - the named accessor §L flagged as missing
      // ("Delta %... derivable, no named accessor").
      const b = footSnapshot(ticks, nowMs, args.length ? asNum(args[0]) : defaultWindowSec)
      if (!b) return 0
      const total = b.upTicks + b.dnTicks
      return total > 0 ? (b.velDelta / total) * 100 : 0
    }
    case 'deltaVelocity': {
      // foot.deltaVelocity(bucketSec?, buckets?) - rate of change of delta
      // across consecutive buckets (this bucket's velDelta minus the
      // previous bucket's) - the named "delta velocity" accessor §L flagged
      // as missing. Returns 0 (not NaN) on too-thin history, same
      // cumulativeDelta() convention right above this case.
      const bucketSec = Math.max(5, Math.round(args.length > 0 ? asNum(args[0]) : defaultWindowSec))
      const buckets = seriesBucketCount(args.length > 1 ? asNum(args[1]) : undefined, 10)
      if (!ticks.length) return 0
      const minutes = Math.max(1, Math.ceil((bucketSec * buckets) / 60))
      const result = buildFootprint([...ticks], { bucketSec, minutes, nowMs })
      const recent = result.buckets.filter((b) => b.nTicks >= 3).slice(-2)
      if (recent.length < 2) return 0
      return recent[1].velDelta - recent[0].velDelta
    }
    case 'diagonalImbalance': {
      // foot.diagonalImbalance(side, ratio, windowSec?) - the classic
      // footprint "diagonal" read: this level's buy-side prints vs the
      // level BELOW's sell-side prints (not foot.imbalance()'s same-level
      // check) - §L's flagged "diagonal imbalance... different check than
      // same-level imbalance" gap.
      if (args.length < 2) throw new MslRuntimeError('foot.diagonalImbalance(side, ratio, windowSec?) takes at least 2 arguments')
      const side = String(args[0])
      if (side !== 'buy' && side !== 'sell') throw new MslRuntimeError(`foot.diagonalImbalance(side, ...) - side must be "buy" or "sell" (got "${side}")`)
      const ratio = asNum(args[1])
      const b = footSnapshot(ticks, nowMs, args.length >= 3 ? asNum(args[2]) : defaultWindowSec)
      if (!b) return false
      return diagonalImbalance(b, side, ratio).length > 0
    }
    case 'absorption': {
      // foot.absorption(windowSec?) - §L's flagged "absorption detection"
      // gap: heavy print density packed into few price rows, with closePos
      // staying mid-range despite a real directional delta - the side whose
      // aggression got absorbed, stated as an explicit documented heuristic
      // (see otcfootprint.ts's own header comment on this function - no
      // universal textbook formula exists, this is a design decision).
      // Returns 'buy'|'sell'|'none', never a forced guess.
      const b = footSnapshot(ticks, nowMs, args.length ? asNum(args[0]) : defaultWindowSec)
      if (!b) return 'none'
      return footprintAbsorption(b).side ?? 'none'
    }
    case 'unfinishedAuction': {
      // foot.unfinishedAuction(windowSec?) - §L's flagged gap: true when the
      // bucket's busiest price node (POC) sits AT the bucket's own high or
      // low, meaning the auction never rotated away from the edge it
      // printed the most volume at. Returns 'high'|'low'|'none'.
      const b = footSnapshot(ticks, nowMs, args.length ? asNum(args[0]) : defaultWindowSec)
      if (!b) return 'none'
      return unfinishedAuction(b).side ?? 'none'
    }
    case 'rowCount': {
      // foot.rowCount(bucketsAgo?, bucketSec?) - FOOTPRINT-COMPLETION SWEEP:
      // closes the one remaining item in §L's "Historical per-price-level
      // data" row - FootprintBucket[] already stores a full per-row ladder
      // for every bucket server-side, but until now nothing beyond the
      // AGGREGATE *Series rollups (pocSeries/deltaSeries/...) could reach
      // any bucket OTHER than the very latest one, and even that one only
      // ever gave back scalars (poc/pocTicks/...), never the per-row ladder
      // itself. foot.rowCount() tells a script how many rows a given past
      // bucket actually has, so foot.row(levelIndex, bucketsAgo?) below can
      // be called with a valid levelIndex instead of guessing - MSL has no
      // loops, so a script walks a ladder via explicit foot.row(0, ...),
      // foot.row(1, ...), etc., exactly the same "no iteration, only named
      // offset access" convention every other historical primitive in this
      // language already uses (ohlc(offset), swing.high(offset), ...).
      const b = footBucketAt(ticks, nowMs, args.length >= 2 ? asNum(args[1]) : defaultWindowSec, args.length ? asNum(args[0]) : 0)
      return b ? b.rows.length : 0
    }
    case 'row': {
      // foot.row(levelIndex, bucketsAgo?, bucketSec?) - one row of the raw
      // per-price-level ladder, from the bucket `bucketsAgo` buckets back
      // (0 = latest, same "how far back" convention as every *Series
      // accessor's `buckets` argument, just picking ONE bucket instead of a
      // whole series of one field). Rows are sorted high price -> low
      // (buildFootprint()'s own order, unchanged) - levelIndex 0 is always
      // the HIGHEST price row in that bucket, not the POC. Returns a bundle
      // {price, up, dn, total, delta, imbalance} - imbalance is up/dn (or
      // dn/up, whichever side is busier) so a script doesn't have to divide
      // by a possibly-zero count itself; 0 when either side is empty rather
      // than Infinity/NaN leaking into a script's own arithmetic.
      if (!args.length) throw new MslRuntimeError('foot.row(levelIndex, bucketsAgo?, bucketSec?) needs a levelIndex argument, e.g. foot.row(0)')
      const b = footBucketAt(ticks, nowMs, args.length >= 3 ? asNum(args[2]) : defaultWindowSec, args.length >= 2 ? asNum(args[1]) : 0)
      if (!b) throw new MslRuntimeError('foot.row(...) - no bucket available yet (thin tick history)')
      const idx = Math.trunc(asNum(args[0]))
      const row = idx >= 0 && idx < b.rows.length ? b.rows[idx] : undefined
      if (!row) throw new MslRuntimeError(`foot.row(${idx}, ...) out of range - this bucket has ${b.rows.length} row(s)`)
      const delta = row.up - row.dn
      const imbalance = row.dn > 0 && row.up > 0 ? Math.max(row.up / row.dn, row.dn / row.up) : 0
      return bundleValue({ price: row.price, up: row.up, dn: row.dn, total: row.total, delta, imbalance })
    }
    default:
      throw new MslRuntimeError(
        `unknown foot method "foot.${name}(...)" - use poc/pocTicks/stagnation/delta/speedRatio/imbalance/consecutiveDense/divergence/exhaustion/cumulativeDelta/consecutiveImbalance/vah/val/deltaPct/deltaVelocity/diagonalImbalance/absorption/unfinishedAuction/row/rowCount, or pocSeries/pocTicksSeries/stagnationSeries/deltaSeries/speedRatioSeries for a historical series`,
      )
  }
}

/** `tickfp.*` - the 'tickfootprint' chart type's own engine
 * (tickdesk.ts#computeTickFootprint: MEASURED prints bucketed into both a
 * time axis AND price rows per bucket, bucketSec default 60s) - previously
 * only reachable through the bare `tickFootprint` verdict-source identifier
 * (a single aggregate read), never as a dotted namespace a script could
 * drill into per-bucket. Distinct from `foot.*` above: that namespace
 * wraps otcfootprint.ts#buildFootprint (the OTC-footprint/footprint chart
 * types' engine) - a different computation, bucketed differently, with its
 * own row shape. Reads the LAST closed bucket; omni-trader-only (needs the
 * live tick buffer), same fail-closed contract every other tick-backed
 * namespace here already has. */
function tickfpMethod(name: string, args: MslValue[], ticks: readonly { ts: number; price: number }[]): MslValue {
  const bucketSec = args.length ? Math.max(1, Math.min(3600, Math.round(asNum(args[0])))) : 60
  if (!ticks.length) {
    if (name === 'imbalance') return 'none'
    return name === 'ticks' || name === 'upTicks' || name === 'dnTicks' || name === 'netImbalance' ? 0 : NaN
  }
  const r = computeTickFootprint([...ticks] as { ts: number; price: number }[], { bucketSec })
  const last = r.candles[r.candles.length - 1]
  if (!last) {
    if (name === 'imbalance') return 'none'
    return name === 'ticks' || name === 'upTicks' || name === 'dnTicks' || name === 'netImbalance' ? 0 : NaN
  }
  switch (name) {
    case 'poc':
      return last.poc === null ? NaN : last.poc
    case 'delta':
      return last.delta
    case 'ticks':
      return last.ticks
    case 'upTicks':
      return last.upTicks
    case 'dnTicks':
      return last.dnTicks
    case 'imbalance': {
      // tickfp.imbalance(bucketSec?) - the last bucket's DOMINANT per-row
      // imbalance side, by count of rows (TickFootprintRow.imbalance is
      // already computed per row - this just reads which side has more of
      // them). 'none' on a tie or when no row shows an imbalance.
      let buy = 0
      let sell = 0
      for (const row of last.rows) {
        if (row.imbalance === 'buy') buy++
        else if (row.imbalance === 'sell') sell++
      }
      return buy === sell ? 'none' : buy > sell ? 'buy' : 'sell'
    }
    case 'netImbalance': {
      // signed (buy rows - sell rows) in the last bucket - the magnitude
      // tickfp.imbalance()'s side-only read deliberately drops.
      let buy = 0
      let sell = 0
      for (const row of last.rows) {
        if (row.imbalance === 'buy') buy++
        else if (row.imbalance === 'sell') sell++
      }
      return buy - sell
    }
    case 'rowCount':
      return last.rows.length
    default:
      throw new MslRuntimeError(`unknown tickfp method "tickfp.${name}(...)" - use poc/delta/ticks/upTicks/dnTicks/imbalance/netImbalance/rowCount`)
  }
}

/** `outcomeMemory.*` - a dotted-method view of the SAME k-NN read the bare
 * `outcomeMemory.value`/`outcomeMemory.conf` verdict-source identifiers
 * already expose (analytics/outcomememory.ts#computeOutcomeMemory), now
 * reachable as a script-callable namespace so a condition can drill into
 * the comparable pool's own shape (poolSize/matchCount/up-down-flat split)
 * instead of only the one aggregate pUp/confidence pair.
 * SIMPLIFICATION, stated honestly: the bare verdict-source reads get the
 * REAL asset (metastrategy.ts passes it to computeOutcomeMemory for
 * OTC/weekend-aware session classification - see session.ts#classifySession).
 * This namespace-method path has no asset in EvalEnv to pass (nothing else
 * in strategylang.ts carries one either), so it calls with an empty asset -
 * classifySession() degrades to its time-of-day-only session bucket in
 * that case (still a real, honest session read, just not OTC-weekend-aware)
 * rather than fabricating or guessing an asset string. */
function outcomeMemoryMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  void args
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const om = computeOutcomeMemory(candles, '', {
    ...(cfgNumLang(ctx, 'memory.expiry', undefined) !== undefined ? { expiryBars: cfgNumLang(ctx, 'memory.expiry', undefined) } : {}),
    ...(cfgNumLang(ctx, 'memory.k', undefined) !== undefined ? { k: cfgNumLang(ctx, 'memory.k', undefined) } : {}),
    ...(cfgNumLang(ctx, 'memory.lookback', undefined) !== undefined ? { lookback: cfgNumLang(ctx, 'memory.lookback', undefined) } : {}),
    ...(cfgNumLang(ctx, 'memory.minPool', undefined) !== undefined ? { minPoolSize: cfgNumLang(ctx, 'memory.minPool', undefined) } : {}),
  })
  switch (name) {
    case 'pUp':
      return om.ok ? om.pUp : NaN
    case 'poolSize':
      return om.ok ? om.poolSize : 0
    case 'matchCount':
      return om.ok ? om.matches.length : 0
    case 'upCount':
      return om.ok ? om.upCount : 0
    case 'downCount':
      return om.ok ? om.downCount : 0
    case 'flatCount':
      return om.ok ? om.flatCount : 0
    case 'avgReturn':
      return om.ok ? om.avgReturn : NaN
    case 'medianReturn':
      return om.ok ? om.medianReturn : NaN
    case 'k':
      return om.k
    case 'ok':
      return om.ok
    default:
      throw new MslRuntimeError(`unknown outcomeMemory method "outcomeMemory.${name}(...)" - use pUp/poolSize/matchCount/upCount/downCount/flatCount/avgReturn/medianReturn/k/ok`)
  }
}

/** `signal.*` - the Signal clock (analytics/signalcore.ts) as MSL primitives.
 * Same pure function the Signal tab calls, run on this evaluation's own closed
 * candles (last 240 bars), so a live script, the tab and a backtest agree
 * bar for bar. Candle-derived only - works in meta_strategy_eval, Meta Trader,
 * Omni Trader AND meta_strategy_backtest.
 *
 *   action()            "buy" | "sell" | "wait"        buy()/sell()/wait()  booleans
 *   needle()            -100..+100 (held inside +/-30 while the call is WAIT)
 *   raw()               the unclamped consensus score  strength()  |needle|, 0-100
 *   regime()            "trend-up" | "trend-down" | "ranging" | "noise" | "unreadable"
 *   trending()/ranging()/noise()  booleans   regimeScore()  rank score 0-100 (0 if unreadable)
 *   er()/adx()/tStat()/position()  regime metrics (position: 0 = box bottom, 1 = top)
 *   hold()/holdMin()    suggested expiry in bars / minutes (0 when the call is WAIT; named `hold`
 *                       because `expiry` is a reserved script keyword)
 *   calls()/puts()/flats()/unreadable()   how the six readers split
 *   smcLean()/candleLean()/mrcLean()/swingLean()/technicalLean()/effortLean()   +1 / -1 / 0
 *   smcStrength()... the reader's own 0-100 strength (0 when none)   smcOk()... readable?
 *   ok()                enough closed bars (60+) to read at all
 * Every method except ok() fails the script closed on too little history. */
const signalCoreCache = new WeakMap<MslSeriesCtx, SignalCore | null>()
const SIGNAL_READERS = ['smc', 'candle', 'mrc', 'swing', 'technical', 'effort']
function signalMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  void args
  const s = requireSeries(ctx, tf)
  let core = signalCoreCache.get(s)
  if (core === undefined) {
    if (!s.time || s.time.length !== s.close.length) {
      throw new MslRuntimeError('signal.*() needs candle timestamps, which this evaluation context does not carry')
    }
    const n = s.close.length
    const candles: Candle[] = new Array(n)
    for (let i = 0; i < n; i++) candles[i] = { time: s.time[i], open: s.open[i], high: s.high[i], low: s.low[i], close: s.close[i], volume: s.volume[i] }
    core = readSignalCore(candles)
    signalCoreCache.set(s, core)
  }
  if (name === 'ok') return core !== null
  if (!core) throw new MslRuntimeError(`signal.${name}() needs at least ${SIGNAL_MIN_BARS} closed bars with real timestamps - history is too thin to read`)
  const sig = core.signal
  const rg = core.regime
  const rd = /^(smc|candle|mrc|swing|technical|effort)(Lean|Strength|Ok)$/.exec(name)
  if (rd) {
    const e = sig.evidence.find((x) => x.id === rd[1])
    if (!e) return rd[2] === 'Ok' ? false : 0
    if (rd[2] === 'Ok') return e.ok
    if (rd[2] === 'Strength') return e.ok && e.strength !== null ? e.strength : 0
    return e.ok ? (e.lean === 'call' ? 1 : e.lean === 'put' ? -1 : 0) : 0
  }
  switch (name) {
    case 'action':
      return sig.action
    case 'buy':
      return sig.action === 'buy'
    case 'sell':
      return sig.action === 'sell'
    case 'wait':
      return sig.action === 'wait'
    case 'needle':
      return sig.needle
    case 'raw':
      return sig.rawNeedle
    case 'strength':
      return sig.strength
    case 'regime':
      return sig.regime
    case 'trending':
      return sig.regime === 'trend-up' || sig.regime === 'trend-down'
    case 'ranging':
      return sig.regime === 'ranging'
    case 'noise':
      return sig.regime === 'noise'
    case 'regimeScore':
      return rg ? rg.score : 0
    case 'er':
      return rg ? rg.er : 0
    case 'adx':
      return rg ? rg.adx : 0
    case 'tStat':
      return rg ? rg.tStat : 0
    case 'position':
      return rg ? rg.position : 0.5
    case 'hold':
      return sig.expiry ? sig.expiry.bars : 0
    case 'holdMin':
      return sig.expiry ? sig.expiry.minutes : 0
    case 'calls':
      return sig.readers.call
    case 'puts':
      return sig.readers.put
    case 'flats':
      return sig.readers.flat
    case 'unreadable':
      return sig.readers.unreadable
    default:
      throw new MslRuntimeError(
        `unknown signal method "signal.${name}(...)" - use ok/action/buy/sell/wait/needle/raw/strength/regime/trending/ranging/noise/regimeScore/er/adx/tStat/position/hold/holdMin/calls/puts/flats/unreadable, or <reader>Lean/<reader>Strength/<reader>Ok for reader in ${SIGNAL_READERS.join('/')}`,
      )
  }
}

/** `tech.*` - the Technical Summary panel's PER-INDICATOR votes as MSL
 * primitives. The very same `oscillatorVotes()` / `maVotes()` the panel runs
 * (11 oscillators + the moving-average block), on this evaluation's own closed
 * candles (last 260 bars, as the panel uses), so a script, the panel and a
 * backtest agree bar for bar. Candle-derived only: works in meta_strategy_eval,
 * Meta Trader, Omni Trader AND meta_strategy_backtest. Needs no timestamps.
 * An indicator whose warm-up doesn't fit the history (SMA/EMA 200 on a short
 * window) is EXCLUDED from the counts, never counted as neutral.
 *
 *   ok()                          40+ closed bars (every other method fails the script closed otherwise)
 *   buys()/sells()/neutrals()/counted()      all votes (oscillators + MAs)
 *   oscBuys()/oscSells()/oscNeutrals()/oscCounted()      oscillators only
 *   maBuys()/maSells()/maNeutrals()/maCounted()          moving averages only
 *   buyShare()/sellShare()        buys (or sells) / counted, 0..1 (0 when nothing counted)
 *   oscBuyShare()/oscSellShare()/maBuyShare()/maSellShare()   same per block
 *   score()                       (buys - sells) / counted, -1..+1 (the panel's own score)
 *   allBuy()/allSell()            EVERY counted vote agrees (rare: one neutral breaks it)
 *   oscAllBuy()/oscAllSell()/maAllBuy()/maAllSell()      same per block
 *   <indicator>()                 that one indicator's vote: +1 buy / -1 sell / 0 neutral or n/a
 *   <indicator>Ok()               did it have enough history to vote
 *     indicators: rsi stoch cci adx ao momentum macd stochRsi williams bbp uo
 *                 sma10 sma20 sma30 sma50 sma100 sma200 ema10 ema20 ema30 ema50 ema100 ema200 hma vwma ichimoku
 * (per-indicator methods rather than vote("rsi"): a trailing string arg is parsed as a timeframe.) */
const techCache = new WeakMap<MslSeriesCtx, Map<number, { osc: Record<string, TechVote>; ma: Record<string, TechVote>; oscList: TechVote[]; maList: TechVote[] } | null>>()
function techKey(name: string): string {
  if (/^Stoch RSI/.test(name)) return 'stochRsi'
  if (/^Stoch %K/.test(name)) return 'stoch'
  if (/^RSI/.test(name)) return 'rsi'
  if (/^CCI/.test(name)) return 'cci'
  if (/^ADX/.test(name)) return 'adx'
  if (/^Awesome/.test(name)) return 'ao'
  if (/^Momentum/.test(name)) return 'momentum'
  if (/^MACD/.test(name)) return 'macd'
  if (/^Williams/.test(name)) return 'williams'
  if (/^Bull Bear/.test(name)) return 'bbp'
  if (/^Ultimate/.test(name)) return 'uo'
  const m = /^(SMA|EMA)\((\d+)\)$/.exec(name)
  if (m) return m[1].toLowerCase() + m[2]
  if (/^Hull/.test(name)) return 'hma'
  if (/^VWMA/.test(name)) return 'vwma'
  if (/^Ichimoku/.test(name)) return 'ichimoku'
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}
function techMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  // optional first numeric arg = bars back (0 = latest closed bar, 1 = the bar before it, max 20)
  const back = typeof args[0] === 'number' && Number.isFinite(args[0]) ? Math.max(0, Math.min(20, Math.round(args[0]))) : 0
  const s = requireSeries(ctx, tf)
  let tm = techCache.get(s)
  if (!tm) { tm = new Map(); techCache.set(s, tm) }
  let t = tm.get(back)
  if (t === undefined) {
    if (s.close.length - back < TECH_MIN_BARS) t = null
    else {
      const full = seriesToCandles(s)
      const all = back ? full.slice(0, full.length - back) : full
      const bars = all.length > TECH_BARS_PER_RUNG ? all.slice(all.length - TECH_BARS_PER_RUNG) : all
      const oscList = oscillatorVotes(bars)
      const maList = maVotes(bars)
      const osc: Record<string, TechVote> = {}
      const ma: Record<string, TechVote> = {}
      for (const v of oscList) osc[techKey(v.name)] = v
      for (const v of maList) ma[techKey(v.name)] = v
      t = { osc, ma, oscList, maList }
    }
    tm.set(back, t)
  }
  if (name === 'ok') return t !== null
  if (!t) throw new MslRuntimeError(`tech.${name}() needs at least ${TECH_MIN_BARS} closed bars - history is too thin to read`)
  const cnt = (list: TechVote[]) => {
    const buys = list.filter((v) => v.read === 'buy').length
    const sells = list.filter((v) => v.read === 'sell').length
    const neutrals = list.filter((v) => v.read === 'neutral').length
    return { buys, sells, neutrals, counted: buys + sells + neutrals }
  }
  const blocks: Record<string, TechVote[]> = { '': [...t.oscList, ...t.maList], osc: t.oscList, ma: t.maList }
  const g = /^(osc|ma)?(Buys|Sells|Neutrals|Counted|BuyShare|SellShare|AllBuy|AllSell)$/i.exec(name)
  const gName = /^(osc|ma)?([a-z]+)$/i.exec(name)
  if (g && gName) {
    const blk = (g[1] ?? '').toLowerCase()
    const what = g[2].toLowerCase()
    const c = cnt(blocks[blk])
    switch (what) {
      case 'buys': return c.buys
      case 'sells': return c.sells
      case 'neutrals': return c.neutrals
      case 'counted': return c.counted
      case 'buyshare': return c.counted ? c.buys / c.counted : 0
      case 'sellshare': return c.counted ? c.sells / c.counted : 0
      case 'allbuy': return c.counted > 0 && c.buys === c.counted
      case 'allsell': return c.counted > 0 && c.sells === c.counted
    }
  }
  if (name === 'score') {
    const c = cnt(blocks[''])
    return c.counted ? (c.buys - c.sells) / c.counted : 0
  }
  const ok = /^(.+)Ok$/.exec(name)
  const key = ok ? ok[1] : name
  const v = t.osc[key] ?? t.ma[key]
  if (!v) {
    throw new MslRuntimeError(
      `unknown tech method "tech.${name}(...)" - use ok/buys/sells/neutrals/counted/buyShare/sellShare/score/allBuy/allSell (prefix osc/ma for a block, e.g. oscBuys, maAllBuy), or an indicator: ${[...Object.keys(t.osc), ...Object.keys(t.ma)].join('/')} (+Ok suffix for "had enough history")`,
    )
  }
  if (ok) return v.read !== 'na'
  return v.read === 'buy' ? 1 : v.read === 'sell' ? -1 : 0
}

/** Shared "plain numeric args" reader for the model namespaces below. */
function numArg(args: MslValue[], i: number): number | undefined {
  return args[i] === undefined ? undefined : asNum(args[i])
}

/** `ou.*` - the Kalman / Ornstein-Uhlenbeck mean-reversion model (analytics/kalman.ts) as MSL primitives.
 * Fits the OU process (AR(1) on price) over a rolling window and runs the OU-drift Kalman filter - the same
 * numbers the Quant panel / `kalman-ou` chart overlay show. Candle-derived: works in meta_strategy_eval,
 * Meta Trader, Omni Trader AND meta_strategy_backtest. An optional first numeric arg = fit window (30-240, default 240).
 *   z()           stretch of price from the equilibrium in stationary sigmas (clamped +/-12)
 *   theta()       OU equilibrium (long-run mean)      fair()    Kalman fair-value estimate of the latent level
 *   upper(w?,k?)/lower(w?,k?)  theta +/- k*sigmaEq (k default 2)     sigma()   stationary std (price units)
 *   halfLife()    reversion half-life in BARS (9999 = no reversion)   kappa()/phi()   speed / per-bar persistence
 *   tStat()       significance of the reversion (1-phi)/se; ~2+ is "real"   r2()   AR(1) fit quality
 *   reverting()   the model's own verdict that the pair is significantly mean-reverting right now
 *   dfSignificant()  tStat >= 2.86 - the 5% Dickey-Fuller critical value for an AR(1) fit with a constant. USE THIS for "is the
 *                 reversion statistically real": the app's own reverting() flag uses the looser t >= 1.5 (+ half-life <= 250) and
 *                 passes roughly half of pure random walks, so it is a screen, not a test
 *   stretchedAbove()/stretchedBelow()   |z| >= 1.5 from the equilibrium - z ONLY, it does NOT check reverting (combine it yourself)
 *   signal()      "call" | "put" | "none": a stretch that ALSO passes reverting() (the app's own fade signal; loose gate, see above)
 *   score()       the model's own 0-100 strength for that signal
 *   innovation()  last standardized Kalman innovation (a surprise measure)   ok()   60+ closed bars */
const ouCache = new WeakMap<MslSeriesCtx, Map<number, OUModel | null>>()
function ouMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const s = requireSeries(ctx, tf)
  const win = name === 'upper' || name === 'lower' ? numArg(args, 0) : numArg(args, 0)
  const w = win === undefined ? 240 : Math.max(30, Math.min(240, Math.round(win)))
  let byWin = ouCache.get(s)
  if (!byWin) ouCache.set(s, (byWin = new Map()))
  let m = byWin.get(w)
  if (m === undefined) {
    m = readOU(seriesToCandles(s), w)
    byWin.set(w, m)
  }
  if (name === 'ok') return m !== null
  if (!m) throw new MslRuntimeError(`ou.${name}() needs at least ${MODEL_MIN_BARS} closed bars - history is too thin to fit`)
  switch (name) {
    case 'z': return m.z
    case 'theta': return m.theta
    case 'fair': return m.fair
    case 'sigma': return m.sigmaEq
    case 'upper':
    case 'lower': {
      const k = numArg(args, 1)
      const kk = k !== undefined && k > 0 ? k : 2
      return name === 'upper' ? m.theta + kk * m.sigmaEq : m.theta - kk * m.sigmaEq
    }
    case 'halfLife': return m.halfLife
    case 'kappa': return m.kappa
    case 'phi': return m.phi
    case 'tStat': return m.tStat
    case 'r2': return m.r2
    case 'reverting': return m.meanReverting
    case 'dfSignificant': return m.tStat >= 2.86
    case 'stretchedAbove': return m.state === 'stretched-above'
    case 'stretchedBelow': return m.state === 'stretched-below'
    case 'signal': return m.signal
    case 'score': return m.score
    case 'innovation': return m.innovation
    default:
      throw new MslRuntimeError(`unknown ou method "ou.${name}(...)" - use ok/z/theta/fair/sigma/upper/lower/halfLife/kappa/phi/tStat/r2/reverting/dfSignificant/stretchedAbove/stretchedBelow/signal/score/innovation`)
  }
}

/** `markov.*` - the first-order Markov chain over vol-scaled return states (analytics/quant.ts markovChain).
 * Five states, -2 big_down, -1 down, 0 flat, +1 up, +2 big_up, thresholds = multiples of the pair's own return sigma
 * (so it reads the same on forex and crypto); Laplace-smoothed transition matrix. Candle-derived, backtestable.
 * An optional first numeric arg = lookback in bars (60-1000, default 500).
 *   probUp()/probDown()/probFlat()   next-bar probability of an up / down / flat state given the current state
 *   expectedReturn()   probability-weighted next-bar log return        state()   the current state, -2..+2
 *   next(s)            next-bar probability of state s (-2..+2) from the current state
 *   p(from, to)        transition probability between two states (-2..+2)    stationary(s)   long-run share of state s
 *   trendiness()       0..1 persistence of up/down runs      entropy()   0..1 (1 = next state fully unpredictable)
 *   regime()           "bull" | "bear" | "range" | "chop"     samples()   how many return states the chain was fit on     ok() 60+ bars */
const markovCache = new WeakMap<MslSeriesCtx, Map<number, MarkovModel | null>>()
function markovMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const s = requireSeries(ctx, tf)
  const takesState = name === 'next' || name === 'stationary' || name === 'p'
  const lbArg = takesState ? undefined : numArg(args, 0)
  const lb = lbArg === undefined ? 500 : Math.max(60, Math.min(1000, Math.round(lbArg)))
  let byLb = markovCache.get(s)
  if (!byLb) markovCache.set(s, (byLb = new Map()))
  let m = byLb.get(lb)
  if (m === undefined) {
    m = readMarkov(seriesToCandles(s), lb)
    byLb.set(lb, m)
  }
  if (name === 'ok') return m !== null
  if (!m) throw new MslRuntimeError(`markov.${name}() needs at least ${MODEL_MIN_BARS} closed bars - history is too thin to fit`)
  const st = (i: number): number => {
    const v = asNum(args[i] as MslValue)
    const r = Math.round(v)
    if (!Number.isFinite(r) || r < -2 || r > 2) throw new MslRuntimeError(`markov.${name}(): a state is -2 (big down) .. +2 (big up), got ${v}`)
    return r + 2
  }
  switch (name) {
    case 'probUp': return m.probUp
    case 'probDown': return m.probDown
    case 'probFlat': return m.probFlat
    case 'expectedReturn': return m.expectedReturn
    case 'state': return m.state
    case 'next':
      if (args.length < 1) throw new MslRuntimeError('markov.next(state) needs a state, -2..+2')
      return m.next[st(0)]
    case 'stationary':
      if (args.length < 1) throw new MslRuntimeError('markov.stationary(state) needs a state, -2..+2')
      return m.stationary[st(0)]
    case 'p':
      if (args.length < 2) throw new MslRuntimeError('markov.p(from, to) needs two states, -2..+2')
      return m.matrix[st(0)][st(1)]
    case 'trendiness': return m.trendiness
    case 'entropy': return m.entropy
    case 'regime': return m.regime
    case 'samples': return m.samples
    default:
      throw new MslRuntimeError(`unknown markov method "markov.${name}(...)" - use ok/probUp/probDown/probFlat/expectedReturn/state/next/p/stationary/trendiness/entropy/regime/samples`)
  }
}

/** `stat.*` - return-distribution and mean-reversion statistics (analytics/quant.ts) on closed candles. Backtestable.
 *   hurst()               rescaled-range Hurst exponent 0..1 (<0.5 mean-reverting, ~0.5 random walk, >0.5 trending); needs 101+ bars
 *   autocorr(lag?, n?)    autocorrelation of the last n log returns at lag 1-20 (defaults 1, 120); negative = reverting
 *   varianceRatio(q?, n?) Lo-MacKinlay variance ratio of q-bar vs 1-bar returns (defaults q 4, n 200): <1 reverting, >1 trending
 *   vrZ(q?, n?)           its z-statistic (|z| > 2 is "statistically not a random walk")
 *   regSlope(n?) regR2(n?) regMid(n?) regUpper(n?, k?) regLower(n?, k?)   linear-regression channel over n bars (default 100, k = 2 sigma)
 *   regZ(n?)              price's distance from the regression line in residual sigmas
 *   ewmaVol(n?, lambda?)  EWMA volatility of log returns     garchVol(n?)   GARCH(1,1) volatility (per-bar log-return std)
 *   retMean(n?) retStd(n?) skew(n?) kurt(n?)   moments of the last n log returns (default 120)
 *   ok()                  60+ closed bars (a method needing more fails the script closed with its own message) */
function statMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const s = requireSeries(ctx, tf)
  if (name === 'ok') return s.close.length >= MODEL_MIN_BARS
  if (!STAT_NAMES.includes(name)) {
    throw new MslRuntimeError(`unknown stat method "stat.${name}(...)" - use ok/${STAT_NAMES.join('/')}`)
  }
  if (s.close.length < MODEL_MIN_BARS) throw new MslRuntimeError(`stat.${name}() needs at least ${MODEL_MIN_BARS} closed bars - history is too thin`)
  const a: { n?: number; lag?: number; q?: number; k?: number; lambda?: number } = {}
  switch (name) {
    case 'autocorr': a.lag = numArg(args, 0); a.n = numArg(args, 1); break
    case 'varianceRatio':
    case 'vrZ': a.q = numArg(args, 0); a.n = numArg(args, 1); break
    case 'regUpper':
    case 'regLower': a.n = numArg(args, 0); a.k = numArg(args, 1); break
    case 'ewmaVol': a.n = numArg(args, 0); a.lambda = numArg(args, 1); break
    default: a.n = numArg(args, 0)
  }
  const v = statValue(name, s.close, a)
  if (v === null) {
    throw new MslRuntimeError(
      name === 'hurst' ? `stat.hurst() needs at least ${HURST_MIN_BARS} closed bars` : `stat.${name}() has too little history for the requested window - widen the history or shrink the window`,
    )
  }
  return v
}

/** `cm.*` - Candle Math (analytics/candlemath.ts): blend consecutive candles into one master candle and read it.
 * Blend rule: open of the first bar, highest high, lowest low, close of the last bar, summed volume. Candle-derived, backtestable.
 *   blend(n, end?)        the blended bar of the n closed bars ending at `end` (-1 = latest, the default) - a bar value, so
 *                         cm.blend(3).body / .range / .upperWick / .lowerWick / .o .h .l .c .v all work like ohlc()
 *   has(name, n)          does the blended n-bar candle form this pattern (any name from the 74-pattern catalog, case-insensitive)
 *   revealed(name, n)     ...AND the raw, unblended bars inside the group did NOT show it (the blend revealed it)
 *   count(n) / newCount(n)   patterns on the blended candle / how many of them were revealed by blending
 *   bullish(n) / bearish(n)  how many of the blended candle's patterns are bullish / bearish
 *   dir(n)                +1 / -1 / 0: reliability-weighted bullish-vs-bearish net of the blended candle's patterns
 *   smart() / smartDir()  size (2-4) / direction of the pattern-confirmed blend group ending on the latest bar (0 when none)
 *   ok()                  30+ closed bars
 * (n is required where shown: a lone trailing string would be read as a timeframe.) Pattern reads use the 20 bars before
 * the group as context, like the Candle Math panel. */
function cmMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const s = requireSeries(ctx, tf)
  if (name === 'ok') return s.close.length >= CM_MIN_BARS
  if (s.close.length < CM_MIN_BARS) throw new MslRuntimeError(`cm.${name}() needs at least ${CM_MIN_BARS} closed bars - history is too thin`)
  const candles = seriesToCandles(s)
  const needN = (i: number): number => {
    if (args[i] === undefined) throw new MslRuntimeError(`cm.${name}() needs the group size n (number of bars to blend, 1-50)`)
    return asNum(args[i])
  }
  const read = (n: number, endArg?: number) => {
    const end = endArg === undefined ? candles.length - 1 : candles.length + Math.trunc(endArg)
    const r = cmRead(candles, n, end)
    if (!r) throw new MslRuntimeError(`cm.${name}(): blending ${n} bar(s) ending at ${endArg ?? -1} runs past the available ${candles.length}-bar history`)
    return r
  }
  switch (name) {
    case 'blend': {
      const n = needN(0)
      const r = read(n, numArg(args, 1))
      const b = r.blended
      const hi = Math.max(b.open, b.close)
      const lo = Math.min(b.open, b.close)
      return { __mslBar: true, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? 0, body: Math.abs(b.close - b.open), range: b.high - b.low, upperWick: b.high - hi, lowerWick: lo - b.low } as MslBarValue
    }
    case 'has':
    case 'revealed': {
      if (typeof args[0] !== 'string') throw new MslRuntimeError(`cm.${name}("pattern name", n) - first argument is the pattern name in quotes`)
      const r = read(needN(1))
      return name === 'has' ? cmHas(r, args[0]) : cmRevealedHas(r, args[0])
    }
    case 'count': return read(needN(0)).hits.length
    case 'newCount': return read(needN(0)).revealed.length
    case 'bullish': return read(needN(0)).hits.filter((h) => h.direction === 'bullish').length
    case 'bearish': return read(needN(0)).hits.filter((h) => h.direction === 'bearish').length
    case 'dir': return cmDir(read(needN(0)))
    case 'smart': return cmSmart(candles)?.size ?? 0
    case 'smartDir': return cmSmart(candles)?.dir ?? 0
    default:
      throw new MslRuntimeError(`unknown cm method "cm.${name}(...)" - use ok/blend/has/revealed/count/newCount/bullish/bearish/dir/smart/smartDir`)
  }
}

/** candles for the structural namespaces: REAL timestamps when the context carries them (so session pivots can anchor on the
 * previous UTC day), else synthetic sequential times (pivots then use their rolling-window fallback). */
function candlesWithTime(s: MslSeriesCtx): Candle[] {
  if (s.time && s.time.length === s.close.length) {
    const n = s.close.length
    const out: Candle[] = new Array(n)
    for (let i = 0; i < n; i++) out[i] = { time: s.time[i], open: s.open[i], high: s.high[i], low: s.low[i], close: s.close[i], volume: s.volume[i] }
    return out
  }
  return seriesToCandles(s)
}

/** `fib.*` - Fibonacci retracement / extension / arcs / time zones of the Auto Fibonacci overlay's swing
 * (analytics/structural.ts computeFibSeries logic; helpers in analytics/mslfib.ts). The leg = the trailing-window high and low,
 * whichever formed LATER is the leg's END (high later = up leg). The window ends on the last CLOSED bar (no look-ahead); like the
 * overlay the grid re-anchors the moment a new extreme forms. Candle-derived: works in meta_strategy_eval, Meta Trader, Omni Trader
 * AND meta_strategy_backtest. Every method takes an optional trailing swing lookback in bars (20-600, default 150).
 *   Levels   level(r, lb?)   retracement price: r 0 = leg end, 0.382/0.5/0.618/0.786, 1 = leg start, >1 beyond
 *            ext(e, lb?)     extension: e 1 = leg end, 1.272 / 1.618 = projected beyond it
 *            pos(lb?)        where price sits as a retracement ratio (0 at the end extreme, 1 at the start; <0 / >1 beyond)
 *            nearest(lb?)    the standard ratio (0,.236,.382,.5,.618,.786,1) closest to price     nearestDist(lb?)  its signed distance in ATR(14)
 *            at(r, tolAtr?, lb?)  price within tolAtr x ATR (default 0.25) of level r        goldenPocket(lb?)  price between the 0.382 and 0.618 levels
 *   Leg      dir(lb?) +1 up leg / -1 down leg    high(lb?) low(lb?)    legBars(lb?) legAtr(lb?) leg size in bars / in ATR    age(lb?) bars since the leg's end extreme
 *   Arcs     arc(r, lb?)     price of the ratio-r arc at the last bar (centred on the leg end, radius r x leg length; the plane is normalised so
 *                            the leg is a 45-degree line - a chart drawing uses screen scale, so it can differ)    arcDist(r, lb?) close - arc    arcLive(r, lb?) arc still defined (age < radius)
 *   Time     tz(unit?, lb?)  index in the Fibonacci sequence (0,1,2,3,5,8,13,21,...) of the latest time-zone line passed, measured from the leg START in units of `unit` bars (default 1)
 *            tzMult(unit?, lb?) that sequence number    tzNext(unit?, lb?) bars until the next zone line    tzOn(unit?, tol?, lb?) the last bar sits on a zone line (+/- tol bars, default 0)    tzUnit(lb?) the leg length in bars (TradingView-style unit)
 *   ok()    40+ closed bars. Fails the script closed on thin history or a degenerate (flat) swing. */
const fibCache = new WeakMap<MslSeriesCtx, Map<number, FibSwing | null>>()
const FIB_PARAMS: Record<string, string[]> = {
  level: ['r', 'lb'], ext: ['e', 'lb'], pos: ['lb'], nearest: ['lb'], nearestDist: ['lb'], at: ['r', 'tol', 'lb'], goldenPocket: ['lb'],
  dir: ['lb'], high: ['lb'], low: ['lb'], legBars: ['lb'], legAtr: ['lb'], age: ['lb'],
  arc: ['r', 'lb'], arcDist: ['r', 'lb'], arcLive: ['r', 'lb'],
  tz: ['unit', 'lb'], tzMult: ['unit', 'lb'], tzNext: ['unit', 'lb'], tzOn: ['unit', 'tol', 'lb'], tzUnit: ['lb'],
}
function fibMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const s = requireSeries(ctx, tf)
  if (name === 'ok') return s.close.length >= FIB_MIN_BARS
  const spec = FIB_PARAMS[name]
  if (!spec) throw new MslRuntimeError(`unknown fib method "fib.${name}(...)" - use ok/${Object.keys(FIB_PARAMS).join('/')}`)
  const p: Record<string, number | undefined> = {}
  spec.forEach((k, i) => (p[k] = numArg(args, i)))
  if (args.length > spec.length) throw new MslRuntimeError(`fib.${name}(${spec.join(', ')}) takes at most ${spec.length} argument(s), got ${args.length}`)
  const needs = (k: string): number => {
    const v = p[k]
    if (v === undefined) throw new MslRuntimeError(`fib.${name}() needs ${k}`)
    return v
  }
  const lb = p.lb === undefined ? 150 : Math.max(20, Math.min(600, Math.round(p.lb)))
  let byLb = fibCache.get(s)
  if (!byLb) fibCache.set(s, (byLb = new Map()))
  let sw = byLb.get(lb)
  if (sw === undefined) {
    sw = fibSwing(candlesWithTime(s), lb)
    byLb.set(lb, sw)
  }
  if (!sw) throw new MslRuntimeError(`fib.${name}() needs at least ${FIB_MIN_BARS} closed bars - history is too thin`)
  if (sw.diff <= 1e-9) throw new MslRuntimeError(`fib.${name}(): the swing is flat (no range) - nothing to measure`)
  switch (name) {
    case 'level': return fibRetr(sw, needs('r'))
    case 'ext': {
      const e = needs('e')
      if (e < 1) throw new MslRuntimeError('fib.ext(e): an extension ratio is >= 1 (1 = the leg end, 1.272, 1.618, ...); use level(r) for retracements')
      return fibExt(sw, e)
    }
    case 'pos': return fibPos(sw)
    case 'nearest':
    case 'nearestDist': {
      const pos = fibPos(sw)
      let best = FIB_RATIOS[0]
      for (const r of FIB_RATIOS) if (Math.abs(r - pos) < Math.abs(best - pos)) best = r
      if (name === 'nearest') return best
      return sw.atr > 1e-12 ? (sw.last - fibRetr(sw, best)) / sw.atr : 0
    }
    case 'at': {
      const tol = p.tol === undefined ? 0.25 : p.tol
      if (sw.atr <= 1e-12) return false
      return Math.abs(sw.last - fibRetr(sw, needs('r'))) <= tol * sw.atr
    }
    case 'goldenPocket': {
      const pos = fibPos(sw)
      return pos >= 0.382 && pos <= 0.618
    }
    case 'dir': return sw.up ? 1 : -1
    case 'high': return sw.hi
    case 'low': return sw.lo
    case 'legBars': return sw.legBars
    case 'legAtr': return sw.atr > 1e-12 ? sw.diff / sw.atr : 0
    case 'age': return sw.age
    case 'arc':
    case 'arcDist':
    case 'arcLive': {
      const r = needs('r')
      if (!(r > 0)) throw new MslRuntimeError(`fib.${name}(r): the arc ratio must be > 0 (0.382 / 0.5 / 0.618 are the usual ones)`)
      const a = fibArc(sw, r)
      if (name === 'arcLive') return a.live
      if (!a.live) throw new MslRuntimeError(`fib.${name}(${r}): the arc is not defined here (leg shorter than 3 bars, or the last bar is outside its radius) - gate on fib.arcLive(${r})`)
      return name === 'arc' ? a.price : sw.last - a.price
    }
    case 'tzUnit': return Math.max(1, sw.legBars)
    default: {
      const tz = fibTimeZone(sw, p.unit === undefined ? 1 : p.unit)
      if (name === 'tz') return tz.index
      if (name === 'tzMult') return tz.mult
      if (name === 'tzNext') return tz.toNext
      return tz.onZone(p.tol === undefined ? 0 : Math.max(0, p.tol))
    }
  }
}

/** `pivot.*` - floor pivot points (analytics/structural.ts computePivotSeries). With real candle timestamps spanning 2+ UTC days the
 * levels are the PREVIOUS day's (fixed for the whole day, no look-ahead); otherwise a rolling `period`-bar window ending on the previous
 * bar anchors them. Candle-derived, backtestable. Optional first arg = variant 0 classic | 1 fibonacci | 2 camarilla | 3 woodie (default 0);
 * optional second = rolling period (10-500, default 60).
 *   pp() r1() r2() r3() s1() s2() s3()   the levels        above()   how many of the seven levels price is above (0-7)
 *   nearest()   price of the closest level      nearestDist()   signed distance close - nearest, in ATR(14)      mode()   "session" | "rolling"      ok() */
const pivotCache = new WeakMap<MslSeriesCtx, Map<string, ReturnType<typeof readPivots>>>()
function pivotMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const s = requireSeries(ctx, tf)
  const variant = numArg(args, 0) ?? 0
  const period = numArg(args, 1) ?? 60
  const key = `${variant}|${period}`
  let byKey = pivotCache.get(s)
  if (!byKey) pivotCache.set(s, (byKey = new Map()))
  let m = byKey.get(key)
  if (m === undefined) {
    m = readPivots(candlesWithTime(s), variant, period)
    byKey.set(key, m)
  }
  if (name === 'ok') return m !== null
  if (!m) throw new MslRuntimeError(`pivot.${name}() has no levels yet (needs 12+ bars and, in rolling mode, a full window - or a prior UTC day in session mode)`)
  const levels = [m.s3, m.s2, m.s1, m.pp, m.r1, m.r2, m.r3]
  const last = s.close[s.close.length - 1]
  switch (name) {
    case 'pp': return m.pp
    case 'r1': return m.r1
    case 'r2': return m.r2
    case 'r3': return m.r3
    case 's1': return m.s1
    case 's2': return m.s2
    case 's3': return m.s3
    case 'above': return levels.filter((l) => last > l).length
    case 'nearest':
    case 'nearestDist': {
      let best = levels[0]
      for (const l of levels) if (Math.abs(l - last) < Math.abs(best - last)) best = l
      if (name === 'nearest') return best
      return m.atr > 1e-12 ? (last - best) / m.atr : 0
    }
    case 'mode': return m.mode
    default:
      throw new MslRuntimeError(`unknown pivot method "pivot.${name}(...)" - use ok/pp/r1/r2/r3/s1/s2/s3/above/nearest/nearestDist/mode`)
  }
}

/** `vol.*` - ATR volatility state, to trade MODERATE volatility and skip dead or frantic markets. Everything is relative to the pair's OWN
 * recent ATR history (percentile rank), so "low"/"high" mean the same on forex, crypto and OTC. Candle-derived, backtestable.
 * Optional first arg = ATR period (2-100, default 14) on methods that read the ATR; `lb` = history window for the rank (30-1000, default 200).
 *   atr(period?)         the ATR in price units      atrPct(period?)   ATR as % of price
 *   rank(period?, lb?)   percentile rank 0..1 of the current ATR inside the last lb ATR values (0.5 = typical)
 *   low(lo?, period?, lb?) / high(hi?, ...) / moderate(lo?, hi?, period?, lb?)   rank < lo (default 0.25) / rank > hi (default 0.75) / lo <= rank <= hi
 *   ratio(fast?, slow?)  ATR(fast)/ATR(slow) (defaults 5, 30): > 1 volatility expanding, < 1 contracting
 *   barRatio(offset?)    that closed bar's range / ATR(14) (offset -1 = latest, default): how oversized the bar is
 *   ok()                 60+ closed bars (history for the rank needs 30+ valid ATR values)
 * The 25 / 75 percentile bands are conventions, not tuned values: check them in a backtest on YOUR pair and expiry. */
const volCache = new WeakMap<MslSeriesCtx, Map<string, ReturnType<typeof readVol>>>()
function volMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const s = requireSeries(ctx, tf)
  if (name === 'ok') return s.close.length >= VOL_MIN_BARS && readVolCached(s, 14, 200, 5, 30) !== null
  if (s.close.length < VOL_MIN_BARS) throw new MslRuntimeError(`vol.${name}() needs at least ${VOL_MIN_BARS} closed bars - history is too thin`)
  switch (name) {
    case 'atr':
    case 'atrPct': {
      const m = readVolCached(s, numArg(args, 0) ?? 14, 200, 5, 30)
      if (!m) throw new MslRuntimeError(`vol.${name}(): ATR not available yet`)
      return name === 'atr' ? m.atr : m.atrPct
    }
    case 'rank': {
      const m = readVolCached(s, numArg(args, 0) ?? 14, numArg(args, 1) ?? 200, 5, 30)
      if (!m) throw new MslRuntimeError('vol.rank(): not enough ATR history yet (needs 30+ valid ATR values in the window)')
      return m.rank
    }
    case 'low':
    case 'high':
    case 'moderate': {
      const lo = name === 'high' ? 0.25 : numArg(args, 0) ?? 0.25
      const hi = name === 'high' ? numArg(args, 0) ?? 0.75 : name === 'moderate' ? numArg(args, 1) ?? 0.75 : 0.75
      const pi = name === 'moderate' ? 2 : 1
      const m = readVolCached(s, numArg(args, pi) ?? 14, numArg(args, pi + 1) ?? 200, 5, 30)
      if (!m) throw new MslRuntimeError(`vol.${name}(): not enough ATR history yet (needs 30+ valid ATR values in the window)`)
      if (name === 'low') return m.rank < lo
      if (name === 'high') return m.rank > hi
      if (!(lo >= 0 && hi <= 1 && lo < hi)) throw new MslRuntimeError('vol.moderate(lo, hi): need 0 <= lo < hi <= 1')
      return m.rank >= lo && m.rank <= hi
    }
    case 'ratio': {
      const m = readVolCached(s, 14, 200, numArg(args, 0) ?? 5, numArg(args, 1) ?? 30)
      if (!m) throw new MslRuntimeError('vol.ratio(): ATR not available yet')
      return m.ratio
    }
    case 'barRatio': {
      const m = readVolCached(s, 14, 200, 5, 30)
      if (!m || m.atr <= 1e-12) throw new MslRuntimeError('vol.barRatio(): ATR not available yet')
      const off = Math.trunc(numArg(args, 0) ?? -1)
      const i = s.close.length + off
      if (i < 0 || i >= s.close.length) throw new MslRuntimeError(`vol.barRatio(${off}) out of range`)
      return (s.high[i] - s.low[i]) / m.atr
    }
    default:
      throw new MslRuntimeError(`unknown vol method "vol.${name}(...)" - use ok/atr/atrPct/rank/low/high/moderate/ratio/barRatio`)
  }
}
function readVolCached(s: MslSeriesCtx, period: number, lookback: number, fast: number, slow: number) {
  const key = `${period}|${lookback}|${fast}|${slow}`
  let byKey = volCache.get(s)
  if (!byKey) volCache.set(s, (byKey = new Map()))
  let m = byKey.get(key)
  if (m === undefined) {
    m = readVol(seriesToCandles(s), period, lookback, fast, slow)
    byKey.set(key, m)
  }
  return m
}

/** `amd.*` - ACCUMULATION / MANIPULATION / DISTRIBUTION (ICT "Power of 3") phase detector (analytics/mslamd.ts), a causal state machine on
 * CLOSED candles: a tight consolidation box (accumulation) -> a poke beyond one side that is reclaimed within 4 bars (manipulation, the false
 * break / liquidity grab) -> a close beyond the OPPOSITE edge (distribution, the real move, opposite the sweep). Candle-derived: works in
 * meta_strategy_eval, Meta Trader, Omni Trader AND meta_strategy_backtest. Needs 120+ closed bars. An optional first numeric arg picks the box source:
 *   0 (default) "structure": the most recent qualifying consolidation anywhere in the trailing window - works on any asset incl. OTC
 *   1 "session": the UTC-day ASIA range (00:00-08:00) is the box; only bars from 08:00 UTC on can sweep it (London) and distribute (New York).
 *     Needs real candle timestamps and the whole Asia session inside the history; meaningful for real FX/crypto sessions, NOT OTC instruments.
 *   phase()  STRING "none" | "accumulation" | "manipulation" | "distribution"      stage()   0 none / 1 accumulation / 2 manipulation / 3 distribution
 *   accumulating()  manipulating()  distributing()   booleans
 *   dir()    +1 bullish / -1 bearish: the expected (manipulation) or realised (distribution) real-move direction, opposite the sweep; 0 before any sweep
 *   sweepSide()  +1 the box high was swept / -1 the box low / 0      returned()  manipulation only: price has closed back inside the box (reclaim done)
 *   breakout()   +1 / -1 a breach that was NOT reclaimed in time (a genuine breakout; phase is "none") / 0
 *   age()        bars since the current phase began      sweepDepth()  how far past the box the sweep went, in ATR
 *   moveAtr()    distribution: how far the close is beyond the opposite box edge, in ATR (positive = with dir)
 *   boxHigh() boxLow() boxBars()   the box      ok()  120+ bars (and, in session mode, real timestamps + the full Asia session in history)
 * The cycle is dropped when it stalls (no distribution within 15 bars of the reclaim), fails (price re-breaches the sweep side, or closes back
 * through the sweep extreme after distributing) or ages out (30 bars after distribution began). Fixed thresholds (box compression <= 0.65 of the
 * prior 40 bars' true range, box range <= 2.5 prior ATR, sweep > 0.1 ATR beyond the box) - they are conventions, not tuned values. */
const amdCache = new WeakMap<MslSeriesCtx, Map<number, AmdRead | null>>()
function amdMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const s = requireSeries(ctx, tf)
  const modeArg = numArg(args, 0)
  const mode = modeArg === 1 ? 1 : 0
  if (modeArg !== undefined && modeArg !== 0 && modeArg !== 1) throw new MslRuntimeError(`amd.${name}(mode): mode is 0 (structure) or 1 (session), got ${modeArg}`)
  const hasTime = !!s.time && s.time.length === s.close.length
  let byMode = amdCache.get(s)
  if (!byMode) amdCache.set(s, (byMode = new Map()))
  let m = byMode.get(mode)
  if (m === undefined) {
    m = mode === 1 && !hasTime ? null : readAmd(candlesWithTime(s), mode)
    byMode.set(mode, m)
  }
  if (name === 'ok') return m !== null
  if (!m) {
    throw new MslRuntimeError(
      mode === 1 && !hasTime
        ? `amd.${name}(1): session mode needs candle timestamps, which this evaluation context does not carry`
        : `amd.${name}() needs at least ${AMD_MIN_BARS} closed bars - history is too thin`,
    )
  }
  switch (name) {
    case 'phase': return m.phase
    case 'stage': return m.phase === 'accumulation' ? 1 : m.phase === 'manipulation' ? 2 : m.phase === 'distribution' ? 3 : 0
    case 'accumulating': return m.phase === 'accumulation'
    case 'manipulating': return m.phase === 'manipulation'
    case 'distributing': return m.phase === 'distribution'
    case 'dir': return m.dir
    case 'sweepSide': return m.sweepSide
    case 'returned': return m.returned
    case 'breakout': return m.breakout
    case 'age': return m.age
    case 'sweepDepth': return m.sweepDepth
    case 'moveAtr': return m.moveAtr
    case 'boxHigh': return m.boxHigh
    case 'boxLow': return m.boxLow
    case 'boxBars': return m.boxBars
    default:
      throw new MslRuntimeError(`unknown amd method "amd.${name}(...)" - use ok/phase/stage/accumulating/manipulating/distributing/dir/sweepSide/returned/breakout/age/sweepDepth/moveAtr/boxHigh/boxLow/boxBars`)
  }
}

/** `wyckoff.*` - WYCKOFF accumulation / distribution SCHEMATIC reader (analytics/mslwyckoff.ts): a clear prior trend -> a climax bar -> a sideways
 * range -> spring (accumulation) / upthrust (distribution) -> SOS / SOW -> LPS / LPSY -> markup / markdown, with phases A-E. Candle-derived (volume
 * is used only when it varies; `volumeOk()` says whether it did). Needs 150+ closed bars. Detects the SHAPE only - no edge is claimed.
 *   schematic() STRING "none"|"accumulation"|"distribution"   phase() STRING "none"|"A".."E"   stage() 0 none / 1..5 = A..E
 *   accumulation() distribution()   booleans      dir() +1 / -1 / 0
 *   support() resistance() rangeBars() priorTrend() (ATR, signed)   sinceRange() bars since the range ended
 *   climax() spring() upthrust() sos() sow() lps() lpsy()   booleans      volumeOk()   ok()   150+ bars */
const wyckoffCache = new WeakMap<MslSeriesCtx, WyckoffRead | null>()
function wyckoffMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  void args
  const s = requireSeries(ctx, tf)
  let m = wyckoffCache.get(s)
  if (m === undefined) {
    m = readWyckoff(candlesWithTime(s))
    wyckoffCache.set(s, m)
  }
  if (name === 'ok') return m !== null
  if (!m) throw new MslRuntimeError(`wyckoff.${name}() needs at least ${WYCKOFF_MIN_BARS} closed bars - history is too thin`)
  switch (name) {
    case 'schematic': return m.schematic
    case 'phase': return m.phase
    case 'stage': return m.phase === 'none' ? 0 : m.phase.charCodeAt(0) - 64
    case 'accumulation': return m.schematic === 'accumulation'
    case 'distribution': return m.schematic === 'distribution'
    case 'dir': return m.dir
    case 'support': return m.support
    case 'resistance': return m.resistance
    case 'rangeBars': return m.rangeBars
    case 'priorTrend': return m.priorTrendAtr
    case 'sinceRange': return m.sinceRange
    case 'climax': return m.climax
    case 'spring': return m.spring
    case 'upthrust': return m.upthrust
    case 'sos': return m.sos
    case 'sow': return m.sow
    case 'lps': return m.lps
    case 'lpsy': return m.lpsy
    case 'volumeOk': return m.volumeOk
    default:
      throw new MslRuntimeError(`unknown wyckoff method "wyckoff.${name}(...)" - use ok/schematic/phase/stage/accumulation/distribution/dir/support/resistance/rangeBars/priorTrend/sinceRange/climax/spring/upthrust/sos/sow/lps/lpsy/volumeOk`)
  }
}

/** `pv.*` - PRICE / VOLUME relationship readers (analytics/mslpv.ts) over the last n closed bars (n = first arg, default 30, 10-120). Candle-derived:
 * works in meta_strategy_eval, the traders AND meta_strategy_backtest. Gate every script on `pv.volumeOk()` - OTC and some feeds carry flat or
 * missing volume, and then every reader returns 0 instead of inventing a relationship. Describes the CURRENT window; no predictive edge is claimed.
 *   ok() 40+ bars   volumeOk() volume varies (not flat / mostly zero)
 *   corrRet(n?) corr(signed bar change, volume)   corrAbs(n?) corr(|bar change|, volume)   corrLevel(n?) corr(close level, volume) (trend-dominated)
 *   relVol(n?) last 3 bars' volume / mean of the n before   tilt(n?) up-bar volume share minus down-bar volume share, -1..+1
 *   effort() last bar's relative volume / relative range (> 1 absorption, < 1 easy movement) */
const pvCache = new WeakMap<MslSeriesCtx, Map<number, PvRead | null>>()
function pvMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const s = requireSeries(ctx, tf)
  const n = args.length ? Math.max(10, Math.min(120, Math.round(asNum(args[0])))) : 30
  let byN = pvCache.get(s)
  if (!byN) { byN = new Map(); pvCache.set(s, byN) }
  let m = byN.get(n)
  if (m === undefined) {
    m = readPv({ close: s.close, high: s.high, low: s.low, volume: s.volume }, n)
    byN.set(n, m)
  }
  if (name === 'ok') return m !== null
  if (!m) throw new MslRuntimeError(`pv.${name}() needs at least ${PV_MIN_BARS} closed bars - history is too thin`)
  switch (name) {
    case 'volumeOk': return m.volumeOk
    case 'corrRet': return m.corrRet
    case 'corrAbs': return m.corrAbs
    case 'corrLevel': return m.corrLevel
    case 'relVol': return m.relVol
    case 'tilt': return m.tilt
    case 'effort': return m.effort
    default:
      throw new MslRuntimeError(`unknown pv method "pv.${name}(...)" - use ok/volumeOk/corrRet/corrAbs/corrLevel/relVol/tilt/effort`)
  }
}

/** `smcx.*` - the three SMC CONTEXT concepts as candle-derived primitives (analytics/mslsmcx.ts): equal highs/lows pools, rejection blocks,
 * inducement. Works in meta_strategy_eval, the traders AND meta_strategy_backtest (unlike the bare `smc:<KIND>` verdict sources, which read
 * none in a backtest). Needs 60+ closed bars with real timestamps.
 *   ok()
 *   eqhNear(k?) / eqlNear(k?)   an unswept equal-highs pool above / equal-lows pool below within k ATR of price (default 1)
 *   eqhDist() / eqlDist()       ATR distance to that pool (99 when none)      eqhTouches() / eqlTouches()  swing touches in the pool (0 when none)
 *   rejBull() / rejBear()       a still-valid bullish / bearish rejection block exists (not closed through)
 *   rejBullIn() / rejBearIn()   price is currently inside that block's wick zone       rejAgo(dir?)  bars since the newest block of dir ("bull"|"bear"), 99 when none
 *   idmBull(n?) / idmBear(n?)   an inducement take in that direction within the last n bars (default 3, max 10)
 *   idmAgo(dir)                 bars since the newest take of dir ("bull"|"bear"), 99 when none
 *   pdOk() / pdPos() / pdSpanAtr()   the dealing range between the latest confirmed swing high and low (>= 1.5 ATR wide): pdPos 0 = range low (deep
 *                               discount), 0.5 = equilibrium, 1 = range high (deep premium), not clamped; premium(k?) = pdPos > k, discount(k?) = pdPos < k (k default 0.5)
 *   mitBull()/mitBear()  a still-valid MITIGATION block: after a lower low (higher high), a swing low (high) FAILS to undercut (exceed) it and a close breaks
 *                               the intervening swing high (low) within 30 bars; the block = the last opposing candle before the break (its full range)
 *   propBull()/propBear()       a PROPULSION block: a >= 0.7 ATR candle that taps an unviolated same-direction order block and closes beyond it (zone = its body)
 *   mitBullIn()/mitBearIn()/propBullIn()/propBearIn()  price inside that zone      mitAgo(dir)/propAgo(dir)  bars since it completed (99 = none)
 *   viBull(minAtr?)/viBear(minAtr?)  an unfilled VOLUME IMBALANCE (bodies do not touch, wicks overlap) of >= minAtr ATR (default 0.05) within 40 bars;
 *                               viBullIn/viBearIn(minAtr?), viAgo(dir, minAtr?), viSizeAtr(dir, minAtr?)
 *   judasBull(session?, k?)/judasBear(session?, k?)  JUDAS SWING at the session open (0 day open 00:00 UTC, 1 London 07:00 (default), 2 New York 12:00): a fake
 *                               move >= 0.75 ATR one way inside 3 hours, then a close back through the open; bull = fake down then up; true within k bars (default 6)
 *                               of the reclaim; judasAgo(session?) bars since (99 = none). Needs timestamps.
 *   soupBull(period?, k?)/soupBear(period?, k?)  TURTLE SOUP: a bar takes out the lowest low (highest high) of the prior period bars (default 20, extreme >= 4 bars
 *                               old) and closes back inside, within the last k bars (default 1); soupAgo(dir, period?) bars since (99 = none) */
const smcxCache = new WeakMap<MslSeriesCtx, SmcxRead | null>()
const smcxCandlesCache = new WeakMap<MslSeriesCtx, Candle[]>()
const smcxBlocksCache = new WeakMap<MslSeriesCtx, Map<number, BlockRead | null>>()
const smcxMiscCache = new WeakMap<MslSeriesCtx, Map<string, unknown>>()
function smcxCandles(s: MslSeriesCtx): Candle[] {
  let c = smcxCandlesCache.get(s)
  if (!c) {
    const n = s.close.length
    const hasTime = !!s.time && s.time.length === n
    c = new Array(n)
    for (let i = 0; i < n; i++) c[i] = { time: hasTime ? s.time![i] : i, open: s.open[i], high: s.high[i], low: s.low[i], close: s.close[i], volume: s.volume[i] }
    smcxCandlesCache.set(s, c)
  }
  return c
}
function smcxMemo<T>(s: MslSeriesCtx, key: string, f: () => T): T {
  let m = smcxMiscCache.get(s)
  if (!m) { m = new Map(); smcxMiscCache.set(s, m) }
  if (!m.has(key)) m.set(key, f())
  return m.get(key) as T
}
function smcxMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const s = requireSeries(ctx, tf)
  let m = smcxCache.get(s)
  if (m === undefined) {
    const n = s.close.length
    const hasTime = !!s.time && s.time.length === n
    const candles: Candle[] = new Array(n)
    for (let i = 0; i < n; i++) candles[i] = { time: hasTime ? s.time![i] : i, open: s.open[i], high: s.high[i], low: s.low[i], close: s.close[i], volume: s.volume[i] }
    m = readSmcx(candles)
    smcxCache.set(s, m)
  }
  if (name === 'ok') return m !== null
  if (!m) throw new MslRuntimeError(`smcx.${name}() needs at least ${SMCX_MIN_BARS} closed bars - history is too thin`)
  const dirArg = (): 'bull' | 'bear' => {
    const d = args.length ? String(args[0]).toLowerCase() : ''
    if (d === 'bull' || d === 'bear') return d
    throw new MslRuntimeError(`smcx.${name}() needs "bull" or "bear"`)
  }
  const win = (): number => (args.length ? Math.max(0, Math.min(10, Math.round(asNum(args[0])))) : 3)
  switch (name) {
    case 'eqhNear': return !!m.eqh && m.eqh.distAtr <= (args.length ? asNum(args[0]) : 1)
    case 'eqlNear': return !!m.eql && m.eql.distAtr <= (args.length ? asNum(args[0]) : 1)
    case 'eqhDist': return m.eqh ? m.eqh.distAtr : 99
    case 'eqlDist': return m.eql ? m.eql.distAtr : 99
    case 'eqhTouches': return m.eqh ? m.eqh.touches : 0
    case 'eqlTouches': return m.eql ? m.eql.touches : 0
    case 'rejBull': return m.rejBull !== null
    case 'rejBear': return m.rejBear !== null
    case 'rejBullIn': return !!m.rejBull && m.rejBull.inZone
    case 'rejBearIn': return !!m.rejBear && m.rejBear.inZone
    case 'rejAgo': { const d = dirArg(); const r = d === 'bull' ? m.rejBull : m.rejBear; return r ? r.barsAgo : 99 }
    case 'idmBull': return m.idmBull !== null && m.idmBull <= win()
    case 'idmBear': return m.idmBear !== null && m.idmBear <= win()
    case 'mitBull': case 'mitBear': case 'mitBullIn': case 'mitBearIn': case 'mitAgo':
    case 'propBull': case 'propBear': case 'propBullIn': case 'propBearIn': case 'propAgo':
    case 'viBull': case 'viBear': case 'viBullIn': case 'viBearIn': case 'viAgo': case 'viSizeAtr': {
      const isVi = name.startsWith('vi')
      const dirMeth = name.endsWith('Ago') || name === 'viSizeAtr'
      const minAtr = isVi ? (dirMeth ? (args.length > 1 ? asNum(args[1]) : 0.05) : args.length ? asNum(args[0]) : 0.05) : 0.05
      let byMin = smcxBlocksCache.get(s)
      if (!byMin) { byMin = new Map(); smcxBlocksCache.set(s, byMin) }
      let b = byMin.get(minAtr)
      if (b === undefined) { b = readBlocks(smcxCandles(s), minAtr); byMin.set(minAtr, b) }
      if (!b) throw new MslRuntimeError(`smcx.${name}() needs at least 60 closed bars`)
      const fam = name.slice(0, name.search(/[A-Z]/)) as 'mit' | 'prop' | 'vi'
      const pick = (d: 'bull' | 'bear') => (b![`${fam}${d === 'bull' ? 'Bull' : 'Bear'}` as 'mitBull'] as { barsAgo: number; inZone: boolean; sizeAtr?: number } | null)
      if (name === 'mitAgo' || name === 'propAgo' || name === 'viAgo') { const z = pick(dirArg()); return z ? z.barsAgo : 99 }
      if (name === 'viSizeAtr') { const z = pick(dirArg()); return z && z.sizeAtr !== undefined ? z.sizeAtr : 0 }
      const bull = name.includes('Bull')
      const z = pick(bull ? 'bull' : 'bear')
      return name.endsWith('In') ? !!z && z.inZone : z !== null
    }
    case 'judasBull': case 'judasBear': case 'judasAgo': {
      const sess = args.length ? Math.round(asNum(args[0])) : 1
      if (sess !== 0 && sess !== 1 && sess !== 2) throw new MslRuntimeError(`smcx.${name}(session) - session must be 0 (day open 00:00 UTC), 1 (London 07:00) or 2 (New York 12:00)`)
      if (!s.time || s.time.length !== s.close.length) throw new MslRuntimeError(`smcx.${name}() needs candle timestamps, which this evaluation context does not carry`)
      const j = smcxMemo<JudasRead | null>(s, `judas${sess}`, () => readJudas(smcxCandles(s), sess as 0 | 1 | 2))
      if (!j) throw new MslRuntimeError(`smcx.${name}() needs at least 60 closed bars`)
      const k = args.length > 1 ? Math.max(0, Math.round(asNum(args[1]))) : 6
      if (name === 'judasAgo') return j.ago
      return name === 'judasBull' ? j.dir === 1 && j.ago <= k : j.dir === -1 && j.ago <= k
    }
    case 'soupBull': case 'soupBear': case 'soupAgo': {
      const dirKey: 'bull' | 'bear' = name === 'soupAgo' ? dirArg() : name === 'soupBull' ? 'bull' : 'bear'
      const pIdx = name === 'soupAgo' ? 1 : 0
      const period = args.length > pIdx ? Math.max(5, Math.min(100, Math.round(asNum(args[pIdx])))) : 20
      const ago = smcxMemo<number | null>(s, `soup${dirKey}${period}`, () => readSoup(smcxCandles(s), dirKey, period))
      if (ago === null) throw new MslRuntimeError(`smcx.${name}() needs at least ${period + 6} closed bars`)
      if (name === 'soupAgo') return ago
      const k = args.length > pIdx + 1 ? Math.max(1, Math.round(asNum(args[pIdx + 1]))) : 1
      return ago < k
    }
    case 'pdOk': return m.pd !== null
    case 'pdPos': if (!m.pd) throw new MslRuntimeError('smcx.pdPos() needs a dealing range: a confirmed swing high AND low at least 1.5 ATR apart (gate on smcx.pdOk())'); return m.pd.pos
    case 'pdSpanAtr': return m.pd ? m.pd.spanAtr : 0
    case 'premium': return !!m.pd && m.pd.pos > (args.length ? asNum(args[0]) : 0.5)
    case 'discount': return !!m.pd && m.pd.pos < (args.length ? asNum(args[0]) : 0.5)
    case 'idmAgo': { const d = dirArg(); const v = d === 'bull' ? m.idmBull : m.idmBear; return v === null ? 99 : v }
    default:
      throw new MslRuntimeError(`unknown smcx method "smcx.${name}(...)" - use ok/eqhNear/eqlNear/eqhDist/eqlDist/eqhTouches/eqlTouches/rejBull/rejBear/rejBullIn/rejBearIn/rejAgo/idmBull/idmBear/idmAgo/pdOk/pdPos/pdSpanAtr/premium/discount/mitBull/mitBear/mitBullIn/mitBearIn/mitAgo/propBull/propBear/propBullIn/propBearIn/propAgo/viBull/viBear/viBullIn/viBearIn/viAgo/viSizeAtr/judasBull/judasBear/judasAgo/soupBull/soupBear/soupAgo`)
  }
}

/** `smt.*` - SMT divergence between THIS pair and a PARTNER pair (analytics/smt.ts). The partner is the FIRST argument, a quoted ticker:
 *   smt.bearish("GBPUSD")  / smt.bullish("GBPUSD")   BOOLEAN - one of the two made a new high (low) in the last `recent` bars and the other did not
 *   smt.dir("GBPUSD")      STRING "bullish" | "bearish" | "none"      smt.ok("GBPUSD")  BOOLEAN - enough aligned bars AND co-moving (corr >= 0.5)
 *   smt.corr("GBPUSD")     the pair's return correlation before the window
 *   smt.leads("GBPUSD")    +1 when THIS pair took the extreme (the partner failed), -1 when the PARTNER took it, 0 when no divergence
 *   optional trailing args: inverse (true for an inversely related pair such as USDCHF), lookback (12-120, default 24), recent (3-60, default 8)
 * Live and in a single-asset backtest (the backtester is given the partner's candles); NOT in walk-forward / cross-asset runs. Fails closed when
 * the partner has no data. Gate scripts on smt.ok(partner): a divergence on a pair that is not co-moving is meaningless (the readers return false). */
function smtMethod(name: string, args: MslValue[], ctx: EvalEnv): MslValue {
  const s = requireSeries(ctx, undefined)
  if (!args.length || typeof args[0] !== 'string') throw new MslRuntimeError(`smt.${name}() needs the partner pair as its first argument, e.g. smt.${name}("GBPUSD")`)
  const partner = String(args[0]).trim()
  if (!s.partner) throw new MslRuntimeError('smt.*() needs partner-pair candles, which this evaluation context does not carry')
  const ps = s.partner(partner)
  if (!ps) throw new MslRuntimeError(`smt.${name}("${partner}") - no candle data for the partner pair "${partner}" (check the ticker, or the pair is not open)`)
  const toCandles = (x: MslSeriesCtx): Candle[] => {
    const n = x.close.length
    const out: Candle[] = new Array(n)
    for (let i = 0; i < n; i++) out[i] = { time: x.time ? x.time[i] : i, open: x.open[i], high: x.high[i], low: x.low[i], close: x.close[i], volume: x.volume[i] }
    return out
  }
  if (!s.time || !ps.time) throw new MslRuntimeError('smt.*() needs candle timestamps on both pairs to align them')
  const inverse = args.length > 1 && (args[1] === true || args[1] === 1)
  const lookback = args.length > 2 ? asNum(args[2]) : undefined
  const recent = args.length > 3 ? asNum(args[3]) : undefined
  const r = smtDivergence(toCandles(s), toCandles(ps), { inverse, lookback, recent })
  switch (name) {
    case 'ok': return r.ok
    case 'corr': return r.corr
    case 'bearish': return r.ok && r.direction === 'bearish'
    case 'bullish': return r.ok && r.direction === 'bullish'
    case 'dir': return r.ok ? r.direction : 'none'
    case 'leads': return !r.ok || r.leader === null ? 0 : r.leader === 'a' ? 1 : -1
    default:
      throw new MslRuntimeError(`unknown smt method "smt.${name}(...)" - use ok/corr/bearish/bullish/dir/leads`)
  }
}

/** `mmxm.*` - MARKET MAKER MODEL (buy / sell) lifecycle on this pair's closed candles (analytics/mslmmxm.ts): original CONSOLIDATION -> a sell-side
 * (buy-side) CURVE through the consolidation low (high) -> the smart-money REVERSAL (a close back through the last lower-high / higher-low = market
 * structure shift) -> the opposite curve back toward the consolidation. Causal (closed bars only), candle-derived, so it works live, in the traders and
 * in meta_strategy_backtest.
 *   ok()             60+ bars        model() STRING "buy"|"sell"|"none"        phase() 0 none, 2 curve done / awaiting reversal, 3 reversal just confirmed,
 *                                    4 reversal curve running, 5 target reached
 *   buy() / sell()   the model is in phase 3 or 4 (the entry window: reversal confirmed, target not yet reached, still on its side of the invalidation)
 *   progress()       0..1.5 of the way from the curve extreme to the target     target()  consolidation high (buy) / low (sell)
 *   invalidation()   the curve extreme (a new extreme beyond it voids the model) mss()     the reversal trigger level (last lower-high / higher-low)
 *   consolHigh() / consolLow()  the original consolidation range      sinceMss() / sinceExtreme()  bars       swept()  the curve's end also swept a prior low/high */
const mmxmCache = new WeakMap<MslSeriesCtx, MmxmRead | null>()
function mmxmMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  void args
  const s = requireSeries(ctx, tf)
  let m = mmxmCache.get(s)
  if (m === undefined) {
    const n = s.close.length
    const candles: Candle[] = new Array(n)
    for (let i = 0; i < n; i++) candles[i] = { time: s.time && s.time.length === n ? s.time[i] : i, open: s.open[i], high: s.high[i], low: s.low[i], close: s.close[i], volume: s.volume[i] }
    m = readMmxm(candles)
    mmxmCache.set(s, m)
  }
  if (name === 'ok') return m !== null
  if (!m) throw new MslRuntimeError(`mmxm.${name}() needs at least ${MMXM_MIN_BARS} closed bars - history is too thin`)
  switch (name) {
    case 'model': return m.model
    case 'phase': return m.phase
    case 'buy': return m.model === 'buy' && (m.phase === 3 || m.phase === 4)
    case 'sell': return m.model === 'sell' && (m.phase === 3 || m.phase === 4)
    case 'progress': return m.progress
    case 'target': return m.target
    case 'invalidation': return m.invalidation
    case 'mss': return m.mss
    case 'consolHigh': return m.consolHigh
    case 'consolLow': return m.consolLow
    case 'sinceMss': return m.sinceMss
    case 'sinceExtreme': return m.sinceExtreme
    case 'swept': return m.swept
    default:
      throw new MslRuntimeError(`unknown mmxm method "mmxm.${name}(...)" - use ok/model/phase/buy/sell/progress/target/invalidation/mss/consolHigh/consolLow/sinceMss/sinceExtreme/swept`)
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
  // BUG FIX (configure-override gap, see EvalEnv.configs' doc comment):
  // renko.brick/renko.atrPeriod/renko.atrMult (the EXACT keys
  // plugins/metastrategy.ts's MSL_READ_CONFIGS whitelist already uses for
  // this engine) now actually reach it when a script sets them, instead of
  // always using the hardcoded defaults no matter what `configure` said.
  const r = renkoBricks(candles, {
    brickSize: cfgNumLang(ctx, 'renko.brick', undefined),
    atrPeriod: cfgNumLang(ctx, 'renko.atrPeriod', undefined),
    atrMult: cfgNumLang(ctx, 'renko.atrMult', undefined),
  })
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
  // BUG FIX (configure-override gap) - pf.boxSize/pf.atrPeriod/pf.atrMult/
  // pf.reversalBoxes now reach the engine from a script's own `configure`.
  const r = pointFigure(candles, {
    boxSize: cfgNumLang(ctx, 'pf.boxSize', undefined),
    atrPeriod: cfgNumLang(ctx, 'pf.atrPeriod', undefined),
    atrMult: cfgNumLang(ctx, 'pf.atrMult', undefined),
    reversalBoxes: cfgNumLang(ctx, 'pf.reversalBoxes', undefined),
  })
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
    // Double/triple top-bottom breakout detection (claude/msl-capability-
    // matrix.md section I, flagged "missing" since Phase 2) - the engine
    // (pointFigure()) was ALREADY computing this internally the whole
    // time (`buySignal`/`sellSignal`/`pattern` - the "most recent of
    // either side" reduction) and simply never exposing it to MSL, the
    // same shape of gap foot.divergence()/foot.exhaustion() turned out to
    // be back in Phase 4. `pf.breakout()`/.breakoutName()/.breakoutAt()
    // read the MOST RECENT pattern of either side (r.pattern); honest
    // "none" (never a forced guess) when no breakout has occurred yet in
    // the window, same convention swing.structure() already uses.
    case 'breakout':
      return r.pattern?.direction ?? 'none'
    case 'breakoutName':
      return r.pattern?.name ?? 'none'
    case 'breakoutAt':
      return r.pattern?.at ?? 0
    default:
      throw new MslRuntimeError(`unknown pf method "pf.${name}(...)" - use boxes(n?)/boxSize()/column(offset)/breakout()/breakoutName()/breakoutAt() (or pointFigure.dir/.conf/.value for the plain verdict read)`)
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
  // BUG FIX (configure-override gap) - range.range/range.atrPeriod/
  // range.atrMult (the existing whitelist's key names for this engine,
  // confusingly prefixed 'range.' rather than 'rangebars.' - matched
  // exactly rather than introducing a second, inconsistent naming).
  const r = rangeBars(candles, {
    range: cfgNumLang(ctx, 'range.range', undefined),
    atrPeriod: cfgNumLang(ctx, 'range.atrPeriod', undefined),
    atrMult: cfgNumLang(ctx, 'range.atrMult', undefined),
  })
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
  // BUG FIX (configure-override gap) - volbar.per (the existing whitelist's
  // key name for this engine).
  const r = volumeBars(candles, { per: cfgNumLang(ctx, 'volbar.per', undefined) })
  switch (name) {
    case 'bars':
      // BUG FIX (capability-matrix section K): VolumeBar.dir is now a
      // STORED field (volumebars.ts) - read it directly instead of
      // re-deriving close>=open at every call site.
      return seriesValue(r.bars.map((b) => b.dir).slice(-seriesLookback(args, 50)))
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
    // DEVELOPING POC/VAH/VAL (capability-matrix section O) - series of n,
    // one value PER PERIOD (not per-candle - see tpo.ts's own doc comment
    // on developingPoc/developingVah/developingVal for why), [-1] = the
    // most recently closed period's running value. NaN entries only on an
    // empty window (never in practice once period 0 has printed).
    case 'developingPoc':
      return seriesValue(r.developingPoc.slice(-seriesLookback(args, 50)).map(num))
    case 'developingVah':
      return seriesValue(r.developingVah.slice(-seriesLookback(args, 50)).map(num))
    case 'developingVal':
      return seriesValue(r.developingVal.slice(-seriesLookback(args, 50)).map(num))
    // SINGLE PRINTS (capability-matrix section O) - count() is the number
    // of thin (one-period) bins in the window; price(offset) reads the
    // offset-th single-print bin's mid price, chronological-by-PRICE order
    // (same -1-is-latest/highest convention as vp.hvn/.lvn above). Fails
    // closed with a clear "none yet" error rather than a confusing
    // out-of-range message, same pattern swing.high()/.low() use.
    case 'singlePrintCount':
      return r.singlePrintBins.length
    case 'singlePrintPrice': {
      if (!args.length) throw new MslRuntimeError('tpo.singlePrintPrice(offset) needs an offset argument, e.g. tpo.singlePrintPrice(-1)')
      if (!r.singlePrintBins.length) throw new MslRuntimeError('tpo.singlePrintPrice(offset) - no single-print bins in this window yet')
      const idx = offsetInto(r.singlePrintBins, asNum(args[0]), 'tpo.singlePrintPrice')
      return r.bins[idx].mid
    }
    // POOR HIGH/LOW vs EXCESS HIGH/LOW (capability-matrix section O) - see
    // tpo.ts's own doc comment on these fields for the exact shape-read
    // definition; poorHigh===!excessHigh and poorLow===!excessLow by
    // construction (both false together only on an empty window).
    case 'excessHigh':
      return r.excessHigh
    case 'excessLow':
      return r.excessLow
    case 'poorHigh':
      return r.poorHigh
    case 'poorLow':
      return r.poorLow
    default:
      throw new MslRuntimeError(`unknown tpo method "tpo.${name}(...)" - use poc()/vah()/val()/ibHigh()/ibLow()/developingPoc(n?)/developingVah(n?)/developingVal(n?)/singlePrintCount()/singlePrintPrice(offset)/excessHigh()/excessLow()/poorHigh()/poorLow() (or tpo.dir/.conf/.value for the plain verdict read)`)
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
  // BUG FIX (configure-override gap) - vp.binCount (already whitelisted in
  // plugins/metastrategy.ts's MSL_READ_CONFIGS for the verdict-source path;
  // this closes the same gap for a script's own direct vp.* calls).
  const r = computeVolumeProfile(candles, { binCount: cfgNumLang(ctx, 'vp.binCount', undefined) })
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

/** `dp.*` - Delta Profile (the 5th new chart type, deferred since the
 * roadmap's Phase 6, built in the post-roadmap follow-up session). Same
 * range-overlap/CLV-proxy approach as vp.*, just splitting each candle's
 * volume into buy/sell shares via close-location-value before binning (see
 * analytics/deltaprofile.ts's own header). Quality 'estimated', never
 * 'measured' - same disclosure convention as every other volume-shaped
 * surface in this codebase. */
function dpMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  // BUG FIX (configure-override gap) - dp.binCount.
  const r = computeDeltaProfile(candles, { binCount: cfgNumLang(ctx, 'dp.binCount', undefined) })
  const num = (v: number | null): number => (v === null ? NaN : v)
  switch (name) {
    case 'positiveDeltaPoc':
      return num(r.positiveDeltaPoc)
    case 'negativeDeltaPoc':
      return num(r.negativeDeltaPoc)
    case 'totalDelta':
      return r.totalDelta
    case 'totalVolume':
      return r.totalVolume
    case 'deltaSkew':
      return r.deltaSkew
    case 'deltaAt': {
      // dp.deltaAt(price) - the net delta of whichever bin a given price
      // falls into, 0 if the price is outside the profiled window.
      if (!args.length) throw new MslRuntimeError('dp.deltaAt(price) needs a price argument')
      const price = asNum(args[0])
      const row = r.rows.find((row) => price >= row.priceLow && price < row.priceHigh)
      return row ? row.delta : 0
    }
    default:
      throw new MslRuntimeError(`unknown dp method "dp.${name}(...)" - use positiveDeltaPoc()/negativeDeltaPoc()/totalDelta()/totalVolume()/deltaSkew()/deltaAt(price)`)
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
  // BUG FIX (configure-override gap) - linebreak.lines (already whitelisted
  // for the verdict-source path; now also honored by a script's own direct
  // linebreak.* calls).
  const r = lineBreak(candles, { lines: cfgNumLang(ctx, 'linebreak.lines', undefined) })
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
 * reversal has occurred, never a misleading 0). kagi.regime() is
 * "trending"/"ranging"/"choppy"/"none" (see kagi.ts's own classifyRegime
 * doc comment for the exact hh-hl/lh-ll-over-reversal-points rule and the
 * density floor that forces "choppy"). kagi.structure() is the raw
 * "hh-hl"/"lh-ll"/"none" read regime() is partly built from. kagi.legs() is
 * how many reversal lines were confirmed inside the regime lookback
 * window - the density/whipsaw count. */
function kagiMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  // BUG FIX (configure-override gap) - kagi.reversal/.atrPeriod/
  // .reversalAtrMult (all three already whitelisted for the verdict-source
  // path; now also honored by a script's own direct kagi.* calls).
  const r = kagi(candles, {
    reversal: cfgNumLang(ctx, 'kagi.reversal', undefined),
    atrPeriod: cfgNumLang(ctx, 'kagi.atrPeriod', undefined),
    reversalAtrMult: cfgNumLang(ctx, 'kagi.reversalAtrMult', undefined),
  })
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
    case 'regime':
      return r.regime
    case 'structure':
      return r.structure
    case 'legs':
      return r.legsInWindow
    default:
      throw new MslRuntimeError(`unknown kagi method "kagi.${name}(...)" - use direction()/thick()/reversal()/shoulder()/waist()/regime()/structure()/legs()`)
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
  // BUG FIX (configure-override gap) - swing.lookback (already whitelisted
  // for the verdict-source path; now also honored by a script's own direct
  // swing.* calls).
  const r = computeSwing(candles, { lookback: cfgNumLang(ctx, 'swing.lookback', undefined) })
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

/** `effort.*` - Effort Bricks (analytics/effortbricks.ts), a Renko variant
 * that also requires real participation (candle volume) behind a brick's
 * move before calling it confirmed - see that module's own header for the
 * full reasoning. `effort.bricks(n?)` is a series of signed brick
 * directions, same convention as `renko.bricks(n?)`. `effort.confirmed
 * (offset)`/`effort.effort(offset)`/`effort.ratio(offset)` read one
 * brick's own participation verdict/raw effort/effort-ratio (same -1=latest
 * offset convention as renko.ohlc/pf.column/swing.high). `effort.regime()`
 * is 'trending'/'ranging'/'choppy'/'none' (the one read none of Renko/P&F/
 * Range/Line-Break/Kagi can give - see effortbricks.ts's own header).
 * `effort.confirmedRatio()` and `effort.source()` ('volume'|'none') expose
 * the regime read's own inputs directly, for a script that wants to build
 * its own threshold rather than trust the built-in regime classification. */
function effortMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = effortBricks(candles, {
    brickSize: cfgNumLang(ctx, 'effort.brick', undefined),
    atrPeriod: cfgNumLang(ctx, 'effort.atrPeriod', undefined),
    atrMult: cfgNumLang(ctx, 'effort.atrMult', undefined),
    effortMult: cfgNumLang(ctx, 'effort.mult', undefined),
    lookback: cfgNumLang(ctx, 'effort.lookback', undefined),
  })
  switch (name) {
    case 'bricks':
      return seriesValue(r.bricks.map((b) => b.dir).slice(-seriesLookback(args, 50)))
    case 'brickSize':
      return r.brickSize
    case 'ohlc': {
      if (!args.length) throw new MslRuntimeError('effort.ohlc(offset) needs an offset argument, e.g. effort.ohlc(-1)')
      const b = offsetInto(r.bricks, asNum(args[0]), 'effort.ohlc')
      return barValueFromOHLC(b.open, b.high, b.low, b.close, 0)
    }
    case 'confirmed': {
      if (!args.length) throw new MslRuntimeError('effort.confirmed(offset) needs an offset argument, e.g. effort.confirmed(-1)')
      const b = offsetInto(r.bricks, asNum(args[0]), 'effort.confirmed')
      return b.confirmed
    }
    case 'effort': {
      if (!args.length) throw new MslRuntimeError('effort.effort(offset) needs an offset argument, e.g. effort.effort(-1)')
      const b = offsetInto(r.bricks, asNum(args[0]), 'effort.effort')
      return b.effort
    }
    case 'ratio': {
      if (!args.length) throw new MslRuntimeError('effort.ratio(offset) needs an offset argument, e.g. effort.ratio(-1)')
      const b = offsetInto(r.bricks, asNum(args[0]), 'effort.ratio')
      return Number.isFinite(b.effortRatio) ? b.effortRatio : 0
    }
    case 'regime':
      return r.regime
    case 'confirmedRatio':
      return r.confirmedRatio
    case 'source':
      return r.effortSource
    default:
      throw new MslRuntimeError(
        `unknown effort method "effort.${name}(...)" - use bricks(n?)/brickSize()/ohlc(offset)/confirmed(offset)/effort(offset)/ratio(offset)/regime()/confirmedRatio()/source() (or effort.dir/.conf/.value for the plain verdict read)`
      )
  }
}

/** `mrc.*` - Market Response Chart (analytics/mrc.ts), the adaptive-event-
 * clock engine: a bar closes on a price event, an activity event, OR a
 * time safeguard, carrying how much displacement a bar's activity actually
 * bought it (`responseEfficiency`/`responseRatio` - "effort without result"
 * vs "clean, low-resistance move"). HONEST FIDELITY, same contract
 * tickbar.* already established: uses REAL ticks (`mrc.fidelity() ==
 * 'tick'`) when this evaluation context has a live tick feed wired in
 * (`ctx.liveTicks`), otherwise falls back to this tf's own closed-candle
 * closes as pseudo-observations (`'candle'`) - NEVER fabricates a real
 * tick-level path where none exists, so `pathEfficiency`/`reversalCount`
 * read NaN in candle fidelity rather than a guessed number (see mrc.ts's
 * own module header). Every offset-indexed accessor uses the SAME
 * -1-is-latest convention as every other primitive in this file. Reads the
 * LATEST bar only when it fails closed with "no bars yet" - unlike most
 * other engines this one can genuinely produce zero bars on a very short
 * window (its triggers need at least 2 observations to ever fire). */
function mrcMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = computeMrc(candles, ctx.liveTicks as { ts: number; price: number }[] | undefined, {
    priceMult: cfgNumLang(ctx, 'mrc.priceMult', undefined),
    activityMult: cfgNumLang(ctx, 'mrc.activityMult', undefined),
    maxDurationSec: cfgNumLang(ctx, 'mrc.maxDuration', undefined),
    maxGapMultiple: cfgNumLang(ctx, 'mrc.maxGapMult', undefined),
    lookback: cfgNumLang(ctx, 'mrc.lookback', undefined),
  })
  if (name === 'fidelity') return r.fidelity
  if (name === 'bars') return seriesValue(r.bars.map((b) => Math.sign(b.directionalDelta)).slice(-seriesLookback(args, 50)))
  if (!r.bars.length) throw new MslRuntimeError('mrc.*(offset) - no bars have formed yet in this window (needs at least 2 observations for a trigger to fire)')
  if (!args.length) throw new MslRuntimeError(`mrc.${name}(offset) needs an offset argument, e.g. mrc.${name}(-1)`)
  const b = offsetInto(r.bars, asNum(args[0]), `mrc.${name}`)
  switch (name) {
    case 'ohlc':
      return barValueFromOHLC(b.open, b.high, b.low, b.close, 0)
    case 'duration':
      return b.duration
    case 'displacement':
      return b.displacement
    case 'range':
      return b.range
    case 'activity':
      return b.activityCount
    case 'velocity':
      return Number.isFinite(b.velocity) ? b.velocity : 0
    case 'directionalDelta':
      return b.directionalDelta
    case 'directionalRatio':
      return Number.isFinite(b.directionalRatio) ? b.directionalRatio : 0
    case 'pathEfficiency':
      return Number.isFinite(b.pathEfficiency) ? b.pathEfficiency : 0
    case 'reversalCount':
      return Number.isFinite(b.reversalCount) ? b.reversalCount : 0
    case 'priceConcentration':
      return Number.isFinite(b.priceConcentration) ? b.priceConcentration : 0
    case 'responseEfficiency':
      return Number.isFinite(b.responseEfficiency) ? b.responseEfficiency : 0
    case 'responseRatio':
      return Number.isFinite(b.responseRatio) ? b.responseRatio : 0
    case 'gap':
      return b.dataGap
    case 'confirmed':
      return b.confirmed
    default:
      throw new MslRuntimeError(
        `unknown mrc method "mrc.${name}(...)" - use bars(n?)/fidelity()/ohlc(offset)/duration(offset)/displacement(offset)/range(offset)/activity(offset)/velocity(offset)/directionalDelta(offset)/directionalRatio(offset)/pathEfficiency(offset)/reversalCount(offset)/priceConcentration(offset)/responseEfficiency(offset)/responseRatio(offset)/gap(offset)/confirmed(offset)`
      )
  }
}

/** `gap.*` - candlestick gap detection (claude/msl-capability-matrix.md
 * section A, flagged "missing" since the Phase 0 audit - see
 * analytics/gap.ts for the full honest-scope note: near-meaningless on
 * OTC synthetic pairs, which trade continuously and essentially never
 * gap; built for forex/real-market session opens). `gap.count()` is the
 * number of gaps found in the current series window; the offset-indexed
 * accessors below read the gap at that offset in CHRONOLOGICAL order,
 * same -1-is-latest convention as every other offset-indexed primitive
 * in this file (renko.ohlc/pf.column/swing.high/...). Fails closed with a
 * clear "no gaps yet" error rather than a confusing out-of-range message
 * when the window has none - same pattern swing.high()/.low() use. */
function gapMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = detectGaps(candles)
  if (name === 'count') return r.gaps.length
  if (!args.length) throw new MslRuntimeError(`gap.${name}(offset) needs an offset argument, e.g. gap.${name}(-1)`)
  if (!r.gaps.length) throw new MslRuntimeError('gap.*(offset) - no gaps in this window yet (most candles never gap; OTC synthetic pairs essentially never do)')
  const g = offsetInto(r.gaps, asNum(args[0]), `gap.${name}`)
  switch (name) {
    case 'direction':
      return g.dir
    case 'size':
      return g.size
    case 'filled':
      return g.filled
    case 'filledAt':
      return g.filledAt ?? 0
    default:
      throw new MslRuntimeError(`unknown gap method "gap.${name}(...)" - use count()/direction(offset)/size(offset)/filled(offset)/filledAt(offset)`)
  }
}

/** `tickbar.*` - the Tick Chart engine (analytics/tickbars.ts) previously
 * had NO MSL namespace at all (claude/msl-capability-matrix.md section P) -
 * the only access was via /tick_patterns's own pattern detection, never
 * arbitrary script use. HONEST SOURCE, same contract tickbars.ts itself
 * already documents: uses REAL ticks (dataSource 'tick') when this
 * evaluation context has a live tick feed wired in (the omni-trader via
 * ctx.liveTicks), otherwise falls back to this tf's own closed-candle
 * closes as pseudo-ticks (dataSource 'candle') - NEVER silently fabricates
 * real ticks where none exist. `tickbar.dataSource()` always tells a script
 * (or a person reading its trace) which mode is live right now. Every
 * accessor takes an optional trailing `per` argument (ticks per bar,
 * default 10, clamped 2-200 same as the engine's own default) - this is a
 * plain numeric argument, not a `configure` key, which is actually a
 * strictly BETTER fit here (every call can pick its own `per`, not just one
 * script-wide value) - so, unlike renko/pf/rangebars/volumebars/vp/dp/
 * linebreak/kagi/swing (which only ever had one fixed hardcoded default
 * until the configure-override fix - see EvalEnv.configs' doc comment),
 * tickbar.* was never missing this capability and doesn't need a
 * `tickbar.per` configure key added alongside its existing argument. */
function tickbarPoints(ctx: EvalEnv, tf: string | undefined): { points: TickPoint[]; dataSource: 'tick' | 'candle' } {
  if (ctx.liveTicks && ctx.liveTicks.length) {
    return { points: ctx.liveTicks.map((t) => ({ time: t.ts / 1000, price: t.price })), dataSource: 'tick' }
  }
  const s = requireSeries(ctx, tf)
  return { points: s.close.map((c, i) => ({ time: i, price: c })), dataSource: 'candle' }
}

function tickbarMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  if (name === 'dataSource') return tickbarPoints(ctx, tf).dataSource
  switch (name) {
    case 'bars': {
      const per = args.length >= 2 ? asNum(args[1]) : undefined
      const { points, dataSource } = tickbarPoints(ctx, tf)
      const r = tickBars(points, { per, dataSource })
      return seriesValue(r.bars.map((b) => (b.close >= b.open ? 1 : -1)).slice(-seriesLookback(args.length ? [args[0]] : [], 50)))
    }
    case 'ohlc': {
      if (!args.length) throw new MslRuntimeError('tickbar.ohlc(offset, per?) needs an offset argument, e.g. tickbar.ohlc(-1)')
      const per = args.length >= 2 ? asNum(args[1]) : undefined
      const { points, dataSource } = tickbarPoints(ctx, tf)
      const r = tickBars(points, { per, dataSource })
      const b = offsetInto(r.bars, asNum(args[0]), 'tickbar.ohlc')
      return barValueFromOHLC(b.open, b.high, b.low, b.close, b.ticks)
    }
    case 'direction': {
      const per = args.length >= 1 ? asNum(args[0]) : undefined
      const { points, dataSource } = tickbarPoints(ctx, tf)
      const r = tickBars(points, { per, dataSource })
      const last = r.bars[r.bars.length - 1]
      return last ? (last.close >= last.open ? 1 : -1) : 0
    }
    case 'duration': {
      // seconds the latest bar took to form (endTime - time) - 0 for the
      // candle-fallback mode's own integer pseudo-time, which is NOT wall-
      // clock seconds (see tickbarPoints()); dataSource() tells a script
      // which reading applies, same honesty contract the engine itself uses.
      const per = args.length >= 1 ? asNum(args[0]) : undefined
      const { points, dataSource } = tickbarPoints(ctx, tf)
      const r = tickBars(points, { per, dataSource })
      const last = r.bars[r.bars.length - 1]
      return last ? last.endTime - last.time : 0
    }
    // BUG FIX (capability-matrix section P: "avg time between ticks...
    // already computed [tickdesk.ts#medianTickGapMs], just not wired to
    // the tick-chart engine itself") - tickBars() now computes this
    // directly (reusing medianTickGapMs, not reimplementing it); this is
    // the MSL-reachability half of closing that gap. NaN (never 0 - the
    // honest "no measurable gap yet" value) with fewer than 2 points.
    case 'avgGapMs': {
      const per = args.length >= 1 ? asNum(args[0]) : undefined
      const { points, dataSource } = tickbarPoints(ctx, tf)
      const r = tickBars(points, { per, dataSource })
      return r.avgGapMs ?? NaN
    }
    default:
      throw new MslRuntimeError(`unknown tickbar method "tickbar.${name}(...)" - use bars(n?, per?)/ohlc(offset, per?)/direction(per?)/duration(per?)/dataSource()/avgGapMs(per?)`)
  }
}

/** `baseline.*` - the Baseline chart previously had NO backing analytics
 * module at all (claude/msl-capability-matrix.md section G) - see
 * analytics/baseline.ts for the definition (first close in the window). */
function baselineMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  const r = computeBaseline(candles)
  if (!r) throw new MslRuntimeError('baseline.*() needs at least 1 bar of history')
  switch (name) {
    case 'value':
      return r.baseline
    case 'deviation':
      return r.deviation
    case 'deviationPct':
      return r.deviationPct
    case 'above':
      return r.aboveBaseline
    case 'cross':
      return r.crossDirection
    case 'deviationSeries':
      return seriesValue(r.deviationSeries.slice(-seriesLookback(args, 50)))
    default:
      throw new MslRuntimeError(`unknown baseline method "baseline.${name}(...)" - use value()/deviation()/deviationPct()/above()/cross()/deviationSeries(n?) (or the plain baseline.dir/.conf verdict read)`)
  }
}

/** `ivhv.*` - realized/historical volatility, purely candle-derived
 * (analytics/ivhv.ts hvSeries/realizedUpProb). Kept lowercase `ivhv`
 * (matching the file name) to avoid any casing confusion with the separate
 * `ivHv` verdict source.
 *
 * ivNow()/ratio() (capability-matrix section Q, flagged "NOT YET BUILT
 * [both source series exist; the ratio/change/percentile derivations do
 * not]") - the raw IV accessor that was PREVIOUSLY deliberately left out:
 * breakeven()/ev()/gate() already cover the practical "is this payout
 * worth taking" arithmetic from `payout.value` directly, so a second,
 * narrower accessor felt redundant. Added now because the IV/HV RATIO
 * specifically needs a scalar IV number to divide by HV, and the plain
 * payout fraction isn't that number - ivNow() reads `ctx.reads.payout`
 * (the SAME live source `payout.value` already exposes; see
 * plugins/metastrategy.ts's own reads.payout for where that's populated -
 * no historical replay path, exactly as ivFromPayout()'s own module
 * header discloses) and runs it through ivFromPayout() to get the
 * payout-implied BREAKEVEN PROBABILITY, the closest honest IV-analog this
 * OS can compute (never "implied volatility" unqualified - see ivhv.ts's
 * header for the full ATM-digital-inversion-has-no-solution reasoning).
 * NaN (never a misleading 0) when no `payout` source was wired into this
 * evaluation (the normal case for a pure historical/backtest run) or the
 * account reports no payout. ratio() = ivNow()/hvNow() - NaN whenever
 * either side is NaN or hvNow() is 0 (never a divide-by-zero Infinity). */
function ivhvMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  switch (name) {
    case 'ivNow': {
      const payout = ctx.reads.payout?.value
      if (payout === undefined || !Number.isFinite(payout) || payout <= 0) return NaN
      const r = ivFromPayout(payout)
      return Number.isFinite(r.breakevenPct) ? r.breakevenPct : NaN
    }
    case 'ratio': {
      const payout = ctx.reads.payout?.value
      if (payout === undefined || !Number.isFinite(payout) || payout <= 0) return NaN
      const iv = ivFromPayout(payout).breakevenPct
      const window = args.length ? asNum(args[0]) : undefined
      const hv = hvSeries(candles, window !== undefined ? { window } : undefined).hvNow
      if (!Number.isFinite(iv) || !Number.isFinite(hv) || hv === 0) return NaN
      return iv / hv
    }
    case 'hvNow': {
      const window = args.length ? asNum(args[0]) : undefined
      const r = hvSeries(candles, window !== undefined ? { window } : undefined)
      return Number.isFinite(r.hvNow) ? r.hvNow : 0
    }
    case 'hvSeries': {
      const r = hvSeries(candles)
      return seriesValue(r.series.map((p) => p.hv).slice(-seriesLookback(args, 50)))
    }
    case 'realizedUpProb': {
      const window = args.length ? asNum(args[0]) : 100
      return realizedUpProb(candles, window)
    }
    case 'change': {
      const lookback = args.length ? Math.max(1, Math.round(asNum(args[0]))) : 1
      const r = hvSeries(candles)
      const series = r.series.map((p) => p.hv)
      if (!series.length) return 0
      const now = series[series.length - 1]
      const idx = series.length - 1 - lookback
      const then = idx >= 0 ? series[idx] : series[0]
      return now - then
    }
    case 'percentile': {
      const lookback = args.length ? Math.max(1, Math.round(asNum(args[0]))) : 100
      const r = hvSeries(candles)
      const series = r.series.map((p) => p.hv)
      if (!series.length) return 0
      const now = series[series.length - 1]
      const window = series.slice(-lookback)
      const below = window.filter((v) => v <= now).length
      return (below / window.length) * 100
    }
    default:
      throw new MslRuntimeError(`unknown ivhv method "ivhv.${name}(...)" - use hvNow(window?)/hvSeries(n?)/realizedUpProb(window?)/change(lookback?)/percentile(lookback?)/ivNow()/ratio(window?)`)
  }
}

/** `nearExpiry.*` - Section 9 of the original checklist (binary-options-
 * specific intelligence): expiry-aligned momentum/displacement/expected-
 * move/reversal-risk/stagnation-exhaustion, all PURE candle functions
 * (analytics/expiryintel.ts) so they replay in meta_strategy_backtest.
 * Named `nearExpiry`, not `expiry` - `expiry` is already a hard statement
 * keyword (the script-level `expiry = <numExpr>` line) and can't double as
 * an identifier. completionProb()/completionDir() are the one genuinely new
 * idea here and are an explicit documented heuristic (see expiryintel.ts's
 * own header) - never present as a measured probability. */
function nearExpiryMethod(name: string, args: MslValue[], ctx: EvalEnv, tf: string | undefined): MslValue {
  const candles = seriesToCandles(requireSeries(ctx, tf))
  switch (name) {
    case 'momentum':
      return expiryMomentum(candles, args.length ? Math.max(1, Math.round(asNum(args[0]))) : 5)
    case 'displacement':
      return priceDisplacement(candles, args.length ? Math.max(1, Math.round(asNum(args[0]))) : 5).price
    case 'displacementAtr':
      return priceDisplacement(candles, args.length ? Math.max(1, Math.round(asNum(args[0]))) : 5).atrMultiple
    case 'expectedMove':
      return volAdjustedExpectedMove(candles, args.length ? Math.max(1, Math.round(asNum(args[0]))) : 5)
    case 'reversalRisk':
      return reversalRisk(candles, args.length ? Math.max(1, Math.round(asNum(args[0]))) : 5)
    case 'stagnation':
      return expiryStagnationExhaustion(candles, args.length ? Math.max(1, Math.round(asNum(args[0]))) : 5).stagnation
    case 'exhaustion':
      return expiryStagnationExhaustion(candles, args.length ? Math.max(1, Math.round(asNum(args[0]))) : 5).exhaustion
    case 'completionProb':
    case 'completionDir': {
      // completionProb(remainingFraction)/completionDir(remainingFraction) -
      // remainingFraction (0..1) is the caller's own read of how much of
      // the current expiry/bar is left (this module takes no stance on
      // where that number comes from - a script already knows its own
      // expiry countdown). openToNow reads the CURRENTLY FORMING bar via
      // live() when available (omni-trader), else honestly falls back to
      // the last CLOSED bar's own open-to-close move (documented fallback,
      // not a forming-bar read) so this stays callable everywhere ohlc()
      // is, same as every other candle-derived namespace.
      if (!args.length) throw new MslRuntimeError(`expiry.${name}(remainingFraction) needs a remainingFraction argument (0..1)`)
      const remainingFraction = asNum(args[0])
      const openToNow = ctx.liveBar ? ctx.liveBar.c - ctx.liveBar.o : candles.length ? candles[candles.length - 1].close - candles[candles.length - 1].open : 0
      const histForAtr = ctx.liveBar ? candles : candles.slice(0, -1)
      const r = candleCompletionProbability(histForAtr, openToNow, remainingFraction)
      return name === 'completionProb' ? r.probability : r.direction
    }
    default:
      throw new MslRuntimeError(
        `unknown nearExpiry method "nearExpiry.${name}(...)" - use momentum(lookback?)/displacement(window?)/displacementAtr(window?)/expectedMove(window?)/reversalRisk(lookback?)/stagnation(window?)/exhaustion(window?)/completionProb(remainingFraction)/completionDir(remainingFraction)`,
      )
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
      // `tickfp.poc(...)` etc - the 'tickfootprint' chart type's own engine
      // (tickdesk.ts#computeTickFootprint), same omni-trader-only contract
      // (requireTicks() fails closed) as tick.*/foot.* above.
      if (e.obj.t === 'ident' && e.obj.name === 'tickfp' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        return tickfpMethod(e.name, args, requireTicks(ctx))
      }
      // `outcomeMemory.poolSize(...)` etc - dotted-method view of the SAME
      // k-NN read the bare `outcomeMemory.value`/`.conf` verdict-source
      // reads already expose; needs the closed-candle series like
      // renko.*/kagi.*/swing.* above, not the live tick buffer.
      if (e.obj.t === 'ident' && e.obj.name === 'outcomeMemory' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return outcomeMemoryMethod(e.name, args, ctx, tf)
      }
      // `signal.needle()` etc - the Signal clock (see signalMethod above).
      if (e.obj.t === 'ident' && e.obj.name === 'signal' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return signalMethod(e.name, args, ctx, tf)
      }
      // `amd.phase()` / `amd.distributing()` - accumulation / manipulation / distribution (see amdMethod above).
      if (e.obj.t === 'ident' && e.obj.name === 'amd' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return amdMethod(e.name, args, ctx, tf)
      }
      // `pv.corrRet()` / `pv.tilt()` / `pv.volumeOk()` - price / volume relationship (see pvMethod above).
      if (e.obj.t === 'ident' && e.obj.name === 'pv' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return pvMethod(e.name, args, ctx, tf)
      }
      // `smt.bearish("GBPUSD")` - SMT divergence against a partner pair (see smtMethod above). The partner string is a plain argument, never a timeframe.
      if (e.obj.t === 'ident' && e.obj.name === 'smt' && !(e.obj.name in env)) {
        return smtMethod(e.name, e.args.map((a) => evalExpr(a, env, ctx)), ctx)
      }
      // `mmxm.buy()` / `mmxm.phase()` - market maker model lifecycle (see mmxmMethod above).
      if (e.obj.t === 'ident' && e.obj.name === 'mmxm' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return mmxmMethod(e.name, args, ctx, tf)
      }
      // `smcx.eqhNear()` / `smcx.rejBull()` / `smcx.idmBull()` - equal highs/lows, rejection blocks, inducement (see smcxMethod above).
      if (e.obj.t === 'ident' && e.obj.name === 'smcx' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' && !/^(bull|bear)$/i.test(String(args[args.length - 1])) ? (args.pop() as string) : undefined
        return smcxMethod(e.name, args, ctx, tf)
      }
      // `wyckoff.phase()` / `wyckoff.spring()` - Wyckoff accumulation / distribution schematic (see wyckoffMethod above).
      if (e.obj.t === 'ident' && e.obj.name === 'wyckoff' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return wyckoffMethod(e.name, args, ctx, tf)
      }
      // `fib.level(0.618)` / `pivot.pp()` / `vol.moderate()` - structural + volatility namespaces (see fibMethod..volMethod above).
      if (e.obj.t === 'ident' && e.obj.name === 'fib' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return fibMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'pivot' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return pivotMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'vol' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return volMethod(e.name, args, ctx, tf)
      }
      // `ou.z()` / `markov.probUp()` / `stat.hurst()` / `cm.blend(3)` - model namespaces (see ouMethod..cmMethod above).
      if (e.obj.t === 'ident' && e.obj.name === 'ou' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return ouMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'markov' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return markovMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'stat' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return statMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'cm' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return cmMethod(e.name, args, ctx, tf)
      }
      // `tech.buys()` / `tech.rsi()` etc - the Technical panel's per-indicator votes (see techMethod above).
      if (e.obj.t === 'ident' && e.obj.name === 'tech' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return techMethod(e.name, args, ctx, tf)
      }
      // `pulse.tickCount(-1)` etc - same namespace-marker special case,
      // same omni-trader-only contract (requireTicks() fails closed).
      if (e.obj.t === 'ident' && e.obj.name === 'pulse' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        return pulseMethod(e.name, args, ctx, requireTicks(ctx))
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
      if (e.obj.t === 'ident' && e.obj.name === 'dp' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return dpMethod(e.name, args, ctx, tf)
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
      if (e.obj.t === 'ident' && e.obj.name === 'gap' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return gapMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'effort' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return effortMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'mrc' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return mrcMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'spring' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return springMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'echo' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return echoMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'tickbar' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return tickbarMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'baseline' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return baselineMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'ivhv' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return ivhvMethod(e.name, args, ctx, tf)
      }
      if (e.obj.t === 'ident' && e.obj.name === 'nearExpiry' && !(e.obj.name in env)) {
        const args = e.args.map((a) => evalExpr(a, env, ctx))
        const tf = args.length && typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined
        return nearExpiryMethod(e.name, args, ctx, tf)
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
        case 'log':
        case 'ln': {
          const v = asNum(args[0] ?? 0)
          if (!(v > 0)) throw new MslRuntimeError(`${e.fn}() of a non-positive number - would produce NaN/-Infinity`)
          return Math.log(v)
        }
        case 'exp': {
          const v = Math.exp(asNum(args[0] ?? 0))
          if (!Number.isFinite(v)) throw new MslRuntimeError('exp() overflowed - argument too large')
          return v
        }
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
        case 'breakeven': {
          // breakeven(payout) - the breakeven win-rate (0..1) for a given
          // payout fraction: 1/(1+payout). Section 9's payout-aware gate
          // item - previously a script had to spell this arithmetic out by
          // hand every time (see the payout source's own doc comment); now
          // a named 1-liner, no new concept, same formula.
          if (args.length !== 1) throw new MslRuntimeError(`breakeven(payout) takes exactly 1 argument, got ${args.length}`)
          const payout = asNum(args[0])
          return payout > -1 ? 1 / (1 + payout) : 1
        }
        case 'ev': {
          // ev(winProb, payout) - expected value per $1 staked at a
          // hypothetical win probability: winProb*payout - (1-winProb).
          if (args.length !== 2) throw new MslRuntimeError(`ev(winProb, payout) takes exactly 2 arguments, got ${args.length}`)
          const [winProb, payout] = args.map(asNum)
          return winProb * payout - (1 - winProb)
        }
        case 'gate': {
          // gate(winProb, payout, minEdge?) - Section 9's explicitly-flagged
          // missing primitive: "an actual payout-aware minimum-confidence-
          // threshold GATE mechanism, not just the raw payout value".
          // Returns true iff the expected value at winProb clears minEdge
          // (default 0 - plain non-negative-EV gate). A script combines this
          // with `payout.value` directly: `call when ... and gate(0.65,
          // payout.value, 0.02)` replaces hand-rolled EV arithmetic with one
          // named boolean check.
          if (args.length < 2 || args.length > 3) throw new MslRuntimeError(`gate(winProb, payout, minEdge?) takes 2 or 3 arguments, got ${args.length}`)
          const winProb = asNum(args[0])
          const payout = asNum(args[1])
          const minEdge = args.length === 3 ? asNum(args[2]) : 0
          return winProb * payout - (1 - winProb) >= minEdge
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
  // configs is declared before ctx so ctx.configs can point at the SAME
  // object the 'configure' statement branch below mutates - a namespace
  // method called by a LATER statement in this script then sees every
  // override collected so far, live, without a second pass (see
  // EvalEnv.configs' doc comment for the bug this fixes).
  const configs: Record<string, number | boolean | string> = {}
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
    configs,
  }
  const env: Record<string, MslValue> = {}
  const trace: string[] = []
  let callFired = false
  let putFired = false
  let confidenceExpr: Expr | null = null
  let expiryExpr: Expr | null = null
  try {
    const run = (stmts: Stmt[]): void => {
    for (const stmt of stmts) {
      if (stmt.kind === 'if') {
        // first true branch wins; the rest are NOT evaluated (so a guarded reading in a later branch cannot error); else runs when none matched
        let matched = false
        for (const b of stmt.branches) {
          const v = truthy(evalExpr(b.cond, env, ctx))
          trace.push(`if ${explainExpr(b.cond, env, ctx).text} -> ${v}`)
          if (v) {
            matched = true
            run(b.body)
            break
          }
        }
        if (!matched && stmt.elseBody) {
          trace.push('else')
          run(stmt.elseBody)
        }
        continue
      }
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
    }
    run(ast.stmts)
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
