// IQAIR//OS - Tempo plugin (the patience engine)
//
// Tempo is a CADENCE layer on top of the Next-Candle Oracle, not another
// predictor: every 10-bar window on a pair is a hunting license for exactly
// ONE shot. All window math and the stopping rule live in
// analytics/tempo.ts (pure); this plugin owns the state around it:
//
// - window bookkeeping per (tf, asset): which 10-bar epoch we are in, the
//   per-bar conviction trace of the current window, whether the license
//   has been spent, and the rolling window-max history that feeds the
//   patience bar;
// - evaluate/claim separation: scan() NEVER commits a shot (panels can
//   watch freely), claim() is the one-shot atomic commit the auto-trader's
//   'tempo' signal source calls - first claim wins, the window then reads
//   'done' for everyone;
// - a shot ledger with its own honesty loop: every claimed shot resolves
//   on the target bar's close (win/loss vs entry at the 1-bar expiry) and
//   persists to data/tempo_shots.json, so the panel can show per-pair
//   "did the patience engine actually pick winners" records.
//
// Fusion reads come from the NextCandleService (predict/globalScan), so
// every tempo row IS a tracked oracle prediction - one honesty ledger,
// shared calibration, no double computation inside the board's 12s TTL.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, Plugin } from '../kernel'
import type { Candle, Timeframe } from '../types'
import { TIMEFRAME_SECONDS } from '../types'
import { tempoConviction, tempoDecide, tempoWindow, TEMPO_FLOOR, TEMPO_PAIR_ACCURACY_MAX_PENALTY, TEMPO_WINDOW_BARS, PATIENCE_COEFF_DEFAULT, PATIENCE_COEFF_MIN, PATIENCE_COEFF_MAX, type TempoDecision } from '../analytics/tempo'
import { fitAdxPatternBias, PATTERN_BIAS_LOOKBACK } from '../analytics/adxpatternbias'
import type { NextCandleService, GlobalScanRow } from './nextcandle'
import type { MarketDataService } from './market-data'
import type { AdxHonestyService } from './adxhonesty'
import { weightedHitRate } from '../analytics/recencystats'

/** Candidate coefficients searched by learnedPatienceCoeff() - centered on
 * the original hand-set PATIENCE_COEFF_DEFAULT (0.35), spanning the full
 * PATIENCE_COEFF_MIN/MAX band. */
const PATIENCE_COEFF_CANDIDATES = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5]
/** "Thin record is no record": fleet-wide resolved-shot floor below which
 * learnedPatienceCoeff() falls back to the hand-set default rather than
 * trusting a coefficient search on too little history. */
const PATIENCE_COEFF_MIN_N = 40
/** Direction-split pairAccuracyMult: a pair's call-side and put-side
 * ledgers are judged separately once each has its own min sample count -
 * thinner than the combined PAIR_ACCURACY_MIN_N (20) since each direction
 * only sees roughly half the shots a pair takes. */
const PAIR_ACCURACY_DIRECTION_MIN_N = 12

function clampCoeff(v: number): number {
  return Math.max(PATIENCE_COEFF_MIN, Math.min(PATIENCE_COEFF_MAX, v))
}

const MAX_SHOTS = 400
const SHOT_FILE = 'tempo_shots.json'
/** per (tf, asset) window states kept - pruned like nextcandle's scanRows */
const MAX_STATES = 600

export interface TempoFiredSignal {
  direction: 'call' | 'put'
  pUp: number
  confidence: number
  conviction: number
  threshold: number
  price: number
  targetBarTime: number
  ts: number
  reason: string
}

export interface ResolvedShot {
  asset: string
  tf: string
  windowIdx: number
  targetBarTime: number
  direction: 'call' | 'put'
  entry: number
  exit: number
  confidence: number
  conviction: number
  /** the license floor this shot had to clear at claim time - persisted so
   * learnedPatienceCoeff() can replay "would a different floor coefficient
   * still have let this fire" without needing the pair's window-max
   * history at that moment. */
  threshold: number
  /** how far into the window the shot was taken (0..9) */
  barIndex: number
  ts: number
  resolvedTs: number
  hit: boolean
  flat: boolean
}

