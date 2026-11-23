'use client'

// IQAIR//OS - Weis PM panels. PURE pm (cause -> effect predicted move, GET /predicted_move | /pm_global) read together with the WEIS WAVE of the same pair and timeframe (GET /weiswave | /weiswave_global).
// pm says WHO is pushing; the Weis wave says whether the volume behind the running wave backs that move or shows it is spent. Same rules as the built-in script "pm + Weis wave":
//   backed = the wave points the SAME way as pm (strength >= minWave)      -> take
//   spent  = the wave points the OTHER way (strength >= minWave)           -> stand down
//   silent = no wave signal (or still warming)                             -> take pm alone (or skip, with "needs backing" on)
// HONEST: both are DESCRIPTIONS, not forecasts. On feeds with no real volume (BTC, many OTC pairs) true range stands in for volume and the row says so. Backtest before trusting it: on clean BTCUSD 1m/2m/5m data the filter did not move the win rate.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { osGet, fmtPrice, getWeisWave, getWeisWaveGlobal } from '@/lib/os/client'
import type { WwMode, WwRow, WwRung } from '@/lib/os/client'
import { DirChip, RungStrip, Updated, WW_TF_CHOICES, WwControls } from './WeisWaveShared'

type Dir = 'call' | 'put' | 'none'
type State = 'backed' | 'spent' | 'silent' | 'no-pm'
interface PmRes {
  ok: boolean; error?: string; text?: string
  pm?: { dir: Dir; prob: number; confidence: number; moveAtr: number }
  cause?: { label: string }
  effect?: { psychology: string; sizeAtr: number }
  sr?: { atSupport: boolean; atResistance: boolean }
  combined?: { alignment: string; dir: Dir; lean: Dir; prob: number }
}
interface PmRow { asset: string; otc: boolean; dir: Dir; lean: Dir; prob: number; alignment: string; cause: string; atSupport: boolean; atResistance: boolean; price: number }
interface PmGlobalRes { ok: boolean; error?: string; rows: PmRow[]; scanned: number; warming: number }

const MIN_WAVE = 30
const dirCls = (d: Dir) => (d === 'call' ? 'text-emerald-300' : d === 'put' ? 'text-rose-300' : 'text-[#7c8aa5]')
const arrow = (d: Dir) => (d === 'call' ? '▲' : d === 'put' ? '▼' : '—')
const btn = (on: boolean) => `rounded border px-1.5 py-px font-mono text-[8.5px] uppercase ${on ? 'border-[#3d4d66] bg-[#132034] text-[#dbe4f0]' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#dbe4f0]'}`
const chip = 'rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]'
const PM_TFS = ['15s', '30s', '1m', '2m', '5m', '15m']
/** the Weis wave only runs 30s..15m: 15s reads its 30s rung */
const wwTfOf = (tf: string) => ((WW_TF_CHOICES as readonly string[]).includes(tf) ? tf : '30s')

/** pm's call + the wave rung on the same timeframe -> the verdict. Mirrors the script (needBacking / minWave). */
export function weisPmVerdict(pm: Dir, rung: WwRung | undefined, needBacking: boolean): { state: State; take: Dir; text: string } {
  if (pm === 'none') return { state: 'no-pm', take: 'none', text: 'pm has no call' }
  if (!rung || !rung.ok) return { state: 'silent', take: needBacking ? 'none' : pm, text: 'wave still warming - pm alone' }
  const strong = rung.direction !== 'none' && rung.strength >= MIN_WAVE
  if (!strong) return { state: 'silent', take: needBacking ? 'none' : pm, text: 'no wave signal - pm alone' }
  if (rung.direction === pm) return { state: 'backed', take: pm, text: `wave backs it (${rung.strength})` }
  return { state: 'spent', take: 'none', text: `wave says spent (${rung.direction} ${rung.strength}) - stand down` }
}
const stateCls = (s: State) => (s === 'backed' ? 'border-emerald-500/40 text-emerald-300' : s === 'spent' ? 'border-amber-500/40 text-amber-300' : s === 'silent' ? 'border-[#3d4d66] text-[#7c8aa5]' : 'border-[#1c2739] text-[#3d4d66]')

