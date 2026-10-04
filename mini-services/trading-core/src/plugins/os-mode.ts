// IQAIR//OS - Mode plugin (human-in-the-loop governor)
// A global OS operating mode that flips the entire system between two intents:
//  - HUMAN: every trade needs a human. A mode gate rejects all bot-originated
//    orders (non-destructively - bot configs are preserved, only execution is
//    suspended) and the built-in auto-trader stands down.
//  - AUTO ("no human in the loop"): the OS trades by itself. Armed autopilot
//    bots resume, and the built-in AUTO-TRADER - the OS acting as its own
//    trader - places fixed-risk binary trades within strict self-imposed
//    limits. The signal SOURCE is configurable:
//      * 'screener'    - the strongest full-composite screener signals market-wide
//      * 'kalman-ou'   - the Kalman/OU mean-reversion edge: fade statistically
//                        stretched pairs (|z| sigmas from the OU equilibrium)
//                        gated by reversion significance and a tradeable half-life
//      * 'markov'      - the Markov chain state forecast: follow the model when it
//                        assigns a decisive next-move probability and the regime
//                        is not chop
//      * 'momentum'    - trend-following on the screener row: ADX-confirmed
//                        directional pressure with the move's rate-of-change
//      * 'confluence'  - reads straight from Screener2Service, the dedicated
//                        market-wide Confluence Signal sweep (screener2.ts) -
//                        the EXACT 14-factor panel/confluence_read engine on
//                        the SAME deep candle history the panel reads
//                        (archived + live tail, 1500 bars), a genuinely
//                        separate feed from 'screener' above, not derived
//                        from it
//      * 'strategy'    - ONE specific saved strategy, picked by strategyId
//                        from the combined Strategy Lab catalog (every
//                        builtin strategy PLUS every AI Lab-learned "custom:"
//                        spec) - the exact same strategyId an autopilot bot
//                        would use, evaluated market-wide on every open pair
//                        (builtin via AnalyticsService.runStrategy, AI Lab
//                        specs via StrategyLabService.runStrategy) instead of
//                        being pinned to one bot's watchlist
//  With 'kalman-ou' + requireValidation, a candidate pair must ALSO pass a
//  walk-forward validation of the OU strategy (out-of-sample net positive,
//  majority of folds profitable, decent IS->OOS efficiency) before the
//  auto-trader trusts the live stretch - validated verdicts are cached per
//  (asset|tf) for an hour and refreshed lazily.
// The mode is persisted, so restarts resume the same intent. Sentinel, the
// watchdog and the base risk manager ALWAYS outrank the mode: flipping to
// AUTO grants autonomy, never exemption. PANIC drops the OS back to HUMAN.

import type { Plugin, KernelContext } from '../kernel'
import type { Store } from '../store'
import type { Timeframe } from '../types'
import type { ScreenerService, ScreenRow } from './screener'
import type { Screener2Service, ConfluenceRow } from './screener2'
import type { MarketDataService } from './market-data'
import type { AnalyticsService } from './analytics'
import type { StrategyLabService } from './lab'
import type { AdaptiveService } from './adaptive'
import { walkForward } from '../strategies/optimize'
import { getStrategy, defaultParams } from '../strategies/builtin'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export type OsMode = 'human' | 'auto'

export type AutoTraderSource = 'screener' | 'kalman-ou' | 'markov' | 'momentum' | 'confluence' | 'strategy'

/** Walk-forward validation verdict for the OU edge on one (asset, tf). */
export interface OUVerdict {
  asset: string
  tf: Timeframe
  verdict: 'robust' | 'weak' | 'failed'
  oosNet: number // aggregate out-of-sample net P&L ($ at $10 stake)
  isNet: number // aggregate in-sample net P&L
  winRate: number // OOS win rate %
  efficiencyPct: number // oosNet / isNet * 100
  foldsProfitable: number
  folds: number
  totalTrades: number // OOS trades
  bestParams: Record<string, number | string>
  elapsedMs: number
  ts: number
}

export interface AutoTraderConfig {
  enabled: boolean // auto-trader armed (it only ever trades while mode = auto)
  signalSource: AutoTraderSource // where entry signals come from
  tf: Timeframe // which screener timeframe to source signals from
  stake: number
  minScore: number // minimum |score| to act on (composite or per-source edge score)
  minConfidence: number // minimum signal confidence (0-100)
  zEntry: number // kalman-ou source: |z| (stationary sigmas) required to enter
  maxHalfLife: number // kalman-ou source: skip pairs reverting slower than this (bars)
  requireValidation: boolean // kalman-ou source: only trade pairs whose walk-forward verdict is robust
  minPUp: number // markov source: decisive next-up probability (call at >=, put at <= 1-)
  minAdx: number // momentum source: minimum trend strength (ADX)
  /** strategy source: id from the combined Strategy Lab catalog - a builtin
   * strategy id (e.g. "ema-cross", "confluence-full") or an AI Lab-learned
   * spec ("custom:<id>"), exactly like an autopilot bot's strategyId. Unset =
   * the 'strategy' source has nothing to trade and stands aside.
   * @deprecated superseded by strategyIds (kept for old saved configs - a
   * lone strategyId is treated as a one-member strategyIds list). */
  strategyId?: string
  /** strategy source: one or more ids from the combined Strategy Lab catalog.
   * One id = trade that single strategy, exactly as strategyId always did.
   * Two or more = an ENSEMBLE: every listed strategy votes call/put/none on
   * each candidate, the majority direction wins, and minConfidence doubles
   * as the minimum agreement % (e.g. 60 = at least 60% of the ensemble must
   * agree) required to act - no classic "confidence" exists at the
   * strategy level, so this is the natural place to put that threshold.
   * Only used when strategyPickMode is 'ensemble' (the default when unset). */
  strategyIds?: string[]
  /** How a 2+-member strategyIds pool combines into one signal per pair.
   * 'ensemble' (default) - every member votes, majority wins (see strategyIds
   * above). 'best' - the OS's own auto-learn: reads the adaptive gate's
   * settled-trade record (adaptive.ts - same Wilson-lower-bound win rate math
   * it already uses to gate bots) for EACH pool member against THIS exact
   * candidate pair/side/score-bucket, and trades whichever member has the
   * strongest proven record for that specific pair - a strategy that's
   * mediocre overall but excellent on e.g. XAUUSD will get picked there and
   * nowhere else. Members with no settled record yet fall back to raw
   * |score| so the pool keeps exploring until it has something to learn
   * from; a proven member always outranks an unproven one. No effect with
   * 0-1 ids. */
  strategyPickMode?: 'ensemble' | 'best'
  /** Per-strategy param overrides, keyed by strategy id - the SAME params a
   * bot's own BotConfig.params carries for its strategyId. Only builtin
   * strategies take params (AnalyticsService.runStrategy); an AI Lab
   * "custom:<id>" spec is fixed and ignores any entry here. Missing keys
   * fall back to that strategy's own defaultParams(), exactly like a bot
   * with no params set. */
  strategyParams?: Record<string, Record<string, number | string>>
  direction: 'both' | 'call' | 'put'
  maxOpen: number // max concurrent auto-trader positions
  cooldownSec: number // per-asset re-entry cooldown
  paceSec: number // minimum seconds between any two auto trades
  dailyProfitTarget: number // 0 = off
  dailyLossLimit: number // 0 = off
  /** Optional pair restriction. Empty/omitted = GLOBAL (every open instrument,
   * the original behavior, unchanged). Non-empty = only these tickers are
   * ever considered, for ANY signalSource - same choke point (assetBlocked)
   * every candidate loop already filters through. */
  watchlist: string[]
  /** Optional compounding plan - SAME shape and semantics as a bot's
   * stakePlan in autopilot.ts (payoutCap, periods, derisk, stopOnLoss). undefined
   * = fixed `stake` every trade, unchanged behavior. Auto-trader is
   * single-asset-at-a-time by construction (maxOpen governs it), which is
   * exactly the constraint autopilot.ts's compound bots are hard-clamped to -
   * no extra restriction needed here. */
  stakePlan?: AutoStakePlan
  /** Runtime roll state, persisted here (saveOsMode persists the whole config
   * blob) rather than a separate table - mirrors BotConfig.planState. */
  planState?: { pot: number; rollN: number; restarts: number; halted: boolean; complete: boolean }
}

export interface AutoStakePlan {
  kind: 'compound'
  base: number
  rollPct?: number
  maxStake?: number
  payoutCap?: number
  stopOnLoss?: boolean
  periods?: number
  deriskAfter?: number
  deriskPct?: number
  onComplete?: 'halt' | 'reseed'
}

