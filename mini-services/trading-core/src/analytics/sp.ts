// IQAIR//OS - SHOCK & PRESSURE of the ONGOING candle (`story.sp()`).
//
// The idea: read how the candle that is STILL FORMING has been moving.
//   PRESSURE = the body moving SLOWLY: a steady, orderly drift in one direction (the slow part of the move).
//   SHOCK    = the body moving SUDDENLY: one fast, long burst (a large move inside a few seconds).
// The slow part and the burst can point different ways, so each has its own direction. story.sp() keeps ONLY the two shock cases below; the old case 5 (pressure with NO shock, with the trend) now stands alone as SSP (readSsp, story.ssp()).
//   1. pressure UP,   shock UP    -> choose LOWER  (put)
//   2. pressure DOWN, shock DOWN  -> choose HIGHER (call)
// Cases 3 (pressure UP + shock DOWN) and 4 (pressure DOWN + shock UP) were REMOVED: a shock that runs against the pressure is "no call". The numbers 3, 4 and 5 are retired.
// Anything else (no pressure) is "no call".
//
// Measured on the candle's own path (ticks when the context has them, else the 5s chart), in ATR14 of the chart timeframe:
//   shock    : the biggest move inside any burstSec window (default 10 s) is >= shockAtr (0.30) AND it ended within the last freshSec (default max(10 s, 30% of the candle)) - the shock is the ONGOING move, not history.
//   pressure : the candle's move WITHOUT the shock burst is >= pressureAtr (0.12) and steady (efficiency = |net| / path >= minEff 0.30).
// Pure function with an explicit clock. HONESTY: thresholds are judgement, nothing here is fitted; the rules are the strategy as described, not a measured edge - replay it before trading it. LIVE / REPLAY only.
export interface SpPoint { t: number; p: number }
export interface SpOptions {
  open: number; openSec: number; nowSec: number; tfSec: number; atr: number
  /** +1 / -1 / 0: the prevailing trend (SSP only; story.sp ignores it) */
  trend: number
  /** how the SHOCK is measured: atr = burst / ATR (default, thr 0.30) | z = burst / (per-second vol x sqrt(burstSec)), z-score (thr 3) | roc = burst as % of the open (thr 0.03) */
  shockMode?: ShockMode
  /** how the PRESSURE is measured: atr = |slow move| / ATR AND efficiency (default, thr 0.12) | er = Kaufman efficiency ratio alone (thr 0.5) | reg = R2 of a straight-line fit (thr 0.7) | roc = slow move as % of the open AND efficiency (thr 0.02) */
  pressureMode?: PressureMode
  /** several measures AT ONCE (all must pass): shockModes ['atr','roc'] / pressureModes ['atr','reg']. When given they replace shockMode / pressureMode; the first one is the PRIMARY (positional thresholds, shockVal / pressureVal). */
  shockModes?: ShockMode[]; pressureModes?: PressureMode[]
  /** per-mode thresholds for the combined case, e.g. { roc: 0.05 }; a mode not listed uses the primary positional threshold (primary only) or its default */
  shockThrs?: Partial<Record<ShockMode, number>>; pressureThrs?: Partial<Record<PressureMode, number>>
  /** thresholds, in the unit of the chosen mode (shockAtr / pressureAtr kept as the old names) */
  shockThr?: number; pressureThr?: number
  /** realised volatility per SECOND (stdev of close-to-close change / sqrt(bar seconds)), price units. Needed for shockMode 'z' */
  sigmaSec?: number
  shockAtr?: number; burstSec?: number; freshSec?: number; pressureAtr?: number; minEff?: number
}
export type ShockMode = 'atr' | 'z' | 'roc'
export type PressureMode = 'atr' | 'er' | 'reg' | 'roc'
export const SHOCK_DEFAULT: Record<ShockMode, number> = { atr: 0.30, z: 3, roc: 0.03 }
export const PRESSURE_DEFAULT: Record<PressureMode, number> = { atr: 0.12, er: 0.5, reg: 0.7, roc: 0.02 }
const SHOCK_UNIT: Record<ShockMode, string> = { atr: 'ATR', z: 'sigma', roc: '% of price' }
/** a pressure read must also move at least this many ATR (er / reg only), so a perfectly smooth 1-tick crawl is not pressure */
const MIN_BODY_ATR = 0.05
export interface SpResult {
  ok: boolean; error?: string
  caseNo: number // 1 or 2, 0 = no setup
  direction: 'call' | 'put' | 'none'
  pressure: boolean; pressureDir: number; pressureAtr: number; pressureEff: number
  shock: boolean; shockDir: number; shockAtr: number; shockAge: number
  /** the measure the thresholds were tested on, in the chosen unit (signed): shockVal in ATR / sigma / % of price; pressureVal = ATR move, efficiency, R2 or % of price */
  shockVal: number; pressureVal: number; shockMode: ShockMode; pressureMode: PressureMode
  /** every measure that had to pass, e.g. 'atr+roc' (one name when a single measure is used) */
  shockModes?: string; pressureModes?: string
  bodyAtr: number; progress: number; trendDir: number; points: number
  text: string
}
const CASE_TEXT: Record<number, string> = {
  1: 'pressure up + shock up -> lower', 2: 'pressure down + shock down -> higher',
}
const fmtShock = (b: { shockVal: number; shockMode: ShockMode }) => `${Math.abs(b.shockVal).toFixed(b.shockMode === 'roc' ? 3 : 2)} ${SHOCK_UNIT[b.shockMode]}`
const fmtPress = (b: { pressureVal: number; pressureMode: PressureMode }) => b.pressureMode === 'atr' ? `${Math.abs(b.pressureVal).toFixed(2)} ATR` : b.pressureMode === 'er' ? `efficiency ${Math.abs(b.pressureVal).toFixed(2)}` : b.pressureMode === 'reg' ? `R2 ${Math.abs(b.pressureVal).toFixed(2)}` : `${Math.abs(b.pressureVal).toFixed(3)}% of price`
const fail = (error: string): SpResult => ({ ok: false, error, caseNo: 0, direction: 'none', pressure: false, pressureDir: 0, pressureAtr: 0, pressureEff: 0, shock: false, shockDir: 0, shockAtr: 0, shockAge: NaN, shockVal: 0, pressureVal: 0, shockMode: 'atr', pressureMode: 'atr', bodyAtr: 0, progress: 0, trendDir: 0, points: 0, text: error })

