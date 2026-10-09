// IQAIR//OS - the yesterday watchlist: the ranking comparators behind the
// panel's week/peak sorts plus the serializer that turns the current view
// into a shareable text snapshot. ONE module on purpose: the panel sorts by
// the very comparators that order the exported text, so the snapshot can
// never disagree with the list on screen. Zero imports (structural row
// types - anything shaped like the wire rows works), which keeps it
// bundleable for the panel and directly testable under bun.

/** rhyme thresholds - a row scores 0..100; >=70 reads as "repeating the
 * script", <40 as "going its own way"; in between is partial rhyme. */
export const RHYME_OK = 70
export const RHYME_BAD = 40

export type WatchSession = 'ASIA' | 'LONDON' | 'OVERLAP' | 'NEWYORK' | 'OFF' | 'OTC'

/** structural subset of the wire echo the watchlist reads */
export interface WatchEcho {
  rhyme: number
  /** both lead-ins flat - real but trivial; excluded from every aggregate */
  quiet?: boolean
}

/** structural subset of a remembered prior day (only its echo matters here) */
export interface WatchPrior {
  echo?: WatchEcho | null
}

/** structural subset of a per-session profile bucket */
export interface WatchBucket {
  session: WatchSession
  obs: number
  quiet: number
  avg: number | null
}

/** structural subset of the yesterday wire row the watchlist reads */
export interface WatchRow {
  asset: string
  movePct: number
  sincePct: number
  rangePct: number
  otc?: boolean
  echo?: WatchEcho | null
  prior?: WatchPrior[] | null
  profile?: WatchBucket[] | null
}

export type WatchSort = 'move' | 'since' | 'range' | 'rhyme' | 'week' | 'peak'

/** every non-quiet echo observation of the row: yesterday's own echo plus
 * each remembered prior day's. The week aggregate ranks only these - a
 * rhyme between two flat lead-ins is real but trivial, so quiet echoes are
 * excluded, never scored zero. */
export function weekObs(r: WatchRow): number[] {
  return [
    ...(r.echo && r.echo.quiet !== true ? [r.echo.rhyme] : []),
    ...(r.prior ?? []).flatMap((p) => (p.echo && p.echo.quiet !== true ? [p.echo.rhyme] : [])),
  ]
}

/** Week-rhyme ranking for the "week" sort - the best-echoes watchlist order:
 * rows rhyming (70+) with the MOST remembered days at this hour first
 * (yesterday's echo included, no-echo days excluded - the same observations
 * the PriorStrip's "N/M rhyme" counts, QUIET rhymes excluded too), the
 * average rhyme across those observations breaking ties, biggest
 * yesterday-window move after that. Rows without any non-quiet comparison
 * sink to the bottom (-1 average). */
export function weekRhymeCmp(a: WatchRow, b: WatchRow): number {
  const ea = weekObs(a)
  const eb = weekObs(b)
  const ra = ea.filter((x) => x >= RHYME_OK).length
  const rb = eb.filter((x) => x >= RHYME_OK).length
  if (ra !== rb) return rb - ra
  const aa = ea.length ? ea.reduce((s, x) => s + x, 0) / ea.length : -1
  const ab = eb.length ? eb.reduce((s, x) => s + x, 0) / eb.length : -1
  if (ab !== aa) return ab - aa
  return Math.abs(b.movePct) - Math.abs(a.movePct)
}

/** The session-peak key for the "peak" sort - trade the pair where its
 * script rhymes: the BEST session average among sessions with at least TWO
 * non-quiet observations (a single lucky hour is not a script; quiet echoes
 * are already excluded from the kernel's averages), the spread between best
 * and worst QUALIFIED session breaking ties (a wide spread means the script
 * really differs by time of day, so the peak is worth trading), biggest
 * window move after that. Rows without a qualified session key to -1 and
 * sink; an -OTC row's single day-wide bucket is its own best session with a
 * spread of 0. */
export function peakKey(r: WatchRow): { best: number; spread: number } {
  const quals = (r.profile ?? []).filter((s) => s.obs - s.quiet >= 2 && s.avg != null).map((s) => s.avg!)
  const best = quals.length ? Math.max(...quals) : -1
  const spread = quals.length > 1 ? Math.max(...quals) - Math.min(...quals) : 0
  return { best, spread }
}

export function peakRhymeCmp(a: WatchRow, b: WatchRow): number {
  const ka = peakKey(a)
  const kb = peakKey(b)
  if (kb.best !== ka.best) return kb.best - ka.best
  if (kb.spread !== ka.spread) return kb.spread - ka.spread
  return Math.abs(b.movePct) - Math.abs(a.movePct)
}

/** the comparator behind every sort chip - the single ordering the list on
 * screen and the exported snapshot both follow. */
export function cmpBySort(mode: WatchSort): (a: WatchRow, b: WatchRow) => number {
  switch (mode) {
    case 'move':
      return (a, b) => Math.abs(b.movePct) - Math.abs(a.movePct)
    case 'since':
      return (a, b) => Math.abs(b.sincePct) - Math.abs(a.sincePct)
    case 'range':
      return (a, b) => b.rangePct - a.rangePct
    case 'rhyme':
      return (a, b) => (b.echo?.rhyme ?? -1) - (a.echo?.rhyme ?? -1) || Math.abs(b.movePct) - Math.abs(a.movePct)
    case 'week':
      return weekRhymeCmp
    case 'peak':
      return peakRhymeCmp
  }
}

