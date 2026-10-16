'use client'

// IQAIR//OS - Lead-Lag sidebar. Intermarket analysis, not technical
// analysis on the asset itself: for each of a handful of liquidity/macro
// "leader" instruments (EUR/USD for major FX crosses, Gold for the other
// precious metals, Bitcoin for crypto alts, WTI/Brent for CAD pairs) this
// panel shows a rolling cross-correlation fit against every follower in
// that group - whichever lag (0-10 bars back) correlates strongest, the
// leader's own trigger move at that lag and how unusual it was (z-score),
// and the projected direction. Every row is shown, not just the ones
// strong enough to trade on - a `qualifies` badge marks exactly the rows
// that clear the SAME thresholds the auto-trader's lead-lag source itself
// requires (|corr| >= 0.35, |triggerZ| >= 1), so this is a read of what
// the auto-trader would act on right now, not a separate, looser read.
// The scan runs on the chart's active timeframe (same convention as Chart
// Signals). Every row that qualifies also enters an honesty loop (mirrored
// off chart-signals' Task 64-c tracker, scoped down since lead-lag has no
// engine roster or CFD plan): the follower's price at a horizon set by the
// fitted lag decides win/loss/flat, aggregated per leader group in the
// hit-rate view - this is what actually answers "is this better than
// watching indicators" with numbers, not just a plausible-looking fit.
import { useCallback, useEffect, useState } from 'react'
import type { LeadLagRow, LeadLagScanResult, LeadLagStats, Timeframe } from '@/lib/os/client'
import { fmtPrice, getLeadLag, getLeadLagStats } from '@/lib/os/client'

interface LeadLagPanelProps {
  onClose: () => void
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
}

type GroupFilter = 'all' | string

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

const POLL_MS = 15_000

function CorrelationBar({ r }: { r: LeadLagRow }) {
  const pos = r.correlation >= 0
  const width = Math.min(100, Math.abs(r.correlation) * 100)
  return (
    <div
      className="h-1 w-full overflow-hidden rounded bg-[#101828]"
      title={`correlation ${r.correlation.toFixed(2)} at lag ${r.lag} bar${r.lag === 1 ? '' : 's'} (${r.lagsTested} lags tested, n=${r.n})`}
    >
      <div className={`h-full ${pos ? 'bg-cyan-500' : 'bg-amber-500'}`} style={{ width: `${Math.max(4, width)}%` }} />
    </div>
  )
}

function LeadLagCard({ r, onSelectAsset }: { r: LeadLagRow; onSelectAsset?: (a: string) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(r.asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(r.asset)
      }}
      className={`w-full cursor-pointer rounded-lg border p-2 text-left transition-opacity hover:border-cyan-500/40 ${
        r.qualifies ? 'border-emerald-500/30 bg-[#0b1710]' : 'border-[#1c2739] bg-[#0b111c]'
      }`}
      title={`open ${r.asset} on the chart`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {dirChip(r.direction)}
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{r.asset}</span>
        {r.otc && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400">otc</span>
        )}
        {!r.open && (
          <span className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] uppercase text-[#4b5a72]" title="market closed - no live candles to fit against right now">
            closed
          </span>
        )}
        {r.qualifies && (
          <span
            className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-emerald-300"
            title="clears the same thresholds the auto-trader's lead-lag source requires - this is what it would act on right now"
          >
            qualifies
          </span>
        )}
        <span className="font-mono text-[9px] text-[#4b5a72]">{fmtPrice(r.price, r.asset)}</span>
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">
          lag {r.lag}b · n={r.n}
        </span>
      </div>
      <div className="mt-1.5">
        <CorrelationBar r={r} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#7c8aa5]">
        <span title="Pearson correlation of the leader's return vs this follower's return at the winning lag">
          corr <span className={r.correlation >= 0 ? 'text-cyan-300' : 'text-amber-300'}>{r.correlation.toFixed(2)}</span>
        </span>
        <span title="how many sigmas the leader's own trigger move was from its own recent return distribution">
          trigger z <span className={Math.abs(r.triggerZ) >= 1 ? 'text-[#dbe4f0]' : 'text-[#4b5a72]'}>{r.triggerZ.toFixed(1)}</span>
        </span>
        <span title="the leader's own return at the winning lag offset back">
          {r.leader} {r.triggerReturn >= 0 ? '+' : ''}{(r.triggerReturn * 100).toFixed(2)}%
        </span>
      </div>
    </div>
  )
}

