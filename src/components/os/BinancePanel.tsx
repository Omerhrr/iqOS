'use client'

// IQAIR//OS - Binance tab
// Real volume, delta and footprint for BTCUSD and ETHUSD from Binance's PUBLIC market data (no account, no key).
// IQ Option sends no volume for these two pairs, so a strategy can ask for it: an input named `dataSource`
// ("iq" | "volume" | "binance") picks IQ candles, IQ candles with Binance volume, or Binance's own candles, and
// binance.* reads give delta / footprint POC. Backed by /binance/health and /binance/bars (plugins/binancefeed.ts).
// This is Binance's market, merged by the minute - it is NOT IQ Option's own quote.

import { useCallback, useEffect, useState } from 'react'
import { getBinanceBars, getBinanceHealth, setBinanceRecorder } from '@/lib/os/client'
import type { BinanceBarsResult, BinanceBarView, BinanceHealthView } from '@/lib/os/client'

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
              recorder {health.recorder.on ? `on · ${health.recorder.written} saved` : 'off'}
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

      <div className="rounded border border-[#141d2e] bg-[#080d16] p-2 font-mono text-[9px] leading-relaxed text-[#7c8aa5]">
        <div className="mb-1 font-bold text-[#aab6cc]">Use it in a strategy</div>
        <pre className="whitespace-pre-wrap text-[#aab6cc]">{`input dataSource = "volume" options "iq", "volume", "binance" "Data source"\n# iq      = IQ candles as they are (no volume on BTCUSD / ETHUSD)\n# volume  = IQ candles (price, entry, settlement) + Binance volume merged by the minute\n# binance = Binance's own candles, the trade is still placed on IQ Option\n# also: binance.volume() binance.delta() binance.deltaPct() binance.cumDelta(10) binance.poc() binance.real()`}</pre>
        <p className="mt-1">Works for BTCUSD and ETHUSD only (not OTC). A bar the feed does not hold completely reads as no data (volume 0), never invented. Binance is a different market from IQ Option&apos;s quote: backtest on both before trusting a signal built on it.</p>
      </div>
    </div>
  )
}
