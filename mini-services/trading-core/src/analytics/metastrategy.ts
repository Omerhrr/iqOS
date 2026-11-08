// IQAIR//OS - Meta-strategy combinator
//
// What this is: a way to build a strategy OUT OF the panels that already
// exist, instead of out of raw candles. "If the Next-Candle Oracle says
// call AND HMA/ROC/Bull-Bear says call AND Accute says call AND Renko says
// call, that's a signal" - the user's own framing. Every other strategy in
// this codebase (strategies/builtin.ts, strategies/custom.ts) recomputes
// its own read from the candle series; a meta-strategy instead reads the
// CURRENT VERDICT each engine already computed (the Oracle's fused
// pUp/confidence, Accute's fused driver, the Renko brick trend, SMC's
// structure summary, ...) and combines those verdicts with simple,
// inspectable rules. It never touches a candle directly.
//
// Deliberately NOT an arbitrary scripting language: letting the user hand
// an executable script to a live trading loop is a sandboxing problem with
// a 1000x bigger blast radius than the payoff. A meta-strategy spec is
// pure data (JSON-shaped) - a list of conditions ("this source, this
// direction, at least this confidence") plus one combine rule - so it's
// inspectable, diffable, and safe to run unattended, same spirit every
// other strategy spec in this codebase already follows.
//
// Pure module: this file only combines READS that are handed to it - it
// has no idea how to go GET an Oracle/Accute/Renko/SMC read for a given
// asset+tf (that needs live kernel services: NextCandleService,
// AccuteService, MarketDataService, SmcScanService). That live wiring
// lives in plugins/metastrategy.ts; this file is the part worth keeping
// pure and unit-testable on its own.

