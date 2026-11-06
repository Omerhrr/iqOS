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

export type TradeKind = 'binary' | 'turbo' | 'blitz' | 'digital' | 'cfd'
export const TRADE_KINDS: TradeKind[] = ['binary', 'turbo', 'blitz', 'digital', 'cfd']
export const KIND_LABEL: Record<TradeKind, string> = { binary: 'Binary', turbo: 'Turbo', blitz: 'Blitz', digital: 'Digital', cfd: 'CFD' }
// Blitz expiries are sub-minute (IQ Option's own picker is seconds-based, not
// minutes) - this is a best-effort set reverse-engineered from a single
// captured trade (option_type_id 12, expiration_size in seconds). Confirm
// against IQ Option's own blitz expiry dropdown before relying on the full
// list; start with the smallest stake if you add/remove values here.
export const BLITZ_EXPIRY_SECONDS: number[] = [5, 10, 15, 20, 30, 60]
// Mirrors trading-core's types.ts BINARY_EXPIRY_MINUTES - every duration IQ
// Option's real binary-option broker call actually accepts (wider than the
// original 1/5m-only assumption). Used both by the manual ticket's expiry
// chip picker and the bot engine's expiry field.
export const BINARY_EXPIRY_MINUTES: number[] = [1, 2, 3, 4, 5, 15, 30, 45, 60, 120]
export function fmtExpiryMinutes(m: number): string {
  return m >= 60 ? `${m / 60}h` : `${m}m`
}

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
// ---------- Smart Money Concepts / ICT structure (trading-core/src/analytics/smc.ts) ----------
// FVG/IFVG/Order Block/Breaker Block/Liquidity Sweep/BOS/CHoCH/OTE/KRM/
// Supply & Demand/Support & Resistance/Breakout/CRT/Power of 3/Silver Bullet
// on the chart's own asset+tf. Detection-only for now - see smc.ts's module
// header: NOT wired into the Next-Candle Oracle's fusion yet, built so it
// can be once it's measured against real resolved outcomes. Two of these
// (KRM, Silver Bullet) are explicitly-flagged interpretations/approximations
// - see the per-signal note text and smc.ts's header comment.

export type SmcDirection = 'bullish' | 'bearish'

export type SmcKind =
  | 'FVG'
  | 'IFVG'
  | 'ORDER_BLOCK'
  | 'BREAKER_BLOCK'
  | 'LIQUIDITY_SWEEP'
  | 'BOS'
  | 'CHOCH'
  | 'OTE'
  | 'KRM'
  | 'SUPPLY_DEMAND'
  | 'SUPPORT_RESISTANCE'
  | 'BREAKOUT'
  | 'CRT'
  | 'POWER_OF_3'
  | 'SILVER_BULLET'

export interface SmcSignal {
  kind: SmcKind
  direction: SmcDirection
  top?: number
  bottom?: number
  level?: number
  index: number
  barsAgo: number
  active: boolean
  touches?: number
  note: string
}

export interface SmcScanResult {
  price: number
  ts: number
  trend: SmcDirection | 'range'
  signals: SmcSignal[]
  summary: { direction: 'call' | 'put' | 'none'; confidence: number; bullish: number; bearish: number }
}

export interface SmcScanResponse {
  ok: true
  asset: string
  tf: Timeframe
  result: SmcScanResult | null
  ts: number
  scanMs: number
  /** true = this is an OTC synthetic pair (ticker ends -OTC). */
  otc: boolean
}

export async function getSmcScan(asset: string, tf: Timeframe): Promise<SmcScanResponse> {
  return osGet<SmcScanResponse>('/smc_scan', { asset, tf })
}

export interface SmcGlobalResult {
  ok: true
  tf: Timeframe
  scannedTs: number
  universe: number
  scanned: number
  agreeing: number
  rows: SmcScanResponse[]
}

export async function getSmcGlobal(tf: Timeframe, opts: { limit?: number; marketScope?: 'all' | 'real' | 'otc' } = {}): Promise<SmcGlobalResult> {
  return osGet<SmcGlobalResult>('/smc_global', { tf, limit: opts.limit, scope: opts.marketScope })
}

// ---------- Meta-strategy (panel-combinator strategies, trading-core/src/analytics+plugins/metastrategy.ts) ----------
// Build a strategy OUT OF the panels directly - "Oracle call AND HMA/ROC/
// Bull-Bear call AND Accute call AND Renko call" - instead of out of raw
// candles. Two ways to build a spec, per direct instruction ("instead of
// using json, lets create our own strategy language, that we can use to
// achieve almost everything"):
//   - conditions-built (the default, simple path, below) - plain data (a
//     list of conditions + one combine rule), never executable code.
//   - script-built (MetaStrategySpec.script) - the Meta Strategy Lab's
//     own small language (mini-services/trading-core/src/analytics/
//     strategylang.ts), real boolean/arithmetic logic over the same named
//     panel reads, still sandboxed (no loops, no I/O, no raw candles) -
//     see that module's header for the full grammar.

export type MetaConditionSource =
  | 'oracle'
  | 'hmaRocBullBear'
  | 'momentumScore'
  | 'accute'
  | 'renko'
  | 'pointFigure'
  | 'rangeBars'
  | 'candle'
  | 'bar'
  | 'heikinAshi'
  | 'line'
  | 'area'
  | 'baseline'
  | 'volumeBars'
  | 'tick'
  | 'footprint'
  | 'tpo'
  | 'ivHv'
  | 'smc'
  | 'smcNow'
  | 'renkoSmc'
  | 'renkoSmcMajority'

export const META_CONDITION_SOURCE_LABELS: Record<MetaConditionSource, string> = {
  oracle: 'Next-Candle Oracle',
  hmaRocBullBear: 'HMA/ROC/Bull-Bear',
  momentumScore: 'Market Momentum Score',
  accute: 'Accute',
  renko: 'Renko',
  pointFigure: 'Point & Figure',
  rangeBars: 'Range Bars',
  candle: 'Candlestick',
  bar: 'Bar (OHLC)',
  heikinAshi: 'Heikin Ashi',
  line: 'Line',
  area: 'Area',
  baseline: 'Baseline',
  volumeBars: 'Volume Bars',
  tick: 'Tick Bars',
  footprint: 'Footprint',
  tpo: 'TPO / Market Profile',
  ivHv: 'IV-HV (realized up-close %)',
  smc: 'Smart Money Concepts (blended)',
  smcNow: 'SMC "now" (this candle only)',
  renkoSmc: 'Renko + SMC "now" confluence (any agrees)',
  renkoSmcMajority: 'Renko + SMC "now" confluence (majority)',
}

/** All 15 SMC concepts, same list Meta Trader's own smc-<kind> sources
 * cover - only meaningful on a 'smcNow' condition's optional smcKind
 * field (undefined = the aggregate "now" read across all of them except
 * Support & Resistance). */
export const ALL_SMC_KINDS = [
  'FVG',
  'IFVG',
  'ORDER_BLOCK',
  'BREAKER_BLOCK',
  'LIQUIDITY_SWEEP',
  'BOS',
  'CHOCH',
  'OTE',
  'KRM',
  'SUPPLY_DEMAND',
  'SUPPORT_RESISTANCE',
  'BREAKOUT',
  'CRT',
  'POWER_OF_3',
  'SILVER_BULLET',
] as const

export interface MetaCondition {
  source: MetaConditionSource
  direction: 'call' | 'put' | 'either'
  minConfidence?: number
  /** Comparison operator applied between the source's confidence and
   * minConfidence - "a wide range of conditions" per direct instruction.
   * Default '>=' (unchanged behavior for every spec saved before this
   * field existed). */
  op?: '>=' | '>' | '<=' | '<' | '==' | '!='
  weight?: number
  /** only meaningful when source === 'smcNow' - one of ALL_SMC_KINDS, or
   * undefined for the aggregate "now" read. */
  smcKind?: string
}

export interface MetaStrategySpec {
  id: string
  name: string
  mode: 'all' | 'any' | 'weighted'
  threshold?: number
  conditions: MetaCondition[]
  /** the strategy-language source, when this spec is script-built - see
   * the module header above. Takes priority over `conditions` whenever
   * it's set (kept non-empty so switching back to the dropdown builder
   * in the UI doesn't lose what was there). */
  script?: string
  createdTs?: number
  updatedTs?: number
}

export interface MetaSourceRead {
  source: MetaConditionSource
  direction: 'call' | 'put' | 'none'
  confidence: number
  label: string
}

export interface MetaConditionResult {
  condition: MetaCondition
  read: MetaSourceRead
  passed: boolean
}

export interface MetaEvalResult {
  direction: 'call' | 'put' | 'none'
  score: number
  confidence: number
  conditions: MetaConditionResult[]
  notes: string
}

export interface MetaStrategyEvalResponse {
  ok: true
  spec: MetaStrategySpec
  result: MetaEvalResult
  price: number
  ts: number
}

export async function getMetaStrategies(): Promise<{ ok: true; strategies: MetaStrategySpec[] }> {
  return osGet('/meta_strategy_list')
}

export async function getMetaStrategySources(): Promise<{ ok: true; sources: MetaConditionSource[] }> {
  return osGet('/meta_strategy_sources')
}

export async function saveMetaStrategy(input: {
  id?: string
  name: string
  mode: 'all' | 'any' | 'weighted'
  threshold?: number
  conditions: MetaCondition[]
  script?: string
}): Promise<{ ok: boolean; id: string; spec: MetaStrategySpec; error?: string }> {
  return osPost('/meta_strategy_save', input)
}

export async function deleteMetaStrategy(id: string): Promise<{ ok: boolean; error?: string }> {
  return osPost('/meta_strategy_delete', { id })
}

export async function evalMetaStrategy(id: string, asset: string, tf: Timeframe): Promise<MetaStrategyEvalResponse> {
  return osGet<MetaStrategyEvalResponse>('/meta_strategy_eval', { id, asset, tf })
}

/** Dry-run a strategy-script string against one asset+tf without saving
 * it - backs the Meta Strategy Lab code editor's "test" button. */
export interface MetaStrategyScriptTestResponse {
  ok: boolean
  direction?: 'call' | 'put' | 'none'
  confidence?: number
  trace?: string[]
  price?: number
  error?: string
  ts?: number
}

export async function testMetaStrategyScript(script: string, asset: string, tf: Timeframe): Promise<MetaStrategyScriptTestResponse> {
  return osPost('/meta_strategy_test_script', { script, asset, tf })
}

