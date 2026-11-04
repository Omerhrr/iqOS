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
  /** cross-nav: jump straight to Accute for this same asset */
  onOpenAccute?: (asset: string) => void
  /** cross-nav: jump straight to Tempo for this same asset */
  onOpenTempo?: (asset: string) => void
  /** cross-nav: jump straight to the SMC Recent panel for this same asset */
  onOpenSmc?: (asset: string) => void
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

// Draws the shape expectedCandleType only describes in words: a tiny
// candlestick glyph laid out from the oracle's own body-ratio/close-position/
// direction geometry. The glyph's box IS the expected high-low range, so the
// wick above the body is "room above the body to the expected high" and the
// wick below is the mirror - body size/placement come straight from
// bodyRatio/closePos, no separate drawing logic to keep in sync.
function expectedCandleGlyph(p: { direction: 'call' | 'put' | 'none'; bodyRatio: number; closePos: number }) {
  const W = 40
  const H = 56
  const call = p.direction === 'call'
  const none = p.direction === 'none'
  const bodyRatio = Math.min(Math.max(p.bodyRatio, 0.04), 1)
  const closePos = Math.min(Math.max(p.closePos, 0), 1)
  const closeY = H * (1 - closePos)
  const bodyH = Math.max(bodyRatio * H, 2)
  let openY: number
  let closeYClamped: number
  if (none) {
    openY = Math.max(0, Math.min(H, closeY - bodyH / 2))
    closeYClamped = openY + bodyH
  } else if (call) {
    closeYClamped = closeY
    openY = closeYClamped + bodyH
    if (openY > H) {
      openY = H
      closeYClamped = H - bodyH
    }
  } else {
    closeYClamped = closeY
    openY = closeYClamped - bodyH
    if (openY < 0) {
      openY = 0
      closeYClamped = bodyH
    }
  }
  const bodyTop = Math.min(openY, closeYClamped)
  const bodyBottom = Math.max(openY, closeYClamped)
  const color = none ? '#7c8aa5' : call ? '#34d399' : '#fb7185'
  const cx = W / 2
  const bodyW = W * 0.55
  return (
    <svg width={W} height={H + 4} viewBox={`0 0 ${W} ${H + 2}`} className="shrink-0">
      {/* upper wick: body top -> expected high */}
      <line x1={cx} y1={bodyTop} x2={cx} y2={0} stroke={color} strokeWidth={1.5} />
      {/* lower wick: body bottom -> expected low */}
      <line x1={cx} y1={bodyBottom} x2={cx} y2={H} stroke={color} strokeWidth={1.5} />
      <rect
        x={cx - bodyW / 2}
        y={Math.max(bodyTop, 0.5)}
        width={bodyW}
        height={Math.max(bodyBottom - bodyTop, 1.5)}
        fill={none ? 'none' : color}
        fillOpacity={none ? 0 : 0.85}
        stroke={color}
        strokeWidth={1.25}
        rx={0.75}
      />
    </svg>
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

/** Which calibration bucket is actually in force for this pair right now,
 * in predictNextCandle's own preference order (regime -> session ->
 * direction -> blended) - explains why the confidence badge above can
 * differ from the plain blended record. */
function activeCalibrationLabel(
  record: NextCandleStatsResponse['records'][number] | undefined,
  regime: string,
): string {
  if (!record) return 'blended (no record yet)'
  const r = record.regimeCalibration[regime as keyof typeof record.regimeCalibration]
  if (r && r.n >= 20) return `regime ${regime} (n=${r.n})`
  // session isn't known client-side without re-deriving the clock; show
  // the thickest available session bucket as a hint instead.
  const sessionEntries = Object.entries(record.sessionCalibration) as [string, { n: number; hitRate: number; brier: number }][]
  const thickSession = sessionEntries.filter(([, v]) => v.n >= 20).sort((a, b) => b[1].n - a[1].n)[0]
  if (thickSession) return `session ${thickSession[0]} (n=${thickSession[1].n})`
  const dirEntries = Object.entries(record.directionCalibration) as [string, { n: number }][]
  const thickDir = dirEntries.filter(([, v]) => v.n >= 20).sort((a, b) => b[1].n - a[1].n)[0]
  if (thickDir) return `direction ${thickDir[0]} (n=${thickDir[1].n})`
  return `blended (n=${record.n})`
}

function LearnedDiagnostics({ stats, record, regime }: { stats: NextCandleStatsResponse; record: NextCandleStatsResponse['records'][number] | undefined; regime: string }) {
  const drivers = Object.entries(stats.driverWeightMultipliers).sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1)).slice(0, 4)
  const patterns = Object.entries(stats.patternReliability).sort((a, b) => Math.abs(b[1] - 2) - Math.abs(a[1] - 2)).slice(0, 4)
  const calQuality = Object.entries(stats.driverCalibrationMultipliers).sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1)).slice(0, 4)
  const correlated = Object.entries(stats.driverCorrelation).sort((a, b) => a[1] - b[1]).slice(0, 4)
  const pairDrivers = Object.entries(record?.pairDriverWeightMultipliers ?? {}).sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1)).slice(0, 4)
  const pairCalQuality = Object.entries(record?.pairDriverCalibrationMultipliers ?? {}).sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1)).slice(0, 4)
  const pairCorrelated = Object.entries(record?.pairDriverCorrelation ?? {}).sort((a, b) => a[1] - b[1]).slice(0, 4)
  const pairPattern = Object.entries(record?.pairPatternReliability ?? {}).sort((a, b) => Math.abs(b[1] - 2) - Math.abs(a[1] - 2)).slice(0, 4)
  const pairPhysiologyActive = pairDrivers.length > 0 || pairCalQuality.length > 0 || pairCorrelated.length > 0 || pairPattern.length > 0 || record?.pairConfidenceBlendWeight != null
  const clusterDrivers = Object.entries(record?.clusterDriverWeightMultipliers ?? {}).sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1)).slice(0, 4)
  const clusterCalQuality = Object.entries(record?.clusterDriverCalibrationMultipliers ?? {}).sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1)).slice(0, 4)
  const clusterCorrelated = Object.entries(record?.clusterDriverCorrelation ?? {}).sort((a, b) => a[1] - b[1]).slice(0, 4)
  const clusterActive = clusterDrivers.length > 0 || clusterCalQuality.length > 0 || clusterCorrelated.length > 0
  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
      <p className="font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">learned (what's actually shaping this read)</p>
      <p className="mt-1 font-mono text-[8.5px] text-[#7c8aa5]">
        calibration bucket in force: <span className="text-[#dbe4f0]">{activeCalibrationLabel(record, regime)}</span>
      </p>
      {record && record.magnitudeCalibration !== null && (
        <p className="mt-0.5 font-mono text-[8.5px] text-[#7c8aa5]">
          magnitude calibration: <span className="text-[#dbe4f0]">{record.magnitudeCalibration.toFixed(2)}×</span>{' '}
          {record.magnitudeCalibration > 1.05 ? '(has been predicting too narrow a move)' : record.magnitudeCalibration < 0.95 ? '(has been predicting too wide a move)' : '(on target)'}
        </p>
      )}
      <p className="mt-0.5 font-mono text-[8.5px] text-[#7c8aa5]">
        confidence blend: <span className="text-[#dbe4f0]">{(stats.confidenceBlendWeight ?? 0.55).toFixed(2)} agreement / {(1 - (stats.confidenceBlendWeight ?? 0.55)).toFixed(2)} distance</span>{' '}
        {stats.confidenceBlendWeight === null ? '(default)' : '(learned)'}
      </p>
      <p className="mt-0.5 font-mono text-[8.5px] text-[#7c8aa5]">
        pair physiology: <span className={pairPhysiologyActive ? 'text-cyan-300' : 'text-[#dbe4f0]'}>{pairPhysiologyActive ? 'this pair has its own learned driver read' : 'not enough of this pair\'s own history yet'}</span>
      </p>
      <p className="mt-0.5 font-mono text-[8.5px] text-[#7c8aa5]">
        cluster physiology{record?.clusterKey ? ` (${record.clusterKey})` : ''}: <span className={clusterActive ? 'text-orange-300' : 'text-[#dbe4f0]'}>{clusterActive ? 'this asset class has its own learned driver read' : 'not enough of this cluster\'s own history yet'}</span>
      </p>
      {record?.pairConfidenceBlendWeight != null && (
        <p className="mt-0.5 font-mono text-[8.5px] text-[#7c8aa5]">
          this pair's confidence blend: <span className="text-cyan-300">{record.pairConfidenceBlendWeight.toFixed(2)} agreement / {(1 - record.pairConfidenceBlendWeight).toFixed(2)} distance</span> (learned, this pair's own)
        </p>
      )}
      {pairDrivers.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">driver weight outliers (this pair, own physiology)</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {pairDrivers.map(([name, w]) => (
              <span key={name} className={`rounded border px-1 py-px font-mono text-[8px] ${w > 1 ? 'border-cyan-500/40 text-cyan-300' : 'border-orange-500/40 text-orange-300'}`} title="this pair's OWN win-rate-based driver weight multiplier, computed only from this asset:tf's own resolved history - takes priority over the universe-wide table above">
                {name} {w.toFixed(2)}×
              </span>
            ))}
          </div>
        </div>
      )}
      {pairCalQuality.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">driver calibration quality (this pair, own physiology)</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {pairCalQuality.map(([name, w]) => (
              <span key={name} className={`rounded border px-1 py-px font-mono text-[8px] ${w > 1 ? 'border-cyan-500/40 text-cyan-300' : 'border-orange-500/40 text-orange-300'}`} title="this pair's OWN Brier-based calibration-quality multiplier">
                {name} {w.toFixed(2)}×
              </span>
            ))}
          </div>
        </div>
      )}
      {pairCorrelated.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">correlated driver pairs (this pair, own physiology)</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {pairCorrelated.map(([pair, discount]) => (
              <span key={pair} className="rounded border border-cyan-500/40 px-1 py-px font-mono text-[8px] text-cyan-300" title="this pair's OWN pairwise driver agreement discount, computed only from this asset:tf's own resolved co-occurrences">
                {pair.replace('|', ' / ')} {discount.toFixed(2)}×
              </span>
            ))}
          </div>
        </div>
      )}
      {pairPattern.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">pattern reliability outliers (this pair, own physiology)</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {pairPattern.map(([name, w]) => (
              <span key={name} className={`rounded border px-1 py-px font-mono text-[8px] ${w > 2 ? 'border-cyan-500/40 text-cyan-300' : 'border-orange-500/40 text-orange-300'}`} title="this pair's OWN pattern reliability, merged on top of the universe-wide learned table">
                {name} {w.toFixed(2)}
              </span>
            ))}
          </div>
        </div>
      )}
      {clusterDrivers.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">driver weight outliers (cluster{record?.clusterKey ? `: ${record.clusterKey}` : ''})</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {clusterDrivers.map(([name, w]) => (
              <span key={name} className={`rounded border px-1 py-px font-mono text-[8px] ${w > 1 ? 'border-orange-500/40 text-orange-300' : 'border-amber-500/40 text-amber-300'}`} title="this asset category's learned win-rate-based driver weight multiplier - the fallback tier between this pair's own history and the universe-wide table">
                {name} {w.toFixed(2)}×
              </span>
            ))}
          </div>
        </div>
      )}
      {clusterCalQuality.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">driver calibration quality (cluster{record?.clusterKey ? `: ${record.clusterKey}` : ''})</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {clusterCalQuality.map(([name, w]) => (
              <span key={name} className={`rounded border px-1 py-px font-mono text-[8px] ${w > 1 ? 'border-orange-500/40 text-orange-300' : 'border-amber-500/40 text-amber-300'}`} title="this asset category's Brier-based calibration-quality multiplier">
                {name} {w.toFixed(2)}×
              </span>
            ))}
          </div>
        </div>
      )}
      {clusterCorrelated.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">correlated driver pairs (cluster{record?.clusterKey ? `: ${record.clusterKey}` : ''})</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {clusterCorrelated.map(([pair, discount]) => (
              <span key={pair} className="rounded border border-orange-500/40 px-1 py-px font-mono text-[8px] text-orange-300" title="this asset category's pairwise driver agreement discount">
                {pair.replace('|', ' / ')} {discount.toFixed(2)}×
              </span>
            ))}
          </div>
        </div>
      )}
      {drivers.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">driver weight outliers (universe-wide fallback)</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {drivers.map(([name, w]) => (
              <span key={name} className={`rounded border px-1 py-px font-mono text-[8px] ${w > 1 ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}`} title="learned driver weight multiplier from its own resolved win rate">
                {name} {w.toFixed(2)}×
              </span>
            ))}
          </div>
        </div>
      )}
      {patterns.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">pattern reliability outliers (universe-wide)</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {patterns.map(([name, w]) => (
              <span key={name} className={`rounded border px-1 py-px font-mono text-[8px] ${w > 2 ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}`} title="learned pattern reliability, 0.3-4 scale (hand-set default is ~2)">
                {name} {w.toFixed(2)}
              </span>
            ))}
          </div>
        </div>
      )}
      {calQuality.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">driver calibration quality (universe-wide fallback)</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {calQuality.map(([name, w]) => (
              <span key={name} className={`rounded border px-1 py-px font-mono text-[8px] ${w > 1 ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}`} title="Brier-based calibration-quality multiplier (0.8-1.2) - rewards a driver for being honest about its own uncertainty, independent of win rate">
                {name} {w.toFixed(2)}×
              </span>
            ))}
          </div>
        </div>
      )}
      {correlated.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">correlated driver pairs (universe-wide fallback, discounted)</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {correlated.map(([pair, discount]) => (
              <span key={pair} className="rounded border border-amber-500/40 px-1 py-px font-mono text-[8px] text-amber-300" title="learned pairwise agreement discount - this pair agrees meaningfully more than chance, so one vote is discounted toward 0.5 to avoid double-counting shared evidence">
                {pair.replace('|', ' / ')} {discount.toFixed(2)}×
              </span>
            ))}
          </div>
        </div>
      )}
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