export type MetaConditionSource =
  | 'oracle' // Next-Candle Oracle's own fused pUp/confidence (analytics/nextcandle.ts)
  | 'hmaRocBullBear' // the Oracle panel's first secondary read (analytics/hmarocbullbear.ts)
  | 'momentumScore' // the Oracle panel's second secondary read, the user's own Market Momentum Score formula (analytics/momentumscore.ts)
  | 'nextExpiry' // Next-Expiry Oracle's own fused read (plugins/nextexpiry.ts) - minute-native (1/2/3/5/15m over the 1m base), so this read ignores the condition's tf exactly like its own panel does. By default it reads the oracle's single best pick (already gated by the engine's pWin>=0.56 AND confidence>=25 floors, honest "wait" -> none); a condition may pin ONE rung via its expiryMin field instead
  | 'accute' // Accute's fused multi-driver prediction (plugins/accute.ts)
  | 'renko' // Renko brick trend/streak (analytics/renko.ts, same read Accute's own renko leg uses)
  | 'smc' // Smart Money Concepts BLENDED structure summary (analytics/smc.ts's scanSmc().summary - mixes in older hits, not just this candle)
  | 'smcNow' // SMC "now" read (analytics/smc.ts's smcNowRead(), barsAgo===0 only) - aggregate across all 14 non-S&R concepts by default, or ONE concept via this condition's `smcKind` field ("build all the smc strats separately", same per-kind reads Meta Trader's own smc-<kind> sources use)
  | 'renkoSmc' // Renko trend + SMC "now" confluence, ANY-AGREES variant - Renko's direction fires as soon as ONE SMC concept agrees with it right now (analytics/smc.ts's smcAnyAgrees()), no vote/majority involved - same rule Meta Trader's 'renko-smc' source trades
  | 'renkoSmcMajority' // Renko trend + SMC "now" confluence, MAJORITY variant - requires SMC's own aggregate "now" verdict (smcNowRead(), majority of now-concepts) to match Renko's direction - stricter than renkoSmc above; kept as a separate source per direct instruction ("we can have the confluence version also tho, lets have both") rather than replacing one with the other
  | 'pointFigure' // Point & Figure column direction/streak (analytics/pointfigure.ts) - "not just renko, p&f, range and all others" per direct instruction
  | 'rangeBars' // Range bar trend/streak (analytics/rangebars.ts) - same "call any other chart" instruction; a different noise filter than Renko (fixed price span per bar vs. ATR-scaled brick + reversal multiplier)
  // Per direct instruction ("lets support all chats also... candle, bar,
  // heikin ashi, tpo, lines, area, baselins, volbars, foot print, tick,
  // iv-hv") - every chart TYPE this OS's own chart picker lists
  // (types.ts's ChartType) now has a meta-strategy condition source. Most
  // reuse analytics/chartsignals.ts's engine-vote committee (the exact
  // math the Signal Panel/Oracle's chart-engine driver already run) via
  // engineVoteSingle() - see plugins/metastrategy.ts's readSource() for
  // which function backs each one.
  | 'candle' // plain candlestick pattern read (chartsignals.ts candleVote - close position in range, 3-bar streak, engulfing)
  | 'bar' // OHLC bar chart - SAME data/math as 'candle' above, just a different rendering of the identical open-high-low-close series; kept as its own source so "bar" shows up by name, not because the math differs
  | 'heikinAshi' // Heikin Ashi smoothed-candle trend (chartsignals.ts haVote - HA streak + body dominance)
  | 'line' // line/area/baseline are the SAME close-only price series, three different renderings - no distinct math exists for them (there is no "line chart indicator"), so all three share one close-trend reduction (recent close vs N bars back, scaled by ATR) - see lineTrendVote() in plugins/metastrategy.ts
  | 'area' // see 'line' above - identical reduction, different chart-type name for the dropdown
  | 'baseline' // see 'line' above - identical reduction, different chart-type name for the dropdown
  | 'volumeBars' // constant-volume bar trend/streak (analytics/volumebars.ts) - same streak convention as Renko/Range, but bars close on cumulative volume instead of price distance; 'none' when the feed has no real volume (volumeBars().degenerate)
  // PRECISION FIX (operator noticed, while discussing AI Trader's own-math
  // overhaul, that 'tick' below was never actually wired to a real tick
  // buffer): readSource('tick') now passes the SAME otc-footprint tick
  // stream the tick-desk sources already read (ticksFor(asset)) into
  // chartsignals.ts's tickVote - when that buffer is cold/thin it still
  // falls back to the honest close-price proxy (tickVote's own contract),
  // so this never regresses to a worse answer than before, only a better
  // one once real prints exist.
  | 'tick' // tick-bar cadence read (chartsignals.ts tickVote) - REAL micro-tick stream when the otc-footprint collector has one buffered for this asset, close-price proxy fallback otherwise (tickVote's own honest degrade, same one used when no buffer exists at all)
  | 'footprint' // volume footprint CLV-proxy delta (chartsignals.ts footprintVote) - same CLV approximation orderflow.ts uses everywhere else in this codebase, since IQ Option exposes no real bid/ask-tagged trades
  // otcFootprint: the REAL print-SPEED/velocity engine (analytics/otcfootprint.ts's
  // buildFootprint, same one plugins/otcfootprint.ts's async footprint()
  // wraps - this calls the identical pure function directly, sync, off
  // whatever ticks are already buffered, so it never forces a fresh live
  // pull from inside a condition read) - distinct from 'footprint' above
  // (that one is a CANDLE-close CLV proxy): this one is actual measured
  // up/down print speed and net delta, the same numbers the OTC Footprint
  // panel and AI Trader's own-math both already show.
  | 'otcFootprint'
  | 'tpo' // Market Profile / Time Price Opportunity (analytics/tpo.ts) - direction from price trading above/below the session's Point of Control, confidence scaled by distance relative to the 70% value-area width
  | 'ivHv' // Implied vs Historical Volatility (analytics/ivhv.ts) - NOT a volatility forecast (vol has no direction); the directional read here is the realized up-closing frequency over a trailing window vs 50% (same honest "realized WR vs breakeven" framing ivhv.ts's own module header uses)
  // Tick-desk sources (analytics/tickdesk.ts) - the SAME four engines the
  // Tick Desk chart tabs render, read off the RAW micro-tick stream the
  // otc-footprint collector buffers (sim = ~1s prints, live = sidecar 100ms
  // captures). These are real tick-built reads, not the close-proxy 'tick'
  // and CLV-proxy 'footprint' above - per direct instruction ("are they all
  // fully accessible in meta strategy") every tick-desk panel is now also a
  // condition source. All four fail closed exactly like their panels: a
  // warming/degenerate bucket reads 'none' with the engine's own note.
  | 'tickSmc' // Smart Money Concepts on tick-built candles (computeTickSmc, default 15s buckets) - swing structure, BOS/CHoCH, order blocks, FVGs, liquidity sweeps, premium/discount
  | 'tickOracle' // tick next-candle oracle (computeTickOracle) - by default the engine's own best bucket across the 1s..5m ladder; pin ONE bucket via this condition's tickBucketSec field. A bucket still warming up (ok:false) or two-sided (direction 'none') reads 'none', never a guess
  | 'tickTechnical' // investing.com-style technical summary over tick buckets (computeTickTechnical) - by default the best-rated ok bucket's summary; pin ONE bucket via tickBucketSec. Oscillators + MAs vote buy/sell/neutral, RATING_RULE aggregates to strong-buy..strong-sell
  | 'tickFootprint' // REAL tick footprint delta (computeTickFootprint, default 60s buckets) - measured up/down PRINT counts per price bin (not the CLV proxy); direction from the window's net delta, confidence from its share of total prints, gated on enough prints to matter
  // Remaining whole-OS panels that were NOT condition sources yet - per
  // direct instruction ("let msl have access to all our panels") every
  // direction-reporting panel this kernel runs is now reachable as a
  // condition/MSL source. All six fail closed exactly like their own
  // panels: a warming scan / thin history / no-row reads 'none' with the
  // panel's own note, never a guess.
  | 'technical' // the Technical Summary panel (analytics/technicals.ts, plugins/technical.ts): investing.com-style oscillator+MA vote ladder over 1s..5m; direction = the ladder-consensus verdict, confidence scaled by its (buys-sells)/counted score
  | 'reversal' // the Reversal Radar panel (analytics/reversal.ts, plugins/reversal.ts): 7 fail-closed detectors per rung; a read fires ONLY in the 'reversing'/'confirmed' states (calm/forming = no tradeable claim yet)
  | 'tempo' // the Tempo shot-license scanner (plugins/tempo.ts): direction counts ONLY on decision 'fire' (an unclaimed license this window) - wait/skip/done honestly read 'none'
  | 'confluence' // the Confluence Screener (plugins/screener.ts): the composite multi-model read (regime + OU stretch + patterns + structure) already scored per pair; direction/confidence straight off its ScreenRow
  | 'volArb' // the Volatility-Arbitrage scanner (plugins/volarbscan.ts): IV/HV ratio regime per pair - direction from its own fade/continue read, 'none' when the scanner reports balanced/no-lean
  | 'cointegration' // the Cointegration scanner (plugins/cointegrationscan.ts): spread-reversion z-score vs the pair's statistical leader; direction = the scanner's suggested reversion trade, gated on its own fit quality (beta/R2/half-life)
  // Per direct instruction ("not only the technical summary, wire summary
  // of any other panel into it, so we have full coverage") - the last four
  // panels that still had no condition/MSL source of their own, each fail-
  // closed the same way every source above already is.
  | 'screenerRank' // the market-wide Screener/Confluence board's row for THIS pair+tf (plugins/screener.ts) - same ScreenRow 'confluence' already reads, exposed under its own name so a script can reference "where does the universe-wide screener rank this pair" without conflating it with the Confluence Screener's own composite label
  | 'chartSignals' // the chart-signal pattern COMMITTEE (analytics/chartsignals.ts via plugins/chartsignals.ts) - the SUGGESTED trade direction (already FADE-adjusted when the committee's own agree/strength floor says to fade it), confidence = |score| 0..100
  | 'leadLag' // the Lead-Lag scanner (plugins/leadlagscan.ts): is a correlated LEADER already moving first - direction = the scanner's own suggested follow trade, 'none' when no qualifying leader/lag fit exists for this pair this cycle
  | 'yesterday' // the Yesterday (T-24h replay) echo (plugins/yesterday.ts): did today's lead-in rhyme with yesterday's at this same wall-clock hour - a WEAK PRIOR by design (markets rhyme, they do not repeat), direction only claimed when the echo's dirAgree is 'same' and the window wasn't quiet/trivial, confidence capped low-to-moderate on purpose
  // Per direct instruction: 'smc'/'smcNow' above lump all 15 SMC/ICT
  // concepts into one vote - this splits that SAME scan (never re-scanned)
  // into the two halves analytics/smc.ts's own module header already
  // documents: classic/generic market-structure terms vs specifically
  // ICT-originated ones. 'smc' below is renamed in spirit, not in code -
  // it still means "the generic half" when read next to this one.
  | 'ict' // ICT-specific concepts only (FVG, IFVG, Order Block, Breaker Block, Liquidity Sweep, OTE, KRM, CRT, Power of 3, Silver Bullet) off the SAME scanSmc() scan 'smc'/'smcNow' already read - see analytics/chartindicators.ts's ICT_KINDS split for the exact list and the reasoning

