// IQAIR//OS - MSL script backtester (Phase 9 of the chart-engine expansion
// roadmap: "backtesting, validation, documentation").
//
// HONEST SCOPE, stated up front rather than discovered the hard way: this
// walks a script over CLOSED historical candles and re-evaluates it at
// every bar using the SAME evaluateStrategyScript() the live engines call -
// but only the CANDLE-DERIVED primitives can be replayed this way. `ind.*`,
// `ohlc()`, `renko.*`/`pf.*`/`ha.*`/`rangebars.*`/`volumebars.*`/`tpo.*`/
// `vp.*`/`linebreak.*`/`kagi.*`/`swing.*`, and `since()`/`streak()` are all
// pure functions of the candle history up to bar i, so they replay exactly
// as they would have lived.
//
// Every OTHER verdict source (`smc`, `oracle`, `accute`, `technical`,
// `tickOracle`, `nextExpiry`, `payout`, ...) depends on a LIVE plugin's own
// internal state (a tick buffer, a scan cache, an account's current payout)
// that this codebase has no historical snapshot of - there is no "what did
// the SMC scanner say as of 400 candles ago" to replay. Rather than silently
// fabricate a plausible-looking historical read for these (which would be
// exactly the kind of "proxy labeled as measured" the project's own ground
// rules forbid), every one of them reads back as `{direction:'none',
// confidence:0}` for the ENTIRE backtest - the same honest "no read"
// behavior a live cold cache already produces elsewhere in this codebase.
// `unavailableSources` in the result lists every one of these by name so a
// caller (and a script author) can see exactly what was faked-closed, not
// faked-open. A script that only uses the first group backtests faithfully
// end-to-end; a script that also reads `smc`/`oracle`/etc. will simply never
// see those conditions fire during a backtest, same as if the plugin were
// always cold.
//
// Settlement model: BINARY, fixed `expiryBars` ahead (not the script's own
// `expiry = <minutes>` statement/wall-clock minutes - history here is
// candle-indexed, not wall-clock-paced), win iff direction matches the sign
// of close[i+expiryBars] - close[i] (flat settles as a loss, same house
// convention `strategies/backtest.ts`'s binary settlement already uses - a
// push is not a free option in real binary trading, so a flat read is
// scored honestly against the trader, not excluded).
//
// Pure function, no I/O, no look-ahead: bar i's evaluation only ever sees
// candles[0..i] via `series`/`seriesFor`.

import type { Candle, Timeframe } from '../types'
import { parseStrategyScript, evaluateStrategyScript, clearMslState, type MslSeriesCtx, type MslSourceRead, type MslAst } from './strategylang'
import { META_CONDITION_SOURCES } from './metastrategy'
import { ALL_SMC_KINDS } from './smc'
import { EXPIRIES_MIN } from './nextexpiry'
import { ORACLE_BUCKETS_SEC } from './tickdesk'
import { TECH_LADDER } from './technicals'

export interface MslBacktestTrade {
  /** index into the candle array of the bar the signal fired ON (its close triggered evaluation) */
  index: number
  time: number
  direction: 'call' | 'put'
  confidence: number
  entry: number
  exit: number
  win: boolean
  /** per-$1-staked PnL for this one trade (win -> +payout, loss -> -1) -
   * only present when a `payout` fraction was given (see MslBacktestOpts) -
   * undefined, never a fabricated 0, when no payout was supplied. */
  pnl?: number
}

/** Win-rate breakdown for one settlement horizon - Section 11's flagged
 * "win-rate-by-expiry breakdown" item, when `opts.expiryBarsList` asks for
 * more than one horizon in a single run (no re-evaluation needed - the
 * SAME fired signals are just settled against each horizon's own forward
 * candle). */
export interface MslBacktestExpiryBreakdown {
  expiryBars: number
  trades: number
  wins: number
  losses: number
  winRate: number | null
  /** only present when a payout fraction was supplied */
  expectancy?: number
}

/** A plain win/loss/expectancy breakdown over SOME subset of a full trade
 * list - the shared shape `inSample`/`outOfSample` (below) and each walk-
 * forward fold use, so a caller reads them all the same way. */
