'use client'

// IQAIR//OS - Accute panel (multi-model prediction fusion)
// Used to be a strict confluence gate - now a weighted log-odds fusion
// across up to 5 independent drivers (ADX/DI + Pattern Bias, Tempo, the
// Next-Candle Oracle, the support/resistance zone, Renko trend), the same
// shape the Next-Candle Oracle itself produces: pUp/confidence/direction,
// not a unanimous-agreement requirement. Shows every active driver's own
// read so the operator can see what's actually feeding the fused number.
// Backed by index.ts's /accute + /accute_stats
// (analytics/accute.ts, plugins/accute.ts).

import { useCallback, useEffect, useState } from 'react'
import type { AccuteDriver, AccuteDriverName, AccuteSignal, AccuteStatsResponse, Timeframe } from '@/lib/os/client'
import { fmtPrice, getAccute, getAccuteStats } from '@/lib/os/client'

interface AccutePanelProps {
  asset: string
  tf: Timeframe
  closedTick?: number
  onClose: () => void
  /** cross-nav: jump straight to the Next-Candle Oracle for this same asset */
  onOpenOracle?: (asset: string) => void
}

const FALLBACK_POLL_MS = 10_000
const DRIVER_LABELS: Record<AccuteDriverName, string> = { adxPattern: 'ADX/DI + Pattern', tempo: 'Tempo', oracle: 'Next-Candle Oracle', zone: 'S/R zone', renko: 'Renko trend' }

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

/** pUp bar, same idea as the Oracle panel's own probBar() - how much of
 * the fused weight leans up vs down. */
function pUpBar(pUp: number) {
  const upPct = Math.round(pUp * 100)
  return (
    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#1c2739]">
      <div className="h-full bg-gradient-to-r from-rose-500/70 to-emerald-500/70" style={{ width: `${upPct}%` }} />
    </div>
  )
}

