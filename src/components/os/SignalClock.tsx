'use client'

// IQAIR//OS - the Signal clock: a half-dial with a SELL arc on the left, a WAIT
// arc across the top and a BUY arc on the right. The needle swings to the
// signal's needle value (-100 .. +100) in short ticks. While the signal is
// WAIT the needle is held inside the WAIT arc by the backend, so the dial never
// points at BUY/SELL for a call that was refused.

import { useEffect, useState } from 'react'

const CX = 150
const CY = 140
const R = 112
const SELL = '#fb7185'
const BUY = '#34d399'
const WAIT = '#fbbf24'
const ENTER = 35

// needle value (-100..100) -> angle on the half dial (180deg = full sell, 90 = top, 0 = full buy)
const angleOf = (v: number) => 90 - (Math.max(-100, Math.min(100, v)) / 100) * 90
const pt = (deg: number, r: number) => {
  const a = (deg * Math.PI) / 180
  return { x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) }
}
function arc(fromVal: number, toVal: number, r: number) {
  const a0 = angleOf(fromVal)
  const a1 = angleOf(toVal)
  const p0 = pt(a0, r)
  const p1 = pt(a1, r)
  const large = Math.abs(a0 - a1) > 180 ? 1 : 0
  // angles decrease as value increases: sweep clockwise (flag 1) from left to right
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`
}

export default function SignalClock({ needle, action, label, sub }: { needle: number; action: 'buy' | 'sell' | 'wait'; label: string; sub?: string }) {
  // tick toward the target in short steps so the needle reads like a clock hand, not a slider
  const [shown, setShown] = useState(0)
  useEffect(() => {
    const id = setInterval(() => {
      setShown((cur) => {
        const d = needle - cur
        if (Math.abs(d) < 0.6) return needle
        return cur + Math.sign(d) * Math.max(1.5, Math.abs(d) * 0.22)
      })
    }, 45)
    return () => clearInterval(id)
  }, [needle])

  const ang = angleOf(shown)
  const tip = pt(ang, R - 14)
  const tail = pt(ang + 180, 12)
  const col = action === 'buy' ? BUY : action === 'sell' ? SELL : WAIT
  const ticks = Array.from({ length: 21 }, (_, i) => -100 + i * 10)

  return (
    <svg viewBox="0 0 300 175" className="h-auto w-full" role="img" aria-label={`signal clock: ${label}`}>
      {/* zones */}
      <path d={arc(-100, -ENTER, R)} stroke={SELL} strokeWidth="14" fill="none" opacity={action === 'sell' ? 0.95 : 0.35} />
      <path d={arc(-ENTER, ENTER, R)} stroke={WAIT} strokeWidth="14" fill="none" opacity={action === 'wait' ? 0.85 : 0.3} />
      <path d={arc(ENTER, 100, R)} stroke={BUY} strokeWidth="14" fill="none" opacity={action === 'buy' ? 0.95 : 0.35} />
      {/* ticks */}
      {ticks.map((v) => {
        const major = v % 50 === 0
        const a = pt(angleOf(v), R - 11)
        const b = pt(angleOf(v), R - (major ? 22 : 17))
        return <line key={v} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#4b5a72" strokeWidth={major ? 1.4 : 0.8} />
      })}
      <text x={CX - R - 4} y={CY + 14} fontSize="9" fill={SELL} fontFamily="monospace" fontWeight="700" textAnchor="start">SELL</text>
      <text x={CX} y={CY - R - 14} fontSize="9" fill={WAIT} fontFamily="monospace" fontWeight="700" textAnchor="middle">WAIT</text>
      <text x={CX + R + 4} y={CY + 14} fontSize="9" fill={BUY} fontFamily="monospace" fontWeight="700" textAnchor="end">BUY</text>
      {/* needle */}
      <line x1={tail.x} y1={tail.y} x2={tip.x} y2={tip.y} stroke={col} strokeWidth="3" strokeLinecap="round" />
      <circle cx={CX} cy={CY} r="8" fill="#0b111c" stroke={col} strokeWidth="2.5" />
      {/* readout */}
      <text x={CX} y={CY + 30} fontSize="22" fill={col} fontFamily="monospace" fontWeight="800" textAnchor="middle">{label}</text>
      {sub && <text x={CX} y={CY + 42} fontSize="8.5" fill="#7c8aa5" fontFamily="monospace" textAnchor="middle">{sub}</text>}
    </svg>
  )
}
