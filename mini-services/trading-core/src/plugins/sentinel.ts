// IQAIR//OS - Sentinel plugin (risk governance)
// Portfolio-level governor that sits ABOVE the per-order risk manager:
//  - persisted limits + breaker states (survive kernel restarts)
//  - circuit breakers: daily-loss breach -> auto kill switch + fleet disarm
//  - equity drawdown guard vs balance high-water mark (latches until acked)
//  - portfolio exposure caps (total open stake, per-asset stake)
//  - trade-rate throttle (bot-storm protection)
//  - PANIC: close every open position + disarm every bot in one shot
// Execution consults sentinel.preTrade() before every order (paper AND live).

import type { Plugin, KernelContext } from '../kernel'
import type { Store } from '../store'
import type { Position } from '../types'
import type { MarketDataService } from './market-data'
import { logReturns, pearson } from '../analytics/quant'

export interface SentinelConfig {
  maxExposurePct: number // max total open stake as % of balance (0 = off)
  perAssetCapPct: number // max open stake on a single asset as % of balance (0 = off)
  maxTradesPerHour: number // rolling-window trade throttle (0 = unlimited)
  drawdownHaltPct: number // % drop from high-water mark that trips the breaker (0 = off)
  autoKillOnDailyLoss: boolean // engage kill switch when the daily loss limit is hit
  autoKillOnDrawdown: boolean // engage kill switch when the drawdown breaker trips
  /** Correlation-aware exposure cap: a basket of 3 highly-correlated pairs is
   * effectively one leveraged bet, even though each one clears the per-asset
   * cap on its own. When a new trade's asset is correlated (|r| >= threshold,
   * on recent log-returns) with any OPEN position, the combined stake across
   * every correlated position (plus the new trade) is checked against this %
   * of balance. 0 = off. */
  correlationCapPct: number
  /** |Pearson r| on recent 1m log-returns at/above which two assets are
   * treated as "the same bet" for the correlation cap above. */
  correlationThreshold: number
}

export const DEFAULT_SENTINEL: SentinelConfig = {
  maxExposurePct: 30,
  perAssetCapPct: 12,
  maxTradesPerHour: 30,
  drawdownHaltPct: 15,
  autoKillOnDailyLoss: true,
  autoKillOnDrawdown: false,
  correlationCapPct: 20,
  correlationThreshold: 0.65,
}

export interface BreakerState {
  id: 'daily' | 'drawdown'
  label: string
  tripped: boolean
  reason: string
  ts: number | null
}

interface ExecLike {
  closePosition(id: string): unknown
  setKillSwitch(on: boolean): unknown
  account(): { balance: number; dayStartBalance: number; killSwitch: boolean }
}
interface AutopilotLike {
  listBots(): { bot: { id: string; enabled: boolean } }[]
  toggleBot(id: string, enabled?: boolean): unknown
}

export class SentinelService {
  private ctx!: KernelContext
  private store!: Store
  private market!: MarketDataService
  private unsubscribers: (() => void)[] = []

  config: SentinelConfig = { ...DEFAULT_SENTINEL }
  hwm = 0 // balance high-water mark
  private tradeTs: number[] = [] // rolling window of trade-open timestamps
  // short-lived cache of pairwise correlations - preTrade runs on every order
  // and a fresh 200-bar pearson per open asset would otherwise recompute on
  // every single trade check
  private corrCache = new Map<string, { r: number; ts: number }>()
  private static readonly CORR_TTL_SEC = 300
  private static readonly CORR_BARS = 200
  private breakers: Record<'daily' | 'drawdown', BreakerState> = {
    daily: { id: 'daily', label: 'DAILY LOSS', tripped: false, reason: '', ts: null },
    drawdown: { id: 'drawdown', label: 'DRAWDOWN', tripped: false, reason: '', ts: null },
  }

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.store = ctx.use<Store>('store')
    this.market = ctx.use<MarketDataService>('market')
    this.restore()

