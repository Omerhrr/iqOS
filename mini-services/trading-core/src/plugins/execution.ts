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
import { getInstrument } from '../universe'
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
  private settleTimer: ReturnType<typeof setInterval> | null = null
  private balanceTimer: ReturnType<typeof setInterval> | null = null
  private syncingBalance = false

  risk: RiskConfig = { ...DEFAULT_RISK }
  liveReady = false
  accountSource: 'paper' | 'iq' = 'paper'
  private lastLiveError = ''

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.store = ctx.use<Store>('store')
    // restore the persisted account source FIRST so the boot sequence
    // (restoreSource) knows which ledger + feed the operator left behind
    this.accountSource = this.store.getSource()
    // restore persisted base risk limits (survive kernel restarts)
    const saved = this.store.getSentinelState()
    if (saved && saved.config && typeof saved.config === 'object') {
      const c = saved.config as Record<string, unknown>
      const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fb)
      this.risk = {
        maxStake: num(c.maxStake, this.risk.maxStake),
        dailyLossLimit: num(c.dailyLossLimit, this.risk.dailyLossLimit),
        maxOpenPositions: num(c.maxOpenPositions, this.risk.maxOpenPositions),
        lossStreakCooldown: num(c.lossStreakCooldown, this.risk.lossStreakCooldown),
        cooldownSeconds: num(c.cooldownSeconds, this.risk.cooldownSeconds),
      }
    }
    // settle binaries + spot TPs/SLs on every closed candle
    this.unsubscribers.push(
      ctx.bus.on('candle', ({ asset, tf, candle, closed }) => {
        if (closed) this.onCandleClose(asset, tf, candle)
        else this.checkSpotStops(asset, candle)
      })
    )
    // LIVE option positions: the candle path only settles paper trades - live
    // binaries/turbos/digitals settle the moment their expiry is due (1s
    // sweep), then the ledger reconciles with the broker's real balance
    this.settleTimer = setInterval(() => this.settleLiveDue(), 1000)
    // keep the displayed IQ balance in tandem with the broker (wins/losses/
    // stakes book on IQ's side; the OS ledger is only an estimate)
    this.balanceTimer = setInterval(() => void this.syncLiveBalance(), 15000)
    ctx.log('execution', 'paper broker + risk manager online')
  }

  stop(): void {
    for (const u of this.unsubscribers) u()
    this.unsubscribers = []
    if (this.settleTimer) clearInterval(this.settleTimer)
    if (this.balanceTimer) clearInterval(this.balanceTimer)
    this.settleTimer = null
    this.balanceTimer = null
  }

  // ---------- account ----------

  account(): AccountState {
    return { ...this.store.getAccount(), source: this.accountSource }
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
    // sentinel gate: portfolio breakers, exposure caps, trade throttle (paper AND live)
    try {
      const sentinel = this.ctx.use<{ preTrade: (a: string, amt: number) => { ok: boolean; reason?: string } }>('sentinel')
      const s = sentinel.preTrade(asset, amount)
      if (!s.ok) return { ok: false, reason: s.reason }
    } catch {
      // sentinel plugin not loaded - fall back to base risk manager only
    }
    if (amount <= 0) return { ok: false, reason: 'amount must be positive' }
    if (amount > this.risk.maxStake) return { ok: false, reason: `stake $${amount} exceeds max stake $${this.risk.maxStake}` }
    // on IQ the broker's balance is the money that matters - gate against it
    const effBalance = this.accountSource === 'iq' && acct.liveBalance !== null ? acct.liveBalance : acct.balance
    if (amount > effBalance) return { ok: false, reason: `insufficient balance ($${effBalance.toFixed(2)})` }
    const dayLoss = acct.dayStartBalance - acct.balance
    if (dayLoss >= this.risk.dailyLossLimit)
      return { ok: false, reason: `daily loss limit hit (-$${dayLoss.toFixed(2)} / -$${this.risk.dailyLossLimit})` }
    const openCount = this.store.listPositions('open').filter((p) => p.mode === 'paper').length +
      this.store.listPositions('open').filter((p) => p.mode === 'live').length
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
    // persist so limits survive kernel restarts
    try {
      const saved = this.store.getSentinelState()
      this.store.saveSentinelState(
        { ...((saved?.config as Record<string, unknown>) ?? {}), ...this.risk },
        saved?.hwm ?? 0
      )
    } catch {
      // persistence is best-effort
    }
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
    expirySec?: number // digital/turbo explicit expiry
    strikeOffsetPct?: number // digital strike distance from spot
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

    const kind = req.kind
    const tfSec = TIMEFRAME_SECONDS[req.tf]
    let position: Position

    if (kind === 'binary' || kind === 'turbo') {
      const expiryBars = Math.max(1, req.expiryBars ?? 1)
      // turbo on short TFs settles in whole seconds, minimum 30s
      const settleSec = kind === 'turbo' ? Math.max(30, expiryBars * tfSec) : expiryBars * tfSec
      position = {
        id: `pp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        tsOpen: this.now(),
        asset: req.asset,
        tf: req.tf,
        side: req.side,
        kind,
        mode: 'paper',
        amount: req.amount,
        expiryBars,
        entryPrice: price,
        payout: this.market.payoutFor(req.asset, kind),
        status: 'open',
        strategy: req.strategy,
        note: req.note,
        settlesAt: this.now() + settleSec,
      }
    } else if (kind === 'digital') {
      const expirySec = Math.max(60, req.expirySec ?? 300) // 5m default, 15m common
      const offsetPct = req.strikeOffsetPct ?? 0
      const strike = req.side === 'call' ? price * (1 + offsetPct / 100) : price * (1 - offsetPct / 100)
      position = {
        id: `pp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        tsOpen: this.now(),
        asset: req.asset,
        tf: req.tf,
        side: req.side,
        kind,
        mode: 'paper',
        amount: req.amount,
        expiryBars: Math.ceil(expirySec / tfSec),
        entryPrice: price,
        payout: this.market.payoutFor(req.asset, kind),
        status: 'open',
        strike,
        expirySec,
        strategy: req.strategy,
        note: req.note,
        settlesAt: this.now() + expirySec,
      }
    } else {
      // CFD: margin = amount, notional = margin * leverage, TP/SL on % move of price
      const leverage = Math.min(Math.max(1, req.leverage ?? assetInfo.leverage ?? 10), assetInfo.leverage ?? 30)
      position = {
        id: `pp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        tsOpen: this.now(),
        asset: req.asset,
        tf: req.tf,
        side: req.side,
        kind: 'cfd',
        mode: 'paper',
        amount: req.amount,
        expiryBars: 0,
        entryPrice: price,
        leverage,
        payout: 1,
        status: 'open',
        tp: req.tp,
        sl: req.sl,
        strategy: req.strategy,
        note: req.note,
      }
    }

    this.store.insertPosition(position)
    // reserve stake/margin: deduct immediately, pay back on settlement
    this.store.adjustBalance(-req.amount)
    this.ctx.bus.emit('positionOpened', { position })
    this.ctx.bus.emit('account', { account: this.account() })
    this.ctx.bus.emit('alert', {
      level: 'success',
      message: `PAPER ${kind.toUpperCase()} ${req.side.toUpperCase()} ${req.asset} $${req.amount}${kind === 'cfd' ? ` x${position.leverage}` : ''} @ ${price.toFixed(assetInfo.pip)}`,
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
    expirySec?: number
    strikeOffsetPct?: number
    mode?: 'paper' | 'live'
    leverage?: number
    tp?: number
    sl?: number
    kind?: TradeKind
  }): Promise<{ ok: boolean; position?: Position; error?: string }> {
    if (!this.liveReady) return { ok: false, error: this.lastLiveError || 'live broker not connected (start the iqair sidecar and connect in Settings)' }
    const kind: TradeKind = req.kind ?? 'binary'
    const info = getInstrument(req.asset)
    const symbol = this.market.iqairSymbol(req.asset)
    const tfSec = TIMEFRAME_SECONDS[req.tf ?? '1m']

    // options payload (binary/turbo/digital)
    const expirySec = kind === 'digital' ? Math.max(60, req.expirySec ?? 300) : Math.max(30, (req.expiryBars ?? 1) * tfSec)
    const expiryMin = Math.max(1, Math.round(expirySec / 60))

    // CFD-style live payload for spot categories
    const isCfd = kind === 'cfd'
    const instrumentType = isCfd
      ? info?.category === 'forex'
        ? 'forex'
        : info?.category === 'crypto'
          ? 'crypto'
          : info?.category === 'commodity'
            ? 'commodity'
            : info?.category === 'index'
              ? 'index'
              : 'stock'
      : kind === 'digital'
        ? 'digital-option'
        : kind === 'turbo'
          ? 'turbo-option'
          : 'binary-option'

    try {
      const res = await fetch(`${this.liveUrl()}/trade`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          asset: symbol,
          amount: req.amount,
          direction: req.side === 'call' ? 'call' : 'put',
          expiry_minutes: expiryMin,
          mode: instrumentType,
          ...(kind === 'digital' ? { strike_offset_pct: req.strikeOffsetPct ?? 0 } : {}),
          ...(isCfd ? { leverage: req.leverage ?? info?.leverage ?? 10, tp: req.tp, sl: req.sl } : {}),
        }),
      })
      const data = (await res.json()) as { ok: boolean; order_id?: number; error?: string; payout?: number }
      if (!data.ok) return { ok: false, error: data.error ?? 'sidecar rejected trade' }
      const position: Position = {
        id: `lv-${data.order_id}`,
        tsOpen: this.now(),
        asset: req.asset,
        tf: req.tf ?? '1m',
        side: req.side,
        kind,
        mode: 'live',
        amount: req.amount,
        expiryBars: req.expiryBars ?? 1,
        entryPrice: this.market.getPrice(req.asset),
        payout: kind === 'digital' ? this.market.payoutFor(req.asset, 'digital') : kind === 'turbo' ? this.market.payoutFor(req.asset, 'turbo') : kind === 'cfd' ? 1 : this.market.payoutFor(req.asset, 'binary'),
        status: 'open',
        leverage: isCfd ? req.leverage ?? info?.leverage ?? 10 : undefined,
        strike: kind === 'digital' && req.strikeOffsetPct ? this.market.getPrice(req.asset) * (1 + (req.side === 'call' ? req.strikeOffsetPct : -req.strikeOffsetPct) / 100) : undefined,
        expirySec: kind === 'digital' ? expirySec : undefined,
        tp: req.tp,
        sl: req.sl,
        liveOrderId: String(data.order_id),
        settlesAt: isCfd ? undefined : this.now() + expiryMin * 60,
      }
      this.store.insertPosition(position)
      this.ctx.bus.emit('positionOpened', { position })
      this.ctx.bus.emit('alert', { level: 'success', message: `LIVE ${kind.toUpperCase()} order ${data.order_id} placed via iqair`, ts: this.now() })
      // IQ deducts the stake immediately - true up the displayed balance
      setTimeout(() => void this.syncLiveBalance(), 4000)
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
      if (pos.kind === 'binary' || pos.kind === 'turbo') {
        if (pos.settlesAt !== undefined && this.now() < pos.settlesAt) continue
        const won = pos.side === 'call' ? candle.close > pos.entryPrice : candle.close < pos.entryPrice
        const draw = candle.close === pos.entryPrice
        const pnl = draw ? 0 : won ? pos.amount * pos.payout : -pos.amount
        this.settle(pos.id, candle.close, draw ? 'won' : won ? 'won' : 'lost', pnl)
      } else if (pos.kind === 'digital') {
        if (pos.settlesAt !== undefined && this.now() < pos.settlesAt) continue
        const strike = pos.strike ?? pos.entryPrice
        const won = pos.side === 'call' ? candle.close > strike : candle.close < strike
        const draw = candle.close === strike
        const pnl = draw ? 0 : won ? pos.amount * pos.payout : -pos.amount
        this.settle(pos.id, candle.close, draw ? 'won' : won ? 'won' : 'lost', pnl)
      } else if (pos.kind === 'spot' || pos.kind === 'cfd') {
        this.checkMargin(pos, candle.close, candle.time)
      }
    }
  }

  private checkSpotStops(asset: string, candle: Candle): void {
    const open = this.store.listPositions('open').filter((p) => p.mode === 'paper' && (p.kind === 'spot' || p.kind === 'cfd') && p.asset === asset)
    for (const pos of open) this.checkMargin(pos, candle.close, Math.floor(Date.now() / 1000))
  }

  private checkMargin(pos: Position, price: number, ts: number): void {
    if (pos.kind !== 'spot' && pos.kind !== 'cfd') return
    const dir = pos.side === 'call' ? 1 : -1
    const movePct = ((price - pos.entryPrice) / pos.entryPrice) * 100 * dir
    const hitTP = pos.tp !== undefined && movePct >= pos.tp
    const hitSL = pos.sl !== undefined && movePct <= -pos.sl
    if (!hitTP && !hitSL) {
      // CFD margin call: unrealized loss >= margin => stop out
      if (pos.kind === 'cfd' && pos.leverage) {
        const lossPct = (movePct * pos.leverage) / 100 // fraction of margin lost
        if (lossPct <= -1) {
          this.settle(pos.id, price, 'closed', -pos.amount)
          this.ctx.bus.emit('alert', {
            level: 'danger',
            message: `MARGIN CALL ${pos.asset}: stop-out at -100% margin`,
            ts: this.now(),
          })
          void ts
        }
      }
      return
    }
    const notional = pos.kind === 'cfd' && pos.leverage ? pos.amount * pos.leverage : pos.amount
    const pnl = ((price - pos.entryPrice) / pos.entryPrice) * notional * dir
    this.settle(pos.id, price, 'closed', pnl)
    void ts
  }

  closePosition(id: string): { ok: boolean; position?: Position; error?: string } {
    const pos = this.store.getPosition(id)
    if (!pos) return { ok: false, error: 'position not found' }
    if (pos.status !== 'open') return { ok: false, error: 'position already settled' }
    if (pos.mode === 'live') {
      // digital positions close through iqair's close_digital_option; the
      // sidecar picks the method by mode prefix - 'turbo' would call
      // sell_option on a digital position id and fail
      void this.postLive(`/close_trade`, { mode: pos.kind === 'digital' ? 'digital-option' : 'turbo', order_id: Number(pos.liveOrderId) })
    }
    const price = this.market.getPrice(pos.asset)
    const dir = pos.side === 'call' ? 1 : -1
    if (pos.kind === 'binary' || pos.kind === 'turbo') {
      // early close: settle at current diff (paper simplification)
      const diffPct = ((price - pos.entryPrice) / pos.entryPrice) * dir
      const pnl = diffPct >= 0 ? pos.amount * pos.payout * Math.min(1, diffPct * 200) : -pos.amount * Math.min(1, -diffPct * 200)
      this.settle(id, price, 'closed', pnl)
    } else if (pos.kind === 'digital') {
      const strike = pos.strike ?? pos.entryPrice
      const diffPct = ((price - strike) / strike) * dir
      const pnl = diffPct >= 0 ? pos.amount * pos.payout * Math.min(1, diffPct * 200) : -pos.amount * Math.min(1, -diffPct * 200)
      this.settle(id, price, 'closed', pnl)
    } else {
      // spot / cfd
      const notional = pos.kind === 'cfd' && pos.leverage ? pos.amount * pos.leverage : pos.amount
      const pnl = ((price - pos.entryPrice) / pos.entryPrice) * notional * dir
      this.settle(id, price, 'closed', pnl)
    }
    return { ok: true, position: this.store.getPosition(id) ?? undefined }
  }

  private settle(id: string, exitPrice: number, status: 'won' | 'lost' | 'closed', pnl: number): void {
    const pos = this.store.settlePosition(id, exitPrice, status, pnl)
    if (!pos) return
    if (pos.mode === 'paper') {
      // stake was deducted at open; balance gets stake + pnl back
      this.store.adjustBalance(pos.amount + pnl)
    } else {
      // live: IQ already booked the stake/result on the broker ledger -
      // never touch the paper balance; pull the REAL figure shortly after
      setTimeout(() => void this.syncLiveBalance(), 3000)
    }
    this.ctx.bus.emit('positionClosed', { position: pos })
    this.ctx.bus.emit('account', { account: this.account() })
    this.ctx.bus.emit('alert', {
      level: pnl >= 0 ? 'success' : 'danger',
      message: `${pos.asset} ${pos.side.toUpperCase()} ${pos.kind} settled: ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`,
      ts: this.now(),
    })
  }

  /**
   * 1s sweep: settle open LIVE option positions the moment their expiry is
   * due - binaries/turbos against entry, digitals against strike, using the
   * current feed price. The broker's authoritative balance arrives via
   * syncLiveBalance() a few seconds later.
   */
  private settleLiveDue(): void {
    if (!this.liveReady || this.accountSource !== 'iq') return
    const now = this.now()
    const due = this.store
      .listPositions('open')
      .filter((p) => p.mode === 'live' && p.settlesAt !== undefined && now >= p.settlesAt)
    for (const pos of due) {
      if (pos.kind !== 'binary' && pos.kind !== 'turbo' && pos.kind !== 'digital') continue
      const price = this.market.getPrice(pos.asset)
      // feed stalled for this asset - retry next sweep rather than settle wrong
      if (!price || price <= 0) continue
      if (pos.kind === 'digital') {
        const strike = pos.strike ?? pos.entryPrice
        const draw = price === strike
        const won = pos.side === 'call' ? price > strike : price < strike
        const pnl = draw ? 0 : won ? pos.amount * pos.payout : -pos.amount
        this.settle(pos.id, price, draw ? 'won' : won ? 'won' : 'lost', pnl)
      } else {
        const draw = price === pos.entryPrice
        const won = pos.side === 'call' ? price > pos.entryPrice : price < pos.entryPrice
        const pnl = draw ? 0 : won ? pos.amount * pos.payout : -pos.amount
        this.settle(pos.id, price, draw ? 'won' : won ? 'won' : 'lost', pnl)
      }
    }
  }

  /**
   * Pull the broker's REAL balance from the sidecar into liveBalance and
   * broadcast it. Runs on a 15s cadence while on IQ, plus right after order
   * placement and settlement (delayed - IQ needs a moment to book results).
   */
  async syncLiveBalance(): Promise<void> {
    if (!this.liveReady || this.accountSource !== 'iq' || this.syncingBalance) return
    this.syncingBalance = true
    try {
      const bal = await this.getLive('/balance')
      if (bal && typeof bal.amount === 'number' && Number.isFinite(bal.amount)) {
        const prev = this.store.getAccount().liveBalance
        const mode = typeof bal.mode === 'string' ? bal.mode : 'PRACTICE'
        if (prev !== bal.amount || this.store.getAccount().balanceMode !== mode) {
          this.store.setLiveBalance(bal.amount, mode)
          this.ctx.bus.emit('account', { account: this.account() })
        }
      }
    } catch {
      // sidecar busy - the next tick retries
    } finally {
      this.syncingBalance = false
    }
  }

  // ---------- live account ops ----------

  async connectLive(url: string, email: string, password: string, balanceMode: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.market.connectLive(url, email, password, balanceMode)
    if (res.ok) {
      this.liveReady = true
      this.lastLiveError = ''
      const bal = await this.getLive('/balance')
      if (bal && typeof bal.amount === 'number') {
        this.store.setLiveBalance(bal.amount, typeof bal.mode === 'string' ? bal.mode : balanceMode)
        this.ctx.bus.emit('account', { account: this.account() })
      }
      // Session authenticated. The DATA FEED is governed by the account source:
      // only an operator already trading on IQ gets the live feed immediately.
      // A paper session is never hijacked by a login (feed stays sim).
      if (this.accountSource === 'iq') await this.market.adoptSidecarSession(url)
    } else {
      this.liveReady = false
      this.lastLiveError = res.error ?? 'connection failed'
    }
    return res
  }

  /**
   * Resume live trading after a kernel restart WITHOUT re-entering secrets:
   * adopt the sidecar's still-authenticated session, then re-sync balance.
   * Called automatically at boot by the kernel wiring when the sidecar holds
   * a live session; also safe to call manually.
   */
  async adoptLive(url?: string): Promise<{ ok: boolean; error?: string }> {
    const adopted = url ? await this.market.adoptSidecarSession(url) : await this.market.adoptSidecarSession()
    if (!adopted) return { ok: false, error: 'no connected sidecar session to adopt' }
    this.liveReady = true
    this.lastLiveError = ''
    // adopting a session means resuming IQ trading - make the source match
    this.accountSource = 'iq'
    this.store.setSource('iq')
    this.ensureIQActiveAsset()
    const bal = await this.getLive('/balance')
    if (bal && typeof bal.amount === 'number') {
      this.store.setLiveBalance(bal.amount, typeof bal.mode === 'string' ? bal.mode : 'PRACTICE')
      this.ctx.bus.emit('account', { account: this.account() })
    }
    return { ok: true }
  }

  /**
   * Boot-time source restore. The persisted account source decides what the OS
   * comes back as after a kernel respawn:
   *   paper -> sim feed, paper ledger. A warm sidecar session is left untouched
   *            (this is what keeps paper working after credentials were entered).
   *   iq     -> re-adopt the sidecar session (feed live + IQ ledger). The
   *            sidecar may still be spawning - retry before giving up, then
   *            fall back to paper honestly instead of faking a live session.
   */
  async restoreSource(): Promise<void> {
    const persisted = this.store.getSource()
    if (persisted !== 'iq') {
      this.ctx.log('execution', 'boot restore: PAPER source - sim feed (warm sidecar session left untouched)')
      return
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await this.adoptLive()
      if (r.ok) {
        this.ctx.log('execution', 'boot restore: IQ source - sidecar session adopted, feed live')
        return
      }
      await new Promise((res) => setTimeout(res, 5000))
    }
    this.accountSource = 'paper'
    this.store.setSource('paper')
    this.lastLiveError = 'IQ session lost (sidecar restarted?) - reverted to PAPER, reconnect in Settings'
    this.ctx.bus.emit('alert', { level: 'danger', message: this.lastLiveError, ts: this.now() })
    this.ctx.bus.emit('account', { account: this.account() })
  }

  /**
   * Switch the OS between the paper ledger and the live IQ account.
   * 'iq' requires an authenticated sidecar session (adopts one if present)
   * and flips the data feed to IQ; balanceMode switches that SAME session
   * between PRACTICE / REAL.
   * 'paper' drops back to the sim feed + paper ledger (session kept warm
   * on the sidecar so switching back needs no re-auth).
   */
  async switchSource(source: 'paper' | 'iq', balanceMode = 'PRACTICE'): Promise<{ ok: boolean; account?: AccountState; error?: string }> {
    if (source === 'iq') {
      if (this.market.mode !== 'live') {
        const adopted = await this.market.adoptSidecarSession()
        if (!adopted) {
          this.lastLiveError = 'no authenticated iqair session - connect in Settings first'
          return { ok: false, error: this.lastLiveError }
        }
      }
      // the current chart asset may not exist on the IQ account (e.g. a sim
      // stock ticker) - move to a tradeable pair so the feed has data
      this.ensureIQActiveAsset()
      const mode = balanceMode === 'REAL' ? 'REAL' : 'PRACTICE'
      const switched = await this.postLive('/balance_mode', { mode })
      if (switched && switched.ok === false) {
        return { ok: false, error: String(switched.error ?? 'sidecar rejected balance mode') }
      }
      this.liveReady = true
      this.lastLiveError = ''
      const bal = await this.getLive('/balance')
      if (bal && typeof bal.amount === 'number') {
        this.store.setLiveBalance(bal.amount, typeof bal.mode === 'string' ? bal.mode : mode)
      }
      this.accountSource = 'iq'
      this.store.setSource('iq')
      this.ctx.log('execution', `account source -> IQ (${mode}) - feed live`)
    } else {
      this.accountSource = 'paper'
      this.store.setSource('paper')
      // liveReady stays TRUE: the sidecar session is still warm, only the
      // feed + ledger fall back to paper. Switching back needs no re-auth.
      this.market.disconnectLive()
      this.ctx.log('execution', 'account source -> PAPER - sim feed (IQ session kept warm)')
    }
    const account = this.account()
    this.ctx.bus.emit('account', { account })
    return { ok: true, account }
  }

  disconnectLive(): void {
    this.liveReady = false
    this.accountSource = 'paper'
    this.store.setSource('paper')
    this.market.disconnectLive()
  }

  /** If the active chart asset is not tradeable on the connected IQ account,
   * move to the first available IQ pair (prefer liquid forex / crypto, OTC
   * variants cover weekends). No-op when the sidecar asset set is unknown. */
  private ensureIQActiveAsset(): void {
    const cur = this.market.activeAsset
    if (this.market.isIQAvailable(cur)) return
    const candidates = ['EURUSD', 'EURUSD-OTC', 'BTCUSD', 'BTCUSD-OTC', 'GBPUSD', 'GBPUSD-OTC']
    const known = (t: string) => this.market.assets.some((a) => a.ticker === t)
    const fallback =
      candidates.find((t) => t !== cur && known(t) && this.market.isIQAvailable(t)) ??
      this.market.assets.find((a) => a.ticker !== cur && this.market.isIQAvailable(a.ticker))?.ticker
    if (!fallback) return
    this.market.activeAsset = fallback
    this.market.refreshActiveLive()
    this.ctx.log('execution', `active asset -> ${fallback} (${cur} not tradeable on IQ)`)
    this.ctx.bus.emit('alert', {
      level: 'info',
      message: `Chart moved to ${fallback} - ${cur} is not available on this IQ account`,
      ts: this.now(),
    })
  }

  async livePositions(): Promise<unknown> {
    return this.postLive('/positions', {})
  }

  async liveHistory(instrumentType: string, limit: number): Promise<unknown> {
    return this.postLive('/history', { instrument_type: instrumentType, limit })
  }

  /**
   * Batch watch-list prices for IQ instruments: last 1m close per ticker
   * from the sidecar (capped at 40, sidecar caches 30s per ticker). The web
   * MarketWatch asks for the rows it is actually displaying.
   */
  async watchPrices(tickers: string[]): Promise<Record<string, number>> {
    if (!this.liveReady || !tickers.length) return {}
    try {
      const res = await fetch(`${this.liveUrl().replace(/\/$/, '')}/prices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tickers: tickers.slice(0, 40) }),
        signal: AbortSignal.timeout(25000),
      })
      const data = (await res.json()) as { ok?: boolean; prices?: Record<string, unknown> }
      const out: Record<string, number> = {}
      for (const [t, p] of Object.entries(data.prices ?? {})) {
        const v = Number(p)
        if (Number.isFinite(v) && v > 0) out[t] = v
      }
      return out
    } catch {
      return {}
    }
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

  /** GET variant - the sidecar serves read-only endpoints (e.g. /balance) on GET. */
  private async getLive(path: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.liveUrl().replace(/\/$/, '')}${path}`, { signal: AbortSignal.timeout(8000) })
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
