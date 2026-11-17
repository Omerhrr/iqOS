// IQAIR//OS - market understanding + self-adapting rule choice (MSL `mkt.*` and `adapt.*`).
//
// mkt.*   UNDERSTAND the market: classifies the latest closed bar's surroundings as trend_up / trend_down / revert / chop
//         from three measured facts (efficiency ratio, Lo-MacKinlay variance ratio, lag-1 autocorrelation) plus a
//         volatility state (ATR14 against its own 100-bar median). Pure candle maths, causal, backtestable.
// adapt.* ADAPT to it: three candidate rules (follow the last candle, fade it, follow the EMA20 side) are scored on this
//         pair's own earlier bars that sat in the SAME regime, recent bars weighted more (half-life 300 bars). The rule with
//         the best shrunk hit-rate becomes the mode, and the side is what that rule says for the latest bar. Walk-forward:
//         only bars whose next candle already closed are scored, the latest bar's own outcome is never used.
// It is a SELECTOR over measured past frequencies, not a forecast and not a learner of new patterns. Honest limits: regime
// labels are noisy, in-sample selection among 3 rules can pick luck, a probability on small n means little (gate on n).
import type { Candle } from '../types'
import { atr, ema } from './indicators'

export const MARKETMIND_MIN_BARS = 150
const ER_N = 20
const VR_N = 100
const VR_Q = 4
const AC_N = 100
const HALF_LIFE = 300
const WINDOW = 1500

export type Regime = 'trend_up' | 'trend_down' | 'revert' | 'chop'
export type Mode = 'follow' | 'fade' | 'trend' | 'none'

export interface MarketRead {
  ok: boolean
  regime: Regime
  trend: number // +1 / -1 / 0
  strength: number // efficiency ratio 0..1
  vr: number
  ac: number
  vol: 'low' | 'normal' | 'high'
  volRatio: number
  confidence: number // 0..1 how many of the 3 facts agree with the label
}
export interface AdaptRead extends MarketRead {
  mode: Mode
  side: 'call' | 'put' | 'none'
  p: number // shrunk weighted hit-rate of the chosen mode in this regime
  low: number // Wilson 95% lower bound on the unweighted hit count
  n: number // earlier same-regime bars scored for the chosen mode
  pFollow: number
  pFade: number
  pTrend: number
}

const EMPTY: MarketRead = { ok: false, regime: 'chop', trend: 0, strength: 0, vr: 1, ac: 0, vol: 'normal', volRatio: 1, confidence: 0 }

function wilsonLow(w: number, n: number): number {
  if (n <= 0) return 0
  const z = 1.96, p = w / n, d = 1 + (z * z) / n
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d)
}

interface Feat { regime: Regime[]; er: number[]; vr: number[]; ac: number[]; volRatio: number[]; conf: number[]; valid: boolean[] }

function features(c: Candle[]): Feat {
  const n = c.length
  const close = c.map((x) => x.close), high = c.map((x) => x.high), low = c.map((x) => x.low)
  const a = atr(high, low, close, 14)
  const lr: number[] = new Array(n).fill(0)
  for (let i = 1; i < n; i++) lr[i] = close[i - 1] > 0 && close[i] > 0 ? Math.log(close[i] / close[i - 1]) : 0
  // prefix sums for fast rolling variance of 1-bar and q-bar returns
  const regime: Regime[] = new Array(n).fill('chop')
  const er = new Array(n).fill(NaN), vr = new Array(n).fill(NaN), ac = new Array(n).fill(NaN), vRatio = new Array(n).fill(1), conf = new Array(n).fill(0)
  const valid: boolean[] = new Array(n).fill(false)
  const start = Math.max(VR_N + VR_Q + 1, 120)
  for (let i = start; i < n; i++) {
    // efficiency ratio
    let path = 0
    for (let k = i - ER_N + 1; k <= i; k++) path += Math.abs(close[k] - close[k - 1])
    er[i] = path > 0 ? Math.abs(close[i] - close[i - ER_N]) / path : 0
    // variance ratio of q-bar vs 1-bar returns over the last VR_N bars
    let s1 = 0, sq = 0
    for (let k = i - VR_N + 1; k <= i; k++) s1 += lr[k] * lr[k]
    let cnt = 0
    for (let k = i - VR_N + VR_Q; k <= i; k++) {
      const r = lr[k] + lr[k - 1] + lr[k - 2] + lr[k - 3]
      sq += r * r
      cnt++
    }
    const v1 = s1 / VR_N, vq = sq / cnt
    vr[i] = v1 > 0 ? vq / (VR_Q * v1) : 1
    // lag-1 autocorrelation
    let num = 0, den = 0
    for (let k = i - AC_N + 2; k <= i; k++) num += lr[k] * lr[k - 1]
    for (let k = i - AC_N + 1; k <= i; k++) den += lr[k] * lr[k]
    ac[i] = den > 0 ? num / den : 0
    // volatility state
    const win: number[] = []
    for (let k = i - 99; k <= i; k++) if (Number.isFinite(a[k])) win.push(a[k])
    win.sort((x, y) => x - y)
    const med = win.length ? win[win.length >> 1] : 0
    vRatio[i] = med > 0 && Number.isFinite(a[i]) ? a[i] / med : 1
    const dir = Math.sign(close[i] - close[i - ER_N])
    const trendFacts = (er[i] >= 0.35 ? 1 : 0) + (vr[i] > 1.1 ? 1 : 0) + (ac[i] > 0.05 ? 1 : 0)
    const revFacts = (er[i] < 0.25 ? 1 : 0) + (vr[i] < 0.9 ? 1 : 0) + (ac[i] < -0.05 ? 1 : 0)
    if (trendFacts >= 2 && dir !== 0) { regime[i] = dir > 0 ? 'trend_up' : 'trend_down'; conf[i] = trendFacts / 3 }
    else if (revFacts >= 2) { regime[i] = 'revert'; conf[i] = revFacts / 3 }
    else { regime[i] = 'chop'; conf[i] = 1 - Math.max(trendFacts, revFacts) / 3 }
    valid[i] = Number.isFinite(vr[i]) && Number.isFinite(a[i])
  }
  return { regime, er, vr, ac, volRatio: vRatio, conf, valid }
}

