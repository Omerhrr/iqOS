'use client'

// IQAIR//OS - Market watch list
import type { AssetRow } from '@/lib/os/client'
import { fmtPrice } from '@/lib/os/client'

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
  return (
    <div className="flex h-full flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex items-center justify-between border-b border-[#1c2739] px-3 py-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Market Watch</h3>
        <span className="flex items-center gap-1 text-[9px] font-mono text-emerald-400">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </span>
          LIVE SIM
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {assets.map((a) => {
          const p = prices[a.ticker] ?? { price: a.price, dir: 0 }
          const isActive = a.ticker === active
          return (
            <button
              key={a.ticker}
              onClick={() => onSelect(a.ticker)}
              className={`flex w-full items-center justify-between border-l-2 px-3 py-2 text-left transition-colors ${
                isActive ? 'border-cyan-400 bg-[#101828]' : 'border-transparent hover:bg-[#0e1626]'
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`text-[12px] font-semibold ${isActive ? 'text-cyan-300' : 'text-[#dbe4f0]'}`}>{a.ticker}</span>
                  <span className="rounded px-1 text-[8px] font-mono uppercase" style={{ color: CAT_COLOR[a.category], background: `${CAT_COLOR[a.category]}14` }}>
                    {a.category}
                  </span>
                </div>
                <div className="truncate text-[9px] text-[#4b5a72]">payout {(a.payout * 100).toFixed(0)}%</div>
              </div>
              <div className={`text-right font-mono text-[12px] ${p.dir > 0 ? 'text-emerald-400' : p.dir < 0 ? 'text-rose-400' : 'text-[#aab6cc]'}`}>
                {fmtPrice(p.price, a.ticker)}
                <div className={`text-[9px] ${p.dir > 0 ? 'text-emerald-500' : p.dir < 0 ? 'text-rose-500' : 'text-[#2a3a52]'}`}>
                  {p.dir > 0 ? '▲' : p.dir < 0 ? '▼' : '—'}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
