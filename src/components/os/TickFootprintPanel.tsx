'use client'

// IQAIR//OS - Tick footprint panel (bottom tab).
// The MEASURED-print cluster chart as a dock tab: the raw micro-tick stream
// is bucketed into time candles (1s..1h ladder, default 60s) and every bucket
// gets a price-bin ladder of REAL up/down print counts (direction vs the
// previous print, across bucket edges), plus per-bucket delta, POC and >=
// imbRatio imbalance rows. The 'Tick FP' CHART TYPE renders the same data on
// the price chart canvas - this tab adds the card grid with full source
// honesty: prints are NOT contracts, and the capture cadence is labeled on
// every response.
import { useCallback, useEffect, useState } from 'react'
import type { TickFootprintCandle, TickFootprintResult } from '@/lib/os/client'
import { fmtPrice, getTickFootprint } from '@/lib/os/client'

interface TickFootprintPanelProps {
  asset: string
  /** left-dock window chrome: closing the panel window (absent in the bottom-dock tab) */
  onClose?: () => void
  /** tick-desk cross-nav: open the sibling tick panel on the same pair */
  onOpenTickSmc?: () => void
  onOpenTickOracle?: () => void
  onOpenTickTechnical?: () => void
}

const BUCKET_OPTIONS = [
  { v: 15, label: '15s' },
  { v: 30, label: '30s' },
  { v: 60, label: '1m' },
  { v: 120, label: '2m' },
  { v: 300, label: '5m' },
]

