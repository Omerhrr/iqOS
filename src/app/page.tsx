'use client'

// IQAIR//OS - main shell
// Single-page operating system: menu bar, market watch, chart workspace,
// analytics dock, trade ticket, copilot and the bottom workspace tabs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  Candle,
  ChartType,
  IndicatorSeries,
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
  'registry: 101 indicators · 35 candlestick + chart patterns armed',
  'analytics: markov + montecarlo engines fitted',
  'execution: binary · turbo · digital · cfd broker + risk manager ready',
  'IQAIR//OS ready',
]

interface ActiveIndicator {
  id: string
  params?: Record<string, number>
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

  const pushToast = useCallback((level: AlertRow['level'], message: string) => {
    if (level === 'success') toast.success(message)
    else if (level === 'danger') toast.error(message)
    else if (level === 'warn') toast.warning(message)
    else toast.message(message)
  }, [])

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

  // initial load
  useEffect(() => {
    void loadAssets()
    void loadAccount()
    void loadPositions()
    void osGet<{ ok: boolean; strategies: StrategyInfo[] }>('/strategies').then((d) => {
      if (d.ok) setStrategies(d.strategies)
    })
    void osGet<{ ok: boolean; indicators: RegistryEntry[] }>('/indicators').then((d) => {
      if (d.ok) setRegistry(d.indicators)
    })
    void osGet<{ ok: boolean; alerts: AlertRow[] }>('/alerts').then((d) => {
      if (d.ok) setAlerts(d.alerts.slice(0, 40))
    })
  }, [loadAssets, loadAccount, loadPositions])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return (
    <div className="flex h-screen min-h-screen flex-col overflow-hidden bg-[#070b12] text-[#dbe4f0]">
      <MenuBar
        assets={assets}
        asset={asset}
        tf={tf}
        account={account}
        risk={risk}
        onSelectAsset={handleSelectAsset}
        onSelectTf={setTf}
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
      ) : (
        <main className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-y-auto p-2 lg:grid-cols-[220px_1fr_320px] lg:overflow-hidden xl:grid-cols-[240px_1fr_360px]">
          {/* LEFT: watch + indicators */}
          <aside className="hidden min-h-0 flex-col gap-2 lg:flex">
            <div className="min-h-0 flex-[3]">
              <MarketWatch assets={assets} active={asset} prices={prices} onSelect={handleSelectAsset} />
            </div>
            <div className="min-h-0 flex-[4]">
              <IndicatorPanel analysis={analysis} />
            </div>
          </aside>

          {/* CENTER: chart + bottom workspace */}
          <section className="flex min-h-0 flex-col gap-2">
            <div className="flex min-h-[320px] flex-[3] flex-col gap-1.5 lg:min-h-0">
              <div className="min-h-[280px] flex-1">
                <ChartPanel
                  candles={candles}
                  analysis={analysis}
                  price={prices[asset]?.price ?? activeAsset?.price ?? 0}
                  digitsTicker={asset}
                  chartType={chartType}
                  onChartTypeChange={setChartType}
                  overlays={overlaySeries}
                  registrySize={registry.length}
                  onOpenPicker={() => setPickerOpen(true)}
                />
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
            </div>
            <div className="flex h-[260px] flex-col lg:h-[300px]">
              <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 xl:grid-cols-[1fr_360px]">
                <div className="hidden min-h-0 xl:block">
                  <SignalPanel analysis={analysis} />
                </div>
                <div className="hidden min-h-0 xl:block">
                  <MarkovPanel markov={analysis?.markov ?? null} />
                </div>
              </div>
              <div className="mt-2 hidden justify-center gap-2 xl:hidden">
                {/* mobile summary strip */}
                {analysis && (
                  <div className="flex w-full gap-2 overflow-x-auto font-mono text-[10px]">
                    <MiniStat label="Signal" value={analysis.signal.direction.toUpperCase()} color={analysis.signal.direction === 'call' ? '#10b981' : analysis.signal.direction === 'put' ? '#f43f5e' : '#eab308'} />
                    <MiniStat label="Score" value={analysis.signal.score.toFixed(0)} />
                    <MiniStat label="Markov P(up)" value={`${(analysis.markov.probUp * 100).toFixed(0)}%`} color="#38bdf8" />
                    <MiniStat label="Regime" value={analysis.markov.regime.toUpperCase()} />
                    <MiniStat label="Hurst" value={analysis.quant.hurst.toFixed(2)} />
                  </div>
                )}
              </div>
            </div>
            <div className="min-h-[220px] flex-[2]">
              <BottomTabs
                asset={asset}
                tf={tf}
                positions={positions}
                history={history}
                alerts={alerts}
                patterns={patterns}
                assets={assets}
                strategies={strategies}
                price={prices[asset]?.price ?? activeAsset?.price ?? 0}
                prices={prices}
                refreshPositions={loadPositions}
                onError={(m) => pushToast('danger', m)}
              />
            </div>
          </section>

          {/* RIGHT: quant + ticket + copilot */}
          <aside className="hidden min-h-0 flex-col gap-2 overflow-y-auto lg:flex">
            <TradeTicket
              asset={activeAsset}
              tf={tf}
              price={prices[asset]?.price ?? activeAsset?.price ?? 0}
              account={account}
              onPlaced={() => void loadPositions()}
              onError={(m) => pushToast('danger', m)}
            />
            <div className="min-h-[260px]">
              <Copilot session="default" />
            </div>
          </aside>

          {/* mobile-only secondary panels */}
          <div className="space-y-2 lg:hidden">
            {analysis && (
              <>
                <SignalPanel analysis={analysis} />
                <MarkovPanel markov={analysis.markov} />
                <QuantPanel analysis={analysis} />
              </>
            )}
            <TradeTicket
              asset={activeAsset}
              tf={tf}
              price={prices[asset]?.price ?? activeAsset?.price ?? 0}
              account={account}
              onPlaced={() => void loadPositions()}
              onError={(m) => pushToast('danger', m)}
            />
            <div className="h-[420px]">
              <Copilot session="default" />
            </div>
          </div>
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
          <span>{assets.length} instruments · {registry.length || 101} indicators · binary/turbo/digital/cfd</span>
          <span className="hidden sm:inline">markov · montecarlo · hurst · garch · 35 patterns · 10 strategies · 11 tfs</span>
        </div>
        <span className="hidden md:inline">unofficial · practice balance by default · not affiliated with IQ Option</span>
      </footer>
    </div>
  )
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="whitespace-nowrap rounded border border-[#1c2739] bg-[#0b111c] px-2 py-1">
      <span className="text-[#4b5a72]">{label} </span>
      <span style={{ color: color ?? '#aab6cc' }}>{value}</span>
    </div>
  )
}
