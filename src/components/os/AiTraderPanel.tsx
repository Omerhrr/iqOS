'use client'

// IQAIR//OS - AI Trader panel: "its like having meta or auto trader with
// brains" per direct instruction. Shows the config (asset/tf/interval/
// stake/min confidence/expiry choices/live-vs-shadow switch), current
// status (running, cycle count, last error), and the decision log (every
// cycle including skips, with the model's own reasoning) - this is the one
// place "trust me" isn't good enough, so the log is the point, not an
// afterthought.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { AiTraderConfig, AiTraderDecision, AiTraderScanMode, AiTraderStatus, AssetRow, Timeframe } from '@/lib/os/client'
import { fmtTime, osGet, osPost } from '@/lib/os/client'
import AssetPicker from './AssetPicker'

interface Props {
  assets: AssetRow[]
  onError: (m: string) => void
}

const TFS: Timeframe[] = ['1m', '2m', '5m', '15m']

export default function AiTraderPanel({ assets, onError }: Props) {
  const [status, setStatus] = useState<AiTraderStatus | null>(null)
  const [decisions, setDecisions] = useState<AiTraderDecision[]>([])
  const [draft, setDraft] = useState<AiTraderConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [expiryText, setExpiryText] = useState('3,5')
  const [clearing, setClearing] = useState(false)
  const [clearArmed, setClearArmed] = useState(false)

  // Decision log height is user-draggable (grab the handle above the table
  // and drag up to grow it, down to shrink) instead of a fixed flex-1 split -
  // the log is the point of this panel, so it should be easy to give it most
  // of the screen when you're actually reading through reasoning.
  const [histHeight, setHistHeight] = useState(240)
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null)

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragState.current = { startY: e.clientY, startHeight: histHeight }
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return
      // dragging UP (clientY decreases) should GROW the log, so the delta is inverted.
      const delta = dragState.current.startY - ev.clientY
      setHistHeight(Math.max(120, Math.min(900, dragState.current.startHeight + delta)))
    }
    const onUp = () => {
      dragState.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [histHeight])

  const load = useCallback(async () => {
    try {
      const d = await osGet<{ ok: boolean } & AiTraderStatus>('/ai_trader_status')
      if (d.ok) {
        setStatus(d)
        setDraft((prev) => prev ?? d.config)
        setExpiryText((prev) => (prev === '3,5' ? d.config.expiryChoices.join(',') : prev))
      }
    } catch {
      // kernel not up yet
    }
    try {
      const d = await osGet<{ ok: boolean; decisions: AiTraderDecision[] }>('/ai_trader_decisions', { limit: 60 })
      if (d.ok) setDecisions(d.decisions)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 8000)
    return () => clearInterval(t)
  }, [load])

  const save = async (patch: Partial<AiTraderConfig>) => {
    if (!draft) return
    setSaving(true)
    try {
      const res = await osPost<{ ok: boolean; config?: AiTraderConfig; error?: string }>('/ai_trader_config', patch)
      if (res.ok && res.config) {
        setDraft(res.config)
        setStatus((s) => (s ? { ...s, config: res.config!, enabled: res.config!.enabled, live: res.config!.live } : s))
      } else onError(res.error ?? 'config rejected')
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const clearDecisions = async () => {
    if (!clearArmed) {
      setClearArmed(true)
      setTimeout(() => setClearArmed(false), 4000)
      return
    }
    setClearing(true)
    try {
      const res = await osPost<{ ok: boolean; error?: string }>('/ai_trader_clear_decisions')
      if (res.ok) setDecisions([])
      else onError(res.error ?? 'clear failed')
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setClearing(false)
      setClearArmed(false)
    }
  }

  const runNow = async () => {
    setRunning(true)
    try {
      const res = await osPost<{ ok: boolean; decisions?: AiTraderDecision[]; error?: string }>('/ai_trader_run_now')
      if (!res.ok) onError(res.error ?? 'cycle failed')
      void load()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  if (!draft || !status) {
    return <div className="p-3 font-mono text-[10px] text-[#4b5a72]">loading AI Trader…</div>
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2 font-mono text-[10px]">
      <div className="flex flex-wrap items-center gap-3 rounded border border-violet-500/30 bg-[#0b0817] p-2">
        <span className="font-bold uppercase tracking-wider text-violet-300">✦ AI Trader</span>
        <span className="text-[#aab6cc]">
          scans {draft.scanMode === 'single' ? draft.asset : draft.scanMode === 'selected' ? `${draft.selectedAssets.length || 0} selected pair(s)` : 'the Screener\'s top-ranked pairs'} on {draft.tf} every {draft.intervalMin}min (max {draft.maxScanPerCycle}/cycle) - plays the human at the desk: reads the raw price action itself, weighs the other panels as a second opinion (not a vote), decides direction + expiry together, and sides with its own read when they disagree. Most cycles should SKIP. Max {draft.maxConcurrent} concurrent position(s) while LIVE.
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded border border-[#1c2739] bg-[#0b0f17] p-2">
        <span className="text-[#7c8aa5]">scan mode</span>
        {(
          [
            ['single', 'single pair'],
            ['selected', 'selected pairs'],
            ['global', 'global (screener-ranked)'],
          ] as [AiTraderScanMode, string][]
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => setDraft({ ...draft, scanMode: mode })}
            className={`rounded px-2 py-1 text-[9px] uppercase tracking-wide ${
              draft.scanMode === mode ? 'bg-violet-600 text-white' : 'border border-[#1c2739] text-[#7c8aa5] hover:text-[#dbe4f0]'
            }`}
          >
            {label}
          </button>
        ))}
        {draft.scanMode !== 'single' && (
          <label className="ml-auto flex items-center gap-1.5">
            <span className="text-[#7c8aa5]">max pairs/cycle</span>
            <Input
              type="number"
              min={1}
              max={20}
              value={draft.maxScanPerCycle}
              onChange={(e) => setDraft({ ...draft, maxScanPerCycle: Math.max(1, Math.min(20, Number(e.target.value) || 5)) })}
              className="h-6 w-14 bg-[#070c15] text-[9.5px] text-[#dbe4f0]"
            />
          </label>
        )}
      </div>

      {draft.scanMode === 'selected' && (
        <div className="flex flex-wrap items-center gap-1.5 rounded border border-[#1c2739] bg-[#0b0f17] p-2">
          <span className="text-[#7c8aa5]">pairs:</span>
          {draft.selectedAssets.length === 0 && <span className="text-[#4b5a72]">none picked yet - add at least one below</span>}
          {draft.selectedAssets.map((t) => (
            <span key={t} className="flex items-center gap-1 rounded bg-[#101828] px-1.5 py-0.5 text-[#dbe4f0]">
              {t}
              <button
                type="button"
                onClick={() => setDraft({ ...draft, selectedAssets: draft.selectedAssets.filter((x) => x !== t) })}
                className="text-[#7c8aa5] hover:text-rose-300"
              >
                ×
              </button>
            </span>
          ))}
          <AssetPicker
            tickers={assets.length ? assets.map((a) => a.ticker) : [draft.asset]}
            value="+ add pair"
            onChange={(t) => {
              if (!draft.selectedAssets.includes(t)) setDraft({ ...draft, selectedAssets: [...draft.selectedAssets, t] })
            }}
            className="w-32"
          />
        </div>
      )}

      {draft.scanMode === 'global' && (
        <div className="rounded border border-[#1c2739] bg-[#0b0f17] p-2 text-[#7c8aa5]">
          scans whatever the Screener currently ranks as the best opportunities across the whole instrument universe for this timeframe (falls back to the raw asset list if the screener hasn&apos;t swept yet) - no pair list to maintain.
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 rounded border border-[#1c2739] bg-[#0b0f17] p-2 sm:grid-cols-4">
        {draft.scanMode === 'single' && (
          <label className="flex flex-col gap-1">
            <span className="text-[#7c8aa5]">asset</span>
            <AssetPicker
              tickers={assets.length ? assets.map((a) => a.ticker) : [draft.asset]}
              value={draft.asset}
              onChange={(t) => setDraft({ ...draft, asset: t })}
              className="w-full"
            />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[#7c8aa5]">tf</span>
          <select
            value={draft.tf}
            onChange={(e) => setDraft({ ...draft, tf: e.target.value as Timeframe })}
            className="rounded border border-[#1c2739] bg-[#070c15] px-1.5 py-1 text-[#dbe4f0]"
          >
            {TFS.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[#7c8aa5]">interval (min)</span>
          <Input
            type="number"
            min={1}
            value={draft.intervalMin}
            onChange={(e) => setDraft({ ...draft, intervalMin: Math.max(1, Number(e.target.value) || 1) })}
            className="h-6 bg-[#070c15] text-[9.5px] text-[#dbe4f0]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[#7c8aa5]">stake $</span>
          <Input
            type="number"
            min={1}
            value={draft.stake}
            onChange={(e) => setDraft({ ...draft, stake: Math.max(1, Number(e.target.value) || 1) })}
            className="h-6 bg-[#070c15] text-[9.5px] text-[#dbe4f0]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[#7c8aa5]">min confidence</span>
          <Input
            type="number"
            min={0}
            max={100}
            value={draft.minConfidence}
            onChange={(e) => setDraft({ ...draft, minConfidence: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
            className="h-6 bg-[#070c15] text-[9.5px] text-[#dbe4f0]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[#7c8aa5]">expiry choices (min, comma-sep)</span>
          <Input
            value={expiryText}
            onChange={(e) => setExpiryText(e.target.value)}
            onBlur={() => {
              const vals = expiryText.split(',').map((s) => Number(s.trim())).filter((n) => n > 0)
              if (vals.length) setDraft({ ...draft, expiryChoices: vals })
            }}
            className="h-6 bg-[#070c15] text-[9.5px] text-[#dbe4f0]"
          />
        </label>
        <label className="col-span-2 flex flex-col gap-1 sm:col-span-4">
          <span className="text-[#7c8aa5]">
            this app&apos;s own URL override (only matters if there&apos;s no APP_URL env var on trading-core - currently resolved to:{' '}
            <span className="font-bold text-cyan-300">{status.resolvedAppUrl}</span>)
          </span>
          <Input
            value={draft.appUrl ?? ''}
            onChange={(e) => setDraft({ ...draft, appUrl: e.target.value || undefined })}
            placeholder="leave blank unless APP_URL isn't set in trading-core's environment"
            className="h-6 bg-[#070c15] text-[9.5px] text-[#dbe4f0]"
          />
        </label>
        <div className="col-span-2 flex items-center gap-4">
          <label className="flex items-center gap-1.5">
            <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} />
            <span className="text-[#aab6cc]">loop enabled</span>
          </label>
          <label className="flex items-center gap-1.5" title="shadow mode logs every decision but places no real order - flip this only once you trust its reasoning">
            <Switch checked={draft.live} onCheckedChange={(v) => setDraft({ ...draft, live: v })} />
            <span className={draft.live ? 'font-bold text-rose-300' : 'text-emerald-300'}>{draft.live ? 'LIVE (real orders)' : 'shadow (logging only)'}</span>
          </label>
          <label className="flex items-center gap-1.5" title="max OPEN positions this trader may hold at once - LIVE only. At the cap, a cycle skips entirely (no analysis, no LLM call) instead of deciding something it has no room to act on.">
            <span className="text-[#7c8aa5]">max concurrent</span>
            <Input
              type="number"
              min={1}
              value={draft.maxConcurrent}
              onChange={(e) => setDraft({ ...draft, maxConcurrent: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
              className="h-6 w-14 bg-[#070c15] text-[9.5px] text-[#dbe4f0]"
            />
          </label>
        </div>
        <div className="col-span-2 flex items-center justify-end gap-2 sm:col-span-4">
          <Button size="sm" disabled={saving} className="h-6 bg-violet-600 px-2 text-[9px] font-bold uppercase tracking-wider text-white hover:bg-violet-500" onClick={() => void save(draft)}>
            {saving ? 'saving...' : 'save config'}
          </Button>
          <Button size="sm" variant="outline" disabled={running} className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5]" onClick={() => void runNow()}>
            {running ? 'deciding...' : 'run a cycle now'}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded border border-[#1c2739] bg-[#0b0f17] p-2 text-[#aab6cc]">
        <span>cycles: {status.cycles}</span>
        {/* fmtTime takes epoch SECONDS (it multiplies by 1000 internally) -
            these fields are kernel epoch-seconds; passing them pre-multiplied
            double-counted and rendered garbage clock times. */}
        <span>last run: {status.lastRunTs ? fmtTime(status.lastRunTs) : 'never'}</span>
        <span>next run: {status.nextRunTs ? fmtTime(status.nextRunTs) : '-'}</span>
        {status.lastError && <span className="text-rose-300">last error: {status.lastError}</span>}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[#7c8aa5]">decision log ({decisions.length}) - drag the handle to resize</span>
        <Button
          size="sm"
          variant="outline"
          disabled={clearing || decisions.length === 0}
          onClick={() => void clearDecisions()}
          className={`h-6 px-2 text-[9px] uppercase ${clearArmed ? 'border-rose-500/50 text-rose-300' : 'border-[#1c2739] text-[#7c8aa5]'}`}
        >
          {clearing ? 'clearing...' : clearArmed ? 'click again to confirm' : 'clear log'}
        </Button>
      </div>

      {/* Drag handle - grab and drag up to grow the log, down to shrink it. */}
      <div
        onMouseDown={onDragStart}
        className="group flex h-2 w-full shrink-0 cursor-row-resize items-center justify-center rounded-sm hover:bg-[#1c2739]"
        title="drag to resize the decision log"
      >
        <div className="h-0.5 w-10 rounded-full bg-[#1c2739] group-hover:bg-violet-400" />
      </div>

      <div className="shrink-0 overflow-y-auto rounded border border-[#1c2739]" style={{ height: histHeight }}>
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-[#0b0f17] text-[#7c8aa5]">
            <tr>
              <th className="px-1.5 py-1">time</th>
              <th className="px-1.5 py-1">asset/tf</th>
              <th className="px-1.5 py-1">decision</th>
              <th className="px-1.5 py-1">conf</th>
              <th className="px-1.5 py-1">expiry</th>
              <th className="px-1.5 py-1">acted</th>
              <th className="px-1.5 py-1">reasoning</th>
            </tr>
          </thead>
          <tbody>
            {decisions.length === 0 && (
              <tr>
                <td colSpan={7} className="px-1.5 py-2 text-[#4b5a72]">
                  no decisions yet - enable the loop, or use &quot;run a cycle now&quot;.
                </td>
              </tr>
            )}
            {decisions.map((d) => (
              <tr key={d.id} className="border-t border-[#1c2739] align-top">
                <td className="whitespace-nowrap px-1.5 py-1 text-[#7c8aa5]">{fmtTime(d.ts)}</td>
                <td className="whitespace-nowrap px-1.5 py-1">
                  {d.asset} {d.tf}
                </td>
                <td
                  className={`px-1.5 py-1 font-bold uppercase ${
                    d.direction === 'call' ? 'text-emerald-300' : d.direction === 'put' ? 'text-rose-300' : 'text-[#7c8aa5]'
                  }`}
                >
                  {d.direction}
                </td>
                <td className="px-1.5 py-1">{d.confidence.toFixed(0)}%</td>
                <td className="px-1.5 py-1">{d.expiryMin ?? '-'}m</td>
                <td className="px-1.5 py-1">{d.acted ? (d.live ? 'placed' : 'shadow') : '-'}</td>
                <td className="px-1.5 py-1 text-[#aab6cc]">{d.error ? <span className="text-rose-300">{d.error}</span> : d.reasoning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
