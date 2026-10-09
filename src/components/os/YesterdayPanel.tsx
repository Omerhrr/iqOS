'use client'

// IQAIR//OS - Yesterday @ Now sidebar. Answers one question per open
// instrument: "what was the market DOING at this exact time yesterday - and
// in the window right after?" Each row replays the forward window that
// started at T-24h: net move, high-low travel, best excursion above/below
// the moment's price (the shape bar), where price has gone since (then ->
// now), and the session the market was in at the time. The lookback runs on
// the CHART's active timeframe (the tf chip shows what the kernel actually
// used - same respect rule as the Chart Signals scan) and the window chips
// pick how much of "after" to replay (kernel snaps the window to whole bars
// and echoes the effective one). Coverage is never implied: bars found vs
// expected and the archived fraction (kernel's own accumulated store vs the
// deterministic prehistory) ride on every row, and rows whose window is
// under half covered are dropped kernel-side instead of reporting a move
// computed from a fraction of the story.
//
// The ECHO line answers the follow-up: is TODAY repeating yesterday's
// script? Both sides are the lead-in window ending at the same wall-clock
// moment - yesterday's ended exactly at the anchor, today's within one bar
// of now - scored 0..100 for rhyme (direction 50 + move-vs-travel 30 +
// travel ratio 20). Rows without an echo had a side under half covered -
// no comparison instead of a fake one.
//
// The day-depth chips walk the SAME window further back (T-48h ... T-168h):
// each row grows a strip of remembered days - how this exact hour behaved
// across the week ("4d: 3/5 up"). Days the series cannot cover are absent
// from the strip, and the depth itself is bounded by the same 4000-bar
// lookback the scan already pulls: finer candles remember fewer days, so
// deeper chips disable with the tf says so instead of 400-ing.
//
// Two aggregate views close the loop. The RHYME-BY-CLASS strip averages each
// class's echo scores (compared rows only - no-echo rows are excluded, not
// scored zero), so "are OTC pairs rhyming today?" is one glance instead of
// mental math over 10 rows. And clicking an ECHO CHIP jumps the chart onto
// the script itself: the page deep-loads the asset's full day of candles
// (kernel /candles deep=1 - archive + live tail, never synthetic filler) and
// scrolls the time scale onto yesterday's lead-in plus the forward replay
// window. The scroll applies once per click, only after the deep bars land.
//
// The WEEK-RHYME aggregate ("at this hour ... ⟳ 2/3 rhyme") asks whether the
// rhyme held across the week or only matched yesterday: every remembered day
// carries its own echo (today's lead-in vs THAT day's lead-in, kernel-side,
// same coverage gates), the strip tags each day with its score, and the
// aggregate counts days scoring 70+ among the compared ones (yesterday's own
// echo included). No-echo days are excluded, never scored zero.
//
// The rhyme-by-class strip carries the same question one level up: each
// chip's main number averages yesterday's echo per class, and (once the scan
// walks deeper than 1d) the ⟳ number beside it averages every echoed
// day-observation in class (yesterday's echo + each remembered prior day's,
// same exclusion rule) - "are OTC pairs rhyming with the whole week?" is a
// glance, not math over a week of rows.
//
// The WEEK sort closes the loop: it turns the list into a best-echoes
// watchlist - rows rhyming (70+) with the most remembered days at this hour
// first, the average rhyme across those observations breaking ties, biggest
// window move after that. It disables at 1d, where the week would just be
// yesterday again (and falls back to the rhyme order if the depth drops).
//
// The QUIET flag guards all of it against one false signal: two FLAT
// lead-ins agree trivially (direction points for free), so a pair of dead
// hours can score 90+ while meaning nothing. The kernel marks such echoes
// (both sides flat by the same 10%-of-own-travel rule that sets dir), the
// panel dims them and tags them "quiet", and every aggregate - the row's
// N/M count, the class averages, the week averages, the week sort -
// excludes them with the exclusion counts in the tooltips.
//
// The SESSION PROFILE (the "by session" toggle) answers the question one
// echo cannot: does the script DIFFER by time of day? Every echo above
// compares lead-ins at ONE wall-clock hour - the panel's whole scan shares
// that hour, so a session tag on it is a constant, not an answer. With the
// toggle on, the kernel re-scores the SAME adjacent-day lead-in comparison
// at EVERY hour of the day (today vs yesterday when elapsed, then T-2 vs
// T-1, ... up to the loaded depth) from the candles the scan already
// pulled, aggregates the pairs per trading session, and each row grows a
// "script" line: Asia / London / Lon-NY / NY / off-hours averages, quiet
// echoes excluded from the averages and counted in the tooltip. -OTC pairs
// have no sessions - one day-wide OTC bucket instead. Hours a series cannot
// cover are fewer observations, never zeros.
//
// The SCRIPT BY CLASS strip (visible with the toggle on) folds the profile
// one level up: each class's row profiles summed per session - obs and
// quiet across rows, the kernel's unrounded rhyme total behind the average
// - so "does the class script differ by session, and does the OTC day-wide
// bucket look like a clock-bound class's?" is a glance. Clock-session
// columns come only from a class's real rows, the OTC column only from its
// -OTC twins; classes with nothing scorable are skipped, not zeroed.
//
// The PEAK sort closes the session trilogy: "trade the pair where its
// script rhymes". The best session average wins - a session needs at least
// TWO non-quiet observations to qualify (one lucky hour is not a script) -
// the spread between best and worst qualified session breaks ties (a wide
// spread means the script really differs by time of day, so the peak is
// worth trading), biggest window move after that. Rows without a qualified
// session sink. The script line marks the peak session bold and grows a
// spread tag (Δ best-worst); the sort needs the "by session" toggle and
// falls back to the rhyme order if it is switched off mid-selection.
//
// The OFF bucket carries its own honesty rule (the session-level cousin of
// the quiet flag): those hours sit OUTSIDE the named sessions, where the
// books are thin and the travel small. A rhyme there is real - quiet pairs
// are already excluded from every average - but it is not the same kind of
// evidence as a London peak, so the script line and the class strip draw
// their off-hours averages under a DOTTED UNDERLINE with the caveat in the
// tooltip, and the snapshot marks an off-hours peak "off*" (the legend
// spells it out). The ranking itself is untouched - the caveat travels with
// the number, it does not rewrite it.
//
// The watchlist leaves the panel through the COPY button: the current view
// (same filters, same sort) serialized into a shareable text snapshot - top
// 10 rows, one line each (echo rhyme, week aggregate, peak session + spread,
// window move) under a header recording the scan time, the sort and the
// filters. Each row with a measured profile also grows an indented "script"
// sub-line - the full session averages, so the SHAPE of the script travels
// with the snapshot, not just the peak cell (measured sessions only,
// off-hours cells marked off* like the dotted underline on screen). The
// comparators and the serializer live in src/lib/os/watchlist.ts, and the
// list on screen sorts by the very same code - the snapshot can never
// disagree with the list.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Timeframe, YesterdayRow, YdaySession } from '@/lib/os/client'
import { TIMEFRAME_SECONDS, fmtPrice, getYesterday } from '@/lib/os/client'
import { RHYME_OK, RHYME_BAD, cmpBySort, buildWatchlist, type WatchSort } from '@/lib/os/watchlist'