const SESSION_SHORT: Record<WatchSession, string> = {
  ASIA: 'Asia',
  LONDON: 'Lon',
  OVERLAP: 'L/N',
  NEWYORK: 'NY',
  OFF: 'off',
  OTC: 'OTC',
}

/** scan time as a UTC label for the snapshot header - the scan rides a
 * moving T-24h anchor, so the timestamp is part of the snapshot's meaning */
export function fmtWatchlistTs(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

const LEGEND = `legend: rhyme = dir 50 + move-vs-travel 30 + travel ratio 20 · ${RHYME_OK}+ rhymes, <${RHYME_BAD} diverges · q quiet (both lead-ins flat, out of aggregates) · week rhymed/kept + avg over non-quiet days · peak best session (2+ non-quiet obs) · Δ best-worst spread · move = yesterday's replay window`

/** Serialize the current view into a shareable text snapshot. The rows come
 * in ALREADY filtered (market/class/direction/echo/search - the operator
 * shares what they see); the ordering is applied here from the same
 * comparators the panel sorts by, then capped at topN. Conditional columns
 * mirror the panel's live rules: the week aggregate appears only when a
 * remembered prior echo exists on some exported row (at 1d it would restate
 * the echo column), the peak column only when a profile is on the wire. */
export function buildWatchlist(opts: {
  rows: WatchRow[]
  sort: WatchSort
  /** scan time (ms epoch) - printed as a UTC label in the header */
  tsMs: number
  topN?: number
  mktLabel?: string
  catLabel?: string
}): string {
  const topN = opts.topN ?? 10
  const sorted = [...opts.rows].sort(cmpBySort(opts.sort)).slice(0, topN)
  const scope = `sort ${opts.sort} · ${opts.mktLabel ?? 'all markets'} · ${opts.catLabel ?? 'all classes'}`
  const count = sorted.length < opts.rows.length ? `top ${sorted.length} of ${opts.rows.length}` : `${sorted.length} row${sorted.length === 1 ? '' : 's'}`
  const title = `iqOS yesterday watchlist · ${fmtWatchlistTs(opts.tsMs)} · ${scope} · ${count}`
  if (sorted.length === 0) return `${title}\nno rows - loosen the filters or widen the scan\n${LEGEND}`

  const weekCol = sorted.some((r) => (r.prior ?? []).some((p) => p.echo != null))
  const peakCol = sorted.some((r) => (r.profile ?? []).length > 0)

  // per-column cells first, then pad - widths must survive the widest value
  const echoCell = (r: WatchRow): string => (r.echo != null ? `${r.echo.rhyme}${r.echo.quiet ? 'q' : ''}` : '—')
  const weekCell = (r: WatchRow): string => {
    const kept = weekObs(r)
    if (kept.length === 0) return '—'
    const rhymed = kept.filter((x) => x >= RHYME_OK).length
    return `${rhymed}/${kept.length} ${Math.round(kept.reduce((s, x) => s + x, 0) / kept.length)}`
  }
  const peakCell = (r: WatchRow): string => {
    const prof = r.profile ?? []
    if (prof.length === 0) return '—'
    const quals = prof.filter((s) => s.obs - s.quiet >= 2 && s.avg != null)
    if (quals.length === 0) return '—'
    const best = quals.reduce((a, b) => (b.avg! > a.avg! ? b : a))
    const spread = quals.length > 1 ? Math.max(...quals.map((s) => s.avg!)) - Math.min(...quals.map((s) => s.avg!)) : 0
    return `${SESSION_SHORT[best.session]} ${best.avg}${quals.length > 1 ? ` Δ${spread}` : ''}`
  }
  const moveCell = (r: WatchRow): string => `${r.movePct >= 0 ? '+' : ''}${r.movePct.toFixed(2)}%`

  const body = sorted.map((r) => ({
    asset: r.asset,
    echo: echoCell(r),
    week: weekCol ? weekCell(r) : null,
    peak: peakCol ? peakCell(r) : null,
    move: moveCell(r),
  }))
  const assetW = Math.max('asset'.length, ...body.map((c) => c.asset.length))
  // column spec drives the key row and the data rows from the same widths -
  // order: echo (the headline verdict), week, peak, move
  const cols: { head: string; cell: (c: (typeof body)[number]) => string }[] = [
    { head: 'echo', cell: (c) => c.echo },
    ...(weekCol ? [{ head: 'week', cell: (c) => c.week ?? '—' }] : []),
    ...(peakCol ? [{ head: 'peak', cell: (c) => c.peak ?? '—' }] : []),
    { head: 'move', cell: (c) => c.move },
  ]
  const widths = cols.map((col) => Math.max(col.head.length, ...body.map((c) => col.cell(c).length)))
  const keyRow = `  #  ${'asset'.padEnd(assetW)}  ${cols.map((col, i) => col.head.padStart(widths[i])).join('  ')}`
  const dataRows = body.map(
    (c, i) =>
      `${String(i + 1).padStart(2)}  ${c.asset.padEnd(assetW)}  ${cols.map((col, j) => col.cell(c).padStart(widths[j])).join('  ')}`,
  )
  return [title, keyRow, ...dataRows, LEGEND].join('\n')
}
