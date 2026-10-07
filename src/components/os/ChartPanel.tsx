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
import type { AnalysisResult, Candle, ChartType, IndicatorSeries, IvHvResponse, Position, TickBarRow, TicksResponse, Timeframe } from '@/lib/os/client'
import { chartPriceFormat, fmtPrice, osGet } from '@/lib/os/client'

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

function renko(candles: Candle[], tfSec: number): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-150)
  // brick size = 30% of average true range of the window
  let trSum = 0
  for (let i = 1; i < window.length; i++) {
    trSum += Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close)
    )
  }
  const brick = Math.max((trSum / Math.max(window.length - 1, 1)) * 0.3, 1e-9)
  const bricks: Candle[] = []
  let lastClose = window[0].close
  let refPrice = lastClose
  // Task 61: HONEST brick times - a brick's time is the open time of the
  // candle that COMPLETED it (the moment the brick became knowable), not a
  // fictional countdown from the last candle. When one candle completes
  // several bricks, extras stagger +1s (renko bricks have no independent
  // clock; lightweight-charts needs ascending unique times).
  for (const c of window) {
    refPrice = lastClose
    let painted = 0
    while (c.close >= refPrice + brick) {
      bricks.push({ time: c.time + painted, open: refPrice, high: refPrice + brick, low: refPrice, close: refPrice + brick, volume: 0 })
      painted++
      refPrice += brick
      lastClose = refPrice
    }
    while (c.close <= refPrice - brick) {
      bricks.push({ time: c.time + painted, open: refPrice, high: refPrice, low: refPrice - brick, close: refPrice - brick, volume: 0 })
      painted++
      refPrice -= brick
      lastClose = refPrice
    }
  }
  // ascending guard (a candle that painted more bricks than its tf has
  // seconds could collide with the next candle's open time)
  for (let i = 1; i < bricks.length; i++) {
    if (bricks[i].time <= bricks[i - 1].time) bricks[i].time = bricks[i - 1].time + 1
  }
  return bricks.slice(-300)
}

/** Point & Figure boxes rendered as pseudo-candles: X boxes paint as up
 * candles (open=box bottom, close=box top), O boxes as down candles, so the
 * classic X/O staircase reads straight off the candlestick series. High/low
 * based, 3-box reversal, absolute box grid - mirrors the kernel engine of
 * record (mini-services/trading-core/src/analytics/pointfigure.ts). Brick
 * times are honest: each box carries the open time of the candle that
 * painted it (+1s stagger for extra boxes in the same candle). */
function pointFigureChart(candles: Candle[], tfSec: number): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-200)
  // box size = 50% of average true range of the window
  let trSum = 0
  for (let i = 1; i < window.length; i++) {
    trSum += Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close)
    )
  }
  const box = Math.max((trSum / Math.max(window.length - 1, 1)) * 0.5, 1e-9)
  const REVERSAL = 3
  const cells: Candle[] = []
  let dir: 'X' | 'O' | null = null
  let top = 0
  let bottom = 0
  const paint = (level: number, d: 'X' | 'O', t: number, seq: number) =>
    cells.push({
      time: t + seq,
      open: d === 'X' ? level : level + box,
      close: d === 'X' ? level + box : level,
      high: level + box,
      low: level,
      volume: 0,
    })
  for (const c of window) {
    const hi = Math.floor(c.high / box)
    const lo = Math.floor(c.low / box)
    let painted = 0
    if (dir === null) {
      dir = 'X'
      top = hi
      bottom = lo
      for (let lvl = bottom; lvl <= top; lvl++) paint(lvl, 'X', c.time, painted++)
      continue
    }
    if (dir === 'X') {
      while (hi > top) {
        top++
        paint(top, 'X', c.time, painted++)
      }
      if (lo <= top - REVERSAL) {
        // reversal: new O column starts one box below the X top box
        const newBottom = Math.min(top - REVERSAL, lo)
        dir = 'O'
        const newTop = top - 1
        for (let lvl = newTop; lvl >= newBottom; lvl--) paint(lvl, 'O', c.time, painted++)
        top = newTop
        bottom = newBottom
      }
    } else {
      while (lo < bottom) {
        bottom--
        paint(bottom, 'O', c.time, painted++)
      }
      if (hi >= bottom + REVERSAL) {
        const newTop = Math.max(bottom + REVERSAL, hi)
        dir = 'X'
        const newBottom = bottom + 1
        for (let lvl = newBottom; lvl <= newTop; lvl++) paint(lvl, 'X', c.time, painted++)
        bottom = newBottom
        top = newTop
      }
    }
  }
  // ascending guard (same rationale as renko)
  for (let i = 1; i < cells.length; i++) {
    if (cells[i].time <= cells[i - 1].time) cells[i].time = cells[i - 1].time + 1
  }
  void tfSec
  return cells.slice(-300)
}

// ---------- Task 63 transforms (kernel-mirrored; engines of record live in
// mini-services/trading-core/src/analytics/{rangebars,volumebars}.ts) ----------

