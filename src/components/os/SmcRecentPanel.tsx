'use client'

// IQAIR//OS - SMC Recent panel
// A standalone panel in the same spirit as the Next-Candle Oracle's own
// panel: instead of the full SMC tab's everything-at-once list (every kind,
// every age, filterable), this is just "what hit NOW and what hit 1 bar
// ago" on the chart's own asset+tf - the two ages that actually matter for
// reacting to structure in real time. Support & Resistance is deliberately
// EXCLUDED here per direct instruction - its touch-cluster read fires far
// more often than the other 14 concepts and drowns the signal that
// actually matters on a tight recent-only view (it still shows normally on
// the full SMC tab, this panel just isn't the place for it).
//
// Backed by the same /smc_scan index.ts route and analytics/smc.ts the SMC
// tab uses - no new backend, just a different, narrower lens on the same
// scan result.
import { useEffect, useState } from 'react'
import type { SmcKind, SmcScanResponse, SmcSignal, Timeframe } from '@/lib/os/client'
import { fmtPrice, getSmcScan } from '@/lib/os/client'

interface SmcRecentPanelProps {
  asset: string
  tf: Timeframe
  closedTick?: number
  onClose: () => void
  /** cross-nav: jump straight to the Next-Candle Oracle for this same asset */
  onOpenOracle?: (asset: string) => void
  /** cross-nav: jump straight to Accute for this same asset */
  onOpenAccute?: (asset: string) => void
}

const FALLBACK_POLL_MS = 8_000

/** Deliberately excluded from this panel - see module header. */
const EXCLUDED_KINDS: SmcKind[] = ['SUPPORT_RESISTANCE']

const KIND_LABEL: Record<SmcKind, string> = {
  FVG: 'Fair Value Gap',
  IFVG: 'Inverse FVG',
  ORDER_BLOCK: 'Order Block',
  BREAKER_BLOCK: 'Breaker Block',
  LIQUIDITY_SWEEP: 'Liquidity Sweep',
  BOS: 'Break of Structure',
  CHOCH: 'CHoCH',
  OTE: 'OTE',
  KRM: 'KRM',
  SUPPLY_DEMAND: 'Supply & Demand',
  SUPPORT_RESISTANCE: 'Support & Resistance',
  BREAKOUT: 'Breakout',
  CRT: 'CRT',
  POWER_OF_3: 'Power of 3',
  SILVER_BULLET: 'Silver Bullet',
}

