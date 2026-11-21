'use client'

// IQAIR//OS - FINDER tab. Two sub-tabs, OPTION and CFD, each with its own trade ticket and a "find trade" button. The button scans every open pair (backend GET /find_trade, analytics/finder.ts): it tells the story of
// several timeframes (pm + nm + weather + market structure + trend maturity + session), and offers ONE trade only when the timeframes agree, nothing blocks it and the score clears the bar - otherwise it says so.
// OPTION gives a side and an expiry (1-30 min, chosen from nm's similar past moments); CFD gives entry, stop and target. Nothing is ever placed automatically: the result loads the ticket, you press its button.
// HONESTY: this stacks models that read the same candles and the weights are judgement; no setup is "almost never wrong". The card shows the measured pm / nm records so the evidence can be judged.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AccountState, AssetRow, Position } from '@/lib/os/client'
import { fmtPrice, osGet } from '@/lib/os/client'
import TradeTicket, { type TicketPrefill } from './TradeTicket'

type Mode = 'option' | 'cfd'
interface FrameRead { tf: string; dir: 'call' | 'put' | 'none'; strength: number; pmRecord: string; nmRecord: string; structure: string; regime: string }
interface Found {
  asset: string; otc: boolean; mode: Mode; side: 'call' | 'put' | 'none'; score: number; grade: 'A' | 'B' | 'C' | ''; tf: string; barLeftSec: number
  frames: FrameRead[]; agree: number; against: number; story: string[]; reasons: string[]; rejected: string[]; session: string; text: string
  expiry: { minutes: number; bars: number; tf: string; prob: number; basis: string; table: Array<{ minutes: number; prob: number }> } | null
  cfd: { entry: number; stop: number; target: number; rr: number; ev: number; riskAtr: number; rewardAtr: number; tpPct: number; slPct: number; stopKind: string; targetKind: string; text: string } | null
}
interface FindRes { ok: boolean; error?: string; mode: Mode; minScore: number; found: boolean; best: Found | null; runnersUp: Found[]; closest: Array<{ asset: string; side: string; score: number; why: string[] }>; scanned: number; screened: number; read: number; ms: number; note: string }

const DIGITAL_SECS = [300, 900, 1800]
const sideCls = (s: string) => (s === 'call' ? 'text-emerald-300' : s === 'put' ? 'text-rose-300' : 'text-[#7c8aa5]')
const btn = (on: boolean) => `rounded border px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider ${on ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300' : 'border-[#1c2739] text-[#4b5a72] hover:text-[#dbe4f0]'}`

interface Props { assets: AssetRow[]; prices: Record<string, { price: number; dir: number }>; closedTick?: number; onSelectAsset?: (a: string) => void; onPlaced: (p: Position) => void; onError: (m: string) => void }

