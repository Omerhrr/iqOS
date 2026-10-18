// IQAIR//OS - Mode plugin (human-in-the-loop governor)
// A global OS operating mode that flips the entire system between two intents:
//  - HUMAN: every trade needs a human. A mode gate rejects all bot-originated
//    orders (non-destructively - bot configs are preserved, only execution is
//    suspended) and the built-in auto-trader stands down.
//  - AUTO ("no human in the loop"): the OS trades by itself. Armed autopilot
//    bots resume, and the built-in AUTO-TRADER - the OS acting as its own
//    trader - places fixed-risk binary trades within strict self-imposed
//    limits. The signal SOURCE is configurable:
//      * 'chartsignals' - the chart-type scanner's own vote engine (renko/
//                        P&F/range/tick/footprint/heikin/candle votes
//                        combined into one signed score+direction)
//      * 'leadlag'     - intermarket lead-lag: a liquidity/macro leader's
//                        unusual move projected onto a correlated follower
//      * 'cointegration' - pairs trading on PRICE LEVELS: Engle-Granger
//                        hedge-ratio fit between a leader/follower pair,
//                        fading the spread when stretched from its own
//                        fitted equilibrium (analytics/cointegration.ts)
//      * 'triangulation' - FX triangular arbitrage: fades the gap between
//                        an actual cross pair and its synthetic value (the
//                        product of the other two triangle legs) when that
//                        basis is unusually stretched (analytics/triangulation.ts)
//      * 'adx-pattern-bias' - ADX/DI trend strength+direction combined with
//                        recent candlestick pattern bias into one
//                        agreement-gated composite (analytics/adxpatternbias.ts)
//      * 'strategy'    - ONE specific saved strategy, picked by strategyId
//                        from the combined Strategy Lab catalog (every
//                        builtin strategy PLUS every AI Lab-learned "custom:"
//                        spec) - the exact same strategyId an autopilot bot
//                        would use, evaluated market-wide on every open pair
//                        (builtin via AnalyticsService.runStrategy, AI Lab
//                        specs via StrategyLabService.runStrategy) instead of
//                        being pinned to one bot's watchlist
//  'screener'/'kalman-ou'/'markov'/'momentum'/'confluence' used to be signal
//  sources here too - each one duplicated an edge that already exists as a
//  selectable 'strategy' (the composite screener read, kalman-ou-reversion,
//  markov-forecast, momentum/adx-trend, confluence-full), so they were
//  dropped from this list in favor of 'strategy', and cointegration/
//  triangulation/adx-pattern-bias (which need a second/third aux series the
//  plain 'strategy' sweep doesn't fetch on demand, so they earn their own
//  dedicated source) took their place.
// The mode is persisted, so restarts resume the same intent. Sentinel, the
// watchdog and the base risk manager ALWAYS outrank the mode: flipping to
// AUTO grants autonomy, never exemption. PANIC drops the OS back to HUMAN.

import type { Plugin, KernelContext } from '../kernel'
import type { Store } from '../store'
import type { AssetCategory, Candle, Timeframe } from '../types'
import { ALL_TIMEFRAMES, TIMEFRAME_SECONDS } from '../types'
import type { ScreenerService, ScreenRow } from './screener'
import type { MarketDataService } from './market-data'
import type { ChartSignalsService, ChartScanResult } from './chartsignals'
import type { AnalyticsService } from './analytics'
import type { StrategyLabService } from './lab'
import type { AdaptiveService } from './adaptive'
import { walkForward } from '../strategies/optimize'
import { getStrategy, defaultParams, STRATEGIES } from '../strategies/builtin'
import { classifyRegime } from '../analytics/regime'
import { classifySession } from '../analytics/session'
import { SweepEdgeMemory } from '../analytics/edge'
import { fitLeadLag, projectLeadLagSignal, LEADLAG_GROUPS, LEADLAG_MIN_ABS_CORRELATION, LEADLAG_MIN_TRIGGER_Z, LEADLAG_LOOKBACK_BARS } from '../analytics/leadlag'
import { fitCointegration, COINTEGRATION_WINDOW, COINTEGRATION_MIN_R2, COINTEGRATION_MIN_TSTAT, COINTEGRATION_MAX_HALFLIFE } from '../analytics/cointegration'
import { findTriangles, fitTriangulationFromCandles, TRIANGULATION_WINDOW, TRIANGULATION_Z_ENTRY, type TriangleCandidate } from '../analytics/triangulation'
import { fitAdxPatternBias, ADX_TREND_THRESHOLD, COMPOSITE_QUALIFY, PATTERN_BIAS_LOOKBACK } from '../analytics/adxpatternbias'
import { fitShockPressure, SHOCK_RATIO_THRESHOLD, PRESSURE_LOOKBACK, SHOCKPRESSURE_COMPOSITE_QUALIFY } from '../analytics/shockpressure'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** NaN-safe comparison for trade gates. Thin-history screener rows can carry
 * NaN indicator values, and EVERY comparison against NaN is false - so a
 * `value < threshold` skip gate PASSES garbage exactly when the data is
 * unusable (observed live: a NaN-adx row was recorded as a held edge via the
 * arm backfill snapshot; a picker gate of the form `adx < minAdx` would have
 * let the same row trade). These fail closed: a non-finite value never
 * qualifies, never trades. */
const finGte = (v: number, floor: number): boolean => Number.isFinite(v) && v >= floor

export type OsMode = 'human' | 'auto'

export type AutoTraderSource = 'cointegration' | 'triangulation' | 'adx-pattern-bias' | 'shock-pressure' | 'strategy' | 'chartsignals' | 'leadlag'

/** Walk-forward validation verdict for the OU edge on one (asset, tf). */
export interface OUVerdict {
  asset: string
  tf: Timeframe
  verdict: 'robust' | 'weak' | 'failed'
  oosNet: number // aggregate out-of-sample net P&L ($ at $10 stake)
  isNet: number // aggregate in-sample net P&L
  winRate: number // OOS win rate %
  efficiencyPct: number // oosNet / isNet * 100
  foldsProfitable: number
  folds: number
  totalTrades: number // OOS trades
  bestParams: Record<string, number | string>
  elapsedMs: number
  ts: number
}

export interface AutoTraderConfig {
  enabled: boolean // auto-trader armed (it only ever trades while mode = auto)
  signalSource: AutoTraderSource // where entry signals come from
  tf: Timeframe // which screener timeframe to source signals from
  /** The trade's own expiry, as a timeframe - SEPARATE from `tf` (the
   * timeframe signals are read from). Previously there was no such field:
   * every auto-trader binary trade silently expired after exactly one bar
   * of `tf`, so changing the signal timeframe also changed how long every
   * trade ran, whether that was intended or not. Undefined = old behavior
   * (expiry tracks `tf` 1:1). Set explicitly to decouple them, e.g. read
   * signals on '1m' candles but let each trade run for '5m' before it
   * settles. Converted to whole bars-of-`tf` at placement time
   * (Math.round(TIMEFRAME_SECONDS[expiryTf] / TIMEFRAME_SECONDS[tf]),
   * floored at 1) since execution.ts's binary/turbo settlement is still
   * bar-counted off the signal tf, not a second independent clock. */
  expiryTf?: Timeframe
  stake: number
  minScore: number // minimum |score| to act on (composite or per-source edge score)
  minConfidence: number // minimum signal confidence (0-100)
  cointegrationZEntry: number // cointegration source: |z| (spread sigmas) required to enter
  cointegrationMaxHalfLife: number // cointegration source: skip pairs reverting slower than this (bars)
  triangulationZEntry: number // triangulation source: |z| (basis sigmas) required to enter
  /** strategy source: id from the combined Strategy Lab catalog - a builtin
   * strategy id (e.g. "ema-cross", "confluence-full") or an AI Lab-learned
   * spec ("custom:<id>"), exactly like an autopilot bot's strategyId. Unset =
   * the 'strategy' source has nothing to trade and stands aside.
   * @deprecated superseded by strategyIds (kept for old saved configs - a
   * lone strategyId is treated as a one-member strategyIds list). */
  strategyId?: string
  /** strategy source: one or more ids from the combined Strategy Lab catalog.
   * One id = trade that single strategy, exactly as strategyId always did.
   * Two or more = an ENSEMBLE: every listed strategy votes call/put/none on
   * each candidate, the majority direction wins, and minConfidence doubles
   * as the minimum agreement % (e.g. 60 = at least 60% of the ensemble must
   * agree) required to act - no classic "confidence" exists at the
   * strategy level, so this is the natural place to put that threshold.
   * Only used when strategyPickMode is 'ensemble' (the default when unset). */
  strategyIds?: string[]
  /** How a 2+-member strategyIds pool combines into one signal per pair.
   * 'ensemble' (default) - every member votes, majority wins (see strategyIds
   * above). 'best' - the OS's own auto-learn: reads the adaptive gate's
   * settled-trade record (adaptive.ts - same Wilson-lower-bound win rate math
   * it already uses to gate bots) for EACH pool member against THIS exact
   * candidate pair/side/score-bucket, and trades whichever member has the
   * strongest proven record for that specific pair - a strategy that's
   * mediocre overall but excellent on e.g. XAUUSD will get picked there and
   * nowhere else. Members with no settled record yet fall back to raw
   * |score| so the pool keeps exploring until it has something to learn
   * from; a proven member always outranks an unproven one. No effect with
   * 0-1 ids. */
  strategyPickMode?: 'ensemble' | 'best'
  /** Only matters with strategyPickMode 'best'. false (default) = auto-learn
   * ranks only among the manually-picked strategyIds, as it always has.
   * true = widens the pool it ranks EVERY tick to the entire builtin
   * strategy catalog plus every non-decayed AI Lab spec that exists so far,
   * AND periodically runs the AI Lab's own pattern-mining (learn()) on open
   * pairs that do not yet have a reasonably fresh learned spec, saving
   * whatever it finds so it joins the pool too - the auto-trader is no
   * longer limited to strategies a human handed it; it can discover its
   * own and then prove, per pair, which one (hand-picked, builtin, or
   * self-discovered) actually works best there. Real compute cost: every
   * tick now evaluates the full catalog on every candidate pair, and the
   * discovery sweep itself is a CPU-heavy mining pass (bounded to at most
   * one pair per tick, at most once every 6h per pair - see
   * AUTO_DISCOVER_COOLDOWN_SEC). */
  autoDiscover?: boolean
  /** Per-strategy param overrides, keyed by strategy id - the SAME params a
   * bot's own BotConfig.params carries for its strategyId. Only builtin
   * strategies take params (AnalyticsService.runStrategy); an AI Lab
   * "custom:<id>" spec is fixed and ignores any entry here. Missing keys
   * fall back to that strategy's own defaultParams(), exactly like a bot
   * with no params set. */
  strategyParams?: Record<string, Record<string, number | string>>
  /** Per-pair strategy pin, keyed by exact ticker (e.g. "EURUSD-OTC") -
   * "for THIS pair always use THIS strategy" instead of letting the global
   * strategyIds pool/ensemble/autoDiscover logic decide for it. Built for
   * an AI Lab spec studied on one pair's history but meant to trade a
   * DIFFERENT one (or several): assign it here and that pair bypasses the
   * global pool entirely - it runs ONLY this one strategy, exactly like a
   * single-strategy strategyIds:[id] setup would, just scoped to this pair
   * instead of every pair. A pair with no entry here keeps using the global
   * strategyIds/strategyPickMode/autoDiscover behavior unchanged. If the
   * pinned id is later removed (e.g. the AI Lab library got wiped) that
   * pair simply sits out - it does NOT silently fall back to the global
   * pool, since that would quietly undo the whole point of pinning it.
   * Params for a pinned builtin id still come from strategyParams[id], same
   * mechanism as any pool member. */
  pairStrategy?: Record<string, string>
  /** Direction pin: "for every CALL use THIS strategy, for every PUT use
   * THIS one" - the direction analog of pairStrategy above, same bypass
   * model (skips the global strategyIds/ensemble/best pool entirely for
   * whichever side(s) are set here), just keyed by side instead of pair.
   * Either key may be set alone (the other side keeps using the global
   * pool) or both (the pool is bypassed completely). A pair's pairStrategy
   * pin, if it has one, still wins over this - pinning a PAIR to one
   * strategy regardless of direction is a narrower, more specific
   * intent than a global per-direction default. Each tick, both configured
   * strategies are evaluated independently per candidate; only the CALL
   * strategy's own 'call' output counts as a call vote and only the PUT
   * strategy's own 'put' output counts as a put vote (its 'none', or the
   * "wrong" side, is simply ignored - same one-way-active convention every
   * other signal kind in this codebase follows) - so the two can never
   * conflict into a tie the way a true ensemble vote could. If the pinned
   * id no longer resolves, that side simply never fires (same as
   * pairStrategy), rather than silently falling back to the pool. */
  directionStrategy?: { call?: string; put?: string }
  direction: 'both' | 'call' | 'put'
  /** Instead of locking onto the single highest-ranked qualifying pair every
   * tick (which, since indicator reads move slowly between 10s ticks, meant
   * the SAME pair could legitimately out-score the whole pool for minutes
   * on end and monopolize every trade), collect the top N qualifying
   * candidates this tick and pick ONE of them at random. 1 (default) = the
   * original strict-best behavior, unchanged. >1 spreads trades across
   * whatever's genuinely in the "best range" this tick instead of always
   * the single top one - the whole pool still gets covered over time
   * instead of one pair soaking up every slot, while a pair that doesn't
   * even clear the qualifying bar can never be picked just by bad luck.
   * Applies to the 'strategy' source, which ranks/scores the whole
   * candidate pool before picking; chartsignals/leadlag/cointegration/
   * triangulation/adx-pattern-bias each pick the first pair that clears
   * their own thresholds in priority order and are unaffected. */
  pickVariety?: number
  maxOpen: number // max concurrent auto-trader positions
  cooldownSec: number // per-asset re-entry cooldown
  paceSec: number // minimum seconds between any two auto trades
  dailyProfitTarget: number // 0 = off
  dailyLossLimit: number // 0 = off
  /** Optional pair restriction. Empty/omitted = GLOBAL (every open instrument,
   * the original behavior, unchanged). Non-empty = gated by watchlistMode,
   * for ANY signalSource - same choke point (assetBlocked) every candidate
   * loop already filters through. */
  watchlist: string[]
  /** How a non-empty watchlist is applied. 'only' (default when unset) -
   * trade ONLY these tickers, nothing else (the original, unchanged
   * behavior). 'exclude' - trade every open instrument EXCEPT these -
   * a deny-list for a pair you've found unreliable or just don't want
   * touched, without having to hand-list every other pair you DO want. */
  watchlistMode?: 'only' | 'exclude'
  /** Market-scope separation: which FEED FAMILY the auto-trader may touch.
   * 'all' (default, the original behavior) - real and -OTC pairs alike.
   * 'real' - REAL exchange-traded feeds only (-OTC tickers excluded):
   * real microstructure, sessions, liquidity - where TA edges can exist.
   * 'otc' - broker-generated -OTC feeds only: the generator's own market.
   * The point is CONFLICT-FREE configs - a strategy validated on real EURUSD
   * must never silently fire on EURUSD-OTC (a different, synthetic price
   * series), and vice versa. Enforced in assetBlocked(), so every signal
   * source, pin and watchlist mode funnels through the same gate. */
  marketScope?: 'all' | 'real' | 'otc'
  /** Scales the stake with how strong THIS signal is, instead of every
   * trade risking the same flat `stake`. Uses the same 0-100 confidence
   * every source already reports on its ScreenRow (raw |score|-derived for
   * screener/kalman-ou/markov/momentum/confluence, agreement % for an
   * ensemble, or the proven Wilson win rate for an auto-learn pick) - so it
   * needs no new signal, just reads the one already computed. Multiplier
   * ranges 0.5x (at/near the confidence floor) to 1.5x (near-certain reads),
   * applied on top of a compounding plan's rolled amount too, before that
   * plan's own maxStake clamp. Default false - opt-in, since it changes bet
   * sizing, not just entry/exit logic. */
  smartStaking?: boolean
  /** Treats correlated pairs as the same bet for concurrency purposes, not
   * just a raw position count - having 3 "different" open positions that
   * are actually all EUR-major or all metals isn't the diversification
   * maxOpen implies. Blocks opening a NEW auto position in a pair that
   * shares a correlation group (CORRELATION_GROUPS below) with one the
   * auto-trader already has open. Default true (on) unless explicitly
   * turned off - this is a pure risk reduction with no tradeoff besides
   * occasionally standing aside for a pair with no open slot. */
  correlationGuard?: boolean
  /** Benches a (strategy, pair) combo after a run of consecutive losses -
   * independent of the daily $ loss limit, which only trips on aggregate
   * P&L and can take a while to notice "this one setup stopped working this
   * week." Bench duration grows with streak length (15min at 3 losses in a
   * row, doubling per extra loss, capped at 4h) and clears itself once the
   * cooldown elapses - no manual restart needed, unlike the compounding
   * stop-on-loss halt. Default true (on) unless explicitly turned off. */
  streakBreaker?: boolean
  /** Stands aside on non-OTC pairs during the historically thinnest FX
   * liquidity window (21:00-23:00 UTC - after NY closes, before Tokyo/Asia
   * really gets going), where spreads widen and a strategy's daytime edge
   * is least likely to hold. Never applies to -OTC synthetic tickers, which
   * trade the same broker-generated walk around the clock and have no real
   * "session" to avoid. Default false - opt-in, since it's a scheduling
   * restriction some setups (e.g. a pure OTC watchlist) have no use for. */
  avoidDeadHours?: boolean
  /** PAYOUT FLOOR (the EV gate): never place a trade when the pair's LIVE
   * binary payout is below this percent. This is the one lever our own
   * research (Task 50-54: no predictive edge exists on synthetic feeds;
   * breakeven at payout p is 1/(1+p)) says actually moves expected value:
   * at 82% payout breakeven is 54.9%, at 65% it's 60.6% - a signal that's
   * worth taking at one payout can be pure house-edge at a lower one, and
   * payouts MOVE per pair per hour. Enforced per candidate right before
   * placement (freshest number wins), a rejected pair sits out 10 minutes
   * so the picker tries the next candidate instead of re-hitting it every
   * tick. 0 = gate off. Default 70 (DEFAULT_AUTOTRADER) - permissive when
   * the account hasn't reported a payout yet (metadata cold / sim mode).
   * Clamped 0..98: 98+ would strand the trader - real IQ payouts top out
   * in the mid-90s. */
  minPayoutPct?: number
  /** Vol-spike gate: 'avoid-volatile' stands a pair down while the SAME
   * 4-way regime classifier the bots use (classifyRegime: ADX + Hurst +
   * garch-vs-ewma vol) reads VOLATILE for it - i.e. a vol spike is active
   * (garchVol > 1.6x ewmaVol). Grounded in the Task 53 contrast study:
   * REAL feeds carry genuine vol clustering (|r| autocorr ~0.24, 10-sigma),
   * so the bar right after a spike behaves differently from the calm that
   * most 1m signal engines were tuned on; synthetic OTC feeds have no vol
   * memory at all, so there the gate simply never fires. Default 'off'. */
  volGate?: 'off' | 'avoid-volatile'
  /** Optional compounding plan - SAME shape and semantics as a bot's
   * stakePlan in autopilot.ts (payoutCap, periods, derisk, stopOnLoss). undefined
   * = fixed `stake` every trade, unchanged behavior. Auto-trader is
   * single-asset-at-a-time by construction (maxOpen governs it), which is
   * exactly the constraint autopilot.ts's compound bots are hard-clamped to -
   * no extra restriction needed here. */
  stakePlan?: AutoStakePlan
  /** Runtime roll state, persisted here (saveOsMode persists the whole config
   * blob) rather than a separate table - mirrors BotConfig.planState. */
  planState?: { pot: number; rollN: number; restarts: number; halted: boolean; complete: boolean }
}

