// IQAIR//OS - DAO: the market read as a way that unfolds, through nine lenses. Nothing here forces a prediction: each lens OBSERVES one aspect of how price is behaving, and the wu wei lens decides whether
// the conditions justify acting at all (doing nothing is a valid, and often the best, output).
//   1 yinyang  : opposing forces. YANG = activity/expansion, YIN = rest/contraction (volatility); separately PUSH = buyers vs sellers. Yin is not bearish, yang is not bullish - a market can rise while
//                contracting. Tracks the TRANSFER of dominance from one side to the other.
//   2 cause    : cause and effect - the pm model (causeeffect.ts) plus what has FOLLOWED compression on this pair (breakout odds, typical excursion).
//   3 life     : life and death of a trend: age, how much it has travelled versus this pair's usual legs (maturity), vitality (efficiency + momentum vs its own peak), pullback depth ->
//                birth / growth / mature / correcting / dying / dead, plus how often legs in the "dying" signature actually ended soon.
//   4 time     : the same move at several scales (is it significant at 5 bars, 15, 45, 135?), the hour-of-day character, and the rhythm of volatility spikes.
//   5 space    : where price sits in its structure: discount/equilibrium/premium of the recent range, the levels above and below, how those levels have been treated (nm).
//   6 momentum : strength, persistence, acceleration and resistance: genuine progress vs effort that goes nowhere (stalling) vs fading.
//   7 wuwei    : act or wait. Blocks: squeeze/dead, chasing an extended move, fighting a strong prevailing move, momentum stalling, pm and nm in conflict, no clear lean.
//   8 fate     : the part already decided: the volatility cone (what range is plausible), the chance of touching the level above/below under a random walk versus how often this pair ACTUALLY did
//                (so you see whether it trends or reverts relative to chance), variance ratios, and drift with its significance.
//   9 phase    : the cycle: stillness -> movement -> expansion -> excess -> transformation.
// reportDao() turns the five deeper questions (expansion -> contraction? strong move -> opposition? can the turning point be seen? equilibrium <-> disequilibrium? does inaction help?) into measurements on a
// pair's OWN history, each with its baseline, counts and a lift.
// HONESTY: every threshold is conventional or judgement, not fitted. A lens is a description, not a forecast; `lean` is a vote of descriptions. Only the report and a walk-forward test say whether any of it pays.

import { readCauseEffect, type CeCandle, type CeTick, type CeResult } from './causeeffect'
import { readNextMove, type NmResult } from './nextmove'
import { readWeather, type WxResult } from './weather'

export type DaoPhase = 'stillness' | 'movement' | 'expansion' | 'excess' | 'transformation'
export type DaoStage = 'birth' | 'growth' | 'mature' | 'correcting' | 'dying' | 'dead'
export interface DaoOptions { horizon?: number; otc?: boolean; light?: boolean }

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const sg = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0)
const shrink = (hit: number, n: number, k = 10) => (hit + 0.5 * k) / (n + k)
const MIN = 150
const DAY = 86400
/** standard normal CDF (Abramowitz-Stegun) */
const Phi = (x: number) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp((-x * x) / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p }
/** chance a driftless random walk with horizon-sigma `s` touches a level `d` away within the horizon (reflection principle) */
export const touchProbRW = (d: number, s: number) => (d <= 0 ? 1 : s <= 0 ? 0 : clamp(2 * (1 - Phi(d / s)), 0, 1))

export interface F {
  n: number; c: CeCandle[]; hi: number[]; lo: number[]; cl: number[]; clock: boolean
  atr: number[]; atr100: number[]; ratio: number[]; er: number[]; bwRank: number[]; volRank: number[]
  roc: number[]; push: number[]; persist: number[]; prog: number[]; effort: number[]; stretch: number[]; sma: number[]
  z: Record<number, number[]>
  dir: number[]; start: number[]; momRatio: number[]
  legs: { dur: number; move: number }[]
}

