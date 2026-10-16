'use client'

// IQAIR//OS - Diagnostics / Soak Test panel.
// Purpose: after letting the auto-trader run unattended for hours (paper
// mode, soak-testing a change), answer "did anything break?" in one glance
// instead of grepping the alerts feed. Everything here is built server-side
// from data the app already persists (positions, alerts, otc_verdicts) - see
// /soak_report in mini-services/trading-core/index.ts. Sections explicitly
// say when there's simply nothing in the window yet vs. when a dimension
// genuinely isn't tracked anywhere (dataAvailable: false) - never a fake 0
// dressed up as "nothing happened".
import { useCallback, useEffect, useState } from 'react'
import { fmtTime, getSoakReport, type SoakReport } from '@/lib/os/client'

interface DiagnosticsPanelProps {
  onError: (m: string) => void
}

const RANGE_OPTIONS: { label: string; ms: number }[] = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '6h', ms: 6 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
      <div className="mb-2 font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">{title}</div>
      {children}
    </div>
  )
}

function Stat({ label, value, tone = 'default' }: { label: string; value: React.ReactNode; tone?: 'default' | 'good' | 'bad' | 'warn' }) {
  const color = tone === 'good' ? '#10b981' : tone === 'bad' ? '#f43f5e' : tone === 'warn' ? '#f59e0b' : '#dbe4f0'
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</span>
      <span className="font-mono text-[14px] font-bold" style={{ color }}>
        {value}
      </span>
    </div>
  )
}

function NoData({ note }: { note?: string }) {
  return <div className="text-[11px] italic text-[#3d4d66]">{note ?? 'no data yet - this dimension is not tracked'}</div>
}

