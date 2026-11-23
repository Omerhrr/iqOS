// IQAIR//OS - TRADE SCHEDULE (`timing.schedule`): control WHEN and HOW OFTEN the sage / limit order may enter.
//
//   timing.schedule(name, window [, tz = 0 [, perDay = 0 [, perHour = 0 [, minGapMin = 0 [, days = "" [, scope = "script"]]]]]])
//   window    "13:00-16:00" local time (24h) in the zone `tz`; several: "09:00-11:00,13:00-16:00"; overnight "22:00-02:00" works; "" or "all" = the whole day
//   tz        hours from UTC: 1 = GMT+1, 5.5 = India, -5 = New York (winter). A fixed offset, it does NOT follow daylight saving - change it when the clocks change. Strings like "GMT+1" / "+01:00" are accepted.
//   perDay    max trades per LOCAL calendar day (0 = no cap)          perHour  max trades per LOCAL clock hour, 13:00-13:59 etc. (0 = no cap)
//   minGapMin minimum minutes between two trades (0 = none) - spreads "2 per hour" instead of two back to back
//   days      "mon-fri" / "mon,wed,fri" (blank = every day); an overnight window counts as the day it STARTED
//   scope     "script" (default: every pair this script trades shares ONE budget) or "pair" (each pair gets its own)
// A schedule is attached to a sage or limit by naming it as the last argument: timing.sage(..., "myschedule"). The sage then neither arms outside the window / over budget, nor enters if the window closed or the budget
// filled while it was waiting. A trade is COUNTED at the moment the sage / limit fires (the one evaluation that enters), never on the signal.
// 3 hours x 2 per hour = 6 trades (13:00-16:00); for 8 trades a day at 2 per hour use four hours (13:00-17:00).
// HONEST: the counts live in kernel memory - a kernel restart resets today's budget (the window still holds). The clock is the kernel's wall clock (or the replay clock in the replay tester).
export interface SchedConfig { windows: Array<[number, number]>; windowText: string; days: Set<number> | null; tzMin: number; perDay: number; perHour: number; minGapMin: number }
interface SchedRec { cfg: SchedConfig; trades: number[]; lastWhy: string }
const store = new Map<string, SchedRec>()
export const schedKey = (prefix: string, name: string, scope: string): string => {
  const sc = scope === 'pair' ? prefix : prefix.split('|')[0]
  return `${sc}|sched|${name}`
}
const byName = new Map<string, string>()
export const registerSchedule = (prefix: string, name: string, key: string): void => { byName.set(`${prefix}|${name}`, key) }
export const lookupSchedule = (prefix: string, name: string): string | undefined => byName.get(`${prefix}|${name}`)
export function clearSchedule(prefix: string): void { const sc = prefix.split('|')[0]; for (const k of store.keys()) if (k.startsWith(`${sc}|sched|`) || k.startsWith(`${prefix}|sched|`)) store.delete(k) }
export const schedRec = (key: string): SchedRec | undefined => store.get(key)

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
export function parseTz(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0
  if (typeof v === 'number') { if (!Number.isFinite(v) || Math.abs(v) > 14) throw new Error('timing.schedule(): tz must be hours from UTC between -14 and +14'); return Math.round(v * 60) }
  const m = /^\s*(?:gmt|utc)?\s*([+-])?\s*(\d{1,2})(?::?(\d{2}))?\s*$/i.exec(String(v))
  if (!m) throw new Error(`timing.schedule(): cannot read the time zone "${v}" - use hours from UTC like 1, -5, 5.5 or "GMT+1"`)
  const mins = (Number(m[2]) * 60 + Number(m[3] ?? 0)) * (m[1] === '-' ? -1 : 1)
  if (Math.abs(mins) > 14 * 60) throw new Error('timing.schedule(): tz must be between -14 and +14 hours')
  return mins
}
const toMin = (s: string): number => {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s.trim())
  if (!m) throw new Error(`timing.schedule(): cannot read the time "${s}" - use 24h like 13:00`)
  const h = Number(m[1]), mm = Number(m[2] ?? 0)
  if (h > 24 || mm > 59 || (h === 24 && mm > 0)) throw new Error(`timing.schedule(): "${s}" is not a valid time`)
  return h * 60 + mm
}
export function parseWindows(v: unknown): { windows: Array<[number, number]>; text: string } {
  const t = String(v ?? '').trim().toLowerCase()
  if (!t || t === 'all' || t === 'always' || t === '*') return { windows: [], text: 'all day' }
  const windows: Array<[number, number]> = []
  for (const part of t.split(',')) {
    const [a, b, ...rest] = part.split('-')
    if (b === undefined || rest.length) throw new Error(`timing.schedule(): cannot read the window "${part.trim()}" - use "13:00-16:00"`)
    let x = toMin(a), y = toMin(b)
    if (y === 1440) y = 1440 // 24:00 = end of day
    windows.push([x === 1440 ? 0 : x, y])
  }
  return { windows, text: windows.map(([a, b]) => `${fmt(a)}-${fmt(b)}`).join(', ') }
}
const fmt = (m: number): string => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
export function parseDays(v: unknown): Set<number> | null {
  const t = String(v ?? '').trim().toLowerCase()
  if (!t || t === 'all' || t === 'every') return null
  const out = new Set<number>()
  for (const part of t.split(',')) {
    const [a, b] = part.trim().split('-').map((x) => DAYS.indexOf(x.trim().slice(0, 3)))
    if (a < 0 || (part.includes('-') && b < 0)) throw new Error(`timing.schedule(): cannot read the days "${part.trim()}" - use mon-fri or mon,wed,fri`)
    if (!part.includes('-')) { out.add(a); continue }
    for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break }
  }
  return out
}
export function buildConfig(a: { window?: unknown; tz?: unknown; perDay?: number; perHour?: number; minGapMin?: number; days?: unknown }): SchedConfig {
  const w = parseWindows(a.window)
  const nz = (x: number | undefined, nm: string): number => { const n = x ?? 0; if (!Number.isFinite(n) || n < 0) throw new Error(`timing.schedule(): ${nm} must be 0 or more`); return Math.floor(n) }
  return { windows: w.windows, windowText: w.text, days: parseDays(a.days), tzMin: parseTz(a.tz), perDay: nz(a.perDay, 'perDay'), perHour: nz(a.perHour, 'perHour'), minGapMin: nz(a.minGapMin, 'minGapMin') }
}