function Header({ title, sub, onClose, extra }: { title: string; sub: React.ReactNode; onClose: () => void; extra?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-teal-300" />
      <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">{title}</h3>
      <span className="font-mono text-[9px] text-[#7c8aa5]">{sub}</span>
      {extra}
      <button type="button" onClick={onClose} className="ml-auto rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300">close</button>
    </div>
  )
}

export function WeisPmPanel({ asset, tf = '1m', closedTick, onClose, onOpenGlobal }: { asset: string; tf?: string; closedTick?: number; onClose: () => void; onOpenGlobal?: () => void }) {
  const [pmRes, setPmRes] = useState<PmRes | null>(null)
  const [ww, setWw] = useState<WwRow | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [htf, setHtf] = useState('5m')
  const [mode, setMode] = useState<WwMode>('atr')
  const [thr, setThr] = useState(1)
  const [live, setLive] = useState(true)
  const [needBacking, setNeedBacking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tfs, setTfs] = useState<string[]>([...WW_TF_CHOICES])

  const load = useCallback(async (force = false) => {
    setBusy(true)
    const errs: string[] = []
    const [p, w] = await Promise.allSettled([
      osGet<PmRes>('/predicted_move', { asset: asset.replace(/\W/g, ''), tf, htf }),
      getWeisWave(asset, { mode, thr, tfs, live, refresh: force }),
    ])
    if (p.status === 'fulfilled') { setPmRes(p.value); if (!p.value.ok) errs.push(p.value.error ?? 'pm unavailable') } else errs.push(`pm: ${(p.reason as Error).message}`)
    if (w.status === 'fulfilled') { if (w.value.ok) setWw(w.value.row); else errs.push(w.value.error ?? 'weis wave unavailable') } else errs.push(`weis wave: ${(w.reason as Error).message}`)
    setErr(errs.length ? errs.join(' · ') : null)
    setBusy(false)
  }, [asset, tf, htf, mode, thr, tfs, live])
  useEffect(() => { setWw(null); setPmRes(null) }, [asset])
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t) }, [load, closedTick])

  const cb = pmRes?.combined
  const pmDir: Dir = pmRes?.ok ? (cb?.dir ?? pmRes.pm?.dir ?? 'none') : 'none'
  const prob = cb?.prob ?? pmRes?.pm?.prob ?? 0.5
  const wwTf = wwTfOf(tf)
  const rung = ww?.rungs.find((r) => r.tf === wwTf)
  const v = weisPmVerdict(pmDir, rung, needBacking)

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <Header title="Weis PM" sub={`${asset} · ${tf}${ww ? ` · ${fmtPrice(ww.price, asset)}` : ''}`} onClose={onClose}
        extra={<><Updated ts={ww?.computedTs ?? null} busy={busy} />{onOpenGlobal && <button type="button" onClick={onOpenGlobal} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-teal-500/40 hover:text-teal-300">→ global</button>}</>} />
      <div className="flex flex-wrap items-center gap-1">
        <span className="font-mono text-[8px] uppercase text-[#4b5a72]">pm higher frame</span>
        {['5m', '15m', 'none'].map((h) => <button key={h} type="button" onClick={() => setHtf(h)} className={btn(htf === h)}>{h}</button>)}
        <span className="mx-1 h-3 w-px bg-[#1c2739]" />
        <button type="button" onClick={() => setNeedBacking((b) => !b)} className={btn(needBacking)} title="on: only take pm when the wave backs it; off: a silent wave lets pm through">needs backing</button>
        <button type="button" onClick={() => void load(true)} disabled={busy} className="ml-auto rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:text-sky-300 disabled:opacity-50">refresh</button>
      </div>
      <WwControls mode={mode} setMode={setMode} thr={thr} setThr={setThr} tfs={tfs} setTfs={setTfs} live={live} setLive={setLive} />
      {err && <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-[9px] text-amber-300">{err}</div>}

      <div className={`rounded-lg border px-2.5 py-2 ${v.take === 'call' ? 'border-emerald-500/40 bg-emerald-500/10' : v.take === 'put' ? 'border-rose-500/40 bg-rose-500/10' : 'border-[#1c2739] bg-[#0b111c]'}`}>
        <div className="flex items-center gap-2">
          <span className={`font-mono text-lg font-bold leading-none ${dirCls(v.take)}`}>{arrow(v.take)}</span>
          <div className="flex flex-col">
            <span className={`font-mono text-[11px] font-bold uppercase tracking-wider ${dirCls(v.take)}`}>{v.take === 'none' ? (v.state === 'spent' ? 'stand down' : 'no call') : v.take}</span>
            <span className="font-mono text-[9px] text-[#7c8aa5]">{v.text}</span>
          </div>
          <span className={`ml-auto rounded border px-1.5 py-px font-mono text-[8.5px] font-bold uppercase ${stateCls(v.state)}`}>{v.state === 'no-pm' ? 'no pm' : v.state}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className={chip}>pm {arrow(pmDir)} {pmDir === 'none' ? 'none' : `${(prob * 100).toFixed(1)}% P(up)`}</span>
          <span className={chip}>wave {wwTf}: {rung?.ok ? `${rung.direction === 'none' ? 'no signal' : `${rung.direction} ${rung.strength}`}` : 'warming'}</span>
          {pmRes?.pm && <span className={chip}>move {pmRes.pm.moveAtr.toFixed(2)} ATR</span>}
          {pmRes?.sr?.atSupport && <span className={`${chip} !border-emerald-500/40 !text-emerald-300`}>at support</span>}
          {pmRes?.sr?.atResistance && <span className={`${chip} !border-rose-500/40 !text-rose-300`}>at resistance</span>}
          {ww && !ww.volumeOk && ww.ok && <span className="font-mono text-[8.5px] text-amber-300" title="no usable volume on this feed, true range stands in">no real volume · range stands in</span>}
        </div>
      </div>

      {pmRes?.ok && pmRes.pm && (
        <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] leading-relaxed text-[#7c8aa5]">
          <div className="flex justify-between"><span>pm cause</span><span className="text-[#dbe4f0]">{pmRes.cause?.label}</span></div>
          <div className="flex justify-between"><span>pm effect</span><span className="text-[#dbe4f0]">{pmRes.effect?.psychology} · {pmRes.effect?.sizeAtr.toFixed(2)} ATR</span></div>
          {cb && <div className="flex justify-between"><span>pm frames</span><span className="text-[#dbe4f0]">{cb.alignment}</span></div>}
        </div>
      )}

      {ww && (
        <div className="flex flex-col gap-1 rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] text-[#7c8aa5]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[8px] uppercase text-[#4b5a72]">wave, all timeframes</span>
            <DirChip d={ww.direction} strength={Math.abs(ww.net)} />
            <RungStrip rungs={ww.rungs} best={ww.best?.tf} />
            <span>{ww.agree}/{ww.live} agree</span>
          </div>
          {rung?.ok && (
            <div className="text-[#7c8aa5]">{wwTf}: {rung.waveDir > 0 ? '▲ up-wave' : '▼ down-wave'} · {rung.waveBars} bars · {rung.waveMoveAtr.toFixed(2)} ATR{rung.volRatio !== null ? ` · vol ${Math.round(rung.volRatio * 100)}% of prev` : ''}{rung.reason ? ` · ${rung.reason}` : ''}</div>
          )}
        </div>
      )}
      {pmRes?.text && <p className="font-mono text-[9px] leading-relaxed text-[#7c8aa5]">{pmRes.text}</p>}
      <p className="font-mono text-[8px] text-[#3d4d66]">backed = the wave points pm&apos;s way · spent = the wave points the other way (stand down) · silent = no wave signal. A description, not a forecast - backtest it on your pair.</p>
    </div>
  )
}

export function WeisPmGlobalPanel({ tf = '1m', closedTick, onClose, onPickAsset, onOpenPm }: { tf?: string; closedTick?: number; onClose: () => void; onPickAsset?: (a: string) => void; onOpenPm?: (a: string) => void }) {
  const [pm, setPm] = useState<PmGlobalRes | null>(null)
  const [wwRows, setWwRows] = useState<Map<string, WwRow> | null>(null)
  const [wwTs, setWwTs] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ftf, setFtf] = useState(tf)
  const [htf, setHtf] = useState('5m')
  const [scope, setScope] = useState<'all' | 'real' | 'otc'>('all')
  const [view, setView] = useState<'take' | 'all' | 'spent'>('take')
  const [mode, setMode] = useState<WwMode>('atr')
  const [thr, setThr] = useState(1)
  const [live, setLive] = useState(true)
  const [needBacking, setNeedBacking] = useState(false)
  const [tfs, setTfs] = useState<string[]>([...WW_TF_CHOICES])

  const load = useCallback(async (force = false) => {
    setBusy(true)
    const errs: string[] = []
    const [p, w] = await Promise.allSettled([
      osGet<PmGlobalRes>('/pm_global', { tf: ftf, htf, scope, limit: 200 }),
      getWeisWaveGlobal({ mode, thr, tfs, live, refresh: force }),
    ])
    if (p.status === 'fulfilled') { setPm(p.value); if (!p.value.ok) errs.push(p.value.error ?? 'pm scan failed') } else errs.push(`pm: ${(p.reason as Error).message}`)
    if (w.status === 'fulfilled') { if (w.value.ok) { setWwRows(new Map(w.value.rows.map((r) => [r.asset, r]))); setWwTs(w.value.scannedTs) } else errs.push(w.value.error ?? 'weis wave unavailable') } else errs.push(`weis wave: ${(w.reason as Error).message}`)
    setErr(errs.length ? errs.join(' · ') : null)
    setBusy(false)
  }, [ftf, htf, scope, mode, thr, tfs, live])
  useEffect(() => { void load(); const t = setInterval(() => void load(), 8000); return () => clearInterval(t) }, [load, closedTick])

  const wwTf = wwTfOf(ftf)
  const joined = useMemo(() => (pm?.rows ?? []).map((r) => {
    const w = wwRows?.get(r.asset)
    const rung = w?.rungs.find((x) => x.tf === wwTf)
    return { r, w, rung, v: weisPmVerdict(r.dir, rung, needBacking) }
  }), [pm, wwRows, wwTf, needBacking])
  const rows = useMemo(() => joined
    .filter((j) => (view === 'take' ? j.v.take !== 'none' : view === 'spent' ? j.v.state === 'spent' : j.r.dir !== 'none'))
    .sort((a, b) => Number(b.v.state === 'backed') - Number(a.v.state === 'backed') || Math.abs(b.r.prob - 0.5) - Math.abs(a.r.prob - 0.5)), [joined, view])
  const takes = joined.filter((j) => j.v.take !== 'none')
  const backed = joined.filter((j) => j.v.state === 'backed').length
  const spent = joined.filter((j) => j.v.state === 'spent').length

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <Header title="Weis PM Global" sub={`${ftf}${pm ? ` · ${pm.scanned} pairs` : ''}`} onClose={onClose} extra={<><Updated ts={wwTs} busy={busy} /><button type="button" onClick={() => void load(true)} disabled={busy} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:text-sky-300 disabled:opacity-50">refresh</button></>} />
      <div className="flex flex-wrap items-center gap-1">
        {PM_TFS.map((t) => <button key={t} type="button" onClick={() => setFtf(t)} className={btn(ftf === t)}>{t}</button>)}
        <span className="mx-1 h-3 w-px bg-[#1c2739]" />
        {['5m', '15m', 'none'].map((h) => <button key={h} type="button" title="pm higher-frame blend" onClick={() => setHtf(h)} className={btn(htf === h)}>htf {h}</button>)}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {(['all', 'real', 'otc'] as const).map((s) => <button key={s} type="button" onClick={() => setScope(s)} className={btn(scope === s)}>{s}</button>)}
        <span className="mx-1 h-3 w-px bg-[#1c2739]" />
        {(['take', 'all', 'spent'] as const).map((o) => <button key={o} type="button" onClick={() => setView(o)} className={btn(view === o)} title={o === 'take' ? 'pairs the combined read would trade' : o === 'all' ? 'every pm call, even the ones the wave stands down' : 'pm calls the wave says are spent'}>{o}</button>)}
        <button type="button" onClick={() => setNeedBacking((b) => !b)} className={btn(needBacking)} title="on: only pairs where the wave backs pm">needs backing</button>
      </div>
      <WwControls mode={mode} setMode={setMode} thr={thr} setThr={setThr} tfs={tfs} setTfs={setTfs} live={live} setLive={setLive} />
      {err && <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-[9px] text-amber-300">{err}</div>}
      {pm?.ok && (
        <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] px-2.5 py-1.5 font-mono text-[9px] text-[#7c8aa5]">
          <span className="text-emerald-300">{takes.filter((j) => j.v.take === 'call').length}▲</span> / <span className="text-rose-300">{takes.filter((j) => j.v.take === 'put').length}▼</span> to trade · {backed} backed · {spent} stood down{pm.warming > 0 && ` · ${pm.warming} warming`}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-[#1c2739]">
        <table className="w-full font-mono text-[9px]">
          <thead className="sticky top-0 bg-[#0b111c] text-[8px] uppercase tracking-wider text-[#4b5a72]">
            <tr><th className="px-1.5 py-1 text-left">pair</th><th className="px-1 text-left">take</th><th className="px-1 text-right">P(up)</th><th className="px-1 text-left">wave {wwTf}</th><th className="px-1 text-left">state</th><th className="px-1 text-left">all tf</th></tr>
          </thead>
          <tbody>
            {rows.map(({ r, w, rung, v }) => (
              <tr key={r.asset} className="border-t border-[#131c2b] hover:bg-[#101a2b]">
                <td className="px-1.5 py-0.5"><button type="button" onClick={() => onPickAsset?.(r.asset)} onDoubleClick={() => onOpenPm?.(r.asset)} title="click: open on chart · double-click: Weis PM panel" className="text-left font-bold text-[#dbe4f0] hover:text-sky-300">{r.asset}</button>{r.otc && <span className="ml-1 text-[7px] text-[#4b5a72]">OTC</span>}{w && !w.volumeOk && w.ok && <span className="ml-1 text-[7px] text-amber-300" title="no real volume - true range stands in">range</span>}</td>
                <td className={`px-1 font-bold ${dirCls(v.take)}`}>{arrow(v.take)} {v.take === 'none' ? (r.dir === 'none' ? '' : `${r.dir} held`) : v.take}{v.take === 'call' && r.atResistance && <span className="ml-1 text-[7px] text-amber-300">res</span>}{v.take === 'put' && r.atSupport && <span className="ml-1 text-[7px] text-amber-300">sup</span>}</td>
                <td className="px-1 text-right text-[#7c8aa5]">{(r.prob * 100).toFixed(0)}%</td>
                <td className={`px-1 ${rung?.ok && rung.direction !== 'none' ? dirCls(rung.direction) : 'text-[#4b5a72]'}`}>{rung?.ok ? (rung.direction === 'none' ? '—' : `${arrow(rung.direction)} ${rung.strength}`) : '·'}</td>
                <td className="px-1"><span className={`rounded border px-1 py-px text-[7.5px] font-bold uppercase ${stateCls(v.state)}`}>{v.state === 'no-pm' ? 'no pm' : v.state}</span></td>
                <td className="px-1">{w?.ok ? <RungStrip rungs={w.rungs} best={w.best?.tf} /> : <span className="text-[#3d4d66]">·</span>}</td>
              </tr>
            ))}
            {!rows.length && !busy && <tr><td colSpan={6} className="px-2 py-3 text-center text-[#4b5a72]">nothing matches</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="font-mono text-[8px] text-[#3d4d66]">pm call x Weis wave on the same timeframe. backed = wave agrees, spent = wave says the move is out of fuel (held back), silent = no wave signal. res/sup = the call runs into a wall.</p>
    </div>
  )
}

export default WeisPmPanel
