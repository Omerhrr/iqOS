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
  /** DEVELOPING POC/VAH/VAL (claude/msl-capability-matrix.md section O,
   * flagged "missing" since the Phase 0 audit) - one entry PER PERIOD,
   * recomputed using only the TPOs printed by periods[0..k] (never a
   * look-ahead into later periods) - the classic "where is the profile
   * balancing RIGHT NOW, mid-session" read, as opposed to `poc`/
   * `valueAreaHigh`/`valueAreaLow` above which are the FINAL, whole-window
   * values. Entries are null only before any TPO has printed at all
   * (never reached in practice - period 0 always prints at least one). */
  developingPoc: (number | null)[]
  developingVah: (number | null)[]
  developingVal: (number | null)[]
  /** SINGLE PRINTS (claude/msl-capability-matrix.md section O, flagged
   * "missing" since Phase 0): bins touched by exactly ONE period - the
   * classic "thin row" a profile reader scans for. Bin indices into
   * `bins` above, ascending by price. */
  singlePrintBins: number[]
  /** POOR HIGH / POOR LOW vs. EXCESS HIGH / EXCESS LOW (claude/msl-
   * capability-matrix.md section O, flagged "missing" since Phase 0):
   * classic market-profile shape read at the session's price EXTREMES.
   *   - excessHigh/excessLow: the highest/lowest TOUCHED bin was printed
   *     by exactly one period - a clean single-print "tail" at the
   *     extreme (rejection/exhaustion: price tried that level once and
   *     moved away).
   *   - poorHigh/poorLow: the highest/lowest touched bin was printed by
   *     TWO OR MORE periods - a flat, built-up extreme with no tail
   *     (failure to show excess - the classic "expect a retest" read).
   *   poorHigh === !excessHigh and poorLow === !excessLow by construction
   *   (every touched extreme bin is exactly one or the other); both false
   *   together only on an empty window. */
  excessHigh: boolean
  excessLow: boolean
  poorHigh: boolean
  poorLow: boolean
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
    developingPoc: [],
    developingVah: [],
    developingVal: [],
    singlePrintBins: [],
    excessHigh: false,
    excessLow: false,
    poorHigh: false,
    poorLow: false,
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
    return {
      ...empty,
      periodRule,
      binCount: 1,
      bins,
      poc: bins[0].mid,
      valueAreaHigh: bins[0].priceHigh,
      valueAreaLow: bins[0].priceLow,
      ibHigh: periods[0].high,
      ibLow: periods[0].low,
      periods,
      totalTpos: periods.length,
      // single-price window: every period stacks on the one bin, so the
      // developing values never move, there's no "single print" (every
      // period touches it), and the extreme is maximally "poor" (never
      // excess) as soon as 2+ periods have printed.
      developingPoc: periods.map(() => bins[0].mid),
      developingVah: periods.map(() => bins[0].priceHigh),
      developingVal: periods.map(() => bins[0].priceLow),
      singlePrintBins: periods.length === 1 ? [0] : [],
      excessHigh: periods.length === 1,
      excessLow: periods.length === 1,
      poorHigh: periods.length >= 2,
      poorLow: periods.length >= 2,
    }
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

  const winMid = (winLow + winHigh) / 2

  // Shared POC + value-area reduction over any tpos snapshot (used for both
  // the final whole-window result and, below, each developing/running
  // snapshot - same ties-toward-mid / two-sided-expansion rules either way).
  const pocAndVa = (tpos: number[]): { pocIdx: number; lo: number; hi: number } => {
    let pocIdx = 0
    for (let b = 1; b < binCount; b++) {
      if (tpos[b] > tpos[pocIdx] ||
          (tpos[b] === tpos[pocIdx] && Math.abs(bins[b].mid - winMid) < Math.abs(bins[pocIdx].mid - winMid))) {
        pocIdx = b
      }
    }
    const total = tpos.reduce((s, v) => s + v, 0)
    const target = total * 0.7
    let va = tpos[pocIdx]
    let lo = pocIdx
    let hi = pocIdx
    while (va < target && (lo > 0 || hi < binCount - 1)) {
      const below = lo > 0 ? tpos[lo - 1] : -1
      const above = hi < binCount - 1 ? tpos[hi + 1] : -1
      if (above > below) {
        hi++
        va += tpos[hi]
      } else {
        lo--
        va += tpos[lo]
      }
    }
    return { pocIdx, lo, hi }
  }

  // ---- running (developing) snapshot, one period at a time ----
  const runningTpos = new Array(binCount).fill(0)
  const developingPoc: (number | null)[] = []
  const developingVah: (number | null)[] = []
  const developingVal: (number | null)[] = []
  for (const p of periods) {
    const from = Math.max(0, Math.floor((p.low - winLow) / bin))
    const to = Math.min(binCount - 1, Math.floor((p.high - winLow) / bin))
    for (let b = from; b <= to; b++) {
      runningTpos[b]++
      bins[b].letters.push(p.letter)
    }
    if (runningTpos.some((v) => v > 0)) {
      const { pocIdx, lo, hi } = pocAndVa(runningTpos)
      developingPoc.push(bins[pocIdx].mid)
      developingVah.push(bins[hi].priceHigh)
      developingVal.push(bins[lo].priceLow)
    } else {
      developingPoc.push(null)
      developingVah.push(null)
      developingVal.push(null)
    }
  }
  // runningTpos now holds the FINAL whole-window counts
  for (let b = 0; b < binCount; b++) bins[b].tpos = runningTpos[b]

  const totalTpos = bins.reduce((s, b) => s + b.tpos, 0)
  const { pocIdx, lo, hi } = pocAndVa(runningTpos)
  for (let b = lo; b <= hi; b++) bins[b].inValueArea = true

  // ---- single prints: bins touched by exactly one period ----
  const singlePrintBins: number[] = []
  for (let b = 0; b < binCount; b++) if (bins[b].tpos === 1) singlePrintBins.push(b)

  // ---- poor/excess at the session extremes (highest/lowest TOUCHED bin) ----
  let topTouched = -1
  let bottomTouched = -1
  for (let b = binCount - 1; b >= 0; b--) if (bins[b].tpos > 0) { topTouched = b; break }
  for (let b = 0; b < binCount; b++) if (bins[b].tpos > 0) { bottomTouched = b; break }
  const excessHigh = topTouched >= 0 && bins[topTouched].tpos === 1
  const excessLow = bottomTouched >= 0 && bins[bottomTouched].tpos === 1
  const poorHigh = topTouched >= 0 && bins[topTouched].tpos >= 2
  const poorLow = bottomTouched >= 0 && bins[bottomTouched].tpos >= 2

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
    developingPoc,
    developingVah,
    developingVal,
    singlePrintBins,
    excessHigh,
    excessLow,
    poorHigh,
    poorLow,
  }
}
