// IQAIR//OS - same-time-yesterday scanner analytics
// "What was the market DOING at this exact time yesterday - and in the window
// right after?" For every open instrument the scanner finds the bar that was
// forming exactly 24h ago and replays the forward window that started at that
// moment: net move, high-low travel, best excursion above / below the moment's
// price, plus where price has gone SINCE (then -> now) and which trading
// session the market was in at the time. Traders read it as intraday
// seasonality: "EURUSD usually pumps at this hour - did it, yesterday?"
//
// The ECHO answers the follow-up a forward replay alone cannot: is TODAY
// repeating yesterday's script? Both sides of the comparison are the window
// leading INTO the same time of day - yesterday's ended exactly at the anchor
// moment, today's ends within one bar of now (the anchor bucket + 24h is
// always <= now) - so the two windows are wall-clock aligned, not just
// "roughly a day apart". Each row scores the rhyme 0..100 from three
// explainable parts: direction agreement (50), how close today's net move is
// to yesterday's measured against yesterday's own travel (30, scale-free),
// and how close today's travel is to yesterday's (20).
//
// The PRIOR days extend the same question past yesterday: the window that
// started at T-48h, T-72h, ... per row, gated by the same coverage rule.
// A day the series cannot honestly cover is ABSENT from the strip (a gap,
// labeled by how far back it is) - never a thin move dressed up as a story.
// Each remembered day also carries its own ECHO: today's lead-in vs THAT
// day's lead-in - "does today rhyme with the whole week at this hour?" - so
// the strip can show whether the rhyme held across the week or only matched
// yesterday. Depth is bounded by the same lookback the row already pulls
// (days*24h + 2x window covers every prior lead-in with a window of slack),
// so finer candles remember fewer days: the archive-depth gate refuses the
// rest.
//
// Honesty rules this module enforces:
// - the story is built ONLY from bars actually present in the series; a row
//   whose window coverage is under half of the expected bars is dropped
//   entirely (market dark at that hour yesterday / asset never warmed) rather
//   than silently reporting a move computed from a fraction of the window;
// - `barsFound` vs `barsExpected` travels with every row that does pass, so
//   the panel can show partial coverage instead of implying a full window;
// - `archived` counts the bars that came from the kernel's own store (real
//   accumulated history - broker bars in live mode) vs the deterministic
//   prehistory the feed generates, so a synthetic "yesterday" can never
//   masquerade as a remembered one.
// - dir is scale-invariant: a window counts as directional only when its net
//   move exceeds 10% of its own high-low travel - a 0.05% drift inside a
//   0.6% chop is flat, no matter the asset class.
// - a rhyme between two FLAT lead-ins is real but trivial (both sides did
//   nothing - the direction points are awarded for free), so the echo carries
//   `quiet` and the panel marks it and keeps it out of every aggregate.
//
// The SESSION PROFILE answers the question one echo cannot: does the script
// DIFFER by time of day? The main echo compares lead-ins at ONE wall-clock
// hour (now's hour) - every scan shares that hour, so a session tag on it is
// a constant, not an answer. The profile re-scores the SAME adjacent-day
// lead-in comparison at EVERY hour of the day (yesterday's h:00 lead-in vs
// today's when elapsed, then T-2 vs T-1, T-3 vs T-2, ... - adjacent days,
// never day-vs-week), from the candles the scan ALREADY pulled: no extra
// lookback, pairs the series cannot cover are absent (fewer observations),
// never approximated. Each pair lands in the session of its hour via
// classifySession, each session reports obs / quiet / the mean rhyme of its
// non-quiet echoes - so "EURUSD rhymes in London and diverges off-hours" is
// a per-row fact instead of folklore. -OTC tickers have no sessions (see
// analytics/session.ts): every pair lands in one day-wide OTC bucket. Each
// bucket also carries the UNROUNDED rhyme total of its non-quiet echoes, so
// clients can fold exact higher-level aggregates (a whole asset class, say)
// from many rows without inheriting per-row rounding.

