'use client'

// IQAIR//OS - Research Lab: single backtest / grid optimizer / walk-forward / asset sweep
// + one-click promote of a researched config into an autopilot bot.
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type {
  AssetRow,
  BacktestResult,
  GridSearchResult,
  HeatmapData,
  OptRow,
  StrategyInfo,
  SweepResult,
  SweepSpec,
  Timeframe,
  WalkForwardResult,
} from '@/lib/os/client'
import { fmtMoney, fmtPct, osPost } from '@/lib/os/client'

type LabTab = 'single' | 'optimizer' | 'walkforward' | 'sweep'

const TABS: { id: LabTab; label: string }[] = [
  { id: 'single', label: 'Single Run' },
  { id: 'optimizer', label: 'Optimizer' },
  { id: 'walkforward', label: 'Walk-Forward' },
  { id: 'sweep', label: 'Asset Sweep' },
]

const TFS: Timeframe[] = ['5s', '15s', '30s', '1m', '2m', '5m', '15m']

interface Props {
  asset: string
  strategies: StrategyInfo[]
  onSelectSetup: (asset: string, tf: Timeframe) => void
}

export default function BacktestLab({ asset, strategies, onSelectSetup }: Props) {
  const [tab, setTab] = useState<LabTab>('single')
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg border border-[#1c2739] bg-[#0b111c] p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded px-3 py-1 text-[11px] font-semibold transition-colors ${
                tab === t.id ? 'bg-cyan-600/20 text-cyan-300 shadow-[inset_0_0_0_1px_rgba(6,182,212,0.4)]' : 'text-[#7c8aa5] hover:text-[#dbe4f0]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="font-mono text-[10px] text-[#4b5a72]">
          research a config here, then promote it to an autopilot bot
        </span>
      </div>

      {tab === 'single' && <SingleTab asset={asset} strategies={strategies} />}
      {tab === 'optimizer' && <OptimizerTab asset={asset} strategies={strategies} />}
      {tab === 'walkforward' && <WalkForwardTab asset={asset} strategies={strategies} />}
      {tab === 'sweep' && <SweepTab asset={asset} strategies={strategies} onSelectSetup={onSelectSetup} />}
    </div>
  )
}

// ---------------------------------------------------------------- shared bits

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
      {children}
    </div>
  )
}

const selCls = 'h-8 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0] outline-none'
const inCls = 'h-8 border-[#1c2739] bg-[#101828] text-right font-mono text-[11px] text-[#dbe4f0]'

