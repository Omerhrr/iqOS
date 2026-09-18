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
