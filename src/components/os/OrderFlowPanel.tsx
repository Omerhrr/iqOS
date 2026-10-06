'use client'

// IQAIR//OS - Order Flow panel: Volume Profile (POC / Value Area) + per-candle
// Delta + Cumulative Delta.
//
// IMPORTANT: IQ Option exposes no real bid/ask-tagged trade data or order-book
// depth for any instrument this OS trades. Everything rendered here is a
// best-effort APPROXIMATION derived from OHLCV candles (close-location-value
// buy/sell split - see trading-core/src/analytics/orderflow.ts for the exact
// method). This is a manual-analysis / visualization tool only - it is not
// wired into strategies, backtests or autopilot.
import { useEffect, useMemo, useState } from 'react'
import type { CandleDelta, CumulativeDeltaPoint, Timeframe, VolumeProfileResult } from '@/lib/os/client'
import { fmtPrice, getDelta, getVolumeProfile } from '@/lib/os/client'

interface OrderFlowPanelProps {
  asset: string
  tf: Timeframe
}

function ApproxTag({ title }: { title?: string }) {
  return (
    <span
      className="ml-1.5 cursor-help rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-amber-400"
      title={title ?? 'Approximated from OHLCV candles (close-location-value proxy) - IQ Option does not expose real bid/ask-tagged order flow or order-book depth.'}
    >
      approx
    </span>
  )
}

function VolumeProfileView({ asset, tf }: OrderFlowPanelProps) {
  const [profile, setProfile] = useState<VolumeProfileResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(null)
    getVolumeProfile(asset, tf, { limit: 400 })
      .then((p) => {
        if (!cancelled) setProfile(p)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message.slice(0, 160))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [asset, tf])

  const chart = useMemo(() => {
    if (!profile || profile.levels.length === 0) return null
    const W = 220
    const H = 320
    const maxVol = Math.max(...profile.levels.map((l) => l.volume), 1)
    // levels are ordered low->high price; render high price at the top
    const rows = [...profile.levels].reverse()
    const rowH = H / rows.length
    return { W, H, rowH, rows, maxVol }
  }, [profile])

  if (busy && !profile) return <div className="p-3 text-[10px] text-[#4b5a72]">loading volume profile…</div>
  if (error) return <div className="p-3 text-[10px] text-rose-400">{error}</div>
  if (!chart || !profile) return <div className="p-3 text-[10px] text-[#4b5a72]">not enough candle history yet.</div>

  const priceToY = (price: number) => {
    const top = chart.rows[0].priceHigh
    const bottom = chart.rows[chart.rows.length - 1].priceLow
    return ((top - price) / (top - bottom)) * chart.H
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center text-[10px] uppercase tracking-wider text-[#4b5a72]">
          Volume Profile
          <ApproxTag />
        </div>
        <div className="font-mono text-[9px] text-[#3d4c66]">{profile.levels.length} buckets · {Math.round(profile.totalVolume).toLocaleString()} vol (approx)</div>
      </div>
      <div className="flex gap-2">
        <svg viewBox={`0 0 ${chart.W} ${chart.H}`} className="h-[320px] w-[220px] shrink-0">
          {chart.rows.map((l, i) => {
            const isPoc = Math.abs(l.price - profile.poc) < 1e-9
            const barW = (l.volume / chart.maxVol) * (chart.W - 4)
            const buyW = l.volume > 0 ? (l.buyVolume / l.volume) * barW : 0
            return (
              <g key={i} transform={`translate(0, ${i * chart.rowH})`}>
                <rect x={0} y={0} width={buyW} height={chart.rowH - 1} fill="rgba(16,185,129,0.55)" />
                <rect x={buyW} y={0} width={Math.max(0, barW - buyW)} height={chart.rowH - 1} fill="rgba(244,63,94,0.5)" />
                {isPoc && <rect x={0} y={0} width={chart.W} height={chart.rowH - 1} fill="none" stroke="#facc15" strokeWidth="1.2" />}
              </g>
            )
          })}
          {/* Value Area High / Low guide lines */}
          <line x1={0} x2={chart.W} y1={priceToY(profile.valueAreaHigh)} y2={priceToY(profile.valueAreaHigh)} stroke="#38bdf8" strokeDasharray="3 2" strokeWidth="1" />
          <line x1={0} x2={chart.W} y1={priceToY(profile.valueAreaLow)} y2={priceToY(profile.valueAreaLow)} stroke="#38bdf8" strokeDasharray="3 2" strokeWidth="1" />
        </svg>
        <div className="flex flex-col justify-between py-0.5 font-mono text-[9px]">
          <div className="text-[#4b5a72]">high {fmtPrice(chart.rows[0].priceHigh, asset)}</div>
          <Legend label="POC" color="#facc15" value={fmtPrice(profile.poc, asset)} />
          <Legend label="VA High" color="#38bdf8" value={fmtPrice(profile.valueAreaHigh, asset)} />
          <Legend label="VA Low" color="#38bdf8" value={fmtPrice(profile.valueAreaLow, asset)} />
          <div className="text-[#4b5a72]">low {fmtPrice(chart.rows[chart.rows.length - 1].priceLow, asset)}</div>
          <div className="mt-2 flex items-center gap-1 text-[#4b5a72]">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: 'rgba(16,185,129,0.55)' }} /> buy (approx)
          </div>
          <div className="flex items-center gap-1 text-[#4b5a72]">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: 'rgba(244,63,94,0.5)' }} /> sell (approx)
          </div>
        </div>
      </div>
      <p className="text-[9px] leading-relaxed text-[#4b5a72]">
        Derived from candle OHLCV, not real order-book data. Each candle's volume is split into buy/sell by where its close sits in its
        high-low range, then distributed across the price buckets its range overlaps. POC = bucket with the most volume. Value Area = the
        contiguous price range covering ~70% of volume around the POC.
      </p>
    </div>
  )
}

