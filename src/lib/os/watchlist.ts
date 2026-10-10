// IQAIR//OS - the yesterday watchlist: the ranking comparators behind the
// panel's week/peak sorts, the serializer that turns the current view into
// a shareable text snapshot, and the parser that reads a pasted snapshot
// back into its view-shape. ONE module on purpose: the panel sorts by
// the very comparators that order the exported text, and the parser reads
// only what the serializer writes - so the snapshot can never disagree
// with the list on screen and the roundtrip can never drift on one side
// alone. Zero imports (structural row
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
  /** the FORWARD window's direction (yesterday's replay) - the second input
   * of the verdict: a rhyme is only worth something when the script it
   * repeats actually went somewhere. Optional so hand-built rows stay legal;
   * a row without dir reads hollow, never trade (missing evidence is never
   * mistaken for a repeatable move). */
  dir?: 'up' | 'down' | 'none'
  otc?: boolean
  echo?: WatchEcho | null
  prior?: WatchPrior[] | null
  profile?: WatchBucket[] | null
}

export type WatchSort = 'move' | 'since' | 'range' | 'rhyme' | 'week' | 'peak' | 'verdict'

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

/** The VERDICT: the echo (is today repeating yesterday's script?) joined
 * with the forward replay (what did that script do NEXT?). Both numbers
 * already ride every row; neither alone is the trade:
 * - `trade`   - today TRACES yesterday's lead-in (rhyme 70+, non-quiet) and
 *               yesterday's window after that moment was DIRECTIONAL: if the
 *               script keeps holding, the next window repeats it. The
 *               panel's actionable read.
 * - `hollow`  - a confirmed rhyme with nothing to repeat: yesterday's
 *               forward window was flat, or the echo itself is quiet (both
 *               lead-ins flat - the agreement is real but trivial, same
 *               exclusion every aggregate applies). The rhyme is the
 *               headline; the script under it went nowhere.
 * - `partial` - rhyme 40..69: today half-traces the script. Unconfirmed -
 *               the forward window is context, not a repeat (yet).
 * - `diverge` - rhyme under 40: today goes its own way; yesterday's
 *               forward window is not this story.
 * null = no echo (no comparison instead of a fake one). All four labels
 * mirror the echo chip's own colors: emerald / amber / amber / rose. */
export type VerdictKind = 'trade' | 'hollow' | 'partial' | 'diverge'

export function verdictOf(r: WatchRow): VerdictKind | null {
  const e = r.echo
  if (!e) return null
  if (e.quiet === true) return 'hollow'
  if (e.rhyme >= RHYME_OK) return r.dir === 'up' || r.dir === 'down' ? 'trade' : 'hollow'
  if (e.rhyme < RHYME_BAD) return 'diverge'
  return 'partial'
}

/** Ranking for the "verdict" sort - trade the pair whose repeating script
 * actually went somewhere. Six levels, quiet sank deliberately:
 * 0 tradeable (rhyme 70+ non-quiet + directional script), 1 hollow-real (a
 * confirmed rhyme over a flat script), 2 partial (unconfirmed trace),
 * 3 QUIET (the trivial-agreement class - both lead-ins flat, two dead hours
 * trace nothing, so it ranks BELOW partial no matter the score: the same
 * "never let 90-from-flat masquerade as a strong echo" rule every other
 * aggregate here applies), 4 diverging, 5 no comparison (sinks last).
 * Within every level: rhyme desc, the size of the move to repeat breaking
 * ties - the same headline order the plain rhyme sort uses. */
export function verdictRank(r: WatchRow): number {
  const v = verdictOf(r)
  if (v == null) return 5
  if (v === 'hollow') return r.echo?.quiet === true ? 3 : 1
  return v === 'trade' ? 0 : v === 'partial' ? 2 : 4
}

