// IQAIR//OS - Meta-strategy library + live source reads
// Owns the saved meta-strategy specs (analytics/metastrategy.ts's pure
// combinator) and knows how to fetch each condition source's CURRENT
// verdict for a given asset+tf from the already-running engines - the
// Next-Candle Oracle, its two secondary panel reads, Accute, Renko, and
// the SMC scanner. Nothing here recomputes a signal from scratch; it only
// reads what those services already computed for their own panels, same
// data the user is looking at.
//
// Persistence: a flat JSON library (data/meta_strategies.json), same shape
// as every other small *.json store in this codebase (smc_outcomes.json,
// leadlag_outcomes.json, ...) - this is a short, hand-curated list of
// specs, not a growing time series, so it doesn't need the Store/DB
// machinery lab.ts's much bigger learned-strategy library uses.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { Timeframe } from '../types'
import type { MarketDataService } from './market-data'
import type { NextCandleService } from './nextcandle'
import type { AccuteService } from './accute'
import type { SmcScanService } from './smcscan'
import { renkoBricks } from '../analytics/renko'
import { smcNowRead, ALL_SMC_KINDS } from '../analytics/smc'
import {
  evaluateMetaStrategy,
  META_CONDITION_SOURCES,
  type MetaConditionSource,
  type MetaEvalResult,
  type MetaSourceRead,
  type MetaStrategySpec,
} from '../analytics/metastrategy'
import { parseStrategyScript, evaluateStrategyScript, type MslSourceRead } from '../analytics/strategylang'

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'strategy'
  )
}

/** Defensive, same reasoning as lab.ts's save(): collapse a repeated
 * "meta:meta:..." prefix so an id that already looks saved doesn't go
 * undeployable. */
function normalizeMetaId(id: string): string {
  return id.toLowerCase().replace(/^(?:meta:)+/, 'meta:')
}

