// Edge classification: the ONE primitive that turns level-based conditions
// into transition-aware reads. Every condition in this system (strategy
// evaluates, chart-engine votes, screener rows) is computed per closed bar
// and is LEVEL-shaped by design - "RSI IS below 30", "score IS above 35".
// Level reads can't answer the operator's actual question, which is always
// "what JUST became true?" vs "what has been true for a while". This module
// classifies the transition by re-running the same pure evaluate on the
// window with the last closed bar dropped: if the condition already held on
// the prior bar it's HELD (stale), if it was quiet it's ENTERED (fresh), if
// it pointed the other way it's a FLIP (fresh, opposite side).
//
// The evaluate functions stay pure and untouched - the edge lives at the
// evaluation boundary, so every strategy (builtin + AI-lab spec) gets
// transition semantics from one wrapper instead of forty rewrites.

import type { Candle } from '../types'

export type ConditionDir = 'call' | 'put' | 'none'
export type ConditionPhase = 'entered' | 'held' | 'flip'

/** Transition between the previous closed bar's condition direction and the
 * current one. null when the current read is 'none' - a quiet condition has
 * no edge to classify (and lapse is how the caller re-arms). */
export function edgePhase(prevDir: ConditionDir, curDir: ConditionDir): ConditionPhase | null {
  if (curDir === 'none') return null
  if (prevDir === 'none') return 'entered'
  if (prevDir === curDir) return 'held'
  return 'flip'
}

export interface EdgedEval {
  direction: ConditionDir
  score: number
  notes: string
  /** present only when direction !== 'none' */
  phase?: ConditionPhase
  /** consecutive closed bars the condition has held, counting the current
   * one: 1 = just became true. Only computed for 'held' reads (entered and
   * flip are 1 by definition), capped at MAX_AGE_BARS - deep repeats all
   * tell the same story and every extra bar costs a full evaluate. */
  ageBars?: number
}

/** Cap on the backward walk that counts how long a held condition has been
 * true. 20 bars is far past any honest entry window - if a condition has
 * been true for 20+ bars, "held 20+" is the honest answer. */
export const MAX_AGE_BARS = 20

/** Run a pure strategy evaluate twice - on the full closed window and on the
 * window minus the last bar - and attach the transition. The prev eval uses
 * the SAME function on a shorter slice, so warmup behavior stays identical
 * (a strategy that needs 40 candles reads 'thin history' in both passes at
 * the same real depth). */
export function evalWithEdge(
  evaluate: (candles: Candle[], hints?: { asset?: string }) => { direction: ConditionDir; score: number; notes: string },
  candles: Candle[],
  hints?: { asset?: string }
): EdgedEval {
  const cur = evaluate(candles, hints)
  if (cur.direction === 'none') return { ...cur }
  // fewer than 2 closed bars: the previous bar doesn't exist, so the first
  // bar we can ever see is by definition an entry
  if (candles.length < 2) return { ...cur, phase: 'entered', ageBars: 1 }
  const prev = evaluate(candles.slice(0, -1), hints)
  const phase = edgePhase(prev.direction, cur.direction)
  if (!phase) return { ...cur }
  if (phase !== 'held') return { ...cur, phase, ageBars: 1 }
  // held: walk back until the condition lapses or flips (capped). Start at
  // the bar BEFORE the prev eval's own bar (slice(0, len-1) already covered
  // it) - re-checking it would double-count one bar of age.
  let age = 2
  for (let end = candles.length - 2; end >= 2 && age <= MAX_AGE_BARS; end--) {
    const prior = evaluate(candles.slice(0, end), hints)
    if (prior.direction !== cur.direction) break
    age++
  }
  return { ...cur, phase, ageBars: Math.min(age, MAX_AGE_BARS + 1) }
}

