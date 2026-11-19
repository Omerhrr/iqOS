// IQAIR//OS - the story of the last CLOSED candle (`story.*` in MSL).
//
// A closed candle is four numbers, but how those four numbers sit relative to each other, to the bars before it and (when a 5s chart is available) to the path price took inside it
// says a lot about who was in control. This turns that into plain facts + one readable sentence, all from CLOSED bars, so it is causal and backtestable
// (the 5s path parts need a 5s series and are NaN / "" without one - never an error).
//
// HONESTY: this DESCRIBES what happened. Whether a given story predicts the next candle is a separate question - test it (backtest `story.kind() == "..."`) before trusting one.
import { emSigmaAt, EM_MIN_BARS, emParams } from './expectedmove'
export interface StoryBars { open: number[]; high: number[]; low: number[]; close: number[]; time?: number[] }
export interface Story {
  ok: boolean
  dir: 1 | -1 | 0
  kind: string          // marubozu | rejection-high | rejection-low | doji | spinning-top | drive | normal
  body: number; range: number; upperWick: number; lowerWick: number  // fractions of the range (0..1)
  closePos: number      // where it closed inside its range, 0 = low .. 1 = high
  sizeAtr: number       // range in ATR14 of the bars before it
  bodyAtr: number
  sweep: number         // +1 poked below a recent low and closed back above it (bullish trap), -1 poked above a recent high and closed back below, 0 none
  breakout: number      // +1 closed above the recent N-bar high, -1 below the recent low, 0 inside
  engulf: number        // +1 body engulfs the previous body upward, -1 downward, 0 no
  inside: boolean       // range fully inside the previous bar's range
  gap: number           // open vs previous close in ATR (signed)
  // 5s path (NaN when no 5s series covers the candle)
  has5s: boolean
  pathEff: number       // |net move| / sum of 5s moves: 1 = one clean push, 0 = pure chop
  retrace: number       // fraction of the candle's best excursion given back by the close (0 none .. 1 all)
  extremeEarly: number  // +1 the candle's extreme (the one in its direction) came in the first half, -1 in the second half, 0 unknown
  upShare: number       // share of 5s bars that closed up
  burst: number         // largest single 5s move as a share of the whole candle's range
  // EXPECTED MOVE (analytics/expectedmove.ts): how big the candle was against what recent volatility says a bar normally does. NaN with < 40 bars.
  sigma: number         // 1-bar standard deviation (price units), measured on the bars BEFORE this candle
  moveSigma: number     // close vs previous close, in sigmas (signed): |x| < 1 normal, 1-2 stretched, > 2 extreme
  rangeSigma: number    // high-low in sigmas
  expUp1: number; expDn1: number; expUp2: number; expDn2: number   // the 1-sigma / 2-sigma range for the NEXT bar, centred on this candle's close
  partial: boolean      // true for the candle still forming
  progress: number      // forming candle: share of its time already elapsed (1 for a closed one)
  text: string
}
export const STORY_LOOKBACK = 10
const atr14 = (h: number[], l: number[], c: number[], end: number): number => {
  const n = 14; if (end < n + 1) return NaN
  let s = 0
  for (let i = end - n; i < end; i++) s += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))
  return s / n
}
const NONE: Story = { ok: false, dir: 0, kind: '', body: NaN, range: NaN, upperWick: NaN, lowerWick: NaN, closePos: NaN, sizeAtr: NaN, bodyAtr: NaN, sweep: 0, breakout: 0, engulf: 0, inside: false, gap: NaN, has5s: false, pathEff: NaN, retrace: NaN, extremeEarly: 0, upShare: NaN, burst: NaN, sigma: NaN, moveSigma: NaN, rangeSigma: NaN, expUp1: NaN, expDn1: NaN, expUp2: NaN, expDn2: NaN, partial: false, progress: 1, text: 'not enough candles to read a story' }

