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
import { ALL_TIMEFRAMES } from '../types'
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

export interface MetaTraderConfig {
  enabled: boolean
  signalSource: MetaTraderSource
  /** only meaningful when signalSource === 'meta-strategy' - which saved
   * combinator spec (plugins/metastrategy.ts) to trade. */
  metaStrategyId?: string
  tf: Timeframe
  direction: 'call' | 'put' | 'both'
  /** 0-100 - the one quality gate this engine keeps (deliberately: "no
   * frictions" means no SELF-IMPOSED pacing/cooldown/payout/vol gating, not
   * "trade literally anything"). */
  minConfidence: number
  stake: number
  /** max concurrently open meta-trader positions, across all assets. */
  maxOpen: number
  kind: TradeKind
  marketScope: 'all' | 'real' | 'otc'
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
}

/** The fixed note prefix every Meta Trader position is tagged with -
 * exactly the same "note starts with X" identity contract the auto-trader
 * uses ('auto:os-trader'), so open-position counting/closing never
 * confuses the two engines' positions with each other. */
const META_TRADER_NOTE = 'meta:trader'

/** barsAgo===0 read of an SmcScanResult, optionally restricted to one kind.
 * Confidence is derived from how many "now" signals agree with the winning
 * side (including itself) out of every "now" signal across all kinds - an
 * honest, explainable number rather than a flat guess, and it naturally
 * rewards a kind firing ALONGSIDE other agreeing structure over one firing
 * in isolation. A lone signal with nothing else to agree or disagree with
 * gets a flat 65 (clearly labeled in the note). */
function smcNowRead(result: SmcScanResult, onlyKind?: SmcKind): { direction: 'call' | 'put' | 'none'; confidence: number; note: string } {
  const now = result.signals.filter((s) => s.barsAgo === 0)
  const pool = onlyKind ? now.filter((s) => s.kind === onlyKind) : now
  if (pool.length === 0) return { direction: 'none', confidence: 0, note: 'nothing hit this candle' }
  const bullish = pool.filter((s) => s.direction === 'bullish').length
  const bearish = pool.filter((s) => s.direction === 'bearish').length
  if (bullish === bearish) return { direction: 'none', confidence: 0, note: `${pool.length} now-signal(s), split evenly - no lean` }
  const direction: 'call' | 'put' = bullish > bearish ? 'call' : 'put'
  const winners = Math.max(bullish, bearish)
  const totalNow = now.length // agreement measured against EVERY kind firing now, not just onlyKind's own pool
  const confidence = totalNow <= 1 ? 65 : Math.round((winners / totalNow) * 100)
  const kindNote = onlyKind ? `${onlyKind} now (${pool.length}x)` : `${pool.length} concept(s) now`
  return { direction, confidence, note: `${kindNote} - ${winners}/${totalNow} now-signals agree ${direction}` }
}

export class MetaTraderService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private store!: Store
  private config: MetaTraderConfig = { ...DEFAULT_META_TRADER }
  private rt: MetaTraderRuntime = { trades: 0, wins: 0, losses: 0, pnlTotal: 0, openCount: 0, lastTradeTs: 0 }
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private unsub: (() => void) | null = null

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
        marketScope: saved.marketScope === 'real' || saved.marketScope === 'otc' ? saved.marketScope : 'all',
      }
    } catch {
      /* corrupt/missing config - start clean */
    }
  }

  private persist(): void {
    this.store.saveMetaTraderConfig(this.config)
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

  private onPositionClosed(position: { note?: string; pnl?: number; status: string; asset?: string }): void {
    if (!position.note?.startsWith(META_TRADER_NOTE)) return
    this.rebuildOpenCount()
    const pnl = position.pnl ?? 0
    this.rt.pnlTotal += pnl
    if (position.status === 'won') this.rt.wins += 1
    else if (position.status === 'lost') this.rt.losses += 1
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
    if (patch.marketScope !== undefined && (patch.marketScope === 'all' || patch.marketScope === 'real' || patch.marketScope === 'otc'))
      this.config.marketScope = patch.marketScope
    this.persist()
    this.ctx.log('meta-trader', `config updated - ${this.config.enabled ? 'armed' : 'off'} · src ${this.config.signalSource} · ${this.config.tf} · stake $${this.config.stake} · maxOpen ${this.config.maxOpen}`)
    return this.config
  }

  // ---------- candidate pool ----------

  private candidatePool(): string[] {
    const open = this.market.listAssets().filter((a) => a.open && (this.config.marketScope === 'all' || (this.config.marketScope === 'otc') === Boolean(a.otc)))
    const tickers = open.map((a) => a.ticker)
    const ordered = [...LIQUID_CANDIDATES.filter((a) => tickers.includes(a)), ...tickers.filter((a) => !LIQUID_CANDIDATES.includes(a))]
    return ordered.slice(0, MAX_TICK_CANDIDATES).filter((a) => !this.hasOpenOn(a))
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
    if (this.rt.openCount >= this.config.maxOpen) {
      this.rt.lastRejection = `max open meta-trader positions (${this.rt.openCount}/${this.config.maxOpen})`
      return
    }

    const candidates = this.pickCandidates()
    if (!candidates.length) {
      this.rt.lastRejection = `no ${this.config.signalSource} signal meets the ${this.config.minConfidence}% confidence floor right now`
      return
    }

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
      // otherwise a per-asset/broker hiccup - try the next-ranked candidate this same tick
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
    return out.sort((a, b) => b.confidence - a.confidence)
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
    return out.sort((a, b) => b.confidence - a.confidence)
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
    return out.sort((a, b) => b.confidence - a.confidence)
  }

  private pickSmc(onlyKind: SmcKind | undefined): MetaTraderRow[] {
    let smc: SmcScanService
    try {
      smc = this.ctx.use<SmcScanService>('smcScan')
    } catch {
      return []
    }
    const out: MetaTraderRow[] = []
    for (const asset of this.candidatePool()) {
      try {
        const res = smc.scan(asset, this.config.tf)
        if (!res.result) continue
        const read = smcNowRead(res.result, onlyKind)
        if (read.direction === 'none') continue
        if (this.config.direction !== 'both' && read.direction !== this.config.direction) continue
        if (!finGte(read.confidence, this.config.minConfidence)) continue
        const row = this.rowFrom(asset, read.direction, read.confidence, res.result.price, `smc: ${read.note}`)
        if (row) out.push(row)
      } catch {
        /* thin history - try the next */
      }
    }
    return out.sort((a, b) => b.confidence - a.confidence)
  }

  // ---------- placement ----------

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
          mode: 'paper' | 'live'
          strategy: string
          note: string
        }): Promise<{ ok: boolean; error?: string }>
      }>('execution')
      return await exec.placeOrder({
        asset: row.asset,
        tf: this.config.tf,
        side: row.direction,
        kind: this.config.kind,
        amount: this.config.stake,
        expiryBars: 1,
        mode: exec.accountSource === 'iq' ? 'live' : 'paper',
        strategy: `meta:${this.config.signalSource}${this.config.signalSource === 'meta-strategy' && this.config.metaStrategyId ? `:${this.config.metaStrategyId}` : ''}`,
        note: META_TRADER_NOTE,
      })
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
