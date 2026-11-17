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

import { beginMslBacktest, endMslBacktest } from './mslai'
import { wilsonLowerBound } from './mslai-stats'
import { setReplayMode } from './timing'
import type { RiskOutcome } from './mslrisk'
import type { Candle, Timeframe } from '../types'
import { parseStrategyScript, evaluateStrategyScript, clearMslState, setRiskSource, type MslSeriesCtx, type MslSourceRead, type MslAst, type MslPosView, type MslDraw } from './strategylang'
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
  /** bars this trade was settled against - only set when the run used the script's own `expiry =` (see `scriptExpiry`) */
  expiryBars?: number
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
  /** present when the script threw on some bars (count of those, the first message with its line, and which bar) - an error never hides silently */
  scriptErrors?: MslScriptErrors
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

function seriesUpTo(candles: Candle[], i: number, partners?: Record<string, Candle[]>): MslSeriesCtx {
  const slice = candles.slice(0, i + 1)
  const tNow = candles[i].time
  return {
    partner: partners
      ? (asset: string): MslSeriesCtx | undefined => {
          const pc = partners[asset]
          if (!pc || !pc.length) return undefined
          // only the partner bars that were already open at the evaluated bar's time: no look-ahead
          let hi = pc.length
          while (hi > 0 && pc[hi - 1].time > tNow) hi--
          if (hi < 40) return undefined
          const ps = pc.slice(0, hi)
          return { open: ps.map((c) => c.open), high: ps.map((c) => c.high), low: ps.map((c) => c.low), close: ps.map((c) => c.close), volume: ps.map((c) => c.volume ?? 0), time: ps.map((c) => c.time) }
        }
      : undefined,
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
  /** the script's own `expiry = <minutes>` for this fire (whole minutes 1-60), when it set one */
  expiryMin?: number
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
function fireSignals(...a: Parameters<typeof fireSignalsInner>): ReturnType<typeof fireSignalsInner> {
  beginMslBacktest()
  try {
    return fireSignalsInner(...a)
  } finally {
    endMslBacktest()
  }
}
/** Cross-timeframe support for a pure candle-array backtest: a `<tf>` argument ("5m", "1h") is answered by AGGREGATING the same candles into that timeframe, and
 * only COMPLETED higher-timeframe bars (their window ended at or before the evaluated bar's close) are visible - no look-ahead. A timeframe that is not a whole
 * multiple of the candle spacing (or is not larger than it) stays unavailable and the call fails closed, exactly as before. */
const TF_SEC: Record<string, number> = { '5s': 5, '10s': 10, '15s': 15, '30s': 30, '1m': 60, '2m': 120, '3m': 180, '5m': 300, '10m': 600, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400 }
let fastFeed: Record<string, Candle[]> | null = null
/** Supply LOWER-timeframe candles (e.g. {"5s": [...]}) so `snr.*`/`fibs.*` can be backtested; only bars that closed at or before the evaluated bar's close are visible. */
export function setBacktestFastFeed(f: Record<string, Candle[]> | null): void { fastFeed = f }
function makeCrossTf(candles: Candle[]): (i: number) => (tf: string) => MslSeriesCtx | undefined {
  let base = Infinity
  for (let i = 1; i < candles.length; i++) { const g = candles[i].time - candles[i - 1].time; if (g > 0 && g < base) base = g }
  type Bucket = { start: number; o: number; h: number; l: number; c: number; v: number }
  const prepared = new Map<string, { sec: number; b: Bucket[]; ptr: number } | null>()
  const prep = (tf: string) => {
    if (prepared.has(tf)) return prepared.get(tf) ?? null
    const sec = TF_SEC[tf]
    if (!sec || !Number.isFinite(base) || sec <= base || sec % base !== 0) { prepared.set(tf, null); return null }
    const b: Bucket[] = []
    for (const k of candles) {
      const start = Math.floor(k.time / sec) * sec
      const last = b[b.length - 1]
      if (last && last.start === start) { last.h = Math.max(last.h, k.high); last.l = Math.min(last.l, k.low); last.c = k.close; last.v += Number.isFinite(k.volume) ? k.volume : 0 } else b.push({ start, o: k.open, h: k.high, l: k.low, c: k.close, v: Number.isFinite(k.volume) ? k.volume : 0 })
    }
    const e = { sec, b, ptr: 0 }
    prepared.set(tf, e)
    return e
  }
  const fastPtr = new Map<string, number>()
  return (i: number) => (tf: string) => {
    const e = prep(tf)
    if (!e) {
      const fc = fastFeed?.[tf]
      const sec = TF_SEC[tf]
      if (!fc || !sec) return undefined
      const nowF = candles[i].time + base
      let p = fastPtr.get(tf) ?? 0
      while (p < fc.length && fc[p].time + sec <= nowF) p++
      fastPtr.set(tf, p)
      if (p === 0) return undefined
      const sl = fc.slice(Math.max(0, p - 2000), p)
      return { open: sl.map((x) => x.open), high: sl.map((x) => x.high), low: sl.map((x) => x.low), close: sl.map((x) => x.close), volume: sl.map((x) => (Number.isFinite(x.volume) ? x.volume : 0)), time: sl.map((x) => x.time) }
    }
    const now = candles[i].time + base
    while (e.ptr < e.b.length && e.b[e.ptr].start + e.sec <= now) e.ptr++
    if (e.ptr === 0) return undefined
    const sl = e.b.slice(0, e.ptr)
    return { open: sl.map((x) => x.o), high: sl.map((x) => x.h), low: sl.map((x) => x.l), close: sl.map((x) => x.c), volume: sl.map((x) => x.v), time: sl.map((x) => x.start) }
  }
}

/** script errors seen by the LAST fireSignalsInner run - every evaluation that threw used to be skipped silently */
export interface MslScriptErrors { count: number; evaluated: number; first: string; firstBarIndex: number }
let lastFireErrors: MslScriptErrors | undefined
function fireSignalsInner(
  candles: Candle[],
  parsedAst: MslAst,
  reads: Record<string, MslSourceRead>,
  warmupBars: number,
  lastIdx: number,
  minConfidence: number,
  runId: string,
  partners?: Record<string, Candle[]>,
): FiredSignal[] {
  const fired: FiredSignal[] = []
  const crossTf = makeCrossTf(candles)
  lastFireErrors = undefined
  let errCount = 0, evaluated = 0, firstErr = '', firstErrBar = -1
  try {
    for (let i = warmupBars; i <= lastIdx; i++) {
      const series = seriesUpTo(candles, i, partners)
      const seriesFor = crossTf(i)
      const state = { keyPrefix: runId, barTimeSec: candles[i].time }
      const out = evaluateStrategyScript(parsedAst, reads, undefined, series, seriesFor, undefined, state)
      evaluated++
      if (out.error) { if (!errCount++) { firstErr = out.error; firstErrBar = i } continue }
      if (out.direction === 'none') continue
      if (out.confidence < minConfidence) continue
      fired.push({ index: i, direction: out.direction, confidence: out.confidence, ...(out.expiryMin !== undefined ? { expiryMin: out.expiryMin } : {}) })
    }
  } finally {
    clearMslState(runId)
  }
  if (errCount) lastFireErrors = { count: errCount, evaluated, first: firstErr, firstBarIndex: firstErrBar }
  return fired
}

/** Settle a fired-signal list against ONE bars-ahead horizon - the same
 * binary settlement rule the module header documents (flat = loss). Shared
 * by every caller below so the settlement math can never drift between
 * the plain/walk-forward/cross-asset entry points. */
function settleFired(fired: FiredSignal[], candles: Candle[], bars: number, payout: number | undefined, scriptExpiry?: MslScriptExpiry): MslBacktestTrade[] {
  const out: MslBacktestTrade[] = []
  for (const f of fired) {
    // per-signal horizon: the script's own `expiry = <minutes>` converted to bars of this series, else the run's fixed horizon
    const own = scriptExpiry && f.expiryMin !== undefined ? Math.max(1, Math.round((f.expiryMin * 60) / scriptExpiry.barSeconds)) : undefined
    const h = own ?? bars
    if (f.index + h > candles.length - 1) continue
    const entry = candles[f.index].close
    const exit = candles[f.index + h].close
    const delta = exit - entry
    const win = f.direction === 'call' ? delta > 0 : delta < 0
    const trade: MslBacktestTrade = { index: f.index, time: candles[f.index].time, direction: f.direction, confidence: f.confidence, entry, exit, win }
    if (own !== undefined) trade.expiryBars = own
    if (payout !== undefined) trade.pnl = win ? payout : -1
    out.push(trade)
  }
  return out
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
  /** `smt.*`: the PARTNER pairs' candles by ticker (same timeframe as `candles`). Each evaluated bar only ever sees partner bars already open at its
   * time. Single-asset backtests only - walk-forward / cross-asset runs do not forward it, so a script using smt.* fails closed there. */
  partners?: Record<string, Candle[]>
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
  /** settle each fire against the horizon the SCRIPT itself asked for (`expiry = <minutes>`, converted with `barSeconds`), falling back to `expiryBars`
   * for a fire whose script set none. `maxBars` (default 15) is the longest horizon the run reserves history for: a fire asking for more is
   * settled only if its forward bar exists, else excluded (never fabricated). Without this the script's `expiry` is ignored, as before. */
  scriptExpiry?: MslScriptExpiry
}

export interface MslScriptExpiry {
  /** seconds per bar of the candle series (TIMEFRAME_SECONDS[tf]) */
  barSeconds: number
  maxBars?: number
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
  const scriptExpiry = opts.scriptExpiry && Number.isFinite(opts.scriptExpiry.barSeconds) && opts.scriptExpiry.barSeconds > 0 ? opts.scriptExpiry : undefined
  const scriptMaxBars = scriptExpiry ? Math.max(1, Math.round(scriptExpiry.maxBars ?? 15)) : 1
  const maxExpiryNeeded = Math.max(expiryBars, ...expiryBarsList, scriptMaxBars, 1)
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
  const fired = fireSignals(candles, parsed.ast, reads, warmupBars, lastIdx, minConfidence, runId, opts.partners)

  const settle = (bars: number, own?: MslScriptExpiry): MslBacktestTrade[] => settleFired(fired, candles, bars, payout, own)

  const trades = settle(expiryBars, scriptExpiry)
  const { wins, losses, winRate, avgConfidence } = breakdownOf(trades, payout)

  const result: MslBacktestResult = { ok: true, barsEvaluated: lastIdx - warmupBars + 1, trades, wins, losses, winRate, avgConfidence, unavailableSources }
  const fe = lastFireErrors as MslScriptErrors | undefined
  if (fe) {
    result.scriptErrors = fe
    // erroring on EVERY bar is a broken script, not "no signals" - fail loudly instead of reporting a clean zero-trade run
    if (fe.count >= fe.evaluated) { result.ok = false; result.error = `the script failed on every bar (${fe.count}/${fe.evaluated}): ${fe.first}` }
  }

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
  const scriptExpiry = opts.scriptExpiry && Number.isFinite(opts.scriptExpiry.barSeconds) && opts.scriptExpiry.barSeconds > 0 ? opts.scriptExpiry : undefined
  const horizon = Math.max(expiryBars, scriptExpiry ? Math.max(1, Math.round(scriptExpiry.maxBars ?? 15)) : 1)
  if (candles.length < warmupBars + horizon + 1) {
    return emptyWf(`not enough candles - need at least ${warmupBars + horizon + 1} (warmup ${warmupBars} + expiry ${horizon} + 1), got ${candles.length}`)
  }

  const lastIdx = candles.length - 1 - horizon
  const barsEvaluated = lastIdx - warmupBars + 1
  const folds = Math.max(1, Math.min(barsEvaluated, Math.round(opts.folds ?? 5)))

  const fired = fireSignals(candles, parsed.ast, reads, warmupBars, lastIdx, minConfidence, runId)
  const allTrades = settleFired(fired, candles, expiryBars, payout, scriptExpiry)
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


// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// REPLAY TESTER - walks REAL fast (5s) bars with an explicit clock, the way Meta Trader would see the script live:
//   * the script is evaluated every `stepSec` (default 10, Meta Trader's poll) with now = that moment, the newest closed fast bar's close as the tick price, the closed trading-chart bars,
//     the closed fast bars (seriesFor(fastTf)) and the higher timeframes aggregated from the trading chart (completed bars only - no look-ahead);
//   * a signal is taken on its FIRST evaluation (a held direction does not re-fire until it lapses = Meta Trader's fresh-edge gate), one open trade at a time, entered at the newest fast close and
//     settled at the first fast close at or after entry + expirySec (flat = loss), payout default 0.85;
//   * so `timing.hold(...)` and `risk.*` run for real here (risk.* sees only trades already settled at the evaluated moment);
//   * `holdBypass: true` makes every hold act at ARM time instead of waiting - run the same script both ways to measure whether the wait helps.
// Needs fast candles for the period; data gaps (> 3 fast bars) split it into segments that are never evaluated across. Honest limits: a signal fills at the last closed fast close (no slippage
// model), the 10 s cadence is a simulation of the live poll, and `signal.*`/`smc.*` sources still read as unavailable exactly as in the candle backtester.
export interface MslReplayOpts { fastTf?: string; stepSec?: number; expirySec?: number; warmupBars?: number; payout?: number; holdBypass?: boolean; runId?: string; maxEvals?: number; minConfidence?: number }
export interface MslReplayTrade { time: number; direction: 'call' | 'put'; confidence: number; entry: number; exit: number; win: boolean; pnl: number }
export interface MslReplayResult {
  ok: boolean
  error?: string
  evals: number
  segments: number
  truncated: boolean
  trades: MslReplayTrade[]
  wins: number
  losses: number
  winRate: number | null
  wilsonLow: number
  breakEven: number
  netPnl: number
  firstHalf: { n: number; wins: number }
  secondHalf: { n: number; wins: number }
  fastBars: number
}
export function replayMslScript(base: Candle[], fast: Candle[], script: string, opts: MslReplayOpts = {}): MslReplayResult {
  const fastTf = opts.fastTf ?? '5s'
  const fs = TF_SEC[fastTf]
  const stepSec = Math.max(fs ?? 5, Math.round(opts.stepSec ?? 10))
  const expirySec = Math.max(5, Math.round(opts.expirySec ?? 60))
  const warmupBars = Math.max(20, Math.round(opts.warmupBars ?? 40))
  const payout = opts.payout !== undefined && Number.isFinite(opts.payout) && opts.payout > 0 ? opts.payout : 0.85
  const maxEvals = Math.max(100, Math.round(opts.maxEvals ?? 60_000))
  const minConf = Math.max(0, Math.min(100, opts.minConfidence ?? 0))
  const runId = opts.runId ?? `replay:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const be = 1 / (1 + payout)
  const fail = (error: string): MslReplayResult => ({ ok: false, error, evals: 0, segments: 0, truncated: false, trades: [], wins: 0, losses: 0, winRate: null, wilsonLow: 0, breakEven: be, netPnl: 0, firstHalf: { n: 0, wins: 0 }, secondHalf: { n: 0, wins: 0 }, fastBars: fast.length })
  if (!fs) return fail(`unknown fast timeframe "${fastTf}"`)
  if (base.length < warmupBars + 5) return fail(`need at least ${warmupBars + 5} trading-chart bars, got ${base.length}`)
  if (fast.length < 200) return fail(`need at least 200 ${fastTf} bars, got ${fast.length}`)
  const parsed = parseStrategyScript(script)
  if (!parsed.ok) return fail(`script parse error: ${parsed.error}`)
  let bs = Infinity
  for (let i = 1; i < base.length; i++) { const g = base[i].time - base[i - 1].time; if (g > 0 && g < bs) bs = g }
  if (!Number.isFinite(bs)) return fail('cannot determine the trading-chart bar spacing')
  const reads = unavailableReads()
  applyPayoutRead(reads, payout)
  // contiguous fast segments
  const segs: Candle[][] = []
  let cur: Candle[] = []
  for (const c of fast) { if (cur.length && c.time - cur[cur.length - 1].time > fs * 3) { segs.push(cur); cur = [] } cur.push(c) }
  if (cur.length) segs.push(cur)
  const trades: MslReplayTrade[] = []
  const outcomes: RiskOutcome[] = []
  let evals = 0
  let truncated = false
  let usedSegs = 0
  beginMslBacktest()
  setReplayMode(true, !!opts.holdBypass)
  setRiskSource(() => outcomes)
  try {
    for (const seg of segs) {
      if (seg.length < 100) continue
      const t0 = seg[0].time, t1 = seg[seg.length - 1].time + fs
      const bseg = base.filter((c) => c.time >= t0 - bs && c.time + bs <= t1)
      if (bseg.length < warmupBars + 2) continue
      usedSegs++
      const crossTf = makeCrossTf(bseg)
      let bi = 0 // number of closed base bars
      let busyUntil = -Infinity
      let prevDir: string = 'none'
      const stepBars = Math.max(1, Math.round(stepSec / fs))
      for (let k = 100; k < seg.length; k += stepBars) {
        if (evals >= maxEvals) { truncated = true; break }
        const T = seg[k].time + fs
        while (bi < bseg.length && bseg[bi].time + bs <= T) bi++
        if (bi < warmupBars) continue
        if (T + expirySec > t1) break
        const iLast = bi - 1
        const lo = Math.max(0, iLast - 599)
        const bs_ = bseg.slice(lo, iLast + 1)
        const series: MslSeriesCtx = { open: bs_.map((c) => c.open), high: bs_.map((c) => c.high), low: bs_.map((c) => c.low), close: bs_.map((c) => c.close), volume: bs_.map((c) => c.volume ?? 0), time: bs_.map((c) => c.time) }
        const fl = seg.slice(Math.max(0, k - 1999), k + 1)
        const fastSeries: MslSeriesCtx = { open: fl.map((c) => c.open), high: fl.map((c) => c.high), low: fl.map((c) => c.low), close: fl.map((c) => c.close), volume: fl.map((c) => c.volume ?? 0), time: fl.map((c) => c.time) }
        const cross = crossTf(iLast)
        const seriesFor = (tf: string): MslSeriesCtx | undefined => (tf === fastTf ? fastSeries : cross(tf))
        const nowMs = T * 1000
        evals++
        const out = evaluateStrategyScript(parsed.ast, reads, undefined, series, seriesFor, { nowMs, ticks: [{ ts: nowMs, price: seg[k].close }] }, { keyPrefix: runId, barTimeSec: bseg[iLast].time })
        const dir = out.error ? 'none' : out.direction
        const fresh = dir !== 'none' && dir !== prevDir
        prevDir = dir
        if (!fresh || out.confidence < minConf || T < busyUntil) continue
        // settle at the first fast close at or after T + expiry
        let j = k
        while (j < seg.length && seg[j].time + fs < T + expirySec) j++
        if (j >= seg.length) break
        const entry = seg[k].close, exit = seg[j].close
        const win = dir === 'call' ? exit > entry : exit < entry
        const settledAt = seg[j].time + fs
        busyUntil = settledAt
        trades.push({ time: T, direction: dir as 'call' | 'put', confidence: out.confidence, entry, exit, win, pnl: win ? payout : -1 })
        outcomes.push({ ts: settledAt * 1000, win, units: win ? payout : -1 })
      }
      clearMslState(runId)
      if (truncated) break
    }
  } finally {
    setRiskSource(null)
    setReplayMode(false)
    endMslBacktest()
    clearMslState(runId)
  }
  const wins = trades.filter((t) => t.win).length
  const mid = trades.length ? trades[Math.floor(trades.length / 2)].time : 0
  const h1 = trades.filter((t) => t.time < mid), h2 = trades.filter((t) => t.time >= mid)
  return {
    ok: true, evals, segments: usedSegs, truncated, trades, wins, losses: trades.length - wins,
    winRate: trades.length ? wins / trades.length : null,
    wilsonLow: wilsonLowerBound(wins, trades.length), breakEven: be,
    netPnl: trades.reduce((a, t) => a + t.pnl, 0),
    firstHalf: { n: h1.length, wins: h1.filter((t) => t.win).length }, secondHalf: { n: h2.length, wins: h2.filter((t) => t.win).length },
    fastBars: fast.length,
  }
}


// =====================================================================================================================
// MANAGED-TRADE BACKTEST - stop-loss, take-profit, trailing stop, break-even, partial exits, scaling in / multiple
// positions, and "hold until <condition>" dynamic exits. A binary option has none of these (fixed expiry, all-or-nothing),
// so this is a SIMULATION of price-based trade management on the candle series: it measures what a script's exits would
// have done, in price / R terms. HONEST LIMITS: fills are modelled on candle OHLC (stop checked before target when a bar
// touches both; a gap through a level fills at the open); there is no spread or slippage unless `slipAtr` is given; and the
// IQ Option binary product cannot be exited early at a price, so these exits only become tradable on an instrument that allows
// it (forex/CFD margin or digital sell). `pnl` per trade is the binary-equivalent (win +payout / loss -1) for comparison only.
// =====================================================================================================================
export interface MslManagedOpts {
  warmupBars?: number
  minConfidence?: number
  runId?: string
  /** longest a position may stay open (bars) - the time stop used when the script gives no `expiry =`; default 120 */
  maxBars?: number
  /** concurrent positions allowed (a script's `pos.max = n` overrides); default 1 */
  maxPositions?: number
  /** seconds per bar - lets a script's `expiry = <minutes>` act as the time stop */
  barSeconds?: number
  payout?: number
  /** price slippage charged on every fill, in ATR14 units (default 0) */
  slipAtr?: number
}
export interface MslManagedPart { index: number; price: number; frac: number; reason: string }
export interface MslManagedTrade {
  id: number
  index: number
  time: number
  direction: 'call' | 'put'
  confidence: number
  entry: number
  size: number
  /** index/price/time of the final fill */
  exitIndex: number
  exit: number
  bars: number
  /** why the LAST part closed: stop | target | exit | time | end */
  reason: string
  parts: MslManagedPart[]
  /** price pnl per unit, summed over partial exits by fraction (positive = in the trade's favour) */
  pnlPrice: number
  /** pnlPrice / initial risk (|entry - first stop|) - absent when the trade never had a stop */
  r?: number
  win: boolean
  /** binary-equivalent pnl x size (comparison only - see the section header) */
  pnl?: number
  initStop?: number
}
export interface MslManagedResult {
  ok: boolean
  error?: string
  barsEvaluated: number
  trades: MslManagedTrade[]
  wins: number
  losses: number
  winRate: number | null
  /** sum of pnlPrice / sum of |losses| (null when there are no losing trades) */
  profitFactor: number | null
  avgBars: number | null
  /** R-multiple stats over the trades that had a stop */
  rTrades: number
  expectancyR: number | null
  netR: number | null
  maxDrawdownR: number | null
  byReason: Record<string, number>
  netPnl?: number
  /** the last evaluation's chart overlays, so a caller can draw what the script drew */
  draws?: MslDraw[]
  skippedBadLevels: number
  scriptErrors?: MslScriptErrors
  execution: 'simulated-managed'
  note: string
}

export function backtestMslManaged(candles: Candle[], script: string, opts: MslManagedOpts = {}): MslManagedResult {
  const warmupBars = Math.max(1, Math.round(opts.warmupBars ?? 60))
  const minConfidence = Math.max(0, Math.min(100, opts.minConfidence ?? 0))
  const runId = opts.runId ?? `mslmanaged:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const maxBarsDefault = Math.max(1, Math.round(opts.maxBars ?? 120))
  const maxPosDefault = Math.max(1, Math.round(opts.maxPositions ?? 1))
  const payout = opts.payout !== undefined && Number.isFinite(opts.payout) ? Math.max(0, opts.payout) : undefined
  const slipAtr = Math.max(0, opts.slipAtr ?? 0)
  const note = 'Simulated price-based exits on candle OHLC: not what a fixed-expiry binary option can do. Stop is checked before target when one bar touches both; gaps fill at the open.'
  const fail = (error: string): MslManagedResult => ({ ok: false, error, barsEvaluated: 0, trades: [], wins: 0, losses: 0, winRate: null, profitFactor: null, avgBars: null, rTrades: 0, expectancyR: null, netR: null, maxDrawdownR: null, byReason: {}, skippedBadLevels: 0, execution: 'simulated-managed', note })
  const parsed = parseStrategyScript(script)
  if (!parsed.ok) return fail(`script parse error: ${parsed.error}`)
  if (candles.length < warmupBars + 5) return fail(`not enough candles - need at least ${warmupBars + 5}, got ${candles.length}`)
  const reads = unavailableReads()
  applyPayoutRead(reads, payout)
  const crossTf = makeCrossTf(candles)

  interface Pos extends MslPosView { openIdx: number; confidence: number; maxBars: number; parts: MslManagedPart[]; dirName: 'call' | 'put'; trailStep: number; be: number }
  const open: Pos[] = []
  const trades: MslManagedTrade[] = []
  let nextId = 1, skipped = 0, lastDraws: MslDraw[] | undefined, lastErr: string | undefined, errCount = 0, evalCount = 0, firstErr = '', firstErrBar = -1
  const atrAt = (i: number): number => { let sum = 0, n = 0; for (let k = Math.max(1, i - 13); k <= i; k++) { sum += Math.max(candles[k].high - candles[k].low, Math.abs(candles[k].high - candles[k - 1].close), Math.abs(candles[k].low - candles[k - 1].close)); n++ } return n ? sum / n : 0 }
  const fill = (p: Pos, i: number, price: number, frac: number, reason: string): void => {
    const slip = slipAtr * atrAt(i)
    const px = p.dir > 0 ? price - slip : price + slip
    const f = Math.min(frac, p.left)
    if (f <= 1e-9) return
    p.parts.push({ index: i, price: px, frac: f, reason })
    p.left = Math.max(0, p.left - f)
    if (p.left <= 1e-9) {
      p.left = 0
      const pnlPrice = p.parts.reduce((a, q) => a + q.frac * p.dir * (q.price - p.entry), 0)
      const risk = Number.isFinite(p.initStop) ? Math.abs(p.entry - p.initStop) : NaN
      const t: MslManagedTrade = { id: p.id, index: p.openIdx, time: candles[p.openIdx].time, direction: p.dirName, confidence: p.confidence, entry: p.entry, size: p.size, exitIndex: i, exit: px, bars: i - p.openIdx, reason, parts: p.parts, pnlPrice, win: pnlPrice > 0 }
      if (risk > 0) { t.r = pnlPrice / risk; t.initStop = p.initStop }
      if (payout !== undefined) t.pnl = (t.win ? payout : -1) * p.size
      trades.push(t)
      open.splice(open.indexOf(p), 1)
    }
  }
  const sane = (dir: 1 | -1, entry: number, stop: number, target: number): [number, number] => {
    let st = stop, tg = target
    if (Number.isFinite(st) && !(dir > 0 ? st < entry : st > entry)) { st = NaN; skipped++ }
    if (Number.isFinite(tg) && !(dir > 0 ? tg > entry : tg < entry)) { tg = NaN; skipped++ }
    return [st, tg]
  }

  beginMslBacktest()
  try {
    for (let i = warmupBars; i < candles.length; i++) {
      const c = candles[i]
      // 1) price action on bar i against the levels set at earlier closes
      for (const p of open.slice()) {
        p.bars = i - p.openIdx
        const hitStop = Number.isFinite(p.stop) && (p.dir > 0 ? c.low <= p.stop : c.high >= p.stop)
        const hitTgt = Number.isFinite(p.target) && (p.dir > 0 ? c.high >= p.target : c.low <= p.target)
        if (hitStop) { fill(p, i, p.dir > 0 ? Math.min(c.open, p.stop) : Math.max(c.open, p.stop), p.left, 'stop'); continue }
        if (hitTgt) { fill(p, i, p.dir > 0 ? Math.max(c.open, p.target) : Math.min(c.open, p.target), p.left, 'target'); continue }
        p.best = p.dir > 0 ? Math.max(p.best, c.high) : Math.min(p.best, c.low)
        p.worst = p.dir > 0 ? Math.min(p.worst, c.low) : Math.max(p.worst, c.high)
        if (Number.isFinite(p.trail) && p.trail > 0) { const ns = p.dir > 0 ? p.best - p.trail : p.best + p.trail; if (!Number.isFinite(p.stop) || (p.dir > 0 ? ns > p.stop : ns < p.stop)) p.stop = ns }
        if (Number.isFinite(p.be) && p.dir * (p.best - p.entry) >= p.be) { if (!Number.isFinite(p.stop) || (p.dir > 0 ? p.entry > p.stop : p.entry < p.stop)) p.stop = p.entry }
        if (p.bars >= p.maxBars) fill(p, i, c.close, p.left, 'time')
      }
      // 2) the script, once, at this close
      const series = seriesUpToManaged(candles, i)
      const views: MslPosView[] = open.map((p) => ({ id: p.id, dir: p.dir, entry: p.entry, bars: p.bars, best: p.best, worst: p.worst, left: p.left, stop: p.stop, target: p.target, trail: p.trail, size: p.size, initStop: p.initStop }))
      const out = evaluateStrategyScript(parsed.ast, reads, undefined, series, crossTf(i), undefined, { keyPrefix: runId, barTimeSec: c.time }, { positions: views })
      evalCount++
      if (out.error) { lastErr = out.error; if (!errCount++) { firstErr = out.error; firstErrBar = i } continue }
      if (out.draws) lastDraws = out.draws
      for (const u of out.posUpdates ?? []) {
        const p = open.find((q) => q.id === u.id); if (!p) continue
        // a stop only ever TIGHTENS (moves toward price) once set - re-evaluating `pos.stop = ...` every bar can ratchet it but never loosen it
        if (u.stop !== undefined && (!Number.isFinite(p.stop) || (p.dir > 0 ? u.stop > p.stop : u.stop < p.stop))) p.stop = u.stop
        if (u.target !== undefined) p.target = u.target
        if (u.trail !== undefined) p.trail = u.trail
        if (u.breakeven !== undefined) p.be = u.breakeven
      }
      for (const x of out.exits ?? []) { const p = open.find((q) => q.id === x.id); if (p) fill(p, i, c.close, x.frac >= 0.999999 ? p.left : x.frac * p.left, 'exit') }
      // 3) a new entry
      if (out.direction !== 'none' && out.confidence >= minConfidence && i < candles.length - 1) {
        const maxPos = Math.max(1, Math.round(out.entry?.max ?? maxPosDefault))
        const dirName = out.direction
        const dir: 1 | -1 = dirName === 'call' ? 1 : -1
        if (open.length < maxPos && open.every((q) => q.dir === dir)) {
          const [stop, target] = sane(dir, c.close, out.entry?.stop ?? NaN, out.entry?.target ?? NaN)
          const tm = out.expiryMin !== undefined && opts.barSeconds ? Math.max(1, Math.round((out.expiryMin * 60) / opts.barSeconds)) : maxBarsDefault
          open.push({ id: nextId++, dir, dirName, entry: c.close, bars: 0, best: c.close, worst: c.close, left: 1, stop, target, trail: out.entry?.trail ?? NaN, size: out.entry?.size && out.entry.size > 0 ? out.entry.size : 1, initStop: stop, openIdx: i, confidence: out.confidence, maxBars: tm, parts: [], trailStep: 0, be: out.entry?.breakeven ?? NaN })
        }
      }
    }
    for (const p of open.slice()) fill(p, candles.length - 1, candles[candles.length - 1].close, p.left, 'end')
  } finally {
    endMslBacktest()
    clearMslState(runId)
  }
  trades.sort((a, b) => a.index - b.index || a.id - b.id)
  const wins = trades.filter((t) => t.win).length
  const gain = trades.filter((t) => t.pnlPrice > 0).reduce((a, t) => a + t.pnlPrice * t.size, 0)
  const loss = trades.filter((t) => t.pnlPrice < 0).reduce((a, t) => a + Math.abs(t.pnlPrice) * t.size, 0)
  const rs = trades.filter((t) => t.r !== undefined).map((t) => (t.r as number) * t.size)
  let cum = 0, peak = 0, dd = 0
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum) }
  const byReason: Record<string, number> = {}
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1
  const res: MslManagedResult = {
    ok: true, barsEvaluated: candles.length - warmupBars, trades, wins, losses: trades.length - wins, winRate: trades.length ? wins / trades.length : null,
    profitFactor: loss > 0 ? gain / loss : null, avgBars: trades.length ? trades.reduce((a, t) => a + t.bars, 0) / trades.length : null,
    rTrades: rs.length, expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, netR: rs.length ? rs.reduce((a, b) => a + b, 0) : null, maxDrawdownR: rs.length ? dd : null,
    byReason, skippedBadLevels: skipped, execution: 'simulated-managed', note,
  }
  if (payout !== undefined) res.netPnl = trades.reduce((a, t) => a + (t.pnl ?? 0), 0)
  if (lastDraws) res.draws = lastDraws
  if (errCount) {
    res.scriptErrors = { count: errCount, evaluated: evalCount, first: firstErr, firstBarIndex: firstErrBar }
    if (errCount >= evalCount) { res.ok = false; res.error = `the script failed on every bar (${errCount}/${evalCount}): ${firstErr}` }
    else if (!trades.length) res.error = `no trades; the script errored on ${errCount} of ${evalCount} bars, first: ${firstErr}`
  }
  return res
}
/** series up to bar i for the managed loop - same shape fireSignalsInner uses, trimmed to the last 1500 bars so a long run stays fast */
function seriesUpToManaged(candles: Candle[], i: number): MslSeriesCtx {
  const lo = Math.max(0, i + 1 - 1500)
  const sl = candles.slice(lo, i + 1)
  return { open: sl.map((c) => c.open), high: sl.map((c) => c.high), low: sl.map((c) => c.low), close: sl.map((c) => c.close), volume: sl.map((c) => c.volume ?? 0), time: sl.map((c) => c.time) }
}
