'use client'

// IQAIR//OS - Tick next-candle oracle panel.
// Per-bucket next-candle direction from the TICK CHART: the raw micro-tick
// stream is bucketed (1s..5m ladder) and five no-look-ahead features vote -
// tick-candle streak, tape persistence z, measured print pressure (up vs down
// prints in the last closed bucket), ATR-normalized momentum and the close
// location value. HONESTY: every row carries the on-buffer walk-forward hit
// rate of the same rule (abstentions excluded), buckets below the print
// cadence read "capture cadence too slow" (a 1s bucket on a ~1s sim feed
// honestly cannot vote), and a two-sided tape reads "no honest lean".
import { useCallback, useEffect, useState } from 'react'
import type { TickOracleResult } from '@/lib/os/client'
import { getTickOracle } from '@/lib/os/client'

interface TickOraclePanelProps {
  asset: string
}

function RowDirBadge({ dir, confidence }: { dir: 'call' | 'put' | 'none'; confidence: number }) {
  const cls =
    dir === 'call'
      ? 'bg-emerald-500/20 text-emerald-300'
      : dir === 'put'
        ? 'bg-rose-500/20 text-rose-300'
        : 'bg-[#101828] text-[#4b5a72]'
  return (
    <span className={`inline-block rounded px-1.5 py-px font-mono text-[9px] font-bold uppercase ${cls}`}>
      {dir === 'none' ? 'lean none' : `${dir} ${confidence}%`}
    </span>
  )
}

function WfBadge({ wf }: { wf: { n: number; hits: number; misses: number; hitRatePct: number | null } | null }) {
  if (!wf || wf.hitRatePct === null) return <span className="font-mono text-[9px] text-[#3d4d66]">wf thin</span>
  const good = wf.hitRatePct >= 55
  const bad = wf.hitRatePct < 45
  return (
    <span
      className={`font-mono text-[9px] font-bold ${good ? 'text-emerald-300' : bad ? 'text-rose-300' : 'text-[#7c8aa5]'}`}
      title={`on-buffer walk-forward of this exact rule: ${wf.hits}W/${wf.misses}L over ${wf.n} evaluated buckets (abstentions excluded) - history evidence, not a promise`}
    >
      wf {wf.hitRatePct}% ({wf.n})
    </span>
  )
}

export default function TickOraclePanel({ asset }: TickOraclePanelProps) {
  const [data, setData] = useState<TickOracleResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setBusy(true)
      getTickOracle(asset)
        .then((d) => {
          setData(d)
          setError(null)
        })
        .catch((e: Error) => setError(e.message.slice(0, 180)))
        .finally(() => setBusy(false))
    },
    [asset],
  )

  useEffect(() => {
    load()
    const iv = setInterval(() => load({ quiet: true }), 6000)
    return () => clearInterval(iv)
  }, [load])

  const bestLabel = data?.best ? `${data.best.label} ${data.best.direction.toUpperCase()} ${data.best.confidence}%` : 'no qualified read'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* summary strip */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1c2739] px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Tick Oracle</span>
        {data?.best && data.best.direction !== 'none' && (
          <RowDirBadge dir={data.best.direction} confidence={data.best.confidence} />
        )}
        <span className="font-mono text-[9px] text-[#7c8aa5]">best: {bestLabel}</span>
        {data && (
          <span
            className="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px font-mono text-[8px] uppercase text-amber-400"
            title={`${data.dataSource}${data.cadenceMs !== null ? `, median inter-print gap ${data.cadenceMs}ms` : ''} - ${data.ticks} prints buffered`}
          >
            {data.dataSource}
            {data.cadenceMs !== null ? ` · ${data.cadenceMs}ms` : ''} · {data.ticks} prints
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => load()}
            className="rounded border border-[#1c2739] px-2 py-0.5 font-mono text-[9px] uppercase text-[#7c8aa5] hover:text-cyan-300"
          >
            {busy ? '…' : 'refresh'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error && <div className="text-[10px] text-rose-400">{error}</div>}
        {!error && data && !data.ok && <div className="text-[10px] leading-relaxed text-[#4b5a72]">{data.note ?? 'warming up'}</div>}
        {!error && !data && <div className="text-[10px] text-[#4b5a72]">loading oracle ladder…</div>}
        {data && (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-[10px]">
              <thead>
                <tr className="border-b border-[#141d2e] text-left text-[8px] uppercase tracking-wider text-[#4b5a72]">
                  <th className="px-2 py-1">bucket</th>
                  <th className="px-2 py-1">next-candle read</th>
                  <th className="px-2 py-1">score</th>
                  <th className="px-2 py-1">evidence</th>
                  <th className="px-2 py-1">walk-forward</th>
                  <th className="px-2 py-1">why</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const isBest = data.best?.label === r.label && r.direction !== 'none'
                  return (
                    <tr
                      key={r.label}
                      className={`border-b border-[#0d1420] ${isBest ? 'bg-cyan-500/5' : ''}`}
                      title={r.note ?? r.reasons.join(' · ')}
                    >
                      <td className="px-2 py-1 text-[#dbe4f0]">
                        {r.label}
                        {isBest && <span className="ml-1 text-[8px] text-cyan-300">★ best</span>}
                      </td>
                      <td className="px-2 py-1">
                        <RowDirBadge dir={r.direction} confidence={r.confidence} />
                      </td>
                      <td className={`px-2 py-1 ${r.score > 0 ? 'text-emerald-400' : r.score < 0 ? 'text-rose-400' : 'text-[#4b5a72]'}`}>
                        {r.score >= 0 ? '+' : ''}
                        {r.score}
                      </td>
                      <td className="px-2 py-1 text-[#7c8aa5]">
                        {r.candles}b · {r.medTicksPerCandle}p/b
                      </td>
                      <td className="px-2 py-1">
                        <WfBadge wf={r.wf} />
                      </td>
                      <td className="max-w-[280px] px-2 py-1 text-[9px] text-[#7c8aa5]">
                        {r.note ?? r.reasons.join(' · ') ?? ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <p className="mt-3 px-1 text-[9px] leading-relaxed text-[#4b5a72]">
            Each bucket length is its own tick chart from the same prints. A row fires only when the vote clears the deadband (|score| &gt;= 20);
            buckets with fewer than ~2 prints per candle are cadence-gated (a 1s bucket on a ~1s sim feed cannot honestly vote); &quot;wf&quot; is
            the same rule replayed on this buffer&apos;s own recent history - <span className="text-[#aab6cc]">evidence, not a promise</span>.
          </p>
        )}
      </div>
    </div>
  )
}
