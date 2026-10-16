'use client'

// IQAIR//OS - Chart Signals Distill panel: the Kalman-OU-smoothed read of the
// combined chart-engine vote, scanned across every open instrument (same
// "list of candidates, not one number" shape as Chart Signals/Lead-Lag,
// instead of reading only whatever's on the active chart). Backed by
// index.ts's /distill_scan, which caches the full-universe pass for
// SCAN_CACHE_MS since each row still costs `window`x a normal vote read
// (see analytics/chartsignalsdistill.ts's cost note).

import { useCallback, useEffect, useState } from 'react'
import type { DistillScanResponse, DistillScanRow, Timeframe } from '@/lib/os/client'
import { getDistillScan, fmtPrice } from '@/lib/os/client'

const POLL_MS = 10_000

function dirChip(direction: 'call' | 'put' | null) {
  if (!direction) {
    return <span className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">flat</span>
  }
  const call = direction === 'call'
  return (
    <span
      className={`rounded px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-wider ${
        call ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
      }`}
    >
      {call ? '▲ call' : '▼ put'}
    </span>
  )
}

function DistillCard({ r, onSelectAsset }: { r: DistillScanRow; onSelectAsset?: (a: string) => void }) {
  const strong = Math.abs(r.filtered) >= 30
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(r.asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(r.asset)
      }}
      className={`w-full cursor-pointer rounded-lg border p-2 text-left transition-opacity hover:border-amber-500/40 ${
        strong ? 'border-amber-500/30 bg-[#17130a]' : 'border-[#1c2739] bg-[#0b111c]'
      }`}
      title={`open ${r.asset} on the chart`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {dirChip(r.direction)}
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{r.asset}</span>
        {r.otc && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400">otc</span>
        )}
        <span className="font-mono text-[9px] text-[#4b5a72]">{fmtPrice(r.price, r.asset)}</span>
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">z {r.z.toFixed(1)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#7c8aa5]">
        <span title="this bar's raw (undistilled) combined chart-engine vote score">
          raw <span className="text-[#aebccf]">{r.rawScore >= 0 ? '+' : ''}{r.rawScore.toFixed(0)}</span>
        </span>
        <span title="raw score run through an OU fit + Kalman forward pass - the decluttered read">
          distilled <span className={Math.abs(r.filtered) >= 30 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.filtered >= 0 ? '+' : ''}{r.filtered.toFixed(0)}</span>
        </span>
        <span title="OU fit significance of the vote-score series">t-stat {r.tStat.toFixed(1)}</span>
      </div>
    </div>
  )
}

export default function ChartSignalsDistillPanel({
  onClose,
  tf,
  onSelectAsset,
}: {
  onClose: () => void
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
}) {
  const [data, setData] = useState<DistillScanResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [onlyStrong, setOnlyStrong] = useState(false)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true)
      getDistillScan(tf)
        .then((d) => {
          if (d?.ok) {
            setData(d)
            setError(null)
          }
        })
        .catch((err: Error) => setError(err.message.slice(0, 180)))
        .finally(() => setLoading(false))
    },
    [tf],
  )

  useEffect(() => {
    load()
    const iv = setInterval(() => load({ quiet: true }), POLL_MS)
    return () => clearInterval(iv)
  }, [load])

  const needle = query.trim().toLowerCase()
  const rows = (data?.rows ?? [])
    .filter((r) => (onlyStrong ? Math.abs(r.filtered) >= 30 : true))
    .filter((r) => (!needle ? true : r.asset.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)))

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">Chart Distill</span>
        <span className="font-mono text-[8px] text-[#3d4d66]">{tf}</span>
        {data && <span className="ml-auto font-mono text-[8px] text-[#4b5a72]">{data.scanned} scanned</span>}
        <button
          type="button"
          onClick={onClose}
          title="close"
          className="ml-1 rounded px-1.5 py-0.5 font-mono text-[9px] text-[#5a6a85] hover:bg-[#1c2739] hover:text-[#aebccf]"
        >
          ✕
        </button>
      </div>

      <div className="flex items-center gap-1 border-b border-[#1c2739] px-2 py-1">
        <div className="relative min-w-0 flex-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="search… e.g. BTCUSD, XAUUSD"
            spellCheck={false}
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1 pr-6 font-mono text-[10px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-amber-500/50"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              title="clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 font-mono text-[10px] text-[#4b5a72] hover:text-rose-300"
            >
              ×
            </button>
          )}
        </div>
        <label className="flex shrink-0 items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]" title="only show reads with |distilled score| >= 30">
          <input type="checkbox" checked={onlyStrong} onChange={(e) => setOnlyStrong(e.target.checked)} className="accent-amber-500" />
          strong only
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && !data && <div className="p-2 font-mono text-[9px] text-[#5a6a85]">scanning every open instrument…</div>}
        {!error && data && rows.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {onlyStrong ? 'No instrument currently reads |distilled| >= 30. Uncheck "strong only" to see every read.' : 'No instruments match the current filter.'}
          </div>
        )}
        {rows.map((r) => (
          <DistillCard key={r.asset} r={r} onSelectAsset={onSelectAsset} />
        ))}
        {data && data.rows.length > 0 && (
          <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
            Distilled = the combined chart-engine vote score run through an OU fit + Kalman forward pass, re-scanned across
            every open instrument every {Math.round(POLL_MS / 1000)}s (cached server-side). Same read the &quot;Chart Signals
            Distill (Kalman-OU)&quot; strategy trades in the Backtest Lab. Click a card to open the chart.
          </p>
        )}
        {loading && <div className="px-1 font-mono text-[8px] text-[#3d4d66]">refreshing…</div>}
      </div>
    </div>
  )
}
