// IQAIR//OS - trading-core service
// Boots the kernel (store -> market-data -> analytics -> execution), then serves
// REST for every OS operation and socket.io for the real-time event feed.
// Port 3030. Path '/' is fixed for the Caddy gateway.

import { createServer, type IncomingMessage } from 'http'
import { createHash, timingSafeEqual } from 'crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
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
import { screener2Plugin, Screener2Service } from './src/plugins/screener2'
import { alertRulesPlugin, AlertRulesService, ALERT_METRICS } from './src/plugins/alert-rules'
import { sentinelPlugin, SentinelService, type SentinelConfig } from './src/plugins/sentinel'
import { watchdogPlugin, WatchdogService, type WatchdogConfig } from './src/plugins/watchdog'
import { adaptivePlugin, AdaptiveService, type AdaptiveConfig } from './src/plugins/adaptive'
import { otcGuardPlugin, OtcGuardService, type OtcDefenseReport } from './src/plugins/otcguard'
import { otcFootprintPlugin, OtcFootprintService } from './src/plugins/otcfootprint'
import { chartSignalsPlugin, ChartSignalsService } from './src/plugins/chartsignals'
import { yesterdayPlugin, YesterdayService } from './src/plugins/yesterday'
import { gridSearch, walkForward, sweepAssets, type Objective } from './src/strategies/optimize'
import { backtest } from './src/strategies/backtest'
import type { BacktestOptions } from './src/strategies/backtest'
import { normalizeSpec, type CustomSpec } from './src/strategies/custom'
import { MINABLE_ENGINES, ENGINE_LABEL, type ChartEngineId } from './src/analytics/chartsignals'
import { vskMonteCarlo } from './src/analytics/vsk'
import { tskMonteCarlo } from './src/analytics/tsk'
import { ALL_TIMEFRAMES, type Candle, type Timeframe } from './src/types'
import { searchInstruments, universeStats, getInstrument } from './src/universe'
import { listRegistry, computeIndicator, registrySize, getIndicatorDef } from './src/analytics/registry'
import { detectChartPatterns } from './src/analytics/chart-patterns'
import { computeVolumeProfile, computeCandleDelta, computeCumulativeDelta } from './src/analytics/orderflow'
import { findSmartBlends } from './src/analytics/candlemath'
import { renkoBricks } from './src/analytics/renko'
import { pointFigure } from './src/analytics/pointfigure'
import { rangeBars } from './src/analytics/rangebars'
import { volumeBars } from './src/analytics/volumebars'
import { computeFootprint } from './src/analytics/footprint'
import { computeTpo } from './src/analytics/tpo'
import { tickBars } from './src/analytics/tickbars'
import { hvSeries, ivFromPayout, realizedUpProb } from './src/analytics/ivhv'
import { buildCalibrationReport, type CalibrationStoreSlice } from './src/analytics/calibration'
import { computeStepStats, computeIntervalStats } from './src/analytics/randomness'
import { loadOtcHarvest } from './src/analytics/otcHarvest'
import { estimateTwinParams, generateOtcTwin } from './src/analytics/otcTwin'
import { tfSeconds } from './src/analytics/synthfeed'

// Defaults to 3030 for local/Windows dev; the Docker deployment overrides
// this to an unusual, hard-to-collide-with port via the KERNEL_PORT env var.
const PORT = Number(process.env.KERNEL_PORT ?? 3030)

// ---------- P0 security baseline (token auth + rate limit + audit) ----------
// KERNEL_TOKEN: when set, every REST route (except /health liveness and the
// /socket.io feed transport) requires the token via the x-kernel-token
// header, an "Authorization: Bearer <token>" header, or a ?token= query
// param. Comparison is timing-safe (sha256 digests). Unset = open, which is
// the local/dev posture; the Docker deployment sets the token on BOTH the
// kernel and web containers (web injects it server-side - the browser never
// sees it). The remaining P0 tail (web auth / Telegram / backups) is tracked
// in deploy/README.md.
const KERNEL_TOKEN = (process.env.KERNEL_TOKEN ?? '').trim()
const RATE_CAPACITY = 240 // burst bucket per client IP
const RATE_REFILL_PER_SEC = 4 // sustained ~240 req/min per IP
const RATE_MAX_IPS = 1000 // bound the bucket map under address churn
const buckets = new Map<string, { tokens: number; ts: number }>()

function rateLimit(ip: string): { ok: boolean; retryAfter: number } {
  const now = Date.now()
  const b = buckets.get(ip) ?? { tokens: RATE_CAPACITY, ts: now }
  b.tokens = Math.min(RATE_CAPACITY, b.tokens + ((now - b.ts) / 1000) * RATE_REFILL_PER_SEC)
  b.ts = now
  if (b.tokens < 1) {
    buckets.set(ip, b)
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / RATE_REFILL_PER_SEC)) }
  }
  b.tokens -= 1
  buckets.set(ip, b)
  if (buckets.size > RATE_MAX_IPS) {
    for (const [k, v] of buckets) if (v.ts < now - 600_000) buckets.delete(k)
    while (buckets.size > RATE_MAX_IPS) {
      const oldest = [...buckets.entries()].sort((a, c) => a[1].ts - c[1].ts)[0]
      buckets.delete(oldest[0])
    }
  }
  return { ok: true, retryAfter: 0 }
}

function tokenOk(req: IncomingMessage, url: URL): boolean {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))
  const given =
    String(req.headers['x-kernel-token'] ?? '').trim() ||
    (bearer ? bearer[1].trim() : '') ||
    (url.searchParams.get('token') ?? '').trim()
  if (!given) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(KERNEL_TOKEN).digest()
  return timingSafeEqual(a, b)
}

// Append-only audit trail: every state-changing (POST) call plus every 401 /
// 429 rejection lands in data/audit.jsonl. Query strings are stripped (the
// ?token= fallback must never be logged) and bodies are NEVER written (the
// live-mode login route's body carries broker credentials).
const AUDIT_PATH = join(process.cwd(), 'data', 'audit.jsonl')
function auditLine(row: Record<string, unknown>): void {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true })
    appendFileSync(AUDIT_PATH, JSON.stringify(row) + '\n')
  } catch {
    /* audit is best-effort - it must never break the request path */
  }
}

/** Wilson 95% score interval on a proportion, in percent. Same math the lab
 * uses for its SignalStat CI, kept local so the research route doesn't reach
 * into the lab plugin's internals. */
