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
//   Support / resistance, period levels and supply / demand zones (built in too; candle-derived, no look-ahead, all anchored to the same ATR units):
//   support, resistance          the nearest swing-pivot level below / above the close (pivots are confirmed `pivotLen` bars after they form; pivots within
//                                0.25 ATR merge into one level and count as touches); supportDist / resistanceDist in ATR from the close, supportZ / resistanceZ in ATR from the anchor
//   supportTouches, resistanceTouches   how many pivots built that level
//   pHigh, pLow, prevHigh, prevLow      this anchor period's high / low so far, and the previous completed period's (+ ...Z in ATR from the anchor)
//   demand*, supply*                    the nearest supply / demand zone: a small BASE (candles of range <= 0.8 ATR) followed within 3 bars by an IMPULSE of
//                                       >= impulseAtr (default 1.5 ATR) in one direction; the zone is the base's high-low and exists from the bar the impulse is
//                                       confirmed. It dies when a close goes through it. top / bottom (price), fresh (never revisited), tests (revisits), age,
//                                       strength (impulse size in ATR), dist (ATR from the close, 0 when inside); inDemand / inSupply (close inside); tapDemand / tapSupply (this bar's range touched it)
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
// CLIENT COPY of mini-services/trading-core/src/analytics/anchordiff.ts - keep the two in sync (a parity test enforces it).
//
// Pure function, no I/O, no look-ahead: bar i only sees bars <= i and an anchor
// that was closed before bar i opened.

/** structural candle - the app's Candle type satisfies it */
export interface AnchorCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}
type Candle = AnchorCandle

// ---- indicator math copied verbatim from mini-services/trading-core/src/analytics/indicators.ts
// (the browser cannot import the kernel module). tests/anchordiff.test.ts checks both give identical output. ----
function sma(src: number[], period: number): number[] {
  const out = new Array<number>(src.length).fill(NaN)
  let sum = 0
  for (let i = 0; i < src.length; i++) {
    sum += src[i]
    if (i >= period) sum -= src[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

function rsiFn(src: number[], period = 14): number[] {
  const out = new Array<number>(src.length).fill(NaN)
  let avgGain = 0
  let avgLoss = 0
  // AUDIT FIX (Task 58, P2): a perfectly flat series (avgGain = avgLoss = 0)
  // read RSI 100 - "maximally overbought" from zero information - and
  // rsi-reversion fired a max-score PUT on dead tape (OTC lattice feeds have
  // long flat stretches). Zero information is the neutral 50.
  const rsiOf = (g: number, l: number) => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l))
  for (let i = 1; i < src.length; i++) {
    const diff = src[i] - src[i - 1]
    const gain = Math.max(diff, 0)
    const loss = Math.max(-diff, 0)
    if (i <= period) {
      avgGain += gain / period
      avgLoss += loss / period
      if (i === period) out[i] = rsiOf(avgGain, avgLoss)
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
      out[i] = rsiOf(avgGain, avgLoss)
    }
  }
  return out
}

function cciFn(high: number[], low: number[], close: number[], period = 20): number[] {
  const tp = close.map((c, i) => (high[i] + low[i] + c) / 3)
  const ma = sma(tp, period)
  const out = new Array<number>(close.length).fill(NaN)
  for (let i = period - 1; i < close.length; i++) {
    let dev = 0
    for (let j = 0; j < period; j++) dev += Math.abs(tp[i - j] - ma[i])
    dev /= period
    out[i] = dev === 0 ? 0 : (tp[i] - ma[i]) / (0.015 * dev)
  }
  return out
}

function trueRange(high: number[], low: number[], close: number[]): number[] {
  const out = new Array<number>(close.length).fill(NaN)
  out[0] = high[0] - low[0]
  for (let i = 1; i < close.length; i++) {
    out[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]))
  }
  return out
}

function atrFn(high: number[], low: number[], close: number[], period = 14): number[] {
  const tr = trueRange(high, low, close)
  const out = new Array<number>(close.length).fill(NaN)
  let acc = 0
  for (let i = 0; i < close.length; i++) {
    if (i < period) {
      acc += tr[i]
      if (i === period - 1) out[i] = acc / period
    } else {
      out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    }
  }
  return out
}

function mfiFn(high: number[], low: number[], close: number[], volume: number[], period = 14): number[] {
  const tp = close.map((c, i) => (high[i] + low[i] + c) / 3)
  const out = new Array<number>(close.length).fill(NaN)
  for (let i = period; i < close.length; i++) {
    let pos = 0
    let neg = 0
    for (let j = 0; j < period; j++) {
      const flow = tp[i - j] * volume[i - j]
      if (tp[i - j] > tp[i - j - 1]) pos += flow
      else if (tp[i - j] < tp[i - j - 1]) neg += flow
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg)
  }
  return out
}


/** ADX / DI, market structure, candle patterns and trader-psychology reads carried by every anchor bar (all computed from bars <= this one).
 *  Signed signals: +1 bullish / -1 bearish (0 = none). */
