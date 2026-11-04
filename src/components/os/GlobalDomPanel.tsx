'use client'

// IQAIR//OS - Global Dom panel
// "Who fully has control right now" (analytics/orderflow.ts
// computeControlRead) lifted from one chart to the whole universe: a
// confirmation-hunting board, not a ranking board. This is deliberately
// NOT a direction prediction (that was the original Momentum-Score-based
// "every timeframe agrees on candle color" read, replaced per direct
// instruction) - it's a read of actual buy/sell transaction pressure:
// "full control" means one side held EVERY bar of a short recent window,
// not just won the net average. Most polls this comes back thin or empty -
// that's the point. When a row DOES show up here, the next move is to
// cross-check it against the full Next-Candle Oracle and Accute reads for
// that same pair before trading it manually, which is exactly what this
// panel's two cross-nav buttons are for.
//
// Backed by /dom_global (plugins/nextcandle.ts domGlobalScan) - it reuses
// the SAME TTL-cached rows Next Global/Accute/Tempo already keep warm
// (one scanRowFor() cache, shared), so this board costs nothing extra to
// poll: it's a filter over work already being done, not a second scan.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { NextGlobalRow, Timeframe } from '@/lib/os/client'
import { fmtPrice, getDomGlobal } from '@/lib/os/client'

interface GlobalDomPanelProps {
  tf: Timeframe
  closedTick?: number
  /** switch the main chart to a row's pair */
  onPickAsset?: (asset: string) => void
  /** open the full Next-Candle Oracle panel for a row's pair - the
   * confirm-before-you-trade cross-check this board exists to feed. */
  onOpenOracle?: (asset: string) => void
  /** open the Accute panel for a row's pair - second confirm-before-you-
   * trade cross-check. */
  onOpenAccute?: (asset: string) => void
  onClose: () => void
}

const POLL_MS = 12_000
const TFS: Timeframe[] = ['1m', '5m']
const LIMIT = 80

type DirFilter = 'all' | 'buy' | 'sell'