function wilsonPct(wins: number, total: number, z = 1.96): [number, number] {
  if (total <= 0) return [0, 100]
  const p = wins / total
  const denom = 1 + (z * z) / total
  const center = p + (z * z) / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))
  return [Math.max(0, ((center - margin) / denom) * 100), Math.min(100, ((center + margin) / denom) * 100)]
}

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
kernel.register(screener2Plugin)
kernel.register(alertRulesPlugin)
kernel.register(sentinelPlugin)
kernel.register(watchdogPlugin)
kernel.register(adaptivePlugin)
kernel.register(otcGuardPlugin)
kernel.register(otcFootprintPlugin)
kernel.register(chartSignalsPlugin)
kernel.register(yesterdayPlugin)

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

  // ---- P0 security gate: rate limit -> token auth, BEFORE any body read ----
  const t0 = Date.now()
  const xff = String(req.headers['x-forwarded-for'] ?? '')
  const ip = xff.split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
  // audit watcher: POSTs are state-changing, 401/429 are the security
  // rejections - everything else is a read and stays out of the trail
  let status = 0
  res.on('finish', () => {
    if (req.method !== 'POST' && status !== 401 && status !== 429) return
    auditLine({ ts: new Date().toISOString(), ip, m: req.method, path, status, ms: Date.now() - t0 })
  })
  const limited = rateLimit(ip)
  if (!limited.ok) {
    status = 429
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(limited.retryAfter) })
    res.end(JSON.stringify({ ok: false, error: 'rate limited', retryAfter: limited.retryAfter }))
    return
  }
  if (KERNEL_TOKEN && path !== '/health' && !path.startsWith('/socket.io') && !tokenOk(req, url)) {
    status = 401
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: false,
      error: 'unauthorized - missing or invalid kernel token (x-kernel-token header, Bearer auth, or ?token=)',
    }))
    return
  }

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
    status = code
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const tf = (name: string | null): Timeframe => {
    const v = (name ?? '1m') as Timeframe
    return (ALL_TIMEFRAMES as string[]).includes(v) ? v : '1m'
  }
  // Task 59 (P3): the lenient tf() silently coerced ANY garbage tf to '1m' -
  // a typo'd query param returned wrong-timeframe data with HTTP 200. The
  // strict variant returns null for garbage; read/decision routes 400 on it.
  const tfStrict = (name: string | null): Timeframe | null => {
    const v = name ?? '1m'
    return (ALL_TIMEFRAMES as string[]).includes(v) ? (v as Timeframe) : null
  }
  const tfErr = (name: string | null) =>
    `invalid tf "${name ?? ''}" - expected one of ${ALL_TIMEFRAMES.join(', ')}`
  // Resolves a "custom:<slug>" AI Lab strategy id to its CustomSpec, the
  // same lab.get()->normalizeSpec() path StrategyLabService.runStrategy
  // uses, so the Backtest Lab's Single-Run/Optimizer/Walk-Forward/Asset-
  // Sweep engines can evaluate a Lab strategy exactly like the live
  // autopilot does. Returns undefined for a builtin id (nothing to
  // resolve); throws when a custom: id doesn't resolve, so the caller's
  // try/catch can turn that into a clean 400 instead of a 500.
  const resolveCustomSpec = (id: string): CustomSpec | undefined => {
    if (!id.startsWith('custom:')) return undefined
    const row = kernel.context().use<StrategyLabService>('lab').get(id)
    if (!row) throw new Error(`unknown lab strategy ${id}`)
    const spec = normalizeSpec(row.spec, id)
    if (!spec) throw new Error(`lab strategy ${id} has no usable signals`)
    return spec
  }
  const directionOf = (b: Record<string, unknown>): 'call' | 'put' | 'both' | undefined =>
    b.direction === 'call' || b.direction === 'put' || b.direction === 'both' ? b.direction : undefined

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
          return json(200, { ok: true, instruments: rows, stats: universeStats() })
        }
        market.refreshSchedules()
        const found = searchInstruments(search, cat)
        return json(200, {
          ok: true,
          instruments: found.map((a) => ({ ...a, price: market.getPrice(a.ticker) || a.basePrice, iq: market.isIQAvailable(a.ticker) })),
          stats: universeStats(),
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

      // Order flow approximation (no real bid/ask-tagged trades are available
      // from IQ Option - see analytics/orderflow.ts header for the method).
      if (path === '/volume_profile') {
        const t = tfStrict(q.get('tf'))
        if (t === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const asset = q.get('asset') ?? market.activeAsset
        const limit = Math.min(Number(q.get('limit') ?? 400), 1000)
        const bucketCount = q.get('buckets') ? Number(q.get('buckets')) : undefined
        // Task 59 (P3): closedOnly - the forming bar made the POC/value-area
        // repaint on every tick.
        const candles = market.getCandles(asset, t, limit, true)
        return json(200, { ok: true, asset, tf: t, approx: true, profile: computeVolumeProfile(candles, { bucketCount }) })
      }

      if (path === '/delta') {
        const t = tfStrict(q.get('tf'))
        if (t === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const asset = q.get('asset') ?? market.activeAsset
        const limit = Math.min(Number(q.get('limit') ?? 400), 1000)
        // Task 59 (P3): closedOnly - the last delta bar used to include the
        // forming candle and repaint continuously, unmarked.
        const candles = market.getCandles(asset, t, limit, true)
        const deltas = computeCandleDelta(candles)
        const cumulative = computeCumulativeDelta(deltas)
        return json(200, { ok: true, asset, tf: t, approx: true, closedOnly: true, deltas, cumulative })
      }

      // Candle Math (candle blending / candlestick algebra) - see
      // analytics/candlemath.ts header for the exact blend rule and the
      // pattern-confirmed "smart grouping" heuristic.
      if (path === '/candle_math') {
        const t = tfStrict(q.get('tf'))
        if (t === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const asset = q.get('asset') ?? market.activeAsset
        const limit = Math.min(Number(q.get('limit') ?? 200), 1000)
        const maxGroup = q.get('maxGroup') ? Math.max(2, Math.min(6, Number(q.get('maxGroup')))) : undefined
        // Task 59 (P3): closedOnly - blends anchored on the forming bar repaint.
        const candles = market.getCandles(asset, t, limit, true)
        const blends = findSmartBlends(candles, { maxGroup })
        return json(200, { ok: true, asset, tf: t, closedOnly: true, raw: candles, blends })
      }

      // Renko brick engine (analytics/renko.ts): close-based bricks, ATR-sized
      // by default, 2-brick reversal, honest completion-candle times. Read-only
      // research surface for strategies ('renko-flip'), agent tools and the
      // chart's own client-side render.
      if (path === '/renko') {
        const t = tfStrict(q.get('tf'))
        if (t === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const asset = q.get('asset') ?? market.activeAsset
        const limit = Math.min(Number(q.get('limit') ?? 400), 1000)
        const candles = market.getCandles(asset, t, limit, true)
        const brickSizeRaw = Number(q.get('brickSize'))
        const r = renkoBricks(candles, {
          brickSize: Number.isFinite(brickSizeRaw) && brickSizeRaw > 0 ? brickSizeRaw : undefined,
          atrPeriod: Math.round(Number(q.get('atrPeriod') ?? 14)) || 14,
          atrMult: Number(q.get('atrMult') ?? 0.3) || 0.3,
        })
        return json(200, {
          ok: true,
          asset,
          tf: t,
          feed: market.mode,
          closedOnly: true,
          brickSize: r.brickSize,
          brickRule: r.brickRule,
          timeRule: r.timeRule,
          trend: r.trend,
          streak: r.streak,
          flips: r.flips,
          count: r.bricks.length,
          bricks: r.bricks.slice(-160),
        })
      }

      // Point & Figure engine (analytics/pointfigure.ts): high/low box counts,
      // classic 3-box reversal, double/triple top-bottom breakout detection
      // with real completion-bar timestamps. Feeds 'pf-breakout' + research.
      if (path === '/pointfigure') {
        const t = tfStrict(q.get('tf'))
        if (t === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const asset = q.get('asset') ?? market.activeAsset
        const limit = Math.min(Number(q.get('limit') ?? 400), 1000)
        const candles = market.getCandles(asset, t, limit, true)
        const boxSizeRaw = Number(q.get('boxSize'))
        const pf = pointFigure(candles, {
          boxSize: Number.isFinite(boxSizeRaw) && boxSizeRaw > 0 ? boxSizeRaw : undefined,
          atrPeriod: Math.round(Number(q.get('atrPeriod') ?? 14)) || 14,
          atrMult: Number(q.get('atrMult') ?? 0.5) || 0.5,
          reversalBoxes: Math.round(Number(q.get('reversal') ?? 3)) || 3,
        })
        return json(200, {
          ok: true,
          asset,
          tf: t,
          feed: market.mode,
          closedOnly: true,
          boxSize: pf.boxSize,
          boxRule: pf.boxRule,
          reversalBoxes: pf.reversalBoxes,
          lastDir: pf.lastDir,
          pattern: pf.pattern,
          buySignal: pf.buySignal,
          sellSignal: pf.sellSignal,
          count: pf.columns.length,
          columns: pf.columns.slice(-40),
        })
      }

      // ---------- Task 63 chart-type engines ----------
      // Range bars: every bar spans EXACTLY `range` of price (open -> close);
      // no time axis, no reversal multiplier. Engine of record:
      // analytics/rangebars.ts. Read-only research surface + chart data.
      if (path === '/rangebars') {
        const t = tfStrict(q.get('tf'))
        if (t === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const asset = q.get('asset') ?? market.activeAsset
        const limit = Math.min(Number(q.get('limit') ?? 400), 1000)
        const candles = market.getCandles(asset, t, limit, true)
        const rangeRaw = Number(q.get('range'))
        const r = rangeBars(candles, {
          range: Number.isFinite(rangeRaw) && rangeRaw > 0 ? rangeRaw : undefined,
          atrPeriod: Math.round(Number(q.get('atrPeriod') ?? 14)) || 14,
          atrMult: Number(q.get('atrMult') ?? 0.5) || 0.5,
        })
        return json(200, {
          ok: true,
          asset,
          tf: t,
          feed: market.mode,
          closedOnly: true,
          range: r.range,
          rangeRule: r.rangeRule,
          timeRule: r.timeRule,
          trend: r.trend,
          streak: r.streak,
          flips: r.flips,
          count: r.bars.length,
          bars: r.bars.slice(-200),
        })
      }

      // Constant (equi) volume bars: a bar closes when cumulative volume
      // first reaches `per`. All-zero-volume windows 400 honestly (post-
      // restart archives can carry volume 0 - Task 59 finding).
      if (path === '/volumebars') {
        const t = tfStrict(q.get('tf'))
        if (t === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const asset = q.get('asset') ?? market.activeAsset
        const limit = Math.min(Number(q.get('limit') ?? 400), 1000)
        const candles = market.getCandles(asset, t, limit, true)
        const perRaw = Number(q.get('per'))
        const r = volumeBars(candles, { per: Number.isFinite(perRaw) && perRaw > 0 ? perRaw : undefined })
        if (r.degenerate) {
          return json(400, { ok: false, error: 'all-zero volume window - constant volume bars are undefined (feed carries no volume; post-restart archives can file volume 0)', volumeSource: r.volumeSource })
        }
        return json(200, {
          ok: true,
          asset,
          tf: t,
          feed: market.mode,
          closedOnly: true,
          per: r.per,
          perRule: r.perRule,
          timeRule: r.timeRule,
          volumeSource: r.volumeSource,
          volumeNote: 'volume (approx) - IQ OTC volume is commonly a tick/sample count, not traded size',
          count: r.bars.length,
          bars: r.bars.slice(-160),
        })
      }

      // Volume footprint / cluster chart: per-candle price-bin ladder with
      // CLV buy/sell split - an approximation (no bid/ask feed), every
      // response says so via `method`.
      if (path === '/footprint') {
        const t = tfStrict(q.get('tf'))
        if (t === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const asset = q.get('asset') ?? market.activeAsset
        const limit = Math.min(Number(q.get('limit') ?? 120), 300)
        const candles = market.getCandles(asset, t, limit, true)
        const fp = computeFootprint(candles, {
          binsPerCandle: Math.round(Number(q.get('bins') ?? 8)) || 8,
          imbalanceRatio: Number(q.get('imbalance') ?? 3) || 3,
        })
        return json(200, {
          ok: true,
          asset,
          tf: t,
          feed: market.mode,
          closedOnly: true,
          binsPerCandle: fp.binsPerCandle,
          imbalanceRatio: fp.imbalanceRatio,
          method: fp.method,
          count: fp.candles.length,
          candles: fp.candles.slice(-50),
        })
      }

      // Market Profile / TPO: single-print-per-period profile over the
      // window, POC + 70% value area + initial balance.
      if (path === '/tpo') {
        const t = tfStrict(q.get('tf'))
        if (t === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const asset = q.get('asset') ?? market.activeAsset
        const limit = Math.min(Number(q.get('limit') ?? 400), 1000)
        const candles = market.getCandles(asset, t, limit, true)
        const prof = computeTpo(candles, {
          periodSec: Math.round(Number(q.get('periodSec') ?? 1800)) || 1800,
          binCount: Math.round(Number(q.get('bins') ?? 60)) || 60,
        })
        return json(200, {
          ok: true,
          asset,
          tf: t,
          feed: market.mode,
          closedOnly: true,
          periodSec: prof.periodSec,
          periodRule: prof.periodRule,
          countRule: prof.countRule,
          poc: prof.poc,
          valueAreaHigh: prof.valueAreaHigh,
          valueAreaLow: prof.valueAreaLow,
          ibHigh: prof.ibHigh,
          ibLow: prof.ibLow,
          totalTpos: prof.totalTpos,
          bins: prof.bins,
          periods: prof.periods.slice(-40),
        })
      }

      // Tick chart: N price observations per bar. Real sub-candle ticks from
      // the sidecar's 100ms capture buffer when LIVE and filled enough,
      // otherwise 5s candle closes as pseudo-ticks - getTickSeries' honest
      // dataSource contract, surfaced verbatim.
      if (path === '/ticks') {
        const asset = q.get('asset') ?? market.activeAsset
        const perRaw = Number(q.get('per'))
        const { points, dataSource } = await market.getTickSeries(asset)
        const r = tickBars(points, { per: Number.isFinite(perRaw) && perRaw >= 2 ? perRaw : undefined, dataSource })
        return json(200, {
          ok: true,
          asset,
          feed: market.mode,
          dataSource: r.dataSource,
          per: r.per,
          perRule: r.perRule,
          timeRule: r.timeRule,
          points: points.length,
          count: r.bars.length,
          bars: r.bars.slice(-160),
          note: r.dataSource === 'candle' ? 'pseudo-ticks = 5s candle closes (no raw tick buffer available) - NOT raw tick data' : 'real broker price changes from the 100ms capture buffer (coalescing bounded by poll rate)',
        })
      }

      // IV vs HV: annualized rolling realized vol (real math) against the
      // payout-implied breakeven probability (the honest IV-ANALOG here - a
      // true option-market IV is not recoverable from a single ATM payout;
      // see analytics/ivhv.ts for why the classic inversion has no solution).
      if (path === '/iv_hv') {
        const t = tfStrict(q.get('tf'))
        if (t === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const asset = q.get('asset') ?? market.activeAsset
        const limit = Math.min(Number(q.get('limit') ?? 400), 1000)
        const candles = market.getCandles(asset, t, limit, true)
        const hv = hvSeries(candles, { window: Math.round(Number(q.get('window') ?? 20)) || 20 })
        // observed payout samples (accrues live, resets on restart)
        const hist = market.getPayoutHistory(asset).slice(-500)
        const payoutNow = market.payoutFor(asset, 'binary')
        let ivSeries = hist.map((s) => ({ time: s.t, payout: s.payout, breakevenPct: ivFromPayout(s.payout).breakevenPct }))
        let ivSource: 'observed' | 'current' | 'none' = 'observed'
        if (ivSeries.length === 0) {
          if (Number.isFinite(payoutNow) && payoutNow > 0) {
            ivSeries = [{ time: Date.now() / 1000, payout: payoutNow, breakevenPct: ivFromPayout(payoutNow).breakevenPct }]
            ivSource = 'current'
          } else {
            ivSource = 'none'
          }
        } else {
          // fold the current quote in when it moved past the last sample
          const lastP = ivSeries[ivSeries.length - 1].payout
          if (Number.isFinite(payoutNow) && payoutNow > 0 && Math.abs(payoutNow - lastP) > 1e-9) {
            ivSeries.push({ time: Date.now() / 1000, payout: payoutNow, breakevenPct: ivFromPayout(payoutNow).breakevenPct })
          }
        }
        return json(200, {
          ok: true,
          asset,
          tf: t,
          feed: market.mode,
          closedOnly: true,
          hv: hv.series,
          hvNow: hv.hvNow,
          annualization: hv.annualization,
          iv: ivSeries,
          ivSource,
          ivRule: ivFromPayout(payoutNow).rule,
          realizedUpProbPct: realizedUpProb(candles, 100),
        })
      }

      // Randomness audit: descriptive statistics on the raw price feed
      // itself (step size, return volatility/skew/kurtosis, update cadence)
      // - a feed-behavior characterization, not a prediction tool. Uses
      // real sub-candle ticks when the sidecar's buffer has enough samples,
      // otherwise falls back to the finest candle resolution ('5s') and
      // says so via dataSource.
      if (path === '/randomness_audit') {
        const asset = q.get('asset') ?? market.activeAsset
        const { points, dataSource } = await market.getTickSeries(asset)
        const stepStats = computeStepStats(points)
        const intervalStats = computeIntervalStats(points)
        return json(200, { ok: true, asset, dataSource, stepStats, intervalStats })
      }

      // ---------- OTC defense: GET reads (run is POST-only) ----------
      if (path === '/otc_status') {
        const guard = kernel.context().use<OtcGuardService>('otcGuard')
        const asset = q.get('asset') ?? market.activeAsset
        const strategyKey = q.get('strategy') ?? 'confluence-core'
        return json(200, { ok: true, ...guard.statusFor(asset, strategyKey) })
      }

      if (path === '/otc_verdicts') {
        const guard = kernel.context().use<OtcGuardService>('otcGuard')
        return json(200, { ok: true, verdicts: guard.listVerdicts(Math.min(Number(q.get('limit') ?? 50), 200)) })
      }

      if (path === '/otc_config') {
        const guard = kernel.context().use<OtcGuardService>('otcGuard')
        return json(200, { ok: true, config: guard.getConfig() })
      }

      // OTC FEED FORENSICS - the fair-coin drift probe. The placebo trial
      // (above) can never see a persistent drift: its synthetic twins
      // inherit the pair's own return pool, so drift is calibrated away by
      // construction. This route asks the complementary question directly:
      // does the candle direction deviate from 50/50, and is that deviation
      // PERSISTENT (hour after hour)? A drifting OTC feed is the one place
      // where "predict the next move" has an honest yes answer - and the
      // drift-follower rule that exploits it needs THIS test + a
      // drift-neutral placebo run, not TA.
      if (path === '/otc_forensics') {
        const asset = q.get('asset') ?? market.activeAsset
        const tfv = (q.get('tf') ?? '1m') as Timeframe
        const limit = Math.max(300, Math.min(5000, Number(q.get('limit') ?? 2000)))
        // FORENSICS MUST READ THE BROKER'S OWN FEED: kernel memory can hold
        // sim-seeded history for never-watched assets (fresh boot = sim feed
        // until adoption), which would poison the probe. Honest chain:
        // live sidecar pull > passive harvest archive (recorded REAL live
        // feed, minutes fresh via the harvester's live thread) > memory.
        let dataSource: 'sidecar' | 'harvest' | 'active-feed'
        let candles = await market.fetchSidecarCandles(asset, tfv, limit)
        dataSource = 'sidecar'
        if (candles.length < 300) {
          candles = loadOtcHarvest(asset, limit)
          dataSource = 'harvest'
        }
        if (candles.length < 300) {
          candles = market.getCandles(asset, tfv, limit)
          dataSource = 'active-feed'
        }
        if (candles.length < 300) {
          return json(400, { ok: false, error: `thin history on ${asset} ${tfv} (${candles.length} candles) - warm the feed first (open the chart, log into IQ, or run the otc harvester)` })
        }
        const n = candles.length
        // TRANSITION CENSUS - flat-aware by design. An all-transitions up-rate
        // confounds the FLAT-CANDLE MASS with drift: a feed where 17.8% of
        // closes don't move (BONKUSD-OTC's 5e-6 grid) and decided moves are a
        // perfect 50/50 coin still reads "up-rate 41%, z -7" vs the naive
        // 50% bar. That false drift then flows into the tradeable backtest as
        // flat=push (EV 0), not a win - the majority side wins only ~41% and
        // LOSES at 0.82 payout. Directional drift must therefore be measured
        // on DECIDED transitions only (up vs down among non-flats).
        let upT = 0
        let downT = 0
        let flatT = 0
        for (let i = 1; i < n; i++) {
          const d = candles[i].close - candles[i - 1].close
          if (d > 0) upT++
          else if (d < 0) downT++
          else flatT++
        }
        const T = n - 1
        const upCC = upT / T
        const flatRate = flatT / T
        const dec = upT + downT
        const decUp = upT / Math.max(1, dec)
        const upOC = candles.filter((c) => c.close > c.open).length / n
        const z = (r: number, m: number) => (r - 0.5) / Math.sqrt(0.25 / m)
        const zCC = z(upCC, T) // all-transitions z - KEPT FOR CONTINUITY ONLY, flat-confounded
        const zDec = z(decUp, dec) // THE honest directional test
        const zOC = z(upOC, n)
        // rolling regime: last 500 candles, decided-only
        const roll = candles.slice(-500)
        let rollUp = 0
        let rollDown = 0
        for (let i = 1; i < roll.length; i++) {
          const d = roll[i].close - roll[i - 1].close
          if (d > 0) rollUp++
          else if (d < 0) rollDown++
        }
        const rollDec = rollUp + rollDown
        const upRoll = rollUp / Math.max(1, rollDec)
        const zRoll = z(upRoll, Math.max(1, rollDec))
        // hourly persistence: per-hour DECIDED-side z's, sign consistency
        const byHour = new Map<number, { up: number; down: number }>()
        for (let i = 1; i < n; i++) {
          const d = candles[i].close - candles[i - 1].close
          if (d === 0) continue
          const h = Math.floor(candles[i].time / 3600)
          const b = byHour.get(h) ?? { up: 0, down: 0 }
          if (d > 0) b.up++
          else b.down++
          byHour.set(h, b)
        }
        const hours = [...byHour.entries()].filter(([, b]) => b.up + b.down >= 30)
        const hz = hours.map(([, b]) => z(b.up / (b.up + b.down), b.up + b.down))
        // 60-candle hours only give a true 0.41-drift hourly z ~ -1.4, so an
        // 'extreme hour' bar of 2.0 would never fire - judge persistence by
        // SIGN CONSISTENCY across hours, not per-hour extremity
        const negFrac = hz.filter((v) => v < 0).length / Math.max(1, hz.length)
        const posFrac = 1 - negFrac
        const consistent = hz.length >= 8 && (negFrac >= 0.6 || posFrac >= 0.6)
        // dominant price grid: the COARSEST candidate covering >=95% of
        // closes (finest-first would always match a dust-level grid)
        let grid = 0
        let gridCov = 0
        for (const g of [1e-3, 5e-4, 2e-4, 1e-4, 5e-5, 2e-5, 1e-5, 5e-6, 2e-6, 1e-6]) {
          const cov = candles.filter((c) => Math.abs(Math.round(c.close / g) * g - c.close) < 1e-9).length / n
          if (cov >= 0.95) {
            grid = g
            gridCov = cov
            break
          }
        }
        // FEED AUTHENTICITY - vol-memory fingerprint (Task 53 contrast).
        // Real markets carry volatility clustering (|r| autocorr ~0.25,
        // Ljung-Box p ~ 0) and session rhythm; the OTC generator emits IID
        // steps (|r| acf ~ 0.003-0.007, LB p > 0.3, flat hourly profile).
        // This detector FIRED on real EURUSD/GBPUSD (LB p~0, runs-z +3.3)
        // and stayed silent on OTC - a VALIDATED synthetic-feed tell. It is
        // a descriptive diagnostic, NOT a trade gate (edge verdicts gate);
        // it tells you what kind of feed you are on, and would instantly
        // flag a generator upgrade (vol memory appearing where there was
        // none). Math: LB Q = N(N+2) * sum(rho_k^2/(N-k)), chi2(10) p-value
        // via Wilson-Hilferty normal approx + Abramowitz-Stegun erf.
        const absSteps: number[] = []
        for (let i = 1; i < n; i++) absSteps.push(Math.abs(candles[i].close - candles[i - 1].close))
        const NA = absSteps.length
        const mA = absSteps.reduce((s, v) => s + v, 0) / Math.max(1, NA)
        const dev = absSteps.map((v) => v - mA)
        const c0 = dev.reduce((s, v) => s + v * v, 0)
        const rho = (k: number) =>
          c0 > 0 ? dev.slice(k).reduce((s, v, i) => s + v * dev[i], 0) / c0 : 0
        const acf1 = rho(1)
        let Q = 0
        for (let k = 1; k <= 10; k++) {
          const rk = rho(k)
          Q += (rk * rk) / (NA - k)
        }
        Q = NA * (NA + 2) * Q
        const whZ = (Qv: number, k: number) =>
          (Math.cbrt(Qv / k) - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k))
        const phi = (x: number) => {
          const t = 1 / (1 + 0.2316419 * Math.abs(x))
          const poly =
            t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
          const cdf = 1 - poly * Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
          return x >= 0 ? cdf : 1 - cdf
        }
        const lbP = Math.max(0, Math.min(1, 1 - phi(whZ(Q, 10))))
        // hourly |step| profile spread (session rhythm proxy, context only)
        const byHourVol = new Map<number, { s: number; c: number }>()
        for (let i = 1; i < n; i++) {
          const h = Math.floor(candles[i].time / 3600)
          const b = byHourVol.get(h) ?? { s: 0, c: 0 }
          b.s += Math.abs(candles[i].close - candles[i - 1].close)
          b.c++
          byHourVol.set(h, b)
        }
        const hourVols = [...byHourVol.values()].filter((b) => b.c >= 30).map((b) => b.s / b.c)
        let hourSpread = 0
        if (hourVols.length >= 8) {
          const sorted = [...hourVols].sort((a, b) => a - b)
          const p01 = sorted[Math.floor(sorted.length * 0.01)]
          const p99 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99))]
          hourSpread = p01 > 0 ? p99 / p01 : 0
        }
        // Verdict rule (calibrated on the Task 53 contrast, n=31k): real
        // feeds read |r| acf1 0.24+ (10-sigma above zero), OTC pairs read
        // 0.004-0.028 - inside the +-0.045 noise floor at the kernel's
        // n~2000 window. LB p is REPORTED but does not gate: the joint
        // 10-lag test is fragile at n~2000 (marginal 0.02-0.05 pops are
        // expected noise); the lag-1 acf against the 0.05 floor is the
        // robust separator at this scale.
        const authenticity =
          acf1 >= 0.1 && lbP <= 0.01
            ? 'real-like'
            : Math.abs(acf1) <= 0.05
              ? 'synthetic-like'
              : 'inconclusive'
        // Drift verdict: DECIDED-side z (flat-aware), rolling agreement +
        // hourly sign consistency. The all-transitions zCC is reported for
        // transparency but deliberately NOT used for the verdict.
        const drift =
          Math.abs(zDec) >= 4 && Math.sign(zRoll) === Math.sign(zDec) && consistent
            ? zDec < 0 ? 'drift_down' : 'drift_up'
            : Math.abs(zDec) >= 2.5 ? 'suggestive' : 'none'
        const breakeven = 100 / 1.82 // worst-case payout 0.82 -> win rate needed
        return json(200, {
          ok: true,
          asset, tf: tfv, n, dataSource,
          upRateClose: +upCC.toFixed(4), zClose: +zCC.toFixed(2),
          flatRate: +flatRate.toFixed(4),
          decided: { share: +(dec / T).toFixed(4), upRate: +decUp.toFixed(4), z: +zDec.toFixed(2) },
          upRateOpen: +upOC.toFixed(4), zOpen: +zOC.toFixed(2),
          rolling500: { upRate: +upRoll.toFixed(4), z: +zRoll.toFixed(2) },
          persistence: { hours: hours.length, negFrac: +negFrac.toFixed(2), posFrac: +posFrac.toFixed(2), consistent },
          lattice: { grid, gridCov: +gridCov.toFixed(4) },
          authenticity: {
            absAcf1: +acf1.toFixed(4),
            ljungBoxP: +lbP.toFixed(4),
            nAbs: NA,
            hourSpread: +hourSpread.toFixed(2),
            verdict: authenticity,
          },
          drift,
          summary:
            drift === 'drift_down' || drift === 'drift_up'
              ? `PERSISTENT ${drift === 'drift_down' ? 'DOWN' : 'UP'} drift on DECIDED moves: ${(decUp * 100).toFixed(1)}% of non-flat transitions settle ${drift === 'drift_down' ? 'down' : 'up'} (z ${zDec.toFixed(1)} over ${dec} decided), rolling-500 agrees, hourly signs ${Math.max(negFrac, posFrac) * 100 | 0}% consistent. Flat mass here is ${(flatRate * 100).toFixed(1)}% - all-transitions up-rate ${(upCC * 100).toFixed(1)}% OVERSTATES the lean. A drift-following rule bets the majority side of DECIDED moves; re-probe each session - generator regimes can end without notice.`
              : drift === 'suggestive'
                ? `Mild decided-side ${zDec < 0 ? 'down' : 'up'} lean (z ${zDec.toFixed(1)} over ${dec} decided moves) - not persistent enough to trade; keep monitoring. Flat rate ${(flatRate * 100).toFixed(1)}%; all-transitions up-rate ${(upCC * 100).toFixed(1)}% (z ${zCC.toFixed(1)}) is flat-confounded, do not trade on it alone.`
                : `No flat-aware directional drift: decided moves split ${(decUp * 100).toFixed(1)}/${((1 - decUp) * 100).toFixed(1)} (z ${zDec.toFixed(1)} over ${dec} decided) - the ${breakeven.toFixed(1)}% breakeven at 0.82 payout is out of reach. Flat rate ${(flatRate * 100).toFixed(1)}% explains the raw up-rate ${(upCC * 100).toFixed(1)}%: flats make a fair coin read as drift. ${Math.abs(zCC) >= 2.5 && Math.abs(zDec) < 2.5 ? 'The naive all-transitions test WOULD have flagged this pair - that flag was the flat-mass artifact.' : ''}`,
          testedAt: Math.floor(Date.now() / 1000),
        })
      }

      // ---------- OTC TWIN (Task 54): the recovered broker generator, ours ----------
      // Tasks 52+53 reverse-engineered the OTC engine's statistical spec:
      // iid near-Gaussian steps, fair-coin signs, per-pair sigma, decimal
      // lattice, CSPRNG-class ordering, NO vol clustering / session rhythm /
      // bid-ask bounce. This endpoint IMPLEMENTS that spec, calibrated to the
      // pair's own feed - the honest "works like them": a stream that is the
      // same statistical animal as the broker's. Any strategy showing "edge"
      // on the twin is by definition an artifact; edge on the real feed that
      // cannot beat this twin's placebo distribution is the same thing. The
      // twin MUST self-test synthetic-like - if the REAL feed ever stops
      // reading that way, the broker changed generators and the prediction
      // case re-opens with new evidence. Full story: src/analytics/otcTwin.ts.
      if (path === '/otc_twin') {
        const asset = q.get('asset') ?? market.activeAsset
        const tfv = (q.get('tf') ?? '1m') as Timeframe
        const nTwin = Math.max(50, Math.min(5000, Number(q.get('n') ?? 500)))
        const payout = Math.max(0.1, Math.min(1.5, Number(q.get('payout') ?? 0.82)))
        // calibrate from the pair's own OTC feed via the SAME honest chain as
        // forensics (sidecar live > harvest archive > kernel memory)
        let dataSource: 'sidecar' | 'harvest' | 'active-feed'
        let src = await market.fetchSidecarCandles(asset, tfv, 2000)
        dataSource = 'sidecar'
        if (src.length < 300) {
          src = loadOtcHarvest(asset, 2000)
          dataSource = 'harvest'
        }
        if (src.length < 300) {
          src = market.getCandles(asset, tfv, 2000)
          dataSource = 'active-feed'
        }
        if (src.length < 300) {
          return json(400, { ok: false, error: `thin history on ${asset} ${tfv} (${src.length} candles) - warm the feed first` })
        }
        const params = estimateTwinParams(src)
        if (!params) {
          return json(400, { ok: false, error: 'could not calibrate twin (degenerate steps or lattice on this pair)' })
        }
        // seed=<int> switches to mulberry32 for an AUDITABLE (reproducible)
        // run; default is CSPRNG-class, matching the broker's security class
        const seedRaw = q.get('seed')
        const seed = seedRaw !== null && seedRaw !== '' ? Math.abs(Math.floor(Number(seedRaw))) || 1 : undefined
        const twin = generateOtcTwin(params, nTwin, tfSeconds(tfv), { seed })
        // THE payout math that owns this market (no signal can):
        // breakeven win rate = 1/(1+payout); a fair coin's EV = (payout-1)/2
        const breakeven = 1 / (1 + payout)
        const fairEv = (payout - 1) / 2
        return json(200, {
          ok: true,
          asset, tf: tfv,
          spec: 'iid near-Gaussian steps; fair-coin signs; per-pair sigma; decimal lattice; CSPRNG-class ordering; NO vol clustering / session structure / bid-ask bounce (recovered in Tasks 52+53)',
          calibration: {
            dataSource,
            sourceN: params.sourceN,
            p0: params.p0,
            sigmaPerStep: +params.sigmaPerStep.toPrecision(6),
            lattice: params.lattice,
            sourceFlatRate: +params.flatRate.toFixed(4),
            stallProb: +params.stallProb.toFixed(4),
            meanAbsStep: +params.meanAbsStep.toPrecision(6),
          },
          rngMode: twin.rngMode,
          seed: twin.seed,
          selfTest: twin.selfTest,
          twin: twin.candles,
          evMath: {
            payout,
            breakevenWinRate: +breakeven.toFixed(4),
            fairCoinEvPerUnitStake: +fairEv.toFixed(4),
            note: `A fair coin wins 50% < ${(breakeven * 100).toFixed(1)}% breakeven at ${payout} payout -> EV ${(fairEv * 100).toFixed(1)}%/trade. On an iid feed no signal exists; the only reliable winner is the payout spread itself (the house).`,
          },
        })
      }

      // OTC Micro-Tick Velocity Footprint: per-minute price-row matrix of
      // up/down tick speeds, velocity delta, speed ratio, POC cluster
      // stagnation and the divergence/exhaustion reads. GET for the chart,
      // POST for copilot/tools.
      if (path === '/otc_footprint') {
        const fp = kernel.context().use<OtcFootprintService>('otcFootprint')
        const asset = q.get('asset') ?? market.activeAsset
        const minutes = Math.max(1, Math.min(240, Number(q.get('minutes') ?? 30)))
        const bucketSec = Math.max(5, Math.min(3600, Number(q.get('bucketSec') ?? 60)))
        return json(200, { ok: true, ...(await fp.footprint(asset, { minutes, bucketSec })) })
      }

      if (path === '/analysis') {
        const t = tfStrict(q.get('tf'))
        if (t === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const asset = q.get('asset') ?? market.activeAsset
        const result = analytics.analyze(asset, t, q.get('force') === '1')
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
                  pDown: Math.round(a.markov.probDown * 1000) / 1000,
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

      // Chart-signal scanner: the chart-type engines (renko / P&F / range /
      // tick / footprint-or-otcfootprint / Heikin Ashi / candlestick math)
      // vote per open instrument; every qualifying read comes back (the
      // whole open universe is scanned - no cap), each with a TTL so stale
      // reads disappear. `top` is an optional read-time cut for callers that
      // want a short list; default is all. kind=option adds a suggested
      // expiry; kind=cfd adds entry/SL/TP levels.
      if (path === '/signals') {
        const kind = q.get('kind') === 'cfd' ? 'cfd' : 'option'
        const topRaw = Number(q.get('top') ?? 0)
        const top = Number.isFinite(topRaw) ? Math.max(0, Math.min(Math.floor(topRaw), 200)) : 0
        const tfv = tfStrict(q.get('tf'))
        if (tfv === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        return json(200, await kernel.context().use<ChartSignalsService>('chartSignals').scan(kind, top, tfv))
      }

      // Same-time-yesterday scanner: for every open instrument, what was the
      // market doing EXACTLY 24h ago - and in the window right after? Each
      // row carries the price at that moment, the forward window's net move /
      // range / run-up / drawdown, where price has gone since, the session
      // the market was in, window coverage (bars found vs expected, and how many
      // came from the store) so a thin or synthetic "yesterday" is visible
      // instead of silently mistaken for a remembered one, and the ECHO - the
      // lead-in window ending at the same wall-clock moment, yesterday vs
      // today, scored 0..100 for rhyme. tf respects
      // the chart's timeframe (same rule as /signals); the cache is per
      // tf:window - the T-24h target crawls, so 60s serves rapid panel polls.
      if (path === '/yesterday') {
        const tfv = tfStrict(q.get('tf'))
        if (tfv === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const winRaw = Number(q.get('window') ?? 60)
        const windowMin = Number.isFinite(winRaw) ? Math.max(5, Math.min(Math.round(winRaw), 240)) : 60
        const plan = YesterdayService.plan(tfv, windowMin)
        if (!plan.ok) {
          return json(400, {
            ok: false,
            error: `tf "${tfv}" cannot reach 24h + the replay window back within the ${plan.needed}-bar lookback limit (4000-bar archive depth) - use 30s or coarser`,
          })
        }
        return json(200, await kernel.context().use<YesterdayService>('yesterday').scan(tfv, windowMin))
      }

      // Outcome stats for the chart signals: every qualifying read is
      // resolved at its own suggested expiry (CFD plans on first sampled
      // TP/SL touch within a 15-min horizon) - win rates per kind, per
      // engine and real-vs-OTC, so the panel shows what the charts
      // actually delivered, not just what they claim.
      if (path === '/signals_stats') {
        // optional tf filter - the panel passes the chart's timeframe so the
        // hit-rate view scores reads computed on THOSE candles; no tf = all
        // timeframes blended (research reads the whole loop)
        const tfq = q.get('tf')
        let tfFilter: Timeframe | undefined
        if (tfq !== null) {
          const v = tfStrict(tfq)
          if (v === null) return json(400, { ok: false, error: tfErr(tfq) })
          tfFilter = v
        }
        return json(200, { ok: true, ...kernel.context().use<ChartSignalsService>('chartSignals').stats(tfFilter), ts: Date.now() })
      }

      // Engine-edge research: "which chart engines actually carry an edge?"
      // merges BOTH feedback loops in one read -
      //   (1) the live honesty loop (64-c): every Signal-Panel read is
      //       resolved at its own expiry and attributed per engine, so the
      //       live column shows what the charts actually delivered;
      //   (2) the lab loop (64-d): every minable engine vote replayed as an
      //       ad-hoc EngineVoteSignal spec through the lab's own binary
      //       settlement engine (backtest()) over each selected asset's
      //       trailing candles, pooled per engine+direction and scored with
      //       a Wilson 95% interval against the payout breakeven.
      // Verdicts: edge (Wilson LB clears breakeven by +2pts on >= minN
      // trades) / watch (winRate above breakeven, LB not there yet) / thin
      // (n < minN) / coinflip / fade (Wilson UB BELOW breakeven - the engine
      // is confidently worse than a coin, so the INVERTED vote is a research
      // candidate). otcfootprint appears live-only: its tick buffer cannot
      // be rebuilt from OHLC history, so the lab loop can never mine it.
      if (path === '/engines_edge') {
        const tfv = tfStrict(q.get('tf'))
        if (tfv === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const win = Math.max(240, Math.min(Number(q.get('window') ?? 420) || 420, 600))
        const expBars = Math.max(1, Math.min(Number(q.get('expiryBars') ?? 1) || 1, 5))
        const payout = Math.max(0.5, Math.min(Number(q.get('payout') ?? 0.85) || 0.85, 0.98))
        const minN = Math.max(10, Math.min(Number(q.get('minN') ?? 30) || 30, 200))
        const breakeven = 100 / (1 + payout)

        // asset selection: requested tickers (capped 6) or active-first open set (3)
        const wanted = (q.get('assets') ?? '')
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
          .slice(0, 6)
        const open = searchInstruments('', 'all').filter((i) => i.open)
        const active = market.activeAsset
        let picks = wanted.map((t) => open.find((i) => i.ticker === t)).filter((i): i is (typeof open)[number] => !!i)
        if (!picks.length) {
          picks = [...open]
            .sort((a, b) => (a.ticker === active ? -1 : b.ticker === active ? 1 : 0))
            .slice(0, 3)
        }

        // (1) live honesty loop - per engine, per kind
        interface LiveEngineStat { votes: number; hits: number; winRate: number | null }
        interface LiveEngineRow { option?: LiveEngineStat; cfd?: LiveEngineStat }
        const liveStats = kernel.context().use<ChartSignalsService>('chartSignals').stats()
        const liveOf = new Map<string, LiveEngineRow>()
        for (const kind of ['option', 'cfd'] as const) {
          for (const e of liveStats[kind].engines) {
            const row = liveOf.get(e.engine) ?? {}
            row[kind] = { votes: e.votes, hits: e.hits, winRate: e.winRate }
            liveOf.set(e.engine, row)
          }
        }

        // (2) lab loop - engine votes through the lab's settlement engine
        interface HistRow { asset: string; n: number; wins: number; winRate: number; netPnl: number; pf: number }
        interface DirAgg { n: number; wins: number; rows: HistRow[] }
        const hist = new Map<ChartEngineId, { call: DirAgg; put: DirAgg }>()
        for (const engine of MINABLE_ENGINES) {
          hist.set(engine, { call: { n: 0, wins: 0, rows: [] }, put: { n: 0, wins: 0, rows: [] } })
        }
        for (const info of picks) {
          let candles: Candle[] = []
          try {
            candles = market.getCandlesDeep(info.ticker, tfv, win, true)
          } catch {
            continue
          }
          if (candles.length < 80) continue // thin history - no honest walk
          for (const engine of MINABLE_ENGINES) {
            for (const dir of ['call', 'put'] as const) {
              const spec: CustomSpec = {
                name: `research:${engine}:${dir}`,
                signals: [{ kind: 'engine', engine, dir, weight: 1 }],
                minScore: 0,
                minVotes: 1,
                horizon: expBars,
              }
              try {
                const r = backtest(candles, info.ticker, tfv, {
                  strategy: 'custom:research-engine-vote',
                  customSpec: spec,
                  mode: 'binary',
                  payout,
                  expiryBars: expBars,
                  amount: 10,
                  warmupBars: 60, // engines self-gate at their own 40-candle floor
                })
                const m = r.metrics
                if (m.totalTrades > 0) {
                  const agg = hist.get(engine)![dir]
                  agg.n += m.totalTrades
                  agg.wins += m.wins
                  agg.rows.push({
                    asset: info.ticker,
                    n: m.totalTrades,
                    wins: m.wins,
                    winRate: Math.round(m.winRate * 10) / 10,
                    netPnl: Math.round(m.netPnl * 100) / 100,
                    pf: Math.round(m.profitFactor * 100) / 100,
                  })
                }
              } catch {
                /* one engine failing never blanks the report */
              }
            }
          }
        }

        interface DirOut {
          dir: 'call' | 'put'
          n: number
          wins: number
          winRate: number | null
          edgeLB: number | null
          assets: HistRow[]
        }
        interface EngineOut {
          engine: ChartEngineId | string
          label: string
          verdict: string
          n: number
          winRate: number | null
          wilsonLB: number | null
          wilsonUB: number | null
          edgeLB: number | null
          live: LiveEngineRow
          byDir: DirOut[]
        }
        const enginesOut: EngineOut[] = [...hist.entries()].map(([engine, agg]) => {
          const decided = agg.call.n + agg.put.n
          const wins = agg.call.wins + agg.put.wins
          const [lb, ub] = wilsonPct(wins, decided)
          const byDir: DirOut[] = (['call', 'put'] as const).map((d) => {
            const a = agg[d]
            const [dlb] = wilsonPct(a.wins, a.n)
            return {
              dir: d,
              n: a.n,
              wins: a.wins,
              winRate: a.n ? Math.round((a.wins / a.n) * 1000) / 10 : null,
              edgeLB: a.n ? Math.round((dlb - breakeven) * 10) / 10 : null,
              assets: [...a.rows].sort((x, y) => y.n - x.n).slice(0, 3),
            }
          })
          let verdict: string
          if (!decided) verdict = 'no-data'
          else if (decided < minN) verdict = 'thin'
          else if (lb >= breakeven + 2) verdict = 'edge'
          else if (ub <= breakeven - 2) verdict = 'fade'
          else if (wins / decided > breakeven / 100) verdict = 'watch'
          else verdict = 'coinflip'
          return {
            engine,
            label: ENGINE_LABEL[engine],
            verdict,
            n: decided,
            winRate: decided ? Math.round((wins / decided) * 1000) / 10 : null,
            wilsonLB: decided ? Math.round(lb * 10) / 10 : null,
            wilsonUB: decided ? Math.round(ub * 10) / 10 : null,
            edgeLB: decided ? Math.round((lb - breakeven) * 10) / 10 : null,
            live: liveOf.get(engine) ?? {},
            byDir,
          }
        })
        // live loop knows the OTC velocity footprint even though OHLC
        // history can never mine it - surface it as a live-only row
        for (const [engine, lv] of liveOf) {
          if (hist.has(engine as ChartEngineId)) continue
          enginesOut.push({
            engine,
            label: ENGINE_LABEL[engine as ChartEngineId] ?? engine,
            verdict: 'live-only',
            n: 0,
            winRate: null,
            wilsonLB: null,
            wilsonUB: null,
            edgeLB: null,
            live: lv,
            byDir: [],
          })
        }
        enginesOut.sort((a, b) => (b.edgeLB ?? -99) - (a.edgeLB ?? -99))

        // deployed knowledge: learned engine specs already in the lab store
        const labSpecs = kernel
          .context()
          .use<StrategyLabService>('lab')
          .list()
          .filter((row) => row.spec?.signals?.some((s) => s.kind === 'engine'))
          .map((row) => ({
            id: row.id,
            name: row.spec.name,
            asset: row.asset,
            tf: row.tf,
            trades: row.stats?.backtest?.trades ?? 0,
            winRate: row.stats?.backtest ? Math.round(row.stats.backtest.winRate * 10) / 10 : null,
            ciLow: row.stats?.backtest ? Math.round(row.stats.backtest.winRateCiLow * 10) / 10 : null,
            decayed: row.stats?.decayed ?? false,
          }))
          .sort((a, b) => b.trades - a.trades)
          .slice(0, 8)

        return json(200, {
          ok: true,
          tf: tfv,
          window: win,
          expiryBars: expBars,
          payout,
          breakevenWinRate: Math.round(breakeven * 100) / 100,
          minN,
          assets: picks.map((p) => p.ticker),
          engines: enginesOut,
          liveKinds: {
            option: {
              resolved: liveStats.option.resolved,
              wins: liveStats.option.wins,
              losses: liveStats.option.losses,
              winRate: liveStats.option.winRate,
              pending: liveStats.option.pending,
            },
            cfd: {
              resolved: liveStats.cfd.resolved,
              wins: liveStats.cfd.wins,
              losses: liveStats.cfd.losses,
              winRate: liveStats.cfd.winRate,
              timeouts: liveStats.cfd.timeouts,
              pending: liveStats.cfd.pending,
            },
          },
          labSpecs,
          note:
            'verdicts: edge = Wilson LB clears the payout breakeven by +2pts on >= minN trades; watch = winRate above breakeven, LB unproven; thin = n < minN; coinflip; fade = Wilson UB BELOW breakeven (inversion candidate). history = engine votes replayed through the lab binary settlement engine over trailing candles per engine x direction; live = the Signal Panel honesty loop',
          ts: Date.now(),
        })
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

      // same feed, but scored with the full 14-factor confluence engine
      // (confluenceSignalOnly/full Kalman fit) instead of the screener's
      // cheaper ouState approximation - see screener2.ts
      if (path === '/screener2') {
        const scr = kernel.context().use<Screener2Service>('screener2')
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

      if (path === '/screener2_status') {
        const scr = kernel.context().use<Screener2Service>('screener2')
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
        const store = kernel.context().use<{ archiveStats: () => unknown; archiveStatsForAsset: (asset: string) => unknown }>('storeRaw')
        const asset = q.get('asset')
        return json(200, {
          ok: true,
          stats: store.archiveStats(),
          // targeted per-asset breakdown - the global `stats.top` above only
          // lists the busiest 12 asset|tf keys, so a thin instrument can be
          // entirely absent from it despite having real archived bars at
          // some timeframe. Pass ?asset= to actually answer "does asset X
          // have data at tf Y" instead of guessing from the top-12 list.
          ...(asset ? { assetStats: store.archiveStatsForAsset(asset.toUpperCase()) } : {}),
        })
      }


      if (path === '/signal') {
        const t = tfStrict(q.get('tf'))
        if (t === null) return json(400, { ok: false, error: tfErr(q.get('tf')) })
        const asset = q.get('asset') ?? market.activeAsset
        const a = analytics.analyze(asset, t)
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

      if (path === '/research_gate') {
        const bots = kernel.context().use<AutopilotService>('autopilot')
        return json(200, { ok: true, enabled: bots.getResearchGateEnabled() })
      }
    }

    if (req.method === 'POST') {
      // ---------- OTC defense (placebo-test gate for generator-driven markets) ----------
      // OTC charts are machine-generated; TA "edges" there can be pure luck.
      // This runs the strategy against K synthetic twins calibrated to the
      // pair's own measured statistics - if real performance doesn't beat the
      // placebo distribution, there is no edge to defend. See
      // plugins/otcguard.ts for verdict/policy semantics.
      if (path === '/otc_defense_run') {
        try {
          const guard = kernel.context().use<OtcGuardService>('otcGuard')
          const report = await guard.runDefense({
            asset: body.asset !== undefined ? String(body.asset) : market.activeAsset,
            strategyId: body.strategyId !== undefined ? String(body.strategyId) : 'confluence-core',
            tf: body.tf !== undefined ? String(body.tf) : '1m',
            params: body.params as Record<string, number | string> | undefined,
            k: body.k !== undefined ? Number(body.k) : undefined,
            payout: body.payout !== undefined ? Number(body.payout) : undefined,
            expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : undefined,
            limit: body.limit !== undefined ? Number(body.limit) : undefined,
            seedBase: body.seedBase !== undefined ? Number(body.seedBase) : undefined,
            driftNeutral: body.driftNeutral === undefined ? undefined : !!body.driftNeutral,
          })
          return json(200, report satisfies OtcDefenseReport)
        } catch (err) {
          return json(400, { ok: false, error: String(err instanceof Error ? err.message : err) })
        }
      }

      if (path === '/otc_config') {
        const guard = kernel.context().use<OtcGuardService>('otcGuard')
        try {
          return json(200, { ok: true, config: guard.setConfig((body ?? {}) as Record<string, never>) })
        } catch (err) {
          return json(400, { ok: false, error: String(err instanceof Error ? err.message : err) })
        }
      }

      // POST variant of the velocity footprint read (copilot tools + scripts)
      if (path === '/otc_footprint') {
        try {
          const fp = kernel.context().use<OtcFootprintService>('otcFootprint')
          return json(200, {
            ok: true,
            ...(await fp.footprint(String(body.asset ?? market.activeAsset), {
              minutes: body.minutes !== undefined ? Math.max(1, Math.min(240, Number(body.minutes))) : undefined,
              bucketSec: body.bucketSec !== undefined ? Math.max(5, Math.min(3600, Number(body.bucketSec))) : undefined,
              minDelta: body.minDelta !== undefined ? Number(body.minDelta) : undefined,
              ratioAt: body.ratioAt !== undefined ? Number(body.ratioAt) : undefined,
              stagnationAt: body.stagnationAt !== undefined ? Number(body.stagnationAt) : undefined,
            })),
          })
        } catch (err) {
          return json(400, { ok: false, error: String(err instanceof Error ? err.message : err) })
        }
      }

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
        try {
          const strategyId = String(body.strategy ?? 'confluence-core')
          const out = gridSearch(market.getCandlesDeep(String(body.asset ?? market.activeAsset), tf(String(body.tf ?? '1m') as string), 2200), String(body.asset ?? market.activeAsset), tf(String(body.tf ?? '1m') as string), {
            strategy: strategyId,
            sweep: (body.sweep as Record<string, { from: number; to: number; step: number }>) ?? {},
            fixedParams: (body.params as Record<string, number | string>) ?? {},
            objective: (body.objective as Objective) ?? 'netPnl',
            // Raised from 8: 8 trades is far too small a sample to trust a
            // ranking decision on (see FastMetrics.winRateCiLow/High - at n=8 the
            // 95% CI on win rate typically spans 40+ points). 20 is a more
            // defensible professional floor; still fully overridable by the caller.
            minTrades: body.minTrades !== undefined ? Number(body.minTrades) : 20,
            maxCombos: body.maxCombos !== undefined ? Number(body.maxCombos) : 240,
            top: body.top !== undefined ? Number(body.top) : 20,
            payout: body.payout !== undefined ? Number(body.payout) : 0.85,
            amount: body.amount !== undefined ? Number(body.amount) : 10,
            expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : 1,
            startEquity: body.startEquity !== undefined ? Number(body.startEquity) : 1000,
            // Round-trip cost modeling - all opt-in, 0 by default (unchanged
            // behavior unless the caller explicitly asks for spread/slippage/
            // commission to be simulated).
            spreadPct: body.spreadPct !== undefined ? Number(body.spreadPct) : 0,
            slippagePct: body.slippagePct !== undefined ? Number(body.slippagePct) : 0,
            commissionPct: body.commissionPct !== undefined ? Number(body.commissionPct) : 0,
            customSpec: resolveCustomSpec(strategyId),
            direction: directionOf(body),
            edgeTrigger: Boolean(body.edgeTrigger),
          })
          return json(200, { ok: true, result: out })
        } catch (err) {
          return json(400, { ok: false, error: (err as Error).message })
        }
      }

      if (path === '/walkforward') {
        try {
        const strategyId = String(body.strategy ?? 'rsi-reversion')
        const out = walkForward(market.getCandlesDeep(String(body.asset ?? market.activeAsset), tf(String(body.tf ?? '1m') as string), 2200), String(body.asset ?? market.activeAsset), tf(String(body.tf ?? '1m') as string), {
          strategy: strategyId,
          sweep: (body.sweep as Record<string, { from: number; to: number; step: number }>) ?? {},
          fixedParams: (body.params as Record<string, number | string>) ?? {},
          objective: (body.objective as Objective) ?? 'netPnl',
          // Raised from 6: each walk-forward fold's OOS sample is inherently
          // small, so 10 is a pragmatic floor between "too few for the fold to
          // ever pass" and "too few to trust" - still overridable.
          minTrades: body.minTrades !== undefined ? Number(body.minTrades) : 10,
          maxCombos: body.maxCombos !== undefined ? Number(body.maxCombos) : 120,
          folds: body.folds !== undefined ? Number(body.folds) : 3,
          isRatio: body.isRatio !== undefined ? Number(body.isRatio) : 0.7,
          payout: body.payout !== undefined ? Number(body.payout) : 0.85,
          amount: body.amount !== undefined ? Number(body.amount) : 10,
          expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : 1,
          startEquity: body.startEquity !== undefined ? Number(body.startEquity) : 1000,
          spreadPct: body.spreadPct !== undefined ? Number(body.spreadPct) : 0,
          slippagePct: body.slippagePct !== undefined ? Number(body.slippagePct) : 0,
          commissionPct: body.commissionPct !== undefined ? Number(body.commissionPct) : 0,
          customSpec: resolveCustomSpec(strategyId),
          direction: directionOf(body),
          edgeTrigger: Boolean(body.edgeTrigger),
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
        } catch (err) {
          return json(400, { ok: false, error: (err as Error).message })
        }
      }

      if (path === '/asset_sweep') {
        try {
        const wanted = Array.isArray(body.assets) ? (body.assets as string[]) : null
        const category = body.category ? String(body.category) : null
        let pool = market.assets
        if (wanted && wanted.length) pool = pool.filter((a) => wanted.includes(a.ticker))
        else if (category && category !== 'all') pool = pool.filter((a) => (category === 'otc' ? a.otc : a.category === category))
        const openOnly = body.openOnly === undefined ? true : Boolean(body.openOnly)
        if (openOnly) pool = pool.filter((a) => a.open)
        const sweepTf = tf(String(body.tf ?? '1m') as string)
        const sweepStrategyId = String(body.strategy ?? 'confluence-core')
        const provStore = kernel.context().use<{ archiveBounds: (asset: string, tf: string) => { oldest: number; newest: number; n: number } | null }>('storeRaw')
        const out = sweepAssets(
          pool.map((a) => ({ ticker: a.ticker, category: a.category, open: a.open, payout: a.payout })),
          (asset) => market.getCandlesDeep(asset, sweepTf, 1200),
          sweepTf,
          {
            // Lets each row report liveDataPct: what share of the candles it
            // was actually tested on are real archived bars vs the market
            // simulator's deterministic synthetic fill (see store.archiveBounds
            // and market-data.ts's buildSeries). A thin/not-yet-live instrument
            // scoring suspiciously perfect is often just the OU/mean-reversion
            // strategy re-detecting the simulator's own mean-reverting price
            // generator rather than a real market edge - this is how that gets
            // caught instead of silently looking like a validated signal.
            provenance: (ticker) => provStore.archiveBounds(ticker, sweepTf),
            strategy: sweepStrategyId,
            params: (body.params as Record<string, number | string>) ?? undefined,
            objective: (body.objective as Objective) ?? 'netPnl',
            minTrades: body.minTrades !== undefined ? Number(body.minTrades) : 20,
            // Leave payout undefined by default so sweepAssets() can fall back to
            // each asset's own real broker payout instead of a flat 0.85 for
            // every instrument. An explicit body.payout still overrides (for an
            // apples-to-apples what-if comparison across assets).
            payout: body.payout !== undefined ? Number(body.payout) : undefined,
            amount: body.amount !== undefined ? Number(body.amount) : 10,
            expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : 1,
            startEquity: body.startEquity !== undefined ? Number(body.startEquity) : 1000,
            maxAssets: body.maxAssets !== undefined ? Number(body.maxAssets) : 40,
            spreadPct: body.spreadPct !== undefined ? Number(body.spreadPct) : 0,
            slippagePct: body.slippagePct !== undefined ? Number(body.slippagePct) : 0,
            commissionPct: body.commissionPct !== undefined ? Number(body.commissionPct) : 0,
            // Same-calendar-window comparison across assets by default; pass
            // sharedWindow:false to restore each asset's own most-recent-N-candles.
            sharedWindow: body.sharedWindow === undefined ? true : Boolean(body.sharedWindow),
            customSpec: resolveCustomSpec(sweepStrategyId),
            direction: directionOf(body),
            edgeTrigger: Boolean(body.edgeTrigger),
          }
        )
        return json(200, { ok: true, result: out })
        } catch (err) {
          return json(400, { ok: false, error: (err as Error).message })
        }
      }

      if (path === '/backtest') {
        try {
        const backtestStrategyId = String(body.strategy ?? 'confluence-core')
        const result = analytics.runBacktest(String(body.asset ?? market.activeAsset), tf(String(body.tf ?? '1m') as string), {
          strategy: backtestStrategyId,
          params: (body.params as Record<string, number | string>) ?? undefined,
          mode: (body.mode as 'binary' | 'spot') ?? 'binary',
          payout: body.payout !== undefined ? Number(body.payout) : 0.85,
          amount: body.amount !== undefined ? Number(body.amount) : 10,
          expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : 1,
          startEquity: body.startEquity !== undefined ? Number(body.startEquity) : 1000,
          tpPct: body.tpPct !== undefined ? Number(body.tpPct) : 0.4,
          slPct: body.slPct !== undefined ? Number(body.slPct) : 0.25,
          maxBars: body.maxBars !== undefined ? Number(body.maxBars) : 24,
          spreadPct: body.spreadPct !== undefined ? Number(body.spreadPct) : 0,
          slippagePct: body.slippagePct !== undefined ? Number(body.slippagePct) : 0,
          commissionPct: body.commissionPct !== undefined ? Number(body.commissionPct) : 0,
          edgeTrigger: Boolean(body.edgeTrigger),
          // Compounding replay (binary mode only) - see backtest.ts's
          // compoundStakeFor/compoundSettle, which mirror the live
          // autopilot's stakeFor/onPositionClosed roll math exactly so a
          // Backtest Lab run and a deployed compound bot agree.
          stakePlan:
            body.stakePlan && (body.stakePlan as { kind?: string }).kind === 'compound'
              ? (body.stakePlan as BacktestOptions['stakePlan'])
              : undefined,
          customSpec: resolveCustomSpec(backtestStrategyId),
          direction: directionOf(body),
        })
        return json(200, { ok: true, result })
        } catch (err) {
          return json(400, { ok: false, error: (err as Error).message })
        }
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

      if (path === '/autotrader_restart') {
        // compound stop-on-loss: revive a halted auto-trader cycle (clears halt, re-seeds pot)
        const mode = kernel.context().use<ModeService>('mode')
        return json(200, mode.restart())
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
        // default: the sidecar's Docker service address (see docker-compose.yml)
        // - only hit when the caller omits url entirely; the Settings dialog
        // always sends one now, this is just a safety fallback.
        const out = await exec.connectLive(
          String(body.url ?? 'http://iqos-sidecar:47313'),
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
        const out = await exec.adoptLive(String(body.url ?? 'http://iqos-sidecar:47313'))
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
        // force:true deliberately bypasses the research gate (no/stale/
        // non-robust walk-forward verdict) for a user who has verified the
        // edge/data themselves - never a silent bypass, always logged and
        // persisted on the bot as forcedUnvalidated so it stays visibly
        // marked everywhere the fleet is listed.
        return json(200, bots.saveBot(body as Partial<BotConfig>, { force: Boolean(body.force) }))
      }

      if (path === '/bot_delete') {
        const bots = kernel.context().use<AutopilotService>('autopilot')
        return json(200, bots.deleteBot(String(body.id ?? '')))
      }

      if (path === '/bot_toggle') {
        const bots = kernel.context().use<AutopilotService>('autopilot')
        return json(
          200,
          bots.toggleBot(String(body.id ?? ''), body.enabled === undefined ? undefined : Boolean(body.enabled), { force: Boolean(body.force) })
        )
      }

      if (path === '/bot_restart') {
        // compound stop-on-loss: revive a halted cycle (clears halt, re-seeds pot)
        const bots = kernel.context().use<AutopilotService>('autopilot')
        return json(200, bots.restartBot(String(body.id ?? '')))
      }

      if (path === '/research_gate_toggle') {
        // Global, persisted, reversible off-switch for BOTH gates (built-in
        // walk-forward and AI-Lab holdout) - user-requested. Bypassing this
        // is a deliberate choice, never a default, and every bot armed while
        // it's off is tagged forcedUnvalidated (see saveBot/toggleBot).
        const bots = kernel.context().use<AutopilotService>('autopilot')
        return json(200, bots.setResearchGateEnabled(Boolean(body.enabled)))
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
            basis: body.basis !== undefined ? String(body.basis) as CustomSpec['basis'] : undefined,
            mineCombos: body.mineCombos !== undefined ? Boolean(body.mineCombos) : undefined,
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

      if (path === '/lab_delete_all') {
        const lab = kernel.context().use<StrategyLabService>('lab')
        return json(200, lab.removeAll())
      }

      if (path === '/lab_relearn') {
        const lab = kernel.context().use<StrategyLabService>('lab')
        return json(200, lab.relearnOne(String(body.id ?? '')))
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
    console.log(
      `[trading-core] P0 security: token auth ${KERNEL_TOKEN ? 'ON (REST requires the kernel token)' : 'OFF - open REST surface, set KERNEL_TOKEN to lock down'} | rate limit ${RATE_CAPACITY} burst / ${RATE_REFILL_PER_SEC}/s per IP | audit -> data/audit.jsonl`
    )
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
