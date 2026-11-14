// IQAIR//OS - price / volume relationship readers for the MSL `pv.*` namespace.
//
// Pure functions over CLOSED candles' close + volume (nothing looks ahead). They answer: does volume go with price here, which way is
// the volume leaning, and is the last bar's effort showing up in its result?
// Volume honesty: many OTC instruments carry flat, zero or tick-count-only volume. `volumeOk` is false then and every other reader still
// returns a number (0 when it cannot say) - a script must gate on `pv.volumeOk()` rather than trust a correlation of a constant.
// This describes a relationship in the CURRENT window. Whether it predicts the next candle is not established here. No I/O.
import type { Candle } from '../types'

export const PV_MIN_BARS = 40

export interface PvInput { close: number[]; high: number[]; low: number[]; volume: number[] }

export function pvInput(c: Candle[]): PvInput {
  return { close: c.map((k) => k.close), high: c.map((k) => k.high), low: c.map((k) => k.low), volume: c.map((k) => k.volume) }
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0)

/** Pearson correlation of two equal-length arrays; 0 when either is constant (no relationship can be measured) */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  const ma = mean(a.slice(0, n))
  const mb = mean(b.slice(0, n))
  let sab = 0, saa = 0, sbb = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb
    sab += da * db; saa += da * da; sbb += db * db
  }
  if (saa <= 1e-18 || sbb <= 1e-18) return 0
  return sab / Math.sqrt(saa * sbb)
}

/** true when the feed's volume actually varies over the last 100 bars (not flat, not mostly zero) */
export function volumeOk(v: number[]): boolean {
  const w = v.slice(-100)
  if (w.length < PV_MIN_BARS) return false
  const nz = w.filter((x) => x > 0).length
  if (nz < w.length * 0.8) return false
  const m = mean(w)
  if (m <= 0) return false
  const sd = Math.sqrt(mean(w.map((x) => (x - m) * (x - m))))
  return sd / m >= 0.05
}

function returns(close: number[], n: number): number[] {
  const out: number[] = []
  for (let i = close.length - n; i < close.length; i++) out.push(close[i] - close[i - 1])
  return out
}

export interface PvRead {
  volumeOk: boolean
  /** correlation of signed bar change with volume over n bars: > 0 = volume is bigger on up bars (rising on rallies) */
  corrRet: number
  /** correlation of |bar change| with volume: the usual "volume goes with big moves" link */
  corrAbs: number
  /** correlation of the close LEVEL with volume (what the Price-Volume Corr indicator shows) - dominated by trend, read with care */
  corrLevel: number
  /** last n bars' volume / the mean of the n bars before them */
  relVol: number
  /** share of volume on up bars minus share on down bars over n bars, -1..+1 (volume-weighted direction) */
  tilt: number
  /** last bar's volume (vs its 20-bar mean) divided by its range (vs its 20-bar mean range): > 1 = effort bigger than result (absorption), < 1 = easy movement */
  effort: number
}

export function readPv(c: PvInput, n = 30, relN = 3): PvRead | null {
  const len = c.close.length
  const nn = Math.max(10, Math.min(120, Math.round(n)))
  if (len < Math.max(PV_MIN_BARS, nn + relN + 2)) return null
  const vol = c.volume.slice(len - nn)
  const rets = returns(c.close, nn)
  const ok = volumeOk(c.volume)
  const corrRet = ok ? pearson(rets, vol) : 0
  const corrAbs = ok ? pearson(rets.map(Math.abs), vol) : 0
  const corrLevel = ok ? pearson(c.close.slice(len - nn), vol) : 0
  const prev = c.volume.slice(len - relN - nn, len - relN)
  const recent = c.volume.slice(len - relN)
  const relVol = ok && mean(prev) > 0 ? mean(recent) / mean(prev) : 0
  let up = 0, dn = 0
  for (let i = 0; i < rets.length; i++) {
    if (rets[i] > 0) up += vol[i]
    else if (rets[i] < 0) dn += vol[i]
  }
  const tilt = ok && up + dn > 0 ? (up - dn) / (up + dn) : 0
  const ranges: number[] = []
  for (let i = len - 21; i < len - 1; i++) ranges.push(c.high[i] - c.low[i])
  const vols20 = c.volume.slice(len - 21, len - 1)
  const lastRange = c.high[len - 1] - c.low[len - 1]
  const mr = mean(ranges), mv = mean(vols20)
  const effort = ok && mr > 0 && mv > 0 && lastRange > 0 ? (c.volume[len - 1] / mv) / (lastRange / mr) : 0
  return { volumeOk: ok, corrRet, corrAbs, corrLevel, relVol, tilt, effort }
}
