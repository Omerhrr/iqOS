// IQAIR//OS - Renko / Kagi reversal EVENT feeds.
//
// The two chart-panel siblings of reversal.ts's "is it turning right now"
// state engine, but event-shaped: they list ONLY the moments a brick-or-line
// chart actually flipped, newest first, instead of printing a state on every
// refresh.
//
//   renkoReversalFeed  - every reversal brick. Default source is Effort Bricks
//     (effortbricks.ts): same brick geometry and 2-brick reversal rule as
//     Renko, but the smaller default step (ATR x 0.3) flips earlier, and each
//     reversal carries whether real volume stood behind it (`confirmed`) and
//     the participation regime AS OF that brick. Plain Renko is a switchable
//     source for slow pairs (no confirmation data there - fields read null,
//     never a fabricated "confirmed").
//   kagiReversalFeed   - every direction reversal AND every thickness flip:
//     yang (price broke above the last shoulder - demand took over) and yin
//     (price broke below the last waist - supply took over).
//
// EVIDENCE, NOT A CLAIM. A reversal brick fires after a small counter-move,
// so on a choppy pair it fires constantly. The feed therefore also measures,
// on THIS pair's own window, what happened after each past event of each
// kind: did price close the next `horizon` candle(s) in the event's direction?
// The result is a Wilson lower bound set against the payout's breakeven
// (calibratededge.ts's rule), reported per event kind - so the panel can say
// "confirmed reversals have followed through 61% (floor 48%)" or "no proven
// follow-through" instead of implying every flip is a trade. Ties count
// against the event. Pure function of the candles it is handed, no look-ahead:
// an event is only scored once the horizon candle has closed.

import type { Candle } from '../types'
import { effortBricks, classifyEffortRegime, type EffortRegime } from './effortbricks'
import { renkoBricks } from './renko'
import { kagi, type KagiRegime } from './kagi'
import { wilsonLower } from './calibratededge'

export type ReversalSource = 'effort' | 'renko'

export interface FollowThroughStat {
  /** Event kind the stat covers ('all', 'confirmed', 'unconfirmed', 'reversal', 'yang', 'yin'). */
  group: string
  horizon: number
  /** Scored events (horizon candle already closed). */
  n: number
  wins: number
  rate: number
  /** One-sided Wilson lower bound of `rate`. */
  lowerBound: number
  breakeven: number
  /** n >= MIN_SCORED_EVENTS - below it the stat is shown but never called proof. */
  enough: boolean
  /** enough AND lowerBound >= breakeven: follow-through is statistically proven on this window. */
  proven: boolean
}

/** Fewest scored events before a follow-through stat can be called proven. */
export const MIN_SCORED_EVENTS = 20

function scoreFollowThrough(
  candles: Candle[],
  items: { idx: number; dir: 'call' | 'put'; groups: string[] }[],
  horizon: number,
  payout: number,
  z: number,
): FollowThroughStat[] {
  const breakeven = 1 / (1 + payout)
  const tally = new Map<string, { n: number; wins: number }>()
  const last = candles.length - 1
  for (const it of items) {
    if (it.idx + horizon > last) continue // horizon candle not closed yet - never scored
    const out = candles[it.idx + horizon].close - candles[it.idx].close
    const win = (it.dir === 'call' && out > 0) || (it.dir === 'put' && out < 0)
    for (const g of it.groups) {
      const t = tally.get(g) ?? { n: 0, wins: 0 }
      t.n++
      if (win) t.wins++
      tally.set(g, t)
    }
  }
  const stats: FollowThroughStat[] = []
  for (const [group, t] of tally) {
    const rate = t.n ? t.wins / t.n : 0
    // multi-candle outcomes of nearby events overlap - deflate like calibratededge.ts does
    const nEff = t.n / horizon
    const lowerBound = wilsonLower(rate * nEff, nEff, z)
    const enough = t.n >= MIN_SCORED_EVENTS
    stats.push({ group, horizon, n: t.n, wins: t.wins, rate, lowerBound, breakeven, enough, proven: enough && lowerBound >= breakeven })
  }
  stats.sort((a, b) => (a.group === 'all' ? -1 : b.group === 'all' ? 1 : a.group.localeCompare(b.group)))
  return stats
}

/** Greatest candle index whose open time is <= `time` (brick times can be a few
 * seconds past their candle's open - see renko.ts's timeRule). */
function candleIndexAt(candles: Candle[], time: number): number {
  let lo = 0
  let hi = candles.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].time <= time) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

