// IQAIR//OS - Unified Chart & Property Registry (Phase 1 of the chart-engine
// expansion roadmap - see claude/msl-capability-matrix.md for the Phase 0
// audit this is built from).
//
// THE ARCHITECTURAL RULE THIS FILE EXISTS TO ENFORCE: MSL should never need
// to know how an individual chart engine internally calculates something.
// strategylang.ts, /signal_vocab, and any future docs/UI should all be able
// to answer "what can I read off chart X" by reading THIS registry, not by
// re-deriving it from renko.ts/pointfigure.ts/footprint.ts/etc headers.
//
// This is a REGISTRY, not an evaluator - it describes properties, it does
// not compute them. The actual math stays exactly where it already lives
// (analytics/renko.ts, analytics/otcfootprint.ts, strategylang.ts's own
// primitive dispatch, ...); this file is the canonical metadata layer on
// top, so a property's documentation, its data-quality label, and its
// MSL-callability status can never drift out of sync with each other the
// way three different ad-hoc comments in three different files could.
//
// Pure data + small accessor helpers, no I/O, no chart-engine imports (this
// module must never create a dependency cycle with the engines it
// describes - it is deliberately just metadata ABOUT them).

import type { ChartType } from '../types'

// ---------------------------------------------------------------------------
// Vocabulary

export type PropertyDataType = 'number' | 'boolean' | 'direction' | 'string' | 'object' | 'series'

export type PropertyUnit =
  | 'price' | 'ticks' | 'volume' | 'percentage' | 'seconds' | 'bars' | 'ratio' | 'count' | 'none'

/** Whether a property has a kept history, only the live/forming value, or
 * only ever a single current snapshot (no history retained anywhere). */
export type HistoryKind = 'historical' | 'live' | 'snapshot'

export type UpdateFrequency = 'per-tick' | 'per-bar-close' | 'per-poll' | 'static-per-session'

/** Where a script can actually read this property from. Mirrors the
 * fail-closed contract strategylang.ts already enforces for live()/tick.* /
 * foot.* (Omni Trader only) vs everything else (works everywhere a script
 * runs) - this field doesn't invent new rules, it documents the existing
 * ones so every property states its own contract explicitly instead of a
 * caller having to remember which primitives are omni-trader-only. */
export type ExecutionContext = 'metaStrategyEval' | 'metaStrategyTestScript' | 'metaTrader' | 'omniTrader' | 'backtest'
export const ALL_CONTEXTS: ExecutionContext[] = ['metaStrategyEval', 'metaStrategyTestScript', 'metaTrader', 'omniTrader', 'backtest']
export const CLOSED_BAR_CONTEXTS: ExecutionContext[] = ['metaStrategyEval', 'metaStrategyTestScript', 'metaTrader', 'backtest']

/** The data-quality classification the roadmap explicitly calls for -
 * "don't label a proxy as measured data." Every property MUST carry one of
 * these, and `proxy`/`estimated` entries MUST carry a `qualityNote`
 * explaining the approximation, so nothing silently reads as more solid
 * than it is. */
export type DataQuality = 'measured' | 'estimated' | 'proxy' | 'unavailable'

/** Where a property currently stands relative to MSL reachability - this is
 * the Phase 0 audit's own status column, kept machine-readable so future
 * phases can query "what's still `missing`" instead of re-reading the
 * matrix doc by eye. */
export type ExposureStatus = 'existing' | 'partial' | 'missing' | 'unavailable-by-design'

export interface ChartPropertyDef {
  /** Globally unique, stable - e.g. "renko.brick.ohlc". Never reused for a
   * different meaning once shipped (strategies may reference it by name in
   * error messages/docs even if the call syntax itself is a method, not
   * this id). */
  id: string
  label: string
  description: string
  /** Which chart type(s) this reads from. Most properties belong to
   * exactly one; a few (OHLC, direction) are shared across every
   * candle-shaped chart (candles/hollow/bars) and list all three. */
  chartTypes: ChartType[]
  /** The analytics module that actually computes this, e.g.
   * "analytics/renko.ts#renkoBricks". Source of truth for a future
   * maintainer tracing a property back to its math. */
  engine: string
  dataType: PropertyDataType
  unit: PropertyUnit
  historyKind: HistoryKind
  updateFrequency: UpdateFrequency
  supportedTimeframes: 'all' | 'native-only' | 'n/a'
  supportedContexts: ExecutionContext[]
  quality: DataQuality
  /** Required when quality is 'estimated' | 'proxy' | 'unavailable' -
   * explains WHY, in the same honest terms the codebase's own module
   * headers already use (e.g. footprint.ts's CLV-proxy disclosure). */
  qualityNote?: string
  /** What happens when there isn't enough history/data yet - "fails closed
   * with <error>" or "returns null/NaN" - must always be ONE of those two
   * shapes, never a silent wrong number. */
  missingDataBehavior: string
  status: ExposureStatus
  /** The exact MSL call that reads this TODAY, or null if `status` is
   * 'missing'/'unavailable-by-design'. This is what makes the registry
   * useful to /signal_vocab callers immediately, not just the roadmap. */
  mslAccessor: string | null
}

// ---------------------------------------------------------------------------
// The registry itself. Grouped by chart type, in the same A-Q order as the
// Phase 0 capability matrix so the two documents can be read side by side.
// This is a representative, load-bearing first pass - every 'existing'/
// 'partial' row reflects a real, verified primitive; every 'missing' row is
// a real gap from the audit, not a placeholder. Phases 2+ ADD properties to
// this array as engines are extended; nothing here should need renaming
// later (ids are chosen to be stable before any accessor exists for them).

