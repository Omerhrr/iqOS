// IQAIR//OS - Watchdog plugin (strategy health & drift guardian)
// The missing OS layer between research and reality: research validates an
// edge, autopilot deploys it, sentinel protects the account - the watchdog
// makes sure the edge is still ALIVE after deployment. Markets drift, and a
// bot that backtested at 62% win rate can quietly bleed at 40%.
//
// Per-bot rolling metrics (win rate, profit factor, loss streak, P&L
// drawdown from the bot's peak) are compared against a baseline:
//   1. per-bot override (set from research promotion or the panel)
//   2. the bot's own all-time record (self-consistent drift detection)
//   3. the fleet default (expectedWinRatePct)
// Drift escalates through a response ladder:
//   0 HEALTHY -> 1 WATCH (alert) -> 2 HOLD (pre-trade block, timed)
//   -> 3 DISARMED (bot stopped, ack + re-arm required)
// Recovery from WATCH is automatic when the window heals; HOLD self-clears
// at re-evaluation if the window recovered; DISARMED needs an explicit ack.
// All state is persisted, so restarts keep every bot's health history.

import type { Plugin, KernelContext } from '../kernel'
import type { Store } from '../store'
import type { Position } from '../types'

export interface WatchdogConfig {
  windowTrades: number // rolling settlement window per bot
  minTrades: number // window needs this many settlements before judging
  winRateFloorPct: number // absolute rolling win-rate floor (%)
  winRateDriftPct: number // rolling WR must stay within baseline - drift
  profitFactorFloor: number // rolling profit-factor floor (0 = off)
  maxConsecLosses: number // consecutive losses that trip WATCH (0 = off)
  graceTrades: number // degraded settlements tolerated before HOLD
  holdMinutes: number // HOLD duration before the next pre-trade re-evaluation
  botDrawdownUsd: number // drop from the bot's P&L peak that trips WATCH (0 = off)
  autoDisarm: boolean // HOLD that re-evaluates still-degraded disarms the bot
  expectedWinRatePct: number // fleet-default baseline when no better baseline exists
}

export const DEFAULT_WATCHDOG: WatchdogConfig = {
  windowTrades: 30,
  minTrades: 10,
  winRateFloorPct: 38,
  winRateDriftPct: 12,
  profitFactorFloor: 0.7,
  maxConsecLosses: 6,
  graceTrades: 5,
  holdMinutes: 30,
  botDrawdownUsd: 0,
  autoDisarm: true,
  expectedWinRatePct: 55,
}

export const LEVEL_LABELS = ['HEALTHY', 'WATCH', 'HOLD', 'DISARMED'] as const

interface WindowTrade {
  ts: number
  won: boolean
  pnl: number
  asset: string
}

export interface BotHealthState {
  botId: string
  level: 0 | 1 | 2 | 3
  reason: string
  sinceTs: number
  holdUntil: number
  window: WindowTrade[]
  degradedStreak: number
  totalTrades: number
  totalWins: number
  cumPnl: number
  peakPnl: number
  acks: number
  baselineOverridePct: number // 0 = no override
  lastAlertKey: string
}

export interface BotMetrics {
  windowSize: number
  trades: number
  wins: number
  winRatePct: number
  pf: number
  netPnl: number
  consecLosses: number
  baselinePct: number
  totalTrades: number
  totalWins: number
  cumPnl: number
  peakPnl: number
  ddFromPeak: number
}

interface AutopilotLike {
  listBots(): { bot: { id: string; name: string; enabled: boolean; strategyId: string; tf: string } }[]
  toggleBot(id: string, enabled?: boolean): unknown
}

function freshState(botId: string): BotHealthState {
  return {
    botId,
    level: 0,
    reason: '',
    sinceTs: 0,
    holdUntil: 0,
    window: [],
    degradedStreak: 0,
    totalTrades: 0,
    totalWins: 0,
    cumPnl: 0,
    peakPnl: 0,
    acks: 0,
    baselineOverridePct: 0,
    lastAlertKey: '',
  }
}

export class WatchdogService {
  private ctx!: KernelContext
  private store!: Store
  private unsubscribers: (() => void)[] = []
  config: WatchdogConfig = { ...DEFAULT_WATCHDOG }
  private states = new Map<string, BotHealthState>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.store = ctx.use<Store>('store')
    this.restore()

