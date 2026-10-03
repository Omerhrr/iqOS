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
import { walkForward } from '../strategies/optimize'

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
  /** Explicit time expiry in seconds (e.g. 900 = 15 minutes) for digital
   * bots - independent of the timeframe, settles at an exact timestamp.
   * Undefined = kind default (5m for digital). */
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
  planState?: { pot: number; rollN: number; restarts: number; halted?: boolean; complete?: boolean }
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
}

export type SessionFilter = 'all' | 'london' | 'newyork' | 'overlap' | 'asia' | 'sydney'

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
  halted: boolean // compound stop-on-loss: cycle ended, awaiting restart
  complete: boolean // halted because the periods target was reached (a WIN, not a loss)
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
  pot: number // compounding roll; 0 = fresh cycle at base
  rollN: number
  restarts: number
  halted: boolean // stop-on-loss: cycle ended, awaiting explicit restart
  complete: boolean // halted on the periods target (win-side completion)
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

    // seed runtime stats from persisted journal so restarts keep their day/total numbers
    for (const { bot } of this.store.listBots()) this.runtime.set(bot.id, this.buildRuntime(bot.id))

    this.unsubscribers.push(
      ctx.bus.on('candle', ({ asset, tf, closed }) => {
        if (closed) void this.onCandleClose(asset, tf)
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

  /** Research gate: every watchlist instrument must have a RECENT robust
   * walk-forward verdict for this exact (asset, tf, strategyId) before a bot
   * is allowed to arm - mirrors the kalman-ou auto-trader's requireValidation
   * check in os-mode.ts, generalized to any strategy via the `validations`
   * table (POST /walkforward writes one on every run). Returns null when
   * clear to arm, or a `research-gate: ...` reason string when blocked. */
  private researchGate(bot: BotConfig): string | null {
    const MAX_AGE_SEC = 14 * 24 * 60 * 60 // 14 days - a stale pass doesn't mean much. v.ts is UNIX SECONDS (store.ts), not ms.
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
    const candles = this.market.getCandlesDeep(asset, tf, 2200)
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

  saveBot(input: Partial<BotConfig>): { ok: boolean; bot?: BotConfig; error?: string } {
    const id = input.id?.trim() || `bot-${Math.random().toString(36).slice(2, 8)}`
    const existing = this.store.listBots().find((b) => b.bot.id === id)?.bot
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
      kind: (input.kind ?? existing?.kind ?? DEFAULT_BOT.kind) as TradeKind,
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
          ? Math.round(clampNum(input.expirySec ?? existing?.expirySec ?? 300, 60, 86400))
          : undefined,
      session: this.validSession(input.session ?? existing?.session),
      stakePlan: this.parseStakePlan(input.stakePlan, existing?.stakePlan),
      adaptive: input.adaptive !== undefined ? Boolean(input.adaptive) : existing?.adaptive,
    }
    // a materially different plan invalidates the persisted roll - start clean
    const planChanged = JSON.stringify(bot.stakePlan ?? null) !== JSON.stringify(existing?.stakePlan ?? null)
    bot.planState = planChanged ? undefined : input.planState ?? existing?.planState
    if (!bot.watchlist.length) return { ok: false, error: 'watchlist needs at least one valid instrument' }
    if (!this.isValidStrategy(bot.strategyId)) return { ok: false, error: `unknown strategy ${bot.strategyId}` }
    // research gate: only check when this save is what's arming the bot (new
    // enable, not every edit to an already-running one) so a stake tweak on a
    // live bot doesn't get blocked by a validation that's since gone stale.
    if (bot.enabled && !(existing?.enabled ?? false)) {
      const gate = this.researchGate(bot)
      if (gate) return { ok: false, error: gate }
    }
    this.store.saveBot(bot)
    if (!this.runtime.has(id)) this.runtime.set(id, this.buildRuntime(id))
    this.emit(bot.enabled ? 'success' : 'info', `Bot "${bot.name}" saved - ${bot.enabled ? 'ARMED' : 'idle'} (${bot.strategyId} · ${bot.tf} · ${bot.watchlist.join(', ')})`)
    return { ok: true, bot }
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
    rt.lastRejection = undefined
    this.store.saveBot({ ...bot, planState: { pot: 0, rollN: 0, restarts: rt.restarts } })
    this.emit('success', `[${bot.name}] compound cycle RESTARTED - next trade seeds $${bot.stakePlan.base}`)
    return { ok: true, bot: this.store.listBots().find((b) => b.bot.id === id)?.bot }
  }

  toggleBot(id: string, enabled?: boolean): { ok: boolean; bot?: BotConfig; error?: string } {
    const found = this.store.listBots().find((b) => b.bot.id === id)
    if (!found) return { ok: false, error: 'bot not found' }
    const bot: BotConfig = { ...found.bot, enabled: enabled ?? !found.bot.enabled }
    if (bot.enabled && !found.bot.enabled) {
      const gate = this.researchGate(bot)
      if (gate) return { ok: false, error: gate }
    }
    this.store.saveBot(bot)
    this.emit(bot.enabled ? 'success' : 'info', `Autopilot "${bot.name}" ${bot.enabled ? 'STARTED' : 'STOPPED'} - watching ${bot.watchlist.join(', ')} on ${bot.tf} (${bot.strategyId})`)
    return { ok: true, bot }
  }

  // ---------- trading loop ----------

  private async onCandleClose(asset: string, tf: Timeframe): Promise<void> {
    const bots = this.store.listBots().filter(
      (b) => b.bot.enabled && b.bot.tf === tf && b.bot.watchlist.includes(asset)
    )
    if (!bots.length) return
    const key = `${asset}|${tf}`
    if (this.evaluating.has(key)) return
    this.evaluating.add(key)
    try {
      for (const { bot } of bots) {
        try {
          await this.tradeForBot(bot, asset, tf)
        } catch (err) {
          // strategy evaluation can throw on thin history - log quietly
          this.ctx.log('autopilot', `${bot.name} ${asset} eval failed:`, (err as Error).message)
        }
      }
    } finally {
      this.evaluating.delete(key)
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
    // autonomy - manual trading stays free, rules govern the machines only
    try {
      const mg = this.ctx.use<{ check: (asset: string, stake: number) => { ok: boolean; reason?: string } }>('memoryGate')
      const g = mg.check(asset, bot.stake)
      if (!g.ok) return this.reject(bot, g.reason ?? 'memory gate hold')
    } catch {
      // memory gate plugin not loaded - rule gating disabled
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
    if (evalOut.direction === 'none') return
    if (Math.abs(evalOut.score) < bot.minScore) {
      return this.reject(bot, `score ${evalOut.score.toFixed(0)} below min ${bot.minScore}`)
    }
    const wanted = evalOut.direction === 'call' ? 'call' : 'put'
    if (bot.direction !== 'both' && bot.direction !== wanted) {
      return this.reject(bot, `signal ${wanted} outside allowed direction (${bot.direction})`)
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
    // score-bucket[, regime]) setup only fires if ITS OWN settled record
    // (Wilson lower bound, not the raw ratio) clears the fleet floor - see
    // adaptive.ts for why this is the honest way to chase a higher win rate
    // instead of a curve-fit backtest number.
    if (bot.adaptive !== false) {
      try {
        const adaptive = this.ctx.use<{ config: { enabled: boolean }; check: (asset: string, tf: string, strategyId: string, side: string, score: number, regime?: string) => { ok: boolean; reason?: string } }>('adaptive')
        if (adaptive.config.enabled) {
          let regime: string | undefined
          try {
            regime = classifyRegime(this.analytics.analyze(asset, tf))
          } catch {
            regime = undefined
          }
          const v = adaptive.check(asset, tf, bot.strategyId, wanted, evalOut.score, regime)
          if (!v.ok) return this.reject(bot, v.reason ?? 'adaptive confidence gate hold')
        }
      } catch {
        // adaptive plugin not loaded - gate disabled
      }
    }

    // execute - the ExecutionService risk manager is the final gate
    const bet = this.stakeFor(bot, rt)
    const out = await this.exec.placeOrder({
      asset,
      tf,
      side: wanted,
      kind: bot.kind,
      amount: bet.amount,
      expiryBars: bot.expiryBars,
      expirySec: bot.kind === 'digital' ? bot.expirySec : undefined,
      mode: 'paper',
      strategy: bot.strategyId,
      note: `bot:${bot.id}`,
    })

    if (!out.ok) return this.reject(bot, out.error ?? 'order rejected')

    rt.trades += 1
    rt.lastTradeTs = Math.floor(Date.now() / 1000)
    rt.lastRejection = undefined
    const periodsTag = bot.stakePlan?.periods ? `/${bot.stakePlan.periods}` : ''
    const roll = bet.compound
      ? ` - compound ${bet.phase} roll x${bet.rollN + 1}${periodsTag} (pot $${bet.pot.toFixed(2)}, stake $${bet.amount.toFixed(2)})`
      : ''
    this.emit('success', `[${bot.name}] ${wanted.toUpperCase()} ${asset} $${bet.amount} ${bot.kind} @ ${evalOut.price.toFixed(5)} - ${evalOut.notes} (score ${evalOut.score.toFixed(0)})${roll}`)
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

  private reject(bot: BotConfig, reason: string): void {
    const rt = this.runtime.get(bot.id)
    // only surface a rejection once per distinct reason to avoid alert spam
    if (!rt || rt.lastRejection === reason) return
    rt.lastRejection = reason
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
    const sameDay = rt.dayKey === new Date().toISOString().slice(0, 10)
    if (position.status === 'won') {
      rt.wins += 1
      rt.streak = rt.streak >= 0 ? rt.streak + 1 : 1
      if (sameDay) rt.pnlToday += pnl
    } else if (position.status === 'lost') {
      rt.losses += 1
      rt.streak = rt.streak <= 0 ? rt.streak - 1 : -1
      if (sameDay) rt.pnlToday += pnl
    }
    // compounding roll: a win folds the payout into the pot, a loss burns the
    // stake out of it (full roll => pot hits 0 => next trade restarts at base)
    // Round to cents at EVERY fold: stakes are rounded to cents at open, and an
    // unrounded pot (3.7636) minus a rounded stake (3.76) leaves dust (0.0036)
    // that never reaches 0 - the cycle would then compound from dust forever.
    const bot = this.store.listBots().find((b) => b.bot.id === botId)?.bot
    if (bot?.stakePlan?.kind === 'compound') {
      const base = bot.stakePlan.base
      const working = rt.pot >= 0.01 ? rt.pot : base
      if (position.status === 'won') {
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
          if (bot.stakePlan.onComplete === 'reseed') {
            rt.pot = 0
            rt.rollN = 0
            this.emit('success', `[${bot.name}] compound cycle COMPLETE - ${periods} periods, +$${banked.toFixed(2)} banked - re-seeding $${base}`)
          } else {
            rt.halted = true
            rt.complete = true
            this.emit('success', `[${bot.name}] compound cycle COMPLETE - ${periods} periods, +$${banked.toFixed(2)} banked - standing down; restart for a fresh cycle`)
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
          ...(rt.halted ? { halted: true } : {}),
          ...(rt.halted && rt.complete ? { complete: true } : {}),
        },
      })
    }
  }

  private botIdOf(position: Position): string | null {
    return position.note?.startsWith('bot:') ? position.note.slice(4) : null
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
      halted: cfg?.planState?.halted ?? false,
      complete: cfg?.planState?.complete ?? false,
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
        halted: rt.halted,
        complete: rt.complete,
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
      halted: fresh.halted,
      complete: fresh.complete,
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
