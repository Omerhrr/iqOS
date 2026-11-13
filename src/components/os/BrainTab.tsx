'use client'

// IQAIR//OS - Brain tab: the Brain Trader's own workspace, separate from the Autopilot bots.
// The Brain Trader runs a saved MSL strategy like any other bot, but every signal goes to an AI reviewer first, which says go / no and
// picks the expiry. Three parts:
//   1. STRATEGY  which saved MSL script the trader runs (the first is "Brain 1": regime picks the playbook, Fibonacci finds the level,
//                SMC + candlesticks confirm). Any script strategy can be picked; edit scripts in the Meta-Strategy tab.
//   2. PREVIEW   run that strategy on one asset right now: what it says and why. No AI call, no order.
//   3. TRADER    on/off, shadow vs live, the reviewer's decisions, and the all-signals / approved / vetoed hit rates (BrainTraderPanel).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getMetaStrategies, osGet, osPost, type AssetRow, type MetaStrategySpec } from '@/lib/os/client'
import BrainTraderPanel from './BrainTraderPanel'

const BRAIN_1 = 'meta:builtin-brain-fib-adaptive'

interface WatchCfg {
  watchMode: 'all' | 'selected'
  marketScope: 'all' | 'real' | 'otc'
  assets: string[]
}
interface Watching {
  mode: 'all' | 'selected'
  pool: number
  selected: number
}
interface Preview {
  asset: string
  tf: string
  strategyId: string
  strategyName: string
  direction: 'call' | 'put' | 'none'
  confidence: number
  notes: string
  price: number
  wouldSend: boolean
  bars: number
}

