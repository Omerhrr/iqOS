// IQAIR//OS - Smart Money Concepts / ICT structure scanner
//
// Finds the market-structure concepts the user asked for - Fair Value Gap,
// Order Block, Liquidity Sweep, Break of Structure, CHoCH, IFVG, Breaker
// Block, OTE, KRM, Supply & Demand, Support & Resistance, Breakout, CRT,
// Power of 3, Silver Bullet - on ONE instrument's own candles, feeding both
// a STANDALONE panel (SmcPanel.tsx / /smc_scan) and, per direct
// instruction, driver #10 of the next-candle Oracle's fusion
// (nextcandle.ts, via smcSummaryScore() below - a single-number digest
// shaped like every other driver input it already fuses).
//
// That wiring happened AHEAD of this session's usual "validate before
// wire" rule (a new driver normally earns its weight slot only after being
// measured against real resolved outcomes, same as cointegration/vol-arb/
// chart-signals/lead-lag) - done anyway because the user asked for it
// directly, with a deliberately low starting weight so the Oracle's own
// learned-multiplier cascade can correct it. The honesty loop has since
// been added retroactively (analytics/smcoutcomes.ts / plugins/smcscan.ts
// / /smc_stats), so that starting weight is no longer a permanent guess -
// once enough resolved outcomes accrue, /smc_stats is what tells you
// whether it should move.
//
// Two of the fifteen names need an explicit admission rather than a quiet
// guess:
// - KRM is not a term with one universally agreed ICT definition the way
//   FVG/OB/BOS are. This implements it as a classic one-bar "Key Reversal
//   Mark": a new N-bar high (or low) that closes back beyond the PRIOR
//   candle's midpoint in the opposite direction - a textbook reversal bar.
//   If a different, specific meaning was intended, say so and this gets
//   redefined.
// - Silver Bullet is genuinely session-time-anchored in ICT practice (the
//   AM kill zone is ~10-11am New York time). This kernel has no DST-aware
//   timezone conversion anywhere (session.ts's own classifySession() is
//   itself a coarse UTC-hour bucket, not NY-local), so the window below is
//   a FIXED UTC-hour approximation of 10-11am EST (standard time, UTC-5)
//   that silently drifts an hour off during US daylight saving - flagged
//   in the signal's own note, not hidden.
import type { Candle } from '../types'
import { closes, highs, lows, atr, donchian } from './indicators'

export type SmcDirection = 'bullish' | 'bearish'

export type SmcKind =
  | 'FVG'
  | 'IFVG'
  | 'ORDER_BLOCK'
  | 'BREAKER_BLOCK'
  | 'LIQUIDITY_SWEEP'
  | 'BOS'
  | 'CHOCH'
  | 'OTE'
  | 'KRM'
  | 'SUPPLY_DEMAND'
  | 'SUPPORT_RESISTANCE'
  | 'BREAKOUT'
  | 'CRT'
  | 'POWER_OF_3'
  | 'SILVER_BULLET'

export interface SmcSignal {
  kind: SmcKind
  direction: SmcDirection
  /** zone top/bottom (FVG, OB, breaker, S&D, S&R band) - absent for
   * point-events (BOS/CHoCH/sweep/KRM/breakout/CRT/Po3/Silver Bullet),
   * which carry `level` instead. */
  top?: number
  bottom?: number
  level?: number
  index: number // candle index (into the scanned window) when formed/triggered
  barsAgo: number
  /** still live: a zone not yet fully mitigated/violated, or a point-event
   * recent enough to matter (kind-specific recency windows below). */
  active: boolean
  touches?: number // S&R only
  note: string
}

export interface SmcScanResult {
  price: number
  ts: number
  /** current structure trend from the BOS/CHoCH walk - 'range' when no
   * swing break has happened yet in the scanned window. */
  trend: SmcDirection | 'range'
  signals: SmcSignal[]
  summary: {
    direction: 'call' | 'put' | 'none'
    confidence: number // 0..100
    bullish: number
    bearish: number
  }
}

const isn = Number.isFinite

// ---------- shared primitive: fractal swing points ----------

export interface SwingPoint {
  index: number
  price: number
  type: 'high' | 'low'
}

/** Classic N-left/N-right fractal swings. A swing is only "confirmed" (safe
 * to trade structure off of) once `right` bars have closed past it - every
 * consumer below respects that via confirmedAt = index + right. */