import { classifySession, type Session } from './session'
import type { AssetCategory, Candle } from '../types'

export type YdayDir = 'up' | 'down' | 'none'

/** The window leading INTO the moment (same length as the replay window),
 * yesterday vs today - the "is today repeating yesterday's lead-in?"
 * comparison. null when either side is under half covered (dark session,
 * asset never warmed) - a missing echo is information, not an error. */
export interface YesterdayEcho {
  /** net move over the lead-in window, yesterday (%) */
  ydayMovePct: number
  /** high-low travel over the lead-in window, yesterday (%) */
  ydayRangePct: number
  /** same wall-clock lead-in window, today (%) */
  todayMovePct: number
  todayRangePct: number
  /** bars present on today's side of the comparison */
  todayBarsFound: number
  /** 'same' = both windows pushed the same way (or both flat), 'opposite' =
   * pushed against each other, 'partial' = one went nowhere */
  dirAgree: 'same' | 'partial' | 'opposite'
  /** 0..100 - direction agreement (50) + move magnitude vs yesterday's own
   * travel (30) + travel ratio (20). >=70 rhymes, <40 diverges. */
  rhyme: number
  /** both lead-ins were FLAT (|move| under 10% of the window's own travel on
   * both sides): the agreement is real but trivial - two dead hours rhyme
   * perfectly and mean nothing. Aggregates exclude quiet echoes; the panel
   * marks them instead of letting 90-from-flat masquerade as a strong echo. */
  quiet: boolean
}

/** The per-prior-day echo: today's lead-in vs THAT day's lead-in, scored
 * with the same rhymeScore as the main echo. null when either side is under
 * half covered. Small by design - the moves already live on the PriorDay. */
export interface PriorEcho {
  /** 0..100 - same three-part score as YesterdayEcho (direction 50 + move
   * delta vs this day's own travel 30 + travel ratio 20) */
  rhyme: number
  dirAgree: YesterdayEcho['dirAgree']
  /** both lead-ins flat (see YesterdayEcho.quiet) - trivial agreement,
   * excluded from the panel's aggregates */
  quiet: boolean
}

/** One session bucket of the per-session rhyme profile: the adjacent-day
 * lead-in comparison scored at this session's hours across the loaded days,
 * aggregated. QUIET echoes (both lead-ins flat - trivial agreement) count in
 * obs but are excluded from avg, same rule as every other aggregate. */
export interface SessionRhyme {
  /** the session every scored pair's hour belongs to (one 'OTC' bucket for
   * -OTC tickers - they have no sessions, see analytics/session.ts) */
  session: Session
  /** adjacent-day lead-in echoes scored in this session's hours */
  obs: number
  /** of those, both lead-ins flat (real but trivial - kept out of avg) */
  quiet: number
  /** total rhyme of the NON-QUIET echoes in this bucket (0 when none) - the
   * unrounded numerator behind avg, so a client folding many rows into one
   * aggregate (per class, per market) gets round(sum/kept) exact, never an
   * average of rounded averages */
  sum: number
  /** mean rhyme of the non-quiet echoes, 0..100; null when none survived */
  avg: number | null
}

/** One remembered day BEFORE yesterday: the same forward window starting at
 * T-24h*back. Only days whose coverage passes the same >= half gate are
 * reported - gaps in the strip mean the market was dark or the series does
 * not reach, which is information, not an error. */
export interface PriorDay {
  /** how many days back (2 = T-48h, 3 = T-72h, ...) */
  back: number
  /** epoch seconds of the bar that was forming at that moment (window start) */
  thenTs: number
  /** net move over the window, % */
  movePct: number
  dir: YdayDir
  /** high-low travel across the window, % */
  rangePct: number
  barsFound: number
  barsExpected: number
  /** session the market was in at that moment */
  session: Session
  /** today's lead-in vs this day's lead-in (see PriorEcho); null = either
   * side under half covered - no comparison instead of a fake one */
  echo: PriorEcho | null
}

