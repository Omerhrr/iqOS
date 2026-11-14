'use client'

// IQAIR//OS - Smart Money Concepts / ICT structure panel.
// Scans the CHART's own active asset+tf (trading-core/src/analytics/smc.ts)
// for: Fair Value Gap, Inverse FVG, Order Block, Breaker Block, Liquidity
// Sweep, Break of Structure, CHoCH, OTE, KRM, Supply & Demand, Support &
// Resistance, Breakout, CRT, Power of 3, Silver Bullet.
//
// Detection-only for now, by design: this is explicitly built so the
// Next-Candle Oracle CAN read it later (summary.direction/confidence is
// shaped like every other driver nextcandle.ts fuses), but it is not wired
// into the Oracle's fusion yet - every other new signal source this session
// added (cointegration, vol-arb outcome trackers) followed the same rule:
// earn a weight slot only after real resolved outcomes validate it, not on
// how plausible the concept sounds.
//
// Two signals are explicit interpretations/approximations rather than
// textbook-exact - KRM (no single agreed ICT definition; implemented as a
// classic one-bar key-reversal mark) and Silver Bullet (its AM kill zone is
// genuinely NY-session-time-anchored; this kernel has no DST-aware
// timezone conversion, so it's a fixed UTC-hour proxy). Both say so in
// their own note text and tooltip.
import { useEffect, useState } from 'react'
import type { AccountState, AssetRow, Position, SmcKind, SmcScanResponse, SmcSignal, Timeframe } from '@/lib/os/client'
import { fmtPrice, getSmcScan, getDayLevels, osGet, type DayLevelsResponse } from '@/lib/os/client'
import TradeTicket, { type TicketPrefill } from './TradeTicket'

interface SmcPanelProps {
  asset: string
  tf: Timeframe
  closedTick?: number
  onError: (m: string) => void
  /** with these three the panel gets the app's normal trade ticket (hidden until opened) */
  assets?: AssetRow[]
  prices?: Record<string, { price: number; dir: number }>
  onPlaced?: (p: Position) => void
}

const KIND_LABEL: Record<SmcKind, string> = {
  FVG: 'Fair Value Gap',
  IFVG: 'Inverse FVG',
  ORDER_BLOCK: 'Order Block',
  BREAKER_BLOCK: 'Breaker Block',
  LIQUIDITY_SWEEP: 'Liquidity Sweep',
  BOS: 'Break of Structure',
  CHOCH: 'CHoCH',
  OTE: 'OTE',
  KRM: 'KRM',
  SUPPLY_DEMAND: 'Supply & Demand',
  SUPPORT_RESISTANCE: 'Support & Resistance',
  BREAKOUT: 'Breakout',
  CRT: 'CRT',
  POWER_OF_3: 'Power of 3',
  SILVER_BULLET: 'Silver Bullet',
  EQH_EQL: 'Equal Highs/Lows',
  REJECTION_BLOCK: 'Rejection Block',
  INDUCEMENT: 'Inducement',
}

const KIND_TOOLTIP: Partial<Record<SmcKind, string>> = {
  EQH_EQL: 'Context only, not counted in the SMC lean. Two or more swing highs (or lows) within 0.15 ATR of each other form a pool of resting stops just past them; shown while unswept. The direction is only the SIDE the pool sits on (a liquidity magnet), not a reversal call.',
  REJECTION_BLOCK: 'Context only, not counted in the SMC lean. A swing high/low candle with a wick at least twice its body and half its range (on a 0.8+ ATR candle). The zone is the wick; the entry is the body edge, not the tip. Dropped when a later bar closes beyond the tip.',
  INDUCEMENT: 'Context only, not counted in the SMC lean. One mechanical reading: inside a trend, a pullback builds a minor swing low (high) after the latest major high (low); a bar that wicks through it and closes back on the trend side has taken the bait. Not a unique definition.',
  KRM: 'This codebase’s own interpretation: KRM has no single universally-agreed ICT definition. Implemented as a classic one-bar "Key Reversal Mark" - a new local extreme that closes back through the prior candle’s midpoint.',
  SILVER_BULLET: 'AM kill-zone proxy: real ICT Silver Bullet is anchored to ~10-11am New York time. This kernel has no DST-aware timezone conversion, so this is a FIXED UTC-hour approximation of 10-11am EST (standard time) - it silently drifts an hour off during US daylight saving.',
  POWER_OF_3: 'Bar-count proxy, not session-anchored: real AMD splits a trading DAY into Asia/London/NY. This kernel has no session-grouped candles, so it instead splits the trailing window into three equal thirds and asks the same structural question.',
}

