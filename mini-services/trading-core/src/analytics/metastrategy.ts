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
  | 'accute' // Accute's fused multi-driver prediction (plugins/accute.ts)
  | 'renko' // Renko brick trend/streak (analytics/renko.ts, same read Accute's own renko leg uses)
  | 'smc' // Smart Money Concepts structure summary (analytics/smc.ts)

export const META_CONDITION_SOURCES: readonly MetaConditionSource[] = ['oracle', 'hmaRocBullBear', 'momentumScore', 'accute', 'renko', 'smc']

export type MetaDirection = 'call' | 'put' | 'none'

export interface MetaCondition {
  source: MetaConditionSource
  /** 'either' = this source just needs to be ACTIVE (direction !== 'none')
   * to count, in whichever direction it's leaning - used when you want a
   * source's confidence to count toward a weighted score without pinning
   * which side it has to be on. 'call'/'put' = it must specifically lean
   * that way to count. */
  direction: 'call' | 'put' | 'either'
  /** 0..100, default 0 - a source reading below this doesn't count as
   * active for this condition, same spirit as the Oracle's own
   * minConfidence gates. */
  minConfidence?: number
  /** Only used in 'weighted' mode - this condition's share of the vote.
   * Default 1 (every condition counts equally unless you say otherwise). */
  weight?: number
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
  conditions: MetaCondition[]
  createdTs?: number
  updatedTs?: number
}

export interface MetaSourceRead {
  source: MetaConditionSource
  direction: MetaDirection
  /** 0..100. 0 when direction is 'none' (nothing to be confident about). */
  confidence: number
  label: string
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
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo
}

function conditionPasses(cond: MetaCondition, read: MetaSourceRead): boolean {
  if (read.direction === 'none') return false
  if (cond.direction !== 'either' && read.direction !== cond.direction) return false
  return read.confidence >= (cond.minConfidence ?? 0)
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
