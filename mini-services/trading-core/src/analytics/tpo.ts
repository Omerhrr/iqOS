// IQAIR//OS - Market Profile / TPO (Time Price Opportunity) engine
// (kernel-side engine of record).
//
// Classic TPO: the session/window is split into 30-minute periods (classic
// bracket; configurable `periodSec` here because this OS tracks 5s..1d
// timeframes - when the chart tf is >= periodSec each candle becomes one
// period so short windows still build a profile). Every period "prints its
// letter" on every price bin its [low, high] range touched; the result is a
// horizontal histogram of TPO counts per price bin.
//
// Derived, standard quantities:
//   - POC      : the bin with the most TPOs (ties -> the bin closer to the
//                window's mid price, deterministic)
//   - ValueArea: expanding from POC, always absorbing the larger neighbor
//                (classic two-sided expansion, ties -> the upper neighbor
//                first) until >= 70% of all TPOs are inside
//   - IB       : Initial Balance = the first period's high/low range
//
// LETTERS: period k prints 'A'..'Z' then 'a'..'z' cycling (67+ period
// windows reuse letters - fine, letters are display sugar; `periods[]`
// carries the real indices/times).
//
// TPO COUNTING CONVENTION: a period touching a bin adds exactly 1 TPO per
// period per bin (single-print counting, the classic chart reading), NOT one
// per candle - that is what makes long quiet periods read as thin rows.
//
// Pure function, O(n + periods * bins), no look-ahead.

import type { Candle } from '../types'

export interface TpoBin {
  priceLow: number
  priceHigh: number
  mid: number
  /** Number of periods that touched this bin. */
  tpos: number
  /** Period letters that printed here (cycled alphabet, display sugar). */
  letters: string[]
  /** True when this bin is inside the 70% value area. */
  inValueArea: boolean
}

export interface TpoPeriod {
  /** 0-based period index across the window. */
  idx: number
  letter: string
  startTime: number
  endTime: number
  high: number
  low: number
  /** Candles aggregated into this period. */
  candles: number
}

export interface TpoResult {
  periodSec: number
  periodRule: string
  binCount: number
  /** Single-print-per-period counting disclosure. */
  countRule: string
  bins: TpoBin[]
  /** POC bin mid price (null when the window is empty). */
  poc: number | null
  valueAreaHigh: number | null
  valueAreaLow: number | null
  /** Initial Balance: first period's high/low (null when < 1 period). */
  ibHigh: number | null
  ibLow: number | null
  periods: TpoPeriod[]
  totalTpos: number
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function periodLetter(idx: number): string {
  return LETTERS[idx % LETTERS.length]
}

export function computeTpo(
  candles: Candle[],
  opts: { periodSec?: number; binCount?: number } = {}
): TpoResult {
  const empty: TpoResult = {
    periodSec: opts.periodSec ?? 1800,
    periodRule: '',
    binCount: 0,
    countRule: 'single print per period per bin',
    bins: [],
    poc: null,
    valueAreaHigh: null,
    valueAreaLow: null,
    ibHigh: null,
    ibLow: null,
    periods: [],
    totalTpos: 0,
  }
  if (candles.length === 0) return { ...empty, periodRule: 'no candles' }

  const tfSec = Math.max(1, candles[1] ? candles[1].time - candles[0].time : 1)
  const requested = Math.max(60, Math.round(opts.periodSec ?? 1800))
  // when the chart tf is coarser than the requested bracket, each candle
  // becomes one period (a 1h chart cannot build 30min brackets from itself)
  const periodSec = tfSec >= requested ? tfSec : requested
  const periodRule = periodSec === requested ? `fixed ${periodSec}s brackets` : `per-candle (tf ${tfSec}s >= requested ${requested}s)`

  // ---- group candles into periods (by candle OPEN time bracket) ----
  const periods: TpoPeriod[] = []
  for (const c of candles) {
    const pIdx = Math.floor(c.time / periodSec)
    const last = periods[periods.length - 1]
    if (!last || last.idx !== pIdx) {
      periods.push({
        idx: pIdx,
        letter: periodLetter(periods.length),
        startTime: c.time,
        endTime: c.time,
        high: c.high,
        low: c.low,
        candles: 1,
      })
    } else {
      last.high = Math.max(last.high, c.high)
      last.low = Math.min(last.low, c.low)
      last.endTime = c.time
      last.candles++
    }
  }

  // ---- price bins over the whole window ----
  const binCount = Math.max(20, Math.min(200, Math.round(opts.binCount ?? 60)))
  const winLow = Math.min(...periods.map((p) => p.low))
  const winHigh = Math.max(...periods.map((p) => p.high))
  const span = winHigh - winLow
  if (!Number.isFinite(span) || span <= 0) {
    // single-price window: one bin, every period prints on it
    const bins: TpoBin[] = [{
      priceLow: winLow,
      priceHigh: winHigh,
      mid: (winLow + winHigh) / 2,
      tpos: periods.length,
      letters: periods.map((p) => p.letter),
      inValueArea: true,
    }]
    return { ...empty, periodRule, binCount: 1, bins, poc: bins[0].mid, valueAreaHigh: bins[0].priceHigh, valueAreaLow: bins[0].priceLow, ibHigh: periods[0].high, ibLow: periods[0].low, periods, totalTpos: periods.length }
  }
  const bin = span / binCount

  // single print per period per touched bin
  const bins: TpoBin[] = Array.from({ length: binCount }, (_, b) => ({
    priceLow: winLow + b * bin,
    priceHigh: winLow + (b + 1) * bin,
    mid: winLow + (b + 0.5) * bin,
    tpos: 0,
    letters: [],
    inValueArea: false,
  }))

  for (const p of periods) {
    const from = Math.max(0, Math.floor((p.low - winLow) / bin))
    const to = Math.min(binCount - 1, Math.floor((p.high - winLow) / bin))
    for (let b = from; b <= to; b++) {
      bins[b].tpos++
      bins[b].letters.push(p.letter)
    }
  }

  const totalTpos = bins.reduce((s, b) => s + b.tpos, 0)

  // ---- POC (ties resolve toward the window mid price) ----
  const winMid = (winLow + winHigh) / 2
  let pocIdx = 0
  for (let b = 1; b < binCount; b++) {
    if (bins[b].tpos > bins[pocIdx].tpos ||
        (bins[b].tpos === bins[pocIdx].tpos && Math.abs(bins[b].mid - winMid) < Math.abs(bins[pocIdx].mid - winMid))) {
      pocIdx = b
    }
  }

  // ---- value area: classic two-sided expansion from POC to 70% ----
  const target = totalTpos * 0.7
  let va = bins[pocIdx].tpos
  let lo = pocIdx
  let hi = pocIdx
  while (va < target && (lo > 0 || hi < binCount - 1)) {
    const below = lo > 0 ? bins[lo - 1].tpos : -1
    const above = hi < binCount - 1 ? bins[hi + 1].tpos : -1
    if (above > below) {
      hi++
      va += bins[hi].tpos
    } else {
      lo--
      va += bins[lo].tpos
    }
  }
  for (let b = lo; b <= hi; b++) bins[b].inValueArea = true

  return {
    periodSec,
    periodRule,
    binCount,
    countRule: 'single print per period per bin',
    bins,
    poc: bins[pocIdx].mid,
    valueAreaHigh: bins[hi].priceHigh,
    valueAreaLow: bins[lo].priceLow,
    ibHigh: periods[0].high,
    ibLow: periods[0].low,
    periods,
    totalTpos,
  }
}
