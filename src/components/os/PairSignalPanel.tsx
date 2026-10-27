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
import type { AdxPatternBiasFit, PairCompareDelta, PairSignalResponse, Timeframe, TpoResult } from '@/lib/os/client'
import { fmtPrice, getKalmanOuZ, getPairSignal, getTpoProfile } from '@/lib/os/client'
import { SideCard } from './PairComparePanel'

const POLL_MS = 10_000

/** Same info PatternChip's hover title shows for a pattern hit - just the
 * note + reliability/3 + bars-ago (no pattern name, that's what the chip
 * itself already prints), plus direction/reliability so a caller can color
 * and flag it exactly like the chip does. */
export interface PatternDetail {
  text: string
  direction: 'bullish' | 'bearish' | 'neutral'
  reliability: number
}

export function patternHitDetail(hit: { note: string; reliability: number; barsAgo: number; direction: 'bullish' | 'bearish' | 'neutral' } | null | undefined): PatternDetail | null {
  if (!hit) return null
  return { text: `${hit.note} · reliability ${hit.reliability}/3 · ${hit.barsAgo} bar(s) ago`, direction: hit.direction, reliability: hit.reliability }
}

/** Where the current price sits vs the TPO POC (analytics/tpo.ts) - a third
 * "something interesting happened" read alongside the candle/HA pattern
 * ones: reliability climbs the further price has pushed away from the POC
 * (1 = still inside the value area, 2 = outside it, 3 = outside it AND
 * outside the Initial Balance - a genuine range break), same arrow/color
 * treatment as a 3/3 pattern hit. */
function tpoPocDetail(tpo: TpoResult | null | undefined, price: number, asset: string): PatternDetail | null {
  if (!tpo || tpo.poc === null) return null
  const direction: 'bullish' | 'bearish' | 'neutral' = price > tpo.poc ? 'bullish' : price < tpo.poc ? 'bearish' : 'neutral'
  const insideVA = tpo.valueAreaHigh !== null && tpo.valueAreaLow !== null && price <= tpo.valueAreaHigh && price >= tpo.valueAreaLow
  const insideIB = tpo.ibHigh !== null && tpo.ibLow !== null && price <= tpo.ibHigh && price >= tpo.ibLow
  const reliability = insideVA ? 1 : insideIB ? 2 : 3
  const where = direction === 'neutral' ? 'at POC' : direction === 'bullish' ? 'above POC' : 'below POC'
  const context = insideVA ? 'inside value area' : insideIB ? 'outside value area' : 'outside value area, IB break'
  return { text: `Price ${where} ${fmtPrice(tpo.poc, asset)} · ${context}`, direction, reliability }
}

/** Kalman/OU stretch (analytics/kalman.ts's ouSeries, same z the "Kalman OU
 * Z" sub-pane plots): how many σ price sits off its own fitted OU
 * equilibrium. A real stretch is a MEAN-REVERSION read - price pushed above
 * equilibrium (z > 0) leans bearish (expected to revert down), pushed below
 * (z < 0) leans bullish - the opposite sign convention from the candle/HA/
 * POC breakout reads above it, which is exactly the point of showing it
 * alongside them. */
function kalmanOuDetail(z: number | null): PatternDetail | null {
  if (z === null || !Number.isFinite(z)) return null
  const direction: 'bullish' | 'bearish' | 'neutral' = z <= -0.25 ? 'bullish' : z >= 0.25 ? 'bearish' : 'neutral'
  const reliability = Math.abs(z) >= 2.5 ? 3 : Math.abs(z) >= 1.5 ? 2 : 1
  const read = direction === 'neutral' ? 'near equilibrium' : direction === 'bullish' ? 'stretched below - reversion up' : 'stretched above - reversion down'
  return { text: `OU z ${z >= 0 ? '+' : ''}${z.toFixed(2)} · ${read}`, direction, reliability }
}

/** ADX/DI trend read (analytics/adxpatternbias.ts's fit - same adx/+DI/-DI
 * the ADX+Pattern/Pair Signal composite already gates on), standalone here:
 * direction off which DI line leads, reliability off ADX's own strength
 * tiers (no trend / developing / strong). */
function adxDiDetail(fit: AdxPatternBiasFit | null | undefined): PatternDetail | null {
  if (!fit) return null
  const direction = fit.adxDirection
  const reliability = fit.adx >= 35 ? 3 : fit.adx >= 20 ? 2 : 1
  const rel = fit.plusDI > fit.minusDI ? '+DI>-DI' : fit.minusDI > fit.plusDI ? '-DI>+DI' : '+DI=-DI'
  const strength = fit.adx >= 35 ? 'strong trend' : fit.adx >= 20 ? 'developing trend' : 'no trend'
  return { text: `ADX ${fit.adx.toFixed(1)} ${rel} · ${strength}`, direction, reliability }
}

/** Latest closed candle's buy-sell delta (footprint.ts CLV-proxy, same
 * array the SideCard's own delta strip renders) - most recent entry only,
 * as a fourth quick read alongside Kalman/OU and ADX/DI. */
function deltaDetail(delta: PairCompareDelta[] | undefined): PatternDetail | null {
  if (!delta?.length) return null
  const last = delta[delta.length - 1]
  const direction: 'bullish' | 'bearish' | 'neutral' = last.delta > 0 ? 'bullish' : last.delta < 0 ? 'bearish' : 'neutral'
  const reliability: 1 | 2 | 3 = last.delta === 0 ? 1 : 3
  return { text: `Δ ${last.delta >= 0 ? '+' : ''}${last.delta.toFixed(1)} this candle`, direction, reliability }
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
   * top candle/HA pattern chip would show (see patternHitDetail) - for a
   * caller that wants to mirror that hover info somewhere else without
   * this panel's own rendering changing at all. */
  onDetail?: (d: {
    candle: PatternDetail | null
    ha: PatternDetail | null
    poc: PatternDetail | null
    ou: PatternDetail | null
    adx: PatternDetail | null
    delta: PatternDetail | null
  }) => void
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
              candle: patternHitDetail(d.side.fit?.patterns[0]),
              ha: patternHitDetail(d.side.fit?.haPatterns[0]),
              poc: null,
              ou: null,
              adx: adxDiDetail(d.side.fit),
              delta: deltaDetail(d.side.delta),
            })
            if (onDetail) {
              Promise.all([getTpoProfile(asset, tf, { limit: 400 }), getKalmanOuZ(asset, tf)])
                .then(([tpo, ouZ]) => {
                  onDetail({
                    candle: patternHitDetail(d.side.fit?.patterns[0]),
                    ha: patternHitDetail(d.side.fit?.haPatterns[0]),
                    poc: tpoPocDetail(tpo, d.side.price, asset),
                    ou: kalmanOuDetail(ouZ),
                    adx: adxDiDetail(d.side.fit),
                    delta: deltaDetail(d.side.delta),
                  })
                })
                .catch(() => {})
            }
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