function swings(h: number[], l: number[], left = 2, right = 2): SwingPoint[] {
  const out: SwingPoint[] = []
  for (let i = left; i < h.length - right; i++) {
    let isHigh = true
    let isLow = true
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue
      if (h[j] >= h[i]) isHigh = false
      if (l[j] <= l[i]) isLow = false
    }
    if (isHigh) out.push({ index: i, price: h[i], type: 'high' })
    if (isLow) out.push({ index: i, price: l[i], type: 'low' })
  }
  return out
}

// ---------- structure: BOS / CHoCH ----------

interface StructureEvent {
  index: number
  type: 'BOS' | 'CHOCH'
  direction: SmcDirection
  level: number
}

/** Walks the candles once, always comparing against the MOST RECENT
 * confirmed swing of each type (the standard ICT convention - older swings
 * stop mattering the moment a fresher one confirms). A break against the
 * prevailing trend (or before any trend is established) is a CHoCH and
 * flips the trend; a break WITH the prevailing trend is a BOS (continuation).
 * Each level only fires once - it's marked "broken" so a close that stays
 * beyond it for the next 50 bars doesn't re-fire BOS/CHoCH every single bar. */
function detectStructure(candles: Candle[], sw: SwingPoint[], right: number): { trend: SmcDirection | null; events: StructureEvent[] } {
  const highsSw = sw.filter((s) => s.type === 'high').sort((a, b) => a.index - b.index)
  const lowsSw = sw.filter((s) => s.type === 'low').sort((a, b) => a.index - b.index)
  let hi = 0
  let lo = 0
  let curHigh: SwingPoint | null = null
  let curLow: SwingPoint | null = null
  let curHighBroken = false
  let curLowBroken = false
  let trend: SmcDirection | null = null
  const events: StructureEvent[] = []
  const c = closes(candles)
  for (let i = 0; i < candles.length; i++) {
    while (hi < highsSw.length && highsSw[hi].index + right <= i) {
      curHigh = highsSw[hi]
      curHighBroken = false
      hi++
    }
    while (lo < lowsSw.length && lowsSw[lo].index + right <= i) {
      curLow = lowsSw[lo]
      curLowBroken = false
      lo++
    }
    if (curHigh && !curHighBroken && c[i] > curHigh.price) {
      curHighBroken = true
      if (trend === 'bearish' || trend === null) {
        events.push({ index: i, type: 'CHOCH', direction: 'bullish', level: curHigh.price })
        trend = 'bullish'
      } else {
        events.push({ index: i, type: 'BOS', direction: 'bullish', level: curHigh.price })
      }
    }
    if (curLow && !curLowBroken && c[i] < curLow.price) {
      curLowBroken = true
      if (trend === 'bullish' || trend === null) {
        events.push({ index: i, type: 'CHOCH', direction: 'bearish', level: curLow.price })
        trend = 'bearish'
      } else {
        events.push({ index: i, type: 'BOS', direction: 'bearish', level: curLow.price })
      }
    }
  }
  return { trend, events }
}

// ---------- Fair Value Gap + Inverse FVG ----------

interface FvgZone {
  index: number // the MIDDLE of the 3-candle pattern - the gap itself
  top: number
  bottom: number
  direction: SmcDirection
  mitigatedPct: number
  filled: boolean
}

/** Classic 3-candle imbalance: candle[i-2]'s high/low leaves a gap to
 * candle[i]'s low/high that candle[i-1]'s body never touches. */
function detectFvgs(candles: Candle[]): FvgZone[] {
  const out: FvgZone[] = []
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2]
    const c = candles[i]
    if (c.low > a.high) out.push({ index: i - 1, top: c.low, bottom: a.high, direction: 'bullish', mitigatedPct: 0, filled: false })
    if (c.high < a.low) out.push({ index: i - 1, top: a.low, bottom: c.high, direction: 'bearish', mitigatedPct: 0, filled: false })
  }
  for (const z of out) {
    const span = z.top - z.bottom || 1
    for (let j = z.index + 2; j < candles.length; j++) {
      const k = candles[j]
      const into = Math.max(0, Math.min(k.high, z.top) - Math.max(k.low, z.bottom))
      z.mitigatedPct = Math.max(z.mitigatedPct, Math.min(1, into / span))
      if (z.direction === 'bullish' ? k.close < z.bottom : k.close > z.top) z.filled = true
    }
  }
  return out
}

