// IQAIR//OS - trading-core service
// Boots the kernel (store -> market-data -> analytics -> execution), then serves
// REST for every OS operation and socket.io for the real-time event feed.
// Port 3030. Path '/' is fixed for the Caddy gateway.

import { createServer } from 'http'
import { Server } from 'socket.io'
import { Kernel } from './src/kernel'
import { storePlugin } from './src/plugins/store'
import { osModePlugin, ModeService, type OsMode } from './src/plugins/os-mode'
import { memoryGatePlugin } from './src/plugins/memory-gate'
import { marketDataPlugin, MarketDataService } from './src/plugins/market-data'
import { analyticsPlugin, AnalyticsService } from './src/plugins/analytics'
import { executionPlugin, ExecutionService, type RiskConfig } from './src/plugins/execution'
import { autopilotPlugin, AutopilotService, type BotConfig } from './src/plugins/autopilot'
import { labPlugin, StrategyLabService } from './src/plugins/lab'
import { screenerPlugin, ScreenerService } from './src/plugins/screener'
import { alertRulesPlugin, AlertRulesService, ALERT_METRICS } from './src/plugins/alert-rules'
import { sentinelPlugin, SentinelService, type SentinelConfig } from './src/plugins/sentinel'
import { watchdogPlugin, WatchdogService, type WatchdogConfig } from './src/plugins/watchdog'
import { adaptivePlugin, AdaptiveService, type AdaptiveConfig } from './src/plugins/adaptive'
import { gridSearch, walkForward, sweepAssets, type Objective } from './src/strategies/optimize'
import { vskMonteCarlo } from './src/analytics/vsk'
import { tskMonteCarlo } from './src/analytics/tsk'
import { ALL_TIMEFRAMES, type Timeframe } from './src/types'
import { searchInstruments, UNIVERSE_STATS, getInstrument } from './src/universe'
import { listRegistry, computeIndicator, registrySize, getIndicatorDef } from './src/analytics/registry'
import { detectChartPatterns } from './src/analytics/chart-patterns'
import { buildCalibrationReport, type CalibrationStoreSlice } from './src/analytics/calibration'

// Defaults to 3030 for local/Windows dev; the Docker deployment overrides
// this to an unusual, hard-to-collide-with port via the KERNEL_PORT env var.
const PORT = Number(process.env.KERNEL_PORT ?? 3030)

const kernel = new Kernel()
kernel.register(storePlugin)
kernel.register(osModePlugin)
kernel.register(memoryGatePlugin)
kernel.register(marketDataPlugin)
kernel.register(analyticsPlugin)
kernel.register(executionPlugin)
kernel.register(labPlugin)
kernel.register(autopilotPlugin)
kernel.register(screenerPlugin)
kernel.register(alertRulesPlugin)
kernel.register(sentinelPlugin)
kernel.register(watchdogPlugin)
kernel.register(adaptivePlugin)

