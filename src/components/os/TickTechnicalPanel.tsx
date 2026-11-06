'use client'

// IQAIR//OS - Tick Technical panel (investing.com-style summary on the TICK
// CHART). The raw micro-tick stream is bucketed into tick candles per bucket
// length; then oscillators (RSI, Stoch, Stoch RSI, CCI, ADX, Awesome,
// Momentum, MACD, Williams %R, Bull/Bear Power, Ultimate Osc) and moving
// averages (SMA/EMA 10..200, VWMA(20) on print counts, Hull(9), Ichimoku
// Base) each vote buy/sell/neutral exactly like a technical-summary table,
// aggregated into strong-buy..strong-sell per group and overall.
// Indicators whose window does not fit the accumulated tick history are
// listed as skipped - never faked from thin data.
import { useCallback, useEffect, useState } from 'react'
import type { TickRating, TickTechnicalResult } from '@/lib/os/client'
import { getTickTechnical } from '@/lib/os/client'

interface TickTechnicalPanelProps {
  asset: string
}

const BUCKET_OPTIONS = [5, 15, 30, 60, 120, 180, 300]
const bucketLabel = (sec: number) => (sec >= 60 ? `${sec / 60}m` : `${sec}s`)

const RATING_STYLE: Record<TickRating, { label: string; color: string; bg: string }> = {
  'strong-buy': { label: 'STRONG BUY', color: '#34d399', bg: 'rgba(16,185,129,0.22)' },
  buy: { label: 'BUY', color: '#6ee7b7', bg: 'rgba(16,185,129,0.1)' },
  neutral: { label: 'NEUTRAL', color: '#7c8aa5', bg: 'rgba(148,163,184,0.08)' },
  sell: { label: 'SELL', color: '#fda4af', bg: 'rgba(244,63,94,0.1)' },
  'strong-sell': { label: 'STRONG SELL', color: '#fb7185', bg: 'rgba(244,63,94,0.22)' },
}

function RatingChip({ rating }: { rating: TickRating }) {
  const s = RATING_STYLE[rating]
  return (
    <span
      className="inline-block rounded px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-wider"
      style={{ color: s.color, background: s.bg }}
    >
      {s.label}
    </span>
  )
}

function VoteDot({ vote }: { vote: 'buy' | 'sell' | 'neutral' }) {
  const color = vote === 'buy' ? '#10b981' : vote === 'sell' ? '#f43f5e' : '#5a6a85'
  return <span className="inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: color }} />
}

