import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

// IQAIR//OS - Copilot v2: a streaming agent harness.
// The LLM drives the trading-core kernel through a 20-tool loop and the run is
// streamed to the client as SSE events (say / tool_start / tool_end / ui / final).
// `ui` events are commands the CLIENT executes (switch chart, timeframe, add
// indicator overlays...) so the copilot can literally operate the OS for the user.

const CORE = 'http://127.0.0.1:3030'

interface ToolSpec {
  name: string
  description: string
  args: string
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>
}

interface ToolCtx {
  emit: (ev: StreamEvent) => void
  signal: AbortSignal
}

type StreamEvent =
  | { type: 'status'; text: string }
  | { type: 'say'; text: string }
  | { type: 'tool_start'; id: number; tool: string; args?: Record<string, unknown> }
  | { type: 'tool_end'; id: number; tool: string; ms: number; ok: boolean; preview?: string; result?: unknown }
  | { type: 'ui'; cmd: string; args?: Record<string, unknown> }
  | { type: 'final'; text: string }
  | { type: 'done'; reply: string; trace: TraceEntry[] }
  | { type: 'error'; message: string }

interface TraceEntry {
  tool: string
  args?: Record<string, unknown>
  result?: unknown
  say?: string
  ms?: number
  ok?: boolean
}

async function coreGet(path: string): Promise<unknown> {
  const res = await fetch(`${CORE}${path}`, { cache: 'no-store' })
  return res.json()
}

async function corePost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${CORE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  })
  return res.json()
}

function trimAnalysis(a: Record<string, unknown>): Record<string, unknown> {
  const mc = a.montecarlo as Record<string, unknown> | undefined
  if (mc && mc.paths) delete mc.paths
  const out = { ...a }
  delete out.indicatorSeries
  const sr = out.srZones as { price: number; type: string; touches: number }[] | undefined
  if (sr) out.srZones = sr.slice(0, 4).map((z) => ({ price: z.price, type: z.type, touches: z.touches }))
  return out
}

const CHART_TYPES = ['candles', 'hollow', 'bars', 'line', 'area', 'baseline', 'heikin-ashi', 'renko']

