// IQAIR//OS - Execution plugin
// Paper broker (binary + spot settlement driven by candle closes), risk manager
// (kill switch, daily loss limit, max stake, max open, loss-streak cooldown),
// and the iqair LIVE adapter that forwards trades to the Python sidecar.

import type {
  AccountState,
  Candle,
  Position,
  Side,
  Timeframe,
  TradeKind,
} from '../types'
import type { KernelContext } from '../kernel'
import { TIMEFRAME_SECONDS } from '../types'
import type { Plugin } from '../kernel'
import type { MarketDataService } from './market-data'
import { Store } from '../store'

export interface RiskConfig {
  maxStake: number
  dailyLossLimit: number
  maxOpenPositions: number
  lossStreakCooldown: number // after N consecutive losses
  cooldownSeconds: number
}

const DEFAULT_RISK: RiskConfig = {
  maxStake: 100,
  dailyLossLimit: 250,
  maxOpenPositions: 8,
  lossStreakCooldown: 4,
  cooldownSeconds: 120,
}

export class ExecutionService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private store!: Store
  private unsubscribers: (() => void)[] = []

  risk: RiskConfig = { ...DEFAULT_RISK }
  liveReady = false
  private lastLiveError = ''

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.store = ctx.use<Store>('store')
    // settle binaries + spot TPs/SLs on every closed candle
    this.unsubscribers.push(
      ctx.bus.on('candle', ({ asset, tf, candle, closed }) => {
        if (closed) this.onCandleClose(asset, tf, candle)
        else this.checkSpotStops(asset, candle)
      })
    )
    ctx.log('execution', 'paper broker + risk manager online')
  }

  stop(): void {
    for (const u of this.unsubscribers) u()
    this.unsubscribers = []
  }

  // ---------- account ----------

  account(): AccountState {
    return this.store.getAccount()
  }

  resetAccount(): AccountState {
    this.store.resetAccount(10000)
    this.ctx.bus.emit('account', { account: this.account() })
    this.ctx.bus.emit('alert', { level: 'info', message: 'Account reset to $10,000', ts: this.now() })
    return this.account()
  }

  private now(): number {
    return Math.floor(Date.now() / 1000)
  }

  private updateDayRollover(): void {
    this.store.rolloverDay()
  }

  // ---------- risk ----------

  riskCheck(asset: string, amount: number): { ok: boolean; reason?: string } {
    this.updateDayRollover()
    const acct = this.store.getAccount()
    if (acct.killSwitch) return { ok: false, reason: 'KILL SWITCH engaged - trading disabled' }
    if (amount <= 0) return { ok: false, reason: 'amount must be positive' }
    if (amount > this.risk.maxStake) return { ok: false, reason: `stake $${amount} exceeds max stake $${this.risk.maxStake}` }
    if (amount > acct.balance) return { ok: false, reason: `insufficient balance ($${acct.balance.toFixed(2)})` }
    const dayLoss = acct.dayStartBalance - acct.balance
    if (dayLoss >= this.risk.dailyLossLimit)
      return { ok: false, reason: `daily loss limit hit (-$${dayLoss.toFixed(2)} / -$${this.risk.dailyLossLimit})` }
    const openCount = this.store.listPositions('open').filter((p) => p.mode === 'paper').length
    if (openCount >= this.risk.maxOpenPositions)
      return { ok: false, reason: `max concurrent positions (${this.risk.maxOpenPositions})` }
    const streakInfo = this.store.lossStreak()
    if (streakInfo.count >= this.risk.lossStreakCooldown && this.now() - streakInfo.lastLossTs < this.risk.cooldownSeconds)
      return {
        ok: false,
        reason: `cooldown active: ${streakInfo.count} consecutive losses - pausing ${this.risk.cooldownSeconds}s`,
      }
    void asset
    return { ok: true }
  }

  setRisk(patch: Partial<RiskConfig>): RiskConfig {
    this.risk = { ...this.risk, ...patch }
    this.ctx.bus.emit('alert', { level: 'info', message: 'Risk config updated', ts: this.now() })
    return this.risk
  }

  setKillSwitch(on: boolean): AccountState {
    this.store.setKillSwitch(on)
    this.ctx.bus.emit('alert', {
      level: on ? 'danger' : 'success',
      message: on ? 'KILL SWITCH ENGAGED - all trading halted' : 'Kill switch released - trading allowed',
      ts: this.now(),
    })
    this.ctx.bus.emit('account', { account: this.account() })
    return this.account()
  }

  // ---------- order placement ----------

  async placeOrder(req: {
    asset: string
    tf: Timeframe
    side: Side
    kind: TradeKind
    amount: number
    expiryBars?: number
    mode?: 'paper' | 'live'
    tp?: number
    sl?: number
    leverage?: number
    strategy?: string
    note?: string
  }): Promise<{ ok: boolean; position?: Position; error?: string }> {
    const mode = req.mode ?? 'paper'
    if (mode === 'live') return this.placeLiveOrder(req)

    const check = this.riskCheck(req.asset, req.amount)
    if (!check.ok) return { ok: false, error: check.reason }

    const assetInfo = this.market.assets.find((a) => a.ticker === req.asset)
    if (!assetInfo) return { ok: false, error: `unknown asset ${req.asset}` }
    const price = this.market.getPrice(req.asset)
    if (!price) return { ok: false, error: 'no price feed' }

    const expiryBars = req.kind === 'binary' ? Math.max(1, req.expiryBars ?? 1) : 0
    const tfSec = TIMEFRAME_SECONDS[req.tf]
    const position: Position = {
      id: `pp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      tsOpen: this.now(),
      asset: req.asset,
      tf: req.tf,
      side: req.side,
      kind: req.kind,
      mode: 'paper',
      amount: req.amount,
      expiryBars,
      entryPrice: price,
      payout: assetInfo.payout,
      status: 'open',
      tp: req.kind === 'spot' ? req.tp : undefined,
      sl: req.kind === 'spot' ? req.sl : undefined,
      strategy: req.strategy,
      note: req.note,
      settlesAt: req.kind === 'binary' ? this.now() + expiryBars * tfSec : undefined,
    }
    this.store.insertPosition(position)
    // reserve stake: deduct immediately, pay back on settlement
    this.store.adjustBalance(-req.amount)
    this.ctx.bus.emit('positionOpened', { position })
    this.ctx.bus.emit('account', { account: this.account() })
    this.ctx.bus.emit('alert', {
      level: 'success',
      message: `PAPER ${req.kind.toUpperCase()} ${req.side.toUpperCase()} ${req.asset} $${req.amount} @ ${price.toFixed(assetInfo.pip)}`,
      ts: this.now(),
    })
    return { ok: true, position }
  }

  private async placeLiveOrder(req: {
    asset: string
    tf?: Timeframe
    side: Side
    amount: number
    expiryBars?: number
    mode?: 'paper' | 'live'
    leverage?: number
    kind?: TradeKind
  }): Promise<{ ok: boolean; position?: Position; error?: string }> {
    if (!this.liveReady) return { ok: false, error: this.lastLiveError || 'live broker not connected (start the iqair sidecar and connect in Settings)' }
    const tfSec = TIMEFRAME_SECONDS[req.tf ?? '1m']
    const expiryMin = Math.max(1, Math.round(((req.expiryBars ?? 1) * tfSec) / 60))
    try {
      const res = await fetch(`${this.liveUrl()}/trade`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          asset: req.asset,
          amount: req.amount,
          direction: req.side === 'call' ? 'call' : 'put',
          expiry_minutes: expiryMin,
          mode: 'turbo',
        }),
      })
      const data = (await res.json()) as { ok: boolean; order_id?: number; error?: string }
      if (!data.ok) return { ok: false, error: data.error ?? 'sidecar rejected trade' }
      const position: Position = {
        id: `lv-${data.order_id}`,
        tsOpen: this.now(),
        asset: req.asset,
        tf: req.tf ?? '1m',
        side: req.side,
        kind: 'binary',
        mode: 'live',
        amount: req.amount,
        expiryBars: req.expiryBars ?? 1,
        entryPrice: this.market.getPrice(req.asset),
        payout: 0.85,
        status: 'open',
        liveOrderId: String(data.order_id),
        settlesAt: this.now() + expiryMin * 60,
      }
      this.store.insertPosition(position)
      this.ctx.bus.emit('positionOpened', { position })
      this.ctx.bus.emit('alert', { level: 'success', message: `LIVE order ${data.order_id} placed via iqair`, ts: this.now() })
      return { ok: true, position }
    } catch (err) {
      this.lastLiveError = (err as Error).message
      return { ok: false, error: `live trade failed: ${this.lastLiveError}` }
    }
  }

  liveUrl(): string {
    return this.market.liveUrl
  }

  // ---------- settlement ----------

  private onCandleClose(asset: string, tf: Timeframe, candle: Candle): void {
    const open = this.store.listPositions('open').filter((p) => p.mode === 'paper' && p.asset === asset && p.tf === tf)
    for (const pos of open) {
      if (pos.kind === 'binary') {
        if (pos.settlesAt !== undefined && this.now() < pos.settlesAt) continue
        const won = pos.side === 'call' ? candle.close > pos.entryPrice : candle.close < pos.entryPrice
        const draw = candle.close === pos.entryPrice
        const pnl = draw ? 0 : won ? pos.amount * pos.payout : -pos.amount
        this.settle(pos.id, candle.close, draw ? 'won' : won ? 'won' : 'lost', pnl)
      } else if (pos.kind === 'spot') {
        this.checkSpot(pos, candle.close, candle.time)
      }
    }
  }

  private checkSpotStops(asset: string, candle: Candle): void {
    const open = this.store.listPositions('open').filter((p) => p.mode === 'paper' && p.kind === 'spot' && p.asset === asset)
    for (const pos of open) this.checkSpot(pos, candle.close, Math.floor(Date.now() / 1000))
  }

  private checkSpot(pos: Position, price: number, ts: number): void {
    if (pos.kind !== 'spot') return
    const dir = pos.side === 'call' ? 1 : -1
    const movePct = ((price - pos.entryPrice) / pos.entryPrice) * 100 * dir
    const hitTP = pos.tp !== undefined && movePct >= pos.tp
    const hitSL = pos.sl !== undefined && movePct <= -pos.sl
    if (!hitTP && !hitSL) return
    const pnl = (price - pos.entryPrice) / pos.entryPrice * pos.amount * dir
    this.settle(pos.id, price, pnl >= 0 ? 'closed' : 'closed', pnl)
    void ts
  }

  closePosition(id: string): { ok: boolean; position?: Position; error?: string } {
    const pos = this.store.getPosition(id)
    if (!pos) return { ok: false, error: 'position not found' }
    if (pos.status !== 'open') return { ok: false, error: 'position already settled' }
    if (pos.mode === 'live') {
      void this.postLive(`/close_trade`, { mode: 'turbo', order_id: Number(pos.liveOrderId) })
    }
    const price = this.market.getPrice(pos.asset)
    if (pos.kind === 'binary') {
      // early close: settle at current diff (paper simplification)
      const dir = pos.side === 'call' ? 1 : -1
      const diffPct = ((price - pos.entryPrice) / pos.entryPrice) * dir
      const pnl = diffPct >= 0 ? pos.amount * pos.payout * Math.min(1, diffPct * 200) : -pos.amount * Math.min(1, -diffPct * 200)
      this.settle(id, price, 'closed', pnl)
    } else {
      const dir = pos.side === 'call' ? 1 : -1
      const pnl = ((price - pos.entryPrice) / pos.entryPrice) * pos.amount * dir
      this.settle(id, price, 'closed', pnl)
    }
    return { ok: true, position: this.store.getPosition(id) ?? undefined }
  }

  private settle(id: string, exitPrice: number, status: 'won' | 'lost' | 'closed', pnl: number): void {
    const pos = this.store.settlePosition(id, exitPrice, status, pnl)
    if (!pos) return
    // stake was deducted at open; balance gets stake + pnl back
    this.store.adjustBalance(pos.amount + pnl)
    this.ctx.bus.emit('positionClosed', { position: pos })
    this.ctx.bus.emit('account', { account: this.account() })
    this.ctx.bus.emit('alert', {
      level: pnl >= 0 ? 'success' : 'danger',
      message: `${pos.asset} ${pos.side.toUpperCase()} ${pos.kind} settled: ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`,
      ts: this.now(),
    })
  }

  // ---------- live account ops ----------

  async connectLive(url: string, email: string, password: string, balanceMode: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.market.connectLive(url, email, password, balanceMode)
    if (res.ok) {
      this.liveReady = true
      this.lastLiveError = ''
      const bal = await this.postLive('/balance', {})
      if (bal && typeof bal.amount === 'number') {
        this.store.setLiveBalance(bal.amount, typeof bal.mode === 'string' ? bal.mode : balanceMode)
        this.ctx.bus.emit('account', { account: this.account() })
      }
    } else {
      this.liveReady = false
      this.lastLiveError = res.error ?? 'connection failed'
    }
    return res
  }

  disconnectLive(): void {
    this.liveReady = false
    this.market.disconnectLive()
  }

  async livePositions(): Promise<unknown> {
    return this.postLive('/positions', {})
  }

  async liveHistory(instrumentType: string, limit: number): Promise<unknown> {
    return this.postLive('/history', { instrument_type: instrumentType, limit })
  }

  private async postLive(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.liveUrl().replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return (await res.json()) as Record<string, unknown>
    } catch {
      return null
    }
  }
}

let activeExecution: ExecutionService | null = null

export const executionPlugin: Plugin = {
  name: 'execution',
  start: async (ctx) => {
    const svc = new ExecutionService()
    activeExecution = svc
    ctx.provide('execution', svc)
    await svc.start(ctx)
  },
  stop: () => {
    try {
      activeExecution?.stop()
    } catch {
      // not started
    }
    activeExecution = null
  },
}
