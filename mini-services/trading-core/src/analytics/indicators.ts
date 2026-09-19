// IQAIR//OS - Technical indicator library
// Pure functions over candle arrays. NaN marks warmup gaps.
import type { Candle } from '../types'

export const isn = (x: number) => Number.isFinite(x)

export function closes(c: Candle[]): number[] {
  return c.map((k) => k.close)
}
export function highs(c: Candle[]): number[] {
  return c.map((k) => k.high)
}
export function lows(c: Candle[]): number[] {
  return c.map((k) => k.low)
}

// ---------- Moving averages ----------

export function sma(src: number[], period: number): number[] {
  const out = new Array<number>(src.length).fill(NaN)
  let sum = 0
  for (let i = 0; i < src.length; i++) {
    sum += src[i]
    if (i >= period) sum -= src[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export function ema(src: number[], period: number): number[] {
  const out = new Array<number>(src.length).fill(NaN)
  const k = 2 / (period + 1)
  let seed = 0
  for (let i = 0; i < src.length; i++) {
    if (i < period - 1) {
      seed += src[i]
      continue
    }
    if (i === period - 1) {
      seed += src[i]
      out[i] = seed / period
    } else {
      out[i] = src[i] * k + out[i - 1] * (1 - k)
    }
  }
  return out
}

export function wma(src: number[], period: number): number[] {
  const out = new Array<number>(src.length).fill(NaN)
  const denom = (period * (period + 1)) / 2
  for (let i = period - 1; i < src.length; i++) {
    let acc = 0
    for (let j = 0; j < period; j++) acc += src[i - j] * (period - j)
    out[i] = acc / denom
  }
  return out
}

// ---------- Oscillators ----------

export function rsi(src: number[], period = 14): number[] {
  const out = new Array<number>(src.length).fill(NaN)
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i < src.length; i++) {
    const diff = src[i] - src[i - 1]
    const gain = Math.max(diff, 0)
    const loss = Math.max(-diff, 0)
    if (i <= period) {
      avgGain += gain / period
      avgLoss += loss / period
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    }
  }
  return out
}

export function macd(
  src: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): { macd: number[]; signal: number[]; hist: number[] } {
  const f = ema(src, fast)
  const s = ema(src, slow)
  const line = src.map((_, i) => (isn(f[i]) && isn(s[i]) ? f[i] - s[i] : NaN))
  const firstValid = line.findIndex(isn)
  const valid = firstValid >= 0 ? line.slice(firstValid).filter(isn) : []
  const sig = ema(valid, signalPeriod)
  const signal = new Array<number>(src.length).fill(NaN)
  for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i]
  const hist = line.map((v, i) => (isn(v) && isn(signal[i]) ? v - signal[i] : NaN))
  return { macd: line, signal, hist }
}

export function stochastic(
  high: number[],
  low: number[],
  close: number[],
  kPeriod = 14,
  dPeriod = 3,
  smooth = 3
): { k: number[]; d: number[] } {
  const raw = new Array<number>(close.length).fill(NaN)
  for (let i = kPeriod - 1; i < close.length; i++) {
    let hh = -Infinity
    let ll = Infinity
    for (let j = 0; j < kPeriod; j++) {
      hh = Math.max(hh, high[i - j])
      ll = Math.min(ll, low[i - j])
    }
    raw[i] = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100
  }
  const k = sma(raw.map((v) => (isn(v) ? v : 0)), smooth).map((v, i) => (isn(raw[i]) ? v : NaN))
  const firstValid = k.findIndex(isn)
  const d = new Array<number>(close.length).fill(NaN)
  if (firstValid >= 0) {
    const kValid = k.slice(firstValid).filter(isn)
    const dVals = sma(kValid, dPeriod)
    for (let i = 0; i < dVals.length; i++) d[firstValid + i] = dVals[i]
  }
  return { k, d }
}

export function williamsR(high: number[], low: number[], close: number[], period = 14): number[] {
  const out = new Array<number>(close.length).fill(NaN)
  for (let i = period - 1; i < close.length; i++) {
    let hh = -Infinity
    let ll = Infinity
    for (let j = 0; j < period; j++) {
      hh = Math.max(hh, high[i - j])
      ll = Math.min(ll, low[i - j])
    }
    out[i] = hh === ll ? -50 : ((hh - close[i]) / (hh - ll)) * -100
  }
  return out
}

export function cci(high: number[], low: number[], close: number[], period = 20): number[] {
  const tp = close.map((c, i) => (high[i] + low[i] + c) / 3)
  const ma = sma(tp, period)
  const out = new Array<number>(close.length).fill(NaN)
  for (let i = period - 1; i < close.length; i++) {
    let dev = 0
    for (let j = 0; j < period; j++) dev += Math.abs(tp[i - j] - ma[i])
    dev /= period
    out[i] = dev === 0 ? 0 : (tp[i] - ma[i]) / (0.015 * dev)
  }
  return out
}

export function roc(src: number[], period = 12): number[] {
  const out = new Array<number>(src.length).fill(NaN)
  for (let i = period; i < src.length; i++) {
    out[i] = src[i - period] === 0 ? NaN : ((src[i] - src[i - period]) / src[i - period]) * 100
  }
  return out
}

// ---------- Volatility / trend strength ----------

export function trueRange(high: number[], low: number[], close: number[]): number[] {
  const out = new Array<number>(close.length).fill(NaN)
  out[0] = high[0] - low[0]
  for (let i = 1; i < close.length; i++) {
    out[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]))
  }
  return out
}