const httpServer = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const q = url.searchParams
  let body: Record<string, unknown> = {}
  if (req.method === 'POST') {
    const chunks: Uint8Array[] = []
    for await (const chunk of req) chunks.push(chunk as Uint8Array)
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
    } catch {
      body = {}
    }
  }

  const json = (code: number, data: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const tf = (name: string | null): Timeframe => {
    const v = (name ?? '1m') as Timeframe
    return (ALL_TIMEFRAMES as string[]).includes(v) ? v : '1m'
  }

  try {
    const market = kernel.context().use<MarketDataService>('market')
    const analytics = kernel.context().use<AnalyticsService>('analytics')
    const exec = kernel.context().use<ExecutionService>('execution')

    if (req.method === 'GET') {
      if (path === '/health') return json(200, { ok: true, service: 'trading-core', uptime: process.uptime() })

      if (path === '/mode') {
        const mode = kernel.context().use<ModeService>('mode')
        return json(200, { ok: true, ...mode.status() })
      }

      if (path === '/assets') {
        // IQ mode serves the IQ ACCOUNT'S OWN asset list from the authenticated
        // session metadata - the sim universe must never leak into it. The
        // metadata fetch can take IQ ~90s - kick it in the background and
        // serve the cached rows (the UI re-polls until the table lands).
        if (exec.accountSource === 'iq') {
          void market.ensureSidecarAssets()
          return json(200, { ok: true, source: 'iq', assets: market.iqAssetRows(), mode: market.mode, activeAsset: market.activeAsset })
        }
        return json(200, { ok: true, source: 'paper', assets: market.listAssets(), mode: market.mode, activeAsset: market.activeAsset })
      }

      if (path === '/live/status') {
        const account = exec.account()
        const onIQ = exec.accountSource === 'iq'
        return json(200, {
          ok: true,
          mode: market.mode,
          liveUrl: market.liveUrl,
          liveReady: exec.liveReady,
          source: exec.accountSource,
          // the balance shown must match the ACTIVE source - paper shows the
          // paper ledger even when a warm IQ session exists alongside it
          balance: onIQ ? (account.liveBalance ?? account.balance) : account.balance,
          balanceMode: onIQ ? account.balanceMode : 'PAPER',
          simBalance: account.balance,
        })
      }

      if (path === '/instruments') {
        const cat = (q.get('category') ?? 'all') as 'all' | 'otc' | 'forex' | 'crypto' | 'commodity' | 'stock' | 'index'
        const search = (q.get('q') ?? '').toLowerCase()
        // IQ-mode search normalizes IQ ticker shapes: dashes, colons, spaces
        // and underscores are ignored, the -OTC suffix is optional, and a
        // subsequence match catches partial typing ("eurjp" -> EURJPY-OTC).
        const norm = (s: string) => s.toLowerCase().replace(/[-_:\s.]/g, '')
        const subseq = (needle: string, hay: string) => {
          let i = 0
          for (const ch of hay) if (ch === needle[i]) i++
          return i === needle.length
        }
        const matchIQ = (a: { ticker: string; name: string; otc: boolean }, raw: string) => {
          const q = norm(raw)
          if (!q) return true
          const wantsOtc = /\botc\b/.test(raw)
          const base = norm(a.ticker.replace(/-OTC$/, ''))
          const full = norm(a.ticker)
          const nameN = norm(a.name)
          const qBase = norm(raw.replace(/\botc\b/g, ''))
          if (wantsOtc && !a.otc) return false
          if (qBase && !(base.startsWith(qBase) || full.startsWith(qBase) || nameN.startsWith(qBase) || base.includes(qBase) || nameN.includes(qBase) || subseq(qBase, base) || subseq(qBase, nameN))) return false
          return true
        }
        // IQ mode: the connected account's own instruments ONLY (its own
        // tickers, incl. weekend OTC) - not a filtered sim universe.
        if (exec.accountSource === 'iq' || q.get('iq') === '1') {
          void market.ensureSidecarAssets()
          let rows = market.iqAssetRows()
          if (cat !== 'all') rows = rows.filter((a) => (cat === 'otc' ? a.otc : a.category === cat))
          if (search) rows = rows.filter((a) => matchIQ(a, search))
          return json(200, { ok: true, instruments: rows, stats: UNIVERSE_STATS })
        }
        market.refreshSchedules()
        const found = searchInstruments(search, cat)
        return json(200, {
          ok: true,
          instruments: found.map((a) => ({ ...a, price: market.getPrice(a.ticker) || a.basePrice, iq: market.isIQAvailable(a.ticker) })),
          stats: UNIVERSE_STATS,
        })
      }

      if (path === '/indicators') {
        return json(200, { ok: true, indicators: listRegistry(), stats: { total: registrySize() } })
      }

      if (path === '/indicator') {
        const id = q.get('id') ?? 'rsi'
        const def = getIndicatorDef(id)
        if (!def) return json(404, { ok: false, error: `unknown indicator ${id}` })
        const asset = q.get('asset') ?? market.activeAsset
        const timeframe = tf(q.get('tf'))
        const params: Record<string, number> = {}
        for (const [k, v] of q.entries()) if (k.startsWith('p_')) params[k.slice(2)] = Number(v)
        const candles = market.getCandles(asset, timeframe, 400)
        const res = computeIndicator(id, candles, params)
        if (!res) return json(404, { ok: false, error: 'compute failed' })
        const time = candles.map((c) => c.time)
        const nz = (v: number) => (Number.isFinite(v) ? v : null)
        return json(200, {
          ok: true,
          series: {
            id: def.id,
            name: def.name,
            category: def.category,
            pane: def.pane,
            params: Object.fromEntries(def.params.map((pp) => [pp.key, params[pp.key] ?? pp.default])),
            time,
            lines: res.output.lines.map((ln) => ({ key: ln.key, color: ln.color, style: ln.style, width: ln.width, values: ln.values.map(nz) })),
            markers: res.output.markers?.map((m) => ({ time: m.time, position: m.position, shape: m.shape, color: m.color, text: m.text, size: m.size })),
            hist: res.output.hist ? { values: res.output.hist.values.map(nz), color: res.output.hist.color } : undefined,
            levels: res.output.levels,
            bands: res.output.bands,
            fillBetween: res.output.fillBetween,
            note: res.output.note,
          },
        })
      }

      if (path === '/chart_patterns') {
        const asset = q.get('asset') ?? market.activeAsset
        const timeframe = tf(q.get('tf'))
        const candles = market.getCandles(asset, timeframe, 400)
        return json(200, { ok: true, patterns: detectChartPatterns(candles) })
      }

      if (path === '/candles') {
        const asset = q.get('asset') ?? market.activeAsset
        const timeframe = tf(q.get('tf'))
        const limit = Math.min(Number(q.get('limit') ?? 400), 1000)
        return json(200, { ok: true, asset, tf: timeframe, candles: market.getCandles(asset, timeframe, limit), price: market.getPrice(asset) })
      }

      if (path === '/analysis') {
        const asset = q.get('asset') ?? market.activeAsset
        const timeframe = tf(q.get('tf'))
        const result = analytics.analyze(asset, timeframe, q.get('force') === '1')
        return json(200, { ok: true, analysis: result })
      }

      // rank a category by composite signal strength - the copilot's market scanner
      if (path === '/scan') {
        const cat = (q.get('category') ?? 'all') as 'all' | 'otc' | 'forex' | 'crypto' | 'commodity' | 'stock' | 'index'
        const timeframe = tf(q.get('tf'))
        const cap = Math.min(Number(q.get('limit') ?? 14), 24)
        const universe = searchInstruments('', cat)
          .filter((i) => i.open)
          .slice(0, cap)
        const rows: Record<string, unknown>[] = []
        const CHUNK = 5
        for (let i = 0; i < universe.length; i += CHUNK) {
          await Promise.all(
            universe.slice(i, i + CHUNK).map(async (inst) => {
              try {
                const a = analytics.analyze(inst.ticker, timeframe)
                rows.push({
                  asset: inst.ticker,
                  name: inst.name,
                  category: inst.category,
                  price: a.signal.price,
                  score: Math.round(a.signal.score * 10) / 10,
                  direction: a.signal.direction,
                  confidence: Math.round(a.signal.confidence),
                  pUp: Math.round(a.markov.probUp * 1000) / 1000,
                  regime: a.markov.regime,
                  rsi: Math.round(a.indicators.rsi * 10) / 10,
                  hurst: Math.round(a.quant.hurst * 100) / 100,
                })
              } catch {
                // insufficient candles - skip
              }
            })
          )
        }
        rows.sort((x, y) => Math.abs(Number(y.score)) - Math.abs(Number(x.score)))
        return json(200, { ok: true, tf: timeframe, scanned: universe.length, results: rows })
      }

      if (path === '/strategies')
        return json(200, {
          ok: true,
          strategies: [
            ...analytics.listStrategies(),
            // AI-learned specs from the Strategy Lab are first-class strategies
            ...kernel.context().use<StrategyLabService>('lab').list().map((r) => ({
              id: r.id,
              name: `${r.spec.name} (Lab)`,
              description: `${r.spec.description ?? 'AI-learned strategy'} [${r.asset} ${r.tf}]` +
                (r.stats?.backtest ? ` backtest ${r.stats.backtest.trades}t @ ${r.stats.backtest.winRate.toFixed(1)}%` : ''),
              params: [],
              defaults: {},
            })),
          ],
        })

      if (path === '/lab_list') {
        return json(200, { ok: true, strategies: kernel.context().use<StrategyLabService>('lab').list() })
      }

      if (path === '/lab_get') {
        const row = kernel.context().use<StrategyLabService>('lab').get(q.get('id') ?? '')
        return row ? json(200, { ok: true, strategy: row }) : json(404, { ok: false, error: 'lab strategy not found' })
      }

      // ---------- discovery: screener + alert rules ----------

      // ranked opportunity feed across the whole scanned universe
      if (path === '/screener') {
        const scr = kernel.context().use<ScreenerService>('screener')
        const direction = (q.get('direction') ?? 'all') as 'all' | 'call' | 'put'
        const out = scr.top({
          tf: q.get('tf') ? tf(q.get('tf')) : undefined,
          category: q.get('category') ?? 'all',
          direction: ['all', 'call', 'put'].includes(direction) ? direction : 'all',
          minScore: Number(q.get('minScore') ?? 0),
          q: q.get('q') ?? undefined,
          limit: Math.min(Number(q.get('limit') ?? 40), 200),
        })
        return json(200, { ok: true, tf: q.get('tf') ?? 'all', ...out })
      }

      if (path === '/screener_status') {
        const scr = kernel.context().use<ScreenerService>('screener')
        return json(200, { ok: true, status: scr.status(), config: scr.config })
      }

      if (path === '/alert_metrics') {
        return json(200, { ok: true, metrics: ALERT_METRICS })
      }

      if (path === '/alert_rules') {
        const rules = kernel.context().use<AlertRulesService>('alertrules')
        return json(200, { ok: true, rules: rules.listRules() })
      }

      // ---------- sentinel: risk governance ----------

      if (path === '/sentinel') {
        const sen = kernel.context().use<SentinelService>('sentinel')
        return json(200, { ok: true, ...sen.status() })
      }

      if (path === '/risk_events') {
        const store = kernel.context().use<{ listRiskEvents: (l?: number) => { ts: number; kind: string; message: string }[] }>('storeRaw')
        return json(200, { ok: true, events: store.listRiskEvents(60) })
      }

      // ---------- watchdog: strategy health ----------

      if (path === '/watchdog') {
        const wd = kernel.context().use<WatchdogService>('watchdog')
        return json(200, { ok: true, ...wd.status() })
      }

      // ---------- adaptive confidence gate ----------

      if (path === '/adaptive') {
        const ad = kernel.context().use<AdaptiveService>('adaptive')
        return json(200, { ok: true, ...ad.status() })
      }

      // Preview a bucket's realized record without placing anything - lets
      // the Autopilot panel show "this bot's setup is proven/unproven/failing"
      // before the operator even arms it.
      if (path === '/adaptive_bucket') {
        const ad = kernel.context().use<AdaptiveService>('adaptive')
        const asset = q.get('asset') ?? market.activeAsset
        const timeframe = String(q.get('tf') ?? '1m')
        const strategy = String(q.get('strategy') ?? 'confluence-core')
        const side = String(q.get('side') ?? 'call')
        const score = Number(q.get('score') ?? 60)
        const regime = q.get('regime') ?? undefined
        return json(200, { ok: true, verdict: ad.check(asset, timeframe, strategy, side, score, regime ?? undefined) })
      }

      // ---------- archive: deep history ----------

      if (path === '/archive') {
        const store = kernel.context().use<{ archiveStats: () => unknown }>('storeRaw')
        return json(200, { ok: true, stats: store.archiveStats() })
      }


      if (path === '/signal') {
        const asset = q.get('asset') ?? market.activeAsset
        const timeframe = tf(q.get('tf'))
        const a = analytics.analyze(asset, timeframe)
        return json(200, { ok: true, signal: a.signal })
      }

      if (path === '/positions') {
        const status = q.get('status') as 'open' | 'closed' | undefined
        return json(200, { ok: true, positions: store_list(status) })
      }

      if (path === '/account') {
        return json(200, { ok: true, account: exec.account(), risk: exec.risk, liveReady: exec.liveReady })
      }

      if (path === '/history') {
        const store = kernel.context().use<{ listPositions: (s?: 'open' | 'closed', l?: number) => unknown[] }>('storeRaw')
        const limit = Math.min(Number(q.get('limit') ?? 100), 500)
        return json(200, { ok: true, positions: store.listPositions('closed', limit) })
      }

      if (path === '/alerts') {
        const store = kernel.context().use<{ listAlerts: (l?: number) => unknown[] }>('storeRaw')
        return json(200, { ok: true, alerts: store.listAlerts(60) })
      }

      if (path === '/stats') {
        const store = kernel.context().use<{ stats: () => unknown }>('storeRaw')
        return json(200, { ok: true, stats: store.stats() })
      }

      if (path === '/chat') {
        const store = kernel.context().use<{ listChat: (s: string, l?: number) => unknown[] }>('storeRaw')
        const session = q.get('session') ?? 'default'
        return json(200, { ok: true, messages: store.listChat(session, 60).reverse() })
      }

      if (path === '/notes') {
        const store = kernel.context().use<{ listNotes: (q: string, l?: number) => unknown[] }>('storeRaw')
        const notes = store.listNotes(q.get('q') ?? '', Number(q.get('limit') ?? 30))
        return json(200, { ok: true, count: notes.length, notes })
      }

      if (path === '/memory_gate') {
        const mg = kernel.context().use<{ status: () => unknown }>('memoryGate')
        return json(200, { ok: true, ...(mg.status() as Record<string, unknown>) })
      }

      // ---------- autopilot fleet ----------

      if (path === '/bots') {
        const bots = kernel.context().use<AutopilotService>('autopilot')
        return json(200, {
          ok: true,
          bots: bots.listBots(),
          running: bots.runningCount(),
        })
      }

      // Compounding stake schedule (pure math, no state): pot_0 = base, each
      // win multiplies the pot by (1 + rollPct*payout), stake_n = rollPct% of
      // pot_n. PAYOUT IS CAPPED AT 70% no matter what the broker pays - the
      // engine folds in at most payoutCap of the stake, the excess is skimmed.
      // Periods bound the cycle (the Nth win completes it); a de-risk phase
      // (deriskAfter/deriskPct) wagers only a fraction of the pot afterwards.
      if (path === '/compound_plan') {
        const PAYOUT_CAP = 0.7
        const base = Math.max(1, Number(q.get('base') ?? 1) || 1)
        const rawPayout = Math.min(1, Math.max(0.01, Number(q.get('payout') ?? PAYOUT_CAP) || PAYOUT_CAP))
        const payout = Math.min(rawPayout, PAYOUT_CAP) // hard cap: compounding never assumes > 70%
        const rollPct = Math.min(100, Math.max(1, Number(q.get('rollPct') ?? 100) || 100))
        const steps = Math.min(30, Math.max(1, Math.round(Number(q.get('steps') ?? 10) || 10)))
        const maxStake = Number(q.get('maxStake') ?? 0) || undefined
        const periods = Math.min(100, Math.max(0, Math.round(Number(q.get('periods') ?? 0) || 0))) || undefined
        const deriskAfter = Math.min(99, Math.max(0, Math.round(Number(q.get('deriskAfter') ?? 0) || 0))) || undefined
        const deriskPctRaw = Number(q.get('deriskPct') ?? 0) || 0
        const deriskPct = deriskPctRaw > 0 ? Math.min(100, Math.max(1, deriskPctRaw)) : undefined
        const onComplete = q.get('onComplete') === 'reseed' ? 'reseed' : 'halt'
        const schedule: { n: number; pot: number; stake: number; phase: string; lossAt: number }[] = []
        let pot = base
        let hitCapAt: number | undefined
        let cycleProfit: number | undefined
        for (let n = 0; n < steps; n++) {
          const derisk = deriskAfter !== undefined && deriskPct !== undefined && n >= deriskAfter
          const pct = derisk ? deriskPct! : rollPct
          const stake = Math.min(maxStake ?? Infinity, (pot * pct) / 100)
          if (maxStake && stake >= maxStake && hitCapAt === undefined) hitCapAt = n
          schedule.push({ n, pot: Math.round(pot * 100) / 100, stake: Math.round(stake * 100) / 100, phase: derisk ? 'derisk' : 'compound', lossAt: 0 })
          if (periods && n + 1 >= periods) {
            // the (n+1)th win completes the cycle - fold it and stop the ladder
            pot += stake * payout
            cycleProfit = Math.round((pot - base) * 100) / 100
            break
          }
          pot += stake * payout
        }
        // lossAt: cumulative capital burned if the cycle dies at step n
        // (every stake 0..n was lost along the way)
        let cum = 0
        for (const s of schedule) {
          cum += s.stake
          s.lossAt = Math.round(cum * 100) / 100
        }
        return json(200, {
          ok: true,
          base,
          payout,
          rawPayout,
          payoutCap: PAYOUT_CAP,
          capped: rawPayout > PAYOUT_CAP,
          rollPct,
          steps: schedule.length,
          periods,
          deriskAfter,
          deriskPct,
          onComplete,
          growth: Math.round((1 + (rollPct * payout) / 100) * 10000) / 10000,
          schedule,
          hitCapAt,
          cycleProfit,
          stopOnLoss: true,
        })
      }

      if (path === '/journal') {
        const store = kernel.context().use<{ journal: (p?: string, l?: number) => unknown[]; stats: () => unknown }>('storeRaw')
        const scope = q.get('scope') ?? 'all' // all | bots | auto | manual
        let trades: {
          tsOpen: number
          tsClose?: number
          asset: string
          side: string
          kind: string
          strategy?: string
          amount: number
          pnl?: number
          status: string
          note?: string
        }[]
        if (scope === 'bots') trades = store.journal('bot:', 500) as typeof trades
        else if (scope === 'auto') trades = store.journal('auto:', 500) as typeof trades
        else if (scope === 'manual')
          trades = (store.journal(undefined, 800) as typeof trades).filter(
            (t) => !(t.note ?? '').startsWith('bot:') && !(t.note ?? '').startsWith('auto:')
          )
        else trades = store.journal(undefined, 500) as typeof trades
        const closed = trades.filter((t) => t.status === 'won' || t.status === 'lost')
        const wins = closed.filter((t) => t.status === 'won')
        const losses = closed.filter((t) => t.status === 'lost')
        const pnls = closed.map((t) => t.pnl ?? 0)
        const netPnl = pnls.reduce((a, b) => a + b, 0)
        const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0)
        const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0))
        const group = (keyOf: (t: (typeof closed)[number]) => string) => {
          const map = new Map<string, { trades: number; wins: number; pnl: number }>()
          for (const t of closed) {
            const k = keyOf(t) || 'unassigned'
            const g = map.get(k) ?? { trades: 0, wins: 0, pnl: 0 }
            g.trades += 1
            if (t.status === 'won') g.wins += 1
            g.pnl += t.pnl ?? 0
            map.set(k, g)
          }
          return [...map.entries()]
            .map(([key, g]) => ({ key, ...g, winRate: g.trades ? g.wins / g.trades : 0 }))
            .sort((a, b) => b.pnl - a.pnl)
        }
        // chronological equity curve
        let eq = 0
        const curve = closed
          .slice()
          .reverse()
          .map((t) => {
            eq += t.pnl ?? 0
            return { ts: t.tsClose ?? t.tsOpen, equity: Math.round(eq * 100) / 100 }
          })
        return json(200, {
          ok: true,
          scope,
          overall: {
            trades: closed.length,
            wins: wins.length,
            losses: losses.length,
            winRate: closed.length ? wins.length / closed.length : 0,
            netPnl: Math.round(netPnl * 100) / 100,
            profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 99 : 0,
            bestTrade: pnls.length ? Math.round(Math.max(...pnls) * 100) / 100 : 0,
            worstTrade: pnls.length ? Math.round(Math.min(...pnls) * 100) / 100 : 0,
            avgWin: wins.length ? Math.round((grossWin / wins.length) * 100) / 100 : 0,
            avgLoss: losses.length ? Math.round((grossLoss / losses.length) * 100) / 100 : 0,
          },
          curve,
          byStrategy: group((t) => t.strategy ?? ''),
          byOrigin: group((t) =>
            (t.note ?? '').startsWith('bot:') ? 'autopilot' : (t.note ?? '').startsWith('auto:') ? 'auto-trader' : 'manual'
          ),
          byAsset: group((t) => t.asset),
          byKind: group((t) => t.kind),
          bySide: group((t) => t.side),
          recent: trades.slice(-40).reverse(),
        })
      }

      if (path === '/calibration') {
        const store = kernel.context().use<CalibrationStoreSlice>('storeRaw')
        const report = buildCalibrationReport(store, {
          asset: q.get('asset') ?? undefined,
          strategyId: q.get('strategy') ?? undefined,
          limit: q.get('limit') ? Number(q.get('limit')) : undefined,
        })
        return json(200, { ok: true, ...report })
      }

      // research gate status: one (asset, tf, strategy) verdict, or every
      // saved verdict when no query params are given (powers the
      // Autopilot panel's per-instrument gate badges).
      if (path === '/validation') {
        const store = kernel.context().use<{
          latestValidation: (asset: string, tf: string, strategyId: string) => unknown
          listLatestValidations: () => unknown[]
        }>('storeRaw')
        const asset = q.get('asset')
        const tfParam = q.get('tf')
        const strategyId = q.get('strategy')
        if (asset && tfParam && strategyId) {
          const v = store.latestValidation(asset, tfParam, strategyId)
          return json(200, { ok: true, validation: v })
        }
        return json(200, { ok: true, validations: store.listLatestValidations() })
      }
    }

    if (req.method === 'POST') {
      // Walk-forward validation of the Kalman/OU edge on one instrument.
      // Also primes the auto-trader's requireValidation verdict cache.
      if (path === '/ou_validate') {
        const mode = kernel.context().use<ModeService>('mode')
        const asset = String(body.asset ?? market.activeAsset)
        const tfv = tf(String(body.tf ?? '1m') as string)
        try {
          const verdict = await mode.validateOU(asset, tfv)
          return json(200, { ok: true, verdict })
        } catch (err) {
          return json(400, { ok: false, error: (err as Error).message })
        }
      }

      if (path === '/asset') {
        const asset = String(body.asset ?? '')
        // IQ mode: the switch target must be an IQ-account instrument; the
        // sim universe is irrelevant here. No synthetic seeding - pollLive
        // materializes the real candles on the next tick.
        if (exec.accountSource === 'iq') {
          void market.ensureSidecarAssets()
          // reject only when the IQ instrument table is LOADED and the ticker
          // is not on it - before the first (slow) metadata fetch everything
          // is passable, the sidecar validates trades authoritatively anyway
          if (market.iqAssetCount > 0 && !market.isIQAsset(asset)) return json(400, { ok: false, error: `${asset} is not available on this IQ account` })
          market.activeAsset = asset
          market.refreshActiveLive()
          io.emit('ui', { event: 'asset-changed', asset })
          return json(200, { ok: true, activeAsset: asset })
        }
        if (!market.assets.some((a) => a.ticker === asset)) return json(400, { ok: false, error: `unknown asset ${asset}` })
        market.activeAsset = asset
        market.ensureSeeded(asset)
        market.refreshActiveLive() // live mode: pull real candles for the new asset now
        io.emit('ui', { event: 'asset-changed', asset })
        return json(200, { ok: true, activeAsset: asset })
      }

      // ---------- research: optimizer / walk-forward / asset sweep ----------

      // deep reads: archived bars + live tail (up to 2200) so validation sees
      // the full accumulated history, not just the seeded window
      if (path === '/optimize') {
        const out = gridSearch(market.getCandlesDeep(String(body.asset ?? market.activeAsset), tf(String(body.tf ?? '1m') as string), 2200), String(body.asset ?? market.activeAsset), tf(String(body.tf ?? '1m') as string), {
          strategy: String(body.strategy ?? 'confluence-core'),
          sweep: (body.sweep as Record<string, { from: number; to: number; step: number }>) ?? {},
          objective: (body.objective as Objective) ?? 'netPnl',
          minTrades: body.minTrades !== undefined ? Number(body.minTrades) : 8,
          maxCombos: body.maxCombos !== undefined ? Number(body.maxCombos) : 240,
          top: body.top !== undefined ? Number(body.top) : 20,
          payout: body.payout !== undefined ? Number(body.payout) : 0.85,
          amount: body.amount !== undefined ? Number(body.amount) : 10,
          expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : 1,
          startEquity: body.startEquity !== undefined ? Number(body.startEquity) : 1000,
        })
        return json(200, { ok: true, result: out })
      }

      if (path === '/walkforward') {
        const out = walkForward(market.getCandlesDeep(String(body.asset ?? market.activeAsset), tf(String(body.tf ?? '1m') as string), 2200), String(body.asset ?? market.activeAsset), tf(String(body.tf ?? '1m') as string), {
          strategy: String(body.strategy ?? 'rsi-reversion'),
          sweep: (body.sweep as Record<string, { from: number; to: number; step: number }>) ?? {},
          objective: (body.objective as Objective) ?? 'netPnl',
          minTrades: body.minTrades !== undefined ? Number(body.minTrades) : 6,
          maxCombos: body.maxCombos !== undefined ? Number(body.maxCombos) : 120,
          folds: body.folds !== undefined ? Number(body.folds) : 3,
          isRatio: body.isRatio !== undefined ? Number(body.isRatio) : 0.7,
          payout: body.payout !== undefined ? Number(body.payout) : 0.85,
          amount: body.amount !== undefined ? Number(body.amount) : 10,
          expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : 1,
          startEquity: body.startEquity !== undefined ? Number(body.startEquity) : 1000,
        })
        // Persist the verdict so the research-gate (bot_create/bot_toggle) can
        // require a recent robust pass before arming a bot on this
        // (asset, tf, strategy) - same grading rubric as the kalman-ou
        // auto-trader's requireValidation check in os-mode.ts: robust = OOS
        // net positive, >=2/3 folds profitable, >=25% IS->OOS efficiency and
        // enough OOS trades to trust it; weak = profitable but not
        // convincing; failed = anything else.
        const verdict: 'robust' | 'weak' | 'failed' =
          out.oos.netPnl > 0 && out.foldsProfitable >= Math.ceil(out.folds.length * (2 / 3)) && out.efficiencyPct >= 25 && out.oos.totalTrades >= 10
            ? 'robust'
            : out.oos.netPnl > 0 && out.foldsProfitable >= 1
              ? 'weak'
              : 'failed'
        try {
          const vstore = kernel.context().use<{
            saveValidation: (v: {
              asset: string
              tf: string
              strategyId: string
              params: Record<string, number | string>
              verdict: 'robust' | 'weak' | 'failed'
              oosNet: number
              isNet: number
              winRate: number
              efficiencyPct: number
              folds: number
              foldsProfitable: number
              totalTrades: number
            }) => void
          }>('storeRaw')
          vstore.saveValidation({
            asset: String(body.asset ?? market.activeAsset),
            tf: String(body.tf ?? '1m'),
            strategyId: String(body.strategy ?? 'rsi-reversion'),
            params: out.bestParams,
            verdict,
            oosNet: Math.round(out.oos.netPnl * 100) / 100,
            isNet: Math.round(out.isNet * 100) / 100,
            winRate: Math.round(out.oos.winRate * 10) / 10,
            efficiencyPct: Math.round(out.efficiencyPct * 10) / 10,
            folds: out.folds.length,
            foldsProfitable: out.foldsProfitable,
            totalTrades: out.oos.totalTrades,
          })
        } catch (err) {
          console.error('[research] saveValidation failed:', (err as Error).message)
        }
        return json(200, { ok: true, result: out, verdict })
      }

      if (path === '/asset_sweep') {
        const wanted = Array.isArray(body.assets) ? (body.assets as string[]) : null
        const category = body.category ? String(body.category) : null
        let pool = market.assets
        if (wanted && wanted.length) pool = pool.filter((a) => wanted.includes(a.ticker))
        else if (category && category !== 'all') pool = pool.filter((a) => (category === 'otc' ? a.otc : a.category === category))
        const openOnly = body.openOnly === undefined ? true : Boolean(body.openOnly)
        if (openOnly) pool = pool.filter((a) => a.open)
        const out = sweepAssets(
          pool.map((a) => ({ ticker: a.ticker, category: a.category, open: a.open, payout: a.payout })),
          (asset) => market.getCandlesDeep(asset, tf(String(body.tf ?? '1m') as string), 1200),
          tf(String(body.tf ?? '1m') as string),
          {
            strategy: String(body.strategy ?? 'confluence-core'),
            params: (body.params as Record<string, number | string>) ?? undefined,
            objective: (body.objective as Objective) ?? 'netPnl',
            minTrades: body.minTrades !== undefined ? Number(body.minTrades) : 8,
            payout: body.payout !== undefined ? Number(body.payout) : 0.85,
            amount: body.amount !== undefined ? Number(body.amount) : 10,
            expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : 1,
            startEquity: body.startEquity !== undefined ? Number(body.startEquity) : 1000,
            maxAssets: body.maxAssets !== undefined ? Number(body.maxAssets) : 40,
          }
        )
        return json(200, { ok: true, result: out })
      }

      if (path === '/backtest') {
        const result = analytics.runBacktest(String(body.asset ?? market.activeAsset), tf(String(body.tf ?? '1m') as string), {
          strategy: String(body.strategy ?? 'confluence-core'),
          params: (body.params as Record<string, number | string>) ?? undefined,
          mode: (body.mode as 'binary' | 'spot') ?? 'binary',
          payout: body.payout !== undefined ? Number(body.payout) : 0.85,
          amount: body.amount !== undefined ? Number(body.amount) : 10,
          expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : 1,
          startEquity: body.startEquity !== undefined ? Number(body.startEquity) : 1000,
          tpPct: body.tpPct !== undefined ? Number(body.tpPct) : 0.4,
          slPct: body.slPct !== undefined ? Number(body.slPct) : 0.25,
          maxBars: body.maxBars !== undefined ? Number(body.maxBars) : 24,
        })
        return json(200, { ok: true, result })
      }

      if (path === '/vsk_montecarlo') {
        // Bootstrap Monte Carlo for the VSK Synthesis strategy: backtest the
        // 4-layer algorithm over deep history, then resample its trade PnL
        // sequence with replacement sims times -> distribution of final
        // equity / drawdown / ruin probability + p5/p50/p95 equity fan.
        try {
          const asset = String(body.asset ?? market.activeAsset)
          const tfv = tf(String(body.tf ?? '1m') as string)
          const startEquity = body.startEquity !== undefined ? Number(body.startEquity) : 1000
          const bt = analytics.runBacktest(asset, tfv, {
            strategy: 'vsk-synthesis',
            params: (body.params as Record<string, number | string>) ?? undefined,
            mode: 'binary',
            payout: body.payout !== undefined ? Number(body.payout) : 0.85,
            amount: body.amount !== undefined ? Number(body.amount) : 10,
            expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : 1,
            startEquity,
          })
          const mc = vskMonteCarlo(
            bt.trades.map((t) => t.pnl),
            {
              sims: body.sims !== undefined ? Number(body.sims) : 2000,
              startEquity,
              ruinPct: body.ruinPct !== undefined ? Number(body.ruinPct) : 0.6,
              seed: body.seed !== undefined ? Number(body.seed) : undefined,
            }
          )
          return json(200, {
            ok: true,
            asset,
            tf: tfv,
            baseline: {
              candlesTested: bt.candlesTested,
              totalTrades: bt.metrics.totalTrades,
              winRate: bt.metrics.winRate,
              netPnl: bt.metrics.netPnl,
              profitFactor: bt.metrics.profitFactor,
              expectancy: bt.metrics.expectancy,
              maxDrawdownPct: bt.metrics.maxDrawdownPct,
              finalEquity: bt.metrics.finalEquity,
            },
            monteCarlo: mc,
          })
        } catch (err) {
          return json(400, { ok: false, error: String(err instanceof Error ? err.message : err) })
        }
      }

      if (path === '/tsk_montecarlo') {
        // Bootstrap Monte Carlo for the TSK Synthesis strategy (volume-free
        // trendline sibling of VSK): backtest the 4-layer algorithm over deep
        // history, then resample its trade PnL sequence with replacement sims
        // times -> distribution of final equity / drawdown / ruin probability
        // + p5/p50/p95 equity fan.
        try {
          const asset = String(body.asset ?? market.activeAsset)
          const tfv = tf(String(body.tf ?? '1m') as string)
          const startEquity = body.startEquity !== undefined ? Number(body.startEquity) : 1000
          const bt = analytics.runBacktest(asset, tfv, {
            strategy: 'tsk-synthesis',
            params: (body.params as Record<string, number | string>) ?? undefined,
            mode: 'binary',
            payout: body.payout !== undefined ? Number(body.payout) : 0.85,
            amount: body.amount !== undefined ? Number(body.amount) : 10,
            expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : 1,
            startEquity,
          })
          const mc = tskMonteCarlo(
            bt.trades.map((t) => t.pnl),
            {
              sims: body.sims !== undefined ? Number(body.sims) : 2000,
              startEquity,
              ruinPct: body.ruinPct !== undefined ? Number(body.ruinPct) : 0.6,
              seed: body.seed !== undefined ? Number(body.seed) : undefined,
            }
          )
          return json(200, {
            ok: true,
            asset,
            tf: tfv,
            baseline: {
              candlesTested: bt.candlesTested,
              totalTrades: bt.metrics.totalTrades,
              winRate: bt.metrics.winRate,
              netPnl: bt.metrics.netPnl,
              profitFactor: bt.metrics.profitFactor,
              expectancy: bt.metrics.expectancy,
              maxDrawdownPct: bt.metrics.maxDrawdownPct,
              finalEquity: bt.metrics.finalEquity,
            },
            monteCarlo: mc,
          })
        } catch (err) {
          return json(400, { ok: false, error: String(err instanceof Error ? err.message : err) })
        }
      }

      if (path === '/run_strategy') {
        const strategyId = String(body.strategy ?? 'confluence-core')
        if (strategyId.startsWith('custom:')) {
          try {
            const lab = kernel.context().use<StrategyLabService>('lab')
            return json(200, { ok: true, eval: lab.runStrategy(String(body.asset ?? market.activeAsset), tf(String(body.tf ?? '1m') as string), strategyId) })
          } catch (err) {
            return json(400, { ok: false, error: String(err instanceof Error ? err.message : err) })
          }
        }
        const out = analytics.runStrategy(
          String(body.asset ?? market.activeAsset),
          tf(String(body.tf ?? '1m') as string),
          String(body.strategy ?? 'confluence-core'),
          (body.params as Record<string, number | string>) ?? undefined
        )
        return json(200, { ok: true, eval: out })
      }

      if (path === '/trade') {
        const asset = String(body.asset ?? market.activeAsset)
        const kind = (body.kind as 'binary' | 'turbo' | 'digital' | 'cfd') ?? 'binary'
        const inst = getInstrument(asset)
        // on IQ the account's own instruments are valid even when unknown to
        // the sim universe (exotics, OTC variants) - the sidecar validates
        if (!inst && !(exec.accountSource === 'iq' && market.isIQAsset(asset)))
          return json(400, { ok: false, error: `unknown asset ${asset}` })
        const out = await exec.placeOrder({
          asset,
          tf: tf(String(body.tf ?? '1m') as string),
          side: (body.side as 'call' | 'put') ?? 'call',
          kind,
          amount: Number(body.amount ?? 10),
          expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : undefined,
          expirySec: body.expirySec !== undefined ? Number(body.expirySec) : undefined,
          strikeOffsetPct: body.strikeOffsetPct !== undefined ? Number(body.strikeOffsetPct) : undefined,
          // account source is the single routing truth: on IQ every order is
          // live, on paper everything stays simulated - ignore body.mode
          mode: exec.accountSource === 'iq' ? 'live' : 'paper',
          tp: body.tp !== undefined ? Number(body.tp) : undefined,
          sl: body.sl !== undefined ? Number(body.sl) : undefined,
          leverage: body.leverage !== undefined ? Number(body.leverage) : undefined,
          strategy: body.strategy !== undefined ? String(body.strategy) : undefined,
          note: body.note !== undefined ? String(body.note) : undefined,
        })
        return json(200, out)
      }

      if (path === '/close') {
        const out = exec.closePosition(String(body.id ?? ''))
        return json(200, out)
      }

      // Batch watch-list prices (IQ): the web asks for the rows it displays;
      // the sidecar serves last 1m closes, cached 30s per ticker
      if (path === '/prices') {
        const raw = body.tickers
        const tickers = (Array.isArray(raw) ? raw : []).filter((t) => typeof t === 'string' && t) as string[]
        if (!exec.accountSource || exec.accountSource !== 'iq') return json(200, { ok: true, prices: {} })
        const prices = await exec.watchPrices(tickers)
        return json(200, { ok: true, prices })
      }

      if (path === '/kill_switch') {
        const out = exec.setKillSwitch(Boolean(body.on))
        return json(200, { ok: true, account: out })
      }

      // ---------- os mode control ----------

      if (path === '/mode_set') {
        const mode = kernel.context().use<ModeService>('mode')
        const next = String(body.mode ?? '') as OsMode
        if (next !== 'human' && next !== 'auto') return json(400, { ok: false, error: "mode must be 'human' or 'auto'" })
        const reason = body.reason !== undefined ? String(body.reason) : undefined
        return json(200, mode.setMode(next, reason))
      }

      if (path === '/autotrader_config') {
        const mode = kernel.context().use<ModeService>('mode')
        return json(200, mode.configure(body as Record<string, never>))
      }

      if (path === '/risk') {
        const patch = body as Partial<RiskConfig>
        const out = exec.setRisk(patch)
        return json(200, { ok: true, risk: out })
      }

      if (path === '/reset') {
        return json(200, { ok: true, account: exec.resetAccount() })
      }

      if (path === '/live/connect') {
        const out = await exec.connectLive(
          String(body.url ?? 'http://127.0.0.1:8788'),
          String(body.email ?? ''),
          String(body.password ?? ''),
          String(body.balanceMode ?? 'PRACTICE')
        )
        return json(200, out)
      }

      // Account source switch: the single routing truth for ledger, order
      // routing AND the data feed. POST only (GET /account/source is a 404
      // by design - a source switch mutates state).
      if (path === '/account/source') {
        const source = String(body.source ?? 'paper') === 'iq' ? 'iq' : 'paper'
        const balanceMode = String(body.balanceMode ?? 'PRACTICE') === 'REAL' ? 'REAL' : 'PRACTICE'
        const out = await exec.switchSource(source, balanceMode)
        if (!out.ok) return json(400, { ok: false, error: out.error })
        // activeAsset may have moved (current chart asset not tradeable on IQ)
        return json(200, { ok: true, account: out.account, source, activeAsset: market.activeAsset, feedMode: market.mode })
      }

      if (path === '/live/disconnect') {
        exec.disconnectLive()
        return json(200, { ok: true })
      }

      if (path === '/live/adopt') {
        const out = await exec.adoptLive(String(body.url ?? 'http://127.0.0.1:8788'))
        return json(200, out)
      }

      if (path === '/live/positions') {
        const out = await exec.livePositions()
        return json(200, { ok: true, data: out })
      }

      if (path === '/live/history') {
        const out = await exec.liveHistory(String(body.instrumentType ?? 'turbo-option'), Number(body.limit ?? 20))
        return json(200, { ok: true, data: out })
      }

      if (path === '/chat_save') {
        const store = kernel.context().use<{ saveChat: (s: string, r: string, c: string) => void }>('storeRaw')
        store.saveChat(String(body.session ?? 'default'), String(body.role ?? 'user'), String(body.content ?? ''))
        return json(200, { ok: true })
      }

      if (path === '/chat_clear') {
        const store = kernel.context().use<{ clearChat: (s: string) => number }>('storeRaw')
        const removed = store.clearChat(String(body.session ?? 'default'))
        return json(200, { ok: true, removed })
      }

      if (path === '/notes_save') {
        const store = kernel.context().use<{ saveNote: (k: string, c: string, t?: string) => { id: number; ts: number } }>('storeRaw')
        const content = String(body.content ?? '').trim()
        if (!content) return json(400, { ok: false, error: 'content required' })
        const saved = store.saveNote(String(body.kind ?? 'note').slice(0, 40), content.slice(0, 2000), body.tags ? String(body.tags).slice(0, 200) : undefined)
        return json(200, { ok: true, ...saved })
      }

      if (path === '/notes_delete') {
        const store = kernel.context().use<{ deleteNote: (id: number) => boolean }>('storeRaw')
        const removed = store.deleteNote(Number(body.id ?? 0))
        return json(200, { ok: removed, removed })
      }

      // ---------- autopilot control ----------

      if (path === '/bot_save') {
        const bots = kernel.context().use<AutopilotService>('autopilot')
        return json(200, bots.saveBot(body as Partial<BotConfig>))
      }

      if (path === '/bot_delete') {
        const bots = kernel.context().use<AutopilotService>('autopilot')
        return json(200, bots.deleteBot(String(body.id ?? '')))
      }

      if (path === '/bot_toggle') {
        const bots = kernel.context().use<AutopilotService>('autopilot')
        return json(200, bots.toggleBot(String(body.id ?? ''), body.enabled === undefined ? undefined : Boolean(body.enabled)))
      }

      if (path === '/bot_restart') {
        // compound stop-on-loss: revive a halted cycle (clears halt, re-seeds pot)
        const bots = kernel.context().use<AutopilotService>('autopilot')
        return json(200, bots.restartBot(String(body.id ?? '')))
      }

      // ---------- strategy lab (AI learning agent) ----------

      // Mine a pair's history for edge-bearing events across the whole pattern
      // vocabulary (candlestick / bar / heiken ashi / line / invented
      // indicators), compose the survivors into a custom spec and backtest it
      // (full sample + holdout). Deploy via /bot_save with strategyId
      // "custom:<id>" after /lab_save.
      if (path === '/lab_learn') {
        try {
          const lab = kernel.context().use<StrategyLabService>('lab')
          const result = lab.learn({
            asset: String(body.asset ?? market.activeAsset),
            tf: tf(String(body.tf ?? '1m') as string),
            bars: body.bars !== undefined ? Number(body.bars) : undefined,
            horizon: body.horizon !== undefined ? Number(body.horizon) : undefined,
            minSamples: body.minSamples !== undefined ? Number(body.minSamples) : undefined,
            minEdge: body.minEdge !== undefined ? Number(body.minEdge) : undefined,
            maxSignals: body.maxSignals !== undefined ? Number(body.maxSignals) : undefined,
            payout: body.payout !== undefined ? Number(body.payout) : undefined,
            amount: body.amount !== undefined ? Number(body.amount) : undefined,
            name: body.name !== undefined ? String(body.name) : undefined,
            basis: body.basis !== undefined ? String(body.basis) as 'candles' | 'heikin' : undefined,
          })
          return json(200, result)
        } catch (err) {
          return json(400, { ok: false, error: String(err instanceof Error ? err.message : err) })
        }
      }

      if (path === '/lab_backtest') {
        try {
          const lab = kernel.context().use<StrategyLabService>('lab')
          const result = lab.backtestSpec({
            spec: body.spec,
            id: body.id !== undefined ? String(body.id) : undefined,
            asset: body.asset !== undefined ? String(body.asset) : undefined,
            tf: body.tf !== undefined ? String(body.tf) : undefined,
            payout: body.payout !== undefined ? Number(body.payout) : undefined,
            amount: body.amount !== undefined ? Number(body.amount) : undefined,
            horizon: body.horizon !== undefined ? Number(body.horizon) : undefined,
          })
          return json(200, result)
        } catch (err) {
          return json(400, { ok: false, error: String(err instanceof Error ? err.message : err) })
        }
      }

      if (path === '/lab_save') {
        try {
          const lab = kernel.context().use<StrategyLabService>('lab')
          return json(200, {
            ...lab.save({
              id: body.id !== undefined ? String(body.id) : undefined,
              name: body.name !== undefined ? String(body.name) : undefined,
              spec: body.spec,
              asset: body.asset !== undefined ? String(body.asset) : undefined,
              tf: body.tf !== undefined ? String(body.tf) : undefined,
              stats: body.stats,
            }),
          })
        } catch (err) {
          return json(400, { ok: false, error: String(err instanceof Error ? err.message : err) })
        }
      }

      if (path === '/lab_delete') {
        const lab = kernel.context().use<StrategyLabService>('lab')
        return json(200, lab.remove(String(body.id ?? '')))
      }

      // ---------- discovery control ----------

      if (path === '/screener_config') {
        const scr = kernel.context().use<ScreenerService>('screener')
        return json(200, scr.configure(body as Parameters<typeof scr.configure>[0]))
      }

      if (path === '/alert_rule_save') {
        const rules = kernel.context().use<AlertRulesService>('alertrules')
        return json(200, rules.saveRule(body as Record<string, never>))
      }

      if (path === '/alert_rule_toggle') {
        const rules = kernel.context().use<AlertRulesService>('alertrules')
        return json(200, rules.toggleRule(String(body.id ?? ''), body.enabled === undefined ? undefined : Boolean(body.enabled)))
      }

      if (path === '/alert_rule_delete') {
        const rules = kernel.context().use<AlertRulesService>('alertrules')
        return json(200, rules.deleteRule(String(body.id ?? '')))
      }

      // ---------- sentinel control ----------

      if (path === '/sentinel_config') {
        const sen = kernel.context().use<SentinelService>('sentinel')
        return json(200, { ok: true, config: sen.configure(body as Partial<SentinelConfig>) })
      }

      if (path === '/sentinel_ack') {
        const sen = kernel.context().use<SentinelService>('sentinel')
        const b = body.breaker === 'daily' || body.breaker === 'drawdown' ? body.breaker : undefined
        return json(200, sen.ack(b))
      }

      if (path === '/panic') {
        const sen = kernel.context().use<SentinelService>('sentinel')
        return json(200, sen.panic({ killSwitch: Boolean(body.killSwitch) }))
      }

      // ---------- adaptive gate control ----------

      if (path === '/adaptive_config') {
        const ad = kernel.context().use<AdaptiveService>('adaptive')
        return json(200, { ok: true, config: ad.configure(body as Partial<AdaptiveConfig>) })
      }

      // ---------- watchdog control ----------

      if (path === '/watchdog_config') {
        const wd = kernel.context().use<WatchdogService>('watchdog')
        return json(200, { ok: true, config: wd.configure(body as Partial<WatchdogConfig>) })
      }

      if (path === '/watchdog_ack') {
        const wd = kernel.context().use<WatchdogService>('watchdog')
        return json(200, wd.ack(body.botId ? String(body.botId) : undefined))
      }

      if (path === '/watchdog_baseline') {
        const wd = kernel.context().use<WatchdogService>('watchdog')
        return json(200, wd.setBaseline(String(body.botId ?? ''), Number(body.expectedWinRatePct ?? 0)))
      }

      // ---------- archive control ----------

      if (path === '/archive_prune') {
        const store = kernel.context().use<{ pruneArchive: (cap: number) => number }>('storeRaw')
        const cap = Math.max(200, Math.min(Number(body.cap ?? 4000), 20000))
        return json(200, { ok: true, cap, removed: store.pruneArchive(cap) })
      }
    }

    return json(404, { ok: false, error: `no route: ${req.method} ${path}` })
  } catch (err) {
    return json(500, { ok: false, error: (err as Error).message })
  }

  function store_list(status?: 'open' | 'closed'): unknown[] {
    const store = kernel.context().use<{ listPositions: (s?: 'open' | 'closed', l?: number) => unknown[] }>('storeRaw')
    return store.listPositions(status, 200)
  }
})

