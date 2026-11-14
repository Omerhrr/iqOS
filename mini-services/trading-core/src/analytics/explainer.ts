// IQAIR//OS - Explainer: one pair + timeframe, five readers, plain language.
//
// The Explainer tab shows what five existing engines each say about ONE pair
// on ONE timeframe - SMC structure, candlestick patterns, the Market
// Response Clock predictor, swing structure and the technical vote panels -
// and, for each, WHY in a sentence a trader can check against the chart.
// This module is the pure half: it turns each engine's own result into a
// `PanelVerdict` (lean, strength, headline, reasons) and counts how many
// readers agree. It performs no I/O and re-derives nothing the engines
// already decided - every lean below is the engine's own call, restated.
//
// HONESTY (kept in the summary note, not just here):
//   - The panels read the SAME candles, so their agreement is not five
//     independent confirmations; correlated readers agree more often than
//     independent ones would.
//   - "Strength" is each engine's own score (SMC confidence, MRC calibrated
//     rate, technical vote balance, pattern bias). None is a calibrated win
//     probability against the payout's breakeven - only mrcpredict's rate is
//     even self-calibrated, and the agreement count is not a probability.
//   - A panel that cannot read (warming up, too few bars) says so and is left
//     OUT of the agreement count instead of being counted as neutral.
import type { PatternHit } from '../types'
import type { SmcScanResult, SmcKind } from './smc'
import type { MrcPredictResult } from './mrcpredict'
import type { SwingResult } from './swing'
import type { TechTfRow } from './technicals'
import { patternBias } from './patterns'
import type { EffortBarsResult } from './effortbricks'

export type Lean = 'call' | 'put' | 'none'
export type PanelId = 'smc' | 'candle' | 'mrc' | 'swing' | 'technical'

export interface PanelVerdict {
  id: PanelId
  title: string
  /** false = this reader could not read (warming up / too few bars) - excluded from the agreement count. */
  ok: boolean
  lean: Lean
  /** The engine's own 0-100 strength for its lean; null where the engine has none (swing structure). */
  strength: number | null
  headline: string
  reasons: string[]
}

export interface ExplainerSummary {
  call: number
  put: number
  /** readable panels with no directional lean */
  flat: number
  /** panels that could not read */
  unavailable: number
  readable: number
  lean: Lean
  /** aligned: one side only and >= 3 panels; leaning: more panels on one side than the other; mixed: both sides present and level; flat: nobody leans */
  grade: 'aligned' | 'leaning' | 'mixed' | 'flat' | 'none'
  headline: string
  note: string
}

/** Net candlestick bias (patterns.ts patternBias, clamped +/-6) a lean needs: roughly one reliability-2 pattern on the latest bar. */
export const PATTERN_LEAN_MIN = 1.5
/** Technical score (buys-sells)/counted a lean needs - the same 0.15 line technicals.ts uses for BUY/SELL. */
export const TECH_LEAN_MIN = 0.15

const SMC_LABEL: Record<SmcKind, string> = {
  FVG: 'Fair Value Gap',
  IFVG: 'Inverse FVG',
  ORDER_BLOCK: 'Order Block',
  BREAKER_BLOCK: 'Breaker Block',
  LIQUIDITY_SWEEP: 'Liquidity Sweep',
  BOS: 'Break of Structure',
  CHOCH: 'CHoCH',
  OTE: 'OTE',
  KRM: 'KRM',
  SUPPLY_DEMAND: 'Supply & Demand',
  SUPPORT_RESISTANCE: 'Support & Resistance',
  BREAKOUT: 'Breakout',
  CRT: 'CRT',
  POWER_OF_3: 'Power of 3',
  SILVER_BULLET: 'Silver Bullet',
  EQH_EQL: 'Equal Highs/Lows',
  REJECTION_BLOCK: 'Rejection Block',
  INDUCEMENT: 'Inducement',
}

