// IQAIR//OS - MSL `smcx.*`: the three SMC context concepts (equal highs/lows, rejection blocks, inducement) as CANDLE-DERIVED primitives, so
// unlike the bare `smc:<KIND>` verdict sources they also work in meta_strategy_backtest (they re-read the series each bar). Pure; reads
// analytics/smc.ts scanSmc on the evaluation's own closed candles (last 300 bars).
import type { Candle } from '../types'
import { scanSmc, type SmcSignal } from './smc'
import { atr } from './indicators'

export const SMCX_MIN_BARS = 60
const WINDOW = 300

export interface SmcxRead {
  price: number
  atr: number
  /** nearest UNSWEPT equal-highs pool above price (null = none) */
  eqh: { level: number; touches: number; distAtr: number } | null
  /** nearest UNSWEPT equal-lows pool below price (null = none) */
  eql: { level: number; touches: number; distAtr: number } | null
  /** newest still-valid rejection block per direction */
  rejBull: { top: number; bottom: number; barsAgo: number; inZone: boolean } | null
  rejBear: { top: number; bottom: number; barsAgo: number; inZone: boolean } | null
  /** bars since the newest inducement take per direction (null = none inside the scan) */
  idmBull: number | null
  idmBear: number | null
  /** the DEALING RANGE between the latest confirmed major swing high and low (null = none or under 1.5 ATR wide) and where price sits in it:
   * pos 0 = at the range low (deep discount), 0.5 = equilibrium, 1 = at the range high (deep premium); not clamped (outside the range reads < 0 / > 1) */
  pd: { high: number; low: number; pos: number; spanAtr: number } | null
}

/** latest confirmed 2/2 fractal swing high and low in the window (same fractal rule as smc.ts) */
function latestSwings(c: Candle[]): { high: number | null; low: number | null } {
  let high: number | null = null
  let low: number | null = null
  for (let i = c.length - 3; i >= 2 && (high === null || low === null); i--) {
    if (high === null && c[i].high > c[i - 1].high && c[i].high > c[i - 2].high && c[i].high > c[i + 1].high && c[i].high > c[i + 2].high) high = c[i].high
    if (low === null && c[i].low < c[i - 1].low && c[i].low < c[i - 2].low && c[i].low < c[i + 1].low && c[i].low < c[i + 2].low) low = c[i].low
  }
  return { high, low }
}

export function readSmcx(all: Candle[]): SmcxRead | null {
  if (all.length < SMCX_MIN_BARS) return null
  const c = all.length > WINDOW ? all.slice(-WINDOW) : all
  const res = scanSmc(c)
  if (!res) return null
  const n = c.length
  const price = c[n - 1].close
  const a = (() => {
    const v = atr(c.map((k) => k.high), c.map((k) => k.low), c.map((k) => k.close), 14)[n - 1]
    return Number.isFinite(v) && v > 0 ? v : price * 0.001
  })()
  const newest = (kind: SmcSignal['kind'], dir: 'bullish' | 'bearish') =>
    res.signals.filter((s) => s.kind === kind && s.direction === dir).sort((x, y) => x.barsAgo - y.barsAgo)[0] ?? null
  const pool = (dir: 'bullish' | 'bearish') => {
    const s = newest('EQH_EQL', dir)
    return s && s.level !== undefined ? { level: s.level, touches: s.touches ?? 2, distAtr: Math.abs(s.level - price) / a } : null
  }
  const rej = (dir: 'bullish' | 'bearish') => {
    const s = newest('REJECTION_BLOCK', dir)
    if (!s || s.top === undefined || s.bottom === undefined) return null
    return { top: s.top, bottom: s.bottom, barsAgo: s.barsAgo, inZone: price <= s.top && price >= s.bottom }
  }
  const idm = (dir: 'bullish' | 'bearish') => newest('INDUCEMENT', dir)?.barsAgo ?? null
  const sw = latestSwings(c)
  const pd = sw.high !== null && sw.low !== null && sw.high > sw.low && (sw.high - sw.low) / a >= 1.5
    ? { high: sw.high, low: sw.low, pos: (price - sw.low) / (sw.high - sw.low), spanAtr: (sw.high - sw.low) / a }
    : null
  return { price, atr: a, pd, eqh: pool('bullish'), eql: pool('bearish'), rejBull: rej('bullish'), rejBear: rej('bearish'), idmBull: idm('bullish'), idmBear: idm('bearish') }
}
