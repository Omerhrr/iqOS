'use client'

// IQAIR//OS - AI Learning Lab
// The agent studies a pair: it mines the candle history for edge-bearing
// events across candlestick / bar / Heiken Ashi / line / invented-indicator
// families, composes the survivors into a strategy spec, backtests it (with
// an honest holdout split) and can deploy it straight to the bot fleet - the
// learned spec becomes a first-class strategyId (custom:<id>) the autopilot
// trades, compound plans included.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AssetRow, LabLearnResult, LabSignalDef, LabSimMetrics, LabSpec, LabStrategyRow, Timeframe, TradeKind } from '@/lib/os/client'
import { fmtMoney, osGet, osPost } from '@/lib/os/client'
import { TIMEFRAMES } from '@/lib/os/client'

type Basis = 'candles' | 'heikin' | 'kalman' | 'typical' | 'smoothed'
const BASIS_OPTIONS: { value: Basis; label: string }[] = [
  { value: 'candles', label: 'raw candles' },
  { value: 'heikin', label: 'heiken-ashi' },
  { value: 'kalman', label: 'kalman-smoothed' },
  { value: 'typical', label: 'typical-price (HLC3)' },
  { value: 'smoothed', label: 'sma-smoothed (3-bar)' },
]

// Same searchable-combobox pattern as Backtest Lab's StrategyPicker -
// a plain <select> with 60+ pairs in it meant scrolling through an
// alphabetical wall to find one; this filters as you type instead.
function AssetPicker({ tickers, value, onChange }: { tickers: string[]; value: string; onChange: (t: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tickers
    return tickers.filter((t) => t.toLowerCase().includes(q))
  }, [tickers, query])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlight(0)
    }
  }, [open])

  const pick = (t: string) => {
    onChange(t)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative w-28">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center justify-between rounded border border-[#1c2739] bg-[#101828] px-2 text-left font-mono text-[11px] text-[#dbe4f0]"
      >
        <span className="truncate">{value}</span>
        <span className="ml-1 shrink-0 text-[#4b5a72]">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+2px)] z-20 w-48 rounded border border-[#1c2739] bg-[#0b111c] shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setHighlight((h) => Math.min(h + 1, filtered.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setHighlight((h) => Math.max(h - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (filtered[highlight]) pick(filtered[highlight])
              } else if (e.key === 'Escape') {
                setOpen(false)
              }
            }}
            placeholder="Search pairs…"
            className="w-full border-b border-[#1c2739] bg-[#101828] px-2 py-1.5 font-mono text-[11px] text-[#dbe4f0] outline-none"
          />
          <div className="max-h-64 overflow-auto py-1">
            {filtered.length === 0 && <div className="px-2 py-1.5 font-mono text-[11px] text-[#4b5a72]">No matches</div>}
            {filtered.map((t, i) => (
              <div
                key={t}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(t)}
                className={`cursor-pointer px-2 py-1.5 font-mono text-[11px] ${i === highlight ? 'bg-[#1c2739] text-[#dbe4f0]' : 'text-[#9aa8bd]'} ${t === value ? 'border-l-2 border-cyan-400' : ''}`}
              >
                {t}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

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
  mtf: 'text-cyan-300 border-cyan-500/40 bg-cyan-500/10',
}

// Every field read here beyond the pre-existing core metrics was added
// alongside a backend deploy - the frontend (iqos-web) and backend
// (iqos-kernel) are two separately-rebuilt Docker services, so there is
// always a window where one has redeployed and the other hasn't yet. A
// response from the not-yet-rebuilt kernel simply omits the new fields
// (undefined, not null/0), so every access below falls back to a safe
// default instead of assuming the field exists.

/** "learned 3h ago" / "learned 2d ago" - the kernel re-mines a saved spec on
 * its own every ~6h (see lab.ts's relearnSweep), so this is what tells you
 * at a glance whether that's actually been happening for a given strategy,
 * without digging into logs. */
function staleLabel(updatedTs: number): string {
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - updatedTs)
  if (ageSec < 3600) return `learned ${Math.max(1, Math.round(ageSec / 60))}m ago`
  if (ageSec < 86400) return `learned ${Math.round(ageSec / 3600)}h ago`
  return `learned ${Math.round(ageSec / 86400)}d ago`
}

