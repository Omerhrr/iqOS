// IQAIR//OS - Range map
//
// Which pairs actually MEAN-REVERT? Most range-fade losses come from fading a pair that is not ranging. This job walks the instrument
// universe one pair at a time (yielding to the event loop between pairs so the kernel stays responsive), backtests ONE fixed
// mean-reversion fade over each pair's archived candles, and ranks the pairs by how well the fade held up - plus where each pair is
// right now (OU half-life, z, whether the fade would fire this bar). Output is a watchlist you can hand to Meta Trader / Omni Trader.
//
// The fade (identical for every pair, nothing tuned per pair, so the comparison is fair):
//   put  when ou.ok() and 2 <= ou.halfLife() <= 20 and ou.z() >= zEntry  and rsi(14) > 60
//   call when ou.ok() and 2 <= ou.halfLife() <= 20 and ou.z() <= -zEntry and rsi(14) < 40
//
// HONESTY: descriptive and in-sample on archived history. A pair that reverted in the past can stop; a high win rate over a few
// dozen overlapping trades is noise. Rows carry the trade count, a 95% lower bound (Wilson) and the win rate of each third of the
// history so a lucky stretch shows. Nothing here is a forecast.
import type { KernelContext, Plugin } from '../kernel'
import type { Timeframe } from '../types'
import { ALL_TIMEFRAMES, TIMEFRAME_SECONDS } from '../types'
import { backtestMslScript } from '../analytics/mslbacktest'
import { readOU } from '../analytics/mslmodels'
import type { MarketDataService } from './market-data'

const MIN_BARS = 400
const MAX_PAIRS = 150
const DEFAULT_PAIRS = 40
const DEFAULT_BARS = 1500
const MIN_TRADES_TO_RANK = 20
const DEFAULT_PAYOUT = 0.85
/** expiry = round(multiple x OU half-life) bars, tried per pair (a fixed expiry is the baseline) */
export const EXPIRY_MULTIPLES = [0.5, 1, 1.5, 2]
const MAX_EXPIRY_MIN = 15

export interface RangeMapOpts {
  tf?: string
  /** explicit tickers; otherwise the open universe filtered by scope, first `limit` of them */
  assets?: string[]
  scope?: 'all' | 'real' | 'otc'
  limit?: number
  bars?: number
  expiryBars?: number
  zEntry?: number
  payout?: number
  /** also try expiry = multiple x half-life for every pair with enough trades (default true) */
  scanExpiry?: boolean
}

export interface ExpiryTry {
  /** 'fixed' = the run's expiryBars, else the half-life multiple */
  how: 'fixed' | number
  trades: number
  wins: number
  winRate: number | null
  winRateLow95: number | null
  /** median bars the trades were held */
  medianBars: number | null
}

export interface RangeMapRow {
  asset: string
  otc: boolean
  bars: number
  trades: number
  wins: number
  winRate: number | null
  /** 95% lower confidence bound of the win rate (Wilson) - what you can actually lean on */
  winRateLow95: number | null
  /** win rate of each third of the history (null when the third had fewer than 3 trades) */
  thirds: (number | null)[]
  /** every third that had 3+ trades beat breakeven */
  consistent: boolean
  /** enough trades, lower bound above breakeven, and consistent */
  holdsUp: boolean
  /** expiry comparison (pairs with enough trades): the fixed expiry vs half-life multiples, same fire signals, in-sample */
  expiryScan: { tries: ExpiryTry[]; best: ExpiryTry | null; /** best's lower bound clears breakeven with enough trades */ bestClearsBreakeven: boolean; /** half-life x best multiple, whole minutes (null without a current half-life) */ suggestedExpiryMin: number | null } | null
  /** current OU read */
  now: { halfLife: number | null; z: number; tStat: number; meanReverting: boolean; stretched: 'above' | 'below' | 'none'; fadeFiresNow: 'call' | 'put' | 'none' } | null
}

interface GroupStat {
  pairs: number
  ranked: number
  holdUp: number
  medianWinRate: number | null
  shareMeanReverting: number | null
}

