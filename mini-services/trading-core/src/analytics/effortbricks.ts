// IQAIR//OS - Effort Bricks engine (effort-confirmed Renko).
//
// Classic Renko (renko.ts) paints a brick purely on PRICE DISTANCE - a
// brick clears the same way whether it formed from one heavy-volume candle
// or a thin, directionless drift that happened to add up to one brick's
// worth of movement. This engine adds the other half of the classic
// Wyckoff "effort vs result" relationship directly into the bar: a brick
// still paints on distance alone (a real price move is never silently
// dropped - same honesty rule every chart engine in this codebase
// follows), but it additionally carries how much PARTICIPATION (volume)
// was behind it, relative to a trailing average of recent bricks, and is
// marked `confirmed` only when that participation cleared a threshold
// multiplier (`effortMult`, default 1.0 = at least average). A run of
// unconfirmed bricks - distance painted without real volume behind it - is
// exactly the signature of a choppy, low-conviction market; a run of
// confirmed bricks running one direction is a real, participation-backed
// trend. This is the one thing none of this codebase's existing brick/box
// engines (Renko, P&F, Range Bars, Line Break, Kagi) do: they are all
// pure-price, with zero participation awareness.
//
// VOLUME HONESTY (same convention as volumebars.ts/footprint.ts/
// deltaprofile.ts): a candle's own `volume` field is folded in as-is - on
// IQ Option's OTC/synthetic instruments this is commonly a tick/sample
// count, not genuine traded size, same disclosed limitation every other
// volume-consuming engine in this codebase carries. `effortSource` reads
// 'none' (the confirmation gate auto-disables - every brick then reads
// back honestly unconfirmed, never a fabricated "confirmed") when the
// whole candle window is all-zero volume, same degenerate handling
// volumebars.ts already uses rather than pretending participation data
// exists where none does.
//
// ONE CANDLE, SEVERAL BRICKS: when a single candle's move is large enough
// to complete more than one brick in the same pass, its WHOLE volume folds
// into the FIRST brick only - which share of that one candle's volume
// "belongs" to the second/third brick is unknowable from OHLCV alone (the
// same "intra-candle path order is unknowable" problem renko.ts's own
// header already discloses for brick times), so subsequent bricks from
// that candle honestly carry effort:0 rather than guessing a split.
//
// Brick geometry (continuation/reversal sizing and the classic 2-brick
// reversal rule) is the SAME rule renko.ts uses. This is a sibling engine,
// not a wrapper around it: attributing volume to the exact candles that
// painted each specific brick needs the same walk renko.ts does, just with
// a running volume sum kept alongside it, so the walk is reimplemented
// here rather than bolted onto renkoBricks()'s own return shape.
//
// REGIME READ: over the trailing `lookback` bricks (default 20, needs at
// least that many painted to read anything but 'none' - same "can't
// confirm yet" honesty convention swing.ts's own lookback-lag already
// uses), the share that are `confirmed` classifies the window:
//   - confirmedRatio >= REGIME_CONFIRMED_FLOOR and one direction dominates
//     the confirmed bricks -> 'trending' (real, participation-backed trend)
//   - confirmedRatio >= REGIME_CONFIRMED_FLOOR but confirmed bricks run
//     both ways -> 'ranging' (genuine, participation-backed swings between
//     levels, not noise)
//   - confirmedRatio < REGIME_CONFIRMED_FLOOR -> 'choppy' (distance painted
//     without real conviction behind it - exactly what makes plain Renko
//     whipsaw)
//
// Pure function, O(n) over candles, no look-ahead: a brick (and its effort
// reading) is only ever built from data the candle carried, so backtests
// (closed-bar slices) and live reads agree bar-for-bar - this is a
// SAFE_BACKTEST_SOURCES-tier engine, unlike the tick/footprint primitives.

import type { Candle } from '../types'

