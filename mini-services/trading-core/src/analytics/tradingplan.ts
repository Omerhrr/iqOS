// IQAIR//OS - TRADING PLAN (trading.plan): NOT a strategy. It builds the CONDITIONS a strategy wants to trade in, so the strategy only has to supply its own trigger (pm, a Heikin Ashi filter, a pattern ...).
//   1 TREND    : is there an uptrend or a downtrend, and has it NOT gone too far? (structure of swing highs/lows + slope + position vs the mean; "too far" = how much it has already travelled and lasted
//                compared with this pair's own past trends, or being stretched far from the mean). A fresh trend is the only thing the plan wants to join.
//   2 LEVELS   : every support and resistance that mattered (swing clusters, touches, how often price reacted, how recent) + the previous day's high / low / close.
//   3 HOURS    : a vertical line at every hour boundary, so the clock is on the chart. Lines only: no hour is judged or tagged.
//   4 AVOID    : price zones where a trade of that side should not be taken (just under resistance for longs, just over support for shorts, the chop in the middle of a range, chasing a stretched move,
//                right after a spike) and the plain states (no trend, trend too far, against the trend).
//   5 SETUP    : when the conditions are favourable for one side: side (call|put), ready, whether price is at the pullback entry zone, and the plan's stop (beyond the last swing / support) and target (next level).
//                `call when tp.allowCall and <your trigger>`. The scan (analytics/setupscan.ts) runs this over every open pair and keeps the ones in a favourable setup, so the strategy runs only there.
// HONESTY: this is a rule set, not a forecast. "Not gone too far" and the zone widths are judgement; no news calendar is used, so a scheduled release is not an avoid zone. reportPlan() measures, on the pair's
// own history, whether being in a plan setup beat ignoring it - run it before trusting any of this.

import { features, type F } from './dao'
import type { CeCandle } from './causeeffect'

export interface PlanOptions { otc?: boolean; light?: boolean }
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const sg = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0)
const med = (a: number[], fb: number) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : fb }
const DAY = 86400, MIN_BARS = 220

interface Piv { idx: number; price: number; hi: boolean; conf: number }
function pivots(c: CeCandle[]): Piv[] {
  const n = c.length, out: Piv[] = []
  for (let i = 2; i < n - 2; i++) {
    if (c[i].high > c[i - 1].high && c[i].high > c[i - 2].high && c[i].high >= c[i + 1].high && c[i].high >= c[i + 2].high) out.push({ idx: i, price: c[i].high, hi: true, conf: i + 2 })
    if (c[i].low < c[i - 1].low && c[i].low < c[i - 2].low && c[i].low <= c[i + 1].low && c[i].low <= c[i + 2].low) out.push({ idx: i, price: c[i].low, hi: false, conf: i + 2 })
  }
  return out
}
const upTo = (pv: Piv[], i: number) => { let k = pv.length; while (k > 0 && pv[k - 1].conf > i) k--; return pv.slice(0, k) }