function measure(points: readonly SpPoint[], o: SpOptions): { fail: SpResult } | { base: Omit<SpResult, 'ok' | 'caseNo' | 'direction' | 'text'>; pressure: boolean; pressureDir: number; shock: boolean; shockDir: number; shockAtr: number; pressureAtr: number; eff: number; progress: number } {
  if (!(o.atr > 0) || !Number.isFinite(o.open) || !(o.tfSec > 0)) return { fail: fail('ATR or the candle open is unavailable') }
  const shockModes: ShockMode[] = o.shockModes?.length ? [...new Set(o.shockModes)] : [o.shockMode ?? 'atr'], pressureModes: PressureMode[] = o.pressureModes?.length ? [...new Set(o.pressureModes)] : [o.pressureMode ?? 'atr']
  const shockMode = shockModes[0], pressureMode = pressureModes[0]
  const shockThrOf = (m: ShockMode): number => o.shockThrs?.[m] ?? (m === shockMode ? (o.shockThr ?? o.shockAtr) : undefined) ?? SHOCK_DEFAULT[m]
  const pressThrOf = (m: PressureMode): number => o.pressureThrs?.[m] ?? (m === pressureMode ? (o.pressureThr ?? o.pressureAtr) : undefined) ?? PRESSURE_DEFAULT[m]
  const burstSec = o.burstSec ?? 10, freshSec = o.freshSec ?? Math.max(10, 0.3 * o.tfSec), minEff = o.minEff ?? 0.30
  if (shockModes.includes('z') && !(o.sigmaSec && o.sigmaSec > 0)) return { fail: fail('shock measure "z" needs realised volatility from the closed bars, which is unavailable') }
  const pts: SpPoint[] = [{ t: o.openSec, p: o.open }]
  for (const q of points) if (q.t > o.openSec && q.t <= o.nowSec + 1e-6 && Number.isFinite(q.p)) pts.push(q)
  pts.sort((a, b) => a.t - b.t)
  const P = pts.length > 800 ? pts.slice(-800) : pts
  if (P.length < 4) return { fail: fail('too little price path inside the forming candle yet') }
  const progress = Math.max(0, Math.min(1.5, (o.nowSec - o.openSec) / o.tfSec))
  const last = P[P.length - 1].p, body = last - o.open
  // the biggest burst inside any burstSec window (signed), by indices
  let bi = 0, bj = 0, bmv = 0
  for (let i = 0; i < P.length - 1; i++) for (let j = i + 1; j < P.length && P[j].t - P[i].t <= burstSec + 1e-6; j++) { const mv = P[j].p - P[i].p; if (Math.abs(mv) > Math.abs(bmv)) { bmv = mv; bi = i; bj = j } }
  const shockAtr = Math.abs(bmv) / o.atr, shockAge = o.nowSec - P[bj].t
  const shockMeasureOf = (m: ShockMode): number => m === 'atr' ? shockAtr : m === 'z' ? Math.abs(bmv) / (o.sigmaSec! * Math.sqrt(Math.max(1, burstSec))) : (Math.abs(bmv) / o.open) * 100
  const shockMeasure = shockMeasureOf(shockMode)
  const shock = shockModes.every((m) => shockMeasureOf(m) >= shockThrOf(m)) && shockAge <= freshSec
  const shockDir = shock ? Math.sign(bmv) : 0
  // the slow part: the candle's move WITHOUT the burst
  const restNet = shock ? body - bmv : body
  let path = 0
  for (let k = 1; k < P.length; k++) { if (shock && k > bi && k <= bj) continue; path += Math.abs(P[k].p - P[k - 1].p) }
  const eff = path > 0 ? Math.abs(restNet) / path : 0
  const pressureAtr = Math.abs(restNet) / o.atr
  // R2 + slope of a straight-line fit of the slow part (the burst points left out)
  let r2 = 0, slope = 0
  if (pressureModes.includes('reg')) {
    const R = P.filter((_, k) => !(shock && k > bi && k <= bj))
    const n = R.length
    if (n >= 4) {
      const mt = R.reduce((a, q) => a + q.t, 0) / n, mp = R.reduce((a, q) => a + q.p, 0) / n
      let sxx = 0, sxy = 0, syy = 0
      for (const q of R) { sxx += (q.t - mt) ** 2; sxy += (q.t - mt) * (q.p - mp); syy += (q.p - mp) ** 2 }
      if (sxx > 0 && syy > 0) { slope = sxy / sxx; r2 = (sxy * sxy) / (sxx * syy) }
    }
  }
  const pressureMeasureOf = (m: PressureMode): number => m === 'atr' ? pressureAtr : m === 'er' ? eff : m === 'reg' ? r2 : (Math.abs(restNet) / o.open) * 100
  const pressureMeasure = pressureMeasureOf(pressureMode)
  const single = pressureModes.length === 1
  const passes = (m: PressureMode): boolean => m === 'atr' ? pressureAtr >= pressThrOf(m) && eff >= minEff
    : m === 'er' ? eff >= pressThrOf(m) && pressureAtr >= MIN_BODY_ATR
    : m === 'reg' ? r2 >= pressThrOf(m) && pressureAtr >= MIN_BODY_ATR && (single || Math.sign(slope) === Math.sign(restNet))
    : pressureMeasureOf('roc') >= pressThrOf(m) && eff >= minEff
  const pressure = pressureModes.every(passes)
  const pressureDir = pressure ? (single && pressureMode === 'reg' ? Math.sign(slope) : Math.sign(restNet)) : 0
  const base = { pressure, pressureDir, pressureAtr: Math.sign(restNet) * pressureAtr, pressureEff: eff, shock, shockDir, shockAtr: Math.sign(bmv) * shockAtr, shockAge, shockVal: Math.sign(bmv) * shockMeasure, pressureVal: (single && pressureMode === 'reg' ? Math.sign(slope) : Math.sign(restNet)) * pressureMeasure, shockMode, pressureMode, shockModes: shockModes.join('+'), pressureModes: pressureModes.join('+'), bodyAtr: body / o.atr, progress, trendDir: o.trend, points: P.length }
  return { base, pressure, pressureDir, shock, shockDir, shockAtr, pressureAtr, eff, progress }
}

