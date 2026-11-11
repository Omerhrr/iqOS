// IQAIR//OS - Meta-strategy library + live source reads
// Owns the saved meta-strategy specs (analytics/metastrategy.ts's pure
// combinator) and knows how to fetch each condition source's CURRENT
// verdict for a given asset+tf from the already-running engines - the
// Next-Candle Oracle, its two secondary panel reads, Accute, Renko, and
// the SMC scanner. Nothing here recomputes a signal from scratch; it only
// reads what those services already computed for their own panels, same
// data the user is looking at.
//
// Persistence: a flat JSON library (data/meta_strategies.json), same shape
// as every other small *.json store in this codebase (smc_outcomes.json,
// leadlag_outcomes.json, ...) - this is a short, hand-curated list of
// specs, not a growing time series, so it doesn't need the Store/DB
// machinery lab.ts's much bigger learned-strategy library uses.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { Timeframe, Candle, BacktestResult, BacktestTrade } from '../types'
import type { MarketDataService } from './market-data'
import type { NextCandleService } from './nextcandle'
import type { AccuteService } from './accute'
import type { SmcScanService } from './smcscan'
import type { NextExpiryService } from './nextexpiry'
import type { OtcFootprintService } from './otcfootprint'
import type { TechnicalService } from './technical'
import type { ReversalService } from './reversal'
import type { TempoService } from './tempo'
import type { ScreenerService } from './screener'
import type { VolArbScanService } from './volarbscan'
import type { CointegrationScanService } from './cointegrationscan'
import type { ChartSignalsService } from './chartsignals'
import type { LeadLagScanService } from './leadlagscan'
import type { YesterdayService } from './yesterday'
import type { TickPoint } from '../analytics/otcfootprint'
import { ORACLE_BUCKETS_SEC, computeTickFootprint, computeTickOracle, computeTickSmc, computeTickTechnical, medianTickGapMs, type TickTechnicalResult } from '../analytics/tickdesk'
import { renkoBricks, renkoAtr } from '../analytics/renko'
import { rangeBars } from '../analytics/rangebars'
import { pointFigure } from '../analytics/pointfigure'
import { volumeBars } from '../analytics/volumebars'
import { computeTpo } from '../analytics/tpo'
import { computeVolumeProfile } from '../analytics/volumeprofile'
import { computeDeltaProfile } from '../analytics/deltaprofile'
import { lineBreak } from '../analytics/linebreak'
import { kagi } from '../analytics/kagi'
import { computeSwing } from '../analytics/swing'
import { effortBricks } from '../analytics/effortbricks'
import { computeMrc } from '../analytics/mrc'
import { computeOutcomeMemory } from '../analytics/outcomememory'
import { computePulseBars } from '../analytics/pulsebars'
import { computeBaseline } from '../analytics/baseline'
import { realizedUpProb } from '../analytics/ivhv'
import { EXPIRIES_MIN } from '../analytics/nextexpiry'
import { TECH_LADDER } from '../analytics/technicals'
import { engineVoteSingle, tickVote, otcFootprintVote, type ChartEngineVote } from '../analytics/chartsignals'
import { smcNowRead, smcAnyAgrees, ALL_SMC_KINDS } from '../analytics/smc'
import { buildFootprint, footprintAbsorption, unfinishedAuction } from '../analytics/otcfootprint'
import { ICT_KINDS, voteForKindSet } from '../analytics/chartindicators'
import { buildCtx } from '../strategies/custom'
import { makeSignalResolver } from '../strategies/signalscript'
import {
  evaluateMetaStrategy,
  META_CONDITION_SOURCES,
  type MetaConditionSource,
  type MetaEvalResult,
  type MetaSourceRead,
  type MetaStrategySpec,
} from '../analytics/metastrategy'
import { parseStrategyScript, evaluateStrategyScript, clearMslState, type MslEvalResult, type MslSourceRead, type MslSeriesCtx, type MslBarValue, type MslAst } from '../analytics/strategylang'
import { getStrategy } from '../strategies/builtin'
import { directionBreakdown } from '../strategies/backtest'
import { sharpeRatio } from '../analytics/quant'

// ---------- backtest support (safe, pure-candle subset only) ----------
//
// Most MetaConditionSource values read some OTHER plugin's LIVE-only state -
// a wall-clock-TTL-cached whole-universe scan (screener/volArb/cointegration/
// leadLag/chartSignals), a one-shot claim/license tracker (accute/tempo), or
// a raw tick buffer that is never archived (tick/footprint/otcFootprint and
// their tick-desk siblings). None of those have an honest historical replay:
// there is no archived record of "what the screener board said three weeks
// ago", and re-running those services' live scan methods during a backtest
// would not just read wrong data, it would WRITE wrong data - several of
// them (smcScan's outcome tracker, accute's claim map, nextexpiry's pending
// dedupe ledger) record every call into real accuracy/outcome stats that a
// flood of simulated historical calls would quietly corrupt.
//
// The sources below are the ones that reduce to a PURE function of this
// pair's own archived candle history, with NOTHING else live in the loop:
//  - the direct-candle cases (renko, pointFigure, rangeBars, candle/bar,
//    heikinAshi, line/area, baseline, volumeBars, tpo, ivHv, volumeProfile,
//    lineBreak, kagi, swing, deltaProfile) call market.getCandlesDeep()
//    straight through readSource() with no other plugin involved at all.
//  - technical/reversal go through TechnicalService/ReversalService, which
//    are themselves stateless (see technical.ts's stop(): "nothing to
//    flush") candle-ladder reads - their only non-candle input is a live
//    tick buffer feeding the 1s/2s/3s rungs, which backtestMeta() forces to
//    read "not ok" during replay (ladderdata.ts's gatherTicks) rather than
//    fake it, and their wall-clock TTL cache is bypassed with
//    `{ refresh: true }` via the `inReplay` flag below.
// Once market.setReplayAsof() truncates getCandlesDeep() to a historical
// cutoff (see market-data.ts), every one of these becomes correct for free.
const SAFE_BACKTEST_SOURCES = new Set<MetaConditionSource>([
  'renko', 'pointFigure', 'rangeBars', 'candle', 'bar', 'heikinAshi', 'line', 'area',
  'baseline', 'volumeBars', 'tpo', 'ivHv', 'volumeProfile', 'lineBreak', 'kagi', 'swing',
  'deltaProfile', 'technical', 'reversal', 'effort', 'mrc', 'outcomeMemory',
])

/** Every OTHER MetaConditionSource - named explicitly (rather than derived
 * as "whatever's not in SAFE_BACKTEST_SOURCES") so a script that references
 * one gets told WHICH source blocked it and why, instead of a generic
 * refusal. Kept in sync with META_CONDITION_SOURCES by the dev-time
 * assertion right below. */
const UNSAFE_BACKTEST_SOURCES = new Set<MetaConditionSource>([
  'oracle', 'hmaRocBullBear', 'momentumScore', 'accute', 'smc', 'smcNow', 'ict',
  'renkoSmc', 'renkoSmcMajority', 'tick', 'footprint', 'otcFootprint', 'tickSmc',
  'tickOracle', 'tickTechnical', 'tickFootprint', 'tempo', 'confluence', 'volArb',
  'cointegration', 'screenerRank', 'chartSignals', 'leadLag', 'yesterday', 'pulse',
  'nextExpiry', 'nextExpiryBest', 'footDivergence', 'footStackedImbalance',
  'footAbsorption', 'footUnfinishedAuction',
])
for (const s of META_CONDITION_SOURCES) {
  if (!SAFE_BACKTEST_SOURCES.has(s) && !UNSAFE_BACKTEST_SOURCES.has(s)) {
    // A new MetaConditionSource was added without deciding whether it's
    // backtestable - fail loudly at module load (dev/test time) rather
    // than silently treating it as either safe or unsafe by omission.
    throw new Error(`metastrategy.ts: condition source '${s}' is not classified in SAFE_BACKTEST_SOURCES or UNSAFE_BACKTEST_SOURCES`)
  }
}

/** Walks a parsed MSL script collecting every bare identifier used as the
 * object of a `.field` access (e.g. the `renko` in `renko.dir`) - exactly
 * the syntax the reads-map vocabulary (buildScriptReads' flat object) is
 * read through. Deliberately untyped/structural (MslAst's Expr/Stmt node
 * types aren't exported) rather than re-declaring the AST shape here - this
 * only needs to recognize the `{ t: 'field', obj: { t: 'ident', name } }`
 * shape and otherwise walk every object/array property it finds, so it
 * stays correct if the AST grows new statement/expression kinds.
 * `obj.method(args)` - the SEPARATE namespaced signal-function vocabulary
 * (ind./tick./foot./renko./pf./ha./... - see buildSignalResolver's own doc
 * comment) - is a `{ t: 'method' }` node, a different tag, so it is never
 * collected here: that vocabulary is always candle-pure (scriptResolver()/
 * scriptSeries() below read straight off market.getCandlesDeep with no
 * other plugin involved), so it needs no safety check at all. */
function collectFieldSources(ast: MslAst): Set<string> {
  const names = new Set<string>()
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n.t === 'field') {
      const obj = n.obj as Record<string, unknown> | undefined
      if (obj && obj.t === 'ident' && typeof obj.name === 'string') names.add(obj.name)
    }
    // `tick.*(...)`/`foot.*(...)` - the two namespaced signal-function
    // vocabularies that are NOT candle-pure (unlike ind./renko./pf./ha./
    // rangebars./volumebars./tpo./vp./dp./linebreak./kagi./swing./gap./
    // tickbar./baseline./ivhv./nearExpiry., which all read straight off
    // market.getCandlesDeep via scriptResolver/scriptSeries and need no
    // check at all). strategylang.ts's own evaluator dispatches these via
    // requireTicks(ctx), which fails closed with a runtime error outside a
    // live `ticks` context - harmless, but it would make backtestMeta()
    // silently return an EMPTY result (every bar's eval throws, caught,
    // treated as 'none') instead of a clear upfront rejection naming the
    // actual blocker, so they're caught here too. Mapped onto the SAME
    // names UNSAFE_BACKTEST_SOURCES already carries ('tick' / 'footprint')
    // so one classification set and one error message cover both the
    // bare-reads-map form (`tick.dir`) and this namespaced-call form
    // (`tick.delta(5)`).
    if (n.t === 'method') {
      const obj = n.obj as Record<string, unknown> | undefined
      if (obj && obj.t === 'ident' && obj.name === 'tick') names.add('tick')
      if (obj && obj.t === 'ident' && obj.name === 'foot') names.add('footprint')
      // `pulse.*(...)` - Pulse-Vector bars (analytics/pulsebars.ts), built
      // directly on the live tick buffer same as tick.*/foot.* above -
      // same reasoning, mapped onto a new 'pulse' UNSAFE_BACKTEST_SOURCES
      // entry rather than reusing 'tick' (a script that only used pulse.*
      // deserves an error naming the actual namespace that blocked it).
      if (obj && obj.t === 'ident' && obj.name === 'pulse') names.add('pulse')
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v === 'object') visit(v)
    }
  }
  for (const s of ast.stmts) visit(s)
  return names
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'strategy'
  )
}

// ---------- MSL configure whitelist ("configure them all from msl") ----------
//
// A script's "configure <key> = <value>" statements are per-script overrides
// for HOW the sources this script reads get COMPUTED (chart-engine knobs,
// the tick engines' bucket length, IV/HV window, builtin strategy params
// via strategy.<id>.<param>). They NEVER mutate live plugin state - every
// override is applied inside THIS script's own read-building, so two specs
// reading the same panel with different configure lines get different,
// both-honest reads, and the panels themselves keep their own configs.
//
// Unknown keys / out-of-range values / unknown strategy ids are a script
// ERROR (fail closed: none/0 + the reason in the trace), never silently
// ignored - a typo'd knob must not quietly read as "no override".
interface MslConfigSpec {
  min: number
  max: number
  integer?: boolean
  /** human description for the save/eval error message */
  desc: string
}
export const MSL_READ_CONFIGS: Record<string, MslConfigSpec> = {
  'renko.brick': { min: 1e-9, max: 1e9, desc: 'explicit renko brick size in price units' },
  'renko.atrPeriod': { min: 2, max: 200, integer: true, desc: 'renko ATR brick period' },
  'renko.atrMult': { min: 0.05, max: 20, desc: 'renko ATR brick multiplier' },
  'range.range': { min: 1e-9, max: 1e9, desc: 'explicit range-bar size in price units' },
  'range.atrPeriod': { min: 2, max: 200, integer: true, desc: 'range-bar ATR period' },
  'range.atrMult': { min: 0.05, max: 20, desc: 'range-bar ATR multiplier' },
  'pf.boxSize': { min: 1e-9, max: 1e9, desc: 'explicit P&F box size in price units' },
  'pf.atrPeriod': { min: 2, max: 200, integer: true, desc: 'P&F ATR box period' },
  'pf.atrMult': { min: 0.05, max: 20, desc: 'P&F ATR box multiplier' },
  'pf.reversalBoxes': { min: 1, max: 10, integer: true, desc: 'P&F reversal boxes' },
  'volbar.per': { min: 1e-9, max: 1e12, desc: 'volume per constant-volume bar' },
  'tpo.periodSec': { min: 60, max: 86400, integer: true, desc: 'TPO profile period (seconds)' },
  'tpo.binCount': { min: 5, max: 200, integer: true, desc: 'TPO profile bin count' },
  'ivhv.window': { min: 10, max: 500, integer: true, desc: 'IV/HV realized up-close window (bars)' },
  'tickSmc.bucketSec': { min: 1, max: 3600, integer: true, desc: 'tick SMC bucket length (seconds)' },
  'tickOracle.bucketSec': { min: 1, max: 3600, integer: true, desc: 'tick oracle bucket length (seconds)' },
  'tickTechnical.bucketSec': { min: 1, max: 3600, integer: true, desc: 'tick technical bucket length (seconds)' },
  'tickFootprint.bucketSec': { min: 1, max: 3600, integer: true, desc: 'tick footprint bucket length (seconds)' },
  // Section 10 audit fix: these were added alongside their readSource()
  // cases in Phases 5-7 but never added to this whitelist - a script's own
  // "configure vp.binCount = 30" would have failed closed with "unknown
  // key" at save AND eval time despite the underlying engine already
  // honoring the override via cfgNum(). Closing that gap here.
  'vp.binCount': { min: 5, max: 200, integer: true, desc: 'Volume Profile bin count' },
  'linebreak.lines': { min: 2, max: 10, integer: true, desc: 'Three-Line-Break reversal line count' },
  'kagi.reversal': { min: 1e-9, max: 1e9, desc: 'explicit Kagi reversal size in price units' },
  'kagi.atrPeriod': { min: 2, max: 200, integer: true, desc: 'Kagi ATR reversal period' },
  'kagi.reversalAtrMult': { min: 0.05, max: 20, desc: 'Kagi ATR reversal multiplier' },
  'swing.lookback': { min: 1, max: 20, integer: true, desc: 'swing fractal-pivot lookback (bars each side)' },
  'footstack.n': { min: 1, max: 20, integer: true, desc: 'footStackedImbalance consecutive-bucket count' },
  'footstack.ratio': { min: 1.01, max: 50, desc: 'footStackedImbalance diagonal-imbalance ratio threshold' },
  'footstack.bucketSec': { min: 5, max: 3600, integer: true, desc: 'footStackedImbalance bucket length (seconds)' },
  // Footprint-completion sweep: closes the configure-override gap this
  // tracker flagged for every candle-derived namespace's own internal
  // sizing (renko/pf/range/volbar/vp/linebreak/kagi/swing already had
  // whitelist entries above - they just weren't wired into strategylang.ts's
  // own raw namespace calls until now; see EvalEnv.configs' doc comment
  // there). dp.binCount is the one genuinely NEW key - Delta Profile didn't
  // exist before this sweep.
  'dp.binCount': { min: 5, max: 200, integer: true, desc: 'Delta Profile bin count' },
  // Effort Bricks (analytics/effortbricks.ts) - same renko.*-style knobs for
  // brick sizing, plus the two knobs unique to this engine: how strict the
  // participation-confirmation gate is (effort.mult) and how many trailing
  // bricks its regime/trailing-average reads look back over (effort.lookback).
  'effort.brick': { min: 1e-9, max: 1e9, desc: 'explicit effort-brick size in price units' },
  'effort.atrPeriod': { min: 2, max: 200, integer: true, desc: 'effort-brick ATR period' },
  'effort.atrMult': { min: 0.05, max: 20, desc: 'effort-brick ATR multiplier' },
  'effort.mult': { min: 0.1, max: 20, desc: 'effort-brick participation multiplier threshold (a brick confirms when its effortRatio clears this)' },
  'effort.lookback': { min: 2, max: 100, integer: true, desc: 'effort-brick trailing average / regime lookback (bricks)' },
  // Market Response Chart (analytics/mrc.ts) - the three event-trigger knobs
  // plus the trailing-average lookback its response/activity reads use.
  'mrc.priceMult': { min: 0.5, max: 200, desc: 'MRC price-event threshold, as a multiple of the trailing average single-step move' },
  'mrc.activityMult': { min: 0.1, max: 1e6, desc: 'MRC activity-event bootstrap threshold, before enough bars exist for a trailing average' },
  'mrc.maxDuration': { min: 1, max: 86400, desc: 'MRC time-safeguard: force-close a bar after this many seconds with no price/activity trigger' },
  'mrc.maxGapMult': { min: 1.5, max: 1000, desc: 'MRC dead-time guard: a recording gap bigger than this multiple of the base sampling interval force-closes the current bar as dataGap' },
  'mrc.lookback': { min: 2, max: 100, integer: true, desc: 'MRC trailing response_efficiency/activity-threshold lookback (bars)' },
  // Historical Outcome Memory (analytics/outcomememory.ts) - the k-NN search
  // knobs. 'memory.expiry' is in BARS of the condition's own tf (not
  // minutes - this engine has no minute-native requirement the way the
  // Next-Expiry Oracle does), matching how every other bar-offset-based
  // engine in this file already counts.
  'memory.expiry': { min: 1, max: 500, integer: true, desc: 'Outcome Memory: settlement horizon in bars of the condition tf' },
  'memory.k': { min: 3, max: 200, integer: true, desc: 'Outcome Memory: number of nearest historical matches to draw' },
  'memory.lookback': { min: 100, max: 10000, integer: true, desc: 'Outcome Memory: how many trailing bars to search for candidates' },
  'memory.minPool': { min: 3, max: 500, integer: true, desc: 'Outcome Memory: minimum comparable (same-session) pool size before trusting a read' },
  // Pulse-Vector bars (analytics/pulsebars.ts) - fixed micro-interval width
  // and the sparse-bar floor.
  'pulse.interval': { min: 1, max: 300, integer: true, desc: 'Pulse-Vector bar width in seconds (fixed micro-interval, not adaptive)' },
  'pulse.sparseFloor': { min: 1, max: 100, integer: true, desc: 'Pulse-Vector: a bar built from fewer than this many ticks is flagged sparse' },
}

