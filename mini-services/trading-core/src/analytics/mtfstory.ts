// IQAIR//OS - MULTI-TIMEFRAME STORY: read the story of the big candles (a 4h session candle, a 15m candle) through every chart type and turn what they say into a direction for the
// small timeframe being traded (1m / 5m).
//
// For each higher timeframe it collects: the last closed candle's story, the 14-bar window story, the 21-bar swing structure (HH/HL/LH/LL), and the Renko, Kagi, Baseline and Heikin Ashi
// equivalents of that timeframe's candles. Each reading becomes a vote between -1 (bearish) and +1 (bullish); the frame's score is the average of its votes. The two higher frames
// are blended into a CONTEXT score (the lean the bigger picture gives), and the trading timeframe's own story is the TRIGGER: only when the trigger agrees with the context is there a
// direction; a trigger moving against the context is read as a pullback to wait out, not a signal.
//
// HONESTY: this is a rule-based synthesis of descriptions. The votes and weights are my own judgement, not fitted to outcomes - nothing here has a measured edge. Use it to organise the
// read and as a filter, and backtest the resulting script (`story.mtf(...)`) before trusting any threshold.
import type { Candle } from '../types'
import { readStory, readWindowStory, readStructure, type StoryBars } from './candlestory'
import { storyRenko, storyKagi, storyBaseline, storyHeikin } from './charttypestory'

export interface FrameVote { name: string; vote: number; why: string }
export interface FrameStory {
  tf: string; ok: boolean; error?: string
  votes: FrameVote[]; score: number; agreement: number          // score -1..1, agreement = share of non-zero votes that share the majority sign
  candleKind: string; windowKind: string; structure: string; renko: string; kagi: string; baseline: string; ha: string
  moveSigma: number; netSigma: number
  lines: string[]                                                 // one readable line per chart type
}
export interface MtfResult {
  ok: boolean; error?: string
  triggerTf: string
  direction: 'call' | 'put' | 'none'   // actionable: context and trigger agree
  lean: 'call' | 'put' | 'none'        // what the bigger picture leans toward even if the trigger has not confirmed
  alignment: 'aligned' | 'wait-for-trigger' | 'pullback-against-context' | 'no-context'
  confidence: number                   // 0..100, how strongly everything lines up (NOT a win probability)
  contextScore: number; triggerScore: number
  frames: FrameStory[]; trigger: FrameStory | null
  warnings: string[]
  text: string
}

const bars = (c: Candle[]): StoryBars => ({ open: c.map((x) => x.open), high: c.map((x) => x.high), low: c.map((x) => x.low), close: c.map((x) => x.close), time: c.map((x) => x.time) })
const clamp = (x: number, a = -1, b = 1) => Math.max(a, Math.min(b, x))
const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0)