function MetricStrip({ label, m, breakeven }: { label: string; m: LabSimMetrics | null; breakeven: number }) {
  if (!m) return null
  const good = m.winRate >= breakeven
  const ciLow = m.winRateCiLow ?? 0
  const ciHigh = m.winRateCiHigh ?? 0
  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2.5">
      <div className="text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
      <div className="mt-1 grid grid-cols-3 gap-x-3 gap-y-1 font-mono text-[11px]">
        <span className="text-[#7c8aa5]">
          trades{' '}
          <span className="text-[#dbe4f0]">{m.trades}</span>
          {m.lowSample && (
            <span className="ml-1 text-amber-400" title="fewer than 30 trades - low statistical confidence">⚠</span>
          )}
        </span>
        <span className="text-[#7c8aa5]">
          win{' '}
          <span className={good ? 'text-emerald-400' : 'text-rose-400'} title={`95% CI ${ciLow.toFixed(0)}–${ciHigh.toFixed(0)}%`}>
            {m.winRate.toFixed(1)}%
          </span>
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
        <span className="col-span-3 text-[10px] text-[#4b5a72]">
          95% CI on win rate: {ciLow.toFixed(0)}–{ciHigh.toFixed(0)}%
        </span>
      </div>
    </div>
  )
}

const REGIME_STYLE: Record<string, string> = {
  TRENDING: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  RANGING: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
  VOLATILE: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  MIXED: 'text-[#7c8aa5] border-[#1c2739] bg-[#101828]',
}