export interface MslBacktestBreakdown {
  trades: number
  wins: number
  losses: number
  winRate: number | null
  avgConfidence: number | null
  /** only present when a payout fraction was supplied */
  expectancy?: number
  netPnl?: number
}

export interface MslBacktestResult {
  ok: boolean
  error?: string
  /** bars actually evaluated (candles.length - warmup - expiryBars, clamped to >= 0) */
  barsEvaluated: number
  trades: MslBacktestTrade[]
  wins: number
  losses: number
  winRate: number | null
  avgConfidence: number | null
  /** every verdict-source name that reads 'none' for the WHOLE backtest
   * because it depends on live plugin state this engine cannot replay
   * historically - see this module's header. Not an error; a script that
   * never references these is unaffected. */
  unavailableSources: string[]
  /** PAYOUT-AWARE fields, present only when `opts.payout` was supplied -
   * Section 11's flagged "payout- and real-expiry-aware backtest
   * settlement" item. expectancy = mean per-$1 PnL across trades (same
   * ev() formula the MSL-level ev()/gate() functions use, applied to the
   * REALIZED win/loss sequence rather than a hypothetical winProb).
   * maxDrawdown = the largest peak-to-trough drop in cumulative PnL across
   * the trade sequence (in $-per-$1-staked units, always >= 0). netPnl =
   * the final cumulative PnL. */
  expectancy?: number
  maxDrawdown?: number
  netPnl?: number
  /** present only when `opts.expiryBarsList` was supplied (overrides
   * `opts.expiryBars` for this breakdown; the top-level trades/wins/losses
   * above still use the single `opts.expiryBars` horizon for backward
   * compatibility) - one entry per requested horizon, same fired signals,
   * different settlement distance. */
  byExpiry?: MslBacktestExpiryBreakdown[]
  /** OUT-OF-SAMPLE SPLIT (the last remaining item from the entire chart-
   * engine roadmap backlog, closed in the loose-threads-backtesting
   * follow-up sweep) - present only when `opts.outOfSampleBars` was
   * supplied. `inSample` is every trade whose signal fired BEFORE the
   * trailing `outOfSampleBars`-wide window; `outOfSample` is every trade
   * that fired INSIDE it - the same fired-signal list and settlement this
   * result's own top-level trades[] already computed, just partitioned by
   * index, never re-evaluated or re-settled. A script with a real edge
   * should show a broadly similar winRate/expectancy in both halves; a
   * sharp dropoff out-of-sample is the classic "looked good on the exact
   * window I was staring at" warning sign this split exists to surface -
   * this engine does not itself fit/tune any parameter, so "out-of-sample"
   * here means "does the edge still hold on bars nobody looked at while
   * writing the script", not "holds out a fitting set". */
  inSample?: MslBacktestBreakdown
  outOfSample?: MslBacktestBreakdown
}

/** One walk-forward fold's own breakdown, PLUS which bar range it covers -
 * `claude/chart-engine-roadmap-progress.md`'s "walk-forward" item. Folds
 * are contiguous, chronological, non-overlapping slices of the SAME fired-
 * signal list a plain backtest already produces (one evaluation pass, then
 * split by index) - never a fresh evaluation per fold, which would be both
 * wasteful and (since `since()`/`streak()` carry state across the whole
 * run) subtly different from a true single continuous pass. */
export interface MslBacktestFold extends MslBacktestBreakdown {
  foldIndex: number
  /** first/last candle INDEX this fold's fired signals were drawn from
   * (inclusive) - the signal's own fire bar, not its settlement bar. */
  fromIndex: number
  toIndex: number
  fromTime: number
  toTime: number
}

export interface MslBacktestWalkForwardResult {
  ok: boolean
  error?: string
  barsEvaluated: number
  unavailableSources: string[]
  /** the whole run's combined breakdown - identical numbers a plain
   * `backtestMslScript()` call over the same candles/script/opts would
   * report (same fired signals, same settlement), just also folded. */
  overall: MslBacktestBreakdown
  folds: MslBacktestFold[]
  /** stddev of each fold's own winRate (folds with zero trades excluded,
   * null when fewer than 2 folds have any trades) - a quick, honest
   * single-number "how consistent was this across time" read; a script
   * that's genuinely robust to regime shifts has a LOW number here, not
   * just a high overall winRate (which a single lucky fold can produce on
   * its own). Never presented as a significance test - just a dispersion
   * measure over however many folds this run happened to have. */
  winRateStdDev: number | null
}

