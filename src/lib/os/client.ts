'use client'

// IQAIR//OS - client runtime: REST client + socket feed + shared types
import { useEffect, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'

export type Timeframe = '5s' | '15s' | '30s' | '1m' | '2m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d'
export const TIMEFRAMES: Timeframe[] = ['5s', '15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d']
// Mirrors trading-core's types.ts TIMEFRAME_SECONDS - needed client-side to
// turn a lab spec's `horizon` (bars-ahead the learner validated against) into
// an actual expiry duration when deploying it as a bot.
export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '5s': 5,
  '15s': 15,
  '30s': 30,
  '1m': 60,
  '2m': 120,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
}

export type TradeKind = 'binary' | 'turbo' | 'digital' | 'cfd'
export const TRADE_KINDS: TradeKind[] = ['binary', 'turbo', 'digital', 'cfd']
export const KIND_LABEL: Record<TradeKind, string> = { binary: 'Binary', turbo: 'Turbo', digital: 'Digital', cfd: 'CFD' }

export type ChartType =
  | 'candles' | 'hollow' | 'heikin' | 'bars' | 'line' | 'area' | 'baseline'
  | 'renko' | 'pointfigure'
  // Task 63 chart-type engines (kernel routes: /rangebars /volumebars
  // /footprint /tpo /ticks /iv_hv - engines of record in trading-core)
  | 'rangebars' | 'volumebars' | 'footprint' | 'tpo' | 'tickchart' | 'ivhv'
  // OTC micro-tick velocity footprint (kernel route /otc_footprint)
  | 'otcfootprint'
export const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'candles', label: 'Candles' },
  { id: 'hollow', label: 'Hollow' },
  { id: 'heikin', label: 'Heikin Ashi' },
  { id: 'bars', label: 'Bars' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'baseline', label: 'Baseline' },
  { id: 'renko', label: 'Renko' },
  { id: 'pointfigure', label: 'P&F' },
  { id: 'rangebars', label: 'Range' },
  { id: 'volumebars', label: 'Vol Bars' },
  { id: 'footprint', label: 'Footprint' },
  { id: 'otcfootprint', label: 'OTC Footprint' },
  { id: 'tpo', label: 'TPO' },
  { id: 'tickchart', label: 'Tick' },
  { id: 'ivhv', label: 'IV·HV' },
]

// kernel route payloads for the Task 63 chart fetches (ChartPanel)
export interface TickBarRow { time: number; endTime: number; open: number; high: number; low: number; close: number; ticks: number }
export interface TicksResponse { ok: boolean; dataSource: 'tick' | 'candle'; per: number; note: string; bars: TickBarRow[] }
export interface IvHvResponse {
  ok: boolean
  hv: { time: number; hv: number }[]
  hvNow: number
  annualization: string
  iv: { time: number; payout: number; breakevenPct: number }[]
  ivSource: 'observed' | 'current' | 'none'
  ivRule: string
  realizedUpProbPct: number
}

export type AssetCategory = 'forex' | 'crypto' | 'commodity' | 'stock' | 'index'
export const CATEGORIES: { id: 'all' | 'otc' | AssetCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'forex', label: 'Forex' },
  { id: 'otc', label: 'OTC' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'commodity', label: 'Comm.' },
  { id: 'stock', label: 'Stocks' },
  { id: 'index', label: 'Indices' },
]

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface AssetRow {
  ticker: string
  name: string
  category: AssetCategory
  otc?: boolean
  price: number
  /** real broker payout (0-1) for binary; null = not reported (IQ margin CFDs/stocks, unknown) */
  payout: number | null
  turboPayout?: number | null
  digitalPayout?: number | null
  leverage?: number
  schedule?: '24/7' | '24/5' | 'market'
  open: boolean
  iq?: boolean // tradeable on the connected IQ account right now
  iqairName?: string
}

export interface InstrumentStats {
  total: number
  forex: number
  otc: number
  crypto: number
  commodities: number
  stocks: number
  indices: number
}

// ---------- Indicator registry types ----------

export interface IndicatorParamDef {
  key: string
  label: string
  type: 'number'
  min: number
  max: number
  step?: number
  default: number
}

export interface RegistryEntry {
  id: string
  name: string
  category: 'overlap' | 'momentum' | 'volume' | 'volatility' | 'trend' | 'cycle' | 'statistic' | 'patterns' | 'structural'
  pane: 'overlay' | 'sub'
  params: IndicatorParamDef[]
  description: string
}

export interface IndicatorSeries {
  id: string
  name: string
  category: string
  pane: 'overlay' | 'sub'
  params: Record<string, number>
  time: number[]
  lines: { key: string; color: string; style?: string; width?: number; values: (number | null)[] }[]
  markers?: {
    time: number
    position: 'aboveBar' | 'belowBar'
    shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square'
    color: string
    text?: string
    size?: number
  }[]
  hist?: { values: (number | null)[]; color: string }
  levels?: number[]
  bands?: [number, number]
  fillBetween?: [number, number]
  note?: string
}

export interface ChartPatternHit {
  name: string
  direction: 'bullish' | 'bearish' | 'neutral'
  startIndex: number
  endIndex: number
  confidence: number
  note: string
}

export interface Factor {
  name: string
  group: string
  value: number
  vote: number
  weight: number
  note: string
}

// ---------- order flow (approximation - see trading-core/src/analytics/orderflow.ts) ----------
// IQ Option exposes no real bid/ask-tagged trades or order-book depth, so all
// of this is derived from OHLCV candles via a close-location-value (CLV) proxy.
// Never present it as real order-flow data in the UI - always label it approx.

export interface VolumeProfileLevel {
  price: number
  priceLow: number
  priceHigh: number
  volume: number
  buyVolume: number
  sellVolume: number
}

export interface VolumeProfileResult {
  levels: VolumeProfileLevel[]
  poc: number
  valueAreaHigh: number
  valueAreaLow: number
  totalVolume: number
}

export interface CandleDelta {
  time: number
  buyVolume: number
  sellVolume: number
  delta: number
}

export interface CumulativeDeltaPoint {
  time: number
  cumulativeDelta: number
}

export async function getVolumeProfile(asset: string, tf: Timeframe, opts?: { limit?: number; buckets?: number }): Promise<VolumeProfileResult> {
  const d = await osGet<{ ok: boolean; profile: VolumeProfileResult }>('/volume_profile', {
    asset,
    tf,
    limit: opts?.limit,
    buckets: opts?.buckets,
  })
  return d.profile
}

// ---------- OTC micro-tick velocity footprint (see trading-core/src/analytics/otcfootprint.ts) ----------
// OTC feeds are generator scripts - no order book, no real volume. This chart
// reads the generator's own price-print stream instead: per price row up/down
// tick speeds, velocity delta, speed ratio and cluster stagnation (the OTC POC).
// The source is REAL captured prints (sidecar 100ms live / sim 1s), with the
// capture cadence labeled honestly on every response.

export interface OtcFootprintRow {
  price: number
  up: number
  dn: number
  upMs: number
  dnMs: number
  upFast: number
  dnFast: number
  total: number
}

export interface OtcFootprintBucket {
  time: number
  open: number
  high: number
  low: number
  close: number
  nTicks: number
  upTicks: number
  dnTicks: number
  upAvgMs: number
  dnAvgMs: number
  speedRatio: number
  velDelta: number
  rows: OtcFootprintRow[]
  pocPrice: number
  pocTicks: number
  stagnation: number
  closePos: number
  divergence: 'put-trap' | 'call-trap' | null
  exhaustion: 'up' | 'down' | null
}

export interface OtcFootprintResult {
  ok: boolean
  asset: string
  bucketSec: number
  tickSize: number
  dataSource: string
  cadenceMs: number | null
  minutes: number
  buckets: OtcFootprintBucket[]
  summary: {
    totalUp: number
    totalDn: number
    netDelta: number
    avgSpeedRatio: number
    dominantPoc: number
    signal: 'call' | 'put' | 'none'
    score: number
    note: string
  }
}

export async function getOtcFootprint(asset: string, opts?: { minutes?: number; bucketSec?: number }): Promise<OtcFootprintResult> {
  return osGet<OtcFootprintResult>('/otc_footprint', {
    asset,
    minutes: opts?.minutes,
    bucketSec: opts?.bucketSec,
  })
}

// ---------- chart-signal scanner (Signal Panel) ----------

export type ChartEngineId = 'renko' | 'pnf' | 'range' | 'tick' | 'footprint' | 'otcfootprint' | 'heikin' | 'candle'

export const CHART_ENGINE_LABEL: Record<ChartEngineId, string> = {
  renko: 'RNK',
  pnf: 'P&F',
  range: 'RNG',
  tick: 'TCK',
  footprint: 'FP',
  otcfootprint: 'OTC FP',
  heikin: 'H/A',
  candle: 'CND',
}

export interface ChartEngineVote {
  engine: ChartEngineId
  dir: 1 | -1 | 0
  weight: number
  note: string
}

export interface CfdLevels {
  entry: number
  sl: number
  tp: number
  slDist: number
  tpDist: number
  rr: number
}

export interface ChartSignal {
  asset: string
  name: string
  category: string
  otc: boolean
  price: number
  direction: 'call' | 'put'
  score: number
  strength: number
  agree: number
  total: number
  expirySec: number
  votes: ChartEngineVote[]
  cfd: CfdLevels | null
  ts: number
  validUntil: number
  dataSource: string
}

export interface ChartSignalsResponse {
  ok: boolean
  kind: 'option' | 'cfd'
  /** timeframe the scan actually ran on - the panel shows this so the
   * operator always knows which candles the reads were computed on */
  tf: Timeframe
  scanned: number
  considered: number
  qualifying: number
  /** Open instruments found this pass - scanned should equal it. */
  universe?: number
  /** OTC coverage of the same pass (panel's OTC filter view). */
  otcScanned?: number
  otcConsidered?: number
  otcQualifying?: number
  signals: ChartSignal[]
  ts: number
  scanMs: number
}

/** Full scan by default (no top param) - the panel renders every qualifying
 * read; pass a positive `top` to get a short list (kernel clamps at 200).
 * `tf` is the chart's active timeframe - the scan runs on those candles. */
export async function getChartSignals(kind: 'option' | 'cfd', tf: Timeframe, top?: number): Promise<ChartSignalsResponse> {
  return osGet<ChartSignalsResponse>(
    '/signals',
    top && top > 0 ? { kind, tf, top } : { kind, tf },
  )
}

// ---- chart-signal outcome stats (Task 64-c: the honesty loop) ------------

export type SignalOutcomeId = 'win' | 'loss' | 'flat' | 'timeout'