export interface PatternFields {
  adx: number
  plusDI: number
  minusDI: number
  /** +1 DI+ crossed above DI- this bar, -1 the reverse */
  diCross: number
  /** market structure from confirmed swings: +1 higher highs and higher lows, -1 lower both, 0 mixed / unknown */
  trend: number
  swingHigh: number
  swingLow: number
  /** ATR distance from the close up to the last swing high / down to the last swing low */
  swingHighDist: number
  swingLowDist: number
  /** +1 close broke the last swing high with the trend (continuation), -1 broke the last swing low with the trend */
  bos: number
  /** +1 close broke the last swing high AGAINST a down-trend (change of character), -1 the reverse */
  choch: number
  /** -1 wicked above the last swing high but closed back under it (buy-side liquidity taken), +1 the mirror below the swing low */
  sweep: number
  /** 1 when the last two swing highs / lows sit within 0.15 ATR of each other (equal highs / lows: resting liquidity) */
  eqHigh: number
  eqLow: number
  engulf: number
  pin: number
  inside: number
  outside: number
  doji: number
  soldiers: number
  star: number
  marubozu: number
  /** direction of the REVERSAL expected: -1 when the gap is stretched up (>= 2 ATR) and the bar printed an upper rejection wick, +1 the mirror */
  exhaust: number
  /** price range touched the anchor and the close held the side the previous bar closed on (+1 above = anchor held as support, -1 below = resistance) */
  reject: number
  /** 1 when the bar's range crossed the anchor */
  anchorTouch: number
  /** failed breakout of this period's high / low: -1 high broken then close back under it (bull trap), +1 low broken then reclaimed (bear trap) */
  trap: number
  /** body >= 1.8 ATR: +1 / -1 the direction of the blow-off candle */
  climax: number
  /** signed run of same-direction candles (+3 = three bullish in a row) */
  streak: number
  /** Kaufman efficiency ratio over 10 bars: 1 = one-way conviction, 0 = chop */
  er: number
  // ---- extended candle patterns (+1 bullish / -1 bearish): harami, tweezer tops/bottoms, three inside up/down, piercing line / dark cloud, hammer (+1, after a fall) / hanging man (-1, after a rise),
  //      inverted hammer (+1) / shooting star (-1), belt-hold, three-line strike, kicker
  // ---- extended structure: fvg (+1/-1 on the bar a fair value gap forms), fvgTap, inFvg, nearest open bull gap below / bear gap above the close, order blocks (last opposite candle before a BOS/CHoCH),
  //      premium/discount of the swing range (pdPos 0..1, pdZone -1 premium / +1 discount, ote), range (inRange, rangeHigh/Low, rangeBreak, retest of the break), double top/bottom, head and shoulders,
  //      trendlines (tlSupport / tlResist price now, tlBreak), wedge, channel
  // ---- extended psychology: capitulation (+1 selling climax / -1 buying climax = expected reversal), fomo (crowd chasing), gapFill (share of the opening gap closed) / gapFilled, stopHunt
  // ---- market state: volRatio (ATR vs its 50-bar average), squeeze, expansion (+1/-1 out of a squeeze), hour (UTC), session (1 Asia 2 London 3 New York 0 off), regime (2 squeeze, 1 trending, -1 chop, 0 normal)
  harami: number
  tweezer: number
  threeInside: number
  piercing: number
  hammer: number
  invHammer: number
  beltHold: number
  threeStrike: number
  kicker: number
  fvg: number
  fvgTap: number
  inFvg: number
  obTap: number
  inOb: number
  pdZone: number
  ote: number
  inRange: number
  rangeBreak: number
  retest: number
  double: number
  hs: number
  tlBreak: number
  wedge: number
  channel: number
  capitulation: number
  fomo: number
  gapFilled: number
  stopHunt: number
  squeeze: number
  expansion: number
  hour: number
  session: number
  regime: number
  fvgBullTop: number
  fvgBullBottom: number
  fvgBearTop: number
  fvgBearBottom: number
  obBullTop: number
  obBullBottom: number
  obBearTop: number
  obBearBottom: number
  pdPos: number
  rangeHigh: number
  rangeLow: number
  tlSupport: number
  tlResist: number
  gapFill: number
  volRatio: number
  /** what happened after earlier bars carrying the same signal value (only for signals active on this bar; newest statsTail bars only) */
  sigNext: Record<string, Record<AnchorHorizon, AnchorNext>>
}

export interface AnchorBar extends PatternFields {
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
  support: number
  resistance: number
  supportDist: number
  resistanceDist: number
  supportZ: number
  resistanceZ: number
  supportTouches: number
  resistanceTouches: number
  pHigh: number
  pLow: number
  prevHigh: number
  prevLow: number
  pHighZ: number
  pLowZ: number
  prevHighZ: number
  prevLowZ: number
  demandTop: number
  demandBottom: number
  demandFresh: boolean
  demandTests: number
  demandAge: number
  demandStrength: number
  demandDist: number
  inDemand: boolean
  tapDemand: boolean
  supplyTop: number
  supplyBottom: number
  supplyFresh: boolean
  supplyTests: number
  supplyAge: number
  supplyStrength: number
  supplyDist: number
  inSupply: boolean
  tapSupply: boolean
  /** live zone counts at this bar */
  demandCount: number
  supplyCount: number
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
  /** bars each side for a swing pivot (default 3) */
  pivotLen?: number
  /** ADX / DI period (default 14) */
  adxPeriod?: number
  /** impulse size, in ATR, that turns a base into a supply / demand zone (default 1.5) */
  impulseAtr?: number
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
      ...emptyLevels(),
      ...emptyPatterns(),
    })
    idxOf.push(i)
  }
  const tailN = opts.statsTail !== undefined && opts.statsTail > 0 ? Math.max(1, Math.round(opts.statsTail)) : Infinity
  periodProfile(bars, bandW, candles, idxOf, tailN)
  levelsAndZones(bars, candles, idxOf, bandW, win, Math.max(1, Math.round(opts.pivotLen ?? 3)), opts.impulseAtr !== undefined && opts.impulseAtr > 0 ? opts.impulseAtr : 1.5, tailN)
  patternsAndStructure(bars, candles, idxOf, Math.max(1, Math.round(opts.pivotLen ?? 3)), Math.max(2, Math.round(opts.adxPeriod ?? 14)), win, tailN)
  extraSignals(bars, candles, idxOf, Math.max(1, Math.round(opts.pivotLen ?? 3)), win)
  signalStats(bars, win, tailN)
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

type LevelFields = Pick<AnchorBar, 'support' | 'resistance' | 'supportDist' | 'resistanceDist' | 'supportZ' | 'resistanceZ' | 'supportTouches' | 'resistanceTouches' | 'pHigh' | 'pLow' | 'prevHigh' | 'prevLow' | 'pHighZ' | 'pLowZ' | 'prevHighZ' | 'prevLowZ' | 'demandTop' | 'demandBottom' | 'demandFresh' | 'demandTests' | 'demandAge' | 'demandStrength' | 'demandDist' | 'inDemand' | 'tapDemand' | 'supplyTop' | 'supplyBottom' | 'supplyFresh' | 'supplyTests' | 'supplyAge' | 'supplyStrength' | 'supplyDist' | 'inSupply' | 'tapSupply' | 'demandCount' | 'supplyCount'>
function emptyLevels(): LevelFields {
  const N = Number.NaN
  return {
    support: N, resistance: N, supportDist: N, resistanceDist: N, supportZ: N, resistanceZ: N, supportTouches: 0, resistanceTouches: 0,
    pHigh: N, pLow: N, prevHigh: N, prevLow: N, pHighZ: N, pLowZ: N, prevHighZ: N, prevLowZ: N,
    demandTop: N, demandBottom: N, demandFresh: false, demandTests: 0, demandAge: 0, demandStrength: 0, demandDist: N, inDemand: false, tapDemand: false,
    supplyTop: N, supplyBottom: N, supplyFresh: false, supplyTests: 0, supplyAge: 0, supplyStrength: 0, supplyDist: N, inSupply: false, tapSupply: false,
    demandCount: 0, supplyCount: 0,
  }
}