/** "we should be able to edit and save the builtin meta strategies" per
 * direct instruction - Meta Trader's own built-in signal sources (oracle/
 * accute/smc/renko-smc/renko-smc-majority/meta-strategy, every smc-<KIND>
 * variant) are real pickXxx() methods on the kernel's MetaTraderService,
 * not a saved spec - these back the Meta Strategy panel's "view/edit/save
 * as code" for them (metasourceedit.ts does the actual file surgery).
 * Editing 'smc' or any smc-<KIND> id edits the ONE shared pickSmc() method
 * (it dispatches on kind internally) - `method` says which one changed. */
export async function getMetaSourceCode(id: string): Promise<{ ok: boolean; source?: string; method?: string; error?: string }> {
  return osGet('/meta_source_code', { id })
}

export async function saveMetaSourceCode(id: string, source: string): Promise<{ ok: boolean; message?: string; method?: string; error?: string }> {
  return osPost('/meta_source_save', { id, source })
}

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

// ---------- Market Profile / TPO (see trading-core/src/analytics/tpo.ts) ----------
// A SECOND, independent way of finding the POC: Volume Profile's POC is the
// price bin with the most (approximated) volume; TPO's POC is the price bin
// touched by the most distinct time periods (classic "single print per
// period" counting) - time-at-price rather than volume-at-price. They often
// agree, and when they don't that disagreement is itself informative.
export interface TpoBin {
  priceLow: number
  priceHigh: number
  mid: number
  tpos: number
  letters: string[]
  inValueArea: boolean
}

export interface TpoPeriod {
  idx: number
  letter: string
  startTime: number
  endTime: number
  high: number
  low: number
  candles: number
}

export interface TpoResult {
  asset: string
  tf: Timeframe
  periodSec: number
  periodRule: string
  countRule: string
  poc: number | null
  valueAreaHigh: number | null
  valueAreaLow: number | null
  ibHigh: number | null
  ibLow: number | null
  totalTpos: number
  bins: TpoBin[]
  periods: TpoPeriod[]
}

