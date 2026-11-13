// IQAIR//OS - Signal clock: turns the Explainer's readers plus the pair's
// regime into ONE call - BUY, SELL or WAIT - a needle position on a dial, and a
// suggested holding period.
//
// Pure functions, no I/O. Everything below restates what the Explainer panels,
// the Effort Renko reader and the regime classifier already decided; nothing is
// re-derived except the final combination and the holding-period fit.
//
// HOW THE NEEDLE IS BUILT (-100 = full SELL .. +100 = full BUY)
//   reader net  = (readers leaning CALL - readers leaning PUT) / readable readers
//                 (the five panels + Effort Renko; unreadable readers are left out)
//   regime part = trending up/down: +/-(0.5 + 0.5 * score/100)
//                 ranging: a fade of the box edge (price in the bottom 20% = buy,
//                          top 20% = sell, scaled by how deep into the edge)
//                 noise / unreadable: 0
//   needle      = 100 * (0.55 * reader net + 0.45 * regime part)
// The action is then GATED, because a high needle built from the wrong parts is
// worse than WAIT:
//   noise or unreadable regime            -> WAIT
//   trending: needle must point the way of the trend, reach +/-35, have at least
//             2 readers on that side and at most 1 against it
//   ranging:  only an edge fade, needle at least +/-25 in the fade direction and
//             at most 1 reader against it
// While the action is WAIT the displayed needle is held inside the WAIT zone so
// the dial never points at BUY/SELL for a call it refused to make.
//
// HONESTY: the needle is a consensus score, not a probability. The readers look
// at the same candles, so their agreement is correlated. The holding period is
// the horizon over which THIS pair's own last ~150 bars followed through in the
// signal's direction most often - in-sample and descriptive, not validated.

import type { Candle } from '../types'
import type { EffortRead, Lean, PanelVerdict } from './explainer'
import type { RegimeKind, RegimeRow } from './regimescan'

export type SignalAction = 'buy' | 'sell' | 'wait'

export const ENTER_NEEDLE = 35
export const RANGE_ENTER_NEEDLE = 25
export const WAIT_CLAMP = 30
const READER_WEIGHT = 0.55
const REGIME_WEIGHT = 0.45
const EDGE_ZONE = 0.2
/** holding periods (in bars of the chosen timeframe) the fit chooses between */
export const EXPIRY_BAR_CHOICES = [1, 2, 3, 5, 8]
export const MIN_FIT_SAMPLES = 30

export interface SignalEvidence {
  id: string
  title: string
  ok: boolean
  lean: Lean
  strength: number | null
  headline: string
}

export interface SignalCheck {
  label: string
  state: 'pass' | 'fail' | 'na'
  note: string
}

export interface SignalExpiry {
  bars: number
  minutes: number
  label: string
  basis: string
  /** share of the pair's recent windows that followed through in the signal's direction, per horizon */
  rates: { bars: number; rate: number; n: number }[]
}

