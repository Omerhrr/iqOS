'use client'

// IQAIR//OS - Confluence Signal sweep (market-wide)
// NOT a Screener reskin. Each pair is its own shrunk copy of the single-asset
// Confluence Signal gauge (SignalPanel.tsx) - same meter (PUT -100..+100 CALL,
// score/conf), same CALL/PUT/NEUTRAL badge and colors, and clicking a row
// expands the EXACT 14-factor breakdown (EMA Stack, ADX/DI, Regression Slope,
// Supertrend, RSI, MACD Hist, Stochastic K/D, Bollinger %B, Z-Score,
// Williams %R, Markov P(up), Hurst Exponent, Kalman/OU Stretch, Pattern Bias)
// with the same per-factor vote bars and notes the panel shows - just for
// every open pair at once instead of only the active chart's asset.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ConfluenceRow, ScreenerStatus, Timeframe } from '@/lib/os/client'
import { fmtPrice, osGet, osPost } from '@/lib/os/client'

interface ScreenerPanel2Props {
  onSelectSetup: (asset: string, tf: Timeframe) => void
  onError: (m: string) => void
}

type DirFilter = 'all' | 'call' | 'put'
type CatFilter = 'all' | 'forex' | 'otc' | 'crypto' | 'commodity' | 'stock' | 'index'

const TFS: (Timeframe | 'all')[] = ['all', '1m', '5m', '15m', '30m', '1h']
const CATS: { id: CatFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'forex', label: 'FX' },
  { id: 'otc', label: 'OTC' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'commodity', label: 'Comm.' },
  { id: 'stock', label: 'Stocks' },
  { id: 'index', label: 'Indices' },
]

/** Same thresholds/colors as SignalPanel.tsx's scoreColor - a row's CALL/PUT/
 * NEUTRAL badge here means exactly what it means on the single-asset panel. */
function scoreColor(score: number): string {
  if (score >= 22) return '#10b981'
  if (score <= -22) return '#f43f5e'
  return '#eab308'
}