const TOOLS: ToolSpec[] = [
  // ---------- market data & registry ----------
  {
    name: 'market_overview',
    description: 'List every tradable asset with live SIM prices, categories, payouts and open status. The full universe spans forex, OTC, crypto, commodities, stocks and indices (110+ instruments).',
    args: '{}',
    run: () => coreGet('/assets'),
  },
  {
    name: 'list_instruments',
    description: 'Search the full IQ Option instrument universe by category (forex|otc|crypto|commodity|stock|index|all) and/or free-text query. Returns payouts per trade kind, leverage, schedule and live price.',
    args: '{"category": "crypto", "q": "btc"}',
    run: (a) => {
      const params = new URLSearchParams({ category: String(a.category ?? 'all') })
      if (a.q) params.set('q', String(a.q))
      return coreGet(`/instruments?${params.toString()}`)
    },
  },
  {
    name: 'list_indicators',
    description: 'List indicators from the registry (100+). Returns compact id/name/category/pane list; pass q to filter (e.g. q="sar") or full=true to include tunable params.',
    args: '{"q": "volatility", "full": false}',
    run: async (a) => {
      const d = (await coreGet('/indicators')) as { ok: boolean; indicators?: { id: string; name: string; category: string; pane: string; params?: unknown; description?: string }[] }
      if (!d.ok) return d
      const q = String(a.q ?? '').toLowerCase().trim()
      let list = d.indicators ?? []
      if (q) {
        const tokens = q.split(/[\s,]+/).filter(Boolean)
        list = list.filter((i) => {
          const hay = `${i.id} ${i.name} ${i.category}`.toLowerCase()
          return tokens.some((t) => hay.includes(t))
        })
      }
      if (a.full === true) return { ok: true, count: list.length, indicators: list }
      return {
        ok: true,
        count: list.length,
        indicators: list.map((i) => ({ id: i.id, name: i.name, category: i.category, pane: i.pane })),
        note: 'pass full=true for tunable params',
      }
    },
  },
  {
    name: 'indicator_series',
    description: 'Compute ANY registry indicator on demand and get its last values. Example ids: rsi, macd, ichimoku, supertrend, stochrsi, klinger, hilbert-sine, zscore, aroon, vortex. Params are optional (defaults used).',
    args: '{"id": "supertrend", "asset": "BTCUSD", "tf": "5m", "params": {"period": 10, "mult": 3}}',
    run: async (a) => {
      const params = new URLSearchParams({ id: String(a.id ?? 'rsi'), asset: String(a.asset ?? 'EURUSD'), tf: String(a.tf ?? '1m') })
      if (a.params && typeof a.params === 'object') {
        for (const [k, v] of Object.entries(a.params as Record<string, unknown>)) params.set(`p_${k}`, String(v))
      }
      const d = (await coreGet(`/indicator?${params.toString()}`)) as { ok: boolean; series?: { id?: string; lines?: unknown[]; time?: unknown[] } }
      if (!d.ok) return d
      const s = d.series!
      const lines = (s.lines ?? []) as { key: string; color: string; values: (number | null)[] }[]
      const lastVals: Record<string, number | null> = {}
      for (const ln of lines) {
        const tail = [...ln.values].reverse().find((v) => v !== null)
        lastVals[ln.key] = typeof tail === 'number' ? Math.round(tail * 10000) / 10000 : null
      }
      return { ok: true, id: s.id ?? 'unknown', lastValues: lastVals, points: s.time?.length ?? 0 }
    },
  },
  {
    name: 'chart_patterns',
    description: 'Detect structural chart patterns (double top/bottom, head & shoulders, triangles, wedges, flags, ranges) on an asset.',
    args: '{"asset": "EURUSD", "tf": "15m"}',
    run: (a) => coreGet(`/chart_patterns?asset=${encodeURIComponent(String(a.asset ?? 'EURUSD'))}&tf=${String(a.tf ?? '15m')}`),
  },
  {
    name: 'candle_patterns',
    description: 'Detect the 35 candlestick patterns (doji, engulfing, harami, morning/evening star, three soldiers, kicker...) on an asset and get the net bullish/bearish bias.',
    args: '{"asset": "EURUSD", "tf": "1m"}',
    run: async (a) => {
      const d = (await coreGet(`/analysis?asset=${encodeURIComponent(String(a.asset ?? 'EURUSD'))}&tf=${String(a.tf ?? '1m')}`)) as {
        ok: boolean
        analysis?: { patterns?: unknown[] }
      }
      if (!d.ok) return d
      const pats = (d.analysis?.patterns ?? []) as { name: string; direction: string; barAgo?: number }[]
      const recent = pats.filter((p) => (p.barAgo ?? 0) <= 3)
      const bull = recent.filter((p) => p.direction === 'bullish').length
      const bear = recent.filter((p) => p.direction === 'bearish').length
      return { ok: true, recentPatterns: recent, bias: { bull, bear, net: bull - bear }, allDetected: pats.length }
    },
  },
  // ---------- analytics ----------
  {
    name: 'analyze_market',
    description: 'Full technical + quantitative analysis of an asset: RSI, MACD, Bollinger, ADX, Stochastic, patterns, Markov chain, Monte Carlo, Hurst, GARCH vol, S/R zones and the composite signal with all factor votes. Works for every instrument and every timeframe (5s..1d).',
    args: '{"asset": "EURUSD", "tf": "1m|2m|5m|15m|30m|1h|4h|1d|5s|15s|30s"}',
    run: async (a) => {
      const asset = String(a.asset ?? 'EURUSD')
      const tf = String(a.tf ?? '1m')
      const d = (await coreGet(`/analysis?asset=${encodeURIComponent(asset)}&tf=${tf}`)) as { ok: boolean; analysis?: Record<string, unknown>; error?: string }
      if (!d.ok) return d
      return { ok: true, analysis: trimAnalysis(d.analysis!) }
    },
  },
  {
    name: 'multi_timeframe',
    description: 'Analyze one asset across 4 timeframes (5m, 15m, 1h, 4h) and get each composite signal - the classic MTF confluence read. Use before recommending a trade.',
    args: '{"asset": "BTCUSD"}',
    run: async (a) => {
      const asset = String(a.asset ?? 'EURUSD')
      const tfs = ['5m', '15m', '1h', '4h']
      const rows = await Promise.all(
        tfs.map(async (t) => {
          try {
            const d = (await coreGet(`/signal?asset=${encodeURIComponent(asset)}&tf=${t}`)) as {
              ok: boolean
              signal?: { score: number; direction: string; confidence: number; price: number }
            }
            return d.ok && d.signal
              ? { tf: t, direction: d.signal.direction, score: Math.round(d.signal.score), confidence: Math.round(d.signal.confidence), price: d.signal.price }
              : { tf: t, error: 'unavailable' }
          } catch {
            return { tf: t, error: 'unavailable' }
          }
        })
      )
      const dirs = rows.filter((r) => 'direction' in r).map((r) => r.direction as string)
      const agree = dirs.length ? Math.max(dirs.filter((d) => d === 'call').length, dirs.filter((d) => d === 'put').length) : 0
      return { ok: true, asset, timeframes: rows, confluence: `${agree}/${rows.length} timeframes agree` }
    },
  },
  {
    name: 'compare_assets',
    description: 'Compare 2-4 assets head-to-head: composite signal, Markov P(up), RSI, Hurst and regime for each. Great for picking the strongest candidate.',
    args: '{"assets": ["EURUSD", "GBPUSD", "BTCUSD"], "tf": "1m"}',
    run: async (a) => {
      const list = Array.isArray(a.assets) ? (a.assets as string[]).slice(0, 4) : []
      if (list.length < 2) return { ok: false, error: 'pass 2-4 tickers in assets[]' }
      const tf = String(a.tf ?? '1m')
      const rows = await Promise.all(
        list.map(async (asset) => {
          try {
            const d = (await coreGet(`/analysis?asset=${encodeURIComponent(asset)}&tf=${tf}`)) as { ok: boolean; analysis?: Record<string, unknown> }
            if (!d.ok) return { asset, error: 'analysis failed' }
            const an = d.analysis!
            const sig = an.signal as { score: number; direction: string; confidence: number }
            const mk = an.markov as { probUp: number; regime: string }
            const ind = an.indicators as { rsi: number }
            return {
              asset,
              direction: sig.direction,
              score: Math.round(sig.score),
              confidence: Math.round(sig.confidence),
              pUp: Math.round(mk.probUp * 1000) / 1000,
              regime: mk.regime,
              rsi: Math.round(ind.rsi * 10) / 10,
              hurst: Math.round((an.quant as { hurst: number }).hurst * 100) / 100,
            }
          } catch {
            return { asset, error: 'analysis failed' }
          }
        })
      )
      rows.sort((x, y) => Math.abs(Number((y as { score?: number }).score ?? 0)) - Math.abs(Number((x as { score?: number }).score ?? 0)))
      return { ok: true, tf, ranking: rows }
    },
  },
  {
    name: 'scan_market',
    description: 'Scan a whole category (forex|otc|crypto|commodity|stock|index|all) and rank instruments by composite signal strength. Returns the hottest bullish + bearish setups.',
    args: '{"category": "crypto", "tf": "5m"}',
    run: (a) => coreGet(`/scan?category=${encodeURIComponent(String(a.category ?? 'all'))}&tf=${String(a.tf ?? '1m')}&limit=14`),
  },
  {
    name: 'markov_chain',
    description: 'The fitted first-order Markov transition matrix for an asset: state probabilities, stationary distribution, next-step forecast, regime classification and entropy.',
    args: '{"asset": "EURUSD", "tf": "1m"}',
    run: async (a) => {
      const d = (await coreGet(`/analysis?asset=${encodeURIComponent(String(a.asset ?? 'EURUSD'))}&tf=${String(a.tf ?? '1m')}`)) as {
        ok: boolean
        analysis?: { markov?: unknown; quant?: unknown }
      }
      return d.ok
        ? {
            ok: true,
            markov: d.analysis!.markov,
            volContext: {
              ewmaVol: (d.analysis!.quant as unknown as { ewmaVol: number }).ewmaVol,
              hurst: (d.analysis!.quant as unknown as { hurst: number }).hurst,
            },
          }
        : d
    },
  },
  {
    name: 'monte_carlo',
    description: 'Monte Carlo simulation (GBM) for an asset: percentile price targets, P(up), VaR95/CVaR95 over the horizon.',
    args: '{"asset": "EURUSD", "tf": "1m"}',
    run: async (a) => {
      const d = (await coreGet(`/analysis?asset=${encodeURIComponent(String(a.asset ?? 'EURUSD'))}&tf=${String(a.tf ?? '1m')}`)) as { ok: boolean; analysis?: { montecarlo?: unknown } }
      return d.ok ? { ok: true, montecarlo: d.analysis!.montecarlo } : d
    },
  },
  // ---------- strategies & backtesting ----------
  {
    name: 'list_strategies',
    description: 'List all registered trading strategies with their tunable parameters.',
    args: '{}',
    run: () => coreGet('/strategies'),
  },
  {
    name: 'run_strategy',
    description: 'Evaluate one strategy on the live candle series right now and get its current call/put/none signal.',
    args: '{"strategy": "markov-edge", "asset": "EURUSD", "tf": "1m", "params": {"threshold": 56}}',
    run: (a) =>
      corePost('/run_strategy', {
        strategy: a.strategy ?? 'confluence-core',
        asset: a.asset,
        tf: a.tf ?? '1m',
        params: a.params,
      }),
  },
  {
    name: 'backtest',
    description: 'Backtest a strategy over recent history. Returns trades, win rate, profit factor, max drawdown, Sharpe, expectancy and the equity curve.',
    args: '{"strategy": "rsi-reversion", "asset": "EURUSD", "tf": "1m", "mode": "binary|spot", "amount": 10, "expiryBars": 1, "params": {}}',
    run: (a) =>
      corePost('/backtest', {
        strategy: a.strategy,
        asset: a.asset,
        tf: a.tf ?? '1m',
        mode: a.mode ?? 'binary',
        amount: a.amount ?? 10,
        expiryBars: a.expiryBars ?? 1,
        params: a.params,
      }),
  },
  // ---------- risk & execution ----------
  {
    name: 'risk_calculator',
    description: 'Position-sizing math. For CFD/spot: stake so a stop-loss hits exactly riskPct of the balance. For binary: recommended stake (fixed-fraction) and the breakeven win rate implied by the payout.',
    args: '{"balance": 10000, "riskPct": 1.0, "stopPct": 0.3, "payout": 0.85, "kind": "cfd|binary|turbo|digital"}',
    run: async (a) => {
      let balance = Number(a.balance ?? 0)
      const kind = String(a.kind ?? 'cfd')
      if (!balance) {
        const acc = (await coreGet('/account')) as { ok: boolean; account?: { balance: number } }
        balance = acc.account?.balance ?? 10000
      }
      const riskPct = Number(a.riskPct ?? 1)
      const stopPct = Number(a.stopPct ?? 0.3)
      const payout = Number(a.payout ?? 0.85)
      const riskAmount = (balance * riskPct) / 100
      if (kind === 'cfd') {
        const stake = stopPct > 0 ? riskAmount / (stopPct / 100) : riskAmount
        return {
          ok: true,
          kind,
          balance,
          riskAmount: Math.round(riskAmount * 100) / 100,
          stopPct,
          stake: Math.round(Math.min(stake, balance) * 100) / 100,
          formula: 'stake = (balance * riskPct/100) / (stopPct/100)',
        }
      }
      const fixedFraction = Math.round(balance * (riskPct / 100) * 100) / 100
      const breakeven = 100 / (100 + payout * 100) * 100
      return {
        ok: true,
        kind,
        balance,
        stake: Math.round(fixedFraction * 100) / 100,
        riskAmount: Math.round(riskAmount * 100) / 100,
        payout,
        breakevenWinRate: Math.round(breakeven * 10) / 10,
        note: `Win rate must exceed ${Math.round(breakeven * 10) / 10}% at ${Math.round(payout * 100)}% payout to be profitable.`,
      }
    },
  },
  {
    name: 'place_trade',
    description: 'Place a PAPER trade through the risk manager. Kinds: binary (expiry in bars), turbo (short expiry, min 30s), digital (strike + expiry in seconds), cfd (margin with leverage + TP/SL %). All instruments support all kinds.',
    args: '{"asset": "EURUSD", "tf": "1m", "side": "call|put", "kind": "binary|turbo|digital|cfd", "amount": 10, "expiryBars": 1, "expirySec": 300, "strikeOffsetPct": 0, "leverage": 10, "tp": 0.4, "sl": 0.25, "strategy": "optional-id", "note": "why"}',
    run: (a, ctx) => {
      ctx.emit({ type: 'status', text: 'placing paper order…' })
      return corePost('/trade', {
        asset: a.asset,
        tf: a.tf ?? '1m',
        side: a.side,
        kind: a.kind ?? 'binary',
        amount: a.amount ?? 10,
        expiryBars: a.expiryBars ?? 1,
        expirySec: a.expirySec,
        strikeOffsetPct: a.strikeOffsetPct,
        leverage: a.leverage,
        tp: a.tp,
        sl: a.sl,
        mode: 'paper',
        strategy: a.strategy,
        note: a.note,
      })
    },
  },
  {
    name: 'close_position',
    description: 'Close an open position early by its id.',
    args: '{"id": "position-id"}',
    run: (a) => corePost('/close', { id: a.id }),
  },
  {
    name: 'positions',
    description: 'List currently open paper positions with live status.',
    args: '{}',
    run: () => coreGet('/positions?status=open'),
  },
  {
    name: 'trade_history',
    description: 'Recent closed trades with P&L.',
    args: '{"limit": 20}',
    run: () => coreGet('/history?limit=30'),
  },
  {
    name: 'account',
    description: 'Paper account state: balance, day P&L, total P&L, kill switch, risk config.',
    args: '{}',
    run: () => coreGet('/account'),
  },
  // ---------- OS control (executed client-side) ----------
  {
    name: 'ui_control',
    description: `Operate the user's OS interface. ALWAYS pass "cmd" - one of: set_asset (+"asset":"BTCUSD"), set_tf (+"tf":"5m"), set_chart_type (+"chartType":"heikin-ashi"), add_indicator (+"id":"bollinger", optional "params":{...}, "pane":"overlay"|"sub"), remove_indicator (+"id":"macd"), clear_indicators. Use it to set up the workspace for your analysis.`,
    args: '{"cmd": "set_asset", "asset": "BTCUSD"}  |  {"cmd": "add_indicator", "id": "macd", "pane": "sub"}',
    run: async (aRaw, ctx) => {
      const ALL_TFS = ['5s', '15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h', '4h', '1d']
      // ---- tolerance layer: models send wildly varying arg shapes ----
      let src: Record<string, unknown> = { ...aRaw }
      const innerA = (src as { args?: unknown }).args
      if (typeof innerA === 'string' || typeof innerA === 'number') {
        // {"cmd":"set_tf","args":"5m"} -> {"cmd":"set_tf","value":"5m"}
        const others = Object.keys(src).filter((k) => !['cmd', 'args', 'say', 'action'].includes(k))
        if (!others.length) src = { cmd: src.cmd, value: innerA }
      } else if (innerA && typeof innerA === 'object' && !Array.isArray(innerA)) {
        src = { ...(innerA as Record<string, unknown>), ...(src.cmd ? { cmd: src.cmd } : {}) }
      }
      const CMD_ALIASES: Record<string, string> = {
        set_asset: 'set_asset', asset: 'set_asset', symbol: 'set_asset', set_symbol: 'set_asset', switch_asset: 'set_asset',
        set_tf: 'set_tf', tf: 'set_tf', timeframe: 'set_tf', set_timeframe: 'set_tf', switch_tf: 'set_tf',
        set_chart_type: 'set_chart_type', chart: 'set_chart_type', chart_type: 'set_chart_type', charttype: 'set_chart_type', set_charttype: 'set_chart_type',
        add_indicator: 'add_indicator', add: 'add_indicator', indicator: 'add_indicator', addindicator: 'add_indicator', show_indicator: 'add_indicator',
        remove_indicator: 'remove_indicator', remove: 'remove_indicator', delete_indicator: 'remove_indicator', hide_indicator: 'remove_indicator',
        clear_indicators: 'clear_indicators', clear: 'clear_indicators', reset_indicators: 'clear_indicators', clear_chart: 'clear_indicators',
      }
      const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[\s_-]/g, '')
      const cmdRaw = String(src.cmd ?? '').trim()
      const cmd = cmdRaw ? (CMD_ALIASES[norm(cmdRaw)] ?? cmdRaw) : ''
      const val = (...keys: string[]) => {
        for (const k of keys) if (src[k] !== undefined && src[k] !== null) return src[k]
        return src.value ?? src.to ?? src.target
      }
      const CHART_ALIASES: Record<string, string> = {
        candle: 'candles', candles: 'candles', candlestick: 'candles', candlesticks: 'candles',
        hollow: 'hollow', hollowcandle: 'hollow', hollowcandles: 'hollow',
        bar: 'bars', bars: 'bars', ohlc: 'bars', ohlcbars: 'bars',
        line: 'line', lines: 'line', area: 'area', baseline: 'baseline',
        heikinashi: 'heikin-ashi', heikin: 'heikin-ashi', ha: 'heikin-ashi',
        renko: 'renko',
      }
      // ---- build command queue (inferred from args when cmd is missing) ----
      const queue: { cmd: string; args: Record<string, unknown> }[] = []
      if (cmd && ['set_asset', 'set_tf', 'set_chart_type', 'add_indicator', 'remove_indicator', 'clear_indicators'].includes(cmd)) {
        queue.push({ cmd, args: src })
      } else if (cmd) {
        return { ok: false, error: `unknown ui cmd "${cmdRaw}" - use set_asset|set_tf|set_chart_type|add_indicator|remove_indicator|clear_indicators` }
      } else {
        if (val('asset') !== undefined) queue.push({ cmd: 'set_asset', args: { asset: val('asset') } })
        if (val('tf') !== undefined) queue.push({ cmd: 'set_tf', args: { tf: val('tf') } })
        if (val('chartType') !== undefined) queue.push({ cmd: 'set_chart_type', args: { chartType: val('chartType') } })
        if (val('id') !== undefined) queue.push({ cmd: src.remove ? 'remove_indicator' : 'add_indicator', args: { id: val('id'), params: src.params, pane: src.pane } })
      }
      if (!queue.length)
        return {
          ok: false,
          error: `ui_control received args ${JSON.stringify(aRaw).slice(0, 140)} — that is not usable. Send {"cmd":"add_indicator","id":"macd"} style args: cmd must be set_asset|set_tf|set_chart_type|add_indicator|remove_indicator|clear_indicators.`,
        }

      const applied: string[] = []
      for (const { cmd: c, args } of queue) {
        if (c === 'set_asset') {
          const ticker = String(args.asset ?? '').toUpperCase().trim()
          const d = (await coreGet(`/instruments?q=${encodeURIComponent(ticker)}`)) as { ok: boolean; instruments?: { ticker: string }[] }
          const hit = (d.instruments ?? []).find((i) => i.ticker.toUpperCase() === ticker)
          if (!hit) return { ok: false, error: `unknown asset ${ticker}` }
          ctx.emit({ type: 'ui', cmd: 'set_asset', args: { asset: hit.ticker } })
          applied.push(`asset=${hit.ticker}`)
        } else if (c === 'set_tf') {
          const tfv = String(args.tf ?? '').trim().toLowerCase()
          if (!ALL_TFS.includes(tfv)) return { ok: false, error: `invalid tf "${tfv}" - use ${ALL_TFS.join('|')}` }
          ctx.emit({ type: 'ui', cmd: 'set_tf', args: { tf: tfv } })
          applied.push(`tf=${tfv}`)
        } else if (c === 'set_chart_type') {
          const raw = String(args.chartType ?? '').toLowerCase().replace(/[\s_-]/g, '')
          const ct = CHART_ALIASES[raw] ?? (CHART_TYPES.includes(raw) ? raw : undefined)
          if (!ct) return { ok: false, error: `unknown chartType "${raw}" - use ${CHART_TYPES.join('|')}` }
          ctx.emit({ type: 'ui', cmd: 'set_chart_type', args: { chartType: ct } })
          applied.push(`chart=${ct}`)
        } else if (c === 'add_indicator') {
          const id = String(args.id ?? '').trim().toLowerCase()
          const d = (await coreGet(`/indicators`)) as { ok: boolean; indicators?: { id: string; name: string; pane: string }[] }
          const all = d.indicators ?? []
          const def = all.find((i) => i.id === id)
          if (!def) {
            // fuzzy suggestions so the model can self-correct without another call
            const tokens = id.split(/[^a-z0-9]+/).filter((t) => t.length > 1)
            const scored = all
              .map((i) => {
                const hay = `${i.id} ${i.name}`.toLowerCase()
                let s = 0
                if (i.id === id) s += 100
                if (hay.includes(id)) s += 50
                for (const t of tokens) if (hay.includes(t)) s += 20
                return { i, s }
              })
              .filter((x) => x.s > 0)
              .sort((x, y) => y.s - x.s)
              .slice(0, 6)
              .map((x) => ({ id: x.i.id, name: x.i.name, pane: x.i.pane }))
            return { ok: false, error: `unknown indicator "${id}"`, suggestions: scored.length ? scored : all.slice(0, 10).map((i) => ({ id: i.id, name: i.name, pane: i.pane })) }
          }
          ctx.emit({ type: 'ui', cmd: 'add_indicator', args: { id: def.id, params: args.params, pane: args.pane ?? def.pane } })
          applied.push(`${def.id} (${args.pane ?? def.pane})`)
        } else if (c === 'remove_indicator') {
          ctx.emit({ type: 'ui', cmd: 'remove_indicator', args: { id: String(args.id ?? '') } })
          applied.push(`removed ${String(args.id ?? '')}`)
        } else if (c === 'clear_indicators') {
          ctx.emit({ type: 'ui', cmd: 'clear_indicators', args: {} })
          applied.push('cleared all indicators')
        }
      }
      return { ok: true, applied: applied.join(', ') }
    },
  },
]