/** Validates a collected configure map against the whitelist. Throws with a
 * human message on the FIRST bad key (fail closed - the whole script errors,
 * same as a syntax error). `strategy.<id>.<param>` keys are validated
 * structurally + by strategy existence; the param NAME itself is whatever
 * the strategy's own evaluate() understands (custom.ts clamps values). */
export function validateMslConfigs(configs: Record<string, number | boolean | string>): void {
  for (const [k, v] of Object.entries(configs)) {
    if (k.startsWith('strategy.')) {
      const rest = k.slice('strategy.'.length)
      const dot = rest.indexOf('.')
      if (dot <= 0 || dot === rest.length - 1 || rest.slice(dot + 1).includes('.')) {
        throw new Error(`configure ${k}: expected strategy.<id>.<param> (e.g. strategy.ema-cross.fast = 5)`)
      }
      const id = rest.slice(0, dot)
      if (!getStrategy(id)) throw new Error(`configure ${k}: unknown builtin strategy "${id}"`)
      if (typeof v === 'boolean') throw new Error(`configure ${k}: strategy params are numbers or strings, not booleans`)
      continue
    }
    const spec = MSL_READ_CONFIGS[k]
    if (!spec) throw new Error(`configure ${k}: unknown key - valid keys: ${Object.keys(MSL_READ_CONFIGS).join(', ')} (or strategy.<id>.<param> for a builtin strategy's params)`)
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`configure ${k}: ${spec.desc} must be a finite number, got "${String(v)}"`)
    const val = spec.integer ? Math.round(v) : v
    if (val < spec.min || val > spec.max) throw new Error(`configure ${k}: ${spec.desc} must be ${spec.min}..${spec.max}${spec.integer ? ' (whole)' : ''}, got ${v}`)
  }
}

/** Numeric getter for an applied config map - returns undefined when the key
 * is absent; callers pass the value straight into the engine opts. */
