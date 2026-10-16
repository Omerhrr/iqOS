'use client'

// IQAIR//OS - Cointegration panel: Engle-Granger pairs scan across every
// leader/follower pair in the lead-lag groups (analytics/leadlag.ts's
// LEADLAG_GROUPS - same roster the lead-lag scanner uses), not just the
// active chart's pair. Backed by index.ts's /cointegration_scan.

import { useCallback, useEffect, useState } from 'react'
import type { CointegrationScanResponse, CointegrationScanRow, Timeframe } from '@/lib/os/client'
import { getCointegrationScan, fmtPrice } from '@/lib/os/client'

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

function CointegrationCard({ r, onSelectAsset }: { r: CointegrationScanRow; onSelectAsset?: (a: string) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(r.asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(r.asset)
      }}
      className={`w-full cursor-pointer rounded-lg border p-2 text-left transition-opacity hover:border-fuchsia-500/40 ${
        r.qualifies ? 'border-fuchsia-500/30 bg-[#16091a]' : 'border-[#1c2739] bg-[#0b111c]'
      }`}
      title={`open ${r.asset} on the chart`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {dirChip(r.direction)}
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{r.asset}</span>
        <span className="font-mono text-[9px] text-[#4b5a72]">vs {r.leader}</span>
        {r.otc && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400">otc</span>
        )}
        {r.qualifies && (
          <span
            className="rounded border border-fuchsia-500/40 bg-fuchsia-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-fuchsia-300"
            title="clears the same R²/t-stat/half-life gates the cointegration-pairs strategy itself requires"
          >
            qualifies
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">{fmtPrice(r.price, r.asset)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#7c8aa5]">
        <span title="spread z-score vs its own OU equilibrium">
          z <span className={Math.abs(r.z) >= 1.5 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.z.toFixed(2)}</span>
        </span>
        <span title="beta fit R²">R² {r.r2.toFixed(2)}</span>
        <span title="reversion significance (OU fit t-stat)">t {r.tStat.toFixed(1)}</span>
        <span title="half-life of the spread's mean reversion, in bars">{r.halfLifeBars >= 9999 ? 'hl ∞' : `hl ${r.halfLifeBars.toFixed(0)}b`}</span>
      </div>
    </div>
  )
}

export default function CointegrationPanel({
  onClose,
  tf,
  onSelectAsset,
}: {
  onClose: () => void
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
}) {
  const [data, setData] = useState<CointegrationScanResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [onlyQualifying, setOnlyQualifying] = useState(false)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true)
      getCointegrationScan(tf)
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
    .filter((r) => (!needle ? true : r.asset.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle) || r.leader.toLowerCase().includes(needle)))

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-400" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">Cointegration</span>
        <span className="font-mono text-[8px] text-[#3d4d66]">{tf}</span>
        {data && (
          <span className="ml-auto font-mono text-[8px] text-[#4b5a72]">
            {data.scanned} pairs
            {data.qualifying > 0 && <span className="ml-1 font-bold text-fuchsia-400">· {data.qualifying} qualify</span>}
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
            placeholder="search… e.g. XAGUSD, EUR"
            spellCheck={false}
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1 pr-6 font-mono text-[10px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-fuchsia-500/50"
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
        <label className="flex shrink-0 items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]" title="hide every pair that doesn't currently clear the cointegration-pairs strategy's own gates">
          <input type="checkbox" checked={onlyQualifying} onChange={(e) => setOnlyQualifying(e.target.checked)} className="accent-fuchsia-500" />
          qualifying only
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && !data && <div className="p-2 font-mono text-[9px] text-[#5a6a85]">fitting every leader/follower pair…</div>}
        {!error && data && rows.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {onlyQualifying
              ? 'No pair currently clears the R²/t-stat/half-life gates. Uncheck "qualifying only" to see every fit.'
              : 'No pairs match the current filter.'}
          </div>
        )}
        {rows.map((r) => (
          <CointegrationCard key={`${r.leader}-${r.asset}`} r={r} onSelectAsset={onSelectAsset} />
        ))}
        {data && data.rows.length > 0 && (
          <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
            Engle-Granger: fits each follower&apos;s hedge ratio β against its lead-lag group leader, OU-fits the spread, and
            ranks by how far it sits from its own equilibrium. <span className="text-fuchsia-400/80">qualifies</span> marks
            exactly the pairs the &quot;Cointegration Pairs (Engle-Granger)&quot; strategy would act on right now. Click a card
            to open the chart.
          </p>
        )}
        {loading && <div className="px-1 font-mono text-[8px] text-[#3d4d66]">refreshing…</div>}
      </div>
    </div>
  )
}
