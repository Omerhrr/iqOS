// IQAIR//OS - NEXT MOVE ("nm"): where price IS and what it has done from places like this.
//
// pm (causeeffect.ts) asks "who is pushing right now" (volume/ticks -> next candle). nm asks about PRICE ITSELF: its map and its path.
//   MAP     : yesterday's open/high/low/close, today's open and range so far, the gap, where price sits in the day, session context (Asia/London/NY/off) and how the LAST session moved and ended.
//   CAUSES  : zones (day levels + swing support/resistance), linear-regression state (slope, R^2, stretch from the line in sigmas), bull/bear structure (HH/HL vs LH/LL), exhaustion, the last swing legs.
//   LEDGER  : how price actually treated those levels before - held or broke - counted over the history (day levels and the nearest swing levels).
//   PATH    : every bar is turned into a fingerprint of the causes above (all scaled by ATR so quiet and wild days compare); the nearest historical fingerprints that have a KNOWN outcome vote on the next
//             candle, the next `horizon` candles, and "does price reach the level above before the level below" (their own forward paths are replayed against today's actual distances).
//   CHECK   : walk-forward - each of the last N calls is made with only the bars that were already resolved at that time. `validated` = that hit rate beat chance on enough calls.
// HONESTY: analog matching is a count of what happened after similar-looking moments, not an understanding of why. The fingerprint weights are judgement, not fitted. With few similar moments it says so
// (ok:false) instead of guessing. Some patterns pass the walk-forward test by luck. Backtest per pair before trusting it. OTC stays a hypothesis: its "sessions" are clock hours of a generated feed.

import { atr as atrInd } from './indicators'

export interface NmCandle { time: number; open: number; high: number; low: number; close: number; volume?: number }
export interface NmOptions { horizon?: number; k?: number; track?: number; otc?: boolean; minHistory?: number }

export type NmSession = 'asia' | 'london' | 'ny' | 'off'

