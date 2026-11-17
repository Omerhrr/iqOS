'use client'

// IQAIR//OS - Signal Global panel
// The Signal clock (BUY / SELL / WAIT from the five Explainer readers, Effort Renko and the pair's regime) lifted from one chart to the whole universe, same relationship
// SMC Global has to the SMC panel: one Signal read per open pair, ranked actionable-first then by strength. Backed by /signal_global (plugins/signal.ts global()) - rows are
// the exact same TTL-cached per-asset read the Signal tab and panel use, so the board, the dial and a live MSL `signal.*` script agree for the same bars.
// The needle bar is the signal's needle (-100 sell .. +100 buy); while WAIT it is held inside +/-30 exactly like the dial. Scanning places nothing.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SignalGlobal, SignalGlobalRow, Timeframe } from '@/lib/os/client'
import { fmtPrice, getSignalGlobal } from '@/lib/os/client'

interface SignalGlobalPanelProps {
  tf: Timeframe
  closedTick?: number
  onPickAsset?: (asset: string) => void
  /** open the per-asset Signal panel (the clock) for a row's pair */
  onOpenSignal?: (asset: string) => void
  onClose: () => void
}

const POLL_MS = 10_000
const TFS: Timeframe[] = ['30s', '1m', '2m', '5m', '15m']
const LIMIT = 60

type ActionFilter = 'all' | 'buy' | 'sell' | 'actionable'
type ScopeFilter = 'all' | 'real' | 'otc'

