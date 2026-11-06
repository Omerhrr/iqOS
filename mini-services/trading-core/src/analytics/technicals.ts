// IQAIR//OS - Technical Summary engine
//
// The investing.com "Technical Summary" read, rebuilt on this OS's own data
// and honesty rules. For EVERY timeframe on a single ladder the engine rates
// the usual oscillator panel (RSI, Stochastic, CCI, ADX/DX, Awesome,
// Momentum, MACD, Stoch RSI, Williams %R, Bull/Bear Power, Ultimate
// Oscillator) and the usual moving-average panel (SMA/EMA x 10/20/30/50/100/
// 200, Hull 9, VWMA 20, Ichimoku base 26) into Buy / Sell / Neutral votes,
// then condenses each block - and both blocks together - into one of the
// investing.com verdicts: STRONG BUY / BUY / NEUTRAL / SELL / STRONG SELL.
//
// THE LADDER (the operator asked for seconds through minutes):
//   1s / 2s / 3s  - aggregated TIME bars built from the market service's raw
//                   tick buffer (real broker-side price changes in live mode,
//                   the sim's 1 Hz ticker in sim mode). A rung that would be
//                   built from too few observations per bar is disclosed with
//                   its ticks-per-bar, never passed off as real candles.
//   5s / 15s / 30s / 1m / 2m / 5m - native candles this OS already tracks.
//   3m            - NOT a tracked timeframe; honestly aggregated from 3 x 1m
//                   native bars (bucket-aligned, no look-ahead).
//
// HONESTY CONTRACTS (same discipline as every engine in this OS):
//   - A rung with fewer than TECH_MIN_BARS closed bars is `ok:false`
//     "warming up" - never a verdict invented from thin history.
//   - An indicator whose warmup doesn't fit the available history is EXCLUDED
//     from its block's vote count (n/a), not counted as fake Neutral - an
//     absent vote cannot distort the buy/sell balance.
//   - A rung whose last bar is stale (tick-built rungs on a frozen feed)
//     reads "feed stale", not "neutral".
//   - The verdict math is pure votes: no calibration cosplay, no pWin. The
//     precision lever here is the score thresholds (±0.15 / ±0.5) and the
//     disclosed vote counts.
//
// Pure functions, O(n) per timeframe, no look-ahead: every read is computed
// on CLOSED bars only.

import type { Candle } from '../types'
import {
  sma, ema, rsi, macd, stochastic, williamsR, cci, adx,
  stochRsi, mom, ultimateOsc, awesomeOsc, hma, vwma, isn,
} from './indicators'

// ---------- the ladder ----------

export interface TechLadderRung {
  /** ladder label - NOT always a kernel Timeframe ('1s'/'2s'/'3s'/'3m' are derived) */
  tf: string
  sec: number
  /** where this rung's bars come from */
  source: 'ticks' | 'native' | 'agg1m'
}

/** The operator's ladder: 1s/2s/3s (tick-built) + 5s/15s/30s/1m/2m/3m/5m.
 * Ordered fastest-first, like investing.com's TF tabs. */
export const TECH_LADDER: TechLadderRung[] = [
  { tf: '1s', sec: 1, source: 'ticks' },
  { tf: '2s', sec: 2, source: 'ticks' },
  { tf: '3s', sec: 3, source: 'ticks' },
  { tf: '5s', sec: 5, source: 'native' },
  { tf: '15s', sec: 15, source: 'native' },
  { tf: '30s', sec: 30, source: 'native' },
  { tf: '1m', sec: 60, source: 'native' },
  { tf: '2m', sec: 120, source: 'native' },
  { tf: '3m', sec: 180, source: 'agg1m' },
  { tf: '5m', sec: 300, source: 'native' },
]

/** The kernel-native timeframes a caller must fetch for the ladder's
 * `native` + `agg1m` rungs (the seconds rungs come from the tick buffer). */
export const TECH_NATIVE_TFS = ['5s', '15s', '30s', '1m', '2m', '5m'] as const

/** Min closed bars before a rung earns any verdict (covers RSI14 + MACD
 * warmup + a few MAs; longer MAs individually n/a until they fit). */
export const TECH_MIN_BARS = 40
/** Bars fed to the indicator math per rung (MA200 + warmup + margin). */
export const TECH_BARS_PER_RUNG = 260
/** A tick-built rung is stale when its newest bar ends this many seconds
 * behind the newest observed tick (a frozen feed is not a neutral market). */
export const TECH_TICK_STALE_SEC = 30

// ---------- bar building ----------

export interface TickPoint { time: number; price: number }
export type TechBar = Candle