export interface NmResult {
  ok: boolean
  error?: string
  nm: { dir: 'call' | 'put' | 'none'; sign: number; prob: number; horizonProb: number; moveAtr: number; confidence: number; validated: boolean; price: number }
  validation: { neighbors: number; pool: number; nearDist: number; trackN: number; trackHit: number; validated: boolean }
  reach: { upLevel: number; upDist: number; downLevel: number; downDist: number; pUpFirst: number; pDownFirst: number; pNeither: number }
  map: { prevOpen: number; prevHigh: number; prevLow: number; prevClose: number; dayOpen: number; dayHigh: number; dayLow: number; rangePos: number; gapAtr: number; session: NmSession; sessionMoveAtr: number; lastSession: NmSession | 'none'; lastSessionMoveAtr: number; lastSessionEndAtr: number; clock: boolean }
  causes: { structure: 'bull' | 'bear' | 'mixed'; regSlope: number; regR2: number; regZ: number; exhaustion: number; lastLegAtr: number; atSupport: boolean; atResistance: boolean; bias: 'call' | 'put' | 'none' }
  ledger: { dayHighHold: number; dayHighN: number; dayLowHold: number; dayLowN: number; supHold: number; supN: number; resHold: number; resN: number }
  text: string
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const DAY = 86400
const sessionOf = (t: number): NmSession => { const h = Math.floor((t % DAY) / 3600); return h < 7 ? 'asia' : h < 13 ? 'london' : h < 21 ? 'ny' : 'off' }
const spacingOf = (c: NmCandle[]) => { let b = Infinity; for (let i = 1; i < c.length; i++) { const g = c[i].time - c[i - 1].time; if (g > 0 && g < b) b = g } return Number.isFinite(b) ? b : 60 }

interface Piv { idx: number; price: number; hi: boolean; conf: number }
const D = 11 // fingerprint dimensions
const POOL = 1200 // only the most recent bars are searched for similar moments
const MAX_BARS = 1600 // longer series are trimmed to their latest bars
// judgement weights, in dimension order: rangePos, gap, distPrevHigh, distPrevLow, regZ, regSlope, structure, lastLeg, exhaustion, sin(hour), cos(hour)
const W = [1.2, 0.6, 0.9, 0.9, 1.3, 0.9, 1.0, 0.7, 0.9, 0.35, 0.35]

interface Feat { v: number[]; atr: number; ok: boolean }

function build(c: NmCandle[]) {
  const n = c.length, sp = spacingOf(c)
  const clock = c[0].time > 1e8
  const hi = c.map((x) => x.high), lo = c.map((x) => x.low), cl = c.map((x) => x.close)
  const atr = atrInd(hi, lo, cl, 14)
  const dayKey = (t: number) => (clock ? Math.floor(t / DAY) : Math.floor((t * sp) / DAY))
  // fractal pivots (strength 2), known only 2 bars after the pivot bar
  const piv: Piv[] = []
  for (let i = 2; i < n - 2; i++) {
    if (hi[i] > hi[i - 1] && hi[i] > hi[i - 2] && hi[i] >= hi[i + 1] && hi[i] >= hi[i + 2]) piv.push({ idx: i, price: hi[i], hi: true, conf: i + 2 })
    if (lo[i] < lo[i - 1] && lo[i] < lo[i - 2] && lo[i] <= lo[i + 1] && lo[i] <= lo[i + 2]) piv.push({ idx: i, price: lo[i], hi: false, conf: i + 2 })
  }
  piv.sort((a, b) => a.idx - b.idx)
  // per-day aggregates, filled incrementally (no look-ahead)
  const prevD = new Array<{ o: number; h: number; l: number; c: number } | null>(n).fill(null)
  const dOpen = new Array<number>(n), dHigh = new Array<number>(n), dLow = new Array<number>(n)
  let cur: { key: number; o: number; h: number; l: number; c: number } | null = null, prev: { o: number; h: number; l: number; c: number } | null = null
  for (let i = 0; i < n; i++) {
    const k = dayKey(c[i].time)
    if (!cur || cur.key !== k) { if (cur) prev = { o: cur.o, h: cur.h, l: cur.l, c: cur.c }; cur = { key: k, o: c[i].open, h: c[i].high, l: c[i].low, c: c[i].close } }
    else { cur.h = Math.max(cur.h, c[i].high); cur.l = Math.min(cur.l, c[i].low); cur.c = c[i].close }
    prevD[i] = prev; dOpen[i] = cur.o; dHigh[i] = cur.h; dLow[i] = cur.l
  }
  const feats: Feat[] = []
  let pi = 0
  const confirmed: Piv[] = []
  const WIN = 40
  for (let t = 0; t < n; t++) {
    while (pi < piv.length && piv[pi].conf <= t) confirmed.push(piv[pi++])
    const a = Number.isFinite(atr[t]) && atr[t] > 0 ? atr[t] : NaN
    if (t < WIN || !Number.isFinite(a)) { feats.push({ v: [], atr: a, ok: false }); continue }
    // regression over the last WIN closes
    let sx = 0, sy = 0, sxy = 0, sxx = 0
    for (let k = 0; k < WIN; k++) { const y = cl[t - WIN + 1 + k]; sx += k; sy += y; sxy += k * y; sxx += k * k }
    const den = WIN * sxx - sx * sx, slope = (WIN * sxy - sx * sy) / den, icpt = (sy - slope * sx) / WIN
    let ssr = 0, sst = 0; const my = sy / WIN
    for (let k = 0; k < WIN; k++) { const y = cl[t - WIN + 1 + k], f = icpt + slope * k; ssr += (y - f) ** 2; sst += (y - my) ** 2 }
    const sd = Math.sqrt(ssr / WIN) || a
    const regZ = clamp((cl[t] - (icpt + slope * (WIN - 1))) / sd, -3, 3), regSlope = clamp((slope / a) * 10, -2, 2)
    const p = prevD[t], span = dHigh[t] - dLow[t]
    const rangePos = span > 0.2 * a ? (cl[t] - dLow[t]) / span : 0.5
    const gap = p ? clamp((dOpen[t] - p.c) / a, -4, 4) / 4 : 0
    const dph = p ? clamp((p.h - cl[t]) / a, -5, 5) / 5 : 0, dpl = p ? clamp((cl[t] - p.l) / a, -5, 5) / 5 : 0
    // structure from the last two confirmed highs and lows
    let h0: Piv | undefined, h1: Piv | undefined, l0: Piv | undefined, l1: Piv | undefined
    for (let q = confirmed.length - 1; q >= 0 && !(h1 && l1); q--) { const x = confirmed[q]; if (x.hi) { if (!h0) h0 = x; else if (!h1) h1 = x } else { if (!l0) l0 = x; else if (!l1) l1 = x } }
    let st = 0
    if (h0 && h1 && l0 && l1) { st = (h0.price > h1.price ? 0.5 : -0.5) + (l0.price > l1.price ? 0.5 : -0.5) }
    const last = confirmed[confirmed.length - 1], before = confirmed[confirmed.length - 2]
    const leg = last && before ? clamp((last.price - before.price) / a, -6, 6) / 6 : 0
    const exh = clamp((cl[t] - cl[t - 5]) / a, -6, 6) / 6
    const ang = clock ? ((c[t].time % DAY) / DAY) * 2 * Math.PI : 0
    feats.push({ v: [rangePos * 2 - 1, gap, dph, dpl, regZ / 3, regSlope / 2, st, leg, exh, clock ? Math.sin(ang) : 0, clock ? Math.cos(ang) : 0], atr: a, ok: true })
  }
  return { feats, atr, confirmed, prevD, dOpen, dHigh, dLow, clock, sp, dayKey }
}

function dist(a: number[], b: number[]): number { let s = 0; for (let i = 0; i < D; i++) { const d = (a[i] - b[i]) * W[i]; s += d * d } return Math.sqrt(s) }

interface Vote { prob: number; hProb: number; move: number; k: number; near: number; pool: number; idx: number[] }
/** nearest historical fingerprints (outcome known: j + H <= limit) -> their next-candle and horizon statistics */
function vote(c: NmCandle[], feats: Feat[], t: number, H: number, kWant: number, limit: number): Vote | null {
  const q = feats[t]; if (!q.ok) return null
  let cand: { j: number; d: number }[] = []
  const lo = Math.max(41, Math.min(limit, t) - POOL)
  for (let j = lo; j + H <= limit && j < t; j++) { const f = feats[j]; if (!f.ok) continue; cand.push({ j, d: dist(q.v, f.v) }) }
  if (cand.length < 40) return null
  const poolN = cand.length
  const k = Math.min(poolN, Math.max(12, Math.min(kWant, Math.floor(poolN / 6))))
  // only the closest ~4k can be picked after thinning: find that distance cut with a typed-array sort, then sort just the survivors
  if (poolN > 4 * k) { const ds = new Float64Array(poolN); for (let i = 0; i < poolN; i++) ds[i] = cand[i].d; ds.sort(); const cut = ds[4 * k - 1]; cand = cand.filter((x) => x.d <= cut) }
  cand.sort((x, y) => x.d - y.d)
  // thin out neighbours that are adjacent bars of the same moment: keep at most one per 3 bars
  const picked: { j: number; d: number }[] = []
  for (const x of cand) { if (picked.length >= k) break; if (picked.every((p) => Math.abs(p.j - x.j) >= 3)) picked.push(x) }
  let up = 0, hup = 0, mv = 0, dsum = 0
  for (const { j, d } of picked) {
    const a = feats[j].atr
    if (c[j + 1].close > c[j].close) up++
    if (c[j + H].close > c[j].close) hup++
    mv += (c[j + H].close - c[j].close) / a; dsum += d
  }
  const m = picked.length, S = 10
  return { prob: (up + 0.5 * S) / (m + S), hProb: (hup + 0.5 * S) / (m + S), move: mv / m, k: m, near: dsum / m, pool: poolN, idx: picked.map((p) => p.j) }
}

const cluster = (ps: Piv[], atr: number) => { const out: { p: number; t: number }[] = []; for (const x of [...ps].sort((a, b) => a.price - b.price)) { const l = out[out.length - 1]; if (l && Math.abs(x.price - l.p) <= 0.25 * atr) { l.p = (l.p * l.t + x.price) / (l.t + 1); l.t++ } else out.push({ p: x.price, t: 1 }) } return out }

/** how often price HELD a level (touch, then closed >=0.3 ATR back on the origin side 3 bars later) versus broke it, over a bar range */
function holdStat(c: NmCandle[], level: (i: number) => number, side: 'res' | 'sup', atr: number[], from: number, to: number): { hold: number; n: number } {
  let held = 0, n = 0
  for (let i = from; i < to - 3; i++) {
    const L = level(i), a = atr[i]; if (!Number.isFinite(L) || !Number.isFinite(a) || a <= 0) continue
    const touch = side === 'res' ? c[i].high >= L - 0.2 * a && c[i].high <= L + 0.4 * a && c[i].close < L : c[i].low <= L + 0.2 * a && c[i].low >= L - 0.4 * a && c[i].close > L
    if (!touch) continue
    n++; const f = c[i + 3].close
    if (side === 'res' ? f < L - 0.3 * a : f > L + 0.3 * a) held++
    i += 2
  }
  return { hold: n ? (held + 0.5 * 4) / (n + 4) : 0.5, n }
}

export function readNextMove(candles: NmCandle[], opts: NmOptions = {}): NmResult {
  const H = Math.max(2, Math.min(30, Math.round(opts.horizon ?? 5))), kWant = opts.k ?? 30, trackN = opts.track ?? (opts.otc ? 150 : 90), minHistory = opts.minHistory ?? 150, otc = !!opts.otc
  const nul: NmResult = { ok: false, nm: { dir: 'none', sign: 0, prob: 0.5, horizonProb: 0.5, moveAtr: 0, confidence: 0, validated: false, price: NaN }, validation: { neighbors: 0, pool: 0, nearDist: NaN, trackN: 0, trackHit: NaN, validated: false }, reach: { upLevel: NaN, upDist: NaN, downLevel: NaN, downDist: NaN, pUpFirst: 0.5, pDownFirst: 0.5, pNeither: 0 }, map: { prevOpen: NaN, prevHigh: NaN, prevLow: NaN, prevClose: NaN, dayOpen: NaN, dayHigh: NaN, dayLow: NaN, rangePos: 0.5, gapAtr: 0, session: 'off', sessionMoveAtr: 0, lastSession: 'none', lastSessionMoveAtr: 0, lastSessionEndAtr: 0, clock: false }, causes: { structure: 'mixed', regSlope: 0, regZ: 0, regR2: 0, exhaustion: 0, lastLegAtr: 0, atSupport: false, atResistance: false, bias: 'none' }, ledger: { dayHighHold: 0.5, dayHighN: 0, dayLowHold: 0.5, dayLowN: 0, supHold: 0.5, supN: 0, resHold: 0.5, resN: 0 }, text: '' }
  const c = candles.filter((x) => x && [x.time, x.open, x.high, x.low, x.close].every((v) => Number.isFinite(v))).slice(-MAX_BARS)
  if (c.length < minHistory) return { ...nul, error: `needs ${minHistory} closed bars, have ${c.length}`, text: `needs ${minHistory} closed bars, have ${c.length}` }
  const B = build(c), n = c.length, t = n - 1, f = B.feats[t]
  if (!f.ok) return { ...nul, error: 'ATR / regression window not ready', text: 'ATR / regression window not ready' }
  const a = f.atr, px = c[t].close
  // ---- the analog vote for NOW (outcomes resolved up to bar t) ----
  const v = vote(c, B.feats, t, H, kWant, t)
  // ---- walk-forward track: each past call uses only fingerprints whose outcome was known at that time ----
  let tn = 0, th = 0
  for (let s = Math.max(60, n - 1 - trackN); s < n - 1; s += 3) { // every 3rd bar: neighbouring calls are nearly the same moment, and it keeps this fast enough to backtest
    const vs = vote(c, B.feats, s, H, kWant, s); if (!vs || Math.abs(vs.prob - 0.5) < 0.04) continue
    if (c[s + 1].close === c[s].close) continue
    tn++; if ((vs.prob > 0.5) === (c[s + 1].close > c[s].close)) th++
  }
  const trackHit = tn ? th / tn : NaN
  const validated = otc ? tn >= 30 && trackHit > 0.55 : tn >= 20 && trackHit > 0.52
  // ---- map ----
  const p = B.prevD[t], dayOpen = B.dOpen[t], dayHigh = B.dHigh[t], dayLow = B.dLow[t], span = dayHigh - dayLow
  const rangePos = span > 0.2 * a ? (px - dayLow) / span : 0.5
  const ses = B.clock ? sessionOf(c[t].time) : 'off'
  // session segments: group consecutive bars of the same (day, session)
  let segStart = t; const key = (i: number) => `${B.dayKey(c[i].time)}|${B.clock ? sessionOf(c[i].time) : 'off'}`
  const ck = key(t); while (segStart > 0 && key(segStart - 1) === ck) segStart--
  let lastSes: NmSession | 'none' = 'none', lsMove = 0, lsEnd = 0
  if (segStart > 5) { const e = segStart - 1; let s0 = e; const pk = key(e); while (s0 > 0 && key(s0 - 1) === pk) s0--; if (e - s0 >= 4) { lastSes = B.clock ? sessionOf(c[e].time) : 'off'; lsMove = (c[e].close - c[s0].open) / a; const k3 = s0 + Math.floor((e - s0) * 0.75); lsEnd = (c[e].close - c[k3].close) / a } }
  const sessionMove = (px - c[segStart].open) / a
  const gapAtr = p ? (dayOpen - p.c) / a : 0
  // ---- causes ----
  let st: 'bull' | 'bear' | 'mixed' = 'mixed'; if (f.v[6] >= 0.99) st = 'bull'; else if (f.v[6] <= -0.99) st = 'bear'
  const regZ = f.v[4] * 3
  let r2 = 0; { const W2 = 40; let sy = 0, sx = 0, sxy = 0, sxx = 0, syy = 0; for (let k = 0; k < W2; k++) { const y = c[t - W2 + 1 + k].close; sx += k; sy += y; sxy += k * y; sxx += k * k; syy += y * y } const num = W2 * sxy - sx * sy, d2 = Math.sqrt((W2 * sxx - sx * sx) * (W2 * syy - sy * sy)); r2 = d2 > 0 ? (num / d2) ** 2 : 0 }
  // ---- levels above/below: day levels + swing clusters (confirmed pivots only) ----
  const cl = cluster(B.confirmed.slice(-60), a)
  const lv: number[] = cl.filter((x) => x.t >= 2).map((x) => x.p)
  if (p) lv.push(p.h, p.l, p.c)
  lv.push(dayHigh, dayLow)
  const above = lv.filter((x) => x > px + 0.15 * a).sort((x, y) => x - y)[0], below = lv.filter((x) => x < px - 0.15 * a).sort((x, y) => y - x)[0]
  const upDist = Number.isFinite(above) ? (above - px) / a : 3, downDist = Number.isFinite(below) ? (px - below) / a : 3
  // ---- reach: replay neighbours' own forward paths against TODAY's distances ----
  let pUp = 0.5, pDn = 0.5, pNo = 0
  if (v) {
    let u = 0, d = 0, no = 0
    for (const j of v.idx) {
      const aj = B.feats[j].atr; let res = 0
      for (let s = 1; s <= H && res === 0; s++) { const hiS = (c[j + s].high - c[j].close) / aj, loS = (c[j].close - c[j + s].low) / aj; const hu = hiS >= upDist, hd = loS >= downDist; if (hu && hd) res = c[j + s].close >= c[j + s].open ? 1 : -1; else if (hu) res = 1; else if (hd) res = -1 }
      if (res === 1) u++; else if (res === -1) d++; else no++
    }
    const m = v.idx.length, S = 6
    pUp = (u + S / 3) / (m + S); pDn = (d + S / 3) / (m + S); pNo = Math.max(0, 1 - pUp - pDn)
  }
  // ---- ledger ----
  const dayHigh0 = holdStat(c, (i) => B.prevD[i]?.h ?? NaN, 'res', B.atr, 41, n), dayLow0 = holdStat(c, (i) => B.prevD[i]?.l ?? NaN, 'sup', B.atr, 41, n)
  const resL = Number.isFinite(above) ? holdStat(c, () => above, 'res', B.atr, Math.max(41, n - 400), n) : { hold: 0.5, n: 0 }
  const supL = Number.isFinite(below) ? holdStat(c, () => below, 'sup', B.atr, Math.max(41, n - 400), n) : { hold: 0.5, n: 0 }
  const atSup = downDist <= 0.5, atRes = upDist <= 0.5
  // ---- the call ----
  let dir: 'call' | 'put' | 'none' = 'none', prob = 0.5, hProb = 0.5, move = 0, conf = 0
  if (v) {
    prob = v.prob; hProb = v.hProb; move = v.move
    let score = 0.5 * (v.prob - 0.5) * 2 + 0.5 * (v.hProb - 0.5) * 2 + 0.25 * (pUp - pDn)
    // zone tilt, scaled by how reliably THAT level has held before (n >= 5 else ignored)
    if (atRes && resL.n >= 5) score -= 0.15 * (resL.hold - 0.5) * 2
    if (atSup && supL.n >= 5) score += 0.15 * (supL.hold - 0.5) * 2
    dir = Math.abs(score) < 0.1 ? 'none' : score > 0 ? 'call' : 'put'
    const sc = clamp(Math.abs(score), 0, 1)
    conf = Math.round(clamp(sc * 70 + (validated ? 15 : 0) + (v.k >= 20 ? 5 : 0) - (v.near > 1.6 ? 10 : 0), 0, 100))
    if (dir === 'none') conf = Math.min(conf, 30)
  }
  const bias: 'call' | 'put' | 'none' = st === 'bull' && regZ > -1 ? 'call' : st === 'bear' && regZ < 1 ? 'put' : 'none'
  const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(3) : x.toFixed(5))
  const text = !v ? `Map: price ${fmt(px)} (${(rangePos * 100).toFixed(0)}% of today's range). Too few similar moments in history to project.`
    : `Map: ${fmt(px)} sits ${(rangePos * 100).toFixed(0)}% up today's range${p ? `, yesterday ${fmt(p.l)}-${fmt(p.h)} (gap ${gapAtr.toFixed(1)} ATR)` : ''}; ${ses} session ${sessionMove >= 0 ? '+' : ''}${sessionMove.toFixed(1)} ATR${lastSes !== 'none' ? `, last ${lastSes} ${lsMove >= 0 ? '+' : ''}${lsMove.toFixed(1)} ATR ending ${lsEnd >= 0 ? '+' : ''}${lsEnd.toFixed(1)}` : ''}. Causes: ${st} structure, regression ${regZ >= 0 ? '+' : ''}${regZ.toFixed(1)}σ (R² ${r2.toFixed(2)}). Levels: ${Number.isFinite(above) ? `${fmt(above)} above (${upDist.toFixed(1)} ATR, held ${(resL.hold * 100).toFixed(0)}% of ${resL.n})` : 'none above'}, ${Number.isFinite(below) ? `${fmt(below)} below (${downDist.toFixed(1)} ATR, held ${(supL.hold * 100).toFixed(0)}% of ${supL.n})` : 'none below'}. History: ${v.k} similar moments (of ${v.pool}) -> next candle ${(v.prob * 100).toFixed(0)}% up, next ${H} ${(v.hProb * 100).toFixed(0)}% up, moved ${v.move >= 0 ? '+' : ''}${v.move.toFixed(2)} ATR; reaches the level above first ${(pUp * 100).toFixed(0)}% / below first ${(pDn * 100).toFixed(0)}%. Walk-forward ${tn ? `${(trackHit * 100).toFixed(0)}% over ${tn} calls${validated ? ' (validated)' : ''}` : 'not enough calls yet'}.`
  return {
    ok: !!v,
    ...(v ? {} : { error: 'too few similar moments in history' }),
    nm: { dir, sign: dir === 'call' ? 1 : dir === 'put' ? -1 : 0, prob, horizonProb: hProb, moveAtr: move, confidence: conf, validated, price: px },
    validation: { neighbors: v?.k ?? 0, pool: v?.pool ?? 0, nearDist: v?.near ?? NaN, trackN: tn, trackHit, validated },
    reach: { upLevel: above ?? NaN, upDist, downLevel: below ?? NaN, downDist, pUpFirst: pUp, pDownFirst: pDn, pNeither: pNo },
    map: { prevOpen: p?.o ?? NaN, prevHigh: p?.h ?? NaN, prevLow: p?.l ?? NaN, prevClose: p?.c ?? NaN, dayOpen, dayHigh, dayLow, rangePos, gapAtr, session: ses, sessionMoveAtr: sessionMove, lastSession: lastSes, lastSessionMoveAtr: lsMove, lastSessionEndAtr: lsEnd, clock: B.clock },
    causes: { structure: st, regSlope: f.v[5] * 2, regR2: r2, regZ, exhaustion: f.v[8] * 6, lastLegAtr: f.v[7] * 6, atSupport: atSup, atResistance: atRes, bias },
    ledger: { dayHighHold: dayHigh0.hold, dayHighN: dayHigh0.n, dayLowHold: dayLow0.hold, dayLowN: dayLow0.n, supHold: supL.hold, supN: supL.n, resHold: resL.hold, resN: resL.n },
    text,
  }
}

