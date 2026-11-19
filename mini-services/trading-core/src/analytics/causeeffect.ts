// IQAIR//OS - CAUSE -> EFFECT predictive mini story ("pm" = predicted move).
//
// Volume alone is just a number. This reads WHY it happened (the CAUSE) and WHAT it did (the EFFECT), checks how that pairing behaved N bars ago, and
// uses the history of "this cause -> what the next candle did" to predict the next candle.
//   CAUSE  : volume vs normal, footprint delta (CLV estimate), tick imbalance (when ticks exist for the bar), Money Flow Index, Accumulation/Distribution slope.
//   EFFECT : candle direction, size in ATR, wick psychology, rate of change, Commodity Channel Index.
//   CHECK  : coherence (did cause and effect agree), bucket statistics of the NEXT bar for the current cause, and a walk-forward track record
//            (every prediction made using only the bars before it).
//   S/R    : fractal pivots clustered by ATR, distance to nearest support/resistance, retest (touched and held / failed).
//   PM     : direction, probability (shrunk toward 50%), expected move in ATR, confidence 0-100, validated flag.
// HONESTY: this is a judgement-weighted model, not a fitted one. Footprint is ESTIMATED from candle volume (no bid/ask). Ticks exist only where the tick
// archive has coverage. `validated` only says the walk-forward hit rate beat 50% on enough predictions; over many labels some pass by luck. Backtest before trading it.

import { atr as atrInd, cci as cciInd, mfi as mfiInd, roc as rocInd } from './indicators'

export interface CeCandle { time: number; open: number; high: number; low: number; close: number; volume?: number }
export interface CeTick { ts: number; price: number }

/** otc: OTC mode - no real volume exists (broker-generated quotes), so the cause is built from what the feed DOES carry: tick imbalance, tick path efficiency, run persistence and range expansion;
 * volume / MFI / A-D are dropped, and `validated` needs a longer, stricter walk-forward record. */
export interface CeOptions { minHistory?: number; track?: number; srStrength?: number; otc?: boolean }

export interface CeBar {
  cause: number          // -1..+1 buying(+)/selling(-) pressure
  causeDir: -1 | 0 | 1
  causeMag: number       // 0..1
  volRatio: number       // volume / 20-bar mean
  fpDelta: number        // CLV buy-sell share of volume, -1..1
  tickImb: number        // up-ticks minus down-ticks share, NaN if no ticks
  mfi: number            // -1..1 ((mfi-50)/50)
  pathEff: number        // OTC: signed tick path efficiency (net move / distance travelled), NaN without ticks
  run: number            // OTC: signed same-direction close streak, -1..1
  speed: number          // OTC: ticks in this bar / mean of the last 20 (1 = normal), 1 without ticks
  expand: number         // OTC: signed range expansion vs the recent mean range, -1..1
  adSlope: number        // -1..1
  effect: number         // -1..+1
  effectDir: -1 | 0 | 1
  sizeAtr: number
  upperWick: number
  lowerWick: number
  body: number
  roc: number            // % over 3 bars
  cci: number
  psychology: string
  label: string
}

