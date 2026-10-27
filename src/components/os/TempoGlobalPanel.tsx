'use client'

// IQAIR//OS - Tempo Global panel
// The patience engine lifted to the whole universe. Every 10-bar window is
// a hunting license for exactly ONE shot per pair - the bar whose fused
// next-candle conviction is surest - so on 1m the whole board fires at most
// 6 times an hour, on 2m 3 times, expiry always = 1 bar of the signal tf.
// Backed by /tempo_scan (plugins/tempo.ts): fusion reads come from the
// Next-Candle Oracle's own board (shared TTL cache + one honesty ledger),
// and the tempo layer adds the window clock, the pair's own patience bar
// (its recent window-max rhythm scaled by the bars still to come) and the
// decision: fire / wait / skip / done.
//
// Scanning NEVER spends a license - only the auto-trader's 'tempo' source
// claims shots (atomic claim, first consumer wins).

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TempoRow, Timeframe } from '@/lib/os/client'
import { fmtPrice, getTempoScan } from '@/lib/os/client'

interface TempoGlobalPanelProps {
  /** active chart timeframe - the board starts there but can switch */
  tf: Timeframe
  /** bumps on every closed candle of the active chart - drives refresh */
  closedTick?: number
  /** switch the main chart to a row's pair */
  onPickAsset?: (asset: string) => void
  onClose: () => void
}

const POLL_MS = 8_000
const TFS: Timeframe[] = ['1m', '2m', '5m']
const LIMIT = 40

type Decision = TempoRow['decision']

function decisionChip(d: Decision) {
  const map: Record<Decision, { cls: string; label: string }> = {
    fire: { cls: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300', label: '● FIRE' },
    done: { cls: 'border-sky-500/40 bg-sky-500/10 text-sky-300', label: 'shot taken' },
    wait: { cls: 'border-[#3d4d66] text-[#7c8aa5]', label: 'waiting' },
    skip: { cls: 'border-[#24324a] text-[#3d4d66]', label: 'below floor' },
  }
  const c = map[d]
  return (
    <span className={`rounded border px-1 py-px font-mono text-[7.5px] font-bold uppercase tracking-wider ${c.cls}`}>{c.label}</span>
  )
}

function dirChip(direction: string) {
  const call = direction === 'call'
  const none = direction === 'none'
  const cls = none
    ? 'border-[#3d4d66] text-[#7c8aa5]'
    : call
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
      : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
  return (
    <span className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-wider ${cls}`}>
      {none ? '—' : call ? '▲ call' : '▼ put'}
    </span>
  )
}

/** conviction (0-100) with the patience bar drawn as a tick mark it must beat */
function convictionBar(conviction: number, threshold: number) {
  const hue = conviction >= threshold && threshold > 0 ? 'bg-emerald-500/70' : conviction > 0 ? 'bg-amber-500/70' : 'bg-[#24324a]'
  return (
    <div className="flex items-center gap-1">
      <div className="relative h-1.5 w-12 overflow-hidden rounded-full border border-[#1c2739] bg-[#0b111c]">
        <div className={`h-full ${hue}`} style={{ width: `${Math.min(100, Math.max(0, conviction))}%` }} />
        {threshold > 0 && (
          <div className="absolute top-0 h-full w-px bg-cyan-300/80" style={{ left: `${Math.min(100, threshold)}%` }} title={`patience bar ${threshold.toFixed(1)}`} />
        )}
      </div>
      <span className={`font-mono text-[9px] ${conviction >= threshold && threshold > 0 ? 'text-emerald-300' : 'text-amber-300'}`}>{conviction.toFixed(1)}</span>
    </div>
  )
}

function windowClock(row: TempoRow) {
  // 10 segment clock of the pair's window
  const filled = row.ok ? row.barIndex + 1 : 0
  return (
    <span className="inline-flex items-center gap-px" title={`window bar ${filled}/10 - ${row.barsRemaining} bar${row.barsRemaining === 1 ? '' : 's'} left before the license expires`}>
      {Array.from({ length: 10 }, (_, i) => (
        <span
          key={i}
          className={`h-2 w-1 rounded-sm ${
            i < filled
              ? row.fired && row.firedSignal && i === row.barIndex
                ? 'bg-emerald-400'
                : 'bg-[#2a3850]'
              : 'bg-[#132034]'
          }`}
        />
      ))}
      <span className="ml-1 font-mono text-[8px] text-[#4b5a72]">{row.ok ? `${row.barsRemaining} left` : '—'}</span>
    </span>
  )
}

function shotBadge(row: TempoRow) {
  const st = row.shotStats
  if (st && st.n > 0 && st.hitRate !== null) {
    const good = st.hitRate >= 0.55
    return (
      <span
        className={`font-mono text-[8px] ${good ? 'text-emerald-300/80' : 'text-amber-300/80'}`}
        title={`this pair's resolved tempo shots: ${st.n}, ${(st.hitRate * 100).toFixed(0)}% winners (flat excluded)`}
      >
        {st.n}·{(st.hitRate * 100).toFixed(0)}%
      </span>
    )
  }
  return <span className="font-mono text-[8px] uppercase tracking-wider text-[#3d4d66]" title="no resolved tempo shots on this pair yet">no shots</span>
}

