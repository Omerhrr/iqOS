// IQAIR//OS - Tick Desk analytics (kernel-side engine of record).
//
// Everything in this module reads the RAW micro-tick stream (the per-asset
// buffers the otc-footprint collector owns: sim = the kernel engine's ~1s
// prints, live = the sidecar's 100ms price-change captures) - NOT time
// candles. Four views share one bucketing primitive:
//
//   tickCandles()          - time-bucketed candles from the tick stream (the
//                            "tick chart" every other view derives from)
//   computeTickSmc()       - Smart Money Concepts on tick-derived candles:
//                            swing structure, BOS/CHoCH, order blocks, FVGs,
//                            liquidity sweeps, premium/discount
//   computeTickOracle()    - per-bucket next-candle direction oracle with an
//                            on-buffer walk-forward honesty hit rate
//   computeTickTechnical() - investing.com-style technical summary:
//                            oscillators + moving averages each vote
//                            buy/sell/neutral, aggregated into
//                            strong-buy..strong-sell ratings
//   computeTickFootprint() - the REAL tick footprint: per-bucket price-bin
//                            ladder of measured up/down print counts (not the
//                            CLV proxy the candle footprint uses)
//
// HONESTY CONTRACT (mirrors analytics/otcfootprint.ts):
//   - the tick source is the feed's own price-print stream, upper-bounded by
//     the capture cadence. The collector drops same-price prints, so every
//     buffered tick carries a direction except the first one ever recorded.
//   - a bucket that has not accumulated enough prints yet is reported
//     ok:false with a warming-up note - never a guessed direction.
//   - slow feeds make short buckets degenerate (a 1s bucket on a 1s feed has
//     ~1 print per candle): cadence-gated, not faked.
//   - no look-ahead: oracle features for candle i read only candles < i, and
//     every view reads CLOSED buckets only (the forming bucket is returned
//     separately and never voted on).
//
// Pure functions, O(n * buckets), no look-ahead.

import type { TickPoint } from './otcfootprint'
import {
  adx,
  awesomeOsc,
  atr,
  cci,
  ema,
  hma,
  macd,
  mom,
  rsi,
  sma,
  stochastic,
  stochRsi,
  ultimateOsc,
  vwma,
  williamsR,
} from './indicators'

// ---------- shared bucketing (the "tick chart" primitive) ----------

export interface TickCandle {
  /** Bucket start, integer epoch seconds (Candle.time convention). */
  time: number
  open: number
  high: number
  low: number
  close: number
  /** Prints aggregated into this bucket. */
  ticks: number
  /** Prints ABOVE the previous print (direction carriers - the buffer holds
   * price CHANGES only, so up+dn == ticks except the very first ever). */
  upTicks: number
  dnTicks: number
}

