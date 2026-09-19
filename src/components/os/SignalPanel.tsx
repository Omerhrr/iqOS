'use client'

// IQAIR//OS - Signal confluence panel (composite gauge + factor votes)
import type { AnalysisResult } from '@/lib/os/client'

function scoreColor(score: number): string {
  if (score >= 22) return '#10b981'
  if (score <= -22) return '#f43f5e'
  return '#eab308'
}

export default function SignalPanel({ analysis }: { analysis: AnalysisResult | null }) {
  if (!analysis) return null
  const sig = analysis.signal
  const pct = (sig.score + 100) / 2 // 0..100

  return (
    <div className="flex h-full flex-col gap-3 rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Confluence Signal</h3>
        <span
          className="rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{
            color: scoreColor(sig.score),
            background: `${scoreColor(sig.score)}1a`,
            border: `1px solid ${scoreColor(sig.score)}55`,
          }}
        >
          {sig.direction === 'call' ? 'CALL' : sig.direction === 'put' ? 'PUT' : 'NEUTRAL'}
        </span>
      </div>

      {/* score meter */}
      <div>
        <div className="relative h-2 overflow-hidden rounded-full bg-gradient-to-r from-rose-500/25 via-yellow-500/15 to-emerald-500/25">
          <div
            className="absolute top-0 h-full w-1 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)] transition-all duration-500"
            style={{ left: `calc(${Math.min(99, Math.max(1, pct))}% - 2px)` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] font-mono text-[#4b5a72]">
          <span className="text-rose-400">PUT -100</span>
          <span style={{ color: scoreColor(sig.score) }} className="font-bold">
            score {sig.score.toFixed(0)} · conf {sig.confidence.toFixed(0)}%
          </span>
          <span className="text-emerald-400">+100 CALL</span>
        </div>
      </div>

      {/* factor votes */}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {sig.factors.map((f) => {
          const strength = Math.min(1, Math.abs(f.vote) / 2)
          const color = f.vote > 0.15 ? '#10b981' : f.vote < -0.15 ? '#f43f5e' : '#4b5a72'
          return (
            <div key={f.name} className="text-[11px] leading-tight">
              <div className="flex items-center justify-between font-mono">
                <span className="text-[#aab6cc]">{f.name}</span>
                <span style={{ color }}>{f.vote > 0 ? '+' : ''}{f.vote.toFixed(1)}</span>
              </div>
              <div className="mt-0.5 flex h-1 items-center">
                <div className="relative h-1 w-full rounded bg-[#101828]">
                  <div className="absolute left-1/2 top-0 h-full w-px bg-[#2a3a52]" />
                  <div
                    className="absolute top-0 h-full rounded"
                    style={{
                      background: color,
                      width: `${strength * 50}%`,
                      left: f.vote > 0 ? '50%' : undefined,
                      right: f.vote <= 0 ? '50%' : undefined,
                    }}
                  />
                </div>
              </div>
              <div className="mt-0.5 text-[10px] text-[#4b5a72]">{f.note}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
