'use client'

// IQAIR//OS - Bottom workspace: positions blotter / history / autopilot / journal / backtest lab / strategy lab / patterns / alerts
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type {
  AlertRow,
  AnalysisResult,
  AssetRow,
  BacktestResult,
  BotRow,
  MetaTraderStatus,
  OsModeStatus,
  Position,
  StrategyInfo,
  Timeframe,
} from '@/lib/os/client'
import { fmtMoney, fmtPct, fmtPrice, fmtTime, osGet, osPost } from '@/lib/os/client'
import BacktestLab from './BacktestLab'
import QuantPanel from './QuantPanel'
import AutopilotPanel from './AutopilotPanel'
import AILabPanel from './AILabPanel'
import JournalTab from './JournalTab'
import ScreenerPanel from './ScreenerPanel'
import ScreenerPanel2 from './ScreenerPanel2'
import SmcPanel from './SmcPanel'
import MetaStrategyPanel from './MetaStrategyPanel'
import AlertRulesPanel from './AlertRulesPanel'
import SentinelPanel from './SentinelPanel'
import WatchdogPanel from './WatchdogPanel'
import ResearchPanel from './ResearchPanel'
import OrderFlowPanel from './OrderFlowPanel'
import OtcFootprintPanel from './OtcFootprintPanel'
import DiagnosticsPanel from './DiagnosticsPanel'
import CodeAssistBar from './CodeAssistBar'
import { builtinStrategyToMsl } from './builtinMslView'
import { FullscreenBackdrop, FullscreenButton } from './FullscreenButton'

interface BottomTabsProps {
  asset: string
  tf: Timeframe
  /** Task 59: bumps on every closed candle - keeps the order-flow views fresh */
  closedTick?: number
  analysis: AnalysisResult | null
  positions: Position[]
  history: Position[]
  alerts: AlertRow[]
  patterns: Position extends never ? never : import('@/lib/os/client').PatternHit[]
  assets: AssetRow[]
  strategies: StrategyInfo[]
  bots: BotRow[]
  price: number
  prices: Record<string, { price: number; dir: number }>
  modeStatus: OsModeStatus | null
  metaTraderStatus: MetaTraderStatus | null
  refreshMode: () => void
  refreshMetaTrader: () => void
  refreshPositions: () => void
  refreshBots: () => void
  refreshAccount: () => void
  onSelectSetup: (asset: string, tf: Timeframe) => void
  onError: (m: string) => void
}

