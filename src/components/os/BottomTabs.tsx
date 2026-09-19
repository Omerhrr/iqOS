'use client'

// IQAIR//OS - Bottom workspace: positions blotter / history / autopilot / journal / backtest lab / strategy lab / patterns / alerts
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type {
  AlertRow,
  AssetRow,
  BacktestResult,
  BotRow,
  Position,
  StrategyInfo,
  Timeframe,
} from '@/lib/os/client'
import { fmtMoney, fmtPct, fmtPrice, fmtTime, osPost } from '@/lib/os/client'
import BacktestLab from './BacktestLab'
import AutopilotPanel from './AutopilotPanel'
import JournalTab from './JournalTab'

interface BottomTabsProps {
  asset: string
  tf: Timeframe
  positions: Position[]
  history: Position[]
  alerts: AlertRow[]
  patterns: Position extends never ? never : import('@/lib/os/client').PatternHit[]
  assets: AssetRow[]
  strategies: StrategyInfo[]
  bots: BotRow[]
  price: number
  prices: Record<string, { price: number; dir: number }>
  refreshPositions: () => void
  refreshBots: () => void
  onError: (m: string) => void
}

export default function BottomTabs(props: BottomTabsProps) {
  const { positions, history, alerts, patterns, price, prices, asset, refreshPositions, onError } = props

  const closePos = async (id: string) => {
    try {
      await osPost('/close', { id })
      refreshPositions()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const openPnl = (p: Position) => {
    const dir = p.side === 'call' ? 1 : -1
    const now = p.asset === asset ? price : (prices[p.asset]?.price ?? p.entryPrice)
    const strike = p.strike ?? p.entryPrice
    const refPrice = p.kind === 'digital' ? strike : p.entryPrice
    const movePct = ((now - refPrice) / refPrice) * 100 * dir
    if (p.kind === 'binary' || p.kind === 'turbo' || p.kind === 'digital') return movePct > 0 ? p.amount * p.payout : movePct < 0 ? -p.amount : 0
    if (p.kind === 'cfd' && p.leverage) return (movePct / 100) * p.amount * p.leverage
    return (movePct / 100) * p.amount
  }

  return (
    <Tabs defaultValue="positions" className="flex h-full min-h-0 flex-col gap-0">
      <TabsList className="h-8 w-fit shrink-0 justify-start gap-1 rounded-none border-b border-[#1c2739] bg-transparent p-0">
        {(
          [
            ['positions', `Positions (${positions.length})`],
            ['history', `History (${history.length})`],
            ['autopilot', `Autopilot${props.bots.filter((b) => b.bot.enabled).length ? ` (${props.bots.filter((b) => b.bot.enabled).length})` : ''}`],
            ['journal', 'Journal'],
            ['backtest', 'Backtest Lab'],
            ['strategies', 'Strategy Lab'],
            ['patterns', `Patterns (${patterns.length})`],
            ['alerts', 'Alerts'],
          ] as [string, string][]
        ).map(([v, label]) => (
          <TabsTrigger
            key={v}
            value={v}
            className="rounded-none border-b-2 border-transparent px-3 text-[10px] uppercase tracking-wider text-[#4b5a72] data-[state=active]:border-cyan-500 data-[state=active]:bg-transparent data-[state=active]:text-cyan-300"
          >
            {label}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* POSITIONS */}
      <TabsContent value="positions" className="mt-0 min-h-0 flex-1 overflow-auto">
        {positions.length === 0 ? (
          <Empty text="No open positions - fire a trade from the ticket." />
        ) : (
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr className="border-b border-[#141d2e] text-left text-[9px] uppercase tracking-wider text-[#4b5a72]">
                <Th>Opened</Th>
                <Th>Asset</Th>
                <Th>Side</Th>
                <Th>Kind</Th>
                <Th>Entry</Th>
                <Th>Now</Th>
                <Th>Expiry</Th>
                <Th>Stake</Th>
                <Th>P/L</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const pnl = openPnl(p)
                const ttl = p.settlesAt ? p.settlesAt - Math.floor(Date.now() / 1000) : null
                return (
                  <tr key={p.id} className="border-b border-[#0d1420] hover:bg-[#0d1420]">
                    <Td className="text-[#4b5a72]">{fmtTime(p.tsOpen)}</Td>
                    <Td className="text-[#dbe4f0]">{p.asset}</Td>
                    <Td className={p.side === 'call' ? 'text-emerald-400' : 'text-rose-400'}>{p.side.toUpperCase()}</Td>
                    <Td className="text-[#7c8aa5]">{p.kind}</Td>
                    <Td>{fmtPrice(p.entryPrice, p.asset)}</Td>
                    <Td className={pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-[#7c8aa5]'}>{fmtPrice(p.asset === asset ? price : (prices[p.asset]?.price ?? p.entryPrice), p.asset)}</Td>
                    <Td className="text-[#4b5a72]">{ttl !== null ? `${Math.max(0, ttl)}s` : `TP ${p.tp ?? '-'}% / SL ${p.sl ?? '-'}%`}</Td>
                    <Td>{fmtMoney(p.amount)}</Td>
                    <Td className={pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {pnl >= 0 ? '+' : ''}
                      {fmtMoney(pnl)}
                    </Td>
                    <Td>
                      <Button onClick={() => void closePos(p.id)} variant="outline" size="sm" className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5] hover:text-rose-400">
                        close
                      </Button>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </TabsContent>

      {/* HISTORY */}
      <TabsContent value="history" className="mt-0 min-h-0 flex-1 overflow-auto">
        {history.length === 0 ? (
          <Empty text="No settled trades yet." />
        ) : (
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr className="border-b border-[#141d2e] text-left text-[9px] uppercase tracking-wider text-[#4b5a72]">
                <Th>Closed</Th>
                <Th>Asset</Th>
                <Th>Side</Th>
                <Th>Kind</Th>
                <Th>Entry</Th>
                <Th>Exit</Th>
                <Th>Stake</Th>
                <Th>P/L</Th>
                <Th>Result</Th>
                <Th>Strategy</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((p) => (
                <tr key={p.id} className="border-b border-[#0d1420] hover:bg-[#0d1420]">
                  <Td className="text-[#4b5a72]">{p.tsClose ? fmtTime(p.tsClose) : '-'}</Td>
                  <Td className="text-[#dbe4f0]">{p.asset}</Td>
                  <Td className={p.side === 'call' ? 'text-emerald-400' : 'text-rose-400'}>{p.side.toUpperCase()}</Td>
                  <Td className="text-[#7c8aa5]">{p.kind}</Td>
                  <Td>{fmtPrice(p.entryPrice, p.asset)}</Td>
                  <Td>{p.exitPrice ? fmtPrice(p.exitPrice, p.asset) : '-'}</Td>
                  <Td>{fmtMoney(p.amount)}</Td>
                  <Td className={(p.pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {(p.pnl ?? 0) >= 0 ? '+' : ''}
                    {fmtMoney(p.pnl ?? 0)}
                  </Td>
                  <Td>
                    <span
                      className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase"
                      style={{
                        color: p.status === 'won' ? '#10b981' : p.status === 'lost' ? '#f43f5e' : '#7c8aa5',
                        background: p.status === 'won' ? 'rgba(16,185,129,0.1)' : p.status === 'lost' ? 'rgba(244,63,94,0.1)' : 'transparent',
                      }}
                    >
                      {p.status}
                    </span>
                  </Td>
                  <Td className="text-[#4b5a72]">{p.strategy ?? '-'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TabsContent>

      {/* AUTOPILOT */}
      <TabsContent value="autopilot" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <div className="h-full">
          <AutopilotPanel
            bots={props.bots}
            assets={props.assets}
            strategies={props.strategies}
            onChanged={props.refreshBots}
            onError={onError}
          />
        </div>
      </TabsContent>

      {/* JOURNAL */}
      <TabsContent value="journal" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <div className="h-full">
          <JournalTab />
        </div>
      </TabsContent>

      {/* BACKTEST */}
      <TabsContent value="backtest" className="mt-0 min-h-0 flex-1 overflow-auto p-3">
        <BacktestLab asset={asset} strategies={props.strategies} />
      </TabsContent>

      {/* STRATEGIES */}
      <TabsContent value="strategies" className="mt-0 min-h-0 flex-1 overflow-auto p-3">
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {props.strategies.map((s) => (
            <div key={s.id} className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
              <div className="flex items-center justify-between">
                <h4 className="text-[12px] font-semibold text-[#dbe4f0]">{s.name}</h4>
                <span className="font-mono text-[9px] text-[#4b5a72]">{s.id}</span>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-[#7c8aa5]">{s.description}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {s.params.map((p) => (
                  <span key={p.key} className="rounded border border-[#1c2739] bg-[#101828] px-1.5 py-0.5 font-mono text-[9px] text-[#7c8aa5]">
                    {p.label}: <span className="text-cyan-300">{String(s.defaults[p.key])}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </TabsContent>

      {/* PATTERNS */}
      <TabsContent value="patterns" className="mt-0 min-h-0 flex-1 overflow-auto p-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {patterns.length === 0 && <Empty text="No candlestick formations on the recent bars." />}
          {patterns.map((h, i) => (
            <div
              key={`${h.name}-${i}`}
              className="rounded-lg border p-2.5"
              style={{
                borderColor: h.direction === 'bullish' ? 'rgba(16,185,129,0.35)' : h.direction === 'bearish' ? 'rgba(244,63,94,0.35)' : '#1c2739',
                background: h.direction === 'bullish' ? 'rgba(16,185,129,0.05)' : h.direction === 'bearish' ? 'rgba(244,63,94,0.05)' : '#0b111c',
              }}
            >
              <div className="flex items-center justify-between">
                <span className={`text-[12px] font-semibold ${h.direction === 'bullish' ? 'text-emerald-400' : h.direction === 'bearish' ? 'text-rose-400' : 'text-[#aab6cc]'}`}>
                  {h.name}
                </span>
                <span className="font-mono text-[9px] text-[#4b5a72]">
                  {'★'.repeat(h.reliability)} · {h.barsAgo === 0 ? 'now' : `${h.barsAgo} bars ago`}
                </span>
              </div>
              <p className="mt-0.5 text-[10px] text-[#7c8aa5]">{h.note}</p>
            </div>
          ))}
        </div>
      </TabsContent>

      {/* ALERTS */}
      <TabsContent value="alerts" className="mt-0 min-h-0 flex-1 overflow-auto">
        {alerts.length === 0 ? (
          <Empty text="System alerts will appear here (fills, settlements, risk events)." />
        ) : (
          <div className="divide-y divide-[#0d1420]">
            {alerts.map((a, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-1.5 font-mono text-[11px]">
                <span className="text-[9px] text-[#4b5a72]">{fmtTime(a.ts)}</span>
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: a.level === 'success' ? '#10b981' : a.level === 'danger' ? '#f43f5e' : a.level === 'warn' ? '#f59e0b' : '#38bdf8' }}
                />
                <span className="text-[#aab6cc]">{a.message}</span>
              </div>
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  )
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-1.5">{children}</th>
}
function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-1.5 ${className}`}>{children}</td>
}
function Empty({ text }: { text: string }) {
  return <div className="flex h-full min-h-[80px] items-center justify-center text-[11px] text-[#3d4d66]">{text}</div>
}