/** One asset's own plain backtest result, tagged with which asset it was -
 * `claude/chart-engine-roadmap-progress.md`'s "cross-asset" item. */
export interface MslBacktestAssetResult {
  asset: string
  result: MslBacktestResult
}

export interface MslBacktestCrossAssetResult {
  ok: boolean
  error?: string
  /** one full MslBacktestResult per asset, in the order given - an asset
   * whose own candles were too few/invalid still gets an entry here with
   * that asset's own result.ok:false/error, never silently dropped. */
  perAsset: MslBacktestAssetResult[]
  /** combined breakdown across every asset's own trades pooled together -
   * the "does this edge generalize, or is it one asset's quirk" read.
   * Built by concatenating each OK asset's own already-settled trades, not
   * by re-evaluating anything - an asset that failed (too little history,
   * parse error) contributes zero trades here, same honest exclusion the
   * single-asset engine already uses for a horizon that runs past the end
   * of history. */
  combined: MslBacktestBreakdown
  /** stddev of each (successful, >=1 trade) asset's own winRate - same
   * "how consistent across assets" read `winRateStdDev` gives across time
   * for the walk-forward result; null when fewer than 2 qualifying assets. */
  winRateStdDevAcrossAssets: number | null
}

/** Every source name a script could reference by bare identifier, each
 * defaulting to a 'none' read, so a script referencing ANY known source
 * (even one this engine can't honestly replay) evaluates instead of
 * throwing "unknown identifier". Mirrors plugins/metastrategy.ts's
 * buildScriptReads() key set (META_CONDITION_SOURCES + the colon-suffixed
 * per-rung keys) without needing a live plugin context at all. */
function unavailableReads(): Record<string, MslSourceRead> {
  const reads: Record<string, MslSourceRead> = {}
  const none: MslSourceRead = { direction: 'none', confidence: 0 }
  for (const s of META_CONDITION_SOURCES) reads[s] = none
  for (const kind of ALL_SMC_KINDS) reads[`smc:${kind}`] = none
  for (const E of EXPIRIES_MIN) reads[`nextExpiry:${E}`] = none
  for (const sec of ORACLE_BUCKETS_SEC) {
    reads[`tickOracle:${sec}`] = none
    reads[`tickTechnical:${sec}`] = none
  }
  for (const rung of TECH_LADDER) {
    reads[`technical:${rung.tf}`] = none
    reads[`reversal:${rung.tf}`] = none
  }
  reads.payout = { direction: 'none', confidence: 0, value: 0 }
  return reads
}

/** BUG FIX (strategy vet): `payout` used to stay stubbed at value 0 for the
 * whole replay even when the caller SUPPLIED a payout fraction for the
 * P&L math - so `gate(p, payout.value, e)` evaluated winProb*0 - (1-winProb)
 * >= e, i.e. false on every bar, and any script using the documented
 * `gate(..., payout.value, ...)` EV gate (13 of the 15 seeded builtin
 * examples) fired ZERO trades here and looked "untestable" rather than
 * tested. A payout the caller explicitly passed is not a fabricated read -
 * it is the exact assumption the result's own expectancy/netPnl are already
 * computed under - so the script now sees that same number. With no payout
 * supplied the read stays 0 (honest "unknown"), unchanged. Returns the
 * source names still unavailable, so `unavailableSources` no longer lists
 * `payout` when it was in fact provided. */
function applyPayoutRead(reads: Record<string, MslSourceRead>, payout: number | undefined): string[] {
  if (payout !== undefined && payout > 0) reads.payout = { direction: 'none', confidence: 0, value: payout }
  return Object.keys(reads).filter((k) => !(k === 'payout' && payout !== undefined && payout > 0))
}

