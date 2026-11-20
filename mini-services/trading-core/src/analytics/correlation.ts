// IQAIR//OS - correlation + scan-rotation helpers shared by the auto-traders (Omni, Meta, Auto).
//
// CORRELATION by EXPOSURE, not by a fixed list. A trade is a bet on currencies: a CALL on EURUSD is long EUR / short USD, a PUT on USDJPY is short USD / long JPY. Two open trades are one bet when
// they carry the SAME-SIGN exposure to any factor: call EURUSD + call GBPUSD (both short USD), call EURUSD + put USDJPY (both short USD), call AUDUSD + call NZDUSD (short USD, long commodity-bloc).
// Opposite-sign exposure is a spread, not a duplicate, so it is allowed (call EURUSD + put GBPUSD). Metals share one factor (METALS), crypto shares one (CRYPTO); their USD quote leg is NOT counted, so gold
// and bitcoin do not block each other or the FX book. Symbols with no known structure (stocks, indices) carry no factor and never conflict.
// This is a structural proxy for "moves together", not a measured correlation coefficient: it catches the obvious double-ups and says which factor caused the block.

const CUR = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF'])
const METALS = new Set(['XAU', 'XAG', 'XPT', 'XPD'])
const CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'DOGE', 'LTC', 'BCH', 'DOT', 'AVAX', 'LINK', 'TRX', 'XLM', 'ETC', 'ATOM', 'NEO', 'UNI'])
export const bareSymbol = (asset: string) => asset.toUpperCase().replace(/[-_ ]?OTC$/, '').replace(/[^A-Z0-9]/g, '')

/** the signed factors a position carries: +1 long the factor, -1 short it */
export function exposure(asset: string, side: 'call' | 'put' | string): Map<string, number> {
  const out = new Map<string, number>(), s = side === 'put' ? -1 : 1, a = bareSymbol(asset)
  if (a.length === 6 && CUR.has(a.slice(0, 3)) && CUR.has(a.slice(3))) { out.set(a.slice(0, 3), s); out.set(a.slice(3), -s); return out }
  const base = a.endsWith('USD') ? a.slice(0, -3) : a
  if (METALS.has(base)) out.set('METALS', s)
  else if (CRYPTO.has(base)) out.set('CRYPTO', s)
  return out
}

export interface OpenLeg { asset: string; side: string }
/** the first open position the candidate duplicates, with the shared factor(s); null when it is a genuinely different bet */
export function correlatedWith(asset: string, side: string, open: readonly OpenLeg[]): { asset: string; side: string; factors: string[] } | null {
  const mine = exposure(asset, side); if (!mine.size) return null
  for (const o of open) {
    if (bareSymbol(o.asset) === bareSymbol(asset)) continue // the same pair is handled by each trader's own per-asset rules
    const theirs = exposure(o.asset, o.side), shared: string[] = []
    for (const [f, sg] of mine) if (theirs.get(f) === sg) shared.push(`${sg > 0 ? 'long' : 'short'} ${f}`)
    if (shared.length) return { asset: o.asset, side: o.side, factors: shared }
  }
  return null
}

/** direction-unknown version (the auto trader picks the pair before the side): two pairs are related when they share a non-USD currency, both are metals, both are crypto, or both put USD on the same side */
export function relatedAssets(a: string, b: string): boolean {
  const A = bareSymbol(a), B = bareSymbol(b); if (A === B) return false
  const ea = exposure(A, 'call'), eb = exposure(B, 'call'); if (!ea.size || !eb.size) return false
  for (const [f, sa] of ea) { const sb = eb.get(f); if (sb === undefined) continue; if (f === 'USD' ? sa === sb : true) return true }
  return false
}

/** Visits a long asset list in SHUFFLED windows so every open instrument gets looked at, with no positional bias. `current()` is stable within a tick (call it as often as you like); `advance()` once per tick. */
export class ScanRotation {
  private order: string[] = []
  private pos = 0
  constructor(private rnd: () => number = Math.random) {}
  private shuffle(a: string[]): string[] { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(this.rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]] } return x }
  private sync(list: readonly string[]): void {
    const set = new Set(list)
    const kept = this.order.filter((x) => set.has(x)), have = new Set(kept), fresh = list.filter((x) => !have.has(x))
    if (kept.length !== this.order.length || fresh.length) { this.order = [...kept, ...this.shuffle(fresh)]; if (this.pos > this.order.length) this.pos = 0 }
  }
  current(list: readonly string[], size: number): string[] {
    if (list.length <= size) return [...list]
    this.sync(list)
    return Array.from({ length: size }, (_, i) => this.order[(this.pos + i) % this.order.length])
  }
  /** the whole list in this rotation's shuffled order (stable until reshuffle()) - for sources that stop at the first qualifying pair, so the winner is not always the same liquid major */
  ordered(list: readonly string[]): string[] { this.sync(list); return this.order.filter((x) => list.includes(x)) }
  reshuffle(): void { this.order = this.shuffle(this.order); this.pos = 0 }
  advance(list: readonly string[], size: number): void {
    if (list.length <= size) { this.pos = 0; return }
    this.sync(list)
    this.pos += size
    if (this.pos >= this.order.length) { this.order = this.shuffle(this.order); this.pos = 0 } // a full lap: reshuffle so the next lap visits in a different order
  }
}
