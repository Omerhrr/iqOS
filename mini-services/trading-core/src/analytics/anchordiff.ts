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
//   dir, body        candle direction (+1 bullish / -1 bearish, from the REAL price open vs close) and body size in ATR
//   upWick, dnWick   wick sizes in ATR; closePos = where the close sits in the candle's range (0 low .. 1 high)
//   band, dwell      the ATR band (floor(z / bandWidth), default 0.25 ATR) the close is in, and how many bars in a row it has stayed there
//   share, dwellRank how crowded that band is over the last `window` closes (share of closes, and share / the busiest band's share)
//   next[h]          WHAT HAPPENED NEXT after earlier visits to the same band (h = 1, 3, 5 bars): n visits, up = share of visits whose
//                    close h bars later was higher, bull = share of those next candles that closed bullish, move = mean move in ATR.
//                    Only visits whose h-bar outcome had ALREADY closed by this bar are used (no look-ahead; the forming bar never
//                    counts toward its own forecast). `ready` needs at least MIN_VISITS visits, otherwise the numbers are neutral
//                    (up 0.5, move 0) - never a percentage from a handful of cases. `alike` is the same restricted to visits that
//                    ARRIVED the same way (rising into the band or falling into it, judged over 3 bars).
//
//   Volume profile and delta OF THE CURRENT ANCHOR PERIOD (built in, no other chart or namespace needed; resets at every roll, developing bar by bar):
//   poc, vah, val     point of control and the 70% value area, as price; pocZ / vahZ / valZ the same in ATR units from the anchor
//   pocDist, inValue  (close - poc) / atr, and whether the close is inside the value area
//   periodVol, periodBars, volSource   volume since the roll, bars since the roll, and what weights the profile: 'volume' when the candles carry real
//                     volume, 'time' (one unit per bar, i.e. a TPO-style profile) when volume is zero - IQ's OTC candles have none
//   delta, cumDelta, cumDeltaPct, deltaDiv   candle delta = weight x close-location value ((close-low) - (high-close)) / range; cumulative since the roll;
//                     cumDeltaPct = cumDelta / weight; deltaDiv +1 / -1 = bullish / bearish divergence (price at its period low/high close while cumulative delta is not)
//   These come from candles, so they are ESTIMATES of buy/sell pressure and of where trade happened, not tick data. Real tick / footprint reads
//   (tick count, tick-rule delta, tick POC) exist only live, from the tick buffer, as anchor.tick*() in MSL.
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
  /** real close price (not a difference) - outcome moves are measured on this so a roll never fakes a move */
  price: number
  dir: 1 | -1 | 0
  /** |close - open| / atr */
  body: number
  upWick: number
  dnWick: number
  /** (close - low) / (high - low), 0.5 for a zero-range candle */
  closePos: number
  /** ATR band index of the close (floor(z / bandWidth)); NaN until ATR exists */
  band: number
  /** consecutive bars (including this one) whose close stayed in this band */
  dwell: number
  /** share of the last `window` closes that sit in this band (0..1) */
  share: number
  /** share / busiest band's share (0..1): 1 = the most crowded band in the window */
  dwellRank: number
  /** what happened after earlier visits to this band, per horizon */
  next: Record<AnchorHorizon, AnchorNext>
  /** same, restricted to visits that arrived the same way */
  alike: Record<AnchorHorizon, AnchorNext>
  /** how the close arrived at its band: +1 rising, -1 falling, 0 flat (z change over 3 bars vs 0.1 band) */
  approach: 1 | -1 | 0
  /** developing profile of the current anchor period (price levels) */
  poc: number
  vah: number
  val: number
  pocZ: number
  vahZ: number
  valZ: number
  /** (close - poc) / atr */
  pocDist: number
  inValue: boolean
  periodVol: number
  periodBars: number
  volSource: 'volume' | 'time'
  /** candle delta estimate of this bar and its running sum since the roll */
  delta: number
  cumDelta: number
  /** cumDelta / total weight since the roll, -1..1 */
  cumDeltaPct: number
  /** +1 bullish / -1 bearish divergence between price and cumulative delta, else 0 */
  deltaDiv: 1 | -1 | 0
}