export default function NextCandlePanel({ asset, tf, closedTick, onClose, onOpenAccute, onOpenTempo, onOpenSmc }: NextCandlePanelProps) {
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
        {onOpenTempo && (
          <button
            type="button"
            onClick={() => onOpenTempo(asset)}
            className={`rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-fuchsia-500/40 hover:text-fuchsia-300 ${onOpenAccute || onOpenSmc ? '' : 'ml-auto'}`}
            title="open Tempo for this asset"
          >
            → tempo
          </button>
        )}
        {onOpenAccute && (
          <button
            type="button"
            onClick={() => onOpenAccute(asset)}
            className={`rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-sky-500/40 hover:text-sky-300 ${onOpenTempo || onOpenSmc ? '' : 'ml-auto'}`}
            title="open Accute for this asset"
          >
            → accute
          </button>
        )}
        {onOpenSmc && (
          <button
            type="button"
            onClick={() => onOpenSmc(asset)}
            className={`rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-cyan-500/40 hover:text-cyan-300 ${onOpenTempo || onOpenAccute ? '' : 'ml-auto'}`}
            title="open SMC Recent for this asset"
          >
            → smc
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className={`rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300 ${onOpenAccute || onOpenTempo || onOpenSmc ? '' : 'ml-auto'}`}
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
          {pred.expectedCandleType && (
            <div className="-mt-0.5 flex flex-wrap items-stretch gap-1.5">
              <div className="flex flex-1 items-center gap-1.5 rounded border border-[#1c2739] bg-[#0b111c] px-1.5 py-1">
                {expectedCandleGlyph(pred)}
                <p className="font-mono text-[8.5px] italic text-[#7c8aa5]" title="derived from the oracle's own body-ratio/close-position/direction geometry">
                  expecting: {pred.expectedCandleType}
                </p>
              </div>
              {pred.altPrediction && (
                <div
                  className="flex flex-1 items-center gap-1.5 rounded border border-[#1c2739] bg-[#0b111c] px-1.5 py-1"
                  title={`Hull MA slope ${pred.altPrediction.hmaSlope >= 0 ? '+' : ''}${pred.altPrediction.hmaSlope.toFixed(3)}% · ROC ${pred.altPrediction.rocValue >= 0 ? '+' : ''}${pred.altPrediction.rocValue.toFixed(3)}% · bull power ${pred.altPrediction.bullPower.toFixed(5)} · bear power ${pred.altPrediction.bearPower.toFixed(5)} - simple average, NOT fused with the oracle above and not tracked by the honesty loop`}
                >
                  {expectedCandleGlyph(pred.altPrediction)}
                  <div className="flex flex-col">
                    <p className="font-mono text-[8.5px] italic text-[#7c8aa5]">HMA/ROC/Bull-Bear: {pred.altPrediction.expectedCandleType}</p>
                    <p className="font-mono text-[7.5px] uppercase tracking-wider text-[#4b5a72]">simple · untracked · strength {pred.altPrediction.strength}%</p>
                  </div>
                </div>
              )}
              {pred.momentumPrediction && (
                <div
                  className="flex flex-1 items-center gap-1.5 rounded border border-[#1c2739] bg-[#0b111c] px-1.5 py-1"
                  title={`Market Momentum Score = ${pred.momentumPrediction.weights.w15m}*T15m + ${pred.momentumPrediction.weights.w5m}*T5m + ${pred.momentumPrediction.weights.w1m}*T1m + ${pred.momentumPrediction.weights.w30s}*T30s · T15m ${pred.momentumPrediction.components.t15m >= 0 ? '+' : ''}${pred.momentumPrediction.components.t15m} · T5m ${pred.momentumPrediction.components.t5m >= 0 ? '+' : ''}${pred.momentumPrediction.components.t5m} · T1m ${pred.momentumPrediction.components.t1m >= 0 ? '+' : ''}${pred.momentumPrediction.components.t1m} · T30s ${pred.momentumPrediction.components.t30s >= 0 ? '+' : ''}${pred.momentumPrediction.components.t30s} - pure candle-math terms (own timeframes, independent of the chart's tf), NOT fused with the oracle above and not tracked by the honesty loop`}
                >
                  {expectedCandleGlyph(pred.momentumPrediction)}
                  <div className="flex flex-col">
                    <p className="font-mono text-[8.5px] italic text-[#7c8aa5]">Momentum Score: {pred.momentumPrediction.expectedCandleType}</p>
                    <p className="font-mono text-[7.5px] uppercase tracking-wider text-[#4b5a72]">15m/5m/1m/30s · untracked · score {pred.momentumPrediction.score >= 0 ? '+' : ''}{pred.momentumPrediction.score}</p>
                  </div>
                </div>
              )}
            </div>
          )}
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

      {stats && <LearnedDiagnostics stats={stats} record={record} regime={pred?.regime ?? ''} />}
    </div>
  )
}