// ---------------------------------------------------------------- trend
export type PlanStage = 'early' | 'developing' | 'mature' | 'extended' | 'pullback' | 'broken' | 'none'
export interface PlanTrend { dir: 'up' | 'down' | 'none'; sign: number; strength: number; structure: string; slope: number; stage: PlanStage; age: number; moveAtr: number; maturity: number; retrace: number; stretch: number; tooFar: boolean; fresh: boolean; reasons: string[] }
function trendAt(c: CeCandle[], f: F, pv: Piv[], t: number): PlanTrend {
  const a = f.atr[t], P = upTo(pv, t).filter((p) => p.idx >= t - 150)
  const hs = P.filter((p) => p.hi).slice(-3), ls = P.filter((p) => !p.hi).slice(-3)
  const rising = (x: Piv[]) => x.length >= 2 && x[x.length - 1].price > x[x.length - 2].price + 0.05 * a, falling = (x: Piv[]) => x.length >= 2 && x[x.length - 1].price < x[x.length - 2].price - 0.05 * a
  // a fast move prints few confirmed swings, so price itself breaking the last swing high (low) counts as a rising high (falling low)
  const recentHi = Math.max(...f.hi.slice(t - 4, t + 1)), recentLo = Math.min(...f.lo.slice(t - 4, t + 1)), lowOf10 = Math.min(...f.lo.slice(t - 9, t + 1)), hiOf10 = Math.max(...f.hi.slice(t - 9, t + 1))
  const rHigh = rising(hs) || (hs.length > 0 && recentHi > hs[hs.length - 1].price + 0.2 * a), rLow = rising(ls) || (ls.length > 0 && lowOf10 > ls[ls.length - 1].price + 0.2 * a)
  const fHigh = falling(hs) || (hs.length > 0 && hiOf10 < hs[hs.length - 1].price - 0.2 * a), fLow = falling(ls) || (ls.length > 0 && recentLo < ls[ls.length - 1].price - 0.2 * a)
  const up = (rHigh ? 1 : 0) + (rLow ? 1 : 0), dn = (fHigh ? 1 : 0) + (fLow ? 1 : 0)
  const structScore = up === 2 ? 1 : dn === 2 ? -1 : up === 1 && dn === 0 ? 0.4 : dn === 1 && up === 0 ? -0.4 : 0
  const structure = up === 2 ? 'higher highs and higher lows' : dn === 2 ? 'lower highs and lower lows' : up ? 'only one of high/low is rising' : dn ? 'only one of high/low is falling' : 'no clear swing structure'
  const slope = (f.sma[t] - f.sma[t - 25]) / (25 * a), macro = (f.cl[t] - f.cl[t - 60]) / (60 * a), pos = (f.cl[t] - f.sma[t]) / a
  // the trend is read over the last ~25-60 bars so a pullback INSIDE an uptrend still reads as an uptrend (the stage then says "pullback"), not as no trend
  const score = 0.45 * structScore + 0.3 * clamp(slope / 0.05, -1, 1) + 0.15 * clamp(macro / 0.05, -1, 1) + 0.1 * clamp((f.er[t] - 0.2) / 0.3, 0, 1) * sg(slope)
  const sign = Math.abs(score) >= 0.42 ? sg(score) : 0
  const none: PlanTrend = { dir: 'none', sign: 0, strength: Math.round(Math.abs(score) * 100), structure, slope, stage: 'none', age: 0, moveAtr: 0, maturity: 0, retrace: 0, stretch: f.stretch[t], tooFar: false, fresh: false, reasons: [] }
  if (!sign) return { ...none, reasons: [`no trend: ${structure}, slope ${slope.toFixed(2)} ATR/bar`] }
  // WHERE THE TREND STARTED = the first swing low of the current chain of rising lows (for a downtrend: the first swing high of the chain of falling highs). A trend that has outlasted / outrun most of THIS pair's
  // past chains is "far"; the comparison is a percentile over every completed chain up to now (no look-ahead), not a fixed number.
  const all = upTo(pv, t), seq = all.filter((p) => (sign > 0 ? !p.hi : p.hi)), better = (x: number, y: number) => (sign > 0 ? x > y : x < y)
  const chains: { dur: number; move: number }[] = []
  let cs = 0
  for (let i = 1; i <= seq.length; i++) {
    const broke = i === seq.length || !better(seq[i].price, seq[i - 1].price)
    if (!broke) continue
    if (i - 1 > cs) { const s1 = seq[cs], e1 = seq[i - 1]; let ex = sign > 0 ? -Infinity : Infinity; for (let k = s1.idx; k <= Math.min(t, e1.idx + 6); k++) ex = sign > 0 ? Math.max(ex, f.hi[k]) : Math.min(ex, f.lo[k]); if (i < seq.length) chains.push({ dur: e1.idx - s1.idx, move: Math.abs(ex - s1.price) / (f.atr[s1.idx] || a) }) }
    cs = i
  }
  const cur = seq.length ? seq[cs] : null, s0 = cur ? cur.idx : t - 20, base = cur ? cur.price : (sign > 0 ? f.lo[t - 20] : f.hi[t - 20])
  const age = t - s0, moveAtr = ((f.cl[t] - base) * sign) / a
  let ext = sign > 0 ? -Infinity : Infinity; for (let k = s0; k <= t; k++) ext = sign > 0 ? Math.max(ext, f.hi[k]) : Math.min(ext, f.lo[k])
  const full = Math.abs(ext - base), retrace = full > 0 ? clamp(((ext - f.cl[t]) * sign) / full, -1, 2) : 0
  const pctOf = (xs: number[], v: number, fallback: number) => (xs.length >= 8 ? xs.filter((x) => x <= v).length / xs.length : clamp(v / fallback, 0, 1) * 0.5)
  const agePct = pctOf(chains.map((c1) => c1.dur), age, 40), movePct = pctOf(chains.map((c1) => c1.move), Math.max(0, moveAtr), 5)
  const maturity = Math.max(agePct, movePct), stretch = f.stretch[t] * sign
  let stage: PlanStage = maturity < 0.25 ? 'early' : maturity < 0.55 ? 'developing' : maturity < 0.8 ? 'mature' : 'extended'
  if (retrace > 0.78) stage = 'broken'; else if (retrace > 0.15 && retrace <= 0.62 && stage !== 'extended') stage = 'pullback'
  const tooFar = maturity >= 0.8 || stretch >= 2.4, fresh = !tooFar && retrace <= 0.62 && stage !== 'broken'
  const reasons = [`${sign > 0 ? 'uptrend' : 'downtrend'}: ${structure}`, `started ${age} bars ago and has travelled ${moveAtr.toFixed(1)} ATR: longer than ${(agePct * 100).toFixed(0)}% and bigger than ${(movePct * 100).toFixed(0)}% of this pair's past trends${chains.length < 8 ? ' (few past trends, rough)' : ''} -> ${stage}`]
  if (tooFar) reasons.push(maturity >= 0.8 ? 'it has already run further / longer than most of this pair\'s trends: too far to join' : `price is stretched ${stretch.toFixed(1)} sd from its mean: too far to chase`)
  return { dir: sign > 0 ? 'up' : 'down', sign, strength: Math.round(clamp(Math.abs(score), 0, 1) * 100), structure, slope, stage, age, moveAtr, maturity, retrace, stretch, tooFar, fresh, reasons }
}