export function features(c: CeCandle[]): F {
  const n = c.length, hi = c.map((x) => x.high), lo = c.map((x) => x.low), cl = c.map((x) => x.close)
  const tr = c.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)) : x.high - x.low))
  const mk = () => new Array<number>(n).fill(NaN)
  const atr = mk(), atr100 = mk(), ratio = mk(), er = mk(), bw = mk(), bwRank = mk(), volRank = mk(), roc = mk(), push = mk(), persist = mk(), prog = mk(), effort = mk(), stretch = mk(), sma = mk()
  const z: Record<number, number[]> = { 5: mk(), 15: mk(), 45: mk(), 135: mk() }
  const mean = (a: number[], i: number, w: number) => { let s = 0; for (let k = i - w + 1; k <= i; k++) s += a[k]; return s / w }
  for (let i = 100; i < n; i++) {
    atr[i] = mean(tr, i, 14); atr100[i] = mean(tr, i, 100); ratio[i] = atr[i] / atr100[i]
    const m = mean(cl, i, 20); sma[i] = m
    let v = 0; for (let k = i - 19; k <= i; k++) v += (cl[k] - m) ** 2
    const sd = Math.sqrt(v / 20) || atr[i]
    bw[i] = m > 0 ? (4 * sd) / m : 0; stretch[i] = (cl[i] - m) / sd
    let path = 0; for (let k = i - 19; k <= i; k++) path += Math.abs(cl[k] - cl[k - 1])
    er[i] = path > 0 ? Math.abs(cl[i] - cl[i - 20]) / path : 0
    roc[i] = (cl[i] - cl[i - 10]) / atr[i]
    let num = 0, den = 0, rs = 0, up = 0, net = Math.sign(cl[i] - cl[i - 10])
    for (let k = i - 9; k <= i; k++) { const r = hi[k] - lo[k]; den += r; rs += r; if (r > 0) num += (2 * (cl[k] - lo[k]) / r - 1) * r; if (Math.sign(cl[k] - cl[k - 1]) === net) up++ }
    push[i] = den > 0 ? num / den : 0; persist[i] = up / 10; prog[i] = rs > 0 ? Math.abs(cl[i] - cl[i - 10]) / rs : 0; effort[i] = rs / 10 / atr[i]
    for (const w of [5, 15, 45, 135]) if (i >= w) z[w][i] = (cl[i] - cl[i - w]) / (atr100[i] * 0.9 * Math.sqrt(w))
  }
  const rank = (a: number[], i: number) => { let lo2 = 0, t = 0; for (let k = Math.max(100, i - 299); k <= i; k++) { if (!Number.isFinite(a[k])) continue; t++; if (a[k] <= a[i]) lo2++ } return t ? lo2 / t : 0.5 }
  for (let i = 100; i < n; i++) { bwRank[i] = rank(bw, i); volRank[i] = rank(atr, i) }
  // trend legs with hysteresis on the 20-bar mean's slope
  const dir = new Array<number>(n).fill(0), start = new Array<number>(n).fill(0), momRatio = new Array<number>(n).fill(0)
  const legs: F['legs'] = []
  let runMax = 0
  for (let i = 100; i < n; i++) {
    const slope = (sma[i] - sma[i - 5]) / (5 * atr[i]), prev = dir[i - 1] || 0
    const d = slope > 0.03 ? 1 : slope < -0.03 ? -1 : prev
    if (i === 100) { dir[i] = d || 1; start[i] = i; runMax = 0 }
    else if (d !== prev && prev !== 0) { const s0 = start[i - 1]; legs.push({ dur: i - s0, move: Math.abs(cl[i - 1] - cl[s0]) / atr[i - 1] }); dir[i] = d; start[i] = i; runMax = 0 }
    else { dir[i] = d || prev; start[i] = start[i - 1] }
    runMax = Math.max(runMax, roc[i] * dir[i]); momRatio[i] = runMax > 0 ? clamp((roc[i] * dir[i]) / runMax, 0, 1) : 0
  }
  return { n, c, hi, lo, cl, clock: c[0].time > 1e8, atr, atr100, ratio, er, bwRank, volRank, roc, push, persist, prog, effort, stretch, sma, z, dir, start, momRatio, legs }
}

const decayAt = (f: F, i: number) => { let mx = 0; for (let k = i - 10; k < i; k++) mx = Math.max(mx, Math.abs(f.roc[k])); return mx > 1 && Math.abs(f.roc[i]) < 0.6 * mx }
export function phaseAt(f: F, i: number): DaoPhase {
  const st = f.stretch[i], p = f.push[i], r = f.ratio[i], dec = decayAt(f, i)
  const prior = Math.sign(f.cl[i - 5] - f.cl[i - 15]), priorBig = Math.abs(f.cl[i - 5] - f.cl[i - 15]) > f.atr[i]
  if (priorBig && p * prior < -0.25 && dec) return 'transformation'
  if (Math.abs(st) > 2.5 || (Math.abs(st) > 2 && dec)) return 'excess'
  if (r > 1.2 && f.prog[i] > 0.35) return 'expansion'
  if (f.bwRank[i] < 0.3 || r < 0.85) return 'stillness'
  return Math.abs(p) > 0.3 ? 'movement' : 'stillness'
}
function leanAt(f: F, i: number): { vote: number; dir: 'call' | 'put' | 'none'; blocks: string[] } {
  const a = clamp(f.push[i] * 1.5, -1, 1), b = clamp(f.roc[i] / 3, -1, 1)
  const zs = [5, 15, 45].map((w) => clamp((f.z[w][i] ?? 0) / 2, -1, 1)), cc = (zs[0] + zs[1] + zs[2]) / 3
  const dd = (f.persist[i] - 0.5) * 2 * sg(f.cl[i] - f.cl[i - 10])
  const vote = 0.3 * a + 0.3 * b + 0.25 * cc + 0.15 * dd
  const dir = Math.abs(vote) >= 0.25 ? (vote > 0 ? 'call' : 'put') : 'none'
  const blocks: string[] = []
  if (dir !== 'none') {
    const s = dir === 'call' ? 1 : -1
    if (f.bwRank[i] < 0.2 && f.ratio[i] < 0.9) blocks.push('squeeze: tight and quiet')
    if (s * f.stretch[i] > 2.2) blocks.push('chasing: price already extended in this direction')
    if (f.effort[i] > 1.15 && f.prog[i] < 0.2) blocks.push('momentum stalling: effort without progress')
    if (s * (f.z[45][i] ?? 0) < -1.5) blocks.push('fighting a strong prevailing move')
  } else blocks.push('no clear lean')
  return { vote, dir, blocks }
}

