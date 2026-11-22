// IQAIR//OS - WEIS WAVE (`ww.*`).
//
// David Weis's adaptation of Wyckoff: cut the price into WAVES (an up-wave is a run of bars rising, a down-wave a run falling), SUM the volume of each wave, and read volume against the price it bought.
//   EFFORT vs RESULT  the volume a wave used per ATR of price it moved. Lots of effort for little result = absorption (the other side is soaking it up) -> the wave is likely to fail.
//   DIVERGENCE        an up-wave that makes a HIGHER high on LESS volume than the previous up-wave is weak (put side); a down-wave that makes a LOWER low on less volume is weak (call side).
//   SHORTENING        successive waves in one direction cover less and less price.
//   CONFIRMATION      a new extreme on MORE volume than the previous wave in that direction = the trend has fuel.
// Two ways to cut the waves (selectable):
//   "atr"   (default) a wave turns when the CLOSE reverses by `thr` x ATR14 (default 1.0) from the wave's extreme close. Adapts to each pair's volatility.
//   "close" the classic simple cut: the wave runs while closes keep going the same way and turns on the first close the other way (many more, shorter waves).
// VOLUME: IQ feeds often carry tick-count or no volume (many OTC instruments). When the volume does not vary, the bar's true range stands in as the effort measure and `volumeOk` is false - the read says so instead of inventing volume.
// Pure, causal on CLOSED candles. HONEST: this describes where effort and result disagree; whether trading it pays is for a backtest to say.
import type { Candle } from '../types'
import { atr as atrInd } from './indicators'

export const WW_MIN_BARS = 60
export type WwMode = 'atr' | 'close'
export interface WwWave { dir: 1 | -1; startIdx: number; endIdx: number; startPrice: number; endPrice: number; bars: number; volume: number; moveAtr: number }
export interface WwOptions { mode?: WwMode; thr?: number; divRatio?: number; absorbEffort?: number }
export interface WwRead {
  ok: true; mode: WwMode; thr: number; volumeOk: boolean
  /** the last confirmed waves, oldest first (at most 16) */
  waves: WwWave[]
  /** the wave still running at the last closed bar (its volume is summed so far) */
  cur: WwWave
  prevSame: WwWave | null; prevOpp: WwWave | null
  count: number
  volRatio: number // cur volume / previous same-direction wave's volume (NaN with none)
  effort: number // cur volume per ATR moved
  effortRatio: number // vs the average of the last confirmed waves (NaN with none)
  newExtreme: boolean // cur has gone beyond the previous same-direction wave's end
  weak: boolean // new extreme on LESS volume (divergence)
  strong: boolean // new extreme on MORE volume (confirmation)
  absorption: boolean // big effort, small result
  shortening: boolean
  hot: boolean // cur volume well above the typical wave
  direction: 'call' | 'put' | 'none'
  strength: number
  reason: string
}
const mean = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN)

function volumeSeries(c: Candle[]): { v: number[]; volumeOk: boolean } {
  const tail = c.slice(-120).map((x) => x.volume ?? 0)
  const distinct = new Set(tail.map((x) => Math.round(x))).size
  const volumeOk = distinct >= 8 && mean(tail) > 0
  return { v: c.map((x) => (volumeOk ? (x.volume ?? 0) : Math.max(0, x.high - x.low))), volumeOk }
}

/** cut the closes into waves; returns [startIdx, endIdx, dir] triples where the wave's bars are startIdx+1..endIdx (the pivot bar belongs to the wave before) */
function cut(close: number[], atr: number[], mode: WwMode, thr: number): Array<[number, number, 1 | -1]> {
  const out: Array<[number, number, 1 | -1]> = []
  const n = close.length
  if (mode === 'close') {
    let dir: 0 | 1 | -1 = 0, start = 0
    for (let i = 1; i < n; i++) {
      const d = Math.sign(close[i] - close[i - 1])
      if (d === 0) continue
      if (dir === 0) { dir = d as 1 | -1; start = i - 1; continue }
      if (d !== dir) { out.push([start, i - 1, dir]); start = i - 1; dir = d as 1 | -1 }
    }
    if (dir !== 0) out.push([start, n - 1, dir]) // running wave (marked by being last)
    return out
  }
  let dir: 0 | 1 | -1 = 0, loIdx = 0, hiIdx = 0, start = 0, ext = 0
  for (let t = 1; t < n; t++) {
    const a = atr[t]
    if (!(a > 0)) continue
    if (dir === 0) {
      if (close[t] - close[loIdx] >= thr * a) { dir = 1; start = loIdx; ext = t }
      else if (close[hiIdx] - close[t] >= thr * a) { dir = -1; start = hiIdx; ext = t }
      else { if (close[t] < close[loIdx]) loIdx = t; if (close[t] > close[hiIdx]) hiIdx = t }
    } else if (dir === 1) {
      if (close[t] > close[ext]) ext = t
      else if (close[ext] - close[t] >= thr * a) { out.push([start, ext, 1]); start = ext; dir = -1; ext = t }
    } else {
      if (close[t] < close[ext]) ext = t
      else if (close[t] - close[ext] >= thr * a) { out.push([start, ext, -1]); start = ext; dir = 1; ext = t }
    }
  }
  if (dir !== 0) out.push([start, n - 1, dir]) // running wave: from its pivot to the last bar
  return out
}