// ---------------------------------------------------------------- levels
export interface PlanLevel { price: number; side: 'support' | 'resistance'; touches: number; reactRate: number; ageBars: number; strength: number; distAtr: number; kind: 'swing' | 'prev-day-high' | 'prev-day-low' | 'prev-day-close'; flipped: boolean }
function levelsAt(c: CeCandle[], f: F, pv: Piv[], t: number, clock: boolean): PlanLevel[] {
  const a = f.atr[t], px = c[t].close, P = upTo(pv, t).filter((p) => p.idx >= t - 500)
  const cl: { p: number; n: number; last: number; hi: number; lo: number }[] = []
  for (const x of [...P].sort((p, q) => p.price - q.price)) { const l = cl[cl.length - 1]; if (l && Math.abs(x.price - l.p) <= 0.25 * a) { l.p = (l.p * l.n + x.price) / (l.n + 1); l.n++; l.last = Math.max(l.last, x.idx); if (x.hi) l.hi++; else l.lo++ } else cl.push({ p: x.price, n: 1, last: x.idx, hi: x.hi ? 1 : 0, lo: x.hi ? 0 : 1 }) }
  const out: PlanLevel[] = []
  for (const l of cl) {
    // reaction: how often a touch was followed by a move of >= 0.8 ATR away within 6 bars
    let touch = 0, react = 0
    for (let i = Math.max(105, t - 500); i < t - 6; i++) {
      const ai = f.atr[i]; if (!(ai > 0)) continue
      if (c[i].low <= l.p + 0.2 * ai && c[i].high >= l.p - 0.2 * ai) { touch++; let best = 0; for (let k = 1; k <= 6; k++) best = Math.max(best, Math.abs(c[i + k].close - l.p)); if (best >= 0.8 * ai) react++; i += 3 }
    }
    const reactRate = touch ? (react + 1) / (touch + 2) : 0.5, ageBars = t - l.last
    const strength = Math.round(clamp(Math.min(1, l.n / 5) * 50 + reactRate * 35 + clamp(1 - ageBars / 300, 0, 1) * 15, 0, 100))
    const side = l.p > px ? 'resistance' : 'support', flipped = (side === 'support' && l.hi > l.lo) || (side === 'resistance' && l.lo > l.hi)
    out.push({ price: l.p, side, touches: l.n, reactRate, ageBars, strength, distAtr: Math.abs(l.p - px) / a, kind: 'swing', flipped })
  }
  if (clock) { // previous UTC day's high / low / close
    const day = Math.floor(c[t].time / DAY); let h = -Infinity, lo = Infinity, cls = NaN
    for (let i = t; i >= 0 && Math.floor(c[i].time / DAY) >= day - 1; i--) { if (Math.floor(c[i].time / DAY) === day - 1) { h = Math.max(h, c[i].high); lo = Math.min(lo, c[i].low); if (!Number.isFinite(cls)) cls = c[i].close } }
    for (const [p, kind] of [[h, 'prev-day-high'], [lo, 'prev-day-low'], [cls, 'prev-day-close']] as [number, PlanLevel['kind']][]) if (Number.isFinite(p)) out.push({ price: p, side: p > px ? 'resistance' : 'support', touches: 1, reactRate: 0.5, ageBars: 0, strength: kind === 'prev-day-close' ? 35 : 60, distAtr: Math.abs(p - px) / a, kind, flipped: false })
  }
  return out.sort((x, y) => x.price - y.price)
}

