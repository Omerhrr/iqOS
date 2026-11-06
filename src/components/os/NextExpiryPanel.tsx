'use client'

// IQAIR//OS - Next-Expiry Oracle panel
// The per-expiry sibling of the Next-Candle Oracle: for the asset on the
// chart it fuses its own horizon-native model panel (Markov H-E transitions,
// variance-ratio momentum/fade, OU half-life fade, run-length exhaustion,
// session drift) at EVERY expiry on the 1/2/3/5/15-minute ladder, then
// recommends the single best expiry - or says "no edge, wait".
//
// Backed by index.ts's /next_expiry + /next_expiry_stats
// (analytics/nextexpiry.ts, plugins/nextexpiry.ts). The engine always runs
// on closed 1m candles regardless of the chart's tf - the expiry ladder is
// minute-native.
//
// The panel auto-refreshes on every closed candle of the active asset
// (closedTick prop) plus a slow fallback poll, shows each rung's own
// honesty record (the plugin resolves every issued window against the real
// close), and the best pick must clear BOTH a pWin floor and a confidence
// floor before the panel will actually recommend it.

import { useCallback, useEffect, useState } from 'react'
import type { ExpiryDriver, ExpiryRow, NextExpiryPrediction, NextExpiryStatsResponse } from '@/lib/os/client'
import { fmtPrice, getNextExpiry, getNextExpiryStats } from '@/lib/os/client'

interface NextExpiryPanelProps {
  asset: string
  /** bumps on every closed candle - keeps the reads + ledger fresh */
  closedTick?: number
  onClose: () => void
  /** cross-nav: jump to the Next-Candle Oracle for this same asset */
  onOpenOracle?: (asset: string) => void
}

const FALLBACK_POLL_MS = 15_000

const EXPIRY_ACCENT: Record<number, string> = {
  1: 'text-sky-300',
  2: 'text-cyan-300',
  3: 'text-teal-300',
  5: 'text-emerald-300',
  15: 'text-lime-300',
}

function regimeChip(regime: string) {
  const color =
    regime === 'TRENDING' ? 'border-cyan-500/40 text-cyan-300' :
    regime === 'RANGING' ? 'border-violet-500/40 text-violet-300' :
    regime === 'VOLATILE' ? 'border-orange-500/40 text-orange-300' :
    'border-[#3d4d66] text-[#7c8aa5]'
  return (
    <span className={`rounded border px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-wider ${color}`}>{regime}</span>
  )
}

function sessionChip(session: string) {
  const hot = session === 'OVERLAP' || session === 'NEWYORK' || session === 'LONDON'
  return (
    <span className={`rounded border px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-wider ${hot ? 'border-amber-500/40 text-amber-300' : 'border-[#3d4d66] text-[#7c8aa5]'}`} title="the session bucket every expiry's Session-drift model is currently reading">
      {session}
    </span>
  )
}

function TrackBadge({ cal }: { cal: ExpiryRow['calibration'] }) {
  if (!cal || cal.n === 0) {
    return (
      <span className="rounded border border-[#1c2739] px-1 py-px font-mono text-[7.5px] uppercase tracking-wider text-[#4b5a72]" title="this expiry has no resolved windows on this asset yet">
        uncal
      </span>
    )
  }
  const good = cal.hitRate >= 0.55 && cal.brier < 0.25
  return (
    <span
      className={`rounded border px-1 py-px font-mono text-[7.5px] uppercase tracking-wider ${good ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/40 text-amber-300'}`}
      title={`last ${cal.n} resolved ${cal.n === 1 ? 'window' : 'windows'} at this expiry: ${(cal.hitRate * 100).toFixed(0)}% hit rate, Brier ${cal.brier.toFixed(3)} (0.25 = honest coin). This record discounts/boosts the confidence read.`}
    >
      {cal.n}: {(cal.hitRate * 100).toFixed(0)}%
    </span>
  )
}

