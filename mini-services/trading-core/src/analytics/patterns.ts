// IQAIR//OS - Candlestick pattern recognition
// Scans the tail of a candle series and reports hits with direction + reliability.
import type { Candle, PatternHit } from '../types'

const body = (c: Candle) => Math.abs(c.close - c.open)
const range = (c: Candle) => Math.max(c.high - c.low, 1e-12)
const upperWick = (c: Candle) => c.high - Math.max(c.open, c.close)
const lowerWick = (c: Candle) => Math.min(c.open, c.close) - c.low
const isBull = (c: Candle) => c.close > c.open
const isBear = (c: Candle) => c.close < c.open
const avgBody = (cs: Candle[]) => cs.reduce((a, c) => a + body(c), 0) / Math.max(cs.length, 1)

type Detector = (w: Candle[]) => PatternHit | null

const doji: Detector = (w) => {
  const c = w[w.length - 1]
  if (body(c) <= range(c) * 0.08)
    return { name: 'Doji', direction: 'neutral', reliability: 1, barsAgo: 0, note: 'Indecision - open ≈ close' }
  return null
}

const hammer: Detector = (w) => {
  const c = w[w.length - 1]
  const prev = w[w.length - 2]
  if (
    lowerWick(c) >= body(c) * 2 &&
    upperWick(c) <= body(c) * 0.6 &&
    body(c) <= range(c) * 0.35 &&
    prev && isBear(prev)
  )
    return { name: 'Hammer', direction: 'bullish', reliability: 2, barsAgo: 0, note: 'Long lower wick after decline' }
  return null
}

const invertedHammer: Detector = (w) => {
  const c = w[w.length - 1]
  const prev = w[w.length - 2]
  if (upperWick(c) >= body(c) * 2 && lowerWick(c) <= body(c) * 0.6 && body(c) <= range(c) * 0.35 && prev && isBear(prev))
    return { name: 'Inverted Hammer', direction: 'bullish', reliability: 1, barsAgo: 0, note: 'Reversal attempt after decline' }
  return null
}

const shootingStar: Detector = (w) => {
  const c = w[w.length - 1]
  const prev = w[w.length - 2]
  if (upperWick(c) >= body(c) * 2 && lowerWick(c) <= body(c) * 0.6 && body(c) <= range(c) * 0.35 && prev && isBull(prev))
    return { name: 'Shooting Star', direction: 'bearish', reliability: 2, barsAgo: 0, note: 'Long upper wick after rally' }
  return null
}

const hangingMan: Detector = (w) => {
  const c = w[w.length - 1]
  const prev = w[w.length - 2]
  if (lowerWick(c) >= body(c) * 2 && upperWick(c) <= body(c) * 0.6 && prev && isBull(prev))
    return { name: 'Hanging Man', direction: 'bearish', reliability: 1, barsAgo: 0, note: 'Distribution wick after rally' }
  return null
}

const bullishEngulfing: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBull(c) && isBear(p) && c.close >= p.open && c.open <= p.close && body(c) > body(p) * 1.05)
    return { name: 'Bullish Engulfing', direction: 'bullish', reliability: 3, barsAgo: 0, note: 'Buyers engulf prior bearish bar' }
  return null
}

const bearishEngulfing: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBear(c) && isBull(p) && c.close <= p.open && c.open >= p.close && body(c) > body(p) * 1.05)
    return { name: 'Bearish Engulfing', direction: 'bearish', reliability: 3, barsAgo: 0, note: 'Sellers engulf prior bullish bar' }
  return null
}

const morningStar: Detector = (w) => {
  const c = w[w.length - 1] // bull
  const m = w[w.length - 2] // small
  const p = w[w.length - 3] // bear
  const ab = avgBody(w.slice(-10))
  if (isBear(p) && body(m) < ab * 0.5 && isBull(c) && c.close > (p.open + p.close) / 2)
    return { name: 'Morning Star', direction: 'bullish', reliability: 3, barsAgo: 2, note: '3-bar bullish reversal' }
  return null
}

