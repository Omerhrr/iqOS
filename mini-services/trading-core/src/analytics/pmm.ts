// IQAIR//OS - PMM: the predicted move (pm) with MARKET STRUCTURE. pm already knows the nearest support / resistance; PMM adds the swing map: every confirmed swing high and low, labelled against the one before it
// (HH higher high, LH lower high, EH equal high; HL higher low, LL lower low, EL equal low), the structure those labels spell (uptrend HH+HL, downtrend LH+LL, expanding, contracting, mixed), breaks of that structure
// (BOS = a close through the swing WITH the trend, CHoCH = a close through the swing that was holding the trend up/down), and the swings that sit in price's way (the "places to go against").
// pm gives the direction; PMM then asks whether the structure allows it:
//   BLOCKS  a call right under a swing high (or a put right over a swing low); a call against a standing downtrend (put against an uptrend) unless pm is strong enough to fight it or the structure just broke the other way;
//           a call at the very top of the swing range (put at the bottom).
//   BOOSTS  buying the higher low / selling the lower high of a trend, a fresh BOS or CHoCH in the call's direction, plenty of room before the next swing.
// HONESTY: the weights are judgement, not fitted. Swings are only confirmed `k` bars after they form, so the newest structure is always `k` bars late. reportPmm() splits pm's own walk-forward calls by what PMM says and
// tests the difference: use it on the pair before trusting the filter.
import { readCauseEffect, type CeCandle, type CeTick } from './causeeffect'

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
export interface PmmSwing { i: number; price: number; kind: 'H' | 'L'; label: 'HH' | 'LH' | 'EH' | 'HL' | 'LL' | 'EL' | '' }
export type PmmStructure = 'uptrend' | 'downtrend' | 'expanding' | 'contracting' | 'mixed' | 'unclear'
export interface PmmWall { price: number; dist: number; label: string; touches: number }
export interface PmmBase { ok: boolean; dir: 'call' | 'put' | 'none'; prob: number; strength: number; alignment?: string }
export interface PmmResult {
  ok: boolean; error?: string
  pmDir: 'call' | 'put' | 'none'; dir: 'call' | 'put' | 'none'; pass: boolean
  prob: number; strength: number; pmProb: number; pmStrength: number
  structure: PmmStructure; sequence: string; lastHigh: string; lastLow: string
  bos: 'up' | 'down' | 'none'; choch: 'up' | 'down' | 'none'; breakAge: number
  rangePos: number // 0 = at the last swing low, 1 = at the last swing high
  wallAbove: PmmWall | null; wallBelow: PmmWall | null; room: number // ATR to the next swing in the call/put direction (99 = none)
  withStructure: boolean; againstStructure: boolean
  blocks: string[]; boosts: string[]; swings: PmmSwing[]; text: string
}
export interface PmmOptions { k?: number; strict?: boolean; fightStrength?: number; tol?: number }

export function readSwings(c: CeCandle[], atr: number, k = 2, tol = 0.1): PmmSwing[] {
  const out: PmmSwing[] = []
  for (let i = k; i < c.length - k; i++) {
    let hi = true, lo = true
    for (let j = 1; j <= k; j++) {
      if (!(c[i].high > c[i - j].high && c[i].high >= c[i + j].high)) hi = false
      if (!(c[i].low < c[i - j].low && c[i].low <= c[i + j].low)) lo = false
    }
    if (hi) out.push({ i, price: c[i].high, kind: 'H', label: '' })
    if (lo) out.push({ i, price: c[i].low, kind: 'L', label: '' })
  }
  out.sort((a, b) => a.i - b.i || (a.kind === 'H' ? -1 : 1))
  let ph: PmmSwing | null = null, pl: PmmSwing | null = null
  for (const s of out) {
    if (s.kind === 'H') { if (ph) { const d = (s.price - ph.price) / atr; s.label = d > tol ? 'HH' : d < -tol ? 'LH' : 'EH' } ph = s }
    else { if (pl) { const d = (s.price - pl.price) / atr; s.label = d > tol ? 'HL' : d < -tol ? 'LL' : 'EL' } pl = s }
  }
  return out
}

