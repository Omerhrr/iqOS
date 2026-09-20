'use client'

// IQAIR//OS - Watchdog panel: live strategy health & drift guardian
// Per-bot rolling metrics vs baseline, escalation ladder (HEALTHY -> WATCH ->
// HOLD -> DISARMED), ack/recalibrate, per-bot baseline override, persisted
// thresholds editor, watchdog events feed.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { WatchdogBotHealth, WatchdogConfig, WatchdogStatus } from '@/lib/os/client'
import { fmtMoney, fmtTime, osGet, osPost } from '@/lib/os/client'

interface Props {
  onError: (m: string) => void
}

const LEVEL_TONE: Record<number, { chip: string; dot: string; ring: string }> = {
  0: { chip: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30', dot: 'bg-emerald-400', ring: 'border-[#1c2739]' },
  1: { chip: 'bg-amber-500/10 text-amber-400 ring-amber-500/30', dot: 'bg-amber-400', ring: 'border-amber-500/30' },
  2: { chip: 'animate-pulse bg-orange-600/20 text-orange-300 ring-orange-500/40', dot: 'bg-orange-400', ring: 'border-orange-500/40' },
  3: { chip: 'animate-pulse bg-rose-600/20 text-rose-300 ring-rose-500/50', dot: 'bg-rose-400', ring: 'border-rose-500/50' },
}

export default function WatchdogPanel({ onError }: Props) {
  const [status, setStatus] = useState<WatchdogStatus | null>(null)
  const [cfg, setCfg] = useState<WatchdogConfig>({
    windowTrades: 30,
    minTrades: 10,
    winRateFloorPct: 38,
    winRateDriftPct: 12,
    profitFactorFloor: 0.7,
    maxConsecLosses: 6,
    graceTrades: 5,
    holdMinutes: 30,
    botDrawdownUsd: 0,
    autoDisarm: true,
    expectedWinRatePct: 55,
  })
  const [saving, setSaving] = useState(false)
  const [baselineDraft, setBaselineDraft] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const d = await osGet<{ ok: boolean } & WatchdogStatus>('/watchdog')
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
      const res = await osPost<{ ok: boolean; config: WatchdogConfig }>('/watchdog_config', cfg)
      if (res.ok) setCfg(res.config)
      void load()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const ack = async (botId?: string) => {
    try {
      await osPost('/watchdog_ack', botId ? { botId } : {})
      void load()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const setBaseline = async (botId: string) => {
    const raw = baselineDraft[botId]
    if (!raw) return
    try {
      const res = await osPost<{ ok: boolean; error?: string }>('/watchdog_baseline', { botId, expectedWinRatePct: Number(raw) })
      if (!res.ok && res.error) onError(res.error)
      void load()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const s = status

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#141d2e] px-3 py-2">
        <span className="text-[12px] font-bold tracking-[0.2em] text-[#e2e8f0]">
          WATCHDOG<span className="text-amber-400">{'//'}</span>strategy health
        </span>
        {s && (
          <span
            className={`rounded px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1 ${
              s.summary.hold + s.summary.disarmed > 0
                ? 'animate-pulse bg-rose-500/15 text-rose-400 ring-rose-500/40'
                : s.summary.watch > 0
                  ? 'bg-amber-500/10 text-amber-400 ring-amber-500/30'
                  : 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30'
            }`}
          >
            {s.summary.hold + s.summary.disarmed > 0
              ? `${s.summary.hold + s.summary.disarmed} bot${s.summary.hold + s.summary.disarmed === 1 ? '' : 's'} stopped`
              : s.summary.watch > 0
                ? `${s.summary.watch} under watch`
                : s.summary.total > 0
                  ? 'fleet healthy'
                  : 'no bots tracked'}
          </span>
        )}
        {s && (s.summary.hold > 0 || s.summary.disarmed > 0 || s.summary.watch > 0) && (
          <Button
            onClick={() => void ack()}
            variant="outline"
            className="h-7 border-amber-500/40 bg-amber-500/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-amber-300 hover:bg-amber-500/20"
          >
            ✓ Ack all
          </Button>
        )}
        <span className="ml-auto font-mono text-[9px] text-[#3d4d66]">
          edge deployed by research · guarded here for life after deployment
        </span>
      </div>

      {!s ? (
        <div className="flex flex-1 items-center justify-center text-[11px] text-[#3d4d66]">connecting to watchdog…</div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 overflow-auto p-3">
          {/* bot health cards */}
          {s.bots.length === 0 ? (
            <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-dashed border-[#1c2739] text-[11px] text-[#3d4d66]">
              No autopilot bots yet - deploy one from the Autopilot or Research Lab tab and its live health appears here.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
              {s.bots.map((b) => (
                <BotHealthCard
                  key={b.botId}
                  bot={b}
                  baselineDraft={baselineDraft[b.botId] ?? ''}
                  onBaselineDraft={(v) => setBaselineDraft((d) => ({ ...d, [b.botId]: v }))}
                  onSetBaseline={() => void setBaseline(b.botId)}
                  onAck={() => void ack(b.botId)}
                />
              ))}
            </div>
          )}

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
            {/* thresholds editor */}
            <div className="rounded-lg border border-[#1c2739] bg-[#0b111c] p-3">
              <h4 className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-amber-400">Watchdog thresholds (persisted)</h4>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['windowTrades', 'Rolling window (settlements)', 5, 200],
                    ['minTrades', 'Min trades before judging', 2, 200],
                    ['winRateFloorPct', 'Win-rate hard floor %', 1, 99],
                    ['winRateDriftPct', 'Drift tolerance vs baseline (pts)', 1, 60],
                    ['profitFactorFloor', 'Profit-factor floor (0=off)', 0, 10],
                    ['maxConsecLosses', 'Max consecutive losses (0=off)', 0, 100],
                    ['graceTrades', 'Grace settlements before HOLD', 1, 100],
                    ['holdMinutes', 'Health-hold duration (min)', 1, 1440],
                    ['botDrawdownUsd', 'Bot P&L drawdown $ (0=off)', 0, 100000],
                    ['expectedWinRatePct', 'Fleet default baseline %', 1, 99],
                  ] as [keyof WatchdogConfig, string, number, number][]
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
              <div className="mt-3">
                <label className="flex items-center gap-2 text-[11px] text-[#aab6cc]">
                  <Switch checked={cfg.autoDisarm} onCheckedChange={(v) => setCfg((c) => ({ ...c, autoDisarm: v }))} />
                  Auto-disarm bots that are still degraded when their hold expires
                </label>
              </div>
              <Button onClick={() => void saveConfig()} disabled={saving} className="mt-3 h-8 bg-amber-600 px-3 text-[11px] text-white hover:bg-amber-500">
                {saving ? 'Saving…' : 'Save thresholds'}
              </Button>
              <p className="mt-2 text-[9px] leading-relaxed text-[#3d4d66]">
                Ladder: HEALTHY → WATCH (alerts) → HOLD (orders blocked {cfg.holdMinutes}m) → DISARMED (bot stopped). Baseline per bot =
                override, else the bot&apos;s own all-time win rate, else the fleet default. Ack recalibrates the window.
              </p>
            </div>

            {/* events feed */}
            <div className="flex min-h-0 flex-col rounded-lg border border-[#1c2739] bg-[#0b111c]">
              <h4 className="border-b border-[#141d2e] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-amber-400">Watchdog events</h4>
              <div className="min-h-0 flex-1 overflow-auto">
                {s.events.length === 0 ? (
                  <div className="flex h-full min-h-[80px] items-center justify-center text-[11px] text-[#3d4d66]">
                    No watchdog events yet - drift, holds, disarms and recoveries land here.
                  </div>
                ) : (
                  <div className="divide-y divide-[#0d1420]">
                    {s.events.map((e, i) => (
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

function BotHealthCard({
  bot,
  baselineDraft,
  onBaselineDraft,
  onSetBaseline,
  onAck,
}: {
  bot: WatchdogBotHealth
  baselineDraft: string
  onBaselineDraft: (v: string) => void
  onSetBaseline: () => void
  onAck: () => void
}) {
  const tone = LEVEL_TONE[bot.level]
  const m = bot.metrics
  const windowPct = Math.min(100, (m.trades / Math.max(1, bot.metrics.trades || 1)) * 100)
  const barPct = Math.min(100, (m.winRatePct / 100) * 100)
  const baselinePos = Math.min(100, (m.baselinePct / 100) * 100)
  const degraded = bot.level >= 1

  return (
    <div className={`rounded-lg border bg-[#0b111c] p-3 ${tone.ring}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${bot.enabled ? 'animate-pulse' : ''} ${bot.enabled ? 'bg-emerald-400' : 'bg-[#4b5a72]'}`} />
        <span className="text-[12px] font-semibold text-[#dbe4f0]">{bot.name}</span>
        <span className="font-mono text-[9px] text-[#4b5a72]">
          {bot.strategyId} · {bot.tf}
        </span>
        <span className={`ml-auto rounded px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1 ${tone.chip}`}>
          {bot.levelLabel}
        </span>
        {bot.level >= 2 && (
          <Button onClick={onAck} variant="outline" className="h-6 border-amber-500/40 px-2 text-[9px] uppercase text-amber-300 hover:bg-amber-500/10">
            ack
          </Button>
        )}
      </div>

      {bot.reason && (
        <p className={`mt-1.5 text-[10px] leading-snug ${degraded ? 'text-amber-300' : 'text-[#7c8aa5]'}`}>{bot.reason}</p>
      )}

      {/* rolling WR bar vs baseline marker */}
      <div className="mt-2">
        <div className="flex items-center justify-between font-mono text-[9px] text-[#4b5a72]">
          <span>
            rolling WR <span className={degraded ? 'text-amber-300' : 'text-emerald-400'}>{m.winRatePct}%</span> · baseline{' '}
            {m.baselinePct}%{bot.baselineOverridePct > 0 ? ' (set)' : ''}
          </span>
          <span>
            {m.trades}/{m.totalTrades} trades
          </span>
        </div>
        <div className="relative mt-1 h-2 w-full overflow-hidden rounded bg-[#101828]">
          <div
            className="h-full rounded transition-all duration-500"
            style={{ width: `${Math.max(windowPct > 0 ? barPct : 0, m.trades ? 1 : 0)}%`, background: degraded ? '#f59e0b' : '#10b981' }}
          />
          <div className="absolute top-0 h-full w-[2px] bg-cyan-400/80" style={{ left: `${baselinePos}%` }} title={`baseline ${m.baselinePct}%`} />
        </div>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1.5 font-mono text-[10px]">
        <MiniStat label="window P&L" value={fmtMoney(m.netPnl)} tone={m.netPnl > 0 ? 'up' : m.netPnl < 0 ? 'down' : 'flat'} />
        <MiniStat label="window PF" value={m.pf >= 99 ? '∞' : String(m.pf)} tone={m.pf >= 1 ? 'up' : m.pf > 0 ? 'down' : 'flat'} />
        <MiniStat label="loss streak" value={`${m.consecLosses}`} tone={m.consecLosses >= 3 ? 'down' : 'flat'} />
        <MiniStat label="dd from peak" value={fmtMoney(m.ddFromPeak)} tone={m.ddFromPeak > 0 ? 'down' : 'flat'} />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-[#141d2e] pt-2">
        <span className="font-mono text-[9px] text-[#3d4d66]">
          lifetime {fmtMoney(m.cumPnl)} · peak {fmtMoney(m.peakPnl)} · WR {m.totalTrades ? Math.round((m.totalWins / m.totalTrades) * 1000) / 10 : 0}% · acks {bot.acks}
          {bot.holdUntil > 0 && bot.level === 2 ? ` · hold ends ${fmtTime(bot.holdUntil)}` : ''}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Input
            value={baselineDraft}
            onChange={(e) => onBaselineDraft(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="baseline %"
            className="h-6 w-20 border-[#1c2739] bg-[#101828] font-mono text-[10px]"
          />
          <Button onClick={onSetBaseline} variant="outline" className="h-6 border-[#1c2739] px-2 text-[9px] uppercase text-[#7c8aa5] hover:text-cyan-300">
            set
          </Button>
        </span>
      </div>
    </div>
  )
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: 'up' | 'down' | 'flat' }) {
  return (
    <div className="rounded bg-[#101828] px-1.5 py-1">
      <div className="text-[8px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
      <div className={tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-rose-400' : 'text-[#aab6cc]'}>{value}</div>
    </div>
  )
}

function EventRow({ event }: { event: { ts: number; botId: string; kind: string; message: string } }) {
  const tone =
    event.kind === 'disarm' || event.kind === 'hold'
      ? 'text-rose-400'
      : event.kind === 'watch'
        ? 'text-amber-400'
        : event.kind === 'recover' || event.kind === 'ack'
          ? 'text-emerald-400'
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
