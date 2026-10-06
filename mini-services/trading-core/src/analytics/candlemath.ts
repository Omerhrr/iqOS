// IQAIR//OS - Candle Math (candlestick algebra / candle blending)
//
// Rationale: fixed-interval candle boundaries are an artifact of the chosen
// timeframe, not of the market itself. A strong institutional move can get
// chopped into two or three individually weak-looking candles purely because
// of where the clock happened to roll over a bar. "Blending" a short run of
// consecutive candles into one synthetic master candle - using the standard
// OHLC-merge rule below - reconstructs what that move would have looked like
// on a coarser timeframe, which can reveal a decisive pin-bar / hammer /
// engulfing / marubozu shape that isn't visible in any single raw candle.
//
// Combined Open  = Open of the FIRST candle in the group
// Combined High  = MAX(High) across the group
// Combined Low   = MIN(Low) across the group
// Combined Close = Close of the LAST candle in the group
// Combined Volume (if present) = SUM(volume) across the group, same
// aggregation convention already used for candle-level volume in orderflow.ts
//
// time: we pick the FIRST candle's time (i.e. the blended candle keeps the
// open-time of the group) because every other field in this codebase
// (Candle.time = "epoch seconds, candle open time", see types.ts) anchors a
// candle by its open time - picking the last candle's time would make the
// blended candle's timestamp inconsistent with what `time` means everywhere
// else in the pipeline.
import type { Candle } from '../types'
import { detectPatterns } from './patterns'

/** Merge 2+ consecutive candles into one synthetic "master" candle via the
 *  standard OHLC blend rule. Pure function, no side effects. */
export function blendCandles(candles: Candle[]): Candle {
  if (candles.length === 0) throw new Error('blendCandles: need at least 1 candle')
  const first = candles[0]
  const last = candles[candles.length - 1]
  let high = -Infinity
  let low = Infinity
  let volume = 0
  for (const c of candles) {
    if (c.high > high) high = c.high
    if (c.low < low) low = c.low
    volume += c.volume ?? 0
  }
  return {
    time: first.time,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
  }
}

export interface SmartBlend {
  startIdx: number
  endIdx: number // inclusive
  blended: Candle
  /** Pattern names detected on the blended candle that were NOT present on the raw candles. */
  patterns: string[]
  /** Pattern names detected scanning the same local context with the raw (unblended) candles. */
  rawPatterns: string[]
}

const CONTEXT = 20 // bars of history fed to detectPatterns so lookback-hungry detectors (3-5 bar patterns, avgBody windows) have enough to work with

/**
 * Scan `candles` with a sliding window of group sizes [minGroup, maxGroup]
 * (default 2-4) and report every group whose blended candle reveals a
 * candlestick pattern that the same local context does NOT show when scanned
 * with the raw, unblended candles.
 *
 * "Smart" grouping = pattern-confirmed grouping: rather than an arbitrary
 * "always blend every N candles" rule, every candidate window is evaluated
 * against `detectPatterns()` (the same detector library the rest of the OS
 * uses) both before and after blending, and only kept when blending
 * produces something genuinely new - i.e. it operationalizes "reveals hidden
 * institutional momentum" as "a higher-conviction pattern becomes detectable
 * that wasn't detectable in the chopped-up raw candles."
 */
export function findSmartBlends(candles: Candle[], opts?: { minGroup?: number; maxGroup?: number }): SmartBlend[] {
  const minGroup = Math.max(2, opts?.minGroup ?? 2)
  const maxGroup = Math.max(minGroup, opts?.maxGroup ?? 4)
  const out: SmartBlend[] = []
  if (candles.length < minGroup + 4) return out

  for (let groupSize = minGroup; groupSize <= maxGroup; groupSize++) {
    for (let startIdx = 0; startIdx + groupSize <= candles.length; startIdx++) {
      const endIdx = startIdx + groupSize - 1
      const group = candles.slice(startIdx, endIdx + 1)
      const blended = blendCandles(group)

      const contextStart = Math.max(0, startIdx - CONTEXT)

      // Raw context: history up through the END of the group, completely
      // unblended - this is "what the chart actually shows today."
      const rawWindow = candles.slice(contextStart, endIdx + 1)
      if (rawWindow.length < 3) continue
      const rawHits = detectPatterns(rawWindow, Math.min(8, groupSize + 2))
      const rawNames = new Set(rawHits.filter((h) => h.barsAgo <= groupSize - 1).map((h) => h.name))

      // Blended context: same history up to the group, but the whole group
      // is substituted by the single synthetic candle - "what the chart
      // would show on a coarser, momentum-preserving timeframe."
      const blendedWindow = [...candles.slice(contextStart, startIdx), blended]
      if (blendedWindow.length < 3) continue
      const blendedHits = detectPatterns(blendedWindow, 3)
      const blendedNames = new Set(blendedHits.filter((h) => h.barsAgo === 0).map((h) => h.name))

      const newPatterns = [...blendedNames].filter((n) => !rawNames.has(n))
      if (newPatterns.length === 0) continue

      out.push({
        startIdx,
        endIdx,
        blended,
        patterns: newPatterns,
        rawPatterns: [...rawNames],
      })
    }
  }

  // Prefer the strongest/most-recent finds; cap output so the API/UI aren't
  // flooded when a long series has many overlapping qualifying windows.
  out.sort((a, b) => b.endIdx - a.endIdx || b.patterns.length - a.patterns.length)

  // De-overlap: once a window's range is claimed, skip windows that overlap
  // it so the frontend isn't drawing 6 nested brackets over the same 3 bars.
  const claimed: Array<[number, number]> = []
  const deduped: SmartBlend[] = []
  for (const b of out) {
    const overlaps = claimed.some(([s, e]) => b.startIdx <= e && b.endIdx >= s)
    if (overlaps) continue
    claimed.push([b.startIdx, b.endIdx])
    deduped.push(b)
  }
  deduped.sort((a, b) => a.startIdx - b.startIdx)
  return deduped
}