export interface ResolvedSignalOutcome {
  id: string
  kind: 'option' | 'cfd'
  asset: string
  otc: boolean
  direction: 'call' | 'put'
  entry: number
  exit: number
  expirySec: number
  ts: number
  resolvedAt: number
  movePct: number
  outcome: SignalOutcomeId
  touched: 'tp' | 'sl' | null
  maxFavPct: number
  maxAdvPct: number
  score: number
  strength: number
  agree: number
  total: number
  engines: { engine: ChartEngineId; dir: 1 | -1; hit: boolean }[]
}

export interface SignalEngineStat {
  engine: ChartEngineId
  votes: number
  hits: number
  winRate: number | null
}

export interface SignalKindStats {
  recorded: number
  pending: number
  resolved: number
  wins: number
  losses: number
  flats: number
  timeouts: number
  winRate: number | null
  avgMovePct: number
  engines: SignalEngineStat[]
  byMarket: { real: { wins: number; losses: number; winRate: number | null }; otc: { wins: number; losses: number; winRate: number | null } }
  recent: ResolvedSignalOutcome[]
}

/** Outcome stats - `tf` scores only reads computed on that timeframe's
 * candles (the honesty loop attributes per tf); omitted = all blended. */
export async function getSignalStats(tf?: Timeframe): Promise<{ ok: boolean; option: SignalKindStats; cfd: SignalKindStats; ts: number }> {
  return osGet<{ ok: boolean; option: SignalKindStats; cfd: SignalKindStats; ts: number }>(
    '/signals_stats',
    tf ? { tf } : {},
  )
}

// ---- same-time-yesterday scanner (Task: "what did the market do at this
// time yesterday?") ----------------------------------------------------------
// Kernel route /yesterday: per open instrument, the story of the window that
// started exactly 24h ago - price at the moment, the window's net move /
// range / run-up / drawdown, where price has gone since, the session the
// market was in, and coverage honesty (bars found vs expected, how many came
// from the kernel's own store vs deterministic prehistory).

export type YdayDir = 'up' | 'down' | 'none'
export type YdaySession = 'ASIA' | 'LONDON' | 'OVERLAP' | 'NEWYORK' | 'OFF' | 'OTC'

/** The window leading INTO the moment (same length as the replay window),
 * yesterday vs today - "is today repeating yesterday's lead-in?". Kernel
 * sends null when either side is under half covered (dark session, asset
 * never warmed); optional on the wire so an older kernel still parses. */
export interface YesterdayEcho {
  /** net move over the lead-in window, yesterday (%) */
  ydayMovePct: number
  /** high-low travel over the lead-in window, yesterday (%) */
  ydayRangePct: number
  /** same wall-clock lead-in window, today (%) */
  todayMovePct: number
  todayRangePct: number
  /** bars present on today's side of the comparison */
  todayBarsFound: number
  /** 'same' = both pushed the same way (or both flat), 'opposite' = pushed against each other, 'partial' = one went nowhere */
  dirAgree: 'same' | 'partial' | 'opposite'
  /** 0..100 - direction agreement (50) + move magnitude vs yesterday's own travel (30) + travel ratio (20) */
  rhyme: number
}

export interface YesterdayRow {
  asset: string
  name: string
  category: AssetCategory
  otc: boolean
  /** epoch seconds of the bar that was forming exactly 24h ago (window start) */
  thenTs: number
  /** price at that moment (open of the bar containing T-24h) */
  thenPrice: number
  /** price right now */
  nowPrice: number
  /** (now - then) / then, % - where the market has gone since that moment */
  sincePct: number
  /** net move over the window that started at that moment, % */
  movePct: number
  dir: YdayDir
  /** high-low travel across the window, % of thenPrice */
  rangePct: number
  /** best excursion above thenPrice inside the window, % */
  runUpPct: number
  /** deepest excursion below thenPrice inside the window, % */
  drawdownPct: number
  /** window bars present vs expected - coverage is displayed, never implied */
  barsFound: number
  barsExpected: number
  /** of the bars found, how many came from the kernel's store (accumulated history) */
  archived: number
  /** session the market was in at that moment yesterday */
  session: YdaySession
  /** lead-in comparison, yesterday vs today (see YesterdayEcho); null/absent = either side under half covered */
  echo?: YesterdayEcho | null
}

export interface YesterdayResponse {
  ok: boolean
  tf: Timeframe
  /** effective forward window in minutes (snapped to whole bars of the tf) */
  windowMin: number
  /** feed behind the scan: 'sim' = deterministic sim engine, 'live' = broker feed */
  mode: 'sim' | 'live'
  scanned: number
  considered: number
  skipped: number
  rows: YesterdayRow[]
  ts: number
  scanMs: number
}

/** Same-time-yesterday scan. `tf` = the chart's active timeframe - the
 * lookback runs on those candles (the kernel refuses timeframes whose
 * 24h + 2x window lookback cannot fit the 4000-bar archive depth). `windowMin`
 * is the forward window replayed after T-24h (5..240, default 60); every row
 * also carries the echo lead-in comparison where coverage allows. */
export async function getYesterday(tf: Timeframe, windowMin = 60): Promise<YesterdayResponse> {
  return osGet<YesterdayResponse>('/yesterday', { tf, window: windowMin })
}

// ---- engine-edge research (both loops merged: honesty + lab) -------------
// Kernel route /engines_edge: per chart engine, the live honesty loop's real
// resolved reads AND a deep-history lab measurement (engine votes replayed
// through the binary settlement engine, Wilson interval vs payout breakeven),
// pooled into edge / watch / thin / coinflip / fade verdicts.

export interface EngineEdgeLiveStat {
  votes: number
  hits: number
  winRate: number | null
}

export interface EngineEdgeDirRow {
  dir: 'call' | 'put'
  n: number
  wins: number
  winRate: number | null
  edgeLB: number | null
  assets: { asset: string; n: number; wins: number; winRate: number; netPnl: number; pf: number }[]
}

export interface EngineEdgeEngine {
  engine: string
  label: string
  verdict: 'edge' | 'watch' | 'thin' | 'coinflip' | 'fade' | 'live-only' | 'no-data'
  n: number
  winRate: number | null
  wilsonLB: number | null
  wilsonUB: number | null
  edgeLB: number | null
  live: { option?: EngineEdgeLiveStat; cfd?: EngineEdgeLiveStat }
  byDir: EngineEdgeDirRow[]
}

export interface EnginesEdgeResponse {
  ok: boolean
  tf: Timeframe
  window: number
  expiryBars: number
  payout: number
  breakevenWinRate: number
  minN: number
  assets: string[]
  engines: EngineEdgeEngine[]
  liveKinds: {
    option: { resolved: number; wins: number; losses: number; winRate: number | null; pending: number }
    cfd: { resolved: number; wins: number; losses: number; winRate: number | null; timeouts: number; pending: number }
  }
  labSpecs: { id: string; name: string; asset: string; tf: string; trades: number; winRate: number | null; ciLow: number | null; decayed: boolean }[]
  note: string
  ts: number
}

export async function getEnginesEdge(
  params: { tf?: string; assets?: string; window?: number; expiryBars?: number; payout?: number; minN?: number } = {}
): Promise<EnginesEdgeResponse> {
  return osGet<EnginesEdgeResponse>('/engines_edge', params as Record<string, string | number | undefined>)
}

export async function getDelta(asset: string, tf: Timeframe, opts?: { limit?: number }): Promise<{ deltas: CandleDelta[]; cumulative: CumulativeDeltaPoint[] }> {
  const d = await osGet<{ ok: boolean; deltas: CandleDelta[]; cumulative: CumulativeDeltaPoint[] }>('/delta', {
    asset,
    tf,
    limit: opts?.limit,
  })
  return { deltas: d.deltas, cumulative: d.cumulative }
}

// ---------- randomness audit (descriptive feed statistics) ----------
// Characterizes an OTC feed's empirical behavior - step size, return
// volatility/skew/kurtosis, update cadence. Purely descriptive: this is
// NOT a prediction mechanism and says nothing about a broker's internal
// RNG/seed, just what the observable price series statistically looks
// like. dataSource is 'tick' (real sub-candle price observations buffered
// by the sidecar) or 'candle' (finest available candle resolution, '5s') -
// always label which one was used, same honesty convention as order flow's
// "(approx)" tagging.

export interface RandomnessStepStats {
  meanAbsStep: number
  stdDevReturns: number
  skewness: number
  excessKurtosis: number
  n: number
}

export interface RandomnessIntervalStats {
  meanIntervalMs: number
  medianIntervalMs: number
  updatesPerSecond: number
  jitterStdDevMs: number
  n: number
}

export interface RandomnessAudit {
  asset: string
  dataSource: 'tick' | 'candle'
  stepStats: RandomnessStepStats
  intervalStats: RandomnessIntervalStats
}

export async function getRandomnessAudit(asset: string, tf?: Timeframe): Promise<RandomnessAudit> {
  const d = await osGet<{ ok: boolean } & RandomnessAudit>('/randomness_audit', { asset, tf })
  return { asset: d.asset, dataSource: d.dataSource, stepStats: d.stepStats, intervalStats: d.intervalStats }
}

// ---------- candle math (candle blending / candlestick algebra) ----------
// See trading-core/src/analytics/candlemath.ts for the exact blend rule
// (Open=first, High=max, Low=min, Close=last) and the pattern-confirmed
// "smart grouping" heuristic (a group is only reported when blending it
// reveals a candlestick pattern that the raw, unblended candles don't show).

export interface CandleMathBlend {
  startIdx: number
  endIdx: number
  blended: Candle
  patterns: string[]
  rawPatterns: string[]
}

export interface CandleMathResult {
  raw: Candle[]
  blends: CandleMathBlend[]
}

export async function getCandleMath(
  asset: string,
  tf: Timeframe,
  opts?: { limit?: number; maxGroup?: number },
): Promise<CandleMathResult> {
  const d = await osGet<{ ok: boolean; raw: Candle[]; blends: CandleMathBlend[] }>('/candle_math', {
    asset,
    tf,
    limit: opts?.limit,
    maxGroup: opts?.maxGroup,
  })
  return { raw: d.raw, blends: d.blends }
}

// ---------- OTC defense (placebo-test gate for generator-driven markets) ----------
// OTC charts are machine-generated, so a TA edge claimed on them must prove
// itself against our OWN calibrated chart generator (see
// trading-core/src/analytics/synthfeed.ts): the same strategy is run on the
// real pair AND on K synthetic twins that reproduce the pair's measured
// statistics with zero learnable structure. edgeZ = how many sigmas the real
// win rate sits above the placebo mean. Verdicts: 'edge' (real beats the
// placebo), 'weak' (suggestive), 'no_edge' (indistinguishable from luck),
// 'inconclusive' (too few real trades).

