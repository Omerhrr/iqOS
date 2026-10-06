'use client'

// IQAIR//OS - Candle Math (candle blending / candlestick algebra).
//
// Combines runs of 2-4 consecutive raw candles into a single synthetic
// "master" candle (Open=first, High=max, Low=min, Close=last - see
// trading-core/src/analytics/candlemath.ts) and keeps only the groups where
// blending reveals a candlestick pattern that wasn't visible in the raw,
// chopped-up candles (confirmed via the same detectPatterns() library used
// everywhere else in the OS). This is a heuristic pattern-discovery tool,
// not a guaranteed signal - same honesty framing as Order Flow.
import { useEffect, useMemo, useState } from 'react'
import type { Candle, CandleMathBlend, Timeframe } from '@/lib/os/client'
import { fmtPrice, getCandleMath } from '@/lib/os/client'

interface CandleMathViewProps {
  asset: string
  tf: Timeframe
  large?: boolean
}

function HeuristicTag() {
  return (
    <span
      className="ml-1.5 cursor-help rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-amber-400"
      title="Blended candles + pattern detection are a heuristic analysis aid, not a guaranteed signal - always confirm against the live chart."
    >
      heuristic
    </span>
  )
}

/** Renders one OHLC candle as a real body+wick SVG bar at column `cx`. */
function CandleBar({
  cx,
  halfW,
  open,
  high,
  low,
  close,
  priceToY,
  dim,
}: {
  cx: number
  halfW: number
  open: number
  high: number
  low: number
  close: number
  priceToY: (p: number) => number
  dim?: boolean
}) {
  const bull = close >= open
  const color = bull ? '#10b981' : '#f43f5e'
  const yOpen = priceToY(open)
  const yClose = priceToY(close)
  const yHigh = priceToY(high)
  const yLow = priceToY(low)
  const bodyTop = Math.min(yOpen, yClose)
  const bodyH = Math.max(1, Math.abs(yClose - yOpen))
  return (
    <g opacity={dim ? 0.35 : 1}>
      <line x1={cx} x2={cx} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1} />
      <rect x={cx - halfW} y={bodyTop} width={halfW * 2} height={bodyH} fill={color} stroke={color} />
    </g>
  )
}

