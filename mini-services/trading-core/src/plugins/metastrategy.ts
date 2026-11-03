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
import {
  evaluateMetaStrategy,
  META_CONDITION_SOURCES,
  type MetaConditionSource,
  type MetaEvalResult,
  type MetaSourceRead,
  type MetaStrategySpec,
} from '../analytics/metastrategy'

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

  /** Save (or overwrite) a spec. Validates every condition's source is one
   * META_CONDITION_SOURCES actually supports and that the spec has at
   * least one condition - a meta-strategy with zero conditions can never
   * fire, which is almost certainly a mistake, not an intentional "always
   * off" spec (use the auto-trader's own enabled toggle for that). */
  save(input: { id?: string; name: string; mode: 'all' | 'any' | 'weighted'; threshold?: number; conditions: MetaStrategySpec['conditions'] }): { ok: boolean; id: string; spec: MetaStrategySpec } {
    const name = String(input.name ?? 'Meta Strategy').slice(0, 60)
    if (!Array.isArray(input.conditions) || !input.conditions.length) throw new Error('a meta-strategy needs at least one condition')
    for (const c of input.conditions) {
      if (!META_CONDITION_SOURCES.includes(c.source as MetaConditionSource)) throw new Error(`unknown condition source "${c.source}" - must be one of ${META_CONDITION_SOURCES.join(', ')}`)
      if (c.direction !== 'call' && c.direction !== 'put' && c.direction !== 'either') throw new Error(`condition direction must be 'call'/'put'/'either', got "${c.direction}"`)
    }
    const mode = input.mode === 'any' || input.mode === 'weighted' ? input.mode : 'all'
    const id = normalizeMetaId(input.id?.trim() || `meta:${slugify(name)}`)
    const existing = this.specs.get(id)
    const spec: MetaStrategySpec = {
      id,
      name,
      mode,
      threshold: mode === 'weighted' ? Math.max(0, Math.min(100, input.threshold ?? 60)) : undefined,
      conditions: input.conditions.map((c) => ({ source: c.source, direction: c.direction, minConfidence: c.minConfidence, weight: c.weight })),
      createdTs: existing?.createdTs ?? Date.now(),
      updatedTs: Date.now(),
    }
    this.specs.set(id, spec)
    this.persist()
    this.ctx.bus.emit('alert', {
      level: 'success',
      message: `[meta-strategy] "${name}" saved as ${id} (${mode}, ${spec.conditions.length} condition(s))`,
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
  private readSource(source: MetaConditionSource, asset: string, tf: Timeframe): MetaSourceRead {
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
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const r = renkoBricks(candles)
          if (r.trend === 'none') return none('Renko: no bricks painted yet')
          const direction = r.trend === 'up' ? 'call' : 'put'
          // Renko has no native 0-100 confidence - streak length is the
          // honest proxy (a 1-brick flip is barely a lean, a long streak
          // reads as conviction), same scaling AccuteRenkoRead's own label
          // implies without putting a number on it. Capped at 10 bricks:
          // deeper streaks all read the same "committed trend" story.
          const confidence = Math.min(100, 40 + r.streak * 12)
          return { source, direction, confidence, label: `Renko ${r.streak} ${r.trend.toUpperCase()} brick(s)` }
        }
        case 'smc': {
          const smc = this.ctx.use<SmcScanService>('smcScan')
          const resp = smc.scan(asset, tf)
          const summary = resp.result?.summary
          if (!summary || summary.direction === 'none') return none('SMC: no lean')
          return { source, direction: summary.direction, confidence: summary.confidence, label: `SMC ${summary.direction.toUpperCase()} ${summary.confidence.toFixed(0)}%` }
        }
      }
    } catch {
      return none(`${source}: not available (plugin not loaded or thin history)`)
    }
  }

  /** Evaluate a saved meta-strategy for one asset+tf right now. */
  evaluate(id: string, asset: string, tf: Timeframe): { spec: MetaStrategySpec; result: MetaEvalResult; price: number } {
    const spec = this.get(id)
    if (!spec) throw new Error(`unknown meta-strategy ${id}`)
    const reads = spec.conditions.map((c) => this.readSource(c.source, asset, tf))
    const result = evaluateMetaStrategy(spec, reads)
    let price = 0
    try {
      price = this.market.getPrice(asset)
    } catch {
      /* price stays 0 - caller treats that as "not tradeable right now" */
    }
    return { spec, result, price }
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
