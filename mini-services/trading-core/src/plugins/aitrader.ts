// IQAIR//OS - AI Trader: "a meta/auto trader with brains," per direct
// request. Every other auto-trader in this codebase (the single Meta
// Trader, the autopilot bot fleet, Meta Strategy specs) decides with FIXED
// rules - indicator thresholds, panel-source votes, learned AI-Lab specs.
//
// This one is explicitly cast as the HUMAN at the desk, not another system
// alongside those - per direct instruction: "take all analysis, make yours,
// decide expiry, decide direction and whether to trade or not." The other
// auto-traders' panel reads (MetaStrategyService.snapshotSources -
// oracle/accute/smc/renko/pointFigure/rangeBars etc) are handed to it as a
// SECOND OPINION from "the desk," same as a real trader's own indicators -
// but the PRIMARY evidence is its own read of the raw recent candles,
// computed per-expiry-choice (see buildHorizonReads below) so the direction
// AND the expiry get decided together against that one specific holding
// period, not a generic longer-term bias. It can agree with the desk, it
// can override it, or it can conclude disagreement itself means skip - see
// the system prompt in runCycle() for exactly how that's framed to the
// model. On a timer rather than every candle close - the user's own framing
// was "6 trades an hour, roughly one every ~10 minutes, 3-5 min expiry,
// only when it sees a good opportunity" - so this is an opportunity-scan
// loop, not an edge-trigger dispatcher like the bots.
//
// Per direct instruction this starts in SHADOW mode by default (config.live
// = false): every cycle still runs the full snapshot -> LLM -> decision
// pipeline and logs the result (direction/confidence/expiry/reasoning),
// but no real order is placed until the operator explicitly flips `live`
// to true. An LLM's judgment can't be walk-forward validated the way a
// fixed rule can (same prompt, same weights, different day - no stable
// "edge" to even measure), so the honest trust-building path is: watch it
// decide for a while, read its reasoning, THEN let it touch money - never
// the "always forced, always live" treatment meta: specs get elsewhere in
// this codebase, which is appropriate there because that's a FIXED
// combinator the operator already built and chose to run; here the
// operator hasn't even seen a single decision yet.
//
// A live decision still goes through ExecutionService.placeOrder(), so the
// SAME risk manager (kill switch, daily loss limit, max stake, max
// concurrent positions, loss-streak cooldown, sentinel, market hours) gates
// it exactly like every other order in this system - there is no side door
// around that gate for this trader or any other.
//
// TICK DESK UPGRADE (per direct instruction "full tick chart analysis,
// footprint, OTC footprint, ... volume and so on" + "it should not be
// stale ... it should be volume aware"): the desk now carries two more
// seats - 17. the TICK DESK (tape freshness + the four tick-built engines:
// tick SMC, tick next-candle oracle, tick technical ladder, measured-print
// footprint with delta slope) and 18. the OTC velocity footprint (print
// speed ratios / stagnation / exhaustion) - plus a snapshotSources() grid
// that now spans EVERY chart type (renko/range/line/p&f/heiken ashi/IV-HV/
// volume bars/TPO and the four tick-desk reads). The system prompt makes
// the model staleness-aware (a STALE tape down-weights the tick reads) and
// volume-aware (measured print flow = the desk's real order-flow evidence).
//
// KNOWN GAP (documented, not silently skipped): the OTC defense guard
// (otcguard.ts) placebo-tests a fixed strategyKey against its own
// synthetic-feed calibration - there is no strategyKey here (a prompt
// isn't one), so OTC gating does not enforce against this trader's LLM
// read the way it does for a fixed spec. The desk briefing below DOES
// surface the guard's latest placebo verdict for the asset (and the plain
// isOtc flag) to the model every cycle, so an unverified OTC read is at
// least visible at the desk; the global risk manager's other gates still
// apply either way.

import type { Candle, Timeframe, TradeKind, Position } from '../types'
import type { KernelContext, Plugin } from '../kernel'
import { Store } from '../store'
import type { MarketDataService } from './market-data'
import type { ExecutionService } from './execution'
import type { MetaStrategyService } from './metastrategy'
import type { MetaSourceRead } from '../analytics/metastrategy'
import type { ScreenerService } from './screener'
import type { NextCandleService } from './nextcandle'
import type { NextExpiryService } from './nextexpiry'
import type { TempoService } from './tempo'
import type { Screener2Service } from './screener2'
import type { SmcScanService } from './smcscan'
import type { ChartSignalsService } from './chartsignals'
import type { LeadLagScanService } from './leadlagscan'
import type { VolArbScanService } from './volarbscan'
import type { CointegrationScanService } from './cointegrationscan'
import type { YesterdayService } from './yesterday'
import type { SentinelService } from './sentinel'
import type { MemoryGateService } from './memory-gate'
import type { OtcGuardService } from './otcguard'
import type { StrategyLabService } from './lab'
import type { OtcFootprintService } from './otcfootprint'
import type { ReversalService } from './reversal'
import type { TechnicalService } from './technical'
import type { AccuteService } from './accute'
import type { TickPoint } from '../analytics/otcfootprint'
import type { FootprintResult } from '../analytics/otcfootprint'
import { computeTickFootprint, computeTickOracle, computeTickSmc, computeTickTechnical, medianTickGapMs } from '../analytics/tickdesk'
import { chatComplete, providerStatus, type ChatMessage } from '../lib/llm'
import { tfSeconds } from '../analytics/synthfeed'
import { atr, closes, highs, lows, rsi, trueRange } from '../analytics/indicators'
import { indicatorBoardLines } from '../analytics/indicatorboard'
import { classifySession } from '../analytics/session'
// OWN-MATH PRECISION REWORK (direct instruction: shift the trader's own math
// off raw-candle indicators onto tick+footprint+technical-ladder as the
// PRIMARY read, renko/range as the noise-filtered confirmation that
// REPLACES moving averages, and SMC/ICT-on-candles as the structural
// confirmation layer, not the primary gauge) - engineVoteSingle gives the
// exact same renko/range brick-trend votes the Chart Signal panel renders
// (analytics/chartsignals.ts), scanSmc/smcNowRead give the same SMC/ICT
// read the SMC panel renders (analytics/smc.ts) - both pure, synchronous,
// over candles already in hand, no new service dependency.
import { engineVoteSingle } from '../analytics/chartsignals'
import { scanSmc, smcNowRead } from '../analytics/smc'
// UNIFIED INDICATOR BOARD (direct instruction: "just as we have them as
// charts, now having them as indicators... great help for easy
// accessibility") - one call gets all ten chart-type indicators (candle,
// tick, footprint, otc-footprint, renko, range, tick-footprint, IV-HV, SMC,
// ICT) in one consistent row shape, see analytics/chartindicators.ts's
// module header for the adapter contract (it wraps existing engines, never
// reimplements them).
import { buildChartIndicatorBoard, chartIndicatorBoardLines, type ChartIndicatorRow } from '../analytics/chartindicators'

export type AiTraderScanMode = 'single' | 'selected' | 'global'

/** Money-management plan - deliberately the SAME shape as the autopilot
 * bots' StakePlan (plugins/autopilot.ts) and the meta-trader's MetaStakePlan
 * field-for-field, so a compounding scheme tuned on a bot carries over to
 * the AI Trader with zero translation and one mental model across the
 * platform. kind:'compound' rolls a pot seeded at `base`: every win folds
 * the payout in (skimming anything above payoutCap%), every loss burns the
 * stake back out and - by default (stopOnLoss) - ENDS the cycle until an
 * explicit restart, exactly like the bots. undefined (the default) = the
 * flat configured `stake` every trade, unchanged original behavior. */
export interface AiTraderStakePlan {
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

/** Persisted roll state (pot/rollN/restarts/halted) - written into the same
 * ai_trader_config blob on every settle so the compounding run survives
 * kernel restarts, the same way the bots carry planState on their record. */
export interface AiTraderPlanState {
  pot: number
  rollN: number
  restarts: number
  reseedCount: number
  lossReseedCount: number
  halted: boolean
  complete: boolean
}

export interface AiTraderConfig {
  enabled: boolean
  /** false (default) = shadow: decide + log every cycle, place nothing.
   *  true = act on non-skip decisions through the real risk-gated order path. */
  live: boolean
  /** 'single' (default, unchanged behavior) - only ever scans `asset`.
   *  'selected' - scans `selectedAssets`, operator-curated.
   *  'global' - scans whatever the Screener currently ranks as the best
   *  opportunities across the WHOLE instrument universe (cheap pre-filter
   *  that's already running every cycle anyway), falling back to the raw
   *  asset universe if the screener has no rows yet. */
  scanMode: AiTraderScanMode
  /** Used when scanMode === 'single' (and as the fallback if 'selected'
   *  ends up with an empty list). */
  asset: string
  /** Used when scanMode === 'selected'. */
  selectedAssets: string[]
  tf: Timeframe
  /** Minutes between opportunity scans - NOT a guaranteed trade cadence
   *  ("6 trades an hour" is the user's own ceiling if it sees an
   *  opportunity every single cycle; a quiet market can skip every cycle). */
  intervalMin: number
  stake: number
  kind: TradeKind
  /** Decisions below this are forced to 'skip' regardless of what the model
   *  itself returned - the floor the operator sets, not just a suggestion
   *  the model can talk itself past. */
  minConfidence: number
  /** Expiry choices (minutes) the prompt offers the model - it picks ONE
   *  per decision, it does not invent others. */
  expiryChoices: number[]
  /** Max OPEN positions this trader is allowed to hold AT ONCE - only
   *  enforced in LIVE mode (shadow never opens a real position, so there is
   *  nothing "concurrent" to cap). When live and already at this cap, a
   *  cycle skips ENTIRELY - no snapshot, no candles, no LLM call - rather
   *  than running a full analysis that could not be acted on anyway. Per
   *  direct instruction: "should it run a cycle when one trade is not
   *  completed yet" - no, not when there's no room left to act on it. */
  maxConcurrent: number
  /** Hard ceiling on how many assets get a full LLM analysis in ONE cycle
   *  under 'selected'/'global' scan modes (and the live-mode concurrency
   *  budget is clamped to this too) - without this, selecting 50 pairs or
   *  scanning "global" would mean 50 LLM calls every single interval tick.
   *  Does not apply to 'single' mode (always exactly 1). */
  maxScanPerCycle: number
  /** LLM provider override - only used on the local-fallback path (see
   *  callLlm() below); the primary path calls through to the Next.js app,
   *  which picks its own provider exactly like the Copilot does. */
  provider?: string
  /** Base URL of the Next.js app (this app's own frontend) - the primary
   *  LLM path POSTs to `${appUrl}/api/ai_trader_decide`, which runs
   *  THROUGH the exact same chatComplete() the Copilot and CodeAssistBar
   *  already use successfully, so there's nothing new to configure: same
   *  keys, same provider, zero separate setup. Defaults to localhost:3000
   *  (the standard `next dev`/`next start` port) - override here if this
   *  app is actually served from somewhere else (a different port, a
   *  docker-compose service name, etc). */
  appUrl?: string
  /** Optional compounding plan (AiTraderStakePlan above). undefined = flat
   *  `stake` every trade. When armed, every LIVE order (and the shadow log
   *  line) sizes off the running pot instead, and a loss ends the cycle -
   *  the trader stands down until restartCompound(). The model is TOLD its
   *  pot/roll state in the prompt (a human at the desk knows his account
   *  state) but sizing stays the operator's lever, never the model's. */
  stakePlan?: AiTraderStakePlan
}

export interface AiTraderDecision {
  id: number
  asset: string
  tf: string
  direction: 'call' | 'put' | 'skip'
  confidence: number
  expiryMin: number | null
  reasoning: string
  live: boolean
  acted: boolean
  positionId: string | null
  provider: string | null
  model: string | null
  error: string | null
  ts: number
}

const DEFAULT_CONFIG: AiTraderConfig = {
  enabled: false,
  live: false,
  scanMode: 'single',
  asset: 'EURUSD',
  selectedAssets: [],
  tf: '1m',
  intervalMin: 10,
  stake: 1,
  kind: 'binary',
  minConfidence: 65,
  expiryChoices: [3, 5],
  maxConcurrent: 1,
  maxScanPerCycle: 5,
  // NOT a literal default on purpose - see resolveAppUrl() below. Baking
  // 'http://127.0.0.1:3000' in here would get written into every saved
  // config (the panel always sends the whole draft on save), permanently
  // shadowing a correct APP_URL env var set later (e.g. after moving this
  // deployment behind docker-compose, where the right address is a service
  // name like http://iqos-web:47311, not localhost at all).
  appUrl: undefined,
}

/** Resolution order: an APP_URL env var (the deployment's own wiring - set
 * this in docker-compose.yml's iqos-kernel service, mirroring how iqos-web
 * already gets KERNEL_URL=http://iqos-kernel:47312 there) always wins, THEN
 * whatever's saved in config (useful for a bare dev setup with no compose
 * env at all), THEN localhost:3000 as the last-resort default. Env wins
 * over config specifically so a correct container-network address isn't
 * permanently stuck behind a stale 127.0.0.1 the UI already saved once. */
function resolveAppUrl(config: AiTraderConfig): string {
  return process.env.APP_URL || config.appUrl || 'http://127.0.0.1:3000'
}

/** Primary path: call THROUGH the Next.js app's /api/ai_trader_decide,
 * which runs the exact same chatComplete() the Copilot/CodeAssistBar
 * already use successfully in that process - same env, same provider, no
 * second copy of any key to keep in sync. Falls back to trading-core's OWN
 * local LLM client (lib/llm.ts, reading trading-core's/the shared root
 * .env) only if the app is unreachable at all (not running, wrong appUrl,
 * network blocked) - so this still works for an operator who genuinely
 * wants trading-core fully independent of the frontend, but that's now the
 * fallback, not the thing everyone has to configure first. */
async function callLlm(
  appUrl: string,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number }
): Promise<{ content: string; provider: string; model: string }> {
  try {
    const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/ai_trader_decide`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // P2 AUDIT FIX: the app route now requires this header whenever
        // KERNEL_TOKEN is set in ITS env - send it whenever THIS process
        // carries the same shared secret (index.ts already reads it for the
        // kernel's own REST auth, so it's the same value in any deployment
        // that sets it at all).
        ...(String(process.env.KERNEL_TOKEN ?? '').trim() ? { 'x-kernel-token': String(process.env.KERNEL_TOKEN).trim() } : {}),
      },
      body: JSON.stringify({ messages, ...opts }),
      signal: AbortSignal.timeout((opts.timeoutMs ?? 45_000) + 5_000), // small margin over the route's own internal timeout
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; content?: string; provider?: string; model?: string; error?: string }
    if (!res.ok || !data.ok) throw new Error(data.error ?? `app HTTP ${res.status}`)
    if (!data.content) throw new Error('app returned no content')
    return { content: data.content, provider: data.provider ?? 'app', model: data.model ?? '' }
  } catch (appErr) {
    try {
      const res = await chatComplete({ messages, ...opts })
      return res
    } catch (localErr) {
      throw new Error(
        `via app (${appUrl}): ${String(appErr instanceof Error ? appErr.message : appErr)} | via trading-core's own .env: ${String(localErr instanceof Error ? localErr.message : localErr)}`
      )
    }
  }
}

/** Minutes -> seconds, used for placeOrder's direct expirySec path (binary
 * accepts an exact expirySec same as turbo/blitz - see execution.ts). */
const minToSec = (m: number) => Math.max(1, Math.round(m * 60))

/** Minimum closed candles an asset must have before this trader is allowed
 * to spend an LLM call (let alone place an order) on it - covers a real
 * ATR(14)/RSI(14) window with headroom for the shortest horizon read.
 * AUDIT: before this gate, a just-booted asset (or one whose feed never
 * warmed) went to the model as "Current price: unavailable ... (none yet)",
 * and the model could still answer "call, 80%" - which LIVE mode would
 * have placed verbatim. Every other decision path in this codebase is
 * fail-closed on thin history; this trader now is too. */
const MIN_CANDLES_FOR_DECISION = 25
/** Same broker-rejection family os-mode.ts's auto-trader and metatrader.ts
 * already cool down on ("Cannot purchase an option (the asset is not
 * available at the moment)", suspended/not-a-tradeable-instrument, etc.) -
 * a REAL AI Trader deployment just hit this verbatim on BTCUSD for hours
 * (every ~5min interval, a full desk briefing + LLM call + a place-order
 * attempt that was rejected every single time) because nothing here ever
 * remembered the rejection past that one cycle. Mirrors the other two
 * plugins' cooldown pattern instead of inventing a third one: once the
 * broker says an asset's option book is closed/suspended, stop spending an
 * LLM call on it at all (not just skip the order) until the cooldown lapses. */
const AI_TRADER_BROKER_UNAVAILABLE_RE = /not available at the moment|is not a (?:turbo\/binary\/digital|digital\/turbo\/binary) instrument|active\b[^.]*not found|is suspended|active is suspended|suspended\b/i
const AI_TRADER_UNAVAILABLE_COOLDOWN_SEC = 600
/** A candle series older than this (relative to the tf - 5 closed bars,
 * floored at 5 wall-clock minutes) reads as a stalled/frozen feed or a
 * closed market: skip without calling the model, same fail-closed rule.
 * This is the hard backstop behind market-data's watchedAssets() warming -
 * warming can lag boot or stall mid-session, and a decision made on
 * hours-old candles is not a decision about THIS market. */
const staleToleranceSec = (tfSec: number) => Math.max(5 * tfSec, 300)

/** One sanitizer for the stake plan patch - same clamps as the autopilot's
 * parseStakePlan so a plan hand-edited in the config blob (or sent up by a
 * stale UI build) can't smuggle in a $0 seed, a 500% payout cap, or an
 * unknown kind. kind !== 'compound' (including junk) = no plan at all. */
function sanitizeAiStakePlan(v: unknown): AiTraderStakePlan | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (o.kind !== 'compound') return undefined
  const num = (x: unknown, fb: number, lo: number, hi: number): number => {
    const n = Number(x)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb
  }
  return {
    kind: 'compound',
    base: num(o.base, 1, 1, 5000),
    rollPct: o.rollPct !== undefined ? num(o.rollPct, 100, 1, 100) : undefined,
    maxStake: o.maxStake !== undefined ? num(o.maxStake, 5000, 1, 5000) : undefined,
    // 70 stays the house maximum fold-in no matter what the patch asks for
    payoutCap: o.payoutCap !== undefined ? num(o.payoutCap, 70, 1, 70) : undefined,
    stopOnLoss: o.stopOnLoss !== undefined ? Boolean(o.stopOnLoss) : undefined,
    periods: o.periods !== undefined ? Math.round(num(o.periods, 1, 1, 1000)) : undefined,
    deriskAfter: o.deriskAfter !== undefined ? Math.round(num(o.deriskAfter, 1, 1, 999)) : undefined,
    deriskPct: o.deriskPct !== undefined ? num(o.deriskPct, 50, 1, 100) : undefined,
    onComplete: o.onComplete === 'reseed' ? 'reseed' : o.onComplete === 'halt' ? 'halt' : undefined,
    reseedLimit:
      o.onComplete === 'reseed' && o.reseedLimit !== undefined && Number(o.reseedLimit) > 0
        ? Math.round(num(o.reseedLimit, 1, 1, 100000))
        : undefined,
    lossReseedLimit:
      o.stopOnLoss === false && o.lossReseedLimit !== undefined && Number(o.lossReseedLimit) > 0
        ? Math.round(num(o.lossReseedLimit, 1, 1, 100000))
        : undefined,
  }
}