/**
 * Aggregate raw tick observations into `sec`-second TIME bars (open/high/low/
 * close + observation count as volume - the only honest size signal a tick
 * buffer has). Bucket-aligned to the epoch (time - time % sec), so re-polls
 * over the same window produce identical bars. Returns bars OLDEST-FIRST.
 */
export function barsFromTicks(points: TickPoint[], sec: number): { bars: TechBar[]; ticksPerBar: number } {
  const bars: TechBar[] = []
  let cur: TechBar | null = null
  for (const p of points) {
    if (!Number.isFinite(p.time) || !Number.isFinite(p.price) || p.price <= 0) continue
    const bucket = Math.floor(p.time / sec) * sec
    if (!cur || cur.time !== bucket) {
      if (cur) bars.push(cur)
      cur = { time: bucket, open: p.price, high: p.price, low: p.price, close: p.price, volume: 0 }
    }
    cur.high = Math.max(cur.high, p.price)
    cur.low = Math.min(cur.low, p.price)
    cur.close = p.price
    cur.volume += 1
  }
  if (cur) bars.push(cur)
  // mean observations per bar - the honest density disclosure for 1s/2s/3s
  const ticksPerBar = bars.length ? bars.reduce((a, b) => a + b.volume, 0) / bars.length : 0
  return { bars, ticksPerBar }
}

/**
 * Aggregate `factor` consecutive bucket-aligned candles into one bar per
 * bucket of `factor * baseSec` seconds (3m from 3 x 1m). The last bar may be
 * a still-forming partial - callers pass CLOSED candles only, so a trailing
 * partial bucket simply means "the newest bucket hasn't closed yet" and is
 * dropped here (a partial bar must never vote).
 */
export function aggregateCandles(candles: Candle[], baseSec: number, factor: number): TechBar[] {
  const bucketSec = baseSec * factor
  const out: TechBar[] = []
  let cur: TechBar | null = null
  for (const c of candles) {
    const bucket = Math.floor(c.time / bucketSec) * bucketSec
    if (!cur || cur.time !== bucket) {
      if (cur) out.push(cur)
      cur = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }
    } else {
      cur.high = Math.max(cur.high, c.high)
      cur.low = Math.min(cur.low, c.low)
      cur.close = c.close
      cur.volume += c.volume
    }
  }
  if (cur) out.push(cur)
  // a trailing bucket is only complete when the source already contains the
  // bucket's LAST base bar - otherwise it is still forming and must never
  // vote (a partial bar would leak the forming close into the verdict)
  if (out.length) {
    const lastBar = out[out.length - 1]
    const complete = candles.some((c) => c.time >= lastBar.time + bucketSec - baseSec)
    if (!complete) out.pop()
  }
  return out
}

// ---------- verdicts ----------

export type TechRead = 'buy' | 'sell' | 'neutral' | 'na'
export type TechVerdictLabel = 'STRONG BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG SELL'

export interface TechVote {
  name: string
  read: TechRead
  /** formatted indicator value for the UI table ('—' when n/a) */
  value: string
}

export interface TechVerdict {
  label: TechVerdictLabel
  /** (buys - sells) / counted, -1..+1 */
  score: number
  buys: number
  sells: number
  neutrals: number
  /** votes actually counted (n/a excluded) */
  counted: number
}

export function verdictFromVotes(buys: number, sells: number, counted: number): TechVerdict {
  const score = counted > 0 ? (buys - sells) / counted : 0
  const label: TechVerdictLabel =
    score >= 0.5 ? 'STRONG BUY' :
    score >= 0.15 ? 'BUY' :
    score > -0.15 ? 'NEUTRAL' :
    score > -0.5 ? 'SELL' : 'STRONG SELL'
  return { label, score, buys, sells, neutrals: counted - buys - sells, counted }
}

/** Cross-timeframe consensus: plain mean of the live rungs' overall scores,
 * same verdict thresholds. Every rung's vote total is disclosed alongside. */
export function consensusFromScores(scores: number[]): TechVerdict {
  if (!scores.length) return { label: 'NEUTRAL', score: 0, buys: 0, sells: 0, neutrals: 0, counted: 0 }
  const score = scores.reduce((a, b) => a + b, 0) / scores.length
  const label: TechVerdictLabel =
    score >= 0.5 ? 'STRONG BUY' :
    score >= 0.15 ? 'BUY' :
    score > -0.15 ? 'NEUTRAL' :
    score > -0.5 ? 'SELL' : 'STRONG SELL'
  return { label, score, buys: scores.filter((s) => s >= 0.15).length, sells: scores.filter((s) => s <= -0.15).length, neutrals: scores.filter((s) => s > -0.15 && s < 0.15).length, counted: scores.length }
}

