'use client'

// IQAIR//OS - Brain Trader panel (plugins/braintrader.ts). Self-contained: polls its own status, no page-level wiring.
// An MSL strategy signals; an AI reviewer says go/no and picks the expiry. SHADOW by default. The three hit rates (proposed / approved / vetoed) are how you find out whether the reviewer adds anything.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { osGet, osPost } from '@/lib/os/client'

interface Cfg {
  enabled: boolean
  metaStrategyId: string
  minConfidence: number
  live: boolean
  tf: string
  direction: 'call' | 'put' | 'both'
  expiriesSec: number[]
  defaultExpirySec: number
  requireAi: boolean
  maxReviewsPerHour: number
  stake: number
  maxOpen: number
  marketScope: 'all' | 'real' | 'otc'
  cooldownSec: number
}
interface Group {
  n: number
  resolved: number
  wins: number
  losses: number
  ties: number
  hitRate: number | null
}
interface Status {
  enabled: boolean
  live: boolean
  mode: string
  active: boolean
  config: Cfg
  runtime: { reads: number; proposals: number; trades: number; wins: number; losses: number; pnlTotal: number; openCount: number; lastAction?: string; lastRejection?: string; lastReason?: string }
  stats: { proposed: Group; approved: Group; vetoed: Group; reviewerLiftPts: number | null; note: string }
  reviewsLastHour: number
}
interface Decision {
  id: string
  ts: number
  asset: string
  direction: 'call' | 'put'
  strategyName: string
  confidence: number
  notes: string
  expirySec: number
  status: string
  ai?: { go: boolean; confidence: number; reason: string }
  placed: boolean
  placeError?: string
  outcome?: 'win' | 'loss' | 'tie'
}

const pct = (v: number | null) => (v === null ? '-' : `${(v * 100).toFixed(0)}%`)
const STATUS_CLS: Record<string, string> = {
  approved: 'text-emerald-400',
  no_ai_needed: 'text-emerald-400',
  vetoed: 'text-amber-400',
  ai_unavailable: 'text-rose-400',
  rate_limited: 'text-[#7c8aa5]',
}

