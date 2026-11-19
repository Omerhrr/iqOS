'use client'

// DR - drawing tools for the main chart (TradingView style): trendline, ray, arrow, parallel channel, horizontal line, vertical line, rectangle (box), fib retracement, text.
// Every drawing is stored as (time, price) points, so it stays glued to the market when you scroll, zoom or rescale; it can be selected, dragged whole, reshaped by its handles, recoloured,
// restyled and deleted, with undo / redo and an optional magnet that snaps to candle open/high/low/close. Trendlines, channels and fibs can extend to the right so they keep following
// price after the chart has moved past them. Drawings are kept per asset in this browser (localStorage). The layer is a canvas on top of the chart; it only intercepts the mouse when a tool
// is active or the pointer is on a drawing, so normal chart panning is untouched.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { IChartApi, Logical } from 'lightweight-charts'

type Tool = 'cursor' | 'trend' | 'ray' | 'arrow' | 'channel' | 'hline' | 'vline' | 'rect' | 'fib' | 'text'
interface Pt { t: number; p: number }
interface Drawing { id: string; type: Exclude<Tool, 'cursor'>; pts: Pt[]; color: string; width: number; dash: boolean; fill: number; ext: boolean; text?: string }
interface Bar { time: number; open: number; high: number; low: number; close: number }

const NEED: Record<Exclude<Tool, 'cursor'>, number> = { trend: 2, ray: 2, arrow: 2, channel: 3, hline: 1, vline: 1, rect: 2, fib: 2, text: 1 }
const TOOLS: { id: Tool; label: string; title: string }[] = [
  { id: 'cursor', label: 'SEL', title: 'Select / move drawings (Esc)' },
  { id: 'trend', label: 'TL', title: 'Trendline - drag, or click two points' },
  { id: 'ray', label: 'RAY', title: 'Ray - a line that runs on to the right' },
  { id: 'arrow', label: 'ARW', title: 'Arrow' },
  { id: 'channel', label: 'CHN', title: 'Parallel channel - drag or click the first line, then click where the parallel goes' },
  { id: 'hline', label: 'H', title: 'Horizontal line - click once' },
  { id: 'vline', label: 'V', title: 'Vertical line - click once' },
  { id: 'rect', label: 'BOX', title: 'Rectangle / box - drag, or click two corners' },
  { id: 'fib', label: 'FIB', title: 'Fibonacci retracement - drag from the swing start to the swing end' },
  { id: 'text', label: 'T', title: 'Text note - click once' },
]
const SWATCHES = ['#38bdf8', '#10b981', '#f43f5e', '#f59e0b', '#a78bfa', '#e2e8f0', '#fb923c', '#facc15']
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
const HIT = 7
const SNAP_PX = 16

interface Props {
  open: boolean
  chartRef: React.MutableRefObject<IChartApi | null>
  seriesRef: React.MutableRefObject<unknown>
  host: HTMLDivElement | null
  bars: Bar[]
  asset: string
  tfSeconds: number
}

const uid = () => Math.random().toString(36).slice(2, 10)
const fmtP = (p: number) => (!Number.isFinite(p) ? '-' : Math.abs(p) >= 1000 ? p.toFixed(2) : Math.abs(p) >= 10 ? p.toFixed(3) : p.toFixed(5))
const hexA = (hex: string, a: number) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return hex
  const n = parseInt(m[1], 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
const distSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number, ray = false) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
  t = ray ? Math.max(0, t) : Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
/** push the end of a segment out to x = reach (a ray) */
const reachX = (a: { x: number; y: number }, b: { x: number; y: number }, reach: number) => {
  const dx = b.x - a.x
  if (dx <= 0) return { x: b.x, y: b.y }
  const k = (reach - a.x) / dx
  return k > 1 ? { x: reach, y: a.y + (b.y - a.y) * k } : { x: b.x, y: b.y }
}