export function atr(high: number[], low: number[], close: number[], period = 14): number[] {
  const tr = trueRange(high, low, close)
  const out = new Array<number>(close.length).fill(NaN)
  let acc = 0
  for (let i = 0; i < close.length; i++) {
    if (i < period) {
      acc += tr[i]
      if (i === period - 1) out[i] = acc / period
    } else {
      out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    }
  }
  return out
}

export function adx(
  high: number[],
  low: number[],
  close: number[],
  period = 14
): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const n = close.length
  const plusDM = new Array<number>(n).fill(0)
  const minusDM = new Array<number>(n).fill(0)
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1]
    const down = low[i - 1] - low[i]
    plusDM[i] = up > down && up > 0 ? up : 0
    minusDM[i] = down > up && down > 0 ? down : 0
  }
  const tr = trueRange(high, low, close)
  const adxOut = new Array<number>(n).fill(NaN)
  const plusOut = new Array<number>(n).fill(NaN)
  const minusOut = new Array<number>(n).fill(NaN)
  let strP = 0
  let strM = 0
  let strTR = 0
  let dxSum = 0
  let dxCount = 0
  for (let i = 1; i < n; i++) {
    if (i <= period) {
      strP += plusDM[i]
      strM += minusDM[i]
      strTR += tr[i]
      if (i < period) continue
    } else {
      strP = strP - strP / period + plusDM[i]
      strM = strM - strM / period + minusDM[i]
      strTR = strTR - strTR / period + tr[i]
    }
    const pdi = strTR === 0 ? 0 : (strP / strTR) * 100
    const mdi = strTR === 0 ? 0 : (strM / strTR) * 100
    plusOut[i] = pdi
    minusOut[i] = mdi
    const dx = pdi + mdi === 0 ? 0 : (Math.abs(pdi - mdi) / (pdi + mdi)) * 100
    if (dxCount < period) {
      dxSum += dx
      dxCount++
      if (dxCount === period) adxOut[i] = dxSum / period
    } else {
      adxOut[i] = (adxOut[i - 1] * (period - 1) + dx) / period
    }
  }
  return { adx: adxOut, plusDI: plusOut, minusDI: minusOut }
}

// ---------- Bands / channels ----------

export function stdDev(src: number[], period: number): number[] {
  const mean = sma(src, period)
  const out = new Array<number>(src.length).fill(NaN)
  for (let i = period - 1; i < src.length; i++) {
    let acc = 0
    for (let j = 0; j < period; j++) {
      const d = src[i - j] - mean[i]
      acc += d * d
    }
    out[i] = Math.sqrt(acc / period)
  }
  return out
}

export function bollinger(
  src: number[],
  period = 20,
  mult = 2
): { upper: number[]; mid: number[]; lower: number[]; width: number[]; percentB: number[] } {
  const mid = sma(src, period)
  const sd = stdDev(src, period)
  const upper = mid.map((m, i) => m + mult * sd[i])
  const lower = mid.map((m, i) => m - mult * sd[i])
  const width = mid.map((m, i) => ((upper[i] - lower[i]) / m) * 100)
  const percentB = src.map((v, i) => {
    const range = upper[i] - lower[i]
    return range === 0 ? 0.5 : (v - lower[i]) / range
  })
  return { upper, mid, lower, width, percentB }
}

export function keltner(
  high: number[],
  low: number[],
  close: number[],
  period = 20,
  mult = 2
): { upper: number[]; mid: number[]; lower: number[] } {
  const mid = ema(close, period)
  const a = atr(high, low, close, period)
  return {
    upper: mid.map((m, i) => m + mult * a[i]),
    mid,
    lower: mid.map((m, i) => m - mult * a[i]),
  }
}

export function donchian(high: number[], low: number[], period = 20): { upper: number[]; lower: number[]; mid: number[] } {
  const upper = new Array<number>(high.length).fill(NaN)
  const lower = new Array<number>(high.length).fill(NaN)
  for (let i = period - 1; i < high.length; i++) {
    let hh = -Infinity
    let ll = Infinity
    for (let j = 0; j < period; j++) {
      hh = Math.max(hh, high[i - j])
      ll = Math.min(ll, low[i - j])
    }
    upper[i] = hh
    lower[i] = ll
  }
  const mid = upper.map((u, i) => (u + lower[i]) / 2)
  return { upper, lower, mid }
}

export function supertrend(
  high: number[],
  low: number[],
  close: number[],
  period = 10,
  mult = 3
): { line: number[]; dir: number[] } {
  const a = atr(high, low, close, period)
  const n = close.length
  const line = new Array<number>(n).fill(NaN)
  const dir = new Array<number>(n).fill(NaN)
  let upper = NaN
  let lower = NaN
  let trend = 1
  for (let i = 0; i < n; i++) {
    if (!isn(a[i])) continue
    const hl2 = (high[i] + low[i]) / 2
    let up = hl2 + mult * a[i]
    let dn = hl2 - mult * a[i]
    if (isn(upper)) {
      upper = up
      lower = dn
      trend = close[i] >= dn ? 1 : -1
    } else {
      up = close[i - 1] > upper ? Math.max(up, upper) : up
      dn = close[i - 1] < lower ? Math.min(dn, lower) : dn
      if (trend === 1) trend = close[i] < lower ? -1 : 1
      else trend = close[i] > upper ? 1 : -1
      upper = up
      lower = dn
    }
    line[i] = trend === 1 ? dn : up
    dir[i] = trend
  }
  return { line, dir }
}

