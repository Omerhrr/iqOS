'use client'

// IQAIR//OS - Autopilot: fleet manager for autonomous strategy bots.
// Bots evaluate a registered strategy on every closed candle of their
// watchlist and execute through the broker; the global risk manager
// (kill switch, daily loss, max stake) always outranks them.

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { AssetRow, AutoTraderConfig, BotConfig, BotRow, OsModeStatus, StrategyInfo, Timeframe, TradeKind, ValidationRow } from '@/lib/os/client'
import { KIND_LABEL, TIMEFRAMES, fmtMoney, fmtTime, osGet, osPost } from '@/lib/os/client'

const GATE_MAX_AGE_SEC = 14 * 24 * 60 * 60

// Seconds per candle, by timeframe - used only to convert "expiry in
// minutes" into the bar count binary/turbo bots actually store (expiryBars).
// Mirrors the kernel's own TIMEFRAME_SECONDS table.
const TF_SECONDS: Record<Timeframe, number> = {
  '5s': 5,
  '15s': 15,
  '30s': 30,
  '1m': 60,
  '2m': 120,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
}

/** Same check the kernel's autopilot.researchGate() runs before arming - re-run
 * here client-side (against the same /validation table) purely to SHOW the
 * user why a bot might be blocked, before they even try to start it. */
function gateStatus(bot: BotConfig, validations: Map<string, ValidationRow>): { ready: boolean; missing: string[] } {
  const missing: string[] = []
  for (const asset of bot.watchlist) {
    const v = validations.get(`${asset}|${bot.tf}|${bot.strategyId}`)
    const stale = v ? Math.floor(Date.now() / 1000) - v.ts > GATE_MAX_AGE_SEC : false
    if (!v || v.verdict !== 'robust' || stale) missing.push(asset)
  }
  return { ready: missing.length === 0, missing }
}

interface AutopilotPanelProps {
  bots: BotRow[]
  assets: AssetRow[]
  strategies: StrategyInfo[]
  modeStatus: OsModeStatus | null
  refreshMode: () => void
  onChanged: () => void
  onError: (m: string) => void
}

const emptyDraft = (): BotConfig => ({
  id: '',
  name: '',
  enabled: false,
  watchlist: [],
  strategyId: 'confluence-core',
  tf: '1m',
  kind: 'binary',
  stake: 10,
  expiryBars: 1,
  minScore: 55,
  direction: 'both',
  regime: 'all',
  maxOpen: 3,
  cooldownSec: 60,
  dailyProfitTarget: 0,
  dailyLossLimit: 0,
})