function seriesUpTo(candles: Candle[], i: number): MslSeriesCtx {
  const slice = candles.slice(0, i + 1)
  return {
    open: slice.map((c) => c.open),
    high: slice.map((c) => c.high),
    low: slice.map((c) => c.low),
    close: slice.map((c) => c.close),
    volume: slice.map((c) => c.volume ?? 0),
    time: slice.map((c) => c.time),
  }
}

interface FiredSignal {
  index: number
  direction: 'call' | 'put'
  confidence: number
}

/** The one expensive pass every exported function in this module shares:
 * parse once, evaluate once per bar from `warmupBars` through `lastIdx`
 * (inclusive), collect every bar that actually fired above `minConfidence`.
 * `backtestMslScript()`, `backtestMslScriptWalkForward()`, and each asset
 * inside `backtestMslScriptCrossAsset()` all call this and then only ever
 * SETTLE/partition the result afterward - never a second evaluation pass
 * over the same candles, so `since()`/`streak()`'s own cross-bar state
 * (scoped to `runId`) stays a single continuous run exactly like a live
 * evaluator would see it, not an artificially chunked one. */
function fireSignals(
  candles: Candle[],
  parsedAst: MslAst,
  reads: Record<string, MslSourceRead>,
  warmupBars: number,
  lastIdx: number,
  minConfidence: number,
  runId: string,
): FiredSignal[] {
  const fired: FiredSignal[] = []
  try {
    for (let i = warmupBars; i <= lastIdx; i++) {
      const series = seriesUpTo(candles, i)
      const seriesFor = (_tf: string): MslSeriesCtx | undefined => undefined // no cross-timeframe history available to a pure candle-array backtest
      const state = { keyPrefix: runId, barTimeSec: candles[i].time }
      const out = evaluateStrategyScript(parsedAst, reads, undefined, series, seriesFor, undefined, state)
      if (out.error || out.direction === 'none') continue
      if (out.confidence < minConfidence) continue
      fired.push({ index: i, direction: out.direction, confidence: out.confidence })
    }
  } finally {
    clearMslState(runId)
  }
  return fired
}

/** Settle a fired-signal list against ONE bars-ahead horizon - the same
 * binary settlement rule the module header documents (flat = loss). Shared
 * by every caller below so the settlement math can never drift between
 * the plain/walk-forward/cross-asset entry points. */
function settleFired(fired: FiredSignal[], candles: Candle[], bars: number, payout: number | undefined): MslBacktestTrade[] {
  return fired
    .filter((f) => f.index + bars <= candles.length - 1)
    .map((f) => {
      const entry = candles[f.index].close
      const exit = candles[f.index + bars].close
      const delta = exit - entry
      const win = f.direction === 'call' ? delta > 0 : delta < 0
      const trade: MslBacktestTrade = { index: f.index, time: candles[f.index].time, direction: f.direction, confidence: f.confidence, entry, exit, win }
      if (payout !== undefined) trade.pnl = win ? payout : -1
      return trade
    })
}

/** Reduce an already-settled trade list to the shared breakdown shape -
 * used for the top-level result, `inSample`/`outOfSample`, each walk-
 * forward fold, and cross-asset's `combined`/per-asset breakdowns, so
 * "how do I read a win/loss subset" only has one answer in this module. */
function breakdownOf(trades: MslBacktestTrade[], payout: number | undefined): MslBacktestBreakdown {
  const wins = trades.filter((t) => t.win).length
  const losses = trades.length - wins
  const winRate = trades.length ? wins / trades.length : null
  const avgConfidence = trades.length ? trades.reduce((s, t) => s + t.confidence, 0) / trades.length : null
  const out: MslBacktestBreakdown = { trades: trades.length, wins, losses, winRate, avgConfidence }
  if (payout !== undefined && trades.length) {
    out.expectancy = trades.reduce((s, t) => s + (t.pnl ?? 0), 0) / trades.length
    out.netPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  }
  return out
}

/** Population stddev of a list of win rates, ignoring nulls (zero-trade
 * folds/assets) - null when fewer than 2 remain, never a misleading 0 or
 * NaN from dividing by a too-small sample. */