interface SrLevel { price: number; touches: number; last: number }
interface SdZone { kind: 1 | -1; top: number; bottom: number; created: number; baseIdx: number; tests: number; strength: number; inside: boolean }

/** support / resistance levels from confirmed swing pivots, this + previous period high / low, and base-then-impulse supply / demand zones. Everything is decided from bars <= i. */
function levelsAndZones(bars: AnchorBar[], candles: Candle[], idxOf: number[], bw: number, win: number, L: number, impulseAtr: number, tail: number): void {
  const m = bars.length
  const H = idxOf.map((k) => candles[k].high), Lo = idxOf.map((k) => candles[k].low), O = idxOf.map((k) => candles[k].open), C = idxOf.map((k) => candles[k].close)
  const levels: SrLevel[] = []
  let zones: SdZone[] = []
  let pHigh = Number.NaN, pLow = Number.NaN, prevHigh = Number.NaN, prevLow = Number.NaN
  const BASE_RANGE = 0.8
  for (let i = 0; i < m; i++) {
    const b = bars[i]
    const atr = b.atr
    // ---- this / previous anchor period high-low
    if (b.rolled || i === 0) { if (Number.isFinite(pHigh)) { prevHigh = pHigh; prevLow = pLow } pHigh = H[i]; pLow = Lo[i] } else { if (H[i] > pHigh) pHigh = H[i]; if (Lo[i] < pLow) pLow = Lo[i] }
    // ---- swing pivots: bar j = i - L is a pivot once L later bars have printed
    const j = i - L
    if (j >= L && atr > 0) {
      let isH = true, isL = true
      for (let k = 1; k <= L; k++) {
        if (!(H[j] > H[j - k]) || !(H[j] >= H[j + k])) isH = false
        if (!(Lo[j] < Lo[j - k]) || !(Lo[j] <= Lo[j + k])) isL = false
      }
      for (const [ok, px] of [[isH, H[j]], [isL, Lo[j]]] as [boolean, number][]) {
        if (!ok) continue
        const tol = bw * atr
        let near: SrLevel | undefined
        for (const lv of levels) if (Math.abs(lv.price - px) <= tol && (!near || Math.abs(lv.price - px) < Math.abs(near.price - px))) near = lv
        if (near) { near.price = (near.price * near.touches + px) / (near.touches + 1); near.touches++; near.last = i } else levels.push({ price: px, touches: 1, last: i })
      }
      // forget stale levels, keep the list small
      for (let k = levels.length - 1; k >= 0; k--) if (i - levels[k].last > win) levels.splice(k, 1)
      if (levels.length > 40) { levels.sort((a, c) => c.last - a.last); levels.length = 40 }
    }
    // ---- supply / demand: base then impulse, confirmed at the impulse's last bar i
    if (atr > 0 && i >= 3) {
      for (const dir of [1, -1] as const) {
        for (let s = i; s >= Math.max(1, i - 2); s--) {
          // every bar s..i must close in the impulse direction
          let same = true
          for (let q = s; q <= i; q++) if ((C[q] - O[q]) * dir <= 0) { same = false; break }
          if (!same) break
          if ((C[i] - O[s]) * dir < impulseAtr * atr) continue
          // base: the 1-2 small candles right before the leg
          let b0 = s - 1
          if (b0 < 0 || H[b0] - Lo[b0] > BASE_RANGE * atr) continue
          if (b0 - 1 >= 0 && H[b0 - 1] - Lo[b0 - 1] <= BASE_RANGE * atr && (C[b0 - 1] - O[b0 - 1]) * dir <= 0 + 0) b0 = b0 - 1
          let top = -Infinity, bot = Infinity
          for (let q = b0; q <= s - 1; q++) { if (H[q] > top) top = H[q]; if (Lo[q] < bot) bot = Lo[q] }
          if (top - bot > 1.5 * atr) continue
          const baseIdx = s - 1
          if (zones.some((z) => z.baseIdx === baseIdx && z.kind === dir)) continue
          // an impulse that already ran through the zone's far side is not a clean origin
          zones.push({ kind: dir, top, bottom: bot, created: i, baseIdx, tests: 0, strength: (C[i] - O[s]) * dir / atr, inside: false })
          break
        }
      }
    }
    // ---- zone upkeep (bars after creation only): tests and breaks
    for (const z of zones) {
      if (i <= z.created) continue
      const overlap = Lo[i] <= z.top && H[i] >= z.bottom
      if (overlap && !z.inside) z.tests++
      z.inside = overlap
    }
    zones = zones.filter((z) => i <= z.created || (z.kind === 1 ? C[i] >= z.bottom : C[i] <= z.top)).filter((z) => i - z.created <= win)
    if (zones.length > 20) { zones.sort((a, c) => c.created - a.created); zones.length = 20 }
    // ---- outputs
    b.pHigh = pHigh; b.pLow = pLow; b.prevHigh = prevHigh; b.prevLow = prevLow
    if (atr > 0) { b.pHighZ = (pHigh - b.anchor) / atr; b.pLowZ = (pLow - b.anchor) / atr; b.prevHighZ = (prevHigh - b.anchor) / atr; b.prevLowZ = (prevLow - b.anchor) / atr }
    b.demandCount = zones.filter((z) => z.kind === 1).length
    b.supplyCount = zones.length - b.demandCount
    if (i < m - tail || !(atr > 0)) continue
    const close = C[i]
    let sup: SrLevel | undefined, res: SrLevel | undefined
    for (const lv of levels) {
      if (lv.price <= close && (!sup || lv.price > sup.price)) sup = lv
      if (lv.price > close && (!res || lv.price < res.price)) res = lv
    }
    if (sup) { b.support = sup.price; b.supportDist = (close - sup.price) / atr; b.supportZ = (sup.price - b.anchor) / atr; b.supportTouches = sup.touches }
    if (res) { b.resistance = res.price; b.resistanceDist = (res.price - close) / atr; b.resistanceZ = (res.price - b.anchor) / atr; b.resistanceTouches = res.touches }
    let dz: SdZone | undefined, sz: SdZone | undefined
    for (const z of zones) {
      if (z.kind === 1 && z.bottom <= close && (!dz || z.top > dz.top)) dz = z
      if (z.kind === -1 && z.top >= close && (!sz || z.bottom < sz.bottom)) sz = z
    }
    if (dz) { b.demandTop = dz.top; b.demandBottom = dz.bottom; b.demandFresh = dz.tests === 0; b.demandTests = dz.tests; b.demandAge = i - dz.created; b.demandStrength = dz.strength; b.demandDist = Math.max(0, close - dz.top) / atr; b.inDemand = close <= dz.top; b.tapDemand = i > dz.created && Lo[i] <= dz.top }
    if (sz) { b.supplyTop = sz.top; b.supplyBottom = sz.bottom; b.supplyFresh = sz.tests === 0; b.supplyTests = sz.tests; b.supplyAge = i - sz.created; b.supplyStrength = sz.strength; b.supplyDist = Math.max(0, sz.bottom - close) / atr; b.inSupply = close >= sz.bottom; b.tapSupply = i > sz.created && H[i] >= sz.bottom }
  }
}

