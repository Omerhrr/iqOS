// IQAIR//OS - TIMING SAGE (`timing.sage`).
//
// The idea: after a signal, price often goes AGAINST us first and then comes back; sometimes the expiry runs out before it does. The sage watches that first move and decides WHEN (and whether) to enter.
// It is built around the four traps of "wait for a dip":
//   1. SURVIVORSHIP  - trades that go straight our way never dip, and are often the best. The sage never discards them: a straight move is TAKEN (straightMode "take", default) the moment it is clear.
//   2. A DIP IS ALSO EVIDENCE - "went against me first" fits "will come back" and "I was wrong". So a dip is only bought when (a) it stays shallow (abortAtr), (b) the script's own `valid` check still
//      passes (pm same way, lower timeframe agrees) AND (c) price has actually TURNED (recovered recoverFrac of the dip) - never the falling knife at the bottom.
//   3. MEMORY BIAS   - every decision is MEASURED. Taken and skipped cases are resolved `horizonSec` later against price (skipped ones counterfactually, from the arm price), per class, so the sage
//      reports how its dip entries and its skipped signals really did instead of how they felt.
//   4. SELF-CORRECTION - once the dip class has 15+ resolved entries and its shrunk hit rate is below 50%, dip entries are refused on that scope ("learned: dip entries lose here").
//
//   timing.sage(name, cond, dir, seconds [, dipAtr = 0.15 [, abortAtr = 0.5 [, valid = true [, straight = "take" [, horizonSec = 60 [, goAtr = 0.1 [, recoverFrac = 0.4]]]]]]])  -> 1 on the ONE evaluation to ENTER
//   cond = the signal (e.g. pm call). valid = the re-check at the dip (e.g. pm still same way and a lower-timeframe read agrees). Moves are in ATR14 of the chart the script runs on.
//   RETOUCH (default on): once price has dipped against the signal and then comes BACK to the signal price (within retouchAtr, default 0.02 ATR), the sage enters IMMEDIATELY - that is the entry the signal
//   originally asked for, so no recovery fraction and no re-check are needed (the signal must still be on, the dip must not have been a reversal). Class 'retouch', measured and self-corrected like the others.
//   timing.sage(..., recoverFrac, retouch = 1 [, retouchAtr = 0.02])
// Pure state machine, explicit clock, so tests (and the replay tester, which walks 5s bars with a clock) can drive it. LIVE / REPLAY only: a 1m candle backtest cannot see intrabar paths.
export type SageState = 'idle' | 'watching' | 'fired' | 'aborted'
export type SageClass = 'straight' | 'dip' | 'retouch'
export interface SageRec { state: SageState; latched: boolean; armedMs: number; doneMs: number; entry: number; dir: number; atr: number; mae: number; mfe: number; dipped: boolean; move: number; seconds: number; why: string; cls: SageClass | ''; entryGain: number }
export interface SageBucket { n: number; w: number }
export interface SagePending { dueMs: number; px: number; dir: number; bucket: string }
const store = new Map<string, SageRec>()
const stats = new Map<string, Record<string, SageBucket>>()
const pending = new Map<string, SagePending[]>()
export const sageKey = (prefix: string, name: string): string => `${prefix}|sage|${name}`
export const sageRec = (key: string): SageRec | undefined => store.get(key)
export const sageStats = (key: string): Record<string, SageBucket> => stats.get(key) ?? {}
export function clearSage(prefix: string): void { for (const m of [store, stats, pending] as Array<Map<string, unknown>>) for (const k of m.keys()) if (k.startsWith(`${prefix}|sage|`)) m.delete(k) }
export function hasWaitingSage(prefix: string): boolean { for (const [k, r] of store) if (r.state === 'watching' && k.startsWith(`${prefix}|`)) return true; return false }
const shrunk = (b?: SageBucket): number => (((b?.w ?? 0) + 1) / ((b?.n ?? 0) + 2))

export interface SageInput { key: string; cond: boolean; valid: boolean; dir: number; seconds: number; dipAtr: number; abortAtr: number; goAtr: number; recoverFrac: number; straightTake: boolean; retouch?: boolean; retouchAtr?: number; horizonSec: number; nowMs: number; price: number; atr: number }

function resolvePending(key: string, nowMs: number, price: number): void {
  const list = pending.get(key); if (!list || !Number.isFinite(price)) return
  const st = stats.get(key) ?? {}
  const keep: SagePending[] = []
  for (const p of list) {
    if (p.dueMs > nowMs) { keep.push(p); continue }
    const d = p.dir * (price - p.px)
    if (d === 0) continue
    const b = st[p.bucket] ?? (st[p.bucket] = { n: 0, w: 0 })
    b.n++; if (d > 0) b.w++
  }
  stats.set(key, st); pending.set(key, keep)
}
function queue(key: string, p: SagePending): void { const l = pending.get(key) ?? []; l.push(p); while (l.length > 200) l.shift(); pending.set(key, l) }

