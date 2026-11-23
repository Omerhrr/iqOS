// IQAIR//OS - SAGE LIMIT ORDER (`timing.limit`).
//
// Option trading has no limit order. The sage fakes one: after a signal it RESTS at a LEVEL and fires the market trade when price arrives there, instead of buying wherever price happens to be.
// The level is a SMART level, either named by the script (an explicit price) or picked by the sage from the level book it builds on the chart it runs on:
//   ob / breaker / fvg / ifvg   SMC zones (analytics/smc.ts scanSmc, active zones only)
//   demand / supply             the SMC supply-demand zones
//   sr                          SMC support/resistance bands (touched before = a proven level)
//   msnr                        Malaysian SNR: FRESH closing-price peaks/valleys (analytics/msnr.ts, no later close beyond them)
// For a CALL the sage looks for support-type levels at or under price, for a PUT resistance-type levels at or over it, within maxAtr of price.
//
// WHEN IT FIRES (mode):
//   "touch"   the moment price reaches the zone's near edge (fast; a knife that slices straight through is bought).
//   "reject"  (default) price must reach the zone AND turn back out of it by reactAtr - a wick into the level that was refused. Slower, never the knife at the bottom.
// WHEN IT CANCELS: the signal goes away; the time (seconds) runs out; price goes THROUGH the zone (breakAtr past its far edge = the level is broken); or price RUNS AWAY our way (runAtr) without ever
// touching it - the honest cost of waiting, which is MEASURED, not hidden.
// MEMORY: every taken and cancelled case is resolved horizonSec later against price (cancelled ones counterfactually from the arm price), per level KIND. Once a kind has 15+ resolved entries and its shrunk hit
// rate is under 50% the sage stops picking that kind ("learned: ob entries lose here"). timing.limitText() prints the table.
// HONESTY: a level is where price MIGHT react. It describes structure; it is not a promise. Pure state machine with an explicit clock (tests and the replay tester drive it). LIVE / REPLAY only.
import type { Candle } from '../types'
import { scanSmc } from './smc'
import { readMsnr } from './msnr'

export type LimitMode = 'touch' | 'reject'
export type LimitState = 'idle' | 'resting' | 'touched' | 'fired' | 'cancelled'
export type LevelKind = 'ob' | 'fvg' | 'ifvg' | 'breaker' | 'demand' | 'supply' | 'sr' | 'msnr' | 'price'
export interface Level { kind: LevelKind; label: string; edge: number; far: number; touches: number; barsAgo: number }
export interface LimitRec {
  state: LimitState; latched: boolean; armedMs: number; doneMs: number; touchMs: number; dir: number; atr: number; armPrice: number
  level: Level | null; extreme: number; why: string; cls: string; entryGain: number; nextPickMs: number; candidates: number
}
export interface LimitBucket { n: number; w: number }
interface Pending { dueMs: number; px: number; dir: number; bucket: string }

const store = new Map<string, LimitRec>()
const stats = new Map<string, Record<string, LimitBucket>>()
const pending = new Map<string, Pending[]>()
export const limitKey = (prefix: string, name: string): string => `${prefix}|limit|${name}`
export const limitRec = (key: string): LimitRec | undefined => store.get(key)
export const limitStats = (key: string): Record<string, LimitBucket> => stats.get(key) ?? {}
export function clearLimit(prefix: string): void { for (const m of [store, stats, pending] as Array<Map<string, unknown>>) for (const k of m.keys()) if (k.startsWith(`${prefix}|limit|`)) m.delete(k) }
export function hasWaitingLimit(prefix: string): boolean { for (const [k, r] of store) if ((r.state === 'resting' || r.state === 'touched') && k.startsWith(`${prefix}|`)) return true; return false }
const shrunk = (b?: LimitBucket): number => (((b?.w ?? 0) + 1) / ((b?.n ?? 0) + 2))

// ---------- the level book ----------
const KIND_WEIGHT: Record<LevelKind, number> = { ob: 1.0, demand: 1.0, supply: 1.0, breaker: 0.9, fvg: 0.8, ifvg: 0.7, sr: 0.9, msnr: 0.8, price: 1.0 }
const SMC_KIND: Record<string, LevelKind | 'sd'> = { ORDER_BLOCK: 'ob', FVG: 'fvg', IFVG: 'ifvg', BREAKER_BLOCK: 'breaker', SUPPLY_DEMAND: 'sd', SUPPORT_RESISTANCE: 'sr' }

