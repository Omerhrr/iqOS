// IQAIR//OS - Alert Rules plugin (DISCOVERY layer)
// User-programmable market watchers. Each rule binds an instrument + timeframe
// to a trigger (price cross, signal score, RSI/ADX extremes, ATR burst, Markov
// regime, candlestick pattern) and fires an OS alert when the condition is met.
// Price rules evaluate on every tick for immediacy; everything else evaluates
// on closed candles through the screener's lightweight snapshot so triggers are
// never based on half-formed bars. The global risk manager is untouched - rules
// only notify, they never trade.

import type { Timeframe } from '../types'
import type { KernelContext, Plugin } from '../kernel'
import type { MarketDataService } from './market-data'
import type { ScreenerService, ScreenRow } from './screener'
import { Store } from '../store'

export type AlertMetric =
  | 'price_above'
  | 'price_below'
  | 'score_call' // composite score >= value AND direction call
  | 'score_put' // composite score <= -value AND direction put
  | 'score_abs' // |score| >= value, either direction
  | 'rsi_above'
  | 'rsi_below'
  | 'adx_above' // trend strength breakout
  | 'atr_above' // ATR% volatility burst
  | 'regime' // value: bull | bear | range | chop
  | 'pattern_bull'
  | 'pattern_bear'

export const ALERT_METRICS: { metric: AlertMetric; label: string; needsValue: boolean; hint: string }[] = [
  { metric: 'price_above', label: 'Price crosses above', needsValue: true, hint: 'price level' },
  { metric: 'price_below', label: 'Price crosses below', needsValue: true, hint: 'price level' },
  { metric: 'score_call', label: 'Call signal strength ≥', needsValue: true, hint: 'score 0-100 (e.g. 60)' },
  { metric: 'score_put', label: 'Put signal strength ≥', needsValue: true, hint: 'score 0-100 (e.g. 60)' },
  { metric: 'score_abs', label: 'Either-direction signal ≥', needsValue: true, hint: 'score 0-100 (e.g. 55)' },
  { metric: 'rsi_above', label: 'RSI above', needsValue: true, hint: 'e.g. 70 overbought' },
  { metric: 'rsi_below', label: 'RSI below', needsValue: true, hint: 'e.g. 30 oversold' },
  { metric: 'adx_above', label: 'ADX above (trend ignition)', needsValue: true, hint: 'e.g. 25' },
  { metric: 'atr_above', label: 'ATR% above (vol burst)', needsValue: true, hint: 'e.g. 0.15' },
  { metric: 'regime', label: 'Markov regime becomes', needsValue: true, hint: 'bull | bear | range | chop' },
  { metric: 'pattern_bull', label: 'Any bullish candle pattern', needsValue: false, hint: '' },
  { metric: 'pattern_bear', label: 'Any bearish candle pattern', needsValue: false, hint: '' },
]

export interface AlertRule {
  id: string
  name: string
  enabled: boolean
  asset: string
  tf: Timeframe
  metric: AlertMetric
  value?: number
  note?: string
  cooldownSec: number
  oneShot: boolean
  lastFiredTs?: number
  fires: number
}

export const DEFAULT_RULE: Omit<AlertRule, 'id' | 'name' | 'asset'> = {
  enabled: true,
  tf: '1m',
  metric: 'score_abs',
  value: 60,
  cooldownSec: 300,
  oneShot: false,
  fires: 0,
}

interface RuntimeRule {
  rule: AlertRule
  lastEvalTs: number
}

const METRIC_LABEL: Record<AlertMetric, string> = Object.fromEntries(
  ALERT_METRICS.map((m) => [m.metric, m.label])
) as Record<AlertMetric, string>

export class AlertRulesService {
  private ctx!: KernelContext
  private store!: Store
  private market!: MarketDataService
  private screener!: ScreenerService
  private runtime = new Map<string, RuntimeRule>()
  private unsubscribers: (() => void)[] = []

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.store = ctx.use<Store>('store')
    this.market = ctx.use<MarketDataService>('market')
    this.screener = ctx.use<ScreenerService>('screener')

    for (const { rule } of this.store.listAlertRules()) this.runtime.set(rule.id, { rule, lastEvalTs: 0 })