export async function getTpoProfile(asset: string, tf: Timeframe, opts?: { limit?: number; periodSec?: number; bins?: number }): Promise<TpoResult> {
  return osGet<TpoResult>('/tpo', {
    asset,
    tf,
    limit: opts?.limit,
    periodSec: opts?.periodSec,
    bins: opts?.bins,
  })
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
  /** The SUGGESTED trade - the committee's own read FADED (see
   * rawDirection), since the real resolved ledger showed the raw
   * committee read loses on its own suggested-expiry horizon and gets
   * worse the more engines agree. This is what cfd's levels are built for. */
  direction: 'call' | 'put'
  /** The committee's own raw read before the fade - what votes/score/
   * agree/total describe. Equal to `direction` only if the backend's fade
   * is ever turned off. */
  rawDirection: 'call' | 'put'
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
  /** Epoch seconds (candle-open time) of the last CLOSED bar that fed the votes. */
  barTs?: number
  /** Seconds since that bar closed - the honest age of the read. */
  ageSec?: number
  /** Edge phase vs the previous scan: entered/flip = just became true,
   * held = already qualifying before (stale-ish). */
  phase?: 'entered' | 'held' | 'flip'
  /** Epoch ms when this read first qualified in its current spell. */
  firstSeenTs?: number
  /** Already qualifying at the scanner's first post-boot scan - true age
   * unknowable, never presented as fresh. */
  backfilled?: boolean
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
  /** Reads whose condition JUST became true or flipped this scan. */
  freshEdges?: number
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

// ---- lead-lag correlation scanner (panel-facing twin of the auto-trader's
// pickLeadLagSignal) ---------------------------------------------------

export interface LeadLagRow {
  leader: string
  asset: string
  name: string
  category: AssetCategory
  otc: boolean
  open: boolean
  price: number
  lag: number
  correlation: number
  lagsTested: number
  n: number
  triggerReturn: number
  triggerZ: number
  direction: 'call' | 'put' | null
  /** true iff this pair currently clears the same gates the auto-trader's
   * lead-lag source requires - exactly what it would act on right now. */
  qualifies: boolean
  ts: number
}

export interface LeadLagScanResult {
  ok: boolean
  tf: Timeframe
  groups: { leader: string; open: boolean; followers: number }[]
  scanned: number
  qualifying: number
  rows: LeadLagRow[]
  ts: number
  scanMs: number
}

export async function getLeadLag(tf: Timeframe): Promise<LeadLagScanResult> {
  return osGet<LeadLagScanResult>('/leadlag', { tf })
}

export interface LeadLagLeaderStats {
  leader: string
  wins: number
  losses: number
  flats: number
  winRate: number | null
  pending: number
}

export interface LeadLagStats {
  ok: boolean
  wins: number
  losses: number
  flats: number
  winRate: number | null
  pending: number
  recorded: number
  avgMovePct: number
  byLeader: LeadLagLeaderStats[]
  recent: {
    id: string
    leader: string
    asset: string
    tf: Timeframe
    otc: boolean
    direction: 'call' | 'put'
    entry: number
    exit: number
    movePct: number
    outcome: 'win' | 'loss' | 'flat'
    correlation: number
    lag: number
    triggerZ: number
    ts: number
    resolvedAt: number
  }[]
  ts: number
}

export async function getLeadLagStats(tf?: Timeframe): Promise<LeadLagStats> {
  return osGet<LeadLagStats>('/leadlag_stats', tf ? { tf } : {})
}

// ---- Chart Signals Distill (Kalman-OU-smoothed combined vote) -----------

export interface ChartSignalsDistillResult {
  filtered: number
  theta: number
  z: number
  tStat: number
  sigmaEq: number
  rawScore: number
  n: number
}

export interface ChartSignalsDistillResponse {
  ok: boolean
  asset: string
  tf: Timeframe
  price: number | null
  result: ChartSignalsDistillResult | null
  direction: 'call' | 'put' | null
  ts: number
}

export async function getChartSignalsDistill(
  asset: string,
  tf: Timeframe,
  opts?: { window?: number; threshold?: number; minAgree?: number }
): Promise<ChartSignalsDistillResponse> {
  return osGet<ChartSignalsDistillResponse>('/distill', {
    asset,
    tf,
    ...(opts?.window !== undefined ? { window: opts.window } : {}),
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    ...(opts?.minAgree !== undefined ? { minAgree: opts.minAgree } : {}),
  })
}

export interface DistillScanRow {
  asset: string
  name: string
  category: string
  otc: boolean
  open: boolean
  price: number
  filtered: number
  z: number
  rawScore: number
  tStat: number
  direction: 'call' | 'put' | null
}

export interface DistillScanResponse {
  ok: boolean
  tf: Timeframe
  scanned: number
  rows: DistillScanRow[]
  ts: number
}

export async function getDistillScan(tf: Timeframe): Promise<DistillScanResponse> {
  return osGet<DistillScanResponse>('/distill_scan', { tf })
}

// ---- Cointegration (Engle-Granger pairs) ---------------------------------

export interface CointegrationFit {
  beta: number
  alpha: number
  r2: number
  theta: number
  sigmaEq: number
  tStat: number
  halfLifeBars: number
  z: number
  n: number
}

export interface CointegrationResponse {
  ok: boolean
  asset: string
  tf: Timeframe
  leader: string | null
  price: number | null
  result: CointegrationFit | null
  direction: 'call' | 'put' | null
  ts: number
}

export async function getCointegration(asset: string, tf: Timeframe, window?: number): Promise<CointegrationResponse> {
  return osGet<CointegrationResponse>('/cointegration', { asset, tf, ...(window !== undefined ? { window } : {}) })
}

export interface CointegrationScanRow {
  leader: string
  asset: string
  name: string
  category: string
  otc: boolean
  open: boolean
  price: number
  beta: number
  r2: number
  z: number
  tStat: number
  halfLifeBars: number
  n: number
  direction: 'call' | 'put' | null
  qualifies: boolean
}

export interface CointegrationScanResponse {
  ok: boolean
  tf: Timeframe
  scanned: number
  qualifying: number
  rows: CointegrationScanRow[]
  ts: number
}

export async function getCointegrationScan(tf: Timeframe): Promise<CointegrationScanResponse> {
  return osGet<CointegrationScanResponse>('/cointegration_scan', { tf })
}

// ---- Volatility Arb (close-vol vs range-vol) -----------------------------

export interface VolArbResult {
  closeVol: number
  rangeVol: number
  ratio: number
  momentum: number
  lastBarDir: -1 | 0 | 1
}

export interface VolArbResponse {
  ok: boolean
  asset: string
  tf: Timeframe
  price: number | null
  result: VolArbResult | null
  ts: number
}

export async function getVolArb(asset: string, tf: Timeframe, window?: number): Promise<VolArbResponse> {
  return osGet<VolArbResponse>('/volarb', { asset, tf, ...(window !== undefined ? { window } : {}) })
}

export interface VolArbScanRow {
  asset: string
  name: string
  category: string
  otc: boolean
  open: boolean
  price: number
  closeVol: number
  rangeVol: number
  ratio: number
  momentum: number
  lastBarDir: -1 | 0 | 1
  direction: 'call' | 'put' | null
  regime: 'fade' | 'continue' | 'balanced'
}

export interface VolArbScanResponse {
  ok: boolean
  tf: Timeframe
  scanned: number
  rows: VolArbScanRow[]
  ts: number
}

export async function getVolArbScan(tf: Timeframe): Promise<VolArbScanResponse> {
  return osGet<VolArbScanResponse>('/volarb_scan', { tf })
}

// ---- Triangulation Arbitrage (synthetic vs actual cross-rate) -----------

export interface TriangulationScanRow {
  currencies: string
  legAB: string
  legBC: string
  cross: string
  price: number
  synthetic: number
  deltaPct: number
  z: number
  n: number
  otc: boolean
  open: boolean
  direction: 'call' | 'put' | null
  qualifies: boolean
  /** How many consecutive closed bars (counting this one) the same
   * direction has qualified - 1 = just crossed this bar, 0 = not currently
   * qualifying. Lets the panel tell a fresh divergence apart from one
   * that's simply been sitting there a while (index.ts's scanTriangulation,
   * same backward-walk idea as analytics/edge.ts's evalWithEdge). */
  ageBars: number
}

export interface TriangulationScanResponse {
  ok: boolean
  tf: Timeframe
  scanned: number
  qualifying: number
  rows: TriangulationScanRow[]
  ts: number
}

export async function getTriangulationScan(tf: Timeframe): Promise<TriangulationScanResponse> {
  return osGet<TriangulationScanResponse>('/triangulation_scan', { tf })
}

// ---- ADX/DI + Pattern Bias composite -------------------------------------

export interface AdxPatternBiasScanRow {
  asset: string
  name: string
  category: string
  otc: boolean
  open: boolean
  price: number
  adx: number
  plusDI: number
  minusDI: number
  trending: boolean
  patternBias: number
  topPattern: string | null
  topPatternBarsAgo: number | null
  agree: boolean
  composite: number
  direction: 'call' | 'put' | null
  /** Heikin Ashi pattern read (independent third signal) actively
   * contradicts the proposed direction - a precision veto that only
   * tightens qualification, never loosens it. */
  haDisagrees: boolean
  /** Same ADX/DI read one timeframe rung up ('neutral' when the higher
   * frame isn't itself trending or wasn't available). */
  htfDirection: 'bullish' | 'bearish' | 'neutral'
  /** Same pattern-bias read one timeframe rung up ('neutral' when there's
   * no pattern hit on the higher frame or it wasn't available). */
  htfPatternDirection: 'bullish' | 'bearish' | 'neutral'
  /** The higher-timeframe ADX/DI direction OR the higher-timeframe pattern
   * direction actively contradicts this read's proposed direction -
   * another precision veto, same contract as haDisagrees. Check
   * htfDirection/htfPatternDirection against `direction` to see which one
   * actually triggered it. */
  htfDisagrees: boolean
  /** The Oracle's own 4-way regime classifier, fed this fit's own ADX plus
   * lightweight vol/persistence proxies. A VOLATILE read raises the
   * composite bar this row had to clear (never a hard veto). */
  regime: string
  /** Did the strongest recent pattern hit's bar carry above-average volume?
   * null when volume data is degraded (routine for OTC/binary feeds) -
   * informational only, never gates qualification. */
  volumeConfirms: boolean | null
  qualifies: boolean
}

export interface AdxPatternBiasScanResponse {
  ok: boolean
  tf: Timeframe
  scanned: number
  qualifying: number
  rows: AdxPatternBiasScanRow[]
  ts: number
}

export async function getAdxPatternBiasScan(tf: Timeframe): Promise<AdxPatternBiasScanResponse> {
  return osGet<AdxPatternBiasScanResponse>('/adx_pattern_bias_scan', { tf })
}

/** One resolved ADX/DI+Pattern honesty-loop call
 * (mini-services/trading-core/src/plugins/adxhonesty.ts's ResolvedAdxCall). */
export interface AdxHonestyResolvedCall {
  asset: string
  tf: string
  targetBarTime: number
  issuedTs: number
  resolvedTs: number
  direction: 'call' | 'put'
  adxDirection: 'bullish' | 'bearish' | 'neutral'
  patternDirection: 'bullish' | 'bearish' | 'neutral'
  composite: number
  entry: number
  exit: number
  actual: 'up' | 'down' | 'flat'
  hit: boolean
  /** this read's HTF disagreement flag at track time. */
  htfDisagrees: boolean
  /** this read's HA (Heikin Ashi pattern) disagreement flag at track time. */
  haDisagrees: boolean
  /** this read's volumeConfirms flag at track time - null = no volume
   * data available for this window. */
  volumeConfirms: boolean | null
  /** true = the HTF veto alone blocked this from firing live - it's here
   * purely so the learned HTF-veto penalty can judge whether the veto is
   * worth its cost; never treat a shadow entry as a real signal. */
  shadow: boolean
  /** true = the HA veto alone blocked this from firing live - the haBlocks
   * counterpart of `shadow` above, same non-live, learning-only contract. */
  haShadow: boolean
  /** did the Next-Candle Oracle have an active same-direction read at
   * track time? null = no active oracle read either way. */
  oracleAgrees: boolean | null
}

export interface AdxPatternBiasStatsResponse {
  ok: boolean
  error?: string
  total: number
  pending: number
  hitRate: number | null
  /** learned relative weight of the ADX/DI trend leg vs the candlestick
   * pattern leg (0.5-2 each, re-normalized around 1 in composite()) -
   * null until both legs have >=30 resolved samples. */
  legWeights: { trendWeight: number; patternWeight: number } | null
  /** learned replacement for the flat COMPOSITE_QUALIFY bar - the
   * smallest composite threshold, among a small candidate sweep, whose
   * own resolved hit rate clears 55%. null = still using the hand-set 3.5. */
  qualifyBar: number | null
  /** direction-split counterpart of qualifyBar above - a pair/regime can
   * carry a structural trend bias that makes bullish and bearish reads
   * differently reliable. Each side independently null until it has its
   * own 30+ resolved samples clearing the target hit rate, falling back
   * to the flat qualifyBar (then the hand-set 3.5) when null. */
  qualifyBarByDirection: { bullish: number | null; bearish: number | null }
  /** learned multiplier an HTF-disagreeing read's composite must clear
   * (as a multiple of the normal qualify bar) to still qualify. null =
   * the HTF veto is still a flat hard block (not enough shadow samples
   * yet to judge it either way). */
  htfPenaltyMult: number | null
  /** learned multiplier an HA (Heikin Ashi pattern)-disagreeing read's
   * composite must clear to still qualify - the haBlocks counterpart of
   * htfPenaltyMult above. null = still a flat hard block. */
  haPenaltyMult: number | null
  /** learned confidence/score multiplier (capped at 1.25x) applied when
   * the Next-Candle Oracle actively agrees on direction - 1 = no boost
   * (not enough samples on both sides yet to trust the comparison). */
  confluenceBoost: number
  /** learned, bounded boost (capped at 1.2x) applied to the composite-vs-
   * qualify-bar comparison when volumeConfirms reads true - 1 = no boost
   * (not enough resolved samples on both the confirmed and unconfirmed
   * sides yet, routinely slow on OTC/binary feeds with no real volume
   * data). */
  volumeBoost: number
  /** learned replacement for the flat ADX_TREND_THRESHOLD (25) - the
   * smallest candidate ADX level, among a small ascending sweep, whose
   * own resolved subset clears the target hit rate. Can only ever be
   * raised above 25 (every resolved call already required adx >= the
   * threshold in force), never lowered. null = still using the flat 25. */
  trendThreshold: number | null
  recent: AdxHonestyResolvedCall[]
}

export async function getAdxPatternBiasStats(): Promise<AdxPatternBiasStatsResponse> {
  return osGet<AdxPatternBiasStatsResponse>('/adx_pattern_bias_stats', {})
}

export interface ShockPressureScanRow {
  asset: string
  name: string
  category: string
  otc: boolean
  open: boolean
  price: number
  atr: number
  barReturn: number
  shockRatio: number
  shock: boolean
  shockDirection: 'bullish' | 'bearish' | 'neutral'
  netDelta: number
  netVolume: number
  volumeDegraded: boolean
  pressureRatio: number
  pressureDirection: 'bullish' | 'bearish' | 'neutral'
  agree: boolean
  composite: number
  direction: 'call' | 'put' | null
  qualifies: boolean
}

export interface ShockPressureScanResponse {
  ok: boolean
  tf: Timeframe
  scanned: number
  qualifying: number
  rows: ShockPressureScanRow[]
  ts: number
}

export async function getShockPressureScan(tf: Timeframe): Promise<ShockPressureScanResponse> {
  return osGet<ShockPressureScanResponse>('/shock_pressure_scan', { tf })
}

export interface RenkoFootprintScanRow {
  asset: string
  name: string
  category: string
  otc: boolean
  open: boolean
  price: number
  renkoDir: 'call' | 'put' | null
  renkoWeight: number
  renkoNote: string
  fpDir: 'call' | 'put' | null
  fpWeight: number
  fpNote: string
  agree: boolean
  composite: number
  direction: 'call' | 'put' | null
  qualifies: boolean
}

export interface RenkoFootprintScanResponse {
  ok: boolean
  tf: Timeframe
  scanned: number
  qualifying: number
  rows: RenkoFootprintScanRow[]
  ts: number
}

export async function getRenkoFootprintScan(tf: Timeframe): Promise<RenkoFootprintScanResponse> {
  return osGet<RenkoFootprintScanResponse>('/renko_footprint_scan', { tf })
}

export async function getRenkoOtcFootprintScan(tf: Timeframe): Promise<RenkoFootprintScanResponse> {
  return osGet<RenkoFootprintScanResponse>('/renko_otc_footprint_scan', { tf })
}

export interface VolumeFootprintScanRow {
  asset: string
  name: string
  category: string
  otc: boolean
  open: boolean
  price: number
  volDir: 'call' | 'put' | null
  volWeight: number
  volNote: string
  relVolume: number
  fpDir: 'call' | 'put' | null
  fpWeight: number
  fpNote: string
  agree: boolean
  composite: number
  direction: 'call' | 'put' | null
  qualifies: boolean
}

export interface VolumeFootprintScanResponse {
  ok: boolean
  tf: Timeframe
  scanned: number
  qualifying: number
  rows: VolumeFootprintScanRow[]
  ts: number
}

export async function getVolumeFootprintScan(tf: Timeframe): Promise<VolumeFootprintScanResponse> {
  return osGet<VolumeFootprintScanResponse>('/volume_footprint_scan', { tf })
}

export interface TickVolumeScanRow {
  asset: string
  name: string
  category: string
  otc: boolean
  open: boolean
  price: number
  tickDir: 'call' | 'put' | null
  tickWeight: number
  tickNote: string
  volDir: 'call' | 'put' | null
  volWeight: number
  volNote: string
  relVolume: number
  agree: boolean
  composite: number
  direction: 'call' | 'put' | null
  qualifies: boolean
}

export interface TickVolumeScanResponse {
  ok: boolean
  tf: Timeframe
  scanned: number
  qualifying: number
  rows: TickVolumeScanRow[]
  ts: number
}

export async function getTickVolumeScan(tf: Timeframe): Promise<TickVolumeScanResponse> {
  return osGet<TickVolumeScanResponse>('/tick_volume_scan', { tf })
}

export interface PatternHit {
  name: string
  direction: 'bullish' | 'bearish' | 'neutral'
  reliability: 1 | 2 | 3
  barsAgo: number
  note: string
}

export interface AdxPatternBiasFit {
  adx: number
  plusDI: number
  minusDI: number
  trending: boolean
  adxDirection: 'bullish' | 'bearish' | 'neutral'
  patternBias: number
  patternDirection: 'bullish' | 'bearish' | 'neutral'
  topPattern: string | null
  topPatternBarsAgo: number | null
  /** every pattern hit in the lookback window, most recent first (raw
   * OHLC - this also IS the "bar chart" pattern read, since a Bar chart and
   * a Candles chart plot the same OHLC values) */
  patterns: PatternHit[]
  /** same detectors, run against the Heikin Ashi transform of this series */
  haPatterns: PatternHit[]
  haPatternBias: number
  haPatternDirection: 'bullish' | 'bearish' | 'neutral'
  agree: boolean
  composite: number
  direction: 'bullish' | 'bearish' | 'neutral'
  qualifies: boolean
}

/** One closed candle's buy-sell delta (footprint.ts's FootprintCandle.delta,
 * CLV-proxy - same approximation-honesty caveat as the Footprint panels:
 * no true bid/ask feed, volume spread by CLV ratio). */
export interface PairCompareDelta {
  time: number
  delta: number
  close: number
}

export interface PairCompareSide {
  asset: string
  name: string
  category: string
  otc: boolean
  open: boolean
  price: number
  fit: AdxPatternBiasFit | null
  direction: 'call' | 'put' | null
  /** trailing 24 closed candles' per-candle delta, oldest first */
  delta: PairCompareDelta[]
}

export interface LeadLagSignal {
  fit: { lag: number; correlation: number; lagsTested: number; n: number }
  triggerReturn: number
  triggerZ: number
  direction: 'call' | 'put'
}

export interface PairCompareLeadLag {
  lag: number
  correlation: number
  lagsTested: number
  n: number
  signal: LeadLagSignal | null
  qualifies: boolean
}

export interface PairCompareResponse {
  ok: boolean
  tf: Timeframe
  a: PairCompareSide
  b: PairCompareSide
  leadlag: {
    aLeadsB: PairCompareLeadLag
    bLeadsA: PairCompareLeadLag
    strongerDirection: 'aLeadsB' | 'bLeadsA' | 'none'
  }
  ts: number
}

export async function getPairCompare(a: string, b: string, tf: Timeframe): Promise<PairCompareResponse> {
  return osGet<PairCompareResponse>('/pair_compare', { a, b, tf })
}

/** Single-asset twin of PairCompareResponse - same side shape (ADX/DI +
 * pattern bias + HA pattern bias + per-candle delta), no second asset and
 * no lead-lag section. */
export interface PairSignalResponse {
  ok: boolean
  tf: Timeframe
  side: PairCompareSide
  ts: number
}

export async function getPairSignal(asset: string, tf: Timeframe): Promise<PairSignalResponse> {
  return osGet<PairSignalResponse>('/pair_signal', { asset, tf })
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

// ---- chart candles ----------------------------------------------------------
// Kernel route /candles: the chart's feed. `deep` reads the kernel's
// accumulated archive + live tail (getCandlesDeep) instead of the live series
// alone - the Yesterday panel's echo click-through uses it to pull a full day
// plus the replay window of bars so the T-24h story is actually on the chart.
// Plain reads clamp at 1000 bars; deep reads may reach the archive's own
// 4000-bar depth. Bars the feed never remembered come back absent (a gap on
// the chart), never as synthetic filler.

export async function getCandles(
  asset: string,
  tf: Timeframe,
  opts?: { limit?: number; deep?: boolean },
): Promise<{ ok: boolean; asset: string; tf: Timeframe; candles: Candle[]; price: number; deep?: boolean }> {
  return osGet('/candles', {
    asset,
    tf,
    ...(opts?.limit != null ? { limit: opts.limit } : {}),
    ...(opts?.deep ? { deep: 1 } : {}),
  })
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

/** The per-prior-day echo: today's lead-in vs THAT day's lead-in, same
 * three-part rhyme score as the row echo. Kernel sends null when either side
 * is under half covered; optional on the wire so an older kernel still parses. */
export interface YdayPriorEcho {
  /** 0..100 - direction agreement (50) + move magnitude vs this day's own travel (30) + travel ratio (20) */
  rhyme: number
  dirAgree: 'same' | 'partial' | 'opposite'
  /** both lead-ins flat (|move| < 10% of travel either side) - a real but
   * trivial agreement; the panel marks it and keeps it out of the aggregates.
   * Optional on the wire so an older kernel still parses. */
  quiet?: boolean
}

/** One remembered day BEFORE yesterday (T-48h, T-72h, ...): the same forward
 * window. Days whose coverage failed the >= half gate are ABSENT - gaps are
 * information. Optional on the wire so an older kernel still parses. */
export interface YdayPrior {
  /** how many days back (2 = T-48h, 3 = T-72h, ...) */
  back: number
  /** epoch seconds of the bar that was forming at that moment (window start) */
  thenTs: number
  /** net move over the window, % */
  movePct: number
  dir: YdayDir
  /** high-low travel across the window, % */
  rangePct: number
  barsFound: number
  barsExpected: number
  /** session the market was in at that moment */
  session: YdaySession
  /** today's lead-in vs this day's lead-in ("does today rhyme with the whole
   * week at this hour?"); null/absent = either side under half covered */
  echo?: YdayPriorEcho | null
}

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
  /** both lead-ins flat (|move| < 10% of travel either side) - a real but
   * trivial agreement (two dead hours rhyme perfectly); the panel marks it
   * and keeps it out of the aggregates. Optional on the wire so an older
   * kernel still parses. */
  quiet?: boolean
}

/** One session bucket of the row's per-session rhyme profile: the SAME
 * adjacent-day lead-in echo scored at every hour of the day (kernel-side,
 * from the candles the scan already pulled), aggregated per session. Quiet
 * echoes (both lead-ins flat) count in obs but are excluded from avg - same
 * rule as every other aggregate. -OTC tickers get one day-wide 'OTC' bucket
 * (they have no sessions). Optional on the wire so an older kernel parses. */
export interface YdaySessionRhyme {
  session: YdaySession
  /** adjacent-day lead-in echoes scored in this session's hours */
  obs: number
  /** of those, both lead-ins flat (trivial agreement - kept out of avg) */
  quiet: number
  /** total rhyme of the non-quiet echoes in this bucket (the unrounded
   * numerator behind avg) - folding many rows per class from sum stays exact
   * instead of averaging rounded averages. Optional so an older kernel
   * parses; the panel falls back to avg x (obs - quiet) when absent. */
  sum?: number
  /** mean rhyme of the non-quiet echoes, 0..100; null when none survived */
  avg: number | null
  /** the distinct UTC hours whose NON-quiet pairs fed avg, ascending - the
   * hours a peak (or any measured cell) is actually made of, named in the
   * cell's tooltip. Empty when avg is null (quiet pairs feed obs, not the
   * average). Optional so an older kernel parses; the panel just omits the
   * hours clause then. */
  hours?: number[]
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
  /** deeper same-hour history, most recent first (back = 2, 3, ...); empty unless the scan asked for more than one day */
  prior?: YdayPrior[]
  /** per-session rhyme profile (see YdaySessionRhyme) - present only when the
   * scan asked for it (profile=1); five ordered session buckets on real rows,
   * one OTC bucket on -OTC rows */
  profile?: YdaySessionRhyme[]
}

export interface YesterdayResponse {
  ok: boolean
  tf: Timeframe
  /** effective forward window in minutes (snapped to whole bars of the tf) */
  windowMin: number
  /** requested day depth (1 = yesterday only; rows carry `prior` beyond that) */
  days?: number
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
 * is the forward window replayed after T-24h (5..240, default 60); `days`
 * (1..7, default 1) walks the same window back over more days - every row
 * then carries `prior`, and finer tfs fit fewer days. Every row also carries
 * the echo lead-in comparison where coverage allows. `profile` (opt-in) adds
 * each row's per-session rhyme profile - the same echo scored at every hour
 * of the day, so "does the script differ ASIA vs LONDON vs NY?" is one line. */
export async function getYesterday(tf: Timeframe, windowMin = 60, days = 1, profile = false): Promise<YesterdayResponse> {
  return osGet<YesterdayResponse>('/yesterday', { tf, window: windowMin, days, ...(profile ? { profile: 1 } : {}) })
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

/** Latest Kalman/OU stretch z-score for one asset - thin wrapper over the
 * generic /indicator endpoint + the 'kalman-ou-z' registry entry
 * (analytics/kalman.ts's ouSeries), just the last finite value instead of
 * the full series a SubPane would render. Returns null when the feed is too
 * short to fit an OU model yet. */
export async function getKalmanOuZ(asset: string, tf: Timeframe, window = 240): Promise<number | null> {
  const d = await osGet<{ ok: boolean; series: { lines: { key: string; values: (number | null)[] }[] } }>('/indicator', {
    id: 'kalman-ou-z',
    asset,
    tf,
    p_window: window,
  })
  const z = d.series.lines.find((l) => l.key === 'z')
  if (!z) return null
  for (let i = z.values.length - 1; i >= 0; i--) {
    const v = z.values[i]
    if (v !== null && Number.isFinite(v)) return v
  }
  return null
}

// ---------- Next-Candle Oracle (analytics/nextcandle.ts, plugins/nextcandle.ts) ----------
// Fused multi-model next-candle forecast (Monte Carlo + chart-engine
// committee + Markov/regime context) with a live self-calibration honesty
// loop - the panel shows the forecast next to the oracle's own resolved
// track record for that exact asset:tf.

export type OracleRegime = 'TRENDING' | 'RANGING' | 'VOLATILE' | 'MIXED'

export interface OracleDriver {
  name: string
  /** this model's own read of P(next close > current close) */
  pUp: number
  /** weight used in the fusion (post-regime adjustment) */
  weight: number
  /** signed -1..+1 convenience read for the UI */
  vote: number
  /** one-line human explanation of what the model sees */
  detail: string
}

export interface NextCandlePrediction {
  asset: string
  tf: string
  ts: number
  /** bar-open timestamp the prediction targets (current forming bar's open) */
  targetBarTime: number
  price: number
  /** fused probability the next candle closes above the current close */
  pUp: number
  direction: 'call' | 'put' | 'none'
  /** 0..100 - agreement + distance from coin-flip, discounted by live calibration */
  confidence: number
  /** raw confidence before the calibration discount (panel shows both) */
  rawConfidence: number
  regime: OracleRegime
  /** expected absolute move of the next candle, price units */
  expectedMove: number
  /** ATR(14) of the series - the cone's natural denominator */
  atr: number
  /** expected next-candle range cone (price units) */
  range: { low: number; high: number }
  /** expected body vs range ratio 0..1 */
  bodyRatio: number
  /** expected close position within the range 0..1 (wick asymmetry read) */
  closePos: number
  /** plain-language label for the kind of candle shape this geometry
   * implies (marubozu-like, doji/indecision, rejection-wick, etc.) - see
   * analytics/nextcandle.ts's classifyExpectedCandleType(). */
  expectedCandleType: string
  drivers: OracleDriver[]
  /** how many drivers were actually usable (had enough history) */
  driversActive: number
  /** live self-calibration (null = no resolved record yet) */
  calibration: { n: number; hitRate: number; brier: number } | null
  mode: 'sim' | 'live'
  /** A SEPARATE, deliberately simple secondary read (Hull MA slope + ROC +
   * Elder Ray Bull/Bear Power, averaged) for the panel to show next to the
   * Oracle's own fused prediction - not one of the drivers above, not
   * fused through the Oracle's calibration/correlation machinery, and not
   * tracked by the honesty loop. null when there wasn't enough history. */
  altPrediction?: HmaRocBullBearPrediction | null
  /** Third secondary read - the user's own multi-timeframe "Market
   * Momentum Score" formula (analytics/momentumscore.ts). Same treatment
   * as altPrediction: deliberately simple, untracked, not fused with the
   * Oracle's own prediction, shown alongside it for comparison. */
  momentumPrediction?: MomentumScorePrediction | null
  /** "who fully has control right now" - buy/sell transaction-pressure
   * dominance (analytics/orderflow.ts computeControlRead), NOT a direction
   * prediction. This is what the panel's "full domination" chip and
   * Global Dom actually surface, replacing momentumPrediction.domination. */
  controlRead?: ControlRead | null
}

/** The HMA/ROC/Bull-Bear secondary read attached to NextCandlePrediction.altPrediction
 * - see analytics/hmarocbullbear.ts. Deliberately simple/untracked; shown
 * next to the Oracle's own prediction for comparison, not fused with it. */
export interface HmaRocBullBearPrediction {
  direction: 'call' | 'put' | 'none'
  /** combined -1..1 score, simple average of the three normalized reads */
  score: number
  /** 0..100 - |score| scaled; NOT the Oracle's confidence (no calibration discount) */
  strength: number
  hmaSlope: number
  rocValue: number
  bullPower: number
  bearPower: number
  bodyRatio: number
  closePos: number
  expectedCandleType: string
}

/** The Market Momentum Score secondary read attached to
 * NextCandlePrediction.momentumPrediction - see analytics/momentumscore.ts.
 * Score = W1*T15m + W2*T5m + W3*T1m + W4*T30s, each T_<tf> a pure
 * candle-math (body-direction-within-range) term on that timeframe's own
 * candles - genuinely cross-timeframe, not a resample of one series. */
export interface MomentumScorePrediction {
  direction: 'call' | 'put' | 'none'
  score: number
  strength: number
  weights: { w15m: number; w5m: number; w1m: number; w30s: number }
  components: { t15m: number; t5m: number; t1m: number; t30s: number }
  bodyRatio: number
  closePos: number
  expectedCandleType: string
  /** true only when all four timeframes agree in direction AND each one
   * individually clears the backend's domination threshold - manual-trade
   * confirmation signal. Superseded by controlRead.fullControl as what the
   * panel's "full domination" chip actually shows; kept as a field for
   * anything else still reading it. */
  domination: boolean
}

/** "Who fully has control right now" (analytics/orderflow.ts
 * computeControlRead) - buy/sell transaction-pressure dominance over a
 * short recent window on the asset's own tf, NOT a direction prediction.
 * `dominance` is the WEAKEST bar's dominant-side share in the window (not
 * the average) - fullControl requires the SAME side to have held every
 * bar AND even the weakest one to clear the threshold. */
export interface ControlRead {
  direction: 'buy' | 'sell' | 'none'
  dominance: number
  fullControl: boolean
  barsChecked: number
  note: string
}

/** One resolved prediction from the oracle's honesty ledger. */
export interface OracleRecentResolution {
  asset: string
  tf: string
  targetBarTime: number
  issuedTs: number
  resolvedTs: number
  predicted: 'call' | 'put' | 'none'
  pUp: number
  confidence: number
  entry: number
  exit: number
  actual: 'up' | 'down' | 'flat'
  hit: boolean
  score: number
  brier: number
}

/** One learned calibration bucket - shape shared by regime/session/
 * direction splits (mini-services/trading-core/src/plugins/nextcandle.ts). */
export interface OracleCalibrationBucket {
  n: number
  hitRate: number
  brier: number
}

export type OracleSession = 'ASIA' | 'LONDON' | 'OVERLAP' | 'NEWYORK' | 'OFF' | 'OTC'

export interface NextCandleStatsResponse {
  ok: boolean
  error?: string
  total: number
  pending: number
  records: {
    asset: string
    tf: string
    n: number
    hitRate: number
    brier: number
    streak: number
    /** learned calibration buckets - whichever is thick enough (n>=20)
     * actually gets used, in order regime -> session -> direction ->
     * blended (see predictNextCandle's preference order). Shown here so a
     * panel can explain WHY a prediction's confidence badge differs from
     * the plain blended record above. */
    regimeCalibration: Partial<Record<OracleRegime, OracleCalibrationBucket>>
    sessionCalibration: Partial<Record<OracleSession, OracleCalibrationBucket>>
    directionCalibration: Partial<Record<'call' | 'put', OracleCalibrationBucket>>
    /** learned realized-move / predicted-move ratio for this pair - 1 =
     * untouched (thin data), >1 = the model has been predicting too
     * NARROW a move historically, <1 = too WIDE. null = not trusted yet. */
    magnitudeCalibration: number | null
    /** this pair's own "physiology" - its own per-driver win-rate
     * multipliers (blended + per-regime), calibration-quality
     * multipliers, and driver-correlation discounts, computed from only
     * this asset:tf's own resolved history. Takes priority over the
     * universe-wide tables below, per driver, once this pair has enough
     * of its own resolved history; empty objects mean every driver is
     * still falling back to the universe-wide read. */
    pairDriverWeightMultipliers: Record<string, number>
    pairRegimeDriverWeightMultipliers: Partial<Record<OracleRegime, Record<string, number>>>
    pairDriverCalibrationMultipliers: Record<string, number>
    pairDriverCorrelation: Record<string, number>
    /** this pair's own learned confidence-blend weight and per-pattern
     * reliability table - same priority as the physiology tables above:
     * takes precedence over the universe-wide values once this pair has
     * enough of its own resolved history. */
    pairConfidenceBlendWeight: number | null
    pairPatternReliability: Record<string, number>
    /** intermediate asset-category fallback tier (e.g. "forex",
     * "crypto:otc") between this pair's own tables and the universe-wide
     * ones - null when this ticker's category couldn't be resolved. */
    clusterKey: string | null
    clusterDriverWeightMultipliers: Record<string, number>
    clusterRegimeDriverWeightMultipliers: Partial<Record<OracleRegime, Record<string, number>>>
    clusterDriverCalibrationMultipliers: Record<string, number>
    clusterDriverCorrelation: Record<string, number>
  }[]
  /** universe-wide learned driver weight multipliers (0.75-1.3), blended
   * across regimes - a driver sitting meaningfully above/below 50% hit
   * rate over a real sample gets up/down-weighted here. */
  driverWeightMultipliers: Record<string, number>
  /** same driver weights, split one table per regime when that regime has
   * enough of its own resolutions - falls back to the blended table above
   * when a regime bucket is thin or absent. */
  regimeDriverWeightMultipliers: Partial<Record<OracleRegime, Record<string, number>>>
  /** universe-wide CALIBRATION-quality multiplier per driver (0.8-1.2) -
   * independent of the win-rate multiplier above: rewards a driver for
   * being honest about its own uncertainty (low resolved Brier), not just
   * lucky on direction. */
  driverCalibrationMultipliers: Record<string, number>
  /** learned pairwise driver correlation discount, keyed by "NameA|NameB"
   * (alphabetical) - a pair agreeing meaningfully more than chance gets
   * discounted toward 0.5 so their shared evidence isn't double-counted;
   * a pair not in this table has no learned discount (the fusion still
   * applies ONE hand-set default pair, Candle patterns/Bar physics, as a
   * fallback when nothing's been learned for it yet). */
  driverCorrelation: Record<string, number>
  /** learned agreement-weight in the final rawConfidence blend
   * (confidence = blend*agreement + (1-blend)*distance) - replaces the
   * flat hand-set 0.55 once there's enough resolved history to pick a
   * better one. null = still using 0.55. */
  confidenceBlendWeight: number | null
  /** universe-wide learned per-pattern reliability (0.3-4 scale, same
   * range the hand-set table used) - feeds every patternBias() caller in
   * the codebase, not just this engine. */
  patternReliability: Record<string, number>
  recent: OracleRecentResolution[]
}

export async function getNextCandle(asset: string, tf: Timeframe): Promise<{ ok: boolean; prediction?: NextCandlePrediction; error?: string }> {
  return osGet('/next_candle', { asset, tf })
}

export async function getNextCandleStats(): Promise<NextCandleStatsResponse> {
  return osGet('/next_candle_stats', {})
}

// ---------- Next-Expiry Oracle (analytics/nextexpiry.ts, plugins/nextexpiry.ts) ----------

export type OracleSessionName = 'ASIA' | 'LONDON' | 'OVERLAP' | 'NEWYORK' | 'OFF' | 'OTC'

/** One horizon model inside a single expiry's fusion. */
export interface ExpiryDriver {
  name: string
  /** the model's own read of P(close E minutes ahead > spot) */
  pUp: number
  weight: number
  /** signed -1..+1 convenience read */
  vote: number
  /** one-line human explanation of what the model sees at THIS expiry */
  detail: string
}

/** One expiry rung (1/2/3/5/15 min) of the Next-Expiry Oracle's ladder. */
export interface ExpiryRow {
  expiry: number
  /** false = this horizon's models are still warming up - never a recommendation */
  ok: boolean
  note: string
  pUp: number
  direction: 'call' | 'put' | 'none'
  /** probability the RECOMMENDED direction wins = max(pUp, 1-pUp) */
  pWin: number
  /** 0..100 calibrated confidence (own per-(asset,expiry) record applied) */
  confidence: number
  rawConfidence: number
  /** tradability score the best pick is ranked on */
  edge: number
  /** 0..1 - how far this horizon's variance ratio sits from a random walk */
  predictability: number
  expectedMove: number
  cone: { low: number; high: number }
  drivers: ExpiryDriver[]
  driversActive: number
  calibration: { n: number; hitRate: number; brier: number } | null
  /** 1m bar-open timestamp (seconds) whose close resolves this window */
  targetBarTime: number
}

export interface NextExpiryPrediction {
  asset: string
  ts: number
  mode: 'sim' | 'live'
  /** spot = last closed 1m close - the entry every row is measured from */
  price: number
  regime: OracleRegime
  session: OracleSessionName
  /** OU reversion half-life in whole minutes (the expiry compass), null
   * when the pair isn't mean-reverting enough to have one */
  halfLifeMin: number | null
  rows: ExpiryRow[]
  best: { expiry: number; direction: 'call' | 'put'; pWin: number; confidence: number; edge: number } | null
  note: string
  calibrationTotal: { n: number; hitRate: number; brier: number } | null
}

/** One resolved window from the expiry oracle's honesty ledger. */
export interface ExpiryRecentResolution {
  asset: string
  expiry: number
  targetBarTime: number
  issuedTs: number
  resolvedTs: number
  predicted: 'call' | 'put'
  pUp: number
  confidence: number
  entry: number
  exit: number
  actual: 'up' | 'down' | 'flat'
  hit: boolean
  score: number
  brier: number
}

export interface NextExpiryStatsResponse {
  ok: boolean
  error?: string
  total: number
  pending: number
  /** per (asset, expiry) honesty records */
  records: {
    asset: string
    expiry: number
    n: number
    hitRate: number
    brier: number
    streak: number
  }[]
  /** universe-wide per-expiry summary - which rung of the ladder actually
   * pays across every pair the oracle has resolved */
  expirySummary: {
    expiry: number
    n: number
    hitRate: number
    brier: number
  }[]
  /** learned per-driver win-rate multipliers keyed by String(expiry) */
  driverWeightMultipliers: Record<string, Record<string, number>>
  recent: ExpiryRecentResolution[]
}

export async function getNextExpiry(asset: string): Promise<{ ok: boolean; prediction?: NextExpiryPrediction; error?: string }> {
  return osGet('/next_expiry', { asset })
}

export async function getNextExpiryStats(): Promise<NextExpiryStatsResponse> {
  return osGet('/next_expiry_stats', {})
}

/** One row of the Next Global board - the oracle's fused read for one
 * instrument, whole-universe scan (plugins/nextcandle.ts's GlobalScanRow). */
export interface NextGlobalRow {
  asset: string
  tf: string
  computedTs: number
  targetBarTime: number
  ok: boolean
  note: string
  pUp: number
  direction: 'call' | 'put' | 'none'
  confidence: number
  rawConfidence: number
  regime: string
  price: number
  expectedMove: number
  atr: number
  driversActive: number
  calibration: { n: number; hitRate: number; brier: number } | null
  /** passthrough of this row's own Momentum Score read (see
   * analytics/momentumscore.ts) - computed alongside the fused oracle read
   * above in the same backend call, not a second fetch. Global Dom reuses
   * this same row shape filtered to momentumDomination === true. */
  momentumDirection?: 'call' | 'put' | 'none' | null
  momentumScore?: number | null
  momentumDomination?: boolean
  momentumExpectedCandleType?: string | null
  /** "who fully has control right now" - buy/sell transaction-pressure
   * dominance (analytics/orderflow.ts), NOT a direction prediction. Global
   * Dom filters/sorts on controlFullControl/controlDominance, not the
   * momentum fields above - see domGlobalScan()'s own doc comment. */
  controlDirection?: 'buy' | 'sell' | 'none' | null
  controlDominance?: number | null
  controlFullControl?: boolean
  controlNote?: string | null
}

export interface NextGlobalResponse {
  ok: boolean
  error?: string
  tf: string
  scannedTs: number
  universe: number
  scanned: number
  live: number
  warming: number
  refreshed: number
  rows: NextGlobalRow[]
}

export async function getNextGlobal(
  tf: Timeframe,
  opts?: { limit?: number; category?: string; refresh?: boolean },
): Promise<NextGlobalResponse> {
  return osGet('/next_global', { tf, limit: opts?.limit, category: opts?.category, refresh: opts?.refresh ? 1 : undefined })
}

/** Global Dom - the whole universe filtered to pairs whose Momentum Score
 * is in full domination right now (plugins/nextcandle.ts's domGlobalScan(),
 * backed by /dom_global). Shares Next Global's TTL-cached rows, so polling
 * this costs nothing extra; rows use the same shape as NextGlobalRow. */
export interface DomGlobalResponse {
  ok: boolean
  error?: string
  tf: string
  scannedTs: number
  universe: number
  scanned: number
  dominating: number
  refreshed: number
  rows: NextGlobalRow[]
}

export async function getDomGlobal(
  tf: Timeframe,
  opts?: { limit?: number; category?: string; refresh?: boolean },
): Promise<DomGlobalResponse> {
  return osGet('/dom_global', { tf, limit: opts?.limit, category: opts?.category, refresh: opts?.refresh ? 1 : undefined })
}

// ---------- Tempo (analytics/tempo.ts, plugins/tempo.ts) ----------
// The "patience" engine: a shared 10-bar hunting window per asset:tf, one
// shot fired at the single most-convicted bar in that window (or none, if
// nothing clears the patience bar) - optimal-stopping on the oracle's own
// per-bar conviction trace rather than trading every qualifying bar.

export interface TempoFiredSignal {
  direction: 'call' | 'put'
  pUp: number
  confidence: number
  conviction: number
  threshold: number
  price: number
  targetBarTime: number
  ts: number
  reason: string
}

export interface TempoRow {
  asset: string
  tf: string
  ok: boolean
  note: string
  windowIdx: number
  barIndex: number
  barsRemaining: number
  /** wall-clock ms when the window closes (the license expires) */
  windowEndsAt: number
  conviction: number
  threshold: number
  patienceBar: number
  /** fire = the shot is live and unclaimed; done = license spent; wait/skip = not this bar */
  decision: 'fire' | 'wait' | 'skip' | 'done'
  decisionReason: string
  fired: boolean
  firedSignal: TempoFiredSignal | null
  bestConviction: number
  trace: { barTime: number; conviction: number; direction: 'call' | 'put' | 'none'; confidence: number; pUp: number }[]
  direction: 'call' | 'put' | 'none'
  pUp: number
  confidence: number
  price: number
  regime: string
  driversActive: number
  calibration: { n: number; hitRate: number; brier: number } | null
  lastShot: { direction: 'call' | 'put'; hit: boolean; conviction: number; resolvedTs: number } | null
  shotStats: { n: number; hitRate: number | null } | null
  /** signed Renko/Footprint votes nudging conviction (tempoCrossSignalMult())
   * - 0 when that driver wasn't active this bar. Passthrough of the
   * Oracle's own drivers, not a separate calculation. */
  renkoVote: number
  footprintVote: number
  /** plain-language candle-shape label, passthrough of the Oracle's own
   * classification. */
  expectedCandleType: string
}

export interface TempoScanResponse {
  ok: boolean
  error?: string
  tf: string
  ts: number
  /** the tf-wide window clock every pair shares (epoch-aligned windows) */
  window: { index: number; barIndex: number; barsRemaining: number; startedAt: number; endsAt: number }
  scanned: number
  live: number
  /** rows whose shot is live and unclaimed RIGHT NOW */
  firing: number
  windowsSpent: number
  windowsMissed: number
  rows: TempoRow[]
}

export async function getTempoScan(tf: Timeframe, opts?: { limit?: number }): Promise<TempoScanResponse> {
  return osGet('/tempo_scan', { tf, limit: opts?.limit })
}

/** One resolved Tempo shot (mini-services/trading-core/src/plugins/tempo.ts's
 * ResolvedShot). */
export interface TempoResolvedShot {
  asset: string
  tf: string
  windowIdx: number
  targetBarTime: number
  direction: 'call' | 'put'
  entry: number
  exit: number
  confidence: number
  conviction: number
  barIndex: number
  ts: number
  resolvedTs: number
  hit: boolean
  flat: boolean
}

export interface TempoStatsResponse {
  ok: boolean
  error?: string
  totalShots: number
  hits: number
  losses: number
  hitRate: number | null
  /** per-pair lifetime hit rate and the learned floor multiplier
   * pairAccuracyMult() is currently applying - mult > 1 means this pair's
   * lifetime hit rate reads below target and Tempo is dampening it; mult
   * === 1 means either healthy or still too thin (n<20) to judge.
   * callMult/putMult: the same dampening judged separately per direction
   * (min 12 of that direction's own resolved shots, else falls back to
   * the combined mult) - lets a pair that's fine on calls but weak on
   * puts (or vice versa) get dampened only on its actually-weak side. */
  pairAccuracy: { asset: string; tf: string; n: number; hitRate: number; mult: number; callMult: number; putMult: number }[]
  /** fleet-learned pairFloor() coefficient (searched against the resolved
   * shot ledger for whichever fraction of a pair's expected window-max
   * would have maximized net hit rate) - replaces the hand-set 0.35 once
   * there's enough resolved history (n>=40 fleet-wide) to trust one. */
  patienceCoeff: number
  recent: TempoResolvedShot[]
}

export async function getTempoStats(): Promise<TempoStatsResponse> {
  return osGet<TempoStatsResponse>('/tempo_stats', {})
}

// ---------- Accute (multi-model prediction fusion) ----------
// Used to be a strict "ADX/Pattern + Tempo + Oracle must all agree, and
// zone/renko must not disagree" confluence gate. Now a weighted log-odds
// fusion across up to 5 independent drivers (ADX/Pattern, Tempo, the
// Next-Candle Oracle, the support/resistance zone, Renko trend), the same
// shape the Next-Candle Oracle itself produces - a continuous pUp/
// confidence/direction prediction, not a unanimous-agreement requirement.
// See mini-services/trading-core/src/analytics/accute.ts for the fusion
// and src/plugins/accute.ts for the live engine.

export type AccuteDirection = 'call' | 'put' | 'none'
export type AccuteDriverName = 'adxPattern' | 'tempo' | 'oracle' | 'zone' | 'renko'

export interface AccuteDriver {
  name: AccuteDriverName
  pUp: number
  weight: number
  vote: number
  label: string
}

/** Self-adaptive confidence gate read-out: this exact pair+timeframe+
 * session+regime bucket's own learned adjustment (or the hand-set macro
 * volatility bump / default floor, below the bucket's own sample floor).
 * The only thing left that can force a fused prediction to WAITING - see
 * mini-services/trading-core/src/plugins/accute.ts's adaptiveAdjustment()
 * for the graduated fallback and override rule. */
export interface AccuteAdaptive {
  bucket: string
  session: string
  regime: string
  n: number
  hitRate: number | null
  minConfidenceUsed: number
  overridden: boolean
  note: string
}

/** Support/resistance + buy-zone/sell-zone read (analytics/structure.ts's
 * trendPullbackSeries / rangeZoneSeries): 'trend' = a trending structure's
 * own support/resistance pullback, 'range' = a ranging channel's own buy/
 * sell zone, 'none' = price isn't currently in a recognized zone at all.
 * Feeds the fusion as a driver only while `side` is 'buy'/'sell' - see
 * plugins/accute.ts's zoneRead(). */
export interface AccuteZone {
  source: 'trend' | 'range' | 'none'
  side: 'buy' | 'sell' | 'none'
  strength: number
  label: string
}

/** Current Renko brick trend (analytics/renko.ts's renkoBricks(), the same
 * engine of record the Renko + Footprint panel/strategies use). Feeds the
 * fusion as a driver only while `trend` is 'up'/'down' - see
 * plugins/accute.ts's renkoRead(). */
export interface AccuteRenko {
  trend: 'up' | 'down' | 'none'
  streak: number
  brickSize: number
  label: string
}

export interface AccuteSignal {
  asset: string
  tf: string
  ok: boolean
  note: string
  direction: AccuteDirection
  waiting: boolean
  summary: string
  /** fused probability of the next window resolving 'up' - 0.5 = no lean. */
  pUp: number
  /** 0-100, the fused prediction's own confidence. */
  confidence: number
  /** every driver that had a nonzero weight this bar (up to 5). */
  drivers: AccuteDriver[]
  driversActive: number
  /** share of the active weight agreeing with the winning side, 0..1. */
  agreement: number
  price: number
  targetBarTime: number
  computedTs: number
  calibration: { n: number; hitRate: number } | null
  adaptive: AccuteAdaptive
  zone: AccuteZone
  renko: AccuteRenko
}

export async function getAccute(asset: string, tf: Timeframe, opts?: { minConfidence?: number }): Promise<{ ok: boolean; error?: string; signal?: AccuteSignal }> {
  return osGet('/accute', { asset, tf, minConfidence: opts?.minConfidence })
}

export interface AccuteScanResponse {
  ok: boolean
  error?: string
  tf: string
  scannedTs: number
  universe: number
  scanned: number
  /** rows with a non-'none' fused direction */
  agreeing: number
  rows: AccuteSignal[]
}

export async function getAccuteScan(tf: Timeframe, opts?: { limit?: number; refresh?: boolean }): Promise<AccuteScanResponse> {
  return osGet('/accute_scan', { tf, limit: opts?.limit, refresh: opts?.refresh ? 1 : undefined })
}

export interface AccuteStatsResponse {
  ok: boolean
  error?: string
  total: number
  pending: number
  hitRate: number | null
  records: { asset: string; tf: string; n: number; hitRate: number }[]
  /** session+regime bucket breakdown for buckets with enough samples to be
   * trusted (same floor the adaptive gate itself uses) - worst hit rate
   * first, so a dampened pair/session/regime combo is easy to spot. */
  buckets: { bucket: string; n: number; hitRate: number }[]
  recent: {
    asset: string
    tf: string
    targetBarTime: number
    issuedTs: number
    resolvedTs: number
    direction: 'call' | 'put'
    entry: number
    exit: number
    actual: 'up' | 'down' | 'flat'
    hit: boolean
  }[]
}

export async function getAccuteStats(): Promise<AccuteStatsResponse> {
  return osGet<AccuteStatsResponse>('/accute_stats', {})
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

// ---------- tradeability: single combined readout ----------

export interface TradeabilityResult {
  ok: boolean
  asset: string
  tf: Timeframe
  strategy: string | null
  verdict: 'favorable' | 'caution' | 'avoid' | 'inconclusive'
  score: number
  reason: string
  structure: {
    state: 'detected' | 'none'
    hurst: number
    hurstNote: string
    acfMaxAbs: number
    acfSignificance: number
    markovRegime: string
    markovEntropy: number
    markovTrendiness: number
  }
  randomness: {
    state: 'normal' | 'fat_tailed' | 'unknown'
    excessKurtosis: number
    stdDevReturns: number
    meanAbsStep: number
    n: number
    dataSource: 'tick' | 'candle'
  }
  guard: {
    state: 'edge' | 'weak' | 'no_edge' | 'inconclusive' | 'not_tested' | 'skipped'
    isOtc: boolean
    strategy: string | null
    detail: {
      ok: boolean
      asset: string
      strategyKey: string
      isOtc: boolean
      policy: OtcPolicy
      verdict: { verdict: OtcVerdictClass; edgeZ: number; realWinRate: number; realTrades: number; placeboWrMean: number; placeboSeries: number; calibrationSource: 'tick' | 'candle'; ts: number } | null
    } | null
  }
}

export async function getTradeability(asset: string, tf: Timeframe, strategy?: string | null): Promise<TradeabilityResult> {
  return osGet<TradeabilityResult>('/tradeability', { asset, tf, strategy: strategy ?? undefined })
}

// ---------- soak report: supervised paper-trading diagnostics ----------

export interface SoakReport {
  ok: boolean
  sinceMs: number
  sinceTs: number
  generatedAt: number
  alertsInWindow: number
  trades: {
    dataAvailable: boolean
    total: number
    nonAutoTraderPositions: number
    byMode: { paper: number; live: number }
    byOutcome: { won: number; lost: number; push: number; open: number; closed: number }
    bySource: Record<string, number>
  }
  settlement: {
    dataAvailable: boolean
    stillAwaitingIqConfirmationCount: number
    recentStillAwaiting: AlertRow[]
    stuckOpenPositions: { id: string; asset: string; settlesAt?: number; secondsPastExpiry: number }[]
    noBrokerOrderIdSettledCount: number
    iqSessionLostCount: number
    brokerLookupFailingCount: number
    errorAlertCount: number
  }
  otcGuard: {
    dataAvailable: boolean
    policy: OtcPolicy
    blockedCount: number
    consultedCount: number | null
    consultedCountAvailable: boolean
    consultedCountNote: string
    verdictRunsInWindow: number
    verdictsByResult: { robust: number; weak: number; failed: number }
  }
  chartsignals:
    | { dataAvailable: true; tradeCount: number; samples: number; avgAgree: number; avgTotal: number; avgAgreePct: number }
    | { dataAvailable: false; tradeCount: number; note: string }
  standdowns: { reason: string; count: number }[]
}

/** sinceMs: how far back to summarize (default 24h). */
export async function getSoakReport(sinceMs = 24 * 60 * 60 * 1000): Promise<SoakReport> {
  return osGet<SoakReport>('/soak_report', { sinceMs })
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
  /** Ignore the (then normally empty) watchlist entirely and hunt the WHOLE
   * open universe instead, via the Next Global board (plugins/autopilot.ts's
   * sweepers path) - one fused read per open pair, ranked by tradability,
   * same strategy/tf/risk gates applied market-wide instead of pinned to a
   * fixed pair list. undefined/false = normal watchlist-only behavior. */
  universeSweep?: boolean
  /** universeSweep bots only: how many trades to take off the Next Global
   * board per bar, at most (1-10, default 1) - the board is ranked by
   * tradability so this takes the top N qualifying rows, not a random N. */
  sweepMaxTrades?: number
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
    /** Caps how many times onComplete:'reseed' auto-starts a fresh cycle.
     * undefined = unlimited (reseeds forever until a loss or a manual
     * restart). Set = after this many auto-reseeds the bot halts instead. */
    reseedLimit?: number
    /** Only when stopOnLoss is false ("On loss: Re-seed"). Caps how many
     * LOSSES IN A ROW the bot will silently re-seed through before being
     * forced to stop (halted, same as stopOnLoss:true). undefined =
     * unlimited. Resets to 0 on the next win. */
    lossReseedLimit?: number
  }
  planState?: { pot: number; rollN: number; restarts: number; reseedCount?: number; lossReseedCount?: number; halted?: boolean; complete?: boolean }
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
  reseedCount: number
  lossReseedCount: number
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

/** Mirror of trading-core's analytics/patterns.ts CANDLE_PATTERN_NAMES - every
 * pattern name the backend's detectors can produce, for the AI Lab's manual
 * "custom candlestick pattern" picker (replacing the old free-text input).
 * Kept here in sync by hand, same convention as BINARY_EXPIRY_MINUTES. */
export const CANDLE_PATTERN_NAMES: string[] = [
  'Doji', 'Hammer', 'Inverted Hammer', 'Shooting Star', 'Hanging Man',
  'Bullish Engulfing', 'Bearish Engulfing', 'Morning Star', 'Evening Star',
  'Three White Soldiers', 'Three Black Crows', 'Piercing Line', 'Dark Cloud Cover',
  'Tweezer Bottom', 'Tweezer Top', 'Bullish Marubozu', 'Bearish Marubozu',
  'Inside Bar', 'Bullish Outside Bar', 'Bearish Outside Bar',
  'Bullish Harami', 'Bearish Harami', 'Harami Cross',
  'Three Inside Up', 'Three Inside Down', 'Three Outside Up', 'Three Outside Down',
  'Morning Doji Star', 'Evening Doji Star', 'Rising Three Methods', 'Falling Three Methods',
  'Homing Pigeon', 'Matching Low', 'Stick Sandwich',
  'Bullish Separating Lines', 'Bearish Separating Lines',
  'Abandoned Baby (Bull)', 'Abandoned Baby (Bear)',
  'Bullish Kicker', 'Bearish Kicker', 'Spinning Top', 'High Wave',
  'Dragonfly Doji', 'Gravestone Doji', 'Long-Legged Doji',
  'Bullish Belt Hold', 'Bearish Belt Hold',
  'Bullish Three Line Strike', 'Bearish Three Line Strike',
  'Two Crows', 'Upside Gap Two Crows',
  'Advance Block', 'Deliberation',
  'Concealing Baby Swallow', 'Ladder Bottom',
  'Bullish Tri-Star', 'Bearish Tri-Star',
  'Unique Three River Bottom',
  'On-Neck Line', 'In-Neck Line', 'Thrusting Line',
  'Bullish Side-by-Side White Lines', 'Bearish Side-by-Side White Lines',
  'Bullish Hikkake', 'Bearish Hikkake',
  'Bullish Breakaway', 'Bearish Breakaway',
]

export type LabSignalDef =
  | { kind: 'candle'; name: string; series?: 'bar' | 'heikin'; dir: 'call' | 'put'; weight: number }
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
      return s.series === 'heikin' ? `${s.name} (HA)` : s.name
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
  /** Meta-Strategy Lab's own script language (MSL), addressing this spec's
   * signal vocabulary via strategies/signalscript.ts's resolver functions
   * (candle/bar/ha/line/renko/pf/indicator/mtf/builtinSig/engine) instead
   * of `signals`. Wins over signals[] when present - same convention
   * MetaStrategySpec's own script field uses. */
  script?: string
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
  reseedLimit?: number
  lossReseedLimit?: number
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
  signalSource: 'cointegration' | 'triangulation' | 'adx-pattern-bias' | 'pair-signal' | 'shock-pressure' | 'poc-triple-confirm' | 'oracle-fusion' | 'tempo' | 'accute' | 'strategy' | 'chartsignals' | 'leadlag' | 'meta-strategy'
  tf: Timeframe
  /** The trade's own expiry, as a timeframe - SEPARATE from `tf` (which
   * candles signals are read from). Unset = old behavior (expiry tracks tf
   * 1:1, i.e. exactly one bar). Set to decouple them, e.g. read signals on
   * '1m' but let each trade run '5m' before it settles. */
  expiryTf?: Timeframe
  /** Instrument type to trade. Undefined/unset = 'binary' (the historical
   * behavior). 'blitz'/'digital' settle on `expirySec` instead of
   * expiryTf's bar math; 'turbo' reuses expiryTf/bars exactly like binary;
   * 'cfd' has no expiry at all (tp/sl-based). */
  kind?: TradeKind
  /** Explicit wall-clock expiry in seconds - only read for kind 'blitz'
   * (1-60s) or 'digital' (60-86400s). Undefined = kind default (15s blitz,
   * 300s digital). */
  expirySec?: number
  stake: number
  minScore: number
  minConfidence: number
  cointegrationZEntry: number
  cointegrationMaxHalfLife: number
  triangulationZEntry: number
  /** strategy source: id from the combined Strategy Lab catalog (builtin id,
   * or "custom:<id>" for an AI Lab-learned spec) - same as a bot's strategyId.
   * @deprecated superseded by strategyIds; kept for older saved configs. */
  strategyId?: string
  /** meta-strategy source: which saved panel-combinator spec (id
   * "meta:<slug>") to trade - see the Meta-Strategy panel/section above. */
  metaStrategyId?: string
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
  planState?: { pot: number; rollN: number; restarts: number; reseedCount?: number; lossReseedCount?: number; halted: boolean; complete: boolean }
}

// ---------- Meta Trader (plugins/metatrader.ts) ----------
// "Like the auto-trader, but without its frictions" per direct instruction:
// one flat stake, no cooldown/pacing/payout-floor/vol-gate/OTC-guard/daily-
// limits/streak-breaker - the one quality gate it keeps is Min confidence.
// Still fully subject to the kill switch/risk manager (ExecutionService
// enforces those for every caller) and to the same global OS mode switch
// the auto-trader and bots obey.

export type MetaTraderSource =
  | 'meta-strategy'
  | 'oracle'
  | 'accute'
  | 'smc'
  | 'smc-fvg'
  | 'smc-ifvg'
  | 'smc-order-block'
  | 'smc-breaker-block'
  | 'smc-liquidity-sweep'
  | 'smc-bos'
  | 'smc-choch'
  | 'smc-ote'
  | 'smc-krm'
  | 'smc-supply-demand'
  | 'smc-support-resistance'
  | 'smc-breakout'
  | 'smc-crt'
  | 'smc-power-of-3'
  | 'smc-silver-bullet'
  | 'renko-smc'
  | 'renko-smc-majority'

/** Every Meta Trader signal source, in the same order the kernel's own
 * META_TRADER_SOURCES array lists them (plugins/metatrader.ts) - exported
 * here so any panel (AutopilotPanel's picker, MetaStrategyPanel's "all
 * strats" list) can enumerate them without duplicating the list. */
export const ALL_META_TRADER_SOURCES: readonly MetaTraderSource[] = [
  'meta-strategy',
  'oracle',
  'accute',
  'smc',
  'smc-fvg',
  'smc-ifvg',
  'smc-order-block',
  'smc-breaker-block',
  'smc-liquidity-sweep',
  'smc-bos',
  'smc-choch',
  'smc-ote',
  'smc-krm',
  'smc-supply-demand',
  'smc-support-resistance',
  'smc-breakout',
  'smc-crt',
  'smc-power-of-3',
  'smc-silver-bullet',
  'renko-smc',
  'renko-smc-majority',
]

export const META_TRADER_SOURCE_LABELS: Record<MetaTraderSource, string> = {
  'meta-strategy': 'Meta-Strategy',
  oracle: 'Oracle',
  accute: 'Accute',
  smc: 'SMC (now)',
  'smc-fvg': 'SMC: FVG',
  'smc-ifvg': 'SMC: IFVG',
  'smc-order-block': 'SMC: Order Block',
  'smc-breaker-block': 'SMC: Breaker Block',
  'smc-liquidity-sweep': 'SMC: Liquidity Sweep',
  'smc-bos': 'SMC: BOS',
  'smc-choch': 'SMC: CHoCH',
  'smc-ote': 'SMC: OTE',
  'smc-krm': 'SMC: KRM',
  'smc-supply-demand': 'SMC: Supply & Demand',
  'smc-support-resistance': 'SMC: Support & Resistance',
  'smc-breakout': 'SMC: Breakout',
  'smc-crt': 'SMC: CRT',
  'smc-power-of-3': 'SMC: Power of 3',
  'smc-silver-bullet': 'SMC: Silver Bullet',
  'renko-smc': 'Renko + SMC confluence (any agrees)',
  'renko-smc-majority': 'Renko + SMC confluence (majority)',
}

export interface MetaStakePlan {
  kind: 'compound'
  base: number
  rollPct?: number
  payoutCap?: number
  stopOnLoss?: boolean
}

export interface MetaTraderConfig {
  enabled: boolean
  signalSource: MetaTraderSource
  /** only meaningful when signalSource === 'meta-strategy'. */
  metaStrategyId?: string
  tf: Timeframe
  direction: 'call' | 'put' | 'both'
  minConfidence: number
  stake: number
  maxOpen: number
  kind: TradeKind
  /** trade's own expiry as a timeframe, separate from `tf` - undefined
   * tracks `tf` 1:1 (1 bar). Only meaningful for binary/turbo. */
  expiryTf?: Timeframe
  /** wall-clock expiry in seconds - only read for kind 'blitz'/'digital'. */
  expirySec?: number
  marketScope: 'all' | 'real' | 'otc'
  /** per-asset cooldown in seconds after a placed trade - no hard floor. */
  cooldownSec: number
  stakePlan?: MetaStakePlan
}

export interface MetaTraderRuntime {
  trades: number
  wins: number
  losses: number
  pnlTotal: number
  openCount: number
  lastTradeTs: number
  lastAction?: string
  lastRejection?: string
  pot: number
  rollN: number
  halted: boolean
}

export interface MetaTraderStatus {
  enabled: boolean
  mode: OsMode
  active: boolean
  config: MetaTraderConfig
  runtime: MetaTraderRuntime
  sources: readonly MetaTraderSource[]
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
    /** Edge memory of the ACTIVE signal source (kernel epoch-SECOND stamps):
     * the already-true conditions the trader is refusing to act on. cold = the
     * first sweep after an arm hasn't run yet (it records, never trades).
     * held/screenerHeld rows carry when the hold started and why (backfilled at
     * arm vs consumed by an executed trade). 'strategy' keeps no memory. */
    edges?: {
      source: string
      cold: boolean
      held: Array<{ asset: string; dir: string; origin: 'backfill' | 'executed'; since: number }>
      screenerHeld: Array<{ asset: string; dir: string; origin: 'backfill' | 'executed'; since: number }>
    }
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

// ---------- AI Trader (LLM-reasoned opportunity-scan trader) ----------
// "its like having meta or auto trader with brains" per direct instruction -
// unlike every other auto-trader here, it decides with actual LLM reasoning
// over a snapshot of the same panel reads the fixed-rule traders use, on a
// timer (default every 10min) rather than every candle close. Starts in
// SHADOW mode (live:false) by direct instruction - logs every decision
// including skips, places nothing real until explicitly flipped live.
export type AiTraderScanMode = 'single' | 'selected' | 'global'

export interface AiTraderConfig {
  enabled: boolean
  live: boolean
  /** 'single' - only ever scans `asset`. 'selected' - scans
   *  `selectedAssets`. 'global' - scans whatever the Screener currently
   *  ranks as the best opportunities across the whole instrument universe. */
  scanMode: AiTraderScanMode
  asset: string
  selectedAssets: string[]
  tf: Timeframe
  intervalMin: number
  stake: number
  kind: TradeKind
  minConfidence: number
  expiryChoices: number[]
  /** Max OPEN positions this trader may hold at once - enforced in LIVE
   *  mode only. At the cap, a cycle skips entirely (no analysis, no LLM
   *  call) rather than deciding something it has no room to act on. */
  maxConcurrent: number
  /** Hard ceiling on how many assets get analyzed in ONE cycle under
   *  'selected'/'global' (and the live concurrency budget is clamped to
   *  this too). Always 1 for 'single'. */
  maxScanPerCycle: number
  provider?: string
  /** Base URL of THIS Next.js app, as trading-core (a separate process)
   * reaches it - the AI Trader's decision calls go through this app's
   * /api/ai_trader_decide first (same chatComplete the Copilot already
   * uses, same keys, nothing extra to configure), falling back to trading-
   * core's own .env only if this app is unreachable. Default localhost:3000. */
  appUrl?: string
}

export interface AiTraderStatus {
  config: AiTraderConfig
  enabled: boolean
  live: boolean
  running: boolean
  cycles: number
  lastRunTs: number
  nextRunTs: number | null
  lastError: string | null
  /** The app URL a cycle will ACTUALLY call right now, after APP_URL env /
   * saved config / default resolution - shown directly so there's nothing
   * to guess about which one is in effect. */
  resolvedAppUrl: string
  llm: {
    order: string[]
    providers: { id: string; enabled: boolean; ready: boolean; model: string }[]
  }
}

export interface AiTraderDecision {
  id: number
  asset: string
  tf: string
  direction: 'call' | 'put' | 'skip'
  confidence: number
  expiryMin: number | null
  reasoning: string
  snapshot: { source: string; direction: string; confidence: number; label: string }[]
  live: boolean
  acted: boolean
  positionId: string | null
  provider: string | null
  model: string | null
  error: string | null
  ts: number
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

/** "invoke the ai and describe it so it will build the strat... if any
 * error, we can have the ai scan and fix" per direct instruction - backs
 * every code editor's shared "AI" bar (CodeAssistBar.tsx). This hits this
 * NEXT.JS APP's own /api/code_assist route directly (like /api/agent),
 * NOT the kernel via osPost - it calls the LLM layer in src/lib/llm, which
 * only runs server-side here, not in trading-core. */
export type CodeAssistKind = 'msl' | 'ai_lab_script' | 'builtin_strategy_ts' | 'meta_source_ts'

export interface CodeAssistResult {
  ok: boolean
  code?: string
  explanation?: string
  provider?: string
  model?: string
  error?: string
}

export async function codeAssist(input: {
  kind: CodeAssistKind
  mode: 'build' | 'fix'
  instruction?: string
  currentCode?: string
  error?: string
  context?: Record<string, string | number | undefined>
}): Promise<CodeAssistResult> {
  const res = await fetch('/api/code_assist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    cache: 'no-store',
  })
  const body = (await res.json().catch(() => ({ ok: false, error: `request failed: ${res.status}` }))) as CodeAssistResult
  return body
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
