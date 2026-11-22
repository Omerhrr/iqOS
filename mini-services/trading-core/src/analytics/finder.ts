// IQAIR//OS - FINDER: one trade, picked from the whole market.
// For one asset it reads SEVERAL timeframes and tells the story of each: the pm (who is pushing) + nm (where price is, what followed from here) + weather (dead / squeeze / trend / range) blended by the EDITOR,
// then run through PMM's market-structure gate (swings, HH/HL/LH/LL, walls) and the trading plan (is the trend already too far, is price inside an avoid zone), plus the clock (session).
// The trade is the call of the single BEST timeframe (no multi-timeframe agreement is required - other frames agreeing only raises the score); it is offered when nothing is blocked and the score clears a bar. Technicals (the 11 oscillator + MA votes) vote into the score and the story. Most of the time the honest answer is "nothing worth taking".
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
import { summarizeTf } from './technicals'
import type { CeCandle, CeTick } from './causeeffect'

export interface FinderFrame { tf: string; sec: number; candles: CeCandle[] }
export interface FinderOptions { mode: 'option' | 'cfd'; minScore?: number; minFrames?: number; nowSec?: number; ticks?: readonly CeTick[]; otc?: boolean; asset?: string }
export interface FrameRead { tf: string; sec: number; dir: 'call' | 'put' | 'none'; strength: number; prob: number; agreement: string; regime: string; pmValidated: boolean; nmValidated: boolean; tech: string; techScore: number; pmRecord: string; nmRecord: string; structure: string; blocks: string[]; boosts: string[]; room: number; text: string }
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
  // loosened nm: when nm and pm conflict (the editor stands down) the pm call stands - pm needs only to be ok. A dead market still stands down.
  const pmCall = ed.pm.ok ? ed.pm.dir : 'none'
  const edDir = ed.dir !== 'none' ? ed.dir : (ed.regime !== 'dead' && pmCall !== 'none' ? pmCall : 'none')
  const pmmIn = edDir === ed.dir ? { ok: true, dir: ed.dir, prob: ed.prob, strength: ed.strength } : { ok: true, dir: edDir, prob: ed.pm.ok ? ed.pm.prob : 0.5, strength: ed.pm.ok ? ed.pm.strength : 0 }
  const pmm = readPmm(f.candles, pmmIn)
  const dir = pmm.ok ? pmm.dir : edDir
  const blocks = [...(pmm.ok ? pmm.blocks : [])]
  if (ed.dir !== 'none' && dir === 'none' && !blocks.length) blocks.push('structure gate')
  const trig = ed.pm.trigger
  let techLabel = 'n/a', techScore = 0
  try { const tr = summarizeTf(f.tf, f.sec, 'native', f.candles); if (tr.ok) { techLabel = tr.summary.label; techScore = tr.summary.score } } catch { /* technicals optional */ }
  const read: FrameRead = {
    tf: f.tf, sec: f.sec, dir, strength: pmm.ok ? pmm.strength : pmmIn.strength, prob: pmm.ok ? pmm.prob : pmmIn.prob, agreement: ed.agreement, regime: ed.regime,
    pmValidated: trig.validation.validated, nmValidated: ed.nm.ok && ed.nm.nm.validated, tech: techLabel, techScore, pmRecord: rec(trig.validation.trackN, trig.validation.trackHit), nmRecord: ed.nm.ok ? rec(ed.nm.validation.trackN, ed.nm.validation.trackHit) : 'none yet',
    structure: pmm.ok ? pmm.structure : 'unclear', blocks, boosts: pmm.ok ? pmm.boosts : [], room: pmm.ok ? pmm.room : 99, text: ed.text,
  }
  return { read, ed, pmm }
}