export type OtcVerdictClass = 'edge' | 'weak' | 'no_edge' | 'inconclusive'
export type OtcPolicy = 'enforce' | 'warn' | 'off'

export interface OtcConfig {
  policy: OtcPolicy
  minEdgeZ: number
  seriesK: number
  ttlDays: number
  minRealTrades: number
}

export interface OtcDefenseReport {
  ok: boolean
  asset: string
  strategyKey: string
  tf: string
  isOtc: boolean
  verdict: OtcVerdictClass
  edgeZ: number
  real: { winRate: number; totalTrades: number; profitFactor: number; expectancy: number; netPnl: number }
  placebo: { series: number; winRateMean: number; winRateStd: number; winRateP95: number; expectancyMean: number }
  calibration: { source: 'tick' | 'candle'; n: number; blockLen: number; seedBase: number; meanAbsStep: number; excessKurtosis: number }
  /** 'live' (real broker feed) or 'sim' (sandbox simulator) - a verdict on sim data reflects the sim's own structure, not a real OTC feed. */
  dataMode: 'live' | 'sim'
  /** Which link of the honest source chain won: 'sidecar' = live broker pull, 'harvest' = recorded REAL live archive, 'active-feed' = kernel memory. */
  dataSource?: 'sidecar' | 'harvest' | 'active-feed'
  config: OtcConfig
  testedAt: number
  summary: string
}

export interface OtcVerdictRow {
  asset: string
  strategyKey: string
  tf: string
  verdict: OtcVerdictClass
  edgeZ: number
  realWinRate: number
  realTrades: number
  placeboWrMean: number
  placeboSeries: number
  calibrationSource: 'tick' | 'candle'
  ts: number
}

export interface OtcStatus {
  ok: boolean
  asset: string
  strategyKey: string
  isOtc: boolean
  policy: OtcPolicy
  verdict: { verdict: OtcVerdictClass; edgeZ: number; realWinRate: number; realTrades: number; placeboWrMean: number; placeboSeries: number; calibrationSource: 'tick' | 'candle'; ts: number } | null
}

export async function runOtcDefense(input: {
  asset: string
  strategyId: string
  tf?: string
  k?: number
  payout?: number
}): Promise<OtcDefenseReport> {
  return osPost<OtcDefenseReport>('/otc_defense_run', input)
}

export async function getOtcStatus(asset: string, strategyKey: string): Promise<OtcStatus> {
  return osGet<OtcStatus>('/otc_status', { asset, strategy: strategyKey })
}

export async function getOtcVerdicts(limit = 50): Promise<{ ok: boolean; verdicts: OtcVerdictRow[] }> {
  return osGet<{ ok: boolean; verdicts: OtcVerdictRow[] }>('/otc_verdicts', { limit })
}

export async function getOtcConfig(): Promise<{ ok: boolean; config: OtcConfig }> {
  return osGet<{ ok: boolean; config: OtcConfig }>('/otc_config')
}

export async function setOtcConfig(patch: Partial<OtcConfig>): Promise<{ ok: boolean; config: OtcConfig }> {
  return osPost<{ ok: boolean; config: OtcConfig }>('/otc_config', patch)
}

/** /otc_forensics - fair-coin drift probe over the broker's own OTC feed. */
export interface OtcForensics {
  ok: boolean
  asset: string
  tf: string
  n: number
  upRateClose: number
  zClose: number
  /** share of transitions where close == previous close (flat = push in a binary trade) */
  flatRate: number
  /** the HONEST directional test: up vs down among NON-FLAT transitions only */
  decided: { share: number; upRate: number; z: number }
  upRateOpen: number
  zOpen: number
  rolling500: { upRate: number; z: number }
  persistence: { hours: number; negFrac: number; posFrac: number; consistent: boolean }
  lattice: { grid: number; gridCov: number }
  /** vol-memory fingerprint (Task 53): real feeds cluster vol (|r| acf ~0.25, LB p~0);
   *  the OTC generator emits IID steps (acf ~0.00). A validated synthetic-feed tell. */
  authenticity?: {
    absAcf1: number
    ljungBoxP: number
    nAbs: number
    hourSpread: number
    verdict: 'synthetic-like' | 'real-like' | 'inconclusive'
  }
  drift: 'drift_up' | 'drift_down' | 'suggestive' | 'none'
  dataSource?: 'sidecar' | 'harvest' | 'active-feed'
  summary: string
  testedAt: number
}

export async function getOtcForensics(asset: string, tf = '1m', limit = 2000): Promise<OtcForensics> {
  return osGet<OtcForensics>('/otc_forensics', { asset, tf, limit })
}

export interface CompositeSignal {
  asset: string
  tf: Timeframe
  ts: number
  price: number
  score: number
  direction: 'call' | 'put' | 'none'
  confidence: number
  factors: Factor[]
}

export interface MarkovResult {
  states: string[]
  matrix: number[][]
  counts: number[][]
  stationary: number[]
  lastState: number
  nextStateProbs: number[]
  probUp: number
  probDown: number
  probFlat: number
  expectedReturn: number
  trendiness: number
  entropy: number
  regime: 'bull' | 'bear' | 'range' | 'chop'
  sampleSize: number
}

export interface MonteCarloResult {
  paths: number[][]
  horizon: number
  nSims: number
  p5: number
  p25: number
  median: number
  p75: number
  p95: number
  probUp: number
  expectedReturn: number
  var95: number
  cvar95: number
  maxDrawdownExpected: number
}

export interface PatternHit {
  name: string
  direction: 'bullish' | 'bearish' | 'neutral'
  reliability: 1 | 2 | 3
  barsAgo: number
  note: string
}

export interface QuantStats {
  hurst: number
  hurstNote: string
  acf: number[]
  acfSignificance: number
  ewmaVol: number
  garchVol: number
  annualizedVol: number
  zScore: number
  zScorePeriod: number
  linreg: { slope: number; r2: number; upper: number; mid: number; lower: number }
  dailyVol: number
  sharpe: number
  skew: number
  kurtosis: number
}

export interface SRZone {
  price: number
  touches: number
  type: 'support' | 'resistance'
  strength: number
}

// Kalman filter + Ornstein-Uhlenbeck mean reversion (mirrors kernel types)
export interface OUVerdict {
  asset: string
  tf: Timeframe
  verdict: 'robust' | 'weak' | 'failed'
  oosNet: number
  isNet: number
  winRate: number
  efficiencyPct: number
  foldsProfitable: number
  folds: number
  totalTrades: number
  bestParams: Record<string, number | string>
  elapsedMs: number
  ts: number
}

export interface KalmanOUResult {
  theta: number // long-run equilibrium level
  phi: number // per-bar persistence e^-kappa
  kappa: number // mean-reversion speed per bar
  sigmaEps: number // AR(1) innovation std
  sigmaEq: number // stationary std
  halfLifeBars: number // ln(2)/kappa, 9999 = effectively no reversion
  r2: number
  tStat: number // significance of reversion
  sample: number
  z: number // (price - theta) / sigma_eq
  meanReverting: boolean
  state: 'stretched-below' | 'stretched-above' | 'neutral'
  signal: 'call' | 'put' | 'none'
  score: number
  note: string
  window: number
  zMult: number
  innovationZ: number
  zSeries: (number | null)[]
}

export interface IndicatorSnapshot {
  rsi: number
  stochK: number
  stochD: number
  macd: number
  macdSignal: number
  macdHist: number
  bbUpper: number
  bbMid: number
  bbLower: number
  bbPercentB: number
  bbWidth: number
  ema20: number
  ema50: number
  ema200: number
  sma20: number
  atr: number
  atrPct: number
  adx: number
  plusDI: number
  minusDI: number
  cci: number
  williamsR: number
  mfi: number
  obv: number
  vwap: number
  roc: number
  supertrend: number
  supertrendDir: number
  tenkan: number
  kijun: number
  donchianUpper: number
  donchianLower: number
  keltnerUpper: number
  keltnerLower: number
}

export interface AnalysisResult {
  asset: string
  tf: Timeframe
  ts: number
  price: number
  changePct: number
  indicators: IndicatorSnapshot
  indicatorSeries: {
    ema20: { time: number; value: number }[]
    ema50: { time: number; value: number }[]
    ema200: { time: number; value: number }[]
    bbUpper: { time: number; value: number }[]
    bbLower: { time: number; value: number }[]
    supertrend: { time: number; value: number; dir: number }[]
    vwap: { time: number; value: number }[]
  }
  registrySize?: number
  patterns: PatternHit[]
  markov: MarkovResult
  montecarlo: MonteCarloResult
  quant: QuantStats
  kalman: KalmanOUResult
  srZones: SRZone[]
  signal: CompositeSignal
}

export interface Position {
  id: string
  tsOpen: number
  tsClose?: number
  asset: string
  tf: Timeframe
  side: 'call' | 'put'
  kind: TradeKind | 'spot'
  mode: 'paper' | 'live'
  amount: number
  expiryBars: number
  entryPrice: number
  exitPrice?: number
  payout: number
  pnl?: number
  status: 'open' | 'won' | 'lost' | 'closed' | 'push'
  strategy?: string
  note?: string
  settlesAt?: number
  strike?: number
  expirySec?: number
  tp?: number
  sl?: number
  leverage?: number
}

export interface AccountState {
  balance: number
  startBalance: number
  mode: string
  balanceMode: string
  dayKey: string
  dayStartBalance: number
  dayPnl: number
  totalPnl: number
  killSwitch: boolean
  openPositions: number
  liveBalance?: number | null
  source?: 'paper' | 'iq'
}

export interface RiskConfig {
  maxStake: number
  dailyLossLimit: number
  maxOpenPositions: number
  lossStreakCooldown: number
  cooldownSeconds: number
}

// ---------- sentinel (risk governance) ----------

export interface SentinelConfig {
  maxExposurePct: number
  perAssetCapPct: number
  maxTradesPerHour: number
  drawdownHaltPct: number
  autoKillOnDailyLoss: boolean
  autoKillOnDrawdown: boolean
}

export interface SentinelBreaker {
  id: 'daily' | 'drawdown'
  label: string
  tripped: boolean
  reason: string
  ts: number | null
}

export interface RiskEvent {
  ts: number
  kind: string
  message: string
}

export interface SentinelStatus {
  armed: boolean
  killSwitch: boolean
  balance: number
  hwm: number
  dayLoss: number
  baseDailyLimit: number
  drawdownPct: number
  exposure: { total: number; byAsset: Record<string, number> }
  exposureCap: number
  perAssetCap: number
  tradesLastHour: number
  openPositions: number
  maxOpenPositions: number
  maxStake: number
  config: SentinelConfig
  breakers: SentinelBreaker[]
  events: RiskEvent[]
}

