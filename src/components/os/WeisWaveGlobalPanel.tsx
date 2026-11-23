'use client'

// IQAIR//OS - Weis Wave Global panel
// Every open pair's Weis Wave read on one board. Each row = the strength-weighted CALL / PUT of its timeframes (30s..15m), the running wave's volume vs the last wave
// in its direction, and a per-timeframe strip. Actionable pairs (a named side) first. Backed by /weiswave_global (plugins/weiswave.ts, TTL-cached 15 s, in-memory candles).
// HONEST: it flags where volume and price disagree (a spent wave -> the other way; a new extreme on more volume -> with it). It is not a win probability - backtest before trading it.
import { useCallback, useEffect, useState } from 'react'
import type { WwGlobalResult, WwMode, WwRow } from '@/lib/os/client'
import { fmtPrice, getWeisWaveGlobal } from '@/lib/os/client'
import { DirChip, RungStrip, Updated, WW_TF_CHOICES, WwControls } from './WeisWaveShared'

interface Props {
  closedTick?: number
  onPickAsset?: (asset: string) => void
  /** open the per-pair Weis Wave panel for a row */
  onOpenWeisWave?: (asset: string) => void
  onClose: () => void
}
const POLL_MS = 6_000
type Filter = 'all' | 'call' | 'put'

export default function WeisWaveGlobalPanel({ closedTick, onPickAsset, onOpenWeisWave, onClose }: Props) {
  const [data, setData] = useState<WwGlobalResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [mode, setMode] = useState<WwMode>('atr')
  const [thr, setThr] = useState(1)
  const [tfs, setTfs] = useState<string[]>([...WW_TF_CHOICES])
  const [filter, setFilter] = useState<Filter>('all')
  const [minAgree, setMinAgree] = useState(1)
  const [live, setLive] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (force = false) => {
    setBusy(true)
    try {
      const d = await getWeisWaveGlobal({ mode, thr, tfs, live, refresh: force })
      if (d.ok) { setData(d); setErr(null) } else setErr(d.error ?? 'weis wave global unavailable')
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }, [mode, thr, tfs, live])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick])

  const rows = (data?.rows ?? []).filter((r: WwRow) => (filter === 'all' ? true : r.direction === filter) && (r.direction === 'none' || r.agree >= minAgree))
  const btn = (on: boolean) => `rounded border px-1.5 py-px font-mono text-[8.5px] uppercase ${on ? 'border-[#3d4d66] bg-[#0e1524] text-[#dbe4f0]' : 'border-[#1c2739] text-[#7c8aa5] hover:text-[#dbe4f0]'}`

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-teal-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Weis Wave Global</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">{data ? `${data.live} live · ${data.warming} warming · universe ${data.universe}` : 'loading…'}</span>
        <Updated ts={data?.scannedTs ?? null} busy={busy} />
        <div className="ml-auto flex items-center gap-1">
          {(['all', 'call', 'put'] as Filter[]).map((f) => (
            <button key={f} type="button" className={btn(filter === f)} onClick={() => setFilter(f)}>{f}</button>
          ))}
          <button type="button" onClick={() => void load(true)} disabled={busy} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:text-sky-300 disabled:opacity-50">refresh</button>
          <button type="button" onClick={onClose} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300">close</button>
        </div>
      </div>

      <WwControls mode={mode} setMode={setMode} thr={thr} setThr={setThr} tfs={tfs} setTfs={setTfs} live={live} setLive={setLive} />

      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[8.5px] text-[#7c8aa5]">
        {data && (
          <>
            <span className="rounded border border-emerald-500/40 px-1.5 py-px text-emerald-300">{data.calls} call</span>
            <span className="rounded border border-rose-500/40 px-1.5 py-px text-rose-300">{data.puts} put</span>
          </>
        )}
        <span title="a named side needs at least this many timeframes pointing the same way">min agree</span>
        {[1, 2, 3].map((n) => (
          <button key={n} type="button" className={btn(minAgree === n)} onClick={() => setMinAgree(n)}>{n}</button>
        ))}
        <span className="text-[#4b5a72]">a spent wave (new extreme on less volume / big effort for little move) = the other way · a new extreme on more volume = with it · click a row for its detail, middle-click to load it on the chart</span>
      </div>

      {err && <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-[9px] text-amber-300">{err}</div>}

      <div className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <button
            key={r.asset}
            type="button"
            onClick={() => onOpenWeisWave?.(r.asset)}
            onAuxClick={() => onPickAsset?.(r.asset)}
            className={`flex items-center gap-2 rounded border px-1.5 py-1 text-left transition-colors ${r.ok ? 'border-[#1c2739] bg-[#0b111c] hover:border-[#3d4d66]' : 'border-dashed border-[#24324a] bg-[#0b111c]'}`}
            title={r.ok ? `${r.asset}: net ${r.net >= 0 ? '+' : ''}${r.net} · ${r.agree}/${r.live} timeframes agree${r.volumeOk ? '' : ' · no real volume on this feed, true range stands in'}` : `${r.asset}: ${r.note}`}
          >
            <span className={`w-4 shrink-0 text-center font-mono text-[10px] font-bold ${r.direction === 'call' ? 'text-emerald-300' : r.direction === 'put' ? 'text-rose-300' : 'text-[#3d4d66]'}`}>{r.direction === 'call' ? '▲' : r.direction === 'put' ? '▼' : '—'}</span>
            <span className={`w-24 shrink-0 truncate font-mono text-[10px] font-bold ${r.ok ? 'text-[#dbe4f0]' : 'text-[#7c8aa5]'}`}>{r.asset}</span>
            {r.ok ? (
              <>
                <DirChip d={r.direction} strength={Math.abs(r.net)} />
                <span className="w-10 shrink-0 text-right font-mono text-[9px] text-[#7c8aa5]">{r.agree}/{r.live}</span>
                <RungStrip rungs={r.rungs} best={r.best?.tf} />
                <span className="ml-auto shrink-0 font-mono text-[8.5px] text-[#7c8aa5]">
                  {r.best ? `best ${r.best.tf}` : ''}{r.volumeOk ? '' : ' · range'} · {fmtPrice(r.price, r.asset)}
                </span>
              </>
            ) : (
              <span className="font-mono text-[8.5px] text-[#4b5a72]">{r.note}</span>
            )}
          </button>
        ))}
        {rows.length === 0 && !err && <p className="p-2 font-mono text-[9px] text-[#3d4d66]">no rows match…</p>}
      </div>
    </div>
  )
}
