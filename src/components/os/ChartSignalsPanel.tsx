'use client'

// IQAIR//OS - Chart Signals sidebar. The chart-type engines (renko, P&F,
// range bars, tick bars, footprint / OTC velocity footprint, Heikin Ashi,
// candlestick math) vote on every open instrument in the kernel; this panel
// renders the top-5 strongest confluence reads. Option tab = direction +
// suggested expiry; CFD tab = the same read with entry / SL / TP levels.
// Signals carry a kernel-side TTL - stale reads disappear instead of
// lingering (the list is recomputed every scan, never cached client-side).
// Task 64-b: each card carries a take action - the read loads straight
// into the trade ticket (kind + expiry, or entry/SL/TP as move-%), the
// operator still presses the side button to actually place the order.
import { useCallback, useEffect, useState } from 'react'
import type { ChartSignal, ChartSignalsResponse } from '@/lib/os/client'
import { CHART_ENGINE_LABEL, fmtPrice, getChartSignals } from '@/lib/os/client'

interface ChartSignalsPanelProps {
  onClose: () => void
  onSelectAsset?: (asset: string) => void
  onTake?: (signal: ChartSignal, tab: Tab) => void
}

type Tab = 'option' | 'cfd'

function rrOf(s: ChartSignal): number | null {
  if (!s.cfd) return null
  const risk = Math.abs(s.cfd.entry - s.cfd.sl)
  const reward = Math.abs(s.cfd.tp - s.cfd.entry)
  return risk > 0 ? reward / risk : null
}

function dirChip(direction: 'call' | 'put') {
  const call = direction === 'call'
  return (
    <span
      className={`rounded px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-wider ${
        call ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
      }`}
    >
      {call ? '▲ call' : '▼ put'}
    </span>
  )
}