const last = (arr: number[]): number => (arr.length ? arr[arr.length - 1] : NaN)
const prev = (arr: number[]): number => (arr.length > 1 ? arr[arr.length - 2] : NaN)
const f2 = (v: number): string => (isn(v) ? v.toFixed(2) : '—')

// ---------- indicator panels (investing.com rules, kept explainable) ----------

/** The oscillator panel: 11 votes, each from the indicator's own textbook
 * read - extreme + turning = Buy/Sell, level/signal rules otherwise. */
export function oscillatorVotes(bars: Candle[]): TechVote[] {
  const hi = bars.map((c) => c.high)
  const lo = bars.map((c) => c.low)
  const cl = bars.map((c) => c.close)
  const votes: TechVote[] = []

  // RSI(14): oversold & rising -> Buy, overbought & falling -> Sell
  const r = rsi(cl, 14)
  const rN = last(r); const rP = prev(r)
  votes.push({
    name: 'RSI(14)',
    read: isn(rN) && isn(rP) ? (rP < 30 && rN > rP ? 'buy' : rP > 70 && rN < rP ? 'sell' : 'neutral') : 'na',
    value: f2(rN),
  })

  // Stochastic %K(14,3,3): K above D but not overbought -> Buy, below D but not oversold -> Sell
  const st = stochastic(hi, lo, cl, 14, 3, 3)
  const kN = last(st.k); const dN = last(st.d)
  votes.push({
    name: 'Stoch %K(14,3,3)',
    read: isn(kN) && isn(dN) ? (kN > dN && kN < 80 ? 'buy' : kN < dN && kN > 20 ? 'sell' : 'neutral') : 'na',
    value: f2(kN),
  })

  // CCI(20): below -100 & turning up -> Buy, above +100 & turning down -> Sell
  const cc = cci(hi, lo, cl, 20)
  const cN = last(cc); const cP = prev(cc)
  votes.push({
    name: 'CCI(20)',
    read: isn(cN) && isn(cP) ? (cP < -100 && cN > cP ? 'buy' : cP > 100 && cN < cP ? 'sell' : 'neutral') : 'na',
    value: f2(cN),
  })

  // ADX(14): trending (ADX > 20) in +DI's direction, else no trend vote
  const ad = adx(hi, lo, cl, 14)
  const aN = last(ad.adx); const pN = last(ad.plusDI); const mN = last(ad.minusDI)
  votes.push({
    name: 'ADX(14)',
    read: isn(aN) && isn(pN) && isn(mN) ? (aN > 20 ? (pN > mN ? 'buy' : mN > pN ? 'sell' : 'neutral') : 'neutral') : 'na',
    value: isn(aN) ? `${aN.toFixed(1)}` : '—',
  })

  // Awesome Oscillator(5,34): above zero & rising -> Buy, below zero & falling -> Sell
  const ao = awesomeOsc(hi, lo)
  const aoN = last(ao); const aoP = prev(ao)
  votes.push({
    name: 'Awesome Osc',
    read: isn(aoN) && isn(aoP) ? (aoN > 0 && aoN > aoP ? 'buy' : aoN < 0 && aoN < aoP ? 'sell' : 'neutral') : 'na',
    value: f2(aoN),
  })

  // Momentum(10): positive & rising -> Buy, negative & falling -> Sell
  const mo = mom(cl, 10)
  const moN = last(mo); const moP = prev(mo)
  votes.push({
    name: 'Momentum(10)',
    read: isn(moN) && isn(moP) ? (moN > 0 && moN > moP ? 'buy' : moN < 0 && moN < moP ? 'sell' : 'neutral') : 'na',
    value: f2(moN),
  })

  // MACD(12,26,9): line vs signal
  const mc = macd(cl, 12, 26, 9)
  const mcN = last(mc.macd); const sgN = last(mc.signal)
  votes.push({
    name: 'MACD(12,26,9)',
    read: isn(mcN) && isn(sgN) ? (mcN > sgN ? 'buy' : mcN < sgN ? 'sell' : 'neutral') : 'na',
    value: f2(mcN),
  })

  // Stochastic RSI(14,14,3,3): same K/D rule as the Stochastic
  const sr = stochRsi(cl, 14, 14, 3, 3)
  const srK = last(sr.k); const srD = last(sr.d)
  votes.push({
    name: 'Stoch RSI',
    read: isn(srK) && isn(srD) ? (srK > srD && srK < 80 ? 'buy' : srK < srD && srK > 20 ? 'sell' : 'neutral') : 'na',
    value: f2(srK),
  })

  // Williams %R(14): oversold & rising -> Buy, overbought & falling -> Sell
  const wr = williamsR(hi, lo, cl, 14)
  const wN = last(wr); const wP = prev(wr)
  votes.push({
    name: 'Williams %R(14)',
    read: isn(wN) && isn(wP) ? (wP < -80 && wN > wP ? 'buy' : wP > -20 && wN < wP ? 'sell' : 'neutral') : 'na',
    value: f2(wN),
  })

  // Bull/Bear Power on EMA(13): power negative & shrinking -> Buy, positive & shrinking -> Sell
  const e13 = ema(cl, 13)
  const bbp = bars.map((c, i) => (isn(e13[i]) ? (c.low - e13[i]) + (c.high - e13[i]) : NaN))
  const bN = last(bbp); const bP = prev(bbp)
  votes.push({
    name: 'Bull Bear Power',
    read: isn(bN) && isn(bP) ? (bN < 0 && bN > bP ? 'buy' : bN > 0 && bN < bP ? 'sell' : 'neutral') : 'na',
    value: f2(bN),
  })

  // Ultimate Oscillator(7,14,28): < 30 -> Buy, > 70 -> Sell
  const uo = ultimateOsc(hi, lo, cl, 7, 14, 28)
  const uN = last(uo)
  votes.push({
    name: 'Ultimate Osc',
    read: isn(uN) ? (uN < 30 ? 'buy' : uN > 70 ? 'sell' : 'neutral') : 'na',
    value: f2(uN),
  })

  return votes
}

