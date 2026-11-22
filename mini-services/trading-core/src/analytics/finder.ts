// IQAIR//OS - FINDER: one trade, picked from the whole market.
// For one asset it reads SEVERAL timeframes and tells the story of each: the pm (who is pushing) + nm (where price is, what followed from here) + weather (dead / squeeze / trend / range) blended by the EDITOR,
// then run through PMM's market-structure gate (swings, HH/HL/LH/LL, walls) and the trading plan (is the trend already too far, is price inside an avoid zone), plus the clock (session).
// A trade is only offered when SEVERAL frames independently agree on one side, none disagrees, nothing is blocked, and the score clears a bar. Most of the time the honest answer is "nothing worth taking".
//   OPTION : the expiry (1-30 min) is chosen by asking nm, for the agreeing frame, which horizon its similar past moments favoured most (walk-forward, shrunk), not a fixed guess.
//   CFD    : entry / stop / target from the pm plan (structure stop + structure target, min reward:risk), checked against the swing walls; tp/sl also given in % of price for the ticket.
// HONESTY: this stacks models that read the SAME candles, so agreement is weaker evidence than it looks; the score weights are judgement, not fitted; "almost never wrong" is not something any of this can promise.
// The result carries the measured walk-forward records of pm and nm for the pair so the evidence can be judged, and says plainly when it found nothing.
import { readEditor, type EditorResult } from './editor'
import { readNextMove } from './nextmove'
import { readPmm, type PmmResult } from './pmm'
import { readPlan, type PlanResult } from './tradingplan'
import { readCfdPlan, type CfdPlan } from './cfdplan'
import { classifySession } from './session'
import type { CeCandle, CeTick } from './causeeffect'

export interface FinderFrame { tf: string; sec: number; candles: CeCandle[] }
export interface FinderOptions { mode: 'option' | 'cfd'; minScore?: number; minFrames?: number; nowSec?: number; ticks?: readonly CeTick[]; otc?: boolean; asset?: string }
export interface FrameRead { tf: string; sec: number; dir: 'call' | 'put' | 'none'; strength: number; prob: number; agreement: string; regime: string; pmValidated: boolean; nmValidated: boolean; pmRecord: string; nmRecord: string; structure: string; blocks: string[]; boosts: string[]; room: number; text: string }
export interface FinderExpiry { minutes: number; bars: number; tf: string; prob: number; basis: string; table: Array<{ minutes: number; prob: number }> }
export interface FinderCfd { entry: number; stop: number; target: number; rr: number; ev: number; riskAtr: number; rewardAtr: number; tpPct: number; slPct: number; stopKind: string; targetKind: string; text: string }
export interface FinderResult {
  ok: boolean; found: boolean; asset: string; otc: boolean; mode: 'option' | 'cfd'
  side: 'call' | 'put' | 'none'; score: number; grade: 'A' | 'B' | 'C' | ''; tf: string; barLeftSec: number
  frames: FrameRead[]; agree: number; against: number
  expiry: FinderExpiry | null; cfd: FinderCfd | null
  story: string[]; reasons: string[]; rejected: string[]; session: string; text: string
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const rec = (n: number, hit: number) => (n > 0 ? `${(hit * 100).toFixed(0)}% of ${n}` : 'none yet')

export function readFrame(f: FinderFrame, htf: FinderFrame | null, o: FinderOptions): { read: FrameRead; ed: EditorResult; pmm: PmmResult } | null {
  if (f.candles.length < 260) return null
  const ticks = f.sec <= 60 ? o.ticks : undefined
  const ed = readEditor(f.candles, ticks, htf?.candles ?? null, { htfTf: htf?.tf ?? 'none', otc: o.otc })
  if (!ed.ok) return null
  const pmm = readPmm(f.candles, { ok: true, dir: ed.dir, prob: ed.prob, strength: ed.strength })
  const dir = pmm.ok ? pmm.dir : ed.dir
  const blocks = [...(pmm.ok ? pmm.blocks : [])]
  if (ed.dir !== 'none' && dir === 'none' && !blocks.length) blocks.push('structure gate')
  const trig = ed.pm.trigger
  const read: FrameRead = {
    tf: f.tf, sec: f.sec, dir, strength: pmm.ok ? pmm.strength : ed.strength, prob: pmm.ok ? pmm.prob : ed.prob, agreement: ed.agreement, regime: ed.regime,
    pmValidated: trig.validation.validated, nmValidated: ed.nm.ok && ed.nm.nm.validated, pmRecord: rec(trig.validation.trackN, trig.validation.trackHit), nmRecord: ed.nm.ok ? rec(ed.nm.validation.trackN, ed.nm.validation.trackHit) : 'none yet',
    structure: pmm.ok ? pmm.structure : 'unclear', blocks, boosts: pmm.ok ? pmm.boosts : [], room: pmm.ok ? pmm.room : 99, text: ed.text,
  }
  return { read, ed, pmm }
}

export function chooseExpiry(f: FinderFrame, side: 'call' | 'put', otc: boolean, maxMin = 30): FinderExpiry {
  const mins = f.sec / 60
  const table: Array<{ minutes: number; prob: number }> = []
  let best: { minutes: number; bars: number; prob: number } | null = null
  const horizons = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30]
  for (const h of horizons) {
    const minutes = Math.max(1, Math.round(h * mins))
    if (minutes > maxMin || (table.length && table[table.length - 1].minutes === minutes)) continue
    let nm
    try { nm = readNextMove(f.candles, { horizon: h, otc }) } catch { continue }
    if (!nm.ok) continue
    const p = side === 'call' ? nm.nm.horizonProb : 1 - nm.nm.horizonProb
    table.push({ minutes, prob: p })
    if (nm.nm.validated && (!best || p > best.prob + 0.005)) best = { minutes, bars: h, prob: p }
  }
  const natural = Math.max(1, Math.ceil(mins))
  if (best && best.prob >= 0.52) return { minutes: best.minutes, bars: best.bars, tf: f.tf, prob: best.prob, basis: `nm's similar past moments favoured ${best.minutes} min most (${(best.prob * 100).toFixed(0)}%, validated)`, table }
  return { minutes: natural, bars: Math.max(1, Math.round(natural / Math.max(mins, 1 / 60))), tf: f.tf, prob: 0.5, basis: 'no horizon had a validated edge above 52%; defaulting to one bar of the frame', table }
}

