// IQAIR//OS - Omni Trader plugin
//
// Per direct instruction: build an engine that can "handle situations"
// Meta Trader/the auto-trader/autopilot bots structurally cannot - not a
// replacement for any of them, a FOURTH execution path for strategies
// whose whole premise is sub-bar, tick-time reactivity (e.g. "institutional
// delta absorption": tick velocity collapsing to near-zero while delta
// spikes, then bursting the other way, ALL WITHIN one still-forming
// candle). Every other engine in this kernel evaluates on CLOSED candles
// only (Autopilot literally ignores every non-closed 'candle' bus event;
// Meta Trader/OS-mode poll every 10s in real time, but still only ever
// feed closed-candle history into a script) - so "wait for the candle to
// close, then check if the reversal already happened" is the best any of
// them can honestly offer, which is NOT what a tick-reactive strategy
// needs. Omni Trader closes that gap, specifically:
//
//   - polls on a MUCH tighter wall-clock loop than Meta Trader (default
//     2s, configurable down to 1s) instead of waiting for a candle close
//   - feeds the CURRENTLY FORMING bar (`live()`) and the raw live tick
//     buffer (`tick.delta/velocity/ratio/count()`, analytics/strategylang.
//     ts's MSL primitives) into the script ADDITIONALLY to the normal
//     closed-bar `ind.*`/`ohlc()`/panel reads - a script can combine both
//     in one expression (closed-bar context + this-instant tick behavior)
//
// It trades exactly one saved SCRIPT meta-strategy spec (plugins/
// metastrategy.ts's MetaStrategyService.evaluateLive() - conditions-built
// specs never touch strategylang.ts, so there's nothing live to feed them;
// evaluateLive() fails closed on one of those rather than silently falling
// back) - same "point it at a spec, don't reinvent config UI" shape Meta
// Trader already uses for its own 'meta-strategy' source.
//
// What it does NOT skip: the same account-level floor everything else in
// this kernel respects. ExecutionService.placeOrder() still enforces the
// kill switch, risk manager, market-open/balance checks; the global OS
// mode gate (plugins/os-mode.ts) still stands this down on HUMAN, same as
// Meta Trader and the auto-trader. "A faster loop" is Omni Trader's own
// freedom from CANDLE-CLOSE pacing, never freedom from those floors.
//
// REST surface mirrors Meta Trader's own shape: GET /omni_trader_status,
// POST /omni_trader_config.

import type { Plugin, KernelContext } from '../kernel'
import type { Store } from '../store'
import type { Timeframe, TradeKind } from '../types'
import { TIMEFRAME_SECONDS } from '../types'
import type { MarketDataService } from './market-data'
import type { MetaStrategyService } from './metastrategy'
import type { MslBarValue } from '../analytics/strategylang'
import type { OsMode } from './os-mode'
import { SweepEdgeMemory } from '../analytics/edge'
import { correlatedWith, ScanRotation } from '../analytics/correlation'
import { scanSetups, excludeHeld, SetupCache } from '../analytics/setupscan'

/** Same liquid-first default watchlist Meta Trader's own candidatePool()
 * uses - duplicated rather than imported, same dependency-isolation
 * reasoning every small constant copy in this codebase already follows
 * (see e.g. plugins/metatrader.ts's own copy of this exact list). */
const LIQUID_CANDIDATES = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD', 'BTCUSD']
/** Bound on how many assets one tick evaluates - a universe spike shouldn't
 * turn one fast cycle into a multi-second stall (this engine's whole point
 * is a TIGHT loop, so this cap is smaller than Meta Trader's 50). */
const SUB_MINUTE_CAP = 6 // pairs a sub-minute script (story.sp/ssp, tick.*, timing.*) scans: it needs each pair's live 5s/tick path, and only live-polled pairs have one
const MAX_TICK_ASSETS = 24 // default scan window; configurable (`scanBatch`, 6-150) - each tick evaluates this many, in a shuffled rotation over every open pair
/** Up to this many ranked candidates get a REAL placeOrder attempt per
 * tick, same reasoning as Meta Trader's MAX_PLACE_ATTEMPTS_PER_TICK. */
const MAX_PLACE_ATTEMPTS_PER_TICK = 3
const HARD_STOP_RE =
  /kill switch engaged|market closed for|amount must be positive|exceeds max stake|insufficient balance|live balance unknown|live broker not connected|unknown asset |no price feed|execution service unavailable/i
