// IQAIR//OS - trading-core service
// Boots the kernel (store -> market-data -> analytics -> execution), then serves
// REST for every OS operation and socket.io for the real-time event feed.
// Port 3030. Path '/' is fixed for the Caddy gateway.

import { createServer } from 'http'
import { Server } from 'socket.io'
import { Kernel } from './src/kernel'
import { storePlugin } from './src/plugins/store'
import { marketDataPlugin, MarketDataService } from './src/plugins/market-data'
import { analyticsPlugin, AnalyticsService } from './src/plugins/analytics'
import { executionPlugin, ExecutionService, type RiskConfig } from './src/plugins/execution'
import type { Timeframe } from './src/types'

const PORT = 3030

const kernel = new Kernel()
kernel.register(storePlugin)
kernel.register(marketDataPlugin)
kernel.register(analyticsPlugin)
kernel.register(executionPlugin)

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
    return ['5s', '15s', '1m', '5m', '15m'].includes(v) ? v : '1m'
  }

  try {
    const market = kernel.context().use<MarketDataService>('market')
    const analytics = kernel.context().use<AnalyticsService>('analytics')
    const exec = kernel.context().use<ExecutionService>('execution')

    if (req.method === 'GET') {
      if (path === '/health') return json(200, { ok: true, service: 'trading-core', uptime: process.uptime() })

      if (path === '/assets') return json(200, { ok: true, assets: market.listAssets(), mode: market.mode, activeAsset: market.activeAsset })

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

      if (path === '/strategies') return json(200, { ok: true, strategies: analytics.listStrategies() })

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
    }

    if (req.method === 'POST') {
      if (path === '/asset') {
        const asset = String(body.asset ?? '')
        if (!market.assets.some((a) => a.ticker === asset)) return json(400, { ok: false, error: `unknown asset ${asset}` })
        market.activeAsset = asset
        io.emit('ui', { event: 'asset-changed', asset })
        return json(200, { ok: true, activeAsset: asset })
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

      if (path === '/run_strategy') {
        const out = analytics.runStrategy(
          String(body.asset ?? market.activeAsset),
          tf(String(body.tf ?? '1m') as string),
          String(body.strategy ?? 'confluence-core'),
          (body.params as Record<string, number | string>) ?? undefined
        )
        return json(200, { ok: true, eval: out })
      }

      if (path === '/trade') {
        const out = await exec.placeOrder({
          asset: String(body.asset ?? market.activeAsset),
          tf: tf(String(body.tf ?? '1m') as string),
          side: (body.side as 'call' | 'put') ?? 'call',
          kind: (body.kind as 'binary' | 'spot') ?? 'binary',
          amount: Number(body.amount ?? 10),
          expiryBars: body.expiryBars !== undefined ? Number(body.expiryBars) : 1,
          mode: (body.mode as 'paper' | 'live') ?? 'paper',
          tp: body.tp !== undefined ? Number(body.tp) : undefined,
          sl: body.sl !== undefined ? Number(body.sl) : undefined,
          strategy: body.strategy !== undefined ? String(body.strategy) : undefined,
          note: body.note !== undefined ? String(body.note) : undefined,
        })
        return json(200, out)
      }

      if (path === '/close') {
        const out = exec.closePosition(String(body.id ?? ''))
        return json(200, out)
      }

      if (path === '/kill_switch') {
        const out = exec.setKillSwitch(Boolean(body.on))
        return json(200, { ok: true, account: out })
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

      if (path === '/live/disconnect') {
        exec.disconnectLive()
        return json(200, { ok: true })
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
  // default path '/socket.io/' so only engine.io requests are claimed;
  // plain REST requests fall through to the handler above.
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
}).catch((err) => {
  console.error('[trading-core] kernel boot failed:', err)
  process.exit(1)
})
