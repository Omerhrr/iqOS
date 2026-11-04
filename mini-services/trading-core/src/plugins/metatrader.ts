// IQAIR//OS - Meta Trader plugin
//
// Per direct instruction: "it will be like auto trader, but without its
// frictions". The auto-trader (plugins/os-mode.ts) earns its caution the
// hard way - OTC defense gate, a payout floor, a vol-spike gate, pacing,
// per-asset cooldowns, daily profit/loss limits, a memory-gate rule check,
// smart staking/compounding, streak-breaker benching - a decade of "why
// didn't it trade" and "why did it trade THAT" lessons, each bolted on for
// a reason. Meta Trader deliberately skips ALL of that: one flat stake, no
// cooldown beyond "don't open a second position on a pair that already has
// one open", no pacing, no payout/vol/OTC gating, no streak memory. It is
// NOT a replacement for the auto-trader - it is a faster, dumber executor
// for signal sources that don't need that machinery to be trustworthy,
// built on top of reads that are already fused/calibrated/honesty-tracked
// upstream (the Oracle, Accute, a saved meta-strategy spec) or that are
// simple enough that the "now" moment itself is the whole signal (one SMC
// concept firing on this exact candle).
//
// What it will NEVER skip: the kernel's own account-level protections.
// ExecutionService.placeOrder() enforces the kill switch, the base risk
// manager, market-open checks, balance checks - those live one layer below
// every caller (auto-trader, bots, manual /trade, this) and apply no
// matter who is asking. "Without its frictions" means Meta Trader's OWN
// self-imposed caution, never the floor under all of them. It is also still
// gated by the global OS mode (plugins/os-mode.ts) exactly like the
// auto-trader and autopilot bots: flipping to HUMAN stands this down too -
// one switch, no exceptions.
//
// Signal sources (MetaTraderSource below), per direct instruction:
//   - 'meta-strategy' - a saved panel-combinator spec (plugins/
//                       metastrategy.ts), market-wide, same shape the
//                       auto-trader's own 'meta-strategy' source uses.
//   - 'oracle'        - the Next-Candle Oracle's fused read (plugins/
//                       nextcandle.ts predict()) - already honesty-tracked.
//   - 'accute'        - the Accute fused read (plugins/accute.ts signal())
//                       - already a weighted multi-driver fusion.
//   - 'smc'           - the SMC scanner's AGGREGATE "now" read: every
//                       concept that fired on the CURRENT candle (barsAgo
//                       === 0) across all 15 kinds, majority direction -
//                       deliberately NOT the panel's blended summary (which
//                       mixes in older hits too; "taking the now" per
//                       direct instruction means only this instant counts).
//   - 'smc-<kind>'    - each of the 15 SMC concepts (FVG, IFVG, Order
//                       Block, Breaker Block, Liquidity Sweep, BOS, CHoCH,
//                       OTE, KRM, Supply & Demand, Support & Resistance,
//                       Breakout, CRT, Power of 3, Silver Bullet) as its
//                       OWN separate signal source, same "now" (barsAgo
//                       === 0) requirement - per direct instruction to
//                       "build all the smc strats separately and make them
//                       each a signal source".
//
// This is the backend/signal-source layer only ("let's build this out
// first") - no UI panel yet. REST surface mirrors the auto-trader's own
// shape: GET /meta_trader_status, POST /meta_trader_config.

import type { Plugin, KernelContext } from '../kernel'
import type { Store } from '../store'
import type { AssetCategory, Timeframe, TradeKind } from '../types'
import { ALL_TIMEFRAMES, TIMEFRAME_SECONDS } from '../types'
import type { MarketDataService } from './market-data'
import type { NextCandleService } from './nextcandle'
import type { AccuteService } from './accute'
import type { MetaStrategyService } from './metastrategy'
import type { SmcScanService } from './smcscan'
import type { SmcKind, SmcScanResult } from '../analytics/smc'
import type { OsMode } from './os-mode'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const finGte = (v: number, floor: number): boolean => Number.isFinite(v) && v >= floor

/** Same liquid-first candidate ordering the auto-trader's pickers use
 * (os-mode.ts's own LIQUID_CANDIDATES) - duplicated rather than imported,
 * same dependency-isolation reasoning every small constant copy in this
 * codebase uses (see e.g. analytics/momentumscore.ts's module header). */
const LIQUID_CANDIDATES = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD', 'BTCUSD']
/** Bound on how many candidates one tick evaluates - a universe spike
 * shouldn't turn one 10s tick into a multi-second stall. */
const MAX_TICK_CANDIDATES = 50
/** Up to this many ranked candidates get a REAL placeOrder attempt per
 * tick before giving up - a transient broker rejection on the top pick
 * shouldn't waste the whole cycle when the next-best candidate would have
 * placed fine. */
const MAX_PLACE_ATTEMPTS_PER_TICK = 5
/** Same hard-stop contract the auto-trader's HARD_STOP_RE uses: these
 * rejection reasons are account/risk-level, not "try a different pair" -
 * retrying another candidate would just hit the identical wall. */
const HARD_STOP_RE =
  /kill switch engaged|market closed for|amount must be positive|exceeds max stake|insufficient balance|live balance unknown|live broker not connected|unknown asset |no price feed|execution service unavailable/i

