// IQAIR//OS - Accute plugin (triple-confluence confirmation)
//
// Wires analytics/accute.ts's combineAccute() to the three engines already
// running in this kernel instead of inventing anything new:
//
//   1. ADX/DI + Pattern Bias - computed fresh here (fitAdxPatternBias is
//      pure; there's no standing plugin to read a live fit from, the same
//      reason index.ts's own scanAdxPatternBias computes it inline), then
//      fed into plugins/adxhonesty.ts's tracker so Accute's own reads also
//      grow that honesty ledger.
//   2. Tempo (plugins/tempo.ts's TempoService.rowFor/scan) - read-only:
//      rowFor() never spends the shared one-shot license, only claim()
//      does (called by the auto-trader source in os-mode.ts, right before
//      actually placing a trade off an Accute signal).
//   3. Next-Candle Oracle (plugins/nextcandle.ts's NextCandleService.rowFor/
//      globalScan) - same shared TTL-cached board every other panel reads.
//
// Same honesty-loop shape as chartsignals/adxhonesty/tempo/nextcandle:
// every signal where all three legs agree is TRACKED pending, resolved on
// the target bar's close, persisted to data/accute_outcomes.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { Candle, Timeframe } from '../types'
import { fitAdxPatternBias, PATTERN_BIAS_LOOKBACK, higherTimeframe } from '../analytics/adxpatternbias'
import { combineAccute, accuteSummary, type AccuteDirection, type AccuteResult } from '../analytics/accute'
import { weightedMeanBy } from '../analytics/recencystats'
import type { MarketDataService } from './market-data'
import type { NextCandleService, GlobalScanRow } from './nextcandle'
import type { TempoService, TempoRow } from './tempo'
import type { AdxHonestyService } from './adxhonesty'

const MAX_RESOLVED = 500
const OUTCOME_FILE = 'accute_outcomes.json'
const GLOBAL_SCAN_TTL_MS = 12_000
const CALIBRATION_WINDOW = 80
export const ACCUTE_DEFAULT_MIN_ORACLE_CONFIDENCE = 55

interface PendingAccuteSignal {
  asset: string
  tf: string
  targetBarTime: number
  issuedTs: number
  direction: 'call' | 'put'
  price: number
}

export interface ResolvedAccuteSignal {
  asset: string
  tf: string
  targetBarTime: number
  issuedTs: number
  resolvedTs: number
  direction: 'call' | 'put'
  entry: number
  exit: number
  actual: 'up' | 'down' | 'flat'
  hit: boolean
}

export interface AccuteSignalResponse {
  asset: string
  tf: string
  ok: boolean
  note: string
  direction: AccuteDirection
  waiting: boolean
  summary: string
  legs: AccuteResult['legs']
  agreeCount: number
  leaning: 'call' | 'put' | null
  price: number
  targetBarTime: number
  computedTs: number
  calibration: { n: number; hitRate: number } | null
}

export interface AccuteGlobalResult {
  tf: string
  scannedTs: number
  universe: number
  scanned: number
  agreeing: number
  rows: AccuteSignalResponse[]
}

