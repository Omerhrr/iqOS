'use client'

// IQAIR//OS - Quant lab panel: Hurst, vol models, ACF, Monte Carlo fan, S/R zones
import { useMemo } from 'react'
import type { AnalysisResult } from '@/lib/os/client'
import { fmtPrice } from '@/lib/os/client'

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

export default function QuantPanel({ analysis }: { analysis: AnalysisResult | null }) {
  if (!analysis) return null
  const q = analysis.quant
  const mc = analysis.montecarlo
  const ou = analysis.kalman
  const hurstColor = q.hurst > 0.58 ? '#10b981' : q.hurst < 0.42 ? '#f59e0b' : '#aab6cc'

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
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
          <Stat label="Hurst exponent" value={q.hurst.toFixed(3)} color={hurstColor} note={q.hurstNote} />
          <Stat label="Ann. volatility" value={`${q.annualizedVol.toFixed(1)}%`} />
          <Stat label="EWMA vol / bar" value={q.ewmaVol.toFixed(5)} />
          <Stat label="GARCH(1,1) vol" value={q.garchVol.toFixed(5)} />
          <Stat label="Z-score (20)" value={q.zScore.toFixed(2)} color={Math.abs(q.zScore) > 1.5 ? '#f59e0b' : '#aab6cc'} />
          <Stat label="Sharpe (ann.)" value={q.sharpe.toFixed(2)} />
          <Stat label="Skew" value={q.skew.toFixed(2)} />
          <Stat label="Excess kurtosis" value={q.kurtosis.toFixed(2)} />
          <Stat label="Reg. slope R²" value={q.linreg.r2.toFixed(2)} note={`slope ${q.linreg.slope >= 0 ? '+' : ''}${q.linreg.slope.toExponential(1)}`} />
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
    </div>
  )
}

function Stat({ label, value, color, note }: { label: string; value: string; color?: string; note?: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
      <div style={{ color: color ?? '#e2e8f0' }}>{value}</div>
      {note && <div className="text-[8px] text-[#4b5a72]">{note}</div>}
    </div>
  )
}