export default function TickTechnicalPanel({ asset }: TickTechnicalPanelProps) {
  const [data, setData] = useState<TickTechnicalResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bucketSec, setBucketSec] = useState(60)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setBusy(true)
      getTickTechnical(asset, { bucketSec })
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
    const iv = setInterval(() => load({ quiet: true }), 8000)
    return () => clearInterval(iv)
  }, [load])

  const oscRows = data?.detail.rows.filter((r) => r.group === 'osc') ?? []
  const maRows = data?.detail.rows.filter((r) => r.group === 'ma') ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* summary strip */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1c2739] px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Tick Technical</span>
        {data?.detail.ok && <RatingChip rating={data.detail.ok ? (data.buckets.find((b) => b.bucketSec === bucketSec)?.summary.rating ?? 'neutral') : 'neutral'} />}
        {data && (
          <span
            className="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px font-mono text-[8px] uppercase text-amber-400"
            title={`${data.dataSource}${data.cadenceMs !== null ? `, median inter-print gap ${data.cadenceMs}ms` : ''} - indicators computed on tick-derived buckets`}
          >
            {data.dataSource}
            {data.cadenceMs !== null ? ` · ${data.cadenceMs}ms` : ''}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <select
            value={bucketSec}
            onChange={(e) => setBucketSec(Number(e.target.value))}
            className="h-6 rounded border border-[#1c2739] bg-[#101828] px-1 font-mono text-[9px] text-[#dbe4f0]"
            title="bucket length for the detailed indicator table"
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
        {!error && data && !data.ok && <div className="text-[10px] leading-relaxed text-[#4b5a72]">{data.note ?? 'warming up'}</div>}
        {!error && !data && <div className="text-[10px] text-[#4b5a72]">loading technical ladder…</div>}

        {data && (
          <>
            {/* per-bucket ladder - the three summary rows per bucket */}
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-[10px]">
                <thead>
                  <tr className="border-b border-[#141d2e] text-left text-[8px] uppercase tracking-wider text-[#4b5a72]">
                    <th className="px-2 py-1">bucket</th>
                    <th className="px-2 py-1">oscillators</th>
                    <th className="px-2 py-1">moving averages</th>
                    <th className="px-2 py-1">summary</th>
                    <th className="px-2 py-1">votes</th>
                  </tr>
                </thead>
                <tbody>
                  {data.buckets.map((b) => {
                    const isDetail = b.bucketSec === bucketSec
                    if (!b.ok) {
                      return (
                        <tr key={b.label} className="border-b border-[#0d1420]" title={b.note}>
                          <td className="px-2 py-1 text-[#dbe4f0]">{b.label}</td>
                          <td colSpan={4} className="px-2 py-1 text-[9px] text-[#4b5a72]">
                            {b.note}
                          </td>
                        </tr>
                      )
                    }
                    return (
                      <tr key={b.label} className={`border-b border-[#0d1420] ${isDetail ? 'bg-cyan-500/5' : ''}`}>
                        <td className="px-2 py-1 text-[#dbe4f0]">
                          {b.label}
                          {isDetail && <span className="ml-1 text-[8px] text-cyan-300">← detail</span>}
                        </td>
                        <td className="px-2 py-1">
                          <RatingChip rating={b.osc.rating} />
                        </td>
                        <td className="px-2 py-1">
                          <RatingChip rating={b.mas.rating} />
                        </td>
                        <td className="px-2 py-1">
                          <RatingChip rating={b.summary.rating} />
                        </td>
                        <td className="px-2 py-1 text-[9px] text-[#7c8aa5]" title="buy/sell/neutral counts (osc+ma)">
                          {b.summary.buy}↑ {b.summary.sell}↓ {b.summary.neutral}=
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* detailed per-indicator table for the selected bucket */}
            <div className="mt-3">
              <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-[#4b5a72]">
                {bucketLabel(bucketSec)} tick buckets - per-indicator votes ({data.detail.candles} closed buckets)
              </div>
              {data.detail.ok ? (
                <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                  <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
                    <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-[#4b5a72]">oscillators</div>
                    <div className="flex flex-col gap-0.5">
                      {oscRows.map((r) => (
                        <div key={r.name} className="flex items-center justify-between gap-2 font-mono text-[9px]">
                          <span className="flex items-center gap-1.5 text-[#aab6cc]">
                            <VoteDot vote={r.vote} />
                            {r.name}
                          </span>
                          <span className="text-[#7c8aa5]">{r.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
                    <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-[#4b5a72]">moving averages</div>
                    <div className="flex flex-col gap-0.5">
                      {maRows.map((r) => (
                        <div key={r.name} className="flex items-center justify-between gap-2 font-mono text-[9px]">
                          <span className="flex items-center gap-1.5 text-[#aab6cc]">
                            <VoteDot vote={r.vote} />
                            {r.name}
                          </span>
                          <span className="text-[#7c8aa5]">{r.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-[10px] leading-relaxed text-[#4b5a72]">{data.detail.note ?? 'warming up'}</div>
              )}
              {data.detail.skipped.length > 0 && data.detail.ok && (
                <p className="mt-1.5 text-[9px] leading-relaxed text-[#4b5a72]">
                  skipped (window too short on tick buckets): {data.detail.skipped.join(', ')} - they vote the moment enough tick buckets exist.
                </p>
              )}
              <p className="mt-1.5 text-[9px] leading-relaxed text-[#4b5a72]">
                aggregation rule: {data.rule}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