// ---------- watchdog (strategy health) ----------

export interface WatchdogConfig {
  windowTrades: number
  minTrades: number
  winRateFloorPct: number
  winRateDriftPct: number
  profitFactorFloor: number
  maxConsecLosses: number
  graceTrades: number
  holdMinutes: number
  botDrawdownUsd: number
  autoDisarm: boolean
  expectedWinRatePct: number
}

export interface WatchdogMetrics {
  windowSize: number
  trades: number
  wins: number
  winRatePct: number
  pf: number
  netPnl: number
  consecLosses: number
  baselinePct: number
  totalTrades: number
  totalWins: number
  cumPnl: number
  peakPnl: number
  ddFromPeak: number
}

export interface WatchdogBotHealth {
  botId: string
  name: string
  strategyId: string
  tf: string
  enabled: boolean
  level: 0 | 1 | 2 | 3
  levelLabel: 'HEALTHY' | 'WATCH' | 'HOLD' | 'DISARMED'
  reason: string
  sinceTs: number
  holdUntil: number
  degradedStreak: number
  acks: number
  baselineOverridePct: number
  metrics: WatchdogMetrics
}

export interface WatchdogEvent {
  ts: number
  botId: string
  kind: string
  message: string
}

export interface WatchdogSummary {
  total: number
  healthy: number
  watch: number
  hold: number
  disarmed: number
}

export interface WatchdogStatus {
  config: WatchdogConfig
  bots: WatchdogBotHealth[]
  summary: WatchdogSummary
  events: WatchdogEvent[]
}

export interface StrategyInfo {
  id: string
  name: string
  description: string
  params: { key: string; label: string; type: 'number' | 'select' | 'text'; min?: number; max?: number; step?: number; options?: { value: string; label: string }[]; default: number | string }[]
  defaults: Record<string, number | string>
}

// ---------- autopilot ----------

export interface BotConfig {
  id: string
  name: string
  enabled: boolean
  watchlist: string[]
  strategyId: string
  tf: Timeframe
  params?: Record<string, number | string>
  kind: TradeKind
  stake: number
  expiryBars: number
  /** Explicit time expiry in seconds for digital bots (900 = 15 minutes). */
  expirySec?: number
  /** Session filter: only trade inside the UTC window. 'overlap' = London x NY. */
  session?: 'all' | 'london' | 'newyork' | 'overlap' | 'asia' | 'sydney'
  minScore: number
  direction: 'both' | 'call' | 'put'
  regime: 'all' | 'trend' | 'range' | 'avoid-volatile'
  maxOpen: number
  cooldownSec: number
  dailyProfitTarget?: number
  dailyLossLimit?: number
  /** Adaptive confidence gate: only fires setups whose own realized record
   * (this asset/tf/strategy/side/score-bucket[/regime]) clears the fleet
   * win-rate floor with statistical confidence. undefined/true = on. */
  adaptive?: boolean
  /** 'compound': a pot seeded at base (e.g. $1) rolls rollPct% of itself into
   * every trade; wins fold the payout in (capped at payoutCap%, default+max
   * 70). stopOnLoss (default true): one loss ENDS the cycle - the bot stands
   * down until an explicit restart. periods (e.g. 7): the Nth win COMPLETES
   * the cycle (halt, or auto re-seed with onComplete 'reseed').
   * deriskAfter/deriskPct: after that many wins, stake only that % of the pot
   * (e.g. 50 = half) so a late loss cannot give back the whole ladder. */
  stakePlan?: {
    kind: 'fixed' | 'compound'
    base: number
    rollPct?: number
    maxStake?: number
    payoutCap?: number
    stopOnLoss?: boolean
    periods?: number
    deriskAfter?: number
    deriskPct?: number
    onComplete?: 'halt' | 'reseed'
  }
  planState?: { pot: number; rollN: number; restarts: number; halted?: boolean; complete?: boolean }
  /** true when this bot was armed with force:true past a FAILING research
   * gate (no/stale/non-robust walk-forward verdict) - a deliberate user
   * override, not a validated edge. Surface this prominently; never let a
   * forced bot render indistinguishably from one that passed the gate. */
  forcedUnvalidated?: boolean
  /** PAYOUT FLOOR (the EV gate): skip signals on pairs whose live payout
   * for this bot's kind is below this percent. 0/undefined = off. */
  minPayoutPct?: number
  /** Self-bench after 3+ consecutive losses (15min, doubling per extra
   * loss, 4h cap; a win clears it). Default off for bots. */
  streakBreaker?: boolean
}

export interface BotStats {
  trades: number
  wins: number
  losses: number
  pnlToday: number
  pnlTotal: number
  openCount: number
  lastTradeTs: number
  streak: number
  pot: number
  rollN: number
  restarts: number
  halted: boolean
  /** halted because the periods target was reached (win-side completion) */
  complete: boolean
  /** Why the bot's last evaluation DIDN'T trade (score below floor, payout
   * floor, bench, session window...). undefined = nothing rejected since the
   * runtime was built - NOT proof the bot is healthy. */
  lastRejection?: string
}

export interface BotRow {
  bot: BotConfig
  stats: BotStats
  createdTs: number
}

// ---------- Strategy Lab (AI-learned strategies) ----------

export type LabSignalDef =
  | { kind: 'candle'; name: string; dir: 'call' | 'put'; weight: number }
  | { kind: 'bar'; variant: 'wide-bull' | 'wide-bear'; atrK?: number; dir: 'call' | 'put'; weight: number }
  | {
      kind: 'ha'
      variant: 'flip-up' | 'flip-down' | 'streak-up' | 'streak-down' | 'strong-bull' | 'strong-bear'
      len?: number
      dir: 'call' | 'put'
      weight: number
    }
  | { kind: 'line'; variant: 'breakout-up' | 'breakout-down' | 'hh-hl' | 'lh-ll'; lookback?: number; dir: 'call' | 'put'; weight: number }
  | {
      kind: 'indicator'
      ind: string
      params?: Record<string, number>
      /** sub-selector for the generic indicator families (madist/osc0100/
       * oscpm100/oscz/trenddist/bandpos/volflow/levels) - mirrors
       * trading-core's IndicatorSignal.type, previously missing here. */
      type?: string
      /** 'between'/'outside' - a band test against [threshold, threshold2],
       * e.g. "rangezone > 0.05 AND rangezone < 0.07" expressed as ONE rule
       * (op:'between', threshold:0.05, threshold2:0.07) instead of two
       * separately-voting signals - mirrors trading-core's IndicatorSignal. */
      op: '>' | '<' | 'between' | 'outside'
      threshold: number
      threshold2?: number
      dir: 'call' | 'put'
      weight: number
    }
  | { kind: 'mtf'; factor: 5 | 15; dir: 'call' | 'put'; weight: number }
  | {
      /** Renko brick structure (mirrors trading-core's RenkoSignal - see
       * analytics/renko.ts). flip-* = trend reversed to this side within the
       * last `len` bricks (young reversal); streak-* = same-color run has
       * reached `len` bricks. Sized ATR-trailing per bar like the renko-flip
       * builtin, or a fixed brickSize when given. */
      kind: 'renko'
      variant: 'flip-up' | 'flip-down' | 'streak-up' | 'streak-down'
      len?: number
      atrPeriod?: number
      atrMult?: number
      brickSize?: number
      dir: 'call' | 'put'
      weight: number
    }
  | {
      /** Point & Figure breakout pattern (mirrors trading-core's PFSignal -
       * see analytics/pointfigure.ts). Fires ONLY on the bar that painted
       * the breakout box - stale patterns never vote. */
      kind: 'pf'
      variant: 'double-top-breakout' | 'double-bottom-breakdown' | 'triple-top-breakout' | 'triple-bottom-breakdown'
      atrPeriod?: number
      atrMult?: number
      boxSize?: number
      reversalBoxes?: number
      dir: 'call' | 'put'
      weight: number
    }
  | {
      /** One of the Signal Panel's chart-engine votes (mirrors trading-core's
       * EngineVoteSignal - see analytics/chartsignals.ts MINABLE_ENGINES).
       * The def fires on bars where that engine's scanner read points the
       * def's way; the lab mines these over deep history and survivors can
       * be deployed like any other learned signal. The OTC velocity
       * footprint is not minable (its tick buffer can't be rebuilt from
       * OHLC history). No params by design: the vote is the scanner's exact
       * math on its own 240-candle feed. */
      kind: 'engine'
      engine: 'renko' | 'pnf' | 'range' | 'tick' | 'footprint' | 'heikin' | 'candle'
      dir: 'call' | 'put'
      weight: number
    }
  | {
      /** AND/OR combination of DIFFERENT signal types into one voting unit
       * - e.g. "Range Sell Zone" AND "Wide Bear Bar" AND "RSI(14) > 70" only
       * counts when ALL (op:'and') or ANY (op:'or') member signals fire on
       * the same bar. Mirrors trading-core's GroupSignal. Member dir fields
       * are each member's own natural direction; the group's own dir/weight
       * is what actually votes. */
      kind: 'group'
      op: 'and' | 'or'
      signals: LabSignalDef[]
      dir: 'call' | 'put'
      weight: number
    }
  | {
      /** A full builtin strategy (trading-core's STRATEGIES registry - e.g.
       * "rsi-reversion", "trend-structure-pullback", the Markov/Kalman/MC
       * ones) used as ONE voting signal instead of traded standalone - lets
       * it be combined with the rest of the signal vocabulary, including
       * inside a GroupSignal. `params` are that strategy's own tunable
       * params (StrategyInfo.params/defaults); omitted keys use the
       * strategy's own defaults server-side. `dir` is which of the
       * strategy's own call/put outputs counts as active - its 'none' or
       * the opposite side never counts. */
      kind: 'builtin'
      id: string
      params?: Record<string, number | string>
      dir: 'call' | 'put'
      weight: number
    }

/** Port of trading-core's labelOf() (strategies/custom.ts) - same formatting,
 * kept in sync by hand since the two are separate deployables. Used to
 * display a human-readable name for both a measured LabSignalStat and a
 * template the user is about to add by hand in the manual strategy builder. */