export interface DaoResult {
  ok: boolean
  error?: string
  yinyang: { yang: number; yin: number; push: number; dominance: 'buyers' | 'sellers' | 'balanced'; contracting: boolean; expanding: boolean; state: string; transfer: 'to-buyers' | 'to-sellers' | 'none'; barsSinceTransfer: number; transferFollowP: number; transferN: number }
  cause: { dir: string; label: string; pmProb: number; pmStrength: number; pmValidated: boolean; compressed: boolean; breakoutP: number; breakoutN: number; avgExcursionAtr: number }
  life: { stage: DaoStage; dir: number; age: number; maturity: number; vitality: number; retrace: number; moveAtr: number; medianAge: number; medianMoveAtr: number; dyingEndP: number; dyingN: number; baseEndP: number }
  time: { z5: number; z15: number; z45: number; z135: number; alignment: number; scaleDir: number; hour: number; hourBias: number; hourN: number; hourVol: number; barsSinceSpike: number; spikeGap: number; cyclePos: number }
  space: { rangePos: number; zone: 'discount' | 'equilibrium' | 'premium'; upLevel: number; upDist: number; downLevel: number; downDist: number; resHold: number; supHold: number; atSupport: boolean; atResistance: boolean; pUpFirst: number; pDownFirst: number }
  momentum: { roc: number; accel: number; persistence: number; progress: number; effort: number; genuine: boolean; state: 'surging' | 'steady' | 'stalling' | 'fading' | 'idle' }
  wuwei: { act: boolean; dir: 'call' | 'put' | 'none'; favour: number; wait: string[]; why: string[] }
  fate: { sigmaH: number; coneUp1: number; coneDn1: number; coneUp2: number; coneDn2: number; touchUpRW: number; touchDownRW: number; touchUpEmp: number; touchDownEmp: number; vr5: number; vr10: number; character: 'trending' | 'reverting' | 'random'; drift: number; driftT: number; horizon: number }
  phase: { phase: DaoPhase; next: DaoPhase; stretch: number }
  lean: { dir: 'call' | 'put' | 'none'; vote: number }
  lines: string[]
  text: string
}

const NEXT: Record<DaoPhase, DaoPhase> = { stillness: 'movement', movement: 'expansion', expansion: 'excess', excess: 'transformation', transformation: 'stillness' }
const med = (a: number[], d: number) => { if (a.length < 5) return d; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }

