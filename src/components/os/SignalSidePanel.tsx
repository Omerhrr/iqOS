'use client'

// IQAIR//OS - Signal panel (left-dock strip).
// The Signal tab's clock, as a compact panel that FOLLOWS the chart's pair: same
// /signal read (five Explainer readers + Effort Renko + regime), same BUY / SELL
// / WAIT clock, suggested expiry, readers, checks and reasons. No auto-pair
// switching and no trade ticket here (those stay in the Signal tab); "load into
// ticket" is not offered because nothing is placed from this panel.
// Descriptive, not a forecast.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExplainerLean, SignalRead, Timeframe } from '@/lib/os/client'
import { getSignal } from '@/lib/os/client'
import AssetPicker from './AssetPicker'
import SignalClock from './SignalClock'

interface SignalSidePanelProps {
  asset: string
  /** the chart's timeframe; used when the signal supports it, else the panel's own pick */
  tf?: string
  closedTick?: number
  /** every open ticker, for the pair picker */
  tickers: string[]
  /** picking a pair here moves the app's main pair (chart, other panels); the chart's own picker moves this panel */
  onSelectAsset: (a: string) => void
  onClose: () => void
}

const TFS: Timeframe[] = ['30s', '1m', '2m', '5m', '15m', '30m', '1h']
const POLL_MS = 8_000