const ALL_KINDS: SmcKind[] = ['BOS', 'CHOCH', 'LIQUIDITY_SWEEP', 'ORDER_BLOCK', 'BREAKER_BLOCK', 'FVG', 'IFVG', 'OTE', 'SUPPLY_DEMAND', 'SUPPORT_RESISTANCE', 'BREAKOUT', 'CRT', 'POWER_OF_3', 'SILVER_BULLET', 'KRM', 'EQH_EQL', 'REJECTION_BLOCK', 'INDUCEMENT']

function dirColor(d: 'bullish' | 'bearish', part: 'text' | 'bg' | 'border' = 'text'): string {
  const map = {
    bullish: { text: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40' },
    bearish: { text: 'text-rose-300', bg: 'bg-rose-500/10', border: 'border-rose-500/40' },
  }
  return map[d][part]
}

function DirChip({ d }: { d: 'bullish' | 'bearish' }) {
  return (
    <span className={`rounded px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-wider ${dirColor(d, 'bg')} ${dirColor(d)}`}>
      {d === 'bullish' ? '▲ bull' : '▼ bear'}
    </span>
  )
}

function SignalRow({ s, price, asset }: { s: SmcSignal; price: number; asset: string }) {
  const hasZone = s.top !== undefined && s.bottom !== undefined
  const tip = KIND_TOOLTIP[s.kind]
  return (
    <div className={`rounded-lg border bg-[#0b111c] p-2 transition-opacity ${s.active ? dirColor(s.direction, 'border') : 'border-[#1c2739] opacity-55'}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#dbe4f0]" title={tip}>
          {KIND_LABEL[s.kind]}
          {tip && <sup className="ml-0.5 text-amber-400">*</sup>}
        </span>
        <DirChip d={s.direction} />
        {!s.active && (
          <span className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] uppercase text-[#4b5a72]" title="no longer live - mitigated, violated, or aged out">
            stale
          </span>
        )}
        {s.touches !== undefined && (
          <span className="rounded border border-[#1c2739] px-1 py-px font-mono text-[8px] text-[#7c8aa5]">{s.touches} touches</span>
        )}
        <span className="ml-auto font-mono text-[9px] text-[#4b5a72]">{s.barsAgo === 0 ? 'now' : `${s.barsAgo}bar ago`}</span>
      </div>
      {hasZone ? (
        <div className="mt-1 flex items-center gap-2 font-mono text-[9px] text-[#aab6cc]">
          <span>top {fmtPrice(s.top ?? 0, asset)}</span>
          <span>bottom {fmtPrice(s.bottom ?? 0, asset)}</span>
          {s.active && price >= Math.min(s.top ?? 0, s.bottom ?? 0) && price <= Math.max(s.top ?? 0, s.bottom ?? 0) && (
            <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1 py-px text-[8px] font-bold uppercase text-cyan-300">price inside</span>
          )}
        </div>
      ) : s.level !== undefined ? (
        <div className="mt-1 font-mono text-[9px] text-[#aab6cc]">level {fmtPrice(s.level, asset)}</div>
      ) : null}
      <p className="mt-1 text-[9px] leading-snug text-[#7c8aa5]">{s.note}</p>
    </div>
  )
}

export default function SmcPanel({ asset, tf, closedTick, onError, assets, prices, onPlaced }: SmcPanelProps) {
  const [data, setData] = useState<SmcScanResponse | null>(null)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [prefill, setPrefill] = useState<TicketPrefill | null>(null)
  const [account, setAccount] = useState<AccountState | null>(null)
  const ticketAvailable = Boolean(assets && onPlaced)

  // the ticket belongs to the pair on screen: a pair change drops any highlighted side
  useEffect(() => {
    setPrefill(null)
  }, [asset])

  useEffect(() => {
    if (!ticketAvailable || !ticketOpen) return
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
  }, [ticketAvailable, ticketOpen])
  const [levels, setLevels] = useState<DayLevelsResponse | null>(null)
  useEffect(() => {
    let alive = true
    setLevels(null)
    const load = () =>
      getDayLevels(asset, '5m')
        .then((d) => {
          if (alive) setLevels(d)
        })
        .catch(() => {})
    void load()
    const t = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [asset])
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Set<SmcKind>>(new Set())
  const [onlyActive, setOnlyActive] = useState(true)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    getSmcScan(asset, tf)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e: Error) => {
        if (!cancelled) onError(e.message.slice(0, 180))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, tf, closedTick])

  useEffect(() => {
    const iv = setInterval(() => {
      getSmcScan(asset, tf)
        .then((d) => setData(d))
        .catch(() => {})
    }, 8000)
    return () => clearInterval(iv)
  }, [asset, tf])

  const result = data?.result ?? null
  const signals = (result?.signals ?? []).filter((s) => (onlyActive ? s.active : true)).filter((s) => (filter.size === 0 ? true : filter.has(s.kind)))

  const toggleKind = (k: SmcKind) => {
    setFilter((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const assetRow = assets?.find((a) => a.ticker === asset)
  const livePrice = prices?.[asset]?.price ?? result?.price ?? assetRow?.price ?? 0
  const lean = result && result.summary.direction !== 'none' ? result.summary.direction : null
  const loadLean = () => {
    if (!lean) return
    setPrefill({ nonce: Date.now(), kind: 'binary', side: lean, expiryBars: 1, source: `SMC ${asset} ${tf}: lean ${lean} ${result?.summary.confidence ?? 0}%` })
    setTicketOpen(true)
  }

  return (
    <div className="flex h-full min-h-0 rounded-lg border border-[#1c2739] bg-[#0b111c]">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1c2739] px-2 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Smart Money Concepts</span>
        <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase text-cyan-300">
          {asset} · {tf}
        </span>
        {result && (
          <span
            className={`rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-wider ${
              result.trend === 'bullish' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : result.trend === 'bearish' ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-[#1c2739] text-[#7c8aa5]'
            }`}
            title="current structure trend from the BOS/CHoCH walk - 'range' means no swing break has happened yet in the scanned window"
          >
            structure: {result.trend}
          </span>
        )}
        {result && result.summary.direction !== 'none' && (
          <span
            className={`rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-wider ${
              result.summary.direction === 'call' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
            }`}
            title={`${result.summary.bullish} bullish vs ${result.summary.bearish} bearish active signals - NOT an Oracle driver yet, see panel header`}
          >
            lean {result.summary.direction} · {result.summary.confidence}%
          </span>
        )}
        <label className="ml-auto flex items-center gap-1 font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]">
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} className="accent-cyan-500" />
          active only
        </label>
        {ticketAvailable && (
          <button
            type="button"
            onClick={() => setTicketOpen((o) => !o)}
            className={`rounded border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${ticketOpen ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300' : 'border-[#2a3750] text-[#aab6cc] hover:border-cyan-500/40 hover:text-cyan-300'}`}
          >
            {ticketOpen ? 'close ticket ✕' : 'trade ticket'}
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1 border-b border-[#1c2739] px-2 py-1">
        {ALL_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => toggleKind(k)}
            className={`rounded px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider transition-colors ${
              filter.has(k) ? 'bg-cyan-500/15 text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      {levels && levels.ok && levels.levels && levels.levels.length > 0 && (
        <div className="border-b border-[#1c2739] px-2 py-1" title={levels.note}>
          <div className="mb-0.5 font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">
            liquidity levels (5m, UTC sessions) - nearest unswept: above {levels.nearestAbove ? `${levels.nearestAbove.label} ${levels.nearestAbove.distanceAtr.toFixed(1)} ATR` : 'none'} · below{' '}
            {levels.nearestBelow ? `${levels.nearestBelow.label} ${Math.abs(levels.nearestBelow.distanceAtr).toFixed(1)} ATR` : 'none'}
          </div>
          <div className="flex flex-wrap gap-1">
            {levels.levels.map((l) => {
              const live = !l.swept
              const rej = l.rejectedBar !== null
              return (
                <span
                  key={l.id}
                  title={`${l.label} (${l.from}) ${l.swept ? (rej ? 'swept, then closed back inside - stop-hunt read' : 'swept') : 'not swept yet'}`}
                  className={`rounded border px-1.5 py-px font-mono text-[8.5px] ${
                    live ? 'border-cyan-500/30 text-cyan-300' : rej ? 'border-amber-500/40 text-amber-300' : 'border-[#1c2739] text-[#4b5a72] line-through'
                  }`}
                >
                  {l.label} {fmtPrice(l.price, asset)} <span className="opacity-70">{l.distanceAtr >= 0 ? '+' : ''}{l.distanceAtr.toFixed(1)}</span>
                </span>
              )
            })}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        {!data && busy && <div className="p-2 text-[10px] text-[#4b5a72]">scanning structure…</div>}
        {data && !result && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">Not enough candle history yet on {asset} · {tf} - needs at least 60 bars.</div>
        )}
        {result && signals.length === 0 && (
          <div className="p-2 text-[10px] leading-relaxed text-[#4b5a72]">
            {result.signals.length === 0
              ? 'No structure concepts detected on this instrument right now.'
              : `${result.signals.length} signal(s) found but filtered out - clear the kind filter${onlyActive ? ' or untick "active only"' : ''}.`}
          </div>
        )}
        {signals.map((s, i) => (
          <SignalRow key={`${s.kind}-${s.index}-${i}`} s={s} price={result?.price ?? 0} asset={asset} />
        ))}
      </div>

      <p className="border-t border-[#1c2739] px-2 py-1 text-[8.5px] leading-relaxed text-[#3d4d66]">
        Detection-only - not fed into the Next-Candle Oracle yet. <span className="text-amber-400">*</span> KRM and Silver Bullet are explicit interpretations/approximations (hover their label). Scans the chart&apos;s own asset + timeframe, refreshes every ~8s or on a closed candle.
      </p>
    </div>
    {ticketAvailable && ticketOpen && (
      <div className="flex w-[290px] shrink-0 flex-col gap-1.5 overflow-auto border-l border-[#1c2739] p-2">
        <div className="flex items-center gap-2 rounded border border-cyan-500/30 bg-cyan-500/5 px-2 py-1 font-mono text-[9px] text-[#7c8aa5]">
          <span className="min-w-0 flex-1">
            ticket pair: <span className="font-bold text-cyan-300">{asset}</span> · {tf}
            <span className="text-[#4b5a72]"> (the chart&apos;s pair)</span>
          </span>
          <button type="button" onClick={() => setTicketOpen(false)} className="shrink-0 rounded border border-[#2a3750] px-1.5 py-px text-[#aab6cc] hover:text-rose-300" aria-label="close ticket">
            ✕
          </button>
        </div>
        {lean && (
          <button
            type="button"
            onClick={loadLean}
            title="highlights this side on the ticket - nothing is placed until you press the ticket's own button"
            className={`rounded border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider ${lean === 'call' ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10' : 'border-rose-500/40 text-rose-300 hover:bg-rose-500/10'}`}
          >
            load SMC lean ({lean.toUpperCase()} {result?.summary.confidence}%) into ticket
          </button>
        )}
        <TradeTicket asset={assetRow} tf={tf} price={livePrice} account={account} prefill={prefill} onPlaced={onPlaced as (p: Position) => void} onError={onError} />
      </div>
    )}
    </div>
  )
}
