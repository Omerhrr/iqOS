'use client'

// IQAIR//OS - Tick SMC panel.
// Smart Money Concepts read off the TICK CHART (not time candles): the
// micro-tick stream is bucketed into tick candles (default 15s), then swing
// structure, BOS/CHoCH, order blocks, FVGs, liquidity sweeps and the
// premium/discount zone are computed from those tick-derived buckets.
// Every response labels the print source honestly (sim ~1s engine prints or
// the sidecar's 100ms live captures) - buckets that haven't accumulated
// enough prints yet say "warming up", they never guess.
import { useCallback, useEffect, useState } from 'react'
import type { TickSmcResult } from '@/lib/os/client'
import { fmtPrice, getTickSmc } from '@/lib/os/client'

interface TickSmcPanelProps {
  asset: string
}

const BUCKET_OPTIONS = [5, 15, 30, 60, 120, 300]

const bucketLabel = (sec: number) => (sec >= 60 ? `${sec / 60}m` : `${sec}s`)

function DirBadge({ direction, confidence, note }: { direction: 'call' | 'put' | 'none'; confidence: number; note?: string }) {
  const cls =
    direction === 'call'
      ? 'bg-emerald-500/20 text-emerald-300'
      : direction === 'put'
        ? 'bg-rose-500/20 text-rose-300'
        : 'bg-[#101828] text-[#4b5a72]'
  return (
    <span className={`rounded px-1.5 py-px font-mono text-[9px] font-bold uppercase ${cls}`} title={note}>
      {direction === 'none' ? 'no read' : direction} {direction !== 'none' ? `${confidence}%` : ''}
    </span>
  )
}

function ZoneChip({ label, zone, asset }: { label: string; zone: { top: number; bottom: number } | null; asset: string }) {
  if (!zone) return null
  const single = Math.abs(zone.top - zone.bottom) < 1e-12
  return (
    <span className="font-mono text-[9px] text-[#7c8aa5]">
      {label}{' '}
      <span className="text-[#dbe4f0]">
        {single ? fmtPrice(zone.top, asset) : `${fmtPrice(zone.bottom, asset)}-${fmtPrice(zone.top, asset)}`}
      </span>
    </span>
  )
}

