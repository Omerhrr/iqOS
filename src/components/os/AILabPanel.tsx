'use client'

// IQAIR//OS - AI Learning Lab
// The agent studies a pair: it mines the candle history for edge-bearing
// events across candlestick / bar / Heiken Ashi / line / invented-indicator
// families, composes the survivors into a strategy spec, backtests it (with
// an honest holdout split) and can deploy it straight to the bot fleet - the
// learned spec becomes a first-class strategyId (custom:<id>) the autopilot
// trades, compound plans included.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AssetRow, LabLearnResult, LabSimMetrics, LabStrategyRow, Timeframe, TradeKind } from '@/lib/os/client'
import { fmtMoney, osGet, osPost } from '@/lib/os/client'
import { TIMEFRAMES } from '@/lib/os/client'

interface AILabPanelProps {
  assets: AssetRow[]
  onError: (m: string) => void
  refreshBots: () => void
}

const KIND_CHIP: Record<string, string> = {
  candle: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  bar: 'text-violet-300 border-violet-500/40 bg-violet-500/10',
  ha: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  line: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
  indicator: 'text-fuchsia-300 border-fuchsia-500/40 bg-fuchsia-500/10',
}

function MetricStrip({ label, m, breakeven }: { label: string; m: LabSimMetrics | null; breakeven: number }) {
  if (!m) return null
  const good = m.winRate >= breakeven
  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2.5">
      <div className="text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
      <div className="mt-1 grid grid-cols-3 gap-x-3 gap-y-1 font-mono text-[11px]">
        <span className="text-[#7c8aa5]">
          trades <span className="text-[#dbe4f0]">{m.trades}</span>
        </span>
        <span className="text-[#7c8aa5]">
          win <span className={good ? 'text-emerald-400' : 'text-rose-400'}>{m.winRate.toFixed(1)}%</span>
          <span className="text-[10px] text-[#4b5a72]"> / BE {breakeven.toFixed(1)}%</span>
        </span>
        <span className="text-[#7c8aa5]">
          P/L <span className={m.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{m.netPnl >= 0 ? '+' : ''}{fmtMoney(m.netPnl)}</span>
        </span>
        <span className="text-[#7c8aa5]">
          PF <span className="text-[#dbe4f0]">{m.profitFactor.toFixed(2)}</span>
        </span>
        <span className="text-[#7c8aa5]">
          exp <span className={m.expectancy >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{m.expectancy >= 0 ? '+' : ''}{fmtMoney(m.expectancy)}</span>
        </span>
        <span className="text-[#7c8aa5]">
          maxDD <span className="text-rose-400">-{fmtMoney(m.maxDrawdown)}</span>
        </span>
      </div>
    </div>
  )
}

export default function AILabPanel({ assets, onError, refreshBots }: AILabPanelProps) {
  const [asset, setAsset] = useState('EURUSD')
  const [tf, setTf] = useState<Timeframe>('1m')
  const [bars, setBars] = useState(1200)
  const [horizon, setHorizon] = useState(1)
  const [minSamples, setMinSamples] = useState(30)
  const [minEdge, setMinEdge] = useState(1.5)
  const [payout, setPayout] = useState(0.7)
  const [maxSignals, setMaxSignals] = useState(8)
  const [learning, setLearning] = useState(false)
  const [result, setResult] = useState<LabLearnResult | null>(null)
  const [savedName, setSavedName] = useState('')
  const [savedId, setSavedId] = useState<string | null>(null)
  const [library, setLibrary] = useState<LabStrategyRow[]>([])
  const [deployFor, setDeployFor] = useState<{ id: string; name: string } | null>(null)
  const [deploying, setDeploying] = useState(false)
  // deploy form
  const [botName, setBotName] = useState('')
  const [stake, setStake] = useState(10)
  const [kind, setKind] = useState<TradeKind>('digital')
  const [expiryMin, setExpiryMin] = useState(15)
  const [maxOpen, setMaxOpen] = useState(1)
  const [cooldownSec, setCooldownSec] = useState(60)
  const [minScore, setMinScore] = useState(0)
  const [useCompound, setUseCompound] = useState(true)
  const [seed, setSeed] = useState(1)
  const [periods, setPeriods] = useState(7)
  const [deriskAfter, setDeriskAfter] = useState(5)
  const [deriskPct, setDeriskPct] = useState(50)

  const loadLibrary = useCallback(() => {
    void osGet<{ ok: boolean; strategies: LabStrategyRow[] }>('/lab_list')
      .then((d) => setLibrary(d.strategies ?? []))
      .catch((e) => onError((e as Error).message))
  }, [onError])

  useEffect(() => {
    loadLibrary()
  }, [loadLibrary])

  const tickers = assets.map((a) => a.ticker)

  const learn = async () => {
    setLearning(true)
    setResult(null)
    setSavedId(null)
    try {
      const res = await osPost<LabLearnResult>('/lab_learn', { asset, tf, bars, horizon, minSamples, minEdge, maxSignals, payout })
      setResult(res)
      setSavedName(`${asset} ${tf} Lab`)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setLearning(false)
    }
  }

  const saveToLibrary = async () => {
    if (!result?.spec) return
    try {
      const res = await osPost<{ ok: boolean; id: string }>('/lab_save', {
        name: savedName || `${asset} ${tf} Lab`,
        spec: result.spec,
        asset: result.asset,
        tf: result.tf,
        stats: { backtest: result.backtest, holdout: result.holdout, breakeven: result.breakevenWinRate },
      })
      setSavedId(res.id)
      loadLibrary()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const openDeploy = async (id: string, name: string) => {
    let targetId = id
    if (!id && result?.spec) {
      // deploy straight from a fresh learn: persist first
      try {
        const res = await osPost<{ ok: boolean; id: string }>('/lab_save', {
          name: savedName || `${asset} ${tf} Lab`,
          spec: result.spec,
          asset: result.asset,
          tf: result.tf,
          stats: { backtest: result.backtest, holdout: result.holdout, breakeven: result.breakevenWinRate },
        })
        targetId = res.id
        setSavedId(res.id)
        loadLibrary()
      } catch (e) {
        onError((e as Error).message)
        return
      }
    }
    setDeployFor({ id: targetId, name })
    setBotName(`${name} Bot`.slice(0, 32))
  }

  const deploy = async () => {
    if (!deployFor) return
    setDeploying(true)
    try {
      const body: Record<string, unknown> = {
        name: botName || `${deployFor.name} Bot`,
        watchlist: [asset],
        strategyId: deployFor.id,
        tf,
        kind,
        stake,
        expirySec: kind === 'digital' ? Math.max(1, expiryMin) * 60 : undefined,
        maxOpen,
        cooldownSec,
        minScore,
        enabled: true,
      }
      if (useCompound) {
        body.stakePlan = {
          kind: 'compound',
          base: seed,
          rollPct: 100,
          payoutCap: 70,
          stopOnLoss: true,
          ...(periods > 0 ? { periods } : {}),
          ...(deriskAfter > 0 && deriskPct > 0 ? { deriskAfter, deriskPct } : {}),
          onComplete: 'halt',
        }
      }
      const res = await osPost<{ ok: boolean; bot?: { id: string }; error?: string }>('/bot_save', body)
      if (!res.ok) throw new Error(res.error ?? 'bot_save failed')
      setDeployFor(null)
      refreshBots()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setDeploying(false)
    }
  }

  const removeLab = async (id: string) => {
    try {
      await osPost('/lab_delete', { id })
      loadLibrary()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const backtestRow = async (id: string) => {
    try {
      await osPost('/lab_backtest', { id, asset, tf, payout })
      loadLibrary()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  return (
    <div className="space-y-3">
      {/* header + learn form */}
      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-cyan-300">AI Learning Lab</h3>
          <span className="font-mono text-[9px] text-[#4b5a72]">the agent studies a pair and builds its own strategy</span>
        </div>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">pair</span>
            <select value={asset} onChange={(e) => setAsset(e.target.value)} className="h-7 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0]">
              {(tickers.length ? tickers : ['EURUSD']).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">tf</span>
            <select value={tf} onChange={(e) => setTf(e.target.value as Timeframe)} className="h-7 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0]">
              {TIMEFRAMES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <NumField label="bars" value={bars} onChange={setBars} w="w-16" />
          <NumField label="horizon" value={horizon} onChange={setHorizon} w="w-12" />
          <NumField label="min n" value={minSamples} onChange={setMinSamples} w="w-14" />
          <NumField label="min edge %" value={minEdge} onChange={setMinEdge} step={0.5} w="w-16" />
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">payout</span>
            <select value={payout} onChange={(e) => setPayout(Number(e.target.value))} className="h-7 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0]">
              <option value={0.7}>70% (cap)</option>
              <option value={0.85}>85%</option>
            </select>
          </label>
          <NumField label="max signals" value={maxSignals} onChange={setMaxSignals} w="w-12" />
          <Button onClick={() => void learn()} disabled={learning} className="h-7 bg-cyan-600 px-3 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-cyan-500 disabled:opacity-50">
            {learning ? 'mining...' : 'learn this pair'}
          </Button>
        </div>
        <p className="mt-2 text-[10px] leading-snug text-[#7c8aa5]">
          Mines candlestick patterns, wide-range bar formations, Heiken Ashi structures, line breaks (Donchian / HH-HL) and its own invented indicators (RSI, BB %B, z-score, Donchian position, MACD-z, slope, streak, wick bias, EMA spread, HA distance, close position) - then weights the survivors by measured edge and backtests the composition.
        </p>
      </div>

      {/* result */}
      {result && (
        <div className="space-y-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
          <div className={`rounded border px-2 py-1.5 font-mono text-[11px] ${result.ok ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300' : 'border-amber-500/30 bg-amber-500/5 text-amber-300'}`}>{result.note}</div>
          <div className="font-mono text-[10px] text-[#4b5a72]">
            {result.asset} · {result.tf} · {result.candlesTested} bars · horizon {result.horizon} · min n {result.minSamples} · min edge {result.minEdge}pts
          </div>

          {/* discovery table */}
          <div className="overflow-x-auto rounded-lg border border-[#141d2e]">
            <table className="w-full font-mono text-[11px]">
              <thead>
                <tr className="border-b border-[#141d2e] text-left text-[9px] uppercase tracking-wider text-[#4b5a72]">
                  <th className="px-2 py-1.5">family</th>
                  <th className="px-2 py-1.5">signal</th>
                  <th className="px-2 py-1.5">dir</th>
                  <th className="px-2 py-1.5">n</th>
                  <th className="px-2 py-1.5">win%</th>
                  <th className="px-2 py-1.5">edge</th>
                  <th className="px-2 py-1.5">weight</th>
                </tr>
              </thead>
              <tbody>
                {result.signals.map((s) => (
                  <tr key={s.key} className={`border-b border-[#0d1420] ${s.selected ? 'bg-cyan-500/5' : ''}`}>
                    <td className="px-2 py-1">
                      <span className={`rounded border px-1 py-0.5 text-[8px] uppercase ${KIND_CHIP[s.kind] ?? 'text-[#7c8aa5] border-[#1c2739]'}`}>{s.kind}</span>
                    </td>
                    <td className="px-2 py-1 text-[#dbe4f0]">{s.label}</td>
                    <td className={`px-2 py-1 ${s.dir === 'call' ? 'text-emerald-400' : 'text-rose-400'}`}>{s.dir.toUpperCase()}</td>
                    <td className="px-2 py-1 text-[#7c8aa5]">{s.n}</td>
                    <td className="px-2 py-1 text-[#dbe4f0]">{s.winRate.toFixed(1)}</td>
                    <td className={`px-2 py-1 ${s.edgePts >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{s.edgePts >= 0 ? '+' : ''}{s.edgePts.toFixed(1)}pts</td>
                    <td className="px-2 py-1 text-cyan-300">{s.selected ? s.weight : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.ok && result.spec && (
            <>
              <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-[#7c8aa5]">
                <span className="rounded border border-[#1c2739] bg-[#101828] px-1.5 py-0.5">
                  minScore <span className="text-cyan-300">{result.spec.minScore}</span>
                </span>
                <span className="rounded border border-[#1c2739] bg-[#101828] px-1.5 py-0.5">
                  minVotes <span className="text-cyan-300">{result.spec.minVotes}</span>
                </span>
                <span className="rounded border border-[#1c2739] bg-[#101828] px-1.5 py-0.5">
                  signals <span className="text-cyan-300">{result.spec.signals.length}</span>
                </span>
                <span className="rounded border border-[#1c2739] bg-[#101828] px-1.5 py-0.5">
                  threshold sweep: {result.calibration.thresholds.map((t) => `${t.minScore}→${t.trades}t/${t.winRate.toFixed(0)}%`).join(' · ')}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                <MetricStrip label="backtest - full sample" m={result.backtest} breakeven={result.breakevenWinRate} />
                <MetricStrip label="backtest - holdout (last 30%, unseen in calibration)" m={result.holdout} breakeven={result.breakevenWinRate} />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Input value={savedName} onChange={(e) => setSavedName(e.target.value)} placeholder="strategy name" className="h-7 w-48 border-[#1c2739] bg-[#101828] font-mono text-[11px] text-[#dbe4f0]" />
                <Button onClick={() => void saveToLibrary()} disabled={!!savedId} variant="outline" className="h-7 border-[#1c2739] px-3 text-[10px] uppercase tracking-wider text-[#7c8aa5] hover:text-cyan-300 disabled:opacity-40">
                  {savedId ? `saved: ${savedId}` : 'save to library'}
                </Button>
                <Button onClick={() => result.spec && void openDeploy('', result.spec.name)} className="h-7 bg-emerald-600 px-3 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-emerald-500">
                  deploy as bot
                </Button>
              </div>

              <details className="rounded border border-[#141d2e] bg-[#0d1420] p-2">
                <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-[#4b5a72]">spec json (what the agent learned)</summary>
                <pre className="mt-1 max-h-48 overflow-auto font-mono text-[10px] leading-relaxed text-[#aab6cc]">{JSON.stringify(result.spec, null, 2)}</pre>
              </details>
            </>
          )}
        </div>
      )}

      {/* deploy form */}
      {deployFor && (
        <div className="space-y-2 rounded-lg border border-emerald-600/40 bg-emerald-500/5 p-3">
          <div className="flex items-center justify-between">
            <h4 className="text-[12px] font-semibold text-emerald-300">Deploy &quot;{deployFor.name}&quot; as an autonomous bot</h4>
            <Button variant="outline" size="sm" className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5]" onClick={() => setDeployFor(null)}>
              cancel
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">bot name</span>
              <Input value={botName} onChange={(e) => setBotName(e.target.value)} className="h-7 w-40 border-[#1c2739] bg-[#101828] font-mono text-[11px] text-[#dbe4f0]" />
            </label>
            <NumField label="stake $" value={stake} onChange={setStake} w="w-16" />
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">kind</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as TradeKind)} className="h-7 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0]">
                {['binary', 'digital', 'turbo'].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            {kind === 'digital' && <NumField label="expiry min" value={expiryMin} onChange={setExpiryMin} w="w-14" />}
            <NumField label="max open" value={maxOpen} onChange={setMaxOpen} w="w-12" />
            <NumField label="cooldown s" value={cooldownSec} onChange={setCooldownSec} w="w-14" />
            <NumField label="min score" value={minScore} onChange={setMinScore} w="w-14" />
          </div>
          <label className="flex items-center gap-2 font-mono text-[11px] text-[#aab6cc]">
            <input type="checkbox" checked={useCompound} onChange={(e) => setUseCompound(e.target.checked)} className="accent-emerald-500" />
            ride a compounding plan on top ($ seed rolls on wins, payout capped 70%, one loss ends the cycle)
          </label>
          {useCompound && (
            <div className="flex flex-wrap items-end gap-2">
              <NumField label="seed $" value={seed} onChange={setSeed} w="w-14" />
              <NumField label="periods" value={periods} onChange={setPeriods} w="w-14" />
              <NumField label="derisk after #" value={deriskAfter} onChange={setDeriskAfter} w="w-16" />
              <NumField label="derisk %" value={deriskPct} onChange={setDeriskPct} w="w-14" />
              <span className="pb-1 font-mono text-[9px] text-[#4b5a72]">0 = unlimited / off</span>
            </div>
          )}
          <Button onClick={() => void deploy()} disabled={deploying} className="h-7 bg-emerald-600 px-4 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-emerald-500 disabled:opacity-50">
            {deploying ? 'deploying...' : 'create + arm bot'}
          </Button>
        </div>
      )}

      {/* library */}
      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
        <div className="flex items-center justify-between">
          <h4 className="text-[12px] font-semibold uppercase tracking-wider text-[#aab6cc]">Learned strategy library</h4>
          <span className="font-mono text-[9px] text-[#4b5a72]">{library.length} saved</span>
        </div>
        {library.length === 0 ? (
          <p className="mt-2 text-[11px] text-[#3d4d66]">Nothing learned yet - run &quot;learn this pair&quot; above, or ask the Copilot to study a pair for you.</p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {library.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#141d2e] bg-[#0d1420] px-2.5 py-1.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[11px] text-[#dbe4f0]">{r.spec.name}</span>
                    <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1 py-0.5 font-mono text-[8px] uppercase text-cyan-300">lab</span>
                  </div>
                  <div className="font-mono text-[9px] text-[#4b5a72]">
                    {r.id} · {r.asset} {r.tf} · {r.spec.signals.length} signals · minScore {r.spec.minScore}
                    {r.stats?.backtest ? ` · backtest ${r.stats.backtest.trades}t @ ${r.stats.backtest.winRate.toFixed(1)}% (PF ${r.stats.backtest.profitFactor.toFixed(2)})` : ''}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <Button variant="outline" size="sm" className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5] hover:text-emerald-400" onClick={() => void backtestRow(r.id)}>
                    re-backtest
                  </Button>
                  <Button variant="outline" size="sm" className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5] hover:text-emerald-400" onClick={() => void openDeploy(r.id, r.spec.name)}>
                    deploy
                  </Button>
                  <Button variant="outline" size="sm" className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5] hover:text-rose-400" onClick={() => void removeLab(r.id)}>
                    delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function NumField({ label, value, onChange, w = 'w-20', step = 1 }: { label: string; value: number; onChange: (v: number) => void; w?: string; step?: number }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</span>
      <Input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`h-7 ${w} border-[#1c2739] bg-[#101828] font-mono text-[11px] text-[#dbe4f0]`}
      />
    </label>
  )
}
