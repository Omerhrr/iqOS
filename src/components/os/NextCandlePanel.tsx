'use client'

// IQAIR//OS - Next-Candle Oracle panel
// The fused multi-model forecast for the asset on the chart: P(next candle
// closes up), direction call, confidence, expected range cone, and the full
// driver breakdown (every model's own read + weight + one-line explanation).
// Backed by index.ts's /next_candle + /next_candle_stats
// (analytics/nextcandle.ts, plugins/nextcandle.ts).
//
// The panel auto-refreshes on every closed candle of the active asset/tf
// (closedTick prop bumps) plus a slow fallback poll, and shows the oracle's
// OWN resolved track record (hit rate / Brier / current streak) next to the
// forecast - an oracle that has been wrong lately visibly discounts itself.

import { useCallback, useEffect, useState } from 'react'
import type { NextCandlePrediction, NextCandleStatsResponse, OracleRecentResolution, Timeframe } from '@/lib/os/client'
import { fmtPrice, getNextCandle, getNextCandleStats } from '@/lib/os/client'

interface NextCandlePanelProps {
  asset: string
  tf: Timeframe
  /** bumps on every closed candle - keeps the prediction + record fresh */
  closedTick?: number
  onClose: () => void
}

const FALLBACK_POLL_MS = 15_000

function probBar(pUp: number) {
  const upPct = Math.round(pUp * 100)
  const call = pUp >= 0.5
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
        <span>p(next close up)</span>
        <span className={call ? 'text-emerald-300' : 'text-rose-300'}>{upPct}% / {100 - upPct}%</span>
      </div>
      <div className="mt-1 flex h-2.5 overflow-hidden rounded-full border border-[#1c2739] bg-[#0b111c]">
        <div className={`h-full ${call ? 'bg-emerald-500/70' : 'bg-[#132034]'}`} style={{ width: `${upPct}%` }} />
        <div className={`h-full ${call ? 'bg-[#132034]' : 'bg-rose-500/70'}`} style={{ width: `${100 - upPct}%` }} />
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[8px] text-[#3d4d66]">
        <span>0% up</span>
        <span>50</span>
        <span>100% up</span>
      </div>
    </div>
  )
}

function confRing(confidence: number) {
  const hue = confidence >= 60 ? 'text-emerald-300' : confidence >= 35 ? 'text-amber-300' : 'text-[#7c8aa5]'
  return (
    <div className="flex flex-col items-center">
      <span className={`font-mono text-lg font-bold leading-none ${hue}`}>{confidence.toFixed(0)}%</span>
      <span className="mt-0.5 font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">confidence</span>
    </div>
  )
}

function regimeChip(regime: string) {
  const color =
    regime === 'TRENDING' ? 'border-cyan-500/40 text-cyan-300' :
    regime === 'RANGING' ? 'border-violet-500/40 text-violet-300' :
    regime === 'VOLATILE' ? 'border-orange-500/40 text-orange-300' :
    'border-[#3d4d66] text-[#7c8aa5]'
  return (
    <span className={`rounded border px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-wider ${color}`}>{regime}</span>
  )
}

