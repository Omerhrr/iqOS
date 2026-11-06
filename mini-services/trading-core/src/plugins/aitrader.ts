// IQAIR//OS - AI Trader: "a meta/auto trader with brains," per direct
// request. Every other auto-trader in this codebase (the single Meta
// Trader, the autopilot bot fleet, Meta Strategy specs) decides with FIXED
// rules - indicator thresholds, panel-source votes, learned AI-Lab specs.
//
// This one is explicitly cast as the HUMAN at the desk, not another system
// alongside those - per direct instruction: "take all analysis, make yours,
// decide expiry, decide direction and whether to trade or not." The other
// auto-traders' panel reads (MetaStrategyService.snapshotSources -
// oracle/accute/smc/renko/pointFigure/rangeBars etc) are handed to it as a
// SECOND OPINION from "the desk," same as a real trader's own indicators -
// but the PRIMARY evidence is its own read of the raw recent candles,
// computed per-expiry-choice (see buildHorizonReads below) so the direction
// AND the expiry get decided together against that one specific holding
// period, not a generic longer-term bias. It can agree with the desk, it
// can override it, or it can conclude disagreement itself means skip - see
// the system prompt in runCycle() for exactly how that's framed to the
// model. On a timer rather than every candle close - the user's own framing
// was "6 trades an hour, roughly one every ~10 minutes, 3-5 min expiry,
// only when it sees a good opportunity" - so this is an opportunity-scan
// loop, not an edge-trigger dispatcher like the bots.
//
// Per direct instruction this starts in SHADOW mode by default (config.live
// = false): every cycle still runs the full snapshot -> LLM -> decision
// pipeline and logs the result (direction/confidence/expiry/reasoning),
// but no real order is placed until the operator explicitly flips `live`
// to true. An LLM's judgment can't be walk-forward validated the way a
// fixed rule can (same prompt, same weights, different day - no stable
// "edge" to even measure), so the honest trust-building path is: watch it
// decide for a while, read its reasoning, THEN let it touch money - never
// the "always forced, always live" treatment meta: specs get elsewhere in
// this codebase, which is appropriate there because that's a FIXED
// combinator the operator already built and chose to run; here the
// operator hasn't even seen a single decision yet.
//
// A live decision still goes through ExecutionService.placeOrder(), so the
// SAME risk manager (kill switch, daily loss limit, max stake, max
// concurrent positions, loss-streak cooldown, sentinel, market hours) gates
// it exactly like every other order in this system - there is no side door
// around that gate for this trader or any other.
//
// KNOWN GAP (documented, not silently skipped): the OTC defense guard
// (otcguard.ts) placebo-tests a fixed strategyKey against its own
// synthetic-feed calibration - there is no strategyKey here (a prompt
// isn't one), so OTC gating does not apply to this trader yet. Treat an
// OTC asset here as unverified until that's addressed; the global risk
// manager's other gates still apply either way.

import type { Candle, Timeframe, TradeKind } from '../types'
import type { KernelContext, Plugin } from '../kernel'
import { Store } from '../store'
import type { MarketDataService } from './market-data'
import type { ExecutionService } from './execution'
import type { MetaStrategyService } from './metastrategy'
import { chatComplete, providerStatus, type ChatMessage } from '../lib/llm'
import { tfSeconds } from '../analytics/synthfeed'
import { atr, closes, ema, highs, lows, rsi } from '../analytics/indicators'