interface YesterdayPanelProps {
  onClose: () => void
  /** the chart's active timeframe - the 24h lookback replays on these candles */
  tf: Timeframe
  onSelectAsset?: (asset: string) => void
  /** echo-chip click-through: the page deep-loads the asset's day of candles
   * and scrolls the chart onto yesterday's lead-in + the forward replay window.
   * Receives the kernel-snapped effective window (whole tf bars). */
  onFocusWindow?: (r: YesterdayRow, effWindowMin: number) => void
}

type Mkt = 'all' | 'real' | 'otc'
type Cat = 'all' | 'forex' | 'crypto' | 'commodity' | 'stock' | 'index'
type Sort = WatchSort
type DirFilter = 'all' | 'up' | 'down' | 'none'
type EchoF = 'all' | 'rhymes' | 'diverges'

const WINDOWS: [number, string][] = [
  [15, '15m'],
  [30, '30m'],
  [60, '1h'],
  [120, '2h'],
]

const DAY_CHIPS: [number, string][] = [
  [1, '1d'],
  [2, '2d'],
  [3, '3d'],
  [5, '5d'],
  [7, '7d'],
]

/** Mirrors the kernel's depth gate: needed = ceil((86400*days + 2*window)/tf)
 * + 2 must fit the 4000-bar lookback, so the deepest reachable day depth is
 * floor(((4000-2)*tf - 2*window) / 86400) - the panel disables what the
 * kernel would refuse instead of round-tripping a 400. */
function maxDaysFor(tf: Timeframe, windowMin: number): number {
  const tfSec = TIMEFRAME_SECONDS[tf]
  return Math.max(1, Math.floor(((4000 - 2) * tfSec - 2 * windowMin * 60) / 86_400))
}

const SESSION_LABEL: Record<YesterdayRow['session'], string> = {
  ASIA: 'Asia',
  LONDON: 'London',
  OVERLAP: 'Lon/NY',
  NEWYORK: 'NY',
  OFF: 'off-hours',
  OTC: 'OTC',
}

/** column order + short heads for the script-by-class strip: the five clock
 * sessions first (real rows only), the day-wide OTC bucket last (the -OTC
 * twins' - it is not a session, it is the absence of one). */
const SCRIPT_COLS: { session: YdaySession; short: string }[] = [
  { session: 'ASIA', short: 'Asia' },
  { session: 'LONDON', short: 'Lon' },
  { session: 'OVERLAP', short: 'L/N' },
  { session: 'NEWYORK', short: 'NY' },
  { session: 'OFF', short: 'off' },
  { session: 'OTC', short: 'OTC' },
]

/** the class taxonomy both strips share - OTC answers over the otc flag
 * (mostly the -OTC fx twins), the others over r.category. */
const CLASS_DEFS: { key: 'otc' | 'forex' | 'crypto' | 'commodity' | 'stock' | 'index'; label: string; why: string; pick: (r: YesterdayRow) => boolean }[] = [
  { key: 'otc', label: 'OTC', why: 'over-the-counter pairs (the -OTC twins)', pick: (r) => r.otc },
  { key: 'forex', label: 'FX', why: 'currency pairs (incl. their OTC twins)', pick: (r) => r.category === 'forex' },
  { key: 'crypto', label: 'Crypto', why: 'crypto pairs - 24/7 real markets', pick: (r) => r.category === 'crypto' },
  { key: 'commodity', label: 'Comm', why: 'metals, energy, agriculture', pick: (r) => r.category === 'commodity' },
  { key: 'stock', label: 'Stocks', why: 'single-name equities', pick: (r) => r.category === 'stock' },
  { key: 'index', label: 'Idx', why: 'index CFDs', pick: (r) => r.category === 'index' },
]

function DirChip({ dir }: { dir: YesterdayRow['dir'] }) {
  const map = {
    up: 'bg-emerald-500/20 text-emerald-300',
    down: 'bg-rose-500/20 text-rose-300',
    none: 'bg-[#1c2739] text-[#7c8aa5]',
  } as const
  const glyph = { up: '▲', down: '▼', none: '—' } as const
  const word = { up: 'up', down: 'down', none: 'flat' } as const
  return (
    <span className={`rounded px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-wider ${map[dir]}`}>
      {glyph[dir]} {word[dir]}
    </span>
  )
}

/** The window's shape: split bar of best excursion above (green) vs below
 * (red) the moment's price - how the hour actually traveled. */
function ShapeBar({ r }: { r: YesterdayRow }) {
  const up = r.runUpPct
  const down = r.drawdownPct
  const total = up + down
  const upW = total > 0 ? (up / total) * 100 : 50
  return (
    <div
      className="flex h-1 w-full overflow-hidden rounded bg-[#101828]"
      title={`window shape: ran +${up.toFixed(3)}% above ${fmtPrice(r.thenPrice, r.asset)}, dipped -${down.toFixed(3)}% below (range ${(r.rangePct ?? 0).toFixed(3)}%)`}
    >
      <div className="h-full bg-emerald-500" style={{ width: `${upW}%` }} />
      <div className="h-full bg-rose-500" style={{ width: `${100 - upW}%` }} />
    </div>
  )
}

/** The rhyme badge: is today's lead-in echoing yesterday's? Color carries
 * the verdict (emerald rhymes / amber partial / rose diverges), the tooltip
 * quotes the score's three parts. QUIET rhymes (both lead-ins flat - two
 * dead hours agreeing trivially) are dimmed and marked, so a 90-from-flat
 * never masquerades as a strong echo. Clicking jumps the chart onto the
 * script: yesterday's lead-in plus the forward replay window (the page
 * deep-loads a day of bars first, so the story actually has history behind
 * it). */
function EchoChip({ e, onJump }: { e: NonNullable<YesterdayRow['echo']>; onJump?: () => void }) {
  const q = e.quiet === true
  const cls =
    e.rhyme >= RHYME_OK
      ? 'bg-emerald-500/15 text-emerald-300'
      : e.rhyme >= RHYME_BAD
        ? 'bg-amber-500/15 text-amber-300'
        : 'bg-rose-500/15 text-rose-300'
  const glyph = e.rhyme >= RHYME_OK ? '⟳' : e.rhyme >= RHYME_BAD ? '≈' : '✗'
  const word = e.rhyme >= RHYME_OK ? 'rhymes' : e.rhyme >= RHYME_BAD ? 'partial' : 'diverges'
  return (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation()
        onJump?.()
      }}
      className={`cursor-pointer rounded px-1.5 py-px font-mono text-[10px] font-bold transition hover:brightness-150 ${cls}${q ? ' opacity-70' : ''}`}
      title={`echo rhyme ${e.rhyme}/100 (${word}) - direction agreement 50 pts (yesterday ${e.dirAgree}), today's move vs yesterday's measured against yesterday's own travel 30 pts, travel ratio 20 pts.${q ? ' QUIET: both lead-ins flat (net move under 10% of travel on both sides) - the agreement is real but trivial (two dead hours), so aggregates do not count it.' : ''} Lead-in windows end at the same wall-clock moment: yesterday's at the anchor, today's within one bar of now. Click: the chart loads this asset's full day of bars and scrolls onto yesterday's lead-in + the forward replay window.`}
    >
      {glyph} {e.rhyme}
      {q && <span className="ml-1 font-normal text-[8.5px] opacity-80">quiet</span>}
    </button>
  )
}

