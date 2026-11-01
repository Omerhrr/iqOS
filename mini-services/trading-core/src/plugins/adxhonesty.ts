// IQAIR//OS - ADX/DI + Pattern Bias honesty loop
//
// Every other engine in this stack (Next-Candle Oracle, Tempo) tracks its
// own calls against reality and feeds that record back into itself. The
// ADX/DI + Pattern Bias composite (analytics/adxpatternbias.ts) never did -
// its qualify bar and its two legs' relative weight were pure hand-set
// constants from day one. This plugin closes that gap:
//
// - track(asset, tf, fit, candles) is called by the sites that already
//   compute a fresh fitAdxPatternBias with real market candles (the
//   index.ts panel scan, the 'adx-pattern-bias'/'pair-signal' auto-trader
//   pickers) - when that fit QUALIFIES, this plugin registers it as a
//   pending call for the bar right after the one it was computed from
//   (same "closed.time + barDuration" convention plugins/nextcandle.ts
//   uses for its own targetBarTime).
// - every pending call resolves on the next 'candle' closed bus event for
//   that exact asset/tf/targetBarTime, against the REAL realized direction.
// - the resolved ledger (universe-wide, not per-pair - same scope the
//   Oracle's driver weights and the learned pattern-reliability table
//   already use) feeds TWO learned numbers back into
//   analytics/adxpatternbias.ts through its own provider bridges:
//     1. which leg (ADX/DI trend push vs pattern bias) has actually been
//        more predictive - replaces the hand-set 1:1 blend in composite()
//     2. the smallest COMPOSITE_QUALIFY bar, among a small candidate sweep,
//        whose own resolved hit rate clears a target precision - replaces
//        the flat hand-set 3.5
// Both numbers apply to EVERY caller of fitAdxPatternBias, tracked or not
// (pair_compare, pair_signal, the backtested strategies included), because
// the provider bridges live inside analytics/adxpatternbias.ts itself.
//
// Resolved records persist to data/adxpatternbias_outcomes.json - same
// durability contract as plugins/nextcandle.ts and plugins/tempo.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { Candle } from '../types'
import {
  type AdxPatternBiasFit,
  type Bias,
  setAdxHtfLearningProvider,
  setAdxPatternBiasLearningProvider,
  setAdxQualifyBarProvider,
} from '../analytics/adxpatternbias'
import { weightedHitRate } from '../analytics/recencystats'

const MAX_RESOLVED = 600
const OUTCOME_FILE = 'adxpatternbias_outcomes.json'
/** min resolved samples per LEG before its learned weight is trusted -
 * same "thin record is no record" floor every other honesty loop in this
 * stack uses. */
const LEG_STATS_MIN_N = 30
const LEG_STATS_WINDOW = 400
/** candidate qualify bars swept ascending - the smallest one whose own
 * subset clears QUALIFY_TARGET_HIT_RATE with enough samples wins, so the
 * learned bar never gets pickier than it needs to be to hit the target. */
const QUALIFY_BAR_CANDIDATES = [2.5, 3, 3.5, 4, 4.5, 5, 5.5]
const QUALIFY_TARGET_HIT_RATE = 0.55
const QUALIFY_BAR_MIN_N = 30
const QUALIFY_BAR_WINDOW = 500
/** min samples per side (htf-agreeing vs htf-disagreeing, oracle-agreeing
 * vs not) before the HTF-veto learning or the confluence boost trusts the
 * comparison - same floor philosophy as everywhere else in this stack. */
const SIDE_STATS_MIN_N = 20
const SIDE_STATS_WINDOW = 500
/** confluenceBoost() never amplifies confidence/composite by more than
 * this - an agreeing second engine earns a real but bounded nudge, never
 * enough to turn a marginal read into a sure thing on its own. */
const CONFLUENCE_BOOST_MAX = 1.25

interface PendingAdxCall {
  asset: string
  tf: string
  targetBarTime: number
  issuedTs: number
  direction: 'call' | 'put'
  adxDirection: Bias
  patternDirection: Bias
  composite: number
  price: number
  /** this read's HTF disagreement flag, carried through to resolution so
   * htfAlignmentLearning() can compare agree-vs-disagree hit rates. */
  htfDisagrees: boolean
  /** true when this call only exists because the HTF veto alone was
   * blocking an otherwise-qualifying read - tracked for learning purposes
   * only, never treated as a live signal by any caller (fit.qualifies was
   * false, so nothing actually fired on it). */
  shadow: boolean
  /** did the Next-Candle Oracle have an ACTIVE same-direction read on this
   * exact pair+tf at track time? null = oracle had no active read either
   * way (not tracked as agreement OR disagreement). */
  oracleAgrees: boolean | null
}

