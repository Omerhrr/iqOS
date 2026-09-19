'use client'

// IQAIR//OS - Alert Rules manager (DISCOVERY)
// Programmable market watchers: bind an instrument + timeframe to a trigger
// (price cross, composite score, RSI/ADX/ATR extremes, Markov regime,
// candlestick pattern). Fired rules surface as OS alerts (toast + feed) and
// are persisted in sqlite, so they survive kernel restarts.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AlertMetricDef, AlertRule, AssetRow, Timeframe } from '@/lib/os/client'
import { fmtTime, osGet, osPost } from '@/lib/os/client'

interface AlertRulesPanelProps {
  assets: AssetRow[]
  onError: (m: string) => void
}

const TF_OPTIONS: Timeframe[] = ['5s', '15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d']

const METRIC_FALLBACK: AlertMetricDef[] = [
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

function describeRule(r: AlertRule): string {
  switch (r.metric) {
    case 'price_above':
      return `price ≥ ${r.value}`
    case 'price_below':
      return `price ≤ ${r.value}`
    case 'score_call':
      return `CALL score ≥ ${r.value}`
    case 'score_put':
      return `PUT score ≥ ${r.value}`
    case 'score_abs':
      return `either-side score ≥ ${r.value}`
    case 'rsi_above':
      return `RSI ≥ ${r.value}`
    case 'rsi_below':
      return `RSI ≤ ${r.value}`
    case 'adx_above':
      return `ADX ≥ ${r.value}`
    case 'atr_above':
      return `ATR% ≥ ${r.value}`
    case 'regime':
      return `regime = ${r.value}`
    case 'pattern_bull':
      return 'bullish pattern'
    case 'pattern_bear':
      return 'bearish pattern'
    default:
      return r.metric
  }
}

export default function AlertRulesPanel({ assets, onError }: AlertRulesPanelProps) {
  const [rules, setRules] = useState<AlertRule[]>([])
  const [metrics, setMetrics] = useState<AlertMetricDef[]>(METRIC_FALLBACK)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // form state
  const [name, setName] = useState('')
  const [asset, setAsset] = useState('EURUSD')
  const [tf, setTf] = useState<Timeframe>('1m')
  const [metric, setMetric] = useState<AlertMetricDef>(METRIC_FALLBACK[4])
  const [value, setValue] = useState('60')
  const [cooldown, setCooldown] = useState('300')
  const [oneShot, setOneShot] = useState(false)

  const load = useCallback(async () => {
    try {
      const [r, m] = await Promise.all([
        osGet<{ ok: boolean; rules: AlertRule[] }>('/alert_rules'),
        osGet<{ ok: boolean; metrics: AlertMetricDef[] }>('/alert_metrics'),
      ])
      if (r.ok) setRules(r.rules)
      if (m.ok && m.metrics.length) setMetrics(m.metrics)
    } catch {
      /* kernel not up yet */
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 8000)
    return () => clearInterval(t)
  }, [load])

  const save = async () => {
    setBusy(true)
    try {
      const def = metrics.find((m) => m.metric === metric.metric)
      const body: Record<string, unknown> = {
        name: name.trim() || `${asset} ${tf} ${metric.label}`,
        asset,
        tf,
        metric: metric.metric,
        cooldownSec: Number(cooldown) || 300,
        oneShot,
      }
      if (def?.needsValue) {
        body.value = metric.metric === 'regime' ? value.trim().toLowerCase() : Number(value)
      }
      const d = await osPost<{ ok: boolean; error?: string }>('/alert_rule_save', body)
      if (!d.ok) throw new Error(d.error ?? 'rule rejected')
      setName('')
      setOpen(false)
      void load()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (id: string, enabled: boolean) => {
    try {
      await osPost('/alert_rule_toggle', { id, enabled })
      void load()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const remove = async (id: string) => {
    try {
      await osPost('/alert_rule_delete', { id })
      void load()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const needsValue = metric.needsValue
  const sortedAssets = [...assets].sort((a, b) => a.ticker.localeCompare(b.ticker))

  return (
    <div className="flex min-h-0 flex-col">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-[#141d2e] px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-[#4b5a72]">Market watch rules</span>
        <span className="font-mono text-[9px] text-[#3d4d66]">
          {rules.filter((r) => r.enabled).length}/{rules.length} armed
        </span>
        <Button
          onClick={() => setOpen((o) => !o)}
          variant="outline"
          size="sm"
          className="ml-auto h-6 border-cyan-500/40 px-2 text-[10px] uppercase text-cyan-300 hover:bg-cyan-500/10"
        >
          {open ? 'cancel' : '+ new rule'}
        </Button>
      </div>

      {/* create form */}
      {open && (
        <div className="border-b border-[#141d2e] bg-[#0a1019] px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="rule name (optional)"
              className="h-6 w-36 border-[#1c2739] bg-[#0b111c] text-[10px] text-[#dbe4f0] placeholder:text-[#3d4d66]"
            />
            <Select value={asset} onValueChange={setAsset}>
              <SelectTrigger className="h-6 w-[120px] border-[#1c2739] bg-[#0b111c] font-mono text-[10px] text-[#dbe4f0]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64 border-[#1c2739] bg-[#0b111c] font-mono text-[11px]">
                {sortedAssets.map((a) => (
                  <SelectItem key={a.ticker} value={a.ticker}>
                    {a.ticker}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={tf} onValueChange={(v) => setTf(v as Timeframe)}>
              <SelectTrigger className="h-6 w-[64px] border-[#1c2739] bg-[#0b111c] font-mono text-[10px] text-[#dbe4f0]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-[#1c2739] bg-[#0b111c] font-mono text-[11px]">
                {TF_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={metric.metric}
              onValueChange={(v) => {
                const def = metrics.find((m) => m.metric === v) ?? METRIC_FALLBACK.find((m) => m.metric === v)!
                setMetric(def)
                if (def.metric.startsWith('score')) setValue('60')
                else if (def.metric.startsWith('rsi')) setValue(def.metric === 'rsi_above' ? '70' : '30')
                else if (def.metric === 'adx_above') setValue('25')
                else if (def.metric === 'atr_above') setValue('0.15')
                else if (def.metric === 'regime') setValue('bull')
              }}
            >
              <SelectTrigger className="h-6 w-[190px] border-[#1c2739] bg-[#0b111c] text-[10px] text-[#dbe4f0]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-[#1c2739] bg-[#0b111c] text-[11px]">
                {metrics.map((m) => (
                  <SelectItem key={m.metric} value={m.metric}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {needsValue ? (
              metric.metric === 'regime' ? (
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger className="h-6 w-[84px] border-[#1c2739] bg-[#0b111c] font-mono text-[10px] text-[#dbe4f0]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-[#1c2739] bg-[#0b111c] font-mono text-[11px]">
                    {['bull', 'bear', 'range', 'chop'].map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={metric.hint}
                  className="h-6 w-24 border-[#1c2739] bg-[#0b111c] font-mono text-[10px] text-[#dbe4f0] placeholder:text-[#3d4d66]"
                />
              )
            ) : null}
            <label className="flex items-center gap-1 font-mono text-[10px] text-[#4b5a72]">
              cooldown
              <Input
                value={cooldown}
                onChange={(e) => setCooldown(e.target.value)}
                className="h-6 w-14 border-[#1c2739] bg-[#0b111c] font-mono text-[10px] text-[#dbe4f0]"
              />
              s
            </label>
            <label className="flex cursor-pointer items-center gap-1 font-mono text-[10px] text-[#4b5a72]">
              <input type="checkbox" checked={oneShot} onChange={(e) => setOneShot(e.target.checked)} className="accent-cyan-500" />
              one-shot
            </label>
            <Button
              onClick={() => void save()}
              disabled={busy}
              size="sm"
              className="h-6 bg-cyan-600 px-3 text-[10px] uppercase text-white hover:bg-cyan-500"
            >
              {busy ? 'saving…' : 'arm rule'}
            </Button>
          </div>
          <p className="mt-1 font-mono text-[9px] text-[#3d4d66]">
            Fires an OS alert when {asset} {tf} meets the condition. Price rules check every tick; the rest evaluate on closed candles.
          </p>
        </div>
      )}

      {/* rules list */}
      {rules.length === 0 ? (
        <div className="px-3 py-3 font-mono text-[10px] text-[#3d4d66]">
          No rules yet - create one, or hit the bell button on any Screener row to watch that setup.
        </div>
      ) : (
        <div className="divide-y divide-[#0d1420]">
          {rules.map((r) => (
            <div key={r.id} className="flex items-center gap-2 px-3 py-1.5">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.enabled ? (r.fires > 0 ? 'bg-emerald-400' : 'bg-cyan-400 animate-pulse') : 'bg-[#2a3850]'}`}
              />
              <span className={`w-40 truncate text-[11px] ${r.enabled ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}`} title={r.name}>
                {r.name}
              </span>
              <span className="font-mono text-[10px] text-[#7c8aa5]">
                {r.asset} · {r.tf} · {describeRule(r)}
              </span>
              {r.oneShot && <span className="rounded bg-violet-500/10 px-1 font-mono text-[8px] uppercase text-violet-300">1-shot</span>}
              <span className="font-mono text-[9px] text-[#3d4d66]">
                {r.fires > 0 ? `${r.fires} fired${r.lastFiredTs ? ` · last ${fmtTime(r.lastFiredTs)}` : ''}` : 'never fired'}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  onClick={() => void toggle(r.id, !r.enabled)}
                  variant="outline"
                  size="sm"
                  className="h-5 border-[#1c2739] px-1.5 text-[9px] uppercase text-[#7c8aa5] hover:text-cyan-300"
                >
                  {r.enabled ? 'pause' : 'arm'}
                </Button>
                <Button
                  onClick={() => void remove(r.id)}
                  variant="outline"
                  size="sm"
                  className="h-5 border-[#1c2739] px-1.5 text-[9px] uppercase text-[#7c8aa5] hover:text-rose-400"
                >
                  del
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
