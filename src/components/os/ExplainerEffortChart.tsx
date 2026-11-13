'use client'

// IQAIR//OS - Effort Renko chart for the Explainer tab.
// Plain SVG. Each brick is one column; FILLED = the brick was backed by
// at-least-average volume (confirmed), OUTLINED = distance painted without
// real participation behind it. A thin bar under each brick shows its effort
// ratio against the average (1.0x line). No volume feed = every brick reads
// outlined, and the footer says so instead of implying a signal.

import { useMemo } from 'react'
import type { ExplainerEffort } from '@/lib/os/client'
import { fmtPrice } from '@/lib/os/client'

const W = 360
const H = 150
const PAD_L = 6
const PAD_R = 46
const PAD_T = 8
const BAR_H = 22
const GAP = 6
const UP = '#34d399'
const DOWN = '#fb7185'

export default function ExplainerEffortChart({ effort, asset }: { effort: ExplainerEffort; asset: string }) {
  const geo = useMemo(() => {
    const bs = effort.bricks
    if (bs.length < 2) return null
    let lo = Infinity
    let hi = -Infinity
    for (const b of bs) {
      lo = Math.min(lo, b.open, b.close)
      hi = Math.max(hi, b.open, b.close)
    }
    const span = hi - lo || Math.abs(hi) * 1e-4 || 1
    lo -= span * 0.05
    hi += span * 0.05
    const innerW = W - PAD_L - PAD_R
    const priceH = H - PAD_T - BAR_H - GAP
    const step = innerW / bs.length
    const x = (i: number) => PAD_L + step * i
    const y = (p: number) => PAD_T + priceH * (1 - (p - lo) / (hi - lo))
    const maxRatio = Math.max(2, ...bs.map((b) => b.effortRatio ?? 0))
    return { bs, step, x, y, lo, hi, priceH, maxRatio }
  }, [effort])

  if (!geo) return <div className="flex h-[150px] items-center justify-center font-mono text-[9px] text-[#4b5a72]">not enough bricks to draw</div>
  const { bs, step, x, y, lo, hi, priceH, maxRatio } = geo
  const bw = Math.max(1.5, step * 0.78)
  const baseY = H - 2
  const avgY = baseY - (1 / maxRatio) * BAR_H

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="effort renko chart" preserveAspectRatio="xMidYMid meet">
      <text x={W - PAD_R + 4} y={PAD_T + 3} fontSize="7" fill="#4b5a72" fontFamily="monospace">{fmtPrice(hi, asset)}</text>
      <text x={W - PAD_R + 4} y={PAD_T + priceH} fontSize="7" fill="#4b5a72" fontFamily="monospace">{fmtPrice(lo, asset)}</text>
      {bs.map((b, i) => {
        const col = b.dir === 1 ? UP : DOWN
        const top = y(Math.max(b.open, b.close))
        const bot = y(Math.min(b.open, b.close))
        const h = Math.max(1, bot - top)
        const er = b.effortRatio ?? 0
        const eh = Math.max(0.5, (Math.min(er, maxRatio) / maxRatio) * BAR_H)
        return (
          <g key={`${b.time}-${i}`}>
            <rect
              x={x(i) + (step - bw) / 2}
              y={top}
              width={bw}
              height={h}
              fill={b.confirmed ? col : 'none'}
              stroke={col}
              strokeWidth={b.confirmed ? 0.4 : 0.9}
              opacity={b.confirmed ? 0.9 : 0.75}
            />
            <rect x={x(i) + (step - bw) / 2} y={baseY - eh} width={bw} height={eh} fill={b.confirmed ? col : '#3d4d66'} opacity="0.55" />
          </g>
        )
      })}
      <line x1={PAD_L} x2={W - PAD_R} y1={avgY} y2={avgY} stroke="#7c8aa5" strokeWidth="0.5" strokeDasharray="2 2" opacity="0.8" />
      <text x={W - PAD_R + 4} y={avgY + 2.5} fontSize="6.5" fill="#7c8aa5" fontFamily="monospace">1.0x effort</text>
    </svg>
  )
}
