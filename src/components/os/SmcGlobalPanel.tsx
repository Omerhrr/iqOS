'use client'

// IQAIR//OS - SMC Global panel
// The Smart Money Concepts scanner lifted from one chart to the whole
// universe, same relationship Next Global has to the per-asset Next-Candle
// Oracle panel: one SMC summary read per open instrument, ranked
// directional-first then by summary confidence. Backed by /smc_global
// (plugins/smcscan.ts globalScan) - rows are the exact same TTL-cached
// per-asset scan the per-asset SMC panels already use, so scanning here
// doesn't duplicate work.
//
// Support & Resistance is NOT excluded here (unlike SMC Recent) - the
// summary direction/confidence this board ranks by already blends every
// active signal kind, same as the SMC tab's own summary chip.
//
// OTC detection: rows now carry `otc` (badged amber), and a scope filter
// (All/Real/OTC) sits next to the direction filter. Previously there was
// no way to tell an OTC row apart, AND OTC pairs could be silently
// crowded out of the scanned universe entirely - universe.ts orders the
// catalog forex -> OTC -> ..., and on an ordinary weekday all 33 forex +
// 10 forex-OTC pairs are open at once (forex-OTC is 24/7, not gated), so
// the old flat limit=40 slice never even reached some of them. Picking
// "OTC" here filters BEFORE the scan limit is applied, so OTC pairs are
// guaranteed to show regardless of how many real-market pairs are open.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SmcScanResponse, Timeframe } from '@/lib/os/client'
import { fmtPrice, getSmcGlobal } from '@/lib/os/client'

interface SmcGlobalPanelProps {
  tf: Timeframe
  closedTick?: number
  onPickAsset?: (asset: string) => void
  /** open the per-asset SMC Recent panel for a row's pair (switches the
   * chart to it too) - distinct from onPickAsset, which only switches the
   * chart and leaves the board open. */
  onOpenSmc?: (asset: string) => void
  onClose: () => void
}

const POLL_MS = 12_000
const TFS: Timeframe[] = ['1m', '5m']
const LIMIT = 30

type DirFilter = 'all' | 'call' | 'put'
type ScopeFilter = 'all' | 'real' | 'otc'