function actionChip(a: SignalGlobalRow['action']) {
  const cls = a === 'buy' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : a === 'sell' ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-[#3d4d66] text-[#7c8aa5]'
  return <span className={`inline-flex w-12 items-center justify-center rounded border px-1 py-px font-mono text-[8.5px] font-bold uppercase tracking-wider ${cls}`}>{a === 'buy' ? '▲ buy' : a === 'sell' ? '▼ sell' : 'wait'}</span>
}

/** centred needle bar: left of the middle = sell, right = buy */
function needleBar(needle: number, action: SignalGlobalRow['action']) {
  const n = Math.max(-100, Math.min(100, needle))
  const hue = action === 'buy' ? 'bg-emerald-500/80' : action === 'sell' ? 'bg-rose-500/80' : 'bg-[#3d4d66]'
  return (
    <div className="flex items-center gap-1" title={`needle ${n.toFixed(0)} (-100 sell .. +100 buy)`}>
      <div className="relative h-1.5 w-20 overflow-hidden rounded-full border border-[#1c2739] bg-[#0b111c]">
        <div className="absolute top-0 h-full w-px bg-[#24324a]" style={{ left: '50%' }} />
        <div className={`absolute top-0 h-full ${hue}`} style={n >= 0 ? { left: '50%', width: `${n / 2}%` } : { right: '50%', width: `${-n / 2}%` }} />
      </div>
      <span className={`w-7 text-right font-mono text-[9px] ${action === 'buy' ? 'text-emerald-300' : action === 'sell' ? 'text-rose-300' : 'text-[#4b5a72]'}`}>{n > 0 ? '+' : ''}{n.toFixed(0)}</span>
    </div>
  )
}

function ageLabel(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
}

export default function SignalGlobalPanel({ tf, closedTick, onPickAsset, onOpenSignal, onClose }: SignalGlobalPanelProps) {
  const [tfSel, setTfSel] = useState<Timeframe>(TFS.includes(tf) ? tf : '1m')
  const [data, setData] = useState<SignalGlobal | null>(null)
  const [actionFilter, setActionFilter] = useState<ActionFilter>('actionable')
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [, forceTick] = useState(0)

  const load = useCallback(
    async (refresh = false) => {
      setBusy(true)
      try {
        const res = await getSignalGlobal(tfSel, { scope: scopeFilter, limit: LIMIT, refresh })
        if (res.ok) {
          setData(res)
          setErr(null)
        } else setErr(res.error)
      } catch (e) {
        setErr((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [tfSel, scopeFilter],
  )

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    const age = setInterval(() => forceTick((n) => n + 1), 5000)
    return () => {
      clearInterval(t)
      clearInterval(age)
    }
  }, [load, closedTick])

  const shown = useMemo(() => {
    const rows = data?.rows ?? []
    return rows.filter((r) => (actionFilter === 'all' ? true : actionFilter === 'actionable' ? r.action !== 'wait' : r.action === actionFilter))
  }, [data, actionFilter])
  const best = (data?.rows ?? []).find((r) => r.action !== 'wait')

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Signal Global</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">clock board · {data ? `${data.buys}▲ / ${data.sells}▼ / ${data.waits} wait` : '…'}</span>
        <div className="ml-auto flex items-center gap-1">
          {TFS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTfSel(t)}
              className={`rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase ${tfSel === t ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'}`}
            >
              {t}
            </button>
          ))}
          <button type="button" onClick={() => void load(true)} disabled={busy} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] uppercase text-[#7c8aa5] hover:text-[#dbe4f0] disabled:opacity-40">
            {busy ? '…' : 'refresh'}
          </button>
          <button type="button" onClick={onClose} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300">
            ✕
          </button>
        </div>
      </div>

      {err && <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5 font-mono text-[9px] text-rose-300">{err}</div>}

      {best && (
        <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
          <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
            <span>strongest signal</span>
            <span className="normal-case text-[#3d4d66]">
              {data ? `${data.scanned}/${data.universe} scanned · ${ageLabel(data.ts)} ago` : ''}
              {data && data.warming > 0 ? ` · ${data.warming} warming` : ''}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <button type="button" onClick={() => onPickAsset?.(best.asset)} className="font-mono text-[12px] font-bold text-[#dbe4f0] underline decoration-[#24324a] underline-offset-2 hover:decoration-cyan-400" title="open this pair on the main chart">
              {best.asset}
            </button>
            {actionChip(best.action)}
            {best.otc && <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-px font-mono text-[8px] font-bold uppercase text-amber-300">OTC</span>}
            <span className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[8.5px] uppercase text-[#7c8aa5]">{best.regime}</span>
            {onOpenSignal && (
              <button type="button" onClick={() => onOpenSignal(best.asset)} className="rounded border border-cyan-500/40 px-1.5 py-px font-mono text-[8.5px] uppercase text-cyan-300 hover:bg-cyan-500/10" title="open the Signal clock for this pair">
                open signal
              </button>
            )}
            <span className="ml-auto font-mono text-[10px] text-[#7c8aa5]">strength {best.strength.toFixed(0)}{best.expiryLabel ? ` · ${best.expiryLabel}` : ''}</span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1">
        {(['actionable', 'buy', 'sell', 'all'] as ActionFilter[]).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setActionFilter(d)}
            className={`rounded border px-1.5 py-px font-mono text-[8.5px] uppercase ${actionFilter === d ? 'border-[#3d4d66] bg-[#132034] text-[#dbe4f0]' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'}`}
          >
            {d}
          </button>
        ))}
        <span className="mx-0.5 h-3 w-px bg-[#1c2739]" />
        {(['all', 'real', 'otc'] as ScopeFilter[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScopeFilter(s)}
            title={s === 'otc' ? 'OTC pairs only - filtered before the scan limit so they are never crowded out' : s === 'real' ? 'real-market pairs only' : 'everything open, real + OTC'}
            className={`rounded border px-1.5 py-px font-mono text-[8.5px] uppercase ${scopeFilter === s ? 'border-amber-500/50 bg-amber-500/10 text-amber-300' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'}`}
          >
            {s === 'otc' ? 'OTC' : s}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1">
        {shown.length === 0 && !err && (
          <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#4b5a72]">
            {data ? (actionFilter === 'actionable' ? 'nothing actionable right now - every pair reads WAIT (that is a normal state; the gates are strict)' : 'no rows for this filter') : 'scanning…'}
          </div>
        )}
        {shown.map((r) => (
          <div
            key={r.asset}
            role="button"
            tabIndex={0}
            onClick={() => onPickAsset?.(r.asset)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onPickAsset?.(r.asset) }}
            className="group flex items-center gap-2 rounded border border-[#1c2739] bg-[#0b111c] px-2 py-1 text-left hover:border-[#24324a]"
            title={`${r.asset} ${tfSel} · ${r.setup} · click to open on the chart`}
          >
            <span className="w-24 shrink-0 truncate font-mono text-[10px] font-bold text-[#dbe4f0] group-hover:text-cyan-300">{r.asset}</span>
            {r.otc && <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[7px] font-bold uppercase text-amber-300">OTC</span>}
            {actionChip(r.action)}
            {needleBar(r.needle, r.action)}
            <span className="shrink-0 rounded border border-[#1c2739] px-1 py-px font-mono text-[7.5px] uppercase text-[#7c8aa5]">{r.regime}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[8px] text-[#4b5a72]">{r.setup}{r.expiryLabel ? ` · ${r.expiryLabel}` : ''}</span>
            {onOpenSignal && (
              <button type="button" onClick={(e) => { e.stopPropagation(); onOpenSignal(r.asset) }} className="shrink-0 rounded border border-cyan-500/40 px-1 py-px font-mono text-[7.5px] uppercase text-cyan-300 hover:bg-cyan-500/10" title="open the Signal clock for this pair">
                signal
              </button>
            )}
            <span className="flex shrink-0 items-center gap-2 font-mono text-[8px] text-[#4b5a72]">
              <span className="text-[#3d4d66]">{fmtPrice(r.price, r.asset)}</span>
              <span>{ageLabel(r.ts)}</span>
            </span>
          </div>
        ))}
        {data && data.warming > 0 && actionFilter !== 'actionable' && (
          <div className="rounded border border-dashed border-[#1c2739] px-2 py-1 font-mono text-[8px] text-[#3d4d66]">
            {data.warming} pair{data.warming > 1 ? 's' : ''} still warming up (need 60+ closed bars) - they join the board as their feeds fill
          </div>
        )}
      </div>
    </div>
  )
}
