'use client'

// IQAIR//OS - Screener panel (DISCOVERY)
// Live ranked opportunity feed across the whole instrument universe. The kernel
// sweeps every open market on the selected timeframes with the lightweight
// scanner; this panel filters/sorts the feed and jumps the workspace to any
// setup with one click. The bell button converts a setup into a standing alert
// rule so the OS keeps watching it after you leave the tab.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ScreenRow, ScreenerStatus, Timeframe } from '@/lib/os/client'
import { fmtPct, fmtPrice, osGet, osPost } from '@/lib/os/client'

interface ScreenerPanelProps {
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

const REGIME_COLOR: Record<string, string> = {
  bull: 'text-emerald-400',
  bear: 'text-rose-400',
  range: 'text-sky-400',
  chop: 'text-[#7c8aa5]',
}

function scoreColor(score: number): string {
  const a = Math.min(1, Math.abs(score) / 80)
  if (score >= 0) return `rgba(16,185,129,${0.15 + a * 0.5})`
  return `rgba(244,63,94,${0.15 + a * 0.5})`
}

export default function ScreenerPanel({ onSelectSetup, onError }: ScreenerPanelProps) {
  const [rows, setRows] = useState<ScreenRow[]>([])
  const [status, setStatus] = useState<ScreenerStatus | null>(null)
  const [tf, setTf] = useState<Timeframe | 'all'>('all')
  const [cat, setCat] = useState<CatFilter>('all')
  const [dir, setDir] = useState<DirFilter>('all')
  const [minScore, setMinScore] = useState(0)
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(60)
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
        osGet<{ ok: boolean; rows: ScreenRow[] }>('/screener', params),
        osGet<{ ok: boolean; status: ScreenerStatus }>('/screener_status'),
      ])
      if (d.ok) {
        // flash rows whose |score| jumped by >= 8 since last paint
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

  const quickAlert = async (r: ScreenRow) => {
    const metric = r.direction === 'call' ? 'score_call' : r.direction === 'put' ? 'score_put' : 'score_abs'
    const value = Math.max(55, Math.ceil(Math.abs(r.score)))
    try {
      await osPost('/alert_rule_save', {
        name: `${r.asset} ${r.tf} signal ≥ ${value}`,
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
        <div className="flex overflow-hidden rounded border border-[#1c2739]">
          {TFS.map((t) => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={`px-2 py-0.5 font-mono text-[10px] uppercase transition-colors ${
                tf === t ? 'bg-cyan-500/20 text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
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
                cat === c.id ? 'bg-cyan-500/20 text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
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
            className="h-1 w-20 accent-cyan-500"
          />
          <span className="w-5 text-cyan-300">{minScore}</span>
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

      {/* table */}
      <div className="min-h-0 flex-1 overflow-auto">
        {shown.length === 0 ? (
          <div className="flex h-full min-h-[100px] items-center justify-center font-mono text-[11px] text-[#3d4d66]">
            {status?.pairs ? 'no setups match the filters' : 'first sweep in progress - ranking the universe…'}
          </div>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <thead className="sticky top-0 z-10 bg-[#080d16]">
              <tr className="border-b border-[#141d2e] text-left text-[9px] uppercase tracking-wider text-[#4b5a72]">
                <Th>Asset</Th>
                <Th>Tf</Th>
                <Th>Price</Th>
                <Th>Signal</Th>
                <Th>Conf</Th>
                <Th>Regime</Th>
                <Th>RSI</Th>
                <Th>ADX</Th>
                <Th>ATR%</Th>
                <Th>Δ24</Th>
                <Th>Hurst</Th>
                <Th>OU z</Th>
                <Th>P(up)</Th>
                <Th>Pattern</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const key = `${r.asset}|${r.tf}`
                const hot = flash.has(key)
                return (
                  <tr
                    key={key}
                    className={`cursor-pointer border-b border-[#0d1420] transition-colors hover:bg-[#101828] ${hot ? 'bg-cyan-500/5' : ''}`}
                    onClick={() => onSelectSetup(r.asset, r.tf)}
                    title={`${r.name} - click to load chart`}
                  >
                    <Td>
                      <span className="text-[#dbe4f0]">{r.asset}</span>
                      {r.otc && <span className="ml-1 rounded bg-amber-500/10 px-1 text-[8px] text-amber-400">OTC</span>}
                    </Td>
                    <Td className="text-[#4b5a72]">{r.tf}</Td>
                    <Td>{fmtPrice(r.price, r.asset)}</Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-14 overflow-hidden rounded-full bg-[#101828]">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.min(100, Math.abs(r.score))}%`,
                              background: scoreColor(r.score),
                              marginLeft: r.score < 0 ? `${100 - Math.min(100, Math.abs(r.score))}%` : undefined,
                            }}
                          />
                        </div>
                        <span className={r.score >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{r.score.toFixed(0)}</span>
                      </div>
                    </Td>
                    <Td className="text-[#7c8aa5]">{r.confidence}%</Td>
                    <Td className={REGIME_COLOR[r.regime]}>{r.regime}</Td>
                    <Td className={r.rsi >= 70 ? 'text-amber-400' : r.rsi <= 30 ? 'text-sky-400' : 'text-[#7c8aa5]'}>{r.rsi.toFixed(0)}</Td>
                    <Td className={r.adx >= 25 ? 'text-cyan-300' : 'text-[#7c8aa5]'}>{r.adx.toFixed(0)}</Td>
                    <Td className="text-[#7c8aa5]">{r.atrPct.toFixed(3)}</Td>
                    <Td className={r.changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{fmtPct(r.changePct, 2)}</Td>
                    <Td className="text-[#7c8aa5]">{r.hurst.toFixed(2)}</Td>
                    <Td
                      className={
                        !r.ouMeanReverting
                          ? 'text-[#3d4c66]'
                          : r.ouZ <= -1.8
                            ? 'text-emerald-400'
                            : r.ouZ >= 1.8
                              ? 'text-rose-400'
                              : 'text-[#aab6cc]'
                      }
                      title={
                        r.ouMeanReverting
                          ? `Kalman/OU mean-reverting · half-life ${r.ouHalfLife >= 9999 ? '∞' : r.ouHalfLife.toFixed(0)} bars · t ${r.ouTStat.toFixed(1)} · ${r.ouZ.toFixed(2)}σ from equilibrium`
                          : `no reversion edge (t ${r.ouTStat.toFixed(1)}) - fading this is not advised`
                      }
                    >
                      {r.ouZ >= 0 ? '+' : ''}
                      {r.ouZ.toFixed(2)}
                    </Td>
                    <Td className={r.pUp >= 0.55 ? 'text-emerald-400' : r.pUp <= 0.45 ? 'text-rose-400' : 'text-[#7c8aa5]'}>{(r.pUp * 100).toFixed(0)}%</Td>
                    <Td className="max-w-[120px] truncate text-[#7c8aa5]" title={r.topPattern?.name ?? ''}>
                      {r.topPattern ? (
                        <span className={r.topPattern.direction === 'bullish' ? 'text-emerald-400' : r.topPattern.direction === 'bearish' ? 'text-rose-400' : ''}>
                          {r.topPattern.name}
                        </span>
                      ) : (
                        '-'
                      )}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        <Button
                          onClick={(e) => {
                            e.stopPropagation()
                            void quickAlert(r)
                          }}
                          variant="outline"
                          size="sm"
                          className="h-5 border-[#1c2739] px-1.5 text-[9px] text-[#7c8aa5] hover:text-cyan-300"
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
                          className="h-5 border-[#1c2739] px-1.5 text-[9px] text-[#7c8aa5] hover:text-cyan-300"
                        >
                          chart
                        </Button>
                      </div>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {rows.length > shown.length && (
          <button
            onClick={() => setLimit((l) => l + 60)}
            className="w-full py-1.5 text-center font-mono text-[10px] text-cyan-400/70 hover:text-cyan-300"
          >
            show more ({rows.length - shown.length} hidden)
          </button>
        )}
      </div>
    </div>
  )
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-2 py-1.5">{children}</th>
}
function Td({ children, className = '', title }: { children?: React.ReactNode; className?: string; title?: string }) {
  return (
    <td className={`px-2 py-1 ${className}`} title={title}>
      {children}
    </td>
  )
}