export function readDao(candles: CeCandle[], ticks?: readonly CeTick[], opts: DaoOptions = {}): DaoResult {
  const H = Math.max(2, Math.min(30, Math.round(opts.horizon ?? 5))), otc = !!opts.otc
  const c = candles.filter((x) => x && [x.time, x.open, x.high, x.low, x.close].every((v) => Number.isFinite(v))).slice(-1600)
  const empty = (error: string): DaoResult => ({ ok: false, error, yinyang: {} as never, cause: {} as never, life: {} as never, time: {} as never, space: {} as never, momentum: {} as never, wuwei: { act: false, dir: 'none', favour: 0, wait: [error], why: [] }, fate: {} as never, phase: { phase: 'stillness', next: 'movement', stretch: 0 }, lean: { dir: 'none', vote: 0 }, lines: [error], text: error })
  if (c.length < MIN) return empty(`needs ${MIN} closed bars, have ${c.length}`)
  const f = features(c), n = f.n, t = n - 1
  const a = f.atr[t]
  if (!Number.isFinite(a) || a <= 0) return empty('ATR not ready')
  // ---- 1 yin/yang ----
  const yang = clamp(0.5 * f.volRank[t] + 0.5 * clamp(f.ratio[t] / 2, 0, 1), 0, 1), push = f.push[t]
  const dom: 'buyers' | 'sellers' | 'balanced' = Math.abs(push) > 0.2 ? (push > 0 ? 'buyers' : 'sellers') : 'balanced'
  let transfer: 'to-buyers' | 'to-sellers' | 'none' = 'none', since = 99
  for (let k = 0; k < 8; k++) { const i = t - k, j = i - 4; if (j < 110) break; if (f.push[i] > 0.15 && f.push[j] < -0.15) { transfer = 'to-buyers'; since = k; break } if (f.push[i] < -0.15 && f.push[j] > 0.15) { transfer = 'to-sellers'; since = k; break } }
  let tf = 0, tn = 0
  for (let i = 115; i < n - 5; i++) { if (f.push[i] > 0.15 && f.push[i - 4] < -0.15) { tn++; if (f.cl[i + 5] > f.cl[i]) tf++ } else if (f.push[i] < -0.15 && f.push[i - 4] > 0.15) { tn++; if (f.cl[i + 5] < f.cl[i]) tf++ } }
  const contracting = f.ratio[t] < 0.85, expanding = f.ratio[t] > 1.15
  const yinyang = { yang, yin: 1 - yang, push, dominance: dom, contracting, expanding, state: `${dom === 'balanced' ? 'balanced' : dom === 'buyers' ? 'bullish' : 'bearish'}-${contracting ? 'contracting' : expanding ? 'expanding' : 'steady'}`, transfer, barsSinceTransfer: since, transferFollowP: shrink(tf, tn), transferN: tn }
  // ---- 2 cause & effect ----
  let pm: CeResult | null = null
  if (!opts.light) { try { pm = readCauseEffect(c.slice(-400), ticks, { otc }) } catch { pm = null } }
  let bo = 0, bn = 0, ex = 0
  for (let i = 110; i < n - 10; i++) if (f.bwRank[i] < 0.25 && f.ratio[i] < 0.9) { bn++; let m = 0; for (let k = 1; k <= 10; k++) m = Math.max(m, Math.abs(f.cl[i + k] - f.cl[i]) / f.atr[i]); ex += m; if (m >= 1.5) bo++ }
  const cause = { dir: pm?.ok ? pm.pm.dir : 'none', label: pm?.ok ? pm.cause.label : 'n/a', pmProb: pm?.ok ? pm.pm.prob : 0.5, pmStrength: pm?.ok ? pm.pm.confidence : 0, pmValidated: !!pm?.ok && pm.validation.validated, compressed: f.bwRank[t] < 0.25 && f.ratio[t] < 0.9, breakoutP: shrink(bo, bn), breakoutN: bn, avgExcursionAtr: bn ? ex / bn : NaN }
  // ---- 3 life & death ----
  const d = f.dir[t] || 1, s0 = f.start[t], age = t - s0, moveAtr = ((f.cl[t] - f.cl[s0]) * d) / a
  let ext = d > 0 ? -Infinity : Infinity; for (let k = s0; k <= t; k++) ext = d > 0 ? Math.max(ext, f.hi[k]) : Math.min(ext, f.lo[k])
  const full = Math.abs(ext - f.cl[s0]), retrace = full > 0 ? clamp(((ext - f.cl[t]) * d) / full, -1, 2) : 0
  const medAge = med(f.legs.map((l) => l.dur), 60), medMove = med(f.legs.map((l) => l.move), 6)
  const maturity = Math.max(age / medAge, Math.max(0, moveAtr) / medMove), vitality = clamp(0.5 * clamp(f.er[t] / 0.5, 0, 1) + 0.5 * f.momRatio[t], 0, 1)
  let stage: DaoStage = maturity < 0.7 ? 'growth' : 'mature'
  if (age < 8) stage = 'birth'; else if (retrace > 0.78) stage = 'dead'; else if (retrace > 0.15 && retrace <= 0.62 && vitality >= 0.35) stage = 'correcting'; else if (maturity > 1 && vitality < 0.45) stage = 'dying'
  let de = 0, dn = 0, be = 0, bnn = 0
  for (let i = 115; i < n - 10; i++) {
    const ends = Math.sign(f.cl[i + 10] - f.cl[i]) === -f.dir[i] // the leg did not continue: the next 10 bars net AGAINST it (price outcome, not the slope flag the stage itself is built from)
    bnn++; if (ends) be++
    if ((i - f.start[i]) / medAge > 1 && f.momRatio[i] < 0.45) { dn++; if (ends) de++ }
  }
  const life = { stage, dir: d, age, maturity, vitality, retrace, moveAtr, medianAge: medAge, medianMoveAtr: medMove, dyingEndP: shrink(de, dn), dyingN: dn, baseEndP: shrink(be, bnn) }
  // ---- 4 time ----
  const zs = [f.z[5][t], f.z[15][t], f.z[45][t], f.z[135][t]], sgs = zs.filter((x) => Number.isFinite(x) && Math.abs(x) > 0.5).map((v) => sg(v) as number)
  const scaleDir = sgs.length ? sg(sgs.reduce((x, y) => x + y, 0)) : 0, alignment = sgs.length ? Math.abs(sgs.reduce((x, y) => x + y, 0)) / sgs.length : 0
  const hourOf = (i: number) => Math.floor((c[i].time % DAY) / 3600)
  let hour = -1, hb = 0.5, hn = 0, hv = 1
  if (f.clock) {
    hour = hourOf(t); let up = 0, tot = 0, rs = 0, rsAll = 0, ra = 0
    for (let i = 100; i < n - 1; i++) { const r = f.hi[i] - f.lo[i]; rsAll += r; ra++; if (hourOf(i) === hour) { tot++; rs += r; if (f.cl[i + 1] > f.cl[i]) up++ } }
    hn = tot; hb = shrink(up, tot); hv = tot && ra ? (rs / tot) / (rsAll / ra) : 1
  }
  let last = -1; const spikes: number[] = []
  for (let i = 101; i < n; i++) { const r = Math.max(f.hi[i] - f.lo[i], Math.abs(f.hi[i] - f.cl[i - 1]), Math.abs(f.lo[i] - f.cl[i - 1])); if (r > 2 * f.atr100[i]) { if (last >= 0 && i - last > 3) spikes.push(i - last); last = i } }
  const gap = med(spikes, NaN), sinceSpike = last >= 0 ? t - last : NaN
  const time = { z5: zs[0], z15: zs[1], z45: zs[2], z135: zs[3], alignment, scaleDir, hour, hourBias: hb, hourN: hn, hourVol: hv, barsSinceSpike: sinceSpike, spikeGap: gap, cyclePos: Number.isFinite(gap) && gap > 0 ? sinceSpike / gap : NaN }
  // ---- 5 space ----
  let nm: NmResult | null = null
  if (!opts.light) { try { nm = readNextMove(c, { otc, horizon: H }) } catch { nm = null } }
  let hh = -Infinity, ll = Infinity; for (let k = Math.max(0, n - 100); k < n; k++) { hh = Math.max(hh, f.hi[k]); ll = Math.min(ll, f.lo[k]) }
  const rp = hh > ll ? (f.cl[t] - ll) / (hh - ll) : 0.5
  const space = { rangePos: rp, zone: (rp < 0.35 ? 'discount' : rp > 0.65 ? 'premium' : 'equilibrium') as 'discount' | 'equilibrium' | 'premium', upLevel: nm?.ok ? nm.reach.upLevel : NaN, upDist: nm?.ok ? nm.reach.upDist : NaN, downLevel: nm?.ok ? nm.reach.downLevel : NaN, downDist: nm?.ok ? nm.reach.downDist : NaN, resHold: nm?.ok ? nm.ledger.resHold : 0.5, supHold: nm?.ok ? nm.ledger.supHold : 0.5, atSupport: !!nm?.ok && nm.causes.atSupport, atResistance: !!nm?.ok && nm.causes.atResistance, pUpFirst: nm?.ok ? nm.reach.pUpFirst : 0.5, pDownFirst: nm?.ok ? nm.reach.pDownFirst : 0.5 }
  // ---- 6 momentum ----
  const accel = Number.isFinite(f.roc[t - 5]) ? (f.roc[t] - f.roc[t - 5]) / 3 : 0
  const genuine = f.persist[t] >= 0.6 && f.prog[t] >= 0.35 && sg(accel) * sg(f.roc[t]) >= 0
  const mstate: DaoResult['momentum']['state'] = Math.abs(f.roc[t]) < 0.5 && f.effort[t] < 0.9 ? 'idle' : f.effort[t] > 1.15 && f.prog[t] < 0.2 ? 'stalling' : genuine && Math.abs(accel) > 0.3 && sg(accel) === sg(f.roc[t]) ? 'surging' : genuine ? 'steady' : decayAt(f, t) ? 'fading' : 'steady'
  const momentum = { roc: f.roc[t], accel, persistence: f.persist[t], progress: f.prog[t], effort: f.effort[t], genuine, state: mstate }
  // ---- 9 phase ----
  const ph = phaseAt(f, t)
  // ---- lean + 7 wu wei ----
  const lt = leanAt(f, t)
  let vote = lt.vote; const wait = [...lt.blocks].filter((b) => b !== 'no clear lean' || true)
  const why: string[] = []
  if (pm?.ok && pm.pm.dir !== 'none') vote += 0.25 * pm.pm.sign * Math.min(1, Math.abs(pm.pm.prob - 0.5) * 4)
  if (nm?.ok && nm.nm.dir !== 'none') vote += 0.25 * nm.nm.sign * Math.min(1, Math.abs(nm.nm.prob - 0.5) * 4)
  vote += space.zone === 'discount' ? 0.05 : space.zone === 'premium' ? -0.05 : 0
  let dir: 'call' | 'put' | 'none' = Math.abs(vote) >= 0.3 ? (vote > 0 ? 'call' : 'put') : 'none'
  const blocks: string[] = lt.blocks.filter((b) => b !== 'no clear lean')
  if (dir === 'none') blocks.push('no clear lean')
  if (pm?.ok && nm?.ok && pm.pm.sign !== 0 && nm.nm.sign !== 0 && pm.pm.sign !== nm.nm.sign) blocks.push('pm and nm point opposite ways')
  const wx: WxResult | null = (() => { try { return readWeather(c) } catch { return null } })()
  if (wx?.ok && (wx.regime === 'dead' || wx.regime === 'squeeze') && !blocks.some((b) => b.startsWith('squeeze'))) blocks.push(`${wx.regime} market`)
  if (dir !== 'none') {
    const s = dir === 'call' ? 1 : -1
    if (alignment >= 0.75 && scaleDir === s) why.push('scales agree')
    if (genuine && sg(f.roc[t]) === s) why.push('genuine momentum with it')
    if ((s > 0 && space.zone === 'discount') || (s < 0 && space.zone === 'premium')) why.push(`${space.zone} of the range`)
    if (transfer === (s > 0 ? 'to-buyers' : 'to-sellers')) why.push('dominance just transferred to this side')
    if (pm?.ok && pm.pm.sign === s) why.push('pm agrees')
    if (nm?.ok && nm.nm.sign === s) why.push('nm agrees')
    if (stage === 'dying' && d === s) blocks.push('the trend it would follow is dying')
  }
  const favour = dir === 'none' ? 0 : Math.round(clamp(Math.abs(vote) * 100 + why.length * 6 - blocks.length * 25, 0, 100))
  const wuwei = { act: dir !== 'none' && blocks.length === 0 && favour >= 45, dir, favour, wait: blocks, why }
  void wait
  // ---- 8 fate ----
  let sdR = 0, nr = 0, mu = 0; for (let i = Math.max(1, n - 300); i < n; i++) { mu += (f.cl[i] - f.cl[i - 1]) / a; nr++ }
  mu /= nr; for (let i = Math.max(1, n - 300); i < n; i++) sdR += (((f.cl[i] - f.cl[i - 1]) / a) - mu) ** 2; sdR = Math.sqrt(sdR / Math.max(1, nr - 1))
  const driftT = sdR > 0 ? (mu / (sdR / Math.sqrt(nr))) : 0
  const sd1 = sdR * a || a * 0.8, sigmaH = sd1 * Math.sqrt(H)
  const vr = (q: number) => { let v1 = 0, vq = 0, k1 = 0, kq = 0; for (let i = Math.max(q, n - 400); i < n; i++) { v1 += (f.cl[i] - f.cl[i - 1]) ** 2; k1++; vq += (f.cl[i] - f.cl[i - q]) ** 2; kq++ } return k1 && kq && v1 > 0 ? (vq / kq) / (q * (v1 / k1)) : 1 }
  const vr5 = vr(5), vr10 = vr(10)
  const upD = Number.isFinite(space.upDist) ? space.upDist : 2, dnD = Number.isFinite(space.downDist) ? space.downDist : 2
  let eu = 0, ed = 0, en = 0
  for (let i = 110; i < n - H; i++) { let mx = 0, mn = 0; for (let k = 1; k <= H; k++) { mx = Math.max(mx, (f.hi[i + k] - f.cl[i]) / f.atr[i]); mn = Math.max(mn, (f.cl[i] - f.lo[i + k]) / f.atr[i]) } en++; if (mx >= upD) eu++; if (mn >= dnD) ed++ }
  const fate = { sigmaH, coneUp1: f.cl[t] + sigmaH, coneDn1: f.cl[t] - sigmaH, coneUp2: f.cl[t] + 2 * sigmaH, coneDn2: f.cl[t] - 2 * sigmaH, touchUpRW: touchProbRW(upD * a, sigmaH), touchDownRW: touchProbRW(dnD * a, sigmaH), touchUpEmp: en ? eu / en : NaN, touchDownEmp: en ? ed / en : NaN, vr5, vr10, character: (vr5 > 1.1 && vr10 > 1.1 ? 'trending' : vr5 < 0.9 && vr10 < 0.9 ? 'reverting' : 'random') as 'trending' | 'reverting' | 'random', drift: mu, driftT, horizon: H }
  const f2 = (x: number, k = 2) => (Number.isFinite(x) ? x.toFixed(k) : '-'), pc = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '-')
  const lines = [
    `1 YIN/YANG: ${yinyang.state}; activity (yang) ${pc(yang)}, rest (yin) ${pc(1 - yang)}; push ${f2(push)} (${dom}).${transfer !== 'none' ? ` Dominance transferred ${transfer} ${since} bar(s) ago - after such transfers the new side followed through ${pc(yinyang.transferFollowP)} of ${tn}.` : ''}`,
    `2 CAUSE/EFFECT: ${cause.label}${pm?.ok ? ` (pm ${cause.dir} ${pc(cause.pmProb)}${cause.pmValidated ? ', validated' : ''})` : ''}. ${cause.compressed ? `Compressed now - after past compressions price moved 1.5+ ATR within 10 bars ${pc(cause.breakoutP)} of ${bn} times (avg excursion ${f2(cause.avgExcursionAtr)} ATR).` : 'Not compressed.'}`,
    `3 LIFE/DEATH: ${stage} ${d > 0 ? 'uptrend' : 'downtrend'}, age ${age} bars (typical leg ${medAge}), travelled ${f2(moveAtr, 1)} ATR (typical ${f2(medMove, 1)}), maturity ${f2(maturity)}, vitality ${pc(vitality)}, pulled back ${pc(retrace)}.${dn >= 10 ? ` Legs with this dying signature then went against their direction over the next 10 bars ${pc(life.dyingEndP)} of ${dn} (any bar: ${pc(life.baseEndP)}).` : ''}`,
    `4 TIME: z-moves 5/15/45/135 bars = ${zs.map((x) => f2(x, 1)).join('/')}, scales agree ${pc(alignment)} ${scaleDir > 0 ? 'up' : scaleDir < 0 ? 'down' : ''}.${f.clock ? ` Hour ${hour} UTC: next candle up ${pc(hb)} of ${hn}, ranges x${f2(hv)} normal.` : ''}${Number.isFinite(gap) ? ` Volatility spikes come about every ${f2(gap, 0)} bars; ${f2(sinceSpike, 0)} since the last.` : ''}`,
    `5 SPACE: ${space.zone} (${pc(rp)} of the last 100 bars' range). ${Number.isFinite(space.upLevel) ? `Above ${f2(space.upLevel, 5)} (${f2(space.upDist, 1)} ATR, held ${pc(space.resHold)})` : 'Nothing above'}, ${Number.isFinite(space.downLevel) ? `below ${f2(space.downLevel, 5)} (${f2(space.downDist, 1)} ATR, held ${pc(space.supHold)})` : 'nothing below'}.`,
    `6 MOMENTUM: ${mstate}; ROC ${f2(momentum.roc, 1)} ATR, accel ${f2(accel)}, persistence ${pc(momentum.persistence)}, progress ${pc(momentum.progress)} for effort x${f2(momentum.effort)}.`,
    `7 WU WEI: ${wuwei.act ? `ACT ${dir.toUpperCase()}` : 'WAIT'} (favour ${favour}/100). ${wuwei.act ? (why.length ? 'Because ' + why.join(', ') + '.' : '') : blocks.length ? 'Because ' + blocks.join('; ') + '.' : ''}`,
    `8 FATE: plausible range over ${H} bars +-${f2(sigmaH, 5)} (1 sigma). Touching the level above: random-walk ${pc(fate.touchUpRW)} vs this pair actually ${pc(fate.touchUpEmp)}; below: ${pc(fate.touchDownRW)} vs ${pc(fate.touchDownEmp)}. Variance ratio ${f2(vr5)}/${f2(vr10)} -> ${fate.character}. Drift ${f2(mu, 3)} ATR/bar (t ${f2(driftT, 1)}).`,
    `9 PHASE: ${ph} (next in the cycle: ${NEXT[ph]}); stretch ${f2(f.stretch[t], 1)} sigma from the 20-bar mean.`,
  ]
  const text = lines.join('\n')
  return { ok: true, yinyang, cause, life, time, space, momentum, wuwei, fate, phase: { phase: ph, next: NEXT[ph], stretch: f.stretch[t] }, lean: { dir, vote }, lines, text }
}