function controlChip(direction: string) {
  const buy = direction === 'buy'
  const none = direction === 'none' || !direction
  const cls = none
    ? 'border-[#3d4d66] text-[#7c8aa5]'
    : buy
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
      : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
  return (
    <span className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-wider ${cls}`}>
      {none ? '—' : buy ? '▲ buyers' : '▼ sellers'}
    </span>
  )
}

function ageLabel(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

export default function GlobalDomPanel({ tf, closedTick, onPickAsset, onOpenOracle, onOpenAccute, onClose }: GlobalDomPanelProps) {
  const [tfSel, setTfSel] = useState<Timeframe>(tf)
  const [rows, setRows] = useState<NextGlobalRow[]>([])
  const [meta, setMeta] = useState<{ scanned: number; universe: number; dominating: number; scannedTs: number } | null>(null)
  const [dirFilter, setDirFilter] = useState<DirFilter>('all')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [, forceTick] = useState(0)

  const load = useCallback(async (refresh = false) => {
    setBusy(true)
    try {
      const res = await getDomGlobal(tfSel, { limit: LIMIT, refresh })
      if (res.ok) {
        setRows(res.rows)
        setMeta({ scanned: res.scanned, universe: res.universe, dominating: res.dominating, scannedTs: res.scannedTs })
        setErr(null)
      } else {
        setErr(res.error ?? 'global dom unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [tfSel])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    const age = setInterval(() => forceTick((n) => n + 1), 5000)
    return () => {
      clearInterval(t)
      clearInterval(age)
    }
  }, [load, closedTick, tfSel])

  const shown = useMemo(() => {
    const live = rows.filter((r) => dirFilter === 'all' || r.controlDirection === dirFilter)
    return [...live].sort((a, b) => (b.controlDominance ?? 0) - (a.controlDominance ?? 0))
  }, [rows, dirFilter])

  const buys = rows.filter((r) => r.controlDirection === 'buy').length
  const sells = rows.filter((r) => r.controlDirection === 'sell').length
  const best = shown[0]

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Global Dom</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">{meta ? `${meta.dominating}/${meta.scanned} dominating` : '…'}</span>
        <div className="ml-auto flex items-center gap-1">
          {TFS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTfSel(t)}
              className={`rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase ${tfSel === t ? 'border-amber-500/50 bg-amber-500/10 text-amber-300' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'}`}
            >
              {t}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={busy}
            className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] uppercase text-[#7c8aa5] hover:text-[#dbe4f0] disabled:opacity-40"
            title="force a fresh fusion on every row (bypass the board cache)"
          >
            {busy ? '…' : 'rescan'}
          </button>
          <button type="button" onClick={onClose} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300">
            ✕
          </button>
        </div>
      </div>

      {err && <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5 font-mono text-[9px] text-rose-300">{err}</div>}

      {best ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 shadow-[0_0_10px_-4px_rgba(245,158,11,0.6)]">
          <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-amber-300/80">
            <span>⚡ strongest control</span>
            <span className="normal-case text-[#7c8aa5]">
              {buys}▲ / {sells}▼{meta && <span className="text-[#3d4d66]"> · scanned {ageLabel(meta.scannedTs)} ago</span>}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPickAsset?.(best.asset)}
              className="font-mono text-[12px] font-bold text-[#dbe4f0] underline decoration-[#24324a] underline-offset-2 hover:decoration-amber-400"
              title="open this pair on the main chart"
            >
              {best.asset}
            </button>
            {controlChip(best.controlDirection ?? 'none')}
            <span className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[8.5px] uppercase text-[#7c8aa5]">
              weakest bar {best.controlDominance ?? 0}%
            </span>
            {onOpenOracle && (
              <button
                type="button"
                onClick={() => onOpenOracle(best.asset)}
                className="rounded border border-amber-500/40 px-1.5 py-px font-mono text-[8.5px] uppercase text-amber-300 hover:bg-amber-500/10"
                title="open the Next-Candle Oracle for this pair to confirm"
              >
                → oracle
              </button>
            )}
            {onOpenAccute && (
              <button
                type="button"
                onClick={() => onOpenAccute(best.asset)}
                className="rounded border border-violet-500/40 px-1.5 py-px font-mono text-[8.5px] uppercase text-violet-300 hover:bg-violet-500/10"
                title="open Accute for this pair to confirm"
              >
                → accute
              </button>
            )}
          </div>
          <p className="mt-1 font-mono text-[8px] text-[#3d4d66]">{best.controlNote}</p>
        </div>
      ) : (
        !err && (
          <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#4b5a72]">
            no full control right now - that's normal, this board is meant to stay quiet. give it a poll or two; it fires only when one side (buyers or sellers) has held every bar of the last few candles, not just won on average.
          </div>
        )
      )}

      <div className="flex items-center gap-1">
        {(['all', 'buy', 'sell'] as DirFilter[]).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDirFilter(d)}
            className={`rounded border px-1.5 py-px font-mono text-[8.5px] uppercase ${dirFilter === d ? 'border-[#3d4d66] bg-[#132034] text-[#dbe4f0]' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'}`}
          >
            {d}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1">
        {shown.map((r) => (
          <div
            key={r.asset}
            role="button"
            tabIndex={0}
            onClick={() => onPickAsset?.(r.asset)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onPickAsset?.(r.asset) }}
            className="group flex items-center gap-2 rounded border border-amber-500/20 bg-[#0b111c] px-2 py-1 text-left hover:border-amber-500/40"
            title={`${r.asset} ${r.tf} · ${r.controlNote ?? ''} · click to open on the chart`}
          >
            <span className="w-24 shrink-0 truncate font-mono text-[10px] font-bold text-[#dbe4f0] group-hover:text-amber-300">{r.asset}</span>
            {controlChip(r.controlDirection ?? 'none')}
            <span className="shrink-0 font-mono text-[9px] text-[#aab6cc]">
              weakest bar {r.controlDominance ?? 0}%
            </span>
            {onOpenOracle && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenOracle(r.asset) }}
                className="shrink-0 rounded border border-amber-500/40 px-1 py-px font-mono text-[7.5px] uppercase text-amber-300 hover:bg-amber-500/10"
                title="open the Next-Candle Oracle for this pair to confirm"
              >
                oracle
              </button>
            )}
            {onOpenAccute && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenAccute(r.asset) }}
                className="shrink-0 rounded border border-violet-500/40 px-1 py-px font-mono text-[7.5px] uppercase text-violet-300 hover:bg-violet-500/10"
                title="open Accute for this pair to confirm"
              >
                accute
              </button>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[8px] text-[#4b5a72]">
              <span className="text-[#3d4d66]">{fmtPrice(r.price, r.asset)}</span>
              <span>{ageLabel(r.computedTs)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
