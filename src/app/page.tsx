'use client'

// IQAIR//OS - main shell
// Single-page operating system: menu bar, market watch, chart workspace,
// analytics dock, trade ticket, copilot and the bottom workspace tabs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { toast } from 'sonner'
import MenuBar from '@/components/os/MenuBar'
import MarketWatch from '@/components/os/MarketWatch'
import ChartPanel from '@/components/os/ChartPanel'
import IndicatorPanel from '@/components/os/IndicatorPanel'
import IndicatorPicker from '@/components/os/IndicatorPicker'
import SubPane from '@/components/os/SubPane'
import SignalPanel from '@/components/os/SignalPanel'
import MarkovPanel from '@/components/os/MarkovPanel'
import QuantPanel from '@/components/os/QuantPanel'
import TradeTicket from '@/components/os/TradeTicket'
import Copilot from '@/components/os/Copilot'
import BottomTabs from '@/components/os/BottomTabs'
import type {
  AccountState,
  AlertRow,
  AnalysisResult,
  AssetRow,
  BotRow,
  Candle,
  ChartType,
  IndicatorSeries,
  OsMode,
  OsModeStatus,
  Position,
  RegistryEntry,
  RiskConfig,
  StrategyInfo,
  Timeframe,
} from '@/lib/os/client'
import { osGet, osPost, useOSFeed } from '@/lib/os/client'

const BOOT_MSGS = [
  'mounting kernel plugins…',
  'universe: 115 instruments online (forex · otc · crypto · commodities · stocks · indices)',
  'registry: 103 indicators · 35 candlestick + chart patterns armed',
  'analytics: markov + montecarlo engines fitted',
  'execution: binary · turbo · digital · cfd broker + risk manager ready',
  'sentinel: circuit breakers armed · exposure caps · trade throttle',
  'watchdog: strategy drift guardian watching the bot fleet',
  'IQAIR//OS ready',
]

interface ActiveIndicator {
  id: string
  params?: Record<string, number>
}

/** Desktop = the resizable 3-dock workspace; below lg the OS stacks into one scrollable column. */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)')
    const onChange = () => setIsDesktop(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isDesktop
}