const ago = (bars: number) => (bars <= 0 ? 'now' : bars === 1 ? '1 bar ago' : `${bars} bars ago`)
const word = (lean: Lean) => (lean === 'call' ? 'CALL' : lean === 'put' ? 'PUT' : 'no lean')

const unreadable = (id: PanelId, title: string, why: string): PanelVerdict => ({ id, title, ok: false, lean: 'none', strength: null, headline: why, reasons: [] })

// ---------------------------------------------------------------------------
// SMC
// ---------------------------------------------------------------------------

export function explainSmc(res: SmcScanResult | null): PanelVerdict {
  const title = 'SMC'
  if (!res) return unreadable('smc', title, 'Not enough candle history yet - SMC needs 60+ bars.')
  const active = res.signals.filter((s) => s.active).sort((a, b) => a.barsAgo - b.barsAgo)
  const lean = res.summary.direction
  const reasons: string[] = []
  reasons.push(
    res.trend === 'range'
      ? 'Structure: range - no swing break has happened in the scanned window.'
      : `Structure: ${res.trend} - the last break of structure went ${res.trend === 'bullish' ? 'up' : 'down'}.`,
  )
  for (const s of active.slice(0, 3)) {
    const where =
      s.top !== undefined && s.bottom !== undefined
        ? ` (zone ${s.bottom}-${s.top})`
        : s.level !== undefined
          ? ` (level ${s.level})`
          : ''
    reasons.push(`${SMC_LABEL[s.kind] ?? s.kind} ${s.direction}, ${ago(s.barsAgo)}${where}.`)
  }
  if (!active.length) reasons.push('No SMC concept is active on this pair right now.')
  const headline =
    lean === 'none'
      ? `No clear SMC lean - ${res.summary.bullish} bullish vs ${res.summary.bearish} bearish active signals.`
      : `Leans ${word(lean)} ${res.summary.confidence}% - ${res.summary.bullish} bullish vs ${res.summary.bearish} bearish active signals.`
  return { id: 'smc', title, ok: true, lean, strength: lean === 'none' ? null : res.summary.confidence, headline, reasons }
}

// ---------------------------------------------------------------------------
// Candle patterns
// ---------------------------------------------------------------------------

export function explainPatterns(hits: PatternHit[], lookback = 8): PanelVerdict {
  const title = 'Candle pattern'
  const bias = patternBias(hits)
  const lean: Lean = bias >= PATTERN_LEAN_MIN ? 'call' : bias <= -PATTERN_LEAN_MIN ? 'put' : 'none'
  const ordered = [...hits].sort((a, b) => a.barsAgo - b.barsAgo || b.reliability - a.reliability)
  const reasons = ordered.slice(0, 4).map((h) => `${h.name} (${h.direction}, ${'★'.repeat(h.reliability)}, ${ago(h.barsAgo)}): ${h.note}.`)
  let headline: string
  if (!hits.length) headline = `No candlestick pattern in the last ${lookback} bars.`
  else if (lean === 'none') headline = `${hits.length} pattern${hits.length === 1 ? '' : 's'} present but not decisive (net bias ${bias >= 0 ? '+' : ''}${bias.toFixed(1)}, needs ±${PATTERN_LEAN_MIN}).`
  else headline = `${hits.length} pattern${hits.length === 1 ? '' : 's'} lean ${word(lean)} - net bias ${bias >= 0 ? '+' : ''}${bias.toFixed(1)}, led by ${ordered[0].name}.`
  if (hits.length) reasons.push('Bias weights each pattern by its reliability stars and how recent it is.')
  return { id: 'candle', title, ok: true, lean, strength: lean === 'none' ? null : Math.round((Math.abs(bias) / 6) * 100), headline, reasons }
}

// ---------------------------------------------------------------------------
// MRC predictor
// ---------------------------------------------------------------------------