const eveningStar: Detector = (w) => {
  const c = w[w.length - 1] // bear
  const m = w[w.length - 2]
  const p = w[w.length - 3] // bull
  const ab = avgBody(w.slice(-10))
  if (isBull(p) && body(m) < ab * 0.5 && isBear(c) && c.close < (p.open + p.close) / 2)
    return { name: 'Evening Star', direction: 'bearish', reliability: 3, barsAgo: 2, note: '3-bar bearish reversal' }
  return null
}

const threeWhiteSoldiers: Detector = (w) => {
  const [a, b, c] = w.slice(-3)
  const ab = avgBody(w.slice(-12))
  if (isBull(a) && isBull(b) && isBull(c) && b.close > a.close && c.close > b.close && body(a) > ab * 0.7 && body(b) > ab * 0.7 && body(c) > ab * 0.7)
    return { name: 'Three White Soldiers', direction: 'bullish', reliability: 3, barsAgo: 2, note: 'Strong bullish continuation' }
  return null
}

const threeBlackCrows: Detector = (w) => {
  const [a, b, c] = w.slice(-3)
  const ab = avgBody(w.slice(-12))
  if (isBear(a) && isBear(b) && isBear(c) && b.close < a.close && c.close < b.close && body(a) > ab * 0.7 && body(b) > ab * 0.7 && body(c) > ab * 0.7)
    return { name: 'Three Black Crows', direction: 'bearish', reliability: 3, barsAgo: 2, note: 'Strong bearish continuation' }
  return null
}

const piercingLine: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBear(p) && isBull(c) && c.open < p.close && c.close > (p.open + p.close) / 2 && c.close < p.open)
    return { name: 'Piercing Line', direction: 'bullish', reliability: 2, barsAgo: 0, note: 'Bullish gap-reversal' }
  return null
}

const darkCloudCover: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBull(p) && isBear(c) && c.open > p.close && c.close < (p.open + p.close) / 2 && c.close > p.open)
    return { name: 'Dark Cloud Cover', direction: 'bearish', reliability: 2, barsAgo: 0, note: 'Bearish gap-reversal' }
  return null
}

const tweezers: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  const tol = range(p) * 0.1
  if (Math.abs(c.low - p.low) <= tol && isBull(c) && isBear(p))
    return { name: 'Tweezer Bottom', direction: 'bullish', reliability: 2, barsAgo: 0, note: 'Matched lows - support hold' }
  if (Math.abs(c.high - p.high) <= tol && isBear(c) && isBull(p))
    return { name: 'Tweezer Top', direction: 'bearish', reliability: 2, barsAgo: 0, note: 'Matched highs - resistance hold' }
  return null
}

const marubozu: Detector = (w) => {
  const c = w[w.length - 1]
  if (body(c) >= range(c) * 0.92 && body(c) > 0)
    return {
      name: isBull(c) ? 'Bullish Marubozu' : 'Bearish Marubozu',
      direction: isBull(c) ? 'bullish' : 'bearish',
      reliability: 2,
      barsAgo: 0,
      note: 'Full-body conviction bar',
    }
  return null
}

const insideBar: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (c.high <= p.high && c.low >= p.low)
    return { name: 'Inside Bar', direction: 'neutral', reliability: 1, barsAgo: 0, note: 'Compression - breakout pending' }
  return null
}

const outsideBar: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (c.high > p.high && c.low < p.low) {
    const dir: 'bullish' | 'bearish' = isBull(c) ? 'bullish' : 'bearish'
    return { name: isBull(c) ? 'Bullish Outside Bar' : 'Bearish Outside Bar', direction: dir, reliability: 2, barsAgo: 0, note: 'Range expansion sweep' }
  }
  return null
}

let DETECTORS_CACHE: Detector[] | null = null
const allDetectors = (): Detector[] => {
  if (!DETECTORS_CACHE) {
    DETECTORS_CACHE = [
      ...DETECTORS_EXT,
      ...DETECTORS_EXT2,
      doji,
  hammer,
  invertedHammer,
  shootingStar,
  hangingMan,
  bullishEngulfing,
  bearishEngulfing,
  morningStar,
  eveningStar,
  threeWhiteSoldiers,
  threeBlackCrows,
  piercingLine,
  darkCloudCover,
  tweezers,
  marubozu,
  insideBar,
  outsideBar,
  ]
  }
  return DETECTORS_CACHE
}

