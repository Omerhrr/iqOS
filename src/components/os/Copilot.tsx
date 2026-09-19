'use client'

// IQAIR//OS - Copilot v2
// A streaming agent-harness chat: the LLM drives the OS kernel through a 20-tool
// loop, and every step is streamed live (SSE) into a visual timeline. The copilot
// can also operate the OS itself - switching assets/timeframes/chart types and
// adding indicators - via ui commands applied by the parent shell.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// ---------------- types ----------------

type TimelineItem =
  | { kind: 'say'; text: string }
  | { kind: 'tool'; id: number; tool: string; args?: Record<string, unknown>; status: 'run' | 'ok' | 'err'; ms?: number; preview?: string }
  | { kind: 'final'; text: string }

interface Msg {
  role: 'user' | 'assistant'
  content: string
  events?: TimelineItem[]
  streaming?: boolean
  error?: boolean
}

interface CopilotProps {
  session?: string
  asset?: string
  tf?: string
  chartType?: string
  overlays?: string[]
  subs?: string[]
  balance?: number
  onUiCommand?: (cmd: string, args?: Record<string, unknown>) => void
}

// ---------------- tool styling ----------------

const TOOL_GROUPS: Record<string, { dot: string; label: string }> = {
  analyze: { dot: 'bg-sky-400', label: 'text-sky-300' },
  data: { dot: 'bg-cyan-400', label: 'text-cyan-300' },
  trade: { dot: 'bg-emerald-400', label: 'text-emerald-300' },
  ui: { dot: 'bg-violet-400', label: 'text-violet-300' },
  risk: { dot: 'bg-amber-400', label: 'text-amber-300' },
}

function toolGroup(tool: string): { dot: string; label: string } {
  if (['place_trade', 'close_position'].includes(tool)) return TOOL_GROUPS.trade
  if (tool === 'ui_control') return TOOL_GROUPS.ui
  if (['risk_calculator', 'account', 'positions', 'trade_history'].includes(tool)) return TOOL_GROUPS.risk
  if (['analyze_market', 'multi_timeframe', 'compare_assets', 'markov_chain', 'monte_carlo', 'backtest', 'run_strategy', 'scan_market'].includes(tool))
    return TOOL_GROUPS.analyze
  return TOOL_GROUPS.data
}

function fmtArgs(args?: Record<string, unknown>): string {
  if (!args) return ''
  try {
    return Object.entries(args)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .slice(0, 4)
      .join(' ')
  } catch {
    return ''
  }
}

// ---------------- mini markdown renderer ----------------

function inline(text: string, keyBase: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g).filter(Boolean)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**'))
      return (
        <strong key={`${keyBase}-${i}`} className="font-semibold text-[#f0f5fc]">
          {p.slice(2, -2)}
        </strong>
      )
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2)
      return (
        <em key={`${keyBase}-${i}`} className="italic text-[#c8d4e6]">
          {p.slice(1, -1)}
        </em>
      )
    if (p.startsWith('`') && p.endsWith('`'))
      return (
        <code key={`${keyBase}-${i}`} className="rounded bg-[#101828] px-1 py-0.5 font-mono text-[10px] text-cyan-300">
          {p.slice(1, -1)}
        </code>
      )
    return <span key={`${keyBase}-${i}`}>{p}</span>
  })
}

