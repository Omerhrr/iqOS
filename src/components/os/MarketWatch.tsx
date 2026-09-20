'use client'

// IQAIR//OS - Market watch: full instrument universe with category tabs + search
// The search is tuned for IQ Option ticker shapes: "EURUSD-OTC", "AAP:US",
// "BTCUSD", "GBPNZD-OTC". Dashes/colons/spaces/underscores are ignored, the
// -OTC suffix is optional (typing "eurusd otc" pins the OTC variant), partial
// typing matches via subsequence ("eurjp" -> EURJPY), and a small alias table
// maps common names to IQ tickers ("aapl"/"apple" -> AAP:US, "gold" -> XAUUSD).
import { useMemo, useState } from 'react'
import type { AssetRow } from '@/lib/os/client'
import { CATEGORIES, fmtPrice } from '@/lib/os/client'

interface Props {
  assets: AssetRow[]
  active: string
  prices: Record<string, { price: number; dir: number }>
  onSelect: (ticker: string) => void
}

// common names -> IQ ticker fragments (search only, display stays verbatim)
const IQ_ALIASES: Record<string, string> = {
  aapl: 'AAP', apple: 'AAP',
  msft: 'MSFT', microsoft: 'MSFT',
  tsla: 'TSLA', tesla: 'TSLA',
  amzn: 'AMZN', amazon: 'AMZN',
  nvda: 'NVDA', nvidia: 'NVDA',
  googl: 'GOOGL', google: 'GOOGL', alphabet: 'GOOGL',
  meta: 'META', facebook: 'META',
  nflx: 'NFLX', netflix: 'NFLX',
  intel: 'INTC', amd: 'AMD', boeing: 'BA', mcdonalds: 'MCD',
  gold: 'XAU', xauusd: 'XAU', silver: 'XAG', xagusd: 'XAG',
  oil: 'OIL', crude: 'OIL', brent: 'BRN', gas: 'NG',
  btc: 'BTC', bitcoin: 'BTC', eth: 'ETH', ethereum: 'ETH',
}

const norm = (s: string) => s.toLowerCase().replace(/[-_:\s.]/g, '')

const subseq = (needle: string, hay: string): boolean => {
  if (!needle) return false
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++
  return i === needle.length
}

/** null = no match; otherwise lower = better (0 exact, 4 subsequence). */
function rankAsset(a: AssetRow, rawQuery: string): number | null {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return 9 // no query: keep list order, filtered out of sorting
  const wantsOtc = /\botc\b/.test(q)
  if (wantsOtc && !a.otc) return null
  const qBase = norm(q.replace(/\botc\b/g, ''))
  const tokens = new Set<string>()
  if (qBase) tokens.add(qBase)
  const alias = IQ_ALIASES[qBase]
  if (alias) tokens.add(norm(alias))
  if (!tokens.size) return wantsOtc ? 5 : null
  const tBase = norm(a.ticker.replace(/-OTC$/, ''))
  const tFull = norm(a.ticker)
  const nBase = norm(a.name)
  let best: number | null = null
  for (const cand of tokens) {
    let r: number | null = null
    if (tBase === cand || tFull === cand) r = 0
    else if (tBase.startsWith(cand) || tFull.startsWith(cand)) r = 1
    else if (nBase.startsWith(cand)) r = 2
    else if (tBase.includes(cand) || tFull.includes(cand) || nBase.includes(cand)) r = 3
    else if (subseq(cand, tBase) || subseq(cand, nBase)) r = 4
    if (r !== null && (best === null || r < best)) best = r
  }
  return best
}

export default function MarketWatch({ assets, active, prices, onSelect }: Props) {
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]['id']>('all')
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const ranked: { a: AssetRow; rank: number }[] = []
    for (const a of assets) {
      if (cat !== 'all') {
        if (cat === 'otc' && !a.otc) continue
        if (cat !== 'otc' && a.category !== cat) continue
      }
      const rank = rankAsset(a, query)
      if (rank !== null) ranked.push({ a, rank })
    }
    // ranked best-match-first only while searching; natural order otherwise
    if (query.trim()) ranked.sort((x, y) => x.rank - y.rank || x.a.ticker.localeCompare(y.a.ticker))
    return ranked.map((r) => r.a)
  }, [assets, cat, query])

  const searching = query.trim().length > 0

  return (
    <div className="flex h-full flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex items-center justify-between border-b border-[#1c2739] px-3 py-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Market Watch</h3>
        <span className="flex items-center gap-1 text-[9px] font-mono text-emerald-400">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </span>
          {searching ? `${filtered.length} / ${assets.length} MATCH` : `${assets.length} SYMBOLS`}
        </span>
      </div>

      {/* search - IQ-ticker tuned */}
      <div className="px-2 pt-2">
        <div className="relative">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="Search… e.g. EURUSD-OTC, AAP:US"
            spellCheck={false}
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1.5 pr-6 font-mono text-[11px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-cyan-500/50"
          />
          {searching && (
            <button
              onClick={() => setQuery('')}
              title="clear"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 text-[11px] leading-none text-[#4b5a72] hover:text-[#e2e8f0]"
            >
              ×
            </button>
          )}
        </div>
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
          const hotPayout = a.payout !== null && a.payout !== undefined && a.payout >= 0.9
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
                <div className={`truncate text-[9px] ${hotPayout ? 'text-emerald-500/80' : 'text-[#4b5a72]'}`}>
                  {/* REAL per-instrument payout; dash when the account doesn't report one */}
                  {a.payout !== null && a.payout !== undefined ? `${(a.payout * 100).toFixed(0)}%` : '—'}
                  {a.leverage ? ` · 1:${a.leverage}` : ''}
                </div>
              </div>
              <div className={`text-right font-mono text-[11px] ${p.dir > 0 ? 'text-emerald-400' : p.dir < 0 ? 'text-rose-400' : 'text-[#aab6cc]'}`}>
                {/* IQ mode: only polled pairs (opened ones) have a live tick */}
                {p.price > 0 ? fmtPrice(p.price, a.ticker) : '—'}
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