export default function BrainTraderPanel() {
  const [st, setSt] = useState<Status | null>(null)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [open, setOpen] = useState(false)
  const [cfgOpen, setCfgOpen] = useState(false)
  const [armLive, setArmLive] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [draft, setDraft] = useState<Cfg | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await osGet<{ ok: boolean } & Status>('/brain_trader_status')
      if (d.ok) setSt(d)
      if (open) {
        const l = await osGet<{ ok: boolean; decisions: Decision[] }>('/brain_trader_decisions', { limit: 40 })
        if (l.ok) setDecisions(l.decisions)
      }
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [open])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current) }, [])

  const patch = async (p: Partial<Cfg>) => {
    try {
      await osPost('/brain_trader_config', p)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  if (!st) {
    return err ? <div className="shrink-0 rounded border border-[#1c2739] bg-[#0d1420] px-2.5 py-1.5 font-mono text-[9px] text-amber-500/70">brain trader: {err}</div> : null
  }
  const c = st.config
  const state = !c.enabled
    ? { label: 'off', cls: 'border-[#1c2739] bg-[#101828] text-[#4b5a72]', dot: 'bg-[#2a3850]' }
    : !c.live
      ? { label: 'SHADOW · logging only', cls: 'border-sky-500/40 bg-sky-500/10 text-sky-300', dot: 'animate-pulse bg-sky-400' }
      : st.mode === 'auto'
        ? { label: 'LIVE · trading', cls: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300', dot: 'animate-pulse bg-emerald-400' }
        : { label: 'live armed · human mode', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300', dot: 'bg-amber-500' }
  const s = st.stats

  return (
    <div className="shrink-0 rounded border border-[#1c2739] bg-[#0d1420] px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#7c8aa5]">brain trader</span>
        <span className={`flex items-center gap-1.5 rounded border px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-wider ${state.cls}`}>
          <span className={`h-1 w-1 rounded-full ${state.dot}`} />
          {state.label}
        </span>
        <span className="font-mono text-[9px] text-[#4b5a72]">
          {c.tf} · conf≥{c.minConfidence} · expiry {c.expiriesSec.join('/')}s · {c.requireAi ? 'AI reviewer' : 'NO reviewer'} · {st.reviewsLastHour}/{c.maxReviewsPerHour} reviews/h
        </span>
        <span className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 font-mono text-[8px] uppercase text-[#7c8aa5]">
            on <Switch checked={c.enabled} onCheckedChange={(v) => void patch({ enabled: v })} />
          </label>
          {c.live ? (
            <Button size="sm" onClick={() => void patch({ live: false })} className="h-5 rounded bg-[#1c2739] px-2 text-[9px] font-bold uppercase tracking-wider text-[#aab6cc] hover:bg-[#243352]">
              back to shadow
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                if (!armLive) {
                  setArmLive(true)
                  armTimer.current = setTimeout(() => setArmLive(false), 6000)
                } else {
                  setArmLive(false)
                  void patch({ live: true })
                }
              }}
              className={`h-5 rounded px-2 text-[9px] font-bold uppercase tracking-wider ${armLive ? 'bg-rose-600 text-white hover:bg-rose-500' : 'bg-[#1c2739] text-[#aab6cc] hover:bg-[#243352]'}`}
            >
              {armLive ? 'confirm: real orders' : 'go live'}
            </Button>
          )}
          <Button size="sm" onClick={() => { setCfgOpen((o) => !o); setDraft(c) }} className="h-5 rounded bg-[#1c2739] px-2 text-[9px] font-bold uppercase tracking-wider text-[#aab6cc] hover:bg-[#243352]">
            Configure
          </Button>
          <Button size="sm" onClick={() => setOpen((o) => !o)} className="h-5 rounded bg-[#1c2739] px-2 text-[9px] font-bold uppercase tracking-wider text-[#aab6cc] hover:bg-[#243352]">
            {open ? 'hide log' : 'decisions'}
          </Button>
        </span>
      </div>

      <p className="mt-0.5 font-mono text-[8px] text-[#3d4c66]">
        reads {st.runtime.reads} · signals {st.runtime.proposals} · orders {st.runtime.trades} · open {st.runtime.openCount}
        {st.runtime.lastAction && <span title={st.runtime.lastAction}> · last: {st.runtime.lastAction}</span>}
        {st.runtime.lastRejection && <span className="text-amber-500/70"> · {st.runtime.lastRejection}</span>}
      </p>

      <div className="mt-1 grid grid-cols-4 gap-x-3 font-mono text-[9px] text-[#7c8aa5]">
        <span />
        <span>signals</span>
        <span>scored</span>
        <span>hit rate</span>
        {([['all signals', s.proposed], ['AI approved', s.approved], ['AI vetoed', s.vetoed]] as const).map(([label, g]) => (
          <div key={label} className="contents">
            <span className="text-[#aab6cc]">{label}</span>
            <span>{g.n}</span>
            <span>{g.resolved}</span>
            <span>{pct(g.hitRate)}</span>
          </div>
        ))}
      </div>
      <p className="mt-0.5 font-mono text-[8px] text-[#3d4c66]">
        reviewer lift {s.reviewerLiftPts === null ? 'n/a' : `${s.reviewerLiftPts > 0 ? '+' : ''}${s.reviewerLiftPts} pts`} - noise until each group has hundreds of scored outcomes. Not a probability, not a win rate on your account.
      </p>

      {cfgOpen && draft && (
        <div className="mt-1.5 grid grid-cols-2 gap-2 rounded border border-[#1c2739] p-2 font-mono text-[9px] text-[#aab6cc] md:grid-cols-4">
          {([
            ['min strategy confidence %', 'minConfidence'],
            ['stake $', 'stake'],
            ['max open', 'maxOpen'],
            ['cooldown s', 'cooldownSec'],
            ['reviews / hour', 'maxReviewsPerHour'],
          ] as const).map(([label, key]) => (
            <label key={key} className="flex flex-col gap-0.5">
              {label}
              <Input type="number" value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} className="h-6 bg-[#101828] px-1 text-[10px]" />
            </label>
          ))}
          <label className="flex flex-col gap-0.5">
            allowed expiries (s)
            <Input
              value={draft.expiriesSec.join(',')}
              onChange={(e) => setDraft({ ...draft, expiriesSec: e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0) })}
              className="h-6 bg-[#101828] px-1 text-[10px]"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            timeframe
            <Input value={draft.tf} onChange={(e) => setDraft({ ...draft, tf: e.target.value })} className="h-6 bg-[#101828] px-1 text-[10px]" />
          </label>
          <label className="flex items-center gap-1.5">
            <Switch checked={draft.requireAi} onCheckedChange={(v) => setDraft({ ...draft, requireAi: v })} /> AI reviewer required
          </label>
          <Button
            size="sm"
            onClick={async () => {
              // the strategy itself is picked in the Brain tab - never send a stale copy of it from here
              const { metaStrategyId: _id, ...rest } = draft
              void _id
              await patch(rest)
              setCfgOpen(false)
            }}
            className="h-6 self-end rounded bg-sky-600 px-3 text-[9px] font-bold uppercase text-white hover:bg-sky-500"
          >
            Save
          </Button>
        </div>
      )}

      {open && (
        <div className="mt-1.5 max-h-56 space-y-1 overflow-y-auto">
          {decisions.length === 0 && <p className="font-mono text-[9px] text-[#4b5a72]">no signals yet - the strategy only fires when its regime, level and confirmations line up, which is rare by design.</p>}
          {decisions.map((d) => (
            <div key={d.id} className="rounded border border-[#1c2739] px-2 py-1 font-mono text-[9px]">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="text-[#aab6cc]">{new Date(d.ts * 1000).toLocaleTimeString()}</span>
                <span className="font-bold text-[#cbd5e1]">{d.asset}</span>
                <span className={d.direction === 'call' ? 'text-emerald-400' : 'text-rose-400'}>{d.direction.toUpperCase()}</span>
                <span className="text-[#7c8aa5]">{d.expirySec}s · {d.strategyName} · conf {d.confidence}</span>
                <span className={STATUS_CLS[d.status] ?? 'text-[#7c8aa5]'}>{d.status.replace('_', ' ')}</span>
                {d.placed && <span className="text-emerald-300">ORDER</span>}
                {d.outcome && <span className={d.outcome === 'win' ? 'text-emerald-400' : d.outcome === 'loss' ? 'text-rose-400' : 'text-[#7c8aa5]'}>would have {d.outcome}</span>}
              </div>
              <p className="text-[#4b5a72]">strategy: {d.notes || '(no notes)'}</p>
              {d.ai && <p className="text-[#7c8aa5]">AI ({d.ai.confidence}): {d.ai.reason}</p>}
              {d.placeError && <p className="text-amber-500/70">{d.placeError}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