/** A FVG that gets fully closed through (not just wicked into) flips
 * polarity - the gap that was support/resistance on the way up/down now
 * acts as the opposite on a retest. */
function detectInverseFvgs(fvgs: FvgZone[]): FvgZone[] {
  return fvgs
    .filter((z) => z.filled)
    .map((z) => ({ ...z, direction: (z.direction === 'bullish' ? 'bearish' : 'bullish') as SmcDirection }))
}

// ---------- Order Block + Breaker Block ----------

interface ObZone {
  index: number
  top: number
  bottom: number
  direction: SmcDirection
  violated: boolean
  violatedAt: number | null
}

/** The last opposite-colored candle immediately before a range-expansion
 * impulse that closes beyond it - the textbook "last down candle before the
 * rally" / "last up candle before the drop". impulseAtrMult gates how big
 * that impulse candle's own range must be vs its own ATR to count as a real
 * impulse, not noise. */
function detectOrderBlocks(candles: Candle[], atrArr: number[], impulseAtrMult = 1.4): ObZone[] {
  const out: ObZone[] = []
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]
    const cur = candles[i]
    const a = atrArr[i]
    if (!isn(a) || a <= 0) continue
    const curRange = cur.high - cur.low
    if (curRange < impulseAtrMult * a) continue
    if (prev.close < prev.open && cur.close > cur.open && cur.close > prev.high) {
      out.push({ index: i - 1, top: prev.high, bottom: prev.low, direction: 'bullish', violated: false, violatedAt: null })
    }
    if (prev.close > prev.open && cur.close < cur.open && cur.close < prev.low) {
      out.push({ index: i - 1, top: prev.high, bottom: prev.low, direction: 'bearish', violated: false, violatedAt: null })
    }
  }
  for (const ob of out) {
    for (let j = ob.index + 2; j < candles.length; j++) {
      const k = candles[j]
      if (ob.direction === 'bullish' ? k.close < ob.bottom : k.close > ob.top) {
        ob.violated = true
        ob.violatedAt = j
        break
      }
    }
  }
  return out
}

/** A violated order block flips role: the zone that was demand/supply and
 * failed now acts as the opposite on a retest ("breaker"). */
function detectBreakers(obs: ObZone[]): ObZone[] {
  return obs
    .filter((o) => o.violated)
    .map((o) => ({ ...o, direction: (o.direction === 'bullish' ? 'bearish' : 'bullish') as SmcDirection }))
}

// ---------- Liquidity Sweep ----------

interface SweepEvent {
  index: number
  direction: SmcDirection
  level: number
}

/** A wick trades beyond the nearest prior confirmed swing high/low (taking
 * the resting liquidity sitting just past it) and closes back inside - the
 * stop-hunt pattern. Direction is named for what it sets up NEXT (a sweep
 * of the high is bearish - the move that follows a failed breakout). */
function detectLiquiditySweeps(candles: Candle[], sw: SwingPoint[]): SweepEvent[] {
  const out: SweepEvent[] = []
  const highsSw = sw.filter((s) => s.type === 'high').sort((a, b) => a.index - b.index)
  const lowsSw = sw.filter((s) => s.type === 'low').sort((a, b) => a.index - b.index)
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i]
    const priorHigh = [...highsSw].reverse().find((s) => s.index < i - 1)
    const priorLow = [...lowsSw].reverse().find((s) => s.index < i - 1)
    if (priorHigh && k.high > priorHigh.price && k.close < priorHigh.price) {
      out.push({ index: i, direction: 'bearish', level: priorHigh.price })
    }
    if (priorLow && k.low < priorLow.price && k.close > priorLow.price) {
      out.push({ index: i, direction: 'bullish', level: priorLow.price })
    }
  }
  return out
}

// ---------- Optimal Trade Entry (OTE) ----------

interface OteZone {
  index: number
  top: number
  bottom: number
  direction: SmcDirection
  active: boolean
}

/** Fib 61.8%-79% retracement zone of the most recent impulse leg (the leg
 * between the two latest opposite-type confirmed swings). An upward leg
 * (low -> high) gives a bullish OTE - buyers look to enter the pullback at
 * a discount expecting continuation; a downward leg mirrors it. */