export interface TickCandlesResult {
  bucketSec: number
  /** Buckets strictly before the wall-clock bucket - CLOSED, votable. */
  closed: TickCandle[]
  /** The wall-clock bucket still forming (null when no prints landed yet). */
  forming: TickCandle | null
  /** Median prints per CLOSED candle - the cadence gate. */
  medTicksPerCandle: number
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Time-bucket the raw prints into candles. `nowMs` pins "now" (tests); the
 * bucket containing now is the forming one. */
export function tickCandles(ticks: TickPoint[], bucketSec: number, nowMs = Date.now()): TickCandlesResult {
  const bs = Math.max(1, Math.min(3600, Math.round(bucketSec)))
  const byKey = new Map<number, TickCandle>()
  let prevPrice = Number.NaN
  for (const t of ticks) {
    if (!Number.isFinite(t.ts) || !Number.isFinite(t.price)) continue
    const key = Math.floor(t.ts / 1000 / bs) * bs
    let c = byKey.get(key)
    if (!c) {
      c = { time: key, open: t.price, high: t.price, low: t.price, close: t.price, ticks: 0, upTicks: 0, dnTicks: 0 }
      byKey.set(key, c)
    }
    c.high = Math.max(c.high, t.price)
    c.low = Math.min(c.low, t.price)
    c.close = t.price
    c.ticks++
    if (Number.isFinite(prevPrice)) {
      if (t.price > prevPrice) c.upTicks++
      else if (t.price < prevPrice) c.dnTicks++
    }
    prevPrice = t.price
  }
  const keys = [...byKey.keys()].sort((a, b) => a - b)
  const nowKey = Math.floor(nowMs / 1000 / bs) * bs
  const formingKey = Math.min(keys.length ? keys[keys.length - 1] : nowKey, nowKey)
  const forming = byKey.has(formingKey) && formingKey === nowKey ? (byKey.get(formingKey) as TickCandle) : null
  const closed: TickCandle[] = keys
    .filter((k) => !forming || k !== formingKey)
    .map((k) => byKey.get(k) as TickCandle)
  return { bucketSec: bs, closed, forming, medTicksPerCandle: median(closed.map((c) => c.ticks)) }
}

/** Median inter-print gap in ms across the buffer (cadence disclosure). */
export function medianTickGapMs(ticks: TickPoint[]): number | null {
  const gaps: number[] = []
  for (let i = 1; i < ticks.length; i++) {
    const g = ticks[i].ts - ticks[i - 1].ts
    if (g > 0) gaps.push(g)
  }
  return gaps.length ? Math.round(median(gaps)) : null
}

// ---------- shared rating mapping (investing.com-style aggregation) ----------

export type TickRating = 'strong-buy' | 'buy' | 'neutral' | 'sell' | 'strong-sell'

export const RATING_RULE =
  'net = (buy - sell) / (buy + sell): net >= 0.6 strong-buy, >= 0.2 buy, > -0.2 neutral, > -0.6 sell, else strong-sell (neutrals excluded from the ratio)'

function ratingFromVotes(buy: number, sell: number): TickRating {
  const total = buy + sell
  if (total <= 0) return 'neutral'
  const net = (buy - sell) / total
  if (net >= 0.6) return 'strong-buy'
  if (net >= 0.2) return 'buy'
  if (net > -0.2) return 'neutral'
  if (net > -0.6) return 'sell'
  return 'strong-sell'
}

// ---------- 1. Tick SMC ----------

export interface TickSmcZone {
  top: number
  bottom: number
  /** Bucket-start seconds of the candle that created the zone. */
  time: number
}

export interface TickSmcBreak {
  dir: 'bull' | 'bear'
  /** What broke: the swing level price. */
  level: number
  /** Bucket-start seconds of the candle that closed beyond the level. */
  time: number
  /** Buckets since the break (0 = the last closed candle). */
  agoBars: number
}

export interface TickSmcResult {
  ok: boolean
  note?: string
  bucketSec: number
  /** Closed tick candles actually read (capped window). */
  candles: number
  medTicksPerCandle: number
  trend: 'up' | 'down' | 'range'
  bos: TickSmcBreak | null
  choch: TickSmcBreak | null
  /** Most recent unmitigated-ish order blocks (one per side). */
  bullOrderBlock: (TickSmcZone & { mitigated: boolean }) | null
  bearOrderBlock: (TickSmcZone & { mitigated: boolean }) | null
  /** Newest first, max 3. */
  fvgs: (TickSmcZone & { dir: 'bull' | 'bear'; filled: boolean })[]
  /** Newest first, max 3. dir = the side whose liquidity was swept. */
  sweeps: (TickSmcZone & { dir: 'bull' | 'bear'; close: number })[]
  premiumDiscount: { eq: number; high: number; low: number; zone: 'premium' | 'discount' | 'equilibrium' } | null
  price: number
  direction: 'call' | 'put' | 'none'
  confidence: number
  reasons: string[]
}

const SM_WINDOW = 120
const SM_MIN_CANDLES = 12

export function computeTickSmc(
  ticks: TickPoint[],
  opts: { bucketSec?: number; nowMs?: number } = {},
): TickSmcResult {
  const tc = tickCandles(ticks, opts.bucketSec ?? 15, opts.nowMs)
  const base: TickSmcResult = {
    ok: false,
    bucketSec: tc.bucketSec,
    candles: tc.closed.length,
    medTicksPerCandle: tc.medTicksPerCandle,
    trend: 'range',
    bos: null,
    choch: null,
    bullOrderBlock: null,
    bearOrderBlock: null,
    fvgs: [],
    sweeps: [],
    premiumDiscount: null,
    price: tc.closed.length ? tc.closed[tc.closed.length - 1].close : 0,
    direction: 'none',
    confidence: 0,
    reasons: [],
  }
  if (tc.closed.length < SM_MIN_CANDLES) {
    base.note = `warming up - need ${SM_MIN_CANDLES} closed ${tc.bucketSec}s tick buckets, have ${tc.closed.length}`
    return base
  }
  const cs = tc.closed.slice(-SM_WINDOW)
  const n = cs.length
  const k = 2 // fractal flank

  // --- swings ---
  const swingHighs: { i: number; level: number }[] = []
  const swingLows: { i: number; level: number }[] = []
  for (let i = k; i < n - k; i++) {
    let isH = true
    let isL = true
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue
      if (cs[j].high >= cs[i].high) isH = false
      if (cs[j].low <= cs[i].low) isL = false
    }
    if (isH) swingHighs.push({ i, level: cs[i].high })
    if (isL) swingLows.push({ i, level: cs[i].low })
  }

