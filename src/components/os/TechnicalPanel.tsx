'use client'

// IQAIR//OS - Technical Summary panel
// The investing.com "Technical Summary" rebuilt on this OS's own data: for
// EVERY rung of the 1s/2s/3s/5s/15s/30s/1m/2m/3m/5m ladder the engine rates
// the oscillator panel (RSI, Stoch, CCI, ADX, Awesome, Momentum, MACD,
// Stoch RSI, Williams %R, Bull/Bear Power, Ultimate) and the moving-average
// panel (SMA/EMA x 10..200, Hull, VWMA, Ichimoku base) into Buy/Sell/
// Neutral votes, then condenses them into STRONG BUY / BUY / NEUTRAL /
// SELL / STRONG SELL - the "which way is the next candle/expiry of THIS
// timeframe leaning" read.
//
// Backed by /technical (analytics/technicals.ts, plugins/technical.ts).
// Seconds rungs are built from the raw tick buffer and say so (ticksPerBar);
// 3m is aggregated from 3 x 1m native bars. A rung with thin history reads
// "warming up", never a verdict.

import { useCallback, useEffect, useState } from 'react'
import type { TechTfRow, TechVerdict, TechVerdictLabel, TechnicalSummary } from '@/lib/os/client'
import { fmtPrice, getTechnical } from '@/lib/os/client'

interface TechnicalPanelProps {
  asset: string
  /** bumps on every closed candle - keeps the reads fresh */
  closedTick?: number
  onClose: () => void
  /** cross-nav: open the whole-universe Technical Global board */
  onOpenGlobal?: () => void
  /** cross-nav: open the Reversal panel for this same asset */
  onOpenReversal?: (asset: string) => void
}

const FALLBACK_POLL_MS = 15_000

const VERDICT_CLASS: Record<TechVerdictLabel, string> = {
  'STRONG BUY': 'text-emerald-300',
  'BUY': 'text-green-300',
  'NEUTRAL': 'text-[#7c8aa5]',
  'SELL': 'text-rose-300',
  'STRONG SELL': 'text-red-300',
}

const VERDICT_BG: Record<TechVerdictLabel, string> = {
  'STRONG BUY': 'border-emerald-500/50 bg-emerald-500/15',
  'BUY': 'border-green-500/40 bg-green-500/10',
  'NEUTRAL': 'border-[#1c2739] bg-[#0b111c]',
  'SELL': 'border-rose-500/40 bg-rose-500/10',
  'STRONG SELL': 'border-red-500/50 bg-red-500/15',
}

function verdictArrow(label: TechVerdictLabel): string {
  return label === 'STRONG BUY' || label === 'BUY' ? '▲' : label === 'SELL' || label === 'STRONG SELL' ? '▼' : '—'
}

