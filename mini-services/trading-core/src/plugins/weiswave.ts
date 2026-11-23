// IQAIR//OS - Weis Wave service: per-pair `read(asset)` for the Weis Wave panel and a TTL-cached whole-universe `globalScan()` for Weis Wave Global.
// Wraps analytics/weiswave.ts (readWeisWave) over the in-memory candles, by default INCLUDING the bar still forming (live=1) so the running wave moves with price; live=0 reads closed bars only (getCandles, NOT getCandlesDeep: the deep read hits the sqlite archive synchronously and a whole-universe board must never block the kernel loop).
// The CALL / PUT per pair is the strength-weighted vote of its timeframes: each live rung with a call/put read contributes +/- its strength, the board shows net score, how many rungs agree and the best rung.
// HONEST: this is where effort and result disagree, not a calibrated win probability.
import type { KernelContext, Plugin } from '../kernel'
import type { Timeframe } from '../types'
import { readWeisWave, WW_MIN_BARS, type WwMode } from '../analytics/weiswave'
import type { MarketDataService } from './market-data'

export const WW_TFS: Timeframe[] = ['30s', '1m', '2m', '5m', '15m']
const TTL_MS = 4_000 // short: the read includes the FORMING bar by default, so it moves with price
const BARS = 320
const MIN_NET = 25 // |net score| needed to name a side

export interface WwRung {
  tf: string; ok: boolean; note: string
  direction: 'call' | 'put' | 'none'; strength: number; reason: string
  waveDir: 1 | -1 | 0; waveBars: number; waveVol: number; waveMoveAtr: number
  volRatio: number | null; effortRatio: number | null; prevVol: number
  weak: boolean; strong: boolean; absorption: boolean; shortening: boolean; hot: boolean; newExtreme: boolean
  volumeOk: boolean; waves: number
}
export interface WwRow {
  asset: string; price: number; computedTs: number; ok: boolean; note: string
  mode: WwMode; thr: number
  direction: 'call' | 'put' | 'none'
  /** strength-weighted mean of the rung votes (-100..+100; + = call) */
  net: number
  agree: number; live: number
  best: { tf: string; direction: 'call' | 'put'; strength: number } | null
  volumeOk: boolean
  rungs: WwRung[]
}
export interface WwGlobalResult { scannedTs: number; universe: number; live: number; warming: number; calls: number; puts: number; mode: WwMode; thr: number; rows: WwRow[] }

const nn = (x: number): number | null => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null)