export interface RangeMapState {
  status: 'idle' | 'running' | 'done' | 'error'
  startedAt: number | null
  finishedAt: number | null
  progress: { done: number; total: number; current: string | null }
  opts: { tf: string; bars: number; expiryBars: number; zEntry: number; payout: number; scope: string; assets: number; scanExpiry: boolean }
  breakeven: number
  rows: RangeMapRow[]
  /** best first among pairs with enough trades */
  ranked: RangeMapRow[]
  /** ready-to-paste watchlist: pairs that hold up, best first */
  watchlist: string[]
  groups: { real: GroupStat; otc: GroupStat } | null
  skipped: { asset: string; reason: string }[]
  note: string
  error?: string
}

export function wilsonLow(wins: number, n: number, z = 1.96): number | null {
  if (n <= 0) return null
  const p = wins / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return (c - m) / d
}
const median = (a: number[]): number | null => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function fadeScript(zEntry: number, expiryExpr?: string): string {
  const ex = expiryExpr ? [`  expiry = ${expiryExpr}`] : []
  return [
    `if ou.ok() and ou.halfLife() >= 2 and ou.halfLife() <= 20 and ou.z() >= ${zEntry} and ind.rsi(14)[-1] > 60`,
    '  put when true',
    '  confidence = 58',
    ...ex,
    `elseif ou.ok() and ou.halfLife() >= 2 and ou.halfLife() <= 20 and ou.z() <= -${zEntry} and ind.rsi(14)[-1] < 40`,
    '  call when true',
    '  confidence = 58',
    ...ex,
    'end',
  ].join('\n')
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

export class RangeMapService {
  private market!: MarketDataService
  private ctx!: KernelContext
  private state: RangeMapState = this.fresh()
  private runId = 0

  private fresh(): RangeMapState {
    return {
      status: 'idle', startedAt: null, finishedAt: null,
      progress: { done: 0, total: 0, current: null },
      opts: { tf: '1m', bars: DEFAULT_BARS, expiryBars: 3, zEntry: 1.5, payout: DEFAULT_PAYOUT, scope: 'all', assets: 0, scanExpiry: true },
      breakeven: 1 / (1 + DEFAULT_PAYOUT),
      rows: [], ranked: [], watchlist: [], groups: null, skipped: [],
      note: 'Descriptive, in-sample, archived history only. Not a forecast.',
    }
  }

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('rangemap', 'range map online (on-demand: which pairs mean-revert)')
  }
  stop(): void {
    this.runId++
  }

  status(): RangeMapState {
    return this.state
  }

  cancel(): boolean {
    if (this.state.status !== 'running') return false
    this.runId++
    this.state = { ...this.state, status: 'idle', progress: { ...this.state.progress, current: null } }
    return true
  }

  /** Start a run (returns at once; poll status()). */
  begin(o: RangeMapOpts = {}): { ok: true; total: number } | { ok: false; error: string } {
    if (this.state.status === 'running') return { ok: false, error: 'a range map run is already in progress - poll /range_map or cancel it' }
    const tf = o.tf ?? '1m'
    if (!(ALL_TIMEFRAMES as string[]).includes(tf)) return { ok: false, error: `unknown timeframe '${tf}'` }
    const bars = Math.max(MIN_BARS, Math.min(5000, Math.round(Number(o.bars) || DEFAULT_BARS)))
    const expiryBars = Math.max(1, Math.min(10, Math.round(Number(o.expiryBars) || 3)))
    const zEntry = Math.max(0.5, Math.min(4, Number(o.zEntry) || 1.5))
    const scanExpiry = o.scanExpiry !== false
    const payout = Number.isFinite(Number(o.payout)) && Number(o.payout) > 0 && Number(o.payout) <= 2 ? Number(o.payout) : DEFAULT_PAYOUT
    const scope = o.scope === 'real' || o.scope === 'otc' ? o.scope : 'all'
    const limit = Math.max(1, Math.min(MAX_PAIRS, Math.round(Number(o.limit) || DEFAULT_PAIRS)))
    const universe = this.market.listAssets().filter((a) => a.open)
    let list: { ticker: string; otc: boolean }[]
    if (Array.isArray(o.assets) && o.assets.length) {
      const want = new Set(o.assets.map((a) => String(a).trim().toUpperCase()))
      list = universe.filter((a) => want.has(a.ticker.toUpperCase())).map((a) => ({ ticker: a.ticker, otc: Boolean(a.otc) }))
    } else {
      list = universe
        .filter((a) => scope === 'all' || (scope === 'otc') === Boolean(a.otc))
        .slice(0, limit)
        .map((a) => ({ ticker: a.ticker, otc: Boolean(a.otc) }))
    }
    if (!list.length) return { ok: false, error: 'no matching open pairs to scan' }
    this.runId++
    const id = this.runId
    this.state = {
      ...this.fresh(),
      status: 'running',
      startedAt: Date.now(),
      progress: { done: 0, total: list.length, current: null },
      opts: { tf, bars, expiryBars, zEntry, payout, scope, assets: list.length, scanExpiry },
      breakeven: 1 / (1 + payout),
    }
    void this.run(id, list, tf as Timeframe, bars, expiryBars, zEntry, payout, scanExpiry).catch((err) => {
      if (id !== this.runId) return
      this.state = { ...this.state, status: 'error', finishedAt: Date.now(), error: err instanceof Error ? err.message : String(err) }
      this.ctx.log('rangemap', `run failed: ${this.state.error}`)
    })
    return { ok: true, total: list.length }
  }

  private async run(id: number, list: { ticker: string; otc: boolean }[], tf: Timeframe, bars: number, expiryBars: number, zEntry: number, payout: number, scanExpiry: boolean): Promise<void> {
    const script = fadeScript(zEntry)
    const breakeven = 1 / (1 + payout)
    const rows: RangeMapRow[] = []
    const skipped: { asset: string; reason: string }[] = []
    for (let i = 0; i < list.length; i++) {
      if (id !== this.runId) return
      const { ticker, otc } = list[i]
      this.state.progress = { done: i, total: list.length, current: ticker }
      await tick()
      try {
        const candles = this.market.getCandlesDeep(ticker, tf, bars, true)
        if (!candles || candles.length < MIN_BARS) {
          skipped.push({ asset: ticker, reason: `only ${candles?.length ?? 0} closed bars (need ${MIN_BARS})` })
          continue
        }
        const res = backtestMslScript(candles, script, { expiryBars, warmupBars: 130, runId: `rangemap:${id}:${ticker}` })
        if (!res.ok) {
          skipped.push({ asset: ticker, reason: res.error ?? 'backtest failed' })
          continue
        }
        const trades = res.trades
        const span = candles.length
        const third = (lo: number, hi: number) => {
          const t = trades.filter((x) => x.index >= lo && x.index < hi)
          return t.length >= 3 ? t.filter((x) => x.win).length / t.length : null
        }
        const thirds = [third(0, span / 3), third(span / 3, (2 * span) / 3), third((2 * span) / 3, span + 1)]
        const wins = res.wins
        const wr = trades.length ? wins / trades.length : null
        const low = wilsonLow(wins, trades.length)
        const consistent = thirds.every((w) => w === null || w >= breakeven) && thirds.some((w) => w !== null)
        const holdsUp = trades.length >= MIN_TRADES_TO_RANK && low !== null && low > breakeven && consistent
        let expiryScan: RangeMapRow['expiryScan'] = null
        if (scanExpiry && trades.length >= MIN_TRADES_TO_RANK) {
          const barSeconds = TIMEFRAME_SECONDS[tf]
          const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null)
          const tries: ExpiryTry[] = [{ how: 'fixed', trades: trades.length, wins, winRate: wr, winRateLow95: low, medianBars: expiryBars }]
          for (const m of EXPIRY_MULTIPLES) {
            await tick()
            if (id !== this.runId) return
            const r2 = backtestMslScript(candles, fadeScript(zEntry, `max(1, min(${MAX_EXPIRY_MIN}, round(${m} * ou.halfLife())))`), {
              expiryBars, warmupBars: 130, runId: `rangemap:${id}:${ticker}:x${m}`, scriptExpiry: { barSeconds, maxBars: MAX_EXPIRY_MIN },
            })
            if (!r2.ok) continue
            tries.push({ how: m, trades: r2.trades.length, wins: r2.wins, winRate: r2.trades.length ? r2.wins / r2.trades.length : null, winRateLow95: wilsonLow(r2.wins, r2.trades.length), medianBars: med(r2.trades.map((x) => x.expiryBars ?? expiryBars)) })
          }
          const eligible = tries.filter((t) => t.trades >= MIN_TRADES_TO_RANK)
          const best = eligible.length ? eligible.reduce((a, b) => ((b.winRateLow95 ?? -1) > (a.winRateLow95 ?? -1) ? b : a)) : null
          expiryScan = { tries, best, bestClearsBreakeven: best !== null && best.winRateLow95 !== null && best.winRateLow95 > breakeven, suggestedExpiryMin: null }
        }
        let now: RangeMapRow['now'] = null
        try {
          const ou = readOU(candles)
          if (ou) {
            const hl = Number.isFinite(ou.halfLife) && ou.halfLife < 9999 ? ou.halfLife : null
            const inBand = hl !== null && hl >= 2 && hl <= 20
            now = {
              halfLife: hl, z: ou.z, tStat: ou.tStat, meanReverting: ou.meanReverting,
              stretched: ou.z >= zEntry ? 'above' : ou.z <= -zEntry ? 'below' : 'none',
              fadeFiresNow: inBand && ou.z >= zEntry ? 'put' : inBand && ou.z <= -zEntry ? 'call' : 'none',
            }
          }
        } catch {
          now = null
        }
        if (expiryScan && expiryScan.best && typeof expiryScan.best.how === 'number' && now?.halfLife) {
          expiryScan.suggestedExpiryMin = Math.max(1, Math.min(MAX_EXPIRY_MIN, Math.round(expiryScan.best.how * now.halfLife * (TIMEFRAME_SECONDS[tf] / 60))))
        } else if (expiryScan && expiryScan.best && expiryScan.best.how === 'fixed') {
          expiryScan.suggestedExpiryMin = Math.max(1, Math.round((expiryBars * TIMEFRAME_SECONDS[tf]) / 60))
        }
        rows.push({ asset: ticker, otc, bars: span, trades: trades.length, wins, winRate: wr, winRateLow95: low, thirds, consistent, holdsUp, expiryScan, now })
      } catch (err) {
        skipped.push({ asset: ticker, reason: err instanceof Error ? err.message : String(err) })
      }
    }
    if (id !== this.runId) return
    const ranked = rows
      .filter((r) => r.trades >= MIN_TRADES_TO_RANK)
      .sort((a, b) => (b.winRateLow95 ?? -1) - (a.winRateLow95 ?? -1) || b.trades - a.trades)
    const grp = (rs: RangeMapRow[]): GroupStat => {
      const rk = rs.filter((r) => r.trades >= MIN_TRADES_TO_RANK)
      const withNow = rs.filter((r) => r.now)
      return {
        pairs: rs.length,
        ranked: rk.length,
        holdUp: rk.filter((r) => r.holdsUp).length,
        medianWinRate: median(rk.map((r) => r.winRate ?? 0)),
        shareMeanReverting: withNow.length ? withNow.filter((r) => r.now!.meanReverting).length / withNow.length : null,
      }
    }
    this.state = {
      ...this.state,
      status: 'done',
      finishedAt: Date.now(),
      progress: { done: list.length, total: list.length, current: null },
      rows,
      ranked,
      watchlist: ranked.filter((r) => r.holdsUp).map((r) => r.asset),
      groups: { real: grp(rows.filter((r) => !r.otc)), otc: grp(rows.filter((r) => r.otc)) },
      skipped,
      note:
        `Same fade on every pair (z >= ${zEntry}, half-life 2-20 bars, RSI confirm, ${expiryBars}-bar expiry), in-sample on archived ${tf} bars. ` +
        `"holdsUp" = at least ${MIN_TRADES_TO_RANK} trades, 95% lower bound above breakeven (${(breakeven * 100).toFixed(1)}% at ${(payout * 100).toFixed(0)}% payout) and every third of the history that had 3+ trades above breakeven. ` +
        'Where scanned, expiryScan compares the fixed expiry with expiry = multiple x half-life on the SAME fires; picking the best of five is itself in-sample, so its lower bound is optimistic. Overlapping trades overstate independence; a past reversion tendency can stop. Descriptive, not a forecast.',
    }
    this.ctx.log('rangemap', `done: ${rows.length} pairs scored, ${this.state.watchlist.length} hold up, ${skipped.length} skipped`)
  }
}

export const rangeMapPlugin: Plugin = {
  name: 'rangemap',
  start: async (ctx) => {
    const svc = new RangeMapService()
    ctx.provide('rangemap', svc)
    await svc.start(ctx)
  },
}
