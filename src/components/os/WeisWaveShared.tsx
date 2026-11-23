'use client'

// IQAIR//OS - shared bits of the Weis Wave panels (mode / sensitivity controls, rung strip, direction chip).
import { useEffect, useState } from 'react'
import type { WwMode, WwRung } from '@/lib/os/client'

export const WW_TF_CHOICES = ['30s', '1m', '2m', '5m', '15m'] as const

export function WwControls({ mode, setMode, thr, setThr, tfs, setTfs, live, setLive }: { mode: WwMode; setMode: (m: WwMode) => void; thr: number; setThr: (n: number) => void; tfs: string[]; setTfs: (t: string[]) => void; live: boolean; setLive: (b: boolean) => void }) {
  const btn = (on: boolean) => `rounded border px-1.5 py-px font-mono text-[8.5px] uppercase ${on ? 'border-[#3d4d66] bg-[#0e1524] text-[#dbe4f0]' : 'border-[#1c2739] text-[#7c8aa5] hover:text-[#dbe4f0]'}`
  return (
    <div className="flex flex-wrap items-center gap-1 font-mono text-[8.5px] text-[#7c8aa5]">
      <span title="how a wave is cut: ATR = a wave turns when the close reverses by thr x ATR14; close = every close-to-close direction change">cut</span>
      <button type="button" className={btn(mode === 'atr')} onClick={() => setMode('atr')}>atr</button>
      <button type="button" className={btn(mode === 'close')} onClick={() => setMode('close')}>close</button>
      {mode === 'atr' && (
        <>
          <span className="ml-1" title="ATR reversal multiple: higher = fewer, longer waves">x ATR</span>
          {[0.6, 1, 1.5, 2].map((n) => (
            <button key={n} type="button" className={btn(thr === n)} onClick={() => setThr(n)}>{n}</button>
          ))}
        </>
      )}
      <span className="ml-1" title="live = the bar still forming counts, so the running wave moves with price (can repaint until the bar closes); closed = finished bars only, it changes once per bar">bar</span>
      <button type="button" className={btn(live)} onClick={() => setLive(true)}>live</button>
      <button type="button" className={btn(!live)} onClick={() => setLive(false)}>closed</button>
      <span className="ml-1">tf</span>
      {WW_TF_CHOICES.map((t) => (
        <button
          key={t}
          type="button"
          className={btn(tfs.includes(t))}
          onClick={() => setTfs(tfs.includes(t) ? (tfs.length > 1 ? tfs.filter((x) => x !== t) : tfs) : WW_TF_CHOICES.filter((x) => tfs.includes(x) || x === t))}
        >
          {t}
        </button>
      ))}
    </div>
  )
}

export function DirChip({ d, strength }: { d: 'call' | 'put' | 'none'; strength?: number }) {
  const cls = d === 'call' ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300' : d === 'put' ? 'border-rose-500/50 bg-rose-500/15 text-rose-300' : 'border-[#3d4d66] text-[#7c8aa5]'
  return (
    <span className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1.5 py-px font-mono text-[8.5px] font-bold uppercase ${cls}`}>
      {d === 'call' ? '▲ call' : d === 'put' ? '▼ put' : '— none'}{strength !== undefined && d !== 'none' ? ` ${strength}` : ''}
    </span>
  )
}

/** one cell per timeframe: arrow = the rung's call/put, opacity = strength, dashed = warming up */
export function RungStrip({ rungs, best }: { rungs: WwRung[]; best?: string | null }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5" title="per-timeframe Weis Wave read: arrow = call/put, opacity = strength, dashed = warming up, ring = strongest rung">
      {rungs.map((r) => {
        const up = r.direction === 'call', dn = r.direction === 'put'
        const a = 0.12 + Math.min(1, r.strength / 100) * 0.45
        return (
          <span
            key={r.tf}
            className={`flex h-4 w-[30px] items-center justify-center rounded-sm border font-mono text-[7.5px] font-bold ${r.ok ? 'border-[#1c2739]' : 'border-dashed border-[#24324a] text-[#3d4d66]'} ${up ? 'text-emerald-200' : dn ? 'text-rose-200' : 'text-[#7c8aa5]'} ${best === r.tf && r.ok ? 'ring-1 ring-amber-400/60' : ''}`}
            style={r.ok && (up || dn) ? { backgroundColor: up ? `rgba(16,185,129,${a})` : `rgba(244,63,94,${a})` } : undefined}
            title={r.ok ? `${r.tf}: ${r.direction === 'none' ? 'no signal' : `${r.direction} ${r.strength}`}${r.reason ? ' · ' + r.reason : ''}` : `${r.tf}: ${r.note}`}
          >
            {r.ok ? `${r.tf}${up ? '▲' : dn ? '▼' : ''}` : '·'}
          </span>
        )
      })}
    </span>
  )
}

/** "updated 12s ago" that ticks every second, so a stale panel is visible at a glance */
export function Updated({ ts, busy }: { ts: number | null; busy?: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  if (!ts) return <span className="font-mono text-[8.5px] text-[#4b5a72]">{busy ? 'loading…' : 'not loaded yet'}</span>
  const age = Math.max(0, Math.round((now - ts) / 1000))
  return <span className={`font-mono text-[8.5px] ${age > 30 ? 'text-amber-300' : 'text-[#4b5a72]'}`} title="when the kernel computed this read">{busy ? 'refreshing… ' : ''}updated {age}s ago</span>
}
