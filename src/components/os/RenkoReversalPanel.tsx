'use client'

// IQAIR//OS - Renko Reversal board
// "Which charts just flipped?" - every open pair across the 30s..15m
// timeframes, listing only the Renko-style series whose newest brick reversed
// within the last few closed candles. Not tied to the open chart's pair or
// timeframe. Default source is Effort Bricks (Renko geometry and 2-brick
// reversal rule, smaller ATR x 0.3 step so the flip fires earlier, each
// reversal tagged volume-confirmed/unconfirmed with its participation
// regime); plain Renko is a switchable source. A pair flipping the same way
// on several timeframes at once is shown as confluence.
// Backed by /renko_reversals_global (plugins/reversalevents.ts globalRenko),
// TTL-cached kernel-side.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RenkoReversalBoardRow, ReversalBoardMeta, ReversalBoardTf, ReversalRegime } from '@/lib/os/client'
import { REVERSAL_BOARD_TFS, fmtPrice, getRenkoReversalsGlobal } from '@/lib/os/client'
import { ageLabel, BoardHonestyNote, EvidenceChip, fmtEventTime, FreshnessControl, TfToggles } from './ReversalFeedShared'

interface RenkoReversalPanelProps {
  /** bumps on every closed candle of the active chart - drives refresh */
  closedTick?: number
  /** switch the main chart to a row's pair */
  onPickAsset?: (asset: string) => void
  /** switch the main chart to a row's timeframe */
  onPickTf?: (tf: ReversalBoardTf) => void
  onClose: () => void
}

const POLL_MS = 8_000

const REGIME_CLASS: Record<ReversalRegime, string> = {
  trending: 'text-emerald-300',
  ranging: 'text-sky-300',
  choppy: 'text-amber-300',
  none: 'text-[#7c8aa5]',
}

type DirFilter = 'all' | 'call' | 'put'
type SortMode = 'newest' | 'confluence'

const arrow = (dir: 'call' | 'put') => (dir === 'call' ? '▲' : '▼')
const dirClass = (dir: 'call' | 'put') => (dir === 'call' ? 'text-emerald-300' : 'text-rose-300')

