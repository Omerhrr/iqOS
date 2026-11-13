'use client'

// IQAIR//OS - Explainer tab.
// One pair + timeframe of its OWN (independent of the main chart), five
// readers side by side - SMC, candle pattern, MRC, swing chart, technical -
// each as a verdict with a plain-language "why", an agreement strip on top,
// and the app's normal trade ticket on the right so an order goes through the
// exact same /trade path, risk gates, kill switch and paper/live routing as
// every other manual trade.
// Backed by /explainer (analytics/explainer.ts, plugins/explainer.ts).

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AccountState, AssetRow, ExplainerLean, ExplainerPanel, ExplainerPanelId, ExplainerRead, Position, Timeframe } from '@/lib/os/client'
import { getExplainer, osGet } from '@/lib/os/client'
import AssetPicker from './AssetPicker'
import ExplainerSwingChart from './ExplainerSwingChart'
import TradeTicket, { type TicketPrefill } from './TradeTicket'

interface ExplainerTabProps {
  /** the main chart's pair/timeframe - only used as the starting selection */
  initialAsset: string
  initialTf: Timeframe
  assets: AssetRow[]
  prices: Record<string, { price: number; dir: number }>
  /** bumps on every closed candle of the main chart - nudges a refresh */
  closedTick?: number
  onPlaced: (p: Position) => void
  onError: (m: string) => void
}

const TFS: Timeframe[] = ['15s', '30s', '1m', '2m', '5m', '15m', '30m', '1h']
const POLL_MS = 8_000
const STORAGE_KEY = 'iqos.explainer.sel.v1'
/** card order = the sketch: SMC, candle pattern, MRC, swing chart, technical */
const ORDER: ExplainerPanelId[] = ['smc', 'candle', 'mrc', 'swing', 'technical']
const TITLE: Record<ExplainerPanelId, string> = { smc: 'SMC', candle: 'Candle pattern', mrc: 'MRC', swing: 'Swing chart', technical: 'Technical' }

