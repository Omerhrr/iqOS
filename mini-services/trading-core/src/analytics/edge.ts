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
