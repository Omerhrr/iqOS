'use client'

// IQAIR//OS - CFD Trader panel (plugins/cfdtrader.ts). Forex / CFD engine: plan (entry, SL, TP, RR) -> size (risk % or fixed margin) -> place -> manage.
// Paper and live use the same path; live needs an explicit arm. Self-contained: polls its own status.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { getMetaStrategies, osGet, osPost, type MetaStrategySpec } from '@/lib/os/client'

interface Cfg {
  enabled: boolean; mode: 'paper' | 'live'; source: 'plan' | 'meta-strategy'; metaStrategyId?: string; tf: string; htfTf: string; assets: string[]
  sizing: 'risk' | 'margin'; riskPct: number; fixedMargin: number; leverage: number; maxMarginPct: number; maxOpen: number; perAssetMax: number; cooldownSec: number
  minStrength: number; minRR: number; minEv: number; dailyLossStopPct: number; maxDailyTrades: number; breakevenR: number; trailAtr: number
}
interface Pos { id: string; asset: string; side: 'call' | 'put'; amount: number; leverage?: number; entryPrice: number; tp?: number; sl?: number; note?: string; mode: string }
interface Status { enabled: boolean; osMode: string; config: Cfg; stats: { opened: number; closed: number; wins: number; losses: number; pnl: number; lastReason: string }; openCount: number; open: Pos[]; dayTrades: number; equity: number; pool: string[] }
interface Decision { ts: number; asset: string; action: 'opened' | 'skipped' | 'rejected'; reason: string; margin?: number; units?: number; plan?: { rr?: number; prob?: number; ev?: number } }
interface Plan { ok: boolean; error?: string; direction: 'call' | 'put' | 'none'; entry: number; stop: number; target: number; rr: number; prob: number; strength: number; ev: number; riskAtr: number; rewardAtr: number; stopKind: string; targetKind: string; alignment: string; text: string }
interface Bt { ok: boolean; error?: string; returnPct?: number; maxDrawdownPct?: number; tradesUsed?: number; winRate?: number | null; profitFactor?: number | null; expectancyR?: number | null; netR?: number | null; curve?: number[]; note?: string; endEquity?: number }

const TFS = ['1m', '2m', '5m', '15m', '30m', '1h']
const f = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(d))
const px = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(3) : v.toFixed(5))

function Num({ label, v, on, step = 1, w = 'w-16' }: { label: string; v: number; on: (n: number) => void; step?: number; w?: string }) {
  const [t, setT] = useState(String(v))
  useEffect(() => setT(String(v)), [v])
  return (
    <label className="flex items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">{label}
      <Input value={t} inputMode="decimal" step={step} onChange={(e) => setT(e.target.value)} onBlur={() => { const n = Number(t); if (Number.isFinite(n) && n !== v) on(n); else setT(String(v)) }} className={`h-6 ${w} border-[#1c2739] bg-[#0a101a] px-1 font-mono text-[10px]`} />
    </label>
  )
}

function Spark({ data }: { data: number[] }) {
  if (data.length < 2) return null
  const lo = Math.min(...data), hi = Math.max(...data), W = 220, H = 40
  const pts = data.map((d, i) => `${((i / (data.length - 1)) * W).toFixed(1)},${(H - ((d - lo) / (hi - lo || 1)) * H).toFixed(1)}`).join(' ')
  return <svg width={W} height={H} className="shrink-0"><polyline points={pts} fill="none" stroke={data[data.length - 1] >= data[0] ? '#34d399' : '#fb7185'} strokeWidth="1.5" /></svg>
}

