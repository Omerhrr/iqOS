'use client'

// IQAIR//OS - Shock + Pressure panel: every open instrument's ATR-normalized
// "shock ratio" on the latest closed bar combined with net buy/sell pressure
// built up over the prior few bars (candle-level CLV approximation, no real
// order book) into one agreement-gated composite, scanned across the whole
// universe at once. Same "list of candidates" shape as Chart Signals/Lead-
// Lag/Cointegration/Vol Arb/Triangulation/ADX-Pattern-Bias. Backed by
// index.ts's /shock_pressure_scan (analytics/shockpressure.ts).

import { useCallback, useEffect, useState } from 'react'
import type { ShockPressureScanResponse, ShockPressureScanRow, Timeframe } from '@/lib/os/client'
import { getShockPressureScan, fmtPrice } from '@/lib/os/client'

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

function ShockPressureCard({ r, onSelectAsset }: { r: ShockPressureScanRow; onSelectAsset?: (a: string) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(r.asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(r.asset)
      }}
      className={`w-full cursor-pointer rounded-lg border p-2 text-left transition-opacity hover:border-orange-500/40 ${
        r.qualifies ? 'border-orange-500/30 bg-[#1f140c]' : 'border-[#1c2739] bg-[#0b111c]'
      }`}
      title={`open ${r.asset} on the chart`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {dirChip(r.direction)}
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{r.asset}</span>
        {r.otc && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400">otc</span>
        )}
        {r.shock && (
          <span
            className="rounded border border-orange-500/40 bg-orange-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-orange-300"
            title="latest bar's return is several ATRs beyond this asset's normal range"
          >
            shock
          </span>
        )}
        {r.agree && (
          <span
            className="rounded border border-orange-500/40 bg-orange-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-orange-300"
            title="shock direction and pressure direction agree"
          >
            agree
          </span>
        )}
        {r.qualifies && (
          <span
            className="rounded border border-orange-500/40 bg-orange-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-orange-300"
            title="a real shock, agreeing with pressure, whose composite clears the threshold"
          >
            qualifies
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">{fmtPrice(r.price, r.asset)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#7c8aa5]">
        <span title="latest closed bar's return / ATR - an ATR-normalized ratio, not a real statistical z-score">
          shock <span className={r.shock ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.shockRatio >= 0 ? '+' : ''}{r.shockRatio.toFixed(2)}</span>
        </span>
        <span
          title={
            r.volumeDegraded
              ? 'no real volume in this window (common on OTC/live-forming bars) - falling back to average close-location-value position instead of the usual buy/sell volume split'
              : 'net (buy - sell) volume over the pressure lookback window, as a fraction of total volume in that window - candle-level CLV approximation, no real order book'
          }
        >
          pressure{' '}
          <span className={Math.abs(r.pressureRatio) >= 0.1 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>
            {r.pressureRatio >= 0 ? '+' : ''}
            {(r.pressureRatio * 100).toFixed(0)}%
          </span>
          {r.volumeDegraded && <span className="ml-1 text-amber-400/80">(no vol)</span>}
        </span>
        <span title="ATR(14) used to normalize the shock ratio">ATR {r.atr.toFixed(5)}</span>
        <span title="combined shock + pressure score, range -10..+10">
          comp <span className={Math.abs(r.composite) >= 3.5 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.composite >= 0 ? '+' : ''}{r.composite.toFixed(1)}</span>
        </span>
      </div>
    </div>
  )
}

export default function ShockPressurePanel({
  onClose,
  tf,
  onSelectAsset,
}: {
  onClose: () => void
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
}) {
  const [data, setData] = useState<ShockPressureScanResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [onlyQualifying, setOnlyQualifying] = useState(false)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true)
      getShockPressureScan(tf)
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
    .filter((r) => (!needle ? true : r.asset.toLowerCase().includes(needle)))

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">Shock + Pressure</span>
        <span className="font-mono text-[8px] text-[#3d4d66]">{tf}</span>
        {data && (
          <span className="ml-auto font-mono text-[8px] text-[#4b5a72]">
            {data.scanned} scanned
            {data.qualifying > 0 && <span className="ml-1 font-bold text-orange-400">· {data.qualifying} qualify</span>}
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
            placeholder="search… e.g. EURUSD"
            spellCheck={false}
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1 pr-6 font-mono text-[10px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-orange-500/50"
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
        <label className="flex shrink-0 items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]" title="hide everything that isn't a real shock agreeing with building pressure above the composite bar">
          <input type="checkbox" checked={onlyQualifying} onChange={(e) => setOnlyQualifying(e.target.checked)} className="accent-orange-500" />
          qualifying only
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && !data && <div className="p-2 font-mono text-[9px] text-[#5a6a85]">reading shock + pressure across the universe…</div>}
        {!error && data && rows.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {onlyQualifying
              ? 'Nothing currently has a shock agreeing with building pressure at a strong enough composite. Uncheck "qualifying only" to see every read.'
              : 'No assets match the current filter.'}
          </div>
        )}
        {rows.map((r) => (
          <ShockPressureCard key={r.asset} r={r} onSelectAsset={onSelectAsset} />
        ))}
        {data && data.rows.length > 0 && (
          <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
            Shock is the latest closed bar's return divided by its ATR(14) - an ATR-normalized ratio, not a real
            statistical z-score; |shock| &gt;= 2.5 counts as an event. Pressure is net buy/sell volume over the last
            10 bars (candle-level close-location-value approximation - IQ Option exposes no real order book), as a
            fraction of total volume in that window. The composite sums the two when they point the same way and
            halves the sum when they fight, so a one-bar spike with no pressure behind it gets pulled back toward 0
            instead of winning on size alone. <span className="text-orange-400/80">agree</span> marks direction
            agreement; <span className="text-orange-400/80">qualifies</span> adds the composite-strength bar on top.
            Click a card to open that asset on the chart.
          </p>
        )}
        {loading && <div className="px-1 font-mono text-[8px] text-[#3d4d66]">refreshing…</div>}
      </div>
    </div>
  )
}