/** Scan the last `lookback` candles; every detector fires on each bar end. */
export function detectPatterns(candles: Candle[], lookback = 8): PatternHit[] {
  const hits: PatternHit[] = []
  const start = Math.max(12, candles.length - lookback)
  for (let end = start + 1; end <= candles.length; end++) {
    const window = candles.slice(0, end)
    const barsAgo = candles.length - end
    for (const fn of allDetectors()) {
      try {
        const hit = fn(window)
        if (hit) hits.push({ ...hit, barsAgo })
      } catch {
        // detector needs more history - skip
      }
    }
  }
  // dedupe by name keeping the MOST RECENT occurrence - AUDIT FIX (Task 58,
  // P2): the old Set-based "first wins" loop kept the OLDEST duplicate
  // (hits are pushed oldest-first), so a Hammer that re-fired 1 bar ago was
  // reported/stored with barsAgo=6 and patternBias weighted it at 1/7
  // instead of 1/2. Order-independent: the smallest barsAgo wins.
  const byName = new Map<string, PatternHit>()
  for (const h of hits) {
    const cur = byName.get(h.name)
    if (!cur || h.barsAgo < cur.barsAgo) byName.set(h.name, h)
  }
  return [...byName.values()].sort((a, b) => a.barsAgo - b.barsAgo || b.reliability - a.reliability)
}

/** Net pattern bias: bullish weight minus bearish weight (weighted by recency + reliability). */
export function patternBias(hits: PatternHit[]): number {
  let score = 0
  for (const h of hits) {
    const recency = 1 / (1 + h.barsAgo)
    const w = h.reliability * recency
    if (h.direction === 'bullish') score += w
    else if (h.direction === 'bearish') score -= w
  }
  return Math.max(-6, Math.min(6, score))
}

// ============================================================
// Phase 2 - extended candlestick library (18 more detectors)
// ============================================================

const bullishHarami: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBear(p) && isBull(c) && c.open >= p.close && c.close <= p.open && body(c) < body(p) * 0.6)
    return { name: 'Bullish Harami', direction: 'bullish', reliability: 2, barsAgo: 0, note: 'Small bull bar inside big bear bar' }
  return null
}

const bearishHarami: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBull(p) && isBear(c) && c.open <= p.close && c.close >= p.open && body(c) < body(p) * 0.6)
    return { name: 'Bearish Harami', direction: 'bearish', reliability: 2, barsAgo: 0, note: 'Small bear bar inside big bull bar' }
  return null
}

const haramiCross: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (body(p) > range(p) * 0.7 && body(c) <= range(c) * 0.1 && c.high <= p.high && c.low >= p.low) {
    const dir: 'bullish' | 'bearish' = isBear(p) ? 'bullish' : 'bearish'
    return { name: 'Harami Cross', direction: dir, reliability: 2, barsAgo: 0, note: 'Doji inside large body - reversal warning' }
  }
  return null
}

const threeInsideUp: Detector = (w) => {
  const [p, m, c] = w.slice(-3)
  if (isBear(p) && isBull(m) && m.open >= p.close && m.close <= p.open && isBull(c) && c.close > p.open)
    return { name: 'Three Inside Up', direction: 'bullish', reliability: 3, barsAgo: 2, note: 'Harami confirmed by breakout' }
  return null
}

const threeInsideDown: Detector = (w) => {
  const [p, m, c] = w.slice(-3)
  if (isBull(p) && isBear(m) && m.open <= p.close && m.close >= p.open && isBear(c) && c.close < p.open)
    return { name: 'Three Inside Down', direction: 'bearish', reliability: 3, barsAgo: 2, note: 'Bear harami confirmed by breakdown' }
  return null
}

const threeOutsideUp: Detector = (w) => {
  const [p, m, c] = w.slice(-3)
  if (isBear(p) && isBull(m) && m.close >= p.open && m.open <= p.close && isBull(c) && c.close > m.close)
    return { name: 'Three Outside Up', direction: 'bullish', reliability: 3, barsAgo: 2, note: 'Engulfing + confirmation close' }
  return null
}

const threeOutsideDown: Detector = (w) => {
  const [p, m, c] = w.slice(-3)
  if (isBull(p) && isBear(m) && m.close <= p.open && m.open >= p.close && isBear(c) && c.close < m.close)
    return { name: 'Three Outside Down', direction: 'bearish', reliability: 3, barsAgo: 2, note: 'Bear engulfing + confirmation' }
  return null
}

