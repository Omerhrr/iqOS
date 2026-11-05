import { NextRequest, NextResponse } from 'next/server'
import { chatComplete } from '@/lib/llm'
import { buildCodeAssistMessages, parseCodeAssistReply, type CodeAssistKind } from '@/lib/codeAssist'

// IQAIR//OS - "invoke the AI and describe it so it will build the strat...
// if any error, we can have the ai scan and fix" per direct instruction.
// One shared, non-streaming endpoint behind every code editor's "AI" bar
// (Meta Strategy Lab's script editor, Meta Strategy's built-in-source
// editor, the Strategy Lab's builtin.ts editor, AI Lab's script editor) -
// codeAssist.ts holds the per-kind system prompt (the exact language/shape
// that editor edits), this route just calls the model once and returns the
// generated/fixed code. Never writes anything itself - the result lands
// back in the SAME editor the user was already looking at, so the editor's
// own existing test/save path (MSL's parser, or Bun.Transpiler's syntax
// check for the two real-TypeScript kinds) is still what actually
// validates and persists it.
const VALID_KINDS: CodeAssistKind[] = ['msl', 'ai_lab_script', 'builtin_strategy_ts', 'meta_source_ts']

export async function POST(req: NextRequest) {
  let body: {
    kind?: string
    mode?: string
    instruction?: string
    currentCode?: string
    error?: string
    context?: Record<string, string | number | undefined>
  }
  try {
    body = (await req.json()) as typeof body
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 })
  }

  const kind = body.kind as CodeAssistKind
  if (!VALID_KINDS.includes(kind)) {
    return NextResponse.json({ ok: false, error: `unknown kind "${String(body.kind)}" - expected one of ${VALID_KINDS.join(', ')}` }, { status: 400 })
  }
  const mode = body.mode === 'fix' ? 'fix' : 'build'
  if (mode === 'build' && !(body.instruction ?? '').trim()) {
    return NextResponse.json({ ok: false, error: 'describe what you want built/changed first' }, { status: 400 })
  }
  if (mode === 'fix' && !(body.error ?? '').trim()) {
    return NextResponse.json({ ok: false, error: 'no error to fix - run a test/save first and pass its error back' }, { status: 400 })
  }

  try {
    const messages = buildCodeAssistMessages({
      kind,
      mode,
      instruction: body.instruction,
      currentCode: body.currentCode,
      error: body.error,
      context: body.context,
    })
    const completion = await chatComplete({ messages, timeoutMs: 60_000, temperature: 0.3, signal: req.signal })
    const { code, explanation } = parseCodeAssistReply(completion.content)
    if (!code.trim()) return NextResponse.json({ ok: false, error: 'the model returned empty code - try rephrasing' }, { status: 502 })
    return NextResponse.json({ ok: true, code, explanation, provider: completion.provider, model: completion.model })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 502 })
  }
}
