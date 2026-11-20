// IQAIR//OS - HEIKIN ASHI PREDICTOR, built to be a FILTER for the pm (cause -> effect predicted move).
// Heikin Ashi candles average the last bar into the current one, so a run of same-coloured HA candles with no wick on the starting side reads as a clean push, and a small body with both wicks as hesitation.
// Two readings come out, and a strategy can use either or both as a pm filter:
//   COLOR   - what the HA candle says right now: colour, streak length, strength (strong = no wick on the starting side, weak = doji-like), and whether it just flipped.
//   PREDICT - what has FOLLOWED the same HA state on this pair: for each state (colour x streak x strength) the walk-forward odds that the next REAL candle closes up, hierarchically shrunk
//             (state -> colour+streak -> 50%) so a rare state leans on its parent instead of its own handful of cases. Built only from bars whose outcome was already known: no look-ahead.
// FILTER  - allowCall / allowPut for a pm direction: `color` (HA agrees and is not a doji), `predict` (the learned odds lean the same way), or `both`.
// HONESTY: HA is a smoothed transform of the same candles pm already reads, so agreement is weaker evidence than it looks, and a smoothed candle LAGS: it tends to confirm a move after it began.
// Whether it helps THIS pm on THIS pair is an empirical question: reportHaFilter() splits pm's own walk-forward calls by HA agreement and tests the difference. Do not assume it filters losses.

import { readCauseEffect, type CeCandle, type CeTick } from './causeeffect'

export interface HaOptions { otc?: boolean; mode?: 'color' | 'predict' | 'both' }
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const K = 10

export interface HaBar { open: number; high: number; low: number; close: number }
export function heikinAshi(c: CeCandle[]): HaBar[] {
  const out: HaBar[] = []
  for (let i = 0; i < c.length; i++) {
    const close = (c[i].open + c[i].high + c[i].low + c[i].close) / 4
    const open = i === 0 ? (c[0].open + c[0].close) / 2 : (out[i - 1].open + out[i - 1].close) / 2
    out.push({ open, close, high: Math.max(c[i].high, open, close), low: Math.min(c[i].low, open, close) })
  }
  return out
}

type Strength = 'strong' | 'normal' | 'weak'
interface HaState { color: 1 | -1; streak: number; strength: Strength; bodyRatio: number; flipped: boolean; key: string; parent: string }
function states(c: CeCandle[]): { ha: HaBar[]; st: HaState[] } {
  const ha = heikinAshi(c), st: HaState[] = []
  let streak = 0, prev = 0
  for (let i = 0; i < ha.length; i++) {
    const b = ha[i], rng = b.high - b.low, body = Math.abs(b.close - b.open), color = (b.close >= b.open ? 1 : -1) as 1 | -1
    streak = color === prev ? streak + 1 : 1; prev = color
    const bodyRatio = rng > 0 ? body / rng : 0
    const startWick = color === 1 ? b.open - b.low : b.high - b.open // the wick on the side the candle started from
    const flat = rng > 0 && startWick / rng <= 0.05
    const strength: Strength = bodyRatio < 0.25 ? 'weak' : flat && bodyRatio >= 0.5 ? 'strong' : 'normal'
    const sb = Math.min(streak, 5)
    st.push({ color, streak, strength, bodyRatio, flipped: streak === 1 && i > 0, key: `${color}|${sb}|${strength}`, parent: `${color}|${sb}` })
  }
  return { ha, st }
}

interface Cnt { n: number; up: number }
const shrinkTo = (h: Cnt | undefined, prior: number) => (((h?.up ?? 0) + K * prior) / ((h?.n ?? 0) + K))

export interface HaResult {
  ok: boolean; error?: string
  ha: { color: 'bull' | 'bear'; sign: number; streak: number; strength: Strength; bodyRatio: number; flipped: boolean; state: string }
  pred: { dir: 'call' | 'put' | 'none'; pUp: number; edge: number; keepProb: number; n: number; relation: 'continuation' | 'reversal' | 'none'; validated: boolean; trackN: number; trackHit: number }
  allow: { color: { call: boolean; put: boolean }; predict: { call: boolean; put: boolean }; both: { call: boolean; put: boolean } }
  text: string
}

