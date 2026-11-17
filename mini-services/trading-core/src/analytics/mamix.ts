// IQAIR//OS - extra moving averages for MSL's ind.* (analytics/mamix.ts): DEMA, T3, HEMA (EMA of the Heikin-Ashi open), daily-anchored VWAP, and one selector ind.ma(type, len).
// Written to match the TradingView definitions in common use (the "Bj Bot" getMA() function): DEMA = 2*EMA - EMA(EMA); T3 = Tillson with volume factor 0.7 (six EMAs, weights
// -v^3, 3v^2+3v^3, -6v^2-3v-3v^3, 1+3v+v^3+3v^2); HEMA = EMA of the Heikin-Ashi open; VWAP = sum(hlc3*vol)/sum(vol) restarting each UTC day.
import { ema, sma, wma, hma, vwma } from './indicators'

/** EMA over a series that starts with NaN warm-up values (the plain ema() poisons everything after a NaN): run it on the finite suffix and pad the front back */
function emaN(src: number[], len: number): number[] {
  const f = src.findIndex(Number.isFinite)
  if (f < 0) return src.map(() => NaN)
  return [...new Array<number>(f).fill(NaN), ...ema(src.slice(f), len)]
}
export function dema(src: number[], len: number): number[] {
  const e1 = emaN(src, len), e2 = emaN(e1, len)
  return e1.map((x, i) => (Number.isFinite(x) && Number.isFinite(e2[i]) ? 2 * x - e2[i] : NaN))
}
export function t3(src: number[], len: number, v = 0.7): number[] {
  const e = [emaN(src, len)]
  for (let k = 1; k < 6; k++) e.push(emaN(e[k - 1], len))
  const c1 = -v * v * v, c2 = 3 * v * v + 3 * v * v * v, c3 = -6 * v * v - 3 * v - 3 * v * v * v, c4 = 1 + 3 * v + v * v * v + 3 * v * v
  return src.map((_, i) => { const a = e[5][i], b = e[4][i], c = e[3][i], d = e[2][i]; return [a, b, c, d].every(Number.isFinite) ? c1 * a + c2 * b + c3 * c + c4 * d : NaN })
}
/** Heikin-Ashi open series: first = (o+c)/2, then (prevHaOpen + prevHaClose)/2 */
export function haOpenSeries(o: number[], h: number[], l: number[], c: number[]): number[] {
  const out = new Array<number>(o.length).fill(NaN)
  for (let i = 0; i < o.length; i++) out[i] = i === 0 ? (o[0] + c[0]) / 2 : (out[i - 1] + (o[i - 1] + h[i - 1] + l[i - 1] + c[i - 1]) / 4) / 2
  return out
}
export const hema = (o: number[], h: number[], l: number[], c: number[], len: number): number[] => ema(haOpenSeries(o, h, l, c), len)
/** VWAP anchored to the UTC day (TradingView's default). Needs bar times. */
export function vwapDaily(h: number[], l: number[], c: number[], vol: number[], time: number[]): number[] {
  const out = new Array<number>(c.length).fill(NaN)
  let pv = 0, v = 0, day = -1
  for (let i = 0; i < c.length; i++) {
    const d = Math.floor(time[i] / 86400)
    if (d !== day) { day = d; pv = 0; v = 0 }
    const w = vol[i] > 0 ? vol[i] : 1 // feeds without volume: equal weights, so this degrades to a daily average price rather than NaN
    pv += ((h[i] + l[i] + c[i]) / 3) * w; v += w
    out[i] = pv / v
  }
  return out
}
export const MA_TYPES = ['ema', 'hema', 'sma', 'hma', 'wma', 'dema', 'vwma', 'vwap', 't3', 'kama'] as const
export function maSeries(type: string, x: { open: number[]; high: number[]; low: number[]; close: number[]; volume: number[]; time?: number[] }, len: number, v = 0.7): number[] {
  const t = type.toLowerCase()
  switch (t) {
    case 'ema': return ema(x.close, len)
    case 'sma': return sma(x.close, len)
    case 'wma': return wma(x.close, len)
    case 'hma': return hma(x.close, len)
    case 'vwma': return vwma(x.close, x.volume, len)
    case 'dema': return dema(x.close, len)
    case 't3': return t3(x.close, len, v)
    case 'hema': return hema(x.open, x.high, x.low, x.close, len)
    case 'vwap': { if (!x.time) throw new Error('vwap needs bar times, which this evaluation context does not provide'); return vwapDaily(x.high, x.low, x.close, x.volume, x.time) }
    default: throw new Error(`unknown moving-average type "${type}" - use ${MA_TYPES.join('/')}`)
  }
}

// ---- Hull Suite (InSilico / DashTrader): HMA, EHMA, THMA exactly as that script defines them ----
// Pine v4 passes `length / 2` etc. to wma()/ema() as integers (truncated), and HMA/EHMA use round(sqrt(length)) for the smoothing leg (the built-in ta.hma uses floor, this script does not).
// THMA is called with len/2 by the script's Mode() switch, so THMA(src, len/2): wma(wma(src, L/3)*3 - wma(src, L/2) - wma(src, L), L) with L = len/2.
const tr = (x: number): number => Math.max(1, Math.trunc(x))
function wmaN(src: number[], len: number): number[] {
  const f = src.findIndex(Number.isFinite)
  return f < 0 ? src.map(() => NaN) : [...new Array<number>(f).fill(NaN), ...wma(src.slice(f), len)]
}
function emaP(src: number[], len: number): number[] { const f = src.findIndex(Number.isFinite); return f < 0 ? src.map(() => NaN) : [...new Array<number>(f).fill(NaN), ...ema(src.slice(f), len)] }
export type HullMode = 'hma' | 'ehma' | 'thma'
export const HULL_MODES: HullMode[] = ['hma', 'ehma', 'thma']
export function hullSeries(mode: string, src: number[], len: number): number[] {
  const L = Math.max(2, Math.round(len))
  const comb = (a: number[], b: number[], f: (x: number, y: number) => number): number[] => a.map((v, i) => (Number.isFinite(v) && Number.isFinite(b[i]) ? f(v, b[i]) : NaN))
  switch (mode.toLowerCase()) {
    case 'hma': { const raw = comb(wmaN(src, tr(L / 2)), wmaN(src, L), (a, b) => 2 * a - b); return wmaN(raw, tr(Math.round(Math.sqrt(L)))) }
    case 'ehma': { const raw = comb(emaP(src, tr(L / 2)), emaP(src, L), (a, b) => 2 * a - b); return emaP(raw, tr(Math.round(Math.sqrt(L)))) }
    case 'thma': {
      const l = L / 2
      const a = wmaN(src, tr(l / 3)), b = wmaN(src, tr(l / 2)), c = wmaN(src, tr(l))
      const raw = a.map((v, i) => (Number.isFinite(v) && Number.isFinite(b[i]) && Number.isFinite(c[i]) ? v * 3 - b[i] - c[i] : NaN))
      return wmaN(raw, tr(l))
    }
    default: throw new Error(`unknown Hull variation "${mode}" - use ${HULL_MODES.join('/')}`)
  }
}
