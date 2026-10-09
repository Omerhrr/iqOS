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
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Timeframe, YesterdayRow } from '@/lib/os/client'
import { TIMEFRAME_SECONDS, fmtPrice, getYesterday } from '@/lib/os/client'

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
type Sort = 'move' | 'since' | 'range' | 'rhyme' | 'week'
type DirFilter = 'all' | 'up' | 'down' | 'none'
type EchoF = 'all' | 'rhymes' | 'diverges'

/** rhyme thresholds - a row scores 0..100; >=70 reads as "repeating the script",
 * <40 as "going its own way"; in between is partial rhyme. */
const RHYME_OK = 70
const RHYME_BAD = 40

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

/** Week-rhyme ranking for the "week" sort - the best-echoes watchlist order:
 * rows rhyming (70+) with the MOST remembered days at this hour first
 * (yesterday's echo included, no-echo days excluded - the same observations
 * the PriorStrip's "N/M rhyme" counts), the average rhyme across those
 * observations breaking ties, biggest yesterday-window move after that.
 * Rows without any comparison sink to the bottom (-1 average). */
function weekRhymeCmp(a: YesterdayRow, b: YesterdayRow): number {
  const obs = (r: YesterdayRow) =>
    [r.echo?.rhyme, ...(r.prior ?? []).map((p) => p.echo?.rhyme)].filter((x): x is number => x != null)
  const ea = obs(a)
  const eb = obs(b)
  const ra = ea.filter((x) => x >= RHYME_OK).length
  const rb = eb.filter((x) => x >= RHYME_OK).length
  if (ra !== rb) return rb - ra
  const aa = ea.length ? ea.reduce((s, x) => s + x, 0) / ea.length : -1
  const ab = eb.length ? eb.reduce((s, x) => s + x, 0) / eb.length : -1
  if (ab !== aa) return ab - aa
  return Math.abs(b.movePct) - Math.abs(a.movePct)
}

const SESSION_LABEL: Record<YesterdayRow['session'], string> = {
  ASIA: 'Asia',
  LONDON: 'London',
  OVERLAP: 'Lon/NY',
  NEWYORK: 'NY',
  OFF: 'off-hours',
  OTC: 'OTC',
}

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
 * quotes the score's three parts. Clicking jumps the chart onto the script:
 * yesterday's lead-in plus the forward replay window (the page deep-loads a
 * day of bars first, so the story actually has history behind it). */