/**
 * Cross-tick edge memory for the auto-trader's PRIORITY-ORDER sweep sources
 * (kalman-ou / markov / momentum / confluence). The screener and strategy
 * sources don't need this class: screener rows arrive as a complete per-tick
 * universe (so an absence is a real lapse, diffable in place) and strategy
 * votes already carry phase from evalWithEdge. The four sweep sources pick
 * the FIRST qualifying pair in priority order and early-return - the only
 * way to know whether a qualifier JUST crossed its threshold or has been
 * sitting there for an hour is to remember what qualified last sweep.
 *
 * Contract (mirrors the screener source's autoEdgeBackfill + the bots'
 * arm-time backfill, same vocabulary: backfill / held / fresh / lapse):
 * - The FIRST sweep after an arm, a restart or a source switch is COLD:
 *   every qualifier it meets is recorded and skipped, so arming can never
 *   trade the stale middle of an already-true condition. An empty sweep
 *   (market closed, plugins missing) leaves the backfill armed - no fake
 *   "nothing qualified" clean slate.
 * - gate() returns 'trade' for a qualifier the memory has never seen (a
 *   fresh edge) and 'skip' for one it has (held). A flip - the same pair's
 *   OPPOSITE side arriving - is by construction unseen, so it trades, like
 *   diffEdges treats an observed direction change as the freshest event.
 *   The caller stamps the key only when the trade actually EXECUTES: a pick
 *   a transient rejection blocked stays fresh and retries until it places
 *   or the condition lapses (retry-until-executed, same as the bots).
 * - endSweep() upkeep: a key whose asset was evaluated this sweep but no
 *   longer qualifies has OBSERVABLY lapsed - drop it, so its next
 *   appearance trades as the fresh edge it then is. An asset that wasn't
 *   evaluated (early return on a fresher pick, thin history throw, cooldown
 *   skip) keeps its keys - no observation, no lapse verdict.
 */
export class SweepEdgeMemory {
  private source = ''
  private cold = true
  private memory = new Set<string>()

  /** Key shape: `${asset}:${dir}` - tickers never contain ':', dir is
   * call|put, so the asset round-trips through the last ':'. */
  static key(asset: string, dir: string): string {
    return `${asset}:${dir}`
  }

  static assetOf(key: string): string {
    return key.slice(0, key.lastIndexOf(':'))
  }

  /** True while the next sweep still owes the arm-time backfill. */
  get armedCold(): boolean {
    return this.cold
  }

  get size(): number {
    return this.memory.size
  }

  has(key: string): boolean {
    return this.memory.has(key)
  }

  /** Start a sweep for `source`. A source switch re-colds: the new source's
   * qualifiers are a different universe - trading on the old source's memory
   * would mislabel its held/edge verdicts. */
  beginSweep(source: string): void {
    if (source !== this.source) {
      this.source = source
      this.cold = true
      this.memory.clear()
    }
  }

  /** Classify a FULLY-gated qualifier (all config thresholds already passed).
   * Pure: 'trade' rows are NOT recorded here - stamp() on execution does. */
  gate(key: string): 'trade' | 'skip' {
    if (this.cold || this.memory.has(key)) return 'skip'
    return 'trade'
  }

  /** Sweep upkeep. An empty evaluated set means nothing was observed (cold
   * screener, closed market) - no pruning, and the cold backfill stays armed.
   * A cold sweep with observations IS the backfill: fold the observed
   * qualifying set in and stand down. Otherwise prune keys whose asset was
   * evaluated but no longer qualifies (an observable lapse). */
  endSweep(evaluated: Set<string>, qualifying: Set<string>): void {
    if (evaluated.size === 0) return
    if (this.cold) {
      for (const key of qualifying) this.memory.add(key)
      this.cold = false
      return
    }
    for (const key of [...this.memory]) {
      if (qualifying.has(key)) continue
      if (evaluated.has(SweepEdgeMemory.assetOf(key))) this.memory.delete(key)
    }
  }

  /** The trade actually placed - the edge is consumed: the condition counts
   * as held for this source from here until it observably lapses, so a
   * per-asset cooldown expiring can never re-enter the stale middle. */
  stamp(key: string): void {
    this.memory.add(key)
  }

  /** (Re)arm: whatever qualifies on the next sweep predates this arm. */
  rearm(): void {
    this.cold = true
    this.memory.clear()
  }
}