export type AnchorHorizon = 1 | 3 | 5
export const ANCHOR_HORIZONS: AnchorHorizon[] = [1, 3, 5]
export const MIN_VISITS = 20

export interface AnchorNext {
  /** settled prior visits used */
  n: number
  /** n >= MIN_VISITS */
  ready: boolean
  /** share of visits whose close h bars later was higher (0.5 when not ready) */
  up: number
  /** share of visits whose candle h bars later closed bullish (0.5 when not ready) */
  bull: number
  /** mean move over h bars in ATR units, signed (0 when not ready) */
  move: number
}

export interface AnchorBand {
  band: number
  /** band edges in ATR units */
  lo: number
  hi: number
  count: number
  bull: number
  bear: number
  /** share of window closes */
  share: number
}

export interface AnchorDiffResult {
  anchorSec: number
  anchorLabel: string
  rocPeriod: number
  bandWidth: number
  window: number
  bars: AnchorBar[]
  /** closes histogram by ATR band over the last `window` bars up to the newest bar, low band first */
  histogram: AnchorBand[]
}

export interface AnchorDiffOptions {
  /** anchor period, e.g. "4h" (default), "1h", "1d", or seconds as a number */
  anchor?: string | number
  atrPeriod?: number
  rocPeriod?: number
  cciPeriod?: number
  mfiPeriod?: number
  rsiPeriod?: number
  /** ATR band width for dwell (default 0.25) */
  bandWidth?: number
  /** rolling window of closes for dwell and outcome stats (default 300) */
  window?: number
  /** compute share / dwellRank / next / alike only for the newest `statsTail` bars (a script reads the last few; the chart wants all of them). Default: all. */
  statsTail?: number
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
  const bandW = opts.bandWidth !== undefined && opts.bandWidth > 0 ? opts.bandWidth : 0.25
  const win = Math.max(20, Math.round(opts.window ?? 300))
  if (!n) return { anchorSec: P, anchorLabel: String(opts.anchor ?? '4h'), rocPeriod: rocP, bandWidth: bandW, window: win, bars: [], histogram: [] }
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
      price: c.close,
      dir: c.close > c.open ? 1 : c.close < c.open ? -1 : 0,
      body: Number.isFinite(atrV) && atrV > 0 ? Math.abs(c.close - c.open) / atrV : Number.NaN,
      upWick: Number.isFinite(atrV) && atrV > 0 ? (c.high - Math.max(c.open, c.close)) / atrV : Number.NaN,
      dnWick: Number.isFinite(atrV) && atrV > 0 ? (Math.min(c.open, c.close) - c.low) / atrV : Number.NaN,
      closePos: c.high > c.low ? (c.close - c.low) / (c.high - c.low) : 0.5,
      band: Number.NaN,
      dwell: 0,
      share: 0,
      dwellRank: 0,
      next: emptyNext(),
      alike: emptyNext(),
      approach: 0,
      poc: Number.NaN, vah: Number.NaN, val: Number.NaN, pocZ: Number.NaN, vahZ: Number.NaN, valZ: Number.NaN, pocDist: Number.NaN, inValue: false,
      periodVol: 0, periodBars: 0, volSource: 'time', delta: 0, cumDelta: 0, cumDeltaPct: 0, deltaDiv: 0,
    })
    idxOf.push(i)
  }
  periodProfile(bars, bandW, candles, idxOf, opts.statsTail !== undefined && opts.statsTail > 0 ? Math.max(1, Math.round(opts.statsTail)) : Infinity)
  const histogram = enrich(bars, bandW, win, opts.statsTail !== undefined && opts.statsTail > 0 ? Math.max(1, Math.round(opts.statsTail)) : Infinity)
  return { anchorSec: P, anchorLabel: typeof opts.anchor === 'string' ? opts.anchor : `${P}s`, rocPeriod: rocP, bandWidth: bandW, window: win, bars, histogram }
}

