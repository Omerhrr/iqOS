'use client'

// TRADING PLAN overlay for the main chart (analytics/tradingplan.ts via GET /plan): every support / resistance as a horizontal line (strength = thickness, labelled), a plain vertical line at each hour boundary
// (the current hour labelled; lines only, no hour is judged), the AVOID zones shaded (price bands for the side they block), and the setup's entry zone / stop / target. Drawn on a canvas on top of the chart that
// never takes the mouse. Like the drawing tools it works in (time, price), so it stays glued to the market when you scroll or zoom.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { IChartApi, Logical } from 'lightweight-charts'
import { osGet } from '@/lib/os/client'

interface Bar { time: number; open: number; high: number; low: number; close: number }
interface Level { price: number; side: 'support' | 'resistance'; touches: number; strength: number; kind: string; distAtr: number }
interface Avoid { kind: 'price' | 'state'; side: 'call' | 'put' | 'both'; from: number; to: number; reason: string; active: boolean }
interface Mark { time: number; hour: number; label: string; now: boolean }
export interface PlanResp {
  ok: boolean; error?: string; lines?: string[]; levels?: Level[]; avoid?: Avoid[]; marks?: Mark[]; tfSec?: number
  trend?: { dir: string; stage: string; strength: number; tooFar: boolean; fresh: boolean }
  setup?: { side: string; ready: boolean; quality: number; allowCall: boolean; allowPut: boolean; stop: number; target: number; rr: number; entryLow: number; entryHigh: number; atEntry: boolean; blocks: string[] }
}
interface Props { open: boolean; chartRef: React.MutableRefObject<IChartApi | null>; seriesRef: React.MutableRefObject<unknown>; host: HTMLDivElement | null; bars: Bar[]; asset: string; tf: string; tfSeconds: number; onPlan?: (p: PlanResp | null) => void }

const fmtP = (p: number) => (!Number.isFinite(p) ? '-' : Math.abs(p) >= 1000 ? p.toFixed(2) : Math.abs(p) >= 10 ? p.toFixed(3) : p.toFixed(5))

