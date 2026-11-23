// IQAIR//OS - FINDER: one trade, picked from the whole market.
// For one asset it reads SEVERAL timeframes and tells the story of each: the pm (who is pushing, PURE pm) + the WEIS WAVE (does the running wave's volume back the move or is it spent) + weather (dead / squeeze / trend / range),
// then run through PMM's market-structure gate (swings, HH/HL/LH/LL, walls) and the trading plan (is the trend already too far, is price inside an avoid zone), plus the clock (session).
// The trade is the call of the single BEST timeframe (no multi-timeframe agreement is required - other frames agreeing only raises the score); it is offered when nothing is blocked and the score clears a bar. Technicals (the 11 oscillator + MA votes) vote into the score and the story. Most of the time the honest answer is "nothing worth taking".
//   OPTION : the expiry (1-30 min) follows the typical length of the frame's recent waves in the trade's direction (Weis wave), snapped to the usual expiries. It is a rhythm estimate, NOT a measured best horizon.
//   CFD    : entry / stop / target from the pm plan (structure stop + structure target, min reward:risk), checked against the swing walls; tp/sl also given in % of price for the ticket.
// HONESTY: this stacks models that read the SAME candles, so agreement is weaker evidence than it looks; the score weights are judgement, not fitted; "almost never wrong" is not something any of this can promise.
// The result carries the measured walk-forward record of pm for the pair and the Weis wave read of each frame so the evidence can be judged, and says plainly when it found nothing.
import { readCauseEffect, combineCeMtf, type CeMtf, type CeResult } from './causeeffect'
import { readWeather, type WxResult } from './weather'
import { readWeisWave, type WwRead } from './weiswave'
import { readPmm, type PmmResult } from './pmm'
import { readPlan, type PlanResult } from './tradingplan'
import { readCfdPlan, type CfdPlan } from './cfdplan'
import { classifySession } from './session'
import { summarizeTf } from './technicals'
import type { CeCandle, CeTick } from './causeeffect'

/** what the finder keeps per frame of the market context: pure pm + weather (no nm, no editor blend) */
interface FrameCtx { regime: WxResult['regime']; wx: WxResult; pm: CeMtf; ww: WwRead | null; text: string }

export interface FinderFrame { tf: string; sec: number; candles: CeCandle[] }
export interface FinderOptions { mode: 'option' | 'cfd'; minScore?: number; minFrames?: number; nowSec?: number; ticks?: readonly CeTick[]; otc?: boolean; asset?: string }
export interface FrameRead { tf: string; sec: number; dir: 'call' | 'put' | 'none'; strength: number; prob: number; agreement: string; regime: string; pmValidated: boolean; ww: 'call' | 'put' | 'none'; wwStrength: number; wwAlign: 'with' | 'against' | 'neutral'; wwWaveDir: 1 | -1 | 0; wwText: string; wwNote: string; tech: string; techScore: number; pmRecord: string; structure: string; blocks: string[]; boosts: string[]; room: number; text: string }
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