export function labelOfSignal(s: LabSignalDef, strategies?: StrategyInfo[]): string {
  switch (s.kind) {
    case 'candle':
      return s.name
    case 'bar':
      return s.variant === 'wide-bull' ? 'Wide Bull Bar' : 'Wide Bear Bar'
    case 'ha':
      return (
        {
          'flip-up': 'HA Flip Up',
          'flip-down': 'HA Flip Down',
          'streak-up': 'HA Streak Up',
          'streak-down': 'HA Streak Down',
          'strong-bull': 'HA Strong Bull',
          'strong-bear': 'HA Strong Bear',
        }[s.variant] ?? s.variant
      )
    case 'line':
      return (
        {
          'breakout-up': `Breakout Up(${s.lookback ?? 20})`,
          'breakout-down': `Breakout Down(${s.lookback ?? 20})`,
          'hh-hl': 'Higher Highs & Lows',
          'lh-ll': 'Lower Highs & Lows',
        }[s.variant] ?? s.variant
      )
    case 'indicator': {
      // trendpullback/rangezone get real names - see trading-core's labelOf()
      // for why (otherwise they're nearly impossible to spot in a signal
      // list full of cryptic "ind op threshold" rows like everything else).
      if (s.ind === 'trendpullback') return s.dir === 'call' ? 'Trend Pullback (Bull Continuation)' : 'Trend Pullback (Bear Continuation)'
      if (s.ind === 'rangezone') return s.dir === 'call' ? 'Range Buy Zone' : 'Range Sell Zone'
      // order-flow (CLV-based approximation) families - see
      // trading-core's analytics/orderflow.ts and strategies/custom.ts labelOf()
      if (s.ind === 'ofdelta' || s.ind === 'ofcumdelta' || s.ind === 'ofpocdist' || s.ind === 'ofvapos') {
        const ofName = (
          {
            ofdelta: 'Delta (approx)',
            ofcumdelta: 'Cumulative Delta Slope (approx)',
            ofpocdist: 'POC Distance (approx)',
            ofvapos: 'Value Area Position (approx)',
          } as Record<string, string>
        )[s.ind]
        if (s.op === 'between' || s.op === 'outside') {
          const lo = Math.min(s.threshold, s.threshold2 ?? s.threshold)
          const hi = Math.max(s.threshold, s.threshold2 ?? s.threshold)
          return `${ofName} ${s.op} [${lo}, ${hi}]`
        }
        return `${ofName} ${s.op} ${s.threshold}`
      }
      if (s.ind === 'otcvdelta' || s.ind === 'otcvratio' || s.ind === 'otcstagn') {
        const name = ({ otcvdelta: 'OTC Tick Velocity Delta', otcvratio: 'OTC Tick Speed Ratio', otcstagn: 'OTC Cluster Stagnation' } as Record<string, string>)[s.ind]
        if (s.op === 'between' || s.op === 'outside') {
          const lo = Math.min(s.threshold, s.threshold2 ?? s.threshold)
          const hi = Math.max(s.threshold, s.threshold2 ?? s.threshold)
          return `${name} ${s.op} [${lo}, ${hi}]`
        }
        return `${name} ${s.op} ${s.threshold}`
      }
      const p = s.params ?? {}
      const pd = p.period ?? p.fast
      const tag = s.type ? `:${s.type}` : ''
      const name = `${s.ind}${tag}${Number.isFinite(pd) ? `(${pd})` : ''}`
      if (s.op === 'between' || s.op === 'outside') {
        const lo = Math.min(s.threshold, s.threshold2 ?? s.threshold)
        const hi = Math.max(s.threshold, s.threshold2 ?? s.threshold)
        return `${name} ${s.op} [${lo}, ${hi}]`
      }
      return `${name} ${s.op} ${s.threshold}`
    }
    case 'mtf':
      return `MTF ${s.factor}x Trend ${s.dir === 'call' ? 'Up' : 'Down'}`
    case 'renko':
      return (
        {
          'flip-up': 'Renko Flip Up',
          'flip-down': 'Renko Flip Down',
          'streak-up': `Renko Streak Up(${s.len ?? 3})`,
          'streak-down': `Renko Streak Down(${s.len ?? 3})`,
        }[s.variant] ?? s.variant
      )
    case 'pf':
      return (
        {
          'double-top-breakout': 'P&F Double Top Breakout',
          'double-bottom-breakdown': 'P&F Double Bottom Breakdown',
          'triple-top-breakout': 'P&F Triple Top Breakout',
          'triple-bottom-breakdown': 'P&F Triple Bottom Breakdown',
        }[s.variant] ?? s.variant
      )
    case 'engine': {
      // mirrors trading-core's ENGINE_LABEL (analytics/chartsignals.ts)
      const name = ({ renko: 'Renko', pnf: 'P&F', range: 'Range', tick: 'Tick', footprint: 'Footprint', heikin: 'H/A', candle: 'Candles' } as Record<string, string>)[s.engine] ?? s.engine
      return `${name} Vote (${s.dir === 'call' ? 'CALL' : 'PUT'})`
    }
    case 'group':
      return `(${s.signals.map((m) => labelOfSignal(m, strategies)).join(s.op === 'and' ? ' AND ' : ' OR ')})`
    case 'builtin': {
      const name = strategies?.find((st) => st.id === s.id)?.name ?? s.id
      return `${name} (${s.dir === 'call' ? 'CALL' : 'PUT'})`
    }
  }
}

/** Mirrors trading-core's lab.ts CANDIDATE_SIGNALS - the exact same
 * parametric vocabulary the learner mines, offered here as ready-made
 * templates for the manual strategy builder. Candlestick patterns aren't
 * listed (the learner discovers those by scanning live history; building one
 * by hand instead takes a free-typed pattern name - see the builder UI). */