export function readFrame(tf: string, candles: Candle[]): FrameStory {
  const empty = (error: string): FrameStory => ({ tf, ok: false, error, votes: [], score: 0, agreement: 0, candleKind: '', windowKind: '', structure: '', renko: '', kagi: '', baseline: '', ha: '', moveSigma: NaN, netSigma: NaN, lines: [] })
  if (candles.length < 60) return empty(`only ${candles.length} closed ${tf} candles (need 60)`)
  const b = bars(candles)
  const votes: FrameVote[] = []
  const lines: string[] = []
  const add = (name: string, vote: number, why: string) => votes.push({ name, vote: clamp(vote), why })

  const st = readStory(b)
  let candleVote = 0
  if (st.ok) {
    if (st.kind === 'rejection-high') candleVote = -0.8; else if (st.kind === 'rejection-low') candleVote = 0.8
    else if (st.sweep) candleVote = st.sweep * 0.8
    else if (st.kind === 'marubozu' || st.kind === 'drive') candleVote = st.dir * 0.8
    else if (st.kind === 'doji' || st.kind === 'spinning-top') candleVote = 0
    else candleVote = st.dir * 0.4
    add('candle', candleVote, `${st.kind}${st.sweep ? ' + sweep' : ''}`)
    lines.push(`candle: ${st.text}`)
  }
  const w = readWindowStory(b, 14)
  if (w.ok) {
    const m: Record<string, number> = { 'trend-up': 1, 'trend-down': -1, 'drift-up': 0.5, 'drift-down': -0.5, 'reversal-up': 0.8, 'reversal-down': -0.8, 'exhausting-up': -0.4, 'exhausting-down': 0.4 }
    add('window14', m[w.kind] ?? 0, w.kind); lines.push(`14 bars: ${w.text}`)
  }
  const sx = readStructure(b, 21)
  if (sx.ok) {
    const base = sx.structure === 'uptrend' ? 1 : sx.structure === 'downtrend' ? -1 : 0
    add('structure21', clamp(base + (sx.brokeHigh ? 0.3 : 0) - (sx.brokeLow ? 0.3 : 0)), `${sx.structure}${sx.brokeHigh ? ', closed above last swing high' : sx.brokeLow ? ', closed below last swing low' : ''} (${sx.sequence || 'no swings'})`)
    lines.push(`structure (21): ${sx.structure}; swings ${sx.sequence || 'none'}; ${sx.hh} HH ${sx.hl} HL ${sx.lh} LH ${sx.ll} LL`)
  }
  const rk = storyRenko(candles)
  let renkoKind = ''
  if (rk.ok) { const m: Record<string, number> = { 'extended-run': 0.8, 'trend-run': 1, 'fresh-reversal': 0.7, building: 0.5, chop: 0 }; add('renko', rk.dir * (m[rk.kind] ?? 0), rk.kind); renkoKind = rk.kind; lines.push(`renko: ${rk.text}`) }
  const kg = storyKagi(candles)
  let kagiKind = ''
  if (kg.ok) { const m: Record<string, number> = { 'yang-trend': 1, 'yin-trend': -1, 'weak-up': 0.4, 'weak-down': -0.4, 'fresh-reversal-up': 0.7, 'fresh-reversal-down': -0.7, choppy: 0, flat: 0 }; add('kagi', m[kg.kind] ?? 0, kg.kind); kagiKind = kg.kind; lines.push(`kagi: ${kg.text}`) }
  const bl = storyBaseline(candles, 30, 'mid')
  let blKind = ''
  if (bl.ok) { const fresh = bl.kind.startsWith('fresh-cross'); add('baseline', bl.kind === 'chop-around-base' || bl.kind === 'hugging-base' ? 0 : (fresh ? 1 : 0.7) * bl.dir, bl.kind); blKind = bl.kind; lines.push(`baseline: ${bl.text}`) }
  const ha = storyHeikin(candles)
  let haKind = ''
  if (ha.ok) { const m: Record<string, number> = { 'strong-up': 1, 'strong-down': 1, up: 0.6, down: 0.6, 'weakening-up': 0.3, 'weakening-down': 0.3, 'flip-up': 0.7, 'flip-down': 0.7, indecision: 0, chop: 0 }; add('heikin', ha.dir * (m[ha.kind] ?? 0), ha.kind); haKind = ha.kind; lines.push(`heikin ashi: ${ha.text}`) }

  const nz = votes.filter((v) => v.vote !== 0)
  const score = votes.length ? votes.reduce((a, v) => a + v.vote, 0) / votes.length : 0
  const maj = sgn(score)
  const agreement = nz.length && maj !== 0 ? nz.filter((v) => sgn(v.vote) === maj).length / nz.length : 0
  return { tf, ok: votes.length > 0, votes, score, agreement, candleKind: st.kind ?? '', windowKind: w.kind ?? '', structure: sx.structure ?? '', renko: renkoKind, kagi: kagiKind, baseline: blKind, ha: haKind, moveSigma: st.moveSigma, netSigma: w.netSigma, lines }
}

