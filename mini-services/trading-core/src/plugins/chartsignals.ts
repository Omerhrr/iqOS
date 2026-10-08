// Chart-signals scanner: runs the chart-type engine votes across the whole
// open instrument universe and keeps only the top-N strongest confluence
// reads. The Signal Panel (web) polls /signals; each signal carries a TTL so
// a stale read disappears instead of lingering. Real-market assets vote with
// the volume footprint (CLV proxy), OTC assets with the micro-tick velocity
// footprint - the same engines their charts render.
// Task 64-c: every qualifying read also becomes a tracked outcome - the
// scanner resolves it at its own suggested expiry (CFD plans on first
// sampled TP/SL touch within a 15-min horizon), so the panel can show what
// the chart engines actually delivered, per engine and per market type.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { Candle, Timeframe } from '../types'
import { searchInstruments } from '../universe'
import { buildChartSignal, type ChartSignal, type OtcFpRead } from '../analytics/chartsignals'
import { SignalOutcomeTracker, type ResolvedOutcome } from '../analytics/signaloutcomes'
import type { MarketDataService } from './market-data'
import type { OtcFootprintService } from './otcfootprint'

export type SignalKind = 'option' | 'cfd'

export interface ChartScanResult {
  ok: true
  kind: SignalKind
  tf: Timeframe
  scanned: number
  considered: number
  qualifying: number
  signals: ChartSignal[]
  ts: number
  scanMs: number
}

const UNIVERSE_CAP = 18 // bounded sidecar/analytics load per scan
const CACHE_MS = 12_000 // one scan serves rapid panel polls
const SIGNAL_TTL_SEC = 150 // a signal that old is no longer "relevant"
const SWEEP_MS = 5_000 // outcome sampling / resolution cadence
const FLUSH_MS = 10_000 // debounced outcomes persistence