export function readWeisWave(candles: Candle[], o: WwOptions = {}): WwRead | null {
  if (candles.length < WW_MIN_BARS) return null
  const mode: WwMode = o.mode === 'close' ? 'close' : 'atr'
  const thr = o.thr !== undefined && o.thr > 0 ? o.thr : 1.0
  const divRatio = o.divRatio ?? 0.8, absorbEffort = o.absorbEffort ?? 1.5
  const close = candles.map((c) => c.close)
  const atr = atrInd(candles.map((c) => c.high), candles.map((c) => c.low), close, 14)
  const lastAtr = atr[atr.length - 1]
  if (!(lastAtr > 0)) return null
  const { v, volumeOk } = volumeSeries(candles)
  const raw = cut(close, atr, mode, thr)
  if (raw.length < 2) return null
  const mk = ([s, e, d]: [number, number, 1 | -1]): WwWave => {
    let vol = 0; for (let i = s + 1; i <= e; i++) vol += v[i]
    const a = atr[e] > 0 ? atr[e] : lastAtr
    return { dir: d, startIdx: s, endIdx: e, startPrice: close[s], endPrice: close[e], bars: e - s, volume: vol, moveAtr: Math.abs(close[e] - close[s]) / a }
  }
  const all = raw.map(mk)
  const cur = all[all.length - 1], conf = all.slice(0, -1).filter((w) => w.bars >= 1)
  const waves = conf.slice(-16)
  const prevSame = [...conf].reverse().find((w) => w.dir === cur.dir) ?? null
  const prevOpp = conf.length && conf[conf.length - 1].dir !== cur.dir ? conf[conf.length - 1] : ([...conf].reverse().find((w) => w.dir !== cur.dir) ?? null)
  const recent = conf.slice(-4)
  const eff = (w: WwWave) => w.volume / Math.max(w.moveAtr, 0.2)
  const volRatio = prevSame && prevSame.volume > 0 ? cur.volume / prevSame.volume : NaN
  const effort = eff(cur)
  const effortRatio = recent.length ? effort / mean(recent.map(eff)) : NaN
  const newExtreme = !!prevSame && (cur.dir > 0 ? cur.endPrice > prevSame.endPrice : cur.endPrice < prevSame.endPrice)
  const weak = newExtreme && cur.bars >= 2 && Number.isFinite(volRatio) && volRatio < divRatio
  const strong = newExtreme && cur.bars >= 2 && Number.isFinite(volRatio) && volRatio >= 1.2
  const avgMove = mean(recent.map((w) => w.moveAtr))
  const absorption = cur.bars >= 2 && Number.isFinite(effortRatio) && effortRatio >= absorbEffort && Number.isFinite(avgMove) && cur.moveAtr < 0.7 * avgMove
  const sameWaves = conf.filter((w) => w.dir === cur.dir).slice(-2)
  const shortening = sameWaves.length === 2 && sameWaves[1].moveAtr < sameWaves[0].moveAtr && cur.moveAtr < sameWaves[1].moveAtr * 0.9 && cur.bars >= 2
  const typical = mean(recent.map((w) => w.volume))
  const hot = Number.isFinite(typical) && typical > 0 && cur.volume > 1.5 * typical
  // the call: weakness / absorption / shortening of the running wave = it is likely to fail, so the other way; a confirmed new extreme = the wave has fuel, so with it
  const against = (weak ? 35 : 0) + (absorption ? 30 : 0) + (shortening ? 20 : 0)
  const withIt = strong ? 40 : 0
  let direction: 'call' | 'put' | 'none' = 'none', strength = 0, reason = 'no effort-versus-result signal on the running wave'
  if (Math.max(against, withIt) >= 30) {
    if (against >= withIt) { direction = cur.dir > 0 ? 'put' : 'call'; strength = Math.min(100, against + (hot ? 10 : 0)); reason = `${cur.dir > 0 ? 'up' : 'down'}-wave looks spent: ${[weak ? `new ${cur.dir > 0 ? 'high' : 'low'} on only ${(volRatio * 100).toFixed(0)}% of the previous wave's volume` : '', absorption ? `big effort (${effortRatio.toFixed(1)}x usual) for little result (${cur.moveAtr.toFixed(2)} ATR)` : '', shortening ? 'each wave in this direction is shorter' : ''].filter(Boolean).join('; ')}` }
    else { direction = cur.dir > 0 ? 'call' : 'put'; strength = Math.min(100, withIt + (hot ? 10 : 0)); reason = `${cur.dir > 0 ? 'up' : 'down'}-wave has fuel: new ${cur.dir > 0 ? 'high' : 'low'} on ${(volRatio * 100).toFixed(0)}% of the previous wave's volume` }
  }
  return { ok: true, mode, thr, volumeOk, waves, cur, prevSame, prevOpp, count: all.length, volRatio, effort, effortRatio, newExtreme, weak, strong, absorption, shortening, hot, direction, strength, reason }
}