/** Which level kinds a `where` selector allows. "auto" = everything. */
export function kindsFor(where: string): Set<LevelKind> {
  const w = where.toLowerCase()
  const all: LevelKind[] = ['ob', 'fvg', 'ifvg', 'breaker', 'demand', 'supply', 'sr', 'msnr']
  if (w === 'auto' || w === '') return new Set(all)
  if (w === 'smc') return new Set<LevelKind>(['ob', 'fvg', 'ifvg', 'breaker', 'demand', 'supply', 'sr'])
  if (w === 'sd' || w === 'supplydemand') return new Set<LevelKind>(['demand', 'supply'])
  if (w === 'zones') return new Set<LevelKind>(['ob', 'breaker', 'demand', 'supply'])
  if (w === 'sr' || w === 'snr' || w === 'support' || w === 'resistance') return new Set<LevelKind>(['sr', 'msnr'])
  if ((all as string[]).includes(w)) return new Set<LevelKind>([w as LevelKind])
  return new Set(all)
}

/** Every level that could serve a trade in direction `dir` (+1 call: support at/under price; -1 put: resistance at/over it). Pure on the candles; costly (an SMC scan), so callers build it only when arming. */
export function buildLevelBook(candles: Candle[], dir: number, price: number, atr: number): Level[] {
  const out: Level[] = []
  if (!(atr > 0) || !Number.isFinite(price) || candles.length < 40) return out
  const want = dir > 0 ? 'bullish' : 'bearish'
  try {
    const scan = scanSmc(candles)
    for (const sg of scan?.signals ?? []) {
      const k0 = SMC_KIND[sg.kind]
      if (!k0 || !sg.active || sg.direction !== want) continue
      const hi = sg.top ?? sg.level, lo = sg.bottom ?? sg.level
      if (hi === undefined || lo === undefined || !Number.isFinite(hi) || !Number.isFinite(lo) || hi < lo) continue
      const kind: LevelKind = k0 === 'sd' ? (dir > 0 ? 'demand' : 'supply') : k0
      // support zone: price must still be at or above its bottom; resistance zone: at or below its top (price already through = a broken zone, not a level)
      if (dir > 0 ? price < lo : price > hi) continue
      out.push({ kind, label: `${sg.kind}${sg.touches ? ` (${sg.touches} touches)` : ''}`, edge: dir > 0 ? hi : lo, far: dir > 0 ? lo : hi, touches: sg.touches ?? 0, barsAgo: sg.barsAgo })
    }
  } catch { /* an SMC scan failure just means fewer levels */ }
  try {
    const m = readMsnr(candles)
    if (m.ok) for (const lv of m.levels) {
      if (!lv.fresh) continue
      if (dir > 0 ? !(lv.kind === 'V' && lv.price <= price) : !(lv.kind === 'A' && lv.price >= price)) continue
      out.push({ kind: 'msnr', label: lv.kind === 'V' ? 'MSNR fresh valley' : 'MSNR fresh peak', edge: lv.price, far: lv.price, touches: 0, barsAgo: Math.max(0, candles.length - 1 - lv.index) })
    }
  } catch { /* ditto */ }
  return out
}

/** The best level: right side of price, within maxAtr, allowed by `where`, not a kind the sage has learned loses here; scored by kind, proven touches, nearness and (when measured) the kind's own hit rate. */
export function pickLevel(book: Level[], dir: number, price: number, atr: number, where: string, maxAtr: number, kindStats: (k: LevelKind) => LimitBucket | undefined): { level: Level | null; candidates: number; refused: string[] } {
  const allowed = kindsFor(where), refused: string[] = []
  let best: { l: Level; s: number } | null = null, cand = 0
  for (const l of book) {
    if (!allowed.has(l.kind)) continue
    const dist = Math.max(0, dir > 0 ? price - l.edge : l.edge - price) / atr
    if (dist > maxAtr) continue
    const ks = kindStats(l.kind)
    if (ks && ks.n >= 15 && shrunk(ks) < 0.5) { if (!refused.includes(l.kind)) refused.push(l.kind); continue }
    cand++
    const s = KIND_WEIGHT[l.kind] + Math.min(l.touches, 4) * 0.25 - dist * 0.5 - Math.min(l.barsAgo, 100) / 400 + (ks && ks.n >= 5 ? (shrunk(ks) - 0.5) * 2 : 0)
    if (!best || s > best.s) best = { l, s }
  }
  return { level: best ? best.l : null, candidates: cand, refused }
}

