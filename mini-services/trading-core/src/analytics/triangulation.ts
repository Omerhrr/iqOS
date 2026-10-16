// IQAIR//OS - Triangular arbitrage (cross-rate delta)
//
// Any three currencies A, B, C that each have a tradable FX pair between
// them (A/B, B/C, A/C) form a closed loop. In a perfectly consistent market
// the cross pair's price must equal the product of the other two legs,
// chained through the shared currency:
//
//   Synthetic A/C = (A/B) * (B/C)
//
// Because each instrument here is its own simulated/mirrored price feed
// rather than one consistently-arbitraged tape, the actual A/C pair can sit
// away from that synthetic value for a while rather than snapping back
// instantly the way it would on a real cross-venue feed - which is exactly
// the kind of persistent, measurable divergence a mean-reversion read can
// act on. `deltaPct` is how far the actual cross sits from its synthetic
// value right now; `z` is how unusual that gap is against its own recent
// history (a plain rolling z-score, not an OU fit - the basis is expected
// to oscillate around ~0, not drift to some other equilibrium).

import type { Candle } from '../types'

export const TRIANGULATION_WINDOW = 120
export const TRIANGULATION_MIN_WINDOW = 30
export const TRIANGULATION_Z_ENTRY = 1.5

export interface FxLeg {
  ticker: string
  base: string
  quote: string
}

/** Parses a vanilla 6-letter FX ticker (EURUSD, GBPJPY-OTC, ...) into its
 * base/quote 3-letter currency codes. Returns null for anything that isn't
 * a plain 2-currency FX pair (crypto/commodity/stock tickers, etc). */
export function parseFxTicker(ticker: string): FxLeg | null {
  const bare = ticker.replace(/-OTC$/, '')
  if (!/^[A-Z]{6}$/.test(bare)) return null
  return { ticker, base: bare.slice(0, 3), quote: bare.slice(3, 6) }
}

export interface TriangleCandidate {
  currencies: [string, string, string]
  /** leg A-B and B-C, each oriented so `invert` tells the caller whether to
   * use 1/price (when that ticker's own base/quote run the other way from
   * what the A->B->C chain needs) so the two legs multiply straight into a
   * synthetic A/C. */
  legAB: { ticker: string; invert: boolean }
  legBC: { ticker: string; invert: boolean }
  /** the real cross pair, oriented the same way (A-base) as the chain so
   * synthetic and actual are directly comparable without a final flip. */
  cross: { ticker: string; invert: boolean }
}

/** Finds every closed triangle among a ticker list - static/price-independent,
 * so callers can compute this once per asset-list snapshot and reuse it. */
export function findTriangles(tickers: string[]): TriangleCandidate[] {
  const legs = tickers.map(parseFxTicker).filter((x): x is FxLeg => x !== null)
  const currencies = new Set<string>()
  for (const l of legs) {
    currencies.add(l.base)
    currencies.add(l.quote)
  }
  const pairIndex = new Map<string, FxLeg>()
  for (const l of legs) {
    const key = [l.base, l.quote].sort().join('|')
    // prefer the non-OTC ticker if both exist for the same currency pair
    const existing = pairIndex.get(key)
    if (!existing || (existing.ticker.endsWith('-OTC') && !l.ticker.endsWith('-OTC'))) {
      pairIndex.set(key, l)
    }
  }
  const list = Array.from(currencies).sort()
  const out: TriangleCandidate[] = []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      for (let k = j + 1; k < list.length; k++) {
        const [a, b, c] = [list[i], list[j], list[k]]
        const ab = pairIndex.get([a, b].sort().join('|'))
        const bc = pairIndex.get([b, c].sort().join('|'))
        const ac = pairIndex.get([a, c].sort().join('|'))
        if (!ab || !bc || !ac) continue
        out.push({
          currencies: [a, b, c],
          legAB: { ticker: ab.ticker, invert: ab.base !== a },
          legBC: { ticker: bc.ticker, invert: bc.base !== b },
          cross: { ticker: ac.ticker, invert: ac.base !== a },
        })
      }
    }
  }
  return out
}

export interface TriangulationFit {
  synthetic: number
  actual: number
  deltaPct: number
  z: number
  mean: number
  stdev: number
  n: number
}

function orient(price: number, invert: boolean): number {
  return invert ? 1 / price : price
}

/** Fits the synthetic-vs-actual basis over a rolling window of
 * SAME-INDEX-aligned closes across all three legs (caller's responsibility
 * to pass closes that line up bar-for-bar). */
export function fitTriangulation(
  abCloses: number[],
  bcCloses: number[],
  acCloses: number[],
  abInvert: boolean,
  bcInvert: boolean,
  crossInvert: boolean,
  window = TRIANGULATION_WINDOW,
): TriangulationFit | null {
  const n = Math.min(abCloses.length, bcCloses.length, acCloses.length)
  const w = Math.min(window, n)
  if (w < TRIANGULATION_MIN_WINDOW) return null
  const deltas: number[] = []
  for (let i = n - w; i < n; i++) {
    const ab = orient(abCloses[i], abInvert)
    const bc = orient(bcCloses[i], bcInvert)
    const ac = orient(acCloses[i], crossInvert)
    const synth = ab * bc
    if (!(synth > 0) || !Number.isFinite(synth) || !Number.isFinite(ac)) continue
    deltas.push(((ac - synth) / synth) * 100)
  }
  if (deltas.length < TRIANGULATION_MIN_WINDOW) return null
  const mean = deltas.reduce((s, v) => s + v, 0) / deltas.length
  const variance = deltas.reduce((s, v) => s + (v - mean) ** 2, 0) / deltas.length
  const stdev = Math.sqrt(variance)
  const last = deltas[deltas.length - 1]
  const z = stdev > 1e-9 ? (last - mean) / stdev : 0
  const abLast = orient(abCloses[n - 1], abInvert)
  const bcLast = orient(bcCloses[n - 1], bcInvert)
  const acLast = orient(acCloses[n - 1], crossInvert)
  return { synthetic: abLast * bcLast, actual: acLast, deltaPct: last, z, mean, stdev, n: deltas.length }
}

/** Convenience wrapper over fitTriangulation for callers that already have
 * Candle[] per leg (closes extracted here, same-index aligned by caller). */
export function fitTriangulationFromCandles(
  abCandles: Candle[],
  bcCandles: Candle[],
  acCandles: Candle[],
  tri: TriangleCandidate,
  window = TRIANGULATION_WINDOW,
): TriangulationFit | null {
  return fitTriangulation(
    abCandles.map((c) => c.close),
    bcCandles.map((c) => c.close),
    acCandles.map((c) => c.close),
    tri.legAB.invert,
    tri.legBC.invert,
    tri.cross.invert,
    window,
  )
}