    this.unsubscribers.push(
      ctx.bus.on('positionClosed', ({ position }) => this.onPositionClosed(position))
    )
    ctx.log('watchdog', `strategy health guardian online (${this.states.size} bots tracked)`)
  }

  stop(): void {
    for (const u of this.unsubscribers) u()
    this.unsubscribers = []
  }

  private now(): number {
    return Math.floor(Date.now() / 1000)
  }

  // ---------- persistence ----------

  private restore(): void {
    const savedCfg = this.store.getWatchdogConfig()
    if (savedCfg) this.config = { ...DEFAULT_WATCHDOG, ...(savedCfg as Partial<WatchdogConfig>) }
    for (const row of this.store.getWatchdogStates()) {
      try {
        const s = row.state as Partial<BotHealthState>
        if (!s || typeof s !== 'object' || !row.botId) continue
        this.states.set(row.botId, { ...freshState(row.botId), ...s, botId: row.botId })
      } catch {
        // skip malformed state
      }
    }
  }

  private persist(state: BotHealthState): void {
    this.store.saveWatchdogState(state.botId, state)
  }

  private event(botId: string, kind: string, message: string, level: 'info' | 'warn' | 'danger' | 'success' = 'info'): void {
    this.store.recordWatchdogEvent(botId, kind, message, this.now())
    this.ctx.bus.emit('alert', { level, message, ts: this.now() })
  }

  // ---------- metrics ----------

  private botName(botId: string): string {
    try {
      const bots = this.ctx.use<AutopilotLike>('autopilot')
      return bots.listBots().find((b) => b.bot.id === botId)?.bot.name ?? botId
    } catch {
      return botId
    }
  }

  private baselineOf(s: BotHealthState): number {
    if (s.baselineOverridePct > 0) return s.baselineOverridePct
    // the bot's own all-time record is the most honest baseline once it has
    // enough history; before that, fall back to the fleet default
    if (s.totalTrades >= this.config.minTrades * 3) {
      return Math.round((s.totalWins / s.totalTrades) * 1000) / 10
    }
    return this.config.expectedWinRatePct
  }

  private metricsOf(s: BotHealthState): BotMetrics {
    const w = s.window
    const wins = w.filter((t) => t.won).length
    const grossWin = w.filter((t) => t.pnl > 0).reduce((a, b) => a + b.pnl, 0)
    const grossLoss = Math.abs(w.filter((t) => t.pnl < 0).reduce((a, b) => a + b.pnl, 0))
    let consec = 0
    for (let i = w.length - 1; i >= 0; i--) {
      if (!w[i].won) consec++
      else break
    }
    return {
      windowSize: w.length,
      trades: w.length,
      wins,
      winRatePct: w.length ? Math.round((wins / w.length) * 1000) / 10 : 0,
      pf: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 99 : 0,
      netPnl: Math.round(w.reduce((a, b) => a + b.pnl, 0) * 100) / 100,
      consecLosses: consec,
      baselinePct: this.baselineOf(s),
      totalTrades: s.totalTrades,
      totalWins: s.totalWins,
      cumPnl: Math.round(s.cumPnl * 100) / 100,
      peakPnl: Math.round(s.peakPnl * 100) / 100,
      ddFromPeak: Math.round(Math.max(0, s.peakPnl - s.cumPnl) * 100) / 100,
    }
  }

  /** First failing rule wins (used as the degradation reason). */
  private classify(s: BotHealthState, m: BotMetrics): { degraded: boolean; key: string; reason: string } {
    const cfg = this.config
    if (cfg.maxConsecLosses > 0 && m.consecLosses >= cfg.maxConsecLosses) {
      return { degraded: true, key: `streak:${m.consecLosses}`, reason: `${m.consecLosses} consecutive losses (max ${cfg.maxConsecLosses})` }
    }
    if (cfg.botDrawdownUsd > 0 && m.ddFromPeak >= cfg.botDrawdownUsd) {
      return { degraded: true, key: 'botdd', reason: `P&L $${m.cumPnl.toFixed(2)} is $${m.ddFromPeak.toFixed(2)} below its $${m.peakPnl.toFixed(2)} peak` }
    }
    if (m.trades >= cfg.minTrades && m.winRatePct < cfg.winRateFloorPct) {
      return { degraded: true, key: 'floor', reason: `rolling win rate ${m.winRatePct}% below hard floor ${cfg.winRateFloorPct}%` }
    }
    if (m.trades >= cfg.minTrades && m.winRatePct < m.baselinePct - cfg.winRateDriftPct) {
      return { degraded: true, key: 'drift', reason: `rolling win rate ${m.winRatePct}% drifted ${Math.round(m.baselinePct - m.winRatePct)}pts below baseline ${m.baselinePct}%` }
    }
    if (m.trades >= cfg.minTrades && cfg.profitFactorFloor > 0 && m.pf < cfg.profitFactorFloor) {
      return { degraded: true, key: 'pf', reason: `rolling profit factor ${m.pf} below floor ${cfg.profitFactorFloor}` }
    }
    return { degraded: false, key: '', reason: '' }
  }

  // ---------- lifecycle hooks ----------

  private onPositionClosed(position: Position): void {
    if (!position.note?.startsWith('bot:')) return
    const botId = position.note.slice(4)
    if (position.status !== 'won' && position.status !== 'lost') return

    const s = this.states.get(botId) ?? freshState(botId)
    this.states.set(botId, s) // ensure the health state lives in the map, not just the DB
    const pnl = position.pnl ?? 0
    const won = position.status === 'won'

    s.totalTrades += 1
    if (won) s.totalWins += 1
    s.cumPnl += pnl
    s.peakPnl = Math.max(s.peakPnl, s.cumPnl)
    s.window.push({ ts: position.tsClose ?? this.now(), won, pnl, asset: position.asset })
    if (s.window.length > this.config.windowTrades) s.window.splice(0, s.window.length - this.config.windowTrades)

    const m = this.metricsOf(s)
    const verdict = this.classify(s, m)
    this.transition(s, m, verdict)
    this.persist(s)
  }

  /** Escalation/de-escalation ladder. Mutates s; emits alerts on transitions. */
  private transition(s: BotHealthState, m: BotMetrics, verdict: { degraded: boolean; key: string; reason: string }): void {
    const name = this.botName(s.botId)

    if (!verdict.degraded) {
      s.degradedStreak = 0
      s.lastAlertKey = ''
      if (s.level === 1) {
        s.level = 0
        s.reason = ''
        s.sinceTs = 0
        this.event(s.botId, 'recover', `Watchdog: "${name}" recovered - rolling win rate ${m.winRatePct}% (baseline ${m.baselinePct}%)`, 'success')
      } else if (s.level === 2) {
        // the edge came back while on hold - self-heal
        s.level = 0
        s.reason = ''
        s.sinceTs = 0
        s.holdUntil = 0
        this.event(s.botId, 'recover', `Watchdog: "${name}" health hold cleared - window recovered to ${m.winRatePct}% WR (baseline ${m.baselinePct}%)`, 'success')
      } else if (s.level === 3) {
        // disarmed bot settled back to health (in-flight trades) - allow re-arm
        s.level = 0
        s.reason = ''
        s.sinceTs = 0
        this.event(s.botId, 'recover', `Watchdog: "${name}" metrics recovered after disarm - bot can be re-armed`, 'success')
      }
      return
    }

    s.degradedStreak += 1
    s.reason = verdict.reason

    if (s.level === 0) {
      s.level = 1
      s.sinceTs = this.now()
      if (s.lastAlertKey !== verdict.key) {
        s.lastAlertKey = verdict.key
        this.event(s.botId, 'watch', `Watchdog: "${name}" under WATCH - ${verdict.reason} (window ${m.trades} trades, ${m.winRatePct}% WR vs baseline ${m.baselinePct}%)`, 'warn')
      }
    } else if (s.level === 1) {
      if (s.lastAlertKey !== verdict.key) {
        s.lastAlertKey = verdict.key
        this.event(s.botId, 'watch', `Watchdog: "${name}" still degrading - ${verdict.reason}`, 'warn')
      }
      if (s.degradedStreak >= this.config.graceTrades) {
        s.level = 2
        s.sinceTs = this.now()
        s.holdUntil = this.now() + this.config.holdMinutes * 60
        this.event(
          s.botId,
          'hold',
          `Watchdog: "${name}" placed on HEALTH HOLD ${this.config.holdMinutes}m - ${verdict.reason} (${s.degradedStreak} degraded settlements, no grace left)`,
          'danger'
        )
      }
    } else if (s.level === 2) {
      // keep the reason fresh; escalation happens at preTrade re-evaluation
      s.reason = verdict.reason
    } else if (s.level === 3) {
      s.reason = verdict.reason
    }
  }

  // ---------- pre-trade gate (consulted by autopilot) ----------

  preTrade(botId: string): { ok: boolean; reason?: string } {
    const s = this.states.get(botId)
    if (!s || s.level === 0 || s.level === 1) return { ok: true }

    if (s.level === 2) {
      const now = this.now()
      if (now >= s.holdUntil) {
        // hold expired - re-classify with the current window
        const m = this.metricsOf(s)
        const verdict = this.classify(s, m)
        if (!verdict.degraded) {
          s.level = 0
          s.degradedStreak = 0
          s.reason = ''
          s.sinceTs = 0
          s.holdUntil = 0
          this.persist(s)
          this.event(botId, 'recover', `Watchdog: "${this.botName(botId)}" hold expired - metrics recovered (${m.winRatePct}% WR), trading resumed`, 'success')
          return { ok: true }
        }
        if (this.config.autoDisarm) {
          this.disarm(s, verdict.reason)
          this.persist(s)
          return { ok: false, reason: `watchdog: bot auto-disarmed after hold - ${verdict.reason} (ack in the Watchdog panel + re-arm to resume)` }
        }
        // no auto-disarm: extend the hold another window
        s.holdUntil = now + this.config.holdMinutes * 60
        this.persist(s)
        this.event(botId, 'hold', `Watchdog: "${this.botName(botId)}" still degraded at hold expiry - hold extended ${this.config.holdMinutes}m (${verdict.reason})`, 'danger')
        return { ok: false, reason: `watchdog: health hold extended - ${verdict.reason}` }
      }
      const mins = Math.max(1, Math.ceil((s.holdUntil - now) / 60))
      return { ok: false, reason: `watchdog: health hold for ${mins}m - ${s.reason} (ack in the Watchdog panel to resume)` }
    }

    return { ok: false, reason: `watchdog: bot disarmed for strategy degradation - ${s.reason} (ack + re-arm to resume)` }
  }

  private disarm(s: BotHealthState, reason: string): void {
    s.level = 3
    s.sinceTs = this.now()
    s.reason = reason
    const name = this.botName(s.botId)
    let stopped = false
    try {
      const bots = this.ctx.use<AutopilotLike>('autopilot')
      const row = bots.listBots().find((b) => b.bot.id === s.botId)
      if (row?.bot.enabled) {
        bots.toggleBot(s.botId, false)
        stopped = true
      }
    } catch {
      // autopilot not loaded
    }
    this.event(
      s.botId,
      'disarm',
      `Watchdog: "${name}" AUTO-DISARMED - ${reason}${stopped ? ' (bot stopped)' : ' (bot was not armed)'}`,
      'danger'
    )
  }

  // ---------- operator API ----------

  /** Acknowledge degradation for one bot (or all). Resets the window (recalibrate). */
  ack(botId?: string): { ok: boolean; cleared: string[] } {
    const cleared: string[] = []
    const targets = botId ? [botId] : [...this.states.keys()]
    for (const id of targets) {
      const s = this.states.get(id)
      if (!s || s.level === 0) continue
      s.level = 0
      s.reason = ''
      s.sinceTs = 0
      s.holdUntil = 0
      s.degradedStreak = 0
      s.window = []
      s.acks += 1
      s.lastAlertKey = ''
      this.persist(s)
      this.event(id, 'ack', `Watchdog: "${this.botName(id)}" acknowledged by operator - window recalibrated, health reset`, 'success')
      cleared.push(id)
    }
    return { ok: true, cleared }
  }

  setBaseline(botId: string, expectedWinRatePct: number): { ok: boolean; error?: string } {
    const s = this.states.get(botId) ?? freshState(botId)
    const pct = Number(expectedWinRatePct)
    if (!Number.isFinite(pct) || pct < 1 || pct > 99) return { ok: false, error: 'expectedWinRatePct must be 1..99' }
    s.botId = botId
    s.baselineOverridePct = Math.round(pct * 10) / 10
    this.states.set(botId, s)
    this.persist(s)
    this.event(botId, 'config', `Watchdog: "${this.botName(botId)}" baseline set to ${s.baselineOverridePct}% win rate`, 'info')
    return { ok: true }
  }

  configure(patch: Partial<WatchdogConfig>): WatchdogConfig {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)))
    const next = { ...this.config, ...patch }
    next.windowTrades = clamp(next.windowTrades, 5, 200)
    next.minTrades = clamp(next.minTrades, 2, next.windowTrades)
    next.winRateFloorPct = clamp(next.winRateFloorPct, 1, 99)
    next.winRateDriftPct = clamp(next.winRateDriftPct, 1, 60)
    next.profitFactorFloor = Math.max(0, Math.round((Number(next.profitFactorFloor) || 0) * 100) / 100)
    next.maxConsecLosses = clamp(next.maxConsecLosses, 0, 100)
    next.graceTrades = clamp(next.graceTrades, 1, 100)
    next.holdMinutes = clamp(next.holdMinutes, 1, 1440)
    next.botDrawdownUsd = Math.max(0, Number(next.botDrawdownUsd) || 0)
    next.expectedWinRatePct = clamp(next.expectedWinRatePct, 1, 99)
    next.autoDisarm = Boolean(next.autoDisarm)
    this.config = next
    this.store.saveWatchdogConfig(this.config)
    this.event(
      'fleet',
      'config',
      `Watchdog limits updated: window ${this.config.windowTrades} · min ${this.config.minTrades} · WR floor ${this.config.winRateFloorPct}% · drift ${this.config.winRateDriftPct}pts · PF floor ${this.config.profitFactorFloor} · streak ${this.config.maxConsecLosses} · grace ${this.config.graceTrades} · hold ${this.config.holdMinutes}m${this.config.autoDisarm ? ' · auto-disarm' : ''}`,
      'info'
    )
    return this.config
  }

  clearBot(botId: string): void {
    if (this.states.delete(botId)) this.store.deleteWatchdogState(botId)
  }

  // ---------- status ----------

  status(): Record<string, unknown> {
    const bots: Record<string, unknown>[] = []
    const seen = new Set<string>()
    let meta: { id: string; name: string; enabled: boolean; strategyId: string; tf: string }[] = []
    try {
      meta = this.ctx.use<AutopilotLike>('autopilot').listBots().map((b) => b.bot)
    } catch {
      // autopilot not loaded - report persisted states only
    }
    for (const b of meta) {
      seen.add(b.id)
      const s = this.states.get(b.id) ?? freshState(b.id)
      const m = this.metricsOf(s)
      bots.push({
        botId: b.id,
        name: b.name,
        strategyId: b.strategyId,
        tf: b.tf,
        enabled: b.enabled,
        level: s.level,
        levelLabel: LEVEL_LABELS[s.level],
        reason: s.reason,
        sinceTs: s.sinceTs,
        holdUntil: s.holdUntil,
        degradedStreak: s.degradedStreak,
        acks: s.acks,
        baselineOverridePct: s.baselineOverridePct,
        metrics: m,
      })
    }
    // persisted states for bots that no longer exist in the fleet are dropped on read
    for (const [id, s] of this.states) {
      if (seen.has(id)) continue
      const m = this.metricsOf(s)
      bots.push({
        botId: id,
        name: `${id} (removed)`,
        strategyId: '-',
        tf: '-',
        enabled: false,
        level: s.level,
        levelLabel: LEVEL_LABELS[s.level],
        reason: s.reason,
        sinceTs: s.sinceTs,
        holdUntil: s.holdUntil,
        degradedStreak: s.degradedStreak,
        acks: s.acks,
        baselineOverridePct: s.baselineOverridePct,
        metrics: m,
      })
    }
    bots.sort((a, b) => Number(b.level) - Number(a.level) || String(a.name).localeCompare(String(b.name)))
    const events = this.store
      .listWatchdogEvents(60)
      .map((e) => ({ ts: e.ts, botId: e.bot_id, kind: e.kind, message: e.message }))
    return {
      config: this.config,
      bots,
      summary: {
        total: bots.length,
        healthy: bots.filter((b) => b.level === 0).length,
        watch: bots.filter((b) => b.level === 1).length,
        hold: bots.filter((b) => b.level === 2).length,
        disarmed: bots.filter((b) => b.level === 3).length,
      },
      events,
    }
  }
}

let activeWatchdog: WatchdogService | null = null

export const watchdogPlugin: Plugin = {
  name: 'watchdog',
  start: async (ctx) => {
    const svc = new WatchdogService()
    activeWatchdog = svc
    ctx.provide('watchdog', svc)
    await svc.start(ctx)
  },
  stop: () => {
    try {
      activeWatchdog?.stop()
    } catch {
      // not started
    }
    activeWatchdog = null
  },
}
