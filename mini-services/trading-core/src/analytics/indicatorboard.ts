// IQAIR//OS - the FULL indicator board
//
// Per direct instruction: "Do the ai trader have access to all our indicators,
// or it's still only having rsi and atr" - the honest answer was no. The AI
// trader's own kit computed EMA9/21 + RSI14 + ATR14 (plugins/aitrader.ts's own
// import list), and while the desk briefing carried the PANEL verdicts
// (technical ladder, tick desk, SMC, ...), no seat reported the plain
// indicator workup a human chartist runs before every trade: the moving
// averages, the oscillator suite, the volatility bands, the volume flow
// family, the levels. This module is that seat.
//
// ONE pure function walks analytics/indicators.ts - the SAME library the
// strategy learner, the screener and the technical ladder already use - and
// reduces every major indicator to a single comparable line:
//   { family, name, value (formatted, ATR-normalized where unbounded),
//     stance: bullish | bearish | neutral | 'n/a' }
//
// Stance conventions (each threshold documented inline, kept deliberately
// coarse - this board is a VOTE PANEL for cross-checking, not a dial):
//   - direction indicators sign/threshold around 0 or a 0-100 midline;
//   - position indicators (%B, band position, Donchian) report where price
//     sits in the envelope;
//   - pure-information indicators (ATR%, hist-vol, Ulcer, mass index) carry
//     a value and a neutral stance - they describe regime, not direction.
//
// HONESTY CONTRACTS (same discipline as every engine in this OS):
//   - < BOARD_MIN_BARS closed bars -> ok:false "warming up", zero lines -
//     never a fabricated vote off a thin slice.
//   - an indicator whose warmup doesn't fit the slice is stance 'n/a' with
//     its value blank - an absent vote can't distort the bull/bear tally,
//     and the tally only counts REAL stances.
//   - unbounded accumulators (OBV, A/D, force, EOM, klinger, chaikin) are
//     z-scored over a trailing window (ATR-normalization is impossible for
//     them) so their scale is comparable across assets, same convention
//     strategies/custom.ts's volflow family uses.
//   - zero-volume feeds degenerate the volume family to honest 'n/a' lines
//     (a silent zero would read as perfectly balanced flow - a lie).
//
// Pure, O(n) over one pass per indicator, no look-ahead: everything reads
// closed bars only. No kernel imports - analytics stays the pure layer.
import type { Candle } from '../types'
import * as ta from './indicators'

export const BOARD_MIN_BARS = 30
/** trailing z-score window for the unbounded volume accumulators */
const Z_WINDOW = 20
/** minimum |z| for a volume-flow vote (below this the flow is balanced) */
const Z_EPS = 0.5

export type BoardFamily = 'trend' | 'momentum' | 'volatility' | 'volume' | 'levels'
export type BoardStance = 'bullish' | 'bearish' | 'neutral' | 'n/a'

export interface BoardLine {
  family: BoardFamily
  name: string
  /** formatted human value ('n/a' when the warmup didn't fit) */
  value: string
  stance: BoardStance
  /** optional qualifier (e.g. "ADX 28 - trending", "inside the cloud") */
  detail?: string
}

export interface IndicatorBoard {
  ok: boolean
  note: string
  lines: BoardLine[]
  /** how many REAL stances the board counted (n/a excluded), split by side */
  tally: { bull: number; bear: number; neutral: number; counted: number }
}

/** rolling z-score of a raw series over a trailing window (leading NaN-safe,
 * zero-variance safe) - the accumulator indicators' common scale. */
function rollingZ(src: number[], period = Z_WINDOW): number[] {
  const sma = ta.skipLeadingNaN(src, (s) => ta.sma(s, period))
  const sd = ta.skipLeadingNaN(src, (s) => ta.stdDev(s, period))
  return src.map((v, i) => (Number.isFinite(sd[i]) && sd[i] > 1e-12 ? (v - sma[i]) / sd[i] : NaN))
}

