'use client'

// IQAIR//OS - Next-Expiry Global panel
// The Next-Expiry Oracle lifted from one chart to the whole universe: one
// fused best-expiry read per open instrument - "this pair, WHICH expiry"
// - ranked by edge, with each pair's 5-rung mini strip (1/2/3/5/15m
// direction reads at a glance) and its own honesty-loop record attached.
// Backed by /next_expiry_global (plugins/nextexpiry.ts globalScan) - every
// row the board computes is tracked by the expiry oracle's ledger, so the
// board and the per-asset expiry panel share one calibration record.
//
// Rows are TTL-cached kernel-side (15s) and the board polls on every closed
// candle of the active chart plus a fallback interval, so a full universe
// refresh costs the kernel one fusion per pair per TTL, not per poll.
// Deliberately tf-free: the expiry ladder is minute-native.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { NextExpiryGlobalRow } from '@/lib/os/client'
import { fmtPrice, getNextExpiryGlobal } from '@/lib/os/client'

interface NextExpiryGlobalPanelProps {
  /** bumps on every closed candle of the active chart - drives refresh */
  closedTick?: number
  /** switch the main chart to a row's pair */
  onPickAsset?: (asset: string) => void
  /** open the per-asset Next-Expiry Oracle panel for a row's pair (switches
   * the chart to it too) - distinct from onPickAsset, which only switches
   * the chart and leaves the board open. */
  onOpenNextExpiry?: (asset: string) => void
  onClose: () => void
}

const POLL_MS = 12_000

const RUNG_ACCENT: Record<number, string> = {
  1: 'text-sky-300',
  2: 'text-cyan-300',
  3: 'text-teal-300',
  5: 'text-emerald-300',
  15: 'text-lime-300',
}

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