/** Floor on the poll interval - below this, the loop risks hammering the
 * broker sidecar/CPU for no real benefit (the live tick buffer itself
 * only updates on the sidecar's own ~100ms/8s merge cadence - see
 * plugins/otcfootprint.ts), and ceiling keeps it meaningfully tighter than
 * Meta Trader's fixed 10s. */
const MIN_INTERVAL_MS = 1000
const MAX_INTERVAL_MS = 10_000
const DEFAULT_INTERVAL_MS = 2000

export interface OmniTraderConfig {
  enabled: boolean
  /** which saved SCRIPT meta-strategy to trade - evaluateLive() fails
   * closed if this id resolves to a conditions-built spec instead. */
  metaStrategyId?: string
  /** timeframe the script's CLOSED-bar primitives (ind.* / ohlc() / panel
   * reads) read from - separate from the live tick/forming-bar feed, which
   * has no timeframe of its own. */
  tf: Timeframe
  direction: 'call' | 'put' | 'both'
  minConfidence: number
  stake: number
  maxOpen: number
  kind: TradeKind
  expiryTf?: Timeframe
  /** Exact binary/turbo expiry in WHOLE MINUTES (1,2,3,4,5,15,30,45,60 - what IQ accepts). Overrides expiryTf's bar rounding, so 3m/4m work on any signal tf. Undefined = use expiryTf. */
  expiryMin?: number
  expirySec?: number
  marketScope: 'all' | 'real' | 'otc'
  cooldownSec: number
  /** GLOBAL cooldown in seconds: no new trade on ANY pair for this long after the last trade this trader placed. 0 (default) = off. Independent of the per-asset `cooldownSec`. */
  globalCooldownSec: number
  /** when true, an order uses the expiry the STRATEGY asked for (`expiry = <minutes>` in its script) instead of the fixed expiry below; a signal whose script set none falls back to the fixed one. Off by default. */
  useScriptExpiry: boolean
  /** wall-clock poll interval in ms - clamped to [MIN_INTERVAL_MS,
   * MAX_INTERVAL_MS]. This, not candle closes, paces the whole engine. */
  intervalMs: number
  /** explicit watchlist override - undefined = the same liquid-first
   * default pool Meta Trader uses, capped at MAX_TICK_ASSETS. */
  assets?: string[]
  /** how many pairs each tick evaluates (6-150). The pool is shuffled and visited in windows of this size, so every open pair gets looked at over successive ticks. */
  scanBatch?: number
  /** don't open a trade that duplicates the exposure of one this trader already has open (same-sign exposure to a currency / metals / crypto, see analytics/correlation.ts). Default on. */
  correlationGuard?: boolean
  /** 'all' = every open pair is a candidate (shuffled windows); 'setups' = the TRADING PLAN scan decides the pool: only pairs in a favourable setup (trend not gone too far, away from avoid zones) are given to the strategy,
   * and after every trade the scan is redone without the pair just traded or anything that duplicates its exposure. */
  poolMode?: 'all' | 'setups'
  /** how long a setup scan is reused (seconds) before it is redone; a trade always forces a rescan. */
  setupScanSec?: number
  /** only setups at or above this quality (0-100) enter the pool */
  setupMinQuality?: number
}

export interface OmniTraderRuntime {
  trades: number
  wins: number
  losses: number
  pnlTotal: number
  openCount: number
  lastTradeTs: number
  lastAction?: string
  lastRejection?: string
}

interface OmniCandidate {
  asset: string
  direction: 'call' | 'put'
  confidence: number
  note: string
  /** the script's own `expiry = <minutes>` for this signal, when it set one */
  expiryMin?: number
}

const DEFAULT_OMNI_TRADER: OmniTraderConfig = {
  enabled: false,
  tf: '1m',
  direction: 'both',
  minConfidence: 60,
  stake: 1,
  maxOpen: 3,
  kind: 'binary',
  marketScope: 'all',
  cooldownSec: 0,
  globalCooldownSec: 0,
  scanBatch: MAX_TICK_ASSETS,
  correlationGuard: true,
  poolMode: 'all',
  setupScanSec: 30,
  setupMinQuality: 0,
  useScriptExpiry: false,
  intervalMs: DEFAULT_INTERVAL_MS,
}

