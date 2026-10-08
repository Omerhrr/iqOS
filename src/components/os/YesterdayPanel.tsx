'use client'

// IQAIR//OS - Yesterday @ Now sidebar. Answers one question per open
// instrument: "what was the market DOING at this exact time yesterday - and
// in the window right after?" Each row replays the forward window that
// started at T-24h: net move, high-low travel, best excursion above/below
// the moment's price (the shape bar), where price has gone since (then ->
// now), and the session the market was in at the time. The lookback runs on
// the CHART's active timeframe (the tf chip shows what the kernel actually
// used - same respect rule as the Chart Signals scan) and the window chips
// pick how much of "after" to replay (kernel snaps the window to whole bars
// and echoes the effective one). Coverage is never implied: bars found vs
// expected and the archived fraction (kernel's own accumulated store vs the
// deterministic prehistory) ride on every row, and rows whose window is
// under half covered are dropped kernel-side instead of reporting a move
// computed from a fraction of the story.
import { useCallback, useEffect, useState } from 'react'
import type { Timeframe, YesterdayRow } from '@/lib/os/client'
import { TIMEFRAME_SECONDS, fmtPrice, getYesterday } from '@/lib/os/client'

interface YesterdayPanelProps {
  onClose: () => void
  /** the chart's active timeframe - the 24h lookback replays on these candles */
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
}

type Mkt = 'all' | 'real' | 'otc'
type Cat = 'all' | 'forex' | 'crypto' | 'commodity' | 'stock' | 'index'
type Sort = 'move' | 'since' | 'range'
type DirFilter = 'all' | 'up' | 'down' | 'none'

const WINDOWS: [number, string][] = [
  [15, '15m'],
  [30, '30m'],
  [60, '1h'],
  [120, '2h'],
]

const SESSION_LABEL: Record<YesterdayRow['session'], string> = {
  ASIA: 'Asia',
  LONDON: 'London',
  OVERLAP: 'Lon/NY',
  NEWYORK: 'NY',
  OFF: 'off-hours',
  OTC: 'OTC',
}

function DirChip({ dir }: { dir: YesterdayRow['dir'] }) {
  const map = {
    up: 'bg-emerald-500/20 text-emerald-300',
    down: 'bg-rose-500/20 text-rose-300',
    none: 'bg-[#1c2739] text-[#7c8aa5]',
  } as const
  const glyph = { up: '▲', down: '▼', none: '—' } as const
  const word = { up: 'up', down: 'down', none: 'flat' } as const
  return (
    <span className={`rounded px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-wider ${map[dir]}`}>
      {glyph[dir]} {word[dir]}
    </span>
  )
}

/** The window's shape: split bar of best excursion above (green) vs below
 * (red) the moment's price - how the hour actually traveled. */
function ShapeBar({ r }: { r: YesterdayRow }) {
  const up = r.runUpPct
  const down = r.drawdownPct
  const total = up + down
  const upW = total > 0 ? (up / total) * 100 : 50
  return (
    <div
      className="flex h-1 w-full overflow-hidden rounded bg-[#101828]"
      title={`window shape: ran +${up.toFixed(3)}% above ${fmtPrice(r.thenPrice, r.asset)}, dipped -${down.toFixed(3)}% below (range ${(r.rangePct ?? 0).toFixed(3)}%)`}
    >
      <div className="h-full bg-emerald-500" style={{ width: `${upW}%` }} />
      <div className="h-full bg-rose-500" style={{ width: `${100 - upW}%` }} />
    </div>
  )
}

