'use client'

// IQAIR//OS - Volatility Arb panel: close-to-close vs Parkinson range-vol
// scan across every open instrument (same "list of candidates" shape as
// Chart Signals/Lead-Lag), not just the active chart's pair. Backed by
// index.ts's /volarb_scan.

import { useCallback, useEffect, useState } from 'react'
import type { VolArbScanResponse, VolArbScanRow, Timeframe } from '@/lib/os/client'
import { getVolArbScan, fmtPrice } from '@/lib/os/client'

const POLL_MS = 10_000

function dirChip(direction: 'call' | 'put' | null) {
  if (!direction) {
    return <span className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">no edge</span>
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

function regimeLabel(regime: VolArbScanRow['regime']) {
  return regime === 'fade' ? 'range vol dominant (fade)' : regime === 'continue' ? 'close vol dominant (continue)' : 'balanced'
}

function VolArbCard({ r, onSelectAsset }: { r: VolArbScanRow; onSelectAsset?: (a: string) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(r.asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(r.asset)
      }}
      className={`w-full cursor-pointer rounded-lg border p-2 text-left transition-opacity hover:border-sky-500/40 ${
        r.direction ? 'border-sky-500/30 bg-[#06141d]' : 'border-[#1c2739] bg-[#0b111c]'
      }`}
      title={`open ${r.asset} on the chart`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {dirChip(r.direction)}
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{r.asset}</span>
        {r.otc && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400">otc</span>
        )}
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">{fmtPrice(r.price, r.asset)}</span>
      </div>
      <div className="mt-1.5 font-mono text-[8px] uppercase tracking-wider text-[#5a6a85]">{regimeLabel(r.regime)}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#7c8aa5]">
        <span title="close-to-close EWMA vol">close {(r.closeVol * 100).toFixed(2)}%</span>
        <span title="Parkinson high-low range vol">range {(r.rangeVol * 100).toFixed(2)}%</span>
        <span title="ratio (range/close)">
          ratio <span className={r.ratio >= 1.6 || r.ratio <= 0.6 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.ratio.toFixed(2)}</span>
        </span>
        <span title="last bar direction">{r.lastBarDir > 0 ? 'up' : r.lastBarDir < 0 ? 'down' : 'doji'}</span>
      </div>
    </div>
  )
}

export default function VolatilityArbPanel({
  onClose,
  tf,
  onSelectAsset,
}: {
  onClose: () => void
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
}) {
  const [data, setData] = useState<VolArbScanResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [onlyEdge, setOnlyEdge] = useState(false)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true)
      getVolArbScan(tf)
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
    .filter((r) => (onlyEdge ? r.direction !== null : true))
    .filter((r) => (!needle ? true : r.asset.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)))

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">Volatility Arb</span>
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
            placeholder="search… e.g. ETHUSD, GBPJPY"
            spellCheck={false}
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1 pr-6 font-mono text-[10px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-sky-500/50"
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
        <label className="flex shrink-0 items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]" title="only show instruments with a fade/continue read right now">
          <input type="checkbox" checked={onlyEdge} onChange={(e) => setOnlyEdge(e.target.checked)} className="accent-sky-500" />
          edge only
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && !data && <div className="p-2 font-mono text-[9px] text-[#5a6a85]">scanning every open instrument…</div>}
        {!error && data && rows.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {onlyEdge ? 'No instrument currently reads a fade/continue edge. Uncheck "edge only" to see every ratio.' : 'No instruments match the current filter.'}
          </div>
        )}
        {rows.map((r) => (
          <VolArbCard key={r.asset} r={r} onSelectAsset={onSelectAsset} />
        ))}
        {data && data.rows.length > 0 && (
          <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
            No options chain/IV surface exists here, so this arbs two REALIZED-vol estimators of the same tape: close-to-close
            EWMA vs the Parkinson high-low range estimator, re-scanned across every open instrument every{' '}
            {Math.round(POLL_MS / 1000)}s. Same read the &quot;Volatility Arb (Close-vs-Range)&quot; strategy trades in the
            Backtest Lab. Click a card to open the chart.
          </p>
        )}
        {loading && <div className="px-1 font-mono text-[8px] text-[#3d4d66]">refreshing…</div>}
      </div>
    </div>
  )
}
