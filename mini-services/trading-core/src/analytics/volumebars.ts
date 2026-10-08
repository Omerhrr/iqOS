// IQAIR//OS - Constant (equi) volume bar engine (kernel-side engine of record).
//
// A bar closes when cumulative volume since the last bar first reaches
// `per`; the overshoot folds into the bar that crossed the threshold (the
// classic "one bar per volume unit" rule - bars are NOT re-split to keep the
// total exact, which would leak the next bar's data backwards). OHLC
// aggregate every candle that contributed to the bar.
//
// HONEST TIMES: unlike renko/P&F/range bars, volume bars HAVE a real clock -
// `time` is the open time of the FIRST candle that contributed to the bar
// (ascending by construction), `endTime` the open time of the candle that
// closed it. `timeRule` documents this.
//
// VOLUME HONESTY (mirrors orderflow.ts): IQ Option's "volume" for OTC/synthetic
// instruments is commonly a tick/sample count rather than genuine traded
// size, and post-restart archive reads can carry volume 0 (Task 59 finding).
// The result carries `volumeSource` ('feed' | 'none') and callers/UI must
// label it "volume (approx)". When the window is ALL-ZERO volume the engine
// returns degenerate:true with zero bars - the route turns that into an
// honest 400 instead of pretending one giant bar.
//
// Pure function, O(n), no look-ahead: bars are closed only by volume that
// already arrived, so closed-bar backtests and live reads agree.

import type { Candle } from '../types'

export interface VolumeBar {
  /** Open time of the FIRST candle contributing to this bar. */
  time: number
  /** Open time of the candle that CLOSED this bar. */
  endTime: number
  open: number
  high: number
  low: number
  close: number
  /** Cumulative (approx) volume folded into this bar (>= per except the last). */
  volume: number
  /** Candles aggregated into this bar. */
  candles: number
}

export interface VolumeBarsResult {
  per: number
  perRule: string
  timeRule: string
  /** 'feed' when any candle carried volume > 0, 'none' when all-zero. */
  volumeSource: 'feed' | 'none'
  /** True when the window had candles but zero total volume (route 400s). */
  degenerate: boolean
  bars: VolumeBar[]
}

/** Median candle volume over the window (used by the auto `per` rule). */
function medianVolume(candles: Candle[]): number {
  if (!candles.length) return 0
  const v = candles.map((c) => c.volume).sort((a, b) => a - b)
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

export function volumeBars(candles: Candle[], opts: { per?: number } = {}): VolumeBarsResult {
  const timeRule = 'first contributing candle open time (real clock)'
  const totalVol = candles.reduce((s, c) => s + (Number.isFinite(c.volume) ? c.volume : 0), 0)
  const volumeSource: 'feed' | 'none' = totalVol > 0 ? 'feed' : 'none'
  if (candles.length > 0 && volumeSource === 'none') {
    return { per: opts.per ?? 0, perRule: 'n/a - all-zero volume window', timeRule, volumeSource, degenerate: true, bars: [] }
  }

  // auto sizing: target ~80 bars out of the window, floored to a positive
  // value so a single heavy candle can never stall the engine
  const explicit = opts.per !== undefined && Number.isFinite(opts.per) && opts.per > 0
  const per = explicit
    ? (opts.per as number)
    : Math.max(totalVol / 80, medianVolume(candles) * 0.25, 1e-9)
  const perRule = explicit ? `explicit ${per}` : `auto (totalVol/80, floor median*0.25) = ${per}`

  const bars: VolumeBar[] = []
  let cur: VolumeBar | null = null
  let acc = 0

  for (const c of candles) {
    const vol = Number.isFinite(c.volume) ? c.volume : 0
    if (!cur) {
      cur = { time: c.time, endTime: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: 0, candles: 0 }
    }
    cur.high = Math.max(cur.high, c.high)
    cur.low = Math.min(cur.low, c.low)
    cur.close = c.close
    cur.volume += vol
    cur.candles++
    acc += vol
    if (acc >= per) {
      cur.endTime = c.time
      bars.push(cur)
      cur = null
      acc = 0
    }
  }
  // trailing partial bar: keep it (it is the honest "still forming" bar)
  if (cur) bars.push(cur)

  return { per, perRule, timeRule, volumeSource, degenerate: false, bars }
}
