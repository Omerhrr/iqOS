// IQAIR//OS - Copilot memory gate
// The copilot's persistent memory doubles as an AUTONOMY RULEBOOK: notes saved
// with kind "rule" (machine grammar, written by the copilot when the user states
// a standing trading instruction) hard-gate every autonomous order - autopilot
// bots AND the built-in auto-trader. Manual user trades are never gated (the
// user is the boss of their own clicks).
//
// Rule grammar (one rule per line inside a note, kind must be "rule"):
//   no-trade-days: Friday, Saturday        -> autonomous orders blocked on those UTC weekdays
//   asset-whitelist: EURUSD-OTC, BTCUSD    -> autonomy restricted to these instruments (-OTC optional)
//   asset-blacklist: DOGEUSD               -> autonomy never touches these instruments
//   max-stake: 20                          -> autonomous stake per order capped at $20
//   max-trades-per-hour: 3                 -> at most N autonomous orders per rolling hour
//
// Deleting the note (memory_forget) removes the rule - the copilot can be told
// "forget my Friday rule" and autonomy is restored on the next gate check.

import type { Plugin, KernelContext } from '../kernel'
import type { Store } from '../store'
import type { Position } from '../types'

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const normAsset = (s: string) => s.toUpperCase().replace(/-OTC$/i, '').trim()

interface ParsedRules {
  noTradeDays: string[]
  assetWhitelist: string[]
  assetBlacklist: string[]
  maxStake: number | null
  maxTradesPerHour: number | null
}

interface RuleNote {
  id: number
  content: string
}

interface GateCache {
  ts: number
  rules: ParsedRules
  raw: RuleNote[]
}

const EMPTY_RULES: ParsedRules = { noTradeDays: [], assetWhitelist: [], assetBlacklist: [], maxStake: null, maxTradesPerHour: null }

function parseRules(notes: RuleNote[]): { rules: ParsedRules; raw: RuleNote[] } {
  const rules: ParsedRules = { noTradeDays: [], assetWhitelist: [], assetBlacklist: [], maxStake: null, maxTradesPerHour: null }
  for (const note of notes) {
    for (const line of note.content.split(/\r?\n/)) {
      const m = line.match(/^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i)
      if (!m) continue
      const key = m[1].toLowerCase().replace(/[_\s]/g, '-')
      const val = m[2].trim()
      if (key === 'no-trade-days' || key === 'no-trade-day') {
        for (const token of val.toLowerCase().split(/[,;/]+|\band\b/g)) {
          const d = token.trim().replace(/\.$/, '')
          if (DAY_NAMES.includes(d)) rules.noTradeDays.push(d)
          else {
            const short = DAY_NAMES.find((n) => n.startsWith(d) && d.length >= 3)
            if (short) rules.noTradeDays.push(short)
          }
        }
      } else if (key === 'asset-whitelist' || key === 'whitelist' || key === 'only-trade') {
        for (const token of val.split(/[,;]+/)) {
          const a = normAsset(token)
          if (a) rules.assetWhitelist.push(a)
        }
      } else if (key === 'asset-blacklist' || key === 'blacklist' || key === 'never-trade' || key === 'avoid') {
        for (const token of val.split(/[,;]+/)) {
          const a = normAsset(token)
          if (a) rules.assetBlacklist.push(a)
        }
      } else if (key === 'max-stake' || key === 'max-stake-usd' || key === 'stake-cap') {
        const n = Number(val.replace(/[^0-9.]/g, ''))
        if (Number.isFinite(n) && n > 0) rules.maxStake = Math.max(rules.maxStake ?? 0, n)
      } else if (key === 'max-trades-per-hour' || key === 'trades-per-hour' || key === 'max-trades-hourly') {
        const n = Number(val.replace(/[^0-9]/g, ''))
        if (Number.isFinite(n) && n > 0) rules.maxTradesPerHour = rules.maxTradesPerHour === null ? n : Math.min(rules.maxTradesPerHour, n)
      }
    }
  }
  // dedupe
  rules.noTradeDays = [...new Set(rules.noTradeDays)]
  rules.assetWhitelist = [...new Set(rules.assetWhitelist)]
  rules.assetBlacklist = [...new Set(rules.assetBlacklist)]
  return { rules, raw: notes }
}