export class AccuteService {
  private ctx!: KernelContext
  private unsub: (() => void) | null = null
  private pending = new Map<string, PendingAccuteSignal>()
  private resolved: ResolvedAccuteSignal[] = []
  private scanRows = new Map<string, AccuteSignalResponse>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.restore()
    this.unsub = ctx.bus.on('candle', ({ asset, tf, candle, closed }) => {
      if (!closed) return
      this.resolveFor(asset, tf, candle)
    })
    ctx.log('accute', "Accute triple-confluence engine online (ADX/DI + Pattern, Tempo, Next-Candle Oracle - signals only when all 3 agree)")
  }

  stop(): void {
    this.unsub?.()
    this.persist()
  }

  private emptyRow(asset: string, tf: string, now: number, note: string): AccuteSignalResponse {
    return {
      asset, tf, ok: false, note,
      direction: 'none', waiting: true, summary: note,
      legs: {
        adxPattern: { direction: 'none', label: note },
        tempo: { direction: 'none', label: note },
        oracle: { direction: 'none', label: note },
      },
      agreeCount: 0, leaning: null,
      price: 0, targetBarTime: 0, computedTs: now,
      calibration: this.calibrationFor(asset, tf),
    }
  }

  /** This asset:tf's own resolved Accute record - same rolling-window,
   * recency-weighted shape every other honesty loop in this codebase uses
   * (analytics/recencystats.ts). */
  calibrationFor(asset: string, tf: string): { n: number; hitRate: number } | null {
    const rows = this.resolved.filter((r) => r.asset === asset && r.tf === tf).slice(-CALIBRATION_WINDOW)
    if (rows.length === 0) return null
    return { n: rows.length, hitRate: weightedMeanBy(rows, (r) => (r.hit ? 1 : 0)) }
  }

  /** The combined read for one asset:tf - computes all three legs fresh
   * (each already cheap/TTL-cached on its own engine) and tracks a
   * pending honesty-loop entry whenever all three agree. Read-only with
   * respect to Tempo's shared one-shot license: only the auto-trader's
   * Accute source (os-mode.ts, via tempo.claim()) ever spends it. */
  signal(asset: string, tf: Timeframe, opts: { minOracleConfidence?: number } = {}): AccuteSignalResponse {
    const now = Date.now()
    let market: MarketDataService
    try {
      market = this.ctx.use<MarketDataService>('market')
    } catch {
      return this.emptyRow(asset, tf, now, 'market-data plugin not loaded')
    }
    const minConf = opts.minOracleConfidence ?? ACCUTE_DEFAULT_MIN_ORACLE_CONFIDENCE

    let candles: Candle[] = []
    try {
      candles = market.getCandlesDeep(asset, tf as never, 400, true)
    } catch {
      candles = []
    }
    if (candles.length < 60) return this.emptyRow(asset, tf, now, 'warming up: not enough bars yet')

    // leg 1: ADX/DI + Pattern Bias - same call index.ts's scanAdxPatternBias
    // makes (optional HTF veto + honesty-loop feed), so Accute's own ADX
    // leg reads identically to the standalone ADX/DI + Pattern Bias panel.
    let fit: ReturnType<typeof fitAdxPatternBias> = null
    try {
      const htf = higherTimeframe(tf as Timeframe)
      let higherCandles: Candle[] | undefined
      if (htf) {
        try {
          higherCandles = market.getCandlesDeep(asset, htf as never, 120, true)
        } catch {
          higherCandles = undefined
        }
      }
      fit = fitAdxPatternBias(candles, 14, PATTERN_BIAS_LOOKBACK, higherCandles)
      if (fit) {
        try {
          this.ctx.use<AdxHonestyService>('adxhonesty').track(asset, tf, fit, candles)
        } catch {
          // honesty tracking optional - never breaks the read
        }
      }
    } catch {
      fit = null
    }
    const adxDir: AccuteDirection = fit?.qualifies ? (fit.direction === 'bullish' ? 'call' : 'put') : 'none'
    const adxLabel = fit
      ? `ADX/Pattern ${adxDir === 'none' ? 'not qualifying' : `${adxDir.toUpperCase()} (composite ${fit.composite.toFixed(1)})`}`
      : 'ADX/Pattern thin history'

    // leg 2: Tempo - must be ACTIVELY FIRING this bar, not merely leaning a
    // direction (see analytics/accute.ts's module doc for why).
    let tempoRow: TempoRow | null = null
    try {
      tempoRow = this.ctx.use<TempoService>('tempo').rowFor(asset, tf as Timeframe)
    } catch {
      tempoRow = null
    }
    const tempoDir: AccuteDirection = tempoRow?.ok && tempoRow.decision === 'fire' ? tempoRow.direction : 'none'
    const tempoLabel = !tempoRow?.ok
      ? 'Tempo warming up'
      : tempoRow.decision === 'fire'
        ? `Tempo FIRING ${tempoDir === 'none' ? '' : tempoDir.toUpperCase()}`
        : `Tempo ${tempoRow.decision} (${tempoRow.decisionReason})`

    // leg 3: Next-Candle Oracle fusion.
    let oracleRow: GlobalScanRow | null = null
    try {
      oracleRow = this.ctx.use<NextCandleService>('nextcandle').rowFor(asset, tf as Timeframe)
    } catch {
      oracleRow = null
    }
    const oracleDir: AccuteDirection = oracleRow?.ok && oracleRow.direction !== 'none' && oracleRow.confidence >= minConf ? oracleRow.direction : 'none'
    const oracleLabel = !oracleRow?.ok
      ? 'Oracle warming up'
      : oracleDir === 'none'
        ? `Oracle not confident enough (${oracleRow.confidence.toFixed(1)} < ${minConf})`
        : `Oracle ${oracleDir.toUpperCase()} (confidence ${oracleRow.confidence.toFixed(1)})`

    const result = combineAccute({
      adxPattern: { direction: adxDir, label: adxLabel },
      tempo: { direction: tempoDir, label: tempoLabel },
      oracle: { direction: oracleDir, label: oracleLabel },
    })

    const price = oracleRow?.price || tempoRow?.price || candles[candles.length - 1]?.close || 0
    const targetBarTime = oracleRow?.targetBarTime || tempoRow?.windowEndsAt || 0

    if (result.direction !== 'none' && targetBarTime > 0) {
      const key = `${asset}:${tf}:${targetBarTime}`
      this.pending.set(key, { asset, tf, targetBarTime, issuedTs: now, direction: result.direction, price })
      if (this.pending.size > 300) {
        const keys = [...this.pending.keys()].slice(0, 60)
        for (const k of keys) this.pending.delete(k)
      }
    }

    const row: AccuteSignalResponse = {
      asset,
      tf,
      ok: true,
      note: '',
      direction: result.direction,
      waiting: result.waiting,
      summary: accuteSummary(result),
      legs: result.legs,
      agreeCount: result.agreeCount,
      leaning: result.leaning,
      price,
      targetBarTime,
      computedTs: now,
      calibration: this.calibrationFor(asset, tf),
    }
    this.scanRows.set(`${tf}:${asset}`, row)
    return row
  }

  /** Whole-universe board, same TTL-cache-per-row shape as the Oracle and
   * Tempo boards - a panel polling one pair and the board scanning the
   * whole universe share the same cached row within GLOBAL_SCAN_TTL_MS. */
  globalScan(tf: Timeframe, opts: { limit?: number; refresh?: boolean } = {}): AccuteGlobalResult {
    const limit = Math.max(1, Math.min(Math.round(opts.limit ?? 40), 150))
    const refresh = opts.refresh === true
    const now = Date.now()
    let market: MarketDataService
    try {
      market = this.ctx.use<MarketDataService>('market')
    } catch {
      return { tf, scannedTs: now, universe: 0, scanned: 0, agreeing: 0, rows: [] }
    }
    const universe = market.listAssets().filter((a) => a.open)
    const picked = universe.slice(0, limit)
    const rows: AccuteSignalResponse[] = []
    for (const a of picked) {
      const key = `${tf}:${a.ticker}`
      const cached = this.scanRows.get(key)
      if (!refresh && cached && now - cached.computedTs < GLOBAL_SCAN_TTL_MS) {
        rows.push(cached)
        continue
      }
      try {
        rows.push(this.signal(a.ticker, tf))
      } catch {
        rows.push(this.emptyRow(a.ticker, tf, now, 'read failed this poll'))
      }
    }
    // agreeing-first, then by how many legs lean the same way, then asset
    rows.sort((x, y) => {
      const xAgree = x.direction !== 'none' ? 1 : 0
      const yAgree = y.direction !== 'none' ? 1 : 0
      if (xAgree !== yAgree) return yAgree - xAgree
      if (y.agreeCount !== x.agreeCount) return y.agreeCount - x.agreeCount
      return x.asset.localeCompare(y.asset)
    })
    return {
      tf,
      scannedTs: now,
      universe: universe.length,
      scanned: rows.length,
      agreeing: rows.filter((r) => r.direction !== 'none').length,
      rows,
    }
  }

  /** Resolve every pending 3-way-agreement signal whose target bar just
   * closed - win/loss vs the predicted direction, same realized-up/down/
   * flat rule every other honesty loop in this codebase uses. */
  private resolveFor(asset: string, tf: string, candle: Candle): void {
    const prefix = `${asset}:${tf}:`
    for (const [key, p] of this.pending) {
      if (!key.startsWith(prefix)) continue
      if (p.targetBarTime !== candle.time) continue
      this.pending.delete(key)
      const diff = candle.close - p.price
      const actual: ResolvedAccuteSignal['actual'] = Math.abs(diff) < 1e-12 ? 'flat' : diff > 0 ? 'up' : 'down'
      const hit = p.direction === 'call' ? actual === 'up' : actual === 'down'
      this.resolved.push({
        asset,
        tf,
        targetBarTime: p.targetBarTime,
        issuedTs: p.issuedTs,
        resolvedTs: Date.now(),
        direction: p.direction,
        entry: p.price,
        exit: candle.close,
        actual,
        hit,
      })
      while (this.resolved.length > MAX_RESOLVED) this.resolved.shift()
      this.persist()
    }
  }

  /** Lifetime ledger for panels/agents. */
  stats(): {
    total: number
    pending: number
    hitRate: number | null
    records: { asset: string; tf: string; n: number; hitRate: number }[]
    recent: ResolvedAccuteSignal[]
  } {
    const decided = this.resolved.filter((r) => r.actual !== 'flat')
    const byKey = new Map<string, ResolvedAccuteSignal[]>()
    for (const r of this.resolved) {
      const k = `${r.asset}:${r.tf}`
      const arr = byKey.get(k) ?? []
      arr.push(r)
      byKey.set(k, arr)
    }
    const records = [...byKey.entries()]
      .map(([k, rows]) => {
        const [asset, tf] = k.split(':')
        return { asset, tf, n: rows.length, hitRate: weightedMeanBy(rows, (r) => (r.hit ? 1 : 0)) }
      })
      .sort((a, b) => b.n - a.n)
    return {
      total: this.resolved.length,
      pending: this.pending.size,
      hitRate: decided.length > 0 ? weightedMeanBy(decided, (r) => (r.hit ? 1 : 0)) : null,
      records,
      recent: this.resolved.slice(-40).reverse(),
    }
  }

  // ---------- persistence (same contract as plugins/nextcandle.ts) ----------
  private dataFile(): string {
    const dir = join(process.cwd(), 'data')
    mkdirSync(dir, { recursive: true })
    return join(dir, OUTCOME_FILE)
  }

  private restore(): void {
    try {
      const f = this.dataFile()
      if (!existsSync(f)) return
      const raw = JSON.parse(readFileSync(f, 'utf8'))
      if (Array.isArray(raw?.resolved)) this.resolved = raw.resolved.slice(-MAX_RESOLVED)
      this.ctx.log('accute', `restored ${this.resolved.length} resolved Accute signals from data/`)
    } catch {
      // corrupt/missing file - start with a clean ledger, never break boot
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.dataFile(), JSON.stringify({ resolved: this.resolved.slice(-MAX_RESOLVED) }))
    } catch {
      // best-effort - the in-memory record stays authoritative until next save
    }
  }
}

export const accutePlugin: Plugin = {
  name: 'accute',
  start: async (ctx) => {
    const svc = new AccuteService()
    ctx.provide('accute', svc)
    await svc.start(ctx)
  },
}