export const ANCHOR_SIGNALS = ['harami', 'tweezer', 'threeInside', 'piercing', 'hammer', 'invHammer', 'beltHold', 'threeStrike', 'kicker', 'fvg', 'fvgTap', 'obTap', 'rangeBreak', 'retest', 'double', 'hs', 'tlBreak', 'capitulation', 'fomo', 'stopHunt', 'expansion', 'diCross', 'bos', 'choch', 'sweep', 'engulf', 'pin', 'inside', 'outside', 'doji', 'soldiers', 'star', 'marubozu', 'exhaust', 'reject', 'trap', 'climax', 'eqHigh', 'eqLow'] as const

function emptyPatterns(): PatternFields {
  const N = Number.NaN
  return {
    adx: N, plusDI: N, minusDI: N, diCross: 0, trend: 0, swingHigh: N, swingLow: N, swingHighDist: N, swingLowDist: N, bos: 0, choch: 0, sweep: 0, eqHigh: 0, eqLow: 0,
    engulf: 0, pin: 0, inside: 0, outside: 0, doji: 0, soldiers: 0, star: 0, marubozu: 0, exhaust: 0, reject: 0, anchorTouch: 0, trap: 0, climax: 0, streak: 0, er: N, sigNext: {},
    harami: 0, tweezer: 0, threeInside: 0, piercing: 0, hammer: 0, invHammer: 0, beltHold: 0, threeStrike: 0, kicker: 0, fvg: 0, fvgTap: 0, inFvg: 0, obTap: 0, inOb: 0, pdZone: 0, ote: 0, inRange: 0, rangeBreak: 0, retest: 0, double: 0, hs: 0, tlBreak: 0, wedge: 0, channel: 0, capitulation: 0, fomo: 0, gapFilled: 0, stopHunt: 0, squeeze: 0, expansion: 0, hour: 0, session: 0, regime: 0, fvgBullTop: N, fvgBullBottom: N, fvgBearTop: N, fvgBearBottom: N, obBullTop: N, obBullBottom: N, obBearTop: N, obBearBottom: N, pdPos: N, rangeHigh: N, rangeLow: N, tlSupport: N, tlResist: N, gapFill: N, volRatio: N,
  }
}

/** Wilder ADX / +DI / -DI over the candle series (arrays aligned with `candles`) */
function wilderAdx(candles: Candle[], P: number): { adx: number[]; pdi: number[]; mdi: number[] } {
  const n = candles.length
  const adx = new Array<number>(n).fill(Number.NaN), pdi = adx.slice(), mdi = adx.slice()
  if (n <= P * 2) return { adx, pdi, mdi }
  let trS = 0, pS = 0, mS = 0
  const dx: number[] = new Array(n).fill(Number.NaN)
  for (let i = 1; i < n; i++) {
    const c = candles[i], q = candles[i - 1]
    const tr = Math.max(c.high - c.low, Math.abs(c.high - q.close), Math.abs(c.low - q.close))
    const up = c.high - q.high, dn = q.low - c.low
    const pd = up > dn && up > 0 ? up : 0, md = dn > up && dn > 0 ? dn : 0
    if (i <= P) { trS += tr; pS += pd; mS += md } else { trS = trS - trS / P + tr; pS = pS - pS / P + pd; mS = mS - mS / P + md }
    if (i >= P && trS > 0) {
      pdi[i] = (100 * pS) / trS; mdi[i] = (100 * mS) / trS
      const sum = pdi[i] + mdi[i]
      dx[i] = sum > 0 ? (100 * Math.abs(pdi[i] - mdi[i])) / sum : 0
    }
  }
  let acc = 0
  for (let i = P; i < 2 * P; i++) acc += dx[i]
  adx[2 * P - 1] = acc / P
  for (let i = 2 * P; i < n; i++) adx[i] = (adx[i - 1] * (P - 1) + dx[i]) / P
  return { adx, pdi, mdi }
}

