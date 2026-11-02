// IQAIR//OS - Accute (multi-model prediction fusion)
//
// Used to be a strict "all 3 legs must agree" confluence gate - any one
// leg sitting at 'none', or any disagreement, collapsed straight to
// 'none' regardless of how strongly the other two agreed. That throws
// away almost all the information in a near-miss (2 strong legs agreeing,
// the third merely flat reads identically to true 3-way disagreement).
//
// Accute is now built the same way the Next-Candle Oracle (analytics/
// nextcandle.ts) is built: every read this module already carries becomes
// one independent, WEIGHTED driver contributing a continuous pUp to a
// log-odds fusion, exactly like Oracle's own fuseOdds() - a prediction
// (pUp + confidence + direction), not a unanimous-agreement requirement.
// Invents no new math, same as the confluence version did - just combines
// the same five already-live reads with the Oracle's own fusion method
// instead of a boolean AND:
//
//   1. ADX/DI + Pattern Bias (analytics/adxpatternbias.ts) - composite
//      score (-10..10), scaled to a vote; weight boosted when the
//      engine's own `qualifies` bar clears (both legs agree, clear the
//      composite bar, survive the HA/HTF vetoes) vs. a smaller weight
//      when it doesn't - still informative, just less so.
//   2. Tempo (plugins/tempo.ts) - the patience engine's own fused pUp
//      read, weight boosted specifically while its one-shot-per-window
//      stopping rule is ACTIVELY FIRING this bar (the real, independent
//      information Tempo adds over the Oracle leg below is TIMING, not
//      direction - Tempo's raw lean is the Oracle's own lean passed
//      through, handled by the correlation discount below so that isn't
//      double-counted).
//   3. Next-Candle Oracle fusion (analytics/nextcandle.ts) - the full
//      multi-model fused read, weight scaled by its own confidence.
//   4. Support/resistance + buy/sell zone (analytics/structure.ts, read
//      by plugins/accute.ts's zoneRead()) - pushed as a driver ONLY when
//      a zone is actually active (both trendPullbackSeries and
//      rangeZoneSeries are deliberately sparse, non-zero well under 5%
//      of bars by design); 'no recognized zone' contributes nothing,
//      exactly like the Oracle's own conditional drivers (Renko bricks/
//      Footprint/Chart engines) only push when they have something to
//      say.
//   5. Renko brick trend (analytics/renko.ts) - same idea, pushed only
//      once a brick has actually painted.
//
// Driver #2 (Tempo) and #3 (Oracle) read substantially the same
// underlying evidence (Tempo's raw lean IS the Oracle's lean passed
// through), so when they agree it's partially the same evidence counted
// twice - handled with the exact same correlation-discount mechanism the
// Oracle itself uses for its own correlated pairs (Chart engines/Renko
// bricks/Footprint): the second-listed member of an agreeing pair gets
// its weight discounted, never boosted, never flipped.

export type AccuteDirection = 'call' | 'put' | 'none'
export type AccuteDriverName = 'adxPattern' | 'tempo' | 'oracle' | 'zone' | 'renko'

export interface AccuteDriver {
  name: AccuteDriverName
  /** this driver's own directional read, as a probability of the next
   * window resolving 'up' - 0.5 = no lean. */
  pUp: number
  /** relative weight this driver contributes to the fusion - 0 means
   * "nothing to say this bar" and the driver is dropped before fusing,
   * same convention the Oracle's own conditional drivers use. */
  weight: number
  /** convenience signed read in [-1, 1], purely for display/sorting -
   * never fed into the fusion directly (pUp + weight already encode it). */
  vote: number
  /** short human-readable reason, surfaced in panels/notes. */
  label: string
}

export interface AccuteResult {
  /** fused probability of the next window resolving 'up', across every
   * driver that had something to say this bar. */
  pUp: number
  /** 0-100, how much the fused read is actually worth trusting - derived
   * from how much of the fused weight agrees with the winning side and
   * how many of the up-to-5 drivers were actually active this bar, same
   * shape as the Oracle's own confidence. */
  confidence: number
  /** call/put once pUp clears a small deadband around 0.5, 'none'
   * (genuine coin-flip) otherwise - the Oracle's own rule, not an
   * all-legs-must-agree gate. */
  direction: AccuteDirection
  /** convenience flag - true whenever direction is 'none'. */
  waiting: boolean
  /** every driver that actually had a nonzero weight this bar, in the
   * order they were evaluated - the ones excluded as flat/unweighted are
   * simply absent, not listed with a zero. */
  drivers: AccuteDriver[]
  /** how many of the up-to-5 possible drivers were active this bar. */
  driversActive: number
  /** share of the active weight sitting on the winning side, 0..1 - 1.0
   * means every active driver agreed, 0.5 means it was a true coin flip
   * between two evenly-weighted camps. */
  agreement: number
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo
}

/** log-odds weighted fusion of pUp values - identical shape to the
 * Oracle's own fuseOdds(), kept as its own small copy here rather than an
 * import so this module has no dependency direction on nextcandle.ts
 * (plugins/accute.ts already imports both where it needs to). */