/** AUDIT FIX - same bug os-mode.ts's own BROKER_UNAVAILABLE_RE/
 * assetRejectedUntil was built to fix for the auto-trader, ported here
 * because Meta Trader never had an equivalent: a broker rejection like
 * "order rejected: Cannot purchase an option (the asset is not available
 * at the moment)" does NOT match HARD_STOP_RE, so the tick loop above just
 * tries the next-ranked candidate THIS tick and moves on - but nothing
 * persisted that rejection anywhere. If the rejected asset is still the
 * top-ranked candidate (e.g. tied at 100% confidence, as a "now" SMC read
 * commonly is), the VERY NEXT tick (10s later) picks the exact same
 * already-known-untradable asset again, gets the exact same rejection
 * again, forever - which is exactly what "standing down: order rejected:
 * Cannot purchase an option..." repeating on the same pair every tick is.
 * This is almost always our own open/closed cache lagging IQ's real
 * schedule (OTC closures, mid-session suspensions, a stale active_id), not
 * a misconfiguration - so the fix is the same as os-mode.ts's: take the
 * asset off the table for a while (not forever) rather than retrying it
 * every single tick. */
const BROKER_UNAVAILABLE_RE =
  /not available at the moment|is not a (?:turbo\/binary\/digital|digital\/turbo\/binary) instrument|active\b[^.]*not found|is suspended|active is suspended|suspended\b/i
const BROKER_UNAVAILABLE_COOLDOWN_SEC = 600

const SMC_KIND_SOURCE: Record<SmcKind, string> = {
  FVG: 'smc-fvg',
  IFVG: 'smc-ifvg',
  ORDER_BLOCK: 'smc-order-block',
  BREAKER_BLOCK: 'smc-breaker-block',
  LIQUIDITY_SWEEP: 'smc-liquidity-sweep',
  BOS: 'smc-bos',
  CHOCH: 'smc-choch',
  OTE: 'smc-ote',
  KRM: 'smc-krm',
  SUPPLY_DEMAND: 'smc-supply-demand',
  SUPPORT_RESISTANCE: 'smc-support-resistance',
  BREAKOUT: 'smc-breakout',
  CRT: 'smc-crt',
  POWER_OF_3: 'smc-power-of-3',
  SILVER_BULLET: 'smc-silver-bullet',
}
/** Reverse lookup: signalSource string -> the one SmcKind it trades. */
const SOURCE_SMC_KIND: Record<string, SmcKind> = Object.fromEntries(
  Object.entries(SMC_KIND_SOURCE).map(([k, v]) => [v, k as SmcKind]),
) as Record<string, SmcKind>

export type MetaTraderSource =
  | 'meta-strategy'
  | 'oracle'
  | 'accute'
  | 'smc'
  | 'smc-fvg'
  | 'smc-ifvg'
  | 'smc-order-block'
  | 'smc-breaker-block'
  | 'smc-liquidity-sweep'
  | 'smc-bos'
  | 'smc-choch'
  | 'smc-ote'
  | 'smc-krm'
  | 'smc-supply-demand'
  | 'smc-support-resistance'
  | 'smc-breakout'
  | 'smc-crt'
  | 'smc-power-of-3'
  | 'smc-silver-bullet'

export const META_TRADER_SOURCES: readonly MetaTraderSource[] = [
  'meta-strategy',
  'oracle',
  'accute',
  'smc',
  ...(Object.values(SMC_KIND_SOURCE) as MetaTraderSource[]),
]

/** Deliberately simpler than the auto-trader's full StakePlan (client.ts) -
 * no periods/derisk/reseed-limit machinery, just the core compounding loop:
 * win folds a share of the payout into the pot, loss burns the stake back
 * out (and, by default, halts the cycle until restart() - same "a loss
 * ends the compound run" convention the auto-trader uses). */
export interface MetaStakePlan {
  kind: 'compound'
  base: number
  /** % of the WON amount folded into the pot each win. Default 100. */
  rollPct?: number
  /** caps the fold to this % of the stake risked, even at a higher real
   * payout. Default 70. */
  payoutCap?: number
  /** false = keep rolling through a loss (burn the pot, don't halt).
   * Default true. */
  stopOnLoss?: boolean
}