export function ichimoku(
  high: number[],
  low: number[],
  conv = 9,
  base = 26,
  spanB = 52
): { tenkan: number[]; kijun: number[]; senkouA: number[]; senkouB: number[] } {
  const midRange = (p: number) => {
    const out = new Array<number>(high.length).fill(NaN)
    for (let i = p - 1; i < high.length; i++) {
      let hh = -Infinity
      let ll = Infinity
      for (let j = 0; j < p; j++) {
        hh = Math.max(hh, high[i - j])
        ll = Math.min(ll, low[i - j])
      }
      out[i] = (hh + ll) / 2
    }
    return out
  }
  const tenkan = midRange(conv)
  const kijun = midRange(base)
  const senkouA = tenkan.map((t, i) => (isn(t) && !isn(t)) || !isn(kijun[i]) ? NaN : (t + kijun[i]) / 2)
  const senkouB = midRange(spanB)
  return { tenkan, kijun, senkouA, senkouB }
}

// ---------- Volume ----------

export function obv(close: number[], volume: number[]): number[] {
  const out = new Array<number>(close.length).fill(0)
  for (let i = 1; i < close.length; i++) {
    const dir = close[i] > close[i - 1] ? 1 : close[i] < close[i - 1] ? -1 : 0
    out[i] = out[i - 1] + dir * volume[i]
  }
  return out
}

export function vwap(candles: Candle[]): number[] {
  let cumPV = 0
  let cumV = 0
  return candles.map((c) => {
    const tp = (c.high + c.low + c.close) / 3
    cumPV += tp * c.volume
    cumV += c.volume
    return cumV === 0 ? c.close : cumPV / cumV
  })
}

export function mfi(high: number[], low: number[], close: number[], volume: number[], period = 14): number[] {
  const tp = close.map((c, i) => (high[i] + low[i] + c) / 3)
  const out = new Array<number>(close.length).fill(NaN)
  for (let i = period; i < close.length; i++) {
    let pos = 0
    let neg = 0
    for (let j = 0; j < period; j++) {
      const flow = tp[i - j] * volume[i - j]
      if (tp[i - j] > tp[i - j - 1]) pos += flow
      else if (tp[i - j] < tp[i - j - 1]) neg += flow
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg)
  }
  return out
}

// ---------- Others ----------

export function parabolicSar(high: number[], low: number[], afStep = 0.02, afMax = 0.2): number[] {
  const n = high.length
  const out = new Array<number>(n).fill(NaN)
  if (n < 3) return out
  let bull = high[1] >= high[0]
  let af = afStep
  let ep = bull ? high[1] : low[1]
  let sar = bull ? low[0] : high[0]
  out[1] = sar
  for (let i = 2; i < n; i++) {
    sar = sar + af * (ep - sar)
    if (bull) {
      if (low[i] < sar) {
        bull = false
        sar = ep
        ep = low[i]
        af = afStep
      } else if (high[i] > ep) {
        ep = high[i]
        af = Math.min(af + afStep, afMax)
      }
    } else {
      if (high[i] > sar) {
        bull = true
        sar = ep
        ep = high[i]
        af = afStep
      } else if (low[i] < ep) {
        ep = low[i]
        af = Math.min(af + afStep, afMax)
      }
    }
    out[i] = sar
  }
  return out
}

export function linreg(src: number[], period: number): {
  slope: number
  intercept: number
  r2: number
  forecast: number
} {
  const n = Math.min(period, src.length)
  const start = src.length - n
  let sx = 0
  let sy = 0
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const x = i
    const y = src[start + i]
    sx += x
    sy += y
    sxy += x * y
    sxx += x * x
    syy += y * y
  }
  const denom = n * sxx - sx * sx
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom
  const intercept = (sy - slope * sx) / n
  const rDenom = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy))
  const r = rDenom === 0 ? 0 : (n * sxy - sx * sy) / rDenom
  return { slope, intercept, r2: r * r, forecast: intercept + slope * n }
}

export interface PivotLevels {
  pp: number
  r1: number
  r2: number
  r3: number
  s1: number
  s2: number
  s3: number
}

export function pivotPoints(candles: Candle[], dPeriod = 20): PivotLevels {
  const window = candles.slice(-dPeriod)
  const h = Math.max(...window.map((c) => c.high))
  const l = Math.min(...window.map((c) => c.low))
  const c = candles[candles.length - 1].close
  const pp = (h + l + c) / 3
  const range = h - l
  return {
    pp,
    r1: 2 * pp - l,
    r2: pp + range,
    r3: h + 2 * (pp - l),
    s1: 2 * pp - h,
    s2: pp - range,
    s3: l - 2 * (h - pp),
  }
}

export function fibLevels(candles: Candle[], lookback = 60): { label: string; price: number }[] {
  const window = candles.slice(-lookback)
  const h = Math.max(...window.map((c) => c.high))
  const l = Math.min(...window.map((c) => c.low))
  const diff = h - l
  const up = candles[candles.length - 1].close >= (h + l) / 2
  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
  return levels.map((lv) => ({
    label: `${(lv * 100).toFixed(1)}%`,
    price: up ? h - diff * lv : l + diff * lv,
  }))
}

// ============================================================
// Phase 2 - extended primitives (full TA suite)
// ============================================================

export function dema(src: number[], period: number): number[] {
  const e1 = ema(src, period)
  const e2 = ema(e1, period)
  return src.map((_, i) => (isn(e1[i]) && isn(e2[i]) ? 2 * e1[i] - e2[i] : NaN))
}

export function tema(src: number[], period: number): number[] {
  const e1 = ema(src, period)
  const e2 = ema(e1, period)
  const e3 = ema(e2, period)
  return src.map((_, i) => (isn(e1[i]) && isn(e2[i]) && isn(e3[i]) ? 3 * e1[i] - 3 * e2[i] + e3[i] : NaN))
}