/** `five` = the 5s bars (any length, ascending) if available; the candle's span is taken from `s.time` and the bar spacing. */
export function readStory(s: StoryBars, five?: StoryBars, partial = false, progress = 1): Story {
  const i = s.close.length - 1
  if (i < 16) return NONE
  const o = s.open[i], h = s.high[i], l = s.low[i], c = s.close[i]
  const rng = h - l
  if (!(rng > 0)) return { ...NONE, ok: true, dir: 0, kind: 'flat', text: 'a flat candle - no range at all' }
  const a = atr14(s.high, s.low, s.close, i)
  const body = Math.abs(c - o) / rng, up = (h - Math.max(o, c)) / rng, lo = (Math.min(o, c) - l) / rng
  const closePos = (c - l) / rng
  const dir: 1 | -1 | 0 = c > o ? 1 : c < o ? -1 : 0
  let hiPrev = -Infinity, loPrev = Infinity
  for (let k = i - STORY_LOOKBACK; k < i; k++) { hiPrev = Math.max(hiPrev, s.high[k]); loPrev = Math.min(loPrev, s.low[k]) }
  const sweep = l < loPrev && c > loPrev ? 1 : h > hiPrev && c < hiPrev ? -1 : 0
  const breakout = c > hiPrev ? 1 : c < loPrev ? -1 : 0
  const po = s.open[i - 1], pc = s.close[i - 1]
  const pTop = Math.max(po, pc), pBot = Math.min(po, pc), cTop = Math.max(o, c), cBot = Math.min(o, c)
  const engulf = dir !== 0 && cTop >= pTop && cBot <= pBot && Math.abs(c - o) > Math.abs(pc - po) && Math.sign(pc - po) === -dir ? dir : 0
  const inside = h <= s.high[i - 1] && l >= s.low[i - 1]
  const gap = Number.isFinite(a) && a > 0 ? (o - pc) / a : NaN
  const sizeAtr = Number.isFinite(a) && a > 0 ? rng / a : NaN
  const bodyAtr = Number.isFinite(a) && a > 0 ? Math.abs(c - o) / a : NaN
  let sigma = NaN, moveSigma = NaN, rangeSigma = NaN, expUp1 = NaN, expDn1 = NaN, expUp2 = NaN, expDn2 = NaN
  if (i >= EM_MIN_BARS + 1) {
    const x = { close: s.close, high: s.high, low: s.low }
    const sdBefore = emSigmaAt(x, i - 1), sdNow = emSigmaAt(x, i)
    if (sdBefore > 0) { sigma = sdBefore; moveSigma = (c - s.close[i - 1]) / sdBefore; rangeSigma = rng / sdBefore }
    if (sdNow > 0) { expUp1 = c + sdNow; expDn1 = c - sdNow; expUp2 = c + 2 * sdNow; expDn2 = c - 2 * sdNow }
  }
  const kind = body >= 0.8 ? 'marubozu' : up >= 0.5 && closePos <= 0.4 ? 'rejection-high' : lo >= 0.5 && closePos >= 0.6 ? 'rejection-low' : body <= 0.12 ? 'doji'
    : body <= 0.3 && up >= 0.25 && lo >= 0.25 ? 'spinning-top' : sizeAtr >= 1.6 && body >= 0.55 ? 'drive' : 'normal'

  // ---- the path inside the candle, from 5s bars ----
  let has5s = false, pathEff = NaN, retrace = NaN, extremeEarly = 0, upShare = NaN, burst = NaN
  if (five && five.time && s.time && five.close.length > 4) {
    const t0 = s.time[i], span = s.time[i] - s.time[i - 1]
    if (span > 0) {
      const seg: number[] = []
      for (let k = 0; k < five.time.length; k++) if (five.time[k] >= t0 && five.time[k] < t0 + span) seg.push(k)
      if (seg.length >= (partial ? 3 : Math.max(4, Math.floor(span / 5 * 0.6)))) {
        has5s = true
        let sumAbs = 0, ups = 0, big = 0, prev = five.open[seg[0]]
        let hiIdx = 0, loIdx = 0, hiV = -Infinity, loV = Infinity
        seg.forEach((k, j) => {
          const mv = five.close[k] - prev; sumAbs += Math.abs(mv); if (mv > 0) ups++; big = Math.max(big, Math.abs(mv)); prev = five.close[k]
          if (five.high[k] > hiV) { hiV = five.high[k]; hiIdx = j }
          if (five.low[k] < loV) { loV = five.low[k]; loIdx = j }
        })
        pathEff = sumAbs > 0 ? Math.min(1, Math.abs(c - o) / sumAbs) : NaN
        upShare = ups / seg.length
        burst = big / rng
        const half = seg.length / 2
        if (dir > 0) { extremeEarly = hiIdx < half ? 1 : -1; retrace = hiV > o ? Math.max(0, (hiV - c) / (hiV - o)) : NaN }
        else if (dir < 0) { extremeEarly = loIdx < half ? 1 : -1; retrace = o > loV ? Math.max(0, (c - loV) / (o - loV)) : NaN }
      }
    }
  }

  // ---- the sentence ----
  const side = dir > 0 ? 'up' : dir < 0 ? 'down' : 'flat'
  const size = !Number.isFinite(sizeAtr) ? '' : sizeAtr >= 1.6 ? 'a big' : sizeAtr <= 0.6 ? 'a small' : 'a normal-sized'
  const parts: string[] = []
  const head: Record<string, string> = {
    marubozu: `${size} one-way ${side} candle: almost all body, ${dir > 0 ? 'buyers' : 'sellers'} in control from open to close`,
    'rejection-high': `${size} candle that pushed up and was rejected: a long upper wick and a close back in the lower part of the range`,
    'rejection-low': `${size} candle that pushed down and was rejected: a long lower wick and a close back in the upper part of the range`,
    doji: `${size} indecision candle: open and close almost the same`,
    'spinning-top': `${size} two-sided candle: small body with wicks on both ends, neither side won`,
    drive: `${size} drive ${side}: big range and a solid body`,
    normal: `${size} ${side} candle`, flat: 'a flat candle',
  }
  parts.push((head[kind] ?? `${size} ${side} candle`).replace(/^ /, ''))
  if (sweep > 0) parts.push(`it swept below the recent ${STORY_LOOKBACK}-bar low and closed back above it (a possible stop-run, bullish trap)`)
  else if (sweep < 0) parts.push(`it swept above the recent ${STORY_LOOKBACK}-bar high and closed back below it (a possible stop-run, bearish trap)`)
  else if (breakout > 0) parts.push(`it closed above the recent ${STORY_LOOKBACK}-bar high (a breakout)`)
  else if (breakout < 0) parts.push(`it closed below the recent ${STORY_LOOKBACK}-bar low (a breakdown)`)
  if (engulf !== 0) parts.push(`its body engulfed the previous one ${engulf > 0 ? 'upward' : 'downward'}`)
  if (inside) parts.push('it stayed inside the previous bar (compression)')
  if (Number.isFinite(gap) && Math.abs(gap) >= 0.5) parts.push(`it opened with a ${gap > 0 ? 'gap up' : 'gap down'} of ${Math.abs(gap).toFixed(1)} ATR`)
  if (has5s) {
    if (Number.isFinite(pathEff)) parts.push(pathEff >= 0.6 ? 'inside it price moved in one clean push' : pathEff <= 0.25 ? 'inside it price chopped around before settling' : 'inside it price moved with some back-and-forth')
    if (dir !== 0 && Number.isFinite(retrace) && retrace >= 0.5) parts.push(`it gave back ${(retrace * 100).toFixed(0)}% of its best move by the close`)
    else if (dir !== 0 && extremeEarly !== 0) parts.push(extremeEarly > 0 ? 'the extreme came early and held' : 'the extreme came late, momentum was building into the close')
  }
  if (Number.isFinite(moveSigma)) {
    const m = Math.abs(moveSigma)
    parts.push(`its close moved ${moveSigma >= 0 ? '+' : '-'}${m.toFixed(1)} sigma from the previous close (${m < 1 ? 'a normal move' : m < 2 ? 'a stretched move' : 'an extreme move'} for this market's recent volatility)`)
    parts.push(`the expected range for the next bar is ${expDn1.toFixed(5)} to ${expUp1.toFixed(5)} (1 sigma) and ${expDn2.toFixed(5)} to ${expUp2.toFixed(5)} (2 sigma)`)
  }
  let text = parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + (parts.length > 1 ? '; ' + parts.slice(1).join('; ') : '') + '.'
  if (partial) text = `So far (${Math.round(progress * 100)}% of the candle elapsed, still forming): ${text.charAt(0).toLowerCase()}${text.slice(1)}`
  return { ok: true, dir, kind, body, range: rng, upperWick: up, lowerWick: lo, closePos, sizeAtr, bodyAtr, sweep, breakout, engulf, inside, gap, has5s, pathEff, retrace, extremeEarly, upShare, burst, sigma, moveSigma, rangeSigma, expUp1, expDn1, expUp2, expDn2, partial, progress: partial ? progress : 1, text }
}