function atr14(c: CeCandle[]): number {
  const n = Math.min(14, c.length - 1); if (n < 3) return NaN
  let s = 0; for (let i = c.length - n; i < c.length; i++) s += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
  return s / n
}

/** pure: the structure read + the gate for a given pm direction */
export function readPmm(c: CeCandle[], base: PmmBase, opts: PmmOptions = {}): PmmResult {
  const k = opts.k ?? 2, strict = opts.strict !== false, fight = opts.fightStrength ?? 70
  const empty = (error: string): PmmResult => ({ ok: false, error, pmDir: base.dir, dir: 'none', pass: false, prob: base.prob, strength: base.strength, pmProb: base.prob, pmStrength: base.strength, structure: 'unclear', sequence: '', lastHigh: '', lastLow: '', bos: 'none', choch: 'none', breakAge: 99, rangePos: 0.5, wallAbove: null, wallBelow: null, room: 99, withStructure: false, againstStructure: false, blocks: [], boosts: [], swings: [], text: error })
  if (!base.ok) return empty('pm unavailable')
  if (c.length < 40) return empty(`needs 40 bars, have ${c.length}`)
  const atr = atr14(c); if (!Number.isFinite(atr) || atr <= 0) return empty('ATR unavailable')
  const px = c[c.length - 1].close
  const sw = readSwings(c, atr, k, opts.tol ?? 0.1)
  const highs = sw.filter((s) => s.kind === 'H'), lows = sw.filter((s) => s.kind === 'L')
  if (highs.length < 2 || lows.length < 2) return empty('not enough swings yet')
  const H = highs[highs.length - 1], H0 = highs[highs.length - 2], L = lows[lows.length - 1], L0 = lows[lows.length - 2]
  const hh = H.price > H0.price + 0.1 * atr, lh = H.price < H0.price - 0.1 * atr, hl = L.price > L0.price + 0.1 * atr, ll = L.price < L0.price - 0.1 * atr
  const structure: PmmStructure = hh && hl ? 'uptrend' : lh && ll ? 'downtrend' : hh && ll ? 'expanding' : lh && hl ? 'contracting' : 'mixed'
  // breaks: the swing that was HOLDING the trend (last HL in an uptrend / last LH in a downtrend) = CHoCH; the swing it was trying to take out = BOS
  let bos: 'up' | 'down' | 'none' = 'none', choch: 'up' | 'down' | 'none' = 'none', breakAge = 99
  const scan = Math.min(4, c.length - 1)
  for (let b = 0; b < scan; b++) {
    const cl = c[c.length - 1 - b].close, prev = c[c.length - 2 - b]?.close ?? cl
    const upThrough = (lvl: number) => cl > lvl && prev <= lvl, downThrough = (lvl: number) => cl < lvl && prev >= lvl
    if (structure === 'uptrend') { if (upThrough(H.price)) { bos = 'up'; breakAge = b; break } if (downThrough(L.price)) { choch = 'down'; breakAge = b; break } }
    else if (structure === 'downtrend') { if (downThrough(L.price)) { bos = 'down'; breakAge = b; break } if (upThrough(H.price)) { choch = 'up'; breakAge = b; break } }
    else { if (upThrough(H.price)) { bos = 'up'; breakAge = b; break } if (downThrough(L.price)) { bos = 'down'; breakAge = b; break } }
  }
  const range = Math.max(H.price, L.price) - Math.min(H.price, L.price)
  const rangePos = range > 0 ? clamp((px - Math.min(H.price, L.price)) / range, 0, 1) : 0.5
  const wall = (kind: 'H' | 'L'): PmmWall | null => {
    const list = sw.filter((s) => s.kind === kind && (kind === 'H' ? s.price > px : s.price < px)).slice(-10)
    if (!list.length) return null
    const near = list.reduce((a, b) => (Math.abs(b.price - px) < Math.abs(a.price - px) ? b : a))
    const touches = list.filter((s) => Math.abs(s.price - near.price) <= 0.25 * atr).length
    return { price: near.price, dist: Math.abs(near.price - px) / atr, label: near.label, touches }
  }
  const wallAbove = wall('H'), wallBelow = wall('L')
  const d = base.dir, blocks: string[] = [], boosts: string[] = []
  const seq = sw.slice(-6).map((s) => s.label || s.kind).join(' ')
  let adj = 0, withS = false, againstS = false
  const room = d === 'call' ? (wallAbove?.dist ?? 99) : d === 'put' ? (wallBelow?.dist ?? 99) : 99
  if (d !== 'none') {
    const sgn = d === 'call' ? 1 : -1
    const wl = sgn > 0 ? wallAbove : wallBelow
    if (wl && wl.dist < 0.35) blocks.push(`${d === 'call' ? 'swing high' : 'swing low'}${wl.label ? ' (' + wl.label + ')' : ''} only ${wl.dist.toFixed(2)} ATR ${d === 'call' ? 'above' : 'below'}${wl.touches > 1 ? `, tested ${wl.touches}x` : ''}`)
    else if (wl && wl.dist < 0.8) adj -= 0.03
    const trendDir = structure === 'uptrend' ? 1 : structure === 'downtrend' ? -1 : 0
    const brokeWith = (sgn > 0 ? (bos === 'up' || choch === 'up') : (bos === 'down' || choch === 'down'))
    if (trendDir !== 0 && trendDir !== sgn) {
      againstS = true
      if (brokeWith) { adj += 0.02; boosts.push(`structure just broke ${d === 'call' ? 'up' : 'down'} (${choch !== 'none' ? 'CHoCH' : 'BOS'}, ${breakAge} bar${breakAge === 1 ? '' : 's'} ago)`) }
      else if (strict && base.strength < fight) blocks.push(`${d} against a ${structure} (${structure === 'downtrend' ? 'LH + LL' : 'HH + HL'}) with pm strength ${base.strength} < ${fight}`)
      else adj -= 0.05
    } else if (trendDir === sgn) {
      withS = true; adj += 0.02
      const nearHold = sgn > 0 ? (px - L.price) / atr : (H.price - px) / atr
      if (nearHold >= -0.2 && nearHold <= 0.6) { adj += 0.03; boosts.push(sgn > 0 ? `buying the higher low (${nearHold.toFixed(2)} ATR above it)` : `selling the lower high (${nearHold.toFixed(2)} ATR below it)`) }
      if ((sgn > 0 ? bos === 'up' : bos === 'down') && breakAge <= 2) { adj += 0.03; boosts.push(`fresh BOS ${bos}`) }
    } else if (brokeWith) { adj += 0.03; boosts.push(`${bos !== 'none' ? 'BOS' : 'CHoCH'} ${d === 'call' ? 'up' : 'down'} ${breakAge} bar${breakAge === 1 ? '' : 's'} ago`) }
    if ((sgn > 0 && rangePos > 0.88) || (sgn < 0 && rangePos < 0.12)) { if (!brokeWith) blocks.push(`${d === 'call' ? 'buying' : 'selling'} the ${d === 'call' ? 'top' : 'bottom'} of the swing range (${(rangePos * 100).toFixed(0)}%)`) }
    if (room >= 1.2 && blocks.length === 0) { adj += 0.02; boosts.push(`${room >= 90 ? 'no swing' : room.toFixed(1) + ' ATR'} of room before the next ${d === 'call' ? 'swing high' : 'swing low'}`) }
  }
  const pass = d !== 'none' && blocks.length === 0
  const pr = clamp(base.prob + (d === 'call' ? adj : d === 'put' ? -adj : 0), 0.05, 0.95)
  const st = clamp(Math.round(base.strength + adj * 100), 0, 100)
  const text = d === 'none' ? `PMM: pm has no call. Structure ${structure} (${seq || 'few swings'}).`
    : `PMM ${pass ? d.toUpperCase() + ' allowed' : 'BLOCKED ' + d}: ${blocks.length ? blocks.join('; ') : boosts.length ? boosts.join('; ') : 'structure neutral'}. Structure ${structure} (${seq}); last high ${H.label || 'n/a'}, last low ${L.label || 'n/a'}.`
  return { ok: true, pmDir: d, dir: pass ? d : 'none', pass, prob: pr, strength: st, pmProb: base.prob, pmStrength: base.strength, structure, sequence: seq, lastHigh: H.label, lastLow: L.label, bos, choch, breakAge, rangePos, wallAbove, wallBelow, room, withStructure: withS, againstStructure: againstS, blocks, boosts, swings: sw.slice(-12), text }
}