export default function TempoGlobalPanel({ tf, closedTick, onPickAsset, onClose }: TempoGlobalPanelProps) {
  const [tfSel, setTfSel] = useState<Timeframe>(tf)
  const [rows, setRows] = useState<TempoRow[]>([])
  const [meta, setMeta] = useState<{ scanned: number; live: number; firing: number; window: TempoScanResponseSafe['window']; ts: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [, forceTick] = useState(0) // re-render for countdowns

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const res = await getTempoScan(tfSel, { limit: LIMIT })
      if (res.ok && res.rows) {
        setRows(res.rows)
        setMeta({ scanned: res.scanned, live: res.live, firing: res.firing, window: res.window, ts: res.ts })
        setErr(null)
      } else {
        setErr(res.error ?? 'tempo board unavailable')
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
    const age = setInterval(() => forceTick((n) => n + 1), 3000)
    return () => {
      clearInterval(t)
      clearInterval(age)
    }
  }, [load, closedTick, tfSel])

  const shown = useMemo(() => rows.filter((r) => r.ok), [rows])
  const firing = shown.filter((r) => r.decision === 'fire')
  const done = shown.filter((r) => r.decision === 'done')
  const waiting = shown.filter((r) => r.decision === 'wait' || r.decision === 'skip')
  const best = firing[0] ?? shown[0]

  const clockNow = Date.now()
  const windowLeftMs = meta ? Math.max(0, meta.window.endsAt - clockNow) : 0
  const leftLabel =
    windowLeftMs >= 60_000
      ? `${Math.floor(windowLeftMs / 60_000)}m${Math.round((windowLeftMs % 60_000) / 1000)}s`
      : `${Math.round(windowLeftMs / 1000)}s`

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Tempo Global</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">patience engine · {meta ? `${meta.firing} firing / ${meta.live} live` : '…'}</span>
        <div className="ml-auto flex items-center gap-1">
          {TFS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTfSel(t)}
              className={`rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase ${tfSel === t ? 'border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-300' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#7c8aa5]'}`}
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

      {err && (
        <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5 font-mono text-[9px] text-rose-300">{err}</div>
      )}

      {/* the window clock: analyze 10 bars, one shot, expiry = 1 bar */}
      {meta && (
        <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
          <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
            <span>
              window clock · {tfSel} · one shot per 10 bars · {tfSel} expiry
            </span>
            <span className="normal-case">
              {firing.length} firing · {done.length} shot taken · {waiting.length} waiting
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="inline-flex items-center gap-px">
              {Array.from({ length: 10 }, (_, i) => (
                <span key={i} className={`h-2.5 w-2.5 rounded-sm ${i <= meta.window.barIndex ? 'bg-fuchsia-400/80' : 'bg-[#132034]'}`} />
              ))}
            </span>
            <span className="font-mono text-[10px] text-[#aab6cc]">
              bar {meta.window.barIndex + 1}/10 · license expires in {leftLabel}
            </span>
          </div>
        </div>
      )}

      {/* strongest live shot, or the best window in progress */}
      {best && (
        <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
          <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
            <span>{best.decision === 'fire' ? 'live shot' : 'strongest window'}</span>
            {best.shotStats && <span className="normal-case text-[#3d4d66]">pair record {best.shotStats.n} shots</span>}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPickAsset?.(best.asset)}
              className="font-mono text-[12px] font-bold text-[#dbe4f0] underline decoration-[#24324a] underline-offset-2 hover:decoration-fuchsia-400"
              title="open this pair on the main chart"
            >
              {best.asset}
            </button>
            {dirChip(best.direction)}
            {decisionChip(best.decision)}
            <span className="ml-auto font-mono text-[10px] text-[#7c8aa5]">
              conviction <span className="text-fuchsia-300">{best.conviction.toFixed(1)}</span> vs bar {best.threshold.toFixed(1)}
              {' · '}P(up) <span className={best.pUp >= 0.5 ? 'text-emerald-300' : 'text-rose-300'}>{(best.pUp * 100).toFixed(1)}%</span>
            </span>
          </div>
          <p className="mt-1 font-mono text-[8px] text-[#3d4d66]">{best.decisionReason}</p>
        </div>
      )}

      {/* the board */}
      <div className="flex min-h-0 flex-1 flex-col gap-1">
        {shown.length === 0 && !err && (
          <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#4b5a72]">
            no live rows yet - the board reads the oracle's universe scan, give it a poll or two
          </div>
        )}
        {shown.map((r) => (
          <button
            key={r.asset}
            type="button"
            onClick={() => onPickAsset?.(r.asset)}
            className="group flex items-center gap-2 rounded border border-[#1c2739] bg-[#0b111c] px-2 py-1 text-left hover:border-[#24324a]"
            title={`${r.asset} ${r.tf} · ${r.decisionReason} · click to open on the chart`}
          >
            <span className="w-24 shrink-0 truncate font-mono text-[10px] font-bold text-[#dbe4f0] group-hover:text-fuchsia-300">{r.asset}</span>
            {dirChip(r.direction)}
            {decisionChip(r.decision)}
            {convictionBar(r.conviction, r.threshold)}
            {windowClock(r)}
            <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[8px] text-[#4b5a72]">
              {shotBadge(r)}
              <span className="text-[#3d4d66]">{fmtPrice(r.price, r.asset)}</span>
            </span>
          </button>
        ))}
      </div>

      <p className="shrink-0 font-mono text-[8px] leading-relaxed text-[#3d4d66]">
        analyze 10 bars · trade the 1 surest · 1-{tfSel.replace(/\d/, '')} expiry = 1 bar - scanning never spends a license; only the auto-trader's Tempo source claims shots. Patience bar (cyan tick) = the pair's own window-max rhythm scaled by the bars still to come.
      </p>
    </div>
  )
}

// local alias so the meta state type reads clean without exporting the response
type TempoScanResponseSafe = import('@/lib/os/client').TempoScanResponse
