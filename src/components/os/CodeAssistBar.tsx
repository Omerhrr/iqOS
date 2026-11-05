'use client'

// IQAIR//OS - "we should be able to invoke the ai and describe it so it
// will build the strat, also we can build ourself, if any error, we can
// have the ai scan and fix" per direct instruction - and per direct
// correction, "the code assist is just copilot going out to other parts":
// this bar is the Copilot itself (same identity/knowledge, see
// lib/copilotKnowledge.ts) reaching into one editor, not a separate
// assistant. One shared bar, reused in every code editor (Meta Strategy
// Lab's script editor, Meta Strategy's built-in-source editor, the
// Strategy Lab's builtin.ts editor, AI Lab's script editor) - each just
// passes its own `kind` so /api/code_assist's prompt matches the exact
// language/shape that editor edits. Two actions:
//   - describe what you want -> "build/update with AI" (mode 'build')
//   - after a failed test/save -> "scan & fix with AI" (mode 'fix'),
//     enabled only once `lastError` is non-empty, so there's always a real
//     error to hand back, not a guess
// Never writes directly into the caller's state - every result renders in
// a preview pane first with its own Apply/Discard, so "build it myself"
// always stays possible: the AI is an assist, not a takeover.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { codeAssist, type CodeAssistKind } from '@/lib/os/client'

interface CodeAssistBarProps {
  kind: CodeAssistKind
  currentCode: string
  onApply: (code: string) => void
  /** The exact error string from the editor's own last test/save call, if
   * any - "scan & fix" is disabled until there's a real one to hand back. */
  lastError?: string | null
  /** Free-form context folded into the AI's user message (asset/tf/method
   * name/strategy id/etc.) - purely informational, never changes the
   * system prompt's rules for `kind`. */
  context?: Record<string, string | number | undefined>
  className?: string
}

export default function CodeAssistBar({ kind, currentCode, onApply, lastError, context, className }: CodeAssistBarProps) {
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<{ code: string; explanation: string } | null>(null)

  const run = async (mode: 'build' | 'fix') => {
    setBusy(true)
    setError(null)
    setSuggestion(null)
    try {
      const res = await codeAssist({
        kind,
        mode,
        instruction: instruction.trim() || undefined,
        currentCode,
        error: mode === 'fix' ? lastError ?? undefined : undefined,
        context,
      })
      if (!res.ok || !res.code) throw new Error(res.error ?? 'the AI did not return usable code')
      setSuggestion({ code: res.code, explanation: res.explanation ?? '' })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const apply = () => {
    if (!suggestion) return
    onApply(suggestion.code)
    setSuggestion(null)
    setInstruction('')
  }

  return (
    <div className={`rounded border border-violet-500/30 bg-[#0b0817] p-1.5 ${className ?? ''}`}>
      <div className="flex items-center gap-1 font-mono text-[8.5px] font-bold uppercase tracking-wider text-violet-300">
        <span>✦ copilot</span>
        <span className="font-normal normal-case text-[#4b5a72]">describe it and Copilot writes it here - or write it yourself and ask Copilot to fix an error</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="e.g. call when oracle and renko both agree and SMC confirms with FVG..."
          disabled={busy}
          className="min-w-0 flex-1 rounded border border-[#1c2739] bg-[#070c15] px-1.5 py-1 font-mono text-[9.5px] text-[#dbe4f0] outline-none focus:border-violet-500/40 disabled:opacity-50"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy && instruction.trim()) void run('build')
          }}
        />
        <Button
          size="sm"
          disabled={busy || !instruction.trim()}
          className="h-6 shrink-0 bg-violet-600 px-2 text-[9px] font-bold uppercase tracking-wider text-white hover:bg-violet-500 disabled:opacity-50"
          onClick={() => void run('build')}
        >
          {busy ? 'thinking...' : currentCode.trim() ? 'update with AI' : 'build with AI'}
        </Button>
        {lastError && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            className="h-6 shrink-0 border-rose-500/40 px-2 text-[9px] font-bold uppercase tracking-wider text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
            onClick={() => void run('fix')}
            title={lastError}
          >
            {busy ? 'scanning...' : 'scan & fix error'}
          </Button>
        )}
      </div>
      {error && <p className="mt-1 font-mono text-[9px] text-rose-300">{error}</p>}
      {suggestion && (
        <div className="mt-1.5 rounded border border-violet-500/30 bg-[#070c15] p-1.5">
          {suggestion.explanation && <p className="mb-1 font-mono text-[9px] text-[#aab6cc]">{suggestion.explanation}</p>}
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[9px] leading-relaxed text-[#dbe4f0]">{suggestion.code}</pre>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Button size="sm" className="h-6 bg-emerald-600 px-2 text-[9px] font-bold uppercase tracking-wider text-white hover:bg-emerald-500" onClick={apply}>
              apply to editor
            </Button>
            <Button variant="outline" size="sm" className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5]" onClick={() => setSuggestion(null)}>
              discard
            </Button>
            <span className="font-mono text-[8.5px] text-[#4b5a72]">review before you test/save - the AI can be wrong</span>
          </div>
        </div>
      )}
    </div>
  )
}
