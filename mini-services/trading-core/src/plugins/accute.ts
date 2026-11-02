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
//
// Self-adaptive confidence gate (adaptiveAdjustment()): no two pairs trade
// alike, the same pair trades differently by time of day, and a macro vol
// spike can make a strategy that works in calm conditions useless in a
// news spike - so Accute does not use one flat minOracleConfidence bar
// everywhere. Every resolved 3-way-agreement signal is tagged at issue
// time with its own session (analytics/session.ts - the clock-based
// classifier every other adaptive bucket in this stack already uses) and
// regime (the Oracle/Tempo board's own classifyRegime() read, already
// computed for every row - VOLATILE is the macro-vol-spike case). Those
// tags bucket the resolved ledger exactly like plugins/tempo.ts's
// pairAccuracyMult() and plugins/adaptive.ts's journal gate do, with the
// same "thin record is no record" graduated fallback: asset+tf+session+
// regime, widening to asset+tf+regime, then asset+tf, then tf-wide, then
// fleet-wide, the first level with enough samples wins. A bucket that has
// proven itself wrong gets its confidence floor raised (or, past a harder
// threshold, forced to WAITING regardless of 3-way agreement); a bucket
// that has proven itself strong gets a small, bounded floor relief. Until
// a bucket has history of its own, the only hand-set rule left is a flat
// confidence bump during a VOLATILE regime read - the seed the learning
// above is free to override once it has evidence either way.
//
// Support/resistance + buy-zone/sell-zone awareness (zoneRead()): the 3
// legs above answer "does everything agree on a direction", but not
// "is price actually somewhere sane to take that direction from" - a CALL
// fired in the dead middle of a range, or chasing already-extended price
// away from any structure, is a worse CALL than the identical 3-way
// agreement fired right off support. Rather than invent new math for
// this, it reuses analytics/structure.ts's two already-existing, pure,
// non-repainting series: trendPullbackSeries (a trending market's own
// swing structure - positive near a confirmed higher-low "support",
// negative near a confirmed lower-high "resistance") and rangeZoneSeries
// (a ranging market's own channel - positive near the floor "buy zone",
// negative near the ceiling "sell zone"). The two are mutually exclusive
// by design (a market in one structure doesn't qualify for the other), so
// whichever is non-zero at the live bar IS the zone read. Both series are
// deliberately sparse (non-zero well under 5% of bars on real data, by
// design - they only fire on a confirmed swing pullback or a genuine
// range), so the gate blocks a CALL only when the read ACTIVELY
// disagrees (reads sell) and a PUT only when it actively reads buy; 'no
// recognized zone right now' passes through neutral, same "thin record
// is no record" cold-start rule the adaptive gate above uses - requiring
// an ACTIVE zone match on every bar would effectively veto the signal
// almost always.
//
// Renko-direction gate (renkoBricks() in analytics/renko.ts, the same
// engine of record the Renko + Footprint panel/strategies already use):
// a CALL only clears while the current Renko brick trend is 'up', a PUT
// only while it's 'down' - 'none' (not enough history to have painted a
// brick yet) blocks either direction, same as every other gate here. This
// is the noise filter the other three legs don't have on their own:
// bricks only form after price has actually moved a full ATR-scaled brick
// size, so a Renko disagreement is a cheap, independent check that the
// move Accute is about to call isn't just intrabar noise the 1-minute
// candle-based legs are reading too eagerly.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { Candle, Timeframe } from '../types'
import { fitAdxPatternBias, PATTERN_BIAS_LOOKBACK, higherTimeframe } from '../analytics/adxpatternbias'
import { combineAccute, accuteSummary, type AccuteDirection, type AccuteResult } from '../analytics/accute'
import { weightedMeanBy } from '../analytics/recencystats'
import { classifySession, type Session } from '../analytics/session'
import { trendPullbackSeries, rangeZoneSeries } from '../analytics/structure'
import { renkoBricks } from '../analytics/renko'
import type { MarketDataService } from './market-data'
import type { NextCandleService, GlobalScanRow } from './nextcandle'
import type { TempoService, TempoRow } from './tempo'
import type { AdxHonestyService } from './adxhonesty'

const MAX_RESOLVED = 500
const OUTCOME_FILE = 'accute_outcomes.json'
const GLOBAL_SCAN_TTL_MS = 12_000
const CALIBRATION_WINDOW = 80
export const ACCUTE_DEFAULT_MIN_ORACLE_CONFIDENCE = 55