function VerdictChip({ v }: { v: TechVerdict }) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-wider ${VERDICT_BG[v.label]} ${VERDICT_CLASS[v.label]}`}
      title={`score ${v.score >= 0 ? '+' : ''}${v.score.toFixed(2)} · ${v.buys} buy / ${v.sells} sell / ${v.neutrals} neutral of ${v.counted} counted votes`}
    >
      {verdictArrow(v.label)} {v.label}
    </span>
  )
}

function sourceBadge(r: TechTfRow) {
  if (r.source === 'native') return null
  const label = r.source === 'ticks' ? `ticks ×${(r.ticksPerBar ?? 0).toFixed(1)}` : '3×1m agg'
  return (
    <span
      className="rounded border border-[#3d4d66] px-1 py-px font-mono text-[7px] uppercase tracking-wider text-[#7c8aa5]"
      title={r.source === 'ticks'
        ? 'this rung is built from raw tick observations, not tracked candles - ticksPerBar discloses the density (1.0 = every bar is a single observation: close-based math valid, wick anatomy not)'
        : '3m is not a tracked timeframe - aggregated honestly from 3 x 1m closed bars'}
    >
      {label}
    </span>
  )
}

function TfCell({ row, selected, isStrongest, onSelect }: { row: TechTfRow; selected: boolean; isStrongest: boolean; onSelect: () => void }) {
  const v = row.summary
  if (!row.ok) {
    return (
      <button
        type="button"
        onClick={onSelect}
        className={`relative rounded-lg border p-1.5 text-left transition-colors ${selected ? 'border-[#3d4d66] bg-[#0e1524]' : 'border-dashed border-[#24324a] bg-[#0b111c] hover:border-[#3d4d66]'}`}
        title={row.note}
      >
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] font-bold text-[#7c8aa5]">{row.tf}</span>
          <span className="font-mono text-[8px] text-[#4b5a72]" title={row.note}>warm</span>
        </div>
        <div className="mt-1.5 font-mono text-[12px] font-bold leading-none text-[#3d4d66]">—</div>
        <p className="mt-1 h-5 font-mono text-[7px] leading-tight text-[#4b5a72]">{row.note}</p>
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative rounded-lg border p-1.5 text-left transition-colors ${selected ? 'border-[#3d4d66] bg-[#0e1524]' : 'border-[#1c2739] bg-[#0b111c] hover:border-[#3d4d66]'} ${isStrongest ? 'ring-1 ring-amber-400/40' : ''}`}
      title={`${row.tf} · ${v.label} · score ${v.score >= 0 ? '+' : ''}${v.score.toFixed(2)} · ${row.bars} closed bars${isStrongest ? ' · strongest conviction on the ladder right now' : ''}`}
    >
      {isStrongest && <span className="absolute -top-1.5 right-1 rounded bg-amber-400 px-1 font-mono text-[7px] font-bold uppercase text-[#0b111c]">top</span>}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{row.tf}</span>
        <span className={`font-mono text-[12px] font-bold leading-none ${VERDICT_CLASS[v.label]}`}>{verdictArrow(v.label)}</span>
      </div>
      <div className={`mt-1 font-mono text-[9px] font-bold uppercase leading-none ${VERDICT_CLASS[v.label]}`}>{v.label}</div>
      <div className="mt-1 flex items-center gap-1">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#101828]">
          <div
            className={`h-full ${v.score >= 0 ? 'bg-emerald-500/70' : 'bg-rose-500/70'}`}
            style={{ width: `${Math.max(6, Math.min(100, Math.abs(v.score) * 100))}%`, marginLeft: v.score >= 0 ? 'auto' : undefined }}
          />
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[7px] text-[#4b5a72]">
        <span title="oscillator block: buy/sell votes">o {row.oscSummary.buys}/{row.oscSummary.sells}</span>
        <span title="moving-average block: buy/sell votes">m {row.maSummary.buys}/{row.maSummary.sells}</span>
      </div>
    </button>
  )
}

