// IQAIR//OS - CFD Trader plugin
//
// The other traders (auto, meta, omni, brain) are built around fixed-expiry options. This one trades CFDs / forex: it needs a direction AND an
// entry, a stop-loss, a take-profit, a position size that respects risk, and trade management after entry. Signal sources:
//   - 'plan'          : analytics/cfdplan.ts readCfdPlan() directly (the same thing story.cfd() exposes to MSL) - cause->effect predicted move +
//                       higher-timeframe blend, stop beyond structure, target at the next level or minimum RR.
//   - 'meta-strategy' : a saved MSL script (plugins/metastrategy.ts). The script decides call/put; its `pos.stop` / `pos.target` / `pos.breakeven`
//                       / `pos.trail` / `pos.size` directives set the levels (absolute prices). A script that sets none falls back to the plan's levels.
// SIZING (switchable): 'risk' = risk `riskPct`% of equity on the stop distance (margin = units x entry / leverage); 'margin' = a fixed margin.
// PAPER and LIVE are the same code path: ExecutionService.placeOrder(kind 'cfd', mode) - the kill switch, risk manager, max-open and daily limits
// below every caller still apply. Gated by the global OS mode (must be 'auto') exactly like Meta/Omni trader.
// MANAGEMENT: paper positions get breakeven (stop to entry after +breakevenR) and an ATR trail by rewriting the position's % stop; LIVE positions
// keep the SL/TP sent at entry (the broker owns them). The engine's own TP/SL/margin-call sweep closes positions.
// HONESTY: nothing here has a measured edge. Run /cfd_backtest first.

import type { Plugin, KernelContext } from '../kernel'
import type { Store } from '../store'
import type { Position, Timeframe } from '../types'
import { ALL_TIMEFRAMES } from '../types'
import type { MarketDataService } from './market-data'
import type { ExecutionService } from './execution'
import type { MetaStrategyService } from './metastrategy'
import { readCfdPlan, cfdSize, type CfdPlan } from '../analytics/cfdplan'

export const CFD_NOTE = 'cfd-trader'
export type CfdSource = 'plan' | 'meta-strategy'

export interface CfdTraderConfig {
  enabled: boolean
  mode: 'paper' | 'live'
  source: CfdSource
  metaStrategyId?: string
  tf: Timeframe
  htfTf: string
  assets: string[]            // empty = default forex majors that are open
  sizing: 'risk' | 'margin'
  riskPct: number             // % of equity risked per trade (sizing 'risk')
  fixedMargin: number         // margin per trade (sizing 'margin')
  leverage: number            // desired; clamped by the asset's max and by stop distance (never past the margin-call line)
  maxMarginPct: number        // cap on margin per trade as % of equity
  maxOpen: number
  perAssetMax: number
  cooldownSec: number
  minStrength: number         // 0-100
  minRR: number
  minEv: number               // expected R
  dailyLossStopPct: number    // stop opening trades once today's P/L <= -this % of day-start balance (0 = off)
  maxDailyTrades: number
  breakevenR: number          // move stop to entry after this many R in profit (0 = off)
  trailAtr: number            // ATR trail distance once in profit (0 = off)
}

export const DEFAULT_CFD_TRADER: CfdTraderConfig = {
  enabled: false, mode: 'paper', source: 'plan', tf: '1m', htfTf: '5m', assets: [],
  sizing: 'risk', riskPct: 1, fixedMargin: 50, leverage: 10, maxMarginPct: 25,
  maxOpen: 3, perAssetMax: 1, cooldownSec: 300, minStrength: 45, minRR: 1.5, minEv: 0,
  dailyLossStopPct: 3, maxDailyTrades: 20, breakevenR: 1, trailAtr: 0,
}

const DEFAULT_ASSETS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'EURJPY', 'GBPJPY', 'NZDUSD']

interface Decision { ts: number; asset: string; action: 'opened' | 'skipped' | 'rejected'; reason: string; plan?: Partial<CfdPlan>; margin?: number; units?: number; positionId?: string }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb)

