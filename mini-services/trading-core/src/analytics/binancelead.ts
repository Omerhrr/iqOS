// IQAIR//OS - Binance vs IQ Option lead/lag (pure maths, no I/O).
//
// Question: for BTCUSD / ETHUSD, which price moves first - Binance's trades or IQ Option's quote - and by how much?
// If Binance leads, then "Binance has moved and IQ has not caught up yet" is a signal for a short IQ trade.
//
// Three pieces:
//   estimateLag     rolling cross-correlation of tick returns on a fine time grid -> who leads, by how many ms, how strongly
//   gapBpsNow       how far Binance is above/below IQ, AFTER removing the usual price difference (USDT vs USD basis, broker markup)
//   analyzeGapEdge  replays recorded ticks: enter on IQ when the gap is big, settle on IQ's own later price, and judge it honestly
//
// Timestamps: both sides use the clock of the machine that recorded them (Binance trades are stamped on arrival, IQ points are stamped by the
// sidecar's 100 ms sampler on the same host), so the lag measured is "how long after Binance showed it did IQ show it", which is exactly the
// quantity a trader on IQ can use. It includes network and sampler delay on both sides; it is not an exchange-to-exchange latency.
import { normInv, wilson } from './binancereplay'

export interface Pt { t: number; p: number }

/** last known price at each grid time t0, t0+step, ... (step-hold); NaN before the first point */
export function gridPrices(pts: Pt[], t0: number, t1: number, stepMs: number): number[] {
  const n = Math.max(0, Math.floor((t1 - t0) / stepMs) + 1)
  const out = new Array<number>(n)
  let j = 0, last = NaN
  for (let i = 0; i < n; i++) {
    const t = t0 + i * stepMs
    while (j < pts.length && pts[j].t <= t) { last = pts[j].p; j++ }
    out[i] = last
  }
  return out
}

function logRet(px: number[]): number[] {
  const r = new Array<number>(px.length).fill(NaN)
  for (let i = 1; i < px.length; i++) if (px[i] > 0 && px[i - 1] > 0) r[i] = Math.log(px[i] / px[i - 1])
  return r
}

function corrAt(a: number[], b: number[], k: number): { c: number; n: number } {
  // pairs (a[i], b[i+k])
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0
  const lo = Math.max(0, -k), hi = Math.min(a.length, b.length - k)
  for (let i = lo; i < hi; i++) {
    const x = a[i], y = b[i + k]
    if (!(x === x) || !(y === y)) continue
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y
  }
  if (n < 5) return { c: 0, n }
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n
  if (va <= 0 || vb <= 0) return { c: 0, n }
  return { c: (sab - (sa * sb) / n) / Math.sqrt(va * vb), n }
}

export interface LagResult {
  ok: boolean
  /** > 0: IQ follows Binance by this many ms (Binance leads); < 0: IQ leads */
  lagMs: number
  corr: number
  corrAtZero: number
  n: number
  leader: 'binance' | 'iq' | 'none'
  curve: { lagMs: number; corr: number }[]
  note: string
}
export interface LagOpts { stepMs?: number; maxLagMs?: number; minN?: number; minCorr?: number; minZ?: number }