export interface YesterdayRow {
  asset: string
  name: string
  category: AssetCategory
  otc: boolean
  /** epoch seconds of the bar that was forming exactly 24h ago - the window starts here */
  thenTs: number
  /** price at that moment (open of the bar containing T-24h) */
  thenPrice: number
  /** price right now */
  nowPrice: number
  /** (now - then) / then, % - where the market has gone since that moment */
  sincePct: number
  /** net move over the window that started at that moment, % (window close vs thenPrice) */
  movePct: number
  dir: YdayDir
  /** high-low travel across the window, % of thenPrice */
  rangePct: number
  /** best excursion above thenPrice inside the window, % */
  runUpPct: number
  /** deepest excursion below thenPrice inside the window, % */
  drawdownPct: number
  /** window bars present vs expected - coverage is displayed, never implied */
  barsFound: number
  barsExpected: number
  /** of the bars found, how many came from the kernel's store (accumulated history) */
  archived: number
  /** session the market was in at that moment yesterday (OTC pairs always 'OTC') */
  session: Session
  /** lead-in comparison, yesterday vs today - see YesterdayEcho */
  echo: YesterdayEcho | null
  /** deeper same-hour history, most recent first (back = 2, 3, ...); empty unless the scan asked for more than one day */
  prior: PriorDay[]
  /** per-session rhyme profile - the same adjacent-day lead-in echo scored at
   * EVERY hour of the day, aggregated per session (see SessionRhyme). Absent
   * unless the scan asked for it (profile=1): it costs days*24 lead-in
   * evaluations per row, all from the candles the scan already pulled. */
  profile?: SessionRhyme[]
}

export interface YesterdayInfo {
  ticker: string
  name: string
  category: AssetCategory
  otc: boolean
}

export interface YesterdayOpts {
  /** scan moment, epoch seconds */
  nowSec: number
  /** forward window length, seconds (a multiple of tfSec, >= tfSec) */
  windowSec: number
  /** scanned timeframe bar size, seconds */
  tfSec: number
  /** current price for the asset (0 = unknown - the row is dropped) */
  nowPrice: number
  /** archived (store-backed) bars inside the window - provenance label */
  archived: number
  /** how many day-anchors to walk past yesterday (0 = none; the scanner
   * passes days-1). Each prior day needs its own window in the series. */
  priorDays?: number
  /** also score the per-session rhyme profile (see SessionRhyme) - pairs per
   * hour are bounded by the same loaded series; nothing extra is fetched */
  profile?: boolean
}

const DAY_SEC = 86_400
const r4 = (x: number) => Math.round(x * 10_000) / 10_000

interface WinStats {
  movePct: number
  rangePct: number
  dir: YdayDir
}

/** Net move / high-low travel / direction over a run of closed bars - the
 * shared math behind the replay window and both echo windows. dir keeps the
 * scale-invariant 10%-of-own-travel rule: a drift smaller than a tenth of
 * the window's travel is flat, whatever the asset class. */
function windowStats(win: Candle[]): WinStats | null {
  if (!win.length) return null
  const open = win[0].open
  if (!(open > 0)) return null
  let high = win[0].high
  let low = win[0].low
  for (const c of win) {
    if (c.high > high) high = c.high
    if (c.low < low) low = c.low
  }
  const movePct = (win[win.length - 1].close / open - 1) * 100
  const rangePct = ((high - low) / open) * 100
  const eps = rangePct * 0.1
  const dir: YdayDir = movePct > eps ? 'up' : movePct < -eps ? 'down' : 'none'
  return { movePct, rangePct, dir }
}

/** Candles in [start, end) by binary search - the same set `filter` would
 * return over an ascending series, without walking the whole array. The
 * profile slices ~days*24 windows per row, so the lookup pays for itself. */
function winSlice(candles: Candle[], start: number, end: number): Candle[] {
  let lo = 0
  const n = candles.length
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].time < start) lo = mid + 1
    else hi = mid
  }
  const from = lo
  hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].time < end) lo = mid + 1
    else hi = mid
  }
  return candles.slice(from, lo)
}

