// IQAIR//OS - SHOCK & PRESSURE of the ONGOING candle (`story.sp()`).
//
// The idea: read how the candle that is STILL FORMING has been moving.
//   PRESSURE = the body moving SLOWLY: a steady, orderly drift in one direction (the slow part of the move).
//   SHOCK    = the body moving SUDDENLY: one fast, long burst (a large move inside a few seconds).
// The slow part and the burst can point different ways, so each has its own direction. The five conditions:
//   1. pressure UP,   shock UP    -> choose LOWER  (put)
//   2. pressure DOWN, shock DOWN  -> choose HIGHER (call)
//   5. pressure, NO shock         -> choose WITH THE TREND (call in an uptrend, put in a downtrend)
// Cases 3 (pressure UP + shock DOWN) and 4 (pressure DOWN + shock UP) were REMOVED: a shock that runs against the pressure is "no call". Their numbers are kept retired so 1, 2 and 5 keep their meaning.
// Anything else (no pressure) is "no call".
//
// Measured on the candle's own path (ticks when the context has them, else the 5s chart), in ATR14 of the chart timeframe:
//   shock    : the biggest move inside any burstSec window (default 10 s) is >= shockAtr (0.30) AND it ended within the last freshSec (default max(10 s, 30% of the candle)) - the shock is the ONGOING move, not history.
//   pressure : the candle's move WITHOUT the shock burst is >= pressureAtr (0.12) and steady (efficiency = |net| / path >= minEff 0.30).
// Pure function with an explicit clock. HONESTY: thresholds are judgement, nothing here is fitted; the rules are the strategy as described, not a measured edge - replay it before trading it. LIVE / REPLAY only.
export interface SpPoint { t: number; p: number }
export interface SpOptions {
  open: number; openSec: number; nowSec: number; tfSec: number; atr: number
  /** +1 / -1 / 0: the prevailing trend (used by case 5 only) */
  trend: number
  shockAtr?: number; burstSec?: number; freshSec?: number; pressureAtr?: number; minEff?: number
}
export interface SpResult {
  ok: boolean; error?: string
  caseNo: number // 1..5, 0 = no setup
  direction: 'call' | 'put' | 'none'
  pressure: boolean; pressureDir: number; pressureAtr: number; pressureEff: number
  shock: boolean; shockDir: number; shockAtr: number; shockAge: number
  bodyAtr: number; progress: number; trendDir: number; points: number
  text: string
}
const CASE_TEXT: Record<number, string> = {
  1: 'pressure up + shock up -> lower', 2: 'pressure down + shock down -> higher', 5: 'pressure without a shock -> with the trend',
}
const fail = (error: string): SpResult => ({ ok: false, error, caseNo: 0, direction: 'none', pressure: false, pressureDir: 0, pressureAtr: 0, pressureEff: 0, shock: false, shockDir: 0, shockAtr: 0, shockAge: NaN, bodyAtr: 0, progress: 0, trendDir: 0, points: 0, text: error })

export function readSp(points: readonly SpPoint[], o: SpOptions): SpResult {
  if (!(o.atr > 0) || !Number.isFinite(o.open) || !(o.tfSec > 0)) return fail('ATR or the candle open is unavailable')
  const shockThr = o.shockAtr ?? 0.30, burstSec = o.burstSec ?? 10, freshSec = o.freshSec ?? Math.max(10, 0.3 * o.tfSec), pressThr = o.pressureAtr ?? 0.12, minEff = o.minEff ?? 0.30
  const pts: SpPoint[] = [{ t: o.openSec, p: o.open }]
  for (const q of points) if (q.t > o.openSec && q.t <= o.nowSec + 1e-6 && Number.isFinite(q.p)) pts.push(q)
  pts.sort((a, b) => a.t - b.t)
  const P = pts.length > 800 ? pts.slice(-800) : pts
  if (P.length < 4) return fail('too little price path inside the forming candle yet')
  const progress = Math.max(0, Math.min(1.5, (o.nowSec - o.openSec) / o.tfSec))
  const last = P[P.length - 1].p, body = last - o.open
  // the biggest burst inside any burstSec window (signed), by indices
  let bi = 0, bj = 0, bmv = 0
  for (let i = 0; i < P.length - 1; i++) for (let j = i + 1; j < P.length && P[j].t - P[i].t <= burstSec + 1e-6; j++) { const mv = P[j].p - P[i].p; if (Math.abs(mv) > Math.abs(bmv)) { bmv = mv; bi = i; bj = j } }
  const shockAtr = Math.abs(bmv) / o.atr, shockAge = o.nowSec - P[bj].t
  const shock = shockAtr >= shockThr && shockAge <= freshSec
  const shockDir = shock ? Math.sign(bmv) : 0
  // the slow part: the candle's move WITHOUT the burst
  const restNet = shock ? body - bmv : body
  let path = 0
  for (let k = 1; k < P.length; k++) { if (shock && k > bi && k <= bj) continue; path += Math.abs(P[k].p - P[k - 1].p) }
  const eff = path > 0 ? Math.abs(restNet) / path : 0
  const pressureAtr = Math.abs(restNet) / o.atr
  const pressure = pressureAtr >= pressThr && eff >= minEff
  const pressureDir = pressure ? Math.sign(restNet) : 0
  const base = { pressure, pressureDir, pressureAtr: Math.sign(restNet) * pressureAtr, pressureEff: eff, shock, shockDir, shockAtr: Math.sign(bmv) * shockAtr, shockAge, bodyAtr: body / o.atr, progress, trendDir: o.trend, points: P.length }
  const none = (why: string): SpResult => ({ ok: true, caseNo: 0, direction: 'none', ...base, text: `No setup: ${why}.` })
  if (!pressure) return none(shock ? `a ${shockDir > 0 ? 'up' : 'down'} shock (${shockAtr.toFixed(2)} ATR) but no steady pressure behind the candle` : `no steady pressure yet (slow move ${pressureAtr.toFixed(2)} ATR, efficiency ${eff.toFixed(2)})`)
  let caseNo = 0, direction: 'call' | 'put' | 'none' = 'none'
  if (shock) {
    if (pressureDir > 0 && shockDir > 0) { caseNo = 1; direction = 'put' }
    else if (pressureDir < 0 && shockDir < 0) { caseNo = 2; direction = 'call' }
    else return none(`the ${shockDir > 0 ? 'up' : 'down'} shock runs against the ${pressureDir > 0 ? 'up' : 'down'} pressure (no call)`)
  } else {
    if (o.trend === 0) return none('pressure without a shock, but there is no clear trend to follow')
    caseNo = 5; direction = o.trend > 0 ? 'call' : 'put'
  }
  return { ok: true, caseNo, direction, ...base, text: `Case ${caseNo}: ${CASE_TEXT[caseNo]} (${direction.toUpperCase()}). Pressure ${pressureDir > 0 ? 'up' : 'down'} ${pressureAtr.toFixed(2)} ATR (efficiency ${eff.toFixed(2)})${shock ? `, shock ${shockDir > 0 ? 'up' : 'down'} ${shockAtr.toFixed(2)} ATR ${shockAge.toFixed(0)} s ago` : ', no shock'}${caseNo === 5 ? `, trend ${o.trend > 0 ? 'up' : 'down'}` : ''}; candle ${(progress * 100).toFixed(0)}% done.` }
}
