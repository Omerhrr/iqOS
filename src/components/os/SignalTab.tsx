'use client'

// IQAIR//OS - Signal tab.
// A clock-shaped BUY / SELL / WAIT call built from the Explainer (five readers
// plus Effort Renko) and the pair's regime, with a suggested expiry. In AUTO
// the tab moves itself to the pair it rates strongest (regime shortlist ->
// full signal on each, with hysteresis so it does not flip every refresh);
// picking a pair yourself switches to MANUAL until you press "back to auto".
// Auto-switching pauses while the trade ticket is open, so the pair under your
// ticket never changes mid-order. The ticket is the app's normal one: same
// /trade path, risk gates and paper/live routing; nothing is ever placed
// automatically. Backed by /signal and /signal_best (plugins/signal.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AccountState, AssetRow, ExplainerLean, Position, SignalBest, SignalRead, Timeframe } from '@/lib/os/client'
import { fmtPrice, getSignal, getSignalBest, osGet } from '@/lib/os/client'
import AssetPicker from './AssetPicker'
import SignalClock from './SignalClock'
import TradeTicket, { type TicketPrefill } from './TradeTicket'

interface SignalTabProps {
  initialAsset: string
  initialTf: Timeframe
  assets: AssetRow[]
  prices: Record<string, { price: number; dir: number }>
  closedTick?: number
  onPlaced: (p: Position) => void
  onError: (m: string) => void
}

const TFS: Timeframe[] = ['30s', '1m', '2m', '5m', '15m', '30m', '1h']
const READ_POLL_MS = 8_000
const BEST_POLL_MS = 10_000
const STORAGE_KEY = 'iqos.signal.sel.v1'

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

