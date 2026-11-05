// IQAIR//OS trading-core - multi-provider LLM client, ported from the
// frontend's src/lib/llm/index.ts for the AI Trader (src/plugins/aitrader.ts),
// which has to make its own decision calls on a timer INSIDE this persistent
// kernel process, independent of whether anyone has the Next.js app open -
// the frontend's chatComplete() lives in a serverless route, only reachable
// per-request from a browser tab, so it can't be imported here directly (a
// different package, a different runtime, no persistent process to call from).
//
// Same env contract as the frontend (USE_ZAI/USE_DEEPSEEK/USE_ANTHROPIC/
// USE_OPENAI/USE_GEMINI/USE_OLLAMA + *_API_KEY + *_MODEL), same fallback-
// through-every-enabled-provider behavior, same ChatMessage/ChatOptions/
// ChatResult shapes - so a decision prompt built here reads exactly like one
// built for the Copilot. ONE deliberate drop: the frontend's zai branch tries
// the managed z-ai-web-dev-sdk gateway when ZAI_API_KEY is unset (zero-config
// inside the managed sandbox); that SDK lives in the Next.js app's own
// node_modules, not trading-core's, so this copy always goes direct-fetch for
// zai. If ZAI_API_KEY isn't set AND no other provider is enabled, zai simply
// fails here the same way any mis-configured provider does, and the caller
// sees NoProviderError - this never silently produces a decision it can't back.

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

const OPENAI_COMPAT_BASE: Record<Exclude<ProviderId, 'zai' | 'anthropic'>, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: '',
}

function isProviderId(v: string): v is ProviderId {
  return (PROVIDER_ORDER as string[]).includes(v)
}

function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

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

function providerReady(p: ProviderId): boolean {
  switch (p) {
    case 'zai':
      return !!env('ZAI_API_KEY') // no SDK fallback here - see module header
    case 'ollama':
      return true
    default:
      return !!env(`${p.toUpperCase()}_API_KEY`)
  }
}

export function providerStatus(): {
  order: ProviderId[]
  providers: { id: ProviderId; enabled: boolean; ready: boolean; model: string }[]
} {
  const order = enabledProviders()
  return {
    order,
    providers: PROVIDER_ORDER.map((id) => ({
      id,
      enabled: order.includes(id),
      ready: order.includes(id) && providerReady(id),
      model: modelOf(id),
    })),
  }
}

async function openaiCompatChat(
  provider: ProviderId,
  messages: ChatMessage[],
  opts: { timeoutMs: number; signal?: AbortSignal; maxTokens?: number; temperature?: number }
): Promise<string> {
  const base = provider === 'zai' ? 'https://api.z.ai/api/paas/v4' : OPENAI_COMPAT_BASE[provider]
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

async function anthropicChat(
  messages: ChatMessage[],
  opts: { timeoutMs: number; signal?: AbortSignal; maxTokens?: number; temperature?: number }
): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m): { role: 'user' | 'assistant'; content: string } => ({ role: m.role as 'user' | 'assistant', content: m.content }))
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

async function callProvider(p: ProviderId, opts: ChatOptions): Promise<ChatResult> {
  const model = modelOf(p)
  const timeoutMs = opts.timeoutMs ?? 120_000
  const content =
    p === 'anthropic'
      ? await anthropicChat(opts.messages, { ...opts, timeoutMs })
      : await openaiCompatChat(p, opts.messages, { timeoutMs, signal: opts.signal, maxTokens: opts.maxTokens, temperature: opts.temperature })
  return { content, provider: p, model }
}

export class NoProviderError extends Error {
  constructor(detail: string) {
    super(`no LLM provider available - enable one with USE_<PROVIDER>=true in trading-core's own .env (tried: ${detail})`)
  }
}

export async function chatComplete(opts: ChatOptions): Promise<ChatResult> {
  const order = enabledProviders().filter(providerReady)
  if (!order.length) {
    throw new NoProviderError(
      'none enabled/ready - set USE_ZAI=true (with ZAI_API_KEY) and/or USE_DEEPSEEK / USE_ANTHROPIC / USE_OPENAI / USE_GEMINI / USE_OLLAMA in trading-core/.env'
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
