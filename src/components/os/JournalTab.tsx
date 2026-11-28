'use client'

// IQAIR//OS - Trade Journal: realized performance analytics.
// Overall stats, cumulative equity curve, grouped breakdowns by strategy /
// asset / instrument / side, and the recent closed-trade blotter.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JournalGroupRow, JournalSummary, Position } from '@/lib/os/client'
import { fmtMoney, fmtTime, osGet } from '@/lib/os/client'

export type JournalScope = 'all' | 'bots' | 'auto' | 'meta' | 'omni' | 'manual'
type Scope = JournalScope

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: 'All trades' },
  { id: 'bots', label: 'Autopilot' },
  { id: 'auto', label: 'Auto-trader' },
  { id: 'meta', label: 'Meta' },
  { id: 'omni', label: 'Omni' },
  { id: 'manual', label: 'Manual' },
]

/** `fixedScope` pins the journal to one engine (used by the Autopilot engine tabs): no scope switcher, deeper blotter. */
export default function JournalTab({ fixedScope, title }: { fixedScope?: JournalScope; title?: string } = {}) {
  const [scope0, setScope] = useState<Scope>('all')
  const scope: Scope = fixedScope ?? scope0
  const [data, setData] = useState<JournalSummary | null>(null)
  const [error, setError] = useState('')

  const hasData = useRef(false)
  const load = useCallback(async (s: Scope) => {
    // a hidden browser tab does not poll; a refused or failed refresh keeps the last numbers on screen (the error only shows while there is nothing to show)
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      const d = await osGet<{ ok: boolean } & JournalSummary>(`/journal`, { scope: s, limit: fixedScope ? 300 : 40 })
      if (d.ok) {
        const { ok: _ok, ...summary } = d
        setData(summary)
        hasData.current = true
        setError('')
      }
    } catch (err) {
      const msg = (err as Error).message
      // "rate limited" is the kernel's per-address request budget, shared by every open panel: it clears by itself, so wait and retry quietly
      if (!hasData.current || !/rate limited|429/i.test(msg)) setError(msg)
    }
  }, [fixedScope])

  useEffect(() => {
    hasData.current = false
    setData(null)
    void load(scope)
    const t = setInterval(() => void load(scope), 20000)
    return () => clearInterval(t)
  }, [scope, load])

  const o = data?.overall
  const [section, setSection] = useState<'trades' | 'breakdown'>('trades')

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-2.5">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">
          {title ?? 'Trade Journal'}
          <span className="ml-2 font-mono text-[9px] normal-case tracking-normal text-[#4b5a72]">
            {fixedScope ? 'every trade this engine took' : 'realized · last 500 closed'}
          </span>
        </h3>
        {!fixedScope && (
          <div className="flex flex-wrap gap-0.5 rounded bg-[#101828] p-0.5">
            {SCOPES.map((s) => (
              <button
                key={s.id}
                onClick={() => setScope(s.id)}
                className={`rounded px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider transition-colors ${
                  scope === s.id ? 'bg-[#1c2739] text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="shrink-0 font-mono text-[10px] text-rose-400">journal unavailable: {error}</p>}
      {!o && !error && <p className="py-8 text-center font-mono text-[10px] text-[#4b5a72]">loading journal…</p>}

      {o && (
        // ONE scrolling column: every block sizes to its own content, nothing sits in a fixed-height row, so blocks can never overlap
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
          {/* headline numbers */}
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 xl:grid-cols-8">
            <Stat label="net P&L" value={fmtMoney(o.netPnl)} tone={o.netPnl >= 0 ? 'up' : 'down'} />
            <Stat label="win rate" value={`${Math.round(o.winRate * 100)}%`} tone={o.winRate >= 0.5 ? 'up' : 'neutral'} />
            <Stat label="profit factor" value={o.profitFactor.toFixed(2)} tone={o.profitFactor >= 1 ? 'up' : 'down'} />
            <Stat label="trades" value={`${o.wins}W · ${o.losses}L`} tone="neutral" />
            <Stat label="avg win" value={fmtMoney(o.avgWin)} tone="up" />
            <Stat label="avg loss" value={fmtMoney(-o.avgLoss)} tone="down" />
            <Stat label="best" value={fmtMoney(o.bestTrade)} tone="up" />
            <Stat label="worst" value={fmtMoney(o.worstTrade)} tone="down" />
          </div>

          <EquityCurve curve={data?.curve ?? []} />

          {/* one section at a time: the trade list, or the breakdowns */}
          <div className="flex gap-1">
            {([['trades', `Trades${data?.recent.length ? ` (${data.recent.length})` : ''}`], ['breakdown', 'Breakdowns']] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setSection(k)}
                className={`rounded px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                  section === k ? 'bg-cyan-500/15 text-cyan-300' : 'text-[#7c8aa5] hover:bg-[#101828] hover:text-[#dbe4f0]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {section === 'breakdown' && (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              <GroupTable title="By origin" rows={data?.byOrigin ?? []} />
              <GroupTable title="By strategy" rows={data?.byStrategy ?? []} />
              <GroupTable title="By instrument" rows={data?.byAsset ?? []} />
              <GroupTable title="By instrument type" rows={data?.byKind ?? []} />
              <GroupTable title="By side" rows={data?.bySide ?? []} />
            </div>
          )}

          {section === 'trades' && (
            <div className="space-y-3">
              {(data?.open?.length ?? 0) > 0 && (
                <TradeTable
                  title={`Open now (${data?.open?.length})`}
                  rows={data?.open ?? []}
                  open
                />
              )}
              <TradeTable title={fixedScope ? 'Closed trades' : 'Recent closed trades'} rows={data?.recent ?? []} empty="no closed trades in this scope yet" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'up' | 'down' | 'neutral' }) {
  return (
    <div className="min-w-0 self-start rounded border border-[#1c2739] bg-[#101828] px-2 py-1.5">
      <div className="truncate text-[8px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
      <div
        className={`text-[12px] font-bold ${
          tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-rose-400' : 'text-[#dbe4f0]'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function EquityCurve({ curve }: { curve: { ts: number; equity: number }[] }) {
  if (curve.length < 2) {
    return (
      <div className="flex h-16 items-center justify-center rounded border border-[#1c2739] bg-[#101828] font-mono text-[10px] text-[#4b5a72]">
        equity curve appears after 2+ closed trades
      </div>
    )
  }
  const w = 600
  const h = 100
  const vals = curve.map((c) => c.equity)
  const min = Math.min(0, ...vals)
  const max = Math.max(0, ...vals)
  const span = max - min || 1
  const px = (i: number) => (i / (curve.length - 1)) * w
  const py = (v: number) => 4 + (1 - (v - min) / span) * (h - 8)
  const line = curve.map((c, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(c.equity).toFixed(1)}`).join(' ')
  const last = vals[vals.length - 1]
  const up = last >= 0
  return (
    <div className="rounded border border-[#1c2739] bg-[#101828] p-2">
      <div className="mb-1 flex items-center justify-between font-mono text-[9px] text-[#4b5a72]">
        <span className="uppercase tracking-wider">cumulative P&amp;L · {curve.length} trades</span>
        <span className={up ? 'text-emerald-400' : 'text-rose-400'}>
          {up ? '+' : ''}
          {fmtMoney(last)}
        </span>
      </div>
      <div className="relative h-24 w-full">
        <svg viewBox={`0 0 ${w} ${h}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
          <line x1="0" y1={py(0)} x2={w} y2={py(0)} stroke="#2a3850" strokeDasharray="4 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d={line} fill="none" stroke={up ? '#34d399' : '#fb7185'} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
        <span
          className={`absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${up ? 'bg-emerald-400' : 'bg-rose-400'}`}
          style={{ left: '100%', top: `${(py(last) / h) * 100}%`, marginLeft: -4 }}
        />
      </div>
    </div>
  )
}

function GroupTable({ title, rows }: { title: string; rows: JournalGroupRow[] }) {
  const maxAbsPnl = Math.max(1, ...rows.map((r) => Math.abs(r.pnl)))
  return (
    <div className="rounded border border-[#1c2739] bg-[#101828] p-2">
      <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">{title}</div>
      {!rows.length && <p className="py-2 text-center font-mono text-[9px] text-[#3d4c66]">no data</p>}
      <div className="space-y-1">
        {rows.slice(0, 6).map((r) => (
          <div key={r.key} className="font-mono text-[9px]">
            <div className="flex items-center justify-between">
              <span className="truncate text-[#aab6cc]">{r.key || 'unassigned'}</span>
              <span className={r.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {r.pnl >= 0 ? '+' : ''}
                {fmtMoney(r.pnl)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <div className="h-1 flex-1 overflow-hidden rounded bg-[#0b111c]">
                <div
                  className={`h-full ${r.pnl >= 0 ? 'bg-emerald-400/60' : 'bg-rose-400/60'}`}
                  style={{ width: `${(Math.abs(r.pnl) / maxAbsPnl) * 100}%` }}
                />
              </div>
              <span className="shrink-0 text-[#4b5a72]">
                {r.trades}t · {Math.round(r.winRate * 100)}%
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TradeTable({ title, rows, open, empty }: { title: string; rows: Position[]; open?: boolean; empty?: string }) {
  return (
    <div>
      <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">{title}</div>
      <div className="max-h-[360px] overflow-auto rounded border border-[#1c2739]">
        <table className="w-full min-w-[640px] table-fixed font-mono text-[9px]">
          <colgroup>
            <col className="w-[88px]" />
            <col className="w-[78px]" />
            <col className="w-[48px]" />
            <col className="w-[56px]" />
            <col className="w-[52px]" />
            <col className="w-[64px]" />
            <col className="w-[52px]" />
            <col />
          </colgroup>
          <thead className="sticky top-0 z-[1]">
            <tr className="bg-[#101828] text-left text-[#4b5a72]">
              <th className="px-2 py-1 font-medium">{open ? 'opened' : 'closed'}</th>
              <th className="px-2 py-1 font-medium">asset</th>
              <th className="px-2 py-1 font-medium">side</th>
              <th className="px-2 py-1 font-medium">kind</th>
              <th className="px-2 py-1 font-medium">stake</th>
              <th className="px-2 py-1 font-medium">p&amp;l</th>
              <th className="px-2 py-1 font-medium">result</th>
              <th className="px-2 py-1 font-medium">strategy</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <RecentRow key={p.id} p={p} open={open} />
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={8} className="px-2 py-4 text-center text-[#4b5a72]">
                  {empty ?? 'none'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RecentRow({ p, open }: { p: Position; open?: boolean }) {
  const pnl = p.pnl ?? 0
  const origin = p.note?.startsWith('bot:')
    ? ['autopilot', 'bg-cyan-500/10 text-cyan-300']
    : p.note?.startsWith('auto:')
      ? ['auto', 'bg-amber-500/10 text-amber-300']
      : p.note?.startsWith('meta:trader')
        ? ['meta', 'bg-violet-500/10 text-violet-300']
        : p.note?.startsWith('omni:trader')
          ? ['omni', 'bg-emerald-500/10 text-emerald-300']
          : null
  return (
    <tr className="border-t border-[#141d2e] text-[#aab6cc]">
      <td className="truncate px-2 py-1 text-[#4b5a72]">{fmtTime(open ? p.tsOpen : (p.tsClose ?? p.tsOpen))}</td>
      <td className="truncate px-2 py-1 font-bold text-[#dbe4f0]">{p.asset}</td>
      <td className={`px-2 py-1 font-bold ${p.side === 'call' ? 'text-emerald-400' : 'text-rose-400'}`}>{p.side.toUpperCase()}</td>
      <td className="truncate px-2 py-1">{p.kind}</td>
      <td className="px-2 py-1">${p.amount}</td>
      <td className={`px-2 py-1 font-bold ${open ? 'text-[#4b5a72]' : pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
        {open ? '—' : `${pnl >= 0 ? '+' : ''}${fmtMoney(pnl)}`}
      </td>
      <td className={`px-2 py-1 ${open ? 'text-amber-300' : p.status === 'won' ? 'text-emerald-400' : 'text-rose-400'}`}>{open ? 'open' : p.status}</td>
      <td className="px-2 py-1 text-[#7c8aa5]">
        <div className="flex min-w-0 items-center gap-1">
          {origin && <span className={`shrink-0 rounded px-1 py-px ${origin[1]}`}>{origin[0]}</span>}
          <span className="truncate" title={p.strategy ?? ''}>{p.strategy ?? (origin ? '' : 'manual')}</span>
        </div>
      </td>
    </tr>
  )
}