function winRateStdDev(rates: (number | null)[]): number | null {
  const vals = rates.filter((r): r is number => r !== null)
  if (vals.length < 2) return null
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length
  const variance = vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length
  return Math.sqrt(variance)
}

export interface MslBacktestOpts {
  /** bars ahead the binary settles against (default 3 - an arbitrary but
   * documented default; callers trading a real minutes-expiry should pass
   * the actual bar count that expiry spans on this asset's native tf). */
  expiryBars?: number
  /** minimum closed-bar history before the first evaluation (default 60 -
   * enough for the deeper `ind.*`/`vp.*` lookbacks' internal warmups to
   * stop returning NaN/empty on literally the first few bars). */
  warmupBars?: number
  /** confidence floor (0-100) below which a fired call/put is NOT counted
   * as a trade (default 0 - every fire counts). Lets a caller test "would
   * this script be profitable if I only ever took its >=70 confidence
   * signals" without editing the script itself. */
  minConfidence?: number
  /** unique id for this run's since()/streak() state scope - MUST differ
   * between concurrent/successive backtests of different scripts (or the
   * same script with different params) sharing this process, or their
   * streak/since counters would bleed into each other. Defaults to a
   * fresh random id (and that id's state is cleared when the run ends
   * either way, so forgetting this only risks a mid-run collision with
   * another backtest started at the exact same moment, never a stale
   * leftover afterward). */
  runId?: string
  /** when supplied (0..1), every trade also gets a `pnl` field (win ->
   * +payout, loss -> -1, per $1 staked) and the result gets `expectancy`/
   * `maxDrawdown`/`netPnl` - Section 11's "payout-aware backtest
   * settlement" item. Omit to keep the plain win/loss-count-only result
   * (no payout is fabricated - fields simply stay absent). A flat close at
   * settlement still counts as a loss, same convention as the plain
   * win/loss settlement above. */
  payout?: number
  /** when supplied, settles the SAME fired signals against each of these
   * bar-counts-ahead horizons (in addition to the single `expiryBars`
   * result above) and returns the breakdown in `byExpiry` - Section 11's
   * "win-rate-by-expiry breakdown" item. The warmup/evaluation window is
   * sized to the LARGEST entry so every horizon gets the full trade set;
   * a horizon whose forward candle would run past the end of history is
   * silently excluded from that trade (never fabricated), same as the
   * single-expiry path already does by construction. */
  expiryBarsList?: number[]
  /** when supplied, splits the result into `inSample` (every fired signal
   * at index < candles.length - outOfSampleBars) and `outOfSample` (every
   * fired signal from that point on) - the out-of-sample item from
   * `claude/chart-engine-roadmap-progress.md`'s backlog. Clamped so at
   * least 1 bar stays in each half when both are non-empty; a value >=
   * the evaluated window simply makes `inSample` empty rather than
   * erroring (the same "silently excluded, never fabricated" convention
   * `expiryBarsList`'s own too-short horizons already use). */
  outOfSampleBars?: number
}

