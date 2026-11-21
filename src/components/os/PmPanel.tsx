'use client'

// IQAIR//OS - PM panels. PmPanel = the cause -> effect PREDICTED MOVE of the chart's pair (analytics/causeeffect.ts, GET /predicted_move);
// PmGlobalPanel = the same model on every open pair, ranked (GET /pm_global). Both are DESCRIPTIONS with a walk-forward record, not forecasts: "validated" only says the
// pair's own recent hit rate beat 50% on enough calls, and over many pairs some pass by luck.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { osGet } from '@/lib/os/client'

type Dir = 'call' | 'put' | 'none'
interface PmRes {
  ok: boolean; error?: string; text?: string
  pm?: { dir: Dir; prob: number; confidence: number; moveAtr: number }
  cause?: { label: string; volRatio: number; fpDelta: number; tickImb: number; mfi: number; adSlope: number; ticksUsed: boolean }
  effect?: { psychology: string; sizeAtr: number; roc: number; cci: number }
  validation?: { coherence: number; bucketN: number; trackN: number; trackHit: number; validated: boolean }
  sr?: { atSupport: boolean; atResistance: boolean; supDist: number; resDist: number }
  combined?: { alignment: string; dir: Dir; lean: Dir; prob: number; strength: number; htfTf: string; htfOk: boolean }
}
interface PmRow { asset: string; otc: boolean; dir: Dir; lean: Dir; prob: number; strength: number; alignment: string; validated: boolean; trackN: number; trackHit: number; bucketN: number; cause: string; psychology: string; atSupport: boolean; atResistance: boolean; moveAtr: number; price: number }
interface PmGlobalRes { ok: boolean; error?: string; tf: string; htf: string; scanned: number; warming: number; calls: number; puts: number; validatedCalls: number; ts: number; rows: PmRow[] }

const dirCls = (d: Dir) => (d === 'call' ? 'text-emerald-300' : d === 'put' ? 'text-rose-300' : 'text-[#7c8aa5]')
const arrow = (d: Dir) => (d === 'call' ? '▲' : d === 'put' ? '▼' : '—')
const chip = 'rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]'
const btn = (on: boolean) => `rounded border px-1.5 py-px font-mono text-[8.5px] uppercase ${on ? 'border-[#3d4d66] bg-[#132034] text-[#dbe4f0]' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#dbe4f0]'}`
const TFS = ['15s', '30s', '1m', '2m', '5m', '15m']

function Header({ title, sub, onClose, extra }: { title: string; sub: string; onClose: () => void; extra?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
      <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">{title}</h3>
      <span className="font-mono text-[9px] text-[#7c8aa5]">{sub}</span>
      {extra}
      <button type="button" onClick={onClose} className="ml-auto rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300">close</button>
    </div>
  )
}