export default function RenkoReversalPanel({ closedTick, onPickAsset, onPickTf, onClose }: RenkoReversalPanelProps) {
  const [rows, setRows] = useState<RenkoReversalBoardRow[]>([])
  const [meta, setMeta] = useState<ReversalBoardMeta | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [source, setSource] = useState<'effort' | 'renko'>('effort')
  const [fresh, setFresh] = useState(1)
  const [tfOn, setTfOn] = useState<Record<ReversalBoardTf, boolean>>({ '30s': true, '1m': true, '2m': true, '5m': true, '15m': true })
  const [hideChoppy, setHideChoppy] = useState(true)
  const [confirmedOnly, setConfirmedOnly] = useState(false)
  const [dirFilter, setDirFilter] = useState<DirFilter>('all')
  const [sort, setSort] = useState<SortMode>('newest')
  const [loading, setLoading] = useState(true)

  const activeTfs = useMemo(() => REVERSAL_BOARD_TFS.filter((t) => tfOn[t]), [tfOn])

  const load = useCallback(async () => {
    try {
      const d = await getRenkoReversalsGlobal({ source, fresh, tfs: activeTfs })
      if (d.ok) {
        setRows(d.rows)
        setMeta(d)
        setErr(null)
      } else {
        setErr(d.error ?? 'Renko reversal board unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [source, fresh, activeTfs])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick])

  const isEffort = source === 'effort'

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (dirFilter !== 'all' && r.event.dir !== dirFilter) return false
        if (isEffort && hideChoppy && r.event.regime === 'choppy') return false
        if (isEffort && confirmedOnly && r.event.confirmed !== true) return false
        return true
      }),
    [rows, dirFilter, isEffort, hideChoppy, confirmedOnly],
  )

  // how many of the SHOWN series flipped the same way on the same pair - "x3" =
  // three timeframes of one pair turned together
  const confluence = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of filtered) m.set(`${r.asset}:${r.event.dir}`, (m.get(`${r.asset}:${r.event.dir}`) ?? 0) + 1)
    return m
  }, [filtered])

  const shown = useMemo(() => {
    if (sort === 'newest') return filtered
    return [...filtered].sort(
      (a, b) =>
        (confluence.get(`${b.asset}:${b.event.dir}`) ?? 0) - (confluence.get(`${a.asset}:${a.event.dir}`) ?? 0) ||
        a.event.candlesAgo - b.event.candlesAgo ||
        a.asset.localeCompare(b.asset),
    )
  }, [filtered, sort, confluence])

  const calls = filtered.filter((r) => r.event.dir === 'call').length
  const puts = filtered.length - calls
  const hidden = rows.length - filtered.length

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-orange-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Renko Reversal</h3>
        <span
          className="font-mono text-[9px] text-[#7c8aa5]"
          title="every open pair x the selected timeframes; only series whose newest brick reversed within the chosen window"
        >
          {meta ? `${filtered.length} reversing · ${meta.series} series · ${meta.universe} pairs` : loading ? 'scanning…' : '—'}
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
          <div className="flex overflow-hidden rounded border border-[#1c2739]">
            {(['effort', 'renko'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={`px-1.5 py-px font-mono text-[9px] uppercase ${source === s ? 'bg-orange-500/20 text-orange-300' : 'text-[#7c8aa5] hover:text-[#dbe4f0]'}`}
                title={s === 'effort' ? 'Effort Bricks - ATR x 0.3 step, volume-confirmed (earlier flips, with a quality read)' : 'plain Renko - ATR x 0.3 step, price only (no confirmation data)'}
              >
                {s === 'effort' ? 'effort bricks' : 'plain renko'}
              </button>
            ))}
          </div>
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
                {d === 'all' ? 'both' : d === 'call' ? '▲ up' : '▼ down'}
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
                title={m === 'confluence' ? 'pairs flipping the same way on the most timeframes first' : 'freshest reversal first, volume-confirmed ahead of unconfirmed'}
                className={`rounded border px-1.5 py-px uppercase ${sort === m ? 'border-[#3d4d66] bg-white/10 text-[#dbe4f0]' : 'border-[#1c2739] hover:text-[#dbe4f0]'}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        {isEffort && (
          <div className="flex flex-wrap items-center gap-3 font-mono text-[9px] text-[#7c8aa5]">
            <label className="flex cursor-pointer items-center gap-1" title="drop reversals printed while the participation regime is choppy (distance without volume - the classic whipsaw)">
              <input type="checkbox" checked={hideChoppy} onChange={(e) => setHideChoppy(e.target.checked)} className="accent-orange-400" />
              hide choppy
            </label>
            <label className="flex cursor-pointer items-center gap-1" title="only reversals whose brick carried at least average volume">
              <input type="checkbox" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} className="accent-orange-400" />
              confirmed only
            </label>
            {hidden > 0 && <span className="ml-auto text-[#4b5a72]">{hidden} filtered out</span>}
          </div>
        )}
      </div>

      {/* summary strip */}
      {meta && (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[9px]">
          <span className="rounded border border-emerald-500/30 px-1.5 py-px text-emerald-300">▲ {calls}</span>
          <span className="rounded border border-rose-500/30 px-1.5 py-px text-rose-300">▼ {puts}</span>
          {meta.noData > 0 && (
            <span className="text-[#4b5a72]" title="pair/timeframe series with no candle history yet (a 30s or 15m series can be empty on a young session)">
              {meta.noData} series without history
            </span>
          )}
        </div>
      )}

      {/* board */}
      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c]">
        <div className="flex items-center border-b border-[#1c2739] px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">
          <span className="w-[78px]">pair</span>
          <span className="w-[30px]">tf</span>
          <span className="w-[54px]">flip</span>
          <span className="w-[66px]">age</span>
          <span className="flex-1">quality</span>
          <span className="w-[92px] text-right">evidence</span>
        </div>
        {loading && rows.length === 0 ? (
          <div className="px-2 py-4 text-center font-mono text-[9px] text-[#4b5a72]">scanning the universe…</div>
        ) : shown.length === 0 ? (
          <div className="px-2 py-4 text-center font-mono text-[9px] text-[#4b5a72]">
            {rows.length ? 'every reversal is filtered out - loosen the filters' : 'no pair is reversing right now on the selected timeframes'}
          </div>
        ) : (
          shown.map((r) => {
            const stack = confluence.get(`${r.asset}:${r.event.dir}`) ?? 1
            return (
              <button
                key={`${r.asset}:${r.tf}`}
                type="button"
                onClick={() => {
                  onPickAsset?.(r.asset)
                  onPickTf?.(r.tf)
                }}
                title={`${r.asset} ${r.tf} - flipped ${r.event.dir === 'call' ? 'up' : 'down'} at ${fmtPrice(r.event.price, r.asset)} (${fmtEventTime(r.event.time)}) after a ${r.event.priorRun}-brick run · brick ${fmtPrice(r.brickSize, r.asset)} · click to open on the chart`}
                className={`flex w-full items-center border-b border-[#1c2739]/60 px-2 py-0.5 text-left font-mono text-[9.5px] last:border-b-0 hover:bg-white/[0.04] ${r.event.candlesAgo === 0 ? 'bg-white/[0.03]' : ''}`}
              >
                <span className="w-[78px] truncate font-bold text-[#dbe4f0]">{r.asset}</span>
                <span className="w-[30px] text-[#7c8aa5]">{r.tf}</span>
                <span className={`w-[54px] font-bold ${dirClass(r.event.dir)}`}>
                  {arrow(r.event.dir)} {r.event.dir === 'call' ? 'CALL' : 'PUT'}
                </span>
                <span className="w-[66px] text-[8.5px] text-[#7c8aa5]">{ageLabel(r.event.candlesAgo)}</span>
                <span className="flex flex-1 items-center gap-1 overflow-hidden text-[8.5px] uppercase">
                  {stack > 1 && (
                    <span className="rounded border border-fuchsia-500/50 bg-fuchsia-500/10 px-1 py-px text-fuchsia-300" title={`${stack} timeframes of ${r.asset} flipped ${r.event.dir === 'call' ? 'up' : 'down'} together`}>
                      ×{stack} tf
                    </span>
                  )}
                  {r.event.confirmed === null ? (
                    <span className="text-[#4b5a72]">{r.source === 'renko' ? 'price only' : 'no volume'}</span>
                  ) : (
                    <>
                      <span className={r.event.confirmed ? 'text-emerald-300' : 'text-[#7c8aa5]'}>{r.event.confirmed ? 'confirmed' : 'unconf'}</span>
                      {r.event.regime && r.event.regime !== 'none' && <span className={REGIME_CLASS[r.event.regime]}>· {r.event.regime}</span>}
                    </>
                  )}
                  <span className="text-[#4b5a72]">· {r.event.priorRun}b run</span>
                </span>
                <span className="flex w-[92px] justify-end">
                  <EvidenceChip stat={r.stat} />
                </span>
              </button>
            )
          })
        )}
      </div>

      <BoardHonestyNote>
        A reversal brick prints after a counter-move of two brick sizes, so on a choppy pair it prints constantly - that is why quality is shown with every flip. <span className="text-[#7c8aa5]">Confirmed</span> = the reversal brick carried at least average volume versus the trailing bricks; the regime is the participation read over the 20 bricks ending at it (on OTC pairs &ldquo;volume&rdquo; is often a tick count, not traded size). The scan reads closed candles only, refreshed every few seconds.
      </BoardHonestyNote>
    </div>
  )
}