export interface AiTraderConfig {
  enabled: boolean
  /** false (default) = shadow: decide + log every cycle, place nothing.
   *  true = act on non-skip decisions through the real risk-gated order path. */
  live: boolean
  asset: string
  tf: Timeframe
  /** Minutes between opportunity scans - NOT a guaranteed trade cadence
   *  ("6 trades an hour" is the user's own ceiling if it sees an
   *  opportunity every single cycle; a quiet market can skip every cycle). */
  intervalMin: number
  stake: number
  kind: TradeKind
  /** Decisions below this are forced to 'skip' regardless of what the model
   *  itself returned - the floor the operator sets, not just a suggestion
   *  the model can talk itself past. */
  minConfidence: number
  /** Expiry choices (minutes) the prompt offers the model - it picks ONE
   *  per decision, it does not invent others. */
  expiryChoices: number[]
  /** LLM provider override - only used on the local-fallback path (see
   *  callLlm() below); the primary path calls through to the Next.js app,
   *  which picks its own provider exactly like the Copilot does. */
  provider?: string
  /** Base URL of the Next.js app (this app's own frontend) - the primary
   *  LLM path POSTs to `${appUrl}/api/ai_trader_decide`, which runs
   *  THROUGH the exact same chatComplete() the Copilot and CodeAssistBar
   *  already use successfully, so there's nothing new to configure: same
   *  keys, same provider, zero separate setup. Defaults to localhost:3000
   *  (the standard `next dev`/`next start` port) - override here if this
   *  app is actually served from somewhere else (a different port, a
   *  docker-compose service name, etc). */
  appUrl?: string
}

export interface AiTraderDecision {
  id: number
  asset: string
  tf: string
  direction: 'call' | 'put' | 'skip'
  confidence: number
  expiryMin: number | null
  reasoning: string
  live: boolean
  acted: boolean
  positionId: string | null
  provider: string | null
  model: string | null
  error: string | null
  ts: number
}

const DEFAULT_CONFIG: AiTraderConfig = {
  enabled: false,
  live: false,
  asset: 'EURUSD',
  tf: '1m',
  intervalMin: 10,
  stake: 1,
  kind: 'binary',
  minConfidence: 65,
  expiryChoices: [3, 5],
  // NOT a literal default on purpose - see resolveAppUrl() below. Baking
  // 'http://127.0.0.1:3000' in here would get written into every saved
  // config (the panel always sends the whole draft on save), permanently
  // shadowing a correct APP_URL env var set later (e.g. after moving this
  // deployment behind docker-compose, where the right address is a service
  // name like http://iqos-web:47311, not localhost at all).
  appUrl: undefined,
}

/** Resolution order: an APP_URL env var (the deployment's own wiring - set
 * this in docker-compose.yml's iqos-kernel service, mirroring how iqos-web
 * already gets KERNEL_URL=http://iqos-kernel:47312 there) always wins, THEN
 * whatever's saved in config (useful for a bare dev setup with no compose
 * env at all), THEN localhost:3000 as the last-resort default. Env wins
 * over config specifically so a correct container-network address isn't
 * permanently stuck behind a stale 127.0.0.1 the UI already saved once. */
function resolveAppUrl(config: AiTraderConfig): string {
  return process.env.APP_URL || config.appUrl || 'http://127.0.0.1:3000'
}

/** Primary path: call THROUGH the Next.js app's /api/ai_trader_decide,
 * which runs the exact same chatComplete() the Copilot/CodeAssistBar
 * already use successfully in that process - same env, same provider, no
 * second copy of any key to keep in sync. Falls back to trading-core's OWN
 * local LLM client (lib/llm.ts, reading trading-core's/the shared root
 * .env) only if the app is unreachable at all (not running, wrong appUrl,
 * network blocked) - so this still works for an operator who genuinely
 * wants trading-core fully independent of the frontend, but that's now the
 * fallback, not the thing everyone has to configure first. */
async function callLlm(
  appUrl: string,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number }
): Promise<{ content: string; provider: string; model: string }> {
  try {
    const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/ai_trader_decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, ...opts }),
      signal: AbortSignal.timeout((opts.timeoutMs ?? 45_000) + 5_000), // small margin over the route's own internal timeout
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; content?: string; provider?: string; model?: string; error?: string }
    if (!res.ok || !data.ok) throw new Error(data.error ?? `app HTTP ${res.status}`)
    if (!data.content) throw new Error('app returned no content')
    return { content: data.content, provider: data.provider ?? 'app', model: data.model ?? '' }
  } catch (appErr) {
    try {
      const res = await chatComplete({ messages, ...opts })
      return res
    } catch (localErr) {
      throw new Error(
        `via app (${appUrl}): ${String(appErr instanceof Error ? appErr.message : appErr)} | via trading-core's own .env: ${String(localErr instanceof Error ? localErr.message : localErr)}`
      )
    }
  }
}