function patternsAndStructure(bars: AnchorBar[], candles: Candle[], idxOf: number[], L: number, adxP: number, win: number, tail: number): void {
  const m = bars.length
  const O = idxOf.map((k) => candles[k].open), H = idxOf.map((k) => candles[k].high), Lo = idxOf.map((k) => candles[k].low), C = idxOf.map((k) => candles[k].close)
  const A = wilderAdx(candles, adxP)
  let lastSH = Number.NaN, prevSH = Number.NaN, lastSL = Number.NaN, prevSL = Number.NaN
  let shBroken = false, slBroken = false, trend = 0, eqH = 0, eqL = 0
  for (let i = 0; i < m; i++) {
    const b = bars[i]
    const atr = b.atr
    const k = idxOf[i]
    b.adx = A.adx[k]; b.plusDI = A.pdi[k]; b.minusDI = A.mdi[k]
    if (k > 0 && Number.isFinite(A.pdi[k]) && Number.isFinite(A.pdi[k - 1])) {
      const was = A.pdi[k - 1] - A.mdi[k - 1], now = A.pdi[k] - A.mdi[k]
      b.diCross = was <= 0 && now > 0 ? 1 : was >= 0 && now < 0 ? -1 : 0
    }
    // ---- structure: swing j = i - L confirmed now
    const j = i - L
    if (j >= L && atr > 0) {
      let isH = true, isL = true
      for (let q = 1; q <= L; q++) {
        if (!(H[j] > H[j - q]) || !(H[j] >= H[j + q])) isH = false
        if (!(Lo[j] < Lo[j - q]) || !(Lo[j] <= Lo[j + q])) isL = false
      }
      if (isH) { prevSH = lastSH; lastSH = H[j]; shBroken = false; eqH = Number.isFinite(prevSH) && Math.abs(lastSH - prevSH) <= 0.15 * atr ? 1 : 0 }
      if (isL) { prevSL = lastSL; lastSL = Lo[j]; slBroken = false; eqL = Number.isFinite(prevSL) && Math.abs(lastSL - prevSL) <= 0.15 * atr ? 1 : 0 }
      if (Number.isFinite(prevSH) && Number.isFinite(prevSL)) trend = lastSH > prevSH && lastSL > prevSL ? 1 : lastSH < prevSH && lastSL < prevSL ? -1 : 0
    }
    b.trend = trend; b.eqHigh = eqH; b.eqLow = eqL
    b.swingHigh = lastSH; b.swingLow = lastSL
    if (atr > 0) { b.swingHighDist = Number.isFinite(lastSH) ? (lastSH - C[i]) / atr : Number.NaN; b.swingLowDist = Number.isFinite(lastSL) ? (C[i] - lastSL) / atr : Number.NaN }
    if (Number.isFinite(lastSH) && !shBroken && C[i] > lastSH) { shBroken = true; if (trend >= 0) b.bos = 1; else b.choch = 1 }
    else if (Number.isFinite(lastSH) && !shBroken && H[i] > lastSH && C[i] <= lastSH) b.sweep = -1
    if (Number.isFinite(lastSL) && !slBroken && C[i] < lastSL) { slBroken = true; if (trend <= 0) b.bos = -1; else b.choch = -1 }
    else if (Number.isFinite(lastSL) && !slBroken && Lo[i] < lastSL && C[i] >= lastSL) b.sweep = 1
    // ---- candle patterns (price candles; a constant anchor shift changes none of them)
    const body = Math.abs(C[i] - O[i]), rng = H[i] - Lo[i], dir = C[i] > O[i] ? 1 : C[i] < O[i] ? -1 : 0
    const up = H[i] - Math.max(O[i], C[i]), dn = Math.min(O[i], C[i]) - Lo[i]
    if (i >= 1) {
      const pb = Math.abs(C[i - 1] - O[i - 1]), pd = C[i - 1] > O[i - 1] ? 1 : C[i - 1] < O[i - 1] ? -1 : 0
      if (dir === 1 && pd === -1 && O[i] <= C[i - 1] && C[i] >= O[i - 1] && body > pb) b.engulf = 1
      else if (dir === -1 && pd === 1 && O[i] >= C[i - 1] && C[i] <= O[i - 1] && body > pb) b.engulf = -1
      if (H[i] <= H[i - 1] && Lo[i] >= Lo[i - 1]) b.inside = 1
      if (H[i] > H[i - 1] && Lo[i] < Lo[i - 1]) b.outside = 1
    }
    if (rng > 0 && atr > 0) {
      if (body <= 0.1 * rng) b.doji = 1
      if (rng >= 0.5 * atr && body <= 0.35 * rng) { if (dn >= 2 * body && dn >= 0.55 * rng) b.pin = 1; else if (up >= 2 * body && up >= 0.55 * rng) b.pin = -1 }
      if (body >= 0.9 * rng && body >= 0.8 * atr) b.marubozu = dir
    }
    if (i >= 2 && atr > 0) {
      const d = (q: number) => (C[q] > O[q] ? 1 : C[q] < O[q] ? -1 : 0)
      const topClose = (q: number, sgn: number) => (sgn > 0 ? (C[q] - Lo[q]) / Math.max(1e-12, H[q] - Lo[q]) >= 0.7 : (H[q] - C[q]) / Math.max(1e-12, H[q] - Lo[q]) >= 0.7)
      for (const sgn of [1, -1]) {
        if (d(i) === sgn && d(i - 1) === sgn && d(i - 2) === sgn && (C[i] - C[i - 1]) * sgn > 0 && (C[i - 1] - C[i - 2]) * sgn > 0 && topClose(i, sgn) && topClose(i - 1, sgn) && topClose(i - 2, sgn)) b.soldiers = sgn
        const b2 = Math.abs(C[i - 2] - O[i - 2]), b1 = Math.abs(C[i - 1] - O[i - 1])
        if (d(i - 2) === -sgn && b2 >= 0.6 * atr && b1 <= 0.3 * b2 && d(i) === sgn && (C[i] - (O[i - 2] + C[i - 2]) / 2) * sgn > 0) b.star = sgn
      }
    }
    // ---- psychology
    if (atr > 0) {
      if (b.z >= 2 && up >= 0.4 * atr) b.exhaust = -1
      else if (b.z <= -2 && dn >= 0.4 * atr) b.exhaust = 1
      if (body >= 1.8 * atr) b.climax = dir
      const a = b.anchor
      b.anchorTouch = Lo[i] <= a && H[i] >= a ? 1 : 0
      if (i >= 1 && b.anchorTouch && !b.rolled) {
        const side = Math.sign(C[i - 1] - a)
        if (side !== 0 && Math.sign(C[i] - a) === side && Math.abs(C[i] - a) >= 0.25 * atr) b.reject = side
      }
      if (i >= 1 && !b.rolled) {
        const pH = bars[i - 1].pHigh, pL = bars[i - 1].pLow
        if (Number.isFinite(pH) && H[i] > pH && C[i] < pH) b.trap = -1
        else if (Number.isFinite(pL) && Lo[i] < pL && C[i] > pL) b.trap = 1
      }
    }
    b.streak = dir === 0 ? 0 : i > 0 && Math.sign(bars[i - 1].streak) === dir ? bars[i - 1].streak + dir : dir
    if (i >= 10) { let path = 0; for (let q = i - 9; q <= i; q++) path += Math.abs(C[q] - C[q - 1]); b.er = path > 0 ? Math.abs(C[i] - C[i - 10]) / path : 0 }
  }
}