/** Range bars - close-chained like the kernel engine: a bar closes when the
 * candle CLOSE clears one full `range` (ATR(window) x 0.5 default) beyond the
 * running reference, either direction, no reversal multiplier. Wickless by
 * construction; honest completion-candle times (+1s stagger). */
function rangeBarsChart(candles: Candle[], tfSec: number): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-150)
  let trSum = 0
  for (let i = 1; i < window.length; i++) {
    trSum += Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close)
    )
  }
  const range = Math.max((trSum / Math.max(window.length - 1, 1)) * 0.5, 1e-9)
  const bars: Candle[] = []
  let ref = window[0].close
  let painted = 0
  for (const c of window) {
    painted = 0
    while (c.close >= ref + range) {
      bars.push({ time: c.time + painted, open: ref, high: ref + range, low: ref, close: ref + range, volume: 0 })
      painted++
      ref += range
    }
    while (c.close <= ref - range) {
      bars.push({ time: c.time + painted, open: ref, high: ref, low: ref - range, close: ref - range, volume: 0 })
      painted++
      ref -= range
    }
  }
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].time <= bars[i - 1].time) bars[i].time = bars[i - 1].time + 1
  }
  void tfSec
  return bars.slice(-300)
}

/** Constant (equi) volume bars - kernel mirror of volumeBars(): a bar closes
 * when cumulative (approx) volume first reaches `per` (auto: totalVol/80,
 * floor median*0.25). Real clock: time = first contributing candle open. */