/** Restores the persisted roll state from the config blob, clamped to sane
 * non-negative numbers so a hand-edited row can't poison the sizing math. */
function sanitizeAiPlanState(v: unknown): AiTraderPlanState {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, x) : 0)
  return {
    pot: num(o.pot),
    rollN: Math.round(num(o.rollN)),
    restarts: Math.round(num(o.restarts)),
    reseedCount: Math.round(num(o.reseedCount)),
    lossReseedCount: Math.round(num(o.lossReseedCount)),
    halted: Boolean(o.halted),
    complete: Boolean(o.complete),
  }
}

/** AUDIT: one sanitizer for every field the panel's draft can send up (the
 * panel always POSTs whole fields on save, and a stale UI build or a hand-
 * edited config row can carry NaN/strings/junk). configure() and start()
 * both run through this, so a poisoned value can never reach the timer
 * math, the prompt ("NaNmin expiry"), or placeOrder's amount. */
function sanitizeAiConfig(c: AiTraderConfig): AiTraderConfig {
  const num = (v: unknown, fb: number, lo: number, hi: number): number => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb
  }
  if (!['single', 'selected', 'global'].includes(c.scanMode)) c.scanMode = 'single'
  if (!Array.isArray(c.selectedAssets)) c.selectedAssets = []
  c.selectedAssets = c.selectedAssets.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim().toUpperCase())
  if (typeof c.asset !== 'string' || !c.asset.trim()) c.asset = DEFAULT_CONFIG.asset
  else c.asset = c.asset.trim().toUpperCase()
  if (!['binary', 'turbo', 'blitz', 'digital', 'cfd'].includes(c.kind)) c.kind = DEFAULT_CONFIG.kind
  c.intervalMin = num(c.intervalMin, DEFAULT_CONFIG.intervalMin, 1, 1440)
  c.stake = num(c.stake, DEFAULT_CONFIG.stake, 1, 5000)
  c.minConfidence = num(c.minConfidence, DEFAULT_CONFIG.minConfidence, 0, 100)
  c.maxConcurrent = Math.round(num(c.maxConcurrent, DEFAULT_CONFIG.maxConcurrent, 1, 20))
  c.maxScanPerCycle = Math.round(num(c.maxScanPerCycle, DEFAULT_CONFIG.maxScanPerCycle, 1, 20))
  // Expiry menu: finite whole minutes only, deduped + sorted, capped at
  // 120 (the operator's own framing was 3-5 min expiries; an absurd value
  // here would also balloon the candle fetch - longestExpiryBars * 4 + 30)
  if (!Array.isArray(c.expiryChoices)) c.expiryChoices = [...DEFAULT_CONFIG.expiryChoices]
  c.expiryChoices = [...new Set(c.expiryChoices.map((m) => Math.round(Number(m))).filter((m) => Number.isFinite(m) && m >= 1 && m <= 120))].sort((a, b) => a - b)
  if (!c.expiryChoices.length) c.expiryChoices = [...DEFAULT_CONFIG.expiryChoices]
  c.stakePlan = sanitizeAiStakePlan(c.stakePlan)
  return c
}

/** Per-expiry-choice read, computed directly off the raw candles rather than
 * any other predictor's pre-digested verdict. This is what makes the model
 * actually reason about THIS trade's specific holding period instead of
 * reacting to a generic, horizon-agnostic signal - a 3min and a 15min expiry
 * can legitimately disagree, and conflating them is exactly the "immediate
 * context" loss the operator flagged. */
interface HorizonRead {
  expiryMin: number
  bars: number
  momentumPct: number
  upBars: number
  downBars: number
  /** |momentum| divided by a random-walk-scaled noise estimate (atr% *
   * sqrt(bars)) - a rough signal-to-noise ratio for THIS window length.
   * Comfortably >1 means the drift measured is bigger than you'd expect
   * from noise alone over that many bars; well under 1 means it's
   * indistinguishable from chop and shouldn't be read as a trend. */
  snr: number
}

/**
 * Glitch-resistant ATR% of price. `validCandle` (market-data.ts) deliberately
 * does NOT do shape-policing on high/low - a live feed can legitimately
 * sample an odd extreme, and rejecting on shape would throw away real data.
 * But that means a single bad bar (a decimal/scale glitch from the sidecar -
 * one tick where high/low lands 10-100x normal) sails straight into
 * Wilder's ATR(14), which is an EMA: one such outlier dominates the average
 * for ~13 bars and can make ATR% read as "500% of price" on an asset that
 * is actually moving a fraction of a percent per bar - and since every
 * horizon's signal-to-noise below divides by atrPct, that one bad bar also
 * silently crushes every expiry's snr to ~0.00x regardless of real momentum
 * (both symptoms, one root cause). Standard Wilder ATR is kept for the
 * trend-context display line, but clamp each bar's true range to a multiple
 * of the window's MEDIAN true range (median is outlier-resistant in a way a
 * mean/EMA is not) before averaging, so one glitched bar can't hijack the
 * whole read. With no glitch this is a no-op (nothing exceeds the clamp).
 */
function robustAtrPct(highPrices: number[], lowPrices: number[], closePrices: number[], price: number, period = 14): number {
  if (price <= 0 || closePrices.length < period + 1) return 0
  const tr = trueRange(highPrices, lowPrices, closePrices)
  const window = tr.slice(-period).filter((v) => Number.isFinite(v))
  if (!window.length) return 0
  const sorted = [...window].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  if (median <= 0) return 0
  const cap = median * 5 // generous - real volatility bursts still pass through, a scale glitch does not
  const clamped = window.map((v) => Math.min(v, cap))
  const avg = clamped.reduce((a, b) => a + b, 0) / clamped.length
  return (avg / price) * 100
}

function buildHorizonReads(closePrices: number[], tfSec: number, expiryChoices: number[], atrPct: number): HorizonRead[] {
  const n = closePrices.length
  return expiryChoices.map((expiryMin) => {
    const bars = Math.max(1, Math.round((expiryMin * 60) / tfSec))
    const start = n - 1 - bars
    let momentumPct = 0
    let upBars = 0
    let downBars = 0
    if (start >= 0 && closePrices[start]) {
      momentumPct = ((closePrices[n - 1] - closePrices[start]) / closePrices[start]) * 100
      for (let i = start + 1; i < n; i++) {
        if (closePrices[i] > closePrices[i - 1]) upBars += 1
        else if (closePrices[i] < closePrices[i - 1]) downBars += 1
      }
    }
    const noise = atrPct * Math.sqrt(bars)
    const snr = noise > 0 ? Math.abs(momentumPct) / noise : 0
    return { expiryMin, bars, momentumPct, upBars, downBars, snr }
  })
}

interface ParsedDecision {
  direction: 'call' | 'put' | 'skip'
  confidence: number
  expiryMin: number
  reasoning: string
}

/** Per direct instruction: AI Trader should not be forced to run EVERY
 * scanner/engine on EVERY cycle regardless of whether this asset/moment
 * needs it - "it should be free to choose what it run as far as it
 * suffices its analysis ... should know what works best for the
 * particular pair." The desk's ALWAYS-ON core (own candle/swing/horizon
 * math, next-candle oracle, the full tick desk incl. tick SMC/footprint,
 * the OTC velocity footprint, reversal, technical summary, Accute, plus
 * the non-skippable governance seats: session/risk-book/memory-gate/OTC-
 * guard) is NOT in this catalog - those always run, they're either the
 * named must-haves or cheap safety gates, not optional analysis spend.
 * Everything in this list is an EXTRA desk seat, each with a real compute
 * (and on 'global'/'selected' scan modes, per-candidate) cost - a cheap
 * triage call (triageSelectSources below) asks the model which of these,
 * if any, it actually wants before the full briefing is built, so a quiet
 * cycle on a pair that's already clear from the core seats doesn't pay for
 * a cointegration fit, a 14-factor confluence scan, and the full indicator
 * board it never needed. MSL is in here too per direct instruction ("msl
 * is for when it actually need it") - it is NOT core. */
const OPTIONAL_DESK_SOURCES: { id: string; label: string }[] = [
  { id: 'nextExpiry', label: 'next-expiry oracle - per-rung (1/2/3/5/15min) pWin honesty engine; most useful when your own expiry choice is genuinely unclear' },
  { id: 'tempo', label: "tempo desk - this pair's own shot-license rhythm scanner (fire/wait/skip with its own hit-rate record)" },
  { id: 'confluenceScreener', label: '14-factor mechanical confluence screener (a different vote-counting method than your own read, for cross-checking)' },
  { id: 'screenerRank', label: 'universe rank + OU mean-reversion stretch (how statistically stretched price is from equilibrium right now)' },
  { id: 'smcScan', label: 'candle-built SMC structure engine (separate from tick SMC - useful when the tick tape is stale/thin and you need a candle-based structure cross-check)' },
  { id: 'chartSignals', label: 'chart-pattern committee (may suggest fading its own read - both sides shown)' },
  { id: 'leadLag', label: 'lead-lag scanner - is a correlated leader already moving first' },
  { id: 'volArb', label: 'volatility-arb scan - close-vol vs range-vol dislocation vs peers' },
  { id: 'cointegration', label: 'cointegration scan - spread stretch vs a statistically paired asset' },
  { id: 'yesterdayEcho', label: 'T-24h replay - did this same hour rhyme with yesterday (a weak prior, not a signal)' },
  { id: 'aiLab', label: 'AI Lab - learned specs on this exact asset+tf with their holdout honesty' },
  { id: 'indicatorBoard', label: 'full indicator board - every trend/momentum/volatility/volume/pivot indicator this OS computes, one tf, name+value+stance' },
  { id: 'msl', label: 'MSL / meta-strategy - your OWN saved specs and scripts, evaluated live on this asset+tf' },
]
const OPTIONAL_DESK_IDS = new Set(OPTIONAL_DESK_SOURCES.map((s) => s.id))

/** Parses the triage call's reply - same strict-then-forgiving ladder as
 * parseDecision, but tolerant of a bare JSON array too (the simplest
 * correct answer to "which of these do you want") alongside the
 * {"use":[...]} shape the prompt actually asks for. Unknown ids are
 * dropped silently (never thrown on) - a model inventing an id it misread
 * from the catalog must never crash the cycle, it just doesn't get run. */
function parseTriageReply(raw: string): Set<string> {
  const tryParse = (text: string): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  let v = tryParse(raw.trim())
  if (v === null) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced) v = tryParse(fenced[1].trim())
  }
  if (v === null) {
    const braced = raw.match(/\{[\s\S]*\}/)
    const bracketed = raw.match(/\[[\s\S]*\]/)
    if (braced) v = tryParse(braced[0])
    else if (bracketed) v = tryParse(bracketed[0])
  }
  const arr: unknown[] = Array.isArray(v) ? v : Array.isArray((v as { use?: unknown })?.use) ? ((v as { use: unknown[] }).use) : []
  const out = new Set<string>()
  for (const item of arr) {
    const id = String(item ?? '')
    if (OPTIONAL_DESK_IDS.has(id)) out.add(id)
  }
  return out
}

/** Strict-then-forgiving JSON extraction, same ladder codeAssist.ts's
 * parseCodeAssistReply uses for the same reason: a model that's 95% good at
 * "return ONLY JSON" still occasionally wraps it in prose or a fenced block,
 * and a trade decision is exactly the place NOT to throw that away. */
function parseDecision(raw: string, allowedExpiries: number[]): ParsedDecision | null {
  const fallbackExpiry = allowedExpiries[0] ?? 3
  const tryParse = (text: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(text)
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  let obj = tryParse(raw.trim())
  if (!obj) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced) obj = tryParse(fenced[1].trim())
  }
  if (!obj) {
    const brace = raw.match(/\{[\s\S]*\}/)
    if (brace) obj = tryParse(brace[0])
  }
  if (!obj) return null
  const dirRaw = String(obj.direction ?? '').toLowerCase()
  const direction: ParsedDecision['direction'] = dirRaw === 'call' || dirRaw === 'put' ? dirRaw : 'skip'
  const confidence = Math.max(0, Math.min(100, Number(obj.confidence) || 0))
  // The model is offered a fixed menu of expiries and told to pick one, not
  // invent one - snap to the closest allowed choice rather than trusting an
  // arbitrary number back, since placeOrder will use this verbatim.
  const rawExpiry = Number(obj.expiryMin)
  const expiryMin =
    rawExpiry > 0 && allowedExpiries.length
      ? allowedExpiries.reduce((best, c) => (Math.abs(c - rawExpiry) < Math.abs(best - rawExpiry) ? c : best), allowedExpiries[0])
      : fallbackExpiry
  const reasoning = String(obj.reasoning ?? '').trim() || '(no reasoning given)'
  return { direction, confidence, expiryMin, reasoning }
}

// ---------------------------------------------------------------------------
// OWN-ANALYSIS DETECTION HELPERS - the model's primary evidence, upgraded.
// All pure functions off the raw candle slice so they unit-test without a
// kernel (scripts/aitrader_briefing_unit.ts) and stay identical between the
// prompt and the tests. The desk briefing (buildDeskBriefing below) is the
// SECOND opinion; these reads are what the trader itself brings to the desk.
// ---------------------------------------------------------------------------

/** Candle-anatomy read of the last few closed bars - the raw material a
 * human trader's eye actually parses before any indicator: who won the bar
 * (body vs wicks), where the close landed inside the bar, how long the
 * current same-color run is, and where price sits inside the recent range.
 * Rejection wicks against the prior drift and a stretched range position
 * are the classic exhaustion tells; a clean marubozu-ish bar mid-range is
 * the classic continuation tell. Deliberately numbers, not adjectives - the
 * model does the interpretation. */
export function candleAnatomy(candles: Candle[]): string[] {
  if (candles.length < 4) return []
  // the caller fetches with closedOnly=true, so the LAST element is already
  // the most recent CLOSED bar - the last three closed bars are slice(-3)
  const bars = candles.slice(-3)
  const lines: string[] = []
  const bodyOf = (c: Candle) => {
    const range = Math.max(c.high - c.low, Number.EPSILON)
    const body = Math.abs(c.close - c.open)
    const upper = c.high - Math.max(c.open, c.close)
    const lower = Math.min(c.open, c.close) - c.low
    return {
      color: c.close > c.open ? 'up' : c.close < c.open ? 'down' : 'flat',
      bodyPct: (body / range) * 100,
      upperWickPct: (upper / range) * 100,
      lowerWickPct: (lower / range) * 100,
      closePosPct: ((c.close - c.low) / range) * 100,
    }
  }
  const last = bars.length
  for (let i = 0; i < last; i++) {
    const a = bodyOf(bars[i])
    const idx = candles.length - bars.length + i
    lines.push(
      `- bar ${idx} (${bars[i].time}): ${a.color} bar, body ${a.bodyPct.toFixed(0)}% of range, upper wick ${a.upperWickPct.toFixed(0)}%, lower wick ${a.lowerWickPct.toFixed(0)}%, close at ${a.closePosPct.toFixed(0)}% of the bar's range` +
        (a.upperWickPct >= 45 ? ' [long upper wick - sellers rejected higher prices]' : a.lowerWickPct >= 45 ? ' [long lower wick - buyers rejected lower prices]' : ''),
    )
  }
  // same-color streak across closed bars, anchored at the most recent one
  const lastBar = bars[bars.length - 1]
  const lastDir = lastBar.close > lastBar.open ? 1 : lastBar.close < lastBar.open ? -1 : 0
  let streak = lastDir === 0 ? 0 : 1
  for (let i = candles.length - 2; i >= 0 && streak > 0; i--) {
    const c = candles[i]
    const dir = c.close > c.open ? 1 : c.close < c.open ? -1 : 0
    if (dir === lastDir) streak += 1
    else break
  }
  if (streak >= 3) {
    lines.push(`- streak: ${streak} consecutive ${lastDir === 1 ? 'up' : 'down'}-color closed bars - extended runs often mean-revert or pause, but confirm with the wick/range reads above`)
  }
  // where price sits in the recent range (window = the slice we hold, min 10 bars)
  const win = candles.slice(-Math.min(24, candles.length))
  const hi = Math.max(...win.map((c) => c.high))
  const lo = Math.min(...win.map((c) => c.low))
  const lastClose = win[win.length - 1].close
  if (hi > lo && lastClose > 0) {
    const posPct = ((lastClose - lo) / (hi - lo)) * 100
    lines.push(
      `- range position: last close sits at ${posPct.toFixed(0)}% of the last ${win.length}-bar high-low range (0% = sitting on the floor, 100% = pinned to the ceiling)` +
        (posPct >= 90 ? ' [pressing the top of the range - either breakout or exhaustion]' : posPct <= 10 ? ' [pressing the bottom of the range - either breakdown or exhaustion]' : ''),
    )
  }
  return lines
}

/** Swing-structure read: 2-bar-fractal swing highs/lows over the held slice,
 * then whether the most recent close has BROKEN the last confirmed swing
 * (a BOS - change of control in the SMC sense) or is still contained. This
 * gives the model its own market-structure read to weigh against the SMC
 * plugin's scan in the desk briefing, instead of trusting that one voice. */
export function swingStructure(candles: Candle[]): string[] {
  if (candles.length < 9) return []
  const swings: { kind: 'high' | 'low'; price: number; idx: number }[] = []
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i]
    const isHigh = c.high > candles[i - 1].high && c.high > candles[i - 2].high && c.high > candles[i + 1].high && c.high > candles[i + 2].high
    const isLow = c.low < candles[i - 1].low && c.low < candles[i - 2].low && c.low < candles[i + 1].low && c.low < candles[i + 2].low
    if (isHigh) swings.push({ kind: 'high', price: c.high, idx: i })
    else if (isLow) swings.push({ kind: 'low', price: c.low, idx: i })
  }
  if (!swings.length) return ['- structure: no confirmed 2-bar swing points in the scanned window yet (flat or one-directional tape)']
  const lastHigh = [...swings].reverse().find((s) => s.kind === 'high')
  const lastLow = [...swings].reverse().find((s) => s.kind === 'low')
  const lastClose = candles[candles.length - 1].close
  const lines: string[] = []
  const price = lastClose || 1
  if (lastHigh) lines.push(`- last swing high: ${lastHigh.price.toFixed(5)} (${((lastClose - lastHigh.price) / price * 100).toFixed(3)}% from current close, bar ${lastHigh.idx})`)
  if (lastLow) lines.push(`- last swing low: ${lastLow.price.toFixed(5)} (${((lastClose - lastLow.price) / price * 100).toFixed(3)}% from current close, bar ${lastLow.idx})`)
  if (lastHigh && lastLow) {
    // the most recent CONFIRMED break of either swing = the structure call
    const brokeHigh = lastClose > lastHigh.price
    const brokeLow = lastClose < lastLow.price
    if (brokeHigh && lastHigh.idx < lastLow.idx) lines.push('- structure: close is ABOVE the last swing high -> bullish break of structure (BOS) - buyers took control of the last level')
    else if (brokeLow && lastLow.idx < lastHigh.idx) lines.push('- structure: close is BELOW the last swing low -> bearish break of structure (BOS) - sellers took control of the last level')
    else lines.push('- structure: close is INSIDE the last swing high/low pair - range-bound between the two levels, no confirmed break yet')
  }
  return lines
}