export class WeisWaveService {
  private ctx!: KernelContext
  private market!: MarketDataService
  private cache = new Map<string, { row: WwRow; ts: number }>()

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('weiswave', `weis wave online (${WW_TFS.join('/')}, atr or close-to-close cut)`)
  }
  stop(): void { /* stateless reads */ }

  read(asset: string, opts: { mode?: WwMode; thr?: number; tfs?: Timeframe[]; refresh?: boolean; priceHint?: number; live?: boolean } = {}): WwRow {
    const live = opts.live !== false
    const mode: WwMode = opts.mode === 'close' ? 'close' : 'atr'
    const thr = opts.thr !== undefined && opts.thr > 0 ? Math.min(opts.thr, 6) : 1
    const tfs = opts.tfs && opts.tfs.length ? opts.tfs : WW_TFS
    const key = `${asset}|${mode}|${thr}|${tfs.join(',')}|${live ? 'live' : 'closed'}`
    const hit = this.cache.get(key)
    if (!opts.refresh && hit && Date.now() - hit.ts < TTL_MS) return hit.row
    const rungs: WwRung[] = []
    let price = opts.priceHint ?? 0
    for (const tf of tfs) {
      let candles: ReturnType<MarketDataService['getCandles']> = []
      try { candles = this.market.getCandles(asset, tf, BARS, !live) ?? [] } catch { candles = [] }
      if (candles.length) price = candles[candles.length - 1].close
      const r = candles.length >= WW_MIN_BARS ? readWeisWave(candles, { mode, thr }) : null
      if (!r) {
        rungs.push({ tf, ok: false, note: candles.length < WW_MIN_BARS ? `warming up (${candles.length}/${WW_MIN_BARS} bars)` : 'too few waves yet', direction: 'none', strength: 0, reason: '', waveDir: 0, waveBars: 0, waveVol: 0, waveMoveAtr: 0, volRatio: null, effortRatio: null, prevVol: 0, weak: false, strong: false, absorption: false, shortening: false, hot: false, newExtreme: false, volumeOk: false, waves: 0 })
        continue
      }
      rungs.push({ tf, ok: true, note: '', direction: r.direction, strength: r.strength, reason: r.reason, waveDir: r.cur.dir, waveBars: r.cur.bars, waveVol: Math.round(r.cur.volume * 100) / 100, waveMoveAtr: nn(r.cur.moveAtr) ?? 0, volRatio: nn(r.volRatio), effortRatio: nn(r.effortRatio), prevVol: r.prevSame ? Math.round(r.prevSame.volume * 100) / 100 : 0, weak: r.weak, strong: r.strong, absorption: r.absorption, shortening: r.shortening, hot: r.hot, newExtreme: r.newExtreme, volumeOk: r.volumeOk, waves: r.count })
    }
    const liveRungs = rungs.filter((x) => x.ok)
    const votes = liveRungs.map((x) => (x.direction === 'call' ? x.strength : x.direction === 'put' ? -x.strength : 0))
    const net = liveRungs.length ? Math.round(votes.reduce((s, v) => s + v, 0) / liveRungs.length) : 0
    const direction: WwRow['direction'] = net >= MIN_NET ? 'call' : net <= -MIN_NET ? 'put' : 'none'
    const agree = direction === 'none' ? 0 : liveRungs.filter((x) => x.direction === direction).length
    const bestRung = [...liveRungs].filter((x) => x.direction !== 'none').sort((a, b) => b.strength - a.strength)[0]
    const row: WwRow = {
      asset, price, computedTs: Date.now(), ok: liveRungs.length > 0,
      note: liveRungs.length ? '' : 'warming up', mode, thr, direction, net, agree, live: liveRungs.length,
      best: bestRung ? { tf: bestRung.tf, direction: bestRung.direction as 'call' | 'put', strength: bestRung.strength } : null,
      volumeOk: liveRungs.some((x) => x.volumeOk), rungs,
    }
    this.cache.set(key, { row, ts: row.computedTs })
    if (this.cache.size > 600) for (const [k] of [...this.cache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 150)) this.cache.delete(k)
    return row
  }

  globalScan(opts: { mode?: WwMode; thr?: number; tfs?: Timeframe[]; category?: string; limit?: number; refresh?: boolean; live?: boolean } = {}): WwGlobalResult {
    const category = opts.category && opts.category !== 'all' ? opts.category : null
    const universe = this.market.listAssets().filter((a) => a.open && this.market.isOptionInstrument(a.ticker) && (!category || a.category === category))
    const limit = opts.limit !== undefined ? Math.max(1, Math.min(Math.round(opts.limit), 500)) : universe.length
    const rows = universe.slice(0, limit).map((a) => this.read(a.ticker, { mode: opts.mode, thr: opts.thr, tfs: opts.tfs, refresh: opts.refresh, live: opts.live, priceHint: a.price ?? 0 }))
    const live = rows.filter((r) => r.ok)
    // actionable first: named side by |net| then agreement, then undecided by |net|, warming last
    live.sort((x, y) => (Number(y.direction !== 'none') - Number(x.direction !== 'none')) || Math.abs(y.net) - Math.abs(x.net) || y.agree - x.agree)
    const warming = rows.filter((r) => !r.ok).sort((a, b) => a.asset.localeCompare(b.asset))
    return {
      scannedTs: Date.now(), universe: universe.length, live: live.length, warming: warming.length,
      calls: live.filter((r) => r.direction === 'call').length, puts: live.filter((r) => r.direction === 'put').length,
      mode: opts.mode === 'close' ? 'close' : 'atr', thr: opts.thr && opts.thr > 0 ? opts.thr : 1, rows: [...live, ...warming],
    }
  }
}

export const weisWavePlugin: Plugin = {
  name: 'weiswave',
  start: async (ctx) => {
    const svc = new WeisWaveService()
    ctx.provide('weiswave', svc)
    await svc.start(ctx)
  },
}
