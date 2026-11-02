'use client'

// IQAIR//OS - Accute Global panel (the board)
// The triple-confluence engine lifted to the whole universe: ADX/DI +
// Pattern Bias, Tempo (actively firing, not merely leaning), and the
// Next-Candle Oracle fusion, combined per pair. A row shows CALL/PUT only
// when all three legs agree right now; otherwise it's WAITING, sorted to
// the bottom. This is deliberately the rarest, strictest signal on the
// board - expect most rows to read WAITING most of the time.
// Backed by /accute_scan + /accute_stats (plugins/accute.ts).

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AccuteLegName, AccuteSignal, AccuteStatsResponse, Timeframe } from '@/lib/os/client'
import { fmtPrice, getAccuteScan, getAccuteStats } from '@/lib/os/client'

interface AccuteGlobalPanelProps {
  /** active chart timeframe - the board starts there but can switch */
  tf: Timeframe
  /** bumps on every closed candle of the active chart - drives refresh */
  closedTick?: number
  /** switch the main chart to a row's pair */
  onPickAsset?: (asset: string) => void
  /** open the per-asset Accute panel for a row's pair */
  onOpenAccute?: (asset: string) => void
  onClose: () => void
}

const POLL_MS = 8_000
const STATS_POLL_MS = 20_000
const TFS: Timeframe[] = ['1m', '2m', '5m']
const LIMIT = 60

const LEG_LABELS: Record<AccuteLegName, string> = { adxPattern: 'ADX/DI+Pat', tempo: 'Tempo', oracle: 'Oracle' }
const LEG_ORDER: AccuteLegName[] = ['adxPattern', 'tempo', 'oracle']

function dirChip(direction: 'call' | 'put' | 'none', size: 'lg' | 'sm' = 'sm') {
  const none = direction === 'none'
  const call = direction === 'call'
  const cls = none
    ? 'border-[#3d4d66] text-[#7c8aa5]'
    : call
      ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
      : 'border-rose-500/50 bg-rose-500/15 text-rose-300'
  const text = size === 'lg' ? 'text-[12px] px-2.5 py-1' : 'text-[8.5px] px-1.5 py-px'
  return (
    <span className={`inline-flex items-center gap-1 rounded border font-mono font-bold uppercase tracking-wider ${cls} ${text}`}>
      {none ? 'WAITING' : call ? '▲ CALL' : '▼ PUT'}
    </span>
  )
}

function legDots(legs: AccuteSignal['legs']) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {LEG_ORDER.map((name) => {
        const leg = legs[name]
        const cls =
          leg.direction === 'none'
            ? 'bg-[#24324a]'
            : leg.direction === 'call'
              ? 'bg-emerald-400'
              : 'bg-rose-400'
        return <span key={name} title={`${LEG_LABELS[name]}: ${leg.label}`} className={`h-2 w-2 rounded-full ${cls}`} />
      })}
    </span>
  )
}