export default function ScreenerPanel2({ onSelectSetup, onError }: ScreenerPanel2Props) {
  const [rows, setRows] = useState<ConfluenceRow[]>([])
  const [status, setStatus] = useState<ScreenerStatus | null>(null)
  const [tf, setTf] = useState<Timeframe | 'all'>('all')
  const [cat, setCat] = useState<CatFilter>('all')
  const [dir, setDir] = useState<DirFilter>('all')
  const [minScore, setMinScore] = useState(0)
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(40)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const prevScores = useRef<Map<string, number>>(new Map())

  const load = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { limit: 200 }
      if (tf !== 'all') params.tf = tf
      if (cat !== 'all') params.category = cat
      if (dir !== 'all') params.direction = dir
      if (minScore > 0) params.minScore = minScore
      if (q.trim()) params.q = q.trim()
      const [d, s] = await Promise.all([
        osGet<{ ok: boolean; rows: ConfluenceRow[] }>('/screener2', params),
        osGet<{ ok: boolean; status: ScreenerStatus }>('/screener2_status'),
      ])
      if (d.ok) {
        const changed = new Set<string>()
        for (const r of d.rows) {
          const key = `${r.asset}|${r.tf}`
          const prev = prevScores.current.get(key)
          if (prev !== undefined && Math.abs(Math.abs(r.score) - Math.abs(prev)) >= 8) changed.add(key)
          prevScores.current.set(key, r.score)
        }
        setFlash(changed)
        setRows(d.rows)
      }
      if (s.ok) setStatus(s.status)
    } catch (err) {
      onError((err as Error).message)
    }
  }, [tf, cat, dir, minScore, q, onError])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load])

  const shown = useMemo(() => rows.slice(0, limit), [rows, limit])

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const quickAlert = async (r: ConfluenceRow) => {
    const metric = r.direction === 'call' ? 'score_call' : r.direction === 'put' ? 'score_put' : 'score_abs'
    const value = Math.max(55, Math.ceil(Math.abs(r.score)))
    try {
      await osPost('/alert_rule_save', {
        name: `${r.asset} ${r.tf} confluence ≥ ${value}`,
        asset: r.asset,
        tf: r.tf,
        metric,
        value,
        cooldownSec: 600,
      })
      onError(`Alert armed: ${r.asset} ${r.tf} ${metric === 'score_call' ? 'CALL' : metric === 'score_put' ? 'PUT' : 'signal'} ≥ ${value} - see Alerts tab`)
    } catch (err) {
      onError((err as Error).message)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* controls */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#141d2e] px-2 py-1.5">
        <h3 className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">Confluence Signal</h3>
        <div className="flex overflow-hidden rounded border border-[#1c2739]">
          {TFS.map((t) => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={`px-2 py-0.5 font-mono text-[10px] uppercase transition-colors ${
                tf === t ? 'bg-violet-500/20 text-violet-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded border border-[#1c2739]">
          {CATS.map((c) => (
            <button
              key={c.id}
              onClick={() => setCat(c.id)}
              className={`px-2 py-0.5 text-[10px] uppercase transition-colors ${
                cat === c.id ? 'bg-violet-500/20 text-violet-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <Select value={dir} onValueChange={(v) => setDir(v as DirFilter)}>
          <SelectTrigger className="h-6 w-[86px] border-[#1c2739] bg-[#0b111c] font-mono text-[10px] text-[#aab6cc]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-[#1c2739] bg-[#0b111c] font-mono text-[11px]">
            <SelectItem value="all">both sides</SelectItem>
            <SelectItem value="call">call only</SelectItem>
            <SelectItem value="put">put only</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-[#4b5a72]">
          min |score|
          <input
            type="range"
            min={0}
            max={90}
            step={5}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="h-1 w-20 accent-violet-500"
          />
          <span className="w-5 text-violet-300">{minScore}</span>
        </div>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter symbol…"
          className="h-6 w-28 border-[#1c2739] bg-[#0b111c] font-mono text-[10px] text-[#dbe4f0] placeholder:text-[#3d4d66]"
        />
        <span className="ml-auto font-mono text-[9px] text-[#4b5a72]">
          {status
            ? `${status.instruments} instruments · ${status.pairs} pairs · ${status.sweeping ? `sweeping ${status.queue} left` : 'feed fresh'}`
            : 'connecting…'}
        </span>
      </div>

      {/* market-wide gauge list */}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {shown.length === 0 ? (
          <div className="flex h-full min-h-[100px] items-center justify-center font-mono text-[11px] text-[#3d4d66]">
            {status?.pairs ? 'no setups match the filters' : 'first sweep in progress - ranking the universe…'}
          </div>
        ) : (
          shown.map((r) => {
            const key = `${r.asset}|${r.tf}`
            const hot = flash.has(key)
            const open = expanded.has(key)
            const color = scoreColor(r.score)
            const pct = (r.score + 100) / 2
            return (
              <div
                key={key}
                className={`rounded border border-[#1c2739] bg-[#0d1420] transition-colors ${hot ? 'ring-1 ring-violet-500/40' : ''}`}
              >
                {/* header + meter (shrunk SignalPanel) */}
                <div className="cursor-pointer px-2.5 py-2" onClick={() => toggle(key)} title="click to expand the factor breakdown">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={`font-mono text-[9px] text-[#4b5a72] transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
                      <span className="truncate font-mono text-[12px] font-semibold text-[#dbe4f0]">{r.asset}</span>
                      {r.otc && <span className="shrink-0 rounded bg-amber-500/10 px-1 text-[8px] text-amber-400">OTC</span>}
                      <span className="shrink-0 font-mono text-[9px] text-[#4b5a72]">{r.tf}</span>
                      <span className="shrink-0 font-mono text-[10px] text-[#7c8aa5]">{fmtPrice(r.price, r.asset)}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span
                        className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                        style={{ color, background: `${color}1a`, border: `1px solid ${color}55` }}
                      >
                        {r.direction === 'call' ? 'CALL' : r.direction === 'put' ? 'PUT' : 'NEUTRAL'}
                      </span>
                      <Button
                        onClick={(e) => {
                          e.stopPropagation()
                          void quickAlert(r)
                        }}
                        variant="outline"
                        size="sm"
                        className="h-5 border-[#1c2739] px-1.5 text-[9px] text-[#7c8aa5] hover:text-violet-300"
                        title="create an alert rule from this setup"
                      >
                        bell
                      </Button>
                      <Button
                        onClick={(e) => {
                          e.stopPropagation()
                          onSelectSetup(r.asset, r.tf)
                        }}
                        variant="outline"
                        size="sm"
                        className="h-5 border-[#1c2739] px-1.5 text-[9px] text-[#7c8aa5] hover:text-violet-300"
                      >
                        chart
                      </Button>
                    </div>
                  </div>

                  {/* the exact panel meter, shrunk */}
                  <div className="mt-1.5">
                    <div className="relative h-1.5 overflow-hidden rounded-full bg-gradient-to-r from-rose-500/25 via-yellow-500/15 to-emerald-500/25">
                      <div
                        className="absolute top-0 h-full w-1 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)] transition-all duration-500"
                        style={{ left: `calc(${Math.min(99, Math.max(1, pct))}% - 2px)` }}
                      />
                    </div>
                    <div className="mt-0.5 flex justify-between font-mono text-[9px] text-[#4b5a72]">
                      <span className="text-rose-400">PUT -100</span>
                      <span style={{ color }} className="font-bold">
                        score {r.score.toFixed(0)} · conf {r.confidence.toFixed(0)}%
                      </span>
                      <span className="text-emerald-400">+100 CALL</span>
                    </div>
                  </div>
                </div>

                {/* full factor breakdown - identical rendering to SignalPanel.tsx */}
                {open && (
                  <div className="space-y-1.5 border-t border-[#141d2e] px-2.5 py-2">
                    {r.factors.map((f) => {
                      const vote = typeof f.vote === 'number' && Number.isFinite(f.vote) ? f.vote : 0
                      const strength = Math.min(1, Math.abs(vote) / 2)
                      const fColor = vote > 0.15 ? '#10b981' : vote < -0.15 ? '#f43f5e' : '#4b5a72'
                      return (
                        <div key={f.name} className="text-[11px] leading-tight">
                          <div className="flex items-center justify-between font-mono">
                            <span className="text-[#aab6cc]">{f.name}</span>
                            <span style={{ color: fColor }}>
                              {vote > 0 ? '+' : ''}
                              {vote.toFixed(1)}
                            </span>
                          </div>
                          <div className="mt-0.5 flex h-1 items-center">
                            <div className="relative h-1 w-full rounded bg-[#101828]">
                              <div className="absolute left-1/2 top-0 h-full w-px bg-[#2a3a52]" />
                              <div
                                className="absolute top-0 h-full rounded"
                                style={{
                                  background: fColor,
                                  width: `${strength * 50}%`,
                                  left: vote > 0 ? '50%' : undefined,
                                  right: vote <= 0 ? '50%' : undefined,
                                }}
                              />
                            </div>
                          </div>
                          <div className="mt-0.5 text-[10px] text-[#4b5a72]">{f.note}</div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}
        {rows.length > shown.length && (
          <button
            onClick={() => setLimit((l) => l + 40)}
            className="w-full py-1.5 text-center font-mono text-[10px] text-violet-400/70 hover:text-violet-300"
          >
            show more ({rows.length - shown.length} hidden)
          </button>
        )}
      </div>
    </div>
  )
}
