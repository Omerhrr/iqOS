'use client'

// IQAIR//OS - Weis Wave panel (one pair)
// The pair's Weis Wave read on every timeframe 30s..15m and the CALL / PUT it adds up to. Per timeframe: the running wave (direction, bars, volume, ATR moved), its volume against the previous wave
// in the same direction, and the flags behind the call (divergence, absorption, shortening, new extreme on more volume). Backed by /weiswave (plugins/weiswave.ts).
// HONEST: describes where effort and result disagree - not a calibrated probability. On feeds without real volume (many OTC pairs) true range stands in and the row says so.
import { useCallback, useEffect, useState } from 'react'
import type { WwMode, WwRow, WwRung } from '@/lib/os/client'
import { fmtPrice, getWeisWave } from '@/lib/os/client'
import { DirChip, Updated, WW_TF_CHOICES, WwControls } from './WeisWaveShared'

interface Props {
  asset: string
  closedTick?: number
  onClose: () => void
  onOpenGlobal?: () => void
}
const POLL_MS = 4_000

function Flag({ on, label, tip }: { on: boolean; label: string; tip: string }) {
  return on ? <span title={tip} className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] uppercase text-amber-300">{label}</span> : null
}

function RungRow({ r }: { r: WwRung }) {
  if (!r.ok) return (
    <div className="flex items-center gap-2 rounded border border-dashed border-[#24324a] bg-[#0b111c] px-1.5 py-1 font-mono text-[9px] text-[#4b5a72]"><span className="w-8 font-bold">{r.tf}</span>{r.note}</div>
  )
  return (
    <div className="flex flex-col gap-0.5 rounded border border-[#1c2739] bg-[#0b111c] px-1.5 py-1">
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[9px]">
        <span className="w-8 shrink-0 font-bold text-[#dbe4f0]">{r.tf}</span>
        <DirChip d={r.direction} strength={r.strength} />
        <span className={r.waveDir > 0 ? 'text-emerald-300' : 'text-rose-300'} title="the wave still running at the last closed bar">{r.waveDir > 0 ? '▲ up-wave' : '▼ down-wave'} · {r.waveBars} bars</span>
        <span className="text-[#7c8aa5]" title="running wave volume vs the previous wave in the same direction">vol {r.waveVol.toLocaleString(undefined, { maximumFractionDigits: 1 })} {r.volRatio !== null ? `(${Math.round(r.volRatio * 100)}% of prev)` : ''}</span>
        <span className="text-[#7c8aa5]" title="price distance the running wave covered, in ATR">{r.waveMoveAtr.toFixed(2)} ATR</span>
        <span className="ml-auto flex gap-0.5">
          <Flag on={r.weak} label="weak" tip="new extreme on LESS volume than the last wave in this direction (divergence)" />
          <Flag on={r.absorption} label="absorb" tip="big effort for little result" />
          <Flag on={r.shortening} label="shorten" tip="each wave in this direction covers less price" />
          <Flag on={r.strong} label="fuel" tip="new extreme on MORE volume - the wave has fuel" />
          <Flag on={r.hot} label="hot" tip="running wave volume well above the typical wave" />
        </span>
      </div>
      {r.reason && <div className="font-mono text-[8.5px] text-[#7c8aa5]">{r.reason}</div>}
    </div>
  )
}

export default function WeisWavePanel({ asset, closedTick, onClose, onOpenGlobal }: Props) {
  const [row, setRow] = useState<WwRow | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [mode, setMode] = useState<WwMode>('atr')
  const [thr, setThr] = useState(1)
  const [tfs, setTfs] = useState<string[]>([...WW_TF_CHOICES])
  const [live, setLive] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (force = false) => {
    setBusy(true)
    try {
      const d = await getWeisWave(asset, { mode, thr, tfs, live, refresh: force })
      if (d.ok) { setRow(d.row); setErr(null) } else setErr(d.error ?? 'weis wave unavailable')
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }, [asset, mode, thr, tfs, live])

  // a different pair clears the old read; every other change just refetches over the top of it (no blank flash)
  useEffect(() => { setRow(null) }, [asset])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick])

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-teal-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Weis Wave</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">{asset}{row ? ` · ${fmtPrice(row.price, asset)}` : ''}</span>
        <Updated ts={row?.computedTs ?? null} busy={busy} />
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => void load(true)} disabled={busy} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:text-sky-300 disabled:opacity-50">refresh</button>
          {onOpenGlobal && <button type="button" onClick={onOpenGlobal} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-teal-500/40 hover:text-teal-300">global</button>}
          <button type="button" onClick={onClose} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300">close</button>
        </div>
      </div>

      <WwControls mode={mode} setMode={setMode} thr={thr} setThr={setThr} tfs={tfs} setTfs={setTfs} live={live} setLive={setLive} />

      {err && <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-[9px] text-amber-300">{err}</div>}

      {row && (
        <>
          <div className={`flex flex-wrap items-center gap-2 rounded border p-2 ${row.direction === 'call' ? 'border-emerald-500/40 bg-emerald-500/10' : row.direction === 'put' ? 'border-rose-500/40 bg-rose-500/10' : 'border-[#1c2739] bg-[#0b111c]'}`}>
            <DirChip d={row.direction} strength={Math.abs(row.net)} />
            <span className="font-mono text-[10px] text-[#dbe4f0]">net {row.net >= 0 ? '+' : ''}{row.net}</span>
            <span className="font-mono text-[9px] text-[#7c8aa5]">{row.agree}/{row.live} timeframes agree{row.best ? ` · strongest ${row.best.tf} (${row.best.direction} ${row.best.strength})` : ''}</span>
            {!row.volumeOk && row.ok && <span className="font-mono text-[8.5px] text-amber-300" title="this feed has no usable volume, true range stands in as the effort measure">no real volume · range stands in</span>}
          </div>
          <p className="font-mono text-[8.5px] text-[#4b5a72]">net = mean of each live timeframe&apos;s vote (+ call, - put, weighted by strength); a side needs |net| &gt;= 25. Backtest before trusting it: this flags effort-vs-result disagreement, not a win probability.</p>
          <div className="flex flex-col gap-0.5">{row.rungs.map((r) => <RungRow key={r.tf} r={r} />)}</div>
        </>
      )}
      {!row && !err && <p className="p-2 font-mono text-[9px] text-[#3d4d66]">loading…</p>}
    </div>
  )
}
