'use client'

// IQAIR//OS - Brain tab: the Brain Trader's own workspace, separate from the Autopilot bots.
//   1. MIND      what the brain thinks about one asset right now (regime, playbook, every reader's vote). Read-only, no AI call, no order.
//   2. STRATEGY  the brain's rules, editable: which playbooks run, which readers vote and how much, the regime / fib thresholds.
//   3. TRADER    on/off, shadow vs live, the AI reviewer's decisions and the proposed / approved / vetoed hit rates (BrainTraderPanel).
// The brain's confluence is agreement between correlated readers of the same candles - not a win probability.

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { osGet, osPost, type AssetRow } from '@/lib/os/client'
import BrainTraderPanel from './BrainTraderPanel'

type Family = 'fib' | 'smc' | 'candle' | 'amd' | 'wyckoff'
const FAMILIES: Family[] = ['fib', 'smc', 'candle', 'amd', 'wyckoff']
const FAMILY_LABEL: Record<Family, string> = { fib: 'Fibonacci', smc: 'SMC / ICT', candle: 'Candle patterns', amd: 'Accumulation · Manipulation · Distribution', wyckoff: 'Wyckoff' }

interface Strategy {
  playbooks: { reversal: boolean; continuation: boolean; range_fade: boolean }
  families: Record<Family, boolean>
  weights: Record<Family, number>
  minAgree: number
  trendEr: number
  rangeEr: number
  rangeEdge: number
  fibZoneLo: number
  fibZoneHi: number
  standAsideWhenVolatile: boolean
}
interface Comp {
  family: Family
  dir: number
  weight: number
  note: string
}
interface Read {
  ok: boolean
  regime: string
  playbook: string
  candidate: 'call' | 'put' | 'none'
  proposal: boolean
  direction: 'call' | 'put' | 'none'
  confluence: number
  agree: string[]
  oppose: string[]
  components: Comp[]
  reason: string
  invalidation: number
  price: number
  atr: number
  er: number
  volRank: number
}
interface Mind {
  asset: string
  tf: string
  bars: number
  lastBarTime: number | null
  read: Read
}

const PLAYBOOK_INFO: [keyof Strategy['playbooks'], string, string][] = [
  ['reversal', 'Reversal', 'Wyckoff phase C/D or an AMD reclaim/distribution names the direction (they must not disagree).'],
  ['continuation', 'Continuation', 'In a trending regime, trade with the trend.'],
  ['range_fade', 'Range fade', 'In a ranging regime, fade price when it sits at the edge of the 30-bar range.'],
]
const NUM_FIELDS: [keyof Strategy, string, number, number][] = [
  ['minAgree', 'readers that must agree (1-5)', 1, 1],
  ['trendEr', 'trend if efficiency ≥', 0.01, 0.1],
  ['rangeEr', 'range if efficiency ≤', 0.01, 0.02],
  ['rangeEdge', 'range edge (fraction)', 0.01, 0.05],
  ['fibZoneLo', 'fib zone from', 0.01, 0.1],
  ['fibZoneHi', 'fib zone to', 0.01, 0.2],
]

