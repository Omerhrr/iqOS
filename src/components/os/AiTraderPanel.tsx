'use client'

// IQAIR//OS - AI Trader panel: "its like having meta or auto trader with
// brains" per direct instruction. Shows the config (asset/tf/interval/
// stake/min confidence/expiry choices/live-vs-shadow switch), current
// status (running, cycle count, last error), and the decision log (every
// cycle including skips, with the model's own reasoning) - this is the one
// place "trust me" isn't good enough, so the log is the point, not an
// afterthought.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { AiTraderConfig, AiTraderDecision, AiTraderStatus, AssetRow, Timeframe } from '@/lib/os/client'
import { fmtTime, osGet, osPost } from '@/lib/os/client'

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

  const runNow = async () => {
    setRunning(true)
    try {
      const res = await osPost<{ ok: boolean; decision?: AiTraderDecision; error?: string }>('/ai_trader_run_now')
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
          scans {draft.asset} {draft.tf} every {draft.intervalMin}min, decides with LLM reasoning over the same panel reads the other auto-traders use - most cycles should SKIP.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 rounded border border-[#1c2739] bg-[#0b0f17] p-2 sm:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-[#7c8aa5]">asset</span>
          <select
            value={draft.asset}
            onChange={(e) => setDraft({ ...draft, asset: e.target.value })}
            className="rounded border border-[#1c2739] bg-[#070c15] px-1.5 py-1 text-[#dbe4f0]"
          >
            {assets.map((a) => (
              <option key={a.ticker} value={a.ticker}>
                {a.ticker}
              </option>
            ))}
          </select>
        </label>
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
          <span className="text-[#7c8aa5]">this app&apos;s own URL (how trading-core reaches it for decisions - same keys as Copilot, nothing else to set up)</span>
          <Input
            value={draft.appUrl ?? 'http://127.0.0.1:3000'}
            onChange={(e) => setDraft({ ...draft, appUrl: e.target.value })}
            placeholder="http://127.0.0.1:3000"
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
        <span>last run: {status.lastRunTs ? fmtTime(status.lastRunTs * 1000) : 'never'}</span>
        <span>next run: {status.nextRunTs ? fmtTime(status.nextRunTs * 1000) : '-'}</span>
        {status.lastError && <span className="text-rose-300">last error: {status.lastError}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded border border-[#1c2739] bg-[#0b0f17] p-2">
        <span className="text-[#7c8aa5]">decisions normally go through this app (same keys as Copilot) - this row is only trading-core&apos;s OWN fallback providers, used only if this app is unreachable:</span>
        {status.llm.providers.map((p) => (
          <span
            key={p.id}
            className={`rounded px-1.5 py-0.5 ${
              p.ready ? 'bg-emerald-500/15 text-emerald-300' : p.enabled ? 'bg-amber-500/15 text-amber-300' : 'bg-[#101828] text-[#4b5a72]'
            }`}
            title={p.enabled ? (p.ready ? `ready - ${p.model}` : 'enabled but missing its API key/config') : 'not enabled (USE_* flag unset or false)'}
          >
            {p.id}
          </span>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto rounded border border-[#1c2739]">
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
                <td className="whitespace-nowrap px-1.5 py-1 text-[#7c8aa5]">{fmtTime(d.ts * 1000)}</td>
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