function f2(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : 'n/a'
}
function f3(v: number): string {
  return Number.isFinite(v) ? v.toFixed(3) : 'n/a'
}
function f1(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : 'n/a'
}

function line(family: BoardFamily, name: string, value: string, stance: BoardStance, detail?: string): BoardLine {
  return { family, name, value, stance, ...(detail !== undefined ? { detail } : {}) }
}

/** signed vote off an ATR-normalized distance: dead-band around 0, else the
 * sign decides - the same ±0.05..0.3 convention custom.ts's emasign family
 * and the trend-distance reads use. */
function distVote(v: number, eps: number, label: string): BoardLine {
  if (!Number.isFinite(v)) return line('trend', label, 'n/a', 'n/a')
  return line('trend', label, `${v >= 0 ? '+' : ''}${f3(v)} ATR`, v > eps ? 'bullish' : v < -eps ? 'bearish' : 'neutral')
}

/** 0..100 oscillator vote around its midline (RSI/Stoch/MFI/UltOsc family). */
function midVote(family: BoardFamily, name: string, v: number, eps = 5): BoardLine {
  if (!Number.isFinite(v)) return line(family, name, 'n/a', 'n/a')
  return line(family, name, f1(v), v > 50 + eps ? 'bullish' : v < 50 - eps ? 'bearish' : 'neutral')
}

/** signed oscillator vote around 0 (CCI/CMO/TSI/ROC family). */
function zeroVote(family: BoardFamily, name: string, v: number, eps: number, fmt: (v: number) => string = f2): BoardLine {
  if (!Number.isFinite(v)) return line(family, name, 'n/a', 'n/a')
  return line(family, name, `${v >= 0 ? '+' : ''}${fmt(v)}`, v > eps ? 'bullish' : v < -eps ? 'bearish' : 'neutral')
}

function tallyOf(lines: BoardLine[]): IndicatorBoard['tally'] {
  let bull = 0
  let bear = 0
  let neutral = 0
  for (const l of lines) {
    if (l.stance === 'bullish') bull++
    else if (l.stance === 'bearish') bear++
    else if (l.stance === 'neutral') neutral++
  }
  return { bull, bear, neutral, counted: bull + bear + neutral }
}

/** The full indicator workup over CLOSED candles. Returns ok:false with a
 * warming note (and zero lines) on a slice too thin for the shortest
 * warmups - every longer warmup degrades to its own honest 'n/a' line. */
