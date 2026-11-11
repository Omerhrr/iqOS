'use client'

// IQAIR//OS - searchable chart-type combobox, same filter-as-you-type
// widget AssetPicker.tsx already established for the pair dropdown (type
// to filter, arrow keys + Enter to pick, Escape/outside-click to close) -
// the chart-type <select> in MenuBar.tsx needed the same treatment once
// CHART_TYPES (client.ts) grew past 30 entries (renko/kagi/kagiOverlay/
// spring/echo/expiryRadar/... - a plain alphabetical-by-insertion <select>
// makes finding one of these by scrolling genuinely slow).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChartType } from '@/lib/os/client'

export default function ChartTypePicker({
  types,
  value,
  onChange,
  className,
}: {
  types: { id: ChartType; label: string }[]
  value: ChartType
  onChange: (t: ChartType) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return types
    return types.filter((t) => t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
  }, [types, query])

  const current = types.find((t) => t.id === value)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlight(0)
    }
  }, [open])

  const pick = (t: ChartType) => {
    onChange(t)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={`relative ${className ?? 'w-40'}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Chart type"
        className="flex h-8 w-full items-center justify-between rounded border border-[#1c2739] bg-[#0d1420] px-2 font-mono text-[11px] uppercase tracking-wider text-[#aab6cc] outline-none focus:border-cyan-500/50"
      >
        <span className="truncate">{current?.label ?? value}</span>
        <span className="ml-1 shrink-0 text-[#4b5a72]">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+2px)] z-20 w-56 rounded border border-[#1c2739] bg-[#0b111c] shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setHighlight((h) => Math.min(h + 1, filtered.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setHighlight((h) => Math.max(h - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (filtered[highlight]) pick(filtered[highlight].id)
              } else if (e.key === 'Escape') {
                setOpen(false)
              }
            }}
            placeholder="Search chart types…"
            className="w-full border-b border-[#1c2739] bg-[#101828] px-2 py-1.5 font-mono text-[11px] normal-case text-[#dbe4f0] outline-none"
          />
          <div className="max-h-72 overflow-auto py-1">
            {filtered.length === 0 && <div className="px-2 py-1.5 font-mono text-[11px] normal-case text-[#4b5a72]">No matches</div>}
            {filtered.map((t, i) => (
              <div
                key={t.id}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(t.id)}
                className={`cursor-pointer px-2 py-1.5 font-mono text-[11px] normal-case ${i === highlight ? 'bg-[#1c2739] text-[#dbe4f0]' : 'text-[#9aa8bd]'} ${t.id === value ? 'border-l-2 border-cyan-400' : ''}`}
              >
                {t.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