export default function OSPage() {
  const [assets, setAssets] = useState<AssetRow[]>([])
  const [asset, setAsset] = useState('EURUSD')
  const [tf, setTf] = useState<Timeframe>('1m')
  const [candles, setCandles] = useState<Candle[]>([])
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [account, setAccount] = useState<AccountState | null>(null)
  const [risk, setRisk] = useState<RiskConfig | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [history, setHistory] = useState<Position[]>([])
  const [alerts, setAlerts] = useState<AlertRow[]>([])
  const [strategies, setStrategies] = useState<StrategyInfo[]>([])
  const [bots, setBots] = useState<BotRow[]>([])
  const [screenerLive, setScreenerLive] = useState(0)
  const [prices, setPrices] = useState<Record<string, { price: number; dir: number }>>({})
  const [bootLine, setBootLine] = useState(0)
  const [connected, setConnected] = useState(false)
  const [chartType, setChartType] = useState<ChartType>('candles')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [registry, setRegistry] = useState<RegistryEntry[]>([])
  const [activeOverlays, setActiveOverlays] = useState<ActiveIndicator[]>([])
  const [activeSubs, setActiveSubs] = useState<ActiveIndicator[]>([])
  const [overlaySeries, setOverlaySeries] = useState<IndicatorSeries[]>([])
  const pricesRef = useRef<Record<string, { price: number; dir: number }>>({})
  const isDesktop = useIsDesktop()

  const pushToast = useCallback((level: AlertRow['level'], message: string) => {
    if (level === 'success') toast.success(message)
    else if (level === 'danger') toast.error(message)
    else if (level === 'warn') toast.warning(message)
    else toast.message(message)
  }, [])

  // kernel keeper: make sure trading-core is alive (spawns it via the server
  // if the port is dark) - called on boot and whenever the feed reconnects
  const ensureKernel = useCallback(async () => {
    try {
      const res = await fetch('/api/kernel', { cache: 'no-store' })
      const d = (await res.json()) as { ok: boolean; kernel?: string }
      if (!d.ok && d.kernel === 'spawn-failed') pushToast('danger', 'Kernel keeper could not start trading-core on :3030')
    } catch {
      /* keeper route unreachable - keep booting anyway */
    }
  }, [pushToast])

  // boot sequence animation
  useEffect(() => {
    if (bootLine >= BOOT_MSGS.length) return
    const t = setTimeout(() => setBootLine((b) => b + 1), 260)
    return () => clearTimeout(t)
  }, [bootLine])

  const loadAssets = useCallback(async () => {
    try {
      const d = await osGet<{ ok: boolean; assets: AssetRow[]; activeAsset: string }>('/assets')
      if (d.ok) {
        setAssets(d.assets)
        setPrices((prev) => {
          const next = { ...prev }
          for (const a of d.assets) next[a.ticker] = next[a.ticker] ?? { price: a.price, dir: 0 }
          return next
        })
      }
    } catch {
      pushToast('danger', 'Cannot reach trading-core on :3030 - is the kernel running?')
    }
  }, [pushToast])

  const loadCandles = useCallback(async (a: string, t: Timeframe) => {
    const d = await osGet<{ ok: boolean; candles: Candle[] }>(`/candles`, { asset: a, tf: t, limit: 320 })
    if (d.ok) setCandles(d.candles)
  }, [])

  const loadAnalysis = useCallback(async (a: string, t: Timeframe) => {
    try {
      const d = await osGet<{ ok: boolean; analysis: AnalysisResult }>(`/analysis`, { asset: a, tf: t })
      if (d.ok) setAnalysis(d.analysis)
    } catch {
      // analysis needs more candles - ignore until then
    }
  }, [])

  const loadAccount = useCallback(async () => {
    const d = await osGet<{ ok: boolean; account: AccountState; risk: RiskConfig }>('/account')
    if (d.ok) {
      setAccount(d.account)
      setRisk(d.risk)
    }
  }, [])

  const loadPositions = useCallback(async () => {
    const [o, h] = await Promise.all([
      osGet<{ ok: boolean; positions: Position[] }>('/positions', { status: 'open' }),
      osGet<{ ok: boolean; positions: Position[] }>('/positions', { status: 'closed' }),
    ])
    if (o.ok) setPositions(o.positions)
    if (h.ok) setHistory(h.positions.slice(0, 60))
  }, [])

  const loadBots = useCallback(async () => {
    try {
      const d = await osGet<{ ok: boolean; bots: BotRow[] }>('/bots')
      if (d.ok) setBots(d.bots)
    } catch {
      // autopilot endpoints need a kernel with the bot plugin - ignore until then
    }
  }, [])

  // sentinel status polling - feeds the governance chip in the status bar
  const [sentinelArmed, setSentinelArmed] = useState(false)
  useEffect(() => {
    const poll = () =>
      void osGet<{ ok: boolean; armed: boolean }>('/sentinel')
        .then((d) => setSentinelArmed(Boolean(d.ok && d.armed)))
        .catch(() => setSentinelArmed(false))
    poll()
    const t = setInterval(poll, 5000)
    return () => clearInterval(t)
  }, [])

  // watchdog status polling - feeds the strategy-health chip in the status bar
  const [watchdogStopped, setWatchdogStopped] = useState(0)
  useEffect(() => {
    const poll = () =>
      void osGet<{ ok: boolean; summary: { hold: number; disarmed: number } }>('/watchdog')
        .then((d) => setWatchdogStopped(d.ok ? d.summary.hold + d.summary.disarmed : 0))
        .catch(() => setWatchdogStopped(0))
    poll()
    const t = setInterval(poll, 10000)
    return () => clearInterval(t)
  }, [])

  // archive depth polling - feeds the deep-history chip in the status bar
  const [archiveBars, setArchiveBars] = useState(0)
  useEffect(() => {
    const poll = () =>
      void osGet<{ ok: boolean; stats: { rows: number } }>('/archive')
        .then((d) => setArchiveBars(d.ok ? d.stats.rows : 0))
        .catch(() => setArchiveBars(0))
    poll()
    const t = setInterval(poll, 30000)
    return () => clearInterval(t)
  }, [])

  // os mode polling - feeds the menu-bar toggle, the autonomy chip in the
  // status bar and the auto-trader strip in the Autopilot panel
  const [modeStatus, setModeStatus] = useState<OsModeStatus | null>(null)
  const loadMode = useCallback(async () => {
    try {
      const d = await osGet<{ ok: boolean } & OsModeStatus>('/mode')
      if (d.ok)
        setModeStatus({ mode: d.mode, ts: d.ts, reason: d.reason, autotrader: d.autotrader })
    } catch {
      /* kernel not up yet */
    }
  }, [])
  useEffect(() => {
    void loadMode()
    const t = setInterval(() => void loadMode(), 5000)
    return () => clearInterval(t)
  }, [loadMode])
  const osMode: OsMode = modeStatus?.mode ?? 'human'

  // initial load
  useEffect(() => {
    void ensureKernel()
    void loadAssets()
    void loadAccount()
    void loadPositions()
    void loadBots()
    void osGet<{ ok: boolean; strategies: StrategyInfo[] }>('/strategies').then((d) => {
      if (d.ok) setStrategies(d.strategies)
    })
    void osGet<{ ok: boolean; indicators: RegistryEntry[] }>('/indicators').then((d) => {
      if (d.ok) setRegistry(d.indicators)
    })
    void osGet<{ ok: boolean; alerts: AlertRow[] }>('/alerts').then((d) => {
      if (d.ok) setAlerts(d.alerts.slice(0, 40))
    })
  }, [loadAssets, loadAccount, loadPositions, loadBots, ensureKernel])

  // if the feed stays dark, give the keeper a chance to revive the kernel
  useEffect(() => {
    if (connected) return
    const t = setTimeout(() => void ensureKernel(), 3000)
    return () => clearTimeout(t)
  }, [connected, ensureKernel])

  // bot fleet polling - keeps armed/P&L stats fresh without socket churn
  useEffect(() => {
    const t = setInterval(() => void loadBots(), 6000)
    return () => clearInterval(t)
  }, [loadBots])

  // screener status polling - feeds the discovery chip in the status bar
  useEffect(() => {
    const poll = () =>
      void osGet<{ ok: boolean; status: { pairs: number } }>('/screener_status')
        .then((d) => setScreenerLive(d.ok ? d.status.pairs : 0))
        .catch(() => setScreenerLive(0))
    poll()
    const t = setInterval(poll, 10000)
    return () => clearInterval(t)
  }, [])

  // fetch overlay series when overlays/asset/tf change
  const overlayKey = useMemo(
    () => activeOverlays.map((o) => `${o.id}:${JSON.stringify(o.params ?? {})}`).join('|'),
    [activeOverlays]
  )
  useEffect(() => {
    if (!activeOverlays.length) {
      setOverlaySeries([])
      return
    }
    let cancelled = false
    void Promise.all(
      activeOverlays.map(async (o) => {
        const fetchParams: Record<string, string | number> = { id: o.id, asset, tf }
        if (o.params) for (const [k, v] of Object.entries(o.params)) fetchParams[`p_${k}`] = v
        try {
          const d = await osGet<{ ok: boolean; series: IndicatorSeries }>('/indicator', fetchParams)
          return d.ok ? d.series : null
        } catch {
          return null
        }
      })
    ).then((res) => {
      if (!cancelled) setOverlaySeries(res.filter((s): s is IndicatorSeries => s !== null))
    })
    return () => {
      cancelled = true
    }
  }, [overlayKey, asset, tf])

  // asset/tf switch
  useEffect(() => {
    if (!asset || !tf) return
    void loadCandles(asset, tf)
    void loadAnalysis(asset, tf)
  }, [asset, tf, loadCandles, loadAnalysis])

  const handleSelectAsset = useCallback((a: string) => {
    setAsset(a)
    void osPost('/asset', { asset: a })
  }, [])

  // screener row -> load that setup into the chart workspace
  const handleSelectSetup = useCallback(
    (a: string, t: Timeframe) => {
      setAsset(a)
      setTf(t)
      void osPost('/asset', { asset: a })
    },
    []
  )

  // realtime feed
  useOSFeed(asset, tf, {
    onConnectChange: setConnected,
    onTick: (p) => {
      pricesRef.current[p.asset] = {
        price: p.price,
        dir: pricesRef.current[p.asset] ? Math.sign(p.price - pricesRef.current[p.asset].price) : 0,
      }
      setPrices({ ...pricesRef.current })
    },
    onCandle: (p) => {
      if (p.asset !== asset || p.tf !== tf) return
      setCandles((prev) => {
        const lastC = prev[prev.length - 1]
        if (lastC && lastC.time === p.candle.time) return [...prev.slice(0, -1), p.candle]
        if (!p.closed) return [...prev.slice(-320), p.candle]
        return [...prev.slice(-319), p.candle]
      })
      if (p.closed) void loadAnalysis(p.asset, p.tf)
    },
    onAccount: (p) => setAccount(p.account),
    onPositionClosed: (p) => {
      void loadPositions()
      void loadAccount()
      void loadBots()
      pushToast(p.position.pnl && p.position.pnl >= 0 ? 'success' : 'danger', `${p.position.asset} ${p.position.side} settled ${p.position.pnl && p.position.pnl >= 0 ? '+' : ''}$${(p.position.pnl ?? 0).toFixed(2)}`)
    },
    onAlert: (p) => {
      setAlerts((prev) => [p, ...prev].slice(0, 40))
      pushToast(p.level, p.message)
    },
    onUi: (p) => {
      if (p.event === 'asset-changed' && p.asset) setAsset(p.asset)
    },
  })

  const activeAsset = assets.find((a) => a.ticker === asset)
  const patterns = analysis?.patterns ?? []

  const livePrice = prices[asset]?.price ?? activeAsset?.price ?? 0

  // copilot ui commands - the agent can drive the workspace
  const applyUiCommand = useCallback(
    (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'set_asset':
          if (typeof args?.asset === 'string') handleSelectAsset(args.asset)
          break
        case 'set_tf':
          if (typeof args?.tf === 'string') setTf(args.tf as Timeframe)
          break
        case 'set_chart_type':
          if (typeof args?.chartType === 'string') setChartType(args.chartType as ChartType)
          break
        case 'add_indicator': {
          const id = String(args?.id ?? '')
          if (!id) break
          const def = registry.find((r) => r.id === id)
          const pane = (typeof args?.pane === 'string' ? args.pane : def?.pane) ?? 'overlay'
          const params = (args?.params as Record<string, number> | undefined) ?? undefined
          if (pane === 'sub') setActiveSubs((prev) => (prev.some((o) => o.id === id) ? prev : [...prev, { id, params }]))
          else setActiveOverlays((prev) => [...prev.filter((o) => o.id !== id), { id, params }])
          break
        }
        case 'remove_indicator': {
          const id = String(args?.id ?? '')
          if (!id) break
          setActiveOverlays((prev) => prev.filter((o) => o.id !== id))
          setActiveSubs((prev) => prev.filter((o) => o.id !== id))
          break
        }
        case 'clear_indicators':
          setActiveOverlays([])
          setActiveSubs([])
          break
      }
    },
    [handleSelectAsset, registry]
  )

  // shared chart workspace (chart + sub-panes) - mounted by whichever layout is active
  const chartWorkspace = (
    <>
      <div className="min-h-[280px] flex-1">
        <ChartPanel candles={candles} analysis={analysis} price={livePrice} digitsTicker={asset} chartType={chartType} overlays={overlaySeries} positions={positions} settledPositions={history} />
      </div>
      {activeSubs.map((s) => (
        <SubPane
          key={`${s.id}:${JSON.stringify(s.params ?? {})}`}
          id={s.id}
          asset={asset}
          tf={tf}
          params={s.params}
          onRemove={() => setActiveSubs((prev) => prev.filter((x) => x.id !== s.id))}
        />
      ))}
    </>
  )

  const ticket = (
    <TradeTicket
      asset={activeAsset}
      tf={tf}
      price={livePrice}
      account={account}
      onPlaced={() => void loadPositions()}
      onError={(m) => pushToast('danger', m)}
    />
  )

  const copilot = (
    <Copilot
      session="default"
      asset={asset}
      tf={tf}
      chartType={chartType}
      overlays={activeOverlays.map((o) => o.id)}
      subs={activeSubs.map((o) => o.id)}
      onUiCommand={applyUiCommand}
    />
  )

  // slim drag handles: vertical bar for horizontal groups, horizontal bar for vertical groups
  const vHandle = (
    <PanelResizeHandle className="group relative h-full w-2 rounded transition-colors hover:bg-cyan-500/10 data-[resize-handle-state=drag]:bg-cyan-500/20">
      <div className="absolute left-1/2 top-1/2 h-10 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1c2739] transition-colors group-hover:bg-cyan-400/70 group-data-[resize-handle-state=drag]:bg-cyan-400" />
    </PanelResizeHandle>
  )
  const hHandle = (
    <PanelResizeHandle className="group relative h-2 w-full rounded transition-colors hover:bg-cyan-500/10 data-[resize-handle-state=drag]:bg-cyan-500/20">
      <div className="absolute left-1/2 top-1/2 h-[3px] w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1c2739] transition-colors group-hover:bg-cyan-400/70 group-data-[resize-handle-state=drag]:bg-cyan-400" />
    </PanelResizeHandle>
  )

  return (
    <div className="flex h-screen min-h-screen flex-col overflow-hidden bg-[#070b12] text-[#dbe4f0]">
      <MenuBar
        assets={assets}
        asset={asset}
        tf={tf}
        chartType={chartType}
        registrySize={registry.length}
        account={account}
        risk={risk}
        mode={osMode}
        onSelectAsset={handleSelectAsset}
        onSelectTf={setTf}
        onChartTypeChange={setChartType}
        onOpenPicker={() => setPickerOpen(true)}
        onModeChanged={(m) => {
          setModeStatus((s) => (s ? { ...s, mode: m } : s))
          void loadMode()
        }}
        onRiskChanged={setRisk}
        onAccountChanged={setAccount}
        onError={(m) => pushToast('danger', m)}
      />

      {bootLine < BOOT_MSGS.length ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="w-72 space-y-1.5 font-mono text-[12px]">
            {BOOT_MSGS.slice(0, bootLine + 1).map((m, i) => (
              <div key={i} className="flex items-center gap-2 text-emerald-400">
                <span className="text-[#4b5a72]">[{String(i).padStart(2, '0')}]</span> {m}
              </div>
            ))}
            <div className="mt-3 h-1 w-full overflow-hidden rounded bg-[#101828]">
              <div className="h-full bg-cyan-500 transition-all duration-300" style={{ width: `${(bootLine / BOOT_MSGS.length) * 100}%` }} />
            </div>
          </div>
        </div>
      ) : !isDesktop ? (
        /* ---------- MOBILE / TABLET: single scrollable column ---------- */
        <main className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
          <div className="flex h-[340px] shrink-0 flex-col">{chartWorkspace}</div>
          <div className="h-[420px] shrink-0">
            <BottomTabs
              asset={asset}
              tf={tf}
              positions={positions}
              history={history}
              alerts={alerts}
              patterns={patterns}
              assets={assets}
              strategies={strategies}
              bots={bots}
              price={livePrice}
              prices={prices}
              modeStatus={modeStatus}
              refreshMode={loadMode}
              refreshPositions={loadPositions}
              refreshBots={loadBots}
              refreshAccount={loadAccount}
              onSelectSetup={handleSelectSetup}
              onError={(m) => pushToast('danger', m)}
            />
          </div>
          {analysis && (
            <>
              <SignalPanel analysis={analysis} />
              <MarkovPanel markov={analysis.markov} />
              <QuantPanel analysis={analysis} />
            </>
          )}
          {ticket}
          <div className="h-[420px] shrink-0">{copilot}</div>
        </main>
      ) : (
        /* ---------- DESKTOP: fully resizable 3-dock workspace ---------- */
        <main className="min-h-0 flex-1 p-2">
          <PanelGroup direction="horizontal" autoSaveId="iqos:docks" className="h-full">
            {/* LEFT dock: market watch / indicators */}
            <Panel defaultSize={17} minSize={11}>
              <PanelGroup direction="vertical" autoSaveId="iqos:left" className="h-full">
                <Panel defaultSize={46} minSize={15}>
                  <div className="mr-0.5 h-full min-h-0">
                    <MarketWatch assets={assets} active={asset} prices={prices} onSelect={handleSelectAsset} />
                  </div>
                </Panel>
                {hHandle}
                <Panel defaultSize={54} minSize={20}>
                  <div className="ml-0.5 h-full min-h-0">
                    <IndicatorPanel analysis={analysis} />
                  </div>
                </Panel>
              </PanelGroup>
            </Panel>

            {vHandle}

            {/* CENTER dock: chart + analytics + bottom workspace */}
            <Panel defaultSize={56} minSize={32}>
              <div className="flex h-full min-h-0 flex-col gap-2 px-0.5">
                <div className="flex min-h-0 flex-[3] flex-col gap-1.5">{chartWorkspace}</div>
                <div className="grid h-[240px] shrink-0 grid-cols-2 grid-rows-[minmax(0,1fr)] gap-2 overflow-hidden">
                  <SignalPanel analysis={analysis} />
                  <MarkovPanel markov={analysis?.markov ?? null} />
                </div>
                <div className="h-[250px] shrink-0">
                  <BottomTabs
                    asset={asset}
                    tf={tf}
                    positions={positions}
                    history={history}
                    alerts={alerts}
                    patterns={patterns}
                    assets={assets}
                    strategies={strategies}
                    bots={bots}
                    price={livePrice}
                    prices={prices}
                    modeStatus={modeStatus}
                    refreshMode={loadMode}
                    refreshPositions={loadPositions}
                    refreshBots={loadBots}
                    refreshAccount={loadAccount}
                    onSelectSetup={handleSelectSetup}
                    onError={(m) => pushToast('danger', m)}
                  />
                </div>
              </div>
            </Panel>

            {vHandle}

            {/* RIGHT dock: trade ticket / copilot */}
            <Panel defaultSize={27} minSize={16}>
              <PanelGroup direction="vertical" autoSaveId="iqos:right" className="h-full">
                <Panel defaultSize={54} minSize={22}>
                  <div className="ml-0.5 h-full min-h-0 overflow-y-auto">{ticket}</div>
                </Panel>
                {hHandle}
                <Panel defaultSize={46} minSize={22}>
                  <div className="mt-0.5 h-full min-h-0">{copilot}</div>
                </Panel>
              </PanelGroup>
            </Panel>
          </PanelGroup>
        </main>
      )}

      {/* indicator registry picker */}
      <IndicatorPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        registry={registry}
        activeOverlays={activeOverlays.map((o) => o.id)}
        activeSubs={activeSubs.map((o) => o.id)}
        onAddOverlay={(id, params) => setActiveOverlays((prev) => [...prev.filter((o) => o.id !== id), { id, params }])}
        onAddSub={(id, params) => setActiveSubs((prev) => (prev.some((o) => o.id === id) ? prev : [...prev, { id, params }]))}
        onRemoveOverlay={(id) => setActiveOverlays((prev) => prev.filter((o) => o.id !== id))}
        onRemoveSub={(id) => setActiveSubs((prev) => prev.filter((o) => o.id !== id))}
      />

      {/* status bar */}
      <footer className="flex items-center justify-between border-t border-[#1c2739] bg-[#080d16] px-3 py-1 font-mono text-[9px] text-[#4b5a72]">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-rose-500 animate-pulse'}`} />
            kernel :3030 {connected ? 'streaming' : 'reconnecting…'}
          </span>
          <span>{assets.length} instruments · {registry.length || 103} indicators · binary/turbo/digital/cfd</span>
          <span className="hidden sm:inline">markov · montecarlo · hurst · garch · kalman-ou · 35 patterns · 11 strategies · 11 tfs</span>
          {bots.some((b) => b.bot.enabled) && (
            <span className="flex items-center gap-1 text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              autopilot: {bots.filter((b) => b.bot.enabled).length} armed
            </span>
        )}
          {osMode === 'auto' ? (
            <span className="flex items-center gap-1 animate-pulse font-bold text-amber-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              no-human mode: OS trading autonomously
            </span>
          ) : (
            <span className="flex items-center gap-1 text-cyan-500">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-600" />
              human-in-the-loop
            </span>
          )}
          {screenerLive > 0 && (
            <span className="flex items-center gap-1 text-cyan-400">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
              screener: {screenerLive} pairs live
            </span>
          )}
          {sentinelArmed && (
            <span className="flex items-center gap-1 animate-pulse text-rose-400">
              <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
              sentinel: breaker tripped
            </span>
          )}
          {watchdogStopped > 0 && (
            <span className="flex items-center gap-1 animate-pulse text-amber-400">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              watchdog: {watchdogStopped} bot{watchdogStopped === 1 ? '' : 's'} held
            </span>
          )}
          {archiveBars > 0 && (
            <span className="flex items-center gap-1 text-violet-400">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
              archive: {archiveBars > 1_000_000 ? `${(archiveBars / 1_000_000).toFixed(1)}M` : `${Math.round(archiveBars / 1000)}k`} bars
            </span>
          )}
        </div>
        <span className="hidden md:inline">unofficial · practice balance by default · not affiliated with IQ Option</span>
      </footer>
    </div>
  )
}
