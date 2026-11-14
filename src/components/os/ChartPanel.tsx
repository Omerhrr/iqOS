'use client'

// IQAIR//OS - Chart workspace: 8 chart types + dynamic registry overlays.
// No default indicators - the chart starts clean and the operator's picker
// selection (persisted in localStorage) is the single source of overlays.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineWidth,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { AnalysisResult, Candle, ChartType, ExpirySurfaceResponse, IndicatorSeries, IvHvResponse, NextExpiryPrediction, OtcFootprintResult, OutcomeMemoryResponse, Position, PulseBarRow, PulseBarsResponse, TickBarRow, TickFootprintResult, TicksResponse, Timeframe } from '@/lib/os/client'
import { chartPriceFormat, fmtPrice, getDayLevels, getExpirySurface, getNextExpiry, getOtcFootprint, getOutcomeMemory, getPulseBars, getTickFootprint, osGet, TIMEFRAME_SECONDS } from '@/lib/os/client'

interface ChartPanelProps {
  candles: Candle[]
  analysis: AnalysisResult | null
  price: number
  digitsTicker: string
  chartType: ChartType
  overlays: IndicatorSeries[]
  positions?: Position[]
  settledPositions?: Position[]
  /** Chart timeframe (drives kernel fetches for tick/IV-HV charts). */
  tf?: Timeframe
  /** Yesterday-echo click-through: epoch-seconds window the time scale jumps
   * onto once the matching (deep-loaded) candles land. Applies ONCE per
   * nonce - later data updates never yank the operator's viewport. */
  focus?: { from: number; to: number; nonce: number } | null
}

type AnyPriceSeries =
  | ISeriesApi<'Candlestick'>
  | ISeriesApi<'Bar'>
  | ISeriesApi<'Line'>
  | ISeriesApi<'Area'>
  | ISeriesApi<'Baseline'>
  | ISeriesApi<'Histogram'>

const UP = '#10b981'
const DOWN = '#f43f5e'
const GRID = 'rgba(28,39,57,0.55)'
const TEXT = '#7c8aa5'

// ---------- transforms ----------

/** Latest candle open time <= ts (renko/heikin display times differ from feed times). */
function snapToCandle(candles: Candle[], ts: number): UTCTimestamp | null {
  let t: number | null = null
  for (const c of candles) {
    if (c.time <= ts) t = c.time
    else break
  }
  return t as UTCTimestamp | null
}

function heikinAshi(candles: Candle[]): Candle[] {
  const out: Candle[] = []
  let prevOpen = candles[0]?.open ?? 0
  let prevClose = candles[0]?.close ?? 0
  for (const c of candles) {
    const close = (c.open + c.high + c.low + c.close) / 4
    const open = (prevOpen + prevClose) / 2
    const high = Math.max(c.high, open, close)
    const low = Math.min(c.low, open, close)
    out.push({ time: c.time, open, high, low, close, volume: c.volume })
    prevOpen = open
    prevClose = close
  }
  return out
}

// ---------- incremental window engine ----------
// renko/pointFigure/rangeBars/volumeBars all re-scanned their WHOLE sliding
// window (150-400 candles, with nested brick/box-painting loops) on every
// single live price TICK, because `candles` gets a new array identity on
// every tick (the forming last candle is replaced in place - see page.tsx's
// onCandle reducer) and the useMemo computing displayCandles re-ran the
// transform from scratch each time. That O(window) rescan, several times a
// SECOND, was the actual CPU cost behind "the renko/range/volume chart feels
// stuck" (separate from the setData() cost ChartPanel already fixed for the
// 1:1 bar-for-bar chart types).
//
// The fix: every one of these transforms is a single left-to-right scan
// with a small running state (refPrice/dir/top-bottom/accumulator) - the
// textbook shape for incremental computation. `candles`' array elements are
// never MUTATED in place (page.tsx always replaces-and-returns a new array),
// so every element except the live forming last one keeps the exact same
// object reference tick after tick. That means "has the window's PREFIX
// (everything except the newest candle) changed" is answerable with a
// handful of reference (===) comparisons - no math - and when it hasn't,
// only the ONE new/changed tail candle needs to be scanned, reusing the
// cached running state from the end of the prefix. A full rescan only
// happens when the prefix itself actually changed (a bar closed and the
// window's start boundary shifted, or the sliding window dropped its oldest
// candle) - once per bar-close instead of once per tick.
interface IncCache<S> {
  prefixFirst: Candle | null
  prefixLastBeforeTail: Candle | null
  prefixLen: number
  state: S
  emitted: Candle[]
}

function scanIncremental<S>(
  window: Candle[],
  cacheRef: { current: IncCache<S> | null },
  seed: (window: Candle[]) => S,
  step: (state: S, c: Candle) => { state: S; emitted: Candle[] }
): Candle[] {
  if (window.length < 2) return []
  const prefix = window.slice(0, -1)
  const tail = window[window.length - 1]
  const cache = cacheRef.current
  const canReuse =
    !!cache &&
    cache.prefixLen === prefix.length &&
    (prefix.length === 0 || (cache.prefixFirst === prefix[0] && cache.prefixLastBeforeTail === prefix[prefix.length - 1]))
  if (canReuse && cache) {
    const tailResult = step(cache.state, tail)
    return [...cache.emitted, ...tailResult.emitted]
  }
  // full rescan: window's prefix shifted (new bar closed, or the sliding
  // window dropped its oldest candle) - reseed and replay the whole prefix.
  let state = seed(window)
  let emitted: Candle[] = []
  for (const c of prefix) {
    const r = step(state, c)
    state = r.state
    if (r.emitted.length) emitted = emitted.concat(r.emitted)
  }
  cacheRef.current = { prefixFirst: prefix[0] ?? null, prefixLastBeforeTail: prefix[prefix.length - 1] ?? null, prefixLen: prefix.length, state, emitted }
  const tailResult = step(state, tail)
  return [...emitted, ...tailResult.emitted]
}

function ascendingGuard(bars: Candle[]): Candle[] {
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].time <= bars[i - 1].time) bars[i].time = bars[i - 1].time + 1
  }
  return bars
}

interface RenkoState {
  refPrice: number
  lastClose: number
  brick: number
}

function atrOf(window: Candle[]): number {
  let trSum = 0
  for (let i = 1; i < window.length; i++) {
    trSum += Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close)
    )
  }
  return trSum / Math.max(window.length - 1, 1)
}

function renkoStep(state: RenkoState, c: Candle): { state: RenkoState; emitted: Candle[] } {
  let { refPrice, lastClose, brick } = state
  const emitted: Candle[] = []
  refPrice = lastClose
  let painted = 0
  while (c.close >= refPrice + brick) {
    emitted.push({ time: c.time + painted, open: refPrice, high: refPrice + brick, low: refPrice, close: refPrice + brick, volume: 0 })
    painted++
    refPrice += brick
    lastClose = refPrice
  }
  while (c.close <= refPrice - brick) {
    emitted.push({ time: c.time + painted, open: refPrice, high: refPrice, low: refPrice - brick, close: refPrice - brick, volume: 0 })
    painted++
    refPrice -= brick
    lastClose = refPrice
  }
  return { state: { refPrice, lastClose, brick }, emitted }
}

function renko(candles: Candle[], tfSec: number, cacheRef: { current: IncCache<RenkoState> | null }): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-150)
  void tfSec
  const bricks = scanIncremental(
    window,
    cacheRef,
    (w) => ({ refPrice: w[0].close, lastClose: w[0].close, brick: Math.max(atrOf(w) * 0.3, 1e-9) }),
    renkoStep
  )
  // Task 61: HONEST brick times - a brick's time is the open time of the
  // candle that COMPLETED it (the moment the brick became knowable), not a
  // fictional countdown from the last candle. When one candle completes
  // several bricks, extras stagger +1s (renko bricks have no independent
  // clock; lightweight-charts needs ascending unique times).
  return ascendingGuard(bricks).slice(-300)
}

/** Point & Figure boxes rendered as pseudo-candles: X boxes paint as up
 * candles (open=box bottom, close=box top), O boxes as down candles, so the
 * classic X/O staircase reads straight off the candlestick series. High/low
 * based, 3-box reversal, absolute box grid - mirrors the kernel engine of
 * record (mini-services/trading-core/src/analytics/pointfigure.ts). Brick
 * times are honest: each box carries the open time of the candle that
 * painted it (+1s stagger for extra boxes in the same candle). */
interface PfState {
  dir: 'X' | 'O' | null
  top: number
  bottom: number
  box: number
}

const PF_REVERSAL = 3

function pfPaint(level: number, d: 'X' | 'O', t: number, seq: number, box: number): Candle {
  return {
    time: t + seq,
    open: d === 'X' ? level : level + box,
    close: d === 'X' ? level + box : level,
    high: level + box,
    low: level,
    volume: 0,
  }
}

function pfStep(state: PfState, c: Candle): { state: PfState; emitted: Candle[] } {
  let { dir, top, bottom, box } = state
  const emitted: Candle[] = []
  const hi = Math.floor(c.high / box)
  const lo = Math.floor(c.low / box)
  let painted = 0
  if (dir === null) {
    dir = 'X'
    top = hi
    bottom = lo
    for (let lvl = bottom; lvl <= top; lvl++) emitted.push(pfPaint(lvl, 'X', c.time, painted++, box))
    return { state: { dir, top, bottom, box }, emitted }
  }
  if (dir === 'X') {
    while (hi > top) {
      top++
      emitted.push(pfPaint(top, 'X', c.time, painted++, box))
    }
    if (lo <= top - PF_REVERSAL) {
      // reversal: new O column starts one box below the X top box
      const newBottom = Math.min(top - PF_REVERSAL, lo)
      dir = 'O'
      const newTop = top - 1
      for (let lvl = newTop; lvl >= newBottom; lvl--) emitted.push(pfPaint(lvl, 'O', c.time, painted++, box))
      top = newTop
      bottom = newBottom
    }
  } else {
    while (lo < bottom) {
      bottom--
      emitted.push(pfPaint(bottom, 'O', c.time, painted++, box))
    }
    if (hi >= bottom + PF_REVERSAL) {
      const newTop = Math.max(bottom + PF_REVERSAL, hi)
      dir = 'X'
      const newBottom = bottom + 1
      for (let lvl = newBottom; lvl <= newTop; lvl++) emitted.push(pfPaint(lvl, 'X', c.time, painted++, box))
      bottom = newBottom
      top = newTop
    }
  }
  return { state: { dir, top, bottom, box }, emitted }
}

/** Point & Figure boxes rendered as pseudo-candles: X boxes paint as up
 * candles (open=box bottom, close=box top), O boxes as down candles, so the
 * classic X/O staircase reads straight off the candlestick series. High/low
 * based, 3-box reversal, absolute box grid - mirrors the kernel engine of
 * record (mini-services/trading-core/src/analytics/pointfigure.ts). Brick
 * times are honest: each box carries the open time of the candle that
 * painted it (+1s stagger for extra boxes in the same candle). Incremental
 * via scanIncremental() - see its doc comment. */
function pointFigureChart(candles: Candle[], tfSec: number, cacheRef: { current: IncCache<PfState> | null }): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-200)
  void tfSec
  const cells = scanIncremental(
    window,
    cacheRef,
    (w) => ({ dir: null, top: 0, bottom: 0, box: Math.max(atrOf(w) * 0.5, 1e-9) }),
    pfStep
  )
  return ascendingGuard(cells).slice(-300)
}

/** Three-Line-Break, rendered as pseudo-candles - mirrors the kernel engine
 * of record (mini-services/trading-core/src/analytics/linebreak.ts): a new
 * line only forms when the close either extends the current line's
 * direction past its own close, or breaks past the EXTREME close of the
 * last `lineCount` lines (reversal rule). Most candles are absorbed (no new
 * line), which is the whole point of the chart. Close-based, same
 * simplification the kernel engine states explicitly (no per-line high/low
 * tracking). Incremental via scanIncremental() - see its doc comment. */
interface LineBreakState {
  /** Trailing window of closed lines, oldest first, capped at lineCount - all
   * that's needed to test the next close against the N-line reversal rule. */
  lines: { close: number; dir: 1 | -1 }[]
  lineCount: number
}

function lineBreakStep(state: LineBreakState, c: Candle): { state: LineBreakState; emitted: Candle[] } {
  const { lineCount } = state
  let lines = state.lines
  const close = c.close
  const emitted: Candle[] = []
  if (lines.length === 0) {
    const dir: 1 | -1 = close >= c.open ? 1 : -1
    lines = [{ close, dir }]
    emitted.push({ time: c.time, open: c.open, high: Math.max(c.open, close), low: Math.min(c.open, close), close, volume: 0 })
    return { state: { lines, lineCount }, emitted }
  }
  const last = lines[lines.length - 1]
  if (close === last.close) return { state: { lines, lineCount }, emitted } // absorbed - no price change
  if ((last.dir === 1 && close > last.close) || (last.dir === -1 && close < last.close)) {
    const open = last.close
    lines = [...lines, { close, dir: last.dir }].slice(-lineCount)
    emitted.push({ time: c.time, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 0 })
    return { state: { lines, lineCount }, emitted }
  }
  const extreme = last.dir === 1 ? Math.min(...lines.map((l) => l.close)) : Math.max(...lines.map((l) => l.close))
  const broke = last.dir === 1 ? close < extreme : close > extreme
  if (broke) {
    const newDir: 1 | -1 = last.dir === 1 ? -1 : 1
    const open = last.close
    lines = [...lines, { close, dir: newDir }].slice(-lineCount)
    emitted.push({ time: c.time, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 0 })
  }
  // else: absorbed - moved against the trend but not far enough to break
  // the last N lines' extreme, so no new line paints.
  return { state: { lines, lineCount }, emitted }
}

function lineBreakChart(candles: Candle[], tfSec: number, cacheRef: { current: IncCache<LineBreakState> | null }): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-400) // wider input window than renko/PF since most candles get absorbed
  void tfSec
  const bars = scanIncremental(window, cacheRef, () => ({ lines: [], lineCount: 3 }), lineBreakStep)
  return ascendingGuard(bars).slice(-300)
}

/** Kagi, rendered as pseudo-candles - mirrors the kernel engine of record
 * (mini-services/trading-core/src/analytics/kagi.ts): a zig-zag line that
 * only reverses once price moves `reversal` (ATR-adaptive, same convention
 * renko/rangebars use) against the current extreme. SIMPLIFICATION, stated
 * honestly: the kernel engine updates one growing line's price in place as
 * it extends and flips its THICKNESS independently (shoulder/waist breaks)
 * for the yin/yang distinction; scanIncremental()'s append-only emission
 * model (same one renko/point-&-figure use - see its doc comment) can't
 * update an already-emitted pseudo-candle in place, so each extending step
 * instead appends its own short segment (open = prior extreme, close = new
 * extreme) rather than growing one continuous line. The zig-zag SHAPE this
 * produces is identical to the kernel engine's; only the thickness overlay
 * is dropped - direction still reads straight off each pseudo-candle's
 * up/down color. */
interface KagiState {
  dir: 1 | -1
  extreme: number
  shoulder: number | null
  waist: number | null
  thick: boolean
  reversal: number
}

function kagiStep(state: KagiState, c: Candle): { state: KagiState; emitted: Candle[] } {
  let { dir, extreme, shoulder, waist, thick, reversal } = state
  const close = c.close
  const emitted: Candle[] = []
  if (shoulder !== null && close > shoulder) thick = true
  if (waist !== null && close < waist) thick = false
  if (dir === 1) {
    if (close >= extreme) {
      const open = extreme
      extreme = close
      emitted.push({ time: c.time, open, high: Math.max(open, extreme), low: Math.min(open, extreme), close: extreme, volume: 0 })
    } else if (extreme - close >= reversal) {
      shoulder = extreme
      const open = extreme
      dir = -1
      extreme = close
      emitted.push({ time: c.time, open, high: Math.max(open, extreme), low: Math.min(open, extreme), close: extreme, volume: 0 })
    }
  } else {
    if (close <= extreme) {
      const open = extreme
      extreme = close
      emitted.push({ time: c.time, open, high: Math.max(open, extreme), low: Math.min(open, extreme), close: extreme, volume: 0 })
    } else if (close - extreme >= reversal) {
      waist = extreme
      const open = extreme
      dir = 1
      extreme = close
      emitted.push({ time: c.time, open, high: Math.max(open, extreme), low: Math.min(open, extreme), close: extreme, volume: 0 })
    }
  }
  return { state: { dir, extreme, shoulder, waist, thick, reversal }, emitted }
}

