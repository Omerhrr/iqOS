'use client'

// IQAIR//OS - Renko + Footprint panel: the renko brick-trend read paired
// with the volume-footprint delta read (real market) or the OTC micro-tick
// velocity footprint read (OTC market - no real order book exists there) into
// one agreement-gated composite, scanned across the whole universe at once.
// Same "list of candidates" shape as Chart Signals/Lead-Lag/Cointegration/
// Vol Arb/Triangulation/ADX-Pattern-Bias/Shock+Pressure. Two instances of
// this one component cover both markets - backed by index.ts's
// /renko_footprint_scan and /renko_otc_footprint_scan (analytics/renkofootprint.ts).

import { useCallback, useEffect, useState } from 'react'
import type { RenkoFootprintScanResponse, RenkoFootprintScanRow, Timeframe } from '@/lib/os/client'
import { getRenkoFootprintScan, getRenkoOtcFootprintScan, fmtPrice } from '@/lib/os/client'

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

function RenkoFootprintCard({ r, fpLabel, otcTheme, onSelectAsset }: { r: RenkoFootprintScanRow; fpLabel: string; otcTheme: boolean; onSelectAsset?: (a: string) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(r.asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(r.asset)
      }}
      className={`w-full cursor-pointer rounded-lg border p-2 text-left transition-opacity ${
        otcTheme ? 'hover:border-amber-500/40' : 'hover:border-emerald-500/40'
      } ${
        r.qualifies
          ? otcTheme
            ? 'border-amber-500/30 bg-[#1a1409]'
            : 'border-emerald-500/30 bg-[#0f1a14]'
          : 'border-[#1c2739] bg-[#0b111c]'
      }`}
      title={`open ${r.asset} on the chart`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {dirChip(r.direction)}
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{r.asset}</span>
        {r.otc && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400">otc</span>
        )}
        {r.agree && (
          <span
            className={`rounded border px-1 py-px font-mono text-[8px] font-bold uppercase ${
              otcTheme ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
            }`}
            title="renko brick trend and footprint delta agree"
          >
            agree
          </span>
        )}
        {r.qualifies && (
          <span
            className={`rounded border px-1 py-px font-mono text-[8px] font-bold uppercase ${
              otcTheme ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
            }`}
            title="renko and footprint agree, with a composite strong enough to clear the threshold"
          >
            qualifies
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">{fmtPrice(r.price, r.asset)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#7c8aa5]">
        <span title={r.renkoNote}>
          renko <span className={r.renkoDir ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.renkoDir ?? 'flat'}</span>
        </span>
        <span title={r.fpNote}>
          {fpLabel} <span className={r.fpDir ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.fpDir ?? 'flat'}</span>
        </span>
        <span title="combined renko + footprint score, range -10..+10">
          comp <span className={Math.abs(r.composite) >= 3.5 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.composite >= 0 ? '+' : ''}{r.composite.toFixed(1)}</span>
        </span>
      </div>
    </div>
  )
}

export default function RenkoFootprintPanel({
  onClose,
  tf,
  onSelectAsset,
  otc,
}: {
  onClose: () => void
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
  /** false = real-market panel (volume footprint, CLV proxy); true = OTC
   * panel (micro-tick velocity footprint - no real order book exists). */
  otc: boolean
}) {
  const [data, setData] = useState<RenkoFootprintScanResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [onlyQualifying, setOnlyQualifying] = useState(false)

  const title = otc ? 'Renko + OTC Footprint' : 'Renko + Footprint'
  const fpLabel = otc ? 'fp(otc)' : 'fp'
  const dotColor = otc ? 'bg-amber-400' : 'bg-emerald-400'
  const qualifyColor = otc ? 'text-amber-400' : 'text-emerald-400'
  const methodNote = otc
    ? 'OTC has no real order book, so "footprint" here is the micro-tick velocity read: how fast the generator ticks up vs down and where prints cluster (analytics/otcfootprint.ts) - not real bid/ask volume.'
    : 'Footprint here is the CLV-proxy volume read (candle volume spread across price bins, buy/sell split by close-location-value) - IQ Option exposes no real bid/ask tape (analytics/footprint.ts).'

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true)
      const getter = otc ? getRenkoOtcFootprintScan : getRenkoFootprintScan
      getter(tf)
        .then((d) => {
          if (d?.ok) {
            setData(d)
            setError(null)
          }
        })
        .catch((err: Error) => setError(err.message.slice(0, 180)))
        .finally(() => setLoading(false))
    },
    [tf, otc],
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
        <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">{title}</span>
        <span className="font-mono text-[8px] text-[#3d4d66]">{tf}</span>
        {data && (
          <span className="ml-auto font-mono text-[8px] text-[#4b5a72]">
            {data.scanned} scanned
            {data.qualifying > 0 && <span className={`ml-1 font-bold ${qualifyColor}`}>· {data.qualifying} qualify</span>}
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
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1 pr-6 font-mono text-[10px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-emerald-500/50"
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
        <label className="flex shrink-0 items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]" title="hide everything that isn't renko agreeing with footprint above the composite bar">
          <input type="checkbox" checked={onlyQualifying} onChange={(e) => setOnlyQualifying(e.target.checked)} className="accent-emerald-500" />
          qualifying only
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && !data && <div className="p-2 font-mono text-[9px] text-[#5a6a85]">reading renko + footprint across the {otc ? 'OTC' : 'real-market'} universe…</div>}
        {!error && data && rows.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {onlyQualifying
              ? 'Nothing currently has renko agreeing with footprint at a strong enough composite. Uncheck "qualifying only" to see every read.'
              : 'No assets match the current filter.'}
          </div>
        )}
        {rows.map((r) => (
          <RenkoFootprintCard key={r.asset} r={r} fpLabel={fpLabel} otcTheme={otc} onSelectAsset={onSelectAsset} />
        ))}
        {data && data.rows.length > 0 && (
          <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
            Renko is the brick-trend read (analytics/renko.ts) - a sustained run of same-direction bricks with no
            recent flip. {methodNote} The composite sums the two signed reads when they agree and halves the sum
            when they fight, so one engine alone never wins on size. <span className={otc ? 'text-amber-400/80' : 'text-emerald-400/80'}>agree</span>{' '}
            marks direction agreement; <span className={otc ? 'text-amber-400/80' : 'text-emerald-400/80'}>qualifies</span> adds the
            composite-strength bar on top. Click a card to open that asset on the chart.
          </p>
        )}
        {loading && <div className="px-1 font-mono text-[8px] text-[#3d4d66]">refreshing…</div>}
      </div>
    </div>
  )
}