function detectOte(sw: SwingPoint[], lastClose: number): OteZone | null {
  const sorted = [...sw].sort((a, b) => a.index - b.index)
  if (sorted.length < 2) return null
  const last = sorted[sorted.length - 1]
  const prev = [...sorted].reverse().find((s) => s.type !== last.type && s.index < last.index)
  if (!prev) return null
  const legHigh = Math.max(last.price, prev.price)
  const legLow = Math.min(last.price, prev.price)
  const diff = legHigh - legLow
  if (diff <= 0) return null
  let top: number
  let bottom: number
  let direction: SmcDirection
  if (last.type === 'high') {
    direction = 'bullish'
    top = legHigh - diff * 0.618
    bottom = legHigh - diff * 0.79
  } else {
    direction = 'bearish'
    bottom = legLow + diff * 0.618
    top = legLow + diff * 0.79
  }
  return { index: last.index, top: Math.max(top, bottom), bottom: Math.min(top, bottom), direction, active: lastClose <= Math.max(top, bottom) && lastClose >= Math.min(top, bottom) }
}

// ---------- KRM (Key Reversal Mark - see module header) ----------

interface KrmEvent {
  index: number
  direction: SmcDirection
}

function detectKrm(candles: Candle[], lookback = 10): KrmEvent[] {
  const out: KrmEvent[] = []
  for (let i = lookback; i < candles.length; i++) {
    const window = candles.slice(i - lookback, i)
    const hh = Math.max(...window.map((c) => c.high))
    const ll = Math.min(...window.map((c) => c.low))
    const k = candles[i]
    const prev = candles[i - 1]
    const prevMid = (prev.open + prev.close) / 2
    if (k.high > hh && k.close < prev.close && k.close < prevMid) out.push({ index: i, direction: 'bearish' })
    else if (k.low < ll && k.close > prev.close && k.close > prevMid) out.push({ index: i, direction: 'bullish' })
  }
  return out
}

// ---------- Supply & Demand zones ----------

interface SdZone {
  index: number
  top: number
  bottom: number
  direction: SmcDirection
}

/** A tight-range "base" (<=1.2x ATR) immediately followed by 3 consecutive
 * same-direction expansion candles that net-move >=1.5x ATR - a broader,
 * multi-candle cousin of the single-candle order block. */
function detectSupplyDemand(candles: Candle[], atrArr: number[]): SdZone[] {
  const out: SdZone[] = []
  for (let i = 4; i < candles.length - 3; i++) {
    const base = candles.slice(i - 3, i + 1)
    const baseHigh = Math.max(...base.map((c) => c.high))
    const baseLow = Math.min(...base.map((c) => c.low))
    const a = atrArr[i]
    if (!isn(a) || a <= 0) continue
    if (baseHigh - baseLow > a * 1.2) continue
    const next3 = candles.slice(i + 1, i + 4)
    if (next3.length < 3) continue
    const allUp = next3.every((c) => c.close > c.open)
    const allDown = next3.every((c) => c.close < c.open)
    const moved = next3[next3.length - 1].close - candles[i].close
    if (allUp && moved > a * 1.5) out.push({ index: i, top: baseHigh, bottom: baseLow, direction: 'bullish' })
    else if (allDown && moved < -a * 1.5) out.push({ index: i, top: baseHigh, bottom: baseLow, direction: 'bearish' })
  }
  return out
}

// ---------- Support & Resistance ----------

interface SrLevel {
  price: number
  touches: number
  direction: SmcDirection // 'bullish' tag = support, 'bearish' tag = resistance (consistent with every other zone's direction field)
}

/** Clusters confirmed swing highs/lows within a tight price-% tolerance -
 * the classic "price keeps reacting at the same level" horizontal zone. */
function detectSR(sw: SwingPoint[], tolerancePct = 0.1): SrLevel[] {
  const clusters: SrLevel[] = []
  for (const s of sw) {
    const direction: SmcDirection = s.type === 'high' ? 'bearish' : 'bullish'
    const existing = clusters.find((c) => c.direction === direction && Math.abs(c.price - s.price) / (s.price || 1) * 100 <= tolerancePct)
    if (existing) {
      existing.touches++
      existing.price = (existing.price + s.price) / 2
    } else {
      clusters.push({ price: s.price, touches: 1, direction })
    }
  }
  return clusters.filter((c) => c.touches >= 2).sort((a, b) => b.touches - a.touches)
}

// ---------- Breakout ----------

interface BreakoutEvent {
  index: number
  direction: SmcDirection
  level: number
}