function fmtClock(t: number): string {
  const d = new Date(t * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function DeltaBadge({ delta }: { delta: number }) {
  const pos = delta > 0
  const flat = delta === 0
  return (
    <span className={`rounded px-1 py-px font-mono text-[9px] font-bold ${flat ? 'bg-[#101828] text-[#4b5a72]' : pos ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>
      {flat ? '0' : `${pos ? '+' : ''}${delta}`} Δ
    </span>
  )
}

function ClusterCard({ c, asset }: { c: TickFootprintCandle; asset: string }) {
  const maxTotal = Math.max(...c.rows.map((r) => r.up + r.dn), 1)
  const rows = c.rows.slice(0, 14) // top of the ladder reads better than the full bins
  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] font-bold text-[#dbe4f0]">{fmtClock(c.time)}</span>
        <span className="font-mono text-[9px] text-[#4b5a72]">
          O {fmtPrice(c.open, asset)} · C {fmtPrice(c.close, asset)}
        </span>
        <DeltaBadge delta={c.delta} />
        <span className="font-mono text-[9px] text-[#7c8aa5]" title="measured up/down prints in the bucket">
          {c.upTicks}u/{c.dnTicks}d
        </span>
        {c.poc !== null && (
          <span className="font-mono text-[9px] text-amber-300/90" title="heaviest price bin of the bucket">
            POC {fmtPrice(c.poc, asset)}
          </span>
        )}
      </div>
      <div className="mt-1.5 space-y-px">
        {rows.map((r) => {
          const isPoc = c.poc !== null && r.mid >= c.poc - (r.priceHigh - r.priceLow) / 2 && r.mid <= c.poc + (r.priceHigh - r.priceLow) / 2
          const tot = r.up + r.dn
          const upW = (r.up / maxTotal) * 50
          const dnW = (r.dn / maxTotal) * 50
          return (
            <div
              key={r.mid}
              className={`flex items-center gap-1 font-mono text-[8.5px] ${r.imbalance ? (r.imbalance === 'buy' ? 'bg-emerald-500/10' : 'bg-rose-500/10') : ''}`}
              title={`bin ${fmtPrice(r.priceLow, asset)}-${fmtPrice(r.priceHigh, asset)}: ${r.up} up (avg ${r.upMs.toFixed(0)}ms) / ${r.dn} down (avg ${r.dnMs.toFixed(0)}ms) prints${r.imbalance ? ` - ${r.imbalance} imbalance` : ''}`}
            >
              <div className="flex h-3 flex-1 justify-end">
                {r.dn > 0 && (
                  <div className="flex h-full items-center justify-end rounded-l bg-rose-500/45 px-1 text-rose-100" style={{ width: `${Math.max(dnW, 7)}%` }}>
                    {r.dn}·{r.dnMs > 0 ? `${r.dnMs.toFixed(0)}ms` : '-'}
                  </div>
                )}
              </div>
              <div className={`w-[72px] shrink-0 text-center ${isPoc ? 'font-bold text-amber-300' : 'text-[#4b5a72]'}`}>
                {isPoc ? '★ ' : ''}
                {fmtPrice(r.mid, asset)}
              </div>
              <div className="flex h-3 flex-1">
                {r.up > 0 && (
                  <div className="flex h-full items-center rounded-r bg-emerald-500/45 px-1 text-emerald-100" style={{ width: `${Math.max(upW, 7)}%` }}>
                    {r.up}·{r.upMs > 0 ? `${r.upMs.toFixed(0)}ms` : '-'}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        {c.rows.length > 14 && <div className="pt-0.5 text-center font-mono text-[8px] text-[#3d4d66]">+{c.rows.length - 14} more bins</div>}
      </div>
    </div>
  )
}

export default function TickFootprintPanel({ asset, onClose, onOpenTickSmc, onOpenTickOracle, onOpenTickTechnical }: TickFootprintPanelProps) {
  const [data, setData] = useState<TickFootprintResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bucketSec, setBucketSec] = useState(60)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setBusy(true)
      getTickFootprint(asset, { bucketSec, bins: 12, candles: 12 })
        .then((d) => {
          setData(d)
          setError(null)
        })
        .catch((e: Error) => setError(e.message.slice(0, 180)))
        .finally(() => setBusy(false))
    },
    [asset, bucketSec],
  )

  useEffect(() => {
    load()
    const iv = setInterval(() => load({ quiet: true }), 6000)
    return () => clearInterval(iv)
  }, [load])

  const cold = data?.dataSource === 'no-ticks-yet' || !data || data.candles.length === 0
  const buckets = (data?.candles ?? []).filter((c) => c.ticks > 0).slice(-12).reverse()
  const s = data?.summary

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* summary strip */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1c2739] px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Tick Footprint</span>
        <span className="font-mono text-[9px] text-[#7c8aa5]" title="the ladder reads this pair's live print stream">{asset}</span>
        {data && s && (
          <>
            <span
              className={`rounded px-1.5 py-px font-mono text-[9px] font-bold uppercase ${
                s.netDelta > 0 ? 'bg-emerald-500/20 text-emerald-300' : s.netDelta < 0 ? 'bg-rose-500/20 text-rose-300' : 'bg-[#101828] text-[#4b5a72]'
              }`}
              title="net measured prints across the window (up - down)"
            >
              Δ {s.netDelta >= 0 ? '+' : ''}
              {s.netDelta} ({s.totalUp}u/{s.totalDn}d)
            </span>
            {s.dominantPoc !== null && (
              <span className="font-mono text-[9px] text-amber-300/90" title="most repeated per-bucket point of control">
                POC {fmtPrice(s.dominantPoc, asset)}
              </span>
            )}
            <span
              className="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px font-mono text-[8px] uppercase text-amber-400"
              title={`source: ${data.dataSource}${data.cadenceMs !== null ? `, median inter-print gap ${data.cadenceMs}ms` : ''} - ${data.ticks} prints buffered; measured cadence is upper-bounded by the capture rate`}
            >
              {data.dataSource}
              {data.cadenceMs !== null ? ` · ${data.cadenceMs}ms` : ''} · {data.ticks} prints
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <select
            value={bucketSec}
            onChange={(e) => setBucketSec(Number(e.target.value))}
            className="h-6 rounded border border-[#1c2739] bg-[#101828] px-1 font-mono text-[9px] text-[#dbe4f0]"
            title="bucket length (tick candles per footprint card)"
          >
            {BUCKET_OPTIONS.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => load()}
            className="rounded border border-[#1c2739] px-2 py-0.5 font-mono text-[9px] uppercase text-[#7c8aa5] hover:text-cyan-300"
          >
            {busy ? '…' : 'refresh'}
          </button>
          {onOpenTickSmc && (
            <button
              type="button"
              onClick={onOpenTickSmc}
              className="rounded border border-[#1c2739] px-1.5 py-0.5 font-mono text-[9px] text-[#7c8aa5] hover:border-indigo-500/40 hover:text-indigo-300"
              title="open Tick SMC - structure read on the same tick buckets"
            >
              → smc
            </button>
          )}
          {onOpenTickOracle && (
            <button
              type="button"
              onClick={onOpenTickOracle}
              className="rounded border border-[#1c2739] px-1.5 py-0.5 font-mono text-[9px] text-[#7c8aa5] hover:border-blue-500/40 hover:text-blue-300"
              title="open the Tick Oracle - per-bucket next-candle direction from the same tick stream"
            >
              → oracle
            </button>
          )}
          {onOpenTickTechnical && (
            <button
              type="button"
              onClick={onOpenTickTechnical}
              className="rounded border border-[#1c2739] px-1.5 py-0.5 font-mono text-[9px] text-[#7c8aa5] hover:border-yellow-500/40 hover:text-yellow-300"
              title="open the Tick Technical - oscillator + MA votes on tick buckets"
            >
              → technical
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-[#1c2739] px-1.5 py-0.5 font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
            >
              close
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {error && <div className="p-3 text-[10px] text-rose-400">{error}</div>}
        {cold && (
          <div className="p-3 text-[10px] leading-relaxed text-[#4b5a72]">
            No micro-tick prints captured for {asset} yet. The collector records the feed&apos;s price CHANGES - sim feeds tick every ~1s, live OTC via
            the sidecar&apos;s 100ms capture. Wait a minute or two; the same buffer feeds Tick SMC, Tick Oracle, Tick Technical and the OTC footprint.
          </div>
        )}
        {!cold && (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 2xl:grid-cols-3">
            {buckets.map((c) => (
              <ClusterCard key={c.time} c={c} asset={asset} />
            ))}
          </div>
        )}
        {data && data.candles.length > 0 && (
          <p className="mt-2 px-1 text-[9px] leading-relaxed text-[#4b5a72]">
            Cluster ladder per tick candle: left cell = down prints at that price bin (count · avg ms between prints), right = up prints. ★ marks each
            bucket&apos;s POC; tinted rows carry a ≥{data.imbRatio}:1 measured-print imbalance. <span className="text-[#aab6cc]">Prints are not
            contracts</span> - there is no bid/ask feed, so nothing here is called volume; the same ladder renders on the price chart via the
            <span className="text-[#aab6cc]"> Tick FP</span> chart type.
          </p>
        )}
      </div>
    </div>
  )
}