export interface CeResult {
  ok: boolean
  error?: string
  cause: { dir: number; mag: number; label: string; volRatio: number; fpDelta: number; tickImb: number; mfi: number; adSlope: number; ticksUsed: boolean; otc?: boolean; pathEff?: number; run?: number; speed?: number; expand?: number }
  effect: { dir: number; sizeAtr: number; psychology: string; upperWick: number; lowerWick: number; body: number; roc: number; cci: number }
  validation: { coherence: number; coherenceN: number; bucketN: number; bucketUpProb: number; bucketMoveAtr: number; trackN: number; trackHit: number; validated: boolean; key: string }
  sr: { support: number; resistance: number; supDist: number; resDist: number; atSupport: boolean; atResistance: boolean; retest: number; retestLevel: number; retestTouches: number }
  pm: { dir: 'call' | 'put' | 'none'; sign: number; prob: number; moveAtr: number; confidence: number; price: number }
  text: string
  bars: CeBar[]
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const sgn = (x: number): -1 | 0 | 1 => (x > 0 ? 1 : x < 0 ? -1 : 0)

/** Accumulation/Distribution line: running sum of close-location-value x volume. */
export function adLine(high: number[], low: number[], close: number[], volume: number[]): number[] {
  const out: number[] = []
  let acc = 0
  for (let i = 0; i < close.length; i++) {
    const rng = high[i] - low[i]
    const clv = rng > 0 ? (close[i] - low[i] - (high[i] - close[i])) / rng : 0
    acc += clv * (Number.isFinite(volume[i]) ? volume[i] : 0)
    out.push(acc)
  }
  return out
}

/** Tick imbalance of one bar window: (up moves - down moves) / (all moves), weighted by move size. NaN when there are fewer than `min` ticks. */
/** Tick path efficiency for a bar: signed net move / total distance travelled (1 = straight line, 0 = pure chop); also the tick count. */
export function tickPath(ticks: readonly CeTick[], fromMs: number, toMs: number, min = 5): { eff: number; n: number } {
  let n = 0, path = 0, first = NaN, last = NaN, prev = NaN
  for (const t of ticks) {
    if (t.ts < fromMs) continue
    if (t.ts >= toMs) break
    n++
    if (!Number.isFinite(first)) first = t.price
    if (Number.isFinite(prev)) path += Math.abs(t.price - prev)
    prev = last = t.price
  }
  return { eff: n < min || path <= 0 ? NaN : (last - first) / path, n }
}

export function tickImbalance(ticks: readonly CeTick[], fromMs: number, toMs: number, min = 5): number {
  let n = 0, up = 0, dn = 0, prev = NaN
  for (const t of ticks) {
    if (t.ts < fromMs) continue
    if (t.ts >= toMs) break
    n++
    if (Number.isFinite(prev)) { const d = t.price - prev; if (d > 0) up += d; else if (d < 0) dn -= d }
    prev = t.price
  }
  if (n < min || up + dn <= 0) return NaN
  return (up - dn) / (up + dn)
}

function spacing(c: CeCandle[]): number {
  let b = Infinity
  for (let i = 1; i < c.length; i++) { const g = c[i].time - c[i - 1].time; if (g > 0 && g < b) b = g }
  return Number.isFinite(b) ? b : 60
}

function featuresFor(c: CeCandle[], ticks?: readonly CeTick[], otc = false): CeBar[] {
  const n = c.length, sp = spacing(c)
  const hi = c.map((x) => x.high), lo = c.map((x) => x.low), cl = c.map((x) => x.close), vol = c.map((x) => (Number.isFinite(x.volume) ? (x.volume as number) : 0))
  const atr = atrInd(hi, lo, cl, 14), mfi = mfiInd(hi, lo, cl, vol, 14), cci = cciInd(hi, lo, cl, 20), roc3 = rocInd(cl, 3), ad = adLine(hi, lo, cl, vol)
  const hasVol = vol.some((v) => v > 0)
  const out: CeBar[] = []
  let volSum = 0, rngSum = 0, runLen = 0
  const tickN: number[] = []
  for (let i = 0; i < n; i++) {
    volSum += vol[i]; if (i >= 20) volSum -= vol[i - 20]
    const mean = volSum / Math.min(i + 1, 20)
    const volRatio = hasVol && mean > 0 ? vol[i] / mean : 1
    const rng = hi[i] - lo[i]
    const fpDelta = rng > 0 ? (cl[i] - lo[i] - (hi[i] - cl[i])) / rng : 0
    const tickImb = ticks && ticks.length ? tickImbalance(ticks, c[i].time * 1000, (c[i].time + sp) * 1000) : NaN
    // OTC extras (computed always, used only in OTC mode)
    const tp = ticks && ticks.length ? tickPath(ticks, c[i].time * 1000, (c[i].time + sp) * 1000) : { eff: NaN, n: 0 }
    tickN.push(tp.n)
    let tm = 0, tc = 0; for (let j = Math.max(0, i - 20); j < i; j++) if (tickN[j] > 0) { tm += tickN[j]; tc++ }
    const speed = tp.n > 0 && tc > 0 && tm > 0 ? tp.n / (tm / tc) : 1
    const dirI = sgn(cl[i] - c[i].open)
    runLen = dirI === 0 ? 0 : i > 0 && sgn(cl[i - 1] - c[i - 1].open) === dirI ? runLen + dirI : dirI
    const run = clamp(runLen / 4, -1, 1)
    rngSum += rng; if (i >= 20) rngSum -= hi[i - 20] - lo[i - 20]
    const rngMean = rngSum / Math.min(i + 1, 20)
    const expand = rngMean > 0 ? clamp(dirI * (rng / rngMean - 1), -1, 1) : 0
    const mfiV = Number.isFinite(mfi[i]) ? (mfi[i] - 50) / 50 : 0
    let adSlope = 0
    if (i >= 5) { let s = 0; for (let j = i - 4; j <= i; j++) s += vol[j]; adSlope = s > 0 ? clamp((ad[i] - ad[i - 5]) / s, -1, 1) : 0 }
    // weights: footprint .3, ticks .25 (if present), mfi .25, A/D .2 - re-normalised over what exists
    const parts: [number, number][] = otc ? [[fpDelta, 0.2], [run, 0.15], [expand, 0.1]] : [[fpDelta, 0.3], [mfiV, 0.25], [adSlope, 0.2]]
    if (Number.isFinite(tickImb)) parts.push([tickImb, otc ? 0.4 : 0.25])
    if (otc && Number.isFinite(tp.eff)) parts.push([tp.eff, 0.15])
    const wsum = parts.reduce((a, p) => a + p[1], 0)
    let cause = parts.reduce((a, p) => a + p[0] * p[1], 0) / wsum
    // volume amplifies: heavy volume = the pressure is real, thin volume = discounted. OTC: no volume - tick SPEED (activity vs normal) scales it instead, mildly
    cause = clamp(cause * (otc ? clamp(0.8 + 0.2 * speed, 0.8, 1.2) : clamp(0.6 + 0.4 * volRatio, 0.4, 1.4)), -1, 1)
    const causeMag = Math.abs(cause)
    const a = Number.isFinite(atr[i]) && atr[i] > 0 ? atr[i] : rng || 1
    const body = rng > 0 ? Math.abs(cl[i] - c[i].open) / rng : 0
    const upperWick = rng > 0 ? (hi[i] - Math.max(c[i].open, cl[i])) / rng : 0
    const lowerWick = rng > 0 ? (Math.min(c[i].open, cl[i]) - lo[i]) / rng : 0
    const sizeAtr = rng / a
    const dir = sgn(cl[i] - c[i].open)
    const rocV = Number.isFinite(roc3[i]) ? roc3[i] : 0
    const cciV = Number.isFinite(cci[i]) ? cci[i] : 0
    const effect = clamp(dir * (0.35 + 0.35 * Math.min(1, sizeAtr)) + 0.15 * clamp(cciV / 150, -1, 1) + 0.15 * clamp(rocV / (a / cl[i] * 100 * 2), -1, 1), -1, 1)
    let psychology = 'balanced'
    if (body >= 0.8) psychology = dir > 0 ? 'buyers-in-control' : 'sellers-in-control'
    else if (lowerWick >= 0.45 && lowerWick > upperWick * 1.5) psychology = 'dip-bought'
    else if (upperWick >= 0.45 && upperWick > lowerWick * 1.5) psychology = 'rally-sold'
    else if (body < 0.2) psychology = 'indecision'
    const tier = causeMag >= 0.35 ? 'strong' : causeMag >= 0.15 ? 'moderate' : 'weak'
    const label = causeMag < 0.15 ? 'quiet' : !otc && volRatio > 1.3 && sgn(cause) !== dir && dir !== 0 && sizeAtr < 0.8 ? 'absorption' : `${cause > 0 ? 'buying' : 'selling'}-pressure-${tier}`
    out.push({ cause, causeDir: causeMag < 0.15 ? 0 : sgn(cause), causeMag, volRatio, fpDelta, tickImb, mfi: mfiV, pathEff: tp.eff, run, speed, expand, adSlope, effect, effectDir: dir, sizeAtr, upperWick, lowerWick, body, roc: rocV, cci: cciV, psychology, label })
  }
  return out
}

function bucketKey(b: CeBar): string {
  const tier = b.causeMag >= 0.35 ? 'S' : b.causeMag >= 0.15 ? 'M' : 'W'
  return `${b.causeDir}|${tier}|${b.effectDir === b.causeDir ? 'paid' : b.effectDir === 0 ? 'flat' : 'unpaid'}`
}

interface Acc { n: number; up: number; mv: number }
function addTo(m: Map<string, Acc>, key: string, nextUp: boolean, moveAtr: number) { const a = m.get(key) ?? { n: 0, up: 0, mv: 0 }; a.n++; if (nextUp) a.up++; a.mv += moveAtr; m.set(key, a) }

function predictFrom(m: Map<string, Acc>, key: string, minN: number): { prob: number; move: number; n: number } {
  const a = m.get(key)
  if (!a || a.n < minN) return { prob: 0.5, move: 0, n: a?.n ?? 0 }
  const k = 10
  return { prob: (a.up + 0.5 * k) / (a.n + k), move: a.mv / a.n, n: a.n }
}

/** S/R from fractal pivots of the closed bars, clustered within 0.25 ATR; retest = the latest bar(s) touched a level and closed back on its side. */
function readSr(c: CeCandle[], atr: number, strength: number) {
  const n = c.length, pts: number[] = []
  for (let i = strength; i < n - strength; i++) {
    let hiP = true, loP = true
    for (let j = 1; j <= strength; j++) { if (c[i].high <= c[i - j].high || c[i].high <= c[i + j].high) hiP = false; if (c[i].low >= c[i - j].low || c[i].low >= c[i + j].low) loP = false }
    if (hiP) pts.push(c[i].high)
    if (loP) pts.push(c[i].low)
  }
  pts.sort((a, b) => a - b)
  const clusters: { p: number; t: number }[] = []
  for (const p of pts) { const l = clusters[clusters.length - 1]; if (l && Math.abs(p - l.p) <= 0.25 * atr) { l.p = (l.p * l.t + p) / (l.t + 1); l.t++ } else clusters.push({ p, t: 1 }) }
  const last = c[n - 1], px = last.close
  const below = clusters.filter((x) => x.p <= px).sort((a, b) => b.p - a.p)[0], above = clusters.filter((x) => x.p > px).sort((a, b) => a.p - b.p)[0]
  const support = below?.p ?? NaN, resistance = above?.p ?? NaN
  const supDist = Number.isFinite(support) ? (px - support) / atr : 99, resDist = Number.isFinite(resistance) ? (resistance - px) / atr : 99
  // retest: last bar's range reached within 0.25 ATR of a level of >=2 touches and closed on the right side of it
  let retest = 0, retestLevel = NaN, retestTouches = 0
  for (const cl of clusters) {
    if (cl.t < 2) continue
    const touched = last.low <= cl.p + 0.25 * atr && last.high >= cl.p - 0.25 * atr
    if (!touched) continue
    if (cl.p <= px && last.close > cl.p && last.low <= cl.p + 0.25 * atr) { if (cl.t > retestTouches) { retest = 1; retestLevel = cl.p; retestTouches = cl.t } }
    else if (cl.p > px && last.close < cl.p && last.high >= cl.p - 0.25 * atr) { if (cl.t > retestTouches) { retest = -1; retestLevel = cl.p; retestTouches = cl.t } }
  }
  return { support, resistance, supDist, resDist, atSupport: supDist <= 0.5, atResistance: resDist <= 0.5, retest, retestLevel, retestTouches }
}

export function readCauseEffect(candles: CeCandle[], ticks?: readonly CeTick[], opts: CeOptions = {}): CeResult {
  const minHistory = opts.minHistory ?? 60, trackN = opts.track ?? 60, srStrength = opts.srStrength ?? 2
  const empty = (error: string): CeResult => ({ ok: false, error, cause: { dir: 0, mag: 0, label: 'unknown', volRatio: NaN, fpDelta: NaN, tickImb: NaN, mfi: NaN, adSlope: NaN, ticksUsed: false }, effect: { dir: 0, sizeAtr: NaN, psychology: 'unknown', upperWick: NaN, lowerWick: NaN, body: NaN, roc: NaN, cci: NaN }, validation: { coherence: NaN, coherenceN: 0, bucketN: 0, bucketUpProb: 0.5, bucketMoveAtr: 0, trackN: 0, trackHit: NaN, validated: false, key: '' }, sr: { support: NaN, resistance: NaN, supDist: 99, resDist: 99, atSupport: false, atResistance: false, retest: 0, retestLevel: NaN, retestTouches: 0 }, pm: { dir: 'none', sign: 0, prob: 0.5, moveAtr: 0, confidence: 0, price: NaN }, text: error, bars: [] })
  const c = candles.filter((x) => x && [x.time, x.open, x.high, x.low, x.close].every((v) => Number.isFinite(v)))
  if (c.length < minHistory) return empty(`needs ${minHistory} closed bars, have ${c.length}`)
  const otc = !!opts.otc
  const f = featuresFor(c, ticks, otc)
  const n = c.length, last = f[n - 1]
  const atrArr = atrInd(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 14)
  const atrOf = (i: number) => (Number.isFinite(atrArr[i]) && atrArr[i] > 0 ? atrArr[i] : c[i].high - c[i].low || 1)
  const next = (i: number) => (c[i + 1].close - c[i].close) / atrOf(i)
  // bucket stats + walk-forward: at bar t only pairs (j, j+1) with j+1 <= t-... i.e. j+1 < t are known when predicting bar t+1
  const book = new Map<string, Acc>()
  const track = { n: 0, hit: 0 }
  const warm = 25, minN = 8
  const tStart = Math.max(warm, n - 1 - trackN)
  for (let j = 0; j + 1 < n; j++) {
    // before adding pair j (outcome known at j+1), predict bar j+1 from pairs < j only if j in track window
    if (j >= tStart && j + 1 <= n - 1) {
      const p = predictFrom(book, bucketKey(f[j]), minN)
      if (p.n >= minN && Math.abs(p.prob - 0.5) >= 0.04) { const up = c[j + 1].close > c[j].close, flat = c[j + 1].close === c[j].close; if (!flat) { track.n++; if ((p.prob > 0.5) === up) track.hit++ } }
    }
    addTo(book, bucketKey(f[j]), c[j + 1].close > c[j].close, next(j))
  }
  // the book now includes the pair (n-2, n-1); the CURRENT bar n-1 has no known next, so predicting from it uses everything before
  const key = bucketKey(last)
  const pr = predictFrom(book, key, minN)
  // coherence: how often did the cause's direction match the same candle's direction (when cause was not quiet)
  let co = 0, coN = 0
  for (let i = Math.max(0, n - 100); i < n; i++) if (f[i].causeDir !== 0 && f[i].effectDir !== 0) { coN++; if (f[i].causeDir === f[i].effectDir) co++ }
  const coherence = coN ? co / coN : NaN
  const a = atrOf(n - 1)
  const sr = readSr(c, a, srStrength)
  // predicted move: history prior (shrunk) + the live cause as a small tilt + S/R adjustment
  let score = (pr.prob - 0.5) * 2 + 0.25 * last.cause * (last.effectDir === last.causeDir || last.effectDir === 0 ? 1 : -0.5)
  if (sr.atSupport) score += 0.12
  if (sr.atResistance) score -= 0.12
  if (sr.retest === 1) score += 0.15
  if (sr.retest === -1) score -= 0.15
  if (sr.resDist < 0.35 && score > 0) score *= 0.6
  if (sr.supDist < 0.35 && score < 0) score *= 0.6
  const trackHit = track.n ? track.hit / track.n : NaN
  const validated = otc ? track.n >= 40 && trackHit > 0.55 : track.n >= 20 && trackHit > 0.52
  const prob = clamp(0.5 + score / 2, 0.05, 0.95)
  let confidence = Math.round(clamp(Math.abs(score) * 70 + (validated ? 15 : 0) + (pr.n >= 20 ? 5 : 0) - (Number.isFinite(coherence) && coherence < 0.5 ? 15 : 0), 0, 100))
  const dir: 'call' | 'put' | 'none' = Math.abs(score) < 0.1 || pr.n < minN ? 'none' : score > 0 ? 'call' : 'put'
  if (dir === 'none') confidence = Math.min(confidence, 30)
  const moveAtr = pr.n >= minN ? pr.move : 0
  const ticksUsed = Number.isFinite(last.tickImb)
  const text0 = `Cause: ${last.label} (volume x${last.volRatio.toFixed(2)}, footprint delta ${last.fpDelta.toFixed(2)}${ticksUsed ? `, ticks ${last.tickImb.toFixed(2)}` : ', no tick data'}, MFI ${last.mfi.toFixed(2)}, A/D ${last.adSlope.toFixed(2)}). Effect: ${last.effectDir > 0 ? 'bullish' : last.effectDir < 0 ? 'bearish' : 'flat'} candle ${last.sizeAtr.toFixed(2)} ATR, ${last.psychology}, ROC3 ${last.roc.toFixed(3)}%, CCI ${last.cci.toFixed(0)}. History: ${pr.n} similar cases, next bar up ${(pr.prob * 100).toFixed(0)}%; walk-forward ${track.n ? `${(trackHit * 100).toFixed(0)}% of ${track.n}` : 'n/a'}. ${sr.retest ? `Retest of ${sr.retest > 0 ? 'support' : 'resistance'} (${sr.retestTouches} touches). ` : ''}Predicted move: ${dir === 'none' ? 'no call' : dir.toUpperCase()} (${(prob * 100).toFixed(0)}%, confidence ${confidence}${validated ? ', validated' : ', unvalidated'}).`
  const text = otc ? `[OTC mode: no volume] ` + text0.replace(/\(volume x[^)]*\)/, `(ticks ${ticksUsed ? last.tickImb.toFixed(2) : 'n/a'}, path ${Number.isFinite(last.pathEff) ? last.pathEff.toFixed(2) : 'n/a'}, run ${last.run.toFixed(2)}, expansion ${last.expand.toFixed(2)}, tick speed x${last.speed.toFixed(2)})`) : text0
  return {
    ok: true,
    cause: { dir: last.causeDir, mag: last.causeMag, label: last.label, volRatio: last.volRatio, fpDelta: last.fpDelta, tickImb: last.tickImb, mfi: last.mfi, adSlope: last.adSlope, ticksUsed, otc, pathEff: last.pathEff, run: last.run, speed: last.speed, expand: last.expand },
    effect: { dir: last.effectDir, sizeAtr: last.sizeAtr, psychology: last.psychology, upperWick: last.upperWick, lowerWick: last.lowerWick, body: last.body, roc: last.roc, cci: last.cci },
    validation: { coherence, coherenceN: coN, bucketN: pr.n, bucketUpProb: pr.prob, bucketMoveAtr: pr.move, trackN: track.n, trackHit, validated, key },
    sr,
    pm: { dir, sign: dir === 'call' ? 1 : dir === 'put' ? -1 : 0, prob, moveAtr, confidence, price: c[n - 1].close },
    text,
    bars: f,
  }
}

