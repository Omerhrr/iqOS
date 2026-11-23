// IQAIR//OS - SIM FILTER: telling SIMULATED candles apart from real broker candles that were stored under the same asset.
//
// Why it is needed: the paper / SIM engine builds candles from ticks like price * exp(noise), so its prices carry a long float tail (97234.894031..., 1.0834129987...). Real broker prices are
// quoted at a FIXED precision (BTCUSD 3 decimals, EURUSD 5, ...), and a real candle only ever copies quotes (open / high / low / close are broker prices, never computed), so a real bar never
// has more decimals than the broker's quote precision. Before provenance tracking existed, sim bars were archived under the real asset name and later mixed with real bars.
//   realDecimals(...)  the quote precision, measured on bars that just came from the broker (the sidecar)
//   isSimBar(bar, d)   true when any of open/high/low/close has more than d + 1 decimals
// The +1 margin absorbs a broker that occasionally quotes one digit deeper; the sim's tail is typically 6-15 digits deeper than the real precision, so the margin costs nothing.
// HONEST LIMIT: a sim bar whose price happens to round to the broker precision is not caught (rare: the sim does not round). Always run the cleaner as a dry run first and read the counts.
import type { Candle } from '../types'

/** decimal digits of a JS number as printed (handles exponent form) */
export function decimalsOf(x: number): number {
  if (!Number.isFinite(x)) return 0
  const s = String(Math.abs(x))
  const e = /e([+-]\d+)$/i.exec(s)
  const mant = e ? s.slice(0, s.search(/e/i)) : s
  const frac = mant.includes('.') ? mant.split('.')[1].length : 0
  const exp = e ? Number(e[1]) : 0
  return Math.max(0, frac - exp)
}

/** the broker's quote precision: the most decimals seen on real bars (needs a handful of bars) */
export function realDecimals(real: readonly Candle[]): number | null {
  if (real.length < 20) return null
  let d = 0
  for (const c of real) d = Math.max(d, decimalsOf(c.open), decimalsOf(c.high), decimalsOf(c.low), decimalsOf(c.close))
  return d
}

export function isSimBar(c: Pick<Candle, 'open' | 'high' | 'low' | 'close'>, realDec: number): boolean {
  const lim = realDec + 1
  return decimalsOf(c.open) > lim || decimalsOf(c.high) > lim || decimalsOf(c.low) > lim || decimalsOf(c.close) > lim
}

export function simTimes(bars: readonly Candle[], realDec: number): number[] {
  const out: number[] = []
  for (const c of bars) if (isSimBar(c, realDec)) out.push(c.time)
  return out
}