/** rate of change of the close over n bars, % (roc) - plus the same in ATR and the change of the 1-bar roc (acceleration) */
export function readRoc(s: StoryBars, n: number): { roc: number; rocAtr: number; accel: number; rocOfBody: number } {
  const i = s.close.length - 1
  const nn = Math.max(1, Math.round(n))
  if (i < nn + 1 || !(s.close[i - nn] > 0)) return { roc: NaN, rocAtr: NaN, accel: NaN, rocOfBody: NaN }
  const roc = (s.close[i] - s.close[i - nn]) / s.close[i - nn] * 100
  const a = atr14(s.high, s.low, s.close, i)
  const rocAtr = Number.isFinite(a) && a > 0 ? (s.close[i] - s.close[i - nn]) / a : NaN
  const r1 = (k: number) => (s.close[k] - s.close[k - nn]) / s.close[k - nn] * 100
  const accel = i - 1 >= nn && s.close[i - 1 - nn] > 0 ? r1(i) - r1(i - 1) : NaN
  const rocOfBody = s.open[i] > 0 ? (s.close[i] - s.open[i]) / s.open[i] * 100 : NaN
  return { roc, rocAtr, accel, rocOfBody }
}

// ===================== the story of a WINDOW of bars (14, 21, any) =====================
export interface WindowStory {
  ok: boolean; n: number
  kind: string          // trend-up | trend-down | drift-up | drift-down | range | squeeze | expansion | reversal-up | reversal-down | exhausting-up | exhausting-down
  dir: 1 | -1 | 0
  net: number           // close-to-close move over the window, ATR
  roc: number           // same move in %
  eff: number           // |net| / total path: 1 = a straight line, 0 = pure back-and-forth
  upShare: number       // share of bars that closed up
  hhhl: number          // share of bars with a higher high AND higher low  (trend-up structure)
  lhll: number          // share of bars with a lower high AND lower low   (trend-down structure)
  rangeAtr: number      // window high-low in ATR
  pos: number           // where the last close sits in the window range, 0 = at the low .. 1 = at the high
  expansion: number     // avg bar range of the last third / the first third (>1.4 widening, <0.7 narrowing)
  bodyShare: number     // average body / range
  tail: number          // lower-wick share minus upper-wick share: >0 buyers kept rejecting dips, <0 sellers kept rejecting rallies
  firstHalf: number; secondHalf: number   // net move of each half, ATR
  biggestAtr: number; biggestAge: number  // largest single bar's range (ATR) and how many bars ago
  // EXPECTED MOVE: the window's net move against what n bars of recent volatility normally cover (sd * n^hurst, sd measured BEFORE the window; no look-ahead)
  netSigma: number      // signed; |x| < 1 normal, 1-2 stretched, > 2 extreme
  expUp1: number; expDn1: number; expUp2: number; expDn2: number   // the 1/2-sigma range for the NEXT bar from the last close
  text: string
}
const NOW: WindowStory = { ok: false, n: 0, kind: '', dir: 0, net: NaN, roc: NaN, eff: NaN, upShare: NaN, hhhl: NaN, lhll: NaN, rangeAtr: NaN, pos: NaN, expansion: NaN, bodyShare: NaN, tail: NaN, firstHalf: NaN, secondHalf: NaN, biggestAtr: NaN, biggestAge: NaN, netSigma: NaN, expUp1: NaN, expDn1: NaN, expUp2: NaN, expDn2: NaN, text: 'not enough candles for that window' }