function outcomeColor(o: string): string {
  return o === 'win' ? 'text-emerald-300' : o === 'loss' ? 'text-rose-300' : 'text-amber-300'
}

function StatsView({ st, tf }: { st: LeadLagStats | null; tf: Timeframe }) {
  if (!st || (st.wins + st.losses + st.flats === 0 && st.pending === 0)) {
    return (
      <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
        No outcome data yet - every qualifying pair becomes a pending claim, resolved against the follower's actual price at a horizon set by the fitted lag. Give it a few minutes of scanning (longer on higher timeframes, since the horizon scales with the lag).
      </div>
    )
  }
  const decided = st.wins + st.losses
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
        <div className="flex items-baseline gap-2">
          <span className={`font-mono text-[18px] font-bold ${st.winRate === null ? 'text-[#4b5a72]' : st.winRate >= 55 ? 'text-emerald-300' : st.winRate >= 45 ? 'text-cyan-300' : 'text-rose-300'}`}>
            {st.winRate === null ? '—' : `${st.winRate}%`}
          </span>
          <span className="font-mono text-[9px] text-[#7c8aa5]">
            follower-echoed hit rate · {tf} · {st.wins}W / {st.losses}L
          </span>
        </div>
        <div className="mt-1 font-mono text-[8.5px] leading-relaxed text-[#4b5a72]">
          {st.flats > 0 && <>{st.flats} flat · </>}
          avg move {st.avgMovePct.toFixed(3)}% · {st.pending} pending · {st.recorded} recorded
        </div>
      </div>

      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
        <div className="mb-1.5 text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">per-leader hit rate</div>
        {st.byLeader.length === 0 ? (
          <div className="text-[9px] text-[#4b5a72]">no resolved reads yet</div>
        ) : (
          <div className="space-y-1">
            {st.byLeader.map((l) => {
              const dec = l.wins + l.losses
              return (
                <div key={l.leader} className="flex items-center gap-1.5" title={`${l.wins}W / ${l.losses}L / ${l.flats} flat · ${l.pending} pending`}>
                  <span className="w-16 shrink-0 font-mono text-[8.5px] text-[#aab6cc]">{l.leader}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-[#101828]">
                    {dec > 0 && (
                      <div
                        className={`h-full ${(l.winRate ?? 0) >= 55 ? 'bg-emerald-500' : (l.winRate ?? 0) >= 45 ? 'bg-cyan-500' : 'bg-rose-500'}`}
                        style={{ width: `${Math.max(3, l.winRate ?? 0)}%` }}
                      />
                    )}
                  </div>
                  <span className="w-20 shrink-0 text-right font-mono text-[8.5px] text-[#7c8aa5]">
                    {l.winRate === null ? '—' : `${l.winRate}%`} · {dec}d · {l.pending}p
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
        <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5]">recent reads</div>
        <div className="space-y-0.5">
          {st.recent.slice(0, 8).map((r) => (
            <div key={r.id} className="flex items-center gap-1.5 font-mono text-[8.5px]">
              {dirChip(r.direction)}
              <span className="text-[#aab6cc]">{r.leader}→{r.asset}</span>
              {r.otc && <span className="text-[8px] font-bold uppercase text-amber-400">otc</span>}
              <span className={`ml-auto ${outcomeColor(r.outcome)}`}>
                {r.outcome} {r.movePct >= 0 ? '+' : ''}{r.movePct.toFixed(3)}%
              </span>
            </div>
          ))}
          {st.recent.length === 0 && <div className="text-[9px] text-[#4b5a72]">nothing resolved yet</div>}
        </div>
      </div>

      <p className="px-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
        A claim wins when the follower's price moved the predicted direction by the resolution horizon (the fitted lag's worth of bars, floored at 1 minute, capped at 30). Flat moves hit nothing and stay out of the rate. Decay here - a leader whose win rate drops over time - is exactly the "relationship stopped holding" signal to watch for.
      </p>
    </div>
  )
}

export default function LeadLagPanel({ onClose, tf, onSelectAsset }: LeadLagPanelProps) {
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all')
  const [onlyQualifying, setOnlyQualifying] = useState(false)
  const [query, setQuery] = useState('')
  const [data, setData] = useState<LeadLagScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stats, setStats] = useState<LeadLagStats | null>(null)
  const [view, setView] = useState<'rows' | 'stats'>('rows')

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setBusy(true)
      getLeadLag(tf)
        .then((d) => {
          if (d?.ok) {
            setData(d)
            setError(null)
          }
        })
        .catch((e: Error) => setError(e.message.slice(0, 180)))
        .finally(() => setBusy(false))
    },
    [tf],
  )

  useEffect(() => {
    load()
    const iv = setInterval(() => load({ quiet: true }), POLL_MS)
    return () => clearInterval(iv)
  }, [load])

  // outcome stats poll - the honesty loop resolves on the kernel's 5s sweep,
  // a 30s refresh here is plenty (aggregates only). Filtered to the chart's
  // tf so the hit-rate view scores the same candles the rows were fit on.
  useEffect(() => {
    const pull = () =>
      getLeadLagStats(tf)
        .then((s) => {
          if (s?.ok) setStats(s)
        })
        .catch(() => {})
    void pull()
    const iv = setInterval(pull, 30_000)
    return () => clearInterval(iv)
  }, [tf])

  const needle = query.trim().toLowerCase()
  const rows = (data?.rows ?? [])
    .filter((r) => (groupFilter === 'all' ? true : r.leader === groupFilter))
    .filter((r) => (onlyQualifying ? r.qualifies : true))
    .filter((r) => (!needle ? true : r.asset.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)))

  const groups = data?.groups ?? []
  const qualifyingCount = data?.qualifying ?? 0

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1 border-b border-[#1c2739] px-2 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Lead-Lag</span>
        <span
          className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-cyan-300"
          title="the correlation fit runs on the chart's current timeframe, same convention as Chart Signals"
        >
          {data?.tf ?? tf}
        </span>
        {data && (
          <span className="ml-auto font-mono text-[8px] text-[#4b5a72]" title="leader/follower pairs tested this pass · how many currently clear the auto-trader's own thresholds · scan duration">
            {data.scanned} pairs
            {qualifyingCount > 0 && (
              <span className="ml-1 font-bold text-emerald-400">· {qualifyingCount} qualify</span>
            )}
            {' '}· {data.scanMs}ms
          </span>
        )}
        {(() => {
          const decided = stats ? stats.wins + stats.losses : 0
          if (!stats || (!decided && !stats.pending)) return null
          return (
            <span
              className={`ml-1 rounded border px-1 py-px font-mono text-[8px] font-bold ${
                stats.winRate === null
                  ? 'border-[#1c2739] text-[#4b5a72]'
                  : stats.winRate >= 55
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : stats.winRate >= 45
                      ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                      : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
              }`}
              title={`resolved claims: ${stats.wins}W / ${stats.losses}L${stats.flats ? ` / ${stats.flats} flat` : ''} · ${stats.pending} pending now`}
            >
              {stats.winRate === null ? `0/${decided}` : `${stats.winRate}%`} · {decided}
            </span>
          )
        })()}
        <button
          type="button"
          onClick={() => setView((v) => (v === 'stats' ? 'rows' : 'stats'))}
          className={`ml-1 flex h-5 items-center rounded border px-1.5 font-mono text-[8px] font-bold uppercase tracking-wider transition-colors ${
            view === 'stats' ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300' : 'border-[#1c2739] text-[#7c8aa5] hover:text-cyan-300'
          }`}
          title="what the lead-lag fits actually delivered - win rates per leader group"
        >
          hit-rate
        </button>
        <button
          type="button"
          onClick={onClose}
          title="close the lead-lag sidebar"
          className="ml-1 flex h-5 w-5 items-center justify-center rounded border border-[#1c2739] font-mono text-[11px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
        >
          ×
        </button>
      </div>

      {view === 'rows' && (
      <div className="flex items-center gap-1 border-b border-[#1c2739] px-2 py-1">
        <div className="relative min-w-0 flex-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="search… e.g. XAGUSD, ETH"
            spellCheck={false}
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1 pr-6 font-mono text-[10px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-cyan-500/50"
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
        <button
          type="button"
          onClick={() => setGroupFilter('all')}
          className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
            groupFilter === 'all' ? 'bg-cyan-500/15 text-cyan-300' : 'text-[#7c8aa5] hover:text-[#aab6cc]'
          }`}
        >
          All
        </button>
        {groups.map((g) => (
          <button
            key={g.leader}
            type="button"
            onClick={() => setGroupFilter(g.leader)}
            className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
              groupFilter === g.leader
                ? 'bg-cyan-500/15 text-cyan-300'
                : g.open
                  ? 'text-[#7c8aa5] hover:text-[#aab6cc]'
                  : 'text-[#3d4d66]'
            }`}
            title={`${g.followers} follower${g.followers === 1 ? '' : 's'} tracked against ${g.leader}${g.open ? '' : ' - leader market closed right now'}`}
          >
            {g.leader}
          </button>
        ))}
      </div>
      )}

      {view === 'rows' && (
      <div className="flex items-center gap-2 border-b border-[#1c2739] px-2 py-1">
        <label className="flex shrink-0 items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-wider text-[#7c8aa5]" title="hide every pair that doesn't currently clear the auto-trader's own correlation + trigger-z thresholds">
          <input type="checkbox" checked={onlyQualifying} onChange={(e) => setOnlyQualifying(e.target.checked)} className="accent-cyan-500" />
          qualifying only
        </label>
        <span className="ml-auto font-mono text-[8px] text-[#4b5a72]">{rows.length} shown</span>
      </div>
      )}

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {view === 'stats' ? (
          <StatsView st={stats} tf={tf} />
        ) : (
          <>
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && rows.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {data ? (
              onlyQualifying
                ? `No pairs currently clear the trading thresholds (|corr| ≥ 0.35, |trigger z| ≥ 1). That's normal - lead-lag is meant to catch unusual leader moves, not fire continuously. Uncheck "qualifying only" to see every fit.`
                : 'No pairs match the current filter - clear the search or switch the group chip.'
            ) : (
              'Fitting rolling cross-correlation across the EURUSD/XAUUSD/BTCUSD/oil leader groups...'
            )}
          </div>
        )}
        {rows.map((r) => (
          <LeadLagCard key={`${r.leader}-${r.asset}`} r={r} onSelectAsset={onSelectAsset} />
        ))}
        {data && data.rows.length > 0 && (
          <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
            Each row refits its own best lag (0-10 bars) and correlation between the group leader's returns and this follower's returns, every {Math.round(POLL_MS / 1000)}s. <span className="text-emerald-500/70">qualifies</span> marks exactly the pairs strong AND unusual enough for the auto-trader's lead-lag source to act on right now - everything else is shown for context, not as a trade signal. Click a card to open the chart.
          </p>
        )}
          </>
        )}
      </div>
    </div>
  )
}
