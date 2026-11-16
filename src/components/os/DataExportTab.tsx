'use client'

// IQAIR//OS - Data tab: look at what history the kernel has for a pair and
// download it as CSV (one file per timeframe, or every timeframe in one file
// with a tf column). Reads the kernel's own archive through /archive (counts per
// timeframe) and /archive_candles (the stored bars ONLY - the normal chart read pads
// gaps and missing history with synthetic bars, which must never reach research data). Bars the feed
// never recorded are simply absent - the gap count shows how patchy a window is,
// and nothing is ever filled in. Nothing is placed or changed by this tab.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AssetRow, Candle, Timeframe } from '@/lib/os/client'
import { TIMEFRAMES, TIMEFRAME_SECONDS, osGet } from '@/lib/os/client'
import AssetPicker from './AssetPicker'

interface DataExportTabProps {
  initialAsset: string
  assets: AssetRow[]
  onError: (m: string) => void
}

interface ArchiveRow {
  tf: string
  n: number
  oldest: number
  newest: number
}

interface Fetched {
  candles: Candle[]
  gaps: number
  longestRun: number
}

const FETCH_TIMEOUT_MS = 45_000
const EXPORT_TFS: Timeframe[] = TIMEFRAMES

/** one deep read with a hard timeout and a single retry, so a stalled or dropped request ends in a clear message instead of hanging */
async function readDeep(asset: string, tf: Timeframe): Promise<Candle[]> {
  let lastErr = 'unknown error'
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
    try {
      const qsStr = new URLSearchParams({ XTransformPort: '3030', asset, tf, limit: '5000' }).toString()
      const res = await fetch(`/archive_candles?${qsStr}`, { cache: 'no-store', signal: ctl.signal })
      if (!res.ok) throw new Error(`the server answered ${res.status}`)
      const d = (await res.json()) as { ok: boolean; candles?: Candle[] }
      if (!d.ok) throw new Error('the kernel refused the read')
      return d.candles ?? []
    } catch (e) {
      lastErr = (e as Error).name === 'AbortError' ? `no answer after ${FETCH_TIMEOUT_MS / 1000}s` : (e as Error).message
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(lastErr)
}

const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z')

function analyse(candles: Candle[], tf: Timeframe): Fetched {
  const step = TIMEFRAME_SECONDS[tf]
  let gaps = 0
  let run = candles.length ? 1 : 0
  let longest = run
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].time - candles[i - 1].time > step * 1.5) {
      gaps++
      run = 1
    } else {
      run++
      if (run > longest) longest = run
    }
  }
  return { candles, gaps, longestRun: longest }
}

const csvOf = (asset: string, tf: Timeframe, candles: Candle[], withTf: boolean) => {
  const head = withTf ? 'asset,tf,time,iso,open,high,low,close,volume' : 'time,iso,open,high,low,close,volume'
  const rows = candles.map((c) => {
    const core = [c.time, iso(c.time), c.open, c.high, c.low, c.close, c.volume ?? 0].join(',')
    return withTf ? `${asset},${tf},${core}` : core
  })
  return [head, ...rows].join('\n')
}