interface PairTempoState {
  windowIdx: number
  fired: boolean
  firedSignal: TempoFiredSignal | null
  bestConviction: number
  bestBarTime: number
  /** per-bar trace of the CURRENT window (one entry per judged bar) */
  bars: { barTime: number; conviction: number; direction: 'call' | 'put' | 'none'; confidence: number; pUp: number }[]
}

export interface TempoRow {
  asset: string
  tf: string
  ok: boolean
  note: string
  windowIdx: number
  barIndex: number
  barsRemaining: number
  /** wall-clock ms when the window closes (the license expires) */
  windowEndsAt: number
  conviction: number
  threshold: number
  patienceBar: number
  /** fire = the shot is live and unclaimed; done = license spent; wait/skip = not this bar */
  decision: 'fire' | 'wait' | 'skip' | 'done'
  decisionReason: string
  fired: boolean
  firedSignal: TempoFiredSignal | null
  bestConviction: number
  trace: PairTempoState['bars']
  direction: 'call' | 'put' | 'none'
  pUp: number
  confidence: number
  price: number
  regime: string
  driversActive: number
  calibration: { n: number; hitRate: number; brier: number } | null
  lastShot: { direction: 'call' | 'put'; hit: boolean; conviction: number; resolvedTs: number } | null
  shotStats: { n: number; hitRate: number | null } | null
}

export interface TempoScanResult {
  tf: string
  ts: number
  /** the tf-wide window clock every pair shares (epoch-aligned windows) */
  window: { index: number; barIndex: number; barsRemaining: number; startedAt: number; endsAt: number }
  scanned: number
  live: number
  /** rows whose shot is live and unclaimed RIGHT NOW */
  firing: number
  /** windows that ended with the license spent vs unspent (observed ones) */
  windowsSpent: number
  windowsMissed: number
  rows: TempoRow[]
}