/** The rhyme score's three parts, kept explicit so the panel tooltip can
 * quote them: direction (50), move delta in units of yesterday's travel
 * (30, scale-free), travel ratio (20). Dead-flat on both sides agrees
 * perfectly; yesterday flat + today moving disagrees.
 *
 * QUIET: when BOTH lead-ins are flat by the module's own scale-invariant
 * rule (|move| under 10% of the window's own travel - the same rule that
 * sets dir), the agreement is real but trivial - two dead hours "rhyme"
 * at 50+ points of direction alone. The flag rides the score so the panel
 * can mark it and keep it out of every aggregate. */
function rhymeScore(sy: WinStats, st: WinStats): { rhyme: number; dirAgree: YesterdayEcho['dirAgree']; quiet: boolean } {
  const dirAgree: YesterdayEcho['dirAgree'] =
    sy.dir === st.dir ? 'same' : sy.dir === 'none' || st.dir === 'none' ? 'partial' : 'opposite'
  const dirPts = dirAgree === 'same' ? 50 : dirAgree === 'partial' ? 25 : 0
  let magPts: number
  let volPts: number
  if (sy.rangePct <= 0 && st.rangePct <= 0) {
    magPts = 30
    volPts = 20
  } else if (sy.rangePct <= 0) {
    magPts = 0
    volPts = 0
  } else {
    magPts = 30 * Math.max(0, 1 - Math.abs(st.movePct - sy.movePct) / sy.rangePct)
    volPts = 20 * Math.max(0, 1 - Math.abs(1 - st.rangePct / sy.rangePct))
  }
  const rhyme = Math.max(0, Math.min(100, Math.round(dirPts + magPts + volPts)))
  const quiet = sy.dir === 'none' && st.dir === 'none'
  return { rhyme, dirAgree, quiet }
}

/** One remembered day before yesterday, or null when the series does not
 * honestly cover that window (same >= half gate as the main row). `back`
 * counts whole days: 2 = T-48h, 3 = T-72h. Shares windowStats and the dir
 * rule with the main row so a "down" in the strip means exactly what a
 * "down" on the row means. When `todayLeadIn` is supplied (today's side of
 * the comparison, covered) the day also carries its own echo: today's
 * lead-in vs this day's lead-in, scored with the same rhymeScore. */
export function buildPriorDay(
  info: YesterdayInfo,
  candles: Candle[],
  opts: { nowSec: number; windowSec: number; tfSec: number; back: number; todayLeadIn?: { stats: WinStats; barsFound: number } | null },
): PriorDay | null {
  const target = opts.nowSec - DAY_SEC * opts.back
  const t0 = target - (target % opts.tfSec)
  const win = candles.filter((c) => c.time >= t0 && c.time < t0 + opts.windowSec)
  const barsExpected = Math.round(opts.windowSec / opts.tfSec)
  const minBars = Math.max(1, Math.floor(barsExpected * 0.5))
  if (win.length < minBars) return null
  const st = windowStats(win)
  if (!st) return null
  // PRIOR ECHO: the lead-in window ending exactly at this day's anchor - the
  // wall-clock twin of the lead-in the main echo compares against. Both sides
  // must clear the same coverage gate; rhymeScore(older, today) keeps the
  // argument order of the main echo (older day = the reference side).
  let echo: PriorEcho | null = null
  if (opts.todayLeadIn) {
    const backP = candles.filter((c) => c.time >= t0 - opts.windowSec && c.time < t0)
    if (backP.length >= minBars) {
      const sy = windowStats(backP)
      if (sy) {
        const { rhyme, dirAgree, quiet } = rhymeScore(sy, opts.todayLeadIn.stats)
        echo = { rhyme, dirAgree, quiet }
      }
    }
  }
  return {
    back: opts.back,
    thenTs: t0,
    movePct: r4(st.movePct),
    dir: st.dir,
    rangePct: r4(st.rangePct),
    barsFound: win.length,
    barsExpected,
    session: classifySession(t0, info.ticker),
    echo,
  }
}