const TOOL_LIST_TEXT = TOOLS.map((t) => `- ${t.name}: ${t.description} args: ${t.args}`).join('\n')

const SYSTEM_BASE = `You are the IQAIR//OS Copilot - an expert quantitative trading analyst embedded as the AI of a trading operating system built on the iqair IQ Option library.
You can analyze markets (100+ technical indicators, 35 candlestick + chart patterns, Markov chains, Monte Carlo, Hurst exponent, GARCH volatility), scan the whole universe for setups, run strategies, backtest them, place PAPER trades through the risk manager, and control the user's workspace (switch charts, timeframes, add indicators).

Tool protocol - follow it EXACTLY:
- Respond with ONE JSON object and nothing else. No markdown fences, no prose outside the JSON.
- You MAY batch several tool calls in one reply when they are independent - list them as consecutive JSON objects, each on its own line. They execute in order.
- To call a tool: {"action": "<tool_name>", "args": {...}, "say": "one short sentence about what you're doing"}
- Available tools:
${TOOL_LIST_TEXT}
- When you have everything you need: {"action": "final", "say": "<your complete answer in markdown>"}
Rules:
- Chain tools freely (up to ~8 calls) before answering.
- The OS CONTEXT block tells you the user's balance, open positions and what chart they are viewing - reference it naturally ("on your EURUSD 1m chart...") instead of re-fetching what you already know.
- Use ui_control to set up the workspace when it helps (e.g. add Bollinger + RSI before a detailed read, or switch to the asset you're discussing). Do not undo the user's layout gratuitously.
- For trade ideas: check multi_timeframe confluence first, size with risk_calculator, then optionally place_trade as PAPER and say so.
- NEVER promise profits. Always frame outputs as probabilistic analysis, not certainty.
- PAPER trades only - you cannot and must not place live trades.
- If a tool returns {"ok": false, "error": ...}, adapt: fix the args or try a different approach.
- Final answer format: tight markdown. Open with a 1-2 sentence TL;DR verdict, then a few bullet groups with the actual numbers you observed (RSI, P(up), win rate, confidence). No walls of text, no invented data.`