export interface MetaTraderConfig {
  enabled: boolean
  signalSource: MetaTraderSource
  /** only meaningful when signalSource === 'meta-strategy' - which saved
   * combinator spec (plugins/metastrategy.ts) to trade. */
  metaStrategyId?: string
  tf: Timeframe
  direction: 'call' | 'put' | 'both'
  /** 0-100 - the one quality gate this engine always keeps (deliberately:
   * "no frictions" means no SELF-IMPOSED pacing/payout/vol gating by
   * default, not "trade literally anything"). */
  minConfidence: number
  stake: number
  /** max concurrently open meta-trader positions, across all assets. */
  maxOpen: number
  kind: TradeKind
  /** The trade's own expiry, as a timeframe - SEPARATE from `tf` (the
   * timeframe signals are read from). Undefined = track `tf` 1:1 (exactly
   * 1 bar), same convention as the auto-trader's own expiryTf. Only
   * meaningful for binary/turbo - blitz/digital settle on expirySec
   * instead. Converted to whole bars-of-`tf` at placement time. */
  expiryTf?: Timeframe
  /** Explicit wall-clock expiry in seconds - only read for kind 'blitz'
   * (1-60s) or 'digital' (60-86400s). Undefined = kind default (15s
   * blitz, 300s digital), same convention as the auto-trader's own. */
  expirySec?: number
  marketScope: 'all' | 'real' | 'otc'
  /** per-asset re-entry cooldown in seconds - 0 (default) = off. Added per
   * direct instruction; UNLIKE the auto-trader's cooldownSec, there is no
   * hard floor here - 0 really does mean no cooldown at all. */
  cooldownSec: number
  /** optional compounding plan - undefined (default) = fixed `stake` every trade. */
  stakePlan?: MetaStakePlan
}

export interface MetaTraderRuntime {
  trades: number
  wins: number
  losses: number
  pnlTotal: number
  openCount: number
  lastTradeTs: number
  lastAction?: string
  lastRejection?: string
  /** compounding state - only meaningful when config.stakePlan is set. */
  pot: number
  rollN: number
  halted: boolean
}

interface MetaTraderRow {
  asset: string
  name: string
  category: AssetCategory
  otc: boolean
  price: number
  direction: 'call' | 'put'
  confidence: number
  note: string
}

const DEFAULT_META_TRADER: MetaTraderConfig = {
  enabled: false,
  signalSource: 'meta-strategy',
  tf: '1m',
  direction: 'both',
  minConfidence: 60,
  stake: 1,
  maxOpen: 3,
  kind: 'binary',
  marketScope: 'all',
  cooldownSec: 0,
}

/** The fixed note prefix every Meta Trader position is tagged with -
 * exactly the same "note starts with X" identity contract the auto-trader
 * uses ('auto:os-trader'), so open-position counting/closing never
 * confuses the two engines' positions with each other. */
const META_TRADER_NOTE = 'meta:trader'

/** barsAgo===0 read of an SmcScanResult, optionally restricted to one kind.
 * Per direct instruction, this now matches SmcRecentPanel's own stance:
 * "any signal that one can fires should be fired here also" - any concept
 * that hits THIS candle is eligible to produce a read, with NO majority-
 * vote veto. There used to be a "split evenly - no lean" case that stood
 * aside entirely on an exact bullish/bearish tie; that's gone - a tie now
 * goes with whichever concept fired first in the scan's own signal order
 * (SmcScanResult.signals is itself ordered, so this is deterministic, not
 * arbitrary) rather than refusing to read at all.
 *
 * Confidence is still derived from how many "now" signals agree with the
 * winning side (including itself) out of every "now" signal across all
 * kinds - an honest, explainable number rather than a flat guess, and it
 * naturally rewards a kind firing ALONGSIDE other agreeing structure over
 * one firing in isolation. A lone signal with nothing else to agree or
 * disagree with gets a flat 65 (clearly labeled in the note); a tied split
 * necessarily lands at 50 (half the now-signals agree with whichever side
 * won the tie-break) - the minConfidence floor is what filters that out if
 * you don't want to act on ties.
 *
 * The AGGREGATE 'smc' source (onlyKind undefined) excludes Support &
 * Resistance entirely, per direct instruction - its touch-cluster read
 * fires far more often than the other 14 concepts and would drown out
 * everything else in a "now" read, same reasoning SmcRecentPanel's own
 * EXCLUDED_KINDS already applies on its "now"/"1 bar ago" view. The
 * dedicated 'smc-support-resistance' source (onlyKind === 'SUPPORT_RESISTANCE')
 * still trades it on its own - this exclusion only affects the aggregate. */
function smcNowRead(result: SmcScanResult, onlyKind?: SmcKind): { direction: 'call' | 'put' | 'none'; confidence: number; note: string } {
  const allNow = result.signals.filter((s) => s.barsAgo === 0)
  const now = onlyKind ? allNow : allNow.filter((s) => s.kind !== 'SUPPORT_RESISTANCE')
  const pool = onlyKind ? now.filter((s) => s.kind === onlyKind) : now
  if (pool.length === 0) return { direction: 'none', confidence: 0, note: 'nothing hit this candle' }
  const bullish = pool.filter((s) => s.direction === 'bullish').length
  const bearish = pool.filter((s) => s.direction === 'bearish').length
  const tied = bullish === bearish
  // no-vote-required: any now-signal fires. A tie breaks on whichever
  // concept hit first in the scan's own order, rather than standing aside.
  const direction: 'call' | 'put' = tied ? (pool[0].direction === 'bullish' ? 'call' : 'put') : bullish > bearish ? 'call' : 'put'
  const winners = Math.max(bullish, bearish)
  const totalNow = now.length // agreement measured against EVERY kind firing now, not just onlyKind's own pool
  const confidence = totalNow <= 1 ? 65 : Math.round((winners / totalNow) * 100)
  const kindNote = onlyKind ? `${onlyKind} now (${pool.length}x)` : `${pool.length} concept(s) now`
  const tieNote = tied && totalNow > 1 ? ` (tied - went with ${pool[0].kind}'s first fire)` : ''
  return { direction, confidence, note: `${kindNote} - ${winners}/${totalNow} now-signals agree ${direction}${tieNote}` }
}