export const SIGNAL_TEMPLATES: LabSignalDef[] = [
  { kind: 'mtf', factor: 5, dir: 'call', weight: 10 },
  { kind: 'mtf', factor: 5, dir: 'put', weight: 10 },
  { kind: 'mtf', factor: 15, dir: 'call', weight: 10 },
  { kind: 'mtf', factor: 15, dir: 'put', weight: 10 },
  { kind: 'bar', variant: 'wide-bull', atrK: 1.1, dir: 'call', weight: 10 },
  { kind: 'bar', variant: 'wide-bear', atrK: 1.1, dir: 'put', weight: 10 },
  { kind: 'ha', variant: 'flip-up', len: 2, dir: 'call', weight: 10 },
  { kind: 'ha', variant: 'flip-down', len: 2, dir: 'put', weight: 10 },
  { kind: 'ha', variant: 'streak-up', len: 3, dir: 'call', weight: 10 },
  { kind: 'ha', variant: 'streak-down', len: 3, dir: 'put', weight: 10 },
  { kind: 'ha', variant: 'strong-bull', dir: 'call', weight: 10 },
  { kind: 'ha', variant: 'strong-bear', dir: 'put', weight: 10 },
  // renko brick structures + P&F breakout patterns - mirror trading-core's
  // lab.ts CANDIDATE_SIGNALS additions (see analytics/renko.ts and
  // analytics/pointfigure.ts for the engines)
  { kind: 'renko', variant: 'flip-up', len: 2, dir: 'call', weight: 10 },
  { kind: 'renko', variant: 'flip-down', len: 2, dir: 'put', weight: 10 },
  { kind: 'renko', variant: 'streak-up', len: 3, dir: 'call', weight: 10 },
  { kind: 'renko', variant: 'streak-down', len: 3, dir: 'put', weight: 10 },
  { kind: 'pf', variant: 'double-top-breakout', dir: 'call', weight: 10 },
  { kind: 'pf', variant: 'double-bottom-breakdown', dir: 'put', weight: 10 },
  { kind: 'pf', variant: 'triple-top-breakout', dir: 'call', weight: 10 },
  { kind: 'pf', variant: 'triple-bottom-breakdown', dir: 'put', weight: 10 },
  // chart-engine votes - the Signal Panel's scanners as one minable signal
  // each (mirrors trading-core's lab.ts CANDIDATE_SIGNALS engine family; no
  // params by design - the vote IS the scanner's exact math). The OTC
  // velocity footprint can't be rebuilt from history and is absent.
  { kind: 'engine', engine: 'renko', dir: 'call', weight: 10 },
  { kind: 'engine', engine: 'renko', dir: 'put', weight: 10 },
  { kind: 'engine', engine: 'pnf', dir: 'call', weight: 10 },
  { kind: 'engine', engine: 'pnf', dir: 'put', weight: 10 },
  { kind: 'engine', engine: 'range', dir: 'call', weight: 10 },
  { kind: 'engine', engine: 'range', dir: 'put', weight: 10 },
  { kind: 'engine', engine: 'tick', dir: 'call', weight: 10 },
  { kind: 'engine', engine: 'tick', dir: 'put', weight: 10 },
  { kind: 'engine', engine: 'footprint', dir: 'call', weight: 10 },
  { kind: 'engine', engine: 'footprint', dir: 'put', weight: 10 },
  { kind: 'engine', engine: 'heikin', dir: 'call', weight: 10 },
  { kind: 'engine', engine: 'heikin', dir: 'put', weight: 10 },
  { kind: 'engine', engine: 'candle', dir: 'call', weight: 10 },
  { kind: 'engine', engine: 'candle', dir: 'put', weight: 10 },
  { kind: 'line', variant: 'breakout-up', lookback: 10, dir: 'call', weight: 10 },
  { kind: 'line', variant: 'breakout-down', lookback: 10, dir: 'put', weight: 10 },
  { kind: 'line', variant: 'breakout-up', lookback: 20, dir: 'call', weight: 10 },
  { kind: 'line', variant: 'breakout-down', lookback: 20, dir: 'put', weight: 10 },
  { kind: 'line', variant: 'hh-hl', lookback: 3, dir: 'call', weight: 10 },
  { kind: 'line', variant: 'lh-ll', lookback: 3, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'rsi', params: { period: 14 }, op: '<', threshold: 30, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'rsi', params: { period: 14 }, op: '<', threshold: 35, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'rsi', params: { period: 14 }, op: '>', threshold: 70, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'rsi', params: { period: 14 }, op: '>', threshold: 65, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'rsi', params: { period: 7 }, op: '<', threshold: 25, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'rsi', params: { period: 7 }, op: '>', threshold: 75, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'bbpos', params: { period: 20, mult: 2 }, op: '<', threshold: 0.05, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'bbpos', params: { period: 20, mult: 2 }, op: '>', threshold: 0.95, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'zscore', params: { period: 20 }, op: '<', threshold: -1.5, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'zscore', params: { period: 20 }, op: '>', threshold: 1.5, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'zscore', params: { period: 50 }, op: '<', threshold: -2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'zscore', params: { period: 50 }, op: '>', threshold: 2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'wickbias', op: '>', threshold: 0.45, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'wickbias', op: '<', threshold: -0.45, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'bodypos', op: '<', threshold: 0.15, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'bodypos', op: '>', threshold: 0.85, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'donchianpos', params: { period: 20 }, op: '>', threshold: 0.95, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'donchianpos', params: { period: 20 }, op: '<', threshold: 0.05, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'macdz', op: '>', threshold: 0.4, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'macdz', op: '<', threshold: -0.4, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'slope', params: { period: 20 }, op: '>', threshold: 0.35, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'slope', params: { period: 20 }, op: '<', threshold: -0.35, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'streak', op: '>', threshold: 2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'streak', op: '<', threshold: -2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'emasign', params: { fast: 9, slow: 21 }, op: '>', threshold: 0.5, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'emasign', params: { fast: 9, slow: 21 }, op: '<', threshold: -0.5, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'hadist', op: '>', threshold: 0.6, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'hadist', op: '<', threshold: -0.6, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'psar', params: { afStep: 0.02, afMax: 0.2 }, op: '>', threshold: 0.1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'psar', params: { afStep: 0.02, afMax: 0.2 }, op: '<', threshold: -0.1, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'psar', params: { afStep: 0.01, afMax: 0.15 }, op: '>', threshold: 0.05, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'psar', params: { afStep: 0.01, afMax: 0.15 }, op: '<', threshold: -0.05, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'fractal', params: { left: 2, right: 2 }, op: '>', threshold: 0.05, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'fractal', params: { left: 2, right: 2 }, op: '<', threshold: -0.05, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'fractal', params: { left: 3, right: 3 }, op: '>', threshold: 0.1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'fractal', params: { left: 3, right: 3 }, op: '<', threshold: -0.1, dir: 'put', weight: 10 },
  // Trending-market pullback (swing HH/HL or LH/LL structure + pullback near
  // the last confirmed swing point) and ranging-market buy/sell zone - mirror
  // trading-core's analytics/structure.ts, added to the Lab's vocabulary so
  // these can be learned per-pair (not just the fixed builtin strategy).
  { kind: 'indicator', ind: 'trendpullback', params: { pivotFlank: 3, pullbackAtr: 0.75, minLegAtr: 2 }, op: '>', threshold: 0.05, dir: 'call', weight: 12 },
  { kind: 'indicator', ind: 'trendpullback', params: { pivotFlank: 3, pullbackAtr: 0.75, minLegAtr: 2 }, op: '<', threshold: -0.05, dir: 'put', weight: 12 },
  { kind: 'indicator', ind: 'trendpullback', params: { pivotFlank: 5, pullbackAtr: 1, minLegAtr: 3 }, op: '>', threshold: 0.05, dir: 'call', weight: 12 },
  { kind: 'indicator', ind: 'trendpullback', params: { pivotFlank: 5, pullbackAtr: 1, minLegAtr: 3 }, op: '<', threshold: -0.05, dir: 'put', weight: 12 },
  { kind: 'indicator', ind: 'rangezone', params: { window: 40, rangeThreshold: 0.35, zoneAtr: 0.4 }, op: '>', threshold: 0.05, dir: 'call', weight: 12 },
  { kind: 'indicator', ind: 'rangezone', params: { window: 40, rangeThreshold: 0.35, zoneAtr: 0.4 }, op: '<', threshold: -0.05, dir: 'put', weight: 12 },
  { kind: 'indicator', ind: 'rangezone', params: { window: 60, rangeThreshold: 0.25, zoneAtr: 0.5 }, op: '>', threshold: 0.05, dir: 'call', weight: 12 },
  { kind: 'indicator', ind: 'rangezone', params: { window: 60, rangeThreshold: 0.25, zoneAtr: 0.5 }, op: '<', threshold: -0.05, dir: 'put', weight: 12 },
  { kind: 'indicator', ind: 'madist', type: 'hma', params: { period: 20 }, op: '>', threshold: 0.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'hma', params: { period: 20 }, op: '<', threshold: -0.2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'kama', params: { period: 10 }, op: '>', threshold: 0.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'kama', params: { period: 10 }, op: '<', threshold: -0.2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'tema', params: { period: 20 }, op: '>', threshold: 0.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'tema', params: { period: 20 }, op: '<', threshold: -0.2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'vwma', params: { period: 20 }, op: '>', threshold: 0.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'madist', type: 'vwma', params: { period: 20 }, op: '<', threshold: -0.2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'stochk', params: { period: 14 }, op: '<', threshold: 20, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'stochk', params: { period: 14 }, op: '>', threshold: 80, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'willr', params: { period: 14 }, op: '<', threshold: 20, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'willr', params: { period: 14 }, op: '>', threshold: 80, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'mfi', params: { period: 14 }, op: '<', threshold: 20, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'mfi', params: { period: 14 }, op: '>', threshold: 80, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'aroonup', params: { period: 14 }, op: '>', threshold: 90, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'osc0100', type: 'aroondown', params: { period: 14 }, op: '>', threshold: 90, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'oscpm100', type: 'cci', params: { period: 20 }, op: '<', threshold: -100, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'oscpm100', type: 'cci', params: { period: 20 }, op: '>', threshold: 100, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'oscpm100', type: 'cmo', params: { period: 14 }, op: '<', threshold: -50, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'oscpm100', type: 'cmo', params: { period: 14 }, op: '>', threshold: 50, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'oscpm100', type: 'tsi', op: '<', threshold: -25, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'oscpm100', type: 'tsi', op: '>', threshold: 25, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'oscz', type: 'roc', params: { period: 12 }, op: '>', threshold: 0.5, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'oscz', type: 'roc', params: { period: 12 }, op: '<', threshold: -0.5, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'oscz', type: 'fisher', params: { period: 9 }, op: '<', threshold: -1.5, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'oscz', type: 'fisher', params: { period: 9 }, op: '>', threshold: 1.5, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'oscz', type: 'awesomeosc', op: '>', threshold: 0.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'oscz', type: 'awesomeosc', op: '<', threshold: -0.2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'trenddist', type: 'supertrend', params: { period: 10, mult: 3 }, op: '>', threshold: 0.1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'trenddist', type: 'supertrend', params: { period: 10, mult: 3 }, op: '<', threshold: -0.1, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'trenddist', type: 'ichimoku', op: '>', threshold: 0.1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'trenddist', type: 'ichimoku', op: '<', threshold: -0.1, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'bandpos', type: 'keltner', params: { period: 20 }, op: '<', threshold: 0.05, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'bandpos', type: 'keltner', params: { period: 20 }, op: '>', threshold: 0.95, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'volflow', type: 'cmf', params: { period: 20 }, op: '>', threshold: 0.1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'volflow', type: 'cmf', params: { period: 20 }, op: '<', threshold: -0.1, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'volflow', type: 'vwapdist', op: '>', threshold: 0.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'volflow', type: 'vwapdist', op: '<', threshold: -0.2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'levels', type: 'pivot', op: '>', threshold: 0.3, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'levels', type: 'pivot', op: '<', threshold: -0.3, dir: 'put', weight: 10 },
  // order flow (CLV-based approximation - see analytics/orderflow.ts; no
  // real tick/order-book data exists on this platform)
  { kind: 'indicator', ind: 'ofdelta', params: { period: 20 }, op: '>', threshold: 1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'ofdelta', params: { period: 20 }, op: '<', threshold: -1, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'ofcumdelta', params: { lookback: 10, period: 20 }, op: '>', threshold: 1, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'ofcumdelta', params: { lookback: 10, period: 20 }, op: '<', threshold: -1, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'ofpocdist', params: { period: 40 }, op: '<', threshold: -1.2, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'ofpocdist', params: { period: 40 }, op: '>', threshold: 1.2, dir: 'put', weight: 10 },
  { kind: 'indicator', ind: 'ofvapos', params: { period: 40 }, op: '>', threshold: 1.05, dir: 'call', weight: 10 },
  { kind: 'indicator', ind: 'ofvapos', params: { period: 40 }, op: '<', threshold: -0.05, dir: 'put', weight: 10 },
  // OTC micro-tick velocity footprint family (kernel analytics/otcfootprint.ts)
  { kind: 'indicator', ind: 'otcvdelta', params: { period: 20 }, op: '>', threshold: 1, dir: 'call', weight: 11 },
  { kind: 'indicator', ind: 'otcvdelta', params: { period: 20 }, op: '<', threshold: -1, dir: 'put', weight: 11 },
  { kind: 'indicator', ind: 'otcvratio', params: { period: 20 }, op: '>', threshold: 1, dir: 'call', weight: 11 },
  { kind: 'indicator', ind: 'otcvratio', params: { period: 20 }, op: '<', threshold: -1, dir: 'put', weight: 11 },
  { kind: 'indicator', ind: 'otcstagn', params: { period: 20 }, op: '>', threshold: 1, dir: 'call', weight: 11 },
  { kind: 'indicator', ind: 'otcstagn', params: { period: 20 }, op: '<', threshold: -1, dir: 'put', weight: 11 },
]

export interface LabSpec {
  name: string
  description?: string
  signals: LabSignalDef[]
  minScore: number
  minVotes: number
  horizon: number
  /** candle basis the signals read: raw (default), Heiken-Ashi, or Kalman-smoothed */
  basis?: 'candles' | 'heikin' | 'kalman' | 'typical' | 'smoothed'
}

export interface LabSignalStat {
  key: string
  kind: LabSignalDef['kind']
  label: string
  dir: 'call' | 'put'
  n: number
  wins: number
  winRate: number
  edgePts: number
  edgeLB: number
  weight: number
  selected: boolean
  /** full definition this stat was measured from - lets the UI compose a
   * spec out of any manually-checked subset, not just the auto-selected one */
  def: LabSignalDef
}

export interface LabSimMetrics {
  trades: number
  wins: number
  losses: number
  winRate: number
  netPnl: number
  profitFactor: number
  maxDrawdown: number
  expectancy: number
  winRateCiLow: number
  winRateCiHigh: number
  lowSample: boolean
}

export type LabRegime = 'TRENDING' | 'RANGING' | 'VOLATILE' | 'MIXED'

export interface LabLearnResult {
  ok: boolean
  asset: string
  tf: Timeframe
  basis: 'candles' | 'heikin' | 'kalman' | 'typical' | 'smoothed'
  candlesTested: number
  horizon: number
  minSamples: number
  minEdge: number
  breakevenWinRate: number
  signals: LabSignalStat[]
  spec: LabSpec | null
  calibration: { thresholds: { minScore: number; trades: number; winRate: number }[]; chosen: number; votes: number }
  backtest: LabSimMetrics | null
  holdout: LabSimMetrics | null
  holdoutFolds: LabSimMetrics[]
  foldsProfitable: number
  confluenceWeak: boolean
  regime: LabRegime
  note: string
  error?: string
}

export interface LabStrategyRow {
  id: string
  spec: LabSpec
  asset: string
  tf: string
  stats: { backtest?: LabSimMetrics; holdout?: LabSimMetrics; breakeven?: number; decayed?: boolean; decayedTs?: number } | null
  createdTs: number
  updatedTs: number
}

