'use client'

// IQAIR//OS - Technical Global panel
// The Technical Summary lifted from one chart to the whole universe: one
// cross-timeframe consensus verdict per open instrument (STRONG BUY ..
// STRONG SELL over the 10-rung 1s..5m ladder), ranked by conviction
// (|score| first), each row with its 10-rung mini strip. Backed by
// /technical_global (plugins/technical.ts globalScan) - rows are TTL-cached
// kernel-side (15s) and the board polls on every closed chart candle plus a
// fallback interval.

import { useCallback, useEffect, useState } from 'react'
import type { TechnicalGlobalRow } from '@/lib/os/client'
import { fmtPrice, getTechnicalGlobal } from '@/lib/os/client'

interface TechnicalGlobalPanelProps {
  /** bumps on every closed candle of the active chart - drives refresh */
  closedTick?: number
  /** switch the main chart to a row's pair */
  onPickAsset?: (asset: string) => void
  /** open the per-asset Technical Summary panel for a row's pair */
  onOpenTechnical?: (asset: string) => void
  onClose: () => void
}

const POLL_MS = 12_000

type DirFilter = 'all' | 'call' | 'put'

function stripLabel(label: TechnicalGlobalRow['overall']['label']): string {
  return label === 'STRONG BUY' ? 'S.BUY' : label === 'STRONG SELL' ? 'S.SELL' : label
}

const LABEL_CLASS: Record<TechnicalGlobalRow['overall']['label'], string> = {
  'STRONG BUY': 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
  'BUY': 'border-green-500/40 bg-green-500/10 text-green-300',
  'NEUTRAL': 'border-[#3d4d66] text-[#7c8aa5]',
  'SELL': 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  'STRONG SELL': 'border-red-500/50 bg-red-500/15 text-red-300',
}

function cellStyle(label: TechnicalGlobalRow['overall']['label'], score: number): React.CSSProperties | undefined {
  if (label === 'NEUTRAL') return undefined
  const strength = Math.max(0.1, Math.min(1, Math.abs(score) * 2))
  const up = label === 'STRONG BUY' || label === 'BUY'
  return { backgroundColor: up ? `rgba(16,185,129,${0.12 + strength * 0.4})` : `rgba(244,63,94,${0.12 + strength * 0.4})` }
}

function TfStrip({ row }: { row: TechnicalGlobalRow }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5" title="per-timeframe verdicts across the 1s..5m ladder: color = direction, opacity = conviction, dashed = warming up, ring = strongest rung">
      {row.cells.map((c) => (
        <span
          key={c.tf}
          className={`flex h-4 w-[26px] items-center justify-center rounded-sm border font-mono text-[7.5px] font-bold ${c.ok ? 'border-[#1c2739]' : 'border-dashed border-[#24324a] text-[#3d4d66]'} ${row.strongest?.tf === c.tf && c.ok ? 'ring-1 ring-amber-400/60' : ''} ${LABEL_CLASS[c.label]}`}
          style={c.ok ? cellStyle(c.label, c.score) : undefined}
          title={c.ok ? `${c.tf}: ${c.label} (${c.score >= 0 ? '+' : ''}${c.score.toFixed(2)})` : `${c.tf}: warming up`}
        >
          {!c.ok ? '·' : stripLabel(c.label) === 'S.BUY' ? '▲▲' : stripLabel(c.label) === 'BUY' ? '▲' : stripLabel(c.label) === 'S.SELL' ? '▼▼' : stripLabel(c.label) === 'SELL' ? '▼' : '—'}
        </span>
      ))}
    </span>
  )
}