export default function CfdTraderPanel({ asset }: { asset: string }) {
  const [st, setSt] = useState<Status | null>(null)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [plan, setPlan] = useState<Plan | null>(null)
  const [bt, setBt] = useState<Bt | null>(null)
  const [btBusy, setBtBusy] = useState(false)
  const [specs, setSpecs] = useState<MetaStrategySpec[]>([])
  const [armLive, setArmLive] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [script, setScript] = useState('')
  const [btAsset, setBtAsset] = useState('')
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const a = btAsset || asset

  const load = useCallback(async () => {
    try {
      const d = await osGet<{ ok: boolean } & Status>('/cfd_trader_status')
      if (d.ok) setSt(d)
      const l = await osGet<{ ok: boolean; decisions: Decision[] }>('/cfd_trader_decisions', { limit: 30 })
      if (l.ok) setDecisions(l.decisions)
      setErr(null)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t) }, [load])
  useEffect(() => { void getMetaStrategies().then((r) => setSpecs((r as { strategies?: MetaStrategySpec[] }).strategies ?? (r as unknown as MetaStrategySpec[]) ?? [])).catch(() => undefined) }, [])
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current) }, [])

  const refreshPlan = useCallback(async () => {
    try { const p = await osGet<{ ok: boolean; plan: Plan; error?: string }>('/cfd_plan', { asset: a }); setPlan(p.ok ? p.plan : { ok: false, error: p.error, direction: 'none' } as Plan) } catch (e) { setPlan({ ok: false, error: e instanceof Error ? e.message : String(e), direction: 'none' } as Plan) }
  }, [a])
  useEffect(() => { void refreshPlan(); const t = setInterval(() => void refreshPlan(), 10000); return () => clearInterval(t) }, [refreshPlan])

  const patch = async (p: Partial<Cfg>) => { try { await osPost('/cfd_trader_config', p); await load(); void refreshPlan() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } }
  const runBt = async () => {
    setBtBusy(true); setBt(null)
    try { setBt(await osPost<Bt>('/cfd_backtest', { asset: a, tf: st?.config.tf ?? '1m', riskPct: st?.config.riskPct ?? 1, ...(script.trim() ? { script } : {}) })) } catch (e) { setBt({ ok: false, error: e instanceof Error ? e.message : String(e) }) } finally { setBtBusy(false) }
  }

  if (!st) return <div className="p-3 font-mono text-[10px] text-amber-500/70">{err ? `cfd trader: ${err}` : 'loading cfd trader...'}</div>
  const c = st.config
  const live = c.mode === 'live'
  const label = !c.enabled ? 'off' : st.osMode !== 'auto' ? `armed · OS mode ${st.osMode.toUpperCase()} (standing down)` : live ? 'LIVE · trading' : 'PAPER · trading'
  const cls = !c.enabled ? 'border-[#1c2739] text-[#4b5a72]' : st.osMode !== 'auto' ? 'border-amber-500/40 text-amber-300' : live ? 'border-emerald-500/50 text-emerald-300' : 'border-sky-500/40 text-sky-300'
  const box = 'rounded border border-[#1c2739] bg-[#0d1420] px-2.5 py-2'
  const head = 'text-[9px] font-bold uppercase tracking-[0.18em] text-[#7c8aa5]'

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2">
      <div className={`${box} flex flex-wrap items-center gap-x-3 gap-y-1`}>
        <span className={head}>cfd trader</span>
        <span className={`rounded border px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-wider ${cls}`}>{label}</span>
        <span className="font-mono text-[9px] text-[#4b5a72]">equity {f(st.equity)} · open {st.openCount}/{c.maxOpen} · today {st.dayTrades}/{c.maxDailyTrades} · {st.stats.wins}W {st.stats.losses}L · pnl {f(st.stats.pnl)}</span>
        <span className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1 font-mono text-[8px] uppercase text-[#7c8aa5]">on <Switch checked={c.enabled} onCheckedChange={(v) => void patch({ enabled: v })} /></label>
          {live ? (
            <Button size="sm" variant="outline" className="h-6 border-emerald-500/40 px-2 text-[9px] text-emerald-300" onClick={() => void patch({ mode: 'paper' })}>LIVE → paper</Button>
          ) : armLive ? (
            <Button size="sm" className="h-6 bg-rose-600 px-2 text-[9px] hover:bg-rose-500" onClick={() => { setArmLive(false); void patch({ mode: 'live' }) }}>confirm LIVE (real orders)</Button>
          ) : (
            <Button size="sm" variant="outline" className="h-6 px-2 text-[9px]" onClick={() => { setArmLive(true); armTimer.current = setTimeout(() => setArmLive(false), 6000) }}>arm live</Button>
          )}
          <Button size="sm" variant="outline" className="h-6 px-2 text-[9px]" onClick={() => void osPost('/cfd_trader_scan').then(load)}>scan now</Button>
          <Button size="sm" variant="outline" className="h-6 border-rose-500/40 px-2 text-[9px] text-rose-300" onClick={() => void osPost('/cfd_trader_close_all').then(load)}>close all</Button>
        </span>
      </div>
      {st.stats.lastReason && <div className="font-mono text-[9px] text-[#4b5a72]">last: {st.stats.lastReason}</div>}
      {err && <div className="font-mono text-[9px] text-amber-500/70">{err}</div>}

      <div className="grid gap-2 lg:grid-cols-2">
        <div className={box}>
          <div className={head}>trade plan · {a}</div>
          {plan?.ok && plan.direction !== 'none' ? (
            <div className="mt-1 space-y-0.5 font-mono text-[10px]">
              <div className={plan.direction === 'call' ? 'text-emerald-400' : 'text-rose-400'}>{plan.direction === 'call' ? 'LONG' : 'SHORT'} · P {f(plan.prob * 100, 0)}% · strength {f(plan.strength, 0)} · {plan.alignment}</div>
              <div>entry {px(plan.entry)} · SL {px(plan.stop)} ({plan.stopKind}, {f(plan.riskAtr)} ATR) · TP {px(plan.target)} ({plan.targetKind}, {f(plan.rewardAtr)} ATR)</div>
              <div>RR {f(plan.rr)} · EV {f(plan.ev)}R <span className="text-[#4b5a72]">(unfitted estimate)</span></div>
            </div>
          ) : <div className="mt-1 font-mono text-[10px] text-[#4b5a72]">{plan?.error || plan?.text || 'no call right now'}</div>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input value={btAsset} placeholder={asset} onChange={(e) => setBtAsset(e.target.value.toUpperCase())} className="h-6 w-24 border-[#1c2739] bg-[#0a101a] px-1 font-mono text-[10px]" />
            <Button size="sm" variant="outline" className="h-6 px-2 text-[9px]" onClick={() => void refreshPlan()}>refresh</Button>
          </div>
        </div>

        <div className={box}>
          <div className={head}>open cfd positions</div>
          {st.open.length === 0 ? <div className="mt-1 font-mono text-[10px] text-[#4b5a72]">none</div> : st.open.map((p) => (
            <div key={p.id} className="mt-1 flex items-center gap-2 font-mono text-[10px]">
              <span className={p.side === 'call' ? 'text-emerald-400' : 'text-rose-400'}>{p.side === 'call' ? 'LONG' : 'SHORT'}</span>
              <span>{p.asset}</span><span className="text-[#7c8aa5]">m{f(p.amount)} x{p.leverage ?? 1} @ {px(p.entryPrice)}</span>
              <span className="text-[#4b5a72]">SL {f(p.sl, 3)}% TP {f(p.tp, 3)}% · {p.mode}</span>
              <Button size="sm" variant="outline" className="ml-auto h-5 px-1.5 text-[8px]" onClick={() => void osPost('/close', { id: p.id }).then(load).catch((e) => setErr(String(e)))}>close</Button>
            </div>
          ))}
        </div>
      </div>

      <div className={box}>
        <div className={head}>engine settings</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label className="flex items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">source
            <select value={c.source} onChange={(e) => void patch({ source: e.target.value as Cfg['source'] })} className="h-6 rounded border border-[#1c2739] bg-[#0a101a] px-1 text-[10px]"><option value="plan">story.cfd plan</option><option value="meta-strategy">MSL strategy</option></select>
          </label>
          {c.source === 'meta-strategy' && (
            <select value={c.metaStrategyId ?? ''} onChange={(e) => void patch({ metaStrategyId: e.target.value })} className="h-6 max-w-[220px] rounded border border-[#1c2739] bg-[#0a101a] px-1 text-[10px]">
              <option value="">pick a strategy…</option>{specs.filter((s) => s.script).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <label className="flex items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">tf <select value={c.tf} onChange={(e) => void patch({ tf: e.target.value })} className="h-6 rounded border border-[#1c2739] bg-[#0a101a] px-1 text-[10px]">{TFS.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label className="flex items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">htf <select value={c.htfTf} onChange={(e) => void patch({ htfTf: e.target.value })} className="h-6 rounded border border-[#1c2739] bg-[#0a101a] px-1 text-[10px]">{['none', ...TFS].map((t) => <option key={t}>{t}</option>)}</select></label>
          <label className="flex items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">sizing
            <select value={c.sizing} onChange={(e) => void patch({ sizing: e.target.value as Cfg['sizing'] })} className="h-6 rounded border border-[#1c2739] bg-[#0a101a] px-1 text-[10px]"><option value="risk">risk % of equity</option><option value="margin">fixed margin</option></select>
          </label>
          {c.sizing === 'risk' ? <Num label="risk %" v={c.riskPct} step={0.1} on={(n) => void patch({ riskPct: n })} /> : <Num label="margin" v={c.fixedMargin} on={(n) => void patch({ fixedMargin: n })} />}
          <Num label="leverage" v={c.leverage} on={(n) => void patch({ leverage: n })} />
          <Num label="max margin %" v={c.maxMarginPct} on={(n) => void patch({ maxMarginPct: n })} />
          <Num label="max open" v={c.maxOpen} on={(n) => void patch({ maxOpen: n })} w="w-12" />
          <Num label="per asset" v={c.perAssetMax} on={(n) => void patch({ perAssetMax: n })} w="w-12" />
          <Num label="cooldown s" v={c.cooldownSec} on={(n) => void patch({ cooldownSec: n })} />
          <Num label="min strength" v={c.minStrength} on={(n) => void patch({ minStrength: n })} w="w-12" />
          <Num label="min RR" v={c.minRR} step={0.1} on={(n) => void patch({ minRR: n })} w="w-12" />
          <Num label="min EV (R)" v={c.minEv} step={0.05} on={(n) => void patch({ minEv: n })} w="w-12" />
          <Num label="daily loss stop %" v={c.dailyLossStopPct} on={(n) => void patch({ dailyLossStopPct: n })} w="w-12" />
          <Num label="max trades/day" v={c.maxDailyTrades} on={(n) => void patch({ maxDailyTrades: n })} w="w-12" />
          <Num label="breakeven at R" v={c.breakevenR} step={0.1} on={(n) => void patch({ breakevenR: n })} w="w-12" />
          <Num label="ATR trail" v={c.trailAtr} step={0.1} on={(n) => void patch({ trailAtr: n })} w="w-12" />
        </div>
        <div className="mt-1.5 flex items-center gap-1 font-mono text-[9px] text-[#7c8aa5]">watchlist (empty = majors)
          <Input defaultValue={c.assets.join(',')} key={c.assets.join(',')} onBlur={(e) => void patch({ assets: e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) })} className="h-6 flex-1 border-[#1c2739] bg-[#0a101a] px-1 font-mono text-[10px]" />
        </div>
        <div className="mt-1 font-mono text-[8px] text-[#4b5a72]">Leverage is auto-reduced so the stop is always hit before the -100% margin call. Live positions keep the SL/TP sent at entry; breakeven/trail rewrite paper stops only. No measured edge - backtest first.</div>
      </div>

      <div className={box}>
        <div className="flex items-center gap-2"><span className={head}>backtest · {a} · {c.tf}</span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[9px]" disabled={btBusy} onClick={() => void runBt()}>{btBusy ? 'running…' : 'run'}</Button>
          <span className="font-mono text-[8px] text-[#4b5a72]">uses the script below, or the built-in story.cfd() strategy when empty</span></div>
        <textarea value={script} onChange={(e) => setScript(e.target.value)} placeholder={'# optional MSL, e.g.\nlet c = story.cfd("5m", 2)\ncall when c.ok and c.direction == "call" and c.ev > 0\nput when c.ok and c.direction == "put" and c.ev > 0\npos.stop = c.stop\npos.target = c.target'} className="mt-1.5 h-24 w-full rounded border border-[#1c2739] bg-[#0a101a] p-1.5 font-mono text-[10px]" spellCheck={false} />
        {bt && (bt.ok ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-4 font-mono text-[10px]">
            <span className={(bt.returnPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>return {f(bt.returnPct)}%</span><span>maxDD {f(bt.maxDrawdownPct)}%</span><span>trades {bt.tradesUsed}</span>
            <span>win {bt.winRate == null ? '-' : f(bt.winRate * 100, 0) + '%'}</span><span>PF {f(bt.profitFactor)}</span><span>exp {f(bt.expectancyR)}R</span>{bt.curve && <Spark data={bt.curve} />}
            <span className="w-full text-[8px] text-[#4b5a72]">{bt.note}</span>
          </div>
        ) : <div className="mt-1.5 font-mono text-[10px] text-amber-500/80">{bt.error}</div>)}
      </div>

      <div className={box}>
        <div className={head}>decisions</div>
        {decisions.length === 0 ? <div className="mt-1 font-mono text-[10px] text-[#4b5a72]">nothing yet</div> : decisions.map((d, i) => (
          <div key={i} className="mt-0.5 flex gap-2 font-mono text-[9px]">
            <span className="text-[#4b5a72]">{new Date(d.ts * 1000).toLocaleTimeString()}</span>
            <span className={d.action === 'opened' ? 'text-emerald-400' : d.action === 'rejected' ? 'text-rose-400' : 'text-[#7c8aa5]'}>{d.action}</span>
            <span>{d.asset}</span>{d.margin ? <span className="text-[#7c8aa5]">m{f(d.margin)}</span> : null}<span className="truncate text-[#4b5a72]">{d.reason}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
