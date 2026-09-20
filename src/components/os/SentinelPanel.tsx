'use client'

// IQAIR//OS - Sentinel panel: portfolio risk governance
// Gauges (daily loss, drawdown, exposure, top-asset, trade rate), circuit
// breakers with ack, panic button, persisted limits editor, risk events feed.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { RiskEvent, SentinelBreaker, SentinelConfig, SentinelStatus } from '@/lib/os/client'
import { fmtMoney, fmtTime, osGet, osPost } from '@/lib/os/client'

interface Props {
  onError: (m: string) => void
  onAccountChanged?: () => void
}

export default function SentinelPanel({ onError, onAccountChanged }: Props) {
  const [status, setStatus] = useState<SentinelStatus | null>(null)
  const [cfg, setCfg] = useState<SentinelConfig>({
    maxExposurePct: 30,
    perAssetCapPct: 12,
    maxTradesPerHour: 30,
    drawdownHaltPct: 15,
    autoKillOnDailyLoss: true,
    autoKillOnDrawdown: false,
  })
  const [saving, setSaving] = useState(false)
  const [panicking, setPanicking] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await osGet<{ ok: boolean } & SentinelStatus>('/sentinel')
      if (d.ok) {
        setStatus(d)
        setCfg(d.config)
      }
    } catch {
      // kernel not up yet
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load])

  const saveConfig = async () => {
    setSaving(true)
    try {
      const res = await osPost<{ ok: boolean; config: SentinelConfig }>('/sentinel_config', cfg)
      if (res.ok) setCfg(res.config)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const ack = async (breaker?: 'daily' | 'drawdown') => {
    try {
      await osPost('/sentinel_ack', breaker ? { breaker } : {})
      void load()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const panic = async (kill: boolean) => {
    setPanicking(true)
    try {
      const res = await osPost<{ ok: boolean; closed: number; failed: number; botsDisarmed: number }>('/panic', { killSwitch: kill })
      if (res.ok) onAccountChanged?.()
      void load()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setPanicking(false)
    }
  }

  const topAsset = status
    ? Object.entries(status.exposure.byAsset).sort((a, b) => b[1] - a[1])[0] ?? null
    : null

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#141d2e] px-3 py-2">
        <span className="text-[12px] font-bold tracking-[0.2em] text-[#e2e8f0]">
          SENTINEL<span className="text-rose-400">{'//'}</span>risk governance
        </span>
        {status && (
          <span
            className={`rounded px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
              status.armed ? 'animate-pulse bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/40' : 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/30'
            }`}
          >
            {status.armed ? 'breaker tripped' : 'all clear'}
          </span>
        )}
        {status?.killSwitch && (
          <span className="rounded bg-rose-600/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-rose-300 ring-1 ring-rose-500/50">
            kill switch engaged
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {status?.breakers.some((b) => b.tripped) && (
            <Button onClick={() => void ack()} variant="outline" className="h-7 border-amber-500/40 bg-amber-500/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-amber-300 hover:bg-amber-500/20">
              ✓ Ack breakers
            </Button>
          )}
          {/* PANIC */}
          <Dialog>
            <DialogTrigger asChild>
              <Button disabled={panicking} className="h-7 animate-none bg-rose-600 px-3 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-rose-500">
                ⚠ PANIC
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-sm border-rose-500/40 bg-[#0b111c] text-[#dbe4f0]">
              <DialogHeader>
                <DialogTitle className="text-[14px] tracking-wider text-rose-400">Execute PANIC?</DialogTitle>
                <DialogDescription className="text-[11px] text-[#7c8aa5]">
                  Closes every open position (paper + live via iqair), disarms all autopilot bots and logs a risk event. Optionally engage the kill switch to halt all new trading.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2">
                <Button onClick={() => void panic(false)} disabled={panicking} variant="outline" className="h-8 border-[#1c2739] text-[11px] text-[#aab6cc]">
                  {panicking ? 'Executing…' : 'Close all + disarm bots'}
                </Button>
                <Button onClick={() => void panic(true)} disabled={panicking} className="h-8 bg-rose-600 text-[11px] font-bold text-white hover:bg-rose-500">
                  PANIC + kill switch
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {!status ? (
        <div className="flex flex-1 items-center justify-center text-[11px] text-[#3d4d66]">connecting to sentinel…</div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 overflow-auto p-3">
          {/* gauges */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <Gauge
              label="Daily loss"
              value={fmtMoney(status.dayLoss)}
              sub={`limit ${fmtMoney(status.baseDailyLimit)}`}
              ratio={status.baseDailyLimit > 0 ? status.dayLoss / status.baseDailyLimit : 0}
              tone={status.breakers.find((b) => b.id === 'daily')?.tripped ? 'tripped' : 'danger'}
            />
            <Gauge
              label="Drawdown (HWM)"
              value={`${status.drawdownPct.toFixed(2)}%`}
              sub={`peak ${fmtMoney(status.hwm)}`}
              ratio={status.config.drawdownHaltPct > 0 ? status.drawdownPct / status.config.drawdownHaltPct : 0}
              tone={status.breakers.find((b) => b.id === 'drawdown')?.tripped ? 'tripped' : 'danger'}
            />
            <Gauge
              label="Open exposure"
              value={fmtMoney(status.exposure.total)}
              sub={status.exposureCap > 0 ? `cap ${fmtMoney(status.exposureCap)}` : 'cap off'}
              ratio={status.exposureCap > 0 ? status.exposure.total / status.exposureCap : 0}
              tone="cyan"
            />
            <Gauge
              label="Top asset stake"
              value={topAsset ? `${topAsset[0]} ${fmtMoney(topAsset[1])}` : '—'}
              sub={status.perAssetCap > 0 ? `cap ${fmtMoney(status.perAssetCap)}` : 'cap off'}
              ratio={topAsset && status.perAssetCap > 0 ? topAsset[1] / status.perAssetCap : 0}
              tone="violet"
            />
            <Gauge
              label="Trades / hour"
              value={`${status.tradesLastHour}`}
              sub={status.config.maxTradesPerHour > 0 ? `max ${status.config.maxTradesPerHour}` : 'unlimited'}
              ratio={status.config.maxTradesPerHour > 0 ? status.tradesLastHour / status.config.maxTradesPerHour : 0}
              tone="amber"
            />
          </div>

          {/* breakers */}
          <div className="flex flex-wrap items-center gap-2">
            {status.breakers.map((b) => (
              <BreakerChip key={b.id} breaker={b} onAck={() => void ack(b.id)} />
            ))}
            <span className={`rounded px-2 py-1 text-[9px] font-bold uppercase tracking-wider ring-1 ${status.killSwitch ? 'bg-rose-600/20 text-rose-300 ring-rose-500/50' : 'bg-[#0d1420] text-[#4b5a72] ring-[#1c2739]'}`}>
              kill switch {status.killSwitch ? 'ENGAGED' : 'released'}
            </span>
            <span className="font-mono text-[9px] text-[#3d4d66]">
              {status.openPositions}/{status.maxOpenPositions} open · max stake {fmtMoney(status.maxStake)} · bal {fmtMoney(status.balance)}
            </span>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
            {/* limits editor */}
            <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
              <h4 className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">Portfolio limits (persisted)</h4>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['maxExposurePct', 'Max exposure % of balance', 0, 100],
                    ['perAssetCapPct', 'Per-asset cap % of balance', 0, 100],
                    ['maxTradesPerHour', 'Max trades / hour', 0, 600],
                    ['drawdownHaltPct', 'Drawdown halt %', 0, 90],
                  ] as [keyof SentinelConfig, string, number, number][]
                ).map(([key, label, min, max]) => (
                  <label key={key} className="block">
                    <span className="mb-1 block text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</span>
                    <Input
                      value={String(cfg[key])}
                      onChange={(e) => {
                        const v = Number(e.target.value.replace(/[^0-9.]/g, '')) || 0
                        setCfg((c) => ({ ...c, [key]: Math.min(max, Math.max(min, v)) }))
                      }}
                      className="h-8 border-[#1c2739] bg-[#101828] font-mono text-[12px]"
                    />
                  </label>
                ))}
              </div>
              <div className="mt-3 space-y-2">
                <label className="flex items-center gap-2 text-[11px] text-[#aab6cc]">
                  <Switch checked={cfg.autoKillOnDailyLoss} onCheckedChange={(v) => setCfg((c) => ({ ...c, autoKillOnDailyLoss: v }))} />
                  Auto kill switch on daily-loss breach
                </label>
                <label className="flex items-center gap-2 text-[11px] text-[#aab6cc]">
                  <Switch checked={cfg.autoKillOnDrawdown} onCheckedChange={(v) => setCfg((c) => ({ ...c, autoKillOnDrawdown: v }))} />
                  Auto kill switch on drawdown breach
                </label>
              </div>
              <Button onClick={() => void saveConfig()} disabled={saving} className="mt-3 h-8 bg-cyan-600 px-3 text-[11px] text-white hover:bg-cyan-500">
                {saving ? 'Saving…' : 'Save limits'}
              </Button>
              <p className="mt-2 text-[9px] leading-relaxed text-[#3d4d66]">
                0 disables a cap. Limits survive kernel restarts. Every order - manual, copilot or bot - passes through this gate.
              </p>
            </div>

            {/* risk events */}
            <div className="flex min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
              <h4 className="border-b border-[#141d2e] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">Risk events</h4>
              <div className="min-h-0 flex-1 overflow-auto">
                {status.events.length === 0 ? (
                  <div className="flex h-full min-h-[80px] items-center justify-center text-[11px] text-[#3d4d66]">No risk events yet - breakers, panics and limit changes land here.</div>
                ) : (
                  <div className="divide-y divide-[#0d1420]">
                    {status.events.map((e, i) => (
                      <EventRow key={i} event={e} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Gauge({ label, value, sub, ratio, tone }: { label: string; value: string; sub: string; ratio: number; tone: 'cyan' | 'violet' | 'amber' | 'danger' | 'tripped' }) {
  const pct = Math.min(100, Math.max(0, ratio * 100))
  const color =
    tone === 'tripped' ? '#f43f5e' : tone === 'danger' ? (pct >= 100 ? '#f43f5e' : pct >= 70 ? '#f59e0b' : '#10b981') : tone === 'cyan' ? '#22d3ee' : tone === 'violet' ? '#a78bfa' : '#f59e0b'
  return (
    <div className={`rounded-lg border bg-[#0b111c] p-2.5 ${tone === 'tripped' ? 'border-rose-500/50' : 'border-[#1c2739]'}`}>
      <div className="text-[8px] uppercase tracking-[0.18em] text-[#4b5a72]">{label}</div>
      <div className="mt-1 truncate font-mono text-[13px] font-bold" style={{ color }}>
        {value}
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-[#101828]">
        <div className="h-full rounded transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="mt-1 font-mono text-[9px] text-[#3d4d66]">{sub}</div>
    </div>
  )
}

function BreakerChip({ breaker, onAck }: { breaker: SentinelBreaker; onAck: () => void }) {
  return (
    <button
      onClick={onAck}
      title={breaker.tripped ? `${breaker.reason} - click to ack` : 'ok'}
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-[9px] font-bold uppercase tracking-wider ring-1 transition-colors ${
        breaker.tripped
          ? 'animate-pulse bg-rose-600/20 text-rose-300 ring-rose-500/50 hover:bg-rose-600/30'
          : 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${breaker.tripped ? 'bg-rose-400' : 'bg-emerald-400'}`} />
      {breaker.label} {breaker.tripped ? 'TRIPPED · ack?' : 'ok'}
    </button>
  )
}

function EventRow({ event }: { event: RiskEvent }) {
  const tone =
    event.kind === 'panic' || event.message.includes('TRIPPED') || event.message.includes('auto-engaged')
      ? 'text-rose-400'
      : event.kind === 'breaker'
        ? 'text-amber-400'
        : event.kind === 'config'
          ? 'text-cyan-400'
          : 'text-[#aab6cc]'
  return (
    <div className="flex items-start gap-2.5 px-3 py-1.5 font-mono text-[11px]">
      <span className="shrink-0 text-[9px] text-[#4b5a72]">{fmtTime(event.ts)}</span>
      <span className={`shrink-0 rounded bg-[#101828] px-1.5 text-[9px] uppercase ${tone}`}>{event.kind}</span>
      <span className="text-[#aab6cc]">{event.message}</span>
    </div>
  )
}