const morningDojiStar: Detector = (w) => {
  const [p, m, c] = w.slice(-3)
  if (isBear(p) && body(p) > range(p) * 0.6 && body(m) <= range(m) * 0.1 && isBull(c) && c.close > (p.open + p.close) / 2)
    return { name: 'Morning Doji Star', direction: 'bullish', reliability: 3, barsAgo: 2, note: 'Doji reversal gap - strong bottom' }
  return null
}

const eveningDojiStar: Detector = (w) => {
  const [p, m, c] = w.slice(-3)
  if (isBull(p) && body(p) > range(p) * 0.6 && body(m) <= range(m) * 0.1 && isBear(c) && c.close < (p.open + p.close) / 2)
    return { name: 'Evening Doji Star', direction: 'bearish', reliability: 3, barsAgo: 2, note: 'Doji reversal gap - strong top' }
  return null
}

const risingThreeMethods: Detector = (w) => {
  const s = w.slice(-5)
  if (s.length < 5) return null
  const [big, a, b, c2, last] = s
  if (!isBull(big) || body(big) < avgBody(w.slice(-14)) * 1.2) return null
  const inside = [a, b, c2].every((k) => k.high <= big.high * 1.001 && k.low >= big.low * 0.999)
  if (inside && isBull(last) && last.close > big.close)
    return { name: 'Rising Three Methods', direction: 'bullish', reliability: 3, barsAgo: 4, note: 'Bull flag consolidation - continuation' }
  return null
}

const fallingThreeMethods: Detector = (w) => {
  const s = w.slice(-5)
  if (s.length < 5) return null
  const [big, a, b, c2, last] = s
  if (!isBear(big) || body(big) < avgBody(w.slice(-14)) * 1.2) return null
  const inside = [a, b, c2].every((k) => k.high <= big.high * 1.001 && k.low >= big.low * 0.999)
  if (inside && isBear(last) && last.close < big.close)
    return { name: 'Falling Three Methods', direction: 'bearish', reliability: 3, barsAgo: 4, note: 'Bear flag consolidation - continuation' }
  return null
}

const homingPigeon: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBear(p) && isBull(c) && c.open <= p.close && c.close >= p.open - 1e-9 && c.close <= p.open && body(c) < body(p) * 0.5)
    return { name: 'Homing Pigeon', direction: 'bullish', reliability: 2, barsAgo: 0, note: 'Small bull inside bear - softening sellers' }
  return null
}

const matchingLow: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBear(p) && isBear(c) && Math.abs(c.close - p.close) <= range(p) * 0.03 && body(p) > body(c))
    return { name: 'Matching Low', direction: 'bullish', reliability: 1, barsAgo: 0, note: 'Twin lows - support test' }
  return null
}

const stickSandwich: Detector = (w) => {
  const [a, b, c] = w.slice(-3)
  if (isBear(a) && isBull(b) && isBear(c) && Math.abs(a.close - c.close) <= range(a) * 0.03)
    return { name: 'Stick Sandwich', direction: 'bullish', reliability: 2, barsAgo: 2, note: 'Twin bear closes sandwich a bull bar' }
  return null
}

const separatingLines: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBear(p) && isBull(c) && Math.abs(c.open - p.open) <= range(p) * 0.05)
    return { name: 'Bullish Separating Lines', direction: 'bullish', reliability: 2, barsAgo: 0, note: 'Same open, opposite close - buyers took over' }
  if (isBull(p) && isBear(c) && Math.abs(c.open - p.open) <= range(p) * 0.05)
    return { name: 'Bearish Separating Lines', direction: 'bearish', reliability: 2, barsAgo: 0, note: 'Same open, opposite close - sellers took over' }
  return null
}

const abandonedBaby: Detector = (w) => {
  const [p, m, c] = w.slice(-3)
  if (isBear(p) && body(m) <= range(m) * 0.1 && m.low > p.high && isBull(c) && c.close > (p.open + p.close) / 2)
    return { name: 'Abandoned Baby (Bull)', direction: 'bullish', reliability: 3, barsAgo: 2, note: 'Island doji below - rare strong reversal' }
  if (isBull(p) && body(m) <= range(m) * 0.1 && m.high < p.low && isBear(c) && c.close < (p.open + p.close) / 2)
    return { name: 'Abandoned Baby (Bear)', direction: 'bearish', reliability: 3, barsAgo: 2, note: 'Island doji above - rare strong reversal' }
  return null
}