function mk(f: Feat, i: number): MarketRead {
  const r = f.regime[i]
  const vr = f.volRatio[i]
  return {
    ok: true, regime: r, trend: r === 'trend_up' ? 1 : r === 'trend_down' ? -1 : 0, strength: f.er[i], vr: f.vr[i], ac: f.ac[i],
    vol: vr > 1.5 ? 'high' : vr < 0.7 ? 'low' : 'normal', volRatio: vr, confidence: f.conf[i],
  }
}

export function readMarket(candles: Candle[]): MarketRead {
  if (candles.length < MARKETMIND_MIN_BARS) return { ...EMPTY }
  candles = candles.slice(-(WINDOW + 200))
  const f = features(candles)
  const i = candles.length - 1
  return f.valid[i] ? mk(f, i) : { ...EMPTY }
}

export function readAdapt(candles: Candle[]): AdaptRead {
  const base: AdaptRead = { ...EMPTY, mode: 'none', side: 'none', p: 0.5, low: 0, n: 0, pFollow: 0.5, pFade: 0.5, pTrend: 0.5 }
  const n = candles.length
  if (n < MARKETMIND_MIN_BARS) return base
  candles = candles.slice(-(WINDOW + 200))
  const f = features(candles)
  const last = candles.length - 1
  if (!f.valid[last]) return base
  const close = candles.map((x) => x.close), open = candles.map((x) => x.open)
  const e = ema(close, 20)
  // prediction of each rule at bar i: +1 next close up, -1 down, 0 no opinion
  const pred = (m: 'follow' | 'fade' | 'trend', i: number): number => {
    if (m === 'trend') return Number.isFinite(e[i]) ? Math.sign(close[i] - e[i]) : 0
    const d = Math.sign(close[i] - open[i])
    return m === 'follow' ? d : -d
  }
  const modes: ('follow' | 'fade' | 'trend')[] = ['follow', 'fade', 'trend']
  const w: Record<string, number> = { follow: 0, fade: 0, trend: 0 }
  const tot: Record<string, number> = { follow: 0, fade: 0, trend: 0 }
  const cw: Record<string, number> = { follow: 0, fade: 0, trend: 0 }
  const cn: Record<string, number> = { follow: 0, fade: 0, trend: 0 }
  const lo = Math.max(0, last - WINDOW)
  for (let i = lo; i < last; i++) {
    if (!f.valid[i] || f.regime[i] !== f.regime[last]) continue
    const mv = close[i + 1] - close[i]
    if (mv === 0) continue
    const wt = Math.pow(0.5, (last - i) / HALF_LIFE)
    for (const m of modes) {
      const p = pred(m, i)
      if (p === 0) continue
      const win = p * mv > 0 ? 1 : 0
      w[m] += wt * win
      tot[m] += wt
      cw[m] += win
      cn[m] += 1
    }
  }
  const P = (m: string) => (w[m] + 1) / (tot[m] + 2)
  let best: 'follow' | 'fade' | 'trend' = 'follow'
  for (const m of modes) if (P(m) > P(best)) best = m
  const dir = pred(best, last)
  const out: AdaptRead = { ...mk(f, last), mode: 'none', side: 'none', p: P(best), low: wilsonLow(cw[best], cn[best]), n: cn[best], pFollow: P('follow'), pFade: P('fade'), pTrend: P('trend') }
  if (P(best) > 0.5 && dir !== 0) {
    out.mode = best
    out.side = dir > 0 ? 'call' : 'put'
  }
  return out
}

/** causal per-bar regime labels ('' where not yet computable) - one features() pass, for discover.ts */
export function regimeSeries(candles: Candle[]): string[] {
  if (candles.length < MARKETMIND_MIN_BARS) return candles.map(() => '')
  const f = features(candles)
  return candles.map((_, i) => (f.valid[i] ? f.regime[i] : ''))
}