export default function TickSmcPanel({ asset }: TickSmcPanelProps) {
  const [data, setData] = useState<TickSmcResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bucketSec, setBucketSec] = useState(15)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setBusy(true)
      getTickSmc(asset, { bucketSec })
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

  const trendColor = data?.trend === 'up' ? 'text-emerald-400' : data?.trend === 'down' ? 'text-rose-400' : 'text-[#7c8aa5]'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* summary strip */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1c2739] px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Tick SMC</span>
        {data && <DirBadge direction={data.direction} confidence={data.confidence} note={data.reasons.join(' · ') || data.note} />}
        {data?.ok && (
          <>
            <span className={`font-mono text-[9px] font-bold uppercase ${trendColor}`}>{data.trend}</span>
            {data.bos && (
              <span
                className="font-mono text-[9px] text-[#7c8aa5]"
                title={`break of structure: close beyond ${fmtPrice(data.bos.level, asset)} ${data.bos.agoBars} buckets ago`}
              >
                BOS {data.bos.dir === 'bull' ? '↑' : '↓'} {data.bos.agoBars}b
              </span>
            )}
            {data.choch && (
              <span
                className="rounded border border-amber-500/40 bg-amber-500/10 px-1 font-mono text-[9px] font-bold text-amber-300"
                title={`change of character: close against the trend beyond ${fmtPrice(data.choch.level, asset)} ${data.choch.agoBars} buckets ago`}
              >
                CHoCH {data.choch.dir === 'bull' ? '↑' : '↓'} {data.choch.agoBars}b
              </span>
            )}
            {data.sweeps[0] && (
              <span
                className="font-mono text-[9px] text-[#7c8aa5]"
                title={`liquidity sweep: wick through ${fmtPrice(data.sweeps[0].top, asset)} then closed back at ${fmtPrice(data.sweeps[0].close, asset)}`}
              >
                sweep {data.sweeps[0].dir === 'bull' ? 'buy-side' : 'sell-side'}
              </span>
            )}
            {data.premiumDiscount && (
              <span
                className={`font-mono text-[9px] ${data.premiumDiscount.zone === 'discount' ? 'text-emerald-300' : data.premiumDiscount.zone === 'premium' ? 'text-rose-300' : 'text-[#7c8aa5]'}`}
                title={`swing leg ${fmtPrice(data.premiumDiscount.low, asset)}-${fmtPrice(data.premiumDiscount.high, asset)}, equilibrium ${fmtPrice(data.premiumDiscount.eq, asset)}`}
              >
                {data.premiumDiscount.zone}
              </span>
            )}
          </>
        )}
        {data && (
          <span
            className="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px font-mono text-[8px] uppercase text-amber-400"
            title={`${data.dataSource}${data.cadenceMs !== null ? `, median inter-print gap ${data.cadenceMs}ms` : ''} - SMC on ${data.bucketSec}s tick buckets from the raw print stream`}
          >
            {data.dataSource}
            {data.cadenceMs !== null ? ` · ${data.cadenceMs}ms` : ''} · {data.candles}b
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <select
            value={bucketSec}
            onChange={(e) => setBucketSec(Number(e.target.value))}
            className="h-6 rounded border border-[#1c2739] bg-[#101828] px-1 font-mono text-[9px] text-[#dbe4f0]"
            title="tick-bucket length the structure is read on"
          >
            {BUCKET_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {bucketLabel(s)}
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
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error && <div className="text-[10px] text-rose-400">{error}</div>}
        {!error && data && !data.ok && (
          <div className="text-[10px] leading-relaxed text-[#4b5a72]">
            {data.note ?? 'warming up'} - the SMC read needs closed {data.bucketSec}s tick buckets. Prints accumulate from the feed&apos;s own
            price-change stream ({data.dataSource}); nothing is guessed while the buffer is thin.
          </div>
        )}
        {!error && !data && <div className="text-[10px] text-[#4b5a72]">loading tick structure…</div>}
        {data?.ok && (
          <>
            <ul className="space-y-0.5 text-[10px] leading-snug text-[#aab6cc]">
              {data.reasons.map((r, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="text-[#3d4d66]">·</span>
                  {r}
                </li>
              ))}
            </ul>
            <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
              <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
                <div className="text-[9px] font-bold uppercase tracking-wider text-[#4b5a72]">order blocks</div>
                <div className="mt-1 flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9px] text-emerald-300">bull OB</span>
                    {data.bullOrderBlock ? (
                      <ZoneChip label={data.bullOrderBlock.mitigated ? '(mitigated)' : '(fresh)'} zone={data.bullOrderBlock} asset={asset} />
                    ) : (
                      <span className="font-mono text-[9px] text-[#3d4d66]">none</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9px] text-rose-300">bear OB</span>
                    {data.bearOrderBlock ? (
                      <ZoneChip label={data.bearOrderBlock.mitigated ? '(mitigated)' : '(fresh)'} zone={data.bearOrderBlock} asset={asset} />
                    ) : (
                      <span className="font-mono text-[9px] text-[#3d4d66]">none</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
                <div className="text-[9px] font-bold uppercase tracking-wider text-[#4b5a72]">fair value gaps</div>
                <div className="mt-1 flex flex-col gap-1">
                  {data.fvgs.length === 0 && <span className="font-mono text-[9px] text-[#3d4d66]">none in window</span>}
                  {data.fvgs.map((f, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <span className={`font-mono text-[9px] ${f.dir === 'bull' ? 'text-emerald-300' : 'text-rose-300'}`}>{f.dir} FVG</span>
                      <ZoneChip label={f.filled ? '(filled)' : '(open)'} zone={f} asset={asset} />
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
                <div className="text-[9px] font-bold uppercase tracking-wider text-[#4b5a72]">liquidity sweeps</div>
                <div className="mt-1 flex flex-col gap-1">
                  {data.sweeps.length === 0 && <span className="font-mono text-[9px] text-[#3d4d66]">none in window</span>}
                  {data.sweeps.map((s, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <span className={`font-mono text-[9px] ${s.dir === 'bull' ? 'text-amber-300' : 'text-cyan-300'}`}>
                        {s.dir === 'bull' ? 'buy-side swept' : 'sell-side swept'}
                      </span>
                      <span className="font-mono text-[9px] text-[#7c8aa5]" title="wick level -> close back inside">
                        {fmtPrice(s.top, asset)} → {fmtPrice(s.close, asset)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
                <div className="text-[9px] font-bold uppercase tracking-wider text-[#4b5a72]">premium / discount</div>
                {data.premiumDiscount ? (
                  <div className="mt-1 flex items-center justify-between">
                    <span className="font-mono text-[9px] text-[#7c8aa5]">
                      leg {fmtPrice(data.premiumDiscount.low, asset)} - {fmtPrice(data.premiumDiscount.high, asset)}
                    </span>
                    <span className="font-mono text-[9px] text-[#dbe4f0]">
                      EQ {fmtPrice(data.premiumDiscount.eq, asset)} · {data.premiumDiscount.zone}
                    </span>
                  </div>
                ) : (
                  <span className="mt-1 block font-mono text-[9px] text-[#3d4d66]">no swing leg yet</span>
                )}
              </div>
            </div>
            <p className="mt-3 px-1 text-[9px] leading-relaxed text-[#4b5a72]">
              Read on <span className="text-[#aab6cc]">{data.bucketSec}s tick buckets</span> built from the raw print stream - every wick, gap
              and swing here is a measurement of the feed&apos;s own prints, not time-candle aggregates. Direction fires only with a real
              structure vote (|score| &gt;= 0.18); a two-sided tape reads &quot;no read&quot;.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