  // --- trend from the last two swing pairs ---
  let trend: 'up' | 'down' | 'range' = 'range'
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const sh1 = swingHighs[swingHighs.length - 1].level
    const sh0 = swingHighs[swingHighs.length - 2].level
    const sl1 = swingLows[swingLows.length - 1].level
    const sl0 = swingLows[swingLows.length - 2].level
    if (sh1 > sh0 && sl1 > sl0) trend = 'up'
    else if (sh1 < sh0 && sl1 < sl0) trend = 'down'
  }

  // --- breaks of the last swing levels (BOS agree / CHoCH oppose) ---
  const lastSH = swingHighs.length ? swingHighs[swingHighs.length - 1] : null
  const lastSL = swingLows.length ? swingLows[swingLows.length - 1] : null
  let bullBreak: TickSmcBreak | null = null
  let bearBreak: TickSmcBreak | null = null
  for (let i = n - 1; i >= 0; i--) {
    if (!bullBreak && lastSH && i > lastSH.i && cs[i].close > lastSH.level) {
      bullBreak = { dir: 'bull', level: lastSH.level, time: cs[i].time, agoBars: n - 1 - i }
    }
    if (!bearBreak && lastSL && i > lastSL.i && cs[i].close < lastSL.level) {
      bearBreak = { dir: 'bear', level: lastSL.level, time: cs[i].time, agoBars: n - 1 - i }
    }
    if (bullBreak && bearBreak) break
  }
  let bos: TickSmcBreak | null = null
  let choch: TickSmcBreak | null = null
  for (const b of [bullBreak, bearBreak]) {
    if (!b) continue
    const agrees = (trend === 'up' && b.dir === 'bull') || (trend === 'down' && b.dir === 'bear')
    // CHoCH = a break AGAINST an established trend. In a range there is no
    // character to change - a directional break IS the structure event, so
    // it classifies as BOS (and the vote carries it as such).
    const isChoch = trend !== 'range' && !agrees
    if (!isChoch) {
      if (!bos || b.agoBars < bos.agoBars) bos = b
    } else {
      if (!choch || b.agoBars < choch.agoBars) choch = b
    }
  }

  // --- order blocks: last opposite candle before each break ---
  const obFor = (dir: 'bull' | 'bear'): (TickSmcZone & { mitigated: boolean }) | null => {
    const brk = dir === 'bull' ? bullBreak : bearBreak
    if (!brk) return null
    const brkIdx = n - 1 - brk.agoBars
    for (let i = brkIdx - 1; i >= Math.max(0, brkIdx - 20); i--) {
      const c = cs[i]
      const opposite = dir === 'bull' ? c.close < c.open : c.close > c.open
      if (!opposite) continue
      const zone = { top: c.high, bottom: c.low, time: c.time }
      const startIdx = brkIdx + 1
      let mitigated = false
      for (let j = startIdx; j < n; j++) {
        if (cs[j].low <= zone.top && cs[j].high >= zone.bottom) {
          mitigated = true
          break
        }
      }
      return { ...zone, mitigated }
    }
    return null
  }
  const bullOrderBlock = obFor('bull')
  const bearOrderBlock = obFor('bear')

  // --- FVGs (3-candle gaps, newest first, max 3) ---
  const fvgs: (TickSmcZone & { dir: 'bull' | 'bear'; filled: boolean })[] = []
  for (let i = n - 1; i >= 2 && fvgs.length < 3; i--) {
    if (cs[i].low > cs[i - 2].high) {
      const zone = { top: cs[i].low, bottom: cs[i - 2].high, time: cs[i].time }
      let filled = false
      for (let j = i + 1; j < n; j++) if (cs[j].low <= zone.bottom) { filled = true; break }
      fvgs.push({ ...zone, dir: 'bull', filled })
    } else if (cs[i].high < cs[i - 2].low) {
      const zone = { top: cs[i - 2].low, bottom: cs[i].high, time: cs[i].time }
      let filled = false
      for (let j = i + 1; j < n; j++) if (cs[j].high >= zone.top) { filled = true; break }
      fvgs.push({ ...zone, dir: 'bear', filled })
    }
  }

  // --- liquidity sweeps: wick beyond a prior swing, close back inside ---
  const sweeps: (TickSmcZone & { dir: 'bull' | 'bear'; close: number })[] = []
  for (let i = n - 1; i >= 0 && sweeps.length < 3; i--) {
    for (const sh of swingHighs) {
      if (sh.i >= i) continue
      if (cs[i].high > sh.level && cs[i].close < sh.level) {
        sweeps.push({ top: sh.level, bottom: sh.level, time: cs[i].time, dir: 'bull', close: cs[i].close })
        break
      }
    }
    for (const sl of swingLows) {
      if (sl.i >= i) continue
      if (cs[i].low < sl.level && cs[i].close > sl.level) {
        sweeps.push({ top: sl.level, bottom: sl.level, time: cs[i].time, dir: 'bear', close: cs[i].close })
        break
      }
    }
  }

  // --- premium / discount over the latest swing leg ---
  let premiumDiscount: TickSmcResult['premiumDiscount'] = null
  if (lastSH && lastSL) {
    const high = Math.max(lastSH.level, lastSL.level)
    const low = Math.min(lastSH.level, lastSL.level)
    const eq = (high + low) / 2
    const price = cs[n - 1].close
    const zone = price > eq * 1.002 ? 'premium' : price < eq * 0.998 ? 'discount' : 'equilibrium'
    premiumDiscount = { eq, high, low, zone }
  }

  // --- direction vote ---
  const reasons: string[] = []
  let score = 0
  if (trend === 'up') { score += 0.3; reasons.push('tick structure up (HH+HL)') }
  else if (trend === 'down') { score -= 0.3; reasons.push('tick structure down (LH+LL)') }
  if (bos) {
    const w = bos.agoBars <= 3 ? 0.25 : 0.15
    score += bos.dir === 'bull' ? w : -w
    reasons.push(`${bos.dir === 'bull' ? 'bullish' : 'bearish'} BOS ${bos.agoBars} buckets ago`)
  }
  if (choch) {
    const w = choch.agoBars <= 3 ? 0.35 : 0.22
    score += choch.dir === 'bull' ? w : -w
    reasons.push(`CHoCH ${choch.dir === 'bull' ? 'bull' : 'bear'} ${choch.agoBars} buckets ago`)
  }
  const freshSweep = sweeps[0]
  if (freshSweep && freshSweep.time === cs[n - 1].time) {
    // a sweep on the very last closed bucket is the actionable cue
    score += freshSweep.dir === 'bull' ? 0.25 : -0.25
    reasons.push(`${freshSweep.dir === 'bull' ? 'buy-side' : 'sell-side'} liquidity swept, closed back inside`)
  } else if (freshSweep) {
    score += freshSweep.dir === 'bull' ? 0.1 : -0.1
    reasons.push(`${freshSweep.dir === 'bull' ? 'buy-side' : 'sell-side'} sweep ${freshSweep.time === cs[n - 2]?.time ? 'last bucket' : 'recent'}`)
  }
  if (premiumDiscount?.zone === 'discount') { score += 0.15; reasons.push('price in discount half of the leg') }
  else if (premiumDiscount?.zone === 'premium') { score -= 0.15; reasons.push('price in premium half of the leg') }

  const direction = score >= 0.18 ? 'call' : score <= -0.18 ? 'put' : 'none'
  const confidence = direction === 'none' ? 0 : Math.min(92, Math.round(Math.abs(score) * 130))
  if (direction === 'none' && !reasons.length) reasons.push('no actionable tick structure')

  return {
    ...base,
    ok: true,
    candles: n,
    trend,
    bos: bos as TickSmcBreak | null,
    choch: choch as TickSmcBreak | null,
    bullOrderBlock,
    bearOrderBlock,
    fvgs,
    sweeps,
    premiumDiscount,
    price: cs[n - 1].close,
    direction,
    confidence,
    reasons,
  }
}

