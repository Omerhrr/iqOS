'use client'

// IQAIR//OS - Triangulation Arbitrage panel: every closed FX triangle (A/B,
// B/C, A/C) scanned at once, synthetic-vs-actual cross-rate delta ranked by
// how unusual it is against its own recent history. Same "list of
// candidates" shape as Chart Signals/Lead-Lag. Backed by
// index.ts's /triangulation_scan (analytics/triangulation.ts).

import { useCallback, useEffect, useState } from 'react'
import type { TriangulationScanResponse, TriangulationScanRow, Timeframe } from '@/lib/os/client'
import { getTriangulationScan, fmtPrice } from '@/lib/os/client'

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

function TriangulationCard({ r, onSelectAsset }: { r: TriangulationScanRow; onSelectAsset?: (a: string) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(r.cross)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(r.cross)
      }}
      className={`w-full cursor-pointer rounded-lg border p-2 text-left transition-opacity hover:border-teal-500/40 ${
        r.qualifies ? 'border-teal-500/30 bg-[#061a18]' : 'border-[#1c2739] bg-[#0b111c]'
      }`}
      title={`open ${r.cross} on the chart`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {dirChip(r.direction)}
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{r.cross}</span>
        <span className="font-mono text-[9px] text-[#4b5a72]">{r.currencies}</span>
        {r.otc && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400">otc</span>
        )}
        {!r.open && (
          <span className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] uppercase text-[#4b5a72]" title="cross pair closed - no live candles right now">
            closed
          </span>
        )}
        {r.qualifies && (
          <span
            className="rounded border border-teal-500/40 bg-teal-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-teal-300"
            title="|z| clears the divergence-is-unusual threshold"
          >
            qualifies
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">{fmtPrice(r.price, r.cross)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#7c8aa5]">
        <span title={`${r.legAB} x ${r.legBC} chained through the shared currency`}>
          synthetic <span className="text-[#aebccf]">{fmtPrice(r.synthetic, r.cross)}</span>
        </span>
        <span title="(actual - synthetic) / synthetic, as a percent">
          Δ <span className={Math.abs(r.deltaPct) >= 0.02 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.deltaPct >= 0 ? '+' : ''}{r.deltaPct.toFixed(4)}%</span>
        </span>
        <span title="how unusual this delta is vs its own recent rolling history">
          z <span className={Math.abs(r.z) >= 1.5 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.z.toFixed(2)}</span>
        </span>
        <span title="legs chained">{r.legAB} · {r.legBC}</span>
      </div>
    </div>
  )
}

export default function TriangulationPanel({
  onClose,
  tf,
  onSelectAsset,
}: {
  onClose: () => void
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
}) {
  const [data, setData] = useState<TriangulationScanResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [onlyQualifying, setOnlyQualifying] = useState(false)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true)
      getTriangulationScan(tf)
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
    .filter((r) => (onlyQualifying ? r.qualifies : true))
    .filter((r) => (!needle ? true : r.cross.toLowerCase().includes(needle) || r.currencies.toLowerCase().includes(needle)))

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">Triangulation</span>
        <span className="font-mono text-[8px] text-[#3d4d66]">{tf}</span>
        {data && (
          <span className="ml-auto font-mono text-[8px] text-[#4b5a72]">
            {data.scanned} triangles
            {data.qualifying > 0 && <span className="ml-1 font-bold text-teal-400">· {data.qualifying} qualify</span>}
          </span>
        )}
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
            placeholder="search… e.g. EURJPY, EUR/USD/JPY"
            spellCheck={false}
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1 pr-6 font-mono text-[10px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-teal-500/50"
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
        <label className="flex shrink-0 items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]" title="hide every triangle whose basis isn't currently unusual (|z| < 1.5)">
          <input type="checkbox" checked={onlyQualifying} onChange={(e) => setOnlyQualifying(e.target.checked)} className="accent-teal-500" />
          qualifying only
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && !data && <div className="p-2 font-mono text-[9px] text-[#5a6a85]">fitting every FX triangle…</div>}
        {!error && data && rows.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {onlyQualifying
              ? 'No triangle currently reads an unusual basis (|z| >= 1.5). Uncheck "qualifying only" to see every gap.'
              : 'No triangles match the current filter.'}
          </div>
        )}
        {rows.map((r) => (
          <TriangulationCard key={`${r.cross}-${r.legAB}-${r.legBC}`} r={r} onSelectAsset={onSelectAsset} />
        ))}
        {data && data.rows.length > 0 && (
          <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
            Synthetic cross = leg A/B x leg B/C, chained through the shared currency. Δ is how far the real cross pair sits
            from that synthetic value right now; z is how unusual that gap is against its own recent rolling history (the
            basis is expected to oscillate near 0, not drift). <span className="text-teal-400/80">qualifies</span> marks the
            triangles worth a look. Backtestable in the Lab as &quot;Triangulation Arbitrage&quot; - the Single-Run/Optimizer/
            Walk-Forward/Asset-Sweep engines fetch both other legs for you when this asset is the cross side of a known
            triangle. Click a card to open the cross pair.
          </p>
        )}
        {loading && <div className="px-1 font-mono text-[8px] text-[#3d4d66]">refreshing…</div>}
      </div>
    </div>
  )
}