/** Confidence-weighted tally across the panel's own source reads - a
 * mechanical STARTING point only ("how many desk voices lean which way, and
 * how loud"), explicitly framed in the prompt as something the model may
 * and should override. Sources reading 'none' count as abstentions, not
 * votes. Returns null when there is nothing to tally (empty snapshot). */
export function deskTally(snapshot: MetaSourceRead[]): string | null {
  if (!snapshot.length) return null
  let callN = 0
  let putN = 0
  let noneN = 0
  let callW = 0
  let putW = 0
  for (const r of snapshot) {
    if (r.direction === 'call') {
      callN += 1
      callW += r.confidence
    } else if (r.direction === 'put') {
      putN += 1
      putW += r.confidence
    } else noneN += 1
  }
  const net = callW - putW
  const dir = net > 0 ? 'call' : net < 0 ? 'put' : 'evenly split'
  return `Desk tally across ${snapshot.length} panel reads: ${callN} call / ${putN} put / ${noneN} abstaining; confidence-weighted net ${net >= 0 ? '+' : ''}${net.toFixed(0)} toward ${dir}. This is a starting point, not your decision - the tally says nothing about WHICH expiry, and a loud tally can still be wrong.`
}

/** OWN-MATH CONSENSUS (precision rework, direct instruction): a weighted
 * tally across the trader's own PRIMARY read - tick desk flow, OTC
 * footprint pressure, the all-timeframe technical ladder, and the
 * noise-filtered renko/range votes - explicitly SEPARATE from deskTally()
 * above (which tallies the EXTERNAL desk/panel snapshot, step 2 of the
 * trader's job). This is "what does my own math say before I even open the
 * meeting with the desk" - same mechanical-starting-point framing, scoped
 * to the sources the operator asked to be primary. SMC/ICT is deliberately
 * NOT folded into this number - per direct instruction it's the
 * CONFIRMATION layer applied to candle structure, read on its own merits in
 * the prompt rather than blended into one score. */
export interface OwnMathVote {
  label: string
  dir: 1 | -1 | 0
  weight: number
}

export function ownMathTally(votes: OwnMathVote[]): string | null {
  const live = votes.filter((v) => v.dir !== 0 && v.weight > 0)
  if (!live.length) return null
  let net = 0
  for (const v of live) net += v.dir * v.weight
  const dir = net > 0 ? 'call' : net < 0 ? 'put' : 'evenly split'
  const detail = live.map((v) => `${v.label} ${v.dir > 0 ? 'call' : 'put'} (${(v.weight * 100).toFixed(0)}% weight)`).join(', ')
  return `Own-math consensus (tick flow + footprint + technical ladder + renko/range, ${live.length}/${votes.length} reporting): ${detail} -> net ${net >= 0 ? '+' : ''}${net.toFixed(2)} toward ${dir}. A mechanical starting point from YOUR primary read, computed BEFORE the desk meeting - weigh it, don't just restate it, and SMC/ICT below still needs its own read as structural confirmation.`
}

/** One row of the trader's own graded history, reduced for calibration. */
export interface CalibrationRow {
  direction: string
  confidence: number
  outcome: 'win' | 'loss' | 'pending' | 'skip' | 'ungraded'
}

/** The self-calibration lines: does the model's OWN claimed confidence map
 * to reality, per direction and per confidence bucket? A trader whose 80%+
 * calls win no more often than its 65% calls is inflating - these lines let
 * the model see that pattern in its own record and correct for it NOW. Pure
 * function over already-graded rows so the unit test can lock the math. */
export function calibrationLines(rows: CalibrationRow[]): string[] {
  const graded = rows.filter((r) => r.outcome === 'win' || r.outcome === 'loss')
  if (graded.length < 3) return [] // too thin to say anything honest - silence beats noise
  const lines: string[] = []
  const fmt = (w: number, l: number) => `${w}W/${l}L (${Math.round((w / Math.max(1, w + l)) * 100)}%)`
  for (const dir of ['call', 'put']) {
    const w = graded.filter((r) => r.direction === dir && r.outcome === 'win').length
    const l = graded.filter((r) => r.direction === dir && r.outcome === 'loss').length
    if (w + l > 0) lines.push(`- your ${dir.toUpperCase()} calls: ${fmt(w, l)}`)
  }
  const buckets: { label: string; lo: number; hi: number }[] = [
    { label: 'confidence 65-74', lo: 65, hi: 74.999 },
    { label: 'confidence 75-84', lo: 75, hi: 84.999 },
    { label: 'confidence 85+', lo: 85, hi: 100.001 },
  ]
  for (const b of buckets) {
    const w = graded.filter((r) => r.confidence >= b.lo && r.confidence <= b.hi && r.outcome === 'win').length
    const l = graded.filter((r) => r.confidence >= b.lo && r.confidence <= b.hi && r.outcome === 'loss').length
    if (w + l > 0) lines.push(`- your ${b.label}: ${fmt(w, l)}`)
  }
  if (lines.length >= 2) lines.unshift('- self-calibration (your claimed confidence vs what actually happened):')
  return lines
}

/** PRECISION FIX (operator report: "incurs a lot of losses, lets make it more
 * precise and accurate"): calibrationLines() above was only ADVISORY text -
 * it showed the model its own inflation pattern in the prompt but never
 * stopped an inflating model from claiming 85% on a call that, by its own
 * track record, only wins ~55% of the time at that confidence/direction. The
 * minConfidence floor is a hard code-side gate, but it only ever compared
 * against the model's SELF-reported number - a model that doesn't correct
 * for its own documented overconfidence still clears the bar every time.
 * This makes the correction numeric and automatic: given enough graded
 * history in the SAME direction and the SAME confidence bucket the model
 * just claimed, blend the claimed confidence halfway toward the REALIZED win
 * rate whenever the model is claiming meaningfully more than its own record
 * supports. Never adjusts upward (an underconfident model isn't the problem
 * here) and stays silent below MIN_CALIBRATION_SAMPLE - too few samples to
 * trust a bucket's realized rate over the model's own read. Pure function,
 * unit-testable like calibrationLines. */
export const MIN_CALIBRATION_SAMPLE = 8

export function calibratedConfidence(
  rows: CalibrationRow[],
  direction: 'call' | 'put',
  claimed: number,
): { adjusted: number; sample: number; realized: number | null } {
  const graded = rows.filter((r) => r.outcome === 'win' || r.outcome === 'loss')
  // same bucket edges as calibrationLines - a claim of e.g. 78% is graded
  // against how 75-84 calls in this direction have actually done
  const bucket =
    claimed >= 85 ? { lo: 85, hi: 100.001 } : claimed >= 75 ? { lo: 75, hi: 84.999 } : claimed >= 65 ? { lo: 65, hi: 74.999 } : null
  if (!bucket) return { adjusted: claimed, sample: 0, realized: null } // below the lowest bucket - already headed for a skip, nothing to correct
  const inBucket = graded.filter((r) => r.direction === direction && r.confidence >= bucket.lo && r.confidence <= bucket.hi)
  const sample = inBucket.length
  if (sample < MIN_CALIBRATION_SAMPLE) return { adjusted: claimed, sample, realized: null }
  const wins = inBucket.filter((r) => r.outcome === 'win').length
  const realized = (wins / sample) * 100
  // only correct DOWNWARD, and only when the gap is big enough to be the
  // model's own documented inflation rather than normal variance on a small
  // sample - a 2-3 point gap isn't worth second-guessing
  if (realized >= claimed - 10) return { adjusted: claimed, sample, realized }
  const adjusted = Math.round(claimed * 0.5 + realized * 0.5)
  return { adjusted: Math.min(claimed, adjusted), sample, realized }
}

// ---------------------------------------------------------------------------
// TICK-DESK BRIEFING HELPERS - the AI trader's full tick-chart analysis, per
// direct instruction ("full tick chart analysis, footprint, OTC footprint,
// renko, range, line, p&f, heiken ashi, IVHV, volume and so on"). Pure
// functions over the RAW micro-tick print stream (the same buffers the Tick
// Desk panels read), unit-testable without a kernel, fail-closed: a read
// that isn't ready is OMITTED, never guessed. The desk grid carries the
// chart-TYPE panel reads (renko/range/line/p&f/heikin ashi/IV-HV/volume)
// via MetaStrategyService.snapshotSources(); these helpers add the tick-
// built engines and the volume/staleness evidence those one-label reads
// can't carry.
// ---------------------------------------------------------------------------

/** Tape health + volume pressure off the raw print stream - the FIRST line
 * the model should read every cycle: how fresh the tick stream is (a stale
 * tape down-weights every tick-desk read below) and which side is winning
 * the print flow (up-prints vs down-prints - the feed's own measured volume
 * proxy; the collector stores price CHANGES, so every buffered print after
 * the first carries a direction). Returns [] only when there are no prints
 * at all - the seat then stays empty, same fail-closed contract as ever. */
export function tapeHealthLines(ticks: TickPoint[], nowMs = Date.now()): string[] {
  if (!ticks.length) return []
  const cadence = medianTickGapMs(ticks)
  const lastTs = ticks[ticks.length - 1].ts
  const ageSec = Math.max(0, Math.round((nowMs - lastTs) / 1000))
  // stale threshold scales with the feed's own cadence: 6 missed prints is
  // a dead stream, never a slow one; floored at 20s so a fast feed's normal
  // quiet patch doesn't trip it
  const staleLimitSec = cadence != null ? Math.max((cadence * 6) / 1000, 20) : 30
  const stale = ageSec > staleLimitSec
  const lines = [
    `tape: ${ticks.length} prints buffered, median cadence ${cadence != null ? `${cadence}ms` : 'n/a'}, last print ${ageSec}s ago${stale ? ` - STALE (older than ~${Math.round(staleLimitSec)}s: DISCOUNT every tick-desk read below and demand candle-structure agreement before trusting any direction)` : ' (fresh)'}`,
  ]
  let up = 0
  let dn = 0
  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i].price > ticks[i - 1].price) up += 1
    else if (ticks[i].price < ticks[i - 1].price) dn += 1
  }
  if (up + dn >= 10) {
    const share = up / (up + dn)
    lines.push(
      `print flow (volume proxy): ${up} up-prints vs ${dn} down-prints over the buffer (${(share * 100).toFixed(0)}% upward) - measured executed-print pressure, not a sentiment guess; ${share >= 0.6 ? 'buyers dominating the tape' : share <= 0.4 ? 'sellers dominating the tape' : 'two-sided tape'}`,
    )
  }
  return lines
}

/** The four tick-desk engines, reduced to desk lines. Each engine reads the
 * SAME ticks the Tick Desk panels render (SMC on 15s tick candles, the
 * next-candle oracle across its 1s..5m bucket ladder, the investing.com-
 * style technical summary ladder, the measured-print footprint) - a warming
 * or two-sided engine simply doesn't speak. Deliberately numbered so the
 * model can cross-reference them in its reasoning. */
export function tickDeskLines(ticks: TickPoint[], nowMs = Date.now()): string[] {
  const lines: string[] = []
  // 1. tick SMC (15s buckets) - structure on tick-built candles
  try {
    const r = computeTickSmc(ticks, { bucketSec: 15, nowMs })
    if (r.ok) {
      const bits: string[] = []
      if (r.bos) bits.push(`BOS ${r.bos.dir} ${r.bos.agoBars} bucket(s) ago`)
      if (r.choch) bits.push(`CHoCH ${r.choch.dir} ${r.choch.agoBars} bucket(s) ago`)
      if (r.bullOrderBlock && !r.bullOrderBlock.mitigated) bits.push('bull OB unmitigated')
      if (r.bearOrderBlock && !r.bearOrderBlock.mitigated) bits.push('bear OB unmitigated')
      const fvgs = r.fvgs.filter((f) => !f.filled)
      if (fvgs.length) bits.push(`${fvgs.length} unfilled FVG (${fvgs[0].dir} newest)`)
      if (r.sweeps.length) bits.push(`${r.sweeps.length} liquidity sweep(s)`)
      if (r.premiumDiscount) bits.push(`price in ${r.premiumDiscount.zone}`)
      lines.push(
        `tick SMC (15s buckets): trend ${r.trend.toUpperCase()} -> ${r.direction.toUpperCase()} ${r.confidence.toFixed(0)}% (${r.medTicksPerCandle.toFixed(1)} prints/bucket)${bits.length ? `: ${bits.join(', ')}` : ''}${r.reasons.length ? ` - ${r.reasons[0]}` : ''}`,
      )
    }
    // warming up -> omitted (the tape-health line already disclosed why)
  } catch {
    /* seat empty */
  }
  // 2. tick next-candle oracle - best bucket + the agreeing-buckets count
  try {
    const o = computeTickOracle(ticks, { nowMs })
    if (o.best) {
      const agreeing = o.rows.filter((r) => r.ok && r.direction === o.best?.direction).length
      const wf = o.best.wf?.hitRatePct != null ? `, own walk-forward ${o.best.wf.hitRatePct}% over ${o.best.wf.n}` : ''
      lines.push(
        `tick oracle (next tick-candle): best ${o.best.label} ${o.best.direction.toUpperCase()} ${o.best.confidence.toFixed(0)}% (score ${o.best.score >= 0 ? '+' : ''}${o.best.score}${wf}; ${agreeing}/${o.rows.filter((r) => r.ok).length} live buckets lean the same way) - reasons: ${o.best.reasons.slice(0, 3).join('; ') || 'n/a'}`,
      )
    }
  } catch {
    /* seat empty */
  }
  // 3. tick technical summary - the whole investing.com-style ladder, one line
  try {
    const t = computeTickTechnical(ticks, { nowMs })
    const okBuckets = t.buckets.filter((b) => b.ok)
    if (okBuckets.length) {
      const ladder = okBuckets.map((b) => `${b.label} ${b.summary.rating.toUpperCase()} (${b.summary.buy}B/${b.summary.sell}S/${b.summary.neutral}N)`).join(' | ')
      lines.push(`tick technical (osc+MA committee per bucket): ${ladder}`)
    }
  } catch {
    /* seat empty */
  }
  // 4. measured-print footprint - net delta, POC, the last buckets' delta
  // slope (volume-aware momentum of the flow itself, not of price)
  try {
    const fp = computeTickFootprint(ticks, { bucketSec: 60, nowMs })
    if (fp.ok && fp.candles.length) {
      const s = fp.summary
      const recent = fp.candles.slice(-5).map((c) => (c.delta >= 0 ? `+${c.delta}` : `${c.delta}`)).join(', ')
      const lastImb = fp.candles[fp.candles.length - 1].rows.filter((r) => r.imbalance).length
      lines.push(
        `tick footprint (60s buckets, measured prints): net delta ${s.netDelta >= 0 ? '+' : ''}${s.netDelta} (${s.totalUp}u/${s.totalDn}d over ${s.buckets} buckets), dominant POC ${s.dominantPoc != null ? s.dominantPoc.toFixed(5) : 'n/a'}, last-bucket delta slope ${recent}${lastImb ? `, ${lastImb} imbalance bin(s) in the last bucket` : ''} - delta slope against price direction = absorption; with it = confirmation`,
      )
    }
  } catch {
    /* seat empty */
  }
  return lines
}

/** The OTC/micro-tick VELOCITY footprint (analytics/otcfootprint.ts via the
 * otcFootprint service's /otc_footprint read) reduced to desk lines - this
 * is the flow-speed engine (up/dn print speed ratios, stagnation loops,
 * exhaustion), distinct from the plain tick footprint above. */
export function otcFootprintLines(fp: FootprintResult): string[] {
  const s = fp.summary
  const lines = [
    `velocity footprint (${fp.minutes}m window @${fp.bucketSec}s buckets, ${fp.dataSource}${fp.cadenceMs != null ? `, ${fp.cadenceMs}ms cadence` : ''}): engine verdict ${s.signal.toUpperCase()} score ${s.score >= 0 ? '+' : ''}${s.score} - net delta ${s.netDelta >= 0 ? '+' : ''}${s.netDelta} (${s.totalUp}u/${s.totalDn}d), avg speed ratio ${s.avgSpeedRatio.toFixed(2)}, POC ${s.dominantPoc != null ? s.dominantPoc.toFixed(5) : 'n/a'}`,
  ]
  if (s.note) lines.push(`engine note: ${s.note}`)
  return lines
}

export class AiTraderService {
  private ctx!: KernelContext
  private store!: Store
  private market!: MarketDataService
  private exec!: ExecutionService
  private meta: MetaStrategyService | null = null
  private screener: ScreenerService | null = null
  private config: AiTraderConfig = { ...DEFAULT_CONFIG }
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false // reentrancy guard - a slow LLM call must never overlap its own next tick
  private lastRunTs = 0
  private lastError: string | null = null
  /** asset -> epoch-seconds until which we don't even spend an LLM call on it,
   * set after a broker rejection matching AI_TRADER_BROKER_UNAVAILABLE_RE. */
  private assetRejectedUntil = new Map<string, number>()
  private cycles = 0
  /** Compounding roll state - only meaningful while config.stakePlan is
   * armed. Restored from the config blob on start(), persisted back on every
   * settle (persistPlanState) so the run survives kernel restarts. */
  private plan: AiTraderPlanState = { pot: 0, rollN: 0, restarts: 0, reseedCount: 0, lossReseedCount: 0, halted: false, complete: false }
  private unsubPlan: (() => void) | null = null

  private metaStrategyService(): MetaStrategyService | null {
    if (this.meta) return this.meta
    try {
      this.meta = this.ctx.use<MetaStrategyService>('metaStrategy')
    } catch {
      this.meta = null
    }
    return this.meta
  }

  private screenerService(): ScreenerService | null {
    if (this.screener) return this.screener
    try {
      this.screener = this.ctx.use<ScreenerService>('screener')
    } catch {
      this.screener = null
    }
    return this.screener
  }

  /** Lazy, fail-closed resolver for the desk-briefing services: caches only
   * SUCCESSFUL resolves (a null from a not-yet-registered plugin is retried
   * on the next cycle, so a briefing that boots before its siblings heals
   * instead of sticking empty forever). Every caller still wraps its USE in
   * try/catch - a registered service can still throw on a thin/unwarmed
   * asset, and that must degrade to "section omitted", never to a skipped
   * decision or a half-prompt. */
  private svcCache = new Map<string, unknown>()
  private svc<T>(name: string): T | null {
    const hit = this.svcCache.get(name)
    if (hit) return hit as T
    try {
      const s = this.ctx.use<T>(name)
      if (s) {
        this.svcCache.set(name, s)
        return s
      }
    } catch {
      // not registered (plugin disabled/absent) - keep null, retry next cycle
    }
    return null
  }