    this.unsubscribers.push(
      ctx.bus.on('positionOpened', ({ position }) => this.onTradeOpened(position)),
      ctx.bus.on('positionClosed', ({ position }) => this.onPositionClosed(position)),
      ctx.bus.on('account', () => this.evaluate())
    )
    // evaluate once on boot so a persisted trip state re-arms immediately
    this.evaluate()
    ctx.log('sentinel', 'risk governor online - breakers armed, limits persisted')
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
    const saved = this.store.getSentinelState()
    if (!saved) {
      this.hwm = this.store.getAccount().balance
      this.persist()
      return
    }
    this.config = { ...DEFAULT_SENTINEL, ...(saved.config as Partial<SentinelConfig>) }
    const bal = this.store.getAccount().balance
    // high-water mark never goes down with the balance; adopt a higher balance on boot
    this.hwm = Math.max(saved.hwm || 0, bal)
  }

  private persist(): void {
    // merge-preserving: the blob also carries the base risk manager keys (maxStake, ...)
    const saved = this.store.getSentinelState()
    this.store.saveSentinelState({ ...((saved?.config as Record<string, unknown>) ?? {}), ...this.config }, this.hwm)
  }

  private event(kind: string, message: string, level: 'info' | 'warn' | 'danger' | 'success' = 'info'): void {
    this.store.recordRiskEvent(kind, message, this.now())
    this.ctx.bus.emit('alert', { level, message, ts: this.now() })
  }

  // ---------- portfolio math ----------

  private openPositions(): Position[] {
    return this.store.listPositions('open', 500)
  }

  exposure(): { total: number; byAsset: Record<string, number> } {
    const byAsset: Record<string, number> = {}
    let total = 0
    for (const p of this.openPositions()) {
      total += p.amount
      byAsset[p.asset] = (byAsset[p.asset] ?? 0) + p.amount
    }
    return { total: Math.round(total * 100) / 100, byAsset }
  }

  /** |Pearson r| of recent 1m log-returns between two assets - the same read
   * as the copilot's `correlate` tool, cached for CORR_TTL_SEC since preTrade
   * runs on every order and correlation drifts slowly. */
  private correlation(a: string, b: string): number {
    if (a === b) return 1
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    const now = this.now()
    const cached = this.corrCache.get(key)
    if (cached && now - cached.ts < SentinelService.CORR_TTL_SEC) return cached.r
    try {
      const ca = this.market.getCandles(a, '1m', SentinelService.CORR_BARS)
      const cb = this.market.getCandles(b, '1m', SentinelService.CORR_BARS)
      const retsA = logReturns(ca.map((c) => c.close))
      const retsB = logReturns(cb.map((c) => c.close))
      const r = Math.abs(pearson(retsA, retsB))
      this.corrCache.set(key, { r, ts: now })
      return r
    } catch {
      return 0
    }
  }

  /** Combined open stake across every position correlated (|r| >= threshold,
   * same asset always counts) with `asset` - what a new trade on `asset`
   * would really be adding to, risk-wise, rather than just its own line. */
  correlatedExposure(asset: string): { total: number; assets: string[] } {
    const byAsset = this.exposure().byAsset
    const threshold = this.config.correlationThreshold
    let total = 0
    const linked: string[] = []
    for (const [other, stake] of Object.entries(byAsset)) {
      if (this.correlation(asset, other) >= threshold) {
        total += stake
        if (other !== asset) linked.push(other)
      }
    }
    return { total: Math.round(total * 100) / 100, assets: linked }
  }

  tradesLastHour(): number {
    const cutoff = this.now() - 3600
    this.tradeTs = this.tradeTs.filter((t) => t >= cutoff)
    return this.tradeTs.length
  }

  drawdownPct(): number {
    if (this.hwm <= 0) return 0
    const dd = ((this.hwm - this.store.getAccount().balance) / this.hwm) * 100
    return Math.max(0, Math.round(dd * 100) / 100)
  }

  // ---------- lifecycle hooks ----------

  private onTradeOpened(pos: Position): void {
    this.tradeTs.push(this.now())
    // new equity peak -> clear drawdown breaker automatically
    const bal = this.store.getAccount().balance
    if (bal > this.hwm) {
      this.hwm = bal
      if (this.breakers.drawdown.tripped) {
        this.breakers.drawdown = { ...this.breakers.drawdown, tripped: false, reason: '', ts: null }
        this.event('breaker', 'Drawdown breaker reset - new equity high-water mark', 'success')
      }
      this.persist()
    }
  }

  private onPositionClosed(_pos: Position): void {
    this.evaluate()
  }

  // ---------- breaker engine ----------

  /** Re-check both breakers against live account metrics; trip/untrip as needed. */
  evaluate(): void {
    const acct = this.store.getAccount()
    const dayLoss = acct.dayStartBalance - acct.balance

    // daily-loss breaker (base limit lives in the execution risk manager)
    const dailyLimit = this.baseDailyLimit()
    if (dailyLimit > 0 && dayLoss >= dailyLimit && !this.breakers.daily.tripped) {
      this.trip('daily', `Daily loss limit hit: -$${dayLoss.toFixed(2)} / -$${dailyLimit.toFixed(2)}`)
    }

    // drawdown breaker vs high-water mark
    const dd = this.drawdownPct()
    if (this.config.drawdownHaltPct > 0 && dd >= this.config.drawdownHaltPct && !this.breakers.drawdown.tripped) {
      this.trip('drawdown', `Equity drawdown ${dd.toFixed(2)}% >= halt ${this.config.drawdownHaltPct}% (HWM $${this.hwm.toFixed(2)})`)
    }
  }

  private baseDailyLimit(): number {
    try {
      const exec = this.ctx.use<{ risk: { dailyLossLimit: number } }>('execution')
      return exec.risk.dailyLossLimit
    } catch {
      return 0
    }
  }

  private trip(id: 'daily' | 'drawdown', reason: string): void {
    this.breakers[id] = { ...this.breakers[id], tripped: true, reason, ts: this.now() }
    this.event('breaker', `BREAKER TRIPPED [${this.breakers[id].label}]: ${reason}`, 'danger')

    const autoKill = id === 'daily' ? this.config.autoKillOnDailyLoss : this.config.autoKillOnDrawdown
    if (autoKill) {
      try {
        const exec = this.ctx.use<ExecLike>('execution')
        exec.setKillSwitch(true)
        this.event('breaker', 'Kill switch auto-engaged by sentinel', 'danger')
      } catch {
        // execution not available
      }
    }
    const disarmed = this.disarmAllBots()
    if (disarmed > 0) {
      this.event('breaker', `Autopilot fleet paused: ${disarmed} bot${disarmed === 1 ? '' : 's'} disarmed by sentinel`, 'warn')
    }
  }

  /** Acknowledge (reset) tripped breakers. Re-trips immediately if still breached. */
  ack(breaker?: 'daily' | 'drawdown'): { ok: boolean; cleared: string[] } {
    const cleared: string[] = []
    const ids = breaker ? [breaker] : (['daily', 'drawdown'] as const)
    for (const id of ids) {
      if (this.breakers[id].tripped) {
        this.breakers[id] = { ...this.breakers[id], tripped: false, reason: '', ts: null }
        cleared.push(id)
      }
    }
    if (cleared.length) {
      this.event('breaker', `Breakers acknowledged and reset: ${cleared.join(', ')}`, 'success')
      this.evaluate() // still breached? re-trip with fresh reason
    }
    return { ok: true, cleared }
  }

  // ---------- pre-trade gate ----------

  preTrade(asset: string, amount: number): { ok: boolean; reason?: string } {
    this.evaluate()
    const acct = this.store.getAccount()

    if (this.breakers.daily.tripped)
      return { ok: false, reason: `sentinel: daily-loss breaker latched - ${this.breakers.daily.reason} (ack in the Sentinel panel)` }
    if (this.breakers.drawdown.tripped)
      return { ok: false, reason: `sentinel: drawdown breaker latched - ${this.breakers.drawdown.reason} (ack in the Sentinel panel)` }

    // exposure caps
    const exp = this.exposure()
    if (this.config.maxExposurePct > 0 && acct.balance > 0) {
      const cap = (acct.balance * this.config.maxExposurePct) / 100
      if (exp.total + amount > cap)
        return {
          ok: false,
          reason: `sentinel: exposure cap - open stake $${exp.total.toFixed(2)} + $${amount.toFixed(2)} would exceed ${this.config.maxExposurePct}% of balance ($${cap.toFixed(2)})`,
        }
    }
    if (this.config.perAssetCapPct > 0 && acct.balance > 0) {
      const cap = (acct.balance * this.config.perAssetCapPct) / 100
      const assetStake = exp.byAsset[asset] ?? 0
      if (assetStake + amount > cap)
        return {
          ok: false,
          reason: `sentinel: ${asset} exposure cap - open stake $${assetStake.toFixed(2)} + $${amount.toFixed(2)} would exceed ${this.config.perAssetCapPct}% of balance ($${cap.toFixed(2)})`,
        }
    }

    // correlation-aware exposure cap: a new trade correlated with existing
    // open positions is really adding to ONE bet, not opening a diversified
    // new one - cap the combined stake, not just this asset's own line.
    if (this.config.correlationCapPct > 0 && acct.balance > 0) {
      const linked = this.correlatedExposure(asset)
      const cap = (acct.balance * this.config.correlationCapPct) / 100
      if (linked.total + amount > cap) {
        return {
          ok: false,
          reason: `sentinel: correlation cap - ${asset} is correlated (|r|>=${this.config.correlationThreshold}) with ${linked.assets.length ? linked.assets.join(', ') : 'its own open stake'}; combined stake $${linked.total.toFixed(2)} + $${amount.toFixed(2)} would exceed ${this.config.correlationCapPct}% of balance ($${cap.toFixed(2)})`,
        }
      }
    }

    // trade-rate throttle
    if (this.config.maxTradesPerHour > 0 && this.tradesLastHour() >= this.config.maxTradesPerHour) {
      return {
        ok: false,
        reason: `sentinel: trade throttle - ${this.tradesLastHour()} trades in the last hour (max ${this.config.maxTradesPerHour}/h)`,
      }
    }
    return { ok: true }
  }

  // ---------- fleet + panic ----------

  disarmAllBots(): number {
    let n = 0
    try {
      const bots = this.ctx.use<AutopilotLike>('autopilot')
      for (const b of bots.listBots()) {
        if (b.bot.enabled) {
          bots.toggleBot(b.bot.id, false)
          n++
        }
      }
    } catch {
      // autopilot not loaded
    }
    return n
  }

  panic(opts: { killSwitch?: boolean } = {}): {
    ok: boolean
    closed: number
    failed: number
    botsDisarmed: number
    killSwitch: boolean
  } {
    let closed = 0
    let failed = 0
    try {
      const exec = this.ctx.use<ExecLike>('execution')
      const open = this.store.listPositions('open', 500)
      for (const p of open) {
        try {
          const r = exec.closePosition(p.id) as { ok?: boolean }
          if (r && r.ok === false) failed++
          else closed++
        } catch {
          failed++
        }
      }
      if (opts.killSwitch) exec.setKillSwitch(true)
    } catch {
      // execution not available
    }
    const botsDisarmed = this.disarmAllBots()
    // PANIC means the human took over - drop the OS back to HUMAN-IN-THE-LOOP
    try {
      const mode = this.ctx.use<{ forceHuman: (reason: string) => void }>('mode')
      mode.forceHuman('panic - operator took control')
    } catch {
      // mode plugin not loaded
    }
    this.event(
      'panic',
      `PANIC executed: ${closed} position${closed === 1 ? '' : 's'} closed, ${failed} failed, ${botsDisarmed} bot${botsDisarmed === 1 ? '' : 's'} disarmed${opts.killSwitch ? ', kill switch ENGAGED' : ''}`,
      'danger'
    )
    return { ok: true, closed, failed, botsDisarmed, killSwitch: Boolean(opts.killSwitch) }
  }

  // ---------- config ----------

  configure(patch: Partial<SentinelConfig>): SentinelConfig {
    this.config = { ...this.config, ...patch }
    this.persist()
    this.evaluate()
    this.event('config', `Sentinel limits updated: exposure ${this.config.maxExposurePct}% · per-asset ${this.config.perAssetCapPct}% · ${this.config.maxTradesPerHour}/h · dd halt ${this.config.drawdownHaltPct}%`)
    return this.config
  }

  status(): Record<string, unknown> {
    const acct = this.store.getAccount()
    const exp = this.exposure()
    const dayLoss = Math.max(0, acct.dayStartBalance - acct.balance)
    let baseDailyLimit = 0
    let maxOpenPositions = 0
    let maxStake = 0
    try {
      const exec = this.ctx.use<{ risk: { dailyLossLimit: number; maxOpenPositions: number; maxStake: number } }>('execution')
      baseDailyLimit = exec.risk.dailyLossLimit
      maxOpenPositions = exec.risk.maxOpenPositions
      maxStake = exec.risk.maxStake
    } catch {
      // execution not loaded
    }
    const bal = acct.balance
    return {
      armed: this.breakers.daily.tripped || this.breakers.drawdown.tripped || acct.killSwitch,
      killSwitch: acct.killSwitch,
      balance: Math.round(bal * 100) / 100,
      hwm: Math.round(this.hwm * 100) / 100,
      dayLoss: Math.round(dayLoss * 100) / 100,
      baseDailyLimit,
      drawdownPct: this.drawdownPct(),
      exposure: exp,
      exposureCap: this.config.maxExposurePct > 0 ? Math.round(((bal * this.config.maxExposurePct) / 100) * 100) / 100 : 0,
      perAssetCap: this.config.perAssetCapPct > 0 ? Math.round(((bal * this.config.perAssetCapPct) / 100) * 100) / 100 : 0,
      correlationCap: this.config.correlationCapPct > 0 ? Math.round(((bal * this.config.correlationCapPct) / 100) * 100) / 100 : 0,
      tradesLastHour: this.tradesLastHour(),
      openPositions: this.openPositions().length,
      maxOpenPositions,
      maxStake,
      config: this.config,
      breakers: Object.values(this.breakers),
      events: this.store.listRiskEvents(40),
    }
  }
}

let activeSentinel: SentinelService | null = null

export const sentinelPlugin: Plugin = {
  name: 'sentinel',
  start: async (ctx) => {
    const svc = new SentinelService()
    activeSentinel = svc
    ctx.provide('sentinel', svc)
    await svc.start(ctx)
  },
  stop: () => {
    try {
      activeSentinel?.stop()
    } catch {
      // not started
    }
    activeSentinel = null
  },
}
