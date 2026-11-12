'use client'

// IQAIR//OS - MRC Next-Movement Predictor panel
// "What does the Market Response Clock say happens next?" - reads the
// latest confirmed MRC bar's own responseRatio, then checks THIS asset's
// own trailing history (walk-forward, self-calibrating - never a borrowed
// constant) for how often a bar like that one continued or reversed.
// States:
//   warming              not enough confirmed MRC bars yet
//   uncertain             no real edge right now - calibrated rate < 55%,
//                         or too few same-bucket samples to trust it
//   continuation-likely   high-response bar; history says this tends to run
//   reversal-likely       low-response bar; history says this tends to flip
// Backed by /mrc_predict (analytics/mrcpredict.ts, plugins/mrcpredict.ts).

import { useCallback, useEffect, useState } from 'react'
import type { MrcPredictResult, MrcPredictState } from '@/lib/os/client'
import { fmtPrice, getMrcPredict } from '@/lib/os/client'

interface MrcPredictPanelProps {
  asset: string
  tf?: string
  /** bumps on every closed candle - keeps the read fresh */
  closedTick?: number
  onClose: () => void
  /** cross-nav: open the whole-universe MRC Predict Global board */
  onOpenGlobal?: () => void
}

const FALLBACK_POLL_MS = 12_000

const STATE_CLASS: Record<MrcPredictState, string> = {
  warming: 'text-[#7c8aa5]',
  uncertain: 'text-[#7c8aa5]',
  'continuation-likely': 'text-emerald-300',
  'reversal-likely': 'text-fuchsia-300',
}

const STATE_BORDER: Record<MrcPredictState, string> = {
  warming: 'border-[#1c2739] bg-[#0b111c]',
  uncertain: 'border-[#1c2739] bg-[#0b111c]',
  'continuation-likely': 'border-emerald-500/40 bg-emerald-500/10',
  'reversal-likely': 'border-fuchsia-500/50 bg-fuchsia-500/15',
}

const STATE_HELP: Record<MrcPredictState, string> = {
  warming: 'not enough confirmed MRC bars yet',
  uncertain: 'no real edge right now - calibrated rate below 55%, or too few same-bucket samples to trust it yet',
  'continuation-likely': 'high-response bar (ratio >= 1.0) - this asset tends to continue after bars like this',
  'reversal-likely': 'low-response bar (ratio < 1.0) - this asset tends to reverse after bars like this',
}

function stateArrow(dir: 'call' | 'put' | 'none'): string {
  return dir === 'call' ? '▲' : dir === 'put' ? '▼' : '—'
}

export default function MrcPredictPanel({ asset, tf = '1m', closedTick, onClose, onOpenGlobal }: MrcPredictPanelProps) {
  const [result, setResult] = useState<MrcPredictResult | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await getMrcPredict(asset, tf)
      if (res.ok && res.result) {
        setResult(res.result)
        setErr(null)
      } else {
        setResult(null)
        setErr(res.error ?? 'MRC predictor unavailable')
      }
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [asset, tf])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), FALLBACK_POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick])

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">MRC Predict</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">{asset} · {tf}</span>
        {onOpenGlobal && (
          <button
            type="button"
            onClick={() => onOpenGlobal()}
            className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-teal-500/40 hover:text-teal-300"
            title="open MRC Predict Global - the whole universe ranked by prediction confidence"
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

      {result && (
        <>
          <div className={`rounded-lg border px-2.5 py-2 ${STATE_BORDER[result.state]}`}>
            <div className="flex items-center gap-2">
              <span className={`font-mono text-lg font-bold leading-none ${result.direction === 'call' ? 'text-emerald-300' : result.direction === 'put' ? 'text-rose-300' : 'text-[#7c8aa5]'}`}>
                {stateArrow(result.direction)}
              </span>
              <div className="flex flex-col">
                <span className={`font-mono text-[11px] font-bold uppercase tracking-wider ${STATE_CLASS[result.state]}`}>
                  {result.state === 'warming' ? 'warming up' : result.state === 'uncertain' ? 'uncertain - no edge' : `${result.state} ${result.direction}`}
                </span>
                <span className="font-mono text-[9px] text-[#7c8aa5]">{result.note}</span>
              </div>
              {result.direction !== 'none' && (
                <div className="ml-auto flex flex-col items-center">
                  <span className="font-mono text-lg font-bold leading-none text-[#dbe4f0]">{result.confidence}%</span>
                  <span className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">n={result.sampleSize}</span>
                </div>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]" title="latest confirmed bar's responseEfficiency / its own trailing average">
                ratio {Number.isFinite(result.lastResponseRatio) ? result.lastResponseRatio.toFixed(2) : 'n/a'}x
              </span>
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]" title="latest confirmed bar's close - open">
                disp {Number.isFinite(result.lastDisplacement) ? (result.lastDisplacement >= 0 ? '+' : '') + fmtPrice(result.lastDisplacement, asset) : 'n/a'}
              </span>
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]">
                {result.fidelity}
              </span>
            </div>
          </div>

          {/* honesty note - the calibration this read is built on */}
          <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[8.5px] leading-snug text-[#aebccf]">
            Self-calibrating per asset: every read recomputes the continuation/reversal rate from this asset&apos;s own trailing confirmed MRC bars, walk-forward - never a number borrowed from a different sample. A rate under 55%, or a bucket with too few of its own samples, reports <span className="text-[#7c8aa5]">uncertain</span> rather than a confident direction.
          </div>

          {/* state legend */}
          <div className="flex flex-wrap gap-1 border-t border-[#1c2739] pt-1.5">
            {(['continuation-likely', 'reversal-likely', 'uncertain', 'warming'] as MrcPredictState[]).map((st) => (
              <span key={st} className={`rounded border px-1 py-px font-mono text-[7.5px] uppercase ${STATE_BORDER[st]} ${STATE_CLASS[st]}`} title={STATE_HELP[st]}>
                {st}: {STATE_HELP[st]}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