export default function DiagnosticsPanel({ onError }: DiagnosticsPanelProps) {
  const [rangeMs, setRangeMs] = useState<number>(RANGE_OPTIONS[2].ms)
  const [report, setReport] = useState<SoakReport | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await getSoakReport(rangeMs)
      setReport(r)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [rangeMs, onError])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), 30_000)
    return () => clearInterval(id)
  }, [load])

  const windowLabel = RANGE_OPTIONS.find((o) => o.ms === rangeMs)?.label ?? `${Math.round(rangeMs / 3_600_000)}h`

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {RANGE_OPTIONS.map((o) => (
            <button
              key={o.label}
              onClick={() => setRangeMs(o.ms)}
              className={`rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${
                o.ms === rangeMs ? 'border-cyan-500 bg-cyan-500/10 text-cyan-300' : 'border-[#1c2739] text-[#7c8aa5] hover:text-[#dbe4f0]'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <button onClick={() => void load()} className="rounded border border-[#1c2739] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-[#7c8aa5] hover:text-cyan-300">
          {loading ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      {!report ? (
        <div className="flex h-32 items-center justify-center text-[11px] text-[#3d4d66]">{loading ? 'loading soak report…' : 'no report yet'}</div>
      ) : (
        <>
          <div className="font-mono text-[9px] text-[#3d4d66]">
            window: last {windowLabel} · {report.alertsInWindow} alerts scanned · generated {fmtTime(Math.floor(report.generatedAt / 1000))}
          </div>

          {/* TRADE COUNTS */}
          <Section title={`Trades (auto-trader only, last ${windowLabel})`}>
            {report.trades.total === 0 ? (
              <NoData note="no auto-trader trades in this window - either it hasn't run, or has been off/standing down the whole time (check Standdowns below)." />
            ) : (
              <>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                  <Stat label="Total" value={report.trades.total} />
                  <Stat label="Paper" value={report.trades.byMode.paper} />
                  <Stat label="Live" value={report.trades.byMode.live} tone={report.trades.byMode.live > 0 ? 'warn' : 'default'} />
                  <Stat label="Won" value={report.trades.byOutcome.won} tone="good" />
                  <Stat label="Lost" value={report.trades.byOutcome.lost} tone="bad" />
                  <Stat label="Push" value={report.trades.byOutcome.push} />
                </div>
                <div className="mt-3 border-t border-[#141d2e] pt-2">
                  <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">by signal source</div>
                  <table className="w-full font-mono text-[10px]">
                    <tbody>
                      {Object.entries(report.trades.bySource)
                        .sort((a, b) => b[1] - a[1])
                        .map(([src, count]) => (
                          <tr key={src} className="border-b border-[#0d1420]">
                            <td className="py-1 text-[#aab6cc]">{src}</td>
                            <td className="py-1 text-right text-cyan-300">{count}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {report.trades.nonAutoTraderPositions > 0 && (
                  <div className="mt-2 text-[9px] text-[#3d4d66]">+ {report.trades.nonAutoTraderPositions} manual/autopilot-bot position(s) in this window, excluded above.</div>
                )}
              </>
            )}
          </Section>

          {/* SETTLEMENT HEALTH */}
          <Section title="Settlement health">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Still-awaiting-IQ alerts"
                value={report.settlement.stillAwaitingIqConfirmationCount}
                tone={report.settlement.stillAwaitingIqConfirmationCount > 0 ? 'warn' : 'good'}
              />
              <Stat
                label="Currently stuck open"
                value={report.settlement.stuckOpenPositions.length}
                tone={report.settlement.stuckOpenPositions.length > 0 ? 'bad' : 'good'}
              />
              <Stat label="IQ session lost" value={report.settlement.iqSessionLostCount} tone={report.settlement.iqSessionLostCount > 0 ? 'bad' : 'good'} />
              <Stat label="Error/warn alerts" value={report.settlement.errorAlertCount} tone={report.settlement.errorAlertCount > 20 ? 'bad' : report.settlement.errorAlertCount > 0 ? 'warn' : 'good'} />
            </div>
            {report.settlement.stuckOpenPositions.length > 0 && (
              <div className="mt-2 space-y-0.5">
                {report.settlement.stuckOpenPositions.map((p) => (
                  <div key={p.id} className="font-mono text-[10px] text-amber-400">
                    {p.asset} ({p.id.slice(0, 8)}) - {p.secondsPastExpiry}s past expected expiry, still open
                  </div>
                ))}
              </div>
            )}
            {report.settlement.recentStillAwaiting.length > 0 && (
              <div className="mt-2 border-t border-[#141d2e] pt-2">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">most recent still-awaiting alerts</div>
                <div className="space-y-0.5">
                  {report.settlement.recentStillAwaiting.map((a, i) => (
                    <div key={i} className="truncate font-mono text-[10px] text-[#7c8aa5]" title={a.message}>
                      <span className="text-[#4b5a72]">{fmtTime(a.ts)}</span> · {a.message}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Section>

          {/* OTC GUARD */}
          <Section title="OTC guard activity">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Policy" value={report.otcGuard.policy} />
              <Stat label="Blocked trades" value={report.otcGuard.blockedCount} tone={report.otcGuard.blockedCount > 0 ? 'warn' : 'default'} />
              <Stat label="Walk-forward runs" value={report.otcGuard.verdictRunsInWindow} />
              <Stat label="Robust / Weak / Failed" value={`${report.otcGuard.verdictsByResult.robust} / ${report.otcGuard.verdictsByResult.weak} / ${report.otcGuard.verdictsByResult.failed}`} />
            </div>
            {!report.otcGuard.consultedCountAvailable && <div className="mt-2 text-[9px] italic text-[#3d4d66]">total consult count: {report.otcGuard.consultedCountNote}</div>}
          </Section>

          {/* CHARTSIGNALS */}
          <Section title="Chartsignals activity">
            {report.chartsignals.dataAvailable ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Trades from chartsignals" value={report.chartsignals.tradeCount} />
                <Stat label="Family-vote samples" value={report.chartsignals.samples} />
                <Stat label="Avg agree/total" value={`${report.chartsignals.avgAgree}/${report.chartsignals.avgTotal}`} />
                <Stat label="Avg agree %" value={`${report.chartsignals.avgAgreePct}%`} />
              </div>
            ) : (
              <NoData note={report.chartsignals.note} />
            )}
          </Section>

          {/* STANDDOWNS - the single most useful "did something break" signal */}
          <Section title="Standdown reasons (frequency)">
            {report.standdowns.length === 0 ? (
              <NoData note="no standdowns logged in this window (either the auto-trader hasn't run, or it has traded cleanly with no holds)." />
            ) : (
              <table className="w-full font-mono text-[10px]">
                <thead>
                  <tr className="text-left text-[9px] uppercase tracking-wider text-[#4b5a72]">
                    <th className="py-1">Reason</th>
                    <th className="py-1 text-right">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {report.standdowns.map((s, i) => {
                    // A single reason dominating hundreds of times (vs. a healthy
                    // mix of benign holds like "no signal"/"cooldown") is the
                    // repeating-error smell this view exists to surface.
                    const dominant = report.standdowns.length > 1 && s.count > report.standdowns.reduce((sum, x) => sum + x.count, 0) * 0.6
                    return (
                      <tr key={i} className="border-b border-[#0d1420]">
                        <td className={`py-1 ${dominant ? 'text-rose-400' : 'text-[#aab6cc]'}`}>{s.reason}</td>
                        <td className={`py-1 text-right font-bold ${dominant ? 'text-rose-400' : 'text-cyan-300'}`}>{s.count}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </Section>
        </>
      )}
    </div>
  )
}
