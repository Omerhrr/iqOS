// Binance market data model + pure helpers (no network, no I/O): minute bars with real volume, taker delta and an
// aggressor-tagged footprint, aggregation to any timeframe, the IQ-pair -> Binance-symbol map, and the merge that
// puts Binance volume onto an IQ candle series.
//
// WHY IT EXISTS: IQ Option sends no volume for BTCUSD / ETHUSD. Binance publishes real trades for free. This is
// ANOTHER market's activity: it is merged by the minute, it is not IQ's own price, and every consumer must treat a
// missing minute as "no data", never as zero volume.
//
// No look-ahead: only CLOSED minutes are ever stored here (the feed finalises a minute when Binance says the kline
// closed), so a read at any moment never sees a forming minute.

import type { Candle } from '../types'

export interface FootRow { price: number; buy: number; sell: number }

export interface BinanceMinute {
  /** minute open, epoch seconds (same grid as IQ candle times) */
  time: number
  open: number
  high: number
  low: number
  close: number
  /** base-asset volume (e.g. BTC) */
  volume: number
  quoteVolume: number
  trades: number
  /** taker-buy base volume straight from the kline (always present, also on backfilled minutes) */
  takerBuy: number
  /** aggressor-tagged ladder from the trade stream; undefined on backfilled minutes (no trades were seen) */
  foot?: FootRow[]
  /** true when `foot` covers the whole minute (the feed was connected for all of it) */
  footComplete?: boolean
}

/** IQ pair -> Binance spot symbol. OTC pairs are deliberately absent: their quotes are broker-made, so an exchange volume says nothing about them. */
export const BINANCE_SYMBOLS: Record<string, string> = {
  BTCUSD: 'BTCUSDT',
  ETHUSD: 'ETHUSDT',
}
/** price bin of the footprint ladder, per Binance symbol (in quote units) */
export const BINANCE_BIN: Record<string, number> = { BTCUSDT: 10, ETHUSDT: 0.5 }

export function binanceSymbolFor(asset: string): string | undefined {
  return BINANCE_SYMBOLS[String(asset).toUpperCase()]
}

export const TF_SEC: Record<string, number> = { '1m': 60, '2m': 120, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 }

export type DataSourceMode = 'iq' | 'volume' | 'binance'
/** the numeric form a script's `configure data.source = n` carries */
export function modeFromNumber(n: number): DataSourceMode { return n >= 2 ? 'binance' : n >= 1 ? 'volume' : 'iq' }

export interface BinanceAgg {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
  trades: number
  buyVolume: number
  sellVolume: number
  delta: number
  /** delta / volume, -1..1 */
  deltaPct: number
  /** price of the heaviest footprint bin, undefined when no minute of the bar had a ladder */
  poc?: number
  /** share of the bar's minutes that carried an aggressor-tagged ladder (0..1); delta falls back to the kline taker split when 0 */
  footShare: number
  /** minutes found / minutes the bar spans */
  minutes: number
  expected: number
  complete: boolean
}

function binOf(price: number, step: number): number { return Math.round(price / step) * step }

/** merge ladders onto the grid `step` (a coarser timeframe uses the same step: only the minute boundaries change) */
export function mergeFoot(minutes: readonly BinanceMinute[], step: number): FootRow[] {
  const m = new Map<number, FootRow>()
  for (const mi of minutes) {
    if (!mi.foot) continue
    for (const r of mi.foot) {
      const p = binOf(r.price, step)
      const cur = m.get(p)
      if (cur) { cur.buy += r.buy; cur.sell += r.sell } else m.set(p, { price: p, buy: r.buy, sell: r.sell })
    }
  }
  return [...m.values()].sort((a, b) => a.price - b.price)
}

/** one aggregate bar over `minutes` (already the closed minutes of [t, t + tfSec)) */
export function aggregateMinutes(t: number, tfSec: number, minutes: readonly BinanceMinute[], step: number): BinanceAgg | undefined {
  if (!minutes.length) return undefined
  const sorted = [...minutes].sort((a, b) => a.time - b.time)
  let volume = 0, quote = 0, trades = 0, takerBuy = 0, hi = -Infinity, lo = Infinity, footMinutes = 0
  let footBuy = 0, footSell = 0
  for (const m of sorted) {
    volume += m.volume; quote += m.quoteVolume; trades += m.trades; takerBuy += m.takerBuy
    if (m.high > hi) hi = m.high
    if (m.low < lo) lo = m.low
    if (m.foot && m.footComplete) { footMinutes++; for (const r of m.foot) { footBuy += r.buy; footSell += r.sell } }
  }
  const useFoot = footMinutes === sorted.length
  const buy = useFoot ? footBuy : takerBuy
  const sell = useFoot ? footSell : volume - takerBuy
  const delta = buy - sell
  // POC only from minutes whose ladder is complete: a partial ladder (feed joined mid-minute) would name the wrong heaviest price
  const ladder = mergeFoot(sorted.filter((m) => m.footComplete), step)
  let poc: number | undefined
  let best = -1
  for (const r of ladder) { const v = r.buy + r.sell; if (v > best) { best = v; poc = r.price } }
  const expected = Math.max(1, Math.round(tfSec / 60))
  return {
    time: t, open: sorted[0].open, high: hi, low: lo, close: sorted[sorted.length - 1].close,
    volume, quoteVolume: quote, trades, buyVolume: buy, sellVolume: sell, delta,
    deltaPct: volume > 0 ? delta / volume : 0,
    ...(poc !== undefined ? { poc } : {}),
    footShare: footMinutes / sorted.length, minutes: sorted.length, expected, complete: sorted.length >= expected,
  }
}