export function trima(src: number[], period: number): number[] {
  const half = Math.ceil(period / 2)
  const s1 = sma(src, half)
  const s2 = sma(s1.map((v) => (isn(v) ? v : 0)), half)
  return s2.map((v, i) => (isn(s1[i]) ? v : NaN))
}

export function kama(src: number[], period = 10, fast = 2, slow = 30): number[] {
  const out = new Array<number>(src.length).fill(NaN)
  const fastSC = 2 / (fast + 1)
  const slowSC = 2 / (slow + 1)
  let prev = NaN
  for (let i = period; i < src.length; i++) {
    let change = 0
    for (let j = i - period + 1; j <= i; j++) change += Math.abs(src[j] - src[j - 1])
    const er = change === 0 ? 0 : Math.abs(src[i] - src[i - period]) / change
    const sc = Math.pow(er * (fastSC - slowSC) + slowSC, 2)
    prev = isn(prev) ? src[i] : prev + sc * (src[i] - prev)
    out[i] = prev
  }
  return out
}

export function hma(src: number[], period: number): number[] {
  const half = Math.max(2, Math.floor(period / 2))
  const sqrtP = Math.max(2, Math.floor(Math.sqrt(period)))
  const w1 = wma(src, half)
  const w2 = wma(src, period)
  const raw = src.map((_, i) => (isn(w1[i]) && isn(w2[i]) ? 2 * w1[i] - w2[i] : NaN))
  const firstValid = raw.findIndex(isn)
  const vals = firstValid >= 0 ? wma(raw.slice(firstValid).map((v) => (isn(v) ? v : 0)), sqrtP) : []
  const out = new Array<number>(src.length).fill(NaN)
  for (let i = 0; i < vals.length; i++) out[firstValid + i] = vals[i]
  return out
}

export function vwma(close: number[], volume: number[], period: number): number[] {
  const pv = close.map((c, i) => c * volume[i])
  const num = sma(pv, period)
  const den = sma(volume, period)
  return num.map((n, i) => (isn(n) && isn(den[i]) && den[i] !== 0 ? n / den[i] : NaN))
}

export function zlema(src: number[], period: number): number[] {
  const lag = Math.floor((period - 1) / 2)
  const adj = src.map((v, i) => (i >= lag ? 2 * v - src[i - lag] : v))
  return ema(adj, period)
}

export function t3(src: number[], period = 5, vf = 0.7): number[] {
  const e1 = ema(src, period)
  const e2 = ema(e1, period)
  const e3 = ema(e2, period)
  const e4 = ema(e3, period)
  const e5 = ema(e4, period)
  const e6 = ema(e5, period)
  const c1 = -(vf * vf * vf)
  const c2 = 3 * vf * vf + 3 * vf * vf * vf
  const c3 = -6 * vf * vf - 3 * vf - 3 * vf * vf * vf
  const c4 = 1 + 3 * vf + vf * vf * vf + 3 * vf * vf
  return src.map((_, i) =>
    isn(e6[i]) ? c1 * e6[i] + c2 * e5[i] + c3 * e4[i] + c4 * e3[i] : NaN
  )
}

export function mcginley(src: number[], period = 14): number[] {
  const out = new Array<number>(src.length).fill(NaN)
  let md = NaN
  for (let i = 0; i < src.length; i++) {
    if (!isn(md)) {
      if (i >= period - 1) {
        md = sma(src, period)[i]
        out[i] = md
      }
      continue
    }
    const k = src[i] > md ? Math.max(Math.abs(src[i] / md - 1) * 100, 1) : Math.min(Math.abs(src[i] / md - 1) * 100, 1)
    md = md + (src[i] - md) / (period * k)
    out[i] = md
  }
  return out
}

export function stochRsi(src: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): { k: number[]; d: number[] } {
  const r = rsi(src, rsiPeriod)
  const raw = new Array<number>(src.length).fill(NaN)
  for (let i = stochPeriod - 1; i < src.length; i++) {
    let hh = -Infinity
    let ll = Infinity
    for (let j = 0; j < stochPeriod; j++) {
      const v = r[i - j]
      if (!isn(v)) continue
      hh = Math.max(hh, v)
      ll = Math.min(ll, v)
    }
    raw[i] = hh === ll ? 50 : ((r[i] - ll) / (hh - ll)) * 100
  }
  const k = smoothInvalid(raw, kSmooth)
  const firstValid = k.findIndex(isn)
  const d = new Array<number>(src.length).fill(NaN)
  if (firstValid >= 0) {
    const kv = k.slice(firstValid).filter(isn)
    const dv = sma(kv, dSmooth)
    for (let i = 0; i < dv.length; i++) d[firstValid + i] = dv[i]
  }
  return { k, d }
}

function smoothInvalid(src: number[], period: number): number[] {
  const filled = src.map((v) => (isn(v) ? v : 0))
  const s = sma(filled, period)
  return s.map((v, i) => (isn(src[i]) ? v : NaN))
}

export function ppo(src: number[], fast = 12, slow = 26, signal = 9): { ppo: number[]; signal: number[]; hist: number[] } {
  const f = ema(src, fast)
  const s = ema(src, slow)
  const line = src.map((_, i) => (isn(f[i]) && isn(s[i]) && s[i] !== 0 ? ((f[i] - s[i]) / s[i]) * 100 : NaN))
  const firstValid = line.findIndex(isn)
  const sig = firstValid >= 0 ? ema(line.slice(firstValid).filter(isn), signal) : []
  const signalArr = new Array<number>(src.length).fill(NaN)
  for (let i = 0; i < sig.length; i++) signalArr[firstValid + i] = sig[i]
  const hist = line.map((v, i) => (isn(v) && isn(signalArr[i]) ? v - signalArr[i] : NaN))
  return { ppo: line, signal: signalArr, hist }
}