export function readFrame(f: FinderFrame, htf: FinderFrame | null, o: FinderOptions): { read: FrameRead; ed: FrameCtx; pmm: PmmResult } | null {
  if (f.candles.length < 260) return null
  const ticks = f.sec <= 60 ? o.ticks : undefined
  const otc = !!o.otc
  // PURE pm (its own trigger blended with the next timeframe up, as everywhere else) + the weather. No nm.
  let trig: CeResult
  try { trig = readCauseEffect(f.candles, ticks, { otc }) } catch { return null }
  let hiRes: CeResult | null = null
  if (htf && htf.candles.length) { try { hiRes = readCauseEffect(htf.candles, undefined, { otc }) } catch { hiRes = null } }
  const pm = combineCeMtf(trig, hiRes, htf?.tf ?? 'none')
  if (!pm.ok) return null
  const wx = readWeather(f.candles)
  // pm needs only to be ok; a dead market still stands down, a squeeze weakens, trend that pm fights weakens, trend it follows (where following has paid) helps - same weather rules as before
  let pmDir: 'call' | 'put' | 'none' = pm.dir, strength = pm.strength
  const prob = pm.prob
  if (wx.ok && pmDir !== 'none') {
    if (wx.regime === 'dead') { pmDir = 'none'; strength = 0 }
    else if (wx.regime === 'squeeze') strength = Math.round(strength * 0.6)
    else {
      const withTrend = (wx.regime === 'trend-up' && pmDir === 'call') || (wx.regime === 'trend-down' && pmDir === 'put')
      const againstTrend = (wx.regime === 'trend-up' && pmDir === 'put') || (wx.regime === 'trend-down' && pmDir === 'call')
      if (againstTrend && wx.favours === 'follow') strength = Math.round(strength * 0.7)
      else if (withTrend && wx.favours === 'follow') strength = Math.min(100, strength + 5)
    }
  }
  const pmmIn = { ok: true, dir: pmDir, prob, strength }
  const pmm = readPmm(f.candles, pmmIn)
  const dir = pmm.ok ? pmm.dir : pmDir
  const blocks = [...(pmm.ok ? pmm.blocks : [])]
  if (pmDir !== 'none' && dir === 'none' && !blocks.length) blocks.push('structure gate')
  // WEIS WAVE of this frame: does the running wave's volume back the pm call? (looser than a gate: it lifts or lowers the score, it never blocks on its own)
  let ww: WwRead | null = null
  try { ww = readWeisWave(f.candles as never) } catch { ww = null }
  const wwDir = ww ? ww.direction : 'none'
  const wwStrength = ww ? ww.strength : 0
  const wwAlign: 'with' | 'against' | 'neutral' = dir === 'none' || wwDir === 'none' ? 'neutral' : wwDir === dir ? 'with' : 'against'
  const wwText = ww ? (ww.direction === 'none' ? `no effort-vs-result signal (${ww.cur.dir > 0 ? 'up' : 'down'}-wave, ${ww.cur.bars} bars)` : ww.reason) : 'not enough waves yet'
  const trigV = trig.validation
  let techLabel = 'n/a', techScore = 0
  try { const tr = summarizeTf(f.tf, f.sec, 'native', f.candles as never); if (tr.ok) { techLabel = tr.summary.label; techScore = tr.summary.score } } catch { /* technicals optional */ }
  const read: FrameRead = {
    tf: f.tf, sec: f.sec, dir, strength: pmm.ok ? pmm.strength : strength, prob: pmm.ok ? pmm.prob : prob, agreement: pm.alignment, regime: wx.regime,
    pmValidated: trigV.validated, ww: wwDir, wwStrength, wwAlign, wwWaveDir: ww ? ww.cur.dir : 0, wwText, wwNote: ww && !ww.volumeOk ? 'no real volume on this feed - true range stands in' : '',
    tech: techLabel, techScore, pmRecord: rec(trigV.trackN, trigV.trackHit),
    structure: pmm.ok ? pmm.structure : 'unclear', blocks, boosts: pmm.ok ? pmm.boosts : [], room: pmm.ok ? pmm.room : 99,
    text: `${pm.text} Weis wave: ${wwText}.`,
  }
  return { read, ed: { regime: wx.regime, wx, pm, ww, text: read.text }, pmm }
}

const EXPIRY_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30]
/** expiry from the frame's WAVE RHYTHM: the typical length (bars) of its recent waves in the trade's direction, in minutes, snapped to the usual expiries. A rhythm estimate, not a measured best horizon.
 * table = share of those recent waves that lasted at least that many minutes. */
export function chooseExpiry(f: FinderFrame, side: 'call' | 'put', otc: boolean, maxMin = 30): FinderExpiry {
  void otc
  const mins = f.sec / 60
  const natural = Math.max(1, Math.ceil(mins))
  let ww: WwRead | null = null
  try { ww = readWeisWave(f.candles as never) } catch { ww = null }
  const want = side === 'call' ? 1 : -1
  const same = ww ? ww.waves.filter((w) => w.dir === want && w.bars >= 1).slice(-8) : []
  const bars = same.map((w) => w.bars).sort((a, b) => a - b)
  const choices = EXPIRY_CHOICES.filter((m) => m <= maxMin)
  const table = choices.map((m) => ({ minutes: m, prob: bars.length ? bars.filter((b) => b * mins >= m).length / bars.length : 0 })).filter((t, i, a) => i === 0 || t.prob > 0 || a[i - 1].prob > 0)
  if (bars.length < 3) return { minutes: natural, bars: Math.max(1, Math.round(natural / Math.max(mins, 1 / 60))), tf: f.tf, prob: 0, basis: 'too few waves to read a rhythm; defaulting to one bar of the frame', table }
  const median = bars[Math.floor(bars.length / 2)]
  const target = Math.max(natural, median * mins)
  const minutes = choices.reduce((b, m) => (Math.abs(m - target) < Math.abs(b - target) ? m : b), choices[0])
  return { minutes, bars: Math.max(1, Math.round(minutes / Math.max(mins, 1 / 60))), tf: f.tf, prob: 0, basis: `Weis wave rhythm: recent ${side === 'call' ? 'up' : 'down'}-waves on ${f.tf} typically run ${median} bars (~${Math.round(median * mins)} min)`, table }
}

