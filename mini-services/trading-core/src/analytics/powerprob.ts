// IQAIR//OS - Bull/Bear Power + footprint-proxy next-candle probability (MSL `pp.*`).
//
// "What fraction of the time did the NEXT candle close up, on this pair's own history, after a bar that looked like
// this one?" - an EMPIRICAL probability, not a score. Two readings of the latest closed bar decide its bucket:
//   1. Elder Ray Bull/Bear Power: bullPower = high - EMA13, bearPower = low - EMA13; net = (bull + bear) / ATR14.
//      Five levels: strongly bearish / bearish / balanced / bullish / strongly bullish.
//   2. A candle-volume FOOTPRINT PROXY: bar delta = volume x CLV, CLV = (2*close - high - low) / (high - low), normalised by the
//      mean volume of the last 20 bars. Three levels: sellers / neutral / buyers. This is NOT real order flow: IQ Option gives no
//      bid/ask or per-price volume, so the delta is only where inside its range each candle closed, weighted by its volume. When
//      volume is flat or mostly zero (OTC and some feeds) the footprint is unavailable (`volumeOk` false), every bar is put in the
//      neutral footprint level, and the read degrades to Bull/Bear Power alone - scripts should gate on pp.volumeOk().
// The probability for the latest bar is the up-rate of EARLIER bars in the same (power level, footprint level) bucket whose next
// candle has already closed (no look-ahead: the latest bar's own outcome is never counted, features use only past bars), over a
// trailing window (default 1500 bars). Shrunk toward a coin flip as (ups + 1) / (n + 2) so a bucket seen twice cannot claim 100%.
// "Up" = the next close above THIS close (what a 1-bar binary on the next candle settles on); exact ties are dropped.
// Honest limits: the buckets are coarse (15), the sample behind each is whatever the history holds (check pp.n()), and a past
// frequency says nothing certain about the next candle. 70% on a 1-bar binary is a very high bar - expect it to fire rarely.

import type { Candle } from '../types'
import { atr, ema } from './indicators'

const EMA_PERIOD = 13
const ATR_PERIOD = 14
const VOL_MEAN = 20
const DEFAULT_WINDOW = 1500
export const POWERPROB_MIN_BARS = 80

export interface PowerProbRead {
  ok: boolean
  bars: number
  /** footprint proxy usable: volume varies and is mostly > 0 over the last 60 bars */
  volumeOk: boolean
  /** latest closed bar: (bullPower + bearPower) / ATR14 */
  net: number
  bull: number
  bear: number
  /** latest closed bar: volume x CLV / mean volume of the 20 bars up to it (NaN when volumeOk is false) */
  delta: number
  /** "<power level 0-4>/<footprint level 0-2>" */
  bucket: string
  powerLevel: number
  footLevel: number
  /** earlier bars in the same bucket whose next candle closed (excluding ties) */
  n: number
  ups: number
  /** (ups + 1) / (n + 2); 0.5 when n = 0 */
  pUp: number
  pDown: number
  /** Wilson 95% lower bounds for each side */
  lowUp: number
  lowDown: number
  /** unconditional up-rate over the same training window */
  base: number
  /** the side with the higher probability when it clears 50%, else 'none' */
  side: 'call' | 'put' | 'none'
}

const EMPTY: PowerProbRead = {
  ok: false, bars: 0, volumeOk: false, net: 0, bull: 0, bear: 0, delta: NaN, bucket: '', powerLevel: 2, footLevel: 1,
  n: 0, ups: 0, pUp: 0.5, pDown: 0.5, lowUp: 0, lowDown: 0, base: 0.5, side: 'none',
}

function wilsonLow(w: number, n: number): number {
  if (n <= 0) return 0
  const z = 1.96
  const p = w / n
  const d = 1 + (z * z) / n
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
}

const powerLevel = (net: number): number => (net <= -1.2 ? 0 : net <= -0.4 ? 1 : net < 0.4 ? 2 : net < 1.2 ? 3 : 4)
const footLevel = (d: number): number => (!Number.isFinite(d) ? 1 : d <= -0.35 ? 0 : d < 0.35 ? 1 : 2)

export function readPowerProb(candles: Candle[], opts: { window?: number } = {}): PowerProbRead {
  const n = candles.length
  if (n < POWERPROB_MIN_BARS) return { ...EMPTY, bars: n }
  const window = Math.max(100, Math.min(Math.round(opts.window ?? DEFAULT_WINDOW), 5000))
  const close = candles.map((c) => c.close)
  const high = candles.map((c) => c.high)
  const low = candles.map((c) => c.low)
  const vol = candles.map((c) => (Number.isFinite(c.volume) ? c.volume : 0))
  const e = ema(close, EMA_PERIOD)
  const a = atr(high, low, close, ATR_PERIOD)

  // is the footprint proxy usable? volume must vary and be mostly positive over the last 60 bars
  const tail = vol.slice(-60)
  const mean = tail.reduce((s, v) => s + v, 0) / tail.length
  const sd = Math.sqrt(tail.reduce((s, v) => s + (v - mean) * (v - mean), 0) / tail.length)
  const volumeOk = tail.filter((v) => v > 0).length >= tail.length * 0.8 && sd > 0

  // rolling mean volume of the 20 bars up to and including i
  const vsum: number[] = new Array(n).fill(NaN)
  let acc = 0
  for (let i = 0; i < n; i++) {
    acc += vol[i]
    if (i >= VOL_MEAN) acc -= vol[i - VOL_MEAN]
    if (i >= VOL_MEAN - 1) vsum[i] = acc / VOL_MEAN
  }

  const net: number[] = new Array(n).fill(NaN)
  const lvl: number[] = new Array(n).fill(-1)
  const delta: number[] = new Array(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(e[i]) || !Number.isFinite(a[i]) || a[i] <= 0) continue
    net[i] = (high[i] - e[i] + (low[i] - e[i])) / a[i]
    const rng = high[i] - low[i]
    if (volumeOk && Number.isFinite(vsum[i]) && vsum[i] > 0 && rng > 0) delta[i] = (vol[i] * ((2 * close[i] - high[i] - low[i]) / rng)) / vsum[i]
    lvl[i] = powerLevel(net[i]) * 3 + footLevel(delta[i])
  }

  const last = n - 1
  if (lvl[last] < 0) return { ...EMPTY, bars: n, volumeOk }
  let nb = 0, ub = 0, nAll = 0, uAll = 0
  const start = Math.max(0, last - window)
  for (let i = start; i < last; i++) {
    // bar i's next candle (i + 1 <= last) is closed; the latest bar's own outcome is never used
    if (lvl[i] < 0) continue
    const mv = close[i + 1] - close[i]
    if (mv === 0) continue
    const up = mv > 0 ? 1 : 0
    nAll++
    uAll += up
    if (lvl[i] === lvl[last]) {
      nb++
      ub += up
    }
  }
  const pUp = (ub + 1) / (nb + 2)
  const pDown = 1 - pUp
  const pl = Math.floor(lvl[last] / 3)
  const fl = lvl[last] % 3
  return {
    ok: true, bars: n, volumeOk, net: net[last], bull: (high[last] - e[last]) / a[last], bear: (low[last] - e[last]) / a[last],
    delta: delta[last], bucket: `${pl}/${fl}`, powerLevel: pl, footLevel: fl,
    n: nb, ups: ub, pUp, pDown, lowUp: wilsonLow(ub, nb), lowDown: wilsonLow(nb - ub, nb),
    base: nAll ? uAll / nAll : 0.5, side: pUp > 0.5 ? 'call' : pUp < 0.5 ? 'put' : 'none',
  }
}