export interface FeedOpts {
  /** newest events returned (default 40, max 200) - follow-through always scores ALL events in the window */
  limit?: number
  /** candles ahead the follow-through check looks (default 1, max 5) */
  horizon?: number
  /** payout fraction for the breakeven, e.g. 0.85 */
  payout?: number
  /** one-sided confidence z for the Wilson floor (default 1.64) */
  z?: number
}

function readFeedOpts(opts: FeedOpts) {
  return {
    limit: Math.max(1, Math.min(200, Math.round(opts.limit ?? 40))),
    horizon: Math.max(1, Math.min(5, Math.round(opts.horizon ?? 1))),
    payout: opts.payout !== undefined && opts.payout > 0 && opts.payout < 2 ? opts.payout : 0.85,
    z: Math.max(0.5, Math.min(3.5, opts.z ?? 1.64)),
  }
}

// ---------------------------------------------------------------------------
// Renko / Effort Bricks reversals
// ---------------------------------------------------------------------------

export interface RenkoReversalEvent {
  time: number
  /** Candle index the reversal brick completed on. */
  candleIdx: number
  /** Closed candles AFTER that one (0 = it completed on the newest candle). */
  candlesAgo: number
  /** Direction of the NEW run: call = flipped up, put = flipped down. */
  dir: 'call' | 'put'
  /** Close of the reversal brick. */
  price: number
  /** Bricks in the run that just ended. */
  priorRun: number
  /** Effort source only - was the reversal brick's volume >= effortMult x the trailing average? null on plain Renko / no-volume pairs. */
  confirmed: boolean | null
  effortRatio: number | null
  /** Effort source only - the participation regime over the `lookback` bricks ending at this one. null on plain Renko. */
  regime: EffortRegime | null
}

export interface RenkoReversalFeed {
  source: ReversalSource
  brickSize: number
  brickRule: string
  /** 'volume' / 'none' (all-zero volume - nothing can be confirmed) on the effort source; 'n/a' on plain Renko. */
  effortSource: 'volume' | 'none' | 'n/a'
  trend: 'up' | 'down' | 'none'
  streak: number
  confirmedRatio: number
  regime: EffortRegime | null
  candleCount: number
  lastCandleTime: number
  /** All reversals found in the window (events[] is the newest `limit` of them). */
  totalReversals: number
  events: RenkoReversalEvent[]
  followThrough: FollowThroughStat[]
}

export function renkoReversalFeed(
  candles: Candle[],
  opts: FeedOpts & { source?: ReversalSource; brickSize?: number; atrPeriod?: number; atrMult?: number; effortMult?: number; lookback?: number } = {},
): RenkoReversalFeed {
  const f = readFeedOpts(opts)
  const source: ReversalSource = opts.source === 'renko' ? 'renko' : 'effort'
  const n = candles.length
  const lastCandleTime = n ? candles[n - 1].time : 0

  type B = { time: number; close: number; dir: 1 | -1; confirmed?: boolean; effortRatio?: number }
  let bricks: B[]
  let brickSize: number
  let brickRule: string
  let effortSource: RenkoReversalFeed['effortSource'] = 'n/a'
  let trend: RenkoReversalFeed['trend']
  let streak: number
  let confirmedRatio = 0
  let regime: EffortRegime | null = null
  let lookback = Math.max(2, Math.min(100, Math.round(opts.lookback ?? 20)))
  let effortBrickList: ReturnType<typeof effortBricks>['bricks'] = []

  if (source === 'effort') {
    const r = effortBricks(candles, { brickSize: opts.brickSize, atrPeriod: opts.atrPeriod, atrMult: opts.atrMult, effortMult: opts.effortMult, lookback })
    bricks = r.bricks
    effortBrickList = r.bricks
    brickSize = r.brickSize
    brickRule = r.brickRule
    effortSource = r.effortSource
    trend = r.trend
    streak = r.streak
    confirmedRatio = r.confirmedRatio
    regime = r.regime
    lookback = r.lookback
  } else {
    const r = renkoBricks(candles, { brickSize: opts.brickSize, atrPeriod: opts.atrPeriod, atrMult: opts.atrMult })
    bricks = r.bricks
    brickSize = r.brickSize
    brickRule = r.brickRule
    trend = r.trend
    streak = r.streak
  }

  const all: RenkoReversalEvent[] = []
  for (let k = 1; k < bricks.length; k++) {
    if (bricks[k].dir === bricks[k - 1].dir) continue
    let priorRun = 0
    for (let j = k - 1; j >= 0 && bricks[j].dir === bricks[k - 1].dir; j--) priorRun++
    const idx = candleIndexAt(candles, bricks[k].time)
    let evRegime: EffortRegime | null = null
    if (source === 'effort') {
      evRegime = effortSource === 'volume' && k + 1 >= lookback ? classifyEffortRegime(effortBrickList.slice(k + 1 - lookback, k + 1)).regime : 'none'
    }
    const eb = source === 'effort' ? effortBrickList[k] : null
    all.push({
      time: bricks[k].time,
      candleIdx: idx,
      candlesAgo: n - 1 - idx,
      dir: bricks[k].dir === 1 ? 'call' : 'put',
      price: bricks[k].close,
      priorRun,
      confirmed: eb && effortSource === 'volume' ? eb.confirmed : null,
      effortRatio: eb && Number.isFinite(eb.effortRatio) ? eb.effortRatio : null,
      regime: evRegime,
    })
  }

  const followThrough = scoreFollowThrough(
    candles,
    all.map((e) => ({
      idx: e.candleIdx,
      dir: e.dir,
      groups: e.confirmed === null ? ['all'] : ['all', e.confirmed ? 'confirmed' : 'unconfirmed'],
    })),
    f.horizon,
    f.payout,
    f.z,
  )

  return {
    source,
    brickSize,
    brickRule,
    effortSource,
    trend,
    streak,
    confirmedRatio,
    regime,
    candleCount: n,
    lastCandleTime,
    totalReversals: all.length,
    events: all.slice(-f.limit).reverse(),
    followThrough,
  }
}