function kagiChart(candles: Candle[], tfSec: number, cacheRef: { current: IncCache<KagiState> | null }): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-200)
  void tfSec
  const bars = scanIncremental(
    window,
    cacheRef,
    (w) => ({ dir: 1 as 1 | -1, extreme: w[0].close, shoulder: null, waist: null, thick: true, reversal: Math.max(atrOf(w), 1e-9) }),
    kagiStep
  )
  return ascendingGuard(bars).slice(-300)
}

/** Time-Anchored Kagi Overlay ('kagiOverlay' chart type) - a CONTINUOUS
 * per-candle walk of the running Kagi extreme, unlike kagiStep()/kagiChart()
 * above which only emit a point when a candle extends the current extreme
 * or triggers a reversal (built for pseudo-candle rendering, where a
 * continuation that doesn't move the extreme has nothing new to draw).
 * Locking the Kagi line onto the REAL time axis (the whole point of this
 * overlay - see client.ts's 'kagiOverlay' doc comment) needs a value at
 * EVERY candle time, including candles where the line is holding flat at
 * its last extreme, so this walks the same state machine but always pushes
 * the current extreme/dir, not just on a change. Same honest simplification
 * kagiChart() already states: thickness (yang/yin) is dropped from this
 * client-side mirror - direction still reads via the up/down color split
 * the caller renders this into (kagiOverlayUpRef/kagiOverlayDownRef). */
function computeKagiOverlaySeries(candles: Candle[], mult = 1): { time: number; price: number; dir: 1 | -1 }[] {
  if (candles.length < 10) return []
  const window = candles.slice(-300)
  const reversal = Math.max(atrOf(window), 1e-9) * mult
  let dir: 1 | -1 = 1
  let extreme = window[0].close
  const out: { time: number; price: number; dir: 1 | -1 }[] = [{ time: window[0].time, price: extreme, dir }]
  for (let i = 1; i < window.length; i++) {
    const close = window[i].close
    if (dir === 1) {
      if (close >= extreme) extreme = close
      else if (extreme - close >= reversal) {
        dir = -1
        extreme = close
      }
    } else {
      if (close <= extreme) extreme = close
      else if (close - extreme >= reversal) {
        dir = 1
        extreme = close
      }
    }
    out.push({ time: window[i].time, price: extreme, dir })
  }
  return out
}

/** Effort Bricks, rendered as pseudo-candles - mirrors the kernel engine of
 * record's own brick GEOMETRY (mini-services/trading-core/src/analytics/
 * effortbricks.ts): continuation + classic 2-brick reversal rule, same
 * ATR(14) x 0.3 default sizing as renko() above (effortbricks.ts's own
 * default atrMult is 0.3 too - the brick shape this engine paints is
 * IDENTICAL to plain Renko's; what effortbricks.ts adds on top is the
 * per-brick volume-confirmation read, `effort`/`effortRatio`/`confirmed`).
 * SIMPLIFICATION, stated honestly (same precedent as kagiChart()'s own
 * thickness-drop note above): a vanilla CandlestickSeries has no per-bar
 * confirmed/unconfirmed visual distinction wired up here, so the chart body
 * shows brick geometry only - the confirmation/regime read itself is fully
 * live via `effort.confirmed()`/`effort.ratio()`/`effort.regime()` in MSL,
 * just not (yet) painted onto this series. Incremental via scanIncremental()
 * - reuses renkoStep() because the geometry (continuation + 2-brick
 * reversal) is byte-for-byte the same rule, just under its own cache. */
function effortBricksChart(candles: Candle[], cacheRef: { current: IncCache<RenkoState> | null }): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-150)
  const bricks = scanIncremental(
    window,
    cacheRef,
    (w) => ({ refPrice: w[0].close, lastClose: w[0].close, brick: Math.max(atrOf(w) * 0.3, 1e-9) }),
    renkoStep
  )
  return ascendingGuard(bricks).slice(-300)
}

/** Market Response Chart (MRC), rendered as pseudo-candles - a client-side
 * port of the kernel engine of record's CANDLE-FALLBACK path (mini-services/
 * trading-core/src/analytics/mrc.ts#computeMrc, `buildPoints()`'s candle
 * branch + the price/activity/time adaptive-event-clock loop) - each
 * candle close stands in as one pseudo-observation, exactly as the kernel
 * engine's own fallback does when no live tick buffer is available (which
 * is always true for this historical chart view - ticks only exist live).
 * SAME HONESTY GAPS the kernel module documents for candle fidelity:
 * `pathEfficiency`/`reversalCount` are not computable from OHLC alone and
 * are dropped entirely here (not even carried as NaN, since nothing reads
 * them on this chart body) - `directionalDelta` and `responseEfficiency`
 * are real, just coarser than a true tick-based read would give.
 * Not incremental (unlike renko/kagi above): the adaptive-event-clock loop
 * carries running trailing-average state (responseHistory/activityHistory)
 * that doesn't cleanly decompose into scanIncremental()'s prefix-reuse
 * model, so this recomputes the full capped window every call - the same
 * tradeoff volumeProfileBins()/deltaProfileBins() already accept for their
 * own full-window recomputes, acceptable at this chart's candle-count cap. */
function mrcChart(candles: Candle[]): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-400)
  const anyVolume = window.some((c) => Number.isFinite(c.volume) && c.volume > 0)
  const tfGaps: number[] = []
  for (let i = 1; i < window.length; i++) {
    const g = window[i].time - window[i - 1].time
    if (g > 0) tfGaps.push(g)
  }
  tfGaps.sort((a, b) => a - b)
  const baseIntervalSec = tfGaps.length ? tfGaps[Math.floor(tfGaps.length / 2)] : NaN
  const gapThresholdSec = Number.isFinite(baseIntervalSec) ? baseIntervalSec * 6 : Infinity // maxGapMultiple default = 6

  interface MrcPoint { t: number; price: number; activity: number; isUp: boolean | null }
  const points: MrcPoint[] = []
  let prevClose: number | null = null
  for (const c of window) {
    const activity = anyVolume ? Math.max(0, Number.isFinite(c.volume) ? c.volume : 0) : 1
    points.push({ t: c.time, price: c.close, activity, isUp: prevClose === null ? null : c.close >= prevClose })
    prevClose = c.close
  }
  if (points.length < 2) return []

  const priceMult = 6 // opts.priceMult default
  const maxDurationSec = Math.max(baseIntervalSec * 20 || 120, 120) // 120s default, widened for coarser timeframes
  const lookback = 20

  const bars: Candle[] = []
  const responseHistory: number[] = []
  const activityHistory: number[] = []
  const deltaWindow: number[] = []

  let barOpen = points[0].price
  let barStart = points[0].t
  let barHigh = points[0].price
  let barLow = points[0].price
  let barClose = points[0].price
  let activity = 0
  let upCount = 0
  let downCount = 0
  let pointsInBar = 0
  let prevT = points[0].t
  let prevPrice = points[0].price
  const ref = () => (bars.length ? bars[bars.length - 1].close : points[0].price)

  const closeBar = (endT: number, dataGap: boolean, confirmed: boolean) => {
    const displacement = barClose - barOpen
    const responseEfficiency = activity > 0 ? Math.abs(displacement) / activity : NaN
    bars.push({ time: barStart, open: barOpen, high: barHigh, low: barLow, close: barClose, volume: activity })
    if (!dataGap && confirmed) {
      if (Number.isFinite(responseEfficiency)) {
        responseHistory.push(responseEfficiency)
        if (responseHistory.length > lookback) responseHistory.shift()
      }
      activityHistory.push(activity)
      if (activityHistory.length > Math.min(lookback, 10)) activityHistory.shift()
    }
    void endT
    activity = 0
    upCount = 0
    downCount = 0
    pointsInBar = 0
  }

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const gapBefore = Number.isFinite(gapThresholdSec) && p.t - prevT > gapThresholdSec
    if (gapBefore && pointsInBar > 0) closeBar(points[i - 1].t, true, true)

    if (pointsInBar === 0) {
      barOpen = p.price
      barStart = p.t
      barHigh = p.price
      barLow = p.price
    }
    barHigh = Math.max(barHigh, p.price)
    barLow = Math.min(barLow, p.price)
    barClose = p.price
    activity += p.activity
    if (p.isUp === true) upCount++
    else if (p.isUp === false) downCount++
    pointsInBar++

    if (i > 0) {
      const delta = p.price - prevPrice
      deltaWindow.push(Math.abs(delta))
      if (deltaWindow.length > 14) deltaWindow.shift()
    }
    prevT = p.t
    prevPrice = p.price

    const avgStep = deltaWindow.length ? deltaWindow.reduce((a, b) => a + b, 0) / deltaWindow.length : NaN
    const distanceFromRef = Math.abs(barClose - ref())
    const activityThreshold = activityHistory.length >= 3 ? activityHistory.reduce((a, b) => a + b, 0) / activityHistory.length : 6
    const elapsed = p.t - barStart

    const priceEvent = pointsInBar >= 2 && Number.isFinite(avgStep) && avgStep > 0 && distanceFromRef >= avgStep * priceMult
    const activityEvent = pointsInBar >= 2 && activity >= activityThreshold
    const timeEvent = elapsed >= maxDurationSec
    const isLast = i === points.length - 1
    if (priceEvent || activityEvent || timeEvent || isLast) {
      const realTrigger = priceEvent || activityEvent || timeEvent
      closeBar(p.t, false, realTrigger)
    }
  }
  return ascendingGuard(bars).slice(-300)
}

// ---------- "Build all these end to end" sweep: Liquidity Spring /
// Volatility Echo - plain candles + native LineSeries overlays (NOT a
// canvas - lightweight-charts' own price-scale-synced lines are the right
// tool for a baseline+band). Client-side mirrors of analytics/
// {liquidityspring,volatilityecho}.ts's own math, same mirroring
// convention as effortBricksChart()/mrcChart() above, not a new UI shape. ----------

interface SpringLinePoint { time: number; baseline: number; snap: boolean; snapUp: boolean }

function computeLiquiditySpringClient(candles: Candle[], emaPeriod = 20, lookback = 50, snapTensionFloor = 2.0): SpringLinePoint[] {
  if (candles.length < 3) return []
  const win = candles.slice(-400)
  const k = 2 / (emaPeriod + 1)
  let baseline = win[0].close
  const anyVolume = win.some((c) => Number.isFinite(c.volume) && c.volume > 0)
  const devHistory: number[] = []
  const activityHistory: number[] = []
  const out: SpringLinePoint[] = []
  for (let i = 0; i < win.length; i++) {
    const c = win[i]
    baseline = i === 0 ? win[0].close : c.close * k + baseline * (1 - k)
    const deviation = c.close - baseline
    const absDev = Math.abs(deviation)
    const activity = anyVolume ? Math.max(0, Number.isFinite(c.volume) ? c.volume : 0) : 1
    const trailingDevs = devHistory.length >= lookback ? devHistory.slice(-lookback) : null
    const trailingStdev = trailingDevs ? Math.sqrt(trailingDevs.reduce((a, b) => a + b * b, 0) / trailingDevs.length - Math.pow(trailingDevs.reduce((a, b) => a + b, 0) / trailingDevs.length, 2)) : NaN
    const tensionScore = Number.isFinite(trailingStdev) && trailingStdev > 0 ? Math.min(6, absDev / trailingStdev) : NaN
    const trailingAct = activityHistory.length >= lookback ? activityHistory.slice(-lookback).reduce((a, b) => a + b, 0) / lookback : NaN
    const activityRatio = Number.isFinite(trailingAct) && trailingAct > 0 ? activity / trailingAct : NaN
    const decelerating = Number.isFinite(activityRatio) && activityRatio < 1
    const snap = Number.isFinite(tensionScore) && tensionScore >= snapTensionFloor && decelerating
    out.push({ time: c.time, baseline, snap, snapUp: deviation >= 0 })
    devHistory.push(absDev)
    activityHistory.push(activity)
  }
  return out
}

interface EchoLinePoint { time: number; baseline: number; upper: number; lower: number; pierced: 'up' | 'down' | null }

function computeVolatilityEchoClient(candles: Candle[], window = 15, bandMult = 2.0): EchoLinePoint[] {
  if (candles.length < window + 1) return []
  const win = candles.slice(-400)
  const out: EchoLinePoint[] = []
  for (let i = window - 1; i < win.length; i++) {
    const slice = win.slice(i - window + 1, i + 1).map((c) => c.close)
    const close = win[i].close
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length
    const dev = Math.sqrt(slice.reduce((a, b) => a + (b - mean) * (b - mean), 0) / slice.length)
    const upper = mean + dev * bandMult
    const lower = mean - dev * bandMult
    const pierced: EchoLinePoint['pierced'] = close > upper ? 'up' : close < lower ? 'down' : null
    out.push({ time: win[i].time, baseline: mean, upper, lower, pierced })
  }
  return out
}

// ---------- Task 63 transforms (kernel-mirrored; engines of record live in
// mini-services/trading-core/src/analytics/{rangebars,volumebars}.ts) ----------

interface RangeState {
  ref: number
  range: number
}

function rangeStep(state: RangeState, c: Candle): { state: RangeState; emitted: Candle[] } {
  let { ref, range } = state
  const emitted: Candle[] = []
  let painted = 0
  while (c.close >= ref + range) {
    emitted.push({ time: c.time + painted, open: ref, high: ref + range, low: ref, close: ref + range, volume: 0 })
    painted++
    ref += range
  }
  while (c.close <= ref - range) {
    emitted.push({ time: c.time + painted, open: ref, high: ref, low: ref - range, close: ref - range, volume: 0 })
    painted++
    ref -= range
  }
  return { state: { ref, range }, emitted }
}

/** Range bars - close-chained like the kernel engine: a bar closes when the
 * candle CLOSE clears one full `range` (ATR(window) x 0.5 default) beyond the
 * running reference, either direction, no reversal multiplier. Wickless by
 * construction; honest completion-candle times (+1s stagger). Incremental
 * via scanIncremental() - see its doc comment. */
function rangeBarsChart(candles: Candle[], tfSec: number, cacheRef: { current: IncCache<RangeState> | null }): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-150)
  void tfSec
  const bars = scanIncremental(
    window,
    cacheRef,
    (w) => ({ ref: w[0].close, range: Math.max(atrOf(w) * 0.5, 1e-9) }),
    rangeStep
  )
  return ascendingGuard(bars).slice(-300)
}

interface VolState {
  cur: Candle | null
  acc: number
  per: number
}

function volStep(state: VolState, c: Candle): { state: VolState; emitted: Candle[] } {
  let { cur, acc, per } = state
  const emitted: Candle[] = []
  if (!cur) cur = { ...c, volume: 0 }
  else cur = { ...cur } // never mutate the cached bar in place - a cached ref is shared across ticks until it closes
  cur.high = Math.max(cur.high, c.high)
  cur.low = Math.min(cur.low, c.low)
  cur.close = c.close
  cur.volume += c.volume
  acc += c.volume
  if (acc >= per) {
    emitted.push(cur)
    cur = null
    acc = 0
  }
  return { state: { cur, acc, per }, emitted }
}

/** Constant (equi) volume bars - kernel mirror of volumeBars(): a bar closes
 * when cumulative (approx) volume first reaches `per` (auto: totalVol/80,
 * floor median*0.25). Real clock: time = first contributing candle open.
 * Incremental via scanIncremental() - see its doc comment. The one bar still
 * accumulating (not yet past `per`) isn't in scanIncremental's `emitted`
 * list (it only collects CLOSED bars) - append it here from the live state
 * so the forming bar stays visible, same as the original always did. */
function volumeBarsChart(candles: Candle[], cacheRef: { current: IncCache<VolState> | null }): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-400)
  const total = window.reduce((s, c) => s + (Number.isFinite(c.volume) ? c.volume : 0), 0)
  if (total <= 0) return [] // all-zero volume -> nothing honest to draw
  const sorted = window.map((c) => c.volume).sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1]
  const per = Math.max(total / 80, median * 0.25, 1e-9)
  // `per` is itself window-derived (changes slightly as the window slides) -
  // fold it into the cache key the same way brick/box/range size changes
  // force a reseed: a cache built under a different `per` is stale.
  if (cacheRef.current && cacheRef.current.state.per !== per) cacheRef.current = null
  const bars = scanIncremental(window, cacheRef, () => ({ cur: null, acc: 0, per }), volStep)
  const pending = cacheRef.current?.state.cur
  return (pending ? [...bars, pending] : bars).slice(-300)
}