// ---------------------------------------------------------------- hours (vertical lines only)
export interface PlanMark { time: number; hour: number; label: string; now: boolean }
/** a vertical line at every hour boundary from 6 hours back to 18 hours ahead of the last bar (UTC hours) */
export function hourMarks(lastBarTime: number): PlanMark[] {
  const base = Math.floor(lastBarTime / 3600) * 3600, out: PlanMark[] = []
  for (let j = -6; j <= 18; j++) { const tm = base + j * 3600, hr = Math.floor((tm % DAY) / 3600); out.push({ time: tm, hour: hr, label: `${String(hr).padStart(2, '0')}:00`, now: j === 0 }) }
  return out
}

// ---------------------------------------------------------------- the plan
export interface PlanAvoid { kind: 'price' | 'state'; side: 'call' | 'put' | 'both'; from: number; to: number; reason: string; active: boolean }
export interface PlanSetup { side: 'call' | 'put' | 'none'; ready: boolean; quality: number; allowCall: boolean; allowPut: boolean; stop: number; target: number; rr: number; entryLow: number; entryHigh: number; atEntry: boolean; reasons: string[]; blocks: string[] }
export interface PlanResult {
  ok: boolean; error?: string; price: number; atr: number; tfSec: number
  trend: PlanTrend; levels: PlanLevel[]; marks: PlanMark[]; avoid: PlanAvoid[]; setup: PlanSetup
  lines: string[]; text: string
}

