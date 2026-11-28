'use client'

// IQAIR//OS - IQ Option tab
// The same view as the Binance tab, for ANY IQ Option pair, built from IQ's own quote changes. IQ sends quotes, not traded size, so there is no real volume:
// "ticks" = how many times the quote changed in the bar, up/down = changes up vs down (tick rule), delta = up - down, the ladder counts ticks per price level and
// POC is the busiest level. Backed by /iq/health, /iq/bars and /iq/now (plugins/otcfootprint.ts collects the quotes the sidecar samples every 100 ms).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getIqBars, getIqHealth, getIqNow } from '@/lib/os/client'
import type { AssetRow, IqBarsResult, IqHealthView, IqNowResult, IqTickBarView, IqLadderRow } from '@/lib/os/client'

const TFS = ['1m', '5m', '15m', '1h'] as const
const STORAGE_KEY = 'iqos.iqtab.v1'

const ago = (s: number | null | undefined): string => (s == null ? '-' : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`)
const hhmm = (t: number): string => new Date(t * 1000).toISOString().slice(11, 16)
const pct = (x: number): string => `${(x * 100).toFixed(1)}`

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={`rounded border px-1.5 py-[1px] font-mono text-[9px] font-bold uppercase ${ok ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}`}>{children}</span>
}

function TickLadder({ rows }: { rows: IqLadderRow[] }) {
  const sorted = [...rows].sort((a, b) => b.price - a.price)
  const max = Math.max(1e-9, ...sorted.map((r) => Math.max(r.up, r.down)))
  const poc = sorted.reduce((best, r) => (r.up + r.down > best.v ? { p: r.price, v: r.up + r.down } : best), { p: NaN, v: -1 }).p
  return (
    <div className="max-h-[260px] overflow-y-auto rounded border border-[#141d2e] bg-[#080d16] p-1">
      <div className="mb-0.5 grid grid-cols-[1fr_72px_1fr] gap-1 font-mono text-[8px] uppercase text-[#4b5a72]">
        <span className="text-right text-rose-300">down ticks</span>
        <span className="text-center">price</span>
        <span className="text-emerald-300">up ticks</span>
      </div>
      {sorted.map((r) => (
        <div key={r.price} className="grid grid-cols-[1fr_72px_1fr] items-center gap-1 font-mono text-[9px]">
          <div className="flex items-center justify-end gap-1"><span className="text-rose-300">{r.down || ''}</span><div className="h-[6px] rounded-l bg-rose-500/60" style={{ width: `${(r.down / max) * 100}%` }} /></div>
          <div className={`text-center ${r.price === poc ? 'font-bold text-amber-300' : 'text-[#aab6cc]'}`}>{r.price}</div>
          <div className="flex items-center gap-1"><div className="h-[6px] rounded-r bg-emerald-500/60" style={{ width: `${(r.up / max) * 100}%` }} /><span className="text-emerald-300">{r.up || ''}</span></div>
        </div>
      ))}
    </div>
  )
}

function Stats({ b }: { b: IqTickBarView }) {
  const col = b.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
      <span>open {b.open}</span><span>last {b.close}</span>
      <span>high {b.high}</span><span>low {b.low}</span>
      <span>ticks {b.ticks}</span><span>POC {b.poc ?? '-'}</span>
      <span className="text-emerald-300">up ticks {b.up}</span><span className="text-rose-300">down ticks {b.down}</span>
      <span className={col}>delta {b.delta > 0 ? '+' : ''}{b.delta}</span><span className={col}>delta% {pct(b.deltaPct)}</span>
      <span className="text-emerald-300">up move {Number(b.upMove.toPrecision(4))}</span><span className="text-rose-300">down move {Number(b.downMove.toPrecision(4))}</span>
      {b.iq && <span className="col-span-2 text-[#7c8aa5]">IQ candle: close {b.iq.close} · volume field {b.iq.volume}</span>}
    </div>
  )
}

export default function IqOptionPanel({ assets, initialAsset }: { assets: AssetRow[]; initialAsset?: string }) {
  const [asset, setAsset] = useState<string>(initialAsset || 'EURUSD')
  const [tf, setTf] = useState<(typeof TFS)[number]>('1m')
  const [filter, setFilter] = useState('')
  const [health, setHealth] = useState<IqHealthView | null>(null)
  const [bars, setBars] = useState<IqBarsResult | null>(null)
  const [now, setNow] = useState<IqNowResult | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) { const v = JSON.parse(raw) as { asset?: string; tf?: string }; if (v.asset) setAsset(v.asset); if (v.tf && (TFS as readonly string[]).includes(v.tf)) setTf(v.tf as (typeof TFS)[number]) }
    } catch { /* storage unavailable: defaults */ }
  }, [])
  const remember = (a: string, t: string) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ asset: a, tf: t })) } catch { /* ignore */ } }

  const matches = useMemo(() => {
    const f = filter.trim().toUpperCase()
    const list = assets.filter((a) => !f || a.ticker.toUpperCase().includes(f) || (a.name ?? '').toUpperCase().includes(f))
    return list.slice(0, 60)
  }, [assets, filter])

  const load = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      const [h, b] = await Promise.all([getIqHealth(asset), getIqBars(asset, tf, 30)])
      setHealth(h); setBars(b); setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [asset, tf])
  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), 10000)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    let alive = true
    const tick = async () => { if (typeof document !== 'undefined' && document.hidden) return; try { const n = await getIqNow(asset, tf); if (alive) setNow(n) } catch { if (alive) setNow(null) } }
    void tick()
    const id = setInterval(() => void tick(), 2000)
    return () => { alive = false; clearInterval(id) }
  }, [asset, tf])

  const last: IqTickBarView | undefined = bars && bars.ok ? bars.bars[bars.bars.length - 1] : undefined
  const rows = bars && bars.ok ? [...bars.bars].reverse() : []
  const info = assets.find((a) => a.ticker === asset)

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2 text-[#dbe4f0]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] font-bold uppercase tracking-wider">IQ Option data</span>
        {health && health.ok ? (
          <>
            <Pill ok={health.live && health.lastTickAgoSec !== null && health.lastTickAgoSec < 120}>{health.live ? (health.lastTickAgoSec !== null && health.lastTickAgoSec < 120 ? 'live' : 'quiet') : 'sim'}</Pill>
            <span className="font-mono text-[9px] text-[#7c8aa5]">{health.name} · {health.ticksHeld} ticks held · last tick {ago(health.lastTickAgoSec)} · {health.ticksPerMin}/min · watching since {ago(health.coverFromAgoSec)}{health.lostWindows ? ` · ${health.lostWindows} gap(s) in the samples` : ''}</span>
          </>
        ) : health && !health.ok ? (
          <span className="font-mono text-[9px] text-rose-300">{health.error}</span>
        ) : null}
      </div>
      {health && health.ok && !health.live && <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 font-mono text-[9px] text-amber-300">{health.source}</div>}
      {err && <div className="rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1 font-mono text-[9px] text-rose-300">{err}</div>}

      <div className="flex flex-wrap items-center gap-1">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="find a pair (EURUSD, gold, OTC...)" className="w-56 rounded border border-[#141d2e] bg-[#0b1220] px-2 py-[2px] font-mono text-[10px] text-[#aab6cc]" />
        {initialAsset && initialAsset !== asset && assets.some((a) => a.ticker === initialAsset) && (
          <button type="button" onClick={() => { setAsset(initialAsset); remember(initialAsset, tf) }} className="rounded border border-[#2a3750] px-2 py-[2px] font-mono text-[10px] text-[#7c8aa5]">chart pair: {initialAsset}</button>
        )}
        <span className="mx-1 text-[#2a3750]">|</span>
        {TFS.map((t) => (
          <button key={t} type="button" onClick={() => { setTf(t); remember(asset, t) }} className={`rounded border px-2 py-[2px] font-mono text-[10px] ${t === tf ? 'border-sky-500/50 bg-sky-500/10 text-sky-300' : 'border-[#2a3750] text-[#7c8aa5]'}`}>{t}</button>
        ))}
      </div>
      <div className="flex max-h-[64px] flex-wrap gap-1 overflow-y-auto">
        {matches.map((a) => (
          <button key={a.ticker} type="button" onClick={() => { setAsset(a.ticker); remember(a.ticker, tf) }} className={`rounded border px-1.5 py-[1px] font-mono text-[9px] ${a.ticker === asset ? 'border-sky-500/50 bg-sky-500/10 text-sky-300' : 'border-[#1c2740] text-[#7c8aa5]'} ${a.open === false ? 'opacity-50' : ''}`} title={`${a.name}${a.open === false ? ' (closed)' : ''}`}>{a.ticker}</button>
        ))}
        {!matches.length && <span className="font-mono text-[9px] text-[#7c8aa5]">no pair matches</span>}
      </div>
      <div className="font-mono text-[10px] text-[#aab6cc]">{asset}{info ? ` · ${info.name}${info.otc ? ' · OTC' : ''}${info.payout != null ? ` · payout ${(info.payout * 100).toFixed(0)}%` : ''}` : ''}</div>

      {now && now.ok && (
        <div className="rounded border border-sky-500/30 bg-sky-500/5 p-2 font-mono text-[10px]">
          <div className="mb-1 flex items-center gap-2 text-[#7c8aa5]">
            <Pill ok={now.fresh && !!now.bar}>forming {tf} bar</Pill>
            {now.bar ? (
              <>
                <span>{now.bar.ageSec}s of {now.bar.tfSec}s</span>
                <div className="h-[4px] w-28 overflow-hidden rounded bg-[#141d2e]"><div className="h-full bg-sky-400" style={{ width: `${Math.min(100, (now.bar.ageSec / now.bar.tfSec) * 100)}%` }} /></div>
                <span className="text-[9px]">still moving: every number below can change until the bar closes</span>
              </>
            ) : <span>no ticks in this bar yet</span>}
          </div>
          {now.bar && (
            <div className="grid gap-2 md:grid-cols-[1fr_1fr]">
              <Stats b={now.bar} />
              <div>{now.bar.ladder.length ? <TickLadder rows={now.bar.ladder} /> : <div className="rounded border border-[#141d2e] bg-[#080d16] p-2 text-[9px] text-[#7c8aa5]">No price changes in this bar yet.</div>}</div>
            </div>
          )}
        </div>
      )}

      {bars && !bars.ok && <div className="font-mono text-[10px] text-[#7c8aa5]">{bars.error}</div>}
      {bars && bars.ok && !last && <div className="font-mono text-[10px] text-[#7c8aa5]">No closed {tf} bar yet for {asset}. The tab starts collecting this pair's quotes when you open it; the first bars appear after a minute or so (live IQ session needed for real quotes).</div>}

      {last && (
        <div className="grid gap-2 md:grid-cols-[1fr_1fr]">
          <div className="rounded border border-[#141d2e] bg-[#080d16] p-2 font-mono text-[10px]">
            <div className="mb-1 text-[#7c8aa5]">Latest closed {tf} bar · {hhmm(last.time)} UTC{last.complete ? '' : ' · PARTIAL (collection started mid-bar or samples were lost)'}</div>
            <Stats b={last} />
          </div>
          <div>{last.ladder && last.ladder.length ? <TickLadder rows={last.ladder} /> : <div className="rounded border border-[#141d2e] bg-[#080d16] p-2 font-mono text-[9px] text-[#7c8aa5]">No price changes in this bar.</div>}</div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded border border-[#141d2e] bg-[#080d16]">
          <table className="w-full font-mono text-[9px]">
            <thead className="text-left text-[#4b5a72]">
              <tr><th className="px-1.5 py-0.5">UTC</th><th className="px-1.5">close</th><th className="px-1.5">ticks</th><th className="px-1.5">up</th><th className="px-1.5">down</th><th className="px-1.5">delta</th><th className="px-1.5">delta%</th><th className="px-1.5">POC</th><th className="px-1.5">IQ vol</th><th className="px-1.5">data</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.time} className="border-t border-[#0e1624]">
                  <td className="px-1.5 py-0.5 text-[#aab6cc]">{hhmm(r.time)}</td>
                  <td className="px-1.5">{r.close}</td>
                  <td className="px-1.5">{r.ticks}</td>
                  <td className="px-1.5 text-emerald-300">{r.up}</td>
                  <td className="px-1.5 text-rose-300">{r.down}</td>
                  <td className={`px-1.5 ${r.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{r.delta > 0 ? '+' : ''}{r.delta}</td>
                  <td className={`px-1.5 ${r.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{pct(r.deltaPct)}</td>
                  <td className="px-1.5">{r.poc ?? '-'}</td>
                  <td className="px-1.5 text-[#7c8aa5]">{r.iq ? r.iq.volume : '-'}</td>
                  <td className="px-1.5 text-[#7c8aa5]">{r.complete ? 'full' : 'partial'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded border border-[#141d2e] bg-[#080d16] p-2 font-mono text-[9px] leading-relaxed text-[#7c8aa5]">
        <div className="mb-1 font-bold text-[#aab6cc]">What these numbers are</div>
        <p>IQ Option publishes quotes, not trades, so there is no traded volume here. <span className="text-[#aab6cc]">Ticks</span> count how often the quote changed in the bar, <span className="text-[#aab6cc]">up/down</span> split those changes by direction (tick rule), <span className="text-[#aab6cc]">delta</span> is up minus down, and the ladder counts ticks per price level with the busiest one as POC. The sidecar samples IQ every 100 ms and keeps price changes only, so bursts faster than that are merged. A bar is marked partial when the tab began collecting mid-bar or samples were lost. For BTCUSD and ETHUSD the Binance tab has real traded volume; compare the two before trusting a tick-based signal.</p>
      </div>
    </div>
  )
}