// ---------- the resting order ----------
export interface LimitInput {
  key: string; cond: boolean; valid: boolean; dir: number; seconds: number; mode: LimitMode; where: string | number; maxAtr: number
  breakAtr: number; reactAtr: number; runAtr: number; horizonSec: number; nowMs: number; price: number; atr: number
  /** schedule hooks: gate() returns a blocking reason or ''; onFire() counts the trade */
  gate?: () => string; onFire?: () => void
  /** builds the level book (only called when a level is needed) */
  book: () => Level[]
}
const TOUCH_TOL = 0.02

function resolvePending(key: string, nowMs: number, price: number): void {
  const list = pending.get(key); if (!list || !Number.isFinite(price)) return
  const st = stats.get(key) ?? {}, keep: Pending[] = []
  for (const p of list) {
    if (p.dueMs > nowMs) { keep.push(p); continue }
    const d = p.dir * (price - p.px); if (d === 0) continue
    const b = st[p.bucket] ?? (st[p.bucket] = { n: 0, w: 0 }); b.n++; if (d > 0) b.w++
  }
  stats.set(key, st); pending.set(key, keep)
}
function queue(key: string, p: Pending): void { const l = pending.get(key) ?? []; l.push(p); while (l.length > 300) l.shift(); pending.set(key, l) }
const kindHit = (key: string, k: LevelKind): LimitBucket | undefined => {
  const s = stats.get(key); if (!s) return undefined
  const a = s[`take:touch:${k}`], b = s[`take:reject:${k}`]
  return a || b ? { n: (a?.n ?? 0) + (b?.n ?? 0), w: (a?.w ?? 0) + (b?.w ?? 0) } : undefined
}