/** the story of the last `n` closed bars (3..200). Needs n + 16 bars of history (ATR14 is measured on the bars BEFORE the window, so the window cannot inflate its own yardstick). */
export function readWindowStory(s: StoryBars, nIn: number): WindowStory {
  const n = Math.round(nIn)
  const i = s.close.length - 1
  if (!(n >= 3 && n <= 200) || i < n + 16) return { ...NOW, n: Number.isFinite(n) ? n : 0 }
  const a0 = i - n + 1                       // first bar of the window
  const atr = atr14(s.high, s.low, s.close, a0)
  if (!(atr > 0)) return { ...NOW, n }
  const net = s.close[i] - s.close[a0 - 1]
  let path = 0, ups = 0, hh = 0, ll = 0, hi = -Infinity, lo = Infinity, bodySum = 0, upW = 0, loW = 0, big = 0, bigAge = 0
  for (let k = a0; k <= i; k++) {
    path += Math.abs(s.close[k] - s.close[k - 1]); if (s.close[k] > s.open[k]) ups++
    if (s.high[k] > s.high[k - 1] && s.low[k] > s.low[k - 1]) hh++
    if (s.high[k] < s.high[k - 1] && s.low[k] < s.low[k - 1]) ll++
    hi = Math.max(hi, s.high[k]); lo = Math.min(lo, s.low[k])
    const r = s.high[k] - s.low[k]
    if (r > 0) { bodySum += Math.abs(s.close[k] - s.open[k]) / r; upW += (s.high[k] - Math.max(s.open[k], s.close[k])) / r; loW += (Math.min(s.open[k], s.close[k]) - s.low[k]) / r }
    if (r > big) { big = r; bigAge = i - k }
  }
  const eff = path > 0 ? Math.abs(net) / path : 0
  const third = Math.max(1, Math.floor(n / 3))
  const avgRange = (from: number, to: number) => { let t = 0; for (let k = from; k <= to; k++) t += s.high[k] - s.low[k]; return t / (to - from + 1) }
  const avgBody = (from: number, to: number) => { let t = 0, c = 0; for (let k = from; k <= to; k++) { const r = s.high[k] - s.low[k]; if (r > 0) { t += Math.abs(s.close[k] - s.open[k]) / r; c++ } } return c ? t / c : 0 }
  const avgUpWick = (from: number, to: number) => { let t = 0, c = 0; for (let k = from; k <= to; k++) { const r = s.high[k] - s.low[k]; if (r > 0) { t += (s.high[k] - Math.max(s.open[k], s.close[k])) / r; c++ } } return c ? t / c : 0 }
  const avgLoWick = (from: number, to: number) => { let t = 0, c = 0; for (let k = from; k <= to; k++) { const r = s.high[k] - s.low[k]; if (r > 0) { t += (Math.min(s.open[k], s.close[k]) - s.low[k]) / r; c++ } } return c ? t / c : 0 }
  const firstR = avgRange(a0, a0 + third - 1), lastR = avgRange(i - third + 1, i)
  const expansion = firstR > 0 ? lastR / firstR : NaN
  const mid = a0 + Math.floor(n / 2) - 1
  const firstHalf = (s.close[mid] - s.close[a0 - 1]) / atr, secondHalf = (s.close[i] - s.close[mid]) / atr
  const netAtr = net / atr
  const root = Math.sqrt(n)
  const trendThr = 0.7 * root
  const dir: 1 | -1 | 0 = netAtr > 0.25 ? 1 : netAtr < -0.25 ? -1 : 0
  const bodyFirst = avgBody(a0, a0 + third - 1), bodyLast = avgBody(i - third + 1, i)
  const upWickLast = avgUpWick(i - third + 1, i), loWickLast = avgLoWick(i - third + 1, i)
  let kind: string
  if (firstHalf <= -0.35 * root && secondHalf >= 0.35 * root) kind = 'reversal-up'
  else if (firstHalf >= 0.35 * root && secondHalf <= -0.35 * root) kind = 'reversal-down'
  else if (netAtr >= 0.5 * root && eff >= 0.25 && bodyFirst > 0 && bodyLast / bodyFirst < 0.7 && upWickLast >= 0.3) kind = 'exhausting-up'
  else if (netAtr <= -0.5 * root && eff >= 0.25 && bodyFirst > 0 && bodyLast / bodyFirst < 0.7 && loWickLast >= 0.3) kind = 'exhausting-down'
  else if (netAtr >= trendThr && eff >= 0.3) kind = 'trend-up'
  else if (netAtr <= -trendThr && eff >= 0.3) kind = 'trend-down'
  else if (expansion < 0.7) kind = 'squeeze'
  else if (expansion > 1.4) kind = 'expansion'
  else if (eff < 0.2) kind = 'range'
  else kind = netAtr > 0 ? 'drift-up' : 'drift-down'
  const pos = hi > lo ? (s.close[i] - lo) / (hi - lo) : 0.5
  const tail = (loW - upW) / n
  const rangeAtr = (hi - lo) / atr
  const pct = s.close[a0 - 1] > 0 ? net / s.close[a0 - 1] * 100 : NaN
  const move = `${netAtr >= 0 ? 'up' : 'down'} ${Math.abs(netAtr).toFixed(1)} ATR`
  const head: Record<string, string> = {
    'trend-up': `a steady climb: ${move} over ${n} bars, ${(ups / n * 100).toFixed(0)}% of candles green and ${(hh / n * 100).toFixed(0)}% making higher highs and higher lows`,
    'trend-down': `a steady fall: ${move} over ${n} bars, ${((n - ups) / n * 100).toFixed(0)}% of candles red and ${(ll / n * 100).toFixed(0)}% making lower highs and lower lows`,
    'drift-up': `a slow drift up (${move}) without a convincing trend`, 'drift-down': `a slow drift down (${move}) without a convincing trend`,
    range: `a range: price went back and forth and ended ${Math.abs(netAtr).toFixed(1)} ATR from where it started`,
    squeeze: `a squeeze: candles got smaller (${expansion.toFixed(2)}x the early size), the market is coiling`,
    expansion: `an expansion: candles got bigger (${expansion.toFixed(2)}x the early size), volatility is waking up`,
    'reversal-up': `a turn up: it fell ${Math.abs(firstHalf).toFixed(1)} ATR, then recovered ${secondHalf.toFixed(1)} ATR`,
    'reversal-down': `a turn down: it rose ${firstHalf.toFixed(1)} ATR, then gave back ${Math.abs(secondHalf).toFixed(1)} ATR`,
    'exhausting-up': `a climb that is running out of steam: still up ${Math.abs(netAtr).toFixed(1)} ATR but the recent bodies shrank and upper wicks grew`,
    'exhausting-down': `a fall that is running out of steam: still down ${Math.abs(netAtr).toFixed(1)} ATR but the recent bodies shrank and lower wicks grew`,
  }
  const parts = [head[kind] ?? kind]
  if (kind !== 'squeeze' && kind !== 'expansion' && Number.isFinite(expansion)) { if (expansion > 1.4) parts.push('candles are getting bigger'); else if (expansion < 0.7) parts.push('candles are getting smaller') }
  parts.push(pos >= 0.8 ? 'it is sitting near the top of the window range' : pos <= 0.2 ? 'it is sitting near the bottom of the window range' : 'it is in the middle of the window range')
  if (tail >= 0.12) parts.push('dips kept getting bought (long lower wicks)'); else if (tail <= -0.12) parts.push('rallies kept getting sold (long upper wicks)')
  if (big / atr >= 2.2) parts.push(`the biggest candle was ${(big / atr).toFixed(1)} ATR, ${bigAge === 0 ? 'the latest one' : bigAge + ' bar' + (bigAge > 1 ? 's' : '') + ' ago'}`)
  let netSigma = NaN, expUp1 = NaN, expDn1 = NaN, expUp2 = NaN, expDn2 = NaN
  if (a0 - 1 >= EM_MIN_BARS) {
    const x = { close: s.close, high: s.high, low: s.low }, pr = emParams()
    const sdB = emSigmaAt(x, a0 - 1), sdN = emSigmaAt(x, i)
    if (sdB > 0) netSigma = net / (sdB * Math.pow(n, pr.hurst))
    if (sdN > 0) { expUp1 = s.close[i] + sdN; expDn1 = s.close[i] - sdN; expUp2 = s.close[i] + 2 * sdN; expDn2 = s.close[i] - 2 * sdN }
  }
  if (Number.isFinite(netSigma)) { const m = Math.abs(netSigma); parts.push(`against what ${n} bars of recent volatility normally cover, the move was ${netSigma >= 0 ? '+' : '-'}${m.toFixed(1)} sigma (${m < 1 ? 'normal' : m < 2 ? 'stretched' : 'extreme'}); the next bar's expected range is ${expDn1.toFixed(5)} to ${expUp1.toFixed(5)} (1 sigma)`) }
  const text = parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + (parts.length > 1 ? '; ' + parts.slice(1).join('; ') : '') + '.'
  return { ok: true, n, kind, dir, net: netAtr, roc: pct, eff, upShare: ups / n, hhhl: hh / n, lhll: ll / n, rangeAtr, pos, expansion, bodyShare: bodySum / n, tail, firstHalf, secondHalf, biggestAtr: big / atr, biggestAge: bigAge, netSigma, expUp1, expDn1, expUp2, expDn2, text }
}

