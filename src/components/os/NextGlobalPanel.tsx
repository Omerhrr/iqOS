'use client'

// IQAIR//OS - Next Global panel
// The Next-Candle Oracle lifted from one chart to the whole universe: one
// fused next-candle read per open instrument, ranked by tradability
// (confidence x distance from coin-flip), with each pair's own honesty-loop
// record (n / hit rate / Brier) attached. Backed by /next_global
// (plugins/nextcandle.ts globalScan) - every row the board computes is
// tracked by the oracle's ledger, so the board and the per-asset oracle
// panel share one calibration record: scanning MORE pairs makes every
// oracle read better calibrated, faster.
//
// Rows are TTL-cached kernel-side (12s) and the board polls on every closed
// candle of the active chart plus a slow fallback, so a full universe
// refresh costs the kernel ~15ms x pairs once per TTL, not per poll.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { NextGlobalRow, Timeframe } from '@/lib/os/client'
import { fmtPrice, getNextGlobal } from '@/lib/os/client'

interface NextGlobalPanelProps {
  /** active chart timeframe - the board starts there but can switch */
  tf: Timeframe
  /** bumps on every closed candle of the active chart - drives refresh */
  closedTick?: number
  /** switch the main chart to a row's pair */
  onPickAsset?: (asset: string) => void
  onClose: () => void
}

const POLL_MS = 12_000
const TFS: Timeframe[] = ['1m', '5m']
const LIMIT = 30

type SortMode = 'edge' | 'conf' | 'record'
type DirFilter = 'all' | 'call' | 'put'

function regimeChip(regime: string) {
  const color =
    regime === 'TRENDING' ? 'border-cyan-500/40 text-cyan-300' :
    regime === 'RANGING' ? 'border-violet-500/40 text-violet-300' :
    regime === 'VOLATILE' ? 'border-orange-500/40 text-orange-300' :
    'border-[#3d4d66] text-[#7c8aa5]'
  return (
    <span className={`rounded border px-1 py-px font-mono text-[7.5px] font-bold uppercase tracking-wider ${color}`}>{regime}</span>
  )
}

