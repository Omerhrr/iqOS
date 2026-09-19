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
// The mode is persisted, so restarts resume the same intent. Sentinel, the
// watchdog and the base risk manager ALWAYS outrank the mode: flipping to
// AUTO grants autonomy, never exemption. PANIC drops the OS back to HUMAN.

import type { Plugin, KernelContext } from '../kernel'
import type { Store } from '../store'
import type { Timeframe } from '../types'
import type { ScreenerService, ScreenRow } from './screener'
import type { MarketDataService } from './market-data'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export type OsMode = 'human' | 'auto'

export interface AutoTraderConfig {
  enabled: boolean // auto-trader armed (it only ever trades while mode = auto)
  signalSource: 'screener' | 'kalman-ou' // where entry signals come from
  tf: Timeframe // which screener timeframe to source signals from
  stake: number
  minScore: number // minimum |score| to act on (composite or OU edge score)
  minConfidence: number // minimum signal confidence (0-100)
  zEntry: number // kalman-ou source: |z| (stationary sigmas) required to enter
  maxHalfLife: number // kalman-ou source: skip pairs reverting slower than this (bars)
  direction: 'both' | 'call' | 'put'
  maxOpen: number // max concurrent auto-trader positions
  cooldownSec: number // per-asset re-entry cooldown
  paceSec: number // minimum seconds between any two auto trades
  dailyProfitTarget: number // 0 = off
  dailyLossLimit: number // 0 = off
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
  direction: 'both',
  maxOpen: 3,
  cooldownSec: 180,
  paceSec: 45,
  dailyProfitTarget: 0,
  dailyLossLimit: 0,
}

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
}

export class ModeService {
  private ctx!: KernelContext
  private store!: Store
  private unsubscribers: (() => void)[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

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
          signalSource: c.signalSource === 'kalman-ou' ? 'kalman-ou' : 'screener',
          tf: (typeof c.tf === 'string' ? c.tf : DEFAULT_AUTOTRADER.tf) as Timeframe,
          stake: num(c.stake, DEFAULT_AUTOTRADER.stake),
          minScore: num(c.minScore, DEFAULT_AUTOTRADER.minScore),
          minConfidence: num(c.minConfidence, DEFAULT_AUTOTRADER.minConfidence),
          zEntry: num(c.zEntry, DEFAULT_AUTOTRADER.zEntry),
          maxHalfLife: num(c.maxHalfLife, DEFAULT_AUTOTRADER.maxHalfLife),
          direction: c.direction === 'call' || c.direction === 'put' ? c.direction : 'both',
          maxOpen: Math.round(num(c.maxOpen, DEFAULT_AUTOTRADER.maxOpen)),
          cooldownSec: Math.round(num(c.cooldownSec, DEFAULT_AUTOTRADER.cooldownSec)),
          paceSec: Math.round(num(c.paceSec, DEFAULT_AUTOTRADER.paceSec)),
          dailyProfitTarget: num(c.dailyProfitTarget, 0),
          dailyLossLimit: num(c.dailyLossLimit, 0),
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

    const side = row.direction === 'put' ? 'put' : 'call'
    const out = await this.place(row, side)
    if (!out.ok) return this.standDown(out.error ?? 'order rejected')

    this.rt.trades += 1
    this.rt.lastTradeTs = this.now()
    this.rt.lastAssetTs.set(row.asset, this.now())
    this.rt.openCount += 1
    this.rt.lastRejection = undefined
    this.rt.lastAction = `${side.toUpperCase()} ${row.asset}`
    const detail =
      this.config.signalSource === 'kalman-ou'
        ? `OU z ${row.ouZ.toFixed(2)}σ · HL ${row.ouHalfLife >= 9999 ? '∞' : row.ouHalfLife.toFixed(0)}b · t ${row.ouTStat.toFixed(1)} · edge ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)}`
        : `score ${Math.abs(row.score).toFixed(0)} conf ${row.confidence.toFixed(0)} regime ${row.regime}`
    this.emit(
      'success',
      `[AUTO-TRADER] ${side.toUpperCase()} ${row.asset} ${this.config.tf} $${this.config.stake} binary - ${detail}`
    )
  }