// ===================== full structure of any candle or series of candles =====================
/** the series as it stood `ago` bars ago (0 = now) - so ANY candle / window in the past can be read the same way */
export function cutBars(s: StoryBars, ago: number): StoryBars {
  const a = Math.max(0, Math.round(ago)); if (!a) return s
  const e = s.close.length - a
  return { open: s.open.slice(0, e), high: s.high.slice(0, e), low: s.low.slice(0, e), close: s.close.slice(0, e), time: s.time?.slice(0, e) }
}
export interface Pivot { age: number; price: number; label: string }
export interface Structure {
  ok: boolean; n: number; strength: number
  high: number; highAge: number; low: number; lowAge: number         // the window's overall high and low (bar highs/lows) and how many bars ago they printed
  highs: Pivot[]; lows: Pivot[]                                       // every confirmed swing high / low in the window, oldest first, each labelled vs the one before it
  hh: number; lh: number; hl: number; ll: number; eh: number; el: number
  lastHigh: string; lastLow: string                                   // label of the newest swing high / low
  sequence: string                                                    // the swings in time order, e.g. "HL HH HL HH"
  structure: string                                                   // uptrend | downtrend | expanding | contracting | mixed | unclear
  brokeHigh: boolean; brokeLow: boolean                               // the last close is beyond the newest swing high / low
  rocs: number[]                                                      // per-bar % change of the close, oldest first
  rocAvg: number; rocMax: number; rocMaxAge: number; rocMin: number; rocMinAge: number
  rocFirst: number; rocSecond: number; rocAccel: number               // average % per bar in each half, and second minus first (>0 speeding up in the up direction)
  rocUpShare: number
  kinds: string[]; dirs: number[]                                     // the kind and direction of every candle in the window, oldest first
  text: string
}
const NOSTR: Structure = { ok: false, n: 0, strength: 0, high: NaN, highAge: NaN, low: NaN, lowAge: NaN, highs: [], lows: [], hh: 0, lh: 0, hl: 0, ll: 0, eh: 0, el: 0, lastHigh: '', lastLow: '', sequence: '', structure: 'unclear', brokeHigh: false, brokeLow: false, rocs: [], rocAvg: NaN, rocMax: NaN, rocMaxAge: NaN, rocMin: NaN, rocMinAge: NaN, rocFirst: NaN, rocSecond: NaN, rocAccel: NaN, rocUpShare: NaN, kinds: [], dirs: [], text: 'not enough candles for that window' }