/** nm and pm agree -> stronger; opposite -> no call. Both are optional so either can be the missing half. */
export function combineNmPm(nm: NmResult, pm: { pm: { sign: number; prob: number; confidence: number } } | null): { alignment: 'aligned' | 'conflict' | 'nm-only' | 'pm-only' | 'no-call'; dir: 'call' | 'put' | 'none'; prob: number; strength: number } {
  const ns = nm.ok ? nm.nm.sign : 0, ps = pm ? pm.pm.sign : 0
  const nm_ = (s: number) => (s > 0 ? 'call' : s < 0 ? 'put' : 'none') as 'call' | 'put' | 'none'
  if (ns !== 0 && ps !== 0) {
    if (ns === ps) { const avg = (nm.nm.prob + (pm as { pm: { prob: number } }).pm.prob) / 2; const pr = clamp(0.5 + (avg - 0.5) * 1.15, 0.05, 0.95); return { alignment: 'aligned', dir: nm_(ns), prob: pr, strength: Math.min(100, Math.round((nm.nm.confidence + (pm as { pm: { confidence: number } }).pm.confidence) / 2 + 10)) } }
    return { alignment: 'conflict', dir: 'none', prob: 0.5, strength: 0 }
  }
  if (ns !== 0) return { alignment: 'nm-only', dir: nm_(ns), prob: nm.nm.prob, strength: Math.round(nm.nm.confidence * 0.8) }
  if (ps !== 0 && pm) return { alignment: 'pm-only', dir: nm_(ps), prob: pm.pm.prob, strength: Math.round(pm.pm.confidence * 0.8) }
  return { alignment: 'no-call', dir: 'none', prob: 0.5, strength: 0 }
}