export const META_CONDITION_SOURCES: readonly MetaConditionSource[] = [
  'oracle',
  'hmaRocBullBear',
  'momentumScore',
  'nextExpiry',
  'accute',
  'renko',
  'smc',
  'smcNow',
  'renkoSmc',
  'renkoSmcMajority',
  'pointFigure',
  'rangeBars',
  'candle',
  'bar',
  'heikinAshi',
  'line',
  'area',
  'baseline',
  'volumeBars',
  'tick',
  'footprint',
  'tpo',
  'ivHv',
  'tickSmc',
  'tickOracle',
  'tickTechnical',
  'tickFootprint',
  'technical',
  'reversal',
  'tempo',
  'confluence',
  'volArb',
  'cointegration',
  'screenerRank',
  'chartSignals',
  'leadLag',
  'yesterday',
  'otcFootprint',
  'ict',
]

export type MetaDirection = 'call' | 'put' | 'none'

export interface MetaCondition {
  source: MetaConditionSource
  /** 'either' = this source just needs to be ACTIVE (direction !== 'none')
   * to count, in whichever direction it's leaning - used when you want a
   * source's confidence to count toward a weighted score without pinning
   * which side it has to be on. 'call'/'put' = it must specifically lean
   * that way to count. */
  direction: 'call' | 'put' | 'either'
  /** 0..100, default 0 - the confidence THRESHOLD this condition compares
   * the source's reading against, via `op` below. */
  minConfidence?: number
  /** Comparison operator applied between the source's confidence and
   * `minConfidence` - "a wide range of conditions" per direct instruction,
   * not just the original fixed ">=" gate. Default '>=' (unchanged
   * behavior for every spec saved before this existed). '<=' / '<' are
   * genuinely useful here: "fire only while Accute's confidence is BELOW
   * 40" is a real condition (e.g. "the other driver is uncertain, so
   * trust this one instead"), not something the weighted/any/all combine
   * modes could express without it. */
  op?: '>=' | '>' | '<=' | '<' | '==' | '!='
  /** Only used in 'weighted' mode - this condition's share of the vote.
   * Default 1 (every condition counts equally unless you say otherwise). */
  weight?: number
  /** Only meaningful when source === 'smcNow' - which of the 15 SMC
   * concepts to read "now" (barsAgo===0) instead of the default aggregate
   * (every concept except Support & Resistance). Lets a dropdown-built
   * spec target one concept the same way Meta Trader's own smc-<kind>
   * sources do, without a new MetaConditionSource per kind. */
  smcKind?: string
  /** Only meaningful when source === 'nextExpiry' - which expiry ladder
   * rung (minutes, one of 1/2/3/5/15) to read instead of the oracle's
   * default single best pick. Undefined = best pick (the engine's own
   * honesty floors already gate it); a pinned rung that is still warming
   * up or sitting in its deadband reads as 'none', never as a guess. */
  expiryMin?: number
  /** Only meaningful on the tick-desk sources (tickSmc/tickOracle/
   * tickTechnical/tickFootprint) - which tick-bucket length in SECONDS to
   * read instead of each engine's own default (SMC 15s, oracle = best
   * across the whole 1s..5m ladder, technical = best-rated ok bucket,
   * footprint 60s). Must be a whole number 1..3600; short buckets on a
   * slow feed read as warming-up 'none', same fail-closed contract the
   * Tick Desk panels render. */
  tickBucketSec?: number
}