export class MetaTraderService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private store!: Store
  private config: MetaTraderConfig = { ...DEFAULT_META_TRADER }
  private rt: MetaTraderRuntime = { trades: 0, wins: 0, losses: 0, pnlTotal: 0, openCount: 0, lastTradeTs: 0, pot: 0, rollN: 0, halted: false }
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private unsub: (() => void) | null = null
  /** per-asset re-entry cooldown (config.cooldownSec) - epoch seconds until
   * each asset is tradeable again. Cleared lazily (checked, not swept). */
  private assetCooldownUntil = new Map<string, number>()
  /** Last successful placement time per asset, used ONLY to break ties
   * between equally-confident candidates (see rankRows()) - tracked
   * regardless of cooldownSec, since with cooldownSec at its default of 0
   * there is nothing else stopping the same top-ranked pair being re-hit
   * the instant its last position closes. */
  private lastTradedAt = new Map<string, number>()
  /** Broker-rejected-this-asset-specifically backoff (BROKER_UNAVAILABLE_RE
   * et al.) - epoch seconds until the asset is worth trying again. Separate
   * from assetCooldownUntil (that one is the user-tunable post-TRADE
   * cooldown, no floor by design) - this one exists regardless of
   * cooldownSec, because a rejected order was never a trade to begin with. */
  private rejectedUntil = new Map<string, number>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.store = ctx.use<Store>('store')
    this.restore()
    this.rebuildOpenCount()
    this.unsub = ctx.bus.on('positionClosed', ({ position }) => this.onPositionClosed(position))
    this.timer = setInterval(() => {
      void this.tick().catch((err) => ctx.log('meta-trader', `tick() rejected, skipping this cycle: ${(err as Error).message}`))
    }, 10_000)
    ctx.log('meta-trader', `meta trader online (sources: meta-strategy/oracle/accute/smc + 15 individual SMC concepts) - ${this.config.enabled ? 'armed' : 'off'} · src ${this.config.signalSource}`)
  }

  stop(): void {
    this.unsub?.()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private now(): number {
    return Math.floor(Date.now() / 1000)
  }

  private restore(): void {
    try {
      const saved = this.store.getMetaTraderConfig() as Record<string, unknown> | null
      if (!saved) return
      const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb)
      this.config = {
        enabled: typeof saved.enabled === 'boolean' ? saved.enabled : DEFAULT_META_TRADER.enabled,
        signalSource: (META_TRADER_SOURCES as readonly string[]).includes(saved.signalSource as string)
          ? (saved.signalSource as MetaTraderSource)
          : DEFAULT_META_TRADER.signalSource,
        metaStrategyId: typeof saved.metaStrategyId === 'string' && saved.metaStrategyId.trim() ? saved.metaStrategyId.trim() : undefined,
        tf: (typeof saved.tf === 'string' && (ALL_TIMEFRAMES as string[]).includes(saved.tf) ? saved.tf : DEFAULT_META_TRADER.tf) as Timeframe,
        direction: saved.direction === 'call' || saved.direction === 'put' ? saved.direction : 'both',
        minConfidence: clamp(num(saved.minConfidence, DEFAULT_META_TRADER.minConfidence), 0, 100),
        stake: clamp(num(saved.stake, DEFAULT_META_TRADER.stake), 1, 5000),
        maxOpen: clamp(Math.round(num(saved.maxOpen, DEFAULT_META_TRADER.maxOpen)), 1, 20),
        kind: (['binary', 'turbo', 'blitz', 'digital', 'cfd'] as const).includes(saved.kind as TradeKind) ? (saved.kind as TradeKind) : 'binary',
        expiryTf: typeof saved.expiryTf === 'string' && (ALL_TIMEFRAMES as string[]).includes(saved.expiryTf) ? (saved.expiryTf as Timeframe) : undefined,
        expirySec: typeof saved.expirySec === 'number' && Number.isFinite(saved.expirySec) ? saved.expirySec : undefined,
        marketScope: saved.marketScope === 'real' || saved.marketScope === 'otc' ? saved.marketScope : 'all',
        cooldownSec: Math.max(0, Math.round(num(saved.cooldownSec, DEFAULT_META_TRADER.cooldownSec))),
        stakePlan: MetaTraderService.sanitizeStakePlan(saved.stakePlan),
      }
      const rt = saved.rt as Record<string, unknown> | undefined
      if (rt && typeof rt === 'object') {
        this.rt.pot = Math.max(0, num(rt.pot, 0))
        this.rt.rollN = Math.max(0, Math.round(num(rt.rollN, 0)))
        this.rt.halted = Boolean(rt.halted)
      }
    } catch {
      /* corrupt/missing config - start clean */
    }
  }

  private static sanitizeStakePlan(v: unknown): MetaStakePlan | undefined {
    if (!v || typeof v !== 'object') return undefined
    const o = v as Record<string, unknown>
    if (o.kind !== 'compound') return undefined
    const num = (x: unknown, fb: number) => (typeof x === 'number' && Number.isFinite(x) ? x : fb)
    return {
      kind: 'compound',
      base: clamp(num(o.base, 1), 1, 5000),
      rollPct: o.rollPct !== undefined ? clamp(num(o.rollPct, 100), 1, 100) : undefined,
      payoutCap: o.payoutCap !== undefined ? clamp(num(o.payoutCap, 70), 1, 100) : undefined,
      stopOnLoss: typeof o.stopOnLoss === 'boolean' ? o.stopOnLoss : undefined,
    }
  }

  private persist(): void {
    this.store.saveMetaTraderConfig({ ...this.config, rt: { pot: this.rt.pot, rollN: this.rt.rollN, halted: this.rt.halted } })
  }

  private rebuildOpenCount(): void {
    try {
      this.rt.openCount = this.store.listPositions('open', 500).filter((p) => p.note?.startsWith(META_TRADER_NOTE)).length
    } catch {
      this.rt.openCount = 0
    }
  }

  private hasOpenOn(asset: string): boolean {
    try {
      return this.store.listPositions('open', 500).some((p) => p.note?.startsWith(META_TRADER_NOTE) && p.asset === asset)
    } catch {
      return false
    }
  }

  private onPositionClosed(position: { note?: string; pnl?: number; status: string; asset?: string; amount?: number }): void {
    if (!position.note?.startsWith(META_TRADER_NOTE)) return
    this.rebuildOpenCount()
    const pnl = position.pnl ?? 0
    this.rt.pnlTotal += pnl
    if (position.status === 'won') this.rt.wins += 1
    else if (position.status === 'lost') this.rt.losses += 1

    // compounding roll - same fold-in/burn shape the auto-trader uses
    // (os-mode.ts's onPositionClosed), simplified: no periods/derisk/
    // reseed-limit machinery, just "win folds a share in, loss burns the
    // stake back out and (by default) halts the cycle until restart()".
    const plan = this.config.stakePlan
    if (plan && (position.status === 'won' || position.status === 'lost')) {
      const base = plan.base
      const working = this.rt.pot >= 0.01 ? this.rt.pot : base
      const amount = position.amount ?? base
      if (position.status === 'won') {
        const rollPct = plan.rollPct ?? 100
        const cap = (plan.payoutCap ?? 70) / 100
        const fold = Math.min(pnl, amount * cap) * (rollPct / 100)
        this.rt.pot = Math.round((working + fold) * 100) / 100
        this.rt.rollN += 1
      } else {
        this.rt.pot = Math.round(Math.max(0, working - amount) * 100) / 100
        this.rt.rollN = 0
        if (plan.stopOnLoss !== false) this.rt.halted = true
      }
      this.persist()
    }
  }

  /** Clears a halted compounding cycle and re-seeds the pot at base - same
   * "restart to trade again" contract the auto-trader's compounding uses. */
  restart(): { ok: boolean; error?: string } {
    if (!this.config.stakePlan) return { ok: false, error: 'restart applies to a compounding meta-trader plan only' }
    this.rt.pot = 0
    this.rt.rollN = 0
    this.rt.halted = false
    this.persist()
    this.ctx.log('meta-trader', `compound cycle restarted - next trade seeds $${this.config.stakePlan.base}`)
    return { ok: true }
  }

  status(): { enabled: boolean; mode: OsMode; active: boolean; config: MetaTraderConfig; runtime: MetaTraderRuntime; sources: readonly MetaTraderSource[] } {
    let mode: OsMode = 'human'
    try {
      mode = this.ctx.use<{ status(): { mode: OsMode } }>('mode').status().mode
    } catch {
      /* mode plugin always loaded in practice - fall back to 'human' (safe default) if not */
    }
    return {
      enabled: this.config.enabled,
      mode,
      active: this.config.enabled && mode === 'auto',
      config: this.config,
      runtime: this.rt,
      sources: META_TRADER_SOURCES,
    }
  }

  configure(patch: Partial<MetaTraderConfig>): MetaTraderConfig {
    const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb)
    if (patch.enabled !== undefined) this.config.enabled = Boolean(patch.enabled)
    if (patch.signalSource !== undefined && (META_TRADER_SOURCES as readonly string[]).includes(patch.signalSource))
      this.config.signalSource = patch.signalSource
    if (patch.metaStrategyId !== undefined) this.config.metaStrategyId = String(patch.metaStrategyId).trim() || undefined
    if (patch.tf !== undefined && (ALL_TIMEFRAMES as string[]).includes(patch.tf)) this.config.tf = patch.tf
    if (patch.direction !== undefined && (patch.direction === 'call' || patch.direction === 'put' || patch.direction === 'both'))
      this.config.direction = patch.direction
    if (patch.minConfidence !== undefined) this.config.minConfidence = clamp(num(patch.minConfidence, this.config.minConfidence), 0, 100)
    if (patch.stake !== undefined) this.config.stake = clamp(num(patch.stake, this.config.stake), 1, 5000)
    if (patch.maxOpen !== undefined) this.config.maxOpen = clamp(Math.round(num(patch.maxOpen, this.config.maxOpen)), 1, 20)
    if (patch.kind !== undefined && (['binary', 'turbo', 'blitz', 'digital', 'cfd'] as const).includes(patch.kind)) this.config.kind = patch.kind
    // null/empty clears back to "track tf 1:1" - same convention the
    // auto-trader's own expiryTf patch uses (a bare undefined is dropped by
    // JSON.stringify, so null is the only way to clear it from the client).
    if (patch.expiryTf !== undefined)
      this.config.expiryTf = typeof patch.expiryTf === 'string' && (ALL_TIMEFRAMES as string[]).includes(patch.expiryTf) ? patch.expiryTf : undefined
    if (patch.expirySec !== undefined) {
      const bounds: [number, number] = this.config.kind === 'blitz' ? [1, 60] : [60, 86400]
      this.config.expirySec =
        patch.expirySec === null
          ? undefined
          : Math.round(clamp(num(patch.expirySec, this.config.expirySec ?? (this.config.kind === 'blitz' ? 15 : 300)), bounds[0], bounds[1]))
    }
    if (patch.marketScope !== undefined && (patch.marketScope === 'all' || patch.marketScope === 'real' || patch.marketScope === 'otc'))
      this.config.marketScope = patch.marketScope
    if (patch.cooldownSec !== undefined) this.config.cooldownSec = Math.max(0, Math.round(num(patch.cooldownSec, this.config.cooldownSec)))
    if (patch.stakePlan !== undefined) {
      const next = MetaTraderService.sanitizeStakePlan(patch.stakePlan)
      const changed = JSON.stringify(this.config.stakePlan ?? null) !== JSON.stringify(next ?? null)
      this.config.stakePlan = next
      // switching the plan itself (not just tuning a field on the same
      // plan) starts a fresh roll - an old pot/halt from a different
      // config would be meaningless carried into a newly (re)enabled plan.
      if (changed) {
        this.rt.pot = 0
        this.rt.rollN = 0
        this.rt.halted = false
      }
    }
    this.persist()
    this.ctx.log('meta-trader', `config updated - ${this.config.enabled ? 'armed' : 'off'} · src ${this.config.signalSource} · ${this.config.tf} · stake $${this.config.stake} · maxOpen ${this.config.maxOpen}`)
    return this.config
  }

  // ---------- candidate pool ----------

  private candidatePool(): string[] {
    const open = this.market.listAssets().filter((a) => a.open && (this.config.marketScope === 'all' || (this.config.marketScope === 'otc') === Boolean(a.otc)))
    const tickers = open.map((a) => a.ticker)
    const ordered = [...LIQUID_CANDIDATES.filter((a) => tickers.includes(a)), ...tickers.filter((a) => !LIQUID_CANDIDATES.includes(a))]
    return ordered
      .slice(0, MAX_TICK_CANDIDATES)
      .filter((a) => !this.hasOpenOn(a))
      .filter((a) => (this.assetCooldownUntil.get(a) ?? 0) <= this.now())
      .filter((a) => (this.rejectedUntil.get(a) ?? 0) <= this.now())
  }

  private assetInfo(ticker: string) {
    return this.market.listAssets().find((a) => a.ticker === ticker)
  }

  // ---------- tick ----------

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.metaTraderTick()
    } finally {
      this.ticking = false
    }
  }

  private async metaTraderTick(): Promise<void> {
    if (!this.config.enabled) return
    let mode: OsMode = 'human'
    try {
      mode = this.ctx.use<{ status(): { mode: OsMode } }>('mode').status().mode
    } catch {
      /* no mode plugin - treat as human (safe default), nothing trades */
    }
    if (mode !== 'auto') return
    if (this.config.stakePlan && this.rt.halted) {
      this.rt.lastRejection = 'compound cycle halted on a loss - restart to trade again'
      return
    }
    if (this.rt.openCount >= this.config.maxOpen) {
      this.rt.lastRejection = `max open meta-trader positions (${this.rt.openCount}/${this.config.maxOpen})`
      return
    }

    const candidates = this.pickCandidates()
    if (!candidates.length) {
      this.rt.lastRejection = `no ${this.config.signalSource} signal meets the ${this.config.minConfidence}% confidence floor right now`
      return
    }

    let refreshedAssetsThisTick = false
    for (let i = 0; i < Math.min(MAX_PLACE_ATTEMPTS_PER_TICK, candidates.length); i++) {
      const row = candidates[i]
      const out = await this.place(row)
      if (out.ok) {
        this.rt.trades += 1
        this.rt.lastTradeTs = this.now()
        this.rt.openCount += 1
        this.rt.lastRejection = undefined
        this.rt.lastAction = `${row.direction.toUpperCase()} ${row.asset} · ${row.note}`
        return
      }
      const reason = out.error ?? 'order rejected'
      this.rt.lastRejection = reason
      if (HARD_STOP_RE.test(reason)) return // account/risk-level - no point trying the next candidate
      // Per-asset broker rejection (closed/suspended/stale active_id, etc.) -
      // take THIS asset off the table for a while so the next tick doesn't
      // just re-pick it and repeat the identical rejection forever (see
      // BROKER_UNAVAILABLE_RE's doc comment above). Still try the next-
      // ranked candidate right now, within this same tick.
      this.rejectedUntil.set(row.asset, this.now() + BROKER_UNAVAILABLE_COOLDOWN_SEC)
      if (BROKER_UNAVAILABLE_RE.test(reason) && !refreshedAssetsThisTick) {
        refreshedAssetsThisTick = true
        try {
          this.ctx.use<{ forceRefreshSidecarAssets: () => void }>('market').forceRefreshSidecarAssets()
        } catch {
          // market plugin not loaded - cache catches up on its own next cycle
        }
      }
    }
  }

  /** Every qualifying candidate for the configured source, best-confidence
   * first - the tick loop works down this list on a placement rejection. */
  private pickCandidates(): MetaTraderRow[] {
    const src = this.config.signalSource
    if (src === 'meta-strategy') return this.pickMetaStrategy()
    if (src === 'oracle') return this.pickOracle()
    if (src === 'accute') return this.pickAccute()
    if (src === 'smc') return this.pickSmc(undefined)
    const kind = SOURCE_SMC_KIND[src]
    if (kind) return this.pickSmc(kind)
    return []
  }

  /** Confidence-desc, ties broken by least-recently-traded. Root cause of
   * "it keeps trading the same pair": candidatePool() always lists assets
   * in the same fixed LIQUID_CANDIDATES order, and a plain confidence sort
   * is STABLE - so whenever two+ assets tie on confidence (common: SMC's
   * "now" confidence is a coarse winners/totalNow ratio or a flat 65,
   * Accute/Oracle often round to the same whole number too), the earliest
   * one in that fixed order wins every single time. With cooldownSec at
   * its default of 0, nothing else stops that same pair being re-picked
   * the instant its last position closes - so it looks like Meta Trader
   * is stuck on one asset forever. This tie-break never overrides a real
   * confidence edge - it only decides between genuinely equal reads, and
   * favors whichever qualifying asset hasn't traded in the longest time
   * (or never has), rotating fairly across ties instead of always picking
   * the same one. */
  private rankRows(rows: MetaTraderRow[]): MetaTraderRow[] {
    return rows.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      const at = this.lastTradedAt.get(a.asset) ?? 0
      const bt = this.lastTradedAt.get(b.asset) ?? 0
      return at - bt
    })
  }

  /** Recency-only ranking - used for every SMC source instead of rankRows().
   * Per direct instruction: SMC "now"'s confidence is just how many
   * concepts firing on THIS candle happen to agree with each other - it has
   * never been honesty-tracked/resolved against real outcomes the way
   * Oracle's and Accute's confidence have been (smcscan.ts's outcome
   * tracker records the panel's blended-all-ages summary, not this now-
   * only number), so ranking qualifying SMC candidates BY it was ranking by
   * a number with no demonstrated predictive value. Any asset with a
   * direction here already passed the "did at least one concept fire now"
   * bar (see pickSmc's dropped minConfidence check) - ranking is purely
   * about which of several equally-eligible assets to act on first, so
   * least-recently-traded (or never-traded) wins, same tie-break rankRows()
   * uses, just without confidence deciding anything first. */
  private rankByRecency(rows: MetaTraderRow[]): MetaTraderRow[] {
    return rows.sort((a, b) => {
      const at = this.lastTradedAt.get(a.asset) ?? 0
      const bt = this.lastTradedAt.get(b.asset) ?? 0
      return at - bt
    })
  }

  private rowFrom(asset: string, direction: 'call' | 'put', confidence: number, price: number, note: string): MetaTraderRow | null {
    const inst = this.assetInfo(asset)
    if (!inst || !(price > 0)) return null
    return {
      asset,
      name: inst.name ?? asset,
      category: inst.category,
      otc: Boolean(inst.otc),
      price,
      direction,
      confidence,
      note,
    }
  }

  private pickMetaStrategy(): MetaTraderRow[] {
    const id = this.config.metaStrategyId
    if (!id) return []
    let meta: MetaStrategyService
    try {
      meta = this.ctx.use<MetaStrategyService>('metaStrategy')
    } catch {
      return []
    }
    if (!meta.isValidStrategyId(id)) return []
    const out: MetaTraderRow[] = []
    for (const asset of this.candidatePool()) {
      try {
        const { result, price } = meta.evaluate(id, asset, this.config.tf)
        if (result.direction === 'none' || !(price > 0)) continue
        if (this.config.direction !== 'both' && result.direction !== this.config.direction) continue
        if (!finGte(result.confidence, this.config.minConfidence)) continue
        const row = this.rowFrom(asset, result.direction, result.confidence, price, `meta-strategy "${id}": ${result.notes}`)
        if (row) out.push(row)
      } catch {
        /* thin history for this pair - try the next */
      }
    }
    return this.rankRows(out)
  }

  private pickOracle(): MetaTraderRow[] {
    let oracle: NextCandleService
    try {
      oracle = this.ctx.use<NextCandleService>('nextcandle')
    } catch {
      return []
    }
    const out: MetaTraderRow[] = []
    for (const asset of this.candidatePool()) {
      try {
        const pred = oracle.predict(asset, this.config.tf)
        if (!pred || pred.direction === 'none') continue
        if (this.config.direction !== 'both' && pred.direction !== this.config.direction) continue
        if (!finGte(pred.confidence, this.config.minConfidence)) continue
        const row = this.rowFrom(
          asset,
          pred.direction,
          pred.confidence,
          pred.price,
          `oracle: pUp ${(pred.pUp * 100).toFixed(0)}% · ${pred.driversActive} models · regime ${pred.regime}`,
        )
        if (row) out.push(row)
      } catch {
        /* thin history - try the next */
      }
    }
    return this.rankRows(out)
  }

  private pickAccute(): MetaTraderRow[] {
    let accute: AccuteService
    try {
      accute = this.ctx.use<AccuteService>('accute')
    } catch {
      return []
    }
    const out: MetaTraderRow[] = []
    for (const asset of this.candidatePool()) {
      try {
        const sig = accute.signal(asset, this.config.tf)
        if (!sig.ok || sig.direction === 'none') continue
        if (this.config.direction !== 'both' && sig.direction !== this.config.direction) continue
        if (!finGte(sig.confidence, this.config.minConfidence)) continue
        const row = this.rowFrom(asset, sig.direction, sig.confidence, sig.price, `accute: ${sig.summary}`)
        if (row) out.push(row)
      } catch {
        /* thin history - try the next */
      }
    }
    return this.rankRows(out)
  }

  private pickSmc(onlyKind: SmcKind | undefined): MetaTraderRow[] {
    let smc: SmcScanService
    try {
      smc = this.ctx.use<SmcScanService>('smcScan')
    } catch {
      return []
    }
    // minConfidence is deliberately NOT applied to SMC sources - per direct
    // instruction, its "now" confidence is only a same-candle agreement
    // count with no honesty-loop/resolved-outcome backing (see
    // rankByRecency's doc comment), so gating on it would be filtering on a
    // number that's never been shown to mean anything. Any concept firing
    // now, alone or alongside others, qualifies - exactly the "any signal
    // that can fire should fire here" behavior smcNowRead() itself already
    // implements for direction; this just stops minConfidence from vetoing
    // it a second time on the way out.
    const out: MetaTraderRow[] = []
    for (const asset of this.candidatePool()) {
      try {
        const res = smc.scan(asset, this.config.tf)
        if (!res.result) continue
        const read = smcNowRead(res.result, onlyKind)
        if (read.direction === 'none') continue
        if (this.config.direction !== 'both' && read.direction !== this.config.direction) continue
        const row = this.rowFrom(asset, read.direction, read.confidence, res.result.price, `smc: ${read.note}`)
        if (row) out.push(row)
      } catch {
        /* thin history - try the next */
      }
    }
    return this.rankByRecency(out)
  }

  // ---------- placement ----------

  /** Stake-plan-aware sizing: mirrors the auto-trader's pot-based compounding -
   * fold the running pot (or seed with `base` if the pot hasn't started yet)
   * by rollPct, clamp to the configured payout cap's implied stake, round to
   * cents. Falls back to the flat configured stake with no plan. */
  private stakeForMeta(): number {
    const plan = this.config.stakePlan
    if (!plan) return this.config.stake
    const working = this.rt.pot >= 0.01 ? this.rt.pot : plan.base
    const rollPct = plan.rollPct ?? 100
    const raw = (working * rollPct) / 100
    return Math.max(1, Math.round(raw * 100) / 100)
  }

  private async place(row: MetaTraderRow): Promise<{ ok: boolean; error?: string }> {
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
      const out = await exec.placeOrder({
        asset: row.asset,
        tf: this.config.tf,
        side: row.direction,
        kind,
        amount: this.stakeForMeta(),
        // expiryTf unset = track the signal tf 1:1 (exactly 1 bar), same
        // convention as the auto-trader's own expiryTf - only meaningful
        // for binary/turbo; blitz/digital settle on expirySec instead.
        expiryBars: this.config.expiryTf ? Math.max(1, Math.round(TIMEFRAME_SECONDS[this.config.expiryTf] / TIMEFRAME_SECONDS[this.config.tf])) : 1,
        expirySec: kind === 'blitz' || kind === 'digital' ? this.config.expirySec : undefined,
        mode: exec.accountSource === 'iq' ? 'live' : 'paper',
        strategy: `meta:${this.config.signalSource}${this.config.signalSource === 'meta-strategy' && this.config.metaStrategyId ? `:${this.config.metaStrategyId}` : ''}`,
        note: META_TRADER_NOTE,
      })
      if (out.ok) {
        this.lastTradedAt.set(row.asset, this.now())
        if (this.config.cooldownSec > 0) {
          this.assetCooldownUntil.set(row.asset, this.now() + this.config.cooldownSec)
        }
      }
      return out
    } catch {
      return { ok: false, error: 'execution service unavailable' }
    }
  }
}

export const metaTraderPlugin: Plugin = {
  name: 'meta-trader',
  start: async (ctx) => {
    const svc = new MetaTraderService()
    ctx.provide('metaTrader', svc)
    metaTraderInstance = svc
    await svc.start(ctx)
  },
  stop: async () => {
    metaTraderInstance?.stop()
    metaTraderInstance = null
  },
}

let metaTraderInstance: MetaTraderService | null = null
