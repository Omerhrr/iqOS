'use client'

// IQAIR//OS - Ticks + Volume panel: the tick-bar trend read (real sub-candle
// ticks when the ring buffer has them, else the 1m-close pseudo-tick
// fallback the vote's own note discloses - analytics/tickbars.ts via
// chartsignals.ts's tickVote) paired with the relative-volume surge read
// (analytics/volumefootprint.ts) into one agreement-gated composite,
// scanned across the whole universe at once. Real market only - same
// reason Volume + Footprint is (OTC "volume" is commonly a tick/sample
// count, not genuine traded size). Backed by index.ts's /tick_volume_scan
// (analytics/tickvolume.ts).

import { useCallback, useEffect, useState } from 'react'
import type { TickVolumeScanResponse, TickVolumeScanRow, Timeframe } from '@/lib/os/client'
import { getTickVolumeScan, fmtPrice } from '@/lib/os/client'

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

function TickVolumeCard({ r, onSelectAsset }: { r: TickVolumeScanRow; onSelectAsset?: (a: string) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(r.asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(r.asset)
      }}
      className={`w-full cursor-pointer rounded-lg border p-2 text-left transition-opacity hover:border-cyan-500/40 ${
        r.qualifies ? 'border-cyan-500/30 bg-[#081a1c]' : 'border-[#1c2739] bg-[#0b111c]'
      }`}
      title={`open ${r.asset} on the chart`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {dirChip(r.direction)}
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{r.asset}</span>
        {r.agree && (
          <span
            className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-cyan-300"
            title="tick-bar trend and volume surge agree"
          >
            agree
          </span>
        )}
        {r.qualifies && (
          <span
            className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-cyan-300"
            title="ticks and volume agree, with a composite strong enough to clear the threshold"
          >
            qualifies
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">{fmtPrice(r.price, r.asset)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#7c8aa5]">
        <span title={r.tickNote}>
          ticks <span className={r.tickDir ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.tickDir ?? 'flat'}</span>
        </span>
        <span title={r.volNote}>
          vol <span className={r.volDir ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.volDir ?? 'flat'}</span>
          {Number.isFinite(r.relVolume) && <span className="ml-1 text-[#4b5a72]">{r.relVolume.toFixed(1)}x</span>}
        </span>
        <span title="combined ticks + volume score, range -10..+10">
          comp <span className={Math.abs(r.composite) >= 3.5 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.composite >= 0 ? '+' : ''}{r.composite.toFixed(1)}</span>
        </span>
      </div>
    </div>
  )
}

export default function TickVolumePanel({
  onClose,
  tf,
  onSelectAsset,
}: {
  onClose: () => void
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
}) {
  const [data, setData] = useState<TickVolumeScanResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [onlyQualifying, setOnlyQualifying] = useState(false)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true)
      getTickVolumeScan(tf)
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
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">Ticks + Volume</span>
        <span className="font-mono text-[8px] text-[#3d4d66]">{tf}</span>
        <span className="font-mono text-[8px] text-[#3d4d66]">real market only</span>
        {data && (
          <span className="ml-auto font-mono text-[8px] text-[#4b5a72]">
            {data.scanned} scanned
            {data.qualifying > 0 && <span className="ml-1 font-bold text-cyan-400">· {data.qualifying} qualify</span>}
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
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1 pr-6 font-mono text-[10px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-cyan-500/50"
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
        <label className="flex shrink-0 items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]" title="hide everything that isn't a tick-bar trend agreeing with a volume surge above the composite bar">
          <input type="checkbox" checked={onlyQualifying} onChange={(e) => setOnlyQualifying(e.target.checked)} className="accent-cyan-500" />
          qualifying only
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && !data && <div className="p-2 font-mono text-[9px] text-[#5a6a85]">reading ticks + volume across the real-market universe…</div>}
        {!error && data && rows.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {onlyQualifying
              ? 'Nothing currently has a tick-bar trend agreeing with a volume surge at a strong enough composite. Uncheck "qualifying only" to see every read.'
              : 'No assets match the current filter.'}
          </div>
        )}
        {rows.map((r) => (
          <TickVolumeCard key={r.asset} r={r} onSelectAsset={onSelectAsset} />
        ))}
        {data && data.rows.length > 0 && (
          <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
            Ticks bins the last 40 real sub-candle prints (or, with no tick buffer yet, falls back to 1m closes as
            pseudo-ticks - the read says which) into 10-print bars and reads the last 4 bars' net direction and
            agreement. Volume compares the last 10 bars' average volume per bar against the 30 before that (a
            relvol ratio), leaning call/put off the same window's CLV-proxy buy/sell delta. Real-market instruments
            only: OTC "volume" is commonly a tick/sample count, not genuine traded size, so a surge read there
            would measure the generator's print rate, not real participation. The composite sums the two signed
            reads when they agree and halves the sum when they fight, so one read alone never wins on size.{' '}
            <span className="text-cyan-400/80">agree</span> marks direction agreement;{' '}
            <span className="text-cyan-400/80">qualifies</span> adds the composite-strength bar on top. Click a
            card to open that asset on the chart.
          </p>
        )}
        {loading && <div className="px-1 font-mono text-[8px] text-[#3d4d66]">refreshing…</div>}
      </div>
    </div>
  )
}