function niceStep(lo: number, hi: number): number {
  const raw = (hi - lo) / 6
  if (raw <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag
  return 10 * mag
}

const netCls = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-[#7c8aa5]')

function ParamChips({ params, cls = 'text-cyan-300' }: { params: Record<string, number | string>; cls?: string }) {
  return (
    <div className="flex flex-wrap gap-1">
      {Object.entries(params).map(([k, v]) => (
        <span key={k} className={`rounded bg-[#101828] px-1.5 py-0.5 font-mono text-[9px] ${cls}`}>
          {k}={typeof v === 'number' ? +v.toFixed(4) : v}
        </span>
      ))}
    </div>
  )
}

function SweepGridEditor({
  strategy,
  value,
  onChange,
}: {
  strategy: StrategyInfo | undefined
  value: Record<string, { from: string; to: string; step: string; on: boolean }>
  onChange: (v: Record<string, { from: string; to: string; step: string; on: boolean }>) => void
}) {
  if (!strategy) return null
  const set = (k: string, patch: Partial<{ from: string; to: string; step: string; on: boolean }>) => {
    const cur = value[k] ?? {
      on: false,
      from: String(strategy.defaults[k] ?? 0),
      to: String(strategy.defaults[k] ?? 0),
      step: '1',
    }
    onChange({ ...value, [k]: { ...cur, ...patch } })
  }
  return (
    <div className="space-y-1 rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
      <div className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Parameter sweep (check a param to optimize it)</div>
      {strategy.params.map((p) => {
        const st = value[p.key]
        const lo = p.min ?? 1
        const hi = p.max ?? 100
        const defSt = {
          on: st?.on ?? false,
          from: st?.from ?? String(Number(p.default)),
          to: st?.to ?? String(Number(p.default)),
          step: st?.step ?? String(niceStep(Math.min(Number(p.default), lo), Math.max(Number(p.default), hi))),
        }
        const cur = st ?? defSt
        return (
          <div key={p.key} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={cur.on}
              onChange={(e) => set(p.key, { on: e.target.checked, ...(cur.on ? {} : { from: String(lo), to: String(hi), step: String(niceStep(lo, hi)) }) })}
              className="h-3 w-3 accent-cyan-500"
            />
            <span className="w-28 shrink-0 truncate font-mono text-[10px] text-[#7c8aa5]" title={p.label}>
              {p.label}
            </span>
            {(['from', 'to', 'step'] as const).map((f) => (
              <Input
                key={f}
                value={cur[f]}
                onChange={(e) => set(p.key, { [f]: e.target.value })}
                disabled={!cur.on}
                placeholder={f}
                className={`${inCls} w-16 disabled:opacity-40`}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function buildSweep(
  strategy: StrategyInfo | undefined,
  state: Record<string, { from: string; to: string; step: string; on: boolean }>
): { sweep: SweepSpec; count: number; missing: string[] } {
  const sweep: SweepSpec = {}
  let count = 1
  const missing: string[] = []
  if (!strategy) return { sweep, count: 0, missing: ['strategy'] }
  for (const p of strategy.params) {
    const st = state[p.key]
    if (!st?.on) continue
    const from = Number(st.from)
    const to = Number(st.to)
    const step = Number(st.step)
    if (![from, to, step].every(Number.isFinite) || step <= 0 || from > to) {
      missing.push(p.label)
      continue
    }
    const n = Math.floor((to - from) / step + 1e-9) + 1
    sweep[p.key] = { from, to, step }
    count *= n
  }
  return { sweep, count, missing }
}

// ---------------------------------------------------------------- single run

function SingleTab({ asset, strategies }: { asset: string; strategies: StrategyInfo[] }) {
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
          <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)} className={selCls}>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timeframe">
          <select value={tf} onChange={(e) => setTf(e.target.value as Timeframe)} className={selCls}>
            {TFS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Mode">
          <select value={mode} onChange={(e) => setMode(e.target.value as 'binary' | 'spot')} className={selCls}>
            <option value="binary">binary</option>
            <option value="spot">spot</option>
          </select>
        </Field>
        <Field label="Stake $">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inCls} w-16`} />
        </Field>
        <Field label="Expiry bars">
          <Input value={expiryBars} onChange={(e) => setExpiryBars(e.target.value)} className={`${inCls} w-14`} />
        </Field>
        <Field label="Start equity $">
          <Input value={startEquity} onChange={(e) => setStartEquity(e.target.value)} className={`${inCls} w-20`} />
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
              className={`${inCls} w-16 text-cyan-300`}
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

// ---------------------------------------------------------------- optimizer

type SweepState = Record<string, { from: string; to: string; step: string; on: boolean }>

function OptimizerTab({ asset, strategies }: { asset: string; strategies: StrategyInfo[] }) {
  const [strategyId, setStrategyId] = useState('rsi-reversion')
  const [tf, setTf] = useState<Timeframe>('1m')
  const [objective, setObjective] = useState<'netPnl' | 'sharpe' | 'profitFactor' | 'winRate' | 'expectancy'>('netPnl')
  const [minTrades, setMinTrades] = useState('8')
  const [maxCombos, setMaxCombos] = useState('240')
  const [amount, setAmount] = useState('10')
  const [expiryBars, setExpiryBars] = useState('1')
  const [startEquity, setStartEquity] = useState('1000')
  const [sweepState, setSweepState] = useState<SweepState>({})
  const [result, setResult] = useState<GridSearchResult | null>(null)
  const [selected, setSelected] = useState<OptRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [promote, setPromote] = useState(false)

  const strategy = strategies.find((s) => s.id === strategyId)
  const { sweep, count, missing } = useMemo(() => buildSweep(strategy, sweepState), [strategy, sweepState])

  const run = async () => {
    if (!Object.keys(sweep).length) {
      setError('check at least one parameter to sweep')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await osPost<{ ok: boolean; result?: GridSearchResult; error?: string }>('/optimize', {
        asset,
        tf,
        strategy: strategyId,
        sweep,
        objective,
        minTrades: Number(minTrades),
        maxCombos: Number(maxCombos),
        amount: Number(amount),
        expiryBars: Number(expiryBars),
        startEquity: Number(startEquity),
      })
      if (res.ok && res.result) {
        setResult(res.result)
        setSelected(res.result.best)
      } else setError(res.error ?? 'optimize failed')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
        <Field label="Strategy">
          <select value={strategyId} onChange={(e) => { setStrategyId(e.target.value); setSweepState({}); setResult(null); setSelected(null) }} className={selCls}>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timeframe">
          <select value={tf} onChange={(e) => setTf(e.target.value as Timeframe)} className={selCls}>
            {TFS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Objective">
          <select value={objective} onChange={(e) => setObjective(e.target.value as typeof objective)} className={selCls}>
            <option value="netPnl">net P&L</option>
            <option value="sharpe">Sharpe</option>
            <option value="profitFactor">profit factor</option>
            <option value="winRate">win rate</option>
            <option value="expectancy">expectancy</option>
          </select>
        </Field>
        <Field label="Min trades">
          <Input value={minTrades} onChange={(e) => setMinTrades(e.target.value)} className={`${inCls} w-14`} />
        </Field>
        <Field label="Max combos">
          <Input value={maxCombos} onChange={(e) => setMaxCombos(e.target.value)} className={`${inCls} w-16`} />
        </Field>
        <Field label="Stake $">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inCls} w-16`} />
        </Field>
        <Field label="Expiry bars">
          <Input value={expiryBars} onChange={(e) => setExpiryBars(e.target.value)} className={`${inCls} w-14`} />
        </Field>
        <Field label="Start equity $">
          <Input value={startEquity} onChange={(e) => setStartEquity(e.target.value)} className={`${inCls} w-20`} />
        </Field>
        <Button onClick={() => void run()} disabled={busy} className="h-8 bg-cyan-600 px-4 text-[11px] font-semibold text-white hover:bg-cyan-500">
          {busy ? 'Searching…' : 'Run Optimizer'}
        </Button>
        <span className="font-mono text-[10px] text-[#4b5a72]">
          {missing.length ? <span className="text-amber-400">bad sweep: {missing.join(', ')}</span> : `${count} combos on ${asset} ${tf}`}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[300px_1fr]">
        <SweepGridEditor strategy={strategy} value={sweepState} onChange={setSweepState} />

        <div className="space-y-3">
          {error && <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-400">{error}</div>}

          {result && (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#1c2739] bg-[#0b111c] px-3 py-2 font-mono text-[10px] text-[#7c8aa5]">
                <span className="text-cyan-300">{result.evaluated}</span> evaluated ·
                <span className="text-amber-400">{result.skipped}</span> below trade guard ·
                <span>{result.totalCombos} grid</span> ·
                <span>{result.elapsedMs} ms</span>
                {result.best && (
                  <span className="ml-auto flex items-center gap-2">
                    best: <ParamChips params={result.best.params} />{' '}
                    <span className={netCls(result.best.metrics.netPnl)}>{fmtMoney(result.best.metrics.netPnl)}</span>
                  </span>
                )}
              </div>

              {result.heatmap && <Heatmap hm={result.heatmap} objective={result.objective} />}

              <div className="overflow-hidden rounded-lg border border-[#1c2739]">
                <table className="w-full font-mono text-[10px]">
                  <thead>
                    <tr className="bg-[#101828] text-left text-[#4b5a72]">
                      {['#', 'params', 'net', 'win%', 'PF', 'trades', 'DD%', 'Sharpe', ''].map((h) => (
                        <th key={h} className="px-2 py-1.5 font-medium uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.ranked.map((r) => (
                      <tr
                        key={r.rank}
                        onClick={() => setSelected(r)}
                        className={`cursor-pointer border-t border-[#1c2739]/60 transition-colors ${
                          selected?.rank === r.rank ? 'bg-cyan-600/10' : 'hover:bg-[#101828]/60'
                        }`}
                      >
                        <td className="px-2 py-1.5 text-[#4b5a72]">{r.rank}</td>
                        <td className="max-w-[280px] px-2 py-1.5"><ParamChips params={r.params} /></td>
                        <td className={`px-2 py-1.5 font-bold ${netCls(r.metrics.netPnl)}`}>{fmtMoney(r.metrics.netPnl)}</td>
                        <td className={`px-2 py-1.5 ${r.metrics.winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'}`}>{r.metrics.winRate.toFixed(0)}%</td>
                        <td className="px-2 py-1.5 text-[#aab6cc]">{r.metrics.profitFactor.toFixed(2)}</td>
                        <td className="px-2 py-1.5 text-[#aab6cc]">{r.metrics.totalTrades}</td>
                        <td className="px-2 py-1.5 text-amber-400/80">{r.metrics.maxDrawdownPct.toFixed(1)}</td>
                        <td className="px-2 py-1.5 text-[#aab6cc]">{r.metrics.sharpe.toFixed(2)}</td>
                        <td className="px-2 py-1.5" title={r.verified ? 're-verified with the full settlement engine' : 'fast-mode estimate'}>
                          {r.verified ? <span className="text-emerald-400" title="verified">✓</span> : <span className="text-[#4b5a72]">~</span>}
                        </td>
                      </tr>
                    ))}
                    {!result.ranked.length && (
                      <tr><td colSpan={9} className="px-3 py-4 text-center text-[#4b5a72]">no combo cleared the min-trades guard — widen the sweep or lower the guard</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <PromoteBar
                disabled={!selected}
                label={selected ? `Promote rank #${selected.rank} to Autopilot bot` : 'select a ranked row to promote'}
                onClick={() => setPromote(true)}
              />
            </>
          )}
        </div>
      </div>

      {promote && selected && strategy && (
        <PromoteBotDialog
          asset={asset}
          tf={tf}
          strategy={strategies.find((s) => s.id === result?.strategy) ?? strategy}
          params={selected.params}
          stake={amount}
          expiryBars={expiryBars}
          onClose={() => setPromote(false)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- walk-forward

function WalkForwardTab({ asset, strategies }: { asset: string; strategies: StrategyInfo[] }) {
  const [strategyId, setStrategyId] = useState('rsi-reversion')
  const [tf, setTf] = useState<Timeframe>('1m')
  const [folds, setFolds] = useState('3')
  const [isRatio, setIsRatio] = useState('0.7')
  const [objective, setObjective] = useState<'netPnl' | 'sharpe' | 'profitFactor' | 'winRate' | 'expectancy'>('netPnl')
  const [minTrades, setMinTrades] = useState('6')
  const [amount, setAmount] = useState('10')
  const [expiryBars, setExpiryBars] = useState('1')
  const [sweepState, setSweepState] = useState<SweepState>({})
  const [result, setResult] = useState<WalkForwardResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [promote, setPromote] = useState(false)

  const strategy = strategies.find((s) => s.id === strategyId)
  const { sweep, count, missing } = useMemo(() => buildSweep(strategy, sweepState), [strategy, sweepState])

  const run = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await osPost<{ ok: boolean; result?: WalkForwardResult; error?: string }>('/walkforward', {
        asset,
        tf,
        strategy: strategyId,
        sweep,
        objective,
        minTrades: Number(minTrades),
        folds: Number(folds),
        isRatio: Number(isRatio),
        amount: Number(amount),
        expiryBars: Number(expiryBars),
      })
      if (res.ok && res.result) setResult(res.result)
      else setError(res.error ?? 'walk-forward failed')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const oos = result?.oos

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
        <Field label="Strategy">
          <select value={strategyId} onChange={(e) => { setStrategyId(e.target.value); setSweepState({}); setResult(null) }} className={selCls}>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timeframe">
          <select value={tf} onChange={(e) => setTf(e.target.value as Timeframe)} className={selCls}>
            {TFS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Folds">
          <select value={folds} onChange={(e) => setFolds(e.target.value)} className={selCls}>
            {['2', '3', '4'].map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </Field>
        <Field label="IS share">
          <Input value={isRatio} onChange={(e) => setIsRatio(e.target.value)} className={`${inCls} w-14`} />
        </Field>
        <Field label="Objective">
          <select value={objective} onChange={(e) => setObjective(e.target.value as typeof objective)} className={selCls}>
            <option value="netPnl">net P&L</option>
            <option value="sharpe">Sharpe</option>
            <option value="winRate">win rate</option>
          </select>
        </Field>
        <Field label="Min trades/fold">
          <Input value={minTrades} onChange={(e) => setMinTrades(e.target.value)} className={`${inCls} w-14`} />
        </Field>
        <Field label="Stake $">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inCls} w-16`} />
        </Field>
        <Field label="Expiry bars">
          <Input value={expiryBars} onChange={(e) => setExpiryBars(e.target.value)} className={`${inCls} w-14`} />
        </Field>
        <Button onClick={() => void run()} disabled={busy} className="h-8 bg-cyan-600 px-4 text-[11px] font-semibold text-white hover:bg-cyan-500">
          {busy ? 'Validating…' : 'Run Walk-Forward'}
        </Button>
        <span className="font-mono text-[10px] text-[#4b5a72]">
          {missing.length ? <span className="text-amber-400">bad sweep: {missing.join(', ')}</span> : `${folds} folds × ${count} combos · optimize in-sample, settle out-of-sample`}
        </span>
      </div>

      {error && <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-400">{error}</div>}

      {result && oos && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            {(
              [
                ['OOS net P&L', fmtMoney(result.oosNet), netCls(result.oosNet)],
                ['OOS win rate', `${oos.winRate.toFixed(1)}%`, oos.winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'],
                ['Consistency', `${result.foldsProfitable}/${result.folds.length} folds`, result.foldsProfitable >= result.folds.length / 2 ? 'text-emerald-400' : 'text-amber-400'],
                ['OOS efficiency', `${result.efficiencyPct.toFixed(0)}%`, result.efficiencyPct > 0 ? 'text-emerald-400' : 'text-rose-400'],
                ['OOS trades', String(oos.totalTrades), 'text-[#aab6cc]'],
              ] as [string, string, string][]
            ).map(([label, value, cls]) => (
              <div key={label} className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2.5">
                <div className="text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
                <div className={`font-mono text-[15px] font-bold ${cls}`}>{value}</div>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-lg border border-[#1c2739]">
            <table className="w-full font-mono text-[10px]">
              <thead>
                <tr className="bg-[#101828] text-left text-[#4b5a72]">
                  {['fold', 'IS bars', 'best IS params', 'IS net', 'OOS bars', 'OOS net', 'OOS win%', 'OOS PF', 'OOS trades'].map((h) => (
                    <th key={h} className="px-2 py-1.5 font-medium uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.folds.map((f) => (
                  <tr key={f.fold} className="border-t border-[#1c2739]/60 hover:bg-[#101828]/60">
                    <td className="px-2 py-1.5 text-[#4b5a72]">{f.fold}</td>
                    <td className="px-2 py-1.5 text-[#aab6cc]">{f.isBars}</td>
                    <td className="max-w-[240px] px-2 py-1.5"><ParamChips params={f.bestParams} /></td>
                    <td className={`px-2 py-1.5 ${netCls(f.is.netPnl)}`}>{fmtMoney(f.is.netPnl)}</td>
                    <td className="px-2 py-1.5 text-[#aab6cc]">{f.oosBars}</td>
                    <td className={`px-2 py-1.5 font-bold ${netCls(f.oos.netPnl)}`}>{fmtMoney(f.oos.netPnl)}</td>
                    <td className={`px-2 py-1.5 ${f.oos.winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'}`}>{f.oos.winRate.toFixed(0)}%</td>
                    <td className="px-2 py-1.5 text-[#aab6cc]">{f.oos.profitFactor.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-[#aab6cc]">{f.oos.totalTrades}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[#1c2739] bg-[#0b111c] px-3 py-2">
            <span className="font-mono text-[10px] text-[#7c8aa5]">robust params (best OOS fold):</span>
            <ParamChips params={result.bestParams} />
            <span className="ml-auto font-mono text-[9px] text-[#4b5a72]">OOS settled by the real binary engine · {result.elapsedMs} ms</span>
            <PromoteBar
              disabled={result.foldsProfitable === 0}
              label="Promote robust params to Autopilot bot"
              onClick={() => setPromote(true)}
            />
          </div>
        </div>
      )}

      {promote && result && strategy && (
        <PromoteBotDialog
          asset={asset}
          tf={tf}
          strategy={strategy}
          params={result.bestParams}
          stake={amount}
          expiryBars={expiryBars}
          onClose={() => setPromote(false)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- asset sweep

const SWEEP_CATS: { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'forex', label: 'Forex' },
  { id: 'otc', label: 'OTC' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'commodity', label: 'Commodities' },
  { id: 'stock', label: 'Stocks' },
  { id: 'index', label: 'Indices' },
]

function SweepTab({
  strategies,
  onSelectSetup,
}: {
  asset: string
  strategies: StrategyInfo[]
  onSelectSetup: (asset: string, tf: Timeframe) => void
}) {
  const [strategyId, setStrategyId] = useState('confluence-core')
  const [tf, setTf] = useState<Timeframe>('1m')
  const [category, setCategory] = useState('all')
  const [openOnly, setOpenOnly] = useState(true)
  const [maxAssets, setMaxAssets] = useState('40')
  const [objective, setObjective] = useState<'netPnl' | 'sharpe' | 'profitFactor' | 'winRate' | 'expectancy'>('netPnl')
  const [minTrades, setMinTrades] = useState('8')
  const [paramValues, setParamValues] = useState<Record<string, Record<string, string>>>({})
  const [result, setResult] = useState<SweepResult | null>(null)
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
      const res = await osPost<{ ok: boolean; result?: SweepResult; error?: string }>('/asset_sweep', {
        tf,
        category,
        openOnly,
        maxAssets: Number(maxAssets),
        strategy: strategyId,
        params,
        objective,
        minTrades: Number(minTrades),
      })
      if (res.ok && res.result) setResult(res.result)
      else setError(res.error ?? 'asset sweep failed')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
        <Field label="Strategy">
          <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)} className={selCls}>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timeframe">
          <select value={tf} onChange={(e) => setTf(e.target.value as Timeframe)} className={selCls}>
            {TFS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Universe">
          <div className="flex gap-1">
            {SWEEP_CATS.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                className={`rounded px-2 py-1 font-mono text-[10px] transition-colors ${
                  category === c.id ? 'bg-cyan-600/20 text-cyan-300 shadow-[inset_0_0_0_1px_rgba(6,182,212,0.4)]' : 'bg-[#101828] text-[#7c8aa5] hover:text-[#dbe4f0]'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Cap">
          <select value={maxAssets} onChange={(e) => setMaxAssets(e.target.value)} className={selCls}>
            {['20', '40', '60', '80'].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </Field>
        <Field label="Objective">
          <select value={objective} onChange={(e) => setObjective(e.target.value as typeof objective)} className={selCls}>
            <option value="netPnl">net P&L</option>
            <option value="sharpe">Sharpe</option>
            <option value="winRate">win rate</option>
          </select>
        </Field>
        <Field label="Min trades">
          <Input value={minTrades} onChange={(e) => setMinTrades(e.target.value)} className={`${inCls} w-14`} />
        </Field>
        <label className="flex cursor-pointer items-center gap-1.5 pb-1.5 font-mono text-[10px] text-[#7c8aa5]">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} className="h-3 w-3 accent-cyan-500" />
          open only
        </label>
        <Button onClick={() => void run()} disabled={busy} className="h-8 bg-cyan-600 px-4 text-[11px] font-semibold text-white hover:bg-cyan-500">
          {busy ? 'Sweeping…' : 'Run Sweep'}
        </Button>

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
              className={`${inCls} w-16 text-cyan-300`}
            />
          </Field>
        ))}
      </div>

      {error && <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-400">{error}</div>}

      {result && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#1c2739] bg-[#0b111c] px-3 py-2 font-mono text-[10px] text-[#7c8aa5]">
            <span className="text-cyan-300">{result.tested}</span> assets tested ·
            <span className="text-amber-400">{result.skipped}</span> skipped ·
            <span>{result.elapsedMs} ms</span>
            <span className="ml-auto text-[#4b5a72]">click a row to load it in the chart</span>
          </div>
          <div className="overflow-hidden rounded-lg border border-[#1c2739]">
            <table className="w-full font-mono text-[10px]">
              <thead>
                <tr className="bg-[#101828] text-left text-[#4b5a72]">
                  {['asset', 'cat', 'payout', 'net', 'win%', 'PF', 'trades', 'DD%', 'Sharpe'].map((h) => (
                    <th key={h} className="px-2 py-1.5 font-medium uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.slice(0, 30).map((r) => (
                  <tr
                    key={r.asset}
                    onClick={() => onSelectSetup(r.asset, tf)}
                    className="cursor-pointer border-t border-[#1c2739]/60 hover:bg-[#101828]/60"
                  >
                    <td className="px-2 py-1.5 font-bold text-[#dbe4f0]">{r.asset}</td>
                    <td className="px-2 py-1.5 text-[#4b5a72]">{r.category}</td>
                    <td className="px-2 py-1.5 text-[#aab6cc]">{(r.payout * 100).toFixed(0)}%</td>
                    <td className={`px-2 py-1.5 font-bold ${netCls(r.metrics.netPnl)}`}>{fmtMoney(r.metrics.netPnl)}</td>
                    <td className={`px-2 py-1.5 ${r.metrics.winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'}`}>{r.metrics.winRate.toFixed(0)}%</td>
                    <td className="px-2 py-1.5 text-[#aab6cc]">{r.metrics.profitFactor.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-[#aab6cc]">{r.metrics.totalTrades}</td>
                    <td className="px-2 py-1.5 text-amber-400/80">{r.metrics.maxDrawdownPct.toFixed(1)}</td>
                    <td className="px-2 py-1.5 text-[#aab6cc]">{r.metrics.sharpe.toFixed(2)}</td>
                  </tr>
                ))}
                {!result.rows.length && (
                  <tr><td colSpan={9} className="px-3 py-4 text-center text-[#4b5a72]">no asset cleared the min-trades guard for this strategy</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- heatmap

function Heatmap({ hm, objective }: { hm: HeatmapData; objective: string }) {
  const vals = hm.cells.map((c) => c.value).filter((v): v is number => v !== null)
  const maxAbs = Math.max(1e-9, ...vals.map((v) => Math.abs(v)))
  const cellW = 44
  const cellH = 20
  const padL = 46
  const padT = 18
  const W = padL + hm.xs.length * cellW + 6
  const H = padT + hm.ys.length * cellH + 4
  const single = hm.yKey === hm.xKey

  const cellColor = (v: number | null) => {
    if (v === null) return '#141d2e'
    const a = Math.min(0.85, 0.12 + (Math.abs(v) / maxAbs) * 0.73)
    return v >= 0 ? `rgba(16,185,129,${a.toFixed(2)})` : `rgba(244,63,94,${a.toFixed(2)})`
  }

  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">
          Robustness map — {hm.xKey}{!single ? ` × ${hm.yKey}` : ''} profile
        </h4>
        <span className="font-mono text-[9px] text-[#4b5a72]">mean {objective} · hover cells for detail</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 220 }}>
        {!single &&
          hm.ys.map((y, yi) => (
            <text key={y} x={padL - 4} y={padT + yi * cellH + 14} textAnchor="end" fontSize="8" fill="#4b5a72" fontFamily="monospace">
              {+y.toFixed(4)}
            </text>
          ))}
        {hm.xs.map((x, xi) => (
          <text key={x} x={padL + xi * cellW + cellW / 2} y={padT - 5} textAnchor="middle" fontSize="8" fill="#4b5a72" fontFamily="monospace">
            {+x.toFixed(4)}
          </text>
        ))}
        {hm.cells.map((c) => {
          const xi = hm.xs.indexOf(c.x)
          const yi = single ? 0 : hm.ys.indexOf(c.y)
          if (xi < 0 || yi < 0) return null
          return (
            <g key={`${c.x}|${c.y}`}>
              <rect
                x={padL + xi * cellW}
                y={padT + yi * cellH}
                width={cellW - 2}
                height={cellH - 2}
                rx={2}
                fill={cellColor(c.value)}
              >
                <title>
                  {hm.xKey}={c.x}
                  {single ? '' : ` ${hm.yKey}=${c.y}`} · {c.value === null ? 'no qualified trades' : `${objective} ${c.value.toFixed(2)}`} · {c.trades} trades · win {c.winRate.toFixed(0)}%
                </title>
              </rect>
              {c.value !== null && (
                <text
                  x={padL + xi * cellW + (cellW - 2) / 2}
                  y={padT + yi * cellH + 13}
                  textAnchor="middle"
                  fontSize="7.5"
                  fill={Math.abs(c.value) / maxAbs > 0.45 ? '#04121c' : '#7c8aa5'}
                  fontFamily="monospace"
                >
                  {c.value >= 1000 || c.value <= -1000 ? `${(c.value / 1000).toFixed(1)}k` : c.value.toFixed(1)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------- promote

function PromoteBar({ disabled, label, onClick }: { disabled: boolean; label: string; onClick: () => void }) {
  return (
    <Button onClick={onClick} disabled={disabled} className="h-8 bg-emerald-600 px-3 text-[11px] font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40">
      🚀 {label}
    </Button>
  )
}

function PromoteBotDialog({
  asset,
  tf,
  strategy,
  params,
  stake,
  expiryBars,
  onClose,
}: {
  asset: string
  tf: Timeframe
  strategy: StrategyInfo
  params: Record<string, number | string>
  stake: string
  expiryBars: string
  onClose: () => void
}) {
  const [name, setName] = useState(`${strategy.name} · ${asset}`)
  const [botStake, setBotStake] = useState(stake)
  const [botExpiry, setBotExpiry] = useState(expiryBars)
  const [minScore, setMinScore] = useState('0')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setStatus('')
    try {
      const res = await osPost<{ ok: boolean; error?: string }>('/bot_save', {
        name,
        enabled: false,
        watchlist: [asset],
        strategyId: strategy.id,
        tf,
        params,
        kind: 'binary',
        stake: Number(botStake) || 10,
        expiryBars: Number(botExpiry) || 1,
        minScore: Number(minScore) || 0,
        direction: 'both',
        regime: 'all',
        maxOpen: 3,
        cooldownSec: 60,
      })
      if (res.ok) {
        setStatus('bot created (disarmed) — arm it in the Autopilot panel')
        setTimeout(onClose, 1400)
      } else setStatus(res.error ?? 'save failed')
    } catch (err) {
      setStatus((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md space-y-3 rounded-xl border border-[#1c2739] bg-[#0b111c] p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-bold text-[#dbe4f0]">Promote to Autopilot bot</h3>
          <button onClick={onClose} className="text-[#4b5a72] hover:text-[#dbe4f0]">✕</button>
        </div>
        <div className="rounded-lg border border-[#1c2739] bg-[#101828] p-2.5">
          <div className="font-mono text-[10px] text-[#7c8aa5]">
            {strategy.id} on <span className="text-cyan-300">{asset}</span> {tf} · binary
          </div>
          <div className="mt-1.5"><ParamChips params={params} /></div>
        </div>
        <Field label="Bot name">
          <Input value={name} onChange={(e) => setName(e.target.value)} className={`w-full ${inCls} text-left`} />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Stake $">
            <Input value={botStake} onChange={(e) => setBotStake(e.target.value)} className={inCls} />
          </Field>
          <Field label="Expiry bars">
            <Input value={botExpiry} onChange={(e) => setBotExpiry(e.target.value)} className={inCls} />
          </Field>
          <Field label="Min score">
            <Input value={minScore} onChange={(e) => setMinScore(e.target.value)} className={inCls} />
          </Field>
        </div>
        <p className="font-mono text-[9px] leading-relaxed text-[#4b5a72]">
          the bot starts DISARMED so you can review it in Autopilot first. min score 0 takes every signal — exactly what the backtest measured.
        </p>
        {status && <div className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1.5 font-mono text-[10px] text-cyan-300">{status}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} className="h-8 border-[#1c2739] bg-transparent text-[11px] text-[#7c8aa5] hover:bg-[#101828] hover:text-[#dbe4f0]">
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy} className="h-8 bg-emerald-600 px-4 text-[11px] font-semibold text-white hover:bg-emerald-500">
            {busy ? 'Creating…' : 'Create bot'}
          </Button>
        </div>
      </div>
    </div>
  )
}