    // price rules: every tick (cheap comparison) for immediate cross detection
    this.unsubscribers.push(
      ctx.bus.on('tick', ({ asset, price }) => {
        for (const { rule } of this.runtime.values()) {
          if (!rule.enabled) continue
          if (rule.asset !== asset) continue
          if (rule.metric !== 'price_above' && rule.metric !== 'price_below') continue
          this.checkPrice(rule, price)
        }
      }),
      // everything else: on closed candles via the screener snapshot
      ctx.bus.on('candle', ({ asset, tf, closed }) => {
        if (!closed) return
        void this.onCandleClose(asset, tf)
      })
    )
    ctx.log('alert-rules', `watch engine online - ${this.runtime.size} rules registered`)
  }

  stop(): void {
    for (const u of this.unsubscribers) u()
    this.unsubscribers = []
  }

  // ---------- CRUD ----------

  listRules(): AlertRule[] {
    return [...this.runtime.values()].map((r) => r.rule)
  }

  saveRule(input: Partial<AlertRule>): { ok: boolean; rule?: AlertRule; error?: string } {
    const id = input.id?.trim() || `rule-${Math.random().toString(36).slice(2, 8)}`
    const existing = this.runtime.get(id)?.rule
    const asset = String(input.asset ?? existing?.asset ?? '').toUpperCase().trim()
    if (!asset || !this.market.assets.some((a) => a.ticker === asset)) {
      return { ok: false, error: `unknown asset "${asset}"` }
    }
    const metric = (input.metric ?? existing?.metric ?? DEFAULT_RULE.metric) as AlertMetric
    if (!ALERT_METRICS.some((m) => m.metric === metric)) return { ok: false, error: `unknown metric ${metric}` }
    const def = ALERT_METRICS.find((m) => m.metric === metric)!
    let value: number | undefined = undefined
    if (def.needsValue) {
      value = Number(input.value ?? existing?.value ?? DEFAULT_RULE.value)
      if (!Number.isFinite(value)) return { ok: false, error: `${metric} needs a numeric value (${def.hint})` }
      if (metric === 'regime' && !['bull', 'bear', 'range', 'chop'].includes(String(input.value ?? existing?.value ?? ''))) {
        return { ok: false, error: 'regime must be one of bull | bear | range | chop' }
      }
      if (metric === 'regime') value = String(input.value ?? existing?.value) as unknown as number
    }
    const rule: AlertRule = {
      id,
      name: (input.name ?? existing?.name ?? `${asset} ${metric}`).trim().slice(0, 40),
      enabled: input.enabled ?? existing?.enabled ?? DEFAULT_RULE.enabled,
      asset,
      tf: (input.tf ?? existing?.tf ?? DEFAULT_RULE.tf) as Timeframe,
      metric,
      value,
      note: input.note !== undefined ? String(input.note).slice(0, 120) : existing?.note,
      cooldownSec: Math.max(0, Math.round(Number(input.cooldownSec ?? existing?.cooldownSec ?? DEFAULT_RULE.cooldownSec))),
      oneShot: input.oneShot ?? existing?.oneShot ?? DEFAULT_RULE.oneShot,
      lastFiredTs: existing?.lastFiredTs,
      fires: existing?.fires ?? 0,
    }
    this.store.saveAlertRule(rule)
    this.runtime.set(id, { rule, lastEvalTs: this.runtime.get(id)?.lastEvalTs ?? 0 })
    this.emit('info', `Alert rule "${rule.name}" saved - ${rule.enabled ? 'watching' : 'paused'} ${rule.asset} ${rule.tf} (${describe(rule)})`)
    return { ok: true, rule }
  }

  deleteRule(id: string): { ok: boolean; error?: string } {
    const ok = this.store.deleteAlertRule(id)
    if (ok) this.runtime.delete(id)
    return { ok, error: ok ? undefined : 'rule not found' }
  }

  toggleRule(id: string, enabled?: boolean): { ok: boolean; rule?: AlertRule; error?: string } {
    const rt = this.runtime.get(id)
    if (!rt) return { ok: false, error: 'rule not found' }
    rt.rule = { ...rt.rule, enabled: enabled ?? !rt.rule.enabled }
    this.store.saveAlertRule(rt.rule)
    this.emit('info', `Alert rule "${rt.rule.name}" ${rt.rule.enabled ? 'armed' : 'paused'}`)
    return { ok: true, rule: rt.rule }
  }

  // ---------- evaluation ----------

  private checkPrice(rule: AlertRule, price: number): void {
    const target = Number(rule.value)
    if (!Number.isFinite(target) || price <= 0) return
    const hit = rule.metric === 'price_above' ? price >= target : price <= target
    if (!hit) return
    this.fire(rule, `${rule.asset} ${rule.metric === 'price_above' ? 'crossed above' : 'crossed below'} ${fmtLevel(target)} (now ${fmtLevel(price)})`)
  }

  private onCandleClose(asset: string, tf: Timeframe): void {
    const rules = [...this.runtime.values()].filter(
      ({ rule }) => rule.enabled && rule.asset === asset && rule.tf === tf && rule.metric !== 'price_above' && rule.metric !== 'price_below'
    )
    if (!rules.length) return
    let row: ScreenRow | null = null
    try {
      row = this.screener.evaluate(asset, tf)
    } catch {
      return // thin history - skip this candle
    }
    if (!row) return
    for (const { rule } of rules) this.checkIndicator(rule, row)
  }

  private checkIndicator(rule: AlertRule, row: ScreenRow): void {
    const v = Number(rule.value)
    switch (rule.metric) {
      case 'score_call':
        if (row.direction === 'call' && row.score >= v) this.fire(rule, `${rule.asset} ${row.tf} CALL setup - score ${row.score.toFixed(0)}, confidence ${row.confidence}%`)
        break
      case 'score_put':
        if (row.direction === 'put' && Math.abs(row.score) >= v) this.fire(rule, `${rule.asset} ${row.tf} PUT setup - score ${row.score.toFixed(0)}, confidence ${row.confidence}%`)
        break
      case 'score_abs':
        if (Math.abs(row.score) >= v && row.direction !== 'none')
          this.fire(rule, `${rule.asset} ${row.tf} ${row.direction === 'call' ? 'CALL' : 'PUT'} setup - score ${row.score.toFixed(0)}, confidence ${row.confidence}%`)
        break
      case 'rsi_above':
        if (row.rsi >= v) this.fire(rule, `${rule.asset} ${row.tf} RSI ${row.rsi.toFixed(1)} (above ${v}) - overbought watch`)
        break
      case 'rsi_below':
        if (row.rsi <= v) this.fire(rule, `${rule.asset} ${row.tf} RSI ${row.rsi.toFixed(1)} (below ${v}) - oversold watch`)
        break
      case 'adx_above':
        if (row.adx >= v) this.fire(rule, `${rule.asset} ${row.tf} ADX ${row.adx.toFixed(1)} - trend ignition (regime ${row.regime})`)
        break
      case 'atr_above':
        if (row.atrPct >= v) this.fire(rule, `${rule.asset} ${row.tf} ATR ${row.atrPct.toFixed(3)}% - volatility burst`)
        break
      case 'regime':
        if (row.regime === String(rule.value)) this.fire(rule, `${rule.asset} ${row.tf} entered ${String(rule.value)} regime (P(up) ${(row.pUp * 100).toFixed(1)}%)`)
        break
      case 'pattern_bull':
        if (row.topPattern && row.topPattern.direction === 'bullish')
          this.fire(rule, `${rule.asset} ${row.tf} bullish formation: ${row.topPattern.name} (reliability ${'★'.repeat(row.topPattern.reliability)})`)
        break
      case 'pattern_bear':
        if (row.topPattern && row.topPattern.direction === 'bearish')
          this.fire(rule, `${rule.asset} ${row.tf} bearish formation: ${row.topPattern.name} (reliability ${'★'.repeat(row.topPattern.reliability)})`)
        break
      default:
        break
    }
  }

  private fire(rule: AlertRule, message: string): void {
    const now = Math.floor(Date.now() / 1000)
    const rt = this.runtime.get(rule.id)
    if (!rt) return
    if (rule.cooldownSec > 0 && rule.lastFiredTs && now - rule.lastFiredTs < rule.cooldownSec) return
    rt.rule = { ...rt.rule, lastFiredTs: now, fires: rule.fires + 1 }
    this.store.saveAlertRule(rt.rule)
    const suffix = rule.oneShot ? ' [one-shot - disarmed]' : ''
    this.emit('success', `🔔 ${message}${suffix}`)
    if (rule.oneShot) {
      rt.rule = { ...rt.rule, enabled: false }
      this.store.saveAlertRule(rt.rule)
    }
  }

  private emit(level: 'info' | 'warn' | 'danger' | 'success', message: string): void {
    this.ctx.bus.emit('alert', { level, message, ts: Math.floor(Date.now() / 1000) })
  }
}

function describe(rule: AlertRule): string {
  const def = ALERT_METRICS.find((m) => m.metric === rule.metric)
  return def?.needsValue ? `${METRIC_LABEL[rule.metric]} ${rule.value}` : METRIC_LABEL[rule.metric]
}

function fmtLevel(v: number): string {
  return v >= 1000 ? v.toFixed(1) : v >= 10 ? v.toFixed(3) : v.toFixed(5)
}

let active: AlertRulesService | null = null

export const alertRulesPlugin: Plugin = {
  name: 'alert-rules',
  start: async (ctx) => {
    const svc = new AlertRulesService()
    active = svc
    ctx.provide('alertrules', svc)
    await svc.start(ctx)
  },
  stop: () => {
    active?.stop()
    active = null
  },
}
