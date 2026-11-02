'use client'

// IQAIR//OS - Accute panel (triple-confluence confirmation)
// The strictest signal in the catalog: combines ADX/DI + Pattern Bias,
// Tempo (actively firing this bar, not merely leaning a direction), and
// the Next-Candle Oracle fusion. Shows CALL/PUT only when all three agree
// right now; otherwise WAITING, with each leg's own read so the operator
// can see exactly which engine is holding things up.
// Backed by index.ts's /accute + /accute_stats
// (analytics/accute.ts, plugins/accute.ts).

import { useCallback, useEffect, useState } from 'react'
import type { AccuteLegName, AccuteSignal, AccuteStatsResponse, Timeframe } from '@/lib/os/client'
import { fmtPrice, getAccute, getAccuteStats } from '@/lib/os/client'

interface AccutePanelProps {
  asset: string
  tf: Timeframe
  closedTick?: number
  onClose: () => void
}

const FALLBACK_POLL_MS = 10_000
const LEG_LABELS: Record<AccuteLegName, string> = { adxPattern: 'ADX/DI + Pattern', tempo: 'Tempo (firing)', oracle: 'Next-Candle Oracle' }
const LEG_ORDER: AccuteLegName[] = ['adxPattern', 'tempo', 'oracle']

function dirChip(direction: 'call' | 'put' | 'none', size: 'lg' | 'sm' = 'sm') {
  const none = direction === 'none'
  const call = direction === 'call'
  const cls = none
    ? 'border-[#3d4d66] text-[#7c8aa5]'
    : call
      ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
      : 'border-rose-500/50 bg-rose-500/15 text-rose-300'
  const text = size === 'lg' ? 'text-[13px] px-3 py-1.5' : 'text-[8.5px] px-1.5 py-px'
  return (
    <span className={`inline-flex items-center gap-1 rounded border font-mono font-bold uppercase tracking-wider ${cls} ${text}`}>
      {none ? (size === 'lg' ? 'WAITING' : '—') : call ? '▲ CALL' : '▼ PUT'}
    </span>
  )
}

function legCard(name: AccuteLegName, leg: AccuteSignal['legs'][AccuteLegName]) {
  const none = leg.direction === 'none'
  return (
    <div key={name} className={`rounded-lg border p-2 ${none ? 'border-[#1c2739] bg-[#0b111c]' : leg.direction === 'call' ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/30 bg-rose-500/5'}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]">{LEG_LABELS[name]}</span>
        {dirChip(leg.direction)}
      </div>
      <p className="mt-1 font-mono text-[8.5px] leading-relaxed text-[#4b5a72]">{leg.label}</p>
    </div>
  )
}

export default function AccutePanel({ asset, tf, closedTick, onClose }: AccutePanelProps) {
  const [signal, setSignal] = useState<AccuteSignal | null>(null)
  const [stats, setStats] = useState<AccuteStatsResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await getAccute(asset, tf)
      if (res.ok && res.signal) {
        setSignal(res.signal)
        setErr(null)
      } else {
        setErr(res.error ?? 'accute unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [asset, tf])

  const loadStats = useCallback(async () => {
    try {
      const d = await getAccuteStats()
      if (d.ok) setStats(d)
    } catch {
      // learned-stats strip is optional - never block the panel on it
    }
  }, [])

  useEffect(() => {
    void load()
    void loadStats()
    const t = setInterval(() => void load(), FALLBACK_POLL_MS)
    const s = setInterval(() => void loadStats(), FALLBACK_POLL_MS * 3)
    return () => {
      clearInterval(t)
      clearInterval(s)
    }
  }, [load, loadStats, closedTick])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-violet-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Accute</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">{asset} · {tf} · triple confluence</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
        >
          ✕
        </button>
      </div>

      {err && <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5 font-mono text-[9px] text-rose-300">{err}</div>}

      {signal && (
        <>
          {/* the verdict */}
          <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3 text-center">
            <div className="flex items-center justify-center gap-2">
              {dirChip(signal.direction, 'lg')}
            </div>
            <p className="mt-2 font-mono text-[9px] leading-relaxed text-[#7c8aa5]">{signal.summary}</p>
            {signal.price > 0 && (
              <p className="mt-1 font-mono text-[8px] text-[#3d4d66]">price {fmtPrice(signal.price, asset)}</p>
            )}
          </div>

          {/* the three legs */}
          <div className="grid grid-cols-1 gap-1.5">
            {LEG_ORDER.map((name) => legCard(name, signal.legs[name]))}
          </div>

          {/* this pair's own resolved record */}
          {signal.calibration && (
            <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
              <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">this pair's own record</p>
              <p className="mt-0.5 font-mono text-[9px] text-[#dbe4f0]">
                {signal.calibration.n} resolved 3-way-agreement signal{signal.calibration.n === 1 ? '' : 's'} ·{' '}
                <span className={signal.calibration.hitRate >= 0.55 ? 'text-emerald-300' : 'text-amber-300'}>{(signal.calibration.hitRate * 100).toFixed(0)}% hit rate</span>
              </p>
            </div>
          )}
          {!signal.calibration && (
            <p className="font-mono text-[8px] text-[#3d4d66]">no resolved 3-way-agreement signals on this pair yet - this is deliberately the rarest signal in the catalog</p>
          )}

          {/* fleet-wide ledger */}
          {stats && (
            <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
              <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">fleet-wide ledger</p>
              <p className="mt-0.5 font-mono text-[9px] text-[#dbe4f0]">
                {stats.total} resolved · {stats.pending} pending{' '}
                {stats.hitRate !== null && (
                  <span className={stats.hitRate >= 0.55 ? 'text-emerald-300' : 'text-amber-300'}>· {(stats.hitRate * 100).toFixed(0)}% overall</span>
                )}
              </p>
            </div>
          )}

          <p className="shrink-0 font-mono text-[8px] leading-relaxed text-[#3d4d66]">
            Accute invents no new math - it only fires when ADX/DI + Pattern Bias, Tempo's one-shot stopping rule (actually firing, not just leaning), and the Next-Candle Oracle fusion all agree on direction right now. Any one leg sitting idle, or any disagreement, is WAITING. Expect this to trade rarely - that is the point.
          </p>
        </>
      )}

      {!signal && !err && (
        <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#4b5a72]">loading…</div>
      )}
    </div>
  )
}