export function PmPanel({ asset, tf = '1m', closedTick, onClose, onOpenGlobal }: { asset: string; tf?: string; closedTick?: number; onClose: () => void; onOpenGlobal?: () => void }) {
  const [res, setRes] = useState<PmRes | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [htf, setHtf] = useState('5m')
  const load = useCallback(async () => {
    try { const r = await osGet<PmRes>('/predicted_move', { asset: asset.replace(/\W/g, ''), tf, htf }); setRes(r); setErr(r.ok ? null : r.error ?? 'pm unavailable') } catch (e) { setErr((e as Error).message) }
  }, [asset, tf, htf])
  useEffect(() => { void load(); const t = setInterval(() => void load(), 8000); return () => clearInterval(t) }, [load, closedTick])
  const cb = res?.combined, dir: Dir = cb?.dir ?? res?.pm?.dir ?? 'none', prob = cb?.prob ?? res?.pm?.prob ?? 0.5
  const v = res?.validation
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <Header title="PM" sub={`${asset} · ${tf}`} onClose={onClose} extra={onOpenGlobal && <button type="button" onClick={onOpenGlobal} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-teal-500/40 hover:text-teal-300">→ global</button>} />
      <div className="flex items-center gap-1">
        <span className="font-mono text-[8px] uppercase text-[#4b5a72]">higher frame</span>
        {['5m', '15m', 'none'].map((h) => <button key={h} type="button" onClick={() => setHtf(h)} className={btn(htf === h)}>{h}</button>)}
      </div>
      {err && <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-[9px] text-amber-300">{err}</div>}
      {res?.ok && res.pm && (
        <>
          <div className={`rounded-lg border px-2.5 py-2 ${dir === 'call' ? 'border-emerald-500/40 bg-emerald-500/10' : dir === 'put' ? 'border-rose-500/40 bg-rose-500/10' : 'border-[#1c2739] bg-[#0b111c]'}`}>
            <div className="flex items-center gap-2">
              <span className={`font-mono text-lg font-bold leading-none ${dirCls(dir)}`}>{arrow(dir)}</span>
              <div className="flex flex-col">
                <span className={`font-mono text-[11px] font-bold uppercase tracking-wider ${dirCls(dir)}`}>{dir === 'none' ? 'no call' : dir}</span>
                <span className="font-mono text-[9px] text-[#7c8aa5]">{cb ? `${cb.alignment}${cb.lean !== 'none' && cb.lean !== dir ? ` · leans ${cb.lean}` : ''}` : 'single frame'}</span>
              </div>
              <div className="ml-auto flex flex-col items-center">
                <span className="font-mono text-lg font-bold leading-none text-[#dbe4f0]">{cb ? cb.strength : res.pm.confidence}</span>
                <span className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">strength</span>
              </div>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <span className={chip}>P(up) {(prob * 100).toFixed(1)}%</span>
              <span className={`${chip} ${v?.validated ? '!border-emerald-500/50 !text-emerald-300' : ''}`}>{v?.validated ? 'validated' : 'unvalidated'}</span>
              {v && <span className={chip} title="walk-forward calls and their hit rate">record {v.trackN > 0 ? `${(v.trackHit * 100).toFixed(0)}% of ${v.trackN}` : 'none yet'}</span>}
              {v && <span className={chip} title="comparable past moments the probability is built from">bucket {v.bucketN}</span>}
              {res.sr?.atSupport && <span className={`${chip} !border-emerald-500/40 !text-emerald-300`}>at support</span>}
              {res.sr?.atResistance && <span className={`${chip} !border-rose-500/40 !text-rose-300`}>at resistance</span>}
            </div>
          </div>
          <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2 font-mono text-[9px] leading-relaxed text-[#7c8aa5]">
            <div className="flex justify-between"><span>cause</span><span className="text-[#dbe4f0]">{res.cause?.label}</span></div>
            <div className="flex justify-between"><span>effect</span><span className="text-[#dbe4f0]">{res.effect?.psychology} · {res.effect?.sizeAtr.toFixed(2)} ATR</span></div>
            <div className="flex justify-between"><span>footprint Δ / MFI / A-D</span><span className="text-[#dbe4f0]">{res.cause?.fpDelta.toFixed(2)} / {Number.isFinite(res.cause?.mfi) ? res.cause?.mfi.toFixed(0) : 'n/a'} / {Number.isFinite(res.cause?.adSlope) ? res.cause?.adSlope.toFixed(2) : 'n/a'}</span></div>
            <div className="flex justify-between"><span>ticks</span><span className="text-[#dbe4f0]">{res.cause?.ticksUsed ? `imbalance ${res.cause.tickImb.toFixed(2)}` : 'none'}</span></div>
          </div>
          {res.text && <p className="font-mono text-[9px] leading-relaxed text-[#7c8aa5]">{res.text}</p>}
          <p className="font-mono text-[8px] text-[#3d4d66]">a description with a walk-forward record, not a forecast - backtest before trusting it</p>
        </>
      )}
    </div>
  )
}

export function PmGlobalPanel({ tf = '1m', closedTick, onClose, onPickAsset, onOpenPm }: { tf?: string; closedTick?: number; onClose: () => void; onPickAsset?: (a: string) => void; onOpenPm?: (a: string) => void }) {
  const [res, setRes] = useState<PmGlobalRes | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ftf, setFtf] = useState(tf)
  const [htf, setHtf] = useState('5m')
  const [scope, setScope] = useState<'all' | 'real' | 'otc'>('all')
  const [only, setOnly] = useState<'all' | 'call' | 'put' | 'validated'>('all')
  const load = useCallback(async () => {
    setBusy(true)
    try { const r = await osGet<PmGlobalRes>('/pm_global', { tf: ftf, htf, scope, limit: 150 }); setRes(r); setErr(r.ok ? null : r.error ?? 'scan failed') } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }, [ftf, htf, scope])
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15000); return () => clearInterval(t) }, [load, closedTick])
  const rows = useMemo(() => (res?.rows ?? []).filter((r) => (only === 'all' ? true : only === 'validated' ? r.dir !== 'none' && r.validated : r.dir === only)), [res, only])
  const best = rows.find((r) => r.dir !== 'none')
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <Header title="PM Global" sub={`${ftf}${res ? ` · ${res.scanned} pairs` : ''}`} onClose={onClose} extra={<button type="button" onClick={() => void load()} disabled={busy} className="rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:text-sky-300 disabled:opacity-50">{busy ? '...' : 'refresh'}</button>} />
      <div className="flex flex-wrap items-center gap-1">
        {TFS.map((t) => <button key={t} type="button" onClick={() => setFtf(t)} className={btn(ftf === t)}>{t}</button>)}
        <span className="mx-1 h-3 w-px bg-[#1c2739]" />
        {['5m', '15m', 'none'].map((h) => <button key={h} type="button" title="higher-frame blend" onClick={() => setHtf(h)} className={btn(htf === h)}>htf {h}</button>)}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {(['all', 'real', 'otc'] as const).map((s) => <button key={s} type="button" onClick={() => setScope(s)} className={btn(scope === s)}>{s}</button>)}
        <span className="mx-1 h-3 w-px bg-[#1c2739]" />
        {(['all', 'call', 'put', 'validated'] as const).map((o) => <button key={o} type="button" onClick={() => setOnly(o)} className={btn(only === o)}>{o}</button>)}
      </div>
      {err && <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-[9px] text-amber-300">{err}</div>}
      {res?.ok && (
        <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] px-2.5 py-1.5 font-mono text-[9px] text-[#7c8aa5]">
          <span className="text-emerald-300">{res.calls}▲</span> / <span className="text-rose-300">{res.puts}▼</span> · {res.validatedCalls} validated{res.warming > 0 && ` · ${res.warming} warming`}
          {best && <> · best <button type="button" onClick={() => onPickAsset?.(best.asset)} className="font-bold text-[#dbe4f0] underline decoration-[#24324a] hover:decoration-sky-400">{best.asset}</button> <span className={dirCls(best.dir)}>{arrow(best.dir)}{best.strength}</span></>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-[#1c2739]">
        <table className="w-full font-mono text-[9px]">
          <thead className="sticky top-0 bg-[#0b111c] text-[8px] uppercase tracking-wider text-[#4b5a72]">
            <tr><th className="px-1.5 py-1 text-left">pair</th><th className="px-1 text-left">call</th><th className="px-1 text-right">str</th><th className="px-1 text-right">P(up)</th><th className="px-1 text-left">align</th><th className="px-1 text-right">record</th><th className="px-1 text-left">cause</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.asset} className="border-t border-[#131c2b] hover:bg-[#101a2b]">
                <td className="px-1.5 py-0.5"><button type="button" onClick={() => onPickAsset?.(r.asset)} onDoubleClick={() => onOpenPm?.(r.asset)} title="click: open on chart · double-click: PM panel" className="text-left font-bold text-[#dbe4f0] hover:text-sky-300">{r.asset}</button>{r.otc && <span className="ml-1 text-[7px] text-[#4b5a72]">OTC</span>}</td>
                <td className={`px-1 font-bold ${dirCls(r.dir)}`}>{arrow(r.dir)} {r.dir === 'none' ? (r.lean !== 'none' ? `lean ${r.lean}` : '') : r.dir}{r.dir !== 'none' && r.validated && <span className="ml-1 text-[7px] text-emerald-300">✓</span>}{r.dir === 'call' && r.atResistance && <span className="ml-1 text-[7px] text-amber-300">res</span>}{r.dir === 'put' && r.atSupport && <span className="ml-1 text-[7px] text-amber-300">sup</span>}</td>
                <td className="px-1 text-right text-[#dbe4f0]">{r.strength}</td>
                <td className="px-1 text-right text-[#7c8aa5]">{(r.prob * 100).toFixed(0)}%</td>
                <td className="px-1 text-[#7c8aa5]">{r.alignment}</td>
                <td className="px-1 text-right text-[#7c8aa5]">{r.trackN > 0 ? `${(r.trackHit * 100).toFixed(0)}%/${r.trackN}` : '-'}</td>
                <td className="px-1 text-[#4b5a72]">{r.cause}</td>
              </tr>
            ))}
            {!rows.length && !busy && <tr><td colSpan={7} className="px-2 py-3 text-center text-[#4b5a72]">nothing matches</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="font-mono text-[8px] text-[#3d4d66]">✓ = the pair&apos;s own walk-forward hit rate beat chance on enough calls; over many pairs some pass by luck. res/sup = the call runs into a wall.</p>
    </div>
  )
}

export default PmPanel