export default function BottomTabs(props: BottomTabsProps) {
  const { positions, history, alerts, patterns, price, prices, asset, refreshPositions, onError, closedTick } = props
  const [full, setFull] = useState(false)

  // "the strategy lab should not be read only... let it be fully
  // functional" per direct instruction - the built-in Strategy Lab
  // catalog (STRATEGIES in trading-core/src/strategies/builtin.ts) gets
  // real view/edit/save-as-code, backed by /strategy_builtin_source and
  // /strategy_builtin_save (src/strategies/sourceedit.ts does the actual
  // brace-matched file surgery + syntax check + backup on the kernel
  // side - this is just the UI for it). AI-learned specs ("(Lab)" suffix,
  // custom:<id>) are handled by AI Lab's own JSON editor instead - they
  // aren't real source code, so they don't belong here.
  //
  // "make them all msl then" per direct instruction, after explaining that
  // a builtin strategy is real compiled TypeScript (Markov/Kalman/Monte
  // Carlo/VSK-TSK/correlation - genuinely iterative code MSL's sandboxed
  // grammar can't hand-write) - the honest version: builtinSig() is one of
  // the AI Lab's own MSL functions and calls a builtin strategy's REAL
  // evaluate() unmodified (strategies/signalscript.ts), so every single one
  // of the 57 gets a byte-identical-on-direction MSL view for free, shown
  // by DEFAULT when you view/edit a strategy here (builtinMslView.ts
  // generates it client-side, no fetch needed) - "view as TypeScript (real
  // code)" is the fallback toggle for the actual source. Editing the MSL
  // view and "save as new AI Lab strategy" promotes it to an independent
  // custom:<id> spec built on top of the original - it never rewrites
  // builtin.ts, since that's a different, genuinely safe thing to do than
  // pretending the original strategy's own logic IS an MSL script.
  const [viewingStrategyId, setViewingStrategyId] = useState<string | null>(null)
  const [sourceViewKind, setSourceViewKind] = useState<'msl' | 'ts'>('msl')
  const [strategySource, setStrategySource] = useState('')
  const [strategySourceLoading, setStrategySourceLoading] = useState(false)
  const [strategySourceError, setStrategySourceError] = useState<string | null>(null)
  const [editingStrategyId, setEditingStrategyId] = useState<string | null>(null)
  const [savingStrategySource, setSavingStrategySource] = useState(false)
  const [strategySaveNote, setStrategySaveNote] = useState<string | null>(null)

  const [mslText, setMslText] = useState('')
  const [mslTestResult, setMslTestResult] = useState<{ ok: boolean; direction?: string; confidence?: number; trace?: string[]; error?: string } | null>(null)
  const [mslTestBusy, setMslTestBusy] = useState(false)
  const [mslSaveBusy, setMslSaveBusy] = useState(false)
  const [mslSaveNote, setMslSaveNote] = useState<string | null>(null)
  const [mslSaveError, setMslSaveError] = useState<string | null>(null)

  const toggleStrategyView = (s: StrategyInfo) => {
    if (viewingStrategyId === s.id) {
      setViewingStrategyId(null)
      setEditingStrategyId(null)
      return
    }
    setViewingStrategyId(s.id)
    setSourceViewKind('msl')
    setEditingStrategyId(null)
    setMslText(builtinStrategyToMsl(s.id, s.name))
    setMslTestResult(null)
    setMslSaveNote(null)
    setMslSaveError(null)
    setStrategySource('')
    setStrategySourceError(null)
    setStrategySaveNote(null)
  }

  const ensureTsLoaded = (id: string) => {
    if (strategySource || strategySourceLoading) return
    setStrategySourceError(null)
    setStrategySourceLoading(true)
    osGet<{ ok: boolean; source?: string; error?: string }>('/strategy_builtin_source', { id })
      .then((r) => {
        if (!r.ok) throw new Error(r.error ?? 'could not read source')
        setStrategySource(r.source ?? '')
      })
      .catch((e: Error) => setStrategySourceError(e.message))
      .finally(() => setStrategySourceLoading(false))
  }

  const saveStrategySource = (id: string) => {
    setSavingStrategySource(true)
    setStrategySourceError(null)
    osPost<{ ok: boolean; message?: string; error?: string }>('/strategy_builtin_save', { id, source: strategySource })
      .then((r) => {
        if (!r.ok) throw new Error(r.error ?? 'save failed')
        setStrategySaveNote(r.message ?? 'saved')
        setEditingStrategyId(null)
      })
      .catch((e: Error) => setStrategySourceError(e.message))
      .finally(() => setSavingStrategySource(false))
  }

  const testMsl = () => {
    setMslTestBusy(true)
    setMslTestResult(null)
    osPost<{ ok: boolean; direction?: string; confidence?: number; trace?: string[]; error?: string }>('/lab_test_script', {
      script: mslText,
      asset,
      tf: props.tf,
    })
      .then((r) => setMslTestResult(r))
      .catch((e: Error) => setMslTestResult({ ok: false, error: e.message }))
      .finally(() => setMslTestBusy(false))
  }

  const saveMslAsNewStrategy = (s: StrategyInfo) => {
    if (!mslText.trim()) return setMslSaveError('nothing to save - the script is empty')
    setMslSaveBusy(true)
    setMslSaveError(null)
    setMslSaveNote(null)
    osPost<{ ok: boolean; id?: string; error?: string }>('/lab_save', {
      name: `${s.name} (MSL)`,
      asset,
      tf: props.tf,
      spec: { name: `${s.name} (MSL)`, signals: [], script: mslText },
    })
      .then((r) => {
        if (!r.ok) throw new Error(r.error ?? 'save failed')
        setMslSaveNote(`saved as new AI Lab strategy "${r.id}" - find it in the AI Lab tab (the original "${s.id}" is untouched)`)
      })
      .catch((e: Error) => setMslSaveError(e.message))
      .finally(() => setMslSaveBusy(false))
  }

  const closePos = async (id: string) => {
    try {
      // Task 58 (P2): 200-with-ok:false rejections ("position already settled")
      // used to be silently swallowed - surface them like hard failures
      const res = await osPost<{ ok: boolean; error?: string }>('/close', { id })
      if (!res.ok) onError(res.error ?? 'close rejected')
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
    <>
      {full && <FullscreenBackdrop onClose={() => setFull(false)} />}
      <Tabs
        defaultValue="positions"
        className={
          full
            ? 'fixed inset-4 z-50 flex flex-col gap-0 overflow-auto rounded-lg border border-[#1c2739] bg-[#05080f] p-2 shadow-2xl'
            : 'flex h-full min-h-0 flex-col gap-0'
        }
      >
      {/* max-w-full + hidden-scrollbar overflow: 12 uppercase tabs exceed the
          center dock at default sizes - without it the last tabs (Patterns,
          Alerts, ...) were clipped and unreachable. */}
      <div className="flex items-center gap-1 border-b border-[#1c2739]">
      <div className="shrink-0 pl-1">
        <FullscreenButton active={full} onToggle={() => setFull((f) => !f)} />
      </div>
      <TabsList className="h-8 w-fit max-w-full shrink-0 justify-start gap-1 overflow-x-auto rounded-none border-b-0 bg-transparent p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {(
          [
            ['positions', `Positions (${positions.length})`],
            ['history', `History (${history.length})`],
            ['screener', 'Screener'],
            ['screener2', 'Confluence Signal'],
            ['smc', 'SMC'],
            ['meta-strategy', 'Meta-Strategy'],
            ['autopilot', `Autopilot${props.bots.filter((b) => b.bot.enabled).length ? ` (${props.bots.filter((b) => b.bot.enabled).length})` : ''}`],
            ['sentinel', 'Sentinel'],
            ['watchdog', 'Watchdog'],
            ['research', 'Research'],
            ['journal', 'Journal'],
            ['backtest', 'Backtest Lab'],
            ['ailab', 'AI Lab'],
            ['strategies', 'Strategy Lab'],
            ['quant', 'Quant Lab'],
            ['orderflow', 'Order Flow'],
            ['otcfootprint', 'OTC Footprint'],
            ['patterns', `Patterns (${patterns.length})`],
            ['alerts', 'Alerts'],
            ['diagnostics', 'Diagnostics'],
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
      </div>

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
                // live option whose expiry has passed but IQ hasn't reported the
                // result yet - the OS deliberately records NOTHING until the
                // broker confirms, so show that state instead of a fake 0s/0.00
                const awaitingBroker = p.mode === 'live' && p.kind !== 'cfd' && ttl !== null && ttl <= 0
                return (
                  <tr key={p.id} className="border-b border-[#0d1420] hover:bg-[#0d1420]">
                    <Td className="text-[#4b5a72]">{fmtTime(p.tsOpen)}</Td>
                    <Td className="text-[#dbe4f0]">{p.asset}</Td>
                    <Td className={p.side === 'call' ? 'text-emerald-400' : 'text-rose-400'}>{p.side.toUpperCase()}</Td>
                    <Td className="text-[#7c8aa5]">{p.kind}</Td>
                    <Td>{fmtPrice(p.entryPrice, p.asset)}</Td>
                    <Td className={pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-[#7c8aa5]'}>{fmtPrice(p.asset === asset ? price : (prices[p.asset]?.price ?? p.entryPrice), p.asset)}</Td>
                    <Td className={awaitingBroker ? 'animate-pulse text-amber-400' : 'text-[#4b5a72]'}>
                      {awaitingBroker ? 'awaiting IQ…' : ttl !== null ? `${Math.max(0, ttl)}s` : `TP ${p.tp ?? '-'}% / SL ${p.sl ?? '-'}%`}
                    </Td>
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
                        color: p.status === 'won' ? '#10b981' : p.status === 'lost' ? '#f43f5e' : p.status === 'push' ? '#f59e0b' : '#7c8aa5',
                        background: p.status === 'won' ? 'rgba(16,185,129,0.1)' : p.status === 'lost' ? 'rgba(244,63,94,0.1)' : p.status === 'push' ? 'rgba(245,158,11,0.1)' : 'transparent',
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

      {/* SCREENER (discovery) */}
      <TabsContent value="screener" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <ScreenerPanel onSelectSetup={props.onSelectSetup} onError={onError} />
      </TabsContent>

      <TabsContent value="screener2" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <ScreenerPanel2 onSelectSetup={props.onSelectSetup} onError={onError} />
      </TabsContent>

      {/* SMART MONEY CONCEPTS / ICT STRUCTURE */}
      <TabsContent value="smc" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <SmcPanel asset={asset} tf={props.tf} closedTick={closedTick} onError={onError} />
      </TabsContent>

      {/* META-STRATEGY BUILDER (panel-combinator strategies) */}
      <TabsContent value="meta-strategy" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <MetaStrategyPanel asset={asset} tf={props.tf} onError={onError} />
      </TabsContent>

      {/* AUTOPILOT */}
      <TabsContent value="autopilot" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <div className="h-full">
          <AutopilotPanel
            bots={props.bots}
            assets={props.assets}
            strategies={props.strategies}
            modeStatus={props.modeStatus}
            metaTraderStatus={props.metaTraderStatus}
            refreshMode={props.refreshMode}
            refreshMetaTrader={props.refreshMetaTrader}
            onChanged={props.refreshBots}
            onError={onError}
          />
        </div>
      </TabsContent>

      {/* SENTINEL (risk governance) */}
      <TabsContent value="sentinel" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <div className="h-full">
          <SentinelPanel onError={onError} onAccountChanged={props.refreshAccount} />
        </div>
      </TabsContent>

      {/* WATCHDOG (strategy health) */}
      <TabsContent value="watchdog" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <div className="h-full">
          <WatchdogPanel onError={onError} />
        </div>
      </TabsContent>

      {/* RESEARCH & CALIBRATION (the "can I trust this" panel: calibration
          buckets + the walk-forward research-gate table) */}
      <TabsContent value="research" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <div className="h-full">
          <ResearchPanel strategies={props.strategies} onError={onError} />
        </div>
      </TabsContent>

      {/* JOURNAL */}
      <TabsContent value="journal" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <div className="h-full">
          <JournalTab />
        </div>
      </TabsContent>

      {/* BACKTEST / RESEARCH LAB */}
      <TabsContent value="backtest" className="mt-0 min-h-0 flex-1 overflow-auto p-3">
        <BacktestLab asset={asset} strategies={props.strategies} onSelectSetup={props.onSelectSetup} />
      </TabsContent>

      {/* AI LEARNING LAB (the agent studies a pair and invents its own strategy) */}
      <TabsContent value="ailab" className="mt-0 min-h-0 flex-1 overflow-auto p-3">
        <AILabPanel assets={props.assets} strategies={props.strategies} onError={onError} refreshBots={props.refreshBots} />
      </TabsContent>

      {/* STRATEGIES */}
      <TabsContent value="strategies" className="mt-0 min-h-0 flex-1 overflow-auto p-3">
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {props.strategies.map((s) => {
            const isLab = s.id.startsWith('custom:')
            const viewing = viewingStrategyId === s.id
            const editing = editingStrategyId === s.id
            return (
            <div key={s.id} className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
              <div className="flex items-center justify-between gap-2">
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
              {!isLab && (
                <div className="mt-2 flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5] hover:text-violet-400"
                    onClick={() => toggleStrategyView(s)}
                  >
                    {viewing ? 'hide source' : 'view source'}
                  </Button>
                  {viewing && sourceViewKind === 'ts' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5] hover:text-amber-400"
                      onClick={() => setEditingStrategyId(editing ? null : s.id)}
                    >
                      {editing ? 'cancel edit' : 'edit'}
                    </Button>
                  )}
                </div>
              )}
              {isLab && (
                <p className="mt-2 font-mono text-[8.5px] text-[#4b5a72]">AI-learned spec - edit it as JSON in the AI Lab tab, not here.</p>
              )}
              {viewing && (
                <div className="mt-2 rounded border border-[#1c2739] bg-[#070c15] p-2">
                  <div className="mb-1.5 flex items-center gap-px rounded border border-[#1c2739] p-0.5" style={{ width: 'fit-content' }}>
                    {(['msl', 'ts'] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => {
                          setSourceViewKind(k)
                          setEditingStrategyId(null)
                          if (k === 'ts') ensureTsLoaded(s.id)
                        }}
                        className={`rounded px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
                          sourceViewKind === k ? 'bg-violet-500/20 text-violet-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
                        }`}
                        title={k === 'ts' ? "The strategy's actual compiled TypeScript source" : 'A view/edit of this strategy as MSL via builtinSig() - a live call-through, not a reimplementation'}
                      >
                        {k === 'ts' ? 'TypeScript (real code)' : 'MSL'}
                      </button>
                    ))}
                  </div>
                  {sourceViewKind === 'msl' ? (
                    <>
                      <CodeAssistBar kind="ai_lab_script" currentCode={mslText} onApply={setMslText} lastError={mslTestResult && !mslTestResult.ok ? mslTestResult.error ?? null : null} context={{ id: s.id, name: s.name, asset, tf: String(props.tf) }} className="mb-1.5" />
                      <textarea
                        value={mslText}
                        onChange={(e) => setMslText(e.target.value)}
                        rows={16}
                        spellCheck={false}
                        className="w-full resize-y rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9.5px] leading-relaxed text-[#dbe4f0] outline-none focus:border-violet-500/40"
                      />
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={mslTestBusy}
                          className="h-6 border-violet-500/40 bg-violet-500/10 px-2 text-[9px] font-bold uppercase text-violet-300 hover:bg-violet-500/20 disabled:opacity-50"
                          onClick={testMsl}
                        >
                          {mslTestBusy ? 'testing...' : `test on ${asset}`}
                        </Button>
                        <Button
                          size="sm"
                          disabled={mslSaveBusy}
                          className="h-6 bg-cyan-600 px-2 text-[9px] font-bold uppercase tracking-wider text-white hover:bg-cyan-500 disabled:opacity-50"
                          onClick={() => saveMslAsNewStrategy(s)}
                        >
                          {mslSaveBusy ? 'saving...' : 'save as new AI Lab strategy'}
                        </Button>
                      </div>
                      {mslTestResult && (
                        <div className="mt-1.5 rounded border border-[#1c2739] bg-[#070c15] p-1.5">
                          {mslTestResult.ok ? (
                            <>
                              <span className={`font-mono text-[10px] font-bold uppercase ${mslTestResult.direction === 'call' ? 'text-emerald-300' : mslTestResult.direction === 'put' ? 'text-rose-300' : 'text-[#4b5a72]'}`}>
                                {mslTestResult.direction === 'none' ? 'no fire' : `${mslTestResult.direction} signal`}
                              </span>
                              {mslTestResult.direction !== 'none' && <span className="ml-1.5 font-mono text-[9px] text-[#7c8aa5]">conf {mslTestResult.confidence}%</span>}
                              <div className="mt-0.5 space-y-0.5">
                                {(mslTestResult.trace ?? []).map((line, i) => (
                                  <p key={i} className="font-mono text-[8.5px] text-[#7c8aa5]">
                                    {line}
                                  </p>
                                ))}
                              </div>
                            </>
                          ) : (
                            <p className="font-mono text-[9px] text-rose-300">{mslTestResult.error}</p>
                          )}
                        </div>
                      )}
                      {mslSaveError && <p className="mt-1 font-mono text-[9px] text-rose-300">{mslSaveError}</p>}
                      {mslSaveNote && <p className="mt-1 font-mono text-[9px] text-emerald-300">{mslSaveNote}</p>}
                      <p className="mt-1 font-mono text-[8.5px] text-[#4b5a72]">
                        builtinSig() calls this strategy&apos;s own evaluate() directly - the call/put verdict is byte-identical to &quot;{s.id}&quot;, only the confidence number is yours to
                        choose. Saving here creates a NEW, independent AI Lab strategy built on top of this one - it never rewrites builtin.ts.
                      </p>
                    </>
                  ) : strategySourceLoading ? (
                    <p className="font-mono text-[9px] text-[#4b5a72]">loading source…</p>
                  ) : editing ? (
                    <>
                      <CodeAssistBar
                        kind="builtin_strategy_ts"
                        currentCode={strategySource}
                        onApply={setStrategySource}
                        lastError={strategySourceError}
                        context={{ id: s.id, name: s.name }}
                        className="mb-1.5"
                      />
                      <textarea
                        value={strategySource}
                        onChange={(e) => setStrategySource(e.target.value)}
                        rows={18}
                        spellCheck={false}
                        className="w-full resize-y rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9.5px] leading-relaxed text-[#dbe4f0] outline-none focus:border-amber-500/40"
                      />
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <Button
                          size="sm"
                          disabled={savingStrategySource}
                          className="h-6 bg-amber-600 px-2 text-[9px] font-bold uppercase tracking-wider text-white hover:bg-amber-500 disabled:opacity-50"
                          onClick={() => saveStrategySource(s.id)}
                        >
                          {savingStrategySource ? 'saving...' : 'save changes'}
                        </Button>
                        <Button variant="outline" size="sm" className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5]" onClick={() => setEditingStrategyId(null)}>
                          cancel
                        </Button>
                      </div>
                      <p className="mt-1 font-mono text-[8.5px] text-[#4b5a72]">
                        This is real TypeScript, not data - edits are syntax-checked and backed up before saving, but a logic mistake can still ship. Saving
                        rewrites this strategy&apos;s block in builtin.ts in place; the kernel needs a restart for the change to take effect.
                      </p>
                    </>
                  ) : (
                    <pre className="max-h-72 overflow-auto font-mono text-[9.5px] leading-relaxed text-[#aab6cc]">{strategySource}</pre>
                  )}
                  {sourceViewKind === 'ts' && strategySourceError && <p className="mt-1 font-mono text-[9px] text-rose-300">{strategySourceError}</p>}
                  {sourceViewKind === 'ts' && strategySaveNote && !editing && <p className="mt-1 font-mono text-[9px] text-emerald-300">{strategySaveNote}</p>}
                </div>
              )}
            </div>
            )
          })}
        </div>
      </TabsContent>

      {/* QUANT LAB (monte carlo · statistical profile · kalman-ou · s/r) */}
      <TabsContent value="quant" className="mt-0 min-h-0 flex-1 overflow-auto p-3">
        {props.analysis ? (
          <QuantPanel analysis={props.analysis} strategies={props.strategies} />
        ) : (
          <Empty text="Quant lab populates once the kernel streams analysis for the active instrument." />
        )}
      </TabsContent>

      <TabsContent value="orderflow" className="mt-0 min-h-0 flex-1 overflow-auto">
        <OrderFlowPanel asset={asset} tf={props.tf} closedTick={closedTick} />
      </TabsContent>

      {/* OTC MICRO-TICK VELOCITY FOOTPRINT (generator-print speed matrix) */}
      <TabsContent value="otcfootprint" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <OtcFootprintPanel asset={asset} />
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

      {/* ALERTS: rules manager + system feed */}
      <TabsContent value="alerts" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
        <AlertRulesPanel assets={props.assets} onError={onError} />
        <div className="min-h-0 flex-1 overflow-auto border-t border-[#141d2e]">
          <div className="px-3 pt-1.5 font-mono text-[9px] uppercase tracking-wider text-[#3d4d66]">system feed</div>
          {alerts.length === 0 ? (
            <Empty text="System alerts will appear here (fills, settlements, rule triggers, risk events)." />
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
        </div>
      </TabsContent>

      {/* DIAGNOSTICS / SOAK TEST: a single-glance "did the auto-trader run
          cleanly" report, built from persisted positions/alerts/otc_verdicts -
          for judging an unattended paper-trading soak run after the fact. */}
      <TabsContent value="diagnostics" className="mt-0 min-h-0 flex-1 overflow-hidden">
        <DiagnosticsPanel onError={onError} />
      </TabsContent>
      </Tabs>
    </>
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
