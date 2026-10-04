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

export type ChartType = 'candles' | 'hollow' | 'heikin' | 'bars' | 'line' | 'area' | 'baseline' | 'renko'
export const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'candles', label: 'Candles' },
  { id: 'hollow', label: 'Hollow' },
  { id: 'heikin', label: 'Heikin Ashi' },
  { id: 'bars', label: 'Bars' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'baseline', label: 'Baseline' },
  { id: 'renko', label: 'Renko' },
]

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
  status: 'open' | 'won' | 'lost' | 'closed'
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
  params: { key: string; label: string; type: 'number' | 'select'; min?: number; max?: number; step?: number; options?: { value: string; label: string }[]; default: number | string }[]
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
      op: '>' | '<'
      threshold: number
      dir: 'call' | 'put'
      weight: number
    }
  | { kind: 'mtf'; factor: 5 | 15; dir: 'call' | 'put'; weight: number }

/** Port of trading-core's labelOf() (strategies/custom.ts) - same formatting,
 * kept in sync by hand since the two are separate deployables. Used to
 * display a human-readable name for both a measured LabSignalStat and a
 * template the user is about to add by hand in the manual strategy builder. */
export function labelOfSignal(s: LabSignalDef): string {
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
      const p = s.params ?? {}
      const pd = p.period ?? p.fast
      const tag = s.type ? `:${s.type}` : ''
      return `${s.ind}${tag}${Number.isFinite(pd) ? `(${pd})` : ''} ${s.op} ${s.threshold}`
    }
    case 'mtf':
      return `MTF ${s.factor}x Trend ${s.dir === 'call' ? 'Up' : 'Down'}`
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
  /** Per-strategy param overrides, keyed by strategy id - same shape as a
   * bot's own params. Ignored for an AI Lab "custom:<id>" spec. */
  strategyParams?: Record<string, Record<string, number | string>>
  direction: 'both' | 'call' | 'put'
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

const CORE_PORT = 3030

function qs(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams()
  usp.set('XTransformPort', String(CORE_PORT))
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) usp.set(k, String(v))
  }
  return usp.toString()
}

export async function osGet<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const clean = path.replace(/^\/+/, '')
  const res = await fetch(`/${clean}?${qs(params)}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`GET ${clean} failed: ${res.status}`)
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
  if (!res.ok) throw new Error(`POST ${clean} failed: ${res.status}`)
  return res.json() as Promise<T>
}

// ---------- socket feed ----------

export interface OSFeedHandlers {
  onTick?: (p: { asset: string; price: number; ts: number }) => void
  onCandle?: (p: { asset: string; tf: Timeframe; candle: Candle; closed: boolean }) => void
  onAccount?: (p: { account: AccountState }) => void
  onPositionClosed?: (p: { position: Position }) => void
  onAlert?: (p: AlertRow) => void
  onUi?: (p: { event: string; asset?: string }) => void
  onConnectChange?: (connected: boolean) => void
}

export function useOSFeed(asset: string, tf: Timeframe, handlers: OSFeedHandlers): void {
  const socketRef = useRef<Socket | null>(null)
  const handlersRef = useRef(handlers)

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
      socket.emit('subscribe', { asset, tf })
    })
    socket.on('disconnect', () => handlersRef.current.onConnectChange?.(false))
    socket.on('tick', (p) => handlersRef.current.onTick?.(p))
    socket.on('candle', (p) => handlersRef.current.onCandle?.(p))
    socket.on('account', (p) => handlersRef.current.onAccount?.(p))
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