/** Regime label as carried on every Oracle/Tempo board row (classifyRegime
 * in analytics/regime.ts) - VOLATILE is the "macro factor" case: a vol
 * spike (GARCH vol well above EWMA) that can render a calm-conditions
 * strategy useless. */
type AccuteRegimeHint = 'TRENDING' | 'RANGING' | 'VOLATILE' | 'MIXED'

const ADAPTIVE_MIN_N = 20
const ADAPTIVE_TARGET_HIT_RATE = 0.52
const ADAPTIVE_OVERRIDE_MIN_N = 40
const ADAPTIVE_OVERRIDE_HIT_RATE = 0.42
const ADAPTIVE_MAX_BUMP = 25
const ADAPTIVE_MAX_RELIEF = 10
const ADAPTIVE_VOLATILITY_BUMP = 10
const ADAPTIVE_MIN_CONFIDENCE = 40
const ADAPTIVE_MAX_CONFIDENCE = 90

export interface AccuteAdaptiveAdjustment {
  /** which bucket's history this adjustment actually came from - may be
   * wider than the exact asset+tf+session+regime combo if that exact
   * bucket is still thin (graduated fallback, see module header). */
  bucket: string
  session: Session
  regime: AccuteRegimeHint
  /** resolved (non-flat) samples backing `bucket` - 0 means no learned
   * history anywhere yet, pure hand-set default in force. */
  n: number
  hitRate: number | null
  /** the Oracle-leg confidence bar actually used this read, after the
   * macro volatility bump and any learned adjustment, clamped to
   * [ADAPTIVE_MIN_CONFIDENCE, ADAPTIVE_MAX_CONFIDENCE]. */
  minConfidenceUsed: number
  /** true when this exact bucket has proven itself wrong often enough
   * (n >= ADAPTIVE_OVERRIDE_MIN_N, hit rate < ADAPTIVE_OVERRIDE_HIT_RATE)
   * that the read is forced to WAITING even if all 3 legs technically
   * agree this bar. */
  overridden: boolean
  note: string
}

/** Support/resistance + buy-zone/sell-zone read, see module header. `source`
 * says which structure detector actually produced it ('none' = price isn't
 * currently sitting in any recognized zone at all). */
export interface AccuteZoneRead {
  source: 'trend' | 'range' | 'none'
  side: 'buy' | 'sell' | 'none'
  strength: number
  label: string
}

function zoneRead(candles: Candle[]): AccuteZoneRead {
  const trend = trendPullbackSeries(candles)
  const tVal = trend[trend.length - 1] ?? 0
  if (tVal !== 0) {
    const side: 'buy' | 'sell' = tVal > 0 ? 'buy' : 'sell'
    return {
      source: 'trend',
      side,
      strength: Math.abs(tVal),
      label: side === 'buy'
        ? `trending structure - price pulled back to a confirmed support swing (${Math.abs(tVal).toFixed(2)} ATR margin)`
        : `trending structure - price pulled back to a confirmed resistance swing (${Math.abs(tVal).toFixed(2)} ATR margin)`,
    }
  }
  const range = rangeZoneSeries(candles)
  const rVal = range[range.length - 1] ?? 0
  if (rVal !== 0) {
    const side: 'buy' | 'sell' = rVal > 0 ? 'buy' : 'sell'
    return {
      source: 'range',
      side,
      strength: Math.abs(rVal),
      label: side === 'buy'
        ? `ranging channel - price is in the buy zone near the channel floor (${Math.abs(rVal).toFixed(2)} ATR margin)`
        : `ranging channel - price is in the sell zone near the channel ceiling (${Math.abs(rVal).toFixed(2)} ATR margin)`,
    }
  }
  return { source: 'none', side: 'none', strength: 0, label: 'price is not currently in a recognized support/resistance or buy/sell zone' }
}

/** Current Renko brick trend read, see module header. */
export interface AccuteRenkoRead {
  trend: 'up' | 'down' | 'none'
  streak: number
  brickSize: number
  label: string
}

function renkoRead(candles: Candle[]): AccuteRenkoRead {
  const r = renkoBricks(candles)
  const label =
    r.trend === 'none'
      ? 'no Renko brick has painted yet on this history - warming up'
      : `${r.streak} consecutive ${r.trend.toUpperCase()} brick${r.streak === 1 ? '' : 's'} (${r.brickRule})`
  return { trend: r.trend, streak: r.streak, brickSize: r.brickSize, label }
}

