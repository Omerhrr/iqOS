// IQAIR//OS - Brain Trader plugin: runs a saved MSL strategy like any other bot, but every signal must get past an AI reviewer first.
//
// The STRATEGY is an MSL meta-strategy spec (plugins/metastrategy.ts) - the first one is the builtin
// "meta:builtin-brain-fib-adaptive" (regime picks the playbook, Fibonacci finds the level, SMC + candlesticks confirm), and any other saved
// script spec can be picked instead. The strategy is not about counting votes: it adapts to the market regime and uses Fibonacci levels.
//
// Flow, once per newly CLOSED candle per asset:
//   1. metaStrategy.evaluate(id, asset, tf) - the script says call / put / none (+ confidence + its own notes).
//   2. A call / put at or above minConfidence is a SIGNAL. It is handed to the AI reviewer WITH what the strategy saw: the script, its
//      notes, the Fibonacci levels of the leg, the other panels' reads (second opinion) and the last bars. The reviewer can only answer
//      go / no and pick an expiry from the operator's allowed list. It cannot change the direction, the stake or the asset.
//   3. If the reviewer says go (and the trader is live, in AUTO mode, under max-open), the order goes through
//      ExecutionService.placeOrder() - same kill switch / risk manager / balance checks as every other engine. No side door.
//
// SHADOW by default (config.live = false): the whole pipeline runs and is logged, no order is placed. The reviewer fails CLOSED: no
// provider, a timeout or a reply that does not parse is a veto ("ai_unavailable"), never a silent go.
//
// MEASURED, NOT ASSUMED: every signal is scored at its own expiry against the closed candles - approved, vetoed, shadow and live alike.
// status().stats shows the hit rate of ALL signals next to the approved and the vetoed ones, the only honest way to learn whether the
// reviewer adds anything. Nothing here claims an edge: an LLM's vetoes cannot be validated in advance, and no strategy has a measured
// real-market win rate until the decision log says so.

import type { Plugin, KernelContext } from '../kernel'
import type { Store } from '../store'
import type { Candle, Timeframe, TradeKind } from '../types'
import { TIMEFRAME_SECONDS } from '../types'
import type { MarketDataService } from './market-data'
import type { OsMode } from './os-mode'
import type { MetaStrategyService } from './metastrategy'
import { fibEvidence, MIN_BARS } from '../analytics/brain'
import { chatComplete, type ChatMessage } from '../lib/llm'

const LIQUID_CANDIDATES = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD', 'BTCUSD']
const MAX_ASSETS = 12
const MAX_REVIEWS_PER_TICK = 3
const LOG_CAP = 300
const POLL_MS = 5000
/** one signal per asset+direction per this many bars (a script that stays true would otherwise re-fire every bar) */
const SIGNAL_HOLD_BARS = 5
const HARD_STOP_RE =
  /kill switch engaged|market closed for|amount must be positive|exceeds max stake|insufficient balance|live balance unknown|live broker not connected|unknown asset |no price feed|execution service unavailable/i
export const BRAIN_TRADER_NOTE = 'brain:trader'

export interface BrainTraderConfig {
  enabled: boolean
  /** false = SHADOW: everything runs and is logged, no order is placed */
  live: boolean
  tf: Timeframe
  direction: 'call' | 'put' | 'both'
  /** the saved MSL meta-strategy this trader runs (a SCRIPT spec) */
  metaStrategyId: string
  /** minimum strategy confidence (0-100) for a signal to be sent to the reviewer */
  minConfidence: number
  /** expiries (seconds) the reviewer may choose from */
  expiriesSec: number[]
  /** expiry used to SCORE a proposal when the reviewer gave none */
  defaultExpirySec: number
  /** false = trade the brain's proposals without the reviewer (not recommended) */
  requireAi: boolean
  /** hard cap on reviewer calls per hour (cost guard) */
  maxReviewsPerHour: number
  stake: number
  maxOpen: number
  kind: TradeKind
  marketScope: 'all' | 'real' | 'otc'
  cooldownSec: number
  assets?: string[]
  /** base URL of the Next.js app (shared LLM keys via /api/ai_trader_decide) */
  appUrl?: string
}