const kicker: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBear(p) && isBull(c) && c.open >= p.open && c.close > p.high && body(c) > body(p))
    return { name: 'Bullish Kicker', direction: 'bullish', reliability: 3, barsAgo: 0, note: 'Gap-up ignition from bear body' }
  if (isBull(p) && isBear(c) && c.open <= p.open && c.close < p.low && body(c) > body(p))
    return { name: 'Bearish Kicker', direction: 'bearish', reliability: 3, barsAgo: 0, note: 'Gap-down collapse from bull body' }
  return null
}

const spinningTop: Detector = (w) => {
  const c = w[w.length - 1]
  const ab = avgBody(w.slice(-10))
  if (body(c) <= ab * 0.4 && upperWick(c) >= body(c) && lowerWick(c) >= body(c) && body(c) > range(c) * 0.05)
    return { name: 'Spinning Top', direction: 'neutral', reliability: 1, barsAgo: 0, note: 'Balanced indecision - pause in trend' }
  return null
}

const highWave: Detector = (w) => {
  const c = w[w.length - 1]
  const ab = avgBody(w.slice(-10))
  if (body(c) <= ab * 0.25 && range(c) >= ab * 2.2)
    return { name: 'High Wave', direction: 'neutral', reliability: 1, barsAgo: 0, note: 'Long wicks tiny body - volatility climax' }
  return null
}

const DETECTORS_EXT: Detector[] = [
  bullishHarami,
  bearishHarami,
  haramiCross,
  threeInsideUp,
  threeInsideDown,
  threeOutsideUp,
  threeOutsideDown,
  morningDojiStar,
  eveningDojiStar,
  risingThreeMethods,
  fallingThreeMethods,
  homingPigeon,
  matchingLow,
  stickSandwich,
  separatingLines,
  abandonedBaby,
  kicker,
  spinningTop,
  highWave,
]

// ============================================================
// Phase 3 - rest of the classic (Nison/TA-Lib) candlestick catalog,
// so the recognizer and the AI Lab's manual pattern picker cover every
// named pattern there is, not just the common ~36.
// ============================================================

const dragonflyDoji: Detector = (w) => {
  const c = w[w.length - 1]
  if (body(c) <= range(c) * 0.08 && lowerWick(c) >= range(c) * 0.6 && upperWick(c) <= range(c) * 0.08)
    return { name: 'Dragonfly Doji', direction: 'bullish', reliability: 2, barsAgo: 0, note: 'Doji with long lower wick - bullish reversal signal' }
  return null
}

const gravestoneDoji: Detector = (w) => {
  const c = w[w.length - 1]
  if (body(c) <= range(c) * 0.08 && upperWick(c) >= range(c) * 0.6 && lowerWick(c) <= range(c) * 0.08)
    return { name: 'Gravestone Doji', direction: 'bearish', reliability: 2, barsAgo: 0, note: 'Doji with long upper wick - bearish reversal signal' }
  return null
}

const longLeggedDoji: Detector = (w) => {
  const c = w[w.length - 1]
  if (body(c) <= range(c) * 0.08 && upperWick(c) >= range(c) * 0.3 && lowerWick(c) >= range(c) * 0.3)
    return { name: 'Long-Legged Doji', direction: 'neutral', reliability: 1, barsAgo: 0, note: 'Long wicks both sides - high indecision' }
  return null
}

const beltHold: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBull(c) && lowerWick(c) <= range(c) * 0.05 && body(c) >= range(c) * 0.7 && p && isBear(p))
    return { name: 'Bullish Belt Hold', direction: 'bullish', reliability: 2, barsAgo: 0, note: 'Opens at low, strong close - reversal candle' }
  if (isBear(c) && upperWick(c) <= range(c) * 0.05 && body(c) >= range(c) * 0.7 && p && isBull(p))
    return { name: 'Bearish Belt Hold', direction: 'bearish', reliability: 2, barsAgo: 0, note: 'Opens at high, strong close down - reversal candle' }
  return null
}