export interface MetaStrategySpec {
  id: string // "meta:<slug>"
  name: string
  /** 'all' - every condition must pass (direction + minConfidence), and
   * every passing condition must agree on ONE side; a disagreement among
   * passing conditions reads as 'none', not a coin flip. This is the
   * user's own example: Oracle call AND HMA/ROC/Bull-Bear call AND Accute
   * call AND Renko call.
   * 'any' - at least one condition must pass; the side with more passing
   * conditions wins, a tie reads as 'none'.
   * 'weighted' - every condition contributes weight*confidence*sign
   * (sign 0 if it fails its own direction/minConfidence gate), normalized
   * by total weight into a -100..100 score; fires when |score| >= threshold. */
  mode: 'all' | 'any' | 'weighted'
  /** weighted mode only: minimum |normalized weighted score| to fire.
   * Default 60 - the same "clearly leaning, not a coin flip" bar the
   * Oracle's own driver fusion effectively enforces via its deadband. */
  threshold?: number
  /** Dropdown-built conditions - the default, simple path. Required to
   * have at least one entry UNLESS `script` is set (see below) - a spec
   * is either conditions-built or script-built, never both evaluated at
   * once (script, when present, always wins - see plugins/
   * metastrategy.ts's evaluate()). */
  conditions: MetaCondition[]
  /** The Meta Strategy Lab's own strategy language (analytics/
   * strategylang.ts) - "instead of using json, our own strategy language,
   * that we can use to achieve almost everything" per direct instruction.
   * When set, this spec is evaluated by parsing+running this source
   * instead of combining `conditions` - `conditions`/`mode`/`threshold`
   * are then ignored (but still saved, so switching back to the dropdown
   * builder doesn't lose what was there before). Validated at save() time
   * (parseStrategyScript) so a broken script never reaches the trading
   * loop - a script that fails to parse is rejected on save, not silently
   * traded as "no signal" later. */
  script?: string
  createdTs?: number
  updatedTs?: number
}

