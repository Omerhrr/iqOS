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
import type { AssetRow, LabLearnResult, LabSignalDef, LabSimMetrics, LabSpec, LabStrategyRow, StrategyInfo, Timeframe, TradeKind } from '@/lib/os/client'
import { fmtMoney, osGet, osPost } from '@/lib/os/client'
import { TIMEFRAMES, TIMEFRAME_SECONDS, SIGNAL_TEMPLATES, labelOfSignal } from '@/lib/os/client'

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
  strategies: StrategyInfo[]
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
  group: 'text-orange-300 border-orange-500/40 bg-orange-500/10',
  builtin: 'text-lime-300 border-lime-500/40 bg-lime-500/10',
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

/** Human duration for a horizon-derived expiry in seconds - "60s", "5m", "1h30m". */
function fmtExpiry(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) {
    const m = Math.floor(sec / 60)
    const rem = sec % 60
    return rem ? `${m}m${rem}s` : `${m}m`
  }
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return m ? `${h}h${m}m` : `${h}h`
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

export default function AILabPanel({ assets, strategies, onError, refreshBots }: AILabPanelProps) {
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

  // ---- manual strategy builder: compose a spec by hand from the same
  // vocabulary the learner mines, instead of only ever getting one out of
  // "learn this pair". Saved/backtested/deployed through the exact same
  // endpoints a learned spec uses (normalizeSpec on the backend already
  // accepts any well-formed SignalDef, learned or hand-built). ----
  // independent pair/tf for this section - a strategy built here is
  // pair-agnostic (it's not mined from any one pair's history the way
  // "learn this pair" above is), so backtest/save/deploy get their OWN
  // selector instead of silently riding the "learn" section's pair/tf. This
  // used to just reuse the shared `asset`/`tf` state, which meant changing
  // this card's target pair meant hunting for the picker in a DIFFERENT
  // card above and easy to miss entirely - in practice everything here kept
  // running against whatever `asset` happened to default to (EURUSD).
  const [manualAsset, setManualAsset] = useState(asset)
  const [manualTf, setManualTf] = useState<Timeframe>(tf)
  const [manualSignals, setManualSignals] = useState<{ uid: string; def: LabSignalDef }[]>([])
  // Which rows are checked for "combine selected -> group" - the direct,
  // click-driven path to the AND/OR combination feature, so joining "Range
  // Sell Zone" + "Wide Bear Bar" + "RSI > 70" into one voting unit doesn't
  // require hand-writing JSON (the JSON editor below remains the escape
  // hatch for anything this can't express, e.g. editing a group's own
  // dir/weight or nesting it inside another group).
  const [manualSelected, setManualSelected] = useState<Set<string>>(new Set())
  const [manualGroupDir, setManualGroupDir] = useState<'call' | 'put'>('call')
  const [manualGroupWeight, setManualGroupWeight] = useState(20)
  const [manualGroupOp, setManualGroupOp] = useState<'and' | 'or'>('and')
  // Building a group straight from the template picker - the natural way to
  // ask for this ("pick Range Sell Zone, then pick Wide Bear Bar, then pick
  // RSI > 70, make those act as one"): check "combine into group", then
  // every "+ add signal" appends to this staging list instead of the main
  // one; "finish group" below folds the staged signals into one group row.
  // The row-select "combine selected" path further down stays too, for
  // grouping signals that are already in the list.
  const [manualGroupBuilding, setManualGroupBuilding] = useState(false)
  const [manualGroupPending, setManualGroupPending] = useState<LabSignalDef[]>([])
  const [manualTemplateIdx, setManualTemplateIdx] = useState(0)
  const [manualIsCandle, setManualIsCandle] = useState(false)
  const [manualCandleName, setManualCandleName] = useState('')
  // Pull a FULL builtin strategy (trading-core's STRATEGIES registry - RSI
  // reversion, MACD cross, the Markov/Kalman/Monte-Carlo ones, trend
  // structure pullback, all of it) in as one more combinable signal,
  // alongside the candle/bar/indicator vocabulary above - mutually
  // exclusive with "custom candlestick pattern" (both override the plain
  // template dropdown). Params are edited as raw JSON rather than a
  // per-field form - the registry's param shapes vary too much
  // strategy-to-strategy to build one generic field UI for all of them, and
  // this mirrors the "edit as json" escape hatch already used for specs.
  const [manualIsBuiltin, setManualIsBuiltin] = useState(false)
  const [manualBuiltinIdx, setManualBuiltinIdx] = useState(0)
  const [manualBuiltinParamsText, setManualBuiltinParamsText] = useState('{}')
  const [manualBuiltinParamsError, setManualBuiltinParamsError] = useState<string | null>(null)
  // A builtin strategy has no fixed "favors call" or "favors put" bias the
  // way a candle pattern or a bar variant does - most of them (Supertrend
  // Follow, Pattern Confluence, the Markov/Kalman ones...) genuinely trade
  // both sides depending on current market state, and the `dir` field below
  // just picks which of ITS OWN outputs counts as active for the role
  // you're assigning it in a group. This runs the real strategy live on the
  // picked pair/tf (same /run_strategy path the backtest lab and autopilot
  // bots use) so you can actually SEE which way it's reading right now
  // before deciding whether it belongs in a CALL-side or PUT-side group.
  const [manualBuiltinPreview, setManualBuiltinPreview] = useState<{ direction: 'call' | 'put' | 'none'; score: number; notes: string } | null>(null)
  const [manualBuiltinPreviewLoading, setManualBuiltinPreviewLoading] = useState(false)
  const [manualBuiltinPreviewError, setManualBuiltinPreviewError] = useState<string | null>(null)

  // Seed the params textarea with the selected strategy's own defaults the
  // moment builtin mode turns on (or once `strategies` finishes loading) -
  // without this it'd sit on the stale initial '{}' until the user manually
  // touched the dropdown.
  useEffect(() => {
    if (manualIsBuiltin && strategies[manualBuiltinIdx]) {
      setManualBuiltinParamsText(JSON.stringify(strategies[manualBuiltinIdx].defaults ?? {}, null, 2))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualIsBuiltin, strategies.length])

  // A stale preview (from a different strategy/pair/tf) is worse than no
  // preview - clear it the moment anything the preview depends on changes,
  // so a leftover "CALL" reading can never be mistaken for this strategy's
  // current read on the currently-selected pair.
  useEffect(() => {
    setManualBuiltinPreview(null)
    setManualBuiltinPreviewError(null)
  }, [manualBuiltinIdx, manualAsset, manualTf])
  const [manualDir, setManualDir] = useState<'call' | 'put'>(SIGNAL_TEMPLATES[0].dir)
  // Editable op/threshold for the selected indicator template - previously
  // a template's op/threshold were baked in and uneditable, so there was no
  // way to express a banded condition like "rangezone > 0.05 AND
  // rangezone < 0.07" as ONE rule; 'between'/'outside' plus a live
  // threshold2 field make that directly buildable here.
  const [manualOp, setManualOp] = useState<'>' | '<' | 'between' | 'outside'>('>')
  const [manualThreshold, setManualThreshold] = useState(0)
  const [manualThreshold2, setManualThreshold2] = useState(0)
  const [manualWeight, setManualWeight] = useState(10)
  const [manualName, setManualName] = useState('')
  const [manualBasis, setManualBasis] = useState<Basis>('candles')
  const [manualMinScore, setManualMinScore] = useState(45)
  const [manualMinVotes, setManualMinVotes] = useState(2)
  const [manualHorizon, setManualHorizon] = useState(1)
  const [manualBacktest, setManualBacktest] = useState<{ backtest: LabSimMetrics; holdout: LabSimMetrics; breakevenWinRate: number } | null>(null)
  const [manualBacktesting, setManualBacktesting] = useState(false)
  const [manualSavedId, setManualSavedId] = useState<string | null>(null)
  const [manualSaving, setManualSaving] = useState(false)
  const [manualDeploying, setManualDeploying] = useState(false)
  // Raw-JSON escape hatch: the row-by-row builder above can't express
  // everything the spec format actually supports (arbitrary signal counts,
  // fields the UI has no control for yet, specs generated elsewhere and
  // pasted in) - this lets the spec be edited directly as the JSON it
  // already is, same shape buildManualSpec() produces and lab_save/
  // lab_backtest already accept, so nothing new needed server-side.
  const [manualJsonMode, setManualJsonMode] = useState(false)
  const [manualJsonText, setManualJsonText] = useState('')
  const [manualJsonError, setManualJsonError] = useState<string | null>(null)

  const templatesByKind = useMemo(() => {
    const groups = new Map<string, { idx: number; label: string }[]>()
    SIGNAL_TEMPLATES.forEach((t, idx) => {
      const list = groups.get(t.kind) ?? []
      list.push({ idx, label: labelOfSignal(t) })
      groups.set(t.kind, list)
    })
    return groups
  }, [])

  // Any change to the spec's actual content invalidates a previous
  // save/backtest - without this, editing signals after saving left the
  // "saved: <id>" button permanently disabled while silently pointing at a
  // DIFFERENT, stale spec than the one now built.
  useEffect(() => {
    setManualSavedId(null)
    setManualBacktest(null)
  }, [manualSignals, manualMinScore, manualMinVotes, manualHorizon, manualBasis, manualName, manualAsset, manualTf])

  /** Runs the currently-selected builtin strategy LIVE on manualAsset/manualTf
   * (same /run_strategy path the backtest lab and autopilot bots use) so the
   * user can see which way it's actually reading right now, instead of
   * guessing at a `dir` to assign it when building a group. */
  const testBuiltinPreview = async () => {
    const strat = strategies[manualBuiltinIdx]
    if (!strat) return
    let params: Record<string, number | string> | undefined
    if (manualBuiltinParamsText.trim() && manualBuiltinParamsText.trim() !== '{}') {
      try {
        const parsed = JSON.parse(manualBuiltinParamsText)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed as Record<string, number | string>
        else {
          setManualBuiltinPreviewError('params must be a JSON object')
          return
        }
      } catch (e) {
        setManualBuiltinPreviewError(`invalid JSON: ${(e as Error).message}`)
        return
      }
    }
    setManualBuiltinPreviewLoading(true)
    setManualBuiltinPreviewError(null)
    try {
      const res = await osPost<{ ok: boolean; eval?: { direction: 'call' | 'put' | 'none'; score: number; notes: string }; error?: string }>('/run_strategy', {
        asset: manualAsset,
        tf: manualTf,
        strategy: strat.id,
        params,
      })
      if (!res.ok || !res.eval) throw new Error(res.error ?? 'preview failed')
      setManualBuiltinPreview(res.eval)
    } catch (e) {
      setManualBuiltinPreview(null)
      setManualBuiltinPreviewError((e as Error).message)
    } finally {
      setManualBuiltinPreviewLoading(false)
    }
  }

  const addManualSignal = () => {
    if (manualIsBuiltin) {
      const strat = strategies[manualBuiltinIdx]
      if (!strat) {
        onError('no builtin strategies loaded yet')
        return
      }
      let params: Record<string, number | string> | undefined
      if (manualBuiltinParamsText.trim() && manualBuiltinParamsText.trim() !== '{}') {
        try {
          const parsed = JSON.parse(manualBuiltinParamsText)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed as Record<string, number | string>
          else {
            setManualBuiltinParamsError('params must be a JSON object')
            return
          }
        } catch (e) {
          setManualBuiltinParamsError(`invalid JSON: ${(e as Error).message}`)
          return
        }
      }
      setManualBuiltinParamsError(null)
      const def: LabSignalDef = { kind: 'builtin', id: strat.id, ...(params ? { params } : {}), dir: manualDir, weight: manualWeight }
      if (manualGroupBuilding) setManualGroupPending((prev) => [...prev, def])
      else setManualSignals((prev) => [...prev, { uid: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, def }])
      return
    }
    const template = SIGNAL_TEMPLATES[manualTemplateIdx]
    const def: LabSignalDef = manualIsCandle
      ? { kind: 'candle', name: manualCandleName.trim().slice(0, 40), dir: manualDir, weight: manualWeight }
      : template.kind === 'indicator'
        ? {
            ...template,
            dir: manualDir,
            weight: manualWeight,
            op: manualOp,
            threshold: manualThreshold,
            ...(manualOp === 'between' || manualOp === 'outside' ? { threshold2: manualThreshold2 } : {}),
          }
        : { ...template, dir: manualDir, weight: manualWeight }
    if (manualIsCandle && !manualCandleName.trim()) {
      onError('enter a candlestick pattern name (e.g. "Hammer", "Engulfing")')
      return
    }
    if (manualGroupBuilding) {
      setManualGroupPending((prev) => [...prev, def])
    } else {
      setManualSignals((prev) => [...prev, { uid: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, def }])
    }
    if (manualIsCandle) setManualCandleName('')
  }

  const removeManualSignal = (uid: string) => {
    setManualSignals((prev) => prev.filter((s) => s.uid !== uid))
    setManualSelected((prev) => {
      if (!prev.has(uid)) return prev
      const next = new Set(prev)
      next.delete(uid)
      return next
    })
  }

  const toggleManualSelected = (uid: string) =>
    setManualSelected((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })

  /** Join the checked rows into one group that votes as a single signal -
   * the actual feature requested: "Range Sell Zone" AND "Wide Bear Bar" AND
   * "RSI > 70" should only count when they ALL fire together, not as three
   * independently-voting rows. Replaces the selected rows in place (at the
   * position of the first one) with the new group row. */
  const combineSelected = (op: 'and' | 'or') => {
    if (manualSelected.size < 2) {
      onError('select at least 2 signals to combine')
      return
    }
    setManualSignals((prev) => {
      const firstIdx = prev.findIndex((s) => manualSelected.has(s.uid))
      if (firstIdx === -1) return prev
      const members = prev.filter((s) => manualSelected.has(s.uid)).map((s) => s.def)
      const rest = prev.filter((s) => !manualSelected.has(s.uid))
      const group: { uid: string; def: LabSignalDef } = {
        uid: `${Date.now()}-grp-${Math.random().toString(36).slice(2, 6)}`,
        def: { kind: 'group', op, signals: members, dir: manualGroupDir, weight: manualGroupWeight },
      }
      const restBeforeFirst = prev.slice(0, firstIdx).filter((s) => !manualSelected.has(s.uid))
      const restAfter = rest.slice(restBeforeFirst.length)
      return [...restBeforeFirst, group, ...restAfter]
    })
    setManualSelected(new Set())
  }

  /** Fold the staged "+ add signal" picks into one group row, appended to
   * the main list, and exit group-building mode. */
  const finishGroupBuild = () => {
    if (manualGroupPending.length < 2) {
      onError('add at least 2 signals to the group before finishing it')
      return
    }
    const group: LabSignalDef = { kind: 'group', op: manualGroupOp, signals: manualGroupPending, dir: manualGroupDir, weight: manualGroupWeight }
    setManualSignals((prev) => [...prev, { uid: `${Date.now()}-grp-${Math.random().toString(36).slice(2, 6)}`, def: group }])
    setManualGroupPending([])
    setManualGroupBuilding(false)
  }

  const cancelGroupBuild = () => {
    setManualGroupPending([])
    setManualGroupBuilding(false)
  }

  const removePendingGroupMember = (idx: number) => setManualGroupPending((prev) => prev.filter((_, i) => i !== idx))

  /** Dissolve a group back into its member rows, each getting a fresh uid -
   * the undo for combineSelected, and the way to fix/rebuild a group that
   * came in from a pasted/learned spec without re-typing it from scratch. */
  const ungroupSignal = (uid: string) => {
    setManualSignals((prev) => {
      const idx = prev.findIndex((s) => s.uid === uid)
      if (idx === -1) return prev
      const row = prev[idx]
      if (row.def.kind !== 'group') return prev
      const members = row.def.signals.map((def, i) => ({ uid: `${Date.now()}-ung-${i}-${Math.random().toString(36).slice(2, 6)}`, def }))
      return [...prev.slice(0, idx), ...members, ...prev.slice(idx + 1)]
    })
  }

  /** minVotes counts top-level signal rows that voted THIS bar (a group row
   * contributes at most one vote regardless of its own AND/OR member count -
   * scoreSeriesFor iterates spec.signals, one test per top-level row) - so
   * minVotes can never exceed how many rows exist at all. Left unclamped,
   * "1 signal row, minVotes 2" (the field's own default) silently backtests
   * to exactly 0 trades on EVERY pair/timeframe forever, since votes can
   * never reach 2 - not a data problem, a math one, and nothing in the
   * result ever says so. Clamping here is the same guard the auto-learn
   * path already applies for the identical reason (see generate()'s
   * `signals.length >= 3 ? 2 : 1` and lab.ts's confluenceWeak). */
  const effectiveManualMinVotes = () => Math.max(1, Math.min(manualMinVotes, manualSignals.length || 1))

  const buildManualSpec = (): LabSpec | null => {
    if (!manualSignals.length) return null
    return {
      name: manualName.trim() || `${manualAsset} ${manualTf} Manual`,
      signals: manualSignals.map((s) => s.def),
      minScore: manualMinScore,
      minVotes: effectiveManualMinVotes(),
      horizon: manualHorizon,
      ...(manualBasis !== 'candles' ? { basis: manualBasis } : {}),
    }
  }

  /** Enter JSON mode: seed the textarea with the spec exactly as the row
   * builder currently has it, so switching to JSON never loses work. */
  const openManualJson = () => {
    const spec = buildManualSpec() ?? {
      name: manualName.trim() || `${manualAsset} ${manualTf} Manual`,
      signals: [],
      minScore: manualMinScore,
      minVotes: manualMinVotes,
      horizon: manualHorizon,
      ...(manualBasis !== 'candles' ? { basis: manualBasis } : {}),
    }
    setManualJsonText(JSON.stringify(spec, null, 2))
    setManualJsonError(null)
    setManualJsonMode(true)
  }

  /** Parse the edited JSON back into the row builder's own state, so
   * Backtest/Save/Deploy below keep working unchanged on whatever came out
   * of the editor - this only checks the SHAPE (object, signals is an
   * array of objects with a "kind"); it does not duplicate trading-core's
   * own field-level validation (valid ind/variant names, clamped ranges,
   * etc.) - that still happens server-side in normalizeSpec the moment
   * Backtest/Save runs, same as it always has, so a signal with a typo'd
   * field just quietly drops out at that point rather than here. */
  const applyManualJson = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(manualJsonText)
    } catch (e) {
      setManualJsonError(`invalid JSON: ${(e as Error).message}`)
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setManualJsonError('must be a JSON object with a "signals" array')
      return
    }
    const obj = parsed as Record<string, unknown>
    if (!Array.isArray(obj.signals)) {
      setManualJsonError('"signals" must be an array')
      return
    }
    const bad = obj.signals.findIndex((s) => !s || typeof s !== 'object' || typeof (s as Record<string, unknown>).kind !== 'string')
    if (bad !== -1) {
      setManualJsonError(`signals[${bad}] is missing a "kind"`)
      return
    }
    setManualSignals(
      (obj.signals as Record<string, unknown>[]).map((def, i) => ({
        uid: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        def: def as LabSignalDef,
      })),
    )
    if (typeof obj.name === 'string') setManualName(obj.name)
    if (Number.isFinite(obj.minScore)) setManualMinScore(Number(obj.minScore))
    if (Number.isFinite(obj.minVotes)) setManualMinVotes(Number(obj.minVotes))
    if (Number.isFinite(obj.horizon)) setManualHorizon(Number(obj.horizon))
    if (typeof obj.basis === 'string') setManualBasis(obj.basis as Basis)
    setManualJsonError(null)
    setManualJsonMode(false)
  }

  const backtestManual = async () => {
    const spec = buildManualSpec()
    if (!spec) return
    setManualBacktesting(true)
    try {
      const res = await osPost<{ ok: boolean; backtest: LabSimMetrics; holdout: LabSimMetrics; breakevenWinRate: number; error?: string }>('/lab_backtest', {
        spec,
        asset: manualAsset,
        tf: manualTf,
        payout,
      })
      if (!res.ok) throw new Error(res.error ?? 'backtest failed')
      setManualBacktest(res)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setManualBacktesting(false)
    }
  }

  const saveManual = async () => {
    const spec = buildManualSpec()
    if (!spec) return
    setManualSaving(true)
    try {
      const res = await osPost<{ ok: boolean; id: string }>('/lab_save', {
        name: spec.name,
        spec,
        asset: manualAsset,
        tf: manualTf,
        stats: { ...(manualBacktest ? { backtest: manualBacktest.backtest, holdout: manualBacktest.holdout, breakeven: manualBacktest.breakevenWinRate } : {}), curated: true },
      })
      setManualSavedId(res.id)
      loadLibrary()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setManualSaving(false)
    }
  }

  const deployManual = async () => {
    const spec = buildManualSpec()
    if (!spec) return
    setManualDeploying(true)
    try {
      let id = manualSavedId
      if (!id) {
        const res = await osPost<{ ok: boolean; id: string }>('/lab_save', {
          name: spec.name,
          spec,
          asset: manualAsset,
          tf: manualTf,
          stats: { ...(manualBacktest ? { backtest: manualBacktest.backtest, holdout: manualBacktest.holdout, breakeven: manualBacktest.breakevenWinRate } : {}), curated: true },
        })
        id = res.id
        setManualSavedId(res.id)
        loadLibrary()
      }
      await openDeploy(id, spec.name, manualAsset, manualTf, spec.horizon)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setManualDeploying(false)
    }
  }

  // THE BUG this replaces: deployFor used to carry only {id, name}, and
  // deploy() built the bot's watchlist/tf from the LEARN FORM's current pair
  // selector - whatever `asset`/`tf` happened to be showing - instead of the
  // asset/tf the strategy was actually learned on. Deploying a library row
  // for one pair while the form's dropdown sat on a different one silently
  // created a bot watching the WRONG instrument with the right strategy id
  // (e.g. a bot watching EURUSD trading a NZDUSD-OTC-learned spec) - wrong
  // even setting aside the research-gate message that surfaced it, since a
  // lab spec's signals/thresholds are tuned to the instrument it was learned
  // against.
  const [deployFor, setDeployFor] = useState<{ id: string; name: string; asset: string; tf: Timeframe; horizon: number } | null>(null)
  const [deploying, setDeploying] = useState(false)
  // deploy form
  const [botName, setBotName] = useState('')
  const [stake, setStake] = useState(10)
  const [kind, setKind] = useState<TradeKind>('digital')
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

  // THE BUG this fixes: a strategy saved with the signal checkboxes edited by
  // hand looked right in the JSON right after saving, but the backend's
  // auto re-learn sweep (every ~6h) - and the "re-learn now" button - always
  // called learn() fresh, which RE-MINES the whole candidate pool and
  // auto-selects a brand-new signal set from scratch. That silently threw
  // away the manual curation on the very next re-learn, with no warning -
  // "view json" later showed all the algorithm's picks, not what was
  // checked. `curated: true` in stats tells relearnRow to refresh this
  // spec's numbers without ever touching which signals are in it.
  const isCuratedSelection = (): boolean => {
    if (!result) return false
    const autoPicked = new Set(result.signals.filter((s) => s.selected).map((s) => s.key))
    return checkedKeys.size !== autoPicked.size || Array.from(checkedKeys).some((k) => !autoPicked.has(k))
  }

  const saveToLibrary = async () => {
    if (!effectiveSpec || !result) return
    try {
      const curated = isCuratedSelection()
      const res = await osPost<{ ok: boolean; id: string }>('/lab_save', {
        name: savedName || `${asset} ${tf} Lab`,
        spec: effectiveSpec,
        asset: result.asset,
        tf: result.tf,
        stats: { backtest: result.backtest, holdout: result.holdout, breakeven: result.breakevenWinRate, ...(curated ? { curated: true } : {}) },
      })
      setSavedId(res.id)
      loadLibrary()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const openDeploy = async (id: string, name: string, forAsset: string, forTf: Timeframe, forHorizon: number) => {
    let targetId = id
    if (!id && effectiveSpec && result) {
      // deploy straight from a fresh learn: persist first (whatever's checked)
      try {
        const curated = isCuratedSelection()
        const res = await osPost<{ ok: boolean; id: string }>('/lab_save', {
          name: savedName || `${asset} ${tf} Lab`,
          spec: effectiveSpec,
          asset: result.asset,
          tf: result.tf,
          stats: { backtest: result.backtest, holdout: result.holdout, breakeven: result.breakevenWinRate, ...(curated ? { curated: true } : {}) },
        })
        targetId = res.id
        setSavedId(res.id)
        loadLibrary()
      } catch (e) {
        onError((e as Error).message)
        return
      }
    }
    setDeployFor({ id: targetId, name, asset: forAsset, tf: forTf, horizon: forHorizon })
    setBotName(`${name} Bot`.slice(0, 32))
  }

  const deploy = async () => {
    if (!deployFor) return
    setDeploying(true)
    try {
      // THE FIX this is part of: expiry used to be a free-typed field on this
      // form, completely disconnected from the strategy's own `horizon` (the
      // bars-ahead outcome the learner actually validated against). A spec
      // learned on "does price move my way 1 bar later" backtested/held-out
      // numbers that say nothing about a 15-minute settlement - deploying it
      // with an unrelated expiry silently traded a DIFFERENT bet than the one
      // that was ever measured. Expiry is now derived straight from the
      // strategy's horizon and locked - not a user choice.
      const tfSec = TIMEFRAME_SECONDS[deployFor.tf]
      const body: Record<string, unknown> = {
        name: botName || `${deployFor.name} Bot`,
        watchlist: [deployFor.asset],
        strategyId: deployFor.id,
        tf: deployFor.tf,
        kind,
        stake,
        expiryBars: deployFor.horizon,
        expirySec: kind === 'digital' ? deployFor.horizon * tfSec : undefined,
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

  // "Delete all" is destructive and irreversible (every learned spec, not
  // just decayed ones) - armConfirm requires a second click within a few
  // seconds instead of firing on the first, same pattern as other
  // irreversible controls elsewhere in the OS (kill switch etc).
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const deleteAllLab = async () => {
    if (!confirmDeleteAll) {
      setConfirmDeleteAll(true)
      setTimeout(() => setConfirmDeleteAll(false), 4000)
      return
    }
    setConfirmDeleteAll(false)
    setDeletingAll(true)
    try {
      await osPost('/lab_delete_all', {})
      loadLibrary()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setDeletingAll(false)
    }
  }

  const [backtesting, setBacktesting] = useState<string | null>(null)
  // Which library row's spec JSON is currently expanded inline - clicking a
  // strategy's name toggles it, same "view the raw spec" need the fresh-learn
  // result already has (its own <details> block), just not previously
  // available once a strategy was saved into the library.
  const [expandedLabId, setExpandedLabId] = useState<string | null>(null)
  const backtestRow = async (id: string) => {
    // Use the saved row's OWN asset/tf, not whatever pair the learn form
    // currently has selected - the library holds strategies learned on
    // different pairs/timeframes, and re-backtesting against the wrong
    // instrument silently produced meaningless numbers.
    const row = library.find((r) => r.id === id)
    setBacktesting(id)
    try {
      // THE BUG this replaces: the response was awaited and thrown away, and
      // the backend never persisted its fresh numbers anywhere either - so
      // the loadLibrary() reload below always re-read the exact same stale
      // stats, and the button looked like it did nothing. backtestSpec now
      // writes the fresh backtest/holdout back onto the saved row itself, so
      // this reload actually picks up new numbers; still check `ok` so a
      // real failure (e.g. not enough history) surfaces instead of silently
      // leaving the old stats in place.
      const res = await osPost<{ ok: boolean; error?: string }>('/lab_backtest', { id, asset: row?.asset ?? asset, tf: row?.tf ?? tf, payout })
      if (!res.ok) throw new Error(res.error ?? 're-backtest failed')
      loadLibrary()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBacktesting(null)
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

      {/* manual strategy builder */}
      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-violet-300">Build a strategy manually</h3>
          <span className="font-mono text-[9px] text-[#4b5a72]">pick signals from the same vocabulary the learner mines - no mining required</span>
        </div>
        <p className="mt-1 text-[10px] leading-snug text-[#7c8aa5]">
          Pick the pair/tf to test this against below - a hand-built strategy isn&apos;t mined from any one pair&apos;s
          history, so it has its own target here, separate from the &quot;learn this pair&quot; selector above. Backtest,
          save and deploy run through the exact same pipeline a learned spec does - including the horizon-locked
          expiry on deploy - using the <span className="text-[#aab6cc]">payout</span> selected above.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">pair</span>
            <AssetPicker tickers={tickers.length ? tickers : ['EURUSD']} value={manualAsset} onChange={setManualAsset} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">tf</span>
            <select
              value={manualTf}
              onChange={(e) => setManualTf(e.target.value as Timeframe)}
              className="h-7 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0]"
            >
              {TIMEFRAMES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex items-center gap-1.5 font-mono text-[10px] text-[#aab6cc]">
            <input
              type="checkbox"
              checked={manualIsCandle}
              onChange={(e) => {
                setManualIsCandle(e.target.checked)
                if (e.target.checked) setManualIsBuiltin(false)
              }}
              className="accent-violet-500"
            />
            custom candlestick pattern
          </label>
          <label className="flex items-center gap-1.5 font-mono text-[10px] text-lime-300">
            <input
              type="checkbox"
              checked={manualIsBuiltin}
              onChange={(e) => {
                setManualIsBuiltin(e.target.checked)
                if (e.target.checked) setManualIsCandle(false)
              }}
              className="accent-lime-500"
            />
            use builtin strategy
          </label>
          <label className="flex items-center gap-1.5 font-mono text-[10px] text-orange-300">
            <input
              type="checkbox"
              checked={manualGroupBuilding}
              onChange={(e) => {
                if (!e.target.checked) cancelGroupBuild()
                else setManualGroupBuilding(true)
              }}
              className="accent-orange-500"
            />
            combine into one group (AND/OR)
          </label>
          {manualIsBuiltin ? (
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">builtin strategy</span>
              <select
                value={manualBuiltinIdx}
                onChange={(e) => {
                  const idx = Number(e.target.value)
                  setManualBuiltinIdx(idx)
                  setManualBuiltinParamsText(JSON.stringify(strategies[idx]?.defaults ?? {}, null, 2))
                  setManualBuiltinParamsError(null)
                }}
                className="h-7 w-64 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0]"
              >
                {strategies.map((s, idx) => (
                  <option key={s.id} value={idx}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ) : manualIsCandle ? (
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">pattern name</span>
              <Input
                value={manualCandleName}
                onChange={(e) => setManualCandleName(e.target.value)}
                placeholder="e.g. Hammer, Engulfing"
                className="h-7 w-40 border-[#1c2739] bg-[#101828] font-mono text-[11px] text-[#dbe4f0]"
              />
            </label>
          ) : (
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">signal template</span>
              <select
                value={manualTemplateIdx}
                onChange={(e) => {
                  const idx = Number(e.target.value)
                  const t = SIGNAL_TEMPLATES[idx]
                  setManualTemplateIdx(idx)
                  setManualDir(t.dir)
                  if (t.kind === 'indicator') {
                    setManualOp(t.op)
                    setManualThreshold(t.threshold)
                    setManualThreshold2(t.threshold2 ?? t.threshold)
                  }
                }}
                className="h-7 w-64 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0]"
              >
                {Array.from(templatesByKind.entries()).map(([kind, items]) => (
                  <optgroup key={kind} label={kind.toUpperCase()}>
                    {items.map(({ idx, label }) => (
                      <option key={idx} value={idx}>
                        {label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          {!manualIsCandle && !manualIsBuiltin && SIGNAL_TEMPLATES[manualTemplateIdx].kind === 'indicator' && (
            <>
              <label className="flex flex-col gap-0.5">
                <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">op</span>
                <select
                  value={manualOp}
                  onChange={(e) => setManualOp(e.target.value as '>' | '<' | 'between' | 'outside')}
                  className="h-7 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0]"
                >
                  <option value=">">{'>'}</option>
                  <option value="<">{'<'}</option>
                  <option value="between">between (AND)</option>
                  <option value="outside">outside (AND)</option>
                </select>
              </label>
              <NumField label="threshold" value={manualThreshold} onChange={setManualThreshold} w="w-16" step={0.01} />
              {(manualOp === 'between' || manualOp === 'outside') && <NumField label="threshold 2" value={manualThreshold2} onChange={setManualThreshold2} w="w-16" step={0.01} />}
            </>
          )}
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">dir</span>
            <select value={manualDir} onChange={(e) => setManualDir(e.target.value as 'call' | 'put')} className="h-7 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0]">
              <option value="call">CALL</option>
              <option value="put">PUT</option>
            </select>
          </label>
          <NumField label="weight" value={manualWeight} onChange={setManualWeight} w="w-14" />
          <Button
            onClick={addManualSignal}
            variant="outline"
            className={
              manualGroupBuilding
                ? 'h-7 border-orange-500/40 px-3 text-[10px] font-bold uppercase tracking-wider text-orange-300 hover:bg-orange-500/10'
                : 'h-7 border-violet-500/40 px-3 text-[10px] font-bold uppercase tracking-wider text-violet-300 hover:bg-violet-500/10'
            }
          >
            {manualGroupBuilding ? '+ add to group' : '+ add signal'}
          </Button>
          <Button
            onClick={() => (manualJsonMode ? setManualJsonMode(false) : openManualJson())}
            variant="outline"
            className="h-7 border-cyan-500/40 px-3 text-[10px] font-bold uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/10"
          >
            {manualJsonMode ? 'back to builder' : '{ } edit as json'}
          </Button>
        </div>

        {manualIsBuiltin && (
          <div className="mt-2 rounded border border-lime-500/40 bg-lime-500/5 p-2">
            <p className="mb-1.5 font-mono text-[9px] leading-relaxed text-lime-200">
              {strategies[manualBuiltinIdx]?.description ?? 'params for the selected strategy'} - edit as JSON (leave as the loaded defaults, or override any
              subset of keys; the rest fall back to the strategy&apos;s own defaults).
            </p>
            <textarea
              value={manualBuiltinParamsText}
              onChange={(e) => {
                setManualBuiltinParamsText(e.target.value)
                setManualBuiltinParamsError(null)
              }}
              rows={6}
              spellCheck={false}
              className="w-full resize-y rounded border border-[#1c2739] bg-[#101828] p-2 font-mono text-[11px] text-[#dbe4f0] outline-none"
            />
            {manualBuiltinParamsError && <p className="mt-1 font-mono text-[10px] text-rose-400">{manualBuiltinParamsError}</p>}
            <button
              type="button"
              onClick={() => {
                setManualBuiltinParamsText(JSON.stringify(strategies[manualBuiltinIdx]?.defaults ?? {}, null, 2))
                setManualBuiltinParamsError(null)
              }}
              className="mt-1 font-mono text-[9px] text-[#4b5a72] hover:text-lime-300"
            >
              reset to defaults
            </button>

            <div className="mt-2 border-t border-lime-500/20 pt-2">
              <p className="mb-1.5 font-mono text-[9px] leading-relaxed text-lime-200">
                No fixed call/put bias - most builtin strategies trade either side depending on current conditions. Run it live on {manualAsset} {manualTf}{' '}
                to see which way it&apos;s reading right now, then set <span className="text-[#aab6cc]">dir</span> below to match (or to the opposite, to
                fade it).
              </p>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => void testBuiltinPreview()}
                  disabled={manualBuiltinPreviewLoading}
                  variant="outline"
                  className="h-6 border-lime-500/40 px-2 text-[9px] font-bold uppercase tracking-wider text-lime-300 hover:bg-lime-500/10 disabled:opacity-40"
                >
                  {manualBuiltinPreviewLoading ? 'testing…' : `test live on ${manualAsset}`}
                </Button>
                {manualBuiltinPreview && (
                  <span className="font-mono text-[10px]">
                    right now:{' '}
                    <span
                      className={
                        manualBuiltinPreview.direction === 'call'
                          ? 'text-emerald-400'
                          : manualBuiltinPreview.direction === 'put'
                            ? 'text-rose-400'
                            : 'text-[#7c8aa5]'
                      }
                    >
                      {manualBuiltinPreview.direction.toUpperCase()}
                    </span>{' '}
                    <span className="text-[#7c8aa5]">(score {manualBuiltinPreview.score.toFixed(0)}) - {manualBuiltinPreview.notes}</span>
                    <button
                      type="button"
                      onClick={() => {
                        const dir = manualBuiltinPreview.direction === 'put' ? 'put' : 'call'
                        setManualDir(dir)
                        // This only changed the DIR dropdown above, which only
                        // affects the NEXT "+ add signal" - if this exact
                        // builtin strategy is ALREADY sitting in the signal
                        // list below (the common case: you added it, then
                        // tested live to see which way it's actually
                        // reading), the dropdown updating was invisible
                        // against it since the already-added row kept its old
                        // dir - looking like the button "did nothing". Flip
                        // every already-added row (and any group-in-progress
                        // member) using this same strategy id to match too.
                        const stratId = strategies[manualBuiltinIdx]?.id
                        if (stratId) {
                          setManualSignals((prev) =>
                            prev.map((s) => (s.def.kind === 'builtin' && s.def.id === stratId ? { ...s, def: { ...s.def, dir } } : s))
                          )
                          setManualGroupPending((prev) => prev.map((def) => (def.kind === 'builtin' && def.id === stratId ? { ...def, dir } : def)))
                        }
                      }}
                      disabled={manualBuiltinPreview.direction === 'none'}
                      className="ml-2 text-[9px] text-lime-300 underline hover:text-lime-200 disabled:cursor-not-allowed disabled:text-[#4b5a72] disabled:no-underline"
                    >
                      use this dir
                    </button>
                  </span>
                )}
              </div>
              {manualBuiltinPreviewError && <p className="mt-1 font-mono text-[10px] text-rose-400">{manualBuiltinPreviewError}</p>}
            </div>
          </div>
        )}

        {manualGroupBuilding && (
          <div className="mt-2 rounded border border-orange-500/40 bg-orange-500/5 p-2">
            <p className="mb-1.5 font-mono text-[9px] leading-relaxed text-orange-200">
              Pick a signal template above and click &quot;+ add to group&quot; for each one you want combined (e.g. Range Sell Zone, then Wide Bear Bar, then
              RSI &gt; 70) - they&apos;ll only count as one vote when they{' '}
              {manualGroupOp === 'and' ? 'ALL fire on the same bar' : 'EITHER fires on the same bar'}. Need 2+ before finishing.
            </p>
            {manualGroupPending.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {manualGroupPending.map((def, i) => (
                  <span key={i} className="flex items-center gap-1.5 rounded border border-orange-500/30 bg-[#101828] px-2 py-1 font-mono text-[10px]">
                    <span className={`rounded border px-1 py-0.5 text-[8px] uppercase ${KIND_CHIP[def.kind] ?? 'text-[#7c8aa5] border-[#1c2739]'}`}>{def.kind}</span>
                    <span className="text-[#dbe4f0]">{labelOfSignal(def, strategies)}</span>
                    <button type="button" onClick={() => removePendingGroupMember(i)} className="text-[#4b5a72] hover:text-rose-400" title="remove">
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-0.5">
                <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">combine as</span>
                <select value={manualGroupOp} onChange={(e) => setManualGroupOp(e.target.value as 'and' | 'or')} className="h-6 rounded border border-[#1c2739] bg-[#101828] px-1.5 font-mono text-[10px] text-[#dbe4f0]">
                  <option value="and">AND - all must fire</option>
                  <option value="or">OR - any one fires</option>
                </select>
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">group dir</span>
                <select value={manualGroupDir} onChange={(e) => setManualGroupDir(e.target.value as 'call' | 'put')} className="h-6 rounded border border-[#1c2739] bg-[#101828] px-1.5 font-mono text-[10px] text-[#dbe4f0]">
                  <option value="call">CALL</option>
                  <option value="put">PUT</option>
                </select>
              </label>
              <NumField label="group weight" value={manualGroupWeight} onChange={setManualGroupWeight} w="w-14" />
              <Button
                onClick={finishGroupBuild}
                disabled={manualGroupPending.length < 2}
                className="h-6 bg-orange-600 px-2 text-[9px] font-bold uppercase tracking-wider text-white hover:bg-orange-500 disabled:opacity-40"
              >
                finish group ({manualGroupPending.length})
              </Button>
              <button type="button" onClick={cancelGroupBuild} className="font-mono text-[9px] text-[#4b5a72] hover:text-rose-400">
                cancel
              </button>
            </div>
          </div>
        )}

        {manualJsonMode && (
          <div className="mt-2 rounded border border-cyan-500/30 bg-[#0b1220] p-2">
            <p className="mb-1.5 font-mono text-[9px] leading-relaxed text-[#7c8aa5]">
              Edit the spec directly - same shape Backtest/Save/Deploy already send. Fields the row builder has no control for (or signals pasted from
              elsewhere) are fine here; anything invalid just gets dropped when you Backtest/Save, same as it always has.
            </p>
            <textarea
              value={manualJsonText}
              onChange={(e) => setManualJsonText(e.target.value)}
              rows={14}
              spellCheck={false}
              className="w-full resize-y rounded border border-[#1c2739] bg-[#101828] p-2 font-mono text-[11px] text-[#dbe4f0] outline-none"
            />
            {manualJsonError && <p className="mt-1 font-mono text-[10px] text-rose-400">{manualJsonError}</p>}
            <div className="mt-1.5 flex items-center gap-2">
              <Button onClick={applyManualJson} className="h-7 bg-cyan-600 px-3 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-cyan-500">
                apply json
              </Button>
              <Button onClick={openManualJson} variant="outline" className="h-7 border-[#1c2739] px-3 text-[10px] uppercase tracking-wider text-[#7c8aa5] hover:text-cyan-300">
                reset from current builder
              </Button>
            </div>
          </div>
        )}

        {manualSignals.length >= 2 && (
          <div className="mt-2 flex flex-wrap items-end gap-2 rounded border border-orange-500/30 bg-orange-500/5 p-1.5">
            <span className="font-mono text-[9px] uppercase tracking-wider text-orange-300">
              or: check 2+ signals already added below, then join THOSE as one unit:
            </span>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">group dir</span>
              <select value={manualGroupDir} onChange={(e) => setManualGroupDir(e.target.value as 'call' | 'put')} className="h-6 rounded border border-[#1c2739] bg-[#101828] px-1.5 font-mono text-[10px] text-[#dbe4f0]">
                <option value="call">CALL</option>
                <option value="put">PUT</option>
              </select>
            </label>
            <NumField label="group weight" value={manualGroupWeight} onChange={setManualGroupWeight} w="w-14" />
            <Button
              onClick={() => combineSelected('and')}
              disabled={manualSelected.size < 2}
              variant="outline"
              className="h-6 border-orange-500/40 px-2 text-[9px] font-bold uppercase tracking-wider text-orange-300 hover:bg-orange-500/10 disabled:opacity-40"
            >
              combine -&gt; AND ({manualSelected.size})
            </Button>
            <Button
              onClick={() => combineSelected('or')}
              disabled={manualSelected.size < 2}
              variant="outline"
              className="h-6 border-orange-500/40 px-2 text-[9px] font-bold uppercase tracking-wider text-orange-300 hover:bg-orange-500/10 disabled:opacity-40"
            >
              combine -&gt; OR ({manualSelected.size})
            </Button>
            {manualSelected.size > 0 && (
              <button type="button" onClick={() => setManualSelected(new Set())} className="font-mono text-[9px] text-[#4b5a72] hover:text-cyan-300">
                clear selection
              </button>
            )}
          </div>
        )}

        {manualSignals.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {manualSignals.map((s) => {
              if (s.def.kind === 'group') {
                const group = s.def
                const joiner = group.op === 'and' ? '&' : '|'
                return (
                  <span key={s.uid} className="flex items-center gap-1.5 rounded border border-orange-500/40 bg-orange-500/5 px-2 py-1 font-mono text-[10px]">
                    <input type="checkbox" checked={manualSelected.has(s.uid)} onChange={() => toggleManualSelected(s.uid)} className="accent-orange-500" title="select for combining" />
                    <span className={`rounded border px-1 py-0.5 text-[8px] uppercase ${KIND_CHIP.group}`}>group:{group.op}</span>
                    <span className="text-[#dbe4f0]">
                      {group.signals.map((m, i) => (
                        <span key={i}>
                          {i > 0 && <span className="text-orange-400"> {joiner} </span>}
                          {labelOfSignal(m, strategies)}
                        </span>
                      ))}
                    </span>
                    <span className={group.dir === 'call' ? 'text-emerald-400' : 'text-rose-400'}>{group.dir.toUpperCase()}</span>
                    <span className="text-cyan-300">w{group.weight}</span>
                    <button type="button" onClick={() => ungroupSignal(s.uid)} className="text-[#4b5a72] hover:text-orange-300" title="dissolve back into separate rows">
                      ungroup
                    </button>
                    <button type="button" onClick={() => removeManualSignal(s.uid)} className="text-[#4b5a72] hover:text-rose-400" title="remove">
                      ✕
                    </button>
                  </span>
                )
              }
              return (
                <span key={s.uid} className="flex items-center gap-1.5 rounded border border-[#1c2739] bg-[#101828] px-2 py-1 font-mono text-[10px]">
                  <input type="checkbox" checked={manualSelected.has(s.uid)} onChange={() => toggleManualSelected(s.uid)} className="accent-orange-500" title="select for combining" />
                  <span className={`rounded border px-1 py-0.5 text-[8px] uppercase ${KIND_CHIP[s.def.kind] ?? 'text-[#7c8aa5] border-[#1c2739]'}`}>{s.def.kind}</span>
                  <span className="text-[#dbe4f0]">{labelOfSignal(s.def, strategies)}</span>
                  <span className={s.def.dir === 'call' ? 'text-emerald-400' : 'text-rose-400'}>{s.def.dir.toUpperCase()}</span>
                  <span className="text-cyan-300">w{s.def.weight}</span>
                  <button type="button" onClick={() => removeManualSignal(s.uid)} className="text-[#4b5a72] hover:text-rose-400" title="remove">
                    ✕
                  </button>
                </span>
              )
            })}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">name</span>
            <Input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder={`${asset} ${tf} Manual`} className="h-7 w-40 border-[#1c2739] bg-[#101828] font-mono text-[11px] text-[#dbe4f0]" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]">basis</span>
            <select value={manualBasis} onChange={(e) => setManualBasis(e.target.value as Basis)} className="h-7 rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-[#dbe4f0]">
              {BASIS_OPTIONS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <NumField label="minScore" value={manualMinScore} onChange={setManualMinScore} w="w-14" />
          <NumField label="minVotes" value={manualMinVotes} onChange={setManualMinVotes} w="w-12" />
          <NumField label="horizon" value={manualHorizon} onChange={setManualHorizon} w="w-12" />
        </div>
        {manualSignals.length > 0 && manualMinVotes > manualSignals.length && (
          <div className="mt-1 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 font-mono text-[9px] text-amber-300">
            ⚠ minVotes {manualMinVotes} with only {manualSignals.length} signal row{manualSignals.length === 1 ? '' : 's'} added - that can never be reached (each row is at most 1
            vote), so this would backtest to exactly 0 trades on every pair. Backtest/save/deploy will use minVotes {effectiveManualMinVotes()} instead - add more signal rows or lower minVotes to stop seeing this.
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button onClick={() => void backtestManual()} disabled={!manualSignals.length || manualBacktesting} variant="outline" className="h-7 border-[#1c2739] px-3 text-[10px] uppercase tracking-wider text-[#7c8aa5] hover:text-cyan-300 disabled:opacity-40">
            {manualBacktesting ? 'backtesting...' : `backtest (${manualAsset} ${manualTf})`}
          </Button>
          <Button onClick={() => void saveManual()} disabled={!manualSignals.length || manualSaving || !!manualSavedId} variant="outline" className="h-7 border-[#1c2739] px-3 text-[10px] uppercase tracking-wider text-[#7c8aa5] hover:text-cyan-300 disabled:opacity-40">
            {manualSavedId ? `saved: ${manualSavedId}` : manualSaving ? 'saving...' : 'save to library'}
          </Button>
          <Button onClick={() => void deployManual()} disabled={!manualSignals.length || manualDeploying} className="h-7 bg-emerald-600 px-3 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-emerald-500 disabled:opacity-40">
            {manualDeploying ? 'deploying...' : 'deploy as bot'}
          </Button>
        </div>

        {manualBacktest && (
          <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
            <MetricStrip label="backtest - full sample" m={manualBacktest.backtest} breakeven={manualBacktest.breakevenWinRate} />
            <MetricStrip label="backtest - holdout (last 30%, unseen)" m={manualBacktest.holdout} breakeven={manualBacktest.breakevenWinRate} />
          </div>
        )}
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
                <Button onClick={() => effectiveSpec && result && void openDeploy('', effectiveSpec.name, result.asset, result.tf, effectiveSpec.horizon)} disabled={!effectiveSpec} className="h-7 bg-emerald-600 px-3 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-emerald-500 disabled:opacity-40">
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
            <h4 className="text-[12px] font-semibold text-emerald-300">
              Deploy &quot;{deployFor.name}&quot; as an autonomous bot <span className="text-[#7c8aa5]">· watching {deployFor.asset} {deployFor.tf}</span>
            </h4>
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
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-[#4b5a72]" title="locked to the strategy's own horizon - the bars-ahead outcome it was actually learned/backtested against. Changing it here would trade a different bet than the one the numbers above were measured on.">
                expiry (locked to horizon)
              </span>
              <div
                className="flex h-7 w-32 items-center rounded border border-[#1c2739] bg-[#0b111c] px-2 font-mono text-[11px] text-amber-300"
                title={`this strategy was learned/validated on a ${deployFor.horizon}-bar horizon - expiry is derived from that, not freely editable`}
              >
                {deployFor.horizon} bar{deployFor.horizon > 1 ? 's' : ''} ({fmtExpiry(deployFor.horizon * TIMEFRAME_SECONDS[deployFor.tf])})
              </div>
            </label>
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
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9px] text-[#4b5a72]">{library.length} saved</span>
            {library.length > 0 && (
              <Button
                onClick={() => void deleteAllLab()}
                disabled={deletingAll}
                variant="outline"
                title={
                  confirmDeleteAll
                    ? 'click again to permanently delete every learned strategy'
                    : 'delete the entire learned strategy library'
                }
                className={`h-6 px-2 text-[9px] uppercase tracking-wider disabled:opacity-40 ${
                  confirmDeleteAll
                    ? 'border-rose-500/60 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
                    : 'border-[#1c2739] text-[#4b5a72] hover:text-rose-300'
                }`}
              >
                {deletingAll ? 'deleting...' : confirmDeleteAll ? 'confirm delete all?' : 'delete all'}
              </Button>
            )}
          </div>
        </div>
        {library.length === 0 ? (
          <p className="mt-2 text-[11px] text-[#3d4d66]">Nothing learned yet - run &quot;learn this pair&quot; above, or ask the Copilot to study a pair for you.</p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {library.map((r) => {
              const expanded = expandedLabId === r.id
              return (
              <div key={r.id} className="rounded border border-[#141d2e] bg-[#0d1420]">
              <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setExpandedLabId(expanded ? null : r.id)}
                      className="truncate font-mono text-[11px] text-[#dbe4f0] hover:text-cyan-300 hover:underline"
                      title="view this strategy's spec JSON"
                    >
                      {r.spec.name}
                    </button>
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
                    {r.id} · {r.asset} {r.tf} · {r.spec.signals.length} signals · minScore {r.spec.minScore} ·{' '}
                    <span className="text-amber-300" title="bars-ahead the learner validated this spec against - the deploy expiry is locked to match this, not freely chosen">
                      horizon {r.spec.horizon}b
                    </span>
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
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={backtesting === r.id}
                    className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5] hover:text-emerald-400 disabled:opacity-40"
                    onClick={() => void backtestRow(r.id)}
                  >
                    {backtesting === r.id ? 're-backtesting...' : 're-backtest'}
                  </Button>
                  <Button variant="outline" size="sm" className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5] hover:text-emerald-400" onClick={() => void openDeploy(r.id, r.spec.name, r.asset, r.tf as Timeframe, r.spec.horizon)}>
                    deploy
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5] hover:text-violet-400"
                    onClick={() => setExpandedLabId(expanded ? null : r.id)}
                    title="view this strategy's spec JSON"
                  >
                    {expanded ? 'hide json' : 'view json'}
                  </Button>
                  <Button variant="outline" size="sm" className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5] hover:text-rose-400" onClick={() => void removeLab(r.id)}>
                    delete
                  </Button>
                </div>
              </div>
              {expanded && (
                <div className="border-t border-[#141d2e] px-2.5 py-2">
                  <pre className="max-h-64 overflow-auto font-mono text-[10px] leading-relaxed text-[#aab6cc]">{JSON.stringify(r.spec, null, 2)}</pre>
                </div>
              )}
              </div>
              )
            })}
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
