// IQAIR//OS - Smart Money Concepts, a port of LuxAlgo's "Smart Money Concepts" indicator (CC BY-NC-SA 4.0, (c) LuxAlgo) to per-bar series for MSL's ind.lux(...).
// Ported by reading the Pine v5 source: swing structure (default leg length 50) + internal structure (leg length 5) with BOS / CHoCH, order blocks (volatility-filtered parsed highs/lows,
// mitigation by close or high/low, newest first, max 100), equal highs/lows (ATR200 threshold), fair value gaps (auto threshold), strong/weak high & low, premium/discount/equilibrium zones
// and previous day/week/month highs & lows. Closed bars only; every bar is processed in the script's own order (trailing extremes, structure legs, internal structure, swing structure, order-block
// mitigation, fair value gaps). Not ported: the drawing code, the higher-timeframe FVG (a different timeframe is requested with ind.lux's trailing "5m" - the whole indicator then runs on it).
// HONESTY: verified against hand-built planted structures, NOT against TradingView's own output (there is no Pine runtime here) - compare a chart before trusting exact levels.
import { atr as atrWilder, trueRange } from './indicators'

export interface LuxOpts { swingLen?: number; internalLen?: number; eqLen?: number; eqThr?: number; obRange?: boolean; obClose?: boolean; confluence?: boolean; fvgAuto?: boolean }
export interface LuxIn { open: number[]; high: number[]; low: number[]; close: number[]; time?: number[] }
const BULL = 1, BEAR = -1
export const LUX_FIELDS = [
  'swingBullBos', 'swingBearBos', 'swingBullChoch', 'swingBearChoch', 'internalBullBos', 'internalBearBos', 'internalBullChoch', 'internalBearChoch',
  'swingTrend', 'internalTrend', 'eqh', 'eql', 'eqhLevel', 'eqlLevel', 'swingHigh', 'swingLow', 'internalHigh', 'internalLow',
  'strongHigh', 'strongLow', 'weakHigh', 'weakLow', 'top', 'bottom', 'pos', 'premium', 'equilibrium', 'discount',
  'swingObBull', 'swingObBear', 'internalObBull', 'internalObBear', 'swingObBullIn', 'swingObBearIn', 'internalObBullIn', 'internalObBearIn',
  'swingObBullTop', 'swingObBullBottom', 'swingObBearTop', 'swingObBearBottom', 'internalObBullTop', 'internalObBullBottom', 'internalObBearTop', 'internalObBearBottom',
  'swingObBullBreak', 'swingObBearBreak', 'internalObBullBreak', 'internalObBearBreak',
  'fvgBull', 'fvgBear', 'fvgBullCount', 'fvgBearCount', 'fvgBullIn', 'fvgBearIn',
  'pdh', 'pdl', 'pwh', 'pwl', 'pmh', 'pml',
] as const
export type LuxSeries = Record<(typeof LUX_FIELDS)[number], number[]>

interface Pivot { cur: number; last: number; crossed: boolean; barIndex: number }
interface Leg { leg: number; prev: number | undefined }
interface OB { hi: number; lo: number; bias: number }
interface Fvg { top: number; bottom: number; bias: number }
const mkPivot = (): Pivot => ({ cur: NaN, last: NaN, crossed: false, barIndex: 0 })