export default function TechnicalGlobalPanel({ closedTick, onPickAsset, onOpenTechnical, onClose }: TechnicalGlobalPanelProps) {
  const [rows, setRows] = useState<TechnicalGlobalRow[]>([])
  const [meta, setMeta] = useState<{ scanned: number; live: number; warming: number; universe: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dirFilter, setDirFilter] = useState<DirFilter>('all')

  const load = useCallback(async () => {
    try {
      const d = await getTechnicalGlobal({})
      if (d.ok) {
        setRows(d.rows)
        setMeta({ scanned: d.scanned, live: d.live, warming: d.warming, universe: d.universe })
        setErr(null)
      } else {
        setErr(d.error ?? 'technical global unavailable')
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

  const filtered = rows.filter((r) => (dirFilter === 'all' ? true : dirFilter === 'call' ? r.direction === 'call' : r.direction === 'put'))
  const buys = rows.filter((r) => r.ok && r.overall.score >= 0.15).length
  const sells = rows.filter((r) => r.ok && r.overall.score <= -0.15).length

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-lime-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Technical Global</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]" title="one cross-timeframe consensus per open pair, ranked by conviction">
          {meta ? `${meta.live} live · ${meta.warming} warming · universe ${meta.universe}` : 'loading…'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {(['all', 'call', 'put'] as DirFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setDirFilter(f)}
              className={`rounded border px-1.5 py-px font-mono text-[8.5px] uppercase ${dirFilter === f ? 'border-[#3d4d66] bg-[#0e1524] text-[#dbe4f0]' : 'border-[#1c2739] text-[#7c8aa5] hover:text-[#dbe4f0]'}`}
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
          <span className="rounded border border-emerald-500/40 px-1.5 py-px text-emerald-300" title="pairs whose cross-TF consensus is BUY/STRONG BUY">{buys} bullish</span>
          <span className="rounded border border-rose-500/40 px-1.5 py-px text-rose-300" title="pairs whose cross-TF consensus is SELL/STRONG SELL">{sells} bearish</span>
          <span className="text-[#4b5a72]">consensus = mean of each pair&apos;s live rung scores · click a row to open its Technical Summary</span>
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        {filtered.map((r) => (
          <button
            key={r.asset}
            type="button"
            onClick={() => onOpenTechnical?.(r.asset)}
            onAuxClick={() => onPickAsset?.(r.asset)}
            className={`flex items-center gap-2 rounded border px-1.5 py-1 text-left transition-colors ${r.ok ? 'border-[#1c2739] bg-[#0b111c] hover:border-[#3d4d66]' : 'border-dashed border-[#24324a] bg-[#0b111c]'}`}
            title={r.ok ? `${r.asset}: ${r.overall.label} (score ${r.overall.score >= 0 ? '+' : ''}${r.overall.score.toFixed(2)}) · ${r.note}` : `${r.asset}: ${r.note}`}
          >
            <span className={`w-4 shrink-0 text-center font-mono text-[10px] font-bold ${r.direction === 'call' ? 'text-emerald-300' : r.direction === 'put' ? 'text-rose-300' : 'text-[#3d4d66]'}`}>
              {r.direction === 'call' ? '▲' : r.direction === 'put' ? '▼' : '—'}
            </span>
            <span className={`w-24 shrink-0 truncate font-mono text-[10px] font-bold ${r.ok ? 'text-[#dbe4f0]' : 'text-[#7c8aa5]'}`}>{r.asset}</span>
            {r.ok ? (
              <>
                <span className={`shrink-0 rounded border px-1.5 py-px font-mono text-[8px] font-bold uppercase ${LABEL_CLASS[r.overall.label]}`}>{r.overall.label}</span>
                <span className={`w-10 shrink-0 text-right font-mono text-[9px] ${r.overall.score >= 0.15 ? 'text-emerald-300' : r.overall.score <= -0.15 ? 'text-rose-300' : 'text-[#7c8aa5]'}`}>
                  {r.overall.score >= 0 ? '+' : ''}{r.overall.score.toFixed(2)}
                </span>
                <TfStrip row={r} />
                <span className="ml-auto shrink-0 font-mono text-[8.5px] text-[#7c8aa5]">
                  {r.strongest ? `top ${r.strongest.tf}` : ''} · {fmtPrice(r.price, r.asset)}
                </span>
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