export class ChartSignalsService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private otcFp: OtcFootprintService | null = null
  private cache = new Map<SignalKind, { ts: number; result: ChartScanResult }>()
  private scanning = new Map<SignalKind, Promise<ChartScanResult>>()
  private tracker = new SignalOutcomeTracker()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private outcomesPath = join(process.cwd(), 'data', 'chartsignals_outcomes.json')

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    try {
      this.otcFp = ctx.use<OtcFootprintService>('otcFootprint')
    } catch {
      this.otcFp = null // footprint engine absent - OTC votes read 0 honestly
    }
    this.loadOutcomes()
    // outcome sweep: sample pending reads, resolve the matured ones
    this.sweepTimer = setInterval(() => {
      try {
        const resolved = this.tracker.tick(Date.now(), (a) => this.market.getPrice(a))
        if (resolved.length) {
          ctx.log('chart-signals', `resolved ${resolved.length} signal outcome(s) (${resolved.map((r) => `${r.asset} ${r.outcome}`).join(', ')})`)
        }
      } catch {
        /* the honesty loop never breaks scanning */
      }
    }, SWEEP_MS)
    // debounced persistence: outcomes survive kernel restarts
    this.flushTimer = setInterval(() => {
      if (!this.tracker.needsFlush) return
      try {
        mkdirSync(join(process.cwd(), 'data'), { recursive: true })
        writeFileSync(this.outcomesPath, JSON.stringify({ savedAt: Date.now(), ...this.tracker.state() }))
        this.tracker.markFlushed()
      } catch {
        /* persistence is best-effort */
      }
    }, FLUSH_MS)
    ctx.log('chart-signals', 'chart-type signal scanner online (renko/pnf/range/tick/footprint|otcfootprint/heikin/candle) + outcome tracking')
  }

  private loadOutcomes(): void {
    try {
      const raw = JSON.parse(readFileSync(this.outcomesPath, 'utf8')) as { resolved?: ResolvedOutcome[] }
      this.tracker = new SignalOutcomeTracker(raw.resolved ?? [])
      if (raw.resolved?.length) {
        this.ctx.log('chart-signals', `restored ${raw.resolved.length} tracked signal outcomes from data/`)
      }
    } catch {
      /* no file yet - start clean */
    }
  }

  /** Outcome stats for the panel's hit-rate view. */
  stats() {
    return this.tracker.stats()
  }

  private async otcReadAsync(ticker: string): Promise<OtcFpRead | null> {
    if (!this.otcFp) return null
    try {
      const fp = await this.otcFp.footprint(ticker, { minutes: 30, bucketSec: 60 })
      const live = fp.buckets.filter((b) => b.nTicks > 0)
      if (!live.length) return null // tick buffer cold - engine stands aside
      return {
        signal: fp.summary.signal,
        score: fp.summary.score,
        netDelta: fp.summary.netDelta,
        avgSpeedRatio: fp.summary.avgSpeedRatio,
        buckets: live.length,
      }
    } catch {
      return null
    }
  }

  private async scanOnce(kind: SignalKind, top: number, tf: Timeframe): Promise<ChartScanResult> {
    const t0 = Date.now()
    const active = this.market.activeAsset
    const universe = searchInstruments('', 'all')
      .filter((i) => i.open)
      .sort((a, b) => (a.ticker === active ? -1 : b.ticker === active ? 1 : 0))
      .slice(0, UNIVERSE_CAP)

    let scanned = 0
    let considered = 0
    const signals: ChartSignal[] = []
    const CHUNK = 4
    for (let i = 0; i < universe.length; i += CHUNK) {
      await Promise.all(
        universe.slice(i, i + CHUNK).map(async (info) => {
          scanned++
          let candles: Candle[] = []
          try {
            candles = this.market.getCandlesDeep(info.ticker, tf, 240, true)
          } catch {
            return
          }
          if (candles.length < 40) return // thin history - no honest read
          considered++
          const realTicks = info.otc
            ? null
            : this.market
                .recentTicks(info.ticker, 400)
                .map((t) => ({ time: t.ts / 1000, price: t.price }))
          const otcRead = info.otc ? await this.otcReadAsync(info.ticker) : null
          const sig = buildChartSignal(
            { ticker: info.ticker, name: info.name, category: info.category, otc: !!info.otc, pip: info.pip },
            candles,
            { realTicks, otcRead, now: Date.now(), ttlSec: SIGNAL_TTL_SEC }
          )
          if (sig) signals.push(sig)
        })
      )
    }

    signals.sort((a, b) => b.strength - a.strength || b.agree - a.agree)
    // the full qualified list is cached; `top` is applied at read time in
    // scan() so different top params can share one scan.
    const result: ChartScanResult = {
      ok: true,
      kind,
      tf,
      scanned,
      considered,
      qualifying: signals.length,
      signals,
      ts: Date.now(),
      scanMs: Date.now() - t0,
    }
    // every qualifying read enters the honesty loop (deduped per
    // kind+asset+direction while pending)
    try {
      this.tracker.record(kind, signals, result.ts)
    } catch {
      /* tracking never breaks the scan */
    }
    return result
  }

  /** Fresh scan (cached for CACHE_MS), stale entries dropped + `top`
   * applied at read time so cache hits honor the caller's limit. */
  async scan(kind: SignalKind, top: number, tf: Timeframe): Promise<ChartScanResult> {
    const cached = this.cache.get(kind)
    const now = Date.now()
    if (cached && now - cached.ts < CACHE_MS) {
      return this.sliceTop(this.filterFresh(cached.result, now), top)
    }
    const inflight = this.scanning.get(kind)
    if (inflight) return this.sliceTop(this.filterFresh(await inflight, now), top)
    const p = this.scanOnce(kind, top, tf).then((r) => {
      this.cache.set(kind, { ts: r.ts, result: r })
      this.scanning.delete(kind)
      return r
    })
    this.scanning.set(kind, p)
    return this.sliceTop(this.filterFresh(await p, now), top)
  }

  private sliceTop(r: ChartScanResult, top: number): ChartScanResult {
    if (r.signals.length <= top) return r
    return { ...r, signals: r.signals.slice(0, top) }
  }

  private filterFresh(r: ChartScanResult, now: number): ChartScanResult {
    const live = r.signals.filter((s) => s.validUntil > now)
    if (live.length === r.signals.length) return r
    return { ...r, signals: live }
  }
}

export const chartSignalsPlugin: Plugin = {
  name: 'chart-signals',
  start: async (ctx) => {
    const svc = new ChartSignalsService()
    ctx.provide('chartSignals', svc)
    await svc.start(ctx)
  },
}
