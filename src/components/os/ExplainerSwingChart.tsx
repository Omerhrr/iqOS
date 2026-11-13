'use client'

// IQAIR//OS - small swing chart for the Explainer tab.
// Plain SVG (no chart library, no lifecycle): the newest closed candles, each
// confirmed swing high/low marked with a triangle and its price, and a dashed
// zig-zag joining the swings in time order. A swing needs `lookback` bars
// AFTER it to confirm, so the right edge of the chart never has one - the
// footer says so instead of letting the gap look like a missing signal.

import { useMemo } from 'react'
import type { ExplainerChart } from '@/lib/os/client'
import { fmtPrice } from '@/lib/os/client'

const W = 360
const H = 150
const PAD_L = 6
const PAD_R = 46
const PAD_T = 10
const PAD_B = 10

const UP = '#34d399'
const DOWN = '#fb7185'

export default function ExplainerSwingChart({ chart, asset }: { chart: ExplainerChart; asset: string }) {
  const geo = useMemo(() => {
    const cs = chart.candles
    if (cs.length < 2) return null
    let lo = Infinity
    let hi = -Infinity
    for (const c of cs) {
      if (c.low < lo) lo = c.low
      if (c.high > hi) hi = c.high
    }
    for (const s of chart.swings) {
      if (s.price < lo) lo = s.price
      if (s.price > hi) hi = s.price
    }
    const span = hi - lo || Math.abs(hi) * 1e-4 || 1
    lo -= span * 0.04
    hi += span * 0.04
    const innerW = W - PAD_L - PAD_R
    const innerH = H - PAD_T - PAD_B
    const step = innerW / cs.length
    const x = (i: number) => PAD_L + step * (i + 0.5)
    const y = (p: number) => PAD_T + innerH * (1 - (p - lo) / (hi - lo))
    const indexByTime = new Map<number, number>()
    cs.forEach((c, i) => indexByTime.set(c.time, i))
    const pts = chart.swings
      .map((s) => ({ ...s, i: indexByTime.get(s.time) }))
      .filter((s): s is typeof s & { i: number } => s.i !== undefined)
      .sort((a, b) => a.i - b.i)
    return { cs, step, x, y, pts, lo, hi }
  }, [chart])

  if (!geo) return <div className="flex h-[150px] items-center justify-center font-mono text-[9px] text-[#4b5a72]">not enough candles to draw</div>
  const { cs, step, x, y, pts, lo, hi } = geo
  const bodyW = Math.max(1.2, Math.min(6, step * 0.62))
  const last = cs[cs.length - 1]
  const zig = pts.map((s) => `${x(s.i).toFixed(1)},${y(s.price).toFixed(1)}`).join(' ')

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="swing chart" preserveAspectRatio="xMidYMid meet">
      {/* price scale */}
      <text x={W - PAD_R + 4} y={PAD_T + 3} fontSize="7" fill="#4b5a72" fontFamily="monospace">{fmtPrice(hi, asset)}</text>
      <text x={W - PAD_R + 4} y={H - PAD_B} fontSize="7" fill="#4b5a72" fontFamily="monospace">{fmtPrice(lo, asset)}</text>
      {/* candles */}
      {cs.map((c, i) => {
        const up = c.close >= c.open
        const col = up ? UP : DOWN
        const top = y(Math.max(c.open, c.close))
        const bot = y(Math.min(c.open, c.close))
        return (
          <g key={c.time}>
            <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth="0.8" opacity="0.75" />
            <rect x={x(i) - bodyW / 2} y={top} width={bodyW} height={Math.max(0.8, bot - top)} fill={col} opacity={up ? 0.85 : 0.9} />
          </g>
        )
      })}
      {/* swing zig-zag */}
      {pts.length > 1 && <polyline points={zig} fill="none" stroke="#7c8aa5" strokeWidth="0.9" strokeDasharray="3 2" opacity="0.8" />}
      {/* swing markers */}
      {pts.map((s) => {
        const sx = x(s.i)
        const sy = y(s.price)
        const isHigh = s.kind === 'high'
        const d = isHigh ? `M${sx - 3},${sy - 6} L${sx + 3},${sy - 6} L${sx},${sy - 1} Z` : `M${sx - 3},${sy + 6} L${sx + 3},${sy + 6} L${sx},${sy + 1} Z`
        return (
          <g key={`${s.kind}-${s.time}`}>
            <path d={d} fill={isHigh ? DOWN : UP} opacity="0.95" />
            <text x={sx} y={isHigh ? sy - 8 : sy + 14} fontSize="6.5" fill="#aab6cc" textAnchor="middle" fontFamily="monospace">
              {fmtPrice(s.price, asset)}
            </text>
          </g>
        )
      })}
      {/* last close */}
      <line x1={PAD_L} x2={W - PAD_R} y1={y(last.close)} y2={y(last.close)} stroke="#38bdf8" strokeWidth="0.6" strokeDasharray="1.5 2" opacity="0.7" />
      <text x={W - PAD_R + 4} y={y(last.close) + 2.5} fontSize="7" fill="#38bdf8" fontFamily="monospace">{fmtPrice(last.close, asset)}</text>
    </svg>
  )
}