export function explainMrc(r: MrcPredictResult | null): PanelVerdict {
  const title = 'MRC'
  if (!r) return unreadable('mrc', title, 'No MRC read - pair not in the tracked universe.')
  if (!r.ok || r.state === 'warming') return unreadable('mrc', title, r.note || 'MRC is warming up - not enough confirmed response bars yet.')
  if (r.state === 'uncertain' || r.direction === 'none') {
    return { id: 'mrc', title, ok: true, lean: 'none', strength: null, headline: `No edge right now - ${r.note}`, reasons: ['MRC reports "uncertain" rather than a direction when this pair\'s own calibrated rate is under 55% or the bucket has too few samples.'] }
  }
  const cont = r.state === 'continuation-likely'
  const reasons = [
    r.note,
    Number.isFinite(r.lastResponseRatio)
      ? `The last bar's response ratio was ${r.lastResponseRatio.toFixed(2)}x (above 1 = it moved more than usual for its activity, below 1 = less).`
      : 'No response ratio for the last bar.',
    `Calibrated on ${r.sampleSize} of this pair's own recent bars - ${cont ? 'bars like this tended to continue' : 'bars like this tended to reverse'}.`,
  ]
  return {
    id: 'mrc',
    title,
    ok: true,
    lean: r.direction,
    strength: Math.round(r.confidence),
    headline: `${cont ? 'Continuation' : 'Reversal'} likely - ${word(r.direction)} ${Math.round(r.confidence)}% (n=${r.sampleSize}).`,
    reasons,
  }
}

// ---------------------------------------------------------------------------
// Swing structure
// ---------------------------------------------------------------------------

export function explainSwing(sw: SwingResult, price: number): PanelVerdict {
  const title = 'Swing chart'
  const highs = sw.swings.filter((s) => s.kind === 'high')
  const lows = sw.swings.filter((s) => s.kind === 'low')
  if (highs.length < 2 || lows.length < 2) {
    return unreadable('swing', title, `Not enough confirmed swings yet (${highs.length} highs, ${lows.length} lows - needs 2 of each).`)
  }
  const lastHigh = highs[highs.length - 1]
  const lastLow = lows[lows.length - 1]
  const prevHigh = highs[highs.length - 2]
  const prevLow = lows[lows.length - 2]
  const reasons: string[] = []
  reasons.push(
    `Last two highs: ${prevHigh.price} then ${lastHigh.price} (${lastHigh.price > prevHigh.price ? 'higher' : lastHigh.price < prevHigh.price ? 'lower' : 'equal'}). Last two lows: ${prevLow.price} then ${lastLow.price} (${lastLow.price > prevLow.price ? 'higher' : lastLow.price < prevLow.price ? 'lower' : 'equal'}).`,
  )
  const brokeUp = price > lastHigh.price
  const brokeDown = price < lastLow.price
  if (brokeUp) reasons.push(`Price ${price} is above the last swing high ${lastHigh.price}.`)
  else if (brokeDown) reasons.push(`Price ${price} is below the last swing low ${lastLow.price}.`)
  else reasons.push(`Price ${price} is between the last swing low ${lastLow.price} and high ${lastHigh.price}.`)
  reasons.push(`A swing confirms ${sw.lookback} bars after it forms, so the newest ${sw.lookback} bars can't have one yet.`)

  let lean: Lean = 'none'
  let headline: string
  if (sw.structure === 'hh-hl') {
    if (brokeDown) headline = 'Higher highs / higher lows, but price just broke the last swing low - the uptrend structure is failing.'
    else {
      lean = 'call'
      headline = 'Uptrend structure: higher highs and higher lows.'
    }
  } else if (sw.structure === 'lh-ll') {
    if (brokeUp) headline = 'Lower highs / lower lows, but price just broke the last swing high - the downtrend structure is failing.'
    else {
      lean = 'put'
      headline = 'Downtrend structure: lower highs and lower lows.'
    }
  } else {
    headline = 'No clean structure - the highs and lows are not moving the same way.'
  }
  return { id: 'swing', title, ok: true, lean, strength: null, headline, reasons }
}

