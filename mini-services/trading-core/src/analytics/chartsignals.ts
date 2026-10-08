// Chart-signal scanner math: chart-type engines vote call/put on one asset.
//
// The operator's Signal Panel asks a simple question - "what do the CHARTS
// say right now?" - so instead of the composite /analysis signal this module
// runs the same chart-type engines the workspace renders (renko, P&F, range
// bars, tick bars, footprint / OTC velocity footprint, Heikin Ashi and plain
// candlestick math) as independent voters and combines them into one signed
// score. Real-market assets vote with the volume footprint (CLV proxy); OTC
// assets vote with the micro-tick velocity footprint instead (no order book
// exists there, so print speed replaces volume). Everything reads only
// CLOSED candles - the forming minute never votes.

import type { Candle } from '../types'
import { renkoAtr, renkoBricks } from './renko'
import { pointFigure } from './pointfigure'
import { rangeBars } from './rangebars'
import { tickBars, type TickPoint } from './tickbars'
import { computeFootprint } from './footprint'

export type ChartEngineId = 'renko' | 'pnf' | 'range' | 'tick' | 'footprint' | 'otcfootprint' | 'heikin' | 'candle'

export const ENGINE_LABEL: Record<ChartEngineId, string> = {
  renko: 'Renko',
  pnf: 'P&F',
  range: 'Range',
  tick: 'Tick',
  footprint: 'Footprint',
  otcfootprint: 'OTC FP',
  heikin: 'H/A',
  candle: 'Candles',
}

export interface ChartEngineVote {
  engine: ChartEngineId
  dir: 1 | -1 | 0
  /** 0..1 conviction within this engine (streak depth, pattern freshness...). */
  weight: number
  note: string
}

export interface CfdLevels {
  entry: number
  sl: number
  tp: number
  slDist: number
  tpDist: number
  rr: number
}

export interface ChartSignal {
  asset: string
  name: string
  category: string
  otc: boolean
  price: number
  direction: 'call' | 'put'
  /** -100..100 signed net conviction (call positive). */
  score: number
  /** 0..100, |score|. */
  strength: number
  agree: number
  total: number
  /** Suggested option expiry in seconds (60..300). */
  expirySec: number
  votes: ChartEngineVote[]
  cfd: CfdLevels | null
  ts: number
  validUntil: number
  dataSource: string
}

export interface CombineResult {
  score: number
  strength: number
  direction: 'call' | 'put'
  agree: number
  total: number
}

/** Heikin Ashi transform (same math as the web chart's heikinAshi). */
export function heikinAshiSeries(candles: Candle[]): Candle[] {
  const out: Candle[] = []
  let prevOpen = candles[0]?.open ?? 0
  let prevClose = candles[0]?.close ?? 0
  for (const c of candles) {
    const close = (c.open + c.high + c.low + c.close) / 4
    const open = (prevOpen + prevClose) / 2
    const high = Math.max(c.high, open, close)
    const low = Math.min(c.low, open, close)
    out.push({ time: c.time, open, high, low, close, volume: c.volume })
    prevOpen = open
    prevClose = close
  }
  return out
}

function haVote(candles: Candle[]): ChartEngineVote {
  const ha = heikinAshiSeries(candles.slice(-40))
  const last = ha.slice(-3)
  if (last.length < 3) return { engine: 'heikin', dir: 0, weight: 0, note: 'thin history' }
  const dirs = last.map((c) => (c.close >= c.open ? 1 : -1))
  const dir = dirs[2]
  const streak = dirs[2] === dirs[1] ? (dirs[1] === dirs[0] ? 3 : 2) : 1
  // body dominance: smooth HA bodies indicate a persistent move, wicks a stall
  const dom =
    last.reduce((s, c) => s + Math.abs(c.close - c.open) / Math.max(c.high - c.low, 1e-12), 0) / last.length
  if (streak < 2) return { engine: 'heikin', dir: 0, weight: 0, note: 'no HA streak' }
  const weight = Math.min(0.35 + (streak - 2) * 0.2 + dom * 0.3, 0.85)
  return { engine: 'heikin', dir: dir as 1 | -1, weight, note: `${streak}x ${dir === 1 ? 'bull' : 'bear'} HA, body ${(dom * 100).toFixed(0)}%` }
}