export function apo(src: number[], fast = 12, slow = 26): number[] {
  const f = ema(src, fast)
  const s = ema(src, slow)
  return src.map((_, i) => (isn(f[i]) && isn(s[i]) ? f[i] - s[i] : NaN))
}

export function cmo(src: number[], period = 14): number[] {
  const out = new Array<number>(src.length).fill(NaN)
  for (let i = period; i < src.length; i++) {
    let up = 0
    let dn = 0
    for (let j = i - period + 1; j <= i; j++) {
      const d = src[j] - src[j - 1]
      if (d > 0) up += d
      else dn -= d
    }
    out[i] = up + dn === 0 ? 0 : ((up - dn) / (up + dn)) * 100
  }
  return out
}

export function mom(src: number[], period = 10): number[] {
  return src.map((v, i) => (i >= period ? v - src[i - period] : NaN))
}

export function tsi(src: number[], long = 25, short = 13): { tsi: number[]; signal: number[] } {
  const pc = src.map((v, i) => (i > 0 ? v - src[i - 1] : 0))
  const num = ema(ema(pc.map(Math.abs), long), short)
  const den = ema(ema(pc, long), short)
  const line = num.map((n, i) => (isn(n) && isn(den[i]) && den[i] !== 0 ? (n / den[i]) * 100 : NaN))
  const firstValid = line.findIndex(isn)
  const sig = firstValid >= 0 ? ema(line.slice(firstValid).filter(isn), 7) : []
  const signal = new Array<number>(src.length).fill(NaN)
  for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i]
  return { tsi: line, signal }
}

export function ultimateOsc(high: number[], low: number[], close: number[], p1 = 7, p2 = 14, p3 = 28): number[] {
  const bp = close.map((c, i) => (i > 0 ? c - Math.min(low[i], close[i - 1]) : 0))
  const tr = close.map((c, i) => (i > 0 ? Math.max(high[i], close[i - 1]) - Math.min(low[i], close[i - 1]) : 0))
  const out = new Array<number>(close.length).fill(NaN)
  const sum = (arr: number[], i: number, p: number) => {
    let acc = 0
    for (let j = i - p + 1; j <= i; j++) acc += arr[j]
    return acc
  }
  for (let i = p3; i < close.length; i++) {
    const a = sum(bp, i, p1) / (sum(tr, i, p1) || 1)
    const b = sum(bp, i, p2) / (sum(tr, i, p2) || 1)
    const c = sum(bp, i, p3) / (sum(tr, i, p3) || 1)
    out[i] = ((4 * a + 2 * b + c) / 7) * 100
  }
  return out
}

export function dpo(src: number[], period = 20): number[] {
  const ma = sma(src, period)
  const shift = Math.floor(period / 2) + 1
  return src.map((v, i) => (isn(ma[i]) && i - shift >= 0 ? v - ma[i - shift] : NaN))
}

export function kst(src: number[]): { kst: number[]; signal: number[] } {
  const r1 = roc(src, 10)
  const r2 = roc(src, 15)
  const r3 = roc(src, 20)
  const r4 = roc(src, 30)
  const combo = src.map((_, i) =>
    isn(r1[i]) && isn(r2[i]) && isn(r3[i]) && isn(r4[i])
      ? r1[i] * 1 + r2[i] * 2 + r3[i] * 3 + r4[i] * 4
      : NaN
  )
  const line = smoothInvalid(combo, 10)
  const firstValid = line.findIndex(isn)
  const sig = firstValid >= 0 ? sma(line.slice(firstValid).filter(isn), 10) : []
  const signal = new Array<number>(src.length).fill(NaN)
  for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i]
  return { kst: line, signal }
}

export function rvi(close: number[], high: number[], low: number[], period = 10): { rvi: number[]; signal: number[] } {
  const out = new Array<number>(close.length).fill(NaN)
  const swma = (a: number, b: number, c: number, d: number) => (a * 1 + b * 2 + c * 2 + d) / 6
  const num: number[] = []
  const den: number[] = []
  for (let i = 0; i < close.length; i++) {
    if (i < 3) {
      num.push(NaN)
      den.push(NaN)
      continue
    }
    num.push(swma(close[i] - close[i - 1] + 0, close[i - 1] - close[i - 2], close[i - 2] - close[i - 3], 0))
    den.push(swma(high[i] - low[i], high[i - 1] - low[i - 1], high[i - 2] - low[i - 2], 0))
  }
  let numSum = 0
  let denSum = 0
  for (let i = 0; i < close.length; i++) {
    if (!isn(num[i])) continue
    numSum += num[i]
    denSum += den[i]
    if (i >= period) {
      const old = i - period
      if (isn(num[old])) {
        numSum -= num[old]
        denSum -= den[old]
      }
      out[i] = denSum === 0 ? 0 : (numSum / denSum) * 100
    }
  }
  const firstValid = out.findIndex(isn)
  const sig = firstValid >= 0 ? sma(out.slice(firstValid).filter(isn), 4) : []
  const signal = new Array<number>(close.length).fill(NaN)
  for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i]
  return { rvi: out, signal }
}