const DEFAULT_CONFIG: BrainTraderConfig = {
  enabled: false,
  live: false,
  tf: '1m',
  direction: 'both',
  metaStrategyId: 'meta:builtin-brain-fib-adaptive',
  minConfidence: 55,
  expiriesSec: [60, 180, 300],
  defaultExpirySec: 180,
  requireAi: true,
  maxReviewsPerHour: 30,
  stake: 1,
  maxOpen: 2,
  kind: 'binary',
  marketScope: 'all',
  cooldownSec: 120,
}

export type BrainDecisionStatus = 'approved' | 'vetoed' | 'ai_unavailable' | 'no_ai_needed' | 'rate_limited'

export interface BrainDecision {
  id: string
  ts: number
  asset: string
  tf: Timeframe
  /** open time (sec) of the closed bar the signal was read on */
  barTime: number
  direction: 'call' | 'put'
  strategyId: string
  strategyName: string
  /** the strategy's own confidence (0-100) */
  confidence: number
  /** the strategy's own notes for why it fired */
  notes: string
  entryPrice: number
  /** expiry used for scoring (the reviewer's pick, else the default) */
  expirySec: number
  status: BrainDecisionStatus
  ai?: { go: boolean; confidence: number; reason: string; provider: string; model: string; ms: number }
  /** an order was actually placed */
  placed: boolean
  placeError?: string
  outcome?: 'win' | 'loss' | 'tie'
  exitPrice?: number
}

export interface BrainGroupStats {
  n: number
  resolved: number
  wins: number
  losses: number
  ties: number
  /** wins / (wins + losses), null until there is at least one decided outcome */
  hitRate: number | null
}

export interface BrainTraderRuntime {
  reads: number
  proposals: number
  trades: number
  wins: number
  losses: number
  pnlTotal: number
  openCount: number
  lastTradeTs: number
  lastAction?: string
  lastRejection?: string
  lastReason?: string
}

export interface BrainTraderStats {
  /** every proposal, whatever the reviewer said */
  proposed: BrainGroupStats
  approved: BrainGroupStats
  vetoed: BrainGroupStats
  /** reviewer value = approved hit rate minus proposed hit rate, in points; null until both exist. Noisy on small samples. */
  reviewerLiftPts: number | null
  note: string
}

// ---------------------------------------------------------------- pure helpers (exported for tests)

export function snapExpiry(sec: number, allowed: number[]): number {
  const list = allowed.length ? allowed : [180]
  let best = list[0]
  for (const a of list) if (Math.abs(a - sec) < Math.abs(best - sec)) best = a
  return best
}

export interface ParsedReview {
  go: boolean
  expirySec: number
  confidence: number
  reason: string
}

/** Fail-closed parse of the reviewer's reply: anything that is not a clear {"decision":"go"|"no", ...} object is rejected (null). */
export function parseReview(text: string, allowedExpiries: number[]): ParsedReview | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(m[0]) as Record<string, unknown>
  } catch {
    return null
  }
  const d = typeof o.decision === 'string' ? o.decision.trim().toLowerCase() : ''
  if (d !== 'go' && d !== 'no') return null
  const exp = Number(o.expirySec)
  const conf = Number(o.confidence)
  return {
    go: d === 'go',
    expirySec: snapExpiry(Number.isFinite(exp) && exp > 0 ? exp : allowedExpiries[0] ?? 180, allowedExpiries),
    confidence: Number.isFinite(conf) ? Math.min(100, Math.max(0, Math.round(conf))) : 0,
    reason: typeof o.reason === 'string' ? o.reason.slice(0, 400) : '',
  }
}