/** `frames` = the higher timeframes' closed candles in order of importance (biggest first), `trigger` = the timeframe being traded. */
export function readMtf(triggerTf: string, trigger: Candle[], higher: { tf: string; candles: Candle[] }[]): MtfResult {
  const frames = higher.map((h) => readFrame(h.tf, h.candles))
  const trig = readFrame(triggerTf, trigger)
  const good = frames.filter((f) => f.ok)
  const none = (error: string): MtfResult => ({ ok: false, error, triggerTf, direction: 'none', lean: 'none', alignment: 'no-context', confidence: 0, contextScore: 0, triggerScore: trig.ok ? trig.score : 0, frames, trigger: trig.ok ? trig : null, warnings: [], text: error })
  if (!good.length) return none(`no usable higher timeframe: ${frames.map((f) => `${f.tf} (${f.error})`).join('; ')}`)
  if (!trig.ok) return none(`the ${triggerTf} trigger timeframe has too little data (${trig.error})`)
  // bigger frame weighs more: weights 1, 0.8, 0.6 ... normalised
  const wts = good.map((_, i) => Math.max(0.3, 1 - i * 0.2)); const wsum = wts.reduce((a, b) => a + b, 0)
  const ctx = good.reduce((a, f, i) => a + f.score * wts[i], 0) / wsum
  const tr = trig.score
  const lean: 'call' | 'put' | 'none' = Math.abs(ctx) < 0.2 ? 'none' : ctx > 0 ? 'call' : 'put'
  const warnings: string[] = []
  for (const f of good) {
    if (Number.isFinite(f.netSigma) && Math.abs(f.netSigma) >= 2) warnings.push(`${f.tf} move over 14 bars is ${f.netSigma >= 0 ? '+' : ''}${f.netSigma.toFixed(1)} sigma - stretched, a reversal or pause is more likely than usual`)
    if (/exhausting/.test(f.windowKind)) warnings.push(`${f.tf} trend is exhausting (shrinking bodies, wicks against it)`)
    if (f.agreement < 0.6 && f.votes.length >= 4) warnings.push(`${f.tf} readings disagree with each other (${(f.agreement * 100).toFixed(0)}% agreement)`)
  }
  if (good.length >= 2 && Math.sign(good[0].score) !== 0 && Math.sign(good[1].score) !== 0 && Math.sign(good[0].score) !== Math.sign(good[1].score)) warnings.push(`${good[0].tf} and ${good[1].tf} lean opposite ways`)
  let alignment: MtfResult['alignment'], direction: 'call' | 'put' | 'none' = 'none', confidence = 0
  if (lean === 'none') { alignment = 'no-context'; confidence = 0 }
  else if (Math.abs(tr) >= 0.2 && sgn(tr) === sgn(ctx)) { alignment = 'aligned'; direction = lean; confidence = Math.round(100 * clamp(0.6 * Math.abs(ctx) + 0.4 * Math.abs(tr), 0, 1)) }
  else if (Math.abs(tr) >= 0.3 && sgn(tr) !== sgn(ctx)) { alignment = 'pullback-against-context'; confidence = Math.round(100 * Math.abs(ctx) * 0.4) }
  else { alignment = 'wait-for-trigger'; confidence = Math.round(100 * Math.abs(ctx) * 0.5) }
  if (warnings.length && direction !== 'none') confidence = Math.max(0, confidence - 10 * Math.min(3, warnings.length))
  const sd = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2)
  const parts: string[] = []
  parts.push(`Higher timeframes: ${good.map((f) => `${f.tf} ${sd(f.score)} (${f.score > 0.2 ? 'bullish' : f.score < -0.2 ? 'bearish' : 'neutral'}, ${(f.agreement * 100).toFixed(0)}% of readings agree)`).join(', ')} -> context ${sd(ctx)} (${lean === 'none' ? 'no clear lean' : 'leans ' + (lean === 'call' ? 'UP' : 'DOWN')}).`)
  parts.push(`Trigger ${triggerTf}: ${sd(tr)} (${tr > 0.2 ? 'bullish' : tr < -0.2 ? 'bearish' : 'neutral'}).`)
  parts.push(alignment === 'aligned' ? `They line up: ${direction === 'call' ? 'CALL' : 'PUT'} bias, strength ${confidence}/100.` : alignment === 'pullback-against-context' ? `The ${triggerTf} is moving AGAINST the bigger lean (a pullback) - wait for it to turn back with the context rather than fade it.` : alignment === 'wait-for-trigger' ? `The bigger picture leans ${lean === 'call' ? 'UP' : 'DOWN'} but the ${triggerTf} has not confirmed yet - wait for the trigger.` : 'The higher timeframes give no clear lean, so there is nothing to prepare.')
  if (warnings.length) parts.push('Caution: ' + warnings.join('; ') + '.')
  return { ok: true, triggerTf, direction, lean, alignment, confidence, contextScore: ctx, triggerScore: tr, frames, trigger: trig, warnings, text: parts.join(' ') }
}