export function fisherTransform(high: number[], low: number[], period = 9): { fisher: number[]; trigger: number[] } {
  const out = new Array<number>(high.length).fill(NaN)
  const trig = new Array<number>(high.length).fill(NaN)
  let v = 0
  let f = 0
  for (let i = period - 1; i < high.length; i++) {
    let hh = -Infinity
    let ll = Infinity
    for (let j = 0; j < period; j++) {
      hh = Math.max(hh, high[i - j])
      ll = Math.min(ll, low[i - j])
    }
    const mid = (hh + ll) / 2
    const raw = ((high[i] + low[i]) / 2 - (i > 0 ? mid : mid)) / ((hh - ll) / 2 || 1)
    v = Math.min(Math.max(raw, -0.999), 0.999) * 0.33 + (isn(out[i - 1]) ? v * 0.67 : 0)
    const nf = (Math.log((1 + v) / (1 - v)) + (isn(out[i - 1]) ? out[i - 1] : 0)) * 0.5
    f = nf
    out[i] = f
    trig[i] = i > 0 ? out[i - 1] : f
  }
  return { fisher: out, trigger: trig }
}

export function awesomeOsc(high: number[], low: number[]): number[] {
  const mid = high.map((h, i) => (h + low[i]) / 2)
  const f = sma(mid, 5)
  const s = sma(mid, 34)
  return mid.map((_, i) => (isn(f[i]) && isn(s[i]) ? f[i] - s[i] : NaN))
}

export function qstick(open: number[], close: number[], period = 14): number[] {
  return sma(close.map((c, i) => c - open[i]), period)
}

// ---------- Volume ----------

export function adl(high: number[], low: number[], close: number[], volume: number[]): number[] {
  const out = new Array<number>(close.length).fill(0)
  for (let i = 0; i < close.length; i++) {
    const range = high[i] - low[i]
    const mfm = range === 0 ? 0 : ((close[i] - low[i]) - (high[i] - close[i])) / range
    out[i] = (i > 0 ? out[i - 1] : 0) + mfm * volume[i]
  }
  return out
}

export function cmf(high: number[], low: number[], close: number[], volume: number[], period = 20): number[] {
  const out = new Array<number>(close.length).fill(NaN)
  for (let i = period - 1; i < close.length; i++) {
    let mfv = 0
    let vol = 0
    for (let j = i - period + 1; j <= i; j++) {
      const range = high[j] - low[j]
      mfv += (range === 0 ? 0 : ((close[j] - low[j]) - (high[j] - close[j])) / range) * volume[j]
      vol += volume[j]
    }
    out[i] = vol === 0 ? 0 : mfv / vol
  }
  return out
}

export function chaikinOsc(high: number[], low: number[], close: number[], volume: number[], fast = 3, slow = 10): number[] {
  const line = adl(high, low, close, volume)
  const f = ema(line, fast)
  const s = ema(line, slow)
  return line.map((_, i) => (isn(f[i]) && isn(s[i]) ? f[i] - s[i] : NaN))
}

export function forceIndex(close: number[], volume: number[], period = 13): number[] {
  const raw = close.map((c, i) => (i > 0 ? (c - close[i - 1]) * volume[i] : 0))
  return ema(raw, period)
}

export function eom(high: number[], low: number[], volume: number[], period = 14): number[] {
  const raw = high.map((h, i) => {
    if (i === 0) return 0
    const mid = (h + low[i]) / 2 - (high[i - 1] + low[i - 1]) / 2
    const br = volume[i] / 10000 / (h - low[i] || 1)
    return mid / (br || 1)
  })
  return sma(raw, period)
}

export function nvi(close: number[], volume: number[]): number[] {
  const out = new Array<number>(close.length).fill(1000)
  for (let i = 1; i < close.length; i++) {
    const pct = close[i - 1] === 0 ? 0 : (close[i] - close[i - 1]) / close[i - 1]
    out[i] = volume[i] < volume[i - 1] ? out[i - 1] * (1 + pct) : out[i - 1]
  }
  return out
}

export function pvi(close: number[], volume: number[]): number[] {
  const out = new Array<number>(close.length).fill(1000)
  for (let i = 1; i < close.length; i++) {
    const pct = close[i - 1] === 0 ? 0 : (close[i] - close[i - 1]) / close[i - 1]
    out[i] = volume[i] > volume[i - 1] ? out[i - 1] * (1 + pct) : out[i - 1]
  }
  return out
}

export function klinger(high: number[], low: number[], close: number[], volume: number[], fast = 34, slow = 55): { vf: number[]; signal: number[] } {
  const vfRaw = new Array<number>(close.length).fill(0)
  for (let i = 1; i < close.length; i++) {
    const hlc = high[i] + low[i] + close[i]
    const prev = high[i - 1] + low[i - 1] + close[i - 1]
    const dir = hlc > prev ? 1 : -1
    const trend = close[i] > close[i - 1] ? 1 : -1
    vfRaw[i] = volume[i] * dir * trend * Math.abs(hlc - prev)
  }
  const f = ema(vfRaw, fast)
  const s = ema(vfRaw, slow)
  const vf = vfRaw.map((_, i) => (isn(f[i]) && isn(s[i]) ? f[i] - s[i] : NaN))
  const firstValid = vf.findIndex(isn)
  const sig = firstValid >= 0 ? ema(vf.slice(firstValid).filter(isn), 13) : []
  const signal = new Array<number>(close.length).fill(NaN)
  for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i]
  return { vf, signal }
}

// ---------- Volatility ----------

