// IQAIR//OS - Signal plugin (the clock)
//
// read(asset, tf): the Signal core (analytics/signalcore.ts: the five Explainer readers + Effort Renko + the pair's regime, from closed candles alone)
//   -> analytics/signalclock.ts buildSignal() -> BUY / SELL / WAIT, needle,
//   holding period. Closed candles only.
// best(tf, current?): shortlists pairs from the Regime scan (the best trending
//   up/down pairs and any pair sitting at a range edge), runs the full signal on
//   each, and returns the strongest actionable one. `current` gives hysteresis:
//   the pair you are on is kept unless another beats it by SWITCH_MARGIN needle
//   points, or it stopped being actionable while another still is - so the tab
//   does not flip pairs every refresh.

import type { KernelContext, Plugin } from '../kernel'
import type { Candle, Timeframe } from '../types'
import { ALL_TIMEFRAMES, TIMEFRAME_SECONDS } from '../types'
import type { SignalResult } from '../analytics/signalclock'
import { readSignalCore, SIGNAL_BARS, SIGNAL_MIN_BARS } from '../analytics/signalcore'
import type { RegimeScanService, RegimeBoardRow } from './regimescan'
import type { MarketDataService } from './market-data'

const CANDLE_BARS = SIGNAL_BARS
const READ_TTL_MS = 8_000
const BEST_TTL_MS = 8_000
const GLOBAL_TTL_MS = 8_000
const GLOBAL_LIMIT_DEFAULT = 40
const GLOBAL_LIMIT_MAX = 80
const MAX_TREND_PER_SIDE = 6
const MAX_RANGE = 4
/** another pair must beat the current one by this many needle points to take over */
export const SWITCH_MARGIN = 15

export interface SignalRead {
  ok: true
  asset: string
  tf: Timeframe
  ts: number
  price: number
  signal: SignalResult
}

export interface SignalCandidate {
  asset: string
  action: SignalResult['action']
  needle: number
  strength: number
  regime: SignalResult['regime']
  setup: string
  expiryLabel: string | null
}

export interface SignalGlobalRow {
  asset: string
  otc: boolean
  ok: boolean
  error?: string
  action: SignalResult['action']
  needle: number
  strength: number
  regime: SignalResult['regime']
  setup: string
  expiryLabel: string | null
  price: number
  ts: number
}
export interface SignalGlobal {
  ok: true
  tf: Timeframe
  ts: number
  universe: number
  scanned: number
  buys: number
  sells: number
  waits: number
  warming: number
  rows: SignalGlobalRow[]
}

export interface SignalBest {
  ok: true
  tf: Timeframe
  ts: number
  /** pairs evaluated this scan */
  evaluated: number
  /** the pick: strongest actionable pair, or the closest-to-actionable one when none qualify */
  pick: SignalRead | null
  /** true when nothing is actionable and `pick` is only the strongest lean among WAITs */
  pickIsWait: boolean
  /** true when the pair passed in `current` was kept (hysteresis) */
  keptCurrent: boolean
  leaderboard: SignalCandidate[]
}