export function sanitizeCfdConfig(raw: Record<string, unknown>, base: CfdTraderConfig): CfdTraderConfig {
  const c = { ...base }
  if (typeof raw.enabled === 'boolean') c.enabled = raw.enabled
  if (raw.mode === 'paper' || raw.mode === 'live') c.mode = raw.mode
  if (raw.source === 'plan' || raw.source === 'meta-strategy') c.source = raw.source
  if (typeof raw.metaStrategyId === 'string') c.metaStrategyId = raw.metaStrategyId.trim() || undefined
  if (typeof raw.tf === 'string' && (ALL_TIMEFRAMES as readonly string[]).includes(raw.tf)) c.tf = raw.tf as Timeframe
  if (typeof raw.htfTf === 'string' && (raw.htfTf === 'none' || (ALL_TIMEFRAMES as readonly string[]).includes(raw.htfTf))) c.htfTf = raw.htfTf
  if (Array.isArray(raw.assets)) c.assets = raw.assets.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean).slice(0, 40)
  if (raw.sizing === 'risk' || raw.sizing === 'margin') c.sizing = raw.sizing
  if (raw.riskPct !== undefined) c.riskPct = clamp(num(raw.riskPct, c.riskPct), 0.05, 10)
  if (raw.fixedMargin !== undefined) c.fixedMargin = clamp(num(raw.fixedMargin, c.fixedMargin), 1, 1e6)
  if (raw.leverage !== undefined) c.leverage = clamp(Math.round(num(raw.leverage, c.leverage)), 1, 500)
  if (raw.maxMarginPct !== undefined) c.maxMarginPct = clamp(num(raw.maxMarginPct, c.maxMarginPct), 1, 100)
  if (raw.maxOpen !== undefined) c.maxOpen = clamp(Math.round(num(raw.maxOpen, c.maxOpen)), 1, 20)
  if (raw.perAssetMax !== undefined) c.perAssetMax = clamp(Math.round(num(raw.perAssetMax, c.perAssetMax)), 1, 5)
  if (raw.cooldownSec !== undefined) c.cooldownSec = clamp(Math.round(num(raw.cooldownSec, c.cooldownSec)), 0, 86400)
  if (raw.minStrength !== undefined) c.minStrength = clamp(num(raw.minStrength, c.minStrength), 0, 100)
  if (raw.minRR !== undefined) c.minRR = clamp(num(raw.minRR, c.minRR), 0.5, 10)
  if (raw.minEv !== undefined) c.minEv = clamp(num(raw.minEv, c.minEv), -1, 5)
  if (raw.dailyLossStopPct !== undefined) c.dailyLossStopPct = clamp(num(raw.dailyLossStopPct, c.dailyLossStopPct), 0, 100)
  if (raw.maxDailyTrades !== undefined) c.maxDailyTrades = clamp(Math.round(num(raw.maxDailyTrades, c.maxDailyTrades)), 1, 500)
  if (raw.breakevenR !== undefined) c.breakevenR = clamp(num(raw.breakevenR, c.breakevenR), 0, 10)
  if (raw.trailAtr !== undefined) c.trailAtr = clamp(num(raw.trailAtr, c.trailAtr), 0, 10)
  return c
}