export interface MetaSourceRead {
  source: MetaConditionSource
  direction: MetaDirection
  /** 0..100. 0 when direction is 'none' (nothing to be confident about). */
  confidence: number
  label: string
  /** OPTIONAL headline numeric metric in the source's NATIVE scale
   * (renko's signed brick streak, a next-expiry rung's pWin 0..1, the
   * technical ladder's -1..1 vote score, the cointegration z, ...). Meta
   * evaluation ignores it; plugins/metastrategy.ts's buildScriptReads()
   * copies it into the MSL read so a script can threshold the RAW number
   * via the `.value` field instead of only direction+confidence. */
  value?: number
}

export interface MetaConditionResult {
  condition: MetaCondition
  read: MetaSourceRead
  /** true iff this condition's own direction + minConfidence gate passed. */
  passed: boolean
}

export interface MetaEvalResult {
  direction: MetaDirection
  /** signed -100..100, same convention every other ScreenRow.score uses. */
  score: number
  /** 0..100, |score|. */
  confidence: number
  conditions: MetaConditionResult[]
  notes: string
  /** set ONLY by a script-built spec whose MSL carried an
   * "expiry = <minutes>" statement (clamped whole minutes 1-60) - the
   * script's own preferred horizon for this verdict; conditions-built
   * specs never set it. Advisory: the trading engines' own expiry
   * contracts still apply on top. */
  expiryMin?: number
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo
}

