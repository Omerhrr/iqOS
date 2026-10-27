// IQAIR//OS - Autopilot plugin
// Strategy bots that close the loop: evaluate a registered strategy on every
// closed candle across a watchlist, apply strict filters (score, direction,
// regime, cooldown, concurrency, daily targets) and execute through the
// broker. The global risk manager in ExecutionService remains the final gate,
// so kill switch / daily loss / max stake always outrank any bot.

import type { Position, Timeframe, TradeKind } from '../types'
import type { KernelContext, Plugin } from '../kernel'
import type { MarketDataService } from './market-data'
import type { AnalyticsService } from './analytics'
import type { ExecutionService } from './execution'
import { Store } from '../store'
import { getStrategy, defaultParams } from '../strategies/builtin'
import type { StrategyLabService } from './lab'
import { classifyRegime } from '../analytics/regime'
import { classifySession } from '../analytics/session'
import { walkForward } from '../strategies/optimize'
import type { GlobalScanRow, GlobalScanResult } from './nextcandle'

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
  /** Explicit time expiry in seconds (e.g. 900 = 15 minutes) for digital/
   * blitz bots - independent of the timeframe, settles at an exact
   * timestamp. Undefined = kind default (5m for digital, 15s for blitz). */
  expirySec?: number
  /** Trading-session filter: only open trades inside the window (UTC).
   * 'overlap' = London x New York 13:00-17:00 UTC. Undefined/'all' = 24h. */
  session?: SessionFilter
  minScore: number
  direction: 'both' | 'call' | 'put'
  /** 'trend'/'range' now check the same 4-way TRENDING/RANGING/VOLATILE/MIXED
   * classification the copilot's regime_playbook tool surfaces (adx + Hurst +
   * garch-vs-ewma vol), not just the coarser Markov bull/bear/range/chop read
   * this used to use. 'avoid-volatile' allows any direction but blocks entries
   * while a vol spike is active (garchVol > 1.6x ewmaVol) - for bots that
   * don't care about trend vs range but shouldn't trade through a shock. */
  regime: 'all' | 'trend' | 'range' | 'avoid-volatile'
  maxOpen: number
  cooldownSec: number
  /** Adaptive confidence gate: before executing, check this exact
   * (asset, tf, strategyId, side, score-bucket[, regime]) bucket's OWN
   * realized win rate (Wilson lower bound) against the fleet floor - trade
   * only in conditions this bot has PROVEN out for itself. Undefined/true =
   * on (fleet default from adaptive.configure() still applies); false = this
   * bot opts out entirely. */
  adaptive?: boolean
  dailyProfitTarget?: number
  dailyLossLimit?: number
  /** Money-management plan. 'fixed' (default/undefined) always bets `stake`.
   * 'compound' rolls a pot that starts at `base` (e.g. $1): every win folds the
   * payout into the pot - the seed stake compounded to the nth win. */
  stakePlan?: StakePlan
  /** Persisted roll state (pot/rollN/restarts/halted) - written by the
   * autopilot on every settle so the compounding streak survives restarts. */
  planState?: { pot: number; rollN: number; restarts: number; reseedCount?: number; lossReseedCount?: number; halted?: boolean; complete?: boolean }
  /** Set when this bot was armed with force:true past a failing research
   * gate - kept visible everywhere the fleet is listed so an unvalidated
   * edge never quietly looks the same as a validated one. */
  forcedUnvalidated?: boolean
  /** PAYOUT FLOOR (the EV gate): skip this bot's signals on any pair whose
   * LIVE payout for the bot's kind is below this percent. The one lever our
   * own research (Tasks 50-54) says moves expected value: breakeven at
   * payout p is 1/(1+p) - 54.9% at 82%, 60.6% at 65% - and payouts MOVE per
   * pair per hour, so a setup worth taking at open can be pure house-edge
   * by the time the next candle closes. 0/undefined = gate off. Clamped
   * 0..98 (real IQ payouts top out in the mid-90s). */
  minPayoutPct?: number
  /** Self-benching on a losing run: after 3 consecutive losses the bot
   * benches ITSELF for 15 minutes (doubling per extra loss, capped at 4h),
   * independent of the watchdog ladder (which needs an operator ack) and
   * the daily $ limits (which only see aggregate P&L). Clears itself when
   * the bench expires - a win at any point also clears it. Default off
   * (bots already have watchdog + adaptive; this is the opt-in stricter
   * tier, mirroring the auto-trader's streakBreaker). */
  streakBreaker?: boolean
  /** UNIVERSE SWEEP (Next Global hunter): ignore the fixed watchlist entirely
   * - once per closed candle on this bot's tf, pull the whole Next Global
   * board (every open instrument, one fused oracle read per pair, ranked by
   * tradability = confidence x |P(up)-0.5|) and fire on the TOP rows that
   * clear every gate: calibrated confidence >= max(minScore, params
   * .minConfidence), P(up) edge >= params.minEdge pp, live payout floor,
   * direction/regime filters, OTC guard, adaptive Wilson floor, memory gate
   * on the actual stake. A per-pair edge-trigger (sweepDir) keeps it from
   * re-firing a direction that is still standing, and the FIRST sweep after
   * arm only RECORDS baseline reads without trading (the same arm-time
   * backfill the watchlist bots do) so it never enters the stale middle of a
   * move. watchlist may be empty for sweep bots. */
  universeSweep?: boolean
  /** Max trades a single universe sweep may open (per candle-close bar).
   * The board is ranked, the bot walks down it and stops at this count.
   * Default 1 - one BEST read per bar. Clamped 1..10. */
  sweepMaxTrades?: number
}

export interface StakePlan {
  kind: 'fixed' | 'compound'
  base: number // seed stake of each compounding cycle, e.g. 1
  rollPct?: number // % of the pot wagered each trade (default 100 = full roll)
  maxStake?: number // per-trade cap; the global risk manager still outranks
  /** Hard ceiling on the payout used for compounding (fold-in), as a %.
   * A broker paying more than the cap gets the excess skimmed to the balance,
   * never compounded. Clamped to 1..70 - 70% is the house maximum "no matter
   * what". Default 70. */
  payoutCap?: number
  /** Once the cycle takes a loss the sequence ENDS: the bot stands down until
   * an explicit restart (bot_restart). Default true. false = legacy behaviour
   * (the pot re-seeds at base and keeps trading). */
  stopOnLoss?: boolean
  /** Compound for N periods (wins) per cycle: the Nth win COMPLETES the cycle
   * - the bot then halts awaiting a restart (onComplete 'halt', default) or
   * auto re-seeds a fresh cycle ('reseed'). Undefined = no limit (runs until
   * a loss). */
  periods?: number
  /** De-risk ladder: once `deriskAfter` wins have compounded, later trades
   * stake only `deriskPct`% of the pot (e.g. 50 = "continue with half the
   * 5th-period amount"). A derisk-phase loss then burns only that fraction -
   * everything already won stays banked on the balance. */
  deriskAfter?: number
  deriskPct?: number
  /** What happens when `periods` is reached: 'halt' (default) stands down
   * until an explicit restart; 'reseed' immediately starts a fresh cycle. */
  onComplete?: 'halt' | 'reseed'
  /** Caps how many times onComplete:'reseed' auto-starts a fresh cycle.
   * undefined = unlimited (reseeds forever until a loss or a manual
   * bot_restart). Set = after this many auto-reseeds the bot halts exactly
   * like onComplete:'halt' would. Only meaningful when onComplete is
   * 'reseed'; ignored otherwise. */
  reseedLimit?: number
  /** Only meaningful when stopOnLoss is false ("On loss: Re-seed" - a loss
   * does NOT end the cycle, it just keeps rolling). Caps how many LOSSES in
   * a row the bot will silently re-seed through before giving up: undefined
   * = unlimited (continues forever, the original behavior). Set = after
   * this many consecutive losses, it is forced to stop exactly like
   * stopOnLoss:true would (halted, awaiting an explicit bot_restart),
   * instead of continuing to re-seed indefinitely into a losing run. Resets
   * to 0 on the next win. */
  lossReseedLimit?: number
}

export type SessionFilter = 'all' | 'london' | 'newyork' | 'overlap' | 'asia' | 'sydney'

/** Streak-breaker bench duration for a run of consecutive losses: 15min at
 * 3 losses (the threshold), doubling per extra loss, capped at 4h. Pure and
 * exported so the selftest can pin the exact ladder the bots bench on. */
export function streakBenchSec(lossStreak: number): number {
  const n = Math.max(3, Math.round(lossStreak))
  return Math.min(4 * 60 * 60, 15 * 60 * 2 ** (n - 3))
}

/** Trading-session windows in UTC hours (fixed-clock approximation - IQ OTC
 * feeds trade around the clock, so the window is a discipline gate, not a
 * market-hours gate). 'overlap' = London x New York, the deep-liquidity hours. */
export const SESSION_WINDOWS: Record<Exclude<SessionFilter, 'all'>, { start: number; end: number; label: string }> = {
  london: { start: 8, end: 17, label: 'London 08:00-17:00 UTC' },
  newyork: { start: 13, end: 22, label: 'New York 13:00-22:00 UTC' },
  overlap: { start: 13, end: 17, label: 'London x NY overlap 13:00-17:00 UTC' },
  asia: { start: 0, end: 9, label: 'Asia 00:00-09:00 UTC' },
  sydney: { start: 21, end: 6, label: 'Sydney 21:00-06:00 UTC' },
}

/** True when UTC time-of-day is inside the session window (wraps midnight). */
export function inSession(s: SessionFilter, d: Date = new Date()): boolean {
  if (s === 'all') return true
  const w = SESSION_WINDOWS[s]
  const h = d.getUTCHours() + d.getUTCMinutes() / 60
  return w.start <= w.end ? h >= w.start && h < w.end : h >= w.start || h < w.end
}

export interface BotStats {
  trades: number
  wins: number
  losses: number
  pnlToday: number
  pnlTotal: number
  openCount: number
  lastTradeTs: number
  streak: number // positive = consecutive wins, negative = consecutive losses
  pot: number // compounding roll (0 = next trade starts a fresh cycle at base)
  rollN: number // wins compounded in the current cycle
  restarts: number // completed cycles (win streaks that ended)
  reseedCount: number // how many times onComplete:'reseed' has auto-fired since last (re)start
  lossReseedCount: number // consecutive losses re-seeded through (stopOnLoss:false) since last win/restart
  halted: boolean // compound stop-on-loss: cycle ended, awaiting restart
  complete: boolean // halted because the periods target was reached (a WIN, not a loss)
  /** Why the bot's last evaluation DIDN'T trade (research gate, session
   * window, score below floor, cooldown, edge-trigger waiting to retrigger,
   * etc). undefined only means nothing has been rejected since the runtime
   * was built (fresh bot, or it just traded) - it is NOT proof the bot is
   * healthy. This was tracked internally but never surfaced to the API/UI,
   * which is exactly why "why hasn't my bot traded" had no answer. */
  lastRejection?: string
  /** Task 59: why the strategy itself reported NO signal on the last closed
   * bar (e.g. "ADX 12.3 too weak", "warming up"). This is the armed-but-quiet
   * case - distinct from lastRejection (a signal existed but a gate blocked
   * it). Without it, a quiet tape looks identical to a broken bot. */
  quietNote?: string
}