function VoteTable({ title, verdict, votes }: { title: string; verdict: TechVerdict; votes: TechTfRow['osc'] }) {
  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">{title}</p>
        <VerdictChip v={verdict} />
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
        {votes.map((v) => (
          <div key={v.name} className="flex items-center gap-1.5 font-mono text-[9px]">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${v.read === 'buy' ? 'bg-emerald-400' : v.read === 'sell' ? 'bg-rose-400' : v.read === 'neutral' ? 'bg-[#3d4d66]' : 'bg-transparent border border-[#3d4d66]'}`} />
            <span className="truncate text-[#dbe4f0]" title={v.name}>{v.name}</span>
            <span className="ml-auto shrink-0 text-[#7c8aa5]">{v.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function TechnicalPanel({ asset, closedTick, onClose, onOpenGlobal, onOpenReversal }: TechnicalPanelProps) {
  const [sum, setSum] = useState<TechnicalSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await getTechnical(asset)
      if (res.ok && res.summary) {
        setSum(res.summary)
        setErr(null)
      } else {
        setSum(null)
        setErr(res.error ?? 'technical summary unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [asset])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), FALLBACK_POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick])

  useEffect(() => setSelected(null), [asset])

  const selRow = sum?.rows.find((r) => r.tf === (selected ?? sum.rows.find((x) => x.ok)?.tf ?? null)) ?? null
  const strongestTf = sum
    ? [...sum.rows.filter((r) => r.ok)].sort((a, b) => Math.abs(b.summary.score) - Math.abs(a.summary.score))[0]?.tf ?? null
    : null
  const overall = sum?.overall

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-lime-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Technical Summary</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">{asset}</span>
        {onOpenReversal && (
          <button
            type="button"
            onClick={() => onOpenReversal(asset)}
            className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-fuchsia-500/40 hover:text-fuchsia-300"
            title="open the Reversal panel for this asset - is a timeframe turning RIGHT NOW"
          >
            → reversal
          </button>
        )}
        {onOpenGlobal && (
          <button
            type="button"
            onClick={() => onOpenGlobal()}
            className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-teal-500/40 hover:text-teal-300"
            title="open Technical Global - one cross-TF consensus verdict per pair, ranked by conviction"
          >
            → global
          </button>
        )}
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
          {err}
        </div>
      )}

      {sum && overall && (
        <>
          {/* overall consensus banner */}
          <div className={`rounded-lg border px-2.5 py-2 ${VERDICT_BG[overall.label]}`}>
            <div className="flex items-center gap-2">
              <span className={`font-mono text-lg font-bold leading-none ${VERDICT_CLASS[overall.label]}`}>
                {verdictArrow(overall.label)}
              </span>
              <div className="flex flex-col">
                <span className={`font-mono text-[11px] font-bold uppercase tracking-wider ${VERDICT_CLASS[overall.label]}`}>
                  {overall.label}
                  {sum.direction !== 'none' && <span className="ml-1.5 normal-case">· next candle lean: {sum.direction}</span>}
                </span>
                <span className="font-mono text-[9px] text-[#7c8aa5]">{sum.note}</span>
              </div>
              <div className="ml-auto flex flex-col items-center">
                <span className="font-mono text-lg font-bold leading-none text-[#dbe4f0]">
                  {overall.score >= 0 ? '+' : ''}{(overall.score * 100).toFixed(0)}
                </span>
                <span className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">score</span>
              </div>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]">spot {fmtPrice(sum.price, sum.asset)}</span>
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]" title="the consensus is a plain mean of the live rungs' scores - every rung equal weight, disclosed">
                mean of {overall.counted} live rungs
              </span>
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]" title="mode the reads were computed in">{sum.mode}</span>
            </div>
          </div>

          {/* the ladder: 10 rungs, 2 rows of 5 */}
          <div className="grid grid-cols-5 gap-1.5">
            {sum.rows.map((row) => (
              <TfCell
                key={row.tf}
                row={row}
                selected={(selected ?? strongestTf ?? row.tf) === row.tf}
                isStrongest={strongestTf === row.tf && row.ok}
                onSelect={() => setSelected(row.tf)}
              />
            ))}
          </div>

          {/* selected rung detail: data provenance + the two vote tables */}
          {selRow && selRow.ok && (
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[10px] font-bold text-[#dbe4f0]">{selRow.tf}</span>
                <VerdictChip v={selRow.summary} />
                {sourceBadge(selRow)}
                <span className="font-mono text-[8px] text-[#4b5a72]" title={selRow.note}>{selRow.bars} closed bars</span>
              </div>
              <VoteTable title={`Oscillators · ${selRow.oscSummary.buys}/${selRow.oscSummary.sells}/${selRow.oscSummary.counted}`} verdict={selRow.oscSummary} votes={selRow.osc} />
              <VoteTable title={`Moving Averages · ${selRow.maSummary.buys}/${selRow.maSummary.sells}/${selRow.maSummary.counted}`} verdict={selRow.maSummary} votes={selRow.mas} />
            </div>
          )}
          {selRow && !selRow.ok && (
            <div className="rounded-lg border border-dashed border-[#24324a] bg-[#0b111c] p-2 font-mono text-[9px] text-[#7c8aa5]">
              {selRow.tf}: {selRow.note}
            </div>
          )}
        </>
      )}
    </div>
  )
}