/** `pUp` for each bar i is built from counts of bars < i only (outcome of bar j is known at j+1). Also returns the walk-forward track record. */
export function readHa(candles: CeCandle[], opts: HaOptions = {}): HaResult {
  const c = candles.filter((x) => x && [x.time, x.open, x.high, x.low, x.close].every((v) => Number.isFinite(v))).slice(-1600)
  const fail = (error: string): HaResult => ({ ok: false, error, ha: { color: 'bull', sign: 0, streak: 0, strength: 'normal', bodyRatio: 0, flipped: false, state: '' }, pred: { dir: 'none', pUp: 0.5, edge: 0, keepProb: 0.5, n: 0, relation: 'none', validated: false, trackN: 0, trackHit: NaN }, allow: { color: { call: false, put: false }, predict: { call: false, put: false }, both: { call: false, put: false } }, text: error })
  if (c.length < 120) return fail(`needs 120 closed bars, have ${c.length}`)
  const { st } = states(c), n = c.length, t = n - 1, otc = !!opts.otc
  const full = new Map<string, Cnt>(), par = new Map<string, Cnt>(), keep = new Map<string, Cnt>()
  let allN = 0, allUp = 0, trackN = 0, trackHit = 0
  const probAt = (s: HaState) => { const root = allN ? allUp / allN : 0.5, p1 = shrinkTo(par.get(s.parent), root), pu = shrinkTo(full.get(s.key), p1); return { pu, n: full.get(s.key)?.n ?? 0 } }
  for (let j = 1; j < n; j++) { // j = the bar whose next candle we ask about; add (j-1) AFTER predicting j would be look-ahead, so we add j-1 -> j outcome first
    const s0 = st[j - 1], up = c[j].close > c[j - 1].close; if (c[j].close === c[j - 1].close) continue
    if (j >= 60) { const pr = probAt(s0); /* prediction made at bar j-1 about bar j, from counts of earlier bars only */ if (Math.abs(pr.pu - 0.5) >= 0.03 && j < n) { trackN++; if ((pr.pu > 0.5) === up) trackHit++ } }
    for (const [m, k, v] of [[full, s0.key, up], [par, s0.parent, up]] as [Map<string, Cnt>, string, boolean][]) { const h = m.get(k) ?? { n: 0, up: 0 }; h.n++; if (v) h.up++; m.set(k, h) }
    const kp = keep.get(s0.key) ?? { n: 0, up: 0 }; kp.n++; if ((st[j].color === s0.color)) kp.up++; keep.set(s0.key, kp)
    allN++; if (up) allUp++
  }
  const cur = st[t], pr = probAt(cur), root = allN ? allUp / allN : 0.5
  const pUp = pr.pu, edge = pUp - 0.5
  const dir: 'call' | 'put' | 'none' = Math.abs(edge) >= 0.03 ? (edge > 0 ? 'call' : 'put') : 'none'
  const keepProb = shrinkTo(keep.get(cur.key), 0.5)
  const trackRate = trackN ? trackHit / trackN : NaN
  const validated = otc ? trackN >= 40 && trackRate > 0.55 : trackN >= 30 && trackRate > 0.52
  const relation = dir === 'none' ? 'none' : (dir === 'call') === (cur.color === 1) ? 'continuation' : 'reversal'
  const colorOk = (d: 1 | -1) => cur.color === d && cur.strength !== 'weak'
  const predOk = (d: 1 | -1) => d === 1 ? edge >= 0.02 : edge <= -0.02
  const allow = { color: { call: colorOk(1), put: colorOk(-1) }, predict: { call: predOk(1), put: predOk(-1) }, both: { call: colorOk(1) && predOk(1), put: colorOk(-1) && predOk(-1) } }
  const bull = cur.color === 1
  const text = `HA: ${cur.streak} ${bull ? 'bull' : 'bear'} candle${cur.streak > 1 ? 's' : ''} in a row, ${cur.strength}${cur.strength === 'strong' ? ` (no ${bull ? 'lower' : 'upper'} wick)` : cur.strength === 'weak' ? ' (small body, hesitation)' : ''}${cur.flipped ? ', just flipped' : ''}. `
    + (pr.n >= 10 ? `After this state on this pair the next candle closed up ${(pUp * 100).toFixed(0)}% (${pr.n} cases${root ? `, ${(root * 100).toFixed(0)}% overall` : ''}), HA kept its colour ${(keepProb * 100).toFixed(0)}% -> ${dir === 'none' ? 'no lean' : `${dir.toUpperCase()} (${relation})`}. ` : `Only ${pr.n} past cases of this exact state, so it leans on the broader ${bull ? 'bull' : 'bear'} ${Math.min(cur.streak, 5)}-streak: ${(pUp * 100).toFixed(0)}% up. `)
    + (trackN ? `Walk-forward ${(trackRate * 100).toFixed(0)}% over ${trackN} calls${validated ? ' (validated)' : ' (not beating chance yet)'}.` : 'No walk-forward record yet.')
  return { ok: true, ha: { color: bull ? 'bull' : 'bear', sign: cur.color, streak: cur.streak, strength: cur.strength, bodyRatio: cur.bodyRatio, flipped: cur.flipped, state: cur.key }, pred: { dir, pUp, edge, keepProb, n: pr.n, relation, validated, trackN, trackHit: trackRate }, allow, text }
}

