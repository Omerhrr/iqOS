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
//
// P2 AUDIT FIX (was an open relay): bounds + auth.
//  - timeoutMs/maxTokens arrive from the network - clamp both instead of
//    passing them into chatComplete verbatim (an unbounded timeout let a
//    caller pin one provider slot for minutes; absurd maxTokens let it
//    burn the provider's billing in one call).
//  - when KERNEL_TOKEN is set in THIS app's env, require the same
//    x-kernel-token header the kernel itself already validates (see
//    middleware.ts + trading-core/index.ts). trading-core's callLlm()
//    sends it whenever its own env carries the token - symmetric, so a
//    compose deployment (or any shared root .env) gets a closed relay,
//    while a bare dev setup with no token configured keeps working.
const clampNum = (v: unknown, lo: number, hi: number, fb: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb
}

export async function POST(req: NextRequest) {
  const expected = (process.env.KERNEL_TOKEN ?? '').trim()
  if (expected && (req.headers.get('x-kernel-token') ?? '').trim() !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized - x-kernel-token required' }, { status: 401 })
  }
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
      maxTokens: clampNum(body.maxTokens, 16, 8192, 700),
      timeoutMs: clampNum(body.timeoutMs, 5_000, 120_000, 45_000),
      signal: req.signal,
    })
    return NextResponse.json({ ok: true, content: completion.content, provider: completion.provider, model: completion.model })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 502 })
  }
}