/** Close beyond the PRIOR bar's 20-bar Donchian channel - a clean range
 * breakout (compares against yesterday's channel, not today's, so the
 * breakout bar isn't comparing itself to a channel it just redrew). */
function detectBreakout(candles: Candle[], don: { upper: number[]; lower: number[] }): BreakoutEvent | null {
  const n = candles.length - 1
  if (n < 1) return null
  const prevUpper = don.upper[n - 1]
  const prevLower = don.lower[n - 1]
  const k = candles[n]
  if (isn(prevUpper) && k.close > prevUpper) return { index: n, direction: 'bullish', level: prevUpper }
  if (isn(prevLower) && k.close < prevLower) return { index: n, direction: 'bearish', level: prevLower }
  return null
}

// ---------- CRT (Candle Range Theory) ----------

interface CrtEvent {
  index: number
  direction: SmcDirection
  rangeHigh: number
  rangeLow: number
}

/** ICT's 3-candle unit on the MOST RECENT triplet: candle 1 sets a range,
 * candle 2 ("manipulation") wicks beyond exactly one side of it, candle 3
 * ("distribution") closes back inside and beyond the OTHER side - true
 * reversal confirmation, not just a wick. */
function detectCrt(candles: Candle[]): CrtEvent | null {
  const n = candles.length
  if (n < 3) return null
  const a = candles[n - 3]
  const m = candles[n - 2]
  const d = candles[n - 1]
  const sweptHigh = m.high > a.high
  const sweptLow = m.low < a.low
  if (sweptHigh && !sweptLow && d.close < a.high && d.close < m.close) {
    return { index: n - 1, direction: 'bearish', rangeHigh: a.high, rangeLow: a.low }
  }
  if (sweptLow && !sweptHigh && d.close > a.low && d.close > m.close) {
    return { index: n - 1, direction: 'bullish', rangeHigh: a.high, rangeLow: a.low }
  }
  return null
}

// ---------- Power of 3 (Accumulation / Manipulation / Distribution) ----------

interface Po3Result {
  index: number
  direction: SmcDirection
  accumHigh: number
  accumLow: number
}

/** Simplified, bar-count proxy for AMD (the real ICT model is anchored to
 * session boundaries, e.g. one day = accumulation in Asia, manipulation at
 * London open, distribution in NY - this kernel has no session-anchored
 * candle grouping, so it instead splits the trailing `window` bars into
 * three equal thirds and asks the same structural question: was the first
 * third tight (accumulation), did the second third sweep beyond it
 * (manipulation), and did the third third confirm the opposite direction
 * from the sweep (distribution)). */
function detectPowerOf3(candles: Candle[], atrArr: number[], window = 24): Po3Result | null {
  if (candles.length < window) return null
  const seg = candles.slice(-window)
  const third = Math.floor(window / 3)
  const accum = seg.slice(0, third)
  const manip = seg.slice(third, third * 2)
  const dist = seg.slice(third * 2)
  if (!accum.length || !manip.length || !dist.length) return null
  const aHigh = Math.max(...accum.map((c) => c.high))
  const aLow = Math.min(...accum.map((c) => c.low))
  const atrv = atrArr[atrArr.length - 1]
  if (!isn(atrv) || atrv <= 0) return null
  if (aHigh - aLow > atrv * 1.5) return null // accumulation wasn't tight enough
  const sweptHigh = Math.max(...manip.map((c) => c.high)) > aHigh
  const sweptLow = Math.min(...manip.map((c) => c.low)) < aLow
  const distMove = dist[dist.length - 1].close - dist[0].open
  if (sweptHigh && !sweptLow && distMove < 0) return { index: candles.length - 1, direction: 'bearish', accumHigh: aHigh, accumLow: aLow }
  if (sweptLow && !sweptHigh && distMove > 0) return { index: candles.length - 1, direction: 'bullish', accumHigh: aHigh, accumLow: aLow }
  return null
}

// ---------- Silver Bullet ----------

interface SilverBulletResult {
  direction: SmcDirection
  top: number
  bottom: number
}

/** AM kill-zone proxy (see module header for the DST caveat): a liquidity
 * sweep followed within a handful of bars by an FVG in the SAME direction,
 * both inside the UTC-hour window that approximates 10-11am EST. */
