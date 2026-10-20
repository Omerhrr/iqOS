'use client'

// IQAIR//OS - Pair Compare panel: for any two assets (default EURUSD/
// US2000), each asset's own ADX/DI + pattern bias read side by side, PLUS
// the lead-lag relationship between the pair tested in BOTH directions
// (fitLeadLag only fits the best lag for whichever leader/follower
// assignment it's handed - it doesn't decide which side actually leads, so
// this panel runs it both ways and reports whichever direction's |corr| is
// stronger). Not a universe scanner like the other panels - a focused
// two-asset comparison. Backed by index.ts's /pair_compare
// (analytics/adxpatternbias.ts + analytics/leadlag.ts, pure-function reuse).

import { useCallback, useEffect, useState } from 'react'
import type { PairCompareResponse, PairCompareSide, PairCompareLeadLag, Timeframe } from '@/lib/os/client'
import { getPairCompare, fmtPrice } from '@/lib/os/client'

const POLL_MS = 10_000

function dirChip(direction: 'call' | 'put' | null) {
  if (!direction) {
    return <span className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">flat</span>
  }
  const call = direction === 'call'
  return (
    <span
      className={`rounded px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-wider ${
        call ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
      }`}
    >
      {call ? '▲ call' : '▼ put'}
    </span>
  )
}