export function readSp(points: readonly SpPoint[], o: SpOptions): SpResult {
  const m = measure(points, o)
  if ('fail' in m) return m.fail
  const { base, pressure, pressureDir, shock, shockDir, shockAtr, pressureAtr, eff, progress } = m
  const none = (why: string): SpResult => ({ ok: true, caseNo: 0, direction: 'none', ...base, text: `No setup: ${why}.` })
  if (!pressure) return none(shock ? `a ${shockDir > 0 ? 'up' : 'down'} shock (${fmtShock(base)}) but no steady pressure behind the candle` : `no steady pressure yet (${fmtPress(base)}, slow move ${pressureAtr.toFixed(2)} ATR, efficiency ${eff.toFixed(2)})`)
  let caseNo = 0, direction: 'call' | 'put' | 'none' = 'none'
  if (!shock) return none('steady pressure but no shock (that is SSP, story.ssp())')
  if (pressureDir > 0 && shockDir > 0) { caseNo = 1; direction = 'put' }
  else if (pressureDir < 0 && shockDir < 0) { caseNo = 2; direction = 'call' }
  else return none(`the ${shockDir > 0 ? 'up' : 'down'} shock runs against the ${pressureDir > 0 ? 'up' : 'down'} pressure (no call)`)
  return { ok: true, caseNo, direction, ...base, text: `Case ${caseNo}: ${CASE_TEXT[caseNo]} (${direction.toUpperCase()}). Pressure ${pressureDir > 0 ? 'up' : 'down'} ${fmtPress(base)} (efficiency ${eff.toFixed(2)})${`, shock ${shockDir > 0 ? 'up' : 'down'} ${fmtShock(base)} ${base.shockAge.toFixed(0)} s ago`}; candle ${(progress * 100).toFixed(0)}% done.` }
}

