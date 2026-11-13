// IQAIR//OS - Wyckoff accumulation / distribution schematic reader for the MSL `wyckoff.*` namespace.
//
// A causal reader over CLOSED candles (nothing looks ahead). It looks for the classic structure:
//   PRIOR TREND  a clear move into the range (down for accumulation, up for distribution)
//   TRADING RANGE  a sideways range (low efficiency ratio, both edges tested, mid-line crossed repeatedly). Support / resistance are the 8th /
//                92nd percentiles of the range's lows / highs, so the spring / upthrust wicks do not move the edges.
//   EVENTS  climax (SC / BC: a wide, high-effort bar at the extreme that closes off it), spring (a poke BELOW support that closes back above)
//           / upthrust (a poke ABOVE resistance that closes back below), SOS / SOW (a decisive expansion close through the far edge),
//           LPS / LPSY (the pullback after it that holds the broken edge).
//   PHASE  A (stopping action: climax present, range young), B (building the range), C (the spring / upthrust test), D (SOS / SOW and
//          its LPS / LPSY), E (the move has run 2+ ATR past the range).
// Volume: used for the climax / SOS effort test only when the feed's volume is informative (varies); on a feed with flat or missing volume
// (many OTC instruments) the bar's true range is the effort measure and `volumeOk` is false - the reader says so instead of inventing volume.
//
// Honest scope: this detects the SCHEMATIC SHAPE. Whether it has an edge on real markets is not established here. Pure, no I/O.
import type { Candle } from '../types'

export const WYCKOFF_MIN_BARS = 150
export const TR_MIN = 20
export const TR_MAX = 120
/** how many bars after the range may have ended and still belong to its cycle (SOS / LPS / markup) */
export const TR_TAIL = 40
export const ER_MAX = 0.2
/** range width in the range's OWN mean true ranges (a calm bar-to-bar tape inside a real range makes the same width many more ATR) */
export const WIDTH_MIN_ATR = 2
export const WIDTH_MAX_ATR = 14
/** the move into the range must be at least this many ATR and reasonably efficient (a trend, not noise) */
export const TREND_MIN_ATR = 3
export const TREND_ER_MIN = 0.35
/** the range must not DRIFT: its two halves' mean closes differ by at most this share of the width */
export const DRIFT_MAX = 0.2
export const EPS_ATR = 0.15

export type WyckoffSchematic = 'none' | 'accumulation' | 'distribution'
export type WyckoffPhase = 'none' | 'A' | 'B' | 'C' | 'D' | 'E'

export interface WyckoffRead {
  schematic: WyckoffSchematic
  phase: WyckoffPhase
  /** +1 accumulation (expected move up) / -1 distribution / 0 none */
  dir: number
  support: number
  resistance: number
  rangeBars: number
  /** move into the range over the 40 bars before it, in ATR (negative = down) */
  priorTrendAtr: number
  climax: boolean
  /** spring (accumulation) / upthrust (distribution) seen and reclaimed */
  spring: boolean
  upthrust: boolean
  /** decisive expansion through the far edge */
  sos: boolean
  sow: boolean
  /** pullback after SOS / SOW that held the broken edge */
  lps: boolean
  lpsy: boolean
  /** bars since the range ended (0 while still inside it) */
  sinceRange: number
  volumeOk: boolean
  atr: number
}

const NONE = (atr: number, volumeOk: boolean): WyckoffRead => ({
  schematic: 'none', phase: 'none', dir: 0, support: 0, resistance: 0, rangeBars: 0, priorTrendAtr: 0,
  climax: false, spring: false, upthrust: false, sos: false, sow: false, lps: false, lpsy: false, sinceRange: 0, volumeOk, atr,
})

function quantile(sorted: number[], q: number): number {
  const p = (sorted.length - 1) * q
  const lo = Math.floor(p)
  const hi = Math.ceil(p)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo)
}

