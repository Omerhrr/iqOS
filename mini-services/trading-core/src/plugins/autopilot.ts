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
  minScore: number
  direction: 'both' | 'call' | 'put'
  regime: 'all' | 'trend' | 'range'
  maxOpen: number
  cooldownSec: number
  dailyProfitTarget?: number
  dailyLossLimit?: number
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
    ctx.log('autopilot', `bot engine online (${this.runtime.size} bots registered)`)
  }

  stop(): void {
    for (const u of this.unsubscribers) u()
    this.unsubscribers = []
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
    }
    if (!bot.watchlist.length) return { ok: false, error: 'watchlist needs at least one valid instrument' }
    if (!getStrategy(bot.strategyId)) return { ok: false, error: `unknown strategy ${bot.strategyId}` }
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

  toggleBot(id: string, enabled?: boolean): { ok: boolean; bot?: BotConfig; error?: string } {
    const found = this.store.listBots().find((b) => b.bot.id === id)
    if (!found) return { ok: false, error: 'bot not found' }
    const bot: BotConfig = { ...found.bot, enabled: enabled ?? !found.bot.enabled }
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

    // strategy evaluation (pure, on closed candles)
    const merged = { ...defaultParams(getStrategy(bot.strategyId)!), ...(bot.params ?? {}) }
    const evalOut = this.analytics.runStrategy(asset, tf, bot.strategyId, merged)
    if (evalOut.direction === 'none') return
    if (Math.abs(evalOut.score) < bot.minScore) {
      return this.reject(bot, `score ${evalOut.score.toFixed(0)} below min ${bot.minScore}`)
    }
    const wanted = evalOut.direction === 'call' ? 'call' : 'put'
    if (bot.direction !== 'both' && bot.direction !== wanted) {
      return this.reject(bot, `signal ${wanted} outside allowed direction (${bot.direction})`)
    }

    // regime gate from the cached full analysis
    if (bot.regime !== 'all') {
      try {
        const a = this.analytics.analyze(asset, tf)
        const r = a.markov.regime
        const trending = r === 'bull' || r === 'bear'
        if (bot.regime === 'trend' && !trending) return this.reject(bot, `regime ${r} not trending`)
        if (bot.regime === 'range' && trending) return this.reject(bot, `regime ${r} not ranging`)
      } catch {
        return this.reject(bot, 'regime unavailable (thin history)')
      }
    }

    // execute - the ExecutionService risk manager is the final gate
    const out = await this.exec.placeOrder({
      asset,
      tf,
      side: wanted,
      kind: bot.kind,
      amount: bot.stake,
      expiryBars: bot.expiryBars,
      mode: 'paper',
      strategy: bot.strategyId,
      note: `bot:${bot.id}`,
    })

    if (!out.ok) return this.reject(bot, out.error ?? 'order rejected')

    rt.trades += 1
    rt.lastTradeTs = Math.floor(Date.now() / 1000)
    rt.lastRejection = undefined
    this.emit('success', `[${bot.name}] ${wanted.toUpperCase()} ${asset} $${bot.stake} ${bot.kind} @ ${evalOut.price.toFixed(5)} - ${evalOut.notes} (score ${evalOut.score.toFixed(0)})`)
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
  }

  private botIdOf(position: Position): string | null {
    return position.note?.startsWith('bot:') ? position.note.slice(4) : null
  }

  private buildRuntime(botId: string): RuntimeState {
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
    }
  }

  private validStrategy(id: string): string {
    return getStrategy(id) ? id : DEFAULT_BOT.strategyId
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
