// IQAIR//OS - the AI desk behind MSL `ai.*` and the /ai_vet /ai_analyze routes.
//
// It rides on the kernel's own LLM client (lib/llm.ts), i.e. the SAME provider config Copilot already uses (USE_* + *_API_KEY in
// the shared .env) - no separate key. ai.* inside a script is LIVE-ONLY and NON-BLOCKING: the evaluator is synchronous, so the
// first call for a bar starts the request in the background and every method fails closed ("pending") until the verdict is
// cached; a live trader that evaluates again a moment later then reads it. Backtests never call a model (non-deterministic,
// slow, unreplayable): ai.* throws there. A reading is a language-model OPINION on a numeric snapshot - not a measured edge.
import type { Candle } from '../types'
import { readMarket, readAdapt } from './marketmind'
import { readLearn } from './discover'

export interface AiReading { side: 'call' | 'put' | 'none'; confidence: number; risk: 'low' | 'medium' | 'high'; regime: string; reason: string; ts: number }
export type ChatFn = (messages: { role: 'system' | 'user'; content: string }[], opts?: { maxTokens?: number; temperature?: number; timeoutMs?: number }) => Promise<string>

let chat: ChatFn | null = null
let enabled = false
let backtestDepth = 0
export const setMslAiChat = (fn: ChatFn | null): void => { chat = fn }
export const setMslAiEnabled = (v: boolean): void => { enabled = v }
export const mslAiAvailable = (): boolean => enabled && chat !== null
export const beginMslBacktest = (): void => { backtestDepth++ }
export const endMslBacktest = (): void => { backtestDepth = Math.max(0, backtestDepth - 1) }
export const inMslBacktest = (): boolean => backtestDepth > 0

const TTL_MS = 15 * 60_000
const MIN_GAP_MS = 4_000
const MAX_INFLIGHT = 2
const MAX_ENTRIES = 200
type Entry = { state: 'pending' | 'ready' | 'error'; reading?: AiReading; error?: string; ts: number }
const cache = new Map<string, Entry>()
let lastStart = 0
let inflight = 0

export const fingerprint = (c: Candle[]): string => {
  const l = c[c.length - 1]
  return `${c.length}:${l.time}:${l.close}:${c[Math.max(0, c.length - 40)].close}`
}

const r = (x: number, d = 5): number => (Number.isFinite(x) ? Number(x.toFixed(d)) : 0)

/** compact numeric snapshot the model reasons over */
export function snapshotText(candles: Candle[], tfSec?: number): string {
  const tail = candles.slice(-40)
  const rows = tail.map((c) => `${r(c.open)},${r(c.high)},${r(c.low)},${r(c.close)}`).join('\n')
  const mk = readMarket(candles)
  const ad = readAdapt(candles)
  const ln = readLearn(candles)
  const parts = [`bars=${candles.length}${tfSec ? ` tf=${tfSec}s` : ''}`, `last 40 candles (open,high,low,close; oldest first):\n${rows}`]
  if (mk.ok) parts.push(`mkt: regime=${mk.regime} strength=${r(mk.strength, 2)} vr=${r(mk.vr, 2)} ac=${r(mk.ac, 2)} vol=${mk.vol} confidence=${r(mk.confidence, 2)}`)
  if (ad.ok) parts.push(`adapt: mode=${ad.mode} side=${ad.side} p=${r(ad.p, 3)} n=${ad.n} (follow ${r(ad.pFollow, 3)} fade ${r(ad.pFade, 3)} trend ${r(ad.pTrend, 3)})`)
  if (ln.ok) parts.push(`learn: validated patterns=${ln.found} of ${ln.tested} tested; latest bar match=${ln.match}${ln.match ? ` side=${ln.side} pattern="${ln.pattern}" p=${r(ln.p, 3)} low=${r(ln.low, 3)} n=${ln.n}` : ''}`)
  return parts.join('\n')
}

const SYS = 'You are the AI desk of a binary-options trading OS. You read a numeric snapshot and give a cautious, honest opinion. Binary 1-bar outcomes are close to coin flips: say none unless the evidence is clearly one-sided, never invent facts that are not in the snapshot, and keep the reason under 40 words. Reply with ONE JSON object only.'