export interface SignalResult {
  action: SignalAction
  /** -100 (sell) .. +100 (buy); held inside +/-WAIT_CLAMP while the action is WAIT */
  needle: number
  /** the unclamped consensus score */
  rawNeedle: number
  /** |needle| - how strong the lean is. Not a win probability. */
  strength: number
  regime: RegimeKind | 'unreadable'
  /** what kind of setup this is, in words */
  setup: string
  headline: string
  reasons: string[]
  checks: SignalCheck[]
  readers: { call: number; put: number; flat: number; unreadable: number }
  evidence: SignalEvidence[]
  expiry: SignalExpiry | null
  note: string
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const sgn = (l: Lean) => (l === 'call' ? 1 : l === 'put' ? -1 : 0)

export function regimePart(row: RegimeRow | null): { value: number; label: string } {
  if (!row) return { value: 0, label: 'regime not readable' }
  if (row.regime === 'trend-up') return { value: 0.5 + 0.5 * (row.score / 100), label: 'trending up' }
  if (row.regime === 'trend-down') return { value: -(0.5 + 0.5 * (row.score / 100)), label: 'trending down' }
  if (row.regime === 'ranging') {
    if (row.position <= EDGE_ZONE) return { value: 0.8 * ((EDGE_ZONE - row.position) / EDGE_ZONE) + 0.2, label: 'ranging, at the bottom of its box' }
    if (row.position >= 1 - EDGE_ZONE) return { value: -(0.8 * ((row.position - (1 - EDGE_ZONE)) / EDGE_ZONE) + 0.2), label: 'ranging, at the top of its box' }
    return { value: 0, label: 'ranging, mid-box' }
  }
  return { value: 0, label: 'noise' }
}

/** Which holding period has this pair's own recent bars followed through in `dir`
 *  most often. Ties go to the shorter hold. Returns null with too few samples. */
export function fitExpiry(candles: Candle[], dir: 1 | -1, tfSec: number, regime: RegimeKind): SignalExpiry | null {
  const closes = candles.map((c) => c.close)
  const rates: { bars: number; rate: number; n: number }[] = []
  for (const k of EXPIRY_BAR_CHOICES) {
    let hits = 0
    let n = 0
    for (let i = 0; i + k < closes.length; i++) {
      n++
      if ((closes[i + k] - closes[i]) * dir > 0) hits++
    }
    if (n >= MIN_FIT_SAMPLES) rates.push({ bars: k, rate: Math.round((hits / n) * 1000) / 1000, n })
  }
  const mk = (bars: number, basis: string): SignalExpiry => {
    const minutes = (bars * tfSec) / 60
    const label = minutes >= 1 ? `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min` : `${Math.round(bars * tfSec)}s`
    return { bars, minutes, label, basis, rates }
  }
  if (regime === 'ranging') {
    return mk(2, 'a range fade pays only if price snaps back soon, so a short hold of 2 bars; the trend follow-through fit does not apply inside a box')
  }
  if (!rates.length) return null
  let best = rates[0]
  for (const r of rates) if (r.rate > best.rate + 1e-9) best = r
  const basis =
    best.rate > 0.5
      ? `over the last ${best.n} windows this pair moved the signal's way after ${best.bars} bar${best.bars === 1 ? '' : 's'} ${(best.rate * 100).toFixed(0)}% of the time, its best holding period`
      : `no holding period has followed through above a coin flip lately (best ${(best.rate * 100).toFixed(0)}% at ${best.bars} bar${best.bars === 1 ? '' : 's'}), so the shortest-risk choice is shown`
  return mk(best.rate > 0.5 ? best.bars : EXPIRY_BAR_CHOICES[0], basis)
}

export function buildSignal(input: {
  panels: PanelVerdict[]
  effort: EffortRead | null
  regime: RegimeRow | null
  candles: Candle[]
  tfSec: number
}): SignalResult {
  const { panels, effort, regime, candles, tfSec } = input
  const evidence: SignalEvidence[] = panels.map((p) => ({ id: p.id, title: p.title, ok: p.ok, lean: p.ok ? p.lean : 'none', strength: p.strength, headline: p.headline }))
  if (effort) evidence.push({ id: 'effort', title: 'Effort Renko', ok: effort.ok, lean: effort.ok ? effort.lean : 'none', strength: effort.strength, headline: effort.headline })

  const readable = evidence.filter((e) => e.ok)
  const call = readable.filter((e) => e.lean === 'call').length
  const put = readable.filter((e) => e.lean === 'put').length
  const flat = readable.length - call - put
  const unreadable = evidence.length - readable.length
  const net = readable.length ? (call - put) / readable.length : 0
  const rp = regimePart(regime)
  const raw = Math.round(clamp(100 * (READER_WEIGHT * net + REGIME_WEIGHT * rp.value), -100, 100))

  const rk: RegimeKind | 'unreadable' = regime ? regime.regime : 'unreadable'
  const checks: SignalCheck[] = []
  const reasons: string[] = []
  let action: SignalAction = 'wait'
  let setup = 'no setup'
  let headline = ''

  const against = (dir: 1 | -1) => (dir === 1 ? put : call)
  const withDir = (dir: 1 | -1) => (dir === 1 ? call : put)

  if (!regime) {
    checks.push({ label: 'Regime readable', state: 'fail', note: 'not enough closed candles on this timeframe to classify the regime' })
    headline = 'WAIT - the regime cannot be read yet.'
    reasons.push('Without a regime read the signal refuses to call a direction.')
  } else if (regime.regime === 'noise') {
    checks.push({ label: 'Tradable regime', state: 'fail', note: `noise: ${regime.reason}` })
    headline = 'WAIT - this pair is noise: no direction and no tested range.'
    reasons.push(`Regime is noise. ${regime.reason}`)
  } else if (regime.regime === 'trend-up' || regime.regime === 'trend-down') {
    const dir: 1 | -1 = regime.regime === 'trend-up' ? 1 : -1
    const dirWord = dir === 1 ? 'up' : 'down'
    const aligned = Math.sign(raw) === dir
    const strongEnough = Math.abs(raw) >= ENTER_NEEDLE
    const sup = withDir(dir)
    const opp = against(dir)
    checks.push({ label: 'Regime', state: 'pass', note: `trending ${dirWord} (rank score ${regime.score}): ${regime.reason}` })
    checks.push({ label: 'Readers back the trend', state: sup >= 2 ? 'pass' : 'fail', note: `${sup} of ${readable.length} readable readers lean ${dir === 1 ? 'CALL' : 'PUT'}` })
    checks.push({ label: 'Few readers against', state: opp <= 1 ? 'pass' : 'fail', note: `${opp} reader${opp === 1 ? '' : 's'} lean the other way` })
    checks.push({ label: 'Needle strong enough', state: aligned && strongEnough ? 'pass' : 'fail', note: `consensus ${raw >= 0 ? '+' : ''}${raw}, needs ${dir === 1 ? '+' : '-'}${ENTER_NEEDLE} or beyond in the trend direction` })
    if (aligned && strongEnough && sup >= 2 && opp <= 1) {
      action = dir === 1 ? 'buy' : 'sell'
      setup = `trend continuation (${dirWord})`
      headline = `${action.toUpperCase()} - trending ${dirWord} and ${sup} of ${readable.length} readers agree.`
      reasons.push(`The pair is in a ${dirWord}trend and the readers lean the same way (${sup} with, ${opp} against, ${flat} flat).`)
    } else {
      headline = `WAIT - trending ${dirWord}, but the readers do not back it strongly enough.`
      if (opp > 1) reasons.push(`${opp} readers lean against the ${dirWord}trend.`)
      if (sup < 2) reasons.push(`only ${sup} reader${sup === 1 ? '' : 's'} back the ${dirWord}trend.`)
      if (!aligned || !strongEnough) reasons.push(`consensus ${raw >= 0 ? '+' : ''}${raw} is short of the ${ENTER_NEEDLE} needed.`)
    }
  } else {
    // ranging
    const fade = Math.sign(rp.value) as -1 | 0 | 1
    checks.push({ label: 'Regime', state: 'pass', note: `ranging: ${regime.reason}` })
    checks.push({ label: 'At a box edge', state: fade !== 0 ? 'pass' : 'fail', note: `price sits ${Math.round(regime.position * 100)}% of the way up its ${regime.rangePct.toFixed(2)}% box (edges are the outer ${EDGE_ZONE * 100}%)` })
    if (fade !== 0) {
      const dir = fade as 1 | -1
      const opp = against(dir)
      checks.push({ label: 'Few readers against the fade', state: opp <= 1 ? 'pass' : 'fail', note: `${opp} reader${opp === 1 ? '' : 's'} lean against the fade` })
      const strong = Math.sign(raw) === dir && Math.abs(raw) >= RANGE_ENTER_NEEDLE
      checks.push({ label: 'Needle strong enough', state: strong ? 'pass' : 'fail', note: `consensus ${raw >= 0 ? '+' : ''}${raw}, needs ${dir === 1 ? '+' : '-'}${RANGE_ENTER_NEEDLE} or beyond` })
      if (strong && opp <= 1) {
        action = dir === 1 ? 'buy' : 'sell'
        setup = `range fade (${dir === 1 ? 'bounce off the bottom' : 'rejection from the top'})`
        headline = `${action.toUpperCase()} - ${dir === 1 ? 'bottom' : 'top'} of a tested range.`
        reasons.push(`Price is at the ${dir === 1 ? 'bottom' : 'top'} of a box it has tagged on both sides, and the readers do not object (${opp} against).`)
      } else {
        headline = 'WAIT - at a range edge, but the readers do not back the fade.'
        reasons.push(opp > 1 ? `${opp} readers lean against the fade.` : `consensus ${raw >= 0 ? '+' : ''}${raw} is short of the ${RANGE_ENTER_NEEDLE} needed.`)
      }
    } else {
      headline = 'WAIT - ranging, but price is mid-box with no edge to fade.'
      reasons.push('Inside a range the only trade this signal takes is a fade from the edge; price is not at one.')
    }
  }

  // reader summary line (always shown)
  reasons.push(`Readers: ${call} CALL, ${put} PUT, ${flat} flat${unreadable ? `, ${unreadable} not readable (left out, never counted as neutral)` : ''}.`)

  const needle = action === 'wait' ? clamp(raw, -WAIT_CLAMP, WAIT_CLAMP) : raw
  let expiry: SignalExpiry | null = null
  if (action !== 'wait' && regime) expiry = fitExpiry(candles.slice(-150), action === 'buy' ? 1 : -1, tfSec, regime.regime)

  return {
    action,
    needle,
    rawNeedle: raw,
    strength: Math.abs(needle),
    regime: rk,
    setup,
    headline,
    reasons,
    checks,
    readers: { call, put, flat, unreadable },
    evidence,
    expiry,
    note: 'A consensus score, not a probability: the readers look at the same candles, so their agreement is correlated. The holding period is the horizon this pair followed through most often over its own recent bars - in-sample and descriptive, not validated. Nothing here places an order.',
  }
}