// =============================== research: the five deeper questions ===============================
export interface DaoStat { n: number; hit: number; rate: number | null }
export interface DaoReport {
  ok: boolean; error?: string; bars: number
  q1: { question: string; afterExpansion: DaoStat; baseline: DaoStat; lift: number | null; answer: string }
  q2: { question: string; afterStrong: DaoStat; baseline: DaoStat; lift: number | null; answer: string }
  q3: { question: string; atTurn: DaoStat; baseline: DaoStat; lift: number | null; answer: string }
  q4: { question: string; matrix: Record<string, Record<string, number>>; dwell: Record<string, number>; stillnessToMovement20: DaoStat; answer: string }
  q5: { question: string; whenAct: DaoStat; whenWait: DaoStat; all: DaoStat; lift: number | null; answer: string }
}
const stat = (): DaoStat => ({ n: 0, hit: 0, rate: null })
const tally = (s: DaoStat, ok: boolean) => { s.n++; if (ok) s.hit++ }
const fin = (s: DaoStat) => { s.rate = s.n ? s.hit / s.n : null; return s }
/** two-proportion z of a vs b (null when either has fewer than 10 cases) */
const zdiff = (a: DaoStat, b: DaoStat): number | null => { if (a.n < 10 || b.n < 10 || a.rate === null || b.rate === null) return null; const p = (a.hit + b.hit) / (a.n + b.n), se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n)); return se > 0 ? (a.rate - b.rate) / se : 0 }
const lift = (a: DaoStat, b: DaoStat) => (a.rate !== null && b.rate !== null && b.rate > 0 ? a.rate / b.rate : null)