interface PendingAccuteSignal {
  asset: string
  tf: string
  targetBarTime: number
  issuedTs: number
  direction: 'call' | 'put'
  price: number
  session: Session
  regime: AccuteRegimeHint
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
  session: Session
  regime: AccuteRegimeHint
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
  adaptive: AccuteAdaptiveAdjustment
  zone: AccuteZoneRead
  renko: AccuteRenkoRead
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
      adaptive: {
        bucket: 'n/a', session: classifySession(Math.floor(now / 1000), asset), regime: 'MIXED',
        n: 0, hitRate: null, minConfidenceUsed: ACCUTE_DEFAULT_MIN_ORACLE_CONFIDENCE, overridden: false, note,
      },
      zone: { source: 'none', side: 'none', strength: 0, label: note },
      renko: { trend: 'none', streak: 0, brickSize: 0, label: note },
    }
  }

  /** Graduated fallback cascade over the resolved (non-flat) ledger: the
   * exact asset+tf+session+regime bucket if it has enough samples of its
   * own, else widen one dimension at a time (drop session, then regime,
   * then timeframe) until a level clears ADAPTIVE_MIN_N - same "thin
   * record is no record" philosophy as plugins/tempo.ts's
   * pairAccuracyMult() and plugins/adaptive.ts's journal gate, just with
   * one more axis (session) because an hour-of-day effect is exactly what
   * the user asked Accute to account for. */
  private bucketRows(asset: string, tf: string, session: Session, regime: AccuteRegimeHint): { rows: ResolvedAccuteSignal[]; label: string } {
    const decided = this.resolved.filter((r) => r.actual !== 'flat')
    const full = decided.filter((r) => r.asset === asset && r.tf === tf && r.session === session && r.regime === regime)
    if (full.length >= ADAPTIVE_MIN_N) return { rows: full, label: `${asset} ${tf} ${session} ${regime}` }
    const byRegime = decided.filter((r) => r.asset === asset && r.tf === tf && r.regime === regime)
    if (byRegime.length >= ADAPTIVE_MIN_N) return { rows: byRegime, label: `${asset} ${tf} any-session ${regime}` }
    const byPair = decided.filter((r) => r.asset === asset && r.tf === tf)
    if (byPair.length >= ADAPTIVE_MIN_N) return { rows: byPair, label: `${asset} ${tf} any-session any-regime` }
    const byTf = decided.filter((r) => r.tf === tf)
    if (byTf.length >= ADAPTIVE_MIN_N) return { rows: byTf, label: `any-pair ${tf}` }
    return { rows: decided, label: 'fleet-wide (every pair/tf)' }
  }

  private clampConfidence(v: number): number {
    return Math.max(ADAPTIVE_MIN_CONFIDENCE, Math.min(ADAPTIVE_MAX_CONFIDENCE, Math.round(v)))
  }

  /** The self-adaptive piece the user asked for: this pair, this time of
   * day, this macro regime - not one flat config for every signal. Thin
   * record: only the hand-set VOLATILE bump applies. Enough history: the
   * bucket's own recency-weighted hit rate tightens or relaxes the Oracle
   * leg's confidence bar, bounded both ways so the gate can never turn
   * fully off or fully closed on its own. Proven-wrong bucket (bigger
   * sample, worse bar): force WAITING outright, regardless of 3-way
   * agreement this bar - no amount of agreement overrides a pair/session/
   * regime combo that has already demonstrated it doesn't work. */
  private adaptiveAdjustment(asset: string, tf: string, session: Session, regime: AccuteRegimeHint, baseMinConfidence: number): AccuteAdaptiveAdjustment {
    const volBump = regime === 'VOLATILE' ? ADAPTIVE_VOLATILITY_BUMP : 0
    const { rows, label } = this.bucketRows(asset, tf, session, regime)
    if (rows.length < ADAPTIVE_MIN_N) {
      return {
        bucket: label, session, regime, n: rows.length, hitRate: null,
        minConfidenceUsed: this.clampConfidence(baseMinConfidence + volBump),
        overridden: false,
        note: `thin record (${rows.length}/${ADAPTIVE_MIN_N} resolved) - ${volBump > 0 ? `macro volatility bump +${volBump}` : 'default floor, nothing learned yet'}`,
      }
    }
    const hitRate = weightedMeanBy(rows, (r) => (r.hit ? 1 : 0))
    if (rows.length >= ADAPTIVE_OVERRIDE_MIN_N && hitRate < ADAPTIVE_OVERRIDE_HIT_RATE) {
      return {
        bucket: label, session, regime, n: rows.length, hitRate,
        minConfidenceUsed: ADAPTIVE_MAX_CONFIDENCE,
        overridden: true,
        note: `"${label}" has proven itself wrong (${rows.length} resolved, ${(hitRate * 100).toFixed(0)}% hit) - standing aside regardless of agreement`,
      }
    }
    let adj = 0
    if (hitRate < ADAPTIVE_TARGET_HIT_RATE) {
      adj = Math.min(ADAPTIVE_MAX_BUMP, (ADAPTIVE_TARGET_HIT_RATE - hitRate) * 100)
    } else if (hitRate > ADAPTIVE_TARGET_HIT_RATE + 0.1) {
      adj = -Math.min(ADAPTIVE_MAX_RELIEF, (hitRate - ADAPTIVE_TARGET_HIT_RATE) * 20)
    }
    return {
      bucket: label, session, regime, n: rows.length, hitRate,
      minConfidenceUsed: this.clampConfidence(baseMinConfidence + volBump + adj),
      overridden: false,
      note: `"${label}": ${rows.length} resolved, ${(hitRate * 100).toFixed(0)}% hit → ${adj >= 0 ? '+' : ''}${adj.toFixed(0)} confidence floor${volBump > 0 ? ` (+${volBump} macro)` : ''}`,
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

    // leg 3: Next-Candle Oracle fusion. Its regime read (classifyRegime,
    // already computed for every board row) is also what feeds the
    // adaptive gate below - the "macro factor" the user asked Accute to
    // account for, since a VOLATILE read is exactly a vol-spike macro
    // event that can render a calm-conditions edge useless.
    let oracleRow: GlobalScanRow | null = null
    try {
      oracleRow = this.ctx.use<NextCandleService>('nextcandle').rowFor(asset, tf as Timeframe)
    } catch {
      oracleRow = null
    }
    const regime = ((oracleRow?.regime ?? tempoRow?.regime ?? 'MIXED') as AccuteRegimeHint)
    const session = classifySession(Math.floor(now / 1000), asset)
    const adaptive = this.adaptiveAdjustment(asset, tf, session, regime, minConf)
    const effectiveMinConf = adaptive.minConfidenceUsed

    const oracleDir: AccuteDirection = oracleRow?.ok && oracleRow.direction !== 'none' && oracleRow.confidence >= effectiveMinConf ? oracleRow.direction : 'none'
    const oracleLabel = !oracleRow?.ok
      ? 'Oracle warming up'
      : oracleDir === 'none'
        ? `Oracle not confident enough (${oracleRow.confidence.toFixed(1)} < ${effectiveMinConf})`
        : `Oracle ${oracleDir.toUpperCase()} (confidence ${oracleRow.confidence.toFixed(1)})`

    const rawResult = combineAccute({
      adxPattern: { direction: adxDir, label: adxLabel },
      tempo: { direction: tempoDir, label: tempoLabel },
      oracle: { direction: oracleDir, label: oracleLabel },
    })

    // support/resistance + buy-zone/sell-zone gate (module header): a CALL
    // is blocked only while the zone read ACTIVELY disagrees (reads sell),
    // a PUT only while it actively reads buy. 'none' (no recognized
    // structure at this bar - trendPullbackSeries/rangeZoneSeries are both
    // deliberately sparse, non-zero well under 5% of bars on real data) is
    // treated as neutral and passes through, same "thin record is no
    // record" cold-start rule the rest of this stack's gates use -
    // requiring an ACTIVE zone match on every bar (the original version of
    // this gate) effectively vetoed the signal almost always, which is
    // what made both the live board and the backtest go quiet.
    const zone = zoneRead(candles)
    const zoneBlocks = rawResult.direction === 'call'
      ? zone.side === 'sell'
      : rawResult.direction === 'put'
        ? zone.side === 'buy'
        : false

    // renko-direction gate (module header): a CALL only clears while the
    // current brick trend is 'up', a PUT only while it's 'down'.
    const renko = renkoRead(candles)
    const renkoBlocks = rawResult.direction === 'call'
      ? renko.trend !== 'up'
      : rawResult.direction === 'put'
        ? renko.trend !== 'down'
        : false

    // the adaptive override: a bucket that has already proven itself
    // wrong often enough stands aside outright, no matter what the 3 legs
    // say this bar - see adaptiveAdjustment()'s doc. Any gate alone is
    // enough to force WAITING.
    const result: AccuteResult = adaptive.overridden || zoneBlocks || renkoBlocks
      ? { ...rawResult, direction: 'none', waiting: true }
      : rawResult

    const price = oracleRow?.price || tempoRow?.price || candles[candles.length - 1]?.close || 0
    const targetBarTime = oracleRow?.targetBarTime || tempoRow?.windowEndsAt || 0

    if (result.direction !== 'none' && targetBarTime > 0) {
      const key = `${asset}:${tf}:${targetBarTime}`
      this.pending.set(key, { asset, tf, targetBarTime, issuedTs: now, direction: result.direction, price, session, regime })
      if (this.pending.size > 300) {
        const keys = [...this.pending.keys()].slice(0, 60)
        for (const k of keys) this.pending.delete(k)
      }
    }

    const summary = adaptive.overridden
      ? `adaptive gate: ${adaptive.note}`
      : zoneBlocks
        ? `zone gate: ${rawResult.direction.toUpperCase()} agreement found, but ${zone.label} - standing aside`
        : renkoBlocks
          ? `renko gate: ${rawResult.direction.toUpperCase()} agreement found, but ${renko.label} - standing aside`
          : accuteSummary(rawResult)

    const row: AccuteSignalResponse = {
      asset,
      tf,
      ok: true,
      note: '',
      direction: result.direction,
      waiting: result.waiting,
      summary,
      legs: rawResult.legs,
      agreeCount: rawResult.agreeCount,
      leaning: rawResult.leaning,
      price,
      targetBarTime,
      computedTs: now,
      calibration: this.calibrationFor(asset, tf),
      adaptive,
      zone,
      renko,
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
        session: p.session,
        regime: p.regime,
      })
      while (this.resolved.length > MAX_RESOLVED) this.resolved.shift()
      this.persist()
    }
  }

  /** Lifetime ledger for panels/agents, plus a visibility-only breakdown of
   * the session/regime buckets the adaptive gate is actually learning from
   * (adaptiveAdjustment() reads the same resolved ledger live, per-signal
   * - this is just a read-only snapshot for the UI, sorted worst-hit-rate
   * first so a dampened pair/session/regime combo is easy to spot). */
  stats(): {
    total: number
    pending: number
    hitRate: number | null
    records: { asset: string; tf: string; n: number; hitRate: number }[]
    buckets: { bucket: string; n: number; hitRate: number }[]
    recent: ResolvedAccuteSignal[]
  } {
    const decided = this.resolved.filter((r) => r.actual !== 'flat')
    const byKey = new Map<string, ResolvedAccuteSignal[]>()
    const byBucket = new Map<string, ResolvedAccuteSignal[]>()
    for (const r of this.resolved) {
      const k = `${r.asset}:${r.tf}`
      const arr = byKey.get(k) ?? []
      arr.push(r)
      byKey.set(k, arr)
      if (r.actual === 'flat') continue
      const bk = `${r.asset} ${r.tf} ${r.session ?? 'OFF'} ${r.regime ?? 'MIXED'}`
      const barr = byBucket.get(bk) ?? []
      barr.push(r)
      byBucket.set(bk, barr)
    }
    const records = [...byKey.entries()]
      .map(([k, rows]) => {
        const [asset, tf] = k.split(':')
        return { asset, tf, n: rows.length, hitRate: weightedMeanBy(rows, (r) => (r.hit ? 1 : 0)) }
      })
      .sort((a, b) => b.n - a.n)
    const buckets = [...byBucket.entries()]
      .filter(([, rows]) => rows.length >= ADAPTIVE_MIN_N)
      .map(([bucket, rows]) => ({ bucket, n: rows.length, hitRate: weightedMeanBy(rows, (r) => (r.hit ? 1 : 0)) }))
      .sort((a, b) => a.hitRate - b.hitRate)
    return {
      total: this.resolved.length,
      pending: this.pending.size,
      hitRate: decided.length > 0 ? weightedMeanBy(decided, (r) => (r.hit ? 1 : 0)) : null,
      records,
      buckets,
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