function signalStats(bars: AnchorBar[], win: number, tail: number): void {
  const m = bars.length
  const from0 = Number.isFinite(tail) ? Math.max(0, m - tail) : 0
  for (let i = from0; i < m; i++) {
    const b = bars[i]
    const from = Math.max(0, i - win + 1)
    for (const name of ANCHOR_SIGNALS) {
      const v = b[name]
      if (!v) continue
      const res = emptyNext()
      for (const h of ANCHOR_HORIZONS) {
        let n = 0, upc = 0, bull = 0, mv = 0
        for (let j = from; j + h <= i; j++) {
          const w = bars[j]
          if (w[name] !== v || !(w.atr > 0)) continue
          const fut = bars[j + h]
          const move = fut.price - w.price
          n++; if (move > 0) upc++; if (fut.dir > 0) bull++; mv += move / w.atr
        }
        res[h] = n >= MIN_VISITS ? { n, ready: true, up: upc / n, bull: bull / n, move: mv / n } : { n, ready: false, up: 0.5, bull: 0.5, move: 0 }
      }
      b.sigNext[name] = res
    }
  }
}

interface Sw { j: number; p: number }
interface Gz { kind: 1 | -1; top: number; bottom: number; created: number }

/** extended candle patterns, FVG / order blocks / premium-discount / ranges / double tops / H&S / trendlines / wedge, extra psychology and market state. Every value uses bars <= i only. */
function extraSignals(bars: AnchorBar[], candles: Candle[], idxOf: number[], L: number, win: number): void {
  const m = bars.length
  const O = idxOf.map((k) => candles[k].open), H = idxOf.map((k) => candles[k].high), Lo = idxOf.map((k) => candles[k].low), C = idxOf.map((k) => candles[k].close), V = idxOf.map((k) => candles[k].volume ?? 0)
  const col = (q: number) => (C[q] > O[q] ? 1 : C[q] < O[q] ? -1 : 0)
  const bd = (q: number) => Math.abs(C[q] - O[q])
  const swH: Sw[] = [], swL: Sw[] = []
  let fvgs: Gz[] = [], obs: Gz[] = []
  const fired = new Set<string>()
  let brk: { dir: number; level: number; idx: number } | null = null
  let hunt: { i: number; dir: number; hi: number; lo: number } | null = null
  let firstZ = Number.NaN, touched = false
  for (let i = 0; i < m; i++) {
    const b = bars[i]
    const atr = b.atr
    const ok = atr > 0
    // ---- swings (same rule as the structure pass)
    const j = i - L
    if (j >= L && ok) {
      let isH = true, isL = true
      for (let q = 1; q <= L; q++) {
        if (!(H[j] > H[j - q]) || !(H[j] >= H[j + q])) isH = false
        if (!(Lo[j] < Lo[j - q]) || !(Lo[j] <= Lo[j + q])) isL = false
      }
      if (isH) { swH.push({ j, p: H[j] }); if (swH.length > 12) swH.shift() }
      if (isL) { swL.push({ j, p: Lo[j] }); if (swL.length > 12) swL.shift() }
    }
    const rng = H[i] - Lo[i], body = bd(i)
    const up = H[i] - Math.max(O[i], C[i]), dn = Math.min(O[i], C[i]) - Lo[i]
    // ---- extended candle patterns
    if (ok && i >= 1) {
      const pb = bd(i - 1)
      if (pb >= 0.6 * atr && col(i) === -col(i - 1) && col(i) !== 0 && body <= 0.5 * pb && Math.max(O[i], C[i]) <= Math.max(O[i - 1], C[i - 1]) && Math.min(O[i], C[i]) >= Math.min(O[i - 1], C[i - 1])) b.harami = -col(i - 1)
      if (Math.abs(H[i] - H[i - 1]) <= 0.08 * atr && col(i - 1) === 1 && col(i) === -1) b.tweezer = -1
      else if (Math.abs(Lo[i] - Lo[i - 1]) <= 0.08 * atr && col(i - 1) === -1 && col(i) === 1) b.tweezer = 1
      const mid = (O[i - 1] + C[i - 1]) / 2
      if (pb >= 0.6 * atr && col(i - 1) === -1 && col(i) === 1 && O[i] <= C[i - 1] && C[i] > mid && C[i] < O[i - 1]) b.piercing = 1
      else if (pb >= 0.6 * atr && col(i - 1) === 1 && col(i) === -1 && O[i] >= C[i - 1] && C[i] < mid && C[i] > O[i - 1]) b.piercing = -1
      if (col(i - 1) === -1 && col(i) === 1 && bd(i) >= 0.6 * atr && pb >= 0.6 * atr && O[i] >= O[i - 1]) b.kicker = 1
      else if (col(i - 1) === 1 && col(i) === -1 && bd(i) >= 0.6 * atr && pb >= 0.6 * atr && O[i] <= O[i - 1]) b.kicker = -1
    }
    if (ok && i >= 2) {
      const b2 = bd(i - 2)
      if (b2 >= 0.6 * atr && col(i - 1) === -col(i - 2) && col(i - 1) !== 0 && bd(i - 1) <= 0.5 * b2 && col(i) === col(i - 1) && (C[i] - O[i - 2]) * col(i) > 0) b.threeInside = col(i)
    }
    if (ok && i >= 3) {
      for (const sgn of [1, -1]) if (col(i - 3) === -sgn && col(i - 2) === -sgn && col(i - 1) === -sgn && (C[i - 2] - C[i - 3]) * sgn < 0 && (C[i - 1] - C[i - 2]) * sgn < 0 && col(i) === sgn && (C[i] - O[i - 3]) * sgn > 0) b.threeStrike = sgn
    }
    if (ok && rng > 0) {
      if (body >= 0.6 * rng && rng >= 0.8 * atr) { if (col(i) === 1 && O[i] - Lo[i] <= 0.05 * rng) b.beltHold = 1; else if (col(i) === -1 && H[i] - O[i] <= 0.05 * rng) b.beltHold = -1 }
      if (i >= 4 && rng >= 0.5 * atr && body <= 0.35 * rng) {
        const prior = C[i - 1] - C[i - 4]
        if (dn >= 2 * body && dn >= 0.55 * rng && up <= 0.15 * rng) { if (prior <= -0.5 * atr) b.hammer = 1; else if (prior >= 0.5 * atr) b.hammer = -1 }
        if (up >= 2 * body && up >= 0.55 * rng && dn <= 0.15 * rng) { if (prior <= -0.5 * atr) b.invHammer = 1; else if (prior >= 0.5 * atr) b.invHammer = -1 }
      }
    }
    // ---- fair value gaps
    if (ok && i >= 2) {
      if (Lo[i] - H[i - 2] >= 0.1 * atr) { b.fvg = 1; fvgs.push({ kind: 1, top: Lo[i], bottom: H[i - 2], created: i }) }
      else if (Lo[i - 2] - H[i] >= 0.1 * atr) { b.fvg = -1; fvgs.push({ kind: -1, top: Lo[i - 2], bottom: H[i], created: i }) }
    }
    let tapB = false, tapS = false
    for (const g of fvgs) if (i > g.created && Lo[i] <= g.top && H[i] >= g.bottom) { if (g.kind === 1) tapB = true; else tapS = true }
    b.fvgTap = tapB && !tapS ? 1 : tapS && !tapB ? -1 : 0
    fvgs = fvgs.filter((g) => i <= g.created || (g.kind === 1 ? C[i] >= g.bottom : C[i] <= g.top)).filter((g) => i - g.created <= win)
    if (fvgs.length > 20) { fvgs.sort((a, c) => c.created - a.created); fvgs.length = 20 }
    {
      let bu: Gz | undefined, be: Gz | undefined
      for (const g of fvgs) {
        if (g.kind === 1 && g.bottom <= C[i] && (!bu || g.top > bu.top)) bu = g
        if (g.kind === -1 && g.top >= C[i] && (!be || g.bottom < be.bottom)) be = g
      }
      if (bu) { b.fvgBullTop = bu.top; b.fvgBullBottom = bu.bottom }
      if (be) { b.fvgBearTop = be.top; b.fvgBearBottom = be.bottom }
      b.inFvg = bu && C[i] <= bu.top ? 1 : be && C[i] >= be.bottom ? -1 : 0
    }
    // ---- order blocks: the last opposite-colour candle before a BOS / CHoCH
    const ev = b.bos || b.choch
    if (ev && ok) {
      for (let q = i - 1; q >= Math.max(0, i - 10); q--) {
        if (col(q) === -ev) {
          if (!obs.some((o) => o.created === q)) obs.push({ kind: ev as 1 | -1, top: H[q], bottom: Lo[q], created: q })
          break
        }
      }
    }
    let oT = 0
    for (const o of obs) if (i > o.created && Lo[i] <= o.top && H[i] >= o.bottom && i > o.created + 1) oT = oT === 0 ? o.kind : 0
    b.obTap = oT
    obs = obs.filter((o) => i <= o.created + 1 || (o.kind === 1 ? C[i] >= o.bottom : C[i] <= o.top)).filter((o) => i - o.created <= win)
    if (obs.length > 20) { obs.sort((a, c) => c.created - a.created); obs.length = 20 }
    {
      let bu: Gz | undefined, be: Gz | undefined
      for (const o of obs) {
        if (o.kind === 1 && o.bottom <= C[i] && (!bu || o.top > bu.top)) bu = o
        if (o.kind === -1 && o.top >= C[i] && (!be || o.bottom < be.bottom)) be = o
      }
      if (bu) { b.obBullTop = bu.top; b.obBullBottom = bu.bottom }
      if (be) { b.obBearTop = be.top; b.obBearBottom = be.bottom }
      b.inOb = bu && C[i] <= bu.top ? 1 : be && C[i] >= be.bottom ? -1 : 0
    }
    // ---- premium / discount of the current swing range
    if (Number.isFinite(b.swingHigh) && Number.isFinite(b.swingLow) && b.swingHigh > b.swingLow) {
      b.pdPos = (C[i] - b.swingLow) / (b.swingHigh - b.swingLow)
      b.pdZone = b.pdPos > 0.5 ? -1 : 1
      const q = b.pdZone === -1 ? b.pdPos : 1 - b.pdPos
      b.ote = q >= 0.62 && q <= 0.79 ? 1 : 0
    }
    // ---- ranges and breakout + retest (the range is the 20 bars BEFORE this one)
    const RN = 20
    if (ok && i >= RN) {
      let hi = -Infinity, lo = Infinity
      for (let q = i - RN; q < i; q++) { if (H[q] > hi) hi = H[q]; if (Lo[q] < lo) lo = Lo[q] }
      if (hi - lo <= 3.5 * atr) {
        b.inRange = 1; b.rangeHigh = hi; b.rangeLow = lo
        if (C[i] > hi) { b.rangeBreak = 1; brk = { dir: 1, level: hi, idx: i } } else if (C[i] < lo) { b.rangeBreak = -1; brk = { dir: -1, level: lo, idx: i } }
      }
    }
    if (brk && i > brk.idx && ok) {
      if (i - brk.idx > 10) brk = null
      else if (brk.dir === 1) { if (C[i] < brk.level - 0.5 * atr) brk = null; else if (Lo[i] <= brk.level + 0.25 * atr && C[i] > brk.level) { b.retest = 1; brk = null } }
      else { if (C[i] > brk.level + 0.5 * atr) brk = null; else if (H[i] >= brk.level - 0.25 * atr && C[i] < brk.level) { b.retest = -1; brk = null } }
    }
    // ---- double top / bottom and head & shoulders (event: close through the neckline, once per pattern)
    const a2 = swH.at(-1), a1 = swH.at(-2), a0 = swH.at(-3), c2 = swL.at(-1), c1 = swL.at(-2), c0 = swL.at(-3)
    const minLo = (x: number, y: number) => { let v = Infinity; for (let q = x; q <= y; q++) if (Lo[q] < v) v = Lo[q]; return v }
    const maxHi = (x: number, y: number) => { let v = -Infinity; for (let q = x; q <= y; q++) if (H[q] > v) v = H[q]; return v }
    if (ok) {
      if (a1 && a2 && a2.j - a1.j >= 4 && Math.abs(a2.p - a1.p) <= 0.3 * atr && i - a2.j <= 30) {
        const neck = minLo(a1.j, a2.j)
        const key = `dt${a2.j}`
        if (a1.p - neck >= atr && C[i] < neck && !fired.has(key)) { fired.add(key); b.double = -1 }
      }
      if (c1 && c2 && c2.j - c1.j >= 4 && Math.abs(c2.p - c1.p) <= 0.3 * atr && i - c2.j <= 30) {
        const neck = maxHi(c1.j, c2.j)
        const key = `db${c2.j}`
        if (neck - c1.p >= atr && C[i] > neck && !fired.has(key)) { fired.add(key); b.double = 1 }
      }
      if (a0 && a1 && a2 && a1.p - Math.max(a0.p, a2.p) >= 0.5 * atr && Math.abs(a0.p - a2.p) <= 0.6 * atr && i - a2.j <= 40) {
        const neck = (minLo(a0.j, a1.j) + minLo(a1.j, a2.j)) / 2
        const key = `hs${a1.j}`
        if (C[i] < neck && !fired.has(key)) { fired.add(key); b.hs = -1 }
      }
      if (c0 && c1 && c2 && Math.min(c0.p, c2.p) - c1.p >= 0.5 * atr && Math.abs(c0.p - c2.p) <= 0.6 * atr && i - c2.j <= 40) {
        const neck = (maxHi(c0.j, c1.j) + maxHi(c1.j, c2.j)) / 2
        const key = `ihs${c1.j}`
        if (C[i] > neck && !fired.has(key)) { fired.add(key); b.hs = 1 }
      }
      if (fired.size > 200) fired.clear()
    }
    // ---- trendlines through the last two swing lows (rising) / highs (falling), wedge and channel from both slopes
    let slopeL = Number.NaN, slopeH = Number.NaN
    if (c1 && c2 && c2.j > c1.j) slopeL = (c2.p - c1.p) / (c2.j - c1.j)
    if (a1 && a2 && a2.j > a1.j) slopeH = (a2.p - a1.p) / (a2.j - a1.j)
    if (ok && Number.isFinite(slopeL) && slopeL > 0 && c2) {
      const now = c2.p + slopeL * (i - c2.j), prev = c2.p + slopeL * (i - 1 - c2.j)
      b.tlSupport = now
      if (i >= 1 && C[i - 1] >= prev && C[i] < now) b.tlBreak = -1
    }
    if (ok && Number.isFinite(slopeH) && slopeH < 0 && a2) {
      const now = a2.p + slopeH * (i - a2.j), prev = a2.p + slopeH * (i - 1 - a2.j)
      b.tlResist = now
      if (i >= 1 && C[i - 1] <= prev && C[i] > now) b.tlBreak = b.tlBreak || 1
    }
    if (Number.isFinite(slopeL) && Number.isFinite(slopeH) && ok) {
      if (slopeH > 0 && slopeL > 0 && slopeL > slopeH) b.wedge = -1
      else if (slopeH < 0 && slopeL < 0 && slopeL > slopeH) b.wedge = 1
      const mx = Math.max(Math.abs(slopeL), Math.abs(slopeH))
      if (mx * 20 >= 0.2 * atr && Math.sign(slopeL) === Math.sign(slopeH) && Math.abs(slopeL - slopeH) <= 0.25 * mx) b.channel = Math.sign(slopeL)
    }
    // ---- psychology
    if (ok && i >= 4 && rng > 0) {
      let avgV = 0
      for (let q = Math.max(0, i - 20); q < i; q++) avgV += V[q]
      avgV /= Math.max(1, Math.min(20, i))
      const volOk = avgV > 0 ? V[i] >= 1.8 * avgV : true
      const closePos = (C[i] - Lo[i]) / rng
      if (rng >= 2 * atr && body >= 1.2 * atr && volOk) {
        if (col(i) === -1 && C[i - 1] < C[i - 4] && closePos <= 0.25) b.capitulation = 1
        else if (col(i) === 1 && C[i - 1] > C[i - 4] && closePos >= 0.75) b.capitulation = -1
      }
      if (body >= atr && Math.abs(b.streak) >= 3) { if (b.z >= 2 && col(i) === 1) b.fomo = 1; else if (b.z <= -2 && col(i) === -1) b.fomo = -1 }
    }
    if (b.rolled || i === 0) { firstZ = b.z; touched = b.anchorTouch === 1 }
    else if (b.anchorTouch === 1) touched = true
    if (Number.isFinite(firstZ) && Math.abs(firstZ) >= 0.5 && Number.isFinite(b.z)) b.gapFill = 1 - Math.abs(b.z) / Math.abs(firstZ)
    b.gapFilled = touched && Number.isFinite(firstZ) && Math.abs(firstZ) >= 0.5 ? 1 : 0
    if (b.sweep) hunt = { i, dir: b.sweep, hi: H[i], lo: Lo[i] }
    else if (hunt && i > hunt.i) {
      if (i - hunt.i > 3) hunt = null
      else if (hunt.dir === 1 && C[i] > hunt.hi) { b.stopHunt = 1; hunt = null }
      else if (hunt.dir === -1 && C[i] < hunt.lo) { b.stopHunt = -1; hunt = null }
    }
    // ---- market state
    if (ok && i >= 20) {
      let sum = 0, n = 0
      for (let q = Math.max(0, i - 50); q < i; q++) if (bars[q].atr > 0) { sum += bars[q].atr; n++ }
      if (n >= 10) b.volRatio = atr / (sum / n)
    }
    b.squeeze = Number.isFinite(b.volRatio) && b.volRatio <= 0.75 ? 1 : 0
    if (ok && i >= 1 && (bars[i - 1].squeeze === 1 || (i >= 2 && bars[i - 2].squeeze === 1)) && b.tr >= 1.5 * atr && col(i) !== 0) b.expansion = col(i)
    const hr = Math.floor(bars[i].time / 3600) % 24
    b.hour = hr
    b.session = hr < 7 ? 1 : hr < 12 ? 2 : hr < 21 ? 3 : 0
    b.regime = b.squeeze ? 2 : Number.isFinite(b.adx) && b.adx >= 25 && Number.isFinite(b.er) && b.er >= 0.4 ? 1 : Number.isFinite(b.adx) && b.adx < 18 ? -1 : 0
  }
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