export function estimateLag(bin: Pt[], iq: Pt[], t0: number, t1: number, o: LagOpts = {}): LagResult {
  const step = o.stepMs ?? 200, maxLag = o.maxLagMs ?? 5000, minN = o.minN ?? 300, minCorr = o.minCorr ?? 0.08, minZ = o.minZ ?? 4
  const empty = (note: string): LagResult => ({ ok: false, lagMs: 0, corr: 0, corrAtZero: 0, n: 0, leader: 'none', curve: [], note })
  if (bin.length < 20 || iq.length < 20) return empty('not enough ticks on one of the two sides yet')
  const rb = logRet(gridPrices(bin, t0, t1, step)), ri = logRet(gridPrices(iq, t0, t1, step))
  const K = Math.max(1, Math.round(maxLag / step))
  const curve: { lagMs: number; corr: number }[] = []
  let best = { k: 0, c: -2, n: 0 }, c0 = 0
  for (let k = -K; k <= K; k++) {
    const { c, n } = corrAt(rb, ri, k)
    curve.push({ lagMs: k * step, corr: c })
    if (k === 0) c0 = c
    if (c > best.c) best = { k, c, n }
  }
  if (best.n < minN) return { ...empty(`only ${best.n} usable ${step} ms steps (need ${minN})`), n: best.n, curve }
  // sub-step peak by a parabola through the neighbours
  let lagMs = best.k * step
  const kk = best.k + K
  if (kk > 0 && kk < curve.length - 1) {
    const y0 = curve[kk - 1].corr, y1 = curve[kk].corr, y2 = curve[kk + 1].corr
    const den = y0 - 2 * y1 + y2
    if (den < 0) lagMs += ((y0 - y2) / (2 * den)) * step
  }
  const z = best.c * Math.sqrt(best.n)
  const sig = best.c >= minCorr && z >= minZ
  let leader: LagResult['leader'] = 'none', note: string
  if (!sig) note = `no clear co-movement (peak correlation ${best.c.toFixed(3)}, needs >= ${minCorr} and z >= ${minZ})`
  else if (Math.abs(lagMs) < step) { note = `the two move together within ${step} ms: neither leads at this resolution` }
  else if (lagMs > 0) { leader = 'binance'; note = `IQ follows Binance by about ${Math.round(lagMs)} ms` }
  else { leader = 'iq'; note = `Binance follows IQ by about ${Math.round(-lagMs)} ms` }
  return { ok: true, lagMs, corr: best.c, corrAtZero: c0, n: best.n, leader, curve, note }
}

const median = (a: number[]): number => {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Binance above (+) or below (-) IQ in basis points, relative to the usual ratio. ratios = recent bin/iq samples (the usual level is their median). */
export function gapBpsNow(binPrice: number, iqPrice: number, ratios: number[], minSamples = 30): number | null {
  if (!(binPrice > 0) || !(iqPrice > 0) || ratios.length < minSamples) return null
  const basis = median(ratios)
  if (!(basis > 0)) return null
  return (binPrice / iqPrice / basis - 1) * 1e4
}

function lastAt(pts: Pt[], t: number, from: { i: number }): Pt | undefined {
  while (from.i + 1 < pts.length && pts[from.i + 1].t <= t) from.i++
  return pts[from.i] && pts[from.i].t <= t ? pts[from.i] : undefined
}
function bsearch(pts: Pt[], t: number): Pt | undefined {
  let lo = 0, hi = pts.length - 1, ans = -1
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m].t <= t) { ans = m; lo = m + 1 } else hi = m - 1 }
  return ans >= 0 ? pts[ans] : undefined
}

export interface EdgeRow {
  thresholdBps: number
  horizonSec: number
  trades: number
  wins: number
  winRate: number | null
  breakeven: number
  expectancy: number | null
  /** average move of IQ in the signal's direction over the horizon, in bps (what the gap actually bought, before any payout rule) */
  avgMoveBps: number | null
  ci: { lo: number; hi: number } | null
  oos: { trades: number; winRate: number | null; expectancy: number | null } | null
  verdict: 'no-trades' | 'too-few' | 'negative' | 'inconclusive' | 'candidate'
  note: string
}
export interface EdgeOpts {
  thresholdsBps?: number[]
  horizonsSec?: number[]
  /** how long after the signal your order actually fills on IQ (ms) - the main reason a lag edge dies in practice */
  delayMs?: number
  payout?: number
  basisWindowSec?: number
  maxStaleSec?: number
}

