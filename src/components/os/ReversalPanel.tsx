'use client'

// IQAIR//OS - Reversal Detection panel
// "Is this timeframe turning RIGHT NOW?" - a dedicated reversal engine over
// the same 1s/2s/3s/5s/15s/30s/1m/2m/3m/5m ladder as the Technical Summary:
// 7 fail-closed detectors (RSI hook, Stoch cross, the OS's own candle
// pattern library, Bollinger re-entry, RSI divergence, run exhaustion,
// stretch fade) vote with weights, and the state machine answers in one of
//   calm / forming / REVERSING NOW / confirmed
// per rung. Backed by /reversal (analytics/reversal.ts, plugins/reversal.ts).

import { useCallback, useEffect, useState } from 'react'
import type { ReversalState, ReversalSummary, ReversalTfRow } from '@/lib/os/client'
import { fmtPrice, getReversal } from '@/lib/os/client'

interface ReversalPanelProps {
  asset: string
  /** bumps on every closed candle - keeps the reads fresh */
  closedTick?: number
  onClose: () => void
  /** cross-nav: open the whole-universe Reversal Global board */
  onOpenGlobal?: () => void
  /** cross-nav: open the Technical Summary panel for this same asset */
  onOpenTechnical?: (asset: string) => void
}

const FALLBACK_POLL_MS = 12_000

const STATE_CLASS: Record<ReversalState, string> = {
  calm: 'text-[#7c8aa5]',
  forming: 'text-amber-300',
  reversing: 'text-fuchsia-300',
  confirmed: 'text-cyan-300',
}

const STATE_BORDER: Record<ReversalState, string> = {
  calm: 'border-[#1c2739] bg-[#0b111c]',
  forming: 'border-amber-500/40 bg-amber-500/10',
  reversing: 'border-fuchsia-500/50 bg-fuchsia-500/15',
  confirmed: 'border-cyan-500/40 bg-cyan-500/10',
}

const STATE_HELP: Record<ReversalState, string> = {
  calm: 'no stretch, no trigger - nothing to act on',
  forming: 'an extreme is in place and counter-pressure is building, but no bar-0 trigger yet',
  reversing: 'a bar-0 trigger fired on the latest closed bar with net weight >= 3 - turning now',
  confirmed: 'trigger fired on the prior bar and the latest bar closed further in the reversal direction',
}

function stateArrow(dir: 'up' | 'down' | 'none'): string {
  return dir === 'up' ? '▲' : dir === 'down' ? '▼' : '—'
}