function dirColor(d: 'bullish' | 'bearish', part: 'text' | 'bg' | 'border' = 'text'): string {
  const map = {
    bullish: { text: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40' },
    bearish: { text: 'text-rose-300', bg: 'bg-rose-500/10', border: 'border-rose-500/40' },
  }
  return map[d][part]
}

function RecentRow({ s, price, asset }: { s: SmcSignal; price: number; asset: string }) {
  const hasZone = s.top !== undefined && s.bottom !== undefined
  return (
    <div className={`rounded-lg border bg-[#0b111c] p-2 ${dirColor(s.direction, 'border')}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#dbe4f0]">{KIND_LABEL[s.kind]}</span>
        <span className={`rounded px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-wider ${dirColor(s.direction, 'bg')} ${dirColor(s.direction)}`}>
          {s.direction === 'bullish' ? '▲ bull' : '▼ bear'}
        </span>
        <span className="ml-auto font-mono text-[9px] text-[#4b5a72]">{s.barsAgo === 0 ? 'now' : `${s.barsAgo} bar ago`}</span>
      </div>
      {hasZone ? (
        <div className="mt-1 flex items-center gap-2 font-mono text-[9px] text-[#aab6cc]">
          <span>top {fmtPrice(s.top ?? 0, asset)}</span>
          <span>bottom {fmtPrice(s.bottom ?? 0, asset)}</span>
        </div>
      ) : s.level !== undefined ? (
        <div className="mt-1 font-mono text-[9px] text-[#aab6cc]">level {fmtPrice(s.level, asset)}</div>
      ) : null}
      <p className="mt-1 text-[9px] leading-snug text-[#7c8aa5]">{s.note}</p>
    </div>
  )
}

export default function SmcRecentPanel({ asset, tf, closedTick, onClose, onOpenOracle, onOpenAccute }: SmcRecentPanelProps) {
  const [data, setData] = useState<SmcScanResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setBusy(true)
    getSmcScan(asset, tf)
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e: Error) => setError(e.message.slice(0, 180)))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, tf, closedTick])

  useEffect(() => {
    const iv = setInterval(load, FALLBACK_POLL_MS)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, tf])

  const result = data?.result ?? null
  const eligible = (result?.signals ?? []).filter((s) => !EXCLUDED_KINDS.includes(s.kind))
  const now = eligible.filter((s) => s.barsAgo === 0)
  const oneBarAgo = eligible.filter((s) => s.barsAgo === 1)

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex items-center gap-2 border-b border-[#1c2739] px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-300">SMC Recent</span>
        <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-px font-mono text-[9px] font-bold uppercase text-cyan-300">
          {asset} · {tf}
        </span>
        {result && (
          <span
            className={`rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-wider ${
              result.trend === 'bullish' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : result.trend === 'bearish' ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-[#1c2739] text-[#7c8aa5]'
            }`}
          >
            structure: {result.trend}
          </span>
        )}
        {onOpenOracle && (
          <button
            type="button"
            onClick={() => onOpenOracle(asset)}
            className={`rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-amber-500/40 hover:text-amber-300 ${onOpenAccute ? '' : 'ml-auto'}`}
            title="open the Next-Candle Oracle for this asset"
          >
            → oracle
          </button>
        )}
        {onOpenAccute && (
          <button
            type="button"
            onClick={() => onOpenAccute(asset)}
            className={`rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-sky-500/40 hover:text-sky-300 ${onOpenOracle ? '' : 'ml-auto'}`}
            title="open Accute for this asset"
          >
            → accute
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className={`rounded px-2 py-1 font-mono text-[10px] text-[#7c8aa5] hover:bg-[#1c2739] hover:text-[#dbe4f0] ${onOpenOracle || onOpenAccute ? '' : 'ml-auto'}`}
        >
          close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2.5 space-y-3">
        {!data && busy && <div className="p-2 text-[10px] text-[#4b5a72]">scanning structure…</div>}
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {data && !result && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">Not enough candle history yet on {asset} · {tf} - needs at least 60 bars.</div>
        )}

        {result && (
          <>
            <div>
              <div className="mb-1 flex items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#dbe4f0]">Now (this candle)</span>
                <span className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] text-[#7c8aa5]">{now.length}</span>
              </div>
              {now.length === 0 ? (
                <p className="text-[9px] text-[#4b5a72]">Nothing has hit yet on this candle.</p>
              ) : (
                <div className="space-y-1.5">
                  {now.map((s, i) => (
                    <RecentRow key={`now-${s.kind}-${s.index}-${i}`} s={s} price={result.price} asset={asset} />
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="mb-1 flex items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#dbe4f0]">1 bar ago</span>
                <span className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] text-[#7c8aa5]">{oneBarAgo.length}</span>
              </div>
              {oneBarAgo.length === 0 ? (
                <p className="text-[9px] text-[#4b5a72]">Nothing hit the bar before this one.</p>
              ) : (
                <div className="space-y-1.5">
                  {oneBarAgo.map((s, i) => (
                    <RecentRow key={`prev-${s.kind}-${s.index}-${i}`} s={s} price={result.price} asset={asset} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <p className="border-t border-[#1c2739] px-2.5 py-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
        Only this candle and the one before it - for the full history/filterable list use the SMC tab. Support &amp; Resistance is
        excluded here (fires too often to be useful at this zoom level). Refreshes on every closed candle, or every ~8s.
      </p>
    </div>
  )
}