function DriverRow({ d }: { d: ExpiryDriver }) {
  const bull = d.vote > 0.05
  const bear = d.vote < -0.05
  return (
    <div className="rounded border border-[#1c2739] bg-[#0b111c] p-1.5">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bull ? 'bg-emerald-400' : bear ? 'bg-rose-400' : 'bg-[#3d4d66]'}`} />
        <span className="font-mono text-[10px] font-bold text-[#dbe4f0]">{d.name}</span>
        <span className="ml-auto font-mono text-[9px] text-[#7c8aa5]">p {Math.round(d.pUp * 100)}% · w {d.weight.toFixed(0)}</span>
      </div>
      <p className="mt-0.5 pl-3 font-mono text-[8.5px] leading-snug text-[#7c8aa5]">{d.detail}</p>
    </div>
  )
}

/** The window-close clock: targetBarTime is the anchor bar's OPEN time in
 * seconds, so the window closes at (targetBarTime + 60)s wall time. Rendered
 * via the browser's own clock -> always the operator's system time. */
function windowCloseLabel(targetBarTime: number, nowSec: number): string {
  const remain = targetBarTime + 60 - nowSec
  if (remain <= 0) return 'closing…'
  const m = Math.floor(remain / 60)
  const s = remain % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

function ExpiryCard({
  row,
  selected,
  isBest,
  nowSec,
  onSelect,
}: {
  row: ExpiryRow
  selected: boolean
  isBest: boolean
  nowSec: number
  onSelect: () => void
}) {
  const accent = EXPIRY_ACCENT[row.expiry] ?? 'text-[#7c8aa5]'
  const call = row.direction === 'call'
  const put = row.direction === 'put'
  // pWin bar: map the 50..100% band onto the full width
  const winPct = Math.round((row.pWin - 0.5) * 200)
  if (!row.ok) {
    return (
      <button
        type="button"
        onClick={onSelect}
        className={`relative rounded-lg border p-1.5 text-left transition-colors ${selected ? 'border-[#3d4d66] bg-[#0e1524]' : 'border-[#1c2739] bg-[#0b111c] hover:border-[#3d4d66]'}`}
        title={row.note || 'this expiry is still warming up'}
      >
        <div className="flex items-center justify-between">
          <span className={`font-mono text-[11px] font-bold ${accent}`}>{row.expiry}m</span>
          <span className="font-mono text-[8px] text-[#4b5a72]" title={row.note}>warm</span>
        </div>
        <div className="mt-1.5 font-mono text-[13px] font-bold leading-none text-[#3d4d66]">—</div>
        <p className="mt-1.5 h-6 font-mono text-[7.5px] leading-tight text-[#4b5a72]">{row.note || 'not enough closed 1m history'}</p>
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative rounded-lg border p-1.5 text-left transition-colors ${
        selected ? 'border-[#3d4d66] bg-[#0e1524]' : 'border-[#1c2739] bg-[#0b111c] hover:border-[#3d4d66]'
      }`}
      title={`${row.expiry}m ${row.direction} · pWin ${(row.pWin * 100).toFixed(1)}% · conf ${row.confidence.toFixed(0)} · VR-predictability ${(row.predictability * 100).toFixed(0)}% · exp |move| ${fmtPrice(row.expectedMove, '')}${isBest ? ' · the oracle\'s best pick this bar' : ''}`}
    >
      {isBest && <span className="absolute -top-1.5 right-1 rounded bg-amber-400 px-1 font-mono text-[7px] font-bold uppercase text-[#0b111c]">best</span>}
      <div className="flex items-center justify-between">
        <span className={`font-mono text-[11px] font-bold ${accent}`}>{row.expiry}m</span>
        <span className={`font-mono text-[13px] font-bold leading-none ${call ? 'text-emerald-300' : put ? 'text-rose-300' : 'text-[#7c8aa5]'}`}>
          {call ? '▲' : put ? '▼' : '—'}
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={`font-mono text-[13px] font-bold leading-none ${call ? 'text-emerald-300' : put ? 'text-rose-300' : 'text-[#7c8aa5]'}`}>
          {(row.pWin * 100).toFixed(0)}%
        </span>
        <span className="font-mono text-[7.5px] uppercase tracking-wider text-[#4b5a72]">pWin</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-[#101828]">
        <div
          className={`h-full ${call ? 'bg-emerald-500/70' : put ? 'bg-rose-500/70' : 'bg-[#3d4d66]'}`}
          style={{ width: `${Math.max(6, Math.min(100, winPct))}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[7.5px] text-[#4b5a72]">
        <span title="calibrated confidence (own record applied)">conf {row.confidence.toFixed(0)}</span>
        <span title="expected |move| over the window">±{fmtPrice(row.expectedMove, '')}</span>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <TrackBadge cal={row.calibration} />
        <span className="font-mono text-[7.5px] text-[#4b5a72]" title="time until this window's anchor bar closes (system clock)">{windowCloseLabel(row.targetBarTime, nowSec)}</span>
      </div>
    </button>
  )
}

function ResolutionRow({ r }: { r: NextExpiryStatsResponse['recent'][number] }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[9px]">
      <span className={r.hit ? 'text-emerald-300' : 'text-rose-300'}>{r.hit ? '✓' : '✗'}</span>
      <span className="text-[#dbe4f0]">{r.asset}</span>
      <span className={`${EXPIRY_ACCENT[r.expiry] ?? 'text-[#7c8aa5]'}`}>{r.expiry}m</span>
      <span className={r.predicted === 'call' ? 'text-emerald-300' : 'text-rose-300'}>{r.predicted}</span>
      <span className="text-[#3d4d66]">@{(r.pUp * 100).toFixed(0)}%</span>
      <span className="ml-auto text-[#7c8aa5]">{r.actual} {(r.exit - r.entry >= 0 ? '+' : '')}{fmtPrice(r.exit - r.entry, r.asset)}</span>
    </div>
  )
}

export default function NextExpiryPanel({ asset, closedTick, onClose, onOpenOracle }: NextExpiryPanelProps) {
  const [pred, setPred] = useState<NextExpiryPrediction | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [stats, setStats] = useState<NextExpiryStatsResponse | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))

  const load = useCallback(async () => {
    try {
      const res = await getNextExpiry(asset)
      if (res.ok && res.prediction) {
        setPred(res.prediction)
        setErr(null)
      } else {
        setPred(null)
        setErr(res.error ?? 'expiry oracle unavailable')
      }
      const st = await getNextExpiryStats()
      if (st.ok) setStats(st)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [asset])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), FALLBACK_POLL_MS)
    return () => clearInterval(t)
  }, [load, closedTick])

  // 1s clock for the window-close countdowns - the browser's own clock, so
  // every countdown is the operator's system time by construction
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  // reset the manual selection when the asset changes
  useEffect(() => setSelected(null), [asset])

  const recordFor = stats?.records.find((r) => r.asset === asset)
  const recent = (stats?.recent ?? []).filter((r) => r.asset === asset).slice(0, 8)
  const selectedRow = pred?.rows.find((r) => r.expiry === (selected ?? pred.best?.expiry ?? null)) ?? null
  const bestExpiry = pred?.best?.expiry ?? null

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-sky-300" />
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#dbe4f0]">Next-Expiry Oracle</h3>
        <span className="font-mono text-[9px] text-[#7c8aa5]">{asset} · 1m base</span>
        {onOpenOracle && (
          <button
            type="button"
            onClick={() => onOpenOracle(asset)}
            className="ml-auto rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-amber-500/40 hover:text-amber-300"
            title="open the Next-Candle Oracle for this asset"
          >
            → candle
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className={`rounded border border-[#1c2739] px-1.5 py-px font-mono text-[9px] text-[#7c8aa5] hover:border-rose-500/40 hover:text-rose-300 ${onOpenOracle ? '' : 'ml-auto'}`}
        >
          close
        </button>
      </div>

      {err && (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 font-mono text-[9px] text-amber-300">
          {err} - the expiry oracle refuses to guess without enough closed 1m history.
        </div>
      )}

      {pred && (
        <>
          {/* best pick banner - or the honest "wait" */}
          <div
            className={`rounded-lg border px-2.5 py-2 ${
              pred.best && pred.best.direction === 'call'
                ? 'border-emerald-500/40 bg-emerald-500/10'
                : pred.best && pred.best.direction === 'put'
                  ? 'border-rose-500/40 bg-rose-500/10'
                  : 'border-[#1c2739] bg-[#0b111c]'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`font-mono text-lg font-bold leading-none ${pred.best ? (pred.best.direction === 'call' ? 'text-emerald-300' : 'text-rose-300') : 'text-[#7c8aa5]'}`}>
                {pred.best ? (pred.best.direction === 'call' ? '▲' : '▼') : '—'}
              </span>
              <div className="flex flex-col">
                <span className={`font-mono text-[11px] font-bold uppercase tracking-wider ${pred.best ? (pred.best.direction === 'call' ? 'text-emerald-300' : 'text-rose-300') : 'text-[#7c8aa5]'}`}>
                  {pred.best ? `next expiry: ${pred.best.expiry}m ${pred.best.direction}` : 'no edge right now - wait'}
                </span>
                <span className="font-mono text-[9px] text-[#7c8aa5]">{pred.note}</span>
              </div>
              {pred.best && (
                <div className="ml-auto flex flex-col items-center">
                  <span className="font-mono text-lg font-bold leading-none text-[#dbe4f0]">{(pred.best.pWin * 100).toFixed(0)}%</span>
                  <span className="font-mono text-[8px] uppercase tracking-wider text-[#4b5a72]">pWin</span>
                </div>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {regimeChip(pred.regime)}
              {sessionChip(pred.session)}
              <span
                className={`rounded border px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-wider ${pred.halfLifeMin ? 'border-teal-500/40 text-teal-300' : 'border-[#3d4d66] text-[#7c8aa5]'}`}
                title="OU reversion half-life on the 1m base - the expiry compass: fades pay closest to it"
              >
                {pred.halfLifeMin ? `half-life ~${pred.halfLifeMin}m` : 'no half-life'}
              </span>
              <span className="rounded border border-[#3d4d66] px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-[#7c8aa5]">spot {fmtPrice(pred.price, pred.asset)}</span>
            </div>
          </div>

          {/* the ladder: one card per expiry */}
          <div className="grid grid-cols-5 gap-1.5">
            {pred.rows.map((row) => (
              <ExpiryCard
                key={row.expiry}
                row={row}
                selected={(selected ?? bestExpiry ?? row.expiry) === row.expiry}
                isBest={bestExpiry === row.expiry}
                nowSec={nowSec}
                onSelect={() => setSelected(row.expiry)}
              />
            ))}
          </div>

          {/* the selected rung's model panel */}
          {selectedRow && selectedRow.drivers.length > 0 && (
            <div>
              <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
                {selectedRow.expiry}m models · {selectedRow.driversActive} fused
                {selectedRow.calibration && selectedRow.confidence !== selectedRow.rawConfidence && (
                  <span className="ml-1.5 normal-case text-[#4b5a72]" title="raw fusion confidence vs the calibrated read">
                    raw {selectedRow.rawConfidence.toFixed(0)}% → calibrated {selectedRow.confidence.toFixed(0)}%
                  </span>
                )}
              </p>
              <div className="flex flex-col gap-1">
                {selectedRow.drivers.map((d) => (
                  <DriverRow key={d.name} d={d} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* this pair's ledger + the universe-wide expiry summary */}
      {stats && (recordFor || stats.expirySummary.some((s) => s.n > 0)) && (
        <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-2">
          {recordFor ? (
            <p className="font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">
              expiry ledger · {asset} · n={recordFor.n} · streak {recordFor.streak}
            </p>
          ) : (
            <p className="font-mono text-[9px] uppercase tracking-wider text-[#4b5a72]">expiry ledger · universe</p>
          )}
          <div className="mt-1 flex flex-col gap-0.5">
            {recent.length === 0 && <p className="font-mono text-[8.5px] text-[#3d4d66]">resolutions land here as each window's anchor bar closes…</p>}
            {recent.map((r, i) => (
              <ResolutionRow key={`${r.targetBarTime}-${r.expiry}-${i}`} r={r} />
            ))}
          </div>
          {stats.expirySummary.some((s) => s.n > 0) && (
            <div className="mt-1.5 flex flex-wrap gap-1 border-t border-[#1c2739] pt-1.5">
              {stats.expirySummary.filter((s) => s.n > 0).map((s) => (
                <span
                  key={s.expiry}
                  className={`rounded border px-1 py-px font-mono text-[8px] ${s.hitRate >= 0.55 ? 'border-emerald-500/40 text-emerald-300' : s.hitRate >= 0.48 ? 'border-[#3d4d66] text-[#7c8aa5]' : 'border-rose-500/40 text-rose-300'}`}
                  title={`universe-wide resolved record at the ${s.expiry}m expiry (every pair, lifetime)`}
                >
                  {s.expiry}m {s.n}: {(s.hitRate * 100).toFixed(0)}%
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