function fuseOdds(entries: { pUp: number; weight: number }[]): number {
  const totalW = entries.reduce((a, e) => a + e.weight, 0)
  if (totalW <= 0) return 0.5
  let logit = 0
  for (const e of entries) {
    const p = clamp(e.pUp, 0.01, 0.99)
    logit += (e.weight / totalW) * Math.log(p / (1 - p))
  }
  return clamp(1 / (1 + Math.exp(-logit)), 0.01, 0.99)
}

/** Tempo's raw lean is the Oracle's own lean passed through (see module
 * header) - when both agree it's the same evidence, not independent
 * confirmation, so Tempo (the second-listed of the pair) gets its weight
 * discounted exactly like the Oracle discounts its own correlated pairs. */
const CORRELATION_DISCOUNT = 0.65

function decorrelate(drivers: AccuteDriver[]): AccuteDriver[] {
  const out = drivers.map((d) => ({ ...d }))
  const tempo = out.find((d) => d.name === 'tempo')
  const oracle = out.find((d) => d.name === 'oracle')
  if (tempo && oracle && tempo.weight > 0 && oracle.weight > 0) {
    const tSign = Math.sign(tempo.pUp - 0.5)
    const oSign = Math.sign(oracle.pUp - 0.5)
    if (tSign !== 0 && tSign === oSign) tempo.weight *= CORRELATION_DISCOUNT
  }
  return out
}

/** Deadband around the coin-flip, same role as the Oracle's own direction
 * cutoff - inside this band the fused read is treated as a genuine
 * no-lean rather than forced to whichever side is a hair over 50%. */
const DEADBAND = 0.03
/** Below this many active (nonzero-weight) drivers there isn't enough
 * independent evidence to fuse into anything worth trusting - refuse
 * rather than guess, same posture predictNextCandle takes at <5/9. Lower
 * here because Accute has a smaller roster (5, not 9) and two of the five
 * (zone/renko) are deliberately sparse and often simply absent. */
const MIN_USABLE_DRIVERS = 2
/** Total possible drivers, for the small-sample confidence dampener. */
const MAX_DRIVERS = 5

export function combineAccute(drivers: AccuteDriver[]): AccuteResult {
  const usable = decorrelate(drivers.filter((d) => Number.isFinite(d.pUp) && Number.isFinite(d.weight) && d.weight > 0))
  if (usable.length < MIN_USABLE_DRIVERS) {
    return { pUp: 0.5, confidence: 0, direction: 'none', waiting: true, drivers: usable, driversActive: usable.length, agreement: 0.5 }
  }

  const pUp = fuseOdds(usable.map((d) => ({ pUp: d.pUp, weight: d.weight })))
  const winSide = pUp >= 0.5 ? 1 : -1
  const totalW = usable.reduce((s, d) => s + d.weight, 0)
  const agreeW = usable.reduce((s, d) => s + (Math.sign(d.pUp - 0.5) === winSide ? d.weight : 0), 0)
  const agreement = totalW > 0 ? agreeW / totalW : 0.5
  const distance = Math.abs(pUp - 0.5) * 2 // 0..1
  // same small-sample dampener idea as the Oracle: a thin 2/5 read is
  // dampened toward coin-flip confidence even when the 2 that fired fully
  // agree; a full 5/5 read gets none.
  const sampleFactor = clamp(0.7 + 0.3 * (usable.length / MAX_DRIVERS), 0.7, 1)
  const confidence = clamp((0.55 * agreement + 0.45 * distance) * 100 * sampleFactor, 0, 100)

  const direction: AccuteDirection = pUp >= 0.5 + DEADBAND ? 'call' : pUp <= 0.5 - DEADBAND ? 'put' : 'none'

  return {
    pUp,
    confidence,
    direction,
    waiting: direction === 'none',
    drivers: usable,
    driversActive: usable.length,
    agreement,
  }
}

const DRIVER_LABEL: Record<AccuteDriverName, string> = {
  adxPattern: 'ADX/Pattern',
  tempo: 'Tempo',
  oracle: 'Oracle',
  zone: 'Zone',
  renko: 'Renko',
}

/** One-line summary, built from the fused read already decided - used by
 * both the live plugin and the backtest strategy so the two never drift
 * apart on wording. */
export function accuteSummary(result: AccuteResult): string {
  const active = result.drivers.map((d) => DRIVER_LABEL[d.name]).join(', ') || 'none'
  if (result.direction !== 'none') {
    return `fused ${result.direction.toUpperCase()} - pUp ${(result.pUp * 100).toFixed(0)}%, confidence ${result.confidence.toFixed(0)} (${result.driversActive}/${MAX_DRIVERS} drivers: ${active})`
  }
  if (result.driversActive < MIN_USABLE_DRIVERS) {
    return `warming up - only ${result.driversActive}/${MIN_USABLE_DRIVERS} minimum drivers active yet`
  }
  return `no lean - pUp ${(result.pUp * 100).toFixed(0)}% too close to a coin flip (${result.driversActive}/${MAX_DRIVERS} drivers: ${active})`
}