export default function AutopilotPanel({ bots, assets, strategies, modeStatus, refreshMode, onChanged, onError }: AutopilotPanelProps) {
  const mode = modeStatus?.mode ?? 'human'
  const [editorOpen, setEditorOpen] = useState(false)
  const [atOpen, setAtOpen] = useState(false)
  const [draft, setDraft] = useState<BotConfig>(emptyDraft())
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const [validations, setValidations] = useState<Map<string, ValidationRow>>(new Map())
  // Set only when the last save was rejected specifically by the research
  // gate ("research-gate: ..." from bot_save) - shows a "Force save anyway"
  // button in the editor instead of making the user go ask the copilot to
  // pass force:true on their behalf for a setting they edited by hand here.
  const [gateError, setGateError] = useState('')
  // Global research-gate switch (covers BOTH the built-in walk-forward gate
  // and the AI-Lab holdout gate) - null while unknown on first load.
  const [gateEnabled, setGateEnabled] = useState<boolean | null>(null)
  const [gateBusy, setGateBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await osGet<{ ok: boolean; validations: ValidationRow[] }>('/validation')
        if (alive && res.ok) {
          setValidations(new Map(res.validations.map((v) => [`${v.asset}|${v.tf}|${v.strategyId}`, v])))
        }
      } catch {
        // research-gate status is informational only - a failed fetch just leaves the last known map
      }
    }
    void load()
    const t = setInterval(() => void load(), 20000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    let alive = true
    osGet<{ ok: boolean; enabled: boolean }>('/research_gate')
      .then((res) => {
        if (alive && res.ok) setGateEnabled(res.enabled)
      })
      .catch(() => {
        // leave it null (unknown) rather than guessing
      })
    return () => {
      alive = false
    }
  }, [])

  const toggleResearchGate = async () => {
    if (gateEnabled === null || gateBusy) return
    const next = !gateEnabled
    // disabling is the risky direction - make sure this is really what they want
    if (!next && !window.confirm('Disable the research gate for ALL bots (built-in and AI-Lab)? Bots will be able to arm with NO validation requirement until you turn this back on.')) {
      return
    }
    setGateBusy(true)
    try {
      const res = await osPost<{ ok: boolean; enabled: boolean }>('/research_gate_toggle', { enabled: next })
      if (res.ok) setGateEnabled(res.enabled)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setGateBusy(false)
    }
  }

  const fleet = useMemo(() => {
    const running = bots.filter((b) => b.bot.enabled).length
    const pnlToday = bots.reduce((s, b) => s + b.stats.pnlToday, 0)
    const trades = bots.reduce((s, b) => s + b.stats.trades, 0)
    const wins = bots.reduce((s, b) => s + b.stats.wins, 0)
    const open = bots.reduce((s, b) => s + b.stats.openCount, 0)
    return { running, pnlToday, trades, wins, winRate: trades ? wins / trades : 0, open }
  }, [bots])

  const visible = bots.filter((b) => {
    const q = filter.trim().toLowerCase()
    if (!q) return true
    return (
      b.bot.name.toLowerCase().includes(q) ||
      b.bot.strategyId.includes(q) ||
      b.bot.watchlist.some((w) => w.toLowerCase().includes(q))
    )
  })

  const openNew = () => {
    setDraft(emptyDraft())
    setGateError('')
    setEditorOpen(true)
  }

  const openEdit = (row: BotRow) => {
    setDraft({ ...row.bot })
    setGateError('')
    setEditorOpen(true)
  }

  const save = async (force = false) => {
    setBusy(true)
    if (!force) setGateError('')
    try {
      const res = await osPost<{ ok: boolean; error?: string }>('/bot_save', { ...draft, force })
      if (res.ok) {
        setEditorOpen(false)
        setGateError('')
        onChanged()
      } else {
        const err = res.error ?? 'bot rejected'
        if (!force && err.startsWith('research-gate:')) setGateError(err)
        else onError(err)
      }
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (row: BotRow) => {
    try {
      const res = await osPost<{ ok: boolean; error?: string }>('/bot_toggle', { id: row.bot.id, enabled: !row.bot.enabled })
      if (res.ok) onChanged()
      else {
        const err = res.error ?? 'bot rejected'
        // same research-gate rejection the editor's Save hits - this quick
        // list-row toggle has no dialog to show a force button in, so point
        // the user to the one place that has it rather than silently
        // refusing with no way forward.
        onError(err.startsWith('research-gate:') ? `${err} - open the bot's settings and use "Force save anyway" to arm it unvalidated.` : err)
      }
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const remove = async (row: BotRow) => {
    try {
      // Task 58 (P2): 200-ok:false rejections surfaced instead of swallowed
      const res = await osPost<{ ok: boolean; error?: string }>('/bot_delete', { id: row.bot.id })
      if (!res.ok) onError(res.error ?? 'bot delete rejected')
      onChanged()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const restart = async (row: BotRow) => {
    try {
      const res = await osPost<{ ok: boolean; error?: string }>('/bot_restart', { id: row.bot.id })
      if (!res.ok) onError(res.error ?? 'bot restart rejected')
      onChanged()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const draftStrategy = strategies.find((s) => s.id === draft.strategyId)
  const patch = (p: Partial<BotConfig>) => setDraft((d) => ({ ...d, ...p }))
  /** Merge-compound-plan helper: keeps every plan field, overrides `over`. */
  const plan = (over: Partial<NonNullable<BotConfig['stakePlan']>>): BotConfig['stakePlan'] =>
    draft.stakePlan?.kind === 'compound'
      ? { ...draft.stakePlan, ...over }
      : { kind: 'compound', base: 1, rollPct: 100, payoutCap: 70, stopOnLoss: true, ...over }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 rounded-lg border border-[#1c2739] bg-[#0b111c] p-2.5">
      {/* mode gate banner - HUMAN mode suspends bot autonomy */}
      {mode === 'human' && (
        <div className="flex shrink-0 items-center justify-between gap-2 rounded border border-cyan-500/30 bg-cyan-500/5 px-2.5 py-1.5">
          <p className="text-[10px] leading-snug text-[#7c8aa5]">
            <span className="font-bold uppercase tracking-wider text-cyan-300">Human-in-the-loop:</span> bot orders are
            suspended by the mode gate. Switch the OS to <span className="text-amber-300">NO-HUMAN</span> mode (menu bar) to
            run autonomy.
          </p>
        </div>
      )}
      {/* auto-trader strip - the OS acting as its own trader in NO-HUMAN mode */}
      {modeStatus && (
        <AutoTraderStrip
          at={modeStatus.autotrader}
          mode={mode}
          onConfigure={() => setAtOpen(true)}
          onRestart={async () => {
            try {
              await osPost('/autotrader_restart', {})
              refreshMode()
            } catch (err) {
              onError((err as Error).message)
            }
          }}
        />
      )}

      {/* auto-trader config editor (remounts on open so the draft mirrors the kernel) */}
      <AutoTraderDialog
        key={String(atOpen)}
        open={atOpen}
        onOpenChange={setAtOpen}
        config={modeStatus?.autotrader.config ?? DEFAULT_AUTOTRADER_UI}
        assets={assets}
        strategies={strategies}
        onSave={async (cfg) => {
          await osPost<{ ok: boolean }>('/autotrader_config', cfg)
          refreshMode()
        }}
      />

      {/* header */}
      <div className="flex shrink-0 items-center justify-between">
        <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c8aa5]">
          Autopilot
          <span
            className={`h-1.5 w-1.5 rounded-full ${fleet.running ? 'animate-pulse bg-emerald-400' : 'bg-[#2a3850]'}`}
          />
          <span className="font-mono text-[9px] normal-case tracking-normal text-[#4b5a72]">
            {fleet.running}/{bots.length} armed
          </span>
        </h3>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            disabled={gateEnabled === null || gateBusy}
            onClick={toggleResearchGate}
            title={
              gateEnabled === null
                ? 'loading research-gate status…'
                : gateEnabled
                  ? 'Research gate is ON - bots must clear a validated edge (built-in walk-forward or AI-Lab holdout) before arming. Click to disable globally.'
                  : 'Research gate is OFF - ANY bot can arm with no validation requirement. Every bot armed now is tagged forcedUnvalidated. Click to re-enable.'
            }
            className={`h-6 rounded px-2.5 text-[10px] font-bold uppercase tracking-wider ${
              gateEnabled === false
                ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
                : 'bg-[#101828] text-[#7c8aa5] hover:bg-[#182334]'
            }`}
          >
            Research gate: {gateEnabled === null ? '…' : gateEnabled ? 'ON' : 'OFF'}
          </Button>
          <Button
            size="sm"
            onClick={openNew}
            className="h-6 rounded bg-cyan-500/15 px-2.5 text-[10px] font-bold uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/25"
          >
            + New Bot
          </Button>
        </div>
      </div>

      {/* fleet summary */}
      <div className="grid shrink-0 grid-cols-4 gap-1.5 font-mono text-[10px]">
        <FleetStat label="bot P&L today" value={fmtMoney(fleet.pnlToday)} tone={fleet.pnlToday >= 0 ? 'up' : 'down'} />
        <FleetStat label="bot trades" value={String(fleet.trades)} tone="neutral" />
        <FleetStat label="win rate" value={`${Math.round(fleet.winRate * 100)}%`} tone={fleet.winRate >= 0.5 ? 'up' : 'neutral'} />
        <FleetStat label="open" value={String(fleet.open)} tone="neutral" />
      </div>

      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="filter bots…"
        className="h-7 shrink-0 border-[#1c2739] bg-[#101828] text-[11px] text-[#e2e8f0] placeholder:text-[#3d4c66]"
      />

      {/* fleet list */}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
        {!bots.length && (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
            <p className="font-mono text-[11px] text-[#4b5a72]">No bots yet.</p>
            <p className="max-w-[280px] text-[10px] leading-relaxed text-[#3d4c66]">
              Create a bot, give it a strategy, watchlist and limits — it will trade every qualifying signal
              automatically, under the OS risk manager.
            </p>
            <Button
              size="sm"
              onClick={openNew}
              className="mt-1 h-7 rounded border border-cyan-500/40 bg-transparent px-3 text-[10px] font-bold uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/10"
            >
              Deploy first bot
            </Button>
          </div>
        )}
        {visible.map((row) => (
          <BotCard
            key={row.bot.id}
            row={row}
            gate={gateStatus(row.bot, validations)}
            onToggle={() => toggle(row)}
            onEdit={() => openEdit(row)}
            onDelete={() => remove(row)}
            onRestart={() => restart(row)}
          />
        ))}
        {bots.length > 0 && !visible.length && (
          <p className="py-6 text-center font-mono text-[10px] text-[#4b5a72]">no bots match &quot;{filter}&quot;</p>
        )}
      </div>

      {/* editor */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto border-[#1c2739] bg-[#0b111c] font-mono text-[#dbe4f0] sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="text-[13px] uppercase tracking-[0.18em] text-cyan-300">
              {draft.id ? `Edit ${draft.name}` : 'Deploy new bot'}
            </DialogTitle>
            <DialogDescription className="text-[10px] text-[#4b5a72]">
              The bot fires on candle close when its strategy signal passes every filter below. Global risk limits always apply.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Name</Label>
              <Input
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value.slice(0, 32) })}
                placeholder="e.g. EUR scalp"
                className="h-8 border-[#1c2739] bg-[#101828] text-[12px] text-[#e2e8f0]"
              />
            </div>

            <div>
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Strategy</Label>
              <select
                value={draft.strategyId}
                onChange={(e) => patch({ strategyId: e.target.value })}
                className="h-8 w-full rounded border border-[#1c2739] bg-[#101828] px-2 text-[11px] text-[#e2e8f0] outline-none focus:border-cyan-500/50"
              >
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Timeframe</Label>
              <select
                value={draft.tf}
                onChange={(e) => patch({ tf: e.target.value as Timeframe })}
                className="h-8 w-full rounded border border-[#1c2739] bg-[#101828] px-2 text-[11px] text-[#e2e8f0] outline-none focus:border-cyan-500/50"
              >
                {TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-span-2">
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">
                Watchlist ({draft.watchlist.length}/{draft.stakePlan?.kind === 'compound' ? 1 : 12})
              </Label>
              <WatchlistPicker
                assets={assets}
                selected={draft.watchlist}
                onChange={(w) => patch({ watchlist: draft.stakePlan?.kind === 'compound' ? w.slice(-1) : w })}
              />
              {draft.stakePlan?.kind === 'compound' && (
                <p className="mt-1 text-[9px] leading-relaxed text-[#4b5a72]">
                  Compound bots trade one asset at a time - the pot has no reservation between opening a trade and
                  settling it, so a second concurrent trade would stake off the same pot and corrupt the roll.
                </p>
              )}
            </div>

            <div>
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Instrument type</Label>
              <select
                value={draft.kind}
                onChange={(e) => patch({ kind: e.target.value as TradeKind })}
                className="h-8 w-full rounded border border-[#1c2739] bg-[#101828] px-2 text-[11px] text-[#e2e8f0] outline-none focus:border-cyan-500/50"
              >
                {(['binary', 'turbo', 'digital', 'cfd'] as TradeKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">
                {draft.stakePlan?.kind === 'compound' ? 'Seed stake $ (ignored)' : 'Stake $'}
              </Label>
              <Input
                value={String(draft.stake)}
                onChange={(e) => patch({ stake: Number(e.target.value.replace(/[^0-9.]/g, '')) || 0 })}
                className="h-8 border-[#1c2739] bg-[#101828] text-right text-[12px] text-[#e2e8f0]"
              />
            </div>

            <Segmented
              label="Stake plan"
              options={[
                { v: 'fixed', label: 'Fixed' },
                { v: 'compound', label: 'Compound' },
              ]}
              value={draft.stakePlan?.kind === 'compound' ? 'compound' : 'fixed'}
              onChange={(v) =>
                patch(
                  v === 'compound'
                    ? { stakePlan: plan({}), maxOpen: 1, watchlist: draft.watchlist.slice(-1) }
                    : { stakePlan: undefined },
                )
              }
            />

            {draft.stakePlan?.kind === 'compound' && (
              <>
                <NumField
                  label="Seed stake $ (each restart)"
                  value={draft.stakePlan.base}
                  onChange={(v) => patch({ stakePlan: plan({ base: Math.max(1, v) }) })}
                />
                <NumField
                  label="Roll % of pot (100 = all-in)"
                  value={draft.stakePlan.rollPct ?? 100}
                  onChange={(v) => patch({ stakePlan: plan({ rollPct: Math.min(100, Math.max(1, v)) }) })}
                />
                <NumField
                  label="Max stake cap $ (0 = none)"
                  value={draft.stakePlan.maxStake ?? 0}
                  onChange={(v) => patch({ stakePlan: plan({ maxStake: v > 0 ? v : undefined }) })}
                />
                <NumField
                  label="Payout cap % (max 70)"
                  value={draft.stakePlan.payoutCap ?? 70}
                  onChange={(v) => patch({ stakePlan: plan({ payoutCap: Math.min(70, Math.max(1, v)) }) })}
                />
                <NumField
                  label="Periods (0 = compound until loss)"
                  value={draft.stakePlan.periods ?? 0}
                  onChange={(v) =>
                    patch({
                      stakePlan: plan({
                        periods: v > 0 ? Math.round(v) : undefined,
                        ...(v > 0 ? {} : { onComplete: undefined }),
                      }),
                    })
                  }
                />
                <NumField
                  label="De-risk after roll # (0 = never)"
                  value={draft.stakePlan.deriskAfter ?? 0}
                  onChange={(v) =>
                    patch({
                      stakePlan: plan({
                        deriskAfter: v > 0 ? Math.round(v) : undefined,
                        deriskPct: v > 0 ? (draft.stakePlan?.deriskPct ?? 50) : undefined,
                      }),
                    })
                  }
                />
                {(draft.stakePlan.deriskAfter ?? 0) > 0 && (
                  <NumField
                    label="De-risk stake % of pot"
                    value={draft.stakePlan.deriskPct ?? 50}
                    onChange={(v) => patch({ stakePlan: plan({ deriskPct: Math.min(100, Math.max(1, v)) }) })}
                  />
                )}
                {(draft.stakePlan.periods ?? 0) > 0 && (
                  <Segmented
                    label="On complete"
                    options={[
                      { v: 'halt', label: 'Stand down' },
                      { v: 'reseed', label: 'Re-seed' },
                    ]}
                    value={draft.stakePlan.onComplete === 'reseed' ? 'reseed' : 'halt'}
                    onChange={(v) => patch({ stakePlan: plan({ onComplete: v as 'halt' | 'reseed' }) })}
                  />
                )}
                <Segmented
                  label="On loss"
                  options={[
                    { v: 'end', label: 'End cycle' },
                    { v: 'roll', label: 'Re-seed' },
                  ]}
                  value={draft.stakePlan.stopOnLoss === false ? 'roll' : 'end'}
                  onChange={(v) => patch({ stakePlan: plan({ stopOnLoss: v !== 'roll' }) })}
                />
              </>
            )}

            <div className="col-span-2">
              <div className="flex items-center justify-between">
                <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Min signal score</Label>
                <span className="font-mono text-[10px] text-cyan-300">{draft.minScore}</span>
              </div>
              <Slider
                value={[draft.minScore]}
                min={0}
                max={90}
                step={5}
                onValueChange={([v]) => patch({ minScore: v })}
                className="mt-2 [&_[data-slot=slider-range]]:bg-cyan-400 [&_[data-slot=slider-thumb]]:border-cyan-400"
              />
            </div>

            <Segmented
              label="Direction"
              options={[
                { v: 'both', label: 'Both' },
                { v: 'call', label: 'Call only' },
                { v: 'put', label: 'Put only' },
              ]}
              value={draft.direction}
              onChange={(v) => patch({ direction: v as BotConfig['direction'] })}
            />
            <Segmented
              label="Regime filter"
              options={[
                { v: 'all', label: 'All' },
                { v: 'trend', label: 'Trend' },
                { v: 'range', label: 'Range' },
                { v: 'avoid-volatile', label: 'Avoid volatile' },
              ]}
              value={draft.regime}
              onChange={(v) => patch({ regime: v as BotConfig['regime'] })}
            />
            <Segmented
              label="Adaptive confidence gate"
              options={[
                { v: 'on', label: 'On (recommended)' },
                { v: 'off', label: 'Off' },
              ]}
              value={draft.adaptive === false ? 'off' : 'on'}
              onChange={(v) => patch({ adaptive: v !== 'off' })}
            />
            <p className="-mt-1 text-[9px] leading-relaxed text-[#4b5a72]">
              Only fires when THIS asset/tf/strategy/side/score-bucket has its own proven settled record (95%
              confidence floor) - see the Research panel for bucket-by-bucket stats. New setups still trade while
              they build a track record; only setups with enough history AND a weak record get held back.
            </p>

            <NumField
              label="Min payout % (0 = off)"
              value={draft.minPayoutPct ?? 0}
              onChange={(v) => patch({ minPayoutPct: Math.min(98, Math.max(0, v)) })}
            />
            <p className="-mt-1 text-[9px] leading-relaxed text-[#4b5a72]">
              The EV gate: never fires when the pair&apos;s live payout for this bot&apos;s kind is below the floor.
              Breakeven = 100/(1+payout): 54.9% at 82%, 60.6% at 65% - payouts move per pair per hour, and a signal
              worth taking at one payout can be pure house-edge at a lower one. Pairs with unknown payouts still trade.
            </p>

            <Segmented
              label="Streak-breaker (self-bench)"
              options={[
                { v: 'on', label: 'On' },
                { v: 'off', label: 'Off' },
              ]}
              value={draft.streakBreaker ? 'on' : 'off'}
              onChange={(v) => patch({ streakBreaker: v === 'on' })}
            />
            <p className="-mt-1 text-[9px] leading-relaxed text-[#4b5a72]">
              After 3 consecutive losses the bot benches ITSELF for 15 minutes, doubling per extra loss (max 4h).
              Independent of the watchdog (which needs your ack) and the daily $ limits - a losing run ends the
              bench on its own, and any win lifts it immediately.
            </p>

            {draft.stakePlan?.kind === 'compound' ? (
              <div>
                <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Max open positions (locked)</Label>
                <Input value="1" disabled className="h-8 border-[#1c2739] bg-[#0b1220] text-right text-[12px] text-[#4b5a72]" />
              </div>
            ) : (
              <NumField label="Max open positions" value={draft.maxOpen} onChange={(v) => patch({ maxOpen: v })} />
            )}
            <NumField label="Cooldown between trades (s)" value={draft.cooldownSec} onChange={(v) => patch({ cooldownSec: v })} />
            <NumField
              label="Daily profit target $ (0 = off)"
              value={draft.dailyProfitTarget ?? 0}
              onChange={(v) => patch({ dailyProfitTarget: v })}
            />
            <NumField
              label="Daily loss limit $ (0 = off)"
              value={draft.dailyLossLimit ?? 0}
              onChange={(v) => patch({ dailyLossLimit: v })}
            />

            {draft.kind === 'binary' || draft.kind === 'turbo' ? (
              <div>
                <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">
                  Expiry (seconds, {TF_SECONDS[draft.tf]}s/bar on {draft.tf})
                </Label>
                <Input
                  type="number"
                  min={TF_SECONDS[draft.tf]}
                  step={TF_SECONDS[draft.tf]}
                  // Binary/turbo bots settle on BAR COUNT (expiryBars), not
                  // wall-clock time - there is no seconds field in the stored
                  // config. A minutes-only control here used to round down to
                  // 0 (and show blank) on sub-minute timeframes (5s/15s/30s),
                  // which is exactly what made it look like there was no way
                  // to set expiry manually on those tf's. Seconds is the only
                  // unit that works for every timeframe, so this is the one
                  // field: type a wall-clock duration in seconds and it
                  // converts to the nearest whole bar count for the CURRENT
                  // timeframe, which is what actually gets saved.
                  value={String(draft.expiryBars * TF_SECONDS[draft.tf] || '')}
                  onChange={(e) => {
                    const secs = Math.max(0, Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)
                    const bars = Math.max(1, Math.round(secs / TF_SECONDS[draft.tf]))
                    patch({ expiryBars: bars })
                  }}
                  className="h-8 border-[#1c2739] bg-[#101828] text-right text-[12px] text-[#e2e8f0]"
                />
                <div className="mt-0.5 text-[9px] text-[#4b5a72]">
                  = {draft.expiryBars} bar{draft.expiryBars === 1 ? '' : 's'} ({draft.expiryBars * TF_SECONDS[draft.tf]}s
                  {draft.expiryBars * TF_SECONDS[draft.tf] >= 60 ? ` ≈ ${(draft.expiryBars * TF_SECONDS[draft.tf] / 60).toFixed(1)} min` : ''}) on this
                  timeframe - changing the timeframe keeps the bar count, not the duration, so re-check this after switching tf
                </div>
              </div>
            ) : draft.kind === 'digital' ? (
              <NumField
                label="Expiry (minutes)"
                value={(draft.expirySec ?? 300) / 60}
                onChange={(v) => patch({ expirySec: Math.min(1440, Math.max(1, Math.round(v))) * 60 })}
              />
            ) : null}

            <div>
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Trading session (UTC)</Label>
              <select
                value={draft.session ?? 'all'}
                onChange={(e) => patch({ session: e.target.value as BotConfig['session'] })}
                className="h-8 w-full rounded border border-[#1c2739] bg-[#101828] px-2 text-[11px] text-[#e2e8f0] outline-none focus:border-cyan-500/50"
              >
                <option value="all">All sessions (24h)</option>
                <option value="overlap">London × NY overlap</option>
                <option value="london">London</option>
                <option value="newyork">New York</option>
                <option value="asia">Asia</option>
                <option value="sydney">Sydney</option>
              </select>
            </div>

            {draftStrategy && draftStrategy.params.length > 0 && (
              <div className="col-span-2 rounded border border-[#1c2739] bg-[#101828] p-2">
                <div className="mb-1.5 text-[9px] uppercase tracking-wider text-[#4b5a72]">
                  {draftStrategy.name} parameters
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {draftStrategy.params.map((p) => (
                    <div key={p.key}>
                      <div className="mb-0.5 truncate text-[9px] text-[#4b5a72]">{p.label}</div>
                      {p.type === 'select' ? (
                        <select
                          value={String(draft.params?.[p.key] ?? p.default)}
                          onChange={(e) => {
                            const next = { ...(draft.params ?? {}) }
                            next[p.key] = e.target.value
                            patch({ params: next })
                          }}
                          className="h-7 w-full rounded border border-[#1c2739] bg-[#0b111c] px-1.5 text-[11px] text-[#e2e8f0] outline-none"
                        >
                          {(p.options ?? []).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : p.type === 'text' ? (
                        <Input
                          value={String(draft.params?.[p.key] ?? p.default)}
                          onChange={(e) => {
                            const next = { ...(draft.params ?? {}) }
                            if (e.target.value.trim() === '') delete next[p.key]
                            else next[p.key] = e.target.value
                            patch({ params: next })
                          }}
                          placeholder={String(p.default)}
                          className="h-7 border-[#1c2739] bg-[#0b111c] text-[11px] text-[#e2e8f0]"
                        />
                      ) : (
                        <Input
                          value={String(draft.params?.[p.key] ?? p.default)}
                          onChange={(e) => {
                            const raw = e.target.value.replace(/[^0-9.\-]/g, '')
                            const next = { ...(draft.params ?? {}) }
                            if (raw === '') delete next[p.key]
                            else next[p.key] = Number(raw)
                            patch({ params: next })
                          }}
                          className="h-7 border-[#1c2739] bg-[#0b111c] text-[11px] text-[#e2e8f0]"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="col-span-2 flex items-center justify-between rounded border border-[#1c2739] bg-[#101828] px-3 py-2">
              <div>
                <div className="text-[11px] font-bold text-[#e2e8f0]">Arm immediately</div>
                <div className="text-[9px] text-[#4b5a72]">bot starts evaluating on the next candle close</div>
              </div>
              <Switch checked={draft.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
            </div>
          </div>

          {gateError && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-300">
              {gateError}
              <div className="mt-1 text-[9px] text-amber-400/80">
                This instrument/tf/strategy combo has not passed a recent robust walk-forward. Forcing arms it UNVALIDATED - it will show a &quot;forced · unvalidated&quot; badge on the fleet list and should be treated as the user&apos;s deliberate override, not a tested edge.
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setEditorOpen(false)}
              className="h-8 rounded text-[11px] text-[#7c8aa5] hover:bg-[#101828] hover:text-[#dbe4f0]"
            >
              Cancel
            </Button>
            {gateError ? (
              <Button
                onClick={() => void save(true)}
                disabled={busy}
                className="h-8 rounded bg-amber-500/20 text-[11px] font-bold uppercase tracking-wider text-amber-300 hover:bg-amber-500/30"
              >
                {busy ? 'Saving…' : 'Force save anyway (unvalidated)'}
              </Button>
            ) : (
              <Button
                onClick={() => void save()}
                disabled={busy || !draft.watchlist.length}
                className="h-8 rounded bg-cyan-500/20 text-[11px] font-bold uppercase tracking-wider text-cyan-200 hover:bg-cyan-500/30"
              >
                {busy ? 'Saving…' : draft.id ? 'Save bot' : 'Deploy bot'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------- pieces ----------

function FleetStat({ label, value, tone }: { label: string; value: string; tone: 'up' | 'down' | 'neutral' }) {
  return (
    <div className="rounded border border-[#1c2739] bg-[#101828] px-2 py-1.5">
      <div className="text-[8px] uppercase tracking-wider text-[#4b5a72]">{label}</div>
      <div
        className={`text-[12px] font-bold ${
          tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-rose-400' : 'text-[#dbe4f0]'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function BotCard({
  row,
  gate,
  onToggle,
  onEdit,
  onDelete,
  onRestart,
}: {
  row: BotRow
  gate: { ready: boolean; missing: string[] }
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  onRestart: () => void
}) {
  const { bot, stats } = row
  const winRate = stats.trades ? stats.wins / stats.trades : null
  const halted = bot.stakePlan?.kind === 'compound' && bot.stakePlan.stopOnLoss !== false && stats.halted
  const complete = halted && stats.complete
  return (
    <div
      className={`rounded-md border p-2 transition-colors ${
        halted
          ? 'border-amber-500/40 bg-[#151109]'
          : bot.enabled
            ? 'border-emerald-500/30 bg-[#0d151f]'
            : 'border-[#1c2739] bg-[#0d121d]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${halted ? 'bg-amber-400' : bot.enabled ? 'animate-pulse bg-emerald-400' : 'bg-[#2a3850]'}`} />
          <span className="truncate text-[12px] font-bold text-[#e2e8f0]">{bot.name}</span>
          {halted && (
            <span
              className={`shrink-0 rounded px-1 py-px text-[8px] font-bold uppercase ${
                complete ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
              }`}
            >
              {complete ? 'cycle complete' : 'cycle ended'}
            </span>
          )}
          {stats.openCount > 0 && (
            <span className="shrink-0 rounded bg-amber-500/15 px-1 py-px text-[8px] font-bold uppercase text-amber-300">
              {stats.openCount} open
            </span>
          )}
          {bot.forcedUnvalidated && (
            <span
              className="shrink-0 rounded bg-rose-500/15 px-1 py-px text-[8px] font-bold uppercase text-rose-300"
              title="Armed past a FAILING research gate on an explicit force override - this is not a validated edge, it's the user's deliberate choice to run an unproven strategy."
            >
              forced · unvalidated
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {halted && (
            <button
              onClick={onRestart}
              className="rounded bg-amber-500/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-200 transition-colors hover:bg-amber-500/30"
            >
              Restart
            </button>
          )}
          <button
            onClick={onToggle}
            className={`rounded px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider transition-colors ${
              bot.enabled
                ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
                : 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
            }`}
          >
            {bot.enabled ? 'Stop' : 'Start'}
          </button>
          <button
            onClick={onEdit}
            className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5] hover:bg-[#1c2739] hover:text-cyan-300"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#7c8aa5] hover:bg-rose-500/15 hover:text-rose-300"
          >
            Del
          </button>
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[9px] text-[#4b5a72]">
        <span className="rounded bg-[#101828] px-1 py-px text-cyan-300/80">{bot.strategyId}</span>
        <span className="rounded bg-[#101828] px-1 py-px">{bot.tf}</span>
        <span className="rounded bg-[#101828] px-1 py-px">{KIND_LABEL[bot.kind]}</span>
        <span className="rounded bg-[#101828] px-1 py-px">min {bot.minScore}</span>
        {bot.stakePlan?.kind === 'compound' ? (
          <span className="rounded bg-violet-500/15 px-1 py-px text-violet-300">
            compound ${bot.stakePlan.base}
            {bot.stakePlan.rollPct !== undefined && bot.stakePlan.rollPct !== 100 ? ` · roll ${bot.stakePlan.rollPct}%` : ''}
            {bot.stakePlan.maxStake ? ` · cap $${bot.stakePlan.maxStake}` : ''}
            {` · pay≤${bot.stakePlan.payoutCap ?? 70}%`}
            {bot.stakePlan.periods ? ` · ${bot.stakePlan.periods}p` : ''}
            {bot.stakePlan.deriskAfter ? ` · derisk½@${bot.stakePlan.deriskAfter}` : ''}
            {bot.stakePlan.stopOnLoss === false ? ' · re-seed' : ' · stop on loss'}
          </span>
        ) : (
          <span className="rounded bg-[#101828] px-1 py-px">${bot.stake}</span>
        )}
        {bot.direction !== 'both' && <span className="rounded bg-[#101828] px-1 py-px">{bot.direction} only</span>}
        {bot.regime !== 'all' && <span className="rounded bg-[#101828] px-1 py-px">{bot.regime} regime</span>}
        {bot.adaptive === false ? (
          <span className="rounded bg-[#101828] px-1 py-px" title="adaptive confidence gate turned off for this bot">
            adaptive off
          </span>
        ) : (
          <span className="rounded bg-cyan-500/15 px-1 py-px text-cyan-300" title="only fires setups with a proven settled record for this exact asset/tf/strategy/side/score/regime">
            adaptive
          </span>
        )}
        {bot.session && bot.session !== 'all' && (
          <span className="rounded bg-sky-500/15 px-1 py-px text-sky-300">{bot.session} only</span>
        )}
        {(bot.minPayoutPct ?? 0) > 0 && (
          <span className="rounded bg-emerald-500/15 px-1 py-px text-emerald-300" title="payout floor - never fires below this live payout (EV gate)">
            pay≥{bot.minPayoutPct}%
          </span>
        )}
        {bot.streakBreaker && (
          <span className="rounded bg-amber-500/15 px-1 py-px text-amber-300" title="self-bench after 3+ consecutive losses (15min, doubling, 4h cap)">
            streak-breaker
          </span>
        )}
        {!bot.enabled && (
          <span
            className={`rounded px-1 py-px ${gate.ready ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}
            title={gate.ready ? 'every watchlist instrument has a robust, recent walk-forward validation' : `missing/stale robust validation: ${gate.missing.join(', ')}`}
          >
            {gate.ready ? 'gate: ready' : `gate: ${gate.missing.length} missing`}
          </span>
        )}
      </div>

      <div className="mt-1 flex items-center justify-between font-mono text-[9px]">
        <span className="truncate text-[#3d4c66]">{bot.watchlist.join(' · ')}</span>
        <div className="flex shrink-0 items-center gap-2">
          <span className={stats.pnlToday >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
            today {stats.pnlToday >= 0 ? '+' : ''}{fmtMoney(stats.pnlToday)}
          </span>
          {winRate !== null && <span className="text-[#7c8aa5]">{Math.round(winRate * 100)}% win</span>}
          {bot.stakePlan?.kind === 'compound' && (
            <span className="text-violet-300/80">
              roll x{stats.rollN}
              {stats.pot > 0 ? ` · pot ${fmtMoney(stats.pot)}` : ' · at seed'}
              {stats.restarts > 0 ? ` · ${stats.restarts} cycles` : ''}
            </span>
          )}
          {stats.streak !== 0 && (
            <span className={stats.streak > 0 ? 'text-emerald-400/70' : 'text-rose-400/70'}>
              {stats.streak > 0 ? `+${stats.streak}` : stats.streak}
            </span>
          )}
          {stats.lastTradeTs > 0 && <span className="text-[#3d4c66]">last {fmtTime(stats.lastTradeTs)}</span>}
        </div>
      </div>
      {stats.lastRejection && (
        <p className="mt-0.5 truncate font-mono text-[8px] text-amber-500/60" title={stats.lastRejection}>
          standing down: {stats.lastRejection}
        </p>
      )}
    </div>
  )
}

/** Searchable multi-select for the Strategy auto-trader source. One pick =
 * trade that single strategy; two or more = an ensemble (every member votes,
 * majority direction wins). In `singleSelect` mode (SINGLE in the dialog's
 * selection-mode control) clicking a strategy REPLACES the pick - the
 * previously selected one is deselected - so a pool can never accumulate by
 * accident; POOL mode keeps the toggle-many behavior. Mirrors WatchlistPicker's
 * search+chip pattern. */
function StrategyPicker({
  strategies,
  selected,
  onChange,
  singleSelect = false,
}: {
  strategies: StrategyInfo[]
  selected: string[]
  onChange: (ids: string[]) => void
  singleSelect?: boolean
}) {
  const [q, setQ] = useState('')
  const options = useMemo(() => {
    const query = q.trim().toLowerCase()
    const list = query
      ? strategies.filter((s) => s.name.toLowerCase().includes(query) || s.id.toLowerCase().includes(query))
      : strategies
    return list.slice(0, 80)
  }, [strategies, q])

  const toggle = (id: string) => {
    if (singleSelect) {
      // SINGLE: one strategy at a time - picking one deselects the rest
      // (clicking the picked one again clears the selection entirely).
      onChange(selected.includes(id) ? [] : [id])
      return
    }
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id].slice(0, 8))
  }

  return (
    <div>
      {selected.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {selected.map((id) => (
            <button
              key={id}
              onClick={() => toggle(id)}
              className="rounded bg-cyan-500/15 px-1.5 py-px text-[9px] text-cyan-300 hover:bg-rose-500/20 hover:text-rose-300"
            >
              {strategies.find((s) => s.id === id)?.name ?? id} ×
            </button>
          ))}
        </div>
      )}
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={singleSelect ? 'search strategies… (picking one replaces the last)' : 'search strategies…'}
        className="h-7 border-[#1c2739] bg-[#0b111c] text-[11px] text-[#e2e8f0] placeholder:text-[#3d4c66]"
      />
      <div className="mt-1 flex max-h-28 flex-col gap-0.5 overflow-y-auto">
        {options.map((s) => (
          <button
            key={s.id}
            onClick={() => toggle(s.id)}
            className={`rounded px-1.5 py-1 text-left text-[10px] transition-colors ${
              selected.includes(s.id)
                ? 'bg-cyan-500/25 text-cyan-200'
                : 'bg-[#101828] text-[#7c8aa5] hover:bg-[#1c2739] hover:text-[#dbe4f0]'
            }`}
          >
            {s.name}
          </button>
        ))}
        {options.length === 0 && <div className="px-1.5 py-1 text-[9px] text-[#4b5a72]">no strategies match</div>}
      </div>
    </div>
  )
}

/** "For THIS pair always use THIS strategy" - assigns a single strategy id
 * to a single ticker, bypassing the global strategyIds/ensemble/auto-learn
 * pool for that pair only. Built for "I studied strategy X in the AI Lab on
 * EURUSD but want it traded on GBPJPY" - each row here is one pin. Every pin
 * is cross-checked against the rest of the config so a pin that can never
 * actually trade says so right on the row (outside the pair restriction, or
 * pointing at an instrument the connected account can't take options on). */
function PairStrategyPicker({
  assets,
  strategies,
  value,
  onChange,
  watchlist,
  watchlistMode,
  nonOptionTickers,
}: {
  assets: AssetRow[]
  strategies: StrategyInfo[]
  value: Record<string, string> | undefined
  // Always emits a plain object, even when it ends up empty - {} (not null
  // or undefined) is what makes "I removed my last pin" actually reach the
  // server on save: a patch field stays as plain JS undefined until the
  // dialog's Save posts `d` as JSON, and JSON.stringify DROPS undefined
  // keys outright, so a cleared-to-undefined field would never even appear
  // in the saved request body - the backend's own empty-object collapse
  // (sanitizePairStrategy) is what then turns {} into "no pins" there.
  onChange: (next: Record<string, string>) => void
  watchlist: string[]
  watchlistMode: 'only' | 'exclude'
  /** Tickers the connected account cannot trade as options (CFD-only) - a
   * pin on one is dead on arrival since the auto-trader only fires binary
   * options. Empty in sim mode (everything is options-capable there). */
  nonOptionTickers: Set<string>
}) {
  const pins = value ?? {}
  const pinnedAssets = Object.keys(pins)
  const [addAsset, setAddAsset] = useState('')
  const [addStrategy, setAddStrategy] = useState('')

  const addPin = () => {
    if (!addAsset || !addStrategy) return
    onChange({ ...pins, [addAsset]: addStrategy })
    setAddAsset('')
    setAddStrategy('')
  }
  const removePin = (asset: string) => {
    const next = { ...pins }
    delete next[asset]
    onChange(next)
  }

  /** Why this pin can never trade under the CURRENT config, or null. */
  const pinConflict = (asset: string): string | null => {
    if (nonOptionTickers.has(asset)) return 'not options-capable on this account (CFD-only) - the auto-trader only fires binary options, so this pin can never trade'
    if (watchlist.length > 0) {
      const inList = watchlist.includes(asset)
      if (watchlistMode === 'only' && !inList) return 'outside the pair restriction below (Only trade these) - this pin is never evaluated'
      if (watchlistMode === 'exclude' && inList) return 'on the Never-trade list below - this pin is never evaluated'
    }
    return null
  }

  return (
    <div className="mt-2 rounded border border-[#1c2739] bg-[#0b1220] p-2">
      <p className="text-[10px] text-[#c7d2e3]">Per-pair strategy pins</p>
      <p className="mt-0.5 text-[8px] leading-relaxed text-[#3d4c66]">
        Override the pool above for specific pairs - e.g. a strategy you studied on one pair in the AI Lab but want
        traded on a different one. A pinned pair ignores the global strategy/ensemble/auto-learn pick entirely and
        runs ONLY the strategy assigned here; if that strategy is later removed, the pair just sits out instead of
        falling back to the pool. Pinned pairs must also pass the pair restriction below to trade.
      </p>
      {pinnedAssets.length > 0 && (
        <div className="mt-2 space-y-1">
          {pinnedAssets.map((asset) => {
            const strat = strategies.find((s) => s.id === pins[asset])
            const conflict = pinConflict(asset)
            return (
              <div key={asset} className={`rounded border px-2 py-1 ${conflict ? 'border-amber-500/40 bg-amber-500/5' : 'border-[#141d2e] bg-[#0d1420]'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[10px] text-[#dbe4f0]">
                    {asset} <span className="text-[#4b5a72]">→</span>{' '}
                    <span className="text-cyan-300">{strat?.name ?? pins[asset]}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removePin(asset)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[9px] text-[#4b5a72] hover:bg-rose-500/20 hover:text-rose-300"
                  >
                    ×
                  </button>
                </div>
                {conflict && <p className="mt-0.5 text-[8px] leading-snug text-amber-300/80">⚠ {conflict}</p>}
              </div>
            )
          })}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <select
          value={addAsset}
          onChange={(e) => setAddAsset(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-[#1c2739] bg-[#0b111c] px-1.5 text-[10px] text-[#e2e8f0] outline-none"
        >
          <option value="">pair…</option>
          {assets.map((a) => (
            <option key={a.ticker} value={a.ticker}>
              {a.ticker}
              {nonOptionTickers.has(a.ticker) ? ' (CFD-only)' : ''}
            </option>
          ))}
        </select>
        <select
          value={addStrategy}
          onChange={(e) => setAddStrategy(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-[#1c2739] bg-[#0b111c] px-1.5 text-[10px] text-[#e2e8f0] outline-none"
        >
          <option value="">strategy…</option>
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Button
          onClick={addPin}
          disabled={!addAsset || !addStrategy}
          variant="outline"
          className="h-7 shrink-0 border-[#1c2739] px-2 text-[9px] uppercase tracking-wider text-[#7c8aa5] hover:text-cyan-300 disabled:opacity-40"
        >
          pin
        </Button>
      </div>
    </div>
  )
}

/** "For every CALL use THIS strategy, for every PUT use THIS one" - the
 * direction analog of PairStrategyPicker above: two single-strategy slots
 * instead of a per-pair map. Either slot can be left on "pool" (the global
 * strategyIds/ensemble/auto-learn pick keeps deciding that side) or pinned
 * to one specific strategy, independent of the other slot. */
function DirectionStrategyPicker({
  strategies,
  value,
  onChange,
}: {
  strategies: StrategyInfo[]
  value: { call?: string; put?: string } | undefined
  onChange: (next: { call?: string; put?: string }) => void
}) {
  const v = value ?? {}
  const setSlot = (side: 'call' | 'put', id: string) => {
    const next = { ...v }
    if (id) next[side] = id
    else delete next[side]
    onChange(next)
  }
  return (
    <div className="mt-2 rounded border border-[#1c2739] bg-[#0b1220] p-2">
      <p className="text-[10px] text-[#c7d2e3]">Per-direction strategy pins</p>
      <p className="mt-0.5 text-[8px] leading-relaxed text-[#3d4c66]">
        Override the pool above by side - e.g. one strategy you trust for CALLs, a different one for PUTs. A pinned
        side ignores the global strategy/ensemble/auto-learn pick entirely and only trades when THAT strategy&apos;s
        own read agrees with the side it&apos;s assigned to; a per-pair pin above still wins over this for any pair it
        covers. A side left on &quot;pool (default)&quot; keeps using the global pick for it - pinning only CALL still
        lets the pool trade PUTs; clear the pool too if you want calls-only, period.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] uppercase tracking-wider text-emerald-400">CALL strategy</span>
          <select
            value={v.call ?? ''}
            onChange={(e) => setSlot('call', e.target.value)}
            className="h-7 rounded border border-[#1c2739] bg-[#0b111c] px-1.5 text-[10px] text-[#e2e8f0] outline-none"
          >
            <option value="">pool (default)</option>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] uppercase tracking-wider text-rose-400">PUT strategy</span>
          <select
            value={v.put ?? ''}
            onChange={(e) => setSlot('put', e.target.value)}
            className="h-7 rounded border border-[#1c2739] bg-[#0b111c] px-1.5 text-[10px] text-[#e2e8f0] outline-none"
          >
            <option value="">pool (default)</option>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}

function WatchlistPicker({
  assets,
  selected,
  onChange,
  nonOptionTickers,
}: {
  assets: AssetRow[]
  selected: string[]
  onChange: (w: string[]) => void
  /** Tickers that cannot trade binary/turbo options on the connected account
   * (CFD-only: payout metadata reports nothing). Rendered dimmed + tagged,
   * clicks refused - the auto-trader only ever fires binary options, so
   * picking one would only manufacture guaranteed broker rejections. The
   * bot editor omits this (bots have a CFD instrument type of their own). */
  nonOptionTickers?: Set<string>
}) {
  const [q, setQ] = useState('')
  const options = useMemo(() => {
    const query = q.trim().toLowerCase()
    const list = query
      ? assets.filter((a) => a.ticker.toLowerCase().includes(query) || a.name.toLowerCase().includes(query))
      : assets
    return list.slice(0, 60)
  }, [assets, q])

  const toggle = (t: string) => {
    if (nonOptionTickers?.has(t)) return
    onChange(selected.includes(t) ? selected.filter((x) => x !== t) : [...selected, t].slice(0, 12))
  }

  return (
    <div>
      {selected.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {selected.map((t) => (
            <button
              key={t}
              onClick={() => toggle(t)}
              title={nonOptionTickers?.has(t) ? 'CFD-only on this account - the auto-trader will skip it' : undefined}
              className={`rounded px-1.5 py-px font-mono text-[9px] ${
                nonOptionTickers?.has(t)
                  ? 'bg-amber-500/10 text-amber-300/80 line-through hover:bg-rose-500/20 hover:text-rose-300'
                  : 'bg-cyan-500/15 text-cyan-300 hover:bg-rose-500/20 hover:text-rose-300'
              }`}
            >
              {t} ×
            </button>
          ))}
        </div>
      )}
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search instruments…"
        className="h-7 border-[#1c2739] bg-[#0b111c] text-[11px] text-[#e2e8f0] placeholder:text-[#3d4c66]"
      />
      <div className="mt-1 flex max-h-24 flex-wrap gap-1 overflow-y-auto">
        {options.map((a) => {
          const locked = nonOptionTickers?.has(a.ticker) ?? false
          return (
            <button
              key={a.ticker}
              onClick={() => toggle(a.ticker)}
              title={locked ? 'CFD-only on this account - no binary/turbo options, the auto-trader skips it' : undefined}
              className={`rounded px-1.5 py-px font-mono text-[9px] transition-colors ${
                locked
                  ? 'cursor-not-allowed bg-[#0d1420] text-[#3d4c66]'
                  : selected.includes(a.ticker)
                    ? 'bg-cyan-500/25 text-cyan-200'
                    : 'bg-[#101828] text-[#7c8aa5] hover:bg-[#1c2739] hover:text-[#dbe4f0]'
              }`}
            >
              {a.ticker}
              {locked && <span className="ml-0.5 text-[7px] uppercase tracking-wider text-amber-400/60">cfd</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { v: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <Label className="mb-1 text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</Label>
      <div className="grid grid-cols-3 gap-0.5 rounded bg-[#101828] p-0.5">
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            className={`rounded py-1 text-[9px] font-bold uppercase tracking-wide transition-colors ${
              value === o.v ? 'bg-[#1c2739] text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function NumField({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div>
      <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">{label}</Label>
      <Input
        type="number"
        step={step}
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)}
        className="h-8 border-[#1c2739] bg-[#101828] text-right text-[12px] text-[#e2e8f0]"
      />
    </div>
  )
}

// ---------- auto-trader strip + config editor ----------

/** Fallback draft before the first /mode poll lands (mirrors kernel defaults). */
const DEFAULT_AUTOTRADER_UI: AutoTraderConfig = {
  enabled: true,
  signalSource: 'screener',
  tf: '1m',
  stake: 10,
  minScore: 60,
  minConfidence: 55,
  zEntry: 1.8,
  maxHalfLife: 60,
  requireValidation: false,
  minPUp: 0.58,
  minAdx: 22,
  direction: 'both',
  maxOpen: 3,
  cooldownSec: 180,
  paceSec: 45,
  dailyProfitTarget: 0,
  dailyLossLimit: 0,
  watchlist: [],
  marketScope: 'all',
  minPayoutPct: 70,
  volGate: 'off',
}

function AutoTraderStrip({
  at,
  mode,
  onConfigure,
  onRestart,
}: {
  at: OsModeStatus['autotrader']
  mode: OsModeStatus['mode']
  onConfigure: () => void
  onRestart: () => void
}) {
  const state =
    mode === 'auto' && at.config.enabled
      ? { label: 'ARMED · trading', cls: 'border-amber-500/50 bg-amber-500/10 text-amber-300', dot: 'animate-pulse bg-amber-400' }
      : mode === 'auto'
        ? { label: 'off', cls: 'border-[#1c2739] bg-[#101828] text-[#4b5a72]', dot: 'bg-[#2a3850]' }
        : { label: 'standby · human mode', cls: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300', dot: 'bg-cyan-500' }
  const closed = at.trades
  const wins = at.wins
  const wr = closed ? Math.round((wins / closed) * 100) : null
  return (
    <div className="shrink-0 rounded border border-[#1c2739] bg-[#0d1420] px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#7c8aa5]">auto-trader</span>
        <span className={`flex items-center gap-1.5 rounded border px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-wider ${state.cls}`}>
          <span className={`h-1 w-1 rounded-full ${state.dot}`} />
          {state.label}
        </span>
        <span className="font-mono text-[9px] text-[#4b5a72]">
          {at.config.signalSource === 'kalman-ou'
            ? `OU·|z|≥${at.config.zEntry}${at.config.requireValidation ? '·wf✓' : ''}`
            : at.config.signalSource === 'markov'
              ? `MARKOV·P(up)≥${(at.config.minPUp * 100).toFixed(0)}%`
              : at.config.signalSource === 'momentum'
                ? `MOM·ADX≥${at.config.minAdx}`
                : at.config.signalSource === 'confluence'
                  ? `CONFLUENCE·14F≥${at.config.minScore}`
                  : at.config.signalSource === 'strategy'
                    ? (() => {
                        const ids = at.config.strategyIds?.length ? at.config.strategyIds : at.config.strategyId ? [at.config.strategyId] : []
                        return ids.length === 0
                          ? 'STRAT·none picked'
                          : ids.length === 1
                            ? `STRAT·${ids[0]}`
                            : at.config.strategyPickMode === 'best'
                              ? `AUTO-LEARN·${ids.length}`
                              : `ENSEMBLE·${ids.length}≥${at.config.minConfidence}%`
                      })()
                    : `score ≥${at.config.minScore}`}
          {' · '}{at.config.tf} ·{' '}
          {at.config.stakePlan ? `compound seed $${at.config.stakePlan.base}` : `$${at.config.stake}`} · max {at.config.maxOpen}
          {at.config.marketScope === 'real' && <span className="text-emerald-400/80"> · REAL only</span>}
          {at.config.marketScope === 'otc' && <span className="text-violet-400/80"> · OTC only</span>}
          {(at.config.minPayoutPct ?? 0) > 0 && <span className="text-emerald-400/80"> · PAY≥{at.config.minPayoutPct}%</span>}
          {at.config.volGate === 'avoid-volatile' && <span className="text-amber-400/80"> · vol-gate</span>}
          {at.config.signalSource === 'strategy' && (() => {
            const ds = at.config.directionStrategy
            const pinCount = Object.keys(at.config.pairStrategy ?? {}).length
            const tags: string[] = []
            if (ds?.call && ds?.put) tags.push(`CALL→${ds.call}/PUT→${ds.put}`)
            else if (ds?.call) tags.push(`CALL→${ds.call}`)
            else if (ds?.put) tags.push(`PUT→${ds.put}`)
            if (pinCount) tags.push(`${pinCount} pair pin${pinCount > 1 ? 's' : ''}`)
            return tags.length ? <span className="text-cyan-400/70"> · {tags.join(' · ')}</span> : null
          })()}
        </span>
        <span className="ml-auto font-mono text-[9px] text-[#4b5a72]">
          {closed}t{wr !== null ? ` · ${wr}% wr` : ''} ·{' '}
          <span className={at.pnlToday >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
            {at.pnlToday >= 0 ? '+' : ''}
            {fmtMoney(at.pnlToday)} today
          </span>
          {at.openCount > 0 && <span className="text-[#aab6cc]"> · {at.openCount} open</span>}
        </span>
        <Button
          size="sm"
          onClick={onConfigure}
          className="h-5 rounded bg-[#1c2739] px-2 text-[9px] font-bold uppercase tracking-wider text-[#aab6cc] hover:bg-[#243352] hover:text-cyan-300"
        >
          Configure
        </Button>
      </div>
      {(at.lastAction || at.lastRejection) && (
        <p className="mt-0.5 truncate font-mono text-[8px] text-[#3d4c66]">
          {/* title carries the full line - the fresh-edge "why now" suffix
              makes it longer than the truncated strip row can show */}
          {at.lastAction && <span title={at.lastAction}>last: {at.lastAction}</span>}
          {at.lastRejection && <span className="text-amber-500/70"> · standing down: {at.lastRejection}</span>}
        </p>
      )}
      {/* edge-memory row: the already-true conditions this source is refusing
          to act on. The operator-facing half of "act on conditions that JUST
          became true" - what is held, since when, and why (armed into it vs
          consumed by an executed trade). */}
      {at.active && at.edges && <EdgeMemoryRow edges={at.edges} nowSec={Date.now() / 1000} />}
      {at.config.stakePlan && at.config.planState?.halted && (
        <div className="mt-1 flex items-center justify-between gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-1.5 py-1">
          <span className="font-mono text-[8px] text-amber-300">
            compound cycle {at.config.planState.complete ? 'COMPLETE' : 'ended on a loss'} - standing down until restarted
          </span>
          <Button
            size="sm"
            onClick={onRestart}
            className="h-5 shrink-0 rounded bg-amber-500/15 px-2 text-[9px] font-bold uppercase tracking-wider text-amber-300 hover:bg-amber-500/25"
          >
            Restart cycle
          </Button>
        </div>
      )}
    </div>
  )
}

/** The auto-trader's edge memory, operator-facing: the already-true
 * conditions this source is refusing to trade, since when, and whether the
 * hold came from arming into them (backfill) or from consuming them with an
 * executed trade. 'strategy' keeps no memory - its votes are phase-gated at
 * the eval itself (entered/flip only), so there is nothing to list. */
function EdgeMemoryRow({
  edges,
  nowSec,
}: {
  edges: NonNullable<OsModeStatus['autotrader']['edges']>
  nowSec: number
}) {
  const age = (since: number) => {
    const s = Math.max(0, Math.round(nowSec - since))
    if (s < 90) return `${s}s`
    const m = Math.round(s / 60)
    if (m < 90) return `${m}m`
    return `${Math.round(m / 60)}h`
  }
  if (edges.source === 'strategy') {
    return (
      <p className="mt-0.5 font-mono text-[8px] text-[#3d4c66]">
        <span className="font-bold uppercase tracking-wider text-[#4b5a72]">edges</span> · votes phase-gated at the eval
        (entered/flip only) · no hold memory
      </p>
    )
  }
  const rows = edges.source === 'screener' ? edges.screenerHeld : edges.held
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[8px]">
      <span className="font-bold uppercase tracking-wider text-[#4b5a72]">edges</span>
      {edges.cold ? (
        <span
          className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-amber-300"
          title="first sweep after arming hasn't run yet - it records what already qualifies and trades none of it"
        >
          backfilling · first sweep records, never trades
        </span>
      ) : rows.length === 0 ? (
        <span
          className="text-[#4b5a72]"
          title="nothing is held - the next condition to cross this source's gates can trade immediately"
        >
          no held edges · fresh qualifiers can trade
        </span>
      ) : (
        <>
          {rows.slice(0, 6).map((h) => (
            <span
              key={`${h.asset}:${h.dir}`}
              className={`rounded border px-1 py-px ${
                h.origin === 'executed'
                  ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300/90'
                  : 'border-[#1c2739] bg-[#101828] text-[#7c8aa5]'
              }`}
              title={
                h.origin === 'executed'
                  ? `${h.asset} ${h.dir}: a placed trade consumed this edge - held until the condition lapses (cooldown expiry cannot re-enter it)`
                  : `${h.asset} ${h.dir}: already qualifying when the trader armed - held until it lapses, then it trades as a fresh edge`
              }
            >
              {h.asset} {h.dir === 'call' ? '▲' : '▼'} {h.origin === 'executed' ? 'exec' : 'arm'} {age(h.since)}
            </span>
          ))}
          {rows.length > 6 && (
            <span
              className="text-[#4b5a72]"
              title={rows
                .slice(6)
                .map((h) => `${h.asset} ${h.dir} ${h.origin === 'executed' ? 'exec' : 'arm'} ${age(h.since)}`)
                .join(', ')}
            >
              +{rows.length - 6} more
            </span>
          )}
        </>
      )}
    </div>
  )
}

function AutoTraderDialog({
  open,
  onOpenChange,
  config,
  assets,
  strategies,
  onSave,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  config: AutoTraderConfig
  assets: AssetRow[]
  strategies: StrategyInfo[]
  onSave: (patch: Partial<AutoTraderConfig>) => Promise<void>
}) {
  const [d, setD] = useState<AutoTraderConfig>(config)
  const [busy, setBusy] = useState(false)
  const p = (patch: Partial<AutoTraderConfig>) => setD((prev) => ({ ...prev, ...patch }))
  // SINGLE vs POOL strategy selection. SINGLE = exactly one strategy runs
  // every non-pinned pair (picking one replaces the last - what the picker
  // always should have done; the old toggle-many picker silently turned a
  // second click into an ENSEMBLE vote). POOL = the multi-member ensemble /
  // auto-learn / auto-discover machinery. Derived once at open from the
  // saved config (the dialog remounts on open via key={String(atOpen)}).
  const savedPicks = config.strategyIds?.length ? config.strategyIds : config.strategyId ? [config.strategyId] : []
  const [selMode, setSelMode] = useState<'single' | 'pool'>(savedPicks.length > 1 || config.autoDiscover ? 'pool' : 'single')
  // Tickers the connected account can't trade as options (IQ payout metadata
  // reports no binary/turbo payout = margin CFD-only). Sim-mode rows always
  // carry a payout, so this stays empty on paper accounts.
  const nonOptionTickers = useMemo(() => new Set(assets.filter((a) => a.payout === null).map((a) => a.ticker)), [assets])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto border-[#1c2739] bg-[#0b111c] text-[#dbe4f0]">
        <DialogHeader>
          <DialogTitle className="text-[14px] tracking-wider">AUTO-TRADER</DialogTitle>
          <DialogDescription className="text-[11px] text-[#7c8aa5]">
            The OS acting as its own trader: takes the strongest signal as 1-bar binary options - composite screener,
            Kalman/OU mean reversion, Markov regime forecast, ADX momentum, the full 14-factor Confluence Signal
            engine, or one specific strategy picked from the Strategy Lab / AI Lab catalog. Only ever trades while the
            OS is in NO-HUMAN mode. Sentinel + risk limits still govern every order.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2.5">
          <div className="col-span-2 flex items-center justify-between rounded border border-[#1c2739] bg-[#101828] px-2.5 py-2">
            <div>
              <div className="text-[11px] font-semibold text-[#e2e8f0]">Enabled</div>
              <div className="text-[9px] text-[#4b5a72]">armed for the next NO-HUMAN session</div>
            </div>
            <Switch checked={d.enabled} onCheckedChange={(v) => p({ enabled: v })} />
          </div>

          {/* ---------- MARKET ---------- */}
          <div className="col-span-2 mt-1 flex items-center gap-2">
            <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-400/80">Market</span>
            <span className="h-px flex-1 bg-[#1c2739]" />
          </div>
          <Segmented
            label="Feed family"
            options={[
              { v: 'all', label: 'All' },
              { v: 'real', label: 'Real only' },
              { v: 'otc', label: 'OTC only' },
            ]}
            value={d.marketScope ?? 'all'}
            onChange={(v) => p({ marketScope: v as AutoTraderConfig['marketScope'] })}
          />
          <div className="self-end text-[8px] leading-relaxed text-[#3d4c66]">
            {d.marketScope === 'real'
              ? 'REAL exchange-traded feeds only - every -OTC ticker is skipped. Signals, validations and pins earned on real charts stay on real charts.'
              : d.marketScope === 'otc'
                ? 'Broker-generated -OTC feeds only - no real pair can fire. The OTC placebo defense still applies on top.'
                : 'No separation: real and -OTC pairs both trade. Split them if a config built for one family should never fire on the other.'}
          </div>
          <p className="col-span-2 rounded border border-[#1c2739] bg-[#0b1220] px-2 py-1.5 text-[8px] leading-relaxed text-[#3d4c66]">
            Binary options only, always: the auto-trader fires 1-bar binary trades, so instruments the connected
            account can&apos;t take options on (margin CFDs - most stocks/indices) are skipped before any evaluation -
            no more &quot;not a turbo/binary/digital instrument&quot; rejection spam. {nonOptionTickers.size > 0 && `${nonOptionTickers.size} instrument(s) on this account are CFD-only.`}
          </p>

          {/* ---------- SIGNAL ---------- */}
          <div className="col-span-2 mt-1 flex items-center gap-2">
            <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-400/80">Signal</span>
            <span className="h-px flex-1 bg-[#1c2739]" />
          </div>
          <div className="col-span-2">
            <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Signal source</Label>
            <div className="flex overflow-hidden rounded border border-[#1c2739]">
              {(
                [
                  ['screener', 'Screener'],
                  ['kalman-ou', 'Kalman-OU'],
                  ['markov', 'Markov'],
                  ['momentum', 'Momentum'],
                  ['confluence', 'Confluence'],
                  ['strategy', 'Strategy'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => p({ signalSource: v })}
                  className={`flex-1 px-1.5 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                    d.signalSource === v ? 'bg-cyan-500/20 text-cyan-300' : 'text-[#4b5a72] hover:text-[#aab6cc]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[8px] leading-relaxed text-[#3d4c66]">
              {d.signalSource === 'kalman-ou'
                ? 'sweeps the universe with the Ornstein-Uhlenbeck + Kalman fit and fades statistically stretched pairs: CALL when price sits |z|σ below the equilibrium, PUT above - only when reversion is significant and the half-life is tradeable'
                : d.signalSource === 'markov'
                  ? 'follows the Markov chain state forecast: CALL when P(next move up) clears the threshold, PUT below its mirror - skipped entirely in chop regimes where the transition matrix degenerates'
                  : d.signalSource === 'momentum'
                    ? 'trend continuation: CALL when ADX-confirmed strength, a positive rate-of-change and RSI on the bullish side of mid line up, PUT mirrored - skips statistically exhausted extremes'
                    : d.signalSource === 'confluence'
                      ? 'the EXACT 14-factor Confluence Signal panel/confluence_read engine, re-fit bar-fresh on each candidate (full Kalman/OU, not the screener sweep\'s cheaper approximation) - identical read to what the panel/copilot would show for that pair right now'
                      : d.signalSource === 'strategy'
                        ? 'one specific strategy picked below, or several combined - as a vote (ENSEMBLE) or an AUTO-LEARN pool that trades whichever member is proven best per pair - the same strategyId an autopilot bot would use (a builtin strategy, or an AI Lab-learned "(Lab)" spec), not pinned to one bot\'s watchlist'
                        : 'takes the strongest full-composite screener signals market-wide (trend + momentum + statistical + patterns)'}
            </p>
          </div>

          {/* source-specific thresholds live with the source that uses them */}
          {d.signalSource === 'kalman-ou' && (
            <>
              <NumField label="OU entry |z| (σ)" value={d.zEntry} onChange={(v) => p({ zEntry: v })} step={0.1} />
              <NumField label="Max half-life (bars)" value={d.maxHalfLife} onChange={(v) => p({ maxHalfLife: v })} />
              <div className="col-span-2 flex items-center justify-between rounded border border-[#1c2739] bg-[#101828] px-2.5 py-1.5">
                <div>
                  <div className="text-[10px] font-semibold text-[#e2e8f0]">Require walk-forward validation</div>
                  <div className="text-[8px] leading-snug text-[#4b5a72]">
                    only trade pairs whose OU edge survives out-of-sample (OOS net +, most folds profitable, ≥25% efficiency) - verdicts cached 1h
                  </div>
                </div>
                <Switch checked={d.requireValidation} onCheckedChange={(v) => p({ requireValidation: v })} />
              </div>
            </>
          )}
          {d.signalSource === 'markov' && <NumField label="Min P(up) threshold" value={d.minPUp} onChange={(v) => p({ minPUp: v })} step={0.01} />}
          {d.signalSource === 'momentum' && <NumField label="Min ADX (trend strength)" value={d.minAdx} onChange={(v) => p({ minAdx: v })} />}
          {d.signalSource !== 'strategy' && <NumField label="Min confidence" value={d.minConfidence} onChange={(v) => p({ minConfidence: v })} />}
          {d.signalSource !== 'strategy' && <NumField label="Min |score|" value={d.minScore} onChange={(v) => p({ minScore: v })} />}

          {d.signalSource === 'strategy' && (() => {
            const picked = d.strategyIds?.length ? d.strategyIds : d.strategyId ? [d.strategyId] : []
            const isPool = picked.length > 1
            const pickMode = d.strategyPickMode ?? 'ensemble'
            const only = picked.length === 1 ? strategies.find((s) => s.id === picked[0]) : undefined
            return (
              <div className="col-span-2">
                <Segmented
                  label="Selection mode"
                  options={[
                    { v: 'single', label: 'Single strategy' },
                    { v: 'pool', label: 'Pool (combine)' },
                  ]}
                  value={selMode}
                  onChange={(v) => {
                    if (v === 'single') {
                      // ONE strategy: truncate any pool to the first pick and
                      // kill auto-discover (it is a pool concept - it would
                      // silently re-widen a "single" pick to the full catalog)
                      setSelMode('single')
                      p({ strategyIds: picked.slice(0, 1), strategyId: picked[0], autoDiscover: false })
                    } else {
                      setSelMode('pool')
                    }
                  }}
                />
                <div className="mt-1.5">
                  <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">
                    {selMode === 'single'
                      ? 'Strategy - picking one deselects the last'
                      : `Strategy pool${picked.length ? ` (${picked.length} picked)` : ' - search to add, pick 2+ to combine'}`}
                  </Label>
                  <StrategyPicker
                    strategies={strategies}
                    selected={picked}
                    singleSelect={selMode === 'single'}
                    onChange={(ids) => p({ strategyIds: ids, strategyId: ids[0] })}
                  />
                </div>
                {picked.length === 0 && !d.autoDiscover && (
                  <p className="mt-1 text-[8px] leading-relaxed text-[#3d4c66]">
                    {selMode === 'single'
                      ? 'no strategy picked yet - the auto-trader stands aside until you pick one (pair/direction pins below can still trade on their own).'
                      : 'nothing picked yet - the auto-trader stands aside until at least one strategy is selected, or turn on auto-discover below to let it find its own.'}
                  </p>
                )}
                {selMode === 'single' && picked.length === 1 && (
                  <p className="mt-1 text-[8px] leading-relaxed text-[#3d4c66]">
                    SINGLE: &quot;{strategies.find((s) => s.id === picked[0])?.name ?? picked[0]}&quot; runs every pair the pins below
                    don&apos;t claim. Switch to Pool to combine several strategies instead.
                  </p>
                )}
                {selMode === 'pool' && (
                <div className="mt-2 flex items-center justify-between gap-2 rounded border border-[#1c2739] bg-[#0b1220] p-2">
                  <div>
                    <p className="text-[10px] text-[#c7d2e3]">Auto-discover (full catalog + AI Lab mining)</p>
                    <p className="text-[8px] leading-relaxed text-[#3d4c66]">
                      ranks the ENTIRE builtin strategy catalog and every AI Lab spec per pair, and periodically mines a new AI
                      Lab spec for pairs that do not have one yet - no manual picks needed, though any picked above are
                      included too. Heavier: evaluates the full catalog every tick.
                    </p>
                  </div>
                  <Switch
                    checked={d.autoDiscover ?? false}
                    onCheckedChange={(v) => p(v ? { autoDiscover: true, strategyPickMode: 'best' } : { autoDiscover: false })}
                  />
                </div>
                )}
                <PairStrategyPicker
                  assets={assets}
                  strategies={strategies}
                  value={d.pairStrategy}
                  onChange={(next) => p({ pairStrategy: next })}
                  watchlist={d.watchlist}
                  watchlistMode={d.watchlistMode ?? 'only'}
                  nonOptionTickers={nonOptionTickers}
                />
                <DirectionStrategyPicker strategies={strategies} value={d.directionStrategy} onChange={(next) => p({ directionStrategy: next })} />
                {only && (
                  <p className="mt-1 text-[8px] leading-relaxed text-[#3d4c66]">
                    {only.description || `trades "${only.name}" on every open pair (respecting the watchlist below, if set)`}
                  </p>
                )}
                {isPool && (
                  <>
                    <Segmented
                      label="Combine as"
                      options={[
                        { v: 'ensemble', label: 'Ensemble (vote)' },
                        { v: 'best', label: 'Auto-learn (best per pair)' },
                      ]}
                      value={pickMode}
                      onChange={(v) => p({ strategyPickMode: v as 'ensemble' | 'best' })}
                    />
                    {pickMode === 'best' ? (
                      <p className="col-span-2 mt-1 text-[8px] leading-relaxed text-[#3d4c66]">
                        auto-learn: on every pair, each of the {picked.length} picked strategies fires independently and the
                        auto-trader reads ITS OWN settled-trade record for that exact pair (the same proven-record math the
                        adaptive gate already uses) - whichever member has the strongest proven win rate there gets traded,
                        so over time a pair naturally ends up run by whichever of your picks actually works on it. A member
                        with no record yet on a pair falls back to its raw signal score, so every member keeps getting a
                        turn until it has something to learn from. Every trade is tagged with the specific member that
                        fired, never a combined label, so each one builds its own clean per-pair record.
                      </p>
                    ) : (
                      <p className="col-span-2 mt-1 text-[8px] leading-relaxed text-[#3d4c66]">
                        every member strategy votes CALL/PUT/none on each pair; the majority direction wins (a tie skips the pair) -
                        trades only when {d.minConfidence}% or more of the {picked.length} members agree.
                      </p>
                    )}
                    {pickMode === 'ensemble' && (
                      <NumField
                        label="Min agreement % (ensemble)"
                        value={d.minConfidence}
                        onChange={(v) => p({ minConfidence: Math.min(100, Math.max(1, v)) })}
                      />
                    )}
                  </>
                )}
                {picked
                  .map((id) => strategies.find((s) => s.id === id))
                  .filter((s): s is StrategyInfo => Boolean(s) && s!.params.length > 0)
                  .map((s) => (
                    <div key={s.id} className="col-span-2 rounded border border-[#1c2739] bg-[#101828] p-2">
                      <div className="mb-1.5 text-[9px] uppercase tracking-wider text-[#4b5a72]">{s.name} parameters</div>
                      <div className="grid grid-cols-2 gap-2">
                        {s.params.map((prm) => (
                          <div key={prm.key}>
                            <div className="mb-0.5 truncate text-[9px] text-[#4b5a72]">{prm.label}</div>
                            {prm.type === 'select' ? (
                              <select
                                value={String(d.strategyParams?.[s.id]?.[prm.key] ?? prm.default)}
                                onChange={(e) => {
                                  const next = { ...(d.strategyParams ?? {}) }
                                  next[s.id] = { ...(next[s.id] ?? {}), [prm.key]: e.target.value }
                                  p({ strategyParams: next })
                                }}
                                className="h-7 w-full rounded border border-[#1c2739] bg-[#0b111c] px-1.5 text-[11px] text-[#e2e8f0] outline-none"
                              >
                                {(prm.options ?? []).map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                            ) : prm.type === 'text' ? (
                              <Input
                                value={String(d.strategyParams?.[s.id]?.[prm.key] ?? prm.default)}
                                onChange={(e) => {
                                  const next = { ...(d.strategyParams ?? {}) }
                                  const forId = { ...(next[s.id] ?? {}) }
                                  if (e.target.value.trim() === '') delete forId[prm.key]
                                  else forId[prm.key] = e.target.value
                                  next[s.id] = forId
                                  p({ strategyParams: next })
                                }}
                                placeholder={String(prm.default)}
                                className="h-7 border-[#1c2739] bg-[#0b111c] text-[11px] text-[#e2e8f0]"
                              />
                            ) : (
                              <Input
                                value={String(d.strategyParams?.[s.id]?.[prm.key] ?? prm.default)}
                                onChange={(e) => {
                                  const raw = e.target.value.replace(/[^0-9.\-]/g, '')
                                  const next = { ...(d.strategyParams ?? {}) }
                                  const forId = { ...(next[s.id] ?? {}) }
                                  if (raw === '') delete forId[prm.key]
                                  else forId[prm.key] = Number(raw)
                                  next[s.id] = forId
                                  p({ strategyParams: next })
                                }}
                                className="h-7 border-[#1c2739] bg-[#0b111c] text-[11px] text-[#e2e8f0]"
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            )
          })()}

          {/* ---------- PAIRS ---------- */}
          <div className="col-span-2 mt-1 flex items-center gap-2">
            <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-400/80">Pairs</span>
            <span className="h-px flex-1 bg-[#1c2739]" />
          </div>
          <div className="col-span-2">
            <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">
              Pair restriction {d.watchlist.length > 0 ? `(${d.watchlist.length} selected)` : '(GLOBAL - every open instrument)'}
            </Label>
            <WatchlistPicker assets={assets} selected={d.watchlist} onChange={(w) => p({ watchlist: w })} nonOptionTickers={nonOptionTickers} />
            {d.watchlist.some((t) => nonOptionTickers.has(t)) && (
              <p className="mt-1 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[8px] leading-snug text-amber-300/80">
                ⚠ {d.watchlist.filter((t) => nonOptionTickers.has(t)).length} selected pair(s) are CFD-only on this
                account - they stay listed (struck through) but the auto-trader will never trade them.
              </p>
            )}
            {d.watchlist.length > 0 && (
              <Segmented
                label="Apply as"
                options={[
                  { v: 'only', label: 'Only trade these' },
                  { v: 'exclude', label: 'Never trade these' },
                ]}
                value={d.watchlistMode ?? 'only'}
                onChange={(v) => p({ watchlistMode: v as 'only' | 'exclude' })}
              />
            )}
            <p className="mt-1 text-[8px] leading-relaxed text-[#3d4c66]">
              {d.watchlist.length > 0
                ? (d.watchlistMode ?? 'only') === 'exclude'
                  ? `BLOCKED from these ${d.watchlist.length} pair(s) - every other currently-open instrument stays in play for the chosen signal source. Clear the selection to go back to global.`
                  : `restricted to ONLY these ${d.watchlist.length} pair(s), regardless of signal source. If you meant to keep the auto-trader away from a pair rather than confine it to one, switch "Apply as" to "Never trade these" above. Clear the selection to go back to global.`
                : 'no pairs selected = global: scans every currently-open instrument for the chosen signal source, same as always. Select pairs above, then choose whether they\'re the ONLY pairs traded or the ones NEVER traded.'}
            </p>
          </div>

          {/* ---------- EXECUTION ---------- */}
          <div className="col-span-2 mt-1 flex items-center gap-2">
            <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-400/80">Execution</span>
            <span className="h-px flex-1 bg-[#1c2739]" />
          </div>
          <div>
            <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Signal timeframe</Label>
            <select
              value={d.tf}
              onChange={(e) => p({ tf: e.target.value as Timeframe })}
              className="h-8 w-full rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-cyan-300 outline-none"
            >
              {TIMEFRAMES.map((t) => (
                <option key={t} value={t} className="bg-[#0d1420]">
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Expiry</Label>
            <select
              value={d.expiryTf ?? ''}
              onChange={(e) =>
                // "Track signal timeframe" writes a CONCRETE value (the
                // current tf) rather than undefined/null - a bare undefined
                // field is dropped entirely by JSON.stringify when this
                // draft gets POSTed, so it would silently fail to clear a
                // previously-set expiry on save (the same bug pairStrategy
                // had earlier - fixed there by never emitting null/undefined
                // either). Setting it equal to tf is exactly equivalent
                // (1 tf-bar expiry), just always a value that survives.
                p({ expiryTf: e.target.value ? (e.target.value as Timeframe) : d.tf })
              }
              className="h-8 w-full rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-cyan-300 outline-none"
            >
              <option value="" className="bg-[#0d1420]">
                Track signal timeframe ({d.tf})
              </option>
              {TIMEFRAMES.map((t) => (
                <option key={t} value={t} className="bg-[#0d1420]">
                  {t}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[8px] leading-relaxed text-[#3d4c66]">
              How long each trade actually runs before it settles - separate from the signal timeframe above. Leave as "Track signal timeframe" for the
              original 1-bar-of-tf behavior.
            </p>
          </div>
          <div>
            <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Direction</Label>
            <select
              value={d.direction}
              onChange={(e) => p({ direction: e.target.value as AutoTraderConfig['direction'] })}
              className="h-8 w-full rounded border border-[#1c2739] bg-[#101828] px-2 font-mono text-[11px] text-cyan-300 outline-none"
            >
              {['both', 'call', 'put'].map((v) => (
                <option key={v} value={v} className="bg-[#0d1420]">
                  {v}
                </option>
              ))}
            </select>
          </div>

          <div className="col-span-2 rounded border border-[#1c2739] bg-[#0b1220] px-2 py-2">
            <NumField
              label="Min payout % - the EV gate (0 = off)"
              value={d.minPayoutPct ?? 70}
              onChange={(v) => p({ minPayoutPct: Math.min(98, Math.max(0, v)) })}
            />
            <p className="mt-1 text-[8px] leading-relaxed text-[#3d4c66]">
              Never fires when the pair&apos;s LIVE payout is below this floor. Breakeven = 100/(1+payout): 54.9% at
              82%, 58.8% at 70%, 60.6% at 65% - and payouts move per pair per hour, so a signal worth taking at one
              payout can be pure house-edge at a lower one. Rejected pairs sit out 10 minutes and the trader moves to
              the next candidate; unknown payouts (metadata cold / sim) still trade. Kernel default: 70.
            </p>
          </div>

          {d.stakePlan?.kind === 'compound' ? (
            <div>
              <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Stake $ (replaced by compound plan)</Label>
              <Input value={`$${d.stake}`} disabled className="h-8 border-[#1c2739] bg-[#0b1220] text-right text-[12px] text-[#4b5a72]" />
            </div>
          ) : (
            <NumField label="Stake $" value={d.stake} onChange={(v) => p({ stake: v })} />
          )}

          <Segmented
            label="Stake plan"
            options={[
              { v: 'fixed', label: 'Fixed' },
              { v: 'compound', label: 'Compound' },
            ]}
            value={d.stakePlan?.kind === 'compound' ? 'compound' : 'fixed'}
            onChange={(v) =>
              p({
                stakePlan: v === 'compound' ? { kind: 'compound', base: Math.max(1, d.stake), rollPct: 100, payoutCap: 70, stopOnLoss: true } : undefined,
              })
            }
          />
          {d.stakePlan?.kind === 'compound' && (
            <>
              <p className="col-span-2 -mt-1 text-[9px] leading-relaxed text-[#4b5a72]">
                Same compounding math as a bot&apos;s stake plan - one roll, shared across the whole auto-trader (it only
                ever holds one position at a time via Max open positions, so there is no cross-asset pot conflict).
              </p>
              <NumField
                label="Seed stake $ (each restart)"
                value={d.stakePlan.base}
                onChange={(v) => p({ stakePlan: { ...d.stakePlan!, base: Math.max(1, v) } })}
              />
              <NumField
                label="Roll % of pot (100 = all-in)"
                value={d.stakePlan.rollPct ?? 100}
                onChange={(v) => p({ stakePlan: { ...d.stakePlan!, rollPct: Math.min(100, Math.max(1, v)) } })}
              />
              <NumField
                label="Max stake cap $ (0 = none)"
                value={d.stakePlan.maxStake ?? 0}
                onChange={(v) => p({ stakePlan: { ...d.stakePlan!, maxStake: v > 0 ? v : undefined } })}
              />
              <NumField
                label="Payout cap % (max 70)"
                value={d.stakePlan.payoutCap ?? 70}
                onChange={(v) => p({ stakePlan: { ...d.stakePlan!, payoutCap: Math.min(70, Math.max(1, v)) } })}
              />
              <NumField
                label="Periods (0 = compound until loss)"
                value={d.stakePlan.periods ?? 0}
                onChange={(v) =>
                  p({
                    stakePlan: { ...d.stakePlan!, periods: v > 0 ? Math.round(v) : undefined, ...(v > 0 ? {} : { onComplete: undefined }) },
                  })
                }
              />
              <NumField
                label="De-risk after roll # (0 = never)"
                value={d.stakePlan.deriskAfter ?? 0}
                onChange={(v) =>
                  p({
                    stakePlan: { ...d.stakePlan!, deriskAfter: v > 0 ? Math.round(v) : undefined, deriskPct: v > 0 ? (d.stakePlan?.deriskPct ?? 50) : undefined },
                  })
                }
              />
              {(d.stakePlan.deriskAfter ?? 0) > 0 && (
                <NumField
                  label="De-risk stake % of pot"
                  value={d.stakePlan.deriskPct ?? 50}
                  onChange={(v) => p({ stakePlan: { ...d.stakePlan!, deriskPct: Math.min(100, Math.max(1, v)) } })}
                />
              )}
              {(d.stakePlan.periods ?? 0) > 0 && (
                <Segmented
                  label="On complete"
                  options={[
                    { v: 'halt', label: 'Stand down' },
                    { v: 'reseed', label: 'Re-seed' },
                  ]}
                  value={d.stakePlan.onComplete === 'reseed' ? 'reseed' : 'halt'}
                  onChange={(v) => p({ stakePlan: { ...d.stakePlan!, onComplete: v as 'halt' | 'reseed' } })}
                />
              )}
              <Segmented
                label="On loss"
                options={[
                  { v: 'end', label: 'End cycle' },
                  { v: 'roll', label: 'Re-seed' },
                ]}
                value={d.stakePlan.stopOnLoss === false ? 'roll' : 'end'}
                onChange={(v) => p({ stakePlan: { ...d.stakePlan!, stopOnLoss: v !== 'roll' } })}
              />
            </>
          )}

          {/* ---------- PROTECTION ---------- */}
          <div className="col-span-2 mt-1 flex items-center gap-2">
            <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-400/80">Protection</span>
            <span className="h-px flex-1 bg-[#1c2739]" />
          </div>
          {(d.signalSource === 'screener' || d.signalSource === 'strategy') && (
            <div>
              <NumField
                label="Pick variety (top-N, random)"
                value={d.pickVariety ?? 1}
                onChange={(v) => p({ pickVariety: Math.round(Math.max(1, Math.min(10, v))) })}
              />
              <p className="mt-1 text-[8px] leading-relaxed text-[#3d4c66]">
                1 (default) always takes the single highest-ranked qualifying pair every tick. Raise this to randomly
                pick among the top N qualifying pairs instead - spreads trades across the pool instead of one pair
                (whose score barely moves between 10s ticks) winning almost every slot.
              </p>
            </div>
          )}
          <div className="col-span-2 rounded border border-[#1c2739] bg-[#0b1220] p-2">
            <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Smarts</Label>
            <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] text-[#c7d2e3]">Confidence-weighted stake</p>
                  <p className="text-[8px] leading-relaxed text-[#3d4c66]">size up on strong signals, down on weak ones (0.5x-1.5x) instead of a flat stake</p>
                </div>
                <Switch checked={d.smartStaking ?? false} onCheckedChange={(v) => p({ smartStaking: v })} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] text-[#c7d2e3]">Correlation guard</p>
                  <p className="text-[8px] leading-relaxed text-[#3d4c66]">won&apos;t open a 2nd position in a pair correlated with one already open</p>
                </div>
                <Switch checked={d.correlationGuard ?? true} onCheckedChange={(v) => p({ correlationGuard: v })} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] text-[#c7d2e3]">Streak-breaker</p>
                  <p className="text-[8px] leading-relaxed text-[#3d4c66]">benches a strategy on a pair after 3+ losses in a row, cooldown grows with the streak</p>
                </div>
                <Switch checked={d.streakBreaker ?? true} onCheckedChange={(v) => p({ streakBreaker: v })} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] text-[#c7d2e3]">Avoid dead hours</p>
                  <p className="text-[8px] leading-relaxed text-[#3d4c66]">stands aside on non-OTC pairs 21:00-23:00 UTC, the thinnest FX liquidity window</p>
                </div>
                <Switch checked={d.avoidDeadHours ?? false} onCheckedChange={(v) => p({ avoidDeadHours: v })} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] text-[#c7d2e3]">Vol-spike gate</p>
                  <p className="text-[8px] leading-relaxed text-[#3d4c66]">no entries while the regime classifier reads VOLATILE (garch &gt; 1.6x ewma) for that pair</p>
                </div>
                <Switch
                  checked={d.volGate === 'avoid-volatile'}
                  onCheckedChange={(v) => p({ volGate: v ? 'avoid-volatile' : 'off' })}
                />
              </div>
            </div>
          </div>
          <NumField label="Max open" value={d.maxOpen} onChange={(v) => p({ maxOpen: v })} />
          <div>
            <NumField
              label="Per-asset cooldown s (1hr floor - never shorter)"
              value={d.cooldownSec}
              onChange={(v) => p({ cooldownSec: v })}
            />
            <p className="mt-1 text-[8px] leading-relaxed text-[#3d4c66]">
              every pair the auto-trader just traded sits out at least 1 hour (3600s) before it can be traded again,
              no matter how low this is set - raise it above 3600 for a longer rest, it just can&apos;t go shorter.
            </p>
          </div>
          <NumField label="Pace s (between trades)" value={d.paceSec} onChange={(v) => p({ paceSec: v })} />
          <NumField label="Daily profit target $ (0 off)" value={d.dailyProfitTarget} onChange={(v) => p({ dailyProfitTarget: v })} />
          <NumField label="Daily loss limit $ (0 off)" value={d.dailyLossLimit} onChange={(v) => p({ dailyLossLimit: v })} />
        </div>

        <DialogFooter className="mt-1 gap-2">
          <Button variant="outline" className="h-8 border-[#1c2739] px-3 text-[11px] text-[#7c8aa5]" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onSave(d)
                onOpenChange(false)
              } finally {
                setBusy(false)
              }
            }}
            className="h-8 bg-cyan-600 px-3 text-[11px] font-bold text-white hover:bg-cyan-500"
          >
            {busy ? 'Saving…' : 'Save config'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
