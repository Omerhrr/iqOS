/**
 * Multi-provider LLM layer for iqOS.
 *
 * One unified chat-completions entry point (`chatComplete`) that routes to the
 * first enabled + working provider. Providers are toggled with env flags and
 * every provider falls back to the next enabled one on failure, so the Copilot
 * brain keeps working even if a key/quota/endpoint is down.
 *
 * ## Env contract (.env or .env.local — server-side only)
 *   USE_ZAI=true|false        USE_DEEPSEEK=true|false    USE_ANTHROPIC=true|false
 *   USE_OPENAI=true|false     USE_GEMINI=true|false      USE_OLLAMA=true|false
 *   LLM_ORDER=zai,deepseek,anthropic,openai,gemini,ollama   (optional priority)
 *
 *   ZAI_API_KEY=...           (optional — omit to use z-ai-web-dev-sdk / .z-ai-config,
 *                              e.g. inside the managed sandbox)
 *   DEEPSEEK_API_KEY=...      ANTHROPIC_API_KEY=...      OPENAI_API_KEY=...
 *   GEMINI_API_KEY=...        OLLAMA_BASE_URL=http://localhost:11434
 *
 *   ZAI_MODEL=glm-4.6         DEEPSEEK_MODEL=deepseek-chat
 *   ANTHROPIC_MODEL=claude-sonnet-4-5
 *   OPENAI_MODEL=gpt-4o       GEMINI_MODEL=gemini-2.5-flash
 *   OLLAMA_MODEL=llama3.1
 *
 * Z.ai keeps two transports: the managed SDK (no key needed where .z-ai-config
 * exists) and a direct OpenAI-compatible fetch when ZAI_API_KEY is set.
 * DeepSeek / OpenAI / Gemini / Ollama all speak the OpenAI-compatible protocol;
 * Anthropic uses its native Messages API (system is top-level, max_tokens required).
 */

export type ProviderId = 'zai' | 'deepseek' | 'anthropic' | 'openai' | 'gemini' | 'ollama'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ChatResult {
  content: string
  provider: ProviderId
  model: string
}

const DEFAULT_MODELS: Record<ProviderId, string> = {
  zai: 'glm-4.6',
  deepseek: 'deepseek-chat',
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-flash',
  ollama: 'llama3.1',
}

const PROVIDER_ORDER: ProviderId[] = ['zai', 'deepseek', 'anthropic', 'openai', 'gemini', 'ollama']

const env = (k: string): string => (process.env[k] ?? '').trim()
const envBool = (k: string): boolean => ['1', 'true', 'yes', 'on'].includes(env(k).toLowerCase())
const modelOf = (p: ProviderId): string => env(`${p.toUpperCase()}_MODEL`) || DEFAULT_MODELS[p]

/** OpenAI-compatible endpoints (Gemini exposes one too; Ollama at /v1). */
const OPENAI_COMPAT_BASE: Record<Exclude<ProviderId, 'zai' | 'anthropic'>, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: '', // resolved at call time from OLLAMA_BASE_URL
}

function isProviderId(v: string): v is ProviderId {
  return (PROVIDER_ORDER as string[]).includes(v)
}

/** Combine a caller-provided abort signal with a hard timeout - passing only
 * `signal` would otherwise silently defeat `timeoutMs` (a request tied to a
 * long-lived SSE stream that never itself aborts could then hang forever on a
 * slow/dead endpoint). Falls back to timeout-only or signal-only when the
 * other is absent. */
function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

/** Providers currently switched on via USE_*=true, ordered by LLM_ORDER or default.
 * If NO USE_* flag is set at all (a bare checkout with no .env yet), default to
 * zai alone - that's how this OS behaved before multi-provider support existed
 * (zero-config inside the managed sandbox via .z-ai-config), so an empty .env
 * doesn't silently turn the copilot off. Set USE_ZAI=false explicitly to opt out
 * without enabling anything else. */
