'use client'

// IQAIR//OS - Regime tab
// Every open pair on ONE timeframe, sorted into four ranked lists: trending UP,
// trending DOWN, RANGING, and NOISE (whatever is left). The scores only rank
// pairs inside their own list. Every read is descriptive of the last 40 closed
// candles - it is not a forecast, and a regime can flip on the next bar.
// Backed by /regime_scan (plugins/regimescan.ts). Click a row to load that pair
// and timeframe on the main chart.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RegimeBoard, RegimeBoardRow, Timeframe } from '@/lib/os/client'
import { fmtPrice, getRegimeScan } from '@/lib/os/client'

interface RegimePanelProps {
  closedTick?: number
  onPick?: (asset: string, tf: Timeframe) => void
}

const TFS: Timeframe[] = ['30s', '1m', '2m', '5m', '15m', '30m', '1h']
const POLL_MS = 10_000
const STORAGE_KEY = 'iqos.regime.tf.v1'

type ColId = 'up' | 'down' | 'ranging' | 'noise'

const COLS: { id: ColId; title: string; sub: string; tone: string; head: string; border: string; dot: string; arrow: string }[] = [
  { id: 'up', title: 'Trending up', sub: 'steady directional climb, ADX and slope agree', tone: 'text-emerald-300', head: 'bg-emerald-500/10', border: 'border-emerald-500/30', dot: 'bg-emerald-400', arrow: '▲' },
  { id: 'down', title: 'Trending down', sub: 'steady directional fall, ADX and slope agree', tone: 'text-rose-300', head: 'bg-rose-500/10', border: 'border-rose-500/30', dot: 'bg-rose-400', arrow: '▼' },
  { id: 'ranging', title: 'Ranging', sub: 'swinging inside a tested box, no direction', tone: 'text-sky-300', head: 'bg-sky-500/10', border: 'border-sky-500/30', dot: 'bg-sky-400', arrow: '↔' },
  { id: 'noise', title: 'Noise', sub: 'no direction and no box - everything else', tone: 'text-[#aab6cc]', head: 'bg-[#141d2e]', border: 'border-[#2a3750]', dot: 'bg-[#7c8aa5]', arrow: '≈' },
]

function Row({ r, col, tf, onPick }: { r: RegimeBoardRow; col: (typeof COLS)[number]; tf: Timeframe; onPick?: (a: string, t: Timeframe) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick?.(r.asset, tf)}
      title={`${r.name || r.asset}: ${r.reason}`}
      className="group flex w-full flex-col gap-0.5 rounded border border-[#141d2e] bg-[#080d16] px-1.5 py-1 text-left hover:border-[#3d4d66]"
    >
      <div className="flex items-center gap-1.5">
        <span className={`font-mono text-[10px] ${col.tone}`}>{col.arrow}</span>
        <span className="font-mono text-[10.5px] font-bold text-[#dbe4f0]">{r.asset}</span>
        {r.otc && <span className="rounded border border-amber-500/30 px-1 font-mono text-[7px] uppercase text-amber-300">otc</span>}
        <span className="ml-auto font-mono text-[8.5px] text-[#4b5a72]">{fmtPrice(r.price, r.asset)}</span>
        <span className={`rounded border px-1 font-mono text-[9px] font-bold ${col.tone} ${col.border}`} title="rank score inside this list - not a probability">
          {r.score}
        </span>
      </div>
      <div className="h-[3px] overflow-hidden rounded bg-[#141d2e]">
        <div className={`h-full ${col.dot}`} style={{ width: `${r.score}%` }} />
      </div>
      {col.id === 'ranging' ? (
        <div className="flex items-center gap-2 font-mono text-[8.5px] text-[#7c8aa5]">
          <span>{r.crossings}x crossed</span>
          <span>
            box {r.rangePct.toFixed(2)}% · {r.rangeAtr.toFixed(1)} ATR
          </span>
          <span className="ml-auto" title="where price sits in the box: 0 = bottom, 100 = top">
            at {Math.round(r.position * 100)}% of box
          </span>
        </div>
      ) : col.id === 'noise' ? (
        <div className="flex items-center gap-2 font-mono text-[8.5px] text-[#7c8aa5]">
          <span>eff {(r.er * 100).toFixed(0)}%</span>
          <span>flip {(r.flipRate * 100).toFixed(0)}%</span>
          <span>ADX {r.adx.toFixed(0)}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 font-mono text-[8.5px] text-[#7c8aa5]">
          <span>eff {(r.er * 100).toFixed(0)}%</span>
          <span>ADX {r.adx.toFixed(0)}</span>
          <span>t {r.tStat.toFixed(1)}</span>
          <span className="ml-auto">R² {(r.r2 * 100).toFixed(0)}%</span>
        </div>
      )}
    </button>
  )
}