function Markdown({ src }: { src: string }) {
  const lines = src.replace(/\r/g, '').split('\n')
  const out: React.ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let table: string[][] | null = null
  let para: string[] = []

  const flushList = () => {
    if (!list) return
    const Tag = list.ordered ? 'ol' : 'ul'
    out.push(
      <Tag key={`l${out.length}`} className={`my-1 space-y-0.5 pl-3 ${list.ordered ? 'list-decimal' : 'list-disc'} marker:text-[#3d4d66]`}>
        {list.items.map((it, i) => (
          <li key={i} className="leading-relaxed">
            {inline(it, `li${out.length}-${i}`)}
          </li>
        ))}
      </Tag>
    )
    list = null
  }
  const flushTable = () => {
    if (!table) return
    const [head, ...rows] = table
    const body = rows.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)))
    out.push(
      <div key={`t${out.length}`} className="my-1.5 overflow-x-auto rounded border border-[#1c2739]">
        <table className="w-full border-collapse text-[10px]">
          <thead>
            <tr className="bg-[#101828]">
              {head.map((c, i) => (
                <th key={i} className="px-2 py-1 text-left font-semibold text-[#aab6cc]">
                  {inline(c, `th${i}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri} className="border-t border-[#141d2e]">
                {r.map((c, ci) => (
                  <td key={ci} className="px-2 py-1 text-[#c8d4e6]">
                    {inline(c, `td${ri}-${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
    table = null
  }
  const flushPara = () => {
    if (!para.length) return
    out.push(
      <p key={`p${out.length}`} className="my-1 leading-relaxed">
        {para.map((l, i) => (
          <span key={i}>
            {i > 0 && ' '}
            {inline(l, `pp${out.length}-${i}`)}
          </span>
        ))}
      </p>
    )
    para = []
  }

  for (const raw of lines) {
    const t = raw.trim()
    if (t.startsWith('|') && t.endsWith('|') && t.length > 2) {
      flushList()
      flushPara()
      table = table ?? []
      table.push(
        t
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim())
      )
      continue
    }
    flushTable()
    if (!t) {
      flushList()
      flushPara()
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t)
    if (h) {
      flushList()
      flushPara()
      out.push(
        <div key={`h${out.length}`} className="mb-0.5 mt-1.5 text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
          {inline(h[2], `hh${out.length}`)}
        </div>
      )
      continue
    }
    const ul = /^[-*•]\s+(.*)$/.exec(t)
    if (ul) {
      flushPara()
      if (!list || list.ordered) {
        flushList()
        list = { ordered: false, items: [] }
      }
      list.items.push(ul[1])
      continue
    }
    const ol = /^(\d+)[.)]\s+(.*)$/.exec(t)
    if (ol) {
      flushPara()
      if (!list || !list.ordered) {
        flushList()
        list = { ordered: true, items: [] }
      }
      list.items.push(ol[2])
      continue
    }
    flushList()
    para.push(t)
  }
  flushList()
  flushTable()
  flushPara()
  return <div className="text-[11px] text-[#dbe4f0]">{out}</div>
}

// ---------------- rich result cards ----------------

function StatCell({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded bg-[#0a0f18] px-1.5 py-1">
      <div className="text-[8px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
      <div className={`font-mono text-[11px] ${tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : 'text-[#dbe4f0]'}`}>{value}</div>
    </div>
  )
}

function TradeCard({ p }: { p: Record<string, unknown> }) {
  const side = String(p.side ?? '').toUpperCase()
  const kind = String(p.kind ?? 'binary')
  const win = side === 'CALL' || side === 'LONG' || side === 'BUY'
  return (
    <div className={`rounded-md border px-2.5 py-2 ${win ? 'border-emerald-700/50 bg-emerald-950/30' : 'border-rose-700/50 bg-rose-950/30'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-white ${win ? 'bg-emerald-600' : 'bg-rose-600'}`}>{side || 'ORDER'}</span>
          <span className="text-[11px] font-semibold text-[#e2e8f0]">{String(p.asset ?? '')}</span>
          <span className="rounded bg-[#101828] px-1 py-0.5 font-mono text-[8px] uppercase text-[#7c8aa5]">{kind}</span>
        </div>
        <span className="font-mono text-[11px] text-[#e2e8f0]">${Number(p.amount ?? 0).toFixed(2)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[9px] text-[#7c8aa5]">
        <span>entry {Number(p.entryPrice ?? 0).toPrecision(6)}</span>
        {p.strike !== undefined && p.strike !== null && <span>strike {Number(p.strike).toPrecision(6)}</span>}
        {p.leverage !== undefined && p.leverage !== null && <span>{Number(p.leverage)}x</span>}
        {p.payout !== undefined && <span>payout {Math.round(Number(p.payout) * 100)}%</span>}
        {p.settlesAt && <span>expires {new Date(Number(p.settlesAt) * 1000).toLocaleTimeString()}</span>}
      </div>
      <div className="mt-0.5 text-[9px] uppercase tracking-wider text-[#4b5a72]">paper order routed to kernel · settles automatically</div>
    </div>
  )
}

function BacktestCard({ r }: { r: Record<string, unknown> }) {
  const m = r.metrics as Record<string, number> | undefined
  if (!m) return null
  const wr = Number(m.winRate)
  return (
    <div className="rounded-md border border-sky-800/50 bg-sky-950/20 px-2.5 py-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-sky-300">
          backtest · {String(r.strategy)} · {String(r.asset)} {String(r.tf)}
        </span>
        <span className={`font-mono text-[10px] ${m.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {m.netPnl >= 0 ? '+' : ''}${Number(m.netPnl).toFixed(2)}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-4 gap-1">
        <StatCell label="win rate" value={`${wr.toFixed(1)}%`} tone={wr >= 55 ? 'good' : wr < 45 ? 'bad' : undefined} />
        <StatCell label="trades" value={String(m.totalTrades)} />
        <StatCell label="PF" value={Number(m.profitFactor).toFixed(2)} tone={m.profitFactor >= 1.3 ? 'good' : m.profitFactor < 1 ? 'bad' : undefined} />
        <StatCell label="max DD" value={`${Number(m.maxDrawdownPct).toFixed(1)}%`} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[9px] text-[#4b5a72]">
        <span>sharpe {Number(m.sharpe).toFixed(2)}</span>
        <span>expectancy {Number(m.expectancy).toFixed(3)}</span>
        <span>equity ${Number(m.finalEquity).toFixed(0)} / ${Number(m.startEquity).toFixed(0)}</span>
      </div>
    </div>
  )
}

function ScanCard({ r }: { r: Record<string, unknown> }) {
  const rows = (r.results as Record<string, unknown>[] | undefined)?.slice(0, 6) ?? []
  if (!rows.length) return null
  return (
    <div className="rounded-md border border-[#1c2739] bg-[#0a0f18] px-2.5 py-2">
      <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
        scanner · {String(r.scanned)} instruments · {String(r.tf)}
      </div>
      <div className="space-y-0.5">
        {rows.map((row, i) => {
          const dir = String(row.direction)
          const score = Number(row.score)
          return (
            <div key={i} className="flex items-center justify-between font-mono text-[10px]">
              <span className="text-[#aab6cc]">{String(row.asset)}</span>
              <span className="flex items-center gap-2">
                <span className="text-[#4b5a72]">p↑ {Number(row.pUp).toFixed(2)}</span>
                <span className={dir === 'call' ? 'text-emerald-400' : dir === 'put' ? 'text-rose-400' : 'text-[#7c8aa5]'}>
                  {dir === 'call' ? '▲ CALL' : dir === 'put' ? '▼ PUT' : '· NONE'} {score > 0 ? '+' : ''}
                  {score.toFixed(0)}
                </span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function UiChipCard({ args }: { args?: Record<string, unknown> }) {
  const desc = (() => {
    if (!args) return 'workspace updated'
    if (args.asset) return `chart switched to ${String(args.asset)}`
    if (args.tf) return `timeframe → ${String(args.tf)}`
    if (args.chartType) return `chart type → ${String(args.chartType)}`
    if (args.id) return `${String(args.id)} applied to your chart`
    return 'indicators cleared'
  })()
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-violet-800/50 bg-violet-950/30 px-2 py-0.5 text-[9px] text-violet-300">
      <span className="h-1 w-1 rounded-full bg-violet-400" />
      {desc}
    </div>
  )
}

function ToolCard({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const g = toolGroup(item.tool)
  const running = item.status === 'run'
  const r = item.preview ? (safeParse(item.preview) as Record<string, unknown> | null) : null

  // upgrade to a rich card for known result shapes
  let card: React.ReactNode = null
  if (!running && r) {
    if (item.tool === 'place_trade' && r.ok && r.position) card = <TradeCard p={r.position as Record<string, unknown>} />
    else if (item.tool === 'backtest' && r.ok && r.result) card = <BacktestCard r={r.result as Record<string, unknown>} />
    else if (item.tool === 'scan_market' && r.ok) card = <ScanCard r={r} />
  }

  return (
    <div className="space-y-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-md border border-[#141d2e] bg-[#0d1420] px-2 py-1.5 text-left transition-colors hover:border-[#243450]"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'animate-pulse bg-cyan-400' : item.status === 'ok' ? g.dot : 'bg-rose-500'}`} />
          <span className={`font-mono text-[10px] ${g.label}`}>{item.tool}</span>
          <span className="truncate font-mono text-[9px] text-[#4b5a72]">{fmtArgs(item.args)}</span>
        </span>
        <span className="ml-2 shrink-0 font-mono text-[9px] text-[#4b5a72]">
          {running ? 'running…' : `${item.ms ?? 0}ms ${item.status === 'err' ? '· failed' : ''}`}
        </span>
      </button>
      {card}
      {open && item.preview && (
        <div className="max-h-28 overflow-y-auto rounded border border-[#141d2e] bg-[#0a0f18] p-1.5 font-mono text-[9px] leading-relaxed text-[#5d6f8c]">{item.preview}</div>
      )}
    </div>
  )
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// ---------------- main component ----------------

const QUICK_BASE: { label: string; build: (a: string, tf: string) => string }[] = [
  { label: 'Read my chart', build: (a, tf) => `Analyze ${a} ${tf} for me: indicators, candlestick + chart patterns, Markov regime and Monte Carlo. Give me the full read-out and a verdict.` },
  { label: 'MTF confluence', build: (a) => `Run a multi-timeframe confluence check on ${a} (5m/15m/1h/4h). Where do the timeframes agree or fight each other?` },
  { label: 'Scan for setups', build: () => `Scan the whole market on 5m and show me the strongest bullish and bearish setups right now. Pick the top candidate and explain why.` },
  { label: 'Find my edge', build: (a, tf) => `Which strategy backtests best on ${a} ${tf} right now? Test the top 2-3 and compare win rate and profit factor.` },
  { label: 'Set up my chart', build: (a) => `Set up my ${a} chart for analysis: add Bollinger Bands, Supertrend and a MACD sub-pane, switch to candles, then explain what each is telling me.` },
]

export default function Copilot({ session = 'default', asset, tf, chartType, overlays, subs, balance, onUiCommand }: CopilotProps) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [loaded, setLoaded] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  const uiRef = useRef(onUiCommand)
  uiRef.current = onUiCommand

  // restore persisted history
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/agent?session=${encodeURIComponent(session)}`)
        const d = (await res.json()) as { ok: boolean; messages?: { role: string; content: string }[] }
        if (!cancelled && d.ok && d.messages?.length) {
          setMessages(
            d.messages.slice(-40).map((m) => ({
              role: m.role === 'user' ? 'user' : 'assistant',
              content: m.content,
            }))
          )
        }
      } catch {
        /* offline kernel - start empty */
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session])

  // stick-to-bottom scrolling unless the user scrolled up
  useEffect(() => {
    if (stickRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, busy, status])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  const patchLast = useCallback((fn: (m: Msg) => Msg) => {
    setMessages((ms) => {
      if (!ms.length) return ms
      const copy = [...ms]
      copy[copy.length - 1] = fn(copy[copy.length - 1])
      return copy
    })
  }, [])

  const send = async (text: string) => {
    const msg = text.trim()
    if (!msg || busy) return
    setInput('')
    setBusy(true)
    setStatus('connecting…')
    stickRef.current = true

    const ctrl = new AbortController()
    abortRef.current = ctrl

    const draft: Msg = { role: 'assistant', content: '', events: [], streaming: true }
    setMessages((ms) => [...ms, { role: 'user', content: msg }, draft])

    const pushEvent = (ev: TimelineItem) =>
      patchLast((m) => ({ ...m, events: [...(m.events ?? []), ev] }))
    const patchEvent = (id: number, patch: Partial<Extract<TimelineItem, { kind: 'tool' }>>) =>
      patchLast((m) => ({
        ...m,
        events: (m.events ?? []).map((e) => (e.kind === 'tool' && e.id === id ? { ...e, ...patch } : e)),
      }))

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          sessionId: session,
          message: msg,
          ui: { asset, tf, chartType, overlays, subs },
        }),
      })
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '')
        throw new Error(errText || `HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let gotFinal = false
      let lastError = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue
            let ev: Record<string, unknown>
            try {
              ev = JSON.parse(line.slice(6)) as Record<string, unknown>
            } catch {
              continue
            }
            switch (ev.type) {
              case 'status':
                setStatus(String(ev.text ?? ''))
                break
              case 'say':
                if (ev.text) pushEvent({ kind: 'say', text: String(ev.text) })
                break
              case 'tool_start':
                pushEvent({ kind: 'tool', id: Number(ev.id), tool: String(ev.tool), args: ev.args as Record<string, unknown>, status: 'run' })
                break
              case 'tool_end':
                patchEvent(Number(ev.id), {
                  status: ev.ok ? 'ok' : 'err',
                  ms: Number(ev.ms ?? 0),
                  preview: ev.preview ? String(ev.preview) : undefined,
                })
                break
              case 'ui':
                uiRef.current?.(String(ev.cmd), ev.args as Record<string, unknown> | undefined)
                break
              case 'final':
                gotFinal = true
                setStatus('')
                pushEvent({ kind: 'final', text: String(ev.text ?? '') })
                break
              case 'error':
                lastError = String(ev.message ?? 'agent error')
                break
              case 'done':
                break
            }
          }
        }
      }

      patchLast((m) => ({
        ...m,
        streaming: false,
        content: '',
        error: Boolean(lastError) && !gotFinal,
        events: (m.events ?? []).some((e) => e.kind === 'final')
          ? m.events
          : [...(m.events ?? []), { kind: 'final', text: lastError || 'The run ended without an answer - try rephrasing.' }],
      }))
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError'
      patchLast((m) => ({
        ...m,
        streaming: false,
        error: !aborted,
        events: (m.events ?? []).some((e) => e.kind === 'final')
          ? m.events
          : [...(m.events ?? []), { kind: 'final', text: aborted ? '⏹ stopped by user' : `Connection error: ${(err as Error).message}` }],
      }))
    } finally {
      setBusy(false)
      setStatus('')
      abortRef.current = null
    }
  }

  const stop = () => abortRef.current?.abort()

  const clearChat = async () => {
    if (busy) return
    setMessages([])
    try {
      await fetch(`/api/agent?session=${encodeURIComponent(session)}`, { method: 'DELETE' })
    } catch {
      /* local clear is enough */
    }
  }

  const exportChat = () => {
    const md = messages
      .map((m) => (m.role === 'user' ? `### You\n${m.content}` : `### OS Copilot\n${(m.events ?? []).filter((e) => e.kind === 'final').map((e) => (e as { text: string }).text).join('\n') || m.content}`))
      .join('\n\n---\n\n')
    const blob = new Blob([`# IQAIR//OS Copilot session - ${new Date().toISOString()}\n\n${md}\n`], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `iqos-copilot-${Date.now()}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const quick = QUICK_BASE.map((q) => ({ label: q.label, prompt: q.build(asset ?? 'EURUSD', tf ?? '1m') }))

  return (
    <div className="flex h-full flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      {/* header */}
      <div className="flex items-center justify-between border-b border-[#1c2739] px-3 py-2">
        <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">
          <span className={`h-1.5 w-1.5 rounded-full ${busy ? 'animate-pulse bg-cyan-400 shadow-[0_0_6px_#22d3ee]' : 'bg-cyan-400 shadow-[0_0_6px_#22d3ee]'}`} />
          OS Copilot
          <span className="rounded bg-[#101828] px-1 py-0.5 text-[8px] font-mono tracking-normal text-cyan-400">v2 · 32 tools</span>
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={exportChat}
            disabled={!messages.length}
            title="Export session as markdown"
            className="rounded px-1.5 py-0.5 font-mono text-[9px] text-[#4b5a72] transition-colors hover:bg-[#101828] hover:text-[#aab6cc] disabled:opacity-30"
          >
            export
          </button>
          <button
            onClick={() => void clearChat()}
            disabled={busy || !messages.length}
            title="Clear conversation"
            className="rounded px-1.5 py-0.5 font-mono text-[9px] text-[#4b5a72] transition-colors hover:bg-[#101828] hover:text-rose-300 disabled:opacity-30"
          >
            clear
          </button>
        </div>
      </div>

      {/* live status strip */}
      {(busy || status) && (
        <div className="flex items-center gap-2 border-b border-[#141d2e] bg-[#0a101a] px-3 py-1 font-mono text-[9px] text-cyan-500">
          <span className="h-1 w-1 animate-ping rounded-full bg-cyan-400" />
          {status || 'harness running…'}
        </div>
      )}

      {/* conversation */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {loaded && messages.length === 0 && (
          <div className="space-y-2">
            <div className="rounded-md border border-[#1c2739] bg-gradient-to-br from-[#0d1420] to-[#0a1220] p-2.5 text-[11px] leading-relaxed text-[#7c8aa5]">
              <span className="text-cyan-400">Copilot v2</span> is wired into the kernel: full TA + quant analysis, market scanner, strategy
              backtests, paper execution — and I can drive your workspace (switch charts, timeframes, add indicators). Ask anything, or tap a
              quick action.
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {quick.map((q) => (
                <button
                  key={q.label}
                  onClick={() => void send(q.prompt)}
                  disabled={busy}
                  className="rounded-md border border-[#1c2739] bg-[#0d1420] px-2 py-1.5 text-left text-[10px] text-[#aab6cc] transition-colors hover:border-cyan-500/40 hover:text-cyan-200 disabled:opacity-40"
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
            {m.role === 'user' ? (
              <div className="max-w-[85%] rounded-md rounded-br-sm border border-cyan-900/50 bg-cyan-950/60 px-2.5 py-1.5 text-[11px] text-cyan-100">{m.content}</div>
            ) : (
              <div className="space-y-1.5">
                {(m.events ?? []).length === 0 && m.content ? (
                  // restored from history - plain content, no timeline
                  <div className={`max-w-[98%] whitespace-pre-wrap rounded-md rounded-bl-sm border px-2.5 py-1.5 ${m.error ? 'border-rose-900/50 bg-rose-950/20' : 'border-[#1c2739] bg-[#0d1420]'}`}>
                    {m.error ? <span className="text-rose-300">{m.content}</span> : <Markdown src={m.content} />}
                  </div>
                ) : (
                  (m.events ?? []).map((e, ei) => {
                  if (e.kind === 'say')
                    return (
                      <div key={ei} className="flex items-start gap-1.5 text-[10px] italic text-[#7c8aa5]">
                        <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[#3d4d66]" />
                        {e.text}
                      </div>
                    )
                  if (e.kind === 'tool') return <ToolCard key={ei} item={e} />
                  // final
                  return (
                    <div key={ei} className="group relative">
                      <div className={`max-w-[98%] whitespace-pre-wrap rounded-md rounded-bl-sm border px-2.5 py-1.5 ${m.error ? 'border-rose-900/50 bg-rose-950/20' : 'border-[#1c2739] bg-[#0d1420]'}`}>
                        {m.error ? <span className="text-rose-300">{e.text}</span> : <Markdown src={e.text} />}
                      </div>
                      {!m.error && !m.streaming && (
                        <button
                          onClick={() => void navigator.clipboard?.writeText(e.text)}
                          className="absolute -right-1 top-1 hidden rounded bg-[#101828] px-1.5 py-0.5 font-mono text-[8px] text-[#7c8aa5] group-hover:block hover:text-cyan-300"
                        >
                          copy
                        </button>
                      )}
                    </div>
                  )
                  })
                )}
                {m.streaming && !(m.events ?? []).some((e) => e.kind === 'tool') && (
                  <div className="flex items-center gap-1.5 px-1 py-1">
                    {[0, 1, 2].map((d) => (
                      <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-500/70" style={{ animationDelay: `${d * 140}ms` }} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* quick actions */}
      {messages.length > 0 && (
        <div className="flex gap-1 overflow-x-auto border-t border-[#141d2e] px-2 py-1.5 [scrollbar-width:none]">
          {quick.map((q) => (
            <button
              key={q.label}
              onClick={() => void send(q.prompt)}
              disabled={busy}
              className="shrink-0 rounded-full border border-[#1c2739] bg-[#0d1420] px-2 py-0.5 text-[9px] text-[#7c8aa5] transition-colors hover:border-cyan-500/40 hover:text-cyan-300 disabled:opacity-40"
            >
              {q.label}
            </button>
          ))}
        </div>
      )}

      {/* composer */}
      <form
        className="flex gap-2 border-t border-[#1c2739] p-2"
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? 'copilot is working…' : asset ? `Ask about ${asset} ${tf ?? ''}…` : 'Ask the copilot…'}
          disabled={busy}
          className="h-9 border-[#1c2739] bg-[#101828] text-[12px] text-[#e2e8f0] placeholder:text-[#3d4d66]"
        />
        {busy ? (
          <Button type="button" onClick={stop} className="h-9 bg-rose-700 px-3 text-white hover:bg-rose-600">
            Stop
          </Button>
        ) : (
          <Button type="submit" className="h-9 bg-cyan-600 px-3 text-white hover:bg-cyan-500">
            Send
          </Button>
        )}
      </form>
    </div>
  )
}