/** Minutes -> seconds, used for placeOrder's direct expirySec path (binary
 * accepts an exact expirySec same as turbo/blitz - see execution.ts). */
const minToSec = (m: number) => Math.max(1, Math.round(m * 60))

/** Per-expiry-choice read, computed directly off the raw candles rather than
 * any other predictor's pre-digested verdict. This is what makes the model
 * actually reason about THIS trade's specific holding period instead of
 * reacting to a generic, horizon-agnostic signal - a 3min and a 15min expiry
 * can legitimately disagree, and conflating them is exactly the "immediate
 * context" loss the operator flagged. */
interface HorizonRead {
  expiryMin: number
  bars: number
  momentumPct: number
  upBars: number
  downBars: number
  /** |momentum| divided by a random-walk-scaled noise estimate (atr% *
   * sqrt(bars)) - a rough signal-to-noise ratio for THIS window length.
   * Comfortably >1 means the drift measured is bigger than you'd expect
   * from noise alone over that many bars; well under 1 means it's
   * indistinguishable from chop and shouldn't be read as a trend. */
  snr: number
}

function buildHorizonReads(closePrices: number[], tfSec: number, expiryChoices: number[], atrPct: number): HorizonRead[] {
  const n = closePrices.length
  return expiryChoices.map((expiryMin) => {
    const bars = Math.max(1, Math.round((expiryMin * 60) / tfSec))
    const start = n - 1 - bars
    let momentumPct = 0
    let upBars = 0
    let downBars = 0
    if (start >= 0 && closePrices[start]) {
      momentumPct = ((closePrices[n - 1] - closePrices[start]) / closePrices[start]) * 100
      for (let i = start + 1; i < n; i++) {
        if (closePrices[i] > closePrices[i - 1]) upBars += 1
        else if (closePrices[i] < closePrices[i - 1]) downBars += 1
      }
    }
    const noise = atrPct * Math.sqrt(bars)
    const snr = noise > 0 ? Math.abs(momentumPct) / noise : 0
    return { expiryMin, bars, momentumPct, upBars, downBars, snr }
  })
}

interface ParsedDecision {
  direction: 'call' | 'put' | 'skip'
  confidence: number
  expiryMin: number
  reasoning: string
}

/** Strict-then-forgiving JSON extraction, same ladder codeAssist.ts's
 * parseCodeAssistReply uses for the same reason: a model that's 95% good at
 * "return ONLY JSON" still occasionally wraps it in prose or a fenced block,
 * and a trade decision is exactly the place NOT to throw that away. */
function parseDecision(raw: string, allowedExpiries: number[]): ParsedDecision | null {
  const fallbackExpiry = allowedExpiries[0] ?? 3
  const tryParse = (text: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(text)
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  let obj = tryParse(raw.trim())
  if (!obj) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced) obj = tryParse(fenced[1].trim())
  }
  if (!obj) {
    const brace = raw.match(/\{[\s\S]*\}/)
    if (brace) obj = tryParse(brace[0])
  }
  if (!obj) return null
  const dirRaw = String(obj.direction ?? '').toLowerCase()
  const direction: ParsedDecision['direction'] = dirRaw === 'call' || dirRaw === 'put' ? dirRaw : 'skip'
  const confidence = Math.max(0, Math.min(100, Number(obj.confidence) || 0))
  // The model is offered a fixed menu of expiries and told to pick one, not
  // invent one - snap to the closest allowed choice rather than trusting an
  // arbitrary number back, since placeOrder will use this verbatim.
  const rawExpiry = Number(obj.expiryMin)
  const expiryMin =
    rawExpiry > 0 && allowedExpiries.length
      ? allowedExpiries.reduce((best, c) => (Math.abs(c - rawExpiry) < Math.abs(best - rawExpiry) ? c : best), allowedExpiries[0])
      : fallbackExpiry
  const reasoning = String(obj.reasoning ?? '').trim() || '(no reasoning given)'
  return { direction, confidence, expiryMin, reasoning }
}

export class AiTraderService {
  private ctx!: KernelContext
  private store!: Store
  private market!: MarketDataService
  private exec!: ExecutionService
  private meta: MetaStrategyService | null = null
  private config: AiTraderConfig = { ...DEFAULT_CONFIG }
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false // reentrancy guard - a slow LLM call must never overlap its own next tick
  private lastRunTs = 0
  private lastError: string | null = null
  private cycles = 0