/** value area of a bin->weight map: start at the POC bin and add the heavier neighbour pair until `share` of the total is covered */
export function valueArea(w: Map<number, number>, share = 0.7): { poc: number; lo: number; hi: number } | null {
  if (!w.size) return null
  let total = 0, poc = 0, best = -1
  for (const [k, v] of w) { total += v; if (v > best || (v === best && k < poc)) { best = v; poc = k } }
  let lo = poc, hi = poc, acc = best
  const g = (k: number) => w.get(k) ?? 0
  let minK = Infinity, maxK = -Infinity
  for (const k of w.keys()) { if (k < minK) minK = k; if (k > maxK) maxK = k }
  while (acc < share * total && (lo > minK || hi < maxK)) {
    const up = hi < maxK ? g(hi + 1) + (hi + 1 < maxK ? g(hi + 2) : 0) : -1
    const dn = lo > minK ? g(lo - 1) + (lo - 1 > minK ? g(lo - 2) : 0) : -1
    if (up >= dn && up >= 0) { acc += g(hi + 1) + (hi + 1 < maxK ? g(hi + 2) : 0); hi = Math.min(maxK, hi + 2) } else if (dn >= 0) { acc += g(lo - 1) + (lo - 1 > minK ? g(lo - 2) : 0); lo = Math.max(minK, lo - 2) } else break
  }
  return { poc, lo, hi }
}

/** developing volume profile + candle delta of the CURRENT anchor period (reset at every roll). Bin = bandWidth x the ATR at the first bar of the period, anchored on the anchor itself. */
function periodProfile(bars: AnchorBar[], bw: number, candles: Candle[], idxOf: number[], tail: number): void {
  const m = bars.length
  const anyVol = bars.some((b) => b.volume > 0)
  let prof = new Map<number, number>()
  let binSize = Number.NaN, wTotal = 0, cum = 0, vol = 0, count = 0, minClose = Infinity, maxClose = -Infinity, minCum = Infinity, maxCum = -Infinity
  for (let i = 0; i < m; i++) {
    const b = bars[i]
    if (b.rolled || i === 0) { prof = new Map(); binSize = Number.NaN; wTotal = 0; cum = 0; vol = 0; count = 0; minClose = Infinity; maxClose = -Infinity; minCum = Infinity; maxCum = -Infinity }
    if (!(binSize > 0)) { if (b.atr > 0) binSize = bw * b.atr }
    count++
    const w = anyVol ? b.volume : 1
    const range = b.high - b.low
    const clv = range > 0 ? ((b.close - b.low) - (b.high - b.close)) / range : 0
    const d = w * clv
    cum += d; wTotal += w; vol += b.volume
    b.delta = d; b.cumDelta = cum; b.cumDeltaPct = wTotal > 0 ? cum / wTotal : 0
    b.periodVol = vol; b.periodBars = count; b.volSource = anyVol ? 'volume' : 'time'
    if (binSize > 0 && w > 0) {
      // spread the weight evenly over the bins the candle spans (anchor-relative bins)
      const k0 = Math.floor(b.low / binSize), k1 = Math.floor(b.high / binSize)
      const n = k1 - k0 + 1
      for (let k = k0; k <= k1; k++) prof.set(k, (prof.get(k) ?? 0) + w / n)
      const va = i >= m - tail ? valueArea(prof) : null // the value area is only needed for the newest bars a script reads; the profile itself is always kept up to date
      if (va) {
        const c = (k: number) => (k + 0.5) * binSize
        b.poc = c(va.poc) + b.anchor; b.vah = (va.hi + 1) * binSize + b.anchor; b.val = va.lo * binSize + b.anchor
        if (b.atr > 0) { b.pocZ = c(va.poc) / b.atr; b.vahZ = (va.hi + 1) * binSize / b.atr; b.valZ = va.lo * binSize / b.atr; b.pocDist = (b.close - c(va.poc)) / b.atr }
        b.inValue = b.close >= va.lo * binSize && b.close <= (va.hi + 1) * binSize
      }
    }
    // divergence: this close is the period's lowest (highest) so far, but cumulative delta is above its low (below its high)
    const early = count >= 6
    b.deltaDiv = early && b.close <= minClose && cum > minCum ? 1 : early && b.close >= maxClose && cum < maxCum ? -1 : 0
    if (b.close < minClose) minClose = b.close
    if (b.close > maxClose) maxClose = b.close
    if (cum < minCum) minCum = cum
    if (cum > maxCum) maxCum = cum
  }
  void candles; void idxOf
}