const threeLineStrike: Detector = (w) => {
  const s = w.slice(-4)
  if (s.length < 4) return null
  const [a, b, c, d] = s
  if (isBull(a) && isBull(b) && isBull(c) && b.close > a.close && c.close > b.close && isBear(d) && d.open > c.close && d.close < a.open)
    return { name: 'Bullish Three Line Strike', direction: 'bullish', reliability: 2, barsAgo: 3, note: 'Pullback bar engulfs 3 prior bulls - often continuation' }
  if (isBear(a) && isBear(b) && isBear(c) && b.close < a.close && c.close < b.close && isBull(d) && d.open < c.close && d.close > a.open)
    return { name: 'Bearish Three Line Strike', direction: 'bearish', reliability: 2, barsAgo: 3, note: 'Pullback bar engulfs 3 prior bears - often continuation' }
  return null
}

const twoCrows: Detector = (w) => {
  const [a, b, c] = w.slice(-3)
  if (isBull(a) && body(a) > range(a) * 0.5 && isBear(b) && b.open > a.close && isBear(c) && c.open < b.open && c.open > b.close && c.close < a.open && c.close > b.close)
    return { name: 'Two Crows', direction: 'bearish', reliability: 2, barsAgo: 2, note: 'Gap up then two bear closes back inside - weakening rally' }
  return null
}

const upsideGapTwoCrows: Detector = (w) => {
  const [a, b, c] = w.slice(-3)
  if (isBull(a) && isBear(b) && b.open > a.close && b.close > a.close && isBear(c) && c.open > b.open && c.close < b.close && c.close > a.close)
    return { name: 'Upside Gap Two Crows', direction: 'bearish', reliability: 2, barsAgo: 2, note: 'Gap up stalls under two bear bars' }
  return null
}

const advanceBlock: Detector = (w) => {
  const [a, b, c] = w.slice(-3)
  if (isBull(a) && isBull(b) && isBull(c) && b.close > a.close && c.close > b.close && body(b) < body(a) && body(c) < body(b) && upperWick(b) > body(b) * 0.3 && upperWick(c) > body(c) * 0.3)
    return { name: 'Advance Block', direction: 'bearish', reliability: 1, barsAgo: 2, note: 'Weakening bullish momentum - shrinking bodies, growing wicks' }
  return null
}

const deliberation: Detector = (w) => {
  const [a, b, c] = w.slice(-3)
  const ab = avgBody(w.slice(-12))
  if (isBull(a) && isBull(b) && isBull(c) && body(a) > ab * 0.8 && body(b) > ab * 0.8 && body(c) < body(b) * 0.5 && c.open > b.close - body(b) * 0.2)
    return { name: 'Deliberation', direction: 'bearish', reliability: 1, barsAgo: 2, note: 'Third bar stalls small near highs - exhaustion' }
  return null
}

const concealingBabySwallow: Detector = (w) => {
  const s = w.slice(-4)
  if (s.length < 4) return null
  const [a, b, c, d] = s
  if (
    isBear(a) &&
    body(a) >= range(a) * 0.85 &&
    isBear(b) &&
    body(b) >= range(b) * 0.85 &&
    isBear(c) &&
    c.open < b.close &&
    c.high > b.close &&
    isBear(d) &&
    d.open > c.high &&
    d.close < c.low
  )
    return { name: 'Concealing Baby Swallow', direction: 'bearish', reliability: 2, barsAgo: 3, note: 'Rare 4-bar bearish continuation' }
  return null
}

const ladderBottom: Detector = (w) => {
  const s = w.slice(-5)
  if (s.length < 5) return null
  const [a, b, c, d, e] = s
  if (isBear(a) && isBear(b) && isBear(c) && b.close < a.close && c.close < b.close && isBear(d) && upperWick(d) > body(d) && isBull(e) && e.open > d.high)
    return { name: 'Ladder Bottom', direction: 'bullish', reliability: 2, barsAgo: 4, note: '5-bar bullish reversal after decline' }
  return null
}