// ---------- 2. Tick next-candle oracle ----------

export interface TickOracleRow {
  /** Bucket length label, e.g. '5s', '1m'. */
  label: string
  bucketSec: number
  ok: boolean
  note?: string
  /** Closed buckets available for this read. */
  candles: number
  medTicksPerCandle: number
  direction: 'call' | 'put' | 'none'
  confidence: number
  /** Signed vote -100..100 (call positive), 0 when none. */
  score: number
  reasons: string[]
  /** On-buffer walk-forward of this same rule: hits / (hits + misses) over
   * the evaluated closed candles, `null` until evaluated enough. */
  wf: { n: number; hits: number; misses: number; hitRatePct: number | null } | null
}

export interface TickOracleResult {
  ok: boolean
  note?: string
  rows: TickOracleRow[]
  best: TickOracleRow | null
  ticks: number
}

export const ORACLE_BUCKETS_SEC = [1, 2, 3, 5, 15, 30, 60, 120, 180, 300]
export const ORACLE_BUCKETS_LABEL = ['1s', '2s', '3s', '5s', '15s', '30s', '1m', '2m', '3m', '5m']
const ORACLE_MIN_CANDLES = 10
const ORACLE_MIN_TICKS_PER_CANDLE = 2

const bucketLabel = (sec: number): string => {
  const idx = ORACLE_BUCKETS_SEC.indexOf(sec)
  if (idx >= 0) return ORACLE_BUCKETS_LABEL[idx]
  return sec >= 60 ? `${sec / 60}m` : `${sec}s`
}

interface OracleFeatures {
  dir: 'call' | 'put' | 'none'
  score: number
  reasons: string[]
  /** Number of feature reasons that fired - feeds the confidence floor. */
  confidenceHint: number
}

/** The oracle vote for "next candle after history" - history ends at candle
 * i-1 (exclusive of candle i). No look-ahead by construction. */
function oracleVote(history: TickCandle[]): OracleFeatures {
  const n = history.length
  const reasons: string[] = []
  let score = 0
  const last = history[n - 1]
  // 1. streak of the last three closed tick candles (w 0.2)
  if (n >= 3) {
    const d = history.slice(-3).map((c) => (c.close >= c.open ? 1 : -1))
    if (d[0] === d[1] && d[1] === d[2]) {
      score += 0.2 * d[2]
      reasons.push(`3x ${d[2] === 1 ? 'up' : 'down'} tick candles`)
    }
  }
  // 2. tape persistence: z of P(same-direction candle) vs fair coin (w 0.25)
  if (n >= 12) {
    const dirs = history.slice(-30).map((c) => (c.close >= c.open ? 1 : -1))
    let same = 0
    for (let i = 1; i < dirs.length; i++) if (dirs[i] === dirs[i - 1]) same++
    const pairs = dirs.length - 1
    const pHat = pairs ? same / pairs : 0.5
    const z = (pHat - 0.5) / Math.sqrt(0.25 / Math.max(pairs, 1))
    const lastDir = last.close >= last.open ? 1 : -1
    if (z >= 1) {
      score += 0.25 * lastDir
      reasons.push(`persistent tape P(same)=${pHat.toFixed(2)} z=${z.toFixed(1)}`)
    } else if (z <= -1) {
      score -= 0.25 * lastDir
      reasons.push(`anti-persistent tape P(same)=${pHat.toFixed(2)} z=${z.toFixed(1)} - fading`)
    }
  }
  // 3. micro-delta of the last closed candle (w 0.2) - measured print pressure
  const updn = last.upTicks + last.dnTicks
  if (updn >= 2) {
    const share = (last.upTicks - last.dnTicks) / updn
    if (share >= 0.6) { score += 0.2; reasons.push(`print pressure ${last.upTicks}u/${last.dnTicks}d`) }
    else if (share <= -0.6) { score -= 0.2; reasons.push(`print pressure ${last.upTicks}u/${last.dnTicks}d`) }
  }
  // 4. momentum over the last 5 closes, ATR-normalized (w 0.2)
  if (n >= 8) {
    const win = history.slice(-12)
    const atrs = atr(win.map((c) => c.high), win.map((c) => c.low), win.map((c) => c.close), 8)
    const a = atrs[atrs.length - 1]
    if (Number.isFinite(a) && a > 0) {
      const move = last.close - history[n - 5].close
      const norm = move / (5 * a)
      if (norm >= 0.3) { score += 0.2; reasons.push(`5-bucket momentum ${(norm).toFixed(1)} ATR`) }
      else if (norm <= -0.3) { score -= 0.2; reasons.push(`5-bucket momentum ${(norm).toFixed(1)} ATR`) }
    }
  }
  // 5. close location value of the last candle (w 0.15)
  const span = Math.max(last.high - last.low, 1e-12)
  const clv = (last.close - last.low) / span
  if (clv >= 0.7) { score += 0.15; reasons.push('closed top 30% of bucket range') }
  else if (clv <= 0.3) { score -= 0.15; reasons.push('closed bottom 30% of bucket range') }

  const dir = score >= 0.2 ? 'call' : score <= -0.2 ? 'put' : 'none'
  return { dir, score, reasons, confidenceHint: reasons.length }
}