export default function BrainTab({ asset, assets, onError }: { asset: string; assets: AssetRow[]; onError?: (m: string) => void }) {
  const [specs, setSpecs] = useState<MetaStrategySpec[]>([])
  const [current, setCurrent] = useState<string>(BRAIN_1)
  const [showScript, setShowScript] = useState(false)
  const [pick, setPick] = useState(asset)
  const [prev, setPrev] = useState<Preview | null>(null)
  const [prevErr, setPrevErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [watchCfg, setWatchCfg] = useState<WatchCfg | null>(null)
  const [watchDraft, setWatchDraft] = useState<WatchCfg | null>(null)
  const [watchDirty, setWatchDirty] = useState(false)
  const [watching, setWatching] = useState<Watching | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => setPick(asset), [asset])

  const loadSpecs = useCallback(async () => {
    try {
      const d = await getMetaStrategies()
      setSpecs(d.strategies.filter((s) => s.script))
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    }
  }, [onError])

  const loadCurrent = useCallback(async () => {
    try {
      const d = await osGet<{ ok: boolean; config: { metaStrategyId: string; watchMode: 'all' | 'selected'; marketScope: 'all' | 'real' | 'otc'; assets?: string[] }; watching: Watching }>('/brain_trader_status')
      if (d.ok) {
        setCurrent(d.config.metaStrategyId)
        const w: WatchCfg = { watchMode: d.config.watchMode ?? 'all', marketScope: d.config.marketScope ?? 'all', assets: d.config.assets ?? [] }
        setWatchCfg(w)
        setWatchDraft((prev) => (prev && watchDirty ? prev : w))
        setWatching(d.watching)
      }
    } catch {
      /* the trader panel below shows connection errors */
    }
  }, [watchDirty])

  const loadPreview = useCallback(async () => {
    if (!pick) return
    try {
      const d = await osGet<{ ok: boolean; error?: string } & Preview>('/brain_trader_preview', { asset: pick })
      if (d.ok) {
        setPrev(d)
        setPrevErr(null)
      } else {
        setPrev(null)
        setPrevErr(d.error ?? 'no read')
      }
    } catch (e) {
      setPrev(null)
      setPrevErr(e instanceof Error ? e.message : String(e))
    }
  }, [pick])

  useEffect(() => {
    void loadSpecs()
    void loadCurrent()
    const t = setInterval(() => void loadCurrent(), 8000)
    return () => clearInterval(t)
  }, [loadSpecs, loadCurrent])
  useEffect(() => {
    void loadPreview()
    const t = setInterval(() => void loadPreview(), 5000)
    return () => clearInterval(t)
  }, [loadPreview, current])

  const choose = async (id: string) => {
    setSaving(true)
    try {
      await osPost('/brain_trader_config', { metaStrategyId: id })
      setCurrent(id)
      await loadPreview()
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const editWatch = (fn: (w: WatchCfg) => WatchCfg) => {
    setWatchDraft((w) => (w ? fn(w) : w))
    setWatchDirty(true)
  }
  const saveWatch = async () => {
    if (!watchDraft) return
    setSaving(true)
    try {
      await osPost('/brain_trader_config', watchDraft)
      setWatchDirty(false)
      await loadCurrent()
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  // the pairs the picker offers: everything inside the chosen real / OTC scope (closed markets are listed, just marked)
  const scoped = useMemo(() => {
    const sc = watchDraft?.marketScope ?? 'all'
    const needle = q.trim().toLowerCase()
    return assets
      .filter((a) => sc === 'all' || (sc === 'otc') === Boolean(a.otc))
      .filter((a) => !needle || a.ticker.toLowerCase().includes(needle) || (a.name ?? '').toLowerCase().includes(needle))
      .sort((a, b) => Number(b.open) - Number(a.open) || a.ticker.localeCompare(b.ticker))
  }, [assets, watchDraft?.marketScope, q])
  const chosen = useMemo(() => new Set(watchDraft?.assets ?? []), [watchDraft?.assets])

  const spec = specs.find((s) => s.id === current)
  const sorted = [...specs].sort((a, b) => (a.id === BRAIN_1 ? -1 : b.id === BRAIN_1 ? 1 : a.name.localeCompare(b.name)))

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2">
      {/* ---------------- STRATEGY ---------------- */}
      <section className="rounded border border-[#1c2739] bg-[#0d1420] p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#7c8aa5]">Brain · strategy</h3>
          <select
            value={current}
            disabled={saving}
            onChange={(e) => void choose(e.target.value)}
            className="h-6 max-w-[28rem] rounded border border-[#1c2739] bg-[#101828] px-1 font-mono text-[10px] text-[#cbd5e1]"
          >
            {!specs.some((s) => s.id === current) && <option value={current}>{current}</option>}
            {sorted.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <Button size="sm" onClick={() => setShowScript((v) => !v)} className="h-5 rounded bg-[#1c2739] px-2 text-[9px] font-bold uppercase tracking-wider text-[#aab6cc] hover:bg-[#243352]">
            {showScript ? 'hide script' : 'show script'}
          </Button>
          <span className="font-mono text-[9px] text-[#4b5a72]">runs like any bot; the AI reviewer confirms every signal before a trade</span>
        </div>
        {current === BRAIN_1 && (
          <ul className="mt-2 space-y-1 font-mono text-[9px] leading-snug text-[#7c8aa5]">
            <li><span className="text-[#aab6cc]">Adapts:</span> a clean linear trend over the last 100 bars plays the pullback; a ranging market fades the range edge; noise or frantic volatility stands aside.</li>
            <li><span className="text-[#aab6cc]">Level:</span> Fibonacci is drawn on the latest leg (worth 2.5+ ATR, not older than 40 bars). Trend: price inside the 38.2-61.8% retracement. Range: price at the leg&apos;s end extreme.</li>
            <li><span className="text-[#aab6cc]">Confirms:</span> the SMC reader and the candlestick reader (hammer, engulfing, stars, piercing, dark cloud...) must both lean the same way.</li>
            <li><span className="text-[#aab6cc]">Honest:</span> on random walks it fires on about 0.3% of bars. Null-market backtests landed between 45% and 61% across three seed sets (about 55% pooled over 364 trades, but trades overlap so that is noisier than it looks) - not distinguishable from chance. No real-market win rate has been measured.</li>
          </ul>
        )}
        {showScript && (
          <pre className="mt-2 max-h-72 overflow-auto rounded border border-[#1c2739] bg-[#080d17] p-2 font-mono text-[9px] leading-relaxed text-[#9fb0c9]">
            {spec?.script ?? '(strategy not loaded)'}
          </pre>
        )}
        <p className="mt-1.5 font-mono text-[8px] text-[#3d4c66]">
          Brain 1 is the first strategy, not the only one: any saved script strategy in the Meta-Strategy tab shows up in this list, so new strategies can be added in MSL and run through the same reviewer.
        </p>
      </section>

      {/* ---------------- WATCHLIST ---------------- */}
      <section className="rounded border border-[#1c2739] bg-[#0d1420] p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#7c8aa5]">Brain · pairs to watch</h3>
          {watching && (
            <span className="font-mono text-[9px] text-[#4b5a72]">
              watching {watching.pool} pair{watching.pool === 1 ? '' : 's'} right now
              {watching.mode === 'selected' ? ` (${watching.selected} selected, closed markets skipped)` : ' (every open pair in scope)'}
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            {watchDirty && <span className="font-mono text-[9px] text-amber-400">unsaved</span>}
            <Button size="sm" disabled={!watchDirty || saving} onClick={() => { setWatchDraft(watchCfg); setWatchDirty(false) }} className="h-5 rounded bg-[#1c2739] px-2 text-[9px] font-bold uppercase text-[#aab6cc] hover:bg-[#243352]">revert</Button>
            <Button size="sm" disabled={!watchDirty || saving} onClick={() => void saveWatch()} className="h-5 rounded bg-sky-600 px-3 text-[9px] font-bold uppercase text-white hover:bg-sky-500">{saving ? 'saving…' : 'save pairs'}</Button>
          </span>
        </div>
        {watchDraft && (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[10px] text-[#aab6cc]">
              {([['all', 'All pairs'], ['selected', 'Only the pairs I pick']] as const).map(([v, label]) => (
                <label key={v} className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" name="brain-watch" checked={watchDraft.watchMode === v} onChange={() => editWatch((w) => ({ ...w, watchMode: v }))} />
                  {label}
                </label>
              ))}
              <label className="flex items-center gap-1.5 text-[#7c8aa5]">
                market
                <select value={watchDraft.marketScope} onChange={(e) => editWatch((w) => ({ ...w, marketScope: e.target.value as WatchCfg['marketScope'] }))} className="h-6 rounded border border-[#1c2739] bg-[#101828] px-1 text-[10px] text-[#cbd5e1]">
                  <option value="all">real + OTC</option>
                  <option value="real">real only</option>
                  <option value="otc">OTC only</option>
                </select>
              </label>
            </div>
            {watchDraft.watchMode === 'all' ? (
              <p className="mt-1.5 font-mono text-[8px] text-[#3d4c66]">
                Every open pair in the chosen market is read on each new closed candle (up to 300). Many pairs can signal in the same minute: the AI reviews 3 per 5 seconds and the rest wait for the next pass, within the hourly review cap. Narrow it with &quot;Only the pairs I pick&quot; to keep the reviewer&apos;s cost down.
              </p>
            ) : (
              <div className="mt-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search pairs…" className="h-6 w-44 bg-[#101828] px-1.5 text-[10px]" />
                  <Button size="sm" onClick={() => editWatch((w) => ({ ...w, assets: [...new Set([...w.assets, ...scoped.map((a) => a.ticker)])] }))} className="h-5 rounded bg-[#1c2739] px-2 text-[9px] font-bold uppercase text-[#aab6cc] hover:bg-[#243352]">add shown ({scoped.length})</Button>
                  <Button size="sm" onClick={() => editWatch((w) => ({ ...w, assets: w.assets.filter((t) => !scoped.some((a) => a.ticker === t)) }))} className="h-5 rounded bg-[#1c2739] px-2 text-[9px] font-bold uppercase text-[#aab6cc] hover:bg-[#243352]">remove shown</Button>
                  <Button size="sm" onClick={() => editWatch((w) => ({ ...w, assets: [] }))} className="h-5 rounded bg-[#1c2739] px-2 text-[9px] font-bold uppercase text-[#aab6cc] hover:bg-[#243352]">clear all</Button>
                  <span className="font-mono text-[9px] text-[#7c8aa5]">{watchDraft.assets.length} selected</span>
                </div>
                {watchDraft.assets.length === 0 && <p className="mt-1 font-mono text-[9px] text-amber-500/80">Nothing selected - the Brain Trader will watch no pairs until you pick some.</p>}
                <div className="mt-1.5 grid max-h-48 grid-cols-2 gap-x-3 gap-y-0.5 overflow-y-auto rounded border border-[#1c2739] p-1.5 md:grid-cols-4 lg:grid-cols-6">
                  {scoped.map((a) => (
                    <label key={a.ticker} className={`flex cursor-pointer items-center gap-1.5 font-mono text-[9px] ${a.open ? 'text-[#aab6cc]' : 'text-[#3d4c66]'}`} title={`${a.name}${a.open ? '' : ' - market closed'}`}>
                      <input
                        type="checkbox"
                        checked={chosen.has(a.ticker)}
                        onChange={(e) => editWatch((w) => ({ ...w, assets: e.target.checked ? [...w.assets, a.ticker] : w.assets.filter((t) => t !== a.ticker) }))}
                      />
                      <span className="truncate">{a.ticker}</span>
                      {a.otc && <span className="text-violet-400/70">otc</span>}
                      {!a.open && <span>closed</span>}
                    </label>
                  ))}
                  {scoped.length === 0 && <span className="col-span-full font-mono text-[9px] text-[#4b5a72]">no pairs match</span>}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* ---------------- PREVIEW ---------------- */}
      <section className="rounded border border-[#1c2739] bg-[#0d1420] p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#7c8aa5]">Brain · preview</h3>
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-6 rounded border border-[#1c2739] bg-[#101828] px-1 font-mono text-[10px] text-[#cbd5e1]">
            {!assets.some((a) => a.ticker === pick) && <option value={pick}>{pick}</option>}
            {assets.map((a) => (
              <option key={a.ticker} value={a.ticker}>{a.ticker}{a.otc ? ' (OTC)' : ''}</option>
            ))}
          </select>
          {prev && <span className="font-mono text-[9px] text-[#4b5a72]">{prev.tf} · {prev.bars} closed bars · read-only, no AI call, no order</span>}
        </div>
        {prevErr && <p className="mt-1.5 font-mono text-[9px] text-amber-500/70">{prevErr}</p>}
        {prev && (
          <div className="mt-1.5 space-y-1 font-mono text-[10px]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span
                className={`rounded border px-1.5 py-px font-bold uppercase ${
                  prev.direction === 'call'
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                    : prev.direction === 'put'
                      ? 'border-rose-500/50 bg-rose-500/10 text-rose-300'
                      : 'border-[#1c2739] text-[#4b5a72]'
                }`}
              >
                {prev.direction === 'none' ? 'no signal' : `signals ${prev.direction}`}
              </span>
              {prev.direction !== 'none' && <span className="text-[#7c8aa5]">strategy confidence {prev.confidence}</span>}
              {prev.direction !== 'none' && (
                <span className={prev.wouldSend ? 'text-sky-300' : 'text-amber-500/80'}>
                  {prev.wouldSend ? 'would go to the AI reviewer' : 'below the trader’s minimum confidence or direction filter - would not be sent'}
                </span>
              )}
              <span className="text-[#4b5a72]">last close {prev.price}</span>
            </div>
            <p className="text-[9px] text-[#7c8aa5]">{prev.notes || (prev.direction === 'none' ? 'The strategy’s conditions are not all true on this asset right now.' : '(the script gave no notes)')}</p>
          </div>
        )}
      </section>

      {/* ---------------- TRADER ---------------- */}
      <BrainTraderPanel />
    </div>
  )
}