export function luxSmc(x: LuxIn, o: LuxOpts = {}): LuxSeries {
  const n = x.close.length, { open, high, low, close } = x
  const swingLen = Math.max(2, Math.round(o.swingLen ?? 50)), internalLen = Math.max(2, Math.round(o.internalLen ?? 5)), eqLen = Math.max(1, Math.round(o.eqLen ?? 3))
  const eqThr = o.eqThr ?? 0.1
  const out = {} as LuxSeries
  for (const k of LUX_FIELDS) out[k] = new Array<number>(n).fill(0)

  const atr200 = atrWilder(high, low, close, 200)
  const tr = trueRange(high, low, close)
  let cumTr = 0, cumFvg = 0
  const parsedHigh = new Array<number>(n), parsedLow = new Array<number>(n)

  const swingHigh = mkPivot(), swingLow = mkPivot(), internalHigh = mkPivot(), internalLow = mkPivot(), equalHigh = mkPivot(), equalLow = mkPivot()
  let swingTrend = 0, internalTrend = 0
  const trailing = { top: NaN, bottom: NaN, barIndex: 0 }
  const legSwing: Leg = { leg: 0, prev: undefined }, legInternal: Leg = { leg: 0, prev: undefined }, legEqual: Leg = { leg: 0, prev: undefined }
  const swingOB: OB[] = [], internalOB: OB[] = []
  const gaps: Fvg[] = []
  let bullishBar = true, bearishBar = true
  // crossover() needs the pivot level as it stood at the previous bar's display step
  const seen: Record<string, number> = { sh: NaN, sl: NaN, ih: NaN, il: NaN }
  let eqhNow = NaN, eqlNow = NaN

  const highestOver = (i: number, size: number): number => { let m = -Infinity; for (let k = i - size + 1; k <= i; k++) m = Math.max(m, high[k]); return m }
  const lowestOver = (i: number, size: number): number => { let m = Infinity; for (let k = i - size + 1; k <= i; k++) m = Math.min(m, low[k]); return m }

  function structure(i: number, size: number, st: Leg, equalHL: boolean, internal: boolean, evEq: { h: boolean; l: boolean }): void {
    if (i >= size) {
      if (high[i - size] > highestOver(i, size)) st.leg = 0
      else if (low[i - size] < lowestOver(i, size)) st.leg = 1
    }
    const change = st.prev === undefined ? 0 : st.leg - st.prev
    st.prev = st.leg
    if (change === 0) return
    if (change === 1) { // pivot low
      const p = equalHL ? equalLow : internal ? internalLow : swingLow
      if (equalHL && Math.abs(p.cur - low[i - size]) < eqThr * atr200[i]) { evEq.l = true; eqlNow = low[i - size] }
      p.last = p.cur; p.cur = low[i - size]; p.crossed = false; p.barIndex = i - size
      if (!equalHL && !internal) trailing.bottom = p.cur, trailing.barIndex = p.barIndex
    } else if (change === -1) { // pivot high
      const p = equalHL ? equalHigh : internal ? internalHigh : swingHigh
      if (equalHL && Math.abs(p.cur - high[i - size]) < eqThr * atr200[i]) { evEq.h = true; eqhNow = high[i - size] }
      p.last = p.cur; p.cur = high[i - size]; p.crossed = false; p.barIndex = i - size
      if (!equalHL && !internal) trailing.top = p.cur, trailing.barIndex = p.barIndex
    }
  }
  const ev = { sBullBos: false, sBullChoch: false, sBearBos: false, sBearChoch: false, iBullBos: false, iBullChoch: false, iBearBos: false, iBearChoch: false }
  function storeOB(p: Pivot, internal: boolean, bias: number, i: number): void {
    const arr = internal ? internalOB : swingOB
    if (p.barIndex >= i) return
    let best = p.barIndex
    for (let k = p.barIndex; k < i; k++) { if (bias === BEAR ? parsedHigh[k] > parsedHigh[best] : parsedLow[k] < parsedLow[best]) best = k }
    arr.unshift({ hi: parsedHigh[best], lo: parsedLow[best], bias })
    if (arr.length > 100) arr.pop()
  }
  function display(i: number, internal: boolean): void {
    if (o.confluence) { bullishBar = high[i] - Math.max(close[i], open[i]) > Math.min(close[i], open[i] - low[i]); bearishBar = high[i] - Math.max(close[i], open[i]) < Math.min(close[i], open[i] - low[i]) }
    const pH = internal ? internalHigh : swingHigh, pL = internal ? internalLow : swingLow
    const key = internal ? ['ih', 'il'] : ['sh', 'sl']
    // bullish break of the pivot high
    const prevH = seen[key[0]]
    const extraH = internal ? internalHigh.cur !== swingHigh.cur && bullishBar : true
    if (i > 0 && close[i] > pH.cur && close[i - 1] <= prevH && !pH.crossed && extraH) {
      const trend = internal ? internalTrend : swingTrend
      const choch = trend === BEAR
      if (internal) { ev[choch ? 'iBullChoch' : 'iBullBos'] = true } else { ev[choch ? 'sBullChoch' : 'sBullBos'] = true }
      pH.crossed = true
      if (internal) internalTrend = BULL; else swingTrend = BULL
      storeOB(pH, internal, BULL, i)
    }
    seen[key[0]] = pH.cur
    const prevL = seen[key[1]]
    const extraL = internal ? internalLow.cur !== swingLow.cur && bearishBar : true
    if (i > 0 && close[i] < pL.cur && close[i - 1] >= prevL && !pL.crossed && extraL) {
      const trend = internal ? internalTrend : swingTrend
      const choch = trend === BULL
      if (internal) { ev[choch ? 'iBearChoch' : 'iBearBos'] = true } else { ev[choch ? 'sBearChoch' : 'sBearBos'] = true }
      pL.crossed = true
      if (internal) internalTrend = BEAR; else swingTrend = BEAR
      storeOB(pL, internal, BEAR, i)
    }
    seen[key[1]] = pL.cur
  }
  const brk = { sBull: false, sBear: false, iBull: false, iBear: false }
  function mitigate(i: number, internal: boolean): void {
    const arr = internal ? internalOB : swingOB
    const bearSrc = o.obClose ? close[i] : high[i], bullSrc = o.obClose ? close[i] : low[i]
    for (const ob of [...arr]) {
      let crossed = false
      if (bearSrc > ob.hi && ob.bias === BEAR) { crossed = true; if (internal) brk.iBear = true; else brk.sBear = true }
      else if (bullSrc < ob.lo && ob.bias === BULL) { crossed = true; if (internal) brk.iBull = true; else brk.sBull = true }
      if (crossed) arr.splice(arr.indexOf(ob), 1)
    }
  }
  // previous day / week / month highs & lows (UTC; week starts Monday)
  const per = (t: number, kind: 'd' | 'w' | 'm'): number => { const d = Math.floor(t / 86400); if (kind === 'd') return d; if (kind === 'w') return Math.floor((d + 3) / 7); const dt = new Date(t * 1000); return dt.getUTCFullYear() * 12 + dt.getUTCMonth() }
  const mtf = (['d', 'w', 'm'] as const).map((kind) => ({ kind, key: NaN, hi: NaN, lo: NaN, pHi: NaN, pLo: NaN }))

  for (let i = 0; i < n; i++) {
    // --- volatility-filtered order-block source ---
    cumTr += tr[i]
    const vol = o.obRange ? cumTr / i : atr200[i]
    const highVol = high[i] - low[i] >= 2 * vol
    parsedHigh[i] = highVol ? low[i] : high[i]
    parsedLow[i] = highVol ? high[i] : low[i]
    // --- trailing swing extremes (before the structure update, as in the script) ---
    if (Number.isFinite(trailing.top)) trailing.top = Math.max(high[i], trailing.top)
    if (Number.isFinite(trailing.bottom)) trailing.bottom = Math.min(low[i], trailing.bottom)
    // --- fair value gaps: delete broken ones first ---
    for (let g = gaps.length - 1; g >= 0; g--) if ((low[i] < gaps[g].bottom && gaps[g].bias === BULL) || (high[i] > gaps[g].top && gaps[g].bias === BEAR)) gaps.splice(g, 1)
    // --- structure ---
    const evEq = { h: false, l: false }
    structure(i, swingLen, legSwing, false, false, evEq)
    structure(i, internalLen, legInternal, false, true, evEq)
    structure(i, eqLen, legEqual, true, false, evEq)
    ev.sBullBos = ev.sBullChoch = ev.sBearBos = ev.sBearChoch = ev.iBullBos = ev.iBullChoch = ev.iBearBos = ev.iBearChoch = false
    brk.sBull = brk.sBear = brk.iBull = brk.iBear = false
    display(i, true)
    display(i, false)
    mitigate(i, true)
    mitigate(i, false)
    // --- fair value gap formation (chart timeframe) ---
    let fvgBull = false, fvgBear = false
    if (i >= 2) {
      const lastClose = close[i - 1], lastOpen = open[i - 1], last2High = high[i - 2], last2Low = low[i - 2]
      const delta = (lastClose - lastOpen) / (lastOpen * 100)
      cumFvg += Math.abs(delta)
      const thr = o.fvgAuto === false ? 0 : (cumFvg / i) * 2
      if (low[i] > last2High && lastClose > last2High && delta > thr) { fvgBull = true; gaps.unshift({ top: low[i], bottom: last2High, bias: BULL }) }
      if (high[i] < last2Low && lastClose < last2Low && -delta > thr) { fvgBear = true; gaps.unshift({ top: high[i], bottom: last2Low, bias: BEAR }) }
    }
    // --- mtf levels ---
    for (const m of mtf) {
      if (x.time) {
        const k = per(x.time[i], m.kind)
        if (k !== m.key) { if (Number.isFinite(m.key)) { m.pHi = m.hi; m.pLo = m.lo } m.key = k; m.hi = high[i]; m.lo = low[i] } else { m.hi = Math.max(m.hi, high[i]); m.lo = Math.min(m.lo, low[i]) }
      }
    }
    // --- write the bar ---
    out.swingBullBos[i] = +ev.sBullBos; out.swingBearBos[i] = +ev.sBearBos; out.swingBullChoch[i] = +ev.sBullChoch; out.swingBearChoch[i] = +ev.sBearChoch
    out.internalBullBos[i] = +ev.iBullBos; out.internalBearBos[i] = +ev.iBearBos; out.internalBullChoch[i] = +ev.iBullChoch; out.internalBearChoch[i] = +ev.iBearChoch
    out.swingTrend[i] = swingTrend; out.internalTrend[i] = internalTrend
    out.eqh[i] = +evEq.h; out.eql[i] = +evEq.l; out.eqhLevel[i] = equalHigh.cur; out.eqlLevel[i] = equalLow.cur
    out.swingHigh[i] = swingHigh.cur; out.swingLow[i] = swingLow.cur; out.internalHigh[i] = internalHigh.cur; out.internalLow[i] = internalLow.cur
    const top = trailing.top, bottom = trailing.bottom
    out.top[i] = top; out.bottom[i] = bottom
    out.strongHigh[i] = swingTrend === BEAR ? top : NaN; out.weakHigh[i] = swingTrend === BEAR ? NaN : top
    out.strongLow[i] = swingTrend === BULL ? bottom : NaN; out.weakLow[i] = swingTrend === BULL ? NaN : bottom
    if (Number.isFinite(top) && Number.isFinite(bottom) && top > bottom) {
      const c = close[i]
      out.pos[i] = (c - bottom) / (top - bottom)
      out.premium[i] = +(c >= 0.95 * top + 0.05 * bottom && c <= top)
      out.discount[i] = +(c <= 0.95 * bottom + 0.05 * top && c >= bottom)
      out.equilibrium[i] = +(c <= 0.525 * top + 0.475 * bottom && c >= 0.525 * bottom + 0.475 * top)
    } else { out.pos[i] = NaN }
    for (const [name, arr] of [['swing', swingOB], ['internal', internalOB]] as const) {
      const bulls = arr.filter((b) => b.bias === BULL), bears = arr.filter((b) => b.bias === BEAR)
      const c = close[i], inn = (a: OB[]) => +a.some((b) => c <= b.hi && c >= b.lo)
      ;(out as Record<string, number[]>)[`${name}ObBull`][i] = bulls.length; (out as Record<string, number[]>)[`${name}ObBear`][i] = bears.length
      ;(out as Record<string, number[]>)[`${name}ObBullIn`][i] = inn(bulls); (out as Record<string, number[]>)[`${name}ObBearIn`][i] = inn(bears)
      ;(out as Record<string, number[]>)[`${name}ObBullTop`][i] = bulls.length ? bulls[0].hi : NaN; (out as Record<string, number[]>)[`${name}ObBullBottom`][i] = bulls.length ? bulls[0].lo : NaN
      ;(out as Record<string, number[]>)[`${name}ObBearTop`][i] = bears.length ? bears[0].hi : NaN; (out as Record<string, number[]>)[`${name}ObBearBottom`][i] = bears.length ? bears[0].lo : NaN
    }
    out.swingObBullBreak[i] = +brk.sBull; out.swingObBearBreak[i] = +brk.sBear; out.internalObBullBreak[i] = +brk.iBull; out.internalObBearBreak[i] = +brk.iBear
    out.fvgBull[i] = +fvgBull; out.fvgBear[i] = +fvgBear
    const gb = gaps.filter((g) => g.bias === BULL), gr = gaps.filter((g) => g.bias === BEAR)
    out.fvgBullCount[i] = gb.length; out.fvgBearCount[i] = gr.length
    // a bearish gap stores top = the current high (the LOWER edge) and bottom = the low two bars back (the UPPER edge), exactly like the script - so test against min/max
    out.fvgBullIn[i] = +gb.some((g) => close[i] <= Math.max(g.top, g.bottom) && close[i] >= Math.min(g.top, g.bottom)); out.fvgBearIn[i] = +gr.some((g) => close[i] <= Math.max(g.top, g.bottom) && close[i] >= Math.min(g.top, g.bottom))
    out.pdh[i] = mtf[0].pHi; out.pdl[i] = mtf[0].pLo; out.pwh[i] = mtf[1].pHi; out.pwl[i] = mtf[1].pLo; out.pmh[i] = mtf[2].pHi; out.pml[i] = mtf[2].pLo
  }
  return out
}