/** the filter verdict for one pm direction: does HA let it through, and why */
export function haFilter(r: HaResult, pmDir: string, mode: 'color' | 'predict' | 'both' = 'color'): { pass: boolean; stance: 'with' | 'against' | 'neutral'; reason: string } {
  if (!r.ok) return { pass: false, stance: 'neutral', reason: r.error ?? 'HA unavailable' }
  if (pmDir !== 'call' && pmDir !== 'put') return { pass: false, stance: 'neutral', reason: 'pm has no direction to filter' }
  const a = r.allow[mode][pmDir]
  const s = pmDir === 'call' ? 1 : -1
  const stance = r.ha.strength === 'weak' ? 'neutral' : r.ha.sign === s ? 'with' : 'against'
  const why = mode === 'color' ? (a ? `HA is ${r.ha.color} (${r.ha.strength}), same side` : r.ha.strength === 'weak' ? 'HA is a doji-like candle: no push either way' : `HA is ${r.ha.color}, against it`)
    : mode === 'predict' ? (a ? `the learned HA odds lean ${pmDir} (${(r.pred.pUp * 100).toFixed(0)}% up)` : `the learned HA odds do not lean ${pmDir} (${(r.pred.pUp * 100).toFixed(0)}% up)`)
      : (a ? 'HA colour and learned odds both agree' : 'HA colour and the learned odds do not both agree')
  return { pass: a, stance, reason: why }
}

// =============================== does it actually filter pm? ===============================
export interface HaGroup { n: number; hit: number; rate: number | null }
export interface HaFilterReport { ok: boolean; error?: string; bars: number; step: number; groups: Record<string, HaGroup>; verdict: string }
/** Re-runs pm (readCauseEffect, no look-ahead) every `step` bars and splits its calls by what HA said at that moment. hit = the next candle closed in pm's direction. */
export function reportHaFilter(candles: CeCandle[], ticks: readonly CeTick[] | undefined, opts: HaOptions & { step?: number; from?: number } = {}): HaFilterReport {
  const step = Math.max(1, Math.round(opts.step ?? 4)), from = Math.max(200, opts.from ?? 200), n = candles.length
  const groups: Record<string, HaGroup> = {}
  const add = (k: string, ok: boolean) => { const g = (groups[k] ??= { n: 0, hit: 0, rate: null }); g.n++; if (ok) g.hit++ }
  if (n < from + 20) return { ok: false, error: `needs ${from + 20} bars, have ${n}`, bars: n, step, groups, verdict: '' }
  // HA states once; predictor re-read per sampled bar from the prefix (cheap: one pass)
  for (let t = from; t < n - 1; t += step) {
    if (candles[t + 1].close === candles[t].close) continue
    const sl = candles.slice(0, t + 1)
    const ce = readCauseEffect(sl, ticks ? ticks.filter((x) => x.ts < (candles[t].time + 60) * 1000) : undefined, { otc: opts.otc })
    if (!ce.ok || ce.pm.dir === 'none') continue
    const d = ce.pm.dir, right = (d === 'call') === (candles[t + 1].close > candles[t].close), h = readHa(sl, { otc: opts.otc })
    if (!h.ok) continue
    add('pm alone', right)
    const f = haFilter(h, d, 'color')
    add(`pm + HA colour ${f.stance}`, right)
    if (haFilter(h, d, 'predict').pass) add('pm + HA odds agree', right); else add('pm + HA odds do not agree', right)
    if (haFilter(h, d, 'both').pass) add('pm + both agree', right); else add('pm + not both', right)
  }
  for (const g of Object.values(groups)) g.rate = g.n ? g.hit / g.n : null
  const base = groups['pm alone']
  const cmp = (k: string): string => {
    const g = groups[k]; if (!g || !base || g.n < 30 || base.rate === null || g.rate === null) return `${k}: too few (${g?.n ?? 0})`
    const se = Math.sqrt((base.rate * (1 - base.rate)) / g.n), z = se > 0 ? (g.rate - base.rate) / se : 0
    return `${k}: ${(g.rate * 100).toFixed(0)}% of ${g.n} vs ${(base.rate * 100).toFixed(0)}% pm alone (z ${z.toFixed(1)})`
  }
  const g = (k: string) => groups[k], zOf = (k: string) => { const x = g(k); if (!x || !base || x.n < 30 || x.rate === null || base.rate === null) return null; const se = Math.sqrt((base.rate * (1 - base.rate)) / x.n); return se > 0 ? (x.rate - base.rate) / se : 0 }
  const zs = ['pm + HA colour with', 'pm + HA odds agree', 'pm + both agree'].map((k) => [k, zOf(k)] as const).filter((x) => x[1] !== null)
  const helped = zs.filter((x) => (x[1] as number) >= 2), against = zOf('pm + HA colour against')
  const verdict = !base || base.n < 60 ? 'Too few pm calls to judge (need 60+). Use a longer history or a smaller step.'
    : helped.length ? `HA looks like a useful pm filter on this history: ${helped.map((x) => x[0]).join(', ')} beat pm alone by z>=2. ${against !== null && against <= -2 ? 'Calls AGAINST the HA colour did clearly worse, so blocking them also helps.' : ''}`
      : against !== null && against <= -2 ? 'Calls against the HA colour did clearly worse than pm alone, so using HA to BLOCK against-colour calls helps, but agreeing with it adds nothing measurable.'
        : 'No clear difference: HA did not measurably separate pm\'s good calls from its bad ones on this history. Do not rely on it as a filter here.'
  return { ok: true, bars: n, step, groups, verdict: verdict + ' | ' + ['pm + HA colour with', 'pm + HA colour against', 'pm + HA colour neutral', 'pm + HA odds agree', 'pm + both agree'].map(cmp).join(' | ') }
}