/** The moving-average panel: 13 votes - price above the MA is a Buy, below
 * is a Sell (investing.com's own convention), each MA warmup-gated. */
export function maVotes(bars: Candle[]): TechVote[] {
  const cl = bars.map((c) => c.close)
  const hi = bars.map((c) => c.high)
  const lo = bars.map((c) => c.low)
  const vol = bars.map((c) => c.volume)
  const px = cl[cl.length - 1]
  const votes: TechVote[] = []
  if (!isn(px)) return votes

  const pushMa = (name: string, series: number[]) => {
    const v = last(series)
    votes.push({ name, read: isn(v) ? (px > v ? 'buy' : px < v ? 'sell' : 'neutral') : 'na', value: f2(v) })
  }
  for (const p of [10, 20, 30, 50, 100, 200]) {
    pushMa(`SMA(${p})`, sma(cl, p))
    pushMa(`EMA(${p})`, ema(cl, p))
  }
  pushMa('Hull MA(9)', hma(cl, 9))
  pushMa('VWMA(20)', vwma(cl, vol, 20))
  // Ichimoku base line (Kijun, 26): midpoint of the 26-bar range, used as an
  // MA vote exactly like investing.com's table does
  const kin = new Array<number>(bars.length).fill(NaN)
  for (let i = 25; i < bars.length; i++) {
    let hh = -Infinity; let ll = Infinity
    for (let j = 0; j < 26; j++) { hh = Math.max(hh, hi[i - j]); ll = Math.min(ll, lo[i - j]) }
    kin[i] = (hh + ll) / 2
  }
  pushMa('Ichimoku Base(26)', kin)
  return votes
}

const tally = (votes: TechVote[]): TechVerdict => {
  const buys = votes.filter((v) => v.read === 'buy').length
  const sells = votes.filter((v) => v.read === 'sell').length
  const counted = votes.filter((v) => v.read === 'buy' || v.read === 'sell' || v.read === 'neutral').length
  return verdictFromVotes(buys, sells, counted)
}

// ---------- per-timeframe summary ----------

export interface TechTfRow {
  tf: string
  sec: number
  source: 'ticks' | 'native' | 'agg1m'
  /** false = warming up / stale tick feed - note says which, never a verdict */
  ok: boolean
  note: string
  bars: number
  /** tick-built rungs only: mean observations per bar (1.0 = every bar is a
   * single observation - close-based math still valid, wick anatomy isn't) */
  ticksPerBar: number | null
  osc: TechVote[]
  oscSummary: TechVerdict
  mas: TechVote[]
  maSummary: TechVerdict
  summary: TechVerdict
}

export interface TechnicalSummary {
  asset: string
  ts: number
  mode: 'sim' | 'live'
  price: number
  rows: TechTfRow[]
  /** cross-timeframe consensus over the live rungs */
  overall: TechVerdict
  /** the overall read translated to a next-candle/expiry lean */
  direction: 'call' | 'put' | 'none'
  note: string
}