  private metaStrategyService(): MetaStrategyService | null {
    if (this.meta) return this.meta
    try {
      this.meta = this.ctx.use<MetaStrategyService>('metaStrategy')
    } catch {
      this.meta = null
    }
    return this.meta
  }

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.store = ctx.use<Store>('store')
    this.market = ctx.use<MarketDataService>('market')
    this.exec = ctx.use<ExecutionService>('execution')
    const saved = this.store.getAiTraderConfig() as Partial<AiTraderConfig> | null
    this.config = { ...DEFAULT_CONFIG, ...(saved ?? {}) }
    this.store.pruneAiTraderDecisions(1000)
    ctx.log('ai-trader', `AI Trader online - ${this.config.enabled ? 'ENABLED' : 'disabled'}, ${this.config.live ? 'LIVE' : 'shadow (logging only)'}, ${this.config.asset} ${this.config.tf}, every ${this.config.intervalMin}min`)
    this.scheduleTimer()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private scheduleTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (!this.config.enabled) return
    const ms = Math.max(1, this.config.intervalMin) * 60 * 1000
    this.timer = setInterval(() => void this.runCycle(), ms)
  }

  getStatus() {
    return {
      config: this.config,
      enabled: this.config.enabled,
      live: this.config.live,
      running: this.running,
      cycles: this.cycles,
      lastRunTs: this.lastRunTs,
      nextRunTs: this.config.enabled && this.lastRunTs ? this.lastRunTs + this.config.intervalMin * 60 : null,
      lastError: this.lastError,
      // the actual URL a cycle will call RIGHT NOW (after APP_URL/config/
      // default resolution) - shown directly so there's no guessing whether
      // an env var or a saved config value is the one actually in effect.
      resolvedAppUrl: resolveAppUrl(this.config),
      // which providers THIS process currently sees as enabled/ready - the
      // direct way to check "did it actually pick up the shared .env"
      // instead of guessing from the cycle error message alone. Only the
      // FALLBACK path (see callLlm()) - the primary path's providers live
      // in the app process, not here.
      llm: providerStatus(),
    }
  }

  configure(patch: Partial<AiTraderConfig>): AiTraderConfig {
    this.config = { ...this.config, ...patch }
    this.store.saveAiTraderConfig(this.config)
    this.scheduleTimer()
    this.emit('info', `AI Trader config updated - ${this.config.enabled ? 'enabled' : 'disabled'} · ${this.config.live ? 'LIVE' : 'shadow'} · ${this.config.asset} ${this.config.tf} · every ${this.config.intervalMin}min`)
    return this.config
  }

  listDecisions(limit = 100): AiTraderDecision[] {
    return this.store.listAiTraderDecisions(limit) as AiTraderDecision[]
  }

  /** User-initiated "clear log" - wipes the whole decision history, not a
   * size-bound prune. Does not touch config/cycles/running state. */
  clearDecisions(): void {
    this.store.clearAiTraderDecisions()
    this.emit('info', 'AI Trader decision log cleared')
  }

  /** Manual trigger - the UI's "run a cycle now" button, and how this gets
   * tested without waiting out a real interval. Runs the exact same path
   * runCycle's timer calls, just on demand. */
  async runNow(): Promise<{ ok: boolean; decision?: AiTraderDecision; error?: string }> {
    try {
      const d = await this.runCycle()
      return d ? { ok: true, decision: d } : { ok: false, error: this.lastError ?? 'cycle did not produce a decision' }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  }

  /** Best-effort recent track record for THIS asset+tf, folded into the
   * prompt so the model isn't reasoning in a vacuum about its own past
   * calls - open positions are excluded (no outcome yet), settled ones
   * contribute win/loss. Never throws; a store/position lookup failure
   * just means an empty record, not a broken cycle. */
  private recentRecord(asset: string, tf: string): { wins: number; losses: number; open: number } {
    let wins = 0
    let losses = 0
    let open = 0
    try {
      const rows = this.store
        .listAiTraderDecisions(50)
        .filter((r) => r.asset === asset && r.tf === tf && r.acted && r.positionId)
      for (const r of rows) {
        const pos = this.store.getPosition(r.positionId as string)
        if (!pos) continue
        if (pos.status === 'open') open += 1
        else if ((pos.pnl ?? 0) > 0) wins += 1
        else losses += 1
      }
    } catch {
      // best-effort only
    }
    return { wins, losses, open }
  }

  private async runCycle(): Promise<AiTraderDecision | null> {
    if (this.running) return null // reentrancy guard - see field comment
    this.running = true
    const ts = Math.floor(Date.now() / 1000)
    this.lastRunTs = ts
    this.cycles += 1
    const { asset, tf } = this.config
    try {
      const meta = this.metaStrategyService()
      const snapshot = meta ? meta.snapshotSources(asset, tf) : []
      let price = 0
      try {
        price = this.market.getPrice(asset)
      } catch {
        price = 0
      }
      const record = this.recentRecord(asset, tf)

      // Raw candles - the model does its OWN read of price action here,
      // it is not just tallying what other predictors already concluded.
      // Need enough bars to cover both a real ATR(14) and the longest
      // expiry choice's lookback window, with headroom.
      const tfSec = tfSeconds(tf)
      const longestExpiryBars = Math.max(1, ...this.config.expiryChoices.map((m) => Math.round((m * 60) / tfSec)))
      const candleLimit = Math.max(80, longestExpiryBars * 4 + 30)
      let candles: Candle[] = []
      try {
        candles = this.market.getCandles(asset, tf, candleLimit, true)
      } catch {
        candles = []
      }

      const closePrices = closes(candles)
      const highPrices = highs(candles)
      const lowPrices = lows(candles)
      const atrSeries = closePrices.length >= 15 ? atr(highPrices, lowPrices, closePrices, 14) : []
      const atrLast = atrSeries.length ? atrSeries[atrSeries.length - 1] : 0
      const atrPct = price > 0 && atrLast > 0 ? (atrLast / price) * 100 : 0
      const rsiSeries = closePrices.length >= 15 ? rsi(closePrices, 14) : []
      const rsiLast = rsiSeries.length ? rsiSeries[rsiSeries.length - 1] : 50
      const ema9Series = closePrices.length >= 9 ? ema(closePrices, 9) : []
      const ema21Series = closePrices.length >= 21 ? ema(closePrices, 21) : []
      const ema9Last = ema9Series.length ? ema9Series[ema9Series.length - 1] : price
      const ema21Last = ema21Series.length ? ema21Series[ema21Series.length - 1] : price

      const horizons = closePrices.length ? buildHorizonReads(closePrices, tfSec, this.config.expiryChoices, atrPct) : []
      const horizonLines = horizons.length
        ? horizons
            .map(
              (h) =>
                `- ${h.expiryMin}min expiry (~${h.bars} x ${tf} bars): net move over that exact window ${h.momentumPct >= 0 ? '+' : ''}${h.momentumPct.toFixed(3)}% (${h.upBars} up-bars / ${h.downBars} down-bars), signal-to-noise ${h.snr.toFixed(2)}x` +
                (h.snr >= 1 ? ' (drift exceeds typical noise for this window - a real move, not just chop)' : h.snr >= 0.5 ? ' (borderline - could be either)' : ' (well within noise - likely just chop, not a trend)')
            )
            .join('\n')
        : '- (not enough candle history yet to compute per-expiry reads - plugin still warming up)'

      // Last ~24 closes, oldest first, so the model can see the actual shape
      // of recent price action with its own eyes instead of only a verdict.
      const recentCloses = closePrices.slice(-24).map((v) => v.toFixed(5)).join(', ')

      const snapshotLines = snapshot.length
        ? snapshot.map((r) => `- ${r.label}`).join('\n')
        : '- (no reference reads available - thin history or plugins still warming up)'

      const system: ChatMessage = {
        role: 'system',
        content: [
          'You are the AI Trader inside IQAIR//OS, a binary-options trading platform - and your role here is',
          'specifically the HUMAN sitting at the desk, not one more system running alongside the others. This',
          'platform already has a whole desk of analysts, predictors and watchers working for you (the panel',
          "reads below) - a real trader doesn't blindly obey their analysts either. They listen to what the desk",
          'says, form their OWN independent read of the actual price action, weigh the two together, and THEN',
          'decide: which way, how big a window, and whether this is even a moment worth trading at all. That',
          'full decision - direction, expiry, and trade-or-skip, together, as one judgment call - is your job.',
          'You are allowed, and expected, to disagree with your own desk when your own read of the price action',
          'says something different, exactly like a human trader would override a system he built himself.',
          '',
          'A mechanical confluence vote across that same panel already exists elsewhere in this platform',
          '(Meta-Strategy/Meta-Trader) - that is NOT your job, and just restating or averaging their labels back',
          'is not a trade decision, it is exactly the "just another bot" behavior you are explicitly here to not be.',
          'A binary option only pays out on where price is AT THE EXACT EXPIRY you pick, not on a generic bias, so',
          'a decision that ignores the specific window it will be judged on is not a real decision either.',
          '',
          'Your job each cycle:',
          '1. Read the raw recent closes and the per-expiry-choice momentum/signal-to-noise reads below yourself -',
          '   this is your OWN analysis, your primary evidence. Form a real view of the actual short-term price',
          '   action: is it trending, ranging, exhausting a move, reversing? Do not just restate the numbers back.',
          "2. Then bring in the desk's panel reads as a second opinion, not a vote to average into yours. If they",
          '   agree with your own read, that raises your conviction, same as a trader feeling better about a call',
          '   when the room agrees with him. If they conflict, you decide whose read you trust more for THIS',
          '   moment - you are allowed to override the desk and go with your own analysis, or to defer to them',
          '   and lower your own confidence, or to conclude the disagreement itself means skip. State which you',
          '   did and why.',
          '3. Decide direction and expiry together, not independently - look at the per-expiry reads below and',
          '   choose the ONE expiry (from the allowed list) where your own analysis is clearest and the',
          '   signal-to-noise is least ambiguous for THAT specific holding period. A read that looks strong at',
          "   one expiry can be noise at another - do not pick an expiry just because it's listed first.",
          '4. Decide whether this moment is even worth trading. Precision matters more than frequency - you are',
          '   not required to trade every cycle, and most cycles SHOULD be a skip, the same way a real trader',
          '   spends most of a session watching and waiting, not firing on every tick. Only call/put when you',
          '   would genuinely expect to be right most of the time at that confidence level. Being honestly',
          '   uncertain and skipping beats a confident-sounding guess that is wrong half the time.',
          '',
          'Respond with ONLY a JSON object, no prose outside it, in exactly this shape:',
          '{"direction": "call" | "put" | "skip", "confidence": 0-100, "expiryMin": <the ONE allowed choice your analysis is clearest on>, "reasoning": "<2-4 sentences: your own read of the price action, how it specifically supports a move completing within the chosen expiry, and whether you sided with or against the desk and why>"}',
        ].join('\n'),
      }
      const user: ChatMessage = {
        role: 'user',
        content: [
          `Asset: ${asset}   Timeframe: ${tf}   Current price: ${price || 'unavailable'}`,
          `Trend context: EMA9 ${ema9Last.toFixed(5)} vs EMA21 ${ema21Last.toFixed(5)} (${ema9Last > ema21Last ? 'short-term above long-term - up-bias' : ema9Last < ema21Last ? 'short-term below long-term - down-bias' : 'flat'}), RSI14 ${rsiLast.toFixed(1)}, ATR14 ${atrPct.toFixed(4)}% of price (volatility regime).`,
          `Recent closes, oldest -> newest (${closePrices.length ? closePrices.length : 0} bars available, showing last ${Math.min(24, closePrices.length)}): ${recentCloses || '(none yet)'}`,
          '',
          'Per-expiry-choice reads (computed directly from the candles above - this is YOUR analysis to build on):',
          horizonLines,
          '',
          `Allowed expiry choices (minutes): ${this.config.expiryChoices.join(', ')} - you must pick exactly one of these.`,
          `Your own recent record on this exact asset+tf: ${record.wins}W / ${record.losses}L settled, ${record.open} still open.`,
          '',
          "The desk's panel reads (second opinion, not a vote - see system instructions on when to defer to this vs override it):",
          snapshotLines,
          '',
          `Minimum confidence to actually act: ${this.config.minConfidence} (a lower confidence will be treated as a skip regardless of direction, so be honest rather than inflating it).`,
        ].join('\n'),
      }

      let content: string
      let provider = ''
      let model = ''
      try {
        const res = await callLlm(resolveAppUrl(this.config), [system, user], { temperature: 0.3, maxTokens: 700, timeoutMs: 45_000 })
        content = res.content
        provider = res.provider
        model = res.model
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err)
        this.lastError = msg
        this.store.recordAiTraderDecision({
          asset, tf, direction: 'skip', confidence: 0, reasoning: `LLM call failed: ${msg}`,
          snapshot, live: this.config.live, acted: false, error: msg, ts,
        })
        this.emit('warn', `AI Trader cycle failed on ${asset} ${tf}: ${msg}`)
        return null
      }

      const parsed = parseDecision(content, this.config.expiryChoices)
      if (!parsed) {
        this.lastError = 'model reply was not parseable JSON'
        this.store.recordAiTraderDecision({
          asset, tf, direction: 'skip', confidence: 0, reasoning: `unparseable model reply: ${content.slice(0, 300)}`,
          snapshot, live: this.config.live, acted: false, provider, model, error: 'unparseable reply', ts,
        })
        this.emit('warn', `AI Trader got an unparseable reply on ${asset} ${tf} - treated as skip`)
        return null
      }
      this.lastError = null

      // the floor is enforced HERE, not just suggested in the prompt - a
      // model that talks itself into high confidence on a weak setup still
      // gets overridden if the operator's own floor says no
      let direction = parsed.direction
      if (direction !== 'skip' && parsed.confidence < this.config.minConfidence) {
        direction = 'skip'
      }

      let acted = false
      let positionId: string | null = null
      let actionError: string | undefined

      if (direction !== 'skip' && this.config.live) {
        const out = await this.exec.placeOrder({
          asset,
          tf,
          side: direction,
          kind: this.config.kind,
          amount: this.config.stake,
          expirySec: minToSec(parsed.expiryMin),
          mode: this.exec.accountSource === 'iq' ? 'live' : 'paper',
          strategy: 'ai-trader',
          note: 'ai-trader',
        })
        if (out.ok && out.position) {
          acted = true
          positionId = out.position.id
          this.emit('success', `[AI Trader] ${direction.toUpperCase()} ${asset} $${this.config.stake} @ ${parsed.expiryMin}min - ${parsed.reasoning} (confidence ${parsed.confidence.toFixed(0)}%)`)
        } else {
          actionError = out.error ?? 'order rejected'
          this.emit('warn', `[AI Trader] wanted ${direction.toUpperCase()} ${asset} but the order was rejected: ${actionError}`)
        }
      } else if (direction !== 'skip') {
        // shadow mode - a real decision, logged, but no order placed
        this.emit('info', `[AI Trader][SHADOW] would ${direction.toUpperCase()} ${asset} $${this.config.stake} @ ${parsed.expiryMin}min - ${parsed.reasoning} (confidence ${parsed.confidence.toFixed(0)}%)`)
      }

      this.store.recordAiTraderDecision({
        asset, tf, direction, confidence: parsed.confidence, expiryMin: parsed.expiryMin,
        reasoning: parsed.reasoning, snapshot, live: this.config.live, acted, positionId: positionId ?? undefined,
        provider, model, error: actionError, ts,
      })

      const rows = this.store.listAiTraderDecisions(1)
      return (rows[0] as AiTraderDecision) ?? null
    } finally {
      this.running = false
    }
  }

  private emit(level: 'info' | 'warn' | 'danger' | 'success', message: string): void {
    this.ctx.bus.emit('alert', { level, message, ts: Math.floor(Date.now() / 1000) })
  }
}

export const aiTraderPlugin: Plugin = {
  name: 'ai-trader',
  start: async (ctx) => {
    const svc = new AiTraderService()
    await svc.start(ctx)
    ctx.provide('aiTrader', svc)
  },
}
