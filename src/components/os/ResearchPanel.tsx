'use client'

// IQAIR//OS - Research & Calibration: the "can I trust this" panel.
// Two halves: (1) CALIBRATION - buckets closed trades by the model's own
// entry-time confidence/Markov P(up) and compares to the realized win rate,
// so you can see whether "confidence 72" actually wins ~72% of the time.
// (2) RESEARCH GATE - every (asset, tf, strategy) that has ever been
// walk-forward validated, with its verdict and age - this is the exact table
// bot_create/bot_toggle checks before letting a bot arm ("research-gate: ..."
// errors reference a missing/stale/non-robust row here).

import { useCallback, useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import type { CalibrationBucket, CalibrationReport, StrategyInfo, ValidationRow } from '@/lib/os/client'
import { fmtTime, osGet } from '@/lib/os/client'

const GATE_MAX_AGE_SEC = 14 * 24 * 60 * 60

interface ResearchPanelProps {
  strategies: StrategyInfo[]
  onError: (m: string) => void
}

export default function ResearchPanel({ strategies, onError }: ResearchPanelProps) {
  const [asset, setAsset] = useState('')
  const [strategyId, setStrategyId] = useState('')
  const [report, setReport] = useState<CalibrationReport | null>(null)
  const [validations, setValidations] = useState<ValidationRow[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cal, val] = await Promise.all([
        osGet<{ ok: boolean } & CalibrationReport>('/calibration', {
          asset: asset || undefined,
          strategy: strategyId || undefined,
        }),
        osGet<{ ok: boolean; validations: ValidationRow[] }>('/validation'),
      ])
      if (cal.ok) {
        const { ok: _ok, ...rest } = cal
        setReport(rest)
      }
      if (val.ok) setValidations(val.validations)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [asset, strategyId, onError])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 20000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-2.5">
      <div className="flex shrink-0 items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">
          Research &amp; Calibration
          <span className="ml-2 font-mono text-[9px] normal-case tracking-normal text-[#4b5a72]">
            does the model&apos;s confidence deserve trust · what&apos;s cleared the research gate
          </span>
        </h3>
        <div className="flex items-center gap-1.5">
          <Input
            value={asset}
            onChange={(e) => setAsset(e.target.value.toUpperCase())}
            placeholder="asset filter…"
            className="h-6 w-28 border-[#1c2739] bg-[#101828] text-[10px] text-[#e2e8f0] placeholder:text-[#3d4c66]"
          />
          <select
            value={strategyId}
            onChange={(e) => setStrategyId(e.target.value)}
            className="h-6 rounded border border-[#1c2739] bg-[#101828] px-1.5 text-[10px] text-[#e2e8f0]"
          >
            <option value="">all strategies</option>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto">
        {/* CALIBRATION */}
        <div className="space-y-2">
          {!report && loading && <p className="py-8 text-center font-mono text-[10px] text-[#4b5a72]">loading calibration…</p>}
          {report && (
            <>
              <div className="grid grid-cols-2 gap-1.5">
                <BrierStat label="Brier · confidence" value={report.brierConfidence} />
                <BrierStat label="Brier · Markov P(up)" value={report.brierMarkov} />
              </div>
              <p className="rounded border border-[#1c2739] bg-[#101828] px-2 py-1.5 font-mono text-[9px] leading-relaxed text-[#7c8aa5]">
                {report.n} usable trade{report.n === 1 ? '' : 's'} ({report.excluded} excluded - open, no entry snapshot, or a flat draw). {report.note}
              </p>
              <CalibrationChart title="By composite confidence" buckets={report.byConfidence} />
              <CalibrationChart title="By Markov P(up) (side taken)" buckets={report.byMarkovProb} />
            </>
          )}
        </div>

        {/* RESEARCH GATE */}
        <div className="min-h-0 space-y-1">
          <div className="text-[9px] uppercase tracking-wider text-[#4b5a72]">
            Research gate - {validations.length} validated combo{validations.length === 1 ? '' : 's'}
          </div>
          <div className="overflow-hidden rounded border border-[#1c2739]">
            <table className="w-full font-mono text-[9px]">
              <thead>
                <tr className="bg-[#101828] text-left text-[#4b5a72]">
                  <th className="px-2 py-1 font-medium">asset</th>
                  <th className="px-2 py-1 font-medium">tf</th>
                  <th className="px-2 py-1 font-medium">strategy</th>
                  <th className="px-2 py-1 font-medium">verdict</th>
                  <th className="px-2 py-1 font-medium">oos net</th>
                  <th className="px-2 py-1 font-medium">win%</th>
                  <th className="px-2 py-1 font-medium">folds</th>
                  <th className="px-2 py-1 font-medium">age</th>
                </tr>
              </thead>
              <tbody>
                {validations.map((v) => (
                  <ValidationRowView key={`${v.asset}|${v.tf}|${v.strategyId}`} v={v} />
                ))}
                {!validations.length && (
                  <tr>
                    <td colSpan={8} className="px-2 py-4 text-center text-[#4b5a72]">
                      nothing walk-forward validated yet - run walkforward before arming a bot, it needs a "robust" row here
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function BrierStat({ label, value }: { label: string; value: number | null }) {
  const tone = value === null ? 'neutral' : value <= 0.2 ? 'up' : value <= 0.25 ? 'neutral' : 'down'
  return (
    <div className="rounded border border-[#1c2739] bg-[#101828] px-2 py-1.5">
      <div className="text-[8px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
      <div
        className={`text-[13px] font-bold ${tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-rose-400' : 'text-[#dbe4f0]'}`}
      >
        {value === null ? 'n/a' : value.toFixed(3)}
      </div>
    </div>
  )
}

function CalibrationChart({ title, buckets }: { title: string; buckets: CalibrationBucket[] }) {
  const maxN = Math.max(1, ...buckets.map((b) => b.n))
  return (
    <div className="rounded border border-[#1c2739] bg-[#101828] p-2">
      <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">{title}</div>
      <div className="space-y-0.5">
        {buckets.map((b) => {
          const gap = b.n > 0 ? b.realizedWinRate - b.predictedMid : 0
          return (
            <div key={b.rangeLabel} className="flex items-center gap-1.5 font-mono text-[9px]">
              <span className="w-10 shrink-0 text-[#4b5a72]">{b.rangeLabel}</span>
              <div className="relative h-3 flex-1 overflow-hidden rounded bg-[#0b111c]">
                {/* predicted-mid reference tick */}
                <div className="absolute inset-y-0 border-l border-dashed border-[#3d4c66]" style={{ left: `${b.predictedMid}%` }} />
                <div
                  className={`h-full ${b.n === 0 ? 'bg-transparent' : Math.abs(gap) <= 8 ? 'bg-emerald-400/60' : 'bg-amber-400/60'}`}
                  style={{ width: `${b.realizedWinRate}%` }}
                />
              </div>
              <span className="w-16 shrink-0 text-right text-[#7c8aa5]">
                {b.n ? `${b.realizedWinRate}%` : '-'} <span className="text-[#3d4c66]">({b.n})</span>
              </span>
            </div>
          )
        })}
        {buckets.every((b) => b.n === 0) && (
          <p className="py-1 text-center font-mono text-[9px] text-[#3d4c66]">no trades in any bucket yet</p>
        )}
      </div>
      {maxN > 0 && (
        <div className="mt-1 flex items-center gap-1 font-mono text-[8px] text-[#3d4c66]">
          <span className="inline-block h-1.5 w-1.5 rounded-sm bg-emerald-400/60" /> realized within 8pt of predicted
          <span className="ml-2 inline-block h-1.5 w-1.5 rounded-sm bg-amber-400/60" /> off by more than 8pt
        </div>
      )}
    </div>
  )
}

function ValidationRowView({ v }: { v: ValidationRow }) {
  const ageSec = Math.floor(Date.now() / 1000) - v.ts
  const stale = ageSec > GATE_MAX_AGE_SEC
  const ageDays = Math.floor(ageSec / 86400)
  const gateReady = v.verdict === 'robust' && !stale
  return (
    <tr className="border-t border-[#141d2e] text-[#aab6cc]">
      <td className="px-2 py-1 font-bold text-[#dbe4f0]">{v.asset}</td>
      <td className="px-2 py-1">{v.tf}</td>
      <td className="px-2 py-1 text-cyan-300/80">{v.strategyId}</td>
      <td className="px-2 py-1">
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase"
          style={{
            color: gateReady ? '#10b981' : v.verdict === 'weak' ? '#fbbf24' : '#f43f5e',
            background: gateReady ? 'rgba(16,185,129,0.1)' : v.verdict === 'weak' ? 'rgba(251,191,36,0.1)' : 'rgba(244,63,94,0.1)',
          }}
          title={stale && v.verdict === 'robust' ? 'robust but stale - re-run walkforward' : undefined}
        >
          {v.verdict}
          {stale && v.verdict === 'robust' ? ' (stale)' : ''}
        </span>
      </td>
      <td className={`px-2 py-1 ${v.oosNet >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
        {v.oosNet >= 0 ? '+' : ''}
        {v.oosNet.toFixed(2)}
      </td>
      <td className="px-2 py-1">{v.winRate.toFixed(0)}%</td>
      <td className="px-2 py-1">
        {v.foldsProfitable}/{v.folds}
      </td>
      <td className="px-2 py-1 text-[#4b5a72]">{ageDays === 0 ? 'today' : `${ageDays}d`} · {fmtTime(v.ts)}</td>
    </tr>
  )
}