export default function CandleMathView({ asset, tf, large = false }: CandleMathViewProps) {
  const [raw, setRaw] = useState<Candle[]>([])
  const [blends, setBlends] = useState<CandleMathBlend[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(null)
    getCandleMath(asset, tf, { limit: 200, maxGroup: 4 })
      .then((d) => {
        if (cancelled) return
        setRaw(d.raw)
        setBlends(d.blends)
        setSelected(0)
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

  // Only show the tail of the raw series so bars stay legible - the blend
  // finder still ran over the full fetched window.
  const VISIBLE = large ? 90 : 48
  const visible = useMemo(() => raw.slice(-VISIBLE), [raw])
  const visibleOffset = raw.length - visible.length

  const chart = useMemo(() => {
    if (visible.length === 0) return null
    const W = large ? 920 : 560
    const H = large ? 300 : 150
    const PAD_TOP = 10
    const PAD_BOTTOM = 10
    let lo = Infinity
    let hi = -Infinity
    for (const c of visible) {
      if (c.low < lo) lo = c.low
      if (c.high > hi) hi = c.high
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
      hi = lo + 1
    }
    const innerH = H - PAD_TOP - PAD_BOTTOM
    const priceToY = (p: number) => PAD_TOP + ((hi - p) / (hi - lo)) * innerH
    const n = visible.length
    const colW = W / n
    const cx = (i: number) => i * colW + colW / 2
    const halfW = Math.max(1, colW * 0.32)
    return { W, H, priceToY, cx, halfW, n, colW }
  }, [visible, large])

  if (busy && raw.length === 0) return <div className="p-3 text-[10px] text-[#4b5a72]">loading candle math…</div>
  if (error) return <div className="p-3 text-[10px] text-rose-400">{error}</div>
  if (!chart) return <div className="p-3 text-[10px] text-[#4b5a72]">not enough candle history yet.</div>

  const visibleBlends = blends.filter((b) => b.endIdx >= visibleOffset)
  const active = visibleBlends[selected]

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center text-[10px] uppercase tracking-wider text-[#4b5a72]">
          Candle Math
          <HeuristicTag />
        </div>
        <div className="font-mono text-[9px] text-[#3d4c66]">
          {visibleBlends.length} smart blend{visibleBlends.length === 1 ? '' : 's'} found
        </div>
      </div>

      <svg viewBox={`0 0 ${chart.W} ${chart.H}`} className={large ? 'h-[300px] w-full' : 'h-[150px] w-full'}>
        {/* highlight bracket behind each blended group's raw candles */}
        {visibleBlends.map((b, i) => {
          const s = b.startIdx - visibleOffset
          const e = b.endIdx - visibleOffset
          if (e < 0 || s >= chart.n) return null
          const x0 = Math.max(0, s) * chart.colW
          const x1 = Math.min(chart.n, e + 1) * chart.colW
          const isActive = i === selected
          return (
            <rect
              key={`hl-${i}`}
              x={x0}
              y={0}
              width={Math.max(1, x1 - x0)}
              height={chart.H}
              fill={isActive ? 'rgba(56,189,248,0.14)' : 'rgba(56,189,248,0.06)'}
              stroke={isActive ? '#38bdf8' : 'rgba(56,189,248,0.3)'}
              strokeWidth={isActive ? 1.2 : 0.6}
              onClick={() => setSelected(i)}
              style={{ cursor: 'pointer' }}
            />
          )
        })}
        {/* raw OHLC candles */}
        {visible.map((c, i) => (
          <CandleBar
            key={i}
            cx={chart.cx(i)}
            halfW={chart.halfW}
            open={c.open}
            high={c.high}
            low={c.low}
            close={c.close}
            priceToY={chart.priceToY}
          />
        ))}
      </svg>

      {active ? (
        <div className="flex flex-col gap-1.5 rounded border border-[#1c2739] bg-[#0d1420] p-2">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[9px] text-[#4b5a72]">
              blended {active.endIdx - active.startIdx + 1} candles · idx {active.startIdx}-{active.endIdx}
            </div>
            <div className="flex gap-1">
              {visibleBlends.length > 1 &&
                visibleBlends.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelected(i)}
                    className={`h-1.5 w-1.5 rounded-full ${i === selected ? 'bg-cyan-400' : 'bg-[#2a3850]'}`}
                    aria-label={`blend ${i + 1}`}
                  />
                ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <svg viewBox="0 0 40 60" className="h-[60px] w-[40px] shrink-0">
              <CandleBar
                cx={20}
                halfW={10}
                open={active.blended.open}
                high={active.blended.high}
                low={active.blended.low}
                close={active.blended.close}
                priceToY={(p) => {
                  const lo = Math.min(active.blended.low, active.blended.low)
                  const hi = Math.max(active.blended.high, active.blended.high)
                  const span = Math.max(hi - lo, 1e-9)
                  return 6 + ((hi - p) / span) * 48
                }}
              />
            </svg>
            <div className="flex flex-col gap-0.5 font-mono text-[9px] text-[#aab6cc]">
              <div>
                O {fmtPrice(active.blended.open, asset)} · H {fmtPrice(active.blended.high, asset)} · L {fmtPrice(active.blended.low, asset)} · C{' '}
                {fmtPrice(active.blended.close, asset)}
              </div>
              <div className="text-cyan-300">
                → {active.patterns.join(', ')} <span className="text-[#4b5a72]">(blended)</span>
              </div>
              {active.rawPatterns.length > 0 && (
                <div className="text-[#4b5a72]">raw candles showed: {active.rawPatterns.join(', ')}</div>
              )}
              {active.rawPatterns.length === 0 && <div className="text-[#4b5a72]">raw candles showed no pattern here</div>}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-1 text-[9px] text-[#4b5a72]">
          No blended group in the visible window revealed a new pattern - scanning continues as fresh candles arrive.
        </div>
      )}

      <p className="text-[9px] leading-relaxed text-[#4b5a72]">
        Each candle is merged with its 1-3 neighbors (Open=first, High=max, Low=min, Close=last, same algebra for any run of consecutive
        bars) only when the merged candle produces a candlestick pattern (hammer, engulfing, marubozu, etc.) that the raw, unblended candles
        don&apos;t show - the idea being that a real move can get artificially chopped across fixed-interval candle boundaries. Pattern
        detection is a heuristic, not a guarantee.
      </p>
    </div>
  )
}