// ---------------------------------------------------------------------------
// Technical
// ---------------------------------------------------------------------------

export function explainTechnical(row: TechTfRow | null): PanelVerdict {
  const title = 'Technical'
  if (!row) return unreadable('technical', title, 'No technical read for this pair.')
  if (!row.ok) return unreadable('technical', title, row.note)
  const s = row.summary
  const lean: Lean = s.score >= TECH_LEAN_MIN ? 'call' : s.score <= -TECH_LEAN_MIN ? 'put' : 'none'
  const reasons = [
    `Oscillators: ${row.oscSummary.label} (${row.oscSummary.buys} buy, ${row.oscSummary.sells} sell of ${row.oscSummary.counted}).`,
    `Moving averages: ${row.maSummary.label} (${row.maSummary.buys} buy, ${row.maSummary.sells} sell of ${row.maSummary.counted}).`,
  ]
  const wanted = lean === 'call' ? 'buy' : lean === 'put' ? 'sell' : null
  if (wanted) {
    const notable = [...row.osc, ...row.mas].filter((v) => v.read === wanted).slice(0, 4)
    if (notable.length) reasons.push(`Voting ${wanted}: ${notable.map((v) => `${v.name} ${v.value}`).join(', ')}.`)
  }
  return {
    id: 'technical',
    title,
    ok: true,
    lean,
    strength: lean === 'none' ? null : Math.round(Math.abs(s.score) * 100),
    headline: `${s.label} - ${s.buys} buy vs ${s.sells} sell votes of ${s.counted}.`,
    reasons,
  }
}

// ---------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------

export function summarizeVerdicts(panels: PanelVerdict[]): ExplainerSummary {
  const readable = panels.filter((p) => p.ok)
  const call = readable.filter((p) => p.lean === 'call').length
  const put = readable.filter((p) => p.lean === 'put').length
  const flat = readable.length - call - put
  const unavailable = panels.length - readable.length
  const note =
    'Counts how many readers agree - not a probability. The five panels read the same candles, so their agreement is not five independent confirmations, and only each panel\'s own strength score is shown (none is a calibrated win rate against the payout breakeven).'
  const base = { call, put, flat, unavailable, readable: readable.length, note }
  if (!readable.length) return { ...base, lean: 'none', grade: 'none', headline: 'No panel can read this pair yet.' }
  if (call === 0 && put === 0) return { ...base, lean: 'none', grade: 'flat', headline: `Nothing leans - ${flat} of ${readable.length} readable panels are flat.` }
  if (call === put) return { ...base, lean: 'none', grade: 'mixed', headline: `Panels disagree: ${call} lean CALL vs ${put} lean PUT.` }
  const lean: Lean = call > put ? 'call' : 'put'
  const n = Math.max(call, put)
  const against = Math.min(call, put)
  const grade: ExplainerSummary['grade'] = against === 0 && n >= 3 ? 'aligned' : 'leaning'
  const headline = `${n} of ${readable.length} readable panels lean ${word(lean)}${against ? `, ${against} lean the other way` : ''}${flat ? `, ${flat} flat` : ''}.`
  return { ...base, lean, grade, headline }
}

// ---------------------------------------------------------------------------
// Effort Renko (effort-confirmed bricks) - a CHART beside the five panels.
// Kept out of summarizeVerdicts on purpose: the agreement count stays "five
// readers"; this is the volume/participation lens on top of them.
// ---------------------------------------------------------------------------

export interface EffortBrickOut {
  time: number
  open: number
  close: number
  dir: 1 | -1
  /** effort / trailing average (1.0 = average); null when no volume data or too early to average. */
  effortRatio: number | null
  confirmed: boolean
}

