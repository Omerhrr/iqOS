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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Candle } from '../types'

const cache = new Map<string, { mtimeMs: number; size: number; candles: Candle[] }>()

export function loadOtcHarvest(asset: string, limit: number): Candle[] {
  const file = join(process.cwd(), 'data', 'otc', 'candles_1m', `candles_1m__${asset.toUpperCase()}.jsonl`)
  if (!existsSync(file)) return []
  const st = statSync(file)
  const hit = cache.get(file)
  // the harvester appends continuously - reparse only when the file changed
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.candles.slice(-Math.max(1, limit))
  const seen = new Map<number, Candle>()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const r = JSON.parse(line) as { t: number; o: number; h: number; l: number; c: number; v?: number }
      const t = Number(r.t)
      const c = Number(r.c)
      if (!Number.isFinite(t) || !Number.isFinite(c)) continue
      seen.set(t, { time: t, open: Number(r.o), high: Number(r.h), low: Number(r.l), close: c, volume: Number(r.v) || 0 })
    } catch {
      // torn trailing line from a concurrent append - skip
    }
  }
  const candles = [...seen.values()].sort((a, b) => a.time - b.time)
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, candles })
  return candles.slice(-Math.max(1, limit))
}