export const DEFAULT_AUTOTRADER: AutoTraderConfig = {
  enabled: true,
  signalSource: 'screener',
  tf: '1m',
  stake: 10,
  minScore: 60,
  minConfidence: 55,
  zEntry: 1.8,
  maxHalfLife: 60,
  requireValidation: false,
  minPUp: 0.58,
  minAdx: 22,
  direction: 'both',
  maxOpen: 3,
  cooldownSec: 180,
  paceSec: 45,
  dailyProfitTarget: 0,
  dailyLossLimit: 0,
  watchlist: [],
}
// stakePlan/planState intentionally omitted from DEFAULT_AUTOTRADER above
// (undefined = fixed-stake, the original unconditional behavior)

const AUTOTRADER_NOTE = 'auto:os-trader'
/** Liquid fallback evaluated on demand while the full screener sweep warms up. */
const LIQUID_CANDIDATES = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD', 'BTCUSD']

interface AutoRuntime {
  dayKey: string
  trades: number
  wins: number
  losses: number
  pnlToday: number
  pnlTotal: number
  openCount: number
  lastTradeTs: number
  lastAssetTs: Map<string, number>
  lastRejection?: string
  lastAction?: string
  pot: number // compounding roll; 0 = fresh cycle at base
  rollN: number
  restarts: number
  halted: boolean // stop-on-loss: cycle ended, awaiting explicit restart
  complete: boolean // halted on the periods target (win-side completion)
}