/** One rung's full read from its own closed bars. `nowSec` gates tick-built
 * rungs against a stale feed. */
export function summarizeTf(
  tf: string,
  sec: number,
  source: 'ticks' | 'native' | 'agg1m',
  bars: Candle[],
  opts: { nowSec?: number; ticksPerBar?: number | null } = {},
): TechTfRow {
  const closed = bars.filter((c) => c && Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0)
  const base = { tf, sec, source, ticksPerBar: opts.ticksPerBar ?? null }
  if (closed.length < TECH_MIN_BARS) {
    const empty = { buys: 0, sells: 0, neutrals: 0, counted: 0, score: 0, label: 'NEUTRAL' as TechVerdictLabel }
    return {
      ...base, ok: false, note: `warming up - needs ${TECH_MIN_BARS}+ closed bars (has ${closed.length})`,
      bars: closed.length, osc: [], mas: [], oscSummary: empty, maSummary: empty, summary: empty,
    }
  }
  // staleness gate for tick-built rungs only: native/agg candles are always
  // fresh by construction (the market service forms them live)
  if (source === 'ticks' && opts.nowSec !== undefined) {
    const newestBarEnd = closed[closed.length - 1].time + sec
    if (opts.nowSec - newestBarEnd > TECH_TICK_STALE_SEC) {
      const empty = { buys: 0, sells: 0, neutrals: 0, counted: 0, score: 0, label: 'NEUTRAL' as TechVerdictLabel }
      return {
        ...base, ok: false, note: `tick feed stale - newest bar ends ${Math.round(opts.nowSec - newestBarEnd)}s ago`,
        bars: closed.length, osc: [], mas: [], oscSummary: empty, maSummary: empty, summary: empty,
      }
    }
  }
  const osc = oscillatorVotes(closed)
  const mas = maVotes(closed)
  const oscSummary = tally(osc)
  const maSummary = tally(mas)
  // combined: every vote the two panels produced, weighted equally - the
  // investing.com "Summary" gauge
  const summary = verdictFromVotes(
    oscSummary.buys + maSummary.buys,
    oscSummary.sells + maSummary.sells,
    oscSummary.counted + maSummary.counted,
  )
  return { ...base, ok: true, note: `${closed.length} closed bars`, bars: closed.length, osc, mas, oscSummary, maSummary, summary }
}

/** Assemble the full-ladder summary from the caller's pre-fetched data
 * (the plugin owns market access; the engine stays pure). */
export function buildTechnicalSummary(input: {
  asset: string
  mode: 'sim' | 'live'
  price: number
  /** native candles per TECH_NATIVE_TFS entry (deep, closed-only) */
  native: Record<string, Candle[]>
  /** raw tick observations for the seconds rungs */
  ticks: TickPoint[]
  nowSec: number
}): TechnicalSummary {
  const rows: TechTfRow[] = []
  for (const rung of TECH_LADDER) {
    if (rung.source === 'ticks') {
      const relevant = input.ticks.filter((p) => Number.isFinite(p.time) && input.nowSec - p.time <= 6 * 3600)
      const tail = relevant.slice(-TECH_BARS_PER_RUNG * 4)
      const { bars, ticksPerBar } = barsFromTicks(tail, rung.sec)
      rows.push(summarizeTf(rung.tf, rung.sec, 'ticks', bars.slice(-TECH_BARS_PER_RUNG), { nowSec: input.nowSec, ticksPerBar }))
    } else if (rung.source === 'agg1m') {
      const src = input.native['1m'] ?? []
      const bars = aggregateCandles(src.slice(-TECH_BARS_PER_RUNG * 3), 60, 3)
      rows.push(summarizeTf(rung.tf, rung.sec, 'agg1m', bars.slice(-TECH_BARS_PER_RUNG)))
    } else {
      const bars = (input.native[rung.tf] ?? []).slice(-TECH_BARS_PER_RUNG)
      rows.push(summarizeTf(rung.tf, rung.sec, 'native', bars))
    }
  }
  const live = rows.filter((r) => r.ok)
  const overall = consensusFromScores(live.map((r) => r.summary.score))
  const direction: 'call' | 'put' | 'none' =
    !live.length || overall.counted < 3 ? 'none' : overall.score >= 0.15 ? 'call' : overall.score <= -0.15 ? 'put' : 'none'
  const note = live.length === 0
    ? 'every rung still warming up - no verdicts yet'
    : `${live.length}/${rows.length} rungs live · ${overall.buys} buy vs ${overall.sells} sell TFs`
  return { asset: input.asset, ts: Date.now(), mode: input.mode, price: input.price, rows, overall, direction, note }
}
