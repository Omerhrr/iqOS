// IQAIR//OS - PMax (Profit Maximizer, KivancOzbilgic): a SuperTrend-style trailing line built on a MOVING AVERAGE instead of the price, with ATR-distance bands.
// Ported from the TradingView script "PMax Explorer" faithfully, including its quirks (WWMA/VAR start from zero like Pine's nz(), VAR's CMO window is a fixed 9 bars).
//   MAvg = movingAverage(src, len);  longStop = MAvg - mult*ATR (ratchets UP while MAvg stays above it);  shortStop = MAvg + mult*ATR (ratchets DOWN while MAvg stays below it)
//   dir flips to +1 when MAvg closes above the previous shortStop, to -1 when below the previous longStop;  PMax = dir==1 ? longStop : shortStop
//   BUY  = MAvg crosses above PMax, SELL = MAvg crosses below it.   The screener half of the script uses a slightly different recursion (TrendUp/TrendDown) - exposed as trend/tsl.
import { ema, sma, wma, atr as atrWilder, trueRange } from './indicators'

export type PmaxMa = 'sma' | 'ema' | 'wma' | 'tma' | 'var' | 'wwma' | 'zlema' | 'tsf'
export const PMAX_MAS: PmaxMa[] = ['sma', 'ema', 'wma', 'tma', 'var', 'wwma', 'zlema', 'tsf']
export type PmaxSrc = 'hl2' | 'hlc3' | 'ohlc4' | 'close' | 'open' | 'high' | 'low'
export interface Ohlc { open: number[]; high: number[]; low: number[]; close: number[] }
export function pmaxSource(name: string, x: Ohlc): number[] {
  const n = x.close.length, f = (g: (i: number) => number): number[] => Array.from({ length: n }, (_, i) => g(i))
  switch (name.toLowerCase()) {
    case 'hl2': return f((i) => (x.high[i] + x.low[i]) / 2)
    case 'hlc3': return f((i) => (x.high[i] + x.low[i] + x.close[i]) / 3)
    case 'ohlc4': return f((i) => (x.open[i] + x.high[i] + x.low[i] + x.close[i]) / 4)
    case 'close': return x.close
    case 'open': return x.open
    case 'high': return x.high
    case 'low': return x.low
    default: throw new Error(`unknown source "${name}" - use hl2/hlc3/ohlc4/close/open/high/low`)
  }
}
/** EMA that tolerates a NaN warm-up prefix (plain ema() poisons everything after a NaN) */
function emaN(src: number[], len: number): number[] {
  const f = src.findIndex(Number.isFinite)
  return f < 0 ? src.map(() => NaN) : [...new Array<number>(f).fill(NaN), ...ema(src.slice(f), len)]
}
/** sma that tolerates a NaN warm-up prefix: run on the finite suffix, pad the front back */
function smaN(src: number[], len: number): number[] {
  const f = src.findIndex(Number.isFinite)
  return f < 0 ? src.map(() => NaN) : [...new Array<number>(f).fill(NaN), ...sma(src.slice(f), len)]
}
const nz = (v: number): number => (Number.isFinite(v) ? v : 0)
export function pmaxMa(type: string, src: number[], len: number): number[] {
  const n = src.length, out = new Array<number>(n).fill(NaN)
  switch (type.toLowerCase()) {
    case 'sma': return sma(src, len)
    case 'ema': return ema(src, len)
    case 'wma': return wma(src, len)
    case 'tma': return smaN(sma(src, Math.ceil(len / 2)), Math.floor(len / 2) + 1)
    case 'var': {
      const a = 2 / (len + 1)
      let prev = 0
      for (let i = 0; i < n; i++) {
        let ud = 0, dd = 0
        for (let k = Math.max(1, i - 8); k <= i; k++) { const d = src[k] - src[k - 1]; if (d > 0) ud += d; else if (d < 0) dd -= d }
        const cmo = ud + dd === 0 ? 0 : (ud - dd) / (ud + dd), w = a * Math.abs(cmo)
        prev = w * src[i] + (1 - w) * prev; out[i] = prev
      }
      return out
    }
    case 'wwma': {
      const a = 1 / len
      let prev = 0
      for (let i = 0; i < n; i++) { prev = a * src[i] + (1 - a) * prev; out[i] = prev }
      return out
    }
    case 'zlema': {
      const lag = len / 2 === Math.round(len / 2) ? len / 2 : (len - 1) / 2
      const data = src.map((v, i) => (i >= lag ? v + (v - src[i - lag]) : NaN))
      return emaN(data, len)
    }
    case 'tsf': {
      // linear regression over the last `len` bars, projected one bar ahead (Pine: linreg(len,0) + (linreg(len,0) - linreg(len,1)))
      for (let i = len - 1; i < n; i++) {
        let sx = 0, sy = 0, sxy = 0, sxx = 0
        for (let k = 0; k < len; k++) { const y = src[i - len + 1 + k]; sx += k; sy += y; sxy += k * y; sxx += k * k }
        const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx), icpt = (sy - slope * sx) / len
        out[i] = icpt + slope * len
      }
      return out
    }
    default: throw new Error(`unknown PMax moving average "${type}" - use ${PMAX_MAS.join('/')}`)
  }
}
export interface PmaxResult { ma: number[]; line: number[]; dir: number[]; atr: number[]; trend: number[]; tsl: number[] }
export function pmax(x: Ohlc, o: { ma?: string; maLen?: number; atrLen?: number; mult?: number; src?: string; wilderAtr?: boolean } = {}): PmaxResult {
  const len = Math.max(1, Math.round(o.maLen ?? 10)), alen = Math.max(1, Math.round(o.atrLen ?? 10)), mult = o.mult ?? 3
  const n = x.close.length
  const src = pmaxSource(o.src ?? 'hl2', x)
  const ma = pmaxMa(o.ma ?? 'ema', src, len)
  const atr = o.wilderAtr === false ? sma(trueRange(x.high, x.low, x.close), alen) : atrWilder(x.high, x.low, x.close, alen)
  const line = new Array<number>(n).fill(NaN), dirArr = new Array<number>(n).fill(NaN)
  const trend = new Array<number>(n).fill(NaN), tsl = new Array<number>(n).fill(NaN)
  let longStop = NaN, shortStop = NaN, dir = 1
  let tUp = 0, tDn = 0, tr = 1
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(ma[i]) || !Number.isFinite(atr[i])) continue
    // strategy recursion (Pmax_Func)
    const lsPrev = Number.isFinite(longStop) ? longStop : ma[i] - mult * atr[i]
    const ssPrev = Number.isFinite(shortStop) ? shortStop : ma[i] + mult * atr[i]
    let ls = ma[i] - mult * atr[i], ss = ma[i] + mult * atr[i]
    ls = ma[i] > lsPrev ? Math.max(ls, lsPrev) : ls
    ss = ma[i] < ssPrev ? Math.min(ss, ssPrev) : ss
    dir = dir === -1 && ma[i] > ssPrev ? 1 : dir === 1 && ma[i] < lsPrev ? -1 : dir
    longStop = ls; shortStop = ss
    line[i] = dir === 1 ? ls : ss; dirArr[i] = dir
    // screener recursion (Pmax)
    const up = ma[i] - mult * atr[i], dn = ma[i] + mult * atr[i]
    const prevMa = i > 0 ? ma[i - 1] : NaN
    const nUp = prevMa > nz(tUp) ? Math.max(up, tUp) : up
    const nDn = prevMa < nz(tDn) ? Math.min(dn, tDn) : dn
    const oldUp = tUp, oldDn = tDn
    tUp = nUp; tDn = nDn
    tr = ma[i] > oldDn ? 1 : ma[i] < oldUp ? -1 : tr
    trend[i] = tr; tsl[i] = tr === 1 ? tUp : tDn
  }
  return { ma, line, dir: dirArr, atr, trend, tsl }
}
