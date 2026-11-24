// IQAIR//OS - Anchor-Difference chart engine.
//
// An Anchor-Difference candle is an ordinary candle whose four prices are
// measured from an ANCHOR instead of from zero:   value = price - anchor.
// The anchor is the close of the last COMPLETED period (default 4h) before the
// candle opened - e.g. yesterday's close 1.15 and price 1.17 give +0.02.
// The candles are time-bound exactly like normal candles (same count, same
// times); only the math behind the four numbers changes. The anchor is
// switchable ("15m" | "30m" | "1h" | "4h" | "1d" | "1w" or any <n>m/<n>h/<n>d).
//
// Every bar also carries the numbers a strategy wants:
//   tr, atr          true range / ATR(14) of the candle (price units)
//   z                close difference in ATR units  = (close - anchor) / atr
//   roc / rocAtr     ROC of the DIFFERENCE over `rocPeriod` bars: roc is the
//                    percent change of the gap, rocAtr = (gap - gap[n]) / atr
//   cci, mfi, rsi    CCI(20), MFI(14), RSI(14)
//   crossed          +1/-1 when the close crossed the anchor (zero line) on this bar
//   rolled           true on the first bar of a new anchor period
//
// HONESTY about which numbers are "new":
//   - Inside one anchor period the difference series is the price series shifted
//     by a constant, so TR, ATR, CCI and RSI of the difference are IDENTICAL to
//     the price versions (they only look at changes / deviations). Across a roll
//     the anchor jumps; computing them on a raw difference series would print a
//     fake spike at every roll, so they are computed on the PRICE bars and carried.
//   - MFI multiplies the typical price by volume, so it needs real prices and is
//     computed on the price bars for the same reason.
//   - What is genuinely about the difference: open/high/low/close, z, roc, rocAtr,
//     crossed, rolled, and the anchor itself.
//
// Pure function, no I/O, no look-ahead: bar i only sees bars <= i and an anchor
// that was closed before bar i opened.

import type { Candle } from '../types'
import { atr as atrFn, cci as cciFn, mfi as mfiFn, rsi as rsiFn, trueRange } from './indicators'

export interface AnchorBar {
  time: number
  /** difference candle: price - anchor (raw price units) */
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** the anchor price in effect for this bar */
  anchor: number
  /** true on the first bar that uses a new anchor */
  rolled: boolean
  tr: number
  atr: number
  /** (close - anchor) / atr, NaN until ATR exists */
  z: number
  /** percent change of the difference over rocPeriod bars; NaN when the earlier gap is under 0.3 ATR (a tiny gap makes a percentage meaningless) or has the opposite sign */
  roc: number
  /** (close gap - gap rocPeriod bars ago, re-based to this bar's anchor) / atr - always defined once ATR exists */
  rocAtr: number
  cci: number
  mfi: number
  rsi: number
  /** +1 close went from below to above the anchor on this bar, -1 the reverse, 0 none */
  crossed: 1 | -1 | 0
}

export interface AnchorDiffResult {
  anchorSec: number
  anchorLabel: string
  rocPeriod: number
  bars: AnchorBar[]
}

export interface AnchorDiffOptions {
  /** anchor period, e.g. "4h" (default), "1h", "1d", or seconds as a number */
  anchor?: string | number
  atrPeriod?: number
  rocPeriod?: number
  cciPeriod?: number
  mfiPeriod?: number
  rsiPeriod?: number
}

/** "15m" | "4h" | "1d" | "1w" | "90s" -> seconds. Null if it is not a period. */
export function parseAnchorPeriod(p: string | number | undefined): number | null {
  if (p === undefined || p === '') return 4 * 3600
  if (typeof p === 'number') return Number.isFinite(p) && p >= 60 ? Math.round(p) : null
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$/i.exec(p)
  if (!m) return null
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd' | 'w']
  const sec = Math.round(Number(m[1]) * mult)
  return sec >= 60 ? sec : null
}

export const ANCHOR_PRESETS = ['15m', '30m', '1h', '4h', '1d', '1w'] as const