export const CHART_PROPERTY_REGISTRY: ChartPropertyDef[] = [
  // ---- A/B/D: candlestick / hollow / bars (one shared engine) ----
  {
    id: 'candle.ohlcv', label: 'OHLCV', description: 'Open/high/low/close + the feed-reported volume for one closed (or, in the Omni Trader, currently forming) bar.',
    chartTypes: ['candles', 'hollow', 'bars'], engine: 'plugins/market-data.ts (candle store)',
    dataType: 'object', unit: 'price', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'fails closed: "too little history yet" for an out-of-range offset/tf',
    status: 'existing', mslAccessor: 'ohlc(offset, tf?) / live() -> {o,h,l,c,v,body,range,upper_wick,lower_wick}',
  },
  {
    id: 'candle.direction', label: 'Direction', description: 'Bullish/bearish/neutral classification of a closed bar.',
    chartTypes: ['candles', 'hollow', 'bars'], engine: 'strategylang.ts (derived) / candle verdict source',
    dataType: 'direction', unit: 'none', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'n/a - always derivable from close vs open',
    status: 'existing', mslAccessor: 'candle.dir, or ohlc(-1).c > ohlc(-1).o',
  },
  {
    id: 'candle.streak', label: 'Consecutive same-direction count', description: 'Signed run length of same-color candles.',
    chartTypes: ['candles', 'hollow', 'bars'], engine: 'analytics/metastrategy indicatorIds.streak',
    dataType: 'number', unit: 'bars', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'returns 0 with insufficient history',
    status: 'existing', mslAccessor: "indicator('streak', ...), or streak(upCandle)/streak(downCandle) with a let-bound condition",
  },
  {
    id: 'candle.gap', label: 'Gap size + direction', description: 'Price gap between this bar\'s open and the prior bar\'s close, plus fill tracking.',
    chartTypes: ['candles', 'hollow', 'bars'], engine: 'analytics/gap.ts#detectGaps',
    dataType: 'number', unit: 'price', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    qualityNote: 'Meaningless on OTC synthetic pairs (continuous trading, essentially never gap); built for forex/real-market session opens. Math is honest and generic either way, it just rarely fires on one feed type.',
    missingDataBehavior: 'gap.*(offset) throws a clear "no gaps yet" error when the window has none, rather than a confusing out-of-range message',
    status: 'existing' /* resolved, loose-threads sweep */, mslAccessor: 'gap.count()/.direction(offset)/.size(offset)/.filled(offset)/.filledAt(offset)',
  },
  {
    id: 'candle.pattern', label: 'Candlestick pattern hit', description: 'Any of the 74 named Nison-catalog patterns, on raw or Heikin-Ashi bars.',
    chartTypes: ['candles', 'hollow', 'bars', 'heikin'], engine: 'analytics/patterns.ts#detectPatterns',
    dataType: 'boolean', unit: 'none', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'returns false below the detector\'s own minimum window',
    status: 'existing', mslAccessor: "candle(name, dir, conf?, series?)",
  },

  // ---- C: Heikin Ashi ----
  {
    id: 'ha.bars.direction', label: 'HA bar signed direction series', description: 'Chronological signed body-direction series of the last n HA candles.',
    chartTypes: ['heikin'], engine: 'analytics/engine.ts#heikinAshiSeries',
    dataType: 'series', unit: 'none', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'fails closed: "series can\'t be used directly" if indexed wrong; short-history indices read null',
    status: 'existing', mslAccessor: 'ha.bars(n?)[offset]',
  },
  {
    id: 'ha.ohlc', label: 'HA full OHLC per bar', description: 'The Heikin-Ashi candle\'s own open/high/low/close (not just signed direction).',
    chartTypes: ['heikin'], engine: 'analytics/chartsignals.ts#heikinAshiSeries, exposed via strategylang.ts#haMethod',
    dataType: 'object', unit: 'price', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'fails closed: "out of range - only N bar(s) of history available"',
    status: 'existing', mslAccessor: 'ha.ohlc(offset) -> {o,h,l,c,v,body,range,upper_wick,lower_wick} (v = underlying candle\'s real volume)',
  },
  {
    id: 'ha.streak', label: 'HA streak length', description: 'Current signed HA run length.',
    chartTypes: ['heikin'], engine: 'analytics/engine.ts#heikinAshiSeries',
    dataType: 'number', unit: 'bars', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'returns 0 with insufficient history',
    status: 'existing', mslAccessor: 'ha.streak()',
  },
  {
    id: 'ha.flip', label: 'HA flip', description: 'True iff the latest HA candle just flipped color.',
    chartTypes: ['heikin'], engine: 'analytics/engine.ts#heikinAshiSeries',
    dataType: 'boolean', unit: 'none', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'returns false with insufficient history',
    status: 'existing', mslAccessor: 'ha.flip()',
  },
  {
    id: 'ha.bodyAtr', label: 'HA body-to-ATR ratio', description: 'Latest HA body size / renko\'s own ATR - how oversized this HA candle is.',
    chartTypes: ['heikin'], engine: 'analytics/engine.ts#heikinAshiSeries',
    dataType: 'number', unit: 'ratio', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'returns NaN with insufficient ATR history',
    status: 'existing', mslAccessor: 'ha.bodyAtr()',
  },

  // ---- E/F/G: line / area / baseline ----
  {
    id: 'line.close', label: 'Close-price series', description: 'Chronological closed-bar close series.',
    chartTypes: ['line', 'area', 'baseline'], engine: 'plugins/market-data.ts (candle store)',
    dataType: 'series', unit: 'price', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'fails closed with insufficient history',
    status: 'existing', mslAccessor: 'ohlc(offset).c in a loop, or ind.*(...) on close',
  },
  {
    id: 'line.slope', label: 'Slope / linreg slope', description: 'Rate of change / linear-regression slope of the close series.',
    chartTypes: ['line', 'area', 'baseline'], engine: 'strategies/custom.ts indicatorIds.slope',
    dataType: 'number', unit: 'ratio', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'returns NaN with insufficient history',
    status: 'existing', mslAccessor: "indicator('slope', ...), or ind.*(...).slope(n) on any series",
  },
  {
    id: 'line.breakout', label: 'Breakout / HH-HL / LH-LL', description: 'Structural breakout and higher-high/higher-low (or lower-high/lower-low) boolean read.',
    chartTypes: ['line', 'area'], engine: 'strategies/signalscript.ts line() signal func',
    dataType: 'boolean', unit: 'none', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'returns false with insufficient lookback',
    status: 'existing', mslAccessor: 'line(variant, dir, conf?, lookback?) - variant: breakout-up|breakout-down|hh-hl|lh-ll',
  },
  {
    id: 'line.swingPoints', label: 'Raw swing-point list', description: 'The actual swing-high/swing-low points backing the HH/HL boolean, not just the verdict.',
    chartTypes: ['line', 'area'], engine: 'NOT YET EXPOSED (swing detection exists only internally to line())',
    dataType: 'series', unit: 'price', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'n/a - not implemented',
    status: 'missing', mslAccessor: null,
  },
  {
    id: 'baseline.value', label: 'Baseline value', description: 'The chart\'s own baseline price (first visible bar\'s close).',
    chartTypes: ['baseline'], engine: 'frontend-only render concept today - no analytics module',
    dataType: 'number', unit: 'price', historyKind: 'snapshot', updateFrequency: 'static-per-session',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'unavailable',
    qualityNote: 'Baseline chart has no backing analytics engine at all today - purely a ChartPanel.tsx render mode. Real gap, scoped for Phase 2.',
    missingDataBehavior: 'n/a - not implemented',
    status: 'missing', mslAccessor: null,
  },
  {
    id: 'baseline.deviation', label: 'Deviation from baseline (+ %) / crossing', description: 'Current price distance/percent from the baseline, above/below state, and crossing direction.',
    chartTypes: ['baseline'], engine: 'NOT YET BUILT (depends on baseline.value shipping first)',
    dataType: 'number', unit: 'price', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'unavailable',
    missingDataBehavior: 'n/a - not implemented',
    status: 'missing', mslAccessor: null,
  },

  // ---- H: Renko ----
  {
    id: 'renko.bricks.direction', label: 'Brick signed direction series', description: 'Chronological signed direction (+1/-1) of the last n Renko bricks.',
    chartTypes: ['renko'], engine: 'analytics/renko.ts#renkoBricks',
    dataType: 'series', unit: 'none', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'fails closed if used unindexed; short-history indices read null',
    status: 'existing', mslAccessor: 'renko.bricks(n?)[offset]',
  },
  {
    id: 'renko.brickSize', label: 'Current brick size', description: 'Current ATR-derived brick size in price units.',
    chartTypes: ['renko'], engine: 'analytics/renko.ts#renkoAtr',
    dataType: 'number', unit: 'price', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'returns NaN with insufficient ATR history',
    status: 'existing', mslAccessor: 'renko.brickSize()',
  },
  {
    id: 'renko.brick.ohlc', label: 'Brick full OHLC series', description: 'Each brick\'s actual open/high/low/close/time (not just signed direction).',
    chartTypes: ['renko'], engine: 'analytics/renko.ts#renkoBricks, exposed via strategylang.ts#renkoMethod',
    dataType: 'series', unit: 'price', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'fails closed: "out of range - only N bar(s) of history available"',
    status: 'existing', mslAccessor: 'renko.ohlc(offset) -> {o,h,l,c,v,body,range,upper_wick,lower_wick} (v always 0 - a brick has no meaningful volume)',
  },
  {
    id: 'renko.formation', label: 'Current brick formation / confirmation state', description: 'Whether a brick is provisional vs confirmed, and how long it took to form.',
    chartTypes: ['renko'], engine: 'NOT A CONCEPT IN THE CURRENT ENGINE',
    dataType: 'object', unit: 'none', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'unavailable',
    qualityNote: 'renko.ts derives bricks deterministically from closed candle history, not live tick-by-tick brick formation - there is no "in-progress brick" concept to read yet. Needs a design decision (does this mean per-candle brick-completion tracking, or true per-tick brick formation off the raw tick buffer?) before building - flagged for Phase 2/3 scoping, not assumed solved by this registry entry.',
    missingDataBehavior: 'n/a - not implemented',
    status: 'missing', mslAccessor: null,
  },

  // ---- I: Point & Figure ----
  {
    id: 'pf.boxes.signed', label: 'Column signed box-count series', description: 'Chronological signed box count (+X/-O) of the last n P&F columns.',
    chartTypes: ['pointfigure'], engine: 'analytics/pointfigure.ts#pointFigure',
    dataType: 'series', unit: 'count', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'fails closed if used unindexed; short-history indices read null',
    status: 'existing', mslAccessor: 'pf.boxes(n?)[offset]',
  },
  {
    id: 'pf.boxSize', label: 'Box size', description: 'Current P&F box size.',
    chartTypes: ['pointfigure'], engine: 'analytics/pointfigure.ts#pointFigure',
    dataType: 'number', unit: 'price', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'returns NaN with insufficient history',
    status: 'existing', mslAccessor: 'pf.boxSize()',
  },
  {
    id: 'pf.column.highLow', label: 'Column high/low price', description: 'Each column\'s top/bottom price boundary + unsigned box count (PFColumn.top/bottom/boxes).',
    chartTypes: ['pointfigure'], engine: 'analytics/pointfigure.ts#pointFigure, exposed via strategylang.ts#pfMethod',
    dataType: 'object', unit: 'price', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'fails closed: "out of range - only N bar(s) of history available"',
    status: 'existing', mslAccessor: 'pf.column(offset) -> {top, bottom, boxes} (no .dir field - read pf.boxes(n)[offset]\'s sign for direction)',
  },
  {
    id: 'pf.doubleTopBottom', label: 'Double-top / double-bottom breakout', description: 'Classic P&F double/triple-top/bottom column-break pattern.',
    chartTypes: ['pointfigure'], engine: 'analytics/pointfigure.ts#pointFigure (buySignal/sellSignal/pattern were already computed internally; strategylang.ts#pfMethod now exposes them)',
    dataType: 'boolean', unit: 'none', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'honest "none" when no breakout pattern has occurred yet in the window, same convention as swing.structure()',
    status: 'existing' /* resolved, loose-threads sweep */, mslAccessor: 'pf.breakout() / pf.breakoutName() / pf.breakoutAt()',
  },

  // ---- J: Range Bars ----
  {
    id: 'rangebars.namespace', label: 'rangebars.* namespace', description: 'rangebars.bars(n?) signed direction series, rangebars.ohlc(offset) full OHLC, rangebars.range() threshold, rangebars.streak() consecutive-direction count.',
    chartTypes: ['rangebars'], engine: 'analytics/rangebars.ts#rangeBars, exposed via strategylang.ts#rangebarsMethod',
    dataType: 'object', unit: 'none', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    qualityNote: 'RangeBar carries no volume field at all - rangebars.ohlc()\'s v is always 0, never fabricated. "Ticks used to form a bar" is not a meaningful concept in this candle-derived (not tick-derived) implementation and remains unexposed.',
    missingDataBehavior: 'fails closed: "out of range - only N bar(s) of history available"',
    status: 'existing', mslAccessor: 'rangebars.bars(n?) / rangebars.ohlc(offset) / rangebars.range() / rangebars.streak()',
  },

  // ---- K: Volume Bars ----
  {
    id: 'volumebars.namespace', label: 'volumebars.* namespace', description: 'volumebars.bars(n?) signed direction series (STORED on VolumeBar.dir as of the loose-threads sweep, read directly rather than re-derived), volumebars.ohlc(offset) full OHLC with real volume, volumebars.threshold() volume-per-bar target, volumebars.volumeSource() "feed"|"none" honesty flag.',
    chartTypes: ['volumebars'], engine: 'analytics/volumebars.ts#volumeBars, exposed via strategylang.ts#volumebarsMethod',
    dataType: 'object', unit: 'none', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'estimated',
    qualityNote: 'volumeSource: "feed"|"none" already honestly flags when the candle feed carries zero real volume, now readable directly as volumebars.volumeSource(); this engine is candle-derived, not a true per-tick volume accumulator - "ticks used" is unavailable by design here, same as the tick-chart\'s own real/pseudo distinction.',
    missingDataBehavior: 'route returns 400 (degenerate) when the window has candles but zero total volume; MSL accessors fail closed on out-of-range offsets',
    status: 'existing', mslAccessor: 'volumebars.bars(n?) / volumebars.ohlc(offset) / volumebars.threshold() / volumebars.volumeSource()',
  },

  // ---- L/M/N: Footprint family ----
  {
    id: 'footprint.candle.ladder', label: 'Candle-derived price ladder (proxy)', description: 'Per-candle price-bin ladder with buy/sell-proxy volume split.',
    chartTypes: ['footprint'], engine: 'analytics/footprint.ts#computeFootprint',
    dataType: 'object', unit: 'volume', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'proxy',
    qualityNote: 'IQ Option exposes no bid/ask-tagged trades. Volume is spread across bins by range-overlap; buy/sell split is CLV-derived (close-location-value), never real bid/ask. Must always be labeled "volume (approx), CLV split", never "measured bid/ask volume".',
    missingDataBehavior: 'zero-volume/flat candles collapse to one 50/50 row with imbalance always null',
    status: 'existing', mslAccessor: '(verdict-only today - see footprint source; no MSL raw-primitive namespace for the candle-footprint engine specifically, use foot.* for the real tick-derived sibling)',
  },
  {
    id: 'tickfootprint.ladder', label: 'Real tick-derived price ladder', description: 'Per-price-node real up/down tick counts (not volume - IQ Option ticks carry no size).',
    chartTypes: ['tickfootprint', 'otcfootprint'], engine: 'analytics/otcfootprint.ts#buildFootprint',
    dataType: 'object', unit: 'ticks', historyKind: 'historical', updateFrequency: 'per-tick',
    supportedTimeframes: 'n/a', supportedContexts: ['omniTrader'], quality: 'measured',
    qualityNote: 'Real tick counts per price level (dataSource is always disclosed: sidecar-tick-100ms / sim-tick-1s / kernel-tick-buffer). Still NOT volume or bid/ask - "buy/sell" here means up-tick/down-tick counts, a real but different measurement than exchange bid/ask volume.',
    missingDataBehavior: 'a too-thin bucket (<3 ticks) reads back as NaN rather than a misleading zero',
    status: 'existing', mslAccessor: 'foot.poc/pocTicks/stagnation/delta/speedRatio(windowSec?) + *Series siblings',
  },
  {
    id: 'footprint.valueArea', label: 'Value Area High/Low (footprint, volume-based)', description: 'VAH/VAL computed from footprint volume - does not exist today in either footprint engine.',
    chartTypes: ['footprint', 'tickfootprint', 'otcfootprint'], engine: 'NOT YET BUILT - only TPO has a value area today, and TPO\'s is time-based, not volume-based',
    dataType: 'number', unit: 'price', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'unavailable',
    qualityNote: 'This is exactly what the new Volume Profile engine (see roadmap section 7.1) is for - do not bolt a second value-area calc onto the footprint engines, build Volume Profile once and have footprint read from it.',
    missingDataBehavior: 'n/a - not implemented',
    status: 'missing', mslAccessor: null,
  },
  {
    id: 'footprint.imbalance.diagonal', label: 'Diagonal imbalance', description: 'This level\'s buy vs the level-below\'s sell (classic footprint diagonal read), distinct from same-level imbalance.',
    chartTypes: ['footprint', 'tickfootprint', 'otcfootprint'], engine: 'NOT YET BUILT - foot.imbalance() today only checks same-level buy-vs-sell',
    dataType: 'boolean', unit: 'none', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'n/a', supportedContexts: ['omniTrader'], quality: 'unavailable',
    missingDataBehavior: 'n/a - not implemented',
    status: 'missing', mslAccessor: null,
  },
  {
    id: 'footprint.absorption', label: 'Absorption detection', description: 'Heavy volume/ticks with minimal price movement, opposing the apparent delta - still needs a defined calculation distinct from exhaustion below (absorption = price HOLDS against the delta, exhaustion = price FLIPS after the delta); not yet built.',
    chartTypes: ['footprint', 'tickfootprint', 'otcfootprint'], engine: 'NOT YET BUILT',
    dataType: 'boolean', unit: 'none', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'n/a', supportedContexts: ['omniTrader'], quality: 'unavailable',
    missingDataBehavior: 'n/a - not implemented; see roadmap section 5 for the intended definition',
    status: 'missing', mslAccessor: null,
  },
  {
    id: 'footprint.exhaustion', label: 'Exhaustion detection (speed-ratio)', description: 'One side ticking far faster than the other while the opposing side still has some prints - a genuine one-sided thrust rather than a one-way gap. Already computed internally by buildFootprint() (FootprintBucket.exhaustion) and was simply never exposed to MSL before this pass.',
    chartTypes: ['tickfootprint', 'otcfootprint'], engine: 'analytics/otcfootprint.ts#buildFootprint, exposed via strategylang.ts#footMethod',
    dataType: 'string', unit: 'none', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'n/a', supportedContexts: ['omniTrader'], quality: 'measured',
    qualityNote: 'This is the real-tick speed-ratio definition already built into buildFootprint(). The broader "heavy volume + delta flip + stalling price" definition for the candle-approximated footprint engine is a DIFFERENT, still-unbuilt concept - do not conflate the two.',
    missingDataBehavior: 'returns "none" when the window has too few prints (<3 ticks)',
    status: 'existing', mslAccessor: "foot.exhaustion(windowSec?) -> 'up'|'down'|'none'",
  },
  {
    id: 'footprint.divergence', label: 'Delta divergence trap', description: 'Heavy positive delta closing at the window\'s low ("put-trap") or heavy negative delta closing at the high ("call-trap") - already computed internally by buildFootprint() (FootprintBucket.divergence), newly exposed.',
    chartTypes: ['tickfootprint', 'otcfootprint'], engine: 'analytics/otcfootprint.ts#buildFootprint, exposed via strategylang.ts#footMethod',
    dataType: 'string', unit: 'none', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'n/a', supportedContexts: ['omniTrader'], quality: 'measured',
    missingDataBehavior: 'returns "none" when the window has too few prints (<3 ticks)',
    status: 'existing', mslAccessor: "foot.divergence(windowSec?) -> 'put-trap'|'call-trap'|'none'",
  },
  {
    id: 'footprint.cumulativeDelta', label: 'Cumulative delta (raw)', description: 'Running sum of per-bucket real-tick delta across a trailing window - the raw, unscaled sibling of the ofcumdelta indicator (which is candle-approximated and z-scored).',
    chartTypes: ['tickfootprint', 'otcfootprint'], engine: 'analytics/otcfootprint.ts#buildFootprint, exposed via strategylang.ts#footMethod',
    dataType: 'number', unit: 'ticks', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'n/a', supportedContexts: ['omniTrader'], quality: 'measured',
    missingDataBehavior: 'thin buckets (<3 ticks) contribute 0 to the running sum rather than NaN, so the total stays meaningful',
    status: 'existing', mslAccessor: 'foot.cumulativeDelta(bucketSec?, buckets?)',
  },
  {
    id: 'footprint.consecutiveImbalance', label: 'Consecutive (stacked) imbalance', description: 'True iff the last n consecutive footprint buckets each independently show a diagonal imbalance of at least `ratio`x in the same direction - generalizes the single-window foot.imbalance() across a run of buckets.',
    chartTypes: ['tickfootprint', 'otcfootprint'], engine: 'analytics/otcfootprint.ts#buildFootprint, exposed via strategylang.ts#footMethod',
    dataType: 'boolean', unit: 'none', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'n/a', supportedContexts: ['omniTrader'], quality: 'measured',
    missingDataBehavior: 'fails closed with a clear error on a bad side argument; returns false with fewer than n buckets available',
    status: 'existing', mslAccessor: "foot.consecutiveImbalance('buy'|'sell', ratio, n, bucketSec?)",
  },
  {
    id: 'footprint.unfinishedAuction', label: 'Unfinished auction detection', description: 'Price closed at (or very near) the high/low of its own value area with volume still building - a defined calculation is required before this can ship, not assumed.',
    chartTypes: ['footprint', 'tickfootprint', 'otcfootprint'], engine: 'NOT YET BUILT - needs a design decision, not just an implementation',
    dataType: 'boolean', unit: 'none', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'n/a', supportedContexts: ['omniTrader'], quality: 'unavailable',
    missingDataBehavior: 'n/a - not implemented',
    status: 'missing', mslAccessor: null,
  },

  // ---- O: TPO / Market Profile ----
  {
    id: 'tpo.namespace', label: 'tpo.* namespace', description: 'tpo.poc()/vah()/val()/ibHigh()/ibLow() - POC/VAH/VAL/Initial-Balance-high/Initial-Balance-low, all scalars (one value per profile period, not a per-candle series - TPO has no natural "last n" shape).',
    chartTypes: ['tpo'], engine: 'analytics/tpo.ts#computeTpo, exposed via strategylang.ts#tpoMethod',
    dataType: 'object', unit: 'none', historyKind: 'snapshot', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    qualityNote: 'TPO POC is TIME-based (time spent at a price), never confuse it with a VOLUME POC - that concept does not exist anywhere in the codebase yet (see Volume Profile, roadmap section 7.1). These accessors read the FINAL whole-window snapshot - for the running, mid-session value see tpo.developingValues below (now built).',
    missingDataBehavior: 'returns NaN (never 0) when the engine itself returns null for an empty window',
    status: 'existing', mslAccessor: 'tpo.poc() / tpo.vah() / tpo.val() / tpo.ibHigh() / tpo.ibLow()',
  },
  {
    id: 'tpo.developingValues', label: 'Developing POC / VAH / VAL', description: 'A running value sampled per period as the profile builds, not just the final snapshot.',
    chartTypes: ['tpo'], engine: 'analytics/tpo.ts#computeTpo (developingPoc/developingVah/developingVal), exposed via strategylang.ts#tpoMethod',
    dataType: 'series', unit: 'price', historyKind: 'live', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    qualityNote: 'One value PER PERIOD (not per-candle) - recomputed using only periods[0..k], never a look-ahead into later periods.',
    missingDataBehavior: 'returns NaN entries only on an empty window',
    status: 'existing' /* resolved, loose-threads sweep */, mslAccessor: 'tpo.developingPoc(n?) / tpo.developingVah(n?) / tpo.developingVal(n?)',
  },
  {
    id: 'tpo.singlePrintsPoorExcess', label: 'Single prints / poor high-low / excess high-low', description: 'Classic market-profile shape markers.',
    chartTypes: ['tpo'], engine: 'analytics/tpo.ts#computeTpo (singlePrintBins/excessHigh/excessLow/poorHigh/poorLow), exposed via strategylang.ts#tpoMethod',
    dataType: 'boolean', unit: 'none', historyKind: 'historical', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    qualityNote: 'poorHigh === !excessHigh and poorLow === !excessLow by construction (every touched extreme bin is exactly one or the other); both false together only on an empty window.',
    missingDataBehavior: 'tpo.singlePrintPrice(offset) throws a clear "none yet" error when the window has no single-print bins',
    status: 'existing' /* resolved, loose-threads sweep */, mslAccessor: 'tpo.singlePrintCount() / tpo.singlePrintPrice(offset) / tpo.excessHigh() / tpo.excessLow() / tpo.poorHigh() / tpo.poorLow()',
  },

  // ---- P: Tick Chart ----
  {
    id: 'tickbar.ohlcv', label: 'Tick-bar OHLCV series', description: 'N-tick bar OHLC + tick count (volume stand-in).',
    chartTypes: ['tickchart'], engine: 'analytics/tickbars.ts#tickBars',
    dataType: 'series', unit: 'price', historyKind: 'historical', updateFrequency: 'per-tick',
    supportedTimeframes: 'n/a', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    qualityNote: 'dataSource: "tick"|"candle" always honestly reported - "candle" means 5s candle closes stand in as pseudo-ticks when no raw tick buffer is available. This property is the house standard every other proxy/estimate should be labeled as clearly as.',
    missingDataBehavior: 'returns [] bars below 3-bar minimum',
    status: 'partial', mslAccessor: '/tick_patterns route reads these for pattern detection; no tickbar.ohlc(n) exists yet for general script use',
  },
  {
    id: 'tickbar.pattern', label: 'Tick-bar candlestick pattern hit', description: 'Candlestick pattern detection run against tick-bars instead of time-candles.',
    chartTypes: ['tickchart'], engine: 'analytics/tickpatterns.ts#detectTickPatterns',
    dataType: 'boolean', unit: 'none', historyKind: 'historical', updateFrequency: 'per-tick',
    supportedTimeframes: 'n/a', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'returns [] below 3-bar minimum',
    status: 'existing', mslAccessor: 'GET /tick_patterns?asset=&per=&lookback= (REST, not yet a strategylang primitive)',
  },
  {
    id: 'tickbar.avgGapMs', label: 'Average time between ticks', description: 'Median inter-tick gap - already computed, just not wired to the tick-chart engine itself.',
    chartTypes: ['tickchart'], engine: 'analytics/tickdesk.ts#medianTickGapMs (built for Tick Oracle/SMC, reusable here)',
    dataType: 'number', unit: 'seconds', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'n/a', supportedContexts: ['omniTrader'], quality: 'measured',
    missingDataBehavior: 'returns null with no ticks in window',
    status: 'existing' /* resolved, loose-threads sweep */, mslAccessor: 'tickbar.avgGapMs(per?) - reuses medianTickGapMs(), does not reimplement',
  },

  // ---- Q: IV/HV ----
  {
    id: 'ivhv.series', label: 'IV / HV / realized-up-close series', description: 'Historical and implied volatility series, realized up-close probability.',
    chartTypes: ['ivhv'], engine: 'analytics/ivhv.ts',
    dataType: 'series', unit: 'percentage', historyKind: 'historical', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'estimated',
    qualityNote: 'ivSource: "observed"|"current"|"none" already honestly labeled - this is the one other place in the codebase (besides dataSource on ticks) that models this registry\'s own quality-labeling discipline.',
    missingDataBehavior: 'ivSource: "none" when no usable payout data exists',
    status: 'existing', mslAccessor: '(verdict-only via the `ivHv` source today, plus ivhv.ivNow() below for a raw script-level accessor)',
  },
  {
    id: 'ivhv.ratio', label: 'IV/HV ratio', description: 'Payout-implied breakeven probability (the honest IV-analog) divided by historical volatility.',
    chartTypes: ['ivhv'], engine: 'analytics/ivhv.ts#ivFromPayout + hvSeries, exposed via strategylang.ts#ivhvMethod',
    dataType: 'number', unit: 'ratio', historyKind: 'historical', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'estimated',
    qualityNote: 'ivNow() reads the SAME live `payout.value` source payout.* already exposes (no historical replay path) - NaN whenever no payout source was wired into this evaluation. Never label this "implied volatility" unqualified; it is the payout-implied breakeven-probability proxy, same disclosure ivhv.ts\'s own header carries.',
    missingDataBehavior: 'NaN when payout is unavailable/0, or when hvNow() is 0 (never a divide-by-zero Infinity)',
    status: 'existing' /* resolved, loose-threads sweep */, mslAccessor: 'ivhv.ivNow() / ivhv.ratio(window?)',
  },

  // ---- Volume Profile (Phase 5) ----
  {
    id: 'vp.poc', label: 'Volume Profile POC', description: 'Point of Control - the price bin with the most approximate traded volume in the window. VOLUME-based - never confuse with tpo.poc (TIME-based).',
    chartTypes: ['volumeprofile'], engine: 'analytics/volumeprofile.ts#computeVolumeProfile',
    dataType: 'number', unit: 'price', historyKind: 'snapshot', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'estimated',
    qualityNote: 'volume spread across range-overlapping price bins - same proxy footprint.ts already uses and discloses, no bid/ask feed behind it.',
    missingDataBehavior: 'null (NaN via MSL) on an empty/degenerate window',
    status: 'existing', mslAccessor: 'vp.poc()',
  },
  {
    id: 'vp.valueArea', label: 'Volume Profile Value Area High/Low', description: 'The price range covering valueAreaPct of total volume, built outward from the POC row.',
    chartTypes: ['volumeprofile'], engine: 'analytics/volumeprofile.ts#computeVolumeProfile',
    dataType: 'number', unit: 'price', historyKind: 'snapshot', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'estimated',
    missingDataBehavior: 'null (NaN via MSL) on an empty/degenerate window',
    status: 'existing', mslAccessor: 'vp.vah() / vp.val()',
  },
  {
    id: 'vp.totalVolume', label: 'Volume Profile total volume', description: 'Sum of approximate volume across all bins in the window.',
    chartTypes: ['volumeprofile'], engine: 'analytics/volumeprofile.ts#computeVolumeProfile',
    dataType: 'number', unit: 'volume', historyKind: 'snapshot', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'estimated',
    missingDataBehavior: '0 on an empty window',
    status: 'existing', mslAccessor: 'vp.totalVolume()',
  },
  {
    id: 'vp.hvnLvn', label: 'High/Low-Volume Nodes', description: 'Price levels at/above hvnMult (or at/below lvnMult, and >0) times the window\'s mean row volume.',
    chartTypes: ['volumeprofile'], engine: 'analytics/volumeprofile.ts#computeVolumeProfile',
    dataType: 'series', unit: 'price', historyKind: 'snapshot', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'estimated',
    missingDataBehavior: 'empty array on an empty window',
    status: 'existing', mslAccessor: 'vp.hvn(n?) / vp.lvn(n?)',
  },

  // ---- Line Break (Phase 6) ----
  {
    id: 'linebreak.bars', label: 'Three-Line-Break lines', description: 'Close-based N-line-break bars - a new line only forms on a continuation beyond the last close or a reversal past the extreme close of the last N lines.',
    chartTypes: ['linebreak'], engine: 'analytics/linebreak.ts#lineBreak',
    dataType: 'series', unit: 'none', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    qualityNote: 'CLOSE-ONLY simplification, stated in linebreak.ts\'s own header - lines track open/close, not high/low.',
    missingDataBehavior: 'empty array before the first line paints',
    status: 'existing', mslAccessor: 'linebreak.bars(n?) / linebreak.ohlc(offset)',
  },
  {
    id: 'linebreak.streak', label: 'Line Break streak / line count', description: 'Consecutive same-direction lines ending at the last one, and the configured N-line-break reversal count.',
    chartTypes: ['linebreak'], engine: 'analytics/linebreak.ts#lineBreak',
    dataType: 'number', unit: 'bars', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: '0 before the first line paints',
    status: 'existing', mslAccessor: 'linebreak.streak() / linebreak.lineCount()',
  },

  // ---- Kagi (Phase 6) ----
  {
    id: 'kagi.line', label: 'Kagi line direction/thickness', description: 'The zig-zag line\'s current direction and thick("yang")/thin("yin") state.',
    chartTypes: ['kagi'], engine: 'analytics/kagi.ts#kagi',
    dataType: 'direction', unit: 'none', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'direction 0, thick true (default) before the series starts or reversal<=0',
    status: 'existing', mslAccessor: 'kagi.direction() / kagi.thick()',
  },
  {
    id: 'kagi.levels', label: 'Kagi reversal/shoulder/waist', description: 'Current ATR-adaptive (or explicit) reversal threshold; the shoulder (high before last down-reversal) and waist (low before last up-reversal).',
    chartTypes: ['kagi'], engine: 'analytics/kagi.ts#kagi',
    dataType: 'number', unit: 'price', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'shoulder/waist null (NaN via MSL) until one has occurred',
    status: 'existing', mslAccessor: 'kagi.reversal() / kagi.shoulder() / kagi.waist()',
  },

  // ---- Swing (Phase 6) ----
  {
    id: 'swing.structure', label: 'Swing hh-hl / lh-ll structure', description: 'Compares only the last two confirmed swing highs and last two confirmed swing lows - "none" when they do not move cleanly together.',
    chartTypes: ['swing'], engine: 'analytics/swing.ts#computeSwing',
    dataType: 'string', unit: 'none', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    qualityNote: 'HONEST LAG: a swing needs `lookback` bars after it to confirm - the most recent `lookback` closed bars can never have a confirmed swing yet. Not a bug.',
    missingDataBehavior: '"none" with fewer than 2 confirmed highs+lows',
    status: 'existing', mslAccessor: 'swing.structure() / swing.direction()',
  },
  {
    id: 'swing.points', label: 'Confirmed swing high/low points', description: 'Individual confirmed swing high/low prices by offset, and the bar-index length of the most recent leg.',
    chartTypes: ['swing'], engine: 'analytics/swing.ts#computeSwing',
    dataType: 'number', unit: 'price', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'throws a dedicated "no confirmed swing highs/lows yet" error rather than a confusing out-of-range message',
    status: 'existing', mslAccessor: 'swing.high(offset) / swing.low(offset) / swing.length()',
  },

  // ---- Phase 7: new verdict sources (wrap the raw primitives above/foot.*; raw stays independently readable) ----
  {
    id: 'verdict.volumeProfile', label: 'Volume Profile verdict', description: 'POC-distance reduction on vp.poc()/vah()/val() - same shape as the tpo verdict, mirrored onto volume instead of time.',
    chartTypes: ['volumeprofile'], engine: 'plugins/metastrategy.ts#readSource(\'volumeProfile\')',
    dataType: 'direction', unit: 'none', historyKind: 'live', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ['metaStrategyEval', 'metaStrategyTestScript'], quality: 'estimated',
    missingDataBehavior: '\'none\' verdict when the profile is too thin or close sits exactly on POC',
    status: 'existing', mslAccessor: 'volumeProfile (bare source identifier)',
  },
  {
    id: 'verdict.lineBreak', label: 'Line Break verdict', description: 'Direction = the current line\'s own direction; confidence scaled by the consecutive-same-direction streak.',
    chartTypes: ['linebreak'], engine: 'plugins/metastrategy.ts#readSource(\'lineBreak\')',
    dataType: 'direction', unit: 'none', historyKind: 'live', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ['metaStrategyEval', 'metaStrategyTestScript'], quality: 'measured',
    missingDataBehavior: '\'none\' verdict before the first line paints',
    status: 'existing', mslAccessor: 'lineBreak (bare source identifier)',
  },
  {
    id: 'verdict.kagi', label: 'Kagi verdict', description: 'Direction = the current trend direction; confidence boosted when the line is thick (yang).',
    chartTypes: ['kagi'], engine: 'plugins/metastrategy.ts#readSource(\'kagi\')',
    dataType: 'direction', unit: 'none', historyKind: 'live', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ['metaStrategyEval', 'metaStrategyTestScript'], quality: 'measured',
    missingDataBehavior: '\'none\' verdict before the first line paints',
    status: 'existing', mslAccessor: 'kagi (bare source identifier)',
  },
  {
    id: 'verdict.swing', label: 'Swing structure verdict', description: 'Direction from the confirmed hh-hl/lh-ll structure read only - \'none\' structure never forces a guess.',
    chartTypes: ['swing'], engine: 'plugins/metastrategy.ts#readSource(\'swing\')',
    dataType: 'direction', unit: 'none', historyKind: 'live', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ['metaStrategyEval', 'metaStrategyTestScript'], quality: 'measured',
    missingDataBehavior: '\'none\' verdict when structure is \'none\'',
    status: 'existing', mslAccessor: 'swing (bare source identifier)',
  },
  {
    id: 'verdict.footDivergence', label: 'Footprint divergence-trap verdict', description: 'The Metric-B divergence trap off the real tick buffer - \'put-trap\' reads PUT, \'call-trap\' reads CALL.',
    chartTypes: ['otcfootprint'], engine: 'plugins/metastrategy.ts#readSource(\'footDivergence\')',
    dataType: 'direction', unit: 'none', historyKind: 'live', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ['omniTrader'], quality: 'measured',
    missingDataBehavior: '\'none\' verdict with a cold tick buffer or no divergence trap in the recent buckets',
    status: 'existing', mslAccessor: 'footDivergence (bare source identifier)',
  },
  {
    id: 'verdict.footStackedImbalance', label: 'Footprint stacked-imbalance verdict', description: 'Consecutive same-direction diagonal imbalance across several footprint buckets, checked both ways.',
    chartTypes: ['otcfootprint'], engine: 'plugins/metastrategy.ts#readSource(\'footStackedImbalance\')',
    dataType: 'direction', unit: 'none', historyKind: 'live', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ['omniTrader'], quality: 'measured',
    missingDataBehavior: '\'none\' verdict with a cold tick buffer or no qualifying stack on either side',
    status: 'existing', mslAccessor: 'footStackedImbalance (bare source identifier)',
  },

  // ---- Post-roadmap follow-up session: baseline.ts, tickbar.*, ivhv.*, and
  // footprint's own VAH/VAL/diagonal-imbalance/absorption/unfinished-auction
  // (closes claude/chart-engine-roadmap-progress.md's "still open" items) ----
  {
    id: 'baseline.deviation', label: 'Baseline value/deviation', description: 'The window\'s first close (the flat reference line itself) and current price\'s deviation/%deviation/above-below state against it.',
    chartTypes: ['baseline'], engine: 'analytics/baseline.ts#computeBaseline',
    dataType: 'number', unit: 'price', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: 'throws "needs at least 1 bar of history" on an empty window',
    status: 'existing', mslAccessor: 'baseline.value() / baseline.deviation() / baseline.deviationPct() / baseline.above()',
  },
  {
    id: 'baseline.cross', label: 'Baseline crossing + history', description: 'Signed crossing direction on the most recent bar (+1/-1/0), and the full per-bar deviation series.',
    chartTypes: ['baseline'], engine: 'analytics/baseline.ts#computeBaseline',
    dataType: 'series', unit: 'price', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: '0 (no crossing) with fewer than 2 bars',
    status: 'existing', mslAccessor: 'baseline.cross() / baseline.deviationSeries(n?)',
  },
  {
    id: 'verdict.baseline', label: 'Baseline verdict', description: 'Direction = fresh crossing direction when just crossed this bar, else plain above/below; confidence scaled by |deviationPct|.',
    chartTypes: ['baseline'], engine: 'plugins/metastrategy.ts#readSource(\'baseline\')',
    dataType: 'direction', unit: 'none', historyKind: 'live', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    missingDataBehavior: '\'none\' verdict when price sits exactly on the baseline with no lean',
    status: 'existing', mslAccessor: 'baseline (bare source identifier)',
  },
  {
    id: 'tickbar.ohlc', label: 'Tick-bar OHLC/direction/duration', description: 'Real tick-count bars (default 10 ticks/bar) - full OHLC by offset, direction, and formation duration.',
    chartTypes: ['tickchart'], engine: 'analytics/tickbars.ts#tickBars (via strategylang.ts#tickbarMethod)',
    dataType: 'number', unit: 'price', historyKind: 'historical', updateFrequency: 'per-tick',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    qualityNote: 'REAL ticks (dataSource "tick") only inside the Omni Trader with a live tick feed; everywhere else honestly falls back to candle-close pseudo-ticks (dataSource "candle") - always check tickbar.dataSource() before presenting as real tick data.',
    missingDataBehavior: 'empty series with no ticks/candles yet',
    status: 'existing', mslAccessor: 'tickbar.bars(n?, per?) / tickbar.ohlc(offset, per?) / tickbar.direction(per?) / tickbar.duration(per?) / tickbar.dataSource()',
  },
  {
    id: 'ivhv.realized', label: 'Realized/historical volatility', description: 'Rolling-stddev-of-log-returns historical volatility (annualized), its series, change over a lookback, and percentile rank; plus realized up-close probability.',
    chartTypes: ['ivhv'], engine: 'analytics/ivhv.ts#hvSeries / #realizedUpProb (via strategylang.ts#ivhvMethod)',
    dataType: 'number', unit: 'percentage', historyKind: 'historical', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'measured',
    qualityNote: 'Candle-derived only - deliberately does NOT cover this file\'s IV/breakeven side (depends on MarketDataService\'s live payoutHistory, no backtest replay path; already covered by the payout source\'s own arithmetic).',
    missingDataBehavior: '0 on an empty window',
    status: 'existing', mslAccessor: 'ivhv.hvNow(window?) / ivhv.hvSeries(n?) / ivhv.realizedUpProb(window?) / ivhv.change(lookback?) / ivhv.percentile(lookback?)',
  },
  {
    id: 'footprint.valueArea', label: 'Footprint\'s own VAH/VAL', description: 'Classic value-area algorithm run on real tick-row totals (not candle-overlap-estimated volume) - distinct from both tpo.vah/val (time-based) and vp.vah/val (candle-overlap-estimated).',
    chartTypes: ['otcfootprint', 'tickfootprint'], engine: 'analytics/otcfootprint.ts#footprintValueArea (via strategylang.ts foot.vah()/foot.val())',
    dataType: 'number', unit: 'price', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'all', supportedContexts: ['omniTrader'], quality: 'measured',
    missingDataBehavior: 'NaN on an empty/too-thin bucket',
    status: 'existing', mslAccessor: 'foot.vah(windowSec?, pct?) / foot.val(windowSec?, pct?)',
  },
  {
    id: 'footprint.diagonalImbalance', label: 'Diagonal imbalance', description: 'This level\'s buy-side prints vs the level BELOW\'s sell-side prints (the classic footprint "diagonal" read) - distinct from foot.imbalance()\'s same-level check.',
    chartTypes: ['otcfootprint', 'tickfootprint'], engine: 'analytics/otcfootprint.ts#diagonalImbalance (via strategylang.ts foot.diagonalImbalance())',
    dataType: 'boolean', unit: 'none', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'all', supportedContexts: ['omniTrader'], quality: 'measured',
    missingDataBehavior: 'false on an empty/too-thin bucket',
    status: 'existing', mslAccessor: 'foot.diagonalImbalance(side, ratio, windowSec?)',
  },
  {
    id: 'footprint.absorption', label: 'Absorption detection', description: 'Heavy print density packed into few price rows with closePos staying mid-range despite a real delta - the side whose aggression got absorbed, a documented explicit heuristic (no universal textbook formula exists).',
    chartTypes: ['otcfootprint', 'tickfootprint'], engine: 'analytics/otcfootprint.ts#footprintAbsorption (via strategylang.ts foot.absorption() / verdict footAbsorption)',
    dataType: 'string', unit: 'none', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'all', supportedContexts: ['omniTrader'], quality: 'measured',
    qualityNote: 'Explicit documented heuristic, not a textbook formula - see otcfootprint.ts#footprintAbsorption\'s own header comment.',
    missingDataBehavior: '\'none\' on an empty/too-thin bucket or no qualifying read',
    status: 'existing', mslAccessor: 'foot.absorption(windowSec?) / footAbsorption (bare source identifier)',
  },
  {
    id: 'footprint.unfinishedAuction', label: 'Unfinished auction detection', description: 'The bucket\'s busiest price node (POC) sitting at its own high or low - the auction never rotated away from that edge.',
    chartTypes: ['otcfootprint', 'tickfootprint'], engine: 'analytics/otcfootprint.ts#unfinishedAuction (via strategylang.ts foot.unfinishedAuction() / verdict footUnfinishedAuction)',
    dataType: 'string', unit: 'none', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'all', supportedContexts: ['omniTrader'], quality: 'measured',
    missingDataBehavior: '\'none\' when the POC is not at either edge, or on an empty/too-thin bucket',
    status: 'existing', mslAccessor: 'foot.unfinishedAuction(windowSec?) / footUnfinishedAuction (bare source identifier)',
  },
  {
    id: 'footprint.deltaMetrics', label: 'Delta % and delta velocity', description: 'Signed delta as a percentage of total prints, and the rate of change of delta across consecutive buckets.',
    chartTypes: ['otcfootprint', 'tickfootprint'], engine: 'analytics/otcfootprint.ts#FootprintBucket (via strategylang.ts foot.deltaPct() / foot.deltaVelocity())',
    dataType: 'number', unit: 'percentage', historyKind: 'live', updateFrequency: 'per-tick',
    supportedTimeframes: 'all', supportedContexts: ['omniTrader'], quality: 'measured',
    missingDataBehavior: '0 on an empty/too-thin bucket or too-thin history',
    status: 'existing', mslAccessor: 'foot.deltaPct(windowSec?) / foot.deltaVelocity(bucketSec?, buckets?)',
  },

  // ---- Delta Profile (post-roadmap follow-up session) - the 5th new chart
  // type, deferred since Phase 6 ----
  {
    id: 'deltaprofile.nodes', label: 'Delta Profile positive/negative nodes', description: 'The strongest buy node (largest positive delta row) and strongest sell node (largest negative delta row) across the window, via the same CLV proxy footprint.ts uses.',
    chartTypes: ['deltaprofile'], engine: 'analytics/deltaprofile.ts#computeDeltaProfile',
    dataType: 'number', unit: 'price', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'estimated',
    missingDataBehavior: 'NaN on an empty window',
    status: 'existing', mslAccessor: 'dp.positiveDeltaPoc() / dp.negativeDeltaPoc()',
  },
  {
    id: 'deltaprofile.skew', label: 'Delta Profile net skew/totals', description: 'Total net delta and total volume across the window, and the net delta as a fraction of total volume (-1..1) - the profile\'s own bullish/bearish skew.',
    chartTypes: ['deltaprofile'], engine: 'analytics/deltaprofile.ts#computeDeltaProfile',
    dataType: 'number', unit: 'ratio', historyKind: 'live', updateFrequency: 'per-bar-close',
    supportedTimeframes: 'all', supportedContexts: ALL_CONTEXTS, quality: 'estimated',
    missingDataBehavior: '0 on an empty window',
    status: 'existing', mslAccessor: 'dp.totalDelta() / dp.totalVolume() / dp.deltaSkew() / dp.deltaAt(price)',
  },
  {
    id: 'verdict.deltaProfile', label: 'Delta Profile verdict', description: 'Direction from the window\'s own net deltaSkew; confidence scaled by |deltaSkew|.',
    chartTypes: ['deltaprofile'], engine: 'plugins/metastrategy.ts#readSource(\'deltaProfile\')',
    dataType: 'direction', unit: 'none', historyKind: 'live', updateFrequency: 'per-poll',
    supportedTimeframes: 'all', supportedContexts: ['metaStrategyEval', 'metaStrategyTestScript'], quality: 'estimated',
    missingDataBehavior: '\'none\' verdict when the window has no net delta lean',
    status: 'existing', mslAccessor: 'deltaProfile (bare source identifier)',
  },
]

