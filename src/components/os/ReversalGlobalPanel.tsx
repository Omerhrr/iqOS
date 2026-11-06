'use client'

// IQAIR//OS - Reversal Global panel
// The Reversal Radar lifted to the whole universe: one urgency-ranked row
// per open instrument - "this pair, WHICH timeframe is turning" - with the
// most urgent live read (reversing now > confirmed > forming > calm) as the
// row's chip and the 10-rung state strip beside it. Backed by
// /reversal_global (plugins/reversal.ts globalScan), TTL-cached kernel-side.

import { useCallback, useEffect, useState } from 'react'
import type { ReversalGlobalRow, ReversalState } from '@/lib/os/client'
import { fmtPrice, getReversalGlobal } from '@/lib/os/client'

interface ReversalGlobalPanelProps {
  /** bumps on every closed candle of the active chart - drives refresh */
  closedTick?: number
  /** switch the main chart to a row's pair */
  onPickAsset?: (asset: string) => void
  /** open the per-asset Reversal Radar panel for a row's pair */
  onOpenReversal?: (asset: string) => void
  onClose: () => void
}

const POLL_MS = 10_000

type StateFilter = 'all' | 'reversing' | 'confirmed' | 'forming'

const STATE_CLASS: Record<ReversalState, string> = {
  calm: 'border-[#3d4d66] text-[#7c8aa5]',
  forming: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  reversing: 'border-fuchsia-500/50 bg-fuchsia-500/15 text-fuchsia-300',
  confirmed: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
}

const CELL_CLASS: Record<ReversalState, string> = {
  calm: 'border-[#1c2739] text-[#3d4d66]',
  forming: 'border-amber-500/40 text-amber-300',
  reversing: 'border-fuchsia-500/60 text-fuchsia-300',
  confirmed: 'border-cyan-500/40 text-cyan-300',
}

const STATE_HELP: Record<ReversalState, string> = {
  calm: 'no stretch, no trigger',
  forming: 'extreme in place, no bar-0 trigger yet',
  reversing: 'bar-0 trigger fired on the latest closed bar',
  confirmed: 'prior-bar trigger + follow-through close',
}

function TfStrip({ row }: { row: ReversalGlobalRow }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5" title="per-timeframe reversal states across the 1s..5m ladder: FN = forming, RV = reversing now, CF = confirmed, dashes dashed = warming up">
      {row.cells.map((c) => {
        const up = c.direction === 'up'
        const dn = c.direction === 'down'
        return (
          <span
            key={c.tf}
            className={`flex h-4 w-[26px] items-center justify-center rounded-sm border font-mono text-[7px] font-bold uppercase ${c.ok ? CELL_CLASS[c.state] : 'border-dashed border-[#24324a] text-[#3d4d66]'}`}
            title={c.ok ? `${c.tf}: ${c.state}${c.direction !== 'none' ? ` ${c.direction}` : ''} (w ${c.score >= 0 ? '+' : ''}${c.score})` : `${c.tf}: warming up`}
            style={c.state === 'reversing' && (up || dn) ? { backgroundColor: up ? 'rgba(217,70,239,0.18)' : 'rgba(217,70,239,0.18)' } : undefined}
          >
            {!c.ok ? '·' : c.state === 'forming' ? 'FN' : c.state === 'reversing' ? 'RV' : c.state === 'confirmed' ? 'CF' : '—'}
          </span>
        )
      })}
    </span>
  )
}

