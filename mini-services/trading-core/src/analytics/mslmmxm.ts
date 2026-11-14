// IQAIR//OS - Market Maker Model (MMXM) lifecycle reader. Pure, CAUSAL (closed candles up to "now" only).
//
// The template (buy side; the sell model is the mirror image):
//   1. ORIGINAL CONSOLIDATION - a quiet, low-efficiency block of bars (a range).
//   2. SELL-SIDE CURVE - price runs DOWN out of it, through the consolidation low, to a curve extreme (the lowest low of the window). Often the extreme
//      also sweeps a prior low (resting sell stops): reported as `swept`.
//   3. SMART-MONEY REVERSAL - a CLOSE back above the last lower-high of the curve (a market-structure shift).
//   4. BUY-SIDE CURVE - price travels back up toward the original consolidation, whose high is the model's TARGET.
//
// Phases reported: 2 = the curve is done but no reversal yet; 3 = reversal confirmed within the last 5 bars (fresh); 4 = reversal curve running;
// 5 = target reached. Anything else (no consolidation, curve too shallow, a new extreme voiding it) = no model.
//
// Honesty: this is ONE mechanical reading of a discretionary template, fitted to the shape. It is causal (it never uses bars after "now"), but it
// reads the shape off the same candles that were used to define it, so it describes structure; it is not a forecast and has no measured edge.
import type { Candle } from '../types'
import { atr } from './indicators'

export const MMXM_MIN_BARS = 60
const WINDOW = 200
/** consolidation block length (bars), efficiency-ratio ceiling and width ceiling (ATR) */
const CONS_LEN = 14
const CONS_ER = 0.25
const CONS_WIDTH_ATR = 3
/** the curve must break the consolidation low by this much and travel this far from the consolidation midpoint (ATR) */
const BREAK_ATR = 1.5
const LEG_ATR = 4.0
const FRESH_BARS = 5
/** the curve must start soon after the consolidation, be efficient (directional), and the reversal must come soon after the curve extreme; the
 * model ages out when the reversal curve has run this long */
const MAX_CURVE_BARS = 40
const MIN_CURVE_ER = 0.5
const MAX_REVERSAL_WAIT = 25
const MAX_MODEL_AGE = 30

export interface MmxmRead {
  model: 'buy' | 'sell' | 'none'
  /** 0 none, 2 curve done / awaiting reversal, 3 reversal just confirmed, 4 reversal curve running, 5 target reached */
  phase: 0 | 2 | 3 | 4 | 5
  /** consolidation high (buy) / low (sell) */
  target: number
  /** the curve extreme (lowest low for the buy model, highest high for the sell model) */
  invalidation: number
  /** the reversal trigger level (last lower-high of the curve for buy; last higher-low for sell) */
  mss: number
  consolHigh: number
  consolLow: number
  /** 0..1.5: how far from the curve extreme to the target price has travelled */
  progress: number
  sinceMss: number
  sinceExtreme: number
  swept: boolean
}

const NONE: MmxmRead = { model: 'none', phase: 0, target: 0, invalidation: 0, mss: 0, consolHigh: 0, consolLow: 0, progress: 0, sinceMss: 99, sinceExtreme: 99, swept: false }