function dirChip(direction: string) {
  const call = direction === 'call'
  const none = direction === 'none'
  const cls = none
    ? 'border-[#3d4d66] text-[#7c8aa5]'
    : call
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
      : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
  return (
    <span className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-wider ${cls}`}>
      {none ? '—' : call ? '▲ call' : '▼ put'}
    </span>
  )
}

function confBar(confidence: number) {
  const hue = confidence >= 60 ? 'bg-emerald-500/70' : confidence >= 40 ? 'bg-amber-500/70' : 'bg-[#24324a]'
  return (
    <div className="flex items-center gap-1">
      <div className="h-1.5 w-10 overflow-hidden rounded-full border border-[#1c2739] bg-[#0b111c]">
        <div className={`h-full ${hue}`} style={{ width: `${Math.min(100, Math.max(0, confidence))}%` }} />
      </div>
      <span className={`font-mono text-[9px] ${confidence >= 60 ? 'text-emerald-300' : confidence >= 40 ? 'text-amber-300' : 'text-[#4b5a72]'}`}>
        {confidence.toFixed(0)}%
      </span>
    </div>
  )
}

function recordBadge(row: NextGlobalRow) {
  const cal = row.calibration
  if (!cal || cal.n === 0) {
    return <span className="font-mono text-[8px] uppercase tracking-wider text-[#3d4d66]" title="no resolved oracle predictions on this pair:tf yet">uncal</span>
  }
  const good = cal.hitRate >= 0.55
  return (
    <span
      className={`font-mono text-[8px] ${good ? 'text-emerald-300/80' : 'text-amber-300/80'}`}
      title={`last ${cal.n} resolved predictions on ${row.asset}:${row.tf}: ${(cal.hitRate * 100).toFixed(0)}% hits, Brier ${cal.brier.toFixed(3)} (0.25 = honest coin)`}
    >
      {cal.n}·{(cal.hitRate * 100).toFixed(0)}%
    </span>
  )
}

function ageLabel(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

export default function NextGlobalPanel({ tf, closedTick, onPickAsset, onClose }: NextGlobalPanelProps) {
  const [tfSel, setTfSel] = useState<Timeframe>(tf)
  const [rows, setRows] = useState<NextGlobalRow[]>([])
  const [meta, setMeta] = useState<{ scanned: number; live: number; warming: number; universe: number; refreshed: number; scannedTs: number } | null>(null)
  const [sort, setSort] = useState<SortMode>('edge')
  const [dirFilter, setDirFilter] = useState<DirFilter>('all')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [, forceTick] = useState(0) // re-render for age labels

  const load = useCallback(async (refresh = false) => {
    setBusy(true)
    try {
      const res = await getNextGlobal(tfSel, { limit: LIMIT, refresh })
      if (res.ok && res.rows) {
        setRows(res.rows)
        setMeta({ scanned: res.scanned, live: res.live, warming: res.warming, universe: res.universe, refreshed: res.refreshed, scannedTs: res.scannedTs })
        setErr(null)
      } else {
        setErr(res.error ?? 'next global unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [tfSel])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    const age = setInterval(() => forceTick((n) => n + 1), 5000)
    return () => {
      clearInterval(t)
      clearInterval(age)
    }
  }, [load, closedTick, tfSel])

  const shown = useMemo(() => {
    const live = rows.filter((r) => r.ok && (dirFilter === 'all' || r.direction === dirFilter))
    const sorted = [...live]
    if (sort === 'edge') sorted.sort((a, b) => b.confidence * Math.abs(b.pUp - 0.5) - a.confidence * Math.abs(a.pUp - 0.5))
    else if (sort === 'conf') sorted.sort((a, b) => b.confidence - a.confidence)
    else sorted.sort((a, b) => (b.calibration?.n ?? 0) - (a.calibration?.n ?? 0))
    return sorted
  }, [rows, sort, dirFilter])

  const warmingCount = rows.filter((r) => !r.ok).length
  const calls = rows.filter((r) => r.ok && r.direction === 'call').length
  const puts = rows.filter((r) => r.ok && r.direction === 'put').length
  const best = shown[0]

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-sky-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Next Global</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">oracle board · {meta ? `${meta.live}/${meta.scanned} live` : '…'}</span>
        <div className="ml-auto flex items-center gap-1">
          {TFS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTfSel(t)}
              className={`rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase ${tfSel === t ? 'border-sky-500/50 bg-sky-500/10 text-sky-300' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'}`}
            >
              {t}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={busy}
            className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] uppercase text-[#7c8aa5] hover:text-[#dbe4f0] disabled:opacity-40"
            title="force a fresh fusion on every row (bypass the 12s board cache)"
          >
            {busy ? '…' : 'rescan'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
          >
            ✕
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5 font-mono text-[9px] text-rose-300">{err}</div>
      )}

      {/* board header: the one row worth looking at first + board counts */}
      {best && (
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
              className="font-mono text-[12px] font-bold text-[#dbe4f0] underline decoration-[#24324a] underline-offset-2 hover:decoration-sky-400"
              title="open this pair on the main chart"
            >
              {best.asset}
            </button>
            {dirChip(best.direction)}
            {regimeChip(best.regime)}
            <span className="ml-auto font-mono text-[10px] text-[#7c8aa5]">
              P(up) <span className={best.pUp >= 0.5 ? 'text-emerald-300' : 'text-rose-300'}>{(best.pUp * 100).toFixed(1)}%</span>
              {' · '}exp {fmtPrice(best.expectedMove, best.asset)} ({(best.expectedMove / Math.max(best.atr, 1e-9)).toFixed(2)}× ATR)
            </span>
          </div>
          <p className="mt-1 font-mono text-[8px] text-[#3d4d66]">
            every row is the full 7-model fused oracle read, tracked by the honesty loop - the board scans more pairs so every oracle read calibrates faster
          </p>
        </div>
      )}

      {/* filters */}
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
        <span className="mx-1 h-3 w-px bg-[#1c2739]" />
        {([['edge', 'edge×conf'], ['conf', 'confidence'], ['record', 'record depth']] as [SortMode, string][]).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setSort(m)}
            className={`rounded border px-1.5 py-px font-mono text-[8.5px] uppercase ${sort === m ? 'border-[#3d4d66] bg-[#132034] text-[#dbe4f0]' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* the board */}
      <div className="flex min-h-0 flex-1 flex-col gap-1">
        {shown.length === 0 && !err && (
          <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#4b5a72]">
            no rows yet - first scan seeds history across the universe, give it a poll or two
          </div>
        )}
        {shown.map((r) => {
          const edge = (r.pUp - 0.5) * 100
          return (
            <button
              key={r.asset}
              type="button"
              onClick={() => onPickAsset?.(r.asset)}
              className="group flex items-center gap-2 rounded border border-[#1c2739] bg-[#0b111c] px-2 py-1 text-left hover:border-[#24324a]"
              title={`${r.asset} ${r.tf} · P(up) ${(r.pUp * 100).toFixed(1)}% · ${r.driversActive} models · click to open on the chart`}
            >
              <span className="w-24 shrink-0 truncate font-mono text-[10px] font-bold text-[#dbe4f0] group-hover:text-sky-300">{r.asset}</span>
              {dirChip(r.direction)}
              <span className={`w-14 shrink-0 text-right font-mono text-[9px] ${edge >= 0 ? 'text-emerald-300/80' : 'text-rose-300/80'}`}>
                {edge >= 0 ? '+' : ''}{edge.toFixed(1)}pp
              </span>
              {confBar(r.confidence)}
              {regimeChip(r.regime)}
              <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[8px] text-[#4b5a72]">
                {recordBadge(r)}
                <span className="text-[#3d4d66]">{fmtPrice(r.price, r.asset)}</span>
                <span>{ageLabel(r.computedTs)}</span>
              </span>
            </button>
          )
        })}
        {warmingCount > 0 && dirFilter === 'all' && (
          <div className="rounded border border-dashed border-[#1c2739] px-2 py-1 font-mono text-[8px] text-[#3d4d66]">
            {warmingCount} pair{warmingCount > 1 ? 's' : ''} still warming up (lazy-seeded history, need 320+ closed bars) - they join the board as their feeds fill
          </div>
        )}
      </div>
    </div>
  )
}