  private pickSignal(): ScreenRow | null {
    if (this.config.signalSource === 'kalman-ou') return this.pickOUSignal()
    try {
      const screener = this.ctx.use<ScreenerService>('screener')
      const dir = this.config.direction === 'both' ? undefined : this.config.direction
      const { rows } = screener.top({ tf: this.config.tf, minScore: this.config.minScore, direction: dir, limit: 12 })
      for (const r of rows) {
        if (r.direction === 'none') continue
        if (r.confidence < this.config.minConfidence) continue
        if (this.assetBlocked(r.asset)) continue
        return r
      }
      // sweep still warming (or rows stale) - evaluate liquid pairs directly
      for (const asset of LIQUID_CANDIDATES) {
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

  private async place(row: ScreenRow, side: 'call' | 'put'): Promise<{ ok: boolean; error?: string }> {
    try {
      const exec = this.ctx.use<{
        placeOrder(req: {
          asset: string
          tf: Timeframe
          side: 'call' | 'put'
          kind: 'binary'
          amount: number
          expiryBars: number
          mode: 'paper'
          strategy: string
          note: string
        }): Promise<{ ok: boolean; error?: string }>
      }>('execution')
      return await exec.placeOrder({
        asset: row.asset,
        tf: this.config.tf,
        side,
        kind: 'binary',
        amount: this.config.stake,
        expiryBars: 1,
        mode: 'paper',
        strategy: this.config.signalSource === 'kalman-ou' ? 'kalman-ou-reversion' : 'screener-auto',
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

  /** Cooldown + one-auto-position-per-asset, applied by the signal picker. */
  private assetBlocked(asset: string): boolean {
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

  private onPositionClosed(position: { note?: string; pnl?: number; status: string; tsOpen: number; tsClose?: number }): void {
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
  }

  // ---------- config ----------

  configure(patch: Partial<AutoTraderConfig>): { ok: boolean; config: AutoTraderConfig; error?: string } {
    if (patch.enabled !== undefined) this.config.enabled = Boolean(patch.enabled)
    if (patch.signalSource !== undefined) this.config.signalSource = patch.signalSource === 'kalman-ou' ? 'kalman-ou' : 'screener'
    if (patch.tf !== undefined) this.config.tf = String(patch.tf) as Timeframe
    if (patch.stake !== undefined) this.config.stake = clamp(Number(patch.stake) || DEFAULT_AUTOTRADER.stake, 1, 5000)
    if (patch.minScore !== undefined) this.config.minScore = clamp(Number(patch.minScore) || 0, 0, 100)
    if (patch.minConfidence !== undefined) this.config.minConfidence = clamp(Number(patch.minConfidence) || 0, 0, 100)
    if (patch.zEntry !== undefined) this.config.zEntry = clamp(Number(patch.zEntry) || DEFAULT_AUTOTRADER.zEntry, 0.5, 4)
    if (patch.maxHalfLife !== undefined) this.config.maxHalfLife = Math.round(clamp(Number(patch.maxHalfLife) || DEFAULT_AUTOTRADER.maxHalfLife, 5, 999))
    if (patch.direction !== undefined && ['both', 'call', 'put'].includes(String(patch.direction)))
      this.config.direction = String(patch.direction) as AutoTraderConfig['direction']
    if (patch.maxOpen !== undefined) this.config.maxOpen = Math.round(clamp(Number(patch.maxOpen) || 1, 1, 10))
    if (patch.cooldownSec !== undefined) this.config.cooldownSec = Math.round(clamp(Number(patch.cooldownSec) || 0, 0, 3600))
    if (patch.paceSec !== undefined) this.config.paceSec = Math.round(clamp(Number(patch.paceSec) || 0, 0, 3600))
    if (patch.dailyProfitTarget !== undefined) this.config.dailyProfitTarget = Math.max(0, Number(patch.dailyProfitTarget) || 0)
    if (patch.dailyLossLimit !== undefined) this.config.dailyLossLimit = Math.max(0, Number(patch.dailyLossLimit) || 0)
    this.persist()
    this.rt.lastRejection = undefined
    this.emit(
      'info',
      `AUTO-TRADER config: ${this.config.enabled ? 'armed' : 'off'} · src ${this.config.signalSource}${this.config.signalSource === 'kalman-ou' ? ` (z ≥ ${this.config.zEntry}σ · HL ≤ ${this.config.maxHalfLife}b)` : ''} · ${this.config.tf} · stake $${this.config.stake} · minScore ${this.config.minScore} · minConf ${this.config.minConfidence} · maxOpen ${this.config.maxOpen} · cooldown ${this.config.cooldownSec}s`
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