export function natr(high: number[], low: number[], close: number[], period = 14): number[] {
  const a = atr(high, low, close, period)
  return a.map((v, i) => (isn(v) && close[i] !== 0 ? (v / close[i]) * 100 : NaN))
}

export function trange(high: number[], low: number[], close: number[]): number[] {
  return trueRange(high, low, close)
}

export function ulcerIndex(close: number[], period = 14): number[] {
  const out = new Array<number>(close.length).fill(NaN)
  for (let i = period - 1; i < close.length; i++) {
    let sumSq = 0
    let maxClose = -Infinity
    for (let j = i - period + 1; j <= i; j++) {
      maxClose = Math.max(maxClose, close[j])
      const dd = ((close[j] - maxClose) / maxClose) * 100
      sumSq += dd * dd
    }
    out[i] = Math.sqrt(sumSq / period)
  }
  return out
}

export function chandelierExit(high: number[], low: number[], close: number[], period = 22, mult = 3): { long: number[]; short: number[] } {
  const a = atr(high, low, close, period)
  const long = new Array<number>(close.length).fill(NaN)
  const short = new Array<number>(close.length).fill(NaN)
  for (let i = period - 1; i < close.length; i++) {
    let hh = -Infinity
    let ll = Infinity
    for (let j = 0; j < period; j++) {
      hh = Math.max(hh, high[i - j])
      ll = Math.min(ll, low[i - j])
    }
    long[i] = hh - mult * a[i]
    short[i] = ll + mult * a[i]
  }
  return { long, short }
}

export function massIndex(high: number[], low: number[], period = 9, sumPeriod = 25): number[] {
  const range = high.map((h, i) => h - low[i])
  const e1 = ema(range, period)
  const e2 = ema(e1, period)
  const ratio = e1.map((v, i) => (isn(v) && isn(e2[i]) && e2[i] !== 0 ? v / e2[i] : NaN))
  const out = new Array<number>(high.length).fill(NaN)
  for (let i = sumPeriod - 1; i < high.length; i++) {
    let acc = 0
    let ok = true
    for (let j = i - sumPeriod + 1; j <= i; j++) {
      if (!isn(ratio[j])) {
        ok = false
        break
      }
      acc += ratio[j]
    }
    if (ok) out[i] = acc
  }
  return out
}

export function histVol(src: number[], period = 20, annualize = 252): number[] {
  const rets = src.map((v, i) => (i > 0 && src[i - 1] !== 0 ? Math.log(v / src[i - 1]) : NaN))
  const out = new Array<number>(src.length).fill(NaN)
  for (let i = period; i < src.length; i++) {
    let sum = 0
    let sumSq = 0
    for (let j = i - period + 1; j <= i; j++) {
      sum += rets[j]
      sumSq += rets[j] * rets[j]
    }
    const mean = sum / period
    const varr = sumSq / period - mean * mean
    out[i] = Math.sqrt(Math.max(varr, 0) * annualize) * 100
  }
  return out
}

export function varianceSeries(src: number[], period = 20): number[] {
  const mean = sma(src, period)
  const out = new Array<number>(src.length).fill(NaN)
  for (let i = period - 1; i < src.length; i++) {
    let acc = 0
    for (let j = 0; j < period; j++) {
      const d = src[i - j] - mean[i]
      acc += d * d
    }
    out[i] = acc / period
  }
  return out
}

// ---------- Trend ----------

export function aroon(high: number[], low: number[], period = 14): { up: number[]; down: number[]; osc: number[] } {
  const up = new Array<number>(high.length).fill(NaN)
  const down = new Array<number>(high.length).fill(NaN)
  for (let i = period; i < high.length; i++) {
    let hi = -Infinity
    let lo = Infinity
    let hiBars = 0
    let loBars = 0
    for (let j = 0; j <= period; j++) {
      if (high[i - j] >= hi) {
        hi = high[i - j]
        hiBars = j
      }
      if (low[i - j] <= lo) {
        lo = low[i - j]
        loBars = j
      }
    }
    up[i] = ((period - hiBars) / period) * 100
    down[i] = ((period - loBars) / period) * 100
  }
  const osc = up.map((u, i) => (isn(u) ? u - down[i] : NaN))
  return { up, down, osc }
}

export function trix(src: number[], period = 15): { trix: number[]; signal: number[] } {
  const e3 = ema(ema(ema(src, period), period), period)
  const line = e3.map((v, i) => (isn(v) && i > 0 && e3[i - 1] !== 0 ? ((v - e3[i - 1]) / e3[i - 1]) * 10000 : NaN))
  const firstValid = line.findIndex(isn)
  const sig = firstValid >= 0 ? ema(line.slice(firstValid).filter(isn), 9) : []
  const signal = new Array<number>(src.length).fill(NaN)
  for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i]
  return { trix: line, signal }
}

export function vortex(high: number[], low: number[], close: number[], period = 14): { viPlus: number[]; viMinus: number[] } {
  const vp = new Array<number>(close.length).fill(NaN)
  const vm = new Array<number>(close.length).fill(NaN)
  for (let i = period; i < close.length; i++) {
    let sumVMp = 0
    let sumVMm = 0
    let sumTR = 0
    for (let j = i - period + 1; j <= i; j++) {
      sumVMp += Math.abs(high[j] - low[j - 1])
      sumVMm += Math.abs(low[j] - high[j - 1])
      sumTR += trueRange(high, low, close)[j]
    }
    vp[i] = sumTR === 0 ? 1 : sumVMp / sumTR
    vm[i] = sumTR === 0 ? 1 : sumVMm / sumTR
  }
  return { viPlus: vp, viMinus: vm }
}