function volumeBarsChart(candles: Candle[]): Candle[] {
  if (candles.length < 10) return []
  const window = candles.slice(-400)
  const total = window.reduce((s, c) => s + (Number.isFinite(c.volume) ? c.volume : 0), 0)
  if (total <= 0) return [] // all-zero volume -> nothing honest to draw
  const sorted = [...window].map((c) => c.volume).sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1]
  const per = Math.max(total / 80, median * 0.25, 1e-9)
  const bars: Candle[] = []
  let cur: Candle | null = null
  let acc = 0
  for (const c of window) {
    if (!cur) cur = { ...c, volume: 0 }
    cur.high = Math.max(cur.high, c.high)
    cur.low = Math.min(cur.low, c.low)
    cur.close = c.close
    cur.volume += c.volume
    acc += c.volume
    if (acc >= per) {
      bars.push(cur)
      cur = null
      acc = 0
    }
  }
  if (cur) bars.push(cur)
  return bars.slice(-300)
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
}: ChartPanelProps) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const priceSeriesRef = useRef<AnyPriceSeries | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const entryLineRefs = useRef<Map<string, { series: AnyPriceSeries; line: IPriceLine; price: number; title: string }>>(new Map())
  const markersRef = useRef<{ series: AnyPriceSeries; api: ISeriesMarkersPluginApi<Time> } | null>(null)
  const priceFmtKeyRef = useRef<string | null>(null)

  // axis/crosshair/price-line precision follows the asset's quote convention
  // (the library default of 2 decimals turns 1.10283 into 1.10)
  const priceFmt = useMemo(() => chartPriceFormat(digitsTicker, price), [digitsTicker, price])
  const overlayRefs = useRef<Map<string, ISeriesApi<'Line'>>>(new Map())
  // registry indicator markers (fractal arrows) + trade markers merge into ONE
  // setMarkers payload on the price series - two refs, one plugin
  const indMarkersRef = useRef<SeriesMarker<Time>[]>([])
  const tradeMarkersRef = useRef<SeriesMarker<Time>[]>([])

  const tfSec = useMemo(() => {
    if (!candles || candles.length < 2) return 60
    return Math.max(1, candles[candles.length - 1].time - candles[candles.length - 2].time)
  }, [candles])

  // ---------- Task 63: fetched chart data + custom-canvas refs ----------
  const [tickBarsState, setTickBarsState] = useState<TickBarRow[]>([])
  const [ticksMeta, setTicksMeta] = useState<{ dataSource: 'tick' | 'candle'; per: number } | null>(null)
  const [ivhvState, setIvhvState] = useState<IvHvResponse | null>(null)
  const customCanvasRef = useRef<HTMLCanvasElement | null>(null)
  // IV/HV pane line series (created only when chartType === 'ivhv')
  const hvLineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const ivLineRef = useRef<ISeriesApi<'Line'> | null>(null)

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
          setTicksMeta({ dataSource: r.dataSource, per: r.per })
        })
        .catch(() => {
          // keep last good data; badge shows what it came from
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

  const displayCandles = useMemo(() => {
    if (chartType === 'heikin') return heikinAshi(candles)
    if (chartType === 'renko') return renko(candles, tfSec)
    if (chartType === 'pointfigure') return pointFigureChart(candles, tfSec)
    if (chartType === 'rangebars') return rangeBarsChart(candles, tfSec)
    if (chartType === 'volumebars') return volumeBarsChart(candles)
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
    } else if (chartType === 'heikin' || chartType === 'renko' || chartType === 'pointfigure' || chartType === 'rangebars' || chartType === 'volumebars' || chartType === 'tickchart') {
      price = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        priceLineColor: '#38bdf8',
      })
    } else if (chartType === 'footprint' || chartType === 'tpo') {
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
        // pane API unavailable -> ivhv degrades to plain candles + badge
      }
    }

    return () => {
      chart.remove()
      chartRef.current = null
      priceSeriesRef.current = null
      volRef.current = null
      hvLineRef.current = null
      ivLineRef.current = null
      overlayRefs.current.clear()
      entryLineRefs.current.clear()
      markersRef.current = null
      indMarkersRef.current = []
      tradeMarkersRef.current = []
    }
  }, [chartType])

  // price + volume data
  useEffect(() => {
    const price = priceSeriesRef.current
    const vol = volRef.current
    if (!price || !vol || displayCandles.length === 0) return
    if (chartType === 'line' || chartType === 'area' || chartType === 'baseline') {
      const lineData = displayCandles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close }))
      ;(price as ISeriesApi<'Line'>).setData(lineData)
      vol.setData(displayCandles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? 'rgba(16,185,129,0.30)' : 'rgba(244,63,94,0.30)' })))
      return
    }
    ;(price as unknown as ISeriesApi<'Candlestick'>).setData(
      displayCandles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }))
    )
    vol.setData(
      displayCandles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(16,185,129,0.30)' : 'rgba(244,63,94,0.30)',
      }))
    )
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
    if (chartType !== 'footprint' && chartType !== 'tpo') return
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
        const padT = 26
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
        ctx.fillStyle = TEXT
        ctx.textAlign = 'left'
        ctx.fillText('footprint - volume (approx), CLV split - green buy / red sell, cyan box POC, outline imbalance', 8, 12)
      } else {
        // TPO: left = close path for time orientation, right = profile
        const prof = tpoProfile(candles.slice(-400))
        if (!prof.bins.length) return
        const pLo = prof.bins[0].priceLow
        const pHi = prof.bins[prof.bins.length - 1].priceHigh
        const padT = 26
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
        ctx.fillStyle = TEXT
        ctx.textAlign = 'left'
        ctx.fillText(`TPO ${prof.periodRule} - VA70 shaded, amber = initial balance, single print/period`, 8, 12)
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [chartType, candles, digitsTicker])

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
    const all = [...indMarkersRef.current, ...tradeMarkersRef.current]
    all.sort((a, b) => Number(a.time) - Number(b.time))
    markersRef.current.api.setMarkers(all)
  }, [])

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

  // honesty badge per Task 63 chart type - provenance always visible
  const tpoBadge = useMemo(() => (chartType === 'tpo' && candles.length ? tpoProfile(candles.slice(-400)) : null), [chartType, candles])
  const badge = useMemo(() => {
    switch (chartType) {
      case 'rangebars':
        return 'range bars - close-chained, ATR(window) x 0.5, wickless by construction'
      case 'volumebars':
        return 'volume bars - auto per, volume (approx), real clock'
      case 'footprint':
        return 'footprint - volume (approx), CLV buy/sell proxy (no bid/ask feed)'
      case 'tpo':
        return tpoBadge ? `TPO ${tpoBadge.periodRule} - POC ${fmtPrice(tpoBadge.poc ?? 0, digitsTicker)} - VA ${fmtPrice(tpoBadge.vaLow ?? 0, digitsTicker)}~${fmtPrice(tpoBadge.vaHigh ?? 0, digitsTicker)}` : 'TPO'
      case 'tickchart':
        return ticksMeta ? `tick chart ${ticksMeta.per}/bar - ${ticksMeta.dataSource === 'tick' ? 'real 100ms capture' : 'PSEUDO-TICKS (5s closes), not raw tick data'}` : 'tick chart - loading...'
      case 'ivhv':
        return ivhvState ? `HV ${Number.isFinite(ivhvState.hvNow) ? ivhvState.hvNow.toFixed(1) : '?'}% - IV proxy (${ivhvState.ivSource}): payout breakeven - realized up ${ivhvState.realizedUpProbPct.toFixed(0)}%` : 'IV/HV - loading...'
      default:
        return null
    }
  }, [chartType, ticksMeta, ivhvState, tpoBadge, digitsTicker])

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
  const fitChart = () => {
    chartRef.current?.timeScale().fitContent()
    chartRef.current?.timeScale().scrollToRealTime()
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      {/* zoom controls (left of the price scale) */}
      <div className="absolute bottom-10 right-[60px] z-10 flex flex-col gap-1">
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
      {badge && (
        <div className="absolute right-[64px] top-1.5 z-[6] max-w-[72%] truncate rounded border border-[#1c2739] bg-[#0d1420]/90 px-2 py-0.5 text-[10px] font-mono text-[#7c8aa5]" title={badge}>
          {badge}
        </div>
      )}
      {(chartType === 'footprint' || chartType === 'tpo') && (
        <div className="absolute inset-x-0 bottom-[30px] top-0 z-[5] bg-[#0b111c]">
          <canvas ref={customCanvasRef} className="block h-full w-full" />
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