export function readFinderAsset(frames: FinderFrame[], o: FinderOptions): FinderResult {
  const asset = o.asset ?? '', otc = !!o.otc, nowSec = o.nowSec ?? Math.floor(Date.now() / 1000)
  const sorted = [...frames].sort((a, b) => a.sec - b.sec)
  const session = classifySession(nowSec, asset)
  const base = (extra: Partial<FinderResult>): FinderResult => ({ ok: true, found: false, asset, otc, mode: o.mode, side: 'none', score: 0, grade: '', tf: '', barLeftSec: 0, frames: [], agree: 0, against: 0, expiry: null, cfd: null, story: [], reasons: [], rejected: [], session, text: '', ...extra })
  const reads: Array<{ read: FrameRead; ed: EditorResult; pmm: PmmResult; frame: FinderFrame }> = []
  for (let i = 0; i < sorted.length; i++) {
    const r = readFrame(sorted[i], sorted[i + 1] ?? null, o)
    if (r) reads.push({ ...r, frame: sorted[i] })
  }
  if (reads.length < 2) return base({ rejected: [`only ${reads.length} timeframe(s) have enough history`], text: 'Not enough history across timeframes.' })
  const frameReads = reads.map((r) => r.read)
  const calls = reads.filter((r) => r.read.dir === 'call'), puts = reads.filter((r) => r.read.dir === 'put')
  const side: 'call' | 'put' | 'none' = calls.length > puts.length ? 'call' : puts.length > calls.length ? 'put' : 'none'
  const rejected: string[] = []
  const minFrames = o.minFrames ?? 2
  if (side === 'none') return base({ frames: frameReads, rejected: ['the timeframes do not lean one way'], text: 'No call: the timeframes do not lean one way.' })
  const agreeing = side === 'call' ? calls : puts, against = side === 'call' ? puts.length : calls.length
  if (agreeing.length < minFrames) rejected.push(`only ${agreeing.length} timeframe(s) agree (need ${minFrames})`)
  if (against > 0) rejected.push(`${against} timeframe(s) point the other way`)
  // the best frame to trade on: strongest agreeing; a validated nm record is preferred. pm needs only a call (ok) - its own validated / bucketN / strength gates are gone; nm is unchanged.
  const best = [...agreeing].sort((a, b) => (Number(b.read.nmValidated) - Number(a.read.nmValidated)) || (b.read.strength - a.read.strength))[0]
  const wxBad = reads.find((r) => r.ed.regime === 'dead')
  if (wxBad) rejected.push(`dead market on ${wxBad.read.tf}`)
  // trading plan on a mid frame (trend maturity + avoid zones)
  let plan: PlanResult | null = null
  const planFrame = reads.find((r) => r.frame.sec >= 60 && r.frame.candles.length >= 300) ?? reads[0]
  try { plan = readPlan(planFrame.frame.candles, { otc, light: true }) } catch { plan = null }
  const want = side === 'call' ? 'up' : 'down'
  if (plan?.ok) {
    if (plan.trend.dir === want && plan.trend.tooFar) rejected.push(`the ${want}trend has already gone too far (${(plan.trend.maturity * 100).toFixed(0)}th percentile of past trends)`)
    const av = plan.avoid.find((a) => a.active && (a.side === side || a.side === 'both') && a.kind === 'price')
    if (av) rejected.push(`price is inside an avoid zone: ${av.reason}`)
  }
  const frameBlocks = best.read.blocks
  if (frameBlocks.length) rejected.push(...frameBlocks.map((b) => `${best.read.tf}: ${b}`))
  // score (judgement weights)
  const meanStrength = agreeing.reduce((s, r) => s + r.read.strength, 0) / agreeing.length
  const agreeFrac = agreeing.length / reads.length
  const evidence = agreeing.reduce((s, r) => s + Number(r.read.nmValidated), 0) / agreeing.length
  const room = clamp(best.read.room >= 90 ? 1 : best.read.room / 2, 0, 1)
  const timeQ = otc ? 0.6 : session === 'OVERLAP' ? 1 : session === 'LONDON' || session === 'NEWYORK' ? 0.8 : session === 'ASIA' ? 0.5 : 0.3
  const wxFit = best.ed.wx.ok ? (best.ed.regime === 'expansion' || (best.ed.regime === 'trend-up' && side === 'call') || (best.ed.regime === 'trend-down' && side === 'put') ? 1 : best.ed.regime === 'squeeze' ? 0.3 : 0.6) : 0.5
  const score = Math.round(clamp(0.40 * meanStrength + 20 * agreeFrac + 18 * evidence + 8 * room + 7 * timeQ + 7 * wxFit, 0, 100))
  const minScore = o.minScore ?? 60
  if (score < minScore) rejected.push(`score ${score} is below the bar of ${minScore}`)
  const barLeft = Math.max(0, best.frame.sec - (nowSec % best.frame.sec))
  const story = [
    `Time: ${session}${otc ? ' (OTC, no real session)' : ''}, ${best.read.tf} bar closes in ${Math.round(barLeft)}s.`,
    `Regime/weather on ${best.read.tf}: ${best.ed.wx.ok ? best.ed.wx.text : best.ed.regime}.`,
    `Structure on ${best.read.tf}: ${best.read.structure}${best.pmm.ok && best.pmm.sequence ? ' (' + best.pmm.sequence + ')' : ''}${best.pmm.ok && best.pmm.boosts.length ? '; ' + best.pmm.boosts.join('; ') : ''}.`,
    plan?.ok ? `Trend: ${plan.trend.dir === 'none' ? 'none' : plan.trend.dir + 'trend, ' + plan.trend.stage + (plan.trend.tooFar ? ', gone too far' : plan.trend.fresh ? ', fresh' : '')}.` : 'Trend: not readable.',
    `pm/nm on ${best.read.tf}: ${best.read.text}`,
    `Timeframes: ${frameReads.map((r) => `${r.tf} ${r.dir === 'none' ? '-' : r.dir === 'call' ? '▲' : '▼'}${r.strength}`).join('  ')}`,
    `Evidence: pm record ${best.read.pmRecord}, nm record ${best.read.nmRecord}.`,
  ]
  const common = { frames: frameReads, agree: agreeing.length, against, story, session, tf: best.read.tf, barLeftSec: barLeft, score, side }
  if (rejected.length) return base({ ...common, rejected, text: `No trade on ${asset}: ${rejected.join('; ')}.` })
  const grade: 'A' | 'B' | 'C' = score >= 80 ? 'A' : score >= 70 ? 'B' : 'C'
  let expiry: FinderExpiry | null = null, cfd: FinderCfd | null = null
  if (o.mode === 'option') expiry = chooseExpiry(best.frame, side, otc)
  else {
    const hi = sorted[sorted.indexOf(best.frame) + 1] ?? null
    let p: CfdPlan | null = null
    try { p = readCfdPlan(best.frame.candles, best.frame.sec <= 60 ? o.ticks : undefined, hi?.candles ?? null, { htfTf: hi?.tf ?? 'none', otc }) } catch { p = null }
    if (!p || !p.ok || p.direction !== side) return base({ ...common, rejected: [`no CFD plan: ${p?.error ?? p?.text ?? 'unavailable'}`], text: `No CFD setup on ${asset}.` })
    if (p.rr < 1.5 || p.ev <= 0) return base({ ...common, rejected: [`CFD plan rejected: reward:risk ${p.rr.toFixed(2)}, expected ${p.ev.toFixed(2)}R`], text: `No CFD setup on ${asset}: the reward does not justify the risk.` })
    cfd = { entry: p.entry, stop: p.stop, target: p.target, rr: p.rr, ev: p.ev, riskAtr: p.riskAtr, rewardAtr: p.rewardAtr, tpPct: (p.rewardDist / p.entry) * 100, slPct: (p.riskDist / p.entry) * 100, stopKind: p.stopKind, targetKind: p.targetKind, text: p.text }
  }
  const reasons = [`${agreeing.length}/${reads.length} timeframes agree on ${side.toUpperCase()}, none against`, ...best.read.boosts]
  const text = `${side.toUpperCase()} ${asset} (${grade}, score ${score}) on ${best.read.tf}: ${reasons.join('; ')}.${expiry ? ` Expiry ${expiry.minutes} min (${expiry.basis}).` : ''}${cfd ? ` ${cfd.text}` : ''}`
  return base({ ...common, found: true, grade, expiry, cfd, reasons, text })
}