function conditionPasses(cond: MetaCondition, read: MetaSourceRead): boolean {
  if (read.direction === 'none') return false
  if (cond.direction !== 'either' && read.direction !== cond.direction) return false
  const threshold = cond.minConfidence ?? 0
  switch (cond.op ?? '>=') {
    case '>=':
      return read.confidence >= threshold
    case '>':
      return read.confidence > threshold
    case '<=':
      return read.confidence <= threshold
    case '<':
      return read.confidence < threshold
    case '==':
      return read.confidence === threshold
    case '!=':
      return read.confidence !== threshold
  }
}

/** Combine one read per condition (same order/length as spec.conditions -
 * callers build this by resolving each condition's source live, see
 * plugins/metastrategy.ts) into a single directional verdict. */
export function evaluateMetaStrategy(spec: MetaStrategySpec, reads: MetaSourceRead[]): MetaEvalResult {
  const conditions: MetaConditionResult[] = spec.conditions.map((condition, i) => {
    const read = reads[i] ?? { source: condition.source, direction: 'none', confidence: 0, label: 'no read' }
    return { condition, read, passed: conditionPasses(condition, read) }
  })

  if (spec.mode === 'weighted') {
    let weightedSum = 0
    let totalWeight = 0
    for (const c of conditions) {
      const w = Math.max(0, c.condition.weight ?? 1)
      totalWeight += w
      if (!c.passed) continue
      const sign = c.read.direction === 'call' ? 1 : c.read.direction === 'put' ? -1 : 0
      weightedSum += w * c.read.confidence * sign
    }
    const score = totalWeight > 0 ? clamp(weightedSum / totalWeight, -100, 100) : 0
    const threshold = spec.threshold ?? 60
    const direction: MetaDirection = Math.abs(score) >= threshold ? (score > 0 ? 'call' : 'put') : 'none'
    const passing = conditions.filter((c) => c.passed)
    const notes =
      direction === 'none'
        ? `weighted score ${score.toFixed(0)} below threshold ${threshold} (${passing.length}/${conditions.length} condition(s) active)`
        : `weighted score ${score.toFixed(0)} >= ${threshold} - ${passing.map((c) => `${c.condition.source}:${c.read.direction}`).join(', ')}`
    return { direction, score: Math.round(score), confidence: Math.round(Math.abs(score)), conditions, notes }
  }

  const passing = conditions.filter((c) => c.passed)
  if (spec.mode === 'all') {
    if (passing.length !== conditions.length || !conditions.length) {
      return {
        direction: 'none',
        score: 0,
        confidence: 0,
        conditions,
        notes: `${passing.length}/${conditions.length} condition(s) passed - 'all' mode needs every one`,
      }
    }
  } else if (!passing.length) {
    return { direction: 'none', score: 0, confidence: 0, conditions, notes: `0/${conditions.length} condition(s) passed` }
  }

  const callSide = passing.filter((c) => c.read.direction === 'call')
  const putSide = passing.filter((c) => c.read.direction === 'put')
  if (callSide.length === putSide.length) {
    return {
      direction: 'none',
      score: 0,
      confidence: 0,
      conditions,
      notes: callSide.length ? `conflicting: ${callSide.length} condition(s) call vs ${putSide.length} put` : `${passing.length}/${conditions.length} condition(s) passed`,
    }
  }
  const winners = callSide.length > putSide.length ? callSide : putSide
  const direction: MetaDirection = callSide.length > putSide.length ? 'call' : 'put'
  const avgConfidence = winners.reduce((s, c) => s + c.read.confidence, 0) / winners.length
  const score = Math.round(avgConfidence) * (direction === 'call' ? 1 : -1)
  const notes = `${spec.mode} - ${winners.map((c) => `${c.condition.source}:${c.read.direction} (${c.read.confidence.toFixed(0)}%)`).join(', ')}`
  return { direction, score, confidence: Math.round(avgConfidence), conditions, notes }
}
