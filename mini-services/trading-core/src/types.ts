// IQAIR//OS - Kernel type system
// Shared across every plugin: market data, analytics, strategies, execution, agent.

export type Timeframe = '5s' | '15s' | '30s' | '1m' | '2m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d'

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

export const ALL_TIMEFRAMES: Timeframe[] = ['5s', '15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d']

/** Timeframes suitable for options expiry sizing (short TFs). */
export const OPTION_TFS: Timeframe[] = ['5s', '15s', '30s', '1m', '2m', '5m', '15m']
/** Timeframes typical for CFD swing charting. */
export const CFD_TFS: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']

export interface Candle {
  time: number // epoch seconds, candle open time
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type AssetCategory = 'forex' | 'crypto' | 'commodity' | 'stock' | 'index'

export interface AssetInfo {
  ticker: string
  name: string
  category: AssetCategory
  otc?: boolean // OTC weekend variant (24/7, higher payout)
  basePrice: number
  pip: number // price rounding digits
  volatility: number // per-second sigma scale for the sim engine
  payout: number // binary payout, e.g. 0.85 => +85% on win
  turboPayout?: number
  digitalPayout?: number
  leverage?: number // CFD max leverage
  schedule?: '24/7' | '24/5' | 'market' // market = exchange hours
  open: boolean
  iqairName?: string // live IQ Option instrument id (defaults to ticker)
}

export type MarketMode = 'sim' | 'live'

export type Side = 'call' | 'put'
export type TradeKind = 'binary' | 'turbo' | 'digital' | 'cfd'

/** Trade kinds a given instrument supports. */
export const CATEGORY_KINDS: Record<AssetCategory, TradeKind[]> = {
  forex: ['binary', 'turbo', 'digital', 'cfd'],
  crypto: ['binary', 'turbo', 'digital', 'cfd'],
  commodity: ['binary', 'turbo', 'digital', 'cfd'],
  stock: ['binary', 'turbo', 'digital', 'cfd'],
  index: ['binary', 'turbo', 'digital', 'cfd'],
}

export const TRADE_KIND_LABEL: Record<TradeKind, string> = {
  binary: 'Binary',
  turbo: 'Turbo',
  digital: 'Digital',
  cfd: 'CFD',
}
export type TradeMode = 'paper' | 'live'
export type TradeStatus = 'open' | 'won' | 'lost' | 'closed'

export interface Position {
  id: string
  tsOpen: number
  tsClose?: number
  asset: string
  tf: Timeframe
  side: Side
  kind: TradeKind
  mode: TradeMode
  amount: number
  expiryBars: number
  entryPrice: number
  exitPrice?: number
  leverage?: number
  tp?: number
  sl?: number
  payout: number
  pnl?: number
  status: TradeStatus
  strategy?: string
  note?: string
  liveOrderId?: string
  settlesAt?: number // epoch seconds when binary/turbo/digital expires
  strike?: number // digital options strike
  expirySec?: number // digital expiry in seconds (5m/15m)
}

export interface AccountState {
  balance: number
  startBalance: number
  mode: MarketMode
  balanceMode: string // PRACTICE / REAL (live)
  dayKey: string
  dayStartBalance: number
  dayPnl: number
  totalPnl: number
  killSwitch: boolean
  openPositions: number
}

// ---------- Analytics ----------

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

export type Direction = 'call' | 'put' | 'none'

export interface Factor {
  name: string
  group: 'trend' | 'momentum' | 'mean-reversion' | 'volatility' | 'statistical' | 'patterns'
  value: number // raw value (display)
  vote: number // -2..+2
  weight: number
  note: string
}

export interface CompositeSignal {
  asset: string
  tf: Timeframe
  ts: number
  price: number
  score: number // -100..100
  direction: Direction
  confidence: number // 0..100
  factors: Factor[]
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
  atrPct: number // ATR / price * 100
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

export interface PatternHit {
  name: string
  direction: 'bullish' | 'bearish' | 'neutral'
  reliability: 1 | 2 | 3
  barsAgo: number
  note: string
}

export interface MarkovResult {
  states: string[]
  matrix: number[][] // transition probabilities
  counts: number[][]
  stationary: number[] // long-run distribution
  lastState: number
  nextStateProbs: number[]
  probUp: number // aggregate P(next move is up), incl. big up
  probDown: number
  probFlat: number
  expectedReturn: number // E[r_{t+1}] estimated from state means
  trendiness: number // P(up|up) + P(down|down) - P(up|down) - P(down|up), 0..1
  entropy: number // Shannon entropy of next-step distribution (0..1, normalized)
  regime: 'bull' | 'bear' | 'range' | 'chop'
  sampleSize: number
}

export interface MonteCarloResult {
  paths: number[][] // sample paths (20 x horizon)
  horizon: number
  nSims: number
  p5: number
  p25: number
  median: number
  p75: number
  p95: number
  probUp: number
  expectedReturn: number
  var95: number // value at risk (positive fraction of price)
  cvar95: number
  maxDrawdownExpected: number
}

export interface QuantStats {
  hurst: number
  hurstNote: string
  acf: number[] // autocorrelation lags 1..N of returns
  acfSignificance: number
  ewmaVol: number // per-candle vol
  garchVol: number
  annualizedVol: number
  zScore: number
  zScorePeriod: number
  linreg: { slope: number; r2: number; upper: number; mid: number; lower: number }
  dailyVol: number
  sharpe: number // per-candle annualized estimate
  skew: number
  kurtosis: number
}

export interface SRZone {
  price: number
  touches: number
  type: 'support' | 'resistance'
  strength: number // 0..1
}

// ---------- Kalman filter + Ornstein-Uhlenbeck mean reversion ----------

/** OLS fit of the discretized OU process (an AR(1)) over a rolling window. */
export interface OUParams {
  theta: number // long-run equilibrium level the process reverts to
  phi: number // per-bar persistence e^{-kappa}
  kappa: number // mean-reversion speed per bar
  sigmaEps: number // AR(1) innovation std (price units)
  sigmaEq: number // stationary std: sigma_eps / sqrt(1 - phi^2)
  halfLifeBars: number // ln(2)/kappa, capped at 9999 (JSON-safe)
  r2: number // AR(1) regression fit quality
  tStat: number // significance of reversion: (1 - b)/se(b)
  sample: number // pairs used in the fit
}

/** Live OU state for one bar (cheap path used by the screener). */
export interface OULive extends OUParams {
  z: number // (price - theta) / sigma_eq
  meanReverting: boolean
  state: 'stretched-below' | 'stretched-above' | 'neutral'
  signal: 'call' | 'put' | 'none'
  score: number
  note: string
}

/** Per-bar OU + Kalman series, full-length and NaN before warmup. */
export interface OUSeries {
  filtered: number[] // Kalman fair-value estimate of the latent level
  theta: number[] // rolling OU equilibrium
  upper: number[] // theta + zMult * sigma_eq
  lower: number[] // theta - zMult * sigma_eq
  z: number[] // stretch of price from theta in stationary sigmas
  innovationZ: number[] // standardized Kalman innovations
}

/** Full model output: live state + filter series for the UI. */
export interface KalmanOUResult extends OULive {
  window: number
  zMult: number
  innovationZ: number // last standardized Kalman innovation
  zSeries: (number | null)[] // stretch history (last 240 bars)
}

export interface AnalysisResult {
  asset: string
  tf: Timeframe
  ts: number
  price: number
  changePct: number // vs 24 candles ago
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
  /** Number of indicators available in the full registry (UI display). */
  registrySize?: number
  patterns: PatternHit[]
  markov: MarkovResult
  montecarlo: MonteCarloResult
  quant: QuantStats
  kalman: KalmanOUResult
  srZones: SRZone[]
  signal: CompositeSignal
}

// ---------- Strategies ----------

export interface StrategyParam {
  key: string
  label: string
  type: 'number' | 'select'
  min?: number
  max?: number
  step?: number
  options?: { value: string; label: string }[]
  default: number | string
}

export interface StrategyEval {
  direction: Direction
  score: number // -100..100
  notes: string
}

export interface StrategyDef {
  id: string
  name: string
  description: string
  params: StrategyParam[]
  evaluate: (candles: Candle[], params: Record<string, number | string>) => StrategyEval
}

export interface BacktestTrade {
  ts: number
  side: Side
  entry: number
  exit: number
  amount: number
  pnl: number
  status: 'won' | 'lost'
}

export interface BacktestResult {
  strategy: string
  asset: string
  tf: Timeframe
  mode: 'binary' | 'spot'
  params: Record<string, number | string>
  candlesTested: number
  trades: BacktestTrade[]
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
  }
}

// ---------- Indicator registry ----------

export type IndicatorCategory =
  | 'overlap'
  | 'momentum'
  | 'volume'
  | 'volatility'
  | 'trend'
  | 'cycle'
  | 'statistic'
  | 'patterns'

export interface IndicatorParamDef {
  key: string
  label: string
  type: 'number'
  min: number
  max: number
  step?: number
  default: number
}

export interface IndicatorLine {
  key: string
  color: string
  style?: 'solid' | 'dashed' | 'dotted'
  width?: 1 | 2
  values: number[]
}

export interface IndicatorOutput {
  lines: IndicatorLine[]
  /** optional histogram series (MACD hist, CMF...) */
  hist?: { values: number[]; color: 'updown' | string }
  /** horizontal reference levels (RSI 30/70 ...) */
  levels?: number[]
  /** signed +/- bands for oscillators */
  bands?: [number, number]
  /** fill area between two line indices (Bollinger, Keltner, Donchian) */
  fillBetween?: [number, number]
  note?: string
}

export interface IndicatorDef {
  id: string
  name: string
  category: IndicatorCategory
  pane: 'overlay' | 'sub'
  params: IndicatorParamDef[]
  description: string
  compute: (candles: Candle[], params: Record<string, number>) => IndicatorOutput
}

export interface IndicatorSeriesResponse {
  id: string
  name: string
  category: IndicatorCategory
  pane: 'overlay' | 'sub'
  params: Record<string, number>
  time: number[]
  lines: { key: string; color: string; style?: string; values: (number | null)[] }[]
  hist?: { values: (number | null)[]; color: string }[]
  levels?: number[]
  bands?: [number, number]
  fillBetween?: [number, number]
}

// ---------- Chart patterns ----------

export interface ChartPatternHit {
  name: string
  direction: 'bullish' | 'bearish' | 'neutral'
  startIndex: number
  endIndex: number
  confidence: number // 0..1
  note: string
}

// ---------- Events ----------

export interface BusEvents {
  tick: { asset: string; price: number; ts: number }
  candle: { asset: string; tf: Timeframe; candle: Candle; closed: boolean }
  signal: { asset: string; tf: Timeframe; signal: CompositeSignal }
  positionOpened: { position: Position }
  positionClosed: { position: Position }
  account: { account: AccountState }
  alert: { level: 'info' | 'warn' | 'danger' | 'success'; message: string; ts: number }
  broadcast: { event: string; payload: unknown }
}