function candleVote(candles: Candle[]): ChartEngineVote {
  if (candles.length < 5) return { engine: 'candle', dir: 0, weight: 0, note: 'thin history' }
  const [a, b] = candles.slice(-2)
  const reads: string[] = []
  let bull = 0
  let bear = 0
  // close position inside the last candle's range
  const span = Math.max(b.high - b.low, 1e-12)
  const pos = (b.close - b.low) / span
  if (pos >= 0.7) {
    bull += 1
    reads.push('close in top 30%')
  } else if (pos <= 0.3) {
    bear += 1
    reads.push('close in bottom 30%')
  }
  // 3-bar streak
  const three = candles.slice(-3)
  if (three.length === 3 && three.every((c) => c.close >= c.open)) {
    bull += 1
    reads.push('3x bull bars')
  } else if (three.length === 3 && three.every((c) => c.close <= c.open)) {
    bear += 1
    reads.push('3x bear bars')
  }
  // engulfing (closed pair)
  if (b.close > b.open && a.close < a.open && b.close >= a.open && b.open <= a.close) {
    bull += 1.5
    reads.push('bull engulfing')
  } else if (b.close < b.open && a.close > a.open && b.close <= a.open && b.open >= a.close) {
    bear += 1.5
    reads.push('bear engulfing')
  }
  const dir = bull > bear ? 1 : bear > bull ? -1 : 0
  if (dir === 0) return { engine: 'candle', dir: 0, weight: 0, note: 'mixed prints' }
  const weight = Math.min(0.3 + Math.abs(bull - bear) * 0.22, 0.7)
  return { engine: 'candle', dir: dir as 1 | -1, weight, note: reads.join(' + ') }
}

function renkoVote(candles: Candle[]): ChartEngineVote {
  const r = renkoBricks(candles.slice(-160), { atrMult: 0.3 })
  if (r.trend === 'none' || r.bricks.length < 3) return { engine: 'renko', dir: 0, weight: 0, note: 'no brick trend' }
  const dir = r.trend === 'up' ? 1 : -1
  const weight = Math.min(0.4 + r.streak * 0.15, 1)
  return { engine: 'renko', dir: dir as 1 | -1, weight, note: `${r.trend} x${r.streak} brick, ${r.flips} flips` }
}

function rangeVote(candles: Candle[]): ChartEngineVote {
  const r = rangeBars(candles.slice(-160), { atrMult: 0.5 })
  if (r.trend === 'none' || r.bars.length < 3) return { engine: 'range', dir: 0, weight: 0, note: 'no range trend' }
  const dir = r.trend === 'up' ? 1 : -1
  const weight = Math.min(0.4 + r.streak * 0.15, 1)
  return { engine: 'range', dir: dir as 1 | -1, weight, note: `${r.trend} x${r.streak} bars, ${r.flips} flips` }
}

function pnfVote(candles: Candle[]): ChartEngineVote {
  const pf = pointFigure(candles.slice(-160), { atrMult: 0.5, reversalBoxes: 3 })
  if (pf.buySignal && pf.buySignal.direction === 'call') return { engine: 'pnf', dir: 1, weight: 0.85, note: pf.buySignal.name }
  if (pf.sellSignal && pf.sellSignal.direction === 'put') return { engine: 'pnf', dir: -1, weight: 0.85, note: pf.sellSignal.name }
  if (pf.lastDir === 'X') return { engine: 'pnf', dir: 1, weight: 0.45, note: 'X column active' }
  if (pf.lastDir === 'O') return { engine: 'pnf', dir: -1, weight: 0.45, note: 'O column active' }
  return { engine: 'pnf', dir: 0, weight: 0, note: 'no column' }
}

function tickVote(candles: Candle[], realTicks: TickPoint[] | null): ChartEngineVote {
  // Real sub-candle ticks when the engine's ring buffer has them (sim bus);
  // otherwise the honest fallback is 1m closes as pseudo-ticks (the same
  // fallback the /ticks chart engine labels dataSource 'candle').
  const points: TickPoint[] =
    realTicks && realTicks.length >= 40
      ? realTicks.slice(-600)
      : candles.slice(-90).map((c) => ({ time: c.time, price: c.close }))
  const src = realTicks && realTicks.length >= 40 ? 'tick' : 'candle'
  const r = tickBars(points, { per: 10, dataSource: src })
  const bars = r.bars
  if (bars.length < 4) return { engine: 'tick', dir: 0, weight: 0, note: 'no tick bars' }
  const done = bars.slice(-4)
  const dirs = done.map((b) => (b.close >= b.open ? 1 : -1))
  const net = done[3].close - done[0].open
  const scale = Math.max(done[0].open, 1e-12)
  const dir = net > 0 ? 1 : net < 0 ? -1 : 0
  if (dir === 0) return { engine: 'tick', dir: 0, weight: 0, note: 'flat tape' }
  const same = dirs.filter((d) => d === dir).length
  const weight = Math.min(0.3 + (same - 1) * 0.18, 0.8)
  return {
    engine: 'tick',
    dir: dir as 1 | -1,
    weight,
    note: `${same}/4 ${dir === 1 ? 'up' : 'down'} bars (${src === 'tick' ? 'real ticks' : 'close-proxy'})`,
  }
}