export default function PlanOverlay({ open, chartRef, seriesRef, host, bars, asset, tf, tfSeconds, onPlan }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const planRef = useRef<PlanResp | null>(null)
  const barsRef = useRef<Bar[]>(bars)
  const [version, setVersion] = useState(0)
  barsRef.current = bars

  useEffect(() => {
    if (!open) { planRef.current = null; onPlan?.(null); setVersion((v) => v + 1); return }
    let alive = true
    const load = () => osGet<PlanResp>('/plan', { asset, tf }).then((r) => { if (alive) { planRef.current = r; onPlan?.(r); setVersion((v) => v + 1) } }).catch((e) => { if (alive) { planRef.current = { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 160) }; onPlan?.(planRef.current); setVersion((v) => v + 1) } })
    planRef.current = null; load()
    const t = window.setInterval(load, 20000)
    return () => { alive = false; window.clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asset, tf])

  const logicalOf = useCallback((t: number): number => {
    const ts = barsRef.current, n = ts.length, sp = tfSeconds || 60
    if (!n) return 0
    if (t <= ts[0].time) return (t - ts[0].time) / sp
    if (t >= ts[n - 1].time) return n - 1 + (t - ts[n - 1].time) / sp
    let lo = 0, hi = n - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m].time <= t) lo = m; else hi = m }
    return lo + (t - ts[lo].time) / Math.max(1, ts[hi].time - ts[lo].time)
  }, [tfSeconds])

  const paint = useCallback(() => {
    const cv = canvasRef.current
    if (!cv || !host) return
    const dpr = window.devicePixelRatio || 1, W = host.clientWidth, H = host.clientHeight
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr) }
    cv.style.width = `${W}px`; cv.style.height = `${H}px`
    const g = cv.getContext('2d'); if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H)
    const p = planRef.current, chart = chartRef.current, s = seriesRef.current as { priceToCoordinate: (p: number) => number | null } | null
    if (!open || !p || !p.ok || !chart || !s) return
    let pw = 64, th = 28
    try { pw = chart.priceScale('right').width(); th = chart.timeScale().height() } catch { /* defaults */ }
    const pl = { w: Math.max(0, W - pw), h: Math.max(0, H - th) }
    const X = (t: number) => { try { return chart.timeScale().logicalToCoordinate(logicalOf(t) as Logical) } catch { return null } }
    const Y = (price: number) => { try { return s.priceToCoordinate(price) } catch { return null } }
    g.save(); g.beginPath(); g.rect(0, 0, pl.w, pl.h); g.clip(); g.font = '10px ui-monospace, monospace'
    // avoid zones: hour bands (red, full height) and price bands (red for the side they block, full width)
    for (const z of p.avoid ?? []) {
      if (z.kind === 'price') { const a = Y(z.from), b = Y(z.to); if (a !== null && b !== null) { g.fillStyle = z.side === 'call' ? 'rgba(251,113,133,0.10)' : z.side === 'put' ? 'rgba(52,211,153,0.08)' : 'rgba(148,163,184,0.10)'; g.fillRect(0, Math.min(a, b), pl.w, Math.max(2, Math.abs(b - a)))
        g.fillStyle = z.side === 'call' ? 'rgba(251,113,133,0.9)' : z.side === 'put' ? 'rgba(52,211,153,0.9)' : 'rgba(148,163,184,0.9)'; g.fillText(`avoid ${z.side === 'both' ? '' : z.side + 's'}`.trim(), 6, Math.min(a, b) + 10) } }
    }
    // hour verticals
    for (const m of p.marks ?? []) {
      const x = X(m.time); if (x === null || x < -2 || x > pl.w + 2) continue
      g.strokeStyle = m.now ? '#94a3b8' : '#475569'; g.lineWidth = m.now ? 1.4 : 1; g.setLineDash([2, 4])
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, pl.h); g.stroke()
      g.setLineDash([]); g.fillStyle = m.now ? '#cbd5e1' : '#64748b'; g.fillText(m.label, x + 3, pl.h - 4)
    }
    // levels
    for (const l of p.levels ?? []) {
      const y = Y(l.price); if (y === null) continue
      const col = l.side === 'support' ? '#34d399' : '#fb7185'
      g.strokeStyle = col; g.globalAlpha = 0.35 + 0.5 * (l.strength / 100); g.lineWidth = l.strength >= 70 ? 2 : 1; g.setLineDash(l.kind === 'swing' ? [] : [6, 3])
      g.beginPath(); g.moveTo(0, y); g.lineTo(pl.w, y); g.stroke(); g.globalAlpha = 1; g.setLineDash([])
      g.fillStyle = col; g.fillText(`${l.kind === 'swing' ? (l.side === 'support' ? 'S' : 'R') : l.kind.replace('prev-day-', 'PD').replace('high', 'H').replace('low', 'L').replace('close', 'C')} ${l.strength}${l.kind === 'swing' ? ` x${l.touches}` : ''}`, pl.w - 64, y - 3)
    }
    // plan: entry zone, stop, target
    const v = p.setup
    if (v && v.ready) {
      const a = Y(v.entryLow), b = Y(v.entryHigh)
      if (a !== null && b !== null && Number.isFinite(v.entryLow)) { g.fillStyle = 'rgba(56,189,248,0.12)'; g.fillRect(0, Math.min(a, b), pl.w, Math.max(2, Math.abs(b - a))); g.fillStyle = '#38bdf8'; g.fillText(v.atEntry ? 'ENTRY ZONE (price is here)' : 'entry zone', 6, Math.min(a, b) - 3) }
      for (const [price, col, label] of [[v.stop, '#f43f5e', 'stop'], [v.target, '#10b981', `target ${Number.isFinite(v.rr) ? v.rr.toFixed(1) + 'R' : ''}`]] as [number, string, string][]) {
        const y = Y(price); if (y === null || !Number.isFinite(price)) continue
        g.strokeStyle = col; g.lineWidth = 1.5; g.setLineDash([8, 4]); g.beginPath(); g.moveTo(0, y); g.lineTo(pl.w, y); g.stroke(); g.setLineDash([]); g.fillStyle = col; g.fillText(`${label} ${fmtP(price)}`, 6, y - 3)
      }
    }
    g.restore()
  }, [host, open, chartRef, seriesRef, logicalOf])

  useEffect(() => {
    let raf = 0, last = ''
    const loop = () => {
      const chart = chartRef.current, s = seriesRef.current as { priceToCoordinate: (p: number) => number | null } | null
      if (chart && s && host) {
        let sig = `${host.clientWidth}x${host.clientHeight}|${version}|${open}|${barsRef.current.length}`
        try { sig += `|${chart.timeScale().logicalToCoordinate(0 as Logical)}|${chart.timeScale().logicalToCoordinate(100 as Logical)}|${s.priceToCoordinate(1)}|${s.priceToCoordinate(1.01)}|${s.priceToCoordinate(1000)}` } catch { /* mid-update */ }
        if (sig !== last) { last = sig; paint() }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [chartRef, seriesRef, host, paint, version, open])

  const top = host?.offsetTop ?? 0, left = host?.offsetLeft ?? 0
  return <canvas ref={canvasRef} className="pointer-events-none absolute z-[3]" style={{ position: 'absolute', top, left, zIndex: 3, pointerEvents: 'none' }} />
}
