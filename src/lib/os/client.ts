'use client'

// IQAIR//OS - client runtime: REST client + socket feed + shared types
import { useEffect, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'

export type Timeframe = '5s' | '15s' | '1m' | '5m' | '15m'
export const TIMEFRAMES: Timeframe[] = ['5s', '15s', '1m', '5m', '15m']

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
  category: 'forex' | 'crypto' | 'commodity' | 'stock' | 'index'
  price: number
  payout: number
  open: boolean
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

export interface Position {
  id: string
  tsOpen: number
  tsClose?: number
  asset: string
  tf: Timeframe
  side: 'call' | 'put'
  kind: 'binary' | 'spot'
  mode: 'paper' | 'live'
  amount: number
  expiryBars: number
  entryPrice: number
  exitPrice?: number
  payout: number
  pnl?: number
  status: 'open' | 'won' | 'lost' | 'closed'
  strategy?: string
  settlesAt?: number
  tp?: number
  sl?: number
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
}

export interface RiskConfig {
  maxStake: number
  dailyLossLimit: number
  maxOpenPositions: number
  lossStreakCooldown: number
  cooldownSeconds: number
}

export interface StrategyInfo {
  id: string
  name: string
  description: string
  params: { key: string; label: string; type: 'number' | 'select'; min?: number; max?: number; step?: number; options?: { value: string; label: string }[]; default: number | string }[]
  defaults: Record<string, number | string>
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
  }
}

export interface AlertRow {
  level: 'info' | 'warn' | 'danger' | 'success'
  message: string
  ts: number
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
      transports: ['websocket', 'polling'],
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

export function fmtPrice(v: number, ticker?: string): string {
  const digits = ticker === 'USDJPY' ? 3 : ticker === 'EURUSD' || ticker === 'GBPUSD' ? 5 : v >= 1000 ? 1 : v >= 10 ? 2 : 4
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
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