function oracleConfidence(f: OracleFeatures, agrees: number): number {
  return Math.min(90, Math.round(Math.abs(f.score) * 45 + agrees * 8))
}

export function computeTickOracle(
  ticks: TickPoint[],
  opts: { bucketsSec?: number[]; nowMs?: number; minCandles?: number } = {},
): TickOracleResult {
  const bucketsSec = opts.bucketsSec ?? ORACLE_BUCKETS_SEC
  const minCandles = opts.minCandles ?? ORACLE_MIN_CANDLES
  const rows: TickOracleRow[] = []
  for (const sec of bucketsSec) {
    const tc = tickCandles(ticks, sec, opts.nowMs)
    const label = bucketLabel(sec)
    const row: TickOracleRow = {
      label,
      bucketSec: sec,
      ok: false,
      candles: tc.closed.length,
      medTicksPerCandle: tc.medTicksPerCandle,
      direction: 'none',
      confidence: 0,
      score: 0,
      reasons: [],
      wf: null,
    }
    if (tc.closed.length < minCandles) {
      row.note = `warming up - need ${minCandles} closed buckets, have ${tc.closed.length}`
      rows.push(row)
      continue
    }
    if (tc.medTicksPerCandle < ORACLE_MIN_TICKS_PER_CANDLE) {
      row.note = `capture cadence too slow for ${label} buckets (median ${tc.medTicksPerCandle} print/bucket)`
      rows.push(row)
      continue
    }
    const history = tc.closed.slice(-60)
    const f = oracleVote(history)
    row.ok = true
    row.score = Math.round(f.score * 100)
    row.reasons = f.reasons
    if (f.dir !== 'none') {
      row.direction = f.dir
      row.confidence = oracleConfidence(f, f.confidenceHint)
    } else {
      row.note = 'two-sided tape - no honest lean'
    }
    // on-buffer walk-forward: the same rule, replayed candle by candle
    let hits = 0
    let misses = 0
    for (let i = minCandles; i < history.length; i++) {
      const pred = oracleVote(history.slice(0, i))
      if (pred.dir === 'none') continue // abstains don't count either way
      const actual = history[i].close >= history[i].open ? 'call' : 'put'
      if (pred.dir === actual) hits++
      else misses++
    }
    if (hits + misses >= 10) {
      row.wf = { n: hits + misses, hits, misses, hitRatePct: Math.round((hits / (hits + misses)) * 100) }
    }
    rows.push(row)
  }
  const best = rows.reduce<TickOracleRow | null>((acc, r) => {
    if (!r.ok || r.direction === 'none') return acc
    if (!acc) return r
    return r.confidence > acc.confidence ? r : acc
  }, null)
  const anyOk = rows.some((r) => r.ok)
  return {
    ok: anyOk,
    note: anyOk ? undefined : 'not enough tick history on any bucket yet',
    rows,
    best,
    ticks: ticks.length,
  }
}

// ---------- 3. Tick technical summary (investing.com-style) ----------

export interface TickTechRow {
  name: string
  group: 'osc' | 'ma'
  vote: 'buy' | 'sell' | 'neutral'
  value: string
}

export interface TickTechBucket {
  label: string
  bucketSec: number
  ok: boolean
  note?: string
  candles: number
  osc: { buy: number; sell: number; neutral: number; rating: TickRating }
  mas: { buy: number; sell: number; neutral: number; rating: TickRating }
  summary: { buy: number; sell: number; neutral: number; rating: TickRating }
}

export interface TickTechnicalResult {
  ok: boolean
  note?: string
  /** Compact ladder - one summary row per bucket. */
  buckets: TickTechBucket[]
  /** Full per-indicator table for the requested bucket. */
  detail: {
    label: string
    bucketSec: number
    ok: boolean
    note?: string
    candles: number
    rows: TickTechRow[]
    skipped: string[]
    price: number
  }
  ticks: number
  rule: string
}

const TECH_MIN_CANDLES = 35
const TECH_WINDOW = 260

interface OscVotes { buy: number; sell: number; neutral: number; rows: TickTechRow[]; skipped: string[] }