function dirChip(direction: 'call' | 'put' | 'none') {
  const none = direction === 'none'
  const call = direction === 'call'
  const cls = none ? 'border-[#3d4d66] text-[#7c8aa5]' : call ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
  return (
    <span className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-wider ${cls}`}>
      {none ? '—' : call ? '▲ call' : '▼ put'}
    </span>
  )
}

function confBar(confidence: number) {
  const hue = confidence >= 80 ? 'bg-emerald-500/70' : confidence >= 60 ? 'bg-amber-500/70' : 'bg-[#24324a]'
  return (
    <div className="flex items-center gap-1">
      <div className="h-1.5 w-10 overflow-hidden rounded-full border border-[#1c2739] bg-[#0b111c]">
        <div className={`h-full ${hue}`} style={{ width: `${Math.min(100, Math.max(0, confidence))}%` }} />
      </div>
      <span className={`font-mono text-[9px] ${confidence >= 80 ? 'text-emerald-300' : confidence >= 60 ? 'text-amber-300' : 'text-[#4b5a72]'}`}>{confidence.toFixed(0)}%</span>
    </div>
  )
}

function ageLabel(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

export default function SmcGlobalPanel({ tf, closedTick, onPickAsset, onOpenSmc, onClose }: SmcGlobalPanelProps) {
  const [tfSel, setTfSel] = useState<Timeframe>(tf)
  const [rows, setRows] = useState<SmcScanResponse[]>([])
  const [meta, setMeta] = useState<{ scanned: number; universe: number; agreeing: number; scannedTs: number } | null>(null)
  const [dirFilter, setDirFilter] = useState<DirFilter>('all')
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [, forceTick] = useState(0)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const res = await getSmcGlobal(tfSel, { limit: LIMIT, marketScope: scopeFilter })
      if (res.ok) {
        setRows(res.rows)
        setMeta({ scanned: res.scanned, universe: res.universe, agreeing: res.agreeing, scannedTs: res.scannedTs })
        setErr(null)
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [tfSel, scopeFilter])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    const age = setInterval(() => forceTick((n) => n + 1), 5000)
    return () => {
      clearInterval(t)
      clearInterval(age)
    }
  }, [load, closedTick, tfSel, scopeFilter])

  const shown = useMemo(() => {
    const live = rows.filter((r) => r.result && (dirFilter === 'all' || r.result.summary.direction === dirFilter))
    return [...live].sort((a, b) => (b.result?.summary.confidence ?? 0) - (a.result?.summary.confidence ?? 0))
  }, [rows, dirFilter])

  const warmingCount = rows.filter((r) => !r.result).length
  const calls = rows.filter((r) => r.result?.summary.direction === 'call').length
  const puts = rows.filter((r) => r.result?.summary.direction === 'put').length
  const best = shown[0]

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">SMC Global</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">structure board · {meta ? `${meta.agreeing}/${meta.scanned} leaning` : '…'}</span>
        <div className="ml-auto flex items-center gap-1">
          {TFS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTfSel(t)}
              className={`rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase ${tfSel === t ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'}`}
            >
              {t}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] uppercase text-[#7c8aa5] hover:text-[#dbe4f0] disabled:opacity-40"
          >
            {busy ? '…' : 'refresh'}
          </button>
          <button type="button" onClick={onClose} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300">
            ✕
          </button>
        </div>
      </div>

      {err && <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5 font-mono text-[9px] text-rose-300">{err}</div>}

      {best?.result && (
        <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
          <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
            <span>strongest read</span>
            <span className="normal-case">
              {calls}▲ / {puts}▼
              {warmingCount > 0 && <span className="text-[#3d4d66]"> · {warmingCount} warming</span>}
              {meta && <span className="text-[#3d4d66]"> · scanned {ageLabel(meta.scannedTs)} ago</span>}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPickAsset?.(best.asset)}
              className="font-mono text-[12px] font-bold text-[#dbe4f0] underline decoration-[#24324a] underline-offset-2 hover:decoration-cyan-400"
              title="open this pair on the main chart"
            >
              {best.asset}
            </button>
            {dirChip(best.result.summary.direction)}
            {best.otc && <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-px font-mono text-[8px] font-bold uppercase text-amber-300">OTC</span>}
            <span className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[8.5px] uppercase text-[#7c8aa5]">structure {best.result.trend}</span>
            {onOpenSmc && (
              <button
                type="button"
                onClick={() => onOpenSmc(best.asset)}
                className="rounded border border-cyan-500/40 px-1.5 py-px font-mono text-[8.5px] uppercase text-cyan-300 hover:bg-cyan-500/10"
                title="open SMC Recent for this pair"
              >
                open smc
              </button>
            )}
            <span className="ml-auto font-mono text-[10px] text-[#7c8aa5]">
              {best.result.summary.bullish}▲/{best.result.summary.bearish}▼ active · {best.result.summary.confidence}%
            </span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1">
        {(['all', 'call', 'put'] as DirFilter[]).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDirFilter(d)}
            className={`rounded border px-1.5 py-px font-mono text-[8.5px] uppercase ${dirFilter === d ? 'border-[#3d4d66] bg-[#132034] text-[#dbe4f0]' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'}`}
          >
            {d}
          </button>
        ))}
        <span className="mx-0.5 h-3 w-px bg-[#1c2739]" />
        {(['all', 'real', 'otc'] as ScopeFilter[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScopeFilter(s)}
            title={s === 'otc' ? 'OTC pairs only - never crowded out by real-market pairs competing for the same scan limit' : s === 'real' ? 'real-market pairs only' : 'everything open, real + OTC'}
            className={`rounded border px-1.5 py-px font-mono text-[8.5px] uppercase ${scopeFilter === s ? 'border-amber-500/50 bg-amber-500/10 text-amber-300' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'}`}
          >
            {s === 'otc' ? 'OTC' : s}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1">
        {shown.length === 0 && !err && (
          <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#4b5a72]">no rows yet - give it a poll or two</div>
        )}
        {shown.map((r) => {
          const result = r.result
          if (!result) return null
          return (
            <div
              key={r.asset}
              role="button"
              tabIndex={0}
              onClick={() => onPickAsset?.(r.asset)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onPickAsset?.(r.asset) }}
              className="group flex items-center gap-2 rounded border border-[#1c2739] bg-[#0b111c] px-2 py-1 text-left hover:border-[#24324a]"
              title={`${r.asset} ${r.tf} · structure ${result.trend} · click to open on the chart`}
            >
              <span className="w-24 shrink-0 truncate font-mono text-[10px] font-bold text-[#dbe4f0] group-hover:text-cyan-300">{r.asset}</span>
              {r.otc && <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[7px] font-bold uppercase text-amber-300">OTC</span>}
              {dirChip(result.summary.direction)}
              {confBar(result.summary.confidence)}
              <span className="shrink-0 font-mono text-[8px] text-[#4b5a72]">{result.summary.bullish}▲/{result.summary.bearish}▼</span>
              {onOpenSmc && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onOpenSmc(r.asset) }}
                  className="shrink-0 rounded border border-cyan-500/40 px-1 py-px font-mono text-[7.5px] uppercase text-cyan-300 hover:bg-cyan-500/10"
                  title="open SMC Recent for this pair"
                >
                  smc
                </button>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[8px] text-[#4b5a72]">
                <span className="text-[#3d4d66]">{fmtPrice(result.price, r.asset)}</span>
                <span>{ageLabel(r.ts)}</span>
              </span>
            </div>
          )
        })}
        {warmingCount > 0 && dirFilter === 'all' && (
          <div className="rounded border border-dashed border-[#1c2739] px-2 py-1 font-mono text-[8px] text-[#3d4d66]">
            {warmingCount} pair{warmingCount > 1 ? 's' : ''} still warming up (need 60+ closed bars) - they join the board as their feeds fill
          </div>
        )}
      </div>
    </div>
  )
}