export class ModeService {
  private ctx!: KernelContext
  private store!: Store
  private unsubscribers: (() => void)[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  /** Broker-side "this pair isn't tradable right now" rejections - not a
   * misconfiguration, just our is_open cache lagging IQ's own schedule
   * (weekend OTC closures, mid-day suspensions). Matches the sidecar's
   * `order rejected: Cannot purchase an option (the asset is not available
   * at the moment).` and the "not a turbo/binary/digital instrument"
   * account-mismatch rejection. */
  private static BROKER_UNAVAILABLE_RE = /not available at the moment|is not a (?:turbo\/binary\/digital|digital\/turbo\/binary) instrument/i
  private static BROKER_UNAVAILABLE_COOLDOWN_SEC = 600
  /** asset -> unix ts until which pickSignal skips it, set on the rejection
   * above so the SAME closed pair isn't retried (and re-rejected) on every
   * 10s tick until the asset cache has a chance to catch up. */
  private assetRejectedUntil = new Map<string, number>()

  mode: OsMode = 'human'
  ts = Math.floor(Date.now() / 1000)
  reason = 'initial state'
  config: AutoTraderConfig = { ...DEFAULT_AUTOTRADER }
  private rt: AutoRuntime = ModeService.freshRuntime()

  static freshRuntime(): AutoRuntime {
    return {
      dayKey: new Date().toISOString().slice(0, 10),
      trades: 0,
      wins: 0,
      losses: 0,
      pnlToday: 0,
      pnlTotal: 0,
      openCount: 0,
      lastTradeTs: 0,
      lastAssetTs: new Map(),
      pot: 0,
      rollN: 0,
      restarts: 0,
      halted: false,
      complete: false,
    }
  }

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.store = ctx.use<Store>('store')

    // restore persisted mode + auto-trader config
    const saved = this.store.getOsMode()
    if (saved) {
      if (saved.mode === 'auto' || saved.mode === 'human') this.mode = saved.mode
      this.reason = saved.reason ?? 'restored'
      this.ts = saved.ts || this.ts
      if (saved.config && typeof saved.config === 'object') {
        const c = saved.config as Record<string, unknown>
        const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb)
        this.config = {
          enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULT_AUTOTRADER.enabled,
          signalSource: (['screener', 'kalman-ou', 'markov', 'momentum', 'confluence', 'strategy'] as const).includes(c.signalSource as AutoTraderSource)
            ? (c.signalSource as AutoTraderSource)
            : DEFAULT_AUTOTRADER.signalSource,
          tf: (typeof c.tf === 'string' ? c.tf : DEFAULT_AUTOTRADER.tf) as Timeframe,
          stake: num(c.stake, DEFAULT_AUTOTRADER.stake),
          minScore: num(c.minScore, DEFAULT_AUTOTRADER.minScore),
          minConfidence: num(c.minConfidence, DEFAULT_AUTOTRADER.minConfidence),
          zEntry: num(c.zEntry, DEFAULT_AUTOTRADER.zEntry),
          maxHalfLife: num(c.maxHalfLife, DEFAULT_AUTOTRADER.maxHalfLife),
          requireValidation: typeof c.requireValidation === 'boolean' ? c.requireValidation : DEFAULT_AUTOTRADER.requireValidation,
          minPUp: num(c.minPUp, DEFAULT_AUTOTRADER.minPUp),
          minAdx: num(c.minAdx, DEFAULT_AUTOTRADER.minAdx),
          strategyId: typeof c.strategyId === 'string' && c.strategyId.trim() ? c.strategyId.trim() : undefined,
          strategyIds: Array.isArray(c.strategyIds)
            ? c.strategyIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
            : undefined,
          strategyPickMode: c.strategyPickMode === 'best' ? 'best' : 'ensemble',
          strategyParams: ModeService.sanitizeStrategyParams(c.strategyParams),
          direction: c.direction === 'call' || c.direction === 'put' ? c.direction : 'both',
          maxOpen: Math.round(num(c.maxOpen, DEFAULT_AUTOTRADER.maxOpen)),
          cooldownSec: Math.round(num(c.cooldownSec, DEFAULT_AUTOTRADER.cooldownSec)),
          paceSec: Math.round(num(c.paceSec, DEFAULT_AUTOTRADER.paceSec)),
          dailyProfitTarget: num(c.dailyProfitTarget, 0),
          dailyLossLimit: num(c.dailyLossLimit, 0),
          watchlist: Array.isArray(c.watchlist) ? c.watchlist.filter((x): x is string => typeof x === 'string') : [],
          stakePlan: this.parseStakePlan(c.stakePlan),
          planState: ModeService.isPlanState(c.planState) ? c.planState : undefined,
        }
      }
    }
    this.rebuildRuntime()
    this.syncTimer()
    ctx.log(
      'mode',
      `OS mode: ${this.mode.toUpperCase()} (${this.reason}) - auto-trader ${this.config.enabled ? 'armed' : 'off'} · src ${this.config.signalSource}`
    )
  }

  stop(): void {
    for (const u of this.unsubscribers) u()
    this.unsubscribers = []
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private now(): number {
    return Math.floor(Date.now() / 1000)
  }

  private persist(): void {
    this.store.saveOsMode(this.mode, this.reason, this.ts, this.config)
  }

  private event(level: 'info' | 'warn' | 'danger' | 'success', message: string): void {
    this.store.recordRiskEvent('mode', message, this.now())
    this.ctx.bus.emit('alert', { level, message, ts: this.now() })
  }

  // ---------- mode gate ----------

  /**
   * Origin-aware gate consulted before non-human orders.
   * HUMAN mode suspends autonomy (bots are blocked; the auto-trader never
   * even starts). Manual and copilot trades are human-initiated by definition
   * and always pass - the human can always intervene.
   */
  gate(origin: 'bot' | 'auto'): { ok: boolean; reason?: string } {
    if (this.mode === 'auto') return { ok: true }
    return {
      ok: false,
      reason:
        origin === 'bot'
          ? 'mode-gate: HUMAN-IN-THE-LOOP mode - bot orders suspended (switch the OS to NO-HUMAN mode to run autonomy)'
          : 'mode-gate: HUMAN-IN-THE-LOOP mode - autonomous trading suspended',
    }
  }

  // ---------- mode switching ----------

  setMode(next: OsMode, reason?: string): { ok: boolean; mode: OsMode; changed: boolean } {
    if (next === this.mode) return { ok: true, mode: this.mode, changed: false }
    this.mode = next
    this.reason = reason ?? (next === 'auto' ? 'operator enabled no-human mode' : 'operator restored human control')
    this.ts = this.now()
    this.persist()
    this.syncTimer()

    if (next === 'auto') {
      let armed = 0
      try {
        const bots = this.ctx.use<{ listBots(): { bot: { enabled: boolean } }[] }>('autopilot')
        armed = bots.listBots().filter((b) => b.bot.enabled).length
      } catch {
        // autopilot not loaded
      }
      this.event(
        'warn',
        `MODE -> NO-HUMAN-IN-THE-LOOP: the OS trades autonomously (${armed} bot${armed === 1 ? '' : 's'} armed, auto-trader ${this.config.enabled ? 'ARMED' : 'off'}). Sentinel, watchdog and risk limits still govern every order.`
      )
    } else {
      this.event(
        'success',
        `MODE -> HUMAN-IN-THE-LOOP: every trade now needs you. Bots + auto-trader suspended (configs preserved) - manual trading unaffected.`
      )
    }
    return { ok: true, mode: this.mode, changed: true }
  }

  /** PANIC semantics: the human took over - autonomy ends immediately. */
  forceHuman(reason: string): void {
    if (this.mode !== 'auto') return
    this.setMode('human', reason)
  }

  private syncTimer(): void {
    const wantRunning = this.mode === 'auto'
    if (wantRunning && !this.timer) {
      this.timer = setInterval(() => void this.tick(), 10_000)
      void this.tick() // act immediately on entry
    } else if (!wantRunning && this.timer) {
      clearInterval(this.timer)
      this.timer = null
      this.rt.lastRejection = undefined
    }
  }

  // ---------- auto-trader (the OS as its own trader) ----------

  private async tick(): Promise<void> {
    if (this.mode !== 'auto' || this.ticking) return
    this.ticking = true
    try {
      await this.autoTraderTick()
    } catch (err) {
      this.ctx.log('mode', 'auto-trader tick failed:', (err as Error).message)
    } finally {
      this.ticking = false
    }
  }

  private async autoTraderTick(): Promise<void> {
    if (!this.config.enabled) return
    this.rolloverIfNeeded()

    // compound stop-on-loss: a cycle that took a loss is DEAD until an
    // explicit restart() - same semantics as a compound bot in autopilot.ts
    if (this.config.stakePlan?.stopOnLoss !== false && this.rt.halted) {
      return this.standDown(
        this.rt.complete
          ? `compound cycle COMPLETE (${this.rt.rollN}/${this.config.stakePlan?.periods ?? '?'} periods banked) - restart for a fresh cycle`
          : 'compound cycle ended on a loss - restart to trade again',
      )
    }

    // self-imposed limits (the global risk manager remains the final gate)
    if (this.config.dailyProfitTarget > 0 && this.rt.pnlToday >= this.config.dailyProfitTarget)
      return this.standDown(`profit target reached (+$${this.rt.pnlToday.toFixed(2)})`)
    if (this.config.dailyLossLimit > 0 && this.rt.pnlToday <= -this.config.dailyLossLimit)
      return this.standDown(`daily loss limit hit (-$${Math.abs(this.rt.pnlToday).toFixed(2)})`)
    if (this.rt.openCount >= this.config.maxOpen)
      return this.standDown(`max open auto positions (${this.rt.openCount}/${this.config.maxOpen})`)
    if (this.config.paceSec > 0 && this.rt.lastTradeTs > 0 && this.now() - this.rt.lastTradeTs < this.config.paceSec)
      return

    // source signals: ranked screener feed first, liquid on-demand eval while the sweep warms up
    // (pickSignal already applies per-asset cooldowns + one-auto-position-per-asset)
    const row = this.pickSignal()
    if (!row) return this.standDown('no signal meets the auto-trader thresholds yet')

    // copilot memory gate: standing rules from the copilot's persistent memory
    // ("never trade Fridays", "only trade ...", "max stake $...", rate caps)
    // bind the OS's own trader too - the user's words outrank the machine
    const bet = this.stakeForAuto()
    try {
      const mg = this.ctx.use<{ check: (asset: string, stake: number) => { ok: boolean; reason?: string } }>('memoryGate')
      const g = mg.check(row.asset, bet.amount)
      if (!g.ok) return this.standDown(g.reason ?? 'memory gate hold')
    } catch {
      // memory gate plugin not loaded - rule gating disabled
    }

    const side = row.direction === 'put' ? 'put' : 'call'
    const out = await this.place(row, side, bet.amount)
    if (!out.ok) {
      const reason = out.error ?? 'order rejected'
      if (ModeService.BROKER_UNAVAILABLE_RE.test(reason)) {
        // IQ itself just said this pair isn't tradable right now - our own
        // open/closed cache (sidecarAssetsTs, up to 10 min stale) is already
        // wrong for it, and without this the picker just re-selects the
        // same top-ranked-but-closed pair on the very next 10s tick, so the
        // SAME rejection repeats "a lot" forever. Take it off the table for
        // a while and kick a fresh /assets fetch so the cache catches up
        // sooner than its normal TTL.
        this.assetRejectedUntil.set(row.asset, this.now() + ModeService.BROKER_UNAVAILABLE_COOLDOWN_SEC)
        try {
          this.ctx.use<{ forceRefreshSidecarAssets: () => void }>('market').forceRefreshSidecarAssets()
        } catch {
          // market plugin not loaded - cache catches up on its own next cycle
        }
      }
      return this.standDown(reason)
    }

    this.rt.trades += 1
    this.rt.lastTradeTs = this.now()
    this.rt.lastAssetTs.set(row.asset, this.now())
    this.rt.openCount += 1
    this.rt.lastRejection = undefined
    const rollTag = bet.compound ? ` · ${bet.phase} roll x${bet.rollN + 1}${this.config.stakePlan?.periods ? `/${this.config.stakePlan.periods}` : ''} (pot $${bet.pot.toFixed(2)})` : ''
    this.rt.lastAction = `${side.toUpperCase()} ${row.asset}${rollTag}`
    const detail =
      this.config.signalSource === 'kalman-ou'
        ? `OU z ${row.ouZ.toFixed(2)}σ · HL ${row.ouHalfLife >= 9999 ? '∞' : row.ouHalfLife.toFixed(0)}b · t ${row.ouTStat.toFixed(1)} · edge ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)}`
        : this.config.signalSource === 'markov'
          ? `P(up) ${(row.pUp * 100).toFixed(1)}% · regime ${row.regime} · edge ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)}`
          : this.config.signalSource === 'momentum'
            ? `ADX ${row.adx.toFixed(0)} · RSI ${row.rsi.toFixed(0)} · Δ${row.changePct.toFixed(2)}% · edge ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)}`
            : this.config.signalSource === 'confluence'
              ? `14-factor confluence ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)} (${row.direction.toUpperCase()})`
              : this.config.signalSource === 'strategy'
                ? (row.note ?? `${this.effectiveStrategyIds().join('+') || 'strategy'} (${row.direction.toUpperCase()})`)
                : `score ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)} regime ${row.regime}`
    this.emit(
      'success',
      `[AUTO-TRADER] ${side.toUpperCase()} ${row.asset} ${this.config.tf} $${this.config.stake} binary - ${detail}`
    )
  }

  private pickSignal(): ScreenRow | null {
    if (this.config.signalSource === 'kalman-ou') return this.pickOUSignal()
    if (this.config.signalSource === 'markov') return this.pickMarkovSignal()
    if (this.config.signalSource === 'momentum') return this.pickMomentumSignal()
    if (this.config.signalSource === 'confluence') return this.pickConfluenceSignal()
    if (this.config.signalSource === 'strategy') return this.pickStrategySignal()
    try {
      const screener = this.ctx.use<ScreenerService>('screener')
      const dir = this.config.direction === 'both' ? undefined : this.config.direction
      const restricted = this.config.watchlist.length > 0
      // a watchlist pair might not make the global top-12 by composite score
      // alone - widen the ranked window so assetBlocked's own watchlist
      // filter (not this limit) is what decides inclusion.
      const { rows } = screener.top({ tf: this.config.tf, minScore: this.config.minScore, direction: dir, limit: restricted ? 500 : 12 })
      for (const r of rows) {
        if (r.direction === 'none') continue
        if (r.confidence < this.config.minConfidence) continue
        if (this.assetBlocked(r.asset)) continue
        return r
      }
      // sweep still warming (or rows stale) - evaluate liquid pairs directly,
      // or the operator's own watchlist when one is set (a restricted auto
      // trader has no business falling back to pairs outside it)
      for (const asset of restricted ? this.config.watchlist : LIQUID_CANDIDATES) {
        if (this.assetBlocked(asset)) continue
        try {
          const r = screener.evaluate(asset, this.config.tf)
          if (r.direction === 'none') continue
          if (Math.abs(r.score) < this.config.minScore) continue
          if (r.confidence < this.config.minConfidence) continue
          if (this.config.direction !== 'both' && r.direction !== this.config.direction) continue
          return r
        } catch {
          // thin history for this pair - try the next
        }
      }
    } catch {
      // screener not loaded - no signal source
    }
    return null
  }

  /**
   * Kalman/OU mean-reversion source: sweep the open universe with the cheap
   * screener path (rows carry the fitted OU state) and fade statistically
   * stretched pairs - CALL when price sits |z| sigmas BELOW the OU equilibrium,
   * PUT above - but only when the fit itself says the series actually reverts
   * (t-stat gate) and fast enough to be tradeable (half-life cap).
   */
  private pickOUSignal(): ScreenRow | null {
    try {
      const screener = this.ctx.use<ScreenerService>('screener')
      const market = this.ctx.use<MarketDataService>('market')
      const open = market.assets.filter((a) => a.open).map((a) => a.ticker)
      // liquid pairs first so early ticks evaluate the deepest books, then the tail
      const candidates = [...LIQUID_CANDIDATES.filter((a) => open.includes(a)), ...open.filter((a) => !LIQUID_CANDIDATES.includes(a))]
      for (const asset of candidates) {
        if (this.assetBlocked(asset)) continue
        try {
          const base = screener.evaluate(asset, this.config.tf) // cached when fresh, recomputed when stale
          if (!base.ouMeanReverting) continue // fit not significant - fading a random walk is how accounts die
          if (base.ouHalfLife > this.config.maxHalfLife) continue // reverts too slowly to be tradeable
          const dir: 'call' | 'put' | 'none' =
            base.ouZ <= -this.config.zEntry ? 'call' : base.ouZ >= this.config.zEntry ? 'put' : 'none'
          if (dir === 'none') continue
          if (this.config.direction !== 'both' && dir !== this.config.direction) continue
          if (this.config.requireValidation) {
            const verdict = this.ouVerdict(asset)
            if (!verdict) {
              // no fresh walk-forward verdict yet - validate lazily (bounded:
              // at most one validation runs at a time) and skip this tick
              void this.ensureOUValidation(asset)
              continue
            }
            if (verdict.verdict !== 'robust') continue // walk-forward said this edge is not tradeable
          }
          const az = Math.abs(base.ouZ)
          // same edge-score shape as the kalman-ou-reversion strategy so thresholds feel consistent
          const score = Math.round(clamp(45 + (az - this.config.zEntry) * 20 + Math.min(18, Math.max(0, base.ouTStat) * 3), 42, 95))
          const confidence = Math.round(clamp(40 + (base.ouTStat - 1.5) * 20 + (az - this.config.zEntry) * 8, 35, 95))
          if (score < this.config.minScore) continue
          if (confidence < this.config.minConfidence) continue
          return { ...base, score, confidence, direction: dir }
        } catch {
          // thin history for this pair - try the next
        }
      }
    } catch {
      // screener/market not loaded - no signal source
    }
    return null
  }

  /**
   * Markov regime source: follow the chain when it assigns a decisive
   * next-move probability - CALL when P(up) clears the threshold, PUT when it
   * sits below its mirror - but never against/inside a chop regime, where the
   * chain's transition matrix degenerates toward coin-flipping.
   */
  private pickMarkovSignal(): ScreenRow | null {
    try {
      const screener = this.ctx.use<ScreenerService>('screener')
      const open = this.ctx.use<MarketDataService>('market').assets.filter((a) => a.open).map((a) => a.ticker)
      const candidates = [...LIQUID_CANDIDATES.filter((a) => open.includes(a)), ...open.filter((a) => !LIQUID_CANDIDATES.includes(a))]
      for (const asset of candidates) {
        if (this.assetBlocked(asset)) continue
        try {
          const r = screener.evaluate(asset, this.config.tf)
          if (r.regime === 'chop') continue // the chain has no edge in chop
          const dir: 'call' | 'put' | 'none' =
            r.pUp >= this.config.minPUp ? 'call' : r.pUp <= 1 - this.config.minPUp ? 'put' : 'none'
          if (dir === 'none') continue
          if (this.config.direction !== 'both' && dir !== this.config.direction) continue
          const edge = Math.abs(r.pUp - 0.5) * 2 // 0..1 decisiveness of the forecast
          const score = Math.round(clamp(40 + edge * 60 + (r.regime === 'bull' || r.regime === 'bear' ? 8 : 0), 40, 95))
          const confidence = Math.round(clamp(36 + edge * 55 + r.adx * 0.35, 35, 95))
          if (score < this.config.minScore) continue
          if (confidence < this.config.minConfidence) continue
          return { ...r, score, confidence, direction: dir }
        } catch {
          // thin history for this pair - try the next
        }
      }
    } catch {
      // screener/market not loaded - no signal source
    }
    return null
  }

  /**
   * Momentum source: ADX-confirmed trend continuation - CALL when trend
   * strength clears the ADX gate with a positive rate-of-change and RSI on
   * the bullish side of mid, PUT mirrored. Skips the extremes where the move
   * is already statistically exhausted (RSI beyond ~78 / below ~22).
   */
  private pickMomentumSignal(): ScreenRow | null {
    try {
      const screener = this.ctx.use<ScreenerService>('screener')
      const open = this.ctx.use<MarketDataService>('market').assets.filter((a) => a.open).map((a) => a.ticker)
      const candidates = [...LIQUID_CANDIDATES.filter((a) => open.includes(a)), ...open.filter((a) => !LIQUID_CANDIDATES.includes(a))]
      for (const asset of candidates) {
        if (this.assetBlocked(asset)) continue
        try {
          const r = screener.evaluate(asset, this.config.tf)
          if (r.adx < this.config.minAdx) continue
          let dir: 'call' | 'put' | 'none' = 'none'
          if (r.changePct > 0 && r.rsi >= 52 && r.rsi <= 78) dir = 'call'
          else if (r.changePct < 0 && r.rsi >= 22 && r.rsi <= 48) dir = 'put'
          if (dir === 'none') continue
          if (this.config.direction !== 'both' && dir !== this.config.direction) continue
          const score = Math.round(clamp(40 + (r.adx - this.config.minAdx) * 1.2 + Math.abs(r.rsi - 50) * 0.8, 40, 95))
          const confidence = Math.round(clamp(36 + (r.adx - this.config.minAdx) * 0.8 + Math.abs(r.changePct) * 6, 35, 95))
          if (score < this.config.minScore) continue
          if (confidence < this.config.minConfidence) continue
          return { ...r, score, confidence, direction: dir }
        } catch {
          // thin history for this pair - try the next
        }
      }
    } catch {
      // screener/market not loaded - no signal source
    }
    return null
  }

  /**
   * Confluence source: reads straight from Screener2Service - the dedicated
   * market-wide Confluence Signal sweep (screener2.ts), which runs the EXACT
   * same engine (confluenceSignalOnly) on the SAME deep candle history
   * (market.getCandlesDeep(..., 1500), archived + live tail) the single-asset
   * panel uses. This is a genuinely separate read from 'screener' above - not
   * derived from it, not borrowing its metadata. evaluate() returns the
   * sweep's cached row when fresh and recomputes on demand when stale, same
   * contract as ScreenerService.evaluate().
   */
  private pickConfluenceSignal(): ScreenRow | null {
    try {
      const screener2 = this.ctx.use<Screener2Service>('screener2')
      const market = this.ctx.use<MarketDataService>('market')
      const open = market.assets.filter((a) => a.open).map((a) => a.ticker)
      const restricted = this.config.watchlist.length > 0
      const pool = restricted ? this.config.watchlist.filter((a) => open.includes(a)) : open
      const candidates = [...LIQUID_CANDIDATES.filter((a) => pool.includes(a)), ...pool.filter((a) => !LIQUID_CANDIDATES.includes(a))]
      for (const asset of candidates) {
        if (this.assetBlocked(asset)) continue
        try {
          const row = screener2.evaluate(asset, this.config.tf)
          if (row.direction === 'none') continue
          if (this.config.direction !== 'both' && row.direction !== this.config.direction) continue
          if (Math.abs(row.score) < this.config.minScore) continue
          if (row.confidence < this.config.minConfidence) continue
          return ModeService.confluenceToScreenRow(row)
        } catch {
          // thin history for this pair - try the next
        }
      }
    } catch {
      // screener2/market not loaded - no signal source
    }
    return null
  }

  /**
   * Adapts a ConfluenceRow (screener2's real factor-based read) into the
   * ScreenRow shape pickSignal()/place() share across every source - only
   * asset/tf/price/score/direction/confidence/payout are ever read for
   * 'confluence' (see the detail string in place()); the screener-specific
   * scalar fields (rsi/adx/regime/hurst/ouZ/pUp/topPattern) don't apply to
   * this engine's output and are inert placeholders here, never surfaced.
   */
  private static confluenceToScreenRow(row: ConfluenceRow): ScreenRow {
    return {
      asset: row.asset,
      name: row.name,
      category: row.category,
      otc: row.otc,
      tf: row.tf,
      price: row.price,
      score: row.score,
      direction: row.direction,
      confidence: row.confidence,
      pUp: 0,
      regime: 'range',
      ouZ: 0,
      ouHalfLife: 0,
      ouMeanReverting: false,
      ouTStat: 0,
      rsi: 0,
      adx: 0,
      atrPct: 0,
      hurst: 0,
      changePct: 0,
      payout: row.payout,
      topPattern: null,
      ts: row.ts,
      computedTs: row.computedTs,
    }
  }

  /** Sanitizes a strategyParams patch/restore blob: {id: {key: number|string}},
   * dropping anything that doesn't match that shape. Same leniency as a
   * bot's own params - unknown keys are harmless (defaultParams() merge just
   * ignores them), so this only guards against garbage types, not against
   * keys a given strategy doesn't define. */
  private static sanitizeStrategyParams(v: unknown): Record<string, Record<string, number | string>> | undefined {
    if (!v || typeof v !== 'object') return undefined
    const out: Record<string, Record<string, number | string>> = {}
    for (const [id, params] of Object.entries(v as Record<string, unknown>)) {
      if (!params || typeof params !== 'object') continue
      const clean: Record<string, number | string> = {}
      for (const [k, val] of Object.entries(params as Record<string, unknown>)) {
        if (typeof val === 'number' && Number.isFinite(val)) clean[k] = val
        else if (typeof val === 'string' && val.trim()) clean[k] = val.trim()
      }
      if (Object.keys(clean).length) out[id] = clean
    }
    return Object.keys(out).length ? out : undefined
  }

  /** The ids this 'strategy' source currently trades - strategyIds when set
   * (one id = single strategy, 2+ = ensemble), falling back to the legacy
   * lone strategyId for configs saved before strategyIds existed. */
  private effectiveStrategyIds(): string[] {
    if (Array.isArray(this.config.strategyIds) && this.config.strategyIds.length) return this.config.strategyIds
    return this.config.strategyId ? [this.config.strategyId] : []
  }

  /**
   * Strategy source: evaluates one or more saved strategies (config.strategyIds)
   * market-wide, on every open candidate - the exact same strategyId/eval/params
   * path an autopilot bot uses (autopilot.ts's tradeForBot): a builtin id runs
   * through AnalyticsService.runStrategy with its own defaultParams merged
   * with any user overrides in config.strategyParams[id], an AI Lab-learned
   * id ("custom:...") runs through StrategyLabService.runStrategy (fixed
   * spec, no params). minScore/minConfidence are NOT applied here at all -
   * neither means anything for "trade exactly this strategy": the strategy's
   * own evaluate() already decided direction, and there is no shared score
   * scale across arbitrary strategies to threshold on. One id = trade it
   * directly. Two+ ids = either an ENSEMBLE (every member votes call/put/
   * none, majority direction wins, a tie votes nothing, minConfidence is
   * reused as the minimum AGREEMENT % the majority must reach) or, with
   * strategyPickMode 'best', an AUTO-LEARN pool (see below).
   */
  private pickStrategySignal(): ScreenRow | null {
    const ids = this.effectiveStrategyIds()
    if (!ids.length) return null // nothing picked yet - source configured but idle
    try {
      const market = this.ctx.use<MarketDataService>('market')
      const open = market.assets.filter((a) => a.open).map((a) => a.ticker)
      const restricted = this.config.watchlist.length > 0
      const pool = restricted ? this.config.watchlist.filter((a) => open.includes(a)) : open
      const candidates = [...LIQUID_CANDIDATES.filter((a) => pool.includes(a)), ...pool.filter((a) => !LIQUID_CANDIDATES.includes(a))]
      const analytics = this.ctx.use<AnalyticsService>('analytics')
      const lab = this.ctx.use<StrategyLabService>('lab')
      const specs = ids.map((id) => {
        const isCustom = id.startsWith('custom:')
        const strat = isCustom ? null : getStrategy(id)
        // user-configured overrides (same shape as a bot's own params) merged
        // over that strategy's defaults - never applies to a custom: lab spec,
        // which is a fixed learned structure with no exposed param schema
        const params = strat ? { ...defaultParams(strat), ...(this.config.strategyParams?.[id] ?? {}) } : undefined
        return { id, isCustom, params, valid: isCustom || Boolean(strat) }
      })
      const liveSpecs = specs.filter((s) => s.valid)
      if (!liveSpecs.length) return null // every picked id is unknown/removed - misconfigured
      for (const asset of candidates) {
        if (this.assetBlocked(asset)) continue
        const votes: Array<{ id: string; direction: 'call' | 'put'; score: number }> = []
        let price = 0
        for (const s of liveSpecs) {
          try {
            const ev = s.isCustom
              ? lab.runStrategy(asset, this.config.tf, s.id)
              : analytics.runStrategy(asset, this.config.tf, s.id, s.params)
            if (ev.direction === 'none') continue
            votes.push({ id: s.id, direction: ev.direction, score: ev.score })
            price = ev.price
          } catch {
            // thin history / bad pair for this member - other members still vote
          }
        }
        if (!votes.length) continue

        if (liveSpecs.length === 1) {
          // no minScore gate here - the strategy's own evaluate() already
          // decided this is a signal (direction !== 'none'); a second,
          // unrelated 0-100 "edge score" threshold on top of that doesn't
          // mean anything a user picking ONE specific strategy would expect
          const v = votes[0]
          if (this.config.direction !== 'both' && v.direction !== this.config.direction) continue
          return ModeService.strategyEvalToScreenRow(asset, this.config.tf, v.direction, v.score, price, `${v.id} score ${Math.abs(v.score).toFixed(0)}`, undefined, v.id)
        }

        if (this.config.strategyPickMode === 'best') {
          // auto-learn: rank this tick's firing members by THEIR OWN proven
          // record for THIS exact pair (adaptive.ts's Wilson-lower-bound
          // read, read-only here - never gates, only ranks), not a vote.
          // A member still cold-starting on this pair falls back to raw
          // |score| so it keeps getting picked often enough to build a
          // record; once any member clears the adaptive gate's own sample
          // floor, a proven result always outranks an unproven one.
          let adaptive: AdaptiveService | null = null
          try {
            adaptive = this.ctx.use<AdaptiveService>('adaptive')
          } catch {
            adaptive = null
          }
          let best: { id: string; direction: 'call' | 'put'; score: number; rank: number; proven: boolean } | null = null
          for (const v of votes) {
            let rank = Math.abs(v.score)
            let proven = false
            if (adaptive) {
              const verdict = adaptive.check(asset, this.config.tf, v.id, v.direction, v.score)
              if (verdict.trades >= adaptive.config.minSampleSize) {
                rank = verdict.wilsonLowerPct
                proven = true
              }
            }
            if (!best || (proven && !best.proven) || (proven === best.proven && rank > best.rank)) best = { id: v.id, direction: v.direction, score: v.score, rank, proven }
          }
          if (!best) continue
          if (this.config.direction !== 'both' && best.direction !== this.config.direction) continue
          const note = best.proven
            ? `auto-learn: ${best.id} proven best for ${asset} (${best.rank.toFixed(0)}% win rate, 95% floor)`
            : `auto-learn: ${best.id} highest edge for ${asset} (score ${Math.abs(best.score).toFixed(0)}) - still building its own record`
          return ModeService.strategyEvalToScreenRow(asset, this.config.tf, best.direction, best.score, price, note, best.proven ? Math.round(best.rank) : undefined, best.id)
        }

        // ensemble: majority vote, agreement %, average |score| of the agreeing members
        const calls = votes.filter((v) => v.direction === 'call')
        const puts = votes.filter((v) => v.direction === 'put')
        const majority = calls.length === puts.length ? null : calls.length > puts.length ? calls : puts
        if (!majority) continue // tied vote - no edge either way
        const direction = majority[0].direction
        if (this.config.direction !== 'both' && direction !== this.config.direction) continue
        const agreementPct = Math.round((majority.length / liveSpecs.length) * 100)
        if (agreementPct < this.config.minConfidence) continue
        const avgScore = majority.reduce((a, v) => a + Math.abs(v.score), 0) / majority.length
        return ModeService.strategyEvalToScreenRow(
          asset,
          this.config.tf,
          direction,
          avgScore,
          price,
          `ensemble ${majority.length}/${liveSpecs.length} agree (${majority.map((v) => v.id).join(', ')}) · avg ${avgScore.toFixed(0)}`,
          agreementPct,
          `ensemble:${majority.map((v) => v.id).join('+')}`
        )
      }
    } catch {
      // market/analytics/lab not loaded - no signal source
    }
    return null
  }

  /** Adapts a strategy/ensemble eval into the shared ScreenRow shape.
   * `note` carries the strategy-specific explanation shown in place of a
   * generic score/confidence (the member id(s) and what they said), and
   * `confidenceOverride` lets the ensemble path report agreement % instead
   * of the single-strategy default of mirroring |score|. Screener-specific
   * scalars are inert placeholders, as with confluenceToScreenRow above. */
  private static strategyEvalToScreenRow(
    asset: string,
    tf: Timeframe,
    direction: 'call' | 'put' | 'none',
    score: number,
    price: number,
    note?: string,
    confidenceOverride?: number,
    strategyLabel?: string
  ): ScreenRow {
    return {
      asset,
      name: asset,
      category: 'forex',
      otc: false,
      tf,
      price,
      score,
      direction,
      confidence: Math.round(clamp(confidenceOverride ?? Math.abs(score), 0, 100)),
      pUp: 0,
      regime: 'range',
      ouZ: 0,
      ouHalfLife: 0,
      ouMeanReverting: false,
      ouTStat: 0,
      rsi: 0,
      adx: 0,
      atrPct: 0,
      hurst: 0,
      changePct: 0,
      payout: 0,
      topPattern: null,
      note,
      strategyLabel,
      ts: Math.floor(Date.now() / 1000),
      computedTs: Math.floor(Date.now() / 1000),
    }
  }

  // ---------- kalman-ou walk-forward validation gate ----------

  static readonly OU_VALIDATION_TTL = 3600 // refresh verdicts hourly

  private ouVerdicts = new Map<string, { ts: number; validating: boolean; verdict: OUVerdict }>()
  private validatingAsset: string | null = null

  private ouKey(asset: string): string {
    return `${asset}|${this.config.tf}`
  }

  /** Fresh (non-expired) walk-forward verdict for the asset, if any. */
  private ouVerdict(asset: string): OUVerdict | null {
    const e = this.ouVerdicts.get(this.ouKey(asset))
    if (!e) return null
    if (this.now() - e.ts > ModeService.OU_VALIDATION_TTL) return null
    return e.verdict
  }

  /**
   * Lazy background validation - at most one runs at a time so the 10s
   * auto-trader tick never piles up heavy walk-forward work. The result is
   * announced on the alert bus so operators see why a pair started/stopped
   * being tradeable in no-human mode.
   */
  private ensureOUValidation(asset: string): void {
    const key = this.ouKey(asset)
    const entry = this.ouVerdicts.get(key)
    if (entry?.validating) return
    if (this.validatingAsset && this.validatingAsset !== key) return
    this.validatingAsset = key
    this.ouVerdicts.set(key, { ts: entry?.ts ?? 0, validating: true, verdict: entry?.verdict ?? ModeService.emptyVerdict(asset) })
    void this.validateOU(asset, this.config.tf)
      .then((v) => {
        this.ouVerdicts.set(key, { ts: this.now(), validating: false, verdict: v })
        this.emit(
          v.verdict === 'robust' ? 'info' : 'warn',
          `[AUTO-TRADER] OU walk-forward ${asset} ${this.config.tf}: ${v.verdict.toUpperCase()} - OOS ${v.oosNet >= 0 ? '+' : ''}$${v.oosNet.toFixed(2)} · ${v.winRate.toFixed(0)}% wr · ${v.foldsProfitable}/${v.folds} folds profitable · efficiency ${v.efficiencyPct.toFixed(0)}%`
        )
      })
      .catch(() => {
        this.ouVerdicts.delete(key)
      })
      .finally(() => {
        if (this.validatingAsset === key) this.validatingAsset = null
      })
  }

  static emptyVerdict(asset: string): OUVerdict {
    return { asset, tf: '1m', verdict: 'failed', oosNet: 0, isNet: 0, winRate: 0, efficiencyPct: 0, foldsProfitable: 0, folds: 0, totalTrades: 0, bestParams: {}, elapsedMs: 0, ts: 0 }
  }

  /**
   * Walk-forward validation of the OU edge on one (asset, tf): grid over the
   * tradeable OU params per fold, settle the fold winner out-of-sample with
   * the real binary settlement engine, then grade the aggregate. Robust =
   * OOS net positive, at least 2/3 folds profitable and >= 25% IS->OOS
   * efficiency; weak = profitable but not convincing; failed = anything else.
   */
  async validateOU(asset: string, tf: Timeframe): Promise<OUVerdict> {
    const market = this.ctx.use<MarketDataService>('market')
    const candles = market.getCandlesDeep(asset, tf, 2200)
    if (candles.length < 700) throw new Error(`not enough history for ${asset} ${tf} (${candles.length} bars)`)
    const result = walkForward(candles, asset, tf, {
      strategy: 'kalman-ou-reversion',
      sweep: {
        window: { from: 180, to: 300, step: 60 },
        zEntry: { from: 1.4, to: 2.4, step: 0.2 },
        maxHalfLife: { from: 30, to: 120, step: 30 },
      },
      objective: 'netPnl',
      minTrades: 5,
      maxCombos: 80,
      folds: 3,
      isRatio: 0.7,
      payout: 0.85,
      amount: 10,
      expiryBars: 1,
    })
    const oos = result.oos
    const verdict: OUVerdict['verdict'] =
      oos.netPnl > 0 && result.foldsProfitable >= 2 && result.efficiencyPct >= 25 && oos.totalTrades >= 10
        ? 'robust'
        : oos.netPnl > 0 && result.foldsProfitable >= 1
          ? 'weak'
          : 'failed'
    return {
      asset,
      tf,
      verdict,
      oosNet: Math.round(oos.netPnl * 100) / 100,
      isNet: Math.round(result.isNet * 100) / 100,
      winRate: Math.round(oos.winRate * 10) / 10,
      efficiencyPct: Math.round(result.efficiencyPct * 10) / 10,
      foldsProfitable: result.foldsProfitable,
      folds: result.folds.length,
      totalTrades: oos.totalTrades,
      bestParams: result.bestParams,
      elapsedMs: result.elapsedMs,
      ts: this.now(),
    }
  }

  private async place(row: ScreenRow, side: 'call' | 'put', amount: number): Promise<{ ok: boolean; error?: string }> {
    try {
      const exec = this.ctx.use<{
        accountSource: 'paper' | 'iq'
        placeOrder(req: {
          asset: string
          tf: Timeframe
          side: 'call' | 'put'
          kind: 'binary'
          amount: number
          expiryBars: number
          mode: 'paper' | 'live'
          strategy: string
          note: string
        }): Promise<{ ok: boolean; error?: string }>
      }>('execution')
      return await exec.placeOrder({
        asset: row.asset,
        tf: this.config.tf,
        side,
        kind: 'binary',
        amount,
        expiryBars: 1,
        // THE SAME BUG that was in autopilot.ts: this was hardcoded 'paper'
        // unconditionally, so the built-in AUTO-mode auto-trader could never
        // place a real order no matter what the account was connected to.
        // account source is the single routing truth (same as /trade and
        // autopilot.ts's bot execution path).
        mode: exec.accountSource === 'iq' ? 'live' : 'paper',
        strategy:
          this.config.signalSource === 'kalman-ou'
            ? 'kalman-ou-reversion'
            : this.config.signalSource === 'markov'
              ? 'markov-edge'
              : this.config.signalSource === 'momentum'
                ? 'supertrend-follow'
                : this.config.signalSource === 'confluence'
                  ? 'confluence-full'
                  : this.config.signalSource === 'strategy'
                    ? (row.strategyLabel ??
                      (() => {
                        const ids = this.effectiveStrategyIds()
                        return ids.length > 1 ? `ensemble:${ids.join('+')}` : ids[0] ?? 'custom-strategy'
                      })())
                    : 'screener-auto',
        note: AUTOTRADER_NOTE,
      })
    } catch {
      return { ok: false, error: 'execution service unavailable' }
    }
  }

  private standDown(reason: string): void {
    if (this.rt.lastRejection === reason) return
    this.rt.lastRejection = reason
    this.emit('info', `[AUTO-TRADER] standing down: ${reason}`)
  }

  private hasOpenAutoOn(asset: string): boolean {
    try {
      const store = this.ctx.use<Store>('store')
      return store
        .listPositions('open', 100)
        .some((p) => p.note?.startsWith('auto:') && p.asset === asset)
    } catch {
      return false
    }
  }

  /** Cooldown + one-auto-position-per-asset + optional watchlist restriction,
   * applied by every signal picker (all 4 sources funnel through this). */
  private assetBlocked(asset: string): boolean {
    if (this.config.watchlist.length > 0 && !this.config.watchlist.includes(asset)) return true
    const rejectedUntil = this.assetRejectedUntil.get(asset) ?? 0
    if (this.now() < rejectedUntil) return true
    const last = this.rt.lastAssetTs.get(asset) ?? 0
    if (this.config.cooldownSec > 0 && this.now() - last < this.config.cooldownSec) return true
    return this.hasOpenAutoOn(asset)
  }

  private emit(level: 'info' | 'warn' | 'danger' | 'success', message: string): void {
    this.ctx.bus.emit('alert', { level, message, ts: this.now() })
  }

  // ---------- stats (rebuilt from the journal, same pattern as autopilot) ----------

  private rolloverIfNeeded(): void {
    const dayKey = new Date().toISOString().slice(0, 10)
    if (this.rt.dayKey !== dayKey) {
      this.rt = { ...ModeService.freshRuntime(), pnlTotal: this.rt.pnlTotal, lastAssetTs: new Map() }
    }
  }

  private rebuildRuntime(): void {
    const rt = ModeService.freshRuntime()
    // restore the compounding roll from the persisted config (survives restarts)
    if (this.config.planState) {
      rt.pot = this.config.planState.pot
      rt.rollN = this.config.planState.rollN
      rt.restarts = this.config.planState.restarts
      rt.halted = this.config.planState.halted
      rt.complete = this.config.planState.complete
    }
    try {
      const closed = this.store.listPositions('closed', 400).filter((p) => p.note?.startsWith('auto:'))
      const open = this.store.listPositions('open', 100).filter((p) => p.note?.startsWith('auto:'))
      rt.openCount = open.length
      for (const p of open) rt.lastAssetTs.set(p.asset, p.tsOpen)
      for (const p of closed) {
        const pnl = p.pnl ?? 0
        rt.pnlTotal += pnl
        const day = new Date((p.tsClose ?? p.tsOpen) * 1000).toISOString().slice(0, 10)
        if (day !== rt.dayKey) continue
        rt.trades += 1
        if (p.status === 'won') {
          rt.wins += 1
          rt.pnlToday += pnl
        } else if (p.status === 'lost') {
          rt.losses += 1
          rt.pnlToday += pnl
        }
        rt.lastAssetTs.set(p.asset, Math.max(rt.lastAssetTs.get(p.asset) ?? 0, p.tsOpen))
      }
      rt.lastTradeTs = closed.reduce((acc, p) => Math.max(acc, p.tsOpen), 0)
    } catch {
      // journal unavailable - start from zero
    }
    this.rt = rt
  }

  private onPositionClosed(position: { note?: string; pnl?: number; status: string; tsOpen: number; tsClose?: number; amount: number; payout: number }): void {
    if (!position.note?.startsWith('auto:')) return
    this.rolloverIfNeeded()
    this.rt.openCount = Math.max(0, this.rt.openCount - 1)
    const pnl = position.pnl ?? 0
    this.rt.pnlTotal += pnl
    if (position.status === 'won') {
      this.rt.wins += 1
      this.rt.pnlToday += pnl
    } else if (position.status === 'lost') {
      this.rt.losses += 1
      this.rt.pnlToday += pnl
    }

    // compounding roll - SAME fold-in/burn math as autopilot.ts's
    // onPositionClosed, applied to the auto-trader's own single roll
    const plan = this.config.stakePlan
    if (plan) {
      const base = plan.base
      const working = this.rt.pot >= 0.01 ? this.rt.pot : base
      if (position.status === 'won') {
        const cap = (plan.payoutCap ?? 70) / 100
        const fold = Math.min(pnl, position.amount * cap)
        this.rt.pot = Math.round((working + fold) * 100) / 100
        this.rt.rollN += 1
        const periods = plan.periods
        if (periods && this.rt.rollN >= periods) {
          this.rt.restarts += 1
          const banked = Math.round((this.rt.pot - base) * 100) / 100
          if (plan.onComplete === 'reseed') {
            this.rt.pot = 0
            this.rt.rollN = 0
            this.emit('success', `[AUTO-TRADER] compound cycle COMPLETE - ${periods} periods, +$${banked.toFixed(2)} banked - re-seeding $${base}`)
          } else {
            this.rt.halted = true
            this.rt.complete = true
            this.emit('success', `[AUTO-TRADER] compound cycle COMPLETE - ${periods} periods, +$${banked.toFixed(2)} banked - standing down; restart for a fresh cycle`)
          }
        }
      } else if (position.status === 'lost') {
        this.rt.pot = Math.round(Math.max(0, working - position.amount) * 100) / 100
        const kept = this.rt.pot
        if (this.rt.rollN > 0) this.rt.restarts += 1
        this.rt.rollN = 0
        if (plan.stopOnLoss !== false) {
          this.rt.halted = true
          this.rt.complete = false
          this.emit('warn', `[AUTO-TRADER] compound cycle ENDED on a loss (-$${Math.abs(pnl).toFixed(2)})${kept >= 0.01 ? ` - $${kept.toFixed(2)} of the pot stays banked on the balance` : ''} - restart to trade again`)
        }
      }
      this.persistPlanState()
    }
  }

  // ---------- config ----------

  private static isPlanState(v: unknown): v is NonNullable<AutoTraderConfig['planState']> {
    if (!v || typeof v !== 'object') return false
    const p = v as Record<string, unknown>
    return typeof p.pot === 'number' && typeof p.rollN === 'number' && typeof p.restarts === 'number' && typeof p.halted === 'boolean' && typeof p.complete === 'boolean'
  }

  /** Mirrors autopilot.ts's parseStakePlan - same shape, same clamps. */
  private parseStakePlan(raw: unknown, existing?: AutoStakePlan): AutoStakePlan | undefined {
    const p = (raw ?? existing) as Partial<AutoStakePlan> | undefined
    if (!p || p.kind !== 'compound') return undefined
    const base = Math.max(1, Number(p.base) || 1)
    return {
      kind: 'compound',
      base,
      rollPct: p.rollPct !== undefined ? clamp(Number(p.rollPct) || 100, 1, 100) : undefined,
      maxStake: p.maxStake !== undefined && Number(p.maxStake) > 0 ? Number(p.maxStake) : undefined,
      payoutCap: p.payoutCap !== undefined ? clamp(Number(p.payoutCap) || 70, 1, 70) : 70,
      stopOnLoss: p.stopOnLoss !== false,
      periods: p.periods !== undefined && Number(p.periods) > 0 ? Math.round(Number(p.periods)) : undefined,
      deriskAfter: p.deriskAfter !== undefined && Number(p.deriskAfter) > 0 ? Math.round(Number(p.deriskAfter)) : undefined,
      deriskPct: p.deriskAfter !== undefined && Number(p.deriskAfter) > 0 ? clamp(Number(p.deriskPct) || 50, 1, 100) : undefined,
      onComplete: p.onComplete === 'reseed' ? 'reseed' : 'halt',
    }
  }

  /** Mirrors autopilot.ts's stakeFor - same compounding math, same dust guard. */
  private stakeForAuto(): { amount: number; pot: number; rollN: number; compound: boolean; phase: 'compound' | 'derisk' } {
    const plan = this.config.stakePlan
    if (!plan) return { amount: this.config.stake, pot: 0, rollN: 0, compound: false, phase: 'compound' }
    const pot = this.rt.pot >= 0.01 ? this.rt.pot : plan.base
    const derisk = plan.deriskAfter !== undefined && plan.deriskPct !== undefined && this.rt.rollN >= plan.deriskAfter
    const rollPct = derisk ? plan.deriskPct! : (plan.rollPct ?? 100)
    const raw = (pot * rollPct) / 100
    const amount = Math.min(plan.maxStake ?? 5000, Math.max(1, Math.round(raw * 100) / 100))
    return { amount, pot, rollN: this.rt.rollN, compound: true, phase: derisk ? 'derisk' : 'compound' }
  }

  /** Clears a halted/complete compounding cycle and re-seeds the pot at base. */
  restart(): { ok: boolean; error?: string } {
    if (!this.config.stakePlan) return { ok: false, error: 'restart applies to a compounding auto-trader plan only' }
    this.rt.pot = 0
    this.rt.rollN = 0
    this.rt.halted = false
    this.rt.complete = false
    this.persistPlanState()
    this.emit('success', `[AUTO-TRADER] compound cycle RESTARTED - next trade seeds $${this.config.stakePlan.base}`)
    return { ok: true }
  }

  private persistPlanState(): void {
    this.config.planState = { pot: this.rt.pot, rollN: this.rt.rollN, restarts: this.rt.restarts, halted: this.rt.halted, complete: this.rt.complete }
    this.persist()
  }

  configure(patch: Partial<AutoTraderConfig>): { ok: boolean; config: AutoTraderConfig; error?: string } {
    if (patch.enabled !== undefined) this.config.enabled = Boolean(patch.enabled)
    if (patch.signalSource !== undefined && (['screener', 'kalman-ou', 'markov', 'momentum', 'confluence', 'strategy'] as const).includes(patch.signalSource as AutoTraderSource))
      this.config.signalSource = patch.signalSource as AutoTraderSource
    if (patch.tf !== undefined) this.config.tf = String(patch.tf) as Timeframe
    if (patch.stake !== undefined) this.config.stake = clamp(Number(patch.stake) || DEFAULT_AUTOTRADER.stake, 1, 5000)
    if (patch.minScore !== undefined) this.config.minScore = clamp(Number(patch.minScore) || 0, 0, 100)
    if (patch.minConfidence !== undefined) this.config.minConfidence = clamp(Number(patch.minConfidence) || 0, 0, 100)
    if (patch.zEntry !== undefined) this.config.zEntry = clamp(Number(patch.zEntry) || DEFAULT_AUTOTRADER.zEntry, 0.5, 4)
    if (patch.maxHalfLife !== undefined) this.config.maxHalfLife = Math.round(clamp(Number(patch.maxHalfLife) || DEFAULT_AUTOTRADER.maxHalfLife, 5, 999))
    if (patch.requireValidation !== undefined) this.config.requireValidation = Boolean(patch.requireValidation)
    if (patch.minPUp !== undefined) this.config.minPUp = clamp(Number(patch.minPUp) || DEFAULT_AUTOTRADER.minPUp, 0.5, 0.75)
    if (patch.minAdx !== undefined) this.config.minAdx = clamp(Number(patch.minAdx) || DEFAULT_AUTOTRADER.minAdx, 10, 45)
    if (patch.strategyId !== undefined)
      this.config.strategyId = typeof patch.strategyId === 'string' && patch.strategyId.trim() ? patch.strategyId.trim() : undefined
    if (patch.strategyIds !== undefined)
      this.config.strategyIds = Array.isArray(patch.strategyIds)
        ? patch.strategyIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
        : undefined
    if (patch.strategyPickMode !== undefined) this.config.strategyPickMode = patch.strategyPickMode === 'best' ? 'best' : 'ensemble'
    if (patch.strategyParams !== undefined) this.config.strategyParams = ModeService.sanitizeStrategyParams(patch.strategyParams)
    if (patch.direction !== undefined && ['both', 'call', 'put'].includes(String(patch.direction)))
      this.config.direction = String(patch.direction) as AutoTraderConfig['direction']
    if (patch.maxOpen !== undefined) this.config.maxOpen = Math.round(clamp(Number(patch.maxOpen) || 1, 1, 10))
    if (patch.cooldownSec !== undefined) this.config.cooldownSec = Math.round(clamp(Number(patch.cooldownSec) || 0, 0, 3600))
    if (patch.paceSec !== undefined) this.config.paceSec = Math.round(clamp(Number(patch.paceSec) || 0, 0, 3600))
    if (patch.dailyProfitTarget !== undefined) this.config.dailyProfitTarget = Math.max(0, Number(patch.dailyProfitTarget) || 0)
    if (patch.dailyLossLimit !== undefined) this.config.dailyLossLimit = Math.max(0, Number(patch.dailyLossLimit) || 0)
    if (patch.watchlist !== undefined)
      this.config.watchlist = Array.isArray(patch.watchlist) ? patch.watchlist.filter((x): x is string => typeof x === 'string') : []
    if (patch.stakePlan !== undefined) {
      const planChanged = JSON.stringify(this.config.stakePlan ?? null) !== JSON.stringify(patch.stakePlan ?? null)
      this.config.stakePlan = this.parseStakePlan(patch.stakePlan, this.config.stakePlan)
      // switching the plan itself (not just tuning a field on the same plan)
      // starts a fresh roll - an old pot/halt state from a different config
      // would be meaningless carried into a newly (re)enabled plan
      if (planChanged) {
        this.rt.pot = 0
        this.rt.rollN = 0
        this.rt.halted = false
        this.rt.complete = false
        this.config.planState = { pot: 0, rollN: 0, restarts: this.rt.restarts, halted: false, complete: false }
      }
    }
    this.persist()
    this.rt.lastRejection = undefined
    const srcDetail =
      this.config.signalSource === 'kalman-ou'
        ? ` (z ≥ ${this.config.zEntry}σ · HL ≤ ${this.config.maxHalfLife}b${this.config.requireValidation ? ' · walk-forward validated' : ''})`
        : this.config.signalSource === 'markov'
          ? ` (P(up) ≥ ${(this.config.minPUp * 100).toFixed(0)}% / ≤ ${((1 - this.config.minPUp) * 100).toFixed(0)}%)`
          : this.config.signalSource === 'momentum'
            ? ` (ADX ≥ ${this.config.minAdx})`
            : this.config.signalSource === 'confluence'
              ? ' (full 14-factor panel engine, bar-fresh)'
              : this.config.signalSource === 'strategy'
                ? (() => {
                    const ids = this.effectiveStrategyIds()
                    return ids.length === 0
                      ? ' (no strategy picked)'
                      : ids.length === 1
                        ? ` (${ids[0]})`
                        : this.config.strategyPickMode === 'best'
                          ? ` (auto-learn over ${ids.length}: ${ids.join(', ')} - trades whichever is proven best per pair)`
                          : ` (ensemble of ${ids.length}: ${ids.join(', ')} · ≥${this.config.minConfidence}% agreement)`
                  })()
                : ''
    this.emit(
      'info',
      `AUTO-TRADER config: ${this.config.enabled ? 'armed' : 'off'} · src ${this.config.signalSource}${srcDetail} · ${this.config.tf} · stake $${this.config.stake} · minScore ${this.config.minScore} · minConf ${this.config.minConfidence} · maxOpen ${this.config.maxOpen} · cooldown ${this.config.cooldownSec}s`
    )
    return { ok: true, config: { ...this.config } }
  }

  status(): {
    mode: OsMode
    ts: number
    reason: string
    autotrader: {
      config: AutoTraderConfig
      trades: number
      wins: number
      losses: number
      pnlToday: number
      pnlTotal: number
      openCount: number
      lastTradeTs: number
      lastAction?: string
      lastRejection?: string
      active: boolean
    }
  } {
    return {
      mode: this.mode,
      ts: this.ts,
      reason: this.reason,
      autotrader: {
        config: { ...this.config },
        trades: this.rt.trades,
        wins: this.rt.wins,
        losses: this.rt.losses,
        pnlToday: Math.round(this.rt.pnlToday * 100) / 100,
        pnlTotal: Math.round(this.rt.pnlTotal * 100) / 100,
        openCount: this.rt.openCount,
        lastTradeTs: this.rt.lastTradeTs,
        lastAction: this.rt.lastAction,
        lastRejection: this.rt.lastRejection,
        active: this.mode === 'auto' && this.config.enabled,
      },
    }
  }

  // ---------- lifecycle wiring ----------

  wire(): void {
    this.unsubscribers.push(
      this.ctx.bus.on('positionClosed', ({ position }) => this.onPositionClosed(position))
    )
  }
}

let activeMode: ModeService | null = null

export const osModePlugin: Plugin = {
  name: 'osmode',
  start: async (ctx) => {
    const svc = new ModeService()
    activeMode = svc
    ctx.provide('mode', svc)
    await svc.start(ctx)
    svc.wire()
  },
  stop: () => {
    try {
      activeMode?.stop()
    } catch {
      // not started
    }
    activeMode = null
  },
}
