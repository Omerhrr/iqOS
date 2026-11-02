'use client'

// IQAIR//OS - ADX/DI + Pattern Bias panel: every open instrument's trend
// strength/direction (ADX/+DI/-DI) combined with its recent candlestick
// pattern bias into one agreement-gated composite, scanned across the whole
// universe at once. Same "list of candidates" shape as Chart Signals/Lead-
// Lag/Cointegration/Vol Arb/Triangulation. Backed by index.ts's
// /adx_pattern_bias_scan (analytics/adxpatternbias.ts).

import { useCallback, useEffect, useState } from 'react'
import type { AdxPatternBiasScanResponse, AdxPatternBiasScanRow, AdxPatternBiasStatsResponse, Timeframe } from '@/lib/os/client'
import { getAdxPatternBiasScan, getAdxPatternBiasStats, fmtPrice } from '@/lib/os/client'

const POLL_MS = 10_000
const STATS_POLL_MS = 20_000

/** Compact strip of the honesty loop's own learned numbers - every one of
 * these already silently shapes the scan above (leg weights feed
 * composite(), qualifyBar replaces the flat 3.5, htfPenaltyMult replaces
 * the flat htf-veto block, confluenceBoost nudges score/confidence when
 * the oracle agrees); this is just what makes any of that visible. */
function LearnedStatsStrip({ stats }: { stats: AdxPatternBiasStatsResponse }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1c2739] bg-[#0b111c] px-2 py-1.5 font-mono text-[8.5px]">
      <span className="text-[#4b5a72]">honesty loop</span>
      <span className="text-[#7c8aa5]">
        n={stats.total} · hit {stats.hitRate !== null ? `${(stats.hitRate * 100).toFixed(0)}%` : 'n/a'}
      </span>
      <span
        className={`rounded border px-1 py-px ${stats.legWeights ? 'border-violet-500/40 text-violet-300' : 'border-[#1c2739] text-[#4b5a72]'}`}
        title="learned relative weight of the ADX/DI trend leg vs the pattern leg in composite() - unset (1:1) until both legs have >=30 resolved samples"
      >
        {stats.legWeights ? `legs trend ${stats.legWeights.trendWeight.toFixed(2)}× / pattern ${stats.legWeights.patternWeight.toFixed(2)}×` : 'legs 1:1 (learning)'}
      </span>
      <span
        className={`rounded border px-1 py-px ${stats.qualifyBar !== null ? 'border-violet-500/40 text-violet-300' : 'border-[#1c2739] text-[#4b5a72]'}`}
        title="learned replacement for the flat 3.5 qualify bar - smallest composite threshold whose own resolved hit rate clears 55%"
      >
        bar {stats.qualifyBar !== null ? stats.qualifyBar.toFixed(1) : '3.5 (default)'}
      </span>
      <span
        className={`rounded border px-1 py-px ${stats.qualifyBarByDirection.bullish !== null || stats.qualifyBarByDirection.bearish !== null ? 'border-violet-500/40 text-violet-300' : 'border-[#1c2739] text-[#4b5a72]'}`}
        title="direction-split qualify bar - a pair/regime can carry a structural trend bias that makes bullish and bearish reads differently reliable. Falls back to the flat bar above, per direction, below 30 resolved samples on that side."
      >
        bar↑{stats.qualifyBarByDirection.bullish !== null ? stats.qualifyBarByDirection.bullish.toFixed(1) : '—'} / bar↓{stats.qualifyBarByDirection.bearish !== null ? stats.qualifyBarByDirection.bearish.toFixed(1) : '—'}
      </span>
      <span
        className={`rounded border px-1 py-px ${stats.htfPenaltyMult !== null ? 'border-violet-500/40 text-violet-300' : 'border-[#1c2739] text-[#4b5a72]'}`}
        title="learned HTF-veto penalty: the composite margin an HTF-disagreeing read must clear to still qualify, as a multiple of the normal bar. Unset = still a flat hard block."
      >
        htf {stats.htfPenaltyMult !== null ? `×${stats.htfPenaltyMult.toFixed(1)}` : 'hard veto (default)'}
      </span>
      <span
        className={`rounded border px-1 py-px ${stats.haPenaltyMult !== null ? 'border-violet-500/40 text-violet-300' : 'border-[#1c2739] text-[#4b5a72]'}`}
        title="learned HA (Heikin Ashi pattern)-veto penalty - the haBlocks counterpart of the HTF penalty above. Unset = still a flat hard block."
      >
        ha {stats.haPenaltyMult !== null ? `×${stats.haPenaltyMult.toFixed(1)}` : 'hard veto (default)'}
      </span>
      <span
        className={`rounded border px-1 py-px ${stats.confluenceBoost > 1 ? 'border-emerald-500/40 text-emerald-300' : 'border-[#1c2739] text-[#4b5a72]'}`}
        title="learned confidence/score multiplier applied when the Next-Candle Oracle actively agrees on direction"
      >
        confluence ×{stats.confluenceBoost.toFixed(2)}
      </span>
      <span
        className={`rounded border px-1 py-px ${stats.volumeBoost > 1 ? 'border-emerald-500/40 text-emerald-300' : 'border-[#1c2739] text-[#4b5a72]'}`}
        title="learned, bounded boost (capped ×1.2) to the composite-vs-qualify-bar comparison when volumeConfirms reads true - routinely slow to earn trust on OTC/binary feeds with no real volume data"
      >
        volume ×{stats.volumeBoost.toFixed(2)}
      </span>
      <span
        className={`rounded border px-1 py-px ${stats.trendThreshold !== null ? 'border-violet-500/40 text-violet-300' : 'border-[#1c2739] text-[#4b5a72]'}`}
        title="learned ADX trend threshold - the smallest level, among a small ascending sweep, whose own resolved subset clears a 55% hit rate. Can only ever rise above the flat default of 25."
      >
        adx≥{stats.trendThreshold !== null ? stats.trendThreshold.toFixed(0) : '25 (default)'}
      </span>
    </div>
  )
}

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