const triStar: Detector = (w) => {
  const [a, b, c] = w.slice(-3)
  const isDojiBar = (k: Candle) => body(k) <= range(k) * 0.08
  if (isDojiBar(a) && isDojiBar(b) && isDojiBar(c)) {
    if (Math.max(a.open, a.close) > Math.max(b.open, b.close) && Math.max(c.open, c.close) > Math.max(b.open, b.close))
      return { name: 'Bearish Tri-Star', direction: 'bearish', reliability: 2, barsAgo: 2, note: 'Three dojis, middle gapping up - rare top reversal' }
    if (Math.min(a.open, a.close) < Math.min(b.open, b.close) && Math.min(c.open, c.close) < Math.min(b.open, b.close))
      return { name: 'Bullish Tri-Star', direction: 'bullish', reliability: 2, barsAgo: 2, note: 'Three dojis, middle gapping down - rare bottom reversal' }
  }
  return null
}

const uniqueThreeRiverBottom: Detector = (w) => {
  const [a, b, c] = w.slice(-3)
  if (isBear(a) && body(a) > range(a) * 0.6 && isBear(b) && b.high < a.high && b.low < a.low && body(b) < body(a) && isBull(c) && c.open < b.close && c.close < b.close)
    return { name: 'Unique Three River Bottom', direction: 'bullish', reliability: 2, barsAgo: 2, note: 'Rare bottoming pattern - shrinking bear bars' }
  return null
}

const onNeckLine: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBear(p) && isBull(c) && c.open < p.low && Math.abs(c.close - p.low) <= range(p) * 0.05)
    return { name: 'On-Neck Line', direction: 'bearish', reliability: 1, barsAgo: 0, note: 'Weak bounce closes at prior low - downtrend likely continues' }
  return null
}

const inNeckLine: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBear(p) && isBull(c) && c.open < p.low && c.close > p.low && c.close <= p.close + range(p) * 0.05 && c.close < p.open)
    return { name: 'In-Neck Line', direction: 'bearish', reliability: 1, barsAgo: 0, note: 'Bounce closes just above prior close - weak continuation' }
  return null
}

const thrustingLine: Detector = (w) => {
  const c = w[w.length - 1]
  const p = w[w.length - 2]
  if (isBear(p) && isBull(c) && c.open < p.low && c.close > p.close && c.close < (p.open + p.close) / 2)
    return { name: 'Thrusting Line', direction: 'bearish', reliability: 1, barsAgo: 0, note: 'Bounce fails below midpoint - downtrend continuation' }
  return null
}

const sideBySideWhiteLines: Detector = (w) => {
  const [a, b, c] = w.slice(-3)
  if (isBull(b) && isBull(c) && Math.abs(b.open - c.open) <= range(b) * 0.08 && Math.abs(body(b) - body(c)) <= avgBody(w.slice(-10)) * 0.4) {
    if (isBull(a) && b.open > a.close) return { name: 'Bullish Side-by-Side White Lines', direction: 'bullish', reliability: 1, barsAgo: 1, note: 'Two similar white bars after gap up - continuation' }
    if (isBear(a) && b.open < a.close) return { name: 'Bearish Side-by-Side White Lines', direction: 'bearish', reliability: 1, barsAgo: 1, note: 'Two similar white bars after gap down - rare continuation' }
  }
  return null
}

const hikkake: Detector = (w) => {
  const s = w.slice(-3)
  if (s.length < 3) return null
  const [p, inside, c] = s
  if (inside.high <= p.high && inside.low >= p.low) {
    if (c.high > inside.high && c.close > inside.high) return { name: 'Bullish Hikkake', direction: 'bullish', reliability: 1, barsAgo: 0, note: 'False breakdown trapped shorts - inside bar breakout up' }
    if (c.low < inside.low && c.close < inside.low) return { name: 'Bearish Hikkake', direction: 'bearish', reliability: 1, barsAgo: 0, note: 'False breakout trapped longs - inside bar breakdown' }
  }
  return null
}

