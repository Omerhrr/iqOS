// IQAIR//OS - Explainer plugin
//
// The market-data half of the Explainer tab: for ONE pair on ONE timeframe it
// reads the five existing engines (SMC scan, candlestick patterns, MRC
// predictor, swing structure, technical votes) and hands the results to
// analytics/explainer.ts, which turns them into verdicts + reasons + an
// agreement count. Closed candles only. Nothing here decides anything the
// engines did not already decide.
//
// The response also carries the last CHART_BARS closed candles and the swing
// points inside them so the tab can draw its small swing chart without a
// second fetch.

import type { KernelContext, Plugin } from '../kernel'
import type { Candle, Timeframe } from '../types'
import { ALL_TIMEFRAMES, TIMEFRAME_SECONDS } from '../types'
import { detectPatterns } from '../analytics/patterns'
import { computeSwing } from '../analytics/swing'
import { summarizeTf, TECH_BARS_PER_RUNG } from '../analytics/technicals'
import {
  explainMrc,
  explainPatterns,
  explainSmc,
  explainSwing,
  explainTechnical,
  summarizeVerdicts,
  type ExplainerSummary,
  type PanelVerdict,
} from '../analytics/explainer'
import type { MarketDataService } from './market-data'
import type { SmcScanService } from './smcscan'
import type { MrcPredictService } from './mrcpredict'

/** Closed bars fetched for the read - enough for SMC (60+), swings and the 260-bar technical window. */
const READ_BARS = 400
/** Candles (and the swings inside them) sent back for the small swing chart. */
const CHART_BARS = 90
const SWING_LOOKBACK = 3
const PATTERN_LOOKBACK = 8

export interface ExplainerChart {
  candles: { time: number; open: number; high: number; low: number; close: number }[]
  swings: { time: number; price: number; kind: 'high' | 'low' }[]
  structure: 'hh-hl' | 'lh-ll' | 'none'
  direction: 1 | -1 | 0
  lookback: number
}

export interface ExplainerRead {
  ok: true
  asset: string
  tf: Timeframe
  ts: number
  price: number
  /** closed candles the read was built from */
  bars: number
  panels: PanelVerdict[]
  summary: ExplainerSummary
  chart: ExplainerChart
}

export type ExplainerResult = ExplainerRead | { ok: false; error: string }

export class ExplainerService {
  private ctx!: KernelContext
  private market!: MarketDataService

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx
    this.market = ctx.use<MarketDataService>('market')
    ctx.log('explainer', 'Explainer online (SMC / candle pattern / MRC / swing / technical, one pair + tf at a time)')
  }

  stop(): void { /* stateless reads - nothing to flush */ }

  read(asset: string, tf: string): ExplainerResult {
    if (!(ALL_TIMEFRAMES as string[]).includes(tf)) return { ok: false, error: `unknown timeframe '${tf}'` }
    const t = tf as Timeframe
    const candles: Candle[] = this.market.getCandlesDeep(asset, t, READ_BARS, true)
    if (!candles || candles.length === 0) return { ok: false, error: 'not in the tracked universe' }
    const last = candles[candles.length - 1]
    const price = this.market.getPrice(asset) || last.close

    const smc = this.ctx.use<SmcScanService>('smcScan').scan(asset, t).result
    const hits = candles.length >= 12 ? detectPatterns(candles.slice(-60), PATTERN_LOOKBACK) : []
    const mrc = this.ctx.use<MrcPredictService>('mrcpredict').readFor(asset, t)
    const swing = computeSwing(candles.slice(-250), { lookback: SWING_LOOKBACK })
    const techRow = summarizeTf(t, TIMEFRAME_SECONDS[t], 'native', candles.slice(-TECH_BARS_PER_RUNG))

    const panels: PanelVerdict[] = [
      explainSmc(smc),
      explainPatterns(hits, PATTERN_LOOKBACK),
      explainMrc(mrc),
      explainSwing(swing, last.close),
      explainTechnical(techRow),
    ]

    const tail = candles.slice(-CHART_BARS)
    const t0 = tail[0].time
    return {
      ok: true,
      asset,
      tf: t,
      ts: Date.now(),
      price,
      bars: candles.length,
      panels,
      summary: summarizeVerdicts(panels),
      chart: {
        candles: tail.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
        swings: swing.swings.filter((s) => s.time >= t0).map((s) => ({ time: s.time, price: s.price, kind: s.kind })),
        structure: swing.structure,
        direction: swing.direction,
        lookback: swing.lookback,
      },
    }
  }
}

export const explainerPlugin: Plugin = {
  name: 'explainer',
  start: async (ctx) => {
    const svc = new ExplainerService()
    ctx.provide('explainer', svc)
    await svc.start(ctx)
  },
}