function TfCell({ row, selected, onSelect }: { row: ReversalTfRow; selected: boolean; onSelect: () => void }) {
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
  const reversing = row.state === 'reversing'
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative rounded-lg border p-1.5 text-left transition-colors ${selected ? 'border-[#3d4d66] bg-[#0e1524]' : STATE_BORDER[row.state]} ${reversing ? 'animate-pulse' : ''} hover:border-[#3d4d66]`}
      title={`${row.tf}: ${row.state}${row.direction !== 'none' ? ` ${row.direction}` : ''} (score ${row.score >= 0 ? '+' : ''}${row.score}) - ${STATE_HELP[row.state]}`}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{row.tf}</span>
        <span className={`font-mono text-[12px] font-bold leading-none ${row.direction === 'up' ? 'text-emerald-300' : row.direction === 'down' ? 'text-rose-300' : 'text-[#7c8aa5]'}`}>
          {stateArrow(row.direction)}
        </span>
      </div>
      <div className={`mt-1 font-mono text-[8.5px] font-bold uppercase leading-none ${STATE_CLASS[row.state]}`}>
        {reversing ? 'REVERSING NOW' : row.state}
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[7px] text-[#4b5a72]">
        <span title="net detector weight: sum(up) - sum(down)">w {row.score >= 0 ? '+' : ''}{row.score}</span>
        <span title="detectors that voted">{row.reasons.length} det</span>
      </div>
    </button>
  )
}

export default function ReversalPanel({ asset, closedTick, onClose, onOpenGlobal, onOpenTechnical }: ReversalPanelProps) {
  const [sum, setSum] = useState<ReversalSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await getReversal(asset)
      if (res.ok && res.summary) {
        setSum(res.summary)
        setErr(null)
      } else {
        setSum(null)
        setErr(res.error ?? 'reversal engine unavailable')
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

  // default the detail view to the most urgent live rung
  const urgentTf = sum?.rows.filter((r) => r.ok && r.state !== 'calm').sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0]?.tf ?? null
  const selRow = sum?.rows.find((r) => r.tf === (selected ?? urgentTf)) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Reversal Radar</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">{asset}</span>
        {onOpenTechnical && (
          <button
            type="button"
            onClick={() => onOpenTechnical(asset)}
            className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-lime-500/40 hover:text-lime-300"
            title="open the Technical Summary panel for this asset - which way each timeframe leans"
          >
            → technical
          </button>
        )}
        {onOpenGlobal && (
          <button
            type="button"
            onClick={() => onOpenGlobal()}
            className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-teal-500/40 hover:text-teal-300"
            title="open Reversal Global - the whole universe ranked by reversal urgency"
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

      {sum && (
        <>
          {/* most urgent read banner - or the honest all-clear */}
          <div className={`rounded-lg border px-2.5 py-2 ${sum.best ? STATE_BORDER[sum.best.state] : 'border-[#1c2739] bg-[#0b111c]'}`}>
            <div className="flex items-center gap-2">
              <span className={`font-mono text-lg font-bold leading-none ${sum.best ? (sum.best.direction === 'up' ? 'text-emerald-300' : 'text-rose-300') : 'text-[#7c8aa5]'}`}>
                {sum.best ? stateArrow(sum.best.direction) : '—'}
              </span>
              <div className="flex flex-col">
                <span className={`font-mono text-[11px] font-bold uppercase tracking-wider ${sum.best ? STATE_CLASS[sum.best.state] : 'text-[#7c8aa5]'}`}>
                  {sum.best ? `${sum.best.tf} · ${sum.best.state === 'reversing' ? 'reversing now' : sum.best.state} ${sum.best.direction}` : 'no rung is turning - all calm'}
                </span>
                <span className="font-mono text-[9px] text-[#7c8aa5]">{sum.note}</span>
              </div>
              {sum.best && (
                <div className="ml-auto flex flex-col items-center">
                  <span className="font-mono text-lg font-bold leading-none text-[#dbe4f0]">{sum.best.score >= 0 ? '+' : ''}{sum.best.score}</span>
                  <span className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">net w</span>
                </div>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]">spot {fmtPrice(sum.price, sum.asset)}</span>
              {(['reversing', 'confirmed', 'forming'] as ReversalState[]).map((st) => {
                const n = sum.rows.filter((r) => r.ok && r.state === st).length
                return n > 0 ? (
                  <span key={st} className={`rounded border px-1.5 py-px font-mono text-[8px] uppercase tracking-wider ${STATE_BORDER[st]} ${STATE_CLASS[st]}`} title={STATE_HELP[st]}>
                    {n} {st}
                  </span>
                ) : null
              })}
            </div>
          </div>

          {/* the ladder: 10 rungs, 2 rows of 5 */}
          <div className="grid grid-cols-5 gap-1.5">
            {sum.rows.map((row) => (
              <TfCell key={row.tf} row={row} selected={(selected ?? urgentTf ?? row.tf) === row.tf} onSelect={() => setSelected(row.tf)} />
            ))}
          </div>

          {/* selected rung detail: every detector vote with its weight */}
          {selRow && selRow.ok && (
            <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
              <div className="mb-1 flex items-center justify-between">
                <p className="font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
                  {selRow.tf} detectors · {selRow.bars} closed bars
                  {selRow.source === 'ticks' && selRow.ticksPerBar !== null && (
                    <span className="ml-1.5" title="tick-built rung - density disclosed">ticks ×{selRow.ticksPerBar.toFixed(1)}</span>
                  )}
                </p>
                <span className={`font-mono text-[9px] font-bold uppercase ${STATE_CLASS[selRow.state]}`}>{selRow.state} {selRow.direction !== 'none' ? selRow.direction : ''}</span>
              </div>
              {selRow.reasons.length === 0 && (
                <p className="font-mono text-[8.5px] text-[#3d4d66]">no detector fired on this rung - genuinely calm</p>
              )}
              <div className="flex flex-col gap-0.5">
                {selRow.reasons.map((r, i) => (
                  <div key={`${r.detector}-${i}`} className="flex items-start gap-1.5 font-mono text-[8.5px] leading-snug">
                    <span className={`mt-px shrink-0 ${r.dir === 'up' ? 'text-emerald-300' : 'text-rose-300'}`}>{stateArrow(r.dir)}</span>
                    <span className="shrink-0 rounded border border-[#1c2739] px-1 text-[7.5px] uppercase text-[#7c8aa5]">{r.detector}</span>
                    <span className="text-[#aebccf]">{r.note}</span>
                    <span className="ml-auto shrink-0 text-[#4b5a72]">w{r.weight}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {selRow && !selRow.ok && (
            <div className="rounded-lg border border-dashed border-[#24324a] bg-[#0b111c] p-2 font-mono text-[9px] text-[#7c8aa5]">
              {selRow.tf}: {selRow.note}
            </div>
          )}

          {/* state legend - the panel's reading guide */}
          <div className="flex flex-wrap gap-1 border-t border-[#1c2739] pt-1.5">
            {(['calm', 'forming', 'reversing', 'confirmed'] as ReversalState[]).map((st) => (
              <span key={st} className={`rounded border px-1 py-px font-mono text-[7.5px] uppercase ${STATE_BORDER[st]} ${STATE_CLASS[st]}`} title={STATE_HELP[st]}>
                {st === 'reversing' ? 'reversing now' : st}: {STATE_HELP[st]}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
