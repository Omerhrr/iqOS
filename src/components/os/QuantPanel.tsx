'use client'

// IQAIR//OS - Quant lab panel: Hurst, vol models, ACF, Monte Carlo fan, S/R zones
import { useEffect, useMemo, useState } from 'react'
import type { AnalysisResult, Factor, OsModeStatus, OUVerdict, RandomnessAudit, OtcStatus, OtcConfig, OtcDefenseReport, OtcVerdictRow, OtcPolicy, OtcForensics, StrategyInfo, Timeframe } from '@/lib/os/client'
import { fmtPrice, getRandomnessAudit, getOtcStatus, getOtcVerdicts, getOtcConfig, setOtcConfig, runOtcDefense, getOtcForensics, osGet, osPost, TIMEFRAMES } from '@/lib/os/client'
import { StrategyPicker } from './BacktestLab'

/** Small chip showing a factor's live contribution to the composite signal score. */
function FactorBadge({ factor }: { factor?: Factor }) {
  if (!factor) return null
  const active = Math.abs(factor.vote) > 0.15
  const contribution = factor.vote * factor.weight
  const dir = !active ? null : contribution > 0 ? 'call' : 'put'
  const color = dir === 'call' ? '#10b981' : dir === 'put' ? '#f43f5e' : '#5a6a85'
  const bg = dir === 'call' ? 'rgba(16,185,129,0.12)' : dir === 'put' ? 'rgba(244,63,94,0.12)' : 'rgba(148,163,184,0.08)'
  const label = dir ? `→ ${dir === 'call' ? 'CALL' : 'PUT'} ${contribution >= 0 ? '+' : ''}${contribution.toFixed(1)}` : 'neutral'
  return (
    <span
      className="ml-1.5 inline-block rounded px-1 py-0.5 align-middle font-mono text-[8px] font-bold uppercase tracking-wide"
      style={{ color, background: bg }}
      title={`weight ${factor.weight} · vote ${factor.vote.toFixed(2)} · feeds the live composite signal score`}
    >
      {label} · w{factor.weight}
    </span>
  )
}