function AdxPatternBiasCard({ r, onSelectAsset }: { r: AdxPatternBiasScanRow; onSelectAsset?: (a: string) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(r.asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(r.asset)
      }}
      className={`w-full cursor-pointer rounded-lg border p-2 text-left transition-opacity hover:border-violet-500/40 ${
        r.qualifies ? 'border-violet-500/30 bg-[#140c1f]' : 'border-[#1c2739] bg-[#0b111c]'
      }`}
      title={`open ${r.asset} on the chart`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {dirChip(r.direction)}
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{r.asset}</span>
        {r.otc && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400">otc</span>
        )}
        {r.agree && (
          <span
            className="rounded border border-violet-500/40 bg-violet-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-violet-300"
            title="ADX/DI direction and pattern bias direction agree"
          >
            agree
          </span>
        )}
        {r.qualifies && (
          <span
            className="rounded border border-violet-500/40 bg-violet-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-violet-300"
            title="agreeing reads whose composite clears the threshold"
          >
            qualifies
          </span>
        )}
        {r.haDisagrees && (
          <span
            className="rounded border border-rose-500/40 bg-rose-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-rose-300"
            title="Heikin Ashi pattern read (independent third signal) contradicts this direction - vetoes qualification even though ADX/DI and raw-candle patterns agree"
          >
            ha veto
          </span>
        )}
        {r.htfDisagrees && (
          <span
            className="rounded border border-rose-500/40 bg-rose-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-rose-300"
            title={(() => {
              const dirBias = r.direction === 'call' ? 'bullish' : r.direction === 'put' ? 'bearish' : null
              return (
                [
                  r.htfDirection !== 'neutral' && r.htfDirection !== dirBias ? `HTF ADX/DI reads ${r.htfDirection}` : null,
                  r.htfPatternDirection !== 'neutral' && r.htfPatternDirection !== dirBias ? `HTF pattern reads ${r.htfPatternDirection}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'the same ADX/DI or pattern read one timeframe rung up contradicts this direction'
              )
            })()}
          >
            htf veto
          </span>
        )}
        {r.regime === 'VOLATILE' && (
          <span
            className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400"
            title="Oracle regime classifier reads this bar as VOLATILE - the composite had to clear a 25% higher bar to qualify"
          >
            volatile
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">{fmtPrice(r.price, r.asset)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#7c8aa5]">
        <span title="ADX(14) - trend strength; >=25 is considered trending">
          ADX <span className={r.trending ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.adx.toFixed(1)}</span>
        </span>
        <span title="+DI / -DI - which side of the trend is in control">
          DI <span className="text-emerald-400/80">{r.plusDI.toFixed(1)}</span>/<span className="text-rose-400/80">{r.minusDI.toFixed(1)}</span>
        </span>
        <span title="net candlestick pattern bias, recency+reliability weighted, range -6..+6">
          pattern <span className={Math.abs(r.patternBias) >= 0.5 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.patternBias >= 0 ? '+' : ''}{r.patternBias.toFixed(1)}</span>
        </span>
        {r.topPattern && (
          <span title={`most recent pattern hit, ${r.topPatternBarsAgo} bar(s) ago`}>
            <span className="text-[#aebccf]">{r.topPattern}</span>
          </span>
        )}
        <span title="combined ADX/DI + pattern bias score, range -10..+10">
          comp <span className={Math.abs(r.composite) >= 3.5 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.composite >= 0 ? '+' : ''}{r.composite.toFixed(1)}</span>
        </span>
        {r.volumeConfirms !== null && (
          <span title="did the strongest recent pattern hit's bar carry above-average volume for this window?">
            vol <span className={r.volumeConfirms ? 'text-emerald-400/80' : 'text-[#4b5a72]'}>{r.volumeConfirms ? 'confirms' : 'thin'}</span>
          </span>
        )}
      </div>
    </div>
  )
}

export default function AdxPatternBiasPanel({
  onClose,
  tf,
  onSelectAsset,
}: {
  onClose: () => void
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
}) {
  const [data, setData] = useState<AdxPatternBiasScanResponse | null>(null)
  const [stats, setStats] = useState<AdxPatternBiasStatsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [onlyQualifying, setOnlyQualifying] = useState(false)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true)
      getAdxPatternBiasScan(tf)
        .then((d) => {
          if (d?.ok) {
            setData(d)
            setError(null)
          }
        })
        .catch((err: Error) => setError(err.message.slice(0, 180)))
        .finally(() => setLoading(false))
    },
    [tf],
  )

  const loadStats = useCallback(() => {
    getAdxPatternBiasStats()
      .then((d) => {
        if (d?.ok) setStats(d)
      })
      .catch(() => {
        // learned-stats strip is optional - never block the scan on it
      })
  }, [])

  useEffect(() => {
    load()
    const iv = setInterval(() => load({ quiet: true }), POLL_MS)
    return () => clearInterval(iv)
  }, [load])

  useEffect(() => {
    loadStats()
    const iv = setInterval(loadStats, STATS_POLL_MS)
    return () => clearInterval(iv)
  }, [loadStats])

  const needle = query.trim().toLowerCase()
  const rows = (data?.rows ?? [])
    .filter((r) => (onlyQualifying ? r.qualifies : true))
    .filter((r) => (!needle ? true : r.asset.toLowerCase().includes(needle) || (r.topPattern ?? '').toLowerCase().includes(needle)))

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">ADX/DI + Pattern Bias</span>
        <span className="font-mono text-[8px] text-[#3d4d66]">{tf}</span>
        {data && (
          <span className="ml-auto font-mono text-[8px] text-[#4b5a72]">
            {data.scanned} scanned
            {data.qualifying > 0 && <span className="ml-1 font-bold text-violet-400">· {data.qualifying} qualify</span>}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          title="close"
          className="ml-1 rounded px-1.5 py-0.5 font-mono text-[9px] text-[#5a6a85] hover:bg-[#1c2739] hover:text-[#aebccf]"
        >
          ✕
        </button>
      </div>

      {stats && <LearnedStatsStrip stats={stats} />}

      <div className="flex items-center gap-1 border-b border-[#1c2739] px-2 py-1">
        <div className="relative min-w-0 flex-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="search… e.g. EURUSD, Hammer"
            spellCheck={false}
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1 pr-6 font-mono text-[10px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-violet-500/50"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              title="clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 font-mono text-[10px] text-[#4b5a72] hover:text-rose-300"
            >
              ×
            </button>
          )}
        </div>
        <label className="flex shrink-0 items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]" title="hide everything whose ADX/DI direction and pattern bias don't agree, or whose composite is weak">
          <input type="checkbox" checked={onlyQualifying} onChange={(e) => setOnlyQualifying(e.target.checked)} className="accent-violet-500" />
          qualifying only
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && !data && <div className="p-2 font-mono text-[9px] text-[#5a6a85]">reading trend + pattern bias across the universe…</div>}
        {!error && data && rows.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {onlyQualifying
              ? 'Nothing currently has ADX/DI and pattern bias agreeing with a strong enough composite. Uncheck "qualifying only" to see every read.'
              : 'No assets match the current filter.'}
          </div>
        )}
        {rows.map((r) => (
          <AdxPatternBiasCard key={r.asset} r={r} onSelectAsset={onSelectAsset} />
        ))}
        {data && data.rows.length > 0 && (
          <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
            ADX/+DI/-DI reads trend strength and direction (ADX &gt;= 25 counts as trending); pattern bias is the net,
            recency+reliability weighted candlestick read over the last few bars (-6..+6). The composite sums the two when
            they point the same way and halves the sum when they fight, so a strong trend running into a fresh reversal
            candle gets pulled back toward 0 instead of just winning on size. <span className="text-violet-400/80">agree</span> marks
            direction agreement; <span className="text-violet-400/80">qualifies</span> adds the composite-strength bar on top.
            <span className="text-rose-400/80">ha veto</span> is a third, independent read - the same pattern catalog re-run on
            smoothed Heikin Ashi candles - and blocks qualification when it actively disagrees, even though ADX/DI and the raw
            candles agree. <span className="text-rose-400/80">htf veto</span> is a fourth independent read: the same ADX/DI check
            AND the same pattern check, both one timeframe rung up - either one disagreeing blocks qualification the same way
            (hover the chip to see which). ADX also now requires the trend reading to have held for 2 consecutive bars, not
            just the current one, before counting as trending at all - a one-bar spike no longer qualifies alone.{' '}
            <span className="text-amber-400/80">volatile</span>{' '}
            means the Oracle's own regime classifier reads this bar as choppy, so the composite needed to clear a 25% higher
            bar rather than being blocked outright. <span className="text-[#aebccf]">vol confirms/thin</span> is informational only
            - whether the top pattern hit's own bar carried above-average volume - and never gates qualification, since many
            OTC/binary feeds carry no real volume data at all. Click a card to open that asset on the chart.
          </p>
        )}
        {loading && <div className="px-1 font-mono text-[8px] text-[#3d4d66]">refreshing…</div>}
      </div>
    </div>
  )
}