/** the buy model on the candles as given; the sell model is this run on mirrored prices */
function findBuy(c: Candle[], a: number[]): (MmxmRead & { extremeIdx: number }) | null {
  const n = c.length
  // the curve extreme = lowest low of the last 160 bars (not the first/last 5 bars of the window)
  const from = Math.max(8, n - 160)
  let L = -1
  let lo = Infinity
  for (let i = from; i < n; i++) if (c[i].low <= lo) { lo = c[i].low; L = i }
  if (L < 0 || L < 25) return null
  const A = a[L] > 0 ? a[L] : a[n - 1]
  if (!(A > 0)) return null
  // original consolidation: the latest quiet block that ends before the curve begins
  let cs = -1
  let ce = -1
  for (let e = L - 5; e >= CONS_LEN + 1; e--) {
    const s0 = e - CONS_LEN
    let path = 0
    let hi = -Infinity
    let lw = Infinity
    for (let i = s0 + 1; i <= e; i++) path += Math.abs(c[i].close - c[i - 1].close)
    for (let i = s0; i <= e; i++) { if (c[i].high > hi) hi = c[i].high; if (c[i].low < lw) lw = c[i].low }
    const er = path > 0 ? Math.abs(c[e].close - c[s0].close) / path : 1
    if (er <= CONS_ER && (hi - lw) <= CONS_WIDTH_ATR * A) { cs = s0; ce = e; break }
  }
  if (cs < 0) return null
  let consolHigh = -Infinity
  let consolLow = Infinity
  for (let i = cs; i <= ce; i++) { if (c[i].high > consolHigh) consolHigh = c[i].high; if (c[i].low < consolLow) consolLow = c[i].low }
  const consolMid = (consolHigh + consolLow) / 2
  // sell-side curve: breaks the consolidation low and is a real leg
  if (!(consolLow - lo >= BREAK_ATR * A) || !(consolMid - lo >= LEG_ATR * A)) return null
  // the curve is a quick, directional run: starts within MAX_CURVE_BARS of the consolidation end and covers its distance efficiently
  if (L - ce > MAX_CURVE_BARS) return null
  let curvePath = 0
  for (let i = ce + 1; i <= L; i++) curvePath += Math.abs(c[i].close - c[i - 1].close)
  if (!(curvePath > 0) || Math.abs(c[L].close - c[ce].close) / curvePath < MIN_CURVE_ER) return null
  // last lower-high of the curve: most recent confirmed swing high between the consolidation end and the extreme, else the highest high of the leg's last third
  let lh = -Infinity
  for (let i = L - 1; i > ce + 1 && i >= 2; i--) {
    if (c[i].high > c[i - 1].high && c[i].high >= c[i + 1].high && c[i].high > (c[i - 2]?.high ?? -Infinity)) { lh = c[i].high; break }
  }
  if (!isFinite(lh)) {
    const k0 = Math.max(ce + 1, L - Math.max(3, Math.floor((L - ce) / 3)))
    for (let i = k0; i <= L; i++) if (c[i].high > lh) lh = c[i].high
  }
  // reversal: a close above lh after the extreme
  let mssIdx = -1
  for (let i = L + 1; i < n; i++) if (c[i].close > lh) { mssIdx = i; break }
  // swept: within +-3 bars of the extreme, a wick below the lowest low of the 12 bars before it that closed back above that level
  let swept = false
  for (let i = Math.max(14, L - 3); i <= Math.min(n - 1, L + 3) && !swept; i++) {
    let prior = Infinity
    for (let j = i - 12; j < i; j++) if (c[j].low < prior) prior = c[j].low
    if (c[i].low < prior && c[i].close > prior) swept = true
  }
  const price = c[n - 1].close
  const target = consolHigh
  const progress = target > lo ? Math.max(-1, Math.min(1.5, (price - lo) / (target - lo))) : 0
  const base = { target, invalidation: lo, mss: lh, consolHigh, consolLow, progress, swept, sinceExtreme: n - 1 - L, extremeIdx: L }
  if (mssIdx < 0) {
    // curve must have run its course: the extreme is not the very latest bar and price is at least 0.5 ATR off it, else it is still falling
    if (n - 1 - L < 2 || price - lo < 0.5 * A || n - 1 - L > MAX_REVERSAL_WAIT) return null
    return { model: 'buy', phase: 2, sinceMss: 99, ...base }
  }
  const sinceMss = n - 1 - mssIdx
  // a reversal that took too long after the extreme is a different story; a model that ran this long without reaching the target is stale
  if (mssIdx - L > MAX_REVERSAL_WAIT) return null
  if (price < target && sinceMss > MAX_MODEL_AGE) return null
  if (sinceMss > 2 * MAX_MODEL_AGE) return null // a long-ago target hit is history, not a live model
  if (price >= target) return { model: 'buy', phase: 5, sinceMss, ...base }
  return { model: 'buy', phase: sinceMss <= FRESH_BARS ? 3 : 4, sinceMss, ...base }
}

const mirror = (c: Candle[]): Candle[] => c.map((k) => ({ ...k, open: -k.open, high: -k.low, low: -k.high, close: -k.close }))

export function readMmxm(all: Candle[]): MmxmRead | null {
  if (all.length < MMXM_MIN_BARS) return null
  const c = all.length > WINDOW ? all.slice(-WINDOW) : all
  const a = atr(c.map((k) => k.high), c.map((k) => k.low), c.map((k) => k.close), 14)
  const buy = findBuy(c, a)
  const mc = mirror(c)
  const sellRaw = findBuy(mc, atr(mc.map((k) => k.high), mc.map((k) => k.low), mc.map((k) => k.close), 14))
  const sell: (MmxmRead & { extremeIdx: number }) | null = sellRaw
    ? { ...sellRaw, model: 'sell', target: -sellRaw.target, invalidation: -sellRaw.invalidation, mss: -sellRaw.mss, consolHigh: -sellRaw.consolLow, consolLow: -sellRaw.consolHigh }
    : null
  const pick = buy && sell ? (buy.extremeIdx >= sell.extremeIdx ? buy : sell) : (buy ?? sell)
  if (!pick) return { ...NONE }
  const { extremeIdx, ...rest } = pick
  void extremeIdx
  return rest
}