/** Minutes/hours-ago label for a unix-ms timestamp, e.g. "3m ago". */
function agoLabel(ts: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ago`
}

/**
 * Walk-forward validation of the OU edge on the active instrument (kernel
 * /ou_validate), plus a direct arm/disarm for the auto-trader's
 * requireValidation gate - so a user doesn't have to separately find it in
 * Autopilot settings to know (or control) whether this result does anything.
 */
function OuWalkForward({ asset, tf }: { asset: string; tf: string }) {
  const [verdict, setVerdict] = useState<OUVerdict | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requireValidation, setRequireValidation] = useState<boolean | null>(null)
  const [autoSource, setAutoSource] = useState<string | null>(null)
  const [toggling, setToggling] = useState(false)

  useEffect(() => {
    let cancelled = false
    osGet<{ ok: boolean } & OsModeStatus>('/mode')
      .then((d) => {
        if (cancelled || !d.ok) return
        setRequireValidation(d.autotrader.config.requireValidation)
        setAutoSource(d.autotrader.config.signalSource)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const run = () => {
    setBusy(true)
    setError(null)
    osPost<{ ok: boolean; verdict?: OUVerdict; error?: string }>('/ou_validate', { asset, tf })
      .then((d) => {
        if (d.ok && d.verdict) setVerdict(d.verdict)
        else setError(d.error ?? 'validation failed')
      })
      .catch((e: Error) => setError(e.message.slice(0, 120)))
      .finally(() => setBusy(false))
  }

  const toggleRequireValidation = () => {
    if (requireValidation === null || toggling) return
    const next = !requireValidation
    setToggling(true)
    setRequireValidation(next) // optimistic
    osPost<{ ok: boolean; error?: string }>('/autotrader_config', { requireValidation: next })
      .catch(() => setRequireValidation(!next))
      .finally(() => setToggling(false))
  }

  const badge =
    verdict === null
      ? null
      : verdict.verdict === 'robust'
        ? { label: 'ROBUST', color: '#10b981', bg: 'rgba(16,185,129,0.12)' }
        : verdict.verdict === 'weak'
          ? { label: 'WEAK', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' }
          : { label: 'FAILED', color: '#f43f5e', bg: 'rgba(244,63,94,0.12)' }

  return (
    <div className="mt-2 border-t border-[#1c2739] pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] text-[#4b5a72]">
          walk-forward validation · 3 folds · IS grid → OOS binary settlement
          {verdict && <span className="text-[#3d4c66]"> · {verdict.elapsedMs}ms{verdict.ts ? ` · validated ${agoLabel(verdict.ts)}` : ''}</span>}
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
        >
          {busy ? 'validating…' : 'validate edge'}
        </button>
      </div>
      <p className="mt-1 text-[8px] leading-snug text-[#4b5a72]">
        this checks ONE pair's OU edge only - it affects live trading only when the auto-trader's signal source is set to <span className="text-[#7c8aa5]">kalman-ou</span> AND &quot;require walk-forward validation&quot; is armed below. It has no effect on any other signal source or on manual trades.
      </p>
      {requireValidation !== null && (
        <div className="mt-1.5 flex items-center justify-between gap-2 rounded border border-[#1c2739] bg-[#101828] px-2 py-1">
          <div>
            <div className="text-[9px] font-semibold text-[#e2e8f0]">
              Require this validation before auto-trading kalman-ou
              {autoSource && autoSource !== 'kalman-ou' && (
                <span className="ml-1 font-normal text-[#f59e0b]">(auto-trader source is currently &quot;{autoSource}&quot; - no effect until switched)</span>
              )}
            </div>
            <div className="text-[8px] text-[#4b5a72]">gates only the kalman-ou auto-trader source · verdicts cache ~1h</div>
          </div>
          <button
            type="button"
            onClick={toggleRequireValidation}
            disabled={toggling}
            className="shrink-0 rounded px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors disabled:opacity-50"
            style={
              requireValidation
                ? { color: '#10b981', background: 'rgba(16,185,129,0.14)', border: '1px solid rgba(16,185,129,0.4)' }
                : { color: '#aab6cc', background: 'rgba(148,163,184,0.08)', border: '1px solid #1c2739' }
            }
          >
            {requireValidation ? 'armed' : 'off'}
          </button>
        </div>
      )}
      {error && <p className="mt-1 font-mono text-[10px] text-rose-400">{error}</p>}
      {verdict && badge && (
        <div className="mt-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider" style={{ color: badge.color, background: badge.bg }}>
              {badge.label}
            </span>
            <span className="font-mono text-[10px] text-[#aab6cc]">
              OOS <span className={verdict.oosNet >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{verdict.oosNet >= 0 ? '+' : ''}${verdict.oosNet.toFixed(2)}</span>
              {' · '}{verdict.winRate.toFixed(0)}% wr · {verdict.totalTrades} trades
            </span>
            <span className="font-mono text-[10px] text-[#4b5a72]">
              IS→OOS {verdict.efficiencyPct.toFixed(0)}% · folds {verdict.foldsProfitable}/{verdict.folds} profitable
            </span>
          </div>
          <p className="mt-1 text-[9px] leading-relaxed text-[#4b5a72]">
            {verdict.verdict === 'robust'
              ? 'the edge survives out-of-sample: profitable OOS aggregate, majority of folds profitable, IS gains carry over. Tradeable.'
              : verdict.verdict === 'weak'
                ? 'OOS profitable but thin (fold count / efficiency below bar) - size down or raise entry thresholds.'
                : 'the edge does not survive out-of-sample - in-sample gains were curve-fit. Not tradeable as-is.'}
            {verdict.bestParams && Object.keys(verdict.bestParams).length > 0 && (
              <>
                {' '}· best: {Object.entries(verdict.bestParams).map(([k, v]) => `${k} ${String(v)}`).join(' · ')}
              </>
            )}
          </p>
        </div>
      )}
    </div>
  )
}

function MonteFan({ analysis }: { analysis: AnalysisResult }) {
  const svg = useMemo(() => {
    const paths = analysis.montecarlo.paths
    if (!paths.length) return null
    const W = 260
    const H = 90
    const n = paths[0].length
    let lo = Infinity
    let hi = -Infinity
    for (const p of paths) for (const v of p) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    const pad = (hi - lo) * 0.06 || 1
    lo -= pad
    hi += pad
    const x = (i: number) => (i / (n - 1)) * W
    const y = (v: number) => H - ((v - lo) / (hi - lo)) * H
    const line = (p: number[]) => p.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
    const med = paths.map((p) => p[n - 1]).sort((a, b) => a - b)[Math.floor(paths.length / 2)]
    const bandPoly = (qLo: number, qHi: number) => {
      const up: string[] = []
      const dn: string[] = []
      for (let i = 0; i < n; i++) {
        const slice = paths.map((p) => p[i]).sort((a, b) => a - b)
        up.push(`${x(i).toFixed(1)},${y(slice[Math.floor(slice.length * qHi)]).toFixed(1)}`)
        dn.push(`${x(i).toFixed(1)},${y(slice[Math.floor(slice.length * qLo)]).toFixed(1)}`)
      }
      return `${up.join(' L')} L ${dn.reverse().join(' L')} Z`
    }
    return {
      W,
      H,
      bandInner: bandPoly(0.25, 0.75),
      bandOuter: bandPoly(0.1, 0.9),
      median: line(paths.reduce((acc, p) => acc.map((v, i) => v + p[i] / paths.length), new Array(n).fill(0))),
      last: med,
      paths: paths.slice(0, 8).map(line),
      start: y(paths[0][0]),
    }
  }, [analysis])

  if (!svg) return null
  return (
    <svg viewBox={`0 0 ${svg.W} ${svg.H}`} className="h-[90px] w-full">
      <polygon points={svg.bandOuter} fill="rgba(56,189,248,0.08)" />
      <polygon points={svg.bandInner} fill="rgba(56,189,248,0.16)" />
      {svg.paths.map((d, idx) => (
        <path key={idx} d={d} fill="none" stroke="rgba(56,189,248,0.35)" strokeWidth="0.7" />
      ))}
      <path d={svg.median} fill="none" stroke="#38bdf8" strokeWidth="1.6" />
      <line x1="0" x2={svg.W} y1={svg.start} y2={svg.start} stroke="#4b5a72" strokeDasharray="3 3" strokeWidth="0.7" />
    </svg>
  )
}

function AcfStrip({ analysis }: { analysis: AnalysisResult }) {
  const acf = analysis.quant.acf
  const sig = analysis.quant.acfSignificance
  const max = Math.max(sig * 1.6, ...acf.map((v) => Math.abs(v)), 0.05)
  return (
    <div className="flex h-10 items-center gap-[3px]">
      {acf.map((v, i) => (
        <div key={i} className="relative h-full flex-1">
          <div className="absolute left-0 top-1/2 h-px w-full bg-[#1c2739]" />
          <div
            className="absolute left-1/2 w-1.5 -translate-x-1/2 rounded-sm"
            style={{
              background: Math.abs(v) > sig ? '#38bdf8' : '#2a3a52',
              height: `${(Math.abs(v) / max) * 45}%`,
              bottom: v >= 0 ? '50%' : undefined,
              top: v < 0 ? '50%' : undefined,
            }}
          />
          <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 text-[7px] text-[#4b5a72]">{i + 1}</span>
        </div>
      ))}
    </div>
  )
}

// stretch history: z of price vs the OU equilibrium, ±2σ guides positioned
// dynamically so the bars and the guide lines share one scale
function OuZStrip({ z }: { z: (number | null)[] }) {
  const vals = z.filter((v): v is number => v !== null && Number.isFinite(v))
  if (vals.length < 5) return null
  const max = Math.max(2.5, ...vals.map((v) => Math.abs(v)))
  const guidePct = (2 / max) * 45 // ±2σ offset from the center line, in % of half-height
  return (
    <div className="relative flex h-10 items-center gap-[2px]">
      <div className="absolute left-0 top-1/2 h-px w-full bg-[#1c2739]" />
      <div className="absolute left-0 w-full border-t border-dashed border-[#2a3a52]" style={{ top: `${50 - guidePct}%` }} />
      <div className="absolute left-0 w-full border-t border-dashed border-[#2a3a52]" style={{ top: `${50 + guidePct}%` }} />
      {z.map((v, i) =>
        v === null || !Number.isFinite(v) ? (
          <div key={i} className="h-full flex-1" />
        ) : (
          <div
            key={i}
            className="absolute left-1/2 w-[3px] -translate-x-1/2 rounded-sm"
            style={{
              left: `${((i + 0.5) / z.length) * 100}%`,
              background: Math.abs(v) > 2 ? '#f59e0b' : Math.abs(v) > 1.2 ? '#a78bfa' : '#2a3a52',
              height: `${(Math.abs(v) / max) * 45}%`,
              bottom: v >= 0 ? '50%' : undefined,
              top: v < 0 ? '50%' : undefined,
            }}
          />
        )
      )}
    </div>
  )
}

/**
 * Randomness audit: descriptive statistics on the raw price FEED itself -
 * step size, return volatility/skew/kurtosis, update cadence. This is a
 * feed-behavior characterization for research/understanding, same genre as
 * the Hurst/ACF/GARCH stats above it in this panel - it does NOT predict any
 * specific future value and says nothing about a broker's internal RNG; it
 * only describes what the observable price series looks like statistically
 * (is it closer to a pure random walk, or does it show detectable structure
 * like fat tails or a metronomic update schedule).
 */
function RandomnessAuditCard({ asset, tf }: { asset: string; tf: string }) {
  const [audit, setAudit] = useState<RandomnessAudit | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    setBusy(true)
    setError(null)
    getRandomnessAudit(asset, tf as never)
      .then(setAudit)
      .catch((e: Error) => setError(e.message.slice(0, 120)))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    setAudit(null)
    setError(null)
  }, [asset])

  const kurt = audit?.stepStats.excessKurtosis ?? 0
  const kurtReadout =
    audit === null
      ? null
      : Math.abs(kurt) < 0.5
        ? { label: 'returns look roughly normal', color: '#aab6cc' }
        : kurt > 0
          ? { label: 'fat tails detected - larger-than-normal moves happen more often than a pure random walk would predict', color: '#f59e0b' }
          : { label: 'thin tails - extreme moves are rarer than a normal distribution would predict', color: '#38bdf8' }

  const jitter = audit?.intervalStats.jitterStdDevMs ?? 0
  const meanInt = audit?.intervalStats.meanIntervalMs ?? 0
  const jitterRatio = meanInt > 0 ? jitter / meanInt : 0
  const cadenceReadout =
    audit === null
      ? null
      : jitterRatio < 0.15
        ? { label: 'near-perfectly metronomic timing (suggests a scheduled/timed generator)', color: '#f59e0b' }
        : { label: 'naturally variable timing', color: '#aab6cc' }

  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3 xl:col-span-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Randomness Audit · OTC Feed Behavior</h3>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
        >
          {busy ? 'sampling…' : 'run audit'}
        </button>
      </div>
      <p className="mb-2 text-[9px] leading-relaxed text-[#4b5a72]">
        Descriptive statistics only - characterizes how this feed empirically moves (step size, return distribution, update cadence), for understanding whether it
        behaves like a pure random walk or a tuned model with detectable structure. Not a prediction of any future value.
      </p>
      {error && <p className="font-mono text-[10px] text-rose-400">{error}</p>}
      {audit && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider"
              style={
                audit.dataSource === 'tick'
                  ? { color: '#10b981', background: 'rgba(16,185,129,0.12)' }
                  : { color: '#f59e0b', background: 'rgba(245,158,11,0.12)' }
              }
            >
              {audit.dataSource === 'tick' ? 'real sub-candle ticks' : 'finest candle resolution (5s) - approx'}
            </span>
            <span className="font-mono text-[9px] text-[#4b5a72]">n = {audit.stepStats.n} samples</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px] md:grid-cols-4">
            <Stat label="Avg step size" value={audit.stepStats.meanAbsStep.toExponential(3)} note="mean |price[i] - price[i-1]|" />
            <Stat label="Std dev of returns" value={audit.stepStats.stdDevReturns.toExponential(3)} note="relative return volatility" />
            <Stat label="Skewness" value={audit.stepStats.skewness.toFixed(2)} note="0 = symmetric" />
            <Stat
              label="Excess kurtosis"
              value={audit.stepStats.excessKurtosis.toFixed(2)}
              color={kurtReadout?.color}
              note="0 = normal-like"
            />
            <Stat
              label="Update frequency"
              value={audit.intervalStats.updatesPerSecond >= 1 ? `${audit.intervalStats.updatesPerSecond.toFixed(2)}/s` : `${(audit.intervalStats.meanIntervalMs / 1000).toFixed(2)}s/update`}
              note={`mean interval ${audit.intervalStats.meanIntervalMs.toFixed(0)}ms`}
            />
            <Stat label="Timing jitter (σ)" value={`${audit.intervalStats.jitterStdDevMs.toFixed(0)}ms`} color={cadenceReadout?.color} note="std dev of inter-arrival time" />
          </div>
          <div className="mt-2 space-y-1 border-t border-[#1c2739] pt-2 text-[10px] leading-relaxed">
            {kurtReadout && <p style={{ color: kurtReadout.color }}>{kurtReadout.label}</p>}
            {cadenceReadout && <p style={{ color: cadenceReadout.color }}>{cadenceReadout.label}</p>}
          </div>
        </>
      )}
      {!audit && !error && <p className="text-[10px] text-[#4b5a72]">Run the audit to sample the live feed and compute these stats.</p>}
    </div>
  )
}

const VERDICT_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  edge: { label: 'EDGE', color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  weak: { label: 'WEAK', color: '#38bdf8', bg: 'rgba(56,189,248,0.12)' },
  no_edge: { label: 'NO EDGE', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  inconclusive: { label: 'INCONCLUSIVE', color: '#aab6cc', bg: 'rgba(170,182,204,0.12)' },
}

const POLICY_STYLE: Record<string, { color: string; bg: string }> = {
  enforce: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  warn: { color: '#38bdf8', bg: 'rgba(56,189,248,0.12)' },
  off: { color: '#7c8aa5', bg: 'rgba(124,138,165,0.12)' },
}

/**
 * OTC Defense - the placebo trial for generator-driven markets. OTC charts
 * don't respect technical analysis (they're synthesized by the broker), so
 * before autonomy is allowed to trade one, the strategy must beat its OWN
 * calibrated synthetic twins: our generator reproduces the pair's measured
 * statistics with zero learnable structure, and the strategy is run on both.
 * If real performance sits within the placebo distribution, the "edge" was
 * luck. Verdicts gate the autopilot/auto-trader under policy 'enforce'.
 */
/** Fair-coin drift monitor over the broker's own OTC feed (/otc_forensics).
 *  Tells the operator whether a drift regime is LIVE right now - the regime
 *  the drift-follower builtin trades and the defense placebo must account
 *  for. Regimes die without notice, so this is a monitor, not a signal. */
function OtcForensicsCard({ asset }: { asset: string }) {
  const [data, setData] = useState<OtcForensics | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setBusy(true)
    setError(null)
    getOtcForensics(asset, '1m', 2000)
      .then(setData)
      .catch((e: Error) => {
        setData(null)
        setError(e.message.slice(0, 200))
      })
      .finally(() => setBusy(false))
  }

  useEffect(load, [asset])
  // regime monitor: re-probe every 60s so a dead regime is seen fast
  useEffect(() => {
    const iv = setInterval(load, 60_000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset])

  const isOtc = asset.toUpperCase().endsWith('-OTC')
  const drift = data?.drift
  const DRIFT_STYLE: Record<string, { label: string; color: string; bg: string }> = {
    drift_up: { label: 'DRIFT UP', color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
    drift_down: { label: 'DRIFT DOWN', color: '#f43f5e', bg: 'rgba(244,63,94,0.12)' },
    suggestive: { label: 'SUGGESTIVE', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    none: { label: 'NO DRIFT', color: '#7c8aa5', bg: 'rgba(124,138,165,0.12)' },
  }
  const ds = drift ? DRIFT_STYLE[drift] : null
  const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`
  const live = drift === 'drift_up' || drift === 'drift_down'

  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3 xl:col-span-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">
          OTC Forensics · Drift Monitor
          {ds && (
            <span className="rounded px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider" style={{ color: ds.color, background: ds.bg }}>
              {ds.label}
            </span>
          )}
        </h3>
        <button
          type="button"
          onClick={load}
          disabled={busy}
          className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
        >
          {busy ? 'probing…' : 're-probe'}
        </button>
      </div>
      <p className="mb-2 text-[9px] leading-relaxed text-[#4b5a72]">
        Fair-coin probe on the broker&apos;s own 1m feed - FLAT-AWARE: candles that close unchanged are pushes in a binary trade (EV 0), so directional drift is
        measured on DECIDED transitions only. A heavy flat mass (e.g. BONK&apos;s 17.8%) makes a fair coin read as &apos;drift&apos; on the naive all-transitions up-rate -
        this monitor does not make that mistake. The drift-follower builtin gates on the same decided-side statistic; regimes die without notice - re-probe
        before every session.
      </p>
      {error && <p className="font-mono text-[10px] text-rose-400">{error}</p>}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px] md:grid-cols-4">
            <Stat
              label="Decided split"
              value={`${((1 - data.decided.upRate) * 100).toFixed(1)}% down`}
              color={ds?.color}
              note={`up ${(data.decided.upRate * 100).toFixed(1)}% · z ${data.decided.z >= 0 ? '+' : ''}${data.decided.z.toFixed(2)}σ`}
            />
            <Stat
              label="Flat (push) rate"
              value={`${(data.flatRate * 100).toFixed(1)}%`}
              note={`closes that don't move · naive up-rate ${(data.upRateClose * 100).toFixed(1)}%`}
            />
            <Stat
              label="Persistence"
              value={`${data.persistence.hours}h ${data.persistence.consistent ? 'consistent' : 'mixed'}`}
              color={data.persistence.consistent ? (live ? ds?.color : undefined) : '#f59e0b'}
              note={`hourly neg ${pct1(data.persistence.negFrac)} / pos ${pct1(data.persistence.posFrac)}`}
            />
            <Stat
              label="Price lattice"
              value={data.lattice.grid > 0 ? data.lattice.grid.toExponential(0) : '—'}
              note={data.lattice.grid > 0 ? `coverage ${pct1(data.lattice.gridCov)}` : 'no dominant grid'}
            />
          </div>
          <p className="mt-2 border-t border-[#1c2739] pt-2 text-[10px] leading-relaxed" style={{ color: ds?.color ?? '#aab6cc' }}>
            {data.summary}
          </p>
          {live && (
            <p className="mt-1 font-mono text-[9px] text-[#4b5a72]">
              regime live → try &apos;OTC Drift Follower&apos; in the Placebo Trial below (default null = does it beat its feed&apos;s luck; drift-neutral null = is the edge
              the drift). Probed {new Date(data.testedAt * 1000).toLocaleTimeString()}
              {data.dataSource && ` · data: ${data.dataSource === 'harvest' ? 'harvest archive (recorded real feed)' : data.dataSource}`}. Regimes die
              without notice - re-probe before trading.
            </p>
          )}
        </>
      )}
      {!data && !error && (
        <p className="text-[10px] text-[#4b5a72]">
          {isOtc ? 'Probing the feed…' : 'Non-OTC asset - the generator-drift probe only applies to -OTC pairs.'}
        </p>
      )}
    </div>
  )
}