const leanChip = (lean: ExplainerLean, ok: boolean) => {
  if (!ok) return { text: 'n/a', cls: 'border-[#1c2739] text-[#4b5a72]' }
  if (lean === 'call') return { text: '▲ CALL', cls: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' }
  if (lean === 'put') return { text: '▼ PUT', cls: 'border-rose-500/50 bg-rose-500/10 text-rose-300' }
  return { text: '— flat', cls: 'border-[#3d4d66] text-[#7c8aa5]' }
}

const actionTone = (a: 'buy' | 'sell' | 'wait') =>
  a === 'buy'
    ? { text: 'text-emerald-300', border: 'border-emerald-500/40', bg: 'bg-emerald-500/10', label: 'BUY' }
    : a === 'sell'
      ? { text: 'text-rose-300', border: 'border-rose-500/40', bg: 'bg-rose-500/10', label: 'SELL' }
      : { text: 'text-amber-300', border: 'border-amber-500/40', bg: 'bg-amber-500/10', label: 'WAIT' }

const REGIME_LABEL: Record<string, string> = { 'trend-up': 'trending up', 'trend-down': 'trending down', ranging: 'ranging', noise: 'noise', unreadable: 'not readable' }

export default function SignalSidePanel({ asset, tf: chartTf, closedTick, tickers, onSelectAsset, onClose }: SignalSidePanelProps) {
  const supported = (t?: string): t is Timeframe => !!t && (TFS as string[]).includes(t)
  const [tf, setTf] = useState<Timeframe>(supported(chartTf) ? chartTf : '1m')
  const [read, setRead] = useState<SignalRead | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const live = useRef({ asset, tf })
  live.current = { asset, tf }

  // follow the chart's timeframe whenever it changes to one the signal supports
  useEffect(() => {
    if (supported(chartTf)) setTf(chartTf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartTf])

  const load = useCallback(async () => {
    const want = { asset: live.current.asset, tf: live.current.tf }
    try {
      const d = await getSignal(want.asset, want.tf)
      if (live.current.asset !== want.asset || live.current.tf !== want.tf) return
      if (d.ok) {
        setRead(d)
        setErr(null)
      } else {
        setRead(null)
        setErr(d.error)
      }
    } catch (e) {
      setErr((e as Error).message.slice(0, 160))
    } finally {
      setLoading(false)
    }
  }, [])

  // pair / tf change: drop the old read so one pair's call is never shown under another's name
  useEffect(() => {
    setRead(null)
    setErr(null)
    setLoading(true)
    void load()
  }, [asset, tf, load])
  useEffect(() => {
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => {
    if (closedTick !== undefined) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedTick])

  const sig = read?.signal
  const tone = actionTone(sig?.action ?? 'wait')

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Signal</span>
        <AssetPicker tickers={tickers} value={asset} onChange={onSelectAsset} className="w-32" />
        <div className="flex overflow-hidden rounded border border-[#1c2739]" role="group" aria-label="timeframe">
          {TFS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTf(t)}
              className={`px-1.5 py-0.5 font-mono text-[9px] uppercase ${tf === t ? 'bg-cyan-500/15 text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'}`}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300"
        >
          close
        </button>
      </div>

      {err && !sig && <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-[9px] text-amber-300">{err}</div>}

      <div className={`rounded-lg border ${tone.border}`}>
        <div className={`flex items-center gap-1.5 border-b border-[#1c2739] px-2 py-1 ${tone.bg}`}>
          <span className="font-mono text-[9px] text-[#7c8aa5]">{tf}</span>
          {sig && <span className="ml-auto rounded border border-[#2a3750] px-1.5 font-mono text-[8.5px] uppercase text-[#aab6cc]">{REGIME_LABEL[sig.regime]}</span>}
        </div>
        <div className="p-2">
          {sig ? (
            <SignalClock needle={sig.needle} action={sig.action} label={tone.label} sub={sig.action === 'wait' ? `lean ${sig.rawNeedle >= 0 ? '+' : ''}${sig.rawNeedle}` : `strength ${sig.strength}`} />
          ) : (
            <div className="flex h-[175px] items-center justify-center font-mono text-[9px] text-[#4b5a72]">{loading ? 'reading the Explainer and regime…' : 'no signal'}</div>
          )}
        </div>
        {sig && (
          <div className="space-y-1.5 border-t border-[#1c2739] p-2">
            <p className={`text-[11px] font-semibold leading-snug ${tone.text}`}>{sig.headline}</p>
            {sig.action !== 'wait' && sig.expiry ? (
              <div className="rounded border border-cyan-500/30 bg-cyan-500/5 p-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-[#4b5a72]">Suggested expiry</span>
                  <span className="font-mono text-[14px] font-bold text-cyan-300">{sig.expiry.label}</span>
                  <span className="font-mono text-[9px] text-[#7c8aa5]">
                    = {sig.expiry.bars} bar{sig.expiry.bars === 1 ? '' : 's'} of {tf}
                  </span>
                </div>
                <div className="mt-0.5 text-[9px] leading-snug text-[#7c8aa5]">{sig.expiry.basis}</div>
              </div>
            ) : (
              <div className="font-mono text-[9px] text-[#4b5a72]">No expiry - there is no call to hold.</div>
            )}
          </div>
        )}
      </div>

      {sig && (
        <>
          <div>
            <div className="mb-1 font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-[#4b5a72]">Readers</div>
            <div className="space-y-1">
              {sig.evidence.map((e) => {
                const c = leanChip(e.lean, e.ok)
                return (
                  <div key={e.id} className="flex items-start gap-1.5" title={e.headline}>
                    <span className={`mt-px w-[58px] shrink-0 rounded border px-1 py-px text-center font-mono text-[8.5px] font-bold uppercase ${c.cls}`}>{c.text}</span>
                    <span className="min-w-0 text-[10px] leading-snug text-[#aab6cc]">
                      <span className="font-semibold text-[#dbe4f0]">{e.title}</span> - {e.headline}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="mt-1 font-mono text-[8.5px] text-[#4b5a72]">
              {sig.readers.call} call · {sig.readers.put} put · {sig.readers.flat} flat{sig.readers.unreadable ? ` · ${sig.readers.unreadable} not readable (left out)` : ''}
            </div>
          </div>
          <div>
            <div className="mb-1 font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-[#4b5a72]">Checks</div>
            <ul className="space-y-1">
              {sig.checks.map((c, i) => (
                <li key={i} className="flex gap-1.5 text-[10px] leading-snug">
                  <span className={`mt-px font-mono font-bold ${c.state === 'pass' ? 'text-emerald-300' : c.state === 'fail' ? 'text-rose-300' : 'text-[#4b5a72]'}`}>{c.state === 'pass' ? '✓' : c.state === 'fail' ? '✗' : '·'}</span>
                  <span className="text-[#aab6cc]">
                    <span className="font-semibold text-[#dbe4f0]">{c.label}</span> - {c.note}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-[#4b5a72]">Why</div>
            <ul className="space-y-1">
              {sig.reasons.map((r, i) => (
                <li key={i} className="flex gap-1.5 text-[10px] leading-snug text-[#aab6cc]">
                  <span className="text-[#4b5a72]">•</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      <div className="font-mono text-[8.5px] leading-snug text-[#4b5a72]">Descriptive read of the last closed bars, not a forecast; a win rate on real data has not been measured. Auto pair-picking and the trade ticket live in the Signal tab.</div>
    </div>
  )
}
