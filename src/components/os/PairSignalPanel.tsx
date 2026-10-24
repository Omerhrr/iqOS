'use client'

// IQAIR//OS - Pair Signal panel: the single-asset twin of Pair Compare. Type
// any one instrument and get back exactly the same card Pair Compare shows
// per side - ADX/DI + pattern bias + Heikin Ashi pattern bias + per-candle
// delta (analytics/adxpatternbias.ts + analytics/footprint.ts, pure reuse) -
// with no second asset to compare against and no lead-lag section, since
// there's nothing to lead or lag against with just one instrument. Backed by
// index.ts's /pair_signal. Shares PairComparePanel.tsx's own SideCard so the
// two panels never drift apart visually.
//
// Two usages: (1) the floating "Pair Signal" panel (opened from its own
// button) - uncontrolled, you type any one instrument and hit read,
// independent of whatever is selected elsewhere; (2) embedded wherever the
// OS's own selected asset should drive it directly (e.g. replacing the old
// IndicatorPanel below Market Watch) - pass `asset` and it becomes fully
// controlled: no input box, no manual "read", it just tracks that asset and
// re-fetches the moment it changes, same as every other asset-bound panel.
import { useCallback, useEffect, useState } from 'react'
import type { PairSignalResponse, Timeframe } from '@/lib/os/client'
import { getPairSignal } from '@/lib/os/client'
import { SideCard } from './PairComparePanel'

const POLL_MS = 10_000

/** Same line PatternChip's hover title shows for a pattern hit (name +
 * note + reliability/3 + bars-ago) - reused here so a readout fed by
 * onDetail reads identically to what hovering a chip already told you. */
export function patternHitDetailLine(hit: { name: string; note: string; reliability: number; barsAgo: number } | null | undefined): string | null {
  if (!hit) return null
  return `${hit.name} - ${hit.note} · reliability ${hit.reliability}/3 · ${hit.barsAgo} bar(s) ago`
}

export default function PairSignalPanel({
  onClose,
  tf,
  onSelectAsset,
  asset: controlledAsset,
  onDetail,
}: {
  onClose?: () => void
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
  /** When set, the panel is fully controlled by this asset (no input box,
   * no manual read) - it just follows whatever is passed in. Omit for the
   * standalone floating panel's own type-any-instrument behavior. */
  asset?: string
  /** Fired every time fresh data lands, with the same detail hovering the
   * top candle/HA pattern chip would show (see patternHitDetailLine) - for
   * a caller that wants to mirror that hover text somewhere else without
   * this panel's own rendering changing at all. */
  onDetail?: (d: { candle: string | null; ha: string | null }) => void
}) {
  const controlled = controlledAsset !== undefined
  const [asset, setAsset] = useState(controlledAsset ?? 'EURUSD')
  const [draft, setDraft] = useState(controlledAsset ?? 'EURUSD')
  const [data, setData] = useState<PairSignalResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // controlled mode: whenever the OS's own selected asset changes elsewhere
  // (Market Watch, the chart's own picker, a card click anywhere), follow it
  // automatically - no typing needed, exactly like every other asset-bound
  // panel already behaves.
  useEffect(() => {
    if (controlled && controlledAsset && controlledAsset !== asset) {
      setAsset(controlledAsset)
      setDraft(controlledAsset)
    }
  }, [controlled, controlledAsset, asset])

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true)
      getPairSignal(asset, tf)
        .then((d) => {
          if (d?.ok) {
            setData(d)
            setError(null)
            onDetail?.({
              candle: patternHitDetailLine(d.side.fit?.patterns[0]),
              ha: patternHitDetailLine(d.side.fit?.haPatterns[0]),
            })
          }
        })
        .catch((err: Error) => setError(err.message.slice(0, 180)))
        .finally(() => setLoading(false))
    },
    [asset, tf, onDetail],
  )

  useEffect(() => {
    load()
    const iv = setInterval(() => load({ quiet: true }), POLL_MS)
    return () => clearInterval(iv)
  }, [load])

  const applyDraft = () => {
    const a = draft.trim().toUpperCase()
    if (a) setAsset(a)
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">Pair Signal</span>
        {controlled && <span className="font-mono text-[9px] font-bold text-violet-300">{asset}</span>}
        <span className="font-mono text-[8px] text-[#3d4d66]">{tf}</span>
        {data && <span className="ml-auto font-mono text-[8px] text-[#4b5a72]">updated {new Date(data.ts).toLocaleTimeString()}</span>}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="close"
            className="ml-1 rounded px-1.5 py-0.5 font-mono text-[9px] text-[#5a6a85] hover:bg-[#1c2739] hover:text-[#aebccf]"
          >
            ✕
          </button>
        )}
      </div>

      {!controlled && (
        <div className="flex items-center gap-1 border-b border-[#1c2739] px-2 py-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyDraft()}
            placeholder="asset"
            spellCheck={false}
            className="w-28 rounded border border-[#1c2739] bg-[#101828] px-2 py-1 font-mono text-[10px] uppercase text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-violet-500/50"
          />
          <button
            type="button"
            onClick={applyDraft}
            className="ml-1 rounded border border-violet-500/40 bg-violet-500/10 px-2 py-1 font-mono text-[9px] font-bold uppercase text-violet-300 hover:bg-violet-500/20"
          >
            read
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && !data && <div className="p-2 font-mono text-[9px] text-[#5a6a85]">reading {asset}…</div>}
        {data && (
          <>
            <SideCard side={data.side} onSelectAsset={onSelectAsset} />
            <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
              Same read Pair Compare shows per side: ADX/DI + pattern bias, agreement-gated (analytics/adxpatternbias.ts),
              the same candlestick detectors run again against the Heikin Ashi transform of this series, and a
              trailing per-candle buy/sell delta strip (analytics/footprint.ts's CLV-proxy split - no true bid/ask
              feed, see its own header). Type any instrument above and hit read, or click the card to open it on the
              chart. The <span className="text-cyan-400/80">Pair Signal</span> strategy in the Strategy Lab and bot/
              auto-trader catalogs trades this exact composite, with the HA and delta reads adjusting its confidence.
            </p>
          </>
        )}
        {loading && <div className="px-1 font-mono text-[8px] text-[#3d4d66]">refreshing…</div>}
      </div>
    </div>
  )
}