export interface BotRow {
  bot: BotConfig
  stats: BotStats
  createdTs: number
}

export const DEFAULT_BOT: Omit<BotConfig, 'id' | 'name'> = {
  enabled: false,
  watchlist: [],
  strategyId: 'confluence-core',
  tf: '1m',
  kind: 'binary',
  stake: 10,
  expiryBars: 1,
  minScore: 55,
  direction: 'both',
  regime: 'all',
  maxOpen: 3,
  cooldownSec: 60,
  dailyProfitTarget: 0,
  dailyLossLimit: 0,
}

interface RuntimeState {
  dayKey: string
  trades: number
  wins: number
  losses: number
  pnlToday: number
  pnlTotal: number
  openCount: number
  lastTradeTs: number
  streak: number
  lastRejection?: string
  /** when lastRejection was last actually emitted, so an ongoing/unresolved
   * rejection re-surfaces periodically instead of going permanently silent
   * after the first alert - see reject(). */
  lastRejectionAt?: number
  quietNote?: string
  pot: number // compounding roll; 0 = fresh cycle at base
  rollN: number
  restarts: number
  reseedCount: number // how many times onComplete:'reseed' has auto-fired since last (re)start
  lossReseedCount: number // consecutive losses re-seeded through (stopOnLoss:false) since last win/restart
  halted: boolean // stop-on-loss: cycle ended, awaiting explicit restart
  complete: boolean // halted on the periods target (win-side completion)
  /** Edge-trigger de-dup: the direction of the last signal this bot actually
   * acted on (passed direction-filter). While the strategy keeps reporting
   * this SAME direction bar after bar, it's treated as the same persisting
   * signal, not a fresh one, and is ignored - prevents pyramiding into / being
   * whipsawed by a condition that just happens to stay true for a while. Reset
   * to null the moment the strategy reports 'none' (or the opposite
   * direction), which re-arms it for the next occurrence.
   * undefined = the bot has not evaluated anything since it was (re)armed or
   * the kernel restarted - the FIRST evaluation backfills this field WITHOUT
   * trading, because whatever the strategy reports then was already true
   * before the bot existed; acting on it would be trading a stale condition.
   * Only a genuine lapse (none) or a fresh edge after that produces an entry. */
  lastSignalDir: 'call' | 'put' | null | undefined
  /** Streak-breaker bench (bot.streakBreaker): epoch seconds until which the
   * bot refuses to trade after 3+ consecutive losses. In-memory only (same
   * as the auto-trader's bench map) - a kernel restart clears it, and the
   * streak itself is rebuilt from the journal, so a restarted bot with a
   * live loss streak re-benches on its next settled loss, not instantly. */
  benchedUntil?: number
  /** Universe-sweep state. sweepDir: per-asset last direction this bot
   * actually TRADED on the board - the edge-trigger de-dup, but keyed by
   * asset because a sweep bot faces 25 pairs at once, not one. An asset
   * whose oracle read keeps saying the same thing is the same persisting
   * signal, not a fresh one; it trades again only after the read lapses to
   * none/flip or the opposite side fires. sweepBackfilled: the first sweep
   * after (re)arm records every qualifying row's direction WITHOUT trading
   * (whatever the board says now was already true before the bot existed).
   * lastSweepTs: burst guard - distinct assets' bar closes can land within
   * the same second; the sweep itself runs once per tf bar, this just keeps
   * pathological re-entry from ever stacking. */
  sweepDir: Map<string, 'call' | 'put'>
  sweepBackfilled: boolean
  lastSweepTs: number
}

export class AutopilotService {
  private ctx!: KernelContext
  private store!: Store
  private market!: MarketDataService
  private analytics!: AnalyticsService
  private exec!: ExecutionService
  private unsubscribers: (() => void)[] = []
  private runtime = new Map<string, RuntimeState>()
  private evaluating = new Set<string>() // asset|tf pairs currently being processed
  private lab: StrategyLabService | null = null
  private revalidateTimer: ReturnType<typeof setInterval> | null = null
  // Global research-gate off-switch, user-requested. Persisted (survives
  // restarts) in the SAME sentinel-state JSON blob execution.ts's setRisk()
  // uses, under its own key, so this doesn't need a schema migration. Default
  // ON - this has to be an explicit opt-out, never a silent default.
  private researchGateEnabled = true
  // Universe-sweep de-dup: key "tf|barTime" -> swept. Several assets close
  // the same tf bar within milliseconds of each other; without this, every
  // close would re-run the whole-board sweep. Insertion-ordered, pruned.
  private sweptBars = new Map<string, number>()
  // walk-forward is CPU-heavy - re-checks are spread across ticks rather than
  // run all at once for a fleet with many bots/assets
  private static readonly REVALIDATE_TICK_MS = 15 * 60 * 1000 // 15 min sweep cadence
  private static readonly REVALIDATE_AFTER_SEC = 6 * 60 * 60 // re-run walk-forward at least this often for any (asset,tf,strategy) an ENABLED bot depends on
  private static readonly REVALIDATE_MAX_PER_TICK = 2

  /** Lazy-resolve the Strategy Lab (registered after the core plugins) -
   * custom:* strategy ids evaluate through it. */
  private labService(): StrategyLabService | null {
    if (this.lab) return this.lab
    try {
      this.lab = this.ctx.use<StrategyLabService>('lab')
    } catch {
      this.lab = null
    }
    return this.lab
  }

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.store = ctx.use<Store>('store')
    this.market = ctx.use<MarketDataService>('market')
    this.analytics = ctx.use<AnalyticsService>('analytics')
    this.exec = ctx.use<ExecutionService>('execution')

    // restore the persisted research-gate toggle (shares execution.ts's
    // sentinel-state blob, own key, so a restart doesn't silently re-arm it)
    try {
      const saved = this.store.getSentinelState()
      const cfg = saved?.config as Record<string, unknown> | undefined
      if (cfg && typeof cfg.researchGateEnabled === 'boolean') this.researchGateEnabled = cfg.researchGateEnabled
    } catch {
      // best-effort - default stays ON
    }

    // seed runtime stats from persisted journal so restarts keep their day/total numbers
    for (const { bot } of this.store.listBots()) this.runtime.set(bot.id, this.buildRuntime(bot.id))