/**
 * The per-session rhyme profile: for EVERY hour h of the day, score the
 * adjacent-day lead-in echoes ending at h:00 - today vs yesterday (when
 * today's h:00 has elapsed), yesterday vs T-2, ... up to `days` pairs - and
 * aggregate the pairs per session (classifySession of the hour; one 'OTC'
 * bucket for -OTC tickers). Same rhymeScore, same >= half coverage gate per
 * lead-in side, same orientation (older side = the reference, like every
 * echo here). Windows come from the series the scan already pulled - a pair
 * whose side is under half covered is skipped (fewer obs), never guessed.
 * Buckets come back in fixed session order, obs 0 / avg null when a session
 * had nothing scorable - honest zeros, not absent sessions.
 */
export function buildSessionProfile(
  info: YesterdayInfo,
  candles: Candle[],
  opts: { nowSec: number; windowSec: number; tfSec: number; days: number },
): SessionRhyme[] {
  const days = Math.max(1, Math.floor(opts.days))
  const barsExpected = Math.round(opts.windowSec / opts.tfSec)
  const minBars = Math.max(1, Math.floor(barsExpected * 0.5))
  const midnight = opts.nowSec - (opts.nowSec % DAY_SEC)
  // per hour: lead-in stats keyed by how many days back the END sits
  // (0 = today h:00, 1 = yesterday, ...); pair d = stats[d] vs stats[d - 1]
  const tally = new Map<Session, { obs: number; quiet: number; sum: number }>()
  for (let h = 0; h < 24; h++) {
    // the bar bucket at h:00 today (bar opens are tf-aligned, same snap as
    // every anchor here) - today's side only exists once its window is past
    const end0 = midnight + h * 3_600
    const e0 = end0 - (end0 % opts.tfSec)
    const stats: (WinStats | null)[] = []
    for (let j = 0; j <= days; j++) {
      const end = e0 - DAY_SEC * j
      const win = winSlice(candles, end - opts.windowSec, end)
      stats.push(win.length >= minBars ? windowStats(win) : null)
    }
    for (let d = 1; d <= days; d++) {
      const sy = stats[d]
      const st = stats[d - 1]
      if (!sy || !st) continue
      const { rhyme, quiet } = rhymeScore(sy, st)
      const session = classifySession(e0, info.ticker)
      const t = tally.get(session) ?? { obs: 0, quiet: 0, sum: 0 }
      t.obs++
      if (quiet) t.quiet++
      else t.sum += rhyme
      tally.set(session, t)
    }
  }
  // fixed session order - real assets get the five clock sessions (obs 0 /
  // avg null when dark), -OTC tickers collapse into the single OTC bucket
  const order: Session[] = info.ticker.endsWith('-OTC')
    ? ['OTC']
    : ['ASIA', 'LONDON', 'OVERLAP', 'NEWYORK', 'OFF']
  return order.map((session) => {
    const t = tally.get(session)
    const kept = t ? t.obs - t.quiet : 0
    return {
      session,
      obs: t?.obs ?? 0,
      quiet: t?.quiet ?? 0,
      sum: t?.sum ?? 0,
      avg: kept > 0 ? Math.round(t!.sum / kept) : null,
    }
  })
}

/**
 * Build the same-time-yesterday row for one asset, or null when history does
 * not honestly cover the moment (no bars in the window, under half the
 * expected coverage, or no current price to anchor "since then").
 * `candles` must be closed bars sorted ascending by time (getCandles* contract)
 * and reach back to t0 - windowSec for the echo (the scanner's lookback is
 * sized for 24h + 2x window).
 */