function RowCard({ r, onSelectAsset, onFocusWindow, windowMin }: { r: YesterdayRow; onSelectAsset?: (a: string) => void; onFocusWindow?: (r: YesterdayRow, effWindowMin: number) => void; windowMin: number }) {
  const thenClock = new Date(r.thenTs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const cov = r.barsExpected > 0 ? Math.round((r.barsFound / r.barsExpected) * 100) : 0
  const partial = cov < 100
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectAsset?.(r.asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelectAsset?.(r.asset)
      }}
      className="w-full cursor-pointer rounded-lg border border-[#1c2739] bg-[#0b111c] p-2 text-left transition-colors hover:border-violet-500/40"
      title={`open ${r.asset} on the chart - window started ${thenClock} yesterday (${r.barsFound}/${r.barsExpected} bars)`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <DirChip dir={r.dir} />
        <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{r.asset}</span>
        {r.otc && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-amber-400">otc</span>
        )}
        <span
          className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] uppercase tracking-wide text-[#7c8aa5]"
          title="the session the market was in at that moment yesterday"
        >
          {SESSION_LABEL[r.session]}
        </span>
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">{thenClock} · {windowMin}m</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2 font-mono text-[9px]">
        <span className="text-[#4b5a72]">then</span>
        <span className="text-[#aab6cc]">{fmtPrice(r.thenPrice, r.asset)}</span>
        <span className="text-[#3d4d66]">→</span>
        <span className="text-[#4b5a72]">now</span>
        <span className="text-[#aab6cc]">{fmtPrice(r.nowPrice, r.asset)}</span>
        <span className={`ml-auto ${r.sincePct >= 0 ? 'text-emerald-300/80' : 'text-rose-300/80'}`} title="where the market has gone since that moment yesterday">
          since {r.sincePct >= 0 ? '+' : ''}{r.sincePct.toFixed(2)}%
        </span>
      </div>
      <div className="mt-1.5">
        <ShapeBar r={r} />
      </div>
      {r.echo ? (
        <div
          className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px]"
          title={`lead-in comparison, yesterday vs today: travel ${r.echo.ydayRangePct.toFixed(2)}% then, ${r.echo.todayRangePct.toFixed(2)}% now (${r.echo.todayBarsFound}/${r.barsExpected} bars on today's side)`}
        >
          <EchoChip e={r.echo} onJump={onFocusWindow ? () => onFocusWindow(r, windowMin) : undefined} />
          <span className="text-[#4b5a72]">yday</span>
          <span className={r.echo.ydayMovePct >= 0 ? 'text-emerald-300/70' : 'text-rose-300/70'}>
            {r.echo.ydayMovePct >= 0 ? '+' : ''}{r.echo.ydayMovePct.toFixed(2)}%
          </span>
          <span className="text-[#3d4d66]">vs</span>
          <span className="text-[#4b5a72]">today</span>
          <span className={r.echo.todayMovePct >= 0 ? 'text-emerald-300/70' : 'text-rose-300/70'}>
            {r.echo.todayMovePct >= 0 ? '+' : ''}{r.echo.todayMovePct.toFixed(2)}%
          </span>
        </div>
      ) : (
        <div className="mt-1.5 font-mono text-[9px] text-[#3d4d66]" title="no echo: yesterday's or today's lead-in window is under half covered (dark session / asset never warmed) - no comparison instead of a fake one">
          echo —
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px]">
        <span
          className={r.dir === 'up' ? 'text-emerald-300' : r.dir === 'down' ? 'text-rose-300' : 'text-[#7c8aa5]'}
          title="net move over the window that started at that moment yesterday"
        >
          {r.movePct >= 0 ? '+' : ''}{r.movePct.toFixed(2)}% move
        </span>
        <span className="text-[#7c8aa5]" title="high-low travel across the window">
          {r.rangePct.toFixed(2)}% range
        </span>
        <span
          className={`ml-auto ${partial ? 'text-amber-400/80' : 'text-[#4b5a72]'}`}
          title={
            partial
              ? `partial window: ${r.barsFound} of ${r.barsExpected} bars present (${cov}%) - market may have been dark part of the window`
              : `${r.barsFound}/${r.barsExpected} bars present`
          }
        >
          {r.barsFound}/{r.barsExpected} bars
        </span>
        <span
          className={r.archived > 0 ? 'text-[#4b5a72]' : 'text-[#3d4d66]'}
          title={
            r.archived > 0
              ? `${r.archived} of the window's bars come from the kernel's own accumulated store - the rest is the feed's deterministic prehistory`
              : "no accumulated store bars in this window - the story is the feed's deterministic prehistory, not a remembered market"
          }
        >
          {r.archived > 0 ? `${r.archived} arch` : 'seeded'}
        </span>
      </div>
      {r.prior && r.prior.length > 0 && <PriorStrip r={r} />}
      {r.profile && <SessionScript prof={r.profile} />}
    </div>
  )
}

/** The same-hour history strip: how this exact hour behaved across the
 * remembered days before yesterday. Gaps are absent days (dark market /
 * series does not reach), not flat days - the count includes yesterday's
 * replay window so "3/4 up" reads as a week-level seasonality stat. Each
 * remembered day also carries its own rhyme tag (today's lead-in vs THAT
 * day's lead-in), and the aggregate "N/M rhyme" says whether the rhyme held
 * across the week or only matched yesterday - compared days only, never
 * zero-filled. QUIET rhymes (both lead-ins flat - trivial agreement) are
 * marked on the day tags and excluded from the aggregate, with the
 * exclusion count in its tooltip. */
function PriorStrip({ r }: { r: YesterdayRow }) {
  const prior = r.prior ?? []
  if (prior.length === 0) return null
  const days = prior.length + 1
  const ups = prior.filter((p) => p.dir === 'up').length + (r.dir === 'up' ? 1 : 0)
  // every echoed day-observation with its quiet flag - the aggregate ranks
  // only non-quiet rhymes (a rhyme between two flat hours is real but trivial)
  const obs = [
    ...(r.echo ? [{ v: r.echo.rhyme, q: r.echo.quiet === true }] : []),
    ...(r.prior ?? []).flatMap((p) => (p.echo ? [{ v: p.echo.rhyme, q: p.echo.quiet === true }] : [])),
  ]
  const kept = obs.filter((o) => !o.q)
  const quietN = obs.length - kept.length
  const rhymed = kept.filter((o) => o.v >= RHYME_OK).length
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[9px]">
      <span className="text-[#3d4d66]">at this hour</span>
      {prior.map((p) => (
        <span
          key={p.back}
          className={p.dir === 'up' ? 'text-emerald-300/80' : p.dir === 'down' ? 'text-rose-300/80' : 'text-[#7c8aa5]'}
          title={`${p.back}d ago, the ${p.barsFound}/${p.barsExpected}-bar window from ${new Date(p.thenTs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${p.movePct >= 0 ? '+' : ''}${p.movePct.toFixed(2)}% move, ${p.rangePct.toFixed(2)}% travel, session ${p.session}${p.echo ? ` - today's lead-in vs this day's: rhyme ${p.echo.rhyme}/100 (${p.echo.dirAgree})${p.echo.quiet === true ? ' - QUIET, both lead-ins flat (trivial agreement, excluded from aggregates)' : ''}` : ' - no echo (a side under half covered)'}`}
        >
          {p.back}d {p.dir === 'up' ? '\u25b2' : p.dir === 'down' ? '\u25bc' : '\u2014'}{Math.abs(p.movePct).toFixed(2)}
          {p.echo && (
            <span className={`ml-1 ${p.echo.rhyme >= RHYME_OK ? 'text-emerald-300' : p.echo.rhyme >= RHYME_BAD ? 'text-amber-300' : 'text-rose-300'}${p.echo.quiet === true ? ' opacity-70' : ''}`}>
              {p.echo.rhyme >= RHYME_OK ? '\u27f3' : p.echo.rhyme >= RHYME_BAD ? '\u2248' : '\u2717'}{p.echo.rhyme}
              {p.echo.quiet === true && <span className="font-normal opacity-80">q</span>}
            </span>
          )}
        </span>
      ))}
      <span className="ml-auto text-[#4b5a72]" title={`of the last ${days} days at this hour (yesterday's replay included), ${ups} opened a window that closed up`}>
        {ups}/{days} up
      </span>
      {kept.length > 0 && (
        <span
          className={rhymed > 0 ? 'text-emerald-300/80' : 'text-[#4b5a72]'}
          title={`today's lead-in rhymed (score ${RHYME_OK}+) with ${rhymed} of the ${kept.length} remembered day${kept.length === 1 ? '' : 's'} at this hour (yesterday included, non-quiet comparisons only). Days without a comparison are excluded, not scored zero - so "0/3" can still mean every side was dark.${quietN > 0 ? ` ${quietN} quiet rhym${quietN === 1 ? 'e is' : 'es are'} excluded (both lead-ins flat - the agreement was trivial).` : ''}`}
        >
          {'\u27f3'} {rhymed}/{kept.length} rhyme
        </span>
      )}
    </div>
  )
}

