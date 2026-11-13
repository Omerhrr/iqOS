'use client'

// IQAIR//OS - Kagi Reversal board (yin / yang)
// "Which Kagi lines just turned?" - every open pair across the 30s..15m
// timeframes, listing only the series with a Kagi event within the last few
// closed candles. Not tied to the open chart's pair or timeframe.
//   REVERSAL  the line flipped direction after an ATR-sized move against it
//   YANG      price broke ABOVE the last shoulder - the line turned thick,
//             demand took over (a structural break, can fire mid-trend)
//   YIN       price broke BELOW the last waist - the line turned thin, supply
//             took over
// Yin/yang are the stronger structural events (a bare reversal is often just a
// pullback), so a row carrying one ranks above a bare reversal at the same age.
// Thickness is read from the engine's event log - the chart view cannot show it.
// Backed by /kagi_reversals_global (plugins/reversalevents.ts globalKagi).

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KagiReversalBoardRow, ReversalBoardMeta, ReversalBoardTf, ReversalRegime } from '@/lib/os/client'
import { REVERSAL_BOARD_TFS, fmtPrice, getKagiReversalsGlobal } from '@/lib/os/client'
import { ageLabel, BoardHonestyNote, EvidenceChip, fmtEventTime, FreshnessControl, TfToggles } from './ReversalFeedShared'

interface KagiReversalPanelProps {
  /** bumps on every closed candle of the active chart - drives refresh */
  closedTick?: number
  /** switch the main chart to a row's pair */
  onPickAsset?: (asset: string) => void
  /** switch the main chart to a row's timeframe */
  onPickTf?: (tf: ReversalBoardTf) => void
  onClose: () => void
}

type EventType = 'reversal' | 'yang' | 'yin'
type DirFilter = 'all' | 'call' | 'put'
type SortMode = 'newest' | 'confluence'

const POLL_MS = 8_000

const TYPE_LABEL: Record<EventType, string> = { reversal: 'REV', yang: 'YANG', yin: 'YIN' }
const TYPE_CLASS: Record<EventType, string> = {
  reversal: 'border-[#3d4d66] text-[#aebccf]',
  yang: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  yin: 'border-sky-500/50 bg-sky-500/10 text-sky-300',
}
const TYPE_HELP: Record<EventType, string> = {
  reversal: 'the line flipped direction after an ATR-sized move against it',
  yang: 'price broke above the last shoulder - the line turned thick; demand took over',
  yin: 'price broke below the last waist - the line turned thin; supply took over',
}
const REGIME_CLASS: Record<ReversalRegime, string> = {
  trending: 'text-emerald-300',
  ranging: 'text-sky-300',
  choppy: 'text-amber-300',
  none: 'text-[#7c8aa5]',
}

const arrow = (dir: 'call' | 'put') => (dir === 'call' ? '▲' : '▼')
const dirClass = (dir: 'call' | 'put') => (dir === 'call' ? 'text-emerald-300' : 'text-rose-300')