export function buildYesterdayRow(info: YesterdayInfo, candles: Candle[], opts: YesterdayOpts): YesterdayRow | null {
  if (!(opts.nowPrice > 0)) return null
  const target = opts.nowSec - DAY_SEC
  // the bucket that was forming at that exact moment (bar opens are tf-aligned)
  const t0 = target - (target % opts.tfSec)
  const windowEnd = t0 + opts.windowSec
  const win = candles.filter((c) => c.time >= t0 && c.time < windowEnd)
  const barsExpected = Math.round(opts.windowSec / opts.tfSec)
  if (!win.length) return null
  // coverage gate: under half the window is a fraction of a story, not a story
  const minBars = Math.max(1, Math.floor(barsExpected * 0.5))
  if (win.length < minBars) return null

  const thenPrice = win[0].open
  if (!(thenPrice > 0)) return null
  let high = win[0].high
  let low = win[0].low
  for (const c of win) {
    if (c.high > high) high = c.high
    if (c.low < low) low = c.low
  }
  const lastClose = win[win.length - 1].close
  const movePct = (lastClose / thenPrice - 1) * 100
  const rangePct = ((high - low) / thenPrice) * 100
  // directional only when the net move is >= 10% of the window's own travel
  const eps = rangePct * 0.1
  const dir: YdayDir = movePct > eps ? 'up' : movePct < -eps ? 'down' : 'none'

  // ECHO: the lead-in windows ending at the same wall-clock moment -
  // yesterday's ends exactly at the anchor, today's at anchor + 24h which is
  // always <= now (the anchor bucket never lands after the scan moment).
  // Either side under half covered -> no comparison rather than a fake one.
  // Today's side is computed once and shared with the prior-day echoes (every
  // one of them compares against the SAME today lead-in).
  let echo: YesterdayEcho | null = null
  const backY = candles.filter((c) => c.time >= t0 - opts.windowSec && c.time < t0)
  const todayEnd = t0 + DAY_SEC
  const backT = candles.filter((c) => c.time >= todayEnd - opts.windowSec && c.time < todayEnd)
  const todayStats = windowStats(backT)
  const todayLeadIn = todayStats && backT.length >= minBars ? { stats: todayStats, barsFound: backT.length } : null
  if (backY.length >= minBars && todayLeadIn) {
    const sy = windowStats(backY)
    if (sy) {
      const { rhyme, dirAgree, quiet } = rhymeScore(sy, todayStats!)
      echo = {
        ydayMovePct: r4(sy.movePct),
        ydayRangePct: r4(sy.rangePct),
        todayMovePct: r4(todayStats!.movePct),
        todayRangePct: r4(todayStats!.rangePct),
        todayBarsFound: backT.length,
        dirAgree,
        rhyme,
        quiet,
      }
    }
  }

  // PRIOR days: T-48h, T-72h, ... same window, same gates. Absent days are
  // honest gaps (market dark / series does not reach), never thin moves.
  // Each covered day also carries its echo vs today's lead-in when today's
  // side is itself covered.
  const prior: PriorDay[] = []
  for (let back = 2; back <= 1 + (opts.priorDays ?? 0); back++) {
    const d = buildPriorDay(info, candles, { nowSec: opts.nowSec, windowSec: opts.windowSec, tfSec: opts.tfSec, back, todayLeadIn })
    if (d) prior.push(d)
  }

  return {
    asset: info.ticker,
    name: info.name,
    category: info.category,
    otc: info.otc,
    thenTs: t0,
    thenPrice,
    nowPrice: opts.nowPrice,
    sincePct: r4((opts.nowPrice / thenPrice - 1) * 100),
    movePct: r4(movePct),
    dir,
    rangePct: r4(rangePct),
    runUpPct: r4(Math.max(0, (high / thenPrice - 1) * 100)),
    drawdownPct: r4(Math.max(0, (1 - low / thenPrice) * 100)),
    barsFound: win.length,
    barsExpected,
    archived: Math.min(opts.archived, win.length),
    session: classifySession(t0, info.ticker),
    echo,
    prior,
    // the profile re-uses the SAME loaded series - days*24 extra lead-in
    // reads per row, no fetch; absent unless the scan asked for it
    ...(opts.profile ? { profile: buildSessionProfile(info, candles, { nowSec: opts.nowSec, windowSec: opts.windowSec, tfSec: opts.tfSec, days: (opts.priorDays ?? 0) + 1 }) } : {}),
  }
}