export class SignalService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private readCache = new Map<string, { ts: number; read: SignalRead | { ok: false; error: string } }>()
  private bestCache = new Map<string, { ts: number; list: SignalRead[]; evaluated: number }>()
  private globalCache = new Map<string, { ts: number; out: SignalGlobal }>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('signal', 'Signal clock online (Explainer + regime -> buy / sell / wait, auto best-pair pick)')
  }

  stop(): void {
    this.readCache.clear()
    this.bestCache.clear()
    this.globalCache.clear()
  }

  read(asset: string, tf: string, opts: { refresh?: boolean } = {}): SignalRead | { ok: false; error: string } {
    if (!(ALL_TIMEFRAMES as string[]).includes(tf)) return { ok: false, error: `unknown timeframe '${tf}'` }
    const key = `${asset}:${tf}`
    const hit = this.readCache.get(key)
    const now = Date.now()
    if (!opts.refresh && hit && now - hit.ts < READ_TTL_MS) return hit.read
    const out = this.compute(asset, tf as Timeframe)
    this.readCache.set(key, { ts: now, read: out })
    if (this.readCache.size > 600) for (const [k, v] of [...this.readCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 200)) this.readCache.delete(k)
    return out
  }

  /** The pure Signal core on the pair's closed candles - the exact function the MSL
   * `signal.*` namespace and the MSL backtester call, so the dial, a live script and
   * a replay agree for the same bars. */
  private compute(asset: string, tf: Timeframe): SignalRead | { ok: false; error: string } {
    try {
      const candles: Candle[] = this.market.getCandlesDeep(asset, tf, CANDLE_BARS, true) ?? []
      if (!candles.length) return { ok: false, error: 'not in the tracked universe' }
      const core = readSignalCore(candles, { tfSec: TIMEFRAME_SECONDS[tf] })
      if (!core) return { ok: false, error: `not enough closed ${tf} candles yet (${candles.length} of ${SIGNAL_MIN_BARS} needed)` }
      const last = candles[candles.length - 1]
      const price = this.market.getPrice(asset) || last.close
      return { ok: true, asset, tf, ts: Date.now(), price, signal: core.signal }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  }

  private shortlist(tf: Timeframe, category?: string): string[] {
    const board = this.ctx.use<RegimeScanService>('regimescan').global({ tf, category: category ?? 'all' })
    if (!board.ok) return []
    const atEdge = (r: RegimeBoardRow) => r.position <= 0.2 || r.position >= 0.8
    return [
      ...board.up.slice(0, MAX_TREND_PER_SIDE),
      ...board.down.slice(0, MAX_TREND_PER_SIDE),
      ...board.ranging.filter(atEdge).slice(0, MAX_RANGE),
    ].map((r) => r.asset)
  }

  /** The Signal clock on EVERY open pair (not just the Regime shortlist `best()` looks at): one row per pair, actionable first then by strength. Rows reuse `read()`'s TTL cache, so the per-asset
   * Signal tab and this board share the same computation; the whole board is cached for GLOBAL_TTL_MS. `scope` filters real/OTC BEFORE the limit so OTC pairs are never crowded out. */
  global(tf: string, opts: { limit?: number; scope?: 'all' | 'real' | 'otc'; refresh?: boolean } = {}): SignalGlobal | { ok: false; error: string } {
    if (!(ALL_TIMEFRAMES as string[]).includes(tf)) return { ok: false, error: `unknown timeframe '${tf}'` }
    const t = tf as Timeframe
    const limit = Math.max(1, Math.min(Math.round(opts.limit ?? GLOBAL_LIMIT_DEFAULT), GLOBAL_LIMIT_MAX))
    const scope = opts.scope ?? 'all'
    const ck = `${t}:${scope}:${limit}`
    const now = Date.now()
    const hit = this.globalCache.get(ck)
    if (!opts.refresh && hit && now - hit.ts < GLOBAL_TTL_MS) return hit.out
    const universe = this.market.listAssets().filter((a) => a.open && (scope === 'all' || (scope === 'otc') === Boolean(a.otc)))
    const rows: SignalGlobalRow[] = []
    let warming = 0
    for (const a of universe.slice(0, limit)) {
      const r = this.read(a.ticker, t)
      if (!r.ok) {
        warming++
        continue
      }
      rows.push({
        asset: a.ticker, otc: Boolean(a.otc), ok: true, action: r.signal.action, needle: r.signal.needle, strength: r.signal.strength, regime: r.signal.regime,
        setup: r.signal.setup, expiryLabel: r.signal.expiry?.label ?? null, price: r.price, ts: r.ts,
      })
    }
    rows.sort((x, y) => Number(y.action !== 'wait') - Number(x.action !== 'wait') || y.strength - x.strength || x.asset.localeCompare(y.asset))
    const out: SignalGlobal = {
      ok: true, tf: t, ts: now, universe: universe.length, scanned: rows.length,
      buys: rows.filter((r) => r.action === 'buy').length, sells: rows.filter((r) => r.action === 'sell').length, waits: rows.filter((r) => r.action === 'wait').length, warming, rows,
    }
    this.globalCache.set(ck, { ts: now, out })
    return out
  }

  best(tf: string, opts: { current?: string; category?: string; refresh?: boolean } = {}): SignalBest | { ok: false; error: string } {
    if (!(ALL_TIMEFRAMES as string[]).includes(tf)) return { ok: false, error: `unknown timeframe '${tf}'` }
    const t = tf as Timeframe
    const now = Date.now()
    const ck = `${t}:${opts.category ?? 'all'}`
    let cached = this.bestCache.get(ck)
    if (opts.refresh || !cached || now - cached.ts >= BEST_TTL_MS) {
      const names = this.shortlist(t, opts.category)
      // the pair the operator is on is always evaluated, so it can be compared fairly
      if (opts.current && !names.includes(opts.current)) names.push(opts.current)
      const list: SignalRead[] = []
      for (const a of names) {
        const r = this.read(a, t, { refresh: true })
        if (r.ok) list.push(r)
      }
      cached = { ts: now, list, evaluated: names.length }
      this.bestCache.set(ck, cached)
    }
    const { list } = cached
    const actionable = list.filter((r) => r.signal.action !== 'wait').sort((a, b) => b.signal.strength - a.signal.strength)
    const cur = opts.current ? list.find((r) => r.asset === opts.current) ?? null : null
    let pick: SignalRead | null = null
    let keptCurrent = false
    let pickIsWait = false
    if (actionable.length) {
      const top = actionable[0]
      if (cur && cur.signal.action !== 'wait' && top.asset !== cur.asset && top.signal.strength < cur.signal.strength + SWITCH_MARGIN) {
        pick = cur
        keptCurrent = true
      } else {
        pick = top
        keptCurrent = !!cur && top.asset === cur.asset
      }
    } else {
      // nothing actionable: stay put if we are somewhere, else show the strongest lean
      pickIsWait = true
      if (cur) {
        pick = cur
        keptCurrent = true
      } else {
        pick = [...list].sort((a, b) => Math.abs(b.signal.rawNeedle) - Math.abs(a.signal.rawNeedle))[0] ?? null
      }
    }
    const leaderboard: SignalCandidate[] = [...list]
      .sort((a, b) => Number(b.signal.action !== 'wait') - Number(a.signal.action !== 'wait') || b.signal.strength - a.signal.strength || Math.abs(b.signal.rawNeedle) - Math.abs(a.signal.rawNeedle))
      .slice(0, 12)
      .map((r) => ({
        asset: r.asset,
        action: r.signal.action,
        needle: r.signal.needle,
        strength: r.signal.strength,
        regime: r.signal.regime,
        setup: r.signal.setup,
        expiryLabel: r.signal.expiry?.label ?? null,
      }))
    return { ok: true, tf: t, ts: cached.ts, evaluated: cached.evaluated, pick, pickIsWait, keptCurrent, leaderboard }
  }
}

export const signalPlugin: Plugin = {
  name: 'signal',
  start: async (ctx) => {
    const svc = new SignalService()
    ctx.provide('signal', svc)
    await svc.start(ctx)
  },
}