    this.unsubscribers.push(
      ctx.bus.on('candle', ({ asset, tf, candle, closed }) => {
        if (closed) void this.onCandleClose(asset, tf, candle?.time)
      }),
      ctx.bus.on('positionOpened', ({ position }) => this.onPositionOpened(position)),
      ctx.bus.on('positionClosed', ({ position }) => this.onPositionClosed(position))
    )
    // continuous re-validation gate: researchGate only checks AT ARM TIME -
    // this keeps re-checking the underlying edge on a clock so a strategy
    // that quietly decayed gets caught even if nobody ever touches the bot
    // again (watchdog catches live P&L drift; this catches the backtest edge
    // itself decaying, before or alongside that).
    this.revalidateTimer = setInterval(() => void this.revalidateSweep(), AutopilotService.REVALIDATE_TICK_MS)
    ctx.log('autopilot', `bot engine online (${this.runtime.size} bots registered)`)
  }

  stop(): void {
    for (const u of this.unsubscribers) u()
    this.unsubscribers = []
    if (this.revalidateTimer) clearInterval(this.revalidateTimer)
    this.revalidateTimer = null
  }

  // ---------- fleet ----------

  listBots(): BotRow[] {
    const bots = this.store.listBots()
    return bots.map(({ bot, createdTs }) => ({
      bot,
      stats: this.statsFor(bot.id),
      createdTs,
    }))
  }

  runningCount(): number {
    return this.store.listBots().filter((b) => b.bot.enabled).length
  }

  /** Global research-gate off-switch (user-requested, applies to BOTH the
   * built-in walk-forward gate and the AI-Lab holdout gate). Reversible and
   * persisted - flip it back on any time. While off, every arm still gets
   * tagged forcedUnvalidated + logged, so an unvalidated bot never looks
   * indistinguishable from one that actually passed its gate. */
  getResearchGateEnabled(): boolean {
    return this.researchGateEnabled
  }

  setResearchGateEnabled(enabled: boolean): { ok: true; enabled: boolean } {
    this.researchGateEnabled = enabled
    try {
      const saved = this.store.getSentinelState()
      const cfg = (saved?.config as Record<string, unknown>) ?? {}
      this.store.saveSentinelState({ ...cfg, researchGateEnabled: enabled }, saved?.hwm ?? 0)
    } catch {
      // persistence best-effort; the in-memory flag still takes effect now
    }
    this.emit(
      enabled ? 'success' : 'danger',
      enabled
        ? 'Research gate RE-ENABLED - bots now require a validated edge to arm again.'
        : 'Research gate DISABLED globally - bots can now arm with NO validation requirement (built-in walk-forward and AI-Lab holdout checks are both bypassed). Every bot armed while this is off is marked forcedUnvalidated.'
    )
    return { ok: true, enabled }
  }

  /** Research gate: every watchlist instrument must have a RECENT robust
   * walk-forward verdict for this exact (asset, tf, strategyId) before a bot
   * is allowed to arm - mirrors the kalman-ou auto-trader's requireValidation
   * check in os-mode.ts, generalized to any strategy via the `validations`
   * table (POST /walkforward writes one on every run). Returns null when
   * clear to arm, or a `research-gate: ...` reason string when blocked. */
  private researchGate(bot: BotConfig): string | null {
    const MAX_AGE_SEC = 14 * 24 * 60 * 60 // 14 days - a stale pass doesn't mean much. v.ts is UNIX SECONDS (store.ts), not ms.
    // UNIVERSE-SWEEP branch: a sweep bot trades whatever pairs the Next Global
    // board surfaces bar by bar - a fixed watchlist (and its per-asset
    // verdicts) doesn't exist. The honest bar it CAN meet: this exact strategy
    // has a recent ROBUST walk-forward verdict on ANY pair at this bot's tf
    // (for oracle-fusion that's the pair the operator validated the fusion on;
    // the board's per-pair honesty records + the adaptive gate cover the rest
    // live). custom:* sweeps go through the lab's own holdout gate instead.
    if (bot.universeSweep) {
      if (bot.strategyId.startsWith('custom:')) return this.labResearchGate(bot)
      const v = this.store.latestRobustValidationAnyAsset(bot.tf, bot.strategyId)
      if (!v) {
        return `research-gate: universe sweep needs at least one ROBUST walk-forward of ${bot.strategyId} on any pair at ${bot.tf} - run /walkforward before arming`
      }
      if (Math.floor(Date.now() / 1000) - v.ts > MAX_AGE_SEC) {
        return `research-gate: ${bot.strategyId} ${bot.tf}'s robust validation (on ${v.asset}) is stale (>14d old) - re-run /walkforward before arming`
      }
      return null
    }
    if (bot.strategyId.startsWith('custom:')) return this.labResearchGate(bot)
    // THE BUG this replaces: the gate below required a `/walkforward` verdict
    // for EVERY strategyId, but `/walkforward` resolves strategies through
    // getStrategy() (builtin.ts), which only knows the fixed built-in
    // registry - it has never heard of a custom:<slug> Strategy Lab spec and
    // always returns undefined for one. That made this gate literally
    // unpassable for any lab-learned strategy: "has never been walk-forward
    // validated" would fire forever, no matter how many times you ran
    // /walkforward, because that endpoint can't even look the strategy up.
    // The scheduled re-validation sweep already knew this and exempted
    // custom:* (see revalidateSweep below); this arm-time gate just hadn't
    // caught up. Lab strategies DO carry their own validation though - the
    // same holdout-split + out-of-sample-fold backtest shown in the AI Lab
    // panel - so check that instead of demanding a verdict that can never
    // exist.
    if (bot.strategyId.startsWith('custom:')) return this.labResearchGate(bot)
    for (const asset of bot.watchlist) {
      const v = this.store.latestValidation(asset, bot.tf, bot.strategyId)
      if (!v) {
        return `research-gate: ${asset} ${bot.tf} ${bot.strategyId} has never been walk-forward validated - run /walkforward for this asset+strategy before arming`
      }
      if (v.verdict !== 'robust') {
        return `research-gate: ${asset} ${bot.tf} ${bot.strategyId}'s latest walk-forward verdict was "${v.verdict}", not robust - re-tune params and re-validate before arming`
      }
      if (Math.floor(Date.now() / 1000) - v.ts > MAX_AGE_SEC) {
        return `research-gate: ${asset} ${bot.tf} ${bot.strategyId}'s robust validation is stale (>14d old) - re-run /walkforward before arming`
      }
    }
    return null
  }

  /** The custom:* equivalent of researchGate() above: instead of a
   * /walkforward verdict (which can't be produced for a lab spec at all),
   * require that the strategy's OWN lab-measured stats actually clear
   * breakeven on its holdout split and weren't flagged decayed by the lab's
   * own re-learn sweep. A strategy that's never been through "learn this
   * pair" at all (no stats saved yet) still blocks - this isn't a free pass,
   * it's the lab-native version of the same bar. */
  private labResearchGate(bot: BotConfig): string | null {
    const lab = this.labService()
    if (!lab) return `research-gate: ${bot.strategyId} can't be checked - Strategy Lab isn't loaded`
    const row = lab.get(bot.strategyId)
    if (!row) return `research-gate: ${bot.strategyId} not found in the Strategy Lab library`
    const stats = row.stats as { holdout?: { winRate: number; trades: number }; breakeven?: number; decayed?: boolean } | null
    if (!stats?.holdout) {
      return `research-gate: ${bot.strategyId} has no saved holdout backtest yet - re-run "learn this pair" (or /lab_backtest) before arming`
    }
    if (stats.decayed) {
      return `research-gate: ${bot.strategyId} was flagged DECAYED by the lab's own re-learn sweep - it no longer clears its own filters on fresh data; re-learn before arming`
    }
    const breakeven = stats.breakeven ?? 50
    if (stats.holdout.winRate < breakeven) {
      return `research-gate: ${bot.strategyId}'s holdout win rate (${stats.holdout.winRate.toFixed(1)}%) is below its own breakeven (${breakeven.toFixed(1)}%) - re-tune or re-learn before arming`
    }
    return null
  }

  /** Sweep every ENABLED bot's watchlist for (asset, tf, strategyId) combos
   * whose latest validation is missing or older than REVALIDATE_AFTER_SEC,
   * and re-run walk-forward on up to REVALIDATE_MAX_PER_TICK of them per
   * tick. custom:* (Strategy Lab) strategies aren't backed by the optimize.ts
   * grid engine, so they're outside this gate for now - watchdog still
   * covers their live drift. */
  private async revalidateSweep(): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    const due = new Map<string, { asset: string; tf: Timeframe; strategyId: string; botIds: string[] }>()
    for (const { bot } of this.store.listBots()) {
      if (!bot.enabled || bot.strategyId.startsWith('custom:')) continue
      for (const asset of bot.watchlist) {
        const v = this.store.latestValidation(asset, bot.tf, bot.strategyId)
        if (v && now - v.ts < AutopilotService.REVALIDATE_AFTER_SEC) continue
        const key = `${asset}|${bot.tf}|${bot.strategyId}`
        const entry = due.get(key) ?? { asset, tf: bot.tf, strategyId: bot.strategyId, botIds: [] }
        entry.botIds.push(bot.id)
        due.set(key, entry)
      }
    }
    if (!due.size) return
    for (const combo of Array.from(due.values()).slice(0, AutopilotService.REVALIDATE_MAX_PER_TICK)) {
      try {
        await this.revalidateOne(combo.asset, combo.tf, combo.strategyId, combo.botIds)
      } catch (err) {
        this.ctx.log('autopilot', `re-validation gate: ${combo.asset} ${combo.tf} ${combo.strategyId} failed:`, (err as Error).message)
      }
    }
  }

  /** Re-run the same walk-forward the operator would run by hand (POST
   * /walkforward) for one (asset, tf, strategyId), save the fresh verdict
   * with the SAME grading rubric that endpoint uses (so the Research panel
   * and researchGate both see one consistent history), and auto-disarm every
   * enabled bot that depends on it the moment a robust edge stops being
   * robust. */
  private async revalidateOne(asset: string, tf: Timeframe, strategyId: string, botIds: string[]): Promise<void> {
    const strat = getStrategy(strategyId)
    if (!strat) return
    // Task 59 (P1): closedOnly - research-gate walk-forward must grade the
    // same closed-bar series the bots and backtests see.
    const candles = this.market.getCandlesDeep(asset, tf, 2200, true)
    const out = walkForward(candles, asset, tf, {
      strategy: strategyId,
      sweep: {},
      objective: 'netPnl',
      minTrades: 6,
      maxCombos: 4,
      folds: 3,
      isRatio: 0.7,
      payout: 0.85,
      amount: 10,
      expiryBars: 1,
      startEquity: 1000,
    })
    const verdict: 'robust' | 'weak' | 'failed' =
      out.oos.netPnl > 0 && out.foldsProfitable >= Math.ceil(out.folds.length * (2 / 3)) && out.efficiencyPct >= 25 && out.oos.totalTrades >= 10
        ? 'robust'
        : out.oos.netPnl > 0 && out.foldsProfitable >= 1
          ? 'weak'
          : 'failed'
    this.store.saveValidation({
      asset,
      tf,
      strategyId,
      params: out.bestParams,
      verdict,
      oosNet: Math.round(out.oos.netPnl * 100) / 100,
      isNet: Math.round(out.isNet * 100) / 100,
      winRate: Math.round(out.oos.winRate * 10) / 10,
      efficiencyPct: Math.round(out.efficiencyPct * 10) / 10,
      folds: out.folds.length,
      foldsProfitable: out.foldsProfitable,
      totalTrades: out.oos.totalTrades,
    })
    this.ctx.log(
      'autopilot',
      `re-validation gate: ${asset} ${tf} ${strategyId} -> ${verdict} (oos net ${out.oos.netPnl.toFixed(2)}, ${out.foldsProfitable}/${out.folds.length} folds profitable)`
    )
    if (verdict === 'robust') return
    for (const botId of botIds) {
      const row = this.store.listBots().find((b) => b.bot.id === botId)
      if (!row?.bot.enabled) continue
      this.store.saveBot({ ...row.bot, enabled: false })
      this.runtime.delete(botId) // rebuilt fresh from the journal on next read - clears stale rejection-spam state too
      this.emit(
        'danger',
        `[${row.bot.name}] AUTO-DISARMED by the continuous re-validation gate - ${asset} ${tf} ${strategyId}'s walk-forward decayed to "${verdict}" - re-tune and re-validate (POST /walkforward) before re-arming`
      )
    }
  }

  /** Full fresh-start for the bot fleet's own numbers - used by the "clear
   * all data" action (new broker account connected, want to see how it does
   * from zero). Every bot's compounding plan state (pot/rollN/restarts) is
   * zeroed and persisted, and the whole in-memory runtime map is dropped so
   * the next read rebuilds wins/losses/pnlToday/pnlTotal/streak from the
   * trade journal - which the caller is expected to have just cleared, so
   * every bot comes back to a clean 0-0 record. Bot configs (strategy,
   * stakes, risk limits, enabled state) are untouched - this resets
   * RESULTS, not setup. */
  resetAllStats(): void {
    for (const { bot } of this.store.listBots()) {
      if (bot.planState) this.store.saveBot({ ...bot, planState: { pot: 0, rollN: 0, restarts: 0, reseedCount: 0, lossReseedCount: 0, halted: false, complete: false } })
    }
    this.runtime.clear()
    this.emit('info', 'bot fleet stats cleared - starting fresh')
  }

  saveBot(input: Partial<BotConfig>, opts: { force?: boolean } = {}): { ok: boolean; bot?: BotConfig; error?: string; forced?: boolean } {
    const id = input.id?.trim() || `bot-${Math.random().toString(36).slice(2, 8)}`
    const existing = this.store.listBots().find((b) => b.bot.id === id)?.bot
    // Task 58 (P2): kind used to be cast unchecked - a client sending
    // kind:"binary " (trailing space) or any unknown string passed save and
    // execution.placeOrder's final else branch treated it as a CFD: margin
    // deducted, leverage defaulted up to 30x, no expiry. Whitelist it.
    const rawKind = String(input.kind ?? existing?.kind ?? DEFAULT_BOT.kind).trim()
    const kind = (['binary', 'turbo', 'blitz', 'digital', 'cfd'].includes(rawKind) ? rawKind : DEFAULT_BOT.kind) as TradeKind
    // expirySec is only meaningful for kinds that settle at an exact
    // timestamp independent of the tf-bar count: digital (minutes-scale,
    // 60-86400s) and blitz (sub-minute, 1-60s) - each gets its own clamp
    // range rather than the old one-size digital-only 60s floor, which would
    // have silently rounded every blitz bot's 5s/15s expiry up to a full
    // minute.
    const expirySecBounds: [number, number] = kind === 'blitz' ? [1, 60] : [60, 86400]
    const bot: BotConfig = {
      id,
      name: (input.name ?? existing?.name ?? `Bot ${id.slice(-4)}`).trim().slice(0, 32) || 'Bot',
      enabled: input.enabled ?? existing?.enabled ?? false,
      watchlist: (Array.isArray(input.watchlist) ? input.watchlist : existing?.watchlist ?? [])
        .map((a) => String(a).toUpperCase())
        .filter((a) => a && this.market.assets.some((x) => x.ticker === a))
        .slice(0, 12),
      strategyId: this.validStrategy(input.strategyId ?? existing?.strategyId ?? DEFAULT_BOT.strategyId),
      tf: (input.tf ?? existing?.tf ?? DEFAULT_BOT.tf) as Timeframe,
      params: input.params && Object.keys(input.params).length ? input.params : existing?.params,
      kind,
      stake: clampNum(input.stake ?? existing?.stake ?? DEFAULT_BOT.stake, 1, 5000),
      expiryBars: Math.max(1, Math.round(input.expiryBars ?? existing?.expiryBars ?? DEFAULT_BOT.expiryBars)),
      minScore: clampNum(input.minScore ?? existing?.minScore ?? DEFAULT_BOT.minScore, 0, 100),
      direction: (input.direction ?? existing?.direction ?? 'both') as BotConfig['direction'],
      regime: (input.regime ?? existing?.regime ?? 'all') as BotConfig['regime'],
      maxOpen: Math.max(1, Math.round(input.maxOpen ?? existing?.maxOpen ?? DEFAULT_BOT.maxOpen)),
      cooldownSec: Math.max(0, Math.round(input.cooldownSec ?? existing?.cooldownSec ?? DEFAULT_BOT.cooldownSec)),
      dailyProfitTarget: input.dailyProfitTarget !== undefined ? Number(input.dailyProfitTarget) : existing?.dailyProfitTarget,
      dailyLossLimit: input.dailyLossLimit !== undefined ? Number(input.dailyLossLimit) : existing?.dailyLossLimit,
      expirySec:
        input.expirySec !== undefined || existing?.expirySec !== undefined
          ? Math.round(clampNum(input.expirySec ?? existing?.expirySec ?? (kind === 'blitz' ? 15 : 300), expirySecBounds[0], expirySecBounds[1]))
          : undefined,
      session: this.validSession(input.session ?? existing?.session),
      stakePlan: this.parseStakePlan(input.stakePlan, existing?.stakePlan),
      adaptive: input.adaptive !== undefined ? Boolean(input.adaptive) : existing?.adaptive,
      minPayoutPct:
        input.minPayoutPct !== undefined || existing?.minPayoutPct !== undefined
          ? clampNum(input.minPayoutPct ?? existing?.minPayoutPct ?? 0, 0, 98)
          : undefined,
      streakBreaker: input.streakBreaker !== undefined ? Boolean(input.streakBreaker) : existing?.streakBreaker,
      universeSweep: input.universeSweep !== undefined ? Boolean(input.universeSweep) : existing?.universeSweep,
      sweepMaxTrades:
        input.sweepMaxTrades !== undefined || existing?.sweepMaxTrades !== undefined
          ? Math.round(clampNum(input.sweepMaxTrades ?? existing?.sweepMaxTrades ?? 1, 1, 10))
          : undefined,
    }
    // a materially different plan invalidates the persisted roll - start clean
    const planChanged = JSON.stringify(bot.stakePlan ?? null) !== JSON.stringify(existing?.stakePlan ?? null)
    bot.planState = planChanged ? undefined : input.planState ?? existing?.planState
    // a universe-sweep bot hunts the whole Next Global board - an empty
    // watchlist is its NORMAL state, not a config error (non-sweep bots
    // still need at least one valid instrument below)
    if (!bot.watchlist.length && !bot.universeSweep) return { ok: false, error: 'watchlist needs at least one valid instrument' }
    if (!this.isValidStrategy(bot.strategyId)) return { ok: false, error: `unknown strategy ${bot.strategyId}` }
    // research gate: only check when this save is what's arming the bot (new
    // enable, not every edit to an already-running one) so a stake tweak on a
    // live bot doesn't get blocked by a validation that's since gone stale.
    let forced = false
    // Task 58 (P2): the research gate used to fire only on the ENABLE
    // transition - an already-armed bot could be re-saved with a brand-new
    // unvalidated strategyId (and params) and keep trading it with no gate.
    // A strategy swap on a live bot is re-gated exactly like a fresh arm.
    const strategyChanged = existing && bot.strategyId !== existing.strategyId
    if (bot.enabled && (!(existing?.enabled ?? false) || strategyChanged)) {
      const gate = this.researchGateEnabled ? this.researchGate(bot) : null
      if (gate) {
        if (!opts.force) return { ok: false, error: gate }
        forced = true
        this.emit('warn', `Bot "${bot.name}" FORCED past research gate - ${gate.replace(/^research-gate: /, '')}. Unvalidated edge, armed on explicit user override.`)
      } else if (!this.researchGateEnabled) {
        forced = true
        this.emit('warn', `Bot "${bot.name}" armed with the research gate globally DISABLED - no validation requirement was checked. Unvalidated edge.`)
      }
      bot.forcedUnvalidated = forced
    } else if (bot.enabled) {
      // already-armed bot being re-saved (a stake tweak, say) - keep whatever
      // forced flag it already had rather than silently clearing it
      bot.forcedUnvalidated = input.forcedUnvalidated ?? existing?.forcedUnvalidated
    }
    this.store.saveBot(bot)
    if (!this.runtime.has(id)) this.runtime.set(id, this.buildRuntime(id))
    this.emit(bot.enabled ? 'success' : 'info', `Bot "${bot.name}" saved - ${bot.enabled ? 'ARMED' : 'idle'} (${bot.strategyId} · ${bot.tf} · ${bot.universeSweep ? 'UNIVERSE SWEEP via Next Global' : bot.watchlist.join(', ')})`)
    return { ok: true, bot, forced }
  }

  deleteBot(id: string): { ok: boolean; error?: string } {
    const ok = this.store.deleteBot(id)
    if (ok) {
      this.runtime.delete(id)
      try {
        const wd = this.ctx.use<{ clearBot: (botId: string) => void }>('watchdog')
        wd.clearBot(id)
      } catch {
        // watchdog not loaded
      }
      this.emit('info', `Bot ${id} deleted`)
    }
    return { ok, error: ok ? undefined : 'bot not found' }
  }

  /** Revive a compound bot after a stop-on-loss halt (or proactively re-seed):
   * clears the halt, zeroes the pot/roll so the next trade bets the seed
   * again. The cumulative cycle counter is kept. */
  restartBot(id: string): { ok: boolean; bot?: BotConfig; error?: string } {
    const found = this.store.listBots().find((b) => b.bot.id === id)
    if (!found) return { ok: false, error: 'bot not found' }
    const bot = found.bot
    if (bot.stakePlan?.kind !== 'compound') return { ok: false, error: 'restart applies to compound bots only' }
    const rt = this.runtime.get(id) ?? this.buildRuntime(id)
    rt.halted = false
    rt.complete = false
    rt.pot = 0
    rt.rollN = 0
    rt.reseedCount = 0
    rt.lossReseedCount = 0
    rt.lastRejection = undefined
    this.store.saveBot({ ...bot, planState: { pot: 0, rollN: 0, restarts: rt.restarts, reseedCount: 0, lossReseedCount: 0 } })
    this.emit('success', `[${bot.name}] compound cycle RESTARTED - next trade seeds $${bot.stakePlan.base}`)
    return { ok: true, bot: this.store.listBots().find((b) => b.bot.id === id)?.bot }
  }

  toggleBot(id: string, enabled?: boolean, opts: { force?: boolean } = {}): { ok: boolean; bot?: BotConfig; error?: string; forced?: boolean } {
    const found = this.store.listBots().find((b) => b.bot.id === id)
    if (!found) return { ok: false, error: 'bot not found' }
    const bot: BotConfig = { ...found.bot, enabled: enabled ?? !found.bot.enabled }
    let forced = false
    if (bot.enabled && !found.bot.enabled) {
      const gate = this.researchGateEnabled ? this.researchGate(bot) : null
      if (gate) {
        if (!opts.force) return { ok: false, error: gate }
        forced = true
        this.emit('warn', `Bot "${bot.name}" FORCED past research gate - ${gate.replace(/^research-gate: /, '')}. Unvalidated edge, armed on explicit user override.`)
      } else if (!this.researchGateEnabled) {
        forced = true
        this.emit('warn', `Bot "${bot.name}" armed with the research gate globally DISABLED - no validation requirement was checked. Unvalidated edge.`)
      }
      bot.forcedUnvalidated = forced
    }
    this.store.saveBot(bot)
    this.emit(bot.enabled ? 'success' : 'info', `Autopilot "${bot.name}" ${bot.enabled ? 'STARTED' : 'STOPPED'} - watching ${bot.universeSweep ? 'the whole universe (Next Global sweep)' : bot.watchlist.join(', ')} on ${bot.tf} (${bot.strategyId})`)
    return { ok: true, bot, forced }
  }

  // ---------- trading loop ----------

  private async onCandleClose(asset: string, tf: Timeframe, barTime?: number): Promise<void> {
    const bots = this.store.listBots().filter(
      (b) => b.bot.enabled && b.bot.tf === tf && b.bot.watchlist.includes(asset)
    )
    if (bots.length) {
      const key = `${asset}|${tf}`
      if (!this.evaluating.has(key)) {
        this.evaluating.add(key)
        try {
          for (const { bot } of bots) {
            try {
              await this.tradeForBot(bot, asset, tf)
            } catch (err) {
              // strategy evaluation can throw on thin history - Task 59: surface
              // it as a rejection (deduped) instead of a console-only whisper
              this.reject(bot, `evaluation failed: ${String((err as Error).message).slice(0, 160)}`)
            }
          }
        } finally {
          this.evaluating.delete(key)
        }
      }
    }

    // UNIVERSE SWEEP: bots with universeSweep:true ignore their (empty)
    // watchlist - they run once per closed candle on their tf, whoever's bar
    // closed first. sweptBars de-dups the several same-tf closes that land
    // within milliseconds; the sweep then scans the whole Next Global board.
    if (!barTime) return
    const sweepers = this.store.listBots().filter((b) => b.bot.enabled && b.bot.universeSweep && b.bot.tf === tf)
    if (!sweepers.length) return
    const sweepKey = `${tf}|${barTime}`
    if (this.sweptBars.has(sweepKey)) return
    this.sweptBars.set(sweepKey, Date.now())
    while (this.sweptBars.size > 60) {
      const oldest = this.sweptBars.keys().next().value
      if (oldest === undefined) break
      this.sweptBars.delete(oldest)
    }
    for (const { bot } of sweepers) {
      try {
        await this.sweepUniverseForBot(bot)
      } catch (err) {
        this.reject(bot, `universe sweep failed: ${String((err as Error).message).slice(0, 160)}`)
      }
    }
  }

  private async tradeForBot(bot: BotConfig, asset: string, tf: Timeframe): Promise<void> {
    const rt = this.runtime.get(bot.id) ?? this.buildRuntime(bot.id)
    const dayKey = new Date().toISOString().slice(0, 10)

    // daily rollover
    if (rt.dayKey !== dayKey) {
      rt.dayKey = dayKey
      rt.trades = 0
      rt.wins = 0
      rt.losses = 0
      rt.pnlToday = 0
      rt.streak = 0
    }

    // compound stop-on-loss: a cycle that took a loss is DEAD - the bot stands
    // down (but stays armed/configured) until an explicit bot_restart. A
    // periods-completed cycle halts too, but with a win-side message.
    if (bot.stakePlan?.kind === 'compound' && bot.stakePlan.stopOnLoss !== false && rt.halted) {
      return this.reject(
        bot,
        rt.complete
          ? `compound cycle COMPLETE (${rt.rollN}/${bot.stakePlan.periods ?? '?'} periods banked) - restart for a fresh cycle`
          : 'compound cycle ended on a loss - restart to trade again',
      )
    }

    // session window gate (UTC): outside the window the bot just stands down
    if (bot.session && bot.session !== 'all' && !inSession(bot.session)) {
      return this.reject(bot, `outside ${bot.session} session (${SESSION_WINDOWS[bot.session].label})`)
    }

    // per-bot circuit breakers
    if (bot.dailyProfitTarget && bot.dailyProfitTarget > 0 && rt.pnlToday >= bot.dailyProfitTarget) {
      return this.reject(bot, `profit target reached (+$${rt.pnlToday.toFixed(2)})`)
    }
    if (bot.dailyLossLimit && bot.dailyLossLimit > 0 && rt.pnlToday <= -bot.dailyLossLimit) {
      return this.reject(bot, `daily loss limit hit (-$${Math.abs(rt.pnlToday).toFixed(2)})`)
    }
    if (rt.openCount >= bot.maxOpen) return this.reject(bot, `max open positions (${bot.maxOpen})`)
    if (bot.cooldownSec > 0 && rt.lastTradeTs > 0 && Math.floor(Date.now() / 1000) - rt.lastTradeTs < bot.cooldownSec) {
      return this.reject(bot, 'cooldown between trades')
    }

    // streak-breaker bench: after 3+ consecutive losses the bot benches
    // itself for a growing window (15min -> doubling -> 4h cap) - it saw the
    // conditions go sour and stands down without needing an operator ack
    // (unlike a watchdog DISARM) or an aggregate $ trip (daily loss limit).
    if (bot.streakBreaker && rt.benchedUntil && Math.floor(Date.now() / 1000) < rt.benchedUntil) {
      const left = Math.ceil((rt.benchedUntil - Math.floor(Date.now() / 1000)) / 60)
      return this.reject(bot, `streak-breaker bench: ${left}min left (after ${Math.abs(Math.min(rt.streak, -1))} losses in a row)`)
    }

    // PAYOUT FLOOR (the EV gate): the one lever our own research says moves
    // expected value - breakeven at payout p is 1/(1+p), so a signal worth
    // taking at an 82% payout (BE 54.9%) can be pure house-edge at 65%
    // (BE 60.6%). Checked per candle-close against the LIVE payout for this
    // bot's kind. pay <= 0 = payout unknown -> permissive (cold metadata
    // contract), exactly like the auto-trader's gate. The same number is
    // reused by the adaptive gate below (payout-aware floor mode).
    const livePay = this.payoutFor(asset, bot.kind)
    if ((bot.minPayoutPct ?? 0) > 0 && livePay > 0 && livePay * 100 < bot.minPayoutPct!) {
      return this.reject(
        bot,
        `payout ${(livePay * 100).toFixed(0)}% below the ${bot.minPayoutPct}% floor (breakeven ${(100 / (1 + livePay)).toFixed(1)}% here)`,
      )
    }

    // mode gate: HUMAN-IN-THE-LOOP suspends bot autonomy (non-destructive -
    // configs and arm states are preserved, only execution is gated)
    try {
      const mode = this.ctx.use<{ gate: (origin: 'bot' | 'auto') => { ok: boolean; reason?: string } }>('mode')
      const m = mode.gate('bot')
      if (!m.ok) return this.reject(bot, m.reason ?? 'mode gate hold')
    } catch {
      // mode plugin not loaded - gate disabled
    }

    // watchdog gate: strategy-health ladder (WATCH informs, HOLD blocks for a
    // window, DISARMED blocks until an operator acks + re-arms the bot)
    try {
      const wd = this.ctx.use<{ preTrade: (botId: string) => { ok: boolean; reason?: string } }>('watchdog')
      const w = wd.preTrade(bot.id)
      if (!w.ok) return this.reject(bot, w.reason ?? 'watchdog health hold')
    } catch {
      // watchdog plugin not loaded - health gating disabled
    }

    // copilot memory gate: standing rules the user told the copilot ("never
    // trade Fridays", "only trade EURUSD-OTC", "max stake $20"...) hard-block
    // autonomy - manual trading stays free, rules govern the machines only.
    // Task 58 (P1): this check MOVED below stakeFor() - it used to run on the
    // bot's FLAT configured stake ~100 lines before the real bet was computed,
    // so a compounding bot with a $200 pot sailed through a "max stake $20"
    // rule and then placed $200. It now gates the ACTUAL bet amount (compound
    // roll + smart multiplier included), same as os-mode does.

    // OTC defense gate: generator-driven charts (synthetic feeds) don't
    // respect TA - autonomy may only trade an OTC asset with a strategy that
    // has beaten its own calibrated synthetic placebo (plugins/otcguard.ts).
    // Cheap persisted-verdict lookup, never computes here. policy 'warn'/
    // 'off' pass through; humans trading manually are never gated.
    try {
      const guard = this.ctx.use<{ check: (target: { asset: string }, strategyKey: string) => { ok: boolean; reason?: string } }>('otcGuard')
      const g = guard.check({ asset }, bot.strategyId)
      if (!g.ok) return this.reject(bot, g.reason ?? 'OTC defense gate hold')
    } catch {
      // otc guard plugin not loaded - OTC gating disabled
    }

    // strategy evaluation (pure, on closed candles) - builtin strategies run
    // through analytics, AI-learned specs (custom:*) through the lab
    const isCustom = bot.strategyId.startsWith('custom:')
    let evalOut: ReturnType<AnalyticsService['runStrategy']>
    if (isCustom) {
      const lab = this.labService()
      if (!lab) return this.reject(bot, 'strategy lab unavailable for custom strategy')
      evalOut = lab.runStrategy(asset, tf, bot.strategyId)
    } else {
      const merged = { ...defaultParams(getStrategy(bot.strategyId)!), ...(bot.params ?? {}) }
      evalOut = this.analytics.runStrategy(asset, tf, bot.strategyId, merged)
    }
    if (evalOut.direction === 'none') {
      // condition lapsed - re-arm the edge-trigger for whenever it next fires
      rt.lastSignalDir = null
      // Task 59: keep the strategy's own reason ("ADX 12.3 too weak") visible
      // in stats so an armed-but-quiet bot is distinguishable from a broken one
      rt.quietNote = evalOut.notes || undefined
      return
    }
    rt.quietNote = undefined
    if (Math.abs(evalOut.score) < bot.minScore) {
      return this.reject(bot, `score ${evalOut.score.toFixed(0)} below min ${bot.minScore}`)
    }
    const wanted = evalOut.direction === 'call' ? 'call' : 'put'
    if (bot.direction !== 'both' && bot.direction !== wanted) {
      return this.reject(bot, `signal ${wanted} outside allowed direction (${bot.direction})`)
    }

    // ARM-TIME BACKFILL: the first evaluation after (re)arm or a kernel
    // restart only tells us the condition is ALREADY true - not when it
    // became true. Trading it would be entering the stale middle of a move
    // (the exact "we capture the condition when it has already happened"
    // failure mode), so the observed direction is stamped here WITHOUT an
    // order: the bot now treats it as the persisting signal it is and waits
    // for a lapse (none) or a flip to see a genuinely fresh edge. A restart
    // used to re-fire every persisting condition as if fresh - the classic
    // stale-burst this backfill kills.
    if (rt.lastSignalDir === undefined) {
      rt.lastSignalDir = wanted
      return this.reject(bot, `condition ${wanted} already true at arm (age ${evalOut.ageBars ?? '?'} bars) - waiting for a fresh edge`)
    }

    // edge-trigger de-dup: only act the FIRST time this direction shows up.
    // While the condition keeps reporting the same direction bar after bar,
    // it's the same persisting signal, not a fresh one - skip it until it
    // either lapses to 'none' or flips to the other direction and comes back.
    // This is what stands between "one clean entry per setup" and pyramiding
    // into (or getting whipsawed by) a condition that just stays true a while.
    // THE BUG: the edge-trigger used to be STAMPED here - before the regime
    // gate, the adaptive gate and the execution call. A signal blocked by ANY
    // of those (regime flicker, adaptive hold, risk manager rejection,
    // balance busy) still consumed the edge: the SAME persisting condition
    // was then skipped forever as "still active" and the bot needed the
    // signal to lapse and re-fire before it could ever take it. The stamp now
    // happens only on actual execution (below), so a transiently-blocked
    // signal retries on the next candle until it either executes or lapses.
    if (rt.lastSignalDir === wanted) {
      return this.reject(bot, `signal ${wanted} still active - waiting for it to clear/flip before retriggering`)
    }

    // regime gate: same 4-way TRENDING/RANGING/VOLATILE/MIXED classification
    // as the copilot's regime_playbook tool (classifyRegime), not just the
    // coarser bull/bear Markov read this used to use.
    if (bot.regime !== 'all') {
      try {
        const a = this.analytics.analyze(asset, tf)
        const r = classifyRegime(a)
        if (bot.regime === 'trend' && r !== 'TRENDING') return this.reject(bot, `regime ${r} not trending`)
        if (bot.regime === 'range' && r !== 'RANGING') return this.reject(bot, `regime ${r} not ranging`)
        if (bot.regime === 'avoid-volatile' && r === 'VOLATILE') return this.reject(bot, `regime ${r} - standing aside for the vol spike to decay`)
      } catch {
        return this.reject(bot, 'regime unavailable (thin history)')
      }
    }

    // adaptive confidence gate: this exact (asset, tf, strategy, side,
    // score-bucket[, regime][, session]) setup only fires if ITS OWN settled
    // record (Wilson lower bound, not the raw ratio) clears the fleet floor -
    // see adaptive.ts for why this is the honest way to chase a higher win
    // rate instead of a curve-fit backtest number.
    if (bot.adaptive !== false) {
      try {
        const adaptive = this.ctx.use<{
          config: { enabled: boolean }
          check: (asset: string, tf: string, strategyId: string, side: string, score: number, regime?: string, session?: string, payout?: number) => { ok: boolean; reason?: string }
        }>('adaptive')
        if (adaptive.config.enabled) {
          let regime: string | undefined
          try {
            regime = classifyRegime(this.analytics.analyze(asset, tf))
          } catch {
            regime = undefined
          }
          const session = classifySession(Math.floor(Date.now() / 1000), asset)
          const v = adaptive.check(asset, tf, bot.strategyId, wanted, evalOut.score, regime, session, livePay || undefined)
          if (!v.ok) return this.reject(bot, v.reason ?? 'adaptive confidence gate hold')
        }
      } catch {
        // adaptive plugin not loaded - gate disabled
      }
    }

    // execute - the ExecutionService risk manager is the final gate
    const bet = this.stakeFor(bot, rt)
    // COMPOUND OVER-BET GUARD: the stake used to be Math.max(1, raw) - a pot
    // below the $1 broker minimum (dust left by a derisk phase or a partial
    // roll) silently bet MORE than the pot, breaking the compounding math
    // (a loss then burns money the cycle never banked). IQ cannot take a
    // stake under $1, so the honest move is to stand the cycle down.
    if (bet.compound && bet.pot >= 0.01 && bet.amount > bet.pot) {
      return this.reject(
        bot,
        `compound pot $${bet.pot.toFixed(2)} is below the $1 broker minimum stake - restart the cycle to re-seed`,
      )
    }
    // copilot memory gate - NOW on the real bet amount (see the note above)
    try {
      const mg = this.ctx.use<{ check: (asset: string, stake: number) => { ok: boolean; reason?: string } }>('memoryGate')
      const g = mg.check(asset, bet.amount)
      if (!g.ok) return this.reject(bot, g.reason ?? 'memory gate hold')
    } catch {
      // memory gate plugin not loaded - rule gating disabled
    }
    // THE BUG: this used to hardcode mode: 'paper' - every bot traded the
    // paper ledger no matter which ledger the operator was actually on, so a
    // bot created/armed while connected to a real IQ session silently placed
    // (and reported) paper trades instead of real ones. Mirror whatever
    // ledger is actually active, exactly like the manual trade path does.
    const out = await this.exec.placeOrder({
      asset,
      tf,
      side: wanted,
      kind: bot.kind,
      amount: bet.amount,
      expiryBars: bot.expiryBars,
      expirySec: bot.kind === 'digital' || bot.kind === 'blitz' ? bot.expirySec : undefined,
      mode: this.exec.accountSource === 'iq' ? 'live' : 'paper',
      strategy: bot.strategyId,
      note: `bot:${bot.id}`,
    })

    if (!out.ok) return this.reject(bot, out.error ?? 'order rejected')

    // edge-trigger stamp happens HERE (execution actually happened) - see
    // the comment above for why the old pre-gate stamp ate blocked signals
    rt.lastSignalDir = wanted
    rt.trades += 1
    rt.lastTradeTs = Math.floor(Date.now() / 1000)
    rt.lastRejection = undefined
    const periodsTag = bot.stakePlan?.periods ? `/${bot.stakePlan.periods}` : ''
    const roll = bet.compound
      ? ` - compound ${bet.phase} roll x${bet.rollN + 1}${periodsTag} (pot $${bet.pot.toFixed(2)}, stake $${bet.amount.toFixed(2)})`
      : ''
    const pay = this.payoutFor(asset, bot.kind)
    const payTag = pay > 0 ? ` · pay ${(pay * 100).toFixed(0)}% (BE ${(100 / (1 + pay)).toFixed(1)}%)` : ''
    this.emit('success', `[${bot.name}] ${wanted.toUpperCase()} ${asset} $${bet.amount} ${bot.kind} @ ${evalOut.price.toFixed(5)} - ${evalOut.notes} (score ${evalOut.score.toFixed(0)})${roll}${payTag}`)
  }

  // ---------- universe sweep (Next Global hunter) ----------

  /** One pass of the whole Next Global board for a universeSweep bot. Runs
   * once per closed tf candle (de-duped in onCandleClose): pull the board
   * (one fused oracle read per open pair, TTL-cached kernel-side, ranked by
   * tradability), walk it top-down and fire on rows that clear EVERY gate,
   * up to sweepMaxTrades per bar. All the governance the watchlist bots
   * answer to still applies - session window, daily $ limits, max open,
   * bot-level cooldown, streak-breaker bench, mode gate, watchdog, payout
   * floor, direction/regime filters, OTC guard, adaptive Wilson floor,
   * memory gate on the ACTUAL stake - and the ExecutionService risk manager
   * remains the final gate on every order. Per-pair edge-triggers
   * (rt.sweepDir) keep a standing oracle read from being re-fired bar after
   * bar; the first sweep after arm only RECORDS baseline reads (arm-time
   * backfill) so the bot never enters the stale middle of a move. */
  private async sweepUniverseForBot(bot: BotConfig): Promise<void> {
    const rt = this.runtime.get(bot.id) ?? this.buildRuntime(bot.id)
    const dayKey = new Date().toISOString().slice(0, 10)

    // daily rollover (same contract as tradeForBot)
    if (rt.dayKey !== dayKey) {
      rt.dayKey = dayKey
      rt.trades = 0
      rt.wins = 0
      rt.losses = 0
      rt.pnlToday = 0
      rt.streak = 0
    }

    // compound stop-on-loss / periods-complete halt (identical wording to
    // tradeForBot - an operator reading alerts should never learn two dialects)
    if (bot.stakePlan?.kind === 'compound' && bot.stakePlan.stopOnLoss !== false && rt.halted) {
      return this.reject(
        bot,
        rt.complete
          ? `compound cycle COMPLETE (${rt.rollN}/${bot.stakePlan.periods ?? '?'} periods banked) - restart for a fresh cycle`
          : 'compound cycle ended on a loss - restart to trade again',
      )
    }

    // burst guard: several assets' same-tf bars close within milliseconds and
    // sweptBars de-dups by barTime, but lazy-seeded feeds can emit slightly
    // different barTimes for the same wall-clock bar - this 5s floor makes
    // double-sweeps structurally impossible even then
    if (Date.now() - rt.lastSweepTs < 5000) return
    rt.lastSweepTs = Date.now()

    // session window gate (UTC)
    if (bot.session && bot.session !== 'all' && !inSession(bot.session)) {
      return this.reject(bot, `outside ${bot.session} session (${SESSION_WINDOWS[bot.session].label})`)
    }

    // per-bot circuit breakers
    if (bot.dailyProfitTarget && bot.dailyProfitTarget > 0 && rt.pnlToday >= bot.dailyProfitTarget) {
      return this.reject(bot, `profit target reached (+$${rt.pnlToday.toFixed(2)})`)
    }
    if (bot.dailyLossLimit && bot.dailyLossLimit > 0 && rt.pnlToday <= -bot.dailyLossLimit) {
      return this.reject(bot, `daily loss limit hit (-$${Math.abs(rt.pnlToday).toFixed(2)})`)
    }
    if (rt.openCount >= bot.maxOpen) return this.reject(bot, `max open positions (${bot.maxOpen})`)
    if (bot.cooldownSec > 0 && rt.lastTradeTs > 0 && Math.floor(Date.now() / 1000) - rt.lastTradeTs < bot.cooldownSec) {
      return this.reject(bot, 'cooldown between trades')
    }

    // streak-breaker bench (same ladder as the watchlist bots)
    if (bot.streakBreaker && rt.benchedUntil && Math.floor(Date.now() / 1000) < rt.benchedUntil) {
      const left = Math.ceil((rt.benchedUntil - Math.floor(Date.now() / 1000)) / 60)
      return this.reject(bot, `streak-breaker bench: ${left}min left (after ${Math.abs(Math.min(rt.streak, -1))} losses in a row)`)
    }

    // mode gate: HUMAN-IN-THE-LOOP suspends sweep autonomy too
    try {
      const mode = this.ctx.use<{ gate: (origin: 'bot' | 'auto') => { ok: boolean; reason?: string } }>('mode')
      const m = mode.gate('bot')
      if (!m.ok) return this.reject(bot, m.reason ?? 'mode gate hold')
    } catch {
      // mode plugin not loaded - gate disabled
    }

    // watchdog gate: strategy-health ladder
    try {
      const wd = this.ctx.use<{ preTrade: (botId: string) => { ok: boolean; reason?: string } }>('watchdog')
      const w = wd.preTrade(bot.id)
      if (!w.ok) return this.reject(bot, w.reason ?? 'watchdog health hold')
    } catch {
      // watchdog plugin not loaded - health gating disabled
    }

    // pull the whole board - every open instrument, one fused oracle read per
    // pair, already ranked by tradability (confidence x |P(up)-0.5|)
    let scan: GlobalScanResult
    try {
      const nc = this.ctx.use<{ globalScan: (tf: Timeframe, opts?: { limit?: number }) => GlobalScanResult }>('nextcandle')
      scan = nc.globalScan(bot.tf, { limit: 150 })
    } catch {
      return this.reject(bot, 'next-candle oracle unavailable - universe sweep offline')
    }
    const live: GlobalScanRow[] = scan.rows.filter((r) => r.ok)
    if (!live.length) {
      return this.reject(bot, `universe sweep: board still warming up (${scan.warming} pair(s) need 320+ closed bars on ${bot.tf})`)
    }

    // lapse re-arm: an asset whose read collapsed to 'none' frees its
    // edge-trigger, exactly like evalOut.direction === 'none' does for the
    // watchlist bots
    for (const row of live) {
      if (row.direction === 'none' && rt.sweepDir.has(row.asset)) rt.sweepDir.delete(row.asset)
    }

    // gate levels: the strategy's own minConfidence param (oracle-fusion
    // convention) AND the bot's minScore slider both apply - the stricter wins
    const minConfParam = Number(bot.params?.minConfidence)
    const minConf = Math.max(bot.minScore, Number.isFinite(minConfParam) ? minConfParam : 0)
    const minEdgeParam = Number(bot.params?.minEdge)
    const minEdgePp = Number.isFinite(minEdgeParam) ? minEdgeParam : 5

    // ARM-TIME BACKFILL: the first sweep after (re)arm only RECORDS the
    // standing board - every qualifying read was already true before the bot
    // existed, so trading it would be entering the stale middle of a move
    // (the same failure mode the watchlist bots' backfill kills)
    if (!rt.sweepBackfilled) {
      for (const row of live) {
        if (row.direction !== 'none') rt.sweepDir.set(row.asset, row.direction === 'call' ? 'call' : 'put')
      }
      rt.sweepBackfilled = true
      return this.reject(
        bot,
        `universe sweep baseline recorded (${rt.sweepDir.size} standing reads) - next sweep fires on FRESH edges only`,
      )
    }

    const maxTrades = bot.sweepMaxTrades ?? 1
    let taken = 0
    let firstBlock = ''
    for (let i = 0; i < live.length; i++) {
      const row = live[i]
      if (taken >= maxTrades) break
      if (row.direction === 'none') continue
      const wanted: 'call' | 'put' = row.direction === 'call' ? 'call' : 'put'
      const edgePp = Math.abs(row.pUp - 0.5) * 100
      // per-pair edge-trigger de-dup: same direction still standing = same
      // signal, not a fresh one
      if (rt.sweepDir.get(row.asset) === wanted) continue
      if (bot.direction !== 'both' && bot.direction !== wanted) continue
      if (row.confidence < minConf) {
        if (!firstBlock) firstBlock = `${row.asset} conf ${row.confidence.toFixed(0)}% < floor ${minConf}%`
        continue
      }
      if (edgePp < minEdgePp) {
        if (!firstBlock) firstBlock = `${row.asset} edge ${edgePp.toFixed(1)}pp < ${minEdgePp}pp`
        continue
      }
      // payout floor (the EV gate) on this pair's LIVE payout
      const livePay = this.payoutFor(row.asset, bot.kind)
      if ((bot.minPayoutPct ?? 0) > 0 && livePay > 0 && livePay * 100 < bot.minPayoutPct!) {
        if (!firstBlock)
          firstBlock = `${row.asset} payout ${(livePay * 100).toFixed(0)}% < ${bot.minPayoutPct}% floor (BE ${(100 / (1 + livePay)).toFixed(1)}%)`
        continue
      }
      // regime gate, read straight off the board's own classification
      if (bot.regime === 'trend' && row.regime !== 'TRENDING') continue
      if (bot.regime === 'range' && row.regime !== 'RANGING') continue
      if (bot.regime === 'avoid-volatile' && row.regime === 'VOLATILE') continue
      // OTC defense gate: generator-driven pairs stay off-limits unless this
      // strategy beat its calibrated placebo (cheap persisted-verdict lookup)
      try {
        const guard = this.ctx.use<{ check: (target: { asset: string }, strategyKey: string) => { ok: boolean; reason?: string } }>('otcGuard')
        const g = guard.check({ asset: row.asset }, bot.strategyId)
        if (!g.ok) {
          if (!firstBlock) firstBlock = `${row.asset}: ${g.reason ?? 'OTC defense gate hold'}`
          continue
        }
      } catch {
        // otc guard plugin not loaded - OTC gating disabled
      }
      // stake + compound over-bet guard (identical to tradeForBot)
      const bet = this.stakeFor(bot, rt)
      if (bet.compound && bet.pot >= 0.01 && bet.amount > bet.pot) {
        return this.reject(
          bot,
          `compound pot $${bet.pot.toFixed(2)} is below the $1 broker minimum stake - restart the cycle to re-seed`,
        )
      }
      // copilot memory gate on the REAL bet amount
      try {
        const mg = this.ctx.use<{ check: (asset: string, stake: number) => { ok: boolean; reason?: string } }>('memoryGate')
        const g = mg.check(row.asset, bet.amount)
        if (!g.ok) {
          if (!firstBlock) firstBlock = `${row.asset}: ${g.reason ?? 'memory gate hold'}`
          continue
        }
      } catch {
        // memory gate plugin not loaded - rule gating disabled
      }
      // adaptive confidence gate: this exact (pair, tf, strategy, side,
      // score-bucket[, regime][, session]) setup needs its own proven record
      if (bot.adaptive !== false) {
        try {
          const adaptive = this.ctx.use<{
            config: { enabled: boolean }
            check: (asset: string, tf: string, strategyId: string, side: string, score: number, regime?: string, session?: string, payout?: number) => { ok: boolean; reason?: string }
          }>('adaptive')
          if (adaptive.config.enabled) {
            const session = classifySession(Math.floor(Date.now() / 1000), row.asset)
            const v = adaptive.check(row.asset, bot.tf, bot.strategyId, wanted, row.confidence, row.regime, session, livePay || undefined)
            if (!v.ok) {
              if (!firstBlock) firstBlock = `${row.asset}: ${v.reason ?? 'adaptive confidence gate hold'}`
              continue
            }
          }
        } catch {
          // adaptive plugin not loaded - gate disabled
        }
      }

      // execute - the ExecutionService risk manager is the final gate
      const out = await this.exec.placeOrder({
        asset: row.asset,
        tf: bot.tf,
        side: wanted,
        kind: bot.kind,
        amount: bet.amount,
        expiryBars: bot.expiryBars,
        expirySec: bot.kind === 'digital' || bot.kind === 'blitz' ? bot.expirySec : undefined,
        mode: this.exec.accountSource === 'iq' ? 'live' : 'paper',
        strategy: bot.strategyId,
        note: `bot:${bot.id}`,
      })
      if (!out.ok) {
        if (!firstBlock) firstBlock = `${row.asset}: ${out.error ?? 'order rejected'}`
        continue
      }
      // edge-trigger stamp happens HERE (execution actually happened)
      rt.sweepDir.set(row.asset, wanted)
      rt.trades += 1
      rt.lastTradeTs = Math.floor(Date.now() / 1000)
      rt.lastRejection = undefined
      taken++
      const roll = bet.compound
        ? ` - compound ${bet.phase} roll x${bet.rollN + 1} (pot $${bet.pot.toFixed(2)})`
        : ''
      const payTag = livePay > 0 ? ` · pay ${(livePay * 100).toFixed(0)}% (BE ${(100 / (1 + livePay)).toFixed(1)}%)` : ''
      this.emit(
        'success',
        `[${bot.name}] SWEEP ${taken}/${maxTrades} ${wanted.toUpperCase()} ${row.asset} $${bet.amount.toFixed(2)} ${bot.kind} @ ${row.price.toFixed(5)} - oracle ${wanted} conf ${row.confidence.toFixed(0)}% edge ${edgePp.toFixed(1)}pp ${row.regime} (board rank ${i + 1}/${live.length}, P(up) ${(row.pUp * 100).toFixed(1)}%, ${row.driversActive} drivers)${roll}${payTag}`,
      )
    }

    if (taken === 0) {
      const top = live[0]
      this.reject(
        bot,
        `universe sweep: no fresh edge cleared the gates - strongest read ${top.asset} ${top.direction} conf ${top.confidence.toFixed(0)}% (floor ${minConf}%, edge floor ${minEdgePp}pp)${firstBlock ? `; last block: ${firstBlock}` : ''}`,
      )
    }
  }

  /** Normalize an incoming stake plan; undefined (or 'fixed') = classic fixed stake. */
  private parseStakePlan(raw: unknown, existing?: StakePlan): StakePlan | undefined {
    const p = (raw ?? existing) as Partial<StakePlan> | undefined
    if (!p || p.kind !== 'compound') return undefined
    return {
      kind: 'compound',
      base: clampNum(p.base ?? 1, 1, 5000),
      rollPct: p.rollPct !== undefined ? clampNum(p.rollPct, 1, 100) : undefined,
      maxStake: p.maxStake !== undefined ? clampNum(p.maxStake, 1, 5000) : undefined,
      payoutCap: p.payoutCap !== undefined ? clampNum(p.payoutCap, 1, 70) : undefined,
      stopOnLoss: p.stopOnLoss !== undefined ? Boolean(p.stopOnLoss) : undefined,
      periods: p.periods !== undefined ? Math.round(clampNum(p.periods, 1, 1000)) : undefined,
      deriskAfter: p.deriskAfter !== undefined ? Math.round(clampNum(p.deriskAfter, 1, 999)) : undefined,
      deriskPct: p.deriskPct !== undefined ? clampNum(p.deriskPct, 1, 100) : undefined,
      onComplete: p.onComplete === 'reseed' ? 'reseed' : p.onComplete === 'halt' ? 'halt' : undefined,
      reseedLimit: p.onComplete === 'reseed' && p.reseedLimit !== undefined && Number(p.reseedLimit) > 0 ? Math.round(clampNum(p.reseedLimit, 1, 100000)) : undefined,
      lossReseedLimit: p.stopOnLoss === false && p.lossReseedLimit !== undefined && Number(p.lossReseedLimit) > 0 ? Math.round(clampNum(p.lossReseedLimit, 1, 100000)) : undefined,
    }
  }

  /** Whitelist a session filter; anything unknown falls back to 'all'. */
  private validSession(raw: unknown): SessionFilter | undefined {
    const s = raw as SessionFilter | undefined
    if (!s || s === 'all') return undefined
    return SESSION_WINDOWS[s] ? s : undefined
  }

  /** Next stake for a bot: fixed bots always bet bot.stake; compound bots bet
   * rollPct% of the current pot (pot 0 = fresh cycle at base) - once the de-risk
   * threshold is crossed they bet deriskPct% instead. Returns the plan context
   * too so the trade alert can show the roll state and phase. */
  private stakeFor(bot: BotConfig, rt: RuntimeState): { amount: number; pot: number; rollN: number; compound: boolean; phase: 'compound' | 'derisk' } {
    const plan = bot.stakePlan?.kind === 'compound' ? bot.stakePlan : null
    if (!plan) return { amount: bot.stake, pot: 0, rollN: 0, compound: false, phase: 'compound' }
    // dust guard: a pot worth less than a cent is a fresh cycle
    const pot = rt.pot >= 0.01 ? rt.pot : plan.base
    const derisk = plan.deriskAfter !== undefined && plan.deriskPct !== undefined && rt.rollN >= plan.deriskAfter
    const rollPct = derisk ? plan.deriskPct! : (plan.rollPct ?? 100)
    const raw = (pot * rollPct) / 100
    const amount = Math.min(plan.maxStake ?? 5000, Math.max(1, Math.round(raw * 100) / 100))
    return { amount, pot, rollN: rt.rollN, compound: true, phase: derisk ? 'derisk' : 'compound' }
  }

  private static REJECT_REMIND_SEC = 300
  private reject(bot: BotConfig, reason: string): void {
    const rt = this.runtime.get(bot.id)
    if (!rt) return
    // Only surface a rejection once per distinct reason to avoid alert spam
    // - BUT an ongoing/unresolved rejection used to go permanently silent
    // after that first alert (no further log line, ever), which reads
    // exactly like "the bot stopped working" even though it's still ticking
    // and retrying every cycle. Re-emit periodically while the same reason
    // persists so a stuck condition stays visible instead of looking dead.
    const sameReason = rt.lastRejection === reason
    const dueForReminder = !rt.lastRejectionAt || Math.floor(Date.now() / 1000) - rt.lastRejectionAt >= AutopilotService.REJECT_REMIND_SEC
    rt.lastRejection = reason
    if (sameReason && !dueForReminder) return
    rt.lastRejectionAt = Math.floor(Date.now() / 1000)
    this.emit('info', `[${bot.name}] standing down: ${reason}`)
  }

  private emit(level: 'info' | 'warn' | 'danger' | 'success', message: string): void {
    this.ctx.bus.emit('alert', { level, message, ts: Math.floor(Date.now() / 1000) })
  }

  // ---------- stats ----------

  private onPositionOpened(position: Position): void {
    const botId = this.botIdOf(position)
    if (!botId) return
    const rt = this.runtime.get(botId)
    if (rt) rt.openCount += 1
  }

  private onPositionClosed(position: Position): void {
    const botId = this.botIdOf(position)
    if (!botId) return
    const rt = this.runtime.get(botId)
    if (!rt) return
    rt.openCount = Math.max(0, rt.openCount - 1)
    const pnl = position.pnl ?? 0
    rt.pnlTotal += pnl
    // Task 58 (P2): the day gate used rt.dayKey, which only rolls inside
    // tradeForBot - a position settling at 00:05 (before the bot's first
    // post-midnight evaluation) failed sameDay, then the rollover wiped the
    // counters: the close was dropped from the daily stats forever. Re-derive
    // the day from the close time like os-mode's rebuild does.
    const closeDay = new Date((position.tsClose ?? Math.floor(Date.now() / 1000)) * 1000).toISOString().slice(0, 10)
    const sameDay = rt.dayKey === closeDay && rt.dayKey === new Date().toISOString().slice(0, 10)
    if (position.status === 'won') {
      rt.wins += 1
      rt.streak = rt.streak >= 0 ? rt.streak + 1 : 1
      if (sameDay) rt.pnlToday += pnl
      rt.benchedUntil = undefined // a win ends a losing run - lift the bench
    } else if (position.status === 'lost') {
      rt.losses += 1
      rt.streak = rt.streak <= 0 ? rt.streak - 1 : -1
      if (sameDay) rt.pnlToday += pnl
    } else if (position.status === 'closed' && sameDay) {
      // manual early exits (status 'closed', any sign) used to vanish from
      // the bot's DAY pnl while still landing in pnlTotal - the daily loss
      // limit and profit target never saw them
      rt.pnlToday += pnl
    }
    // 'push' (Task 58): neutral refund - pnl 0, no win/loss, streak untouched
    // streak-breaker: 3+ consecutive losses bench the bot for a growing
    // window (15min at 3, doubling per extra loss, 4h cap). rt.streak was
    // JUST updated above, so a fresh 3rd loss lands here on the same event.
    const bot = this.store.listBots().find((b) => b.bot.id === botId)?.bot
    if (bot?.streakBreaker && position.status === 'lost' && rt.streak <= -3) {
      const benchSec = streakBenchSec(-rt.streak)
      rt.benchedUntil = Math.floor(Date.now() / 1000) + benchSec
      this.emit('warn', `[${bot.name}] streak-breaker: benched ${Math.round(benchSec / 60)}min after ${-rt.streak} losses in a row - the setup goes sour, the bot stands down on its own`)
    }
    // compounding roll: a win folds the payout into the pot, a loss burns the
    // stake out of it (full roll => pot hits 0 => next trade restarts at base)
    // Round to cents at EVERY fold: stakes are rounded to cents at open, and an
    // unrounded pot (3.7636) minus a rounded stake (3.76) leaves dust (0.0036)
    // that never reaches 0 - the cycle would then compound from dust forever.
    if (bot?.stakePlan?.kind === 'compound') {
      const base = bot.stakePlan.base
      const working = rt.pot >= 0.01 ? rt.pot : base
      if (position.status === 'won') {
        rt.lossReseedCount = 0
        // payout cap: fold in at most payoutCap% (default+max 70) of the stake
        // as profit - a broker paying more gets the excess skimmed to the
        // balance, never compounded into the pot
        const cap = (bot.stakePlan.payoutCap ?? 70) / 100
        const fold = Math.min(position.pnl ?? position.amount * position.payout, position.amount * cap)
        rt.pot = Math.round((working + fold) * 100) / 100
        rt.rollN += 1
        // periods target reached: the cycle is COMPLETE (win-side halt)
        const periods = bot.stakePlan.periods
        if (periods && rt.rollN >= periods) {
          rt.restarts += 1
          const banked = Math.round((rt.pot - base) * 100) / 100
          const reseedLimit = bot.stakePlan.reseedLimit
          const reseedsLeft = bot.stakePlan.onComplete === 'reseed' && reseedLimit ? reseedLimit - rt.reseedCount : Infinity
          if (bot.stakePlan.onComplete === 'reseed' && reseedsLeft > 0) {
            rt.pot = 0
            rt.rollN = 0
            rt.reseedCount += 1
            const limitTag = reseedLimit ? ` (re-seed ${rt.reseedCount}/${reseedLimit})` : ''
            this.emit('success', `[${bot.name}] compound cycle COMPLETE - ${periods} periods, +$${banked.toFixed(2)} banked - re-seeding $${base}${limitTag}`)
          } else {
            rt.halted = true
            rt.complete = true
            const why = bot.stakePlan.onComplete === 'reseed' ? `re-seed limit reached (${reseedLimit}/${reseedLimit})` : `${periods} periods`
            this.emit('success', `[${bot.name}] compound cycle COMPLETE - ${why}, +$${banked.toFixed(2)} banked - standing down; restart for a fresh cycle`)
          }
        }
      } else if (position.status === 'lost') {
        rt.pot = Math.round(Math.max(0, working - position.amount) * 100) / 100
        const kept = rt.pot
        if (rt.rollN > 0) rt.restarts += 1 // a winning streak ended
        rt.rollN = 0
        // stop-on-loss (default): the sequence is over - stand down until an
        // explicit bot_restart. stopOnLoss:false keeps the legacy re-seed roll.
        if (bot.stakePlan.stopOnLoss !== false) {
          rt.halted = true
          rt.complete = false
          this.emit('warn', `[${bot.name}] compound cycle ENDED on a loss (-$${Math.abs(position.pnl ?? 0).toFixed(2)})${kept >= 0.01 ? ` - $${kept.toFixed(2)} of the pot stays banked on the balance` : ''} - restart to trade again`)
        } else {
          // "On loss: Re-seed" - the bot normally just keeps rolling through
          // a loss, but lossReseedLimit caps how many losses in a row it
          // will silently absorb before forcing a stop anyway.
          rt.lossReseedCount += 1
          const lossReseedLimit = bot.stakePlan.lossReseedLimit
          if (lossReseedLimit && rt.lossReseedCount >= lossReseedLimit) {
            rt.halted = true
            rt.complete = false
            this.emit(
              'warn',
              `[${bot.name}] compound cycle FORCED TO STOP - ${rt.lossReseedCount}/${lossReseedLimit} consecutive losses while re-seeding (-$${Math.abs(position.pnl ?? 0).toFixed(2)} this one)${kept >= 0.01 ? ` - $${kept.toFixed(2)} of the pot stays banked on the balance` : ''} - restart to trade again`
            )
          }
        }
      }
      // survive restarts: persist the roll on the bot record (raw store write
      // - the validating saveBot would emit an alert every settle)
      this.store.saveBot({
        ...bot,
        planState: {
          pot: rt.pot,
          rollN: rt.rollN,
          restarts: rt.restarts,
          reseedCount: rt.reseedCount,
          lossReseedCount: rt.lossReseedCount,
          ...(rt.halted ? { halted: true } : {}),
          ...(rt.halted && rt.complete ? { complete: true } : {}),
        },
      })
    }
  }

  private botIdOf(position: Position): string | null {
    return position.note?.startsWith('bot:') ? position.note.slice(4) : null
  }

  /** Live payout for one ticker as a 0-1 fraction, 0 when the market service
   * can't answer (0 reads as "unknown" to the gates - permissive contract,
   * same as the auto-trader's payout floor). */
  private payoutFor(asset: string, kind: TradeKind): number {
    try {
      const pay = this.market.payoutFor(asset, kind)
      return typeof pay === 'number' && Number.isFinite(pay) && pay > 0 ? pay : 0
    } catch {
      return 0
    }
  }

  private buildRuntime(botId: string): RuntimeState {
    const cfg = this.store.listBots().find((b) => b.bot.id === botId)?.bot
    const rt: RuntimeState = {
      dayKey: new Date().toISOString().slice(0, 10),
      trades: 0,
      wins: 0,
      losses: 0,
      pnlToday: 0,
      pnlTotal: 0,
      openCount: 0,
      lastTradeTs: 0,
      streak: 0,
      pot: cfg?.planState?.pot ?? 0,
      rollN: cfg?.planState?.rollN ?? 0,
      restarts: cfg?.planState?.restarts ?? 0,
      reseedCount: cfg?.planState?.reseedCount ?? 0,
      lossReseedCount: cfg?.planState?.lossReseedCount ?? 0,
      halted: cfg?.planState?.halted ?? false,
      complete: cfg?.planState?.complete ?? false,
      // undefined, not null: a fresh runtime hasn't evaluated anything yet,
      // so the first candle close backfills the edge-trigger (arm-time
      // backfill) instead of trading an already-true condition
      lastSignalDir: undefined,
      sweepDir: new Map(),
      sweepBackfilled: false,
      lastSweepTs: 0,
    }
    const journal = this.store.botJournal(botId, 400)
    for (const p of journal) {
      if (p.status === 'open') {
        rt.openCount += 1
        continue
      }
      const pnl = p.pnl ?? 0
      rt.pnlTotal += pnl
      const day = new Date((p.tsClose ?? p.tsOpen) * 1000).toISOString().slice(0, 10)
      if (day === rt.dayKey) {
        rt.trades += 1
        if (p.status === 'won') {
          rt.wins += 1
          rt.pnlToday += pnl
        } else if (p.status === 'lost') {
          rt.losses += 1
          rt.pnlToday += pnl
        } else if (p.status === 'closed') {
          // mirror onPositionClosed: manual early exits count toward the day
          rt.pnlToday += pnl
        }
      }
    }
    // last trade timestamp from the freshest entry
    const lastTs = journal.reduce((acc, p) => Math.max(acc, p.tsOpen), 0)
    rt.lastTradeTs = lastTs
    // streak from the most recent closed trades
    let streak = 0
    const closed = journal.filter((p) => p.status === 'won' || p.status === 'lost')
    for (const p of closed) {
      if (streak === 0) streak = p.status === 'won' ? 1 : -1
      else if (streak > 0 && p.status === 'won') streak += 1
      else if (streak < 0 && p.status === 'lost') streak -= 1
      else break
    }
    rt.streak = streak
    return rt
  }

  private statsFor(botId: string): BotStats {
    const rt = this.runtime.get(botId)
    if (rt) {
      const sameDay = rt.dayKey === new Date().toISOString().slice(0, 10)
      return {
        trades: sameDay ? rt.trades : 0,
        wins: sameDay ? rt.wins : 0,
        losses: sameDay ? rt.losses : 0,
        pnlToday: sameDay ? rt.pnlToday : 0,
        pnlTotal: rt.pnlTotal,
        openCount: rt.openCount,
        lastTradeTs: rt.lastTradeTs,
        streak: rt.streak,
        pot: rt.pot,
        rollN: rt.rollN,
        restarts: rt.restarts,
        reseedCount: rt.reseedCount,
        lossReseedCount: rt.lossReseedCount,
        halted: rt.halted,
        complete: rt.complete,
        lastRejection: rt.lastRejection,
        quietNote: sameDay ? rt.quietNote : undefined,
      }
    }
    const fresh = this.buildRuntime(botId)
    this.runtime.set(botId, fresh)
    return {
      trades: fresh.trades,
      wins: fresh.wins,
      losses: fresh.losses,
      pnlToday: fresh.pnlToday,
      pnlTotal: fresh.pnlTotal,
      openCount: fresh.openCount,
      lastTradeTs: fresh.lastTradeTs,
      streak: fresh.streak,
      pot: fresh.pot,
      rollN: fresh.rollN,
      restarts: fresh.restarts,
      reseedCount: fresh.reseedCount,
      lossReseedCount: fresh.lossReseedCount,
      halted: fresh.halted,
      complete: fresh.complete,
      lastRejection: fresh.lastRejection,
      quietNote: fresh.quietNote,
    }
  }

  private validStrategy(id: string): string {
    if (getStrategy(id)) return id
    // AI-learned strategies from the Strategy Lab (custom:<slug>) are valid
    // when they exist in the lab library
    if (id.startsWith('custom:') && this.labService()?.isValidStrategyId(id)) return id
    return DEFAULT_BOT.strategyId
  }

  private isValidStrategy(id: string): boolean {
    if (getStrategy(id)) return true
    if (id.startsWith('custom:')) return this.labService()?.isValidStrategyId(id) ?? false
    return false
  }
}

const clampNum = (v: number, lo: number, hi: number) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

let active: AutopilotService | null = null

export const autopilotPlugin: Plugin = {
  name: 'autopilot',
  start: async (ctx) => {
    const svc = new AutopilotService()
    active = svc
    ctx.provide('autopilot', svc)
    await svc.start(ctx)
  },
  stop: () => {
    active?.stop()
    active = null
  },
}