export default function KagiReversalPanel({ closedTick, onPickAsset, onPickTf, onClose }: KagiReversalPanelProps) {
  const [rows, setRows] = useState<KagiReversalBoardRow[]>([])
  const [meta, setMeta] = useState<ReversalBoardMeta | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [fresh, setFresh] = useState(1)
  const [tfOn, setTfOn] = useState<Record<ReversalBoardTf, boolean>>({ '30s': true, '1m': true, '2m': true, '5m': true, '15m': true })
  const [typeOn, setTypeOn] = useState<Record<EventType, boolean>>({ reversal: true, yang: true, yin: true })
  const [dirFilter, setDirFilter] = useState<DirFilter>('all')
  const [sort, setSort] = useState<SortMode>('newest')
  const [loading, setLoading] = useState(true)

  const activeTfs = useMemo(() => REVERSAL_BOARD_TFS.filter((t) => tfOn[t]), [tfOn])

  const load = useCallback(async () => {
    try {
      const d = await getKagiReversalsGlobal({ fresh, tfs: activeTfs })
      if (d.ok) {
        setRows(d.rows)
        setMeta(d)
        setErr(null)
      } else {
        setErr(d.error ?? 'Kagi reversal board unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [fresh, activeTfs])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick])

  // a row survives if ANY of its fresh events passes the type + direction
  // filters; the row then shows only the events that did
  const filtered = useMemo(() => {
    const out: (KagiReversalBoardRow & { visible: KagiReversalBoardRow['events'] })[] = []
    for (const r of rows) {
      const visible = r.events.filter((e) => typeOn[e.type] && (dirFilter === 'all' || e.dir === dirFilter))
      if (visible.length) out.push({ ...r, visible })
    }
    return out
  }, [rows, typeOn, dirFilter])

  const confluence = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of filtered) {
      const dir = r.visible[0].dir
      m.set(`${r.asset}:${dir}`, (m.get(`${r.asset}:${dir}`) ?? 0) + 1)
    }
    return m
  }, [filtered])

  const shown = useMemo(() => {
    if (sort === 'newest') return filtered
    return [...filtered].sort(
      (a, b) =>
        (confluence.get(`${b.asset}:${b.visible[0].dir}`) ?? 0) - (confluence.get(`${a.asset}:${a.visible[0].dir}`) ?? 0) ||
        a.visible[0].candlesAgo - b.visible[0].candlesAgo ||
        a.asset.localeCompare(b.asset),
    )
  }, [filtered, sort, confluence])

  const counts = useMemo(() => {
    const c = { reversal: 0, yang: 0, yin: 0 }
    for (const r of rows) for (const e of r.events) c[e.type]++
    return c
  }, [rows])
  const calls = filtered.filter((r) => r.visible[0].dir === 'call').length
  const puts = filtered.length - calls

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Kagi Reversal</h3>
        <span
          className="font-mono text-[9px] text-[#7c8aa5]"
          title="every open pair x the selected timeframes; only series with a Kagi event within the chosen window"
        >
          {meta ? `${filtered.length} turning · ${meta.series} series · ${meta.universe} pairs` : loading ? 'scanning…' : '—'}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
        >
          close
        </button>
      </div>

      {err && <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-[9px] text-amber-300">{err}</div>}

      {/* controls */}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <FreshnessControl value={fresh} onChange={setFresh} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TfToggles value={tfOn} onChange={setTfOn} />
          <div className="flex overflow-hidden rounded border border-[#1c2739] font-mono text-[9px] uppercase">
            {(['all', 'call', 'put'] as DirFilter[]).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDirFilter(d)}
                className={`px-1.5 py-px ${dirFilter === d ? (d === 'call' ? 'bg-emerald-500/20 text-emerald-300' : d === 'put' ? 'bg-rose-500/20 text-rose-300' : 'bg-white/10 text-[#dbe4f0]') : 'text-[#7c8aa5] hover:text-[#dbe4f0]'}`}
              >
                {d === 'all' ? 'both' : d === 'call' ? '▲ bull' : '▼ bear'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">
            <span className="text-[#4b5a72]">sort</span>
            {(['newest', 'confluence'] as SortMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setSort(m)}
                title={m === 'confluence' ? 'pairs turning the same way on the most timeframes first' : 'freshest event first; a yang/yin ahead of a bare reversal at the same age'}
                className={`rounded border px-1.5 py-px uppercase ${sort === m ? 'border-[#3d4d66] bg-white/10 text-[#dbe4f0]' : 'border-[#1c2739] hover:text-[#dbe4f0]'}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {(['yang', 'yin', 'reversal'] as EventType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTypeOn((p) => ({ ...p, [t]: !p[t] }))}
              title={TYPE_HELP[t]}
              className={`rounded border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider transition-opacity ${TYPE_CLASS[t]} ${typeOn[t] ? '' : 'opacity-35'}`}
            >
              {t === 'reversal' ? 'reversal' : t} {counts[t]}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-1.5 font-mono text-[9px]">
            <span className="rounded border border-emerald-500/30 px-1.5 py-px text-emerald-300">▲ {calls}</span>
            <span className="rounded border border-rose-500/30 px-1.5 py-px text-rose-300">▼ {puts}</span>
          </span>
        </div>
      </div>

      {meta && meta.noData > 0 && (
        <div className="font-mono text-[9px] text-[#4b5a72]" title="pair/timeframe series with no candle history yet (a 30s or 15m series can be empty on a young session)">
          {meta.noData} series without history
        </div>
      )}

      {/* board */}
      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c]">
        <div className="flex items-center border-b border-[#1c2739] px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">
          <span className="w-[78px]">pair</span>
          <span className="w-[30px]">tf</span>
          <span className="w-[66px]">age</span>
          <span className="flex-1">events</span>
          <span className="w-[92px] text-right">evidence</span>
        </div>
        {loading && rows.length === 0 ? (
          <div className="px-2 py-4 text-center font-mono text-[9px] text-[#4b5a72]">scanning the universe…</div>
        ) : shown.length === 0 ? (
          <div className="px-2 py-4 text-center font-mono text-[9px] text-[#4b5a72]">
            {rows.length ? 'every event is filtered out - loosen the filters' : 'no Kagi line is turning right now on the selected timeframes'}
          </div>
        ) : (
          shown.map((r) => {
            const head = r.visible[0]
            const stack = confluence.get(`${r.asset}:${head.dir}`) ?? 1
            // the evidence chip follows the row's strongest visible event (yang/yin over reversal)
            const lead = r.visible.find((e) => e.type !== 'reversal') ?? head
            return (
              <button
                key={`${r.asset}:${r.tf}`}
                type="button"
                onClick={() => {
                  onPickAsset?.(r.asset)
                  onPickTf?.(r.tf)
                }}
                title={`${r.asset} ${r.tf} - ${r.visible.map((e) => `${e.type} ${e.dir === 'call' ? 'bullish' : 'bearish'} @ ${fmtPrice(e.price, r.asset)}${e.level !== null ? ` (${e.type === 'reversal' ? 'from' : 'broke'} ${fmtPrice(e.level, r.asset)})` : ''}`).join(' · ')} · ${fmtEventTime(head.time)} · click to open on the chart`}
                className={`flex w-full items-center border-b border-[#1c2739]/60 px-2 py-0.5 text-left font-mono text-[9.5px] last:border-b-0 hover:bg-white/[0.04] ${head.candlesAgo === 0 ? 'bg-white/[0.03]' : ''}`}
              >
                <span className="w-[78px] truncate font-bold text-[#dbe4f0]">{r.asset}</span>
                <span className="w-[30px] text-[#7c8aa5]">{r.tf}</span>
                <span className="w-[66px] text-[8.5px] text-[#7c8aa5]">{ageLabel(head.candlesAgo)}</span>
                <span className="flex flex-1 flex-wrap items-center gap-1 overflow-hidden">
                  {stack > 1 && (
                    <span className="rounded border border-fuchsia-500/50 bg-fuchsia-500/10 px-1 py-px text-[8px] uppercase text-fuchsia-300" title={`${stack} timeframes of ${r.asset} turned ${head.dir === 'call' ? 'bullish' : 'bearish'} together`}>
                      ×{stack} tf
                    </span>
                  )}
                  {r.visible.map((e) => (
                    <span key={`${e.type}-${e.time}`} className={`rounded border px-1 py-px text-[8px] uppercase tracking-wider ${TYPE_CLASS[e.type]}`}>
                      <span className={dirClass(e.dir)}>{arrow(e.dir)}</span> {TYPE_LABEL[e.type]}
                    </span>
                  ))}
                  <span className={`text-[8px] uppercase ${r.thick ? 'text-amber-300' : 'text-sky-300'}`} title={r.thick ? 'line is thick (yang) now' : 'line is thin (yin) now'}>
                    {r.thick ? 'yang' : 'yin'}
                  </span>
                  <span className={`text-[8px] uppercase ${REGIME_CLASS[r.regime]}`} title="Kagi regime - structure of the last shoulders/waists, gated by reversal density">
                    {r.regime === 'none' ? '' : r.regime}
                  </span>
                </span>
                <span className="flex w-[92px] justify-end" title={`evidence for the ${lead.type} event`}>
                  <EvidenceChip stat={r.stats[lead.type]} />
                </span>
              </button>
            )
          })
        )}
      </div>

      <BoardHonestyNote>
        Yang and yin are structural breaks and can fire mid-trend, not only at a reversal; a bare reversal after a short run is often just a pullback, so rows carrying a yang or yin rank first at the same age. The reversal size is ATR-adaptive, so on the fastest timeframes the line can lag - tighten it in MSL (<span className="text-[#7c8aa5]">kagi.reversalAtrMult</span>) if you trade 60s and under. The scan reads closed candles only, refreshed every few seconds.
      </BoardHonestyNote>
    </div>
  )
}