export class CfdTraderService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private store!: Store
  private exec!: ExecutionService
  config: CfdTraderConfig = { ...DEFAULT_CFD_TRADER }
  private timer: ReturnType<typeof setInterval> | null = null
  private mgmtTimer: ReturnType<typeof setInterval> | null = null
  private unsub: (() => void) | null = null
  private ticking = false
  private cooldownUntil = new Map<string, number>()
  private log: Decision[] = []
  private stats = { opened: 0, closed: 0, wins: 0, losses: 0, pnl: 0, lastReason: '' }
  private dayKey = ''
  private dayTrades = 0

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.store = ctx.use<Store>('store')
    this.exec = ctx.use<ExecutionService>('execution')
    try { const saved = this.store.getCfdTraderConfig() as Record<string, unknown> | null; if (saved) this.config = sanitizeCfdConfig(saved, DEFAULT_CFD_TRADER) } catch { /* defaults */ }
    this.unsub = ctx.bus.on('positionClosed', ({ position }) => this.onClosed(position))
    this.timer = setInterval(() => { void this.tick().catch((e) => ctx.log('cfd-trader', `tick failed: ${(e as Error).message}`)) }, 15_000)
    this.mgmtTimer = setInterval(() => { try { this.manage() } catch { /* next pass */ } }, 5_000)
    ctx.log('cfd-trader', 'cfd trader online (sources: plan, meta-strategy; sizing risk%/fixed margin; paper = live path)')
  }

  stop(): void {
    this.unsub?.()
    if (this.timer) clearInterval(this.timer)
    if (this.mgmtTimer) clearInterval(this.mgmtTimer)
    this.timer = this.mgmtTimer = null
  }

  private now(): number { return Math.floor(Date.now() / 1000) }

  configure(patch: Record<string, unknown>): CfdTraderConfig {
    this.config = sanitizeCfdConfig(patch, this.config)
    this.store.saveCfdTraderConfig(this.config)
    return this.config
  }

  private osMode(): string {
    try { return this.ctx.use<{ status(): { mode: string } }>('mode').status().mode } catch { return 'human' }
  }

  private mine(p: Position): boolean { return p.kind === 'cfd' && !!p.note?.startsWith(CFD_NOTE) }
  private openMine(): Position[] { try { return this.store.listPositions('open', 500).filter((p) => this.mine(p)) } catch { return [] } }

  private onClosed(p: Position): void {
    if (!this.mine(p)) return
    this.stats.closed++
    const pnl = p.pnl ?? 0
    this.stats.pnl += pnl
    if (pnl > 0) this.stats.wins++; else if (pnl < 0) this.stats.losses++
    this.cooldownUntil.set(p.asset, this.now() + this.config.cooldownSec)
  }

  private candles(asset: string, tf: string) {
    return this.market.getCandlesDeep(asset, tf as Timeframe, 300, true).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
  }

  private ticksFor(asset: string): { ts: number; price: number }[] | undefined {
    try { const t = this.ctx.use<{ ticksFor(a: string): { ts: number; price: number }[] | null }>('otcFootprint').ticksFor(asset); return t && t.length ? t : undefined } catch { return undefined }
  }

  /** The plan for one asset under the current source. Pure read, places nothing - also what /cfd_plan serves. */
  plan(asset: string): { plan: CfdPlan; source: CfdSource; note: string } {
    const cfg = this.config
    const cs = this.candles(asset, cfg.tf)
    const htf = cfg.htfTf !== 'none' ? this.candles(asset, cfg.htfTf) : null
    const base = readCfdPlan(cs, this.ticksFor(asset), htf, { htfTf: cfg.htfTf, minRR: cfg.minRR })
    if (cfg.source !== 'meta-strategy' || !cfg.metaStrategyId) return { plan: base, source: 'plan', note: base.text }
    const ms = this.ctx.use<MetaStrategyService>('metaStrategy')
    const ev = ms.evaluate(cfg.metaStrategyId, asset, cfg.tf)
    const r = ev.result
    const price = ev.price || base.entry
    if (r.direction === 'none' || !Number.isFinite(price) || price <= 0) return { plan: { ...base, ok: false, direction: 'none', text: r.notes }, source: 'meta-strategy', note: r.notes }
    const long = r.direction === 'call'
    const atr = Number.isFinite(base.atr) && base.atr > 0 ? base.atr : price * 0.001
    const sOk = (v: number | undefined) => v !== undefined && Number.isFinite(v) && (long ? v < price : v > price)
    const tOk = (v: number | undefined) => v !== undefined && Number.isFinite(v) && (long ? v > price : v < price)
    // script levels win; a missing / wrong-side level falls back to the plan's (same direction) or ATR defaults
    const sameDir = base.ok && base.direction === r.direction
    const stop = sOk(r.entry?.stop) ? (r.entry!.stop as number) : sameDir ? base.stop : long ? price - 1.5 * atr : price + 1.5 * atr
    const stopDist = Math.abs(price - stop)
    const target = tOk(r.entry?.target) ? (r.entry!.target as number) : sameDir ? base.target : long ? price + cfg.minRR * stopDist : price - cfg.minRR * stopDist
    const rewardDist = Math.abs(target - price)
    const rr = stopDist > 0 ? rewardDist / stopDist : 0
    const prob = clamp(0.5 + (r.confidence / 100) * 0.25, 0.5, 0.8) // script confidence has no calibrated probability: a coarse, honest-ish mapping
    const plan: CfdPlan = { ...base, ok: true, direction: r.direction, entry: price, stop, target, riskDist: stopDist, rewardDist, riskAtr: stopDist / atr, rewardAtr: rewardDist / atr, rr, prob, strength: r.confidence, ev: prob * rr - (1 - prob), atr, stopKind: sOk(r.entry?.stop) ? 'structure' : 'atr', targetKind: tOk(r.entry?.target) ? 'structure' : 'rr', text: `${r.notes} | RR ${rr.toFixed(2)}` }
    return { plan, source: 'meta-strategy', note: r.notes }
  }

  private pool(): string[] {
    const open = new Set(this.market.listAssets().filter((a) => a.open).map((a) => a.ticker))
    return (this.config.assets.length ? this.config.assets : DEFAULT_ASSETS).filter((a) => open.has(a))
  }

  private note(d: Decision): void { this.log.unshift(d); if (this.log.length > 200) this.log.length = 200; this.stats.lastReason = `${d.asset}: ${d.reason}` }

  private equity(): number {
    const a = this.exec.account()
    return this.config.mode === 'live' && a.liveBalance != null ? a.liveBalance : a.balance
  }

  async tick(): Promise<void> {
    if (!this.config.enabled || this.ticking) return
    if (this.osMode() !== 'auto') { this.stats.lastReason = 'OS mode is not AUTO - standing down'; return }
    this.ticking = true
    try { await this.scan() } finally { this.ticking = false }
  }

  /** One pass over the pool. Exposed for tests and the "scan now" button. */
  async scan(): Promise<Decision[]> {
    const cfg = this.config, out: Decision[] = []
    const acct = this.exec.account()
    const dk = String(acct.dayKey)
    if (dk !== this.dayKey) { this.dayKey = dk; this.dayTrades = 0 }
    if (cfg.dailyLossStopPct > 0 && acct.dayStartBalance > 0 && acct.dayPnl <= -(acct.dayStartBalance * cfg.dailyLossStopPct) / 100) { this.stats.lastReason = `daily loss stop hit (${acct.dayPnl.toFixed(2)})`; return out }
    if (this.dayTrades >= cfg.maxDailyTrades) { this.stats.lastReason = 'max daily trades reached'; return out }
    let open = this.openMine()
    for (const asset of this.pool()) {
      if (open.length >= cfg.maxOpen) break
      if ((this.cooldownUntil.get(asset) ?? 0) > this.now()) continue
      if (open.filter((p) => p.asset === asset).length >= cfg.perAssetMax) continue
      let p: ReturnType<CfdTraderService['plan']>
      try { p = this.plan(asset) } catch (e) { continue }
      const plan = p.plan
      const skip = (reason: string) => { const d: Decision = { ts: this.now(), asset, action: 'skipped', reason, plan: { direction: plan.direction, rr: plan.rr, prob: plan.prob, ev: plan.ev, strength: plan.strength } }; if (plan.direction !== 'none') this.note(d); return d }
      if (!plan.ok || plan.direction === 'none') continue
      if (plan.strength < cfg.minStrength) { out.push(skip(`strength ${plan.strength.toFixed(0)} < ${cfg.minStrength}`)); continue }
      if (plan.rr < cfg.minRR) { out.push(skip(`RR ${plan.rr.toFixed(2)} < ${cfg.minRR}`)); continue }
      if (plan.ev < cfg.minEv) { out.push(skip(`EV ${plan.ev.toFixed(2)}R < ${cfg.minEv}`)); continue }
      const d = await this.place(asset, plan, p.source)
      out.push(d); this.note(d)
      if (d.action === 'opened') open = this.openMine()
    }
    return out
  }

  /** Size + send one plan. Stop/target are converted from prices to the engine's percent-of-entry unit. */
  async place(asset: string, plan: CfdPlan, source: CfdSource): Promise<Decision> {
    const cfg = this.config
    const fail = (action: Decision['action'], reason: string): Decision => ({ ts: this.now(), asset, action, reason, plan: { direction: plan.direction, rr: plan.rr, prob: plan.prob, ev: plan.ev } })
    const info = this.market.listAssets().find((a) => a.ticker === asset)
    if (!info) return fail('rejected', 'unknown asset')
    const slPct = (plan.riskDist / plan.entry) * 100, tpPct = (plan.rewardDist / plan.entry) * 100
    if (!(slPct > 0) || !(tpPct > 0)) return fail('rejected', 'degenerate stop/target')
    // never let leverage put the margin-call line (-100% of margin) inside the stop: need slPct x lev < 90
    const maxLev = Math.max(1, Math.min(info.leverage ?? 30, 500))
    const lev = Math.min(cfg.leverage, maxLev, Math.floor(90 / slPct))
    if (lev < 1) return fail('rejected', `stop ${slPct.toFixed(2)}% too wide for any leverage`)
    const sz = cfdSize({ mode: cfg.sizing, equity: this.equity(), riskPct: cfg.riskPct, fixedMargin: cfg.fixedMargin, leverage: lev, entry: plan.entry, stopDist: plan.riskDist, maxMarginPct: cfg.maxMarginPct })
    if (sz.margin < 1) return fail('rejected', `margin ${sz.margin.toFixed(2)} below the 1 minimum`)
    const res = await this.exec.placeOrder({ asset, tf: cfg.tf, side: plan.direction as 'call' | 'put', kind: 'cfd', amount: sz.margin, mode: cfg.mode, leverage: lev, tp: Number(tpPct.toFixed(4)), sl: Number(slPct.toFixed(4)), strategy: 'cfd-trader', note: `${CFD_NOTE}:${source} rr=${plan.rr.toFixed(2)} p=${(plan.prob * 100).toFixed(0)}% risk0=${slPct.toFixed(4)} risk=${sz.riskAmount.toFixed(2)}${sz.capped ? ' (margin-capped)' : ''}` })
    if (!res.ok || !res.position) return fail('rejected', res.error ?? 'order refused')
    this.stats.opened++; this.dayTrades++
    this.cooldownUntil.set(asset, this.now() + cfg.cooldownSec)
    return { ts: this.now(), asset, action: 'opened', reason: plan.text, plan: { direction: plan.direction, entry: plan.entry, stop: plan.stop, target: plan.target, rr: plan.rr, prob: plan.prob, ev: plan.ev }, margin: sz.margin, units: sz.units, positionId: res.position.id }
  }

  /** Breakeven + ATR trail on OPEN PAPER positions (live keeps its broker-side SL/TP). The engine's sl is % adverse move from entry; a negative sl
   * means the stop sits in profit (checkMargin: movePct <= -sl). */
  manage(): void {
    const cfg = this.config
    if (cfg.breakevenR <= 0 && cfg.trailAtr <= 0) return
    for (const p of this.openMine()) {
      if (p.mode !== 'paper' || p.sl === undefined) continue
      let price: number; try { price = this.market.getPrice(p.asset) } catch { continue }
      if (!(price > 0)) continue
      const dir = p.side === 'call' ? 1 : -1
      const movePct = ((price - p.entryPrice) / p.entryPrice) * 100 * dir
      const initSl = (() => { const m = /risk0=([\d.]+)/.exec(p.note ?? ''); return m ? Number(m[1]) : p.sl })()
      let newSl = p.sl
      if (cfg.breakevenR > 0 && movePct >= cfg.breakevenR * Math.abs(initSl) && newSl > 0) newSl = 0
      if (cfg.trailAtr > 0) {
        try {
          const cs = this.candles(p.asset, p.tf)
          const trs = cs.slice(-15).map((c, i, a) => (i ? Math.max(c.high - c.low, Math.abs(c.high - a[i - 1].close), Math.abs(c.low - a[i - 1].close)) : c.high - c.low)).slice(1)
          const atr = trs.reduce((s, v) => s + v, 0) / Math.max(1, trs.length)
          const trailPct = ((cfg.trailAtr * atr) / price) * 100
          if (movePct > trailPct) newSl = Math.min(newSl, -(movePct - trailPct)) // stop locks in profit, only ever tightens
        } catch { /* keep */ }
      }
      if (newSl < p.sl - 1e-9) this.store.updateCfdLevels(p.id, { sl: Number(newSl.toFixed(4)) })
    }
  }

  status() {
    const open = this.openMine()
    return { enabled: this.config.enabled, osMode: this.osMode(), config: this.config, stats: this.stats, openCount: open.length, open, dayTrades: this.dayTrades, equity: this.equity(), pool: this.pool() }
  }

  decisions(limit = 50): Decision[] { return this.log.slice(0, limit) }

  /** Close every position this trader opened. */
  closeAll(): number { let n = 0; for (const p of this.openMine()) if (this.exec.closePosition(p.id, { force: true }).ok) n++; return n }
}

export const cfdTraderPlugin: Plugin = {
  name: 'cfd-trader',
  start: async (ctx) => {
    const svc = new CfdTraderService()
    ctx.provide('cfdTrader', svc)
    inst = svc
    await svc.start(ctx)
  },
  stop: async () => { inst?.stop(); inst = null },
}
let inst: CfdTraderService | null = null