export default function ReversalGlobalPanel({ closedTick, onPickAsset, onOpenReversal, onClose }: ReversalGlobalPanelProps) {
  const [rows, setRows] = useState<ReversalGlobalRow[]>([])
  const [meta, setMeta] = useState<{ scanned: number; live: number; warming: number; universe: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')

  const load = useCallback(async () => {
    try {
      const d = await getReversalGlobal({})
      if (d.ok) {
        setRows(d.rows)
        setMeta({ scanned: d.scanned, live: d.live, warming: d.warming, universe: d.universe })
        setErr(null)
      } else {
        setErr(d.error ?? 'reversal global unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick])

  const filtered = rows.filter((r) => (stateFilter === 'all' ? true : r.state === stateFilter))
  const counts = {
    reversing: rows.filter((r) => r.ok && r.state === 'reversing').length,
    confirmed: rows.filter((r) => r.ok && r.state === 'confirmed').length,
    forming: rows.filter((r) => r.ok && r.state === 'forming').length,
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Reversal Global</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]" title="one urgency-ranked reversal read per open pair">
          {meta ? `${meta.live} live · ${meta.warming} warming · universe ${meta.universe}` : 'loading…'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {(['all', 'reversing', 'confirmed', 'forming'] as StateFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setStateFilter(f)}
              className={`rounded border px-1.5 py-px font-mono text-[8.5px] uppercase ${stateFilter === f ? 'border-[#3d4d66] bg-[#0e1524] text-[#dbe4f0]' : 'border-[#1c2739] text-[#7c8aa5] hover:text-[#dbe4f0]'}`}
            >
              {f}
            </button>
          ))}
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
          >
            close
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-[9px] text-amber-300">{err}</div>
      )}

      {meta && (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[8.5px] text-[#7c8aa5]">
          <span className={`rounded border px-1.5 py-px ${STATE_CLASS.reversing}`} title={STATE_HELP.reversing}>{counts.reversing} reversing now</span>
          <span className={`rounded border px-1.5 py-px ${STATE_CLASS.confirmed}`} title={STATE_HELP.confirmed}>{counts.confirmed} confirmed</span>
          <span className={`rounded border px-1.5 py-px ${STATE_CLASS.forming}`} title={STATE_HELP.forming}>{counts.forming} forming</span>
          <span className="text-[#4b5a72]">rows ranked by urgency then |score| · click a row to open its Reversal Radar</span>
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        {filtered.map((r) => (
          <button
            key={r.asset}
            type="button"
            onClick={() => onOpenReversal?.(r.asset)}
            onAuxClick={() => onPickAsset?.(r.asset)}
            className={`flex items-center gap-2 rounded border px-1.5 py-1 text-left transition-colors ${r.ok ? 'border-[#1c2739] bg-[#0b111c] hover:border-[#3d4d66]' : 'border-dashed border-[#24324a] bg-[#0b111c]'} ${r.state === 'reversing' ? 'animate-pulse' : ''}`}
            title={r.ok ? `${r.asset}: ${r.state}${r.direction !== 'none' ? ` ${r.direction}` : ''} (w ${r.score >= 0 ? '+' : ''}${r.score}) · ${r.note}` : `${r.asset}: ${r.note}`}
          >
            <span className={`w-4 shrink-0 text-center font-mono text-[10px] font-bold ${r.direction === 'up' ? 'text-emerald-300' : r.direction === 'down' ? 'text-rose-300' : 'text-[#3d4d66]'}`}>
              {r.direction === 'up' ? '▲' : r.direction === 'down' ? '▼' : '—'}
            </span>
            <span className={`w-24 shrink-0 truncate font-mono text-[10px] font-bold ${r.ok ? 'text-[#dbe4f0]' : 'text-[#7c8aa5]'}`}>{r.asset}</span>
            {r.ok ? (
              <>
                <span className={`shrink-0 rounded border px-1.5 py-px font-mono text-[8px] font-bold uppercase ${STATE_CLASS[r.state]}`}>
                  {r.state === 'calm' ? 'calm' : r.best ? `${r.best.tf} ${r.state === 'reversing' ? 'reversing now' : r.state}` : 'calm'}
                </span>
                <span className={`w-9 shrink-0 text-right font-mono text-[9px] ${r.direction === 'up' ? 'text-emerald-300' : r.direction === 'down' ? 'text-rose-300' : 'text-[#7c8aa5]'}`}>
                  {r.score >= 0 ? '+' : ''}{r.score}
                </span>
                <TfStrip row={r} />
                <span className="ml-auto shrink-0 font-mono text-[8.5px] text-[#7c8aa5]">{fmtPrice(r.price, r.asset)}</span>
              </>
            ) : (
              <span className="font-mono text-[8.5px] text-[#4b5a72]">{r.note}</span>
            )}
          </button>
        ))}
        {filtered.length === 0 && !err && (
          <p className="p-2 font-mono text-[9px] text-[#3d4d66]">no rows match this filter…</p>
        )}
      </div>
    </div>
  )
}
