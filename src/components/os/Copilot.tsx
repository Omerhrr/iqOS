'use client'

// IQAIR//OS - AI Copilot (agent harness chat with tool trace)
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface TraceEntry {
  tool: string
  args?: Record<string, unknown>
  result?: unknown
  say?: string
}

/** If the model ever leaks a raw tool-call JSON as its reply, show the human `say` instead. */
function sanitizeReply(text: string): string {
  const t = text.trim()
  if (!t.startsWith('{')) return t
  try {
    const p = JSON.parse(t.replace(/```json|```/g, '')) as { action?: string; say?: string }
    if (p.action && p.action !== 'final' && p.say) return p.say
  } catch {
    // not json - fine
  }
  return t
}

interface Msg {
  role: 'user' | 'assistant'
  content: string
  trace?: TraceEntry[]
}

const SUGGESTIONS = [
  'Analyze BTCUSD: indicators + Markov regime',
  'Which strategy has the best backtest right now?',
  'Run a Markov-edge backtest on EURUSD 5m',
  'What is the Monte Carlo outlook for NVDA?',
]

export default function Copilot({ session = 'default' }: { session?: string }) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [openTrace, setOpenTrace] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, busy])

  const send = async (text: string) => {
    const msg = text.trim()
    if (!msg || busy) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', content: msg }, { role: 'assistant', content: '…thinking', pending: true } as unknown as Msg])
    setBusy(true)
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: session, message: msg }),
      })
      const data = (await res.json()) as { ok: boolean; reply?: string; trace?: TraceEntry[]; error?: string }
      const reply = data.ok ? sanitizeReply(data.reply ?? '(empty)') : `Error: ${data.error}`
      setMessages((m) => {
        const copy = [...m]
        copy[copy.length - 1] = { role: 'assistant', content: reply, trace: data.trace }
        return copy
      })
    } catch (err) {
      setMessages((m) => {
        const copy = [...m]
        copy[copy.length - 1] = { role: 'assistant', content: `Error: ${(err as Error).message}` }
        return copy
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex items-center justify-between border-b border-[#1c2739] px-3 py-2">
        <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">
          <span className="flex h-1.5 w-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_#22d3ee]" />
          OS Copilot
        </h3>
        <span className="text-[9px] font-mono text-[#4b5a72]">tool-calling harness</span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="space-y-2">
            <div className="rounded-md border border-[#1c2739] bg-[#0d1420] p-2.5 text-[11px] leading-relaxed text-[#7c8aa5]">
              I am wired into the OS kernel: I can run full analyses (RSI, MACD, Bollinger, patterns), fit Markov chains, simulate Monte Carlo
              paths, backtest any strategy, and place paper trades through the risk manager. Ask me anything about the markets on screen.
            </div>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => void send(s)}
                className="block w-full rounded-md border border-[#1c2739] bg-[#0d1420] px-2.5 py-2 text-left text-[11px] text-[#aab6cc] transition-colors hover:border-cyan-500/40 hover:text-cyan-200"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
            {m.role === 'user' ? (
              <div className="max-w-[85%] rounded-md rounded-br-sm bg-cyan-950/60 border border-cyan-900/50 px-2.5 py-1.5 text-[11px] text-cyan-100">
                {m.content}
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="max-w-[95%] whitespace-pre-wrap rounded-md rounded-bl-sm border border-[#1c2739] bg-[#0d1420] px-2.5 py-1.5 text-[11px] leading-relaxed text-[#dbe4f0]">
                  {m.content}
                </div>
                {m.trace && m.trace.length > 0 && (
                  <div className="rounded-md border border-[#1c2739] bg-[#0a0f18]">
                    <button
                      onClick={() => setOpenTrace(openTrace === i ? null : i)}
                      className="flex w-full items-center justify-between px-2 py-1 text-[9px] font-mono uppercase tracking-wider text-[#4b5a72] hover:text-[#7c8aa5]"
                    >
                      <span>tool trace · {m.trace.length} calls</span>
                      <span>{openTrace === i ? '−' : '+'}</span>
                    </button>
                    {openTrace === i && (
                      <div className="space-y-1 px-2 pb-2">
                        {m.trace.map((t, ti) => (
                          <div key={ti} className="rounded border border-[#141d2e] bg-[#0d1420] p-1.5 font-mono text-[9px] text-[#7c8aa5]">
                            <div className="text-cyan-500">
                              → {t.tool} {t.args ? JSON.stringify(t.args).slice(0, 90) : ''}
                            </div>
                            {t.say && <div className="text-[#4b5a72]">say: {t.say}</div>}
                            <div className="mt-0.5 truncate text-[#3d4d66]">
                              {JSON.stringify(t.result).slice(0, 140)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-2 px-1 text-[10px] font-mono text-cyan-500">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />
            harness running - tools may be executing…
          </div>
        )}
      </div>

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
          placeholder="Ask the copilot…"
          disabled={busy}
          className="h-9 border-[#1c2739] bg-[#101828] text-[12px] text-[#e2e8f0] placeholder:text-[#3d4d66]"
        />
        <Button type="submit" disabled={busy} className="h-9 bg-cyan-600 px-3 text-white hover:bg-cyan-500 disabled:opacity-40">
          Send
        </Button>
      </form>
    </div>
  )
}