// ---------- Task 63 custom-canvas chart data (footprint / TPO) ----------
// These two cannot be candlestick pseudo-series; they render on a dedicated
// canvas overlay. The math mirrors the kernel engines of record
// (analytics/footprint.ts + analytics/tpo.ts) exactly as renko/pf mirror
// theirs. HONESTY: footprint buy/sell is the CLV proxy (no bid/ask feed);
// volume is IQ's (approx) figure.

interface FootRow { priceLow: number; priceHigh: number; buy: number; sell: number; imb: 'buy' | 'sell' | null }
interface FootCluster { time: number; open: number; high: number; low: number; close: number; rows: FootRow[]; delta: number; pocMid: number | null }

function footprintClusters(candles: Candle[], bins = 8, imbRatio = 3): FootCluster[] {
  return candles.map((c) => {
    const lo = c.low
    const hi = Math.max(c.high, c.low)
    const span = hi - lo
    const vol = Number.isFinite(c.volume) ? c.volume : 0
    const buyRatio = span > 0 ? Math.min(1, Math.max(0, (c.close - lo) / span)) : 0.5
    const rows: FootRow[] = []
    if (span <= 0 || vol <= 0) {
      rows.push({ priceLow: lo, priceHigh: hi, buy: vol * buyRatio, sell: vol * (1 - buyRatio), imb: null })
    } else {
      const bin = span / bins
      for (let b = 0; b < bins; b++) {
        const binLo = lo + b * bin
        const binHi = binLo + bin
        const overlap = Math.min(binHi, hi) - Math.max(binLo, lo)
        if (overlap <= 0) continue
        const v = vol * (overlap / span)
        const buy = v * buyRatio
        const sell = v - buy
        rows.push({
          priceLow: binLo,
          priceHigh: binHi,
          buy,
          sell,
          imb: buy >= imbRatio * sell ? 'buy' : sell >= imbRatio * buy ? 'sell' : null,
        })
      }
    }
    const delta = rows.reduce((s, r) => s + r.buy - r.sell, 0)
    let pocMid: number | null = null
    let best = -1
    for (const r of rows) {
      if (r.buy + r.sell > best) {
        best = r.buy + r.sell
        pocMid = (r.priceLow + r.priceHigh) / 2
      }
    }
    return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, rows, delta, pocMid }
  })
}

// ---------- Meta-Trader-bug-fix sweep: Volume Profile / Delta Profile
// custom-canvas histogram panels, Swing point-overlay ----------
// Volume Profile and Delta Profile are a HORIZONTAL HISTOGRAM over the
// visible price range, not a time series - they render on the same opaque
// canvas-overlay mechanism as footprint/tpo/otcfootprint/tickfootprint
// above, not as a pseudo-candle series. The math below is a client-side
// mirror of mini-services/trading-core/src/analytics/{volumeprofile,
// deltaprofile}.ts's own range-overlap volume-spreading (+ CLV buy/sell
// split for delta) - same honesty convention: `quality: 'estimated'`,
// never "measured bid/ask volume," labeled "(approx)" everywhere it's drawn.

interface VpRow { priceLow: number; priceHigh: number; mid: number; volume: number }
interface VpResult { rows: VpRow[]; totalVolume: number; poc: number | null; vah: number | null; val: number | null }

function volumeProfileBins(candles: Candle[], binCount = 36): VpResult {
  const empty: VpResult = { rows: [], totalVolume: 0, poc: null, vah: null, val: null }
  if (!candles.length) return empty
  let lo = Infinity
  let hi = -Infinity
  for (const c of candles) {
    lo = Math.min(lo, c.low)
    hi = Math.max(hi, c.high)
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return empty
  const binSize = (hi - lo) / binCount
  const volumes = new Array(binCount).fill(0)
  let totalVolume = 0
  for (const c of candles) {
    const vol = Number.isFinite(c.volume) ? c.volume : 0
    if (vol <= 0) continue
    const span = Math.max(c.high, c.low) - Math.min(c.high, c.low)
    if (span <= 0) {
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((c.close - lo) / binSize)))
      volumes[idx] += vol
      totalVolume += vol
      continue
    }
    const firstBin = Math.max(0, Math.floor((c.low - lo) / binSize))
    const lastBin = Math.min(binCount - 1, Math.floor((c.high - lo) / binSize))
    for (let b = firstBin; b <= lastBin; b++) {
      const binLo = lo + b * binSize
      const binHi = binLo + binSize
      const overlap = Math.min(binHi, c.high) - Math.max(binLo, c.low)
      if (overlap <= 0) continue
      const share = vol * (overlap / span)
      volumes[b] += share
      totalVolume += share
    }
  }
  const rows: VpRow[] = volumes.map((volume, b) => {
    const priceLow = lo + b * binSize
    const priceHigh = priceLow + binSize
    return { priceLow, priceHigh, mid: (priceLow + priceHigh) / 2, volume }
  })
  if (totalVolume <= 0) return { ...empty, rows }
  let pocIdx = 0
  for (let i = 1; i < rows.length; i++) if (rows[i].volume > rows[pocIdx].volume) pocIdx = i
  let loIdx = pocIdx
  let hiIdx = pocIdx
  let acc = rows[pocIdx].volume
  const target = totalVolume * 0.7
  while (acc < target && (loIdx > 0 || hiIdx < rows.length - 1)) {
    const belowVol = loIdx > 0 ? rows[loIdx - 1].volume : -1
    const aboveVol = hiIdx < rows.length - 1 ? rows[hiIdx + 1].volume : -1
    if (aboveVol >= belowVol) {
      hiIdx++
      acc += rows[hiIdx].volume
    } else {
      loIdx--
      acc += rows[loIdx].volume
    }
  }
  return { rows, totalVolume, poc: rows[pocIdx].mid, vah: rows[hiIdx].priceHigh, val: rows[loIdx].priceLow }
}

interface DpRow { priceLow: number; priceHigh: number; mid: number; delta: number; volume: number }
interface DpResult { rows: DpRow[]; totalDelta: number; totalVolume: number; positiveDeltaPoc: number | null; negativeDeltaPoc: number | null; deltaSkew: number }

function deltaProfileBins(candles: Candle[], binCount = 36): DpResult {
  const empty: DpResult = { rows: [], totalDelta: 0, totalVolume: 0, positiveDeltaPoc: null, negativeDeltaPoc: null, deltaSkew: 0 }
  if (!candles.length) return empty
  let lo = Infinity
  let hi = -Infinity
  for (const c of candles) {
    lo = Math.min(lo, c.low)
    hi = Math.max(hi, c.high)
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return empty
  const binSize = (hi - lo) / binCount
  const deltas = new Array(binCount).fill(0)
  const volumes = new Array(binCount).fill(0)
  let totalVolume = 0
  for (const c of candles) {
    const vol = Number.isFinite(c.volume) ? c.volume : 0
    if (vol <= 0) continue
    const range = c.high - c.low
    const clv = range > 0 ? (2 * c.close - c.high - c.low) / range : 0
    const buyShare = (1 + clv) / 2
    const buyVol = vol * buyShare
    const sellVol = vol - buyVol
    const span = Math.max(c.high, c.low) - Math.min(c.high, c.low)
    if (span <= 0) {
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((c.close - lo) / binSize)))
      deltas[idx] += buyVol - sellVol
      volumes[idx] += vol
      totalVolume += vol
      continue
    }
    const firstBin = Math.max(0, Math.floor((c.low - lo) / binSize))
    const lastBin = Math.min(binCount - 1, Math.floor((c.high - lo) / binSize))
    for (let b = firstBin; b <= lastBin; b++) {
      const binLo = lo + b * binSize
      const binHi = binLo + binSize
      const overlap = Math.min(binHi, c.high) - Math.max(binLo, c.low)
      if (overlap <= 0) continue
      const overlapShare = overlap / span
      deltas[b] += (buyVol - sellVol) * overlapShare
      volumes[b] += vol * overlapShare
      totalVolume += vol * overlapShare
    }
  }
  const rows: DpRow[] = deltas.map((delta, b) => {
    const priceLow = lo + b * binSize
    const priceHigh = priceLow + binSize
    return { priceLow, priceHigh, mid: (priceLow + priceHigh) / 2, delta, volume: volumes[b] }
  })
  const totalDelta = rows.reduce((s, r) => s + r.delta, 0)
  if (totalVolume <= 0) return { ...empty, rows }
  let posIdx = -1
  let negIdx = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].delta > 0 && (posIdx === -1 || rows[i].delta > rows[posIdx].delta)) posIdx = i
    if (rows[i].delta < 0 && (negIdx === -1 || rows[i].delta < rows[negIdx].delta)) negIdx = i
  }
  return {
    rows,
    totalDelta,
    totalVolume,
    positiveDeltaPoc: posIdx >= 0 ? rows[posIdx].mid : null,
    negativeDeltaPoc: negIdx >= 0 ? rows[negIdx].mid : null,
    deltaSkew: Math.max(-1, Math.min(1, totalDelta / totalVolume)),
  }
}

// Swing is NOT a histogram or a pseudo-candle series - it's a point overlay
// on the existing (plain) candle series, so this is the one client-side
// mirror that feeds the markers effect below rather than the custom-canvas
// one. Mirrors analytics/swing.ts#computeSwing exactly (fractal-pivot
// swing high/low, honest lookback-confirmation lag, hh-hl/lh-ll structure).
interface SwingPoint { time: number; price: number; kind: 'high' | 'low'; index: number }

function computeSwingClient(candles: Candle[], lookback = 3): SwingPoint[] {
  const swings: SwingPoint[] = []
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true
    let isLow = true
    const h = candles[i].high
    const l = candles[i].low
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue
      if (candles[j].high >= h) isHigh = false
      if (candles[j].low <= l) isLow = false
    }
    if (isHigh && isLow) {
      const mid = (h + l) / 2
      if (candles[i].close >= mid) isLow = false
      else isHigh = false
    }
    if (isHigh) swings.push({ time: candles[i].time, price: h, kind: 'high', index: i })
    else if (isLow) swings.push({ time: candles[i].time, price: l, kind: 'low', index: i })
  }
  return swings
}

interface TpoBinRow { priceLow: number; priceHigh: number; tpos: number; inVA: boolean }
interface TpoPeriodRow { letter: string; startTime: number; endTime: number; high: number; low: number }
interface TpoProfile {
  bins: TpoBinRow[]
  periods: TpoPeriodRow[]
  poc: number | null
  vaHigh: number | null
  vaLow: number | null
  ibHigh: number | null
  ibLow: number | null
  periodRule: string
  totalTpos: number
}

const TPO_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function tpoProfile(candles: Candle[], periodSecReq = 1800, binCount = 60): TpoProfile {
  if (!candles.length) return { bins: [], periods: [], poc: null, vaHigh: null, vaLow: null, ibHigh: null, ibLow: null, periodRule: 'no data', totalTpos: 0 }
  const tfSec = Math.max(1, candles.length >= 2 ? candles[candles.length - 1].time - candles[candles.length - 2].time : 60)
  const periodSec = tfSec >= periodSecReq ? tfSec : Math.max(60, periodSecReq)
  const periodRule = periodSec === periodSecReq ? `${periodSec}s brackets` : `per-candle (tf ${tfSec}s)`

  const periods: TpoPeriodRow[] = []
  for (const c of candles) {
    const last = periods[periods.length - 1]
    const sameBracket = last && Math.floor(last.startTime / periodSec) === Math.floor(c.time / periodSec)
    if (sameBracket && last) {
      last.high = Math.max(last.high, c.high)
      last.low = Math.min(last.low, c.low)
      last.endTime = c.time
    } else {
      periods.push({ letter: TPO_LETTERS[periods.length % TPO_LETTERS.length], startTime: c.time, endTime: c.time, high: c.high, low: c.low })
    }
  }

  const winLow = Math.min(...periods.map((p) => p.low))
  const winHigh = Math.max(...periods.map((p) => p.high))
  const span = winHigh - winLow
  if (!Number.isFinite(span) || span <= 0) {
    return { bins: [{ priceLow: winLow, priceHigh: winHigh, tpos: periods.length, inVA: true }], periods, poc: (winLow + winHigh) / 2, vaHigh: winHigh, vaLow: winLow, ibHigh: periods[0].high, ibLow: periods[0].low, periodRule, totalTpos: periods.length }
  }
  const bin = span / binCount
  const bins: TpoBinRow[] = Array.from({ length: binCount }, (_, b) => ({ priceLow: winLow + b * bin, priceHigh: winLow + (b + 1) * bin, tpos: 0, inVA: false }))
  for (const p of periods) {
    const from = Math.max(0, Math.floor((p.low - winLow) / bin))
    const to = Math.min(binCount - 1, Math.floor((p.high - winLow) / bin))
    for (let b = from; b <= to; b++) bins[b].tpos++
  }
  const total = bins.reduce((s, b) => s + b.tpos, 0)
  const winMid = (winLow + winHigh) / 2
  let pocIdx = 0
  for (let b = 1; b < binCount; b++) {
    const mid = bins[b].priceLow + bin / 2
    const pocMid = bins[pocIdx].priceLow + bin / 2
    if (bins[b].tpos > bins[pocIdx].tpos || (bins[b].tpos === bins[pocIdx].tpos && Math.abs(mid - winMid) < Math.abs(pocMid - winMid))) pocIdx = b
  }
  const target = total * 0.7
  let acc = bins[pocIdx].tpos
  let lo = pocIdx
  let hi = pocIdx
  while (acc < target && (lo > 0 || hi < binCount - 1)) {
    const below = lo > 0 ? bins[lo - 1].tpos : -1
    const above = hi < binCount - 1 ? bins[hi + 1].tpos : -1
    if (above > below) acc += bins[++hi].tpos
    else acc += bins[--lo].tpos
  }
  for (let b = lo; b <= hi; b++) bins[b].inVA = true
  return {
    bins,
    periods,
    poc: bins[pocIdx].priceLow + bin / 2,
    vaHigh: bins[hi].priceHigh,
    vaLow: bins[lo].priceLow,
    ibHigh: periods[0].high,
    ibLow: periods[0].low,
    periodRule,
    totalTpos: total,
  }
}

const lineStyleMap: Record<string, LineStyle> = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted }

export default function ChartPanel({
  candles,
  analysis,
  price,
  digitsTicker,
  chartType,
  overlays,
  positions,
  settledPositions,
  tf,
  focus,
}: ChartPanelProps) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const priceSeriesRef = useRef<AnyPriceSeries | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const entryLineRefs = useRef<Map<string, { series: AnyPriceSeries; line: IPriceLine; price: number; title: string }>>(new Map())
  const markersRef = useRef<{ series: AnyPriceSeries; api: ISeriesMarkersPluginApi<Time> } | null>(null)
  const priceFmtKeyRef = useRef<string | null>(null)
  // Perf: tracks what's ALREADY rendered on the price/volume series, so the
  // data effect below can tell "the forming bar just ticked" (replace the
  // last point - series.update(), O(1)) and "one new bar appended while the
  // buffer hadn't hit its cap yet" (append - also series.update()) apart
  // from "the dataset actually changed shape" (chart-type switch, asset
  // switch, or the capped candle buffer rolled - full series.setData(),
  // O(n)). Every live price TICK used to force a full setData() of up to
  // ~320 bars - on a fast-ticking asset that's a full series rebuild
  // several times a SECOND, which is exactly what "the chart feels stuck"
  // was - lightweight-charts is built around update() for this, setData()
  // is for a genuine reload. Reset to null whenever the series itself is
  // torn down/recreated (chartType switch) so the first paint after that
  // always goes through the safe full-setData path.
  const renderStateRef = useRef<{ len: number; lastTime: number } | null>(null)
  // Incremental-scan caches for the sliding-window chart types - one per
  // transform, persisted across renders (see scanIncremental()'s doc
  // comment above). Reset whenever the underlying candle feed restarts for
  // a different reason than "one more tick/bar" (asset switch) so a stale
  // cached running state never bleeds into a different instrument's bricks/
  // boxes/bars - digitsTicker already identifies the instrument uniquely.
  const renkoCacheRef = useRef<IncCache<RenkoState> | null>(null)
  const pfCacheRef = useRef<IncCache<PfState> | null>(null)
  const rangeCacheRef = useRef<IncCache<RangeState> | null>(null)
  const volCacheRef = useRef<IncCache<VolState> | null>(null)
  const lineBreakCacheRef = useRef<IncCache<LineBreakState> | null>(null)
  const kagiCacheRef = useRef<IncCache<KagiState> | null>(null)
  const effortCacheRef = useRef<IncCache<RenkoState> | null>(null)
  useEffect(() => {
    renkoCacheRef.current = null
    pfCacheRef.current = null
    rangeCacheRef.current = null
    volCacheRef.current = null
    lineBreakCacheRef.current = null
    kagiCacheRef.current = null
    effortCacheRef.current = null
  }, [digitsTicker])

  // axis/crosshair/price-line precision follows the asset's quote convention
  // (the library default of 2 decimals turns 1.10283 into 1.10)
  const priceFmt = useMemo(() => chartPriceFormat(digitsTicker, price), [digitsTicker, price])
  const overlayRefs = useRef<Map<string, ISeriesApi<'Line'>>>(new Map())
  // registry indicator markers (fractal arrows) + trade markers merge into ONE
  // setMarkers payload on the price series - two refs, one plugin
  const indMarkersRef = useRef<SeriesMarker<Time>[]>([])
  const tradeMarkersRef = useRef<SeriesMarker<Time>[]>([])
  const swingMarkersRef = useRef<SeriesMarker<Time>[]>([])
  const memoryMarkersRef = useRef<SeriesMarker<Time>[]>([])

  const tfSec = useMemo(() => {
    if (!candles || candles.length < 2) return 60
    return Math.max(1, candles[candles.length - 1].time - candles[candles.length - 2].time)
  }, [candles])

  // ---------- Task 63: fetched chart data + custom-canvas refs ----------
  const [tickBarsState, setTickBarsState] = useState<TickBarRow[]>([])
  const [ivhvState, setIvhvState] = useState<IvHvResponse | null>(null)
  const [otcState, setOtcState] = useState<OtcFootprintResult | null>(null)
  const [tickFpState, setTickFpState] = useState<TickFootprintResult | null>(null)
  const [pulseState, setPulseState] = useState<PulseBarsResponse | null>(null)
  const [outcomeMemState, setOutcomeMemState] = useState<OutcomeMemoryResponse | null>(null)
  const [expirySurfaceState, setExpirySurfaceState] = useState<ExpirySurfaceResponse | null>(null)
  const [liveExpiryState, setLiveExpiryState] = useState<NextExpiryPrediction | null>(null)
  const customCanvasRef = useRef<HTMLCanvasElement | null>(null)
  // IV/HV pane line series (created only when chartType === 'ivhv')
  const hvLineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const springBaselineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const echoBaselineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const echoUpperRef = useRef<ISeriesApi<'Line'> | null>(null)
  const kagiOverlayUpRef = useRef<ISeriesApi<'Line'> | null>(null)
  const kagiOverlayDownRef = useRef<ISeriesApi<'Line'> | null>(null)
  const echoLowerRef = useRef<ISeriesApi<'Line'> | null>(null)
  const springMarkersRef = useRef<SeriesMarker<Time>[]>([])
  const echoMarkersRef = useRef<SeriesMarker<Time>[]>([])
  const kagiGlowMarkersRef = useRef<SeriesMarker<Time>[]>([])
  const ivLineRef = useRef<ISeriesApi<'Line'> | null>(null)

  // Drop stale tick/IV-HV/OTC-footprint data the instant the asset changes,
  // BEFORE the poll effects below land their next response. The "keep last
  // good data" comments in those effects are about tolerating a transient
  // poll FAILURE for the SAME asset - they were never meant to also cover a
  // real asset SWITCH, but with no asset-keyed reset they did too: switching
  // pairs while on Tick/IV-HV/OTC Footprint kept rendering the PREVIOUS
  // asset's bars/buckets for up to one whole poll interval (5-15s).
  useEffect(() => {
    setTickBarsState([])
    setIvhvState(null)
    setOtcState(null)
    setPulseState(null)
    setOutcomeMemState(null)
    setExpirySurfaceState(null)
    setLiveExpiryState(null)
  }, [digitsTicker])

  // tick chart: real /ticks bars (sidecar 100ms capture when live, 5s-close
  // pseudo-ticks otherwise - the kernel's honest dataSource contract). Poll
  // at candle cadence while the type is active.
  useEffect(() => {
    if (chartType !== 'tickchart') return
    let dead = false
    const pull = () => {
      osGet<TicksResponse>('/ticks', { asset: digitsTicker, per: 10 })
        .then((r) => {
          if (dead || !r?.ok) return
          setTickBarsState(r.bars ?? [])
        })
        .catch(() => {
          // keep last good data
        })
    }
    pull()
    const iv = setInterval(pull, 5000)
    return () => {
      dead = true
      clearInterval(iv)
    }
  }, [chartType, digitsTicker])

  // IV vs HV: kernel-computed HV series + payout-implied IV-proxy samples
  useEffect(() => {
    if (chartType !== 'ivhv') return
    let dead = false
    const pull = () => {
      osGet<IvHvResponse>('/iv_hv', { asset: digitsTicker, tf: tf ?? '1m', window: 20 })
        .then((r) => {
          if (dead || !r?.ok) return
          setIvhvState(r)
        })
        .catch(() => {
          // keep last good data
        })
    }
    pull()
    const iv = setInterval(pull, 15000)
    return () => {
      dead = true
      clearInterval(iv)
    }
  }, [chartType, digitsTicker, tf])

  // OTC velocity footprint: kernel micro-tick aggregation (/otc_footprint) -
  // same engine the OTC Footprint tab and the otcv* lab family read. Poll at
  // the panel's cadence while the type is active; buckets arrive pre-aggregated
  // per minute with per-row up/down speeds (up to the capture cadence).
  useEffect(() => {
    if (chartType !== 'otcfootprint') return
    let dead = false
    const pull = () => {
      getOtcFootprint(digitsTicker, { minutes: 30, bucketSec: 60 })
        .then((r) => {
          if (dead || !r?.ok) return
          setOtcState(r)
        })
        .catch(() => {
          // keep last good data
        })
    }
    pull()
    const iv = setInterval(pull, 6000)
    return () => {
      dead = true
      clearInterval(iv)
    }
  }, [chartType, digitsTicker])

  // Tick Footprint: measured-print footprint over TICK-CHART buckets
  // (/tick_footprint) - real up/down print counts per price bin, never the
  // CLV proxy. Bucket length follows the chart's own timeframe.
  useEffect(() => {
    if (chartType !== 'tickfootprint') return
    let dead = false
    const bucketSec = TIMEFRAME_SECONDS[tf ?? '1m'] ?? 60
    const pull = () => {
      getTickFootprint(digitsTicker, { bucketSec, bins: 12, candles: 40 })
        .then((r) => {
          if (dead) return
          setTickFpState(r)
        })
        .catch(() => {
          // keep last good data
        })
    }
    pull()
    const iv = setInterval(pull, 6000)
    return () => {
      dead = true
      clearInterval(iv)
    }
  }, [chartType, digitsTicker, tf])

  // Pulse-Vector bars: live-tick-only aggregation (/pulse_bars) - same
  // "poll while the type is active" cadence as otcfootprint/tickfootprint.
  useEffect(() => {
    // also polled on 'kagiOverlay' - the ribbon's tick-velocity glow (see
    // the kagiOverlay data effect below) reuses this SAME live-tick feed
    // rather than standing up a second poll; honestly flat/no-glow when
    // this never resolves (no live tick buffer, e.g. backtest/history view).
    if (chartType !== 'pulse' && chartType !== 'kagiOverlay') return
    let dead = false
    const pull = () => {
      getPulseBars(digitsTicker, { intervalSec: 5 })
        .then((r) => {
          if (dead || !r?.ok) return
          setPulseState(r)
        })
        .catch(() => {
          // keep last good data
        })
    }
    pull()
    const iv = setInterval(pull, 5000)
    return () => {
      dead = true
      clearInterval(iv)
    }
  }, [chartType, digitsTicker])

  // Historical Outcome Memory: a current-state k-NN read (/outcome_memory),
  // not a fast-moving time series - poll at a slower cadence than the
  // other fetched chart types (the comparable pool only changes bar-to-bar).
  useEffect(() => {
    if (chartType !== 'outcomeMemory') return
    let dead = false
    const pull = () => {
      getOutcomeMemory(digitsTicker, { tf: tf ?? '1m' })
        .then((r) => {
          if (dead || !r?.ok) return
          setOutcomeMemState(r)
        })
        .catch(() => {
          // keep last good data
        })
    }
    pull()
    const iv = setInterval(pull, 20000)
    return () => {
      dead = true
      clearInterval(iv)
    }
  }, [chartType, digitsTicker, tf])

  // Expiry Probability Surface: the historical raw-replay heatmap
  // (/expiry_surface, slow-moving - 1m-native, polled gently) PLUS the
  // real calibrated live read (/next_expiry, polled faster - it's the
  // "right now" column and should feel current).
  useEffect(() => {
    if (chartType !== 'expirySurface') return
    let dead = false
    const pullSurface = () => {
      getExpirySurface(digitsTicker, { lookback: 120 })
        .then((r) => {
          if (dead || !r?.ok) return
          setExpirySurfaceState(r)
        })
        .catch(() => {
          // keep last good data
        })
    }
    const pullLive = () => {
      getNextExpiry(digitsTicker)
        .then((r) => {
          if (dead || !r?.ok || !r.prediction) return
          setLiveExpiryState(r.prediction)
        })
        .catch(() => {
          // keep last good data
        })
    }
    pullSurface()
    pullLive()
    const ivSurface = setInterval(pullSurface, 30000)
    const ivLive = setInterval(pullLive, 5000)
    return () => {
      dead = true
      clearInterval(ivSurface)
      clearInterval(ivLive)
    }
  }, [chartType, digitsTicker])

  // footprint/TPO/OTC-footprint/tick-footprint's canvas redraw used to key
  // off raw `candles`, which gets a new array identity on every live tick
  // (the forming last candle is replaced in place). For footprint/TPO that
  // meant rebuilding their cluster/profile math AND repainting the whole
  // canvas (many fillRect/fillText calls - text draws are themselves not
  // cheap) several times a SECOND; for otcfootprint/tickfootprint it was
  // even more wasteful since those two don't read `candles` at all (their
  // pixels come from otcState/tickFpState, which already poll on their own
  // 5-6s interval) - `candles` ticking was repainting them for data that
  // hadn't changed. This signature is a primitive STRING, so even though
  // the useMemo recomputes every tick (cheap - O(1), not O(window)), its
  // VALUE only changes once a bar actually closes (the array's second-to-
  // last element is what's stable across ticks and shifts only on a close),
  // and React's effect-dependency check compares by value for primitives -
  // so the canvas effect below only reruns on an actual bar close, not on
  // every forming-bar tick.
  const closedBarSignature = useMemo(() => {
    if (!candles.length) return '0'
    const anchor = candles.length >= 2 ? candles[candles.length - 2] : candles[0]
    return `${candles.length}:${anchor.time}`
  }, [candles])

  const displayCandles = useMemo(() => {
    if (chartType === 'heikin') return heikinAshi(candles)
    if (chartType === 'renko') return renko(candles, tfSec, renkoCacheRef)
    if (chartType === 'pointfigure') return pointFigureChart(candles, tfSec, pfCacheRef)
    if (chartType === 'rangebars') return rangeBarsChart(candles, tfSec, rangeCacheRef)
    if (chartType === 'volumebars') return volumeBarsChart(candles, volCacheRef)
    if (chartType === 'linebreak') return lineBreakChart(candles, tfSec, lineBreakCacheRef)
    if (chartType === 'kagi') return kagiChart(candles, tfSec, kagiCacheRef)
    if (chartType === 'effort') return effortBricksChart(candles, effortCacheRef)
    if (chartType === 'mrc') return mrcChart(candles)
    if (chartType === 'tickchart') {
      // real /ticks bars when the fetch landed; else fall through to raw
      // candles (kernel always falls back server-side, so empty = not loaded)
      const bars = tickBarsState.map((b) => ({ time: Math.floor(b.time), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.ticks }))
      // sidecar times are float seconds - force ascending unique ints
      for (let i = 1; i < bars.length; i++) if (bars[i].time <= bars[i - 1].time) bars[i].time = bars[i - 1].time + 1
      return bars.length ? bars : candles
    }
    return candles
  }, [candles, chartType, tfSec, tickBarsState])

  // create/recreate chart when chartType changes; built-in series live & die with the chart
  useEffect(() => {
    if (!elRef.current) return
    const chart = createChart(elRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: TEXT,
        fontSize: 11,
        fontFamily: 'var(--font-geist-mono), monospace',
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      crosshair: { mode: 0, vertLine: { color: '#3b82a0', labelBackgroundColor: '#0f2733' }, horzLine: { color: '#3b82a0', labelBackgroundColor: '#0f2733' } },
      rightPriceScale: { borderColor: '#1c2739', scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: '#1c2739', timeVisible: true, secondsVisible: true, rightOffset: 6 },
    })
    chartRef.current = chart

    const vol = chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      color: 'rgba(56,189,248,0.28)',
    })
    volRef.current = vol
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })

    let price: ISeriesApi<'Candlestick'> | ISeriesApi<'Bar'> | ISeriesApi<'Line'> | ISeriesApi<'Area'> | ISeriesApi<'Baseline'>
    if (chartType === 'candles') {
      price = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        priceLineColor: '#38bdf8',
      })
    } else if (chartType === 'hollow') {
      price = chart.addSeries(CandlestickSeries, {
        upColor: 'transparent', downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        priceLineColor: '#38bdf8',
      })
    } else if (chartType === 'heikin' || chartType === 'renko' || chartType === 'pointfigure' || chartType === 'rangebars' || chartType === 'volumebars' || chartType === 'tickchart' || chartType === 'linebreak' || chartType === 'kagi' || chartType === 'swing' || chartType === 'effort' || chartType === 'mrc' || chartType === 'outcomeMemory' || chartType === 'spring' || chartType === 'echo') {
      price = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        priceLineColor: '#38bdf8',
      })
    } else if (chartType === 'kagiOverlay') {
      // REAL candles, dimmed - this chart type does NOT replace the candle
      // view the way 'kagi' does; the ribbon (added below) draws on top of
      // these, which is the entire point of the overlay (see client.ts's
      // 'kagiOverlay' doc comment).
      price = chart.addSeries(CandlestickSeries, {
        upColor: 'rgba(16,185,129,0.35)', downColor: 'rgba(244,63,94,0.35)',
        borderUpColor: 'rgba(16,185,129,0.45)', borderDownColor: 'rgba(244,63,94,0.45)',
        wickUpColor: 'rgba(16,185,129,0.35)', wickDownColor: 'rgba(244,63,94,0.35)',
        priceLineVisible: false,
      })
    } else if (chartType === 'footprint' || chartType === 'tpo' || chartType === 'otcfootprint' || chartType === 'tickfootprint') {
      // hidden behind the opaque custom canvas - but keeps the series
      // machinery (markers/price lines) alive and the data effect fed with
      // candle-shaped objects (falling through to baseline would crash)
      price = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        priceLineColor: '#38bdf8',
      })
    } else if (chartType === 'ivhv') {
      // candles in pane 0 for context; HV/IV lines live in pane 1
      price = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        priceLineColor: '#38bdf8',
      })
    } else if (chartType === 'bars') {
      price = chart.addSeries(BarSeries, { upColor: UP, downColor: DOWN, thinBars: false })
    } else if (chartType === 'line') {
      price = chart.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 2 })
    } else if (chartType === 'area') {
      price = chart.addSeries(AreaSeries, {
        lineColor: '#38bdf8', topColor: 'rgba(56,189,248,0.28)', bottomColor: 'rgba(56,189,248,0.02)', lineWidth: 2,
      })
    } else {
      // baseline
      price = chart.addSeries(BaselineSeries, {
        topLineColor: UP, topFillColor1: 'rgba(16,185,129,0.28)', topFillColor2: 'rgba(16,185,129,0.02)',
        bottomLineColor: DOWN, bottomFillColor1: 'rgba(244,63,94,0.02)', bottomFillColor2: 'rgba(244,63,94,0.28)',
      })
    }
    price.applyOptions({ priceFormat: priceFmt })
    priceSeriesRef.current = price

    // IV vs HV pane: two line series in a separate pane below the price
    // (lightweight-charts v5 panes). Live/die with the chart; the data
    // effect fills them from the /iv_hv fetch.
    if (chartType === 'ivhv') {
      try {
        const hvLine = chart.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'HV%' }, 1)
        const ivLine = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'IV proxy%' }, 1)
        hvLineRef.current = hvLine
        ivLineRef.current = ivLine
        const pane = chart.panes()[1]
        pane?.setStretchFactor(1)
        chart.panes()[0]?.setStretchFactor(3)
      } catch {
        // pane API unavailable -> ivhv degrades to plain candles
      }
    }

    // Liquidity Spring / Volatility Echo: native LineSeries overlays in
    // PANE 0 (same pane as price - unlike ivhv's lines above, these track
    // the SAME price scale the candles use, which is the whole point of a
    // baseline+band overlay). Live/die with the chart; the data effect
    // below fills them from computeLiquiditySpringClient()/
    // computeVolatilityEchoClient().
    if (chartType === 'spring') {
      springBaselineRef.current = chart.addSeries(LineSeries, { color: 'rgba(245,158,11,0.85)', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: 'core' })
    } else if (chartType === 'echo') {
      echoBaselineRef.current = chart.addSeries(LineSeries, { color: 'rgba(124,138,165,0.7)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: 'mid' })
      echoUpperRef.current = chart.addSeries(LineSeries, { color: 'rgba(56,189,248,0.6)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: 'upper' })
      echoLowerRef.current = chart.addSeries(LineSeries, { color: 'rgba(56,189,248,0.6)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: 'lower' })
    } else if (chartType === 'kagiOverlay') {
      // The ribbon itself: two sparse native LineSeries in pane 0 (same
      // price scale as the dimmed candles above), split by Kagi leg
      // direction so the zig-zag still reads via color the way kagiChart()'s
      // pseudo-candles do - each series only carries points for candles
      // currently in ITS direction (computeKagiOverlaySeries' per-candle
      // walk), leaving a natural gap at every reversal. Thickness (yang/yin)
      // is the one thing dropped from this client-side mirror - same
      // honestly-stated simplification kagiChart() already makes.
      kagiOverlayUpRef.current = chart.addSeries(LineSeries, { color: 'rgba(16,185,129,0.95)', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: 'kagi' })
      kagiOverlayDownRef.current = chart.addSeries(LineSeries, { color: 'rgba(244,63,94,0.95)', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: 'kagi' })
    }

    return () => {
      chart.remove()
      chartRef.current = null
      priceSeriesRef.current = null
      volRef.current = null
      hvLineRef.current = null
      ivLineRef.current = null
      springBaselineRef.current = null
      echoBaselineRef.current = null
      echoUpperRef.current = null
      echoLowerRef.current = null
      kagiOverlayUpRef.current = null
      kagiOverlayDownRef.current = null
      overlayRefs.current.clear()
      entryLineRefs.current.clear()
      markersRef.current = null
      indMarkersRef.current = []
      tradeMarkersRef.current = []
      swingMarkersRef.current = []
      memoryMarkersRef.current = []
      springMarkersRef.current = []
      echoMarkersRef.current = []
      renderStateRef.current = null
    }
  }, [chartType])

  // price + volume data. Incremental by default (series.update() - O(1)):
  // any bar-for-bar builder - plain candles/heikin/tickchart/ivhv's base
  // candles, AND renko/pointFigure/rangeBars/volumeBars now that their brick/
  // box/range size is frozen for the currently-forming bar (see renkoStep/
  // pfStep/rangeStep/scanIncremental above) - can always tell "forming bar
  // ticked, same last point" (last time unchanged) and "exactly one new bar
  // landed before the cap" (length +1, same prior last time now second-to-
  // last) apart from a genuine reshape, and handle both with update().
  // Falls back to the old full setData() for everything else: first paint,
  // chart-type/asset switch, the capped candle buffer actually rolling (once
  // per bar after the buffer fills, not once per tick), OR - specific to the
  // synthetic brick/box/bar series - a tick RETRACTING part of the still-
  // forming bar's output (price pulls back enough that the live candle now
  // paints fewer bricks than the previous tick did): that always changes the
  // new last point's time away from what was last rendered, so it's caught
  // by the same two checks below and safely falls through to setData()
  // rather than silently under-updating.
  useEffect(() => {
    const price = priceSeriesRef.current
    const vol = volRef.current
    if (!price || !vol || displayCandles.length === 0) return
    const last = displayCandles[displayCandles.length - 1]
    const prev = renderStateRef.current
    const volBarFor = (c: Candle) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? 'rgba(16,185,129,0.30)' : 'rgba(244,63,94,0.30)' })
    const isLineLike = chartType === 'line' || chartType === 'area' || chartType === 'baseline'
    const priceBarFor = (c: Candle) => (isLineLike ? { time: c.time as UTCTimestamp, value: c.close } : { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })

    if (prev) {
      if (last.time === prev.lastTime) {
        // the forming bar just ticked - replace just the last point
        ;(price as ISeriesApi<'Line'>).update(priceBarFor(last) as never)
        vol.update(volBarFor(last))
        renderStateRef.current = { len: displayCandles.length, lastTime: last.time }
        return
      }
      if (last.time > prev.lastTime && displayCandles.length === prev.len + 1) {
        // exactly one new bar landed and the buffer hasn't rolled yet - append
        ;(price as ISeriesApi<'Line'>).update(priceBarFor(last) as never)
        vol.update(volBarFor(last))
        renderStateRef.current = { len: displayCandles.length, lastTime: last.time }
        return
      }
      // anything else (buffer rolled, time went backwards, length jumped by
      // more than one) - fall through to the full rebuild below
    }

    if (isLineLike) {
      ;(price as ISeriesApi<'Line'>).setData(displayCandles.map(priceBarFor) as { time: UTCTimestamp; value: number }[])
    } else {
      ;(price as unknown as ISeriesApi<'Candlestick'>).setData(displayCandles.map(priceBarFor) as never)
    }
    vol.setData(displayCandles.map(volBarFor))
    renderStateRef.current = { len: displayCandles.length, lastTime: last.time }
  }, [displayCandles, chartType])

  // ---------- yesterday-echo click-through ----------
  // The panel asks the page for a deep candle load + a scroll onto the replay
  // window. The range applies only once the matching candles actually land
  // (the deep fetch resolves after the focus prop arrives), then it is
  // consumed - so later data updates never yank the operator's viewport.
  // Declared AFTER the data effect: same-commit ordering puts the scroll
  // behind the setData that gives it something to scroll onto.
  const pendingFocusRef = useRef<{ from: number; to: number; nonce: number } | null>(null)
  useEffect(() => {
    pendingFocusRef.current = focus ?? null
  }, [focus])
  useEffect(() => {
    const f = pendingFocusRef.current
    if (!f || displayCandles.length === 0 || !chartRef.current) return
    const ts = chartRef.current.timeScale()
    if (!ts) return
    pendingFocusRef.current = null
    try {
      ts.setVisibleRange({ from: Math.floor(f.from) as UTCTimestamp, to: Math.ceil(f.to) as UTCTimestamp })
    } catch {
      // range outside the remembered data (fresh boot, thin archive) - the
      // zoom/fit controls still work from wherever it lands
    }
  }, [displayCandles, chartType])

  // IV vs HV pane data (fetched from /iv_hv; kernel = engine of record).
  // IV proxy times are float epoch - lightweight-charts wants int seconds.
  useEffect(() => {
    const hv = hvLineRef.current
    const iv = ivLineRef.current
    if (!hv || !iv || !ivhvState) return
    hv.setData(
      ivhvState.hv
        .filter((p) => Number.isFinite(p.hv))
        .map((p) => ({ time: p.time as UTCTimestamp, value: p.hv }))
    )
    iv.setData(
      ivhvState.iv
        .filter((p) => Number.isFinite(p.breakevenPct))
        .map((p) => ({ time: Math.floor(p.time) as UTCTimestamp, value: p.breakevenPct }))
    )
  }, [ivhvState, chartType])

  // ---------- Task 63: footprint / TPO custom canvas ----------
  // These two chart types cannot be candlestick pseudo-series; an opaque
  // canvas overlays the lightweight chart. Redraws on data/type/resize.
  useEffect(() => {
    if (
      chartType !== 'footprint' &&
      chartType !== 'tpo' &&
      chartType !== 'otcfootprint' &&
      chartType !== 'tickfootprint' &&
      chartType !== 'volumeprofile' &&
      chartType !== 'deltaprofile' &&
      chartType !== 'pulse' &&
      chartType !== 'expiryRadar' &&
      chartType !== 'expirySurface'
    )
      return
    const canvas = customCanvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const W = parent.clientWidth
      const H = parent.clientHeight
      if (W < 50 || H < 50) return
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      ctx.font = '10px var(--font-geist-mono), monospace'

      if (chartType === 'footprint') {
        const clusters = footprintClusters(candles.slice(-160)).slice(-Math.max(6, Math.floor((W - 70) / 58)))
        if (!clusters.length) return
        const lows = clusters.map((c) => c.low)
        const highs = clusters.map((c) => c.high)
        const pLo = Math.min(...lows)
        const pHi = Math.max(...highs)
        const padT = 12
        const padB = 20
        const y = (p: number) => padT + ((pHi - p) / Math.max(pHi - pLo, 1e-12)) * (H - padT - padB)
        const colW = 58
        const maxRowVol = Math.max(...clusters.flatMap((c) => c.rows.map((r) => r.buy + r.sell)), 1)
        ctx.textAlign = 'center'
        for (let ci = 0; ci < clusters.length; ci++) {
          const cl = clusters[ci]
          const cx = 8 + ci * colW + colW / 2
          // candle skeleton (low..high line + open/close ticks) for orientation
          ctx.strokeStyle = 'rgba(124,138,165,0.4)'
          ctx.beginPath()
          ctx.moveTo(cx, y(cl.high))
          ctx.lineTo(cx, y(cl.low))
          ctx.stroke()
          for (const r of cl.rows) {
            const yTop = y(r.priceHigh)
            const yBot = y(r.priceLow)
            const h = Math.max(2, yBot - yTop - 1)
            const rowVol = r.buy + r.sell
            const w = (rowVol / maxRowVol) * (colW / 2 - 8)
            // sell (left, red) / buy (right, green)
            ctx.fillStyle = 'rgba(244,63,94,0.55)'
            ctx.fillRect(cx - 2 - (w * r.sell) / Math.max(rowVol, 1e-9), yTop, (w * r.sell) / Math.max(rowVol, 1e-9), h)
            ctx.fillStyle = 'rgba(16,185,129,0.55)'
            ctx.fillRect(cx + 2, yTop, (w * r.buy) / Math.max(rowVol, 1e-9), h)
            if (r.imb) {
              ctx.strokeStyle = r.imb === 'buy' ? 'rgba(16,185,129,0.9)' : 'rgba(244,63,94,0.9)'
              ctx.strokeRect(cx - 3 - w / 2, yTop, w + 6, h)
            }
            if (cl.pocMid !== null && r.priceLow <= cl.pocMid && cl.pocMid <= r.priceHigh) {
              ctx.strokeStyle = 'rgba(56,189,248,0.9)'
              ctx.strokeRect(cx - 4 - w / 2, yTop, w + 8, h)
            }
          }
          // per-cluster delta caption
          ctx.fillStyle = cl.delta >= 0 ? UP : DOWN
          ctx.fillText(`${cl.delta >= 0 ? '+' : ''}${Math.round(cl.delta)}`, cx, H - 6)
        }
      } else if (chartType === 'otcfootprint') {
        // OTC velocity footprint: per-minute price-row matrix of the
        // generator's own print stream - left cell = down-ticks at that level
        // (count+avg ms), right cell = up-ticks. Reads /otc_footprint (the
        // kernel's micro-tick buffers), NOT candles - no volume fabrication.
        const buckets = (otcState?.buckets ?? []).filter((b) => b.nTicks > 0)
        if (!buckets.length) {
          ctx.fillStyle = TEXT
          ctx.textAlign = 'center'
          ctx.fillText('no micro-tick prints captured yet for this asset', W / 2, H / 2 - 8)
          ctx.font = '9px var(--font-geist-mono), monospace'
          ctx.fillText('sim feeds print ~1/s, live OTC via the sidecar 100ms capture - wait a minute or two', W / 2, H / 2 + 8)
          return
        }
        const colW = 64
        const maxCols = Math.max(3, Math.floor((W - 24) / colW))
        const vis = buckets.slice(-maxCols)
        const allRows = vis.flatMap((b) => b.rows)
        const pLo = allRows.length ? Math.min(...allRows.map((r) => r.price)) : Math.min(...vis.map((b) => b.low))
        const pHi = allRows.length ? Math.max(...allRows.map((r) => r.price)) : Math.max(...vis.map((b) => b.high))
        const padT = 18
        const padB = 28
        const y = (p: number) => padT + ((pHi - p) / Math.max(pHi - pLo, 1e-12)) * (H - padT - padB)
        const maxTotal = Math.max(...allRows.map((r) => r.total), 1)
        // window-dominant POC - dashed amber guide across the whole chart
        const domPoc = otcState?.summary.dominantPoc ?? 0
        if (domPoc > 0 && domPoc >= pLo && domPoc <= pHi) {
          ctx.strokeStyle = 'rgba(245,158,11,0.5)'
          ctx.setLineDash([4, 3])
          ctx.beginPath()
          ctx.moveTo(8, y(domPoc))
          ctx.lineTo(W - 8, y(domPoc))
          ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = '#f59e0b'
          ctx.textAlign = 'right'
          ctx.fillText(`dominant POC ${fmtPrice(domPoc, digitsTicker)}`, W - 10, y(domPoc) - 3)
        }
        const halfW = colW / 2 - 6
        for (let bi = 0; bi < vis.length; bi++) {
          const b = vis[bi]
          const cx = 12 + bi * colW + colW / 2
          // hi-lo skeleton per bucket for orientation
          ctx.strokeStyle = 'rgba(124,138,165,0.35)'
          ctx.beginPath()
          ctx.moveTo(cx, y(b.high))
          ctx.lineTo(cx, y(b.low))
          ctx.stroke()
          if (b.divergence) {
            ctx.fillStyle = b.divergence === 'put-trap' ? 'rgba(244,63,94,0.95)' : 'rgba(16,185,129,0.95)'
            ctx.textAlign = 'center'
            ctx.fillText(b.divergence === 'put-trap' ? 'CEIL TRAP' : 'FLOOR TRAP', cx, padT - 9)
          } else if (b.exhaustion) {
            ctx.fillStyle = 'rgba(245,158,11,0.9)'
            ctx.textAlign = 'center'
            ctx.fillText(b.exhaustion === 'up' ? 'UP THRUST' : 'DN THRUST', cx, padT - 9)
          }
          const rows = [...b.rows].sort((a, c) => c.price - a.price)
          for (const r of rows) {
            const ry = y(r.price)
            const h = 5
            const dnW = (r.dn / maxTotal) * halfW
            const upW = (r.up / maxTotal) * halfW
            if (r.dn > 0) {
              ctx.fillStyle = 'rgba(244,63,94,0.6)'
              ctx.fillRect(cx - 2 - dnW, ry - h / 2, dnW, h)
            }
            if (r.up > 0) {
              ctx.fillStyle = 'rgba(16,185,129,0.6)'
              ctx.fillRect(cx + 2, ry - h / 2, upW, h)
            }
            if (r.price === b.pocPrice) {
              ctx.strokeStyle = 'rgba(245,158,11,0.95)'
              ctx.strokeRect(cx - 4 - halfW, ry - h / 2 - 1, halfW * 2 + 8, h + 2)
            }
            // count+ms labels when the cell is wide enough to hold them
            ctx.font = '8px var(--font-geist-mono), monospace'
            ctx.fillStyle = 'rgba(219,228,240,0.85)'
            if (r.dn > 0 && dnW >= 24) {
              ctx.textAlign = 'right'
              ctx.fillText(`${r.dn}·${Math.round(r.dnMs)}`, cx - 4, ry + 2.5)
            }
            if (r.up > 0 && upW >= 24) {
              ctx.textAlign = 'left'
              ctx.fillText(`${r.up}·${Math.round(r.upMs)}`, cx + 4, ry + 2.5)
            }
          }
          // bucket captions: clock + velocity delta
          const d = new Date(b.time * 1000)
          ctx.font = '8px var(--font-geist-mono), monospace'
          ctx.fillStyle = TEXT
          ctx.textAlign = 'center'
          ctx.fillText(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, cx, H - 15)
          ctx.fillStyle = b.velDelta > 0 ? UP : b.velDelta < 0 ? DOWN : TEXT
          ctx.fillText(`${b.velDelta >= 0 ? '+' : ''}${b.velDelta}`, cx, H - 5)
        }
      } else if (chartType === 'tickfootprint') {
        // Tick Footprint: MEASURED prints per price bin over tick-chart
        // buckets (/tick_footprint) - real up/down print counts, not the
        // candle footprint's CLV spread. Same visual grammar as the OTC
        // velocity matrix, but the buckets follow the chart timeframe and
        // each bin shows count·avg-ms per side.
        const candlesFp = tickFpState?.candles ?? []
        const visible = candlesFp.filter((c) => c.rows.length > 0)
        if (!tickFpState) {
          ctx.fillStyle = TEXT
          ctx.textAlign = 'center'
          ctx.fillText('loading tick footprint…', W / 2, H / 2)
          return
        }
        if (!visible.length) {
          ctx.fillStyle = TEXT
          ctx.textAlign = 'center'
          ctx.fillText(tickFpState.note ?? 'no closed tick buckets yet', W / 2, H / 2 - 8)
          ctx.font = '9px var(--font-geist-mono), monospace'
          ctx.fillText(`${tickFpState.dataSource} · ${tickFpState.ticks} prints buffered - the footprint bins real up/down prints`, W / 2, H / 2 + 8)
          return
        }
        const colW = 64
        const maxCols = Math.max(3, Math.floor((W - 24) / colW))
        const vis = visible.slice(-maxCols)
        const allRows = vis.flatMap((c) => c.rows)
        const pLo = Math.min(...allRows.map((r) => r.priceLow), ...vis.map((c) => c.low))
        const pHi = Math.max(...allRows.map((r) => r.priceHigh), ...vis.map((c) => c.high))
        const padT = 18
        const padB = 28
        const y = (p: number) => padT + ((pHi - p) / Math.max(pHi - pLo, 1e-12)) * (H - padT - padB)
        const maxTotal = Math.max(...allRows.map((r) => r.up + r.dn), 1)
        const domPoc = tickFpState.summary.dominantPoc
        if (domPoc !== null && domPoc >= pLo && domPoc <= pHi) {
          ctx.strokeStyle = 'rgba(245,158,11,0.5)'
          ctx.setLineDash([4, 3])
          ctx.beginPath()
          ctx.moveTo(8, y(domPoc))
          ctx.lineTo(W - 8, y(domPoc))
          ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = '#f59e0b'
          ctx.textAlign = 'right'
          ctx.fillText(`dominant POC ${fmtPrice(domPoc, digitsTicker)}`, W - 10, y(domPoc) - 3)
        }
        const halfW = colW / 2 - 6
        for (let ci = 0; ci < vis.length; ci++) {
          const c = vis[ci]
          const cx = 12 + ci * colW + colW / 2
          // hi-lo skeleton for orientation
          ctx.strokeStyle = 'rgba(124,138,165,0.35)'
          ctx.beginPath()
          ctx.moveTo(cx, y(c.high))
          ctx.lineTo(cx, y(c.low))
          ctx.stroke()
          // open/close stubs (candle direction hint)
          ctx.strokeStyle = c.close >= c.open ? UP : DOWN
          const openY = y(c.open)
          const closeY = y(c.close)
          ctx.beginPath()
          ctx.moveTo(cx - halfW * 0.5, openY)
          ctx.lineTo(cx + halfW * 0.5, openY)
          ctx.moveTo(cx - halfW * 0.5, closeY)
          ctx.lineTo(cx + halfW * 0.5, closeY)
          ctx.stroke()
          const rows = [...c.rows].sort((a, b2) => b2.mid - a.mid)
          for (const r of rows) {
            const yTop = y(r.priceHigh)
            const yBot = y(r.priceLow)
            const h = Math.max(3, yBot - yTop - 1)
            const tot = r.up + r.dn
            const w = (tot / maxTotal) * halfW
            if (r.dn > 0) {
              ctx.fillStyle = 'rgba(244,63,94,0.6)'
              ctx.fillRect(cx - 2 - (w * r.dn) / Math.max(tot, 1e-9), yTop, (w * r.dn) / Math.max(tot, 1e-9), h)
            }
            if (r.up > 0) {
              ctx.fillStyle = 'rgba(16,185,129,0.6)'
              ctx.fillRect(cx + 2, yTop, (w * r.up) / Math.max(tot, 1e-9), h)
            }
            if (r.imbalance) {
              ctx.strokeStyle = r.imbalance === 'buy' ? 'rgba(16,185,129,0.9)' : 'rgba(244,63,94,0.9)'
              ctx.strokeRect(cx - 3 - w / 2, yTop, w + 6, h)
            }
            if (c.poc !== null && r.priceLow <= c.poc && c.poc <= r.priceHigh) {
              ctx.strokeStyle = 'rgba(245,158,11,0.95)'
              ctx.strokeRect(cx - 4 - w / 2, yTop, w + 8, h)
            }
            ctx.font = '8px var(--font-geist-mono), monospace'
            ctx.fillStyle = 'rgba(219,228,240,0.85)'
            if (r.dn > 0 && w * (r.dn / Math.max(tot, 1e-9)) >= 22) {
              ctx.textAlign = 'right'
              ctx.fillText(`${r.dn}·${Math.round(r.dnMs)}`, cx - 4, yTop + h / 2 + 2.5)
            }
            if (r.up > 0 && w * (r.up / Math.max(tot, 1e-9)) >= 22) {
              ctx.textAlign = 'left'
              ctx.fillText(`${r.up}·${Math.round(r.upMs)}`, cx + 4, yTop + h / 2 + 2.5)
            }
          }
          const d2 = new Date(c.time * 1000)
          ctx.font = '8px var(--font-geist-mono), monospace'
          ctx.fillStyle = TEXT
          ctx.textAlign = 'center'
          ctx.fillText(
            c.time % 60 === 0 ? `${String(d2.getHours()).padStart(2, '0')}:${String(d2.getMinutes()).padStart(2, '0')}` : `${String(d2.getMinutes()).padStart(2, '0')}:${String(d2.getSeconds()).padStart(2, '0')}`,
            cx,
            H - 15,
          )
          ctx.fillStyle = c.delta > 0 ? UP : c.delta < 0 ? DOWN : TEXT
          ctx.fillText(`${c.delta >= 0 ? '+' : ''}${c.delta}`, cx, H - 5)
        }
      } else if (chartType === 'volumeprofile' || chartType === 'deltaprofile') {
        // Volume Profile / Delta Profile: a horizontal histogram over the
        // visible price range - left = dim close path for time orientation
        // (same layout convention TPO's own panel below uses), right = the
        // profile itself. Volume Profile bars run single-direction (volume
        // magnitude only); Delta Profile bars diverge from a center zero
        // line (green = net buy, red = net sell at that price level).
        const win = candles.slice(-400)
        if (win.length < 2) {
          ctx.fillStyle = TEXT
          ctx.textAlign = 'center'
          ctx.fillText('not enough bars yet', W / 2, H / 2)
          return
        }
        const isDelta = chartType === 'deltaprofile'
        const vp = isDelta ? null : volumeProfileBins(win)
        const dp = isDelta ? deltaProfileBins(win) : null
        const rows = isDelta ? dp!.rows : vp!.rows
        if (!rows.length) return
        const pLo = rows[0].priceLow
        const pHi = rows[rows.length - 1].priceHigh
        const padT = 12
        const padB = 20
        const profileW = Math.min(220, W * 0.4)
        const chartW = W - profileW - 24
        const y = (p: number) => padT + ((pHi - p) / Math.max(pHi - pLo, 1e-12)) * (H - padT - padB)
        ctx.strokeStyle = 'rgba(124,138,165,0.35)'
        ctx.beginPath()
        win.forEach((c, i) => {
          const px = 8 + (i / (win.length - 1)) * chartW
          const py = y(c.close)
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        })
        ctx.stroke()
        const binH = Math.max(2, (H - padT - padB) / rows.length)
        if (!isDelta) {
          const prof = vp!
          if (prof.val !== null && prof.vah !== null) {
            ctx.fillStyle = 'rgba(56,189,248,0.08)'
            ctx.fillRect(chartW, y(prof.vah), profileW, y(prof.val) - y(prof.vah))
          }
          const maxVol = Math.max(...rows.map((r) => r.volume), 1e-9)
          rows.forEach((r) => {
            const by = y(r.priceHigh)
            const w = (r.volume / maxVol) * (profileW - 10)
            ctx.fillStyle = 'rgba(56,189,248,0.45)'
            ctx.fillRect(chartW + 6, by, Math.max(w, r.volume > 0 ? 2 : 0), Math.max(1.5, binH - 1))
          })
          if (prof.poc !== null) {
            ctx.strokeStyle = 'rgba(56,189,248,0.9)'
            ctx.setLineDash([4, 3])
            ctx.beginPath()
            ctx.moveTo(8, y(prof.poc))
            ctx.lineTo(chartW + profileW, y(prof.poc))
            ctx.stroke()
            ctx.setLineDash([])
            ctx.fillStyle = '#38bdf8'
            ctx.textAlign = 'left'
            ctx.fillText(`POC ${fmtPrice(prof.poc, digitsTicker)}`, chartW + 8, y(prof.poc) - 4)
          }
          ctx.fillStyle = TEXT
          ctx.textAlign = 'left'
          ctx.font = '9px var(--font-geist-mono), monospace'
          ctx.fillText('volume (approx - range-overlap proxy, no bid/ask feed)', 8, H - 6)
        } else {
          const prof = dp!
          const maxAbs = Math.max(...prof.rows.map((r) => Math.abs(r.delta)), 1e-9)
          const zeroX = chartW + 6 + (profileW - 12) / 2
          const halfW = (profileW - 12) / 2
          prof.rows.forEach((r) => {
            const by = y(r.priceHigh)
            const w = (Math.abs(r.delta) / maxAbs) * halfW
            ctx.fillStyle = r.delta >= 0 ? 'rgba(16,185,129,0.55)' : 'rgba(244,63,94,0.55)'
            if (r.delta >= 0) ctx.fillRect(zeroX, by, Math.max(w, r.delta !== 0 ? 2 : 0), Math.max(1.5, binH - 1))
            else ctx.fillRect(zeroX - w, by, Math.max(w, 2), Math.max(1.5, binH - 1))
          })
          ctx.strokeStyle = 'rgba(124,138,165,0.4)'
          ctx.beginPath()
          ctx.moveTo(zeroX, padT)
          ctx.lineTo(zeroX, H - padB)
          ctx.stroke()
          if (prof.positiveDeltaPoc !== null) {
            ctx.fillStyle = UP
            ctx.textAlign = 'left'
            ctx.fillText(`+POC ${fmtPrice(prof.positiveDeltaPoc, digitsTicker)}`, chartW + 8, y(prof.positiveDeltaPoc) - 4)
          }
          if (prof.negativeDeltaPoc !== null) {
            ctx.fillStyle = DOWN
            ctx.textAlign = 'left'
            ctx.fillText(`-POC ${fmtPrice(prof.negativeDeltaPoc, digitsTicker)}`, chartW + 8, y(prof.negativeDeltaPoc) + 11)
          }
          ctx.fillStyle = prof.deltaSkew >= 0 ? UP : DOWN
          ctx.textAlign = 'left'
          ctx.font = '10px var(--font-geist-mono), monospace'
          ctx.fillText(`skew ${prof.deltaSkew >= 0 ? '+' : ''}${(prof.deltaSkew * 100).toFixed(1)}%`, 8, H - 18)
          ctx.fillStyle = TEXT
          ctx.font = '9px var(--font-geist-mono), monospace'
          ctx.fillText('delta (approx - CLV buy/sell proxy, no bid/ask feed)', 8, H - 6)
        }
      } else if (chartType === 'pulse') {
        // Pulse-Vector: fixed self-contained column layout (same convention
        // otcfootprint/tickfootprint use above - not synced to the price
        // chart's own time axis), one column per bundled bar
        // (/pulse_bars, live-tick only): vector LENGTH = |displacement|,
        // node THICKNESS = tickCount (density), color HEAT-MAP = the
        // direction+acceleration label the kernel engine already computes
        // (bright accel-* vs dim decel-* vs gray flat) - the exact 3 visual
        // mechanics the Pulse-Vector design doc specified, all backed by
        // real tick data, no new math invented here.
        const bars = pulseState?.bars ?? []
        if (!bars.length) {
          ctx.fillStyle = TEXT
          ctx.textAlign = 'center'
          ctx.fillText('no live ticks captured yet for this asset', W / 2, H / 2 - 8)
          ctx.font = '9px var(--font-geist-mono), monospace'
          ctx.fillText('Pulse-Vector is live-only - no historical tick archive to fall back to', W / 2, H / 2 + 8)
          return
        }
        const colW = 26
        const maxCols = Math.max(4, Math.floor((W - 16) / colW))
        const vis = bars.slice(-maxCols)
        const maxDisp = Math.max(...vis.map((b) => Math.abs(b.displacement)), 1e-9)
        const maxTicks = Math.max(...vis.map((b) => b.tickCount), 1)
        const midY = H / 2
        const maxHalfH = (H - 40) / 2
        const colorFor = (c: PulseBarRow['color'], sparse: boolean): string => {
          if (sparse) return 'rgba(124,138,165,0.35)'
          switch (c) {
            case 'accel-up': return 'rgba(16,185,129,0.95)'
            case 'decel-up': return 'rgba(16,185,129,0.4)'
            case 'accel-down': return 'rgba(244,63,94,0.95)'
            case 'decel-down': return 'rgba(244,63,94,0.4)'
            default: return 'rgba(124,138,165,0.5)'
          }
        }
        ctx.strokeStyle = 'rgba(124,138,165,0.25)'
        ctx.beginPath()
        ctx.moveTo(8, midY)
        ctx.lineTo(W - 8, midY)
        ctx.stroke()
        for (let i = 0; i < vis.length; i++) {
          const b = vis[i]
          const cx = 10 + i * colW + colW / 2
          const halfLen = (Math.abs(b.displacement) / maxDisp) * maxHalfH
          const thickness = Math.max(2, (b.tickCount / maxTicks) * (colW - 6))
          const up = b.displacement >= 0
          const yTop = up ? midY - halfLen : midY
          const h = Math.max(1.5, halfLen)
          ctx.fillStyle = colorFor(b.color, b.sparse)
          ctx.fillRect(cx - thickness / 2, yTop, thickness, h)
          if (Number.isFinite(b.exhaustionScore) && b.exhaustionScore >= 0.6) {
            ctx.strokeStyle = 'rgba(245,158,11,0.9)'
            ctx.strokeRect(cx - thickness / 2 - 1, yTop - 1, thickness + 2, h + 2)
          }
        }
        ctx.fillStyle = TEXT
        ctx.font = '9px var(--font-geist-mono), monospace'
        ctx.textAlign = 'left'
        ctx.fillText(`${pulseState?.intervalSec ?? 5}s bars · trend ${pulseState?.trend ?? 'none'} · streak ${pulseState?.streak ?? 0} · amber outline = exhaustion >= 0.6`, 8, H - 6)
      } else if (chartType === 'expiryRadar') {
        // Expiry-Horizon Radar: a purely visual re-presentation of price vs.
        // time-to-expiry - NO new backend engine, no MSL namespace (see
        // client.ts's ChartType doc comment). The "lap" length is this
        // chart's own selected timeframe (labeled honestly below, not a
        // separate configurable expiry this chart doesn't otherwise know
        // about); the "strike" (center) is the entry price at the start of
        // the CURRENT lap - the close of the last candle before it, or that
        // lap's own first open if none exists yet. Angle = elapsed/lap x
        // 360 clockwise from 12 o'clock; radius = price distance from
        // strike, scaled by the lap's own trailing range so the spiral
        // always fits the canvas regardless of instrument/volatility.
        const lapSec = Math.max(1, TIMEFRAME_SECONDS[tf ?? '1m'] ?? 60)
        const win = candles.slice(-600)
        if (win.length < 2) {
          ctx.fillStyle = TEXT
          ctx.textAlign = 'center'
          ctx.fillText('not enough history yet', W / 2, H / 2)
          return
        }
        const lastTime = win[win.length - 1].time
        const lapStart = Math.floor(lastTime / lapSec) * lapSec
        const lapCandles = win.filter((c) => c.time >= lapStart)
        const priorIdx = win.length - lapCandles.length - 1
        const strike = priorIdx >= 0 ? win[priorIdx].close : lapCandles[0]?.open ?? win[win.length - 1].close
        const cx = W / 2
        const cy = H / 2
        const maxRadius = Math.min(W, H) / 2 - 30
        const devs = lapCandles.map((c) => Math.abs(c.close - strike))
        const scale = Math.max(...devs, 1e-9) * 1.25 || 1e-9
        const angleFor = (t: number) => ((Math.min(Math.max(t - lapStart, 0), lapSec) / lapSec) * 360 - 90) * (Math.PI / 180)
        const radiusFor = (price: number) => Math.min(maxRadius, (Math.abs(price - strike) / scale) * maxRadius)
        // clock face: concentric gridlines + 12/3/6/9 o'clock ticks
        ctx.strokeStyle = 'rgba(124,138,165,0.25)'
        for (const frac of [0.33, 0.66, 1]) {
          ctx.beginPath()
          ctx.arc(cx, cy, maxRadius * frac, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.beginPath()
        ctx.moveTo(cx, cy - maxRadius)
        ctx.lineTo(cx, cy + maxRadius)
        ctx.moveTo(cx - maxRadius, cy)
        ctx.lineTo(cx + maxRadius, cy)
        ctx.stroke()
        ctx.fillStyle = '#f59e0b'
        ctx.beginPath()
        ctx.arc(cx, cy, 3, 0, Math.PI * 2)
        ctx.fill()
        // the spiral: price distance from strike, drawn out from center as the lap's clock hand sweeps
        ctx.strokeStyle = 'rgba(56,189,248,0.9)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        lapCandles.forEach((c, i) => {
          const a = angleFor(c.time)
          const r = radiusFor(c.close)
          const px = cx + Math.cos(a) * r
          const py = cy + Math.sin(a) * r
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        })
        ctx.stroke()
        ctx.lineWidth = 1
        // live point + buffer radius readout (distance still available before the hand reaches 12 again)
        const last = lapCandles[lapCandles.length - 1]
        if (last) {
          const a = angleFor(last.time)
          const r = radiusFor(last.close)
          const px = cx + Math.cos(a) * r
          const py = cy + Math.sin(a) * r
          const up = last.close >= strike
          ctx.fillStyle = up ? UP : DOWN
          ctx.beginPath()
          ctx.arc(px, py, 4, 0, Math.PI * 2)
          ctx.fill()
          const elapsed = Math.min(Math.max(last.time - lapStart, 0), lapSec)
          const remainingSec = Math.max(0, lapSec - elapsed)
          ctx.fillStyle = TEXT
          ctx.font = '10px var(--font-geist-mono), monospace'
          ctx.textAlign = 'center'
          ctx.fillText(`strike ${fmtPrice(strike, digitsTicker)} · ${up ? '+' : ''}${(last.close - strike).toFixed(5)} · ${Math.round(remainingSec)}s to lap close`, W / 2, H - 10)
          ctx.fillText(`lap = ${tf ?? '1m'} (${lapSec}s) - not a live trade expiry, just this chart's own timeframe`, W / 2, 16)
        }
      } else if (chartType === 'expirySurface') {
        // Expiry Probability Surface: columns = historical 1m bars (raw/
        // uncalibrated walk-forward replay, /expiry_surface), rows = the 5
        // expiry rungs, color = pUp (red<0.5<green). The LIVE column
        // (/next_expiry - the real, calibration-discounted read) is drawn
        // as its own highlighted strip on the right, visually distinct
        // from the historical replay so the two are never confused.
        const cols = expirySurfaceState?.columns ?? []
        const expiries = expirySurfaceState?.expiries ?? [1, 2, 3, 5, 15]
        if (!cols.length && !liveExpiryState) {
          ctx.fillStyle = TEXT
          ctx.textAlign = 'center'
          ctx.fillText('warming up - needs 720+ 1m candles for the oracle to read anything', W / 2, H / 2)
          return
        }
        const liveColW = 90
        const padL = 8
        const padR = liveColW + 16
        const padT = 24
        const padB = 24
        const rowH = (H - padT - padB) / expiries.length
        const colW = cols.length ? Math.max(2, (W - padL - padR) / cols.length) : 0
        const pUpColor = (pUp: number, ok: boolean, alpha: number) => {
          if (!ok || !Number.isFinite(pUp)) return `rgba(124,138,165,${alpha * 0.3})`
          const t = Math.min(1, Math.max(0, pUp))
          // red (put-favored) -> amber (coinflip) -> green (call-favored)
          const r = t < 0.5 ? 244 : Math.round(244 - (244 - 16) * ((t - 0.5) * 2))
          const g = t < 0.5 ? Math.round(63 + (158 - 63) * (t * 2)) : Math.round(158 + (185 - 158) * ((t - 0.5) * 2))
          const b = t < 0.5 ? Math.round(94 - (94 - 11) * (t * 2)) : Math.round(11 + (129 - 11) * ((t - 0.5) * 2))
          return `rgba(${r},${g},${b},${alpha})`
        }
        // row labels + gridlines
        ctx.font = '9px var(--font-geist-mono), monospace'
        ctx.textAlign = 'right'
        expiries.forEach((e, ri) => {
          const ry = padT + ri * rowH
          ctx.fillStyle = TEXT
          ctx.fillText(`${e}m`, padL - 2 > 20 ? padL - 2 : 20, ry + rowH / 2 + 3)
          ctx.strokeStyle = 'rgba(124,138,165,0.15)'
          ctx.beginPath()
          ctx.moveTo(20, ry)
          ctx.lineTo(W - padR + liveColW, ry)
          ctx.stroke()
        })
        // historical heatmap cells
        cols.forEach((col, ci) => {
          const cx = padL + 22 + ci * colW
          col.cells.forEach((cell) => {
            const ri = expiries.indexOf(cell.expiry)
            if (ri < 0) return
            ctx.fillStyle = pUpColor(cell.pUp, cell.ok, 0.85)
            ctx.fillRect(cx, padT + ri * rowH, Math.max(1, colW - 0.5), rowH - 1)
          })
        })
        // live column - distinctly bordered, drawn from the REAL calibrated read
        const liveX = W - liveColW + 4
        ctx.strokeStyle = 'rgba(245,158,11,0.9)'
        ctx.strokeRect(liveX - 4, padT - 2, liveColW, H - padT - padB + 4)
        ctx.font = '9px var(--font-geist-mono), monospace'
        ctx.fillStyle = '#f59e0b'
        ctx.textAlign = 'center'
        ctx.fillText('LIVE (calibrated)', liveX + liveColW / 2 - 4, padT - 8)
        if (liveExpiryState) {
          liveExpiryState.rows.forEach((row) => {
            const ri = expiries.indexOf(row.expiry)
            if (ri < 0) return
            const ry = padT + ri * rowH
            ctx.fillStyle = pUpColor(row.pUp, row.ok, 0.9)
            ctx.fillRect(liveX, ry, liveColW - 8, rowH - 1)
            ctx.fillStyle = '#0b111c'
            ctx.font = '9px var(--font-geist-mono), monospace'
            ctx.textAlign = 'center'
            ctx.fillText(row.ok ? `${Math.round(row.pWin * 100)}%` : '-', liveX + (liveColW - 8) / 2, ry + rowH / 2 + 3)
          })
        }
        ctx.font = '9px var(--font-geist-mono), monospace'
        ctx.fillStyle = TEXT
        ctx.textAlign = 'left'
        ctx.fillText('left of the amber border: raw/uncalibrated historical replay - the oracle\'s honesty-discount only exists live', 8, H - 8)
      } else {
        // TPO: left = close path for time orientation, right = profile
        const prof = tpoProfile(candles.slice(-400))
        if (!prof.bins.length) return
        const pLo = prof.bins[0].priceLow
        const pHi = prof.bins[prof.bins.length - 1].priceHigh
        const padT = 12
        const padB = 20
        const profileW = Math.min(190, W * 0.32)
        const chartW = W - profileW - 24
        const y = (p: number) => padT + ((pHi - p) / Math.max(pHi - pLo, 1e-12)) * (H - padT - padB)
        // close path (dim)
        const win = candles.slice(-400)
        if (win.length >= 2) {
          ctx.strokeStyle = 'rgba(124,138,165,0.35)'
          ctx.beginPath()
          win.forEach((c, i) => {
            const px = 8 + (i / (win.length - 1)) * chartW
            const py = y(c.close)
            if (i === 0) ctx.moveTo(px, py)
            else ctx.lineTo(px, py)
          })
          ctx.stroke()
        }
        // value area shading + profile bars
        const vaLoY = prof.vaLow !== null ? y(prof.vaLow) : 0
        const vaHiY = prof.vaHigh !== null ? y(prof.vaHigh) : 0
        ctx.fillStyle = 'rgba(56,189,248,0.08)'
        ctx.fillRect(chartW, Math.min(vaHiY, vaLoY), profileW, Math.abs(vaLoY - vaHiY))
        const binH = Math.max(2, (H - padT - padB) / prof.bins.length)
        const maxT = Math.max(...prof.bins.map((b) => b.tpos), 1)
        prof.bins.forEach((b, bi) => {
          const by = y(b.priceHigh)
          const w = (b.tpos / maxT) * (profileW - 44)
          ctx.fillStyle = b.inVA ? 'rgba(56,189,248,0.45)' : 'rgba(124,138,165,0.30)'
          ctx.fillRect(chartW + 34, by, Math.max(w, b.tpos > 0 ? 2 : 0), Math.max(1.5, binH - 1))
          // period letters (first 6) - display sugar
          void bi
        })
        // POC line
        if (prof.poc !== null) {
          ctx.strokeStyle = 'rgba(56,189,248,0.9)'
          ctx.setLineDash([4, 3])
          ctx.beginPath()
          ctx.moveTo(8, y(prof.poc))
          ctx.lineTo(chartW + profileW, y(prof.poc))
          ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = '#38bdf8'
          ctx.textAlign = 'left'
          ctx.fillText(`POC ${fmtPrice(prof.poc, digitsTicker)}`, chartW + profileW - 110, y(prof.poc) - 4)
        }
        // IB bracket
        if (prof.ibHigh !== null && prof.ibLow !== null) {
          ctx.strokeStyle = 'rgba(245,158,11,0.7)'
          ctx.beginPath()
          ctx.moveTo(chartW, y(prof.ibHigh))
          ctx.lineTo(chartW + 30, y(prof.ibHigh))
          ctx.moveTo(chartW, y(prof.ibLow))
          ctx.lineTo(chartW + 30, y(prof.ibLow))
          ctx.stroke()
        }
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(parent)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
    // keyed on closedBarSignature, not raw `candles` (see its own doc
    // comment above) - `candles` is still read fresh via closure when this
    // DOES run, just not used to decide whether it reruns.
  }, [chartType, closedBarSignature, digitsTicker, otcState, tickFpState, pulseState, tf, expirySurfaceState, liveExpiryState])

  // live precision sync: asset switch or a quote crossing a magnitude band
  useEffect(() => {
    const key = `${digitsTicker}:${priceFmt.precision}`
    if (priceFmtKeyRef.current === key) return
    priceFmtKeyRef.current = key
    priceSeriesRef.current?.applyOptions({ priceFormat: priceFmt })
  }, [priceFmt, digitsTicker])

  // registry overlays: create/remove line series on the live chart. The
  // 'dots' style renders traditional point markers (Parabolic SAR) with no
  // connecting line via the series' point-marker options.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const seen = new Set<string>()
    for (const s of overlays) {
      s.lines.forEach((ln, i) => {
        const key = `${s.id}:${s.lines[i]?.key}:${i}`
        seen.add(key)
        let series = overlayRefs.current.get(key)
        if (!series) {
          const isDots = ln.style === 'dots'
          series = chart.addSeries(LineSeries, {
            color: ln.color,
            lineWidth: (ln.width ?? 1) as LineWidth,
            lineVisible: !isDots,
            pointMarkersVisible: isDots,
            pointMarkersRadius: isDots ? 1 : undefined,
            lineStyle: lineStyleMap[ln.style ?? 'solid'] ?? LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: false,
          })
          overlayRefs.current.set(key, series)
        }
        series.setData(
          s.time
            .map((t, ti) => ({ time: t as UTCTimestamp, value: ln.values[ti] }))
            .filter((p) => p.value !== null && Number.isFinite(p.value as number)) as { time: UTCTimestamp; value: number }[]
        )
        series.applyOptions({ visible: true })
      })
    }
    // remove stale
    for (const [key, series] of overlayRefs.current) {
      if (!seen.has(key)) {
        try {
          chart.removeSeries(series)
        } catch {
          // chart already torn down
        }
        overlayRefs.current.delete(key)
      }
    }
  }, [overlays, chartType])

  // single markers plugin on the price series; indicator arrows (fractals)
  // and trade entry/settle markers both feed the same payload
  const ensureMarkerApi = useCallback(() => {
    const series = priceSeriesRef.current
    if (!series) return null
    if (!markersRef.current || markersRef.current.series !== series) {
      markersRef.current = { series, api: createSeriesMarkers(series, []) }
    }
    return markersRef.current.api
  }, [])

  const applyMarkers = useCallback(() => {
    if (!markersRef.current) return
    const all = [...indMarkersRef.current, ...tradeMarkersRef.current, ...swingMarkersRef.current, ...memoryMarkersRef.current, ...springMarkersRef.current, ...echoMarkersRef.current, ...kagiGlowMarkersRef.current]
    all.sort((a, b) => Number(a.time) - Number(b.time))
    markersRef.current.api.setMarkers(all)
  }, [])

  // Swing point-overlay (Meta-Trader-bug-fix sweep follow-up): confirmed
  // swing highs/lows drawn as markers on the plain candle series, mirroring
  // analytics/swing.ts's fractal-pivot definition client-side
  // (computeSwingClient above) - NOT its own chart type/series, per the
  // design decision recorded in client.ts's ChartType doc comment. Honors
  // the same lookback-confirmation lag the backend engine documents: the
  // most recent `lookback` closed bars never show a marker yet.
  useEffect(() => {
    if (chartType !== 'swing') {
      if (swingMarkersRef.current.length) {
        swingMarkersRef.current = []
        applyMarkers()
      }
      return
    }
    const swings = computeSwingClient(candles, 3)
    const out: SeriesMarker<Time>[] = swings.map((s) => ({
      time: s.time as UTCTimestamp,
      position: s.kind === 'high' ? 'aboveBar' : 'belowBar',
      shape: s.kind === 'high' ? 'arrowDown' : 'arrowUp',
      color: s.kind === 'high' ? DOWN : UP,
      text: s.kind === 'high' ? 'H' : 'L',
      size: 1,
    }))
    swingMarkersRef.current = out
    ensureMarkerApi()
    applyMarkers()
  }, [chartType, candles, ensureMarkerApi, applyMarkers])

  // Historical Outcome Memory marker overlay: the k nearest historical
  // analogs (/outcome_memory's own matches[], real past bars that looked
  // like the current one) marked directly on the plain candle chart at the
  // times they actually happened - "show the trader the raw comparable
  // evidence" rather than only a model's aggregate score (see the small
  // readout panel in the JSX below for the aggregate pUp/pool numbers).
  // Snaps each match time onto the nearest displayed candle, same
  // tolerance snapToCandle() already applies to indicator markers.
  useEffect(() => {
    if (chartType !== 'outcomeMemory') {
      if (memoryMarkersRef.current.length) {
        memoryMarkersRef.current = []
        applyMarkers()
      }
      return
    }
    const matches = outcomeMemState?.matches ?? []
    const out: SeriesMarker<Time>[] = []
    for (const m of matches) {
      const t = snapToCandle(candles, m.time)
      if (t === null) continue
      out.push({
        time: t as UTCTimestamp,
        position: 'belowBar',
        shape: 'circle',
        color: m.outcomeDirection === 'up' ? UP : m.outcomeDirection === 'down' ? DOWN : TEXT,
        text: '',
        size: 0.6,
      })
    }
    memoryMarkersRef.current = out
    ensureMarkerApi()
    applyMarkers()
  }, [chartType, candles, outcomeMemState, ensureMarkerApi, applyMarkers])

  // Liquidity Spring / Volatility Echo overlay data - client-side math
  // (computeLiquiditySpringClient()/computeVolatilityEchoClient() above).
  // Full-window recompute per closed bar, same tradeoff mrcChart() accepts.
  // Snap/pierce events feed marker dots through the same applyMarkers() pipeline.
  useEffect(() => {
    if (chartType === 'spring') {
      const base = springBaselineRef.current
      if (!base) return
      const pts = computeLiquiditySpringClient(candles)
      base.setData(pts.map((p) => ({ time: p.time as UTCTimestamp, value: p.baseline })))
      springMarkersRef.current = pts
        .filter((p) => p.snap)
        .map((p) => ({ time: p.time as UTCTimestamp, position: p.snapUp ? 'aboveBar' : 'belowBar', shape: p.snapUp ? 'arrowDown' : 'arrowUp', color: p.snapUp ? DOWN : UP, text: 'snap', size: 1 }))
      ensureMarkerApi()
      applyMarkers()
    } else if (chartType === 'echo') {
      const base = echoBaselineRef.current
      const up = echoUpperRef.current
      const lo = echoLowerRef.current
      if (!base || !up || !lo) return
      const pts = computeVolatilityEchoClient(candles)
      base.setData(pts.map((p) => ({ time: p.time as UTCTimestamp, value: p.baseline })))
      up.setData(pts.map((p) => ({ time: p.time as UTCTimestamp, value: p.upper })))
      lo.setData(pts.map((p) => ({ time: p.time as UTCTimestamp, value: p.lower })))
      echoMarkersRef.current = pts
        .filter((p) => p.pierced)
        .map((p) => ({ time: p.time as UTCTimestamp, position: p.pierced === 'up' ? 'aboveBar' : 'belowBar', shape: p.pierced === 'up' ? 'arrowUp' : 'arrowDown', color: p.pierced === 'up' ? UP : DOWN, text: '', size: 1 }))
      ensureMarkerApi()
      applyMarkers()
    } else if (springMarkersRef.current.length || echoMarkersRef.current.length) {
      springMarkersRef.current = []
      echoMarkersRef.current = []
      applyMarkers()
    }
  }, [chartType, closedBarSignature, candles, ensureMarkerApi, applyMarkers])

  // Time-Anchored Kagi Overlay ribbon data - computeKagiOverlaySeries()'
  // continuous per-candle walk, split by leg direction into the two sparse
  // LineSeries created above (a natural gap opens at every reversal, which
  // is what makes the color flip read as a zig-zag rather than one solid
  // line). Tick-velocity glow: reuses Pulse-Vector's OWN already-computed
  // velocity (pulseState, polled above whenever this chart type is active)
  // to mark the ribbon's live tip whenever that bar's velocity is running
  // well above its own trailing average - the same "surge, still extending"
  // signal pulsebars.ts's exhaustionScore is built from, just read here as
  // "how fast is the tip moving right now" rather than "how much has that
  // speed fallen off." Honestly absent (no marker at all) whenever no live
  // tick buffer resolved - never a fabricated glow on a backtest/history view.
  useEffect(() => {
    if (chartType !== 'kagiOverlay') {
      if (kagiGlowMarkersRef.current.length) {
        kagiGlowMarkersRef.current = []
        applyMarkers()
      }
      return
    }
    const up = kagiOverlayUpRef.current
    const down = kagiOverlayDownRef.current
    if (!up || !down) return
    const pts = computeKagiOverlaySeries(candles)
    const upData = pts.filter((p) => p.dir === 1).map((p) => ({ time: p.time as UTCTimestamp, value: p.price }))
    const downData = pts.filter((p) => p.dir === -1).map((p) => ({ time: p.time as UTCTimestamp, value: p.price }))
    up.setData(upData)
    down.setData(downData)

    const bars = pulseState?.bars ?? []
    const tip = pts[pts.length - 1]
    if (tip && bars.length >= 6) {
      const last = bars[bars.length - 1]
      const trail = bars.slice(-6, -1)
      const avgV = trail.reduce((s, b) => s + Math.abs(b.velocity), 0) / Math.max(trail.length, 1)
      const ratio = avgV > 1e-9 ? Math.abs(last.velocity) / avgV : 1
      if (Number.isFinite(ratio) && ratio >= 1.3) {
        const t = snapToCandle(candles, tip.time)
        kagiGlowMarkersRef.current = t === null
          ? []
          : [{ time: t as UTCTimestamp, position: tip.dir === 1 ? 'aboveBar' : 'belowBar', shape: 'circle', color: tip.dir === 1 ? UP : DOWN, text: 'velocity', size: Math.min(2, 0.8 + ratio / 3) }]
      } else {
        kagiGlowMarkersRef.current = []
      }
    } else {
      kagiGlowMarkersRef.current = []
    }
    ensureMarkerApi()
    applyMarkers()
  }, [chartType, closedBarSignature, candles, pulseState, ensureMarkerApi, applyMarkers])

  // registry indicator markers (Williams fractal arrows) - times snap to the
  // displayed candle grid (heikin/renko remap times), then merge via applyMarkers
  useEffect(() => {
    const out: SeriesMarker<Time>[] = []
    for (const s of overlays) {
      for (const m of s.markers ?? []) {
        const t = snapToCandle(displayCandles, m.time)
        if (t === null) continue
        out.push({
          time: t,
          position: m.position,
          shape: m.shape,
          color: m.color,
          text: m.text,
          size: m.size ?? 1,
        })
      }
    }
    indMarkersRef.current = out
    ensureMarkerApi()
    applyMarkers()
  }, [overlays, displayCandles, chartType, ensureMarkerApi, applyMarkers])

  // trade overlay: one dashed price line per open position on this asset
  // (green CALL / red PUT, titled with kind + stake + expiry countdown) and
  // markers pinning entries - arrows for open trades, faded arrows + a
  // settle circle with P&L for the most recent settled trades, so bar-count
  // expiries and outcomes are readable straight off the chart. Lines re-
  // attach after chart-type switches and drop when trades settle or the
  // operator switches asset.
  useEffect(() => {
    const series = priceSeriesRef.current
    if (!series) return
    const lastT = displayCandles.length ? displayCandles[displayCandles.length - 1].time : 0
    const open = (positions ?? []).filter((p) => p.status === 'open' && p.asset === digitsTicker)
    const seen = new Set<string>()
    for (const p of open) {
      seen.add(p.id)
      const isCall = p.side === 'call'
      // expiry countdown: bars for binary/turbo (settle on the close of the
      // expiry bar), seconds for digital, none for CFD
      let countdown = ''
      if (p.kind !== 'cfd' && lastT > 0 && tfSec > 0) {
        if (p.kind === 'digital' && p.expirySec) {
          countdown = ` · T-${Math.max(0, Math.round(p.tsOpen + p.expirySec - lastT))}s`
        } else if (p.expiryBars) {
          const barsSince = Math.max(0, Math.round((lastT - p.tsOpen) / tfSec))
          countdown = ` · T-${Math.max(0, p.expiryBars - barsSince)}`
        }
      }
      const title = `${isCall ? '▲ CALL' : '▼ PUT'} ${p.kind} $${p.amount}${countdown}`
      const existing = entryLineRefs.current.get(p.id)
      if (existing && existing.series === series && existing.title === title) continue
      if (existing) {
        if (existing.series === series && existing.price === p.entryPrice) {
          existing.line.applyOptions({ title }) // countdown tick - keep the line
          entryLineRefs.current.set(p.id, { ...existing, title })
          continue
        }
        try {
          existing.series.removePriceLine(existing.line)
        } catch {
          // chart already torn down
        }
        entryLineRefs.current.delete(p.id)
      }
      const line = series.createPriceLine({
        price: p.entryPrice,
        color: isCall ? UP : DOWN,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title,
      })
      entryLineRefs.current.set(p.id, { series, line, price: p.entryPrice, title })
    }
    for (const [key, entry] of entryLineRefs.current) {
      if (!seen.has(key)) {
        try {
          entry.series.removePriceLine(entry.line)
        } catch {
          // chart already torn down
        }
        entryLineRefs.current.delete(key)
      }
    }

    ensureMarkerApi()
    const markers: SeriesMarker<Time>[] = []
    for (const p of open) {
      const t = snapToCandle(displayCandles, p.tsOpen)
      if (t === null) continue
      const isCall = p.side === 'call'
      markers.push({
        time: t,
        position: isCall ? 'belowBar' : 'aboveBar',
        color: isCall ? UP : DOWN,
        shape: isCall ? 'arrowUp' : 'arrowDown',
        text: `${isCall ? '▲' : '▼'} $${p.amount} ${p.kind}`,
        size: 1,
      })
    }
    // settled feed arrives newest-first (ts_open DESC); review window = 30 most recent
    for (const p of (settledPositions ?? []).filter((q) => q.asset === digitsTicker).slice(0, 30)) {
      const col = p.pnl === undefined ? '#7c8aa5' : p.pnl > 0 ? UP : p.pnl < 0 ? DOWN : '#7c8aa5'
      const isCall = p.side === 'call'
      const entryT = snapToCandle(displayCandles, p.tsOpen)
      if (entryT !== null) {
        markers.push({
          time: entryT,
          position: isCall ? 'belowBar' : 'aboveBar',
          color: col,
          shape: isCall ? 'arrowUp' : 'arrowDown',
          text: `${isCall ? '▲' : '▼'} $${p.amount}`,
          size: 1,
        })
      }
      const exitT = p.tsClose ? snapToCandle(displayCandles, p.tsClose) : null
      if (exitT !== null) {
        markers.push({
          time: exitT,
          position: isCall ? 'aboveBar' : 'belowBar',
          color: col,
          shape: 'circle',
          text: `■ ${p.pnl === undefined ? '' : `${p.pnl >= 0 ? '+' : '-'}$${Math.abs(p.pnl).toFixed(2)}`}`,
          size: 1,
        })
      }
    }
    tradeMarkersRef.current = markers
    applyMarkers()
  }, [positions, settledPositions, digitsTicker, chartType, displayCandles, tfSec, ensureMarkerApi, applyMarkers])

  const lastCandle = candles[candles.length - 1]
  const lastUp = lastCandle ? lastCandle.close >= lastCandle.open : true

  // zoom controls: scale the visible logical range around its center
  const zoomBy = (factor: number) => {
    const ts = chartRef.current?.timeScale()
    if (!ts) return
    const r = ts.getVisibleLogicalRange()
    if (!r) return
    const center = (r.from + r.to) / 2
    const half = Math.max(((r.to - r.from) / 2) * factor, 1.5)
    ts.setVisibleLogicalRange({ from: center - half, to: center + half })
  }
  // Liquidity levels overlay (LVL toggle): previous day / week highs & lows, today's range and the latest Asia / London / New York session ranges as
  // horizontal price lines (red = highs, green = lows, dim dotted = swept, amber = swept then closed back inside). Fetched from the kernel's /levels
  // (5m history, ~7 days), refreshed every 60s, removed when toggled off, when the asset changes or the series is rebuilt.
  const [showLevels, setShowLevels] = useState(false)
  const levelLinesRef = useRef<{ series: AnyPriceSeries; line: IPriceLine }[]>([])
  useEffect(() => {
    const clearLines = () => {
      for (const l of levelLinesRef.current) {
        try {
          l.series.removePriceLine(l.line)
        } catch {
          // chart already torn down
        }
      }
      levelLinesRef.current = []
    }
    if (!showLevels) {
      clearLines()
      return
    }
    let alive = true
    const draw = () =>
      getDayLevels(digitsTicker, '5m')
        .then((d) => {
          const series = priceSeriesRef.current
          if (!alive || !series) return
          clearLines()
          if (!d.ok || !d.levels) return
          for (const l of d.levels) {
            const isHigh = /HIGH|PDH|PWH/.test(l.id)
            const rejected = l.rejectedBar !== null
            const color = l.swept ? (rejected ? '#f59e0b' : '#4b5a72') : isHigh ? '#fb7185' : '#34d399'
            const line = series.createPriceLine({
              price: l.price,
              color,
              lineWidth: 1,
              lineStyle: l.swept ? LineStyle.Dotted : LineStyle.Dashed,
              axisLabelVisible: !l.swept || rejected,
              title: `${l.id.replace('_', ' ')}${l.swept ? (rejected ? ' (swept, rejected)' : ' (swept)') : ''}`,
            })
            levelLinesRef.current.push({ series, line })
          }
        })
        .catch(() => {})
    void draw()
    const t = setInterval(draw, 60_000)
    return () => {
      alive = false
      clearInterval(t)
      clearLines()
    }
  }, [showLevels, digitsTicker, chartType])

  const fitChart = () => {
    chartRef.current?.timeScale().fitContent()
    chartRef.current?.timeScale().scrollToRealTime()
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      {/* zoom controls (left of the price scale) */}
      <div className="absolute bottom-10 right-[60px] z-10 flex flex-col gap-1">
        <button
          onClick={() => setShowLevels((v) => !v)}
          title="Liquidity levels: previous day / week highs & lows, today's range and the latest Asia / London / New York session ranges (red = highs, green = lows, dim dotted = swept, amber = swept then closed back inside). 5m history, fixed UTC sessions."
          className={`flex h-6 w-6 items-center justify-center rounded border font-mono text-[8px] font-bold leading-none transition-colors ${
            showLevels ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300' : 'border-[#1c2739] bg-[#0d1420]/90 text-[#7c8aa5] hover:border-cyan-500/40'
          }`}
        >
          LVL
        </button>
        <button
          onClick={() => zoomBy(0.7)}
          title="Zoom in"
          className="flex h-6 w-6 items-center justify-center rounded border border-[#1c2739] bg-[#0d1420]/90 font-mono text-[13px] font-bold leading-none text-[#7c8aa5] transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
        >
          +
        </button>
        <button
          onClick={() => zoomBy(1.4)}
          title="Zoom out"
          className="flex h-6 w-6 items-center justify-center rounded border border-[#1c2739] bg-[#0d1420]/90 font-mono text-[13px] font-bold leading-none text-[#7c8aa5] transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
        >
          −
        </button>
        <button
          onClick={fitChart}
          title="Fit chart"
          className="flex h-6 w-6 items-center justify-center rounded border border-[#1c2739] bg-[#0d1420]/90 text-[11px] leading-none text-[#7c8aa5] transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
        >
          ⤢
        </button>
      </div>

      <div ref={elRef} className="min-h-0 flex-1" />
      {(chartType === 'footprint' || chartType === 'tpo' || chartType === 'otcfootprint' || chartType === 'tickfootprint' || chartType === 'volumeprofile' || chartType === 'deltaprofile' || chartType === 'pulse' || chartType === 'expiryRadar' || chartType === 'expirySurface') && (
        <div className="absolute inset-x-0 bottom-[30px] top-0 z-[5] bg-[#0b111c]">
          <canvas ref={customCanvasRef} className="block h-full w-full" />
        </div>
      )}
      {chartType === 'outcomeMemory' && outcomeMemState && (
        <div className="absolute right-2 top-2 z-[5] max-w-[220px] rounded border border-[#1c2739] bg-[#0d1420]/92 px-2.5 py-2 text-[10px] font-mono leading-tight text-[#dbe4f0]">
          <div className="mb-1 text-[#7c8aa5]">Historical Outcome Memory</div>
          {outcomeMemState.poolSize > 0 ? (
            <>
              <div>
                pUp <span className={outcomeMemState.pUp >= 0.5 ? 'text-emerald-400' : 'text-rose-400'}>{(outcomeMemState.pUp * 100).toFixed(1)}%</span>
                {' · '}pool {outcomeMemState.poolSize}
              </div>
              <div className="text-[#7c8aa5]">
                {outcomeMemState.upCount}↑ / {outcomeMemState.downCount}↓ / {outcomeMemState.flatCount}→
              </div>
              <div className="text-[#7c8aa5]">
                avg {(outcomeMemState.avgReturn * 100).toFixed(2)}% · k={outcomeMemState.k} · {outcomeMemState.session}
              </div>
            </>
          ) : (
            <div className="text-[#7c8aa5]">{outcomeMemState.note}</div>
          )}
        </div>
      )}
      <div className="flex items-center justify-between border-t border-[#1c2739] px-3 py-1.5 text-[11px] font-mono">
        <span className={lastUp ? 'text-emerald-400' : 'text-rose-400'}>
          {fmtPrice(price, digitsTicker)} <span className="text-[#4b5a72]">last</span>
        </span>
        {analysis && (
          <span className="text-[#4b5a72]">
            {analysis.asset} · {analysis.tf} · {chartType} · {candles.length} bars ·{' '}
            <span className={analysis.changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {analysis.changePct >= 0 ? '+' : ''}
              {analysis.changePct.toFixed(2)}%
            </span>
          </span>
        )}
      </div>
    </div>
  )
}