function emptyNext(): Record<AnchorHorizon, AnchorNext> {
  const z = (): AnchorNext => ({ n: 0, ready: false, up: 0.5, bull: 0.5, move: 0 })
  return { 1: z(), 3: z(), 5: z() }
}

/** dwell (band, run length, crowding) and the no-look-ahead "what happened next" stats; returns the histogram at the newest bar */
function enrich(bars: AnchorBar[], bw: number, win: number, tail: number): AnchorBand[] {
  const m = bars.length
  for (let i = 0; i < m; i++) {
    const b = bars[i]
    b.band = Number.isFinite(b.z) ? Math.floor(b.z / bw) : Number.NaN
    b.dwell = Number.isFinite(b.band) ? (i > 0 && bars[i - 1].band === b.band ? bars[i - 1].dwell + 1 : 1) : 0
    const back = i >= 3 ? bars[i - 3].z : Number.NaN
    b.approach = Number.isFinite(back) && Number.isFinite(b.z) ? (b.z - back > 0.1 * bw ? 1 : b.z - back < -0.1 * bw ? -1 : 0) : 0
  }
  const statsFrom = Number.isFinite(tail) ? Math.max(0, m - tail) : 0
  for (let i = statsFrom; i < m; i++) {
    const b = bars[i]
    if (!Number.isFinite(b.band)) continue
    const from = Math.max(0, i - win + 1)
    const counts = new Map<number, number>()
    let tot = 0
    for (let j = from; j <= i; j++) {
      const k = bars[j].band
      if (!Number.isFinite(k)) continue
      counts.set(k, (counts.get(k) ?? 0) + 1)
      tot++
    }
    const mine = counts.get(b.band) ?? 0
    let max = 0
    for (const v of counts.values()) if (v > max) max = v
    b.share = tot ? mine / tot : 0
    b.dwellRank = max ? mine / max : 0
    for (const h of ANCHOR_HORIZONS) {
      let n = 0, up = 0, bull = 0, mv = 0, na = 0, upA = 0, bullA = 0, mvA = 0
      // a visit j counts only if its h-bar outcome had already closed by bar i (j + h <= i)
      for (let j = from; j + h <= i; j++) {
        const v = bars[j]
        if (v.band !== b.band || !(v.atr > 0)) continue
        const fut = bars[j + h]
        const move = fut.price - v.price
        const isUp = move > 0 ? 1 : 0
        const isBull = fut.dir > 0 ? 1 : 0
        n++; up += isUp; bull += isBull; mv += move / v.atr
        if (v.approach === b.approach) { na++; upA += isUp; bullA += isBull; mvA += move / v.atr }
      }
      const fill = (cnt: number, u: number, bl: number, mvs: number): AnchorNext => cnt >= MIN_VISITS ? { n: cnt, ready: true, up: u / cnt, bull: bl / cnt, move: mvs / cnt } : { n: cnt, ready: false, up: 0.5, bull: 0.5, move: 0 }
      b.next[h] = fill(n, up, bull, mv)
      b.alike[h] = fill(na, upA, bullA, mvA)
    }
  }
  if (!m) return []
  const last = bars[m - 1]
  const from = Math.max(0, m - win)
  const agg = new Map<number, { count: number; bull: number; bear: number }>()
  let tot = 0
  for (let j = from; j < m; j++) {
    const k = bars[j].band
    if (!Number.isFinite(k)) continue
    const e = agg.get(k) ?? { count: 0, bull: 0, bear: 0 }
    e.count++
    if (bars[j].dir > 0) e.bull++
    else if (bars[j].dir < 0) e.bear++
    agg.set(k, e)
    tot++
  }
  void last
  return [...agg.entries()].sort((a, b) => a[0] - b[0]).map(([band, e]) => ({ band, lo: band * bw, hi: (band + 1) * bw, count: e.count, bull: e.bull, bear: e.bear, share: tot ? e.count / tot : 0 }))
}
