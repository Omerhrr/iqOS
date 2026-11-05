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
import { renkoBricks, renkoAtr } from '../analytics/renko'
import { rangeBars } from '../analytics/rangebars'
import { pointFigure } from '../analytics/pointfigure'
import { volumeBars } from '../analytics/volumebars'
import { computeTpo } from '../analytics/tpo'
import { realizedUpProb } from '../analytics/ivhv'
import { engineVoteSingle, type ChartEngineVote } from '../analytics/chartsignals'
import { smcNowRead, smcAnyAgrees, ALL_SMC_KINDS } from '../analytics/smc'
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
        if (c.op !== undefined && !(['>=', '>', '<=', '<', '==', '!='] as const).includes(c.op))
          throw new Error(`condition op must be one of >=, >, <=, <, ==, !=, got "${c.op}"`)
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
        ? input.conditions.map((c) => ({ source: c.source, direction: c.direction, minConfidence: c.minConfidence, weight: c.weight, smcKind: c.smcKind, op: c.op }))
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
        case 'pointFigure': {
          // "not just renko, p&f, range and all others as we see fit" per
          // direct instruction - Point & Figure has no native streak the
          // way Renko/range bars do (a column grows by boxes, not bars),
          // so the confidence proxy is the current column's own box count,
          // same `40 + n*12` capped-100 scaling convention as Renko -
          // more boxes painted in the live column reads as more committed
          // than a column that just flipped.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const pf = pointFigure(candles)
          if (!pf.lastDir) return none('Point & Figure: no column painted yet')
          const direction = pf.lastDir === 'X' ? 'call' : 'put'
          const liveBoxes = pf.columns.length ? pf.columns[pf.columns.length - 1].boxes : 0
          const confidence = Math.min(100, 40 + liveBoxes * 12)
          const breakout = pf.pattern && pf.pattern.direction === direction ? ` - ${pf.pattern.name}` : ''
          return { source, direction, confidence, label: `P&F ${pf.lastDir} column, ${liveBoxes} box(es)${breakout}` }
        }
        case 'rangeBars': {
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const rb = rangeBars(candles)
          if (rb.trend === 'none') return none('Range bars: no bars painted yet')
          const direction = rb.trend === 'up' ? 'call' : 'put'
          const confidence = Math.min(100, 40 + rb.streak * 12)
          return { source, direction, confidence, label: `Range bars ${rb.streak} ${rb.trend.toUpperCase()} bar(s)` }
        }
        case 'candle':
        case 'bar': {
          // "support all charts" per direct instruction - 'bar' is the SAME
          // OHLC data as 'candle' (just rendered differently, no distinct
          // math), so both share the chart-engine committee's own
          // candleVote via engineVoteSingle('candle', ...) - the identical
          // math the Signal Panel/Oracle "chart engines" driver already
          // uses, not a reimplementation.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const vote = engineVoteSingle('candle', candles)
          if (vote.dir === 0) return none(`${source === 'bar' ? 'Bar' : 'Candle'}: no lean - ${vote.note}`)
          const direction = vote.dir === 1 ? 'call' : 'put'
          const confidence = Math.round(Math.min(1, Math.max(0, vote.weight)) * 100)
          return { source, direction, confidence, label: `${source === 'bar' ? 'Bar' : 'Candle'} ${direction.toUpperCase()} - ${vote.note}` }
        }
        case 'heikinAshi': {
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const vote = engineVoteSingle('heikin', candles)
          if (vote.dir === 0) return none(`Heikin Ashi: no lean - ${vote.note}`)
          const direction = vote.dir === 1 ? 'call' : 'put'
          const confidence = Math.round(Math.min(1, Math.max(0, vote.weight)) * 100)
          return { source, direction, confidence, label: `Heikin Ashi ${direction.toUpperCase()} - ${vote.note}` }
        }
        case 'tick': {
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const vote = engineVoteSingle('tick', candles)
          if (vote.dir === 0) return none(`Tick: no lean - ${vote.note}`)
          const direction = vote.dir === 1 ? 'call' : 'put'
          const confidence = Math.round(Math.min(1, Math.max(0, vote.weight)) * 100)
          return { source, direction, confidence, label: `Tick ${direction.toUpperCase()} - ${vote.note}` }
        }
        case 'footprint': {
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const vote = engineVoteSingle('footprint', candles)
          if (vote.dir === 0) return none(`Footprint: no lean - ${vote.note}`)
          const direction = vote.dir === 1 ? 'call' : 'put'
          const confidence = Math.round(Math.min(1, Math.max(0, vote.weight)) * 100)
          return { source, direction, confidence, label: `Footprint ${direction.toUpperCase()} - ${vote.note}` }
        }
        case 'line':
        case 'area':
        case 'baseline': {
          // Line/area/baseline are the SAME close-only price series, just
          // rendered three ways - no distinct math, so all three share one
          // close-trend reduction: closed-candle-count of consecutive
          // closes moving the same direction as the latest close-vs-close
          // delta, scaled by that delta relative to ATR (renkoAtr) so a
          // big move reads as more committed than a one-tick drift, same
          // 40+n*12-capped-100 confidence convention as renko/range/P&F.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          if (candles.length < 3) return none(`${source}: not enough closes yet`)
          let streak = 0
          const lastDelta = candles[candles.length - 1].close - candles[candles.length - 2].close
          if (lastDelta === 0) return none(`${source}: flat close, no lean`)
          const wantUp = lastDelta > 0
          for (let i = candles.length - 1; i > 0; i--) {
            const d = candles[i].close - candles[i - 1].close
            if (d === 0) break
            if (wantUp !== d > 0) break
            streak++
          }
          const atr = renkoAtr(candles)
          const magnitude = Number.isFinite(atr) && atr > 0 ? Math.min(2, Math.abs(lastDelta) / atr) : 0
          const direction = wantUp ? 'call' : 'put'
          const confidence = Math.min(100, 40 + streak * 12 + Math.round(magnitude * 10))
          const label = source === 'line' ? 'Line' : source === 'area' ? 'Area' : 'Baseline'
          return { source, direction, confidence, label: `${label} ${streak} closed ${direction.toUpperCase()} bar(s), delta ${lastDelta.toFixed(5)} vs ATR ${Number.isFinite(atr) ? atr.toFixed(5) : 'n/a'}` }
        }
        case 'volumeBars': {
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const vb = volumeBars(candles)
          if (vb.degenerate || vb.bars.length < 2) return none('Volume bars: no bars painted yet (or all-zero volume window)')
          let streak = 0
          const bars = vb.bars
          const lastUp = bars[bars.length - 1].close > bars[bars.length - 1].open
          for (let i = bars.length - 1; i >= 0; i--) {
            const up = bars[i].close > bars[i].open
            if (up !== lastUp) break
            streak++
          }
          const direction = lastUp ? 'call' : 'put'
          const confidence = Math.min(100, 40 + streak * 12)
          return { source, direction, confidence, label: `Volume bars ${streak} ${direction.toUpperCase()} bar(s) (${vb.volumeSource})` }
        }
        case 'tpo': {
          // POC-distance reduction: last close ABOVE the Point-of-Control
          // reads as bullish conviction (price trading above fair value),
          // below reads bearish - scaled by distance relative to the value
          // area's own width so a close just outside POC reads weaker than
          // one well outside the whole value area.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          const tpo = computeTpo(candles)
          if (tpo.poc === null) return none('TPO: no profile built yet (window too thin)')
          const lastClose = candles[candles.length - 1].close
          const delta = lastClose - tpo.poc
          if (delta === 0) return none('TPO: close sitting right on POC, no lean')
          const vaWidth = tpo.valueAreaHigh !== null && tpo.valueAreaLow !== null ? Math.max(tpo.valueAreaHigh - tpo.valueAreaLow, 1e-9) : NaN
          const ratio = Number.isFinite(vaWidth) ? Math.min(2, Math.abs(delta) / vaWidth) : 0
          const direction = delta > 0 ? 'call' : 'put'
          const confidence = Math.min(100, 45 + Math.round(ratio * 35))
          return { source, direction, confidence, label: `TPO close ${direction.toUpperCase()} of POC (poc ${tpo.poc.toFixed(5)}, close ${lastClose.toFixed(5)})` }
        }
        case 'ivHv': {
          // Deviation-from-50% reduction on realizedUpProb() - NOT a
          // volatility forecast ("vol has no direction" - see ivhv.ts's own
          // doc comment); this reads the realized up-closing frequency
          // itself as a directional lean, same honest framing the IV/HV
          // panel uses for its "realized WR vs breakeven" line.
          const candles = this.market.getCandlesDeep(asset, tf, 300, true)
          if (candles.length < 10) return none('IV-HV: not enough closes yet')
          const upProb = realizedUpProb(candles, 100)
          const delta = upProb - 50
          if (Math.abs(delta) < 1e-9) return none('IV-HV: exactly 50/50 up-closes, no lean')
          const direction = delta > 0 ? 'call' : 'put'
          const confidence = Math.min(100, 50 + Math.round(Math.abs(delta) * 2.5))
          return { source, direction, confidence, label: `IV-HV realized up-close ${upProb.toFixed(1)}% (${direction.toUpperCase()} lean)` }
        }
        case 'renkoSmc': {
          // Same confluence rule Meta Trader's 'renko-smc' source trades -
          // AUDIT FIX: "smc now says up" means ANY SMC concept agreeing
          // with Renko's direction right now, not smcNowRead()'s own
          // majority/tie-broken winner (that would reject a case where a
          // minority concept DID agree, just because other concepts
          // outvoted it - see pickRenkoSmc()'s doc comment in
          // plugins/metatrader.ts for the full story). Renko decides the
          // direction; smcAnyAgrees() (analytics/smc.ts) only checks
          // whether at least one now-signal points the same way.
          const r = this.renkoDirectionRead(asset, tf)
          if (r.direction === 'none') return none('Renko+SMC: no bricks painted yet')
          const smc = this.ctx.use<SmcScanService>('smcScan')
          const resp = smc.scan(asset, tf)
          if (!resp.result) return none('Renko+SMC: no scan result yet')
          const agreement = smcAnyAgrees(resp.result, r.direction)
          if (!agreement.agrees) return none(`Renko+SMC: no confluence (renko ${r.direction}, ${agreement.note})`)
          const confidence = Math.round((agreement.confidence + r.confidence) / 2)
          return { source, direction: r.direction, confidence, label: `Renko+SMC ${r.direction.toUpperCase()} - ${r.streak} ${r.trend.toUpperCase()} brick(s) & ${agreement.note}` }
        }
        case 'renkoSmcMajority': {
          // The OTHER confluence rule, kept alongside 'renkoSmc' above per
          // direct instruction ("we can have the confluence version also
          // tho, lets have both"): requires SMC's own AGGREGATE "now"
          // verdict (smcNowRead() - majority of now-concepts, same read
          // the plain 'smc' source trades) to match Renko's direction,
          // not just any one concept agreeing. Stricter - a pair with 3
          // bearish concepts and 1 bullish now will NOT qualify here even
          // if Renko is up, where 'renkoSmc' still would.
          const r2 = this.renkoDirectionRead(asset, tf)
          if (r2.direction === 'none') return none('Renko+SMC (majority): no bricks painted yet')
          const smc2 = this.ctx.use<SmcScanService>('smcScan')
          const resp2 = smc2.scan(asset, tf)
          if (!resp2.result) return none('Renko+SMC (majority): no scan result yet')
          const smcRead = smcNowRead(resp2.result)
          if (smcRead.direction === 'none' || smcRead.direction !== r2.direction) {
            return none(`Renko+SMC (majority): no confluence (renko ${r2.direction}, smc now ${smcRead.direction})`)
          }
          const confidence2 = Math.round((smcRead.confidence + r2.confidence) / 2)
          return { source, direction: r2.direction, confidence: confidence2, label: `Renko+SMC (majority) ${r2.direction.toUpperCase()} - ${r2.streak} ${r2.trend.toUpperCase()} brick(s) & ${smcRead.note}` }
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
      renkoSmcMajority: toMsl(this.readSource('renkoSmcMajority', asset, tf)),
      pointFigure: toMsl(this.readSource('pointFigure', asset, tf)),
      rangeBars: toMsl(this.readSource('rangeBars', asset, tf)),
      candle: toMsl(this.readSource('candle', asset, tf)),
      bar: toMsl(this.readSource('bar', asset, tf)),
      heikinAshi: toMsl(this.readSource('heikinAshi', asset, tf)),
      line: toMsl(this.readSource('line', asset, tf)),
      area: toMsl(this.readSource('area', asset, tf)),
      baseline: toMsl(this.readSource('baseline', asset, tf)),
      volumeBars: toMsl(this.readSource('volumeBars', asset, tf)),
      tick: toMsl(this.readSource('tick', asset, tf)),
      footprint: toMsl(this.readSource('footprint', asset, tf)),
      tpo: toMsl(this.readSource('tpo', asset, tf)),
      ivHv: toMsl(this.readSource('ivHv', asset, tf)),
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