export function buildIndicatorBoard(candles: Candle[]): IndicatorBoard {
  const n = candles.length
  if (n < BOARD_MIN_BARS) {
    return { ok: false, note: `warming up - needs ${BOARD_MIN_BARS}+ closed bars (has ${n})`, lines: [], tally: { bull: 0, bear: 0, neutral: 0, counted: 0 } }
  }
  const close = candles.map((k) => k.close)
  const high = candles.map((k) => k.high)
  const low = candles.map((k) => k.low)
  const open = candles.map((k) => k.open)
  const volume = candles.map((k) => k.volume ?? 0)
  const atr14 = ta.atr(high, low, close, 14)
  const atrLast = atr14[n - 1]
  const price = close[n - 1]
  const hasVolume = volume.some((v) => v > 0)
  // ATR-normalizer for unbounded price-scale indicators; n/a past ATR warmup
  const an = (arr: number[], i = n - 1): number => (atr14[i] > 1e-12 ? arr[i] / atr14[i] : NaN)
  const lines: BoardLine[] = []

  // ---------- TREND ----------
  const ema9 = ta.ema(close, 9)
  const ema21 = ta.ema(close, 21)
  lines.push(distVote(an(ema9.map((v, i) => v - ema21[i])), 0.05, 'EMA9 vs EMA21'))
  const sma20 = ta.sma(close, 20)
  lines.push(distVote(an(sma20.map((v, i) => close[i] - v)), 0.1, 'close vs SMA20'))
  const sma50 = ta.sma(close, 50)
  lines.push(distVote(an(sma50.map((v, i) => close[i] - v)), 0.2, 'close vs SMA50'))
  if (n >= 210) {
    const sma200 = ta.sma(close, 200)
    lines.push(distVote(an(sma200.map((v, i) => close[i] - v)), 0.3, 'close vs SMA200'))
  } else {
    lines.push(line('trend', 'close vs SMA200', 'n/a', 'n/a', `needs 210 bars, has ${n}`))
  }
  const hma9 = ta.hma(close, 9)
  lines.push(distVote(an(hma9.map((v, i) => close[i] - v)), 0.05, 'close vs HMA9'))
  const st = ta.supertrend(high, low, close, 10, 3)
  const stLine = st.line[n - 1]
  const stDir = st.dir[n - 1]
  lines.push(
    Number.isFinite(stLine)
      ? line('trend', 'Supertrend(10,3)', stDir > 0 ? 'up' : 'down', stDir > 0 ? 'bullish' : 'bearish', `line ${f3(stLine)}`)
      : line('trend', 'Supertrend(10,3)', 'n/a', 'n/a'),
  )
  const sar = ta.parabolicSar(high, low)
  lines.push(distVote(Number.isFinite(sar[n - 1]) && atrLast > 0 ? (price - sar[n - 1]) / atrLast : NaN, 0, 'close vs PSAR'))
  const ich = ta.ichimoku(high, low)
  const a = ich.senkouA[n - 1]
  const b = ich.senkouB[n - 1]
  if (Number.isFinite(a) && Number.isFinite(b) && atrLast > 1e-12) {
    const top = Math.max(a, b)
    const bot = Math.min(a, b)
    const cloudPos = price > top ? 'above the cloud' : price < bot ? 'below the cloud' : 'inside the cloud'
    lines.push(line('trend', 'Ichimoku cloud', cloudPos, price > top ? 'bullish' : price < bot ? 'bearish' : 'neutral'))
  } else {
    lines.push(line('trend', 'Ichimoku cloud', 'n/a', 'n/a', 'needs ~60+ bars for Senkou B'))
  }
  const adx = ta.adx(high, low, close, 14)
  const adxV = adx.adx[n - 1]
  const diDiff = adx.plusDI[n - 1] - adx.minusDI[n - 1]
  lines.push(
    Number.isFinite(diDiff)
      ? line('trend', 'ADX(14) + DI spread', `ADX ${f1(adxV)}, DI spread ${diDiff >= 0 ? '+' : ''}${f1(diDiff)}`, diDiff > 5 ? 'bullish' : diDiff < -5 ? 'bearish' : 'neutral', Number.isFinite(adxV) ? (adxV >= 25 ? 'ADX >= 25 - trending regime' : adxV < 20 ? 'ADX < 20 - chop regime' : 'ADX mid - regime unclear') : undefined)
      : line('trend', 'ADX(14) + DI spread', 'n/a', 'n/a'),
  )

  // ---------- MOMENTUM ----------
  const rsi14 = ta.rsi(close, 14)
  lines.push(midVote('momentum', 'RSI(14)', rsi14[n - 1]))
  const stoch14 = ta.stochastic(high, low, close, 14)
  lines.push(midVote('momentum', 'Stochastic %K(14)', stoch14.k[n - 1]))
  const srsi = ta.stochRsi(close, 14, 14)
  lines.push(midVote('momentum', 'Stoch RSI %K', srsi.k[n - 1]))
  const cci20 = ta.cci(high, low, close, 20)
  lines.push(zeroVote('momentum', 'CCI(20)', cci20[n - 1], 25, f1))
  const willr = ta.williamsR(high, low, close, 14)
  lines.push(midVote('momentum', 'Williams %R(14)', willr[n - 1] + 100))
  const roc12 = ta.roc(close, 12)
  lines.push(zeroVote('momentum', 'ROC(12) %', roc12[n - 1], 0.02, (v) => `${f3(v)}%`))
  const mom10 = ta.mom(close, 10)
  lines.push(zeroVote('momentum', 'Momentum(10) ATR', an(mom10), 0.1, f2))
  const cmo14 = ta.cmo(close, 14)
  lines.push(zeroVote('momentum', 'CMO(14)', cmo14[n - 1], 25, f1))
  const tsi13 = ta.tsi(close)
  lines.push(zeroVote('momentum', 'TSI(25,13)', tsi13.tsi[n - 1], 10, f1))
  const ppo12 = ta.ppo(close)
  lines.push(zeroVote('momentum', 'PPO hist(12,26,9)', ppo12.hist[n - 1], 0.02, (v) => `${v >= 0 ? '+' : ''}${f3(v)}%`))
  const macd12 = ta.macd(close)
  lines.push(zeroVote('momentum', 'MACD hist ATR', an(macd12.hist), 0.05, f2))
  const ao = ta.awesomeOsc(high, low)
  lines.push(zeroVote('momentum', 'Awesome Osc ATR', an(ao), 0.1, f2))
  const fish = ta.fisherTransform(high, low, 9)
  lines.push(
    Number.isFinite(fish.fisher[n - 1]) && Number.isFinite(fish.trigger[n - 1])
      ? line('momentum', 'Fisher(9)', `${f2(fish.fisher[n - 1])} vs trig ${f2(fish.trigger[n - 1])}`, fish.fisher[n - 1] > fish.trigger[n - 1] ? 'bullish' : fish.fisher[n - 1] < fish.trigger[n - 1] ? 'bearish' : 'neutral')
      : line('momentum', 'Fisher(9)', 'n/a', 'n/a'),
  )
  const ult = ta.ultimateOsc(high, low, close)
  lines.push(midVote('momentum', 'Ultimate Osc(7/14/28)', ult[n - 1]))
  const dpo20 = ta.dpo(close, 20)
  lines.push(zeroVote('momentum', 'DPO(20) ATR', an(dpo20), 0.1, f2))
  const trix15 = ta.trix(close, 15)
  lines.push(
    Number.isFinite(trix15.trix[n - 1]) && Number.isFinite(trix15.signal[n - 1])
      ? line('momentum', 'TRIX(15)', `${f2(trix15.trix[n - 1])} vs sig ${f2(trix15.signal[n - 1])}`, trix15.trix[n - 1] > trix15.signal[n - 1] ? 'bullish' : trix15.trix[n - 1] < trix15.signal[n - 1] ? 'bearish' : 'neutral')
      : line('momentum', 'TRIX(15)', 'n/a', 'n/a'),
  )

  // ---------- VOLATILITY (mostly informational - regime, not direction) ----------
  const atrPct = price > 0 && atrLast > 0 ? (atrLast / price) * 100 : NaN
  lines.push(line('volatility', 'ATR(14) % of price', `${f3(atrPct)}%`, 'neutral', 'per-bar range - the noise budget'))
  const bb = ta.bollinger(close, 20, 2)
  const pctB = bb.percentB[n - 1]
  const bbw = bb.width[n - 1]
  lines.push(
    Number.isFinite(pctB)
      ? line('volatility', 'Bollinger %B(20,2)', f2(pctB), pctB > 0.5 ? 'bullish' : pctB < 0.5 ? 'bearish' : 'neutral', 'price position inside the bands (0=lower, 1=upper)')
      : line('volatility', 'Bollinger %B(20,2)', 'n/a', 'n/a'),
  )
  lines.push(line('volatility', 'BB width (20,2)', `${f3(bbw)} (${price > 0 ? `${f3((bbw / price) * 100)}% of price` : 'n/a'})`, 'neutral', 'band width - squeeze vs expansion'))
  const kel = ta.keltner(high, low, close, 20, 2)
  const kelW = kel.upper[n - 1] - kel.lower[n - 1]
  lines.push(
    Number.isFinite(kelW) && kelW > 1e-12
      ? line('volatility', 'Keltner position(20,2)', f2((price - kel.lower[n - 1]) / kelW), price > kel.mid[n - 1] ? 'bullish' : 'bearish', 'price position inside the channel')
      : line('volatility', 'Keltner position(20,2)', 'n/a', 'n/a'),
  )
  const don = ta.donchian(high, low, 20)
  const donW = don.upper[n - 1] - don.lower[n - 1]
  if (Number.isFinite(donW) && donW > 1e-12) {
    const pos = (price - don.lower[n - 1]) / donW
    lines.push(line('volatility', 'Donchian(20) position', f2(pos), pos > 0.8 ? 'bullish' : pos < 0.2 ? 'bearish' : 'neutral', pos > 0.8 ? 'pressing the 20-bar high' : pos < 0.2 ? 'pressing the 20-bar low' : 'mid-range'))
  } else {
    lines.push(line('volatility', 'Donchian(20) position', 'n/a', 'n/a'))
  }
  const hv = ta.histVol(close, 20)
  lines.push(line('volatility', 'Hist volatility(20)', Number.isFinite(hv[n - 1]) ? `${f1(hv[n - 1] * 100)}% ann.` : 'n/a', 'neutral'))
  const mass = ta.massIndex(high, low)
  lines.push(line('volatility', 'Mass Index(9)', f1(mass[n - 1]), 'neutral', mass[n - 1] > 26.5 ? '> 26.5 - trend-change bulge possible' : undefined))
  const ulcer = ta.ulcerIndex(close, 14)
  lines.push(line('volatility', 'Ulcer Index(14)', f2(ulcer[n - 1]), 'neutral', 'downside-depth gauge'))

  // ---------- VOLUME FLOW (all honest n/a on a zero-volume feed) ----------
  if (hasVolume) {
    const obvZ = rollingZ(ta.obv(close, volume))
    lines.push(zeroVote('volume', 'OBV z(20)', obvZ[n - 1], Z_EPS))
    const adZ = rollingZ(ta.adl(high, low, close, volume))
    lines.push(zeroVote('volume', 'A/D line z(20)', adZ[n - 1], Z_EPS))
    const cmf20 = ta.cmf(high, low, close, volume, 20)
    lines.push(zeroVote('volume', 'CMF(20)', cmf20[n - 1], 0.05, f3))
    const mfi14 = ta.mfi(high, low, close, volume, 14)
    lines.push(midVote('volume', 'MFI(14)', mfi14[n - 1]))
    const frcZ = rollingZ(ta.forceIndex(close, volume, 13))
    lines.push(zeroVote('volume', 'Force Index(13) z', frcZ[n - 1], Z_EPS))
    const eomZ = rollingZ(ta.eom(high, low, volume, 14))
    lines.push(zeroVote('volume', 'EOM(14) z', eomZ[n - 1], Z_EPS))
    const kl = ta.klinger(high, low, close, volume)
    lines.push(
      Number.isFinite(kl.vf[n - 1]) && Number.isFinite(kl.signal[n - 1])
        ? line('volume', 'Klinger VF', `${f2(kl.vf[n - 1])} vs sig ${f2(kl.signal[n - 1])}`, kl.vf[n - 1] > kl.signal[n - 1] ? 'bullish' : kl.vf[n - 1] < kl.signal[n - 1] ? 'bearish' : 'neutral')
        : line('volume', 'Klinger VF', 'n/a', 'n/a'),
    )
    const chkZ = rollingZ(ta.chaikinOsc(high, low, close, volume))
    lines.push(zeroVote('volume', 'Chaikin Osc z', chkZ[n - 1], Z_EPS))
    const vw = ta.vwap(candles)
    lines.push(distVote(an(vw.map((v, i) => close[i] - v)), 0.1, 'close vs session VWAP'))
  } else {
    for (const nm of ['OBV z(20)', 'A/D line z(20)', 'CMF(20)', 'MFI(14)', 'Force Index(13) z', 'EOM(14) z', 'Klinger VF', 'Chaikin Osc z', 'close vs session VWAP']) {
      lines.push(line('volume', nm, 'n/a', 'n/a', 'feed carries no volume'))
    }
  }

  // ---------- LEVELS ----------
  const piv = ta.pivotPoints(candles.slice(0, n))
  const pivLevels = [piv.pp, piv.r1, piv.r2, piv.r3, piv.s1, piv.s2, piv.s3].filter((v) => Number.isFinite(v))
  if (pivLevels.length && atrLast > 1e-12) {
    let nearest = pivLevels[0]
    let best = Infinity
    for (const lv of pivLevels) {
      const d = Math.abs(price - lv)
      if (d < best) {
        best = d
        nearest = lv
      }
    }
    const dist = (price - nearest) / atrLast
    lines.push(line('levels', 'Nearest pivot dist', `${dist >= 0 ? '+' : ''}${f3(dist)} ATR`, Math.abs(dist) < 0.2 ? 'neutral' : dist > 0 ? 'bullish' : 'bearish', 'sitting ON the level = decision point'))
  } else {
    lines.push(line('levels', 'Nearest pivot dist', 'n/a', 'n/a'))
  }
  const fib = ta.fibLevels(candles.slice(0, n), 60)
  const fibLevels = fib.map((l) => l.price).filter((v) => Number.isFinite(v))
  if (fibLevels.length && atrLast > 1e-12) {
    let nearest = fibLevels[0]
    let best = Infinity
    for (const lv of fibLevels) {
      const d = Math.abs(price - lv)
      if (d < best) {
        best = d
        nearest = lv
      }
    }
    const dist = (price - nearest) / atrLast
    lines.push(line('levels', 'Nearest fib dist', `${dist >= 0 ? '+' : ''}${f3(dist)} ATR`, Math.abs(dist) < 0.2 ? 'neutral' : dist > 0 ? 'bullish' : 'bearish', 'within 0.2 ATR = at the retracement'))
  } else {
    lines.push(line('levels', 'Nearest fib dist', 'n/a', 'n/a'))
  }

  return { ok: true, note: `${lines.length} indicators reported`, lines, tally: tallyOf(lines) }
}

