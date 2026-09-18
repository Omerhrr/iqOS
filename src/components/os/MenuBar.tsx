'use client'

// IQAIR//OS - Menu bar: brand, selectors, account status, kill switch, settings
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import type { AccountState, AssetRow, ChartType, RiskConfig, Timeframe } from '@/lib/os/client'
import { CHART_TYPES, TIMEFRAMES, fmtClock, fmtMoney, fmtPct, osPost } from '@/lib/os/client'

interface Props {
  assets: AssetRow[]
  asset: string
  tf: Timeframe
  chartType: ChartType
  registrySize: number
  account: AccountState | null
  risk: RiskConfig | null
  onSelectAsset: (a: string) => void
  onSelectTf: (t: Timeframe) => void
  onChartTypeChange: (t: ChartType) => void
  onOpenPicker: () => void
  onRiskChanged: (r: RiskConfig) => void
  onAccountChanged: (a: AccountState) => void
  onError: (m: string) => void
}

export default function MenuBar(props: Props) {
  const [now, setNow] = useState(0)
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000))
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  const account = props.account
  const kill = account?.killSwitch ?? false

  const toggleKill = async () => {
    try {
      const res = await osPost<{ ok: boolean; account: AccountState }>('/kill_switch', { on: !kill })
      if (res.ok) props.onAccountChanged(res.account)
    } catch (err) {
      props.onError((err as Error).message)
    }
  }

  const resetAccount = async () => {
    try {
      const res = await osPost<{ ok: boolean; account: AccountState }>('/reset')
      if (res.ok) props.onAccountChanged(res.account)
    } catch (err) {
      props.onError((err as Error).message)
    }
  }

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[#1c2739] bg-[#080d16] px-3 py-2">
      {/* brand */}
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-md border border-cyan-500/50 bg-cyan-500/10 font-mono text-[11px] font-bold text-cyan-300">
          iQ
        </div>
        <div className="leading-none">
          <div className="text-[13px] font-bold tracking-[0.22em] text-[#e2e8f0]">
            IQAIR<span className="text-cyan-400">{"//"}</span>OS
          </div>
          <div className="mt-0.5 text-[8px] uppercase tracking-[0.3em] text-[#4b5a72]">trading operating system</div>
        </div>
      </div>

      {/* selectors */}
      <div className="flex items-center gap-1.5">
        <select
          value={props.asset}
          onChange={(e) => props.onSelectAsset(e.target.value)}
          className="h-8 max-w-56 rounded border border-[#1c2739] bg-[#0d1420] px-2 font-mono text-[12px] font-semibold text-cyan-300 outline-none"
        >
          {(['forex', 'otc', 'crypto', 'commodity', 'stock', 'index'] as const).map((grp) => {
            const items = props.assets.filter((a) => (grp === 'otc' ? a.otc : !a.otc && a.category === grp))
            if (!items.length) return null
            return (
              <optgroup key={grp} label={grp.toUpperCase()} className="bg-[#0d1420]">
                {items.map((a) => (
                  <option key={a.ticker} value={a.ticker}>
                    {a.ticker}
                  </option>
                ))}
              </optgroup>
            )
          })}
        </select>
        <div className="flex max-w-[360px] overflow-x-auto rounded border border-[#1c2739] scrollbar-none">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              onClick={() => props.onSelectTf(t)}
              className={`shrink-0 px-2 py-1 font-mono text-[10px] transition-colors ${
                props.tf === t ? 'bg-cyan-500/15 text-cyan-300' : 'bg-[#0d1420] text-[#4b5a72] hover:text-[#aab6cc]'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* chart type + indicator registry (moved off the chart canvas) */}
        <select
          value={props.chartType}
          onChange={(e) => props.onChartTypeChange(e.target.value as ChartType)}
          title="Chart type"
          className="h-8 rounded border border-[#1c2739] bg-[#0d1420] px-2 font-mono text-[11px] uppercase tracking-wider text-[#aab6cc] outline-none focus:border-cyan-500/50"
        >
          {CHART_TYPES.map((t) => (
            <option key={t.id} value={t.id} className="bg-[#0d1420]">
              {t.label}
            </option>
          ))}
        </select>
        <button
          onClick={props.onOpenPicker}
          title="Browse the full indicator registry"
          className="h-8 rounded bg-violet-500/15 px-2.5 text-[10px] font-bold uppercase tracking-wider text-violet-300 ring-1 ring-violet-500/40 transition-colors hover:bg-violet-500/25"
        >
          + Indicator ({props.registrySize})
        </button>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
        {/* account */}
        {account && (
          <>
            <Metric label="Balance" value={fmtMoney(account.balance)} cls="text-[#e2e8f0]" />
            <Metric
              label="Day P/L"
              value={fmtMoney(account.dayPnl)}
              cls={account.dayPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}
            />
            <Metric
              label="Total P/L"
              value={`${fmtMoney(account.totalPnl)} (${fmtPct((account.totalPnl / account.startBalance) * 100)})`}
              cls={account.totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}
            />
            <Metric label="Open" value={String(account.openPositions)} cls="text-[#aab6cc]" />
          </>
        )}

        {/* kill switch */}
        <Button
          onClick={() => void toggleKill()}
          className={`h-8 px-3 text-[10px] font-bold uppercase tracking-wider text-white ${
            kill ? 'animate-pulse bg-rose-600 hover:bg-rose-500' : 'bg-[#1c2739] text-rose-300 hover:bg-rose-900/50'
          }`}
        >
          {kill ? '■ KILL ENGAGED' : '◉ KILL SWITCH'}
        </Button>

        {/* settings */}
        <SettingsDialog {...props} onReset={resetAccount} />

        <span className="font-mono text-[11px] text-[#4b5a72]">{now > 0 ? fmtClock(now) : '--:--:-- UTC'}</span>
      </div>
    </header>
  )
}

function Metric({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className="leading-none">
      <div className="text-[8px] uppercase tracking-[0.18em] text-[#4b5a72]">{label}</div>
      <div className={`mt-0.5 font-mono text-[12px] font-bold ${cls}`}>{value}</div>
    </div>
  )
}

function SettingsDialog(props: Props & { onReset: () => void }) {
  const [risk, setRisk] = useState<RiskConfig>({
    maxStake: props.risk?.maxStake ?? 100,
    dailyLossLimit: props.risk?.dailyLossLimit ?? 250,
    maxOpenPositions: props.risk?.maxOpenPositions ?? 8,
    lossStreakCooldown: props.risk?.lossStreakCooldown ?? 4,
    cooldownSeconds: props.risk?.cooldownSeconds ?? 120,
  })
  const [url, setUrl] = useState('http://127.0.0.1:8788')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [real, setReal] = useState(false)
  const [liveMsg, setLiveMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const saveRisk = async () => {
    const res = await osPost<{ ok: boolean; risk: RiskConfig }>('/risk', risk)
    if (res.ok) props.onRiskChanged(res.risk)
  }

  const connectLive = async () => {
    setBusy(true)
    setLiveMsg('')
    try {
      const res = await osPost<{ ok: boolean; error?: string }>('/live/connect', {
        url,
        email,
        password,
        balanceMode: real ? 'REAL' : 'PRACTICE',
      })
      setLiveMsg(res.ok ? 'Connected - LIVE mode active, iqair sidecar streaming.' : `Failed: ${res.error}`)
    } catch (err) {
      setLiveMsg(`Failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="h-8 border-[#1c2739] bg-[#0d1420] px-3 text-[10px] font-bold uppercase tracking-wider text-[#7c8aa5] hover:text-cyan-300">
          ⚙ Settings
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg border-[#1c2739] bg-[#0b111c] text-[#dbe4f0]">
        <DialogHeader>
          <DialogTitle className="text-[14px] tracking-wider">OS Settings</DialogTitle>
          <DialogDescription className="text-[11px] text-[#7c8aa5]">
            Risk manager limits apply to every order - manual or copilot.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section>
            <h4 className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">Risk Manager</h4>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['maxStake', 'Max stake $'],
                  ['dailyLossLimit', 'Daily loss limit $'],
                  ['maxOpenPositions', 'Max open positions'],
                  ['lossStreakCooldown', 'Loss streak cooldown (n)'],
                  ['cooldownSeconds', 'Cooldown seconds'],
                ] as [keyof RiskConfig, string][]
              ).map(([key, label]) => (
                <label key={key} className="block">
                  <span className="mb-1 block text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</span>
                  <Input
                    value={String(risk[key])}
                    onChange={(e) => setRisk((r) => ({ ...r, [key]: Number(e.target.value.replace(/[^0-9.]/g, '')) || 0 }))}
                    className="h-8 border-[#1c2739] bg-[#101828] font-mono text-[12px]"
                  />
                </label>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <Button onClick={() => void saveRisk()} className="h-8 bg-cyan-600 px-3 text-[11px] text-white hover:bg-cyan-500">
                Save risk config
              </Button>
              <Button onClick={props.onReset} variant="outline" className="h-8 border-[#1c2739] px-3 text-[11px] text-[#7c8aa5] hover:text-rose-400">
                Reset paper account ($10,000)
              </Button>
            </div>
          </section>

          <section className="border-t border-[#1c2739] pt-3">
            <h4 className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">LIVE broker - iqair sidecar</h4>
            <p className="mb-2 text-[10px] leading-relaxed text-[#4b5a72]">
              Run your iqair library bridge locally: <code className="text-cyan-500">python live/iqair_sidecar.py</code> (repo file), then
              connect. Sim engine stays active for everything else.
            </p>
            <div className="grid grid-cols-1 gap-2">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="sidecar url" className="h-8 border-[#1c2739] bg-[#101828] font-mono text-[11px]" />
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="IQ Option email" type="email" className="h-8 border-[#1c2739] bg-[#101828] text-[12px]" />
              <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="IQ Option password" type="password" className="h-8 border-[#1c2739] bg-[#101828] text-[12px]" />
              <div className="flex items-center gap-2 text-[11px] text-[#7c8aa5]">
                <Switch checked={real} onCheckedChange={setReal} />
                Use REAL balance <span className="text-rose-400">(not recommended)</span>
              </div>
              <Button onClick={() => void connectLive()} disabled={busy} className="h-8 bg-emerald-600 px-3 text-[11px] font-semibold text-white hover:bg-emerald-500">
                {busy ? 'Connecting…' : 'Connect LIVE via iqair'}
              </Button>
              {liveMsg && <p className="text-[10px] leading-relaxed text-[#7c8aa5]">{liveMsg}</p>}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
