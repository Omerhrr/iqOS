// IQAIR//OS - Execution plugin
// Paper broker (binary + spot settlement driven by candle closes), risk manager
// (kill switch, daily loss limit, max stake, max open, loss-streak cooldown),
// and the iqair LIVE adapter that forwards trades to the Python sidecar.
// Live options settle against the SIDECAR'S OWN EXPIRY QUOTES (candles at the
// broker's real minute-boundary expiry), never the kernel's cached tick.

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
import type { AnalyticsService } from './analytics'
import { getInstrument, isInstrumentOpen } from '../universe'
import { Store } from '../store'
import { classifyRegime } from '../analytics/regime'
import { classifySession } from '../analytics/session'

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
  private analytics!: AnalyticsService
  private store!: Store
  private unsubscribers: (() => void)[] = []
  private settleTimer: ReturnType<typeof setInterval> | null = null
  private balanceTimer: ReturnType<typeof setInterval> | null = null
  private syncingBalance = false
  // live options currently in their expiry-quote settlement flow (re-entry
  // guard for the 1s sweep while the async sidecar round-trips are out)
  private settlingLive = new Set<string>()
  // sweeps spent trying to fetch an expiry quote per position (backoff ladder)
  private expiryAttempts = new Map<string, number>()

  risk: RiskConfig = { ...DEFAULT_RISK }
  liveReady = false
  accountSource: 'paper' | 'iq' = 'paper'
  private lastLiveError = ''

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.analytics = ctx.use<AnalyticsService>('analytics')
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
    // spot/cfd TP-SL + margin checks ride the candle stream
    this.unsubscribers.push(
      ctx.bus.on('candle', ({ asset, tf, candle, closed }) => {
        if (closed) this.onCandleClose(asset, tf, candle)
        else this.checkSpotStops(asset, candle)
      })
    )
    // 1s sweep: binary/turbo/digital positions (paper AND live) settle the
    // moment their expiry is due - no waiting for a candle boundary - then
    // the ledger reconciles with the broker's real balance on IQ
    this.settleTimer = setInterval(() => this.settleDue(), 1000)
    // keep the displayed IQ balance in tandem with the broker (wins/losses/
    // stakes book on IQ's side; the OS ledger is only an estimate). Runs
    // whenever a sidecar session is warm - even in paper mode - so the true
    // figure is always current when you switch sources.
    this.balanceTimer = setInterval(() => void this.syncLiveBalance(), 10_000)
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
    const src = this.accountSource
    const base = this.store.getAccount()
    // "Open" must count the positions of the ledger the operator is ON -
    // paper source should not count stray live positions and vice versa.
    const openCount = this.store.listPositions('open').filter((p) => (src === 'iq' ? p.mode === 'live' : p.mode === 'paper')).length
    const out: AccountState = { ...base, source: src, openPositions: openCount }
    // Live P/L: IQ practice and real are two DIFFERENT broker accounts - the
    // paper ledger's start/day balances must never surface as their P/L.
    // Measure against the per-mode broker snapshots taken from the live
    // balance sync (first-ever balance = total baseline, first of the day =
    // day baseline). Paper keeps its own ledger numbers untouched.
    if (src === 'iq' && base.liveBalance !== null && base.liveBalance !== undefined) {
      const stat = this.store.getLiveStat(base.balanceMode)
      if (stat) {
        out.startBalance = stat.startBalance
        out.dayPnl = base.liveBalance - stat.dayStart
        out.totalPnl = base.liveBalance - stat.startBalance
      }
    }
    return out
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

  /** What the model believed AT THE INSTANT of entry - captured on every
   * placed trade (paper and live, manual and bot) so calibration can later
   * check whether "score 72" actually won ~72% of the time. Best-effort:
   * analysis can throw while a pair is still warming up right after boot. */
  private snapshotSignal(asset: string, tf: Timeframe): { entryScore?: number; entryConfidence?: number; entryPUp?: number; entryRegime?: string; entrySession?: string } {
    try {
      const a = this.analytics.analyze(asset, tf)
      return {
        entryScore: a.signal.score,
        entryConfidence: a.signal.confidence,
        entryPUp: a.markov.probUp,
        entryRegime: classifyRegime(a),
        entrySession: classifySession(this.now(), asset),
      }
    } catch {
      return {}
    }
  }

  private updateDayRollover(): void {
    this.store.rolloverDay()
  }

  // ---------- risk ----------

  riskCheck(asset: string, amount: number): { ok: boolean; reason?: string } {
    this.updateDayRollover()
    // THE BUG: this used to be this.store.getAccount() directly, whose
    // dayStartBalance/balance are the PAPER ledger row - settle() correctly
    // never touches that row for a live trade (IQ already books the
    // stake/result on the broker's own ledger), but that also meant dayLoss
    // below was computed from a number that can never move on live losses.
    // this.account() is the same data PLUS the live-aware dayPnl override
    // (see account() above) - reuse it here so the daily loss limit actually
    // sees real IQ losses once accountSource is 'iq', not just paper ones.
    const acct = this.account()
    if (acct.killSwitch) return { ok: false, reason: 'KILL SWITCH engaged - trading disabled' }
    // sentinel gate: portfolio breakers, exposure caps, trade throttle (paper AND live)
    try {
      const sentinel = this.ctx.use<{ preTrade: (a: string, amt: number) => { ok: boolean; reason?: string } }>('sentinel')
      const s = sentinel.preTrade(asset, amount)
      if (!s.ok) return { ok: false, reason: s.reason }
    } catch {
      // sentinel plugin not loaded - fall back to base risk manager only
    }
    const info = getInstrument(asset)
    if (info && !isInstrumentOpen(info, new Date(this.now() * 1000)))
      return { ok: false, reason: `market closed for ${asset} - trading disabled` }
    if (amount <= 0) return { ok: false, reason: 'amount must be positive' }
    if (amount > this.risk.maxStake) return { ok: false, reason: `stake $${amount} exceeds max stake $${this.risk.maxStake}` }
    // on IQ the broker's balance is the money that matters - gate against it
    const effBalance = this.accountSource === 'iq' && acct.liveBalance !== null ? acct.liveBalance : acct.balance
    if (amount > effBalance) return { ok: false, reason: `insufficient balance ($${effBalance.toFixed(2)})` }
    const dayLoss = -acct.dayPnl
    if (dayLoss >= this.risk.dailyLossLimit)
      return { ok: false, reason: `daily loss limit hit (-$${dayLoss.toFixed(2)} / -$${this.risk.dailyLossLimit})` }
    // THE BUG: this used to sum paper-open + live-open and compare the TOTAL
    // against one shared limit - a stray paper position (leftover from
    // testing, say) could block a live bot from trading and vice versa.
    // account()'s own openCount already scopes to the ledger the operator is
    // ON (see its comment: "paper source should not count stray live
    // positions and vice versa") - mirror that here so the limit is per
    // ledger, matching what maxOpenPositions is documented to mean.
    const openCount = this.store.listPositions('open').filter((p) => (this.accountSource === 'iq' ? p.mode === 'live' : p.mode === 'paper')).length
    if (openCount >= this.risk.maxOpenPositions)
      return { ok: false, reason: `max concurrent positions (${this.risk.maxOpenPositions})` }
    const streakInfo = this.store.lossStreak()
    if (streakInfo.count >= this.risk.lossStreakCooldown && this.now() - streakInfo.lastLossTs < this.risk.cooldownSeconds)
      return {
        ok: false,
        reason: `cooldown active: ${streakInfo.count} consecutive losses - pausing ${this.risk.cooldownSeconds}s`,
      }
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
    // THE BUG: riskCheck() (daily-loss limit, max stake, max concurrent
    // positions, loss-streak cooldown, sentinel pre-trade, market-hours) used
    // to run only on this paper path - a live order went straight to the
    // broker with ZERO governance. That was already reachable from manual
    // live trades and is now also reachable from any bot once it's on the IQ
    // ledger, so it has to gate both paths identically.
    const check = this.riskCheck(req.asset, req.amount)
    if (!check.ok) return { ok: false, error: check.reason }
    if (mode === 'live') return this.placeLiveOrder(req)

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

    Object.assign(position, this.snapshotSignal(req.asset, req.tf))
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
    note?: string
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
        signal: AbortSignal.timeout(90_000), // digital resolve + server wait can legitimately take ~40s
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
      const data = (await res.json()) as {
        ok: boolean
        order_id?: number
        error?: string
        payout?: number
        mode?: string
        expired?: number
      }
      if (!data.ok) return { ok: false, error: data.error ?? 'sidecar rejected trade' }
      const orderId = String(data.order_id)
      // THE REROUTE BUG: the sidecar's /trade handler silently reroutes an
      // options-family order to whichever instrument family the account
      // actually offers for that ticker (binary/turbo requested but only
      // available as digital-option on this account, or vice versa - see
      // iqair_sidecar.py's /trade handler) and echoes the family it ACTUALLY
      // used back as `data.mode`. We used to ignore that echo and keep
      // `kind` exactly as requested, so a binary-kind order silently placed
      // as digital-option kept `pos.kind === 'binary'` forever. Every later
      // lookup keys off `pos.kind` - settleLiveExpiry's /order_result call
      // narrows IQ's history search to ["binary-option","turbo-option"],
      // which never includes "digital-option" - so a rerouted order's
      // settlement can NEVER be found there no matter how many pages get
      // checked: the trade genuinely isn't in the itype family being
      // searched. Symptom: "still awaiting IQ confirmation ...s past
      // expected expiry - holding, no history recorded yet", forever, for
      // exactly the instruments (often OTC pairs) an account only carries
      // on one side of the binary/turbo vs digital split.
      // Fix: trust the echoed mode for the options family (cfd/forex/etc.
      // never reroute, so leave those as requested) and settle/close/payout
      // against the instrument IQ actually opened, not the one we asked for.
      const effectiveKind: TradeKind = isCfd
        ? kind
        : data.mode === 'digital-option'
          ? 'digital'
          : data.mode === 'turbo-option' || data.mode === 'turbo'
            ? 'turbo'
            : data.mode === 'binary-option' || data.mode === 'binary'
              ? 'binary'
              : kind
      // The broker echoes the REAL expiration (minute-boundary aligned) - IQ
      // may settle up to ~30s either side of our now+N*60 estimate.
      const nowS = this.now()
      const echoExp =
        typeof data.expired === 'number' && data.expired > nowS && data.expired < nowS + 2 * 3600
          ? Math.floor(data.expired)
          : undefined
      const position: Position = {
        id: `lv-${data.order_id}`,
        tsOpen: this.now(),
        asset: req.asset,
        tf: req.tf ?? '1m',
        side: req.side,
        kind: effectiveKind,
        mode: 'live',
        amount: req.amount,
        expiryBars: req.expiryBars ?? 1,
        entryPrice: this.market.getPrice(req.asset),
        payout: effectiveKind === 'digital' ? this.market.payoutFor(req.asset, 'digital') : effectiveKind === 'turbo' ? this.market.payoutFor(req.asset, 'turbo') : effectiveKind === 'cfd' ? 1 : this.market.payoutFor(req.asset, 'binary'),
        status: 'open',
        leverage: isCfd ? req.leverage ?? info?.leverage ?? 10 : undefined,
        strike: effectiveKind === 'digital' && req.strikeOffsetPct ? this.market.getPrice(req.asset) * (1 + (req.side === 'call' ? req.strikeOffsetPct : -req.strikeOffsetPct) / 100) : undefined,
        expirySec: effectiveKind === 'digital' ? expirySec : undefined,
        tp: req.tp,
        sl: req.sl,
        liveOrderId: orderId,
        settlesAt: isCfd ? undefined : echoExp ?? this.now() + expiryMin * 60,
        // THE BUG: this Position literal never carried `note` through, unlike
        // the paper-order branch above (`note: req.note`). Every live trade's
        // `note` therefore came back as `bot:${bot.id}` ... undefined, so
        // autopilot's botIdOf() - which keys ONLY off that prefix - could
        // never match a live position to its bot. onPositionOpened/Closed
        // both bail out immediately on a null botId, so for every bot that
        // is actually routed to the real IQ account: the compounding pot
        // never updates (stuck forever at whatever it was before the live
        // bug - hence "it keeps trading the same stake, never compounds"),
        // the cooldown-at-close re-stamp never runs, win/loss/streak/pnl
        // stats never update, and the research-gate's journal lookups
        // (which filter positions by `note LIKE 'bot:%'`) silently miss
        // every live trade too. Threading the note through fixes all of it
        // at once for live-routed bots.
        note: req.note,
      }
      Object.assign(position, this.snapshotSignal(req.asset, req.tf ?? '1m'))
      this.store.insertPosition(position)
      this.ctx.bus.emit('positionOpened', { position })
      this.ctx.bus.emit('alert', { level: 'success', message: `LIVE ${kind.toUpperCase()} order ${data.order_id} placed via iqair`, ts: this.now() })
      // IQ deducts the stake immediately - true up the displayed balance
      setTimeout(() => void this.syncLiveBalance(), 4000)
      if (!isCfd) {
        if (echoExp) this.ctx.log('execution', `live ${kind} ${orderId}: broker expiry ${new Date(echoExp * 1000).toISOString()}`)
        // broker meta reconcile: real expiration_time + openPrice straight
        // from IQ's portfolio (covers digitals and orders whose echo omitted
        // `expired`)
        setTimeout(() => void this.reconcileLiveMeta(position.id, orderId, typeof data.mode === 'string' ? data.mode : ''), 2500)
      }
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
    // binary/turbo/digital settle on the 1s expiry sweep (settleDue) - the
    // candle boundary is only for spot/cfd exit checks.
    // THE BUG: this used to filter p.mode === 'paper' only, so a LIVE cfd
    // position never got a tp/sl/margin-call check from anywhere - settleDue
    // only drives expiry-based kinds (binary/turbo/digital), and live cfds
    // have settlesAt left undefined (no expiry to sweep). A live leveraged
    // position could therefore sit open indefinitely with no kernel-side
    // mechanism ever closing it on tp, sl, or a margin call - uncapped
    // downside bounded only by whatever the broker itself enforces outside
    // this kernel. Checking live cfds here too (and routing their actual
    // close through closePosition(), which talks to the sidecar) closes
    // that gap.
    const open = this.store.listPositions('open').filter((p) => p.kind === 'cfd' && p.asset === asset && p.tf === tf)
    for (const pos of open) this.checkMargin(pos, candle.close, candle.time)
  }

  private checkSpotStops(asset: string, candle: Candle): void {
    const open = this.store.listPositions('open').filter((p) => p.kind === 'cfd' && p.asset === asset)
    for (const pos of open) this.checkMargin(pos, candle.close, Math.floor(Date.now() / 1000))
  }

  private checkMargin(pos: Position, price: number, ts: number): void {
    // NOTE: only 'cfd' carries TP/SL/margin semantics - TradeKind has no
    // 'spot' member (binary/turbo/digital all settle by expiry), so the old
    // `pos.kind === 'spot'` branch here was unreachable dead code.
    if (pos.kind !== 'cfd') return
    const dir = pos.side === 'call' ? 1 : -1
    const movePct = ((price - pos.entryPrice) / pos.entryPrice) * 100 * dir
    const hitTP = pos.tp !== undefined && movePct >= pos.tp
    const hitSL = pos.sl !== undefined && movePct <= -pos.sl
    if (!hitTP && !hitSL) {
      // CFD margin call: unrealized loss >= margin => stop out
      if (pos.kind === 'cfd' && pos.leverage) {
        const lossPct = (movePct * pos.leverage) / 100 // fraction of margin lost
        if (lossPct <= -1) {
          // live: actually tell the broker to close it (closePosition's live
          // branch), not just mutate our own ledger - a paper settle() alone
          // would mark it closed here while the real IQ position stays open.
          if (pos.mode === 'live') this.closePosition(pos.id)
          else this.settle(pos.id, price, 'closed', -pos.amount)
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
    if (pos.mode === 'live') {
      this.closePosition(pos.id)
    } else {
      const notional = pos.kind === 'cfd' && pos.leverage ? pos.amount * pos.leverage : pos.amount
      const pnl = ((price - pos.entryPrice) / pos.entryPrice) * notional * dir
      this.settle(pos.id, price, 'closed', pnl)
    }
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

  private settle(id: string, exitPrice: number, status: 'won' | 'lost' | 'closed', pnl: number, via = ''): void {
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
    const priceTxt = Number(exitPrice.toPrecision(6)).toString()
    this.ctx.bus.emit('alert', {
      level: pnl >= 0 ? 'success' : 'danger',
      message: `${pos.asset} ${pos.side.toUpperCase()} ${pos.kind} settled @ ${priceTxt}${via ? ` (${via})` : ''}: ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`,
      ts: this.now(),
    })
  }

  /**
   * 1s sweep: settle open option positions (paper AND live) the moment their
   * expiry is due. Paper settles against the sim feed tick; LIVE settles
   * against the SIDECAR'S OWN EXPIRY QUOTE (see settleLiveExpiry) - never
   * against this kernel's cached active-asset tick. On IQ the broker's
   * authoritative balance arrives via syncLiveBalance() a few seconds later.
   */
  private settleDue(): void {
    const now = this.now()
    const due = this.store
      .listPositions('open')
      .filter(
        (p) =>
          (p.kind === 'binary' || p.kind === 'turbo' || p.kind === 'digital') &&
          p.settlesAt !== undefined &&
          now >= p.settlesAt
      )
    for (const pos of due) {
      // live positions only settle while on IQ with a warm sidecar session
      if (pos.mode === 'live') {
        if (!(this.liveReady && this.accountSource === 'iq')) continue
        if (this.settlingLive.has(pos.id)) continue
        this.settlingLive.add(pos.id)
        void this.settleLiveExpiry(pos)
        continue
      }
      // paper positions settle against the sim universe, which only ticks in
      // paper mode - a stale sim price is never a settlement price
      if (this.market.mode !== 'sim') continue
      const price = this.market.getPrice(pos.asset)
      // feed stalled for this asset - retry next sweep rather than settle wrong
      if (!price || price <= 0) continue
      this.settleExpiry(pos, price, '')
    }
  }

  /**
   * Expiry win/loss decision: binary/turbo against entry, digital against
   * strike, at-the-money refunds the stake. `via` names the price source in
   * the settlement alert ("iq expiry 1s quote" etc).
   */
  private settleExpiry(pos: Position, price: number, via: string): void {
    const strike = pos.kind === 'digital' ? (pos.strike ?? pos.entryPrice) : pos.entryPrice
    const draw = price === strike
    const won = pos.side === 'call' ? price > strike : price < strike
    const pnl = draw ? 0 : won ? pos.amount * pos.payout : -pos.amount
    this.settle(pos.id, price, draw ? 'won' : won ? 'won' : 'lost', pnl, via)
  }

  /**
   * LIVE options settle ONLY against IQ's OWN authoritative order result -
   * never a price quote we compute win/loss from ourselves. We ask the
   * sidecar's /order_result (which walks IQ's own portfolio/history
   * endpoints and matches our order id - see iqOrderResult()) whether the
   * broker has already closed this order out, and if so trust ITS pnl sign,
   * full stop.
   *
   * THE BUG (fake/guessed history): this used to fall back, once IQ hadn't
   * reported back yet, to a local price-quote ladder (own expiry candle ->
   * degraded stream quote -> kernel feed "last resort") that GUESSED a
   * win/loss from a price comparison and wrote that guess to history via
   * finishLiveExpiry. That guess could - and did - disagree with what IQ
   * itself later reported, so the trade history for REAL money trades was
   * sometimes simply wrong. There is now no such path for live trades: if
   * the broker hasn't confirmed closed (whether it explicitly says "open",
   * says "not found yet", or the sidecar call itself errors/times out), we
   * record NOTHING and just retry on the next sweep, indefinitely, until IQ
   * itself reports the real result. Paper trades are untouched - they have
   * no real broker to wait for and keep settling via settleExpiry's local
   * price computation, unchanged.
   */
  private async settleLiveExpiry(pos: Position): Promise<void> {
    const attempt = (this.expiryAttempts.get(pos.id) ?? 0) + 1
    this.expiryAttempts.set(pos.id, attempt)
    if (pos.liveOrderId) {
      const result = await this.iqOrderResult(pos.liveOrderId, pos.kind)
      if (result?.found && result.status === 'closed' && Number.isFinite(result.pnl)) {
        this.finishLiveExpiryFromBroker(pos, result.pnl as number)
        return
      }
      // The lookup itself failed (sidecar says every get_positions()/
      // get_position_history_v2() call errored - typically an expired IQ
      // session) rather than IQ genuinely saying "not closed yet". This is
      // NOT the normal waiting path: surface it loudly and immediately
      // (every attempt, not just every 150th) so a broken session doesn't
      // masquerade as "position still open" for however long until someone
      // happens to check the logs. We still never guess a settlement from
      // it - only flag it more visibly than the normal wait below.
      if (result?.error) {
        this.lastLiveError = `live ${pos.kind} ${pos.liveOrderId ?? pos.id} on ${pos.asset}: broker lookup failing (${result.error}) - IQ confirmation cannot be fetched, position held open, not settled`
        if (attempt === 1 || attempt % 10 === 0) {
          this.ctx.log('execution', this.lastLiveError)
          this.ctx.bus.emit('alert', { level: 'warn', message: this.lastLiveError, ts: this.now() })
        }
      }
      // Broker explicitly open, not found yet, or the call errored/timed
      // out (result === null): in every case IQ has not confirmed a close,
      // so nothing gets written to history. Just wait and re-ask.
    }
    // ~2-3 minutes past expected expiry with still no broker confirmation:
    // flag the position as stuck (visible to the UI/ops) rather than just a
    // log line buried in the console - still does not affect settlement.
    if (attempt === 150 || (attempt > 150 && attempt % 150 === 0)) {
      const waitedSec = this.now() - (pos.settlesAt ?? this.now())
      this.lastLiveError = `live ${pos.kind} ${pos.liveOrderId ?? pos.id} on ${pos.asset} still awaiting IQ confirmation ${waitedSec}s past expected expiry - holding, no history recorded yet`
      this.ctx.log('execution', this.lastLiveError)
      // Surface it as a visible alert (not just a log line) the first time a
      // position crosses this threshold, so a stuck settlement is noticed
      // from the existing alerts panel instead of requiring a log dig.
      this.ctx.bus.emit('alert', { level: 'warn', message: this.lastLiveError, ts: this.now() })
    }
    // unresolved - the next 1s sweep re-asks the broker. No local guess, no
    // timeout that forces a settlement: we wait as long as it takes for IQ
    // to report the real result.
    this.settlingLive.delete(pos.id)
  }

  /**
   * Settle directly from IQ's own reported pnl (see iqOrderResult) - no
   * price/strike comparison at all, because the broker already decided.
   * draw (pnl === 0, e.g. an at-the-money refund) stays 'won' with $0 pnl,
   * matching settleExpiry's existing draw convention.
   */
  private finishLiveExpiryFromBroker(pos: Position, pnl: number): void {
    this.settlingLive.delete(pos.id)
    this.expiryAttempts.delete(pos.id)
    const status: 'won' | 'lost' = pnl < 0 ? 'lost' : 'won'
    this.settle(pos.id, pos.entryPrice, status, pnl, 'iq order result (broker-reported)')
  }

  /**
   * Ask the sidecar whether IQ has closed this order out yet, and what it
   * paid - the actual "wait for iq to report back before deciding" check.
   * Returns null on a sidecar hiccup (caller falls back to the price ladder
   * for this sweep and just retries next tick); { found: false } means IQ
   * hasn't settled it yet either.
   */
  private async iqOrderResult(
    liveOrderId: string,
    kind: Position['kind']
  ): Promise<{ found: boolean; status?: string; pnl?: number; error?: string } | null> {
    const mode = kind === 'digital' ? 'digital' : kind === 'binary' ? 'binary' : 'turbo'
    const res = await this.postLive('/order_result', { order_id: liveOrderId, mode, max_wait_sec: 6 }, 10_000)
    // null here means the HTTP call itself failed/timed out (network to the
    // sidecar, not the broker) - the caller already treats that as "keep
    // waiting, no guess". `error` below is the OTHER failure mode: the
    // sidecar answered fine but every get_positions()/get_position_history_v2()
    // call it made to IQ itself failed (e.g. an expired IQ session) - also
    // not a genuine "not found yet", so it's threaded through distinctly
    // rather than collapsed into plain found:false.
    if (!res || res.ok === false) return null
    const found = res.found === true
    const status = typeof res.status === 'string' ? res.status : undefined
    const pnl = Number(res.pnl)
    const error = typeof res.error === 'string' ? res.error : undefined
    return { found, status, pnl: Number.isFinite(pnl) ? pnl : undefined, error }
  }

  /**
   * True-up a just-placed live option against the broker's own books
   * (portfolio v4 via the sidecar /positions): expiration_time is the REAL
   * minute-boundary expiry (our now+N*60 estimate can be ~30s off) and
   * openPrice is the quote IQ will actually settle against. Best-effort -
   * when the broker list lags or no instrument type matches, local values stand.
   */
  private async reconcileLiveMeta(posId: string, orderId: string, modeHint: string): Promise<void> {
    const types = modeHint.startsWith('digital')
      ? ['digital-option', 'turbo-option', 'binary-option']
      : modeHint === 'binary'
        ? ['binary-option', 'turbo-option']
        : ['turbo-option', 'binary-option', 'digital-option']
    for (const itype of types) {
      const res = await this.postLive('/positions', { instrument_type: itype }, 35_000)
      if (!res || !Array.isArray(res.positions)) continue
      const row = (res.positions as Record<string, unknown>[]).find((r) => r && String(r.id) === orderId)
      if (!row) continue
      const lower: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v
      const num = (...keys: string[]): number | undefined => {
        for (const k of keys) {
          const v = Number(lower[k])
          if (Number.isFinite(v) && v > 0) return v
        }
        return undefined
      }
      const pos = this.store.getPosition(posId)
      if (!pos || pos.status !== 'open') return
      const patch: { settlesAt?: number; entryPrice?: number } = {}
      const exp = num('expiration_time', 'expired', 'expiration')
      if (exp && exp > pos.tsOpen && exp < pos.tsOpen + 2 * 3600) patch.settlesAt = Math.floor(exp)
      const open = num('openprice', 'open_price')
      // sanity band: a misparsed field must never poison the settlement math
      // (entryPrice <= 0 = kernel feed never ticked this asset -> the broker
      // figure is the only real number, take it unconditionally)
      if (open && (pos.entryPrice <= 0 || Math.abs(open / pos.entryPrice - 1) <= 0.2)) patch.entryPrice = open
      if (!Object.keys(patch).length) return
      this.store.updateLiveMeta(posId, patch)
      this.ctx.log(
        'execution',
        `live meta ${orderId} (${itype}): expiry ${patch.settlesAt ? new Date(patch.settlesAt * 1000).toISOString() : 'unchanged'}, open ${patch.entryPrice ?? 'unchanged'}`
      )
      return
    }
    this.ctx.log('execution', `live meta ${orderId}: broker position not found yet - local expiry/open kept`)
  }

  /**
   * Pull the broker's REAL balance from the sidecar into liveBalance and
   * broadcast it. Runs on a 10s cadence whenever a sidecar session is warm
   * (any account source), plus right after order placement and settlement
   * (delayed - IQ needs a moment to book results).
   */
  async syncLiveBalance(): Promise<void> {
    if (!this.liveReady || this.syncingBalance) return
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
      // change_balance() is a slow multi-round-trip (profile fetch + two
      // position-stream resubscribes) and the sidecar serializes it behind
      // its global lock - 20s aborted REAL switches mid-flight, which made
      // practice<->real look broken. Give it a real budget.
      const switched = await this.postLive('/balance_mode', { mode }, 60_000)
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

  private async postLive(path: string, body: unknown, timeoutMs = 20_000): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.liveUrl().replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // never let a hung sidecar call pin kernel fetches. Callers that hit
        // legitimately slow IQ round-trips (connect, balance-mode switch -
        // change_balance() chains multiple websocket messages) pass a
        // larger budget; the 20s default protects the hot paths.
        signal: AbortSignal.timeout(timeoutMs),
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