function driverCard(d: AccuteDriver) {
  const none = d.vote === 0
  return (
    <div key={d.name} className={`rounded-lg border p-2 ${none ? 'border-[#1c2739] bg-[#0b111c]' : d.vote > 0 ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/30 bg-rose-500/5'}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]">{DRIVER_LABELS[d.name]}</span>
        <span className="font-mono text-[8px] text-[#4b5a72]">weight {d.weight.toFixed(1)}</span>
      </div>
      <p className="mt-1 font-mono text-[8.5px] leading-relaxed text-[#4b5a72]">{d.label}</p>
    </div>
  )
}

export default function AccutePanel({ asset, tf, closedTick, onClose, onOpenOracle }: AccutePanelProps) {
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
        <span className="font-mono text-[9px] text-[#7c8aa5]">{asset} · {tf} · prediction fusion</span>
        {onOpenOracle && (
          <button
            type="button"
            onClick={() => onOpenOracle(asset)}
            className="ml-auto rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-amber-500/40 hover:text-amber-300"
            title="open Next-Candle Oracle for this asset"
          >
            → oracle
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className={`rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300 ${onOpenOracle ? '' : 'ml-auto'}`}
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
              <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{signal.confidence.toFixed(0)}%</span>
            </div>
            {pUpBar(signal.pUp)}
            <p className="mt-1.5 flex justify-between font-mono text-[7.5px] text-[#4b5a72]"><span>PUT {(100 - signal.pUp * 100).toFixed(0)}%</span><span>CALL {(signal.pUp * 100).toFixed(0)}%</span></p>
            <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-[#7c8aa5]">{signal.summary}</p>
            {signal.price > 0 && (
              <p className="mt-1 font-mono text-[8px] text-[#3d4d66]">price {fmtPrice(signal.price, asset)} · {signal.driversActive}/5 drivers active · {(signal.agreement * 100).toFixed(0)}% weight agreeing</p>
            )}
          </div>

          {/* every active driver's own read */}
          <div className="grid grid-cols-1 gap-1.5">
            {signal.drivers.map((d) => driverCard(d))}
            {signal.drivers.length === 0 && (
              <p className="font-mono text-[8px] text-[#3d4d66]">no driver has anything to say yet - warming up</p>
            )}
          </div>

          {/* S/R zone and Renko detail - only shown in the drivers list
              above when actually active (nonzero weight); these two cards
              always show the underlying read either way, since "no zone
              right now" is itself useful context even though it isn't a
              driver this bar. */}
          {signal.zone.side === 'none' && (
            <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
              <span className="font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]">S/R zone</span>
              <p className="mt-1 font-mono text-[8.5px] leading-relaxed text-[#4b5a72]">{signal.zone.label} - not a driver this bar</p>
            </div>
          )}
          {signal.renko.trend === 'none' && (
            <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
              <span className="font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]">Renko trend</span>
              <p className="mt-1 font-mono text-[8.5px] leading-relaxed text-[#4b5a72]">{signal.renko.label} - not a driver this bar</p>
            </div>
          )}

          {/* self-adaptive confidence gate: this pair's own session+regime bucket */}
          <div className={`rounded-lg border p-2 ${signal.adaptive.overridden ? 'border-rose-500/40 bg-rose-500/5' : 'border-[#1c2739] bg-[#0b111c]'}`}>
            <div className="flex items-center justify-between">
              <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">adaptive gate · {signal.adaptive.session} · {signal.adaptive.regime}</p>
              <span className="font-mono text-[8px] text-[#7c8aa5]">confidence floor {signal.adaptive.minConfidenceUsed}</span>
            </div>
            {signal.adaptive.overridden && (
              <p className="mt-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-rose-300">standing aside - bucket proven unreliable</p>
            )}
            <p className="mt-0.5 font-mono text-[8.5px] leading-relaxed text-[#7c8aa5]">{signal.adaptive.note}</p>
          </div>

          {/* this pair's own resolved record */}
          {signal.calibration && (
            <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
              <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">this pair's own record</p>
              <p className="mt-0.5 font-mono text-[9px] text-[#dbe4f0]">
                {signal.calibration.n} resolved fused signal{signal.calibration.n === 1 ? '' : 's'} ·{' '}
                <span className={signal.calibration.hitRate >= 0.55 ? 'text-emerald-300' : 'text-amber-300'}>{(signal.calibration.hitRate * 100).toFixed(0)}% hit rate</span>
              </p>
            </div>
          )}
          {!signal.calibration && (
            <p className="font-mono text-[8px] text-[#3d4d66]">no resolved fused signals on this pair yet</p>
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
              {stats.buckets.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {stats.buckets.slice(0, 6).map((b) => (
                    <span
                      key={b.bucket}
                      title={`${b.bucket}: ${b.n} resolved, ${(b.hitRate * 100).toFixed(0)}% hit rate`}
                      className={`rounded border px-1 py-px font-mono text-[7.5px] ${b.hitRate < 0.5 ? 'border-amber-500/40 text-amber-300' : 'border-emerald-500/30 text-emerald-300'}`}
                    >
                      {b.bucket} · {(b.hitRate * 100).toFixed(0)}%
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="shrink-0 font-mono text-[8px] leading-relaxed text-[#3d4d66]">
            Accute invents no new math - it fuses up to 5 independent drivers (ADX/DI + Pattern Bias, Tempo, the Next-Candle Oracle, the S/R buy/sell zone, Renko trend) into one weighted prediction, the same log-odds blend the Next-Candle Oracle itself uses, not a unanimous-agreement gate. Zone and Renko are deliberately sparse - they only become drivers when actually active, and simply sit out otherwise rather than blocking anything. Tempo's own weight rises specifically while it's actively firing this bar (its raw lean is the Oracle's own lean passed through, so it's correlation-discounted against the Oracle driver rather than double-counted). The only thing that can still force WAITING is the self-adaptive confidence floor - this exact pair/time-of-day/regime bucket's own resolved record (a volatility spike bumps the floor up by default) - a combo that's proven itself wrong enough times gets its floor raised, or stands aside outright regardless of how the drivers lean.
          </p>
        </>
      )}

      {!signal && !err && (
        <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#4b5a72]">loading…</div>
      )}
    </div>
  )
}