/** a store of closed minutes keyed by symbol, read by time */
export interface MinuteSource {
  /** closed minutes of [fromSec, toSec) ascending */
  range(symbol: string, fromSec: number, toSec: number): BinanceMinute[]
  /** newest closed minute time (sec), 0 when none */
  lastClosed(symbol: string): number
  /** oldest minute time (sec) held, 0 when none */
  firstHeld(symbol: string): number
}

export function aggAt(src: MinuteSource, symbol: string, t: number, tfSec: number): BinanceAgg | undefined {
  return aggregateMinutes(t, tfSec, src.range(symbol, t, t + tfSec), BINANCE_BIN[symbol] ?? 1)
}

/**
 * MODE 'volume': keep IQ's candles (price, direction, settlement) and replace ONLY the volume with Binance's summed over the candle.
 * A candle whose minutes are not all held keeps volume 0 = no data (scripts skip it). Candles shorter than a minute are left alone.
 * The newest candle is returned as-is when it is still forming (its volume is the sum of the minutes closed so far).
 */
export function overlayVolume(candles: Candle[], tf: string, symbol: string, src: MinuteSource): Candle[] {
  const sec = TF_SEC[tf]
  if (!sec) return candles
  return candles.map((c) => {
    const a = aggAt(src, symbol, c.time, sec)
    return { ...c, volume: a && a.complete ? a.volume : 0 }
  })
}

/** MODE 'binance': Binance's own candles on the requested timeframe (closed minutes only, whole candles only) */
export function binanceCandles(tf: string, symbol: string, src: MinuteSource, limit: number, closedOnly: boolean, nowSec: number): Candle[] {
  const sec = TF_SEC[tf]
  if (!sec) return []
  const last = src.lastClosed(symbol)
  const first = src.firstHeld(symbol)
  if (!last || !first) return []
  const out: Candle[] = []
  // the newest candle that is fully closed ends at or before last + 60
  const newestStart = Math.floor((last + 60) / sec) * sec - sec
  const start0 = Math.ceil(first / sec) * sec
  for (let t = newestStart; t >= start0 && out.length < limit; t -= sec) {
    const a = aggAt(src, symbol, t, sec)
    if (!a || !a.complete) continue
    out.push({ time: t, open: a.open, high: a.high, low: a.low, close: a.close, volume: a.volume })
  }
  out.reverse()
  if (!closedOnly) {
    // the partial candle in progress: the minutes closed so far inside the current bucket
    const t = Math.floor(nowSec / sec) * sec
    if (t > (out.length ? out[out.length - 1].time : 0)) {
      const a = aggAt(src, symbol, t, sec)
      if (a) out.push({ time: t, open: a.open, high: a.high, low: a.low, close: a.close, volume: a.volume })
    }
  }
  return out.slice(-limit)
}

/** the bar that is still FORMING right now (live only): running totals, never stored, never used in a backtest */
export interface BinanceNow extends BinanceAgg {
  /** seconds since this bar opened */
  ageSec: number
  tfSec: number
  /** running ladder of the bar (only the minutes whose ladder is complete are in it) */
  ladder: FootRow[]
}

/**
 * Running bar of timeframe `tfSec`: the closed minutes already inside the current bucket plus the forming minute.
 * `forming` is the minute in progress (its kline running totals and its trade ladder so far). The aggregate is flagged
 * complete=false by construction (the bar has not closed) - consumers must treat every number as still moving.
 */
export function nowBar(closed: readonly BinanceMinute[], forming: BinanceMinute | undefined, tfSec: number, step: number, nowSec: number): BinanceNow | undefined {
  const start = Math.floor(nowSec / tfSec) * tfSec
  const inBucket = closed.filter((m) => m.time >= start && m.time < start + tfSec)
  const mins = forming && forming.time >= start && forming.time < start + tfSec ? [...inBucket, forming] : inBucket
  const a = aggregateMinutes(start, tfSec, mins, step)
  if (!a) return undefined
  return { ...a, complete: false, ageSec: Math.max(0, nowSec - start), tfSec, ladder: mergeFoot(mins.filter((m) => m.footComplete), step) }
}
