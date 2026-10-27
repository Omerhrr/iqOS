'use client'

// IQAIR//OS - Tempo panel (single pair, follows the chart)
// The patience engine for the asset on the chart: a 10-bar hunting window
// clock, the pair's per-bar conviction trace of the CURRENT window, the
// patience bar each reading has to beat (the pair's own recent window-max
// rhythm scaled by the bars still to come), the live decision (fire /
// wait / skip / done with the exact reason), the spent shot when the
// license is used, and the pair's resolved shot record. Backed by
// /tempo_scan (plugins/tempo.ts, analytics/tempo.ts) filtered to this
// asset - scanning never spends the license, only the auto-trader's
// 'tempo' source claims shots.

import { useCallback, useEffect, useState } from 'react'
import type { TempoRow, Timeframe } from '@/lib/os/client'
import { fmtPrice, getTempoScan } from '@/lib/os/client'

interface TempoPanelProps {
  asset: string
  tf: Timeframe
  /** bumps on every closed candle - keeps the window state fresh */
  closedTick?: number
  onClose: () => void
}

const POLL_MS = 8_000
const LIMIT = 150 // scan wide enough to always include the chart's pair

function decisionBanner(row: TempoRow) {
  const map: Record<TempoRow['decision'], { cls: string; label: string }> = {
    fire: { cls: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300', label: '● FIRE - THIS BAR IS THE SHOT' },
    done: { cls: 'border-sky-500/40 bg-sky-500/10 text-sky-300', label: 'LICENSE SPENT - SHOT TAKEN' },
    wait: { cls: 'border-[#1c2739] bg-[#0b111c] text-[#7c8aa5]', label: 'WAITING - NOT THE SUREST BAR YET' },
    skip: { cls: 'border-[#1c2739] bg-[#0b111c] text-[#4b5a72]', label: 'BELOW FLOOR - NOT WORTH THE LICENSE' },
  }
  const c = map[row.decision]
  return (
    <div className={`rounded border px-2 py-1.5 ${c.cls}`}>
      <div className="font-mono text-[10px] font-bold uppercase tracking-wider">{c.label}</div>
      <p className="mt-0.5 font-mono text-[8.5px] leading-relaxed opacity-80">{row.decisionReason}</p>
    </div>
  )
}

export default function TempoPanel({ asset, tf, closedTick, onClose }: TempoPanelProps) {
  const [row, setRow] = useState<TempoRow | null>(null)
  const [meta, setMeta] = useState<{ window: { index: number; barIndex: number; barsRemaining: number; endsAt: number }; firing: number; scanned: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [, forceTick] = useState(0)

  const load = useCallback(async () => {
    try {
      const res = await getTempoScan(tf, { limit: LIMIT })
      if (res.ok && res.rows) {
        const mine = res.rows.find((r) => r.asset === asset) ?? null
        setRow(mine)
        setMeta({ window: res.window, firing: res.firing, scanned: res.scanned })
        setErr(null)
      } else {
        setErr(res.error ?? 'tempo unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [asset, tf])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    const tick = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => {
      clearInterval(t)
      clearInterval(tick)
    }
  }, [load, closedTick])

  const now = Date.now()
  const leftMs = row && row.windowEndsAt > 0 ? Math.max(0, row.windowEndsAt - now) : meta ? Math.max(0, meta.window.endsAt - now) : 0
  const leftLabel = leftMs >= 60_000 ? `${Math.floor(leftMs / 60_000)}m${Math.round((leftMs % 60_000) / 1000)}s` : `${Math.round(leftMs / 1000)}s`
  const barNow = row && row.ok ? row.barIndex : meta ? meta.window.barIndex : 0

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Tempo</h3>
        <span className="truncate font-mono text-[10px] font-bold text-fuchsia-300">{asset}</span>
        <span className="font-mono text-[9px] text-[#7c8aa5]">one shot per 10 bars · {tf} expiry</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
        >
          ✕
        </button>
      </div>

      {err && <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5 font-mono text-[9px] text-rose-300">{err}</div>}

      {/* the window clock: which of the 10 bars are we hunting in */}
      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
        <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
          <span>hunting window</span>
          <span className="normal-case">
            {row?.ok ? <>bar {row.barIndex + 1}/10 · license expires in {leftLabel}</> : `bar ${barNow + 1}/10 · ${leftLabel} left`}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-1">
          {Array.from({ length: 10 }, (_, i) => {
            const judged = !!row && i < (row.trace?.length ?? 0)
            const isNow = i === barNow
            const isShot = row?.fired && row.firedSignal && i === row.barIndex
            return (
              <div key={i} className="flex-1">
                <div
                  className={`h-6 rounded-sm border ${
                    isShot
                      ? 'border-emerald-400/70 bg-emerald-500/20'
                      : isNow
                        ? 'border-fuchsia-400/70 bg-fuchsia-500/20'
                        : judged
                          ? 'border-[#2a3850] bg-[#132034]'
                          : 'border-[#1c2739] bg-[#0b111c]'
                  }`}
                  title={isShot ? 'the bar the license was spent on' : isNow ? 'current bar being judged' : judged ? 'already judged this window' : 'still ahead'}
                />
                <div className="mt-0.5 text-center font-mono text-[7px] text-[#3d4d66]">{i + 1}</div>
              </div>
            )
          })}
        </div>
        <p className="mt-1 font-mono text-[8px] leading-relaxed text-[#3d4d66]">
          {row?.ok
            ? `this window: best conviction so far ${row.bestConviction.toFixed(1)} across ${row.trace.length} judged bar${row.trace.length === 1 ? '' : 's'} - the engine waits for the bar that beats the patience bar, then spends the license once`
            : 'warming up - the oracle needs 320+ closed bars on this timeframe before it can hunt'}
        </p>
      </div>

      {/* the decision */}
      {row?.ok ? (
        <>
          {decisionBanner(row)}

          <div className="grid grid-cols-2 gap-1.5">
            <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
              <div className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">conviction vs patience bar</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className={`font-mono text-lg font-bold leading-none ${row.conviction >= row.threshold ? 'text-emerald-300' : 'text-amber-300'}`}>{row.conviction.toFixed(1)}</span>
                <span className="font-mono text-[9px] text-[#4b5a72]">/ bar {row.threshold.toFixed(1)}</span>
              </div>
              <div className="relative mt-1.5 h-2 overflow-hidden rounded-full border border-[#1c2739] bg-[#0b111c]">
                <div
                  className={`h-full ${row.conviction >= row.threshold ? 'bg-emerald-500/70' : 'bg-amber-500/70'}`}
                  style={{ width: `${Math.min(100, row.conviction)}%` }}
                />
                <div className="absolute top-0 h-full w-px bg-cyan-300/80" style={{ left: `${Math.min(100, row.threshold)}%` }} />
              </div>
              <p className="mt-1 font-mono text-[8px] leading-relaxed text-[#3d4d66]">
                patience bar = the pair's own window-max rhythm scaled by the {row.barsRemaining} bar{row.barsRemaining === 1 ? '' : 's'} still to come
              </p>
            </div>
            <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
              <div className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">the fused read on this bar</div>
              <div className="mt-1 flex items-center gap-2">
                <span className={`font-mono text-lg font-bold leading-none ${row.direction === 'call' ? 'text-emerald-300' : row.direction === 'put' ? 'text-rose-300' : 'text-[#7c8aa5]'}`}>
                  {row.direction === 'none' ? '—' : row.direction === 'call' ? '▲ CALL' : '▼ PUT'}
                </span>
                <span className="font-mono text-[9px] text-[#aab6cc]">P(up) {(row.pUp * 100).toFixed(1)}%</span>
              </div>
              <div className="mt-1 font-mono text-[9px] text-[#7c8aa5]">
                conf {row.confidence.toFixed(0)}% · {row.driversActive} drivers · {row.regime}
              </div>
              <div className="mt-1 font-mono text-[9px] text-[#3d4d66]">
                {fmtPrice(row.price, asset)}
                {row.calibration ? ` · oracle record ${Math.round(row.calibration.hitRate * 100)}% of ${row.calibration.n}` : ' · oracle uncalibrated'}
              </div>
            </div>
          </div>

          {/* the per-bar trace of this window */}
          {row.trace.length > 0 && (
            <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
              <div className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">this window's readings</div>
              <div className="mt-1 flex flex-col gap-0.5">
                {[...row.trace].reverse().map((b) => (
                  <div key={b.barTime} className="flex items-center gap-2 font-mono text-[8.5px]">
                    <span className="w-10 shrink-0 text-[#3d4d66]">{new Date(b.barTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    <span className={b.direction === 'call' ? 'text-emerald-300/80' : b.direction === 'put' ? 'text-rose-300/80' : 'text-[#4b5a72]'}>{b.direction === 'none' ? '—' : b.direction.toUpperCase()}</span>
                    <span className="text-[#7c8aa5]">conv {b.conviction.toFixed(1)}</span>
                    <span className="text-[#3d4d66]">conf {b.confidence.toFixed(0)}% · pUp {(b.pUp * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* shot record */}
          <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
            <div className="flex items-center justify-between font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">
              <span>this pair's tempo record</span>
              {row.shotStats && row.shotStats.n > 0 && row.shotStats.hitRate !== null && (
                <span className={`normal-case ${row.shotStats.hitRate >= 0.55 ? 'text-emerald-300/80' : 'text-amber-300/80'}`}>
                  {row.shotStats.n} shots · {(row.shotStats.hitRate * 100).toFixed(0)}% winners
                </span>
              )}
            </div>
            {row.lastShot ? (
              <p className={`mt-1 font-mono text-[9px] ${row.lastShot.hit ? 'text-emerald-300' : 'text-rose-300'}`}>
                last shot: {row.lastShot.direction.toUpperCase()} conviction {row.lastShot.conviction.toFixed(1)} - {row.lastShot.hit ? 'WON' : 'LOST'} ({Math.round((now - row.lastShot.resolvedTs) / 1000)}s ago)
              </p>
            ) : (
              <p className="mt-1 font-mono text-[9px] text-[#4b5a72]">no shots resolved yet - the engine only trades when a window's surest bar clears the patience bar</p>
            )}
          </div>

          {meta && meta.firing > 0 && (
            <p className="font-mono text-[8px] text-[#3d4d66]">
              {meta.firing} pair{meta.firing > 1 ? 's' : ''} firing board-wide right now - the auto-trader's Tempo source claims the strongest ({meta.scanned} scanned)
            </p>
          )}
        </>
      ) : (
        !err && (
          <div className="rounded border border-dashed border-[#1c2739] p-2 font-mono text-[9px] text-[#4b5a72]">
            {row ? row.note : 'waiting for the first tempo scan of this pair'}
          </div>
        )
      )}
    </div>
  )
}