function saveText(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export default function DataExportTab({ initialAsset, assets, onError }: DataExportTabProps) {
  const tickers = useMemo(() => assets.map((a) => a.ticker), [assets])
  const [asset, setAsset] = useState(initialAsset)
  const [archive, setArchive] = useState<Record<string, ArchiveRow>>({})
  const [loadingArchive, setLoadingArchive] = useState(false)
  const [fetched, setFetched] = useState<Partial<Record<Timeframe, Fetched>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const loadArchive = useCallback(async () => {
    setLoadingArchive(true)
    try {
      const d = await osGet<{ ok: boolean; assetStats?: { perTf: ArchiveRow[] } }>('/archive', { asset: asset.toUpperCase() })
      const map: Record<string, ArchiveRow> = {}
      for (const r of d.assetStats?.perTf ?? []) map[r.tf] = r
      setArchive(map)
    } catch (e) {
      onError((e as Error).message.slice(0, 160))
    } finally {
      setLoadingArchive(false)
    }
  }, [asset, onError])

  useEffect(() => {
    setFetched({})
    setNote(null)
    void loadArchive()
  }, [asset, loadArchive])

  const fetchTf = useCallback(
    async (tf: Timeframe): Promise<Fetched | null> => {
      try {
        const f = analyse(await readDeep(asset, tf), tf)
        setFetched((p) => ({ ...p, [tf]: f }))
        return f
      } catch (e) {
        onError(`${asset} ${tf}: ${(e as Error).message.slice(0, 140)}`)
        return null
      }
    },
    [asset, onError],
  )

  const downloadOne = async (tf: Timeframe) => {
    setBusy(tf)
    const f = fetched[tf] ?? (await fetchTf(tf))
    setBusy(null)
    if (!f) return
    if (!f.candles.length) {
      setNote(`${asset} has no ${tf} bars to download`)
      return
    }
    saveText(`${asset}_${tf}.csv`, csvOf(asset, tf, f.candles, false))
    setNote(`downloaded ${asset}_${tf}.csv (${f.candles.length} bars)`)
  }

  const downloadAll = async () => {
    setBusy('all')
    const parts: string[] = []
    let total = 0
    let first = true
    const failed: string[] = []
    const wanted = EXPORT_TFS.filter((t) => archive[t]?.n)
    for (let i = 0; i < wanted.length; i++) {
      const tf = wanted[i]
      setNote(`reading ${tf} (${i + 1} of ${wanted.length})…`)
      const f = fetched[tf] ?? (await fetchTf(tf))
      if (!f) {
        failed.push(tf)
        continue
      }
      if (!f.candles.length) continue
      const csv = csvOf(asset, tf, f.candles, true)
      parts.push(first ? csv : csv.slice(csv.indexOf('\n') + 1))
      first = false
      total += f.candles.length
    }
    setBusy(null)
    if (!parts.length) {
      setNote(failed.length ? `could not read ${failed.join(', ')} - see the error toast; try one timeframe at a time` : `${asset} has no archived bars to download`)
      return
    }
    saveText(`${asset}_all_timeframes.csv`, parts.join('\n'))
    setNote(`downloaded ${asset}_all_timeframes.csv (${total} bars across ${parts.length} timeframes)${failed.length ? ` - could not read: ${failed.join(', ')} (use that row's own button to retry)` : ''}`)
  }

  const rows = EXPORT_TFS.map((tf) => ({ tf, a: archive[tf], f: fetched[tf] }))

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1c2739] px-2 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Data</span>
        <AssetPicker tickers={tickers} value={asset} onChange={setAsset} className="w-36" />
        <button
          type="button"
          onClick={() => void loadArchive()}
          className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-cyan-500/40 hover:text-cyan-300"
        >
          {loadingArchive ? 'reading…' : 'refresh'}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void downloadAll()}
          className="ml-auto rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50"
          title="one CSV with every timeframe that has bars, with asset and tf columns"
        >
          {busy === 'all' ? 'preparing…' : 'download all timeframes (one CSV)'}
        </button>
      </div>

      {note && <div className="border-b border-[#1c2739] px-2 py-1 font-mono text-[9px] text-emerald-300">{note}</div>}

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <table className="w-full border-collapse font-mono text-[10px]">
          <thead>
            <tr className="text-left text-[8.5px] uppercase tracking-wider text-[#4b5a72]">
              <th className="px-1.5 py-1">tf</th>
              <th className="px-1.5 py-1">archived bars</th>
              <th className="px-1.5 py-1">oldest (UTC)</th>
              <th className="px-1.5 py-1">newest (UTC)</th>
              <th className="px-1.5 py-1">gaps / longest run</th>
              <th className="px-1.5 py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ tf, a, f }) => (
              <tr key={tf} className="border-t border-[#141d2e] text-[#aab6cc]">
                <td className="px-1.5 py-1 font-bold text-[#dbe4f0]">{tf}</td>
                <td className="px-1.5 py-1">{a ? a.n.toLocaleString() : <span className="text-[#4b5a72]">none</span>}</td>
                <td className="px-1.5 py-1">{a ? iso(a.oldest) : '-'}</td>
                <td className="px-1.5 py-1">{a ? iso(a.newest) : '-'}</td>
                <td className="px-1.5 py-1">{f ? `${f.gaps} gaps / ${f.longestRun.toLocaleString()} bars` : <span className="text-[#4b5a72]">after the first download</span>}</td>
                <td className="px-1.5 py-1 text-right">
                  <button
                    type="button"
                    disabled={!a?.n || busy !== null}
                    onClick={() => void downloadOne(tf)}
                    className="rounded border border-[#2a3750] px-2 py-0.5 text-[9px] font-bold uppercase text-[#aab6cc] hover:border-cyan-500/40 hover:text-cyan-300 disabled:opacity-40"
                  >
                    {busy === tf ? '…' : 'download CSV'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[9px] leading-relaxed text-[#4b5a72]">
          Bars are exactly the rows in the kernel&apos;s archive - no synthetic gap-fill or prehistory is added (the chart&apos;s own reads do pad those, these downloads do not). The archive does not record whether a bar came from the broker or from a simulated-feed period, so a pair watched while the kernel ran in sim mode can still contain simulated bars. The archive keeps about 4000 bars per pair per timeframe, so one download is at most that many; older bars are dropped as new ones arrive, so download regularly to build a longer history. Bars the feed was not recording are missing, never filled in - the gap count shows how patchy a window is, and any pattern work should treat each run between gaps separately. Columns: time (unix seconds), iso (UTC), open, high, low, close, volume.
        </p>
      </div>
    </div>
  )
}