export function stepSage(i: SageInput): { fire: boolean; rec: SageRec } {
  resolvePending(i.key, i.nowMs, i.price)
  let r = store.get(i.key)
  if (!r) { r = { state: 'idle', latched: false, armedMs: 0, doneMs: 0, entry: NaN, dir: i.dir, atr: i.atr, mae: 0, mfe: 0, dipped: false, move: 0, seconds: i.seconds, why: '', cls: '', entryGain: 0 }; store.set(i.key, r) }
  if (r.state === 'fired' && i.nowMs - r.doneMs < 1000) return { fire: true, rec: r } // idempotent within one instant
  if (r.state === 'fired' || r.state === 'aborted') { if (!i.cond) r.latched = false; if (i.nowMs - r.doneMs >= 1000) r.state = 'idle' }
  if (r.state === 'idle') {
    if (!i.cond) r.latched = false
    if (i.cond && !r.latched && Number.isFinite(i.price) && i.dir !== 0) Object.assign(r, { state: 'watching' as SageState, armedMs: i.nowMs, entry: i.price, dir: i.dir, atr: i.atr, mae: 0, mfe: 0, dipped: false, move: 0, seconds: i.seconds, why: 'armed', cls: '' as const, entryGain: 0 })
    return { fire: false, rec: r }
  }
  if (r.state !== 'watching') return { fire: false, rec: r }
  const move = r.dir * (i.price - r.entry) / r.atr
  r.move = move; r.mae = Math.max(r.mae, -move); r.mfe = Math.max(r.mfe, move)
  const recovered = move + r.mae // ATR regained off the worst point
  const finish = (state: SageState, why: string): void => { r!.state = state; r!.why = why; r!.doneMs = i.nowMs; r!.latched = true }
  const skip = (why: string, bucket: string): { fire: boolean; rec: SageRec } => { queue(i.key, { dueMs: i.nowMs + i.horizonSec * 1000, px: r!.entry, dir: r!.dir, bucket: `skip:${bucket}` }); finish('aborted', why); return { fire: false, rec: r! } }
  const enter = (cls: SageClass, why: string): { fire: boolean; rec: SageRec } => { r!.cls = cls; r!.entryGain = cls === 'dip' ? -move : 0; queue(i.key, { dueMs: i.nowMs + i.horizonSec * 1000, px: i.price, dir: r!.dir, bucket: `take:${cls}` }); finish('fired', why); return { fire: true, rec: r! } }
  if (!i.cond) return skip(r.dipped ? 'analysis gone after the dip' : 'analysis gone', r.dipped ? 'dip-gone' : 'gone')
  if (r.mae >= i.abortAtr) return skip(`dip too deep (${r.mae.toFixed(2)} ATR) - that is a reversal, not a dip`, 'dip-deep')
  if (!r.dipped && r.mae >= i.dipAtr) r.dipped = true
  if (!r.dipped && move >= i.goAtr) return i.straightTake ? enter('straight', `moved ${move.toFixed(2)} ATR our way with no dip - taken (never skip the strong ones)`) : skip('straight move skipped by setting', 'straight')
  if (r.dipped && (i.retouch ?? true) && move >= -(i.retouchAtr ?? 0.02)) {
    const lr = stats.get(i.key)?.['take:retouch']
    if (lr && lr.n >= 15 && shrunk(lr) < 0.5) return skip(`learned: retouch entries win only ${(shrunk(lr) * 100).toFixed(0)}% here (${lr.n} resolved)`, 'retouch-learned')
    return enter('retouch', `dipped ${r.mae.toFixed(2)} ATR against, then price came back to the signal price - entered immediately at the original entry`)
  }
  if (r.dipped && recovered >= Math.max(0.03, i.recoverFrac * r.mae) && i.valid) {
    const learned = stats.get(i.key)?.['take:dip']
    if (learned && learned.n >= 15 && shrunk(learned) < 0.5) return skip(`learned: dip entries win only ${(shrunk(learned) * 100).toFixed(0)}% here (${learned.n} resolved)`, 'dip-learned')
    return enter('dip', `dipped ${r.mae.toFixed(2)} ATR, turned back ${recovered.toFixed(2)} and still valid - entry ${(-move).toFixed(2)} ATR better than the signal price`)
  }
  if ((i.nowMs - r.armedMs) / 1000 >= r.seconds) return skip(r.dipped ? `dip of ${r.mae.toFixed(2)} ATR never turned back in time (or no longer valid)` : `went nowhere (${move.toFixed(2)} ATR)`, r.dipped ? 'dip-failed' : 'flat')
  return { fire: false, rec: r }
}

export function sageText(key: string): string {
  const s = stats.get(key) ?? {}
  const b = (k: string) => { const x = s[k]; return x && x.n ? `${x.w}/${x.n} (${((x.w / x.n) * 100).toFixed(0)}%)` : 'none yet' }
  const skipped = Object.entries(s).filter(([k]) => k.startsWith('skip:')).reduce((a, [, v]) => ({ n: a.n + v.n, w: a.w + v.w }), { n: 0, w: 0 })
  return `sage resolved: straight entries ${b('take:straight')}, dip entries ${b('take:dip')}, retouch entries ${b('take:retouch')}, skipped signals that would have won ${skipped.n ? `${skipped.w}/${skipped.n} (${((skipped.w / skipped.n) * 100).toFixed(0)}%)` : 'none yet'}`
}