function detectSilverBullet(candles: Candle[], fvgs: FvgZone[], sweeps: SweepEvent[]): SilverBulletResult | null {
  const last = candles[candles.length - 1]
  const hourUtc = new Date(last.time * 1000).getUTCHours()
  if (hourUtc !== 15) return null // ~10-11am EST, standard time only - see header
  const n = candles.length
  const recentFvg = fvgs.filter((f) => f.index >= n - 6).sort((a, b) => b.index - a.index)[0]
  const recentSweep = sweeps.filter((s) => s.index >= n - 8).sort((a, b) => b.index - a.index)[0]
  if (!recentFvg || !recentSweep || recentFvg.direction !== recentSweep.direction) return null
  return { direction: recentFvg.direction, top: recentFvg.top, bottom: recentFvg.bottom }
}

// ---------- top-level scan ----------

const MIN_CANDLES = 60
/** zones/events older than this are dropped entirely - keeps the payload a
 * readable "what matters right now" list instead of every FVG since boot. */
const MAX_AGE_BARS = 80

export function scanSmc(candles: Candle[]): SmcScanResult | null {
  if (candles.length < MIN_CANDLES) return null
  const h = highs(candles)
  const l = lows(candles)
  const c = closes(candles)
  const atrArr = atr(h, l, c, 14)
  const sw = swings(h, l, 2, 2)
  const n = candles.length
  const price = c[n - 1]
  const barsAgo = (idx: number) => n - 1 - idx

  const { trend, events } = detectStructure(candles, sw, 2)
  const fvgs = detectFvgs(candles)
  const ifvgs = detectInverseFvgs(fvgs)
  const obs = detectOrderBlocks(candles, atrArr)
  const breakers = detectBreakers(obs)
  const sweeps = detectLiquiditySweeps(candles, sw)
  const ote = detectOte(sw, price)
  const krms = detectKrm(candles)
  const sd = detectSupplyDemand(candles, atrArr)
  const sr = detectSR(sw)
  const don = donchian(h, l, 20)
  const breakout = detectBreakout(candles, don)
  const crt = detectCrt(candles)
  const po3 = detectPowerOf3(candles, atrArr)
  const silverBullet = detectSilverBullet(candles, fvgs, sweeps)

  const signals: SmcSignal[] = []

  for (const z of fvgs) {
    if (barsAgo(z.index) > MAX_AGE_BARS) continue
    signals.push({
      kind: 'FVG', direction: z.direction, top: z.top, bottom: z.bottom, index: z.index, barsAgo: barsAgo(z.index),
      active: !z.filled,
      note: z.filled ? `filled - see IFVG` : `${z.direction} imbalance, ${Math.round(z.mitigatedPct * 100)}% mitigated`,
    })
  }
  for (const z of ifvgs) {
    if (barsAgo(z.index) > MAX_AGE_BARS) continue
    signals.push({
      kind: 'IFVG', direction: z.direction, top: z.top, bottom: z.bottom, index: z.index, barsAgo: barsAgo(z.index), active: true,
      note: `FVG fully closed through - flipped to a ${z.direction} level on retest`,
    })
  }
  for (const o of obs) {
    if (barsAgo(o.index) > MAX_AGE_BARS) continue
    signals.push({
      kind: 'ORDER_BLOCK', direction: o.direction, top: o.top, bottom: o.bottom, index: o.index, barsAgo: barsAgo(o.index),
      active: !o.violated,
      note: o.violated ? 'violated - see Breaker Block' : `last opposite candle before the impulse`,
    })
  }
  for (const b of breakers) {
    if (barsAgo(b.index) > MAX_AGE_BARS) continue
    signals.push({
      kind: 'BREAKER_BLOCK', direction: b.direction, top: b.top, bottom: b.bottom, index: b.index, barsAgo: barsAgo(b.index), active: true,
      note: `failed order block - now expected to act as ${b.direction} on retest`,
    })
  }
  for (const s of sweeps.slice(-6)) {
    signals.push({
      kind: 'LIQUIDITY_SWEEP', direction: s.direction, level: s.level, index: s.index, barsAgo: barsAgo(s.index), active: barsAgo(s.index) <= 10,
      note: `swept resting liquidity at ${s.level.toFixed(5)} and closed back through - stop hunt`,
    })
  }
  for (const e of events.slice(-10)) {
    signals.push({
      kind: e.type === 'BOS' ? 'BOS' : 'CHOCH', direction: e.direction, level: e.level, index: e.index, barsAgo: barsAgo(e.index), active: barsAgo(e.index) <= 15,
      note: e.type === 'BOS' ? `continuation break of structure (${e.direction})` : `change of character - structure flipped ${e.direction}`,
    })
  }
  if (ote) {
    signals.push({
      kind: 'OTE', direction: ote.direction, top: ote.top, bottom: ote.bottom, index: ote.index, barsAgo: barsAgo(ote.index), active: ote.active,
      note: ote.active ? `price is IN the 61.8-79% discount/premium zone of the latest impulse leg` : `61.8-79% retracement zone of the latest impulse leg - price hasn't reached it yet`,
    })
  }
  for (const k of krms.slice(-3)) {
    signals.push({
      kind: 'KRM', direction: k.direction, index: k.index, barsAgo: barsAgo(k.index), active: barsAgo(k.index) <= 10,
      note: `key reversal bar - new local extreme, closed back through the prior candle's midpoint`,
    })
  }
  for (const z of sd.filter((z) => barsAgo(z.index) <= MAX_AGE_BARS)) {
    signals.push({
      kind: 'SUPPLY_DEMAND', direction: z.direction, top: z.top, bottom: z.bottom, index: z.index, barsAgo: barsAgo(z.index), active: true,
      note: `tight base before a ${z.direction} expansion move - broader cousin of the order block`,
    })
  }
  for (const lvl of sr.slice(0, 8)) {
    signals.push({
      kind: 'SUPPORT_RESISTANCE', direction: lvl.direction, level: lvl.price, index: n - 1, barsAgo: 0, active: true, touches: lvl.touches,
      note: `${lvl.direction === 'bullish' ? 'support' : 'resistance'} - ${lvl.touches} swing touches clustered here`,
    })
  }
  if (breakout) {
    signals.push({
      kind: 'BREAKOUT', direction: breakout.direction, level: breakout.level, index: breakout.index, barsAgo: barsAgo(breakout.index), active: barsAgo(breakout.index) <= 3,
      note: `close beyond the prior 20-bar range (${breakout.direction})`,
    })
  }
  if (crt) {
    signals.push({
      kind: 'CRT', direction: crt.direction, index: crt.index, barsAgo: barsAgo(crt.index), active: barsAgo(crt.index) <= 3,
      note: `candle-range theory: manipulation swept the range, distribution confirmed ${crt.direction}`,
    })
  }
  if (po3) {
    signals.push({
      kind: 'POWER_OF_3', direction: po3.direction, top: po3.accumHigh, bottom: po3.accumLow, index: po3.index, barsAgo: barsAgo(po3.index), active: true,
      note: `accumulation/manipulation/distribution over the trailing window confirms ${po3.direction} (bar-count proxy, not session-anchored - see module header)`,
    })
  }
  if (silverBullet) {
    signals.push({
      kind: 'SILVER_BULLET', direction: silverBullet.direction, top: silverBullet.top, bottom: silverBullet.bottom, index: n - 1, barsAgo: 0, active: true,
      note: `AM kill-zone window (UTC-hour approx of 10-11am EST, no DST adjustment) + same-direction sweep and FVG`,
    })
  }

  const active = signals.filter((s) => s.active)
  const bullish = active.filter((s) => s.direction === 'bullish').length
  const bearish = active.filter((s) => s.direction === 'bearish').length
  const total = bullish + bearish
  const direction: 'call' | 'put' | 'none' = total === 0 ? 'none' : bullish > bearish ? 'call' : bearish > bullish ? 'put' : 'none'
  const confidence = total === 0 ? 0 : Math.round((Math.max(bullish, bearish) / total) * 100)

  return {
    price,
    ts: candles[n - 1].time,
    trend: trend ?? 'range',
    signals: signals.sort((a, b) => a.barsAgo - b.barsAgo),
    summary: { direction, confidence, bullish, bearish },
  }
}

/** Single-number digest shaped like every other Oracle driver input
 * (nextcandle.ts fuses log-odds-weighted -1..1 scores) - NOT currently
 * read by the Oracle (see module header). Exists so wiring this in later,
 * once real resolved outcomes validate it, is a one-line addition instead
 * of a new interface. */
export function smcSummaryScore(result: SmcScanResult | null): number {
  if (!result || result.summary.direction === 'none') return 0
  const sign = result.summary.direction === 'call' ? 1 : -1
  return sign * (result.summary.confidence / 100)
}