interface ChatMsg {
  role: 'assistant' | 'user'
  content: string
}

interface Action {
  action: string
  args?: Record<string, unknown>
  say?: string
}

/** Find balanced top-level JSON objects in a (possibly messy) LLM reply. */
function topJsonObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      if (depth > 0) inStr = true
      continue
    }
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

/**
 * Models often batch several tool calls in one reply. Parse ALL of them in order;
 * a lone "final" action ends the run, tool batches execute sequentially.
 * Tolerates three arg styles: nested ({action, args:{...}}), flat
 * ({action, cmd:"set_tf", tf:"5m"}) and stringified ({action, args:"{...}"}).
 */
function extractActions(text: string): Action[] {
  const cleaned = text.replace(/```json|```/g, '')
  const res: Action[] = []
  for (const s of topJsonObjects(cleaned)) {
    try {
      const p = JSON.parse(s) as Record<string, unknown>
      if (!p || typeof p !== 'object' || typeof p.action !== 'string') continue
      const { action, args: a, say, ...rest } = p
      let args: Record<string, unknown>
      if (typeof a === 'string') {
        try {
          const parsed = JSON.parse(a) as unknown
          args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: a }
        } catch {
          args = { value: a }
        }
      } else if (a && typeof a === 'object' && !Array.isArray(a)) {
        args = { ...rest, ...(a as Record<string, unknown>) }
      } else if (rest && Object.keys(rest).length) {
        args = rest
      } else {
        args = {}
      }
      res.push({ action: action as string, args, say: typeof say === 'string' ? say : undefined })
    } catch {
      /* not valid json - skip */
    }
  }
  return res
}