/** Same "note starts with X" identity contract every engine in this kernel
 * uses (META_TRADER_NOTE, 'auto:os-trader', ...) so position counting/
 * closing never confuses this engine's trades with any other's. */
const OMNI_TRADER_NOTE = 'omni:trader'

export class OmniTraderService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private store!: Store
  private config: OmniTraderConfig = { ...DEFAULT_OMNI_TRADER }
  private rt: OmniTraderRuntime = { trades: 0, wins: 0, losses: 0, pnlTotal: 0, openCount: 0, lastTradeTs: 0 }
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private unsub: (() => void) | null = null
  private assetCooldownUntil = new Map<string, number>()
  private rejectedUntil = new Map<string, number>()
  /** Same cross-tick fresh-edge discipline Meta Trader uses (analytics/
   * edge.ts) - CRITICAL here specifically, since a sub-second poll loop
   * would otherwise re-fire on the exact same still-true tick-velocity-
   * collapse condition every single cycle until it lapses. */
  private sweepEdge = new SweepEdgeMemory()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.store = ctx.use<Store>('store')
    this.restore()
    this.rebuildOpenCount()
    this.unsub = ctx.bus.on('positionClosed', ({ position }) => this.onPositionClosed(position))
    this.timer = setInterval(() => {
      void this.tick().catch((err) => ctx.log('omni-trader', `tick() rejected, skipping this cycle: ${(err as Error).message}`))
    }, this.clampInterval(this.config.intervalMs))
    ctx.log('omni-trader', `omni trader online (sub-bar live()/tick.* reactivity, ${this.clampInterval(this.config.intervalMs)}ms loop) - ${this.config.enabled ? 'armed' : 'off'}`)
  }

  stop(): void {
    this.unsub?.()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private now(): number {
    return Math.floor(Date.now() / 1000)
  }

  private clampInterval(ms: number): number {
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)))
  }

  private restore(): void {
    try {
      const saved = this.store.getOmniTraderConfig() as Record<string, unknown> | null
      if (!saved) return
      const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb)
      const str = (v: unknown, fb: string) => (typeof v === 'string' && v.length ? v : fb)
      this.config = {
        enabled: typeof saved.enabled === 'boolean' ? saved.enabled : DEFAULT_OMNI_TRADER.enabled,
        metaStrategyId: typeof saved.metaStrategyId === 'string' ? saved.metaStrategyId : undefined,
        tf: str(saved.tf, DEFAULT_OMNI_TRADER.tf) as Timeframe,
        direction: (saved.direction === 'call' || saved.direction === 'put' ? saved.direction : 'both') as 'call' | 'put' | 'both',
        minConfidence: Math.min(100, Math.max(0, num(saved.minConfidence, DEFAULT_OMNI_TRADER.minConfidence))),
        stake: Math.max(0, num(saved.stake, DEFAULT_OMNI_TRADER.stake)),
        maxOpen: Math.max(1, Math.round(num(saved.maxOpen, DEFAULT_OMNI_TRADER.maxOpen))),
        kind: str(saved.kind, DEFAULT_OMNI_TRADER.kind) as TradeKind,
        expiryTf: typeof saved.expiryTf === 'string' ? (saved.expiryTf as Timeframe) : undefined,
        expiryMin: (([1, 2, 3, 4, 5, 15, 30, 45, 60]).includes(Number(saved.expiryMin)) ? Number(saved.expiryMin) : undefined),
        expirySec: typeof saved.expirySec === 'number' ? saved.expirySec : undefined,
        marketScope: (saved.marketScope === 'real' || saved.marketScope === 'otc' ? saved.marketScope : 'all') as 'all' | 'real' | 'otc',
        cooldownSec: Math.max(0, num(saved.cooldownSec, DEFAULT_OMNI_TRADER.cooldownSec)),
        globalCooldownSec: Math.max(0, num(saved.globalCooldownSec, DEFAULT_OMNI_TRADER.globalCooldownSec)),
        scanBatch: Math.min(150, Math.max(6, Math.round(num(saved.scanBatch, MAX_TICK_ASSETS)))),
        correlationGuard: saved.correlationGuard !== false,
        poolMode: saved.poolMode === 'setups' ? 'setups' : 'all',
        setupScanSec: Math.min(600, Math.max(5, Math.round(num(saved.setupScanSec, 30)))),
        setupMinQuality: Math.min(100, Math.max(0, Math.round(num(saved.setupMinQuality, 0)))),
        useScriptExpiry: saved.useScriptExpiry === true,
        intervalMs: this.clampInterval(num(saved.intervalMs, DEFAULT_OMNI_TRADER.intervalMs)),
        assets: Array.isArray(saved.assets) ? saved.assets.filter((a): a is string => typeof a === 'string') : undefined,
      }
    } catch {
      // corrupt/missing config - stay on defaults (disabled, safe)
    }
  }

  private persist(): void {
    this.store.saveOmniTraderConfig({ ...this.config })
  }

  private rebuildOpenCount(): void {
    try {
      this.rt.openCount = this.store.listPositions('open', 500).filter((p) => p.note?.startsWith(OMNI_TRADER_NOTE)).length
    } catch {
      this.rt.openCount = 0
    }
  }

  private hasOpenOn(asset: string): boolean {
    try {
      return this.store.listPositions('open', 500).some((p) => p.note?.startsWith(OMNI_TRADER_NOTE) && p.asset === asset)
    } catch {
      return false
    }
  }

  private onPositionClosed(position: { note?: string; pnl?: number; status: string; asset?: string }): void {
    if (!position.note?.startsWith(OMNI_TRADER_NOTE)) return
    this.rebuildOpenCount()
    this.rt.pnlTotal += position.pnl ?? 0
    if (position.status === 'won') this.rt.wins += 1
    else if (position.status === 'lost') this.rt.losses += 1
  }

  /** Full fresh-start for Omni Trader's own numbers - same BUG FIX and
   * "clear RESULTS, not setup" contract as MetaTraderService.resetAllStats()
   * (see its doc comment for the root cause: ExecutionService's "clear all
   * data" action never called either trader's own reset, only AI Trader's
   * and the OS auto-trader's). Wipes trades/wins/losses/pnlTotal, the
   * per-asset cooldown/rejection-backoff maps, and the sweepEdge freshness
   * memory; config (spec, thresholds, interval) is untouched. */
  resetAllStats(): void {
    this.rt = { trades: 0, wins: 0, losses: 0, pnlTotal: 0, openCount: 0, lastTradeTs: 0 }
    this.assetCooldownUntil.clear()
    this.rejectedUntil.clear()
    this.sweepEdge.rearm()
    this.rebuildOpenCount()
    this.ctx.log('omni-trader', 'stats cleared - starting fresh')
  }

  status(): { enabled: boolean; mode: OsMode; active: boolean; config: OmniTraderConfig; runtime: OmniTraderRuntime } {
    let mode: OsMode = 'human'
    try {
      mode = this.ctx.use<{ status(): { mode: OsMode } }>('mode').status().mode
    } catch {
      /* mode plugin always loaded in practice - fall back to 'human' */
    }
    return { enabled: this.config.enabled, mode, active: this.config.enabled && mode === 'auto', config: this.config, runtime: this.rt }
  }

  configure(patch: Partial<OmniTraderConfig>): OmniTraderConfig {
    const sourceChanged = patch.metaStrategyId !== undefined && patch.metaStrategyId !== this.config.metaStrategyId
    const before = this.config
    this.config = { ...this.config, ...patch }
    this.config.cooldownSec = Math.max(0, Math.round(Number(this.config.cooldownSec) || 0))
    this.config.globalCooldownSec = Math.max(0, Math.round(Number(this.config.globalCooldownSec) || 0))
    this.config.useScriptExpiry = this.config.useScriptExpiry === true
    this.config.expiryMin = (([1, 2, 3, 4, 5, 15, 30, 45, 60]).includes(Number(this.config.expiryMin)) ? Number(this.config.expiryMin) : undefined)
    this.config.scanBatch = Math.min(150, Math.max(6, Math.round(Number(this.config.scanBatch) || MAX_TICK_ASSETS)))
    this.config.correlationGuard = this.config.correlationGuard !== false
    this.config.poolMode = this.config.poolMode === 'setups' ? 'setups' : 'all'
    this.config.setupScanSec = Math.min(600, Math.max(5, Math.round(Number(this.config.setupScanSec) || 30)))
    this.config.setupMinQuality = Math.min(100, Math.max(0, Math.round(Number(this.config.setupMinQuality) || 0)))
    if (patch.poolMode !== undefined || patch.setupMinQuality !== undefined || patch.tf !== undefined) this.setups.invalidate()
    if (patch.intervalMs !== undefined) {
      this.config.intervalMs = this.clampInterval(this.config.intervalMs)
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = setInterval(() => {
          void this.tick().catch((err) => this.ctx.log('omni-trader', `tick() rejected, skipping this cycle: ${(err as Error).message}`))
        }, this.config.intervalMs)
      }
    }
    // Watchlist override: trim/uppercase/dedupe; an empty array (or null) clears back to the default pool. The dialog sends [] for a blank box: a missing key would mean "unchanged".
    let assetsChanged = false
    if (patch.assets !== undefined) {
      const next = Array.isArray(patch.assets) ? [...new Set(patch.assets.map((a) => String(a).trim().toUpperCase()).filter((a) => a.length > 0))] : []
      assetsChanged = JSON.stringify(next) !== JSON.stringify(before.assets ?? [])
      this.config.assets = next.length ? next : undefined
    }
    if (assetsChanged) this.sweepEdge.rearm() // a different watchlist is a different candidate universe
    if (sourceChanged) this.sweepEdge.rearm() // a different spec's qualifiers are a different universe - see SweepEdgeMemory.beginSweep's own doc
    this.persist()
    this.ctx.log('omni-trader', `config updated - ${this.config.enabled ? 'armed' : 'off'} · spec ${this.config.metaStrategyId ?? '(none)'} · ${this.config.tf} · stake $${this.config.stake} · ${this.config.intervalMs}ms loop`)
    return this.config
  }

  // ---------- candidate pool ----------

  /** Every open in-scope asset in a stable order (the explicit watchlist, else liquid majors first). */
  private orderedPool(): string[] {
    const open = this.market.listAssets().filter((a) => a.open && (this.config.marketScope === 'all' || (this.config.marketScope === 'otc') === Boolean(a.otc)))
    const tickers = open.map((a) => a.ticker)
    const configured = this.config.assets?.length ? this.config.assets.filter((a) => tickers.includes(a)) : undefined
    return configured ?? [...LIQUID_CANDIDATES.filter((a) => tickers.includes(a)), ...tickers.filter((a) => !LIQUID_CANDIDATES.includes(a))]
  }

  /** THE "IT KEEPS TRADING THE SAME PAIRS" BUG: this used to be orderedPool().slice(0, 12) every tick, so only the six liquid majors plus the first six listed were EVER looked at and the other ~100
   * open instruments never got a single evaluation. The pool now ROTATES: each tick scans a window of MAX_TICK_ASSETS starting at a cursor that advances after every scan, so over successive ticks
   * every open instrument is evaluated (a watchlist of 12 or fewer is unchanged - the window is the whole list). */
  private candidatePool(): string[] {
    if (this.config.poolMode === 'setups') return this.setupPool()
    // sub-minute script (story.sp/ssp, tick.*, timing.*): scan a small STABLE pair set that the live feed keeps warm, not the rotating universe (see pinnedAssets)
    const pool = this.subMinuteScan() ? this.orderedPool().slice(0, SUB_MINUTE_CAP) : this.orderedPool()
    const window = this.rotation.current(pool, this.scanBatch())
    return window
      .filter((a) => !this.hasOpenOn(a))
      .filter((a) => (this.assetCooldownUntil.get(a) ?? 0) <= this.now())
      .filter((a) => (this.rejectedUntil.get(a) ?? 0) <= this.now())
  }
  /** the TRADING PLAN as the pool: pairs in a favourable setup right now, best first, minus the pair(s) already traded and anything duplicating their exposure. Re-scanned every setupScanSec and right after a trade. */
  private setups = new SetupCache()
  private setupPool(): string[] {
    const inScope = this.orderedPool()
    const rows = this.setups.get(this.now(), this.config.setupScanSec ?? 30, () => scanSetups(
      this.market.listAssets().filter((a) => inScope.includes(a.ticker)),
      (t) => { try { return this.market.getCandlesDeep(t, this.config.tf, 500, true) ?? [] } catch { return [] } },
      { minQuality: this.config.setupMinQuality ?? 0 },
    ))
    let open: Array<{ asset: string; side: string }> = []
    try { open = this.store.listPositions('open', 500).filter((p) => p.note?.startsWith(OMNI_TRADER_NOTE)).map((p) => ({ asset: p.asset, side: p.side })) } catch { open = [] }
    const left = this.config.correlationGuard === false ? rows.filter((r) => !open.some((o) => o.asset === r.asset)) : excludeHeld(rows, open)
    return left.map((r) => r.asset).slice(0, this.scanBatch())
      .filter((a) => !this.hasOpenOn(a))
      .filter((a) => (this.assetCooldownUntil.get(a) ?? 0) <= this.now())
      .filter((a) => (this.rejectedUntil.get(a) ?? 0) <= this.now())
  }
  private rotation = new ScanRotation()
  private scanBatch(): number { return Math.min(150, Math.max(6, Math.round(this.config.scanBatch ?? MAX_TICK_ASSETS))) }
  /** assets looked at since the last (re)arm: a rotated-in asset's FIRST look only baselines a signal that is already standing (it predates us), exactly like the cold sweep does for the first ones */
  private seen = new Set<string>()
  private lastTradedAt = new Map<string, number>()
  private advanceCursor(): void { this.rotation.advance(this.orderedPool(), this.scanBatch()) }
  /** the open position (this trader's own) a candidate would duplicate, if any */
  private correlatedOpen(asset: string, side: string): ReturnType<typeof correlatedWith> {
    if (this.config.correlationGuard === false) return null
    try {
      const open = this.store.listPositions('open', 500).filter((p) => p.note?.startsWith(OMNI_TRADER_NOTE)).map((p) => ({ asset: p.asset, side: p.side }))
      return correlatedWith(asset, side, open)
    } catch { return null }
  }

  // ---------- live data feed ----------

  /** The currently-forming bar, as an MslBarValue `live()` can read -
   * undefined when the market is closed / there's no forming candle yet
   * (closedOnly=false still returns only closed bars in that case). */
  private liveBar(asset: string): MslBarValue | undefined {
    try {
      const candles = this.market.getCandlesDeep(asset, this.config.tf, 2, false)
      if (!candles.length) return undefined
      const last = candles[candles.length - 1]
      const closedOnlyLast = this.market.getCandlesDeep(asset, this.config.tf, 2, true)
      const stillForming = !closedOnlyLast.length || closedOnlyLast[closedOnlyLast.length - 1].time !== last.time
      if (!stillForming) return undefined // last candle is already closed - nothing "forming" right now
      const o = last.open
      const h = last.high
      const l = last.low
      const c = last.close
      if (![o, h, l, c].every(Number.isFinite)) return undefined
      return {
        __mslBar: true,
        o,
        h,
        l,
        c,
        v: Number.isFinite(last.volume) ? last.volume : 0,
        body: Math.abs(c - o),
        range: h - l,
        upperWick: h - Math.max(o, c),
        lowerWick: Math.min(o, c) - l,
      }
    } catch {
      return undefined
    }
  }

  /** THE FROZEN-CANDLE BUG (same fix as Meta Trader / AI Trader / Brain Trader): market-data's live poll only keeps the charted asset, bot / auto-trader watchlists and the pairs those traders name warm.
   * Omni Trader scans the market but was never in that set, so every pair OTHER than a charted/watchlisted one re-read frozen candles, a frozen price and an empty tick buffer - and `timing.hold` (which needs a
   * moving price) could only ever see "went nowhere". Returns the pairs Omni is actually scanning so market-data keeps them live (market-data caps the warm set, charted pair first). */
  private subMinuteScan(): boolean {
    if (!this.config.metaStrategyId) return false
    try { return this.ctx.use<MetaStrategyService>('metaStrategy').needsSubMinute(this.config.metaStrategyId) } catch { return false }
  }

  /** the stable pair set a sub-minute script scans; market-data keeps it live first (right after the charted pair). Empty for every other strategy. */
  pinnedAssets(): string[] {
    if (!this.config.enabled || !this.subMinuteScan()) return []
    try { return this.orderedPool().slice(0, SUB_MINUTE_CAP) } catch { return [] }
  }

  watchedAssets(): string[] {
    if (!this.config.enabled || !this.config.metaStrategyId) return []
    try {
      return this.candidatePool()
    } catch {
      return []
    }
  }

  private liveTicks(asset: string): readonly { ts: number; price: number }[] {
    try {
      return this.ctx.use<{ ticksFor(asset: string): { ts: number; price: number }[] }>('otcFootprint').ticksFor(asset)
    } catch {
      return []
    }
  }

  // ---------- tick ----------

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.omniTick()
    } finally {
      this.ticking = false
    }
  }

  private async omniTick(): Promise<void> {
    if (!this.config.enabled || !this.config.metaStrategyId) return
    let mode: OsMode = 'human'
    try {
      mode = this.ctx.use<{ status(): { mode: OsMode } }>('mode').status().mode
    } catch {
      /* no mode plugin - treat as human (safe default), nothing trades */
    }
    if (mode !== 'auto') return
    if (this.config.globalCooldownSec > 0 && this.rt.lastTradeTs > 0 && this.now() - this.rt.lastTradeTs < this.config.globalCooldownSec) {
      this.rt.lastRejection = `global cooldown: ${this.config.globalCooldownSec - (this.now() - this.rt.lastTradeTs)}s left before the next trade on any pair`
      return
    }
    if (this.rt.openCount >= this.config.maxOpen) {
      this.rt.lastRejection = `max open omni-trader positions (${this.rt.openCount}/${this.config.maxOpen})`
      return
    }

    let metaStrategy: MetaStrategyService
    try {
      metaStrategy = this.ctx.use<MetaStrategyService>('metaStrategy')
    } catch {
      this.rt.lastRejection = 'meta-strategy service unavailable'
      return
    }

    const assets = this.candidatePool()
    if (this.config.poolMode === 'setups' && !assets.length) { const st = this.setups.stats; this.rt.lastRejection = `no pair is in a favourable plan setup right now (${st.scanned} scanned, ${st.withTrend} in a trend, ${st.ready} ready before exclusions) - rescanning every ${this.config.setupScanSec}s`; this.sweepEdge.beginSweep(`omni:${this.config.metaStrategyId}`); return }
    const nowMs = Date.now()
    const evaluated = new Set<string>()
    const qualifying = new Set<string>()
    const rows: OmniCandidate[] = []

    this.sweepEdge.beginSweep(`omni:${this.config.metaStrategyId}`)
    if (this.sweepEdge.armedCold) this.seen.clear()

    for (const asset of assets) {
      const bar = this.liveBar(asset)
      if (!bar) continue // market closed / no forming candle right now - nothing live to feed
      const ticks = this.liveTicks(asset)
      evaluated.add(asset)
      const firstLook = !this.seen.has(asset) // an asset's first evaluation, qualifying or not, is its baseline look
      this.seen.add(asset)
      let result: { result: { direction: 'call' | 'put' | 'none'; confidence: number; notes: string; expiryMin?: number } }
      try {
        result = metaStrategy.evaluateLive(this.config.metaStrategyId, asset, this.config.tf, { bar, ticks, nowMs }, { slot: 'omni' })
      } catch (err) {
        this.ctx.log('omni-trader', `evaluateLive(${asset}) threw: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      const { direction, confidence, notes } = result.result
      if (direction === 'none' || confidence < this.config.minConfidence) continue
      if (this.config.direction !== 'both' && direction !== this.config.direction) continue
      const key = SweepEdgeMemory.key(asset, direction)
      qualifying.add(key)
      if (this.config.poolMode !== 'setups' && firstLook && !this.sweepEdge.armedCold) { this.sweepEdge.backfill(key, this.now()); continue } // first look at a rotated-in asset: a signal already standing predates us
      if (this.sweepEdge.gate(key) !== 'trade') continue // cold sweep or already-held - not a fresh edge
      rows.push({ asset, direction, confidence, note: notes, ...(result.result.expiryMin !== undefined ? { expiryMin: result.result.expiryMin } : {}) })
    }

    this.sweepEdge.endSweep(evaluated, qualifying, this.now())
    this.advanceCursor()

    if (!rows.length) {
      this.rt.lastRejection = evaluated.size ? `no fresh ${this.config.metaStrategyId} live edge right now (${evaluated.size} asset(s) checked)` : 'no asset has a forming candle / live tick feed right now'
      return
    }
    rows.sort((a, b) => b.confidence - a.confidence || (this.lastTradedAt.get(a.asset) ?? 0) - (this.lastTradedAt.get(b.asset) ?? 0)) // ties go to the asset traded longest ago

    let attempts = 0
    for (const row of rows) {
      if (attempts >= MAX_PLACE_ATTEMPTS_PER_TICK) break
      const dup = this.correlatedOpen(row.asset, row.direction)
      if (dup) { this.rt.lastRejection = `${row.direction.toUpperCase()} ${row.asset} duplicates the open ${dup.side.toUpperCase()} ${dup.asset} (${dup.factors.join(', ')}) - skipped to avoid doubling one bet`; this.sweepEdge.backfill(SweepEdgeMemory.key(row.asset, row.direction), this.now()); continue } // held, so it must lapse and re-fire (not enter the stale middle) once the other position closes
      attempts++
      const out = await this.place(row)
      if (out.ok) {
        this.sweepEdge.stamp(SweepEdgeMemory.key(row.asset, row.direction), this.now())
        this.lastTradedAt.set(row.asset, this.now())
        this.setups.invalidate() // a trade was taken: rescan for the next market, without this one
        this.rt.trades += 1
        this.rt.lastTradeTs = this.now()
        this.rt.openCount += 1
        this.rt.lastRejection = undefined
        this.rt.lastAction = `${row.direction.toUpperCase()} ${row.asset} · ${row.note}`
        return
      }
      const reason = out.error ?? 'order rejected'
      this.rt.lastRejection = reason
      if (HARD_STOP_RE.test(reason)) return
      this.rejectedUntil.set(row.asset, this.now() + 30)
    }
  }

  private async place(row: OmniCandidate): Promise<{ ok: boolean; error?: string }> {
    try {
      const exec = this.ctx.use<{
        accountSource: 'paper' | 'iq'
        placeOrder(req: {
          asset: string
          tf: Timeframe
          side: 'call' | 'put'
          kind: TradeKind
          amount: number
          expiryBars: number
          expirySec?: number
          mode: 'paper' | 'live'
          strategy: string
          note: string
        }): Promise<{ ok: boolean; error?: string }>
      }>('execution')
      const kind = this.config.kind
      // useScriptExpiry: the strategy's own `expiry = <minutes>` (whole minutes 1-60) overrides the fixed expiry for this order
      const scriptMin = this.config.useScriptExpiry && row.expiryMin !== undefined ? row.expiryMin : undefined
      const exactMin = (kind === 'binary' || kind === 'turbo') && scriptMin === undefined ? this.config.expiryMin : undefined // exact minutes (3m/4m...) beat the tf bar rounding
      const fixedBars = exactMin !== undefined ? Math.max(1, Math.round((exactMin * 60) / TIMEFRAME_SECONDS[this.config.tf])) : this.config.expiryTf ? Math.max(1, Math.round(TIMEFRAME_SECONDS[this.config.expiryTf] / TIMEFRAME_SECONDS[this.config.tf])) : 1
      const expiryBars = scriptMin !== undefined ? Math.max(1, Math.round((scriptMin * 60) / TIMEFRAME_SECONDS[this.config.tf])) : fixedBars
      const expirySec = exactMin !== undefined ? exactMin * 60 : kind === 'blitz' || kind === 'digital' ? (scriptMin !== undefined ? (kind === 'blitz' ? Math.min(60, scriptMin * 60) : scriptMin * 60) : this.config.expirySec) : undefined
      const out = await exec.placeOrder({
        asset: row.asset,
        tf: this.config.tf,
        side: row.direction,
        kind,
        amount: this.config.stake,
        expiryBars,
        expirySec,
        mode: exec.accountSource === 'iq' ? 'live' : 'paper',
        strategy: `omni:${this.config.metaStrategyId}`,
        note: OMNI_TRADER_NOTE,
      })
      if (out.ok && this.config.cooldownSec > 0) {
        this.assetCooldownUntil.set(row.asset, this.now() + this.config.cooldownSec)
      }
      return out
    } catch {
      return { ok: false, error: 'execution service unavailable' }
    }
  }
}

let omniTraderInstance: OmniTraderService | null = null

export const omniTraderPlugin: Plugin = {
  name: 'omni-trader',
  start: async (ctx) => {
    const svc = new OmniTraderService()
    ctx.provide('omniTrader', svc)
    omniTraderInstance = svc
    await svc.start(ctx)
  },
  stop: async () => {
    omniTraderInstance?.stop()
    omniTraderInstance = null
  },
}