/** every swing high/low (fractal of `strength` bars each side) in the last `n` bars ending `ago` bars back, HH/HL/LH/LL labelled, plus the rate-of-change profile and every candle's kind. */
export function readStructure(sAll: StoryBars, nIn: number, ago = 0, strengthIn = 2): Structure {
  const n = Math.round(nIn), strength = Math.max(1, Math.min(10, Math.round(strengthIn)))
  const s = cutBars(sAll, ago)
  const i = s.close.length - 1
  if (!(n >= 3 && n <= 300) || i < n + 16) return { ...NOSTR, n: Number.isFinite(n) ? n : 0, strength }
  const a0 = i - n + 1
  const atr = atr14(s.high, s.low, s.close, a0)
  const tol = (Number.isFinite(atr) ? atr : 0) * 0.05
  let hi = -Infinity, lo = Infinity, hiI = a0, loI = a0
  for (let k = a0; k <= i; k++) { if (s.high[k] >= hi) { hi = s.high[k]; hiI = k } if (s.low[k] <= lo) { lo = s.low[k]; loI = k } }
  const highs: Pivot[] = [], lows: Pivot[] = []
  const seq: { idx: number; label: string }[] = []
  for (let k = a0 + strength; k <= i - strength; k++) {
    let isH = true, isL = true
    for (let d = 1; d <= strength; d++) {
      if (!(s.high[k] > s.high[k - d] && s.high[k] >= s.high[k + d])) isH = false
      if (!(s.low[k] < s.low[k - d] && s.low[k] <= s.low[k + d])) isL = false
    }
    if (isH) { const prev = highs[highs.length - 1]; const label = !prev ? 'H' : s.high[k] > prev.price + tol ? 'HH' : s.high[k] < prev.price - tol ? 'LH' : 'EH'; highs.push({ age: i - k, price: s.high[k], label }); seq.push({ idx: k, label }) }
    if (isL) { const prev = lows[lows.length - 1]; const label = !prev ? 'L' : s.low[k] > prev.price + tol ? 'HL' : s.low[k] < prev.price - tol ? 'LL' : 'EL'; lows.push({ age: i - k, price: s.low[k], label }); seq.push({ idx: k, label }) }
  }
  seq.sort((x, y) => x.idx - y.idx)
  const cnt = (arr: Pivot[], l: string) => arr.filter((p) => p.label === l).length
  const hh = cnt(highs, 'HH'), lh = cnt(highs, 'LH'), eh = cnt(highs, 'EH'), hl = cnt(lows, 'HL'), ll = cnt(lows, 'LL'), el = cnt(lows, 'EL')
  const lastHigh = highs.length ? highs[highs.length - 1].label : '', lastLow = lows.length ? lows[lows.length - 1].label : ''
  const up = (lastHigh === 'HH') && (lastLow === 'HL'), dn = (lastHigh === 'LH') && (lastLow === 'LL')
  const structure = highs.length < 2 || lows.length < 2 ? 'unclear' : up ? 'uptrend' : dn ? 'downtrend' : lastHigh === 'HH' && lastLow === 'LL' ? 'expanding' : lastHigh === 'LH' && lastLow === 'HL' ? 'contracting' : 'mixed'
  const brokeHigh = highs.length > 0 && s.close[i] > highs[highs.length - 1].price
  const brokeLow = lows.length > 0 && s.close[i] < lows[lows.length - 1].price
  // rate of change profile
  const rocs: number[] = []
  for (let k = a0; k <= i; k++) rocs.push(s.close[k - 1] > 0 ? (s.close[k] - s.close[k - 1]) / s.close[k - 1] * 100 : 0)
  let mx = -Infinity, mn = Infinity, mxI = 0, mnI = 0, upN = 0
  rocs.forEach((r, j) => { if (r > mx) { mx = r; mxI = j } if (r < mn) { mn = r; mnI = j } if (r > 0) upN++ })
  const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN
  const half = Math.floor(rocs.length / 2)
  const rocFirst = avg(rocs.slice(0, half)), rocSecond = avg(rocs.slice(half))
  // every candle's own kind
  const kinds: string[] = [], dirs: number[] = []
  for (let k = a0; k <= i; k++) { const st = readStory({ open: s.open.slice(0, k + 1), high: s.high.slice(0, k + 1), low: s.low.slice(0, k + 1), close: s.close.slice(0, k + 1), time: s.time?.slice(0, k + 1) }); kinds.push(st.kind || 'n/a'); dirs.push(st.dir) }
  const sequence = seq.map((x) => x.label).join(' ')
  const parts: string[] = []
  parts.push(`over the last ${n} bars${ago ? ` (ending ${ago} bars ago)` : ''} the high was ${hi.toFixed(5)} (${i - hiI} bars ago) and the low ${lo.toFixed(5)} (${i - loI} bars ago)`)
  parts.push(highs.length + lows.length ? `swings in order: ${sequence}` : 'no confirmed swings yet')
  parts.push(`${hh} higher high${hh === 1 ? '' : 's'}, ${hl} higher low${hl === 1 ? '' : 's'}, ${lh} lower high${lh === 1 ? '' : 's'}, ${ll} lower low${ll === 1 ? '' : 's'}`)
  parts.push(`structure: ${structure}${brokeHigh ? ', and the last close is above the newest swing high' : brokeLow ? ', and the last close is below the newest swing low' : ''}`)
  parts.push(`the fastest bar was ${mx >= 0 ? '+' : ''}${mx.toFixed(3)}% (${rocs.length - 1 - mxI} bars ago), the sharpest drop ${mn.toFixed(3)}% (${rocs.length - 1 - mnI} bars ago); average ${rocFirst >= 0 ? '+' : ''}${rocFirst.toFixed(4)}% per bar in the first half vs ${rocSecond >= 0 ? '+' : ''}${rocSecond.toFixed(4)}% in the second`)
  const text = parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + '; ' + parts.slice(1).join('; ') + '.'
  return { ok: true, n, strength, high: hi, highAge: i - hiI, low: lo, lowAge: i - loI, highs, lows, hh, lh, hl, ll, eh, el, lastHigh, lastLow, sequence, structure, brokeHigh, brokeLow, rocs, rocAvg: avg(rocs), rocMax: mx, rocMaxAge: rocs.length - 1 - mxI, rocMin: mn, rocMinAge: rocs.length - 1 - mnI, rocFirst, rocSecond, rocAccel: rocSecond - rocFirst, rocUpShare: upN / rocs.length, kinds, dirs, text }
}

/** the story of the candle that is STILL FORMING: the closed series plus the forming bar so far. `progress` = share of the candle's time already elapsed (0..1). Everything is "so far" - it can still change. */
export function readFormingStory(closed: StoryBars, bar: { o: number; h: number; l: number; c: number }, openTimeSec: number | undefined, progress: number, five?: StoryBars): Story {
  const s: StoryBars = { open: [...closed.open, bar.o], high: [...closed.high, bar.h], low: [...closed.low, bar.l], close: [...closed.close, bar.c], time: closed.time && openTimeSec !== undefined ? [...closed.time, openTimeSec] : closed.time }
  const pg = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : NaN
  return readStory(s, five, true, Number.isFinite(pg) ? pg : 0)
}