const voteCls = (d: number) => (d > 0 ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : d < 0 ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-[#1c2739] bg-[#101828] text-[#4b5a72]')

export default function BrainTab({ asset, assets, onError }: { asset: string; assets: AssetRow[]; onError?: (m: string) => void }) {
  const [pick, setPick] = useState(asset)
  const [mind, setMind] = useState<Mind | null>(null)
  const [mindErr, setMindErr] = useState<string | null>(null)
  const [strategy, setStrategy] = useState<Strategy | null>(null)
  const [draft, setDraft] = useState<Strategy | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => setPick(asset), [asset])

  const loadMind = useCallback(async () => {
    if (!pick) return
    try {
      const d = await osGet<{ ok: boolean; error?: string } & Mind>('/brain_trader_mind', { asset: pick })
      if (d.ok) {
        setMind(d)
        setMindErr(null)
      } else setMindErr(d.error ?? 'no read')
    } catch (e) {
      setMindErr(e instanceof Error ? e.message : String(e))
    }
  }, [pick])

  const loadStrategy = useCallback(async () => {
    try {
      const d = await osGet<{ ok: boolean; config: { strategy: Strategy } }>('/brain_trader_status')
      if (d.ok) {
        setStrategy(d.config.strategy)
        setDraft((prev) => (prev && dirty ? prev : d.config.strategy))
      }
    } catch {
      /* the trader panel below shows connection errors */
    }
  }, [dirty])

  useEffect(() => {
    void loadMind()
    const t = setInterval(() => void loadMind(), 5000)
    return () => clearInterval(t)
  }, [loadMind])
  useEffect(() => {
    void loadStrategy()
    const t = setInterval(() => void loadStrategy(), 8000)
    return () => clearInterval(t)
  }, [loadStrategy])

  const edit = (fn: (s: Strategy) => Strategy) => {
    setDraft((d) => (d ? fn(d) : d))
    setDirty(true)
  }
  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      await osPost('/brain_trader_config', { strategy: draft })
      setDirty(false)
      await loadStrategy()
      await loadMind()
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const r = mind?.read
  const regimeLabel: Record<string, string> = { trend_up: 'trending up', trend_down: 'trending down', range: 'ranging', volatile: 'volatile - stands aside', unclear: 'unclear' }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2">
      {/* ---------------- MIND ---------------- */}
      <section className="rounded border border-[#1c2739] bg-[#0d1420] p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#7c8aa5]">Brain · mind</h3>
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-6 rounded border border-[#1c2739] bg-[#101828] px-1 font-mono text-[10px] text-[#cbd5e1]">
            {!assets.some((a) => a.ticker === pick) && <option value={pick}>{pick}</option>}
            {assets.map((a) => (
              <option key={a.ticker} value={a.ticker}>{a.ticker}{a.otc ? ' (OTC)' : ''}</option>
            ))}
          </select>
          {mind && <span className="font-mono text-[9px] text-[#4b5a72]">{mind.tf} · {mind.bars} closed bars · read-only, no AI call, no order</span>}
        </div>

        {mindErr && <p className="mt-1.5 font-mono text-[9px] text-amber-500/70">{mindErr}</p>}
        {r && !r.ok && <p className="mt-1.5 font-mono text-[9px] text-[#7c8aa5]">{r.reason}</p>}
        {r && r.ok && (
          <>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px]">
              <span className="rounded border border-[#1c2739] bg-[#101828] px-1.5 py-px text-[#aab6cc]">regime: {regimeLabel[r.regime] ?? r.regime}</span>
              <span className="text-[#7c8aa5]">playbook: <span className="text-[#cbd5e1]">{r.playbook === 'none' ? '-' : r.playbook.replace('_', ' ')}</span></span>
              <span className={`rounded border px-1.5 py-px font-bold uppercase ${r.proposal ? (r.direction === 'call' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/50 bg-rose-500/10 text-rose-300') : 'border-[#1c2739] text-[#4b5a72]'}`}>
                {r.proposal ? `PROPOSES ${r.direction}` : r.candidate !== 'none' ? `leans ${r.candidate} - not enough` : 'no proposal'}
              </span>
              {r.candidate !== 'none' && <span className="text-[#7c8aa5]">agreement {r.confluence}/100 ({r.agree.length} agree · {r.oppose.length} oppose)</span>}
              <span className="text-[#4b5a72]">efficiency {r.er.toFixed(2)} · vol rank {(r.volRank * 100).toFixed(0)}%</span>
            </div>
            <p className="mt-1 font-mono text-[9px] text-[#7c8aa5]">{r.reason}</p>
            {r.candidate !== 'none' && <p className="font-mono text-[9px] text-[#4b5a72]">idea is dead if price closes through {r.invalidation.toPrecision(6)}</p>}
            <div className="mt-2 grid grid-cols-1 gap-1.5 md:grid-cols-5">
              {r.components.map((c) => (
                <div key={c.family} className={`rounded border px-2 py-1 ${voteCls(c.dir)}`}>
                  <div className="flex items-center justify-between font-mono text-[9px] font-bold uppercase tracking-wider">
                    <span>{c.family}</span>
                    <span>{c.dir > 0 ? '▲ bull' : c.dir < 0 ? '▼ bear' : '· neutral'}</span>
                  </div>
                  <p className="mt-0.5 font-mono text-[8px] leading-snug opacity-80">{c.note}</p>
                </div>
              ))}
            </div>
            <p className="mt-1.5 font-mono text-[8px] text-[#3d4c66]">Agreement is how many of the five readers point the same way. They read the same candles, so it is not a win probability.</p>
          </>
        )}
      </section>

      {/* ---------------- STRATEGY ---------------- */}
      <section className="rounded border border-[#1c2739] bg-[#0d1420] p-2.5">
        <div className="flex items-center gap-2">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#7c8aa5]">Brain · strategy</h3>
          <span className="font-mono text-[9px] text-[#4b5a72]">the rules the brain proposes with - defaults are conventions, not tuned values</span>
          <span className="ml-auto flex items-center gap-2">
            {dirty && <span className="font-mono text-[9px] text-amber-400">unsaved</span>}
            <Button size="sm" disabled={!dirty || saving} onClick={() => { setDraft(strategy); setDirty(false) }} className="h-5 rounded bg-[#1c2739] px-2 text-[9px] font-bold uppercase text-[#aab6cc] hover:bg-[#243352]">revert</Button>
            <Button size="sm" disabled={!dirty || saving} onClick={() => void save()} className="h-5 rounded bg-sky-600 px-3 text-[9px] font-bold uppercase text-white hover:bg-sky-500">{saving ? 'saving…' : 'save strategy'}</Button>
          </span>
        </div>
        {!draft ? (
          <p className="mt-1.5 font-mono text-[9px] text-[#4b5a72]">loading…</p>
        ) : (
          <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-[#7c8aa5]">playbooks</p>
              {PLAYBOOK_INFO.map(([k, label, info]) => (
                <label key={k} className="mb-1.5 flex items-start gap-2">
                  <Switch checked={draft.playbooks[k]} onCheckedChange={(v) => edit((s) => ({ ...s, playbooks: { ...s.playbooks, [k]: v } }))} />
                  <span className="font-mono text-[9px] text-[#aab6cc]">{label}<span className="block text-[8px] text-[#4b5a72]">{info}</span></span>
                </label>
              ))}
              <label className="mt-1 flex items-start gap-2">
                <Switch checked={draft.standAsideWhenVolatile} onCheckedChange={(v) => edit((s) => ({ ...s, standAsideWhenVolatile: v }))} />
                <span className="font-mono text-[9px] text-[#aab6cc]">Stand aside when volatile<span className="block text-[8px] text-[#4b5a72]">ATR in its top decile and expanding: no proposals.</span></span>
              </label>
            </div>
            <div>
              <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-[#7c8aa5]">readers · vote and weight</p>
              {FAMILIES.map((f) => (
                <div key={f} className="mb-1.5 flex items-center gap-2">
                  <Switch checked={draft.families[f]} onCheckedChange={(v) => edit((s) => ({ ...s, families: { ...s.families, [f]: v } }))} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-[#aab6cc]" title={FAMILY_LABEL[f]}>{FAMILY_LABEL[f]}</span>
                  <Input
                    type="number"
                    step={0.1}
                    min={0.1}
                    max={5}
                    value={draft.weights[f]}
                    disabled={!draft.families[f]}
                    onChange={(e) => edit((s) => ({ ...s, weights: { ...s.weights, [f]: Number(e.target.value) } }))}
                    className="h-6 w-14 bg-[#101828] px-1 text-[10px]"
                  />
                </div>
              ))}
              <p className="font-mono text-[8px] text-[#3d4c66]">A reader that is switched off casts no vote and is left out of the agreement share. Weights only change the agreement number, not who may propose.</p>
            </div>
            <div>
              <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-[#7c8aa5]">thresholds</p>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                {NUM_FIELDS.map(([k, label, step]) => (
                  <label key={k} className="flex flex-col gap-0.5 font-mono text-[8px] text-[#7c8aa5]">
                    {label}
                    <Input type="number" step={step} value={draft[k] as number} onChange={(e) => edit((s) => ({ ...s, [k]: Number(e.target.value) }))} className="h-6 bg-[#101828] px-1 text-[10px]" />
                  </label>
                ))}
              </div>
              <p className="mt-1 font-mono text-[8px] text-[#3d4c66]">Values are clamped to sane ranges when saved. 3 readers agreeing proposes on about 1.7% of random-walk bars; 2 on about 11%.</p>
            </div>
          </div>
        )}
      </section>

      {/* ---------------- TRADER ---------------- */}
      <BrainTraderPanel />
    </div>
  )
}