function OtcDefenseCard({ asset, tf, strategies }: { asset: string; tf: string; strategies: StrategyInfo[] }) {
  const [strategyId, setStrategyId] = useState('confluence-core')
  // trial timeframe - follows the chart's tf by default but the operator can
  // pick any timeframe independently (a strategy may only make sense on one tf)
  const [tfSel, setTfSel] = useState<Timeframe>((TIMEFRAMES as string[]).includes(tf) ? (tf as Timeframe) : '1m')
  useEffect(() => {
    if ((TIMEFRAMES as string[]).includes(tf)) setTfSel(tf as Timeframe)
  }, [tf])
  const [status, setStatus] = useState<OtcStatus | null>(null)
  const [config, setConfig] = useState<OtcConfig | null>(null)
  const [report, setReport] = useState<OtcDefenseReport | null>(null)
  const [verdicts, setVerdicts] = useState<OtcVerdictRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshStatus = (s = strategyId) => {
    getOtcStatus(asset, s)
      .then(setStatus)
      .catch(() => setStatus(null))
    getOtcVerdicts(12)
      .then((d) => setVerdicts(d.verdicts.filter((v) => v.asset === asset)))
      .catch(() => setVerdicts([]))
  }

  useEffect(() => {
    setReport(null)
    setError(null)
    refreshStatus()
    getOtcConfig()
      .then((d) => setConfig(d.config))
      .catch(() => setConfig(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, strategyId])

  const run = () => {
    setBusy(true)
    setError(null)
    setReport(null)
    runOtcDefense({ asset, strategyId, tf: tfSel })
      .then((r) => {
        setReport(r)
        refreshStatus()
      })
      .catch((e: Error) => setError(e.message.slice(0, 300)))
      .finally(() => setBusy(false))
  }

  const setPolicy = (policy: OtcPolicy) => {
    setOtcConfig({ policy })
      .then((d) => setConfig(d.config))
      .catch((e: Error) => setError(e.message.slice(0, 120)))
  }

  const isOtc = status?.isOtc ?? asset.toUpperCase().endsWith('-OTC')
  const v = report?.verdict ?? status?.verdict?.verdict
  const vs = v ? VERDICT_STYLE[v] : null
  const edgeZ = report?.edgeZ ?? status?.verdict?.edgeZ
  // kernel reports win rates in percentage points already - never ×100
  const pct = (x: number) => `${x.toFixed(1)}%`

  return (
    <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3 xl:col-span-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">
          OTC Defense · Placebo Trial
          <span className="rounded px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider" style={isOtc ? { color: '#f59e0b', background: 'rgba(245,158,11,0.15)' } : { color: '#7c8aa5', background: 'rgba(124,138,165,0.12)' }}>
            {isOtc ? 'generator-driven feed' : 'real market'}
          </span>
          {config && (
            <span className="rounded px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider" style={POLICY_STYLE[config.policy]}>
              policy: {config.policy}
            </span>
          )}
        </h3>
        <div className="flex items-center gap-1">
          {config &&
            (['enforce', 'warn', 'off'] as OtcPolicy[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPolicy(p)}
                className={`rounded px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider transition-colors ${
                  config.policy === p ? 'bg-cyan-500/15 text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
                }`}
              >
                {p}
              </button>
            ))}
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="ml-1 rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
          >
            {busy ? 'running trial…' : 'run defense'}
          </button>
        </div>
      </div>
      <p className="mb-2 text-[9px] leading-relaxed text-[#4b5a72]">
        OTC charts are machine-generated - TA wins there can be pure luck. This trial runs the strategy on the real pair AND on K synthetic twins built by OUR
        OWN generator, calibrated to this pair&apos;s measured statistics (block-bootstrapped returns + cadence) with zero learnable structure. Real must beat
        the placebo to count as an edge. Under &apos;enforce&apos;, bots and the auto-trader are blocked on OTC pairs without a fresh passing verdict.
      </p>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* searchable dropdown over builtins + AI Lab specs (custom:<id>) */}
        <StrategyPicker strategies={strategies} value={strategyId} onChange={setStrategyId} width="w-48" />
        <select
          value={tfSel}
          onChange={(e) => setTfSel(e.target.value as Timeframe)}
          title="timeframe the trial runs on"
          className="h-8 rounded border border-[#1c2739] bg-[#101828] px-1.5 font-mono text-[11px] text-[#dbe4f0] outline-none focus:border-cyan-500/50"
        >
          {TIMEFRAMES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className="font-mono text-[9px] text-[#4b5a72]">
          {config ? `k=${config.seriesK} · minEdgeZ ${config.minEdgeZ}σ · TTL ${config.ttlDays}d` : ''}
        </span>
      </div>
      {error && <p className="font-mono text-[10px] text-rose-400">{error}</p>}
      {vs && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="rounded px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider" style={{ color: vs.color, background: vs.bg }}>
            {vs.label}
          </span>
          {typeof edgeZ === 'number' && (
            <span className="font-mono text-[10px] text-[#aab6cc]">
              edgeZ {edgeZ >= 0 ? '+' : ''}
              {edgeZ.toFixed(2)}σ
            </span>
          )}
          {status?.verdict && !report && (
            <span className="font-mono text-[9px] text-[#4b5a72]">
              last tested {new Date(status.verdict.ts * 1000).toLocaleString()} · {status.verdict.calibrationSource} calibration
            </span>
          )}
        </div>
      )}
      {report && (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px] md:grid-cols-4">
            <Stat label="Real win rate" value={pct(report.real.winRate)} color={vs?.color} note={`${report.real.totalTrades} trades · PF ${report.real.profitFactor.toFixed(2)}`} />
            <Stat label="Placebo mean" value={pct(report.placebo.winRateMean)} note={`± ${pct(report.placebo.winRateStd)} across ${report.placebo.series} twins`} />
            <Stat label="Placebo p95" value={pct(report.placebo.winRateP95)} note="luck's 95th percentile on this feed" />
            <Stat
              label="Edge (σ above placebo)"
              value={`${report.edgeZ >= 0 ? '+' : ''}${report.edgeZ.toFixed(2)}`}
              color={vs?.color}
              note={`bar: ${report.config.minEdgeZ}σ`}
            />
          </div>
          <p className="mt-2 border-t border-[#1c2739] pt-2 text-[10px] leading-relaxed" style={{ color: vs?.color ?? '#aab6cc' }}>
            {report.summary}
          </p>
          <p className="mt-1 font-mono text-[9px] text-[#4b5a72]">
            calibrated on {report.calibration.n} {report.calibration.source === 'tick' ? 'real sub-candle ticks' : 'candle closes'} · meanAbsStep{' '}
            {report.calibration.meanAbsStep.toExponential(3)} · excess kurtosis {report.calibration.excessKurtosis.toFixed(2)} · seedBase{' '}
            {report.calibration.seedBase} (reproducible)
            {report.dataSource === 'harvest' && (
              <span className="ml-1 rounded px-1 py-0.5 font-bold" style={{ color: '#10b981', background: 'rgba(16,185,129,0.12)' }}>
                HARVEST ARCHIVE - recorded REAL live feed
              </span>
            )}
            {report.dataMode === 'sim' && report.dataSource !== 'harvest' && (
              <span className="ml-1 rounded px-1 py-0.5 font-bold" style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.12)' }}>
                SIMULATOR DATA - verdict reflects sim structure, re-run on live feed
              </span>
            )}
          </p>
        </>
      )}
      {!report && !v && !error && (
        <p className="text-[10px] text-[#4b5a72]">
          {isOtc
            ? 'No verdict yet for this asset + strategy. Autonomy stays blocked on this feed until a trial passes (or policy is relaxed).'
            : 'Real-market asset - the OTC gate does not apply here. Run a trial anyway to sanity-check that performance beats calibrated noise.'}
        </p>
      )}
      {verdicts.length > 0 && (
        <div className="mt-2 border-t border-[#1c2739] pt-2">
          <p className="mb-1 font-mono text-[8px] font-bold uppercase tracking-wider text-[#4b5a72]">verdict ledger · {asset}</p>
          <div className="space-y-0.5">
            {verdicts.slice(0, 5).map((row, i) => {
              const s = VERDICT_STYLE[row.verdict] ?? VERDICT_STYLE.inconclusive
              return (
                <div key={`${row.strategyKey}-${row.ts}-${i}`} className="flex items-center gap-2 font-mono text-[9px]">
                  <span className="rounded px-1 py-0.5 text-[8px] font-bold" style={{ color: s.color, background: s.bg }}>
                    {s.label}
                  </span>
                  <span className="text-[#aab6cc]">{row.strategyKey}</span>
                  <span className="text-[#4b5a72]">
                    {row.tf} · real {pct(row.realWinRate)} vs placebo {pct(row.placeboWrMean)} · {row.edgeZ >= 0 ? '+' : ''}
                    {row.edgeZ.toFixed(2)}σ · {row.calibrationSource}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default function QuantPanel({ analysis, strategies = [] }: { analysis: AnalysisResult | null; strategies?: StrategyInfo[] }) {
  if (!analysis) return null
  const q = analysis.quant
  const mc = analysis.montecarlo
  const ou = analysis.kalman
  const hurstColor = q.hurst > 0.58 ? '#10b981' : q.hurst < 0.42 ? '#f59e0b' : '#aab6cc'

  const factorByName = new Map(analysis.signal.factors.map((f) => [f.name, f]))
  const hurstFactor = factorByName.get('Hurst Exponent')
  const zScoreFactor = factorByName.get('Z-Score (20)')
  const regressionFactor = factorByName.get('Regression Slope (R2)')
  const ouFactor = factorByName.get('Kalman/OU Stretch')
  const linkedCount = [hurstFactor, zScoreFactor, regressionFactor, ouFactor].filter(Boolean).length

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <div className="xl:col-span-2 text-[10px] text-[#4b5a72]">
        {linkedCount} of the stats below are live inputs to your composite signal score (currently{' '}
        <span className={analysis.signal.direction === 'call' ? 'text-emerald-400' : analysis.signal.direction === 'put' ? 'text-rose-400' : 'text-[#aab6cc]'}>
          {analysis.signal.score.toFixed(0)} · {analysis.signal.direction.toUpperCase()}
        </span>
        ) - the chips show each stat&apos;s current weighted vote direction and contribution.
      </div>
      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Monte Carlo · 30 steps · {mc.nSims} paths</h3>
        <MonteFan analysis={analysis} />
        <div className="mt-1 grid grid-cols-5 gap-1 text-center font-mono text-[10px]">
          {(
            [
              ['P5', mc.p5, 'text-rose-400'],
              ['P25', mc.p25, 'text-[#aab6cc]'],
              ['MED', mc.median, 'text-[#e2e8f0]'],
              ['P75', mc.p75, 'text-[#aab6cc]'],
              ['P95', mc.p95, 'text-emerald-400'],
            ] as [string, number, string][]
          ).map(([label, v, cls]) => (
            <div key={label}>
              <div className="text-[8px] text-[#4b5a72]">{label}</div>
              <div className={cls}>{fmtPrice(v, analysis.asset)}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between font-mono text-[10px]">
          <span className="text-[#4b5a72]">P(up) <span className="text-[#aab6cc]">{(mc.probUp * 100).toFixed(1)}%</span></span>
          <span className="text-[#4b5a72]">VaR95 <span className="text-rose-400">{(mc.var95 * 100).toFixed(2)}%</span></span>
          <span className="text-[#4b5a72]">CVaR95 <span className="text-rose-400">{(mc.cvar95 * 100).toFixed(2)}%</span></span>
          <span className="text-[#4b5a72]">E[DD] <span className="text-[#aab6cc]">{(mc.maxDrawdownExpected * 100).toFixed(2)}%</span></span>
        </div>
      </div>

      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Statistical Profile</h3>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px]">
          <Stat label="Hurst exponent" value={q.hurst.toFixed(3)} color={hurstColor} note={q.hurstNote} factor={hurstFactor} />
          <Stat label="Ann. volatility" value={`${q.annualizedVol.toFixed(1)}%`} />
          <Stat label="EWMA vol / bar" value={q.ewmaVol.toFixed(5)} />
          <Stat label="GARCH(1,1) vol" value={q.garchVol.toFixed(5)} />
          <Stat label="Z-score (20)" value={q.zScore.toFixed(2)} color={Math.abs(q.zScore) > 1.5 ? '#f59e0b' : '#aab6cc'} factor={zScoreFactor} />
          <Stat label="Sharpe (ann.)" value={q.sharpe.toFixed(2)} />
          <Stat label="Skew" value={q.skew.toFixed(2)} />
          <Stat label="Excess kurtosis" value={q.kurtosis.toFixed(2)} />
          <Stat label="Reg. slope R²" value={q.linreg.r2.toFixed(2)} note={`slope ${q.linreg.slope >= 0 ? '+' : ''}${q.linreg.slope.toExponential(1)}`} factor={regressionFactor} />
          <Stat label="Daily vol est." value={`${q.dailyVol.toFixed(2)}%`} />
        </div>
        <div className="mt-2 border-t border-[#1c2739] pt-2">
          <div className="mb-1 flex justify-between text-[10px] text-[#4b5a72]">
            <span>ACF of returns (lag 1–20)</span>
            <span>±{q.acfSignificance.toFixed(3)} significance</span>
          </div>
          <AcfStrip analysis={analysis} />
        </div>
      </div>

      {ou && (
        <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3 xl:col-span-2">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Kalman · Ornstein-Uhlenbeck Mean Reversion</h3>
            <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider">
              <span
                className="rounded px-1.5 py-0.5"
                style={{
                  color: ou.meanReverting ? '#10b981' : '#aab6cc',
                  background: ou.meanReverting ? 'rgba(16,185,129,0.1)' : 'rgba(148,163,184,0.08)',
                }}
              >
                {ou.meanReverting ? 'mean-reverting' : 'trending · OU edge off'}
              </span>
              {ou.signal !== 'none' && (
                <span
                  className="rounded px-1.5 py-0.5"
                  style={{
                    color: ou.signal === 'call' ? '#10b981' : '#f43f5e',
                    background: ou.signal === 'call' ? 'rgba(16,185,129,0.12)' : 'rgba(244,63,94,0.12)',
                  }}
                >
                  {ou.signal === 'call' ? '▲ call edge' : '▼ put edge'}
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px] md:grid-cols-4">
            <Stat
              label="Stretch z (price vs θ)"
              value={ou.z.toFixed(2)}
              color={Math.abs(ou.z) > 2 ? '#f59e0b' : Math.abs(ou.z) > 1.2 ? '#a78bfa' : '#e2e8f0'}
              note={ou.state !== 'neutral' ? ou.state.replace('-', ' ') : 'inside ±1.5σ'}
              factor={ouFactor}
            />
            <Stat label="Half-life" value={`${ou.halfLifeBars >= 9999 ? '∞' : ou.halfLifeBars.toFixed(1)} bars`} note={`entry gate: fast enough to revert in-bar`} />
            <Stat label="κ reversion speed" value={ou.kappa.toFixed(4)} note="per bar" />
            <Stat label="θ equilibrium" value={fmtPrice(ou.theta, analysis.asset)} note="OU long-run mean" />
            <Stat label="σ stationary" value={ou.sigmaEq.toExponential(2)} note="typical deviation from θ" />
            <Stat label="φ persistence" value={ou.phi.toFixed(4)} note={`R² ${ou.r2.toFixed(3)}`} />
            <Stat label="Reversion t-stat" value={ou.tStat.toFixed(2)} color={ou.tStat >= 1.5 ? '#10b981' : '#aab6cc'} note="≥ 1.5 = significant" />
            <Stat label="Kalman innov. z" value={ou.innovationZ.toFixed(2)} note="last standardized surprise" />
          </div>
          <div className="mt-2 border-t border-[#1c2739] pt-2">
            <div className="mb-1 flex justify-between text-[10px] text-[#4b5a72]">
              <span>stretch history (z, last {ou.zSeries.length} bars)</span>
              <span>dashed = ±2σ</span>
            </div>
            <OuZStrip z={ou.zSeries} />
          </div>
          <OuWalkForward asset={analysis.asset} tf={analysis.tf} />
          <p className="mt-1.5 text-[10px] leading-relaxed text-[#4b5a72]">
            {ou.note} · window {ou.window} bars · the Kalman filter runs the OU drift as its state equation, so the fair-value line anticipates pullback toward θ
            {ou.signal !== 'none' && (ou.signal === 'call' ? ' · stretched below equilibrium favors CALLS' : ' · stretched above equilibrium favors PUTS')}
          </p>
        </div>
      )}

      <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3 xl:col-span-2">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Support / Resistance Zones</h3>
        <div className="flex flex-wrap gap-2">
          {analysis.srZones.length === 0 && <span className="text-[11px] text-[#4b5a72]">No significant zones within 3% of price.</span>}
          {analysis.srZones.map((z, i) => (
            <div
              key={i}
              className="rounded border px-2 py-1 font-mono text-[10px]"
              style={{
                borderColor: z.type === 'support' ? 'rgba(16,185,129,0.4)' : 'rgba(244,63,94,0.4)',
                color: z.type === 'support' ? '#10b981' : '#f43f5e',
                background: z.type === 'support' ? 'rgba(16,185,129,0.07)' : 'rgba(244,63,94,0.07)',
              }}
            >
              {z.type === 'support' ? 'S' : 'R'} {fmtPrice(z.price, analysis.asset)} · {z.touches} touches
            </div>
          ))}
        </div>
      </div>

      <RandomnessAuditCard asset={analysis.asset} tf={analysis.tf} />
      <OtcForensicsCard asset={analysis.asset} />
      <OtcDefenseCard asset={analysis.asset} tf={analysis.tf} strategies={strategies} />
    </div>
  )
}

function Stat({ label, value, color, note, factor }: { label: string; value: string; color?: string; note?: string; factor?: Factor }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
      <div>
        <span style={{ color: color ?? '#e2e8f0' }}>{value}</span>
        <FactorBadge factor={factor} />
      </div>
      {note && <div className="text-[8px] text-[#4b5a72]">{note}</div>}
    </div>
  )
}
