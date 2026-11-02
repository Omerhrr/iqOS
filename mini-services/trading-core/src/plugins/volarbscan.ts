// IQAIR//OS - Volatility-arb scanner (panel-facing) + outcome tracking
// Same role/shape as leadlagscan.ts/cointegrationscan.ts for their own
// sources: re-runs the close-vol-vs-range-vol fit (analytics/volarb.ts)
// across the whole open-instrument universe, returns the full table, and -
// new vs the old bare index.ts module function this replaces - records
// every directional (fade/continue, never balanced) row as a tracked claim
// so there is finally a REAL answer to "does the vol-ratio regime actually
// predict anything" instead of just a plausible read (task: next-candle-
// oracle real-edge audit, 2026-11-02).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { AssetCategory, Timeframe } from '../types'
import { TIMEFRAME_SECONDS } from '../types'
import type { MarketDataService } from './market-data'
import { computeVolArb, VOLARB_DEFAULT_WINDOW } from '../analytics/volarb'
import { VolArbOutcomeTracker, type VolArbStats, type ResolvedVolArbOutcome } from '../analytics/volarboutcomes'

export interface VolArbScanRow {
  asset: string
  name: string
  category: AssetCategory
  otc: boolean
  open: boolean
  price: number
  closeVol: number
  rangeVol: number
  ratio: number
  momentum: number
  lastBarDir: -1 | 0 | 1
  direction: 'call' | 'put' | null
  regime: 'fade' | 'continue' | 'balanced'
  ts: number
}

export interface VolArbScanResult {
  ok: true
  tf: Timeframe
  scanned: number
  rows: VolArbScanRow[]
  ts: number
  scanMs: number
}

// same ratioHigh/ratioLow convention as the volatility-arb strategy's own
// defaults in builtin.ts and VolatilityArbPanel.tsx's local constants
const VOLARB_SCAN_RATIO_HIGH = 1.6
const VOLARB_SCAN_RATIO_LOW = 0.6
const CACHE_MS = 15_000
const SWEEP_MS = 5_000
const FLUSH_MS = 10_000
const ACTIVE_MS = 30 * 60_000
const SELF_SCAN_MS = CACHE_MS

export class VolArbScanService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private cache = new Map<Timeframe, { ts: number; result: VolArbScanResult }>()
  private tracker = new VolArbOutcomeTracker()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private selfScanTimer: ReturnType<typeof setInterval> | null = null
  private outcomesPath = join(process.cwd(), 'data', 'volarb_outcomes.json')
  private activeTfs = new Map<Timeframe, number>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    this.loadOutcomes()
    this.sweepTimer = setInterval(() => {
      try {
        const resolved = this.tracker.tick(Date.now(), (a) => this.market.getPrice(a))
        if (resolved.length) {
          ctx.log('volarb-scan', `resolved ${resolved.length} vol-arb outcome(s) (${resolved.map((r) => `${r.asset} ${r.regime} ${r.outcome}`).join(', ')})`)
        }
      } catch {
        /* the honesty loop never breaks scanning */
      }
    }, SWEEP_MS)
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
    this.selfScanTimer = setInterval(() => {
      const now = Date.now()
      for (const [tf, lastRequested] of this.activeTfs) {
        if (now - lastRequested > ACTIVE_MS) {
          this.activeTfs.delete(tf)
          continue
        }
        try {
          this.scan(tf)
        } catch {
          /* a failed self-scan just waits for the next tick */
        }
      }
    }, SELF_SCAN_MS)
    ctx.log('volarb-scan', 'volatility-arb (close-vol vs range-vol) scanner online + outcome tracking')
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.selfScanTimer) clearInterval(this.selfScanTimer)
  }

  private loadOutcomes(): void {
    try {
      const raw = JSON.parse(readFileSync(this.outcomesPath, 'utf8')) as { resolved?: ResolvedVolArbOutcome[] }
      this.tracker = new VolArbOutcomeTracker(raw.resolved ?? [])
      if (raw.resolved?.length) {
        this.ctx.log('volarb-scan', `restored ${raw.resolved.length} tracked vol-arb outcomes from data/`)
      }
    } catch {
      /* no file yet - start clean */
    }
  }

  stats(tf?: Timeframe): VolArbStats {
    return this.tracker.stats(tf)
  }

  private scanOnce(tf: Timeframe): VolArbScanResult {
    const t0 = Date.now()
    const rows: VolArbScanRow[] = []
    for (const a of this.market.assets) {
      if (!a.open) continue
      try {
        const candles = this.market.getCandlesDeep(a.ticker, tf, Math.max(300, VOLARB_DEFAULT_WINDOW + 50), true)
        const out = computeVolArb(candles, VOLARB_DEFAULT_WINDOW)
        if (!out) continue
        const direction: 'call' | 'put' | null =
          out.ratio >= VOLARB_SCAN_RATIO_HIGH && out.lastBarDir !== 0
            ? out.lastBarDir > 0 ? 'put' : 'call'
            : out.ratio <= VOLARB_SCAN_RATIO_LOW && out.momentum !== 0
              ? out.momentum > 0 ? 'call' : 'put'
              : null
        const regime: VolArbScanRow['regime'] = out.ratio >= VOLARB_SCAN_RATIO_HIGH ? 'fade' : out.ratio <= VOLARB_SCAN_RATIO_LOW ? 'continue' : 'balanced'
        rows.push({
          asset: a.ticker,
          name: a.name,
          category: a.category,
          otc: !!a.otc,
          open: a.open,
          price: candles[candles.length - 1]?.close ?? 0,
          closeVol: out.closeVol,
          rangeVol: out.rangeVol,
          ratio: out.ratio,
          momentum: out.momentum,
          lastBarDir: out.lastBarDir,
          direction,
          regime,
          ts: Date.now(),
        })
      } catch {
        /* one bad asset never breaks the scan */
      }
    }
    rows.sort((x, y) => Math.abs(y.ratio - 1) - Math.abs(x.ratio - 1))

    const nowMs = Date.now()
    const tfSec = TIMEFRAME_SECONDS[tf]
    const directionalRows = rows.filter((r) => r.direction && r.regime !== 'balanced')
    try {
      this.tracker.record(
        directionalRows.map((r) => ({
          asset: r.asset,
          tf,
          otc: r.otc,
          direction: r.direction as 'call' | 'put',
          price: r.price,
          ratio: r.ratio,
          regime: r.regime,
          momentum: r.momentum,
          tfSec,
        })),
        nowMs,
      )
      const liveKeys = new Set(directionalRows.map((r) => `${r.asset}|${r.direction}`))
      this.tracker.pruneStale(liveKeys, nowMs)
    } catch {
      /* tracking never breaks the scan */
    }

    return {
      ok: true,
      tf,
      scanned: rows.length,
      rows,
      ts: Date.now(),
      scanMs: Date.now() - t0,
    }
  }

  scan(tf: Timeframe): VolArbScanResult {
    this.activeTfs.set(tf, Date.now())
    const cached = this.cache.get(tf)
    const now = Date.now()
    if (cached && now - cached.ts < CACHE_MS) return cached.result
    const result = this.scanOnce(tf)
    this.cache.set(tf, { ts: result.ts, result })
    return result
  }
}

export const volArbScanPlugin: Plugin = {
  name: 'volarb-scan',
  start: async (ctx) => {
    const svc = new VolArbScanService()
    ctx.provide('volArbScan', svc)
    await svc.start(ctx)
  },
}