export function analyzeGapEdge(bin: Pt[], iq: Pt[], o: EdgeOpts = {}): { rows: EdgeRow[]; samples: number; spanSec: number; breakeven: number; note: string } {
  const thr = o.thresholdsBps?.length ? o.thresholdsBps : [1, 2, 3, 5, 8]
  const hor = o.horizonsSec?.length ? o.horizonsSec : [5, 15, 30, 60]
  const delay = o.delayMs ?? 1000, payout = o.payout ?? 0.85, basisSec = o.basisWindowSec ?? 300, stale = (o.maxStaleSec ?? 5) * 1000
  const breakeven = 1 / (1 + payout)
  const base = { samples: 0, spanSec: 0, breakeven }
  if (bin.length < 100 || iq.length < 100) return { rows: [], ...base, note: 'not enough recorded ticks: keep the recorder on' }
  const tStart = Math.max(bin[0].t, iq[0].t) + basisSec * 1000, tEnd = Math.min(bin[bin.length - 1].t, iq[iq.length - 1].t) - (Math.max(...hor) * 1000 + delay + 2000)
  if (tEnd <= tStart) return { rows: [], ...base, note: 'the two recordings overlap for too short a time' }
  // 1 s samples of the ratio and the gap
  type S = { t: number; gap: number }
  const samples: S[] = []
  const ratios: number[] = []
  const ib = { i: 0 }, ii = { i: 0 }
  let basis = NaN
  for (let t = bin[0].t > iq[0].t ? bin[0].t : iq[0].t, k = 0; t <= tEnd; t += 1000, k++) {
    const b = lastAt(bin, t, ib), q = lastAt(iq, t, ii)
    if (!b || !q || t - b.t > stale * 4 || t - q.t > stale * 4) continue
    const r = b.p / q.p
    if (t >= tStart) {
      if (k % 5 === 0 || !(basis === basis)) basis = median(ratios.slice(-basisSec))
      if (basis > 0 && t - b.t <= stale && t - q.t <= stale) samples.push({ t, gap: (r / basis - 1) * 1e4 })
    }
    ratios.push(r)
    if (ratios.length > basisSec * 3) ratios.splice(0, ratios.length - basisSec * 2)
  }
  const cut = samples.length ? samples[0].t + (samples[samples.length - 1].t - samples[0].t) * 0.7 : 0
  const tried = thr.length * hor.length
  const z = normInv(1 - 0.05 / Math.max(1, tried))
  const rows: EdgeRow[] = []
  for (const th of thr) for (const h of hor) {
    let n = 0, w = 0, on = 0, ow = 0, mv = 0, nextOk = 0
    for (const s of samples) {
      if (s.t < nextOk || Math.abs(s.gap) < th) continue
      const e = bsearch(iq, s.t + delay), x = bsearch(iq, s.t + delay + h * 1000)
      if (!e || !x || s.t + delay - e.t > stale || s.t + delay + h * 1000 - x.t > stale) continue
      nextOk = s.t + h * 1000   // one trade at a time per horizon
      if (x.p === e.p) continue // a tie is not a win for either side
      const up = s.gap > 0, win = up ? x.p > e.p : x.p < e.p
      n++; if (win) w++
      mv += ((x.p - e.p) / e.p) * 1e4 * (up ? 1 : -1)
      if (s.t >= cut) { on++; if (win) ow++ }
    }
    const ev = (a: number, m: number) => (m ? (a / m) * payout - (1 - a / m) : null)
    const ci = n ? wilson(w, n) : null
    const oos = on ? { trades: on, winRate: ow / on, expectancy: ev(ow, on) } : null
    const adjLo = n ? wilson(w, n, z).lo : 0
    let verdict: EdgeRow['verdict'], note: string
    if (!n) { verdict = 'no-trades'; note = 'the gap never reached this size with usable IQ prices around it' }
    else if (n < 30) { verdict = 'too-few'; note = `only ${n} trades: nothing can be concluded` }
    else if (adjLo > breakeven && n >= 100 && oos && (oos.expectancy ?? -1) > 0) { verdict = 'candidate'; note = `beats breakeven even after allowing for ${tried} settings tried, and the last 30% of the time agrees - confirm on fresh days and with your real order delay` }
    else if ((ev(w, n) ?? 0) > 0) { verdict = 'inconclusive'; note = `positive here but inside what luck produces (95% interval ${(ci!.lo * 100).toFixed(1)}-${(ci!.hi * 100).toFixed(1)}%, breakeven ${(breakeven * 100).toFixed(1)}%, ${tried} settings tried)` }
    else { verdict = 'negative'; note = `below breakeven (${(breakeven * 100).toFixed(1)}%)` }
    rows.push({ thresholdBps: th, horizonSec: h, trades: n, wins: w, winRate: n ? w / n : null, breakeven, expectancy: ev(w, n), avgMoveBps: n ? mv / n : null, ci, oos, verdict, note })
  }
  return { rows, samples: samples.length, spanSec: samples.length ? Math.round((samples[samples.length - 1].t - samples[0].t) / 1000) : 0, breakeven, note: `IQ fills ${delay} ms after the signal and settles on IQ's own later price; ${tried} settings tried, so the bar for "candidate" is raised accordingly` }
}