function SideCard({ side, onSelectAsset }: { side: PairCompareSide; onSelectAsset?: (a: string) => void }) {
  const fit = side.fit
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(side.asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(side.asset)
      }}
      className={`w-full cursor-pointer rounded-lg border p-2 text-left transition-opacity hover:border-violet-500/40 ${
        fit?.qualifies ? 'border-violet-500/30 bg-[#140c1f]' : 'border-[#1c2739] bg-[#0b111c]'
      }`}
      title={`open ${side.asset} on the chart`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {dirChip(side.direction)}
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{side.asset}</span>
        {side.otc && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400">otc</span>
        )}
        {!side.open && (
          <span className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] uppercase text-[#4b5a72]" title="market closed">
            closed
          </span>
        )}
        {fit?.agree && (
          <span className="rounded border border-violet-500/40 bg-violet-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-violet-300" title="ADX/DI and pattern bias agree">
            agree
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">{fmtPrice(side.price, side.asset)}</span>
      </div>
      {!fit ? (
        <div className="mt-1.5 font-mono text-[9px] text-[#4b5a72]">thin history - no honest ADX/pattern read yet</div>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#7c8aa5]">
          <span title="ADX(14) - trend strength; >=25 is considered trending">
            ADX <span className={fit.trending ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{fit.adx.toFixed(1)}</span>
          </span>
          <span title="+DI / -DI - which side of the trend is in control">
            DI <span className="text-emerald-400/80">{fit.plusDI.toFixed(1)}</span>/<span className="text-rose-400/80">{fit.minusDI.toFixed(1)}</span>
          </span>
          <span title="net candlestick pattern bias, recency+reliability weighted, range -6..+6">
            pattern <span className={Math.abs(fit.patternBias) >= 0.5 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{fit.patternBias >= 0 ? '+' : ''}{fit.patternBias.toFixed(1)}</span>
          </span>
          {fit.topPattern && (
            <span title={`most recent pattern hit, ${fit.topPatternBarsAgo} bar(s) ago`}>
              <span className="text-[#aebccf]">{fit.topPattern}</span>
            </span>
          )}
          <span title="combined ADX/DI + pattern bias score, range -10..+10">
            comp <span className={Math.abs(fit.composite) >= 3.5 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{fit.composite >= 0 ? '+' : ''}{fit.composite.toFixed(1)}</span>
          </span>
        </div>
      )}
    </div>
  )
}

function CorrelationBar({ ll }: { ll: PairCompareLeadLag }) {
  const pos = ll.correlation >= 0
  const width = Math.min(100, Math.abs(ll.correlation) * 100)
  return (
    <div className="h-1 w-full overflow-hidden rounded bg-[#101828]" title={`correlation ${ll.correlation.toFixed(2)} at lag ${ll.lag} bar(s), ${ll.lagsTested} lags tested, n=${ll.n}`}>
      <div className={`h-full ${pos ? 'bg-cyan-500' : 'bg-amber-500'}`} style={{ width: `${Math.max(4, width)}%` }} />
    </div>
  )
}

function DirectionRow({ label, ll, leading }: { label: string; ll: PairCompareLeadLag; leading: boolean }) {
  return (
    <div className={`rounded-lg border p-2 ${leading ? 'border-cyan-500/30 bg-[#08161c]' : 'border-[#1c2739] bg-[#0b111c]'}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#aebccf]">{label}</span>
        {leading && (
          <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-cyan-300" title="the stronger of the two directions tested">
            stronger
          </span>
        )}
        {ll.qualifies && (
          <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-emerald-300" title="clears the lead-lag strategy's own correlation + trigger-z thresholds">
            qualifies
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">
          lag {ll.lag}b · n={ll.n}
        </span>
      </div>
      <div className="mt-1.5">
        <CorrelationBar ll={ll} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#7c8aa5]">
        <span title="Pearson correlation of the leader's return vs the follower's return at the winning lag">
          corr <span className={ll.correlation >= 0 ? 'text-cyan-300' : 'text-amber-300'}>{ll.correlation.toFixed(2)}</span>
        </span>
        {ll.signal ? (
          <>
            <span title="how many sigmas the leader's own trigger move was from its own recent return distribution">
              trigger z <span className={Math.abs(ll.signal.triggerZ) >= 1 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{ll.signal.triggerZ.toFixed(1)}</span>
            </span>
            <span title="the leader's own return at the winning lag offset back">
              {ll.signal.triggerReturn >= 0 ? '+' : ''}{(ll.signal.triggerReturn * 100).toFixed(2)}%
            </span>
            {dirChip(ll.signal.direction)}
          </>
        ) : (
          <span className="text-[#4b5a72]">no honest trigger signal yet (thin history or flat tape)</span>
        )}
      </div>
    </div>
  )
}

export default function PairComparePanel({
  onClose,
  tf,
  onSelectAsset,
}: {
  onClose: () => void
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
}) {
  const [assetA, setAssetA] = useState('EURUSD')
  const [assetB, setAssetB] = useState('US2000')
  const [draftA, setDraftA] = useState('EURUSD')
  const [draftB, setDraftB] = useState('US2000')
  const [data, setData] = useState<PairCompareResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true)
      getPairCompare(assetA, assetB, tf)
        .then((d) => {
          if (d?.ok) {
            setData(d)
            setError(null)
          }
        })
        .catch((err: Error) => setError(err.message.slice(0, 180)))
        .finally(() => setLoading(false))
    },
    [assetA, assetB, tf],
  )

  useEffect(() => {
    load()
    const iv = setInterval(() => load({ quiet: true }), POLL_MS)
    return () => clearInterval(iv)
  }, [load])

  const swap = () => {
    setAssetA(assetB)
    setAssetB(assetA)
    setDraftA(assetB)
    setDraftB(assetA)
  }

  const applyDraft = () => {
    const a = draftA.trim().toUpperCase()
    const b = draftB.trim().toUpperCase()
    if (a) setAssetA(a)
    if (b) setAssetB(b)
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">Pair Compare</span>
        <span className="font-mono text-[8px] text-[#3d4d66]">{tf}</span>
        {data && <span className="ml-auto font-mono text-[8px] text-[#4b5a72]">updated {new Date(data.ts).toLocaleTimeString()}</span>}
        <button
          type="button"
          onClick={onClose}
          title="close"
          className="ml-1 rounded px-1.5 py-0.5 font-mono text-[9px] text-[#5a6a85] hover:bg-[#1c2739] hover:text-[#aebccf]"
        >
          ✕
        </button>
      </div>

      <div className="flex items-center gap-1 border-b border-[#1c2739] px-2 py-1.5">
        <input
          value={draftA}
          onChange={(e) => setDraftA(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyDraft()}
          placeholder="asset A"
          spellCheck={false}
          className="w-24 rounded border border-[#1c2739] bg-[#101828] px-2 py-1 font-mono text-[10px] uppercase text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-violet-500/50"
        />
        <button type="button" onClick={swap} title="swap A and B" className="rounded px-1.5 py-1 font-mono text-[10px] text-[#5a6a85] hover:bg-[#1c2739] hover:text-[#aebccf]">
          ⇄
        </button>
        <input
          value={draftB}
          onChange={(e) => setDraftB(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyDraft()}
          placeholder="asset B"
          spellCheck={false}
          className="w-24 rounded border border-[#1c2739] bg-[#101828] px-2 py-1 font-mono text-[10px] uppercase text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-violet-500/50"
        />
        <button
          type="button"
          onClick={applyDraft}
          className="ml-1 rounded border border-violet-500/40 bg-violet-500/10 px-2 py-1 font-mono text-[9px] font-bold uppercase text-violet-300 hover:bg-violet-500/20"
        >
          compare
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && !data && <div className="p-2 font-mono text-[9px] text-[#5a6a85]">reading {assetA} vs {assetB}…</div>}
        {data && (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <SideCard side={data.a} onSelectAsset={onSelectAsset} />
              <SideCard side={data.b} onSelectAsset={onSelectAsset} />
            </div>
            <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
              Each side's ADX/DI + pattern bias is the exact same read the ADX/DI + Pattern panel scans the universe
              with (analytics/adxpatternbias.ts) - trend strength/direction combined with recent candlestick
              pattern bias, agreement-gated.
            </p>
            <div className="space-y-1.5">
              <DirectionRow
                label={`${data.a.asset} leads ${data.b.asset}`}
                ll={data.leadlag.aLeadsB}
                leading={data.leadlag.strongerDirection === 'aLeadsB'}
              />
              <DirectionRow
                label={`${data.b.asset} leads ${data.a.asset}`}
                ll={data.leadlag.bLeadsA}
                leading={data.leadlag.strongerDirection === 'bLeadsA'}
              />
            </div>
            <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
              Lead-lag fits a Pearson correlation between the two assets' bar-over-bar RETURNS across lags 0..10,
              for each direction independently (analytics/leadlag.ts) - the math never assumes which side actually
              leads, it only fits the best lag for whichever assignment it's handed, so this runs it both ways and
              marks whichever direction's |correlation| came out stronger. A short window and small sample size can
              both produce a lag that looks meaningful but isn't - treat a borderline read here the same way you'd
              treat any single backtest window, not as settled fact. <span className="text-cyan-400/80">qualifies</span>{' '}
              means that direction clears the same correlation + trigger-z thresholds the lead-lag auto-trade source
              requires. Click either asset's card to open it on the chart.
            </p>
          </>
        )}
        {loading && <div className="px-1 font-mono text-[8px] text-[#3d4d66]">refreshing…</div>}
      </div>
    </div>
  )
}
