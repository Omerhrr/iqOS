// IQAIR//OS - "who is in control" (MSL `ctl.*`).
//
// Reads the last N closed bars (default 10) and scores who is driving price, -100 (sellers fully in control) .. +100 (buyers).
// Five transparent components, each -1..+1, so a script (and a person) can see WHY:
//   body   net candle pressure   sum(close-open) / sum(high-low)                  (do bodies fill the ranges, and which way)
//   clv    close location        mean((2*close-high-low)/(high-low))              (where bars settle inside their range)
//   struct structure             (higher-high+higher-low) - (lower-high+lower-low) over the window, / (2*(N-1))
//   ema    position vs EMA20     clamp((close-EMA20)/(2*ATR14), -1, 1)            (which side of value price lives on)
//   flow   volume-weighted CLV   buy-share of volume*CLV over the window, *2-1    (only when volume is real: see volumeOk)
// Score = 100 * weighted mean of the available components (body .25, clv .20, struct .20, ema .20, flow .15; flow is dropped and
// the rest renormalised when volume is flat/zero, e.g. OTC). who(): >= +25 buyers, <= -25 sellers, else contested.
// `full` mirrors the oracle's ControlRead: the SAME side held every bar of the last 5 with the weakest bar's volume share >= 70%.
// HONEST: this DESCRIBES who has been in control; it is not a forecast. Whether control persists or exhausts is for a backtest to say.
import type { Candle } from '../types'
import { atr, ema } from './indicators'
import { computeControlRead } from './orderflow'

export const CONTROL_MIN_BARS = 40
const COMP_W = { body: 0.25, clv: 0.2, struct: 0.2, ema: 0.2, flow: 0.15 }

export interface ControlSnap {
  ok: boolean
  score: number // -100..+100
  who: 'buyers' | 'sellers' | 'contested'
  strength: number // |score|
  body: number
  clv: number
  struct: number
  ema: number
  flow: number // NaN when volume is not usable
  volumeOk: boolean
  full: boolean // oracle-style full control (needs real volume)
  fullSide: 'buyers' | 'sellers' | 'none'
  runBars: number // consecutive bars (ending at the latest) whose control side stayed the same
  shifted: boolean // the control side changed within the last 3 bars
}
const EMPTY: ControlSnap = { ok: false, score: 0, who: 'contested', strength: 0, body: 0, clv: 0, struct: 0, ema: 0, flow: NaN, volumeOk: false, full: false, fullSide: 'none', runBars: 0, shifted: false }
const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x))
const whoOf = (s: number): 'buyers' | 'sellers' | 'contested' => (s >= 25 ? 'buyers' : s <= -25 ? 'sellers' : 'contested')

export function scoreAt(c: Candle[], i: number, win: number, e: number[], a: number[], volumeOk: boolean): { score: number; comp: [number, number, number, number, number] } | null {
  if (i - win < 0 || !Number.isFinite(e[i]) || !Number.isFinite(a[i]) || a[i] <= 0) return null
  let sb = 0, sr = 0, sc = 0, nc = 0, st = 0, fb = 0, ft = 0
  for (let k = i - win + 1; k <= i; k++) {
    const rg = c[k].high - c[k].low
    sb += c[k].close - c[k].open
    sr += rg
    if (rg > 0) { const clv = (c[k].close - c[k].low) / rg; sc += 2 * clv - 1; nc++; const v = Number.isFinite(c[k].volume) ? c[k].volume : 0; fb += v * clv; ft += v }
    if (k > i - win + 0) {
      st += (c[k].high > c[k - 1].high ? 1 : c[k].high < c[k - 1].high ? -1 : 0) + (c[k].low > c[k - 1].low ? 1 : c[k].low < c[k - 1].low ? -1 : 0)
    }
  }
  const body = sr > 0 ? clamp(sb / sr, -1, 1) : 0
  const clv = nc ? clamp(sc / nc, -1, 1) : 0
  const struct = clamp(st / (2 * (win - 1)), -1, 1)
  const ema20 = clamp((c[i].close - e[i]) / (2 * a[i]), -1, 1)
  const flow = volumeOk && ft > 0 ? clamp((fb / ft) * 2 - 1, -1, 1) : NaN
  let num = COMP_W.body * body + COMP_W.clv * clv + COMP_W.struct * struct + COMP_W.ema * ema20
  let den = COMP_W.body + COMP_W.clv + COMP_W.struct + COMP_W.ema
  if (Number.isFinite(flow)) { num += COMP_W.flow * flow; den += COMP_W.flow }
  return { score: (100 * num) / den, comp: [body, clv, struct, ema20, flow] }
}

export function readControl(candles: Candle[], window = 10): ControlSnap {
  const win = Math.max(5, Math.min(60, Math.round(window)))
  if (candles.length < CONTROL_MIN_BARS) return { ...EMPTY }
  const c = candles.slice(-400)
  const close = c.map((x) => x.close)
  const e = ema(close, 20)
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), close, 14)
  const tail = c.slice(-60).map((x) => (Number.isFinite(x.volume) ? x.volume : 0))
  const mean = tail.reduce((s, v) => s + v, 0) / tail.length
  const sd = Math.sqrt(tail.reduce((s, v) => s + (v - mean) * (v - mean), 0) / tail.length)
  const volumeOk = tail.filter((v) => v > 0).length >= tail.length * 0.8 && sd > 0
  const last = c.length - 1
  const cur = scoreAt(c, last, win, e, a, volumeOk)
  if (!cur) return { ...EMPTY, volumeOk }
  const who = whoOf(cur.score)
  let run = 1
  let shifted = false
  for (let k = 1; k <= 30; k++) {
    const p = scoreAt(c, last - k, win, e, a, volumeOk)
    if (!p) break
    if (whoOf(p.score) === who) { if (run === k) run++ } else if (k <= 3) shifted = true
  }
  let full = false
  let fullSide: 'buyers' | 'sellers' | 'none' = 'none'
  if (volumeOk) {
    const cr = computeControlRead(c)
    full = cr.fullControl
    fullSide = cr.direction === 'buy' ? 'buyers' : cr.direction === 'sell' ? 'sellers' : 'none'
  }
  return { ok: true, score: cur.score, who, strength: Math.abs(cur.score), body: cur.comp[0], clv: cur.comp[1], struct: cur.comp[2], ema: cur.comp[3], flow: cur.comp[4], volumeOk, full, fullSide, runBars: run, shifted }
}
