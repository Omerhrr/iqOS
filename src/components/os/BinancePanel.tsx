'use client'

// IQAIR//OS - Binance tab
// Real volume, delta and footprint for BTCUSD and ETHUSD from Binance's PUBLIC market data (no account, no key).
// IQ Option sends no volume for these two pairs, so a strategy can ask for it: an input named `dataSource`
// ("iq" | "volume" | "binance") picks IQ candles, IQ candles with Binance volume, or Binance's own candles, and
// binance.* reads give delta / footprint POC. Backed by /binance/health and /binance/bars (plugins/binancefeed.ts).
// This is Binance's market, merged by the minute - it is NOT IQ Option's own quote.

import { useCallback, useEffect, useState } from 'react'
import { getBinanceBars, getBinanceHealth, getBinanceLead, getBinanceNow, runBinanceLeadReport, runBinanceReplay, setBinanceRecorder } from '@/lib/os/client'
import type { BinanceBarsResult, BinanceBarView, BinanceHealthView, BinanceLeadPair, BinanceLeadReport, BinanceLeadResult, BinanceNowResult, BinanceReplayResult } from '@/lib/os/client'

const PAIRS = ['BTCUSD', 'ETHUSD'] as const
const TFS = ['1m', '5m', '15m', '1h'] as const
const STORAGE_KEY = 'iqos.binance.v1'

const fmtV = (v: number): string => (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4))
const ago = (s: number | null | undefined): string => (s == null ? '-' : s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`)
const hhmm = (t: number): string => new Date(t * 1000).toISOString().slice(11, 16)

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={`rounded border px-1.5 py-[1px] font-mono text-[9px] font-bold uppercase ${ok ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}`}>{children}</span>
  )
}

const VERDICT_STYLE: Record<string, string> = {
  candidate: 'border-emerald-500/50 text-emerald-300',
  inconclusive: 'border-amber-500/40 text-amber-300',
  negative: 'border-rose-500/40 text-rose-300',
  'too-few': 'border-[#2a3750] text-[#7c8aa5]',
  'no-trades': 'border-[#2a3750] text-[#7c8aa5]',
}

// Replays the Binance strategies over the minutes the recorder has saved and ranks them. Verdicts are deliberately strict.
function ReplayBoard({ pair, tf }: { pair: string; tf: string }) {
  const [payout, setPayout] = useState(85)
  const [exp, setExp] = useState('1,3')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<BinanceReplayResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const run = async () => {
    setBusy(true); setErr(null)
    try {
      const expiry = exp.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0)
      const r = await runBinanceReplay({ pair, tf, expiry: expiry.length ? expiry : [1, 3], payout: payout / 100, variants: true })
      if (!r.ok) setErr(r.error ?? 'replay failed')
      setRes(r.ok ? r : null)
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded border border-[#141d2e] bg-[#080d16] p-2">
      <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[9px]">
        <span className="font-bold text-[#aab6cc]">Replay tester</span>
        <span className="text-[#7c8aa5]">{pair} {tf}</span>
        <label className="text-[#7c8aa5]">payout % <input type="number" min={10} max={150} value={payout} onChange={(e) => setPayout(Number(e.target.value) || 85)} className="w-12 rounded border border-[#141d2e] bg-[#0b1220] px-1 text-[#aab6cc]" /></label>
        <label className="text-[#7c8aa5]">expiry bars <input value={exp} onChange={(e) => setExp(e.target.value)} className="w-14 rounded border border-[#141d2e] bg-[#0b1220] px-1 text-[#aab6cc]" /></label>
        <button type="button" disabled={busy} onClick={run} className="rounded border border-sky-500/40 px-2 py-0.5 font-bold text-sky-300 disabled:opacity-50">{busy ? 'Running...' : 'Run all Binance strategies'}</button>
      </div>
      {err && <div className="mb-1 font-mono text-[9px] text-rose-300">{err}</div>}
      {res && (
        <>
          <div className="mb-1 font-mono text-[9px] text-[#7c8aa5]">{res.runs} runs over {res.files} recorded day file(s). Breakeven win rate at this payout: {(res.breakeven * 100).toFixed(1)}%.</div>
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-[9px]">
              <thead className="text-left text-[#4b5a72]"><tr><th className="px-1">strategy</th><th className="px-1">variant</th><th className="px-1">exp</th><th className="px-1">trades</th><th className="px-1">win%</th><th className="px-1">95% range</th><th className="px-1">EV/$1</th><th className="px-1">last part</th><th className="px-1">verdict</th></tr></thead>
              <tbody>
                {res.rows.map((r, i) => (
                  <tr key={`${r.id}-${r.variant}-${r.expiryBars}-${i}`} className="border-t border-[#0e1624]" title={r.error ?? r.stats?.note ?? ''}>
                    <td className="px-1 py-0.5 text-[#aab6cc]">{r.label}</td>
                    <td className="px-1">{r.variant}</td>
                    <td className="px-1">{r.expiryBars}</td>
                    {r.stats ? (
                      <>
                        <td className="px-1">{r.stats.trades}</td>
                        <td className="px-1">{r.stats.winRate == null ? '-' : (r.stats.winRate * 100).toFixed(1)}</td>
                        <td className="px-1">{r.stats.ci ? `${(r.stats.ci.lo * 100).toFixed(0)}-${(r.stats.ci.hi * 100).toFixed(0)}` : '-'}</td>
                        <td className={`px-1 ${(r.stats.expectancy ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{r.stats.expectancy == null ? '-' : r.stats.expectancy.toFixed(3)}</td>
                        <td className="px-1">{r.stats.oos ? `${r.stats.oos.trades}t ${r.stats.oos.winRate == null ? '-' : (r.stats.oos.winRate * 100).toFixed(0) + '%'}` : '-'}</td>
                        <td className="px-1"><span className={`rounded border px-1 py-[1px] uppercase ${VERDICT_STYLE[r.stats.verdict] ?? ''}`}>{r.stats.verdict}</span></td>
                      </>
                    ) : (
                      <td className="px-1 text-[#7c8aa5]" colSpan={6}>{r.error ?? 'no result'}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 font-mono text-[9px] leading-relaxed text-[#7c8aa5]">{res.note} Only &quot;candidate&quot; means the edge survives the number of variants tried and the later part of the data; it still needs fresh days. Hover a row for the reason.</p>
        </>
      )}
      {!res && !busy && <p className="font-mono text-[9px] text-[#7c8aa5]">Needs saved minutes: keep the recorder on for a few days (more days = fewer false winners).</p>}
    </div>
  )
}