function cfgNum(cfg: Record<string, number | boolean | string> | undefined, key: string): number | undefined {
  const v = cfg?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Defensive, same reasoning as lab.ts's save(): collapse a repeated
 * "meta:meta:..." prefix so an id that already looks saved doesn't go
 * undeployable. */
function normalizeMetaId(id: string): string {
  return id.toLowerCase().replace(/^(?:meta:)+/, 'meta:')
}

export class MetaStrategyService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private specs = new Map<string, MetaStrategySpec>()
  private libPath = join(process.cwd(), 'data', 'meta_strategies.json')
  // Set only for the duration of backtestMeta()'s own replay loop - lets
  // the 'technical'/'reversal' cases below bypass TechnicalService's and
  // ReversalService's wall-clock TTL cache (`{ refresh: true }`), which
  // would otherwise serve the SAME cached row for every simulated bar a
  // real backtest moves through in a few milliseconds of actual wall time.
  private inReplay = false

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.load()
    ctx.log('meta-strategy', `meta-strategy library online (${this.specs.size} saved, sources: ${META_CONDITION_SOURCES.join('/')})`)
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.libPath, 'utf8')) as { specs?: MetaStrategySpec[] }
      for (const spec of raw.specs ?? []) this.specs.set(spec.id, spec)
    } catch {
      /* no file yet - start clean */
    }
  }

  private persist(): void {
    try {
      mkdirSync(join(process.cwd(), 'data'), { recursive: true })
      writeFileSync(this.libPath, JSON.stringify({ savedAt: Date.now(), specs: [...this.specs.values()] }))
    } catch {
      /* persistence is best-effort - the in-memory library still works this run */
    }
  }

  list(): MetaStrategySpec[] {
    return [...this.specs.values()].sort((a, b) => (b.updatedTs ?? 0) - (a.updatedTs ?? 0))
  }

  get(id: string): MetaStrategySpec | null {
    return this.specs.get(normalizeMetaId(id)) ?? null
  }

  isValidStrategyId(id: string): boolean {
    return id.startsWith('meta:') && this.specs.has(normalizeMetaId(id))
  }

  /** Public snapshot of the most decision-relevant panel reads for one pair -
   * exposes the same readSource() this service already uses to build Meta-
   * Strategy conditions and MSL script reads, so any OTHER consumer that
   * wants "what do our panels currently say about this pair" (the AI Trader's
   * market-analysis prompt, say) gets the identical reads a human flipping
   * through the panels would see, instead of a second reimplementation that
   * could drift from this one.
   *
   * Includes EACH of the 15 individual SMC concepts on its own (FVG, Order
   * Block, Breaker Block, Liquidity Sweep, BOS, CHoCH, OTE, KRM, Supply/
   * Demand, Support/Resistance, Breakout, CRT, Power of 3, Silver Bullet),
   * not just the aggregate smc/smcNow "did anything agree" reads above - per
   * direct instruction ("what about all the smcs?"). The aggregate reads can
   * hide a concept that's firing a cleaner read than whichever one happened
   * to win the aggregate vote, so the AI Trader's desk gets to see each one
   * by name, the same way Meta Trader's SMC_KIND_SOURCE can target one
   * specific concept instead of only the "any" read.
   *
   * ALSO includes every chart-TYPE source (candle, heikin ashi, volume bars,
   * tpo, iv-hv, line, and the four tick-desk engines) - per direct
   * instruction the AI Trader must see the FULL chart surface ("full tick
   * chart analysis, footprint, OTC footprint, renko, range, line, p&f,
   * heiken ashi, IVHV, volume and so on"), so the desk grid now reads every
   * chart type this OS renders, not just the headline predictors. Only
   * area/baseline stay out - they are the SAME math as 'line' (one close-only
   * reduction, three names) and would just triple one voice in the desk
   * tally; the MSL script map below still exposes them by name. */
  snapshotSources(asset: string, tf: Timeframe): MetaSourceRead[] {
    const sources: MetaConditionSource[] = [
      'oracle', 'hmaRocBullBear', 'momentumScore', 'nextExpiry', 'accute', 'renko',
      'smc', 'smcNow', 'renkoSmc', 'renkoSmcMajority', 'pointFigure', 'rangeBars',
      'candle', 'heikinAshi', 'volumeBars', 'tick', 'footprint', 'tpo', 'ivHv', 'line',
      'tickSmc', 'tickOracle', 'tickTechnical', 'tickFootprint',
      'technical', 'reversal', 'tempo', 'confluence', 'volArb', 'cointegration', 'effort', 'mrc', 'outcomeMemory', 'pulse',
    ]
    const base = sources.map((s) => this.readSource(s, asset, tf))
    const perSmcConcept = ALL_SMC_KINDS.map((kind) => this.readSource('smcNow', asset, tf, kind))
    return [...base, ...perSmcConcept]
  }

  /** Save (or overwrite) a spec. Two ways to build one, per direct
   * instruction ("let's create our own strategy language, that we can use
   * to achieve almost everything" instead of hand-written JSON):
   *   - conditions-built (the default, simple path): validates every
   *     condition's source is one META_CONDITION_SOURCES actually
   *     supports, and requires at least one condition - a meta-strategy
   *     with zero conditions can never fire, which is almost certainly a
   *     mistake, not an intentional "always off" spec (use the
   *     auto-trader's own enabled toggle for that).
   *   - script-built: a Meta Strategy Lab script (analytics/
   *     strategylang.ts). Parsed HERE, at save time, not deferred to the
   *     trading loop - a script with a syntax error (or missing the
   *     required "call when"/"put when") is rejected on save so it can
   *     never silently sit there doing nothing once wired into Meta
   *     Trader or the auto-trader.
   * A spec needs exactly one of the two - script, when provided (even as
   * an empty-ish string that still parses), takes priority and conditions
   * become inert history (see evaluate()'s branch below). */
  save(input: {
    id?: string
    name: string
    mode: 'all' | 'any' | 'weighted'
    threshold?: number
    conditions: MetaStrategySpec['conditions']
    script?: string
  }): { ok: boolean; id: string; spec: MetaStrategySpec } {
    const name = String(input.name ?? 'Meta Strategy').slice(0, 60)
    const script = typeof input.script === 'string' && input.script.trim() ? input.script : undefined
    if (script) {
      const parsed = parseStrategyScript(script)
      if (!parsed.ok) throw new Error(`strategy script error: ${parsed.error}`)
      // configure statements: validate the PATHS statically here (values may
      // be dynamic expressions - their ranges are re-checked at every eval,
      // see evaluateScript's two-pass flow). A typo'd knob or unknown
      // strategy id is rejected on save, so it can never sit in the library
      // failing silently every cycle.
      for (const stmt of parsed.ast.stmts) {
        if (stmt.kind !== 'configure') continue
        if (stmt.path.startsWith('strategy.')) {
          const rest = stmt.path.slice('strategy.'.length)
          const dot = rest.indexOf('.')
          if (dot <= 0 || dot === rest.length - 1 || rest.slice(dot + 1).includes('.')) throw new Error(`strategy script error: configure ${stmt.path}: expected strategy.<id>.<param> (e.g. strategy.ema-cross.fast = 5)`)
          if (!getStrategy(rest.slice(0, dot))) throw new Error(`strategy script error: configure ${stmt.path}: unknown builtin strategy "${rest.slice(0, dot)}"`)
        } else if (!MSL_READ_CONFIGS[stmt.path]) {
          throw new Error(`strategy script error: configure ${stmt.path}: unknown key - valid: ${Object.keys(MSL_READ_CONFIGS).join(', ')} (or strategy.<id>.<param> for a builtin strategy's params)`)
        }
      }
    } else {
      if (!Array.isArray(input.conditions) || !input.conditions.length) throw new Error('a meta-strategy needs at least one condition (or a strategy script)')
      for (const c of input.conditions) {
        if (!META_CONDITION_SOURCES.includes(c.source as MetaConditionSource)) throw new Error(`unknown condition source "${c.source}" - must be one of ${META_CONDITION_SOURCES.join(', ')}`)
        if (c.direction !== 'call' && c.direction !== 'put' && c.direction !== 'either') throw new Error(`condition direction must be 'call'/'put'/'either', got "${c.direction}"`)
        if (c.source === 'smcNow' && c.smcKind !== undefined && !(ALL_SMC_KINDS as readonly string[]).includes(c.smcKind))
          throw new Error(`unknown smcKind "${c.smcKind}" - must be one of ${ALL_SMC_KINDS.join(', ')}`)
        if (c.source === 'nextExpiry' && c.expiryMin !== undefined && !(EXPIRIES_MIN as readonly number[]).includes(c.expiryMin))
          throw new Error(`nextExpiry expiryMin must be one of ${EXPIRIES_MIN.join('/')} (minutes), got "${c.expiryMin}"`)
        if (c.tickBucketSec !== undefined) {
          if (!['tickSmc', 'tickOracle', 'tickTechnical', 'tickFootprint'].includes(c.source))
            throw new Error(`tickBucketSec is only meaningful on the tick-desk sources (tickSmc/tickOracle/tickTechnical/tickFootprint), not "${c.source}"`)
          const b = Math.round(Number(c.tickBucketSec))
          if (!Number.isFinite(b) || b < 1 || b > 3600) throw new Error(`tickBucketSec must be a whole number of seconds 1..3600, got "${c.tickBucketSec}"`)
          c.tickBucketSec = b
        }
        if (c.op !== undefined && !(['>=', '>', '<=', '<', '==', '!='] as const).includes(c.op))
          throw new Error(`condition op must be one of >=, >, <=, <, ==, !=, got "${c.op}"`)
      }
    }
    const mode = input.mode === 'any' || input.mode === 'weighted' ? input.mode : 'all'
    const id = normalizeMetaId(input.id?.trim() || `meta:${slugify(name)}`)
    const existing = this.specs.get(id)
    const spec: MetaStrategySpec = {
      id,
      name,
      mode,
      threshold: mode === 'weighted' ? Math.max(0, Math.min(100, input.threshold ?? 60)) : undefined,
      conditions: Array.isArray(input.conditions)
        ? input.conditions.map((c) => ({ source: c.source, direction: c.direction, minConfidence: c.minConfidence, weight: c.weight, smcKind: c.smcKind, op: c.op, expiryMin: c.expiryMin, tickBucketSec: c.tickBucketSec }))
        : [],
      script,
      createdTs: existing?.createdTs ?? Date.now(),
      updatedTs: Date.now(),
    }
    this.specs.set(id, spec)
    // `since()`/`streak()` memory is scoped by this spec's OWN id (see
    // evaluateScript's `state.keyPrefix` below) - a re-save (even just
    // editing other statements, not the counters themselves) means the
    // script's logic may have changed underneath those counters, so clear
    // them rather than let an edited script silently resume counting from
    // its previous version's history.
    if (script) clearMslState(id)
    this.persist()
    this.ctx.bus.emit('alert', {
      level: 'success',
      message: `[meta-strategy] "${name}" saved as ${id} (${script ? 'script' : `${mode}, ${spec.conditions.length} condition(s)`})`,
      ts: Math.floor(Date.now() / 1000),
    })
    return { ok: true, id, spec }
  }

  remove(id: string): { ok: boolean; error?: string } {
    const ok = this.specs.delete(normalizeMetaId(id))
    if (ok) this.persist()
    return ok ? { ok } : { ok, error: 'meta-strategy not found' }
  }

  /** Current verdict for ONE condition source on one asset+tf - this is
   * the only place that reaches into the live engines. Returns a 'none'
   * read (never throws) when the underlying service isn't loaded or the
   * pair has too little history - a meta-strategy should fail OPEN into
   * "this condition didn't pass" the same way every other source here
   * does on thin history, not crash the whole evaluation. */
  /** Current Renko trend as a call/put/none read, shared by the 'renko'
   * condition source and the 'renkoSmc' confluence read below - kept as
   * one small helper so both read the exact same bricks the same way. */
  private renkoDirectionRead(asset: string, tf: Timeframe, cfg?: Record<string, number | boolean | string>): { direction: 'call' | 'put' | 'none'; confidence: number; streak: number; trend: 'up' | 'down' | 'none' } {
    const candles = this.market.getCandlesDeep(asset, tf, 300, true)
    const r = renkoBricks(candles, {
      ...(cfgNum(cfg, 'renko.brick') !== undefined ? { brickSize: cfgNum(cfg, 'renko.brick') } : {}),
      ...(cfgNum(cfg, 'renko.atrPeriod') !== undefined ? { atrPeriod: cfgNum(cfg, 'renko.atrPeriod') } : {}),
      ...(cfgNum(cfg, 'renko.atrMult') !== undefined ? { atrMult: cfgNum(cfg, 'renko.atrMult') } : {}),
    })
    if (r.trend === 'none') return { direction: 'none', confidence: 0, streak: 0, trend: 'none' }
    const direction = r.trend === 'up' ? 'call' : 'put'
    const confidence = Math.min(100, 40 + r.streak * 12)
    return { direction, confidence, streak: r.streak, trend: r.trend }
  }

  /** The raw micro-tick buffer for one asset (the otc-footprint collector's
   * own per-asset store - sim = the kernel engine's ~1s prints, live = the
   * sidecar's 100ms price-change captures), the SAME buffer every Tick Desk
   * panel reads. Returns null when the collector isn't loaded; every tick-
   * desk source read then reports its honest warming note instead of
   * guessing off candles. */
  private tickBuffer(asset: string): TickPoint[] | null {
    try {
      const ofp = this.ctx.use<OtcFootprintService>('otcFootprint')
      return ofp.ticksFor(asset)
    } catch {
      return null
    }
  }

  /** 'tickTechnical' reduction: pick the pinned bucket's ladder row (or, when
   * unpinned, the best-rated ok bucket - strongest |net| wins, ties favor the
   * FASTER bucket because a newer read is worth more) and turn its
   * strong-buy..strong-sell summary into a call/put/none read with the same
   * 40+net*100 confidence convention the other streak sources use. */
  private tickTechnicalRead(asset: string, bucketSec?: number): { direction: 'call' | 'put' | 'none'; confidence: number; label: string } {
    const ticks = this.tickBuffer(asset)
    if (!ticks) return { direction: 'none', confidence: 0, label: 'tick technical: no tick collector loaded yet' }
    const opts = bucketSec !== undefined ? { bucketsSec: [bucketSec], detailBucketSec: bucketSec } : {}
    const res = computeTickTechnical(ticks, opts)
    const ok = res.buckets.filter((b) => b.ok)
    if (!ok.length) return { direction: 'none', confidence: 0, label: `tick technical: ${res.note ?? 'warming up'}` }
    const netOf = (b: TickTechnicalResult['buckets'][number]) => {
      const total = b.summary.buy + b.summary.sell
      return total > 0 ? (b.summary.buy - b.summary.sell) / total : 0
    }
    const pick = bucketSec !== undefined
      ? ok.find((b) => b.bucketSec === bucketSec)
      : ok.reduce((best, b) => (Math.abs(netOf(b)) > Math.abs(netOf(best)) ? b : best), ok[0])
    if (!pick) return { direction: 'none', confidence: 0, label: `tick technical: ${bucketSec}s bucket still warming up` }
    const net = netOf(pick)
    const rating = pick.summary.rating
    const direction = net >= 0.2 ? 'call' : net <= -0.2 ? 'put' : 'none'
    const cadence = medianTickGapMs(ticks)
    const label = direction === 'none'
      ? `tick technical ${pick.label}: ${rating} (osc ${pick.osc.buy}/${pick.osc.sell}/${pick.osc.neutral}, ma ${pick.mas.buy}/${pick.mas.sell}/${pick.mas.neutral} - neutral band)`
      : `tick technical ${pick.label}: ${rating} (osc ${pick.osc.buy}/${pick.osc.sell}/${pick.osc.neutral}, ma ${pick.mas.buy}/${pick.mas.sell}/${pick.mas.neutral}, net ${(net * 100).toFixed(0)}%${cadence != null ? `, ${cadence}ms cadence` : ''})`
    return { direction, confidence: Math.min(100, Math.round(40 + Math.abs(net) * 100)), label }
  }

  private readSource(source: MetaConditionSource, asset: string, tf: Timeframe, smcKind?: string, expiryMin?: number, tickBucketSec?: number, cfg?: Record<string, number | boolean | string>): MetaSourceRead {
    const none = (label: string): MetaSourceRead => ({ source, direction: 'none', confidence: 0, label })
    try {
      switch (source) {
        case 'oracle': {
          const oracle = this.ctx.use<NextCandleService>('nextcandle')
          const pred = oracle.predict(asset, tf)
          if (!pred || pred.direction === 'none') return none('Oracle: no lean')
          return { source, direction: pred.direction, confidence: pred.confidence, label: `Oracle ${pred.direction.toUpperCase()} ${pred.confidence.toFixed(0)}%` }
        }
        case 'hmaRocBullBear': {
          const oracle = this.ctx.use<NextCandleService>('nextcandle')
          const alt = oracle.predict(asset, tf)?.altPrediction
          if (!alt || alt.direction === 'none') return none('HMA/ROC/Bull-Bear: no lean')
          return { source, direction: alt.direction, confidence: alt.strength, label: `HMA/ROC/Bull-Bear ${alt.direction.toUpperCase()} ${alt.strength.toFixed(0)}%` }
        }
        case 'momentumScore': {
          const oracle = this.ctx.use<NextCandleService>('nextcandle')
          const mom = oracle.predict(asset, tf)?.momentumPrediction
          if (!mom || mom.direction === 'none') return none('Momentum Score: no lean')
          return { source, direction: mom.direction, confidence: mom.strength, label: `Momentum Score ${mom.direction.toUpperCase()} ${mom.strength.toFixed(0)}%` }
        }
        case 'nextExpiry': {
          // The Next-Expiry Oracle's own fused read (plugins/nextexpiry.ts),
          // same data its panel renders. Minute-native by design - the ladder
          // is 1/2/3/5/15 minutes over the 1m base - so this read
          // deliberately ignores the condition's tf exactly the way its own
          // panel and global board do. Two shapes:
          //   - expiryMin set -> that specific rung's LIVE read; a rung still
          //     warming up (ok:false) or sitting in its deadband (direction
          //     'none') reads as none - a warming rung makes no claim, so a
          //     meta condition pinned to it cannot pass, never guesses.
          //   - expiryMin unset -> the oracle's single best pick, which the
          //     ENGINE already gated (pWin >= 0.56 AND confidence >= 25, else
          //     honest null = "wait" -> none). No second gate here on
          //     purpose: duplicating floors would just drift from the panel.
          const expiryOracle = this.ctx.use<NextExpiryService>('nextexpiry')
          const pred = expiryOracle.predict(asset)
          if (!pred) return none('Expiry oracle: no read (thin 1m history)')
          if (expiryMin !== undefined) {
            const rung = pred.rows.find((r) => r.expiry === expiryMin)
            if (!rung || !rung.ok) return none(`Expiry oracle ${expiryMin}m: warming up`)
            if (rung.direction === 'none') return none(`Expiry oracle ${expiryMin}m: ${rung.note}`)
            return { source, direction: rung.direction, confidence: rung.confidence, value: rung.pWin, label: `Expiry ${expiryMin}m ${rung.direction.toUpperCase()} ${rung.confidence.toFixed(0)}% (pWin ${(rung.pWin * 100).toFixed(0)}%)` }
          }
          if (!pred.best) return none(`Expiry oracle: wait - ${pred.note}`)
          return { source, direction: pred.best.direction, confidence: pred.best.confidence, value: pred.best.pWin, label: `Expiry oracle ${pred.best.expiry}m ${pred.best.direction.toUpperCase()} ${pred.best.confidence.toFixed(0)}% (pWin ${(pred.best.pWin * 100).toFixed(0)}%)` }
        }
        case 'nextExpiryBest': {
          // VALUE-ONLY companion to 'nextExpiry' above - same fused best
          // pick, but .value is WHICH rung (minutes) was picked, not pWin.
          // See MetaConditionSource's own doc comment for why this gets its
          // own source rather than overloading nextExpiry's .value field.
          const expiryOracle = this.ctx.use<NextExpiryService>('nextexpiry')
          const pred = expiryOracle.predict(asset)
          if (!pred?.best) return none(pred ? `Expiry oracle: wait - ${pred.note}` : 'Expiry oracle: no read (thin 1m history)')
          return {
            source,
            direction: pred.best.direction,
            confidence: pred.best.confidence,
            value: pred.best.expiry,
            label: `Expiry oracle's best pick is the ${pred.best.expiry}m rung (${pred.best.direction.toUpperCase()} ${pred.best.confidence.toFixed(0)}%)`,
          }
        }
        case 'accute': {
          const accute = this.ctx.use<AccuteService>('accute')
          const sig = accute.signal(asset, tf)
          if (!sig.ok || sig.direction === 'none') return none('Accute: no lean')
          return { source, direction: sig.direction, confidence: sig.confidence, label: `Accute ${sig.direction.toUpperCase()} ${sig.confidence.toFixed(0)}%` }
        }
        case 'renko': {
          // Renko has no native 0-100 confidence - streak length is the
          // honest proxy (a 1-brick flip is barely a lean, a long streak
          // reads as conviction), same scaling AccuteRenkoRead's own label
          // implies without putting a number on it. Capped at 10 bricks:
          // deeper streaks all read the same "committed trend" story.
          // `.value` = the SIGNED streak (+up/-down) so an MSL script can
          // threshold raw commitment (renko.value >= 3) without re-parsing
          // the label.
          const r = this.renkoDirectionRead(asset, tf, cfg)
          if (r.direction === 'none') return none('Renko: no bricks painted yet')
          const signedStreak = r.direction === 'call' ? r.streak : -r.streak
          return { source, direction: r.direction, confidence: r.confidence, value: signedStreak, label: `Renko ${r.streak} ${r.trend.toUpperCase()} brick(s)${cfg ? ' [configured]' : ''}` }
        }
        case 'smc': {
          const smc = this.ctx.use<SmcScanService>('smcScan')
          const resp = smc.scan(asset, tf)
          const summary = resp.result?.summary
          if (!summary || summary.direction === 'none') return none('SMC: no lean')
          return { source, direction: summary.direction, confidence: summary.confidence, label: `SMC ${summary.direction.toUpperCase()} ${summary.confidence.toFixed(0)}%` }
        }
        case 'smcNow': {
          // "any of the smcs" per direct instruction - the aggregate "now"
          // read (every concept except Support & Resistance, barsAgo===0
          // only - same read Meta Trader's plain 'smc' source trades) by
          // default, or ONE concept via this condition's smcKind field,
          // same smcNowRead() both share (analytics/smc.ts).
          const smc = this.ctx.use<SmcScanService>('smcScan')
          const resp = smc.scan(asset, tf)
          if (!resp.result) return none('SMC now: no scan result yet')
          const kind = smcKind && (ALL_SMC_KINDS as readonly string[]).includes(smcKind) ? (smcKind as (typeof ALL_SMC_KINDS)[number]) : undefined
          const read = smcNowRead(resp.result, kind)
          if (read.direction === 'none') return none(`SMC now${kind ? ` (${kind})` : ''}: ${read.note}`)
          return { source, direction: read.direction, confidence: read.confidence, label: `SMC now${kind ? ` ${kind}` : ''} ${read.direction.toUpperCase()} - ${read.note}` }
        }
        case 'ict': {
          // Splits the SAME scan 'smc'/'smcNow' above already read into just
          // the ICT-originated concepts (analytics/chartindicators.ts's
          // ICT_KINDS, reused here rather than redefined) - never re-scans.
          const smc = this.ctx.use<SmcScanService>('smcScan')
          const resp = smc.scan(asset, tf)
          if (!resp.result) return none('ICT: no scan result yet')
          const row = voteForKindSet(resp.result, ICT_KINDS, 'ict', 'ICT')
          if (row.direction === 'none') return none(`ICT: ${row.note}`)
          return { source, direction: row.direction, confidence: row.confidence, label: `ICT ${row.direction.toUpperCase()} - ${row.note}` }
        }
        case 'pointFigure': {
          // "not just renko, p&f, range and all others as we see fit" per
          // direct instruction - Point & Figure has no native streak the
          // way Renko/range bars do (a column grows by boxes, not bars),
          // so the confidence proxy is the current column's own box count,
          // same `40 + n*12` capped-100 scaling convention as Renko -
          // more boxes painted in the live column reads as more committed
          // than a column that just flipped.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const pf = pointFigure(candles, {
            ...(cfgNum(cfg, 'pf.boxSize') !== undefined ? { boxSize: cfgNum(cfg, 'pf.boxSize') } : {}),
            ...(cfgNum(cfg, 'pf.atrPeriod') !== undefined ? { atrPeriod: cfgNum(cfg, 'pf.atrPeriod') } : {}),
            ...(cfgNum(cfg, 'pf.atrMult') !== undefined ? { atrMult: cfgNum(cfg, 'pf.atrMult') } : {}),
            ...(cfgNum(cfg, 'pf.reversalBoxes') !== undefined ? { reversalBoxes: cfgNum(cfg, 'pf.reversalBoxes') } : {}),
          })
          if (!pf.lastDir) return none('Point & Figure: no column painted yet')
          const direction = pf.lastDir === 'X' ? 'call' : 'put'
          const liveBoxes = pf.columns.length ? pf.columns[pf.columns.length - 1].boxes : 0
          const confidence = Math.min(100, 40 + liveBoxes * 12)
          const breakout = pf.pattern && pf.pattern.direction === direction ? ` - ${pf.pattern.name}` : ''
          return { source, direction, confidence, value: direction === 'call' ? liveBoxes : -liveBoxes, label: `P&F ${pf.lastDir} column, ${liveBoxes} box(es)${breakout}` }
        }
        case 'rangeBars': {
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const rb = rangeBars(candles, {
            ...(cfgNum(cfg, 'range.range') !== undefined ? { range: cfgNum(cfg, 'range.range') } : {}),
            ...(cfgNum(cfg, 'range.atrPeriod') !== undefined ? { atrPeriod: cfgNum(cfg, 'range.atrPeriod') } : {}),
            ...(cfgNum(cfg, 'range.atrMult') !== undefined ? { atrMult: cfgNum(cfg, 'range.atrMult') } : {}),
          })
          if (rb.trend === 'none') return none('Range bars: no bars painted yet')
          const direction = rb.trend === 'up' ? 'call' : 'put'
          const confidence = Math.min(100, 40 + rb.streak * 12)
          return { source, direction, confidence, value: direction === 'call' ? rb.streak : -rb.streak, label: `Range bars ${rb.streak} ${rb.trend.toUpperCase()} bar(s)` }
        }
        case 'candle':
        case 'bar': {
          // "support all charts" per direct instruction - 'bar' is the SAME
          // OHLC data as 'candle' (just rendered differently, no distinct
          // math), so both share the chart-engine committee's own
          // candleVote via engineVoteSingle('candle', ...) - the identical
          // math the Signal Panel/Oracle "chart engines" driver already
          // uses, not a reimplementation.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const vote = engineVoteSingle('candle', candles)
          if (vote.dir === 0) return none(`${source === 'bar' ? 'Bar' : 'Candle'}: no lean - ${vote.note}`)
          const direction = vote.dir === 1 ? 'call' : 'put'
          const confidence = Math.round(Math.min(1, Math.max(0, vote.weight)) * 100)
          return { source, direction, confidence, label: `${source === 'bar' ? 'Bar' : 'Candle'} ${direction.toUpperCase()} - ${vote.note}` }
        }
        case 'heikinAshi': {
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const vote = engineVoteSingle('heikin', candles)
          if (vote.dir === 0) return none(`Heikin Ashi: no lean - ${vote.note}`)
          const direction = vote.dir === 1 ? 'call' : 'put'
          const confidence = Math.round(Math.min(1, Math.max(0, vote.weight)) * 100)
          return { source, direction, confidence, label: `Heikin Ashi ${direction.toUpperCase()} - ${vote.note}` }
        }
        case 'tick': {
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          // PRECISION FIX: this used to always pass realTicks:null (the
          // close-price proxy fallback, see the type's own doc comment in
          // analytics/metastrategy.ts) - now reuses the SAME tick buffer
          // the tick-desk sources already read, so a warm buffer gets the
          // real transaction-built vote; tickVote's own contract still
          // degrades honestly to the close-proxy when the buffer is cold.
          let realTicks: { time: number; price: number }[] | null = null
          try {
            const ofp = this.ctx.use<OtcFootprintService>('otcFootprint')
            const raw = ofp.ticksFor(asset)
            if (raw.length) realTicks = raw.map((t) => ({ time: Math.floor(t.ts / 1000), price: t.price }))
          } catch {
            realTicks = null // collector not loaded - proxy fallback, unchanged behavior
          }
          const vote = tickVote(candles, realTicks)
          if (vote.dir === 0) return none(`Tick: no lean - ${vote.note}`)
          const direction = vote.dir === 1 ? 'call' : 'put'
          const confidence = Math.round(Math.min(1, Math.max(0, vote.weight)) * 100)
          return { source, direction, confidence, label: `Tick ${direction.toUpperCase()} - ${vote.note}` }
        }
        case 'pulse': {
          // Pulse-Vector bars - see analytics/pulsebars.ts's own header and
          // claude/pulse-vector-chart-build.md for the full design
          // rationale. Reuses the SAME real tick buffer 'tick' above pulls
          // from (otcFootprint.ticksFor) - no separate sample, no proxy
          // fallback (unlike 'tick', this engine has no close-price
          // fallback mode at all - it IS a tick engine, so with no real
          // buffer it just reads none honestly rather than faking ticks
          // from candle closes).
          let ticks: { ts: number; price: number }[] = []
          try {
            ticks = this.ctx.use<OtcFootprintService>('otcFootprint').ticksFor(asset) as { ts: number; price: number }[]
          } catch {
            ticks = []
          }
          if (!ticks.length) return none('Pulse: no live tick buffer available')
          const pulse = computePulseBars(ticks, {
            ...(cfgNum(cfg, 'pulse.interval') !== undefined ? { intervalSec: cfgNum(cfg, 'pulse.interval') } : {}),
            ...(cfgNum(cfg, 'pulse.sparseFloor') !== undefined ? { sparseFloor: cfgNum(cfg, 'pulse.sparseFloor') } : {}),
          })
          if (!pulse.bars.length) return none('Pulse: no pulse bars formed yet (too few ticks per micro-interval)')
          const last = pulse.bars[pulse.bars.length - 1]
          if (last.color === 'flat') return none('Pulse: last bar was flat (zero net displacement)')
          const direction = last.displacement > 0 ? 'call' : 'put'
          const accelerating = last.color === 'accel-up' || last.color === 'accel-down'
          const highExhaustion = Number.isFinite(last.exhaustionScore) && last.exhaustionScore >= 0.6
          const confidence = accelerating && !highExhaustion ? 70 : highExhaustion ? 35 : 50
          return {
            source,
            direction,
            confidence,
            value: pulse.trend === 'up' ? pulse.streak : -pulse.streak,
            label: `Pulse ${direction.toUpperCase()} - ${last.color}${last.sparse ? ' (sparse)' : ''}, exhaustion ${Number.isFinite(last.exhaustionScore) ? (last.exhaustionScore * 100).toFixed(0) + '%' : 'n/a'}, ${last.tickCount} ticks/${pulse.intervalSec}s`,
          }
        }
        case 'footprint': {
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const vote = engineVoteSingle('footprint', candles)
          if (vote.dir === 0) return none(`Footprint: no lean - ${vote.note}`)
          const direction = vote.dir === 1 ? 'call' : 'put'
          const confidence = Math.round(Math.min(1, Math.max(0, vote.weight)) * 100)
          return { source, direction, confidence, label: `Footprint ${direction.toUpperCase()} - ${vote.note}` }
        }
        case 'otcFootprint': {
          // REAL print-speed/velocity footprint (analytics/otcfootprint.ts's
          // buildFootprint - the exact pure function plugins/otcfootprint.ts's
          // async footprint() wraps) - called directly here, sync, off
          // whatever ticks are ALREADY buffered, so a condition read never
          // triggers a fresh live pull itself (that stays the async service's
          // job on its own poll cadence; this is best-effort off the
          // existing buffer, same "never block a sync read" rule every
          // other source here already follows).
          const ofp = this.ctx.use<OtcFootprintService>('otcFootprint')
          const ticks = ofp.ticksFor(asset)
          if (!ticks.length) return none('OTC footprint: tick buffer cold')
          const fp = buildFootprint(ticks, { minutes: 30, bucketSec: 60, asset, dataSourceLabel: this.market.mode === 'live' ? 'sidecar-tick-100ms' : 'sim-tick-1s' })
          // reuse otcFootprintVote's own weight scaling (chartsignals.ts) -
          // the SAME function the Chart Signal committee and
          // chartindicators.ts's board use for this exact OtcFpRead shape,
          // rather than re-deriving a confidence formula here.
          const vote = otcFootprintVote({ signal: fp.summary.signal, score: fp.summary.score, netDelta: fp.summary.netDelta, avgSpeedRatio: fp.summary.avgSpeedRatio, buckets: fp.buckets.length })
          if (vote.dir === 0) return none(`OTC footprint: ${vote.note}`)
          return {
            source,
            direction: vote.dir === 1 ? 'call' : 'put',
            confidence: Math.round(Math.min(1, Math.max(0, vote.weight)) * 100),
            value: fp.summary.netDelta,
            label: `OTC footprint ${vote.dir === 1 ? 'CALL' : 'PUT'} - ${vote.note}`,
          }
        }
        case 'baseline': {
          // Real baseline-deviation reduction (analytics/baseline.ts,
          // Section 3/G closeout) - direction = crossing direction when the
          // baseline was JUST crossed this bar (the cleanest, freshest
          // signal), otherwise the plain above/below state; confidence
          // scaled by |deviationPct| (bigger displacement from the
          // baseline = more committed), capped the same 40-100 range every
          // other candle-derived source in this switch already uses.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const bl = computeBaseline(candles)
          if (!bl) return none('baseline: no candles yet')
          if (bl.crossDirection === 0 && bl.deviation === 0) return none('baseline: price sitting right on the baseline, no lean')
          const direction: 'call' | 'put' = bl.crossDirection !== 0 ? (bl.crossDirection === 1 ? 'call' : 'put') : bl.aboveBaseline ? 'call' : 'put'
          const magnitude = Math.min(2, Math.abs(bl.deviationPct) / 0.5) // 0.5% displacement already reads as "fully committed"
          const confidence = Math.min(100, 40 + Math.round(magnitude * 30) + (bl.crossDirection !== 0 ? 10 : 0))
          return { source, direction, confidence, value: bl.deviationPct, label: `Baseline ${direction.toUpperCase()}${bl.crossDirection !== 0 ? ' (just crossed)' : ''} - ${bl.deviation >= 0 ? '+' : ''}${bl.deviation.toFixed(5)} (${bl.deviationPct.toFixed(2)}%) vs baseline ${bl.baseline.toFixed(5)}` }
        }
        case 'line':
        case 'area': {
          // Line/area are the SAME close-only price series, just rendered
          // two ways - no distinct math, so both share one close-trend
          // reduction (baseline now has its own real deviation-based
          // reduction above, see analytics/baseline.ts): closed-candle-count of consecutive
          // closes moving the same direction as the latest close-vs-close
          // delta, scaled by that delta relative to ATR (renkoAtr) so a
          // big move reads as more committed than a one-tick drift, same
          // 40+n*12-capped-100 confidence convention as renko/range/P&F.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          if (candles.length < 3) return none(`${source}: not enough closes yet`)
          let streak = 0
          const lastDelta = candles[candles.length - 1].close - candles[candles.length - 2].close
          if (lastDelta === 0) return none(`${source}: flat close, no lean`)
          const wantUp = lastDelta > 0
          for (let i = candles.length - 1; i > 0; i--) {
            const d = candles[i].close - candles[i - 1].close
            if (d === 0) break
            if (wantUp !== d > 0) break
            streak++
          }
          const atr = renkoAtr(candles)
          const magnitude = Number.isFinite(atr) && atr > 0 ? Math.min(2, Math.abs(lastDelta) / atr) : 0
          const direction = wantUp ? 'call' : 'put'
          const confidence = Math.min(100, 40 + streak * 12 + Math.round(magnitude * 10))
          const label = source === 'line' ? 'Line' : 'Area'
          return { source, direction, confidence, label: `${label} ${streak} closed ${direction.toUpperCase()} bar(s), delta ${lastDelta.toFixed(5)} vs ATR ${Number.isFinite(atr) ? atr.toFixed(5) : 'n/a'}` }
        }
        case 'volumeBars': {
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const vb = volumeBars(candles, cfgNum(cfg, 'volbar.per') !== undefined ? { per: cfgNum(cfg, 'volbar.per') } : {})
          if (vb.degenerate || vb.bars.length < 2) return none('Volume bars: no bars painted yet (or all-zero volume window)')
          let streak = 0
          const bars = vb.bars
          const lastUp = bars[bars.length - 1].close > bars[bars.length - 1].open
          for (let i = bars.length - 1; i >= 0; i--) {
            const up = bars[i].close > bars[i].open
            if (up !== lastUp) break
            streak++
          }
          const direction = lastUp ? 'call' : 'put'
          const confidence = Math.min(100, 40 + streak * 12)
          return { source, direction, confidence, value: direction === 'call' ? streak : -streak, label: `Volume bars ${streak} ${direction.toUpperCase()} bar(s) (${vb.volumeSource})` }
        }
        case 'tpo': {
          // POC-distance reduction: last close ABOVE the Point-of-Control
          // reads as bullish conviction (price trading above fair value),
          // below reads bearish - scaled by distance relative to the value
          // area's own width so a close just outside POC reads weaker than
          // one well outside the whole value area.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const tpo = computeTpo(candles, {
            ...(cfgNum(cfg, 'tpo.periodSec') !== undefined ? { periodSec: cfgNum(cfg, 'tpo.periodSec') } : {}),
            ...(cfgNum(cfg, 'tpo.binCount') !== undefined ? { binCount: cfgNum(cfg, 'tpo.binCount') } : {}),
          })
          if (tpo.poc === null) return none('TPO: no profile built yet (window too thin)')
          const lastClose = candles[candles.length - 1].close
          const delta = lastClose - tpo.poc
          if (delta === 0) return none('TPO: close sitting right on POC, no lean')
          const vaWidth = tpo.valueAreaHigh !== null && tpo.valueAreaLow !== null ? Math.max(tpo.valueAreaHigh - tpo.valueAreaLow, 1e-9) : NaN
          const ratio = Number.isFinite(vaWidth) ? Math.min(2, Math.abs(delta) / vaWidth) : 0
          const direction = delta > 0 ? 'call' : 'put'
          const confidence = Math.min(100, 45 + Math.round(ratio * 35))
          return { source, direction, confidence, value: Number.isFinite(vaWidth) ? delta / vaWidth : undefined, label: `TPO close ${direction.toUpperCase()} of POC (poc ${tpo.poc.toFixed(5)}, close ${lastClose.toFixed(5)})` }
        }
        case 'ivHv': {
          // Deviation-from-50% reduction on realizedUpProb() - NOT a
          // volatility forecast ("vol has no direction" - see ivhv.ts's own
          // doc comment); this reads the realized up-closing frequency
          // itself as a directional lean, same honest framing the IV/HV
          // panel uses for its "realized WR vs breakeven" line.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          if (candles.length < 10) return none('IV-HV: not enough closes yet')
          const upProb = realizedUpProb(candles, cfgNum(cfg, 'ivhv.window') ?? 100)
          const delta = upProb - 50
          if (Math.abs(delta) < 1e-9) return none('IV-HV: exactly 50/50 up-closes, no lean')
          const direction = delta > 0 ? 'call' : 'put'
          const confidence = Math.min(100, 50 + Math.round(Math.abs(delta) * 2.5))
          return { source, direction, confidence, value: delta, label: `IV-HV realized up-close ${upProb.toFixed(1)}% (${direction.toUpperCase()} lean)` }
        }
        case 'renkoSmc': {
          // Same confluence rule Meta Trader's 'renko-smc' source trades -
          // AUDIT FIX: "smc now says up" means ANY SMC concept agreeing
          // with Renko's direction right now, not smcNowRead()'s own
          // majority/tie-broken winner (that would reject a case where a
          // minority concept DID agree, just because other concepts
          // outvoted it - see pickRenkoSmc()'s doc comment in
          // plugins/metatrader.ts for the full story). Renko decides the
          // direction; smcAnyAgrees() (analytics/smc.ts) only checks
          // whether at least one now-signal points the same way.
          const r = this.renkoDirectionRead(asset, tf)
          if (r.direction === 'none') return none('Renko+SMC: no bricks painted yet')
          const smc = this.ctx.use<SmcScanService>('smcScan')
          const resp = smc.scan(asset, tf)
          if (!resp.result) return none('Renko+SMC: no scan result yet')
          const agreement = smcAnyAgrees(resp.result, r.direction)
          if (!agreement.agrees) return none(`Renko+SMC: no confluence (renko ${r.direction}, ${agreement.note})`)
          const confidence = Math.round((agreement.confidence + r.confidence) / 2)
          return { source, direction: r.direction, confidence, label: `Renko+SMC ${r.direction.toUpperCase()} - ${r.streak} ${r.trend.toUpperCase()} brick(s) & ${agreement.note}` }
        }
        case 'renkoSmcMajority': {
          // The OTHER confluence rule, kept alongside 'renkoSmc' above per
          // direct instruction ("we can have the confluence version also
          // tho, lets have both"): requires SMC's own AGGREGATE "now"
          // verdict (smcNowRead() - majority of now-concepts, same read
          // the plain 'smc' source trades) to match Renko's direction,
          // not just any one concept agreeing. Stricter - a pair with 3
          // bearish concepts and 1 bullish now will NOT qualify here even
          // if Renko is up, where 'renkoSmc' still would.
          const r2 = this.renkoDirectionRead(asset, tf)
          if (r2.direction === 'none') return none('Renko+SMC (majority): no bricks painted yet')
          const smc2 = this.ctx.use<SmcScanService>('smcScan')
          const resp2 = smc2.scan(asset, tf)
          if (!resp2.result) return none('Renko+SMC (majority): no scan result yet')
          const smcRead = smcNowRead(resp2.result)
          if (smcRead.direction === 'none' || smcRead.direction !== r2.direction) {
            return none(`Renko+SMC (majority): no confluence (renko ${r2.direction}, smc now ${smcRead.direction})`)
          }
          const confidence2 = Math.round((smcRead.confidence + r2.confidence) / 2)
          return { source, direction: r2.direction, confidence: confidence2, label: `Renko+SMC (majority) ${r2.direction.toUpperCase()} - ${r2.streak} ${r2.trend.toUpperCase()} brick(s) & ${smcRead.note}` }
        }
        case 'tickSmc': {
          // The Tick Desk's own SMC engine on the RAW print stream - same
          // computeTickSmc call the /tick_smc route serves, so a condition
          // reads exactly what the panel shows (swing structure, BOS/CHoCH,
          // order blocks, FVGs, sweeps, premium/discount). Warming/degenerate
          // buckets come back ok:false with the engine's own note - a 'none'
          // read, never a guess.
          const ticks = this.tickBuffer(asset)
          if (!ticks?.length) return none('Tick SMC: no tick buffer yet (collector warming up)')
          const r = computeTickSmc(ticks, { bucketSec: tickBucketSec ?? 15 })
          if (!r.ok || r.direction === 'none') return none(`Tick SMC: ${r.note ?? 'no lean'}`)
          const zones = `${r.fvgs.length} FVG(s), ${r.bullOrderBlock || r.bearOrderBlock ? 'OB present' : 'no OB'}${r.sweeps.length ? `, ${r.sweeps.length} sweep(s)` : ''}`
          return { source, direction: r.direction, confidence: r.confidence, label: `Tick SMC ${r.trend.toUpperCase()} ${r.direction.toUpperCase()} ${r.confidence.toFixed(0)}% - ${zones} (${r.medTicksPerCandle.toFixed(1)} prints/bucket @${r.bucketSec}s)` }
        }
        case 'tickOracle': {
          // The Tick Desk's next-candle oracle. Unpinned = the engine's own
          // best bucket (same pick the tick oracle panel highlights); pinned
          // tickBucketSec = exactly that rung's read, same fail-closed shape
          // as the nextExpiry rungs above (warming/deadband -> 'none'). The
          // engine's walk-forward hit rate (when resolved) is disclosed in
          // the label, so a meta condition can be judged by its own record.
          const ticks = this.tickBuffer(asset)
          if (!ticks?.length) return none('Tick oracle: no tick buffer yet (collector warming up)')
          const res = computeTickOracle(ticks, tickBucketSec !== undefined ? { bucketsSec: [tickBucketSec] } : {})
          const row = tickBucketSec !== undefined ? res.rows[0] : res.best
          if (!row) return none(`Tick oracle: ${res.note ?? 'no read'}`)
          if (!row.ok) return none(`Tick oracle ${row.label}: ${row.note ?? 'warming up'}`)
          if (row.direction === 'none') return none(`Tick oracle ${row.label}: ${row.note ?? 'two-sided tape'}`)
          const wf = row.wf && row.wf.hitRatePct != null ? `, own walk-forward ${row.wf.hitRatePct}% over ${row.wf.n}` : ''
          return { source, direction: row.direction, confidence: row.confidence, value: row.score, label: `Tick oracle ${row.label} ${row.direction.toUpperCase()} ${row.confidence.toFixed(0)}% (score ${row.score >= 0 ? '+' : ''}${row.score}${wf})` }
        }
        case 'tickTechnical':
          return { source, ...this.tickTechnicalRead(asset, tickBucketSec ?? cfgNum(cfg, 'tickTechnical.bucketSec')) }
        case 'tickFootprint': {
          // The REAL measured-print footprint (not the CLV proxy 'footprint'
          // above): direction from the window's net delta (up prints minus
          // down prints), confidence from the delta's SHARE of total prints
          // so a 3-print window can't read as conviction. Gated on >= 8
          // measured prints - below that the ladder is trivia, not evidence.
          // `.value` = the signed one-sided share (-1..1).
          const ticks = this.tickBuffer(asset)
          if (!ticks?.length) return none('Tick footprint: no tick buffer yet (collector warming up)')
          const fp = computeTickFootprint(ticks, { bucketSec: tickBucketSec ?? cfgNum(cfg, 'tickFootprint.bucketSec') ?? 60 })
          if (!fp.ok) return none(`Tick footprint: ${fp.note ?? 'no closed buckets yet'}`)
          const s = fp.summary
          const total = s.totalUp + s.totalDn
          if (total < 8) return none(`Tick footprint: only ${total} measured print(s) in ${s.buckets} bucket(s) - too thin to lean on`)
          if (s.netDelta === 0) return none('Tick footprint: perfectly balanced tape, no lean')
          const direction = s.netDelta > 0 ? 'call' : 'put'
          const share = Math.abs(s.netDelta) / total
          return { source, direction, confidence: Math.min(100, Math.round(40 + share * 100)), value: direction === 'call' ? share : -share, label: `Tick footprint ${direction.toUpperCase()} - net delta ${s.netDelta >= 0 ? '+' : ''}${s.netDelta} (${s.totalUp}u/${s.totalDn}d, ${Math.round(share * 100)}% one-sided, POC ${s.dominantPoc != null ? s.dominantPoc.toFixed(5) : 'n/a'}, ${s.buckets}x${fp.bucketSec}s)` }
        }
        case 'technical': {
          // The Technical Summary panel's own ladder-consensus verdict (the
          // exact row the per-asset panel and the whole-universe board
          // render): direction straight off the board's call/put/none,
          // confidence scaled by the overall (buys-sells)/counted vote
          // score (-1..1), `.value` = that raw score.
          const tech = this.ctx.use<TechnicalService>('technical')
          let priceHint = 0
          try {
            priceHint = this.market.getPrice(asset)
          } catch {
            /* rowFor handles a 0 hint */
          }
          const row = tech.rowFor(asset, priceHint, { refresh: this.inReplay })
          if (!row.ok) return none(`Technical: ${row.note}`)
          if (row.direction === 'none') return none(`Technical: ladder consensus neutral (${row.overall.label})`)
          const score = row.overall.score
          return { source, direction: row.direction, confidence: Math.min(100, Math.round(40 + Math.abs(score) * 80)), value: score, label: `Technical ladder ${row.direction.toUpperCase()} - ${row.overall.label} (score ${(score * 100).toFixed(0)}%, ${row.overall.buys}buy/${row.overall.sells}sell/${row.overall.neutrals}n over ${row.overall.counted})` }
        }
        case 'reversal': {
          // The Reversal Radar's most urgent live read - but a read only
          // CLAIMS direction in the two tradeable states: 'reversing NOW'
          // and 'confirmed'. calm/forming honestly read none (a forming
          // reversal is a watch, not a trade).
          const rev = this.ctx.use<ReversalService>('reversal')
          let priceHint = 0
          try {
            priceHint = this.market.getPrice(asset)
          } catch {
            /* rowFor handles a 0 hint */
          }
          const row = rev.rowFor(asset, priceHint, { refresh: this.inReplay })
          if (!row.ok) return none(`Reversal: ${row.note}`)
          if (row.state !== 'reversing' && row.state !== 'confirmed') return none(`Reversal: ${row.state} (no tradeable claim yet)`)
          if (row.direction === 'none') return none('Reversal: no direction resolved')
          const rdir: 'call' | 'put' = row.direction === 'up' ? 'call' : 'put'
          return { source, direction: rdir, confidence: Math.min(100, Math.round(35 + Math.abs(row.score) * 15)), value: row.score, label: `Reversal ${row.state.toUpperCase()} ${rdir.toUpperCase()} (net vote ${row.score.toFixed(1)} @ ${row.best?.tf ?? '?'})` }
        }
        case 'tempo': {
          // The Tempo shot-license scanner's read for THIS pair+tf: the
          // direction only counts on decision 'fire' (an unclaimed license
          // this window) - wait/skip/done are honest 'none's, exactly what
          // the Tempo panel itself would tell a human.
          const tempo = this.ctx.use<TempoService>('tempo')
          const row = tempo.rowFor(asset, tf)
          if (!row.ok) return none(`Tempo: ${row.note}`)
          if (row.decision !== 'fire') return none(`Tempo: ${row.decision.toUpperCase()} - ${row.decisionReason}`)
          if (row.direction === 'none') return none(`Tempo: fire without a direction - ${row.decisionReason}`)
          return { source, direction: row.direction, confidence: Math.min(100, Math.round(row.conviction)), value: row.conviction, label: `Tempo FIRE ${row.direction.toUpperCase()} (conviction ${row.conviction.toFixed(0)} vs ${row.threshold.toFixed(0)}, ${row.barsRemaining} bar(s) left)` }
        }
        case 'confluence': {
          // The Confluence Screener's composite read for THIS pair+tf (the
          // same ScreenRow its own panel and the auto-trader's 'screener'
          // source trade): direction + confidence straight off the row,
          // `.value` = its signed score (-100..100).
          const screener = this.ctx.use<ScreenerService>('screener')
          if (!screener.hasRow(asset, tf)) return none('Confluence: screener has not scored this pair yet (sweep warming up)')
          const row = screener.evaluate(asset, tf)
          if (row.direction === 'none') return none(`Confluence: no lean (score ${row.score.toFixed(0)}, regime ${row.regime})`)
          return { source, direction: row.direction, confidence: row.confidence, value: row.score, label: `Confluence ${row.direction.toUpperCase()} ${row.confidence.toFixed(0)}% (score ${row.score.toFixed(0)}, regime ${row.regime}, pUp ${(row.pUp * 100).toFixed(0)}%)` }
        }
        case 'volArb': {
          // The Volatility-Arb scanner's per-pair read: direction only when
          // the scanner's own ratio regime produces one (balanced/no-lean =
          // honest none); `.value` = the signed IV/HV ratio distance from 1.
          const va = this.ctx.use<VolArbScanService>('volArbScan')
          const res = va.scan(tf)
          const row = res.rows.find((r) => r.asset === asset)
          if (!row || !row.open) return none('Vol-arb: no scan row for this pair (warming up or closed)')
          if (!row.direction) return none(`Vol-arb: ${row.regime} regime, no lean (ratio ${row.ratio.toFixed(2)})`)
          const confidence = Math.min(100, Math.round(40 + Math.abs(row.ratio - 1) * 40 + Math.abs(row.momentum) * 10))
          return { source, direction: row.direction, confidence, value: row.ratio - 1, label: `Vol-arb ${row.direction.toUpperCase()} (IV/HV ratio ${row.ratio.toFixed(2)}, ${row.regime}, momentum ${row.momentum >= 0 ? '+' : ''}${row.momentum.toFixed(2)})` }
        }
        case 'cointegration': {
          // The Cointegration scanner's spread-reversion read vs this pair's
          // statistical leader: direction = the scanner's own suggested
          // trade (already gated on beta/R2/half-life fit quality inside the
          // scan), `.value` = the raw spread z (sigmas).
          const ci = this.ctx.use<CointegrationScanService>('cointegrationScan')
          const res = ci.scan(tf)
          const row = res.rows.find((r) => r.asset === asset)
          if (!row) return none('Cointegration: no fitted leader for this pair (warming up or no cointegrated partner)')
          if (!row.direction) return none(`Cointegration: fit ok (z ${row.z >= 0 ? '+' : ''}${row.z.toFixed(2)}) but no trade suggestion`) 
          const confidence = Math.min(100, Math.round(40 + Math.abs(row.z) * 12))
          return { source, direction: row.direction, confidence, value: row.z, label: `Cointegration ${row.direction.toUpperCase()} - spread z ${row.z >= 0 ? '+' : ''}${row.z.toFixed(2)} vs ${row.leader} (beta ${row.beta.toFixed(2)}, R2 ${row.r2.toFixed(2)})` }
        }
        case 'screenerRank': {
          // The market-wide Screener board's own row for this pair+tf -
          // same ScreenRow 'confluence' reads above, under its own name
          // per direct instruction to give every panel full MSL coverage.
          const scr = this.ctx.use<ScreenerService>('screener')
          if (!scr.hasRow(asset, tf)) return none('Screener: has not scored this pair yet (sweep warming up)')
          const row = scr.evaluate(asset, tf)
          if (row.direction === 'none') return none(`Screener: no lean (score ${row.score.toFixed(0)}, regime ${row.regime})`)
          return { source, direction: row.direction, confidence: row.confidence, value: row.score, label: `Screener rank ${row.direction.toUpperCase()} ${row.confidence.toFixed(0)}% (score ${row.score.toFixed(0)}, regime ${row.regime}, pUp ${(row.pUp * 100).toFixed(0)}%)` }
        }
        case 'chartSignals': {
          // The chart-signal pattern committee's row for this pair - the
          // SUGGESTED (already fade-adjusted) trade direction, strength
          // 0..100 as confidence, signed -100..100 score as .value.
          const cs = this.ctx.use<ChartSignalsService>('chartSignals')
          const res = cs.peek('option', tf)
          if (!res?.ok) return none('Chart signals: committee scan warming up')
          const row = res.signals.find((s) => s.asset === asset)
          if (!row) return none('Chart signals: no qualifying committee read for this pair this cycle')
          const faded = row.rawDirection !== row.direction ? ` (FADE of the committee's own ${row.rawDirection.toUpperCase()} ${row.agree}/${row.total} read)` : ''
          return { source, direction: row.direction, confidence: Math.round(row.strength), value: row.score, label: `Chart-signal committee ${row.direction.toUpperCase()} strength ${row.strength.toFixed(0)}${faded}` }
        }
        case 'leadLag': {
          // Is a correlated LEADER already moving first - direction = the
          // scanner's own suggested follow trade; confidence from fit
          // quality (|correlation|) and how sharp the leader's trigger move
          // was (|triggerZ|), same "40 + magnitude" shape as volArb/
          // cointegration above. `.value` = the leader's triggerZ.
          const ll = this.ctx.use<LeadLagScanService>('leadLagScan')
          const res = ll.scan(tf)
          const row = res.rows.find((r) => r.asset === asset && r.direction != null)
          if (!row) return none('Lead-lag: no qualifying leader/lag fit for this pair this cycle')
          const confidence = Math.min(100, Math.round(40 + Math.abs(row.correlation) * 30 + Math.min(20, Math.abs(row.triggerZ) * 5)))
          return { source, direction: row.direction as 'call' | 'put', confidence, value: row.triggerZ, label: `Lead-lag ${row.direction!.toUpperCase()} - leader ${row.leader} by ${row.lag} bar(s) (corr ${row.correlation.toFixed(2)}, trigger ${row.triggerZ >= 0 ? '+' : ''}${row.triggerZ.toFixed(1)}σ, n=${row.n})` }
        }
        case 'yesterday': {
          // T-24h replay echo - a WEAK PRIOR by design ("markets rhyme,
          // they do not repeat"): direction only claimed when today's
          // lead-in actually agrees with yesterday's at this wall-clock
          // hour (echo.dirAgree === 'same') and the window wasn't quiet/
          // trivial; confidence capped low-to-moderate (30-80) on purpose -
          // this should never out-rank a real structural/momentum read.
          // Synchronous cache peek (YesterdayService.peekCached) rather
          // than the async scan() every other caller uses - MSL's reads
          // map must stay a plain sync build, so a cold cache honestly
          // reads 'none' and warms for the NEXT evaluation instead of this
          // one call going async.
          const yd = this.ctx.use<YesterdayService>('yesterday')
          const res = yd.peekCached(tf, 60, 1)
          const row = res?.rows.find((r) => r.asset === asset)
          if (!row) return none('Yesterday echo: no cached T-24h read yet for this pair+tf (warming up - poll the panel once to prime it)')
          if (!row.echo || row.echo.quiet || row.echo.dirAgree !== 'same' || row.dir === 'none') {
            return none(`Yesterday echo: ${!row.echo ? 'no echo window' : row.echo.quiet ? 'both lead-ins flat (trivial)' : `dirAgree ${row.echo.dirAgree}`} - no directional claim`)
          }
          const confidence = Math.min(80, Math.round(30 + row.echo.rhyme * 0.5))
          return { source, direction: row.dir === 'up' ? 'call' : 'put', confidence, value: row.echo.rhyme, label: `Yesterday echo ${row.dir.toUpperCase()} - rhyme ${row.echo.rhyme.toFixed(0)}/100, same-hour move ${row.movePct >= 0 ? '+' : ''}${row.movePct.toFixed(3)}% (weak prior, not a signal)` }
        }
        case 'volumeProfile': {
          // VOLUME-based POC-distance reduction - the exact same shape as
          // 'tpo' above, mirrored onto analytics/volumeprofile.ts's
          // range-overlap-proxy volume POC/value-area instead of TPO's
          // time-based ones. Never confuse the two (see volumeprofile.ts's
          // own module header) - this case exists precisely so a script can
          // trade "price vs volume-weighted fair value" as a DISTINCT read
          // from "price vs time-weighted fair value".
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const vp = computeVolumeProfile(candles, {
            ...(cfgNum(cfg, 'vp.binCount') !== undefined ? { binCount: cfgNum(cfg, 'vp.binCount') } : {}),
          })
          if (vp.poc === null) return none('Volume Profile: no profile built yet (window too thin)')
          const lastClose = candles[candles.length - 1].close
          const delta = lastClose - vp.poc
          if (delta === 0) return none('Volume Profile: close sitting right on POC, no lean')
          const vaWidth = vp.valueAreaHigh !== null && vp.valueAreaLow !== null ? Math.max(vp.valueAreaHigh - vp.valueAreaLow, 1e-9) : NaN
          const ratio = Number.isFinite(vaWidth) ? Math.min(2, Math.abs(delta) / vaWidth) : 0
          const direction = delta > 0 ? 'call' : 'put'
          const confidence = Math.min(100, 45 + Math.round(ratio * 35))
          return { source, direction, confidence, value: Number.isFinite(vaWidth) ? delta / vaWidth : undefined, label: `Volume Profile close ${direction.toUpperCase()} of POC (poc ${vp.poc.toFixed(5)}, close ${lastClose.toFixed(5)}, vol ${vp.method})` }
        }
        case 'lineBreak': {
          // direction = the current line's own direction; confidence scaled
          // by the consecutive-same-direction streak, same 40+n*12-capped
          // shape renko/range/P&F/volumeBars above already use.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const lb = lineBreak(candles, {
            ...(cfgNum(cfg, 'linebreak.lines') !== undefined ? { lines: cfgNum(cfg, 'linebreak.lines') } : {}),
          })
          if (lb.direction === 0 || lb.bars.length < 2) return none('Line Break: no lines painted yet')
          const direction = lb.direction === 1 ? 'call' : 'put'
          const confidence = Math.min(100, 40 + lb.streak * 12)
          return { source, direction, confidence, value: lb.direction === 1 ? lb.streak : -lb.streak, label: `Line Break ${lb.streak} ${direction.toUpperCase()} line(s) (of ${lb.lineCount})` }
        }
        case 'kagi': {
          // direction = the current trend direction; confidence boosted
          // when the line is currently thick (yang - price has broken its
          // last shoulder) vs thin (yin) - thickness is Kagi's own
          // conviction signal, independent of the last reversal itself.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const kg = kagi(candles, {
            ...(cfgNum(cfg, 'kagi.reversal') !== undefined ? { reversal: cfgNum(cfg, 'kagi.reversal') } : {}),
            ...(cfgNum(cfg, 'kagi.atrPeriod') !== undefined ? { atrPeriod: cfgNum(cfg, 'kagi.atrPeriod') } : {}),
            ...(cfgNum(cfg, 'kagi.reversalAtrMult') !== undefined ? { reversalAtrMult: cfgNum(cfg, 'kagi.reversalAtrMult') } : {}),
          })
          if (kg.direction === 0 || !kg.lines.length) return none('Kagi: no lines painted yet')
          const direction = kg.direction === 1 ? 'call' : 'put'
          const confidence = kg.thick ? 70 : 45
          return { source, direction, confidence, label: `Kagi ${direction.toUpperCase()} - line is ${kg.thick ? 'thick (yang)' : 'thin (yin)'} (reversal ${kg.reversal.toFixed(5)})` }
        }
        case 'swing': {
          // direction from the confirmed hh-hl/lh-ll structure read only -
          // 'none' structure (including a high/low moving in different
          // directions) reads as a 'none' verdict, never a forced guess,
          // same honest-no-read contract swing.ts's own structure() field
          // documents.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const sw = computeSwing(candles, {
            ...(cfgNum(cfg, 'swing.lookback') !== undefined ? { lookback: cfgNum(cfg, 'swing.lookback') } : {}),
          })
          if (sw.structure === 'none') return none(`Swing: no clean hh-hl/lh-ll structure yet (${sw.swings.length} confirmed swing(s))`)
          const direction = sw.structure === 'hh-hl' ? 'call' : 'put'
          const confidence = 60
          return { source, direction, confidence, label: `Swing structure ${sw.structure.toUpperCase()} (${sw.swings.length} confirmed swing(s), lookback ${sw.lookback})` }
        }
        case 'effort': {
          // direction = the last brick's trend (same as 'renko' above);
          // confidence boosted when that LAST brick is itself confirmed
          // (its own participation cleared effortMult) vs not - mirrors
          // 'kagi' above using its own thickness as the conviction boost.
          // 'none' both when no bricks have painted yet AND (same honest
          // no-guess contract every source here follows) there isn't
          // enough history to say anything.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const eb = effortBricks(candles, {
            ...(cfgNum(cfg, 'effort.brick') !== undefined ? { brickSize: cfgNum(cfg, 'effort.brick') } : {}),
            ...(cfgNum(cfg, 'effort.atrPeriod') !== undefined ? { atrPeriod: cfgNum(cfg, 'effort.atrPeriod') } : {}),
            ...(cfgNum(cfg, 'effort.atrMult') !== undefined ? { atrMult: cfgNum(cfg, 'effort.atrMult') } : {}),
            ...(cfgNum(cfg, 'effort.mult') !== undefined ? { effortMult: cfgNum(cfg, 'effort.mult') } : {}),
            ...(cfgNum(cfg, 'effort.lookback') !== undefined ? { lookback: cfgNum(cfg, 'effort.lookback') } : {}),
          })
          if (eb.trend === 'none' || !eb.bricks.length) return none('Effort Bricks: no bricks painted yet')
          const last = eb.bricks[eb.bricks.length - 1]
          const direction = eb.trend === 'up' ? 'call' : 'put'
          const confidence = last.confirmed ? 70 : 40
          return {
            source,
            direction,
            confidence,
            value: eb.trend === 'up' ? eb.streak : -eb.streak,
            label: `Effort Bricks ${direction.toUpperCase()} - last brick ${last.confirmed ? 'CONFIRMED' : 'unconfirmed'} (regime ${eb.regime}, confirmed ${(eb.confirmedRatio * 100).toFixed(0)}% of last ${eb.lookback}, effortSource ${eb.effortSource})`,
          }
        }
        case 'mrc': {
          // CANDLE-FALLBACK ONLY, deliberately - no live tick feed is
          // passed in here (unlike the raw mrc.* namespace in
          // strategylang.ts, which opportunistically upgrades via
          // ctx.liveTicks) so this verdict stays SAFE_BACKTEST_SOURCES
          // tier, same reasoning 'effort' above follows. Direction = the
          // last CONFIRMED (not still-forming, not gap-forced) bar's
          // directional lean; confidence boosted when that bar's own
          // responseRatio clears its trailing average (a "clean,
          // low-resistance move" read, mirroring 'effort'/'kagi' above
          // using their own engine's conviction signal as the boost).
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const mrc = computeMrc(candles, undefined, {
            ...(cfgNum(cfg, 'mrc.priceMult') !== undefined ? { priceMult: cfgNum(cfg, 'mrc.priceMult') } : {}),
            ...(cfgNum(cfg, 'mrc.activityMult') !== undefined ? { activityMult: cfgNum(cfg, 'mrc.activityMult') } : {}),
            ...(cfgNum(cfg, 'mrc.maxDuration') !== undefined ? { maxDurationSec: cfgNum(cfg, 'mrc.maxDuration') } : {}),
            ...(cfgNum(cfg, 'mrc.maxGapMult') !== undefined ? { maxGapMultiple: cfgNum(cfg, 'mrc.maxGapMult') } : {}),
            ...(cfgNum(cfg, 'mrc.lookback') !== undefined ? { lookback: cfgNum(cfg, 'mrc.lookback') } : {}),
          })
          const confirmedBars = mrc.bars.filter((b) => b.confirmed && !b.dataGap)
          if (!confirmedBars.length) return none('MRC: no confirmed bars yet')
          const last = confirmedBars[confirmedBars.length - 1]
          if (last.directionalDelta === 0) return none('MRC: last confirmed bar had no net directional lean')
          const direction = last.directionalDelta > 0 ? 'call' : 'put'
          const strong = Number.isFinite(last.responseRatio) && last.responseRatio >= 1
          const confidence = strong ? 70 : 40
          return {
            source,
            direction,
            confidence,
            value: mrc.trend === 'up' ? mrc.streak : -mrc.streak,
            label: `MRC ${direction.toUpperCase()} - last confirmed bar ${strong ? 'ABOVE' : 'below'} trailing response_efficiency (ratio ${Number.isFinite(last.responseRatio) ? last.responseRatio.toFixed(2) : 'n/a'}x, trigger ${last.trigger}, fidelity ${mrc.fidelity})`,
          }
        }
        case 'outcomeMemory': {
          // k-NN over past same-session market states - see
          // analytics/outcomememory.ts's own header and
          // claude/market-response-chart-mrc.md for the full design
          // rationale (built in response to a "Binary Outcome Chart"
          // proposal - this is the one genuinely new piece that proposal
          // surfaced, not already covered by the Next-Expiry Oracle).
          // DEADBAND + POOL-SIZE-SCALED CONFIDENCE: a pUp of 0.52 drawn from
          // 20 matches says almost nothing - confidence here scales with
          // BOTH how far pUp sits from a coin flip AND how large the
          // comparable pool actually was, so a thin-pool read never
          // outranks a thick-pool one at the same pUp.
          const candles = this.market.getCandlesDeep(asset, tf, Math.max(2000, cfgNum(cfg, 'memory.lookback') ?? 1500), true)
          const om = computeOutcomeMemory(candles, asset, {
            ...(cfgNum(cfg, 'memory.expiry') !== undefined ? { expiryBars: cfgNum(cfg, 'memory.expiry') } : {}),
            ...(cfgNum(cfg, 'memory.k') !== undefined ? { k: cfgNum(cfg, 'memory.k') } : {}),
            ...(cfgNum(cfg, 'memory.lookback') !== undefined ? { lookback: cfgNum(cfg, 'memory.lookback') } : {}),
            ...(cfgNum(cfg, 'memory.minPool') !== undefined ? { minPoolSize: cfgNum(cfg, 'memory.minPool') } : {}),
          })
          if (!om.ok) return none(`Outcome Memory: ${om.note}`)
          const DEADBAND = 0.08
          if (!Number.isFinite(om.pUp) || Math.abs(om.pUp - 0.5) < DEADBAND) return none(`Outcome Memory: pUp ${Number.isFinite(om.pUp) ? (om.pUp * 100).toFixed(0) + '%' : 'n/a'} too close to a coin flip (${om.k} matches, pool ${om.poolSize})`)
          const direction = om.pUp > 0.5 ? 'call' : 'put'
          const edgeStrength = Math.min(1, Math.abs(om.pUp - 0.5) / 0.3) // |pUp-0.5| of 0.3+ (i.e. 80%+/20%-) maxes this out
          const poolStrength = Math.min(1, om.poolSize / 200) // a 200+ match pool maxes this out
          const confidence = Math.round(35 + 40 * edgeStrength + 15 * poolStrength)
          return {
            source,
            direction,
            confidence,
            value: om.pUp,
            label: `Outcome Memory ${direction.toUpperCase()} - pUp ${(om.pUp * 100).toFixed(0)}% over ${om.k} comparable ${om.session} state(s) (pool ${om.poolSize}), avg forward return ${om.avgReturn.toFixed(4)}%`,
          }
        }
        case 'footDivergence': {
          // The Metric-B divergence trap off the REAL tick buffer - same
          // sync-off-existing-buffer rule 'otcFootprint' above follows (never
          // triggers a fresh live pull itself). 'put-trap' = heavy buy delta
          // trapped at the window low -> reads PUT; 'call-trap' -> CALL.
          const ofpD = this.ctx.use<OtcFootprintService>('otcFootprint')
          const ticksD = ofpD.ticksFor(asset)
          if (!ticksD.length) return none('Footprint divergence: tick buffer cold')
          const fpD = buildFootprint(ticksD, { minutes: 30, bucketSec: 60, asset, dataSourceLabel: this.market.mode === 'live' ? 'sidecar-tick-100ms' : 'sim-tick-1s' })
          const div = [...fpD.buckets].reverse().find((b) => b.divergence)
          if (!div || !div.divergence) return none('Footprint divergence: no divergence trap in the recent buckets')
          const direction = div.divergence === 'put-trap' ? 'put' : 'call'
          return { source, direction, confidence: 65, value: div.velDelta, label: `Footprint divergence ${direction.toUpperCase()} trap - ${div.divergence} (vel delta ${div.velDelta >= 0 ? '+' : ''}${div.velDelta})` }
        }
        case 'footStackedImbalance': {
          // Consecutive same-direction diagonal imbalance across several
          // footprint buckets - checks BOTH sides and returns whichever (if
          // either) currently qualifies; 'none' if neither side has a
          // qualifying stack right now. Same tick-buffer-required,
          // never-block-a-sync-read contract as 'footDivergence' above.
          const ofpS = this.ctx.use<OtcFootprintService>('otcFootprint')
          const ticksS = ofpS.ticksFor(asset)
          if (!ticksS.length) return none('Stacked imbalance: tick buffer cold')
          const n = Math.max(1, Math.round(cfgNum(cfg, 'footstack.n') ?? 3))
          const ratio = cfgNum(cfg, 'footstack.ratio') ?? 1.5
          const bucketSec = Math.max(5, Math.round(cfgNum(cfg, 'footstack.bucketSec') ?? 60))
          const minutes = Math.max(1, Math.ceil((bucketSec * n) / 60))
          const fpS = buildFootprint(ticksS, { bucketSec, minutes, asset, dataSourceLabel: this.market.mode === 'live' ? 'sidecar-tick-100ms' : 'sim-tick-1s' })
          const recent = fpS.buckets.slice(-n)
          const qualifies = (side: 'buy' | 'sell'): boolean => {
            if (recent.length < n) return false
            return recent.every((b) => {
              if (b.nTicks < 3) return false
              let pocRow: (typeof b.rows)[number] | undefined
              for (const row of b.rows) if (!pocRow || row.total > pocRow.total) pocRow = row
              if (!pocRow) return false
              return side === 'buy' ? (pocRow.dn > 0 ? pocRow.up / pocRow.dn >= ratio : pocRow.up > 0) : pocRow.up > 0 ? pocRow.dn / pocRow.up >= ratio : pocRow.dn > 0
            })
          }
          const buyStacked = qualifies('buy')
          const sellStacked = qualifies('sell')
          if (!buyStacked && !sellStacked) return none(`Stacked imbalance: no ${n}-bucket diagonal stack on either side right now`)
          const direction = buyStacked ? 'call' : 'put'
          return { source, direction, confidence: 60, label: `Stacked imbalance ${direction.toUpperCase()} - ${n} consecutive bucket(s) at >=${ratio}x diagonal imbalance` }
        }
        case 'footAbsorption': {
          // Heavy print density packed into few price rows with closePos
          // staying mid-range despite a real delta - direction = the side
          // whose aggression got absorbed (a documented heuristic, see
          // otcfootprint.ts#footprintAbsorption's own header). Same
          // tick-buffer-required contract as 'footDivergence' above.
          const ofpA = this.ctx.use<OtcFootprintService>('otcFootprint')
          const ticksA = ofpA.ticksFor(asset)
          if (!ticksA.length) return none('Footprint absorption: tick buffer cold')
          const fpA = buildFootprint(ticksA, { minutes: 30, bucketSec: 60, asset, dataSourceLabel: this.market.mode === 'live' ? 'sidecar-tick-100ms' : 'sim-tick-1s' })
          const latestA = fpA.buckets[fpA.buckets.length - 1]
          if (!latestA || latestA.nTicks < 3) return none('Footprint absorption: thin bucket')
          const absA = footprintAbsorption(latestA)
          if (!absA.side) return none('Footprint absorption: no absorption read in the latest bucket')
          const direction = absA.side === 'buy' ? 'put' : 'call' // the absorbed side's aggression failed - contrarian tell
          return { source, direction, confidence: 55, value: absA.density, label: `Footprint absorption - ${absA.side} aggression absorbed (density ${absA.density}x, closePos ${(absA.closePos * 100).toFixed(0)}%)` }
        }
        case 'footUnfinishedAuction': {
          // POC sitting at the bucket's own high or low - reads toward the
          // stuck edge, low confidence since this names an unresolved state,
          // not a directional edge on its own. Same tick-buffer-required
          // contract as 'footDivergence' above.
          const ofpU = this.ctx.use<OtcFootprintService>('otcFootprint')
          const ticksU = ofpU.ticksFor(asset)
          if (!ticksU.length) return none('Unfinished auction: tick buffer cold')
          const fpU = buildFootprint(ticksU, { minutes: 30, bucketSec: 60, asset, dataSourceLabel: this.market.mode === 'live' ? 'sidecar-tick-100ms' : 'sim-tick-1s' })
          const latestU = fpU.buckets[fpU.buckets.length - 1]
          if (!latestU || latestU.nTicks < 3) return none('Unfinished auction: thin bucket')
          const uaU = unfinishedAuction(latestU)
          if (!uaU.side) return none('Unfinished auction: POC is not at either edge of the bucket')
          const direction = uaU.side === 'high' ? 'call' : 'put'
          return { source, direction, confidence: 45, label: `Unfinished auction - POC stuck at the bucket's ${uaU.side} (${latestU.pocPrice.toPrecision(6)})` }
        }
        case 'deltaProfile': {
          // Delta Profile - the 5th new chart type, deferred since Phase 6.
          // Direction from the window's own net deltaSkew; confidence
          // scaled by |deltaSkew|, same shape as the volumeProfile case.
          const candlesDp = this.market.getCandlesDeep(asset, tf, 300, true)
          const dp = computeDeltaProfile(candlesDp, { binCount: cfgNum(cfg, 'dp.binCount') })
          if (dp.totalVolume <= 0 || dp.deltaSkew === 0) return none('Delta Profile: no net delta lean in the window')
          const direction = dp.deltaSkew > 0 ? 'call' : 'put'
          const confidence = Math.min(100, 45 + Math.round(Math.abs(dp.deltaSkew) * 45))
          return { source, direction, confidence, value: dp.deltaSkew, label: `Delta Profile ${direction.toUpperCase()} - net delta skew ${(dp.deltaSkew * 100).toFixed(1)}% (${dp.method})` }
        }
      }
    } catch {
      return none(`${source}: not available (plugin not loaded or thin history)`)
    }
  }

  /** Full read map for the strategy-language evaluator (analytics/
   * strategylang.ts) - every source a script is allowed to reference, by
   * name, including a slot for each of the 15 SMC concepts' OWN "now"
   * read ('smc:<KIND>') so a script can combine "any of the smcs" freely
   * without the caller having to know in advance which ones it uses. Only
   * computed when a spec actually has a script (see evaluate() below) -
   * scanning all 15 SMC kinds plus Renko plus every Oracle driver on
   * every candidate would be wasted work for a conditions-built spec.
   *
   * `cfg` carries the script's own validated "configure <key> = <v>"
   * overrides (chart-engine knobs, tick bucket lengths, IV/HV window) -
   * applied ONLY here, per script evaluation, never to live plugin state.
   * Sources whose read carries a natural headline number also populate
   * `.value` (renko's signed streak, the expiry rungs' pWin, the tick
   * oracle's score, the tick technical net share, the tick footprint's
   * signed one-sided share) so scripts can threshold RAW metrics. */
  private buildScriptReads(asset: string, tf: Timeframe, cfg?: Record<string, number | boolean | string>): Record<string, MslSourceRead> {
    const toMsl = (r: MetaSourceRead): MslSourceRead => ({ direction: r.direction, confidence: r.confidence, ...(r.value !== undefined ? { value: r.value } : {}) })
    const reads: Record<string, MslSourceRead> = {
      oracle: toMsl(this.readSource('oracle', asset, tf)),
      hmaRocBullBear: toMsl(this.readSource('hmaRocBullBear', asset, tf)),
      momentumScore: toMsl(this.readSource('momentumScore', asset, tf)),
      accute: toMsl(this.readSource('accute', asset, tf)),
      renko: toMsl(this.readSource('renko', asset, tf, undefined, undefined, undefined, cfg)),
      smc: toMsl(this.readSource('smc', asset, tf)),
      smcNow: toMsl(this.readSource('smcNow', asset, tf)),
      ict: toMsl(this.readSource('ict', asset, tf)),
      renkoSmc: toMsl(this.readSource('renkoSmc', asset, tf, undefined, undefined, undefined, cfg)),
      renkoSmcMajority: toMsl(this.readSource('renkoSmcMajority', asset, tf, undefined, undefined, undefined, cfg)),
      pointFigure: toMsl(this.readSource('pointFigure', asset, tf, undefined, undefined, undefined, cfg)),
      rangeBars: toMsl(this.readSource('rangeBars', asset, tf, undefined, undefined, undefined, cfg)),
      candle: toMsl(this.readSource('candle', asset, tf)),
      bar: toMsl(this.readSource('bar', asset, tf)),
      heikinAshi: toMsl(this.readSource('heikinAshi', asset, tf)),
      line: toMsl(this.readSource('line', asset, tf)),
      area: toMsl(this.readSource('area', asset, tf)),
      baseline: toMsl(this.readSource('baseline', asset, tf)),
      volumeBars: toMsl(this.readSource('volumeBars', asset, tf, undefined, undefined, undefined, cfg)),
      tick: toMsl(this.readSource('tick', asset, tf)),
      footprint: toMsl(this.readSource('footprint', asset, tf)),
      otcFootprint: toMsl(this.readSource('otcFootprint', asset, tf)),
      tpo: toMsl(this.readSource('tpo', asset, tf, undefined, undefined, undefined, cfg)),
      ivHv: toMsl(this.readSource('ivHv', asset, tf, undefined, undefined, undefined, cfg)),
      tickSmc: toMsl(this.readSource('tickSmc', asset, tf, undefined, undefined, undefined, cfg)),
      tickOracle: toMsl(this.readSource('tickOracle', asset, tf, undefined, undefined, undefined, cfg)),
      tickTechnical: toMsl(this.readSource('tickTechnical', asset, tf, undefined, undefined, undefined, cfg)),
      tickFootprint: toMsl(this.readSource('tickFootprint', asset, tf, undefined, undefined, undefined, cfg)),
      technical: toMsl(this.readSource('technical', asset, tf)),
      reversal: toMsl(this.readSource('reversal', asset, tf)),
      tempo: toMsl(this.readSource('tempo', asset, tf)),
      confluence: toMsl(this.readSource('confluence', asset, tf)),
      volArb: toMsl(this.readSource('volArb', asset, tf)),
      cointegration: toMsl(this.readSource('cointegration', asset, tf)),
      screenerRank: toMsl(this.readSource('screenerRank', asset, tf)),
      chartSignals: toMsl(this.readSource('chartSignals', asset, tf)),
      leadLag: toMsl(this.readSource('leadLag', asset, tf)),
      yesterday: toMsl(this.readSource('yesterday', asset, tf)),
      volumeProfile: toMsl(this.readSource('volumeProfile', asset, tf, undefined, undefined, undefined, cfg)),
      lineBreak: toMsl(this.readSource('lineBreak', asset, tf, undefined, undefined, undefined, cfg)),
      kagi: toMsl(this.readSource('kagi', asset, tf, undefined, undefined, undefined, cfg)),
      swing: toMsl(this.readSource('swing', asset, tf, undefined, undefined, undefined, cfg)),
      effort: toMsl(this.readSource('effort', asset, tf, undefined, undefined, undefined, cfg)),
      mrc: toMsl(this.readSource('mrc', asset, tf, undefined, undefined, undefined, cfg)),
      outcomeMemory: toMsl(this.readSource('outcomeMemory', asset, tf, undefined, undefined, undefined, cfg)),
      pulse: toMsl(this.readSource('pulse', asset, tf, undefined, undefined, undefined, cfg)),
      footDivergence: toMsl(this.readSource('footDivergence', asset, tf)),
      footStackedImbalance: toMsl(this.readSource('footStackedImbalance', asset, tf, undefined, undefined, undefined, cfg)),
      footAbsorption: toMsl(this.readSource('footAbsorption', asset, tf)),
      footUnfinishedAuction: toMsl(this.readSource('footUnfinishedAuction', asset, tf)),
      deltaProfile: toMsl(this.readSource('deltaProfile', asset, tf)),
    }
    // Tick-desk reads for scripts: bare keys = each engine's own default read
    // (SMC 15s, oracle best bucket, technical best-rated bucket, footprint
    // 60s) plus 'tickOracle:<SEC>' and 'tickTechnical:<SEC>' pinned-bucket
    // keys (same 'source:<KIND>' convention as smc:<KIND> and
    // nextExpiry:<E> - the part after the colon is part of the identifier).
    // ONE computeTickOracle/computeTickTechnical call feeds all their keys.
    try {
      const ticks = this.tickBuffer(asset)
      if (ticks?.length) {
        const oracle = computeTickOracle(ticks, cfgNum(cfg, 'tickOracle.bucketSec') !== undefined ? { bucketsSec: [cfgNum(cfg, 'tickOracle.bucketSec') as number] } : {})
        for (const sec of ORACLE_BUCKETS_SEC) {
          const row = oracle.rows.find((r) => r.bucketSec === sec)
          reads[`tickOracle:${sec}`] = row && row.ok && row.direction !== 'none' ? { direction: row.direction, confidence: row.confidence, value: row.score } : { direction: 'none', confidence: 0 }
        }
        const tech = computeTickTechnical(ticks)
        for (const b of tech.buckets) {
          const total = b.summary.buy + b.summary.sell
          const net = total > 0 ? (b.summary.buy - b.summary.sell) / total : 0
          reads[`tickTechnical:${b.bucketSec}`] = b.ok && Math.abs(net) >= 0.2 ? { direction: net > 0 ? 'call' : 'put', confidence: Math.min(100, Math.round(40 + Math.abs(net) * 100)), value: net } : { direction: 'none', confidence: 0 }
        }
      } else {
        for (const sec of ORACLE_BUCKETS_SEC) reads[`tickOracle:${sec}`] = { direction: 'none', confidence: 0 }
      }
    } catch {
      for (const sec of ORACLE_BUCKETS_SEC) reads[`tickOracle:${sec}`] = { direction: 'none', confidence: 0 }
    }
    // Next-Expiry Oracle reads for scripts: bare 'nextExpiry' = the best
    // pick (engine honesty floors already applied, null best = none) and
    // 'nextExpiry:<E>' for each ladder rung (1/2/3/5/15) - same smc:<KIND>
    // convention, so a script can pin a horizon without a new language
    // keyword. ONE predict() call feeds all six keys; the plugin's pending
    // dedupe makes the extra poll idempotent on the honesty ledger anyway.
    try {
      const expiryOracle = this.ctx.use<NextExpiryService>('nextexpiry')
      const pred = expiryOracle.predict(asset)
      reads.nextExpiry = pred?.best ? { direction: pred.best.direction, confidence: pred.best.confidence, value: pred.best.pWin } : { direction: 'none', confidence: 0 }
      for (const E of EXPIRIES_MIN) {
        const rung = pred?.rows.find((r) => r.expiry === E)
        reads[`nextExpiry:${E}`] = rung && rung.ok && rung.direction !== 'none' ? { direction: rung.direction, confidence: rung.confidence, value: rung.pWin } : { direction: 'none', confidence: 0 }
      }
      // Footprint-completion follow-up (closes a gap flagged in the
      // capability matrix since Phase 8): until now, a script using the
      // bare `nextExpiry` source could see WHAT the oracle's fused best
      // pick thinks (direction/confidence/pWin, via .value) but never
      // WHICH expiry rung (1/2/3/5/15m) that pick actually was -
      // pred.best.expiry existed on the engine's own predict() result the
      // whole time, it just never got its own read. 'nextExpiryBest' is
      // this missing field, exposed the same shape every other MSL source
      // uses (direction mirrors the bare nextExpiry pick so a script can
      // still gate on it the normal way; .value is the chosen expiry in
      // MINUTES, not a probability - documented here and in /signal_vocab
      // precisely because every other nextExpiry* source's .value is a
      // 0-1 probability, so a script reading the wrong one by habit would
      // otherwise silently misinterpret a "5" as "500% win probability").
      reads.nextExpiryBest = pred?.best
        ? { direction: pred.best.direction, confidence: pred.best.confidence, value: pred.best.expiry }
        : { direction: 'none', confidence: 0 }
    } catch {
      reads.nextExpiry = { direction: 'none', confidence: 0 }
      for (const E of EXPIRIES_MIN) reads[`nextExpiry:${E}`] = { direction: 'none', confidence: 0 }
      reads.nextExpiryBest = { direction: 'none', confidence: 0 }
    }
    // Phase 8 of the chart-engine expansion roadmap (binary-options-specific
    // intelligence): the account's REAL current binary payout fraction
    // (0-1) for this asset, as a plain VALUE-only read (no direction - a
    // payout rate has no up/down lean of its own, so it is deliberately
    // NOT forced into a call/put verdict, same honest-no-guess rule
    // 'baseline'/IV-ratio/etc already follow for non-directional data).
    // This is the first place MSL can see payout at all - every expected-
    // value/breakeven calc a script wants (breakeven win-rate needed =
    // 1/(1+payout), EV per $1 staked = winProb*payout - (1-winProb)) is
    // now directly expressible from `payout.value` with plain arithmetic,
    // no new primitive needed for the derived math itself. 0 (not a
    // misleading default like 0.8) when the account reports no payout for
    // this instrument (e.g. a CFD-only asset with no binary/turbo option).
    try {
      const payoutRate = this.market.payoutFor(asset, 'binary')
      reads.payout = { direction: 'none', confidence: 0, value: Number.isFinite(payoutRate) && payoutRate > 0 ? payoutRate : 0 }
    } catch {
      reads.payout = { direction: 'none', confidence: 0, value: 0 }
    }
    // Footprint-completion sweep: closes the "OTC/weekend-session
    // awareness" gap flagged since Phase 8 - no asset.otc()/session flag
    // existed in MSL at all, so a script had no way to tell a genuinely
    // generator-driven OTC/synthetic-weekend instrument apart from a real
    // market one, even though AssetInfo.otc already carries exactly that
    // flag server-side (types.ts) and the auto-trader's own "OTC defense
    // gate" (os-mode.ts) already treats the two very differently. Both are
    // VALUE-ONLY reads, same honest-no-guess shape as 'payout' immediately
    // above - neither an OTC flag nor a weekday number has a directional
    // lean of its own, so neither is ever forced into a call/put verdict.
    // 'otc': 1 when this asset is the OTC/synthetic-generator variant
    // (AssetInfo.otc), 0 for a real-market instrument or if asset lookup
    // fails (the honest "don't know, assume real market" default - never
    // silently treat an unknown asset as OTC, which would suppress trust
    // in a real feed for no reason).
    try {
      const info = this.market.listAssets().find((a) => a.ticker === asset)
      reads.otc = { direction: 'none', confidence: 0, value: info?.otc ? 1 : 0 }
    } catch {
      reads.otc = { direction: 'none', confidence: 0, value: 0 }
    }
    // 'session': wall-clock weekend flag (1 = Sat/Sun UTC, when every real-
    // market instrument is closed and only OTC/synthetic pairs trade at
    // all - 0 otherwise). Deliberately UTC, not the user's local day - IQ
    // Option's own market calendar runs on UTC weekends, and a local-time
    // read would disagree with the broker's actual open/closed state for
    // roughly half the world. Combine with `otc` above for the literal
    // "weekend AND this asset is the synthetic generator" check a script
    // would actually want, e.g. `call when otc.value == 1 and session.value == 1 and ...`.
    {
      const day = new Date().getUTCDay() // 0=Sun, 6=Sat
      reads.session = { direction: 'none', confidence: 0, value: day === 0 || day === 6 ? 1 : 0 }
    }
    try {
      const smc = this.ctx.use<SmcScanService>('smcScan')
      const resp = smc.scan(asset, tf)
      for (const kind of ALL_SMC_KINDS) {
        const read = resp.result ? smcNowRead(resp.result, kind) : { direction: 'none' as const, confidence: 0 }
        reads[`smc:${kind}`] = { direction: read.direction, confidence: read.confidence }
      }
    } catch {
      for (const kind of ALL_SMC_KINDS) reads[`smc:${kind}`] = { direction: 'none', confidence: 0 }
    }
    // Technical Summary + Reversal reads PER RUNG - the bare 'technical'/
    // 'reversal' keys above only ever give the whole-ladder consensus or
    // the single most-urgent rung; per direct request ("the technical
    // indicator panel at 1 sec, 2 sec, 3 sec... says strong buy... and
    // reversal panel at 1 sec, 2sec... is not reversing") a script needs
    // to test EACH rung independently, same 'source:<KIND>' colon
    // convention as smc:<KIND>/nextExpiry:<E>/tickOracle:<SEC> above - the
    // part after the colon is one of TECH_LADDER's own tf tokens (1s/2s/
    // 3s/5s/15s/30s/1m/2m/3m/5m/...), identical rungs both panels share.
    // ONE rowFor() call per engine feeds every rung key, same one-call-
    // feeds-every-key shape as the tick-desk block above.
    // Technical: direction/confidence mirror the bare 'technical' case's
    // own formula exactly (score -1..1, confidence 40+|score|*80, clamped
    // 100) - a STRONG BUY/STRONG SELL rung (|score|>=0.5) always reads
    // >=80 confidence, a plain BUY/SELL (|score|>=0.15) reads 52-79, so
    // "says strong buy" is simply `.dir == call and .conf >= 80` (or
    // `.value >= 0.5`) while "says buy" (strong or not) is `.dir == call`.
    try {
      const tech = this.ctx.use<TechnicalService>('technical')
      let priceHint = 0
      try {
        priceHint = this.market.getPrice(asset)
      } catch {
        /* rowFor handles a 0 hint */
      }
      const row = tech.rowFor(asset, priceHint)
      for (const rung of TECH_LADDER) {
        const cell = row.cells.find((c) => c.tf === rung.tf)
        if (!cell || !cell.ok || cell.label === 'NEUTRAL') {
          reads[`technical:${rung.tf}`] = { direction: 'none', confidence: 0 }
          continue
        }
        const dir: 'call' | 'put' = cell.score >= 0 ? 'call' : 'put'
        reads[`technical:${rung.tf}`] = { direction: dir, confidence: Math.min(100, Math.round(40 + Math.abs(cell.score) * 80)), value: cell.score }
      }
    } catch {
      for (const rung of TECH_LADDER) reads[`technical:${rung.tf}`] = { direction: 'none', confidence: 0 }
    }
    // Reversal: same honesty rule as the bare 'reversal' case - a rung only
    // claims a direction in its two TRADEABLE states ('reversing' now or
    // 'confirmed'); 'calm'/'forming' honestly reads none, so "is NOT
    // reversing" at a rung is simply `.dir == none` (or `not reversal:1s.active`).
    try {
      const rev = this.ctx.use<ReversalService>('reversal')
      let priceHint = 0
      try {
        priceHint = this.market.getPrice(asset)
      } catch {
        /* rowFor handles a 0 hint */
      }
      const row = rev.rowFor(asset, priceHint)
      for (const rung of TECH_LADDER) {
        const cell = row.cells.find((c) => c.tf === rung.tf)
        if (!cell || !cell.ok || (cell.state !== 'reversing' && cell.state !== 'confirmed') || cell.direction === 'none') {
          reads[`reversal:${rung.tf}`] = { direction: 'none', confidence: 0 }
          continue
        }
        const dir: 'call' | 'put' = cell.direction === 'up' ? 'call' : 'put'
        reads[`reversal:${rung.tf}`] = { direction: dir, confidence: Math.min(100, Math.round(35 + Math.abs(cell.score) * 15)), value: cell.score }
      }
    } catch {
      for (const rung of TECH_LADDER) reads[`reversal:${rung.tf}`] = { direction: 'none', confidence: 0 }
    }
    return reads
  }

  /** Evaluate a saved meta-strategy for one asset+tf right now. Script,
   * when the spec has one, always wins over conditions (see
   * MetaStrategySpec.script's doc comment) - this is the one place that
   * decision is made, so Meta Trader's 'meta-strategy' source and the
   * /meta_strategy_eval REST route both get it for free. */
  evaluate(id: string, asset: string, tf: Timeframe): { spec: MetaStrategySpec; result: MetaEvalResult; price: number } {
    const spec = this.get(id)
    if (!spec) throw new Error(`unknown meta-strategy ${id}`)
    const result = spec.script ? this.evaluateScript(spec.id, spec.script, asset, tf) : this.evaluateConditions(spec, asset, tf)
    let price = 0
    try {
      price = this.market.getPrice(asset)
    } catch {
      /* price stays 0 - caller treats that as "not tradeable right now" */
    }
    return { spec, result, price }
  }

  /** Same contract as evaluate(), but ALSO threads live sub-bar data
   * (the forming bar + raw tick buffer) into the script - the omni-
   * trader's own read path, for a spec that wants `live()`/`tick.*`
   * reactivity instead of waiting for `evaluate()`'s candle-close-only
   * view. Only meaningful for a SCRIPT spec (conditions-built specs never
   * touch strategylang.ts's evaluator at all, so there's nothing to feed
   * live data into) - a conditions-only spec id fails closed here rather
   * than silently falling back to the non-live path, so the caller always
   * knows whether it actually got live reactivity. */
  evaluateLive(
    id: string,
    asset: string,
    tf: Timeframe,
    live: { bar?: MslBarValue; ticks?: readonly { ts: number; price: number }[]; nowMs?: number },
  ): { spec: MetaStrategySpec; result: MetaEvalResult; price: number } {
    const spec = this.get(id)
    if (!spec) throw new Error(`unknown meta-strategy ${id}`)
    if (!spec.script) {
      return {
        spec,
        result: { direction: 'none', score: 0, confidence: 0, conditions: [], notes: 'omni-trader needs a SCRIPT meta-strategy (live()/tick.* reactivity) - this spec is conditions-built' },
        price: 0,
      }
    }
    const result = this.evaluateScript(spec.id, spec.script, asset, tf, live)
    let price = 0
    try {
      price = this.market.getPrice(asset)
    } catch {
      /* price stays 0 - caller treats that as "not tradeable right now" */
    }
    return { spec, result, price }
  }

  private evaluateConditions(spec: MetaStrategySpec, asset: string, tf: Timeframe): MetaEvalResult {
    const reads = spec.conditions.map((c) => this.readSource(c.source, asset, tf, c.smcKind, c.expiryMin, c.tickBucketSec))
    return evaluateMetaStrategy(spec, reads)
  }

  /** Build the AI-Lab signal resolver for a meta script - the SAME signal
   * vocabulary the AI Lab's own code editor uses (candle/bar/ha/line/renko/
   * pf/mtf/indicator/indicatorType/indicatorPeriod/builtinSig/engine),
   * evaluated by custom.ts's own signalActive() on this pair's deep candles.
   * Per direct instruction ("let msl have access to all our indicators and
   * strategies") a Meta-Strategy script can now call any of them, not just
   * read the named panel sources. Returns undefined on a thin history (<40
   * closed candles - the chart engines' own floor) - the script then runs
   * reads-only and a signal call fails the script closed, same as before.
   * `cfg` threads the script's validated strategy.<id>.<param> overrides
   * into builtinSig() calls. */
  private scriptResolver(asset: string, tf: Timeframe, cfg?: Record<string, number | boolean | string>): ReturnType<typeof makeSignalResolver> | undefined {
    try {
      const candles = this.market.getCandlesDeep(asset, tf, 240, true)
      if (candles.length < 40) return undefined
      return makeSignalResolver(buildCtx(candles, asset), candles.length - 1, cfg)
    } catch {
      return undefined
    }
  }

  /** MSL's `ind.*`/`ohlc()` primitives need the raw per-bar OHLCV arrays
   * directly (not the resolver-wrapped signal vocabulary) - built from the
   * SAME candle fetch buildCtx() already uses for scriptResolver(), so a
   * script gets both without a duplicate history read. Returns undefined on
   * the same thin-history floor as scriptResolver() (ind.* / ohlc() calls
   * then fail the script closed, same fail-closed convention as every other
   * runtime error here). */
  private scriptSeries(asset: string, tf: Timeframe): MslSeriesCtx | undefined {
    try {
      const candles = this.market.getCandlesDeep(asset, tf, 240, true)
      if (candles.length < 40) return undefined
      return {
        open: candles.map((k) => k.open),
        high: candles.map((k) => k.high),
        low: candles.map((k) => k.low),
        close: candles.map((k) => k.close),
        volume: candles.map((k) => k.volume ?? 0),
      }
    } catch {
      return undefined
    }
  }

  /** `since()`/`streak()`'s dedup key - the native tf's latest CLOSED
   * bar's own open time (epoch seconds), same convention Candle.time
   * already uses. Cheap (2-candle fetch): called once per evaluateScript()
   * call, not per since()/streak() call site. Returns undefined on a
   * fetch failure - since()/streak() then fail the script closed via
   * EvalEnv.barTimeSec being absent, same convention as every other MSL
   * primitive here. */
  private scriptBarTimeSec(asset: string, tf: Timeframe): number | undefined {
    try {
      const candles = this.market.getCandlesDeep(asset, tf, 2, true)
      return candles.length ? candles[candles.length - 1].time : undefined
    } catch {
      return undefined
    }
  }

  /** MSL's cross-timeframe `ind.rsi(14, "5m")` / `ohlc(-1, "5m")` -
   * builds a memoized `(tf) => MslSeriesCtx | undefined` resolver so a
   * script referencing the SAME other-timeframe tf more than once (e.g.
   * `ind.ema(8, "5m")` and `ind.ema(21, "5m")` in the same script) only
   * fetches that tf's candle history once per evaluateScript()/testScript()
   * call, not once per call site. An unrecognized string (not a real
   * Timeframe) or a too-thin history both resolve to undefined - the
   * evaluator's own requireSeries() turns that into the script's "no data
   * for that tf" error, same fail-closed convention as every other MSL
   * runtime error. */
  private scriptSeriesFor(asset: string): (tf: string) => MslSeriesCtx | undefined {
    const cache = new Map<string, MslSeriesCtx | undefined>()
    return (tf: string) => {
      if (cache.has(tf)) return cache.get(tf)
      const known: readonly string[] = ['5s', '15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d']
      const result = known.includes(tf) ? this.scriptSeries(asset, tf as Timeframe) : undefined
      cache.set(tf, result)
      return result
    }
  }

  /** Run a strategy-language script against one asset+tf's current
   * source reads, shaped as a MetaEvalResult so it's a drop-in for
   * evaluateMetaStrategy's conditions-built result - every caller
   * (Meta Trader, the REST eval route, this service's own evaluate())
   * gets the same {direction, score, confidence, notes} shape either
   * way, never needing to know which path a given spec took.
   *
   * TWO-PASS because a script's "configure" lines must be known before the
   * reads they affect can be built: pass 1 evaluates on default reads and
   * collects the configure statements; if there are none, pass 1 IS the
   * result. Otherwise the configs are whitelist-validated (unknown key /
   * bad range / unknown strategy id = script error, fail closed), the reads
   * are rebuilt with them applied and the resolver re-threaded, and pass 2's
   * result wins. A script's own configure lines therefore change how ITS
   * sources are computed while never touching live plugin state. */
  private evaluateScript(
    specId: string,
    script: string,
    asset: string,
    tf: Timeframe,
    live?: { bar?: MslBarValue; ticks?: readonly { ts: number; price: number }[]; nowMs?: number },
  ): MetaEvalResult {
    const parsed = parseStrategyScript(script)
    if (!parsed.ok) return { direction: 'none', score: 0, confidence: 0, conditions: [], notes: `script error: ${parsed.error}` }
    const reads = this.buildScriptReads(asset, tf)
    const series = this.scriptSeries(asset, tf)
    const seriesFor = this.scriptSeriesFor(asset)
    // `since()`/`streak()` scope - keyed by THIS spec's id (so two specs
    // reading an identically-worded condition never share memory) plus
    // asset+tf (so the same spec watching two pairs, or the same pair on
    // two timeframes, tracks each independently); barTimeSec is what lets
    // MslStateStore tell "still the same closed bar" from "a new one just
    // closed" apart across repeat polls.
    const state = { keyPrefix: `${specId}|${asset}|${tf}`, barTimeSec: this.scriptBarTimeSec(asset, tf) }
    const out = evaluateStrategyScript(parsed.ast, reads, this.scriptResolver(asset, tf), series, seriesFor, live, state)
    if (!out.error && out.configs) {
      try {
        validateMslConfigs(out.configs)
      } catch (err) {
        return { direction: 'none', score: 0, confidence: 0, conditions: [], notes: `script error: ${err instanceof Error ? err.message : String(err)}` }
      }
      const reads2 = this.buildScriptReads(asset, tf, out.configs)
      const out2 = evaluateStrategyScript(parsed.ast, reads2, this.scriptResolver(asset, tf, out.configs), series, seriesFor, live, state)
      return this.scriptMetaResult(out2)
    }
    return this.scriptMetaResult(out)
  }

  private scriptMetaResult(out: MslEvalResult): MetaEvalResult {
    const score = out.confidence * (out.direction === 'call' ? 1 : out.direction === 'put' ? -1 : 0)
    const notes = out.error ? `script error: ${out.error}` : out.trace.join(' · ') || `script: ${out.direction} ${out.confidence}%`
    return {
      direction: out.direction,
      score,
      confidence: out.confidence,
      conditions: [],
      notes,
      ...(out.expiryMin !== undefined ? { expiryMin: out.expiryMin } : {}),
    }
  }

  /** Dry-run a strategy-script string against one asset+tf WITHOUT saving
   * it - the Meta Strategy Lab's "test" button in its code editor, so a
   * script can be iterated on before committing it (save() still
   * re-validates the syntax on its own, this is purely for live preview).
   * Same two-pass configure contract as evaluateScript; surfaces the
   * script's preferred expiryMin when it set one. */
  testScript(script: string, asset: string, tf: Timeframe): { ok: boolean; direction?: 'call' | 'put' | 'none'; confidence?: number; expiryMin?: number; trace?: string[]; price?: number; error?: string } {
    const parsed = parseStrategyScript(script)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const reads = this.buildScriptReads(asset, tf)
    const series = this.scriptSeries(asset, tf)
    const seriesFor = this.scriptSeriesFor(asset)
    // Test-button preview: not a saved spec, so there's no real spec id to
    // scope since()/streak() under - 'test' + asset + tf is stable enough
    // across repeated clicks on the SAME script/pair for a human to see the
    // counters move sensibly, and never collides with a real `meta:...` id.
    const state = { keyPrefix: `test|${asset}|${tf}`, barTimeSec: this.scriptBarTimeSec(asset, tf) }
    const out = evaluateStrategyScript(parsed.ast, reads, this.scriptResolver(asset, tf), series, seriesFor, undefined, state)
    if (out.error) return { ok: false, error: out.error }
    let final = out
    if (out.configs) {
      try {
        validateMslConfigs(out.configs)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      const reads2 = this.buildScriptReads(asset, tf, out.configs)
      final = evaluateStrategyScript(parsed.ast, reads2, this.scriptResolver(asset, tf, out.configs), series, seriesFor, undefined, state)
      if (final.error) return { ok: false, error: final.error }
    }
    let price = 0
    try {
      price = this.market.getPrice(asset)
    } catch {
      /* price stays 0 */
    }
    return { ok: true, direction: final.direction, confidence: final.confidence, ...(final.expiryMin !== undefined ? { expiryMin: final.expiryMin } : {}), trace: final.trace, price }
  }

  /** Same shape as buildScriptReads(), but computes ONLY the sources in
   * SAFE_BACKTEST_SOURCES directly via readSource() - every other key
   * defaults to an inert `{direction:'none',confidence:0}` WITHOUT ever
   * calling the plugin that owns it. This is deliberately a separate,
   * narrower function rather than a flag on buildScriptReads(): that
   * function's whole contract is "compute the full map, unconditionally,
   * every call" (see its own doc comment), which is exactly what must NOT
   * happen during a backtest replay (see SAFE_BACKTEST_SOURCES' doc
   * comment on why calling smcScan/accute/nextexpiry/etc. during replay
   * would corrupt their real accuracy-tracking state, not just read stale
   * data) - backtestMeta() only ever reaches here after confirming (via
   * collectFieldSources) the script doesn't reference any of those keys
   * anyway, so leaving them 'none' here changes nothing the script reads. */
  private buildReplaySafeReads(asset: string, tf: Timeframe, cfg?: Record<string, number | boolean | string>): Record<string, MslSourceRead> {
    const toMsl = (r: MetaSourceRead): MslSourceRead => ({ direction: r.direction, confidence: r.confidence, ...(r.value !== undefined ? { value: r.value } : {}) })
    const none: MslSourceRead = { direction: 'none', confidence: 0 }
    const reads: Record<string, MslSourceRead> = {}
    for (const s of META_CONDITION_SOURCES) reads[s] = none
    for (const s of SAFE_BACKTEST_SOURCES) {
      reads[s] =
        s === 'candle' || s === 'bar' || s === 'heikinAshi' || s === 'line' || s === 'area' || s === 'baseline' || s === 'deltaProfile' || s === 'technical' || s === 'reversal'
          ? toMsl(this.readSource(s, asset, tf))
          : toMsl(this.readSource(s, asset, tf, undefined, undefined, undefined, cfg))
    }
    // The three value-only reads (payout/otc/session) are cheap, side-
    // effect-free, and not plugin-scan-dependent - same blocks buildScriptReads
    // uses, duplicated here rather than factored out so this function stays
    // self-contained and obviously safe to audit on its own.
    try {
      const payoutRate = this.market.payoutFor(asset, 'binary')
      reads.payout = { direction: 'none', confidence: 0, value: Number.isFinite(payoutRate) && payoutRate > 0 ? payoutRate : 0 }
    } catch {
      reads.payout = { direction: 'none', confidence: 0, value: 0 }
    }
    try {
      const info = this.market.listAssets().find((a) => a.ticker === asset)
      reads.otc = { direction: 'none', confidence: 0, value: info?.otc ? 1 : 0 }
    } catch {
      reads.otc = { direction: 'none', confidence: 0, value: 0 }
    }
    return reads
  }

  /**
   * Backtest a saved Meta-Strategy spec (conditions-built OR script-built)
   * over its own asset's REAL archived candle history.
   *
   * Mechanism: this is a bar-by-bar replay, same shape as strategies/
   * backtest.ts's binary-mode loop, except each step calls market's
   * setReplayAsof(candle.time) FIRST so every candle-derived read anywhere
   * under evaluate() - renko, technical/reversal's whole ladder, the MSL
   * `ind.*`/`renko.*`/etc. signal-function vocabulary - transparently sees
   * ONLY bars up to that point, not the live feed (see market-data.ts's
   * replayAsof). `inReplay` additionally bypasses Technical/Reversal's TTL
   * cache (wall-clock-keyed, meaningless against a simulated asof clock)
   * and ladderdata.ts's gatherTicks() honestly degrades the 1s/2s/3s rungs
   * to "not ok" (no archived tick history exists to replay).
   *
   * Safety gate (see SAFE_BACKTEST_SOURCES/UNSAFE_BACKTEST_SOURCES): a spec
   * that references ANY source reading another plugin's live-only scan
   * cache or tick buffer is rejected up front, naming the exact source,
   * rather than silently running a replay that would either read garbage
   * or corrupt that plugin's own real-time stats. A script spec additionally
   * NEVER goes through evaluateScript()/buildScriptReads() during replay -
   * buildReplaySafeReads() above computes only the safe subset directly, so
   * there is no path by which replay can reach an unsafe plugin even
   * transiently.
   */
  backtestMeta(
    id: string,
    asset: string,
    tf: Timeframe,
    opts: { amount?: number; payout?: number; expiryBars?: number; warmupBars?: number; startEquity?: number } = {},
  ): BacktestResult {
    const spec = this.get(id)
    if (!spec) throw new Error(`unknown meta-strategy ${id}`)
    let ast: MslAst | null = null
    if (spec.script) {
      const parsed = parseStrategyScript(spec.script)
      if (!parsed.ok) throw new Error(`${spec.id}: script error - ${parsed.error}`)
      ast = parsed.ast
      for (const name of collectFieldSources(ast)) {
        // AUDIT FIX: a colonized source (smc:CHOCH, tickOracle:60,
        // tickTechnical:300, nextExpiry:5, ...) was never literally a member
        // of UNSAFE_BACKTEST_SOURCES (only the bare 'smc'/'smcNow'/
        // 'tickOracle'/'tickTechnical'/'nextExpiry' names are), so a script
        // reading e.g. `smc:CHOCH.dir` sailed straight past this gate and
        // into a replay where that exact key was never populated at all
        // (buildReplaySafeReads() only fills SAFE_BACKTEST_SOURCES keys) -
        // not even 'none', just missing, which is a confusing per-bar
        // runtime error instead of the clear upfront rejection every other
        // unsafe source gets. 'technical:<TF>'/'reversal:<TF>' are NOT
        // affected (their bare names are already in SAFE_BACKTEST_SOURCES),
        // so stripping to the base name before checking is safe for those
        // too - it only ever makes the unsafe check MORE inclusive, never
        // rejects a safe colonized source by mistake.
        const base = name.includes(':') ? name.slice(0, name.indexOf(':')) : name
        if (UNSAFE_BACKTEST_SOURCES.has(base as MetaConditionSource)) {
          throw new Error(
            `${spec.id} uses '${name}' - that source reads another plugin's LIVE-only scan cache or tick buffer with no historical record, so it can't be honestly replayed. Remove it (it can stay in a separate live-only spec) to backtest the rest of this script.`
          )
        }
      }
    } else {
      if (!spec.conditions.length) throw new Error(`${spec.id} has no conditions and no script - nothing to backtest`)
      for (const c of spec.conditions) {
        if (!SAFE_BACKTEST_SOURCES.has(c.source)) {
          throw new Error(
            `${spec.id} uses condition source '${c.source}' - that source reads another plugin's LIVE-only scan cache or tick buffer with no historical record, so it can't be honestly replayed.`
          )
        }
      }
    }

    const candles: Candle[] = this.market.getCandlesDeep(asset, tf, 2200, true)
    if (candles.length < 300) throw new Error(`not enough candle history for a meaningful backtest (${candles.length} bars)`)

    const payout = opts.payout ?? 0.85
    const amount = Math.max(0.01, opts.amount ?? 10)
    const expiryBars = Math.max(1, opts.expiryBars ?? 1)
    const warmup = Math.max(40, Math.min(candles.length - 20, opts.warmupBars ?? 300)) // SAFE_BACKTEST_SOURCES engines want >=300 bars of their own warmup
    let equity = opts.startEquity ?? 1000
    const startEquity = equity
    const trades: BacktestTrade[] = []
    const equityCurve: { time: number; value: number }[] = []
    const rets: number[] = []
    let peak = equity
    let maxDD = 0

    this.inReplay = true
    try {
      for (let i = warmup; i < candles.length - expiryBars; i++) {
        this.market.setReplayAsof(candles[i].time)
        let result: MetaEvalResult
        try {
          result = spec.script
            ? this.scriptMetaResult(
                evaluateStrategyScript(ast!, this.buildReplaySafeReads(asset, tf), this.scriptResolver(asset, tf), this.scriptSeries(asset, tf), this.scriptSeriesFor(asset), undefined, {
                  keyPrefix: `backtest:${spec.id}|${asset}|${tf}`,
                  barTimeSec: candles[i].time,
                })
              )
            : this.evaluateConditions(spec, asset, tf)
        } catch (err) {
          result = { direction: 'none', score: 0, confidence: 0, conditions: [], notes: `replay error: ${err instanceof Error ? err.message : String(err)}` }
        }
        if (result.direction === 'none') continue
        const entry = candles[i].close
        const exitCandle = candles[i + expiryBars]
        const stake = Math.min(amount, equity)
        if (stake <= 0) break
        const won = result.direction === 'call' ? exitCandle.close > entry : exitCandle.close < entry
        const draw = exitCandle.close === entry
        const pnl = draw ? 0 : won ? stake * payout : -stake
        equity += pnl
        rets.push(pnl / Math.max(stake, 0.01))
        trades.push({
          ts: exitCandle.time,
          side: result.direction,
          entry,
          exit: exitCandle.close,
          amount: stake,
          pnl,
          status: draw ? 'push' : won ? 'won' : 'lost',
        })
        if (equity > peak) peak = equity
        const dd = peak - equity
        if (dd > maxDD) maxDD = dd
        equityCurve.push({ time: exitCandle.time, value: equity })
      }
    } finally {
      this.inReplay = false
      this.market.setReplayAsof(null)
    }

    const wins = trades.filter((t) => t.status === 'won').length
    const losses = trades.filter((t) => t.status === 'lost').length
    const grossWin = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0)
    const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0))
    const tsSorted = trades.map((t) => t.ts).sort((a, b) => a - b)
    let meanGapSec = 0
    if (tsSorted.length > 1) {
      let gaps = 0
      for (let i = 1; i < tsSorted.length; i++) gaps += tsSorted[i] - tsSorted[i - 1]
      meanGapSec = gaps / (tsSorted.length - 1)
    }
    const periodsPerYear = meanGapSec > 0 ? (365 * 24 * 3600) / meanGapSec : 252
    const byDirection = directionBreakdown(trades)

    return {
      strategy: spec.id,
      asset,
      tf,
      mode: 'binary',
      params: {},
      candlesTested: Math.max(0, candles.length - warmup),
      trades,
      equityCurve,
      metrics: {
        totalTrades: trades.length,
        wins,
        losses,
        winRate: wins + losses ? (wins / (wins + losses)) * 100 : 0,
        netPnl: equity - startEquity,
        profitFactor: grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss,
        maxDrawdown: maxDD,
        maxDrawdownPct: startEquity > 0 ? (maxDD / startEquity) * 100 : 0,
        sharpe: sharpeRatio(rets, periodsPerYear),
        expectancy: trades.length ? (equity - startEquity) / trades.length : 0,
        finalEquity: equity,
        startEquity,
        byDirection,
      },
    }
  }
}

export const metaStrategyPlugin: Plugin = {
  name: 'meta-strategy',
  start: async (ctx) => {
    const svc = new MetaStrategyService()
    ctx.provide('metaStrategy', svc)
    await svc.start(ctx)
  },
}