function Legend({ label, color, value }: { label: string; color: string; value: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />
      <span className="text-[#aab6cc]">{label}</span>
      <span className="text-[#4b5a72]">{value}</span>
    </div>
  )
}

// Exported standalone so it can be reused outside the full Order Flow tab
// (e.g. the Markov/Delta switcher next to Confluence Signal) without pulling
// in Volume Profile or the tab chrome around it.
export function DeltaFootprintView({ asset, tf, large = false }: OrderFlowPanelProps & { large?: boolean }) {
  const [deltas, setDeltas] = useState<CandleDelta[]>([])
  const [cumulative, setCumulative] = useState<CumulativeDeltaPoint[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(null)
    getDelta(asset, tf, { limit: 160 })
      .then((d) => {
        if (cancelled) return
        setDeltas(d.deltas)
        setCumulative(d.cumulative)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message.slice(0, 160))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [asset, tf])

  const chart = useMemo(() => {
    if (deltas.length === 0) return null
    const W = 600
    // in the small Markov/Delta switcher slot these render at fixed small
    // pixel heights regardless of container size (hand-rolled SVG, not an
    // external chart lib) - when opened in the fullscreen overlay (`large`)
    // the viewBox itself grows so bars/line actually render bigger and more
    // legible, not just the same tiny SVG centered in extra empty space.
    const barH = large ? 260 : 90
    const lineH = large ? 200 : 70
    const maxAbsDelta = Math.max(...deltas.map((d) => Math.abs(d.delta)), 1)
    const cumVals = cumulative.map((c) => c.cumulativeDelta)
    let cLo = Math.min(...cumVals, 0)
    let cHi = Math.max(...cumVals, 0)
    if (cHi === cLo) {
      cHi += 1
      cLo -= 1
    }
    const n = deltas.length
    const barW = W / n
    const x = (i: number) => i * barW
    const yLine = (v: number) => lineH - ((v - cLo) / (cHi - cLo)) * lineH
    const linePath = cumulative
      .map((c, i) => `${i === 0 ? 'M' : 'L'}${(x(i) + barW / 2).toFixed(1)},${yLine(c.cumulativeDelta).toFixed(1)}`)
      .join(' ')
    return { W, barH, lineH, maxAbsDelta, barW, x, linePath, n }
  }, [deltas, cumulative])

  if (busy && deltas.length === 0) return <div className="p-3 text-[10px] text-[#4b5a72]">loading delta…</div>
  if (error) return <div className="p-3 text-[10px] text-rose-400">{error}</div>
  if (!chart) return <div className="p-3 text-[10px] text-[#4b5a72]">not enough candle history yet.</div>

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center text-[10px] uppercase tracking-wider text-[#4b5a72]">
          Per-Candle Delta
          <ApproxTag title="Approximated buy-side minus sell-side volume per candle, via close-location-value (CLV) - not real executed order flow." />
        </div>
        <div className="font-mono text-[9px] text-[#3d4c66]">{chart.n} candles</div>
      </div>
      <svg viewBox={`0 0 ${chart.W} ${chart.barH}`} className={large ? 'h-[260px] w-full' : 'h-[90px] w-full'}>
        <line x1="0" x2={chart.W} y1={chart.barH / 2} y2={chart.barH / 2} stroke="#1c2739" strokeWidth="1" />
        {deltas.map((d, i) => {
          const h = (Math.abs(d.delta) / chart.maxAbsDelta) * (chart.barH / 2 - 2)
          const up = d.delta >= 0
          return (
            <rect
              key={i}
              x={chart.x(i) + 1}
              y={up ? chart.barH / 2 - h : chart.barH / 2}
              width={Math.max(1, chart.barW - 2)}
              height={h}
              fill={up ? 'rgba(16,185,129,0.75)' : 'rgba(244,63,94,0.7)'}
            />
          )
        })}
      </svg>
      <div className="flex items-center text-[10px] uppercase tracking-wider text-[#4b5a72]">
        Cumulative Delta
        <ApproxTag title="Running sum of the per-candle approximated delta above - visualizes sustained buying vs selling pressure, not real cumulative order-flow." />
      </div>
      <svg viewBox={`0 0 ${chart.W} ${chart.lineH}`} className={large ? 'h-[200px] w-full' : 'h-[70px] w-full'}>
        <path d={chart.linePath} fill="none" stroke="#38bdf8" strokeWidth="1.6" />
      </svg>
      <p className="text-[9px] leading-relaxed text-[#4b5a72]">
        Buy/sell volume per candle is approximated from where price closed within the candle&apos;s high-low range (close-location-value), since
        IQ Option does not provide real bid/ask-tagged trades. Green = net approximated buying pressure, red = net approximated selling
        pressure. The line below is the running sum of that delta over time.
      </p>
    </div>
  )
}

export default function OrderFlowPanel({ asset, tf }: OrderFlowPanelProps) {
  const [view, setView] = useState<'profile' | 'delta'>('profile')
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-[#1c2739] px-2 py-1.5">
        {(
          [
            ['profile', 'Volume Profile'],
            ['delta', 'Delta / Footprint'],
          ] as [typeof view, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
              view === v ? 'bg-cyan-500/15 text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto text-[9px] text-[#3d4c66]">{asset} · {tf}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {view === 'profile' ? <VolumeProfileView asset={asset} tf={tf} /> : <DeltaFootprintView asset={asset} tf={tf} />}
      </div>
    </div>
  )
}