export function enabledProviders(): ProviderId[] {
  const flagKeys: Record<ProviderId, string> = {
    zai: 'USE_ZAI',
    deepseek: 'USE_DEEPSEEK',
    anthropic: 'USE_ANTHROPIC',
    openai: 'USE_OPENAI',
    gemini: 'USE_GEMINI',
    ollama: 'USE_OLLAMA',
  }
  const anySet = PROVIDER_ORDER.some((p) => env(flagKeys[p]) !== '')
  const flags: Partial<Record<ProviderId, boolean>> = anySet
    ? { zai: envBool('USE_ZAI'), deepseek: envBool('USE_DEEPSEEK'), anthropic: envBool('USE_ANTHROPIC'), openai: envBool('USE_OPENAI'), gemini: envBool('USE_GEMINI'), ollama: envBool('USE_OLLAMA') }
    : { zai: true }
  const enabled = PROVIDER_ORDER.filter((p) => flags[p])
  if (enabled.length <= 1) return enabled
  const custom = env('LLM_ORDER').split(',').map((s) => s.trim().toLowerCase()).filter(isProviderId)
  if (!custom.length) return enabled
  return [...custom.filter((p) => enabled.includes(p)), ...enabled.filter((p) => !custom.includes(p))]
}

/** True when the provider has whatever credential it needs. zai is always
 * "ready" from a config standpoint: with ZAI_API_KEY it goes direct, without
 * one it falls to the managed SDK (.z-ai-config) - if THAT is also missing,
 * the actual chatComplete() call fails and chatComplete's own fallback loop
 * moves on to the next enabled provider, so gating on env flags here would
 * just mean "enabled but always filtered out" the moment USE_ZAI is implied
 * rather than explicitly set (the zero-.env default case). */
function providerReady(p: ProviderId): boolean {
  switch (p) {
    case 'zai':
    case 'ollama':
      return true // ollama: local server needs no key (base URL still required)
    default:
      return !!env(`${p.toUpperCase()}_API_KEY`)
  }
}

/** Human-readable readiness map for /api/llm and diagnostics. */
export function providerStatus(): {
  order: ProviderId[]
  providers: { id: ProviderId; enabled: boolean; ready: boolean; model: string; baseUrl: string }[]
} {
  const order = enabledProviders()
  return {
    order,
    providers: PROVIDER_ORDER.map((id) => ({
      id,
      enabled: order.includes(id),
      ready: order.includes(id) && providerReady(id),
      model: modelOf(id),
      baseUrl:
        id === 'zai'
          ? env('ZAI_API_KEY') ? 'https://api.z.ai/api/paas/v4' : 'sdk(.z-ai-config)'
          : id === 'anthropic'
            ? 'https://api.anthropic.com/v1'
            : id === 'ollama'
              ? env('OLLAMA_BASE_URL') || 'http://localhost:11434'
              : OPENAI_COMPAT_BASE[id],
    })),
  }
}

// ---------------------------------------------------------------- transports

/** z-ai-web-dev-sdk (managed gateway) — system prompt rides as leading assistant msg.
 * The SDK takes no AbortSignal of its own, so an incoming abort only stops US
 * from waiting on it (the upstream call may still run to completion in the
 * background) - same limitation as the pre-multi-provider code had. */
async function zaiSdkChat(messages: ChatMessage[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const { default: ZAI } = await import('z-ai-web-dev-sdk')
  const zai = await ZAI.create()
  const payload: ChatMessage[] = messages.map((m) =>
    m.role === 'system' ? { role: 'assistant', content: m.content } : { role: m.role, content: m.content }
  )
  const completion = (await Promise.race([
    zai.chat.completions.create({ messages: payload, thinking: { type: 'disabled' } }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('zai sdk timeout')), timeoutMs)),
    ...(signal ? [new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }))] : []),
  ])) as { choices?: { message?: { content?: string } }[] }
  const content = completion.choices?.[0]?.message?.content ?? ''
  if (!content) throw new Error('zai sdk returned empty content')
  return content
}