export default function FinderTab({ assets, prices, onSelectAsset, onPlaced, onError }: Props) {
  const [mode, setMode] = useState<Mode>('option')
  const [minScore, setMinScore] = useState(60)
  const [scope, setScope] = useState<'all' | 'real' | 'otc'>('all')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<Record<Mode, FindRes | null>>({ option: null, cfd: null })
  const [pick, setPick] = useState<Record<Mode, Found | null>>({ option: null, cfd: null })
  const [prefill, setPrefill] = useState<Record<Mode, TicketPrefill | null>>({ option: null, cfd: null })
  const [err, setErr] = useState<string | null>(null)
  const [account, setAccount] = useState<AccountState | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let on = true
    const load = () => osGet<AccountState>('/account').then((a) => { if (on) setAccount(a) }).catch(() => {})
    load(); const t = setInterval(load, 10000)
    return () => { on = false; clearInterval(t) }
  }, [])

  const toPrefill = useCallback((f: Found, m: Mode): TicketPrefill | null => {
    if (f.side === 'none') return null
    if (m === 'cfd' && f.cfd) return { nonce: Date.now(), kind: 'cfd', side: f.side, tpPct: Number(f.cfd.tpPct.toFixed(3)), slPct: Number(f.cfd.slPct.toFixed(3)), source: `Finder ${f.grade} · ${f.asset}` }
    if (m === 'option' && f.expiry) {
      const min = f.expiry.minutes
      if (min <= 5) return { nonce: Date.now(), kind: 'binary', side: f.side, expiryBars: min, source: `Finder ${f.grade} · ${f.asset} · ${min} min` }
      const sec = DIGITAL_SECS.reduce((b, v) => (Math.abs(v - min * 60) < Math.abs(b - min * 60) ? v : b))
      return { nonce: Date.now(), kind: 'digital', side: f.side, digitalExpirySec: sec, source: `Finder ${f.grade} · ${f.asset} · ${min} min (digital ${sec / 60}m)` }
    }
    return null
  }, [])

  const find = useCallback(async (skip?: string) => {
    setBusy(true); setErr(null)
    const m = mode
    try {
      const r = await osGet<FindRes>('/find_trade', { mode: m, minScore, scope, exclude: skip })
      if (!alive.current) return
      if (!r.ok) { setErr(r.error ?? 'scan failed'); return }
      setRes((p) => ({ ...p, [m]: r }))
      setPick((p) => ({ ...p, [m]: r.best }))
      setPrefill((p) => ({ ...p, [m]: r.best ? toPrefill(r.best, m) : null }))
      if (r.best) onSelectAsset?.(r.best.asset)
    } catch (e) { setErr((e as Error).message.slice(0, 180)) } finally { if (alive.current) setBusy(false) }
  }, [mode, minScore, scope, toPrefill, onSelectAsset])

  const r = res[mode], cur = pick[mode]
  const row = useMemo(() => assets.find((a) => a.ticker === (cur?.asset ?? assets[0]?.ticker)), [assets, cur])
  const price = prices[row?.ticker ?? '']?.price ?? (cfdPrice(cur) || row?.price || 0)
  function cfdPrice(f: Found | null): number { return f?.cfd?.entry ?? 0 }
  const choose = (f: Found) => { setPick((p) => ({ ...p, [mode]: f })); setPrefill((p) => ({ ...p, [mode]: toPrefill(f, mode) })); onSelectAsset?.(f.asset) }

  return (
    <div className="flex h-full min-h-0 flex-col font-mono">
      <div className="flex items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <button type="button" className={btn(mode === 'option')} onClick={() => setMode('option')}>option</button>
        <button type="button" className={btn(mode === 'cfd')} onClick={() => setMode('cfd')}>cfd</button>
        <span className="mx-1 h-4 w-px bg-[#1c2739]" />
        <button type="button" disabled={busy} onClick={() => void find()} className="rounded border border-emerald-500/50 bg-emerald-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">{busy ? 'scanning the market...' : 'find trade'}</button>
        {cur && <button type="button" disabled={busy} onClick={() => void find(cur.asset)} className="rounded border border-[#1c2739] px-2 py-1 text-[9px] uppercase text-[#7c8aa5] hover:text-sky-300 disabled:opacity-50" title="scan again without this pair">find another (skip {cur.asset})</button>}
        <span className="ml-auto flex items-center gap-1 text-[9px] text-[#4b5a72]">
          bar
          <select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="rounded border border-[#1c2739] bg-[#0b111c] px-1 py-px text-[#aab6cc]">{[55, 60, 65, 70, 80].map((v) => <option key={v} value={v}>score ≥ {v}</option>)}</select>
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className="rounded border border-[#1c2739] bg-[#0b111c] px-1 py-px text-[#aab6cc]"><option value="all">all pairs</option><option value="real">real</option><option value="otc">OTC</option></select>
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto p-2">
          {err && <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[9px] text-amber-300">{err}</div>}
          {!r && !busy && <p className="text-[10px] text-[#4b5a72]">Press <span className="text-emerald-300">find trade</span>: it reads every open pair across 30s to 30m (pm, nm, weather, structure, trend maturity, session) and offers one trade, or tells you nothing is worth taking.</p>}
          {r && !r.found && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
              <div className="text-[11px] font-bold uppercase tracking-wider text-amber-300">no trade worth taking right now</div>
              <p className="mt-1 text-[9px] leading-relaxed text-[#7c8aa5]">{r.note}</p>
              {r.closest.length > 0 && <div className="mt-2 text-[9px] text-[#7c8aa5]">closest:{r.closest.map((c) => <div key={c.asset} className="mt-0.5"><span className={`font-bold ${sideCls(c.side)}`}>{c.asset} {c.side}</span> score {c.score} - {c.why.join('; ')}</div>)}</div>}
              <p className="mt-2 text-[8px] text-[#3d4d66]">scanned {r.scanned} pairs · {r.screened} passed the pm screen · {r.read} read in full · {(r.ms / 1000).toFixed(1)}s</p>
            </div>
          )}
          {cur && r?.found && (
            <div className="space-y-2">
              <div className={`rounded-lg border px-2.5 py-2 ${cur.side === 'call' ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-rose-500/40 bg-rose-500/10'}`}>
                <div className="flex items-center gap-2">
                  <span className={`text-lg font-bold leading-none ${sideCls(cur.side)}`}>{cur.side === 'call' ? '▲' : '▼'}</span>
                  <div className="flex flex-col">
                    <span className={`text-[13px] font-bold uppercase tracking-wider ${sideCls(cur.side)}`}>{mode === 'cfd' ? (cur.side === 'call' ? 'long' : 'short') : cur.side} · {cur.asset}{cur.otc ? ' (OTC)' : ''}</span>
                    <span className="text-[9px] text-[#7c8aa5]">{cur.agree} timeframes agree, none against · read on {cur.tf} · {cur.session}</span>
                  </div>
                  <div className="ml-auto flex flex-col items-center"><span className="text-xl font-bold leading-none text-[#dbe4f0]">{cur.score}</span><span className="text-[8px] uppercase tracking-wider text-[#4b5a72]">grade {cur.grade}</span></div>
                </div>
                {mode === 'option' && cur.expiry && (
                  <div className="mt-2 rounded border border-[#1c2739] bg-[#0b111c] p-2">
                    <div className="flex items-baseline gap-2"><span className="text-[9px] uppercase text-[#4b5a72]">expiry</span><span className="text-lg font-bold text-cyan-300">{cur.expiry.minutes} min</span><span className="text-[9px] text-[#7c8aa5]">{cur.expiry.basis}</span></div>
                    <div className="mt-1 flex flex-wrap gap-1">{cur.expiry.table.map((t) => <span key={t.minutes} className={`rounded border px-1 text-[8px] ${t.minutes === cur.expiry!.minutes ? 'border-cyan-500/50 text-cyan-300' : 'border-[#1c2739] text-[#4b5a72]'}`}>{t.minutes}m {(t.prob * 100).toFixed(0)}%</span>)}</div>
                    <p className="mt-1 text-[8px] text-[#3d4d66]">the ticket snaps this to the durations the broker accepts (binary 1/5 min, digital 5/15/30 min)</p>
                  </div>
                )}
                {mode === 'cfd' && cur.cfd && (
                  <div className="mt-2 grid grid-cols-3 gap-1.5 rounded border border-[#1c2739] bg-[#0b111c] p-2 text-center">
                    <div><div className="text-[8px] uppercase text-[#4b5a72]">entry</div><div className="text-[11px] font-bold text-[#dbe4f0]">{fmtPrice(cur.cfd.entry, cur.asset)}</div></div>
                    <div><div className="text-[8px] uppercase text-[#4b5a72]">stop loss</div><div className="text-[11px] font-bold text-rose-300">{fmtPrice(cur.cfd.stop, cur.asset)}</div><div className="text-[8px] text-[#4b5a72]">{cur.cfd.slPct.toFixed(2)}% · {cur.cfd.stopKind}</div></div>
                    <div><div className="text-[8px] uppercase text-[#4b5a72]">take profit</div><div className="text-[11px] font-bold text-emerald-300">{fmtPrice(cur.cfd.target, cur.asset)}</div><div className="text-[8px] text-[#4b5a72]">{cur.cfd.tpPct.toFixed(2)}% · {cur.cfd.targetKind}</div></div>
                    <div className="col-span-3 text-[9px] text-[#7c8aa5]">reward:risk {cur.cfd.rr.toFixed(2)} · expected {cur.cfd.ev.toFixed(2)}R if the probability holds · risk {cur.cfd.riskAtr.toFixed(2)} ATR</div>
                  </div>
                )}
              </div>
              <div className="rounded border border-[#1c2739] bg-[#0b111c] p-2">
                <div className="mb-1 text-[8px] uppercase tracking-wider text-[#4b5a72]">the story</div>
                {cur.story.map((l, i) => <p key={i} className="text-[9px] leading-relaxed text-[#7c8aa5]">{l}</p>)}
                <div className="mt-1.5 flex flex-wrap gap-1">{cur.frames.map((f) => <span key={f.tf} className={`rounded border border-[#1c2739] px-1 text-[8px] ${sideCls(f.dir)}`} title={`pm ${f.pmRecord} · nm ${f.nmRecord} · ${f.structure} · ${f.regime}`}>{f.tf} {f.dir === 'none' ? '-' : f.dir === 'call' ? '▲' : '▼'}{f.strength}</span>)}</div>
              </div>
              {r.runnersUp.length > 0 && (
                <div className="rounded border border-[#1c2739] p-2"><div className="mb-1 text-[8px] uppercase tracking-wider text-[#4b5a72]">runners-up</div>
                  {r.runnersUp.map((f) => <button key={f.asset} type="button" onClick={() => choose(f)} className="mr-1 rounded border border-[#1c2739] px-1.5 py-0.5 text-[9px] text-[#7c8aa5] hover:text-sky-300"><span className={`font-bold ${sideCls(f.side)}`}>{f.asset} {f.side}</span> {f.score}</button>)}
                </div>
              )}
              <p className="text-[8px] leading-relaxed text-[#3d4d66]">scanned {r.scanned} pairs · {r.screened} passed the pm screen · {r.read} read in full · {(r.ms / 1000).toFixed(1)}s. Models read the same candles and the score weights are judgement: a high score is agreement, not a guarantee. Nothing is placed automatically.</p>
            </div>
          )}
        </div>
        <div className="flex w-[290px] shrink-0 flex-col gap-1.5 overflow-auto border-l border-[#1c2739] p-2">
          <div className="rounded border border-cyan-500/30 bg-cyan-500/5 px-2 py-1 text-[9px] text-[#7c8aa5]">{mode === 'cfd' ? 'CFD ticket' : 'Option ticket'}{cur ? <> · <span className="font-bold text-cyan-300">{cur.asset}</span></> : ' · find a trade to load it'}</div>
          <TradeTicket key={mode} asset={row} tf="1m" price={price} account={account} prefill={prefill[mode]} kinds={mode === 'cfd' ? ['cfd'] : ['binary', 'turbo', 'blitz', 'digital']} onPlaced={onPlaced} onError={onError} />
        </div>
      </div>
    </div>
  )
}
