// IQAIR//OS - Tick bar engine (kernel-side engine of record).
//
// A tick chart draws one bar per N consecutive price observations ("ticks")
// regardless of time - the classic N-tick chart. The honest question is what
// a "tick" IS in this OS:
//   - dataSource 'tick'   : the sidecar's randomness-audit capture buffer
//     (/tick_stats) - REAL broker price changes sampled by a 100ms poll
//     (coalescing upper-bounded by the poll rate; see iqair_sidecar.py).
//     LIVE mode + a sufficiently filled buffer only.
//   - dataSource 'candle' : the closes of the finest timeframe this OS
//     tracks ('5s') used as pseudo-ticks - each candle close stands for one
//     observation. This is NOT raw tick data and every consumer must label
//     it so (market.getTickSeries() established this contract for the
//     randomness audit; the tick chart reuses it verbatim).
//
// `volume` on a tick bar is the OBSERVATION COUNT (the only honest size
// signal - the capture buffer has no traded size).
//
// HONEST TIMES: a bar's `time` is the FIRST contributing observation's
// timestamp (float epoch seconds for the tick source, integer candle opens
// for the fallback - ascending by construction). `endTime` = the observation
// that closed the bar.
//
// Pure function, O(n), no look-ahead.

export interface TickPoint {
  time: number
  price: number
}

export interface TickBar {
  /** First contributing observation's timestamp. */
  time: number
  /** Observation that closed the bar. */
  endTime: number
  open: number
  high: number
  low: number
  close: number
  /** Number of observations aggregated (== per except the last bar). */
  ticks: number
}

export interface TickBarsResult {
  per: number
  perRule: string
  dataSource: 'tick' | 'candle'
  timeRule: string
  bars: TickBar[]
}

export function tickBars(
  points: TickPoint[],
  opts: { per?: number; dataSource?: 'tick' | 'candle' } = {}
): TickBarsResult {
  const dataSource = opts.dataSource ?? 'candle'
  // 10 ticks/bar: small enough to resolve micro-structure on the 1000-point
  // capture buffer, large enough that bars are not pure noise
  const per = Math.max(2, Math.min(200, Math.round(opts.per ?? 10)))
  const perRule = `explicit ${per}`

  const bars: TickBar[] = []
  let cur: TickBar | null = null
  let count = 0

  for (const p of points) {
    if (!Number.isFinite(p.price)) continue
    if (!cur) {
      cur = { time: p.time, endTime: p.time, open: p.price, high: p.price, low: p.price, close: p.price, ticks: 0 }
    }
    cur.high = Math.max(cur.high, p.price)
    cur.low = Math.min(cur.low, p.price)
    cur.close = p.price
    cur.endTime = p.time
    cur.ticks++
    count++
    if (count >= per) {
      bars.push(cur)
      cur = null
      count = 0
    }
  }
  // trailing partial bar kept (the honest "still forming" bar)
  if (cur) bars.push(cur)

  return { per, perRule, dataSource, timeRule: 'first contributing observation time', bars }
}