// ---------- calibration & research gate ----------

export interface CalibrationBucket {
  rangeLabel: string
  predictedMid: number
  n: number
  wins: number
  realizedWinRate: number
}

export interface CalibrationReport {
  n: number
  excluded: number
  byConfidence: CalibrationBucket[]
  byMarkovProb: CalibrationBucket[]
  brierConfidence: number | null
  brierMarkov: number | null
  note: string
}

/** One (asset, tf, strategy) walk-forward verdict, as saved by POST
 * /walkforward and read back by GET /validation - the research gate
 * bot_create/bot_toggle check before arming a bot. */
export interface ValidationVerdict {
  verdict: 'robust' | 'weak' | 'failed'
  oosNet: number
  isNet: number
  winRate: number
  efficiencyPct: number
  folds: number
  foldsProfitable: number
  totalTrades: number
  ts: number // unix SECONDS
}

export interface ValidationRow extends ValidationVerdict {
  asset: string
  tf: string
  strategyId: string
}

export interface JournalGroupRow {
  key: string
  trades: number
  wins: number
  pnl: number
  winRate: number
}

export interface JournalSummary {
  scope: string
  overall: {
    trades: number
    wins: number
    losses: number
    winRate: number
    netPnl: number
    profitFactor: number
    bestTrade: number
    worstTrade: number
    avgWin: number
    avgLoss: number
  }
  curve: { ts: number; equity: number }[]
  byStrategy: JournalGroupRow[]
  byOrigin: JournalGroupRow[]
  byAsset: JournalGroupRow[]
  byKind: JournalGroupRow[]
  bySide: JournalGroupRow[]
  recent: Position[]
}

export interface BacktestResult {
  strategy: string
  asset: string
  tf: Timeframe
  mode: 'binary' | 'spot'
  candlesTested: number
  trades: { ts: number; side: string; entry: number; exit: number; amount: number; pnl: number; status: string }[]
  equityCurve: { time: number; value: number }[]
  metrics: {
    totalTrades: number
    wins: number
    losses: number
    winRate: number
    netPnl: number
    profitFactor: number
    maxDrawdown: number
    maxDrawdownPct: number
    sharpe: number
    expectancy: number
    finalEquity: number
    startEquity: number
    winRateCiLow: number
    winRateCiHigh: number
    lowSample: boolean
    /** Same metrics, split by which side the trade actually was - a
     * strategy's blended win rate can hide one that's genuinely good on
     * CALLs and a coin-flip (or worse) on PUTs, which matters once it gets
     * combined into an AI Lab group with a chosen dir. */
    byDirection: {
      call: { trades: number; wins: number; losses: number; winRate: number; netPnl: number; expectancy: number }
      put: { trades: number; wins: number; losses: number; winRate: number; netPnl: number; expectancy: number }
    }
  }
  // Present only when a compounding stakePlan was sent: how many times a
  // stopOnLoss cycle ended and the backtest auto-reseeded at base to keep
  // walking the rest of history (a live bot would instead stand down for
  // bot_restart).
  compoundCycles?: number
}

// Mirrors mini-services/trading-core's autopilot.ts StakePlan - the SAME
// shape bot_create/compound_plan use, so a config tuned in Backtest Lab can
// be pasted straight into a bot without translation.
export interface StakePlan {
  kind: 'compound'
  base: number
  rollPct?: number
  maxStake?: number
  payoutCap?: number
  stopOnLoss?: boolean
  periods?: number
  deriskAfter?: number
  deriskPct?: number
  onComplete?: 'halt' | 'reseed'
}

// ---------- research: optimizer / walk-forward / asset sweep ----------

export type ResearchObjective = 'netPnl' | 'sharpe' | 'profitFactor' | 'winRate' | 'expectancy'
export type SweepSpec = Record<string, { from: number; to: number; step: number }>

export interface FastMetrics {
  totalTrades: number
  wins: number
  winRate: number
  netPnl: number
  profitFactor: number
  maxDrawdownPct: number
  sharpe: number
  expectancy: number
  finalEquity: number
  winRateCiLow: number
  winRateCiHigh: number
  lowSample: boolean
  /** Same metrics split by call/put - a combo/fold/asset's blended win rate
   * can hide a strategy that's only actually good on one side. */
  byDirection: {
    call: { trades: number; wins: number; losses: number; winRate: number; netPnl: number; expectancy: number }
    put: { trades: number; wins: number; losses: number; winRate: number; netPnl: number; expectancy: number }
  }
}

export interface OptRow {
  params: Record<string, number | string>
  metrics: FastMetrics
  score: number
  rank: number
  verified: boolean
}

export interface HeatmapData {
  xKey: string
  yKey: string
  xs: number[]
  ys: number[]
  cells: { x: number; y: number; value: number | null; trades: number; winRate: number }[]
}

export interface GridSearchResult {
  strategy: string
  asset: string
  tf: Timeframe
  objective: ResearchObjective
  totalCombos: number
  evaluated: number
  skipped: number
  elapsedMs: number
  ranked: OptRow[]
  heatmap: HeatmapData | null
  best: OptRow | null
}

export interface WalkForwardFold {
  fold: number
  isBars: number
  oosBars: number
  bestParams: Record<string, number | string>
  is: FastMetrics
  oos: FastMetrics
}

export interface WalkForwardResult {
  strategy: string
  asset: string
  tf: Timeframe
  objective: ResearchObjective
  folds: WalkForwardFold[]
  oos: FastMetrics
  isNet: number
  oosNet: number
  efficiencyPct: number
  foldsProfitable: number
  bestParams: Record<string, number | string>
  elapsedMs: number
}

export interface SweepRow {
  asset: string
  category: string
  open: boolean
  payout: number
  metrics: FastMetrics
  score: number
  // % of tested candles backed by REAL archived bars vs the market
  // simulator's deterministic synthetic fill (null if the backend didn't
  // compute it). A thin/not-yet-live instrument scoring too well is often
  // the strategy re-detecting the simulator's own generative process, not a
  // real edge - see store.archiveBounds on the kernel side.
  liveDataPct: number | null
}

export interface SweepResult {
  strategy: string
  tf: Timeframe
  params: Record<string, number | string>
  objective: ResearchObjective
  tested: number
  skipped: number
  elapsedMs: number
  rows: SweepRow[]
  sharedWindow: { start: number; end: number } | null
}

export interface AlertRow {
  level: 'info' | 'warn' | 'danger' | 'success'
  message: string
  ts: number
}

// ---------- discovery: screener + alert rules ----------

export type AlertMetric =
  | 'price_above'
  | 'price_below'
  | 'score_call'
  | 'score_put'
  | 'score_abs'
  | 'rsi_above'
  | 'rsi_below'
  | 'adx_above'
  | 'atr_above'
  | 'regime'
  | 'pattern_bull'
  | 'pattern_bear'

export interface AlertMetricDef {
  metric: AlertMetric
  label: string
  needsValue: boolean
  hint: string
}

export interface AlertRule {
  id: string
  name: string
  enabled: boolean
  asset: string
  tf: Timeframe
  metric: AlertMetric
  value?: number
  note?: string
  cooldownSec: number
  oneShot: boolean
  lastFiredTs?: number
  fires: number
}

export interface ScreenRow {
  asset: string
  name: string
  category: AssetCategory
  otc: boolean
  tf: Timeframe
  price: number
  score: number
  direction: 'call' | 'put' | 'none'
  confidence: number
  pUp: number
  regime: 'bull' | 'bear' | 'range' | 'chop'
  ouZ: number
  ouHalfLife: number
  ouMeanReverting: boolean
  ouTStat: number
  rsi: number
  adx: number
  atrPct: number
  hurst: number
  changePct: number
  payout: number
  topPattern: { name: string; direction: string; reliability: number } | null
  ts: number
  computedTs: number
}

/** One pair's full Confluence Signal read, market-wide - the exact
 * CompositeSignal the single-asset panel (SignalPanel.tsx) shows for one pair
 * (same `factors` breakdown: EMA Stack, ADX/DI, Supertrend, RSI, Markov P(up),
 * Hurst, Kalman/OU Stretch, Pattern Bias, etc.), plus list metadata. This is
 * NOT a ScreenRow - it carries no screener-derived scalars (rsi/adx/regime/
 * hurst/ouZ/pUp/topPattern), only the real factor votes. */
export interface ConfluenceRow {
  asset: string
  name: string
  category: AssetCategory
  otc: boolean
  tf: Timeframe
  price: number
  score: number
  direction: 'call' | 'put' | 'none'
  confidence: number
  factors: Factor[]
  payout: number
  ts: number
  computedTs: number
}

export interface ScreenerStatus {
  pairs: number
  tfs: Timeframe[]
  category: string
  queue: number
  stale: number
  instruments: number
  lastSweepTs: number
  sweeping: boolean
  uptimeSec: number
}

// ---------- OS mode (human-in-the-loop governor) ----------

export type OsMode = 'human' | 'auto'