const MIN = 60_000
const localMs = (nowMs: number, cfg: SchedConfig): number => nowMs + cfg.tzMin * MIN
/** is `nowMs` inside the window and an allowed day? (budget NOT considered) */
export function inWindow(cfg: SchedConfig, nowMs: number): { ok: boolean; why: string } {
  const lm = localMs(nowMs, cfg)
  const d = new Date(lm)
  const m = d.getUTCHours() * 60 + d.getUTCMinutes()
  let hit = cfg.windows.length === 0, overnightAfterMidnight = false
  for (const [a, b] of cfg.windows) {
    if (a === b) { hit = true; break }
    if (a < b) { if (m >= a && m < b) { hit = true; break } } else if (m >= a) { hit = true; break } else if (m < b) { hit = true; overnightAfterMidnight = true; break }
  }
  if (!hit) return { ok: false, why: `outside the trading window ${cfg.windowText} (it is ${fmt(m)} local)` }
  if (cfg.days) {
    const day = (d.getUTCDay() + (overnightAfterMidnight ? 6 : 0)) % 7
    if (!cfg.days.has(day)) return { ok: false, why: `${DAYS[day]} is not a trading day for this schedule` }
  }
  return { ok: true, why: '' }
}
const counts = (rec: SchedRec, nowMs: number): { day: number; hour: number; lastAgoMin: number } => {
  const cfg = rec.cfg, lm = localMs(nowMs, cfg)
  const dayIdx = Math.floor(lm / 86_400_000), hourIdx = Math.floor(lm / 3_600_000)
  let day = 0, hour = 0, last = -Infinity
  for (const t of rec.trades) { const l = localMs(t, cfg); if (Math.floor(l / 86_400_000) === dayIdx) day++; if (Math.floor(l / 3_600_000) === hourIdx) hour++; if (t > last) last = t }
  return { day, hour, lastAgoMin: Number.isFinite(last) ? (nowMs - last) / MIN : Infinity }
}
/** register / refresh the schedule's settings (the script is the source of truth) and return its record */
export function setSchedule(key: string, cfg: SchedConfig): SchedRec {
  let r = store.get(key)
  if (!r) { r = { cfg, trades: [], lastWhy: '' }; store.set(key, r) } else r.cfg = cfg
  return r
}
/** '' when a new trade may start now, else the reason it may not */
export function scheduleBlock(key: string, nowMs: number): string {
  const r = store.get(key)
  if (!r) return ''
  const w = inWindow(r.cfg, nowMs)
  let why = w.why
  if (!why) {
    const c = counts(r, nowMs)
    if (r.cfg.perDay > 0 && c.day >= r.cfg.perDay) why = `daily limit reached (${c.day}/${r.cfg.perDay} trades today)`
    else if (r.cfg.perHour > 0 && c.hour >= r.cfg.perHour) why = `hourly limit reached (${c.hour}/${r.cfg.perHour} this hour, next slot at the top of the hour)`
    else if (r.cfg.minGapMin > 0 && c.lastAgoMin < r.cfg.minGapMin) why = `minimum gap: ${c.lastAgoMin.toFixed(1)} of ${r.cfg.minGapMin} min since the last trade`
  }
  r.lastWhy = why
  return why ? `schedule: ${why}` : ''
}
export function recordScheduleTrade(key: string, nowMs: number): void {
  const r = store.get(key); if (!r) return
  r.trades.push(nowMs)
  const cutoff = nowMs - 3 * 86_400_000
  while (r.trades.length && (r.trades[0] < cutoff || r.trades.length > 500)) r.trades.shift()
}
export function scheduleText(key: string, nowMs: number): string {
  const r = store.get(key)
  if (!r) return 'no schedule'
  const c = counts(r, nowMs), w = inWindow(r.cfg, nowMs)
  const cap = (n: number, cp: number) => (cp > 0 ? `${n}/${cp}` : `${n}/unlimited`)
  const blk = scheduleBlock(key, nowMs)
  return `window ${r.cfg.windowText}${r.cfg.days ? ` (${[...r.cfg.days].map((d) => DAYS[d]).join(',')})` : ''}, GMT${r.cfg.tzMin >= 0 ? '+' : '-'}${fmt(Math.abs(r.cfg.tzMin))}: ${w.ok ? 'open' : 'closed'}; today ${cap(c.day, r.cfg.perDay)}, this hour ${cap(c.hour, r.cfg.perHour)}${r.cfg.minGapMin ? `, gap ${r.cfg.minGapMin}m` : ''}${blk ? ` - ${blk.replace('schedule: ', '')}` : ' - can take a trade now'}`
}
export function scheduleTradesToday(key: string, nowMs: number): number { const r = store.get(key); return r ? counts(r, nowMs).day : 0 }
export function scheduleTradesThisHour(key: string, nowMs: number): number { const r = store.get(key); return r ? counts(r, nowMs).hour : 0 }
export function scheduleOpen(key: string, nowMs: number): boolean { const r = store.get(key); return r ? scheduleBlock(key, nowMs) === '' : true }