/** The script-by-session micro line: the kernel scored the SAME adjacent-day
 * lead-in echo at every hour of the day and averaged it per session - so
 * "rhymes in London, diverges off-hours" is a glance, not folklore. Quiet
 * echoes (both lead-ins flat) are excluded from the averages, counted in the
 * tooltip; a session with nothing scorable reads "—" (honest zero, not an
 * absent session). OTC pairs have no sessions - one day-wide bucket. The
 * PEAK session (best average among sessions with 2+ non-quiet observations -
 * a single lucky hour is not a script) is marked bold at full color, and a
 * spread tag (best minus worst qualified) says how much the script differs
 * by time of day: near 0 the script is session-independent, a wide spread
 * means trade the pair only where it rhymes. OFF-HOURS averages (the OFF
 * bucket, obs > 0) sit under a dotted underline with the caveat in the
 * tooltip - real rhymes at hours where the books are thin, weight them
 * accordingly. */
function SessionScript({ prof }: { prof: NonNullable<YesterdayRow['profile']> }) {
  if (!prof.some((s) => s.obs > 0)) return null
  const quals = prof.filter((s) => s.obs - s.quiet >= 2 && s.avg != null)
  const peak = quals.length ? quals.reduce((a, b) => (b.avg! > a.avg! ? b : a)) : null
  const worst = quals.length > 1 ? quals.reduce((a, b) => (b.avg! < a.avg! ? b : a)) : null
  const spread = peak && worst ? peak.avg! - worst.avg! : null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px]">
      <span
        className="text-[#3d4d66]"
        title="the same lead-in echo scored at EVERY hour of the day, averaged per trading session - does this pair's script differ ASIA vs LONDON vs NY? Quiet echoes (both lead-ins flat) are excluded from the averages; hours the series cannot cover are fewer observations, never zeros. The bold value is the peak session (2+ non-quiet observations required) and the spread tag is how far the worst qualified session sits below it."
      >
        script
      </span>
      {prof.map((s) => {
        const isPeak = peak != null && s.session === peak.session
        const offHours = s.session === 'OFF' && s.obs > 0
        const color =
          s.avg == null
            ? 'text-[#2a3648]'
            : s.avg >= RHYME_OK
              ? isPeak
                ? 'text-emerald-300'
                : 'text-emerald-300/80'
              : s.avg >= RHYME_BAD
                ? isPeak
                  ? 'text-amber-300'
                  : 'text-amber-300/80'
                : isPeak
                  ? 'text-rose-300'
                  : 'text-rose-300/80'
        return (
          <span
            key={s.session}
            className={`${color}${isPeak ? ' font-bold' : ''}${offHours ? ' underline decoration-dotted decoration-[#4b5a72] underline-offset-2' : ''}`}
            title={`${SESSION_LABEL[s.session]}: average rhyme ${s.avg ?? '—'}/100 across ${s.obs} adjacent-day lead-in echo${s.obs === 1 ? '' : 's'} scored at this session's hours (quiet excluded: ${s.quiet}${s.obs - s.quiet === s.obs && s.obs > 0 ? ' - every pair here was two flat hours' : ''}). Same rhyme score as the echo chip: direction 50 + move-vs-travel 30 + travel ratio 20.${isPeak ? ' PEAK of the script - the best average among sessions with at least two non-quiet observations.' : ''}${offHours ? ' OFF-HOURS CAVEAT: these hours sit outside the named sessions, where the books are thin and moves are small - the rhyme is real (quiet pairs are already excluded) but weight it accordingly.' : ''}`}
          >
            {SESSION_LABEL[s.session]} {s.avg ?? '—'}
          </span>
        )
      })}
      {spread != null && (
        <span
          className="text-[#7c8aa5]"
          title={`spread: best session (${SESSION_LABEL[peak!.session]} ${peak!.avg}) minus worst (${SESSION_LABEL[worst!.session]} ${worst!.avg}) among the sessions with 2+ non-quiet observations - how much this pair's script differs by time of day. Near 0 the script is session-independent; a wide spread means trade the pair only where it rhymes.`}
        >
          {'\u0394'}
          {spread}
        </span>
      )}
    </div>
  )
}

