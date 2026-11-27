// IQAIR//OS - IQ Option tick bars (pure): per-bar tick activity, up/down-tick delta and a price ladder built from IQ's own quote changes.
//
// IQ Option sends QUOTES, not traded size, so there is no real volume here. What IS measurable for any pair, from the changes of IQ's price:
//   ticks      how many times the quote changed inside the bar (activity)
//   up / down  quote changes up vs down (the tick rule: an up-change is read as buying pressure, a down-change as selling pressure)
//   delta      up - down (counts), deltaPct = delta / ticks
//   upMove/downMove  total distance travelled up and down
//   ladder     tick counts per price level (up and down separately); POC = the level with the most ticks
// None of it is traded volume. Time stamps are the recording host's clock (the sidecar samples IQ's stream every 100 ms and keeps price changes only,
// so bursts faster than 100 ms are coalesced). A bar is `complete` only when the collector was already watching the whole bar and lost no samples in it.
import type { TickPoint } from './otcfootprint'

export interface IqLadderRow { price: number; up: number; down: number }
export interface IqTickBar {
  time: number           // bar open, epoch seconds
  open: number
  high: number
  low: number
  close: number
  ticks: number
  up: number
  down: number
  delta: number
  deltaPct: number
  upMove: number
  downMove: number
  poc?: number
  complete: boolean
  ladder: IqLadderRow[]
}
export interface IqNowBar extends IqTickBar { ageSec: number; tfSec: number }
export interface IqCoverage { from: number; losses: { from: number; to: number }[] }

export const IQ_TF_SEC: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 }

/** a round ladder step: about `rows` levels across the typical 1 minute range */
export function ladderStepFor(ticks: TickPoint[], rows = 12): number {
  const ranges: number[] = []
  let lo = Infinity, hi = -Infinity, cur = -1
  for (let i = Math.max(0, ticks.length - 6000); i < ticks.length; i++) {
    const m = Math.floor(ticks[i].ts / 60000)
    if (m !== cur) { if (cur >= 0 && hi > lo) ranges.push(hi - lo); cur = m; lo = Infinity; hi = -Infinity }
    if (ticks[i].price < lo) lo = ticks[i].price
    if (ticks[i].price > hi) hi = ticks[i].price
  }
  if (hi > lo) ranges.push(hi - lo) // the minute still being built counts too (a short history would otherwise have no range at all)
  if (!ranges.length) return ticks.length ? Math.max(1e-9, ticks[ticks.length - 1].price * 1e-5) : 1
  ranges.sort((a, b) => a - b)
  const raw = Math.max(1e-12, ranges[ranges.length >> 1] / rows)
  const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p
}

const round = (x: number, step: number): number => {
  const d = Math.max(0, Math.ceil(-Math.log10(step)) + 2)
  return Number((Math.round(x / step) * step).toFixed(d))
}

function overlapsLoss(startMs: number, endMs: number, cov: IqCoverage): boolean {
  return cov.losses.some((l) => l.from < endMs && l.to > startMs)
}

/** closed bars (oldest first, at most n) plus the forming bar. Ticks must be in time order. */
export function buildIqBars(ticks: TickPoint[], tfSec: number, cov: IqCoverage, nowMs: number, n = 30, step = ladderStepFor(ticks)): { bars: IqTickBar[]; forming: IqNowBar | null; step: number } {
  if (!ticks.length) return { bars: [], forming: null, step }
  const tfMs = tfSec * 1000
  const nowBucket = Math.floor(nowMs / tfMs) * tfMs
  const firstBucket = Math.floor(ticks[0].ts / tfMs) * tfMs
  const from = Math.max(firstBucket, nowBucket - (n + 1) * tfMs)
  const byBucket = new Map<number, TickPoint[]>()
  let prevPrice: number | undefined
  const prevOf = new Map<number, number | undefined>()
  for (const t of ticks) {
    const b = Math.floor(t.ts / tfMs) * tfMs
    if (b < from) { prevPrice = t.price; continue }
    let arr = byBucket.get(b)
    if (!arr) { arr = []; byBucket.set(b, arr); prevOf.set(b, prevPrice) }
    arr.push(t)
    prevPrice = t.price
  }
  const make = (b: number): IqTickBar | null => {
    const arr = byBucket.get(b)
    if (!arr || !arr.length) return null
    let up = 0, down = 0, upMove = 0, downMove = 0
    let hi = -Infinity, lo = Infinity
    const lad = new Map<number, IqLadderRow>()
    let last = prevOf.get(b)
    for (const t of arr) {
      if (t.price > hi) hi = t.price
      if (t.price < lo) lo = t.price
      if (last !== undefined && t.price !== last) {
        const isUp = t.price > last, mv = Math.abs(t.price - last)
        if (isUp) { up++; upMove += mv } else { down++; downMove += mv }
        const lv = round(t.price, step)
        let r = lad.get(lv)
        if (!r) { r = { price: lv, up: 0, down: 0 }; lad.set(lv, r) }
        if (isUp) r.up++; else r.down++
      }
      last = t.price
    }
    const ticks = up + down
    const ladder = [...lad.values()].sort((a, c) => a.price - c.price)
    let poc: number | undefined, best = -1
    for (const r of ladder) if (r.up + r.down > best) { best = r.up + r.down; poc = r.price }
    const complete = b + 5000 >= cov.from && !overlapsLoss(b, b + tfMs, cov)
    return { time: b / 1000, open: arr[0].price, high: hi, low: lo, close: arr[arr.length - 1].price, ticks, up, down, delta: up - down, deltaPct: ticks ? (up - down) / ticks : 0, upMove, downMove, poc, complete, ladder }
  }
  const bars: IqTickBar[] = []
  for (let b = from; b < nowBucket; b += tfMs) { const x = make(b); if (x) bars.push(x) }
  const f = make(nowBucket)
  return { bars: bars.slice(-n), forming: f ? { ...f, ageSec: Math.max(0, Math.round((nowMs - nowBucket) / 1000)), tfSec } : null, step }
}