const io = new Server(httpServer, {
  // engine.io claims the realtime path and plain REST falls through to the
  // handler above. addTrailingSlash:false makes the path check a slash-less
  // prefix match, so BOTH '/socket.io/?EIO=4…' and '/socket.io?EIO=4…' are
  // accepted - proxies that normalize the trailing slash (e.g. Next's
  // trailing-slash 308 in front of :3000) would otherwise 404 the handshake
  // and leave the OS feed stuck on "reconnecting…".
  addTrailingSlash: false,
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

io.on('connection', (socket) => {
  console.log(`[ws] client connected: ${socket.id}`)
  socket.on('subscribe', ({ asset, tf }: { asset?: string; tf?: string }) => {
    for (const room of socket.rooms) {
      if (room.startsWith('feed:')) socket.leave(room)
    }
    socket.join('feed:global')
    if (asset && tf) socket.join(`feed:${asset}:${tf}`)
  })
  socket.on('ping-msg', (data) => socket.emit('pong-msg', data))
  socket.on('disconnect', () => console.log(`[ws] client gone: ${socket.id}`))
})

// forward kernel events: candles room-scoped by asset+tf, everything else global
const ctx = kernel.context()
ctx.bus.on('tick', (p) => io.to('feed:global').emit('tick', p))
ctx.bus.on('candle', (p) => io.to(`feed:${p.asset}:${p.tf}`).emit('candle', p))
ctx.bus.on('positionOpened', (p) => io.to('feed:global').emit('positionOpened', p))
ctx.bus.on('positionClosed', (p) => io.to('feed:global').emit('positionClosed', p))
ctx.bus.on('account', (p) => io.to('feed:global').emit('account', p))
ctx.bus.on('alert', (p) => {
  const store = ctx.use<{ recordAlert: (l: string, m: string, t: number) => void }>('storeRaw')
  store.recordAlert(p.level, p.message, p.ts)
  io.to('feed:global').emit('alert', p)
})

kernel.start().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`[trading-core] IQAIR//OS kernel listening on :${PORT}`)
  })
  // Boot-time source restore: the PERSISTED account source decides what the
  // OS resumes as. Paper stays on the sim feed even when the sidecar holds a
  // warm session (credentials no longer hijack paper); a persisted IQ source
  // re-adopts the session without re-entering credentials.
  setTimeout(() => {
    const exec = kernel.context().use<ExecutionService>('execution')
    void exec.restoreSource().then(() => {
      console.log(`[trading-core] boot source restore done - source=${exec.accountSource} feed=${kernel.context().use<MarketDataService>('market').mode}`)
    })
  }, 2000)
}).catch((err) => {
  console.error('[trading-core] kernel boot failed:', err)
  process.exit(1)
})