// ---------------------------------------------------------------------------
// Query helpers - the only way anything (strategylang.ts, /signal_vocab, a
// future UI) should read this registry. Never iterate CHART_PROPERTY_REGISTRY
// directly from outside this module so a future refactor of its shape has
// one call site to update, not N.

export function propertiesForChart(chartType: ChartType): ChartPropertyDef[] {
  return CHART_PROPERTY_REGISTRY.filter((p) => p.chartTypes.includes(chartType))
}

export function propertyById(id: string): ChartPropertyDef | undefined {
  return CHART_PROPERTY_REGISTRY.find((p) => p.id === id)
}

export function propertiesByStatus(status: ExposureStatus): ChartPropertyDef[] {
  return CHART_PROPERTY_REGISTRY.filter((p) => p.status === status)
}

/** Grouped-by-chart-type shape for /signal_vocab - one array per ChartType
 * that actually has registry entries, so a caller doesn't have to filter
 * CHART_PROPERTY_REGISTRY itself. */
export function chartPropertyRegistryForVocab(): Record<string, ChartPropertyDef[]> {
  const out: Record<string, ChartPropertyDef[]> = {}
  for (const p of CHART_PROPERTY_REGISTRY) {
    for (const ct of p.chartTypes) {
      ;(out[ct] ??= []).push(p)
    }
  }
  return out
}