function CurveSvg({ curve }: { curve: { lagMs: number; corr: number }[] }) {
  if (curve.length < 3) return null
  const w = 220, h = 44
  const xs = curve.map((c) => c.lagMs), minX = Math.min(...xs), maxX = Math.max(...xs)
  const maxC = Math.max(0.05, ...curve.map((c) => c.corr))
  const pts = curve.map((c) => `${(((c.lagMs - minX) / (maxX - minX || 1)) * w).toFixed(1)},${(h - (Math.max(0, c.corr) / maxC) * (h - 4) - 2).toFixed(1)}`).join(' ')
  const zeroX = ((0 - minX) / (maxX - minX || 1)) * w
  return (
    <svg width={w} height={h} className="rounded border border-[#141d2e] bg-[#0b1220]">
      <line x1={zeroX} x2={zeroX} y1={0} y2={h} stroke="#2a3750" strokeDasharray="2 2" />
      <polyline points={pts} fill="none" stroke="#38bdf8" strokeWidth={1.2} />
    </svg>
  )
}

// Who moves first, Binance or IQ Option? Live estimate every 30 s from both price streams, the live gap, and an analyzer over the recorded ticks.
function LeadCard({ pair }: { pair: string }) {
  const [live, setLive] = useState<BinanceLeadResult | null>(null)
  const [delay, setDelay] = useState(500)
  const [payout, setPayout] = useState(85)
  const [busy, setBusy] = useState(false)
  const [rep, setRep] = useState<BinanceLeadReport | null>(null)
  useEffect(() => {
    let off = false
    const load = async () => { try { const r = await getBinanceLead(); if (!off) setLive(r) } catch { /* keep the last view */ } }
    void load()
    const id = setInterval(load, 2000)
    return () => { off = true; clearInterval(id) }
  }, [])
  const p: BinanceLeadPair | undefined = live && live.ok ? live.pairs.find((x) => x.pair === pair) : undefined
  const analyze = async () => {
    setBusy(true)
    try { setRep(await runBinanceLeadReport({ pair, delayMs: delay, payout: payout / 100 })) } catch (e) { setRep({ ok: false, error: String(e instanceof Error ? e.message : e) }) } finally { setBusy(false) }
  }
  const leaderTxt = !p ? '-' : p.leader === 'binance' ? `Binance leads by ~${Math.round(p.lagMs)} ms` : p.leader === 'iq' ? `IQ leads by ~${Math.round(-p.lagMs)} ms` : 'no clear leader'
  return (
    <div className="rounded border border-[#141d2e] bg-[#080d16] p-2">
      <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[9px]">
        <span className="font-bold text-[#aab6cc]">Lead / lag: Binance vs IQ</span>
        <span className="text-[#7c8aa5]">{pair}</span>
        {live && live.ok && <Pill ok={live.iqLive}>{live.iqLive ? 'IQ live' : 'IQ not live'}</Pill>}
        {live && live.ok && <Pill ok={live.recording}>{live.recording ? 'recording ticks' : 'not recording'}</Pill>}
        {live && !live.ok && <span className="text-rose-300">{live.error}</span>}
      </div>
      {p && (
        <div className="grid gap-2 md:grid-cols-[1fr_auto]">
          <div className="font-mono text-[10px] text-[#aab6cc]">
            <div className="text-[12px] font-bold">{leaderTxt}</div>
            <div className="text-[#7c8aa5]">correlation {p.corr.toFixed(3)} over {p.n} steps; Binance led in {(p.stable * 100).toFixed(0)}% of the last {Math.min(20, p.history.length)} estimates</div>
            <div className="mt-1">live gap: <span className={`font-bold ${p.fresh ? (p.gapBps >= 0 ? 'text-emerald-300' : 'text-rose-300') : 'text-[#4b5a72]'}`}>{p.fresh ? `${p.gapBps >= 0 ? '+' : ''}${p.gapBps.toFixed(2)} bps` : 'stale'}</span> <span className="text-[#7c8aa5]">(+ = Binance above IQ, so IQ is expected to rise)</span></div>
            <div className="text-[#7c8aa5]">Binance tick {p.binAgeSec == null ? '-' : p.binAgeSec.toFixed(1)}s ago, IQ poll {p.iqPollAgeSec == null ? '-' : p.iqPollAgeSec.toFixed(1)}s ago, IQ changes/min {p.iqTicksPerMin}{p.recvLatencyMs != null ? `, Binance arrival delay ${p.recvLatencyMs} ms` : ''}</div>
            <div className="mt-0.5 text-[#7c8aa5]">{p.note}</div>
          </div>
          <div><CurveSvg curve={p.curve} /><div className="font-mono text-[8px] text-[#4b5a72]">correlation by lag (dashed = 0 ms; right of it = IQ follows Binance)</div></div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[#0e1624] pt-2 font-mono text-[9px]">
        <span className="font-bold text-[#aab6cc]">Test the gap on recorded ticks</span>
        <label className="text-[#7c8aa5]">order delay ms <input type="number" min={0} max={5000} value={delay} onChange={(e) => setDelay(Math.max(0, Number(e.target.value) || 0))} className="w-16 rounded border border-[#141d2e] bg-[#0b1220] px-1 text-[#aab6cc]" /></label>
        <label className="text-[#7c8aa5]">payout % <input type="number" min={10} max={150} value={payout} onChange={(e) => setPayout(Number(e.target.value) || 85)} className="w-12 rounded border border-[#141d2e] bg-[#0b1220] px-1 text-[#aab6cc]" /></label>
        <button type="button" disabled={busy} onClick={analyze} className="rounded border border-sky-500/40 px-2 py-0.5 font-bold text-sky-300 disabled:opacity-50">{busy ? 'Analyzing...' : 'Analyze recorded days'}</button>
      </div>
      {rep && !rep.ok && <div className="mt-1 font-mono text-[9px] text-rose-300">{rep.error}</div>}
      {rep && rep.ok && (
        <div className="mt-1 font-mono text-[9px] text-[#7c8aa5]">
          <div>{rep.files} day file(s), {(rep.spanSec / 3600).toFixed(1)} h of overlap. Overall: <span className="text-[#aab6cc]">{rep.overall.note}</span> (correlation {rep.overall.corr.toFixed(3)})</div>
          {rep.hours.length > 0 && <div className="mt-0.5">By hour (lag ms): {rep.hours.slice(-24).map((h) => `${new Date(h.from).toISOString().slice(11, 13)}h ${h.leader === 'binance' ? '' : h.leader === 'iq' ? '-' : '~'}${Math.round(Math.abs(h.lagMs))}`).join(' | ')}</div>}
          <div className="mt-1 overflow-x-auto">
            <table className="w-full">
              <thead className="text-left text-[#4b5a72]"><tr><th className="px-1">gap &ge; bps</th><th className="px-1">hold s</th><th className="px-1">trades</th><th className="px-1">win%</th><th className="px-1">95% range</th><th className="px-1">avg move bps</th><th className="px-1">EV/$1</th><th className="px-1">last 30%</th><th className="px-1">verdict</th></tr></thead>
              <tbody>
                {rep.edge.rows.map((r) => (
                  <tr key={`${r.thresholdBps}-${r.horizonSec}`} className="border-t border-[#0e1624]" title={r.note}>
                    <td className="px-1 text-[#aab6cc]">{r.thresholdBps}</td><td className="px-1">{r.horizonSec}</td><td className="px-1">{r.trades}</td>
                    <td className="px-1">{r.winRate == null ? '-' : (r.winRate * 100).toFixed(1)}</td>
                    <td className="px-1">{r.ci ? `${(r.ci.lo * 100).toFixed(0)}-${(r.ci.hi * 100).toFixed(0)}` : '-'}</td>
                    <td className="px-1">{r.avgMoveBps == null ? '-' : r.avgMoveBps.toFixed(2)}</td>
                    <td className={`px-1 ${(r.expectancy ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{r.expectancy == null ? '-' : r.expectancy.toFixed(3)}</td>
                    <td className="px-1">{r.oos ? `${r.oos.trades}t ${r.oos.winRate == null ? '-' : (r.oos.winRate * 100).toFixed(0) + '%'}` : '-'}</td>
                    <td className="px-1"><span className={`rounded border px-1 py-[1px] uppercase ${VERDICT_STYLE[r.verdict] ?? ''}`}>{r.verdict}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 leading-relaxed">{rep.edge.note}. Breakeven win rate {(rep.edge.breakeven * 100).toFixed(1)}%. Set the order delay to what your bot really takes to land an order on IQ: a lag edge that exists at 0 ms often vanishes at 1-2 s. Only &quot;candidate&quot; survives the number of settings tried and the later part of the data.</p>
        </div>
      )}
      {!rep && <p className="mt-1 font-mono text-[9px] text-[#7c8aa5]">Needs the live IQ session and the recorder on for a while (hours, ideally days). The strategy &quot;Binance leads IQ gap&quot; uses binance.gap() / binance.leadOk() live.</p>}
    </div>
  )
}

function Ladder({ rows }: { rows: { price: number; buy: number; sell: number }[] }) {
  const sorted = [...rows].sort((a, b) => b.price - a.price)
  const max = Math.max(1e-9, ...sorted.map((r) => Math.max(r.buy, r.sell)))
  const poc = sorted.reduce((best, r) => (r.buy + r.sell > best.v ? { p: r.price, v: r.buy + r.sell } : best), { p: NaN, v: -1 }).p
  return (
    <div className="max-h-[260px] overflow-y-auto rounded border border-[#141d2e] bg-[#080d16] p-1">
      <div className="mb-0.5 grid grid-cols-[1fr_64px_1fr] gap-1 font-mono text-[8px] uppercase text-[#4b5a72]">
        <span className="text-right text-rose-300">sell (hit bid)</span>
        <span className="text-center">price</span>
        <span className="text-emerald-300">buy (lift ask)</span>
      </div>
      {sorted.map((r) => (
        <div key={r.price} className="grid grid-cols-[1fr_64px_1fr] items-center gap-1 font-mono text-[9px]">
          <div className="flex items-center justify-end gap-1">
            <span className="text-[#7c8aa5]">{fmtV(r.sell)}</span>
            <div className="h-[7px] rounded-l bg-rose-500/70" style={{ width: `${(r.sell / max) * 100}%` }} />
          </div>
          <span className={`text-center ${r.price === poc ? 'font-bold text-amber-300' : 'text-[#aab6cc]'}`}>{r.price}</span>
          <div className="flex items-center gap-1">
            <div className="h-[7px] rounded-r bg-emerald-500/70" style={{ width: `${(r.buy / max) * 100}%` }} />
            <span className="text-[#7c8aa5]">{fmtV(r.buy)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function BinancePanel() {
  const [health, setHealth] = useState<BinanceHealthView | null>(null)
  const [pair, setPair] = useState<(typeof PAIRS)[number]>('BTCUSD')
  const [tf, setTf] = useState<(typeof TFS)[number]>('1m')
  const [bars, setBars] = useState<BinanceBarsResult | null>(null)
  const [now, setNow] = useState<BinanceNowResult | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      if (PAIRS.includes(s.pair)) setPair(s.pair)
      if (TFS.includes(s.tf)) setTf(s.tf)
    } catch {
      /* no storage */
    }
  }, [])
  const remember = (p: string, t: string) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ pair: p, tf: t }))
    } catch {
      /* no storage */
    }
  }

  const load = useCallback(async () => {
    try {
      const h = await getBinanceHealth()
      setHealth(h)
      const b = await getBinanceBars(pair, tf, 30)
      setBars(b)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [pair, tf])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), 5000)
    return () => clearInterval(id)
  }, [load])

  // the bar still forming: refreshed every second (cheap: it is read from memory on the kernel)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const n = await getBinanceNow(pair, tf)
        if (alive) setNow(n)
      } catch {
        if (alive) setNow(null)
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 1000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [pair, tf])

  const last: BinanceBarView | undefined = bars && bars.ok ? bars.bars[bars.bars.length - 1] : undefined
  const rows = bars && bars.ok ? [...bars.bars].reverse() : []

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2 text-[#dbe4f0]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] font-bold uppercase tracking-wider">Binance data</span>
        {health && health.ok ? (
          <>
            <Pill ok={health.connected && !health.stale}>{health.connected ? (health.stale ? 'stale' : 'live') : 'offline'}</Pill>
            <span className="font-mono text-[9px] text-[#7c8aa5]">last message {ago(health.lastMessageAgoSec)} · reconnects {health.reconnects}</span>
            <button
              type="button"
              onClick={async () => {
                try {
                  await setBinanceRecorder(!health.recorder.on)
                  void load()
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e))
                }
              }}
              className={`ml-auto rounded border px-2 py-[2px] font-mono text-[9px] uppercase ${health.recorder.on ? 'border-emerald-500/40 text-emerald-300' : 'border-[#2a3750] text-[#7c8aa5]'}`}
              title={`records every closed minute (candle, volume, footprint, IQ candle) to ${health.recorder.dir}`}
            >
              recorder {health.recorder.on ? `on · ${health.recorder.written} min · ${health.recorder.snapshots ?? 0} snaps` : 'off'}
            </button>
          </>
        ) : (
          <Pill ok={false}>feed not running</Pill>
        )}
      </div>
      {health && health.ok && health.lastError && <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 font-mono text-[9px] text-amber-300">{health.lastError}</div>}
      {err && <div className="rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1 font-mono text-[9px] text-rose-300">{err}</div>}

      {health && health.ok && (
        <div className="grid grid-cols-2 gap-1">
          {health.symbols.map((s) => (
            <div key={s.symbol} className="rounded border border-[#141d2e] bg-[#080d16] px-2 py-1 font-mono text-[9px] text-[#7c8aa5]">
              <span className="font-bold text-[#dbe4f0]">{s.pair}</span> → {s.symbol} · {s.minutesHeld} min held · newest {ago(s.lastClosedAgoSec)} · trade ladder on {s.footMinutes} min · last trade {ago(s.lastTradeAgoSec)}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1">
        {PAIRS.map((p) => (
          <button key={p} type="button" onClick={() => { setPair(p); remember(p, tf) }} className={`rounded border px-2 py-[2px] font-mono text-[10px] ${p === pair ? 'border-sky-500/50 bg-sky-500/10 text-sky-300' : 'border-[#2a3750] text-[#7c8aa5]'}`}>
            {p}
          </button>
        ))}
        <span className="mx-1 text-[#2a3750]">|</span>
        {TFS.map((t) => (
          <button key={t} type="button" onClick={() => { setTf(t); remember(pair, t) }} className={`rounded border px-2 py-[2px] font-mono text-[10px] ${t === tf ? 'border-sky-500/50 bg-sky-500/10 text-sky-300' : 'border-[#2a3750] text-[#7c8aa5]'}`}>
            {t}
          </button>
        ))}
      </div>

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
            ) : (
              <span>no fresh data</span>
            )}
          </div>
          {now.bar && (
            <div className="grid gap-2 md:grid-cols-[1fr_1fr]">
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                <span>open {now.bar.open}</span><span>last {now.bar.close}</span>
                <span>high {now.bar.high}</span><span>low {now.bar.low}</span>
                <span>volume {fmtV(now.bar.volume)}</span><span>trades {now.bar.trades}</span>
                <span className="text-emerald-300">buy {fmtV(now.bar.buyVolume)}</span><span className="text-rose-300">sell {fmtV(now.bar.sellVolume)}</span>
                <span className={now.bar.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}>delta {fmtV(now.bar.delta)}</span>
                <span className={now.bar.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}>delta% {(now.bar.deltaPct * 100).toFixed(1)}</span>
                <span>POC {now.bar.poc ?? '-'}</span>
                <span>{now.bar.footShare >= 0.999 ? 'delta: true aggressor' : now.bar.footShare > 0 ? `delta: partly true (${Math.round(now.bar.footShare * 100)}%)` : 'delta: kline taker split'}</span>
              </div>
              <div>{now.bar.ladder.length ? <Ladder rows={now.bar.ladder} /> : <div className="rounded border border-[#141d2e] bg-[#080d16] p-2 text-[9px] text-[#7c8aa5]">No complete trade ladder for this bar yet.</div>}</div>
            </div>
          )}
        </div>
      )}

      {bars && !bars.ok && <div className="font-mono text-[10px] text-[#7c8aa5]">{bars.error}</div>}
      {bars && bars.ok && !last && <div className="font-mono text-[10px] text-[#7c8aa5]">No closed {tf} bar yet: the feed backfills about 16 hours of minutes when it connects.</div>}

      {last && (
        <div className="grid gap-2 md:grid-cols-[1fr_1fr]">
          <div className="rounded border border-[#141d2e] bg-[#080d16] p-2 font-mono text-[10px]">
            <div className="mb-1 text-[#7c8aa5]">Latest closed {tf} bar · {hhmm(last.time)} UTC</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              <span>open {last.open}</span><span>close {last.close}</span>
              <span>high {last.high}</span><span>low {last.low}</span>
              <span>volume {fmtV(last.volume)}</span><span>trades {last.trades}</span>
              <span className="text-emerald-300">buy {fmtV(last.buyVolume)}</span><span className="text-rose-300">sell {fmtV(last.sellVolume)}</span>
              <span className={last.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}>delta {fmtV(last.delta)}</span>
              <span className={last.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}>delta% {(last.deltaPct * 100).toFixed(1)}</span>
              <span>POC {last.poc ?? '-'}</span>
              <span title="share of the bar's minutes whose delta comes from real aggressor-tagged trades; otherwise the kline taker split is used">{last.footShare >= 0.999 ? 'delta: true aggressor' : last.footShare > 0 ? `delta: partly true (${Math.round(last.footShare * 100)}%)` : 'delta: kline taker split'}</span>
            </div>
          </div>
          <div>{last.ladder && last.ladder.length ? <Ladder rows={last.ladder} /> : <div className="rounded border border-[#141d2e] bg-[#080d16] p-2 font-mono text-[9px] text-[#7c8aa5]">{tf === '1m' ? 'No trade ladder for this minute (the feed was not connected for all of it).' : 'The footprint ladder is shown on the 1m view.'}</div>}</div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded border border-[#141d2e] bg-[#080d16]">
          <table className="w-full font-mono text-[9px]">
            <thead className="text-left text-[#4b5a72]">
              <tr><th className="px-1.5 py-0.5">UTC</th><th className="px-1.5">close</th><th className="px-1.5">volume</th><th className="px-1.5">buy</th><th className="px-1.5">sell</th><th className="px-1.5">delta</th><th className="px-1.5">POC</th><th className="px-1.5">src</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.time} className="border-t border-[#0e1624]">
                  <td className="px-1.5 py-0.5 text-[#aab6cc]">{hhmm(r.time)}</td>
                  <td className="px-1.5">{r.close}</td>
                  <td className="px-1.5">{fmtV(r.volume)}</td>
                  <td className="px-1.5 text-emerald-300">{fmtV(r.buyVolume)}</td>
                  <td className="px-1.5 text-rose-300">{fmtV(r.sellVolume)}</td>
                  <td className={`px-1.5 ${r.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{fmtV(r.delta)}</td>
                  <td className="px-1.5">{r.poc ?? '-'}</td>
                  <td className="px-1.5 text-[#7c8aa5]">{r.footShare >= 0.999 ? 'trades' : r.footShare > 0 ? 'mixed' : 'taker'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <LeadCard pair={pair} />

      <ReplayBoard pair={pair} tf={tf} />

      <div className="rounded border border-[#141d2e] bg-[#080d16] p-2 font-mono text-[9px] leading-relaxed text-[#7c8aa5]">
        <div className="mb-1 font-bold text-[#aab6cc]">Use it in a strategy</div>
        <pre className="whitespace-pre-wrap text-[#aab6cc]">{`input dataSource = "volume" options "iq", "volume", "binance" "Data source"\n# iq      = IQ candles as they are (no volume on BTCUSD / ETHUSD)\n# volume  = IQ candles (price, entry, settlement) + Binance volume merged by the minute\n# binance = Binance's own candles, the trade is still placed on IQ Option\n# closed bars: binance.volume() binance.delta() binance.deltaPct() binance.cumDelta(10) binance.poc() binance.real()\n# forming bar (live only): binance.live() binance.age() binance.nowVolume() binance.nowDelta() binance.nowDeltaPct() binance.nowPoc()\n# Binance vs IQ (live only): binance.gap() (bps, + = Binance above IQ) binance.leadMs() binance.leadCorr() binance.leadStable() binance.leadOk()`}</pre>
        <p className="mt-1">Works for BTCUSD and ETHUSD only (not OTC). A bar the feed does not hold completely reads as no data (volume 0), never invented. Binance is a different market from IQ Option&apos;s quote: backtest on both before trusting a signal built on it.</p>
      </div>
    </div>
  )
}