function techOscillators(cs: TickCandle[]): OscVotes {
  const out: OscVotes = { buy: 0, sell: 0, neutral: 0, rows: [], skipped: [] }
  const n = cs.length
  const push = (name: string, vote: 'buy' | 'sell' | 'neutral', value: string) => {
    out.rows.push({ name, group: 'osc', vote, value })
    out[vote]++
  }
  const need = (m: number) => n >= m
  const closes = cs.map((c) => c.close)
  const highs = cs.map((c) => c.high)
  const lows = cs.map((c) => c.low)

  // RSI(14) + RSI(7): oversold -> buy, overbought -> sell (investing rule)
  if (need(16)) {
    const r14 = rsi(closes, 14)
    const v = r14[r14.length - 1]
    if (Number.isFinite(v)) push('RSI(14)', v <= 30 ? 'buy' : v >= 70 ? 'sell' : 'neutral', v.toFixed(1))
  } else out.skipped.push('RSI(14) (need 16)')
  if (need(9)) {
    const r7 = rsi(closes, 7)
    const v = r7[r7.length - 1]
    if (Number.isFinite(v)) push('RSI(7)', v <= 30 ? 'buy' : v >= 70 ? 'sell' : 'neutral', v.toFixed(1))
  } else out.skipped.push('RSI(7) (need 9)')

  // Stoch %K(14,3): <20 buy, >80 sell
  if (need(20)) {
    const st = stochastic(highs, lows, closes, 14, 3)
    const k = st.k[st.k.length - 1]
    if (Number.isFinite(k)) push('Stoch %K(14,3)', k <= 20 ? 'buy' : k >= 80 ? 'sell' : 'neutral', k.toFixed(1))
  } else out.skipped.push('Stoch %K (need 20)')

  // Stoch RSI(14): 0..100 scale - <20 buy, >80 sell
  if (need(35)) {
    const srsi = stochRsi(closes, 14, 14, 3, 3)
    const k = srsi.k[srsi.k.length - 1]
    if (Number.isFinite(k)) push('Stoch RSI', k <= 20 ? 'buy' : k >= 80 ? 'sell' : 'neutral', k.toFixed(1))
  } else out.skipped.push('Stoch RSI (need 35)')

  // CCI(20): < -100 buy, > 100 sell
  if (need(22)) {
    const arr = cci(highs, lows, closes, 20)
    const v = arr[arr.length - 1]
    if (Number.isFinite(v)) push('CCI(20)', v <= -100 ? 'buy' : v >= 100 ? 'sell' : 'neutral', v.toFixed(0))
  } else out.skipped.push('CCI(20) (need 22)')

  // ADX(14): trending when > 23, vote by DI dominance
  if (need(30)) {
    const a = adx(highs, lows, closes, 14)
    const v = a.adx[a.adx.length - 1]
    const pdi = a.plusDI[a.plusDI.length - 1]
    const mdi = a.minusDI[a.minusDI.length - 1]
    if (Number.isFinite(v) && Number.isFinite(pdi) && Number.isFinite(mdi)) {
      push('ADX(14)', v > 23 ? (pdi > mdi ? 'buy' : 'sell') : 'neutral', `${v.toFixed(0)} (+DI ${pdi.toFixed(0)}/-DI ${mdi.toFixed(0)})`)
    }
  } else out.skipped.push('ADX(14) (need 30)')

  // Awesome Osc(5,34): >0 & rising buy, <0 & falling sell
  if (need(38)) {
    const arr = awesomeOsc(highs, lows)
    const v = arr[arr.length - 1]
    const p = arr[arr.length - 2]
    if (Number.isFinite(v) && Number.isFinite(p)) {
      push('Awesome Osc', v > 0 && v >= p ? 'buy' : v < 0 && v <= p ? 'sell' : 'neutral', v.toFixed(2))
    }
  } else out.skipped.push('Awesome Osc (need 38)')

  // Momentum(10): >0 & rising buy, <0 & falling sell
  if (need(13)) {
    const arr = mom(closes, 10)
    const v = arr[arr.length - 1]
    const p = arr[arr.length - 2]
    if (Number.isFinite(v) && Number.isFinite(p)) {
      push('Momentum(10)', v > 0 && v >= p ? 'buy' : v < 0 && v <= p ? 'sell' : 'neutral', v.toFixed(2))
    }
  } else out.skipped.push('Momentum(10) (need 13)')

  // MACD(12,26,9): macd above signal buy, below sell
  if (need(30)) {
    const m = macd(closes, 12, 26, 9)
    const v = m.macd[m.macd.length - 1]
    const s = m.signal[m.signal.length - 1]
    if (Number.isFinite(v) && Number.isFinite(s)) {
      push('MACD(12,26,9)', v > s ? 'buy' : v < s ? 'sell' : 'neutral', `${v.toFixed(2)} vs ${s.toFixed(2)}`)
    }
  } else out.skipped.push('MACD (need 30)')

  // Williams %R(14): < -80 buy, > -20 sell
  if (need(16)) {
    const arr = williamsR(highs, lows, closes, 14)
    const v = arr[arr.length - 1]
    if (Number.isFinite(v)) push('Williams %R(14)', v <= -80 ? 'buy' : v >= -20 ? 'sell' : 'neutral', v.toFixed(0))
  } else out.skipped.push('Williams %R (need 16)')

  // Bull/Bear Power(13): bear<0 & rising buy, bull>0 & falling sell
  if (need(16)) {
    const e = ema(closes, 13)
    const bull = highs[highs.length - 1] - e[e.length - 1]
    const bear = lows[lows.length - 1] - e[e.length - 1]
    const bearPrev = lows[lows.length - 2] - e[e.length - 2]
    const bullPrev = highs[highs.length - 2] - e[e.length - 2]
    if ([bull, bear, bearPrev, bullPrev].every(Number.isFinite)) {
      push('Bull/Bear Power', bear < 0 && bear >= bearPrev ? 'buy' : bull > 0 && bull <= bullPrev ? 'sell' : 'neutral', `+${bull.toFixed(2)}/${bear.toFixed(2)}`)
    }
  } else out.skipped.push('Bull/Bear Power (need 16)')

  // Ultimate Osc(7,14,28): <30 buy, >70 sell
  if (need(32)) {
    const arr = ultimateOsc(highs, lows, closes, 7, 14, 28)
    const v = arr[arr.length - 1]
    if (Number.isFinite(v)) push('Ultimate Osc', v <= 30 ? 'buy' : v >= 70 ? 'sell' : 'neutral', v.toFixed(0))
  } else out.skipped.push('Ultimate Osc (need 32)')

  return out
}

interface MaVotes { buy: number; sell: number; neutral: number; rows: TickTechRow[]; skipped: string[] }