export function chooseExpiry(f: FinderFrame, side: 'call' | 'put', otc: boolean, maxMin = 30): FinderExpiry {
  const mins = f.sec / 60
  const table: Array<{ minutes: number; prob: number }> = []
  let best: { minutes: number; bars: number; prob: number; v?: boolean } | null = null
  const horizons = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30]
  for (const h of horizons) {
    const minutes = Math.max(1, Math.round(h * mins))
    if (minutes > maxMin || (table.length && table[table.length - 1].minutes === minutes)) continue
    let nm
    try { nm = readNextMove(f.candles, { horizon: h, otc }) } catch { continue }
    if (!nm.ok) continue
    const p = side === 'call' ? nm.nm.horizonProb : 1 - nm.nm.horizonProb
    table.push({ minutes, prob: p })
    if (!best || p > best.prob + 0.005) best = { minutes, bars: h, prob: p, v: nm.nm.validated } // loosened: a horizon need not be validated, the best one wins (validated is only noted)
  }
  const natural = Math.max(1, Math.ceil(mins))
  if (best && best.prob >= 0.505) return { minutes: best.minutes, bars: best.bars, tf: f.tf, prob: best.prob, basis: `nm's similar past moments favoured ${best.minutes} min most (${(best.prob * 100).toFixed(0)}%${best.v ? ', validated' : ', not validated'})`, table }
  return { minutes: natural, bars: Math.max(1, Math.round(natural / Math.max(mins, 1 / 60))), tf: f.tf, prob: 0.5, basis: 'no horizon leaned clearly; defaulting to one bar of the frame', table }
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
  if (reads.length < 1) return base({ rejected: ['no timeframe has enough history'], text: 'Not enough history.' })
  const frameReads = reads.map((r) => r.read)
  // the BEST single frame decides the side: strongest call (a validated nm and agreeing technicals lift it a little). Other frames only add to the score.
  const callers = reads.filter((r) => r.read.dir !== 'none')
  const rejected: string[] = []
  if (!callers.length) return base({ frames: frameReads, rejected: ['no timeframe has a call'], text: 'No call on any timeframe.' })
  const lift = (r: typeof reads[number]) => r.read.strength + (r.read.nmValidated ? 4 : 0) + (r.read.dir === 'call' ? r.read.techScore : -r.read.techScore) * 8
  const best = [...callers].sort((a, b) => lift(b) - lift(a))[0]
  const side: 'call' | 'put' = best.read.dir as 'call' | 'put'
  const agreeing = callers.filter((r) => r.read.dir === side)
  const against = callers.length - agreeing.length
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
  const meanStrength = best.read.strength
  const agreeFrac = agreeing.length / Math.max(1, reads.length)
  const evidence = Number(best.read.nmValidated)
  const techSigned = side === 'call' ? best.read.techScore : -best.read.techScore
  const techFit = clamp(0.5 + techSigned * 0.5, 0, 1)
  const room = clamp(best.read.room >= 90 ? 1 : best.read.room / 2, 0, 1)
  const timeQ = otc ? 0.6 : session === 'OVERLAP' ? 1 : session === 'LONDON' || session === 'NEWYORK' ? 0.8 : session === 'ASIA' ? 0.5 : 0.3
  const wxFit = best.ed.wx.ok ? (best.ed.regime === 'expansion' || (best.ed.regime === 'trend-up' && side === 'call') || (best.ed.regime === 'trend-down' && side === 'put') ? 1 : best.ed.regime === 'squeeze' ? 0.3 : 0.6) : 0.5
  const score = Math.round(clamp(0.36 * meanStrength + 12 * agreeFrac + 10 * evidence + 8 * room + 7 * timeQ + 7 * wxFit + 20 * techFit, 0, 100))
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
    `Technicals on ${best.read.tf}: ${best.read.tech} (${best.read.techScore >= 0 ? '+' : ''}${best.read.techScore.toFixed(2)}), ${techSigned >= 0.15 ? 'agree with the trade' : techSigned <= -0.15 ? 'lean against the trade' : 'neutral'}.`,
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
  const reasons = [`best call is ${best.read.tf} (${agreeing.length}/${reads.length} frames lean ${side.toUpperCase()}${against ? `, ${against} the other way` : ''}); technicals ${best.read.tech}`, ...best.read.boosts]
  const text = `${side.toUpperCase()} ${asset} (${grade}, score ${score}) on ${best.read.tf}: ${reasons.join('; ')}.${expiry ? ` Expiry ${expiry.minutes} min (${expiry.basis}).` : ''}${cfd ? ` ${cfd.text}` : ''}`
  return base({ ...common, found: true, grade, expiry, cfd, reasons, text })
}