interface Core { trend: PlanTrend; levels: PlanLevel[]; avoid: PlanAvoid[]; allowCall: boolean; allowPut: boolean; stop: number; target: number; rr: number; entryLow: number; entryHigh: number; atEntry: boolean; blocksCall: string[]; blocksPut: string[]; reasons: string[] }
function core(c: CeCandle[], f: F, pv: Piv[], t: number): Core {
  const a = f.atr[t], px = c[t].close, trend = trendAt(c, f, pv, t), levels = levelsAt(c, f, pv, t, f.clock)
  const sup = levels.filter((l) => l.side === 'support').sort((x, y) => y.price - x.price), res = levels.filter((l) => l.side === 'resistance').sort((x, y) => x.price - y.price)
  const strongSup = sup.filter((l) => l.strength >= 40), strongRes = res.filter((l) => l.strength >= 40)
  const avoid: PlanAvoid[] = []
  // price zones
  const r1 = strongRes[0], s1 = strongSup[0]
  if (r1) { const lo = r1.price - 0.8 * a, hi = r1.price + 0.15 * a; avoid.push({ kind: 'price', side: 'call', from: lo, to: hi, reason: `buying into resistance ${r1.price.toPrecision(6)} (${r1.touches} touches, reacted ${(r1.reactRate * 100).toFixed(0)}%)`, active: px >= lo && px <= hi }) }
  if (s1) { const lo = s1.price - 0.15 * a, hi = s1.price + 0.8 * a; avoid.push({ kind: 'price', side: 'put', from: lo, to: hi, reason: `selling into support ${s1.price.toPrecision(6)} (${s1.touches} touches, reacted ${(s1.reactRate * 100).toFixed(0)}%)`, active: px >= lo && px <= hi }) }
  if (r1 && s1 && r1.price - s1.price >= 2 * a) { const mid = (r1.price + s1.price) / 2, half = 0.2 * (r1.price - s1.price); avoid.push({ kind: 'price', side: 'both', from: mid - half, to: mid + half, reason: 'the middle of the range between support and resistance: no edge, no room for a stop', active: Math.abs(px - mid) <= half }) }
  const chasing = trend.sign !== 0 && trend.stretch >= 2.2
  if (chasing) avoid.push({ kind: 'state', side: trend.sign > 0 ? 'call' : 'put', from: px, to: px, reason: `stretched ${trend.stretch.toFixed(1)} sd from the mean in the trend direction: chasing`, active: true })
  let spike = -1; for (let k = 0; k <= 2; k++) if (Math.abs(c[t - k].close - c[t - k].open) > 2.5 * f.atr[t - k]) { spike = k; break }
  if (spike >= 0) avoid.push({ kind: 'state', side: 'both', from: px, to: px, reason: `a ${(Math.abs(c[t - spike].close - c[t - spike].open) / f.atr[t - spike]).toFixed(1)} ATR bar ${spike} bar(s) ago: let it settle`, active: true })
  // plan levels for the trend side
  let stop = NaN, target = NaN, rr = NaN, entryLow = NaN, entryHigh = NaN, atEntry = false
  const blocksCall: string[] = [], blocksPut: string[] = [], reasons: string[] = []
  const P = upTo(pv, t)
  if (trend.sign > 0) {
    const swing = P.filter((p) => !p.hi && p.price < px).slice(-1)[0], base = s1 ?? sup[0]
    stop = Math.min(swing?.price ?? px - 1.5 * a, base ? base.price : Infinity, px - 0.8 * a) - 0.3 * a
    const risk = px - stop; target = (res.find((l) => l.price - px >= 1.2 * risk) ?? res[res.length - 1])?.price ?? px + 2 * risk
    rr = target > px ? (target - px) / risk : NaN
    if (base) { entryLow = base.price; entryHigh = base.price + 0.6 * a; atEntry = px <= entryHigh + 0.4 * a && px >= entryLow - 0.2 * a }
  } else if (trend.sign < 0) {
    const swing = P.filter((p) => p.hi && p.price > px).slice(-1)[0], base = r1 ?? res[0]
    stop = Math.max(swing?.price ?? px + 1.5 * a, base ? base.price : -Infinity, px + 0.8 * a) + 0.3 * a
    const risk = stop - px; target = ([...sup].find((l) => px - l.price >= 1.2 * risk) ?? sup[sup.length - 1])?.price ?? px - 2 * risk
    rr = target < px ? (px - target) / risk : NaN
    if (base) { entryHigh = base.price; entryLow = base.price - 0.6 * a; atEntry = px >= entryLow - 0.4 * a && px <= entryHigh + 0.2 * a }
  }
  // the gates per side
  const side = (s: 1 | -1, blocks: string[]) => {
    const dirOk = trend.sign === s
    if (!trend.sign) blocks.push('no trend to join'); else if (!dirOk) blocks.push(`against the ${trend.dir}trend`)
    if (dirOk && trend.tooFar) blocks.push('the trend has already gone too far')
    if (dirOk && !trend.tooFar && !trend.fresh) blocks.push(`the trend is ${trend.stage} (retraced ${(trend.retrace * 100).toFixed(0)}%)`)
    for (const z of avoid) if (z.active && (z.side === 'both' || z.side === (s > 0 ? 'call' : 'put'))) blocks.push(z.reason)
    return dirOk && blocks.length === 0
  }
  const allowCall = side(1, blocksCall), allowPut = side(-1, blocksPut)
  if (allowCall || allowPut) { reasons.push(...trend.reasons); if (Number.isFinite(rr)) reasons.push(`stop ${stop.toPrecision(6)} / target ${target.toPrecision(6)} = ${rr.toFixed(1)}R`) }
  return { trend, levels, avoid, allowCall, allowPut, stop, target, rr, entryLow, entryHigh, atEntry, blocksCall, blocksPut, reasons }
}