  /** Which assets THIS cycle should scan, before any concurrency budget is
   * applied - purely scanMode's own sourcing logic. */
  private buildCandidateList(): string[] {
    const { scanMode, asset, selectedAssets, tf, maxScanPerCycle } = this.config
    if (scanMode === 'selected') {
      const list = (selectedAssets ?? []).filter(Boolean)
      // an empty selection scans nothing useful - fall back to the single
      // configured asset rather than silently doing no work every cycle.
      return list.length ? list : [asset]
    }
    if (scanMode === 'global') {
      try {
        const scr = this.screenerService()
        if (scr) {
          const { rows } = scr.top({ tf, limit: maxScanPerCycle })
          if (rows.length) return rows.map((r) => r.asset)
        }
      } catch {
        // fall through to the raw-universe fallback below
      }
      // screener has no rows yet (just booted, or disabled) - fall back to
      // the raw asset universe rather than scanning nothing.
      try {
        return this.market.listAssets().slice(0, maxScanPerCycle).map((a) => a.ticker)
      } catch {
        return [asset]
      }
    }
    return [asset] // 'single' - unchanged original behavior
  }

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.store = ctx.use<Store>('store')
    this.market = ctx.use<MarketDataService>('market')
    this.exec = ctx.use<ExecutionService>('execution')
    // planState rides in the same blob as the config (persistPlanState) but
    // is NOT part of AiTraderConfig - strip it before sanitizing so a stale
    // blob field can never leak into status().config or a later save.
    const saved = this.store.getAiTraderConfig() as (Partial<AiTraderConfig> & { planState?: unknown }) | null
    const { planState, ...savedConfig } = saved ?? {}
    this.config = sanitizeAiConfig({ ...DEFAULT_CONFIG, ...(savedConfig ?? {}) })
    this.plan = sanitizeAiPlanState(planState)
    this.store.pruneAiTraderDecisions(1000)
    // settle hook: every closed AI Trader position (identified by the
    // strategy tag runCycleForAsset places orders with) feeds the roll -
    // same bus pattern the autopilot/meta-trader/watchdog use.
    this.unsubPlan = ctx.bus.on('positionClosed', ({ position }: { position: { strategy?: string; status: string; pnl?: number; amount?: number } }) => this.onPlanPositionClosed(position))
    ctx.log(
      'ai-trader',
      `AI Trader online - ${this.config.enabled ? 'ENABLED' : 'disabled'}, ${this.config.live ? 'LIVE' : 'shadow (logging only)'}, ${this.config.asset} ${this.config.tf}, every ${this.config.intervalMin}min${this.config.stakePlan ? `, compound pot (seed $${this.config.stakePlan.base}, roll x${this.plan.rollN}${this.plan.halted ? ', HALTED - restart to trade again' : ''})` : ''}`,
    )
    this.scheduleTimer()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubPlan?.()
    this.unsubPlan = null
  }

  private scheduleTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (!this.config.enabled) return
    const ms = Math.max(1, this.config.intervalMin) * 60 * 1000
    this.timer = setInterval(() => void this.runCycle(), ms)
  }

  getStatus() {
    return {
      config: this.config,
      enabled: this.config.enabled,
      live: this.config.live,
      running: this.running,
      cycles: this.cycles,
      lastRunTs: this.lastRunTs,
      nextRunTs: this.config.enabled && this.lastRunTs ? this.lastRunTs + this.config.intervalMin * 60 : null,
      lastError: this.lastError,
      // compounding roll state + the stake the NEXT trade would place - the
      // panel renders the pot/roll/halt strip and the restart button off
      // these instead of re-deriving the plan math client-side.
      planState: this.plan,
      nextStake: this.stakeFor(),
      // the actual URL a cycle will call RIGHT NOW (after APP_URL/config/
      // default resolution) - shown directly so there's no guessing whether
      // an env var or a saved config value is the one actually in effect.
      resolvedAppUrl: resolveAppUrl(this.config),
      // which providers THIS process currently sees as enabled/ready - the
      // direct way to check "did it actually pick up the shared .env"
      // instead of guessing from the cycle error message alone. Only the
      // FALLBACK path (see callLlm()) - the primary path's providers live
      // in the app process, not here.
      llm: providerStatus(),
    }
  }

  configure(patch: Partial<AiTraderConfig>): AiTraderConfig {
    const hadPlan = Boolean(this.config.stakePlan)
    this.config = sanitizeAiConfig({ ...this.config, ...patch })
    // dropping the plan (compound -> fixed) also drops the roll state, so a
    // later re-arm starts a FRESH cycle instead of resurrecting a stale
    // halted pot from a previous run - same fresh-start contract as switching
    // a bot's stake plan off in the fleet editor.
    if (hadPlan && !this.config.stakePlan) {
      this.plan = { pot: 0, rollN: 0, restarts: 0, reseedCount: 0, lossReseedCount: 0, halted: false, complete: false }
    }
    this.persistPlanState()
    this.scheduleTimer()
    this.emit(
      'info',
      `AI Trader config updated - ${this.config.enabled ? 'enabled' : 'disabled'} · ${this.config.live ? 'LIVE' : 'shadow'} · ${this.config.scanMode} · ${this.config.asset} ${this.config.tf} · every ${this.config.intervalMin}min · max ${this.config.maxConcurrent} concurrent${this.config.stakePlan ? ` · compound pot (seed $${this.config.stakePlan.base}, rollPct ${this.config.stakePlan.rollPct ?? 100}%)` : ''}`,
    )
    return this.config
  }

  /** THE FROZEN-CANDLE BUG: market-data's live poll only ever kept the
   * CHARTED asset + enabled bots' watchlists + the os-mode auto-trader's
   * watchlist warm with real broker ticks/candles (see livePollAssets() in
   * market-data.ts) - AI Trader's own scanned asset(s) were never added to
   * that set. If US2000 (or whatever AI Trader is pointed at) isn't also
   * charted or on one of those other watchlists, its candle series never
   * receives a fresh bar: every cycle re-reads the exact same stale closes,
   * so RSI/EMA/the "price ripped from 2836 to 2860" narrative/ATR all read
   * IDENTICAL cycle after cycle (and if whatever bar happened to be sitting
   * in that frozen window was itself a feed glitch, it never ages out of
   * the ATR(14) window either - compounding the earlier 500%-ATR symptom).
   * Exposed here so market-data can pull it in without a circular import -
   * disabled AI Trader or an enabled-but-empty scan returns nothing to add. */
  watchedAssets(): string[] {
    if (!this.config.enabled) return []
    try {
      return this.buildCandidateList().slice(0, this.config.maxScanPerCycle)
    } catch {
      return [this.config.asset]
    }
  }

  listDecisions(limit = 100): AiTraderDecision[] {
    return this.store.listAiTraderDecisions(limit) as AiTraderDecision[]
  }

  /** User-initiated "clear log" - wipes the whole decision history, not a
   * size-bound prune. Does not touch config/cycles/running state. */
  clearDecisions(): void {
    this.store.clearAiTraderDecisions()
    this.emit('info', 'AI Trader decision log cleared')
  }

  /** Manual trigger - the UI's "run a cycle now" button, and how this gets
   * tested without waiting out a real interval. Runs the exact same path
   * runCycle's timer calls, just on demand - including scanMode's candidate
   * selection and the live-mode concurrency budget, so a manual trigger can
   * come back with MULTIPLE decisions (one per asset actually scanned). */
  async runNow(): Promise<{ ok: boolean; decisions?: AiTraderDecision[]; error?: string }> {
    try {
      const ds = await this.runCycle()
      return ds && ds.length ? { ok: true, decisions: ds } : { ok: false, error: this.lastError ?? 'cycle did not produce a decision' }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  }

  /** A graded entry for one past decision - this is the "did I get it right"
   * feedback a human trader carries into the next call, fed back into the
   * NEXT prompt per direct instruction ("he should be allowed to know also
   * that his prediction went well or wrong, so he can learn from it"). */
  private gradeOne(
    r: { direction: string; expiryMin: number | null; priceAtDecision: number | null; acted: boolean; positionId: string | null; ts: number },
    candles: Candle[],
    nowSec: number
  ): 'win' | 'loss' | 'pending' | 'skip' | 'ungraded' {
    if (r.direction === 'skip') return 'skip'
    // A LIVE/acted trade has a real position with a real pnl - grade off
    // that, it's ground truth, not an estimate.
    if (r.acted && r.positionId) {
      try {
        const pos = this.store.getPosition(r.positionId)
        if (!pos) return 'ungraded'
        if (pos.status === 'open') return 'pending'
        return (pos.pnl ?? 0) > 0 ? 'win' : 'loss'
      } catch {
        return 'ungraded'
      }
    }
    // Shadow mode never opens a position, so there is no pnl to read back -
    // the only way it can ever learn from a shadow call is to self-grade it
    // against what price actually did: a CALL "wins" if price at ts+expiry
    // closed above price-at-decision, a PUT wins if it closed below. This
    // is an approximation (ignores payout/exact-strike mechanics) but it's
    // the right binary comparison for "was my DIRECTION call correct."
    if (!r.priceAtDecision || !r.expiryMin) return 'ungraded'
    const targetTs = r.ts + Math.round(r.expiryMin * 60)
    if (nowSec < targetTs) return 'pending' // expiry hasn't happened yet
    const future = candles.find((c) => c.time >= targetTs)
    if (!future) return 'ungraded' // expiry passed but no candle data reaches that far - can't grade, don't guess
    const won = r.direction === 'call' ? future.close > r.priceAtDecision : future.close < r.priceAtDecision
    return won ? 'win' : 'loss'
  }

  /** Grades the last few decisions on THIS exact asset+tf and formats them
   * as feedback for the next prompt - the model sees, in order, what it
   * called, how confident it was, and whether it was actually right, so it
   * can learn from its own track record instead of starting cold every
   * cycle. Deep candles (not just the short window runCycle already
   * fetched) so a shadow call from an hour ago can still be graded even
   * though its expiry window is well behind the current candle slice. */
  private gradeRecent(asset: string, tf: Timeframe, limit = 8): { lines: string; wins: number; losses: number; pending: number; calibration: string[] } {
    let deepCandles: Candle[] = []
    try {
      deepCandles = this.market.getCandlesDeep(asset, tf, 2200, true)
    } catch {
      deepCandles = []
    }
    const nowSec = Math.floor(Date.now() / 1000)
    let rows: ReturnType<Store['listAiTraderDecisions']> = []
    try {
      rows = this.store.listAiTraderDecisions(50).filter((r) => r.asset === asset && r.tf === tf)
    } catch {
      rows = []
    }
    const graded = rows.slice(0, limit).map((r) => ({ r, outcome: this.gradeOne(r, deepCandles, nowSec) }))
    const wins = graded.filter((g) => g.outcome === 'win').length
    const losses = graded.filter((g) => g.outcome === 'loss').length
    const pending = graded.filter((g) => g.outcome === 'pending').length
    const lines = graded.length
      ? graded
          .map(({ r, outcome }) => {
            const agoMin = Math.max(0, Math.round((nowSec - r.ts) / 60))
            if (r.direction === 'skip') return `- ${agoMin}min ago: SKIPPED - "${r.reasoning.slice(0, 160)}"`
            const verdict = outcome === 'win' ? 'WON' : outcome === 'loss' ? 'LOST' : outcome === 'pending' ? 'pending (expiry not reached yet)' : 'ungraded (no outcome data)'
            return `- ${agoMin}min ago: ${r.direction.toUpperCase()} @ ${r.confidence.toFixed(0)}% confidence, ${r.expiryMin ?? '?'}min expiry - ${verdict} - "${r.reasoning.slice(0, 160)}"`
          })
          .join('\n')
      : '- (no prior decisions on this exact asset+tf yet - this is a fresh start, no track record to lean on)'
    // SELF-CALIBRATION LOOP (precision upgrade): beyond the raw W/L list,
    // aggregate the graded calls by direction and by confidence bucket so
    // the model can see whether its own claimed confidence maps to reality
    // (e.g. "calls win 60% but puts win 25%" or "85%+ confidence wins no
    // more often than 65-74 did"). calibrationLines stays silent until
    // there are >=3 graded calls - no fake statistics off one or two rows.
    const calibration = calibrationLines(
      graded.map(({ r, outcome }) => ({ direction: r.direction, confidence: r.confidence, outcome })),
    )
    return { lines, wins, losses, pending, calibration }
  }

  /** ACCOUNT-WIDE calibration sample for calibratedConfidence() above.
   * gradeRecent() is deliberately scoped to ONE asset+tf (limit 8) for the
   * prompt's own narrative - accurate for "what has THIS pair done" but far
   * too thin a sample to safely base a numeric confidence haircut on (one or
   * two rows either way would swing the bucket's realized rate wildly). The
   * haircut instead draws on every ACTED trade across every asset/tf this
   * trader has ever placed, graded by its REAL settlement outcome
   * (won/lost on the position row, not a re-derivation from candles like
   * gradeOne does for shadow-mode rows) - acted trades are exactly the
   * population the calibration bucket needs to answer "when I claim 80%+ on
   * a CALL, how often do I actually win," and settlement status is ground
   * truth, not an estimate. */
  private accountCalibrationRows(limit = 400): CalibrationRow[] {
    let decisions: ReturnType<Store['listAiTraderDecisions']> = []
    try {
      decisions = this.store.listAiTraderDecisions(limit).filter((r) => r.acted && r.positionId && (r.direction === 'call' || r.direction === 'put'))
    } catch {
      decisions = []
    }
    const rows: CalibrationRow[] = []
    for (const d of decisions) {
      let pos: Position | null = null
      try {
        pos = this.store.getPosition(d.positionId!)
      } catch {
        pos = null
      }
      if (!pos) continue
      const outcome = pos.status === 'won' ? 'win' : pos.status === 'lost' ? 'loss' : pos.status === 'open' ? 'pending' : 'ungraded'
      rows.push({ direction: d.direction, confidence: d.confidence, outcome })
    }
    return rows
  }

  /** THE DESK BRIEFING - "an expert trader with access to all tools,
   * predictions and everything else we ever built." Every scanner, oracle
   * and learned model in this kernel reports here for ONE asset, each in
   * its own fail-closed compartment: a missing/warming/unready service
   * means its SECTION IS OMITTED (the model reads a shorter briefing), never
   * an error, never a skipped decision, never a fabricated "unavailable"
   * filler. Where a read carries its own live calibration (hit rate / Brier
   * score / pWin), the briefing includes it, so the model can WEIGHT reads
   * by their proven records instead of treating every label equally.
   * Returns { lines, sourcesSeen } - sourcesSeen (how many desk seats
   * actually reported) is surfaced in status()/the log as an honest health
   * count for the briefing itself. */
  /** Cheap pre-decision call: shows the model its OWN math (candle anatomy,
   * swing structure, per-expiry horizon reads, ATR%/RSI) plus the
   * OPTIONAL_DESK_SOURCES catalog, and asks which EXTRA desk seats (if any)
   * are worth computing before it decides. Per direct instruction - the
   * trader should know what works best for a particular pair rather than
   * always paying for the full 13-source spread. Fails CHEAP, not
   * expensive: any error, timeout, or unparseable reply here returns an
   * EMPTY set (core-only briefing), never the full set - a triage failure
   * must never silently escalate the next LLM call's cost, and the core
   * seats alone are always enough for a decision (the fail-closed gates
   * upstream already guaranteed real data to reason over). */
  private async triageSelectSources(
    asset: string,
    tf: Timeframe,
    horizonLines: string,
    recentCloses: string,
    anatomy: string[],
    structure: string[],
    atrPct: number,
    rsiLast: number,
    ownMathSummary?: string,
  ): Promise<Set<string>> {
    try {
      const menu = OPTIONAL_DESK_SOURCES.map((s) => `- ${s.id}: ${s.label}`).join('\n')
      const system: ChatMessage = {
        role: 'system',
        content: [
          'You are the same AI Trader about to decide on a binary-option trade. Before the full desk briefing is',
          'built, pick which EXTRA desk seats (if any) you actually want this cycle - you already have your own',
          'PRIMARY read (tick desk transactions, footprint pressure, the all-timeframe technical ladder,',
          'noise-filtered renko/range, SMC/ICT structure) and the CORE desk (next-candle oracle, the full tick',
          'desk incl. tick SMC and tick footprint, the OTC velocity footprint, the reversal detector, the',
          'technical summary ladder, and Accute) below for free, always. Pick only what would genuinely change or firm up your read for THIS',
          'asset+tf right now - not everything, not out of habit. A clear, high-conviction core read needs',
          'nothing extra; a genuinely unclear or conflicted one is worth spending a seat or two on. Different',
          'pairs and moments call for different tools - you decide what this one needs.',
          '',
          'Available extra seats:',
          menu,
          '',
          'Respond with ONLY a JSON object, no prose: {"use": [<zero or more ids from the list above>]}',
        ].join('\n'),
      }
      const user: ChatMessage = {
        role: 'user',
        content: [
          `${asset} ${tf}`,
          `your own candle anatomy: ${anatomy.join('; ') || '(n/a)'}`,
          `your own swing structure: ${structure.join('; ') || '(n/a)'}`,
          `ATR14 ${atrPct.toFixed(3)}% of price, RSI14 ${rsiLast.toFixed(1)}`,
          `recent closes: ${recentCloses}`,
          `per-expiry horizon reads:\n${horizonLines}`,
          ...(ownMathSummary ? [`own-math primary read (tick/footprint/technical/renko/range/SMC-ICT): ${ownMathSummary}`] : []),
        ].join('\n'),
      }
      const res = await callLlm(resolveAppUrl(this.config), [system, user], { temperature: 0, maxTokens: 150, timeoutMs: 15_000 })
      return parseTriageReply(res.content)
    } catch {
      // triage failure -> core-only briefing, never the expensive fallback
      return new Set<string>()
    }
  }

  /** `optionalIds` - the EXTRA desk seats this cycle's triage call (see
   * triageSelectSources) decided are worth their compute, from
   * OPTIONAL_DESK_SOURCES above. Every seat NOT gated on optionalIds below
   * is core: always computed, never skipped - either a named must-have
   * (own math/next-candle/tick desk/OTC velocity footprint/reversal/
   * technical/Accute) or a cheap, safety-relevant governance read
   * (session/risk-book/memory-gate/OTC-guard) that is never optional. */
  async deskBriefingFor(asset: string, tf: Timeframe, ts: number, stake: number, optionalIds: Set<string>): Promise<{ lines: string[]; sourcesSeen: number }> {
    const lines: string[] = []
    let sourcesSeen = 0
    const section = (header: string, body: string[]) => {
      if (!body.length) return
      lines.push(`[${header}]`, ...body)
      sourcesSeen += 1
    }

    // ---- 1. Next-candle oracle DEEP read (the 'oracle' panel row is one
    // label; here the model gets the engine's full geometry: pUp, cone,
    // expected candle shape, driver count, pattern hits, and the honesty
    // loop's own calibration of this exact (asset, tf) read)
    try {
      const oracle = this.svc<NextCandleService>('nextcandle')
      const p = oracle?.predict(asset, tf)
      if (oracle && p) {
        const body: string[] = []
        const conePct = p.atr > 0 && p.price > 0 ? (p.range.high - p.range.low) / p.price * 100 : 0
        body.push(
          `direction ${p.direction.toUpperCase()} (pUp ${(p.pUp * 100).toFixed(0)}%), confidence ${p.confidence.toFixed(0)}% (raw ${p.rawConfidence.toFixed(0)}% before the calibration discount), regime ${p.regime}, ${p.driversActive} drivers active`,
        )
        body.push(
          `expected next-candle geometry: move ~${p.expectedMove >= 0 ? '+' : ''}${p.expectedMove.toFixed(5)} (${p.atr > 0 ? `${(Math.abs(p.expectedMove) / p.atr).toFixed(2)}x ATR` : 'ATR n/a'}), range cone ${p.range.low.toFixed(5)}..${p.range.high.toFixed(5)} (${conePct.toFixed(3)}% wide), shape "${p.expectedCandleType}"`,
        )
        const cal = p.calibration
        body.push(
          cal
            ? `engine's OWN live record on this read: ${cal.n} graded calls, ${(cal.hitRate * 100).toFixed(0)}% hit rate, Brier ${cal.brier.toFixed(3)} (lower = better calibrated; weigh this read by this record)`
            : 'engine has NO live calibration record on this read yet (treat as unproven)',
        )
        if (p.patternHits.length) body.push(`candle patterns firing now: ${p.patternHits.map((h) => `${h.name} (${h.direction})`).join(', ')}`)
        if (p.altPrediction) body.push(`textbook cross-check (HMA/ROC/Bull-Bear, uncalibrated): ${p.altPrediction.direction.toUpperCase()} ${p.altPrediction.strength.toFixed(0)}%`)
        if (p.momentumPrediction) body.push(`multi-tf momentum score: ${p.momentumPrediction.direction.toUpperCase()} ${p.momentumPrediction.strength.toFixed(0)}%`)
        if (p.controlRead && p.controlRead.direction !== 'none')
          body.push(`order-flow control: ${p.controlRead.direction === 'buy' ? 'buyers' : 'sellers'} transacting-dominant ${p.controlRead.dominance.toFixed(0)}% over ${p.controlRead.barsChecked} bars${p.controlRead.fullControl ? ' - FULL control (every bar same side)' : ''}`)
        section('next-candle oracle (deep read)', body)
      }
    } catch {
      // omitted - the desk seat is empty this cycle
    }

    // ---- 1b. Accute DEEP read (CORE - named explicitly, per direct
    // instruction, alongside next-candle/tick/footprint/reversal/technical
    // as a tool this trader must always have at hand). Accute is itself a
    // weighted fusion of up to 5 drivers (ADX/Pattern, Tempo, Oracle, Zone,
    // Renko) with a decorrelation discount when Tempo and the Oracle agree
    // for the same reason - this is NOT the same as reading those drivers
    // individually elsewhere in this briefing, it's the platform's own
    // pre-fused cross-check, and `signal()` here is the read-only call
    // (never spends the shared one-shot license claim() does).
    try {
      const accute = this.svc<AccuteService>('accute')
      const r = accute?.signal(asset, tf)
      if (accute && r && r.ok && !r.waiting) {
        const body: string[] = [
          `fused read: ${r.direction.toUpperCase()} (pUp ${(r.pUp * 100).toFixed(0)}%), confidence ${r.confidence.toFixed(0)}%, ${r.driversActive} driver(s) active, agreement ${(r.agreement * 100).toFixed(0)}%`,
          `drivers: ${r.drivers.map((d) => `${d.name} pUp ${(d.pUp * 100).toFixed(0)}% (w=${d.weight.toFixed(2)})`).join(', ') || 'none active'}`,
        ]
        if (r.calibration) body.push(`engine's own live record: ${r.calibration.n} graded calls, ${(r.calibration.hitRate * 100).toFixed(0)}% hit rate`)
        section('Accute (ADX/DI+Pattern, Tempo, Oracle, Zone, Renko - weighted fusion)', body)
      }
    } catch {
      // omitted
    }

    // ---- 2. Next-expiry oracle (OPTIONAL - minute-native per-rung
    // probabilities - the single most expiry-relevant read for a binary
    // trader; rungs that match THIS trader's own expiry menu are marked so
    // the model can cross-check its expiry choice against the oracle's
    // per-rung pWin. Request it when your own expiry read is genuinely
    // unclear.)
    if (optionalIds.has('nextExpiry'))
    try {
      const exp = this.svc<NextExpiryService>('nextexpiry')
      const pred = exp?.predict(asset)
      if (exp && pred) {
        const body: string[] = []
        if (pred.halfLifeMin != null) body.push(`OU mean-reversion half-life: ~${pred.halfLifeMin}min (a compass for HOW FAR an expiry can plausibly see a round trip)`)
        if (pred.best) body.push(`oracle's best pick: ${pred.best.expiry}min ${pred.best.direction.toUpperCase()} (pWin ${(pred.best.pWin * 100).toFixed(0)}%, edge ${pred.best.edge >= 0 ? '+' : ''}${(pred.best.edge * 100).toFixed(1)}pp over coin-flip, confidence ${pred.best.confidence.toFixed(0)}%)`)
        else body.push(`oracle's best pick: NONE - "${'no edge right now'}" - the engine itself would wait`)
        const rungs = pred.rows
          .filter((r) => r.ok)
          .map((r) => `${r.expiry}m: ${r.direction} (pWin ${(r.pWin * 100).toFixed(0)}%, conf ${r.confidence.toFixed(0)}%)${(this.config.expiryChoices as number[]).includes(r.expiry) ? ' <= on YOUR menu' : ''}`)
        if (rungs.length) body.push(`per-expiry rungs (ok=true only; a rung still warming up or in its deadband is deliberately absent): ${rungs.join(' | ')}`)
        section('next-expiry oracle (1/2/3/5/15m honesty engine)', body)
      }
    } catch {
      // omitted
    }

    // ---- 3. Tempo desk (OPTIONAL - the shot-license read: is THIS pair's
    // own firing rhythm saying fire/wait/skip right now, with its own shot
    // record)
    if (optionalIds.has('tempo'))
    try {
      const tempo = this.svc<TempoService>('tempo')
      const row = tempo?.rowFor(asset, tf)
      if (tempo && row && row.ok) {
        const body: string[] = [
          `license decision: ${row.decision.toUpperCase()} - ${row.decisionReason}`,
          `conviction ${row.conviction.toFixed(0)} vs threshold ${row.threshold.toFixed(0)}, window closes in ${row.barsRemaining} bar(s), direction ${row.direction} (pUp ${(row.pUp * 100).toFixed(0)}%)`,
        ]
        if (row.shotStats && row.shotStats.n > 0) body.push(`tempo's own shot record on this pair: ${row.shotStats.n} shots, ${(row.shotStats.hitRate ?? 0) * 100 > 0 ? `${((row.shotStats.hitRate ?? 0) * 100).toFixed(0)}% hits` : 'hit rate not resolved yet'}`)
        if (row.lastShot) body.push(`last tempo shot: ${row.lastShot.direction} ${row.lastShot.hit ? 'HIT' : 'missed'}`)
        section('tempo desk (shot-license scanner)', body)
      }
    } catch {
      // omitted
    }

    // ---- 4. Confluence screener (OPTIONAL - the 14-factor mechanical
    // read; only when the sweeper already has a row - calling evaluate()
    // blind would trigger a fresh full-engine fit mid-cycle)
    if (optionalIds.has('confluenceScreener'))
    try {
      const s2 = this.svc<Screener2Service>('screener2')
      if (s2 && s2.hasRow(asset, tf)) {
        const row = s2.evaluate(asset, tf)
        const top = [...row.factors].sort((a, b) => Math.abs(b.vote * b.weight) - Math.abs(a.vote * a.weight)).slice(0, 3)
        section(
          'confluence screener (14-factor mechanical read)',
          [
            `score ${row.score >= 0 ? '+' : ''}${row.score.toFixed(0)} -> ${row.direction.toUpperCase()} at ${row.confidence.toFixed(0)}% confidence`,
            `strongest factors: ${top.map((f) => `${f.name} ${f.vote >= 0 ? '+' : ''}${f.vote.toFixed(1)} (${f.note})`).join('; ')}`,
          ],
        )
      }
    } catch {
      // omitted
    }

    // ---- 5. Screener rank + OU stretch (OPTIONAL - how stretched is price
    // from its equilibrium RIGHT NOW - the classic reversion tell with a
    // half-life attached; plus this asset's rank among the universe's best
    // rows)
    if (optionalIds.has('screenerRank'))
    try {
      const scr = this.svc<ScreenerService>('screener')
      if (scr) {
        const { rows } = scr.top({ tf, limit: 40 })
        const idx = rows.findIndex((r) => r.asset === asset)
        const row = idx >= 0 ? rows[idx] : null
        const body: string[] = []
        if (row) {
          body.push(
            `universe rank #${idx + 1} of ${rows.length} screened rows at score ${row.score >= 0 ? '+' : ''}${row.score.toFixed(0)} (${row.direction.toUpperCase()}, pUp ${(row.pUp * 100).toFixed(0)}%, regime ${row.regime})`,
          )
          body.push(
            `OU stretch: ${row.ouZ >= 0 ? '+' : ''}${row.ouZ.toFixed(2)} sigmas from equilibrium${row.ouMeanReverting ? `, mean-reverting fit CONFIRMED (half-life ~${row.ouHalfLife === 9999 ? 'effectively none' : `${row.ouHalfLife} bars`}, t-stat ${row.ouTStat.toFixed(1)})` : ' (no confirmed mean-reversion fit - stretch alone is not a signal here)'}`,
          )
        }
        section('screener rank + OU stretch', body)
      }
    } catch {
      // omitted
    }

    // ---- 6. SMC structure scan (OPTIONAL - candle-built BOS/CHoCH trend +
    // signal counts, separate from tick SMC in the core tick desk below.
    // The model has its OWN swing-structure read in the user message too;
    // request this when the tick tape is stale/thin and a candle-based
    // structure cross-check is worth the call.)
    if (optionalIds.has('smcScan'))
    try {
      const smc = this.svc<SmcScanService>('smcScan')
      const resp = smc?.scan(asset, tf)
      if (smc && resp?.ok && resp.result) {
        const r = resp.result
        section('SMC structure scan', [
          `structure trend ${r.trend.toUpperCase()}, engine summary ${r.summary.direction.toUpperCase()} at ${r.summary.confidence.toFixed(0)}% (${r.summary.bullish} bullish / ${r.summary.bearish} bearish signals in the window)`,
        ])
      }
    } catch {
      // omitted
    }

    // ---- 7. Chart signals (OPTIONAL - pattern committee; direction may be
    // a deliberate FADE of the committee's own read - both sides shown)
    if (optionalIds.has('chartSignals'))
    try {
      const cs = this.svc<ChartSignalsService>('chartSignals')
      const res = cs?.peek('option', tf)
      if (cs && res?.ok) {
        const mine = res.signals.filter((s) => s.asset === asset)
        const body = mine.slice(0, 2).map((s) => {
          const faded = s.rawDirection !== s.direction ? ` (committee read ${s.rawDirection.toUpperCase()} ${s.strength.toFixed(0)}% - suggested trade is the FADE)` : ''
          return `${s.direction.toUpperCase()} suggested at strength ${s.strength.toFixed(0)}${faded}`
        })
        section('chart-signal committee', body)
      }
    } catch {
      // omitted
    }

    // ---- 8. Lead-lag (OPTIONAL - is a correlated leader already moving
    // FIRST)
    if (optionalIds.has('leadLag'))
    try {
      const ll = this.svc<LeadLagScanService>('leadLagScan')
      const res = ll?.scan(tf)
      if (ll && res?.ok) {
        const mine = res.rows.filter((r) => r.asset === asset && r.direction != null).slice(0, 2)
        const body = mine.map((r) => `leader ${r.leader} leads this pair by ${r.lag} bar(s) (corr ${r.correlation.toFixed(2)}, n=${r.n}): leader just moved ${(r.triggerReturn * 100).toFixed(3)}% (${r.triggerZ >= 0 ? '+' : ''}${r.triggerZ.toFixed(1)} sigma) -> suggests ${r.direction === 'call' ? 'CALL' : 'PUT'}`)
        section('lead-lag scanner', body)
      }
    } catch {
      // omitted
    }

    // ---- 9. Vol-arb (OPTIONAL - volatility dislocation vs peers)
    if (optionalIds.has('volArb'))
    try {
      const va = this.svc<VolArbScanService>('volArbScan')
      const res = va?.scan(tf)
      if (va && res?.ok) {
        const mine = res.rows.filter((r) => r.asset === asset).slice(0, 1)
        const body = mine.map((r) => `close-vol/range-vol ratio ${r.ratio.toFixed(2)} (fade below 0.6, continue above 1.6): regime ${r.regime}, momentum ${(r.momentum * 100).toFixed(1)}%, last bar ${r.lastBarDir === 1 ? 'up' : r.lastBarDir === -1 ? 'down' : 'flat'}${r.direction ? ` -> scanner leans ${r.direction.toUpperCase()}` : ''}`)
        section('volatility-arb scan', body)
      }
    } catch {
      // omitted
    }

    // ---- 10. Cointegration (OPTIONAL - spread stretch vs a statistical
    // pair)
    if (optionalIds.has('cointegration'))
    try {
      const ci = this.svc<CointegrationScanService>('cointegrationScan')
      const res = ci?.scan(tf)
      if (ci && res?.ok) {
        const mine = res.rows.filter((r) => r.asset === asset).slice(0, 1)
        const body = mine.map((r) => `spread vs ${r.leader} (beta ${r.beta.toFixed(2)}, R2 ${r.r2.toFixed(2)}, n=${r.n}): z ${r.z >= 0 ? '+' : ''}${r.z.toFixed(2)} sigmas, half-life ~${r.halfLifeBars} bars -> scanner suggests ${r.direction?.toUpperCase() ?? 'no trade'}`)
        section('cointegration scan (spread reversion)', body)
      }
    } catch {
      // omitted
    }

    // ---- 11. Yesterday echo (OPTIONAL - same-time-24h-ago replay: did
    // this hour have a rhyme last session; async + cached, raced with a
    // short timeout so a cold first scan can never stall the decision loop
    // - the loser keeps warming the cache for the NEXT cycle)
    if (optionalIds.has('yesterdayEcho'))
    try {
      const yd = this.svc<YesterdayService>('yesterday')
      if (yd) {
        const scan = yd.scan(tf, 60, 1).then((r) => ({ r })).catch(() => null)
        const timeout = new Promise<{ r: null }>((res) => setTimeout(() => res({ r: null }), 2500))
        const got = await Promise.race([scan, timeout])
        const row = got?.r?.rows.find((r) => r.asset === asset)
        if (row) {
          const body = [
            `same hour yesterday: window moved ${row.movePct >= 0 ? '+' : ''}${row.movePct.toFixed(3)}% (${row.dir}), range ${row.rangePct.toFixed(3)}%, run-up ${row.runUpPct.toFixed(3)}% / drawdown ${row.drawdownPct.toFixed(3)}%`,
          ]
          if (row.echo) body.push(`lead-in echo: yesterday's lead-in ${row.echo.ydayMovePct >= 0 ? '+' : ''}${row.echo.ydayMovePct.toFixed(3)}% vs today's ${row.echo.todayMovePct >= 0 ? '+' : ''}${row.echo.todayMovePct.toFixed(3)}% -> directions ${row.echo.dirAgree}, rhyme score ${row.echo.rhyme.toFixed(0)}/100${row.echo.quiet ? ' (BOTH windows flat - the agreement is trivial, ignore it)' : ''}`)
          body.push('(a rhyme is a weak prior, not a signal - markets rhyme, they do not repeat)')
          section('yesterday echo (T-24h replay)', body)
        }
      }
    } catch {
      // omitted
    }

    // ---- 12. Session (which market-center window is this; OTC pairs get
    // their synthetic feed labeled honestly)
    try {
      const sess = classifySession(ts, asset)
      const note =
        sess === 'OVERLAP'
          ? 'London+NY overlap - historically the most liquid, most directional window'
          : sess === 'OFF'
            ? 'post-NY close dead hours - thinnest liquidity of the day, chop and spike risk both elevated'
            : sess === 'OTC'
              ? 'synthetic OTC feed - no real market session behind it, generated walk; treat session-based priors as VOID'
              : sess === 'ASIA'
                ? 'Asian session - typically thinner, range-prone for FX majors'
                : sess === 'LONDON'
                  ? 'London session - full liquidity, trend-friendly for EUR/GBP pairs'
                  : 'New York session - full liquidity, data releases land in this window'
      section('trading session', [`${sess} - ${note}`])
    } catch {
      // omitted
    }

    // ---- 13. Risk book (a real trader checks the book before adding risk:
    // total exposure, correlated exposure on THIS asset, trade cadence,
    // drawdown, and the cross-asset correlation regime)
    try {
      const sent = this.svc<SentinelService>('sentinel')
      if (sent) {
        const exp = sent.exposure()
        const corr = sent.correlatedExposure(asset)
        const body = [
          `book: $${exp.total.toFixed(2)} total open exposure, ${sent.tradesLastHour()} trade(s) placed in the last hour, day drawdown ${sent.drawdownPct().toFixed(1)}%`,
        ]
        if (corr.total > 0) body.push(`OPEN correlated exposure on ${corr.assets.join(', ')} worth $${corr.total.toFixed(2)} - adding a position here stacks correlated risk on top of it`)
        const regime = sent.correlationRegime()
        if (regime.state !== 'normal') body.push(`cross-asset correlation regime: ${regime.state.toUpperCase()} (estimated panic probability next hour ${(regime.nextPanicProb * 100).toFixed(0)}%, sample ${regime.sample}) - in this regime correlated pairs move together and diversification does not protect you; demand extra edge`)
        section('risk book (sentinel)', body)
      }
    } catch {
      // omitted
    }

    // ---- 14. Memory gate (the operator's own configured trading rules)
    try {
      const mg = this.svc<MemoryGateService>('memoryGate')
      if (mg) {
        const gate = mg.check(asset, stake)
        if (!gate.ok) section('memory gate (operator rules)', [`BLOCKED for ${asset}: ${gate.reason ?? 'rule matched'} - treat this as a hard skip for this asset`])
        else if (gate.reason) section('memory gate (operator rules)', [`passed: ${gate.reason}`])
      }
    } catch {
      // omitted
    }

    // ---- 15. OTC guard (honest OTC flag + the defense guard's latest
    // placebo verdict for this pair - surfaced, NOT enforced; enforcement
    // stays with the global risk manager)
    try {
      const otc = this.svc<OtcGuardService>('otcGuard')
      if (otc && otc.isOtc(asset)) {
        const st = otc.statusFor(asset, 'ai-trader')
        const v = st.verdict as { verdict: string; realWinRate: number; realTrades: number; placeboWrMean: number; placeboWrStd: number; placeboSeries: number; calibrationSource: string } | null | undefined
        section(
          'OTC guard',
          [
            `${asset} is an OTC (synthetic feed) instrument`,
            v
              ? `defense guard's latest placebo verdict: ${String(v.verdict).toUpperCase()} (this strategy family's real win rate ${v.realWinRate.toFixed(1)}% over ${v.realTrades} trades vs the placebo field's ${v.placeboWrMean.toFixed(1)}% +/-${v.placeboWrStd.toFixed(1)} over ${v.placeboSeries} series, via ${v.calibrationSource})`
              : 'defense guard has no placebo verdict recorded for this pair yet - read is UNVERIFIED against synthetic-feed calibration',
          ],
        )
      }
    } catch {
      // omitted
    }

    // ---- 16. AI Lab (OPTIONAL - learned specs live on this exact
    // asset+tf, with their holdout honesty)
    if (optionalIds.has('aiLab'))
    try {
      const lab = this.svc<StrategyLabService>('lab')
      const rows = lab?.list() ?? []
      const mine = rows.filter((r) => r.asset === asset && r.tf === tf).slice(0, 3)
      const body: string[] = []
      for (const r of mine) {
        const h = r.stats?.holdout
        const be = r.stats?.breakeven
        if (h) body.push(`learned spec "${r.id}"${r.stats?.decayed ? ' (DECAYED - edge did not survive fresh data)' : ''}: holdout ${h.winRate.toFixed(1)}% over ${h.trades} trades vs breakeven ${be != null ? be.toFixed(1) : '?'}% (net ${h.netPnl >= 0 ? '+' : ''}${h.netPnl.toFixed(2)})`)
        else body.push(`learned spec "${r.id}" present but has no holdout metrics yet`)
      }
      section('AI Lab (learned strategies on this asset)', body)
    } catch {
      // omitted
    }

    // ---- 17. TICK DESK (the raw micro-tick print stream - tape freshness
    // first, then the four tick-built engines: SMC on tick candles, the tick
    // next-candle oracle, the technical-summary ladder, the measured-print
    // footprint with its delta slope). Per direct instruction the trader is
    // VOLUME-AWARE and STALENESS-AWARE: the tape line says how old the
    // stream is (STALE = discount everything below), the flow lines are
    // measured up/down prints - the feed's own volume evidence.
    try {
      const ofp = this.svc<OtcFootprintService>('otcFootprint')
      const ticks = ofp?.ticksFor(asset) ?? []
      if (ticks.length) {
        const nowMs = Date.now()
        section('tick desk (raw micro-tick stream: tape health / tick SMC / tick oracle / tick technical / tick footprint)', [...tapeHealthLines(ticks, nowMs), ...tickDeskLines(ticks, nowMs)])
      }
    } catch {
      // omitted - no tick collector or no prints yet
    }

    // ---- 18. OTC velocity footprint (the flow-SPEED engine: up/dn print
    // speed ratios, stagnation loops, exhaustion - async read off the same
    // collector, raced with a short timeout exactly like the yesterday-echo
    // seat so a cold pull can never stall the decision loop)
    try {
      const ofp = this.svc<OtcFootprintService>('otcFootprint')
      if (ofp) {
        const fp = ofp.footprint(asset, { minutes: 30, bucketSec: 60 }).then((r) => ({ r })).catch(() => null)
        const timeout = new Promise<{ r: null }>((res) => setTimeout(() => res({ r: null }), 2500))
        const got = await Promise.race([fp, timeout])
        if (got?.r) section('OTC velocity footprint (print-speed order flow, 30m)', otcFootprintLines(got.r))
      }
    } catch {
      // omitted
    }

    // ---- 19. FULL INDICATOR BOARD (per direct instruction: "do the ai
    // trader have access to all our indicators, or it's still only having
    // rsi and atr" - the honest answer WAS rsi/atr/ema only; this seat
    // reports every indicator family analytics/indicators.ts offers, each
    // reduced to name + value + stance, so the trader's chartist pass
    // covers the whole board: 9 trend reads, 16 momentum oscillators, the
    // volatility band/width suite, the volume-flow family (honest n/a on a
    // zero-volume feed) and the pivot/fib levels. A WARMING board (thin
    // history) prints its honest note and is omitted like any other seat.
    // OPTIONAL - this is the biggest single seat in the briefing; request
    // it when your own math and the core reads leave the chartist picture
    // genuinely unclear, not as a default every-cycle pass.)
    if (optionalIds.has('indicatorBoard'))
    try {
      let board: Candle[] = []
      try {
        board = this.market.getCandlesDeep(asset, tf, 300, true)
      } catch {
        board = []
      }
      const boardLines = board.length ? indicatorBoardLines(board) : []
      // indicatorBoardLines returns a warming note even on thin history -
      // surface that honestly rather than silently omitting the seat.
      if (boardLines.length) section('indicator board (the FULL indicator workup: trend / momentum / volatility / volume / levels, every read name value [BULL|BEAR|=|n/a])', boardLines)
    } catch {
      // omitted
    }

    // ---- 20. Reversal detector (the "is this turning RIGHT NOW" state
    // engine - calm/forming/reversing/confirmed across the same 10-rung
    // timeframe ladder the Technical Summary panel uses, down to sub-minute
    // tick-built rungs on a live feed). This is the human operator's own
    // Reversal panel, read exactly as they would read it: the model gets
    // the single most urgent live rung plus a quick per-rung strip so it
    // can see whether a reversal is forming on the trader's exact tf or
    // only on a faster/slower rung.
    try {
      const rv = this.svc<ReversalService>('reversal')
      const sum = rv?.readFor(asset)
      if (sum) {
        const body: string[] = []
        if (sum.best) {
          body.push(
            `most urgent live rung: ${sum.best.tf} is ${sum.best.state.toUpperCase()} ${sum.best.direction.toUpperCase()} (score ${sum.best.score})`,
          )
        } else {
          body.push('every live rung reads CALM - no reversal forming anywhere on the ladder right now')
        }
        const mine = sum.rows.find((r) => r.tf === tf)
        if (mine && mine.ok) body.push(`on YOUR OWN tf (${tf}): ${mine.state.toUpperCase()} ${mine.direction.toUpperCase()} (score ${mine.score})${mine.reasons.length ? ` - ${mine.reasons[0].note}` : ''}`)
        const strip = sum.rows.filter((r) => r.ok).map((r) => `${r.tf}:${r.state[0].toUpperCase()}${r.direction === 'up' ? '^' : r.direction === 'down' ? 'v' : '-'}`).join(' ')
        if (strip) body.push(`ladder strip: ${strip}`)
        section('reversal detector (calm/forming/reversing/confirmed, 10-rung ladder incl. sub-minute tick rungs)', body)
      }
    } catch {
      // omitted
    }

    // ---- 21. Technical Summary (the investing.com-style oscillator + MA
    // vote panel, same 10-rung ladder as the Reversal seat above - this is
    // the human operator's OWN Technical Summary panel, not a duplicate of
    // the indicator board: that board is raw name/value/stance per
    // indicator on ONE tf, this is BUY/SELL/NEUTRAL vote counts cross-checked
    // across every rung from sub-minute ticks up).
    try {
      const tc = this.svc<TechnicalService>('technical')
      const sum = tc?.summaryFor(asset)
      if (sum) {
        const body = [
          `cross-timeframe consensus: ${sum.overall.label} (score ${sum.overall.score >= 0 ? '+' : ''}${sum.overall.score.toFixed(2)}, ${sum.overall.buys}B/${sum.overall.sells}S/${sum.overall.neutrals}N of ${sum.overall.counted} rungs counted) -> leans ${sum.direction.toUpperCase()}`,
        ]
        const mine = sum.rows.find((r) => r.tf === tf)
        if (mine && mine.ok) body.push(`on YOUR OWN tf (${tf}): oscillators ${mine.oscSummary.label} (${mine.oscSummary.buys}B/${mine.oscSummary.sells}S), ${mine.source === 'ticks' ? `tick-built (${mine.ticksPerBar?.toFixed(1) ?? '?'} prints/bar)` : mine.source}`)
        section('technical summary (oscillator+MA vote ladder, same rungs as the reversal seat)', body)
      }
    } catch {
      // omitted
    }

    // ---- 22. MSL / Meta-Strategy (OPTIONAL, per direct instruction: "msl
    // is for when it actually need it" - the operator's OWN saved
    // meta-strategy specs and scripts, evaluated live against THIS
    // asset+tf exactly as Meta Trader or the MSL editor would run them.
    // This is NOT the same as seat/snapshot's static panel reads above
    // (oracle/smc/renko/etc labels) - these are the operator's own
    // hand-built logic. A spec that errors on this asset (wrong script
    // assumptions, thin history) is skipped silently - one broken saved
    // spec must never blank the whole desk seat.)
    if (optionalIds.has('msl'))
    try {
      const msl = this.metaStrategyService()
      const specs = msl?.list() ?? []
      const body: string[] = []
      for (const spec of specs.slice(0, 10)) {
        try {
          const { result } = msl!.evaluate(spec.id, asset, tf)
          if (result.direction === 'none') continue
          const expiryTag = result.expiryMin ? `, script's own preferred expiry ${result.expiryMin}min` : ''
          body.push(`"${spec.name}" (${spec.mode}): ${result.direction.toUpperCase()} ${result.confidence.toFixed(0)}%${expiryTag}${result.notes ? ` - ${result.notes}` : ''}`)
        } catch {
          // this spec doesn't resolve on this asset/tf - skip it, not the whole seat
        }
      }
      if (body.length) section('MSL / meta-strategy (your own saved specs and scripts, evaluated live on this asset+tf)', body)
    } catch {
      // omitted
    }

    return { lines, sourcesSeen }
  }

  /** The orchestrator the timer (and runNow()) actually calls - picks WHICH
   * asset(s) to scan this cycle (scanMode), applies the live-mode
   * concurrency budget, then runs the full per-asset analysis pipeline
   * (runCycleForAsset) on each candidate it can actually afford to act on. */
  private async runCycle(): Promise<AiTraderDecision[] | null> {
    if (this.running) return null // reentrancy guard - see field comment
    this.running = true
    const ts = Math.floor(Date.now() / 1000)
    this.lastRunTs = ts
    this.cycles += 1
    try {
      // compound stop-on-loss / periods-complete: a halted cycle stands down
      // ENTIRELY - no snapshot, no candles, no LLM call, no order - until the
      // operator explicitly restarts it (the same "restart to trade again"
      // contract the autopilot bots' compound plans and the meta-trader use).
      // Logged as a skip row each cycle so the decision log keeps telling the
      // truth about WHY nothing is happening.
      if (this.config.stakePlan && this.plan.halted) {
        const why = this.plan.complete
          ? `compound cycle COMPLETE (${this.plan.rollN}/${this.config.stakePlan.periods ?? '?'} periods banked) - standing down until restarted, no LLM call made`
          : 'compound cycle ended on a loss - standing down until restarted, no LLM call made'
        this.store.recordAiTraderDecision({
          asset: this.config.asset, tf: this.config.tf, direction: 'skip', confidence: 0,
          reasoning: why, snapshot: [], live: this.config.live, acted: false, ts,
        })
        this.emit('warn', `[AI Trader] ${why}`)
        return null
      }
      const candidates = this.buildCandidateList()
      if (!candidates.length) {
        this.lastError = 'no candidate assets to scan this cycle'
        return null
      }

      // Concurrency budget - LIVE mode only (see maxConcurrent's field
      // comment: shadow never opens a real position, so nothing is
      // "concurrent" to cap). At/over the cap, skip the WHOLE cycle before
      // any snapshot/candle/LLM work happens - answering "should it run a
      // cycle when one trade is not completed yet" with: no, not when
      // there's no room left to act on whatever it would decide.
      //
      // AUDIT (real deployment bug, "in selected, it's only trying one
      // instead of checking others too"): this used to also clamp the SCAN
      // budget itself down to the free slot COUNT (`budget =
      // Math.min(budget, slots)`), not just gate whether there is ANY room
      // at all. With the default maxConcurrent:1 and zero open positions,
      // slots was always exactly 1 - so scanMode 'selected'/'global' could
      // never analyze more than the FIRST candidate in the list, ever,
      // regardless of maxScanPerCycle or how many assets were selected
      // (every single logged decision landed on candidates[0]). Analyzing
      // extra candidates is harmless on its own - it costs an LLM call, not
      // a position - the in-loop re-check right below already stops NEW
      // orders the moment concurrency actually fills, live, candidate by
      // candidate. So the slot count now only answers "is there room to act
      // on ANYTHING at all this cycle" (0 slots -> skip the whole cycle,
      // unchanged), never "how many candidates are we allowed to look at."
      let budget = Math.min(candidates.length, this.config.maxScanPerCycle)
      if (this.config.live) {
        const allOpen = this.store.listPositions('open')
        const openCount = allOpen.filter((p) => p.strategy === 'ai-trader').length
        // DIAGNOSTIC (operator report: "max concurrent is 1 but it still
        // trades more than one at a time without one finishing"): maxConcurrent
        // only ever counts THIS trader's own positions (strategy ===
        // 'ai-trader') - verified against the singleton service, the
        // reentrancy guard, and the sequential per-candidate loop below, none
        // of which can let AI Trader itself open a 2nd position of its own
        // before the 1st is recorded. What a "more than one open at once" view
        // in the UI most likely means is a DIFFERENT concurrent source - a
        // manual TradeTicket trade, an autopilot bot, Meta-Strategy, etc. -
        // opening its own position around the same time, which this cap was
        // never meant to gate. Surfacing the account-wide count alongside AI
        // Trader's own count here (and in the acted-decision log below) lets
        // the operator tell the two apart from the decision log itself,
        // instead of having to take my word for which positions are whose.
        const otherOpen = allOpen.length - openCount
        const slots = Math.max(0, this.config.maxConcurrent - openCount)
        if (slots <= 0) {
          this.store.recordAiTraderDecision({
            asset: candidates[0], tf: this.config.tf, direction: 'skip', confidence: 0,
            reasoning: `at max concurrent AI Trader position(s) (${openCount}/${this.config.maxConcurrent} open)${otherOpen ? ` - ${otherOpen} OTHER non-AI-Trader position(s) also open on the account right now (manual/autopilot/meta-strategy, not capped by this setting)` : ''} - cycle skipped before any analysis, no LLM call made`,
            snapshot: [], live: this.config.live, acted: false, ts,
          })
          this.emit('info', `[AI Trader] skipping cycle - already at max concurrent positions (${openCount}/${this.config.maxConcurrent})${otherOpen ? ` · ${otherOpen} other non-AI-Trader position(s) also open` : ''}`)
          return null
        }
      }

      const decisions: AiTraderDecision[] = []
      for (const candidate of candidates.slice(0, budget)) {
        const d = await this.runCycleForAsset(candidate, this.config.tf, ts)
        if (d) decisions.push(d)
        // A trade opened by one candidate consumes a concurrency slot the
        // NEXT candidate in this same loop might have been counting on -
        // re-check before continuing rather than trusting the budget
        // computed before any of them ran.
        if (this.config.live && d?.acted) {
          const openNow = this.store.listPositions('open').filter((p) => p.strategy === 'ai-trader').length
          if (openNow >= this.config.maxConcurrent) break
        }
      }
      return decisions.length ? decisions : null
    } finally {
      this.running = false
    }
  }

  /** Full own-analysis -> desk-cross-check -> learn-from-track-record ->
   * decide pipeline for ONE asset - unchanged from the original single-
   * asset runCycle, just parameterized so the orchestrator above can call
   * it once per scanned candidate instead of always on `this.config.asset`. */
  private async runCycleForAsset(asset: string, tf: Timeframe, ts: number): Promise<AiTraderDecision | null> {
    try {
      // Broker-rejection cooldown - BEFORE any snapshot/candle/LLM work,
      // same fail-closed spirit as the stale-candle gate below. Without
      // this, an asset whose option book the broker has closed/suspended
      // (weekend hours, delisted, etc.) gets a full desk briefing + LLM
      // call + a place-order attempt EVERY single cycle forever, each one
      // rejected the same way - pure wasted spend and decision-log noise.
      const rejectedUntil = this.assetRejectedUntil.get(asset) ?? 0
      if (rejectedUntil > ts) {
        this.store.recordAiTraderDecision({
          asset, tf, direction: 'skip', confidence: 0,
          reasoning: `broker rejected this asset recently (option book closed/suspended) - cooling down for ${Math.round((rejectedUntil - ts) / 60)} more min, cycle skipped before any analysis, no LLM call made`,
          snapshot: [], live: this.config.live, acted: false, ts,
        })
        return null
      }
      const meta = this.metaStrategyService()
      const snapshot = meta ? meta.snapshotSources(asset, tf) : []
      let price = 0
      try {
        price = this.market.getPrice(asset)
      } catch {
        price = 0
      }
      const graded = this.gradeRecent(asset, tf, 8)

      // Raw candles - the model does its OWN read of price action here,
      // it is not just tallying what other predictors already concluded.
      // Need enough bars to cover both a real ATR(14) and the longest
      // expiry choice's lookback window, with headroom.
      const tfSec = tfSeconds(tf)
      const longestExpiryBars = Math.max(1, ...this.config.expiryChoices.map((m) => Math.round((m * 60) / tfSec)))
      const candleLimit = Math.max(80, longestExpiryBars * 4 + 30)
      let candles: Candle[] = []
      try {
        candles = this.market.getCandles(asset, tf, candleLimit, true)
      } catch {
        candles = []
      }

      const closePrices = closes(candles)

      // AUDIT: fail-closed gates, BEFORE any LLM spend - no price, thin
      // history, or a stale/frozen series must resolve to a logged skip,
      // never to a model judgment call (and never to a live order). See
      // MIN_CANDLES_FOR_DECISION / staleToleranceSec above for the why.
      const lastCandle = candles.length ? candles[candles.length - 1] : null
      const staleSec = staleToleranceSec(tfSec)
      const noPrice = !(Number.isFinite(price) && price > 0)
      const thin = closePrices.length < MIN_CANDLES_FOR_DECISION
      const stale = !lastCandle || !(lastCandle.time > 0) || ts - lastCandle.time > staleSec
      if (noPrice || thin || stale) {
        const why = noPrice
          ? `no live price for ${asset} - cycle skipped before any analysis, no LLM call made`
          : thin
            ? `thin history (${closePrices.length}/${MIN_CANDLES_FOR_DECISION} closed candles) - cycle skipped before any analysis, no LLM call made`
            : `stale candle series (last closed bar ${lastCandle && lastCandle.time > 0 ? `${Math.round((ts - lastCandle.time) / 60)}min old, tolerance ${Math.round(staleSec / 60)}min` : 'unusable'}) - cycle skipped before any analysis, no LLM call made`
        this.store.recordAiTraderDecision({
          asset, tf, direction: 'skip', confidence: 0,
          reasoning: why,
          snapshot: [], live: this.config.live, acted: false, ts,
        })
        return null
      }

      const highPrices = highs(candles)
      const lowPrices = lows(candles)
      const atrSeries = closePrices.length >= 15 ? atr(highPrices, lowPrices, closePrices, 14) : []
      const atrLast = atrSeries.length ? atrSeries[atrSeries.length - 1] : 0
      const rawAtrPct = price > 0 && atrLast > 0 ? (atrLast / price) * 100 : 0
      // Use the glitch-resistant read (see robustAtrPct) for everything that
      // actually drives a decision - the per-expiry signal-to-noise below,
      // and the confidence/skip logic - so one bad feed bar can't silently
      // nuke every horizon's snr to 0.00x. Standard Wilder ATR% stays in the
      // trend-context line sent to the model as a secondary data point.
      const atrPct = robustAtrPct(highPrices, lowPrices, closePrices, price, 14) || rawAtrPct
      const rsiSeries = closePrices.length >= 15 ? rsi(closePrices, 14) : []
      // RSI kept ONLY as a minor secondary context figure (sent to triage,
      // never framed as a directional own-math vote any more - see the
      // PRECISION REWORK block below). EMA9/21 crossover is GONE entirely:
      // per direct instruction, moving averages are replaced as the
      // trend-confirmation role by the noise-filtered renko/range votes.
      const rsiLast = rsiSeries.length ? rsiSeries[rsiSeries.length - 1] : 50

      const horizons = closePrices.length ? buildHorizonReads(closePrices, tfSec, this.config.expiryChoices, atrPct) : []
      const horizonLines = horizons.length
        ? horizons
            .map(
              (h) =>
                `- ${h.expiryMin}min expiry (~${h.bars} x ${tf} bars): net move over that exact window ${h.momentumPct >= 0 ? '+' : ''}${h.momentumPct.toFixed(3)}% (${h.upBars} up-bars / ${h.downBars} down-bars), signal-to-noise ${h.snr.toFixed(2)}x` +
                (h.snr >= 1 ? ' (drift exceeds typical noise for this window - a real move, not just chop)' : h.snr >= 0.5 ? ' (borderline - could be either)' : ' (well within noise - likely just chop, not a trend)')
            )
            .join('\n')
        : '- (not enough candle history yet to compute per-expiry reads - plugin still warming up)'

      // Last ~24 closes, oldest first, so the model can see the actual shape
      // of recent price action with its own eyes instead of only a verdict.
      const recentCloses = closePrices.slice(-24).map((v) => v.toFixed(5)).join(', ')

      const snapshotLines = snapshot.length
        ? snapshot.map((r) => `- ${r.label}`).join('\n')
        : '- (no reference reads available - thin history or plugins still warming up)'

      // Stake-plan awareness: a human at the desk knows his account state,
      // so the model gets the pot/roll facts too - framed so the pot can
      // only ever make it MORE selective with a big roll on the line, never
      // resize the bet (sizing is the operator's lever, direction is the
      // model's, and placeOrder takes the operator-computed stake verbatim).
      // Computed once here and reused for placement + the log lines below.
      const bet = this.stakeFor()

      // ===================================================================
      // OWN-MATH PRECISION REWORK (direct instruction): the trader's own
      // math no longer leans on raw-candle indicators (RSI/EMA-as-trend)
      // as its PRIMARY gauge. Technical measures TIME, tick measures
      // TRANSACTIONS, footprint reveals buying/selling PRESSURE - each is
      // a different lens the candle-only read above couldn't see, and all
      // three are already computed every cycle by their own engines (the
      // tick desk / OTC footprint / technical ladder are CORE desk seats,
      // never gated by triage) - this pulls the SAME reads in here, BEFORE
      // the desk briefing, so they anchor the own-read instead of only
      // showing up later as one more "desk opinion" to weigh against.
      // Renko and range (noise-eliminated by construction - a brick/bar
      // only prints once price has actually moved a real distance) replace
      // moving averages as the trend-confirmation layer. SMC/ICT applied
      // to candles is kept as the STRUCTURAL CONFIRMATION step on top of
      // all of the above, not the primary read itself.
      // ===================================================================

      // 1. TICK (transactions) - tape health + the tick desk's four
      // tick-built engines, same pure functions the desk briefing's tick
      // seat renders, computed here too so they anchor the own-read.
      let tickTapeLines: string[] = []
      let tickDeskOwnLines: string[] = []
      let rawTicks: TickPoint[] = []
      try {
        const ofpTicks = this.svc<OtcFootprintService>('otcFootprint')
        rawTicks = ofpTicks?.ticksFor(asset) ?? []
        if (rawTicks.length) {
          tickTapeLines = tapeHealthLines(rawTicks, Date.now())
          tickDeskOwnLines = tickDeskLines(rawTicks, Date.now())
        }
      } catch {
        // tick collector not warm yet - own-read falls back to candle-only evidence below
      }

      // 2. FOOTPRINT (buying/selling pressure) - the OTC velocity footprint
      // engine is asset-agnostic (used for ANY live asset, not just OTC
      // pairs, per its own module comment) - same race-with-timeout
      // pattern the desk briefing uses so a cold pull never stalls the cycle.
      let footprintResult: FootprintResult | null = null
      let footprintOwnLines: string[] = []
      try {
        const ofpFlow = this.svc<OtcFootprintService>('otcFootprint')
        if (ofpFlow) {
          const fp = ofpFlow.footprint(asset, { minutes: 30, bucketSec: 60 }).then((r) => ({ r })).catch(() => null)
          const timeout = new Promise<{ r: null }>((res) => setTimeout(() => res({ r: null }), 2500))
          const got = await Promise.race([fp, timeout])
          if (got?.r) {
            footprintResult = got.r
            footprintOwnLines = otcFootprintLines(got.r)
          }
        }
      } catch {
        // omitted - own-read proceeds without it
      }

      // 3. TECHNICAL (time, at EVERY timeframe) - the full cross-timeframe
      // ladder, not just this one tf's RSI/EMA snapshot. Sync, pure compute.
      let technicalOwn: ReturnType<TechnicalService['summaryFor']> | null = null
      try {
        const tcOwn = this.svc<TechnicalService>('technical')
        technicalOwn = tcOwn?.summaryFor(asset) ?? null
      } catch {
        technicalOwn = null
      }

      // 4. RENKO + RANGE (noise-eliminated trend confirmation, replacing
      // moving averages) - the exact votes the Chart Signal panel renders,
      // pure sync functions over the same candles already in hand.
      const renkoRead = candles.length ? engineVoteSingle('renko', candles) : null
      const rangeRead = candles.length ? engineVoteSingle('range', candles) : null

      // 5. SMC/ICT applied to candles - STRUCTURAL CONFIRMATION, read
      // alongside (not blended into) the own-math tally below.
      const smcResult = candles.length ? scanSmc(candles) : null
      const smcRead = smcResult ? smcNowRead(smcResult) : null

      // 6. UNIFIED INDICATOR BOARD (direct instruction: "just as we have
      // them as charts, now having them as indicators... great help for
      // easy accessibility") - all ten chart-type indicators (candle,
      // tick, footprint, otc-footprint, renko, range, tick-footprint,
      // IV-HV, SMC, ICT) in ONE call, ONE consistent row shape. Reuses the
      // SAME candles/ticks/footprint/smc already computed above - no extra
      // engine work, purely an adapter (see analytics/chartindicators.ts).
      let indicatorBoard: ChartIndicatorRow[] = []
      try {
        const tickFpForBoard = rawTicks.length ? computeTickFootprint(rawTicks, { bucketSec: 60 }) : null
        indicatorBoard = buildChartIndicatorBoard({
          candles,
          realTicks: rawTicks.length ? rawTicks.map((t) => ({ time: Math.floor(t.ts / 1000), price: t.price })) : null,
          otcFootprint: footprintResult ? { ...footprintResult.summary, buckets: footprintResult.buckets.length } : null,
          tickFootprint: tickFpForBoard,
          smc: smcResult,
        })
      } catch {
        indicatorBoard = []
      }
      const indicatorBoardOwnLines = indicatorBoard.length ? chartIndicatorBoardLines(indicatorBoard) : []
      const tickFootprintBoardRow = indicatorBoard.find((r) => r.id === 'tickFootprint') ?? null
      const ivHvBoardRow = indicatorBoard.find((r) => r.id === 'ivHv') ?? null

      const ownMathVotes: OwnMathVote[] = [
        { label: 'Renko', dir: renkoRead?.dir ?? 0, weight: renkoRead?.weight ?? 0 },
        { label: 'Range', dir: rangeRead?.dir ?? 0, weight: rangeRead?.weight ?? 0 },
        {
          label: 'Technical (all-tf)',
          dir: technicalOwn?.direction === 'call' ? 1 : technicalOwn?.direction === 'put' ? -1 : 0,
          weight: technicalOwn ? Math.min(1, Math.abs(technicalOwn.overall.score)) : 0,
        },
        {
          label: 'Footprint pressure',
          dir: footprintResult?.summary.signal === 'call' ? 1 : footprintResult?.summary.signal === 'put' ? -1 : 0,
          weight: footprintResult ? Math.min(1, Math.abs(footprintResult.summary.score)) : 0,
        },
        {
          label: 'Tick footprint (real prints)',
          dir: tickFootprintBoardRow?.direction === 'call' ? 1 : tickFootprintBoardRow?.direction === 'put' ? -1 : 0,
          weight: tickFootprintBoardRow ? tickFootprintBoardRow.confidence / 100 : 0,
        },
        {
          label: 'IV-HV',
          dir: ivHvBoardRow?.direction === 'call' ? 1 : ivHvBoardRow?.direction === 'put' ? -1 : 0,
          weight: ivHvBoardRow ? ivHvBoardRow.confidence / 100 : 0,
        },
      ]
      const ownMathTallyLine = ownMathTally(ownMathVotes)
      // Compact digest for triageSelectSources - the cheap pre-call that
      // picks which OPTIONAL desk seats to pay for should see the SAME
      // primary own-math reads the main decision call gets, not just the
      // old candle anatomy/ATR/RSI snapshot (precision rework follow-up:
      // "feed it into triage too").
      const ownMathSummaryForTriage = [
        ownMathTallyLine ?? '(own-math tally: nothing live yet)',
        `SMC/ICT: ${smcRead ? (smcRead.direction === 'none' ? 'nothing fired' : `${smcRead.direction.toUpperCase()} (${smcRead.confidence}%)`) : 'n/a'}`,
        `tick tape: ${tickTapeLines[0] ?? 'cold'}`,
      ].join(' | ')

      // Candle anatomy/swing structure kept as the SMC/ICT-adjacent
      // structural read (step 1b, confirmation), no longer the whole of
      // "own math" by themselves - tick/footprint/technical/renko/range
      // above are the primary read now.
      const anatomy = candleAnatomy(candles)
      const structure = swingStructure(candles)
      const tally = deskTally(snapshot)

      // THE EXPERT DESK: core seats (own math above + next-candle/tick
      // desk/OTC velocity footprint/reversal/technical/Accute + the
      // governance seats) always run. Everything else is OPTIONAL per
      // direct instruction - the trader should be "free to choose what it
      // runs as far as it suffices its analysis" rather than paying for
      // every scanner on every cycle regardless of whether this pair/
      // moment needs it - so a cheap triage call picks which EXTRA seats
      // (if any) are worth computing before the full briefing is built.
      const optionalIds = await this.triageSelectSources(asset, tf, horizonLines, recentCloses, anatomy, structure, atrPct, rsiLast, ownMathSummaryForTriage)
      const briefing = await this.deskBriefingFor(asset, tf, ts, bet.amount, optionalIds)
      // audit trail: the stored decision's snapshot keeps the panel grid AND
      // every desk line, tagged source 'desk' so a replay of the log can tell
      // a panel read from a briefing line (matches the client's
      // AiTraderDecision.snapshot element shape exactly)
      const snapshotWithDesk: { source: string; direction: string; confidence: number; label: string }[] = [
        ...snapshot.map((r) => ({ source: r.source as string, direction: r.direction as string, confidence: r.confidence, label: r.label })),
        ...(tally ? [{ source: 'desk', direction: 'none', confidence: 0, label: tally }] : []),
        ...briefing.lines.map((l) => ({ source: 'desk', direction: 'none', confidence: 0, label: l })),
      ]

      const system: ChatMessage = {
        role: 'system',
        content: [
          'You are the AI Trader inside IQAIR//OS, a binary-options trading platform - the SENIOR TRADER of this',
          'desk, and the only one who decides. Every tool this platform has ever built reports to you in the',
          'briefing below: a fused next-candle oracle (with its own live calibration record), a per-expiry',
          'honesty engine (1/2/3/5/15 minute rungs with pWin per rung), a shot-license tempo scanner, a 14-factor',
          'confluence screener, an OU mean-reversion stretch model, an SMC structure engine, a chart-pattern',
          'committee, lead-lag/cointegration/volatility-dislocation cross-asset scanners, a T-24h replay, the',
          'TICK DESK (the raw micro-tick print stream: tape freshness, SMC structure on tick candles, a tick',
          'next-candle oracle, a technical-summary ladder and a measured-print footprint with its delta slope),',
          'the OTC velocity footprint (measured print-speed order flow), the account book, the operator rule',
          'gate, the OTC defense guard, the AI Lab where learned strategies report their holdout edge, and the',
          'FULL INDICATOR BOARD (every indicator this OS computes - trend MAs/Supertrend/PSAR/Ichimoku/ADX, the',
          'momentum oscillator suite, volatility bands and widths, the volume-flow family and pivot/fib levels -',
          'each reduced to name value [BULL|BEAR|=|n/a] with a bull/bear vote tally), a REVERSAL DETECTOR (the',
          'is-it-turning-RIGHT-NOW state engine - calm/forming/reversing/confirmed across a 10-rung ladder down',
          'to sub-minute tick rungs), a TECHNICAL SUMMARY (the oscillator+MA vote ladder on those same rungs),',
          'and your own MSL / META-STRATEGY seat: every saved spec and script the operator has built in this',
          'platform, evaluated live against this exact asset+tf exactly as the Meta Trader or the MSL editor',
          'would run it - this is the operator\'s own hand-built logic, not another panel label.',
          'You are their HUMAN - not one more system running alongside them. Everything the human running this',
          'desk can see, you can see: every chart type this platform charts (candle/bar/renko/point-and-figure/',
          'range-bars/Heikin-Ashi/line/area/baseline/volume-bars/tick-bars/footprint/TPO), every SMC concept on',
          'BOTH candle-built AND tick-built structure (tick SMC is the more precise of the two when the tape is',
          'fresh - read its tape-health line first), the full indicator board, the reversal/technical ladders,',
          'and your own saved MSL specs. A handful of these (next-expiry, tempo, confluence screener, OU/universe',
          'rank, candle-SMC, chart-pattern committee, lead-lag, vol-arb, cointegration, yesterday-echo, AI Lab,',
          'the full indicator board, and MSL) are OPTIONAL - you already picked which of those, if any, you',
          'wanted for THIS cycle before this briefing was built, based on your own math. If one of those is',
          'absent, it is because you did not ask for it, not because it failed. If a CORE seat is absent (the',
          'ones named above as always-on), its data genuinely was not available this cycle - never read either',
          'kind of absence as agreement or disagreement.',
          '',
          'A real senior trader works exactly like this: read the tape with his own eyes first - and "the tape"',
          'means the TRANSACTIONS (tick desk) and the buying/selling PRESSURE behind them (footprint), not just',
          'the candle close. Technical measures TIME (the cross-timeframe ladder), tick measures TRANSACTIONS,',
          'footprint reveals PRESSURE - three different lenses on the same moment, all in YOUR OWN ANALYSIS below,',
          'confirmed by renko/range (noise-eliminated by construction - they replace moving averages here) and by',
          'SMC/ICT applied to the candles themselves (structural confirmation, not the primary read). Only THEN',
          'take the meeting with the analysts (the desk briefing), then make ONE judgment call that belongs to',
          'him alone: which way, which exact expiry, and whether this moment is even worth money. You may agree',
          'with your desk, override it, or conclude that disagreement itself means skip - the call is yours.',
          '',
          'How to WEIGH the desk (this is what makes you precise, not just busy):',
          '- Reads carrying their own LIVE RECORD (hit rate / Brier / pWin over n) are worth more than unproven',
          '  ones at the same confidence: a scanner that has actually hit 62% over 200 graded calls outranks a',
          '  confident label with no record, and a read whose own record is at or under coin-flip gets discounted',
          '  no matter how loud it is. Where the briefing shows "raw vs calibrated" confidence, the calibrated',
          '  number is the honest one.',
          '- Convinced only when INDEPENDENT lines agree: oracle + structure + a cross-asset scanner pointing the',
          '  same way is evidence; the same scanner family restated five times is one voice, not five.',
          '- The desk tally is a starting point, never your decision - it says nothing about expiry, and a loud',
          '  tally of weak/unproven voices is exactly the trap you exist to not fall into.',
          '- The indicator board is YOUR chartist pass, not one more voice: read it as votes, not verdicts. Its',
          '  tally ("N bull / M bear / K neutral") shows the whole board\'s balance; the ADX line tells you whether',
          '  the regime is even trending (ADX < 20 = chop: discount every trend read), and an n/a line means that',
          '  indicator had no honest read this cycle - an absent vote is not a quiet vote.',
          '- You are VOLUME-AWARE and STALENESS-AWARE, in that order: read the tick desk\'s tape line FIRST - a',
          '  STALE tape (last print too old) down-weights every tick-desk and footprint read no matter how loud',
          '  they are. On fresh tape, the measured print flow (up/down prints, net delta, delta slope, speed',
          '  ratios, POC migration) is the desk\'s only REAL order-flow evidence: flow agreeing with price',
          '  structure is confirmation, flow against price is absorption - both beat another indicator restating',
          '  the candle close.',
          '- A MEMORY-GATE "BLOCKED" line or an engaged kill switch is a HARD skip for that asset - no override.',
          '',
          'Your job each cycle:',
          '1. YOUR OWN ANALYSIS first, in this order: (a) tick desk - tape freshness, then the tick-built',
          '   SMC/oracle/technical/footprint reads (TRANSACTIONS); (b) footprint - buying vs selling PRESSURE',
          '   and its delta slope; (c) technical - the cross-TIMEFRAME ladder, not just this one tf; (d) renko',
          '   and range - noise-eliminated trend confirmation (these replace moving averages - trust a brick/bar',
          '   flip over an EMA cross); (e) SMC/ICT applied to the candles - structural confirmation (order',
          '   blocks, FVGs, BOS) on top of (a)-(d), never the primary signal by itself. The own-math tally below',
          '   is a mechanical starting point across (a)-(d) - weigh it, do not just restate it. The raw closes,',
          '   candle anatomy and swing structure further below are the last, lowest-priority confirmation layer,',
          '   not where you start. Form a real view: trending, ranging, exhausting, reversing?',
          '2. Take the desk meeting: weigh the briefing by each read\'s own calibration record as above. If the',
          '   desk conflicts with your own read, decide who you trust more for THIS moment and say which you did.',
          '   Check the tick desk\'s tape-freshness and print-flow lines before you trust any direction: fresh',
          '   tape + flow agreeing with structure is the highest-conviction stack this desk can show you.',
          '3. Direction and expiry TOGETHER: check the per-expiry runs and the expiry-oracle rungs for EACH menu',
          '   choice, and pick the ONE expiry where your evidence is clearest for that specific holding period.',
          '   A read that is strong at 3min can be noise at 15min; the OU half-life line tells you which windows',
          '   can plausibly see a round trip at all, and the tick oracle\'s per-bucket reads tell you what the',
          '   raw stream itself expects over the NEXT seconds-to-minutes candles.',
          '4. Precision over frequency: most cycles SHOULD be a skip. Only call/put when you would genuinely',
          '   expect to be right most of the time at the confidence you claim. Honestly uncertain + skip always',
          '   beats a confident-sounding coin flip.',
          '5. Learn from yourself: your own graded record and self-calibration table (does your 85% actually win',
          '   more than your 65%? does one direction keep losing on this pair?) are below - correct any inflation',
          '   or bias you find there NOW, in this decision.',
          '',
          'Respond with ONLY a JSON object, no prose outside it, in exactly this shape:',
          '{"direction": "call" | "put" | "skip", "confidence": 0-100, "expiryMin": <the ONE allowed choice your analysis is clearest on>, "reasoning": "<2-4 sentences: your own read of the price action, which desk evidence you weighed and how its calibration graded it, whether you sided with or against the desk, and why THIS expiry>"}',
        ].join('\n'),
      }
      const user: ChatMessage = {
        role: 'user',
        content: [
          `Asset: ${asset}   Timeframe: ${tf}   Current price: ${price || 'unavailable'}`,
          `Volatility regime (context only, not a directional vote): ATR14 ${atrPct.toFixed(4)}% of price, RSI14 ${rsiLast.toFixed(1)}${Math.abs(rawAtrPct - atrPct) > 0.01 ? ` [raw ATR read ${rawAtrPct.toFixed(2)}% - one outlier bar in the window was clamped as a likely feed glitch, the figure above is the corrected one]` : ''}.`,
          '',
          'YOUR OWN ANALYSIS (a) TICK DESK - transactions, read FIRST (tape health, then tick-built SMC/oracle/technical/footprint):',
          ...(tickTapeLines.length || tickDeskOwnLines.length ? [...tickTapeLines, ...tickDeskOwnLines] : ['- (tick collector not warm yet on this asset - own-read proceeds on technical/renko/range/SMC below)']),
          '',
          'YOUR OWN ANALYSIS (b) FOOTPRINT - buying vs selling PRESSURE (the OTC velocity footprint engine, asset-agnostic):',
          ...(footprintOwnLines.length ? footprintOwnLines : ['- (footprint not available this cycle - cold pull or thin print history)']),
          '',
          `YOUR OWN ANALYSIS (c) TECHNICAL - cross-TIMEFRAME ladder (TIME, not just this one tf):${technicalOwn ? ` ${technicalOwn.overall.label} (score ${technicalOwn.overall.score >= 0 ? '+' : ''}${technicalOwn.overall.score.toFixed(2)}, ${technicalOwn.overall.buys}B/${technicalOwn.overall.sells}S/${technicalOwn.overall.neutrals}N of ${technicalOwn.overall.counted} rungs) -> leans ${technicalOwn.direction.toUpperCase()}` : ' (ladder still warming up on this asset)'}`,
          '',
          `YOUR OWN ANALYSIS (d) RENKO + RANGE - noise-eliminated trend confirmation, REPLACES moving averages: Renko ${renkoRead && renkoRead.dir !== 0 ? `${renkoRead.dir > 0 ? 'BULLISH' : 'BEARISH'} (${renkoRead.note})` : 'no brick trend'}; Range ${rangeRead && rangeRead.dir !== 0 ? `${rangeRead.dir > 0 ? 'BULLISH' : 'BEARISH'} (${rangeRead.note})` : 'no range trend'}.`,
          ...(ownMathTallyLine ? ['', ownMathTallyLine] : []),
          '',
          `YOUR OWN ANALYSIS (e) SMC/ICT applied to the candles - STRUCTURAL CONFIRMATION only, never the primary signal: ${smcRead ? `${smcRead.direction === 'none' ? 'no concept fired this candle' : `${smcRead.direction.toUpperCase()} (${smcRead.confidence}% agreement) - ${smcRead.note}`}` : '(thin candle history for an SMC read)'}`,
          '',
          'Indicator board - all ten chart-type reads at a glance (candle/tick/footprint/otc-footprint/renko/range/tick-footprint/IV-HV/SMC/ICT), each the SAME engine behind its chart panel, reduced to one line for easy reference:',
          ...(indicatorBoardOwnLines.length ? indicatorBoardOwnLines : ['- (indicator board unavailable this cycle)']),
          '',
          'YOUR OWN ANALYSIS (f) candle anatomy of the last 3 closed bars (lowest-priority confirmation, not where you start):',
          ...(anatomy.length ? anatomy : ['- (too few closed bars for an anatomy read)']),
          'YOUR OWN ANALYSIS (f) swing structure and break-of-structure:',
          ...(structure.length ? structure : ['- (too few closed bars for a structure read)']),
          '',
          `Recent closes, oldest -> newest (${closePrices.length ? closePrices.length : 0} bars available, showing last ${Math.min(24, closePrices.length)}): ${recentCloses || '(none yet)'}`,
          '',
          'Per-expiry-choice reads (computed directly from the candles above - YOUR raw evidence per holding period):',
          horizonLines,
          '',
          `Allowed expiry choices (minutes): ${this.config.expiryChoices.join(', ')} - you must pick exactly one of these.`,
          '',
          `Your own recent calls on this exact asset+tf, most recent first (${graded.wins}W / ${graded.losses}L graded, ${graded.pending} still pending) - learn from these, this is YOUR track record:`,
          graded.lines,
          ...(graded.calibration.length ? ['', 'Self-calibration table (claimed confidence vs reality - correct for any inflation you see here):', ...graded.calibration] : []),
          '',
          `THE DESK BRIEFING (${briefing.sourcesSeen} of the desk's scanners are reporting this cycle; each section is one independent tool, weigh by its own live record - see system instructions):`,
          ...(briefing.lines.length ? briefing.lines : ['- (no desk scanner is reporting yet - boot still warming; decide on your own analysis alone)']),
          '',
          'Panel snapshot (the at-a-glance source grid the Meta panel shows, one label per source):',
          snapshotLines,
          ...(tally ? ['', tally] : []),
          '',
          `Minimum confidence to actually act: ${this.config.minConfidence} (a lower confidence will be treated as a skip regardless of direction, so be honest rather than inflating it).`,
          ...(bet.compound
            ? [
                '',
                `Your stake plan (set by the operator, not you): COMPOUNDING - the pot is $${bet.pot.toFixed(2)} after ${bet.rollN} compounded win(s) this run, so the next trade stakes $${bet.amount.toFixed(2)} (${bet.phase} phase). A loss ends the compounding run${this.config.stakePlan?.stopOnLoss !== false ? ' and stands you down until the operator restarts the cycle' : ''}. A larger roll is a reason to be MORE selective about marginal setups, never less - but pot size must not change your direction read: size is the operator's lever, direction is yours.`,
              ]
            : []),
        ].join('\n'),
      }

      let content: string
      let provider = ''
      let model = ''
      try {
        const res = await callLlm(resolveAppUrl(this.config), [system, user], { temperature: 0.3, maxTokens: 900, timeoutMs: 45_000 })
        content = res.content
        provider = res.provider
        model = res.model
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err)
        this.lastError = msg
        this.store.recordAiTraderDecision({
          asset, tf, direction: 'skip', confidence: 0, reasoning: `LLM call failed: ${msg}`,
          snapshot: snapshotWithDesk, live: this.config.live, acted: false, error: msg, priceAtDecision: price || undefined, ts,
        })
        this.emit('warn', `AI Trader cycle failed on ${asset} ${tf}: ${msg}`)
        return null
      }

      const parsed = parseDecision(content, this.config.expiryChoices)
      if (!parsed) {
        this.lastError = 'model reply was not parseable JSON'
        this.store.recordAiTraderDecision({
          asset, tf, direction: 'skip', confidence: 0, reasoning: `unparseable model reply: ${content.slice(0, 300)}`,
          snapshot: snapshotWithDesk, live: this.config.live, acted: false, provider, model, error: 'unparseable reply', priceAtDecision: price || undefined, ts,
        })
        this.emit('warn', `AI Trader got an unparseable reply on ${asset} ${tf} - treated as skip`)
        return null
      }
      this.lastError = null

      // the floor is enforced HERE, not just suggested in the prompt - a
      // model that talks itself into high confidence on a weak setup still
      // gets overridden if the operator's own floor says no
      let direction = parsed.direction
      // PRECISION FIX: before comparing to the floor, haircut the model's
      // SELF-reported confidence against its own account-wide track record
      // in this exact direction+bucket (see calibratedConfidence's doc
      // comment) - a model whose claimed 85%+ CALLs have actually only won
      // ~55% of the time no longer gets to clear minConfidence just by
      // saying "85%" again; the number used for the gate (and recorded to
      // the decision log) is the calibration-corrected one.
      let effectiveConfidence = parsed.confidence
      let calibrationNote = ''
      if (direction === 'call' || direction === 'put') {
        const calRows = this.accountCalibrationRows()
        const cal = calibratedConfidence(calRows, direction, parsed.confidence)
        if (cal.adjusted !== parsed.confidence) {
          effectiveConfidence = cal.adjusted
          calibrationNote = ` [calibration haircut: claimed ${parsed.confidence.toFixed(0)}% -> ${effectiveConfidence.toFixed(0)}% - this trader's own ${direction.toUpperCase()} calls at that confidence have realized ${cal.realized?.toFixed(0)}% over ${cal.sample} graded trades]`
        }
      }
      if (direction !== 'skip' && effectiveConfidence < this.config.minConfidence) {
        direction = 'skip'
      }

      let acted = false
      let positionId: string | null = null
      let actionError: string | undefined

      if (direction !== 'skip' && this.config.live) {
        const out = await this.exec.placeOrder({
          asset,
          tf,
          side: direction,
          kind: this.config.kind,
          amount: bet.amount,
          expirySec: minToSec(parsed.expiryMin),
          mode: this.exec.accountSource === 'iq' ? 'live' : 'paper',
          strategy: 'ai-trader',
          note: 'ai-trader',
        })
        if (out.ok && out.position) {
          acted = true
          positionId = out.position.id
          this.emit('success', `[AI Trader] ${direction.toUpperCase()} ${asset} $${bet.amount.toFixed(2)}${bet.compound ? ` (compound ${bet.phase} roll x${bet.rollN + 1}, pot $${bet.pot.toFixed(2)})` : ''} @ ${parsed.expiryMin}min - ${parsed.reasoning} (confidence ${parsed.confidence.toFixed(0)}%, desk: ${briefing.sourcesSeen} sources reporting)`)
        } else {
          actionError = out.error ?? 'order rejected'
          if (AI_TRADER_BROKER_UNAVAILABLE_RE.test(actionError)) {
            this.assetRejectedUntil.set(asset, ts + AI_TRADER_UNAVAILABLE_COOLDOWN_SEC)
          }
          this.emit('warn', `[AI Trader] wanted ${direction.toUpperCase()} ${asset} but the order was rejected: ${actionError}`)
        }
      } else if (direction !== 'skip') {
        // shadow mode - a real decision, logged, but no order placed
        this.emit('info', `[AI Trader][SHADOW] would ${direction.toUpperCase()} ${asset} $${bet.amount.toFixed(2)}${bet.compound ? ` (compound ${bet.phase} roll x${bet.rollN + 1}, pot $${bet.pot.toFixed(2)})` : ''} @ ${parsed.expiryMin}min - ${parsed.reasoning} (confidence ${parsed.confidence.toFixed(0)}%, desk: ${briefing.sourcesSeen} sources reporting)`)
      }

      this.store.recordAiTraderDecision({
        // confidence recorded (and gated on above) is the CALIBRATED number,
        // not the model's raw claim - the decision log, the stake plan, and
        // next cycle's own calibration bucket should all see the honest
        // figure, not the possibly-inflated one the model said out loud
        asset, tf, direction, confidence: effectiveConfidence, expiryMin: parsed.expiryMin,
        reasoning: parsed.reasoning + calibrationNote, snapshot: snapshotWithDesk, live: this.config.live, acted, positionId: positionId ?? undefined,
        provider, model, error: actionError, priceAtDecision: price || undefined, ts,
      })

      const rows = this.store.listAiTraderDecisions(1)
      return (rows[0] as AiTraderDecision) ?? null
    } catch (err) {
      // Never let one bad candidate (in a multi-asset scan) throw the whole
      // cycle - log it and let the orchestrator move on to the next one.
      const msg = String(err instanceof Error ? err.message : err)
      this.lastError = msg
      this.emit('warn', `AI Trader cycle failed on ${asset} ${tf}: ${msg}`)
      return null
    }
  }

  /** Stake-plan-aware sizing - the SAME pot math as the autopilot bots'
   * stakeFor() (plugins/autopilot.ts): the working pot is the running roll
   * (or the seed once the pot is dust), rolled by rollPct% - or deriskPct%
   * once the de-risk threshold is crossed - clamped by maxStake and the
   * broker's $1 minimum, rounded to cents. Falls back to the flat configured
   * stake with no plan. The GLOBAL risk manager still outranks this:
   * execution.ts gates the actual bet amount like every other order. */
  private stakeFor(): { amount: number; pot: number; rollN: number; compound: boolean; phase: 'compound' | 'derisk' } {
    const plan = this.config.stakePlan
    if (!plan) return { amount: this.config.stake, pot: 0, rollN: 0, compound: false, phase: 'compound' }
    // dust guard: a pot worth less than a cent is a fresh cycle
    const pot = this.plan.pot >= 0.01 ? this.plan.pot : plan.base
    const derisk = plan.deriskAfter !== undefined && plan.deriskPct !== undefined && this.plan.rollN >= plan.deriskAfter
    const rollPct = derisk ? plan.deriskPct! : (plan.rollPct ?? 100)
    const raw = (pot * rollPct) / 100
    const amount = Math.min(plan.maxStake ?? 5000, Math.max(1, Math.round(raw * 100) / 100))
    return { amount, pot, rollN: this.plan.rollN, compound: true, phase: derisk ? 'derisk' : 'compound' }
  }

  /** Settle hook - the fold-in/burn half of the compounding plan, mirrored
   * field-for-field from the autopilot bots' onPositionClosed (os-mode.ts's
   * shape): a win folds the payout into the pot (skimming anything above the
   * payout cap), a loss burns the stake back out; stopOnLoss (default) ends
   * the cycle on a loss, `periods` completes it on the Nth win, and the
   * reseed/lossReseed limits bound the automatic continuations. Only this
   * trader's own positions count (strategy 'ai-trader' - the tag every
   * order runCycleForAsset places carries; identical filter to the
   * concurrency counter). Rounds to cents at EVERY fold: stakes are rounded
   * to cents at open, and an unrounded pot (3.7636) minus a rounded stake
   * (3.76) leaves dust that never reaches 0 - the cycle would then compound
   * from dust forever. */
  private onPlanPositionClosed(position: { strategy?: string; status: string; pnl?: number; amount?: number }): void {
    if (position.strategy !== 'ai-trader') return
    const plan = this.config.stakePlan
    if (!plan || (position.status !== 'won' && position.status !== 'lost')) return
    // THE CONCURRENT-SETTLEMENT BUG: with maxConcurrent > 1 (or scanMode
    // 'selected'/'global'), more than one AI Trader position can be open at
    // once under the SAME pot. If one of them settles as a loss first, the
    // plan halts (stands down, pot frozen) - but a SECOND position opened
    // before that halt can still be out there and settle afterward. Without
    // this guard its win/loss would silently fold into or burn from a pot
    // that's supposed to be frozen, which both lies to the operator (the
    // displayed pot moves after "HALTED, restart to trade again" already
    // fired) and double-counts risk the halt was meant to stop compounding
    // on. The real position's own pnl already settled for real on the
    // account via execution.ts's settle() regardless - this guard only
    // protects the DERIVED sizing pot, never the account balance. */
    if (this.plan.halted) {
      this.emit(
        'warn',
        `[AI Trader] late ${position.status} settlement (opened before the compound cycle halted, probably from maxConcurrent > 1) - pot stays frozen at $${this.plan.pot.toFixed(2)}, this trade's real pnl already settled on the account and is unaffected - restart the compound cycle to resume`,
      )
      return
    }
    const base = plan.base
    const working = this.plan.pot >= 0.01 ? this.plan.pot : base
    const amount = position.amount ?? base
    if (position.status === 'won') {
      this.plan.lossReseedCount = 0
      // payout cap: fold in at most payoutCap% (default+max 70) of the stake
      // as profit - a broker paying more gets the excess skimmed to the
      // balance, never compounded into the pot
      const cap = (plan.payoutCap ?? 70) / 100
      const fold = Math.min(position.pnl ?? amount * cap, amount * cap)
      this.plan.pot = Math.round((working + fold) * 100) / 100
      this.plan.rollN += 1
      // periods target reached: the cycle is COMPLETE (win-side halt or reseed)
      const periods = plan.periods
      if (periods && this.plan.rollN >= periods) {
        this.plan.restarts += 1
        const banked = Math.round((this.plan.pot - base) * 100) / 100
        const reseedLimit = plan.reseedLimit
        const reseedsLeft = plan.onComplete === 'reseed' && reseedLimit ? reseedLimit - this.plan.reseedCount : Infinity
        if (plan.onComplete === 'reseed' && reseedsLeft > 0) {
          this.plan.pot = 0
          this.plan.rollN = 0
          this.plan.reseedCount += 1
          const limitTag = reseedLimit ? ` (re-seed ${this.plan.reseedCount}/${reseedLimit})` : ''
          this.emit('success', `[AI Trader] compound cycle COMPLETE - ${periods} periods, +$${banked.toFixed(2)} banked - re-seeding $${base}${limitTag}`)
        } else {
          this.plan.halted = true
          this.plan.complete = true
          const why = plan.onComplete === 'reseed' ? `re-seed limit reached (${reseedLimit}/${reseedLimit})` : `${periods} periods`
          this.emit('success', `[AI Trader] compound cycle COMPLETE - ${why}, +$${banked.toFixed(2)} banked - standing down; restart the compound cycle to trade again`)
        }
      }
    } else {
      this.plan.pot = Math.round(Math.max(0, working - amount) * 100) / 100
      const kept = this.plan.pot
      if (this.plan.rollN > 0) this.plan.restarts += 1 // a winning streak ended
      this.plan.rollN = 0
      // stop-on-loss (default): the sequence is over - stand down until an
      // explicit restart. stopOnLoss:false keeps the legacy re-seed roll.
      if (plan.stopOnLoss !== false) {
        this.plan.halted = true
        this.plan.complete = false
        this.emit('warn', `[AI Trader] compound cycle ENDED on a loss (-$${Math.abs(position.pnl ?? 0).toFixed(2)})${kept >= 0.01 ? ` - $${kept.toFixed(2)} of the pot stays banked on the balance` : ''} - restart the compound cycle to trade again`)
      } else {
        // "On loss: Re-seed" - the trader normally just keeps rolling through
        // a loss, but lossReseedLimit caps how many losses in a row it will
        // silently absorb before being forced to stop anyway.
        this.plan.lossReseedCount += 1
        const lossReseedLimit = plan.lossReseedLimit
        if (lossReseedLimit && this.plan.lossReseedCount >= lossReseedLimit) {
          this.plan.halted = true
          this.plan.complete = false
          this.emit('warn', `[AI Trader] compound cycle FORCED TO STOP - ${this.plan.lossReseedCount}/${lossReseedLimit} consecutive losses while re-seeding (-$${Math.abs(position.pnl ?? 0).toFixed(2)} this one)${kept >= 0.01 ? ` - $${kept.toFixed(2)} of the pot stays banked on the balance` : ''} - restart the compound cycle to trade again`)
        }
      }
    }
    this.persistPlanState()
  }

  /** Clears a halted compounding cycle and re-seeds the pot at base - the
   * same "restart to trade again" contract the autopilot bots' compound
   * plans (bot_restart) and the meta-trader's restart() use. The cumulative
   * restarts counter is kept for the record. */
  restartCompound(): { ok: boolean; error?: string } {
    if (!this.config.stakePlan) return { ok: false, error: 'restart applies to a compounding AI Trader plan only' }
    this.plan = { pot: 0, rollN: 0, restarts: this.plan.restarts, reseedCount: 0, lossReseedCount: 0, halted: false, complete: false }
    this.persistPlanState()
    this.emit('success', `[AI Trader] compound cycle RESTARTED - next trade seeds $${this.config.stakePlan.base}`)
    return { ok: true }
  }

  /** Raw store write of the roll state (config + planState in one blob) -
   * deliberately NOT a full configure() round-trip, which would re-emit a
   * config alert and restart the timer on every settle; same shape the
   * autopilot's per-settle saveBot(planState) write uses. */
  private persistPlanState(): void {
    this.store.saveAiTraderConfig({ ...this.config, planState: this.plan })
  }

  private emit(level: 'info' | 'warn' | 'danger' | 'success', message: string): void {
    this.ctx.bus.emit('alert', { level, message, ts: Math.floor(Date.now() / 1000) })
  }
}

export const aiTraderPlugin: Plugin = {
  name: 'ai-trader',
  start: async (ctx) => {
    const svc = new AiTraderService()
    await svc.start(ctx)
    ctx.provide('aiTrader', svc)
  },
}
