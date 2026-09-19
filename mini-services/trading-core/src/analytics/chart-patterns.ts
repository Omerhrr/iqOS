// IQAIR//OS - Chart pattern recognition
// Pivot-based structural detection: double tops/bottoms, head & shoulders,
// triangles, wedges, flags and ranges. Works on the last ~120 candles.

import type { Candle, ChartPatternHit } from '../types'

interface Pivot {
  idx: number
  price: number
  kind: 'H' | 'L'
}

/** Fractal pivots with asymmetric confirmation (2 bars each side). */
function findPivots(candles: Candle[], left = 3, right = 3): Pivot[] {
  const pivots: Pivot[] = []
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true
    let isLow = true
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue
      if (candles[j].high >= candles[i].high) isHigh = false
      if (candles[j].low <= candles[i].low) isLow = false
    }
    if (isHigh) pivots.push({ idx: i, price: candles[i].high, kind: 'H' })
    else if (isLow) pivots.push({ idx: i, price: candles[i].low, kind: 'L' })
  }
  return pivots
}

const tol = (a: number, b: number, pct = 0.012) => Math.abs(a - b) <= Math.abs(a) * pct

/** Scan the tail of a candle series for structural chart patterns. */
export function detectChartPatterns(candles: Candle[]): ChartPatternHit[] {
  if (candles.length < 60) return []
  const n = candles.length
  const scanStart = Math.max(0, n - 140)
  const window = candles.slice(scanStart)
  const pivots = findPivots(window)
  const out: ChartPatternHit[] = []

  const last = window[window.length - 1]
  const highs = pivots.filter((p) => p.kind === 'H')
  const lows = pivots.filter((p) => p.kind === 'L')

  // ---- Double Top ----
  if (highs.length >= 2) {
    const h1 = highs[highs.length - 2]
    const h2 = highs[highs.length - 1]
    const betweenLow = lows.filter((l) => l.idx > h1.idx && l.idx < h2.idx)
    const neckline = betweenLow.length ? Math.max(...betweenLow.map((l) => l.price)) : NaN
    if (Number.isFinite(neckline) && tol(h1.price, h2.price, 0.02) && h2.idx - h1.idx >= 8 && last.close < neckline) {
      out.push({
        name: 'Double Top',
        direction: 'bearish',
        startIndex: scanStart + h1.idx,
        endIndex: scanStart + h2.idx,
        confidence: Math.min(0.95, 0.6 + Math.abs(h1.price - h2.price) * -0 + (last.close < neckline ? 0.25 : 0)),
        note: 'Twin peaks broken the neckline - distribution complete',
      })
    }
  }

  // ---- Double Bottom ----
  if (lows.length >= 2) {
    const l1 = lows[lows.length - 2]
    const l2 = lows[lows.length - 1]
    const betweenHigh = highs.filter((h) => h.idx > l1.idx && h.idx < l2.idx)
    const neckline = betweenHigh.length ? Math.min(...betweenHigh.map((h) => h.price)) : NaN
    if (Number.isFinite(neckline) && tol(l1.price, l2.price, 0.02) && l2.idx - l1.idx >= 8 && last.close > neckline) {
      out.push({
        name: 'Double Bottom',
        direction: 'bullish',
        startIndex: scanStart + l1.idx,
        endIndex: scanStart + l2.idx,
        confidence: 0.85,
        note: 'Twin troughs reclaimed the neckline - accumulation',
      })
    }
  }

  // ---- Head & Shoulders ----
  if (highs.length >= 3 && lows.length >= 2) {
    const ls = lows.filter((l) => l.idx < highs[highs.length - 3].idx || true)
    const [p1, p2, p3] = highs.slice(-3)
    const shoulderLows = lows.filter((l) => l.idx < p2.idx && l.idx > (p1.idx > 4 ? p1.idx - 20 : 0))
    if (p2.price > p1.price * 1.01 && p2.price > p3.price * 1.01 && tol(p1.price, p3.price, 0.03) && shoulderLows.length >= 2) {
      const neck = (shoulderLows[0].price + shoulderLows[shoulderLows.length - 1].price) / 2
      if (last.close < neck) {
        out.push({
          name: 'Head & Shoulders',
          direction: 'bearish',
          startIndex: scanStart + p1.idx,
          endIndex: scanStart + p3.idx,
          confidence: 0.88,
          note: 'Classic reversal top - neckline lost',
        })
      }
    }
    void ls
  }

  // ---- Inverse H&S ----
  if (lows.length >= 3 && highs.length >= 2) {
    const [p1, p2, p3] = lows.slice(-3)
    const shoulderHighs = highs.filter((h) => h.idx < p2.idx)
    if (p2.price < p1.price * 0.99 && p2.price < p3.price * 0.99 && tol(p1.price, p3.price, 0.03) && shoulderHighs.length >= 2) {
      const neck = (shoulderHighs[0].price + shoulderHighs[shoulderHighs.length - 1].price) / 2
      if (last.close > neck) {
        out.push({
          name: 'Inverse H&S',
          direction: 'bullish',
          startIndex: scanStart + p1.idx,
          endIndex: scanStart + p3.idx,
          confidence: 0.88,
          note: 'Inverted head pattern - neckline reclaimed',
        })
      }
    }
  }

  // ---- Triangles / Wedges: regress last 3 highs + 3 lows ----
  if (highs.length >= 3 && lows.length >= 3) {
    const H = highs.slice(-3)
    const L = lows.slice(-3)
    const slopeH = (H[2].price - H[0].price) / Math.max(H[2].idx - H[0].idx, 1)
    const slopeL = (L[2].price - L[0].price) / Math.max(L[2].idx - L[0].idx, 1)
    const relH = slopeH / last.close
    const relL = slopeL / last.close
    const span = (H[2].idx - H[0].idx) >= 10
    if (!span) return out

    if (Math.abs(relH) < 0.0004 && relL > 0.0004) {
      out.push({
        name: 'Ascending Triangle',
        direction: 'bullish',
        startIndex: scanStart + H[0].idx,
        endIndex: scanStart + L[2].idx,
        confidence: 0.75,
        note: 'Flat resistance + rising lows - breakout pressure',
      })
    } else if (Math.abs(relL) < 0.0004 && relH < -0.0004) {
      out.push({
        name: 'Descending Triangle',
        direction: 'bearish',
        startIndex: scanStart + H[0].idx,
        endIndex: scanStart + L[2].idx,
        confidence: 0.75,
        note: 'Flat support + falling highs - breakdown pressure',
      })
    } else if (relH < -0.0002 && relL > 0.0002) {
      out.push({
        name: 'Symmetrical Triangle',
        direction: 'neutral',
        startIndex: scanStart + H[0].idx,
        endIndex: scanStart + L[2].idx,
        confidence: 0.65,
        note: 'Converging range - coiled spring, await break',
      })
    } else if (relH > 0.0004 && relL > 0.0006 && relL > relH * 1.15) {
      out.push({
        name: 'Rising Wedge',
        direction: 'bearish',
        startIndex: scanStart + H[0].idx,
        endIndex: scanStart + L[2].idx,
        confidence: 0.7,
        note: 'Rising but narrowing - momentum fading',
      })
    } else if (relH < -0.0004 && relL < -0.0006 && relH < relL * 1.15) {
      out.push({
        name: 'Falling Wedge',
        direction: 'bullish',
        startIndex: scanStart + H[0].idx,
        endIndex: scanStart + L[2].idx,
        confidence: 0.7,
        note: 'Falling but narrowing - sellers exhausting',
      })
    }
  }

  // ---- Flag / pole: strong impulse then shallow counter drift ----
  if (window.length >= 40) {
    const ret20 = (last.close - window[window.length - 21].close) / window[window.length - 21].close
    const ret5 = (last.close - window[window.length - 6].close) / window[window.length - 6].close
    if (ret20 > 0.015 && Math.abs(ret5) < ret20 * 0.35 && ret5 < 0) {
      out.push({
        name: 'Bull Flag',
        direction: 'bullish',
        startIndex: n - 21,
        endIndex: n - 1,
        confidence: 0.72,
        note: 'Strong pole + shallow pullback - continuation setup',
      })
    } else if (ret20 < -0.015 && Math.abs(ret5) < Math.abs(ret20) * 0.35 && ret5 > 0) {
      out.push({
        name: 'Bear Flag',
        direction: 'bearish',
        startIndex: n - 21,
        endIndex: n - 1,
        confidence: 0.72,
        note: 'Weak bounce in downtrend - continuation setup',
      })
    }
  }

  // ---- Range / rectangle ----
  if (highs.length >= 2 && lows.length >= 2) {
    const H = highs.slice(-2)
    const L = lows.slice(-2)
    if (H[1].idx - H[0].idx >= 15 && tol(H[0].price, H[1].price, 0.015) && tol(L[0].price, L[1].price, 0.015)) {
      out.push({
        name: 'Trading Range',
        direction: 'neutral',
        startIndex: scanStart + H[0].idx,
        endIndex: n - 1,
        confidence: 0.7,
        note: 'Flat rectangle - fade edges until break',
      })
    }
  }

  return out.slice(0, 6)
}