export interface EffortRead {
  ok: boolean
  lean: Lean
  strength: number | null
  headline: string
  reasons: string[]
  brickSize: number
  brickRule: string
  effortSource: 'volume' | 'none'
  trend: 'up' | 'down' | 'none'
  streak: number
  confirmedRatio: number
  regime: 'trending' | 'ranging' | 'choppy' | 'none'
  lookback: number
  /** the last `EFFORT_CHART_BRICKS` bricks, oldest first */
  bricks: EffortBrickOut[]
}

export const EFFORT_CHART_BRICKS = 60

export function explainEffort(r: EffortBarsResult | null): EffortRead {
  if (!r || r.bricks.length < 3) {
    return {
      ok: false, lean: 'none', strength: null,
      headline: 'Not enough bricks painted yet to read effort.',
      reasons: ['Effort Renko needs a few completed bricks; the price has not moved far enough yet on this timeframe.'],
      brickSize: r?.brickSize ?? 0, brickRule: r?.brickRule ?? '', effortSource: r?.effortSource ?? 'none',
      trend: 'none', streak: 0, confirmedRatio: 0, regime: 'none', lookback: r?.lookback ?? 20, bricks: [],
    }
  }
  const tail = r.bricks.slice(-EFFORT_CHART_BRICKS)
  const bricks: EffortBrickOut[] = tail.map((b) => ({
    time: b.time, open: b.open, close: b.close, dir: b.dir,
    effortRatio: Number.isFinite(b.effortRatio) ? Math.round(b.effortRatio * 100) / 100 : null,
    confirmed: b.confirmed,
  }))
  const last = r.bricks[r.bricks.length - 1]
  const reasons: string[] = []
  const trendWord = r.trend === 'up' ? 'up' : r.trend === 'down' ? 'down' : 'no direction'
  reasons.push(`${r.streak} ${trendWord} brick${r.streak === 1 ? '' : 's'} in a row (brick size ${r.brickRule}).`)
  let lean: Lean = 'none'
  let strength: number | null = null
  let headline: string
  if (r.effortSource === 'none') {
    headline = `Bricks run ${trendWord} but this feed carries no volume, so effort cannot be confirmed.`
    reasons.push('Every brick reads unconfirmed because the candle window has zero volume (common on synthetic/OTC feeds). Treat the bricks as plain Renko.')
  } else {
    reasons.push(
      `${Math.round(r.confirmedRatio * 100)}% of the last ${r.lookback} bricks were backed by at-least-average volume; the latest brick was ${last.confirmed ? 'confirmed' : 'NOT confirmed'}${Number.isFinite(last.effortRatio) ? ` (${last.effortRatio.toFixed(2)}x average effort)` : ''}.`,
    )
    if (r.regime === 'trending' && r.trend !== 'none') {
      lean = r.trend === 'up' ? 'call' : 'put'
      strength = Math.round(r.confirmedRatio * 100)
      headline = `Participation-backed ${trendWord}trend: effort confirms the bricks.`
      reasons.push('Regime is trending: confirmed bricks run mostly one way, so the move has real volume behind it.')
    } else if (r.regime === 'ranging') {
      headline = 'Ranging with real volume: confirmed bricks swing both ways.'
      reasons.push('Regime is ranging: genuine participation, but no side dominates - no directional lean.')
    } else if (r.regime === 'choppy') {
      headline = 'Choppy: price distance is painting bricks without volume behind it.'
      reasons.push('Regime is choppy: fewer than 60% of recent bricks are confirmed, the classic whipsaw signature - no lean.')
    } else {
      headline = 'Regime not readable yet (fewer than the lookback of bricks painted).'
    }
  }
  return {
    ok: true, lean, strength, headline, reasons,
    brickSize: r.brickSize, brickRule: r.brickRule, effortSource: r.effortSource,
    trend: r.trend, streak: r.streak, confirmedRatio: Math.round(r.confirmedRatio * 1000) / 1000,
    regime: r.regime, lookback: r.lookback, bricks,
  }
}