export default function RegimePanel({ closedTick, onPick }: RegimePanelProps) {
  const [tf, setTf] = useState<Timeframe>('1m')
  const [board, setBoard] = useState<RegimeBoard | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [hideOtc, setHideOtc] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY)
      if (v && (TFS as string[]).includes(v)) setTf(v as Timeframe)
    } catch {
      /* ignore */
    }
  }, [])
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, tf)
    } catch {
      /* ignore */
    }
  }, [tf])

  const load = useCallback(async () => {
    try {
      const d = await getRegimeScan(tf)
      if (d.ok) {
        setBoard(d)
        setErr(null)
      } else {
        setErr(d.error)
      }
    } catch (e) {
      setErr((e as Error).message.slice(0, 160))
    } finally {
      setLoading(false)
    }
  }, [tf])

  // switching timeframe drops the old board so one tf's lists are never shown under another's label
  useEffect(() => {
    setBoard(null)
    setLoading(true)
  }, [tf])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick])

  const q = filter.trim().toUpperCase()
  const lists = useMemo(() => {
    const keep = (r: RegimeBoardRow) => (!hideOtc || !r.otc) && (!q || r.asset.includes(q))
    return {
      up: (board?.up ?? []).filter(keep),
      down: (board?.down ?? []).filter(keep),
      ranging: (board?.ranging ?? []).filter(keep),
      noise: (board?.noise ?? []).filter(keep),
    } as Record<ColId, RegimeBoardRow[]>
  }, [board, hideOtc, q])

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1c2739] px-2 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Regime</span>
        <div className="flex overflow-hidden rounded border border-[#1c2739]" role="group" aria-label="timeframe">
          {TFS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTf(t)}
              className={`px-1.5 py-0.5 font-mono text-[9px] uppercase ${tf === t ? 'bg-cyan-500/15 text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'}`}
            >
              {t}
            </button>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter pair…"
          className="h-5 w-24 rounded border border-[#1c2739] bg-[#070c15] px-1.5 font-mono text-[9px] text-[#dbe4f0] placeholder:text-[#4b5a72]"
        />
        <label className="flex cursor-pointer items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">
          <input type="checkbox" checked={hideOtc} onChange={(e) => setHideOtc(e.target.checked)} className="accent-cyan-400" />
          hide OTC
        </label>
        <span className="ml-auto font-mono text-[9px] text-[#4b5a72]">
          {board ? `${board.classified} of ${board.universe} open pairs classified${board.noData ? ` · ${board.noData} without enough ${board.tf} history` : ''} · last ${board.window} closed candles` : loading ? 'scanning…' : '—'}
        </span>
      </div>

      {err && <div className="border-b border-[#1c2739] px-2 py-1 font-mono text-[9px] text-amber-300">{err}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-auto p-2 lg:grid-cols-4">
        {COLS.map((c) => (
          <div key={c.id} className={`flex min-h-[140px] min-w-0 flex-col overflow-hidden rounded-lg border bg-[#0b111c] ${c.border}`}>
            <div className={`flex items-baseline gap-1.5 border-b border-[#1c2739] px-2 py-1.5 ${c.head}`}>
              <span className={`font-mono text-[11px] font-bold uppercase tracking-wider ${c.tone}`}>{c.title}</span>
              <span className={`rounded border px-1.5 font-mono text-[9px] font-bold ${c.tone} ${c.border}`}>{lists[c.id].length}</span>
            </div>
            <div className="border-b border-[#141d2e] px-2 py-0.5 text-[8.5px] leading-snug text-[#4b5a72]">{c.sub} · ranked best first</div>
            <div className="min-h-0 flex-1 space-y-1 overflow-auto p-1.5">
              {!board ? (
                <div className="p-1 font-mono text-[9px] text-[#4b5a72]">{loading ? 'scanning the universe…' : 'no data'}</div>
              ) : lists[c.id].length === 0 ? (
                <div className="p-1 font-mono text-[9px] text-[#4b5a72]">none on {board.tf} right now</div>
              ) : (
                lists[c.id].map((r) => <Row key={r.asset} r={r} col={c} tf={board.tf} onPick={onPick} />)
              )}
            </div>
          </div>
        ))}
      </div>

      <p className="border-t border-[#1c2739] px-2 py-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
        Descriptive, not predictive: each pair is classified from its last {board?.window ?? 40} closed candles (efficiency ratio, ADX, slope strength, and a tested two-sided box for ranging) and may change on the next bar. Scores only rank pairs inside their own list. On random data about 4% of series still read as trending and roughly a fifth as ranging, so treat a single read as a lead to check on the chart, not a signal. Short boxes and slow swings often read as noise.
      </p>
    </div>
  )
}