export function zigzag(close: number[], deviation = 5): { time: number[]; value: number[] } {
  const pivots: { idx: number; price: number }[] = []
  let lastPivotIdx = 0
  let lastPivotPrice = close[0]
  let trend = 0
  const th = deviation / 100
  for (let i = 1; i < close.length; i++) {
    const change = (close[i] - lastPivotPrice) / lastPivotPrice
    if (trend >= 0 && change <= -th) {
      pivots.push({ idx: lastPivotIdx, price: lastPivotPrice })
      trend = -1
      lastPivotIdx = i
      lastPivotPrice = close[i]
    } else if (trend <= 0 && change >= th) {
      pivots.push({ idx: lastPivotIdx, price: lastPivotPrice })
      trend = 1
      lastPivotIdx = i
      lastPivotPrice = close[i]
    } else if ((trend >= 0 && close[i] > lastPivotPrice) || (trend <= 0 && close[i] < lastPivotPrice)) {
      lastPivotIdx = i
      lastPivotPrice = close[i]
    }
  }
  pivots.push({ idx: lastPivotIdx, price: lastPivotPrice })
  return { time: pivots.map((p) => p.idx), value: pivots.map((p) => p.price) }
}

// ---------- Statistic / cycle ----------

export function correlation(a: number[], b: number[], period: number): number[] {
  const out = new Array<number>(a.length).fill(NaN)
  for (let i = period - 1; i < a.length; i++) {
    let sa = 0
    let sb = 0
    let sab = 0
    let saa = 0
    let sbb = 0
    for (let j = i - period + 1; j <= i; j++) {
      sa += a[j]
      sb += b[j]
      sab += a[j] * b[j]
      saa += a[j] * a[j]
      sbb += b[j] * b[j]
    }
    const num = period * sab - sa * sb
    const den = Math.sqrt((period * saa - sa * sa) * (period * sbb - sb * sb))
    out[i] = den === 0 ? 0 : num / den
  }
  return out
}

export function beta(asset: number[], market: number[], period: number): number[] {
  const out = new Array<number>(asset.length).fill(NaN)
  for (let i = period; i < asset.length; i++) {
    let ra = 0
    let rm = 0
    let cov = 0
    let varm = 0
    for (let j = i - period + 1; j <= i; j++) {
      const raJ = asset[j - 1] !== 0 ? (asset[j] - asset[j - 1]) / asset[j - 1] : 0
      const rmJ = market[j - 1] !== 0 ? (market[j] - market[j - 1]) / market[j - 1] : 0
      ra += raJ
      rm += rmJ
      cov += raJ * rmJ
      varm += rmJ * rmJ
    }
    const ma = ra / period
    const mm = rm / period
    const c = cov / period - ma * mm
    const v = varm / period - mm * mm
    out[i] = v === 0 ? 1 : c / v
  }
  return out
}

export function zscoreSeries(src: number[], period: number): number[] {
  const mean = sma(src, period)
  const sd = stdDev(src, period)
  return src.map((v, i) => (isn(sd[i]) && sd[i] !== 0 ? (v - mean[i]) / sd[i] : NaN))
}

/** Ehlers Hilbert-style dominant cycle proxy (sine wave of price detrend). */
export function hilbertSine(src: number[], period = 32): { sine: number[]; lead: number[] } {
  const out = new Array<number>(src.length).fill(NaN)
  const lead = new Array<number>(src.length).fill(NaN)
  const detrend = src.map((v, i) => (i >= period ? v - sma(src, period)[i] : v))
  for (let i = period; i < src.length; i++) {
    const d = detrend[i]
    const im = (d + 2 * detrend[i - 1] + 2 * detrend[i - 2] + detrend[i - 3]) / 6
    const re = (detrend[i] + detrend[i - 2]) / 2
    const phase = Math.atan2(im, re) * (180 / Math.PI)
    const dc = phase < 0 ? phase + 360 : phase
    out[i] = Math.sin((dc * Math.PI) / 180)
    lead[i] = Math.sin(((dc + 45) * Math.PI) / 180)
  }
  return { sine: out, lead }
}

// ---------- Overlap extras ----------

export function envelope(src: number[], period = 20, pct = 2.5): { upper: number[]; mid: number[]; lower: number[] } {
  const mid = sma(src, period)
  return {
    upper: mid.map((m) => (isn(m) ? m * (1 + pct / 100) : NaN)),
    mid,
    lower: mid.map((m) => (isn(m) ? m * (1 - pct / 100) : NaN)),
  }
}

export function linregLine(src: number[], period: number): number[] {
  const out = new Array<number>(src.length).fill(NaN)
  for (let i = period - 1; i < src.length; i++) {
    let sx = 0
    let sy = 0
    let sxy = 0
    let sxx = 0
    for (let j = 0; j < period; j++) {
      const x = j
      const y = src[i - period + 1 + j]
      sx += x
      sy += y
      sxy += x * y
      sxx += x * x
    }
    const denom = period * sxx - sx * sx
    const slope = denom === 0 ? 0 : (period * sxy - sx * sy) / denom
    const intercept = (sy - slope * sx) / period
    out[i] = intercept + slope * (period - 1)
  }
  return out
}

export function midpoint(src: number[], period: number): number[] {
  const out = new Array<number>(src.length).fill(NaN)
  for (let i = period - 1; i < src.length; i++) {
    let hh = -Infinity
    let ll = Infinity
    for (let j = 0; j < period; j++) {
      hh = Math.max(hh, src[i - j])
      ll = Math.min(ll, src[i - j])
    }
    out[i] = (hh + ll) / 2
  }
  return out
}