const STANCE_MARK: Record<BoardStance, string> = { bullish: 'BULL', bearish: 'BEAR', neutral: '=', 'n/a': 'n/a' }

/** The desk-briefing rendering: one line per family, every indicator
 * "name value [STANCE]" - compact enough for a prompt, complete enough that
 * "does the trader see ALL our indicators" is answered YES. The tally header
 * leads with the vote count so the model reads the balance first. */
export function indicatorBoardLines(candles: Candle[]): string[] {
  const board = buildIndicatorBoard(candles)
  if (!board.ok) return [`indicator board: ${board.note}`]
  const order: BoardFamily[] = ['trend', 'momentum', 'volatility', 'volume', 'levels']
  const out: string[] = [
    `vote tally: ${board.tally.counted} counted -> ${board.tally.bull} bull / ${board.tally.bear} bear / ${board.tally.neutral} neutral (n/a warmups excluded - an absent vote is not a quiet vote)`,
  ]
  for (const fam of order) {
    const famLines = board.lines.filter((l) => l.family === fam)
    if (!famLines.length) continue
    const body = famLines.map((l) => `${l.name} ${l.value} [${STANCE_MARK[l.stance]}]${l.detail && l.family === 'trend' ? ` (${l.detail})` : ''}`).join(' · ')
    out.push(`${fam}: ${body}`)
  }
  return out
}