export function readPlan(candles: CeCandle[], opts: PlanOptions = {}): PlanResult {
  const c = candles.filter((x) => x && [x.time, x.open, x.high, x.low, x.close].every((v) => Number.isFinite(v))).slice(-1600)
  const none = {} as never
  const emptySetup = (blocks: string[]): PlanSetup => ({ side: 'none', ready: false, quality: 0, allowCall: false, allowPut: false, stop: NaN, target: NaN, rr: NaN, entryLow: NaN, entryHigh: NaN, atEntry: false, reasons: [], blocks })
  const fail = (error: string): PlanResult => ({ ok: false, error, price: NaN, atr: NaN, tfSec: 0, trend: none, levels: [], marks: [], avoid: [], setup: emptySetup([error]), lines: [error], text: error })
  if (c.length < MIN_BARS) return fail(`needs ${MIN_BARS} closed bars, have ${c.length}`)
  const f = features(c), n = f.n, t = n - 1, a = f.atr[t]
  if (!(a > 0)) return fail('ATR not ready')
  const dts: number[] = []; for (let i = n - 60; i < n; i++) if (i > 0) dts.push(c[i].time - c[i - 1].time)
  const tfSec = Math.max(1, med(dts, 60))
  const k = core(c, f, pv0(c), t)
  const marks = opts.light ? [] : hourMarks(c[t].time)
  const side: 'call' | 'put' | 'none' = k.allowCall ? 'call' : k.allowPut ? 'put' : 'none', ready = side !== 'none'
  const blocks = k.trend.sign > 0 ? k.blocksCall : k.trend.sign < 0 ? k.blocksPut : [...new Set([...k.blocksCall, ...k.blocksPut])].slice(0, 4)
  // quality, for ranking setups against each other: a stronger, younger trend, price sitting in the pullback entry zone, and room to the target
  const quality = ready ? Math.round(clamp(k.trend.strength * 0.5 + (1 - k.trend.maturity) * 25 + (k.atEntry ? 20 : 0) + (Number.isFinite(k.rr) ? clamp(k.rr, 0, 3) * 2 : 0), 0, 100)) : 0
  const px = c[t].close, fmt = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(3) : x.toFixed(5)) : '-')
  const supL = k.levels.filter((l) => l.side === 'support').sort((x, y) => y.price - x.price).slice(0, 4), resL = k.levels.filter((l) => l.side === 'resistance').sort((x, y) => x.price - y.price).slice(0, 4)
  const lines = [
    `TREND: ${k.trend.dir === 'none' ? k.trend.reasons[0] : k.trend.reasons.join('. ')}.`,
    `LEVELS: resistance ${resL.length ? resL.map((l) => `${fmt(l.price)} (${l.distAtr.toFixed(1)} ATR, str ${l.strength}${l.kind !== 'swing' ? ', ' + l.kind : ''})`).join(' | ') : 'none above'}; support ${supL.length ? supL.map((l) => `${fmt(l.price)} (${l.distAtr.toFixed(1)} ATR, str ${l.strength}${l.kind !== 'swing' ? ', ' + l.kind : ''})`).join(' | ') : 'none below'}.`,
    `AVOID: ${k.avoid.filter((z) => z.active).map((z) => `${z.side === 'both' ? '' : z.side.toUpperCase() + ': '}${z.reason}`).slice(0, 6).join(' | ') || 'price is not in any avoid zone'}.`,
    `SETUP: ${ready ? `${side.toUpperCase()}-side conditions are favourable (quality ${quality}/100)${k.atEntry ? ', price is in the pullback entry zone' : ', price has not pulled back to the entry zone yet'}: entry zone ${fmt(k.entryLow)}-${fmt(k.entryHigh)}, stop ${fmt(k.stop)}, target ${fmt(k.target)} (${Number.isFinite(k.rr) ? k.rr.toFixed(1) + 'R' : '-'}). Your strategy supplies the trigger.` : 'no favourable setup: ' + (blocks.slice(0, 3).join('; ') || 'no trend')}`,
  ]
  return { ok: true, price: px, atr: a, tfSec, trend: k.trend, levels: k.levels, marks, avoid: k.avoid,
    setup: { side, ready, quality, allowCall: k.allowCall, allowPut: k.allowPut, stop: k.stop, target: k.target, rr: k.rr, entryLow: k.entryLow, entryHigh: k.entryHigh, atEntry: k.atEntry, reasons: k.reasons, blocks }, lines, text: lines.join('\n') }
}
const pv0 = (c: CeCandle[]) => pivots(c)

