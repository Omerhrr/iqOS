// Chart-signals scanner: runs the chart-type engine votes across the whole
// open instrument universe - no top-N cut here, every qualifying read comes
// back and the caller applies any limit it wants (`top` on /signals; the
// Signal Panel (web) takes them all). Each signal carries a TTL so a stale
// read disappears instead of lingering - anchored to the BAR that fed it, so
// a late scan against old candles honestly lives shorter. Real-market assets
// vote with the volume footprint (CLV proxy), OTC assets with the micro-tick
// velocity footprint - the same engines their charts render. OTC pairs are
// always part of the pass (they used to be crowded out by a universe cap -
// now the response reports per-market coverage so the panel can prove it).
// Task 64-c: every qualifying read also becomes a tracked outcome - the
// scanner resolves it at its own suggested expiry (CFD plans on first
// sampled TP/SL touch within a 15-min horizon), so the panel can show what
// the chart engines actually delivered, per engine and per market type.
// Edge registry: the scanner used to be pure PULL (scan only when a panel
// polls, emit whatever is currently true) - a read that had been true for
// forty bars looked identical to one that flipped two bars ago, and with no
// panel open nothing was evaluated at all. Now every scan diffs against the
// previous scan's qualifying set (diffEdges) and stamps entered/held/flip +
// firstSeenTs on each read, and the scanner subscribes to bar-close events:
// since votes only read CLOSED candles, a bar close is the only moment the
// answer can change - so recently-requested kind:tf combos are rescanned
// within ~1.5s of it, proactively, no panel poll required. Boot backfill:
// the first scan after a restart marks every read held+backfilled - a fresh
// boot cannot know how long a condition has been true, so nothing looks
// fresh just because the kernel came up.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { Candle, Timeframe } from '../types'
import { TIMEFRAME_SECONDS } from '../types'
import { isInstrumentOpen, searchInstruments } from '../universe'
import { buildChartSignal, diffEdges, type ChartSignal, type EdgeState, type OtcFpRead } from '../analytics/chartsignals'
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
  /** Open instruments found this pass - scanned should equal it (nothing
   * left behind); if the hard safety cap ever bites, scanned < universe. */
  universe: number
  /** OTC coverage of the same pass - the panel's OTC filter shows exactly
   * these instruments, so the counts keep the split honest. */
  otcScanned: number
  otcConsidered: number
  otcQualifying: number
  /** Reads whose condition JUST became true or flipped this scan (phase
   * entered|flip) - the fresh-edge count the panel's NEW badges summarize. */
  freshEdges: number
  signals: ChartSignal[]
  ts: number
  scanMs: number
}

const UNIVERSE_HARD_CAP = 200 // safety valve for pathological sidecar catalogs
const CACHE_MS = 12_000 // one scan serves rapid panel polls
const SIGNAL_TTL_SEC = 150 // a signal that old is no longer "relevant"
const SWEEP_MS = 5_000 // outcome sampling / resolution cadence
const FLUSH_MS = 10_000 // debounced outcomes persistence
/** How long after its last consumer request a kind:tf combo stays proactive:
 * bar-close rescans only run for combos someone actually reads - scanning
 * everything forever would burn CPU for panels nobody has open. */
const ACTIVE_MS = 15 * 60_000
/** Debounce for bar-close-triggered rescans: many candle events land in a
 * burst (one per asset); one rescan per combo after the burst settles. */
const RESCAN_DEBOUNCE_MS = 1_500