export interface EffortBrick {
  /** Open time of the candle that COMPLETED this brick (same convention as renko.ts). */
  time: number
  open: number
  high: number
  low: number
  close: number
  /** 1 = up brick, -1 = down brick. */
  dir: 1 | -1
  /** Summed volume of the candle(s) that painted this brick (approx - see module header's VOLUME HONESTY note). */
  effort: number
  /** effort / trailing average effort-per-brick as of just before this brick painted (1.0 = average). NaN when effortSource is 'none', or before enough prior bricks exist to average against. */
  effortRatio: number
  /** effortRatio >= effortMult AND effortSource === 'volume'. Always false when effortSource is 'none' (no real participation data to confirm against) or on an early brick with no trailing average yet. */
  confirmed: boolean
}

export type EffortRegime = 'trending' | 'ranging' | 'choppy' | 'none'

export interface EffortBarsResult {
  brickSize: number
  /** How brickSize was derived. */
  brickRule: string
  /** The participation-multiplier threshold a brick's effortRatio must clear to count as confirmed. */
  effortMult: number
  /** How many trailing bricks the regime/trailing-average reads look back over. */
  lookback: number
  bricks: EffortBrick[]
  /** 'none' when the whole candle window carried zero volume - the confirmation gate honestly disables rather than fabricating participation data. */
  effortSource: 'volume' | 'none'
  /** Direction of the last brick. */
  trend: 'up' | 'down' | 'none'
  /** Consecutive same-direction bricks ending at the last one. */
  streak: number
  /** Share of the last `lookback` bricks that were confirmed. 0 until at least `lookback` bricks have painted. */
  confirmedRatio: number
  regime: EffortRegime
  /** The ATR the brick size was derived from (NaN when brickSize was explicit). */
  atr: number
}

/** Share of the trailing window that must be confirmed for the regime read
 * to call it 'trending'/'ranging' instead of 'choppy'. */
const REGIME_CONFIRMED_FLOOR = 0.6
/** Share of CONFIRMED bricks in the trailing window that must share one
 * direction for the regime read to call it 'trending' instead of 'ranging'. */
const REGIME_DOMINANCE_FLOOR = 0.6

/** Mean true range over the last `period` candles (simple mean, same
 * deterministic/restart-stable convention renko.ts's own local helper
 * uses - duplicated rather than imported, same dependency-isolation
 * reasoning renko.ts/rangebars.ts/kagi.ts each already state for their own
 * copies). Returns NaN when history is too thin. */
function effortAtr(candles: Candle[], period: number): number {
  if (candles.length < 2) return NaN
  const n = Math.min(period, candles.length - 1)
  let sum = 0
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i]
    const prev = candles[i - 1]
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
  }
  return sum / n
}