export function reportDao(candles: CeCandle[]): DaoReport {
  const c = candles.filter((x) => x && [x.time, x.open, x.high, x.low, x.close].every((v) => Number.isFinite(v)))
  const mkEmpty = (error: string): DaoReport => ({ ok: false, error, bars: c.length, q1: {} as never, q2: {} as never, q3: {} as never, q4: {} as never, q5: {} as never })
  if (c.length < 400) return mkEmpty(`needs 400 closed bars, have ${c.length}`)
  const f = features(c), n = f.n
  // a "yes" needs BOTH a visible lift and statistical separation (|z| >= 2); otherwise it is reported as no clear difference, because over many questions some gaps appear by chance
  const verdict = (a: DaoStat, b: DaoStat, extra: string) => {
    const l = lift(a, b), z = zdiff(a, b)
    if (a.n < 30 || b.n < 30 || l === null || z === null) return `Too few cases (${a.n} vs ${b.n}) to say. ${extra}`
    const nums = `${(a.rate! * 100).toFixed(0)}% of ${a.n} vs ${(b.rate! * 100).toFixed(0)}% of ${b.n} baseline (lift ${l.toFixed(2)}, z ${z.toFixed(1)})`
    return z >= 2 && l > 1.05 ? `YES on this history: ${nums}. ${extra}` : z <= -2 && l < 0.95 ? `The OPPOSITE on this history: ${nums}. ${extra}` : `No clear difference: ${nums}. ${extra}`
  }
  // Q1: expansion -> contraction. Event: volatility (ATR14 / ATR100) falls to <= 0.8 within 30 bars. Group: bars in expansion (ratio > 1.3). Baseline: bars with ordinary volatility (0.9..1.3), so the baseline cannot
  // saturate on bars that are already quiet.
  const q1a = stat(), q1b = stat()
  for (let i = 110; i < n - 30; i++) {
    const r0 = f.ratio[i]; if (!(r0 >= 0.9)) continue
    let contract = false; for (let k = 1; k <= 30; k++) if (f.ratio[i + k] <= 0.8) { contract = true; break }
    if (r0 > 1.3) tally(q1a, contract); else tally(q1b, contract)
  }
  // Q2: strong directional move -> opposing excursion
  const q2a = stat(), q2b = stat()
  for (let i = 115; i < n - 10; i++) {
    const net = (f.cl[i] - f.cl[i - 10]) / f.atr[i]; let up = 0, dn = 0
    for (let k = 1; k <= 10; k++) { up = Math.max(up, (f.hi[i + k] - f.cl[i]) / f.atr[i]); dn = Math.max(dn, (f.cl[i] - f.lo[i + k]) / f.atr[i]) }
    tally(q2b, dn >= 1.5 || up >= 1.5 ? (net >= 0 ? dn >= 1.5 : up >= 1.5) : false)
    if (Math.abs(net) >= 3) tally(q2a, net > 0 ? dn >= 1.5 : up >= 1.5)
  }
  // Q3: the turning point: excess / transformation -> next 5 bars go against the prior leg
  const q3a = stat(), q3b = stat()
  for (let i = 115; i < n - 5; i++) {
    const prior = Math.sign(f.cl[i] - f.cl[i - 10]); if (!prior) continue
    const rev = Math.sign(f.cl[i + 5] - f.cl[i]) === -prior; tally(q3b, rev)
    const p = phaseAt(f, i); if (p === 'excess' || p === 'transformation') tally(q3a, rev)
  }
  // Q4: phase transitions
  const names: DaoPhase[] = ['stillness', 'movement', 'expansion', 'excess', 'transformation']
  const cnt: Record<string, Record<string, number>> = {}; const dwell: Record<string, number> = {}; const runs: Record<string, number[]> = {}
  for (const a of names) { cnt[a] = {}; for (const b of names) cnt[a][b] = 0; runs[a] = [] }
  let prev = phaseAt(f, 110), len = 1
  for (let i = 111; i < n; i++) { const p = phaseAt(f, i); if (p !== prev) { cnt[prev][p]++; runs[prev].push(len); prev = p; len = 1 } else len++ }
  for (const a of names) { const tot = names.reduce((s, b) => s + cnt[a][b], 0); for (const b of names) cnt[a][b] = tot ? cnt[a][b] / tot : 0; dwell[a] = runs[a].length ? runs[a].reduce((x, y) => x + y, 0) / runs[a].length : 0 }
  const q4s = stat()
  for (let i = 110; i < n - 20; i++) if (phaseAt(f, i) === 'stillness') { let m = false; for (let k = 1; k <= 20; k++) { const p = phaseAt(f, i + k); if (p === 'movement' || p === 'expansion') { m = true; break } } tally(q4s, m) }
  // Q5: does inaction help? light lean + light wu wei, next 3 bars
  const q5a = stat(), q5w = stat(), q5all = stat()
  for (let i = 115; i < n - 3; i++) {
    const l = leanAt(f, i); if (l.dir === 'none') continue
    const ok = (l.dir === 'call') === (f.cl[i + 3] > f.cl[i]); if (f.cl[i + 3] === f.cl[i]) continue
    tally(q5all, ok); if (l.blocks.length === 0) tally(q5a, ok); else tally(q5w, ok)
  }
  for (const s of [q1a, q1b, q2a, q2b, q3a, q3b, q4s, q5a, q5w, q5all]) fin(s)
  const l1 = lift(q1a, q1b), l2 = lift(q2a, q2b), l3 = lift(q3a, q3b), l5 = lift(q5a, q5all)
  return {
    ok: true, bars: n,
    q1: { question: 'Does every expansion create conditions for contraction?', afterExpansion: q1a, baseline: q1b, lift: l1, answer: verdict(q1a, q1b, `P(volatility falls to 80% of its 100-bar level within 30 bars | expansion, ATR14 > 1.3 x ATR100) versus ordinary-volatility bars.`) },
    q2: { question: 'Does a strong directional move meet its opposite force?', afterStrong: q2a, baseline: q2b, lift: l2, answer: verdict(q2a, q2b, `P(an opposing 1.5+ ATR excursion within 10 bars | a 3+ ATR move) versus after any move.`) },
    q3: { question: 'Can we see the point where one force turns into the other?', atTurn: q3a, baseline: q3b, lift: l3, answer: verdict(q3a, q3b, `P(next 5 bars go against the prior leg | phase is excess or transformation) versus any bar.`) },
    q4: { question: 'Does the market move between equilibrium and disequilibrium?', matrix: cnt, dwell, stillnessToMovement20: q4s, answer: q4s.n < 30 ? 'Too few stillness periods to say.' : `From stillness, the market reached movement/expansion within 20 bars ${(q4s.rate! * 100).toFixed(0)}% of ${q4s.n} times. Average dwell (bars): ${names.map((p) => `${p} ${dwell[p].toFixed(1)}`).join(', ')}.` },
    q5: { question: 'Can we recognise when the best action is inaction?', whenAct: q5a, whenWait: q5w, all: q5all, lift: l5, answer: verdict(q5a, q5w, `The light lean (push, momentum, scales) over the next 3 bars: right when wu wei said ACT versus when it said WAIT.`) },
  }
}