/** Salvage narration from a reply we could not fully parse. */
function salvageSay(text: string): string {
  const says = [...text.matchAll(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => {
    try {
      return JSON.parse(`"${m[1]}"`) as string
    } catch {
      return m[1]
    }
  })
  return says.filter(Boolean).join(' ')
}

/** Compact a tool result for the live client preview (small). */
function previewOf(result: unknown, max = 700): string {
  try {
    const s = JSON.stringify(result)
    return s.length > max ? s.slice(0, max) + '…' : s
  } catch {
    return String(result)
  }
}

/** Bound the tool result fed back to the model - with an explicit truncation marker. */
function feedOf(result: unknown, max = 4000): string {
  try {
    const s = JSON.stringify(result)
    if (s.length <= max) return s
    return s.slice(0, max) + ` …[JSON truncated - ${s.length - max} more chars. If you need specific fields, use a narrower tool or filter args instead of re-reading this whole payload.]`
  } catch {
    return String(result)
  }
}

interface UiContext {
  asset?: string
  tf?: string
  chartType?: string
  overlays?: string[]
  subs?: string[]
}

async function buildContextBlock(ui: UiContext): Promise<string> {
  const lines: string[] = []
  try {
    const acc = (await coreGet('/account')) as { ok: boolean; account?: Record<string, number | boolean>; risk?: Record<string, number> }
    if (acc.ok && acc.account) {
      const a = acc.account
      lines.push(`- Paper account: balance $${Number(a.balance ?? 0).toFixed(2)}, day P&L $${Number(a.dayPnl ?? 0).toFixed(2)}, total P&L $${Number(a.totalPnl ?? 0).toFixed(2)}, kill switch ${a.killSwitch ? 'ENGAGED' : 'off'}`)
    }
  } catch {
    /* ignore */
  }
  try {
    const pos = (await coreGet('/positions?status=open')) as { ok: boolean; positions?: { asset: string; side: string; kind: string; amount: number; status: string; strike?: number }[] }
    if (pos.ok && pos.positions?.length) {
      lines.push(`- Open positions (${pos.positions.length}): ${pos.positions.slice(0, 6).map((p) => `${p.asset} ${p.side} ${p.kind} $${p.amount}`).join('; ')}`)
    } else {
      lines.push('- Open positions: none')
    }
  } catch {
    /* ignore */
  }
  const view = [
    ui.asset ? `asset ${ui.asset}` : null,
    ui.tf ? `timeframe ${ui.tf}` : null,
    ui.chartType ? `${ui.chartType} chart` : null,
    ui.overlays?.length ? `overlays: ${ui.overlays.join(', ')}` : null,
    ui.subs?.length ? `sub-panes: ${ui.subs.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(', ')
  lines.push(`- User is viewing: ${view || 'unknown'}`)
  return `OS CONTEXT (live, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC):\n${lines.join('\n')}`
}

export async function GET(req: NextRequest) {
  const session = req.nextUrl.searchParams.get('session') ?? 'default'
  try {
    const history = (await coreGet(`/chat?session=${encodeURIComponent(session)}`)) as { ok: boolean; messages?: { role: string; content: string; ts: number }[] }
    return NextResponse.json({ ok: true, messages: history.ok ? history.messages ?? [] : [] })
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const session = req.nextUrl.searchParams.get('session') ?? 'default'
  try {
    await corePost('/chat_clear', { session })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let sessionId = 'default'
  let userMessage = ''
  let ui: UiContext = {}
  try {
    const body = (await req.json()) as { sessionId?: string; message?: string; ui?: UiContext }
    sessionId = body.sessionId ?? 'default'
    userMessage = (body.message ?? '').trim()
    ui = body.ui ?? {}
    if (!userMessage) {
      return NextResponse.json({ ok: false, error: 'message required' }, { status: 400 })
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const emit = (ev: StreamEvent) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`))
        } catch {
          closed = true
        }
      }

      const trace: TraceEntry[] = []
      try {
        emit({ type: 'status', text: 'loading OS context…' })
        const contextBlock = await buildContextBlock(ui)
        const SYSTEM = `${SYSTEM_BASE}\n\n${contextBlock}`

        // recent conversation for continuity
        let recent: ChatMsg[] = []
        try {
          const history = (await coreGet(`/chat?session=${encodeURIComponent(sessionId)}`)) as { ok: boolean; messages?: { role: string; content: string }[] }
          recent = (history.ok ? history.messages ?? [] : [])
            .slice(-10)
            .map((m) => ({ role: m.role as 'assistant' | 'user', content: m.content }))
        } catch {
          /* first message ever - fine */
        }

        const zai = await ZAI.create()
        const messages: ChatMsg[] = [...recent, { role: 'user', content: userMessage }]

        let failedBatches = 0
        for (let iter = 0; iter < 8 && !closed && !req.signal.aborted; iter++) {
          emit({ type: 'status', text: iter === 0 ? 'thinking…' : 'reasoning over results…' })
          const payloadMessages = [
            { role: 'assistant', content: SYSTEM },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
          ] as any[]
          const completion = (await Promise.race([
            zai.chat.completions.create({ messages: payloadMessages, thinking: { type: 'disabled' } }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('model timeout')), 90_000)),
          ])) as Awaited<ReturnType<typeof zai.chat.completions.create>>
          const raw = completion.choices[0]?.message?.content ?? ''
          const actions = extractActions(raw)

          if (!actions.length) {
            const final = salvageSay(raw) || raw || 'I could not produce a structured response - please rephrase.'
            emit({ type: 'final', text: final })
            await persist(sessionId, userMessage, final)
            break
          }

          // split batch into leading tool calls + optional trailing final
          const finalIdx = actions.findIndex((a) => a.action === 'final')
          const batch = finalIdx === -1 ? actions : actions.slice(0, finalIdx)
          const pendingFinal = finalIdx !== -1 ? actions[finalIdx].say : undefined

          if (!batch.length) {
            const final = pendingFinal ?? raw
            emit({ type: 'final', text: final })
            await persist(sessionId, userMessage, final)
            break
          }

          for (const act of batch) {
            if (req.signal.aborted || closed) break
            if (act.say) emit({ type: 'say', text: act.say })
            const tool = TOOLS.find((t) => t.name === act.action)
            const id = trace.length + 1
            emit({ type: 'tool_start', id, tool: act.action, args: act.args })
            const t0 = Date.now()
            let result: unknown
            let ok = true
            if (!tool) {
              result = { ok: false, error: `unknown tool ${act.action}` }
              ok = false
            } else {
              try {
                result = await tool.run(act.args ?? {}, { emit, signal: req.signal })
                if (result && typeof result === 'object' && 'ok' in (result as Record<string, unknown>)) {
                  ok = Boolean((result as Record<string, unknown>).ok)
                }
              } catch (err) {
                result = { ok: false, error: (err as Error).message }
                ok = false
              }
            }
            const ms = Date.now() - t0
            trace.push({ tool: act.action, args: act.args, result, say: act.say, ms, ok })
            // preview feeds both the client card renderers and the expandable raw view
            emit({ type: 'tool_end', id, tool: act.action, ms, ok, preview: previewOf(result, 4000) })
            messages.push({ role: 'assistant', content: JSON.stringify({ action: act.action, say: act.say }) })
            messages.push({
              role: 'user',
              content: `TOOL_RESULT ${act.action}: ${feedOf(result, 4000)}\n\nYou now have the tool result. If you need more data call another tool (you may batch several), otherwise respond with {"action": "final", "say": "<your full answer>"}.`,
            })
          }

          // circuit breaker: two consecutive all-failed batches mean the model is
          // stuck in a retry loop - synthesize from what we have instead of burning budget
          const batchResults = trace.slice(-batch.length)
          if (batchResults.length === batch.length && batchResults.every((t) => t.ok === false)) {
            failedBatches++
          } else {
            failedBatches = 0
          }

          const synthesize = (why: string) => {
            const says = trace.map((t) => t.say).filter(Boolean).join(' ')
            const final =
              pendingFinal ||
              says ||
              `I ran ${trace.length} tool call(s) (${[...new Set(trace.map((t) => t.tool))].join(', ')}) but ${why}. Ask again or narrow the question for a fuller read-out.`
            emit({ type: 'final', text: final })
            void persist(sessionId, userMessage, final)
          }

          if (failedBatches >= 2) {
            synthesize('kept hitting tool errors')
            break
          }

          // a final emitted alongside a tool batch still waits for the next
          // iteration so the model can compose with fresh results.
          if (iter === 7) {
            synthesize('ran out of reasoning budget')
          }
        }

        emit({ type: 'done', reply: '', trace })
      } catch (err) {
        const msg = (err as Error).message || 'unknown error'
        const friendly = /429|too many request/i.test(msg)
          ? 'The AI provider rate-limited us - give it a few seconds and ask again.'
          : /timeout/i.test(msg)
            ? 'The model took too long to respond - try a narrower question.'
            : msg
        emit({ type: 'error', message: friendly })
      } finally {
        closed = true
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

async function persist(session: string, userMsg: string, reply: string) {
  try {
    await corePost('/chat_save', { session, role: 'user', content: userMsg })
    await corePost('/chat_save', { session, role: 'assistant', content: reply })
  } catch {
    /* chat persistence is best-effort */
  }
}