function techMas(cs: TickCandle[]): MaVotes {
  const out: MaVotes = { buy: 0, sell: 0, neutral: 0, rows: [], skipped: [] }
  const n = cs.length
  const closes = cs.map((c) => c.close)
  const price = closes[n - 1]
  const push = (name: string, vote: 'buy' | 'sell' | 'neutral', value: string) => {
    out.rows.push({ name, group: 'ma', vote, value })
    out[vote]++
  }
  const maVote = (name: string, m: number, arr: number[]) => {
    if (!arr.length) return
    const v = arr[arr.length - 1]
    if (!Number.isFinite(v)) return
    push(name, price > v ? 'buy' : price < v ? 'sell' : 'neutral', v.toFixed(5))
  }
  for (const m of [10, 20, 30, 50, 100, 200] as const) {
    if (n >= m + 1) {
      maVote(`SMA(${m})`, m, sma(closes, m))
      maVote(`EMA(${m})`, m, ema(closes, m))
    } else {
      out.skipped.push(`SMA/EMA(${m}) (need ${m + 1})`)
    }
  }
  // volume proxy = print counts (the only honest size signal on a tick feed)
  const vols = cs.map((c) => Math.max(1, c.ticks))
  if (n >= 21) maVote('VWMA(20)', 20, vwma(closes, vols, 20))
  else out.skipped.push('VWMA(20) (need 21)')
  if (n >= 11) maVote('Hull MA(9)', 9, hma(closes, 9))
  else out.skipped.push('Hull MA(9) (need 11)')
  // Ichimoku Base Line (26): price above base buy, below sell
  if (n >= 27) {
    const win = cs.slice(-27)
    const base = (Math.max(...win.map((c) => c.high)) + Math.min(...win.map((c) => c.low))) / 2
    push('Ichimoku Base', price > base ? 'buy' : price < base ? 'sell' : 'neutral', base.toFixed(5))
  } else out.skipped.push('Ichimoku Base (need 27)')
  return out
}

function aggVotes(rows: TickTechRow[]): TickTechBucket['osc'] {
  const buy = rows.filter((r) => r.vote === 'buy').length
  const sell = rows.filter((r) => r.vote === 'sell').length
  const neutral = rows.filter((r) => r.vote === 'neutral').length
  return { buy, sell, neutral, rating: ratingFromVotes(buy, sell) }
}

export function computeTickTechnical(
  ticks: TickPoint[],
  opts: { bucketsSec?: number[]; detailBucketSec?: number; nowMs?: number } = {},
): TickTechnicalResult {
  const bucketsSec = opts.bucketsSec ?? [5, 15, 30, 60, 120, 180, 300]
  const detailSec = opts.detailBucketSec ?? bucketsSec[Math.min(3, bucketsSec.length - 1)]
  const ladder: TickTechBucket[] = []
  let detail: TickTechnicalResult['detail'] | null = null
  let anyOk = false
  for (const sec of bucketsSec) {
    const tc = tickCandles(ticks, sec, opts.nowMs)
    const label = bucketLabel(sec)
    const wantDetail = sec === detailSec
    if (tc.closed.length < TECH_MIN_CANDLES) {
      const note = `warming up - need ${TECH_MIN_CANDLES} closed buckets, have ${tc.closed.length}`
      ladder.push({
        label, bucketSec: sec, ok: false, note, candles: tc.closed.length,
        osc: { buy: 0, sell: 0, neutral: 0, rating: 'neutral' },
        mas: { buy: 0, sell: 0, neutral: 0, rating: 'neutral' },
        summary: { buy: 0, sell: 0, neutral: 0, rating: 'neutral' },
      })
      if (wantDetail) {
        detail = { label, bucketSec: sec, ok: false, note, candles: tc.closed.length, rows: [], skipped: [], price: tc.closed.length ? tc.closed[tc.closed.length - 1].close : 0 }
      }
      continue
    }
    const cs = tc.closed.slice(-TECH_WINDOW)
    const osc = techOscillators(cs)
    const mas = techMas(cs)
    const oscAgg = aggVotes(osc.rows)
    const maAgg = aggVotes(mas.rows)
    const sumAgg = aggVotes([...osc.rows, ...mas.rows])
    ladder.push({
      label, bucketSec: sec, ok: true, candles: cs.length,
      osc: oscAgg, mas: maAgg, summary: sumAgg,
    })
    anyOk = true
    if (wantDetail) {
      detail = {
        label, bucketSec: sec, ok: true, candles: cs.length,
        rows: [...osc.rows, ...mas.rows],
        skipped: [...osc.skipped, ...mas.skipped],
        price: cs[cs.length - 1].close,
      }
    }
  }
  if (!detail) {
    const tc = tickCandles(ticks, detailSec, opts.nowMs)
    detail = {
      label: bucketLabel(detailSec), bucketSec: detailSec, ok: false,
      note: `warming up - need ${TECH_MIN_CANDLES} closed buckets, have ${tc.closed.length}`,
      candles: tc.closed.length, rows: [], skipped: [],
      price: tc.closed.length ? tc.closed[tc.closed.length - 1].close : 0,
    }
  }
  return {
    ok: anyOk,
    note: anyOk ? undefined : 'not enough tick history on any bucket yet',
    buckets: ladder,
    detail: detail as TickTechnicalResult['detail'],
    ticks: ticks.length,
    rule: RATING_RULE,
  }
}

// ---------- 4. Tick footprint (measured prints, not the CLV proxy) ----------

