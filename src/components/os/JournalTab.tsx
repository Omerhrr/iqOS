'use client'

// IQAIR//OS - Trade Journal: realized performance analytics.
// Overall stats, cumulative equity curve, grouped breakdowns by strategy /
// asset / instrument / side, and the recent closed-trade blotter.

import { useCallback, useEffect, useState } from 'react'
import type { JournalGroupRow, JournalSummary, Position } from '@/lib/os/client'
import { fmtMoney, fmtTime, osGet } from '@/lib/os/client'

type Scope = 'all' | 'bots'

export default function JournalTab() {
  const [scope, setScope] = useState<Scope>('all')
  const [data, setData] = useState<JournalSummary | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (s: Scope) => {
    try {
      const d = await osGet<{ ok: boolean } & JournalSummary>(`/journal`, { scope: s })
      if (d.ok) {
        const { ok: _ok, ...summary } = d
        setData(summary)
        setError('')
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void load(scope)
    const t = setInterval(() => void load(scope), 15000)
    return () => clearInterval(t)
  }, [scope, load])

  const o = data?.overall

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-2.5">
      <div className="flex shrink-0 items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">
          Trade Journal
          <span className="ml-2 font-mono text-[9px] normal-case tracking-normal text-[#4b5a72]">
            realized · last 500 closed
          </span>
        </h3>
        <div className="grid grid-cols-2 gap-0.5 rounded bg-[#101828] p-0.5">
          {(['all', 'bots'] as Scope[]).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`rounded px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-wider transition-colors ${
                scope === s ? 'bg-[#1c2739] text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
              }`}
            >
              {s === 'all' ? 'All trades' : 'Autopilot'}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="shrink-0 font-mono text-[10px] text-rose-400">journal unavailable: {error}</p>}

      {!o && !error && <p className="py-8 text-center font-mono text-[10px] text-[#4b5a72]">loading journal…</p>}

      {o && (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] gap-2 overflow-y-auto">
          {/* stat tiles */}
          <div className="grid grid-cols-4 gap-1.5">
            <Stat label="net P&L" value={fmtMoney(o.netPnl)} tone={o.netPnl >= 0 ? 'up' : 'down'} />
            <Stat label="win rate" value={`${Math.round(o.winRate * 100)}%`} tone={o.winRate >= 0.5 ? 'up' : 'neutral'} />
            <Stat label="profit factor" value={o.profitFactor.toFixed(2)} tone={o.profitFactor >= 1 ? 'up' : 'down'} />
            <Stat label="trades" value={String(o.trades)} tone="neutral" />
            <Stat label="avg win" value={fmtMoney(o.avgWin)} tone="up" />
            <Stat label="avg loss" value={fmtMoney(-o.avgLoss)} tone="down" />
            <Stat label="best" value={fmtMoney(o.bestTrade)} tone="up" />
            <Stat label="worst" value={fmtMoney(o.worstTrade)} tone="down" />
          </div>

          {/* equity curve */}
          <EquityCurve curve={data?.curve ?? []} />

          {/* grouped tables */}
          <div className="col-span-2 grid grid-cols-2 gap-2">
            <GroupTable title="By strategy" rows={data?.byStrategy ?? []} />
            <GroupTable title="By instrument" rows={data?.byAsset ?? []} />
            <GroupTable title="By instrument type" rows={data?.byKind ?? []} />
            <GroupTable title="By side" rows={data?.bySide ?? []} />
          </div>

          {/* recent blotter */}
          <div className="col-span-2">
            <div className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">Recent closed trades</div>
            <div className="overflow-hidden rounded border border-[#1c2739]">
              <table className="w-full font-mono text-[9px]">
                <thead>
                  <tr className="bg-[#101828] text-left text-[#4b5a72]">
                    <th className="px-2 py-1 font-medium">time</th>
                    <th className="px-2 py-1 font-medium">asset</th>
                    <th className="px-2 py-1 font-medium">side</th>
                    <th className="px-2 py-1 font-medium">kind</th>
                    <th className="px-2 py-1 font-medium">stake</th>
                    <th className="px-2 py-1 font-medium">p&l</th>
                    <th className="px-2 py-1 font-medium">status</th>
                    <th className="px-2 py-1 font-medium">source</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.recent ?? []).map((p) => (
                    <RecentRow key={p.id} p={p} />
                  ))}
                  {!data?.recent.length && (
                    <tr>
                      <td colSpan={8} className="px-2 py-4 text-center text-[#4b5a72]">
                        no closed trades in this scope yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'up' | 'down' | 'neutral' }) {
  return (
    <div className="rounded border border-[#1c2739] bg-[#101828] px-2 py-1.5">
      <div className="text-[8px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
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
      <div className="flex items-center justify-center rounded border border-[#1c2739] bg-[#101828] font-mono text-[10px] text-[#4b5a72]">
        equity curve appears after 2+ closed trades
      </div>
    )
  }
  const w = 300
  const h = 96
  const pad = 4
  const vals = curve.map((c) => c.equity)
  const min = Math.min(0, ...vals)
  const max = Math.max(0, ...vals)
  const span = max - min || 1
  const x = (i: number) => pad + (i / (curve.length - 1)) * (w - 2 * pad)
  const y = (v: number) => pad + (1 - (v - min) / span) * (h - 2 * pad)
  const line = curve.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(c.equity).toFixed(1)}`).join(' ')
  const zeroY = y(0)
  const last = vals[vals.length - 1]
  const up = last >= 0
  return (
    <div className="rounded border border-[#1c2739] bg-[#101828] p-2">
      <div className="mb-1 flex items-center justify-between font-mono text-[9px] text-[#4b5a72]">
        <span className="uppercase tracking-wider">cumulative P&L</span>
        <span className={up ? 'text-emerald-400' : 'text-rose-400'}>
          {up ? '+' : ''}
          {fmtMoney(last)}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
        <line x1={pad} y1={zeroY} x2={w - pad} y2={zeroY} stroke="#2a3850" strokeDasharray="3 3" strokeWidth="1" />
        <path d={line} fill="none" stroke={up ? '#34d399' : '#fb7185'} strokeWidth="1.6" />
        <circle cx={x(curve.length - 1)} cy={y(last)} r="2.5" fill={up ? '#34d399' : '#fb7185'} />
      </svg>
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

function RecentRow({ p }: { p: Position }) {
  const pnl = p.pnl ?? 0
  return (
    <tr className="border-t border-[#141d2e] text-[#aab6cc]">
      <td className="px-2 py-1 text-[#4b5a72]">{fmtTime(p.tsClose ?? p.tsOpen)}</td>
      <td className="px-2 py-1 font-bold text-[#dbe4f0]">{p.asset}</td>
      <td className={`px-2 py-1 font-bold ${p.side === 'call' ? 'text-emerald-400' : 'text-rose-400'}`}>
        {p.side.toUpperCase()}
      </td>
      <td className="px-2 py-1">{p.kind}</td>
      <td className="px-2 py-1">${p.amount}</td>
      <td className={`px-2 py-1 font-bold ${pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
        {pnl >= 0 ? '+' : ''}
        {fmtMoney(pnl)}
      </td>
      <td className={`px-2 py-1 ${p.status === 'won' ? 'text-emerald-400' : 'text-rose-400'}`}>{p.status}</td>
      <td className="px-2 py-1 text-[#4b5a72]">
        {p.note?.startsWith('bot:') ? (
          <span className="rounded bg-cyan-500/10 px-1 py-px text-cyan-300">autopilot</span>
        ) : (
          p.strategy ?? 'manual'
        )}
      </td>
    </tr>
  )
}