export function backtestMslScript(candles: Candle[], script: string, opts: MslBacktestOpts = {}): MslBacktestResult {
  const expiryBars = Math.max(1, Math.round(opts.expiryBars ?? 3))
  const warmupBars = Math.max(1, Math.round(opts.warmupBars ?? 60))
  const minConfidence = Math.max(0, Math.min(100, opts.minConfidence ?? 0))
  const runId = opts.runId ?? `mslbacktest:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const reads = unavailableReads()
  const payout = opts.payout !== undefined && Number.isFinite(opts.payout) ? Math.max(0, opts.payout) : undefined
  const unavailableSources = applyPayoutRead(reads, payout)
  const expiryBarsList = (opts.expiryBarsList ?? []).map((n) => Math.max(1, Math.round(n))).filter((n) => Number.isFinite(n))
  const maxExpiryNeeded = Math.max(expiryBars, ...expiryBarsList, 1)
  const empty = (error: string): MslBacktestResult => ({ ok: false, error, barsEvaluated: 0, trades: [], wins: 0, losses: 0, winRate: null, avgConfidence: null, unavailableSources })

  const parsed = parseStrategyScript(script)
  if (!parsed.ok) return empty(`script parse error: ${parsed.error}`)
  if (candles.length < warmupBars + maxExpiryNeeded + 1) {
    return empty(`not enough candles - need at least ${warmupBars + maxExpiryNeeded + 1} (warmup ${warmupBars} + max expiry ${maxExpiryNeeded} + 1), got ${candles.length}`)
  }

  // Evaluate ONCE per bar (the expensive step) up to the point every
  // requested horizon still has a forward candle to settle against; each
  // horizon's own trade list is then just a cheap re-settlement of the
  // same fired signals, not a re-run of the script.
  const lastIdx = candles.length - 1 - maxExpiryNeeded
  const fired = fireSignals(candles, parsed.ast, reads, warmupBars, lastIdx, minConfidence, runId)

  const settle = (bars: number): MslBacktestTrade[] => settleFired(fired, candles, bars, payout)

  const trades = settle(expiryBars)
  const { wins, losses, winRate, avgConfidence } = breakdownOf(trades, payout)

  const result: MslBacktestResult = { ok: true, barsEvaluated: lastIdx - warmupBars + 1, trades, wins, losses, winRate, avgConfidence, unavailableSources }

  if (payout !== undefined && trades.length) {
    let cum = 0
    let peak = 0
    let maxDrawdown = 0
    for (const t of trades) {
      cum += t.pnl ?? 0
      peak = Math.max(peak, cum)
      maxDrawdown = Math.max(maxDrawdown, peak - cum)
    }
    result.expectancy = trades.reduce((s, t) => s + (t.pnl ?? 0), 0) / trades.length
    result.maxDrawdown = maxDrawdown
    result.netPnl = cum
  }

  if (expiryBarsList.length) {
    result.byExpiry = expiryBarsList.map((bars) => {
      const ts = settle(bars)
      const b = breakdownOf(ts, payout)
      const entry: MslBacktestExpiryBreakdown = { expiryBars: bars, trades: b.trades, wins: b.wins, losses: b.losses, winRate: b.winRate }
      if (b.expectancy !== undefined) entry.expectancy = b.expectancy
      return entry
    })
  }

  if (opts.outOfSampleBars !== undefined && Number.isFinite(opts.outOfSampleBars) && opts.outOfSampleBars > 0) {
    const oosBars = Math.round(opts.outOfSampleBars)
    const splitIdx = candles.length - oosBars // trades firing at index >= splitIdx are out-of-sample
    const inSampleTrades = trades.filter((t) => t.index < splitIdx)
    const outOfSampleTrades = trades.filter((t) => t.index >= splitIdx)
    result.inSample = breakdownOf(inSampleTrades, payout)
    result.outOfSample = breakdownOf(outOfSampleTrades, payout)
  }

  return result
}

export interface MslBacktestWalkForwardOpts extends MslBacktestOpts {
  /** number of contiguous, chronological, non-overlapping folds to split
   * the evaluated bar range into (default 5). Folds are sized as evenly as
   * possible by bar count - the last fold absorbs any remainder, same
   * convention a plain integer-division split would produce, never
   * silently dropping a leftover bar. Clamped to at least 1 and at most
   * the number of bars actually evaluated (a fold needs at least 1 bar). */
  folds?: number
}

/** Walk-forward: the SAME single evaluation pass `backtestMslScript()`
 * runs, partitioned into `folds` contiguous chronological slices so a
 * caller can see whether an edge holds up consistently ACROSS TIME rather
 * than being carried by one lucky stretch inside an otherwise flat overall
 * winRate. Never re-evaluates the script per fold (see `fireSignals()`'s
 * own doc comment for why that would also subtly change `since()`/
 * `streak()`'s behavior) - folds are a pure partition of one continuous
 * run's already-fired signals. */
export function backtestMslScriptWalkForward(candles: Candle[], script: string, opts: MslBacktestWalkForwardOpts = {}): MslBacktestWalkForwardResult {
  const expiryBars = Math.max(1, Math.round(opts.expiryBars ?? 3))
  const warmupBars = Math.max(1, Math.round(opts.warmupBars ?? 60))
  const minConfidence = Math.max(0, Math.min(100, opts.minConfidence ?? 0))
  const runId = opts.runId ?? `mslbacktest-wf:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const reads = unavailableReads()
  const payout = opts.payout !== undefined && Number.isFinite(opts.payout) ? Math.max(0, opts.payout) : undefined
  const unavailableSources = applyPayoutRead(reads, payout)
  const emptyWf = (error: string): MslBacktestWalkForwardResult => ({
    ok: false,
    error,
    barsEvaluated: 0,
    unavailableSources,
    overall: breakdownOf([], undefined),
    folds: [],
    winRateStdDev: null,
  })

  const parsed = parseStrategyScript(script)
  if (!parsed.ok) return emptyWf(`script parse error: ${parsed.error}`)
  if (candles.length < warmupBars + expiryBars + 1) {
    return emptyWf(`not enough candles - need at least ${warmupBars + expiryBars + 1} (warmup ${warmupBars} + expiry ${expiryBars} + 1), got ${candles.length}`)
  }

  const lastIdx = candles.length - 1 - expiryBars
  const barsEvaluated = lastIdx - warmupBars + 1
  const folds = Math.max(1, Math.min(barsEvaluated, Math.round(opts.folds ?? 5)))

  const fired = fireSignals(candles, parsed.ast, reads, warmupBars, lastIdx, minConfidence, runId)
  const allTrades = settleFired(fired, candles, expiryBars, payout)
  const overall = breakdownOf(allTrades, payout)

  const foldSize = Math.floor(barsEvaluated / folds)
  const foldResults: MslBacktestFold[] = []
  for (let f = 0; f < folds; f++) {
    const fromIndex = warmupBars + f * foldSize
    const toIndex = f === folds - 1 ? lastIdx : fromIndex + foldSize - 1
    const foldTrades = allTrades.filter((t) => t.index >= fromIndex && t.index <= toIndex)
    const b = breakdownOf(foldTrades, payout)
    foldResults.push({ ...b, foldIndex: f, fromIndex, toIndex, fromTime: candles[fromIndex].time, toTime: candles[toIndex].time })
  }

  return {
    ok: true,
    barsEvaluated,
    unavailableSources,
    overall,
    folds: foldResults,
    winRateStdDev: winRateStdDev(foldResults.map((f) => f.winRate)),
  }
}

