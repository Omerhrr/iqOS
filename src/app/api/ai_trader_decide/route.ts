import { NextRequest, NextResponse } from 'next/server'
import { chatComplete, type ChatMessage } from '@/lib/llm'

// IQAIR//OS - "cant the ai trader be an instance of copilot, with that they
// share keys so [no] separate setup" per direct instruction.
//
// trading-core (mini-services/trading-core) is a SEPARATE Bun process with
// its OWN cwd and its OWN process.env - it was never able to see the keys
// in this Next.js app's .env, no matter how many env-sharing tricks got
// layered on (a root-.env loader, BOM stripping, diagnostics - all still
// landed on "trading-core has to somehow get its own copy of the config").
// The honest fix the user is asking for is the opposite direction: don't
// give trading-core a second copy of the LLM setup AT ALL - have it call
// INTO this already-working process instead, the exact same way the
// Copilot's own chat and the CodeAssistBar's /api/code_assist already do.
// One key, one place it's read, one thing to keep working.
//
// This route is intentionally generic (messages in, one completion out) -
// it carries no AI-Trader-specific knowledge (the prompt, the JSON
// decision contract, the panel-reads snapshot) because none of that
// belongs server-side in THIS app; aitrader.ts in trading-core still owns
// 100% of that reasoning and parsing, exactly as before. The only thing
// that moved is WHICH PROCESS actually dials the provider.
export async function POST(req: NextRequest) {
  let body: { messages?: ChatMessage[]; temperature?: number; maxTokens?: number; timeoutMs?: number }
  try {
    body = (await req.json()) as typeof body
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 })
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return NextResponse.json({ ok: false, error: 'missing messages[]' }, { status: 400 })
  }
  try {
    const completion = await chatComplete({
      messages: body.messages,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      timeoutMs: body.timeoutMs ?? 45_000,
      signal: req.signal,
    })
    return NextResponse.json({ ok: true, content: completion.content, provider: completion.provider, model: completion.model })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 502 })
  }
}