const leanChip = (lean: ExplainerLean, ok: boolean) => {
  if (!ok) return { text: 'n/a', cls: 'border-[#1c2739] text-[#4b5a72]' }
  if (lean === 'call') return { text: '▲ CALL', cls: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' }
  if (lean === 'put') return { text: '▼ PUT', cls: 'border-rose-500/50 bg-rose-500/10 text-rose-300' }
  return { text: '— flat', cls: 'border-[#3d4d66] text-[#7c8aa5]' }
}

const TONE = {
  call: { border: 'border-emerald-500/40', head: 'bg-emerald-500/10', bar: 'bg-emerald-400', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  put: { border: 'border-rose-500/40', head: 'bg-rose-500/10', bar: 'bg-rose-400', text: 'text-rose-300', dot: 'bg-rose-400' },
  flat: { border: 'border-[#2a3750]', head: 'bg-[#141d2e]', bar: 'bg-[#7c8aa5]', text: 'text-[#aab6cc]', dot: 'bg-[#7c8aa5]' },
  off: { border: 'border-[#1c2739]', head: 'bg-[#0e1522]', bar: 'bg-[#3d4d66]', text: 'text-[#4b5a72]', dot: 'bg-[#3d4d66]' },
}
const PANEL_ACCENT: Record<ExplainerPanelId, string> = { smc: 'text-cyan-300', candle: 'text-amber-300', mrc: 'text-violet-300', swing: 'text-sky-300', technical: 'text-fuchsia-300' }

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 mt-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-[#4b5a72]">{children}</div>
}

function PanelCard({ panel, read }: { panel: ExplainerPanel | undefined; read: ExplainerRead | null }) {
  const id = panel?.id
  const chip = panel ? leanChip(panel.lean, panel.ok) : leanChip('none', false)
  const tone = !panel || !panel.ok ? TONE.off : panel.lean === 'call' ? TONE.call : panel.lean === 'put' ? TONE.put : TONE.flat
  const pct = panel?.ok && panel.strength !== null ? Math.max(0, Math.min(100, panel.strength)) : 0
  return (
    <div className={`flex min-h-0 min-w-[220px] flex-1 flex-col overflow-hidden rounded-lg border bg-[#0b111c] ${tone.border}`}>
      <div className={`flex items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5 ${tone.head}`}>
        <span className={`font-mono text-[11px] font-bold uppercase tracking-wider ${id ? PANEL_ACCENT[id] : 'text-[#7c8aa5]'}`}>{id ? TITLE[id] : '…'}</span>
        <span className={`ml-auto rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-wider ${chip.cls}`}>{chip.text}</span>
      </div>
      {panel?.ok && panel.strength !== null && (
        <div className="flex items-center gap-1.5 px-2 pt-1.5" title="the engine's own strength score - not a win probability">
          <span className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">strength</span>
          <div className="h-1 flex-1 overflow-hidden rounded bg-[#141d2e]">
            <div className={`h-full ${tone.bar}`} style={{ width: `${pct}%` }} />
          </div>
          <span className={`font-mono text-[9px] font-bold ${tone.text}`}>{panel.strength}%</span>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {!panel ? (
          <div className="font-mono text-[9px] text-[#4b5a72]">reading…</div>
        ) : (
          <>
            {panel.id === 'swing' && read && (
              <>
                <SectionLabel>Chart</SectionLabel>
                <div className="rounded border border-[#141d2e] bg-[#080d16] p-1">
                  <ExplainerSwingChart chart={read.chart} asset={read.asset} />
                </div>
              </>
            )}
            <SectionLabel>Verdict</SectionLabel>
            <p className={`text-[11px] font-semibold leading-snug ${panel.ok ? tone.text : 'text-[#7c8aa5]'}`}>{panel.headline}</p>
            {panel.reasons.length > 0 && (
              <>
                <SectionLabel>Why</SectionLabel>
                <ul className="space-y-1">
                  {panel.reasons.map((r, k) => (
                    <li key={k} className="flex gap-1.5 text-[10px] leading-snug text-[#aab6cc]">
                      <span className={`mt-[4px] h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default function ExplainerTab({ initialAsset, initialTf, assets, prices, closedTick, onPlaced, onError }: ExplainerTabProps) {
  const tickers = useMemo(() => assets.map((a) => a.ticker), [assets])

  const [asset, setAsset] = useState(initialAsset)
  const [tf, setTf] = useState<Timeframe>(TFS.includes(initialTf) ? initialTf : '1m')
  const [read, setRead] = useState<ExplainerRead | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [account, setAccount] = useState<AccountState | null>(null)
  const [prefill, setPrefill] = useState<TicketPrefill | null>(null)
  const [ticketOpen, setTicketOpen] = useState(false)

  // remember this tab's own pair/tf across tab switches and reloads (per-viewer convenience only)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const s = JSON.parse(raw) as { asset?: string; tf?: string }
      if (s.asset && tickers.includes(s.asset)) setAsset(s.asset)
      if (s.tf && (TFS as string[]).includes(s.tf)) setTf(s.tf as Timeframe)
    } catch {
      /* storage unavailable - keep the main chart's pair */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers.length > 0])

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ asset, tf }))
    } catch {
      /* ignore */
    }
  }, [asset, tf])

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setBusy(true)
      try {
        const d = await getExplainer(asset, tf)
        if (d.ok) {
          setRead(d)
          setErr(null)
        } else {
          setRead(null)
          setErr(d.error)
        }
      } catch (e) {
        setErr((e as Error).message.slice(0, 180))
      } finally {
        if (!silent) setBusy(false)
      }
    },
    [asset, tf],
  )

  // pair / tf change: drop the previous read at once so one pair's verdict is
  // never shown under another pair's name
  useEffect(() => {
    setRead(null)
    setErr(null)
    setPrefill(null)
    void load(false)
  }, [load])

  useEffect(() => {
    const t = setInterval(() => void load(true), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (closedTick !== undefined) void load(true)
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

  const assetRow = assets.find((a) => a.ticker === asset)
  const livePrice = prices[asset]?.price ?? read?.price ?? assetRow?.price ?? 0
  const panels = ORDER.map((id) => read?.panels.find((p) => p.id === id))
  const summary = read?.summary

  const loadVerdictIntoTicket = () => {
    if (!summary || summary.lean === 'none') return
    setPrefill({
      nonce: Date.now(),
      kind: 'binary',
      side: summary.lean,
      expiryBars: 1,
      source: `Explainer ${asset} ${tf}: ${summary.headline}`,
    })
    setTicketOpen(true)
  }

  const gradeCls =
    summary?.grade === 'aligned'
      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
      : summary?.grade === 'leaning'
        ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
        : summary?.grade === 'mixed'
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
          : 'border-[#1c2739] text-[#7c8aa5]'

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
      {/* header: pair selector + tf (this tab's own) */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1c2739] px-2 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Explainer</span>
        <AssetPicker tickers={tickers} value={asset} onChange={setAsset} className="w-32" />
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
        <span className="font-mono text-[9px] text-[#4b5a72]">{busy && !read ? 'reading…' : read ? `${read.bars} closed bars · live` : ''}</span>
        <span className="ml-auto hidden font-mono text-[8px] uppercase tracking-wider text-[#3d4d66] md:inline">own pair/tf - not the main chart</span>
        <button
          type="button"
          onClick={() => setTicketOpen((o) => !o)}
          className={`rounded border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${
            ticketOpen ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300' : 'border-[#2a3750] text-[#aab6cc] hover:border-cyan-500/40 hover:text-cyan-300'
          }`}
        >
          {ticketOpen ? 'close ticket ✕' : 'trade ticket'}
        </button>
      </div>

      {/* agreement strip */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1c2739] px-2 py-1.5">
        {summary ? (
          <>
            <span className={`rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-wider ${gradeCls}`}>{summary.grade}</span>
            <span className="text-[10.5px] text-[#dbe4f0]">{summary.headline}</span>
            {summary.unavailable > 0 && (
              <span className="font-mono text-[9px] text-[#4b5a72]" title="panels that could not read yet are left out of the count, not counted as neutral">
                {summary.unavailable} panel{summary.unavailable === 1 ? '' : 's'} not readable
              </span>
            )}
            {summary.lean !== 'none' && (
              <button
                type="button"
                onClick={loadVerdictIntoTicket}
                className={`ml-auto rounded border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${
                  summary.lean === 'call' ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10' : 'border-rose-500/40 text-rose-300 hover:bg-rose-500/10'
                }`}
                title="highlights this side on the ticket - nothing is placed until you press the ticket's button"
              >
                load {summary.lean.toUpperCase()} into ticket
              </button>
            )}
          </>
        ) : (
          <span className="font-mono text-[10px] text-[#4b5a72]">{err ?? 'reading five engines…'}</span>
        )}
      </div>

      {err && read === null && summary && <div className="px-2 py-1 font-mono text-[9px] text-amber-300">{err}</div>}

      {/* body: five readers + the ticket */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 gap-2 overflow-x-auto p-2">
          {panels.map((p, i) => (
            <PanelCard key={ORDER[i]} panel={p} read={read} />
          ))}
        </div>

        {ticketOpen && (
          <div className="flex w-[290px] shrink-0 flex-col gap-1.5 overflow-auto border-l border-[#1c2739] p-2">
            <div className="flex items-center gap-2 rounded border border-cyan-500/30 bg-cyan-500/5 px-2 py-1 font-mono text-[9px] text-[#7c8aa5]">
              <span className="min-w-0 flex-1">
                ticket pair: <span className="font-bold text-cyan-300">{asset}</span> · {tf}
                <span className="text-[#4b5a72]"> (this tab&apos;s pair, not the main chart)</span>
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
        {summary?.note ?? 'Reads closed candles for the pair and timeframe chosen here.'} Orders use the same /trade path, risk gates and paper/live routing as the main trade ticket.
      </p>
    </div>
  )
}