function dirBanner(p: NextCandlePrediction) {
  const call = p.direction === 'call'
  const none = p.direction === 'none'
  const cls = none
    ? 'border-[#1c2739] bg-[#0b111c] text-[#7c8aa5]'
    : call
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
      : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
  return (
    <div className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${cls}`}>
      <span className="font-mono text-base font-bold leading-none">{none ? '—' : call ? '▲' : '▼'}</span>
      <div className="flex flex-col">
        <span className="font-mono text-[11px] font-bold uppercase tracking-wider">{none ? 'no lean' : `next candle: ${p.direction}`}</span>
        <span className="font-mono text-[9px] text-[#7c8aa5]">
          exp |move| {fmtPrice(p.expectedMove, p.asset)} ({(p.expectedMove / Math.max(p.atr, 1e-9)).toFixed(2)}× ATR)
        </span>
      </div>
    </div>
  )
}

function RangeCone({ p }: { p: NextCandlePrediction }) {
  const lo = p.range.low
  const hi = p.range.high
  const span = hi - lo || 1e-9
  // expected close position inside the cone: direction lean from pUp, body
  // centered with wick room on both sides
  const bodyLo = ((p.price - span * (1 - p.bodyRatio) * 0.5 * 0.5) - lo) / span
  const bodyHi = bodyLo + (p.bodyRatio * span * 0.5) / span
  const closePos = Math.min(Math.max(p.closePos, 0.02), 0.98)
  return (
    <div className="mt-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
      <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
        <span>next-candle cone</span>
        <span className="normal-case text-[#7c8aa5]">{fmtPrice(lo, p.asset)} — {fmtPrice(hi, p.asset)}</span>
      </div>
      <div className="relative mt-2 h-14">
        {/* wick zone */}
        <div className="absolute inset-x-8 top-0 bottom-0 rounded bg-[#101828]" />
        {/* body zone */}
        <div
          className={`absolute inset-x-16 ${p.pUp >= 0.5 ? 'bg-emerald-500/25' : 'bg-rose-500/25'}`}
          style={{ top: `${(1 - bodyHi) * 100}%`, height: `${Math.max((bodyHi - bodyLo) * 100, 8)}%` }}
        />
        {/* spot line */}
        <div className="absolute inset-x-4 border-t border-dashed border-[#3d4d66]" style={{ top: '50%' }}>
          <span className="absolute -top-2 right-0 font-mono text-[8px] text-[#7c8aa5]">spot {fmtPrice(p.price, p.asset)}</span>
        </div>
        {/* expected close marker */}
        <div
          className={`absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${p.pUp >= 0.5 ? 'bg-emerald-400' : 'bg-rose-400'}`}
          style={{ left: '50%', top: `${(1 - closePos) * 100}%` }}
          title="expected close position inside the cone"
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[8px] text-[#3d4d66]">
        <span>low wick</span>
        <span>body {(p.bodyRatio * 100).toFixed(0)}% of range</span>
        <span>high wick</span>
      </div>
    </div>
  )
}

function CalibrationBadge({ cal }: { cal: NextCandlePrediction['calibration'] }) {
  if (!cal || cal.n === 0) {
    return (
      <span className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]" title="the oracle has no resolved predictions on this asset:tf yet">
        uncalibrated
      </span>
    )
  }
  const good = cal.hitRate >= 0.55 && cal.brier < 0.25
  return (
    <span
      className={`rounded border px-1.5 py-px font-mono text-[8px] uppercase tracking-wider ${good ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/40 text-amber-300'}`}
      title={`last ${cal.n} resolved predictions: ${(cal.hitRate * 100).toFixed(0)}% hit rate, Brier ${cal.brier.toFixed(3)} (0.25 = honest coin). This record discounts/boosts the confidence read.`}
    >
      track record {cal.n}: {(cal.hitRate * 100).toFixed(0)}% · brier {cal.brier.toFixed(3)}
    </span>
  )
}

function DriverRow({ d }: { d: NextCandlePrediction['drivers'][number] }) {
  const bull = d.vote > 0.05
  const bear = d.vote < -0.05
  return (
    <div className="rounded border border-[#1c2739] bg-[#0b111c] p-1.5">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bull ? 'bg-emerald-400' : bear ? 'bg-rose-400' : 'bg-[#3d4d66]'}`} />
        <span className="font-mono text-[10px] font-bold text-[#dbe4f0]">{d.name}</span>
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">p {Math.round(d.pUp * 100)}% · w {d.weight.toFixed(0)}</span>
      </div>
      <p className="mt-0.5 pl-3 font-mono text-[8.5px] leading-snug text-[#7c8aa5]">{d.detail}</p>
    </div>
  )
}

function ResolutionRow({ r }: { r: OracleRecentResolution }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[9px]">
      <span className={r.hit ? 'text-emerald-300' : 'text-rose-300'}>{r.hit ? '✓' : '✗'}</span>
      <span className="text-[#dbe4f0]">{r.asset}</span>
      <span className="text-[#3d4d66]">{r.tf}</span>
      <span className={r.predicted === 'call' ? 'text-emerald-300' : 'text-rose-300'}>{r.predicted}</span>
      <span className="text-[#3d4d66]">@{(r.pUp * 100).toFixed(0)}%</span>
      <span className="ml-auto text-[#7c8aa5]">{r.actual} {(r.exit - r.entry >= 0 ? '+' : '')}{fmtPrice(r.exit - r.entry, r.asset)}</span>
    </div>
  )
}

export default function NextCandlePanel({ asset, tf, closedTick, onClose }: NextCandlePanelProps) {
  const [pred, setPred] = useState<NextCandlePrediction | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [stats, setStats] = useState<NextCandleStatsResponse | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await getNextCandle(asset, tf)
      if (res.ok && res.prediction) {
        setPred(res.prediction)
        setErr(null)
      } else {
        setErr(res.error ?? 'oracle unavailable')
      }
      const st = await getNextCandleStats()
      if (st.ok) setStats(st)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [asset, tf])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), FALLBACK_POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick])

  const record = stats?.records.find((r) => r.asset === asset && r.tf === tf)
  const recent = (stats?.recent ?? []).filter((r) => r.asset === asset && r.tf === tf).slice(0, 8)

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Next-Candle Oracle</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">{asset} · {tf}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
        >
          close
        </button>
      </div>

      {err && (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-[9px] text-amber-300">
          {err} - the oracle refuses to guess without enough closed history.
        </div>
      )}

      {pred && (
        <>
          <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
            <div className="flex items-center gap-2">
              {regimeChip(pred.regime)}
              <span className="font-mono text-[9px] text-[#7c8aa5]">{pred.driversActive} models fused · {pred.mode} feed</span>
              <div className="ml-auto">{confRing(pred.confidence)}</div>
            </div>
            {probBar(pred.pUp)}
            {pred.calibration && pred.confidence !== pred.rawConfidence && (
              <p className="mt-1 font-mono text-[8px] text-[#4b5a72]" title="raw fusion confidence vs the calibrated read">
                raw {pred.rawConfidence.toFixed(0)}% → calibrated {pred.confidence.toFixed(0)}% (own record applied)
              </p>
            )}
          </div>

          {dirBanner(pred)}
          <CalibrationBadge cal={pred.calibration ?? (record ? { n: record.n, hitRate: record.hitRate, brier: record.brier } : null)} />
          <RangeCone p={pred} />

          <div>
            <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">model drivers</p>
            <div className="flex flex-col gap-1">
              {pred.drivers.map((d) => (
                <DriverRow key={d.name} d={d} />
              ))}
            </div>
          </div>
        </>
      )}

      {record && (
        <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
          <p className="font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
            oracle ledger · {asset} {tf} · n={record.n} · streak {record.streak}
          </p>
          <div className="mt-1 flex flex-col gap-0.5">
            {recent.length === 0 && <p className="font-mono text-[8.5px] text-[#3d4d66]">resolves land here as the target candles close…</p>}
            {recent.map((r, i) => (
              <ResolutionRow key={`${r.targetBarTime}-${i}`} r={r} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
