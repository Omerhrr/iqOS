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
import { parseStrategyScript, evaluateStrategyScript, clearMslState, type MslSeriesCtx, type MslSourceRead } from './strategylang'
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

function seriesUpTo(candles: Candle[], i: number): MslSeriesCtx {
  const slice = candles.slice(0, i + 1)
  return {
    open: slice.map((c) => c.open),
    high: slice.map((c) => c.high),
    low: slice.map((c) => c.low),
    close: slice.map((c) => c.close),
    volume: slice.map((c) => c.volume ?? 0),
  }
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
}

export function backtestMslScript(candles: Candle[], script: string, opts: MslBacktestOpts = {}): MslBacktestResult {
  const expiryBars = Math.max(1, Math.round(opts.expiryBars ?? 3))
  const warmupBars = Math.max(1, Math.round(opts.warmupBars ?? 60))
  const minConfidence = Math.max(0, Math.min(100, opts.minConfidence ?? 0))
  const runId = opts.runId ?? `mslbacktest:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const reads = unavailableReads()
  const unavailableSources = Object.keys(reads)
  const payout = opts.payout !== undefined && Number.isFinite(opts.payout) ? Math.max(0, opts.payout) : undefined
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
  const fired: { index: number; direction: 'call' | 'put'; confidence: number }[] = []
  const lastIdx = candles.length - 1 - maxExpiryNeeded
  try {
    for (let i = warmupBars; i <= lastIdx; i++) {
      const series = seriesUpTo(candles, i)
      const seriesFor = (_tf: string): MslSeriesCtx | undefined => undefined // no cross-timeframe history available to a pure candle-array backtest
      const state = { keyPrefix: runId, barTimeSec: candles[i].time }
      const out = evaluateStrategyScript(parsed.ast, reads, undefined, series, seriesFor, undefined, state)
      if (out.error || out.direction === 'none') continue
      if (out.confidence < minConfidence) continue
      fired.push({ index: i, direction: out.direction, confidence: out.confidence })
    }
  } finally {
    clearMslState(runId)
  }

  const settle = (bars: number): MslBacktestTrade[] =>
    fired
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

  const trades = settle(expiryBars)
  const wins = trades.filter((t) => t.win).length
  const losses = trades.length - wins
  const winRate = trades.length ? wins / trades.length : null
  const avgConfidence = trades.length ? trades.reduce((s, t) => s + t.confidence, 0) / trades.length : null

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
      const w = ts.filter((t) => t.win).length
      const entry: MslBacktestExpiryBreakdown = { expiryBars: bars, trades: ts.length, wins: w, losses: ts.length - w, winRate: ts.length ? w / ts.length : null }
      if (payout !== undefined && ts.length) entry.expectancy = ts.reduce((s, t) => s + (t.pnl ?? 0), 0) / ts.length
      return entry
    })
  }

  return result
}
