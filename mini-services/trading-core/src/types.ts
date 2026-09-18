// IQAIR//OS - Kernel type system
// Shared across every plugin: market data, analytics, strategies, execution, agent.

export type Timeframe = '5s' | '15s' | '1m' | '5m' | '15m'

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '5s': 5,
  '15s': 15,
  '1m': 60,
  '5m': 300,
  '15m': 900,
}

export const ALL_TIMEFRAMES: Timeframe[] = ['5s', '15s', '1m', '5m', '15m']

export interface Candle {
  time: number // epoch seconds, candle open time
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface AssetInfo {
  ticker: string
  name: string
  category: 'forex' | 'crypto' | 'commodity' | 'stock' | 'index'
  basePrice: number
  pip: number // price rounding digits
  volatility: number // per-second sigma scale for the sim engine
  payout: number // binary payout, e.g. 0.85 => +85% on win
  open: boolean
}

export type MarketMode = 'sim' | 'live'

export type Side = 'call' | 'put'
export type TradeKind = 'binary' | 'spot'
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
  settlesAt?: number // epoch seconds when binary expires
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
    bbUpper: { time: number; value: number }[]
    bbLower: { time: number; value: number }[]
    supertrend: { time: number; value: number; dir: number }[]
    vwap: { time: number; value: number }[]
  }
  patterns: PatternHit[]
  markov: MarkovResult
  montecarlo: MonteCarloResult
  quant: QuantStats
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