// ---------------------------------------------------------------- does following the plan help?
export interface PlanGroup { n: number; hit: number; rate: number | null; z: number | null }
export interface PlanReport { ok: boolean; error?: string; bars: number; groups: Record<string, PlanGroup>; verdict: string }
const passage = (c: CeCandle[], a: number, i: number, dir: number): boolean | null => { const b = c[i].close; for (let k = 1; k <= 10 && i + k < c.length; k++) { const u = c[i + k].high >= b + a, d = c[i + k].low <= b - a; if (u && d) return null; if (u) return dir > 0; if (d) return dir < 0 } return null }
/** Samples the plan's own gates over history (no look-ahead) and asks whether price went +1 ATR in the trend direction before -1 ATR within 10 bars, for fresh trends, too-far trends, entries against the trend and entries inside avoid zones. */
export function reportPlan(candles: CeCandle[], opts: { step?: number } = {}): PlanReport {
  const c = candles.filter((x) => x && [x.time, x.open, x.high, x.low, x.close].every((v) => Number.isFinite(v)))
  if (c.length < 500) return { ok: false, error: `needs 500 closed bars, have ${c.length}`, bars: c.length, groups: {}, verdict: '' }
  const f = features(c), pv = pivots(c), step = Math.max(1, Math.round(opts.step ?? 3)), n = c.length
  const G: Record<string, { n: number; hit: number }> = {}, add = (k: string, ok: boolean) => { const g = (G[k] ??= { n: 0, hit: 0 }); g.n++; if (ok) g.hit++ }
  for (let t = 160; t < n - 12; t += step) {
    const k = core(c, f, pv, t), a = f.atr[t]; if (!(a > 0)) continue
    const tr = k.trend; if (!tr.sign) { const up = passage(c, a, t, 1); if (up !== null) add('no trend: price went up first (baseline for either side)', up); continue }
    const r = passage(c, a, t, tr.sign); if (r === null) continue
    const inZone = k.avoid.some((z) => z.kind === 'price' && z.active && (z.side === 'both' || z.side === (tr.sign > 0 ? 'call' : 'put')))
    add('any trend direction (all bars)', r)
    if (tr.fresh && !inZone) add('PLAN: fresh trend, not in an avoid zone', r)
    if (tr.fresh && inZone) add('fresh trend but INSIDE an avoid zone', r)
    if (tr.tooFar) add('trend TOO FAR', r)
    if (tr.fresh && k.atEntry && !inZone) add('PLAN + at the pullback entry zone', r)
    const against = passage(c, a, t, -tr.sign); if (against !== null) add('AGAINST the trend (fading it)', against)
  }
  const base = G['any trend direction (all bars)'], groups: Record<string, PlanGroup> = {}
  for (const [key, g] of Object.entries(G)) { const rate = g.n ? g.hit / g.n : null; let z: number | null = null; if (base && base.n > 30 && rate !== null && key !== 'any trend direction (all bars)') { const b = base.hit / base.n, se = Math.sqrt((b * (1 - b)) / g.n); z = se > 0 ? (rate - b) / se : null } groups[key] = { n: g.n, hit: g.hit, rate, z } }
  const baseG = groups['any trend direction (all bars)'], p = groups['PLAN: fresh trend, not in an avoid zone'], tf = groups['trend TOO FAR'], zn = groups['fresh trend but INSIDE an avoid zone']
  const pct = (g?: PlanGroup) => (g?.rate != null ? `${(g.rate * 100).toFixed(0)}% of ${g.n}` : 'n/a')
  const verdict = !base || base.n < 60 ? 'Too few trend samples to judge.' : [
    p && p.n >= 30 && p.z !== null ? (p.z >= 2 ? `Following the plan (fresh trend, outside avoid zones) did beat the average trend bar: ${pct(p)} vs ${pct(baseG)} (z ${p.z.toFixed(1)}).` : p.z <= -2 ? `Following the plan did WORSE than the average trend bar: ${pct(p)} vs ${pct(baseG)} (z ${p.z.toFixed(1)}).` : `Following the plan was not clearly different from the average trend bar: ${pct(p)} vs ${pct(baseG)} (z ${p.z.toFixed(1)}).`) : 'Too few plan setups to judge.',
    tf && tf.n >= 30 && tf.z !== null ? `Trends flagged TOO FAR: ${pct(tf)} (z ${tf.z.toFixed(1)}) - ${tf.z <= -2 ? 'avoiding them helped' : tf.z >= 2 ? 'they actually did better, so the too-far filter cost you' : 'no clear difference'}.` : '',
    zn && zn.n >= 30 && zn.z !== null ? `Entries inside an avoid zone: ${pct(zn)} (z ${zn.z.toFixed(1)}) - ${zn.z <= -2 ? 'avoiding them helped' : zn.z >= 2 ? 'they did better, the zones cost you' : 'no clear difference'}.` : '',
  ].filter(Boolean).join(' ')
  return { ok: true, bars: n, groups, verdict }
}