function RowCard({ r, onSelectAsset, windowMin }: { r: YesterdayRow; onSelectAsset?: (a: string) => void; windowMin: number }) {
  const thenClock = new Date(r.thenTs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const cov = r.barsExpected > 0 ? Math.round((r.barsFound / r.barsExpected) * 100) : 0
  const partial = cov < 100
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(r.asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(r.asset)
      }}
      className="w-full cursor-pointer rounded-lg border border-[#1c2739] bg-[#0b111c] p-2 text-left transition-colors hover:border-violet-500/40"
      title={`open ${r.asset} on the chart - window started ${thenClock} yesterday (${r.barsFound}/${r.barsExpected} bars)`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <DirChip dir={r.dir} />
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{r.asset}</span>
        {r.otc && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400">otc</span>
        )}
        <span
          className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] uppercase tracking-wide text-[#7c8aa5]"
          title="the session the market was in at that moment yesterday"
        >
          {SESSION_LABEL[r.session]}
        </span>
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">{thenClock} · {windowMin}m</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2 font-mono text-[9px]">
        <span className="text-[#4b5a72]">then</span>
        <span className="text-[#aab6cc]">{fmtPrice(r.thenPrice, r.asset)}</span>
        <span className="text-[#3d4d66]">→</span>
        <span className="text-[#4b5a72]">now</span>
        <span className="text-[#aab6cc]">{fmtPrice(r.nowPrice, r.asset)}</span>
        <span className={`ml-auto ${r.sincePct >= 0 ? 'text-emerald-300/80' : 'text-rose-300/80'}`} title="where the market has gone since that moment yesterday">
          since {r.sincePct >= 0 ? '+' : ''}{r.sincePct.toFixed(2)}%
        </span>
      </div>
      <div className="mt-1.5">
        <ShapeBar r={r} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px]">
        <span
          className={r.dir === 'up' ? 'text-emerald-300' : r.dir === 'down' ? 'text-rose-300' : 'text-[#7c8aa5]'}
          title="net move over the window that started at that moment yesterday"
        >
          {r.movePct >= 0 ? '+' : ''}{r.movePct.toFixed(2)}% move
        </span>
        <span className="text-[#7c8aa5]" title="high-low travel across the window">
          {r.rangePct.toFixed(2)}% range
        </span>
        <span
          className={`ml-auto ${partial ? 'text-amber-400/80' : 'text-[#4b5a72]'}`}
          title={
            partial
              ? `partial window: ${r.barsFound} of ${r.barsExpected} bars present (${cov}%) - market may have been dark part of the window`
              : `${r.barsFound}/${r.barsExpected} bars present`
          }
        >
          {r.barsFound}/{r.barsExpected} bars
        </span>
        <span
          className={r.archived > 0 ? 'text-[#4b5a72]' : 'text-[#3d4d66]'}
          title={
            r.archived > 0
              ? `${r.archived} of the window's bars come from the kernel's own accumulated store - the rest is the feed's deterministic prehistory`
              : "no accumulated store bars in this window - the story is the feed's deterministic prehistory, not a remembered market"
          }
        >
          {r.archived > 0 ? `${r.archived} arch` : 'seeded'}
        </span>
      </div>
    </div>
  )
}