/** SSP - STEADY SHOCK-FREE PRESSURE (the old case 5 of story.sp, now standalone): the forming candle drifts one way steadily (pressure, no shock) and price trades WITH THE TREND (EMA20 vs EMA50).
 * Call in an uptrend, put in a downtrend, whatever the drift direction (the same rule the old case 5 used). No pressure, a shock present, or no clear trend = no call. HONEST: judgement thresholds, not a measured edge. */
export function readSsp(points: readonly SpPoint[], o: SpOptions): SpResult {
  const m = measure(points, o)
  if ('fail' in m) return m.fail
  const { base, pressure, pressureDir, shock, pressureAtr, eff, progress } = m
  const none = (why: string): SpResult => ({ ok: true, caseNo: 0, direction: 'none', ...base, text: `No setup: ${why}.` })
  if (shock) return none('a shock is present (that is story.sp(), not SSP)')
  if (!pressure) return none(`no steady pressure yet (${fmtPress(base)}, efficiency ${eff.toFixed(2)})`)
  if (o.trend === 0) return none('steady pressure, but there is no clear trend to follow')
  const direction: 'call' | 'put' = o.trend > 0 ? 'call' : 'put'
  return { ok: true, caseNo: 5, direction, ...base, text: `SSP: steady pressure ${pressureDir > 0 ? 'up' : 'down'} ${fmtPress(base)} (efficiency ${eff.toFixed(2)}), no shock, trend ${o.trend > 0 ? 'up' : 'down'} -> ${direction.toUpperCase()}; candle ${(progress * 100).toFixed(0)}% done.` }
}