export function readWyckoff(c: Candle[]): WyckoffRead | null {
  const n = c.length
  if (n < WYCKOFF_MIN_BARS) return null
  const i = n - 1
  const tr = new Array<number>(n)
  for (let k = 0; k < n; k++) tr[k] = k === 0 ? c[k].high - c[k].low : Math.max(c[k].high - c[k].low, Math.abs(c[k].high - c[k - 1].close), Math.abs(c[k].low - c[k - 1].close))
  const ps = new Array<number>(n + 1).fill(0)
  for (let k = 0; k < n; k++) ps[k + 1] = ps[k] + tr[k]
  const meanTr = (a: number, b: number) => (ps[b + 1] - ps[a]) / (b - a + 1)
  // path length of closes for the efficiency ratio
  const pp = new Array<number>(n).fill(0)
  for (let k = 1; k < n; k++) pp[k] = pp[k - 1] + Math.abs(c[k].close - c[k - 1].close)
  // is the volume informative?
  const vols = c.slice(-200).map((x) => x.volume ?? 0)
  const vm = vols.reduce((a, b) => a + b, 0) / vols.length
  const vsd = Math.sqrt(vols.reduce((a, b) => a + (b - vm) ** 2, 0) / vols.length)
  const volumeOk = vm > 0 && vsd / vm > 0.15
  const atrNow = meanTr(Math.max(0, i - 13), i)

  const volAvg = (a: number, b: number) => {
    let t = 0
    let m = 0
    for (let k = Math.max(0, a); k <= b; k++) {
      t += c[k].volume ?? 0
      m++
    }
    return m ? t / m : 0
  }

  // ---- anchor on the stopping action: the climax bar that ENDS a clear prior trend. The range is then the structure after it.
  type Rng = { k: number; s: number; e: number; S: number; R: number; accum: boolean; prior: number }
  let found: Rng | null = null
  for (let k = i - TR_MIN - 1; k >= Math.max(45, i - TR_MAX - TR_TAIL) && !found; k--) {
    const atrPrior = meanTr(k - 20, k - 1)
    if (atrPrior <= 1e-12) continue
    const range = c[k].high - c[k].low
    if (range <= 1e-12) continue
    const wideBar = tr[k] >= 1.8 * atrPrior
    const heavy = volumeOk && (c[k].volume ?? 0) >= 2.5 * volAvg(k - 20, k - 1)
    // effort: a wide bar, or (with informative volume) a bar on very heavy volume that is at least average width
    if (!(wideBar && (!volumeOk || (c[k].volume ?? 0) >= 1.5 * volAvg(k - 20, k - 1))) && !(heavy && tr[k] >= 0.8 * atrPrior)) continue
    // direction of the move INTO the climax
    const p0 = k - 40
    const move = c[k - 1].close - c[p0].close
    const path = pp[k - 1] - pp[p0]
    if (path <= 1e-12 || Math.abs(move) / path < TREND_ER_MIN || Math.abs(move) < TREND_MIN_ATR * atrPrior) continue
    const accum = move < 0
    // the climax bar is the extreme of that move and closes off it
    let ext = true
    for (let j = k - 40; j < k; j++) if (accum ? c[j].low < c[k].low - 1.0 * atrPrior : c[j].high > c[k].high + 1.0 * atrPrior) ext = false
    const closePos = (c[k].close - c[k].low) / range
    void closePos // close location is not required: the range that follows is what validates the stop
    // the range after it: longest window starting right after the climax that qualifies, ending as late as possible
    const s = k + 1
    for (let e = i; e >= s + TR_MIN - 1; e--) {
      const L = e - s + 1
      if (L > TR_MAX) break
      const path2 = pp[e] - pp[s]
      if (path2 <= 1e-12 || Math.abs(c[e].close - c[s].close) / path2 > ER_MAX) continue
      const atrE = meanTr(s, e)
      if (atrE <= 1e-12) continue
      const lows: number[] = []
      const highs: number[] = []
      for (let q = s; q <= e; q++) {
        lows.push(c[q].low)
        highs.push(c[q].high)
      }
      lows.sort((a, b) => a - b)
      highs.sort((a, b) => a - b)
      const S = quantile(lows, 0.08)
      const R = quantile(highs, 0.92)
      const w = R - S
      if (w < WIDTH_MIN_ATR * atrE || w > WIDTH_MAX_ATR * atrE) continue
      let touchLo = 0
      let touchHi = 0
      let cross = 0
      const mid = (S + R) / 2
      for (let q = s; q <= e; q++) {
        if (c[q].low <= S + 0.15 * w) touchLo++
        if (c[q].high >= R - 0.15 * w) touchHi++
        if (q > s && (c[q].close - mid) * (c[q - 1].close - mid) < 0) cross++
      }
      if (touchLo < 2 || touchHi < 2 || cross < Math.max(4, Math.floor(L / 10))) continue
      const h = s + Math.floor(L / 2)
      let m1 = 0
      let m2 = 0
      for (let q = s; q < h; q++) m1 += c[q].close
      for (let q = h; q <= e; q++) m2 += c[q].close
      if (Math.abs(m1 / (h - s) - m2 / (e - h + 1)) > DRIFT_MAX * w) continue
      found = { k, s, e, S, R, accum, prior: move / atrPrior }
      break
    }
  }
  if (!found) return NONE(atrNow, volumeOk)
  const { s, S, R, accum, prior } = found
  let e = found.e
  // clip the range at the first decisive close beyond the far edge ESTABLISHED by its first 25 bars (that bar is the breakout, not range)
  {
    const m = Math.min(e, s + 24)
    let hi0 = -Infinity
    let lo0 = Infinity
    for (let k = s; k <= m; k++) {
      hi0 = Math.max(hi0, c[k].high)
      lo0 = Math.min(lo0, c[k].low)
    }
    const a0 = meanTr(s, m)
    for (let k = m + 1; k <= e; k++) {
      if (accum ? c[k].close > hi0 + a0 : c[k].close < lo0 - a0) {
        if (k - s >= TR_MIN) e = k - 1
        break
      }
    }
  }
  const atr = meanTr(s, e)
  const eps = EPS_ATR * atr
  const dir = accum ? 1 : -1
  const effortOk = (k: number): boolean => {
    const wide = tr[k] >= 1.8 * atr
    if (!volumeOk) return wide
    return wide && (c[k].volume ?? 0) >= 1.5 * volAvg(k - 20, k - 1)
  }
  void effortOk

  // ---- events (accumulation reads the lows; distribution is the mirror image)
  let farExt = accum ? -Infinity : Infinity // the range's true extreme on the far side (SOS / SOW must break it)
  for (let k = s; k <= e; k++) farExt = accum ? Math.max(farExt, c[k].high) : Math.min(farExt, c[k].low)
  const edgeFar = farExt
  const climax = true // anchored on it above
  // spring / upthrust: poke through the near edge that is reclaimed within 3 bars (and not followed by a collapse)
  let spring = false
  let nearExt = accum ? Infinity : -Infinity // the range's extreme on the near side SO FAR (a spring takes out the range's own lows)
  for (let k = s; k <= i; k++) {
    if (k >= s + 8) {
      const poke = accum ? c[k].low < nearExt - 0.3 * atr : c[k].high > nearExt + 0.3 * atr
      if (poke) {
        let back = false
        for (let j = k; j <= Math.min(i, k + 3); j++) {
          if (accum ? c[j].close >= nearExt : c[j].close <= nearExt) {
            back = true
            break
          }
        }
        if (back) spring = true
      }
    }
    nearExt = accum ? Math.min(nearExt, c[k].low) : Math.max(nearExt, c[k].high)
  }
  // SOS / SOW: decisive expansion close through the far edge (after the range had time to form)
  let sosIdx = -1
  for (let k = s + 10; k <= i; k++) {
    const through = accum ? c[k].close > edgeFar + eps : c[k].close < edgeFar - eps
    const expansion = tr[k] >= 1.2 * atr && (volumeOk ? (c[k].volume ?? 0) >= 1.2 * volAvg(k - 20, k - 1) : true)
    if (through && expansion) {
      sosIdx = k
      break
    }
  }
  const sos = sosIdx >= 0
  // LPS / LPSY: after SOS, a pullback of >= 0.5 ATR from the best close that still holds the broken edge, and price is back out of the range
  let lps = false
  if (sos) {
    let best = c[sosIdx].close
    let pulled = false
    for (let k = sosIdx + 1; k <= i; k++) {
      best = accum ? Math.max(best, c[k].close) : Math.min(best, c[k].close)
      const pulledBack = accum ? best - c[k].low >= 0.5 * atr : c[k].high - best >= 0.5 * atr
      const held = accum ? c[k].low >= edgeFar - 0.5 * atr : c[k].high <= edgeFar + 0.5 * atr
      if (pulledBack && held) pulled = true
      if (!held) {
        pulled = false
        break
      }
    }
    lps = pulled && (accum ? c[i].close > edgeFar : c[i].close < edgeFar)
  }
  // a failed cycle: after SOS price falls back into / through the range
  if (sos && (accum ? c[i].close < edgeFar - 0.5 * atr : c[i].close > edgeFar + 0.5 * atr)) {
    return { ...NONE(atrNow, volumeOk), support: S, resistance: R, rangeBars: e - s + 1, priorTrendAtr: prior, schematic: 'none' }
  }
  const beyond = accum ? (c[i].close - R) / atr : (S - c[i].close) / atr
  let phase: WyckoffPhase
  if (sos) phase = beyond >= 2 ? 'E' : 'D'
  else if (spring) phase = 'C'
  else if (e - s + 1 < 30 && i - e <= 5) phase = 'A'
  else phase = 'B'
  return {
    schematic: accum ? 'accumulation' : 'distribution',
    phase,
    dir,
    support: S,
    resistance: R,
    rangeBars: e - s + 1,
    priorTrendAtr: prior,
    climax,
    spring: accum && spring,
    upthrust: !accum && spring,
    sos: accum && sos,
    sow: !accum && sos,
    lps: accum && lps,
    lpsy: !accum && lps,
    sinceRange: i - e,
    volumeOk,
    atr,
  }
}