export function effortBricks(
  candles: Candle[],
  opts: { brickSize?: number; atrPeriod?: number; atrMult?: number; effortMult?: number; lookback?: number } = {}
): EffortBarsResult {
  const atrPeriod = Math.max(2, Math.round(opts.atrPeriod ?? 14))
  const atrMult = Math.max(0.05, opts.atrMult ?? 0.3)
  const atr = effortAtr(candles, atrPeriod)
  const explicit = opts.brickSize !== undefined && Number.isFinite(opts.brickSize) && opts.brickSize > 0
  const brickSize = explicit ? (opts.brickSize as number) : Math.max(Number.isFinite(atr) ? atr * atrMult : 0, 1e-9)
  const brickRule = explicit ? `explicit ${brickSize}` : `ATR(${atrPeriod}) x ${atrMult}`
  const effortMult = Math.max(0.1, opts.effortMult ?? 1.0)
  const lookback = Math.max(2, Math.min(100, Math.round(opts.lookback ?? 20)))

  const anyVolume = candles.some((c) => Number.isFinite(c.volume) && c.volume > 0)
  const effortSource: 'volume' | 'none' = anyVolume ? 'volume' : 'none'

  const bricks: EffortBrick[] = []
  if (!Number.isFinite(brickSize) || brickSize <= 0 || candles.length === 0) {
    return { brickSize, brickRule, effortMult, lookback, bricks, effortSource, trend: 'none', streak: 0, confirmedRatio: 0, regime: 'none', atr }
  }

  let lastClose = candles[0].close // reference = close of the last painted brick (seeded with the first candle)
  let dir: 0 | 1 | -1 = 0
  let flips = 0
  let pendingVolume = 0 // volume accumulated since the last painted brick (reset on paint - see ONE CANDLE, SEVERAL BRICKS above)
  const effortHistory: number[] = [] // trailing pool of recent bricks' own effort, chronological, capped at `lookback`

  for (const c of candles) {
    pendingVolume += Number.isFinite(c.volume) ? Math.max(0, c.volume) : 0
    let painted = 0
    const paint = (open: number, close: number, d: 1 | -1) => {
      const trailing = effortHistory.length ? effortHistory.reduce((a, b) => a + b, 0) / effortHistory.length : NaN
      const effort = pendingVolume
      const effortRatio = effortSource === 'volume' && Number.isFinite(trailing) && trailing > 0 ? effort / trailing : NaN
      const confirmed = effortSource === 'volume' && Number.isFinite(effortRatio) && effortRatio >= effortMult
      bricks.push({
        time: c.time + painted,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        dir: d,
        effort,
        effortRatio,
        confirmed,
      })
      effortHistory.push(effort)
      if (effortHistory.length > lookback) effortHistory.shift()
      painted++
      lastClose = close
      pendingVolume = 0 // this candle's volume already spent on the brick(s) it just painted (see header note)
      if (dir !== 0 && dir !== d) flips++
      dir = d
    }

    if (dir === 0) {
      // seed: whichever side clears one brick first
      if (c.close >= lastClose + brickSize) paint(lastClose, lastClose + brickSize, 1)
      else if (c.close <= lastClose - brickSize) paint(lastClose, lastClose - brickSize, -1)
    }

    // paint() mutates `dir` through this closure - re-widen before the
    // per-direction blocks (same TS control-flow caveat renko.ts notes)
    dir = dir as 0 | 1 | -1

    if (dir === 1) {
      while (c.close >= lastClose + brickSize) paint(lastClose, lastClose + brickSize, 1)
      if (c.close <= lastClose - 2 * brickSize) {
        paint(lastClose - brickSize, lastClose - 2 * brickSize, -1)
      }
    }

    if (dir === -1) {
      while (c.close <= lastClose - brickSize) paint(lastClose, lastClose - brickSize, -1)
      if (c.close >= lastClose + 2 * brickSize) {
        paint(lastClose + brickSize, lastClose + 2 * brickSize, 1)
      }
    }
  }

  // ascending guard, same reasoning as renko.ts's own
  for (let i = 1; i < bricks.length; i++) {
    if (bricks[i].time <= bricks[i - 1].time) bricks[i].time = bricks[i - 1].time + 1
  }

  let streak = 0
  const trend: EffortBarsResult['trend'] = dir === 0 ? 'none' : dir === 1 ? 'up' : 'down'
  if (bricks.length) {
    const d = bricks[bricks.length - 1].dir
    for (let i = bricks.length - 1; i >= 0 && bricks[i].dir === d; i--) streak++
  }

  let confirmedRatio = 0
  let regime: EffortRegime = 'none'
  if (bricks.length >= lookback && effortSource === 'volume') {
    const recent = bricks.slice(-lookback)
    const confirmedBricks = recent.filter((b) => b.confirmed)
    confirmedRatio = confirmedBricks.length / recent.length
    if (confirmedRatio >= REGIME_CONFIRMED_FLOOR) {
      const up = confirmedBricks.filter((b) => b.dir === 1).length
      const down = confirmedBricks.length - up
      const dominant = confirmedBricks.length === 0 || Math.abs(up - down) / confirmedBricks.length >= REGIME_DOMINANCE_FLOOR
      regime = dominant ? 'trending' : 'ranging'
    } else {
      regime = 'choppy'
    }
  }

  return {
    brickSize,
    brickRule,
    effortMult,
    lookback,
    bricks,
    effortSource,
    trend,
    streak,
    confirmedRatio,
    regime,
    atr: explicit ? NaN : atr,
  }
}