export default function DrawingLayer({ open, chartRef, seriesRef, host, bars, asset, tfSeconds }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [tool, setTool] = useState<Tool>('cursor')
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [selId, setSelId] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  const [magnet, setMagnet] = useState(false)
  const [version, setVersion] = useState(0)
  const barsRef = useRef<Bar[]>(bars); barsRef.current = bars
  const spRef = useRef(tfSeconds); spRef.current = tfSeconds
  const dRef = useRef<Drawing[]>(drawings); dRef.current = drawings
  const selRef = useRef<string | null>(selId); selRef.current = selId
  const toolRef = useRef<Tool>(tool); toolRef.current = tool
  const openRef = useRef(open); openRef.current = open
  const hiddenRef = useRef(hidden); hiddenRef.current = hidden
  const magnetRef = useRef(magnet); magnetRef.current = magnet
  const draftRef = useRef<Drawing | null>(null)
  const placedRef = useRef(0)
  const dragRef = useRef<null | { kind: 'draw' | 'move' | 'handle'; id: string; sx: number; sy: number; orig: Pt[]; idx: number; moved: boolean }>(null)
  const undoRef = useRef<Drawing[][]>([])
  const redoRef = useRef<Drawing[][]>([])
  const lastPatchPush = useRef(0)

  // ---- undo / redo ----
  const pushUndo = useCallback(() => {
    undoRef.current.push(JSON.parse(JSON.stringify(dRef.current)) as Drawing[])
    if (undoRef.current.length > 100) undoRef.current.shift()
    redoRef.current = []
  }, [])
  const undo = useCallback(() => {
    const prev = undoRef.current.pop(); if (!prev) return
    redoRef.current.push(JSON.parse(JSON.stringify(dRef.current)) as Drawing[])
    setDrawings(prev); setSelId(null); draftRef.current = null; setVersion((v) => v + 1)
  }, [])
  const redo = useCallback(() => {
    const nxt = redoRef.current.pop(); if (!nxt) return
    undoRef.current.push(JSON.parse(JSON.stringify(dRef.current)) as Drawing[])
    setDrawings(nxt); setSelId(null); setVersion((v) => v + 1)
  }, [])

  // ---- persistence (per asset) ----
  const key = `iqos:drawings:v1:${asset}`
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key)
      setDrawings(raw ? (JSON.parse(raw) as Drawing[]).filter((d) => d && d.type in NEED && Array.isArray(d.pts)).map((d) => ({ ...d, ext: d.ext ?? d.type === 'fib' })) : [])
    } catch { setDrawings([]) }
    setSelId(null); undoRef.current = []; redoRef.current = []
  }, [key])
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(drawings)) } catch { /* storage unavailable - drawings stay in memory */ } }, [drawings, key])
  useEffect(() => { try { setMagnet(localStorage.getItem('iqos:drawings:magnet') === '1') } catch { /* default off */ } }, [])
  useEffect(() => { try { localStorage.setItem('iqos:drawings:magnet', magnet ? '1' : '0') } catch { /* ignore */ } }, [magnet])

  // ---- time <-> x, price <-> y ----
  const logicalOf = useCallback((t: number): number => {
    const ts = barsRef.current, n = ts.length, sp = spRef.current || 60
    if (!n) return 0
    if (t <= ts[0].time) return (t - ts[0].time) / sp
    if (t >= ts[n - 1].time) return n - 1 + (t - ts[n - 1].time) / sp
    let lo = 0, hi = n - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m].time <= t) lo = m; else hi = m }
    return lo + (t - ts[lo].time) / Math.max(1, ts[hi].time - ts[lo].time)
  }, [])
  const timeOf = useCallback((l: number): number => {
    const ts = barsRef.current, n = ts.length, sp = spRef.current || 60
    if (!n) return 0
    if (l <= 0) return ts[0].time + l * sp
    if (l >= n - 1) return ts[n - 1].time + (l - (n - 1)) * sp
    const i = Math.floor(l)
    return ts[i].time + (l - i) * (ts[i + 1].time - ts[i].time)
  }, [])
  const toPx = useCallback((pt: Pt): { x: number; y: number } | null => {
    const chart = chartRef.current, s = seriesRef.current as { priceToCoordinate: (p: number) => number | null } | null
    if (!chart || !s) return null
    const x = chart.timeScale().logicalToCoordinate(logicalOf(pt.t) as Logical), y = s.priceToCoordinate(pt.p)
    if (x === null || y === null) return null
    return { x, y }
  }, [chartRef, seriesRef, logicalOf])
  const fromPx = useCallback((x: number, y: number, snap = false): Pt | null => {
    const chart = chartRef.current, s = seriesRef.current as { coordinateToPrice: (y: number) => number | null; priceToCoordinate: (p: number) => number | null } | null
    if (!chart || !s) return null
    const l = chart.timeScale().coordinateToLogical(x), p = s.coordinateToPrice(y)
    if (l === null || p === null) return null
    let pt: Pt = { t: timeOf(l as number), p }
    if (snap && magnetRef.current) {
      const bar = barsRef.current[Math.round(l as number)]
      if (bar) {
        let best: number | null = null, bd = SNAP_PX + 1
        for (const v of [bar.open, bar.high, bar.low, bar.close]) { const py = s.priceToCoordinate(v); if (py !== null && Math.abs(py - y) < bd) { bd = Math.abs(py - y); best = v } }
        if (best !== null) pt = { t: bar.time, p: best }
      }
    }
    return pt
  }, [chartRef, seriesRef, timeOf])

  // plot area (excludes the price scale on the right and the time axis at the bottom)
  const plot = useCallback(() => {
    const chart = chartRef.current
    const w = host?.clientWidth ?? 0, h = host?.clientHeight ?? 0
    let pw = 64, th = 28
    try { pw = chart?.priceScale('right').width() ?? 64; th = chart?.timeScale().height() ?? 28 } catch { /* defaults */ }
    return { w: Math.max(0, w - pw), h: Math.max(0, h - th) }
  }, [chartRef, host])

  /** pixel geometry of a parallel channel: the base line and the parallel one through the third point */
  const chanPx = useCallback((d: Drawing) => {
    if (d.pts.length < 3) return null
    const [A, B, C] = d.pts
    const dt = B.t - A.t
    const onBase = A.p + (dt === 0 ? 0 : ((B.p - A.p) * (C.t - A.t)) / dt)
    const off = C.p - onBase
    const a = toPx(A), b = toPx(B), a2 = toPx({ t: A.t, p: A.p + off }), b2 = toPx({ t: B.t, p: B.p + off })
    return a && b && a2 && b2 ? { a, b, a2, b2 } : null
  }, [toPx])

  // ---- hit testing ----
  const hitTest = useCallback((x: number, y: number): { id: string; handle: number } | null => {
    const list = dRef.current
    const sel = list.find((d) => d.id === selRef.current)
    if (sel) {
      for (let i = 0; i < sel.pts.length; i++) { const q = toPx(sel.pts[i]); if (q && Math.hypot(q.x - x, q.y - y) <= HIT + 2) return { id: sel.id, handle: i } }
    }
    const pl = plot()
    for (let k = list.length - 1; k >= 0; k--) {
      const d = list[k], q = d.pts.map(toPx)
      if (q.some((v) => !v)) continue
      const a = q[0]!, b = q[1]
      let hit = false
      if (d.type === 'trend' || d.type === 'arrow') { if (b) { const e = d.ext && d.type === 'trend' ? reachX(a, b, pl.w + 200) : b; hit = distSeg(x, y, a.x, a.y, e.x, e.y) <= HIT } }
      else if (d.type === 'ray') hit = !!b && distSeg(x, y, a.x, a.y, b.x, b.y, true) <= HIT
      else if (d.type === 'channel') {
        const c = chanPx(d)
        if (c) { const e1 = d.ext ? reachX(c.a, c.b, pl.w + 200) : c.b, e2 = d.ext ? reachX(c.a2, c.b2, pl.w + 200) : c.b2; hit = distSeg(x, y, c.a.x, c.a.y, e1.x, e1.y) <= HIT || distSeg(x, y, c.a2.x, c.a2.y, e2.x, e2.y) <= HIT }
      } else if (d.type === 'hline') hit = Math.abs(y - a.y) <= HIT
      else if (d.type === 'vline') hit = Math.abs(x - a.x) <= HIT
      else if (d.type === 'rect' && b) { const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y); hit = x >= x0 - HIT && x <= x1 + HIT && y >= y0 - HIT && y <= y1 + HIT }
      else if (d.type === 'fib' && b) {
        const x0 = Math.min(a.x, b.x), x1 = d.ext ? pl.w : Math.max(a.x, b.x)
        if (x >= x0 - HIT && x <= x1 + HIT) hit = FIB_LEVELS.some((lv) => Math.abs(y - (a.y + (b.y - a.y) * lv)) <= HIT)
      } else if (d.type === 'text') hit = Math.abs(x - a.x) <= 60 && Math.abs(y - a.y) <= 12
      if (hit) return { id: d.id, handle: -1 }
    }
    return null
  }, [toPx, plot, chanPx])

  // ---- drawing ----
  const paint = useCallback(() => {
    const cv = canvasRef.current
    if (!cv || !host) return
    const dpr = window.devicePixelRatio || 1
    const W = host.clientWidth, H = host.clientHeight
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr) }
    cv.style.width = `${W}px`; cv.style.height = `${H}px`
    const g = cv.getContext('2d'); if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    if (hiddenRef.current) return
    const pl = plot()
    g.save(); g.beginPath(); g.rect(0, 0, pl.w, pl.h); g.clip()
    g.font = '10px ui-monospace, monospace'
    const draft = draftRef.current
    const all = draft ? [...dRef.current, draft] : dRef.current
    for (const d of all) {
      const q = d.pts.map(toPx)
      if (q.some((v) => !v)) continue
      const a = q[0]!, b = q[1]
      const sel = d.id === selRef.current
      g.strokeStyle = d.color; g.fillStyle = d.color; g.lineWidth = d.width + (sel ? 0.5 : 0)
      g.setLineDash(d.dash ? [6, 4] : [])
      if (d.type === 'trend' || d.type === 'ray' || d.type === 'arrow') {
        if (!b) continue
        const e = d.type === 'ray' ? reachX(a, b, pl.w + 200) : d.type === 'trend' && d.ext ? reachX(a, b, pl.w + 200) : b
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(e.x, e.y); g.stroke()
        if (d.type === 'arrow') { g.setLineDash([]); const ang = Math.atan2(b.y - a.y, b.x - a.x), s = 10 + d.width * 2; g.beginPath(); g.moveTo(b.x, b.y); g.lineTo(b.x - s * Math.cos(ang - 0.4), b.y - s * Math.sin(ang - 0.4)); g.lineTo(b.x - s * Math.cos(ang + 0.4), b.y - s * Math.sin(ang + 0.4)); g.closePath(); g.fill() }
      } else if (d.type === 'channel') {
        if (d.pts.length < 3) { if (b) { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke() } }
        const c = chanPx(d)
        if (c) {
          const e1 = d.ext ? reachX(c.a, c.b, pl.w + 200) : c.b, e2 = d.ext ? reachX(c.a2, c.b2, pl.w + 200) : c.b2
          if (d.fill > 0) { g.fillStyle = hexA(d.color, d.fill); g.beginPath(); g.moveTo(c.a.x, c.a.y); g.lineTo(e1.x, e1.y); g.lineTo(e2.x, e2.y); g.lineTo(c.a2.x, c.a2.y); g.closePath(); g.fill() }
          g.beginPath(); g.moveTo(c.a.x, c.a.y); g.lineTo(e1.x, e1.y); g.stroke()
          g.beginPath(); g.moveTo(c.a2.x, c.a2.y); g.lineTo(e2.x, e2.y); g.stroke()
          g.setLineDash([3, 4]); g.strokeStyle = hexA(d.color, 0.55)
          g.beginPath(); g.moveTo((c.a.x + c.a2.x) / 2, (c.a.y + c.a2.y) / 2); g.lineTo((e1.x + e2.x) / 2, (e1.y + e2.y) / 2); g.stroke()
        }
      } else if (d.type === 'hline') {
        g.beginPath(); g.moveTo(0, a.y); g.lineTo(pl.w, a.y); g.stroke()
        g.setLineDash([]); const label = fmtP(d.pts[0].p), tw = g.measureText(label).width + 8
        g.fillStyle = hexA(d.color, 0.9); g.fillRect(pl.w - tw - 2, a.y - 8, tw, 16); g.fillStyle = '#0b111c'; g.fillText(label, pl.w - tw + 2, a.y + 3)
      } else if (d.type === 'vline') {
        g.beginPath(); g.moveTo(a.x, 0); g.lineTo(a.x, pl.h); g.stroke()
      } else if (d.type === 'rect') {
        if (!b) continue
        const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y)
        if (d.fill > 0) { g.fillStyle = hexA(d.color, d.fill); g.fillRect(x0, y0, w, h) }
        g.strokeRect(x0, y0, w, h)
      } else if (d.type === 'fib') {
        if (!b) continue
        const x0 = Math.min(a.x, b.x), x1 = d.ext ? Math.max(pl.w, Math.max(a.x, b.x)) : Math.max(a.x, b.x)
        const lx = Math.max(x0, 0) + 4 // labels stay readable when the swing start has scrolled off the left edge
        g.setLineDash([])
        FIB_LEVELS.forEach((lv, i) => {
          const y = a.y + (b.y - a.y) * lv, price = d.pts[0].p + (d.pts[1].p - d.pts[0].p) * lv
          if (d.fill > 0 && i < FIB_LEVELS.length - 1) { const yn = a.y + (b.y - a.y) * FIB_LEVELS[i + 1]; g.fillStyle = hexA(d.color, d.fill * (i % 2 ? 0.5 : 1)); g.fillRect(x0, Math.min(y, yn), x1 - x0, Math.abs(yn - y)) }
          g.strokeStyle = d.color; g.setLineDash(lv === 0 || lv === 1 ? [] : [4, 3]); g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke()
          g.setLineDash([]); g.fillStyle = d.color; g.fillText(`${lv} (${fmtP(price)})`, lx, y - 3)
        })
        g.setLineDash([3, 3]); g.strokeStyle = hexA(d.color, 0.6); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke()
      } else if (d.type === 'text') {
        g.setLineDash([]); g.font = `${10 + d.width * 2}px ui-sans-serif, system-ui, sans-serif`; g.fillStyle = d.color; g.fillText(d.text || 'text', a.x, a.y)
      }
      if (sel) {
        g.setLineDash([]); g.lineWidth = 1.5
        for (const p of q) { g.fillStyle = '#0b111c'; g.strokeStyle = d.color; g.beginPath(); g.arc(p!.x, p!.y, 4.5, 0, Math.PI * 2); g.fill(); g.stroke() }
      }
    }
    g.restore()
  }, [host, plot, toPx, chanPx])

  // repaint whenever the chart moves: a light rAF loop that only redraws when the view signature changes (covers scroll, zoom, price rescale, resize, new bars)
  useEffect(() => {
    let raf = 0, last = ''
    const loop = () => {
      const chart = chartRef.current, s = seriesRef.current as { priceToCoordinate: (p: number) => number | null } | null
      if (chart && s && host) {
        let sig = `${host.clientWidth}x${host.clientHeight}|${version}|${dRef.current.length}|${selRef.current}|${hiddenRef.current}|${draftRef.current ? 'd' + placedRef.current : ''}`
        try { sig += `|${chart.timeScale().logicalToCoordinate(0 as Logical)}|${chart.timeScale().logicalToCoordinate(100 as Logical)}|${s.priceToCoordinate(1)}|${s.priceToCoordinate(1.01)}|${s.priceToCoordinate(1000)}` } catch { /* chart rebuilding */ }
        if (sig !== last) { last = sig; paint() }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [chartRef, seriesRef, host, paint, version])

  // ---- mouse handling: capture on the chart host, only when drawing or on a drawing ----
  useEffect(() => {
    if (!host) return
    let intercept = false
    const rel = (e: PointerEvent | MouseEvent) => { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    const inPlot = (x: number, y: number) => { const pl = plot(); return x >= 0 && y >= 0 && x <= pl.w && y <= pl.h }
    const finish = (d: Drawing) => { pushUndo(); setDrawings((prev) => [...prev, d]); setSelId(d.id); draftRef.current = null; placedRef.current = 0; setTool('cursor'); setVersion((v) => v + 1) }
    const follow = (draft: Drawing, pt: Pt) => { for (let i = placedRef.current; i < draft.pts.length; i++) draft.pts[i] = pt; setVersion((v) => v + 1) }
    const down = (e: PointerEvent) => {
      intercept = false
      if (!openRef.current || e.button !== 0) return
      const { x, y } = rel(e)
      if (!inPlot(x, y)) return
      const tl = toolRef.current
      if (tl !== 'cursor') {
        const pt = fromPx(x, y, true); if (!pt) return
        intercept = true
        const draft = draftRef.current
        if (draft) { // a later click of a click-click draw
          draft.pts[placedRef.current] = pt; placedRef.current++
          if (placedRef.current >= NEED[draft.type]) finish({ ...draft, pts: draft.pts.map((p) => ({ ...p })) }); else follow(draft, pt)
          return
        }
        const n = NEED[tl]
        const base: Drawing = { id: uid(), type: tl, pts: Array.from({ length: n }, () => pt), color: SWATCHES[0], width: tl === 'text' ? 2 : 1.5, dash: false, fill: tl === 'rect' ? 0.12 : tl === 'fib' ? 0.06 : tl === 'channel' ? 0.08 : 0, ext: tl === 'fib' }
        if (tl === 'fib') base.color = '#f59e0b'
        if (tl === 'text') { base.text = 'note'; finish(base); return }
        if (n === 1) { finish(base); return }
        draftRef.current = base; placedRef.current = 1
        dragRef.current = { kind: 'draw', id: base.id, sx: x, sy: y, orig: [], idx: 1, moved: false }
        return
      }
      const h = hitTest(x, y)
      if (h) {
        intercept = true
        setSelId(h.id)
        const d = dRef.current.find((q) => q.id === h.id)!
        dragRef.current = { kind: h.handle >= 0 ? 'handle' : 'move', id: h.id, sx: x, sy: y, orig: d.pts.map((p) => ({ ...p })), idx: h.handle, moved: false }
      } else if (selRef.current) setSelId(null)
    }
    const stopIf = (e: Event) => { if (intercept) { e.stopPropagation(); e.preventDefault() } }
    const move = (e: PointerEvent) => {
      const { x, y } = rel(e)
      const dr = dragRef.current
      if (!dr) {
        if (openRef.current) host.style.cursor = toolRef.current !== 'cursor' ? 'crosshair' : hitTest(x, y) ? 'move' : ''
        else host.style.cursor = ''
        const draft = draftRef.current
        if (draft && toolRef.current !== 'cursor') { const pt = fromPx(x, y, true); if (pt) follow(draft, pt) }
        return
      }
      if (!dr.moved && Math.hypot(x - dr.sx, y - dr.sy) > 3) { dr.moved = true; if (dr.kind !== 'draw') pushUndo() }
      if (dr.kind === 'draw') {
        const pt = fromPx(x, y, true), draft = draftRef.current
        if (pt && draft) follow(draft, pt)
        return
      }
      if (!dr.moved) return
      const dx = x - dr.sx, dy = y - dr.sy
      setDrawings((prev) => prev.map((d) => {
        if (d.id !== dr.id) return d
        const pts = d.pts.map((p, i) => {
          if (dr.kind === 'handle' && i !== dr.idx) return p
          const o = toPx(dr.orig[i]); if (!o) return p
          return fromPx(o.x + dx, o.y + dy, dr.kind === 'handle') ?? p
        })
        return { ...d, pts }
      }))
    }
    const up = () => {
      const dr = dragRef.current
      if (!dr) return
      if (dr.kind === 'draw') {
        const draft = draftRef.current
        if (draft && dr.moved) { // drag-to-draw: the second point is where the drag ended
          placedRef.current = 2
          if (NEED[draft.type] <= 2) finish({ ...draft, pts: draft.pts.map((p) => ({ ...p })) }); else follow(draft, draft.pts[1])
        }
        // a plain click keeps the draft alive; the NEXT click places the next point
      }
      dragRef.current = null
      intercept = false
    }
    host.addEventListener('pointerdown', down, true)
    host.addEventListener('mousedown', stopIf, true)
    host.addEventListener('touchstart', stopIf, { capture: true, passive: false })
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      host.removeEventListener('pointerdown', down, true)
      host.removeEventListener('mousedown', stopIf, true)
      host.removeEventListener('touchstart', stopIf, true)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      host.style.cursor = ''
    }
  }, [host, plot, fromPx, toPx, hitTest, pushUndo])

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (!openRef.current) return
      if (e.key === 'Escape') { draftRef.current = null; placedRef.current = 0; dragRef.current = null; setTool('cursor'); setSelId(null); setVersion((v) => v + 1) }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo() }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current) { const id = selRef.current; pushUndo(); setDrawings((p) => p.filter((d) => d.id !== id)); setSelId(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, pushUndo])

  useEffect(() => { if (!open) { draftRef.current = null; placedRef.current = 0; setTool('cursor') } }, [open])

  const sel = drawings.find((d) => d.id === selId) ?? null
  const patch = (p: Partial<Drawing>) => {
    if (Date.now() - lastPatchPush.current > 700) { pushUndo(); lastPatchPush.current = Date.now() }
    setDrawings((prev) => prev.map((d) => (d.id === selId ? { ...d, ...p } : d)))
  }
  const top = host?.offsetTop ?? 0, left = host?.offsetLeft ?? 0
  const btn = 'h-6 w-8 rounded border text-[8px] font-bold leading-none'

  return (
    <>
      <canvas ref={canvasRef} className="pointer-events-none absolute z-[4]" style={{ position: 'absolute', top, left, zIndex: 4, pointerEvents: 'none' }} />
      {open && (
        <div className="absolute z-20 flex flex-col gap-0.5 rounded border border-[#1c2739] bg-[#0b111c]/95 p-0.5 font-mono" style={{ top: top + 6, left: left + 6 }}>
          {TOOLS.map((t) => (
            <button key={t.id} title={t.title} onClick={() => { draftRef.current = null; placedRef.current = 0; setTool(t.id) }}
              className={`${btn} ${tool === t.id ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300' : 'border-transparent text-[#9fb0cc] hover:border-cyan-500/40'}`}>{t.label}</button>
          ))}
          <div className="my-0.5 h-px bg-[#1c2739]" />
          <button title="Magnet: snap new points and handles to a candle's open / high / low / close when close to one" onClick={() => setMagnet((v) => !v)} className={`${btn} ${magnet ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300' : 'border-transparent text-[#9fb0cc] hover:border-cyan-500/40'}`}>MAG</button>
          <button title="Undo (Ctrl+Z)" onClick={undo} className={`${btn} border-transparent text-[#9fb0cc] hover:border-cyan-500/40`}>UND</button>
          <button title="Redo (Ctrl+Shift+Z / Ctrl+Y)" onClick={redo} className={`${btn} border-transparent text-[#9fb0cc] hover:border-cyan-500/40`}>RED</button>
          <button title={hidden ? 'Show drawings' : 'Hide drawings'} onClick={() => setHidden((v) => !v)} className={`${btn} ${hidden ? 'border-amber-500/60 text-amber-300' : 'border-transparent text-[#9fb0cc] hover:border-cyan-500/40'}`}>{hidden ? 'SHOW' : 'HIDE'}</button>
          <button title="Delete every drawing on this asset (undo brings them back)" onClick={() => { if (drawings.length && window.confirm(`Delete all ${drawings.length} drawings on ${asset}?`)) { pushUndo(); setDrawings([]); setSelId(null) } }} className={`${btn} border-transparent text-rose-300 hover:border-rose-500/40`}>CLR</button>
        </div>
      )}
      {open && sel && (
        <div className="absolute z-20 w-44 space-y-1.5 rounded border border-[#1c2739] bg-[#0b111c]/95 p-2 font-mono text-[9px] text-[#9fb0cc]" style={{ top: top + 6, left: left + 52 }}>
          <div className="flex items-center justify-between text-cyan-300"><span>{TOOLS.find((t) => t.id === sel.type)?.title.split(' - ')[0]}</span>
            <button onClick={() => { pushUndo(); setDrawings((p) => p.filter((d) => d.id !== sel.id)); setSelId(null) }} className="rounded border border-rose-500/40 px-1 text-rose-300 hover:bg-rose-500/10" title="Delete (Del)">delete</button></div>
          <div className="flex flex-wrap items-center gap-1">
            {SWATCHES.map((c) => <button key={c} onClick={() => patch({ color: c })} title={c} className={`h-4 w-4 rounded-sm border ${sel.color === c ? 'border-white' : 'border-[#1c2739]'}`} style={{ background: c }} />)}
            <input type="color" value={/^#[0-9a-f]{6}$/i.test(sel.color) ? sel.color : '#38bdf8'} onChange={(e) => patch({ color: e.target.value })} className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0" title="Any colour" />
          </div>
          <label className="flex items-center justify-between">{sel.type === 'text' ? 'size' : 'width'}
            <input type="range" min={1} max={5} step={0.5} value={sel.width} onChange={(e) => patch({ width: Number(e.target.value) })} className="w-20" /></label>
          {sel.type !== 'text' && sel.type !== 'arrow' && (
            <label className="flex items-center justify-between">dashed<input type="checkbox" checked={sel.dash} onChange={(e) => patch({ dash: e.target.checked })} /></label>
          )}
          {(sel.type === 'trend' || sel.type === 'channel' || sel.type === 'fib') && (
            <label className="flex items-center justify-between" title="Keep the lines going to the right edge so they still follow price after the chart has moved past them">extend right<input type="checkbox" checked={sel.ext} onChange={(e) => patch({ ext: e.target.checked })} /></label>
          )}
          {(sel.type === 'rect' || sel.type === 'fib' || sel.type === 'channel') && (
            <label className="flex items-center justify-between">fill
              <input type="range" min={0} max={0.5} step={0.02} value={sel.fill} onChange={(e) => patch({ fill: Number(e.target.value) })} className="w-20" /></label>
          )}
          {sel.type === 'text' && (
            <input type="text" value={sel.text ?? ''} onChange={(e) => patch({ text: e.target.value.slice(0, 80) })} className="w-full rounded border border-[#1c2739] bg-[#0d1420] px-1 py-0.5 text-[#d6e2f5]" placeholder="note..." />
          )}
          <button onClick={() => { pushUndo(); const c = { ...sel, id: uid(), pts: sel.pts.map((p) => ({ t: p.t + spRef.current * 3, p: p.p })) }; setDrawings((p) => [...p, c]); setSelId(c.id) }} className="w-full rounded border border-[#1c2739] py-0.5 hover:border-cyan-500/40">duplicate</button>
        </div>
      )}
      {open && tool !== 'cursor' && (
        <div className="pointer-events-none absolute z-20 rounded border border-cyan-500/40 bg-[#0b111c]/90 px-1.5 py-0.5 font-mono text-[9px] text-cyan-300" style={{ top: top + 6, left: left + (sel ? 232 : 52) }}>
          {TOOLS.find((t) => t.id === tool)?.title} · Esc cancels
        </div>
      )}
    </>
  )
}