export interface CeMtf {
  ok: boolean
  htfTf: string
  htfOk: boolean
  alignment: 'aligned' | 'conflict' | 'wait-for-trigger' | 'trigger-only' | 'no-htf' | 'no-call'
  dir: 'call' | 'put' | 'none'
  lean: 'call' | 'put' | 'none'
  prob: number
  strength: number
  triggerWithHtf: boolean
  trigger: CeResult
  htf: CeResult | null
  text: string
}

/** Blend the trigger timeframe's predicted move with a HIGHER timeframe's (default 5m for a 1m trigger). Agree = stronger; opposite = no call; the higher frame alone = wait for the trigger.
 * `triggerWithHtf` says whether the trigger's own latest candle is moving the way the higher frame's prediction points (how the 1m is behaving relative to the 5m). */
export function combineCeMtf(trigger: CeResult, htf: CeResult | null, htfTf: string): CeMtf {
  const sc = (r: CeResult) => r.pm.sign * Math.abs(r.pm.prob - 0.5) * 2
  const htfOk = !!htf && htf.ok
  const base = { htfTf, htfOk, trigger, htf }
  if (!trigger.ok) return { ...base, ok: false, alignment: 'no-call', dir: 'none', lean: 'none', prob: 0.5, strength: 0, triggerWithHtf: false, text: trigger.text }
  const tw = htfOk && htf!.pm.sign !== 0 && trigger.effect.dir === htf!.pm.sign
  const name = (s: number) => (s > 0 ? 'call' : s < 0 ? 'put' : 'none') as 'call' | 'put' | 'none'
  let alignment: CeMtf['alignment'], dir: 'call' | 'put' | 'none', lean: 'call' | 'put' | 'none', score: number, strength: number
  if (!htfOk) { alignment = 'no-htf'; dir = trigger.pm.dir; lean = dir; score = sc(trigger); strength = Math.round(trigger.pm.confidence * 0.85) }
  else if (trigger.pm.sign !== 0 && htf!.pm.sign === trigger.pm.sign) { alignment = 'aligned'; dir = trigger.pm.dir; lean = dir; score = 0.6 * sc(trigger) + 0.4 * sc(htf!); strength = Math.min(100, Math.round(trigger.pm.confidence * 0.65 + htf!.pm.confidence * 0.35 + 10 + (tw ? 5 : 0))) }
  else if (trigger.pm.sign !== 0 && htf!.pm.sign !== 0) { alignment = 'conflict'; dir = 'none'; lean = name(htf!.pm.sign); score = 0; strength = Math.round(Math.min(trigger.pm.confidence, htf!.pm.confidence) * 0.4) }
  else if (trigger.pm.sign === 0 && htf!.pm.sign !== 0) { alignment = 'wait-for-trigger'; dir = 'none'; lean = name(htf!.pm.sign); score = 0; strength = Math.round(htf!.pm.confidence * 0.4) }
  else if (trigger.pm.sign !== 0) { alignment = 'trigger-only'; dir = trigger.pm.dir; lean = dir; score = sc(trigger); strength = Math.round(trigger.pm.confidence * 0.8) }
  else { alignment = 'no-call'; dir = 'none'; lean = 'none'; score = 0; strength = 0 }
  const prob = clamp(0.5 + score / 2, 0.05, 0.95)
  const text = `${htfOk ? `${htfTf}: ${htf!.pm.dir === 'none' ? 'no call' : htf!.pm.dir.toUpperCase() + ' ' + (htf!.pm.prob * 100).toFixed(0) + '%'} (cause ${htf!.cause.label}${htf!.validation.validated ? ', validated' : ''}). ` : `${htfTf} unavailable. `}Trigger: ${trigger.pm.dir === 'none' ? 'no call' : trigger.pm.dir.toUpperCase() + ' ' + (trigger.pm.prob * 100).toFixed(0) + '%'}${htfOk ? `, its last candle is ${tw ? 'moving with' : htf!.pm.sign === 0 ? 'unrelated to' : 'against'} the ${htfTf} prediction` : ''}. Combined: ${alignment}${dir !== 'none' ? ` ${dir.toUpperCase()} ${(prob * 100).toFixed(0)}%` : lean !== 'none' ? ` (leans ${lean})` : ''}, strength ${strength}/100.`
  return { ...base, ok: true, alignment, dir, lean, prob, strength, triggerWithHtf: tw, text }
}