function footprintVote(candles: Candle[]): ChartEngineVote {
  const fp = computeFootprint(candles.slice(-30), { binsPerCandle: 6 })
  const recent = fp.candles.slice(-5)
  if (!recent.length) return { engine: 'footprint', dir: 0, weight: 0, note: 'no clusters' }
  let delta = 0
  let vol = 0
  let buyImb = 0
  let sellImb = 0
  for (const c of recent) {
    for (const r of c.rows) {
      delta += r.delta
      vol += r.buyVolume + r.sellVolume
      if (r.imbalance === 'buy') buyImb++
      else if (r.imbalance === 'sell') sellImb++
    }
  }
  const share = vol > 0 ? delta / vol : 0
  const dir = share > 0.06 ? 1 : share < -0.06 ? -1 : 0
  if (dir === 0) return { engine: 'footprint', dir: 0, weight: 0, note: `delta ${(share * 100).toFixed(1)}% (flat)` }
  const imbBias = Math.abs(buyImb - sellImb) / Math.max(buyImb + sellImb, 1)
  const weight = Math.min(0.3 + Math.abs(share) * 2 + imbBias * 0.2, 0.85)
  return {
    engine: 'footprint',
    dir: dir as 1 | -1,
    weight,
    note: `delta ${(share * 100).toFixed(1)}%, ${buyImb}b/${sellImb}s imb (CLV proxy)`,
  }
}

export interface OtcFpRead {
  signal: 'call' | 'put' | 'none'
  score: number
  netDelta: number
  avgSpeedRatio: number
  buckets: number
}

function otcFootprintVote(read: OtcFpRead | null): ChartEngineVote {
  if (!read || read.buckets === 0) {
    return { engine: 'otcfootprint', dir: 0, weight: 0, note: 'tick buffer cold' }
  }
  if (read.signal === 'none') return { engine: 'otcfootprint', dir: 0, weight: 0, note: `delta ${read.netDelta} (flat)` }
  const dir = read.signal === 'call' ? 1 : -1
  const weight = Math.min(0.4 + Math.abs(read.score) * 0.15, 0.9)
  return {
    engine: 'otcfootprint',
    dir: dir as 1 | -1,
    weight,
    note: `${read.signal} score ${read.score}, delta ${read.netDelta}, ratio ${read.avgSpeedRatio.toFixed(2)}:1`,
  }
}

/** All engine votes for one asset. `otc` swaps the volume footprint for the
 * micro-tick velocity footprint; `otcRead === null` (cold buffer) votes 0. */
export function engineVotes(
  candles: Candle[],
  opts: { otc: boolean; realTicks?: TickPoint[] | null; otcRead?: OtcFpRead | null }
): ChartEngineVote[] {
  const votes: ChartEngineVote[] = [renkoVote(candles), pnfVote(candles), rangeVote(candles), tickVote(candles, opts.realTicks ?? null), haVote(candles), candleVote(candles)]
  votes.push(opts.otc ? otcFootprintVote(opts.otcRead ?? null) : footprintVote(candles))
  return votes
}

/** Combine votes into one signed score. Returns null when the votes do not
 * qualify (no directional weight, or below the strength/agreement floor). */
export function combineVotes(votes: ChartEngineVote[], opts: { threshold?: number; minAgree?: number } = {}): CombineResult | null {
  const threshold = opts.threshold ?? 35
  const minAgree = opts.minAgree ?? 3
  let pos = 0
  let neg = 0
  let agreePos = 0
  let agreeNeg = 0
  for (const v of votes) {
    if (v.dir === 1) {
      pos += v.weight
      agreePos++
    } else if (v.dir === -1) {
      neg += v.weight
      agreeNeg++
    }
  }
  const sum = pos + neg
  if (sum <= 0) return null
  const score = Math.round(((pos - neg) / sum) * 100)
  const direction: 'call' | 'put' = score >= 0 ? 'call' : 'put'
  const agree = direction === 'call' ? agreePos : agreeNeg
  const strength = Math.abs(score)
  if (strength < threshold || agree < minAgree) return null
  return { score, strength, direction, agree, total: votes.length }
}