export function computeAnchorDiff(candles: Candle[], opts: AnchorDiffOptions = {}): AnchorDiffResult | null {
  const P = parseAnchorPeriod(opts.anchor)
  if (P === null) return null
  const atrP = opts.atrPeriod ?? 14
  const rocP = Math.max(1, Math.round(opts.rocPeriod ?? 5))
  const n = candles.length
  if (!n) return { anchorSec: P, anchorLabel: String(opts.anchor ?? '4h'), rocPeriod: rocP, bars: [] }
  const hi = candles.map((c) => c.high)
  const lo = candles.map((c) => c.low)
  const cl = candles.map((c) => c.close)
  const vol = candles.map((c) => c.volume || 0)
  const trS = trueRange(hi, lo, cl)
  const atrS = atrFn(hi, lo, cl, atrP)
  const cciS = cciFn(hi, lo, cl, opts.cciPeriod ?? 20)
  const mfiS = mfiFn(hi, lo, cl, vol, opts.mfiPeriod ?? 14)
  const rsiS = rsiFn(cl, opts.rsiPeriod ?? 14)

  // anchor for each bar = close of the last candle that opened BEFORE this bar's period started
  const anchors = new Array<number>(n).fill(NaN)
  let curBucket = Number.NaN
  let curAnchor = Number.NaN
  let lastBeforeBucket = Number.NaN // close of the last candle of any earlier bucket
  let lastClose = Number.NaN
  for (let i = 0; i < n; i++) {
    const b = Math.floor(candles[i].time / P)
    if (b !== curBucket) {
      // entering a new bucket: the previous candle's close is the last close before it
      curAnchor = i > 0 ? lastClose : Number.NaN
      lastBeforeBucket = curAnchor
      curBucket = b
    }
    anchors[i] = lastBeforeBucket
    lastClose = candles[i].close
  }

  const bars: AnchorBar[] = []
  const idxOf: number[] = [] // bar index in `candles` for each emitted bar
  for (let i = 0; i < n; i++) {
    const a = anchors[i]
    if (!Number.isFinite(a)) continue
    const prevA = i > 0 ? anchors[i - 1] : Number.NaN
    const rolled = !Number.isFinite(prevA) || a !== prevA || Math.floor(candles[i].time / P) !== Math.floor(candles[i - 1].time / P)
    const c = candles[i]
    const atrV = atrS[i]
    const d = c.close - a
    // previous close re-based to THIS bar's anchor, so a roll never fakes a crossing
    const prevD = i > 0 ? candles[i - 1].close - a : Number.NaN
    let crossed: 1 | -1 | 0 = 0
    if (Number.isFinite(prevD)) {
      if (prevD <= 0 && d > 0) crossed = 1
      else if (prevD >= 0 && d < 0) crossed = -1
    }
    let roc = Number.NaN
    let rocAtr = Number.NaN
    if (i - rocP >= 0) {
      const dp = cl[i - rocP] - a // gap rocP bars ago, re-based to the current anchor
      if (Number.isFinite(atrV) && atrV > 0) {
        rocAtr = (d - dp) / atrV
        if (Math.abs(dp) >= 0.3 * atrV && dp * d > 0) roc = ((Math.abs(d) - Math.abs(dp)) / Math.abs(dp)) * 100
      }
    }
    bars.push({
      time: c.time,
      open: c.open - a,
      high: c.high - a,
      low: c.low - a,
      close: d,
      volume: c.volume || 0,
      anchor: a,
      rolled,
      tr: trS[i],
      atr: atrV,
      z: Number.isFinite(atrV) && atrV > 0 ? d / atrV : Number.NaN,
      roc,
      rocAtr,
      cci: cciS[i],
      mfi: mfiS[i],
      rsi: rsiS[i],
      crossed,
    })
    idxOf.push(i)
  }
  return { anchorSec: P, anchorLabel: typeof opts.anchor === 'string' ? opts.anchor : `${P}s`, rocPeriod: rocP, bars }
}