export interface ResolvedAdxCall {
  asset: string
  tf: string
  targetBarTime: number
  issuedTs: number
  resolvedTs: number
  direction: 'call' | 'put'
  adxDirection: Bias
  patternDirection: Bias
  composite: number
  entry: number
  exit: number
  actual: 'up' | 'down' | 'flat'
  hit: boolean
  htfDisagrees: boolean
  shadow: boolean
  oracleAgrees: boolean | null
}

export class AdxHonestyService {
  private ctx!: KernelContext
  private pending = new Map<string, PendingAdxCall>()
  private resolved: ResolvedAdxCall[] = []
  private unsub: (() => void) | null = null

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.restore()
    this.unsub = ctx.bus.on('candle', ({ asset, tf, candle, closed }) => {
      if (!closed) return
      this.resolveFor(asset, tf, candle)
    })
    setAdxPatternBiasLearningProvider(() => this.legWeights())
    setAdxQualifyBarProvider(() => this.learnedQualifyBar())
    setAdxHtfLearningProvider(() => this.htfAlignmentLearning())
    ctx.log('adxhonesty', 'ADX/DI + pattern bias honesty loop online (learned leg weights + learned qualify bar + learned HTF veto)')
  }

  stop(): void {
    this.unsub?.()
    this.persist()
  }

  /** Report a freshly-computed fit (with REAL market candles) for tracking.
   * Tracks it when it actually qualifies (a live, fired signal), OR when
   * it's blocked ONLY by the HTF veto (fit.qualifiesIgnoringHtf true,
   * fit.qualifies false, fit.htfDisagrees true) - that second case is a
   * SHADOW entry: nothing fired on it, but its real outcome is the only
   * way htfAlignmentLearning() can ever learn whether the HTF veto is
   * worth its cost, since a hard-blocked call otherwise never resolves
   * against reality. `oracleAgrees` (optional) lets a caller that already
   * checked the Next-Candle Oracle's own active read pass that agreement
   * through for confluenceBoost() to learn from - omit it when the oracle
   * wasn't checked. Dedupes per (asset, tf, targetBarTime): a re-poll
   * inside the same forming bar replaces the pending entry, not stacks it. */
  track(asset: string, tf: string, fit: AdxPatternBiasFit, candles: Candle[], oracleAgrees?: boolean | null): void {
    if (fit.direction === 'neutral') return
    const shadow = !fit.qualifies && fit.htfDisagrees && fit.qualifiesIgnoringHtf
    if (!fit.qualifies && !shadow) return
    if (candles.length < 2) return
    const last = candles[candles.length - 1]
    const prev = candles[candles.length - 2]
    const barDur = last.time - prev.time || 60
    const targetBarTime = last.time + barDur
    const key = `${asset}:${tf}:${targetBarTime}`
    this.pending.set(key, {
      asset,
      tf,
      targetBarTime,
      issuedTs: Date.now(),
      direction: fit.direction === 'bullish' ? 'call' : 'put',
      adxDirection: fit.adxDirection,
      patternDirection: fit.patternDirection,
      composite: fit.composite,
      price: last.close,
      htfDisagrees: fit.htfDisagrees,
      shadow,
      oracleAgrees: oracleAgrees ?? null,
    })
    if (this.pending.size > 400) {
      const keys = [...this.pending.keys()].slice(0, 80)
      for (const k of keys) this.pending.delete(k)
    }
  }

  /** Learned confluence boost: how much extra weight an agreeing
   * Next-Candle Oracle read (same direction, active at track time) is
   * worth, based on whether agreeing calls have actually resolved better
   * than calls where the oracle disagreed or had no active read. 1 (no
   * boost) until both sides have SIDE_STATS_MIN_N samples - agreement is
   * currently a free no-op everywhere it's checked; this is what finally
   * lets it count for something, capped at CONFLUENCE_BOOST_MAX so it can
   * only ever nudge, not replace, the base read. */
  confluenceBoost(): number {
    const window = this.resolved.filter((r) => !r.shadow && r.actual !== 'flat').slice(-SIDE_STATS_WINDOW)
    const agree = window.filter((r) => r.oracleAgrees === true)
    const rest = window.filter((r) => r.oracleAgrees !== true)
    if (agree.length < SIDE_STATS_MIN_N || rest.length < SIDE_STATS_MIN_N) return 1
    const agreeRate = weightedHitRate(agree, (r) => r.hit).hitRate
    const restRate = weightedHitRate(rest, (r) => r.hit).hitRate
    return Math.max(1, Math.min(CONFLUENCE_BOOST_MAX, 1 + (agreeRate - restRate) * 2))
  }

  private resolveFor(asset: string, tf: string, candle: Candle): void {
    const prefix = `${asset}:${tf}:`
    for (const [key, p] of this.pending) {
      if (!key.startsWith(prefix)) continue
      if (p.targetBarTime !== candle.time) continue
      this.pending.delete(key)
      const diff = candle.close - p.price
      const actual: ResolvedAdxCall['actual'] = Math.abs(diff) < 1e-12 ? 'flat' : diff > 0 ? 'up' : 'down'
      const hit = actual === 'flat' ? false : p.direction === 'call' ? actual === 'up' : actual === 'down'
      const entry: ResolvedAdxCall = {
        asset,
        tf,
        targetBarTime: p.targetBarTime,
        issuedTs: p.issuedTs,
        resolvedTs: Date.now(),
        direction: p.direction,
        adxDirection: p.adxDirection,
        patternDirection: p.patternDirection,
        composite: p.composite,
        entry: p.price,
        exit: candle.close,
        actual,
        hit,
        htfDisagrees: p.htfDisagrees,
        shadow: p.shadow,
        oracleAgrees: p.oracleAgrees,
      }
      this.resolved.push(entry)
      while (this.resolved.length > MAX_RESOLVED) this.resolved.shift()
      this.persist()
    }
  }

  /** Per-leg win rate, universe-wide, over the last LEG_STATS_WINDOW
   * resolved calls - mapped to a weight on roughly the same scale
   * composite()'s re-normalization expects (both legs default to 1). null
   * until BOTH legs have LEG_STATS_MIN_N - a one-sided record would let a
   * thin leg's noise silently out-weigh a well-sampled one. */
  private legWeights(): { trendWeight: number; patternWeight: number } | null {
    // shadow entries never actually fired (the HTF veto blocked them) -
    // excluded here so leg-weight learning stays scoped to real, live
    // calls, same as before this round's HTF-shadow tracking was added.
    const window = this.resolved.slice(-LEG_STATS_WINDOW).filter((r) => !r.shadow && r.actual !== 'flat')
    const trendCalls: boolean[] = []
    const patCalls: boolean[] = []
    for (const r of window) {
      const up = r.actual === 'up'
      if (r.adxDirection !== 'neutral') trendCalls.push((r.adxDirection === 'bullish') === up)
      if (r.patternDirection !== 'neutral') patCalls.push((r.patternDirection === 'bullish') === up)
    }
    if (trendCalls.length < LEG_STATS_MIN_N || patCalls.length < LEG_STATS_MIN_N) return null
    const trendWinRate = weightedHitRate(trendCalls, (hit) => hit).hitRate
    const patWinRate = weightedHitRate(patCalls, (hit) => hit).hitRate
    return {
      trendWeight: Math.max(0.5, Math.min(2, 0.5 + (trendWinRate - 0.5) * 3)),
      patternWeight: Math.max(0.5, Math.min(2, 0.5 + (patWinRate - 0.5) * 3)),
    }
  }

  /** Learned replacement for the flat HTF veto (see
   * setAdxHtfLearningProvider's doc in analytics/adxpatternbias.ts): compares
   * the resolved hit rate of calls where the HTF read agreed/was neutral
   * against calls where it actively disagreed (both the rare live ones and
   * the shadow-tracked ones the veto blocked from firing) - INCLUDING
   * shadow entries here, unlike legWeights()/learnedQualifyBar() above,
   * because a shadow call's market outcome is exactly what's needed to
   * judge the veto itself; it just never got a chance to be live. null
   * (defaults the veto back to its original hard-block behavior) until
   * both sides clear SIDE_STATS_MIN_N. */
  private htfAlignmentLearning(): { penaltyMult: number } | null {
    const window = this.resolved.filter((r) => r.actual !== 'flat').slice(-SIDE_STATS_WINDOW)
    const agree = window.filter((r) => !r.htfDisagrees)
    const disagree = window.filter((r) => r.htfDisagrees)
    if (agree.length < SIDE_STATS_MIN_N || disagree.length < SIDE_STATS_MIN_N) return null
    const agreeRate = weightedHitRate(agree, (r) => r.hit).hitRate
    const disagreeRate = weightedHitRate(disagree, (r) => r.hit).hitRate
    // disagreeing reads that do just as well (or better) than agreeing
    // ones mean the veto isn't buying real accuracy - penaltyMult relaxes
    // toward 1 (barely any extra margin required). Disagreeing reads that
    // resolve meaningfully worse keep (or restore) a steep multiplier -
    // at composite's own max scale, 8x is effectively still a hard block.
    return { penaltyMult: Math.max(1, Math.min(8, 1 + (agreeRate - disagreeRate) * 6)) }
  }

  /** Smallest candidate qualify bar whose own resolved subset clears the
   * target hit rate with enough samples - a precision sweep over the
   * composite's own resolved history instead of one flat hand-set number.
   * Ascending candidates means the search never gets pickier than needed
   * to hit the target, so it doesn't quietly starve trade frequency once
   * it has enough history to speak. null (falls back to the hand-set
   * COMPOSITE_QUALIFY) until the smallest candidate itself has enough
   * samples to trust. */
  private learnedQualifyBar(): number | null {
    const window = this.resolved.slice(-QUALIFY_BAR_WINDOW).filter((r) => !r.shadow && r.actual !== 'flat')
    if (window.length < QUALIFY_BAR_MIN_N) return null
    for (const c of QUALIFY_BAR_CANDIDATES) {
      const subset = window.filter((r) => Math.abs(r.composite) >= c)
      if (subset.length < QUALIFY_BAR_MIN_N) continue
      const hitRate = weightedHitRate(subset, (r) => r.hit).hitRate
      if (hitRate >= QUALIFY_TARGET_HIT_RATE) return c
    }
    return null
  }

  /** Lifetime ledger for panels/agents. */
  stats(): {
    total: number
    pending: number
    hitRate: number | null
    legWeights: { trendWeight: number; patternWeight: number } | null
    qualifyBar: number | null
    htfPenaltyMult: number | null
    confluenceBoost: number
    recent: ResolvedAdxCall[]
  } {
    const decided = this.resolved.filter((r) => !r.shadow && r.actual !== 'flat')
    const wins = decided.filter((r) => r.hit).length
    return {
      total: this.resolved.length,
      pending: this.pending.size,
      hitRate: decided.length ? wins / decided.length : null,
      legWeights: this.legWeights(),
      qualifyBar: this.learnedQualifyBar(),
      htfPenaltyMult: this.htfAlignmentLearning()?.penaltyMult ?? null,
      confluenceBoost: this.confluenceBoost(),
      recent: this.resolved.slice(-40).reverse(),
    }
  }

  // ---------- persistence ----------
  private dataFile(): string {
    const dir = join(process.cwd(), 'data')
    mkdirSync(dir, { recursive: true })
    return join(dir, OUTCOME_FILE)
  }

  private restore(): void {
    try {
      const f = this.dataFile()
      if (!existsSync(f)) return
      const raw = JSON.parse(readFileSync(f, 'utf8'))
      if (Array.isArray(raw?.resolved)) this.resolved = raw.resolved.slice(-MAX_RESOLVED)
      this.ctx.log('adxhonesty', `restored ${this.resolved.length} resolved ADX/DI + pattern bias calls from data/`)
    } catch {
      // corrupt/missing file - clean ledger, never break boot
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.dataFile(), JSON.stringify({ resolved: this.resolved.slice(-MAX_RESOLVED) }))
    } catch {
      // best-effort - the in-memory ledger stays authoritative until next save
    }
  }
}

export const adxHonestyPlugin: Plugin = {
  name: 'adx-honesty',
  start: async (ctx) => {
    const svc = new AdxHonestyService()
    ctx.provide('adxhonesty', svc)
    await svc.start(ctx)
  },
}