function EchoChip({ e, onJump }: { e: NonNullable<YesterdayRow['echo']>; onJump?: () => void }) {
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
      className={`cursor-pointer rounded px-1.5 py-px font-mono text-[10px] font-bold transition hover:brightness-150 ${cls}`}
      title={`echo rhyme ${e.rhyme}/100 (${word}) - direction agreement 50 pts (yesterday ${e.dirAgree}), today's move vs yesterday's measured against yesterday's own travel 30 pts, travel ratio 20 pts. Lead-in windows end at the same wall-clock moment: yesterday's at the anchor, today's within one bar of now. Click: the chart loads this asset's full day of bars and scrolls onto yesterday's lead-in + the forward replay window.`}
    >
      {glyph} {e.rhyme}
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
 * zero-filled. */
function PriorStrip({ r }: { r: YesterdayRow }) {
  const prior = r.prior ?? []
  if (prior.length === 0) return null
  const days = prior.length + 1
  const ups = prior.filter((p) => p.dir === 'up').length + (r.dir === 'up' ? 1 : 0)
  const echoes = [r.echo?.rhyme, ...prior.map((p) => p.echo?.rhyme)].filter((x): x is number => x != null)
  const rhymed = echoes.filter((x) => x >= RHYME_OK).length
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[9px]">
      <span className="text-[#3d4d66]">at this hour</span>
      {prior.map((p) => (
        <span
          key={p.back}
          className={p.dir === 'up' ? 'text-emerald-300/80' : p.dir === 'down' ? 'text-rose-300/80' : 'text-[#7c8aa5]'}
          title={`${p.back}d ago, the ${p.barsFound}/${p.barsExpected}-bar window from ${new Date(p.thenTs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${p.movePct >= 0 ? '+' : ''}${p.movePct.toFixed(2)}% move, ${p.rangePct.toFixed(2)}% travel, session ${p.session}${p.echo ? ` - today's lead-in vs this day's: rhyme ${p.echo.rhyme}/100 (${p.echo.dirAgree})` : ' - no echo (a side under half covered)'}`}
        >
          {p.back}d {p.dir === 'up' ? '\u25b2' : p.dir === 'down' ? '\u25bc' : '\u2014'}{Math.abs(p.movePct).toFixed(2)}
          {p.echo && (
            <span className={`ml-1 ${p.echo.rhyme >= RHYME_OK ? 'text-emerald-300' : p.echo.rhyme >= RHYME_BAD ? 'text-amber-300' : 'text-rose-300'}`}>
              {p.echo.rhyme >= RHYME_OK ? '\u27f3' : p.echo.rhyme >= RHYME_BAD ? '\u2248' : '\u2717'}{p.echo.rhyme}
            </span>
          )}
        </span>
      ))}
      <span className="ml-auto text-[#4b5a72]" title={`of the last ${days} days at this hour (yesterday's replay included), ${ups} opened a window that closed up`}>
        {ups}/{days} up
      </span>
      {echoes.length > 0 && (
        <span
          className={rhymed > 0 ? 'text-emerald-300/80' : 'text-[#4b5a72]'}
          title={`today's lead-in rhymed (score ${RHYME_OK}+) with ${rhymed} of the ${echoes.length} remembered day${echoes.length === 1 ? '' : 's'} at this hour (yesterday included). Days without a comparison are excluded, not scored zero - so "0/3" can still mean every side was dark.`}
        >
          {'\u27f3'} {rhymed}/{echoes.length} rhyme
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
  const [query, setQuery] = useState('')
  const [data, setData] = useState<Awaited<ReturnType<typeof getYesterday>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

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
      getYesterday(tf, windowMin, effDays)
        .then((d) => {
          if (d?.ok) {
            setData(d)
            setError(null)
          }
        })
        .catch((e: Error) => setError(e.message.slice(0, 180)))
        .finally(() => setBusy(false))
    },
    [tf, windowMin, effDays, tfSupported],
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
    .sort((a, b) =>
      sort === 'move'
        ? Math.abs(b.movePct) - Math.abs(a.movePct)
        : sort === 'since'
          ? Math.abs(b.sincePct) - Math.abs(a.sincePct)
          : sort === 'rhyme'
            ? (b.echo?.rhyme ?? -1) - (a.echo?.rhyme ?? -1) || Math.abs(b.movePct) - Math.abs(a.movePct)
            : sort === 'week'
              ? weekRhymeCmp(a, b)
              : b.rangePct - a.rangePct,
    )
  // the week numbers only mean something once the scan actually carries prior
  // echoes (a day chip beyond 1d, on a kernel that computes them) - at 1d they
  // would be pure duplicates of the yesterday averages, so they stay hidden
  const weekLive = (data?.rows ?? []).some((r) => (r.prior ?? []).some((p) => p.echo != null))
  // the week sort needs prior echoes - if the depth drops back to 1d while it
  // is selected, fall back to the yesterday-rhyme order instead of leaving a
  // disabled chip selected
  useEffect(() => {
    if (!weekLive && sort === 'week') setSort('rhyme')
  }, [weekLive, sort])
  const otcLive = (data?.rows ?? []).filter((r) => r.otc).length
  const rhymeLive = (data?.rows ?? []).filter((r) => (r.echo?.rhyme ?? -1) >= RHYME_OK).length
  const catCount = (c: Cat) => (c === 'all' ? (data?.rows ?? []).length : (data?.rows ?? []).filter((r) => r.category === c).length)
  const ageSec = data ? Math.max(0, Math.round((now - data.ts) / 1000)) : 0

  // per-class rhyme averages - "are OTC pairs rhyming today?" at a glance.
  // Averages run ONLY over rows carrying an echo (the honest denominator);
  // the OTC entry answers over the otc flag (mostly the -OTC fx twins), the
  // others over r.category. The week average (wkAvg) runs the same arithmetic
  // over EVERY echoed day-observation in class - the row's own echo plus each
  // remembered prior day's, same inclusion rule as the row's "N/M rhyme"
  // (yesterday included, no-echo days excluded, never zeroed) - so "are OTC
  // pairs rhyming with the whole week?" is the glance next to it. The strip
  // always reads the FULL scan - it is a readout, and its click just sets the
  // filters above.
  const classRhyme = useMemo(() => {
    const rowsAll = data?.rows ?? []
    const build = (pick: (r: YesterdayRow) => boolean) => {
      const sub = rowsAll.filter(pick)
      const es = sub.flatMap((r) => (r.echo ? [r.echo.rhyme] : []))
      const avg = es.length ? Math.round(es.reduce((s, x) => s + x, 0) / es.length) : null
      const wk = sub.flatMap((r) => [
        ...(r.echo ? [r.echo.rhyme] : []),
        ...(r.prior ?? []).flatMap((p) => (p.echo ? [p.echo.rhyme] : [])),
      ])
      const wkAvg = wk.length ? Math.round(wk.reduce((s, x) => s + x, 0) / wk.length) : null
      return {
        rows: sub.length,
        compared: es.length,
        ok: es.filter((x) => x >= RHYME_OK).length,
        bad: es.filter((x) => x < RHYME_BAD).length,
        avg,
        wkObs: wk.length,
        wkRhymed: wk.filter((x) => x >= RHYME_OK).length,
        wkAvg,
      }
    }
    return [
      { key: 'otc' as const, label: 'OTC', why: 'over-the-counter pairs (the -OTC twins)', agg: build((r) => r.otc) },
      { key: 'forex' as const, label: 'FX', why: 'currency pairs (incl. their OTC twins)', agg: build((r) => r.category === 'forex') },
      { key: 'crypto' as const, label: 'Crypto', why: 'crypto pairs - 24/7 real markets', agg: build((r) => r.category === 'crypto') },
      { key: 'commodity' as const, label: 'Comm', why: 'metals, energy, agriculture', agg: build((r) => r.category === 'commodity') },
      { key: 'stock' as const, label: 'Stocks', why: 'single-name equities', agg: build((r) => r.category === 'stock') },
      { key: 'index' as const, label: 'Idx', why: 'index CFDs', agg: build((r) => r.category === 'index') },
    ]
  }, [data])

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
              ['rhymes', `rhymes${rhymeLive > 0 ? ` ${rhymeLive}` : ''}`, `only rows scoring ${RHYME_OK}+ - today is tracing yesterday's lead-in`],
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
              ['week', 'week', "best echoes of the week first - rows rhyming (70+) with the most remembered days at this hour, average rhyme breaking ties (rows without any comparison sink)"],
              ['range', 'range', 'widest high-low travel in the window first - the most restless hours'],
            ] as [Sort, string, string][]
          ).map(([v, label, why]) => {
            const dimmed = v === 'week' && !weekLive
            return (
              <button
                key={v}
                type="button"
                onClick={() => !dimmed && setSort(v)}
                disabled={dimmed}
                title={dimmed ? `${why} - pick a day chip beyond 1d first (the week order needs the prior-day echoes)` : why}
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
                    ? `${why} - none of the ${agg.rows} row${agg.rows === 1 ? '' : 's'} in class carries an echo (lead-ins under half covered)`
                    : `${why} - average echo rhyme ${agg.avg}/100 across ${agg.compared} of ${agg.rows} row${agg.rows === 1 ? '' : 's'} in class (${agg.ok} rhyming ${RHYME_OK}+, ${agg.bad} diverging under ${RHYME_BAD}); the rest have no comparison.${weekLive ? ' The ⟳ number is the week rhyme (hover it).' : ''} Click to filter.`
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
                    title={`week rhyme: average ${agg.wkAvg}/100 across ${agg.wkObs} echoed day-observation${agg.wkObs === 1 ? '' : 's'} in class - yesterday's echo + each remembered prior day's (${agg.wkRhymed} scored ${RHYME_OK}+). Same exclusion rule as the row aggregate: no-echo days are left out, not scored zero.${agg.wkObs === agg.compared ? ' No remembered prior days in this class yet - the week here is yesterday only.' : ''}`}
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
            Each row is the window that started at the bar forming exactly 24h ago, on the chart's timeframe. dir counts as up/down only when the net move exceeds 10% of the window's own travel. "arch" = bars from the kernel's accumulated store (broker bars in live mode), "seeded" = the feed's deterministic prehistory - never mistake a seeded yesterday for a remembered one. echo compares the lead-in windows ending at this same time of day (yesterday's ended at the anchor, today's within one bar of now): rhyme = direction 50 + move-vs-travel 30 + travel ratio 20, 70+ reads as "repeating the script", under 40 as "going its own way". The rhyme-by-class strip averages each class's echo scores (compared rows only) - "are OTC pairs rhyming today?" is one glance away, and once the scan walks deeper than 1d each chip grows a ⟳ week number averaging every echoed day-observation in class - "are they rhyming with the whole week, or only with yesterday?". Click a card to open that asset on the chart; click an echo chip to go further - the chart deep-loads the asset's full day of candles and scrolls onto yesterday's lead-in plus the forward replay window (edges the feed never remembered show as a gap, not filler). The day chips walk the same window further back - the "at this hour" strip shows each remembered day with its own coverage (days the series cannot cover are absent, not flat), each day's rhyme tag scores today's lead-in against THAT day's lead-in, and the "N/M rhyme" aggregate counts the days today actually rhymed with (70+), compared days only. The week sort orders the list by exactly that count - the strongest week rhymes float to the top (average rhyme breaking ties, biggest window move after that), turning the panel into a best-echoes watchlist.
          </p>
        )}
      </div>
    </div>
  )
}