function FoldsStrip({ folds, foldsProfitable, breakeven }: { folds: LabSimMetrics[] | undefined; foldsProfitable: number | undefined; breakeven: number }) {
  if (!folds?.length) return null
  const done = foldsProfitable ?? 0
  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2.5">
      <div className="flex items-center justify-between">
        <div className="text-[9px] uppercase tracking-wider text-[#4b5a72]">
          out-of-sample folds (last 40%, same spec replayed with no re-tuning)
        </div>
        <span className={`font-mono text-[10px] font-bold ${done >= Math.ceil(folds.length / 2) ? 'text-emerald-400' : 'text-rose-400'}`}>
          {done}/{folds.length} profitable
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-1.5">
        {folds.map((f, i) => (
          <div key={i} className="rounded border border-[#141d2e] bg-[#0d1420] px-1.5 py-1 font-mono text-[10px]">
            <div className="text-[8px] uppercase tracking-wider text-[#4b5a72]">fold {i + 1}</div>
            <div className={f.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{f.netPnl >= 0 ? '+' : ''}{fmtMoney(f.netPnl)}</div>
            <div className={f.winRate >= breakeven ? 'text-emerald-400/80' : 'text-rose-400/80'}>{f.winRate.toFixed(0)}% · {f.trades}t</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function AILabPanel({ assets, onError, refreshBots }: AILabPanelProps) {
  const [asset, setAsset] = useState('EURUSD')
  const [tf, setTf] = useState<Timeframe>('1m')
  const [basis, setBasis] = useState<Basis>('candles')
  const [bars, setBars] = useState(1200)
  const [horizon, setHorizon] = useState(1)
  const [minSamples, setMinSamples] = useState(30)
  const [minEdge, setMinEdge] = useState(1.5)
  const [payout, setPayout] = useState(0.7)
  const [maxSignals, setMaxSignals] = useState(8)
  const [learning, setLearning] = useState(false)
  const [result, setResult] = useState<LabLearnResult | null>(null)
  // Which measured signals (by key) are checked into the deployed spec. Seeded
  // to whatever the auto-selector picked each time a fresh learn() result
  // comes back, but the user can tick/untick any row from here on - including
  // ones the algorithm excluded (thin sample, lost the family slot, etc.) or
  // unticking ones it kept.
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())
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

  const toggleSignal = (key: string) => {
    setCheckedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // The spec actually wired up to "save to library" / "deploy as bot" - built
  // from whichever rows are checked, not from the algorithm's own pick. A
  // checked row that the auto-selector excluded (dash in the weight column)
  // gets the same Wilson-haircut weight formula the backend uses for anything
  // it DID select, so a manually-added thin-sample signal still casts a vote
  // sized to how trustworthy its edge actually is, not a flat default.
  const effectiveSpec: LabSpec | null = useMemo(() => {
    if (!result?.spec) return null
    const chosen = result.signals.filter((s) => checkedKeys.has(s.key))
    if (!chosen.length) return null
    const signals: LabSignalDef[] = chosen.map((s) => ({
      ...s.def,
      weight: s.selected ? s.weight : Math.max(6, Math.min(50, Math.round(Math.max(0.5, s.edgeLB) * 4))),
    })) as LabSignalDef[]
    return {
      ...result.spec,
      signals,
      minVotes: signals.length >= 3 ? 2 : 1,
    }
  }, [result, checkedKeys])

  const learn = async () => {
    setLearning(true)
    setResult(null)
    setSavedId(null)
    try {
      const res = await osPost<LabLearnResult>('/lab_learn', { asset, tf, basis, bars, horizon, minSamples, minEdge, maxSignals, payout })
      setResult(res)
      setCheckedKeys(new Set(res.signals.filter((s) => s.selected).map((s) => s.key)))
      const basisSuffix = { candles: '', heikin: ' HA', kalman: ' KAL', typical: ' TYP', smoothed: ' SMA' }[basis]
      setSavedName(`${asset} ${tf} Lab${basisSuffix}`)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setLearning(false)
    }
  }

  const saveToLibrary = async () => {
    if (!effectiveSpec || !result) return
    try {
      const res = await osPost<{ ok: boolean; id: string }>('/lab_save', {
        name: savedName || `${asset} ${tf} Lab`,
        spec: effectiveSpec,
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
    if (!id && effectiveSpec && result) {
      // deploy straight from a fresh learn: persist first (whatever's checked)
      try {
        const res = await osPost<{ ok: boolean; id: string }>('/lab_save', {
          name: savedName || `${asset} ${tf} Lab`,
          spec: effectiveSpec,
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
          // Match the payout the strategy was actually learned/validated at
          // (was hardcoded to 70 regardless of the `payout` used for
          // learning - a strategy validated at 85% payout got deployed with
          // a compounding plan capped as if it were 70%, understating what
          // it was proven against).
          payoutCap: Math.round(payout * 100),
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
    // Use the saved row's OWN asset/tf, not whatever pair the learn form
    // currently has selected - the library holds strategies learned on
    // different pairs/timeframes, and re-backtesting against the wrong
    // instrument silently produced meaningless numbers.
    const row = library.find((r) => r.id === id)
    try {
      await osPost('/lab_backtest', { id, asset: row?.asset ?? asset, tf: row?.tf ?? tf, payout })
      loadLibrary()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const [relearning, setRelearning] = useState<string | null>(null)
  const relearnRow = async (id: string) => {
    setRelearning(id)
    try {
      const res = await osPost<{ ok: boolean; decayed?: boolean; error?: string }>('/lab_relearn', { id })
      if (!res.ok) onError(res.error ?? 're-learn failed')
      loadLibrary()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setRelearning(null)
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
            <AssetPicker tickers={tickers.length ? tickers : ['EURUSD']} value={asset} onChange={setAsset} />
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
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">basis</span>
            <select
              value={basis}
              onChange={(e) => setBasis(e.target.value as Basis)}
              className="h-7 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0]"
              title="what the agent reads: raw candles, Heiken-Ashi, a Kalman-smoothed trend series, typical-price (HLC3), or a 3-bar SMA smooth - outcomes always settle on real prices"
            >
              {BASIS_OPTIONS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <NumField label="bars" value={bars} onChange={setBars} w="w-16" />
          <NumField label="horizon" value={horizon} onChange={setHorizon} w="w-12" />
          <NumField label="min n" value={minSamples} onChange={setMinSamples} w="w-14" />
          <NumField label="min edge %" value={minEdge} onChange={setMinEdge} step={0.5} w="w-16" />
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]" title="the real payout to validate against - matches whatever this instrument actually pays, not just the two most common tiers">payout %</span>
            <Input
              type="number"
              min={50}
              max={95}
              step={1}
              value={Math.round(payout * 100)}
              onChange={(e) => setPayout(Math.max(0.5, Math.min(0.95, Number(e.target.value) / 100)))}
              className="h-7 w-16 border-[#1c2739] bg-[#101828] font-mono text-[11px] text-[#dbe4f0]"
            />
          </label>
          <NumField label="max signals" value={maxSignals} onChange={setMaxSignals} w="w-12" />
          <Button onClick={() => void learn()} disabled={learning} className="h-7 bg-cyan-600 px-3 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-cyan-500 disabled:opacity-50">
            {learning ? 'mining...' : 'learn this pair'}
          </Button>
        </div>
        <p className="mt-2 text-[10px] leading-snug text-[#7c8aa5]">
          Mines candlestick patterns, wide-range bar formations, Heiken Ashi structures, line breaks (Donchian / HH-HL), multi-timeframe EMA-trend agreement (resampled 5x/15x) and its own invented indicators (RSI, BB %B, z-score, Donchian position, MACD-z, slope, streak, wick bias, EMA spread, HA distance, close position) - then weights the survivors by their Wilson-score confidence-adjusted edge (not just the raw win rate, so a lucky small sample can&apos;t outrank a well-sampled one) and backtests the composition. The <span className="text-[#aab6cc]">basis</span> switch picks what every signal actually reads: raw candles, Heiken-Ashi, a Kalman-smoothed trend line, typical-price (HLC3, folds the whole bar&apos;s range into one number), or a plain 3-bar SMA smooth - whichever basis, outcomes always settle on real prices and the deployed bot trades the same basis it learned on. Thin history auto-relaxes the min-samples floor instead of failing. Saved strategies are automatically re-learned every ~6h to catch decay (see the library below).
        </p>
      </div>

      {/* result */}
      {result && (
        <div className="space-y-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
          <div className={`rounded border px-2 py-1.5 font-mono text-[11px] ${result.ok ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300' : 'border-amber-500/30 bg-amber-500/5 text-amber-300'}`}>{result.note}</div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-[#4b5a72]">
            <span>
              {result.asset} · {result.tf} ·{' '}
              <span className={result.basis !== 'candles' ? 'text-emerald-300' : ''}>
                {BASIS_OPTIONS.find((b) => b.value === result.basis)?.label ?? 'raw candles'} basis
              </span>{' '}
              · {result.candlesTested} bars · horizon {result.horizon} · min n {result.minSamples} · min edge {result.minEdge}pts
            </span>
            {result.regime && (
              <span className={`rounded border px-1.5 py-0.5 text-[9px] uppercase ${REGIME_STYLE[result.regime] ?? REGIME_STYLE.MIXED}`} title="market regime detected over the learned window">
                {result.regime.toLowerCase()}
              </span>
            )}
          </div>
          {result.confluenceWeak && (
            <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 font-mono text-[10px] text-amber-300">
              ⚠ confluence guard degraded: fewer than 3 signals qualified, so minVotes dropped to 1 - a single signal firing alone is enough to trade, not multiple signals agreeing.
            </div>
          )}

          {/* discovery table */}
          <div className="overflow-x-auto rounded-lg border border-[#141d2e]">
            <table className="w-full font-mono text-[11px]">
              <thead>
                <tr className="border-b border-[#141d2e] text-left text-[9px] uppercase tracking-wider text-[#4b5a72]">
                  <th className="px-2 py-1.5" title="only checked signals are written into the saved/deployed spec">use</th>
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
                {result.signals.map((s) => {
                  const checked = checkedKeys.has(s.key)
                  return (
                    <tr key={s.key} className={`border-b border-[#0d1420] ${checked ? 'bg-cyan-500/5' : ''}`}>
                      <td className="px-2 py-1">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSignal(s.key)}
                          className="accent-cyan-500"
                          title={s.selected ? 'auto-selected by the learner' : "not auto-selected (min-n / min-edge / family slot) - check to include it anyway"}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <span className={`rounded border px-1 py-0.5 text-[8px] uppercase ${KIND_CHIP[s.kind] ?? 'text-[#7c8aa5] border-[#1c2739]'}`}>{s.kind}</span>
                      </td>
                      <td className="px-2 py-1 text-[#dbe4f0]">{s.label}</td>
                      <td className={`px-2 py-1 ${s.dir === 'call' ? 'text-emerald-400' : 'text-rose-400'}`}>{s.dir.toUpperCase()}</td>
                      <td className="px-2 py-1 text-[#7c8aa5]">{s.n}</td>
                      <td className="px-2 py-1 text-[#dbe4f0]">{s.winRate.toFixed(1)}</td>
                      <td className={`px-2 py-1 ${s.edgePts >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{s.edgePts >= 0 ? '+' : ''}{s.edgePts.toFixed(1)}pts</td>
                      <td className="px-2 py-1 text-cyan-300">
                        {checked ? (s.selected ? s.weight : Math.max(6, Math.min(50, Math.round(Math.max(0.5, s.edgeLB) * 4)))) : '-'}
                      </td>
                    </tr>
                  )
                })}
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
                  minVotes <span className="text-cyan-300">{effectiveSpec?.minVotes ?? result.spec.minVotes}</span>
                </span>
                <span className="rounded border border-[#1c2739] bg-[#101828] px-1.5 py-0.5">
                  signals checked <span className="text-cyan-300">{checkedKeys.size}</span> / auto-picked {result.spec.signals.length}
                </span>
                <span className="rounded border border-[#1c2739] bg-[#101828] px-1.5 py-0.5">
                  threshold sweep: {result.calibration.thresholds.map((t) => `${t.minScore}→${t.trades}t/${t.winRate.toFixed(0)}%`).join(' · ')}
                </span>
              </div>
              {checkedKeys.size > 0 && checkedKeys.size !== result.spec.signals.length && (
                <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 font-mono text-[10px] text-amber-300">
                  ⚠ signal selection edited by hand - minScore/calibration below still reflect the learner&apos;s original {result.spec.signals.length}-signal run, not this {checkedKeys.size}-signal mix. Re-learn after saving if you want the threshold/minScore recalibrated against your picks.
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                <MetricStrip label="backtest - full sample" m={result.backtest} breakeven={result.breakevenWinRate} />
                <MetricStrip label="backtest - holdout (last 30%, unseen in calibration)" m={result.holdout} breakeven={result.breakevenWinRate} />
              </div>

              <FoldsStrip folds={result.holdoutFolds} foldsProfitable={result.foldsProfitable} breakeven={result.breakevenWinRate} />

              <div className="flex flex-wrap items-center gap-2">
                <Input value={savedName} onChange={(e) => setSavedName(e.target.value)} placeholder="strategy name" className="h-7 w-48 border-[#1c2739] bg-[#101828] font-mono text-[11px] text-[#dbe4f0]" />
                <Button onClick={() => void saveToLibrary()} disabled={!!savedId || !effectiveSpec} variant="outline" className="h-7 border-[#1c2739] px-3 text-[10px] uppercase tracking-wider text-[#7c8aa5] hover:text-cyan-300 disabled:opacity-40">
                  {savedId ? `saved: ${savedId}` : `save to library (${checkedKeys.size} signals)`}
                </Button>
                <Button onClick={() => effectiveSpec && void openDeploy('', effectiveSpec.name)} disabled={!effectiveSpec} className="h-7 bg-emerald-600 px-3 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-emerald-500 disabled:opacity-40">
                  deploy as bot
                </Button>
              </div>

              <details className="rounded border border-[#141d2e] bg-[#0d1420] p-2">
                <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-[#4b5a72]">spec json (what will be saved/deployed - {checkedKeys.size} checked signals)</summary>
                <pre className="mt-1 max-h-48 overflow-auto font-mono text-[10px] leading-relaxed text-[#aab6cc]">{JSON.stringify(effectiveSpec, null, 2)}</pre>
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
                    {r.stats?.decayed && (
                      <span className="rounded border border-rose-500/40 bg-rose-500/10 px-1 py-0.5 font-mono text-[8px] uppercase text-rose-300" title="the auto re-learn sweep found this spec no longer clears its own filters / can't beat breakeven on fresh data - any bot trading it was auto-disarmed">
                        decayed
                      </span>
                    )}
                    <span className="font-mono text-[8px] text-[#3d4d66]" title={new Date(r.updatedTs * 1000).toLocaleString()}>
                      {staleLabel(r.updatedTs)}
                    </span>
                  </div>
                  <div className="font-mono text-[9px] text-[#4b5a72]">
                    {r.id} · {r.asset} {r.tf} · {r.spec.signals.length} signals · minScore {r.spec.minScore}
                    {r.stats?.backtest ? ` · backtest ${r.stats.backtest.trades}t @ ${r.stats.backtest.winRate.toFixed(1)}% (PF ${r.stats.backtest.profitFactor.toFixed(2)})` : ''}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={relearning === r.id}
                    className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5] hover:text-cyan-400 disabled:opacity-40"
                    onClick={() => void relearnRow(r.id)}
                    title="re-mine this pair's latest history and refresh this spec's signals/weights/calibration in place"
                  >
                    {relearning === r.id ? 're-learning...' : 're-learn now'}
                  </Button>
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