export interface MslBacktestCrossAssetOpts extends MslBacktestOpts {}

/** Cross-asset: runs the SAME script, independently, through the plain
 * `backtestMslScript()` engine against each asset's own candle history -
 * the "does this edge generalize, or is it one pair's own quirk" check.
 * Each asset gets its own `runId` derived from the shared base (so their
 * `since()`/`streak()` state never bleeds across assets, even though
 * they're sequential calls in this one process) unless the caller passed
 * an explicit `opts.runId`, in which case that exact id is reused for
 * every asset verbatim (a caller doing that deliberately wants shared
 * state across assets - not this function's default, but not blocked
 * either). */
export function backtestMslScriptCrossAsset(
  assetCandles: Record<string, Candle[]>,
  script: string,
  opts: MslBacktestCrossAssetOpts = {},
): MslBacktestCrossAssetResult {
  const assets = Object.keys(assetCandles)
  const baseRunId = opts.runId
  const perAsset: MslBacktestAssetResult[] = assets.map((asset, i) => {
    const runId = baseRunId ?? `mslbacktest-xasset:${asset}:${Date.now()}:${Math.random().toString(36).slice(2)}:${i}`
    const result = backtestMslScript(assetCandles[asset], script, { ...opts, runId })
    return { asset, result }
  })

  const combinedTrades: MslBacktestTrade[] = []
  for (const { result } of perAsset) if (result.ok) combinedTrades.push(...result.trades)
  const payout = opts.payout !== undefined && Number.isFinite(opts.payout) ? Math.max(0, opts.payout) : undefined
  const combined = breakdownOf(combinedTrades, payout)

  const perAssetWinRates = perAsset.map(({ result }) => (result.ok ? result.winRate : null))

  return {
    ok: perAsset.some((a) => a.result.ok),
    perAsset,
    combined,
    winRateStdDevAcrossAssets: winRateStdDev(perAssetWinRates),
  }
}
