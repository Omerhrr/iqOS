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
  // dedupe by name keeping most recent
  const seen = new Set<string>()
  const out: PatternHit[] = []
  for (const h of hits) {
    if (!seen.has(h.name)) {
      seen.add(h.name)
      out.push(h)
    }
  }
  return out.sort((a, b) => a.barsAgo - b.barsAgo || b.reliability - a.reliability)
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