export function stepLimit(i: LimitInput): { fire: boolean; rec: LimitRec } {
  resolvePending(i.key, i.nowMs, i.price)
  let r = store.get(i.key)
  if (!r) { r = { state: 'idle', latched: false, armedMs: 0, doneMs: 0, touchMs: 0, dir: i.dir, atr: i.atr, armPrice: NaN, level: null, extreme: NaN, why: '', cls: '', entryGain: 0, nextPickMs: 0, candidates: 0 }; store.set(i.key, r) }
  if (r.state === 'fired' && i.nowMs - r.doneMs < 1000) return { fire: true, rec: r }
  if (r.state === 'fired' || r.state === 'cancelled') { if (!i.cond) r.latched = false; if (i.nowMs - r.doneMs >= 1000) r.state = 'idle' }
  if (r.state === 'idle') {
    if (!i.cond) { r.latched = false; return { fire: false, rec: r } }
    if (r.latched || !Number.isFinite(i.price) || i.dir === 0 || !(i.atr > 0) || i.nowMs < r.nextPickMs) return { fire: false, rec: r }
    const blocked = i.gate?.() ?? ''
    if (blocked) { r.why = blocked; return { fire: false, rec: r } }
    let level: Level | null = null, why = 'resting at the level'
    if (typeof i.where === 'number') {
      if (!Number.isFinite(i.where)) return { fire: false, rec: r }
      level = { kind: 'price', label: 'your price', edge: i.where, far: i.where, touches: 0, barsAgo: 0 }
      r.candidates = 1
    } else {
      const picked = pickLevel(i.book(), i.dir, i.price, i.atr, i.where, i.maxAtr, (k) => kindHit(i.key, k))
      r.candidates = picked.candidates
      level = picked.level
      if (!level) { r.nextPickMs = i.nowMs + 4000; r.why = picked.refused.length ? `no usable level (learned to avoid: ${picked.refused.join(', ')})` : `no ${i.where === 'auto' ? '' : i.where + ' '}level within ${i.maxAtr} ATR on the right side of price`; return { fire: false, rec: r } }
      why = `resting at ${level.kind} ${level.label}`
    }
    Object.assign(r, { state: 'resting' as LimitState, armedMs: i.nowMs, doneMs: 0, touchMs: 0, dir: i.dir, atr: i.atr, armPrice: i.price, level, extreme: i.price, why, cls: '', entryGain: 0 })
    // already at the level when armed: handled by the same touch test below on this very evaluation
  }
  if (r.state !== 'resting' && r.state !== 'touched') return { fire: false, rec: r }
  const lv = r.level as Level, a = r.atr, d = r.dir
  const finish = (state: LimitState, why: string): void => { r!.state = state; r!.why = why; r!.doneMs = i.nowMs; r!.latched = true }
  const cancel = (why: string, bucket: string): { fire: boolean; rec: LimitRec } => { queue(i.key, { dueMs: i.nowMs + i.horizonSec * 1000, px: r!.armPrice, dir: d, bucket: `skip:${bucket}:${lv.kind}` }); finish('cancelled', why); return { fire: false, rec: r! } }
  const enter = (cls: string, why: string): { fire: boolean; rec: LimitRec } => { const g = i.gate?.() ?? ''; if (g) { finish('cancelled', `${g} - not entered`); return { fire: false, rec: r! } }; i.onFire?.(); r!.cls = cls; r!.entryGain = -d * (i.price - r!.armPrice) / a; queue(i.key, { dueMs: i.nowMs + i.horizonSec * 1000, px: i.price, dir: d, bucket: `take:${cls}:${lv.kind}` }); finish('fired', why); return { fire: true, rec: r! } }
  // extreme into the level (lowest for a call, highest for a put)
  r.extreme = d > 0 ? Math.min(r.extreme, i.price) : Math.max(r.extreme, i.price)
  if (!i.cond) return cancel('signal gone before the level was reached', r.state === 'touched' ? 'gone-touched' : 'gone')
  const brokenAt = d > 0 ? lv.far - i.breakAtr * a : lv.far + i.breakAtr * a
  if (d > 0 ? i.price <= brokenAt : i.price >= brokenAt) return cancel(`price went through the ${lv.kind} (${i.breakAtr} ATR past its far edge) - the level is broken`, 'broken')
  if (r.state === 'resting' && i.runAtr > 0 && d * (i.price - r.armPrice) / a >= i.runAtr) return cancel(`price ran ${(d * (i.price - r.armPrice) / a).toFixed(2)} ATR our way without touching the level - not chased`, 'runaway')
  if ((i.nowMs - r.armedMs) / 1000 >= i.seconds) return cancel(r.state === 'touched' ? 'touched the level but never turned back out in time' : 'the level was never reached in time', r.state === 'touched' ? 'noreact' : 'expired')
  if (r.state === 'resting') {
    const reached = d > 0 ? i.price <= lv.edge + TOUCH_TOL * a : i.price >= lv.edge - TOUCH_TOL * a
    if (reached) {
      r.state = 'touched'; r.touchMs = i.nowMs
      if (i.mode === 'touch') { if (!i.valid) { r.why = 'touched, but the re-check failed - waiting'; return { fire: false, rec: r } } return enter('touch', `price touched the ${lv.kind} (${lv.label}) - entered at ${(r.entryGain).toFixed(2)} ATR better than the signal price`) }
      r.why = `price reached the ${lv.kind} - waiting for it to be refused`
    }
  }
  if (r.state === 'touched' && i.mode === 'reject') {
    const react = d * (i.price - r.extreme) / a // ATR turned back out off the worst point inside the level
    if (react >= i.reactAtr) {
      if (!i.valid) { r.why = 'turned out of the level, but the re-check failed - waiting'; return { fire: false, rec: r } }
      return enter('reject', `${lv.kind} refused: dipped to ${(d * (r.armPrice - r.extreme) / a).toFixed(2)} ATR under the signal price, turned back ${react.toFixed(2)} ATR - entered`)
    }
  }
  return { fire: false, rec: r }
}

export function limitText(key: string): string {
  const s = stats.get(key) ?? {}
  const rows: string[] = []
  const kinds = new Set<string>()
  for (const k of Object.keys(s)) kinds.add(k.split(':')[2] ?? '')
  for (const kind of kinds) {
    if (!kind) continue
    const t = [s[`take:touch:${kind}`], s[`take:reject:${kind}`]].reduce((a, b) => ({ n: a.n + (b?.n ?? 0), w: a.w + (b?.w ?? 0) }), { n: 0, w: 0 })
    const sk = Object.entries(s).filter(([k]) => k.startsWith('skip:') && k.endsWith(`:${kind}`)).reduce((a, [, v]) => ({ n: a.n + v.n, w: a.w + v.w }), { n: 0, w: 0 })
    rows.push(`${kind}: taken ${t.n ? `${t.w}/${t.n} (${((t.w / t.n) * 100).toFixed(0)}%)` : 'none yet'}, cancelled ones that would have won ${sk.n ? `${sk.w}/${sk.n} (${((sk.w / sk.n) * 100).toFixed(0)}%)` : 'none yet'}`)
  }
  return rows.length ? `limit resolved - ${rows.join(' | ')}` : 'limit resolved - nothing resolved yet'
}