export class ChartSignalsService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private otcFp: OtcFootprintService | null = null
  // keyed by kind:tf - the panel follows the chart's timeframe, so M1 and M5
  // scans must live side by side without one leaking into the other's cache
  private cache = new Map<string, { ts: number; result: ChartScanResult }>()
  private scanning = new Map<string, Promise<ChartScanResult>>()
  private tracker = new SignalOutcomeTracker()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private outcomesPath = join(process.cwd(), 'data', 'chartsignals_outcomes.json')
  // per kind:tf registry of what qualified on the previous scan - the memory
  // that turns level reads into entered/held/flip transitions
  private edges = new Map<string, Map<string, EdgeState>>()
  // kind:tf -> last consumer-request ts; only recently-requested combos get
  // proactive bar-close rescans (nothing scans for panels nobody opens)
  private activeCombos = new Map<string, number>()
  private dirtyCombos = new Set<string>()
  private rescanTimer: ReturnType<typeof setTimeout> | null = null
  private draining = false

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
    // bar-close proactive rescans: votes read only CLOSED candles, so a bar
    // close is the only moment a read can change - recently-requested
    // kind:tf combos are marked dirty and rescanned after the burst settles.
    // This is what makes "we caught it when it happened" true: the scan
    // happens ~1.5s after the bar closes whether or not any panel polls.
    ctx.bus.on('candle', ({ tf, closed }) => {
      if (!closed) return
      for (const kind of ['option', 'cfd'] as SignalKind[]) {
        const combo = `${kind}:${tf}`
        if (this.activeCombos.has(combo)) this.dirtyCombos.add(combo)
      }
      this.scheduleRescan()
    })
  }

  /** Debounced drain of dirty combos - one rescan per combo per bar-close
   * burst, sequential so a slow scan never piles up behind itself. */
  private scheduleRescan(): void {
    if (this.rescanTimer) return
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null
      void this.drainRescans()
    }, RESCAN_DEBOUNCE_MS)
  }

  private async drainRescans(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      const now = Date.now()
      const combos = [...this.dirtyCombos]
      this.dirtyCombos.clear()
      for (const combo of combos) {
        const lastRequested = this.activeCombos.get(combo)
        if (lastRequested === undefined || now - lastRequested > ACTIVE_MS) continue // consumer went away
        const [kind, tf] = combo.split(':') as [SignalKind, Timeframe]
        try {
          // full scan (updates cache + registry + outcomes); panel polls
          // read it from the cache with zero extra work
          await this.scanOnce(kind, tf)
        } catch {
          /* a failed proactive scan waits for the next bar like before */
        }
      }
    } finally {
      this.draining = false
      // more closes landed while draining - run another pass
      if (this.dirtyCombos.size) this.scheduleRescan()
    }
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

  /** Outcome stats for the panel's hit-rate view. tf filters to one
   * timeframe's reads; omitted = all timeframes blended. */
  stats(tf?: Timeframe) {
    return this.tracker.stats(tf)
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

  private async scanOnce(kind: SignalKind, tf: Timeframe): Promise<ChartScanResult> {
    const t0 = Date.now()
    // reads live on the scanned timeframe: a structural read on M15 needs
    // more runway than an M1 blip - TTL and suggested expiry scale with the
    // bar size (1m keeps the historical 150s / 60..300s behavior exactly)
    const tfSec = TIMEFRAME_SECONDS[tf]
    const ttlSec = tfSec <= 60 ? SIGNAL_TTL_SEC : Math.min(Math.max(tfSec * 5, 300), 3600)
    const active = this.market.activeAsset
    // Session-aware open set: curated 'market'/'otc-gap' rows carry a static
    // open=false at boot, so the time-of-day check rescues them when their
    // session is actually running (stocks during US hours, SNAP-OTC at
    // night). Live-discovered rows trust the sidecar's own is_open.
    const universe = searchInstruments('', 'all')
      .filter((i) => i.open || isInstrumentOpen(i))
      .sort((a, b) => (a.ticker === active ? -1 : b.ticker === active ? 1 : 0))
      .slice(0, UNIVERSE_HARD_CAP)

    let scanned = 0
    let considered = 0
    let otcScanned = 0
    let otcConsidered = 0
    const signals: ChartSignal[] = []
    const CHUNK = 4
    for (let i = 0; i < universe.length; i += CHUNK) {
      await Promise.all(
        universe.slice(i, i + CHUNK).map(async (info) => {
          scanned++
          if (info.otc) otcScanned++
          let candles: Candle[] = []
          try {
            candles = this.market.getCandlesDeep(info.ticker, tf, 240, true)
          } catch {
            return
          }
          if (candles.length < 40) return // thin history - no honest read
          considered++
          if (info.otc) otcConsidered++
          const realTicks = info.otc
            ? null
            : this.market
                .recentTicks(info.ticker, 400)
                .map((t) => ({ time: t.ts / 1000, price: t.price }))
          const otcRead = info.otc ? await this.otcReadAsync(info.ticker) : null
          const sig = buildChartSignal(
            { ticker: info.ticker, name: info.name, category: info.category, otc: !!info.otc, pip: info.pip },
            candles,
            { realTicks, otcRead, now: Date.now(), ttlSec, tfSec }
          )
          if (sig) signals.push(sig)
        })
      )
    }

    signals.sort((a, b) => b.strength - a.strength || b.agree - a.agree)
    // edge diff: stamp entered/held/flip + firstSeenTs on every read against
    // what qualified on the previous scan of this kind:tf (boot backfill:
    // the first scan marks everything held+backfilled - nothing looks fresh
    // just because the kernel restarted)
    const comboKey = `${kind}:${tf}`
    let registry = this.edges.get(comboKey)
    if (!registry) {
      registry = new Map()
      this.edges.set(comboKey, registry)
    }
    const nowMs = Date.now()
    const edgeMeta = diffEdges(
      registry,
      signals.map((s) => ({ asset: s.asset, direction: s.direction, barTs: s.barTs })),
      nowMs,
    )
    for (const s of signals) {
      const meta = edgeMeta.get(s.asset)
      if (!meta) continue
      s.phase = meta.phase
      s.firstSeenTs = meta.firstSeenTs
      s.backfilled = meta.backfilled
    }
    // the full qualified list is cached; `top` is applied at read time in
    // scan() so different top params can share one scan.
    const result: ChartScanResult = {
      ok: true,
      kind,
      tf,
      scanned,
      considered,
      qualifying: signals.length,
      universe: universe.length,
      otcScanned,
      otcConsidered,
      otcQualifying: signals.filter((s) => s.otc).length,
      freshEdges: signals.filter((s) => s.phase === 'entered' || s.phase === 'flip').length,
      signals,
      ts: Date.now(),
      scanMs: Date.now() - t0,
    }
    // every qualifying read enters the honesty loop (deduped per
    // kind+tf+asset+direction while pending - reads on different timeframes
    // are different reads)
    try {
      this.tracker.record(kind, tf, signals, result.ts)
    } catch {
      /* tracking never breaks the scan */
    }
    return result
  }

  /** Fresh scan (cached per kind:tf for CACHE_MS), stale entries dropped +
   * `top` applied at read time so cache hits honor the caller's limit.
   * top<=0 (the default) means no cut - every qualifying read comes back.
   * Every request also marks the kind:tf combo active, which arms proactive
   * bar-close rescans for ACTIVE_MS - the scanner stops being pull-only. */
  async scan(kind: SignalKind, top: number, tf: Timeframe): Promise<ChartScanResult> {
    this.activeCombos.set(`${kind}:${tf}`, Date.now())
    const key = `${kind}:${tf}`
    const cached = this.cache.get(key)
    const now = Date.now()
    if (cached && now - cached.ts < CACHE_MS) {
      return this.sliceTop(this.filterFresh(cached.result, now), top)
    }
    const inflight = this.scanning.get(key)
    if (inflight) return this.sliceTop(this.filterFresh(await inflight, now), top)
    const p = this.scanOnce(kind, tf).then((r) => {
      this.cache.set(key, { ts: r.ts, result: r })
      this.scanning.delete(key)
      return r
    })
    this.scanning.set(key, p)
    return this.sliceTop(this.filterFresh(await p, now), top)
  }

  private sliceTop(r: ChartScanResult, top: number): ChartScanResult {
    if (top <= 0 || r.signals.length <= top) return r
    const signals = r.signals.slice(0, top)
    return {
      ...r,
      signals,
      otcQualifying: signals.filter((s) => s.otc).length,
    }
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
