'use client'

// IQAIR//OS - Market watch: full instrument universe with category tabs + search
import { useMemo, useState } from 'react'
import type { AssetRow } from '@/lib/os/client'
import { CATEGORIES, fmtPrice } from '@/lib/os/client'

interface Props {
  assets: AssetRow[]
  active: string
  prices: Record<string, { price: number; dir: number }>
  onSelect: (ticker: string) => void
}

const CAT_COLOR: Record<AssetRow['category'], string> = {
  forex: '#38bdf8',
  crypto: '#f59e0b',
  commodity: '#e879f9',
  stock: '#10b981',
  index: '#a78bfa',
}

export default function MarketWatch({ assets, active, prices, onSelect }: Props) {
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]['id']>('all')
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return assets.filter((a) => {
      if (cat !== 'all') {
        if (cat === 'otc' && !a.otc) return false
        if (cat !== 'otc' && a.category !== cat) return false
      }
      if (q && !a.ticker.toLowerCase().includes(q) && !a.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [assets, cat, query])

  return (
    <div className="flex h-full flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex items-center justify-between border-b border-[#1c2739] px-3 py-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Market Watch</h3>
        <span className="flex items-center gap-1 text-[9px] font-mono text-emerald-400">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </span>
          {assets.length} SYMBOLS
        </span>
      </div>

      {/* search */}
      <div className="px-2 pt-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search 115+ instruments…"
          className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1.5 font-mono text-[11px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-cyan-500/50"
        />
      </div>

      {/* category tabs */}
      <div className="flex flex-wrap gap-1 px-2 py-2">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCat(c.id)}
            className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition-colors ${
              cat === c.id ? 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/40' : 'bg-[#101828] text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.map((a) => {
          const p = prices[a.ticker] ?? { price: a.price, dir: 0 }
          const isActive = a.ticker === active
          return (
            <button
              key={a.ticker}
              onClick={() => onSelect(a.ticker)}
              className={`flex w-full items-center justify-between border-l-2 px-3 py-1.5 text-left transition-colors ${
                isActive ? 'border-cyan-400 bg-[#101828]' : 'border-transparent hover:bg-[#0e1626]'
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`text-[12px] font-semibold ${isActive ? 'text-cyan-300' : 'text-[#dbe4f0]'}`}>{a.ticker}</span>
                  {a.otc && (
                    <span className="rounded bg-amber-500/15 px-1 text-[8px] font-bold text-amber-400">OTC</span>
                  )}
                  <span
                    className={`h-1 w-1 shrink-0 rounded-full ${a.open ? 'bg-emerald-400' : 'bg-[#3d4d66]'}`}
                    title={a.open ? 'market open' : 'market closed'}
                  />
                </div>
                <div className="truncate text-[9px] text-[#4b5a72]">
                  {(a.payout * 100).toFixed(0)}%{a.leverage ? ` · 1:${a.leverage}` : ''}
                </div>
              </div>
              <div className={`text-right font-mono text-[11px] ${p.dir > 0 ? 'text-emerald-400' : p.dir < 0 ? 'text-rose-400' : 'text-[#aab6cc]'}`}>
                {fmtPrice(p.price, a.ticker)}
                <div className={`text-[8px] ${p.dir > 0 ? 'text-emerald-500' : p.dir < 0 ? 'text-rose-500' : 'text-[#2a3a52]'}`}>
                  {p.dir > 0 ? '▲' : p.dir < 0 ? '▼' : '—'}
                </div>
              </div>
            </button>
          )
        })}
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center font-mono text-[10px] text-[#3d4d66]">no instruments match “{query}”</div>
        )}
      </div>
    </div>
  )
}