const breakaway: Detector = (w) => {
  const s = w.slice(-5)
  if (s.length < 5) return null
  const [a, b, c, d, e] = s
  const ab = avgBody(w.slice(-14))
  if (isBear(a) && body(a) > ab * 0.8 && b.open < a.close && c.close < b.close && d.close < c.close && isBull(e) && e.close > b.open && e.close < a.open)
    return { name: 'Bullish Breakaway', direction: 'bullish', reliability: 2, barsAgo: 4, note: '5-bar reversal - rally reclaims mid-range after breakdown' }
  if (isBull(a) && body(a) > ab * 0.8 && b.open > a.close && c.close > b.close && d.close > c.close && isBear(e) && e.close < b.open && e.close > a.open)
    return { name: 'Bearish Breakaway', direction: 'bearish', reliability: 2, barsAgo: 4, note: '5-bar reversal - selloff reclaims mid-range after breakout' }
  return null
}

const DETECTORS_EXT2: Detector[] = [
  dragonflyDoji,
  gravestoneDoji,
  longLeggedDoji,
  beltHold,
  threeLineStrike,
  twoCrows,
  upsideGapTwoCrows,
  advanceBlock,
  deliberation,
  concealingBabySwallow,
  ladderBottom,
  triStar,
  uniqueThreeRiverBottom,
  onNeckLine,
  inNeckLine,
  thrustingLine,
  sideBySideWhiteLines,
  hikkake,
  breakaway,
]

/** Every pattern NAME this file's detectors can produce, in no particular
 * order - the exact strings `detectPatterns()` emits in each `PatternHit.name`
 * (and what a 'candle' custom-strategy signal matches against, case
 * insensitively - see strategies/custom.ts's CandleSignal). Kept here, next
 * to the detectors themselves, as the one list to update when a detector is
 * added, renamed or removed above - every other caller (the AI Lab's manual
 * pattern picker, its validation) reuses this instead of hardcoding its own
 * copy. Some detectors emit one of two names depending on direction
 * (Marubozu, Tweezer, Separating Lines, Kicker, Abandoned Baby) - both
 * variants are listed since either can be the tail-bar hit.
 *
 * Phase 3 added the rest of the classic Nison/TA-Lib catalog (doji
 * sub-types, belt holds, three line strike, crows, block/deliberation,
 * tri-star, river/ladder/swallow rarities, neck/thrusting lines,
 * side-by-side lines, hikkake, breakaway) so this list now covers every
 * named candlestick pattern in common use, not just the ~36 most frequent
 * ones. */
export const CANDLE_PATTERN_NAMES: string[] = [
  'Doji',
  'Hammer',
  'Inverted Hammer',
  'Shooting Star',
  'Hanging Man',
  'Bullish Engulfing',
  'Bearish Engulfing',
  'Morning Star',
  'Evening Star',
  'Three White Soldiers',
  'Three Black Crows',
  'Piercing Line',
  'Dark Cloud Cover',
  'Tweezer Bottom',
  'Tweezer Top',
  'Bullish Marubozu',
  'Bearish Marubozu',
  'Inside Bar',
  'Bullish Outside Bar',
  'Bearish Outside Bar',
  'Bullish Harami',
  'Bearish Harami',
  'Harami Cross',
  'Three Inside Up',
  'Three Inside Down',
  'Three Outside Up',
  'Three Outside Down',
  'Morning Doji Star',
  'Evening Doji Star',
  'Rising Three Methods',
  'Falling Three Methods',
  'Homing Pigeon',
  'Matching Low',
  'Stick Sandwich',
  'Bullish Separating Lines',
  'Bearish Separating Lines',
  'Abandoned Baby (Bull)',
  'Abandoned Baby (Bear)',
  'Bullish Kicker',
  'Bearish Kicker',
  'Spinning Top',
  'High Wave',
  'Dragonfly Doji',
  'Gravestone Doji',
  'Long-Legged Doji',
  'Bullish Belt Hold',
  'Bearish Belt Hold',
  'Bullish Three Line Strike',
  'Bearish Three Line Strike',
  'Two Crows',
  'Upside Gap Two Crows',
  'Advance Block',
  'Deliberation',
  'Concealing Baby Swallow',
  'Ladder Bottom',
  'Bullish Tri-Star',
  'Bearish Tri-Star',
  'Unique Three River Bottom',
  'On-Neck Line',
  'In-Neck Line',
  'Thrusting Line',
  'Bullish Side-by-Side White Lines',
  'Bearish Side-by-Side White Lines',
  'Bullish Hikkake',
  'Bearish Hikkake',
  'Bullish Breakaway',
  'Bearish Breakaway',
]