export default function YesterdayPanel({ onClose, tf, onSelectAsset }: YesterdayPanelProps) {
  const [windowMin, setWindowMin] = useState(60)
  const [mkt, setMkt] = useState<Mkt>('all')
  const [cat, setCat] = useState<Cat>('all')
  const [dirF, setDirF] = useState<DirFilter>('all')
  const [sort, setSort] = useState<Sort>('move')
  const [query, setQuery] = useState('')
  const [data, setData] = useState<Awaited<ReturnType<typeof getYesterday>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // the 24h lookback cannot fit the archive depth below 30s candles - say so
  // instead of round-tripping a 400 the operator can't act on
  const tfSupported = TIMEFRAME_SECONDS[tf] >= 30

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!tfSupported) return
      if (!opts?.quiet) setBusy(true)
      getYesterday(tf, windowMin)
        .then((d) => {
          if (d?.ok) {
            setData(d)
            setError(null)
          }
        })
        .catch((e: Error) => setError(e.message.slice(0, 180)))
        .finally(() => setBusy(false))
    },
    [tf, windowMin, tfSupported],
  )

  useEffect(() => {
    load()
    // the kernel caches each tf:window scan for 60s (the T-24h target crawls
    // forward one second per second) - a 15s poll always lands on a warm scan
    const iv = setInterval(() => load({ quiet: true }), 15_000)
    return () => clearInterval(iv)
  }, [load])

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(iv)
  }, [])

  const needle = query.trim().toLowerCase()
  const rows = (data?.rows ?? [])
    .filter((r) => (mkt === 'all' ? true : mkt === 'otc' ? r.otc : !r.otc))
    .filter((r) => (cat === 'all' ? true : r.category === cat))
    .filter((r) => (dirF === 'all' ? true : r.dir === dirF))
    .filter((r) => (!needle ? true : r.asset.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)))
    .sort((a, b) =>
      sort === 'move'
        ? Math.abs(b.movePct) - Math.abs(a.movePct)
        : sort === 'since'
          ? Math.abs(b.sincePct) - Math.abs(a.sincePct)
          : b.rangePct - a.rangePct,
    )
  const otcLive = (data?.rows ?? []).filter((r) => r.otc).length
  const catCount = (c: Cat) => (c === 'all' ? (data?.rows ?? []).length : (data?.rows ?? []).filter((r) => r.category === c).length)
  const ageSec = data ? Math.max(0, Math.round((now - data.ts) / 1000)) : 0

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1 border-b border-[#1c2739] px-2 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-violet-300">Yesterday @ Now</span>
        <span
          className="rounded border border-violet-500/40 bg-violet-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-violet-300"
          title="the 24h lookback is computed on the chart's current timeframe - switch the chart's tf and the story is rebuilt on those candles"
        >
          {data?.tf ?? tf}
        </span>
        <span
          className={`rounded border px-1 py-px font-mono text-[8px] font-bold uppercase ${
            data?.mode === 'live' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-[#1c2739] text-[#7c8aa5]'
          }`}
          title={
            data?.mode === 'live'
              ? 'live broker feed - window bars are accumulated market data (plus deterministic fill where history is thin)'
              : 'sim feed - the whole story is the deterministic sim engine, not a remembered market'
          }
        >
          {data?.mode ?? '—'}
        </span>
        <span className="mx-0.5 h-3 w-px bg-[#1c2739]" />
        {WINDOWS.map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setWindowMin(m)}
            className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
              windowMin === m ? 'bg-violet-500/15 text-violet-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
            title={`replay the ${label} window that started at this time yesterday (kernel snaps it to whole bars of the tf)`}
          >
            {label}
          </button>
        ))}
        {data && (
          <span
            className="ml-auto font-mono text-[8px] text-[#4b5a72]"
            title="instruments scanned / rows with enough window coverage · skipped (thin history) · scan age · scan duration"
          >
            {data.considered}/{data.scanned} rows · {data.skipped} skip · {ageSec}s · {data.scanMs}ms
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          title="close the yesterday sidebar (market watch + indicators return)"
          className="ml-1 flex h-5 w-5 items-center justify-center rounded border border-[#1c2739] font-mono text-[11px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
        >
          ×
        </button>
      </div>

      {/* search + market/class filters - same composition as the signals panel */}
      <div className="flex items-center gap-1 border-b border-[#1c2739] px-2 py-1">
        <div className="relative min-w-0 flex-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="search… e.g. EURUSD-OTC, gold"
            spellCheck={false}
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1 pr-6 font-mono text-[10px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-violet-500/50"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              title="clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 font-mono text-[10px] text-[#4b5a72] hover:text-rose-300"
            >
              ×
            </button>
          )}
        </div>
        {(
          [
            ['all', 'All'],
            ['real', 'Real'],
            ['otc', 'OTC'],
          ] as [Mkt, string][]
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMkt(m)}
            className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
              mkt === m
                ? m === 'otc'
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-violet-500/15 text-violet-300'
                : m === 'otc' && otcLive > 0
                  ? 'text-amber-400/70 hover:text-amber-300'
                  : 'text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
            title={m === 'otc' ? "only the over-the-counter pairs' yesterday stories" : m === 'real' ? 'only real-market instruments' : 'every open instrument'}
          >
            {label}
            {m === 'otc' && otcLive > 0 && ` ${otcLive}`}
          </button>
        ))}
        {(
          [
            ['all', 'All', 'every asset class'],
            ['forex', 'FX', 'currency pairs (incl. their OTC twins)'],
            ['crypto', 'Crypto', 'crypto pairs - 24/7 real markets'],
            ['commodity', 'Comm', 'metals, energy, agriculture'],
            ['stock', 'Stocks', 'single-name equities'],
            ['index', 'Idx', 'index CFDs'],
          ] as [Cat, string, string][]
        ).map(([c, label, why]) => {
          const n = catCount(c)
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
                cat === c ? 'bg-violet-500/15 text-violet-300' : n > 0 ? 'text-[#7c8aa5] hover:text-[#aab6cc]' : 'text-[#3d4d66]'
              }`}
              title={`${why} · ${n} yesterday row${n === 1 ? '' : 's'} in class`}
            >
              {label}
              {n > 0 && ` ${n}`}
            </button>
          )
        })}
      </div>

      {/* direction filter + sort - "show me what pumped at this hour" */}
      <div className="flex items-center gap-2 border-b border-[#1c2739] px-2 py-1">
        <div className="flex shrink-0 overflow-hidden rounded border border-[#1c2739]" role="group" aria-label="direction filter">
          {(
            [
              ['all', 'all', 'every direction'],
              ['up', 'up', "rows whose window moved up at this time yesterday"],
              ['down', 'down', "rows whose window moved down at this time yesterday"],
              ['none', 'flat', 'rows whose window went nowhere (net move under 10% of its own range)'],
            ] as [DirFilter, string, string][]
          ).map(([v, label, why]) => (
            <button
              key={v}
              type="button"
              onClick={() => setDirF(v)}
              title={why}
              className={`px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-wider transition-colors ${
                dirF === v ? 'bg-violet-500/15 text-violet-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 overflow-hidden rounded border border-[#1c2739]" role="group" aria-label="sort order">
          {(
            [
              ['move', 'move', 'biggest yesterday-window move first (kernel order)'],
              ['since', 'since', 'biggest 24h drift first - where the market has gone since that moment'],
              ['range', 'range', 'widest high-low travel in the window first - the most restless hours'],
            ] as [Sort, string, string][]
          ).map(([v, label, why]) => (
            <button
              key={v}
              type="button"
              onClick={() => setSort(v)}
              title={why}
              className={`px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-wider transition-colors ${
                sort === v ? 'bg-violet-500/15 text-violet-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && !tfSupported && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            The 24h lookback cannot fit the archive depth on {tf} candles (a day of {tf} bars is far beyond the 4000-bar history) - switch the chart to 30s or coarser and the panel follows.
          </div>
        )}
        {!error && tfSupported && rows.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {data ? (
              (data.rows ?? []).length > 0 ? (
                `No rows match the current filter - ${data.rows.length} row${data.rows.length === 1 ? '' : 's'} scanned${mkt !== 'all' ? ` · market ${mkt.toUpperCase()}` : ''}${cat !== 'all' ? ` · class ${cat}` : ''}${dirF !== 'all' ? ` · direction ${dirF}` : ''}${needle ? ` · search "${query.trim()}"` : ''}. Clear the search or loosen the chips.`
              ) : (
                `${data.scanned} instruments scanned, none had enough window history - the T-24h story needs the series to reach back a full day (bars accumulate while the OS runs; the feed's deterministic prehistory fills the front once it does). Rows appear here automatically.`
              )
            ) : (
              'Replaying the window that started exactly 24h ago across the open universe...'
            )}
          </div>
        )}
        {rows.map((r) => (
          <RowCard key={r.asset} r={r} onSelectAsset={onSelectAsset} windowMin={data?.windowMin ?? windowMin} />
        ))}
        {data && data.rows.length > 0 && (
          <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
            Each row is the window that started at the bar forming exactly 24h ago, on the chart's timeframe. dir counts as up/down only when the net move exceeds 10% of the window's own travel. "arch" = bars from the kernel's accumulated store (broker bars in live mode), "seeded" = the feed's deterministic prehistory - never mistake a seeded yesterday for a remembered one. Click a card to open that asset on the chart.
          </p>
        )}
      </div>
    </div>
  )
}
