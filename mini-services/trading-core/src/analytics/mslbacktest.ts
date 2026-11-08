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
}

export function backtestMslScript(candles: Candle[], script: string, opts: MslBacktestOpts = {}): MslBacktestResult {
  const expiryBars = Math.max(1, Math.round(opts.expiryBars ?? 3))
  const warmupBars = Math.max(1, Math.round(opts.warmupBars ?? 60))
  const minConfidence = Math.max(0, Math.min(100, opts.minConfidence ?? 0))
  const runId = opts.runId ?? `mslbacktest:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const reads = unavailableReads()
  const unavailableSources = Object.keys(reads)
  const empty = (error: string): MslBacktestResult => ({ ok: false, error, barsEvaluated: 0, trades: [], wins: 0, losses: 0, winRate: null, avgConfidence: null, unavailableSources })

  const parsed = parseStrategyScript(script)
  if (!parsed.ok) return empty(`script parse error: ${parsed.error}`)
  if (candles.length < warmupBars + expiryBars + 1) {
    return empty(`not enough candles - need at least ${warmupBars + expiryBars + 1} (warmup ${warmupBars} + expiry ${expiryBars} + 1), got ${candles.length}`)
  }

  const trades: MslBacktestTrade[] = []
  const lastIdx = candles.length - 1 - expiryBars
  try {
    for (let i = warmupBars; i <= lastIdx; i++) {
      const series = seriesUpTo(candles, i)
      const seriesFor = (_tf: string): MslSeriesCtx | undefined => undefined // no cross-timeframe history available to a pure candle-array backtest
      const state = { keyPrefix: runId, barTimeSec: candles[i].time }
      const out = evaluateStrategyScript(parsed.ast, reads, undefined, series, seriesFor, undefined, state)
      if (out.error || out.direction === 'none') continue
      if (out.confidence < minConfidence) continue
      const entry = candles[i].close
      const exit = candles[i + expiryBars].close
      const delta = exit - entry
      const win = out.direction === 'call' ? delta > 0 : delta < 0
      trades.push({ index: i, time: candles[i].time, direction: out.direction, confidence: out.confidence, entry, exit, win })
    }
  } finally {
    clearMslState(runId)
  }

  const wins = trades.filter((t) => t.win).length
  const losses = trades.length - wins
  const winRate = trades.length ? wins / trades.length : null
  const avgConfidence = trades.length ? trades.reduce((s, t) => s + t.confidence, 0) / trades.length : null
  return { ok: true, barsEvaluated: lastIdx - warmupBars + 1, trades, wins, losses, winRate, avgConfidence, unavailableSources }
}