function bestChip(row: NextExpiryGlobalRow) {
  const b = row.best
  if (!b) {
    return (
      <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-wider text-[#7c8aa5]" title={row.note}>
        — wait
      </span>
    )
  }
  const call = b.direction === 'call'
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-wider ${
        call ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
      }`}
      title={`best expiry ${b.expiry}m ${b.direction} · pWin ${(b.pWin * 100).toFixed(1)}% · conf ${b.confidence.toFixed(0)} · edge ${b.edge.toFixed(3)}`}
    >
      {b.expiry}m {call ? '▲' : '▼'}
    </span>
  )
}

/** The 5-rung mini strip: one slot per ladder expiry, arrow = that rung's
 * direction lean, brightness = its pWin distance from coin-flip, hollow =
 * still warming. The best rung gets a ring. */
function RungStrip({ row }: { row: NextExpiryGlobalRow }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5" title="per-expiry reads: ▲/▼ = that rung's lean, box opacity = distance from coin-flip, ring = the oracle's best pick">
      {row.rungs.map((r) => {
        const call = r.direction === 'call'
        const put = r.direction === 'put'
        const strength = Math.max(0.12, (r.pWin - 0.5) * 2)
        const isBest = row.best?.expiry === r.expiry
        return (
          <span
            key={r.expiry}
            className={`flex h-4 w-6 items-center justify-center rounded-sm border font-mono text-[8px] font-bold ${
              isBest ? 'border-amber-400/70' : 'border-[#1c2739]'
            } ${r.ok ? '' : 'border-dashed border-[#24324a] text-[#3d4d66]'}`}
            style={r.ok && (call || put) ? { backgroundColor: call ? `rgba(16,185,129,${0.15 + strength * 0.5})` : `rgba(244,63,94,${0.15 + strength * 0.5})` } : undefined}
          >
            {!r.ok ? '·' : call ? '▲' : put ? '▼' : '—'}
          </span>
        )
      })}
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

function recordBadge(row: NextExpiryGlobalRow) {
  const cal = row.calibration
  if (!cal || cal.n === 0) {
    return <span className="font-mono text-[8px] uppercase tracking-wider text-[#3d4d66]" title="no resolved windows on this pair's best expiry yet">uncal</span>
  }
  const good = cal.hitRate >= 0.55
  return (
    <span
      className={`font-mono text-[8px] ${good ? 'text-emerald-300/80' : 'text-amber-300/80'}`}
      title={`last ${cal.n} resolved windows on ${row.asset} at the ${row.best?.expiry ?? '?'}m expiry: ${(cal.hitRate * 100).toFixed(0)}% hits, Brier ${cal.brier.toFixed(3)} (0.25 = honest coin)`}
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

export default function NextExpiryGlobalPanel({ closedTick, onPickAsset, onOpenNextExpiry, onClose }: NextExpiryGlobalPanelProps) {
  const [rows, setRows] = useState<NextExpiryGlobalRow[]>([])
  const [meta, setMeta] = useState<{ scanned: number; live: number; warming: number; universe: number; refreshed: number; scannedTs: number } | null>(null)
  const [sort, setSort] = useState<SortMode>('edge')
  const [dirFilter, setDirFilter] = useState<DirFilter>('all')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [, forceTick] = useState(0) // re-render for age labels

  const load = useCallback(async (refresh = false) => {
    setBusy(true)
    try {
      // no limit passed - the whole open universe is scanned kernel-side
      // (limit is a safety ceiling there, never a silent truncation)
      const res = await getNextExpiryGlobal({ refresh })
      if (res.ok && res.rows) {
        setRows(res.rows)
        setMeta({ scanned: res.scanned, live: res.live, warming: res.warming, universe: res.universe, refreshed: res.refreshed, scannedTs: res.scannedTs })
        setErr(null)
      } else {
        setErr(res.error ?? 'next-expiry global unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    const age = setInterval(() => forceTick((n) => n + 1), 5000)
    return () => {
      clearInterval(t)
      clearInterval(age)
    }
  }, [load, closedTick])

  const shown = useMemo(() => {
    const live = rows.filter((r) => r.ok && (dirFilter === 'all' || r.best?.direction === dirFilter))
    const sorted = [...live]
    if (sort === 'edge') sorted.sort((a, b) => (b.best?.edge ?? 0) - (a.best?.edge ?? 0))
    else if (sort === 'conf') sorted.sort((a, b) => (b.best?.confidence ?? 0) - (a.best?.confidence ?? 0))
    else sorted.sort((a, b) => (b.calibration?.n ?? 0) - (a.calibration?.n ?? 0))
    return sorted
  }, [rows, sort, dirFilter])

  const warmingCount = rows.filter((r) => !r.ok).length
  const calls = rows.filter((r) => r.ok && r.best?.direction === 'call').length
  const puts = rows.filter((r) => r.ok && r.best?.direction === 'put').length
  const waits = rows.filter((r) => r.ok && !r.best).length
  const best = shown[0]

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-sky-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Next-Expiry Global</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">expiry board · {meta ? `${meta.live}/${meta.scanned} live` : '…'}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={busy}
            className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] uppercase text-[#7c8aa5] hover:text-[#dbe4f0] disabled:opacity-40"
            title="force a fresh fusion on every row (bypass the 15s board cache)"
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
            <span>strongest expiry read</span>
            <span className="normal-case">
              {calls}▲ / {puts}▼{waits > 0 && <span className="text-[#3d4d66]"> · {waits} wait</span>}
              {warmingCount > 0 && <span className="text-[#3d4d66]"> · {warmingCount} warming</span>}
              {meta && <span className="text-[#3d4d66]"> · scanned {ageLabel(meta.scannedTs)} ago</span>}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onPickAsset?.(best.asset)}
              className="font-mono text-[12px] font-bold text-[#dbe4f0] underline decoration-[#24324a] underline-offset-2 hover:decoration-sky-400"
              title="open this pair on the main chart"
            >
              {best.asset}
            </button>
            {bestChip(best)}
            {regimeChip(best.regime)}
            {onOpenNextExpiry && (
              <button
                type="button"
                onClick={() => onOpenNextExpiry(best.asset)}
                className="rounded border border-sky-500/40 px-1.5 py-px font-mono text-[8.5px] uppercase text-sky-300 hover:bg-sky-500/10"
                title="open the full Next-Expiry Oracle panel for this pair"
              >
                open expiry panel
              </button>
            )}
            <span className="ml-auto font-mono text-[10px] text-[#7c8aa5]">
              {best.best ? (
                <>
                  pWin <span className={best.best.direction === 'call' ? 'text-emerald-300' : 'text-rose-300'}>{(best.best.pWin * 100).toFixed(1)}%</span>
                  {' · '}exp {fmtPrice(best.price, best.asset)} spot · {best.liveRungs}/5 rungs live
                </>
              ) : (
                <>{best.liveRungs}/5 rungs live</>
              )}
            </span>
          </div>
          <p className="mt-1 font-mono text-[8px] text-[#3d4d66]">
            every row is the full per-expiry fused read, tracked by the honesty loop - the board scans more pairs so every rung calibrates faster
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
        {([['edge', 'edge'], ['conf', 'confidence'], ['record', 'record depth']] as [SortMode, string][]).map(([m, label]) => (
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
        {shown.map((r) => (
          <div
            key={r.asset}
            role="button"
            tabIndex={0}
            onClick={() => onPickAsset?.(r.asset)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onPickAsset?.(r.asset) }}
            className="group flex items-center gap-2 rounded border border-[#1c2739] bg-[#0b111c] px-2 py-1 text-left hover:border-[#24324a]"
            title={`${r.asset} · ${r.note} · click to open on the chart`}
          >
            <span className="w-24 shrink-0 truncate font-mono text-[10px] font-bold text-[#dbe4f0] group-hover:text-sky-300">{r.asset}</span>
            {bestChip(r)}
            <RungStrip row={r} />
            {regimeChip(r.regime)}
            {onOpenNextExpiry && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenNextExpiry(r.asset) }}
                className="shrink-0 rounded border border-sky-500/40 px-1 py-px font-mono text-[7.5px] uppercase text-sky-300 hover:bg-sky-500/10"
                title="open the full Next-Expiry Oracle panel for this pair"
              >
                expiry
              </button>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[8px] text-[#4b5a72]">
              {recordBadge(r)}
              {confBar(r.best?.confidence ?? 0)}
              <span className="text-[#3d4d66]">{fmtPrice(r.price, r.asset)}</span>
              <span>{r.computedTs ? ageLabel(r.computedTs) : 'warm'}</span>
            </span>
          </div>
        ))}
        {warmingCount > 0 && dirFilter === 'all' && (
          <div className="rounded border border-dashed border-[#1c2739] px-2 py-1 font-mono text-[8px] text-[#3d4d66]">
            {warmingCount} pair{warmingCount > 1 ? 's' : ''} still warming up (lazy-seeded history, need 720+ closed 1m bars) - they join the board as their feeds fill
          </div>
        )}
      </div>
    </div>
  )
}