export function readFinderAsset(frames: FinderFrame[], o: FinderOptions): FinderResult {
  const asset = o.asset ?? '', otc = !!o.otc, nowSec = o.nowSec ?? Math.floor(Date.now() / 1000)
  const sorted = [...frames].sort((a, b) => a.sec - b.sec)
  const session = classifySession(nowSec, asset)
  const base = (extra: Partial<FinderResult>): FinderResult => ({ ok: true, found: false, asset, otc, mode: o.mode, side: 'none', score: 0, grade: '', tf: '', barLeftSec: 0, frames: [], agree: 0, against: 0, expiry: null, cfd: null, story: [], reasons: [], rejected: [], session, text: '', ...extra })
  const reads: Array<{ read: FrameRead; ed: FrameCtx; pmm: PmmResult; frame: FinderFrame }> = []
  for (let i = 0; i < sorted.length; i++) {
    const r = readFrame(sorted[i], sorted[i + 1] ?? null, o)
    if (r) reads.push({ ...r, frame: sorted[i] })
  }
  if (reads.length < 1) return base({ rejected: ['no timeframe has enough history'], text: 'Not enough history.' })
  const frameReads = reads.map((r) => r.read)
  // the BEST single frame decides the side: strongest call (a Weis wave that backs it and agreeing technicals lift it a little). Other frames only add to the score.
  const callers = reads.filter((r) => r.read.dir !== 'none')
  const rejected: string[] = []
  if (!callers.length) return base({ frames: frameReads, rejected: ['no timeframe has a call'], text: 'No call on any timeframe.' })
  const lift = (r: typeof reads[number]) => r.read.strength + (r.read.wwAlign === 'with' ? r.read.wwStrength / 12 : r.read.wwAlign === 'against' ? -r.read.wwStrength / 12 : 0) + (r.read.dir === 'call' ? r.read.techScore : -r.read.techScore) * 8
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
  const evidence = best.read.wwAlign === 'with' ? clamp(best.read.wwStrength / 100, 0, 1) : 0 // Weis wave backing the call (0 when silent or against)
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
    `pm + Weis wave on ${best.read.tf}: ${best.read.text}${best.read.wwNote ? ' (' + best.read.wwNote + ')' : ''}`,
    `Timeframes: ${frameReads.map((r) => `${r.tf} ${r.dir === 'none' ? '-' : r.dir === 'call' ? '▲' : '▼'}${r.strength}`).join('  ')}`,
    `Technicals on ${best.read.tf}: ${best.read.tech} (${best.read.techScore >= 0 ? '+' : ''}${best.read.techScore.toFixed(2)}), ${techSigned >= 0.15 ? 'agree with the trade' : techSigned <= -0.15 ? 'lean against the trade' : 'neutral'}.`,
    `Evidence: pm record ${best.read.pmRecord}; Weis wave ${best.read.wwAlign === 'with' ? 'backs the call (' + best.read.wwStrength + ')' : best.read.wwAlign === 'against' ? 'leans AGAINST the call (' + best.read.wwStrength + ') - score lowered, not blocked' : 'has no signal'}.`,
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
  const reasons = [`best call is ${best.read.tf} (${agreeing.length}/${reads.length} frames lean ${side.toUpperCase()}${against ? `, ${against} the other way` : ''}); technicals ${best.read.tech}; Weis wave ${best.read.wwAlign === 'with' ? 'backs it' : best.read.wwAlign === 'against' ? 'leans against it' : 'silent'}`, ...best.read.boosts]
  const text = `${side.toUpperCase()} ${asset} (${grade}, score ${score}) on ${best.read.tf}: ${reasons.join('; ')}.${expiry ? ` Expiry ${expiry.minutes} min (${expiry.basis}).` : ''}${cfd ? ` ${cfd.text}` : ''}`
  return base({ ...common, found: true, grade, expiry, cfd, reasons, text })
}
