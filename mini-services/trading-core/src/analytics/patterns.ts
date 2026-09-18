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

const DETECTORS: Detector[] = [
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

/** Scan the last `lookback` candles; every detector fires on each bar end. */
export function detectPatterns(candles: Candle[], lookback = 8): PatternHit[] {
  const hits: PatternHit[] = []
  const start = Math.max(12, candles.length - lookback)
  for (let end = start + 1; end <= candles.length; end++) {
    const window = candles.slice(0, end)
    const barsAgo = candles.length - end
    for (const fn of DETECTORS) {
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