export class TempoService {
  private ctx!: KernelContext
  private unsub: (() => void) | null = null
  private states = new Map<string, PairTempoState>() // key `${tf}:${asset}`
  private history = new Map<string, number[]>() // key `${tf}:${asset}` -> window maxima, all sessions blended
  /** Same window-maxima, split by session - a pair's rhythm during active
   * hours and quiet hours blended into one history muddies expectedWindowMax
   * (the quiet-hours numbers drag the active-hours patience bar down, or
   * vice versa). Key `${tf}:${asset}:${session}`. Read via historyFor()
   * below, which falls back to the blended `history` map until a session
   * bucket has enough of its own samples to trust. */
  private sessionHistory = new Map<string, number[]>()
  private shots: ResolvedShot[] = []

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.restore()
    // resolve shots + roll windows on candle close - the same bus event
    // the oracle's own honesty loop uses, so a shot and its underlying
    // fusion prediction settle on the same tick
    this.unsub = ctx.bus.on('candle', ({ asset, tf, candle, closed }) => {
      if (!closed) return
      this.onCandleClose(asset, tf, candle)
    })
    ctx.log('tempo', `tempo patience engine online - one shot per ${10} bars, floor ${TEMPO_FLOOR}, optimal stopping on the pair's own window-max rhythm`)
  }

  stop(): void {
    this.unsub?.()
    this.persist()
  }

  // ---------- window state ----------

  private key(tf: string, asset: string): string {
    return `${tf}:${asset}`
  }

  /** Coarse 2-bucket session split (UTC): 07:00-21:00 covers the London/NY
   * active window this universe is busiest in, everything else is "off".
   * Deliberately simple - the point is separating "typical active-hours
   * rhythm" from "typical quiet-hours rhythm" for THIS pair, not modeling
   * every session boundary precisely. */
  private session(ms: number): 'active' | 'off' {
    const h = new Date(ms).getUTCHours()
    return h >= 7 && h < 21 ? 'active' : 'off'
  }

  /** The history to feed tempoDecide: this moment's session bucket once it
   * has enough of its own samples (>=6, same floor expectedWindowMax's own
   * trimmed-mean kicks in at), otherwise the blended all-sessions history -
   * explore blended first, specialize once the session's own rhythm is
   * actually known. */
  private historyFor(key: string, nowMs: number): number[] {
    const sh = this.sessionHistory.get(`${key}:${this.session(nowMs)}`)
    if (sh && sh.length >= 6) return sh
    return this.history.get(key) ?? []
  }

  /** Did the most recent resolved shot(s) on this pair, within the last
   * few windows, LOSE in the SAME direction at a similar conviction level
   * to right now? If so the current setup echoes a fresh failure rather
   * than being a clean fresh read - tempoDecide raises its floor for this
   * one decision instead of refusing outright (see TEMPO_RECENT_LOSS_PENALTY). */
  private recentSimilarLoss(asset: string, tf: string, direction: 'call' | 'put' | 'none', conviction: number, windowIdx: number): boolean {
    if (direction === 'none') return false
    const LOOKBACK_WINDOWS = 3
    const TOL = 0.25
    return this.shots.some(
      (s) =>
        s.asset === asset &&
        s.tf === tf &&
        !s.flat &&
        !s.hit &&
        s.direction === direction &&
        windowIdx - s.windowIdx >= 0 &&
        windowIdx - s.windowIdx <= LOOKBACK_WINDOWS &&
        Math.abs(s.conviction - conviction) <= Math.max(1, conviction) * TOL,
    )
  }

  /** This pair's own LIFETIME shot ledger (not just the last few windows,
   * unlike recentSimilarLoss above) - a structural, longer-horizon read on
   * whether this pair just runs worse than the fleet. "Thin record is no
   * record": below PAIR_ACCURACY_MIN_N decided shots this returns 1 (no
   * penalty) - a pair with few shots hasn't earned either trust or
   * suspicion yet. Once trusted, a hit rate at or above the healthy target
   * also returns 1; below target the floor gets multiplied up smoothly,
   * capped at TEMPO_PAIR_ACCURACY_MAX_PENALTY so a structurally bad pair is
   * dampened, never effectively shut off outright. */
  /** `direction` optional: when given, judges only that direction's own
   * ledger (see PAIR_ACCURACY_DIRECTION_MIN_N) instead of the pair's
   * combined call+put history - a pair that is structurally fine on calls
   * but weak on puts (or vice versa) used to get BOTH directions dampened
   * equally by the combined hit rate; this lets only the actually-weak
   * side get the raised floor. Falls back to the combined, direction-
   * blind read below its own sample floor, same "thin record is no
   * record" philosophy as everywhere else. */
  private pairAccuracyMult(asset: string, tf: string, direction?: 'call' | 'put'): number {
    const PAIR_ACCURACY_MIN_N = 20
    const PAIR_ACCURACY_TARGET_HIT_RATE = 0.5
    const base = this.shots.filter((s) => s.asset === asset && s.tf === tf && !s.flat)
    const decided = direction ? base.filter((s) => s.direction === direction) : base
    const minN = direction ? PAIR_ACCURACY_DIRECTION_MIN_N : PAIR_ACCURACY_MIN_N
    if (decided.length < minN) {
      // not enough of this direction's own history yet - fall back to the
      // pair's combined ledger rather than assuming "no penalty"
      // outright, so a structurally bad pair doesn't get a free pass on
      // its thinner-sampled direction while the other direction's penalty
      // is already well-established.
      if (direction && base.length >= PAIR_ACCURACY_MIN_N) return this.pairAccuracyMult(asset, tf)
      return 1
    }
    // recency-weighted (analytics/recencystats.ts): a pair's lifetime
    // ledger used to treat a loss from months ago exactly like one from
    // this morning - a pair that genuinely turned around would stay
    // penalized until the whole ledger rolled over. Weighting lets the
    // dampening ease off within a far shorter real improvement streak.
    const hitRate = weightedHitRate(decided, (s) => s.hit).hitRate
    if (hitRate >= PAIR_ACCURACY_TARGET_HIT_RATE) return 1
    return Math.max(1, Math.min(TEMPO_PAIR_ACCURACY_MAX_PENALTY, 1 + (PAIR_ACCURACY_TARGET_HIT_RATE - hitRate) * 3))
  }

  /** Fleet-wide search over PATIENCE_COEFF_CANDIDATES for whichever
   * pairFloor() coefficient would have maximized net hit rate across every
   * resolved shot, replacing the hand-set PATIENCE_COEFF_DEFAULT (0.35).
   * Can't exactly replay history (a shot's own window-max history at the
   * time isn't persisted), so this uses each candidate purely as a
   * decision-quality proxy: for a resolved shot, a HIGHER coefficient
   * would have required MORE conviction to fire - so a candidate above
   * the shot's own normalized conviction-vs-threshold margin would have
   * skipped a trade that, in hindsight, should or shouldn't have been
   * taken. Concretely: score each candidate by, for every resolved shot,
   * whether scaling that shot's recorded threshold by (candidate /
   * PATIENCE_COEFF_DEFAULT) would still have let a WIN fire (good) or
   * would have blocked a LOSS (good) - counting the fraction of "good"
   * outcomes per candidate and picking the best. Falls back to
   * PATIENCE_COEFF_DEFAULT below PATIENCE_COEFF_MIN_N resolved shots
   * fleet-wide. */
  private learnedPatienceCoeff(): number {
    const decided = this.shots.filter((s) => !s.flat && s.threshold !== undefined)
    if (decided.length < PATIENCE_COEFF_MIN_N) return PATIENCE_COEFF_DEFAULT
    let best = { coeff: PATIENCE_COEFF_DEFAULT, score: -1 }
    for (const coeff of PATIENCE_COEFF_CANDIDATES) {
      const scale = coeff / PATIENCE_COEFF_DEFAULT
      let good = 0
      for (const s of decided) {
        const scaledThreshold = (s.threshold ?? s.conviction) * scale
        const wouldFire = s.conviction >= scaledThreshold
        // a win that still would have fired, or a loss that would now be
        // blocked, counts as this coefficient doing the right thing
        if ((s.hit && wouldFire) || (!s.hit && !wouldFire)) good++
      }
      const score = good / decided.length
      if (score > best.score) best = { coeff: clampCoeff(coeff), score }
    }
    return best.coeff
  }

  private stateFor(key: string): PairTempoState {
    let s = this.states.get(key)
    if (!s) {
      s = { windowIdx: -1, fired: false, firedSignal: null, bestConviction: 0, bestBarTime: 0, bars: [] }
      this.states.set(key, s)
    }
    return s
  }

  /** Roll a pair into the window a bar belongs to, recording the previous
   * window's best into the patience history when the epoch advanced. */
  private rollTo(key: string, barTimeMs: number, tfSec: number): PairTempoState {
    const w = tempoWindow(barTimeMs, tfSec)
    const st = this.stateFor(key)
    if (w.windowIdx !== st.windowIdx) {
      if (st.windowIdx >= 0 && st.bars.length > 0) {
        // the old window is over - was its license spent or wasted?
        const h = this.history.get(key) ?? []
        h.push(st.bestConviction)
        if (h.length > 24) h.splice(0, h.length - 24)
        this.history.set(key, h)
        // archive into this window's own session bucket too - the window
        // we're archiving STARTED at st.windowIdx's epoch, not "now"
        const windowMs = TEMPO_WINDOW_BARS * tfSec * 1000
        const oldWindowStartMs = st.windowIdx * windowMs
        const sKey = `${key}:${this.session(oldWindowStartMs)}`
        const sh = this.sessionHistory.get(sKey) ?? []
        sh.push(st.bestConviction)
        if (sh.length > 24) sh.splice(0, sh.length - 24)
        this.sessionHistory.set(sKey, sh)
        if (this.sessionHistory.size > MAX_STATES * 2) {
          const stale = [...this.sessionHistory.keys()].slice(0, 200)
          for (const k of stale) this.sessionHistory.delete(k)
        }
      }
      st.windowIdx = w.windowIdx
      st.fired = false
      st.firedSignal = null
      st.bestConviction = 0
      st.bestBarTime = 0
      st.bars = []
      if (this.states.size > MAX_STATES) {
        const stale = [...this.states.entries()].sort((a, b) => a[1].windowIdx - b[1].windowIdx).slice(0, 200)
        for (const [k] of stale) this.states.delete(k)
      }
    }
    return st
  }

  // ---------- scan (pure evaluation - never commits a shot) ----------

  /** Whole-universe tempo board: one row per open instrument. Fusion reads
   * come from the nextcandle board (TTL-cached, honesty-tracked); the
   * tempo layer adds the window clock, the patience bar and the decision. */
  scan(tf: Timeframe, opts: { limit?: number } = {}): TempoScanResult {
    const tfSec = TIMEFRAME_SECONDS[tf] ?? 60
    const now = Date.now()
    const clock = tempoWindow(now, tfSec)
    const rows: TempoRow[] = []

    let oracle: NextCandleService | null = null
    try {
      oracle = this.ctx.use<NextCandleService>('nextcandle')
    } catch {
      oracle = null // plugin not loaded - board renders empty, never throws
    }
    if (!oracle) {
      return { tf, ts: now, window: { index: clock.windowIdx, barIndex: clock.barIndex, barsRemaining: clock.barsRemaining, startedAt: clock.windowStartMs, endsAt: clock.windowEndMs }, scanned: 0, live: 0, firing: 0, windowsSpent: 0, windowsMissed: 0, rows }
    }

    const board = oracle.globalScan(tf, { limit: Math.max(1, Math.min(opts.limit ?? 30, 150)) })
    for (const r of board.rows) {
      rows.push(this.rowFromScan(r, tf, tfSec, now))
    }
    // firing first (the whole point of the board), then by conviction
    const rank = (d: TempoRow['decision']) => (d === 'fire' ? 0 : d === 'done' ? 1 : d === 'wait' ? 2 : 3)
    rows.sort((a, b) => rank(a.decision) - rank(b.decision) || b.conviction - a.conviction)
    return {
      tf,
      ts: now,
      window: { index: clock.windowIdx, barIndex: clock.barIndex, barsRemaining: clock.barsRemaining, startedAt: clock.windowStartMs, endsAt: clock.windowEndMs },
      scanned: board.scanned,
      live: board.live,
      firing: rows.filter((r) => r.decision === 'fire').length,
      windowsSpent: this.shots.length, // lifetime spent licenses (resolved shots)
      windowsMissed: [...this.history.values()].reduce((s, h) => s + h.filter((v) => v > 0).length, 0) - this.shots.length,
      rows,
    }
  }

  private rowFromScan(r: GlobalScanRow, tf: string, tfSec: number, now: number): TempoRow {
    const key = this.key(tf, r.asset)
    const shotStats = this.shotStats(r.asset, tf)
    const lastShot = this.lastShot(r.asset, tf)
    if (!r.ok) {
      return {
        asset: r.asset, tf, ok: false, note: r.note,
        windowIdx: -1, barIndex: 0, barsRemaining: 0, windowEndsAt: 0,
        conviction: 0, threshold: 0, patienceBar: 0, decision: 'skip', decisionReason: 'warming up',
        fired: false, firedSignal: null, bestConviction: 0, trace: [],
        direction: 'none', pUp: 0.5, confidence: 0, price: r.price, regime: r.regime, driversActive: 0,
        calibration: r.calibration, lastShot, shotStats,
      }
    }
    const conviction = tempoConviction(r.confidence, r.pUp)
    const st = this.rollTo(key, r.targetBarTime, tfSec)
    const w = tempoWindow(r.targetBarTime, tfSec)
    // per-bar trace: one entry per predicted bar (dedupe re-polls of the
    // same forming bar - a refresh updates, not stacks)
    const existing = st.bars.find((b) => b.barTime === r.targetBarTime)
    if (existing) {
      existing.conviction = conviction
      existing.direction = r.direction
      existing.confidence = r.confidence
      existing.pUp = r.pUp
    } else {
      st.bars.push({ barTime: r.targetBarTime, conviction, direction: r.direction, confidence: r.confidence, pUp: r.pUp })
      if (st.bars.length > TEMPO_WINDOW_BARS) st.bars.shift()
    }
    if (conviction > st.bestConviction) {
      st.bestConviction = conviction
      st.bestBarTime = r.targetBarTime
    }
    const hist = this.historyFor(key, now)
    const recentSimilarLoss = this.recentSimilarLoss(r.asset, tf, r.direction, conviction, w.windowIdx)
    const pairAccuracyMult = r.direction === 'none' ? this.pairAccuracyMult(r.asset, tf) : this.pairAccuracyMult(r.asset, tf, r.direction)
    const floorCoeff = this.learnedPatienceCoeff()
    const dec: TempoDecision = tempoDecide({ conviction, barsRemaining: w.barsRemaining, windowMaxHistory: hist, recentSimilarLoss, pairAccuracyMult, floorCoeff })
    const spent = st.fired
    const decision: TempoRow['decision'] = spent ? 'done' : dec.kind === 'fire' ? 'fire' : dec.kind
    const reason = spent
      ? `license spent this window - shot taken at bar ${st.bars.findIndex((b) => b.barTime === st.firedSignal?.targetBarTime) + 1}/10 (${st.firedSignal?.direction?.toUpperCase()} conf ${st.firedSignal?.confidence.toFixed(0)}%)`
      : dec.reason
    return {
      asset: r.asset, tf, ok: true, note: '',
      windowIdx: w.windowIdx, barIndex: w.barIndex, barsRemaining: w.barsRemaining, windowEndsAt: w.windowEndMs,
      conviction, threshold: dec.threshold, patienceBar: dec.patienceBar,
      decision, decisionReason: reason,
      fired: spent, firedSignal: st.firedSignal,
      bestConviction: st.bestConviction,
      trace: [...st.bars],
      direction: r.direction, pUp: r.pUp, confidence: r.confidence, price: r.price,
      regime: r.regime, driversActive: r.driversActive, calibration: r.calibration,
      lastShot, shotStats,
    }
  }

  // ---------- claim (the one-shot atomic commit) ----------

  /** Spend a pair's window license: re-reads the pair fresh, re-runs the
   * stopping rule, and ONLY if the rule says fire and the license is
   * unspent commits the shot. First claim wins - the auto-trader source
   * calls this right before placing, so no amount of panel polling can
   * burn or block a shot. */
  claim(asset: string, tf: Timeframe): { ok: boolean; reason: string; signal?: TempoFiredSignal } {
    let oracle: NextCandleService
    try {
      oracle = this.ctx.use<NextCandleService>('nextcandle')
    } catch {
      return { ok: false, reason: 'oracle offline' }
    }
    const tfSec = TIMEFRAME_SECONDS[tf] ?? 60
    const pred = oracle.predict(asset, tf)
    if (!pred) return { ok: false, reason: 'oracle has no read on this pair yet (warming up)' }
    const key = this.key(tf, asset)
    if (pred.direction === 'none') return { ok: false, reason: 'fusion has no directional lean on this bar' }
    const st = this.rollTo(key, pred.targetBarTime, tfSec)
    if (st.fired) return { ok: false, reason: 'license already spent this window' }
    // cross-engine read, done BEFORE the stopping-rule decision (not just
    // as a post-hoc veto) so an agreeing second engine can earn the same
    // learned confluenceBoost() the ADX/DI+Pattern pickers use on a
    // borderline conviction, not just block a disagreeing one. Veto
    // contract unchanged: a neutral read never blocks or boosts, only an
    // ACTIVE opposing read stops the shot.
    let crossEngineAgrees: boolean | null = null
    try {
      const market = this.ctx.use<MarketDataService>('market')
      const candles = market.getCandlesDeep(asset, tf, 200, true)
      const fit = fitAdxPatternBias(candles, 14, PATTERN_BIAS_LOOKBACK)
      if (fit && fit.direction !== 'neutral') {
        const fitDir: 'call' | 'put' = fit.direction === 'bullish' ? 'call' : 'put'
        crossEngineAgrees = fitDir === pred.direction
        if (!crossEngineAgrees) {
          return { ok: false, reason: `held: ADX/DI + pattern bias on this pair currently reads ${fitDir.toUpperCase()}, opposing the oracle's ${pred.direction.toUpperCase()} - cross-engine confluence veto` }
        }
      }
    } catch {
      // confirmation optional - thin history or a bad read never blocks the oracle's own fire
    }
    let confluenceBoost = 1
    if (crossEngineAgrees) {
      try {
        confluenceBoost = this.ctx.use<AdxHonestyService>('adxhonesty').confluenceBoost()
      } catch {
        // learned boost optional - 1 (no change) when the honesty loop isn't loaded
      }
    }
    const conviction = tempoConviction(pred.confidence, pred.pUp) * confluenceBoost
    const w = tempoWindow(pred.targetBarTime, tfSec)
    const hist = this.historyFor(key, Date.now())
    const recentSimilarLoss = this.recentSimilarLoss(asset, tf, pred.direction, conviction, w.windowIdx)
    const pairAccuracyMult = this.pairAccuracyMult(asset, tf, pred.direction)
    const floorCoeff = this.learnedPatienceCoeff()
    const dec = tempoDecide({ conviction, barsRemaining: w.barsRemaining, windowMaxHistory: hist, recentSimilarLoss, pairAccuracyMult, floorCoeff })
    if (dec.kind !== 'fire') return { ok: false, reason: dec.reason }
    st.fired = true
    st.firedSignal = {
      direction: pred.direction,
      pUp: pred.pUp,
      confidence: pred.confidence,
      conviction,
      threshold: dec.threshold,
      price: pred.price,
      targetBarTime: pred.targetBarTime,
      ts: Date.now(),
      reason: dec.reason,
    }
    return { ok: true, reason: dec.reason, signal: st.firedSignal }
  }

  // ---------- honesty loop ----------

  private onCandleClose(asset: string, tf: string, candle: Candle): void {
    const tfSec = TIMEFRAME_SECONDS[tf as Timeframe] ?? 60
    const key = this.key(tf, asset)
    const st = this.states.get(key)
    // 1) resolve a fired shot whose target bar just closed (1-bar expiry)
    if (st?.fired && st.firedSignal && st.firedSignal.targetBarTime === candle.time) {
      const diff = candle.close - st.firedSignal.price
      const flat = Math.abs(diff) < 1e-12
      const hit = !flat && (st.firedSignal.direction === 'call' ? diff > 0 : diff < 0)
      const barTimeMs = candle.time * 1000
      const shot: ResolvedShot = {
        asset, tf,
        windowIdx: st.windowIdx,
        targetBarTime: candle.time,
        direction: st.firedSignal.direction,
        entry: st.firedSignal.price,
        exit: candle.close,
        confidence: st.firedSignal.confidence,
        conviction: st.firedSignal.conviction,
        threshold: st.firedSignal.threshold,
        barIndex: tempoWindow(barTimeMs, tfSec).barIndex,
        ts: st.firedSignal.ts,
        resolvedTs: Date.now(),
        hit,
        flat,
      }
      this.shots.push(shot)
      while (this.shots.length > MAX_SHOTS) this.shots.shift()
      this.persist()
    }
    // 2) roll the window bookkeeping forward: the bar after the closed one
    // is the next forming bar - if it starts a new epoch, archive the old
    // window's best into the patience history
    this.rollTo(key, (candle.time + tfSec) * 1000, tfSec)
  }

  private lastShot(asset: string, tf: string): TempoRow['lastShot'] {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]
      if (s.asset === asset && s.tf === tf) return { direction: s.direction, hit: s.hit, conviction: s.conviction, resolvedTs: s.resolvedTs }
    }
    return null
  }

  private shotStats(asset: string, tf: string): TempoRow['shotStats'] {
    const rows = this.shots.filter((s) => s.asset === asset && s.tf === tf && !s.flat)
    if (!rows.length) return null
    const wins = rows.filter((s) => s.hit).length
    return { n: rows.length, hitRate: wins / rows.length }
  }

  /** Lifetime ledger for panels/agents. */
  /** Lifetime ledger for panels/agents - now also surfaces per-pair
   * accuracy multipliers (pairAccuracyMult()), which were already
   * dampening live decisions with no way for a panel to show which pairs
   * are currently being dampened or why. */
  stats(): {
    totalShots: number
    hits: number
    losses: number
    hitRate: number | null
    pairAccuracy: { asset: string; tf: string; n: number; hitRate: number; mult: number; callMult: number; putMult: number }[]
    /** fleet-learned pairFloor() coefficient (see learnedPatienceCoeff()) -
     * replaces the hand-set PATIENCE_COEFF_DEFAULT (0.35) once there's
     * enough resolved history to trust one. Equal to PATIENCE_COEFF_DEFAULT
     * when still in fallback mode. */
    patienceCoeff: number
    recent: ResolvedShot[]
  } {
    const decided = this.shots.filter((s) => !s.flat)
    const wins = decided.filter((s) => s.hit).length
    const byPair = new Map<string, ResolvedShot[]>()
    for (const s of decided) {
      const k = `${s.asset}:${s.tf}`
      const arr = byPair.get(k) ?? []
      arr.push(s)
      byPair.set(k, arr)
    }
    const pairAccuracy = [...byPair.entries()]
      .map(([k, rows]) => {
        const [asset, tf] = k.split(':')
        const hits = rows.filter((r) => r.hit).length
        return {
          asset,
          tf,
          n: rows.length,
          hitRate: hits / rows.length,
          mult: this.pairAccuracyMult(asset, tf),
          callMult: this.pairAccuracyMult(asset, tf, 'call'),
          putMult: this.pairAccuracyMult(asset, tf, 'put'),
        }
      })
      .sort((a, b) => b.n - a.n)
    return {
      totalShots: this.shots.length,
      hits: wins,
      losses: decided.length - wins,
      hitRate: decided.length ? wins / decided.length : null,
      pairAccuracy,
      patienceCoeff: this.learnedPatienceCoeff(),
      recent: this.shots.slice(-20).reverse(),
    }
  }

  // ---------- persistence (same contract as nextcandle) ----------

  private dataFile(): string {
    const dir = join(process.cwd(), 'data')
    mkdirSync(dir, { recursive: true })
    return join(dir, SHOT_FILE)
  }

  private restore(): void {
    try {
      const f = this.dataFile()
      if (!existsSync(f)) return
      const raw = JSON.parse(readFileSync(f, 'utf8'))
      // threshold is new - older persisted shots won't have it. Default to
      // the shot's own conviction (threshold<=conviction is always true at
      // fire time) so learnedPatienceCoeff()'s replay treats a legacy shot
      // as "barely cleared the floor" rather than crashing on undefined.
      if (Array.isArray(raw?.shots)) this.shots = raw.shots.slice(-MAX_SHOTS).map((s: ResolvedShot) => ({ ...s, threshold: Number.isFinite(s.threshold) ? s.threshold : s.conviction }))
      this.ctx.log('tempo', `restored ${this.shots.length} resolved tempo shots from data/`)
    } catch {
      // corrupt/missing file - clean ledger, never break boot
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.dataFile(), JSON.stringify({ shots: this.shots.slice(-MAX_SHOTS) }))
    } catch {
      // best-effort - the in-memory ledger stays authoritative until next save
    }
  }
}

export const tempoPlugin: Plugin = {
  name: 'tempo',
  start: async (ctx) => {
    const svc = new TempoService()
    ctx.provide('tempo', svc)
    await svc.start(ctx)
  },
}
