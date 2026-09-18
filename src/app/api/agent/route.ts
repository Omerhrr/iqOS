import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

// IQAIR//OS - Agent harness route
// Repurposed deepseek-harness concept: an LLM loop with JSON tool-calling that
// drives the trading-core kernel through its REST surface. All tool execution
// happens server-side; the client only sees the transcript + trace.

const CORE = 'http://127.0.0.1:3030'

interface ToolSpec {
  name: string
  description: string
  args: string // human-readable JSON schema summary
  run: (args: Record<string, unknown>) => Promise<unknown>
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

const TOOLS: ToolSpec[] = [
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
    description: 'List every indicator in the registry (100+): id, name, category (overlap/momentum/trend/volatility/volume/cycle/statistic), pane and tunable params.',
    args: '{}',
    run: () => coreGet('/indicators'),
  },
  {
    name: 'indicator_series',
    description: 'Compute ANY registry indicator on demand and get its full series. Example ids: rsi, macd, ichimoku, supertrend, stochrsi, klinger, hilbert-sine, zscore, aroon, vortex. Params are optional (defaults used).',
    args: '{"id": "supertrend", "asset": "BTCUSD", "tf": "5m", "params": {"period": 10, "mult": 3}}',
    run: async (a) => {
      const params = new URLSearchParams({ id: String(a.id ?? 'rsi'), asset: String(a.asset ?? 'EURUSD'), tf: String(a.tf ?? '1m') })
      if (a.params && typeof a.params === 'object') {
        for (const [k, v] of Object.entries(a.params as Record<string, unknown>)) params.set(`p_${k}`, String(v))
      }
      const d = (await coreGet(`/indicator?${params.toString()}`)) as { ok: boolean; series?: { lines?: unknown[]; time?: unknown[] } }
      if (!d.ok) return d
      const s = d.series!
      const lines = (s.lines ?? []) as { key: string; color: string; values: (number | null)[] }[]
      const lastVals: Record<string, number | null> = {}
      for (const ln of lines) {
        const tail = [...ln.values].reverse().find((v) => v !== null)
        lastVals[ln.key] = typeof tail === 'number' ? tail : null
      }
      return { ok: true, id: s.id, lastValues: lastVals, points: s.time?.length ?? 0 }
    },
  },
  {
    name: 'chart_patterns',
    description: 'Detect structural chart patterns (double top/bottom, head & shoulders, triangles, wedges, flags, ranges) on an asset.',
    args: '{"asset": "EURUSD", "tf": "15m"}',
    run: (a) => coreGet(`/chart_patterns?asset=${encodeURIComponent(String(a.asset ?? 'EURUSD'))}&tf=${String(a.tf ?? '15m')}`),
  },
  {
    name: 'analyze_market',
    description: 'Full technical + quantitative analysis of an asset: RSI, MACD, Bollinger, ADX, Stochastic, patterns, Markov chain, Monte Carlo, Hurst, GARCH vol, S/R zones and the composite signal with all factor votes. Works for every instrument in the universe (forex, OTC, crypto, commodities, stocks, indices) and every timeframe (5s..1d).',
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
    name: 'markov_chain',
    description: 'The fitted first-order Markov transition matrix for an asset: state probabilities, stationary distribution, next-step forecast, regime classification and entropy.',
    args: '{"asset": "EURUSD", "tf": "1m"}',
    run: async (a) => {
      const d = (await coreGet(`/analysis?asset=${encodeURIComponent(String(a.asset ?? 'EURUSD'))}&tf=${String(a.tf ?? '1m')}`)) as { ok: boolean; analysis?: { markov?: unknown; quant?: unknown } }
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
  {
    name: 'place_trade',
    description: 'Place a PAPER trade through the risk manager. Kinds: binary (expiry in bars), turbo (short expiry, min 30s), digital (strike + expiry in seconds), cfd (margin with leverage + TP/SL %). All instruments support all kinds.',
    args: '{"asset": "EURUSD", "tf": "1m", "side": "call|put", "kind": "binary|turbo|digital|cfd", "amount": 10, "expiryBars": 1, "expirySec": 300, "strikeOffsetPct": 0, "leverage": 10, "tp": 0.4, "sl": 0.25, "strategy": "optional-id", "note": "why"}',
    run: (a) =>
      corePost('/trade', {
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
      }),
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
    name: 'account',
    description: 'Paper account state: balance, day P&L, total P&L, kill switch, risk config.',
    args: '{}',
    run: () => coreGet('/account'),
  },
  {
    name: 'trade_history',
    description: 'Recent closed trades with P&L.',
    args: '{"limit": 20}',
    run: () => coreGet('/history?limit=30'),
  },
  {
    name: 'set_active_asset',
    description: 'Switch the OS chart + panels to another asset for the user.',
    args: '{"asset": "BTCUSD"}',
    run: (a) => corePost('/asset', { asset: a.asset }),
  },
]

const TOOL_LIST_TEXT = TOOLS.map((t) => `- ${t.name}: ${t.description} args: ${t.args}`).join('\n')

const SYSTEM = `You are the IQAIR//OS Copilot - an expert quantitative trading analyst embedded in a trading operating system built on the iqair IQ Option library.
You can analyze markets (100+ technical indicators, 35 candlestick + chart patterns, Markov chains, Monte Carlo, Hurst exponent, GARCH volatility), run strategies, backtest them, and place PAPER trades through the risk manager.
The universe covers 110+ IQ Option instruments across forex, OTC (24/7), crypto, commodities, stocks and indices, with 11 timeframes (5s to 1d) and 4 trade kinds: binary, turbo, digital (strike-based) and CFD (leveraged margin).

Tool protocol - follow it EXACTLY:
- Respond with ONE JSON object and nothing else. No markdown fences, no prose outside the JSON.
- To call a tool: {"action": "<tool_name>", "args": {...}, "say": "one short sentence about what you're doing"}
- Available tools:
${TOOL_LIST_TEXT}
- When you have everything you need: {"action": "final", "say": "<your complete answer in markdown>"}
Rules:
- Chain tools freely (up to ~6 calls) before answering, e.g. analyze_market then place_trade.
- NEVER promise profits. Always frame outputs as probabilistic analysis, not certainty.
- PAPER trades only - you cannot and must not place live trades.
- If a tool returns {"ok": false, "error": ...}, adapt: fix the args or try a different approach.
- In the final answer, be concrete: cite the actual numbers you observed (RSI values, P(up), win rates).`

interface ChatMsg {
  role: 'assistant' | 'user'
  content: string
}

function extractJson(text: string): { action: string; args?: Record<string, unknown>; say?: string } | null {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { sessionId?: string; message?: string }
    const sessionId = body.sessionId ?? 'default'
    const userMessage = (body.message ?? '').trim()
    if (!userMessage) {
      return NextResponse.json({ ok: false, error: 'message required' }, { status: 400 })
    }

    // load recent history from the core store
    const history = (await coreGet(`/chat?session=${encodeURIComponent(sessionId)}`)) as {
      ok: boolean
      messages?: { role: string; content: string }[]
    }
    const recent: ChatMsg[] = (history.ok ? history.messages ?? [] : [])
      .slice(-10)
      .map((m) => ({ role: m.role as 'assistant' | 'user', content: m.content }))

    const zai = await ZAI.create()
    const messages: ChatMsg[] = [...recent, { role: 'user', content: userMessage }]

    const trace: { tool: string; args?: Record<string, unknown>; result?: unknown; say?: string }[] = []
    let final = ''

    for (let iter = 0; iter < 6; iter++) {
      const payloadMessages = [
        { role: 'assistant', content: SYSTEM },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ] as any[]
      const completion = await zai.chat.completions.create({
        messages: payloadMessages,
        thinking: { type: 'disabled' },
      })
      const raw = completion.choices[0]?.message?.content ?? ''
      const parsed = extractJson(raw)

      if (!parsed) {
        final = raw || 'I could not produce a structured response - please rephrase.'
        break
      }

      if (parsed.action === 'final' || !parsed.action) {
        final = parsed.say ?? raw
        break
      }

      const tool = TOOLS.find((t) => t.name === parsed.action)
      let result: unknown
      if (!tool) {
        result = { ok: false, error: `unknown tool ${parsed.action}` }
      } else {
        try {
          result = await tool.run(parsed.args ?? {})
        } catch (err) {
          result = { ok: false, error: (err as Error).message }
        }
      }
      trace.push({ tool: parsed.action, args: parsed.args, result, say: parsed.say })
      messages.push({ role: 'assistant', content: JSON.stringify({ action: parsed.action, say: parsed.say }) })
      messages.push({
        role: 'user',
        content: `TOOL_RESULT ${parsed.action}: ${JSON.stringify(result).slice(0, 4000)}\n\nYou now have the tool result. If you need more data call another tool, otherwise respond with {"action": "final", "say": "<your full answer>"}.`,
      })

      if (iter === 5) {
        // budget exhausted - synthesize an answer from what we gathered
        const says = trace.map((t) => t.say).filter(Boolean).join(' ')
        final =
          says ||
          `I gathered ${trace.length} tool result(s) (${trace.map((t) => t.tool).join(', ')}) but ran out of reasoning budget before composing the summary. Try asking again or narrow the question.`
      }
    }

    // never end on a raw tool-call JSON
    if (/^\s*\{\s*"action"\s*:\s*"(?!final)/.test(final)) {
      const says = trace.map((t) => t.say).filter(Boolean).join(' ')
      final = says || 'Here is what I found so far - ask me to continue for the full read-out.'
    }

    // persist to the core store
    await corePost('/chat_save', { session: sessionId, role: 'user', content: userMessage })
    await corePost('/chat_save', { session: sessionId, role: 'assistant', content: final })

    return NextResponse.json({ ok: true, reply: final, trace })
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 })
  }
}
