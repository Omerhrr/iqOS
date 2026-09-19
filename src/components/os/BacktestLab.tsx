'use client'

// IQAIR//OS - Backtest lab: strategy + params -> full metrics + equity curve
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { BacktestResult, StrategyInfo, Timeframe } from '@/lib/os/client'
import { fmtMoney, fmtPct, osPost } from '@/lib/os/client'

interface Props {
  asset: string
  strategies: StrategyInfo[]
}

export default function BacktestLab({ asset, strategies }: Props) {
  const [strategyId, setStrategyId] = useState(strategies[0]?.id ?? 'markov-edge')
  const [tf, setTf] = useState<Timeframe>('1m')
  const [mode, setMode] = useState<'binary' | 'spot'>('binary')
  const [amount, setAmount] = useState('10')
  const [expiryBars, setExpiryBars] = useState('1')
  const [startEquity, setStartEquity] = useState('1000')
  const [paramValues, setParamValues] = useState<Record<string, Record<string, string>>>({})
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const strategy = strategies.find((s) => s.id === strategyId)

  const run = async () => {
    setBusy(true)
    setError('')
    try {
      const params: Record<string, number | string> = {}
      if (strategy) {
        for (const p of strategy.params) {
          const raw = paramValues[strategyId]?.[p.key] ?? String(p.default)
          params[p.key] = p.type === 'number' ? Number(raw) : raw
        }
      }
      const res = await osPost<{ ok: boolean; result?: BacktestResult; error?: string }>('/backtest', {
        asset,
        tf,
        strategy: strategyId,
        mode,
        amount: Number(amount),
        expiryBars: Number(expiryBars),
        startEquity: Number(startEquity),
        params,
      })
      if (res.ok && res.result) setResult(res.result)
      else setError(res.error ?? 'backtest failed')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const equity = useMemo(() => {
    if (!result || result.equityCurve.length < 2) return null
    const pts = result.equityCurve
    const W = 560
    const H = 110
    let lo = Math.min(...pts.map((p) => p.value), result.metrics.startEquity)
    let hi = Math.max(...pts.map((p) => p.value), result.metrics.startEquity)
    const pad = (hi - lo) * 0.08 || 1
    lo -= pad
    hi += pad
    const x = (i: number) => (i / (pts.length - 1)) * W
    const y = (v: number) => H - ((v - lo) / (hi - lo)) * H
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
    const y0 = y(result.metrics.startEquity)
    const positive = result.metrics.netPnl >= 0
    const area = `${d} L${W},${H} L0,${H} Z`
    return { W, H, d, y0, area, positive, start: pts[0].time, end: pts[pts.length - 1].time }
  }, [result])

  const m = result?.metrics

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
        <Field label="Strategy">
          <select
            value={strategyId}
            onChange={(e) => setStrategyId(e.target.value)}
            className="h-8 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0] outline-none"
          >
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timeframe">
          <select
            value={tf}
            onChange={(e) => setTf(e.target.value as Timeframe)}
            className="h-8 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0] outline-none"
          >
            {['5s', '15s', '1m', '5m', '15m'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Mode">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'binary' | 'spot')}
            className="h-8 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0] outline-none"
          >
            <option value="binary">binary</option>
            <option value="spot">spot</option>
          </select>
        </Field>
        <Field label="Stake $">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} className="h-8 w-16 border-[#1c2739] bg-[#101828] text-right font-mono text-[11px] text-[#dbe4f0]" />
        </Field>
        <Field label="Expiry bars">
          <Input value={expiryBars} onChange={(e) => setExpiryBars(e.target.value)} className="h-8 w-14 border-[#1c2739] bg-[#101828] text-right font-mono text-[11px] text-[#dbe4f0]" />
        </Field>
        <Field label="Start equity $">
          <Input value={startEquity} onChange={(e) => setStartEquity(e.target.value)} className="h-8 w-20 border-[#1c2739] bg-[#101828] text-right font-mono text-[11px] text-[#dbe4f0]" />
        </Field>

        {strategy?.params.map((p) => (
          <Field key={p.key} label={p.label}>
            <Input
              value={paramValues[strategyId]?.[p.key] ?? String(p.default)}
              onChange={(e) =>
                setParamValues((pv) => ({
                  ...pv,
                  [strategyId]: { ...(pv[strategyId] ?? {}), [p.key]: e.target.value },
                }))
              }
              className="h-8 w-16 border-[#1c2739] bg-[#101828] text-right font-mono text-[11px] text-cyan-300"
            />
          </Field>
        ))}

        <Button onClick={() => void run()} disabled={busy} className="h-8 bg-cyan-600 px-4 text-[11px] font-semibold text-white hover:bg-cyan-500">
          {busy ? 'Running…' : 'Run Backtest'}
        </Button>
        <span className="font-mono text-[10px] text-[#4b5a72]">
          on {asset} · live sim history
        </span>
      </div>

      {error && <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-400">{error}</div>}

      {m && equity && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
          <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
            <div className="mb-1 flex items-center justify-between">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Equity Curve</h4>
              <span className={`font-mono text-[12px] font-bold ${equity.positive ? 'text-emerald-400' : 'text-rose-400'}`}>
                {fmtMoney(m.netPnl)} ({fmtPct((m.netPnl / m.startEquity) * 100)})
              </span>
            </div>
            <svg viewBox={`0 0 ${equity.W} ${equity.H}`} className="h-[110px] w-full">
              <line x1="0" x2={equity.W} y1={equity.y0} y2={equity.y0} stroke="#2a3a52" strokeDasharray="4 4" strokeWidth="0.8" />
              <path d={equity.area} fill={equity.positive ? 'rgba(16,185,129,0.12)' : 'rgba(244,63,94,0.12)'} />
              <path d={equity.d} fill="none" stroke={equity.positive ? '#10b981' : '#f43f5e'} strokeWidth="1.5" />
            </svg>
            <div className="mt-1 flex justify-between font-mono text-[9px] text-[#4b5a72]">
              <span>{new Date(equity.start * 1000).toLocaleTimeString('en-US', { hour12: false })}</span>
              <span>{result?.candlesTested} candles tested · {m.totalTrades} trades</span>
              <span>{new Date(equity.end * 1000).toLocaleTimeString('en-US', { hour12: false })}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['Win rate', `${m.winRate.toFixed(1)}%`, m.winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'],
                ['Profit factor', m.profitFactor.toFixed(2), m.profitFactor >= 1 ? 'text-emerald-400' : 'text-rose-400'],
                ['Max drawdown', `${m.maxDrawdownPct.toFixed(1)}%`, 'text-amber-400'],
                ['Sharpe', m.sharpe.toFixed(2), 'text-[#aab6cc]'],
                ['Expectancy / trade', fmtMoney(m.expectancy), m.expectancy >= 0 ? 'text-emerald-400' : 'text-rose-400'],
                ['Final equity', fmtMoney(m.finalEquity), 'text-cyan-300'],
              ] as [string, string, string][]
            ).map(([label, value, cls]) => (
              <div key={label} className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2.5">
                <div className="text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
                <div className={`font-mono text-[15px] font-bold ${cls}`}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
      {children}
    </div>
  )
}