export class MemoryGateService {
  private cache: GateCache | null = null
  private ctx: KernelContext

  constructor(ctx: KernelContext) {
    this.ctx = ctx
  }

  private store(): Store {
    return this.ctx.use<Store>('storeRaw')
  }

  /** Load + parse rule notes (30s cache - rule changes apply within half a minute). */
  private load(force = false): GateCache {
    const now = Date.now()
    if (!force && this.cache && now - this.cache.ts < 30_000) return this.cache
    const store = this.store()
    const all = store.listNotes('', 200)
    const ruleNotes = all.filter((n) => n.kind === 'rule').map((n) => ({ id: n.id, content: n.content }))
    const { rules, raw } = parseRules(ruleNotes)
    this.cache = { ts: now, rules, raw }
    return this.cache
  }

  /**
   * Consult before ANY autonomous order (bots + auto-trader).
   * Returns ok:false with a "memory-gate:" reason when a standing rule blocks it.
   */
  check(asset: string, stake: number): { ok: boolean; reason?: string } {
    let rules: ParsedRules
    try {
      rules = this.load().rules
    } catch {
      return { ok: true } // store unavailable - never block trading on gate failure
    }

    const day = DAY_NAMES[new Date().getUTCDay()]
    if (rules.noTradeDays.includes(day)) {
      return { ok: false, reason: `memory-gate: standing rule blocks autonomous trading on ${day}s` }
    }

    const a = normAsset(asset)
    if (rules.assetBlacklist.includes(a)) {
      return { ok: false, reason: `memory-gate: standing rule excludes ${a} from autonomous trading` }
    }
    if (rules.assetWhitelist.length && !rules.assetWhitelist.includes(a)) {
      return { ok: false, reason: `memory-gate: standing rule restricts autonomy to ${rules.assetWhitelist.join(', ')}` }
    }

    if (rules.maxStake !== null && stake > rules.maxStake) {
      return { ok: false, reason: `memory-gate: standing rule caps stake at $${rules.maxStake} (order was $${Number(stake).toFixed(2)})` }
    }

    if (rules.maxTradesPerHour !== null) {
      try {
        const cutoff = Math.floor(Date.now() / 1000) - 3600
        const positions = this.store().listPositions(undefined, 300) as Position[]
        const autoRecent = positions.filter(
          (p) => p.tsOpen >= cutoff && (typeof p.note === 'string' && (p.note.startsWith('bot:') || p.note.startsWith('auto-trader')))
        ).length
        if (autoRecent >= rules.maxTradesPerHour) {
          return { ok: false, reason: `memory-gate: standing rule limits autonomy to ${rules.maxTradesPerHour} trade(s)/hour (${autoRecent} placed in the last hour)` }
        }
      } catch {
        /* position history unavailable - let this check pass */
      }
    }

    return { ok: true }
  }

  /** Human-readable status of every active rule (for /memory_gate + the copilot). */
  status(): { active: boolean; rules: ParsedRules; descriptions: string[]; rawNotes: RuleNote[] } {
    const { rules, raw } = this.load(true)
    const descriptions: string[] = []
    if (rules.noTradeDays.length) descriptions.push(`No autonomous trading on: ${rules.noTradeDays.join(', ')}`)
    if (rules.assetWhitelist.length) descriptions.push(`Autonomy restricted to: ${rules.assetWhitelist.join(', ')}`)
    if (rules.assetBlacklist.length) descriptions.push(`Autonomy excludes: ${rules.assetBlacklist.join(', ')}`)
    if (rules.maxStake !== null) descriptions.push(`Autonomous stake capped at $${rules.maxStake}`)
    if (rules.maxTradesPerHour !== null) descriptions.push(`Max ${rules.maxTradesPerHour} autonomous trade(s) per hour`)
    return { active: descriptions.length > 0, rules, descriptions, rawNotes: raw }
  }
}

export const memoryGatePlugin: Plugin = {
  name: 'memory-gate',
  start(ctx) {
    ctx.provide('memoryGate', new MemoryGateService(ctx))
    ctx.log('memory-gate', 'copilot rule notes now gate bots + auto-trader')
  },
}