export class MetaStrategyService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private specs = new Map<string, MetaStrategySpec>()
  private libPath = join(process.cwd(), 'data', 'meta_strategies.json')

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.load()
    ctx.log('meta-strategy', `meta-strategy library online (${this.specs.size} saved, sources: ${META_CONDITION_SOURCES.join('/')})`)
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.libPath, 'utf8')) as { specs?: MetaStrategySpec[] }
      for (const spec of raw.specs ?? []) this.specs.set(spec.id, spec)
    } catch {
      /* no file yet - start clean */
    }
  }

  private persist(): void {
    try {
      mkdirSync(join(process.cwd(), 'data'), { recursive: true })
      writeFileSync(this.libPath, JSON.stringify({ savedAt: Date.now(), specs: [...this.specs.values()] }))
    } catch {
      /* persistence is best-effort - the in-memory library still works this run */
    }
  }

  list(): MetaStrategySpec[] {
    return [...this.specs.values()].sort((a, b) => (b.updatedTs ?? 0) - (a.updatedTs ?? 0))
  }

  get(id: string): MetaStrategySpec | null {
    return this.specs.get(normalizeMetaId(id)) ?? null
  }

  isValidStrategyId(id: string): boolean {
    return id.startsWith('meta:') && this.specs.has(normalizeMetaId(id))
  }

  /** Save (or overwrite) a spec. Two ways to build one, per direct
   * instruction ("let's create our own strategy language, that we can use
   * to achieve almost everything" instead of hand-written JSON):
   *   - conditions-built (the default, simple path): validates every
   *     condition's source is one META_CONDITION_SOURCES actually
   *     supports, and requires at least one condition - a meta-strategy
   *     with zero conditions can never fire, which is almost certainly a
   *     mistake, not an intentional "always off" spec (use the
   *     auto-trader's own enabled toggle for that).
   *   - script-built: a Meta Strategy Lab script (analytics/
   *     strategylang.ts). Parsed HERE, at save time, not deferred to the
   *     trading loop - a script with a syntax error (or missing the
   *     required "call when"/"put when") is rejected on save so it can
   *     never silently sit there doing nothing once wired into Meta
   *     Trader or the auto-trader.
   * A spec needs exactly one of the two - script, when provided (even as
   * an empty-ish string that still parses), takes priority and conditions
   * become inert history (see evaluate()'s branch below). */
  save(input: {
    id?: string
    name: string
    mode: 'all' | 'any' | 'weighted'
    threshold?: number
    conditions: MetaStrategySpec['conditions']
    script?: string
  }): { ok: boolean; id: string; spec: MetaStrategySpec } {
    const name = String(input.name ?? 'Meta Strategy').slice(0, 60)
    const script = typeof input.script === 'string' && input.script.trim() ? input.script : undefined
    if (script) {
      const parsed = parseStrategyScript(script)
      if (!parsed.ok) throw new Error(`strategy script error: ${parsed.error}`)
    } else {
      if (!Array.isArray(input.conditions) || !input.conditions.length) throw new Error('a meta-strategy needs at least one condition (or a strategy script)')
      for (const c of input.conditions) {
        if (!META_CONDITION_SOURCES.includes(c.source as MetaConditionSource)) throw new Error(`unknown condition source "${c.source}" - must be one of ${META_CONDITION_SOURCES.join(', ')}`)
        if (c.direction !== 'call' && c.direction !== 'put' && c.direction !== 'either') throw new Error(`condition direction must be 'call'/'put'/'either', got "${c.direction}"`)
        if (c.source === 'smcNow' && c.smcKind !== undefined && !(ALL_SMC_KINDS as readonly string[]).includes(c.smcKind))
          throw new Error(`unknown smcKind "${c.smcKind}" - must be one of ${ALL_SMC_KINDS.join(', ')}`)
      }
    }
    const mode = input.mode === 'any' || input.mode === 'weighted' ? input.mode : 'all'
    const id = normalizeMetaId(input.id?.trim() || `meta:${slugify(name)}`)
    const existing = this.specs.get(id)
    const spec: MetaStrategySpec = {
      id,
      name,
      mode,
      threshold: mode === 'weighted' ? Math.max(0, Math.min(100, input.threshold ?? 60)) : undefined,
      conditions: Array.isArray(input.conditions)
        ? input.conditions.map((c) => ({ source: c.source, direction: c.direction, minConfidence: c.minConfidence, weight: c.weight, smcKind: c.smcKind }))
        : [],
      script,
      createdTs: existing?.createdTs ?? Date.now(),
      updatedTs: Date.now(),
    }
    this.specs.set(id, spec)
    this.persist()
    this.ctx.bus.emit('alert', {
      level: 'success',
      message: `[meta-strategy] "${name}" saved as ${id} (${script ? 'script' : `${mode}, ${spec.conditions.length} condition(s)`})`,
      ts: Math.floor(Date.now() / 1000),
    })
    return { ok: true, id, spec }
  }

  remove(id: string): { ok: boolean; error?: string } {
    const ok = this.specs.delete(normalizeMetaId(id))
    if (ok) this.persist()
    return ok ? { ok } : { ok, error: 'meta-strategy not found' }
  }

  /** Current verdict for ONE condition source on one asset+tf - this is
   * the only place that reaches into the live engines. Returns a 'none'
   * read (never throws) when the underlying service isn't loaded or the
   * pair has too little history - a meta-strategy should fail OPEN into
   * "this condition didn't pass" the same way every other source here
   * does on thin history, not crash the whole evaluation. */
  /** Current Renko trend as a call/put/none read, shared by the 'renko'
   * condition source and the 'renkoSmc' confluence read below - kept as
   * one small helper so both read the exact same bricks the same way. */
  private renkoDirectionRead(asset: string, tf: Timeframe): { direction: 'call' | 'put' | 'none'; confidence: number; streak: number; trend: 'up' | 'down' | 'none' } {
    const candles = this.market.getCandlesDeep(asset, tf, 300, true)
    const r = renkoBricks(candles)
    if (r.trend === 'none') return { direction: 'none', confidence: 0, streak: 0, trend: 'none' }
    const direction = r.trend === 'up' ? 'call' : 'put'
    const confidence = Math.min(100, 40 + r.streak * 12)
    return { direction, confidence, streak: r.streak, trend: r.trend }
  }

  private readSource(source: MetaConditionSource, asset: string, tf: Timeframe, smcKind?: string): MetaSourceRead {
    const none = (label: string): MetaSourceRead => ({ source, direction: 'none', confidence: 0, label })
    try {
      switch (source) {
        case 'oracle': {
          const oracle = this.ctx.use<NextCandleService>('nextcandle')
          const pred = oracle.predict(asset, tf)
          if (!pred || pred.direction === 'none') return none('Oracle: no lean')
          return { source, direction: pred.direction, confidence: pred.confidence, label: `Oracle ${pred.direction.toUpperCase()} ${pred.confidence.toFixed(0)}%` }
        }
        case 'hmaRocBullBear': {
          const oracle = this.ctx.use<NextCandleService>('nextcandle')
          const alt = oracle.predict(asset, tf)?.altPrediction
          if (!alt || alt.direction === 'none') return none('HMA/ROC/Bull-Bear: no lean')
          return { source, direction: alt.direction, confidence: alt.strength, label: `HMA/ROC/Bull-Bear ${alt.direction.toUpperCase()} ${alt.strength.toFixed(0)}%` }
        }
        case 'momentumScore': {
          const oracle = this.ctx.use<NextCandleService>('nextcandle')
          const mom = oracle.predict(asset, tf)?.momentumPrediction
          if (!mom || mom.direction === 'none') return none('Momentum Score: no lean')
          return { source, direction: mom.direction, confidence: mom.strength, label: `Momentum Score ${mom.direction.toUpperCase()} ${mom.strength.toFixed(0)}%` }
        }
        case 'accute': {
          const accute = this.ctx.use<AccuteService>('accute')
          const sig = accute.signal(asset, tf)
          if (!sig.ok || sig.direction === 'none') return none('Accute: no lean')
          return { source, direction: sig.direction, confidence: sig.confidence, label: `Accute ${sig.direction.toUpperCase()} ${sig.confidence.toFixed(0)}%` }
        }
        case 'renko': {
          // Renko has no native 0-100 confidence - streak length is the
          // honest proxy (a 1-brick flip is barely a lean, a long streak
          // reads as conviction), same scaling AccuteRenkoRead's own label
          // implies without putting a number on it. Capped at 10 bricks:
          // deeper streaks all read the same "committed trend" story.
          const r = this.renkoDirectionRead(asset, tf)
          if (r.direction === 'none') return none('Renko: no bricks painted yet')
          return { source, direction: r.direction, confidence: r.confidence, label: `Renko ${r.streak} ${r.trend.toUpperCase()} brick(s)` }
        }
        case 'smc': {
          const smc = this.ctx.use<SmcScanService>('smcScan')
          const resp = smc.scan(asset, tf)
          const summary = resp.result?.summary
          if (!summary || summary.direction === 'none') return none('SMC: no lean')
          return { source, direction: summary.direction, confidence: summary.confidence, label: `SMC ${summary.direction.toUpperCase()} ${summary.confidence.toFixed(0)}%` }
        }
        case 'smcNow': {
          // "any of the smcs" per direct instruction - the aggregate "now"
          // read (every concept except Support & Resistance, barsAgo===0
          // only - same read Meta Trader's plain 'smc' source trades) by
          // default, or ONE concept via this condition's smcKind field,
          // same smcNowRead() both share (analytics/smc.ts).
          const smc = this.ctx.use<SmcScanService>('smcScan')
          const resp = smc.scan(asset, tf)
          if (!resp.result) return none('SMC now: no scan result yet')
          const kind = smcKind && (ALL_SMC_KINDS as readonly string[]).includes(smcKind) ? (smcKind as (typeof ALL_SMC_KINDS)[number]) : undefined
          const read = smcNowRead(resp.result, kind)
          if (read.direction === 'none') return none(`SMC now${kind ? ` (${kind})` : ''}: ${read.note}`)
          return { source, direction: read.direction, confidence: read.confidence, label: `SMC now${kind ? ` ${kind}` : ''} ${read.direction.toUpperCase()} - ${read.note}` }
        }
        case 'renkoSmc': {
          // Same confluence rule Meta Trader's 'renko-smc' source trades:
          // fires ONLY when Renko's brick trend and SMC's aggregate "now"
          // read agree, blending both legs' confidence 50/50.
          const smc = this.ctx.use<SmcScanService>('smcScan')
          const resp = smc.scan(asset, tf)
          if (!resp.result) return none('Renko+SMC: no scan result yet')
          const smcRead = smcNowRead(resp.result)
          const r = this.renkoDirectionRead(asset, tf)
          if (smcRead.direction === 'none' || r.direction === 'none' || smcRead.direction !== r.direction) {
            return none(`Renko+SMC: no confluence (renko ${r.direction}, smc now ${smcRead.direction})`)
          }
          const confidence = Math.round((smcRead.confidence + r.confidence) / 2)
          return { source, direction: r.direction, confidence, label: `Renko+SMC ${r.direction.toUpperCase()} - ${r.streak} ${r.trend.toUpperCase()} brick(s) & ${smcRead.note}` }
        }
      }
    } catch {
      return none(`${source}: not available (plugin not loaded or thin history)`)
    }
  }

  /** Full read map for the strategy-language evaluator (analytics/
   * strategylang.ts) - every source a script is allowed to reference, by
   * name, including a slot for each of the 15 SMC concepts' OWN "now"
   * read ('smc:<KIND>') so a script can combine "any of the smcs" freely
   * without the caller having to know in advance which ones it uses. Only
   * computed when a spec actually has a script (see evaluate() below) -
   * scanning all 15 SMC kinds plus Renko plus every Oracle driver on
   * every candidate would be wasted work for a conditions-built spec. */
  private buildScriptReads(asset: string, tf: Timeframe): Record<string, MslSourceRead> {
    const toMsl = (r: MetaSourceRead): MslSourceRead => ({ direction: r.direction, confidence: r.confidence })
    const reads: Record<string, MslSourceRead> = {
      oracle: toMsl(this.readSource('oracle', asset, tf)),
      hmaRocBullBear: toMsl(this.readSource('hmaRocBullBear', asset, tf)),
      momentumScore: toMsl(this.readSource('momentumScore', asset, tf)),
      accute: toMsl(this.readSource('accute', asset, tf)),
      renko: toMsl(this.readSource('renko', asset, tf)),
      smc: toMsl(this.readSource('smc', asset, tf)),
      smcNow: toMsl(this.readSource('smcNow', asset, tf)),
      renkoSmc: toMsl(this.readSource('renkoSmc', asset, tf)),
    }
    try {
      const smc = this.ctx.use<SmcScanService>('smcScan')
      const resp = smc.scan(asset, tf)
      for (const kind of ALL_SMC_KINDS) {
        const read = resp.result ? smcNowRead(resp.result, kind) : { direction: 'none' as const, confidence: 0 }
        reads[`smc:${kind}`] = { direction: read.direction, confidence: read.confidence }
      }
    } catch {
      for (const kind of ALL_SMC_KINDS) reads[`smc:${kind}`] = { direction: 'none', confidence: 0 }
    }
    return reads
  }

  /** Evaluate a saved meta-strategy for one asset+tf right now. Script,
   * when the spec has one, always wins over conditions (see
   * MetaStrategySpec.script's doc comment) - this is the one place that
   * decision is made, so Meta Trader's 'meta-strategy' source and the
   * /meta_strategy_eval REST route both get it for free. */
  evaluate(id: string, asset: string, tf: Timeframe): { spec: MetaStrategySpec; result: MetaEvalResult; price: number } {
    const spec = this.get(id)
    if (!spec) throw new Error(`unknown meta-strategy ${id}`)
    const result = spec.script ? this.evaluateScript(spec.script, asset, tf) : this.evaluateConditions(spec, asset, tf)
    let price = 0
    try {
      price = this.market.getPrice(asset)
    } catch {
      /* price stays 0 - caller treats that as "not tradeable right now" */
    }
    return { spec, result, price }
  }

  private evaluateConditions(spec: MetaStrategySpec, asset: string, tf: Timeframe): MetaEvalResult {
    const reads = spec.conditions.map((c) => this.readSource(c.source, asset, tf, c.smcKind))
    return evaluateMetaStrategy(spec, reads)
  }

  /** Run a strategy-language script against one asset+tf's current
   * source reads, shaped as a MetaEvalResult so it's a drop-in for
   * evaluateMetaStrategy's conditions-built result - every caller
   * (Meta Trader, the REST eval route, this service's own evaluate())
   * gets the same {direction, score, confidence, notes} shape either
   * way, never needing to know which path a given spec took. */
  private evaluateScript(script: string, asset: string, tf: Timeframe): MetaEvalResult {
    const parsed = parseStrategyScript(script)
    if (!parsed.ok) return { direction: 'none', score: 0, confidence: 0, conditions: [], notes: `script error: ${parsed.error}` }
    const reads = this.buildScriptReads(asset, tf)
    const out = evaluateStrategyScript(parsed.ast, reads)
    const score = out.confidence * (out.direction === 'call' ? 1 : out.direction === 'put' ? -1 : 0)
    const notes = out.error ? `script error: ${out.error}` : out.trace.join(' · ') || `script: ${out.direction} ${out.confidence}%`
    return { direction: out.direction, score, confidence: out.confidence, conditions: [], notes }
  }

  /** Dry-run a strategy-script string against one asset+tf WITHOUT saving
   * it - the Meta Strategy Lab's "test" button in its code editor, so a
   * script can be iterated on before committing it (save() still
   * re-validates the syntax on its own, this is purely for live preview). */
  testScript(script: string, asset: string, tf: Timeframe): { ok: boolean; direction?: 'call' | 'put' | 'none'; confidence?: number; trace?: string[]; price?: number; error?: string } {
    const parsed = parseStrategyScript(script)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const reads = this.buildScriptReads(asset, tf)
    const out = evaluateStrategyScript(parsed.ast, reads)
    if (out.error) return { ok: false, error: out.error }
    let price = 0
    try {
      price = this.market.getPrice(asset)
    } catch {
      /* price stays 0 */
    }
    return { ok: true, direction: out.direction, confidence: out.confidence, trace: out.trace, price }
  }
}

export const metaStrategyPlugin: Plugin = {
  name: 'meta-strategy',
  start: async (ctx) => {
    const svc = new MetaStrategyService()
    ctx.provide('metaStrategy', svc)
    await svc.start(ctx)
  },
}