export interface AutoTraderConfig {
  enabled: boolean
  signalSource: 'screener' | 'kalman-ou' | 'markov' | 'momentum' | 'confluence' | 'strategy'
  tf: Timeframe
  /** The trade's own expiry, as a timeframe - SEPARATE from `tf` (which
   * candles signals are read from). Unset = old behavior (expiry tracks tf
   * 1:1, i.e. exactly one bar). Set to decouple them, e.g. read signals on
   * '1m' but let each trade run '5m' before it settles. */
  expiryTf?: Timeframe
  stake: number
  minScore: number
  minConfidence: number
  zEntry: number
  maxHalfLife: number
  requireValidation: boolean
  minPUp: number
  minAdx: number
  /** strategy source: id from the combined Strategy Lab catalog (builtin id,
   * or "custom:<id>" for an AI Lab-learned spec) - same as a bot's strategyId.
   * @deprecated superseded by strategyIds; kept for older saved configs. */
  strategyId?: string
  /** strategy source: one or more ids to trade. One id = that single
   * strategy (score-gated only). Two+ = an ENSEMBLE - every member votes,
   * the majority direction wins, and minConfidence is reused as the
   * minimum agreement % the majority must reach. */
  strategyIds?: string[]
  /** How a 2+-member strategyIds pool combines into one signal per pair.
   * 'ensemble' (default) - every member votes, majority wins. 'best' - the
   * OS's own auto-learn: for each candidate pair, trades whichever pool
   * member has the strongest PROVEN (Wilson-lower-bound, from its own
   * settled trades on that exact pair) win rate, falling back to raw score
   * for members still building a record. */
  strategyPickMode?: 'ensemble' | 'best'
  /** Only matters with strategyPickMode 'best'. true = ranks the FULL
   * builtin + AI Lab catalog per pair (not just manually-picked
   * strategyIds) and periodically mines new AI Lab specs for pairs without
   * a fresh one yet. Default false. */
  autoDiscover?: boolean
  /** Per-strategy param overrides, keyed by strategy id - same shape as a
   * bot's own params. Ignored for an AI Lab "custom:<id>" spec. */
  strategyParams?: Record<string, Record<string, number | string>>
  /** Per-pair strategy pin, keyed by exact ticker - "for THIS pair always
   * use THIS strategy", bypassing the global strategyIds/ensemble/best pool
   * entirely for that pair. A pair with no entry here keeps using the
   * global pool unchanged. If the pinned id no longer resolves, that pair
   * sits out rather than falling back to the pool. */
  pairStrategy?: Record<string, string>
  /** Direction pin: "for every CALL use THIS strategy, for every PUT use
   * THIS one" - the direction analog of pairStrategy above. Either key may
   * be set alone (the other side keeps using the global pool) or both. A
   * pair's own pairStrategy pin, if it has one, still wins over this. */
  directionStrategy?: { call?: string; put?: string }
  direction: 'both' | 'call' | 'put'
  /** Instead of always locking onto the single highest-ranked qualifying
   * pair every tick, collect the top N qualifying candidates this tick and
   * pick ONE at random - spreads trades across what's genuinely in the
   * "best range" instead of one pair (whose score moves slowly between 10s
   * ticks) monopolizing every slot for minutes on end. 1 (default/unset) =
   * original strict-best behavior. Only affects the 'screener' and
   * 'strategy' sources, which already rank/score the whole pool. */
  pickVariety?: number
  maxOpen: number
  cooldownSec: number
  paceSec: number
  dailyProfitTarget: number
  dailyLossLimit: number
  /** Empty = global (every open instrument, any signalSource). Non-empty =
   * gated by watchlistMode. */
  watchlist: string[]
  /** 'only' (default when unset) = trade ONLY the watchlist tickers. 'exclude'
   * = trade every open instrument EXCEPT the watchlist tickers - a deny-list. */
  watchlistMode?: 'only' | 'exclude'
  /** Market-scope separation: 'all' (default) = real and -OTC feeds alike,
   * 'real' = REAL exchange-traded feeds only, 'otc' = broker-generated -OTC
   * feeds only. Keeps a config built for one feed family from ever firing on
   * the other. */
  marketScope?: 'all' | 'real' | 'otc'
  /** Scales the stake with signal confidence (0.5x-1.5x) instead of a flat
   * `stake` every trade. Default false. */
  smartStaking?: boolean
  /** Blocks opening a new position in a pair correlated with one already
   * open (same FX-major/metals/crypto group), not just raw maxOpen count.
   * Default true. */
  correlationGuard?: boolean
  /** Benches a (strategy, pair) combo after 3+ consecutive losses, cooldown
   * growing with streak length. Default true. */
  streakBreaker?: boolean
  /** Stands aside on non-OTC pairs during the 21:00-23:00 UTC thin-liquidity
   * window. Default false. */
  avoidDeadHours?: boolean
  /** PAYOUT FLOOR (the EV gate): never place a trade when the pair's live
   * binary payout is below this percent (0 = off, kernel default 70).
   * Breakeven at payout p is 1/(1+p) - the one lever that provably moves EV. */
  minPayoutPct?: number
  /** Vol-spike gate: 'avoid-volatile' stands a pair down while the 4-way
   * regime classifier reads VOLATILE for it (garchVol > 1.6x ewmaVol).
   * Default 'off'. */
  volGate?: 'off' | 'avoid-volatile'
  /** Optional compounding plan - same StakePlan shape as a bot's. undefined =
   * fixed `stake` every trade. */
  stakePlan?: StakePlan
  /** Server-persisted roll state (read-only from the client - the server
   * is the only writer; informational for the dialog/strip). */
  planState?: { pot: number; rollN: number; restarts: number; halted: boolean; complete: boolean }
}

export interface OsModeStatus {
  mode: OsMode
  ts: number
  reason: string
  autotrader: {
    config: AutoTraderConfig
    trades: number
    wins: number
    losses: number
    pnlToday: number
    pnlTotal: number
    openCount: number
    lastTradeTs: number
    lastAction?: string
    lastRejection?: string
    active: boolean
  }
}

// ---------- REST client (direct to core via gateway port param) ----------

const CORE_PORT = Number((typeof process !== 'undefined' && process.env && (process.env as Record<string, string | undefined>).NEXT_PUBLIC_KERNEL_PORT) || 3030)

function qs(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams()
  usp.set('XTransformPort', String(CORE_PORT))
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) usp.set(k, String(v))
  }
  return usp.toString()
}

// AUDIT FIX (Task 58, P2): the wrappers used to discard the kernel's error
// BODY ("GET x failed: 400") - kernel 400s carry rich diagnostics (thin
// history, lab validation errors, OTC trial breakdowns) that the panels were
// never shown. Non-2xx now rethrows with the kernel's own message when the
// body carries one.
async function errorFrom(res: Response, label: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: string }
    if (body?.error) return new Error(body.error)
  } catch {
    // body not JSON - fall through to the generic message
  }
  return new Error(`${label} failed: ${res.status}`)
}

export async function osGet<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const clean = path.replace(/^\/+/, '')
  const res = await fetch(`/${clean}?${qs(params)}`, { cache: 'no-store' })
  if (!res.ok) throw await errorFrom(res, `GET ${clean}`)
  return res.json() as Promise<T>
}

export async function osPost<T>(path: string, body: unknown = {}): Promise<T> {
  const clean = path.replace(/^\/+/, '')
  const res = await fetch(`/${clean}?${qs({})}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!res.ok) throw await errorFrom(res, `POST ${clean}`)
  return res.json() as Promise<T>
}

// ---------- socket feed ----------

export interface OSFeedHandlers {
  onTick?: (p: { asset: string; price: number; ts: number }) => void
  onCandle?: (p: { asset: string; tf: Timeframe; candle: Candle; closed: boolean }) => void
  onAccount?: (p: { account: AccountState }) => void
  onPositionOpened?: (p: { position: Position }) => void
  onPositionClosed?: (p: { position: Position }) => void
  onAlert?: (p: AlertRow) => void
  onUi?: (p: { event: string; asset?: string }) => void
  onConnectChange?: (connected: boolean) => void
}

export function useOSFeed(asset: string, tf: Timeframe, handlers: OSFeedHandlers): void {
  const socketRef = useRef<Socket | null>(null)
  const handlersRef = useRef(handlers)

  // Task 59 (P2): the socket effect below has [] deps, so its `connect`
  // handler closes over the FIRST render's asset/tf - on every reconnect it
  // re-subscribed the mount-time pair, silently freezing the feed for the
  // pair the user is actually viewing (page-level guards kept data clean,
  // but the active pair got no live events until re-picked). Route the
  // reconnect subscribe through a ref of the CURRENT pair.
  const pairRef = useRef({ asset, tf })
  useEffect(() => {
    pairRef.current = { asset, tf }
  }, [asset, tf])

  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  useEffect(() => {
    const socket = io(`/?XTransformPort=${CORE_PORT}`, {
      // Polling first, websocket as an opportunistic upgrade. Behind the Next
      // :3000 proxy the WS upgrade request hangs (rewrites never respond to
      // it), and engine.io's WS-fail path cannot fall back cleanly: by the
      // time the 10s open-timeout fires, readyState has left "opening", so
      // tryAllTransports does not shift to the next transport and every
      // reconnect retries the hanging websocket forever - the OS stayed on
      // "reconnecting…". Polling always completes (the 308 redirect is
      // followed transparently by XHR), then engine.io upgrades to websocket
      // whenever the path allows it (full WS through the Caddy :81 gateway).
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1500,
      timeout: 10000,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      handlersRef.current.onConnectChange?.(true)
      socket.emit('subscribe', { asset: pairRef.current.asset, tf: pairRef.current.tf })
    })
    socket.on('disconnect', () => handlersRef.current.onConnectChange?.(false))
    socket.on('tick', (p) => handlersRef.current.onTick?.(p))
    socket.on('candle', (p) => handlersRef.current.onCandle?.(p))
    socket.on('account', (p) => handlersRef.current.onAccount?.(p))
    // The backend emits 'positionOpened' for EVERY new position, not just
    // ones placed through the trade ticket (autopilot/bot-placed live
    // trades go through this path too, with no local onPlaced callback to
    // trigger a refresh) - without this listener those positions never
    // appear in the blotter until some unrelated position happens to close
    // and onPositionClosed's refresh incidentally picks them up.
    socket.on('positionOpened', (p) => handlersRef.current.onPositionOpened?.(p))
    socket.on('positionClosed', (p) => handlersRef.current.onPositionClosed?.(p))
    socket.on('alert', (p) => handlersRef.current.onAlert?.(p))
    socket.on('ui', (p) => handlersRef.current.onUi?.(p))

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [])

  // re-subscribe when asset/tf changes
  useEffect(() => {
    socketRef.current?.emit('subscribe', { asset, tf })
  }, [asset, tf])
}

// ---------- formatting helpers ----------

// Digits for a quote, by instrument convention: 5 for majors quoted ~1.xx,
// 3 for JPY-style quotes >= 100, scaled for indices/metals/stocks. Shared by
// the DOM formatter and the chart engine so the axis never disagrees with
// the footer, watch, or ticket.
export function priceDigits(v: number, ticker?: string): number {
  const abs = Math.abs(v)
  if (ticker?.endsWith('-OTC') || ticker === 'USDJPY') return abs >= 100 ? 3 : 5
  if (ticker === 'EURUSD' || ticker === 'GBPUSD' || (abs > 1 && abs < 20 && (ticker?.includes('USD') || ticker?.length === 6))) return 5
  return abs >= 1000 ? 1 : abs >= 100 ? 2 : abs >= 10 ? 2 : abs >= 1 ? 4 : 5
}

export function fmtPrice(v: number, ticker?: string): string {
  const digits = priceDigits(v, ticker)
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

// lightweight-charts mirror of fmtPrice. The library defaults to 2 decimals,
// which mangles forex quotes (1.10283 -> 1.10) on the axis, crosshair, and
// price-line labels - this restores the asset's quote convention there.
export function chartPriceFormat(ticker: string | undefined, v: number): { type: 'price'; precision: number; minMove: number } {
  const precision = priceDigits(v, ticker)
  return { type: 'price', precision, minMove: Math.pow(10, -precision) }
}

export function fmtMoney(v: number): string {
  const sign = v < 0 ? '-' : ''
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtPct(v: number, digits = 2): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
}

export function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', { hour12: false })
}

export function fmtClock(ts: number): string {
  const d = new Date(ts * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} UTC`
}
