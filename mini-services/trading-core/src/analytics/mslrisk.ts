// IQAIR//OS - MSL `risk.*` (own recent results) and `session.*` (market sessions / windows).
//
// risk.* reads the OUTCOMES of the trades this system has taken - live: every closed Meta Trader position since this kernel started (in memory, lost on restart, all scripts together);
//   in the replay tester: the trades that script took earlier in the replay (only ones already SETTLED at the evaluated moment - no look-ahead). The plain candle backtester has no trade
//   clock, so risk.* throws there (use the replay tester). Units: stake = 1, a win = +payout, a loss = -1.
// session.* is clock-only (UTC, fixed): Asia 00-08, London 07-16, New York 12-21, overlap = London and New York 12-16, dead = outside all (21-24 on weekdays... plus weekend). It replays in a candle
//   backtest on the bar's own time. Fixed UTC windows ignore daylight saving - same limitation as the chart's LVL sessions.
export interface RiskOutcome { ts: number; win: boolean; units: number }
const live: RiskOutcome[] = []
export function recordRiskOutcome(o: RiskOutcome): void { live.push(o); if (live.length > 500) live.splice(0, live.length - 500) }
export function liveRiskOutcomes(): readonly RiskOutcome[] { return live }
export function clearLiveRisk(): void { live.length = 0 }

export interface RiskStats { tradesWeek: number; drawdownAll: number; pnlAll: number; lossDays: number; trades: number; todayPnl: number; drawdown: number; losses: number; wins: number; sinceMin: number; last: (n: number) => { n: number; wins: number } }
export function riskStats(all: readonly RiskOutcome[], nowMs: number): RiskStats {
  const done = all.filter((o) => o.ts <= nowMs)
  const day0 = Math.floor(nowMs / 86_400_000) * 86_400_000
  const today = done.filter((o) => o.ts >= day0)
  let cum = 0, peak = 0
  for (const o of today) { cum += o.units; peak = Math.max(peak, cum) }
  let losses = 0, wins = 0
  for (let i = done.length - 1; i >= 0 && !done[i].win; i--) losses++
  for (let i = done.length - 1; i >= 0 && done[i].win; i--) wins++
  // since Monday 00:00 UTC
  const dowMon = (new Date(nowMs).getUTCDay() + 6) % 7
  const wk0 = day0 - dowMon * 86_400_000
  let cumAll = 0, peakAll = 0, ddAll = 0
  for (const o of done) { cumAll += o.units; peakAll = Math.max(peakAll, cumAll); ddAll = Math.max(ddAll, peakAll - cumAll) }
  // consecutive most-recent trading days that ended net negative (days without trades are skipped)
  const byDay = new Map<number, number>()
  for (const o of done) { const d = Math.floor(o.ts / 86_400_000); byDay.set(d, (byDay.get(d) ?? 0) + o.units) }
  let lossDays = 0
  for (const d of [...byDay.keys()].sort((a, b) => b - a)) { if ((byDay.get(d) ?? 0) < 0) lossDays++; else break }
  return {
    tradesWeek: done.filter((o) => o.ts >= wk0).length, drawdownAll: ddAll, pnlAll: cumAll, lossDays,
    trades: today.length, todayPnl: cum, drawdown: peak - cum, losses, wins,
    sinceMin: done.length ? (nowMs - done[done.length - 1].ts) / 60_000 : 99999,
    last: (n) => { const s = done.slice(-Math.max(1, Math.floor(n))); return { n: s.length, wins: s.filter((x) => x.win).length } },
  }
}

export type SessionName = 'asia' | 'london' | 'ny' | 'overlap' | 'dead'
const SESS: Record<string, [number, number]> = { asia: [0, 8], london: [7, 16], ny: [12, 21] }
export function weekendAt(nowMs: number): boolean {
  const d = new Date(nowMs), dow = d.getUTCDay(), h = d.getUTCHours()
  return dow === 6 || (dow === 0 && h < 21) || (dow === 5 && h >= 21)
}
export function sessionAt(nowMs: number): { name: SessionName; asia: boolean; london: boolean; ny: boolean; overlap: boolean } {
  const h = new Date(nowMs).getUTCHours() + new Date(nowMs).getUTCMinutes() / 60
  const inn = (k: string) => h >= SESS[k][0] && h < SESS[k][1]
  const asia = inn('asia'), london = inn('london'), ny = inn('ny')
  const overlap = london && ny
  const name: SessionName = overlap ? 'overlap' : london ? 'london' : ny ? 'ny' : asia ? 'asia' : 'dead'
  return { name, asia, london, ny, overlap }
}
export function minsIn(nowMs: number, which: string): number {
  const r = SESS[which]; if (!r) return -1
  const h = new Date(nowMs).getUTCHours() + new Date(nowMs).getUTCMinutes() / 60
  return h >= r[0] && h < r[1] ? Math.round((h - r[0]) * 60) : -1
}
export function minsLeft(nowMs: number, which: string): number {
  const r = SESS[which]; if (!r) return -1
  const h = new Date(nowMs).getUTCHours() + new Date(nowMs).getUTCMinutes() / 60
  return h >= r[0] && h < r[1] ? Math.round((r[1] - h) * 60) : -1
}
/** "HH:MM" UTC window, wraps past midnight ("22:00","02:00") */
export function inWindow(nowMs: number, from: string, to: string): boolean {
  const p = (s: string): number => { const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim()); if (!m) throw new Error(`bad time "${s}" - use "HH:MM" (UTC)`); return Number(m[1]) * 60 + Number(m[2]) }
  const a = p(from), b = p(to)
  const d = new Date(nowMs), m = d.getUTCHours() * 60 + d.getUTCMinutes()
  return a <= b ? m >= a && m < b : m >= a || m < b
}
/** true while now is within [from, to] (UTC); each is "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (a bare end date includes that whole day) */
export function inDates(nowMs: number, from: string, to: string): boolean {
  const p = (s: string, end: boolean): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s.trim())
    if (!m) throw new Error(`bad date "${s}" - use "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (UTC)`)
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0)
    return !m[4] && end ? t + 86_400_000 - 1 : t
  }
  return nowMs >= p(from, false) && nowMs <= p(to, true)
}
