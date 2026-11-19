// IQAIR//OS - CFD trade PLAN ("cfd" = the pm model turned into a tradeable order).
//
// story.pm answers "which way and how likely". A CFD trader also needs WHERE: entry, stop-loss, take-profit, and whether the reward is worth the
// risk. This builds that plan on top of the cause->effect read (analytics/causeeffect.ts) blended with a higher timeframe:
//   ENTRY : last close (market order).
//   STOP  : just beyond the nearest structural level against the trade (support for a long, resistance for a short) plus a buffer, clamped to
//           [minSlAtr, maxSlAtr] x ATR; no level nearby -> slAtr x ATR.
//   TARGET: the nearest structural level in the trade's favour (shaved by a buffer) if it gives at least minRR, otherwise minRR x risk (never
//           beyond the model's own expected move x tpStretch when that is larger than minRR x risk would imply - see capped).
//   EV    : probability x RR - (1 - probability), in R. Positive only if the (judgement-weighted, unfitted) probability is right.
// HONESTY: levels are mechanical, the probability is a shrunk estimate, nothing here has a measured edge. Backtest before risking money.

import { atr as atrInd } from './indicators'
import { combineCeMtf, readCauseEffect, type CeCandle, type CeMtf, type CeTick } from './causeeffect'

export interface CfdPlanOptions {
  slAtr?: number      // default stop distance when no structure is near (ATR), default 1.5
  minSlAtr?: number   // default 0.8
  maxSlAtr?: number   // default 3
  minRR?: number      // minimum reward:risk, default 1.5
  bufferAtr?: number  // beyond/inside a level, default 0.25
  htfTf?: string      // default '5m'; 'none' disables
  otc?: boolean       // OTC mode (no volume; see causeeffect.ts)
}

export interface CfdPlan {
  ok: boolean
  error?: string
  direction: 'call' | 'put' | 'none'
  entry: number
  stop: number
  target: number
  riskDist: number
  rewardDist: number
  riskAtr: number
  rewardAtr: number
  rr: number
  prob: number
  strength: number
  ev: number          // expected R per trade
  atr: number
  stopKind: 'structure' | 'atr' | 'none'
  targetKind: 'structure' | 'rr' | 'none'
  alignment: CeMtf['alignment']
  mtf: CeMtf | null
  text: string
}

const none = (error: string, atr = NaN): CfdPlan => ({ ok: false, error, direction: 'none', entry: NaN, stop: NaN, target: NaN, riskDist: NaN, rewardDist: NaN, riskAtr: NaN, rewardAtr: NaN, rr: NaN, prob: 0.5, strength: 0, ev: 0, atr, stopKind: 'none', targetKind: 'none', alignment: 'no-call', mtf: null, text: error })

export function readCfdPlan(candles: CeCandle[], ticks?: readonly CeTick[], htfCandles?: CeCandle[] | null, opts: CfdPlanOptions = {}): CfdPlan {
  const htfTf = opts.htfTf ?? '5m'
  const trig = readCauseEffect(candles, ticks, { otc: opts.otc })
  if (!trig.ok) return none(trig.error ?? 'not enough history')
  let htf: ReturnType<typeof readCauseEffect> | null = null
  if (htfTf !== 'none' && htfCandles && htfCandles.length) { try { htf = readCauseEffect(htfCandles, undefined, { otc: opts.otc }) } catch { htf = null } }
  const m = combineCeMtf(trig, htf, htfTf)
  const a = atrInd(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), 14)
  const atr = a[a.length - 1]
  if (!Number.isFinite(atr) || atr <= 0) return none('ATR unavailable', atr)
  const entry = candles[candles.length - 1].close
  if (m.dir === 'none') return { ...none(m.text, atr), entry, prob: m.prob, strength: m.strength, alignment: m.alignment, mtf: m, text: m.text }
  const long = m.dir === 'call'
  const slAtr = opts.slAtr ?? 1.5, minSl = opts.minSlAtr ?? 0.8, maxSl = opts.maxSlAtr ?? 3, minRR = opts.minRR ?? 1.5, buf = (opts.bufferAtr ?? 0.25) * atr
  const sup = trig.sr.support, res = trig.sr.resistance
  // STOP
  let stopDist = slAtr * atr, stopKind: CfdPlan['stopKind'] = 'atr'
  const against = long ? sup : res
  if (Number.isFinite(against)) {
    const d = Math.abs(entry - against) + buf
    if (d >= minSl * atr && d <= maxSl * atr) { stopDist = d; stopKind = 'structure' }
  }
  stopDist = Math.min(Math.max(stopDist, minSl * atr), maxSl * atr)
  // TARGET
  let rewardDist = minRR * stopDist, targetKind: CfdPlan['targetKind'] = 'rr'
  const toward = long ? res : sup
  if (Number.isFinite(toward)) {
    const d = Math.abs(toward - entry) - buf
    if (d >= minRR * stopDist) { rewardDist = d; targetKind = 'structure' }
  }
  const stop = long ? entry - stopDist : entry + stopDist
  const target = long ? entry + rewardDist : entry - rewardDist
  const rr = rewardDist / stopDist
  const ev = m.prob * rr - (1 - m.prob)
  const text = `${long ? 'LONG' : 'SHORT'} @ ${entry} SL ${stop.toFixed(5)} (${stopKind}, ${(stopDist / atr).toFixed(2)} ATR) TP ${target.toFixed(5)} (${targetKind}, ${(rewardDist / atr).toFixed(2)} ATR) RR ${rr.toFixed(2)} P ${(m.prob * 100).toFixed(0)}% EV ${ev.toFixed(2)}R - ${m.alignment}`
  return { ok: true, direction: m.dir, entry, stop, target, riskDist: stopDist, rewardDist, riskAtr: stopDist / atr, rewardAtr: rewardDist / atr, rr, prob: m.prob, strength: m.strength, ev, atr, stopKind, targetKind, alignment: m.alignment, mtf: m, text }
}

/** Position size for a CFD. mode 'risk': risk `riskPct`% of `equity` on the stop distance (units = risk$ / stopDist; margin = units x entry / leverage).
 * mode 'margin': fixed margin, units = margin x leverage / entry. Returns margin to commit (the engine's `amount`) and the implied units/notional/risk. */
export function cfdSize(p: { mode: 'risk' | 'margin'; equity: number; riskPct: number; fixedMargin: number; leverage: number; entry: number; stopDist: number; maxMarginPct?: number }): { margin: number; units: number; notional: number; riskAmount: number; capped: boolean } {
  const lev = Math.max(1, p.leverage)
  let margin: number
  if (p.mode === 'risk') {
    const riskAmt = Math.max(0, p.equity * p.riskPct / 100)
    const units = p.stopDist > 0 ? riskAmt / p.stopDist : 0
    margin = (units * p.entry) / lev
  } else margin = Math.max(0, p.fixedMargin)
  let capped = false
  const cap = p.equity * (p.maxMarginPct ?? 25) / 100
  if (margin > cap) { margin = cap; capped = true }
  margin = Math.floor(margin * 100) / 100
  const notional = margin * lev
  const units = p.entry > 0 ? notional / p.entry : 0
  return { margin, units, notional, riskAmount: units * p.stopDist, capped }
}