export function verdictRhymeCmp(a: WatchRow, b: WatchRow): number {
  const ra = verdictRank(a)
  const rb = verdictRank(b)
  if (ra !== rb) return ra - rb
  const ea = a.echo?.rhyme ?? -1
  const eb = b.echo?.rhyme ?? -1
  if (eb !== ea) return eb - ea
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
    case 'verdict':
      return verdictRhymeCmp
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

/** marker after a peak session whose best bucket is OFF - the rhyme was
 * scored at hours OUTSIDE the named sessions, where the books are thin and
 * the travel small. Real (quiet pairs are already excluded from the
 * averages) but not the same kind of evidence as a London peak, so the
 * snapshot says so inline and the legend spells it out. The script sub-line
 * marks every MEASURED off-hours cell the same way, mirroring the panel's
 * dotted underline. */
const OFF_MARK = '*'

/** Compact run-length form of a bucket's contributing hours, for the
 * panel's session tooltips: consecutive hours collapse into ranges, the
 * rest stay comma-separated, everything zero-padded, sorted defensively
 * (dedup included). `[9,10,11,12]` -> "09-12", `[13,15]` -> "13, 15",
 * `[7]` -> "07", the full day -> "00-23", nothing -> "none". The kernel
 * ships the hours behind each session average (SessionRhyme.hours); the
 * tooltip's sentence is "the average is fed by echoes at 09-12 UTC" - which
 * is exactly the question a peak cell asks: WHICH hours is this peak made
 * of. Lives here so the bun unit can lock the exact strings beside the
 * serializer it shares the module with. */
export function fmtHours(hours: number[]): string {
  const hs = [...new Set(hours)].sort((a, b) => a - b)
  if (hs.length === 0) return 'none'
  const p = (h: number) => String(h).padStart(2, '0')
  const parts: string[] = []
  let start = hs[0]
  let prev = hs[0]
  for (let i = 1; i <= hs.length; i++) {
    const cur = hs[i]
    if (cur === prev + 1) {
      prev = cur
      continue
    }
    parts.push(start === prev ? p(start) : `${p(start)}-${p(prev)}`)
    start = cur
    prev = cur
  }
  return parts.join(', ')
}

/** the canonical session order of a script line - the wire already ships
 * buckets in this order, but the serializer orders them itself so the text
 * is deterministic even against a hand-built profile */
const SESSION_ORDER: WatchSession[] = ['ASIA', 'LONDON', 'OVERLAP', 'NEWYORK', 'OFF', 'OTC']

/** scan time as a UTC label for the snapshot header - the scan rides a
 * moving T-24h anchor, so the timestamp is part of the snapshot's meaning */
export function fmtWatchlistTs(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

const LEGEND = `legend: rhyme = dir 50 + move-vs-travel 30 + travel ratio 20 · ${RHYME_OK}+ rhymes, <${RHYME_BAD} diverges · q quiet (both lead-ins flat, out of aggregates) · week rhymed/kept + avg over non-quiet days · peak best session (2+ non-quiet obs) · Δ best-worst spread · * off-hours (thin books, weight it) · move = yesterday's replay window · verdict sort = rhyme joined with the forward window (traced + somewhere to go first, hollow / partial / quiet / diverge after, no echo sinks)`

/** Serialize the current view into a shareable text snapshot. The rows come
 * in ALREADY filtered (market/class/direction/echo/search - the operator
 * shares what they see); the ordering is applied here from the same
 * comparators the panel sorts by, then capped at topN. Conditional columns
 * mirror the panel's live rules: the week aggregate appears only when a
 * remembered prior echo exists on some exported row (at 1d it would restate
 * the echo column), the peak column only when a profile is on the wire. A
 * peak whose best session is OFF carries the off* marker - same caveat the
 * panel draws as a dotted underline under its off-hours averages. Every row
 * with a measured profile also grows an indented "script" sub-line - its
 * full session averages in canonical order, measured sessions only (obs 0
 * skipped, all-quiet reads —), off-hours cells marked off* - so the SHAPE
 * of the script travels with the watchlist, not just the peak cell. */
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
    return `${SESSION_SHORT[best.session]}${best.session === 'OFF' ? OFF_MARK : ''} ${best.avg}${quals.length > 1 ? ` Δ${spread}` : ''}`
  }
  const moveCell = (r: WatchRow): string => `${r.movePct >= 0 ? '+' : ''}${r.movePct.toFixed(2)}%`
  // the script sub-line: the row's full session profile, one indented line
  // under the data row - the peak cell names the best session, this carries
  // the whole shape (flat vs spiky, where else it rhymes). Measured sessions
  // only, canonical order, off-hours cells marked off* like the panel's
  // dotted underline; a row without a measured profile adds no line.
  const scriptLine = (r: WatchRow): string | null => {
    const measured = (r.profile ?? []).filter((s) => s.obs > 0)
    if (measured.length === 0) return null
    measured.sort((a, b) => SESSION_ORDER.indexOf(a.session) - SESSION_ORDER.indexOf(b.session))
    return `      script  ${measured.map((s) => `${SESSION_SHORT[s.session]}${s.session === 'OFF' ? OFF_MARK : ''} ${s.avg ?? '—'}`).join('  ')}`
  }

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
  const dataRows = body.flatMap(
    (c, i) => {
      const line = `${String(i + 1).padStart(2)}  ${c.asset.padEnd(assetW)}  ${cols.map((col, j) => col.cell(c).padStart(widths[j])).join('  ')}`
      const sub = scriptLine(sorted[i])
      return sub ? [line, sub] : [line]
    },
  )
  return [title, keyRow, ...dataRows, LEGEND].join('\n')
}