export interface PmmGroup { n: number; hit: number; rate: number | null }
export interface PmmReport { ok: boolean; error?: string; bars: number; step: number; groups: Record<string, PmmGroup>; verdict: string }
/** does PMM separate pm's good calls from its bad ones? pm's own walk-forward calls (next candle) split by the PMM gate */
export function reportPmm(candles: CeCandle[], ticks: readonly CeTick[] | undefined, opts: PmmOptions & { otc?: boolean; step?: number; from?: number } = {}): PmmReport {
  const step = Math.max(1, Math.round(opts.step ?? 4)), from = Math.max(200, opts.from ?? 200), n = candles.length
  const groups: Record<string, PmmGroup> = {}
  const add = (k: string, ok: boolean) => { const g = (groups[k] ??= { n: 0, hit: 0, rate: null }); g.n++; if (ok) g.hit++ }
  if (n < from + 20) return { ok: false, error: `needs ${from + 20} bars, have ${n}`, bars: n, step, groups, verdict: '' }
  for (let t = from; t < n - 1; t += step) {
    if (candles[t + 1].close === candles[t].close) continue
    const sl = candles.slice(0, t + 1)
    const ce = readCauseEffect(sl, ticks ? ticks.filter((x) => x.ts < (candles[t].time + 60) * 1000) : undefined, { otc: opts.otc })
    if (!ce.ok || ce.pm.dir === 'none') continue
    const right = (ce.pm.dir === 'call') === (candles[t + 1].close > candles[t].close)
    const m = readPmm(sl, { ok: true, dir: ce.pm.dir, prob: ce.pm.prob, strength: ce.pm.confidence }, opts)
    if (!m.ok) continue
    add('pm alone', right)
    if (m.pass) add('pm + PMM allowed', right); else add('pm blocked by PMM', right)
    if (m.pass && m.boosts.length) add('PMM allowed + boosted', right)
    if (m.againstStructure) add('pm against structure', right)
    if (m.withStructure) add('pm with structure', right)
    for (const b of m.blocks) add(`blocked: ${b.startsWith('swing') ? 'wall' : b.includes('against') ? 'against structure' : 'range edge'}`, right)
  }
  for (const g of Object.values(groups)) g.rate = g.n ? g.hit / g.n : null
  const base = groups['pm alone']
  const z = (k: string): number | null => { const g = groups[k]; if (!g || !base || g.n < 30 || g.rate === null || base.rate === null) return null; const se = Math.sqrt((base.rate * (1 - base.rate)) / g.n); return se > 0 ? (g.rate - base.rate) / se : 0 }
  const cmp = (k: string): string => { const g = groups[k]; if (!g || g.n < 30 || g.rate === null || !base || base.rate === null) return `${k}: too few (${g?.n ?? 0})`; return `${k}: ${(g.rate * 100).toFixed(0)}% of ${g.n} vs ${(base.rate * 100).toFixed(0)}% pm alone (z ${(z(k) ?? 0).toFixed(1)})` }
  const allowedZ = z('pm + PMM allowed'), blockedZ = z('pm blocked by PMM')
  const verdict = !base || base.n < 60 ? 'Too few pm calls to judge (need 60+). Use a longer history or a smaller step.'
    : allowedZ !== null && allowedZ >= 2 ? 'PMM looks like a useful pm filter on this history: the calls it allows beat pm alone by z>=2.' + (blockedZ !== null && blockedZ <= -2 ? ' The calls it blocks did clearly worse, so the block is doing real work.' : '')
      : blockedZ !== null && blockedZ <= -2 ? 'The calls PMM blocks did clearly worse than pm alone, so blocking them helps, but the ones it allows are not measurably better.'
        : 'No clear difference: PMM did not measurably separate pm\'s good calls from its bad ones on this history. Do not rely on it as a filter here.'
  return { ok: true, bars: n, step, groups, verdict: verdict + ' | ' + ['pm + PMM allowed', 'pm blocked by PMM', 'PMM allowed + boosted', 'pm with structure', 'pm against structure'].map(cmp).join(' | ') }
}