/** Suggested option expiry: stronger confluence gets a little more room, the
 * dominant chart cadence (brick/bar streaks) sets the floor. 60..300s. */
export function expirySecFor(votes: ChartEngineVote[], strength: number): number {
  const streakNotes = votes
    .filter((v) => v.dir !== 0 && (v.engine === 'renko' || v.engine === 'range'))
    .map((v) => Number(/x(\d+)/.exec(v.note)?.[1] ?? 1))
  const maxStreak = streakNotes.length ? Math.max(...streakNotes) : 1
  const cadenceMin = Math.min(Math.max(Math.ceil(maxStreak / 2), 1), 3)
  const convictionMin = Math.min(Math.max(Math.round(strength / 35), 1), 5)
  return 60 * Math.min(Math.max(cadenceMin, convictionMin), 5)
}

/** CFD plan from the same vote: entry at last close, SL beyond the recent
 * swing with an ATR floor, TP at >=1.5R. Prices rounded to the asset pip. */
export function cfdLevelsFor(candles: Candle[], direction: 'call' | 'put', pipDigits: number): CfdLevels {
  const entry = candles[candles.length - 1].close
  const atr = renkoAtr(candles, 14)
  const atrSafe = Number.isFinite(atr) && atr > 0 ? atr : Math.max(entry * 0.0005, 1e-9)
  const win = candles.slice(-20)
  const round = (p: number) => Number(p.toFixed(Math.max(0, pipDigits)))
  const dir = direction === 'call' ? 1 : -1
  const swing = direction === 'call' ? Math.min(...win.map((c) => c.low)) : Math.max(...win.map((c) => c.high))
  const atrSl = entry - dir * 1.2 * atrSafe
  // SL: whichever is FARTHER from entry (swing protective or ATR floor)
  const slRaw = direction === 'call' ? Math.min(swing - 0.1 * atrSafe, atrSl) : Math.max(swing + 0.1 * atrSafe, atrSl)
  const risk = Math.abs(entry - slRaw)
  const tpRaw = entry + dir * Math.max(2 * atrSafe, risk * 1.6)
  const sl = round(slRaw)
  const tp = round(tpRaw)
  const entryR = round(entry)
  const rr = Math.abs(tp - entryR) / Math.max(Math.abs(entryR - sl), 1e-12)
  return { entry: entryR, sl, tp, slDist: Math.abs(entryR - sl), tpDist: Math.abs(tp - entryR), rr: Math.round(rr * 100) / 100 }
}

/** Full per-asset signal build. Returns null when the chart engines do not
 * qualify (thin history, no confluence) - the caller honestly drops it. */
export function buildChartSignal(
  info: { ticker: string; name: string; category: string; otc: boolean; pip: number },
  candles: Candle[],
  opts: { realTicks?: TickPoint[] | null; otcRead?: OtcFpRead | null; now?: number; ttlSec?: number; threshold?: number; minAgree?: number }
): ChartSignal | null {
  if (candles.length < 40) return null
  const votes = engineVotes(candles, { otc: info.otc, realTicks: opts.realTicks, otcRead: opts.otcRead })
  const combined = combineVotes(votes, { threshold: opts.threshold, minAgree: opts.minAgree })
  if (!combined) return null
  const now = opts.now ?? Date.now()
  const last = candles[candles.length - 1]
  return {
    asset: info.ticker,
    name: info.name,
    category: info.category,
    otc: info.otc,
    price: last.close,
    direction: combined.direction,
    score: combined.score,
    strength: combined.strength,
    agree: combined.agree,
    total: combined.total,
    expirySec: expirySecFor(votes, combined.strength),
    votes,
    cfd: cfdLevelsFor(candles, combined.direction, info.pip),
    ts: now,
    validUntil: now + (opts.ttlSec ?? 150) * 1000,
    dataSource: `chart-engines:${info.otc ? 'renko,pnf,range,tick,otcfootprint,heikin,candle' : 'renko,pnf,range,tick,footprint,heikin,candle'}`,
  }
}