// ---------------------------------------------------------------------------
// Kagi reversals + yin/yang thickness flips
// ---------------------------------------------------------------------------

export interface KagiFeedEvent {
  time: number
  candleIdx: number
  candlesAgo: number
  type: 'reversal' | 'yang' | 'yin'
  /** call = bullish event (up-reversal / yang), put = bearish (down-reversal / yin). */
  dir: 'call' | 'put'
  price: number
  /** The extreme a reversal turned from / the shoulder a yang broke / the waist a yin broke. */
  level: number | null
  /** Line thickness after the event. */
  thick: boolean
}

export interface KagiReversalFeed {
  /** The reversal threshold in price (ATR-adaptive unless explicit). */
  reversal: number
  direction: 'up' | 'down' | 'none'
  /** Current line thickness: true = yang (thick), false = yin (thin). */
  thick: boolean
  shoulder: number | null
  waist: number | null
  structure: 'hh-hl' | 'lh-ll' | 'none'
  regime: KagiRegime
  legsInWindow: number
  candleCount: number
  lastCandleTime: number
  counts: { reversal: number; yang: number; yin: number }
  events: KagiFeedEvent[]
  followThrough: FollowThroughStat[]
}

export function kagiReversalFeed(
  candles: Candle[],
  opts: FeedOpts & { reversal?: number; atrPeriod?: number; reversalAtrMult?: number; regimeLookback?: number } = {},
): KagiReversalFeed {
  const f = readFeedOpts(opts)
  const n = candles.length
  const r = kagi(candles, { reversal: opts.reversal, atrPeriod: opts.atrPeriod, reversalAtrMult: opts.reversalAtrMult, regimeLookback: opts.regimeLookback })
  const all: KagiFeedEvent[] = r.events.map((e) => ({
    time: e.time,
    candleIdx: e.index,
    candlesAgo: n - 1 - e.index,
    type: e.type,
    dir: e.dir === 1 ? 'call' : 'put',
    price: e.price,
    level: e.level,
    thick: e.thick,
  }))
  const counts = { reversal: 0, yang: 0, yin: 0 }
  for (const e of all) counts[e.type]++

  const followThrough = scoreFollowThrough(
    candles,
    all.map((e) => ({ idx: e.candleIdx, dir: e.dir, groups: ['all', e.type] })),
    f.horizon,
    f.payout,
    f.z,
  )

  return {
    reversal: r.reversal,
    direction: r.direction === 1 ? 'up' : r.direction === -1 ? 'down' : 'none',
    thick: r.thick,
    shoulder: r.shoulder,
    waist: r.waist,
    structure: r.structure,
    regime: r.regime,
    legsInWindow: r.legsInWindow,
    candleCount: n,
    lastCandleTime: n ? candles[n - 1].time : 0,
    counts,
    events: all.slice(-f.limit).reverse(),
    followThrough,
  }
}