export interface AutoStakePlan {
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

export const DEFAULT_AUTOTRADER: AutoTraderConfig = {
  enabled: true,
  signalSource: 'chartsignals',
  tf: '1m',
  expiryTf: undefined,
  stake: 10,
  minScore: 60,
  minConfidence: 55,
  cointegrationZEntry: 1.5,
  cointegrationMaxHalfLife: COINTEGRATION_MAX_HALFLIFE,
  triangulationZEntry: TRIANGULATION_Z_ENTRY,
  direction: 'both',
  maxOpen: 3,
  cooldownSec: 3600, // every pair gets a hard 1hr rest after it trades - see MIN_ASSET_COOLDOWN_SEC
  paceSec: 45,
  dailyProfitTarget: 0,
  dailyLossLimit: 0,
  watchlist: [],
  marketScope: 'all',
  minPayoutPct: 70, // the EV gate: never fire below a 70% payout (BE 58.8%)
  volGate: 'off',
}
// stakePlan/planState intentionally omitted from DEFAULT_AUTOTRADER above
// (undefined = fixed-stake, the original unconditional behavior)

const AUTOTRADER_NOTE = 'auto:os-trader'
/** The sweep-based auto-trader signal sources - the ones whose fresh-edge
 * discipline is enforced by SweepEdgeMemory ('strategy' instead phase-gates
 * its votes at the eval). Only these sources can guarantee every placed
 * trade is a FRESH edge, so only their alerts carry the "why now" crossing
 * note the pickers attach. */
const SWEEP_SOURCES: readonly string[] = ['chartsignals', 'leadlag', 'cointegration', 'triangulation', 'adx-pattern-bias', 'shock-pressure']
/** analytics/chartsignals.ts combineVotes() now groups the 7 raw chart
 * engines into 5 independent-METHODOLOGY families before counting `agree`
 * - renko/range/P&F (all "price crossed N ATR-thresholds" read three ways)
 * collapse into ONE price-threshold family vote, so they can only ever
 * contribute a single "agree" between them instead of three. combineVotes'
 * own qualifying floor is minAgree=2 of 5 families (~40%) - every signal
 * chartsignals.ts hands back already cleared that bar. This auto-trader
 * source keeps the same "+1 above the scanner's own floor" safety margin
 * that existed before the family fix (the margin was never a correction of
 * the correlation, the family grouping is - this is just extra headroom on
 * top): 2 + 1 = 3 of 5 families (~57%), which reproduces the original
 * 4-of-7 (~57%) intent on the new family-counted scale rather than the old
 * raw-engine scale. (Previously: minAgree=3/7 default + 1 margin = 4/7,
 * before the price-threshold trio was collapsed into one family.) */
const CHARTSIGNALS_MIN_AGREE = 3
/** Liquid fallback evaluated on demand while the full screener sweep warms up. */
const LIQUID_CANDIDATES = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD', 'BTCUSD']

// LEADLAG_GROUPS/LEADLAG_MIN_ABS_CORRELATION/LEADLAG_MIN_TRIGGER_Z/
// LEADLAG_LOOKBACK_BARS moved to analytics/leadlag.ts (imported above) -
// that's a plugin-free module strategies/backtest.ts can also depend on
// without risking an import cycle back through this file (os-mode.ts
// already imports strategies/optimize.ts, which imports
// strategies/backtest.ts). Re-exported here so leadlagscan.ts and any
// other existing importer of these names from os-mode.ts keeps working.
export { LEADLAG_GROUPS, LEADLAG_MIN_ABS_CORRELATION, LEADLAG_MIN_TRIGGER_Z, LEADLAG_LOOKBACK_BARS } from '../analytics/leadlag'

interface AutoRuntime {
  dayKey: string
  trades: number
  wins: number
  losses: number
  pnlToday: number
  pnlTotal: number
  openCount: number
  lastTradeTs: number
  lastAssetTs: Map<string, number>
  lastRejection?: string
  lastAction?: string
  pot: number // compounding roll; 0 = fresh cycle at base
  rollN: number
  restarts: number
  halted: boolean // stop-on-loss: cycle ended, awaiting explicit restart
  complete: boolean // halted on the periods target (win-side completion)
}

export class ModeService {
  private ctx!: KernelContext
  private store!: Store
  private unsubscribers: (() => void)[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  /** Broker-side "this pair isn't tradable right now" rejections - not a
   * misconfiguration, just our is_open cache lagging IQ's own schedule
   * (weekend OTC closures, mid-day suspensions). Matches the sidecar's
   * `order rejected: Cannot purchase an option (the asset is not available
   * at the moment).` and the "not a turbo/binary/digital instrument"
   * account-mismatch rejection, plus the sidecar's `Active %!s(MISSING) not
   * found.` rejection (a Go fmt bug on the sidecar's side drops the active_id
   * into that "%!s(MISSING)" placeholder, but the "active ... not found"
   * shape is stable - this fires when our active_id map is stale/wrong for
   * an asset, e.g. right after an IQ instrument catalog refresh swaps ids
   * out from under us). Without matching this one too, assetRejectedUntil
   * never gets set and the picker re-selects the exact same dead active_id
   * on every single 10s tick forever - which is exactly what the logs showed:
   * hundreds of back-to-back "Active ... not found" rejections for the same
   * handful of active_ids while everything else kept trading fine. */
  private static BROKER_UNAVAILABLE_RE = /not available at the moment|is not a (?:turbo\/binary\/digital|digital\/turbo\/binary) instrument|active\b[^.]*not found/i
  private static BROKER_UNAVAILABLE_COOLDOWN_SEC = 600
  // An OTC pair blocked by the placebo defense keeps its verdict until the
  // TTL expires or a new defense run lands - re-probing every tick would just
  // spam the same rejection; 30 min is long enough to be quiet, short enough
  // that a policy flip or a fresh 'edge' verdict is honored promptly.
  private static OTC_DEFENSE_COOLDOWN_SEC = 1800
  /** Payout-floor re-probe cadence: payouts move per pair per hour, so a
   * pair rejected for paying under the floor gets 10 minutes off (not the
   * 30-60min the harder gates use) - it may legitimately clear the floor
   * again on the next quote refresh. */
  private static PAYOUT_FLOOR_COOLDOWN_SEC = 600
  /** Vol-gate re-probe cadence: a GARCH-detected spike decays on the scale
   * of minutes-to-tens-of-minutes; re-check a benched pair every 5. */
  private static VOL_GATE_COOLDOWN_SEC = 300
  /** Bound on how many times one tick will re-pick and retry after a
   * broker-unavailable rejection before giving up and standing down - keeps
   * a systemic outage (the whole active_id map stale at once) from turning
   * one tick into an unbounded loop, while still giving the tick a real
   * chance to work its way down the ranked pool to a pair that's actually
   * tradable, instead of giving up after exactly one try. */
  private static MAX_PLACE_ATTEMPTS_PER_TICK = 6
  /** Hard floor for the per-asset re-entry cooldown (assetBlocked) - a pair
   * the auto-trader just traded always sits out at least this long, however
   * cooldownSec is configured. */
  private static MIN_ASSET_COOLDOWN_SEC = 3600
  /** asset -> unix ts until which pickSignal skips it, set on the rejection
   * above so the SAME closed pair isn't retried (and re-rejected) on every
   * 10s tick until the asset cache has a chance to catch up. */
  private assetRejectedUntil = new Map<string, number>()

  /** Pairs that tend to move together, for correlationGuard - grouped
   * loosely by what actually drives them (shared base/quote currency,
   * shared commodity/metal complex, shared crypto beta), not a computed
   * correlation coefficient. Good enough to catch "these 3 open positions
   * are really one bet" without needing a live correlation matrix. OTC
   * suffixes are stripped before matching, so e.g. EURUSD-OTC still groups
   * with GBPUSD-OTC. */
  // Task: lead-lag (LEADLAG_GROUPS below) argues several of these followers
  // are driven by one leader's shock - but until this list said so too,
  // correlationGuard treated e.g. an open XAUUSD position and a fresh
  // XPTUSD signal as two "diversified" bets instead of one. Metals, the
  // full crypto roster, and the oil-linked CAD crosses were widened to
  // match LEADLAG_GROUPS' followers so the two systems agree on what
  // counts as "really one exposure" - not a coincidence, lead-lag is
  // explicitly betting that these move together.
  private static CORRELATION_GROUPS: string[][] = [
    ['EURUSD', 'GBPUSD', 'EURGBP', 'EURCHF', 'EURJPY', 'EURAUD', 'EURCAD'],
    ['AUDUSD', 'NZDUSD', 'AUDNZD', 'AUDCAD'],
    ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CHFJPY'],
    ['USDCAD', 'USDCHF', 'CADJPY', 'CADCHF'],
    ['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD'],
    [
      'BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD', 'ADAUSD', 'DOGEUSD', 'LTCUSD', 'BCHUSD',
      'DOTUSD', 'AVAXUSD', 'LINKUSD', 'TRXUSD', 'XLMUSD', 'ETCUSD', 'ATOMUSD', 'NEOUSD', 'UNIUSD',
    ],
  ]

  private static stripOtc(asset: string): string {
    return asset.endsWith('-OTC') ? asset.slice(0, -4) : asset
  }

  /** Which correlation group (index into CORRELATION_GROUPS) an asset
   * belongs to, or null if it's not in any tracked group - an asset with no
   * known group never blocks or gets blocked by correlationGuard. */
  private static correlationGroupOf(asset: string): number | null {
    const bare = ModeService.stripOtc(asset)
    const idx = ModeService.CORRELATION_GROUPS.findIndex((g) => g.includes(bare))
    return idx === -1 ? null : idx
  }

  /** streak-breaker state, keyed "<strategyLabel>|<asset>" (the exact
   * identity a settled position.strategy + position.asset pair carries) -
   * independent of the daily runtime (rt), since a losing streak and its
   * bench should survive a midnight rollover same as everything else that
   * isn't a daily counter. */
  private lossStreak = new Map<string, number>()
  private benchedUntil = new Map<string, number>()
  /** pickStrategySignal's own round-robin cursor into the candidate pool
   * (NOT shared with the other signal sources, which early-return on the
   * first qualifying pair and so stay cheap on their own) - see
   * MAX_TICK_CANDIDATES below for why this exists. */
  private strategyTickCursor = 0
  private static STREAK_BENCH_THRESHOLD = 3 // consecutive losses before a bench kicks in
  private static STREAK_BENCH_BASE_SEC = 900 // 15min at exactly the threshold
  private static STREAK_BENCH_MAX_SEC = 14400 // 4h cap, however long the streak runs

  mode: OsMode = 'human'
  ts = Math.floor(Date.now() / 1000)
  reason = 'initial state'
  config: AutoTraderConfig = { ...DEFAULT_AUTOTRADER }
  private rt: AutoRuntime = ModeService.freshRuntime()
  /** Edge memory for the screener source: (asset:dir) pairs that were ALREADY
   * qualifying when autonomy armed (value = arm-time, kernel epoch seconds)
   * or that a placed trade consumed (value = execution time). The screener's
   * qualifying feed is the complete universe for its source, so each tick
   * refreshes this map's honesty: keys that lapse out of the feed are removed
   * (their next appearance is a genuine fresh edge), keys that persist keep
   * blocking. Without it the first tick after arming would happily trade
   * whatever had been sitting in the top-12 for the last hour - the exact
   * "condition that already true" failure mode. */
  private autoEdgeBackfill = new Map<string, { since: number; origin: 'backfill' | 'executed' }>()

  /** Same edge memory for the four PRIORITY-ORDER sweep sources
   * (kalman-ou/markov/momentum/confluence): they early-return the first
   * qualifying pair, so there is no complete per-tick universe to diff -
   * "has this condition been true for a while?" is remembered across ticks
   * per (asset, direction) instead. Cold backfill on arm/restart/source
   * switch, stamp on execution, lapse pruning per observed sweep. */
  private sweepEdge = new SweepEdgeMemory()

  static freshRuntime(): AutoRuntime {
    return {
      dayKey: new Date().toISOString().slice(0, 10),
      trades: 0,
      wins: 0,
      losses: 0,
      pnlToday: 0,
      pnlTotal: 0,
      openCount: 0,
      lastTradeTs: 0,
      lastAssetTs: new Map(),
      pot: 0,
      rollN: 0,
      restarts: 0,
      halted: false,
      complete: false,
    }
  }

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.store = ctx.use<Store>('store')

    // restore persisted mode + auto-trader config
    const saved = this.store.getOsMode()
    if (saved) {
      if (saved.mode === 'auto' || saved.mode === 'human') this.mode = saved.mode
      this.reason = saved.reason ?? 'restored'
      this.ts = saved.ts || this.ts
      if (saved.config && typeof saved.config === 'object') {
        const c = saved.config as Record<string, unknown>
        const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb)
        this.config = {
          enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULT_AUTOTRADER.enabled,
          signalSource: (['cointegration', 'triangulation', 'adx-pattern-bias', 'shock-pressure', 'strategy', 'chartsignals', 'leadlag'] as const).includes(c.signalSource as AutoTraderSource)
            ? (c.signalSource as AutoTraderSource)
            : DEFAULT_AUTOTRADER.signalSource,
          tf: (typeof c.tf === 'string' && (ALL_TIMEFRAMES as string[]).includes(c.tf) ? c.tf : DEFAULT_AUTOTRADER.tf) as Timeframe,
          expiryTf: typeof c.expiryTf === 'string' && (ALL_TIMEFRAMES as string[]).includes(c.expiryTf) ? (c.expiryTf as Timeframe) : undefined,
          stake: clamp(num(c.stake, DEFAULT_AUTOTRADER.stake), 1, 5000),
          minScore: clamp(num(c.minScore, DEFAULT_AUTOTRADER.minScore), 0, 100),
          minConfidence: clamp(num(c.minConfidence, DEFAULT_AUTOTRADER.minConfidence), 0, 100),
          cointegrationZEntry: num(c.cointegrationZEntry, DEFAULT_AUTOTRADER.cointegrationZEntry),
          cointegrationMaxHalfLife: num(c.cointegrationMaxHalfLife, DEFAULT_AUTOTRADER.cointegrationMaxHalfLife),
          triangulationZEntry: num(c.triangulationZEntry, DEFAULT_AUTOTRADER.triangulationZEntry),
          strategyId: typeof c.strategyId === 'string' && c.strategyId.trim() ? c.strategyId.trim() : undefined,
          strategyIds: Array.isArray(c.strategyIds)
            ? c.strategyIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
            : undefined,
          strategyPickMode: c.strategyPickMode === 'best' ? 'best' : 'ensemble',
          autoDiscover: typeof c.autoDiscover === 'boolean' ? c.autoDiscover : false,
          strategyParams: ModeService.sanitizeStrategyParams(c.strategyParams),
          pairStrategy: ModeService.sanitizePairStrategy(c.pairStrategy),
          directionStrategy: ModeService.sanitizeDirectionStrategy(c.directionStrategy),
          direction: c.direction === 'call' || c.direction === 'put' ? c.direction : 'both',
          maxOpen: clamp(Math.round(num(c.maxOpen, DEFAULT_AUTOTRADER.maxOpen)), 1, 10),
          cooldownSec: Math.round(num(c.cooldownSec, DEFAULT_AUTOTRADER.cooldownSec)),
          paceSec: Math.round(num(c.paceSec, DEFAULT_AUTOTRADER.paceSec)),
          dailyProfitTarget: num(c.dailyProfitTarget, 0),
          dailyLossLimit: num(c.dailyLossLimit, 0),
          watchlist: Array.isArray(c.watchlist)
            ? c.watchlist.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toUpperCase()).filter(Boolean)
            : [],
          watchlistMode: c.watchlistMode === 'exclude' ? 'exclude' : 'only',
          marketScope: c.marketScope === 'real' || c.marketScope === 'otc' ? c.marketScope : 'all',
          smartStaking: typeof c.smartStaking === 'boolean' ? c.smartStaking : false,
          correlationGuard: typeof c.correlationGuard === 'boolean' ? c.correlationGuard : true,
          streakBreaker: typeof c.streakBreaker === 'boolean' ? c.streakBreaker : true,
          avoidDeadHours: typeof c.avoidDeadHours === 'boolean' ? c.avoidDeadHours : false,
          minPayoutPct: clamp(num(c.minPayoutPct, DEFAULT_AUTOTRADER.minPayoutPct ?? 70), 0, 98),
          volGate: c.volGate === 'avoid-volatile' ? 'avoid-volatile' : 'off',
          stakePlan: this.parseStakePlan(c.stakePlan),
          planState: ModeService.isPlanState(c.planState) ? c.planState : undefined,
        }
      }
    }
    this.rebuildRuntime()
    this.syncTimer()
    ctx.log(
      'mode',
      `OS mode: ${this.mode.toUpperCase()} (${this.reason}) - auto-trader ${this.config.enabled ? 'armed' : 'off'} · src ${this.config.signalSource}`
    )
  }

  stop(): void {
    for (const u of this.unsubscribers) u()
    this.unsubscribers = []
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private now(): number {
    return Math.floor(Date.now() / 1000)
  }

  private persist(): void {
    this.store.saveOsMode(this.mode, this.reason, this.ts, this.config)
  }

  private event(level: 'info' | 'warn' | 'danger' | 'success', message: string): void {
    this.store.recordRiskEvent('mode', message, this.now())
    this.ctx.bus.emit('alert', { level, message, ts: this.now() })
  }

  // ---------- mode gate ----------

  /**
   * Origin-aware gate consulted before non-human orders.
   * HUMAN mode suspends autonomy (bots are blocked; the auto-trader never
   * even starts). Manual and copilot trades are human-initiated by definition
   * and always pass - the human can always intervene.
   */
  gate(origin: 'bot' | 'auto'): { ok: boolean; reason?: string } {
    if (this.mode === 'auto') return { ok: true }
    return {
      ok: false,
      reason:
        origin === 'bot'
          ? 'mode-gate: HUMAN-IN-THE-LOOP mode - bot orders suspended (switch the OS to NO-HUMAN mode to run autonomy)'
          : 'mode-gate: HUMAN-IN-THE-LOOP mode - autonomous trading suspended',
    }
  }

  // ---------- mode switching ----------

  setMode(next: OsMode, reason?: string): { ok: boolean; mode: OsMode; changed: boolean } {
    if (next === this.mode) return { ok: true, mode: this.mode, changed: false }
    this.mode = next
    this.reason = reason ?? (next === 'auto' ? 'operator enabled no-human mode' : 'operator restored human control')
    this.ts = this.now()
    this.persist()
    this.syncTimer()

    if (next === 'auto') {
      let armed = 0
      try {
        const bots = this.ctx.use<{ listBots(): { bot: { enabled: boolean } }[] }>('autopilot')
        armed = bots.listBots().filter((b) => b.bot.enabled).length
      } catch {
        // autopilot not loaded
      }
      this.event(
        'warn',
        `MODE -> NO-HUMAN-IN-THE-LOOP: the OS trades autonomously (${armed} bot${armed === 1 ? '' : 's'} armed, auto-trader ${this.config.enabled ? 'ARMED' : 'off'}). Sentinel, watchdog and risk limits still govern every order.`
      )
    } else {
      this.event(
        'success',
        `MODE -> HUMAN-IN-THE-LOOP: every trade now needs you. Bots + auto-trader suspended (configs preserved) - manual trading unaffected.`
      )
    }
    return { ok: true, mode: this.mode, changed: true }
  }

  /** PANIC semantics: the human took over - autonomy ends immediately. */
  forceHuman(reason: string): void {
    if (this.mode !== 'auto') return
    this.setMode('human', reason)
  }

  private syncTimer(): void {
    const wantRunning = this.mode === 'auto'
    if (wantRunning && !this.timer) {
      // wrapped: tick() places real/paper orders every 10s outside any
      // request's try/catch - a rejected promise here (one bad pick, one
      // throwing picker) must never take the whole process down and stop
      // every other kernel plugin's timers with it.
      const safeTick = () =>
        void this.tick().catch((err) => this.ctx.log('os-mode', `autotrader tick() rejected, skipping this cycle: ${(err as Error).message}`))
      this.timer = setInterval(safeTick, 10_000)
      this.armAutoEdgeBackfill()
      safeTick() // act immediately on entry
    } else if (!wantRunning && this.timer) {
      clearInterval(this.timer)
      this.timer = null
      this.rt.lastRejection = undefined
    }
  }

  /** Snapshot the screener's CURRENTLY qualifying (asset,dir) pairs into the
   * backfill set - everything in it is treated as an already-true condition
   * until it is observed lapsing. Cheap (one screener.top call), best-effort
   * (a cold screener just backfills less; cooldowns still apply). The four
   * sweep sources backfill differently - their sweepEdge memory re-colds so
   * the first sweep after this arm records what qualifies WITHOUT trading. */
  private armAutoEdgeBackfill(): void {
    this.autoEdgeBackfill.clear()
    this.sweepEdge.rearm()
    try {
      const screener = this.ctx.use<ScreenerService>('screener')
      const { rows } = screener.top({ tf: this.config.tf, limit: 500 })
      for (const r of rows) {
        if (r.direction === 'none') continue
        this.autoEdgeBackfill.set(`${r.asset}:${r.direction}`, { since: this.now(), origin: 'backfill' })
      }
      if (this.autoEdgeBackfill.size) {
        this.ctx.log('os-mode', `[auto-trader] edge backfill: ${this.autoEdgeBackfill.size} pair-direction(s) already qualifying at arm - waiting for fresh edges`)
      }
    } catch {
      // screener not loaded / still warming - nothing to backfill yet
    }
  }

  // ---------- auto-trader (the OS as its own trader) ----------

  private async tick(): Promise<void> {
    if (this.mode !== 'auto' || this.ticking) return
    this.ticking = true
    try {
      await this.autoTraderTick()
    } catch (err) {
      this.ctx.log('mode', 'auto-trader tick failed:', (err as Error).message)
    } finally {
      this.ticking = false
    }
  }

  private async autoTraderTick(): Promise<void> {
    if (!this.config.enabled) return
    this.rolloverIfNeeded()
    if (this.config.signalSource === 'strategy' && this.config.strategyPickMode === 'best' && this.config.autoDiscover === true) {
      this.maybeAutoDiscover()
    }

    // compound stop-on-loss / completion: a halted or completed cycle is DEAD
    // until an explicit restart(). AUDIT FIX (Task 58, P2): the old condition
    // `stopOnLoss !== false && halted` meant a config with stopOnLoss:false +
    // periods:N + onComplete:'halt' NEVER halted - the full banked pot kept
    // being wagered and every further win re-tripped "cycle COMPLETE". The
    // flag is the single source of truth here; stopOnLoss only governs
    // whether a LOSS halts the cycle, not whether a halt is respected.
    if (this.rt.halted || this.rt.complete) {
      return this.standDown(
        this.rt.complete
          ? `compound cycle COMPLETE (${this.rt.rollN}/${this.config.stakePlan?.periods ?? '?'} periods banked) - restart for a fresh cycle`
          : 'compound cycle ended on a loss - restart to trade again',
      )
    }

    // self-imposed limits (the global risk manager remains the final gate)
    if (this.config.dailyProfitTarget > 0 && this.rt.pnlToday >= this.config.dailyProfitTarget)
      return this.standDown(`profit target reached (+$${this.rt.pnlToday.toFixed(2)})`)
    if (this.config.dailyLossLimit > 0 && this.rt.pnlToday <= -this.config.dailyLossLimit)
      return this.standDown(`daily loss limit hit (-$${Math.abs(this.rt.pnlToday).toFixed(2)})`)
    if (this.rt.openCount >= this.config.maxOpen)
      return this.standDown(`max open auto positions (${this.rt.openCount}/${this.config.maxOpen})`)
    // Task 59: this used to be a SILENT return - the trader looked armed but
    // nothing surfaced why. A STATIC reason (no countdown) keeps the
    // standDown dedupe from spamming one alert per tick.
    if (this.config.paceSec > 0 && this.rt.lastTradeTs > 0 && this.now() - this.rt.lastTradeTs < this.config.paceSec)
      return this.standDown(`pacing: minimum ${this.config.paceSec}s between trades not yet elapsed`)

    // source signals: ranked screener feed first, liquid on-demand eval while the sweep warms up
    // (pickSignal already applies per-asset cooldowns + one-auto-position-per-asset)
    //
    // A single broker-side "this pair isn't tradable" rejection used to end
    // the WHOLE tick - stand down, wait out paceSec/the next 10s tick, try
    // again. That's fine when it's one occasionally-stale pair, but when the
    // active_id map itself has drifted (e.g. right after an IQ instrument
    // catalog refresh swaps ids out from under us - the exact symptom in the
    // logs: "Active ... not found" on pair after pair), standing down after
    // the FIRST rejection meant the auto-trader could go an entire session
    // without ever landing a trade, even though plenty of pairs would have
    // worked fine once the stale one was skipped. So: on a broker-unavailable
    // rejection, cool that asset down (same as before) and immediately
    // re-pick and retry IN THE SAME TICK instead of giving up - bounded so a
    // systemic outage can't spin forever. Any other kind of rejection (risk
    // manager block, insufficient funds, a real misconfiguration) still
    // stands down immediately, unchanged - those aren't "try a different
    // pair" situations.
    let lastReason = 'no signal meets the auto-trader thresholds yet'
    let refreshedAssetsThisTick = false
    for (let attempt = 0; attempt < ModeService.MAX_PLACE_ATTEMPTS_PER_TICK; attempt++) {
      const row = this.pickSignal()
      if (!row) break

      // copilot memory gate: standing rules from the copilot's persistent memory
      // ("never trade Fridays", "only trade ...", "max stake $...", rate caps)
      // bind the OS's own trader too - the user's words outrank the machine
      const bet = this.stakeForAuto(row)
      // Task 58 (P1): port autopilot's compound over-bet guard - with a dust
      // pot the old stakeForAuto floor bet Math.max(1, ...) i.e. MORE than
      // the pot, and a loss burned the whole cycle via the silent reseed in
      // the fold math. The honest move is the same one autopilot makes:
      // stand the cycle down with the restart hint.
      if (bet.compound && bet.pot >= 0.01 && bet.amount > bet.pot) {
        return this.standDown(
          `compound pot $${bet.pot.toFixed(2)} is below the $1 broker minimum stake - restart the auto-trader cycle to re-seed`,
        )
      }
      try {
        const mg = this.ctx.use<{ check: (asset: string, stake: number) => { ok: boolean; reason?: string } }>('memoryGate')
        const g = mg.check(row.asset, bet.amount)
        if (!g.ok) return this.standDown(g.reason ?? 'memory gate hold') // a rule, not a broker hiccup - don't retry a different pair around it
      } catch {
        // memory gate plugin not loaded - rule gating disabled
      }

      // OTC defense gate: generator-driven OTC charts don't respect TA. Under
      // policy 'enforce', an OTC pair may only be auto-traded when the
      // strategies that would actually decide for it hold a fresh passing
      // placebo verdict (plugins/otcguard.ts). AUDIT FIX (Task 58, P2): the
      // check used to be keyed by signalSource ('screener'/'confluence'/...)
      // - a key no verdict is ever minted under - so under enforce the
      // auto-trader could never trade ANY OTC pair even when its configured
      // strategies had fresh passing verdicts (the autopilot side already
      // checked the right key). Now every strategy that would be consulted
      // for THIS asset (pins first, then pool, then fixed sources) must pass;
      // fixed sources (screener etc.) still fail honestly under enforce -
      // there is no placebo evidence for a non-strategy signal.
      try {
        const guard = this.ctx.use<{ check: (target: { asset: string; otc?: boolean }, strategyKey: string) => { ok: boolean; reason?: string } }>('otcGuard')
        if (row.otc) {
          let verdict: { ok: boolean; reason?: string } | null = null
          for (const key of this.otcStrategyKeysFor(row.asset)) {
            const g = guard.check({ asset: row.asset, otc: row.otc }, key)
            if (!g.ok) {
              verdict = g
              break
            }
          }
          if (verdict) {
            this.assetRejectedUntil.set(row.asset, this.now() + ModeService.OTC_DEFENSE_COOLDOWN_SEC)
            lastReason = verdict.reason ?? 'OTC defense gate hold'
            continue
          }
        }
      } catch {
        // otc guard plugin not loaded - OTC gating disabled
      }

      // PAYOUT FLOOR (the EV gate): the one lever our own research says moves
      // expected value. Breakeven at payout p is 1/(1+p) - 54.9% at 82%,
      // 60.6% at 65% - so a signal worth taking at one payout can be pure
      // house-edge minutes later at a lower one. Checked HERE (not in
      // assetBlocked) so the rejection is VISIBLE: the pair is cooled down
      // like a broker-unavailable pair and the loop moves to the next
      // candidate, and if nothing qualifies the reason surfaces via
      // standDown instead of the picker silently skipping forever.
      // row.payout comes from the screener's payoutFor() (0-1 fraction);
      // missing/stale rows fall back to a direct read. pay <= 0 = unknown ->
      // permissive (the same don't-hide-on-cold-metadata contract the
      // options-capability gate uses).
      const minPay = (this.config.minPayoutPct ?? 0) / 100
      if (minPay > 0) {
        // Task 58 (P3): the FRESH read wins - row.payout was frozen when the
        // screener row was built (payouts re-quote per pair per hour), so a
        // payout that has since dropped below the floor used to pass on the
        // stale number (and a stale low number benched a pair that now pays
        // fine). The stale row value is only a fallback for cold metadata.
        const freshPay = this.payoutFor(row.asset, 'binary')
        const pay = freshPay > 0 ? freshPay : row.payout
        if (pay > 0 && pay < minPay) {
          this.assetRejectedUntil.set(row.asset, this.now() + ModeService.PAYOUT_FLOOR_COOLDOWN_SEC)
          lastReason = `payout ${(pay * 100).toFixed(0)}% below the ${this.config.minPayoutPct}% floor (breakeven ${((100 / (1 + pay))).toFixed(1)}% here) - waiting for a better-paying pair`
          continue
        }
      }

      // VOL-SPIKE GATE: stand a pair down while classifyRegime reads
      // VOLATILE (garchVol > 1.6x ewmaVol) for it - real feeds carry genuine
      // vol clustering (Task 53), and the bar right after a spike behaves
      // differently from the calm most 1m engines are tuned on. Checked
      // per-candidate here (one analyze per attempt, not per universe row)
      // with the same visible-rejection + cooldown treatment as the payout
      // floor. Synthetic OTC feeds have no vol memory, so there the gate
      // never fires - it costs one cheap analyze and changes nothing.
      if (this.config.volGate === 'avoid-volatile' && !row.otc) {
        try {
          const a = this.ctx.use<AnalyticsService>('analytics').analyze(row.asset, this.config.tf)
          const r = classifyRegime(a)
          if (r === 'VOLATILE') {
            this.assetRejectedUntil.set(row.asset, this.now() + ModeService.VOL_GATE_COOLDOWN_SEC)
            lastReason = `vol gate: ${row.asset} regime VOLATILE (garch > 1.6x ewma) - standing aside for the spike to decay`
            continue
          }
        } catch {
          // thin history / analytics unavailable - don't block the trade on a diagnostic that couldn't compute
        }
      }

      const side = row.direction === 'put' ? 'put' : 'call'
      const out = await this.place(row, side, bet.amount)
      if (!out.ok) {
        const reason = out.error ?? 'order rejected'
        lastReason = reason
        if (ModeService.BROKER_UNAVAILABLE_RE.test(reason)) {
          // IQ itself just said this pair isn't tradable right now - our own
          // open/closed cache (sidecarAssetsTs, up to 10 min stale) is already
          // wrong for it, and without this the picker just re-selects the
          // same top-ranked-but-closed pair on the very next 10s tick, so the
          // SAME rejection repeats "a lot" forever. Take it off the table for
          // a while and kick a fresh /assets fetch so the cache catches up
          // sooner than its normal TTL (once per tick - no point asking twice
          // inside the same handful of seconds).
          this.assetRejectedUntil.set(row.asset, this.now() + ModeService.BROKER_UNAVAILABLE_COOLDOWN_SEC)
          if (!refreshedAssetsThisTick) {
            refreshedAssetsThisTick = true
            try {
              this.ctx.use<{ forceRefreshSidecarAssets: () => void }>('market').forceRefreshSidecarAssets()
            } catch {
              // market plugin not loaded - cache catches up on its own next cycle
            }
          }
          continue // try the next-best candidate right now instead of waiting a full tick
        }
        return this.standDown(reason) // not a "pick a different pair" situation - stand down as before
      }

      // Edge stamp ON EXECUTION, never on pick: a fresh edge that a transient
      // rejection blocked stays fresh and is re-picked next tick (the retry
      // loop above), but once a trade actually places the edge is consumed -
      // the still-true condition reads as held from here on, so cooldown
      // expiry can never re-enter the stale middle. The sweep sources'
      // memory is sweepEdge (pruned in edgeSweep); the strategy source
      // needs no stamp - its votes already carry phase (entered/flip only).
      const edgeKey = `${row.asset}:${row.direction}`
      if (this.config.signalSource !== 'strategy') this.sweepEdge.stamp(edgeKey, this.now())
      this.rt.trades += 1
      this.rt.lastTradeTs = this.now()
      this.rt.lastAssetTs.set(row.asset, this.now())
      this.rt.openCount += 1
      this.rt.lastRejection = undefined
      const rollTag = bet.compound ? ` · ${bet.phase} roll x${bet.rollN + 1}${this.config.stakePlan?.periods ? `/${this.config.stakePlan.periods}` : ''} (pot $${bet.pot.toFixed(2)})` : ''
      // The sweep sources only ever reach this block on a FRESH edge
      // (the picker's gate() === 'trade' branch), and each picker attaches a
      // note naming the gate that JUST crossed - surface it in the strip's
      // `last:` state row and in the alert, so the operator reads why the
      // pair qualifies NOW, not just raw indicator values.
      const why = SWEEP_SOURCES.includes(this.config.signalSource) && row.note ? row.note : ''
      this.rt.lastAction = `${side.toUpperCase()} ${row.asset}${rollTag}${why ? ` · ${why}` : ''}`
      const detail =
        this.config.signalSource === 'cointegration'
          ? (row.note ?? `cointegration spread edge ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)} (${row.direction.toUpperCase()})`)
          : this.config.signalSource === 'triangulation'
            ? (row.note ?? `triangulation basis edge ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)} (${row.direction.toUpperCase()})`)
            : this.config.signalSource === 'adx-pattern-bias'
              ? (row.note ?? `ADX ${row.adx.toFixed(0)} + pattern bias, edge ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)} (${row.direction.toUpperCase()})`)
              : this.config.signalSource === 'shock-pressure'
                ? (row.note ?? `shock + pressure, edge ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)} (${row.direction.toUpperCase()})`)
                : this.config.signalSource === 'chartsignals'
                ? (row.note ?? `chart-signals vote ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)} (${row.direction.toUpperCase()})`)
                : this.config.signalSource === 'leadlag'
                  ? (row.note ?? `EUR/USD lead-lag ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)} (${row.direction.toUpperCase()})`)
                  : this.config.signalSource === 'strategy'
                  ? (row.note ?? `${this.effectiveStrategyIds().join('+') || 'strategy'} (${row.direction.toUpperCase()})`)
                  : `score ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)} regime ${row.regime}`
      // Surface paper-vs-live right in the success line itself - this is the
      // one place an operator actually reads "trade placed" and, before this,
      // had no way to tell from the message alone whether it hit the real IQ
      // account or the paper ledger. (UI symptom this fixes: "auto trader
      // took a trade but nothing shows up in IQ Option" - because it was
      // correctly placed on the paper ledger the whole time, just not labeled.)
      let modeTag = ''
      try {
        const exec = this.ctx.use<{ accountSource: 'paper' | 'iq' }>('execution')
        modeTag = exec.accountSource === 'iq' ? ' [LIVE]' : ' [PAPER]'
      } catch {
        // execution plugin unavailable - already failed above via place(), unreachable in practice
      }
      const pay = this.payoutFor(row.asset, 'binary')
      const payTag = pay > 0 ? ` · pay ${(pay * 100).toFixed(0)}% (BE ${(100 / (1 + pay)).toFixed(1)}%)` : ''
      this.emit(
        'success',
        `[AUTO-TRADER]${modeTag} ${side.toUpperCase()} ${row.asset} ${this.config.tf} $${bet.amount.toFixed(2)} binary - ${detail}${why ? ` · fresh edge: ${why}` : ''}${payTag}`
      )
      return
    }
    return this.standDown(lastReason)
  }

  /** Shared by the 'screener' and 'strategy' sources (the two that already
   * rank/score the whole candidate pool instead of taking the first hit in
   * priority order): instead of handing back strictly the single top-metric
   * row every tick, keep the top `variety` qualifying rows and pick ONE of
   * them at random. variety=1 (the default) is the original strict-best
   * behavior - exactly one candidate, nothing to randomize among. `pool`
   * does not need to be pre-sorted; this sorts it itself. */
  private pickRandomFromPool(pool: Array<{ row: ScreenRow; metric: number }>, variety: number): ScreenRow | null {
    if (!pool.length) return null
    const n = Math.max(1, Math.round(variety) || 1)
    if (n <= 1 || pool.length === 1) {
      let best = pool[0]
      for (const p of pool) if (p.metric > best.metric) best = p
      return best.row
    }
    const top = [...pool].sort((a, b) => b.metric - a.metric).slice(0, n)
    return top[Math.floor(Math.random() * top.length)].row
  }

  private pickSignal(): ScreenRow | null {
    if (this.config.signalSource === 'chartsignals') return this.pickChartSignalsSignal()
    if (this.config.signalSource === 'leadlag') return this.pickLeadLagSignal()
    if (this.config.signalSource === 'cointegration') return this.pickCointegrationSignal()
    if (this.config.signalSource === 'triangulation') return this.pickTriangulationSignal()
    if (this.config.signalSource === 'adx-pattern-bias') return this.pickAdxPatternBiasSignal()
    if (this.config.signalSource === 'shock-pressure') return this.pickShockPressureSignal()
    if (this.config.signalSource === 'strategy') return this.pickStrategySignal()
    return null
  }

  /** Shared sweep harness for the priority-order sources: wraps the
   * picker body with the sweepEdge memory so a qualifier only trades when it
   * is FRESH (just crossed its gates), never when it has been sitting there
   * since before the last arm/execution. The `rec` callback must be called
   * once per successfully-read row - with the key when the row fully
   * qualifies under the config gates; a throw (thin history) or a skipped
   * asset records nothing, and unobserved assets never get a lapse verdict. */
  private edgeSweep(
    source: Exclude<AutoTraderSource, 'strategy'>,
    body: (rec: (asset: string, key?: string) => void) => ScreenRow | null,
  ): ScreenRow | null {
    this.sweepEdge.beginSweep(source)
    const evaluated = new Set<string>()
    const qualifying = new Set<string>()
    const pick = body((asset, key) => {
      evaluated.add(asset)
      if (key) qualifying.add(key)
    })
    this.sweepEdge.endSweep(evaluated, qualifying, this.now())
    return pick
  }

  /**
   * Cointegration source: pairs trading on PRICE LEVELS, not returns. Walks
   * every leader group in LEADLAG_GROUPS (same roster lead-lag/cointegration
   * strategies share - see analytics/cointegration.ts's own doc comment),
   * Engle-Granger-fits a rolling hedge ratio between the leader and each
   * follower, and fades the implied spread when it is stretched far enough
   * from its own fitted OU equilibrium (z gate) and that equilibrium is
   * itself statistically real (r2/t-stat gates) and fast enough to be
   * tradeable (half-life cap) - exactly the cointegration-pairs strategy's
   * own gates, applied market-wide instead of pinned to one bot's pair.
   * Picks the single BEST fresh qualifier this sweep, ranked the same way
   * CointegrationPanel/scanCointegration ranks its rows (|z| desc) - not just
   * the first one hit while walking the leader/follower roster.
   */
  private pickCointegrationSignal(): ScreenRow | null {
    return this.edgeSweep('cointegration', (rec) => {
      const fresh: Array<{ row: ScreenRow; metric: number }> = []
      try {
        const market = this.ctx.use<MarketDataService>('market')
        const open = market.assets.filter((a) => a.open).map((a) => a.ticker)
        const pool = this.candidatePool(open)
        const leaderCloseCache = new Map<string, number[] | null>()
        for (const group of LEADLAG_GROUPS) {
          if (!open.includes(group.leader)) continue // leader itself not tradeable right now
          let leaderCloses = leaderCloseCache.get(group.leader)
          if (leaderCloses === undefined) {
            try {
              const leaderCandles = market.getCandles(group.leader, this.config.tf, LEADLAG_LOOKBACK_BARS, true)
              leaderCloses = leaderCandles.length >= 60 ? leaderCandles.map((c) => c.close) : null
            } catch {
              leaderCloses = null
            }
            leaderCloseCache.set(group.leader, leaderCloses)
          }
          if (!leaderCloses) continue // too little leader history to fit a hedge ratio honestly
          const candidates = group.followers.filter((a) => pool.includes(a) && a !== group.leader)
          for (const asset of candidates) {
            if (this.assetBlocked(asset)) continue
            try {
              const followerCandles = market.getCandles(asset, this.config.tf, LEADLAG_LOOKBACK_BARS, true)
              rec(asset)
              if (followerCandles.length < 60) continue // thin history for this follower - try the next
              const followerCloses = followerCandles.map((c) => c.close)
              const fit = fitCointegration(leaderCloses, followerCloses, COINTEGRATION_WINDOW)
              if (!fit) continue
              if (fit.r2 < COINTEGRATION_MIN_R2) continue // hedge-ratio fit too weak - not a reliable pair right now
              if (fit.tStat < COINTEGRATION_MIN_TSTAT) continue // spread not mean-reverting enough
              if (!finGte(fit.halfLifeBars, 0) || fit.halfLifeBars > this.config.cointegrationMaxHalfLife) continue // reverts too slowly
              const zEntry = this.config.cointegrationZEntry
              if (Math.abs(fit.z) < zEntry) continue // fairly priced right now
              const dir: 'call' | 'put' = fit.z <= -zEntry ? 'call' : 'put'
              if (this.config.direction !== 'both' && dir !== this.config.direction) continue
              const score = Math.round(clamp(45 + (Math.abs(fit.z) - zEntry) * 18 + fit.r2 * 15, 40, 95)) * (dir === 'call' ? 1 : -1)
              const confidence = Math.round(clamp(40 + (fit.tStat - COINTEGRATION_MIN_TSTAT) * 10 + (Math.abs(fit.z) - zEntry) * 8, 35, 95))
              if (!finGte(Math.abs(score), this.config.minScore)) continue
              if (!finGte(confidence, this.config.minConfidence)) continue
              const key = SweepEdgeMemory.key(asset, dir)
              rec(asset, key)
              if (this.sweepEdge.gate(key) === 'trade') {
                const inst = market.assets.find((a) => a.ticker === asset)
                fresh.push({
                  metric: Math.abs(fit.z),
                  row: {
                    asset,
                    name: inst?.name ?? asset,
                    category: (inst?.category ?? 'forex') as AssetCategory,
                    otc: inst?.otc ?? asset.endsWith('-OTC'),
                    tf: this.config.tf,
                    price: followerCandles[followerCandles.length - 1]?.close ?? 0,
                    score,
                    direction: dir,
                    confidence,
                    pUp: 0,
                    pDown: 0,
                    regime: 'range',
                    ouZ: 0,
                    ouHalfLife: 0,
                    ouMeanReverting: false,
                    ouTStat: 0,
                    rsi: 0,
                    adx: 0,
                    atrPct: 0,
                    hurst: 0,
                    changePct: 0,
                    payout: this.payoutFor(asset, 'binary'),
                    topPattern: null,
                    ts: this.now(),
                    computedTs: this.now(),
                    // why NOW: the spread just crossed its entry z-threshold,
                    // backed by a significant (r2/t-stat-gated) hedge-ratio fit
                    note: `spread z ${fit.z.toFixed(2)} crossed ±${zEntry.toFixed(2)} vs ${group.leader} (β ${fit.beta.toFixed(3)}, R² ${fit.r2.toFixed(2)}, HL ${fit.halfLifeBars.toFixed(0)}b) → ${dir.toUpperCase()}`,
                  },
                })
              }
            } catch {
              // thin history/candle fetch failed for this follower - try the next
            }
          }
        }
      } catch {
        // market not loaded - no signal source
      }
      // pick the strongest fresh qualifier this sweep (|z| desc), same
      // ranking scanCointegration/CointegrationPanel use - not just the
      // first one hit while walking the leader/follower roster.
      if (!fresh.length) return null
      fresh.sort((a, b) => b.metric - a.metric)
      return fresh[0].row
    })
  }

  /**
   * Triangulation source: FX triangular arbitrage. Walks every closed
   * triangle among the currently-open forex tickers (analytics/
   * triangulation.ts's findTriangles), fetches the two non-cross legs plus
   * the cross pair itself, and fades the gap between the cross's actual
   * price and its synthetic value (the product of the other two legs,
   * oriented into the cross's own units) when that basis is unusually
   * stretched against its own recent history - the same gates the
   * triangulation-arb strategy applies, swept market-wide. Picks the single
   * BEST fresh qualifier this sweep, ranked the same way TriangulationPanel/
   * scanTriangulation ranks its rows (|z| desc) - not just the first
   * triangle hit while walking the roster.
   */
  private pickTriangulationSignal(): ScreenRow | null {
    return this.edgeSweep('triangulation', (rec) => {
      const fresh: Array<{ row: ScreenRow; metric: number }> = []
      try {
        const market = this.ctx.use<MarketDataService>('market')
        const open = market.assets.filter((a) => a.open).map((a) => a.ticker)
        const pool = this.candidatePool(open)
        const forexTickers = market.assets.filter((a) => a.category === 'forex').map((a) => a.ticker)
        const triangles: TriangleCandidate[] = findTriangles(forexTickers)
        const candleCache = new Map<string, Candle[] | null>()
        const fetchCandles = (ticker: string): Candle[] | null => {
          let c = candleCache.get(ticker)
          if (c === undefined) {
            try {
              c = market.getCandles(ticker, this.config.tf, TRIANGULATION_WINDOW + 20, true)
            } catch {
              c = null
            }
            candleCache.set(ticker, c)
          }
          return c
        }
        for (const tri of triangles) {
          const asset = tri.cross.ticker
          if (!pool.includes(asset) || !open.includes(asset)) continue
          if (this.assetBlocked(asset)) continue
          if (!open.includes(tri.legAB.ticker) || !open.includes(tri.legBC.ticker)) continue
          try {
            const abCandles = fetchCandles(tri.legAB.ticker)
            const bcCandles = fetchCandles(tri.legBC.ticker)
            const acCandles = fetchCandles(asset)
            rec(asset)
            if (!abCandles || !bcCandles || !acCandles) continue
            if (abCandles.length < TRIANGULATION_WINDOW || bcCandles.length < TRIANGULATION_WINDOW || acCandles.length < TRIANGULATION_WINDOW) continue
            // fitTriangulation slices the LAST w bars of each series assuming
            // they're already bar-for-bar index-aligned from the end - three
            // independently-fetched series can differ in length (gaps/thin
            // history on one leg), which would silently misalign bars across
            // legs. Require equal length first - same guard
            // AnalyticsService.auxByStrategyMap uses before trusting these
            // legs for the triangulation-arb STRATEGY's own live/backtest path.
            if (abCandles.length !== bcCandles.length || bcCandles.length !== acCandles.length) continue
            // fitTriangulationFromCandles reads tri.legAB.invert/legBC.invert/
            // cross.invert itself - pass the raw (unoriented) leg candles.
            const fit = fitTriangulationFromCandles(abCandles, bcCandles, acCandles, tri, TRIANGULATION_WINDOW)
            if (!fit) continue
            const zEntry = this.config.triangulationZEntry
            if (Math.abs(fit.z) < zEntry) continue // synthetic and actual agree right now
            const dir: 'call' | 'put' = fit.z >= zEntry ? 'put' : 'call' // actual rich -> fade (put); actual cheap -> call
            if (this.config.direction !== 'both' && dir !== this.config.direction) continue
            const score = Math.round(clamp(45 + (Math.abs(fit.z) - zEntry) * 20, 40, 90)) * (dir === 'call' ? 1 : -1)
            const confidence = Math.round(clamp(40 + (Math.abs(fit.z) - zEntry) * 14, 35, 95))
            if (!finGte(Math.abs(score), this.config.minScore)) continue
            if (!finGte(confidence, this.config.minConfidence)) continue
            const key = SweepEdgeMemory.key(asset, dir)
            rec(asset, key)
            if (this.sweepEdge.gate(key) === 'trade') {
              const inst = market.assets.find((a) => a.ticker === asset)
              fresh.push({
                metric: Math.abs(fit.z),
                row: {
                  asset,
                  name: inst?.name ?? asset,
                  category: 'forex' as AssetCategory,
                  otc: inst?.otc ?? asset.endsWith('-OTC'),
                  tf: this.config.tf,
                  price: acCandles[acCandles.length - 1]?.close ?? 0,
                  score,
                  direction: dir,
                  confidence,
                  pUp: 0,
                  pDown: 0,
                  regime: 'range',
                  ouZ: 0,
                  ouHalfLife: 0,
                  ouMeanReverting: false,
                  ouTStat: 0,
                  rsi: 0,
                  adx: 0,
                  atrPct: 0,
                  hurst: 0,
                  changePct: 0,
                  payout: this.payoutFor(asset, 'binary'),
                  topPattern: null,
                  ts: this.now(),
                  computedTs: this.now(),
                  // why NOW: the basis just crossed its entry z-threshold -
                  // actual vs synthetic diverged enough to fade
                  note: `basis Δ ${fit.deltaPct.toFixed(4)}% (z ${fit.z.toFixed(2)}) crossed ±${zEntry.toFixed(2)} via ${tri.legAB.ticker}×${tri.legBC.ticker} → ${dir === 'put' ? 'rich, fade' : 'cheap, buy'}`,
                },
              })
            }
          } catch {
            // thin history/candle fetch failed for this triangle - try the next
          }
        }
      } catch {
        // market not loaded - no signal source
      }
      // pick the strongest fresh qualifier this sweep (|z| desc), same
      // ranking scanTriangulation/TriangulationPanel use.
      if (!fresh.length) return null
      fresh.sort((a, b) => b.metric - a.metric)
      return fresh[0].row
    })
  }

  /**
   * ADX/DI + Pattern Bias source: single-asset scan (no leader/leg needed) -
   * combines ADX/+DI/-DI trend strength+direction with recent candlestick
   * pattern bias into one agreement-gated composite (analytics/
   * adxpatternbias.ts), market-wide, same gates the adx-pattern-bias
   * strategy applies per pair. Picks the single BEST fresh qualifier this
   * sweep, ranked the same way AdxPatternBiasPanel/scanAdxPatternBias ranks
   * its rows (|composite| desc) - not just the first liquid pair hit.
   */
  private pickAdxPatternBiasSignal(): ScreenRow | null {
    return this.edgeSweep('adx-pattern-bias', (rec) => {
      const fresh: Array<{ row: ScreenRow; metric: number }> = []
      try {
        const market = this.ctx.use<MarketDataService>('market')
        const open = market.assets.filter((a) => a.open).map((a) => a.ticker)
        const pool = this.candidatePool(open)
        const candidates = [...LIQUID_CANDIDATES.filter((a) => pool.includes(a)), ...pool.filter((a) => !LIQUID_CANDIDATES.includes(a))]
        for (const asset of candidates) {
          if (this.assetBlocked(asset)) continue
          try {
            const candles = market.getCandles(asset, this.config.tf, 200, true)
            rec(asset)
            if (candles.length < 60) continue
            const fit = fitAdxPatternBias(candles, 14, PATTERN_BIAS_LOOKBACK)
            if (!fit || !fit.qualifies) continue
            const dir: 'call' | 'put' | 'none' = fit.direction === 'bullish' ? 'call' : fit.direction === 'bearish' ? 'put' : 'none'
            if (dir === 'none') continue
            if (this.config.direction !== 'both' && dir !== this.config.direction) continue
            const score = Math.round(clamp(40 + (Math.abs(fit.composite) - COMPOSITE_QUALIFY) * 10, 40, 95)) * (dir === 'call' ? 1 : -1)
            const confidence = Math.round(clamp(40 + (fit.adx - ADX_TREND_THRESHOLD) * 0.8 + (Math.abs(fit.composite) - COMPOSITE_QUALIFY) * 6, 35, 95))
            if (!finGte(Math.abs(score), this.config.minScore)) continue
            if (!finGte(confidence, this.config.minConfidence)) continue
            const key = SweepEdgeMemory.key(asset, dir)
            rec(asset, key)
            if (this.sweepEdge.gate(key) === 'trade') {
              const inst = market.assets.find((a) => a.ticker === asset)
              fresh.push({
                metric: Math.abs(fit.composite),
                row: {
                  asset,
                  name: inst?.name ?? asset,
                  category: (inst?.category ?? 'forex') as AssetCategory,
                  otc: inst?.otc ?? asset.endsWith('-OTC'),
                  tf: this.config.tf,
                  price: candles[candles.length - 1]?.close ?? 0,
                  score,
                  direction: dir,
                  confidence,
                  pUp: 0,
                  pDown: 0,
                  regime: 'range',
                  ouZ: 0,
                  ouHalfLife: 0,
                  ouMeanReverting: false,
                  ouTStat: 0,
                  rsi: 0,
                  adx: fit.adx,
                  atrPct: 0,
                  hurst: 0,
                  changePct: 0,
                  payout: this.payoutFor(asset, 'binary'),
                  // fit.topPattern is a bare pattern-name string here, not the
                  // {name, direction, reliability} ScreenRow.topPattern shape -
                  // the full pattern object isn't surfaced by this source.
                  topPattern: null,
                  ts: this.now(),
                  computedTs: this.now(),
                  // why NOW: ADX/DI direction and pattern bias just agreed and
                  // crossed the composite qualify bar together
                  note: `ADX ${fit.adx.toFixed(0)} (${fit.adxDirection}) agrees with pattern bias ${fit.patternBias.toFixed(1)}${fit.topPattern ? ` (${fit.topPattern})` : ''} - composite ${fit.composite.toFixed(1)} crossed ±${COMPOSITE_QUALIFY}`,
                },
              })
            }
          } catch {
            // thin history for this pair - try the next
          }
        }
      } catch {
        // market not loaded - no signal source
      }
      // pick the strongest fresh qualifier this sweep (|composite| desc),
      // same ranking scanAdxPatternBias/AdxPatternBiasPanel use.
      if (!fresh.length) return null
      fresh.sort((a, b) => b.metric - a.metric)
      return fresh[0].row
    })
  }

  /**
   * Shock + Pressure source (analytics/shockpressure.ts): same shape as
   * pickAdxPatternBiasSignal above - sweeps the full candidate universe,
   * same gates the shock-pressure strategy applies per pair. Picks the
   * single BEST fresh qualifier this sweep, ranked by |composite| desc -
   * same ranking the shock-pressure strategy itself qualifies on.
   */
  private pickShockPressureSignal(): ScreenRow | null {
    return this.edgeSweep('shock-pressure', (rec) => {
      const fresh: Array<{ row: ScreenRow; metric: number }> = []
      try {
        const market = this.ctx.use<MarketDataService>('market')
        const open = market.assets.filter((a) => a.open).map((a) => a.ticker)
        const pool = this.candidatePool(open)
        const candidates = [...LIQUID_CANDIDATES.filter((a) => pool.includes(a)), ...pool.filter((a) => !LIQUID_CANDIDATES.includes(a))]
        for (const asset of candidates) {
          if (this.assetBlocked(asset)) continue
          try {
            const candles = market.getCandles(asset, this.config.tf, 200, true)
            rec(asset)
            if (candles.length < 60) continue
            const fit = fitShockPressure(candles, 14, PRESSURE_LOOKBACK)
            if (!fit || !fit.qualifies) continue
            const dir: 'call' | 'put' | 'none' = fit.direction === 'bullish' ? 'call' : fit.direction === 'bearish' ? 'put' : 'none'
            if (dir === 'none') continue
            if (this.config.direction !== 'both' && dir !== this.config.direction) continue
            const score = Math.round(clamp(40 + (Math.abs(fit.composite) - SHOCKPRESSURE_COMPOSITE_QUALIFY) * 10, 40, 95)) * (dir === 'call' ? 1 : -1)
            const confidence = Math.round(clamp(40 + (Math.abs(fit.shockRatio) - SHOCK_RATIO_THRESHOLD) * 8 + (Math.abs(fit.composite) - SHOCKPRESSURE_COMPOSITE_QUALIFY) * 6, 35, 95))
            if (!finGte(Math.abs(score), this.config.minScore)) continue
            if (!finGte(confidence, this.config.minConfidence)) continue
            const key = SweepEdgeMemory.key(asset, dir)
            rec(asset, key)
            if (this.sweepEdge.gate(key) === 'trade') {
              const inst = market.assets.find((a) => a.ticker === asset)
              fresh.push({
                metric: Math.abs(fit.composite),
                row: {
                  asset,
                  name: inst?.name ?? asset,
                  category: (inst?.category ?? 'forex') as AssetCategory,
                  otc: inst?.otc ?? asset.endsWith('-OTC'),
                  tf: this.config.tf,
                  price: candles[candles.length - 1]?.close ?? 0,
                  score,
                  direction: dir,
                  confidence,
                  pUp: 0,
                  pDown: 0,
                  regime: 'range',
                  ouZ: 0,
                  ouHalfLife: 0,
                  ouMeanReverting: false,
                  ouTStat: 0,
                  rsi: 0,
                  adx: 0,
                  atrPct: 0,
                  hurst: 0,
                  changePct: 0,
                  payout: this.payoutFor(asset, 'binary'),
                  topPattern: null,
                  ts: this.now(),
                  computedTs: this.now(),
                  // why NOW: a shock just printed and the pressure that was
                  // already building agrees with its direction
                  note: `shock ratio ${fit.shockRatio.toFixed(2)} (${fit.shockDirection}) agrees with pressure ${fit.pressureRatio >= 0 ? '+' : ''}${(fit.pressureRatio * 100).toFixed(0)}% - composite ${fit.composite.toFixed(1)} crossed ±${SHOCKPRESSURE_COMPOSITE_QUALIFY}`,
                },
              })
            }
          } catch {
            // thin history for this pair - try the next
          }
        }
      } catch {
        // market not loaded - no signal source
      }
      // pick the strongest fresh qualifier this sweep (|composite| desc).
      if (!fresh.length) return null
      fresh.sort((a, b) => b.metric - a.metric)
      return fresh[0].row
    })
  }

  /**
   * Chart-signals source: the chart-type scanner's own vote engine
   * (plugins/chartsignals.ts - renko/P&F/range/tick/footprint|otcfootprint/
   * heikin/candle votes combined by analytics/chartsignals.ts combineVotes
   * into one signed score+direction). Same optional-plugin-access pattern as
   * otcGuard/execution elsewhere in this file: chartSignals is read via
   * ctx.use wrapped in try/catch, so a kernel without the plugin loaded just
   * yields no signal, never a crash. Uses peek() (a synchronous cache read,
   * since pickSignal() runs once per tick with no await) rather than scan()
   * - the scanner already proactively rescans on bar close for any kind:tf
   * combo a consumer has recently asked for, so peek() warms its own cache
   * within one or two ticks and the picker never blocks on it. Picks the
   * single BEST fresh qualifier this sweep, ranked the same way
   * ChartSignalsPanel's default sort does (strength desc, then agree-count
   * desc) - not just the first liquid pair hit.
   */
  private pickChartSignalsSignal(): ScreenRow | null {
    return this.edgeSweep('chartsignals', (rec) => {
      const fresh: Array<{ row: ScreenRow; strength: number; agree: number }> = []
      try {
        const chartSignals = this.ctx.use<ChartSignalsService>('chartSignals')
        const market = this.ctx.use<MarketDataService>('market')
        const open = market.assets.filter((a) => a.open).map((a) => a.ticker)
        const pool = this.candidatePool(open)
        const scan: ChartScanResult | null = chartSignals.peek('option', this.config.tf)
        if (!scan) return null // cache cold - a background scan just started, try again next tick
        const byAsset = new Map(scan.signals.map((s) => [s.asset, s]))
        const candidates = [...LIQUID_CANDIDATES.filter((a) => pool.includes(a)), ...pool.filter((a) => !LIQUID_CANDIDATES.includes(a))]
        for (const asset of candidates) {
          if (this.assetBlocked(asset)) continue
          const s = byAsset.get(asset)
          if (!s) continue // no qualifying vote for this asset this scan
          rec(asset)
          // correlated-vote safety margin (see CHARTSIGNALS_MIN_AGREE) - above
          // and beyond combineVotes' own minAgree floor every s already cleared
          if (!finGte(s.agree, CHARTSIGNALS_MIN_AGREE)) continue
          if (this.config.direction !== 'both' && s.direction !== this.config.direction) continue
          const score = Math.round(clamp(s.strength, 0, 100)) * (s.direction === 'call' ? 1 : -1)
          const confidence = Math.round(clamp(40 + s.strength * 0.5 + (s.agree - CHARTSIGNALS_MIN_AGREE) * 6, 35, 95))
          // fail-closed gates: a NaN score/confidence must never qualify
          if (!finGte(Math.abs(score), this.config.minScore)) continue
          if (!finGte(confidence, this.config.minConfidence)) continue
          const key = SweepEdgeMemory.key(asset, s.direction)
          rec(asset, key)
          if (this.sweepEdge.gate(key) === 'trade')
            fresh.push({
              strength: s.strength,
              agree: s.agree,
              row: {
                asset,
                name: s.name,
                category: s.category as AssetCategory,
                otc: s.otc,
                tf: this.config.tf,
                price: s.price,
                score,
                direction: s.direction,
                confidence,
                pUp: 0,
                pDown: 0,
                regime: 'range',
                ouZ: 0,
                ouHalfLife: 0,
                ouMeanReverting: false,
                ouTStat: 0,
                rsi: 0,
                adx: 0,
                atrPct: 0,
                hurst: 0,
                changePct: 0,
                payout: this.payoutFor(asset, 'binary'),
                topPattern: null,
                ts: s.ts,
                computedTs: s.ts,
                // why NOW: the vote engine's agreement just crossed this
                // source's safety-margin bar for this candidate
                note: `${s.agree}/${s.total} independent chart methodologies agree (${s.direction.toUpperCase()}), strength ${s.strength.toFixed(0)}`,
              },
            })
        }
      } catch {
        // chartSignals/market not loaded - no signal source
      }
      // pick the strongest fresh qualifier this sweep: strength desc, then
      // agree-count desc - the exact tie-break ChartSignalsPanel's own
      // default sort uses.
      if (!fresh.length) return null
      fresh.sort((a, b) => b.strength - a.strength || b.agree - a.agree)
      return fresh[0].row
    })
  }

  /**
   * Lead-lag source: intermarket analysis, not technical analysis on the
   * follower itself. Walks every leader group in LEADLAG_GROUPS (EURUSD ->
   * major crosses, XAUUSD -> other metals, BTCUSD -> alts, USCrude/UKBrent
   * -> CAD pairs); for each group's followers, fits a rolling cross-
   * correlation between the LEADER's returns and the follower's returns
   * across lags 0..10 bars (analytics/leadlag.ts fitLeadLag), picks
   * whichever lag correlates strongest, and - only when that fit is strong
   * enough (LEADLAG_MIN_ABS_CORRELATION) AND the leader's own move at that
   * lag offset back was itself unusual (LEADLAG_MIN_TRIGGER_Z) - projects
   * the same (or, for a negative fit, opposite) direction onto the
   * follower right now. A weak or merely-average leader wiggle never fires
   * a signal here, by design: the whole premise is "a shock in the group's
   * liquidity/macro leader ripples outward", not "these two series are
   * generally correlated". Groups are tried in LEADLAG_GROUPS order, and
   * within a group followers are tried in listed order - the first
   * candidate whose fit clears every gate AND whose sweep-edge key is a
   * fresh edge is collected; a leader with no tradeable feed right now, or
   * one whose fit never clears, simply contributes nothing. Among every
   * fresh qualifier found this sweep, picks the single BEST one by |corr|
   * desc - the same ranking leadlagscan.ts/LeadLagPanel use - not just
   * whichever group/follower happened to be walked first.
   */
  private pickLeadLagSignal(): ScreenRow | null {
    return this.edgeSweep('leadlag', (rec) => {
      const fresh: Array<{ row: ScreenRow; metric: number }> = []
      try {
        const market = this.ctx.use<MarketDataService>('market')
        const open = market.assets.filter((a) => a.open).map((a) => a.ticker)
        const pool = this.candidatePool(open)
        const leaderCloseCache = new Map<string, number[] | null>()
        for (const group of LEADLAG_GROUPS) {
          if (!open.includes(group.leader)) continue // leader itself not tradeable right now - nothing to lead with
          let leaderCloses = leaderCloseCache.get(group.leader)
          if (leaderCloses === undefined) {
            try {
              const leaderCandles = market.getCandles(group.leader, this.config.tf, LEADLAG_LOOKBACK_BARS, true)
              leaderCloses = leaderCandles.length >= 30 ? leaderCandles.map((c) => c.close) : null
            } catch {
              leaderCloses = null
            }
            leaderCloseCache.set(group.leader, leaderCloses)
          }
          if (!leaderCloses) continue // too little leader history to fit any lag honestly
          const candidates = group.followers.filter((a) => pool.includes(a) && a !== group.leader)
          for (const asset of candidates) {
            if (this.assetBlocked(asset)) continue
            try {
              const followerCandles = market.getCandles(asset, this.config.tf, LEADLAG_LOOKBACK_BARS, true)
              rec(asset)
              if (followerCandles.length < 30) continue // thin history for this follower - try the next
              const followerCloses = followerCandles.map((c) => c.close)
              const fit = fitLeadLag(leaderCloses, followerCloses, 10)
              if (fit.n < 10) continue // not enough overlapping bars at the winning lag to trust it
              if (!finGte(Math.abs(fit.correlation), LEADLAG_MIN_ABS_CORRELATION)) continue
              const signal = projectLeadLagSignal(fit, leaderCloses)
              if (!signal) continue
              if (!finGte(Math.abs(signal.triggerZ), LEADLAG_MIN_TRIGGER_Z)) continue
              const dir = signal.direction
              if (this.config.direction !== 'both' && dir !== this.config.direction) continue
              const corrStrength = clamp(Math.abs(fit.correlation), 0, 1)
              const zStrength = clamp(Math.abs(signal.triggerZ) / 4, 0, 1) // z=4 treated as maxed-out "very unusual"
              const score = Math.round(clamp(corrStrength * 100, 0, 100)) * (dir === 'call' ? 1 : -1)
              const confidence = Math.round(clamp(35 + corrStrength * 35 + zStrength * 25, 35, 95))
              if (!finGte(Math.abs(score), this.config.minScore)) continue
              if (!finGte(confidence, this.config.minConfidence)) continue
              const key = SweepEdgeMemory.key(asset, dir)
              rec(asset, key)
              if (this.sweepEdge.gate(key) === 'trade') {
                const inst = market.assets.find((a) => a.ticker === asset)
                fresh.push({
                  metric: Math.abs(fit.correlation),
                  row: {
                    asset,
                    name: inst?.name ?? asset,
                    category: (inst?.category ?? 'forex') as AssetCategory,
                    otc: inst?.otc ?? asset.endsWith('-OTC'),
                    tf: this.config.tf,
                    price: followerCandles[followerCandles.length - 1]?.close ?? 0,
                    score,
                    direction: dir,
                    confidence,
                    pUp: 0,
                    pDown: 0,
                    regime: 'range',
                    ouZ: 0,
                    ouHalfLife: 0,
                    ouMeanReverting: false,
                    ouTStat: 0,
                    rsi: 0,
                    adx: 0,
                    atrPct: 0,
                    hurst: 0,
                    changePct: 0,
                    payout: this.payoutFor(asset, 'binary'),
                    topPattern: null,
                    ts: this.now(),
                    computedTs: this.now(),
                    // why NOW: the leader's own move (the trigger) was unusual
                    // enough, and the fitted lag/correlation says this
                    // follower should echo it in this direction - both bars
                    // just cleared, together
                    note: `${group.leader} moved ${(signal.triggerReturn * 100).toFixed(2)}% (z ${signal.triggerZ.toFixed(1)}) ${fit.lag} bar${fit.lag === 1 ? '' : 's'} ago · corr ${fit.correlation.toFixed(2)} at lag ${fit.lag} → ${dir.toUpperCase()}`,
                  },
                })
              }
            } catch {
              // thin history/candle fetch failed for this follower - try the next
            }
          }
        }
      } catch {
        // market service not loaded - no signal source
      }
      // pick the strongest fresh qualifier this sweep (|correlation| desc),
      // same ranking leadlagscan.ts/LeadLagPanel use.
      if (!fresh.length) return null
      fresh.sort((a, b) => b.metric - a.metric)
      return fresh[0].row
    })
  }

  /** Sanitizes a strategyParams patch/restore blob: {id: {key: number|string}},
   * dropping anything that doesn't match that shape. Same leniency as a
   * bot's own params - unknown keys are harmless (defaultParams() merge just
   * ignores them), so this only guards against garbage types, not against
   * keys a given strategy doesn't define. */
  private static sanitizeStrategyParams(v: unknown): Record<string, Record<string, number | string>> | undefined {
    if (!v || typeof v !== 'object') return undefined
    const out: Record<string, Record<string, number | string>> = {}
    for (const [id, params] of Object.entries(v as Record<string, unknown>)) {
      if (!params || typeof params !== 'object') continue
      const clean: Record<string, number | string> = {}
      for (const [k, val] of Object.entries(params as Record<string, unknown>)) {
        if (typeof val === 'number' && Number.isFinite(val)) clean[k] = val
        else if (typeof val === 'string' && val.trim()) clean[k] = val.trim()
      }
      if (Object.keys(clean).length) out[id] = clean
    }
    return Object.keys(out).length ? out : undefined
  }

  /** Sanitizes the asset -> strategy-id pin map (pairStrategy) - same
   * "guard against garbage types, not against a bad id" philosophy as
   * sanitizeStrategyParams above. A pinned id that doesn't resolve to a
   * real builtin/custom strategy at USE time is handled in
   * pickStrategySignal (the pair sits out), not here - the id might
   * reference an AI Lab spec that gets re-added later, so this never
   * silently drops an entry just because it doesn't resolve right now. */
  private static sanitizePairStrategy(v: unknown): Record<string, string> | undefined {
    if (!v || typeof v !== 'object') return undefined
    const out: Record<string, string> = {}
    for (const [asset, id] of Object.entries(v as Record<string, unknown>)) {
      // Task 58 (P3): keys are uppercased - "eurusd-OTC" silently matched
      // nothing and the pin was inert while the config alert announced it
      if (typeof asset === 'string' && asset.trim() && typeof id === 'string' && id.trim()) out[asset.trim().toUpperCase()] = id.trim()
    }
    return Object.keys(out).length ? out : undefined
  }

  /** Sanitizes directionStrategy ({call?, put?}) - same "guard the shape,
   * not the id" philosophy as sanitizePairStrategy; an id that doesn't
   * resolve at USE time just means that side never fires (handled in
   * pickStrategySignal), not here. */
  private static sanitizeDirectionStrategy(v: unknown): { call?: string; put?: string } | undefined {
    if (!v || typeof v !== 'object') return undefined
    const o = v as Record<string, unknown>
    const out: { call?: string; put?: string } = {}
    if (typeof o.call === 'string' && o.call.trim()) out.call = o.call.trim()
    if (typeof o.put === 'string' && o.put.trim()) out.put = o.put.trim()
    return out.call || out.put ? out : undefined
  }

  /** The ids this 'strategy' source currently trades - strategyIds when set
   * (one id = single strategy, 2+ = ensemble), falling back to the legacy
   * lone strategyId for configs saved before strategyIds existed. */
  private effectiveStrategyIds(): string[] {
    if (Array.isArray(this.config.strategyIds) && this.config.strategyIds.length) return this.config.strategyIds
    return this.config.strategyId ? [this.config.strategyId] : []
  }

  /**
   * Strategy source: evaluates one or more saved strategies (config.strategyIds)
   * market-wide, on every open candidate - the exact same strategyId/eval/params
   * path an autopilot bot uses (autopilot.ts's tradeForBot): a builtin id runs
   * through AnalyticsService.runStrategy with its own defaultParams merged
   * with any user overrides in config.strategyParams[id], an AI Lab-learned
   * id ("custom:...") runs through StrategyLabService.runStrategy (fixed
   * spec, no params). minScore/minConfidence are NOT applied here at all -
   * neither means anything for "trade exactly this strategy": the strategy's
   * own evaluate() already decided direction, and there is no shared score
   * scale across arbitrary strategies to threshold on. One id = trade it
   * directly. Two+ ids = either an ENSEMBLE (every member votes call/put/
   * none, majority direction wins, a tie votes nothing, minConfidence is
   * reused as the minimum AGREEMENT % the majority must reach) or, with
   * strategyPickMode 'best', an AUTO-LEARN pool (see below).
   */
  /** Hard cap on how many pairs pickStrategySignal evaluates in a single
   * tick. The IQ universe auto-discovers new instruments live (it can and
   * does jump from ~100 to 270+ open pairs the moment a broker adds a batch)
   * and this method, unlike the other signal sources, deliberately does NOT
   * early-return on the first qualifying pair - it scores every candidate so
   * the best one market-wide wins. Multiply an uncapped candidate list by a
   * strategy pool that can itself be dozens deep (autoDiscover's full
   * builtin catalog + every AI Lab spec) and a single 10s tick turns into
   * thousands of synchronous strategy evaluations - long enough to block
   * the event loop past the Docker healthcheck's timeout and reset every
   * other in-flight connection (the proxy's "socket hang up"/ECONNRESET),
   * which is exactly what an unbounded universe growth spike triggered.
   * LIQUID_CANDIDATES always get a slot (they're what most configs actually
   * care about); the remaining budget round-robins through the rest of the
   * pool via strategyTickCursor so every pair still gets evaluated, just
   * spread across multiple ticks instead of all at once. */
  private static MAX_TICK_CANDIDATES = 40
  /** Hard cap on the AI Lab specs autoDiscover folds into the ranking pool,
   * most-recently-updated first - lab.list() grows without bound over time
   * as autoDiscover mines new pairs, and an uncapped pool multiplies the
   * same way an uncapped candidate list does. */
  private static MAX_AUTO_DISCOVER_LAB_SPECS = 60
  private static AUTO_DISCOVER_COOLDOWN_SEC = 6 * 3600 // mirrors lab.ts's own RELEARN_AFTER_SEC
  /** asset -> unix ts of the last auto-discover attempt (success OR
   * failure) - prevents retrying the same thin-history pair every tick
   * while still letting a genuinely new spec get mined once the cooldown
   * clears. */
  private autoDiscoverAttemptedAt = new Map<string, number>()

  /** Mines AT MOST ONE open candidate pair per tick that does not already
   * have a reasonably fresh AI Lab spec, via the lab's own learn() pipeline
   * - the exact same pattern-mining/holdout backtest a human clicking
   * "Discover" in the AI Lab UI would get, just triggered automatically. A
   * successful mine is saved (lab.save) so it immediately joins
   * pickStrategySignal's autoDiscover pool on the very next tick, and the
   * lab's own relearnSweep (lab.ts) takes over keeping it fresh from there -
   * this method only ever needs to get a pair its FIRST spec. One pair per
   * tick because learn() replays the full mining pipeline and is
   * CPU-heavy enough that doing it for several pairs back-to-back would be
   * a real hit on the 10s tick cadence. */
  private maybeAutoDiscover(): void {
    try {
      const market = this.ctx.use<MarketDataService>('market')
      const lab = this.ctx.use<StrategyLabService>('lab')
      const open = market.assets.filter((a) => a.open).map((a) => a.ticker)
      const pool = this.candidatePool(open)
      const existing = lab.list()
      for (const asset of pool) {
        const lastAttempt = this.autoDiscoverAttemptedAt.get(asset) ?? 0
        if (this.now() - lastAttempt < ModeService.AUTO_DISCOVER_COOLDOWN_SEC) continue
        const hasFresh = existing.some((r) => r.asset === asset && r.tf === this.config.tf && this.now() - r.updatedTs < ModeService.AUTO_DISCOVER_COOLDOWN_SEC)
        this.autoDiscoverAttemptedAt.set(asset, this.now())
        if (hasFresh) continue // already has a spec the lab's own relearnSweep keeps current
        try {
          const result = lab.learn({ asset, tf: this.config.tf })
          if (result.ok && result.spec) {
            lab.save({
              spec: result.spec,
              asset,
              tf: this.config.tf,
              stats: { backtest: result.backtest ?? undefined, holdout: result.holdout ?? undefined, breakeven: result.breakevenWinRate },
            })
            this.emit('info', `[AUTO-TRADER] auto-discover: mined a new strategy for ${asset} ${this.config.tf} - added to the auto-learn pool`)
          }
        } catch {
          // thin history or no signal cleared the lab's own filters this time - retry after the cooldown
        }
        break // at most one mining pass per tick
      }
    } catch {
      // market/lab plugin not loaded - auto-discover disabled for this tick
    }
  }

  private pickStrategySignal(): ScreenRow | null {
    try {
      const market = this.ctx.use<MarketDataService>('market')
      const open = market.assets.filter((a) => a.open).map((a) => a.ticker)
      const pool = this.candidatePool(open)
      const allCandidates = [...LIQUID_CANDIDATES.filter((a) => pool.includes(a)), ...pool.filter((a) => !LIQUID_CANDIDATES.includes(a))]
      // Bounded working set: LIQUID_CANDIDATES always get a slot, the rest of
      // the budget round-robins through the remaining pool tick-to-tick (see
      // MAX_TICK_CANDIDATES's comment - this is what keeps a universe spike
      // from turning one tick into thousands of synchronous evaluations).
      const liquidSlice = allCandidates.filter((a) => LIQUID_CANDIDATES.includes(a))
      const rest = allCandidates.filter((a) => !LIQUID_CANDIDATES.includes(a))
      const restBudget = Math.max(0, ModeService.MAX_TICK_CANDIDATES - liquidSlice.length)
      let rotated: string[] = []
      if (rest.length) {
        const start = this.strategyTickCursor % rest.length
        rotated = Array.from({ length: Math.min(restBudget, rest.length) }, (_, i) => rest[(start + i) % rest.length])
        this.strategyTickCursor = (start + rotated.length) % rest.length
      }
      const candidates = [...liquidSlice, ...rotated]
      const analytics = this.ctx.use<AnalyticsService>('analytics')
      const lab = this.ctx.use<StrategyLabService>('lab')
      // autoDiscover: instead of ranking only among manually-picked
      // strategyIds, pull in the ENTIRE builtin catalog plus every
      // non-decayed AI Lab spec that exists so far - the adaptive gate's own
      // per-pair ranking (below) is what actually narrows this down, same
      // as it always has, so widening the pool just gives it more to
      // discover from instead of only dispatching among a hand-picked few.
      // A spec trained on one pair still evaluates fine on another (its
      // signals are generic pattern/indicator thresholds, not asset-
      // calibrated) - it'll just read as unproven there until its OWN
      // record builds up on that pair too, same cold-start treatment any
      // strategy gets on a pair it hasn't traded yet.
      // lab specs are capped (most-recently-updated first) for the same
      // reason the candidate pool is - autoDiscover's own mining grows
      // lab.list() without bound over weeks of uptime.
      const manualIds = this.effectiveStrategyIds()
      const ids =
        this.config.strategyPickMode === 'best' && this.config.autoDiscover === true
          ? Array.from(
              new Set([
                ...manualIds,
                ...STRATEGIES.map((s) => s.id),
                ...lab
                  .list()
                  .filter((r) => !r.stats?.decayed)
                  .sort((a, b) => b.updatedTs - a.updatedTs)
                  .slice(0, ModeService.MAX_AUTO_DISCOVER_LAB_SPECS)
                  .map((r) => r.id),
              ])
            )
          : manualIds
      // pairStrategy: "for THIS pair, always use THIS one strategy" - bypasses
      // the global ids/ensemble/best pool entirely for any asset that has an
      // entry here. Resolved per-asset inside the loop below via the same
      // resolveMemberSpecs() helper the global pool uses, so params/validity
      // checks stay identical either way.
      const pairStrategyMap = this.config.pairStrategy ?? {}
      const hasPairOverrides = Object.keys(pairStrategyMap).length > 0
      // directionStrategy: "for every CALL use THIS strategy, for every PUT
      // use THIS one" - same bypass model as pairStrategy, keyed by side
      // instead of pair (see the field's own doc comment for the full
      // precedence/role rules). Resolved once here, applied per-asset below.
      const dirStrategy = this.config.directionStrategy
      const hasDirOverrides = Boolean(dirStrategy?.call || dirStrategy?.put)
      if (!ids.length && !hasPairOverrides && !hasDirOverrides) return null // nothing picked yet (and autoDiscover/pins/direction pins are all off) - source configured but idle
      const resolveMemberSpecs = (memberIds: string[]) =>
        memberIds
          .map((id) => {
            const isCustom = id.startsWith('custom:')
            const strat = isCustom ? null : getStrategy(id)
            // user-configured overrides (same shape as a bot's own params) merged
            // over that strategy's defaults - never applies to a custom: lab spec,
            // which is a fixed learned structure with no exposed param schema
            const params = strat ? { ...defaultParams(strat), ...(this.config.strategyParams?.[id] ?? {}) } : undefined
            return { id, isCustom, params, valid: isCustom || Boolean(strat) }
          })
          .filter((s) => s.valid)
      const liveSpecs = ids.length ? resolveMemberSpecs(ids) : []
      if (!liveSpecs.length && !hasPairOverrides && !hasDirOverrides) return null // every picked id is unknown/removed AND no pins exist - misconfigured (a direction-only config has hasDirOverrides and must reach the per-asset resolution below)

      let adaptive: AdaptiveService | null = null
      if (liveSpecs.length > 1 && this.config.strategyPickMode === 'best') {
        try {
          adaptive = this.ctx.use<AdaptiveService>('adaptive')
        } catch {
          adaptive = null
        }
      }

      // Evaluate EVERY open/eligible pair this tick and keep every qualifying
      // row across the whole pool - NOT just the first candidate in
      // LIQUID_CANDIDATES order that happens to fire (returning on first
      // match meant whichever major (EURUSD, by list order) qualified most
      // often under a given strategy would win almost every tick, making the
      // auto-trader look pinned to one pair even with a GLOBAL pair
      // restriction - there was never a second pair in the running), and NOT
      // just the single highest-metric one either - pickVariety picks
      // randomly among the top N of this pool below instead of always the
      // strict best, so one pair that happens to out-score the rest for a
      // while doesn't monopolize every trade.
      const signalPool: Array<{ row: ScreenRow; metric: number }> = []

      for (const asset of candidates) {
        if (this.assetBlocked(asset)) continue
        // pinned pair: run ONLY the assigned strategy for this asset, never
        // the global pool - and if the pinned id no longer resolves (e.g.
        // the AI Lab library got wiped), sit this pair out rather than
        // quietly falling back to the pool, which would undo the pin.
        const pinnedId = pairStrategyMap[asset]
        // Precedence: a per-pair pin (pairStrategy) always wins - it's the
        // more specific intent ("regardless of direction, THIS pair always
        // trades THIS one strategy"). Otherwise, if a per-direction pin
        // (directionStrategy) is configured, the pinned side(s) run ONLY
        // their assigned strategy instead of the global pool - while any
        // side left on "pool (default)" keeps using the global pool, exactly
        // what the picker's own description promises (THE BUG this fixes:
        // one pinned side used to bypass the pool for BOTH sides, so the
        // unpinned side silently went dead - a CALL-only pin silently
        // disabled every PUT signal). directionPinned tracks the mode so the
        // votes loop below knows to enforce "a call-slot strategy's vote
        // only counts if it actually said call" (and the put-slot
        // symmetrically), which an ordinary ensemble/pool vote never needs.
        const directionPinned = !pinnedId && hasDirOverrides
        // PARTIAL pins: exactly one side pinned, the other on the pool. The
        // pool members join the evaluation to own the unpinned side.
        const partialDirPins = directionPinned && Boolean(dirStrategy!.call) !== Boolean(dirStrategy!.put)
        const dirIds = directionPinned ? Array.from(new Set([dirStrategy!.call, dirStrategy!.put].filter((x): x is string => Boolean(x)))) : []
        const assetSpecs = pinnedId
          ? resolveMemberSpecs([pinnedId])
          : directionPinned
            ? resolveMemberSpecs(partialDirPins ? Array.from(new Set([...dirIds, ...ids])) : dirIds)
            : liveSpecs
        if (!assetSpecs.length) continue
        const assetOtc = asset.endsWith('-OTC')
        const votes: Array<{ id: string; direction: 'call' | 'put'; score: number }> = []
        let price = 0
        for (const s of assetSpecs) {
          // streak-breaker: a member on a losing run against THIS exact
          // pair sits out, but still lets every other member vote/rank -
          // the bench is per (strategy, pair), never the whole pool
          if (this.config.streakBreaker !== false && this.isBenched(`${s.id}|${asset}`)) continue
          try {
            const ev = s.isCustom
              ? lab.runStrategy(asset, this.config.tf, s.id)
              : analytics.runStrategy(asset, this.config.tf, s.id, s.params)
            if (ev.direction === 'none') continue
            // fresh-edge gate: a vote whose condition has been true since
            // before this bar is the stale middle of a move. Only reads that
            // JUST became true (entered) or flipped get a vote - the same
            // rule the bots' edge-trigger enforces, applied at the source
            // instead of after the pick.
            if (ev.phase === 'held') continue
            if (directionPinned) {
              // a strategy assigned to the CALL slot only ever contributes a
              // call vote (its put/none output is dropped), and symmetrically
              // for PUT - this is what keeps the two sides from ever
              // colliding into an accidental tie below, unlike a real
              // ensemble vote where every member can vote either way.
              const isCallSlot = dirStrategy!.call === s.id
              const isPutSlot = dirStrategy!.put === s.id
              if (isCallSlot && !isPutSlot && ev.direction !== 'call') continue
              if (isPutSlot && !isCallSlot && ev.direction !== 'put') continue
            }
            votes.push({ id: s.id, direction: ev.direction, score: ev.score })
            price = ev.price
          } catch {
            // thin history / bad pair for this member - other members still vote
          }
        }
        if (!votes.length) continue

        if (directionPinned) {
          // Two pin layouts:
          //  - BOTH sides pinned: at most one CALL vote (from the call-slot
          //    strategy) and at most one PUT vote can ever be present, so
          //    there is no tie to break in the ordinary sense - apply the
          //    global direction filter and, in the rare case BOTH fired this
          //    same tick (the two assigned strategies disagree), take
          //    whichever read has the stronger edge.
          //  - ONE side pinned (other on "pool (default)"): the pinned side
          //    fires only from its own strategy; the UNPINNED side falls
          //    back to the global pool read the same way an unpinned config
          //    would read it - a single pool member is that side's own read,
          //    2+ members need a strict majority at the configured min
          //    agreement %. An empty pool means the unpinned side simply
          //    cannot fire - nothing is assigned to it. If both sides
          //    produce a read, the stronger |score| wins.
          const callSlot = dirStrategy!.call
          const putSlot = dirStrategy!.put
          /** Resolve ONE side's read: from its pinned slot when pinned, else
           * from the pool votes (strict-majority ensemble read). */
          const sideRead = (
            side: 'call' | 'put'
          ): { direction: 'call' | 'put'; id: string; score: number; note: string; confidence?: number } | null => {
            const slotId = side === 'call' ? callSlot : putSlot
            if (slotId) {
              // the votes loop already dropped any slot vote that didn't
              // match its side, so a found vote IS the side's own read
              const v = votes.find((x) => x.id === slotId && x.direction === side)
              return v
                ? {
                    direction: side,
                    id: v.id,
                    score: v.score,
                    note: `direction-pinned: ${v.id} (${side.toUpperCase()}) on ${asset} (score ${Math.abs(v.score).toFixed(0)})`,
                  }
                : null
            }
            // unpinned side - pool fallback (unreachable with both sides pinned)
            const poolVotes = votes.filter((v) => !dirIds.includes(v.id))
            if (!poolVotes.length) return null
            const sideVotes = poolVotes.filter((v) => v.direction === side)
            if (!sideVotes.length) return null
            if (poolVotes.length === 1) {
              const v = sideVotes[0]
              return { direction: side, id: v.id, score: v.score, note: `pool fallback: ${v.id} (${side.toUpperCase()}) on ${asset} (score ${Math.abs(v.score).toFixed(0)})` }
            }
            const agree = sideVotes.length > poolVotes.length - sideVotes.length
            if (!agree) return null // pool tied or outvoted on this side
            const agreementPct = Math.round((sideVotes.length / poolVotes.length) * 100)
            if (agreementPct < this.config.minConfidence) return null
            const avg = sideVotes.reduce((a, v) => a + Math.abs(v.score), 0) / sideVotes.length
            const members = sideVotes.map((v) => v.id).join('+')
            return {
              direction: side,
              id: `pool:${members}`,
              score: avg,
              confidence: agreementPct,
              note: `pool fallback: ${members} agree ${side.toUpperCase()} on ${asset} (${agreementPct}% · avg ${avg.toFixed(0)})`,
            }
          }
          const callRead = sideRead('call')
          const putRead = sideRead('put')
          const chosen = callRead && putRead ? (Math.abs(callRead.score) >= Math.abs(putRead.score) ? callRead : putRead) : (callRead ?? putRead)
          if (!chosen) continue
          if (this.config.direction !== 'both' && chosen.direction !== this.config.direction) continue
          signalPool.push({
            metric: Math.abs(chosen.score),
            row: ModeService.strategyEvalToScreenRow(
              asset,
              this.config.tf,
              chosen.direction,
              chosen.score,
              price,
              chosen.note,
              chosen.confidence,
              chosen.id,
              assetOtc
            ),
          })
          continue
        }

        if (assetSpecs.length === 1) {
          // no minScore gate here - the strategy's own evaluate() already
          // decided this is a signal (direction !== 'none'); a second,
          // unrelated 0-100 "edge score" threshold on top of that doesn't
          // mean anything a user picking ONE specific strategy would expect
          const v = votes[0]
          if (this.config.direction !== 'both' && v.direction !== this.config.direction) continue
          const metric = Math.abs(v.score)
          const note = pinnedId
            ? `pinned: ${v.id} on ${asset} (score ${Math.abs(v.score).toFixed(0)})`
            : `${v.id} score ${Math.abs(v.score).toFixed(0)}`
          signalPool.push({ metric, row: ModeService.strategyEvalToScreenRow(asset, this.config.tf, v.direction, v.score, price, note, undefined, v.id, assetOtc) })
          continue
        }

        if (this.config.strategyPickMode === 'best') {
          // auto-learn: rank this tick's firing members by THEIR OWN proven
          // record for THIS exact pair (adaptive.ts's Wilson-lower-bound
          // read, read-only here - never gates, only ranks), not a vote.
          // A member still cold-starting on this pair falls back to raw
          // |score| so it keeps getting picked often enough to build a
          // record; once any member clears the adaptive gate's own sample
          // floor, a proven result always outranks an unproven one.
          let best: { id: string; direction: 'call' | 'put'; score: number; rank: number; proven: boolean } | null = null
          // Regime-aware ranking: execution.ts stamps every settled position
          // with entry_regime via the SAME classifyRegime() call (its own
          // snapshotSignal, independent of signalSource) - so a bucket read
          // that omits regime here would be pooling across what's actually
          // regime-split data, diluting a member that's e.g. excellent in a
          // trend but mediocre in chop into one blended, weaker-looking
          // number. Passing the SAME classification used at write-time is
          // what makes "best per pair" actually "best per pair AND regime".
          // Session-aware too, same reasoning: execution.ts also stamps
          // entry_session (classifySession) on every settled trade
          // regardless of signalSource, so the gate's bucket query is
          // ALREADY split by session - passing it here is what lets "best
          // per pair" actually read that split instead of pooling the whole
          // day's trades together.
          let regime: string | undefined
          let session: string | undefined
          if (adaptive) {
            try {
              regime = classifyRegime(analytics.analyze(asset, this.config.tf))
            } catch {
              regime = undefined
            }
            session = classifySession(this.now(), asset)
          }
          for (const v of votes) {
            let rank = Math.abs(v.score)
            let proven = false
            if (adaptive) {
              const verdict = adaptive.check(asset, this.config.tf, v.id, v.direction, v.score, regime, session)
              if (verdict.trades >= adaptive.config.minSampleSize) {
                rank = verdict.wilsonLowerPct
                proven = true
              }
            }
            if (!best || (proven && !best.proven) || (proven === best.proven && rank > best.rank)) best = { id: v.id, direction: v.direction, score: v.score, rank, proven }
          }
          if (!best) continue
          if (this.config.direction !== 'both' && best.direction !== this.config.direction) continue
          // proven ALWAYS outranks unproven across pairs too, regardless of
          // raw score magnitude - so a +1_000_000 offset keeps the two tiers
          // from ever crossing while still ranking within each tier by rank.
          const metric = best.proven ? 1_000_000 + best.rank : best.rank
          const note = best.proven
            ? `auto-learn: ${best.id} proven best for ${asset} (${best.rank.toFixed(0)}% win rate, 95% floor)`
            : `auto-learn: ${best.id} highest edge for ${asset} (score ${Math.abs(best.score).toFixed(0)}) - still building its own record`
          signalPool.push({
            metric,
            row: ModeService.strategyEvalToScreenRow(asset, this.config.tf, best.direction, best.score, price, note, best.proven ? Math.round(best.rank) : undefined, best.id, assetOtc),
          })
          continue
        }

        // ensemble: majority vote, agreement %, average |score| of the agreeing members
        const calls = votes.filter((v) => v.direction === 'call')
        const puts = votes.filter((v) => v.direction === 'put')
        const majority = calls.length === puts.length ? null : calls.length > puts.length ? calls : puts
        if (!majority) continue // tied vote - no edge either way
        const direction = majority[0].direction
        if (this.config.direction !== 'both' && direction !== this.config.direction) continue
        // Task 58 (P3): the denominator is the LIVE voters (members that
        // actually cast a vote this tick) - benched/errored members used to
        // dilute the agreement % below minConfidence and silently kill a
        // unanimous-alive-vote signal. The note now also reports honestly
        // how many members were counted.
        const agreementPct = Math.round((majority.length / Math.max(1, votes.length)) * 100)
        if (agreementPct < this.config.minConfidence) continue
        const avgScore = majority.reduce((a, v) => a + Math.abs(v.score), 0) / majority.length
        // rank by agreement % first (coarse, *1000 so it dominates), avg
        // |score| as the tiebreak among pairs with equal agreement
        const metric = agreementPct * 1000 + avgScore
        signalPool.push({
          metric,
          row: ModeService.strategyEvalToScreenRow(
            asset,
            this.config.tf,
            direction,
            avgScore,
            price,
            `ensemble ${majority.length}/${votes.length} agree (${majority.map((v) => v.id).join(', ')}) · avg ${avgScore.toFixed(0)}`,
            agreementPct,
            `ensemble:${majority.map((v) => v.id).join('+')}`,
            assetOtc
          ),
        })
      }
      return this.pickRandomFromPool(signalPool, this.config.pickVariety ?? 1)
    } catch {
      // market/analytics/lab not loaded - no signal source
    }
    return null
  }

  /** Adapts a strategy/ensemble eval into the shared ScreenRow shape.
   * `note` carries the strategy-specific explanation shown in place of a
   * generic score/confidence (the member id(s) and what they said), and
   * `confidenceOverride` lets the ensemble path report agreement % instead
   * of the single-strategy default of mirroring |score|. `otc` is the REAL
   * feed flag (THE BUG: this used to hardcode false, so every strategy-
   * sourced signal on a -OTC pair claimed a real feed and silently bypassed
   * the OTC placebo defense - the one gate that exists precisely because TA
   * doesn't work on the generator). Screener-specific scalars are inert
   * placeholders, as with confluenceToScreenRow above. */
  private static strategyEvalToScreenRow(
    asset: string,
    tf: Timeframe,
    direction: 'call' | 'put' | 'none',
    score: number,
    price: number,
    note?: string,
    confidenceOverride?: number,
    strategyLabel?: string,
    otc?: boolean
  ): ScreenRow {
    return {
      asset,
      name: asset,
      category: 'forex',
      otc: otc ?? false,
      tf,
      price,
      score,
      direction,
      confidence: Math.round(clamp(confidenceOverride ?? Math.abs(score), 0, 100)),
      pUp: 0,
      pDown: 0,
      regime: 'range',
      ouZ: 0,
      ouHalfLife: 0,
      ouMeanReverting: false,
      ouTStat: 0,
      rsi: 0,
      adx: 0,
      atrPct: 0,
      hurst: 0,
      changePct: 0,
      payout: 0,
      topPattern: null,
      note,
      strategyLabel,
      ts: Math.floor(Date.now() / 1000),
      computedTs: Math.floor(Date.now() / 1000),
    }
  }

  // ---------- kalman-ou walk-forward validation gate ----------

  static readonly OU_VALIDATION_TTL = 3600 // refresh verdicts hourly

  private ouVerdicts = new Map<string, { ts: number; validating: boolean; verdict: OUVerdict }>()
  private validatingAsset: string | null = null

  private ouKey(asset: string): string {
    return `${asset}|${this.config.tf}`
  }

  /** Fresh (non-expired) walk-forward verdict for the asset, if any. */
  private ouVerdict(asset: string): OUVerdict | null {
    const e = this.ouVerdicts.get(this.ouKey(asset))
    if (!e) return null
    if (this.now() - e.ts > ModeService.OU_VALIDATION_TTL) return null
    return e.verdict
  }

  /**
   * Lazy background validation - at most one runs at a time so the 10s
   * auto-trader tick never piles up heavy walk-forward work. The result is
   * announced on the alert bus so operators see why a pair started/stopped
   * being tradeable in no-human mode.
   */
  private ensureOUValidation(asset: string): void {
    const key = this.ouKey(asset)
    const entry = this.ouVerdicts.get(key)
    if (entry?.validating) return
    if (this.validatingAsset && this.validatingAsset !== key) return
    this.validatingAsset = key
    this.ouVerdicts.set(key, { ts: entry?.ts ?? 0, validating: true, verdict: entry?.verdict ?? ModeService.emptyVerdict(asset) })
    void this.validateOU(asset, this.config.tf)
      .then((v) => {
        this.ouVerdicts.set(key, { ts: this.now(), validating: false, verdict: v })
        this.emit(
          v.verdict === 'robust' ? 'info' : 'warn',
          `[AUTO-TRADER] OU walk-forward ${asset} ${this.config.tf}: ${v.verdict.toUpperCase()} - OOS ${v.oosNet >= 0 ? '+' : ''}$${v.oosNet.toFixed(2)} · ${v.winRate.toFixed(0)}% wr · ${v.foldsProfitable}/${v.folds} folds profitable · efficiency ${v.efficiencyPct.toFixed(0)}%`
        )
      })
      .catch(() => {
        this.ouVerdicts.delete(key)
      })
      .finally(() => {
        if (this.validatingAsset === key) this.validatingAsset = null
      })
  }

  static emptyVerdict(asset: string): OUVerdict {
    return { asset, tf: '1m', verdict: 'failed', oosNet: 0, isNet: 0, winRate: 0, efficiencyPct: 0, foldsProfitable: 0, folds: 0, totalTrades: 0, bestParams: {}, elapsedMs: 0, ts: 0 }
  }

  /**
   * Walk-forward validation of the OU edge on one (asset, tf): grid over the
   * tradeable OU params per fold, settle the fold winner out-of-sample with
   * the real binary settlement engine, then grade the aggregate. Robust =
   * OOS net positive, at least 2/3 folds profitable and >= 25% IS->OOS
   * efficiency; weak = profitable but not convincing; failed = anything else.
   */
  async validateOU(asset: string, tf: Timeframe): Promise<OUVerdict> {
    const market = this.ctx.use<MarketDataService>('market')
    // Task 59 (P1): closedOnly - validation must match the backtest engine's input.
    const candles = market.getCandlesDeep(asset, tf, 2200, true)
    if (candles.length < 700) throw new Error(`not enough history for ${asset} ${tf} (${candles.length} bars)`)
    const result = walkForward(candles, asset, tf, {
      strategy: 'kalman-ou-reversion',
      sweep: {
        window: { from: 180, to: 300, step: 60 },
        zEntry: { from: 1.4, to: 2.4, step: 0.2 },
        maxHalfLife: { from: 30, to: 120, step: 30 },
      },
      objective: 'netPnl',
      minTrades: 5,
      maxCombos: 80,
      folds: 3,
      isRatio: 0.7,
      payout: 0.85,
      amount: 10,
      expiryBars: 1,
    })
    const oos = result.oos
    const verdict: OUVerdict['verdict'] =
      oos.netPnl > 0 && result.foldsProfitable >= 2 && result.efficiencyPct >= 25 && oos.totalTrades >= 10
        ? 'robust'
        : oos.netPnl > 0 && result.foldsProfitable >= 1
          ? 'weak'
          : 'failed'
    return {
      asset,
      tf,
      verdict,
      oosNet: Math.round(oos.netPnl * 100) / 100,
      isNet: Math.round(result.isNet * 100) / 100,
      winRate: Math.round(oos.winRate * 10) / 10,
      efficiencyPct: Math.round(result.efficiencyPct * 10) / 10,
      foldsProfitable: result.foldsProfitable,
      folds: result.folds.length,
      totalTrades: oos.totalTrades,
      bestParams: result.bestParams,
      elapsedMs: result.elapsedMs,
      ts: this.now(),
    }
  }

  private async place(row: ScreenRow, side: 'call' | 'put', amount: number): Promise<{ ok: boolean; error?: string }> {
    try {
      const exec = this.ctx.use<{
        accountSource: 'paper' | 'iq'
        placeOrder(req: {
          asset: string
          tf: Timeframe
          side: 'call' | 'put'
          kind: 'binary'
          amount: number
          expiryBars: number
          mode: 'paper' | 'live'
          strategy: string
          note: string
        }): Promise<{ ok: boolean; error?: string }>
      }>('execution')
      return await exec.placeOrder({
        asset: row.asset,
        tf: this.config.tf,
        side,
        kind: 'binary',
        amount,
        // expiryTf unset = the old behavior (expiry tracks the signal tf
        // 1:1, i.e. exactly 1 bar). Set = however many `tf` bars it takes to
        // cover that expiry timeframe (min 1) - e.g. signals on '1m' with
        // expiryTf '5m' settles 5 bars later, not 1.
        expiryBars: this.config.expiryTf ? Math.max(1, Math.round(TIMEFRAME_SECONDS[this.config.expiryTf] / TIMEFRAME_SECONDS[this.config.tf])) : 1,
        // THE SAME BUG that was in autopilot.ts: this was hardcoded 'paper'
        // unconditionally, so the built-in AUTO-mode auto-trader could never
        // place a real order no matter what the account was connected to.
        // account source is the single routing truth (same as /trade and
        // autopilot.ts's bot execution path).
        mode: exec.accountSource === 'iq' ? 'live' : 'paper',
        strategy:
          this.config.signalSource === 'cointegration'
            ? 'cointegration-pairs'
            : this.config.signalSource === 'triangulation'
              ? 'triangulation-arb'
              : this.config.signalSource === 'adx-pattern-bias'
                ? 'adx-pattern-bias'
                : this.config.signalSource === 'shock-pressure'
                  ? 'shock-pressure'
                  : this.config.signalSource === 'chartsignals'
                  ? 'chartsignals-vote'
                  : this.config.signalSource === 'leadlag'
                    ? 'leadlag-echo'
                    : this.config.signalSource === 'strategy'
                    ? (row.strategyLabel ??
                      (() => {
                        const ids = this.effectiveStrategyIds()
                        return ids.length > 1 ? `ensemble:${ids.join('+')}` : ids[0] ?? 'custom-strategy'
                      })())
                    : 'auto-trader',
        note: AUTOTRADER_NOTE,
      })
    } catch {
      return { ok: false, error: 'execution service unavailable' }
    }
  }

  private standDown(reason: string): void {
    if (this.rt.lastRejection === reason) return
    this.rt.lastRejection = reason
    this.emit('info', `[AUTO-TRADER] standing down: ${reason}`)
  }

  private hasOpenAutoOn(asset: string): boolean {
    try {
      const store = this.ctx.use<Store>('store')
      return store
        .listPositions('open', 500)
        .some((p) => p.note?.startsWith('auto:') && p.asset === asset)
    } catch {
      return false
    }
  }

  /** The candidate universe after applying watchlist/watchlistMode up front -
   * 'only' (default) intersects with the watchlist, 'exclude' removes it.
   * Same semantics assetBlocked enforces per-asset below, applied once so a
   * candidate loop isn't wasting cycles on assets it can never trade. */
  private candidatePool(open: string[]): string[] {
    if (!this.config.watchlist.length) return open
    const exclude = this.config.watchlistMode === 'exclude'
    return exclude ? open.filter((a) => !this.config.watchlist.includes(a)) : open.filter((a) => this.config.watchlist.includes(a))
  }

  /** The strategy label a non-'strategy' source always trades under - fixed
   * per signalSource, exactly what place() tags the resulting position with
   * (see its `strategy:` switch below). Used to look up the streak-breaker
   * bench for sources where the label doesn't depend on which candidate is
   * picked. Returns null for 'strategy' (its label varies per member/pair -
   * handled per-member inside pickStrategySignal instead). */
  private fixedStrategyLabel(): string | null {
    switch (this.config.signalSource) {
      case 'cointegration':
        return 'cointegration-pairs'
      case 'triangulation':
        return 'triangulation-arb'
      case 'adx-pattern-bias':
        return 'adx-pattern-bias'
      case 'shock-pressure':
        return 'shock-pressure'
      case 'chartsignals':
        return 'chartsignals-vote'
      case 'leadlag':
        return 'leadlag-echo'
      default:
        return null
    }
  }

  /** Task 58 (P2): the strategy keys whose placebo verdicts gate OTC
   * auto-trading for ONE asset - mirrors pickStrategySignal's own resolution
   * order (per-pair pin > direction pins (+pool for the unpinned side) >
   * configured pool > fixed source). Every key returned must hold a fresh
   * passing verdict under policy 'enforce'. */
  private otcStrategyKeysFor(asset: string): string[] {
    const pinned = this.config.pairStrategy?.[asset]
    if (pinned) return [pinned]
    const dir = this.config.directionStrategy
    const dirIds = dir ? Array.from(new Set([dir.call, dir.put].filter((x): x is string => Boolean(x)))) : []
    const ids = (this.config.strategyIds ?? []).filter((x) => typeof x === 'string' && x.trim())
    if (dirIds.length) return Array.from(new Set([...dirIds, ...ids]))
    if (ids.length) return ids
    // fixed (non-'strategy') sources: the OTC guard mints verdicts under the
    // real STRATEGY id (fixedStrategyLabel - e.g. 'cointegration-pairs', not
    // the raw signalSource literal 'cointegration'), same id place()'s own
    // strategy: switch tags the order with - using the raw signalSource here
    // would look up a key /otc_defense_run never writes a verdict under,
    // silently failing OTC-enforce for every fixed source.
    return [this.fixedStrategyLabel() ?? String(this.config.signalSource)]
  }

  private isBenched(key: string): boolean {
    return this.now() < (this.benchedUntil.get(key) ?? 0)
  }

  /** Live binary payout for one ticker as a 0-1 fraction, 0 when the market
   * service can't answer (never invent a number - 0 reads as "unknown" to
   * every gate that consults this, which is the permissive contract). */
  private payoutFor(asset: string, kind: 'binary' | 'turbo' | 'digital' | 'cfd'): number {
    try {
      const pay = this.ctx.use<MarketDataService>('market').payoutFor(asset, kind)
      return typeof pay === 'number' && Number.isFinite(pay) && pay > 0 ? pay : 0
    } catch {
      return 0
    }
  }

  /** 21:00-23:00 UTC - after New York closes and before Tokyo/Sydney really
   * get going, historically the thinnest liquidity window for FX majors.
   * Only ever consulted for non-OTC tickers (see avoidDeadHours's docs). */
  private isDeadHour(): boolean {
    const h = new Date(this.now() * 1000).getUTCHours()
    return h >= 21 && h < 23
  }

  /** Cooldown + one-auto-position-per-asset + optional watchlist restriction
   * + market-scope (real vs OTC) + options-capability + correlation guard +
   * streak-breaker bench + dead-hours filter, applied by every signal picker
   * (all sources funnel through this). */
  private assetBlocked(asset: string): boolean {
    if (this.config.watchlist.length > 0) {
      const inList = this.config.watchlist.includes(asset)
      const exclude = this.config.watchlistMode === 'exclude'
      if (exclude ? inList : !inList) return true
    }
    // MARKET SCOPE: keep the two feed families apart so a config built for
    // one never fires on the other. Real feeds have sessions/microstructure;
    // -OTC feeds are the broker's generator - a signal (or a validated edge,
    // or a pin) earned on one family says nothing about the other. 'real'
    // excludes every -OTC ticker; 'otc' admits nothing else.
    if (this.config.marketScope === 'real' && asset.endsWith('-OTC')) return true
    if (this.config.marketScope === 'otc' && !asset.endsWith('-OTC')) return true
    // OPTIONS-CAPABILITY: the auto-trader only ever places binary options,
    // but the candidate universe is every open instrument on the account -
    // including margin CFDs (stocks, indices, many commodities) that IQ will
    // only ever answer with "is not a turbo/binary/digital instrument".
    // Screening those was pure alert noise: evaluate -> signal -> guaranteed
    // rejection -> 10min cooldown -> repeat on the next tick. Skip them BEFORE
    // any evaluation using the account's own payout metadata (CFD-only
    // instruments report no binary/turbo payout). Permissive while metadata
    // is cold (sim mode / sidecar still answering) - isOptionInstrument's
    // "unknown -> don't hide anything" contract, with the reactive
    // broker-rejection path as the backstop.
    try {
      const market = this.ctx.use<{ isOptionInstrument: (ticker: string) => boolean }>('market')
      if (!market.isOptionInstrument(asset)) return true
    } catch {
      // market plugin not loaded - capability gating disabled
    }
    if (this.config.avoidDeadHours === true && !asset.endsWith('-OTC') && this.isDeadHour()) return true
    const rejectedUntil = this.assetRejectedUntil.get(asset) ?? 0
    if (this.now() < rejectedUntil) return true
    const last = this.rt.lastAssetTs.get(asset) ?? 0
    // Hard floor: a pair the auto-trader just traded is off-limits for a
    // full hour minimum, no matter what cooldownSec is set to (even if an
    // older saved config or a future patch tries to shrink it below that) -
    // every pair it touches gets its own 1hr rest before it can be traded
    // again.
    const effectiveCooldown = Math.max(this.config.cooldownSec, ModeService.MIN_ASSET_COOLDOWN_SEC)
    if (this.now() - last < effectiveCooldown) return true
    if (this.hasOpenAutoOn(asset)) return true
    const label = this.fixedStrategyLabel()
    if (label && this.config.streakBreaker !== false && this.isBenched(`${label}|${asset}`)) return true
    if (this.config.correlationGuard !== false && this.correlationBlocked(asset)) return true
    return false
  }

  /** True when a DIFFERENT asset the auto-trader already has open shares a
   * correlation group with this candidate - treating them as one exposure,
   * not two "diversified" ones. */
  private correlationBlocked(asset: string): boolean {
    const group = ModeService.correlationGroupOf(asset)
    if (group === null) return false
    try {
      const openAssets = this.store
        .listPositions('open', 500)
        .filter((p) => p.note?.startsWith('auto:') && p.asset !== asset)
        .map((p) => p.asset)
      return openAssets.some((a) => ModeService.correlationGroupOf(a) === group)
    } catch {
      return false
    }
  }

  private emit(level: 'info' | 'warn' | 'danger' | 'success', message: string): void {
    this.ctx.bus.emit('alert', { level, message, ts: this.now() })
  }

  // ---------- stats (rebuilt from the journal, same pattern as autopilot) ----------

  /**
   * Midnight (UTC) day boundary - resets ONLY the daily counters (trades,
   * wins, losses, pnlToday). It used to do that by blindly replacing the
   * whole runtime with a fresh one, which silently wiped three things that
   * must survive the boundary:
   *  - openCount: reset to 0 even though a position opened before midnight
   *    may still be open after it, letting maxOpen be exceeded until the
   *    next onPositionClosed/restart happens to fix the count.
   *  - lastAssetTs: wiped entirely, so a pair traded at 23:59 became
   *    tradeable again at 00:00 - defeating the per-asset cooldown floor
   *    (including the 1hr minimum) right at the one moment it matters most.
   *  - halted/complete/pot/rollN: reset to a fresh, un-halted cycle even
   *    though a compounding plan with stopOnLoss was deliberately parked
   *    until an explicit restart() - the day flipping should never be what
   *    un-halts it.
   * rebuildRuntime() already does this correctly: it restores halted/
   * complete/pot/rollN from the persisted planState (the actual source of
   * truth) and recomputes openCount/lastAssetTs from the store's real open
   * positions, so delegating to it here keeps everything but the
   * date-filtered daily stats intact across the boundary.
   */
  private rolloverIfNeeded(): void {
    const dayKey = new Date().toISOString().slice(0, 10)
    if (this.rt.dayKey !== dayKey) this.rebuildRuntime()
  }

  private rebuildRuntime(): void {
    const rt = ModeService.freshRuntime()
    // restore the compounding roll from the persisted config (survives restarts)
    if (this.config.planState) {
      rt.pot = this.config.planState.pot
      rt.rollN = this.config.planState.rollN
      rt.restarts = this.config.planState.restarts
      rt.halted = this.config.planState.halted
      rt.complete = this.config.planState.complete
    }
    try {
      const closed = this.store.listPositions('closed', 400).filter((p) => p.note?.startsWith('auto:'))
      const open = this.store.listPositions('open', 500).filter((p) => p.note?.startsWith('auto:'))
      rt.openCount = open.length
      for (const p of open) rt.lastAssetTs.set(p.asset, p.tsOpen)
      for (const p of closed) {
        const pnl = p.pnl ?? 0
        rt.pnlTotal += pnl
        const day = new Date((p.tsClose ?? p.tsOpen) * 1000).toISOString().slice(0, 10)
        if (day !== rt.dayKey) continue
        rt.trades += 1
        if (p.status === 'won') {
          rt.wins += 1
          rt.pnlToday += pnl
        } else if (p.status === 'lost') {
          rt.losses += 1
          rt.pnlToday += pnl
        } else if (p.status === 'closed') {
          // Task 58 (P1): manual early exits carry real pnl too - the daily
          // loss limit used to be blind to them (autopilot parity, Task 55)
          rt.pnlToday += pnl
        }
        // 'push': neutral refund (pnl 0) - counted in trades, not wins/losses
        rt.lastAssetTs.set(p.asset, Math.max(rt.lastAssetTs.get(p.asset) ?? 0, p.tsOpen))
      }
      // Task 58 (P2): the pace clock must ALSO see pre-restart positions that
      // are still open - a restart used to allow a new trade <1s after the
      // pre-restart one (paceSec only rebuilt from CLOSED positions)
      rt.lastTradeTs = [...closed, ...open].reduce((acc, p) => Math.max(acc, p.tsOpen), 0)
    } catch {
      // journal unavailable - start from zero
    }
    this.rt = rt
  }

  private onPositionClosed(position: { note?: string; pnl?: number; status: string; tsOpen: number; tsClose?: number; amount: number; payout: number; asset?: string; strategy?: string }): void {
    if (!position.note?.startsWith('auto:')) return
    this.rolloverIfNeeded()
    // Task 58 (P2): recount instead of blind decrement - a rollover right
    // before this event already rebuilt openCount WITHOUT this position, so
    // the old -1 double-decremented and loosened maxOpen by a slot until the
    // next rebuild. The query is scoped to auto notes exactly like the
    // rebuild's own count.
    try {
      this.rt.openCount = this.store.listPositions('open', 500).filter((p) => p.note?.startsWith('auto:')).length
    } catch {
      this.rt.openCount = Math.max(0, this.rt.openCount - 1)
    }
    const pnl = position.pnl ?? 0
    this.rt.pnlTotal += pnl
    if (position.status === 'won') {
      this.rt.wins += 1
      this.rt.pnlToday += pnl
    } else if (position.status === 'lost') {
      this.rt.losses += 1
      this.rt.pnlToday += pnl
    } else if (position.status === 'closed') {
      // Task 58 (P1): manual early exits count toward the daily limits too
      this.rt.pnlToday += pnl
    }
    // 'push': neutral refund (pnl 0) - no win/loss, nothing to add

    // streak-breaker: track consecutive losses per (strategy, pair) - the
    // exact identity recorded on the position at placement time, so this
    // works uniformly across every signalSource (a fixed label like
    // "kalman-ou-reversion", or a specific strategy/ensemble member id).
    // Task 58 (P3): ensemble/pool labels ("ensemble:a+b") used to be benched
    // as a WHOLE - a key pickStrategySignal never reads (it checks per
    // member "${s.id}|${asset}"), so ensemble losing streaks never benched
    // anything. The streak now propagates to every member that voted.
    if (position.asset && position.strategy && (position.status === 'won' || position.status === 'lost')) {
      const isComposite = position.strategy.startsWith('ensemble:') || position.strategy.startsWith('pool:')
      const members = isComposite
        ? position.strategy.slice(position.strategy.indexOf(':') + 1).split('+').map((s) => s.trim()).filter(Boolean)
        : [position.strategy]
      for (const memberId of members.length ? members : [position.strategy]) {
        const key = `${memberId}|${position.asset}`
        if (position.status === 'lost') {
          const streak = (this.lossStreak.get(key) ?? 0) + 1
          this.lossStreak.set(key, streak)
          if (streak >= ModeService.STREAK_BENCH_THRESHOLD) {
            const benchSec = Math.min(
              ModeService.STREAK_BENCH_MAX_SEC,
              ModeService.STREAK_BENCH_BASE_SEC * 2 ** (streak - ModeService.STREAK_BENCH_THRESHOLD)
            )
            this.benchedUntil.set(key, this.now() + benchSec)
            this.emit('warn', `[AUTO-TRADER] streak-breaker: ${key} benched ${Math.round(benchSec / 60)}min after ${streak} losses in a row`)
          }
        } else {
          this.lossStreak.set(key, 0)
        }
      }
    }

    // compounding roll - SAME fold-in/burn math as autopilot.ts's
    // onPositionClosed, applied to the auto-trader's own single roll
    const plan = this.config.stakePlan
    if (plan) {
      const base = plan.base
      const working = this.rt.pot >= 0.01 ? this.rt.pot : base
      if (position.status === 'won') {
        const cap = (plan.payoutCap ?? 70) / 100
        const fold = Math.min(pnl, position.amount * cap)
        this.rt.pot = Math.round((working + fold) * 100) / 100
        this.rt.rollN += 1
        const periods = plan.periods
        if (periods && this.rt.rollN >= periods) {
          this.rt.restarts += 1
          const banked = Math.round((this.rt.pot - base) * 100) / 100
          if (plan.onComplete === 'reseed') {
            this.rt.pot = 0
            this.rt.rollN = 0
            this.emit('success', `[AUTO-TRADER] compound cycle COMPLETE - ${periods} periods, +$${banked.toFixed(2)} banked - re-seeding $${base}`)
          } else {
            this.rt.halted = true
            this.rt.complete = true
            this.emit('success', `[AUTO-TRADER] compound cycle COMPLETE - ${periods} periods, +$${banked.toFixed(2)} banked - standing down; restart for a fresh cycle`)
          }
        }
      } else if (position.status === 'lost') {
        this.rt.pot = Math.round(Math.max(0, working - position.amount) * 100) / 100
        const kept = this.rt.pot
        if (this.rt.rollN > 0) this.rt.restarts += 1
        this.rt.rollN = 0
        if (plan.stopOnLoss !== false) {
          this.rt.halted = true
          this.rt.complete = false
          this.emit('warn', `[AUTO-TRADER] compound cycle ENDED on a loss (-$${Math.abs(pnl).toFixed(2)})${kept >= 0.01 ? ` - $${kept.toFixed(2)} of the pot stays banked on the balance` : ''} - restart to trade again`)
        }
      }
      this.persistPlanState()
    }
  }

  // ---------- config ----------

  private static isPlanState(v: unknown): v is NonNullable<AutoTraderConfig['planState']> {
    if (!v || typeof v !== 'object') return false
    const p = v as Record<string, unknown>
    return typeof p.pot === 'number' && typeof p.rollN === 'number' && typeof p.restarts === 'number' && typeof p.halted === 'boolean' && typeof p.complete === 'boolean'
  }

  /** Mirrors autopilot.ts's parseStakePlan - same shape, same clamps. */
  private parseStakePlan(raw: unknown, existing?: AutoStakePlan): AutoStakePlan | undefined {
    const p = (raw ?? existing) as Partial<AutoStakePlan> | undefined
    if (!p || p.kind !== 'compound') return undefined
    const base = Math.max(1, Number(p.base) || 1)
    return {
      kind: 'compound',
      base,
      rollPct: p.rollPct !== undefined ? clamp(Number(p.rollPct) || 100, 1, 100) : undefined,
      maxStake: p.maxStake !== undefined && Number(p.maxStake) >= 1 ? clamp(Number(p.maxStake), 1, 5000) : undefined,
      payoutCap: p.payoutCap !== undefined ? clamp(Number(p.payoutCap) || 70, 1, 70) : 70,
      stopOnLoss: p.stopOnLoss !== false,
      periods: p.periods !== undefined && Number(p.periods) > 0 ? Math.round(Number(p.periods)) : undefined,
      deriskAfter: p.deriskAfter !== undefined && Number(p.deriskAfter) > 0 ? Math.round(Number(p.deriskAfter)) : undefined,
      deriskPct: p.deriskAfter !== undefined && Number(p.deriskAfter) > 0 ? clamp(Number(p.deriskPct) || 50, 1, 100) : undefined,
      onComplete: p.onComplete === 'reseed' ? 'reseed' : 'halt',
    }
  }

  /** smartStaking multiplier - reads the SAME 0-100 confidence every source
   * already puts on its ScreenRow (no new signal needed): raw |score|-
   * derived for screener/kalman-ou/markov/momentum/confluence, agreement %
   * for an ensemble, or the proven Wilson win rate for an auto-learn pick.
   * 70 is treated as "normal" (1.0x, roughly where most sources' own
   * minConfidence floors sit) - below it tapers down to a 0.5x floor, above
   * it scales up to a 1.5x cap. Returns 1 (no-op) when smartStaking is off
   * or there's no row to read yet. */
  private confidenceMultiplier(row?: ScreenRow): number {
    if (this.config.smartStaking !== true || !row) return 1
    return clamp(row.confidence / 70, 0.5, 1.5)
  }

  /** Mirrors autopilot.ts's stakeFor - same compounding math, same dust
   * guard - with an optional smartStaking multiplier layered on top of
   * EITHER the flat stake or the compounding plan's rolled amount, applied
   * before a compounding plan's own maxStake clamp so that cap still has
   * the final say. */
  private stakeForAuto(row?: ScreenRow): { amount: number; pot: number; rollN: number; compound: boolean; phase: 'compound' | 'derisk' } {
    const mult = this.confidenceMultiplier(row)
    const plan = this.config.stakePlan
    if (!plan) return { amount: Math.max(1, Math.round(this.config.stake * mult * 100) / 100), pot: 0, rollN: 0, compound: false, phase: 'compound' }
    const pot = this.rt.pot >= 0.01 ? this.rt.pot : plan.base
    const derisk = plan.deriskAfter !== undefined && plan.deriskPct !== undefined && this.rt.rollN >= plan.deriskAfter
    const rollPct = derisk ? plan.deriskPct! : (plan.rollPct ?? 100)
    const raw = ((pot * rollPct) / 100) * mult
    const amount = Math.min(plan.maxStake ?? 5000, Math.max(1, Math.round(raw * 100) / 100))
    return { amount, pot, rollN: this.rt.rollN, compound: true, phase: derisk ? 'derisk' : 'compound' }
  }

  /** Clears a halted/complete compounding cycle and re-seeds the pot at base. */
  restart(): { ok: boolean; error?: string } {
    if (!this.config.stakePlan) return { ok: false, error: 'restart applies to a compounding auto-trader plan only' }
    this.rt.pot = 0
    this.rt.rollN = 0
    this.rt.halted = false
    this.rt.complete = false
    this.persistPlanState()
    this.emit('success', `[AUTO-TRADER] compound cycle RESTARTED - next trade seeds $${this.config.stakePlan.base}`)
    return { ok: true }
  }

  private persistPlanState(): void {
    this.config.planState = { pot: this.rt.pot, rollN: this.rt.rollN, restarts: this.rt.restarts, halted: this.rt.halted, complete: this.rt.complete }
    this.persist()
  }

  configure(patch: Partial<AutoTraderConfig>): { ok: boolean; config: AutoTraderConfig; error?: string } {
    // AUDIT FIX (Task 58, P2): `Number("abc") || 0` turned garbage into
    // gate-disabling zeros - minScore 0, minConfidence 0, and worst of all
    // minPayoutPct 0 = the EV payout gate silently OFF. Non-finite input now
    // keeps the CURRENT value (fail-closed), matching the restore path.
    const numCur = (v: unknown, cur: number): number => {
      const n = Number(v)
      return Number.isFinite(n) ? n : cur
    }
    if (patch.enabled !== undefined) {
      const was = this.config.enabled
      this.config.enabled = Boolean(patch.enabled)
      // (re)enabling the trader while autonomy is already live is an arm
      // moment too - whatever qualifies NOW predates this arm
      if (this.config.enabled && !was && this.mode === 'auto') this.armAutoEdgeBackfill()
    }
    if (patch.signalSource !== undefined && (['cointegration', 'triangulation', 'adx-pattern-bias', 'shock-pressure', 'strategy', 'chartsignals', 'leadlag'] as const).includes(patch.signalSource as AutoTraderSource))
      this.config.signalSource = patch.signalSource as AutoTraderSource
    // AUDIT FIX (Task 58, P2): tf used to be cast unchecked - a garbage tf
    // made every picker return nothing (silent "no signal" forever) and
    // expiryBars math NaN (settlesAt = now + NaN = never settles). Garbage
    // is ignored, the current tf stays.
    if (patch.tf !== undefined && typeof patch.tf === 'string' && (ALL_TIMEFRAMES as string[]).includes(patch.tf)) this.config.tf = patch.tf as Timeframe
    // null/empty clears back to "track tf 1:1" (the old, implicit behavior) -
    // same null-clears-the-field convention pairStrategy/strategyParams use,
    // since JSON.stringify drops a bare `undefined` from the request body.
    if (patch.expiryTf !== undefined)
      this.config.expiryTf = typeof patch.expiryTf === 'string' && (ALL_TIMEFRAMES as string[]).includes(patch.expiryTf) ? (patch.expiryTf as Timeframe) : undefined
    if (patch.stake !== undefined) this.config.stake = clamp(numCur(patch.stake, this.config.stake), 1, 5000)
    if (patch.minScore !== undefined) this.config.minScore = clamp(numCur(patch.minScore, this.config.minScore), 0, 100)
    if (patch.minConfidence !== undefined) this.config.minConfidence = clamp(numCur(patch.minConfidence, this.config.minConfidence), 0, 100)
    if (patch.cointegrationZEntry !== undefined) this.config.cointegrationZEntry = clamp(numCur(patch.cointegrationZEntry, this.config.cointegrationZEntry), 0.5, 4)
    if (patch.cointegrationMaxHalfLife !== undefined) this.config.cointegrationMaxHalfLife = Math.round(clamp(numCur(patch.cointegrationMaxHalfLife, this.config.cointegrationMaxHalfLife), 5, 999))
    if (patch.triangulationZEntry !== undefined) this.config.triangulationZEntry = clamp(numCur(patch.triangulationZEntry, this.config.triangulationZEntry), 0.5, 4)
    if (patch.strategyId !== undefined)
      this.config.strategyId = typeof patch.strategyId === 'string' && patch.strategyId.trim() ? patch.strategyId.trim() : undefined
    if (patch.strategyIds !== undefined)
      this.config.strategyIds = Array.isArray(patch.strategyIds)
        ? patch.strategyIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
        : undefined
    if (patch.strategyPickMode !== undefined) this.config.strategyPickMode = patch.strategyPickMode === 'best' ? 'best' : 'ensemble'
    if (patch.autoDiscover !== undefined) this.config.autoDiscover = Boolean(patch.autoDiscover)
    if (patch.strategyParams !== undefined) this.config.strategyParams = ModeService.sanitizeStrategyParams(patch.strategyParams)
    if (patch.pairStrategy !== undefined) this.config.pairStrategy = ModeService.sanitizePairStrategy(patch.pairStrategy)
    if (patch.directionStrategy !== undefined) this.config.directionStrategy = ModeService.sanitizeDirectionStrategy(patch.directionStrategy)
    if (patch.direction !== undefined && ['both', 'call', 'put'].includes(String(patch.direction)))
      this.config.direction = String(patch.direction) as AutoTraderConfig['direction']
    if (patch.pickVariety !== undefined) this.config.pickVariety = Math.round(clamp(Number(patch.pickVariety) || 1, 1, 10))
    if (patch.maxOpen !== undefined) this.config.maxOpen = Math.round(clamp(numCur(patch.maxOpen, this.config.maxOpen), 1, 10))
    // Floor stays enforced in assetBlocked() regardless of what's saved here
    // (MIN_ASSET_COOLDOWN_SEC) - the field itself can still be raised past
    // 1hr for a longer per-pair rest, just never shrunk below it.
    if (patch.cooldownSec !== undefined) this.config.cooldownSec = Math.round(clamp(numCur(patch.cooldownSec, this.config.cooldownSec), 0, 86400))
    if (patch.paceSec !== undefined) this.config.paceSec = Math.round(clamp(numCur(patch.paceSec, this.config.paceSec), 0, 3600))
    if (patch.dailyProfitTarget !== undefined) this.config.dailyProfitTarget = Math.max(0, numCur(patch.dailyProfitTarget, this.config.dailyProfitTarget))
    if (patch.dailyLossLimit !== undefined) this.config.dailyLossLimit = Math.max(0, numCur(patch.dailyLossLimit, this.config.dailyLossLimit))
    if (patch.watchlist !== undefined)
      // Task 58 (P3): trim+upper normalize - " eurusd-otc " used to silently
      // match nothing in 'only' mode while the config alert kept announcing it
      this.config.watchlist = Array.isArray(patch.watchlist)
        ? patch.watchlist.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toUpperCase()).filter(Boolean)
        : []
    if (patch.smartStaking !== undefined) this.config.smartStaking = Boolean(patch.smartStaking)
    if (patch.correlationGuard !== undefined) this.config.correlationGuard = Boolean(patch.correlationGuard)
    if (patch.streakBreaker !== undefined) this.config.streakBreaker = Boolean(patch.streakBreaker)
    if (patch.avoidDeadHours !== undefined) this.config.avoidDeadHours = Boolean(patch.avoidDeadHours)
    if (patch.watchlistMode !== undefined) this.config.watchlistMode = patch.watchlistMode === 'exclude' ? 'exclude' : 'only'
    if (patch.marketScope !== undefined) this.config.marketScope = patch.marketScope === 'real' || patch.marketScope === 'otc' ? patch.marketScope : 'all'
    if (patch.minPayoutPct !== undefined) this.config.minPayoutPct = clamp(numCur(patch.minPayoutPct, this.config.minPayoutPct ?? 70), 0, 98)
    if (patch.volGate !== undefined) this.config.volGate = patch.volGate === 'avoid-volatile' ? 'avoid-volatile' : 'off'
    if (patch.stakePlan !== undefined) {
      const planChanged = JSON.stringify(this.config.stakePlan ?? null) !== JSON.stringify(patch.stakePlan ?? null)
      this.config.stakePlan = this.parseStakePlan(patch.stakePlan, this.config.stakePlan)
      // switching the plan itself (not just tuning a field on the same plan)
      // starts a fresh roll - an old pot/halt state from a different config
      // would be meaningless carried into a newly (re)enabled plan
      if (planChanged) {
        this.rt.pot = 0
        this.rt.rollN = 0
        this.rt.halted = false
        this.rt.complete = false
        this.config.planState = { pot: 0, rollN: 0, restarts: this.rt.restarts, halted: false, complete: false }
      }
    }
    this.persist()
    this.rt.lastRejection = undefined
    const srcDetail =
      this.config.signalSource === 'cointegration'
        ? ` (spread z ≥ ${this.config.cointegrationZEntry}σ · HL ≤ ${this.config.cointegrationMaxHalfLife}b, Engle-Granger)`
        : this.config.signalSource === 'triangulation'
          ? ` (basis z ≥ ${this.config.triangulationZEntry}σ across FX triangles)`
          : this.config.signalSource === 'adx-pattern-bias'
            ? ` (ADX ≥ ${ADX_TREND_THRESHOLD} + pattern bias agreement, composite ≥ ${COMPOSITE_QUALIFY})`
            : this.config.signalSource === 'shock-pressure'
              ? ` (shock ratio ≥ ${SHOCK_RATIO_THRESHOLD}σ-ish of ATR + ${PRESSURE_LOOKBACK}-bar pressure agreement, composite ≥ ${SHOCKPRESSURE_COMPOSITE_QUALIFY})`
              : this.config.signalSource === 'chartsignals'
                ? ` (chart-type vote engine, agree ≥ ${CHARTSIGNALS_MIN_AGREE}/5 families)`
                : this.config.signalSource === 'leadlag'
                ? ` (intermarket lead-lag across ${LEADLAG_GROUPS.length} leader groups - EURUSD/XAUUSD/BTCUSD/oil, |corr| ≥ ${LEADLAG_MIN_ABS_CORRELATION}, trigger |z| ≥ ${LEADLAG_MIN_TRIGGER_Z})`
                : this.config.signalSource === 'strategy'
                ? (() => {
                    const ids = this.effectiveStrategyIds()
                    const pinCount = Object.keys(this.config.pairStrategy ?? {}).length
                    const pinNote = pinCount ? `, ${pinCount} pair${pinCount > 1 ? 's' : ''} pinned to their own strategy` : ''
                    const ds = this.config.directionStrategy
                    const dirNote = ds?.call && ds?.put ? `, CALL→${ds.call} / PUT→${ds.put}` : ds?.call ? `, CALL→${ds.call}` : ds?.put ? `, PUT→${ds.put}` : ''
                    if (this.config.strategyPickMode === 'best' && this.config.autoDiscover === true)
                      return ` (auto-discover ON - ranks the FULL builtin + AI Lab catalog per pair, mining new specs for pairs without one; ${ids.length ? `${ids.length} manually-picked id(s) also included` : 'no manual picks'}${pinNote}${dirNote})`
                    const body =
                      ids.length === 0
                        ? pinCount || dirNote
                          ? 'no global strategy picked'
                          : 'no strategy picked'
                        : ids.length === 1
                          ? ids[0]
                          : this.config.strategyPickMode === 'best'
                            ? `auto-learn over ${ids.length}: ${ids.join(', ')} - trades whichever is proven best per pair`
                            : `ensemble of ${ids.length}: ${ids.join(', ')} · ≥${this.config.minConfidence}% agreement`
                    return ` (${body}${pinNote}${dirNote})`
                  })()
                : ''
    // minScore/minConfidence are meaningless noise on a config line unless
    // this source actually gates on them - 'strategy' never applies minScore
    // (in any of single/ensemble/auto-learn mode, per pickStrategySignal),
    // and only applies minConfidence as the ensemble's "min agreement %"
    // when 2+ strategyIds are picked AND strategyPickMode is 'ensemble'.
    // Reporting both unconditionally ("minScore 40 · minConf 55") claimed
    // thresholds that weren't actually in effect - this says only what's
    // real for the source that's actually armed.
    const strategyIdsForLog = this.config.signalSource === 'strategy' ? this.effectiveStrategyIds() : []
    const showMinScore = this.config.signalSource !== 'strategy'
    const showMinConf = this.config.signalSource !== 'strategy' || (strategyIdsForLog.length > 1 && this.config.strategyPickMode !== 'best')
    const thresholds = [
      showMinScore ? `minScore ${this.config.minScore}` : null,
      showMinConf ? `minConf ${this.config.minConfidence}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    // report the ENFORCED cooldown (the 1hr floor always wins), not the raw
    // saved value - a config saved at e.g. 60s would otherwise claim a
    // cooldown that assetBlocked() never actually applies
    const effectiveCooldown = Math.max(this.config.cooldownSec, ModeService.MIN_ASSET_COOLDOWN_SEC)
    const scopeNote = this.config.marketScope === 'real' ? ' · REAL feeds only' : this.config.marketScope === 'otc' ? ' · OTC feeds only' : ''
    const payoutNote = (this.config.minPayoutPct ?? 0) > 0 ? ` · payout ≥ ${this.config.minPayoutPct}% (EV gate)` : ''
    const volNote = this.config.volGate === 'avoid-volatile' ? ' · vol-gate on (no entries in a VOLATILE regime)' : ''
    this.emit(
      'info',
      `AUTO-TRADER config: ${this.config.enabled ? 'armed' : 'off'} · src ${this.config.signalSource}${srcDetail} · ${this.config.tf} · stake $${this.config.stake}${thresholds ? ` · ${thresholds}` : ''} · maxOpen ${this.config.maxOpen} · cooldown ${effectiveCooldown}s${scopeNote}${payoutNote}${volNote} · binary options only (CFD-only instruments skipped)`
    )
    return { ok: true, config: { ...this.config } }
  }

  status(): {
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
      /** Edge-memory state for the ACTIVE signal source - what the operator
       * needs to answer "why isn't it trading / what is it waiting for": the
       * held (already-true) edges it is refusing to act on, each with when the
       * hold started and why (backfilled at arm vs consumed by an executed
       * trade). 'strategy' keeps no memory (its votes are phase-gated at the
       * eval), so held/screenerHeld come back empty for it. since = kernel
       * epoch SECONDS. Capped at 60 rows per list. */
      edges: {
        source: AutoTraderSource
        cold: boolean
        held: Array<{ asset: string; dir: string; origin: 'backfill' | 'executed'; since: number }>
        screenerHeld: Array<{ asset: string; dir: string; origin: 'backfill' | 'executed'; since: number }>
      }
    }
  } {
    const sweepDesc = this.sweepEdge.describe()
    const isSweepSource = SWEEP_SOURCES.includes(this.config.signalSource)
    // 'screener' is no longer a selectable signal source (it duplicated the
    // 'strategy' source's screener-composite option) - screenerHeld is kept
    // in the shape for API/UI backward-compat but is now always empty.
    const isScreener = false
    return {
      mode: this.mode,
      ts: this.ts,
      reason: this.reason,
      autotrader: {
        config: { ...this.config },
        trades: this.rt.trades,
        wins: this.rt.wins,
        losses: this.rt.losses,
        pnlToday: Math.round(this.rt.pnlToday * 100) / 100,
        pnlTotal: Math.round(this.rt.pnlTotal * 100) / 100,
        openCount: this.rt.openCount,
        lastTradeTs: this.rt.lastTradeTs,
        lastAction: this.rt.lastAction,
        lastRejection: this.rt.lastRejection,
        active: this.mode === 'auto' && this.config.enabled,
        edges: {
          source: this.config.signalSource,
          cold: isSweepSource && sweepDesc.cold,
          held: isSweepSource ? sweepDesc.held.slice(0, 60) : [],
          screenerHeld: isScreener
            ? [...this.autoEdgeBackfill.entries()]
                .map(([key, e]) => ({
                  asset: key.slice(0, key.lastIndexOf(':')),
                  dir: key.slice(key.lastIndexOf(':') + 1),
                  origin: e.origin,
                  since: e.since,
                }))
                .sort((a, b) => b.since - a.since)
                .slice(0, 60)
            : [],
        },
      },
    }
  }

  // ---------- lifecycle wiring ----------

  wire(): void {
    this.unsubscribers.push(
      this.ctx.bus.on('positionClosed', ({ position }) => this.onPositionClosed(position))
    )
  }
}

let activeMode: ModeService | null = null

export const osModePlugin: Plugin = {
  name: 'osmode',
  start: async (ctx) => {
    const svc = new ModeService()
    activeMode = svc
    ctx.provide('mode', svc)
    await svc.start(ctx)
    svc.wire()
  },
  stop: () => {
    try {
      activeMode?.stop()
    } catch {
      // not started
    }
    activeMode = null
  },
}
