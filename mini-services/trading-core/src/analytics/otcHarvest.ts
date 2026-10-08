// Passive OTC harvest archive reader.
//
// live/otc_harvester.py records the broker's own 1m OTC feed to
// data/otc/candles_1m/candles_1m__<ASSET>.jsonl (lines: {t,o,h,l,c,v}, t in
// epoch SECONDS, candle open time). The backfill is resumable and overlaps
// between passes, so timestamps can repeat and arrive out of order - dedupe
// by open time (keep the last write, which is the live thread's freshest
// copy), sort, and hand back the most recent `limit` candles.
//
// Why this exists: the defense trial and forensics probe must read the
// BROKER's feed, but kernel memory holds SIM-seeded history for assets the
// UI never watched after a fresh boot, and the sidecar has nothing when no
// IQ session is logged in. The archive is a passive RECORD of real live
// feed - the honest middle source: sidecar (live) > harvest (recorded live)
// > kernel memory (possibly sim).
//
// Task 58 (P2): reads are now INCREMENTAL - the file is append-only, so a
// change re-reads only the appended bytes instead of re-parsing the whole
// file on the kernel event loop (the archive grows unboundedly while the
// harvester runs). A shrunken file (rotation/truncate) falls back to a full
// re-read. The asset name is sanitized into the path (it used to be
// interpolated raw).
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Candle } from '../types'

interface HarvestCache {
  mtimeMs: number
  size: number
  offset: number // bytes already ingested
  seen: Map<number, Candle>
  candles: Candle[] // sorted view of seen
}

const cache = new Map<string, HarvestCache>()

const parseLine = (line: string, seen: Map<number, Candle>): void => {
  if (!line) return
  try {
    const r = JSON.parse(line) as { t: number; o: number; h: number; l: number; c: number; v?: number }
    const t = Number(r.t)
    const c = Number(r.c)
    if (!Number.isFinite(t) || !Number.isFinite(c)) return
    seen.set(t, { time: t, open: Number(r.o), high: Number(r.h), low: Number(r.l), close: c, volume: Number(r.v) || 0 })
  } catch {
    // torn trailing line from a concurrent append - skip
  }
}

const ingestBytes = (buf: Buffer, seen: Map<number, Candle>): number => {
  // split on \n, tolerate \r\n; a torn trailing line is NOT ingested - the
  // returned count only advances past complete lines, so the next call
  // re-reads the completed tail from the same offset
  const text = buf.toString('utf8')
  let start = 0
  for (;;) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) break
    parseLine(text.slice(start, nl), seen)
    start = nl + 1
  }
  return start
}

export function loadOtcHarvest(asset: string, limit: number): Candle[] {
  // path safety: only [A-Z0-9_-] may reach the filesystem (Task 58)
  const safe = asset.toUpperCase().replace(/[^A-Z0-9_-]/g, '')
  if (!safe) return []
  const file = join(process.cwd(), 'data', 'otc', 'candles_1m', `candles_1m__${safe}.jsonl`)
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(file)
  } catch {
    return []
  }
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.candles.slice(-Math.max(1, limit))

  // changed: incremental when the file GREW from a known offset, full re-read
  // otherwise (first read, rotation, truncation)
  let entry: HarvestCache
  if (hit && st.size > hit.offset) {
    entry = hit
    let fh = -1
    try {
      fh = openSync(file, 'r')
      const buf = Buffer.alloc(st.size - hit.offset)
      readSync(fh, buf, 0, buf.length, hit.offset)
      const consumed = ingestBytes(buf, entry.seen)
      entry.offset = hit.offset + consumed
    } catch {
      // read race with the appending harvester - keep what we got
    } finally {
      if (fh >= 0) closeSync(fh)
    }
  } else {
    entry = { mtimeMs: st.mtimeMs, size: st.size, offset: 0, seen: new Map(), candles: [] }
    let fh = -1
    try {
      fh = openSync(file, 'r')
      const buf = Buffer.alloc(st.size)
      readSync(fh, buf, 0, buf.length, 0)
      const consumed = ingestBytes(buf, entry.seen)
      entry.offset = consumed
    } catch {
      // unreadable - empty archive
    } finally {
      if (fh >= 0) closeSync(fh)
    }
  }
  entry.mtimeMs = st.mtimeMs
  entry.size = st.size
  entry.candles = [...entry.seen.values()].sort((a, b) => a.time - b.time)
  cache.set(file, entry)
  return entry.candles.slice(-Math.max(1, limit))
}