export interface ReviewInput {
  asset: string
  tf: Timeframe
  strategyName: string
  script: string
  direction: 'call' | 'put'
  confidence: number
  notes: string
  price: number
  candles: Candle[]
  expiriesSec: number[]
  /** the other panels' reads (second opinion), already formatted one per line */
  panelLines: string[]
  /** strategy's own preferred horizon in minutes, if its script set `expiry = n` */
  scriptExpiryMin?: number
}

export function buildReviewMessages(inp: ReviewInput): ChatMessage[] {
  const recent = inp.candles
    .slice(-12)
    .map((c) => `${c.open.toFixed(5)}/${c.high.toFixed(5)}/${c.low.toFixed(5)}/${c.close.toFixed(5)}`)
    .join(' ')
  const fib = fibEvidence(inp.candles)
  const system = [
    'You are the trade reviewer for a rule-based binary-options strategy. The strategy has produced ONE signal. You decide only: go or no, and which expiry.',
    'You cannot change the direction, the asset or the stake. If the evidence is thin, contradictory, the level looks stale or the move already happened, answer "no". Saying no is cheap; a bad trade is not.',
    'The strategy\'s confidence is a fixed number its script assigns, NOT a win probability. The other panels read the same candles, so their agreement is correlated evidence, not independent confirmation.',
    `Pick expirySec from exactly this list: ${inp.expiriesSec.join(', ')} (seconds). Match it to the setup: a pullback entry with room to run can take longer; a late entry or a fade at a range edge should be short.`,
    'Reply with ONE JSON object and nothing else: {"decision":"go"|"no","expirySec":<number>,"confidence":<0-100>,"reason":"<one or two sentences>"}.',
  ].join('\n')
  const user = [
    `ASSET ${inp.asset} - timeframe ${inp.tf} - last close ${inp.price}`,
    `SIGNAL: ${inp.direction.toUpperCase()} from strategy "${inp.strategyName}", strategy confidence ${inp.confidence}/100.`,
    `WHY IT FIRED (the strategy's own notes): ${inp.notes || '(none)'}`,
    inp.scriptExpiryMin ? `The script suggests a ${inp.scriptExpiryMin}-minute horizon.` : '',
    `STRATEGY SCRIPT:\n${inp.script.slice(0, 3500)}`,
    fib,
    inp.panelLines.length ? `OTHER PANELS (second opinion, correlated with the strategy):\n${inp.panelLines.join('\n')}` : '',
    `LAST 12 CLOSED BARS (open/high/low/close): ${recent}`,
  ]
    .filter(Boolean)
    .join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function groupStats(rows: BrainDecision[]): BrainGroupStats {
  const resolved = rows.filter((r) => r.outcome)
  const wins = resolved.filter((r) => r.outcome === 'win').length
  const losses = resolved.filter((r) => r.outcome === 'loss').length
  const ties = resolved.filter((r) => r.outcome === 'tie').length
  return { n: rows.length, resolved: resolved.length, wins, losses, ties, hitRate: wins + losses > 0 ? wins / (wins + losses) : null }
}

export function computeStats(log: BrainDecision[]): BrainTraderStats {
  const proposed = groupStats(log)
  const approved = groupStats(log.filter((d) => d.status === 'approved' || d.status === 'no_ai_needed'))
  const vetoed = groupStats(log.filter((d) => d.status === 'vetoed'))
  const lift = proposed.hitRate !== null && approved.hitRate !== null ? Math.round((approved.hitRate - proposed.hitRate) * 1000) / 10 : null
  return {
    proposed,
    approved,
    vetoed,
    reviewerLiftPts: lift,
    note: 'Every proposal is scored at its own expiry against closed candles (entry = the decision bar\'s close), shadow and vetoed ones included. Small samples are noise: do not read the reviewer lift until each group has hundreds of decided outcomes.',
  }
}

/** Score one decision against closed candles: exit = close of the bar `expiryBars` bars after the decision bar. null = not resolvable yet. */
export function resolveOutcome(d: BrainDecision, candles: Candle[]): { outcome: 'win' | 'loss' | 'tie'; exitPrice: number } | null {
  const tfSec = TIMEFRAME_SECONDS[d.tf]
  const bars = Math.max(1, Math.round(d.expirySec / tfSec))
  const exitTime = d.barTime + bars * tfSec
  const bar = candles.find((c) => c.time === exitTime)
  if (!bar) return null
  const exit = bar.close
  const diff = exit - d.entryPrice
  if (Math.abs(diff) < 1e-12) return { outcome: 'tie', exitPrice: exit }
  const won = d.direction === 'call' ? diff > 0 : diff < 0
  return { outcome: won ? 'win' : 'loss', exitPrice: exit }
}

async function callLlm(appUrl: string, messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number; timeoutMs?: number }): Promise<{ content: string; provider: string; model: string }> {
  try {
    const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/ai_trader_decide`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(String(process.env.KERNEL_TOKEN ?? '').trim() ? { 'x-kernel-token': String(process.env.KERNEL_TOKEN).trim() } : {}),
      },
      body: JSON.stringify({ messages, ...opts }),
      signal: AbortSignal.timeout((opts.timeoutMs ?? 30_000) + 5_000),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; content?: string; provider?: string; model?: string; error?: string }
    if (!res.ok || !data.ok) throw new Error(data.error ?? `app HTTP ${res.status}`)
    if (!data.content) throw new Error('app returned no content')
    return { content: data.content, provider: data.provider ?? 'app', model: data.model ?? '' }
  } catch (appErr) {
    try {
      return await chatComplete({ messages, ...opts })
    } catch (localErr) {
      throw new Error(`via app: ${(appErr as Error).message} | via own env: ${(localErr as Error).message}`)
    }
  }
}

// ---------------------------------------------------------------- service

export class BrainTraderService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private store!: Store
  private config: BrainTraderConfig = { ...DEFAULT_CONFIG }
  private rt: BrainTraderRuntime = { reads: 0, proposals: 0, trades: 0, wins: 0, losses: 0, pnlTotal: 0, openCount: 0, lastTradeTs: 0 }
  private log: BrainDecision[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private unsub: (() => void) | null = null
  private lastBar = new Map<string, number>()
  private lastSignalBar = new Map<string, number>()
  private assetCooldownUntil = new Map<string, number>()
  private reviewTimes: number[] = []
  private seq = 0

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.store = ctx.use<Store>('store')
    this.restore()
    this.rebuildOpenCount()
    this.unsub = ctx.bus.on('positionClosed', ({ position }) => this.onPositionClosed(position))
    this.timer = setInterval(() => {
      void this.tick().catch((err) => ctx.log('brain-trader', `tick() rejected, skipping this cycle: ${(err as Error).message}`))
    }, POLL_MS)
    ctx.log('brain-trader', `brain trader online - ${this.config.enabled ? (this.config.live ? 'LIVE' : 'SHADOW') : 'off'}`)
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
      const s = this.store.getBrainTraderConfig() as Record<string, unknown> | null
      if (s) this.config = sanitize({ ...DEFAULT_CONFIG, ...s })
      const l = this.store.getBrainTraderLog()
      if (Array.isArray(l)) {
        this.log = (l as BrainDecision[]).slice(-LOG_CAP)
        this.seq = this.log.length
      }
    } catch {
      // corrupt/missing - stay on safe defaults (disabled, shadow)
    }
  }

  private persistConfig(): void {
    this.store.saveBrainTraderConfig({ ...this.config })
  }
  private persistLog(): void {
    this.store.saveBrainTraderLog(this.log)
  }

  private rebuildOpenCount(): void {
    try {
      this.rt.openCount = this.store.listPositions('open', 500).filter((p) => p.note?.startsWith(BRAIN_TRADER_NOTE)).length
    } catch {
      this.rt.openCount = 0
    }
  }

  private hasOpenOn(asset: string): boolean {
    try {
      return this.store.listPositions('open', 500).some((p) => p.note?.startsWith(BRAIN_TRADER_NOTE) && p.asset === asset)
    } catch {
      return false
    }
  }

  private onPositionClosed(position: { note?: string; pnl?: number; status: string }): void {
    if (!position.note?.startsWith(BRAIN_TRADER_NOTE)) return
    this.rebuildOpenCount()
    this.rt.pnlTotal += position.pnl ?? 0
    if (position.status === 'won') this.rt.wins += 1
    else if (position.status === 'lost') this.rt.losses += 1
  }

  /** Fresh start for the numbers and the decision log; config untouched. */
  resetAllStats(): void {
    this.rt = { reads: 0, proposals: 0, trades: 0, wins: 0, losses: 0, pnlTotal: 0, openCount: 0, lastTradeTs: 0 }
    this.log = []
    this.seq = 0
    this.lastBar.clear()
    this.lastSignalBar.clear()
    this.assetCooldownUntil.clear()
    this.reviewTimes = []
    this.rebuildOpenCount()
    this.persistLog()
    this.ctx.log('brain-trader', 'stats and decision log cleared - starting fresh')
  }

  status(): { enabled: boolean; live: boolean; mode: OsMode; active: boolean; config: BrainTraderConfig; runtime: BrainTraderRuntime; stats: BrainTraderStats; reviewsLastHour: number } {
    let mode: OsMode = 'human'
    try {
      mode = this.ctx.use<{ status(): { mode: OsMode } }>('mode').status().mode
    } catch {
      /* mode plugin always loaded in practice */
    }
    const cut = Date.now() - 3_600_000
    return {
      enabled: this.config.enabled,
      live: this.config.live,
      mode,
      active: this.config.enabled && this.config.live && mode === 'auto',
      config: this.config,
      runtime: this.rt,
      stats: computeStats(this.log),
      reviewsLastHour: this.reviewTimes.filter((t) => t >= cut).length,
    }
  }

  private metaStrategy(): MetaStrategyService {
    return this.ctx.use<MetaStrategyService>('metaStrategy')
  }

  /** the other panels' reads, one short line each (second opinion for the reviewer). Never throws. */
  private panelLines(asset: string): string[] {
    try {
      return this.metaStrategy()
        .snapshotSources(asset, this.config.tf)
        .filter((r) => r.direction !== 'none')
        .slice(0, 24)
        .map((r) => `- ${r.source}: ${r.direction} ${Math.round(r.confidence)}${r.label ? ` (${String(r.label).slice(0, 60)})` : ''}`)
    } catch {
      return []
    }
  }

  /** Run the configured strategy on one asset RIGHT NOW (closed bars). No AI call, no order, nothing logged. */
  preview(asset: string, tf?: Timeframe): { asset: string; tf: Timeframe; strategyId: string; strategyName: string; direction: 'call' | 'put' | 'none'; confidence: number; notes: string; price: number; wouldSend: boolean; bars: number } {
    const t = tf && tf in TIMEFRAME_SECONDS ? tf : this.config.tf
    const ev = this.metaStrategy().evaluate(this.config.metaStrategyId, asset, t)
    const bars = this.market.getCandlesDeep(asset, t, 320, true).length
    const r = ev.result
    const dirOk = this.config.direction === 'both' || r.direction === this.config.direction
    return {
      asset,
      tf: t,
      strategyId: ev.spec.id,
      strategyName: ev.spec.name,
      direction: r.direction,
      confidence: r.confidence,
      notes: r.notes,
      price: ev.price,
      wouldSend: r.direction !== 'none' && r.confidence >= this.config.minConfidence && dirOk,
      bars,
    }
  }

  decisions(limit = 50): BrainDecision[] {
    return this.log.slice(-Math.max(1, Math.min(LOG_CAP, limit))).reverse()
  }

  configure(patch: Partial<BrainTraderConfig>): BrainTraderConfig {
    this.config = sanitize({ ...this.config, ...patch })
    this.persistConfig()
    this.ctx.log('brain-trader', `config updated - ${this.config.enabled ? (this.config.live ? 'LIVE' : 'SHADOW') : 'off'} · ${this.config.tf} · ${this.config.metaStrategyId} · conf>=${this.config.minConfidence} · expiries ${this.config.expiriesSec.join('/')}s`)
    return this.config
  }

  private candidatePool(): string[] {
    const open = this.market.listAssets().filter((a) => a.open && (this.config.marketScope === 'all' || (this.config.marketScope === 'otc') === Boolean(a.otc)))
    const tickers = open.map((a) => a.ticker)
    const configured = this.config.assets?.length ? this.config.assets.filter((a) => tickers.includes(a)) : undefined
    const ordered = configured ?? [...LIQUID_CANDIDATES.filter((a) => tickers.includes(a)), ...tickers.filter((a) => !LIQUID_CANDIDATES.includes(a))]
    return ordered.slice(0, MAX_ASSETS)
  }

  // ---------- loop ----------

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      if (!this.config.enabled) return
      this.resolvePending()
      await this.scan()
    } finally {
      this.ticking = false
    }
  }

  /** score every unresolved decision whose exit bar has closed */
  private resolvePending(): void {
    let changed = false
    for (const d of this.log) {
      if (d.outcome) continue
      const tfSec = TIMEFRAME_SECONDS[d.tf]
      const bars = Math.max(1, Math.round(d.expirySec / tfSec))
      if (this.now() < d.barTime + (bars + 1) * tfSec) continue // exit bar not closed yet
      let candles: Candle[]
      try {
        candles = this.market.getCandlesDeep(d.asset, d.tf, bars + 40, true)
      } catch {
        continue
      }
      const r = resolveOutcome(d, candles)
      if (r) {
        d.outcome = r.outcome
        d.exitPrice = r.exitPrice
        changed = true
      } else if (this.now() > d.barTime + (bars + 60) * tfSec) {
        // the exit bar never showed up (market closed over it) - leave it unscored rather than guess
        d.outcome = undefined
      }
    }
    if (changed) this.persistLog()
  }

  private reviewBudgetLeft(): boolean {
    const cut = Date.now() - 3_600_000
    this.reviewTimes = this.reviewTimes.filter((t) => t >= cut)
    return this.reviewTimes.length < this.config.maxReviewsPerHour
  }

  private async scan(): Promise<void> {
    let reviewsThisTick = 0
    for (const asset of this.candidatePool()) {
      let candles: Candle[]
      try {
        candles = this.market.getCandlesDeep(asset, this.config.tf, 320, true)
      } catch {
        continue
      }
      if (candles.length < MIN_BARS) continue
      const last = candles[candles.length - 1]
      if (this.lastBar.get(asset) === last.time) continue // already read this closed bar
      this.lastBar.set(asset, last.time)
      this.rt.reads += 1
      let ev: { spec: { id: string; name: string; script?: string }; result: { direction: 'call' | 'put' | 'none'; confidence: number; notes: string; expiryMin?: number }; price: number }
      try {
        ev = this.metaStrategy().evaluate(this.config.metaStrategyId, asset, this.config.tf)
      } catch (err) {
        this.rt.lastRejection = `strategy ${this.config.metaStrategyId}: ${(err as Error).message}`
        continue
      }
      const sig = ev.result
      this.rt.lastReason = `${asset}: ${sig.direction === 'none' ? 'no signal' : `${sig.direction} @ ${sig.confidence}`}`
      if (sig.direction === 'none' || sig.confidence < this.config.minConfidence) continue
      if (this.config.direction !== 'both' && sig.direction !== this.config.direction) continue
      if ((this.assetCooldownUntil.get(asset) ?? 0) > this.now()) continue
      // a script that stays true for several bars would re-fire every bar: one signal per asset+direction per SIGNAL_HOLD_BARS bars
      const sigKey = `${asset}|${sig.direction}`
      const prev = this.lastSignalBar.get(sigKey)
      if (prev !== undefined && last.time - prev < SIGNAL_HOLD_BARS * TIMEFRAME_SECONDS[this.config.tf]) continue
      this.lastSignalBar.set(sigKey, last.time)
      this.rt.proposals += 1

      const dec: BrainDecision = {
        id: `b${Date.now().toString(36)}${(this.seq++).toString(36)}`,
        ts: this.now(),
        asset,
        tf: this.config.tf,
        barTime: last.time,
        direction: sig.direction,
        strategyId: ev.spec.id,
        strategyName: ev.spec.name,
        confidence: sig.confidence,
        notes: sig.notes,
        entryPrice: last.close,
        expirySec: this.config.defaultExpirySec,
        status: 'approved',
        placed: false,
      }

      let go = true
      if (this.config.requireAi) {
        if (reviewsThisTick >= MAX_REVIEWS_PER_TICK || !this.reviewBudgetLeft()) {
          dec.status = 'rate_limited'
          go = false
        } else {
          reviewsThisTick += 1
          this.reviewTimes.push(Date.now())
          const t0 = Date.now()
          try {
            const res = await callLlm(this.config.appUrl ?? 'http://localhost:3000', buildReviewMessages({ asset, tf: this.config.tf, strategyName: ev.spec.name, script: ev.spec.script ?? '', direction: sig.direction, confidence: sig.confidence, notes: sig.notes, price: last.close, candles, expiriesSec: this.config.expiriesSec, panelLines: this.panelLines(asset), scriptExpiryMin: sig.expiryMin }), { temperature: 0.2, maxTokens: 300, timeoutMs: 30_000 })
            const parsed = parseReview(res.content, this.config.expiriesSec)
            if (!parsed) {
              dec.status = 'ai_unavailable'
              dec.ai = { go: false, confidence: 0, reason: 'reply did not parse as a go/no JSON object - treated as a veto', provider: res.provider, model: res.model, ms: Date.now() - t0 }
              go = false
            } else {
              dec.expirySec = parsed.expirySec
              dec.ai = { go: parsed.go, confidence: parsed.confidence, reason: parsed.reason, provider: res.provider, model: res.model, ms: Date.now() - t0 }
              dec.status = parsed.go ? 'approved' : 'vetoed'
              go = parsed.go
            }
          } catch (err) {
            dec.status = 'ai_unavailable'
            dec.ai = { go: false, confidence: 0, reason: `reviewer unreachable - treated as a veto: ${(err as Error).message}`.slice(0, 300), provider: '', model: '', ms: Date.now() - t0 }
            go = false
          }
        }
      } else {
        dec.status = 'no_ai_needed'
      }

      if (go && this.config.live) await this.maybePlace(dec)
      this.log.push(dec)
      if (this.log.length > LOG_CAP) this.log = this.log.slice(-LOG_CAP)
      this.persistLog()
      this.rt.lastAction = `${dec.status} ${dec.direction.toUpperCase()} ${asset} (${dec.expirySec}s)${dec.placed ? ' - ORDER PLACED' : this.config.live ? '' : ' - shadow'}`
    }
  }

  private async maybePlace(dec: BrainDecision): Promise<void> {
    let mode: OsMode = 'human'
    try {
      mode = this.ctx.use<{ status(): { mode: OsMode } }>('mode').status().mode
    } catch {
      /* treat as human - nothing trades */
    }
    if (mode !== 'auto') {
      dec.placeError = 'OS mode is not AUTO - logged only'
      this.rt.lastRejection = dec.placeError
      return
    }
    if (this.rt.openCount >= this.config.maxOpen) {
      dec.placeError = `max open brain-trader positions (${this.rt.openCount}/${this.config.maxOpen})`
      this.rt.lastRejection = dec.placeError
      return
    }
    if (this.hasOpenOn(dec.asset)) {
      dec.placeError = 'already holding a brain-trader position on this asset'
      this.rt.lastRejection = dec.placeError
      return
    }
    const out = await this.place(dec)
    if (out.ok) {
      dec.placed = true
      this.rt.trades += 1
      this.rt.openCount += 1
      this.rt.lastTradeTs = this.now()
      this.rt.lastRejection = undefined
      if (this.config.cooldownSec > 0) this.assetCooldownUntil.set(dec.asset, this.now() + this.config.cooldownSec)
    } else {
      dec.placeError = out.error ?? 'order rejected'
      this.rt.lastRejection = dec.placeError
      if (HARD_STOP_RE.test(dec.placeError)) this.assetCooldownUntil.set(dec.asset, this.now() + 60)
    }
  }

  private async place(dec: BrainDecision): Promise<{ ok: boolean; error?: string }> {
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
      return await exec.placeOrder({
        asset: dec.asset,
        tf: this.config.tf,
        side: dec.direction,
        kind,
        amount: this.config.stake,
        expiryBars: Math.max(1, Math.round(dec.expirySec / TIMEFRAME_SECONDS[this.config.tf])),
        expirySec: kind === 'blitz' || kind === 'digital' || kind === 'binary' ? dec.expirySec : undefined,
        mode: exec.accountSource === 'iq' ? 'live' : 'paper',
        strategy: `brain:${dec.strategyId}`,
        note: `${BRAIN_TRADER_NOTE} ${dec.id}`,
      })
    } catch {
      return { ok: false, error: 'execution service unavailable' }
    }
  }
}

function sanitize(c: BrainTraderConfig): BrainTraderConfig {
  const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb)
  const exp = Array.isArray(c.expiriesSec) ? c.expiriesSec.map(Number).filter((x) => Number.isFinite(x) && x >= 5 && x <= 3600).map(Math.round) : []
  const expiriesSec = [...new Set(exp.length ? exp : DEFAULT_CONFIG.expiriesSec)].sort((a, b) => a - b).slice(0, 8)
  return {
    enabled: Boolean(c.enabled),
    live: Boolean(c.live),
    tf: (typeof c.tf === 'string' && c.tf in TIMEFRAME_SECONDS ? c.tf : DEFAULT_CONFIG.tf) as Timeframe,
    direction: c.direction === 'call' || c.direction === 'put' ? c.direction : 'both',
    metaStrategyId: typeof c.metaStrategyId === 'string' && c.metaStrategyId.trim() ? c.metaStrategyId.trim() : DEFAULT_CONFIG.metaStrategyId,
    minConfidence: Math.min(100, Math.max(0, num(c.minConfidence, DEFAULT_CONFIG.minConfidence))),
    expiriesSec,
    defaultExpirySec: snapExpiry(num(c.defaultExpirySec, DEFAULT_CONFIG.defaultExpirySec), expiriesSec),
    requireAi: c.requireAi !== false,
    maxReviewsPerHour: Math.min(600, Math.max(1, Math.round(num(c.maxReviewsPerHour, DEFAULT_CONFIG.maxReviewsPerHour)))),
    stake: Math.max(0, num(c.stake, DEFAULT_CONFIG.stake)),
    maxOpen: Math.max(1, Math.round(num(c.maxOpen, DEFAULT_CONFIG.maxOpen))),
    kind: (typeof c.kind === 'string' && c.kind ? c.kind : DEFAULT_CONFIG.kind) as TradeKind,
    marketScope: c.marketScope === 'real' || c.marketScope === 'otc' ? c.marketScope : 'all',
    cooldownSec: Math.max(0, num(c.cooldownSec, DEFAULT_CONFIG.cooldownSec)),
    assets: Array.isArray(c.assets) ? c.assets.filter((a): a is string => typeof a === 'string') : undefined,
    appUrl: typeof c.appUrl === 'string' && c.appUrl ? c.appUrl : undefined,
  }
}

let brainTraderInstance: BrainTraderService | null = null

export const brainTraderPlugin: Plugin = {
  name: 'brain-trader',
  start: async (ctx) => {
    const svc = new BrainTraderService()
    ctx.provide('brainTrader', svc)
    brainTraderInstance = svc
    await svc.start(ctx)
  },
  stop: async () => {
    brainTraderInstance?.stop()
    brainTraderInstance = null
  },
}
