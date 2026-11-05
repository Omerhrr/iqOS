'use client'

// IQAIR//OS - searchable pair combobox, extracted out of AILabPanel.tsx so
// every panel with a long asset dropdown (AI Lab, AI Trader, and anywhere
// else that grows one later) shares the SAME filter-as-you-type widget
// instead of each rolling its own plain <select> through 60+ alphabetical
// pairs. Behavior unchanged from the original: type to filter, arrow keys +
// Enter to pick, Escape or an outside click to close.
import { useEffect, useMemo, useRef, useState } from 'react'

export default function AssetPicker({
  tickers,
  value,
  onChange,
  className,
}: {
  tickers: string[]
  value: string
  onChange: (t: string) => void
  /** Width/sizing override - callers vary (AI Lab's compact strip vs AI
   * Trader's grid cell), default matches the original w-28. */
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tickers
    return tickers.filter((t) => t.toLowerCase().includes(q))
  }, [tickers, query])

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

  const pick = (t: string) => {
    onChange(t)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={`relative ${className ?? 'w-28'}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center justify-between rounded border border-[#1c2739] bg-[#101828] px-2 text-left font-mono text-[11px] text-[#dbe4f0]"
      >
        <span className="truncate">{value}</span>
        <span className="ml-1 shrink-0 text-[#4b5a72]">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+2px)] z-20 w-48 rounded border border-[#1c2739] bg-[#0b111c] shadow-lg">
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
                if (filtered[highlight]) pick(filtered[highlight])
              } else if (e.key === 'Escape') {
                setOpen(false)
              }
            }}
            placeholder="Search pairs…"
            className="w-full border-b border-[#1c2739] bg-[#101828] px-2 py-1.5 font-mono text-[11px] text-[#dbe4f0] outline-none"
          />
          <div className="max-h-64 overflow-auto py-1">
            {filtered.length === 0 && <div className="px-2 py-1.5 font-mono text-[11px] text-[#4b5a72]">No matches</div>}
            {filtered.map((t, i) => (
              <div
                key={t}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(t)}
                className={`cursor-pointer px-2 py-1.5 font-mono text-[11px] ${i === highlight ? 'bg-[#1c2739] text-[#dbe4f0]' : 'text-[#9aa8bd]'} ${t === value ? 'border-l-2 border-cyan-400' : ''}`}
              >
                {t}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