export interface TickFootprintRow {
  priceLow: number
  priceHigh: number
  mid: number
  /** Measured up/down PRINTS at this level (a true tick count, not a proxy). */
  up: number
  dn: number
  upMs: number
  dnMs: number
  delta: number
  imbalance: 'buy' | 'sell' | null
}

export interface TickFootprintCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  ticks: number
  upTicks: number
  dnTicks: number
  delta: number
  poc: number | null
  rows: TickFootprintRow[]
}

export interface TickFootprintResult {
  ok: boolean
  note?: string
  bucketSec: number
  bins: number
  imbRatio: number
  candles: TickFootprintCandle[]
  summary: {
    netDelta: number
    totalUp: number
    totalDn: number
    dominantPoc: number | null
    buckets: number
  }
  ticks: number
}

export function computeTickFootprint(
  ticks: TickPoint[],
  opts: { bucketSec?: number; bins?: number; maxBuckets?: number; imbRatio?: number; nowMs?: number } = {},
): TickFootprintResult {
  const bucketSec = Math.max(1, Math.min(3600, Math.round(opts.bucketSec ?? 60)))
  const bins = Math.max(2, Math.min(24, Math.round(opts.bins ?? 12)))
  const maxBuckets = Math.max(2, Math.min(80, Math.round(opts.maxBuckets ?? 30)))
  const imbRatio = Math.max(1.5, Math.min(10, opts.imbRatio ?? 3))
  const tc = tickCandles(ticks, bucketSec, opts.nowMs)
  // the bucketing loop above loses per-print info, so re-walk the raw prints
  // once for the last maxBuckets buckets (candles give the OHLC skeleton)
  const candles: TickFootprintCandle[] = []
  const pocCounts = new Map<number, number>()
  let totalUp = 0
  let totalDn = 0
  if (tc.closed.length) {
    const win = tc.closed.slice(-maxBuckets)
    const t0 = win[0].time
    const t1 = (win[win.length - 1].time + bucketSec) * 1000
    const rowsByTime = new Map<number, Map<number, TickFootprintRow>>()
    const skelByTime = new Map<number, TickCandle>(win.map((c) => [c.time, c as TickCandle]))
    let prevPrice = Number.NaN
    let prevTs = Number.NaN
    // seed prev from the first print BEFORE the window (direction of the first
    // in-window print must still be measured, not guessed)
    for (const t of ticks) {
      if (t.ts >= t0 * 1000) break
      prevPrice = t.price
      prevTs = t.ts
    }
    for (const t of ticks) {
      if (t.ts < t0 * 1000) continue
      if (t.ts >= t1) break
      const key = Math.floor(t.ts / 1000 / bucketSec) * bucketSec
      const skel = skelByTime.get(key)
      if (!skel) continue
      let binMap = rowsByTime.get(key)
      if (!binMap) {
        binMap = new Map()
        rowsByTime.set(key, binMap)
      }
      const lo = skel.low
      const hi = Math.max(skel.high, skel.low)
      const span = Math.max(hi - lo, 1e-12)
      const idx = Math.min(bins - 1, Math.max(0, Math.floor(((t.price - lo) / span) * bins)))
      const binLo = lo + (span * idx) / bins
      const binHi = binLo + span / bins
      const mid = (binLo + binHi) / 2
      let row = binMap.get(mid)
      if (!row) {
        row = { priceLow: binLo, priceHigh: binHi, mid, up: 0, dn: 0, upMs: 0, dnMs: 0, delta: 0, imbalance: null }
        binMap.set(mid, row)
      }
      if (Number.isFinite(prevPrice) && Number.isFinite(prevTs)) {
        const gap = Math.max(0, t.ts - prevTs)
        if (t.price > prevPrice) { row.up++; row.upMs += gap; totalUp++ }
        else if (t.price < prevPrice) { row.dn++; row.dnMs += gap; totalDn++ }
      }
      prevPrice = t.price
      prevTs = t.ts
    }
    for (const c of win) {
      const binMap = rowsByTime.get(c.time)
      const rows = binMap
        ? [...binMap.values()]
            .map((r) => {
              const delta = r.up - r.dn
              const imb = r.up + r.dn >= 4 ? (r.up >= imbRatio * r.dn ? 'buy' : r.dn >= imbRatio * r.up ? 'sell' : null) : null
              return { ...r, upMs: r.up ? r.upMs / r.up : 0, dnMs: r.dn ? r.dnMs / r.dn : 0, delta, imbalance: imb as TickFootprintRow['imbalance'] }
            })
            .sort((a, b) => b.mid - a.mid)
        : []
      let poc: number | null = null
      let best = -1
      for (const r of rows) {
        const tot = r.up + r.dn
        if (tot > best) { best = tot; poc = r.mid }
      }
      if (poc !== null) pocCounts.set(poc, (pocCounts.get(poc) ?? 0) + 1)
      candles.push({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
        ticks: c.ticks, upTicks: c.upTicks, dnTicks: c.dnTicks,
        delta: c.upTicks - c.dnTicks, poc, rows,
      })
    }
  }
  let dominantPoc: number | null = null
  let domBest = 0
  for (const [p, cnt] of pocCounts) {
    if (cnt > domBest) { domBest = cnt; dominantPoc = p }
  }
  const ok = candles.length > 0
  return {
    ok,
    note: ok ? undefined : 'no closed tick buckets yet - the footprint needs prints to bin',
    bucketSec,
    bins,
    imbRatio,
    candles,
    summary: {
      netDelta: totalUp - totalDn,
      totalUp,
      totalDn,
      dominantPoc,
      buckets: candles.length,
    },
    ticks: ticks.length,
  }
}