export function parseReading(text: string): AiReading | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>
    const side = j.side === 'call' || j.side === 'put' ? j.side : 'none'
    const conf = Math.max(0, Math.min(100, Math.round(Number(j.confidence) || 0)))
    const risk = j.risk === 'low' || j.risk === 'high' ? j.risk : 'medium'
    return { side, confidence: side === 'none' ? 0 : conf, risk, regime: String(j.regime ?? '').slice(0, 40), reason: String(j.reason ?? '').slice(0, 300), ts: Date.now() }
  } catch {
    return null
  }
}

/** state of the AI reading for this series; starts the background request on a miss (rate limited) */
export function aiReadingFor(candles: Candle[]): { state: 'pending' | 'ready' | 'error' | 'off'; reading?: AiReading; error?: string } {
  if (!mslAiAvailable() || !chat) return { state: 'off', error: 'no LLM provider is wired in (enable USE_<PROVIDER> in the kernel .env, same as Copilot)' }
  const key = fingerprint(candles)
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.ts < TTL_MS) return { state: hit.state, reading: hit.reading, error: hit.error }
  if (inflight >= MAX_INFLIGHT || now - lastStart < MIN_GAP_MS) return { state: 'pending' }
  if (cache.size >= MAX_ENTRIES) for (const k of [...cache.keys()].slice(0, 50)) cache.delete(k)
  cache.set(key, { state: 'pending', ts: now })
  lastStart = now
  inflight++
  const user = `${snapshotText(candles)}\n\nGive your read of the NEXT candle as JSON: {"side":"call"|"put"|"none","confidence":0-100,"risk":"low"|"medium"|"high","regime":"short label","reason":"..."}`
  chat([{ role: 'system', content: SYS }, { role: 'user', content: user }], { maxTokens: 300, temperature: 0.2, timeoutMs: 30_000 })
    .then((t) => {
      const rd = parseReading(t)
      cache.set(key, rd ? { state: 'ready', reading: rd, ts: Date.now() } : { state: 'error', error: 'model reply was not valid JSON', ts: Date.now() })
    })
    .catch((e) => cache.set(key, { state: 'error', error: String((e as Error).message ?? e).slice(0, 200), ts: Date.now() }))
    .finally(() => { inflight-- })
  return { state: 'pending' }
}

export const clearAiCache = (): void => { cache.clear(); lastStart = 0; inflight = 0 }

/** free-form analysis of a market snapshot (route /ai_analyze) */
export async function aiAnalyze(candles: Candle[], question: string | undefined, label: string): Promise<string> {
  if (!chat) throw new Error('no LLM provider is wired in')
  const q = question?.trim() || 'Describe the current market state, what the measured reads imply, and the main risks. Be concrete and brief.'
  return chat([{ role: 'system', content: 'You are the AI desk of a binary-options trading OS. Analyse ONLY the numeric snapshot given, say clearly when the data cannot support a conclusion, never promise profit, and keep it under 220 words.' }, { role: 'user', content: `${label}\n${snapshotText(candles)}\n\nQuestion: ${q}` }], { maxTokens: 700, temperature: 0.3, timeoutMs: 60_000 })
}

/** critique of a strategy script given its measured backtest (route /ai_vet) */
export async function aiVet(script: string, evidence: string): Promise<string> {
  if (!chat) throw new Error('no LLM provider is wired in')
  return chat([
    { role: 'system', content: 'You are a sceptical reviewer of binary-options strategy scripts written in MSL. You are given the script and MEASURED backtest evidence. Judge ONLY from the evidence: sample size, win rate against the break-even rate, stability between halves, the confidence interval, multiple-testing and overfitting risk, look-ahead or data problems visible in the script. Do not invent numbers. Give: a verdict line (promising / unproven / reject), the 3 strongest concerns, and 2 concrete next tests. Under 250 words.' },
    { role: 'user', content: `SCRIPT:\n${script}\n\nEVIDENCE:\n${evidence}` },
  ], { maxTokens: 800, temperature: 0.2, timeoutMs: 60_000 })
}