export default function YesterdayPanel({ onClose, tf, onSelectAsset, onFocusWindow }: YesterdayPanelProps) {
  const [windowMin, setWindowMin] = useState(60)
  const [days, setDays] = useState(1)
  const [mkt, setMkt] = useState<Mkt>('all')
  const [cat, setCat] = useState<Cat>('all')
  const [dirF, setDirF] = useState<DirFilter>('all')
  const [echoF, setEchoF] = useState<EchoF>('all')
  const [sort, setSort] = useState<Sort>('move')
  const [profOn, setProfOn] = useState(false)
  const [query, setQuery] = useState('')
  const [data, setData] = useState<Awaited<ReturnType<typeof getYesterday>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  // the 24h lookback cannot fit the archive depth below 30s candles - say so
  // instead of round-tripping a 400 the operator can't act on
  const tfSupported = TIMEFRAME_SECONDS[tf] >= 30
  // depth the current tf:window combination can honestly reach - the panel
  // clamps silently when the window widens and highlights the snapped chip
  const maxDays = maxDaysFor(tf, windowMin)
  const effDays = Math.min(days, maxDays)

  const load = useCallback(
    (opts?: { quiet?: boolean }) => {
      if (!tfSupported) return
      if (!opts?.quiet) setBusy(true)
      getYesterday(tf, windowMin, effDays, profOn)
        .then((d) => {
          if (d?.ok) {
            setData(d)
            setError(null)
          }
        })
        .catch((e: Error) => setError(e.message.slice(0, 180)))
        .finally(() => setBusy(false))
    },
    [tf, windowMin, effDays, tfSupported, profOn],
  )

  useEffect(() => {
    load()
    // the kernel caches each tf:window scan for 60s (the T-24h target crawls
    // forward one second per second) - a 15s poll always lands on a warm scan
    const iv = setInterval(() => load({ quiet: true }), 15_000)
    return () => clearInterval(iv)
  }, [load])

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(iv)
  }, [])

  const needle = query.trim().toLowerCase()
  const rows = (data?.rows ?? [])
    .filter((r) => (mkt === 'all' ? true : mkt === 'otc' ? r.otc : !r.otc))
    .filter((r) => (cat === 'all' ? true : r.category === cat))
    .filter((r) => (dirF === 'all' ? true : r.dir === dirF))
    .filter((r) =>
      echoF === 'all'
        ? true
        : echoF === 'rhymes'
          ? (r.echo?.rhyme ?? -1) >= RHYME_OK
          : r.echo != null && r.echo.rhyme < RHYME_BAD,
    )
    .filter((r) => (!needle ? true : r.asset.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)))
    .sort(cmpBySort(sort))
  // the week numbers only mean something once the scan actually carries prior
  // echoes (a day chip beyond 1d, on a kernel that computes them) - at 1d they
  // would be pure duplicates of the yesterday averages, so they stay hidden
  const weekLive = (data?.rows ?? []).some((r) => (r.prior ?? []).some((p) => p.echo != null))
  // the peak sort needs the per-session profile - it exists only while the
  // "by session" toggle is on (the kernel computes it on request); rows with
  // profiles but nothing measured count as not live
  const profLive = (data?.rows ?? []).some((r) => (r.profile ?? []).some((s) => s.obs > 0))
  // the week sort needs prior echoes - if the depth drops back to 1d while it
  // is selected, fall back to the yesterday-rhyme order instead of leaving a
  // disabled chip selected. The peak sort does the same when the "by session"
  // toggle goes off mid-selection.
  useEffect(() => {
    if (!weekLive && sort === 'week') setSort('rhyme')
    if (!profLive && sort === 'peak') setSort('rhyme')
  }, [weekLive, profLive, sort])
  const otcLive = (data?.rows ?? []).filter((r) => r.otc).length
  const rhymeLive = (data?.rows ?? []).filter((r) => (r.echo?.rhyme ?? -1) >= RHYME_OK).length
  const catCount = (c: Cat) => (c === 'all' ? (data?.rows ?? []).length : (data?.rows ?? []).filter((r) => r.category === c).length)
  const ageSec = data ? Math.max(0, Math.round((now - data.ts) / 1000)) : 0

  // the watchlist leaving the panel: serialize the CURRENT view (same
  // filters, same sort) into a shareable text snapshot and copy it. The
  // ordering comes from the very comparators the list on screen sorts by
  // (src/lib/os/watchlist.ts) - the snapshot can never disagree with the
  // list. Clipboard API first, textarea fallback for non-secure contexts.
  const copyWatchlist = () => {
    if (!data || rows.length === 0) return
    const text = buildWatchlist({
      rows,
      sort,
      tsMs: data.ts,
      mktLabel: mkt === 'all' ? 'all markets' : mkt.toUpperCase(),
      catLabel: cat === 'all' ? 'all classes' : cat,
    })
    const flash = () => {
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current)
      setCopied(true)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
    }
    const fallback = () => {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        // clipboard unavailable - nothing else to try; still flash so the
        // operator knows the click landed
      }
      document.body.removeChild(ta)
      flash()
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(flash, fallback)
    else fallback()
  }

  // per-class rhyme averages - "are OTC pairs rhyming today?" at a glance.
  // Averages run ONLY over rows carrying a NON-QUIET echo (the honest
  // denominator; a rhyme between two flat lead-ins is real but trivial and
  // would inflate the average - quiet echoes are excluded and counted for
  // the tooltips); the OTC entry answers over the otc flag (mostly the -OTC
  // fx twins), the others over r.category. The week average (wkAvg) runs the
  // same arithmetic over EVERY non-quiet echoed day-observation in class -
  // the row's own echo plus each remembered prior day's, same inclusion rule
  // as the row's "N/M rhyme" (yesterday included, no-echo days excluded,
  // never zeroed) - so "are OTC pairs rhyming with the whole week?" is the
  // glance next to it. The strip always reads the FULL scan - it is a
  // readout, and its click just sets the filters above.
  const classRhyme = useMemo(() => {
    const rowsAll = data?.rows ?? []
    const build = (pick: (r: YesterdayRow) => boolean) => {
      const sub = rowsAll.filter(pick)
      const es = sub.flatMap((r) => (r.echo && r.echo.quiet !== true ? [r.echo.rhyme] : []))
      const avg = es.length ? Math.round(es.reduce((s, x) => s + x, 0) / es.length) : null
      const wk = sub.flatMap((r) => [
        ...(r.echo && r.echo.quiet !== true ? [r.echo.rhyme] : []),
        ...(r.prior ?? []).flatMap((p) => (p.echo && p.echo.quiet !== true ? [p.echo.rhyme] : [])),
      ])
      const wkAvg = wk.length ? Math.round(wk.reduce((s, x) => s + x, 0) / wk.length) : null
      const mainQuiet = sub.filter((r) => r.echo?.quiet === true).length
      const wkQuiet = sub.reduce((n, r) => n + (r.echo?.quiet === true ? 1 : 0) + (r.prior ?? []).filter((p) => p.echo?.quiet === true).length, 0)
      return {
        rows: sub.length,
        compared: es.length,
        ok: es.filter((x) => x >= RHYME_OK).length,
        bad: es.filter((x) => x < RHYME_BAD).length,
        avg,
        mainQuiet,
        wkObs: wk.length,
        wkRhymed: wk.filter((x) => x >= RHYME_OK).length,
        wkAvg,
        wkQuiet,
      }
    }
    return CLASS_DEFS.map(({ key, label, why, pick }) => ({ key, label, why, agg: build(pick) }))
  }, [data])

  // the session profile one level up - the class strip's averages broken out
  // by session ("does the OTC day-wide script look like FX's London one?").
  // Folds each class's row profiles per session: obs and quiet sum across
  // rows and the rhyme total sums too (the kernel's unrounded bucket sum;
  // the avg x kept fallback keeps the fold honest against an older kernel),
  // so the class average is round(totalSum / totalKept) - a weighted mean of
  // the rows' echoes, never an average of rounded averages. Clock sessions
  // come only from the class's real rows (every real row carries all five
  // buckets, obs 0 when a session had nothing scorable), the OTC bucket only
  // from its -OTC twins; a session absent from the fold means the class has
  // no rows of that kind at all.
  const classScript = useMemo(() => {
    if (!profOn) return []
    const rowsAll = data?.rows ?? []
    const fold = (pick: (r: YesterdayRow) => boolean) => {
      const per = new Map<YdaySession, { obs: number; quiet: number; sum: number; kept: number }>()
      for (const r of rowsAll.filter(pick)) {
        for (const s of r.profile ?? []) {
          const kept = s.obs - s.quiet
          const t = per.get(s.session) ?? { obs: 0, quiet: 0, sum: 0, kept: 0 }
          t.obs += s.obs
          t.quiet += s.quiet
          if (kept > 0) {
            t.sum += s.sum ?? (s.avg ?? 0) * kept
            t.kept += kept
          }
          per.set(s.session, t)
        }
      }
      return SCRIPT_COLS.filter(({ session }) => per.has(session)).map(({ session }) => {
        const t = per.get(session)!
        return { session, obs: t.obs, quiet: t.quiet, avg: t.kept > 0 ? Math.round(t.sum / t.kept) : null }
      })
    }
    return CLASS_DEFS.map(({ key, label, why, pick }) => ({ key, label, why, rows: rowsAll.filter(pick).length, cells: fold(pick) }))
  }, [profOn, data])
  const scriptLive = classScript.some((c) => c.cells.some((s) => s.obs > 0))

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-1 border-b border-[#1c2739] px-2 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-violet-300">Yesterday @ Now</span>
        <span
          className="rounded border border-violet-500/40 bg-violet-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-violet-300"
          title="the 24h lookback is computed on the chart's current timeframe - switch the chart's tf and the story is rebuilt on those candles"
        >
          {data?.tf ?? tf}
        </span>
        <span
          className={`rounded border px-1 py-px font-mono text-[8px] font-bold uppercase ${
            data?.mode === 'live' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-[#1c2739] text-[#7c8aa5]'
          }`}
          title={
            data?.mode === 'live'
              ? 'live broker feed - window bars are accumulated market data (plus deterministic fill where history is thin)'
              : 'sim feed - the whole story is the deterministic sim engine, not a remembered market'
          }
        >
          {data?.mode ?? '—'}
        </span>
        <span className="mx-0.5 h-3 w-px bg-[#1c2739]" />
        {WINDOWS.map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setWindowMin(m)}
            className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
              windowMin === m ? 'bg-violet-500/15 text-violet-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
            title={`replay the ${label} window that started at this time yesterday (kernel snaps it to whole bars of the tf)`}
          >
            {label}
          </button>
        ))}
        <span className="mx-0.5 h-3 w-px bg-[#1c2739]" />
        {DAY_CHIPS.map(([d, label]) => {
          const reachable = d <= maxDays
          return (
            <button
              key={d}
              type="button"
              onClick={() => reachable && setDays(d)}
              disabled={!reachable}
              className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
                effDays === d
                  ? 'bg-violet-500/15 text-violet-300'
                  : reachable
                    ? 'text-[#4b5a72] hover:text-[#aab6cc]'
                    : 'cursor-not-allowed text-[#2a3648]'
              }`}
              title={
                reachable
                  ? `walk the same window back over the last ${d} day${d === 1 ? '' : 's'} - each row grows a same-hour history strip (T-24h ... T-${24 * d}h)`
                  : `${d} days of ${tf} candles plus the replay window cannot fit the 4000-bar lookback - coarsen the tf or shrink the window`
              }
            >
              {label}
            </button>
          )
        })}
        {data && (
          <span
            className="ml-auto font-mono text-[8px] text-[#4b5a72]"
            title="instruments scanned / rows with enough window coverage · skipped (thin history) · scan age · scan duration"
          >
            {data.considered}/{data.scanned} rows · {data.skipped} skip · {ageSec}s · {data.scanMs}ms
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          title="close the yesterday sidebar (market watch + indicators return)"
          className="ml-1 flex h-5 w-5 items-center justify-center rounded border border-[#1c2739] font-mono text-[11px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
        >
          ×
        </button>
      </div>

      {/* search + market/class filters - same composition as the signals panel */}
      <div className="flex items-center gap-1 border-b border-[#1c2739] px-2 py-1">
        <div className="relative min-w-0 flex-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="search… e.g. EURUSD-OTC, gold"
            spellCheck={false}
            className="w-full rounded border border-[#1c2739] bg-[#101828] px-2 py-1 pr-6 font-mono text-[10px] text-[#e2e8f0] placeholder-[#3d4d66] outline-none focus:border-violet-500/50"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              title="clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 font-mono text-[10px] text-[#4b5a72] hover:text-rose-300"
            >
              ×
            </button>
          )}
        </div>
        {(
          [
            ['all', 'All'],
            ['real', 'Real'],
            ['otc', 'OTC'],
          ] as [Mkt, string][]
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMkt(m)}
            className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
              mkt === m
                ? m === 'otc'
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-violet-500/15 text-violet-300'
                : m === 'otc' && otcLive > 0
                  ? 'text-amber-400/70 hover:text-amber-300'
                  : 'text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
            title={m === 'otc' ? "only the over-the-counter pairs' yesterday stories" : m === 'real' ? 'only real-market instruments' : 'every open instrument'}
          >
            {label}
            {m === 'otc' && otcLive > 0 && ` ${otcLive}`}
          </button>
        ))}
        {(
          [
            ['all', 'All', 'every asset class'],
            ['forex', 'FX', 'currency pairs (incl. their OTC twins)'],
            ['crypto', 'Crypto', 'crypto pairs - 24/7 real markets'],
            ['commodity', 'Comm', 'metals, energy, agriculture'],
            ['stock', 'Stocks', 'single-name equities'],
            ['index', 'Idx', 'index CFDs'],
          ] as [Cat, string, string][]
        ).map(([c, label, why]) => {
          const n = catCount(c)
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors ${
                cat === c ? 'bg-violet-500/15 text-violet-300' : n > 0 ? 'text-[#7c8aa5] hover:text-[#aab6cc]' : 'text-[#3d4d66]'
              }`}
              title={`${why} · ${n} yesterday row${n === 1 ? '' : 's'} in class`}
            >
              {label}
              {n > 0 && ` ${n}`}
            </button>
          )
        })}
      </div>

      {/* direction + echo filter + sort - "show me what pumped at this hour, and where today repeats it" */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1c2739] px-2 py-1">
        <div className="flex shrink-0 overflow-hidden rounded border border-[#1c2739]" role="group" aria-label="direction filter">
          {(
            [
              ['all', 'all', 'every direction'],
              ['up', 'up', "rows whose window moved up at this time yesterday"],
              ['down', 'down', "rows whose window moved down at this time yesterday"],
              ['none', 'flat', 'rows whose window went nowhere (net move under 10% of its own range)'],
            ] as [DirFilter, string, string][]
          ).map(([v, label, why]) => (
            <button
              key={v}
              type="button"
              onClick={() => setDirF(v)}
              title={why}
              className={`px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-wider transition-colors ${
                dirF === v ? 'bg-violet-500/15 text-violet-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 overflow-hidden rounded border border-[#1c2739]" role="group" aria-label="echo filter">
          {(
            [
              ['all', 'all', 'every row - rhyming, diverging and rows with no comparison'],
              ['rhymes', `rhymes${rhymeLive > 0 ? ` ${rhymeLive}` : ''}`, `only rows scoring ${RHYME_OK}+ - today is tracing yesterday's lead-in (quiet rhymes still count here - the filter reads the score, the aggregates mark them)`],
              ['diverges', 'diverge', `only rows scoring under ${RHYME_BAD} - today is going its own way`],
            ] as [EchoF, string, string][]
          ).map(([v, label, why]) => (
            <button
              key={v}
              type="button"
              onClick={() => setEchoF(v)}
              title={why}
              className={`px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-wider transition-colors ${
                echoF === v
                  ? v === 'rhymes'
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : v === 'diverges'
                      ? 'bg-rose-500/15 text-rose-300'
                      : 'bg-violet-500/15 text-violet-300'
                  : 'text-[#4b5a72] hover:text-[#aab6cc]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 overflow-hidden rounded border border-[#1c2739]" role="group" aria-label="sort order">
          {(
            [
              ['move', 'move', 'biggest yesterday-window move first (kernel order)'],
              ['since', 'since', 'biggest 24h drift first - where the market has gone since that moment'],
              ['rhyme', 'rhyme', 'best echo rhyme first - where today is repeating yesterday\'s lead-in (rows without a comparison sink)'],
              ['week', 'week', "best echoes of the week first - rows rhyming (70+) with the most remembered days at this hour, average rhyme breaking ties (rows without any non-quiet comparison sink - quiet rhymes, both lead-ins flat, don't count)"],
              ['peak', 'peak', "trade the pair where its script rhymes - best session average first (sessions need 2+ non-quiet observations to qualify: one lucky hour is not a script), the spread between best and worst qualified session breaking ties (a wide spread means the script really differs by time of day), biggest window move after that (rows without a qualified session sink)"],
              ['range', 'range', 'widest high-low travel in the window first - the most restless hours'],
            ] as [Sort, string, string][]
          ).map(([v, label, why]) => {
            const dimmed = (v === 'week' && !weekLive) || (v === 'peak' && !profLive)
            return (
              <button
                key={v}
                type="button"
                onClick={() => !dimmed && setSort(v)}
                disabled={dimmed}
                title={dimmed ? (v === 'week' ? `${why} - pick a day chip beyond 1d first (the week order needs the prior-day echoes)` : `${why} - turn on 'by session' first (the kernel computes the per-session profile only then)`) : why}
                className={`px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-wider transition-colors ${
                  sort === v
                    ? 'bg-violet-500/15 text-violet-300'
                    : dimmed
                      ? 'cursor-not-allowed text-[#2a3648]'
                      : 'text-[#4b5a72] hover:text-[#aab6cc]'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => setProfOn((v) => !v)}
          className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-wider transition-colors ${
            profOn ? 'border-violet-500/40 bg-violet-500/15 text-violet-300' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#aab6cc]'
          }`}
          title="score the same lead-in echo at EVERY hour of the day and average it per trading session - does this pair's script differ ASIA vs LONDON vs NY? Each row grows a 'script' line (Asia / London / Lon-NY / NY / off-hours averages, quiet echoes excluded from the averages). -OTC pairs have no sessions - one day-wide OTC bucket. The kernel computes it from the candles the scan already pulls; the scan just reads more windows. The rhyme-by-class strip grows a matching 'script by class' readout - each class's averages folded across its rows."
        >
          by session
        </button>
        <button
          type="button"
          onClick={copyWatchlist}
          disabled={!data || rows.length === 0}
          className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-wider transition-colors ${
            copied
              ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
              : !data || rows.length === 0
                ? 'cursor-not-allowed border-[#1c2739] text-[#2a3648]'
                : 'border-[#1c2739] text-[#4b5a72] hover:text-[#aab6cc]'
          }`}
          title="copy the current view as a shareable text watchlist - the same filters and the same sort, top 10 rows, one line each (echo rhyme, week aggregate rhymed/kept + avg, peak session with its spread, window move) under a header recording the scan time, the sort and the filters. Rows with a measured profile grow an indented script sub-line (the full session averages - the shape travels, not just the peak). Quiet echoes are marked q and excluded from the aggregates exactly as on screen; off-hours cells are marked off* (the legend spells the caveat out)."
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>

      {/* rhyme by class - the portfolio-level answer to "is today repeating
          yesterday's script" per asset class, not just per pair */}
      {data && data.rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-[#1c2739] px-2 py-1">
          <span
            className="mr-0.5 font-mono text-[8.5px] uppercase tracking-wider text-[#3d4d66]"
            title={`average echo rhyme per asset class, over the rows that carry a comparison (rows without an echo are excluded, not scored zero)${
              weekLive
                ? " - each chip's ⟳ number averages the same rhyme over every echoed day-observation of the week in class (yesterday's echo + each remembered prior day's)"
                : ' - pick a deeper day chip (beyond 1d) and each chip grows a ⟳ week rhyme over every echoed day-observation in class'
            } - click a class to filter the list to it`}
          >
            rhyme by class
          </span>
          {classRhyme.map(({ key, label, why, agg }) => {
            const color =
              agg.avg == null
                ? 'text-[#3d4d66]'
                : agg.avg >= RHYME_OK
                  ? 'text-emerald-300'
                  : agg.avg >= RHYME_BAD
                    ? 'text-amber-300'
                    : 'text-rose-300'
            const wkColor =
              agg.wkAvg == null
                ? 'text-[#3d4d66]'
                : agg.wkAvg >= RHYME_OK
                  ? 'text-emerald-300/80'
                  : agg.wkAvg >= RHYME_BAD
                    ? 'text-amber-300/80'
                    : 'text-rose-300/80'
            const click = () => {
              if (key === 'otc') {
                setMkt('otc')
                setCat('all')
              } else {
                setCat(key)
              }
            }
            return (
              <button
                key={key}
                type="button"
                onClick={click}
                className="shrink-0 rounded px-1 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors hover:bg-[#141d2e]"
                title={
                  agg.avg == null
                    ? `${why} - none of the ${agg.rows} row${agg.rows === 1 ? '' : 's'} in class carries a non-quiet echo${agg.mainQuiet > 0 ? ` (${agg.mainQuiet} quiet: both lead-ins flat, trivial agreement)` : ' (lead-ins under half covered)'}`
                    : `${why} - average echo rhyme ${agg.avg}/100 across ${agg.compared} of ${agg.rows} row${agg.rows === 1 ? '' : 's'} in class (${agg.ok} rhyming ${RHYME_OK}+, ${agg.bad} diverging under ${RHYME_BAD}; the rest have no comparison${agg.mainQuiet > 0 ? `; ${agg.mainQuiet} quiet rhym${agg.mainQuiet === 1 ? 'e' : 's'} excluded - both lead-ins flat` : ''}).${weekLive ? ' The ⟳ number is the week rhyme (hover it).' : ''} Click to filter.`
                }
              >
                <span className="text-[#4b5a72]">{label}</span>{' '}
                <span className={color}>{agg.avg == null ? '—' : agg.avg}</span>
                {agg.compared > 0 && (
                  <span className="ml-0.5 text-[8.5px] text-[#3d4d66]">
                    {agg.ok}/{agg.compared}
                  </span>
                )}
                {weekLive && agg.wkAvg != null && (
                  <span
                    className={`ml-1 ${wkColor}`}
                    title={`week rhyme: average ${agg.wkAvg}/100 across ${agg.wkObs} non-quiet echoed day-observation${agg.wkObs === 1 ? '' : 's'} in class - yesterday's echo + each remembered prior day's (${agg.wkRhymed} scored ${RHYME_OK}+). Same exclusion rule as the row aggregate: no-echo days are left out, not scored zero, and quiet rhymes (both lead-ins flat) are excluded too${agg.wkQuiet > 0 ? ` - ${agg.wkQuiet} quiet here` : ''}.${agg.wkObs === agg.compared ? ' No remembered prior days in this class yet - the week here is yesterday only.' : ''}`}
                  >
                    {'\u27f3'}
                    {agg.wkAvg}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* script by class - the session profile one level up: does the CLASS
          script differ by session, and does the OTC day-wide bucket look like
          a clock-bound class's? Same fold-the-wire arithmetic as the strip
          above, one more dimension. */}
      {profOn && scriptLive && data && data.rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-[#1c2739] px-2 py-1">
          <span
            className="mr-0.5 font-mono text-[8.5px] uppercase tracking-wider text-[#3d4d66]"
            title="the session profile one level up: each class's row profiles folded per session (obs summed across rows, quiet echoes excluded, the class average weighted by each row's observations). Clock sessions come only from the class's real rows; the OTC column only from its -OTC twins (one day-wide bucket). Click a class to filter the list to it."
          >
            script by class
          </span>
          {classScript.map(({ key, label, why, rows, cells }) => {
            if (!cells.some((c) => c.obs > 0)) return null
            const click = () => {
              if (key === 'otc') {
                setMkt('otc')
                setCat('all')
              } else {
                setCat(key)
              }
            }
            return (
              <button
                key={key}
                type="button"
                onClick={click}
                className="shrink-0 rounded px-1 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors hover:bg-[#141d2e]"
                title={`${why} - the session profile folded over all ${rows} row${rows === 1 ? '' : 's'} in class: does this class's script differ ASIA vs LONDON vs NY? Quiet echoes (both lead-ins flat) are excluded from the averages, which are weighted by each row's observations. Click to filter.`}
              >
                <span className="text-[#4b5a72]">{label}</span>
                {cells.map((c) => {
                  const offHours = c.session === 'OFF' && c.obs > 0
                  const color =
                    c.avg == null
                      ? 'text-[#2a3648]'
                      : c.avg >= RHYME_OK
                        ? 'text-emerald-300/80'
                        : c.avg >= RHYME_BAD
                          ? 'text-amber-300/80'
                          : 'text-rose-300/80'
                  return (
                    <span
                      key={c.session}
                      className={`ml-1.5 ${color}${offHours ? ' underline decoration-dotted decoration-[#4b5a72] underline-offset-2' : ''}`}
                      title={`${SESSION_LABEL[c.session]}${c.session === 'OTC' ? ' (day-wide bucket - -OTC pairs have no sessions, see analytics/session.ts)' : ''}: average rhyme ${c.avg ?? '—'}/100 across ${c.obs} adjacent-day lead-in echo${c.obs === 1 ? '' : 's'} in the class's rows at this session's hours (quiet excluded: ${c.quiet}; weighted by each row's observations). Same score as the echo chip: direction 50 + move-vs-travel 30 + travel ratio 20.${offHours ? ' OFF-HOURS CAVEAT: these hours sit outside the named sessions, where the books are thin - the rhyme is real but weight it accordingly.' : ''}`}
                    >
                      {SCRIPT_COLS.find((s) => s.session === c.session)?.short ?? c.session} {c.avg ?? '—'}
                    </span>
                  )
                })}
              </button>
            )
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {error && <div className="p-2 text-[10px] text-rose-400">{error}</div>}
        {!error && !tfSupported && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            The 24h lookback cannot fit the archive depth on {tf} candles (a day of {tf} bars is far beyond the 4000-bar history) - switch the chart to 30s or coarser and the panel follows.
          </div>
        )}
        {!error && tfSupported && rows.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {data ? (
              (data.rows ?? []).length > 0 ? (
                `No rows match the current filter - ${data.rows.length} row${data.rows.length === 1 ? '' : 's'} scanned${mkt !== 'all' ? ` · market ${mkt.toUpperCase()}` : ''}${cat !== 'all' ? ` · class ${cat}` : ''}${dirF !== 'all' ? ` · direction ${dirF}` : ''}${echoF !== 'all' ? ` · echo ${echoF}` : ''}${effDays > 1 ? ` · depth ${effDays}d` : ''}${needle ? ` · search "${query.trim()}"` : ''}. Clear the search or loosen the chips.`
              ) : (
                `${data.scanned} instruments scanned, none had enough window history - the T-24h story needs the series to reach back a full day (bars accumulate while the OS runs; the feed's deterministic prehistory fills the front once it does). Rows appear here automatically.`
              )
            ) : (
              'Replaying the window that started exactly 24h ago across the open universe...'
            )}
          </div>
        )}
        {rows.map((r) => (
          <RowCard key={r.asset} r={r} onSelectAsset={onSelectAsset} onFocusWindow={onFocusWindow} windowMin={data?.windowMin ?? windowMin} />
        ))}
        {data && data.rows.length > 0 && (
          <p className="px-1 pt-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
            Each row is the window that started at the bar forming exactly 24h ago, on the chart's timeframe. dir counts as up/down only when the net move exceeds 10% of the window's own travel. "arch" = bars from the kernel's accumulated store (broker bars in live mode), "seeded" = the feed's deterministic prehistory - never mistake a seeded yesterday for a remembered one. echo compares the lead-in windows ending at this same time of day (yesterday's ended at the anchor, today's within one bar of now): rhyme = direction 50 + move-vs-travel 30 + travel ratio 20, 70+ reads as "repeating the script", under 40 as "going its own way"; a rhyme between two FLAT lead-ins (net move under 10% of travel on both sides) is marked "quiet" - real but trivial, excluded from every aggregate. The rhyme-by-class strip averages each class's echo scores (compared rows only) - "are OTC pairs rhyming today?" is one glance away, and once the scan walks deeper than 1d each chip grows a ⟳ week number averaging every non-quiet echoed day-observation in class - "are they rhyming with the whole week, or only with yesterday?". Click a card to open that asset on the chart; click an echo chip to go further - the chart deep-loads the asset's full day of candles and scrolls onto yesterday's lead-in plus the forward replay window (edges the feed never remembered show as a gap, not filler). The day chips walk the same window further back - the "at this hour" strip shows each remembered day with its own coverage (days the series cannot cover are absent, not flat), each day's rhyme tag scores today's lead-in against THAT day's lead-in, and the "N/M rhyme" aggregate counts the days today actually rhymed with (70+, non-quiet comparisons) among the compared ones. The week sort orders the list by exactly that count - the strongest week rhymes float to the top (average rhyme breaking ties, biggest window move after that, quiet rhymes not counting), turning the panel into a best-echoes watchlist. The "by session" toggle goes one question deeper: the kernel re-scores the same adjacent-day lead-in echo at every hour of the day and averages it per trading session, so each row grows a "script" line - rhymes in London but not off-hours, or the reverse - with quiet echoes excluded from the averages and -OTC pairs collapsed into one day-wide bucket (they have no sessions). With the toggle on, the rhyme-by-class strip gains a sibling: script by class - each class's session averages folded across its rows (weighted by observations, quiet excluded), the OTC column separating the synthetic twins' day-wide script from the clock-bound classes'. The peak sort turns the script into a watchlist: the pair whose BEST session (2+ non-quiet observations) rhymes hardest floats to the top, the spread between best and worst qualified session breaking ties - and the script line marks the peak session bold beside a spread tag, so "trade it only where it rhymes" reads without the sort. Off-hours averages sit under a dotted underline (script line and class strip alike): those hours are outside the named sessions, where the books are thin - the rhyme is real, quiet pairs are already excluded, but weight it accordingly; the copy button marks such a peak off* in the snapshot and the legend spells it out. The copy button serializes exactly what you see - the same filters and sort, the top 10 rows as a text snapshot (echo rhyme, week aggregate, peak session, window move) headed by the scan time, the sort and the filters - and every row with a measured profile grows an indented script sub-line carrying its full session averages, so the shape of the script travels with the paste, not just the peak - ready to paste anywhere.
          </p>
        )}
      </div>
    </div>
  )
}