export default function AccuteGlobalPanel({ tf, closedTick, onPickAsset, onOpenAccute, onClose }: AccuteGlobalPanelProps) {
  const [tfSel, setTfSel] = useState<Timeframe>(tf)
  const [rows, setRows] = useState<AccuteSignal[]>([])
  const [meta, setMeta] = useState<{ scanned: number; universe: number; agreeing: number; ts: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [stats, setStats] = useState<AccuteStatsResponse | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await getAccuteScan(tfSel, { limit: LIMIT })
      if (res.ok) {
        setRows(res.rows)
        setMeta({ scanned: res.scanned, universe: res.universe, agreeing: res.agreeing, ts: res.scannedTs })
        setErr(null)
      } else {
        setErr(res.error ?? 'accute board unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [tfSel])

  const loadStats = useCallback(async () => {
    try {
      const d = await getAccuteStats()
      if (d.ok) setStats(d)
    } catch {
      // learned-stats strip is optional - never block the board on it
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick, tfSel])

  useEffect(() => {
    void loadStats()
    const iv = setInterval(() => void loadStats(), STATS_POLL_MS)
    return () => clearInterval(iv)
  }, [loadStats])

  const shown = useMemo(() => rows.filter((r) => r.ok), [rows])
  const agreeing = useMemo(() => shown.filter((r) => r.direction !== 'none').sort((a, b) => b.agreeCount - a.agreeCount), [shown])
  const waiting = useMemo(() => shown.filter((r) => r.direction === 'none'), [shown])
  const ordered = [...agreeing, ...waiting]
  const best = agreeing[0]

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-violet-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Accute Global</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">triple confluence · {meta ? `${meta.agreeing} agreeing / ${meta.scanned} scanned` : '…'}</span>
        <div className="ml-auto flex items-center gap-1">
          {TFS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTfSel(t)}
              className={`rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase ${tfSel === t ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'}`}
            >
              {t}
            </button>
          ))}
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
          >
            ✕
          </button>
        </div>
      </div>

      {err && <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5 font-mono text-[9px] text-rose-300">{err}</div>}

      {stats && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[8.5px]">
          <span className="text-[#4b5a72]">fleet-wide ledger</span>
          <span className="text-[#7c8aa5]">
            {stats.total} resolved · {stats.pending} pending
            {stats.hitRate !== null && (
              <span className={stats.hitRate >= 0.55 ? 'text-emerald-300' : 'text-amber-300'}> · {(stats.hitRate * 100).toFixed(0)}% overall</span>
            )}
          </span>
        </div>
      )}

      {/* strongest current 3-way agreement, if any */}
      {best ? (
        <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
          <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
            <span>strongest agreement right now</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPickAsset?.(best.asset)}
              className="font-mono text-[12px] font-bold text-[#dbe4f0] underline decoration-[#24324a] underline-offset-2 hover:decoration-violet-400"
              title="open this pair on the main chart"
            >
              {best.asset}
            </button>
            {dirChip(best.direction, 'lg')}
            {legDots(best.legs)}
            {onOpenAccute && (
              <button
                type="button"
                onClick={() => onOpenAccute(best.asset)}
                className="rounded border border-violet-500/40 px-1.5 py-px font-mono text-[8.5px] uppercase text-violet-300 hover:bg-violet-500/10"
                title="open the full Accute panel for this pair"
              >
                open accute
              </button>
            )}
            <span className="ml-auto font-mono text-[10px] text-[#7c8aa5]">{fmtPrice(best.price, best.asset)}</span>
          </div>
          <p className="mt-1 font-mono text-[8px] text-[#3d4d66]">{best.summary}</p>
          <p className="mt-0.5 font-mono text-[7.5px] text-[#4b5a72]">
            {best.adaptive.session} · {best.adaptive.regime} · confidence floor {best.adaptive.minConfidenceUsed} · {best.adaptive.note}
          </p>
        </div>
      ) : (
        !err && (
          <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#4b5a72]">
            no 3-way agreement anywhere on the board right now - this is deliberately rare
          </div>
        )
      )}

      {/* the board */}
      <div className="flex min-h-0 flex-1 flex-col gap-1">
        {ordered.length === 0 && !err && (
          <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#4b5a72]">
            no live rows yet - the board reads the oracle's universe scan, give it a poll or two
          </div>
        )}
        {ordered.map((r) => (
          <div
            key={r.asset}
            role="button"
            tabIndex={0}
            onClick={() => onPickAsset?.(r.asset)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onPickAsset?.(r.asset) }}
            className="group flex items-center gap-2 rounded border border-[#1c2739] bg-[#0b111c] px-2 py-1 text-left hover:border-[#24324a]"
            title={`${r.asset} ${r.tf} · ${r.summary} · click to open on the chart`}
          >
            <span className="w-24 shrink-0 truncate font-mono text-[10px] font-bold text-[#dbe4f0] group-hover:text-violet-300">{r.asset}</span>
            {dirChip(r.direction)}
            {legDots(r.legs)}
            {r.zone.side !== 'none' && (
              <span
                className={`shrink-0 rounded border px-1 py-px font-mono text-[7px] uppercase ${r.zone.side === 'buy' ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}`}
                title={r.zone.label}
              >
                {r.zone.side === 'buy' ? 'buy zone' : 'sell zone'}
              </span>
            )}
            {r.adaptive.overridden && (
              <span className="shrink-0 rounded border border-rose-500/40 px-1 py-px font-mono text-[7px] uppercase text-rose-300" title={r.adaptive.note}>
                gated
              </span>
            )}
            <span className="truncate font-mono text-[8px] text-[#4b5a72]">{r.summary}</span>
            {onOpenAccute && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenAccute(r.asset) }}
                className="shrink-0 rounded border border-violet-500/40 px-1 py-px font-mono text-[7.5px] uppercase text-violet-300 hover:bg-violet-500/10"
                title="open the full Accute panel for this pair"
              >
                accute
              </button>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[8px] text-[#4b5a72]">
              <span className="text-[#3d4d66]">{fmtPrice(r.price, r.asset)}</span>
            </span>
          </div>
        ))}
      </div>

      <p className="shrink-0 font-mono text-[8px] leading-relaxed text-[#3d4d66]">
        ADX/DI + Pattern, Tempo (actively firing), and Next-Candle Oracle - CALL/PUT only when all three agree right now, otherwise WAITING. The dots show each leg's own read (green=call, red=put, grey=flat). A CALL also needs an actual buy zone (support/range floor) and a PUT a sell zone (resistance/range ceiling) - the buy/sell zone tag shows which. The confidence bar adapts per pair, session, and macro regime from Accute's own resolved record - a "gated" tag means that exact bucket has proven itself wrong often enough to stand aside regardless of agreement. Deliberately the rarest signal in the catalog.
      </p>
    </div>
  )
}