const TITLE_TAG = 'iqOS yesterday watchlist'
const SORT_KINDS: readonly string[] = ['move', 'since', 'range', 'rhyme', 'week', 'peak', 'verdict']
const COUNT_SEG = /^(top \d+ of \d+|\d+ rows?)$/

/** What a pasted snapshot parses into - the view's SHAPE, never the
 * numbers: the selection (ranked assets), the sort and the scope labels,
 * plus the header's scan-time label and top-of counts for honest display.
 * The receiver's panel re-reads every number from its own scan. */
export interface WatchlistParse {
  /** the snapshot's ranked assets, deduped (best rank kept), in rank order */
  assets: string[]
  /** the header's sort - null when absent or not one of the seven kinds */
  sort: WatchSort | null
  /** the scan-time label exactly as the header carried it (display-only) */
  tsLabel: string | null
  /** market / class labels from the header - display-only: the selection IS
   * the shared filter, the receiver's own chips stay untouched */
  mktLabel: string | null
  catLabel: string | null
  /** the scan denominator of a "top N of M" header (null on a full view) */
  total: number | null
  /** unique ranked pairs the snapshot carries */
  ranked: number
}

export type WatchlistParseResult =
  | { ok: true; wl: WatchlistParse }
  | { ok: false; why: string }

/** Read a pasted watchlist back into its view-shape - the other half of
 * buildWatchlist, living in the SAME module on purpose: the parser reads
 * only what the serializer writes, so the format can never drift on one
 * side alone. From the title it takes the scan-time label, the sort (only
 * the seven real kinds pass) and the scope segments between the sort and the
 * count; from the body, lines shaped `NN  ASSET  ...` - the key row (#)
 * and the indented script sub-lines carry no leading rank digits and the
 * legend doesn't start with one, so nothing else can leak in as a row.
 * Duplicates keep their best (lowest) rank; ranks reorder the assets, so
 * even a hand-reordered paste ranks by what the text says. A trimmed or
 * hand-edited header degrades honestly (nulls, not guesses); a text with
 * no title or no ranked rows is refused with a reason. */
export function parseWatchlist(text: string): WatchlistParseResult {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''))
  const title = lines.find((l) => l.includes(TITLE_TAG))
  if (!title) return { ok: false, why: 'not an iqOS yesterday watchlist snapshot' }
  const segs = title.split('·').map((s) => s.trim())
  const iSort = segs.findIndex((s) => /^sort \S+$/.test(s))
  const iCount = segs.findIndex((s) => COUNT_SEG.test(s))
  const sortSeg = iSort >= 0 ? segs[iSort].slice(5) : null
  const sort = sortSeg != null && SORT_KINDS.includes(sortSeg) ? (sortSeg as WatchSort) : null
  const topM = iCount >= 0 ? segs[iCount].match(/^top (\d+) of (\d+)$/) : null
  const rowsM = iCount >= 0 ? segs[iCount].match(/^(\d+) rows?$/) : null
  const total = topM ? Number(topM[2]) : rowsM ? Number(rowsM[1]) : null
  // the scope labels sit between the sort and the count segments - the
  // serializer always writes both (defaulting to all markets / all classes)
  const mktLabel = iSort >= 0 && iCount > iSort + 1 && segs[iSort + 1] ? segs[iSort + 1] : null
  const catLabel = iSort >= 0 && iCount > iSort + 2 && segs[iSort + 2] ? segs[iSort + 2] : null
  const tsM = title.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)
  const best = new Map<string, number>()
  for (const l of lines) {
    const m = l.match(/^\s{0,3}(\d{1,3})\s{2}(\S+)(?:\s{2}|\s*$)/)
    if (!m) continue
    const idx = Number(m[1])
    const prev = best.get(m[2])
    if (prev === undefined || idx < prev) best.set(m[2], idx)
  }
  const assets = [...best.entries()].sort((a, b) => a[1] - b[1]).map(([a]) => a)
  if (assets.length === 0) return { ok: false, why: 'the snapshot carries no ranked rows' }
  return {
    ok: true,
    wl: {
      assets,
      sort,
      tsLabel: tsM ? tsM[0] : null,
      mktLabel,
      catLabel,
      total,
      ranked: assets.length,
    },
  }
}
