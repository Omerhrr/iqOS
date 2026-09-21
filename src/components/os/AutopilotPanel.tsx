'use client'

// IQAIR//OS - Autopilot: fleet manager for autonomous strategy bots.
// Bots evaluate a registered strategy on every closed candle of their
// watchlist and execute through the broker; the global risk manager
// (kill switch, daily loss, max stake) always outranks them.

import { useMemo, useState } from 'react'
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
import type { AssetRow, AutoTraderConfig, BotConfig, BotRow, OsModeStatus, StrategyInfo, Timeframe, TradeKind } from '@/lib/os/client'
import { KIND_LABEL, TIMEFRAMES, fmtMoney, fmtTime, osPost } from '@/lib/os/client'

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
    setEditorOpen(true)
  }

  const openEdit = (row: BotRow) => {
    setDraft({ ...row.bot })
    setEditorOpen(true)
  }

  const save = async () => {
    setBusy(true)
    try {
      const res = await osPost<{ ok: boolean; error?: string }>('/bot_save', { ...draft })
      if (res.ok) {
        setEditorOpen(false)
        onChanged()
      } else onError(res.error ?? 'bot rejected')
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (row: BotRow) => {
    try {
      await osPost('/bot_toggle', { id: row.bot.id, enabled: !row.bot.enabled })
      onChanged()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const remove = async (row: BotRow) => {
    try {
      await osPost('/bot_delete', { id: row.bot.id })
      onChanged()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const draftStrategy = strategies.find((s) => s.id === draft.strategyId)
  const patch = (p: Partial<BotConfig>) => setDraft((d) => ({ ...d, ...p }))

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
      {modeStatus && <AutoTraderStrip at={modeStatus.autotrader} mode={mode} onConfigure={() => setAtOpen(true)} />}

      {/* auto-trader config editor (remounts on open so the draft mirrors the kernel) */}
      <AutoTraderDialog
        key={String(atOpen)}
        open={atOpen}
        onOpenChange={setAtOpen}
        config={modeStatus?.autotrader.config ?? DEFAULT_AUTOTRADER_UI}
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
        <Button
          size="sm"
          onClick={openNew}
          className="h-6 rounded bg-cyan-500/15 px-2.5 text-[10px] font-bold uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/25"
        >
          + New Bot
        </Button>
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
          <BotCard key={row.bot.id} row={row} onToggle={() => toggle(row)} onEdit={() => openEdit(row)} onDelete={() => remove(row)} />
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
                Watchlist ({draft.watchlist.length}/12)
              </Label>
              <WatchlistPicker assets={assets} selected={draft.watchlist} onChange={(w) => patch({ watchlist: w })} />
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
                patch({
                  stakePlan:
                    v === 'compound'
                      ? {
                          kind: 'compound',
                          base: draft.stakePlan?.base ?? 1,
                          rollPct: draft.stakePlan?.rollPct ?? 100,
                          maxStake: draft.stakePlan?.maxStake,
                        }
                      : undefined,
                })
              }
            />

            {draft.stakePlan?.kind === 'compound' && (
              <>
                <NumField
                  label="Seed stake $ (each restart)"
                  value={draft.stakePlan.base}
                  onChange={(v) => patch({ stakePlan: { kind: 'compound', base: Math.max(1, v), rollPct: draft.stakePlan?.rollPct, maxStake: draft.stakePlan?.maxStake } })}
                />
                <NumField
                  label="Roll % of pot (100 = all-in)"
                  value={draft.stakePlan.rollPct ?? 100}
                  onChange={(v) => patch({ stakePlan: { kind: 'compound', base: draft.stakePlan?.base ?? 1, rollPct: Math.min(100, Math.max(1, v)), maxStake: draft.stakePlan?.maxStake } })}
                />
                <NumField
                  label="Max stake cap $ (0 = none)"
                  value={draft.stakePlan.maxStake ?? 0}
                  onChange={(v) => patch({ stakePlan: { kind: 'compound', base: draft.stakePlan?.base ?? 1, rollPct: draft.stakePlan?.rollPct, maxStake: v > 0 ? v : undefined } })}
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
              ]}
              value={draft.regime}
              onChange={(v) => patch({ regime: v as BotConfig['regime'] })}
            />

            <NumField label="Max open positions" value={draft.maxOpen} onChange={(v) => patch({ maxOpen: v })} />
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
              <NumField label="Expiry (bars)" value={draft.expiryBars} onChange={(v) => patch({ expiryBars: v })} />
            ) : null}

            {draftStrategy && draftStrategy.params.length > 0 && (
              <div className="col-span-2 rounded border border-[#1c2739] bg-[#101828] p-2">
                <div className="mb-1.5 text-[9px] uppercase tracking-wider text-[#4b5a72]">
                  {draftStrategy.name} parameters
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {draftStrategy.params.map((p) => (
                    <div key={p.key}>
                      <div className="mb-0.5 truncate text-[9px] text-[#4b5a72]">{p.label}</div>
                      <Input
                        value={String(draft.params?.[p.key] ?? p.default)}
                        onChange={(e) => {
                          const raw = e.target.value.replace(/[^0-9.\-]/g, '')
                          const next = { ...(draft.params ?? {}) }
                          if (raw === '' ) delete next[p.key]
                          else next[p.key] = Number(raw)
                          patch({ params: next })
                        }}
                        className="h-7 border-[#1c2739] bg-[#0b111c] text-[11px] text-[#e2e8f0]"
                      />
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

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setEditorOpen(false)}
              className="h-8 rounded text-[11px] text-[#7c8aa5] hover:bg-[#101828] hover:text-[#dbe4f0]"
            >
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={busy || !draft.watchlist.length}
              className="h-8 rounded bg-cyan-500/20 text-[11px] font-bold uppercase tracking-wider text-cyan-200 hover:bg-cyan-500/30"
            >
              {busy ? 'Saving…' : draft.id ? 'Save bot' : 'Deploy bot'}
            </Button>
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
  onToggle,
  onEdit,
  onDelete,
}: {
  row: BotRow
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { bot, stats } = row
  const winRate = stats.trades ? stats.wins / stats.trades : null
  return (
    <div
      className={`rounded-md border p-2 transition-colors ${
        bot.enabled ? 'border-emerald-500/30 bg-[#0d151f]' : 'border-[#1c2739] bg-[#0d121d]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${bot.enabled ? 'animate-pulse bg-emerald-400' : 'bg-[#2a3850]'}`} />
          <span className="truncate text-[12px] font-bold text-[#e2e8f0]">{bot.name}</span>
          {stats.openCount > 0 && (
            <span className="shrink-0 rounded bg-amber-500/15 px-1 py-px text-[8px] font-bold uppercase text-amber-300">
              {stats.openCount} open
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
          </span>
        ) : (
          <span className="rounded bg-[#101828] px-1 py-px">${bot.stake}</span>
        )}
        {bot.direction !== 'both' && <span className="rounded bg-[#101828] px-1 py-px">{bot.direction} only</span>}
        {bot.regime !== 'all' && <span className="rounded bg-[#101828] px-1 py-px">{bot.regime} regime</span>}
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
    </div>
  )
}

function WatchlistPicker({
  assets,
  selected,
  onChange,
}: {
  assets: AssetRow[]
  selected: string[]
  onChange: (w: string[]) => void
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
              className="rounded bg-cyan-500/15 px-1.5 py-px font-mono text-[9px] text-cyan-300 hover:bg-rose-500/20 hover:text-rose-300"
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
        {options.map((a) => (
          <button
            key={a.ticker}
            onClick={() => toggle(a.ticker)}
            className={`rounded px-1.5 py-px font-mono text-[9px] transition-colors ${
              selected.includes(a.ticker)
                ? 'bg-cyan-500/25 text-cyan-200'
                : 'bg-[#101828] text-[#7c8aa5] hover:bg-[#1c2739] hover:text-[#dbe4f0]'
            }`}
          >
            {a.ticker}
          </button>
        ))}
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
}

function AutoTraderStrip({
  at,
  mode,
  onConfigure,
}: {
  at: OsModeStatus['autotrader']
  mode: OsModeStatus['mode']
  onConfigure: () => void
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
                : `score ≥${at.config.minScore}`}
          {' · '}{at.config.tf} · ${at.config.stake} · max {at.config.maxOpen}
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
          {at.lastAction && <span>last: {at.lastAction}</span>}
          {at.lastRejection && <span className="text-amber-500/70"> · standing down: {at.lastRejection}</span>}
        </p>
      )}
    </div>
  )
}

function AutoTraderDialog({
  open,
  onOpenChange,
  config,
  onSave,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  config: AutoTraderConfig
  onSave: (patch: Partial<AutoTraderConfig>) => Promise<void>
}) {
  const [d, setD] = useState<AutoTraderConfig>(config)
  const [busy, setBusy] = useState(false)
  const p = (patch: Partial<AutoTraderConfig>) => setD((prev) => ({ ...prev, ...patch }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-[#1c2739] bg-[#0b111c] text-[#dbe4f0]">
        <DialogHeader>
          <DialogTitle className="text-[14px] tracking-wider">AUTO-TRADER</DialogTitle>
          <DialogDescription className="text-[11px] text-[#7c8aa5]">
            The OS acting as its own trader: takes the strongest signal as 1-bar binary options - composite screener,
            Kalman/OU mean reversion, Markov regime forecast or ADX momentum. Only ever trades while the OS is in
            NO-HUMAN mode. Sentinel + risk limits still govern every order.
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

          <div className="col-span-2">
            <Label className="text-[9px] uppercase tracking-wider text-[#4b5a72]">Signal source</Label>
            <div className="flex overflow-hidden rounded border border-[#1c2739]">
              {(
                [
                  ['screener', 'Screener'],
                  ['kalman-ou', 'Kalman-OU'],
                  ['markov', 'Markov'],
                  ['momentum', 'Momentum'],
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
                    : 'takes the strongest full-composite screener signals market-wide (trend + momentum + statistical + patterns)'}
            </p>
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

          <NumField label="Stake $" value={d.stake} onChange={(v) => p({ stake: v })} />
          <NumField label="Min |score|" value={d.minScore} onChange={(v) => p({ minScore: v })} />
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
          {d.signalSource === 'markov' && (
            <NumField label="Min P(up) threshold" value={d.minPUp} onChange={(v) => p({ minPUp: v })} step={0.01} />
          )}
          {d.signalSource === 'momentum' && (
            <NumField label="Min ADX (trend strength)" value={d.minAdx} onChange={(v) => p({ minAdx: v })} />
          )}
          <NumField label="Min confidence" value={d.minConfidence} onChange={(v) => p({ minConfidence: v })} />
          <NumField label="Max open" value={d.maxOpen} onChange={(v) => p({ maxOpen: v })} />
          <NumField label="Per-asset cooldown s" value={d.cooldownSec} onChange={(v) => p({ cooldownSec: v })} />
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