/** Direct OpenAI-style POST (Z.ai with key, DeepSeek, OpenAI, Gemini, Ollama). */
async function openaiCompatChat(
  provider: ProviderId,
  messages: ChatMessage[],
  opts: { timeoutMs: number; signal?: AbortSignal; maxTokens?: number; temperature?: number }
): Promise<string> {
  const base =
    provider === 'zai' ? 'https://api.z.ai/api/paas/v4' : OPENAI_COMPAT_BASE[provider]
  const url =
    provider === 'ollama'
      ? `${(env('OLLAMA_BASE_URL') || 'http://localhost:11434').replace(/\/$/, '')}/v1/chat/completions`
      : `${base}/chat/completions`
  const apiKey = provider === 'ollama' ? env('OLLAMA_API_KEY') : env(`${provider.toUpperCase()}_API_KEY`)

  const body: Record<string, unknown> = { model: modelOf(provider), messages, stream: false }
  if (provider === 'zai') body.thinking = { type: 'disabled' }
  if (opts.temperature !== undefined) body.temperature = opts.temperature
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: withTimeout(opts.timeoutMs, opts.signal),
  })
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`${provider} HTTP ${res.status}${text ? `: ${text}` : ''}`)
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content ?? ''
  if (!content) throw new Error(`${provider} returned empty content`)
  return content
}

/** Anthropic native Messages API. */
async function anthropicChat(
  messages: ChatMessage[],
  opts: { timeoutMs: number; signal?: AbortSignal; maxTokens?: number; temperature?: number }
): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m): { role: 'user' | 'assistant'; content: string } => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  // Anthropic requires alternating turns starting with user — merge consecutive same-role.
  const merged: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of rest) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`
    else merged.push({ role: m.role, content: m.content })
  }
  if (!merged.length || merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: '(begin)' })
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelOf('anthropic'),
      max_tokens: opts.maxTokens ?? 8192,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(system ? { system } : {}),
      messages: merged,
    }),
    signal: withTimeout(opts.timeoutMs, opts.signal),
  })
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`anthropic HTTP ${res.status}${text ? `: ${text}` : ''}`)
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] }
  const content = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim()
  if (!content) throw new Error('anthropic returned empty content')
  return content
}

// ---------------------------------------------------------------- dispatcher

async function callProvider(p: ProviderId, opts: ChatOptions): Promise<ChatResult> {
  const model = modelOf(p)
  const timeoutMs = opts.timeoutMs ?? 120_000
  let content: string
  if (p === 'zai') {
    content = env('ZAI_API_KEY')
      ? await openaiCompatChat('zai', opts.messages, { timeoutMs, signal: opts.signal })
      : await zaiSdkChat(opts.messages, timeoutMs, opts.signal)
  } else if (p === 'anthropic') {
    content = await anthropicChat(opts.messages, { ...opts, timeoutMs })
  } else {
    content = await openaiCompatChat(p, opts.messages, { timeoutMs, signal: opts.signal })
  }
  return { content, provider: p, model }
}

export class NoProviderError extends Error {
  constructor(detail: string) {
    super(`no LLM provider available - enable one with USE_<PROVIDER>=true in .env (tried: ${detail})`)
  }
}

/**
 * Chat completion across all enabled providers (USE_* flags), first success wins,
 * later providers act as fallback. Throws NoProviderError if nothing answers.
 */
export async function chatComplete(opts: ChatOptions): Promise<ChatResult> {
  const order = enabledProviders().filter(providerReady)
  if (!order.length) {
    throw new NoProviderError(
      'none enabled - set USE_ZAI=true and/or USE_DEEPSEEK / USE_ANTHROPIC / USE_OPENAI / USE_GEMINI / USE_OLLAMA in .env'
    )
  }
  const failures: string[] = []
  for (const p of order) {
    try {
      return await callProvider(p, opts)
    } catch (err) {
      if (opts.signal?.aborted) throw err
      failures.push(`${p}: ${(err as Error).message}`)
    }
  }
  throw new NoProviderError(failures.join(' | '))
}