function StrengthBar({ s }: { s: ChartSignal }) {
  const pos = s.direction === 'call'
  return (
    <div className="h-1 w-full overflow-hidden rounded bg-[#101828]" title={`net score ${s.score} (${s.agree}/${s.total} engines agree)`}>
      <div className={`h-full ${pos ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ width: `${Math.max(6, s.strength)}%` }} />
    </div>
  )
}

function EngineChips({ s }: { s: ChartSignal }) {
  return (
    <div className="flex flex-wrap gap-1">
      {s.votes.map((v) => {
        const dim = v.dir === 0
        const agree = v.dir === (s.direction === 'call' ? 1 : -1)
        return (
          <span
            key={v.engine}
            title={`${CHART_ENGINE_LABEL[v.engine]}: ${v.note}`}
            className={`rounded border px-1 py-px font-mono text-[8px] uppercase tracking-wide ${
              dim
                ? 'border-[#1c2739] text-[#3d4d66]'
                : agree
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
            }`}
          >
            {CHART_ENGINE_LABEL[v.engine]}
            {!dim && (v.weight >= 0.7 ? '·●' : v.weight >= 0.5 ? '·◑' : '·○')}
          </span>
        )
      })}
    </div>
  )
}

function SignalCard({ s, now, tab, onSelectAsset, onTake }: { s: ChartSignal; now: number; tab: Tab; onSelectAsset?: (a: string) => void; onTake?: (sig: ChartSignal, t: Tab) => void }) {
  const ageSec = Math.max(0, Math.round((now - s.ts) / 1000))
  const remainSec = Math.round((s.validUntil - now) / 1000)
  // fade as the read approaches its TTL - gone entirely once expired
  const opacity = remainSec <= 0 ? 0 : remainSec < 45 ? 0.35 + (remainSec / 45) * 0.65 : 1
  const expiryMin = Math.round(s.expirySec / 60)
  const rr = rrOf(s)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(s.asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(s.asset)
      }}
      style={{ opacity }}
      className="w-full cursor-pointer rounded-lg border border-[#1c2739] bg-[#0b111c] p-2 text-left transition-opacity hover:border-cyan-500/40"
      title={`open ${s.asset} on the chart - valid ${remainSec}s more`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {dirChip(s.direction)}
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{s.asset}</span>
        {s.otc && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400">otc</span>
        )}
        <span className="font-mono text-[9px] text-[#4b5a72]">{fmtPrice(s.price, s.asset)}</span>
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">
          {s.agree}/{s.total} · {ageSec}s
        </span>
      </div>
      <div className="mt-1.5">
        <StrengthBar s={s} />
      </div>
      {tab === 'option' ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-cyan-300" title="suggested expiry from the dominant chart cadence + confluence strength">
            ~{expiryMin}m expiry
          </span>
          <span className="font-mono text-[9px] text-[#7c8aa5]">strength {s.strength}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onTake?.(s, 'option')
            }}
            className="ml-auto rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-emerald-300 transition-colors hover:bg-emerald-500/25"
            title="load this read into the trade ticket - kind + expiry pre-filled, you press the side button"
          >
            take →
          </button>
        </div>
      ) : (
        <>
          <div className="mt-1.5 grid grid-cols-3 gap-1 font-mono text-[9px]">
            <div>
              <div className="text-[8px] uppercase text-[#4b5a72]">entry</div>
              <div className="text-[#dbe4f0]">{fmtPrice(s.cfd?.entry ?? s.price, s.asset)}</div>
            </div>
            <div>
              <div className="text-[8px] uppercase text-[#4b5a72]">stop</div>
              <div className="text-rose-300">{fmtPrice(s.cfd?.sl ?? 0, s.asset)}</div>
            </div>
            <div>
              <div className="text-[8px] uppercase text-[#4b5a72]">target</div>
              <div className="text-emerald-300">{fmtPrice(s.cfd?.tp ?? 0, s.asset)}</div>
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            {rr !== null && (
              <span className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] text-[#7c8aa5]" title="reward / risk of the plan - floor is 1.5 by construction">
                RR {rr.toFixed(2)}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onTake?.(s, 'cfd')
              }}
              className="ml-auto rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-emerald-300 transition-colors hover:bg-emerald-500/25"
              title="load the plan into the CFD ticket - TP/SL arrive as move-% levels, you press the side button"
            >
              take plan →
            </button>
          </div>
        </>
      )}
      <div className="mt-1.5">
        <EngineChips s={s} />
      </div>
    </div>
  )
}

export default function ChartSignalsPanel({ onClose, onSelectAsset, onTake }: ChartSignalsPanelProps) {
  const [tab, setTab] = useState<Tab>('option')
  const [data, setData] = useState<ChartSignalsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setBusy(true)
      getChartSignals(tab, 5)
        .then((d) => {
          if (d?.ok) {
            setData(d)
            setError(null)
          }
        })
        .catch((e: Error) => setError(e.message.slice(0, 180)))
        .finally(() => setBusy(false))
    },
    [tab],
  )

  useEffect(() => {
    load()
    const iv = setInterval(() => load({ quiet: true }), 6000)
    return () => clearInterval(iv)
  }, [load])

  // 1s ticker drives age + fade rendering between polls
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])

  const signals = (data?.signals ?? []).filter((s) => s.validUntil > now)

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1 border-b border-[#1c2739] px-2 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Chart Signals</span>
        {(
          [
            ['option', 'Option'],
            ['cfd', 'CFD'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
              tab === t ? 'bg-cyan-500/15 text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
          >
            {label}
          </button>
        ))}
        {data && (
          <span className="ml-auto font-mono text-[8px] text-[#4b5a72]" title="instruments scanned per pass · scan duration">
            {data.scanned} scanned · {data.scanMs}ms
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          title="close the signals sidebar (market watch + indicators return)"
          className="ml-1 flex h-5 w-5 items-center justify-center rounded border border-[#1c2739] font-mono text-[11px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
        >
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && signals.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {data
              ? `No qualifying reads right now - ${data.considered} instruments had enough history, none reached the 7-engine confluence floor (strength >= 35, >= 3 engines agreeing). Fresh reads appear here automatically.`
              : 'Scanning the market with the chart engines (renko, P&F, range, tick, footprint, Heikin Ashi, candles)...'}
          </div>
        )}
        {signals.map((s) => (
          <SignalCard key={`${s.asset}-${s.ts}`} s={s} now={now} tab={tab} onSelectAsset={onSelectAsset} onTake={onTake} />
        ))}
        {data && data.signals.length > 0 && (
          <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
            {tab === 'option'
              ? 'Direction + suggested expiry from chart-type confluence. Real pairs read the volume footprint (CLV proxy), OTC pairs the micro-tick velocity footprint.'
              : 'Same chart-engine read, expressed as a CFD plan: entry at last close, stop beyond the recent swing (ATR floor), target at >= 1.5R.'}
            {' '}Click a card to open that asset on the chart - take loads it into the trade ticket.
          </p>
        )}
      </div>
    </div>
  )
}
