// IQAIR//OS - Accute (triple-confluence confirmation)
//
// Invents no new math - combines three ALREADY-LIVE directional reads this
// codebase already carries, each with its own gate, and fires a signal
// ONLY when all three currently point the same way:
//
//   1. ADX/DI + Pattern Bias (analytics/adxpatternbias.ts) - qualifies only
//      when ADX/DI and candle-pattern bias agree, clear their composite
//      bar, and survive the HA/HTF vetoes.
//   2. Tempo (analytics/tempo.ts + plugins/tempo.ts) - the patience engine's
//      own one-shot-per-window stopping rule has to be ACTIVELY FIRING this
//      bar, not merely leaning a direction. Tempo's raw directional lean is
//      just the Oracle's own lean passed through (see plugins/tempo.ts's
//      rowFromScan: `direction: r.direction`), so using the raw lean here
//      would make this leg redundant with the Oracle leg below - the real,
//      independent information Tempo adds is TIMING: is this pair's window
//      actually ready to spend its license right now.
//   3. Next-Candle Oracle fusion (analytics/nextcandle.ts) - the 7-model
//      fused read, gated on its own confidence clearing a floor.
//
// Any one of the three sitting at 'none' (not qualifying/firing/confident
// enough), or any disagreement between the three that DO have a lean, means
// WAITING. This is deliberately the strictest, rarest signal in the catalog
// - the whole point of a triple-confirmation gate is that it almost never
// fires, and when it does, three independent engines agree.

export type AccuteDirection = 'call' | 'put' | 'none'
export type AccuteLegName = 'adxPattern' | 'tempo' | 'oracle'

export interface AccuteLeg {
  /** this leg's own directional lean, already gated by its own engine -
   * 'none' means "this engine isn't currently qualifying/firing/confident
   * enough", not merely "leans the other way". */
  direction: AccuteDirection
  /** short human-readable reason, surfaced in panels/notes */
  label: string
}

export interface AccuteResult {
  /** 'call'/'put' ONLY when all three legs share the same non-'none'
   * direction; 'none' (waiting) otherwise. */
  direction: AccuteDirection
  /** convenience flag - true whenever direction is 'none' */
  waiting: boolean
  legs: Record<AccuteLegName, AccuteLeg>
  /** how many of the three legs share the direction that appears most
   * often among them (0-3) - lets a panel show "2/3 lean call, waiting on
   * Tempo" instead of just a flat "waiting". */
  agreeCount: number
  /** the direction the plurality of non-'none' legs lean, even when not
   * all three agree (null if every leg is 'none', or call/put are tied) -
   * purely informational, never gates `direction` above. */
  leaning: 'call' | 'put' | null
}

export function combineAccute(legs: Record<AccuteLegName, AccuteLeg>): AccuteResult {
  const dirs = (Object.keys(legs) as AccuteLegName[]).map((k) => legs[k].direction)
  const callCount = dirs.filter((d) => d === 'call').length
  const putCount = dirs.filter((d) => d === 'put').length
  const allAgree = dirs.every((d) => d === dirs[0]) && dirs[0] !== 'none'
  const leaning: 'call' | 'put' | null = callCount === putCount ? (callCount > 0 ? null : null) : callCount > putCount ? 'call' : 'put'
  return {
    direction: allAgree ? (dirs[0] as 'call' | 'put') : 'none',
    waiting: !allAgree,
    legs,
    agreeCount: Math.max(callCount, putCount),
    leaning,
  }
}

/** One-line summary of why Accute is or isn't firing, built from the legs
 * already decided - used by both the live plugin and the backtest
 * strategy so the two never drift apart on wording. */
export function accuteSummary(result: AccuteResult): string {
  if (result.direction !== 'none') {
    return `all 3 agree ${result.direction.toUpperCase()} - ${result.legs.adxPattern.label} · ${result.legs.tempo.label} · ${result.legs.oracle.label}`
  }
  const names: Record<AccuteLegName, string> = { adxPattern: 'ADX/Pattern', tempo: 'Tempo', oracle: 'Oracle' }
  const waitingOn = (Object.keys(result.legs) as AccuteLegName[]).filter((k) => result.legs[k].direction === 'none').map((k) => names[k])
  if (waitingOn.length === 3) return 'waiting - all 3 legs flat'
  if (result.agreeCount >= 2 && result.leaning) {
    return `waiting - ${result.agreeCount}/3 lean ${result.leaning.toUpperCase()}, held up by ${waitingOn.length ? waitingOn.join('/') : 'a disagreeing leg'}`
  }
  return `waiting - no 3-way agreement${waitingOn.length ? ` (flat: ${waitingOn.join('/')})` : ''}`
}