export default function SignalTab({ initialAsset, initialTf, assets, prices, closedTick, onPlaced, onError }: SignalTabProps) {
  const tickers = useMemo(() => assets.map((a) => a.ticker), [assets])
  const [asset, setAsset] = useState(initialAsset)
  const [tf, setTf] = useState<Timeframe>(TFS.includes(initialTf) ? initialTf : '1m')
  const [auto, setAuto] = useState(true)
  const [read, setRead] = useState<SignalRead | null>(null)
  const [board, setBoard] = useState<SignalBest | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [prefill, setPrefill] = useState<TicketPrefill | null>(null)
  const [account, setAccount] = useState<AccountState | null>(null)
  const [switchNote, setSwitchNote] = useState<string | null>(null)

  // the pair/tf/mode a response was requested for - stale responses are dropped
  const live = useRef({ asset, tf, auto, ticketOpen })
  live.current = { asset, tf, auto, ticketOpen }

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const s = JSON.parse(raw) as { tf?: string; auto?: boolean; asset?: string }
      if (s.tf && (TFS as string[]).includes(s.tf)) setTf(s.tf as Timeframe)
      if (s.auto === false) {
        setAuto(false)
        if (s.asset && tickers.includes(s.asset)) setAsset(s.asset)
      }
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers.length > 0])
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tf, auto, asset: auto ? undefined : asset }))
    } catch {
      /* ignore */
    }
  }, [tf, auto, asset])

  const loadRead = useCallback(async () => {
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

  const loadBest = useCallback(async () => {
    const want = { tf: live.current.tf, cur: live.current.asset }
    try {
      const d = await getSignalBest(want.tf, { current: want.cur })
      if (live.current.tf !== want.tf) return
      if (!d.ok) {
        setErr(d.error)
        return
      }
      setBoard(d)
      const pick = d.pick
      if (live.current.auto && !live.current.ticketOpen && pick && pick.asset !== live.current.asset) {
        setSwitchNote(`switched to ${pick.asset} (${pick.signal.action === 'wait' ? 'strongest lean, nothing actionable' : `${pick.signal.action.toUpperCase()} ${pick.signal.strength}`})`)
        setAsset(pick.asset)
        setRead(pick)
        setPrefill(null)
        setLoading(false)
      }
    } catch {
      /* the per-pair read still runs */
    }
  }, [])

  // pair / tf change: drop the old read so one pair's call is never shown under another's name
  useEffect(() => {
    setRead(null)
    setErr(null)
    setLoading(true)
    void loadRead()
  }, [asset, tf, loadRead])
  useEffect(() => {
    setBoard(null)
  }, [tf])

  useEffect(() => {
    const t = setInterval(() => void loadRead(), READ_POLL_MS)
    return () => clearInterval(t)
  }, [loadRead])
  useEffect(() => {
    void loadBest()
    const t = setInterval(() => void loadBest(), BEST_POLL_MS)
    return () => clearInterval(t)
  }, [loadBest, tf, auto])
  useEffect(() => {
    if (closedTick !== undefined) void loadRead()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedTick])

  useEffect(() => {
    let alive = true
    const readAcct = () =>
      osGet<AccountState>('/account')
        .then((a) => {
          if (alive) setAccount(a)
        })
        .catch(() => {})
    void readAcct()
    const t = setInterval(readAcct, 10_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const pickManual = (a: string) => {
    setAuto(false)
    setSwitchNote(null)
    setAsset(a)
  }

  const sig = read?.signal
  const tone = actionTone(sig?.action ?? 'wait')
  const assetRow = assets.find((a) => a.ticker === asset)
  const livePrice = prices[asset]?.price ?? read?.price ?? assetRow?.price ?? 0

  const loadIntoTicket = () => {
    if (!sig || sig.action === 'wait') return
    setPrefill({
      nonce: Date.now(),
      kind: 'binary',
      side: sig.action === 'buy' ? 'call' : 'put',
      expiryBars: sig.expiry?.bars ?? 1,
      source: `Signal ${asset} ${tf}: ${sig.headline}`,
    })
    setTicketOpen(true)
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1c2739] px-2 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Signal</span>
        <button
          type="button"
          onClick={() => {
            setAuto(true)
            setSwitchNote(null)
            void loadBest()
          }}
          title={auto ? 'AUTO: the tab moves itself to the pair it rates strongest. Pick a pair to take over.' : 'MANUAL: you chose this pair. Press to hand control back to auto.'}
          className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${auto ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'}`}
        >
          {auto ? (ticketOpen ? 'auto · paused (ticket open)' : 'auto') : 'manual · back to auto'}
        </button>
        <AssetPicker tickers={tickers} value={asset} onChange={pickManual} className="w-32" />
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
        <span className="min-w-0 truncate font-mono text-[9px] text-[#4b5a72]">{loading && !read ? 'reading…' : switchNote ?? ''}</span>
        <button
          type="button"
          onClick={() => setTicketOpen((o) => !o)}
          className={`ml-auto rounded border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${ticketOpen ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300' : 'border-[#2a3750] text-[#aab6cc] hover:border-cyan-500/40 hover:text-cyan-300'}`}
        >
          {ticketOpen ? 'close ticket ✕' : 'trade ticket'}
        </button>
      </div>

      {err && !sig && <div className="border-b border-[#1c2739] px-2 py-1 font-mono text-[9px] text-amber-300">{err}</div>}

      <div className="flex min-h-0 flex-1">
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-2 overflow-auto p-2 lg:grid-cols-[minmax(260px,1fr)_minmax(260px,1.1fr)_minmax(200px,0.8fr)]">
          {/* clock + call */}
          <div className={`flex min-w-0 flex-col rounded-lg border bg-[#0b111c] ${tone.border}`}>
            <div className={`flex items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5 ${tone.bg}`}>
              <span className="font-mono text-[11px] font-bold text-[#dbe4f0]">{asset}</span>
              <span className="font-mono text-[9px] text-[#7c8aa5]">{tf}</span>
              <span className="font-mono text-[9px] text-[#4b5a72]">{livePrice ? fmtPrice(livePrice, asset) : ''}</span>
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
                    {sig.expiry.rates.length > 0 && sig.regime !== 'ranging' && (
                      <div className="mt-1 flex flex-wrap gap-1 font-mono text-[8.5px] text-[#4b5a72]">
                        {sig.expiry.rates.map((r) => (
                          <span key={r.bars} className={`rounded border px-1 ${r.bars === sig.expiry!.bars ? 'border-cyan-500/40 text-cyan-300' : 'border-[#1c2739]'}`}>
                            {r.bars}b {(r.rate * 100).toFixed(0)}%
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="font-mono text-[9px] text-[#4b5a72]">No expiry - there is no call to hold.</div>
                )}
                {sig.action !== 'wait' && (
                  <button
                    type="button"
                    onClick={loadIntoTicket}
                    title="opens the ticket with this side and expiry highlighted - nothing is placed until you press the ticket's own button"
                    className={`w-full rounded border px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider ${sig.action === 'buy' ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10' : 'border-rose-500/40 text-rose-300 hover:bg-rose-500/10'}`}
                  >
                    load {sig.action === 'buy' ? 'CALL' : 'PUT'} {sig.expiry ? `· ${sig.expiry.label}` : ''} into ticket
                  </button>
                )}
              </div>
            )}
          </div>

          {/* analysis */}
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[#1c2739] bg-[#0b111c]">
            <div className="border-b border-[#1c2739] bg-[#0e1522] px-2 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Analysis</div>
            <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
              {!sig ? (
                <div className="font-mono text-[9px] text-[#4b5a72]">reading…</div>
              ) : (
                <>
                  <div>
                    <div className="mb-1 font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-[#4b5a72]">Readers (the Explainer + Effort Renko)</div>
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
                          <span className={`mt-[4px] h-1.5 w-1.5 shrink-0 rounded-full ${sig.action === 'buy' ? 'bg-emerald-400' : sig.action === 'sell' ? 'bg-rose-400' : 'bg-amber-400'}`} />
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* best pairs */}
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[#1c2739] bg-[#0b111c]">
            <div className="flex items-baseline gap-1.5 border-b border-[#1c2739] bg-[#0e1522] px-2 py-1.5">
              <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Best pairs</span>
              <span className="font-mono text-[8.5px] text-[#4b5a72]">{board ? `${board.evaluated} shortlisted from the regime scan` : 'scanning…'}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-auto p-1.5">
              {!board ? (
                <div className="p-1 font-mono text-[9px] text-[#4b5a72]">scanning…</div>
              ) : board.leaderboard.length === 0 ? (
                <div className="p-1 font-mono text-[9px] text-[#4b5a72]">no trending or range-edge pair on {board.tf} right now</div>
              ) : (
                board.leaderboard.map((c) => {
                  const t = actionTone(c.action)
                  const here = c.asset === asset
                  return (
                    <button
                      key={c.asset}
                      type="button"
                      onClick={() => pickManual(c.asset)}
                      title={`${c.setup || 'no setup'} · click to open this pair (switches to manual)`}
                      className={`flex w-full items-center gap-1.5 rounded border px-1.5 py-1 text-left hover:border-[#3d4d66] ${here ? 'border-cyan-500/40 bg-cyan-500/5' : 'border-[#141d2e] bg-[#080d16]'}`}
                    >
                      <span className={`w-9 shrink-0 rounded border px-1 text-center font-mono text-[8.5px] font-bold ${t.text} ${t.border}`}>{t.label}</span>
                      <span className="font-mono text-[10px] font-bold text-[#dbe4f0]">{c.asset}</span>
                      <span className="ml-auto font-mono text-[8.5px] text-[#7c8aa5]">{REGIME_LABEL[c.regime]}</span>
                      <span className={`w-7 text-right font-mono text-[9px] font-bold ${t.text}`}>{c.action === 'wait' ? '·' : c.strength}</span>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </div>

        {ticketOpen && (
          <div className="flex w-[290px] shrink-0 flex-col gap-1.5 overflow-auto border-l border-[#1c2739] p-2">
            <div className="flex items-center gap-2 rounded border border-cyan-500/30 bg-cyan-500/5 px-2 py-1 font-mono text-[9px] text-[#7c8aa5]">
              <span className="min-w-0 flex-1">
                ticket pair: <span className="font-bold text-cyan-300">{asset}</span> · {tf}
                {auto && <span className="text-[#4b5a72]"> (auto-switching is paused while this is open)</span>}
              </span>
              <button type="button" onClick={() => setTicketOpen(false)} className="shrink-0 rounded border border-[#2a3750] px-1.5 py-px text-[#aab6cc] hover:text-rose-300" aria-label="close ticket">
                ✕
              </button>
            </div>
            <TradeTicket asset={assetRow} tf={tf} price={livePrice} account={account} prefill={prefill} onPlaced={onPlaced} onError={onError} />
          </div>
        )}
      </div>

      <p className="border-t border-[#1c2739] px-2 py-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
        {sig?.note ?? 'Combines the Explainer readers with the pair\'s regime into a buy / sell / wait call.'} In auto the tab keeps a pair until another beats it by a clear margin. Nothing is ever placed automatically.
      </p>
    </div>
  )
}
